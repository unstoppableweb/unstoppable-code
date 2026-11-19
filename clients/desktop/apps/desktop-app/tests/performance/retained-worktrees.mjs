import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

/** Armed after every seeded transcript message, so no catch-up fires them. */
const ACTIVE_WATCHER_CREATED_AT = '2026-07-02T12:00:00.000Z';
const ACTIVE_WATCHER_ID_PREFIX = 'perf-active-chat-watcher-';

/**
 * The access evidence a current watcher records when it is armed: the
 * project's owner and incarnation, as `makeAuthorizedIdentity` in
 * `project-discovery/owner-policy.ts` builds them. Fixture projects carry no
 * owner binding, so they resolve to Personal. Without it, startup
 * reconciliation treats each row's authority as changed and rewrites the
 * store once per row to stamp a denial watermark.
 */
function retainedSetupAuthority({ id, type, name }) {
  const owner = { kind: 'personal' };
  return {
    sourceOwner: owner,
    resourceIncarnation: JSON.stringify({
      projectId: id,
      owner,
      readiness: 'ready',
      name,
      type,
    }),
  };
}

/**
 * CAN-7129: `count` active chat-completion watchers on retained worktree
 * chats, so every `watchers.list()` runs their access checks. Alternate rows
 * use the legacy `worktree_chat_completion` spelling in the legacy store and
 * the current `project_task_chat_completion` spelling in the canonical
 * sidecar. Targets go round-robin across projects; each watcher reports to
 * another worktree's chat in its project. The selected worktree, whose chat
 * streams during the chat phase, and each list's recovery-journal row are
 * never targets or destinations, so no seeded watcher fires.
 */
export function seedRetainedActiveChatWatchers(
  userDataDir,
  count,
  { excludeBranch },
) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const index = JSON.parse(
    readFileSync(path.join(workspacesRoot, 'index.json'), 'utf8'),
  );
  const setupAuthorities = new Map();
  const projects = index.workspaces.flatMap(({ id, type, name }) => {
    const listPath = path.join(workspacesRoot, id, 'worktrees.json');
    if (type === 'cowork' || !existsSync(listPath)) return [];
    setupAuthorities.set(id, retainedSetupAuthority({ id, type, name }));
    const rows = JSON.parse(readFileSync(listPath, 'utf8')).worktrees ?? [];
    const chats = rows.slice(0, -1).flatMap((row) => {
      const chatsPath = path.join(
        workspacesRoot,
        id,
        'chats',
        `${row.id}.json`,
      );
      if (
        row.hidden === true ||
        row.branchName === excludeBranch ||
        !existsSync(chatsPath)
      )
        return [];
      const chatId = JSON.parse(readFileSync(chatsPath, 'utf8')).tabs?.[0]?.id;
      return chatId ? [{ projectId: id, taskId: row.id, chatId }] : [];
    });
    // A destination needs a second chat in the same project.
    return chats.length >= 2 ? [chats] : [];
  });
  const targets = [];
  for (let depth = 0; targets.length < count; depth += 1) {
    const layer = projects.filter((chats) => depth < chats.length);
    if (layer.length === 0)
      throw new Error(
        `--retained-active-watchers supports at most ${targets.length} watchers at this worktree count`,
      );
    for (const chats of layer) {
      if (targets.length === count) break;
      targets.push({
        target: chats[depth],
        destination: chats[(depth + 1) % chats.length],
      });
    }
  }
  const legacy = [];
  const canonical = [];
  for (const [ordinal, { target, destination }] of targets.entries()) {
    const current = ordinal % 2 === 1;
    const id = `${ACTIVE_WATCHER_ID_PREFIX}${String(ordinal + 1).padStart(3, '0')}`;
    const row = {
      version: 1,
      id,
      trigger: current
        ? 'project_task_chat_completion'
        : 'worktree_chat_completion',
      status: 'active',
      label: `Retained chat watcher ${ordinal + 1}`,
      target: {
        kind: 'worktree_chat',
        projectId: target.projectId,
        worktreeId: target.taskId,
        chatId: target.chatId,
      },
      destination: {
        projectId: destination.projectId,
        worktreeId: destination.taskId,
        chatId: destination.chatId,
      },
      ...(current
        ? {
            canonical: {
              trigger: 'project_task_chat_completion',
              target: {
                projectId: target.projectId,
                taskId: target.taskId,
                chatId: target.chatId,
              },
            },
            observation: {
              mode: 'current',
              armedAt: ACTIVE_WATCHER_CREATED_AT,
            },
            setupAuthority: setupAuthorities.get(target.projectId),
          }
        : {}),
      createdAt: ACTIVE_WATCHER_CREATED_AT,
      updatedAt: ACTIVE_WATCHER_CREATED_AT,
      dedupeKey: `perf-active-chat-watcher-dedupe-${id}`,
    };
    (current ? canonical : legacy).push(row);
  }
  const legacyPath = path.join(userDataDir, 'app-advisor-watchers.json');
  const legacyFile = existsSync(legacyPath)
    ? JSON.parse(readFileSync(legacyPath, 'utf8'))
    : { version: 1, updatedAt: ACTIVE_WATCHER_CREATED_AT, watchers: [] };
  legacyFile.watchers.push(...legacy);
  writeFileSync(legacyPath, `${JSON.stringify(legacyFile, null, 2)}\n`);
  writeFileSync(
    path.join(userDataDir, 'app-advisor-watchers-canonical.json'),
    `${JSON.stringify({ version: 1, updatedAt: ACTIVE_WATCHER_CREATED_AT, watchers: canonical })}\n`,
  );
  return {
    count: targets.length,
    legacy: legacy.length,
    current: canonical.length,
    projects: new Set(targets.map(({ target }) => target.projectId)).size,
  };
}

