import { createHash } from 'node:crypto';
import { roundMetric } from './statistics.mjs';

/**
 * CAN-6932: the power-user fixture at `retainedWorktrees` worktrees (about
 * 86% of them in one project, as on the reporting machine), with chats and
 * fired watchers. Rows are padded to about 3 KB, each project holds one
 * stopped archive, and each worktree checkout has a project config file, so
 * recovery checks and script and hook resolution do real work.
 */
const RETAINED_COWORK_ENTRIES = 4;

export function retainedWorktreesIdleConfig(config) {
  // The power-user shape holds at most 175 chat containers: one Advisor
  // container, one per worktree, and the visible Cowork entries.
  if (config.retainedWorktrees + 1 + RETAINED_COWORK_ENTRIES > 175)
    throw new Error(
      `retained-worktrees-idle supports at most ${174 - RETAINED_COWORK_ENTRIES} worktrees`,
    );
  return {
    ...config,
    powerUserWorktrees: config.retainedWorktrees,
    powerUserWorkspaces: 4,
    powerUserRepositories: 3,
    powerUserCoworkWorkspaces: 1,
    powerUserCoworkEntries: RETAINED_COWORK_ENTRIES,
    powerUserChatTabs: Math.min(175, config.retainedWorktrees + 20),
    powerUserMessages: 2_000,
    powerUserGraphFilesPerRepo: 40,
    powerUserPipelineExecutions: 10,
    powerUserPipelineTotalBytes: 1_000_000,
  };
}

/**
 * Stored bytes a seeded row is padded to. Launch adds about 1.1 KB to each row
 * (PR status from the mock server), so rows measure about 3 KB at the start of
 * the idle window, as on the reporting machine (321 KB / 107 rows). The run
 * records the measured size in `retained.rowsMeasured`.
 */
export const RETAINED_ROW_BYTES = 1_900;

/** A row's bytes as a worktree list stores it: indented, inside the array. */
function storedRowBytes(row) {
  const empty = JSON.stringify({ version: 1, worktrees: [] }, null, 2);
  return (
    Buffer.byteLength(
      JSON.stringify({ version: 1, worktrees: [row] }, null, 2),
    ) - Buffer.byteLength(empty)
  );
}

/**
 * `row` grown to at least `bytes` as stored, with paused hook keys that name no
 * configured hook. Only an explicit pause or resume rewrites them, so the
 * padding survives launch; seen pipeline execution IDs that match no run are
 * pruned as soon as the renderer reconciles them.
 */
export function padRetainedWorktreeRow(row, bytes = RETAINED_ROW_BYTES) {
  const keys = [...(row.pausedHookKeys ?? [])];
  const padded = { ...row, pausedHookKeys: keys };
  let ordinal = 0;
  while (storedRowBytes(padded) < bytes) {
    ordinal += 1;
    keys.push(
      `perf-retained-${createHash('sha256').update(`${row.id}:${ordinal}`).digest('hex').slice(0, 32)}`,
    );
  }
  keys.sort();
  return padded;
}

export function counterDeltas(start, end, keep) {
  const deltas = {};
  for (const [key, value] of Object.entries(end ?? {})) {
    if (!keep(key) || typeof value !== 'number') continue;
    const delta = value - (start?.[key] ?? 0);
    if (delta > 0) deltas[key] = delta;
  }
  return deltas;
}

export function scaled(deltas, divisor) {
  return Object.fromEntries(
    Object.entries(deltas)
      .map(([key, value]) => [key, roundMetric(value / divisor)])
      .sort((left, right) => right[1] - left[1]),
  );
}

const countedWork = (key) => !key.endsWith('.us') && !key.endsWith('.bytes');

/** The keys that answer "what did one stale signal or focus cost". */
const RETAINED_EVENT_IPC = [
  'invoke.desktop:session-snapshot',
  'invoke.worktree:recovery-list',
  'invoke.preferences:load',
];

function isMetadataRead(key) {
  return /^read\.(index|manifest|worktrees)\./.test(key);
}

