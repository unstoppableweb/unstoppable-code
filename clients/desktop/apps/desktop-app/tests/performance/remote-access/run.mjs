#!/usr/bin/env node
/**
 * Device-to-device Remote Control runs over real E2E desktops and the real
 * relay: the relay benchmark (CAN-7858), and the soak and the recovery run
 * (CAN-7876). Canonical documentation: docs/desktop-app-performance.md,
 * "Remote Control relay benchmark" and "Remote Control relay soak and
 * recovery".
 *
 *   pnpm run build:e2e
 *   pnpm run perf:desktop:remote-access bench [--profiles loopback,rtt-40ms] [--strict-delivery]
 *   pnpm run perf:desktop:remote-access soak --minutes 15 [--local]
 *   pnpm run perf:desktop:remote-access recovery
 *
 * Results go to `.performance/remote-access/<run>-<time>.json`. Exit status:
 * 0 when the run passed, 1 when it found a problem (a key-to-paint ceiling
 * breach, typing that did not overlap its load, a failed round, a session
 * that did not recover, a leaked window, a phase past its deadline or, with
 * --strict-delivery, lost terminal output), 2 on a usage error. Memory is
 * reported per computer and does not fail a run until CAN-7859 sets a limit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessHostMeasurement,
  startHostMeasurement,
} from '../host-measurement.mjs';
import {
  ensureMockServer,
  PERFORMANCE_MOCK_BASE_URL,
} from '../mock-server.mjs';
import { BENCH_PROFILES, runBench } from './bench.mjs';
import { onCleanup, runCleanup, runCleanupSync } from './cleanup.mjs';
import { runRecovery } from './recovery.mjs';
import { runSoak } from './soak.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);

function usage(message) {
  process.stderr.write(
    `${message}\nUsage: run.mjs bench [--profiles a,b] [--strict-delivery] | soak --minutes <n> [--local] | recovery\n`,
  );
  process.exit(2);
}

/**
 * Longest each step may take. A Playwright call that never answers would
 * otherwise hang the run with its apps open and the performance lock held.
 */
const SETUP_DEADLINE_MS = 2 * 60_000;
const PHASE_DEADLINE_MS = { bench: 45 * 60_000, recovery: 20 * 60_000 };
const SOAK_MARGIN_MS = 20 * 60_000;

/** Options each run accepts; any other is a usage error. */
const RUN_OPTIONS = {
  bench: ['--profiles', '--strict-delivery'],
  soak: ['--minutes', '--local'],
  recovery: [],
};
/** The longest soak whose deadline still fits Node's timer (2^31-1 ms). */
const MAX_SOAK_MINUTES = Math.floor((2 ** 31 - 1 - SOAK_MARGIN_MS) / 60_000);

function parseArguments([run, ...rest]) {
  if (!Object.hasOwn(RUN_OPTIONS, run)) {
    usage(`Unknown run ${String(run)}`);
  }
  const options = {
    run,
    profiles: BENCH_PROFILES,
    minutes: 0,
    local: false,
    strictDelivery: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!RUN_OPTIONS[run].includes(argument)) {
      usage(`Unknown option ${argument} for ${run}`);
    }
    if (argument === '--local') {
      options.local = true;
    } else if (argument === '--strict-delivery') {
      options.strictDelivery = true;
    } else if (argument === '--minutes') {
      options.minutes = Number(rest[index + 1]);
      index += 1;
    } else {
      const names = (rest[index + 1] ?? '').split(',').filter(Boolean);
      options.profiles = BENCH_PROFILES.filter((profile) =>
        names.includes(profile.name),
      );
      if (names.length === 0 || options.profiles.length !== names.length) {
        usage(
          `Unknown profile in ${names.join(',')}; known: ${BENCH_PROFILES.map((profile) => profile.name).join(', ')}`,
        );
      }
      index += 1;
    }
  }
  if (
    run === 'soak' &&
    !(
      Number.isFinite(options.minutes) &&
      options.minutes >= 1 &&
      options.minutes <= MAX_SOAK_MINUTES
    )
  ) {
    usage(
      `soak needs --minutes of at least 1 and at most ${String(MAX_SOAK_MINUTES)}`,
    );
  }
  return options;
}

