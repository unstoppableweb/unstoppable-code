#!/usr/bin/env node
/**
 * Remote Control workload runner (CAN-7754). Canonical documentation:
 * docs/desktop-app-performance.md, "Remote Control workload".
 *
 *   pnpm run perf:desktop:remote-control [options]
 *
 * --scenarios <a,b>      streaming-chat, large-transcript, busy-terminal (all)
 * --repeat <n>           samples per scenario and side (7)
 * --candidate-root <dir> checkout to measure (this checkout)
 * --baseline-root <dir>  also measure this checkout, interleaved per sample
 * --order abba|alternate who goes first in each interleaved sample (abba)
 * --compare <artifact>   judge the candidate against a saved artifact's
 *                        candidate samples (not matched; for a quick look)
 * --runtime electron|node  run the computers under Electron's Node (electron)
 * --out <file>           artifact path (.performance/remote-control/<time>.json)
 *
 * Every sample is a fresh process with fresh workers. Exit status: 0 when
 * every sample drained, 1 when one did not or a verdict regressed, 2 on a
 * usage or setup error.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../statistics.mjs';
import { judgeScenarioMetrics } from '../verdicts.mjs';
import { bundleComputer } from './bundle.mjs';
import { SAMPLE_RESULT_PREFIX } from './sample.mjs';
import { SCENARIO_NAMES, SCENARIOS, WORKLOAD_VERSION } from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const SAMPLE_ENTRY = path.join(here, 'sample.mjs');
export const ARTIFACT_SCHEMA = 'canopy-remote-control-workload/v1';
const MAX_REPEAT = 100;
/** A sample takes under a minute; its drains alone may wait two. */
const SAMPLE_TIMEOUT_MS = 5 * 60_000;

/**
 * Metrics in the artifact. `judged` metrics decide verdicts; the rest are
 * reported. Floors are the smallest change worth calling a regression, on
 * top of the comparator's 5% (see verdicts.mjs).
 */
const SIDE_METRICS = [
  {
    key: 'event_loop_delay.p99_ms',
    unit: 'ms',
    judged: true,
    minRegressionAbsolute: 1,
    read: (side) => side.eventLoopDelay.p99Ms,
  },
  {
    key: 'event_loop_delay.max_ms',
    unit: 'ms',
    judged: true,
    minRegressionAbsolute: 5,
    read: (side) => side.eventLoopDelay.maxMs,
  },
  {
    key: 'event_loop_delay.p50_ms',
    unit: 'ms',
    read: (side) => side.eventLoopDelay.p50Ms,
  },
  {
    key: 'utilization_percent',
    unit: 'percent',
    judged: true,
    minRegressionAbsolute: 0.5,
    read: (side) => side.utilization * 100,
  },
  { key: 'cpu_ms', unit: 'ms', read: (side) => side.cpuMs },
  {
    key: 'wire_out_bytes_per_s',
    unit: 'bytes/s',
    read: (side) => side.wire.bytesOutPerSecond,
  },
  {
    key: 'wire_in_bytes_per_s',
    unit: 'bytes/s',
    read: (side) => side.wire.bytesInPerSecond,
  },
  { key: 'frames_out', unit: 'frames', read: (side) => side.wire.framesOut },
  { key: 'frames_in', unit: 'frames', read: (side) => side.wire.framesIn },
  {
    key: 'heap_peak_mb',
    unit: 'MB',
    read: (side) => side.heapPeakBytes / 1024 / 1024,
  },
];