/**
 * How the app lists the seeded watchers after the measured phases. Each one
 * must still be active and carry no availability, so its access check reached
 * the worktree read in every phase; otherwise the workload measured nothing.
 */
export function retainedActiveChatWatchersAfterRun(summaries, seeded) {
  const rows = summaries.filter(({ id }) =>
    id.startsWith(ACTIVE_WATCHER_ID_PREFIX),
  );
  const statuses = {};
  const unavailable = {};
  for (const { status, availability } of rows) {
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (availability)
      unavailable[availability] = (unavailable[availability] ?? 0) + 1;
  }
  const allowedActive = rows.filter(
    ({ status, availability }) => status === 'active' && !availability,
  ).length;
  const afterRun = {
    listed: rows.length,
    allowedActive,
    statuses,
    unavailable,
  };
  if (allowedActive !== seeded.count)
    throw new Error(
      `retained-worktrees-idle: ${allowedActive} of ${seeded.count} seeded chat watchers stayed active and allowed (${JSON.stringify(afterRun)})`,
    );
  return afterRun;
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

/**
 * The mean record-port capture round trip, in milliseconds (CAN-6944): from
 * sending `core.workspaceRecords.capture` to its answer, timed by the port's
 * own `port.capture.us` counter. Null when the window sent no capture.
 */
function captureRoundTripMs(start, end) {
  const timed = counterDeltas(
    start,
    end,
    (key) => key === 'port.capture' || key === 'port.capture.us',
  );
  const captures = timed['port.capture'] ?? 0;
  return captures > 0
    ? roundMetric((timed['port.capture.us'] ?? 0) / captures / 1000)
    : null;
}

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
 * `events`, also the work per event: per stale signal, per focus, or per
 * applied chat provider event. `events.source` names the counter source the
 * event key is read from, `ipc` unless given.
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
  // CAN-6970: the broad stale signal by the source that asked, broadcasts
  // and snapshot builds. Unavailable, never zero, on a build without it.
  const hasStale = Boolean(start.stale && end.stale);
  const stale = counterDeltas(start.stale, end.stale, countedWork);
  const provider = counterDeltas(start.provider, end.provider, countedWork);
  // CAN-6944: W5 captures and store reads by the IPC channel that asked.
  const hasW5Caller = Boolean(start.w5Caller && end.w5Caller);
  const w5Caller = counterDeltas(start.w5Caller, end.w5Caller, countedWork);
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
    captureRoundTripMs: captureRoundTripMs(start.w5, end.w5),
    configReadsPerSecond: hasMetadata
      ? sumOf(scaled(metadata, seconds), (key) => key.startsWith('config.'))
      : null,
    w5PerSecond,
    metadataPerSecond: hasMetadata ? scaled(metadata, seconds) : null,
    stalePerSecond: hasStale ? scaled(stale, seconds) : null,
    w5CallerPerSecond: hasW5Caller ? scaled(w5Caller, seconds) : null,
    snapshotBuildsPerSecond: hasStale
      ? roundMetric((stale['snapshot.build'] ?? 0) / seconds)
      : null,
    ipcPerSecond: Object.fromEntries(
      Object.entries(scaled(ipc, seconds)).slice(0, 25),
    ),
  };
  if (!events) return rates;
  const signals =
    (events.source === 'provider' ? provider : ipc)[events.key] ?? 0;
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
        snapshotBuilds: hasStale
          ? roundMetric((stale['snapshot.build'] ?? 0) / signals)
          : null,
        stale: hasStale ? scaled(stale, signals) : null,
        w5Caller: hasW5Caller ? scaled(w5Caller, signals) : null,
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
 * Per-event work for a phase whose events the harness counts itself (window
 * focus), from the phase's per-second rates: the same keys `retainedIdleRates`
 * reports for an IPC-counted event, each `null` when its source is unavailable.
 */
