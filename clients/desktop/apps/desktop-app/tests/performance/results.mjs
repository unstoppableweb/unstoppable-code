import { assessSmokeRun, usesLocalSmokePolicy } from './smoke-acceptance.mjs';
import {
  SCALING_WORK_SOURCE,
  applyScalingRatios,
  scalingRatioMetrics,
} from './scaling-ratios.mjs';
import {
  percentile,
  roundMetric,
  roundSummary,
  summarize,
} from './statistics.mjs';

/**
 * Work-counter sources recorded under `<scenario>.work.<source>.*`: the E2E
 * transcript accumulator, Chromium's `Performance.getMetrics` counters, the
 * app's main-process IPC, chat-storage, and provider-ingestion counters, the
 * E2E React commit hook, the OS per-process disk counters of the app's
 * process tree (measured window only; reported, never judged until admitted),
 * the code-graph build counts a code-graph scenario read from its builds'
 * metadata and diagnostics (window only), and the P0 section C scaling ratios
 * (`scaling-ratios.mjs`, window only).
 */
export const WORK_METRIC_SOURCES = Object.freeze([
  'transcript',
  'chromium',
  'ipc',
  'chatStorage',
  'provider',
  'react',
  'disk',
  'codeGraph',
  // CAN-6969: retained-worktrees-idle's per-event counts.
  'retained',
  SCALING_WORK_SOURCE,
]);

const APP_WORK_SOURCE_LABELS = Object.freeze({
  ipc: 'IPC',
  chatStorage: 'Chat storage',
  provider: 'Provider',
  react: 'React',
  disk: 'Disk I/O',
  codeGraph: 'Code graph',
  retained: 'Retained worktrees',
});

const COUNT_METRIC_UNITS = new Set(['count', 'bytes', 'ratio']);

/**
 * `time` metrics are sampled measurements (durations and the timer-sampled
 * resource and long-task observations) judged by the relative timing rule.
 * `count` metrics are work counters, reported separately and ratcheted.
 */
function metric(
  value,
  unit,
  description,
  minRegressionAbsolute,
  kind = 'time',
) {
  if (!Number.isFinite(value)) return null;
  if (kind === 'count' && !COUNT_METRIC_UNITS.has(unit)) {
    throw new Error(`Count metrics use the count or bytes unit, not ${unit}`);
  }
  return {
    value: roundMetric(value),
    unit,
    kind,
    direction: 'lower',
    description,
    ...(Number.isFinite(minRegressionAbsolute)
      ? { minRegressionAbsolute }
      : {}),
  };
}

/**
 * Splits `<scenario>.work.<source>.<counter>` and
 * `<scenario>.work.task.<kind>.<source>.<counter>`; other keys return null.
 */
export function parseWorkMetricKey(key) {
  const [scenario, namespace, ...rest] = String(key).split('.');
  if (!scenario || namespace !== 'work') return null;
  const taskKind = rest[0] === 'task' ? (rest[1] ?? null) : null;
  const [source, ...counter] = taskKind ? rest.slice(2) : rest;
  if (!WORK_METRIC_SOURCES.includes(source) || counter.length === 0) {
    return null;
  }
  return { scenario, taskKind, source, counter: counter.join('.') };
}

/**
 * The scope a work metric is counted in: `<scenario>.work.<source>` for the
 * measured window, `<scenario>.work.task.<kind>.<source>` for a task kind.
 */
export function workMetricScope(key) {
  const parsed = parseWorkMetricKey(key);
  if (!parsed) return null;
  return parsed.taskKind === null
    ? `${parsed.scenario}.work.${parsed.source}`
    : `${parsed.scenario}.work.task.${parsed.taskKind}.${parsed.source}`;
}

function completedTasks(scenario) {
  return (scenario.tasks ?? []).filter((task) => task.status !== 'error');
}

/**
 * The work scopes a scenario collected in full: the measured window of each
 * source sampled without error, and each task kind whose completed tasks were
 * all bracketed for that source (one unbracketed task would make the kind's
 * sum silently partial). Only inside one of these scopes is an absent counter
 * a measured zero.
 */
