/**
 * `--remote-control controller` inside one scenario attempt (CAN-7852): the
 * measured app signs in, pairs with the scripted computers and holds each
 * one through its main window in one-window mode before the measured window
 * opens; after it closes, the holds must have stayed connected throughout.
 *
 * Nothing in the app reads a held computer's snapshot yet (the sidebar is
 * CAN-7766), so the scenario's main window does what that sidebar will: it
 * holds each computer through `window.api.pairedComputers`, reads its
 * session snapshot once connected, and reads it again on every
 * `desktop:session-snapshot-stale` push, one read in flight per computer
 * with at most one more queued behind it.
 *
 * Order inside `runPerformanceScenarioAttempt`:
 * `prepareRemoteControlController` after the fixture is seeded (keys,
 * preferences), `connectRemoteControlController` after the shell is ready,
 * `markRemoteControlCaptureStart` just before the monitor starts,
 * `verifyRemoteControlCapture` just after it stops, and
 * `teardownRemoteControlController` before the app closes, always.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { connectMockCloudAccount } from '../../electron/seeders/connectMockCloudAccount.mjs';
import { registerScenario } from '../../electron/seeders/registerScenario.mjs';
import { PERFORMANCE_MOCK_BASE_URL } from '../mock-server.mjs';
import { latencySummary } from '../remote-access/desktops.mjs';
import {
  SESSION_SNAPSHOT_CHANNEL,
  SESSION_SNAPSHOT_STALE_CHANNEL,
  STUCK_READ_MS,
} from './peer-protocol.mjs';
import { startScriptedHost } from './runtime.mjs';

/**
 * Cloud sign-in needs OS secure storage. Electron cannot detect the Secret
 * Service under every Linux desktop, so point it there explicitly, as the
 * Remote Control bench does; macOS and Windows ignore the switch.
 */
export const REMOTE_CONTROL_ELECTRON_ARGS =
  process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [];

const SETUP_TIMEOUT_MS = 60_000;
const PAGE_CALL_TIMEOUT_MS = 10_000;

/** The page-side state's global, read back after the measured window. */
const PAGE_STATE = '__CANOPY_PERF_REMOTE_CONTROL__';

