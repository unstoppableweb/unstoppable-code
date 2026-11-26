#!/usr/bin/env node
import {
  assessSmokeRun,
  formatSmokeAcceptance,
  usesLocalSmokePolicy,
} from './smoke-acceptance.mjs';
import { assertHeadlessStudyMetadata } from './browser-profiles-evidence.mjs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  comparePerformanceResults,
  compareRepeatedPerformanceResults,
  compareFrameAreas,
  formatFrameAreaComparisonLines,
  refreshRateMismatches,
} from './comparison.mjs';
import {
  MAX_REPEAT,
  SCENARIO_SCOPED_CONFIG_KEYS,
  SCENARIO_SCOPED_OPTIONS,
  SCENARIO_SCOPED_SWITCHES,
  parsePerformanceArgs,
} from './profiles.mjs';
import { aggregateSampleMetrics, isRepeatedResult } from './results.mjs';
import { roundMetric } from './statistics.mjs';
import { VERDICT_DEFAULTS } from './verdicts.mjs';
import { parseW5StoreArms } from './w5-store-arms.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../../..');
const RUN_SCRIPT = path.join(currentDir, 'run.mjs');

function usage() {
  return `Usage: pnpm run perf:desktop:compare <baseline.json> <current.json> [options]
       pnpm run perf:desktop:compare:interleaved --baseline-root <path> --candidate-root <path> --scenarios <csv> [options]

Two artifacts:
  Single-sample artifacts use the flat diagnostic rule; repeated-sample
  artifacts (--repeat) use the noise-aware three-way verdict.
  --max-regression-percent <number>  Flat rule: allowed relative regression (default 15)
  --min-regression-ms <number>       Flat rule: ignore timing deltas at or below this floor (default 20)
  --no-diagnostics                   Flat rule: do not replay regressions with profilers
  --output <path>                    Repeated artifacts: write the comparison JSON

Interleaved driver (runs both builds, one fresh launch per sample):
  --baseline-root <path>             Checkout whose build is the baseline
  --candidate-root <path>            Checkout whose build is the candidate (may equal the baseline)
  --scenarios <csv>                  Scenarios to sample (required)
  --profile <name>                   Workload profile for both sides (default baseline)
  --repeat <n>                       Samples per side (default ${DEFAULT_INTERLEAVED_REPEAT})
  --warmup <n>                       Unrecorded launches per side and scenario first (default 1)
  --release-like                     Launch each checkout's production out/ bundle instead of out-e2e/
  --order <abba|alternate>           Side order per sample (default abba)
  --baseline-format4 <unset|1>       E2E only: unset or set CANOPY_E2E_CHAT_FORMAT4 for baseline
  --candidate-format4 <unset|1>       E2E only: unset or set CANOPY_E2E_CHAT_FORMAT4 for candidate
  --w5-store-arms <baseline>,<candidate> W5 store arm of each side (in-process or daemon-record-port); both sides launch the candidate build
  --output-dir <path>                Artifact directory (default .performance/desktop/interleaved-<time>)
  Other workload options, such as --chats, are passed to both sides.

Three-way verdict (repeated artifacts and the interleaved driver):
  --alpha <number>                   Family-wise error per scenario (default ${VERDICT_DEFAULTS.alpha})
  --min-effect-percent <number>      Relative effect floor on the p50 and p75 shifts (default ${VERDICT_DEFAULTS.minEffectPercent})
  --min-effect-ms <number>           Absolute effect floor for millisecond metrics without their own (default ${VERDICT_DEFAULTS.minEffectMs})
`;
}

function readNumber(argv, index, option) {
  const inline = argv[index].startsWith(`${option}=`)
    ? argv[index].slice(option.length + 1)
    : argv[index + 1];
  const value = Number(inline);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${option} expects a non-negative number`);
  }
  return { value, nextIndex: argv[index].includes('=') ? index : index + 1 };
}

const VERDICT_OPTIONS = Object.freeze({
  '--alpha': 'alpha',
  '--min-effect-percent': 'minEffectPercent',
  '--min-effect-ms': 'minEffectMs',
});

function readVerdictOption(argv, index, option, verdictOptions) {
  const parsed = readNumber(argv, index, option);
  if (option === '--alpha' && (parsed.value <= 0 || parsed.value >= 1))
    throw new Error('--alpha expects a number between 0 and 1');
  verdictOptions[VERDICT_OPTIONS[option]] = parsed.value;
  return parsed.nextIndex;
}

function parseArgs(argv) {
  const paths = [];
  const options = {};
  const verdictOptions = {};
  let runDiagnostics = true;
  let output = '';
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const option = raw.split('=')[0];
    if (option === '--help') return { help: true };
    if (option === '--no-diagnostics') {
      runDiagnostics = false;
      continue;
    }
    if (
      option === '--max-regression-percent' ||
      option === '--min-regression-ms'
    ) {
      const parsed = readNumber(argv, index, option);
      index = parsed.nextIndex;
      if (option === '--max-regression-percent') {
        options.maxRegressionPercent = parsed.value;
      } else {
        options.minRegressionMs = parsed.value;
      }
    } else if (Object.hasOwn(VERDICT_OPTIONS, option)) {
      index = readVerdictOption(argv, index, option, verdictOptions);
    } else if (option === '--output') {
      const parsed = readText(argv, index, option);
      output = parsed.value;
      index = parsed.nextIndex;
    } else if (raw.startsWith('--')) {
      throw new Error(`Unknown option: ${raw}`);
    } else {
      paths.push(raw);
    }
  }
  if (paths.length !== 2)
    throw new Error('Expected baseline and current JSON paths');
  return { paths, options, verdictOptions, runDiagnostics, output };
}

function readText(argv, index, option) {
  if (argv[index].startsWith(`${option}=`))
    return { value: argv[index].slice(option.length + 1), nextIndex: index };
  const value = argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${option} requires a value`);
  return { value, nextIndex: index + 1 };
}