export function collectedWorkScopes(scenario) {
  const scopes = new Set();
  if (!scenario?.work) return scopes;
  const completed = completedTasks(scenario);
  const kinds = new Set(completed.map((task) => task.kind));
  for (const source of WORK_METRIC_SOURCES) {
    if (!scenario.work[source]) continue;
    scopes.add(`${scenario.name}.work.${source}`);
    for (const kind of kinds) {
      const tasks = completed.filter((task) => task.kind === kind);
      if (tasks.every((task) => task.work?.[source])) {
        scopes.add(`${scenario.name}.work.task.${kind}.${source}`);
      }
    }
  }
  return scopes;
}

function workUnit(counter) {
  return /bytes$/i.test(counter) ? 'bytes' : 'count';
}

function describeWorkCounter(source, counter, scope) {
  if (source === 'chromium') return `Chromium ${counter} change ${scope}`;
  if (Object.hasOwn(APP_WORK_SOURCE_LABELS, source)) {
    return `${APP_WORK_SOURCE_LABELS[source]} ${counter} ${scope}`;
  }
  const [head, ...tail] = counter.split('.');
  if (head === 'counters') {
    return `Transcript counter ${tail.join('.')} change ${scope}`;
  }
  if (tail.length === 1 && tail[0] === 'count') {
    return `Transcript ${head} stage runs ${scope}`;
  }
  return `Transcript ${head} ${tail.slice(1).join('.')} work units ${scope}`;
}

function addWorkMetrics(metrics, prefix, source, counters, scope) {
  for (const counter of Object.keys(counters).sort()) {
    addMetric(
      metrics,
      `${prefix}.${source}.${counter}`,
      metric(
        counters[counter],
        workUnit(counter),
        describeWorkCounter(source, counter, scope),
        undefined,
        'count',
      ),
    );
  }
}

/**
 * Work counters are emitted only for sources the scenario collected without a
 * sampling error. Every counter the measured window observed is reported for
 * the window and for each task kind, so a counter a kind never moved is an
 * explicit zero. Task sums include every task that completed its operation,
 * slow (`unresponsive`) ones too: their work still happened.
 */
function workMetrics(scenario, metrics) {
  const work = scenario.work;
  if (!work) return;
  const prefix = `${scenario.name}.work`;
  const scopes = collectedWorkScopes(scenario);
  const completed = completedTasks(scenario);
  const kinds = [...new Set(completed.map((task) => task.kind))].sort();
  for (const source of WORK_METRIC_SOURCES) {
    // Scaling ratios carry their bounds; `scalingRatioMetrics` emits them.
    if (source === SCALING_WORK_SOURCE || !work[source]) continue;
    addWorkMetrics(
      metrics,
      prefix,
      source,
      work[source],
      'over the measured window',
    );
    for (const kind of kinds) {
      if (!scopes.has(`${prefix}.task.${kind}.${source}`)) continue;
      const tasks = completed.filter((task) => task.kind === kind);
      const totals = Object.fromEntries(
        Object.keys(work[source]).map((counter) => [counter, 0]),
      );
      for (const task of tasks) {
        for (const [counter, value] of Object.entries(task.work[source])) {
          totals[counter] = (totals[counter] ?? 0) + value;
        }
      }
      addWorkMetrics(
        metrics,
        `${prefix}.task.${kind}`,
        source,
        totals,
        `summed over completed ${kind} tasks`,
      );
    }
  }
}

function addMetric(target, key, entry) {
  if (entry) target[key] = entry;
}

