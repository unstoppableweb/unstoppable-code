import { execFile } from 'node:child_process';
import { performance as nodePerformance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { percentile, summarize } from './statistics.mjs';

const EXPECTED_FRAME_MS = 1000 / 60;
const APP_METRICS_CONTEXT_RETRY_LIMIT = 1;
const execFileAsync = promisify(execFile);

// `summarize` spreads its values into `Math.min` and `Math.max`, which throws
// past about 120,000 arguments. A 17-minute window of 120 Hz frames exceeds
// that, so frame series use `summarizeSeries`.
const SPREAD_SAFE_VALUES = 50_000;

/** `summarize`, for a series of any length. */
export function summarizeSeries(values) {
  if (values.length <= SPREAD_SAFE_VALUES) return summarize(values);
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return summarize([]);
  let min = finite[0];
  let max = finite[0];
  let total = 0;
  for (const value of finite) {
    if (value < min) min = value;
    if (value > max) max = value;
    total += value;
  }
  return {
    count: finite.length,
    min,
    mean: total / finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
    max,
  };
}

/**
 * Frame budgets per bracketed streamed reply (methodology R5), advisory. The
 * counts are `requestAnimationFrame` callback intervals: a delayed-callback
 * count, not a compositor frame count, so they must be qualified against a
 * frame-timing trace before anything gates on them.
 */
export const FRAME_BUDGETS_MS = Object.freeze({ hz60: 16.7, hz120: 8.33 });
// One renderer timestamp quantum (0.1 ms). A 120 Hz frame interval of
// 8.333 ms rounds to 8.3 or 8.4 ms, and a 60 Hz one to 16.6 or 16.7 ms, so an
// interval counts as over budget only beyond that rounding.
const FRAME_BUDGET_TOLERANCE_MS = 0.1;
export const FRAME_BUDGET_METHOD =
  'requestAnimationFrame callback intervals: delayed-callback counts, not compositor frames; advisory until qualified against a frame-timing trace';
// Long Animation Frames kept per run; later ones are counted as dropped.
const MAX_LONG_ANIMATION_FRAMES = 2_000;
// Scripts kept per Long Animation Frame, largest duration first.
const MAX_LONG_ANIMATION_FRAME_SCRIPTS = 8;
const TOP_LONG_ANIMATION_FRAME_SCRIPTS = 10;
// Key and pointer presses kept per run for input-to-frame; later ones are
// counted as dropped.
const MAX_INPUT_EVENTS = 20_000;

/**
 * `Performance.getMetrics` counters recorded as work. `LayoutCount` and
 * `RecalcStyleCount` count operations since `Performance.enable`; the others
 * are live-object gauges, so their bracket deltas are signed net changes that
 * also move when garbage is collected. The `*Duration` fields are timings and
 * are deliberately excluded.
 */
export const CHROMIUM_WORK_METRICS = Object.freeze([
  'LayoutCount',
  'RecalcStyleCount',
  'Nodes',
  'JSEventListeners',
  'Documents',
  'Frames',
]);

export function selectChromiumWorkMetrics(metrics) {
  const values = new Map(
    (metrics ?? []).map(({ name, value }) => [name, value]),
  );
  return Object.fromEntries(
    CHROMIUM_WORK_METRICS.filter((name) =>
      Number.isFinite(values.get(name)),
    ).map((name) => [name, values.get(name)]),
  );
}

/**
 * Signed change of every counter observed in either sample, zero included: an
 * unchanged counter is a measurement, not an omission. A counter missing from
 * one sample counts as zero there.
 */
export function diffWorkCounters(before = {}, after = {}) {
  const delta = {};
  const names = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  for (const name of [...names].sort()) {
    const value = (after?.[name] ?? 0) - (before?.[name] ?? 0);
    if (Number.isFinite(value)) delta[name] = value;
  }
  return delta;
}

/**
 * App work-counter sources. E2E builds install a main-process query,
 * `globalThis.__CANOPY_WORK_COUNTERS__`, for the first three, and a renderer
 * React hook, `window.__CANOPY_REACT_WORK__`, for `react`. Both are reset at
 * the start of the measured window and snapshotted at each bracket.
 */
export const MAIN_WORK_SOURCES = Object.freeze([
  'ipc',
  'chatStorage',
  'provider',
]);
export const APP_WORK_SOURCES = Object.freeze([...MAIN_WORK_SOURCES, 'react']);

/**
 * Main's `route` counters say which backend served each opt-in routed read.
 * They are evidence, not work: the window's change is kept as
 * `summary.routeWork`, never bracketed per task or turned into metrics. A
 * build without them records nothing and no error.
 */
export const ROUTE_EVIDENCE_SOURCE = 'route';

/**
 * Main's `w5` counters (CAN-5532) count W5 store reads, captures, commits and
 * record-port calls. Like `route` they are evidence, kept as
 * `summary.w5Work`, never bracketed per task or turned into metrics.
 */
export const W5_EVIDENCE_SOURCE = 'w5';

const EVIDENCE_SOURCES = Object.freeze([
  ROUTE_EVIDENCE_SOURCE,
  W5_EVIDENCE_SOURCE,
]);

function isCounterMap(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((count) => Number.isFinite(count))
  );
}

/** `{ ipc, chatStorage, provider }` samples from one main snapshot. */
function mainWorkSamples(snapshot) {
  if (!snapshot || !Number.isFinite(snapshot.generation)) return null;
  const samples = {};
  for (const source of MAIN_WORK_SOURCES) {
    if (!isCounterMap(snapshot[source])) return null;
    samples[source] = {
      generation: snapshot.generation,
      counters: { ...snapshot[source] },
    };
  }
  return samples;
}

function evidenceSample(snapshot, source) {
  const counters = snapshot?.[source];
  return Number.isFinite(snapshot?.generation) && isCounterMap(counters)
    ? { generation: snapshot.generation, counters: { ...counters } }
    : null;
}

/** `{ route, w5 }` evidence samples of one main snapshot, null where absent. */
function evidenceSamples(snapshot) {
  return Object.fromEntries(
    EVIDENCE_SOURCES.map((source) => [
      source,
      snapshot ? evidenceSample(snapshot, source) : null,
    ]),
  );
}

function reactWorkSample(snapshot) {
  return snapshot &&
    typeof snapshot.generation === 'string' &&
    isCounterMap(snapshot.counters)
    ? { generation: snapshot.generation, counters: { ...snapshot.counters } }
    : null;
}

function readMainWorkCounters(electronApp, reset, estimateIpcBytes) {
  // A repeated reset only starts the window at the reset whose snapshot
  // arrives, so a lost result is safe to read again.
  return evaluateMainWithRetry(() =>
    electronApp.evaluate(
      (_electron, { shouldReset, estimateBytes }) => {
        // A callback soon after this read reaches a microtask checkpoint, so
        // the inspector delivers the result before a collection can lose it.
        globalThis.setImmediate?.(() => {});
        const query = globalThis.__CANOPY_WORK_COUNTERS__;
        if (!query) return null;
        return shouldReset
          ? query.reset({ estimateIpcBytes: estimateBytes })
          : query.snapshot();
      },
      { shouldReset: reset, estimateBytes: estimateIpcBytes },
    ),
  );
}

function readReactWorkCounters(page, reset) {
  return Promise.resolve().then(() =>
    page.evaluate((shouldReset) => {
      const query = window.__CANOPY_REACT_WORK__;
      if (!query) return null;
      return shouldReset ? query.reset() : query.snapshot();
    }, reset),
  );
}

function defaultNewCDPSession(page) {
  return page.context().newCDPSession(page);
}

/** Settles like `promise`, but rejects as soon as `signal` aborts. */
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Opens the renderer CDP session dedicated to work counters. It is separate
 * from the diagnostics-only session. The session is detached if
 * `Performance.enable` fails, or if `signal` aborts while it is still enabling
 * or before it opens; a session that opens after the abort is never enabled.
 */
export async function openRendererWorkSession(
  page,
  { newCDPSession = defaultNewCDPSession, signal } = {},
) {
  const session = await newCDPSession(page);
  try {
    signal?.throwIfAborted();
    await abortable(session.send('Performance.enable'), signal);
  } catch (error) {
    await Promise.resolve()
      .then(() => session.detach())
      .catch(() => undefined);
    throw error;
  }
  return {
    async sample() {
      const { metrics } = await session.send('Performance.getMetrics');
      return selectChromiumWorkMetrics(metrics);
    },
    detach: () => session.detach(),
  };
}

