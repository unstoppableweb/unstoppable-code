#!/usr/bin/env node
// The retained-worktrees-idle performance gate (CAN-6969).
//
//   node retained-worktrees-gate.mjs calibrate --output <calibration.json>
//   node retained-worktrees-gate.mjs judge --counts <run.json>... \
//     [--cpu <run.json>...] [--calibration <calibration.json>] \
//     [--summary <file.md>] [--output <report.json>]
//
// Counts come from counters-profile runs and are judged by the work-counter
// ratchet, on the median of the runs, with every counter's min and max; a
// counter that varies between runs is flagged and cannot gate. CPU comes from
// baseline-profile runs and is reported, or failed only when cpuGate is
// 'fail' and the runner calibrated as no slower than its norm.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { percentile, roundMetric } from './statistics.mjs';
import {
  evaluateWorkRatchet,
  readWorkRatchetInputs,
  summarizeWorkDeterminism,
} from './work-ratchet.mjs';

export const GATE_CONFIG_PATH = fileURLToPath(
  new URL('./retained-worktrees-gate.json', import.meta.url),
);
export const CPU_GATES = Object.freeze(['report', 'fail']);
const PHASES = Object.freeze(['idle', 'stale', 'focus']);
const RATCHET_FAILURES = new Set([
  'exceeded',
  'missing',
  'not-run',
  'incompatible',
]);

function fail(message) {
  throw new Error(message);
}

export function validateGateConfig(config) {
  if (config?.version !== 1) fail('The gate config must be version 1');
  if (typeof config.scenario !== 'string') fail('The gate needs a scenario');
  for (const field of ['countRuns', 'cpuRuns']) {
    if (!Number.isInteger(config[field]) || config[field] < 2)
      fail(`${field} must be an integer of at least 2`);
  }
  if (!CPU_GATES.includes(config.cpuGate))
    fail(`cpuGate must be one of ${CPU_GATES.join(', ')}`);
  if (!PHASES.includes(config.cpuPhase))
    fail(`cpuPhase must be one of ${PHASES.join(', ')}`);
  if (!(config.cpuThresholdPercent > 0))
    fail('cpuThresholdPercent must be positive');
  const { normMs, slowMarginPercent } = config.calibration ?? {};
  if (normMs !== null && !(normMs > 0))
    fail('calibration.normMs must be positive or null');
  if (!(slowMarginPercent >= 0))
    fail('calibration.slowMarginPercent must be non-negative');
  return config;
}

export function readGateConfig(path = GATE_CONFIG_PATH) {
  return validateGateConfig(JSON.parse(readFileSync(path, 'utf8')));
}

/** A fixed CPU workload; its time says how fast this runner is right now. */
export function runCalibration({ rounds = 5 } = {}) {
  const block = Buffer.alloc(1 << 20, 7);
  const text = JSON.stringify(
    Array.from({ length: 20_000 }, (_, index) => ({
      index,
      name: `row-${index}`,
      tags: ['a', 'b'],
    })),
  );
  const samplesMs = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    let digest = block;
    for (let pass = 0; pass < 256; pass += 1)
      digest = createHash('sha256').update(block).update(digest).digest();
    for (let pass = 0; pass < 5; pass += 1) JSON.parse(text);
    samplesMs.push(roundMetric(performance.now() - started));
  }
  return { medianMs: roundMetric(percentile(samplesMs, 0.5)), samplesMs };
}

function scenarioOf(result, name) {
  return (result?.scenarios ?? []).find((scenario) => scenario.name === name);
}

function spread(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return null;
  return {
    median: roundMetric(percentile(finite, 0.5)),
    min: Math.min(...finite),
    max: Math.max(...finite),
    values,
  };
}