const WINDOW_METRICS = [
  {
    key: 'window.push_latency.p50_ms',
    unit: 'ms',
    read: (window) => summarize(window.pushLatencyMs).p50,
  },
  {
    key: 'window.push_latency.p95_ms',
    unit: 'ms',
    judged: true,
    minRegressionAbsolute: 2,
    read: (window) => summarize(window.pushLatencyMs).p95,
  },
  {
    key: 'window.push_latency.max_ms',
    unit: 'ms',
    read: (window) => summarize(window.pushLatencyMs).max,
  },
  {
    key: 'window.echo_latency.p50_ms',
    unit: 'ms',
    read: (window) => summarize(window.echoLatencyMs).p50,
  },
  {
    key: 'window.echo_latency.p95_ms',
    unit: 'ms',
    judged: true,
    minRegressionAbsolute: 2,
    read: (window) => summarize(window.echoLatencyMs).p95,
  },
  {
    key: 'window.echo_latency.max_ms',
    unit: 'ms',
    read: (window) => summarize(window.echoLatencyMs).max,
  },
  {
    key: 'window.transcript_page.p50_ms',
    unit: 'ms',
    judged: true,
    minRegressionAbsolute: 2,
    read: (window) => summarize(window.transcriptPageMs).p50,
  },
  {
    key: 'window.transcript_page.max_ms',
    unit: 'ms',
    read: (window) => summarize(window.transcriptPageMs).max,
  },
];

const METRICS = Object.freeze([
  ...['host', 'controller'].flatMap((side) =>
    SIDE_METRICS.map((metric) => ({
      ...metric,
      key: `${side}.${metric.key}`,
      read: (result) => metric.read(result[side]),
    })),
  ),
  {
    key: 'host.transcript_page_serialized_bytes',
    unit: 'bytes',
    read: (result) => result.host.transcriptPageSerializedBytes,
  },
  ...WINDOW_METRICS.map((metric) => ({
    ...metric,
    read: (result) => metric.read(result.window),
  })),
]);

/** One sample's flat metrics; null where the scenario has no such sample. */
function flattenSample(result) {
  const metrics = {};
  for (const metric of METRICS) {
    const value = metric.read(result);
    metrics[metric.key] = Number.isFinite(value) ? value : null;
  }
  return metrics;
}

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = {
    scenarios: [...SCENARIO_NAMES],
    repeat: 7,
    candidateRoot: repoRoot,
    baselineRoot: null,
    order: 'abba',
    compare: null,
    runtime: 'electron',
    out: null,
  };
  const value = (index) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      usage(`${argv[index]} needs a value`);
    }
    return next;
  };
  const setters = {
    '--scenarios': (next) => {
      options.scenarios = next.split(',').filter(Boolean);
    },
    '--repeat': (next) => {
      options.repeat = Number(next);
    },
    '--candidate-root': (next) => {
      options.candidateRoot = path.resolve(next);
    },
    '--baseline-root': (next) => {
      options.baselineRoot = path.resolve(next);
    },
    '--order': (next) => {
      options.order = next;
    },
    '--compare': (next) => {
      options.compare = path.resolve(next);
    },
    '--runtime': (next) => {
      options.runtime = next;
    },
    '--out': (next) => {
      options.out = path.resolve(next);
    },
  };
  for (let index = 0; index < argv.length; index += 2) {
    const set = setters[argv[index]];
    if (!set) usage(`Unknown option ${argv[index]}`);
    set(value(index));
  }
  if (options.scenarios.length === 0) usage('--scenarios names no scenario');
  for (const scenario of options.scenarios) {
    if (!Object.hasOwn(SCENARIOS, scenario)) {
      usage(`Unknown scenario ${scenario}`);
    }
  }
  if (
    !Number.isInteger(options.repeat) ||
    options.repeat < 1 ||
    options.repeat > MAX_REPEAT
  ) {
    usage(`--repeat must be an integer from 1 to ${String(MAX_REPEAT)}`);
  }
  if (!['abba', 'alternate'].includes(options.order)) {
    usage('--order must be abba or alternate');
  }
  if (!['electron', 'node'].includes(options.runtime)) {
    usage('--runtime must be electron or node');
  }
  if (options.baselineRoot && options.compare) {
    usage('Use --baseline-root or --compare, not both');
  }
  return options;
}

function gitState(root) {
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    return {
      root,
      commit: git('rev-parse', 'HEAD'),
      dirty: git('status', '--porcelain').length > 0,
    };
  } catch {
    return { root, commit: null, dirty: null };
  }
}