async function readPosixProcessTree(rootPid) {
  if (process.platform === 'win32' || !Number.isSafeInteger(rootPid)) return [];
  const { stdout } = await execFileAsync(
    'ps',
    ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='],
    { encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const rows = stdout
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
      return match
        ? {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            rssKb: Number(match[3]),
            cpuPercent: Number(match[4]),
            command: match[5],
          }
        : null;
    })
    .filter(Boolean);
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (included.has(row.ppid) && !included.has(row.pid)) {
        included.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => included.has(row.pid));
}

async function raceWithTimeout(promise, timeoutMs) {
  const timeout = Symbol('timeout');
  const timeoutAbortController = new AbortController();
  try {
    const result = await Promise.race([
      promise.catch((error) => ({ error })),
      delay(timeoutMs, timeout, {
        signal: timeoutAbortController.signal,
      }).catch((error) =>
        error?.name === 'AbortError' ? undefined : { error },
      ),
    ]);
    return result === timeout ? { timeout: true } : result;
  } finally {
    timeoutAbortController.abort();
  }
}

function isTransientElectronEvaluationContextError(error) {
  return String(error).includes('Execution context was destroyed');
}

// Pauses before each further attempt at a repeatable main-process read.
const MAIN_EVALUATE_RETRY_DELAYS_MS = Object.freeze([
  10, 50, 100, 250, 500, 1_000,
]);

/**
 * Runs a main-process `electronApp.evaluate` again when it fails with
 * Playwright's "Execution context was destroyed" error. Playwright evaluates
 * with `awaitPromise`, so V8's inspector delivers even a synchronous result
 * through a promise it holds only weakly, and Electron's main process runs
 * that promise's callback only at its next microtask checkpoint. A garbage
 * collection in between answers "Promise was collected", which Playwright
 * reports under that message. The evaluated function did run, so only reads,
 * and operations that are safe to repeat, may use this; the pauses let a
 * collection cycle finish. A crashed or closed app fails with a different
 * error and is never retried.
 */
export async function evaluateMainWithRetry(
  evaluate,
  {
    delaysMs = MAIN_EVALUATE_RETRY_DELAYS_MS,
    pause = (delayMs) => delay(delayMs),
    onRetry,
  } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await evaluate();
    } catch (error) {
      if (
        attempt >= delaysMs.length ||
        !isTransientElectronEvaluationContextError(error)
      ) {
        throw error;
      }
      onRetry?.(error);
      await pause(delaysMs[attempt]);
    }
  }
}

async function readAppMetrics(electronApp, timeoutMs) {
  let retries = 0;
  while (true) {
    const result = await raceWithTimeout(
      Promise.resolve().then(() =>
        electronApp.evaluate(({ app }) => app.getAppMetrics()),
      ),
      timeoutMs,
    );
    if (
      result?.error &&
      retries < APP_METRICS_CONTEXT_RETRY_LIMIT &&
      isTransientElectronEvaluationContextError(result.error)
    ) {
      retries += 1;
      await delay(0);
      continue;
    }
    return result?.timeout || result?.error
      ? { ...result, retries }
      : { value: result, retries };
  }
}