function taskMetrics(scenario, metrics) {
  const byKind = new Map();
  for (const task of scenario.tasks ?? []) {
    if (task.status !== 'ok') continue;
    const existing = byKind.get(task.kind) ?? [];
    existing.push(task.durationMs);
    byKind.set(task.kind, existing);
  }
  for (const [kind, durations] of byKind) {
    const summary = summarize(durations);
    const prefix = `${scenario.name}.task.${kind}`;
    addMetric(
      metrics,
      `${prefix}.p50_ms`,
      metric(summary.p50, 'ms', `${kind} median duration`),
    );
    addMetric(
      metrics,
      `${prefix}.p95_ms`,
      metric(summary.p95, 'ms', `${kind} p95 duration`),
    );
    addMetric(
      metrics,
      `${prefix}.max_ms`,
      metric(summary.max, 'ms', `${kind} maximum duration`),
    );
  }

  const typingTimings = [
    ['keyboardDispatchMs', 'keyboard_dispatch', 'Keyboard dispatch burst', 20],
    ['textCommitMs', 'text_commit', 'Text-observed burst', 20],
    [
      'typingBurstMs',
      'burst_to_paint_confirmation',
      'Typing burst through paint confirmation',
      20,
    ],
    [
      'typingBurstMsPerCharacter',
      'burst_per_character',
      'Typing burst per character',
      0.5,
    ],
  ];
  for (const [
    field,
    suffix,
    description,
    minRegressionAbsolute,
  ] of typingTimings) {
    const values = (scenario.tasks ?? [])
      .filter((task) => task.status === 'ok')
      .map((task) => task[field])
      .filter(Number.isFinite);
    const summary = summarize(values);
    const unit = field.endsWith('PerCharacter') ? 'ms/character' : 'ms';
    addMetric(
      metrics,
      `${scenario.name}.typing.${suffix}.p50_${unit === 'ms' ? 'ms' : 'ms_per_character'}`,
      metric(summary.p50, unit, `${description} median`, minRegressionAbsolute),
    );
    addMetric(
      metrics,
      `${scenario.name}.typing.${suffix}.p95_${unit === 'ms' ? 'ms' : 'ms_per_character'}`,
      metric(summary.p95, unit, `${description} p95`, minRegressionAbsolute),
    );
    addMetric(
      metrics,
      `${scenario.name}.typing.${suffix}.max_${unit === 'ms' ? 'ms' : 'ms_per_character'}`,
      metric(
        summary.max,
        unit,
        `${description} maximum`,
        minRegressionAbsolute,
      ),
    );
  }
}

/**
 * Journey milestones and phase durations a scenario measured itself, such as
 * J7 and the code-graph build phases: `scenarios[].timings.<group>.<name>`
 * becomes the timing metric `<scenario>.timing.<group>.<name>`. Only names
 * ending in `_ms` are timings. Startup journeys keep theirs in
 * `startupJourney`, so earlier startup baselines stay comparable.
 */
function timingMetrics(scenario, metrics) {
  for (const [group, values] of Object.entries(scenario.timings ?? {})) {
    for (const [name, value] of Object.entries(values ?? {})) {
      if (!name.endsWith('_ms')) continue;
      addMetric(
        metrics,
        `${scenario.name}.timing.${group}.${name}`,
        metric(value, 'ms', `${group} ${name.slice(0, -3).replace(/_/g, ' ')}`),
      );
    }
  }
}

