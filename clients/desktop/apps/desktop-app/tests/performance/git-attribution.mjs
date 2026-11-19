import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const KNOWN_SOURCES = new Set([
  'branch-watcher',
  'renderer-global-poll',
  'renderer-targeted',
  'portal-snapshot',
  'desktop-session-snapshot',
  'runtime-status',
  'cli',
  'user-explicit',
  'activity-changed-files',
  'default-branch-revalidation',
  'turn-diff-capture',
  'worktree-health',
  'untagged',
]);

const TIMELINE_BIN_MS = 10_000;
const TIMELINE_MAX_BINS = 60;
const TIMELINE_TOP_SOURCES = 3;
const BETWEEN_TASKS = 'between-tasks';
const MINIMUM_BASH_MAJOR_VERSION = 5;

const KNOWN_COMMAND_FAMILIES = new Set([
  'add',
  'branch',
  'check-ignore',
  'check-ref-format',
  'checkout',
  'commit',
  'config',
  'diff',
  'diff-tree',
  'fetch',
  'for-each-ref',
  'hash-object',
  'log',
  'ls-files',
  'ls-remote',
  'merge-base',
  'merge-tree',
  'mv',
  'remote',
  'reset',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'status',
  'symbolic-ref',
  'update-index',
  'version',
  'worktree',
]);

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function normalizeSource(value) {
  return KNOWN_SOURCES.has(value) ? value : 'other';
}

function normalizeFamily(value) {
  if (value === '--version') return 'version';
  return KNOWN_COMMAND_FAMILIES.has(value) ? value : 'other';
}

function maxConcurrency(records) {
  const events = records.flatMap((record) => [
    { at: record.startedAt, delta: 1 },
    ...(Number.isFinite(record.completedAt)
      ? [{ at: record.completedAt, delta: -1 }]
      : []),
  ]);
  events.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function isFailed(record) {
  return Number.isFinite(record.completedAt) && record.exitCode !== 0;
}

function summarizeRecords(records) {
  const completed = records.filter((record) =>
    Number.isFinite(record.completedAt),
  );
  const durations = completed.map(
    (record) => (record.completedAt - record.startedAt) * 1_000,
  );
  return {
    commandCount: records.length,
    completedCommandCount: completed.length,
    incompleteCommandCount: records.length - completed.length,
    failedCommandCount: records.filter(isFailed).length,
    uniqueTaggedRequestCount: new Set(
      records
        .map((record) => record.requestId)
        .filter((requestId) => requestId !== 'unset'),
    ).size,
    maxConcurrent: maxConcurrency(records),
    durationMs: {
      p50: round(percentile(durations, 0.5) ?? 0),
      p95: round(percentile(durations, 0.95) ?? 0),
      max: round(durations.length > 0 ? Math.max(...durations) : 0),
      total: round(durations.reduce((sum, duration) => sum + duration, 0)),
    },
  };
}

function rankedGroups(records, keyName, keyForRecord) {
  const groups = new Map();
  for (const record of records) {
    const key = keyForRecord(record);
    const existing = groups.get(key) ?? [];
    existing.push(record);
    groups.set(key, existing);
  }
  return [...groups.entries()]
    .map(([key, entries]) => ({
      [keyName]: key,
      ...summarizeRecords(entries),
    }))
    .sort(
      (left, right) =>
        right.commandCount - left.commandCount ||
        String(left[keyName]).localeCompare(String(right[keyName])),
    );
}

function crossSourceOverlaps(records) {
  const completed = records.filter((record) =>
    Number.isFinite(record.completedAt),
  );
  const counts = new Map();
  for (let leftIndex = 0; leftIndex < completed.length; leftIndex += 1) {
    const left = completed[leftIndex];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < completed.length;
      rightIndex += 1
    ) {
      const right = completed[rightIndex];
      if (left.source === right.source) continue;
      if (
        left.startedAt >= right.completedAt ||
        right.startedAt >= left.completedAt
      ) {
        continue;
      }
      const sources = [left.source, right.source].sort();
      const key = sources.join('\0');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, overlapCount]) => ({
      sources: key.split('\0'),
      overlapCount,
    }))
    .sort(
      (left, right) =>
        right.overlapCount - left.overlapCount ||
        left.sources.join().localeCompare(right.sources.join()),
    );
}