function diagnosticOutputPath(currentPath) {
  const extension = path.extname(currentPath);
  return path.join(
    path.dirname(currentPath),
    `${path.basename(currentPath, extension)}-regression-profile.json`,
  );
}

export function buildRegressionDiagnosticInvocation(
  currentPath,
  current,
  scenarioNames,
  pnpmExecPath = process.env.npm_execpath,
) {
  if (!pnpmExecPath) {
    throw new Error(
      'Automatic diagnostic replay requires npm_execpath; run the comparator through pnpm run perf:desktop:compare',
    );
  }
  const output = diagnosticOutputPath(currentPath);
  const npmArgs = [
    'run',
    'perf:desktop',
    '--profile',
    current.profile,
    '--scenarios',
    scenarioNames.join(','),
    '--diagnose',
    '--output',
    output,
    '--label',
    'automatic regression diagnostic',
  ];
  const configOptions = [
    ['--chats', current.config?.concurrentChats],
    ['--pipelines', current.config?.concurrentPipelines],
    ['--worktrees', current.config?.worktreesToCreate],
    ['--preexisting-worktrees', current.config?.preexistingWorktrees],
    ['--sample-interval-ms', current.config?.sampleIntervalMs],
    ['--code-graph-worktrees', current.config?.codeGraphBuildWorktrees],
    ['--code-graph-files', current.config?.codeGraphFixtureFilesPerWorktree],
  ];
  for (const [option, value] of configOptions) {
    if (Number.isInteger(value) && value > 0) {
      npmArgs.push(option, String(value));
    }
  }
  // A connected run's replay keeps its Remote Control workload.
  const remoteControl = current.config?.remoteControl;
  if (remoteControl?.role) {
    npmArgs.push(
      '--remote-control',
      remoteControl.role,
      '--remote-control-peers',
      String(remoteControl.peers),
    );
    if (remoteControl.role === 'controller')
      npmArgs.push(
        '--remote-control-tasks',
        String(remoteControl.tasks),
        '--remote-control-status-interval-ms',
        String(remoteControl.statusIntervalMs),
      );
  }
  if (
    current.environment?.studyWindowMode !== undefined ||
    (current.environment?.studyViewportPreset !== undefined &&
      current.environment.studyViewportPreset !== 'headed-native-1000x640')
  ) {
    assertHeadlessStudyMetadata(current.environment);
    if (scenarioNames.length !== 1 || scenarioNames[0] !== 'browser-panels')
      throw new Error('Hidden study requires browser-panels-only replay');
    npmArgs.push('--headless', '--study-window-mode', 'headless');
  }
  if (current.environment?.windowVisible) npmArgs.push('--headed');
  if (current.environment?.studyViewportPreset === 'headed-native-1000x640') {
    if (
      !current.environment.windowVisible ||
      scenarioNames.length !== 1 ||
      scenarioNames[0] !== 'browser-panels'
    )
      throw new Error(
        'Recorded study viewport requires headed browser-panels-only replay',
      );
    npmArgs.push('--browser-panels-viewport', '1000x640');
  }

  // pnpm 12 is a native executable; earlier releases are a JavaScript entry.
  return /\.[cm]?js$/i.test(pnpmExecPath)
    ? { command: process.execPath, args: [pnpmExecPath, ...npmArgs], output }
    : { command: pnpmExecPath, args: npmArgs, output };
}

function runRegressionDiagnostics(currentPath, current, scenarioNames) {
  const invocation = buildRegressionDiagnosticInvocation(
    currentPath,
    current,
    scenarioNames,
  );

  console.log(
    `Replaying ${scenarioNames.join(',')} with deterministic CPU/trace capture...`,
  );
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(`Could not start diagnostic replay: ${result.error.message}`);
  } else if (result.signal) {
    console.error(`Diagnostic replay terminated by ${result.signal}`);
  } else {
    console.log(`Diagnostic replay result: ${invocation.output}`);
  }
}

export function canOfferRegressionDiagnostics(result) {
  return result.compatible && result.regressedScenarios.length > 0;
}

/** Work counters are reported beside, never inside, the timing verdict. */
export function formatWorkComparisonLines(result, { limit = Infinity } = {}) {
  const comparisons = result.workComparisons ?? [];
  const unavailable = result.workUnavailable ?? [];
  if (comparisons.length === 0 && unavailable.length === 0) return [];
  const changed = comparisons
    .filter((entry) => entry.delta !== 0)
    .sort(
      (left, right) =>
        Math.abs(right.percent ?? Infinity) -
          Math.abs(left.percent ?? Infinity) ||
        left.key.localeCompare(right.key),
    );
  const lines = [
    `Work counters (reported only, not part of PASS/FAIL): ${comparisons.length} compared, ${changed.length} changed`,
  ];
  for (const entry of changed.slice(0, limit)) {
    const percent =
      entry.percent === null ? 'from zero' : `${entry.percent.toFixed(1)}%`;
    lines.push(
      `${entry.delta > 0 ? 'MORE ' : 'LESS '}${entry.key} | ${entry.baseline} ${entry.unit} | ${entry.current} ${entry.unit} | ${entry.delta > 0 ? '+' : ''}${entry.delta} (${percent})`,
    );
  }
  if (changed.length > limit) {
    lines.push(
      `... ${changed.length - limit} more changed counter(s) in the comparison JSON`,
    );
  }
  if (unavailable.length > 0) {
    lines.push(
      `Work counters not collected by both runs: ${unavailable.join(', ')}`,
    );
  }
  return lines;
}