async function runtimeCommand(runtime) {
  if (runtime === 'node') {
    return { executable: process.execPath, env: {} };
  }
  const { default: electronPath } = await import('electron');
  return { executable: electronPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function runtimeVersions({ executable, env }) {
  const output = execFileSync(
    executable,
    [
      '-e',
      'process.stdout.write(JSON.stringify({node: process.versions.node, electron: process.versions.electron ?? null, v8: process.versions.v8, zlib: process.versions.zlib, openssl: process.versions.openssl}))',
    ],
    { env: { ...process.env, ...env }, encoding: 'utf8' },
  );
  return JSON.parse(output);
}

function runSampleProcess(command, config) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command.executable,
      [SAMPLE_ENTRY, JSON.stringify(config)],
      {
        env: { ...process.env, ...command.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    // A sample that stops making progress is killed and recorded invalid.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SAMPLE_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `Sample ${config.scenario} did not finish within ${String(SAMPLE_TIMEOUT_MS / 1000)} s.`,
          ),
        );
        return;
      }
      const line = stdout
        .split('\n')
        .find((entry) => entry.startsWith(SAMPLE_RESULT_PREFIX));
      if (code !== 0 || !line) {
        reject(
          new Error(
            `Sample ${config.scenario} failed (exit ${String(code)}):\n${stderr.slice(-4_000)}`,
          ),
        );
        return;
      }
      resolve(JSON.parse(line.slice(SAMPLE_RESULT_PREFIX.length)));
    });
  });
}

function sideOrder(sides, index, order) {
  if (sides.length === 1) return sides;
  const flipped = order === 'abba' && index % 2 === 1;
  return flipped ? [...sides].reverse() : sides;
}

/** Per side and scenario: every metric's samples and their summary. */
function summarizeSamples(samples) {
  const summary = {};
  for (const sample of samples) {
    if (!sample.valid) continue;
    summary[sample.side] ??= {};
    const side = summary[sample.side];
    side[sample.scenario] ??= {};
    const scenario = side[sample.scenario];
    for (const [key, value] of Object.entries(sample.metrics)) {
      scenario[key] ??= { samples: [] };
      scenario[key].samples.push(value);
    }
  }
  for (const side of Object.values(summary)) {
    for (const scenario of Object.values(side)) {
      for (const metric of Object.values(scenario)) {
        Object.assign(metric, summarize(metric.samples));
      }
    }
  }
  return summary;
}

/** Judges each scenario's candidate samples against the baseline samples. */
function compareSummaries(baseline, candidate, scenarios) {
  const verdicts = {};
  for (const scenario of scenarios) {
    const baselineMetrics = baseline?.[scenario];
    const candidateMetrics = candidate?.[scenario];
    // A side with no valid sample cannot be compared; that fails the run.
    if (!baselineMetrics || !candidateMetrics) {
      verdicts[scenario] = {
        verdict: 'invalid',
        reason: `no valid ${!baselineMetrics ? 'baseline' : 'candidate'} samples`,
        metrics: [],
      };
      continue;
    }
    const inputs = METRICS.filter(
      (metric) =>
        metric.judged &&
        (candidateMetrics[metric.key]?.count ?? 0) > 0 &&
        (baselineMetrics[metric.key]?.count ?? 0) > 0,
    ).map((metric) => ({
      key: metric.key,
      unit: metric.unit,
      direction: 'lower',
      minRegressionAbsolute: metric.minRegressionAbsolute,
      baseline: baselineMetrics[metric.key].samples.filter(Number.isFinite),
      candidate: candidateMetrics[metric.key].samples.filter(Number.isFinite),
    }));
    verdicts[scenario] = judgeScenarioMetrics(inputs);
  }
  return verdicts;
}

const formatNumber = (value, digits = 2) =>
  Number.isFinite(value) ? value.toFixed(digits) : '-';