export function buildScenarioMetrics(scenario) {
  const metrics = {};
  const prefix = scenario.name;
  addMetric(
    metrics,
    `${prefix}.wall_ms`,
    metric(scenario.durationMs, 'ms', 'Complete scenario wall time'),
  );
  addMetric(
    metrics,
    `${prefix}.launch.first_window_ms`,
    metric(
      scenario.launch?.firstWindowMs,
      'ms',
      'Electron launch to first BrowserWindow',
    ),
  );
  addMetric(
    metrics,
    `${prefix}.launch.shell_ms`,
    metric(
      scenario.launch?.shellReadyMs,
      'ms',
      'Electron launch to usable shell',
    ),
  );
  addMetric(
    metrics,
    `${prefix}.launch.dom_content_loaded_ms`,
    metric(
      scenario.launch?.domContentLoadedMs,
      'ms',
      'Electron launch to renderer DOMContentLoaded',
    ),
  );
  addMetric(
    metrics,
    `${prefix}.launch.composer_ready_ms`,
    metric(
      scenario.launch?.composerReadyMs,
      'ms',
      'Electron launch to the first visible startup composer',
    ),
  );
  addMetric(
    metrics,
    `${prefix}.launch.first_input_ms`,
    metric(
      scenario.launch?.firstInputMs,
      'ms',
      'Electron launch to the first startup composer key dispatch',
    ),
  );
  addMetric(
    metrics,
    `${prefix}.launch.shell_to_first_input_ms`,
    metric(
      scenario.launch?.firstInputRelativeToShellMs,
      'ms',
      'Usable shell to the first startup composer key dispatch',
    ),
  );
  // A `timed-out` quit keeps its deadline time, a lower bound.
  addMetric(
    metrics,
    `${prefix}.quit.exit_ms`,
    metric(
      scenario.quit?.exitMs,
      'ms',
      'App quit request to Electron main process exit',
    ),
  );
  taskMetrics(scenario, metrics);
  workMetrics(scenario, metrics);
  Object.assign(metrics, scalingRatioMetrics(scenario));
  timingMetrics(scenario, metrics);

  const summary = scenario.monitoring?.summary;
  if (!summary) return metrics;

  const summaryMetrics = [
    ['ipc.outer.p95_ms', summary.ipcOuterMs?.p95, 'ms', 'IPC heartbeat p95'],
    [
      'ipc.outer.max_ms',
      summary.ipcOuterMs?.max,
      'ms',
      'IPC heartbeat maximum',
    ],
    [
      'ipc.handler.p95_ms',
      summary.ipcHandlerMs?.p95,
      'ms',
      'Renderer-observed IPC handler p95',
    ],
    [
      'renderer.interval_delay.p95_ms',
      summary.rendererIntervalDelayMs?.p95,
      'ms',
      'Renderer timer delay p95',
    ],
    [
      'renderer.interval_delay.p99_ms',
      summary.rendererIntervalDelayMs?.p99,
      'ms',
      'Renderer timer delay p99',
    ],
    [
      'renderer.interval_delay.max_ms',
      summary.rendererIntervalDelayMs?.max,
      'ms',
      'Renderer timer delay maximum',
    ],
    [
      'renderer.frame_delay.p95_ms',
      summary.rendererFrameDelayMs?.p95,
      'ms',
      'Animation-frame delay p95',
    ],
    [
      'renderer.frame_delay.max_ms',
      summary.rendererFrameDelayMs?.max,
      'ms',
      'Animation-frame delay maximum',
    ],
    [
      'renderer.key_event_handler.p95_ms',
      summary.rendererKeyEventHandlerMs?.p95,
      'ms',
      'Keydown-through-keyup event sequence p95',
      1,
    ],
    [
      'renderer.key_event_handler.max_ms',
      summary.rendererKeyEventHandlerMs?.max,
      'ms',
      'Keydown-through-keyup event sequence maximum',
      1,
    ],
    [
      'renderer.key_to_next_frame.p95_ms',
      summary.rendererKeyToNextFrameMs?.p95,
      'ms',
      'Key event to next animation frame p95',
      5,
    ],
    [
      'renderer.key_to_next_frame.max_ms',
      summary.rendererKeyToNextFrameMs?.max,
      'ms',
      'Key event to next animation frame maximum',
      5,
    ],
    [
      'renderer.key_to_paint_confirmation.p95_ms',
      summary.rendererKeyToPaintConfirmationMs?.p95,
      'ms',
      'Key event to second-frame paint confirmation p95',
      5,
    ],
    [
      'renderer.key_to_paint_confirmation.max_ms',
      summary.rendererKeyToPaintConfirmationMs?.max,
      'ms',
      'Key event to second-frame paint confirmation maximum',
      5,
    ],
    [
      'renderer.long_tasks.count',
      summary.longTasks?.count,
      'count',
      'Renderer long-task count',
    ],
    [
      'renderer.long_tasks.max_ms',
      summary.longTasks?.max ?? 0,
      'ms',
      'Renderer longest long task',
    ],
    [
      'renderer.long_tasks.total_ms',
      summary.longTaskTotalMs,
      'ms',
      'Renderer total long-task time',
    ],
    [
      'renderer.js_heap.max_mb',
      summary.jsHeapUsedMb?.max,
      'mb',
      'Renderer maximum used JS heap',
    ],
    [
      'resources.working_set.max_mb',
      summary.totalWorkingSetMb?.max,
      'mb',
      'Maximum summed Electron process working set',
    ],
    [
      'resources.working_set.delta_mb',
      Math.max(0, summary.totalWorkingSetDeltaMb ?? 0),
      'mb',
      'Positive Electron process working-set delta',
    ],
    [
      'resources.cpu.p95_percent',
      summary.totalCpuPercent?.p95,
      'percent',
      'Summed Electron process CPU p95',
    ],
    [
      'resources.cpu.max_percent',
      summary.totalCpuPercent?.max,
      'percent',
      'Summed Electron process CPU maximum',
    ],
    [
      'resources.processes.max_count',
      summary.processCount?.max,
      'count',
      'Maximum Electron-associated process count',
    ],
  ];
  for (const [
    suffix,
    value,
    unit,
    description,
    minRegressionAbsolute,
  ] of summaryMetrics) {
    addMetric(
      metrics,
      `${prefix}.${suffix}`,
      metric(value, unit, description, minRegressionAbsolute),
    );
  }
  return metrics;
}

