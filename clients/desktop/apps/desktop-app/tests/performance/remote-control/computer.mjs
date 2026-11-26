/**
 * One computer of the Remote Control workload (CAN-7754), run in its own
 * worker thread so its event loop stands in for that computer's Electron
 * main. The `host` is the controlled computer, the `controller` the one the
 * person sits at.
 *
 * Both run the desktop app's own session layer: device keys, the encrypted
 * handshake, AES-GCM per fragment, V8 serialize plus deflate in the message
 * codec, resume retention and acks, and the RPC peer. The controller also
 * parses each push with the same schema as `client/host-connection.ts` and
 * structured-clones it to its window, as `webContents.send` does. The host
 * parses each invoke with the schema `host/host-session.ts` uses.
 *
 * Not included: the host's capture of its own renderer pushes (bridge
 * window, interest filters, push summary) and anything behind a tunnelled
 * channel. Those change no transport cost, and the workload measures the
 * transport.
 *
 * The `canopy-transport/*` imports are resolved by the runner's bundler
 * against the checkout being measured (see `bundle.mjs`), so one harness can
 * measure a baseline and a candidate checkout.
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { getHeapStatistics, serialize } from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';
import { generateDeviceKeyPair } from 'canopy-transport/device-key';
import { RpcPeer } from 'canopy-transport/rpc-peer';
import { RemoteSessionManager } from 'canopy-transport/session-manager';
import {
  InvokeParamsSchema,
  InvokeRequestParamsSchema,
  REMOTE_EVENTS,
  REMOTE_METHODS,
} from 'canopy-transport/remote-protocol';
import {
  createRandom,
  chatDeltaPush,
  ECHO_PROBE_INTERVAL_MS,
  SCENARIOS,
  terminalOutputPush,
  transcriptPage,
  transcriptPageMessageCount,
} from './scenarios.mjs';

const CHAT_EVENT = 'chat:event';
const TERMINAL_OUTPUT = 'terminal:output';
const TERMINAL_WRITE = 'terminal:write';
const TRANSCRIPT_PAGE = 'chat:get-transcript-page';
const ECHO_TERMINAL_ID = 'perf-terminal-echo';
const TERMINAL_FRAME_POOL = 64;

const { role, scenario: scenarioName, seed } = workerData;
const scenario = SCENARIOS[scenarioName];
if (!scenario) throw new Error(`Unknown scenario ${String(scenarioName)}`);
if (role !== 'host' && role !== 'controller') {
  throw new Error(`Unknown role ${String(role)}`);
}

/** Wall-clock milliseconds that agree across the threads of one process. */
const now = () => performance.timeOrigin + performance.now();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The histogram records each interval of a timer that fires every
 * `resolution` ms, so a loop that never blocks reads `resolution`. Delay is
 * the interval minus that.
 */
const LOOP_DELAY_RESOLUTION_MS = 10;
const loopDelay = monitorEventLoopDelay({
  resolution: LOOP_DELAY_RESOLUTION_MS,
});
loopDelay.enable();

/**
 * The relay: frames cross to the peer's thread over a MessagePort, in order,
 * one copy per frame as the socket write makes. Presence never changes.
 */
class PortRelay {
  constructor(port, deviceId) {
    this.port = port;
    this.deviceId = deviceId;
    this.frameListeners = new Set();
    this.counters = { framesOut: 0, bytesOut: 0, framesIn: 0, bytesIn: 0 };
    port.on('message', (message) => {
      const payload = Buffer.from(message.payload);
      this.counters.framesIn += 1;
      this.counters.bytesIn += payload.byteLength;
      for (const listener of Array.from(this.frameListeners)) {
        listener(message.from, payload);
      }
    });
  }

  sendFrame(_peerDeviceId, payload) {
    const copy = new Uint8Array(payload.byteLength);
    copy.set(payload);
    this.counters.framesOut += 1;
    this.counters.bytesOut += copy.byteLength;
    this.port.postMessage({ from: this.deviceId, payload: copy.buffer }, [
      copy.buffer,
    ]);
    return true;
  }

  onFrame(listener) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onPeerOffline() {
    return () => undefined;
  }