const DEFAULT_INTERLEAVED_REPEAT = 7;
const INTERLEAVED_ORDERS = Object.freeze(['abba', 'alternate']);
const SIDES = Object.freeze(['baseline', 'candidate']);
const CHAT_FORMAT4_ENV = 'CANOPY_E2E_CHAT_FORMAT4';
const INTERLEAVED_FORMAT4_OPTIONS = Object.freeze({
  '--baseline-format4': 'baseline',
  '--candidate-format4': 'candidate',
});

/** Runner options that take no value. */
const RUNNER_FLAGS = new Set([
  '--keep-data',
  '--headless',
  '--headed',
  '--diagnose',
  '--no-diagnostics',
  '--live-startup-background',
  '--startup-trace',
  '--git-attribution',
  '--release-like',
  '--cold-background-streams',
  '--help',
]);

/**
 * Runner options the driver owns, or that make timings non-comparable or
 * non-deterministic, or show a window.
 */
const DRIVER_REFUSED_RUNNER_OPTIONS = new Set([
  '--output',
  '--label',
  '--release-like-root',
  '--e2e-root',
  '--headed',
  '--diagnose',
  '--no-diagnostics',
  '--keep-data',
  '--help',
  '--git-attribution',
  '--startup-trace',
  '--live-startup-background',
  '--study-window-mode',
  '--browser-panels-viewport',
]);

function integerOption(option, value, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum)
    throw new Error(`${option} expects an integer of at least ${minimum}`);
  return parsed;
}

/** Driver options that take a value, and where each one goes in the plan. */
const INTERLEAVED_VALUE_OPTIONS = Object.freeze({
  '--baseline-root': (plan, value) => {
    plan.baselineRoot = value;
  },
  '--candidate-root': (plan, value) => {
    plan.candidateRoot = value;
  },
  '--profile': (plan, value) => {
    plan.profile = value;
  },
  '--output-dir': (plan, value) => {
    plan.outputDir = value;
  },
  '--scenarios': (plan, value) => {
    plan.scenarios = value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  },
  '--repeat': (plan, value) => {
    plan.repeat = integerOption('--repeat', value, 2);
  },
  '--warmup': (plan, value) => {
    plan.warmup = integerOption('--warmup', value, 0);
  },
  '--order': (plan, value) => {
    if (!INTERLEAVED_ORDERS.includes(value))
      throw new Error(`--order expects ${INTERLEAVED_ORDERS.join(' or ')}`);
    plan.order = value;
  },
  '--w5-store-arms': (plan, value) => {
    plan.w5StoreArms = parseW5StoreArms(value);
  },
});

