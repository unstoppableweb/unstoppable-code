#!/usr/bin/env node
// The retained-worktrees-idle performance gate (CAN-6969).
//
//   node retained-worktrees-gate.mjs calibrate --output <calibration.json>
//   node retained-worktrees-gate.mjs judge --counts <run.json>... \
//     [--cpu <run.json>...] [--calibration <calibration.json>] \
//     [--summary <file.md>] [--output <report.json>]
//   node retained-worktrees-gate.mjs matched-args
//   node retained-worktrees-gate.mjs matched --dir <interleaved output dir> \
//     [--pr <number>] [--record-baseline [--side <side> --run <id>] \
//     [--note <host>]] [--summary <file.md>] [--output <report.json>]
//
// Counts come from counters-profile runs and are judged by the work-counter
// ratchet, on the median of the runs, with every counter's min and max; a
// counter that varies between runs is flagged and cannot gate. CPU comes from
// baseline-profile runs and is reported, or failed only when cpuGate is
// 'fail' and the runner calibrated as no slower than its norm.
//
// `matched` (CAN-7148) judges one interleaved before/after run at the 170
// tier on three idle signals and fails only on an unaccepted REGRESSED one.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile, roundMetric } from './statistics.mjs';
import { judgeScenarioMetrics, requiredSamplesPerSide } from './verdicts.mjs';
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

export const MATCHED_GATES = Object.freeze(['block', 'report']);
const MATCHED_SIDES = Object.freeze(['baseline', 'candidate']);
// Main counts every worktree list write it stages, whichever store commits
// it. `host.commit.<operation>` is not used: main records it only when it
// hosts the commit log itself, never on the daemon-backed store builds ship.
const WORKTREE_LIST_WRITE = 'replace.worktrees';

/**
 * The matched run's signals (CAN-7148), each read from one sample's idle
 * phase. A capture is counted once whichever store served it (see
 * `retainedIdleRates`); a list commit is one `worktrees.json` write.
 */
export const MATCHED_SIGNALS = Object.freeze({
  mainCpuIdlePercent: (idle) => idle.mainCpuPercentOfCore,
  w5MetadataReadsAndCapturesPerSecond: (idle) =>
    roundMetric(idle.metadataReadsPerSecond + idle.metadataCapturesPerSecond),
  // Whole writes from the rounded rate, so 2 in a minute reads 2, not 1.98.
  worktreeListCommitsPerMinute: (idle) =>
    roundMetric(
      (Math.round((idle.w5PerSecond[WORKTREE_LIST_WRITE] ?? 0) * idle.seconds) /
        idle.seconds) *
        60,
      2,
    ),
});
const SIGNAL_IDS = Object.keys(MATCHED_SIGNALS);