  onPeerOnline() {
    return () => undefined;
  }

  onUndeliverable() {
    return () => undefined;
  }
}

const identity = generateDeviceKeyPair();
let relay = null;
let manager = null;
let rpc = null;
let windowPort = null;
const counters = {
  messagesOut: 0,
  messagesIn: 0,
  parseFailures: 0,
  /** Sends the session refused (closed, or the relay refused the frame). */
  rejectedSends: 0,
};

function threadCpuMs() {
  // Per-thread CPU time; absent on runtimes that predate it.
  if (typeof process.threadCpuUsage !== 'function') return null;
  const usage = process.threadCpuUsage();
  return (usage.user + usage.system) / 1000;
}

let measureStart = null;
let heapPeakBytes = 0;
let heapTimer = null;

function startMeasure() {
  loopDelay.reset();
  heapPeakBytes = getHeapStatistics().used_heap_size;
  heapTimer = setInterval(() => {
    heapPeakBytes = Math.max(heapPeakBytes, getHeapStatistics().used_heap_size);
  }, 250);
  measureStart = {
    atMs: now(),
    utilization: performance.eventLoopUtilization(),
    cpuMs: threadCpuMs(),
    relay: { ...relay.counters },
    counters: { ...counters },
  };
}

function stopMeasure() {
  clearInterval(heapTimer);
  const durationMs = now() - measureStart.atMs;
  const seconds = durationMs / 1000;
  const utilization = performance.eventLoopUtilization(
    measureStart.utilization,
  );
  const cpuMs = threadCpuMs();
  const relayDelta = (key) => relay.counters[key] - measureStart.relay[key];
  const countDelta = (key) => counters[key] - measureStart.counters[key];
  const delayMs = (nanoseconds) =>
    Math.max(0, nanoseconds / 1e6 - LOOP_DELAY_RESOLUTION_MS);
  return {
    durationMs,
    eventLoopDelay: {
      p50Ms: delayMs(loopDelay.percentile(50)),
      p99Ms: delayMs(loopDelay.percentile(99)),
      maxMs: delayMs(loopDelay.max),
      intervals: loopDelay.count,
    },
    utilization: utilization.utilization,
    cpuMs:
      cpuMs === null || measureStart.cpuMs === null
        ? null
        : cpuMs - measureStart.cpuMs,
    wire: {
      bytesOutPerSecond: relayDelta('bytesOut') / seconds,
      bytesInPerSecond: relayDelta('bytesIn') / seconds,
      framesOut: relayDelta('framesOut'),
      framesIn: relayDelta('framesIn'),
      bytesOut: relayDelta('bytesOut'),
      bytesIn: relayDelta('bytesIn'),
    },
    messagesOut: countDelta('messagesOut'),
    messagesIn: countDelta('messagesIn'),
    transcriptPageSerializedBytes,
    parseFailures: countDelta('parseFailures'),
    heapPeakBytes,
  };
}

function notify(name, payload) {
  const sent = rpc.notify(name, payload);
  if (sent) counters.messagesOut += 1;
  else counters.rejectedSends += 1;
  return sent;
}

function push(channel, args) {
  return notify(REMOTE_EVENTS.push, { channel, args });
}

async function request(channel, args) {
  counters.messagesOut += 1;
  const result = await rpc.request(REMOTE_METHODS.invoke, { channel, args });
  counters.messagesIn += 1;
  return result;
}

// ---------------------------------------------------------------- host side

/** Payloads made before the measured window, so making them costs nothing there. */
let terminalFrames = [];
let pages = [];
/** How far the last paced run finished behind its cadence. */
let scheduleLagMs = 0;
/** Mean V8-serialized size of a transcript page, before compression. */
let transcriptPageSerializedBytes = null;