/** Passes one runner option, and its value if it takes one, to both sides. */
function forwardRunnerOption(argv, index, plan) {
  const raw = argv[index];
  const option = raw.split('=')[0];
  if (DRIVER_REFUSED_RUNNER_OPTIONS.has(option))
    throw new Error(
      `${option} cannot be used with the interleaved driver; it owns the output, build selection and diagnostics of each run`,
    );
  const args = [raw];
  let nextIndex = index;
  if (!RUNNER_FLAGS.has(option) && !raw.includes('=')) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${option} requires a value`);
    args.push(value);
    nextIndex = index + 1;
  }
  plan.runnerArgs.push(...args);
  plan.runnerOptions.push({ option, args });
  return nextIndex;
}

/** The scenarios that own a runner option, or null when every scenario does. */
function runnerOptionOwners(option) {
  const key = SCENARIO_SCOPED_OPTIONS[option];
  return (
    SCENARIO_SCOPED_SWITCHES[option] ??
    (key ? SCENARIO_SCOPED_CONFIG_KEYS[key] : null)
  );
}

/**
 * Validates the plan before anything launches, exactly as the runner will: the
 * driver's own repeat and warm-up counts, and the argument list of every
 * scenario. A scenario-scoped option must be owned by a requested scenario.
 */
function validatePlan(plan) {
  if (plan.warmup > MAX_REPEAT)
    throw new Error(`--warmup cannot exceed ${MAX_REPEAT}`);
  if (plan.w5StoreArms) {
    if (plan.releaseLike)
      throw new Error(
        '--w5-store-arms compares E2E-only W5 store arms and cannot be used with --release-like',
      );
    if (plan.runnerOptions.some(({ option }) => option === '--w5-store'))
      throw new Error(
        '--w5-store-arms sets the --w5-store of each side; do not pass --w5-store as well',
      );
  }
  for (const { option } of plan.runnerOptions) {
    const owners = runnerOptionOwners(option);
    if (owners && !owners.some((scenario) => plan.scenarios.includes(scenario)))
      throw new Error(
        `The ${option} option requires the ${owners.join(' or ')} scenario`,
      );
  }
  // Children run `--repeat 1`; the driver's count is checked as the runner
  // would check it, so a refusal comes before the first launch. Each side's
  // store arm is checked too; arms never enter the workload configuration.
  const validate = (scenarios, side) =>
    parsePerformanceArgs([
      ...runnerArgsFor(plan, scenarios, side),
      '--repeat',
      String(plan.repeat),
    ]).config;
  plan.scenarioConfigs = Object.fromEntries(
    plan.scenarios.map((scenario) => [scenario, validate([scenario])]),
  );
  plan.config = validate(plan.scenarios);
  if (plan.w5StoreArms)
    for (const side of SIDES) validate(plan.scenarios, side);
}

export function parseInterleavedArgs(argv) {
  const plan = {
    baselineRoot: '',
    candidateRoot: '',
    profile: 'baseline',
    scenarios: [],
    repeat: DEFAULT_INTERLEAVED_REPEAT,
    warmup: 1,
    releaseLike: false,
    order: 'abba',
    outputDir: '',
    // `{ baseline, candidate }` W5 store arms of one build (CAN-5532).
    w5StoreArms: null,
    verdictOptions: {},
    format4Options: {},
    runnerArgs: [],
    runnerOptions: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const option = raw.split('=')[0];
    if (option === '--help') return { help: true };
    if (option === '--interleaved') continue;
    if (option === '--release-like') {
      plan.releaseLike = true;
    } else if (Object.hasOwn(VERDICT_OPTIONS, option)) {
      index = readVerdictOption(argv, index, option, plan.verdictOptions);
    } else if (Object.hasOwn(INTERLEAVED_VALUE_OPTIONS, option)) {
      const parsed = readText(argv, index, option);
      index = parsed.nextIndex;
      INTERLEAVED_VALUE_OPTIONS[option](plan, parsed.value);
    } else if (Object.hasOwn(INTERLEAVED_FORMAT4_OPTIONS, option)) {
      const parsed = readText(argv, index, option);
      index = parsed.nextIndex;
      if (parsed.value !== 'unset' && parsed.value !== '1')
        throw new Error(`${option} expects unset or 1`);
      plan.format4Options[INTERLEAVED_FORMAT4_OPTIONS[option]] = parsed.value;
    } else if (raw.startsWith('--')) {
      index = forwardRunnerOption(argv, index, plan);
    } else {
      throw new Error(`Unexpected argument: ${raw}`);
    }
  }
  if (!plan.baselineRoot || !plan.candidateRoot)
    throw new Error(
      'The interleaved driver needs --baseline-root and --candidate-root',
    );
  if (plan.scenarios.length === 0)
    throw new Error(
      'The interleaved driver needs an explicit --scenarios list',
    );
  if (plan.releaseLike && Object.keys(plan.format4Options).length > 0)
    throw new Error('The format 4 options cannot be used with --release-like');
  validatePlan(plan);
  return plan;
}

/** Apply only this E2E chat-format switch and keep its safe provenance value. */
export function interleavedSideEnvironment(
  plan,
  side,
  inheritedEnvironment = process.env,
) {
  const env = { ...inheritedEnvironment };
  if (Object.hasOwn(plan.format4Options, side)) {
    const value = plan.format4Options[side];
    if (value === 'unset') delete env[CHAT_FORMAT4_ENV];
    else env[CHAT_FORMAT4_ENV] = value;
  }
  return {
    env,
    provenance: { [CHAT_FORMAT4_ENV]: env[CHAT_FORMAT4_ENV] ?? null },
  };
}

/**
 * The runner options shared by both sides for the given scenarios. A
 * scenario-scoped option goes only to the scenarios that own it. With W5
 * store arms, `side` adds that side's `--w5-store`.
 */
export function runnerArgsFor(plan, scenarios, side) {
  const arm = side && plan.w5StoreArms ? plan.w5StoreArms[side] : null;
  return [
    '--profile',
    plan.profile,
    '--scenarios',
    scenarios.join(','),
    '--no-diagnostics',
    ...(plan.releaseLike ? ['--release-like'] : []),
    ...plan.runnerOptions
      .filter(({ option }) => {
        const owners = runnerOptionOwners(option);
        return (
          !owners || owners.some((scenario) => scenarios.includes(scenario))
        );
      })
      .flatMap(({ args }) => args),
    ...(arm ? ['--w5-store', arm] : []),
  ];
}

/**
 * The checkout each side launches. W5 store arms compare one artifact, so
 * both sides launch the candidate's build and the baseline root is unused.
 */
export function sideBuildRoots(plan, roots) {
  return plan.w5StoreArms
    ? { baseline: roots.candidate, candidate: roots.candidate }
    : roots;
}

/**
 * The side order of each sample. `abba` alternates which side goes first
 * (AB, BA, AB, …) so a steady drift in host load favors neither side;
 * `alternate` always runs the baseline first.
 */
export function interleavedSchedule(repeat, order = 'abba') {
  return Array.from({ length: repeat }, (_, sample) => ({
    sample,
    sides:
      order === 'abba' && sample % 2 === 1
        ? ['candidate', 'baseline']
        : ['baseline', 'candidate'],
  }));
}

/** The bundle a side launches: `out/` release-like, else the E2E output. */
export function measuredBundleEntry(root, releaseLike, env = process.env) {
  return path.join(
    root,
    releaseLike ? 'out' : (env.CANOPY_E2E_OUT_DIR ?? 'out-e2e'),
    'main',
    'index.js',
  );
}

const MATCHED_FIELDS = Object.freeze([
  'acceptancePolicy',
  'schemaVersion',
  'suite',
  'benchmarkKind',
  'profile',
]);
const MATCHED_ENVIRONMENT_FIELDS = Object.freeze([
  'hostname',
  'electronVersion',
  'playwrightVersion',
  'nodeVersion',
  'platform',
  'osRelease',
  'architecture',
  'cpuModel',
  'logicalCpuCount',
  'totalMemoryMb',
  'viewport',
  'windowVisible',
]);

/** Throws when a sample artifact differs from the first in kind, build or workload. */
function assertSameSampleSetup(first, artifact, config, scenarioConfig) {
  if (
    usesLocalSmokePolicy(artifact) &&
    (!Number.isFinite(Date.parse(artifact.startedAt)) ||
      !Number.isFinite(Date.parse(artifact.completedAt)) ||
      Date.parse(artifact.completedAt) < Date.parse(artifact.startedAt))
  )
    throw new Error('Cannot combine incomplete local smoke evidence');
  for (const field of MATCHED_FIELDS)
    if (artifact[field] !== first[field])
      throw new Error(`Sample artifacts mix ${field} values`);
  for (const field of MATCHED_ENVIRONMENT_FIELDS)
    if (
      JSON.stringify(artifact.environment?.[field]) !==
      JSON.stringify(first.environment?.[field])
    )
      throw new Error(`Sample artifacts mix environment.${field} values`);
  if (
    JSON.stringify(artifact.source?.measuredBuild) !==
    JSON.stringify(first.source?.measuredBuild)
  )
    throw new Error('Sample artifacts mix measured builds');
  if (JSON.stringify(artifact.treatment) !== JSON.stringify(first.treatment))
    throw new Error('Sample artifacts mix treatments');
  const expected = scenarioConfig ?? config;
  const actual = artifact.config ?? {};
  // A scenario's own configuration must match exactly, scoped keys included;
  // without one, an artifact may carry any subset of the plan's keys.
  const keys = scenarioConfig
    ? new Set([...Object.keys(actual), ...Object.keys(expected)])
    : Object.keys(actual);
  for (const key of keys)
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key]))
      throw new Error(`Sample artifacts mix configuration: ${key}`);
}

/**
 * Throws when a scenario's configuration differs between the two sides.
 * Configurations legitimately differ from scenario to scenario by their
 * scoped keys, so each scenario is compared with itself.
 */
export function assertMatchedScenarioConfigs(baselineRuns, candidateRuns) {
  const first = (runs, scenario) =>
    runs.find((run) => run.scenario === scenario)?.artifact.config ?? {};
  const scenarios = new Set(
    [...baselineRuns, ...candidateRuns].map((run) => run.scenario),
  );
  for (const scenario of scenarios) {
    const baseline = first(baselineRuns, scenario);
    const candidate = first(candidateRuns, scenario);
    for (const key of new Set([
      ...Object.keys(baseline),
      ...Object.keys(candidate),
    ]))
      if (JSON.stringify(baseline[key]) !== JSON.stringify(candidate[key]))
        throw new Error(
          `Baseline and candidate mix configuration for ${scenario}: ${key}`,
        );
  }
}

/**
 * Folds one side's single-sample artifacts (one per sample and scenario) into
 * a repeated-sample artifact with the shape `run.mjs --repeat` writes. Refuses
 * artifacts that mix benchmark kinds, profiles, environments, measured builds
 * or configurations.
 */
export function combineSampleArtifacts(
  runs,
  { count, config, scenarioConfigs, scenarios, label, interleaved },
) {
  if (runs.length === 0) throw new Error('No sample artifacts to combine');
  const first = runs[0].artifact;
  for (const { artifact, scenario } of runs)
    assertSameSampleSetup(first, artifact, config, scenarioConfigs?.[scenario]);
  const ordered = [...runs].sort(
    (left, right) =>
      left.sample - right.sample ||
      scenarios.indexOf(left.scenario) - scenarios.indexOf(right.scenario),
  );
  const combined = {
    schemaVersion: first.schemaVersion,
    suite: first.suite,
    benchmarkKind: first.benchmarkKind,
    profile: first.profile,
    ...(first.acceptancePolicy
      ? { acceptancePolicy: first.acceptancePolicy }
      : {}),
    label,
    startedAt: ordered[0].artifact.startedAt,
    completedAt: ordered[ordered.length - 1].artifact.completedAt,
    config,
    ...(first.treatment ? { treatment: first.treatment } : {}),
    requestedScenarios: scenarios,
    source: first.source,
    environment: first.environment,
    diagnosticInstrumentation: first.diagnosticInstrumentation,
    caveats: [
      ...(first.caveats ?? []),
      'Samples were collected by the interleaved compare driver, alternating this build with the other side, one fresh launch per sample.',
    ],
    repeat: { count, interleaved, samples: [] },
    scenarios: [],
  };
  const sampleMetrics = [];
  for (const run of ordered) {
    for (const scenario of run.artifact.scenarios ?? [])
      combined.scenarios.push({ ...scenario, sample: run.sample });
    sampleMetrics[run.sample] = Object.assign(
      sampleMetrics[run.sample] ?? {},
      run.artifact.metrics,
    );
    if (!combined.repeat.samples[run.sample])
      combined.repeat.samples[run.sample] = {
        index: run.sample,
        startedAt: run.artifact.startedAt,
        loadAverage: run.loadAverage,
      };
    combined.repeat.samples[run.sample].completedAt = run.artifact.completedAt;
  }
  combined.metrics = aggregateSampleMetrics(combined, sampleMetrics);
  return combined;
}

function sampleFileName(side, sample, scenario) {
  return `${side}-s${String(sample + 1).padStart(2, '0')}-${scenario}.json`;
}

function defaultInterleavedOutputDir() {
  return path.join(
    repoRoot,
    '.performance',
    'desktop',
    `interleaved-${new Date().toISOString().replaceAll(':', '-')}`,
  );
}

function assertBuiltCheckouts(plan, roots) {
  const launched = sideBuildRoots(plan, roots);
  for (const side of SIDES) {
    const entry = measuredBundleEntry(launched[side], plan.releaseLike);
    if (!existsSync(entry))
      throw new Error(
        `The ${side} checkout has no ${path.relative(launched[side], entry)}. Run \`${plan.releaseLike ? 'npm run build' : 'npm run build:e2e -- --performance-sourcemaps'}\` there first.`,
      );
  }
}