function sumOf(values, keep) {
  return roundMetric(
    Object.entries(values)
      .filter(([key]) => keep(key))
      .reduce((sum, [, value]) => sum + value, 0),
  );
}

/**
 * One window's main CPU (percent of one core) and per-second work. With
 * `events`, also the work per event: per stale signal or per focus.
 */
export function retainedIdleRates(start, end, events) {
  const seconds = (end.at - start.at) / 1000;
  const cpuMicros =
    end.cpu.user - start.cpu.user + (end.cpu.system - start.cpu.system);
  const w5 = counterDeltas(start.w5, end.w5, countedWork);
  const ipc = counterDeltas(start.ipc, end.ipc, countedWork);
  // A build without the metadata source reports it unavailable, never zero.
  const hasMetadata = Boolean(start.metadata && end.metadata);
  const metadata = counterDeltas(start.metadata, end.metadata, countedWork);
  const w5PerSecond = scaled(w5, seconds);
  const rates = {
    seconds: roundMetric(seconds),
    mainCpuPercentOfCore: roundMetric(
      (cpuMicros / 1000 / (seconds * 1000)) * 100,
    ),
    metadataReadsPerSecond: sumOf(w5PerSecond, isMetadataRead),
    // A daemon-backed capture counts in both; the in-process store only in
    // the first.
    metadataCapturesPerSecond: Math.max(
      w5PerSecond['readView.captured'] ?? 0,
      w5PerSecond['port.capture'] ?? 0,
    ),
    configReadsPerSecond: hasMetadata
      ? sumOf(scaled(metadata, seconds), (key) => key.startsWith('config.'))
      : null,
    w5PerSecond,
    metadataPerSecond: hasMetadata ? scaled(metadata, seconds) : null,
    ipcPerSecond: Object.fromEntries(
      Object.entries(scaled(ipc, seconds)).slice(0, 25),
    ),
  };
  if (!events) return rates;
  const signals = ipc[events.key] ?? 0;
  if (signals === 0) return { ...rates, events: { key: events.key, count: 0 } };
  return {
    ...rates,
    events: {
      key: events.key,
      count: signals,
      perEvent: {
        metadataReads: roundMetric(sumOf(w5, isMetadataRead) / signals),
        configReads: hasMetadata
          ? roundMetric(
              sumOf(metadata, (key) => key.startsWith('config.')) / signals,
            )
          : null,
        metadata: hasMetadata ? scaled(metadata, signals) : null,
        ipc: scaled(
          Object.fromEntries(
            RETAINED_EVENT_IPC.map((key) => [key, ipc[key] ?? 0]),
          ),
          signals,
        ),
      },
    },
  };
}

/**
 * CAN-6969: the counts the work-counter ratchet reads for this scenario, as
 * its `retained` work source. Idle values are totals over the idle window;
 * stale and focus values are per event, so they hold whatever the phase's
 * length. Null when an active phase saw no events, so a broken run is
 * `missing` rather than a clean zero.
 */
export function retainedEventWork({ idle, stale, focus }) {
  if (!stale?.events?.perEvent || !focus?.events?.perEvent) return null;
  const work = {};
  const add = (key, value) => {
    if (Number.isFinite(value)) work[key] = value;
  };
  const total = (perSecond) =>
    perSecond === null ? null : Math.round(perSecond * idle.seconds);
  add('idle.metadataReads', total(idle.metadataReadsPerSecond));
  add('idle.metadataCaptures', total(idle.metadataCapturesPerSecond));
  add('idle.configReads', total(idle.configReadsPerSecond));
  for (const [phase, rates] of [
    ['stale', stale],
    ['focus', focus],
  ]) {
    const { perEvent } = rates.events;
    add(`${phase}.perEvent.metadataReads`, perEvent.metadataReads);
    add(`${phase}.perEvent.configReads`, perEvent.configReads);
    for (const [channel, value] of Object.entries(perEvent.ipc ?? {}))
      add(`${phase}.perEvent.ipc.${channel}`, value);
  }
  return work;
}