function problemsOf({ run, strictDelivery }, result) {
  if (run !== 'bench') return result.problems;
  const problems = [];
  // Lenient by default only because of CAN-7871 (terminal output is lost
  // when the connection can't keep up); its fix makes this the default.
  if (
    strictDelivery &&
    (result.terminalBytesLost > 0 || !result.terminalDeliveryIntact)
  ) {
    problems.push(
      `terminal output was not delivered intact: ${String(result.terminalBytesLost)} of ${String(result.terminalBytesProduced)} bytes never reached the controller's window`,
    );
  }
  if (result.keyToPaintMeasurements === 0) {
    problems.push('the bench made no key-to-paint measurement');
  }
  if (!result.keyToPaintWithinCeiling) {
    problems.push(
      'key-to-paint exceeded the p95 100 ms or max 250 ms ceiling, or a key never painted',
    );
  }
  if (!result.keyToPaintOverlappedLoad) {
    problems.push(
      'a key-to-paint measurement did not overlap its load, so it measured nothing; rerun',
    );
  }
  return problems;
}

/**
 * The run in progress, so an interrupted run can write its artifact from
 * the signal handler instead of waiting for a phase that may keep retrying.
 */
const current = {
  options: null,
  startedAt: null,
  hostMeasurement: null,
  result: null,
  /** What the phase has measured so far, kept for a failed or cut run. */
  progress: {},
  written: false,
};