export function retainedPerEventFromRates(rates, count) {
  const events = Math.max(count, 1);
  const total = (perSecond) => perSecond * rates.seconds;
  const totals = (perSecond) =>
    perSecond === null
      ? null
      : scaled(
          Object.fromEntries(
            Object.entries(perSecond).map(([key, rate]) => [key, total(rate)]),
          ),
          events,
        );
  return {
    metadataReads: roundMetric(total(rates.metadataReadsPerSecond) / events),
    configReads:
      rates.configReadsPerSecond === null
        ? null
        : roundMetric(total(rates.configReadsPerSecond) / events),
    metadata: totals(rates.metadataPerSecond),
    snapshotBuilds:
      rates.snapshotBuildsPerSecond === null
        ? null
        : roundMetric(total(rates.snapshotBuildsPerSecond) / events),
    stale: totals(rates.stalePerSecond),
    w5Caller: totals(rates.w5CallerPerSecond ?? null),
  };
}

const isStaleRequest = (key) => key.startsWith('request.');

/**
 * The broad stale signal's work (CAN-6970) under `prefix`: snapshot builds,
 * broadcasts and requests from every source, then each source on its own.
 * `snapshot.build` is reported once, as `snapshotBuilds`. A build without
 * the stale source adds nothing, so its counts read as missing.
 */
function addStaleWork(add, prefix, snapshotBuilds, stale) {
  add(`${prefix}snapshotBuilds`, snapshotBuilds);
  if (!stale) return;
  add(`${prefix}stale.broadcast`, stale.broadcast ?? 0);
  add(`${prefix}stale.requests`, sumOf(stale, isStaleRequest));
  for (const [key, value] of Object.entries(stale))
    if (key !== 'snapshot.build') add(`${prefix}stale.${key}`, value);
}

/**
 * CAN-6969: the counts the work-counter ratchet reads for this scenario, as
 * its `retained` work source. Idle values are totals over the idle window;
 * stale, focus and chat values are per event, so they hold whatever the
 * phase's length. Null when the stale or focus phase saw no events, so a
 * broken run is `missing` rather than a clean zero. A chat phase that didn't
 * run, such as on a build without work counters, adds no chat counts.
 */
export function retainedEventWork({ idle, stale, focus, chat }) {
  if (!stale?.events?.perEvent || !focus?.events?.perEvent) return null;
  const work = {};
  const add = (key, value) => {
    if (Number.isFinite(value)) work[key] = value;
  };
  const total = (perSecond) =>
    perSecond === null || perSecond === undefined
      ? null
      : Math.round(perSecond * idle.seconds);
  add('idle.metadataReads', total(idle.metadataReadsPerSecond));
  add('idle.metadataCaptures', total(idle.metadataCapturesPerSecond));
  add('idle.configReads', total(idle.configReadsPerSecond));
  addStaleWork(
    add,
    'idle.',
    total(idle.snapshotBuildsPerSecond),
    idle.stalePerSecond
      ? Object.fromEntries(
          Object.entries(idle.stalePerSecond).map(([key, rate]) => [
            key,
            total(rate),
          ]),
        )
      : null,
  );
  for (const [phase, rates] of [
    ['stale', stale],
    ['focus', focus],
  ]) {
    const { perEvent } = rates.events;
    add(`${phase}.perEvent.metadataReads`, perEvent.metadataReads);
    add(`${phase}.perEvent.configReads`, perEvent.configReads);
    for (const [channel, value] of Object.entries(perEvent.ipc ?? {}))
      add(`${phase}.perEvent.ipc.${channel}`, value);
    addStaleWork(
      add,
      `${phase}.perEvent.`,
      perEvent.snapshotBuilds,
      perEvent.stale,
    );
  }
  // CAN-6934's reopen trigger: archive recovery list reads per focus.
  const focusMetadata = focus.events.perEvent.metadata;
  if (focusMetadata)
    add(
      'focus.perEvent.recoveryListReads',
      focusMetadata['recovery.list'] ?? 0,
    );
  const chatPerEvent = chat?.events?.perEvent;
  if (chatPerEvent) {
    add('chat.perEvent.metadataReads', chatPerEvent.metadataReads);
    add('chat.perEvent.configReads', chatPerEvent.configReads);
    addStaleWork(
      add,
      'chat.perEvent.',
      chatPerEvent.snapshotBuilds,
      chatPerEvent.stale,
    );
  }
  return work;
}