/** Broken runs, which the gate refuses to judge. */
function runErrors(results, name, expected, label) {
  const errors = [];
  if (results.length !== expected)
    errors.push(`${label}: ${results.length} run(s), expected ${expected}`);
  for (const [index, result] of results.entries()) {
    const scenario = scenarioOf(result, name);
    if (!scenario)
      errors.push(`${label} run ${index + 1}: ${name} did not run`);
    else if (scenario.status === 'error')
      errors.push(
        `${label} run ${index + 1}: ${name} failed: ${scenario.error ?? 'error'}`,
      );
  }
  return errors;
}

/**
 * The scenario's counts over the runs: each counter's median, min and max,
 * judged by the ratchet on the medians. A counter whose runs differ is
 * nondeterministic; one that gates fails, since a varying count cannot be a
 * gate.
 */
export function judgeCounts(results, { config, inputs }) {
  const name = config.scenario;
  const errors = runErrors(results, name, config.countRuns, 'counts');
  // A run that saw no events emits no retained counts; judging the others
  // alone would make the verdict depend on which run broke.
  for (const [index, result] of results.entries()) {
    const scenario = scenarioOf(result, name);
    if (scenario && scenario.status !== 'error' && !scenario.work?.retained)
      errors.push(
        `counts run ${index + 1}: ${name} emitted no retained counts`,
      );
  }
  if (errors.length > 0) return { errors, rows: [], failures: [] };
  const determinism = summarizeWorkDeterminism(results, { scenarios: [name] });
  const median = {
    ...results[0],
    metrics: { ...results[0].metrics },
  };
  for (const row of determinism.rows)
    median.metrics[row.key] = {
      ...median.metrics[row.key],
      value: row.median,
    };
  const verdict = evaluateWorkRatchet(median, inputs);
  const entries = new Map(
    verdict.entries
      .filter((entry) => entry.key.startsWith(`${name}.`))
      .map((entry) => [entry.key, entry]),
  );
  const rows = determinism.rows
    .filter((row) => row.source === 'retained')
    .map((row) => {
      const entry = entries.get(row.key);
      return {
        key: row.key,
        status: inputs.registry.metrics[row.key]?.status ?? 'unregistered',
        median: row.median,
        min: row.min,
        max: row.max,
        varies: row.min !== row.max,
        ceiling: entry?.ceiling ?? null,
        outcome: entry?.outcome ?? 'no-ceiling',
      };
    });
  const failures = [
    ...[...entries.values()]
      .filter(
        (entry) =>
          entry.status === 'gating' && RATCHET_FAILURES.has(entry.outcome),
      )
      .map((entry) => `${entry.key}: ${entry.outcome}`),
    ...rows
      .filter((row) => row.status === 'gating' && row.varies)
      .map(
        (row) =>
          `${row.key}: nondeterministic (${row.min} to ${row.max}), so it cannot gate`,
      ),
  ];
  return {
    errors: [],
    platform: verdict.platform,
    ceilingsRecorded: verdict.ceilingsRecorded,
    incompatibilities: verdict.incompatibilities,
    rows,
    failures,
  };
}

/**
 * Main's CPU per phase over the runs. The configured phase is judged only
 * when every run completed and the runner calibrated as no slower than its
 * recorded norm; otherwise it is inconclusive, never a failure.
 */