/** Writes the run's artifact once; returns the exit code it implies. */
function writeArtifact(runError) {
  if (current.written) return runError ? 1 : 0;
  current.written = true;
  const { options, startedAt } = current;
  // A phase that failed, timed out or was interrupted still reports what it
  // had measured.
  const result =
    current.result ??
    (Object.keys(current.progress).length > 0
      ? { partial: true, ...current.progress }
      : null);
  const hostLoad = current.hostMeasurement.stop();
  const oneMinuteLoads = hostLoad.samples.map(
    (sample) => sample.loadAverage[0],
  );
  const host = {
    ...assessHostMeasurement(hostLoad),
    logicalCpuCount: hostLoad.logicalCpuCount,
    oneMinuteLoad: {
      start: oneMinuteLoads[0] ?? null,
      // Folded, not spread: a long soak holds a sample per second.
      min: oneMinuteLoads.reduce((low, load) => Math.min(low, load), Infinity),
      max: oneMinuteLoads.reduce(
        (high, load) => Math.max(high, load),
        -Infinity,
      ),
      end: oneMinuteLoads.at(-1) ?? null,
    },
  };
  const problems = runError
    ? [
        `the run failed: ${runError instanceof Error ? runError.message : String(runError)}`,
      ]
    : problemsOf(options, result);
  const artifact = {
    schema: 'canopy-remote-access-run/v1',
    run: options.run,
    ...(options.run === 'bench'
      ? { strictDelivery: options.strictDelivery }
      : {}),
    startedAt,
    completedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    host,
    hostLoad,
    result,
    error: runError
      ? String(runError instanceof Error ? runError.stack : runError)
      : null,
    problems,
  };
  const outDir = path.join(repoRoot, '.performance', 'remote-access');
  mkdirSync(outDir, { recursive: true });
  const out = path.join(
    outDir,
    `${options.run}-${startedAt.replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(
    `REMOTE-ACCESS-${options.run.toUpperCase()} ${JSON.stringify(result)}\n`,
  );
  process.stdout.write(
    `host load: ${host.status}, 1-minute load ${host.oneMinuteLoad.min.toFixed(2)} to ${host.oneMinuteLoad.max.toFixed(2)} on ${String(host.logicalCpuCount)} logical CPUs\n`,
  );
  if (options.run === 'bench' && current.result) {
    process.stdout.write(
      `terminal delivery: ${String(result.terminalBytesProduced - result.terminalBytesLost)} of ${String(result.terminalBytesProduced)} bytes received, ${String(result.terminalBytesLost)} lost, ${result.terminalDeliveryIntact ? 'intact' : 'not intact'} (${options.strictDelivery ? 'strict: a loss fails the run' : 'lenient until CAN-7871; --strict-delivery fails the run on a loss'})\n`,
    );
  }
  for (const problem of problems) process.stdout.write(`problem: ${problem}\n`);
  process.stdout.write(`Artifact: ${out}\n`);
  return problems.length > 0 ? 1 : 0;
}

/** Rejects when `promise` takes longer than `ms`; the late result is ignored. */
function withDeadline(promise, ms, label) {
  promise.catch(() => undefined);
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${label} did not finish within ${String(Math.round(ms / 60_000))} minutes`,
            ),
          ),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  // The desktops reach the mock services, the mock cloud and its relay
  // tokens on the performance suite's origin, as its scenarios do.
  process.env.CANOPY_E2E_MOCK_BASE_URL = PERFORMANCE_MOCK_BASE_URL;
  process.env.CANOPY_E2E_CLOUD_BASE_URL = PERFORMANCE_MOCK_BASE_URL;
  current.options = options;
  current.startedAt = new Date().toISOString();
  // The suite's host load evidence (see host-measurement.mjs), sampled every
  // second for the whole run, so a result can be read against host load.
  current.hostMeasurement = startHostMeasurement();
  let mock = null;
  let runError = null;
  try {
    mock = await withDeadline(
      ensureMockServer(),
      SETUP_DEADLINE_MS,
      'the mock server',
    );
    onCleanup(() => mock.stop());
    if (options.run === 'bench') {
      current.result = await withDeadline(
        runBench({ profiles: options.profiles, progress: current.progress }),
        PHASE_DEADLINE_MS.bench,
        'the bench',
      );
    } else if (options.run === 'soak') {
      current.result = await withDeadline(
        runSoak({
          minutes: options.minutes,
          local: options.local,
          progress: current.progress,
        }),
        options.minutes * 60_000 + SOAK_MARGIN_MS,
        'the soak',
      );
    } else {
      current.result = await withDeadline(
        runRecovery({ progress: current.progress }),
        PHASE_DEADLINE_MS.recovery,
        'the recovery run',
      );
    }
  } catch (error) {
    // A failed run still writes its artifact, host load included.
    runError = error;
  } finally {
    await mock?.stop();
  }
  return writeArtifact(runError);
}

/** Longest a cleanup may take before the run exits anyway. */
const CLEANUP_DEADLINE_MS = 60_000;
let finishing = false;

/**
 * Closes every app, relay, proxy and mock server the run started, then
 * exits, so the guarded command ends and the shared performance lock is
 * released even when the run failed or was interrupted.
 */
async function finish(code, signal = null) {
  if (finishing) return;
  finishing = true;
  setTimeout(() => process.exit(code), CLEANUP_DEADLINE_MS);
  // An interrupted run writes its artifact first and synchronously: its
  // phase may still be retrying, and Playwright's own SIGINT handler (which
  // every Electron launch installs) closes the apps and exits with 130 as
  // soon as they are closed.
  if (signal !== null && current.hostMeasurement !== null) {
    try {
      writeArtifact(new Error(`interrupted by ${signal}`));
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.stack : String(error)}\n`,
      );
    }
  }
  // Synchronous removals (temporary directories) next, before anything
  // yields to Playwright's exit; then the apps, relay, proxy and mock.
  if (signal !== null) runCleanupSync();
  await runCleanup();
  process.exit(code);
}

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    process.stderr.write(`${signal}: closing the run's apps and relay\n`);
    void finish(code, signal);
  });
}

main().then(finish, (error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  return finish(1);
});