function taskEpochMs(mark) {
  return Number.isFinite(mark?.timeOrigin) && Number.isFinite(mark?.atMs)
    ? mark.timeOrigin + mark.atMs
    : null;
}

/** Recorded task windows on the host wall clock. A task without both renderer
 * marks has no window. */
function scenarioTaskWindows(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map((task) => ({
      kind: typeof task?.kind === 'string' ? task.kind : 'unknown',
      startMs: taskEpochMs(task?.rendererStart),
      endMs: taskEpochMs(task?.rendererEnd),
    }))
    .filter(
      (window) =>
        window.startMs !== null &&
        window.endMs !== null &&
        window.endMs >= window.startMs,
    );
}

/** Launches grouped by the recorded task whose window encloses their start
 * (the latest-starting one when windows overlap). This is time overlap only;
 * it does not show that the task caused the launch. */
function byScenarioTask(records, tasks) {
  const windows = scenarioTaskWindows(tasks);
  const windowStats = new Map();
  for (const window of windows) {
    const stats = windowStats.get(window.kind) ?? {
      windowCount: 0,
      windowMs: 0,
    };
    stats.windowCount += 1;
    stats.windowMs += window.endMs - window.startMs;
    windowStats.set(window.kind, stats);
  }
  const taskForRecord = (record) => {
    const atMs = record.startedAt * 1_000;
    let enclosing = null;
    for (const window of windows) {
      if (atMs < window.startMs || atMs > window.endMs) continue;
      if (!enclosing || window.startMs > enclosing.startMs) enclosing = window;
    }
    return enclosing ? enclosing.kind : BETWEEN_TASKS;
  };
  return rankedGroups(records, 'task', taskForRecord).map((group) => {
    const stats = windowStats.get(group.task);
    if (!stats || group.task === BETWEEN_TASKS) return group;
    return {
      ...group,
      windowCount: stats.windowCount,
      windowMs: round(stats.windowMs),
      launchesPerSecond: round(
        stats.windowMs > 0 ? group.commandCount / (stats.windowMs / 1_000) : 0,
      ),
    };
  });
}

/** `main` when Electron main launched the shim, `other` for any other parent,
 * and `unknown` when the log or the run lacks a parent PID. */
function byLauncher(records, mainPid) {
  const knownMainPid =
    Number.isInteger(mainPid) && mainPid > 0 ? String(mainPid) : null;
  return rankedGroups(records, 'launcher', (record) => {
    if (!knownMainPid || !record.parentPid) return 'unknown';
    return record.parentPid === knownMainPid ? 'main' : 'other';
  });
}

function timeline(records) {
  if (records.length === 0) {
    return { binMs: TIMELINE_BIN_MS, maxBins: TIMELINE_MAX_BINS, bins: [] };
  }
  const originMs =
    records.reduce(
      (earliest, record) => Math.min(earliest, record.startedAt),
      Infinity,
    ) * 1_000;
  const bins = new Map();
  const overflow = [];
  for (const record of records) {
    const index = Math.floor(
      (record.startedAt * 1_000 - originMs) / TIMELINE_BIN_MS,
    );
    if (index >= TIMELINE_MAX_BINS) {
      overflow.push(record);
      continue;
    }
    const entries = bins.get(index) ?? [];
    entries.push(record);
    bins.set(index, entries);
  }
  return {
    originEpochMs: round(originMs),
    binMs: TIMELINE_BIN_MS,
    maxBins: TIMELINE_MAX_BINS,
    bins: [...bins.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, entries]) => ({
        startOffsetMs: index * TIMELINE_BIN_MS,
        commandCount: entries.length,
        failedCommandCount: entries.filter(isFailed).length,
        topSources: rankedGroups(entries, 'source', (record) => record.source)
          .slice(0, TIMELINE_TOP_SOURCES)
          .map(({ source, commandCount }) => ({ source, commandCount })),
      })),
    ...(overflow.length > 0
      ? {
          afterLastBin: {
            commandCount: overflow.length,
            failedCommandCount: overflow.filter(isFailed).length,
          },
        }
      : {}),
  };
}