/**
 * Runs one sample launch and reads back the artifact it wrote to `output`.
 * The path is cleared first: sample names repeat between runs, so a reused
 * output directory would otherwise let an earlier run's file stand in for a
 * launch that wrote nothing. A launch that exits without writing one stops
 * the comparison; one that wrote an artifact is read whatever its exit code,
 * so a failed sample still reaches the clean-sample check.
 */
export function readLaunchArtifact(output, launch, description) {
  rmSync(output, { force: true });
  const child = launch();
  if (child.error)
    throw new Error(`Could not start a sample run: ${child.error.message}`);
  if (child.signal)
    throw new Error(`${description} was stopped by ${child.signal}`);
  if (!existsSync(output))
    throw new Error(
      `${description} wrote no result (exit ${child.status}); stopping.`,
    );
  const artifact = JSON.parse(readFileSync(output, 'utf8'));
  if (
    usesLocalSmokePolicy(artifact) &&
    child.status !== 0 &&
    assessSmokeRun(artifact).localCheckPassed
  )
    throw new Error(
      `${description} reported a completed local smoke but exited with exit ${child.status}; retain the artifact and inspect cleanup.`,
    );
  return artifact;
}

/** One runner process: one launch of one scenario on one side. */
function runSideOnce(plan, roots, { side, scenario, output, label }) {
  const sideEnvironment = interleavedSideEnvironment(plan, side);
  const loadAverage = os.loadavg().map((value) => roundMetric(value, 2));
  console.log(
    `[interleave] ${label} ${scenario} ${side} (load average ${loadAverage.join(' ')})`,
  );
  const artifact = readLaunchArtifact(
    output,
    () =>
      spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          RUN_SCRIPT,
          ...runnerArgsFor(plan, [scenario], side),
          plan.releaseLike ? '--release-like-root' : '--e2e-root',
          sideBuildRoots(plan, roots)[side],
          '--output',
          output,
          '--label',
          `interleaved ${side} ${label}`,
        ],
        {
          cwd: repoRoot,
          env: sideEnvironment.env,
          stdio: 'inherit',
          shell: false,
        },
      ),
    `The ${side} ${label} run of ${scenario}`,
  );
  return { loadAverage, artifact };
}