function fail(message) {
  throw new Error(message);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (value) =>
  typeof value === 'string' &&
  ISO_DATE.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const FOLLOW_UP_TICKET = /^[A-Z][A-Z0-9]*-\d+$/;
const PLACEHOLDER = /[<>]|^(tbd|todo|none|unknown|n\/a|-)$/i;
const isNamed = (value) =>
  typeof value === 'string' &&
  value.trim() !== '' &&
  !PLACEHOLDER.test(value.trim());

/**
 * A regression a person accepted for one PR: the signals, who approved it,
 * when, and the dated follow-up ticket. Missing either the approver or the
 * follow-up makes the config invalid, so the gate fails rather than passes.
 */
function validateAcceptedRegression(entry, index) {
  const label = `matched.acceptedRegressions[${index}]`;
  if (!Number.isInteger(entry?.pr) || entry.pr < 1)
    fail(`${label} needs the PR number it applies to`);
  if (
    !Array.isArray(entry.signals) ||
    entry.signals.length === 0 ||
    entry.signals.some((id) => !SIGNAL_IDS.includes(id))
  )
    fail(`${label} needs the accepted signals, from ${SIGNAL_IDS.join(', ')}`);
  if (!isNamed(entry.approver)) fail(`${label} needs a named approver`);
  if (!isIsoDate(entry.approvedOn))
    fail(`${label} needs approvedOn as YYYY-MM-DD`);
  if (!FOLLOW_UP_TICKET.test(entry.followUp?.ticket ?? ''))
    fail(`${label} needs a follow-up ticket, such as CAN-1234`);
  if (!isIsoDate(entry.followUp.due) || entry.followUp.due < entry.approvedOn)
    fail(
      `${label} needs a follow-up due date, YYYY-MM-DD, on or after approvedOn`,
    );
  if (!isNamed(entry.reason)) fail(`${label} needs a reason`);
}

const isCommit = (value) => /^[0-9a-f]{40}$/.test(value ?? '');
// The bare id, not the URL: the gate config ships in the public export, which
// refuses this private repository's URL. The run is always this repository's.
const isRunId = (value) =>
  typeof value === 'string' && /^[1-9]\d*$/.test(value);

function validateDevelopBaseline(baseline) {
  if (baseline === null) return;
  const label = 'matched.baseline';
  if (!isIsoDate(baseline?.recordedOn))
    fail(`${label} needs recordedOn as YYYY-MM-DD`);
  if (!isCommit(baseline.commit))
    fail(`${label} needs the develop commit it measured`);
  // One side of a matched run: which side, the commit on the other, the run,
  // when it ran and why it was used.
  if (baseline.side !== undefined) {
    if (!MATCHED_SIDES.includes(baseline.side))
      fail(`${label}.side must be one of ${MATCHED_SIDES.join(', ')}`);
    if (!isCommit(baseline.pairedCommit))
      fail(`${label} needs pairedCommit, the other side's commit`);
    if (!isRunId(baseline.run))
      fail(`${label} needs run, the run's numeric id as a string`);
    if (!isIsoDate(baseline.measuredOn))
      fail(`${label} needs measuredOn as YYYY-MM-DD`);
    if (!isNamed(baseline.note)) fail(`${label} needs a note`);
  }
  if (!Number.isInteger(baseline.samplesPerSide))
    fail(`${label} needs samplesPerSide`);
  for (const id of SIGNAL_IDS)
    for (const side of ['baseline', 'candidate'])
      if (!Number.isFinite(baseline.signals?.[id]?.[side]?.p50))
        fail(`${label} needs the ${side} p50 of ${id}`);
}

function validateMatched(matched) {
  if (typeof matched !== 'object' || matched === null)
    fail('The gate config needs a matched section');
  if (!MATCHED_GATES.includes(matched.gate))
    fail(`matched.gate must be one of ${MATCHED_GATES.join(', ')}`);
  for (const field of ['pathsFile', 'profile'])
    if (typeof matched[field] !== 'string' || matched[field] === '')
      fail(`matched.${field} must be a non-empty string`);
  if (
    !Number.isInteger(matched.retainedWorktrees) ||
    matched.retainedWorktrees < 1
  )
    fail('matched.retainedWorktrees must be a positive integer');
  if (!Number.isInteger(matched.warmup) || matched.warmup < 0)
    fail('matched.warmup must be a non-negative integer');
  if (!(matched.alpha > 0 && matched.alpha < 1))
    fail('matched.alpha must be between 0 and 1');
  if (!(matched.minEffectPercent >= 0))
    fail('matched.minEffectPercent must be non-negative');
  const ids = (matched.signals ?? []).map((signal) => signal?.id);
  if (
    !Array.isArray(matched.signals) ||
    ids.length !== SIGNAL_IDS.length ||
    SIGNAL_IDS.some((id) => !ids.includes(id))
  )
    fail(`matched.signals must list exactly ${SIGNAL_IDS.join(', ')}`);
  for (const signal of matched.signals) {
    if (!isNamed(signal.label) || !isNamed(signal.unit))
      fail(`matched signal ${signal.id} needs a label and a unit`);
    // A zero floor would let any significant wobble block a PR.
    if (!(signal.minEffectAbsolute > 0))
      fail(`matched signal ${signal.id} needs a positive minEffectAbsolute`);
  }
  // Fewer samples could never reach significance, so the gate never blocks.
  const required = requiredSamplesPerSide(matched.alpha, SIGNAL_IDS.length);
  if (!Number.isInteger(matched.repeat) || matched.repeat < required)
    fail(
      `matched.repeat must be at least ${required}: with fewer samples per side no regression can be significant`,
    );
  validateDevelopBaseline(matched.baseline);
  if (!Array.isArray(matched.acceptedRegressions))
    fail('matched.acceptedRegressions must be a list');
  matched.acceptedRegressions.forEach(validateAcceptedRegression);
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
  if (!Array.isArray(config.flags)) fail('flags must be a list');
  for (const flag of config.flags) {
    if (typeof flag?.metric !== 'string' || flag.metric === '')
      fail('Each flag needs a metric');
    if (!Number.isFinite(flag.above))
      fail(`Flag ${flag.metric} needs a numeric 'above'`);
    if (typeof flag.reason !== 'string' || flag.reason === '')
      fail(`Flag ${flag.metric} needs a reason`);
  }
  validateMatched(config.matched);
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
 * Watched counts: each flag's metric median against its `above` value. A
 * flag only warns; whether a count fails is the registry's call.
 */
export function judgeFlags(rows, { config }) {
  const medians = new Map(rows.map((row) => [row.key, row.median]));
  return config.flags.map((flag) => {
    const median =
      medians.get(`${config.scenario}.work.retained.${flag.metric}`) ?? null;
    let outcome = 'missing';
    if (median !== null) outcome = median > flag.above ? 'flagged' : 'ok';
    return { ...flag, median, outcome };
  });
}

const prefixed = (prefix, values) =>
  Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [
      `${prefix}${key}`,
      value,
    ]),
  );

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

