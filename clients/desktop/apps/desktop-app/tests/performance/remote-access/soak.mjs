/**
 * Device-to-device Remote Control soak (CAN-7876), restored from the
 * `remote-access-soak` spec that commit 5c15612d262 deleted.
 *
 * Controller A keeps windows open on hosts B and C for the given duration
 * while running, in every round and in parallel on both hosts: a burst of
 * tunnelled calls, a streaming terminal job whose output must arrive
 * complete, and every third round a 1 MB attachment upload. The relay is
 * restarted three times mid-run; operations that fail while it is down are counted
 * separately, and every window must reconnect and keep working. Memory and
 * window counts are sampled each minute to catch leaks (for example bridge
 * windows that outlive their sessions), and each computer's heap after a full
 * GC must not grow past a bound from minute 2 to the end (CAN-7859). `local`
 * runs the same work in each host's own window, without Remote Control, for
 * comparison.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { closeCanopy } from '../../electron/launchCanopy.mjs';
import { registerScenario } from '../../electron/seeders/registerScenario.mjs';
import { currentMockBaseUrl } from '../mock-server.mjs';
import { onCleanupSync } from './cleanup.mjs';
import {
  DEMO_APPS,
  latencySummary,
  launchDesktop,
  openRemoteWindow,
  pairDevices,
  remoteState,
  runRemoteTerminal,
  startDeviceRelay,
} from './desktops.mjs';

const WORKTREE_ID = 'demo-main';

async function readProcessSample(desktop) {
  return desktop.electronApp.evaluate(({ BrowserWindow, webContents }) => ({
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
    heapMb: Math.round(process.memoryUsage().heapUsed / 1e6),
    windows: BrowserWindow.getAllWindows().length,
    webContents: webContents.getAllWebContents().length,
  }));
}

async function processSample(desktop) {
  // A window reload (after a reconnect) can briefly interrupt evaluation.
  try {
    return await readProcessSample(desktop);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return readProcessSample(desktop);
  }
}

async function invokeBurst(window, count) {
  return window.evaluate(async (n) => {
    const timings = await Promise.all(
      Array.from({ length: n }, async () => {
        const startedAt = performance.now();
        await window.api.terminal.list();
        return performance.now() - startedAt;
      }),
    );
    return timings;
  }, count);
}

/**
 * Each computer's heap after a full GC is read at this minute, once start-up
 * code and caches have settled, and again after the final checks.
 */
const RETAINED_HEAP_BASELINE_MINUTE = 2;
/**
 * How much more heap any computer may keep after a full GC at the end of a
 * soak than at the baseline (CAN-7859). A 15-minute soak measured 3 to 5 MB
 * on each receiving host; the terminal record keeps about 0.9 KB per round
 * (about 2 MB per 15 minutes), so the bound holds for soaks of several hours,
 * while keeping one round's output or uploads would cross it in minutes.
 */
const RETAINED_HEAP_GROWTH_MAX_MB = 64;

/**
 * Main's heap after a full garbage collection, in MB: what it still holds,
 * without the garbage a sampled heap includes. `--expose-gc` set after start
 * reaches only contexts created later, so the collection runs in a new one.
 */