/**
 * Local smoke gates completed workloads and reports timing separately. Other
 * profiles require every scenario to be responsive and any counter ratchet to
 * pass. Advisory scaling ratios never fail a run.
 */
export function performanceRunSucceeded(result) {
  if (usesLocalSmokePolicy(result))
    return assessSmokeRun(result).localCheckPassed;
  return (
    (result.scenarios ?? []).every((scenario) => scenario.status === 'ok') &&
    result.workRatchet?.passed !== false
  );
}

/**
 * Sample statuses whose timings count in a repeated comparison. A slow
 * (`unresponsive`) launch still measured real timings; a failed one did not.
 */
export const COMPARABLE_SAMPLE_STATUSES = Object.freeze(['ok', 'unresponsive']);

/** Whether an artifact holds more than one sample of each scenario. */
export function isRepeatedResult(result) {
  return Number.isInteger(result?.repeat?.count) && result.repeat.count > 1;
}

/**
 * Whether one sample of a scenario measured comparable timings. A
 * single-sample artifact's records carry no `sample` index and count as
 * sample 0.
 */
export function sampleIsComparable(result, scenarioName, sampleIndex) {
  const records = (result.scenarios ?? []).filter(
    (scenario) =>
      scenario.name === scenarioName && (scenario.sample ?? 0) === sampleIndex,
  );
  return (
    records.length > 0 &&
    records.every((scenario) =>
      COMPARABLE_SAMPLE_STATUSES.includes(scenario.status),
    )
  );
}

/**
 * Folds each sample's flat metrics into one repeated-sample metric map. Every
 * entry keeps its single-sample fields, with `value` set to the median of the
 * comparable samples, so single-sample consumers read a representative value,
 * and adds `samples`: one value per sample index, null where that sample did
 * not report the metric. When no sample is comparable, `value` is null: the
 * failed samples stay in `samples` but represent nothing.
 */
export function aggregateSampleMetrics(result, sampleMetrics) {
  const count = result.repeat?.count ?? sampleMetrics.length;
  const keys = new Set(
    sampleMetrics.flatMap((metrics) => Object.keys(metrics ?? {})),
  );
  const aggregated = {};
  for (const key of keys) {
    const entries = Array.from(
      { length: count },
      (_, index) => sampleMetrics[index]?.[key] ?? null,
    );
    const samples = entries.map((entry) =>
      Number.isFinite(entry?.value) ? entry.value : null,
    );
    const scenarioName = key.split('.')[0];
    const comparable = samples.filter(
      (value, index) =>
        value !== null && sampleIsComparable(result, scenarioName, index),
    );
    if (samples.every((value) => value === null)) continue;
    aggregated[key] = {
      ...entries.find(Boolean),
      value:
        comparable.length > 0 ? roundMetric(percentile(comparable, 0.5)) : null,
      samples,
    };
  }
  return aggregated;
}

/**
 * Builds the flat metric map. A repeated run (`--repeat`) tags each scenario
 * record with its `sample` index and aggregates per-sample metrics; a
 * single-sample run keeps the original shape.
 */
export function finalizeResult(result) {
  const repeated = isRepeatedResult(result);
  const metrics = {};
  const sampleMetrics = [];
  for (const scenario of result.scenarios) {
    applyScalingRatios(scenario);
    const scenarioMetrics = buildScenarioMetrics(scenario);
    if (repeated) {
      const index = scenario.sample ?? 0;
      sampleMetrics[index] = Object.assign(
        sampleMetrics[index] ?? {},
        scenarioMetrics,
      );
    } else {
      Object.assign(metrics, scenarioMetrics);
    }
    if (scenario.monitoring?.summary) {
      scenario.monitoring.summary = Object.fromEntries(
        Object.entries(scenario.monitoring.summary).map(([key, value]) => [
          key,
          value && typeof value === 'object' && 'count' in value
            ? roundSummary(value)
            : typeof value === 'number'
              ? roundMetric(value)
              : value,
        ]),
      );
    }
    scenario.durationMs = roundMetric(scenario.durationMs);
    for (const task of scenario.tasks ?? []) {
      task.durationMs = roundMetric(task.durationMs);
    }
  }
  result.metrics = repeated
    ? aggregateSampleMetrics(result, sampleMetrics)
    : metrics;
  if (usesLocalSmokePolicy(result)) result.acceptance = assessSmokeRun(result);
  return result;
}