const PRINTED_KEYS = [
  'host.event_loop_delay.p99_ms',
  'host.event_loop_delay.max_ms',
  'host.utilization_percent',
  'controller.event_loop_delay.p99_ms',
  'controller.event_loop_delay.max_ms',
  'controller.utilization_percent',
  'host.wire_out_bytes_per_s',
  'controller.wire_in_bytes_per_s',
  'window.push_latency.p95_ms',
  'window.echo_latency.p95_ms',
  'window.transcript_page.p50_ms',
];

function printSummary(summary, verdicts) {
  for (const [side, scenarios] of Object.entries(summary)) {
    for (const [scenario, metrics] of Object.entries(scenarios)) {
      process.stdout.write(`\n${side} / ${scenario} (median of samples)\n`);
      for (const key of PRINTED_KEYS) {
        const metric = metrics[key];
        if (!metric || metric.count === 0) continue;
        const digits = key.includes('bytes') ? 0 : 2;
        process.stdout.write(
          `  ${key.padEnd(38)} ${formatNumber(metric.p50, digits).padStart(12)}  (min ${formatNumber(metric.min, digits)}, max ${formatNumber(metric.max, digits)}, n=${String(metric.count)})\n`,
        );
      }
    }
  }
  for (const [scenario, verdict] of Object.entries(verdicts ?? {})) {
    if (verdict.verdict === 'invalid') {
      process.stdout.write(`\n${scenario}: invalid (${verdict.reason})\n`);
      continue;
    }
    const power = verdict.underpowered
      ? `, underpowered: needs ${String(verdict.requiredSamplesPerSide)}`
      : '';
    process.stdout.write(
      `\n${scenario}: ${verdict.verdict} (${String(verdict.counts.regressed)} regressed, ${String(verdict.counts.improved)} improved, ${String(verdict.samplesPerSide)} samples per side${power})\n`,
    );
    for (const metric of verdict.metrics) {
      if (metric.verdict === 'inconclusive' && !metric.suggestive) continue;
      const suggestive = metric.suggestive ? ' (suggestive)' : '';
      process.stdout.write(
        `  ${metric.key}: ${metric.verdict}${suggestive}, p50 ${formatNumber(metric.baseline.p50)} -> ${formatNumber(metric.candidate.p50)}\n`,
      );
    }
  }
}

/**
 * Reads and checks a `--compare` artifact before any sample runs: it must
 * hold valid candidate samples for every requested scenario.
 */
function loadComparison(file, scenarios) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    usage(`Cannot read ${file}: ${String(error)}`);
  }
  if (saved?.schema !== ARTIFACT_SCHEMA || !saved.summary?.candidate) {
    usage(
      `${file} is not a ${ARTIFACT_SCHEMA} artifact with candidate samples`,
    );
  }
  // Every requested scenario needs samples for at least one judged metric.
  const missing = scenarios.filter((scenario) => {
    const metrics = saved.summary.candidate[scenario];
    return !METRICS.some(
      (metric) =>
        metric.judged &&
        Array.isArray(metrics?.[metric.key]?.samples) &&
        metrics[metric.key].samples.some(Number.isFinite),
    );
  });
  if (missing.length > 0) {
    usage(`${file} has no valid samples for ${missing.join(', ')}`);
  }
  // Samples of another workload are not comparable with this one.
  if (saved.workloadVersion !== WORKLOAD_VERSION) {
    usage(
      `${file} was recorded with workload version ${String(saved.workloadVersion)}, not ${String(WORKLOAD_VERSION)}`,
    );
  }
  const changed = scenarios.filter(
    (scenario) =>
      JSON.stringify(saved.scenarios?.[scenario]) !==
      JSON.stringify(SCENARIOS[scenario]),
  );
  if (changed.length > 0) {
    usage(
      `${file} defines ${changed.join(', ')} differently from this workload`,
    );
  }
  return saved;
}