async function installRendererCollector(
  page,
  intervalMs,
  ipcIntervalMs,
  ipcProbeTimeoutMs,
  { longAnimationFrames = false } = {},
) {
  await page.evaluate(
    ({
      configuredIntervalMs,
      configuredIpcIntervalMs,
      ipcTimeoutMs,
      observeLongAnimationFrames,
      maxLongAnimationFrames,
      maxLongAnimationFrameScripts,
      maxInputEvents,
    }) => {
      const existing = window.__CANOPY_DESKTOP_PERF__;
      existing?.stop?.();

      window.__CANOPY_TRANSCRIPT_PERF__ = {
        schemaVersion: 2,
        startedAt: performance.now(),
        stages: {},
        counters: {},
        correlations: [],
      };

      const state = {
        startedAt: performance.now(),
        timeOrigin: performance.timeOrigin,
        frames: [],
        visibilityEvents: [],
        taskEvents: [],
        longTaskObserverAvailable: false,
        intervalMs: configuredIntervalMs,
        intervalDelaysMs: [],
        frameGapsMs: [],
        keyEventHandlerMs: [],
        keyToNextFrameMs: [],
        keyToPaintConfirmationMs: [],
        longTasks: [],
        jsHeapUsedBytes: [],
        ipcSamples: [],
        typingProbeActive: false,
        stopped: false,
        stop: null,
      };

      const visibility = () => ({
        atMs: performance.now(),
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
        activeElement: document.activeElement?.tagName ?? null,
      });
      const onVisibility = () => state.visibilityEvents.push(visibility());
      onVisibility();
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('focus', onVisibility);
      window.addEventListener('blur', onVisibility);
      let lastIntervalAt = performance.now();
      const intervalId = window.setInterval(() => {
        const now = performance.now();
        state.intervalDelaysMs.push(
          Math.max(0, now - lastIntervalAt - configuredIntervalMs),
        );
        lastIntervalAt = now;
        if (performance.memory?.usedJSHeapSize) {
          state.jsHeapUsedBytes.push(performance.memory.usedJSHeapSize);
        }
      }, configuredIntervalMs);

      // Opt-in with frame budgets. A message posted from inside a frame's
      // animation-frame callback runs as the next task, after that frame's
      // style, layout, paint and commit, so its arrival ends the frame's
      // main-thread work. That work, measured from the frame's own
      // timestamp, does not depend on the display refresh rate.
      const frameWorkChannel =
        observeLongAnimationFrames && typeof MessageChannel === 'function'
          ? new MessageChannel()
          : null;
      let frameAwaitingRenderEnd = null;
      if (frameWorkChannel) {
        frameWorkChannel.port1.onmessage = () => {
          if (frameAwaitingRenderEnd) {
            frameAwaitingRenderEnd.renderEndMs = performance.now();
            frameAwaitingRenderEnd = null;
          }
        };
      }
      let animationFrameId = 0;
      let lastFrameAt = 0;
      const onFrame = (now) => {
        if (state.stopped) return;
        const frame = {
          timestampMs: now,
          observedAtMs: performance.now(),
          ...visibility(),
        };
        state.frames.push(frame);
        if (frameWorkChannel) {
          frameAwaitingRenderEnd = frame;
          frameWorkChannel.port2.postMessage(0);
        }
        if (lastFrameAt > 0) state.frameGapsMs.push(now - lastFrameAt);
        lastFrameAt = now;
        animationFrameId = requestAnimationFrame(onFrame);
      };
      animationFrameId = requestAnimationFrame(onFrame);

      // Opt-in with frame budgets: every key and pointer press, with the
      // event's own timestamp, so a frame window can report input to its
      // next frame for clicks as well as typing.
      if (observeLongAnimationFrames) {
        state.inputEvents = [];
        state.inputEventsDropped = 0;
      }
      const onInputEvent = (event) => {
        if (state.stopped) return;
        if (state.inputEvents.length >= maxInputEvents) {
          state.inputEventsDropped += 1;
          return;
        }
        const input = {
          type: event.type,
          eventAtMs: event.timeStamp,
          handledAtMs: performance.now(),
        };
        state.inputEvents.push(input);
        requestAnimationFrame((frameAt) => {
          input.nextFrameMs = frameAt;
          input.nextFrameObservedAtMs = performance.now();
        });
      };
      if (observeLongAnimationFrames) {
        document.addEventListener('keydown', onInputEvent, true);
        document.addEventListener('pointerdown', onInputEvent, true);
      }

      const isMeasuredKey = (event) =>
        state.typingProbeActive &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !['Shift', 'Control', 'Alt', 'Meta'].includes(event.key);
      let keyStartedAt = null;
      const onKeyDown = (event) => {
        if (!isMeasuredKey(event)) return;
        const keyAt = performance.now();
        keyStartedAt = keyAt;
        requestAnimationFrame(() => {
          if (!state.stopped) {
            state.keyToNextFrameMs.push(performance.now() - keyAt);
          }
          requestAnimationFrame(() => {
            if (!state.stopped) {
              state.keyToPaintConfirmationMs.push(performance.now() - keyAt);
            }
          });
        });
      };
      const onKeyUp = (event) => {
        if (!isMeasuredKey(event) || keyStartedAt === null) return;
        const keyAt = keyStartedAt;
        keyStartedAt = null;
        queueMicrotask(() => {
          if (!state.stopped) {
            state.keyEventHandlerMs.push(performance.now() - keyAt);
          }
        });
      };
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup', onKeyUp, true);

      let ipcProbeInFlight = false;
      let ipcSequence = 0;
      const sampleIpc = async () => {
        if (state.stopped || ipcProbeInFlight) return;
        ipcProbeInFlight = true;
        const sampleStartedAt = performance.now();
        let timeoutId = 0;
        try {
          const result = await Promise.race([
            // CAN-6935: a build with the E2E liveness ping times a round
            // trip that does no app work; an older build falls back to a
            // preferences read, which is real work.
            (typeof window.api.e2eLivenessPing === 'function'
              ? window.api.e2eLivenessPing()
              : window.api.loadPreferences()
            ).then(
              () => ({ ok: true }),
              (error) => ({ error: String(error) }),
            ),
            new Promise((resolve) => {
              timeoutId = window.setTimeout(
                () => resolve({ timeout: true }),
                ipcTimeoutMs,
              );
            }),
          ]);
          if (state.stopped) return;
          const outerMs = performance.now() - sampleStartedAt;
          state.ipcSamples.push({
            correlationId: `preferences-ipc-${++ipcSequence}`,
            atMs: sampleStartedAt - state.startedAt,
            outerMs,
            ...(result.timeout
              ? { timeout: true }
              : result.error
                ? { error: result.error }
                : { handlerMs: outerMs, timeout: false }),
          });
        } finally {
          if (timeoutId) window.clearTimeout(timeoutId);
          ipcProbeInFlight = false;
        }
      };
      const ipcIntervalId = window.setInterval(
        () => void sampleIpc(),
        configuredIpcIntervalMs,
      );
      void sampleIpc();

      let observer = null;
      if (typeof PerformanceObserver === 'function') {
        try {
          observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              state.longTasks.push({
                startTime: entry.startTime,
                duration: entry.duration,
                name: entry.name,
              });
            }
          });
          observer.observe({ type: 'longtask' });
          state.longTaskObserverAvailable = true;
        } catch {
          observer = null;
        }
      }

      // Opt-in, so other monitor callers keep their exact renderer footprint.
      // Long Animation Frames are frames over 50 ms; each carries its
      // blocking duration and the scripts that ran in it.
      let longAnimationFrameObserver = null;
      if (observeLongAnimationFrames) {
        state.longAnimationFrames = [];
        state.longAnimationFramesDropped = 0;
        state.longAnimationFrameObserverAvailable = false;
        const supported =
          typeof PerformanceObserver === 'function' &&
          (PerformanceObserver.supportedEntryTypes ?? []).includes(
            'long-animation-frame',
          );
        if (supported) {
          try {
            longAnimationFrameObserver = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                if (state.stopped) return;
                if (
                  state.longAnimationFrames.length >= maxLongAnimationFrames
                ) {
                  state.longAnimationFramesDropped += 1;
                  continue;
                }
                const scripts = Array.from(entry.scripts ?? [])
                  .map((script) => ({
                    invoker: script.invoker ?? '',
                    invokerType: script.invokerType ?? '',
                    sourceURL: script.sourceURL ?? '',
                    sourceFunctionName: script.sourceFunctionName ?? '',
                    sourceCharPosition: script.sourceCharPosition ?? -1,
                    duration: script.duration,
                    executionStart: script.executionStart,
                    forcedStyleAndLayoutDuration:
                      script.forcedStyleAndLayoutDuration ?? 0,
                    pauseDuration: script.pauseDuration ?? 0,
                  }))
                  .sort((left, right) => right.duration - left.duration)
                  .slice(0, maxLongAnimationFrameScripts);
                state.longAnimationFrames.push({
                  startTime: entry.startTime,
                  duration: entry.duration,
                  blockingDuration: entry.blockingDuration ?? 0,
                  renderStart: entry.renderStart ?? 0,
                  styleAndLayoutStart: entry.styleAndLayoutStart ?? 0,
                  scriptCount: entry.scripts?.length ?? 0,
                  scripts,
                });
              }
            });
            longAnimationFrameObserver.observe({
              type: 'long-animation-frame',
            });
            state.longAnimationFrameObserverAvailable = true;
          } catch {
            longAnimationFrameObserver = null;
          }
        }
      }

      state.stop = () => {
        if (state.stopped) return;
        state.stopped = true;
        clearInterval(intervalId);
        clearInterval(ipcIntervalId);
        cancelAnimationFrame(animationFrameId);
        if (frameWorkChannel) frameWorkChannel.port1.onmessage = null;
        document.removeEventListener('keydown', onInputEvent, true);
        document.removeEventListener('pointerdown', onInputEvent, true);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('keyup', onKeyUp, true);
        observer?.disconnect();
        longAnimationFrameObserver?.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('focus', onVisibility);
        window.removeEventListener('blur', onVisibility);
      };
      window.__CANOPY_DESKTOP_PERF__ = state;
    },
    {
      configuredIntervalMs: intervalMs,
      configuredIpcIntervalMs: ipcIntervalMs,
      ipcTimeoutMs: ipcProbeTimeoutMs,
      observeLongAnimationFrames: longAnimationFrames,
      maxLongAnimationFrames: MAX_LONG_ANIMATION_FRAMES,
      maxLongAnimationFrameScripts: MAX_LONG_ANIMATION_FRAME_SCRIPTS,
      maxInputEvents: MAX_INPUT_EVENTS,
    },
  );
}

async function readTranscriptWorkSnapshot(page) {
  return page.evaluate(() => {
    const accumulator = window.__CANOPY_TRANSCRIPT_PERF__;
    return accumulator
      ? { stages: accumulator.stages, counters: accumulator.counters }
      : null;
  });
}

function workErrorMessage(operation, result, timeoutMs) {
  return `${operation}: ${
    result?.timeout ? `timed out after ${timeoutMs}ms` : String(result?.error)
  }`;
}

/**
 * Work-counter collection for one measured page: a phase-boundary Chromium
 * sample at start and stop, plus `sample()` for task brackets. Failures are
 * recorded rather than thrown so timings are never lost to a counter problem.
 */