async function retainedHeapMb(desktop) {
  return desktop.electronApp.evaluate(async () => {
    // Playwright drives main through an attached inspector, which keeps every
    // console message's arguments alive, such as each error Electron logs for
    // a rejected IPC handler (CAN-8049). A packaged app has no inspector, so
    // its stored messages are dropped first: only they, nothing the app holds.
    const session = new (process.getBuiltinModule('inspector').Session)();
    session.connect();
    try {
      await new Promise((resolve, reject) =>
        session.post('Runtime.discardConsoleEntries', (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    } finally {
      session.disconnect();
    }
    process.getBuiltinModule('v8').setFlagsFromString('--expose-gc');
    process.getBuiltinModule('vm').runInNewContext('gc')();
    return Math.round(process.memoryUsage().heapUsed / 1e6);
  });
}

/** `promise`, or a rejection naming `what` once the sample timeout passes. */
async function withinSampleTimeout(promise, what) {
  promise.catch(() => undefined);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${what} took over ${String(SAMPLE_TIMEOUT_MS / 1_000)} s`,
              ),
            ),
          SAMPLE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const UPLOAD_BYTES = 1024 * 1024;
/** How long one memory sample of the three computers may take. */
const SAMPLE_TIMEOUT_MS = 30_000;
/** How long each host has to run a fresh command after a relay restart. */
const RESTART_PROBE_TIMEOUT_MS = 60_000;
/** When in the soak the relay restarts, as fractions of its length. */
const RESTART_AT = [0.25, 0.5, 0.75];
/**
 * How long a relay restart may take, from the kill until both hosts run a
 * fresh command through their windows (CAN-8048). It takes about 3.5 s,
 * including the relay's 2 s outage; the waits above are only outer limits.
 */
const RESTART_RECOVERY_MAX_MS = 30_000;
/**
 * A round whose every operation failed outside a relay restart waits before
 * the next, from 1 s doubling to 10 s, so a controller that lost its relay is
 * not hidden behind thousands of instant failures (CAN-8049). When every
 * operation keeps failing for longer than the limit, timed from the start of
 * the first failed round, the soak stops with that as its problem.
 */
const FAILED_ROUND_BACKOFF_MIN_MS = 1_000;
const FAILED_ROUND_BACKOFF_MAX_MS = 10_000;
const ALL_FAILING_MAX_MS = 60_000;

/**
 * Attaches a 1 MB file to the worktree. Through a remote window the file
 * goes from memory to the controlled computer, which returns its path
 * there; a local window has no upload, so `localDir` gives it a file on
 * disk.
 */
async function uploadAttachment(window, projectId, localDir) {
  let localPath = null;
  if (localDir) {
    const bytes = Buffer.alloc(UPLOAD_BYTES);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }
    localPath = path.join(localDir, `soak-${randomUUID()}.bin`);
    writeFileSync(localPath, bytes);
  }
  try {
    return await window.evaluate(
      async ({ projectId, worktreeId, localPath, size }) => {
        let filePaths;
        if (localPath) {
          filePaths = [localPath];
        } else {
          const bytes = new Uint8Array(size);
          for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = index % 251;
          }
          const file = new File([bytes], `soak-${Date.now()}.bin`);
          filePaths = await window.api.getPathsForFiles([file]);
        }
        if (filePaths.length !== 1 || filePaths[0] === '') {
          throw new Error('The upload returned no path.');
        }
        const response = await window.api.importWorktreeAttachments({
          projectId,
          worktreeId,
          filePaths,
        });
        return response.attachments.length;
      },
      { projectId, worktreeId: WORKTREE_ID, localPath, size: UPLOAD_BYTES },
    );
  } finally {
    // The import copies the file, so the fixture can go once it settles.
    if (localPath) rmSync(localPath, { force: true });
  }
}

/**
 * Terminal output without its escape sequences: OSC (such as the shell's
 * OSC 3008 context marks, which can share a line with the first output
 * line), CSI and two-character escapes. They are control, not output.
 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ESCAPE_SEQUENCES = [
  new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g'),
  new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g'),
  new RegExp(`${ESC}[@-Z\\\\-_]`, 'g'),
];

function withoutEscapes(text) {
  return ESCAPE_SEQUENCES.reduce(
    (plain, pattern) => plain.replace(pattern, ''),
    text,
  );
}

/**
 * Whether the round's output holds every line from 1 to `count`, in order,
 * each on a line of its own once escape sequences are removed: a numbered
 * line that lost its line break, or any other damage to one, fails the check.
 */
function completeSequence(text, round, count) {
  const exact = new RegExp(`^soak-${String(round)}-(\\d+)$`);
  const numbered = new RegExp(`soak-${String(round)}-\\d`);
  const seen = [];
  // Only LF ends a line. A CR at a line's start is the terminal returning
  // the cursor; one inside a line (a CRLF that lost its LF) fails the match.
  for (const raw of withoutEscapes(text).split(/\r?\n/)) {
    const line = raw.replace(/^\r+/, '');
    if (!numbered.test(line)) continue;
    const match = exact.exec(line);
    if (!match) return false;
    seen.push(Number(match[1]));
  }
  return (
    seen.length === count && seen.every((value, index) => value === index + 1)
  );
}

async function waitForRemoteReady(remote, host, controller) {
  await expect
    .poll(
      async () =>
        (await remoteState(controller.window)).hosts.find(
          (entry) => entry.deviceId === host.deviceId,
        )?.connection,
      { timeout: 90_000 },
    )
    .toBe('connected');
  await expect(remote.window.getByTestId('app-sidebar')).toContainText(
    DEMO_APPS[host.demoApp],
    { timeout: 60_000 },
  );
}

const TERMINAL_LINES = 2_000;

/** One round's operations, each timed so a failure can be set against outages. */
function roundWork(report, targets, round, localDir) {
  const timed = (operation) => {
    const record = { startedAt: Date.now(), endedAt: null };
    return operation().then(
      () => {
        record.endedAt = Date.now();
        return record;
      },
      (error) => {
        record.endedAt = Date.now();
        throw Object.assign(new Error(String(error).slice(0, 300)), {
          record,
        });
      },
    );
  };
  return targets.flatMap(({ host, projectId, remote }) => {
    const jobs = [
      timed(() =>
        invokeBurst(remote.window, 20).then((timings) => {
          report.invokeMs.push(...timings);
        }),
      ),
      timed(() =>
        runRemoteTerminal(remote.window, {
          projectId,
          worktreeId: WORKTREE_ID,
          command: `for i in $(seq 1 ${String(TERMINAL_LINES)}); do echo soak-${String(round)}-$i; done; echo SOAK-${String(round)}-$((1+1))DONE; sleep 1`,
          marker: `SOAK-${String(round)}-2DONE`,
          timeoutMs: 120_000,
        }).then((result) => {
          report.terminalJobMs.push(result.elapsedMs);
          if (!completeSequence(result.text, round, TERMINAL_LINES)) {
            throw new Error(`Terminal output incomplete on ${host.label}`);
          }
        }),
      ),
    ];
    if (round % 3 === 0) {
      jobs.push(
        timed(() =>
          uploadAttachment(remote.window, projectId, localDir).then((count) => {
            if (count !== 1) throw new Error('Upload did not import');
            report.uploads += 1;
          }),
        ),
      );
    }
    return jobs;
  });
}

async function killTerminals(targets) {
  // Clean up a round's terminals so PTYs do not accumulate. A round's
  // shells exit on their own after their marker, so one can be gone
  // between the list and the kill; that is not a failure.
  await Promise.all(
    targets.map(({ remote }) =>
      remote.window.evaluate(async () => {
        const terminals = await window.api.terminal.list();
        await Promise.all(
          terminals.map((terminal) =>
            window.api.terminal
              .kill({ terminalId: terminal.id })
              .catch((error) => {
                if (!String(error).includes('Terminal not found')) throw error;
              }),
          ),
        );
      }),
    ),
  );
}

/**
 * Runs the soak. Returns the report and `problems`: failures outside relay
 * outages, missed relay restarts, and bridge windows that leaked.
 */
export async function runSoak({ minutes, local = false, progress = {} }) {
  const relay = await startDeviceRelay();
  const apiKey = `csk_remote_soak_${randomUUID()}`;
  const desktops = [];
  const localDir = local
    ? mkdtempSync(path.join(os.tmpdir(), 'canopy-soak-uploads-'))
    : null;
  // An interrupted soak skips its teardown; the cleanup still removes this.
  if (localDir) {
    onCleanupSync(() => rmSync(localDir, { recursive: true, force: true }));
  }
  const report = {
    minutes,
    local,
    rounds: 0,
    operations: 0,
    failures: [],
    outageFailures: 0,
    relayRestarts: [],
    invokeMs: [],
    terminalJobMs: [],
    uploads: 0,
    samples: [],
    sampleFailures: [],
    // Rounds that waited because all their operations failed outside a
    // restart, and how long; and how long every operation had been failing
    // when that ended the soak early.
    backoff: { rounds: 0, ms: 0 },
    allFailingMs: null,
  };
  // The report so far, written to the artifact if the soak fails.
  progress.report = report;
  const sample = async (startedAt, [a, b, c]) => {
    const atMinute = Math.round((Date.now() - startedAt) / 6_000) / 10;
    const [controller, hostB, hostC] = await withinSampleTimeout(
      Promise.all([a, b, c].map(processSample)),
      'the memory sample',
    );
    report.samples.push({ atMinute, controller, hostB, hostC });
  };
  // Each computer's heap after a full GC, at minute 2 and after the final
  // checks; see RETAINED_HEAP_GROWTH_MAX_MB.
  report.retainedHeap = {
    inspectorConsole: 'discarded before each reading',
    baselineMinute: RETAINED_HEAP_BASELINE_MINUTE,
    maxGrowthMb: RETAINED_HEAP_GROWTH_MAX_MB,
    baseline: null,
    end: null,
    failures: [],
  };
  // Too short to read a baseline after start-up has settled: neither
  // reading is taken, so none can fail the run.
  const checkRetainedHeap = minutes > RETAINED_HEAP_BASELINE_MINUTE;
  if (!checkRetainedHeap) {
    report.retainedHeap.skipped = `the soak is not longer than ${String(RETAINED_HEAP_BASELINE_MINUTE)} minutes`;
  }
  const readRetainedHeap = async ([a, b, c]) => {
    const [controller, hostB, hostC] = await withinSampleTimeout(
      Promise.all([a, b, c].map(retainedHeapMb)),
      'the post-GC heap reading',
    );
    return { controller, hostB, hostC };
  };
  let stopSampling = async () => undefined;
  let relayWarnings = [];
  try {
    await registerScenario(currentMockBaseUrl(), apiKey, {
      cloud: {
        deviceRelay: {
          url: relay.url,
          secret: relay.secret,
          userId: 'remote-access-soak-user',
        },
      },
    });
    const b = await launchDesktop({
      label: 'soak-b',
      demoApp: 'ts-pnpm-vite',
      apiKey,
    });
    desktops.push(b);
    const c = await launchDesktop({
      label: 'soak-c',
      demoApp: 'ts-bun-api',
      apiKey,
    });
    desktops.push(c);
    const a = await launchDesktop({ label: 'soak-a', apiKey });
    desktops.push(a);
    await pairDevices(a, b);
    await pairDevices(a, c);
    const targets = [
      { host: b, projectId: 'demo-ts-pnpm-vite' },
      { host: c, projectId: 'demo-ts-bun-api' },
    ];
    for (const target of targets) {
      target.remote = local
        ? { window: target.host.window }
        : await openRemoteWindow(a, target.host);
    }

    const startedAt = Date.now();
    const deadline = startedAt + minutes * 60_000;
    const restartAt = RESTART_AT.map(
      (fraction) => startedAt + minutes * 60_000 * fraction,
    );
    // Memory is sampled every minute on its own timer, so a round that
    // hangs cannot hold back the samples that would show why.
    let sampling = true;
    let baselineDue = checkRetainedHeap;
    let sampleTimer = null;
    let wakeSampler = () => undefined;
    const sampler = (async () => {
      for (let nextSampleAt = startedAt; sampling; nextSampleAt += 60_000) {
        await new Promise((resolve) => {
          wakeSampler = resolve;
          sampleTimer = setTimeout(
            resolve,
            Math.max(0, nextSampleAt - Date.now()),
          );
        });
        if (!sampling) break;
        await sample(startedAt, [a, b, c]).catch((error) => {
          report.sampleFailures.push(String(error).slice(0, 200));
        });
        if (
          baselineDue &&
          Date.now() - startedAt >= RETAINED_HEAP_BASELINE_MINUTE * 60_000
        ) {
          baselineDue = false;
          report.retainedHeap.baselineAtMinute =
            Math.round((Date.now() - startedAt) / 6_000) / 10;
          report.retainedHeap.baseline = await readRetainedHeap([
            a,
            b,
            c,
          ]).catch((error) => {
            report.retainedHeap.failures.push(String(error).slice(0, 200));
            return null;
          });
        }
      }
    })();
    stopSampling = async () => {
      sampling = false;
      clearTimeout(sampleTimer);
      wakeSampler();
      await sampler;
    };
    // Each relay restart runs while rounds keep going: from the kill until
    // every window works again. An operation that overlaps one may fail.
    const outages = [];
    const restarts = [];
    const restartFailures = [];
    let restartInFlight = false;
    const overlaps = (record, outage) =>
      record.startedAt <= (outage.endedAt ?? Number.POSITIVE_INFINITY) &&
      record.endedAt >= outage.startedAt;
    const overlapsOutage = (record) =>
      outages.some((outage) => overlaps(record, outage));
    // Reconnected is not recovered: each host must run a fresh command
    // through its window before the restart counts as recovered. The rounds'
    // terminal cleanup waits while a probe runs, or it would kill the
    // probe's own terminal. Returns how many attempts the command took.
    let probing = 0;
    const probeHost = async ({ remote, projectId }, label) => {
      let attempt = 0;
      let lastError = null;
      probing += 1;
      try {
        await expect
          .poll(
            async () => {
              attempt += 1;
              const stamp = `${label}-${String(attempt)}`;
              try {
                await runRemoteTerminal(remote.window, {
                  projectId,
                  worktreeId: WORKTREE_ID,
                  command: `echo ${stamp}-$((1+1))DONE; sleep 1`,
                  marker: `${stamp}-2DONE`,
                  timeoutMs: 10_000,
                });
                return true;
              } catch (error) {
                lastError = error;
                return false;
              }
            },
            { timeout: RESTART_PROBE_TIMEOUT_MS, intervals: [500, 1_000] },
          )
          .toBe(true);
      } catch {
        throw new Error(
          `${label}: no command ran within ${String(RESTART_PROBE_TIMEOUT_MS / 1_000)} s: ${String(lastError).slice(0, 200)}`,
        );
      } finally {
        probing -= 1;
      }
      return attempt;
    };
    const restartRelay = async () => {
      const outage = { startedAt: Date.now(), endedAt: null, operations: 0 };
      outages.push(outage);
      const label = `SOAK-RESTART-${String(outages.length)}`;
      let probeAttempts;
      try {
        await relay.restart(2_000);
        // Both hosts at once, so each one's 60 s starts at its own reconnect.
        probeAttempts = await Promise.all(
          targets.map(async (target, index) => {
            await waitForRemoteReady(target.remote, target.host, a);
            return probeHost(target, `${label}-${String(index)}`);
          }),
        );
      } finally {
        // A failed restart closes its outage too, so later round failures
        // are reported rather than counted as outage noise.
        outage.endedAt = Date.now();
      }
      report.relayRestarts.push({
        atMinute: Math.round((outage.startedAt - startedAt) / 6_000) / 10,
        recoveredInMs: outage.endedAt - outage.startedAt,
        probeAttempts,
      });
    };

    let failingSince = null;
    let backoffStep = 0;
    while (Date.now() < deadline) {
      // One restart at a time: the next waits until the previous one has
      // recovered, so each restart record has its own recovery.
      if (
        !local &&
        !restartInFlight &&
        restartAt.length > 0 &&
        Date.now() >= restartAt[0]
      ) {
        restartAt.shift();
        restartInFlight = true;
        restarts.push(
          restartRelay()
            .catch((error) => {
              restartFailures.push(String(error).slice(0, 300));
            })
            .finally(() => {
              restartInFlight = false;
            }),
        );
      }

      report.rounds += 1;
      const round = report.rounds;
      const settled = await Promise.allSettled(
        roundWork(report, targets, round, localDir),
      );
      report.operations += settled.length;
      let overlappedRestart = false;
      let roundStartedAt = Date.now();
      for (const result of settled) {
        const record =
          result.status === 'fulfilled' ? result.value : result.reason.record;
        if (overlapsOutage(record)) overlappedRestart = true;
        roundStartedAt = Math.min(roundStartedAt, record.startedAt);
        for (const outage of outages) {
          if (overlaps(record, outage)) outage.operations += 1;
        }
        if (result.status === 'fulfilled') continue;
        if (overlapsOutage(record)) {
          report.outageFailures += 1;
        } else {
          report.failures.push({ round, error: result.reason.message });
        }
      }
      const inOutage = outages.some((outage) => outage.endedAt === null);
      if (
        settled.length > 0 &&
        settled.every((result) => result.status === 'rejected') &&
        !inOutage &&
        !overlappedRestart
      ) {
        // A restart's own deadline judges the time around it, so a streak
        // counts from the end of the latest restart at the earliest.
        const lastRestartEnd = Math.max(
          0,
          ...outages.map((outage) => outage.endedAt ?? 0),
        );
        // From the start of the round, so time a round spent waiting on a
        // suspended session counts.
        failingSince = Math.max(failingSince ?? roundStartedAt, lastRestartEnd);
        const expired = () => Date.now() - failingSince > ALL_FAILING_MAX_MS;
        if (expired()) {
          report.allFailingMs = Date.now() - failingSince;
          break;
        }
        // Never past the limit: a restart due next would end the streak.
        const waitMs = Math.min(
          FAILED_ROUND_BACKOFF_MAX_MS,
          FAILED_ROUND_BACKOFF_MIN_MS * 2 ** backoffStep,
          ALL_FAILING_MAX_MS - (Date.now() - failingSince) + 1,
        );
        backoffStep += 1;
        report.backoff.rounds += 1;
        report.backoff.ms += waitMs;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (expired()) {
          report.allFailingMs = Date.now() - failingSince;
          break;
        }
      } else {
        // A success or a restart ends the streak.
        failingSince = null;
        backoffStep = 0;
      }
      // Clean up the round's terminals so PTYs do not accumulate; during an
      // outage the window may not answer, and the next round retries. While
      // a restart probe runs, the next round after it cleans up instead.
      if (probing > 0) continue;
      const cleanup = { startedAt: Date.now(), endedAt: null };
      await killTerminals(targets).catch((error) => {
        cleanup.endedAt = Date.now();
        if (!overlapsOutage(cleanup)) {
          report.failures.push({
            round,
            error: `Terminal cleanup failed: ${String(error).slice(0, 200)}`,
          });
        }
      });
    }
    await Promise.all(restarts);
    report.operationsDuringOutages = outages.map((outage) => outage.operations);
    report.restartFailures = restartFailures;
    // After the last restart every window must still work: one fresh
    // command per host, outside any outage.
    report.finalChecks = await Promise.all(
      targets.map(({ host, projectId, remote }) =>
        runRemoteTerminal(remote.window, {
          projectId,
          worktreeId: WORKTREE_ID,
          command: 'echo SOAK-FINAL-$((1+1))DONE; sleep 1',
          marker: 'SOAK-FINAL-2DONE',
          timeoutMs: 60_000,
        }).then(
          () => ({ host: host.label, ok: true }),
          (error) => ({
            host: host.label,
            ok: false,
            error: String(error).slice(0, 200),
          }),
        ),
      ),
    );
    await stopSampling();
    await sample(startedAt, [a, b, c]);
    if (checkRetainedHeap)
      report.retainedHeap.end = await readRetainedHeap([a, b, c]).catch(
        (error) => {
          report.retainedHeap.failures.push(String(error).slice(0, 200));
          return null;
        },
      );
  } finally {
    await stopSampling();
    relayWarnings = relay
      .output()
      .split('\n')
      .filter((line) => /WARN|rate limited|dropped|undeliverable/i.test(line))
      .slice(-20);
    for (const desktop of desktops.reverse()) {
      await closeCanopy(desktop.electronApp, desktop.userDataDir);
    }
    await relay.stop();
    if (localDir) rmSync(localDir, { recursive: true, force: true });
  }

  const problems = report.failures.map(
    (failure) => `round ${String(failure.round)}: ${failure.error}`,
  );
  if (report.rounds === 0) problems.push('the soak ran no rounds');
  if (report.allFailingMs !== null) {
    // The rounds' own errors are listed above; this only says why it stopped.
    problems.push(
      `every operation failed for ${String(report.allFailingMs)} ms outside a relay restart, over the ${String(ALL_FAILING_MAX_MS / 1_000)} s limit, so the soak stopped`,
    );
  }
  if (!local && report.relayRestarts.length !== RESTART_AT.length) {
    problems.push(
      `expected ${String(RESTART_AT.length)} relay restarts, saw ${String(report.relayRestarts.length)}`,
    );
  }
  for (const failure of report.restartFailures ?? []) {
    problems.push(`a relay restart did not recover: ${failure}`);
  }
  for (const restart of report.relayRestarts) {
    if (restart.recoveredInMs > RESTART_RECOVERY_MAX_MS) {
      problems.push(
        `the relay restart at minute ${String(restart.atMinute)} took ${String(restart.recoveredInMs)} ms to recover (the bound is ${String(RESTART_RECOVERY_MAX_MS)} ms)`,
      );
    }
  }
  for (const failure of report.sampleFailures) {
    problems.push(`a memory sample failed: ${failure}`);
  }
  for (const check of report.finalChecks ?? []) {
    if (!check.ok) {
      problems.push(
        `${check.host} did not work after the soak: ${check.error}`,
      );
    }
  }
  for (const [index, count] of (
    report.operationsDuringOutages ?? []
  ).entries()) {
    if (count === 0) {
      problems.push(
        `no operation overlapped relay restart ${String(index + 1)}, so it tested nothing`,
      );
    }
  }
  const first = report.samples[0];
  const last = report.samples.at(-1);
  // One bridge window per connected controller: no leaks across reconnects.
  for (const key of ['hostB', 'hostC']) {
    if (first && last && last[key].windows !== first[key].windows) {
      problems.push(
        `${key} windows went from ${String(first[key].windows)} to ${String(last[key].windows)}`,
      );
    }
  }
  const { baseline, end } = report.retainedHeap;
  for (const failure of report.retainedHeap.failures) {
    problems.push(`a post-GC heap reading failed: ${failure}`);
  }
  if (report.retainedHeap.skipped !== undefined) {
    process.stderr.write(
      `The post-GC heap bound was not checked: ${report.retainedHeap.skipped}.\n`,
    );
  } else if (
    report.retainedHeap.failures.length === 0 &&
    (baseline === null || end === null)
  ) {
    problems.push(
      `the post-GC heap was not read at minute ${String(RETAINED_HEAP_BASELINE_MINUTE)} and after the final checks`,
    );
  }
  report.retainedHeap.growthMb =
    report.retainedHeap.skipped === undefined && baseline && end
      ? Object.fromEntries(
          Object.keys(end).map((key) => [key, end[key] - baseline[key]]),
        )
      : null;
  for (const [key, growth] of Object.entries(
    report.retainedHeap.growthMb ?? {},
  )) {
    if (growth > RETAINED_HEAP_GROWTH_MAX_MB) {
      problems.push(
        `${key} kept ${String(growth)} MB more heap after a full GC than at minute ${String(RETAINED_HEAP_BASELINE_MINUTE)} (${String(baseline[key])} -> ${String(end[key])} MB; the bound is ${String(RETAINED_HEAP_GROWTH_MAX_MB)} MB)`,
      );
    }
  }
  // Sampled heap includes garbage not yet collected: reported, not judged.
  const peakHeapMb = Object.fromEntries(
    ['controller', 'hostB', 'hostC'].map((key) => [
      key,
      Math.max(0, ...report.samples.map((entry) => entry[key].heapMb)),
    ]),
  );
  return {
    ...report,
    peakHeapMb,
    relayWarnings,
    invokeMs: latencySummary(report.invokeMs),
    terminalJobMs: latencySummary(report.terminalJobMs),
    problems,
  };
}