function prepareHostPayloads() {
  const random = createRandom(seed);
  if (scenarioName === 'busy-terminal') {
    const bytes = Math.round(
      (scenario.bytesPerSecondPerTerminal * scenario.mergeIntervalMs) / 1000,
    );
    terminalFrames = Array.from(
      { length: TERMINAL_FRAME_POOL },
      () =>
        terminalOutputPush(random, {
          terminalIndex: 0,
          seq: 0,
          bytes,
          sentAtMs: 0,
        }).data,
    );
  }
  if (scenarioName === 'large-transcript') {
    pages = Array.from({ length: scenario.pages }, (_, page) =>
      transcriptPage(random, { ...scenario, page }),
    );
    transcriptPageSerializedBytes =
      pages.reduce((total, page) => total + serialize(page).byteLength, 0) /
      pages.length;
  }
}

/** The keys `validateChatTranscriptPageRequest` (main's handler) accepts. */
const TRANSCRIPT_REQUEST_KEYS = new Set([
  'projectId',
  'worktreeId',
  'archivedContainerId',
  'standaloneHistory',
  'chatId',
  'before',
  'view',
  'turnId',
  'transcriptRevision',
]);

/**
 * Answers a transcript page request shaped as the renderer sends it: no
 * cursor for the newest page, then the previous page's `before` and
 * `transcriptRevision`. A request main's handler would refuse is refused.
 */
function transcriptPageFor(pageRequest) {
  if (
    pageRequest === null ||
    typeof pageRequest !== 'object' ||
    Object.keys(pageRequest).some((key) => !TRANSCRIPT_REQUEST_KEYS.has(key))
  ) {
    throw new Error('Invalid transcript page request.');
  }
  if (pageRequest.view !== 'turns') {
    throw new Error('The chat pages its history in the turn view.');
  }
  const total = scenario.pages * scenario.turnsPerPage * scenario.rowsPerTurn;
  const page =
    pageRequest.before === undefined
      ? 0
      : (total - pageRequest.before) /
        (scenario.turnsPerPage * scenario.rowsPerTurn);
  const result = pages[page];
  if (
    !result ||
    (pageRequest.before !== undefined &&
      pageRequest.transcriptRevision !== result.transcriptRevision)
  ) {
    throw new Error(`No transcript page before ${String(pageRequest.before)}.`);
  }
  return result;
}

function hostRequest(method, params) {
  counters.messagesIn += 1;
  if (method !== REMOTE_METHODS.invoke) {
    return Promise.reject(new Error(`Unexpected method ${method}`));
  }
  const invoke = InvokeRequestParamsSchema.parse(params);
  if (invoke.channel === TERMINAL_WRITE) {
    const [write] = invoke.args;
    // The shell echoes the keystroke back as terminal output.
    setImmediate(() => {
      push(TERMINAL_OUTPUT, [
        {
          projectId: 'perf-project',
          worktreeId: 'perf-worktree',
          terminalId: ECHO_TERMINAL_ID,
          data: new TextEncoder().encode(write.data),
          seq: write.seq,
          canopyPerfEchoSentAtMs: write.canopyPerfSentAtMs,
        },
      ]);
    });
    counters.messagesOut += 1;
    return Promise.resolve(undefined);
  }
  if (invoke.channel === TRANSCRIPT_PAGE) {
    const [pageRequest] = invoke.args;
    counters.messagesOut += 1;
    return Promise.resolve(transcriptPageFor(pageRequest));
  }
  return Promise.reject(new Error(`Unexpected channel ${invoke.channel}`));
}

/** Sends at a steady rate for `durationMs`; returns how many pushes went out. */
/**
 * Sends every tick of the scenario's cadence, however late: a busy loop
 * delivers the full traffic and reports how far it fell behind, instead
 * of quietly sending less.
 */
async function runPaced({ durationMs, intervalMs, send }) {
  const startedAt = now();
  const ticks = Math.ceil(durationMs / intervalMs);
  let sent = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    sent += send(tick);
    const next = startedAt + (tick + 1) * intervalMs;
    await delay(Math.max(0, next - now()));
  }
  scheduleLagMs = Math.max(0, now() - startedAt - ticks * intervalMs);
  return sent;
}