async function startWorkCounters(
  page,
  { newCDPSession, timeoutMs, electronApp, estimateIpcBytes },
) {
  const raw = {
    chromium: { start: null, end: null },
    app: { start: {}, end: {} },
    route: { start: null, end: null },
    w5: { start: null, end: null },
    errors: [],
  };
  let session = null;
  const opening = new AbortController();
  const opened = await raceWithTimeout(
    openRendererWorkSession(page, { newCDPSession, signal: opening.signal }),
    timeoutMs,
  );
  if (opened?.timeout || opened?.error) {
    // A session still enabling, or one that opens after the deadline, is
    // detached on abort, so it never stays attached for the workload.
    opening.abort();
    raw.errors.push({
      source: 'chromium',
      message: workErrorMessage('open', opened, timeoutMs),
    });
  } else {
    session = opened;
  }

  async function readChromium() {
    if (!session) return { error: 'Chromium work session unavailable' };
    const result = await raceWithTimeout(session.sample(), timeoutMs);
    return result?.timeout || result?.error
      ? {
          error: workErrorMessage('Performance.getMetrics', result, timeoutMs),
        }
      : { value: result };
  }

  const start = await readChromium();
  if (start.value) raw.chromium.start = start.value;
  else if (session)
    raw.errors.push({ source: 'chromium', message: start.error });

  // Sources the window reset successfully; a source that failed is dropped
  // for the whole scenario, so it is not sampled again.
  const appSources = new Set();

  /** Resets (at the window start) or snapshots every live app source. */
  async function readAppWork(reset) {
    const operation = reset ? 'reset' : 'snapshot';
    const wanted = APP_WORK_SOURCES.filter(
      (source) => reset || appSources.has(source),
    );
    const wantsMain = MAIN_WORK_SOURCES.some((source) =>
      wanted.includes(source),
    );
    const [main, react] = await Promise.all([
      wantsMain
        ? raceWithTimeout(
            readMainWorkCounters(electronApp, reset, estimateIpcBytes),
            timeoutMs,
          )
        : null,
      wanted.includes('react')
        ? raceWithTimeout(readReactWorkCounters(page, reset), timeoutMs)
        : null,
    ]);
    const values = {};
    const errors = [];
    const record = (source, result, parse) => {
      const value = result?.timeout || result?.error ? null : parse(result);
      if (value) values[source] = value;
      else {
        errors.push({
          source,
          message:
            result?.timeout || result?.error
              ? workErrorMessage(operation, result, timeoutMs)
              : `${operation}: ${result ? 'invalid snapshot' : 'not installed'}`,
        });
      }
    };
    const mainSamples =
      main?.timeout || main?.error ? null : mainWorkSamples(main);
    for (const source of MAIN_WORK_SOURCES) {
      if (wanted.includes(source)) {
        record(source, main, () => mainSamples?.[source] ?? null);
      }
    }
    if (wanted.includes('react')) record('react', react, reactWorkSample);
    const evidence = evidenceSamples(mainSamples ? main : null);
    return { values, errors, evidence };
  }

  const appStart = await readAppWork(true);
  raw.errors.push(...appStart.errors);
  for (const [source, value] of Object.entries(appStart.values)) {
    raw.app.start[source] = value;
    appSources.add(source);
  }
  for (const source of EVIDENCE_SOURCES)
    raw[source].start = appStart.evidence[source];

  return {
    raw,
    async sample() {
      const [transcript, chromium, app] = await Promise.all([
        raceWithTimeout(readTranscriptWorkSnapshot(page), timeoutMs),
        readChromium(),
        readAppWork(false),
      ]);
      const sample = { errors: [] };
      if (transcript?.timeout || transcript?.error) {
        sample.errors.push({
          source: 'transcript',
          message: workErrorMessage('accumulator', transcript, timeoutMs),
        });
      } else if (!transcript) {
        sample.errors.push({
          source: 'transcript',
          message: 'accumulator: not installed',
        });
      } else {
        sample.transcript = transcript;
      }
      if (chromium.value) sample.chromium = chromium.value;
      else sample.errors.push({ source: 'chromium', message: chromium.error });
      Object.assign(sample, app.values);
      sample.errors.push(...app.errors);
      return sample;
    },
    /** Takes the phase-boundary samples that close the window. */
    async closeWindow() {
      const [end, app] = await Promise.all([
        session ? readChromium() : null,
        readAppWork(false),
      ]);
      if (end?.value) raw.chromium.end = end.value;
      else if (end) raw.errors.push({ source: 'chromium', message: end.error });
      raw.errors.push(...app.errors);
      for (const [source, value] of Object.entries(app.values)) {
        if (value.generation === raw.app.start[source].generation) {
          raw.app.end[source] = value;
        } else {
          raw.errors.push({
            source,
            message: 'counters were reset during the measured window',
          });
        }
      }
      // A reset in the window already reported its error for the main sources.
      for (const source of EVIDENCE_SOURCES) {
        const end = app.evidence[source];
        if (
          raw[source].start &&
          end?.generation === raw[source].start.generation
        ) {
          raw[source].end = end;
        }
      }
    },
    async detach() {
      if (!session) return;
      const current = session;
      session = null;
      const detached = await raceWithTimeout(
        Promise.resolve().then(() => current.detach()),
        timeoutMs,
      );
      if (detached?.timeout || detached?.error) {
        // The counts are already read; a failed detach does not void them.
        raw.errors.push({
          source: 'cleanup',
          message: workErrorMessage('detach', detached, timeoutMs),
        });
      }
    },
  };
}

async function readAndStopRendererCollector(page) {
  return page.evaluate(() => {
    const state = window.__CANOPY_DESKTOP_PERF__;
    if (!state) return null;
    state.stop?.();
    const snapshot = {
      startedAt: state.startedAt,
      timeOrigin: state.timeOrigin,
      frames: state.frames,
      visibilityEvents: state.visibilityEvents,
      taskEvents: state.taskEvents,
      longTaskObserverAvailable: state.longTaskObserverAvailable,
      durationMs: performance.now() - state.startedAt,
      intervalMs: state.intervalMs,
      intervalDelaysMs: state.intervalDelaysMs,
      frameGapsMs: state.frameGapsMs,
      keyEventHandlerMs: state.keyEventHandlerMs,
      keyToNextFrameMs: state.keyToNextFrameMs,
      keyToPaintConfirmationMs: state.keyToPaintConfirmationMs,
      longTasks: state.longTasks,
      ...(state.inputEvents
        ? {
            inputEvents: state.inputEvents,
            inputEventsDropped: state.inputEventsDropped,
          }
        : {}),
      ...(state.longAnimationFrames
        ? {
            longAnimationFrames: state.longAnimationFrames,
            longAnimationFramesDropped: state.longAnimationFramesDropped,
            longAnimationFrameObserverAvailable:
              state.longAnimationFrameObserverAvailable,
          }
        : {}),
      jsHeapUsedBytes: state.jsHeapUsedBytes,
      ipcSamples: state.ipcSamples,
      transcript: window.__CANOPY_TRANSCRIPT_PERF__
        ? {
            schemaVersion: window.__CANOPY_TRANSCRIPT_PERF__.schemaVersion,
            startedAt: window.__CANOPY_TRANSCRIPT_PERF__.startedAt,
            stages: window.__CANOPY_TRANSCRIPT_PERF__.stages,
            counters: window.__CANOPY_TRANSCRIPT_PERF__.counters,
            correlations: window.__CANOPY_TRANSCRIPT_PERF__.correlations,
          }
        : null,
    };
    delete window.__CANOPY_DESKTOP_PERF__;
    delete window.__CANOPY_TRANSCRIPT_PERF__;
    return snapshot;
  });
}

export function normalizeAppMetrics(metrics) {
  return metrics.map((entry) => ({
    pid: entry.pid,
    type: entry.type,
    serviceName: entry.serviceName,
    name: entry.name,
    creationTime: entry.creationTime,
    cpuPercent: entry.cpu?.percentCPUUsage ?? 0,
    idleWakeupsPerSecond: entry.cpu?.idleWakeupsPerSecond,
    workingSetSizeKb: entry.memory?.workingSetSize ?? 0,
    peakWorkingSetSizeKb: entry.memory?.peakWorkingSetSize,
    privateBytesKb: entry.memory?.privateBytes,
  }));
}