function seedOneWindowSwitch(userDataDir) {
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  const stored = existsSync(preferencesPath)
    ? JSON.parse(readFileSync(preferencesPath, 'utf8'))
    : { version: 1, preferences: {} };
  writeFileSync(
    preferencesPath,
    JSON.stringify(
      {
        ...stored,
        version: stored.version ?? 1,
        preferences: { ...(stored.preferences ?? {}), oneWindowEnabled: true },
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * Registers the app's and each peer's cloud key on one account, so the
 * relay lists them to each other. Call after the mock server was reset for
 * this scenario. Shared by both roles.
 */
export async function registerRemoteControlAccount(runtime, peers) {
  if (!runtime)
    throw new Error(
      '--remote-control needs the run-wide relay; run the scenario through run.mjs',
    );
  const runId = randomUUID();
  const userId = `perf-remote-control-${runId}`;
  const deviceRelay = {
    url: runtime.relay.url,
    secret: runtime.relay.secret,
    userId,
  };
  const appKey = `csk_perf_remote_control_app_${runId}`;
  const peerKeys = Array.from(
    { length: peers },
    (_, index) => `csk_perf_remote_control_peer${index + 1}_${runId}`,
  );
  for (const key of [appKey, ...peerKeys]) {
    await registerScenario(PERFORMANCE_MOCK_BASE_URL, key, {
      cloud: { deviceRelay },
    });
  }
  return { appKey, peerKeys };
}

/**
 * Before launch: registers the app's and each computer's cloud keys (one
 * account, so the relay lists them to each other) and turns the one-window
 * switch on in the fixture's preferences, merged with what the scenario
 * seeded. Call after the mock server was reset for this scenario.
 */
export async function prepareRemoteControlController({
  config,
  runtime,
  userDataDir,
}) {
  const { appKey, peerKeys } = await registerRemoteControlAccount(
    runtime,
    config.peers,
  );
  seedOneWindowSwitch(userDataDir);
  return {
    config,
    runtime,
    appKey,
    peerKeys,
    peers: [],
    page: null,
    setup: {},
    captureStartedAtMs: null,
    captureStartPeerStats: null,
  };
}

export async function remoteState(page, request = {}) {
  return page.evaluate(
    (options) => window.api.remoteControl.getState(options),
    request,
  );
}

export async function poll(read, done, { timeoutMs, what, intervalMs = 100 }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read();
    if (done(last)) return last;
    if (Date.now() >= deadline)
      throw new Error(
        `Remote Control: ${what} within ${timeoutMs} ms (last: ${JSON.stringify(last)})`,
      );
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Pairs the app with one scripted computer through the preload API. */
async function pairWith(page, peer) {
  await poll(
    async () =>
      (await remoteState(page, { discover: true })).discoverable.map(
        (device) => device.deviceId,
      ),
    (ids) => ids.includes(peer.deviceId),
    {
      timeoutMs: 30_000,
      what: `${peer.name} was not discoverable`,
      intervalMs: 200,
    },
  );
  await page.evaluate(
    (deviceId) => window.api.remoteControl.startPairing(deviceId),
    peer.deviceId,
  );
  const status = await poll(
    async () => (await remoteState(page)).outgoingPairing,
    (outgoing) =>
      ['approved', 'rejected', 'failed'].includes(outgoing?.status ?? ''),
    { timeoutMs: 30_000, what: `pairing with ${peer.name} did not finish` },
  );
  if (status.status !== 'approved')
    throw new Error(
      `Remote Control: pairing with ${peer.name} ${status.status}: ${status.error ?? 'no reason'}; the computer reported ${JSON.stringify(peer.messages)}:\n${peer.output.join('')}`,
    );
}

/**
 * Installs the page-side holder: per computer, update and state
 * subscriptions first, then the hold, then a snapshot read on every connect,
 * stale push and reconnect.
 */
async function holdComputers(page, deviceIds) {
  return page.evaluate(
    async ({ ids, channel, staleChannel, stateKey }) => {
      const api = window.api.pairedComputers;
      const state = { captureStartedAt: null, computers: {} };
      window[stateKey] = state;
      const holds = [];
      for (const deviceId of ids) {
        const computer = {
          holdId: null,
          heldAt: null,
          status: null,
          statusHistory: [],
          firstConnectedAt: null,
          firstReadAt: null,
          reads: [],
          readErrors: [],
          inFlight: false,
          inFlightSince: null,
          again: false,
          againCause: null,
          pushes: [],
          reconnects: [],
          lastTaskCount: null,
          unsubscribe: [],
        };
        state.computers[deviceId] = computer;
        const read = async (cause) => {
          if (computer.inFlight) {
            // The queued re-read carries the cause that queued it.
            computer.again = true;
            computer.againCause = cause;
            return;
          }
          computer.inFlight = true;
          try {
            let readCause = cause;
            do {
              if (computer.again) readCause = computer.againCause;
              computer.again = false;
              const startedAt = performance.now();
              computer.inFlightSince = startedAt;
              try {
                const snapshot = await api.invoke(deviceId, channel, [{}]);
                const endedAt = performance.now();
                computer.reads.push({
                  atMs: startedAt,
                  ms: endedAt - startedAt,
                  cause: readCause,
                });
                computer.lastTaskCount = Array.isArray(snapshot?.worktrees)
                  ? snapshot.worktrees.length
                  : null;
                if (computer.firstReadAt === null)
                  computer.firstReadAt = endedAt;
              } catch (error) {
                computer.readErrors.push({
                  atMs: startedAt,
                  cause: readCause,
                  message: String(error?.message ?? error),
                });
              }
            } while (computer.again);
          } finally {
            computer.inFlight = false;
            computer.inFlightSince = null;
          }
        };
        const applyState = (next) => {
          const now = performance.now();
          computer.statusHistory.push({
            atMs: now,
            status: next.status,
            reason: next.reason ?? null,
          });
          const was = computer.status;
          computer.status = next.status;
          if (next.status === 'connected') {
            if (computer.firstConnectedAt === null)
              computer.firstConnectedAt = now;
            if (was !== 'connected') void read('connected');
          }
        };
        computer.unsubscribe.push(
          api.onUpdate(deviceId, (update) => {
            if (update.type === 'push') {
              computer.pushes.push({
                atMs: performance.now(),
                channel: update.channel,
              });
              if (update.channel === staleChannel) void read('stale');
            } else if (update.type === 'reconnected') {
              computer.reconnects.push(performance.now());
              void read('reconnected');
            }
          }),
        );
        computer.unsubscribe.push(api.onStateChanged(deviceId, applyState));
        computer.heldAt = performance.now();
        const hold = await api.hold(deviceId);
        computer.holdId = hold.holdId;
        if (computer.status === null) applyState(hold.state);
        holds.push({ deviceId, state: hold.state });
      }
      return holds;
    },
    {
      ids: deviceIds,
      channel: SESSION_SNAPSHOT_CHANNEL,
      staleChannel: SESSION_SNAPSHOT_STALE_CHANNEL,
      stateKey: PAGE_STATE,
    },
  );
}

/** Setup progress per computer, from the page. */
async function holdProgress(page) {
  return page.evaluate((stateKey) => {
    const state = window[stateKey];
    return Object.entries(state?.computers ?? {}).map(
      ([deviceId, computer]) => ({
        deviceId,
        status: computer.status,
        heldAt: computer.heldAt,
        firstConnectedAt: computer.firstConnectedAt,
        firstReadAt: computer.firstReadAt,
        reads: computer.reads.length,
        readErrors: computer.readErrors.slice(-3),
        lastTaskCount: computer.lastTaskCount,
      }),
    );
  }, PAGE_STATE);
}

export const elapsed = (startedAt) => Math.round(performance.now() - startedAt);

/**
 * After the shell is ready: signs in, starts the scripted computers, pairs
 * with each and holds each from the main window, then waits until every
 * hold is connected and has read a snapshot. Records setup timings.
 */
export async function connectRemoteControlController(session, { page }) {
  const { config, runtime } = session;
  session.page = page;
  const setupStartedAt = performance.now();
  let startedAt = performance.now();
  await connectMockCloudAccount(page, session.appKey);
  session.setup.signInMs = elapsed(startedAt);

  startedAt = performance.now();
  // Started together: each is its own process.
  const started = await Promise.allSettled(
    session.peerKeys.map((apiKey, index) =>
      startScriptedHost(runtime, {
        apiKey,
        name: `Perf computer ${index + 1}`,
        tasks: config.tasks,
        statusIntervalMs: config.statusIntervalMs,
        mockBaseUrl: PERFORMANCE_MOCK_BASE_URL,
      }),
    ),
  );
  for (const result of started)
    if (result.status === 'fulfilled') session.peers.push(result.value);
  const failed = started.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  session.setup.peersReadyMs = elapsed(startedAt);

  session.setup.pairMs = [];
  for (const peer of session.peers) {
    startedAt = performance.now();
    await pairWith(page, peer);
    await peer.waitFor(
      (message) => message.type === 'paired',
      PAGE_CALL_TIMEOUT_MS,
      'record the pairing',
    );
    session.setup.pairMs.push(elapsed(startedAt));
  }

  startedAt = performance.now();
  const holds = await holdComputers(
    page,
    session.peers.map((peer) => peer.deviceId),
  );
  session.setup.holdMs = elapsed(startedAt);
  const refused = holds.filter(
    (hold) =>
      hold.state.status === 'unavailable' ||
      hold.state.status === 'needs-update',
  );
  if (refused.length > 0)
    throw new Error(
      `Remote Control: the main window could not hold ${refused
        .map((hold) => `${hold.deviceId} (${JSON.stringify(hold.state)})`)
        .join(', ')}`,
    );
  const progress = await poll(
    () => holdProgress(page),
    (computers) =>
      computers.length === session.peers.length &&
      computers.every(
        (computer) =>
          computer.status === 'connected' && computer.firstReadAt !== null,
      ),
    {
      timeoutMs: SETUP_TIMEOUT_MS,
      what: 'every held computer did not connect and serve a snapshot',
    },
  );
  const wrongCount = progress.find(
    (computer) => computer.lastTaskCount !== config.tasks,
  );
  if (wrongCount)
    throw new Error(
      `Remote Control: ${wrongCount.deviceId}'s snapshot held ${String(wrongCount.lastTaskCount)} tasks, expected ${config.tasks}`,
    );
  session.setup.connectedMs = progress.map((computer) =>
    Math.round(computer.firstConnectedAt - computer.heldAt),
  );
  session.setup.firstSnapshotMs = progress.map((computer) =>
    Math.round(computer.firstReadAt - computer.heldAt),
  );
  session.setup.totalMs = elapsed(setupStartedAt);
}

/** Just before the monitor starts: the measured window's start. */
export async function markRemoteControlCaptureStart(session) {
  session.captureStartedAtMs = performance.now();
  await session.page.evaluate((stateKey) => {
    const state = window[stateKey];
    state.captureStartedAt = performance.now();
    // The verdict starts from each hold's state at the window's start.
    state.statusAtCaptureStart = Object.fromEntries(
      Object.entries(state.computers).map(([deviceId, computer]) => [
        deviceId,
        computer.status,
      ]),
    );
  }, PAGE_STATE);
  session.captureStartPeerStats = await Promise.all(
    session.peers.map((peer) => peer.stats()),
  );
}

/** Entries timed inside the measured window, from its start to its end. */
function captureSlice(entries, startedAt, endedAt, at = (entry) => entry.atMs) {
  return entries.filter(
    (entry) => at(entry) >= startedAt && at(entry) <= endedAt,
  );
}

/**
 * Just after the monitor stops: reads what each hold saw during the
 * measured window and each computer's counters, and throws when a hold did
 * not stay connected throughout, a read failed, or no stale push reached a
 * computer over a window long enough for three. Returns the evidence.
 */
/**
 * Just before the monitor stops: the measured window's end. Every hold's
 * history and any read in flight are copied in one synchronous step in the
 * page, while every computer's counters are read at the same time, so
 * nothing that settles afterwards can change what the window saw.
 */
/** How long the end-of-window page read may take before the sample fails. */
const CAPTURE_END_TIMEOUT_MS = 10_000;

function withDeadline(ms, what) {
  return (promise) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${String(ms)} ms ${what}`)),
          ms,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };
}

export async function markRemoteControlCaptureEnd(session) {
  session.captureEndedAtMs = performance.now();
  const failures = [];
  const pageRead = withDeadline(
    CAPTURE_END_TIMEOUT_MS,
    'reading the holds at the end of the measured window',
  )(
    session.page.evaluate(
      ({ stateKey, ids }) => {
        const state = window[stateKey];
        const endedAt = performance.now();
        return ids.map((deviceId) => {
          const computer = state.computers[deviceId];
          return {
            deviceId,
            holdId: computer.holdId,
            captureStartedAt: state.captureStartedAt,
            captureEndedAt: endedAt,
            statusAtCaptureStart:
              state.statusAtCaptureStart?.[deviceId] ?? null,
            readInFlightForMs:
              computer.inFlightSince === null
                ? null
                : endedAt - computer.inFlightSince,
            statusHistory: [...computer.statusHistory],
            reads: [...computer.reads],
            readErrors: [...computer.readErrors],
            pushes: [...computer.pushes],
            reconnects: [...computer.reconnects],
            lastTaskCount: computer.lastTaskCount,
          };
        });
      },
      { stateKey: PAGE_STATE, ids: session.peers.map((peer) => peer.deviceId) },
    ),
  );
  const peerRead = Promise.all(
    session.peers.map((peer, index) =>
      peer.stats().catch((error) => {
        failures.push(
          `scripted computer ${index + 1} stopped answering: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        );
        return null;
      }),
    ),
  );
  const [page, peerStats] = await Promise.all([pageRead, peerRead]);
  session.captureEnd = { page, peerStats, failures };
}