export function judgeCpu(results, { config, calibration }) {
  if (results.length === 0)
    return { outcome: 'not-run', failed: false, phases: {} };
  const name = config.scenario;
  const errors = runErrors(results, name, config.cpuRuns, 'cpu');
  // A run that ended without measuring every phase, such as one that timed
  // out as unresponsive, is broken, not inconclusive.
  for (const [index, result] of results.entries()) {
    const scenario = scenarioOf(result, name);
    if (!scenario || scenario.status === 'error') continue;
    const missing = PHASES.filter(
      (phase) =>
        !Number.isFinite(scenario.counters?.[phase]?.mainCpuPercentOfCore),
    );
    if (missing.length)
      errors.push(
        `cpu run ${index + 1}: ${name} (${scenario.status}) measured no CPU for ${missing.join(', ')}`,
      );
  }
  const phases = Object.fromEntries(
    PHASES.map((phase) => [
      phase,
      spread(
        results.map(
          (result) =>
            scenarioOf(result, name)?.counters?.[phase]?.mainCpuPercentOfCore,
        ),
      ),
    ]),
  );
  const { normMs, slowMarginPercent } = config.calibration;
  let calibrationState = 'ok';
  if (!calibration) calibrationState = 'not-measured';
  else if (normMs === null) calibrationState = 'no-norm';
  else if (calibration.medianMs > normMs * (1 + slowMarginPercent / 100))
    calibrationState = 'slow';
  const judged = phases[config.cpuPhase];
  let outcome;
  if (errors.length > 0 || !judged) outcome = 'inconclusive';
  else if (calibrationState !== 'ok') outcome = 'inconclusive';
  else outcome = judged.median > config.cpuThresholdPercent ? 'over' : 'under';
  return {
    gate: config.cpuGate,
    phase: config.cpuPhase,
    thresholdPercent: config.cpuThresholdPercent,
    calibration: calibration ?? null,
    calibrationState,
    errors,
    phases,
    outcome,
    failed: config.cpuGate === 'fail' && outcome === 'over',
  };
}

/**
 * Per-source work behind each event, as the median over the runs, so a
 * regression names its source: W5 reads and captures, config and recovery
 * reads, and IPC per stale signal and per focus, and W5 work per second
 * while idle.
 */
/** A phase's W5 work per event, from its per-second rates and event count. */
function w5PerEvent(phase) {
  const count = phase?.events?.count;
  if (!(count > 0) || !phase.w5PerSecond) return {};
  return Object.fromEntries(
    Object.entries(phase.w5PerSecond).map(([key, rate]) => [
      key,
      roundMetric((rate * phase.seconds) / count),
    ]),
  );
}

export function breakdown(results, name) {
  const sources = {
    'stale per signal': (counters) => ({
      ...w5PerEvent(counters?.stale),
      ...counters?.stale?.events?.perEvent?.metadata,
      ...counters?.stale?.events?.perEvent?.ipc,
    }),
    'focus per event': (counters) => ({
      ...w5PerEvent(counters?.focus),
      ...counters?.focus?.events?.perEvent?.metadata,
    }),
    'idle W5 per second': (counters) => counters?.idle?.w5PerSecond,
  };
  return Object.fromEntries(
    Object.entries(sources).map(([label, pick]) => {
      const perRun = results.map(
        (result) => pick(scenarioOf(result, name)?.counters) ?? {},
      );
      const keys = [
        ...new Set(perRun.flatMap((values) => Object.keys(values))),
      ];
      const rows = keys
        .map((key) => ({
          key,
          ...spread(perRun.map((values) => values[key] ?? 0)),
        }))
        .filter((row) => row.max > 0)
        .sort((left, right) => right.median - left.median);
      return [label, rows];
    }),
  );
}

export function judgeGate({ counts, cpu = [], calibration, config, inputs }) {
  const countVerdict = judgeCounts(counts, { config, inputs });
  const cpuVerdict = judgeCpu(cpu, { config, calibration });
  // A CPU run that failed or wrote nothing is an error too; CPU that was not
  // measured (a PR run) is not.
  const errors = [...countVerdict.errors, ...(cpuVerdict.errors ?? [])];
  const failures = [
    ...countVerdict.failures,
    ...(cpuVerdict.failed
      ? [
          `main CPU ${cpuVerdict.phase} ${cpuVerdict.phases[cpuVerdict.phase].median}% > ${cpuVerdict.thresholdPercent}%`,
        ]
      : []),
  ];
  return {
    scenario: config.scenario,
    passed: errors.length === 0 && failures.length === 0,
    errors,
    failures,
    counts: countVerdict,
    cpu: cpuVerdict,
    breakdown: breakdown(counts, config.scenario),
  };
}

const cell = (value) => (value === null || value === undefined ? '-' : value);