/** Summarizes a wrapper log. `tasks` are the scenario's recorded tasks and
 * `mainPid` the Electron main process ID; both are optional. Start rows carry
 * an optional trailing parent PID; logs written before it still parse. */
export function summarizeGitAttributionLog(text, { tasks, mainPid } = {}) {
  // Every start row is its own record; an end row completes the latest open
  // start with its PID, so a reused PID never replaces an earlier launch.
  const records = [];
  const openByPid = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [phase, rawAt, pid, first, second, third, fourth] = line.split('\t');
    const at = Number(rawAt);
    if (!Number.isFinite(at) || !pid) continue;
    if (phase === 'start') {
      const record = {
        pid,
        startedAt: at,
        source: normalizeSource(first),
        requestId: second || 'unset',
        commandFamily: normalizeFamily(third),
        parentPid: /^[1-9][0-9]*$/.test(fourth ?? '') ? fourth : null,
      };
      records.push(record);
      openByPid.set(pid, record);
      continue;
    }
    if (phase === 'end') {
      const record = openByPid.get(pid);
      if (!record || at < record.startedAt) continue;
      openByPid.delete(pid);
      record.completedAt = at;
      record.exitCode = Number.isFinite(Number(first)) ? Number(first) : null;
    }
  }

  return {
    schemaVersion: 1,
    captureKind: 'diagnostic-git-wrapper',
    timingComparable: false,
    ...summarizeRecords(records),
    bySource: rankedGroups(records, 'source', (record) => record.source),
    byCommandFamily: rankedGroups(
      records,
      'commandFamily',
      (record) => record.commandFamily,
    ),
    sourceCommandFamilies: rankedGroups(
      records,
      'sourceCommandFamily',
      (record) => `${record.source}:${record.commandFamily}`,
    ),
    crossSourceOverlaps: crossSourceOverlaps(records),
    byScenarioTask: byScenarioTask(records, tasks),
    byLauncher: byLauncher(records, mainPid),
    timeline: timeline(records),
  };
}

/** The command-family parse, log rows and exit propagation the zsh and bash
 * shims share. `timeFormat` and `timeValue` print the current wall-clock time
 * in epoch seconds without a subshell. The start row's trailing column is the
 * shim's parent PID. */
function shimBody(timeFormat, timeValue) {
  return `source_name="\${CANOPY_GIT_REQUEST_SOURCE:-untagged}"
request_id="\${CANOPY_GIT_REQUEST_ID:-unset}"
git_args=("$@")
family="other"
while (( $# > 0 )); do
  case "$1" in
    -C|-c|--git-dir|--work-tree|--namespace|--super-prefix)
      shift
      (( $# > 0 )) && shift
      ;;
    --git-dir=*|--work-tree=*|--namespace=*|--super-prefix=*|--config-env=*|--exec-path=*|--list-cmds=*|--attr-source=*)
      shift
      ;;
    --version)
      family="version"
      break
      ;;
    -*)
      shift
      ;;
    *)
      case "$1" in
        add|branch|check-ignore|check-ref-format|checkout|commit|config|diff|diff-tree|fetch|for-each-ref|hash-object|log|ls-files|ls-remote|merge-base|merge-tree|mv|remote|reset|rev-list|rev-parse|show|show-ref|status|symbolic-ref|update-index|worktree) family="$1" ;;
      esac
      break
      ;;
  esac
done
printf 'start\\t${timeFormat}\\t%s\\t%s\\t%s\\t%s\\t%s\\n' ${timeValue} "$$" "$source_name" "$request_id" "$family" "$PPID" >> "$CANOPY_PERFORMANCE_GIT_ATTRIBUTION_LOG"
"$CANOPY_PERFORMANCE_REAL_GIT" "\${git_args[@]}"
exit_code=$?
printf 'end\\t${timeFormat}\\t%s\\t%s\\n' ${timeValue} "$$" "$exit_code" >> "$CANOPY_PERFORMANCE_GIT_ATTRIBUTION_LOG"
exit "$exit_code"
`;
}