async function runHost(durationMs) {
  const random = createRandom(seed + 1);
  if (scenarioName === 'streaming-chat') {
    const intervalMs = 1000 / scenario.deltasPerSecondPerChat;
    return runPaced({
      durationMs,
      intervalMs,
      send: (tick) => {
        let sent = 0;
        for (let chat = 0; chat < scenario.chats; chat += 1) {
          if (
            push(CHAT_EVENT, [
              chatDeltaPush(random, {
                chatIndex: chat,
                seq: tick,
                sentAtMs: now(),
              }),
            ])
          )
            sent += 1;
        }
        return sent;
      },
    });
  }
  if (scenarioName === 'busy-terminal') {
    return runPaced({
      durationMs,
      intervalMs: scenario.mergeIntervalMs,
      send: (tick) => {
        let sent = 0;
        for (let terminal = 0; terminal < scenario.terminals; terminal += 1) {
          const data =
            terminalFrames[
              (tick * scenario.terminals + terminal) % TERMINAL_FRAME_POOL
            ];
          if (
            push(TERMINAL_OUTPUT, [
              {
                projectId: 'perf-project',
                worktreeId: 'perf-worktree',
                terminalId: `perf-terminal-${String(terminal)}`,
                data,
                seq: tick,
                canopyPerfSentAtMs: now(),
              },
            ])
          )
            sent += 1;
        }
        return sent;
      },
    });
  }
  return 0;
}

// ---------------------------------------------------------- controller side

/**
 * The current run's probe loop: `stopAt` is set when the sample stops it,
 * `wake` cuts its wait short and `done` settles once it has sent every
 * probe that fell due up to `stopAt`.
 */
let probes = null;

function controllerEvent(name, payload) {
  counters.messagesIn += 1;
  if (name !== REMOTE_EVENTS.push) return;
  const parsed = InvokeParamsSchema.safeParse(payload);
  if (!parsed.success) {
    counters.parseFailures += 1;
    return;
  }
  windowPort.postMessage({
    kind: 'push',
    channel: parsed.data.channel,
    args: parsed.data.args,
  });
}

/** Probes sent by the current run; every one must come back as an echo. */
let probesSent = 0;

/**
 * Sends a keystroke probe every `ECHO_PROBE_INTERVAL_MS` on a fixed
 * schedule. Each probe carries its scheduled time, so a probe that falls
 * due while the controller's loop is blocked is sent late and its latency
 * includes the stall, instead of quietly not being sent. Stopping sends
 * every probe that fell due before the stop, even while the loop waits.
 */
async function runEchoProbes(run) {
  const startedAt = now();
  for (let seq = 0; ; seq += 1) {
    const dueAt = startedAt + seq * ECHO_PROBE_INTERVAL_MS;
    // A timer can fire a fraction of a millisecond early, so wait until the
    // probe is due; never send a probe before the time it carries.
    while (run.stopAt === undefined && now() < dueAt) {
      await new Promise((resolve) => {
        run.wake = resolve;
        setTimeout(resolve, Math.max(1, Math.ceil(dueAt - now())));
      });
    }
    if (run.stopAt !== undefined && dueAt > run.stopAt) return;
    probesSent += 1;
    void request(TERMINAL_WRITE, [
      {
        terminalId: ECHO_TERMINAL_ID,
        data: `k${String(seq + 1)}`,
        seq: seq + 1,
        canopyPerfSentAtMs: dueAt,
      },
    ]).catch(() => undefined);
  }
}

/** Stops the probe loop once every probe due by now has been sent. */
async function stopEchoProbes() {
  const run = probes;
  if (!run) return;
  run.stopAt = now();
  run.wake?.();
  await run.done;
}

async function runTranscriptPages(pageCount) {
  let previous = null;
  for (let page = 0; page < pageCount; page += 1) {
    if (page > 0) await delay(scenario.pageIntervalMs);
    const startedAtMs = now();
    // The newest page first, then older pages by the previous page's cursor.
    const result = await request(TRANSCRIPT_PAGE, [
      {
        projectId: 'perf-project',
        worktreeId: 'perf-worktree',
        chatId: 'perf-chat-long',
        view: 'turns',
        ...(previous === null
          ? {}
          : {
              before: previous.before,
              transcriptRevision: previous.transcriptRevision,
            }),
      },
    ]);
    // A page that is missing or short is not a delivered page.
    if (
      result?.view !== 'turns' ||
      !Array.isArray(result.turns) ||
      result.turns.length !== scenario.turnsPerPage ||
      !Array.isArray(result.messages) ||
      result.messages.length !== transcriptPageMessageCount(scenario, page)
    ) {
      throw new Error(
        `Transcript page ${String(page)} is missing or incomplete.`,
      );
    }
    windowPort.postMessage({ kind: 'result', startedAtMs, result });
    previous = result;
  }
}