export function buildSummary(raw) {
  const resourceSampleErrors = raw.resourceSamples.filter(
    (sample) => sample.error,
  );
  const transientResourceSampleErrors = resourceSampleErrors.filter((sample) =>
    sample.error.includes('Execution context was destroyed'),
  );
  const validResourceSamples = raw.resourceSamples.filter(
    (sample) => !sample.error,
  );
  const resourceTotals = validResourceSamples.map((sample) => ({
    totalCpuPercent: sample.processes.reduce(
      (sum, process) => sum + process.cpuPercent,
      0,
    ),
    totalWorkingSetMb:
      sample.processes.reduce(
        (sum, process) => sum + process.workingSetSizeKb,
        0,
      ) / 1024,
    processCount: sample.processes.length,
  }));
  const nativeTreeSampleErrors = (raw.nativeTreeSamples ?? []).filter(
    (sample) => sample.error,
  );
  const nativeTreeTotals = (raw.nativeTreeSamples ?? [])
    .filter((sample) => !sample.error)
    .map((sample) => ({
      totalCpuPercent: sample.processes.reduce(
        (sum, process) => sum + process.cpuPercent,
        0,
      ),
      totalWorkingSetMb:
        sample.processes.reduce((sum, process) => sum + process.rssKb, 0) /
        1024,
      processCount: sample.processes.length,
    }));
  const workingSets = resourceTotals.map((entry) => entry.totalWorkingSetMb);
  const jsHeapMb = (raw.renderer?.jsHeapUsedBytes ?? []).map(
    (bytes) => bytes / 1024 / 1024,
  );
  const longDurations = (raw.renderer?.longTasks ?? []).map(
    (entry) => entry.duration,
  );
  const processSamples = {};
  for (const sample of validResourceSamples) {
    const totalsByType = {};
    for (const process of sample.processes) {
      const total = (totalsByType[process.type] ??= {
        cpuPercent: 0,
        workingSetMb: 0,
      });
      total.cpuPercent += process.cpuPercent;
      total.workingSetMb += process.workingSetSizeKb / 1024;
    }
    for (const [type, total] of Object.entries(totalsByType)) {
      const bucket = (processSamples[type] ??= {
        cpuPercent: [],
        workingSetMb: [],
      });
      bucket.cpuPercent.push(total.cpuPercent);
      bucket.workingSetMb.push(total.workingSetMb);
    }
  }
  const processAttribution = Object.fromEntries(
    Object.entries(processSamples).map(([type, samples]) => [
      type,
      {
        cpuPercent: summarize(samples.cpuPercent),
        workingSetMb: summarize(samples.workingSetMb),
      },
    ]),
  );

  return {
    ipcOuterMs: summarize(raw.ipcSamples.map((sample) => sample.outerMs)),
    ipcHandlerMs: summarize(
      raw.ipcSamples
        .filter((sample) => !sample.timeout)
        .map((s) => s.handlerMs),
    ),
    ipcTimeoutCount: raw.ipcSamples.filter((sample) => sample.timeout).length,
    ipcErrorCount: raw.ipcSamples.filter((sample) => sample.error).length,
    rendererIntervalDelayMs: summarize(raw.renderer?.intervalDelaysMs ?? []),
    rendererFrameDelayMs: summarizeSeries(
      (raw.renderer?.frameGapsMs ?? []).map((gap) =>
        Math.max(0, gap - EXPECTED_FRAME_MS),
      ),
    ),
    rendererKeyEventHandlerMs: summarize(raw.renderer?.keyEventHandlerMs ?? []),
    rendererKeyToNextFrameMs: summarize(raw.renderer?.keyToNextFrameMs ?? []),
    rendererKeyToPaintConfirmationMs: summarize(
      raw.renderer?.keyToPaintConfirmationMs ?? [],
    ),
    longTasks: summarize(longDurations),
    longTaskTotalMs: longDurations.reduce((sum, value) => sum + value, 0),
    ...(Array.isArray(raw.renderer?.longAnimationFrames)
      ? {
          longAnimationFrames: summarizeLongAnimationFrames(
            raw.renderer.longAnimationFrames,
            {
              available:
                raw.renderer.longAnimationFrameObserverAvailable === true,
              dropped: raw.renderer.longAnimationFramesDropped ?? 0,
            },
          ),
        }
      : {}),
    ...(raw.display ? { display: raw.display } : {}),
    jsHeapUsedMb: summarize(jsHeapMb),
    totalCpuPercent: summarize(
      resourceTotals.map((entry) => entry.totalCpuPercent),
    ),
    totalWorkingSetMb: summarize(workingSets),
    totalWorkingSetDeltaMb:
      workingSets.length > 1
        ? workingSets[workingSets.length - 1] - workingSets[0]
        : 0,
    processCount: summarize(resourceTotals.map((entry) => entry.processCount)),
    supervisedTreeCpuPercent: summarize(
      nativeTreeTotals.map((entry) => entry.totalCpuPercent),
    ),
    supervisedTreeWorkingSetMb: summarize(
      nativeTreeTotals.map((entry) => entry.totalWorkingSetMb),
    ),
    supervisedTreeProcessCount: summarize(
      nativeTreeTotals.map((entry) => entry.processCount),
    ),
    nativeTreeSampleErrorCount: nativeTreeSampleErrors.length,
    resourceSampleErrorCount: resourceSampleErrors.length,
    resourceTransientErrorCount: transientResourceSampleErrors.length,
    resourceFatalErrorCount:
      resourceSampleErrors.length - transientResourceSampleErrors.length,
    resourceValidSampleCount: validResourceSamples.length,
    resourceSampleRetryCount: raw.resourceSamples.reduce(
      (sum, sample) => sum + (sample.retries ?? 0),
      0,
    ),
    rendererCollectionError:
      raw.renderer?.error ?? (raw.renderer ? null : 'missing snapshot'),
    transcriptStages: raw.renderer?.transcript?.stages ?? {},
    transcriptCounters: raw.renderer?.transcript?.counters ?? {},
    ...(raw.work
      ? {
          chromiumWork:
            raw.work.chromium?.start &&
            raw.work.chromium?.end &&
            !raw.work.errors.some((error) => error.source === 'chromium')
              ? diffWorkCounters(raw.work.chromium.start, raw.work.chromium.end)
              : undefined,
          appWork: appWindowWork(raw.work),
          ...(raw.work.route?.start && raw.work.route?.end
            ? {
                routeWork: diffWorkCounters(
                  raw.work.route.start.counters,
                  raw.work.route.end.counters,
                ),
              }
            : {}),
          ...(raw.work.w5?.start && raw.work.w5?.end
            ? {
                w5Work: diffWorkCounters(
                  raw.work.w5.start.counters,
                  raw.work.w5.end.counters,
                ),
              }
            : {}),
          workErrors: raw.work.errors,
        }
      : {}),
    transcriptAttribution: {
      processAggregation: 'per-sample-type-total',
      renderer: {
        stages: raw.renderer?.transcript?.stages ?? {},
        counters: raw.renderer?.transcript?.counters ?? {},
        correlations: raw.renderer?.transcript?.correlations ?? [],
      },
      main: raw.mainTranscript ?? {
        schemaVersion: 1,
        process: 'main',
        stages: {},
        correlations: [],
      },
      ipc: {
        samples: raw.ipcSamples,
        outerMs: summarize(raw.ipcSamples.map((sample) => sample.outerMs)),
      },
      processes: processAttribution,
    },
  };
}

function shortScriptUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return '';
  const withoutQuery = url.split(/[?#]/, 1)[0];
  return withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1) || withoutQuery;
}

/**
 * Long Animation Frame attribution: counts, durations, blocking time, and
 * the scripts that spent the most time in frames over 50 ms. A script is
 * keyed by its invoker, function, and source location, with the source URL
 * shortened to its file name.
 */
export function summarizeLongAnimationFrames(
  entries = [],
  { available = true, dropped = 0 } = {},
) {
  const durations = entries.map((entry) => entry.duration);
  const blocking = entries.map((entry) => entry.blockingDuration ?? 0);
  const scripts = new Map();
  for (const entry of entries) {
    for (const script of entry.scripts ?? []) {
      const sourceURL = shortScriptUrl(script.sourceURL);
      const key = [
        script.invokerType,
        script.invoker,
        script.sourceFunctionName,
        sourceURL,
        script.sourceCharPosition,
      ].join('|');
      const aggregate = scripts.get(key) ?? {
        invokerType: script.invokerType,
        invoker: script.invoker,
        sourceFunctionName: script.sourceFunctionName,
        sourceURL,
        sourceCharPosition: script.sourceCharPosition,
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        forcedStyleAndLayoutMs: 0,
      };
      aggregate.count += 1;
      aggregate.totalDurationMs += script.duration ?? 0;
      aggregate.maxDurationMs = Math.max(
        aggregate.maxDurationMs,
        script.duration ?? 0,
      );
      aggregate.forcedStyleAndLayoutMs +=
        script.forcedStyleAndLayoutDuration ?? 0;
      scripts.set(key, aggregate);
    }
  }
  return {
    available,
    count: entries.length,
    dropped,
    durationMs: summarize(durations),
    blockingDurationMs: summarize(blocking),
    totalBlockingMs: blocking.reduce((total, value) => total + value, 0),
    topScripts: [...scripts.values()]
      .sort((left, right) => right.totalDurationMs - left.totalDurationMs)
      .slice(0, TOP_LONG_ANIMATION_FRAME_SCRIPTS),
  };
}

/**
 * Animation-frame callback intervals inside one renderer-clock window: how
 * many exceeded the 60 Hz and 120 Hz budgets and the longest one. An interval
 * belongs to the window when the frame that ends it does, so the frame just
 * before the window supplies the first interval. A gap still open when the
 * window ends is reported separately, not counted.
 */