function zshShim() {
  return `#!/bin/zsh
zmodload zsh/datetime
${shimBody('%.6f', '"$EPOCHREALTIME"')}`;
}

// Bash 5 formats $EPOCHREALTIME with the locale's decimal separator.
function bashShim() {
  return `#!/usr/bin/env bash
${shimBody('%s', '"${EPOCHREALTIME/,/.}"')}`;
}

function findExecutableOnPath(name, pathValue) {
  for (const directory of (pathValue ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not present or not executable here; keep searching.
    }
  }
  return null;
}

function readBashMajorVersion(env) {
  try {
    const output = execFileSync(
      '/usr/bin/env',
      ['bash', '-c', 'printf %s "${BASH_VERSINFO[0]}"'],
      { encoding: 'utf8', env, timeout: 10_000 },
    );
    const major = Number.parseInt(output.trim(), 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

/** The wrapper and real Git for this host: zsh and `/usr/bin/git` on macOS,
 * bash 5 and the first `git` on `PATH` on Linux. Other platforms refuse.
 * `host` lets tests substitute the platform, environment and bash probe. */
export function resolveGitAttributionHost({
  platform = process.platform,
  env = process.env,
  bashMajorVersion = readBashMajorVersion,
} = {}) {
  if (platform === 'darwin') {
    const realGitPath = '/usr/bin/git';
    if (!existsSync(realGitPath)) {
      throw new Error(`Git attribution requires ${realGitPath}`);
    }
    return { shimName: 'git-attribution.zsh', shim: zshShim(), realGitPath };
  }
  if (platform === 'linux') {
    const realGitPath = findExecutableOnPath('git', env.PATH);
    if (!realGitPath) {
      throw new Error('Git attribution requires git on PATH');
    }
    const major = bashMajorVersion(env);
    if (major === null || major < MINIMUM_BASH_MAJOR_VERSION) {
      throw new Error(
        `Git attribution on Linux requires bash ${MINIMUM_BASH_MAJOR_VERSION} or later on PATH (found ${major === null ? 'none' : `bash ${major}`})`,
      );
    }
    return { shimName: 'git-attribution.bash', shim: bashShim(), realGitPath };
  }
  throw new Error(
    '--git-attribution requires macOS or Linux, the supported desktop performance development hosts',
  );
}

export function prepareGitAttributionCapture(userDataDir, host) {
  const { shimName, shim, realGitPath } = resolveGitAttributionHost(host);
  const captureDir = path.join(userDataDir, 'performance-git-attribution');
  const logPath = path.join(captureDir, 'commands.tsv');
  const shimPath = path.join(captureDir, shimName);
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(logPath, '');
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return {
    env: {
      CANOPY_GIT_EXECUTABLE: shimPath,
      CANOPY_PERFORMANCE_GIT_ATTRIBUTION_LOG: logPath,
      CANOPY_PERFORMANCE_REAL_GIT: realGitPath,
    },
    /** `tasks` and `mainPid` enable `byScenarioTask` and `byLauncher`. */
    summarize: ({ tasks, mainPid } = {}) =>
      summarizeGitAttributionLog(
        existsSync(logPath) ? readFileSync(logPath, 'utf8') : '',
        { tasks, mainPid },
      ),
  };
}