/**
 * Per-source work behind each event, as the median over the runs, so a
 * regression names its source: W5 reads and captures, config and recovery
 * reads, IPC, and the broad stale signal by the source that asked, per stale
 * signal, per focus and per applied chat provider event, and W5 work and
 * stale signals per second while idle.
 */
export function breakdown(results, name) {
  const sources = {
    'stale per signal': (counters) => ({
      ...w5PerEvent(counters?.stale),
      ...counters?.stale?.events?.perEvent?.metadata,
      ...counters?.stale?.events?.perEvent?.ipc,
      ...prefixed('stale.', counters?.stale?.events?.perEvent?.stale),
    }),
    'focus per event': (counters) => ({
      ...w5PerEvent(counters?.focus),
      ...counters?.focus?.events?.perEvent?.metadata,
      ...prefixed('stale.', counters?.focus?.events?.perEvent?.stale),
    }),
    'chat per provider event': (counters) => ({
      ...w5PerEvent(counters?.chat),
      ...counters?.chat?.events?.perEvent?.metadata,
      ...prefixed('stale.', counters?.chat?.events?.perEvent?.stale),
    }),
    'idle W5 per second': (counters) => counters?.idle?.w5PerSecond,
    'idle stale signal per second': (counters) =>
      counters?.idle?.stalePerSecond,
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

export function judgeGate({
  counts,
  cpu = [],
  calibration,
  config,
  inputs,
  commitRange = null,
}) {
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
    commitRange,
    passed: errors.length === 0 && failures.length === 0,
    errors,
    failures,
    counts: countVerdict,
    flags: judgeFlags(countVerdict.rows, { config }),
    cpu: cpuVerdict,
    breakdown: breakdown(counts, config.scenario),
  };
}

const measuredCommit = (result) =>
  result?.source?.measuredBuild?.commit ?? result?.source?.commit ?? null;

/**
 * One side's signal values, one per sample. A sample that failed or has no
 * idle work counters is an error, never a clean zero; one that finished
 * unresponsive still measured its idle window and is kept, with a note.
 */
function matchedSide(result, side, { config }) {
  const { matched, scenario: name } = config;
  const values = Object.fromEntries(SIGNAL_IDS.map((id) => [id, []]));
  const errors = [];
  const notes = [];
  if (!result) return { values, errors: [`${side}: no result`], notes };
  if (result.profile !== matched.profile)
    errors.push(
      `${side}: profile ${result.profile ?? 'missing'}, expected ${matched.profile}`,
    );
  if (result.config?.retainedWorktrees !== matched.retainedWorktrees)
    errors.push(
      `${side}: ${result.config?.retainedWorktrees ?? 'no'} retained worktrees, expected ${matched.retainedWorktrees}`,
    );
  const samples = (result.scenarios ?? []).filter(
    (scenario) => scenario.name === name,
  );
  if (samples.length < matched.repeat)
    errors.push(
      `${side}: ${samples.length} sample(s) of ${name}, expected at least ${matched.repeat}`,
    );
  for (const [index, scenario] of samples.entries()) {
    const label = `${side} sample ${(scenario.sample ?? index) + 1}`;
    if (scenario.status === 'error') {
      errors.push(`${label}: ${name} failed: ${scenario.error ?? 'error'}`);
      continue;
    }
    const idle = scenario.counters?.idle;
    // Null metadata rates mean the build had no work counters at all.
    if (!idle?.w5PerSecond || !idle.metadataPerSecond) {
      errors.push(`${label}: no idle work counters`);
      continue;
    }
    const sample = SIGNAL_IDS.map((id) => [id, MATCHED_SIGNALS[id](idle)]);
    const unmeasured = sample.filter(([, value]) => !Number.isFinite(value));
    if (unmeasured.length > 0) {
      errors.push(
        `${label}: measured no ${unmeasured.map(([id]) => id).join(', ')}`,
      );
      continue;
    }
    for (const [id, value] of sample) values[id].push(value);
    if (scenario.status !== 'ok') notes.push(`${label}: ${scenario.status}`);
  }
  return { values, errors, notes };
}

/** The accepted-regression entry covering `signal` for `pr`, if any. */
function acceptanceFor(config, pr, signal) {
  if (pr === null) return null;
  return (
    config.matched.acceptedRegressions.find(
      (entry) => entry.pr === pr && entry.signals.includes(signal),
    ) ?? null
  );
}

/**
 * CAN-7148: one interleaved before/after run of the scenario at the matched
 * tier, judged on the three signals with the noise-aware verdict
 * (verdicts.mjs): a signal is REGRESSED only when the rank-sum test, Holm
 * corrected across the signals, is significant and its p50 and p75 both got
 * worse by more than the floor. Inconclusive passes. A REGRESSED signal fails
 * unless an accepted regression names this PR and that signal; with gate
 * 'report' nothing fails.
 */
export function judgeMatched({ baseline, candidate, config, pr = null }) {
  const { matched } = config;
  const sides = {
    baseline: matchedSide(baseline, 'baseline', { config }),
    candidate: matchedSide(candidate, 'candidate', { config }),
  };
  const errors = MATCHED_SIDES.flatMap((side) => sides[side].errors);
  const notes = MATCHED_SIDES.flatMap((side) => sides[side].notes);
  // Both sides must come from one interleaved run, so they share a host.
  const runIds = [baseline, candidate].map(
    (result) => result?.repeat?.interleaved?.runId ?? null,
  );
  if (baseline && candidate && (!runIds[0] || runIds[0] !== runIds[1]))
    errors.push(
      'baseline and candidate are not the two sides of one interleaved run',
    );
  const report = {
    kind: 'matched',
    scenario: config.scenario,
    gate: matched.gate,
    profile: matched.profile,
    retainedWorktrees: matched.retainedWorktrees,
    pr,
    builds: {
      baseline: measuredCommit(baseline),
      candidate: measuredCommit(candidate),
    },
    samples: Object.fromEntries(
      MATCHED_SIDES.map((side) => [
        side,
        sides[side].values[SIGNAL_IDS[0]].length,
      ]),
    ),
    developBaseline: matched.baseline,
    errors,
    notes,
    verdict: null,
    signals: [],
    failures: [],
    accepted: [],
  };
  if (errors.length > 0) {
    report.passed = matched.gate === 'report';
    return report;
  }
  const judged = judgeScenarioMetrics(
    matched.signals.map((signal) => ({
      key: signal.id,
      unit: signal.unit,
      direction: 'lower',
      minRegressionAbsolute: signal.minEffectAbsolute,
      baseline: sides.baseline.values[signal.id],
      candidate: sides.candidate.values[signal.id],
    })),
    { alpha: matched.alpha, minEffectPercent: matched.minEffectPercent },
  );
  report.verdict = judged.verdict;
  report.requiredSamplesPerSide = judged.requiredSamplesPerSide;
  for (const signal of matched.signals) {
    const record = judged.metrics.find((entry) => entry.key === signal.id);
    const accepted =
      record.verdict === 'regressed'
        ? acceptanceFor(config, pr, signal.id)
        : null;
    report.signals.push({
      id: signal.id,
      label: signal.label,
      unit: signal.unit,
      verdict: record.verdict,
      reason: record.reason,
      baseline: record.baseline,
      candidate: record.candidate,
      delta: record.delta,
      floors: record.floors,
      adjustedPValue: record.test?.adjustedPValue ?? null,
      accepted,
    });
    if (record.verdict !== 'regressed') continue;
    if (accepted) report.accepted.push(signal.id);
    else report.failures.push(signal.id);
  }
  report.passed = matched.gate === 'report' || report.failures.length === 0;
  return report;
}

// A clean checkout, and a launched bundle built from it when the harness
// recorded one: a bundle built dirty or from another commit is not that commit.
const isClean = (result) =>
  (result?.source?.measuredBuild?.dirty ?? result?.source?.dirty) === false &&
  (result.source.bundleIdentity?.status ?? 'verified') === 'verified';

function refuseRegressedAA(report) {
  if (report.verdict === 'regressed')
    fail(
      `Identical builds came out REGRESSED in ${report.signals
        .filter((signal) => signal.verdict === 'regressed')
        .map((signal) => signal.id)
        .join(', ')}: review the floors before recording a baseline`,
    );
}

/**
 * The develop baseline record (`matched.baseline`). By default it comes from
 * an A/A matched run of one unchanged commit, and refuses a run whose
 * identical builds came out REGRESSED, since then the floors need review.
 * With `side`, it comes from that side of an error-free matched run, such as
 * a PR run's baseline side, which measured develop's tip; that side must be
 * clean, and `run` and `note` say where it came from.
 */
export function developBaselineRecord(
  report,
  sides,
  { note = null, side = null, run = null } = {},
) {
  if (report.errors.length > 0)
    fail(`Not a clean run: ${report.errors.join('; ')}`);
  let measured;
  if (side === null) {
    if (
      !report.builds.baseline ||
      report.builds.baseline !== report.builds.candidate ||
      !MATCHED_SIDES.every((name) => isClean(sides[name]))
    )
      fail(
        'A develop baseline compares one clean develop commit with itself (--baseline-root and --candidate-root on the same checkout), or records one side with --side',
      );
    refuseRegressedAA(report);
    measured = sides.candidate;
  } else {
    if (!MATCHED_SIDES.includes(side))
      fail(`--side must be one of ${MATCHED_SIDES.join(', ')}`);
    if (!isRunId(run))
      fail('--side needs --run, the numeric id of the run it came from');
    if (!isNamed(note))
      fail('--side needs --note, the host and why this run was used');
    if (!isCommit(report.builds[side]) || !isClean(sides[side]))
      fail(`The ${side} side did not measure one clean commit`);
    if (!isIsoDate(sides[side].completedAt?.slice(0, 10)))
      fail(`The ${side} side has no completedAt date`);
    // The other side is usually another commit, so its REGRESSED verdict
    // says nothing about this side; on one commit it is still an A/A run.
    if (report.builds.baseline === report.builds.candidate)
      refuseRegressedAA(report);
    measured = sides[side];
  }
  const other = MATCHED_SIDES.find((name) => name !== side);
  const environment = measured.environment ?? {};
  const measuredOn = measured.completedAt?.slice(0, 10);
  const record = {
    recordedOn: new Date().toISOString().slice(0, 10),
    ...(isIsoDate(measuredOn) ? { measuredOn } : {}),
    commit: report.builds[side ?? 'candidate'],
    ...(side === null ? {} : { side, pairedCommit: report.builds[other], run }),
    host: `${environment.platform}-${environment.architecture} ${environment.cpuModel ?? 'unknown CPU'}`,
    // Such as whether the host was quiet, which the artifact can't tell.
    ...(isNamed(note) ? { note: note.trim() } : {}),
    samplesPerSide: Math.min(report.samples.baseline, report.samples.candidate),
    verdict: report.verdict,
    signals: Object.fromEntries(
      report.signals.map((signal) => [
        signal.id,
        Object.fromEntries(
          MATCHED_SIDES.map((name) => [
            name,
            {
              p50: roundMetric(signal[name].p50),
              p75: roundMetric(signal[name].p75),
              max: roundMetric(signal[name].max),
            },
          ]),
        ),
      ]),
    ),
  };
  validateDevelopBaseline(record);
  return record;
}

/** A flagged count, with the commits the run covers when it knows them. */
const flagText = (flag, commitRange) =>
  `${flag.metric} is ${flag.median}, above ${flag.above}: ${flag.reason}${commitRange ? ` Commits in this run's window: ${commitRange}.` : ''}`;

const cell = (value) => (value === null || value === undefined ? '-' : value);

export function formatGateSummary(report) {
  const lines = [
    `## Retained-worktrees gate: ${report.passed ? 'pass' : 'FAIL'}`,
    '',
  ];
  const flagged = report.flags.filter((flag) => flag.outcome === 'flagged');
  for (const error of report.errors) lines.push(`- Error: ${error}`);
  for (const failure of report.failures) lines.push(`- Failed: ${failure}`);
  for (const flag of flagged)
    lines.push(`- Warning: ${flagText(flag, report.commitRange)}`);
  if (report.errors.length || report.failures.length || flagged.length)
    lines.push('');
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
  const registered = counts.rows.filter((row) => row.status !== 'unregistered');
  for (const row of registered)
    lines.push(
      `| \`${row.key.replace(`${report.scenario}.work.retained.`, '')}\` | ${row.status} | ${row.median} | ${row.min} | ${row.max} | ${cell(row.ceiling)} | ${row.varies ? 'nondeterministic' : row.outcome} |`,
    );
  const unregistered = counts.rows.length - registered.length;
  if (unregistered > 0)
    lines.push(
      '',
      `${unregistered} more counts, such as the stale signal by source, are reported, never judged; see the breakdown.`,
    );
  if (report.flags.length) {
    lines.push(
      '',
      '### Watched counts',
      '',
      '| Count | Median | Warns above | Outcome | Why |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const flag of report.flags)
      lines.push(
        `| \`${flag.metric}\` | ${cell(flag.median)} | ${flag.above} | ${flag.outcome} | ${flag.reason} |`,
      );
  }
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

const shown = (value) =>
  Number.isFinite(value) ? String(roundMetric(value)) : '-';

/** With `repositoryUrl`, as in CI's job summary, the baseline's run links. */
export function formatMatchedSummary(report, { repositoryUrl = null } = {}) {
  const outcome = report.passed
    ? report.gate === 'report' &&
      (report.failures.length > 0 || report.errors.length > 0)
      ? 'pass (report only)'
      : 'pass'
    : 'FAIL';
  const lines = [`## Retained-worktrees matched gate: ${outcome}`, ''];
  lines.push(
    `\`${report.scenario}\`, profile ${report.profile} (${report.retainedWorktrees} retained worktrees), idle window. Baseline ${report.builds.baseline?.slice(0, 11) ?? '-'}, candidate ${report.builds.candidate?.slice(0, 11) ?? '-'}; ${report.samples.baseline} and ${report.samples.candidate} interleaved sample(s). Gate: ${report.gate}. A signal fails only when REGRESSED; inconclusive passes.`,
    '',
  );
  for (const error of report.errors) lines.push(`- Error: ${error}`);
  for (const signal of report.signals) {
    if (signal.verdict !== 'regressed') continue;
    const change = `p50 ${shown(signal.baseline.p50)} -> ${shown(signal.candidate.p50)} ${signal.unit}`;
    if (signal.accepted) {
      const { approver, approvedOn, followUp } = signal.accepted;
      lines.push(
        `- Accepted: ${signal.label} REGRESSED (${change}), accepted for PR #${report.pr} by ${approver} on ${approvedOn}; follow-up ${followUp.ticket} due ${followUp.due}.`,
      );
    } else
      lines.push(
        `- ${report.gate === 'block' ? 'Failed' : 'Reported'}: ${signal.label} REGRESSED (${change}). To merge anyway, add an accepted regression${report.pr ? ` for PR #${report.pr}` : ''} with a named approver and a dated follow-up to retained-worktrees-gate.json.`,
      );
  }
  for (const note of report.notes) lines.push(`- Note: ${note}`);
  if (
    report.errors.length ||
    report.signals.some((s) => s.verdict === 'regressed') ||
    report.notes.length
  )
    lines.push('');
  if (report.signals.length > 0) {
    lines.push(
      '| Signal | Verdict | Baseline p50 | Candidate p50 | Baseline p75 | Candidate p75 | Floor (p50) | Adjusted p | Why |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const signal of report.signals)
      lines.push(
        `| ${signal.label} (${signal.unit}) | ${signal.verdict === 'inconclusive' ? 'inconclusive' : signal.verdict.toUpperCase()} | ${shown(signal.baseline.p50)} | ${shown(signal.candidate.p50)} | ${shown(signal.baseline.p75)} | ${shown(signal.candidate.p75)} | ${shown(signal.floors?.p50)} | ${Number.isFinite(signal.adjustedPValue) ? signal.adjustedPValue.toPrecision(2) : '-'} | ${signal.reason ?? '-'} |`,
      );
    lines.push('');
  }
  const develop = report.developBaseline;
  const run =
    develop?.side && repositoryUrl
      ? `[run ${develop.run}](${repositoryUrl}/actions/runs/${develop.run})`
      : `run ${develop?.run}`;
  const from = develop?.side
    ? `the ${develop.side} side of ${run} against ${develop.pairedCommit.slice(0, 11)}`
    : 'A/A';
  lines.push(
    develop
      ? `Develop baseline: ${develop.commit.slice(0, 11)} on ${develop.measuredOn ?? develop.recordedOn} (${develop.host}${develop.note ? `; ${develop.note}` : ''}), ${from}, ${develop.samplesPerSide} samples per side, ${develop.verdict}; main CPU at idle p50 ${develop.signals.mainCpuIdlePercent[develop.side ?? 'candidate'].p50}%.`
      : 'Develop baseline: not recorded yet.',
  );
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = { counts: [], cpu: [] };
  let list = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--counts' || arg === '--cpu') list = options[arg.slice(2)];
    else if (arg === '--record-baseline') {
      options.recordBaseline = true;
      list = null;
    } else if (
      [
        '--calibration',
        '--summary',
        '--output',
        '--config',
        '--commit-range',
        '--dir',
        '--pr',
        '--note',
        '--side',
        '--run',
      ].includes(arg)
    ) {
      const value = argv[++index];
      if (!value) fail(`${arg} needs a value`);
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

/** The interleaved driver's workload arguments for a matched run. */
export function matchedDriverArgs(config) {
  const { matched } = config;
  return [
    '--profile',
    matched.profile,
    '--scenarios',
    config.scenario,
    '--repeat',
    String(matched.repeat),
    '--warmup',
    String(matched.warmup),
    '--order',
    'abba',
  ];
}

/**
 * `matched`: judge the interleaved driver's `baseline.json` and
 * `candidate.json`. With `--record-baseline`, an A/A run of unchanged develop,
 * or with `--side` that side of the run, is written to the config as
 * `matched.baseline`.
 */
function mainMatched(options) {
  if (!options.dir) fail('matched needs --dir <interleaved output dir>');
  let pr = null;
  if (options.pr !== undefined) {
    pr = Number(options.pr);
    if (!Number.isInteger(pr) || pr < 1) fail('--pr needs a PR number');
  }
  const configPath = options.config ?? GATE_CONFIG_PATH;
  const config = readGateConfig(configPath);
  const sides = Object.fromEntries(
    MATCHED_SIDES.map((side) => [
      side,
      readRun(path.join(options.dir, `${side}.json`)),
    ]),
  );
  const report = judgeMatched({ ...sides, config, pr });
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository } =
    process.env;
  const summary = formatMatchedSummary(report, {
    repositoryUrl: server && repository ? `${server}/${repository}` : null,
  });
  if (options.summary) appendFileSync(options.summary, summary);
  else console.log(summary);
  if (options.output)
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  for (const flag of ['note', 'side', 'run'])
    if (options[flag] !== undefined && !options.recordBaseline)
      fail(`--${flag} describes a recorded baseline; add --record-baseline`);
  if (options.run !== undefined && options.side === undefined)
    fail('--run names the run behind --side; add --side');
  if (options.recordBaseline) {
    const raw = readJson(configPath);
    raw.matched.baseline = developBaselineRecord(report, sides, {
      note: options.note,
      side: options.side ?? null,
      run: options.run ?? null,
    });
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
    console.log(
      `[perf] recorded the develop baseline in ${configPath}; run pnpm run prettier:dirty:fix`,
    );
    return 0;
  }
  return report.passed ? 0 : 1;
}

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
  if (command === 'matched') return mainMatched(options);
  if (command === 'matched-args') {
    console.log(matchedDriverArgs(readGateConfig(options.config)).join('\n'));
    return 0;
  }
  if (command !== 'judge')
    fail('Usage: retained-worktrees-gate.mjs calibrate|judge|matched ...');
  const config = readGateConfig(options.config);
  const report = judgeGate({
    counts: options.counts.map(readRun),
    cpu: options.cpu.map(readRun),
    calibration: options.calibration ? readRun(options.calibration) : null,
    config,
    inputs: readWorkRatchetInputs(),
    commitRange: options['commit-range'] ?? null,
  });
  const summary = formatGateSummary(report);
  if (options.summary) appendFileSync(options.summary, summary);
  else console.log(summary);
  const flagged = report.flags.filter((flag) => flag.outcome === 'flagged');
  for (const flag of flagged)
    console.log(
      `::warning title=Retained-worktrees watched count::${flagText(flag, report.commitRange)}`,
    );
  // The workflow names the merge window for a flagged nightly run too.
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `flagged=${flagged.length > 0}\n`,
    );
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