// ------------------------------------------------------------ coordination

async function connect(peer) {
  if (role === 'host') {
    manager = new RemoteSessionManager({
      transport: relay,
      identity: () => identity,
      authorize: () => ({
        kind: 'desktop',
        kindAuthenticated: false,
        rootDeviceId: null,
        expiresAt: null,
      }),
      onIncomingSession: (session) => {
        // Today's desktop controller and host both offer transport resume.
        session.setResumeNegotiated(true);
        rpc = new RpcPeer(session, {
          onRequest: hostRequest,
          onEvent: () => {
            counters.messagesIn += 1;
          },
        });
        parentPort.postMessage({ type: 'connected' });
      },
    });
    return;
  }
  manager = new RemoteSessionManager({
    transport: relay,
    identity: () => identity,
    authorize: () => null,
    onIncomingSession: () => undefined,
  });
  const session = await manager.connect({
    peerDeviceId: peer.deviceId,
    purpose: 'control',
    pinnedPeerPublicKey: peer.publicKey,
  });
  session.setResumeNegotiated(true);
  rpc = new RpcPeer(session, {
    onRequest: () => Promise.reject(new Error('No controller methods.')),
    onEvent: controllerEvent,
  });
  parentPort.postMessage({ type: 'connected' });
}

/** One run of the scenario's traffic; `scale` shortens the warm-up run. */
async function run(scale) {
  if (role === 'host') {
    const durationMs = (scenario.durationMs ?? 0) * scale;
    const rejectedBefore = counters.rejectedSends;
    scheduleLagMs = 0;
    const sent = durationMs > 0 ? await runHost(durationMs) : 0;
    return {
      sent,
      rejected: counters.rejectedSends - rejectedBefore,
      scheduleLagMs,
    };
  }
  if (scenario.echoProbes) {
    await stopEchoProbes();
    probesSent = 0;
    const run = { stopAt: undefined, wake: undefined };
    run.done = runEchoProbes(run);
    probes = run;
  }
  if (scenarioName === 'large-transcript') {
    await runTranscriptPages(Math.max(1, Math.round(scenario.pages * scale)));
  }
  return { sent: 0, rejected: 0 };
}

parentPort.on('message', (message) => {
  const reply = (type, body = {}) =>
    parentPort.postMessage({ type, id: message.id, ...body });
  const fail = (error) =>
    reply('error', {
      message: error instanceof Error ? error.stack : String(error),
    });
  switch (message.type) {
    case 'attach':
      relay = new PortRelay(message.relayPort, identity.deviceId);
      windowPort = message.windowPort ?? null;
      if (role === 'host') prepareHostPayloads();
      connect(message.peer).catch((error) =>
        parentPort.postMessage({
          type: 'connect-failed',
          message: error instanceof Error ? error.stack : String(error),
        }),
      );
      reply('attached');
      break;
    case 'run':
      run(message.scale)
        .then((result) => reply('ran', result))
        .catch(fail);
      break;
    case 'stop-probes':
      stopEchoProbes()
        .then(() => reply('probes-stopped', { probesSent }))
        .catch(fail);
      break;
    case 'measure-start':
      startMeasure();
      reply('measure-started');
      break;
    case 'measure-stop':
      reply('measured', { metrics: stopMeasure() });
      break;
    case 'close':
      rpc?.close('closed');
      manager?.dispose();
      loopDelay.disable();
      reply('closed');
      break;
    default:
      fail(new Error(`Unknown message ${String(message.type)}`));
  }
});

parentPort.postMessage({
  type: 'identity',
  deviceId: identity.deviceId,
  publicKey: identity.publicKey,
});