export function frameBudgetForWindow(
  frames,
  { startAtMs, endAtMs },
  longAnimationFrames = [],
  { vsyncMs = null, longTasks = [], inputEvents = [] } = {},
) {
  const timestamps = (frames ?? [])
    .map((frame) => frame.timestampMs)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const inWindow = timestamps.filter(
    (timestamp) => timestamp >= startAtMs && timestamp <= endAtMs,
  );
  const before = timestamps.filter((timestamp) => timestamp < startAtMs).at(-1);
  const series = before === undefined ? inWindow : [before, ...inWindow];
  const intervals = [];
  for (let index = 1; index < series.length; index += 1) {
    intervals.push(series[index] - series[index - 1]);
  }
  const over = (budgetMs) =>
    intervals.filter(
      (interval) => interval > budgetMs + FRAME_BUDGET_TOLERANCE_MS,
    ).length;
  const lastFrame = series.at(-1);
  const loaf = (longAnimationFrames ?? []).filter(
    (entry) => entry.startTime >= startAtMs && entry.startTime <= endAtMs,
  );
  // Each frame's main-thread work: from its own timestamp to the end of its
  // rendering steps. Refresh-independent, so it is judged against the 120 Hz
  // budget whatever the display ran at.
  const frameWork = (frames ?? [])
    .filter(
      (frame) =>
        Number.isFinite(frame.timestampMs) &&
        Number.isFinite(frame.renderEndMs) &&
        frame.timestampMs >= startAtMs &&
        frame.timestampMs <= endAtMs,
    )
    .map((frame) => frame.renderEndMs - frame.timestampMs);
  // A frame is dropped for each whole refresh interval that passed without
  // one; an interval up to 1.5 refreshes long is one frame of jitter.
  const droppedFrames = Number.isFinite(vsyncMs)
    ? intervals.reduce(
        (total, interval) =>
          total + Math.max(0, Math.round(interval / vsyncMs) - 1),
        0,
      )
    : null;
  const tasks = (longTasks ?? []).filter(
    (entry) => entry.startTime >= startAtMs && entry.startTime <= endAtMs,
  );
  const inputs = (inputEvents ?? []).filter(
    (input) => input.eventAtMs >= startAtMs && input.eventAtMs <= endAtMs,
  );
  return {
    startAtMs,
    endAtMs,
    windowMs: endAtMs - startAtMs,
    frames: inWindow.length,
    intervals: intervals.length,
    over16_7Ms: over(FRAME_BUDGETS_MS.hz60),
    over8_33Ms: over(FRAME_BUDGETS_MS.hz120),
    // A long window holds far more intervals than a spread call accepts.
    longestIntervalMs: intervals.reduce(
      (longest, interval) =>
        longest === null || interval > longest ? interval : longest,
      null,
    ),
    trailingOpenIntervalMs:
      lastFrame === undefined ? endAtMs - startAtMs : endAtMs - lastFrame,
    intervalMs: summarizeSeries(intervals),
    frameWorkMs: summarizeSeries(frameWork),
    framesOverWorkBudget: frameWork.filter(
      (work) => work > FRAME_BUDGETS_MS.hz120 + FRAME_BUDGET_TOLERANCE_MS,
    ).length,
    droppedFrames,
    longTasks: {
      count: tasks.length,
      totalMs: tasks.reduce((total, entry) => total + entry.duration, 0),
      maxMs: tasks.length > 0 ? Math.max(...tasks.map((t) => t.duration)) : 0,
    },
    input: {
      count: inputs.length,
      delayMs: summarizeSeries(
        inputs.map((input) => input.handledAtMs - input.eventAtMs),
      ),
      toNextFrameMs: summarizeSeries(
        inputs
          .filter((input) => Number.isFinite(input.nextFrameObservedAtMs))
          .map((input) => input.nextFrameObservedAtMs - input.eventAtMs),
      ),
    },
    longAnimationFrames: {
      count: loaf.length,
      totalBlockingMs: loaf.reduce(
        (total, entry) => total + (entry.blockingDuration ?? 0),
        0,
      ),
      maxDurationMs:
        loaf.length > 0 ? Math.max(...loaf.map((entry) => entry.duration)) : 0,
    },
  };
}

/**
 * The advisory frame-budget report for a run's bracketed streamed replies,
 * with the display refresh rate the run used. `replies` holds renderer-clock
 * windows recorded by the scenario (`{ label, start, end }` renderer marks).
 */
export function buildFrameBudgetReport(raw, replies = [], frameWindows = []) {
  const renderer = raw?.renderer;
  const frameGaps = renderer?.frameGapsMs ?? [];
  const observedFrameIntervalP50Ms = summarizeSeries(frameGaps).p50;
  const refresh = effectiveRefresh(raw?.display, observedFrameIntervalP50Ms);
  const measure = (window) =>
    frameBudgetForWindow(
      renderer?.frames,
      { startAtMs: window.start.atMs, endAtMs: window.end.atMs },
      renderer?.longAnimationFrames,
      {
        vsyncMs: refresh.vsyncMs,
        longTasks: renderer?.longTasks,
        inputEvents: renderer?.inputEvents,
      },
    );
  const measurable = (window) =>
    Number.isFinite(window.start?.atMs) && Number.isFinite(window.end?.atMs);
  const windows = replies
    .filter(measurable)
    .map((reply) => ({ label: reply.label, ...measure(reply) }));
  const interactions = frameWindows.filter(measurable).map((window) => ({
    area: window.area,
    label: window.label,
    ...measure(window),
    ...(window.work ? { work: window.work } : {}),
  }));
  return {
    advisory: true,
    method: FRAME_BUDGET_METHOD,
    budgetsMs: FRAME_BUDGETS_MS,
    display: raw?.display ?? null,
    observedFrameIntervalP50Ms,
    refresh,
    replies: windows,
    unmeasuredReplies: replies.length - windows.length,
    ...(frameWindows.length > 0
      ? {
          windows: interactions,
          unmeasuredWindows: frameWindows.length - interactions.length,
          areas: summarizeFrameAreas(renderer, interactions, refresh),
        }
      : {}),
  };
}

/**
 * The refresh rate a run actually rendered at, beside the one the display
 * reports. A hidden or throttled window can run at a different rate than its
 * display; interval counts, dropped frames and input-to-next-frame only mean
 * the same thing between runs at the same effective rate.
 */
export function effectiveRefresh(display, observedFrameIntervalP50Ms) {
  const effectiveHz =
    Number.isFinite(observedFrameIntervalP50Ms) &&
    observedFrameIntervalP50Ms > 0
      ? 1_000 / observedFrameIntervalP50Ms
      : null;
  return {
    displayHz: Number.isFinite(display?.refreshRateHz)
      ? display.refreshRateHz
      : null,
    effectiveHz,
    vsyncMs: Number.isFinite(effectiveHz) ? 1_000 / effectiveHz : null,
    // The 120 Hz budget's interval and drop counts hold only at 120 Hz.
    matchesBudget:
      Number.isFinite(effectiveHz) &&
      Math.abs(effectiveHz - 120) / 120 <= REFRESH_MATCH_TOLERANCE,
  };
}

// Relative effective-refresh difference two runs may have and still be paired.
export const REFRESH_MATCH_TOLERANCE = 0.1;

/**
 * Why two runs' refresh rates make their frame and input timings
 * incomparable, or null when they match. Keyed by scenario name.
 */
export function refreshRateMismatch(baselineRefresh, currentRefresh) {
  if (!baselineRefresh && !currentRefresh) return null;
  if (!baselineRefresh || !currentRefresh) return 'refresh rate missing';
  if (baselineRefresh.displayHz !== currentRefresh.displayHz)
    return `display ${baselineRefresh.displayHz} Hz vs ${currentRefresh.displayHz} Hz`;
  const left = baselineRefresh.effectiveHz;
  const right = currentRefresh.effectiveHz;
  if (!Number.isFinite(left) || !Number.isFinite(right))
    return 'effective refresh rate missing';
  if (Math.abs(left - right) / Math.max(left, right) > REFRESH_MATCH_TOLERANCE)
    return `effective ${left.toFixed(1)} Hz vs ${right.toFixed(1)} Hz`;
  return null;
}

