/**
 * Device-to-device Remote Control latency benchmark (CAN-7858), restored
 * from the `remote-access-bench` spec that commit 5c15612d262 deleted.
 *
 * Two desktops on one machine talk through the real `apps/device-relay`,
 * behind a TCP proxy that adds a fixed delay in each direction, for each
 * round-trip profile. Both share one clock, so one-way push latency comes
 * straight from timestamps the host prints. It records invoke latency,
 * keystroke echo, push latency and throughput of a busy terminal, chat
 * streaming, background chats streaming while the controller types (the
 * relay's single FIFO per socket and its 256 KiB destination mark make that
 * phase head-of-line sensitive), and key-to-paint in both windows while
 * Remote Control is connected and busy.
 */
import { createHash, randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from '../../electron/canopyApp.mjs';
import { closeCanopy } from '../../electron/launchCanopy.mjs';
import { seedWorktreeChat } from '../../electron/seeders/index.mjs';
import { registerScenario } from '../../electron/seeders/registerScenario.mjs';
import { currentMockBaseUrl } from '../mock-server.mjs';
import {
  keyToPaintVerdict,
  latencySummary,
  launchDesktop,
  measureKeyToPaint,
  openRemoteWindow,
  pairDevices,
  startDeviceRelay,
  startProxy,
  trafficDelta,
} from './desktops.mjs';

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'bench-chat';
const BACKGROUND_CHAT_IDS = [
  'bench-background-1',
  'bench-background-2',
  'bench-background-3',
];
export const BENCH_PROFILES = Object.freeze([
  { name: 'loopback', oneWayDelayMs: 0 },
  { name: 'rtt-40ms', oneWayDelayMs: 20 },
  { name: 'rtt-150ms', oneWayDelayMs: 75 },
]);
// Each background chat is switched to once, alternating no dwell and a dwell
// on its tab first, which lets the foreground-first prefetch read it.
const SWITCH_HOVER_MS = [0, 250, 0];
const STREAM_STEP = {
  text: `Streaming reply token by token. ${'More text follows here. '.repeat(20)}`,
  streamMs: 3_000,
  chunkChars: 6,
};
// Long enough to stream through the three sends, the controller's typing
// and the echo sample that follow, so the typing overlaps streamed text.
const BACKGROUND_STREAM_STEP = {
  text: `Background stream reply. ${'More background text follows here. '.repeat(20)}`,
  streamMs: 20_000,
  chunkChars: 6,
};

/** Every seeded chat's panel stays mounted, so select one by its panel id. */
async function showChatPanel(window, chatId) {
  await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
  return window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
}

/**
 * Sends a chat in a window and samples the reply's visible length until the
 * whole reply is on screen: first text, how many distinct partial lengths
 * were seen (incremental streaming), and completion. The deleted spec waited
 * for a "Completed in" label the chat no longer shows.
 */
async function measureChat(window, marker) {
  const app = new CanopyAppDriver(window);
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  const panel = await showChatPanel(window, CHAT_ID);
  await panel.getByRole('textbox').fill(`[${marker}] Stream please`);
  const squash = (text) => text.replace(/\s+/g, '');
  const count = (text, needle) => squash(text).split(squash(needle)).length - 1;
  const baseline = await panel.evaluate((element) => element.textContent ?? '');
  const sentAt = Date.now();
  await panel.getByRole('textbox').press('Enter');
  return panel.evaluate(
    async (element, { sentAt, reply, replyBefore, doneBefore }) => {
      // Rendered Markdown can drop or add whitespace; compare without it.
      const squashed = (text) => text.replace(/\s+/g, '');
      const occurrences = (text, needle) =>
        squashed(text).split(squashed(needle)).length - 1;
      const lengths = new Set();
      let firstTextMs = null;
      for (;;) {
        const text = element.textContent ?? '';
        const started = occurrences(text, 'Streaming reply') > replyBefore;
        const complete = occurrences(text, reply) > doneBefore;
        if (started) firstTextMs ??= Date.now() - sentAt;
        // Only a reply still short of complete is a partial render, and only
        // the current reply counts: its length from its own first words.
        if (started && !complete) {
          lengths.add(text.length - text.lastIndexOf('Streaming reply'));
        }
        if (complete) {
          return {
            firstTextMs,
            completeMs: Date.now() - sentAt,
            distinctPartialRenders: lengths.size,
          };
        }
        if (Date.now() - sentAt > 60_000) {
          return {
            firstTextMs,
            completeMs: null,
            distinctPartialRenders: lengths.size,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    {
      sentAt,
      reply: STREAM_STEP.text,
      replyBefore: count(baseline, 'Streaming reply'),
      doneBefore: count(baseline, STREAM_STEP.text),
    },
  );
}

async function measureInvokes(window, count) {
  return window.evaluate(async (n) => {
    const samples = [];
    for (let index = 0; index < n; index += 1) {
      const startedAt = performance.now();
      await window.api.terminal.list();
      samples.push(performance.now() - startedAt);
    }
    return samples;
  }, count);
}

/**
 * Keystroke echo, one-way push latency from host timestamps, and the
 * throughput of 5 MB of terminal output, through one terminal on the host.
 */
async function measureTerminal(window, { echoOnly = false } = {}) {
  const measured = await window.evaluate(
    async ({ projectId, worktreeId, echoOnly }) => {
      const decoder = new TextDecoder();
      const listeners = new Set();
      let terminalId = null;
      const unsubscribe = window.api.terminal.onOutput((event) => {
        if (terminalId !== null && event.terminalId !== terminalId) return;
        const text = decoder.decode(event.data);
        const receivedAt = Date.now();
        for (const listener of listeners)
          listener(text, receivedAt, event.data.byteLength);
      });
      const waitFor = (predicate, timeoutMs = 30_000) =>
        new Promise((resolve, reject) => {
          let buffer = '';
          const timer = setTimeout(() => {
            listeners.delete(listener);
            reject(new Error(`Timed out: ${buffer.slice(-200)}`));
          }, timeoutMs);
          const listener = (text, receivedAt, bytes) => {
            buffer += text;
            const result = predicate(buffer, receivedAt, bytes);
            if (result !== undefined) {
              clearTimeout(timer);
              listeners.delete(listener);
              resolve(result);
            }
          };
          listeners.add(listener);
        });
      const spawned = await window.api.terminal.spawn({
        projectId,
        worktreeId,
        cols: 200,
        rows: 50,
      });
      terminalId = spawned.id;
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      // Keystroke to echo: type a unique token and wait for the shell's echo.
      const echo = [];
      for (let index = 0; index < 30; index += 1) {
        const token = `k${index}x${Math.random().toString(36).slice(2, 6)}`;
        const startedAt = performance.now();
        const seen = waitFor((buffer) =>
          buffer.includes(token) ? true : undefined,
        );
        await window.api.terminal.write({ terminalId, data: token });
        await seen;
        echo.push(performance.now() - startedAt);
        await window.api.terminal.write({ terminalId, data: '\u0015' });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }

      if (echoOnly) {
        unsubscribe();
        await window.api.terminal.kill({ terminalId });
        return { echo };
      }

      // One-way push latency from host timestamps (same machine clock).
      const pushLatency = [];
      const pushDone = waitFor((buffer, receivedAt) => {
        const matches = buffer.match(/TS:(\d{13})/g) ?? [];
        while (pushLatency.length < matches.length) {
          const stamp = Number(matches[pushLatency.length].slice(3));
          pushLatency.push(receivedAt - stamp);
        }
        return buffer.includes('TS-2END') ? true : undefined;
      });
      // Millisecond stamps from Perl's core Time::HiRes, so the stamps are
      // the same on macOS and Linux (BSD date has no %N).
      await window.api.terminal.write({
        terminalId,
        data: `perl -MTime::HiRes=time,sleep -e '$|=1; for (1..40) { printf "TS:%d\\n", time*1000; sleep 0.05 } print "TS-", 1+1, "END\\n"'\r`,
      });
      await pushDone;
      if (pushLatency.length !== 40) {
        throw new Error(
          `Expected 40 timestamps, received ${String(pushLatency.length)}.`,
        );
      }

      // Streaming throughput: 5 MB of output.
      let bytes = 0;
      let output = '';
      const throughputStartedAt = performance.now();
      const endMarker = /BULK-5END:([0-9a-f]{64})/;
      const streamed = waitFor((buffer, _receivedAt, chunkBytes) => {
        bytes += chunkBytes;
        output = buffer;
        if (endMarker.test(buffer)) return true;
        return buffer.includes('BULK-5FAILED') ? false : undefined;
      }, 120_000);
      // The producer frames the payload between start and end markers, the
      // end one carrying the payload's SHA-256, and only after it succeeded.
      // It repeats the end marker after a pause, so the end is still seen
      // when the push that carried the first one was lost (CAN-7871).
      await window.api.terminal.write({
        terminalId,
        // One Perl process (core MIME::Base64 and Digest::SHA, the same on
        // macOS and Linux) makes, hashes and prints the payload in memory, so
        // no temporary file is left behind when a run stops.
        data: `perl -MDigest::SHA -MMIME::Base64 -e '$|=1; open(my $in, "<", "/dev/urandom") or die; read($in, my $bytes, 3750000) == 3750000 or die; my $hex = Digest::SHA::sha256_hex($bytes); print "BULK-", 2+3, "START\\n", encode_base64($bytes), "BULK-", 2+3, "END:$hex\\n"; sleep 1; print "BULK-", 2+3, "END:$hex\\n"' || echo BULK-$((2+3))FAILED\r`,
      });
      if (!(await streamed)) throw new Error('The bulk output failed.');
      // The payload that arrived: the base64-only lines between the markers.
      // A lost push shortens or joins lines; it never adds payload characters.
      const endAt = output.search(endMarker);
      const startAt = output.indexOf('BULK-5START');
      let payload = '';
      for (const line of output
        .slice(Math.max(0, startAt), endAt)
        .split(/\r?\n/)) {
        if (/^[A-Za-z0-9+/=]+$/.test(line)) payload += line;
      }
      const throughputMs = performance.now() - throughputStartedAt;
      unsubscribe();
      await window.api.terminal.kill({ terminalId });
      return {
        echo,
        pushLatency,
        bytes,
        payload,
        payloadSha256: output.slice(endAt).match(endMarker)[1],
        throughputMs,
      };
    },
    { projectId: PROJECT_ID, worktreeId: WORKTREE_ID, echoOnly },
  );
  if (echoOnly) return measured;
  // Intact only when every payload byte arrived and its SHA-256 matches the
  // producer's.
  const { payload, payloadSha256, ...rest } = measured;
  const digest = createHash('sha256')
    .update(Buffer.from(payload, 'base64'))
    .digest('hex');
  return {
    ...rest,
    payloadBytes: payload.length,
    payloadIntact:
      payload.length === BULK_PAYLOAD_BYTES && digest === payloadSha256,
  };
}

/** The bulk phase's payload: 3,750,000 random bytes as base64. */
const BULK_PAYLOAD_BYTES = 5_000_000;

const SUSTAINED_STREAM_SECONDS = 8;
/** The longest pause in terminal output that still counts as load. */
const MAX_OUTPUT_GAP_MS = 1_000;

/**
 * Key-to-paint in the host's own window while the controller's remote
 * window pulls sustained terminal output from it, so the host's main is
 * sealing and sending the whole time. The result says whether the typing
 * overlapped the stream; a run where it did not measured nothing.
 */
async function measureHostKeyToPaintWhileSending(remoteWindow, host, composer) {
  const stream = remoteWindow.evaluate(
    async ({ projectId, worktreeId, seconds }) => {
      const decoder = new TextDecoder();
      let terminalId = null;
      let text = '';
      let bytes = 0;
      window.__remoteAccessBenchStream = {
        startedAt: null,
        endedAt: null,
        chunkTimes: [],
      };
      const state = window.__remoteAccessBenchStream;
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('The sustained stream did not finish.')),
          (seconds + 60) * 1_000,
        );
        const unsubscribe = window.api.terminal.onOutput((event) => {
          if (terminalId !== null && event.terminalId !== terminalId) return;
          bytes += event.data.byteLength;
          text = (text + decoder.decode(event.data)).slice(-64);
          if (state.startedAt === null && bytes > 64 * 1024) {
            state.startedAt = Date.now();
          }
          if (state.startedAt !== null) state.chunkTimes.push(Date.now());
          if (text.includes('SUSTAIN-2END')) {
            state.endedAt = Date.now();
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        });
      });
      const spawned = await window.api.terminal.spawn({
        projectId,
        worktreeId,
        cols: 200,
        rows: 50,
        initialCommand: `end=$(( $(date +%s) + ${String(seconds)} )); while [ "$(date +%s)" -lt "$end" ]; do head -c 262144 /dev/urandom | perl -MMIME::Base64 -0777 -ne 'print encode_base64($_)'; done; echo SUSTAIN-$((1+1))END; sleep 1`,
      });
      terminalId = spawned.id;
      await done;
      // The shell exits a second after the marker; the terminal may be gone.
      await window.api.terminal.kill({ terminalId }).catch(() => undefined);
      return {
        bytes,
        startedAt: state.startedAt,
        endedAt: state.endedAt,
        chunkTimes: state.chunkTimes,
      };
    },
    {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      seconds: SUSTAINED_STREAM_SECONDS,
    },
  );
  // Observed at once: the poll or the typing below can fail first, and the
  // stream must not then reject unhandled before the run's cleanup.
  stream.catch(() => undefined);
  await expect
    .poll(
      () =>
        remoteWindow.evaluate(
          () => window.__remoteAccessBenchStream?.startedAt ?? null,
        ),
      { timeout: 60_000 },
    )
    .not.toBeNull();
  const typingStartedAt = Date.now();
  const keyToPaint = await measureKeyToPaint(
    host.window,
    composer,
    host.electronApp,
  );
  const typingEndedAt = Date.now();
  const streamed = await stream;
  // Output must have kept arriving throughout the typing: the longest gap
  // between output chunks, counted from the typing's start to its end.
  const marks = [
    typingStartedAt,
    ...streamed.chunkTimes.filter(
      (time) => time > typingStartedAt && time < typingEndedAt,
    ),
    typingEndedAt,
  ];
  const longestGapMs = Math.max(
    ...marks.slice(1).map((time, index) => time - marks[index]),
  );
  return keyToPaintVerdict(keyToPaint, {
    overlapped:
      typingStartedAt >= streamed.startedAt &&
      typingEndedAt <= streamed.endedAt &&
      longestGapMs <= MAX_OUTPUT_GAP_MS,
    load: {
      kind: 'sustained terminal output to the controller',
      longestGapMs,
      bytes: streamed.bytes,
      durationMs: streamed.endedAt - streamed.startedAt,
    },
  });
}

async function sendBackgroundChatTurn(hostWindow, chatId, marker) {
  const panel = await showChatPanel(hostWindow, chatId);
  await panel.getByRole('textbox').fill(`[${marker}] Stream please`);
  await panel.getByRole('textbox').press('Enter');
}

async function waitForBackgroundChatTurns(hostWindow) {
  const observedRunning = new Set();
  await expect
    .poll(
      async () => {
        const sessions = await hostWindow.evaluate(
          async ({ projectId, worktreeId }) => {
            const state = await window.api.chat.activeSessions({
              projectId,
              worktreeId,
            });
            return state.sessions ?? [];
          },
          { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
        );
        const byChatId = new Map(
          sessions.map((session) => [session.chatId, session]),
        );
        for (const chatId of BACKGROUND_CHAT_IDS) {
          if (byChatId.get(chatId)?.turnActive) observedRunning.add(chatId);
        }
        return BACKGROUND_CHAT_IDS.every(
          (chatId) =>
            observedRunning.has(chatId) &&
            byChatId.get(chatId)?.turnActive !== true,
        );
      },
      { timeout: 120_000 },
    )
    .toBe(true);
}

/**
 * The host streams three background chats while the controller stays on
 * its foreground chat: keystroke echo through the terminal, key-to-paint in
 * the controller's composer, and what reached the controller.
 */
async function measureBackgroundStreaming({
  profile,
  hostWindow,
  remoteWindow,
  controllerApp,
  hostProxy,
  controllerProxy,
  markers,
}) {
  const hostApp = new CanopyAppDriver(hostWindow);
  await hostApp.openMainPage();
  await hostApp.selectWorktree(WORKTREE_ID);
  const remoteApp = new CanopyAppDriver(remoteWindow);
  await remoteApp.openMainPage();
  await remoteApp.selectWorktree(WORKTREE_ID);
  await remoteWindow.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();

  // Chat events that reach the controller's window: a delivery metric.
  await remoteWindow.evaluate((chatIds) => {
    const counts = Object.fromEntries(chatIds.map((chatId) => [chatId, 0]));
    const unsubscribe = window.api.chat.onChatEvent(({ chatId }) => {
      if (!Object.hasOwn(counts, chatId)) return;
      counts[chatId] += 1;
    });
    window.__remoteAccessBenchChatEventCounts = counts;
    window.__remoteAccessBenchChatEventUnsubscribe = unsubscribe;
  }, BACKGROUND_CHAT_IDS);
  // The provider timing, taken on the host, where the events arrive without
  // the relay's delay, on the clock the typing is timed with (one machine).
  await hostWindow.evaluate((chatIds) => {
    const spans = {};
    const started = new Set();
    const unsubscribe = window.api.chat.onChatEvent(({ chatId, data }) => {
      if (!chatIds.includes(chatId)) return;
      // The provider's session start, after the host's routing status.
      if (data?.type === 'system' && data.subtype === 'init') {
        started.add(chatId);
      }
      // Its result reports how long the streaming call took, so the call ran
      // from arrival minus that to arrival. The routing status plays no part.
      if (data?.type === 'result' && typeof data.duration_api_ms === 'number') {
        const endedAt = Date.now();
        spans[chatId] = {
          startedAt: endedAt - data.duration_api_ms,
          endedAt,
        };
      }
    });
    window.__remoteAccessBenchProviderSpans = spans;
    window.__remoteAccessBenchProvidersStarted = started;
    window.__remoteAccessBenchProviderUnsubscribe = unsubscribe;
  }, BACKGROUND_CHAT_IDS);

  const hostTrafficBefore = hostProxy.trafficSnapshot();
  const controllerTrafficBefore = controllerProxy.trafficSnapshot();
  const startedAt = Date.now();
  for (const [index, chatId] of BACKGROUND_CHAT_IDS.entries()) {
    await sendBackgroundChatTurn(hostWindow, chatId, markers[index]);
  }
  // Started before the gate below: a turn that runs and finishes while the
  // gate waits must still be seen running.
  const backgroundTurnsDone = waitForBackgroundChatTurns(hostWindow);
  // Observed at once: the poll can time out while the gate or the typing
  // below is still pending, and must not reject unhandled. It is awaited
  // after the typing.
  backgroundTurnsDone.catch(() => undefined);

  // Type only once every background provider has started: sending a turn
  // returns before its provider does, so typing at once would land before
  // the streaming it means to overlap.
  await expect
    .poll(
      () =>
        hostWindow.evaluate(
          () => window.__remoteAccessBenchProvidersStarted.size,
        ),
      { timeout: 60_000 },
    )
    .toBe(BACKGROUND_CHAT_IDS.length);

  // Keep the controller on its foreground chat while the host's other chats
  // stream: type into its composer, then sample the terminal echo path.
  const foreground = await showChatPanel(remoteWindow, CHAT_ID);
  const typingStartedAt = Date.now();
  const keyToPaint = await measureKeyToPaint(
    remoteWindow,
    foreground.getByRole('textbox'),
    controllerApp,
  );
  const typingEndedAt = Date.now();
  const [echo] = await Promise.all([
    measureTerminal(remoteWindow, { echoOnly: true }),
    backgroundTurnsDone,
  ]);
  await remoteWindow.waitForTimeout(profile.oneWayDelayMs * 2 + 50);

  // The host withholds streamed text for chats this page doesn't show
  // (`shouldDropChatEvent` in main/ipc/chat-event-interest.ts), so this
  // window cannot time the streaming from text. The typing measured the load
  // only if one background turn's provider call, as its result reports it,
  // spans the typing. Read once every turn has finished.
  const streamSpans = await hostWindow.evaluate(() => ({
    ...window.__remoteAccessBenchProviderSpans,
  }));
  const overlapped = Object.values(streamSpans).some(
    (span) =>
      span.startedAt <= typingStartedAt && span.endedAt >= typingEndedAt,
  );

  const eventCounts = await remoteWindow.evaluate(() => ({
    ...window.__remoteAccessBenchChatEventCounts,
  }));
  const hostTraffic = trafficDelta(
    hostTrafficBefore,
    hostProxy.trafficSnapshot(),
  );
  const controllerTraffic = trafficDelta(
    controllerTrafficBefore,
    controllerProxy.trafficSnapshot(),
  );
  await remoteWindow.evaluate(() => {
    window.__remoteAccessBenchChatEventUnsubscribe?.();
    delete window.__remoteAccessBenchChatEventCounts;
    delete window.__remoteAccessBenchChatEventUnsubscribe;
  });
  await hostWindow.evaluate(() => {
    window.__remoteAccessBenchProviderUnsubscribe?.();
    delete window.__remoteAccessBenchProviderSpans;
    delete window.__remoteAccessBenchProvidersStarted;
    delete window.__remoteAccessBenchProviderUnsubscribe;
  });

  return {
    burstMs: Date.now() - startedAt,
    backgroundChatCount: BACKGROUND_CHAT_IDS.length,
    remoteForegroundChatId: CHAT_ID,
    pushesAtControllerByChannel: {
      'chat:event': {
        total: Object.values(eventCounts).reduce(
          (total, value) => total + value,
          0,
        ),
        byBackgroundChat: eventCounts,
      },
    },
    keystrokeEchoMs: latencySummary(echo.echo),
    controllerKeyToPaintMs: keyToPaintVerdict(keyToPaint, {
      overlapped,
      load: {
        kind: 'three background chats streaming on the host',
        typingMs: typingEndedAt - typingStartedAt,
        // Per background chat: its first and last events at this window,
        // in ms from the start of typing, and how many arrived.
        // Per background chat: its provider call, in ms from the start of
        // typing, as its result reported it.
        providerStreamSpans: Object.fromEntries(
          Object.entries(streamSpans).map(([chatId, span]) => [
            chatId,
            {
              startMs: span.startedAt - typingStartedAt,
              endMs: span.endedAt - typingStartedAt,
            },
          ]),
        ),
      },
    }),
    controllerProxyTraffic: {
      controllerToRelay: controllerTraffic.toRelay,
      relayToController: controllerTraffic.toDesktop,
    },
    hostProxyTraffic: {
      hostToRelay: hostTraffic.toRelay,
      relayToHost: hostTraffic.toDesktop,
    },
    perChannelTrafficNote:
      'The relay payloads are end-to-end encrypted; only aggregate outer WebSocket traffic is visible at the proxy. Controller chat:event pushes are counted by background chat above.',
  };
}

/** Click to the background reply at the controller, after an optional dwell. */
async function measureBackgroundSwitches(remoteWindow) {
  const switches = [];
  for (const [index, chatId] of BACKGROUND_CHAT_IDS.entries()) {
    const hoverMs = SWITCH_HOVER_MS[index];
    const tab = remoteWindow.getByTestId(`panel-tab-panel-chat-${chatId}`);
    const panel = remoteWindow.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    if (hoverMs > 0) {
      await tab.hover();
      await remoteWindow.waitForTimeout(hoverMs);
    }
    const startedAt = performance.now();
    await tab.click();
    await expect(panel.getByText('Background stream reply.')).toBeVisible({
      timeout: 30_000,
    });
    switches.push({
      chatId,
      hoverMs,
      clickToReplyMs: Math.round(performance.now() - startedAt),
    });
    await remoteWindow.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
  }
  return switches;
}

function seedBenchChats(userDataDir) {
  seedWorktreeChat({
    userDataDir,
    workspaceId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      { id: CHAT_ID, title: 'Bench chat', model: 'claude-haiku-4-5-20251001' },
      ...BACKGROUND_CHAT_IDS.map((id, index) => ({
        id,
        title: `Background bench chat ${String(index + 1)}`,
        model: 'claude-haiku-4-5-20251001',
      })),
    ],
  });
}

async function runProfile(relay, profile) {
  let hostProxy = null;
  let controllerProxy = null;
  const hostApiKey = `csk_remote_bench_host_${randomUUID()}`;
  const controllerApiKey = `csk_remote_bench_controller_${randomUUID()}`;
  const userId = `remote-access-bench-${profile.name}`;
  const marker = `Canopy-CREMOTEBENCH${randomUUID().slice(0, 8).toUpperCase()}`;
  const backgroundMarkers = BACKGROUND_CHAT_IDS.map(
    (_, index) => `${marker}BACKGROUND${String(index + 1)}`,
  );
  const desktops = [];
  try {
    hostProxy = await startProxy({
      targetPort: relay.port,
      oneWayDelayMs: profile.oneWayDelayMs,
    });
    controllerProxy = await startProxy({
      targetPort: relay.port,
      oneWayDelayMs: profile.oneWayDelayMs,
    });
    await registerScenario(currentMockBaseUrl(), hostApiKey, {
      cloud: {
        deviceRelay: { url: hostProxy.url, secret: relay.secret, userId },
      },
    });
    await registerScenario(currentMockBaseUrl(), controllerApiKey, {
      cloud: {
        deviceRelay: { url: controllerProxy.url, secret: relay.secret, userId },
      },
    });
    await Promise.all(
      backgroundMarkers.map((backgroundMarker) =>
        registerScenario(currentMockBaseUrl(), backgroundMarker, {
          llm: { steps: [BACKGROUND_STREAM_STEP] },
        }),
      ),
    );
    const host = await launchDesktop({
      label: `bench-host-${profile.name}`,
      demoApp: 'ts-pnpm-vite',
      apiKey: hostApiKey,
      seed: seedBenchChats,
    });
    desktops.push(host);
    const controller = await launchDesktop({
      label: `bench-controller-${profile.name}`,
      apiKey: controllerApiKey,
    });
    desktops.push(controller);
    const pairStartedAt = Date.now();
    await pairDevices(controller, host);
    const pairMs = Date.now() - pairStartedAt;
    const remote = await openRemoteWindow(controller, host);

    await measureInvokes(remote.window, 20);
    const remoteInvoke = await measureInvokes(remote.window, 200);
    const localInvoke = await measureInvokes(controller.window, 200);
    // While the controller pulls 5 MB of terminal output, the host's main
    // seals and sends it: type into the host's own composer meanwhile.
    const hostApp = new CanopyAppDriver(host.window);
    await hostApp.openMainPage();
    await hostApp.selectWorktree(WORKTREE_ID);
    const hostComposer = (await showChatPanel(host.window, CHAT_ID)).getByRole(
      'textbox',
    );
    const terminal = await measureTerminal(remote.window);
    const hostKeyToPaint = await measureHostKeyToPaintWhileSending(
      remote.window,
      host,
      hostComposer,
    );

    // Alternate remote and local turns so a cold provider start does not
    // land on one side only.
    const chatRounds = [];
    for (let round = 0; round < 2; round += 1) {
      for (const [side, target] of [
        ['remote', remote.window],
        ['local', host.window],
      ]) {
        const roundMarker = `${marker}${side.toUpperCase()}${String(round)}`;
        await registerScenario(currentMockBaseUrl(), roundMarker, {
          llm: { steps: [STREAM_STEP] },
        });
        chatRounds.push({
          side,
          round,
          ...(await measureChat(target, roundMarker)),
        });
      }
    }
    const localTerminal = await measureTerminal(host.window);
    const backgroundStreaming =
      profile.oneWayDelayMs <= 20
        ? await measureBackgroundStreaming({
            profile,
            hostWindow: host.window,
            remoteWindow: remote.window,
            controllerApp: controller.electronApp,
            hostProxy,
            controllerProxy,
            markers: backgroundMarkers,
          })
        : null;
    const backgroundSwitches = backgroundStreaming
      ? await measureBackgroundSwitches(remote.window)
      : null;

    return {
      profile: profile.name,
      // Both computers reach the relay over the delayed link, so a
      // computer-to-computer round trip crosses it twice each way.
      deviceToRelayRttMs: profile.oneWayDelayMs * 2,
      deviceToDeviceRttMs: profile.oneWayDelayMs * 4,
      pairMs,
      openWindowToProjectsMs: remote.openedInMs,
      localInvokeMs: latencySummary(localInvoke),
      remoteInvokeMs: latencySummary(remoteInvoke),
      keystrokeEchoMs: latencySummary(terminal.echo),
      pushOneWayMs: latencySummary(terminal.pushLatency),
      streamedBytes: terminal.bytes,
      terminalDelivery: {
        producedBytes: BULK_PAYLOAD_BYTES,
        receivedBytes: terminal.payloadBytes,
        lostBytes: Math.max(0, BULK_PAYLOAD_BYTES - terminal.payloadBytes),
        intact: terminal.payloadIntact,
      },
      streamThroughputMBps:
        Math.round(
          (terminal.bytes / 1e6 / (terminal.throughputMs / 1000)) * 10,
        ) / 10,
      hostKeyToPaintWhileStreamingMs: hostKeyToPaint,
      chatRounds,
      localKeystrokeEchoOnHostMs: latencySummary(localTerminal.echo),
      localPushOneWayOnHostMs: latencySummary(localTerminal.pushLatency),
      backgroundStreaming,
      backgroundSwitches,
    };
  } finally {
    for (const desktop of desktops.reverse()) {
      await closeCanopy(desktop.electronApp, desktop.userDataDir);
    }
    await Promise.all([hostProxy?.stop(), controllerProxy?.stop()]);
  }
}

/** Runs every selected profile; returns one result per profile. */
export async function runBench({
  profiles = BENCH_PROFILES,
  progress = {},
} = {}) {
  const relay = await startDeviceRelay();
  const results = [];
  // Profiles finished so far, written to the artifact if a later one fails.
  progress.profiles = results;
  try {
    for (const profile of profiles) {
      results.push(await runProfile(relay, profile));
    }
  } finally {
    await relay.stop();
  }
  const keyToPaint = results.flatMap((result) => [
    result.hostKeyToPaintWhileStreamingMs,
    result.backgroundStreaming?.controllerKeyToPaintMs,
  ]);
  const measured = keyToPaint.filter(Boolean);
  return {
    profiles: results,
    keyToPaintWithinCeiling: measured.every((verdict) => verdict.withinCeiling),
    keyToPaintOverlappedLoad: measured.every((verdict) => verdict.overlapped),
    keyToPaintMeasurements: measured.length,
    // Terminal output the controller's window never received (CAN-7871).
    terminalBytesProduced: results.reduce(
      (total, result) => total + result.terminalDelivery.producedBytes,
      0,
    ),
    terminalBytesLost: results.reduce(
      (total, result) => total + result.terminalDelivery.lostBytes,
      0,
    ),
    terminalDeliveryIntact: results.every(
      (result) => result.terminalDelivery.intact,
    ),
  };
}