export function formatGateSummary(report) {
  const lines = [
    `## Retained-worktrees gate: ${report.passed ? 'pass' : 'FAIL'}`,
    '',
  ];
  for (const error of report.errors) lines.push(`- Error: ${error}`);
  for (const failure of report.failures) lines.push(`- Failed: ${failure}`);
  if (report.errors.length || report.failures.length) lines.push('');
  const { counts, cpu } = report;
  lines.push('### Counts (counters profile, median of runs)', '');
  if (counts.ceilingsRecorded === false)
    lines.push(
      `No ceilings recorded for ${counts.platform}; nothing gates.`,
      '',
    );
  if (counts.incompatibilities?.length)
    lines.push(
      `Ceilings were recorded with a different ${counts.incompatibilities.join(', ')}.`,
      '',
    );
  lines.push(
    '| Counter | Status | Median | Min | Max | Ceiling | Outcome |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const row of counts.rows)
    lines.push(
      `| \`${row.key.replace(`${report.scenario}.work.retained.`, '')}\` | ${row.status} | ${row.median} | ${row.min} | ${row.max} | ${cell(row.ceiling)} | ${row.varies ? 'nondeterministic' : row.outcome} |`,
    );
  lines.push('', '### Main CPU (baseline profile, % of one core)', '');
  if (cpu.outcome === 'not-run') lines.push('Not measured in this run.');
  else {
    lines.push(
      `Gate: ${cpu.gate}. Judged phase: ${cpu.phase}, threshold ${cpu.thresholdPercent}%. Outcome: ${cpu.outcome}. Calibration: ${cpu.calibrationState}${cpu.calibration ? ` (${cpu.calibration.medianMs} ms)` : ''}.`,
      '',
      '| Phase | Median | Min | Max |',
      '| --- | --- | --- | --- |',
    );
    for (const [phase, values] of Object.entries(cpu.phases))
      lines.push(
        `| ${phase} | ${cell(values?.median)} | ${cell(values?.min)} | ${cell(values?.max)} |`,
      );
    for (const error of cpu.errors) lines.push('', `- CPU run error: ${error}`);
  }
  lines.push('', '### Breakdown (median over count runs)');
  for (const [label, rows] of Object.entries(report.breakdown)) {
    lines.push('', `#### ${label}`, '');
    if (rows.length === 0) {
      lines.push('Nothing counted.');
      continue;
    }
    lines.push('| Source | Median | Min | Max |', '| --- | --- | --- | --- |');
    for (const row of rows.slice(0, 15))
      lines.push(
        `| \`${row.key}\` | ${row.median} | ${row.min} | ${row.max} |`,
      );
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = { counts: [], cpu: [] };
  let list = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--counts' || arg === '--cpu') list = options[arg.slice(2)];
    else if (
      ['--calibration', '--summary', '--output', '--config'].includes(arg)
    ) {
      const value = argv[++index];
      if (!value) fail(`${arg} needs a path`);
      options[arg.slice(2)] = value;
      list = null;
    } else if (list && !arg.startsWith('--')) list.push(arg);
    else fail(`Unknown argument: ${arg}`);
  }
  return options;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
/** A run that wrote no result is judged as not run, not skipped. */
const readRun = (path) => (existsSync(path) ? readJson(path) : null);

export function main(argv) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest);
  if (command === 'calibrate') {
    if (!options.output) fail('calibrate needs --output');
    const calibration = runCalibration();
    writeFileSync(options.output, `${JSON.stringify(calibration, null, 2)}\n`);
    console.log(`[perf] calibration: ${calibration.medianMs} ms`);
    return 0;
  }
  if (command !== 'judge')
    fail('Usage: retained-worktrees-gate.mjs calibrate|judge ...');
  const config = readGateConfig(options.config);
  const report = judgeGate({
    counts: options.counts.map(readRun),
    cpu: options.cpu.map(readRun),
    calibration: options.calibration ? readRun(options.calibration) : null,
    config,
    inputs: readWorkRatchetInputs(),
  });
  const summary = formatGateSummary(report);
  if (options.summary) appendFileSync(options.summary, summary);
  else console.log(summary);
  if (options.output)
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  return report.passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