function judge(artifact, options, saved) {
  if (options.baselineRoot) {
    return compareSummaries(
      artifact.summary.baseline,
      artifact.summary.candidate,
      options.scenarios,
    );
  }
  if (!saved) return null;
  artifact.compareTo = {
    path: options.compare,
    createdAt: saved.createdAt,
    sides: saved.sides,
  };
  return compareSummaries(
    saved.summary.candidate,
    artifact.summary.candidate,
    options.scenarios,
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const saved = options.compare
    ? loadComparison(options.compare, options.scenarios)
    : null;
  const command = await runtimeCommand(options.runtime);
  const sides = [];
  if (options.baselineRoot) {
    sides.push({ name: 'baseline', ...gitState(options.baselineRoot) });
  }
  sides.push({ name: 'candidate', ...gitState(options.candidateRoot) });

  // A fresh private directory, so nothing else can plant a worker bundle.
  const bundleRoot = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-remote-workload-'),
  );
  try {
    const bundles = {};
    for (const side of sides) {
      const outDir = path.join(bundleRoot, side.name);
      mkdirSync(outDir, { recursive: true });
      bundles[side.name] = await bundleComputer(side.root, { outDir });
    }

    const artifact = {
      schema: ARTIFACT_SCHEMA,
      createdAt: new Date().toISOString(),
      options: {
        scenarios: options.scenarios,
        repeat: options.repeat,
        order: options.order,
        runtime: options.runtime,
        matched: options.baselineRoot !== null,
      },
      workloadVersion: WORKLOAD_VERSION,
      scenarios: Object.fromEntries(
        options.scenarios.map((name) => [name, SCENARIOS[name]]),
      ),
      host: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? null,
        totalMemoryBytes: os.totalmem(),
      },
      runtime: runtimeVersions(command),
      sides,
      samples: [],
    };

    let failed = false;
    for (let index = 0; index < options.repeat; index += 1) {
      for (const scenario of options.scenarios) {
        for (const side of sideOrder(sides, index, options.order)) {
          const startedAt = new Date().toISOString();
          const loadAverage = os.loadavg();
          const record = {
            side: side.name,
            scenario,
            index,
            startedAt,
            loadAverage,
          };
          let result;
          try {
            result = await runSampleProcess(command, {
              computerBundle: bundles[side.name],
              scenario,
              seed: 0x7754 + index,
            });
          } catch (error) {
            // An invalid sample stays in the artifact as evidence, out of
            // the summaries and verdicts, and fails the run.
            failed = true;
            artifact.samples.push({
              ...record,
              valid: false,
              error: String(error).slice(0, 4_000),
            });
            process.stdout.write(
              `sample ${String(index + 1)}/${String(options.repeat)} ${scenario} ${side.name}: invalid (${String(error).split('\n')[0]})\n`,
            );
            continue;
          }
          if (!result.drained) failed = true;
          artifact.samples.push({
            ...record,
            valid: result.drained,
            drained: result.drained,
            pushesSent: result.pushesSent,
            probesSent: result.probesSent,
            scheduleLagMs: result.scheduleLagMs,
            metrics: flattenSample(result),
          });
          process.stdout.write(
            `sample ${String(index + 1)}/${String(options.repeat)} ${scenario} ${side.name}: host p99 ${formatNumber(result.host.eventLoopDelay.p99Ms)} ms, controller p99 ${formatNumber(result.controller.eventLoopDelay.p99Ms)} ms, load ${formatNumber(loadAverage[0])}\n`,
          );
        }
      }
    }

    artifact.summary = summarizeSamples(artifact.samples);
    artifact.verdicts = judge(artifact, options, saved);
    if (
      Object.values(artifact.verdicts ?? {}).some((verdict) =>
        ['regressed', 'invalid'].includes(verdict.verdict),
      )
    ) {
      failed = true;
    }

    const out =
      options.out ??
      path.join(
        repoRoot,
        '.performance',
        'remote-control',
        `${artifact.createdAt.replace(/[:.]/g, '-')}.json`,
      );
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
    printSummary(artifact.summary, artifact.verdicts);
    process.stdout.write(`\nArtifact: ${out}\n`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 2;
});