export async function verifyRemoteControlCapture(session) {
  const { config } = session;
  if (!session.captureEnd) await markRemoteControlCaptureEnd(session);
  const captureMs = session.captureEndedAtMs - session.captureStartedAtMs;
  const failures = [...session.captureEnd.failures];
  const { peerStats } = session.captureEnd;
  // Each hold's live state is read afterwards, separately from the window.
  const liveStates = await session.page.evaluate(
    (ids) =>
      Promise.all(
        ids.map((deviceId) =>
          window.api.pairedComputers
            .getState(deviceId)
            .catch((error) => ({ status: 'error', message: String(error) })),
        ),
      ),
    session.peers.map((peer) => peer.deviceId),
  );
  const page = session.captureEnd.page.map((computer, index) => ({
    ...computer,
    liveState: liveStates[index],
  }));
  const computers = page.map((computer, index) => {
    const startedAt = computer.captureStartedAt;
    const endedAt = computer.captureEndedAt;
    // A read counts only when it finished inside the window.
    const reads = captureSlice(computer.reads, startedAt, endedAt).filter(
      (read) => read.atMs + read.ms <= endedAt,
    );
    const readErrors = captureSlice(computer.readErrors, startedAt, endedAt);
    const stalePushes = captureSlice(
      computer.pushes,
      startedAt,
      endedAt,
    ).filter((push) => push.channel === SESSION_SNAPSHOT_STALE_CHANNEL);
    const reconnects = captureSlice(
      computer.reconnects,
      startedAt,
      endedAt,
      (at) => at,
    );
    const stateChanges = captureSlice(
      computer.statusHistory,
      startedAt,
      endedAt,
    );
    const left = stateChanges.filter((change) => change.status !== 'connected');
    const label = `computer ${index + 1} (${computer.deviceId})`;
    // Connected at the window's start and through every change up to its
    // end; the live state read afterwards is kept as a diagnostic only.
    const statusAtEnd =
      stateChanges.at(-1)?.status ?? computer.statusAtCaptureStart;
    if (computer.statusAtCaptureStart !== 'connected')
      failures.push(
        `${label} was ${String(computer.statusAtCaptureStart)} when the measured window started`,
      );
    else if (statusAtEnd !== 'connected')
      failures.push(
        `${label} was ${String(statusAtEnd)} when the measured window ended`,
      );
    if (left.length > 0)
      failures.push(
        `${label} left connected during the measured window: ${left
          .map(
            (change) =>
              `${change.status}${change.reason ? ` (${change.reason})` : ''}`,
          )
          .join(', ')}`,
      );
    if (reconnects.length > 0)
      failures.push(
        `${label} reconnected ${reconnects.length} time(s) during the measured window`,
      );
    if (readErrors.length > 0)
      failures.push(
        `${label} failed ${readErrors.length} snapshot read(s): ${readErrors[0].message}`,
      );
    // Every stale push starts a re-read; the window must contain a finished
    // one, and no read may be stuck at its end.
    if (stalePushes.length > 0 && !reads.some((read) => read.cause === 'stale'))
      failures.push(
        `${label} received ${stalePushes.length} stale push(es) but finished no snapshot read they started during the measured window`,
      );
    if (
      computer.readInFlightForMs !== null &&
      computer.readInFlightForMs > STUCK_READ_MS
    )
      failures.push(
        `${label} had a snapshot read pending for ${Math.round(computer.readInFlightForMs)} ms when the measured window ended`,
      );
    if (stalePushes.length === 0 && captureMs >= 3 * config.statusIntervalMs)
      failures.push(
        `${label} received no stale push in a ${Math.round(captureMs)} ms window`,
      );
    const peer = peerStats[index];
    const atStart = session.captureStartPeerStats[index];
    const since = (key) => (peer ? peer[key] - atStart[key] : null);
    return {
      deviceId: computer.deviceId,
      connectedThroughout:
        computer.statusAtCaptureStart === 'connected' &&
        left.length === 0 &&
        reconnects.length === 0,
      liveStateAfterWindow: computer.liveState?.status ?? null,
      snapshotReads: reads.length,
      snapshotReadErrors: readErrors.length,
      stalePushesReceived: stalePushes.length,
      reconnects: reconnects.length,
      stateChanges: stateChanges.map((change) => change.status),
      readLatencyMs: latencySummary(reads.map((read) => read.ms)),
      tasksInLastSnapshot: computer.lastTaskCount,
      peer: peer
        ? {
            snapshotsServed: since('snapshotsServed'),
            pushesSent: since('pushesSent'),
            pushesRefused: since('pushesRefused'),
            controlSessions: peer.controlSessions,
            hellos: peer.hellos,
            sessionsClosed: peer.sessionsClosed.length,
            sessionStateChanges: peer.sessionStates.length,
            relayConnects: peer.relayConnects,
            refusedRequests: peer.refusedRequests,
            snapshotJsonBytes: peer.lastSnapshotJsonBytes,
          }
        : null,
    };
  });
  const evidence = {
    role: config.role,
    peers: config.peers,
    tasks: config.tasks,
    statusIntervalMs: config.statusIntervalMs,
    setup: session.setup,
    captureMs: Math.round(captureMs),
    computers,
  };
  if (failures.length > 0) {
    const error = new Error(
      `Remote Control did not stay connected through the measured window: ${failures.join('; ')}`,
    );
    error.remoteControl = evidence;
    throw error;
  }
  return evidence;
}

/** What is known so far, for a failed attempt's record. */
export function remoteControlPartialEvidence(session) {
  return {
    role: session.config.role,
    peers: session.config.peers,
    tasks: session.config.tasks,
    statusIntervalMs: session.config.statusIntervalMs,
    setup: session.setup,
    startedPeers: session.peers.map((peer) => peer.deviceId),
  };
}

/**
 * Releases the holds (when the window is still there) and stops every
 * scripted computer, waiting for their processes to end. Never throws.
 */
export async function teardownRemoteControlController(session) {
  if (session.page && !session.page.isClosed()) {
    await Promise.race([
      session.page
        .evaluate(async (stateKey) => {
          const state = window[stateKey];
          for (const computer of Object.values(state?.computers ?? {})) {
            for (const unsubscribe of computer.unsubscribe) unsubscribe();
            if (computer.holdId)
              await window.api.pairedComputers
                .release(computer.holdId)
                .catch(() => undefined);
          }
        }, PAGE_STATE)
        .catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, PAGE_CALL_TIMEOUT_MS)),
    ]);
  }
  const peers = session.peers.splice(0);
  await Promise.all(peers.map((peer) => peer.stop()));
}