/**
 * One 120 Hz verdict per focus area, over every frame of its windows. An
 * area holds 120 Hz when its frames' main-thread work fits the 8.33 ms budget
 * at p99, it drops no more than 1% of its frames, and it has no long task.
 * The drop rule needs a run that rendered at 120 Hz; at another rate the
 * verdict rests on frame work and long tasks alone and says so.
 */
export function summarizeFrameAreas(renderer, windows, refresh) {
  const byArea = new Map();
  for (const window of windows) {
    const list = byArea.get(window.area) ?? [];
    list.push(window);
    byArea.set(window.area, list);
  }
  const frames = renderer?.frames ?? [];
  const inputEvents = renderer?.inputEvents ?? [];
  const areas = {};
  for (const [area, list] of byArea) {
    const inside = (atMs) =>
      list.some((window) => atMs >= window.startAtMs && atMs <= window.endAtMs);
    const work = frames
      .filter(
        (frame) =>
          Number.isFinite(frame.renderEndMs) && inside(frame.timestampMs),
      )
      .map((frame) => frame.renderEndMs - frame.timestampMs);
    const inputToNextFrame = inputEvents
      .filter(
        (input) =>
          Number.isFinite(input.nextFrameObservedAtMs) &&
          inside(input.eventAtMs),
      )
      .map((input) => input.nextFrameObservedAtMs - input.eventAtMs);
    const sum = (key) => list.reduce((total, w) => total + (w[key] ?? 0), 0);
    const frameCount = sum('frames');
    const droppedFrames = refresh.matchesBudget ? sum('droppedFrames') : null;
    const longTaskCount = list.reduce((t, w) => t + w.longTasks.count, 0);
    const frameWorkMs = summarizeSeries(work);
    const workFits =
      frameWorkMs.count > 0 && frameWorkMs.p99 <= FRAME_BUDGETS_MS.hz120;
    const dropsFit =
      droppedFrames === null || droppedFrames <= frameCount * 0.01;
    areas[area] = {
      windows: list.length,
      frames: frameCount,
      frameWorkMs,
      framesOverWorkBudget: sum('framesOverWorkBudget'),
      droppedFrames,
      droppedFramePercent:
        droppedFrames === null || frameCount === 0
          ? null
          : (droppedFrames / frameCount) * 100,
      longTasks: longTaskCount,
      longestIntervalMs: Math.max(
        0,
        ...list.map((w) => w.longestIntervalMs ?? 0),
      ),
      inputToNextFrameMs: summarizeSeries(inputToNextFrame),
      holds120Hz: workFits && dropsFit && longTaskCount === 0,
      verdictBasis: refresh.matchesBudget
        ? 'frame work, drops, long tasks'
        : 'frame work, long tasks (run did not render at 120 Hz)',
    };
  }
  return areas;
}

/** Console lines for a run's 120 Hz focus-area verdicts. */
export function frameAreaLines(frameBudgets) {
  const areas = frameBudgets?.areas;
  if (!areas) return [];
  const ms = (value) =>
    Number.isFinite(value) ? `${value.toFixed(1)}ms` : 'n/a';
  const refresh = frameBudgets.refresh;
  return [
    `[perf]   120 Hz frames (display ${refresh?.displayHz ?? 'n/a'} Hz, effective ${
      Number.isFinite(refresh?.effectiveHz)
        ? refresh.effectiveHz.toFixed(1)
        : 'n/a'
    } Hz):`,
    ...Object.entries(areas).map(
      ([area, summary]) =>
        `[perf]     ${area}: ${summary.holds120Hz ? 'holds' : 'MISSES'} 120 Hz; ` +
        `frame work p50 ${ms(summary.frameWorkMs.p50)} p95 ${ms(summary.frameWorkMs.p95)} p99 ${ms(summary.frameWorkMs.p99)}, ` +
        `${summary.framesOverWorkBudget}/${summary.frames} over 8.33ms, ` +
        `dropped ${summary.droppedFrames ?? 'n/a'}, long tasks ${summary.longTasks}, ` +
        `input to next frame p95 ${ms(summary.inputToNextFrameMs.p95)}`,
    ),
  ];
}

/** Each app source's change over the measured window, if collected cleanly. */
function appWindowWork(work) {
  const failed = new Set((work.errors ?? []).map((error) => error.source));
  const result = {};
  for (const source of APP_WORK_SOURCES) {
    const start = work.app?.start?.[source];
    const end = work.app?.end?.[source];
    if (start && end && !failed.has(source)) {
      result[source] = diffWorkCounters(start.counters, end.counters);
    }
  }
  return result;
}

export function assertValidResourceSampling(summary) {
  const errorCount = summary.resourceSampleErrorCount ?? 0;
  const transientErrorCount = summary.resourceTransientErrorCount ?? 0;
  const fatalErrorCount =
    summary.resourceFatalErrorCount ?? errorCount - transientErrorCount;
  const validCount = summary.resourceValidSampleCount ?? 0;
  // Electron process churn can invalidate an evaluation context between two
  // otherwise valid samples. Keep the allowance proportional and tightly
  // bounded so long-running concurrency scenarios are not penalized merely
  // for collecting more samples, while still rejecting a noisy monitor.
  const toleratedTransientErrors =
    validCount >= 10 ? Math.max(1, Math.floor(validCount * 0.02)) : 0;
  if (
    fatalErrorCount > 0 ||
    transientErrorCount > toleratedTransientErrors ||
    validCount < 2
  ) {
    throw new Error(
      `Resource sampling was invalid: ${fatalErrorCount} fatal, ${transientErrorCount} transient, ${validCount} valid`,
    );
  }
}

export function assertValidRendererSampling(summary) {
  if (summary.rendererCollectionError) {
    throw new Error(
      `Renderer sampling was invalid: ${summary.rendererCollectionError}`,
    );
  }
}

export function assertValidMonitoring(summary) {
  assertValidResourceSampling(summary);
  assertValidRendererSampling(summary);
}

export function assertValidTypingSampling(raw, tasks) {
  const expected = tasks
    .filter(
      (task) =>
        task.kind.startsWith('type_') &&
        Number.isFinite(task.characters) &&
        task.characters > 0,
    )
    .reduce((sum, task) => sum + task.characters, 0);
  if (expected === 0) return;

  const counts = {
    keyEventHandler: raw.renderer?.keyEventHandlerMs?.length ?? 0,
    keyToNextFrame: raw.renderer?.keyToNextFrameMs?.length ?? 0,
    keyToPaintConfirmation: raw.renderer?.keyToPaintConfirmationMs?.length ?? 0,
  };
  if (Object.values(counts).some((count) => count !== expected)) {
    throw new Error(
      `Typing sampling was invalid: expected ${expected} samples, received ${JSON.stringify(counts)}`,
    );
  }
}

/**
 * The refresh rate of the display showing the measured window, from
 * Electron's `screen` module. Recorded with frame budgets because a 60 Hz and
 * a 120 Hz display give the same work different interval counts.
 */
export async function readDisplayRefreshRate(electronApp, timeoutMs = 5_000) {
  const result = await raceWithTimeout(
    Promise.resolve().then(() =>
      electronApp.evaluate(({ BrowserWindow, screen }) => {
        const [window] = BrowserWindow.getAllWindows();
        const display = window
          ? screen.getDisplayMatching(window.getBounds())
          : screen.getPrimaryDisplay();
        return {
          refreshRateHz: display.displayFrequency,
          scaleFactor: display.scaleFactor,
        };
      }),
    ),
    timeoutMs,
  );
  if (result?.timeout || result?.error || !result) {
    return {
      source: 'electron-screen',
      refreshRateHz: null,
      error: result?.timeout ? 'timeout' : String(result?.error),
    };
  }
  return {
    source: 'electron-screen',
    refreshRateHz: Number.isFinite(result.refreshRateHz)
      ? result.refreshRateHz
      : null,
    scaleFactor: result.scaleFactor,
  };
}

/**
 * Moves the measured window, at its own size, onto the attached display with
 * the highest refresh rate. A hidden window renders at the rate of the display
 * it sits on, so with a 60 Hz external monitor beside a 120 Hz panel the same
 * build can measure at either rate depending on where the window opened.
 */