/**
 * Unrecorded warm-up launches, then the recorded samples in schedule order.
 * The warm-ups absorb one-time costs (cold file caches after a build), which
 * would otherwise land on whichever side runs first.
 */
function collectInterleavedSamples(plan, roots, samplesDir) {
  for (let warmup = 0; warmup < plan.warmup; warmup += 1)
    for (const scenario of plan.scenarios)
      for (const side of SIDES)
        runSideOnce(plan, roots, {
          side,
          scenario,
          output: path.join(
            samplesDir,
            `warmup-${warmup + 1}-${side}-${scenario}.json`,
          ),
          label: `warm-up ${warmup + 1}/${plan.warmup}`,
        });
  const runs = { baseline: [], candidate: [] };
  for (const { sample, sides } of interleavedSchedule(plan.repeat, plan.order))
    for (const scenario of plan.scenarios)
      for (const side of sides)
        runs[side].push({
          side,
          sample,
          scenario,
          ...runSideOnce(plan, roots, {
            side,
            scenario,
            output: path.join(
              samplesDir,
              sampleFileName(side, sample, scenario),
            ),
            label: `sample ${sample + 1}/${plan.repeat}`,
          }),
        });
  return runs;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runInterleavedComparison(plan) {
  const roots = {
    baseline: path.resolve(plan.baselineRoot),
    candidate: path.resolve(plan.candidateRoot),
  };
  assertBuiltCheckouts(plan, roots);
  const outputDir = path.resolve(
    repoRoot,
    plan.outputDir || defaultInterleavedOutputDir(),
  );
  const samplesDir = path.join(outputDir, 'samples');
  mkdirSync(samplesDir, { recursive: true });
  console.log(
    `[interleave] ${plan.releaseLike ? 'release-like' : 'E2E'} ${plan.profile}: ${plan.scenarios.join(',')} x ${plan.repeat} sample(s) per side after ${plan.warmup} warm-up, ${plan.order} order`,
  );
  if (plan.w5StoreArms) {
    for (const side of SIDES)
      console.log(
        `[interleave] ${side}: ${roots.candidate} with W5 store arm ${plan.w5StoreArms[side]}`,
      );
    if (roots.baseline !== roots.candidate)
      console.log(
        `[interleave] W5 store arms launch one build; the baseline root ${roots.baseline} is not launched.`,
      );
    if (plan.w5StoreArms.baseline === plan.w5StoreArms.candidate)
      console.log(
        '[interleave] Both sides name one W5 store arm: this is a calibration run and should report no regression.',
      );
  } else {
    for (const side of SIDES)
      console.log(`[interleave] ${side}: ${roots[side]}`);
  }
  if (!plan.w5StoreArms && roots.baseline === roots.candidate)
    console.log(
      '[interleave] Both sides name one build: this is a calibration run and should report no regression.',
    );
  const runs = collectInterleavedSamples(plan, roots, samplesDir);
  assertMatchedScenarioConfigs(runs.baseline, runs.candidate);
  const combined = {};
  const runId = randomUUID();
  for (const side of SIDES) {
    combined[side] = combineSampleArtifacts(runs[side], {
      count: plan.repeat,
      config: plan.config,
      scenarioConfigs: plan.scenarioConfigs,
      scenarios: plan.scenarios,
      label: `interleaved ${side}`,
      interleaved: {
        side,
        order: plan.order,
        runId,
        warmup: plan.warmup,
        environment: interleavedSideEnvironment(plan, side).provenance,
      },
    });
    writeJson(path.join(outputDir, `${side}.json`), combined[side]);
  }
  const comparison = compareRepeatedPerformanceResults(
    combined.baseline,
    combined.candidate,
    plan.verdictOptions,
  );
  writeJson(path.join(outputDir, 'comparison.json'), comparison);
  for (const line of formatRepeatedComparisonLines(comparison, {
    profile: plan.profile,
  }))
    console.log(line);
  const frameAreas = compareFrameAreas(combined.baseline, combined.candidate);
  writeJson(path.join(outputDir, 'frame-areas.json'), frameAreas);
  for (const line of formatFrameAreaComparisonLines(frameAreas))
    console.log(line);
  console.log(`[interleave] Artifacts: ${outputDir}`);
  return comparison;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function formatMetricLine(record) {
  const verdict =
    record.verdict === 'inconclusive'
      ? 'within noise'
      : record.verdict.toUpperCase();
  const shift = record.shift;
  const interval =
    shift?.lower === null || shift?.lower === undefined
      ? 'no interval'
      : `[${formatNumber(shift.lower)}, ${formatNumber(shift.upper)}]`;
  return `  ${verdict} ${record.key} | p50 ${formatNumber(record.baseline.p50)} -> ${formatNumber(record.candidate.p50)} ${record.unit} (${formatPercent(record.delta?.p50Percent)}) | p75 ${formatNumber(record.baseline.p75)} -> ${formatNumber(record.candidate.p75)} (${formatPercent(record.delta?.p75Percent)}) | shift ${formatNumber(shift?.estimate)} ${interval} | adjusted p ${Number.isFinite(record.test?.adjustedPValue) ? record.test.adjustedPValue.toPrecision(2) : 'n/a'} | diagnostic p95 ${formatNumber(record.baseline.p95)} -> ${formatNumber(record.candidate.p95)}, max ${formatNumber(record.baseline.max)} -> ${formatNumber(record.candidate.max)}`;
}

/**
 * Names the samples that failed or were unresponsive: they fail the comparison
 * whatever its verdict under the strict policy. Local smoke retains the same
 * observations but applies its separate acceptance policy. Sample numbers are
 * 1-based, as in the driver's log.
 */
function formatNonOkSampleLines(result) {
  const named = SIDES.flatMap((side) =>
    (result.nonOkSamples?.[side] ?? []).map(
      (entry) =>
        `  ${side} ${entry.scenario} sample ${entry.sample + 1}: ${entry.status}`,
    ),
  );
  return named.length === 0
    ? []
    : [
        `${result.acceptance ? 'OBSERVED' : 'FAILED'}: ${named.length} sample(s) did not run cleanly`,
        ...named,
      ];
}

/** Console report of a repeated-sample comparison. */
export function formatRepeatedComparisonLines(result, { profile } = {}) {
  if (!result.compatible)
    return [`Incompatible runs: ${result.incompatibilities.join(', ')}`];
  const method = result.method;
  const lines = [
    `Noise-aware comparison: Mann-Whitney U with a Holm correction across each scenario's timing metrics (alpha ${method.alpha}). A verdict needs the p50 and p75 shifts past max(${method.minEffectPercent}%, ${method.minEffectMs} ms or the metric's own floor); p95 and max are diagnostic only. Shift intervals are ${Math.round(method.intervalLevel * 100)}% Hodges-Lehmann intervals.`,
    `Samples per side: baseline ${result.samples.baseline}, candidate ${result.samples.candidate}${formatLoad(result.hostLoad)}`,
  ];
  if (result.acceptance?.measurement === 'inconclusive')
    lines.push(
      'Timing statistics below are diagnostic only: measurement validity was not established.',
    );
  const headline = result.headline;
  lines.push(
    headline.ratio === null
      ? 'Headline: no journey timing on both sides'
      : `Headline: candidate/baseline p50 of journey timings, geometric mean ${headline.ratio.toFixed(3)}x (${formatPercent(headline.percent)}) across ${headline.scenarios.length} scenario(s): ${headline.scenarios.map((entry) => `${entry.name} ${entry.ratio.toFixed(3)}x`).join(', ')}`,
  );
  for (const scenario of result.scenarios) {
    lines.push(
      `${scenario.verdict.toUpperCase()} ${scenario.name}: ${scenario.tests} timing metric(s) tested with at least ${scenario.samplesPerSide} sample(s) per side; ${scenario.counts.improved} improved, ${scenario.counts.regressed} regressed`,
    );
    for (const record of scenario.metrics.filter(
      (entry) => entry.verdict !== 'inconclusive',
    ))
      lines.push(formatMetricLine(record));
    const movers = scenario.metrics
      .filter((entry) => entry.suggestive)
      .sort(
        (left, right) =>
          Math.abs(right.delta.p50Percent ?? 0) -
          Math.abs(left.delta.p50Percent ?? 0),
      )
      .slice(0, 3);
    for (const record of movers) lines.push(formatMetricLine(record));
    for (const guidance of scenario.guidance ?? [])
      lines.push(`  Rerun: ${guidance}`);
    if (scenario.verdict === 'regressed' && profile)
      lines.push(
        `  Profile it: npm run perf:desktop -- --profile ${profile} --scenarios ${scenario.name} --diagnose`,
      );
  }
  lines.push(...formatWorkComparisonLines(result, { limit: 10 }));
  lines.push(...formatNonOkSampleLines(result));
  lines.push(
    `${result.verdict.toUpperCase()}: ${result.regressedScenarios.length} regressed, ${result.improvedScenarios.length} improved, ${result.inconclusiveScenarios.length} inconclusive scenario(s)`,
  );
  if (result.acceptance)
    lines.push(...formatSmokeAcceptance(result.acceptance));
  return lines;
}

function formatLoad(hostLoad) {
  const ranges = SIDES.map((side) => [side, hostLoad?.[side]]).filter(
    ([, range]) => range,
  );
  if (ranges.length === 0) return '';
  return `; 1-minute load average ${ranges.map(([side, range]) => `${side} ${range.min}-${range.max}`).join(', ')}`;
}

function runArtifactComparison(parsed) {
  const [baselinePath, currentPath] = parsed.paths;
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const current = JSON.parse(readFileSync(currentPath, 'utf8'));
  if (
    isRepeatedResult(baseline) ||
    isRepeatedResult(current) ||
    usesLocalSmokePolicy(baseline) ||
    usesLocalSmokePolicy(current)
  ) {
    // Repeated samples get the noise-aware verdict; the flat rule below stays
    // the single-sample diagnostic path.
    const result = compareRepeatedPerformanceResults(
      baseline,
      current,
      parsed.verdictOptions,
    );
    for (const line of formatRepeatedComparisonLines(result, {
      profile: current.profile,
    }))
      console.log(line);
    for (const line of formatFrameAreaComparisonLines(
      compareFrameAreas(baseline, current),
    ))
      console.log(line);
    if (parsed.output) {
      const output = path.resolve(parsed.output);
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      console.log(`Comparison: ${output}`);
    }
    if (!result.passed)
      process.exitCode = result.acceptance?.verdict === 'inconclusive' ? 2 : 1;
    return;
  }
  const result = comparePerformanceResults(baseline, current, parsed.options);
  if (!result.compatible) {
    console.error(`Incompatible runs: ${result.incompatibilities.join(', ')}`);
    for (const { scenario, reason } of refreshRateMismatches(baseline, current))
      console.error(`  ${scenario}: refresh rate ${reason}`);
  }
  const sorted = [...result.comparisons].sort(
    (left, right) => (right.percent ?? Infinity) - (left.percent ?? Infinity),
  );
  console.log('Metric | Baseline | Current | Delta');
  for (const entry of sorted) {
    const percent =
      entry.percent === null ? 'n/a' : `${entry.percent.toFixed(1)}%`;
    console.log(
      `${entry.regression ? 'REGRESSION ' : ''}${entry.key} | ${entry.baseline} ${entry.unit} | ${entry.current} ${entry.unit} | ${entry.delta.toFixed(2)} (${percent})`,
    );
  }
  for (const line of formatWorkComparisonLines(result)) console.log(line);
  console.log(
    `${result.passed ? 'PASS' : 'FAIL'}: ${result.regressions.length} regression(s), ${result.comparisons.length} comparable metric(s)`,
  );
  if (canOfferRegressionDiagnostics(result) && parsed.runDiagnostics) {
    runRegressionDiagnostics(currentPath, current, result.regressedScenarios);
  } else if (canOfferRegressionDiagnostics(result)) {
    console.log(
      `Profile the regressed workload: npm run perf:desktop -- --profile ${current.profile} --scenarios ${result.regressedScenarios.join(',')} --diagnose`,
    );
  }
  if (!result.passed)
    process.exitCode = result.acceptance?.verdict === 'inconclusive' ? 2 : 1;
}

function main() {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--interleaved')) {
      const plan = parseInterleavedArgs(argv);
      if (plan.help) {
        console.log(usage());
        return;
      }
      const result = runInterleavedComparison(plan);
      if (!result.passed)
        process.exitCode =
          result.acceptance?.verdict === 'inconclusive' ? 2 : 1;
      return;
    }
    const parsed = parseArgs(argv);
    if (parsed.help) {
      console.log(usage());
    } else {
      runArtifactComparison(parsed);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