export async function placeWindowOnFastestDisplay(
  electronApp,
  timeoutMs = 5_000,
) {
  const result = await raceWithTimeout(
    Promise.resolve().then(() =>
      electronApp.evaluate(({ BrowserWindow, screen }) => {
        const [window] = BrowserWindow.getAllWindows();
        if (!window) return { moved: false, reason: 'no window' };
        const displays = screen.getAllDisplays();
        const fastest = displays.reduce((best, candidate) =>
          candidate.displayFrequency > best.displayFrequency ? candidate : best,
        );
        const bounds = window.getBounds();
        const current = screen.getDisplayMatching(bounds);
        const rates = displays.map((entry) => entry.displayFrequency);
        if (current.id === fastest.id)
          return {
            moved: false,
            refreshRateHz: fastest.displayFrequency,
            rates,
          };
        const area = fastest.workArea;
        window.setBounds({
          x: area.x + Math.max(0, Math.floor((area.width - bounds.width) / 2)),
          y:
            area.y + Math.max(0, Math.floor((area.height - bounds.height) / 2)),
          width: bounds.width,
          height: bounds.height,
        });
        return {
          moved: true,
          fromRefreshRateHz: current.displayFrequency,
          refreshRateHz: fastest.displayFrequency,
          rates,
        };
      }),
    ),
    timeoutMs,
  );
  if (result?.timeout || result?.error || !result)
    return {
      moved: false,
      error: result?.timeout ? 'timeout' : String(result?.error),
    };
  return result;
}

export async function startPerformanceMonitor({
  page,
  electronApp,
  sampleIntervalMs,
  probeTimeoutMs = 5_000,
  nativeTreeRootPid,
  resourceBoundarySamples = false,
  workCounters = false,
  estimateIpcBytes = false,
  frameBudgets = false,
  newCDPSession,
}) {
  const initializeMainCollector = () =>
    electronApp.evaluate(() => {
      globalThis.__CANOPY_MAIN_TRANSCRIPT_PERF__ = {
        schemaVersion: 1,
        process: 'main',
        startedAt: performance.now(),
        stages: {},
        correlations: [],
      };
    });
  try {
    await initializeMainCollector();
  } catch (error) {
    if (!isTransientElectronEvaluationContextError(error)) throw error;
    await delay(0);
    await initializeMainCollector();
  }
  // Frame budgets are opt-in, so other monitor callers keep their exact
  // renderer and main-process footprint.
  const placement = frameBudgets
    ? await placeWindowOnFastestDisplay(electronApp, probeTimeoutMs)
    : null;
  const display = frameBudgets
    ? {
        ...(await readDisplayRefreshRate(electronApp, probeTimeoutMs)),
        placement,
      }
    : null;
  await installRendererCollector(
    page,
    Math.min(sampleIntervalMs, 100),
    sampleIntervalMs,
    probeTimeoutMs,
    { longAnimationFrames: frameBudgets },
  );
  // Opt-in, so other monitor callers keep their exact CDP footprint.
  const work = workCounters
    ? await startWorkCounters(page, {
        newCDPSession,
        timeoutMs: probeTimeoutMs,
        electronApp,
        estimateIpcBytes,
      })
    : null;
  const startedAt = nodePerformance.now();
  const raw = {
    sampleIntervalMs,
    ipcSamples: [],
    resourceSamples: [],
    nativeTreeSamples: [],
    renderer: null,
    mainTranscript: null,
    ...(work ? { work: work.raw } : {}),
    ...(display ? { display } : {}),
  };
  let stopped = false;
  const samplingAbortController = new AbortController();

  async function waitForNextSample(sampleStartedAt) {
    try {
      await delay(
        Math.max(
          0,
          sampleIntervalMs - (nodePerformance.now() - sampleStartedAt),
        ),
        undefined,
        { signal: samplingAbortController.signal },
      );
    } catch (error) {
      if (error?.name !== 'AbortError') throw error;
    }
  }

  async function sampleResources() {
    const sampleStartedAt = nodePerformance.now();
    const [result, nativeTreeResult] = await Promise.all([
      readAppMetrics(electronApp, probeTimeoutMs),
      nativeTreeRootPid && process.platform !== 'win32'
        ? readPosixProcessTree(nativeTreeRootPid).then(
            (processes) => ({ processes }),
            (error) => ({ error: String(error), processes: [] }),
          )
        : Promise.resolve(null),
    ]);
    if (nativeTreeResult) {
      raw.nativeTreeSamples.push({
        atMs: sampleStartedAt - startedAt,
        ...nativeTreeResult,
      });
    }
    if (result?.timeout) {
      raw.resourceSamples.push({
        atMs: sampleStartedAt - startedAt,
        processes: [],
        error: 'timeout',
        retries: result.retries,
      });
    } else if (result?.error) {
      raw.resourceSamples.push({
        atMs: sampleStartedAt - startedAt,
        processes: [],
        error: String(result.error),
        retries: result.retries,
      });
    } else {
      raw.resourceSamples.push({
        atMs: sampleStartedAt - startedAt,
        processes: normalizeAppMetrics(result.value),
        retries: result.retries,
      });
    }
  }

  const resourceLoop = (async () => {
    while (!stopped) {
      const sampleStartedAt = nodePerformance.now();
      await sampleResources();
      await waitForNextSample(sampleStartedAt);
    }
  })();

  return {
    ...(work ? { sampleWork: () => work.sample() } : {}),
    async stop() {
      if (stopped) return { raw, summary: buildSummary(raw) };
      stopped = true;
      samplingAbortController.abort();
      if (resourceBoundarySamples) {
        // Short reload windows can finish before the periodic sample. Take a
        // real closing sample, serialized with the opening one, before cleanup.
        await resourceLoop;
        await sampleResources();
      }
      // Close the work window (the final Chromium, main, and React samples)
      // at the stop boundary, read and stop the renderer collector right after
      // it, and only then detach the counters session, so cleanup never lands
      // inside either window. Neither step throws.
      await work?.closeWindow();
      const rendererSnapshot = raceWithTimeout(
        readAndStopRendererCollector(page),
        probeTimeoutMs,
      );
      const mainTranscriptSnapshot = raceWithTimeout(
        electronApp.evaluate(() => {
          const snapshot = globalThis.__CANOPY_MAIN_TRANSCRIPT_PERF__ ?? null;
          delete globalThis.__CANOPY_MAIN_TRANSCRIPT_PERF__;
          return snapshot;
        }),
        probeTimeoutMs,
      );
      await Promise.allSettled([resourceLoop]);
      const rendererResult = await rendererSnapshot;
      await work?.detach();
      const mainTranscriptResult = await mainTranscriptSnapshot;
      raw.renderer =
        rendererResult?.timeout || rendererResult?.error
          ? {
              error: rendererResult.timeout
                ? 'timeout'
                : String(rendererResult.error),
              intervalDelaysMs: [],
              frameGapsMs: [],
              keyEventHandlerMs: [],
              keyToNextFrameMs: [],
              keyToPaintConfirmationMs: [],
              longTasks: [],
              jsHeapUsedBytes: [],
            }
          : rendererResult;
      raw.ipcSamples = Array.isArray(raw.renderer?.ipcSamples)
        ? raw.renderer.ipcSamples
        : [];
      raw.mainTranscript =
        mainTranscriptResult?.timeout || mainTranscriptResult?.error
          ? null
          : mainTranscriptResult;
      return { raw, summary: buildSummary(raw) };
    },
  };
}

/** Renderer clock boundaries in the primary collector, also retained without profiling. */
export async function markRendererTask(page, label) {
  const nodeBeforeMs = nodePerformance.now();
  let event;
  try {
    event = await page.evaluate((label) => {
      const event = {
        label,
        atMs: performance.now(),
        timeOrigin: performance.timeOrigin,
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
        activeElement: document.activeElement?.tagName ?? null,
      };
      window.__CANOPY_DESKTOP_PERF__?.taskEvents.push(event);
      return event;
    }, label);
  } catch (error) {
    event = { label, error: String(error) };
  }
  return { ...event, nodeBeforeMs, nodeAfterMs: nodePerformance.now() };
}
