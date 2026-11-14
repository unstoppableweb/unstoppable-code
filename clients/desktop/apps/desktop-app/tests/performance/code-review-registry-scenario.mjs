// Whole-app Code Review registry workload (CAN-4495): the retained register
// IPC and the real worktree removal routes that read or rewrite the legacy
// review-chat registry, driven through the sidebar and archive UI.
//
// Routes, as wired at the time of writing:
// - Delete with the checkout present archives a retained "Deleted" container;
//   its cleanup returns before the registry is read (a control).
// - Delete permanently from "Archived and deleted" purges that container and
//   removes the worktree's registry rows inside the purge IPC.
// - Delete with the checkout missing is a hard delete whose sidecar cleanup
//   removes the rows inside the archive IPC. The sidebar hides the row before
//   main finishes, so its user-visible row timing excludes the registry work;
//   the main handler time is the completion measure.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { seedDemoWorkspaces } from '../electron/demoWorkspaces.mjs';

export const CODE_REVIEW_REGISTRY_SCENARIO = 'code-review-registry-cleanup';
export const CODE_REVIEW_REGISTRY_TRACE_SCENARIO =
  'code-review-registry-cleanup-trace';

const REGISTRY_DIR_SEGMENTS = ['app-workspaces', 'code-review-chat', 'chats'];
const REGISTRY_FILE = 'registry.json';
const REGISTRY_TEMP_PATTERN = /^\.registry\.json\..+\.tmp$/;
const OTHER_PROJECT_ID = 'perf-other-project';
const FIXED_CREATED_AT_MS = Date.parse('2026-09-01T12:00:00.000Z');
const PROBE_GLOBAL = '__canopyCodeReviewRegistryProbe';
const TIMER_GLOBAL = '__canopyCodeReviewRegistryTimers';
const PING_GLOBAL = '__canopyCodeReviewRegistryPing';

export const PROBED_IPC_CHANNELS = Object.freeze({
  register: 'code-review:register',
  archive: 'worktree:archive',
  purge: 'archived-containers:delete',
});

export function codeReviewRegistryDir(userDataDir) {
  return path.join(userDataDir, ...REGISTRY_DIR_SEGMENTS);
}

export function codeReviewRegistryPath(userDataDir) {
  return path.join(codeReviewRegistryDir(userDataDir), REGISTRY_FILE);
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Seeded registry rows. Each removed worktree owns `matchingRows` rows: its
 * composite scope key plus synthetic legacy-form keys. Unrelated rows are the
 * kept worktree's row, one same-worktree-id row owned by another project per
 * removed worktree (owner pairs, not ids, decide ownership), then synthetic
 * owners. Row counts are synthetic, not usage data.
 */
export function buildCodeReviewRegistryFixture({
  workspaceId,
  keepWorktreeId,
  removedWorktreeIds,
  matchingRows,
  unrelatedRows,
}) {
  positiveInteger(matchingRows, 'matchingRows');
  positiveInteger(unrelatedRows, 'unrelatedRows');
  const targets = {};
  const unrelatedKeys = [];
  const add = (key, ref) => {
    if (Object.hasOwn(targets, key))
      throw new Error(`Duplicate registry fixture key ${key}`);
    targets[key] = ref;
    return key;
  };
  const addUnrelated = (key, ref) => {
    if (unrelatedKeys.length < unrelatedRows) unrelatedKeys.push(add(key, ref));
  };
  const keepKey = `${workspaceId}--${keepWorktreeId}`;
  addUnrelated(keepKey, { projectId: workspaceId, worktreeId: keepWorktreeId });
  for (const worktreeId of removedWorktreeIds)
    addUnrelated(`${OTHER_PROJECT_ID}--${worktreeId}`, {
      projectId: OTHER_PROJECT_ID,
      worktreeId,
    });
  for (let index = 1; unrelatedKeys.length < unrelatedRows; index += 1)
    addUnrelated(`perf-unrelated-${index}--wt-${index}`, {
      projectId: `perf-unrelated-${index}`,
      worktreeId: `wt-${index}`,
    });
  const matchingKeys = {};
  for (const worktreeId of removedWorktreeIds) {
    matchingKeys[worktreeId] = [];
    for (let index = 0; index < matchingRows; index += 1)
      matchingKeys[worktreeId].push(
        add(
          index === 0
            ? `${workspaceId}--${worktreeId}`
            : `${workspaceId}--${worktreeId}--legacy-${index}`,
          { projectId: workspaceId, worktreeId },
        ),
      );
  }
  return {
    file: { version: 1, targets },
    keepKey,
    matchingKeys,
    unrelatedKeys,
  };
}

/** Registry bytes as production writes them (two-space JSON, no newline). */
export function serializeRegistry(file) {
  return JSON.stringify(file, null, 2);
}

function legacyTabsFile(chatId) {
  return {
    version: 1,
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Legacy review chat',
        providerType: 'claude',
        interfaceMode: 'canopy',
        thinkingLevel: 'off',
        createdAt: '2026-09-01T12:00:00.000Z',
        messages: [
          {
            id: `${chatId}-user`,
            role: 'user',
            blocks: [{ type: 'text', text: 'Review the retry change.' }],
            timestamp: FIXED_CREATED_AT_MS,
          },
          {
            id: `${chatId}-assistant`,
            role: 'assistant',
            blocks: [{ type: 'text', text: 'The retry change looks correct.' }],
            timestamp: FIXED_CREATED_AT_MS + 5_000,
          },
        ],
      },
    ],
  };
}

/** Refuses any path that is not strictly inside `root` after resolution. */
export function assertInsideRoot(root, candidate, label) {
  const resolvedRoot = realpathSync(root);
  const parent = realpathSync(path.dirname(candidate));
  const resolved = path.join(parent, path.basename(candidate));
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`${label} ${candidate} is outside ${resolvedRoot}`);
  return resolved;
}

function runGit(repoPath, args) {
  execFileSync('git', args, { cwd: repoPath, stdio: 'ignore' });
}

function seedPreferences(userDataDir) {
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          onboardingCompleted: ['v1'],
          defaultWorktreeProvider: 'claude',
        },
      },
      null,
      2,
    )}\n`,
  );
}

export function prepareCodeReviewRegistry(userDataDir, config) {
  const deleteCycles = positiveInteger(
    config.codeReviewRegistryDeleteCycles,
    'codeReviewRegistryDeleteCycles',
  );
  const missingDeletes = positiveInteger(
    config.codeReviewRegistryMissingDeletes,
    'codeReviewRegistryMissingDeletes',
  );
  positiveInteger(
    config.codeReviewRegistryRegisterIterations,
    'codeReviewRegistryRegisterIterations',
  );
  const seeded = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  const workspace = seeded.workspaces[0];
  if (!workspace?.id || !workspace.name || !workspace.repoPath)
    throw new Error('The demo seed returned no named workspace and repository');
  const workspaceRoot = assertInsideRoot(
    userDataDir,
    path.join(userDataDir, 'workspaces', workspace.id),
    'Workspace root',
  );
  const worktreesPath = path.join(workspaceRoot, 'worktrees.json');
  const worktrees = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  const keep = worktrees.worktrees[0];
  if (!keep) throw new Error('The demo workspace seeded no worktree');
  const deleteIds = Array.from(
    { length: deleteCycles },
    (_, index) => `crr-delete-${index + 1}`,
  );
  const missingIds = Array.from(
    { length: missingDeletes },
    (_, index) => `crr-missing-${index + 1}`,
  );
  const worktreesDir = path.join(workspaceRoot, 'worktrees');
  [...deleteIds, ...missingIds].forEach((id, index) => {
    const checkout = path.join(worktreesDir, id);
    runGit(workspace.repoPath, [
      'worktree',
      'add',
      '-b',
      `perf/${id}`,
      checkout,
    ]);
    worktrees.worktrees.push({
      ...keep,
      id,
      branchName: `perf/${id}`,
      createdAt: new Date(FIXED_CREATED_AT_MS + index * 1_000).toISOString(),
    });
  });
  writeFileSync(worktreesPath, JSON.stringify(worktrees, null, 2));
  // Every checkout exists at launch. Boot recovery archives a row whose
  // checkout is already gone, so the missing route deletes its checkout only
  // once the app is up (`removeMissingCheckout`).

  const registry = buildCodeReviewRegistryFixture({
    workspaceId: workspace.id,
    keepWorktreeId: keep.id,
    removedWorktreeIds: [...deleteIds, ...missingIds],
    matchingRows: config.codeReviewRegistryMatchingRows,
    unrelatedRows: config.codeReviewRegistryUnrelatedRows,
  });
  const registryDir = codeReviewRegistryDir(userDataDir);
  mkdirSync(registryDir, { recursive: true });
  assertInsideRoot(userDataDir, registryDir, 'Registry directory');
  const registryPath = codeReviewRegistryPath(userDataDir);
  const seededRegistryText = serializeRegistry(registry.file);
  writeFileSync(registryPath, seededRegistryText, 'utf8');
  // Each removed row had a review chat; the kept row's chat must survive.
  const legacyTabKeys = [
    registry.keepKey,
    ...Object.values(registry.matchingKeys).flat(),
  ];
  legacyTabKeys.forEach((key, index) =>
    writeFileSync(
      path.join(registryDir, `${key}.json`),
      JSON.stringify(legacyTabsFile(`crr-review-chat-${index + 1}`)),
    ),
  );
  return {
    userDataDir,
    workspace: { id: workspace.id, name: workspace.name },
    workspaceRoot,
    worktreesPath,
    worktreesDir,
    keepWorktreeId: keep.id,
    deleteIds,
    missingIds,
    registryDir,
    registryPath,
    seededRegistryText,
    registry,
  };
}

function missingCheckoutPath(fixture, id) {
  if (!fixture.missingIds.includes(id))
    throw new Error(`${id} is not a missing-checkout worktree`);
  const checkout = assertInsideRoot(
    fixture.userDataDir,
    path.join(fixture.worktreesDir, id),
    'Missing checkout',
  );
  if (path.dirname(checkout) !== realpathSync(fixture.worktreesDir))
    throw new Error(`Refusing to remove ${checkout}`);
  return checkout;
}

/** Fails when a missing-route checkout is already gone before the run. */
export function assertMissingCheckoutsPresent(fixture) {
  const gone = fixture.missingIds.filter(
    (id) => !existsSync(missingCheckoutPath(fixture, id)),
  );
  if (gone.length > 0)
    throw new Error(
      `The ${gone.join(', ')} checkout(s) were gone at launch; boot recovery archives such rows, so they must be removed while the app runs`,
    );
}

/**
 * Deletes one missing-route checkout outside the app, as in the CAN-3039
 * report. Call it only after the app has shown the row healthy.
 */
export function removeMissingCheckout(fixture, id) {
  const checkout = missingCheckoutPath(fixture, id);
  if (!existsSync(checkout))
    throw new Error(`The ${id} checkout was removed before its own route`);
  rmSync(checkout, { recursive: true, force: true });
  if (existsSync(checkout))
    throw new Error(`The ${id} checkout could not be removed`);
}

export function readRegistry(registryPath) {
  const text = readFileSync(registryPath, 'utf8');
  const file = JSON.parse(text);
  if (
    file?.version !== 1 ||
    typeof file.targets !== 'object' ||
    file.targets === null ||
    Array.isArray(file.targets)
  )
    throw new Error(`Registry ${registryPath} is not a version 1 registry`);
  return { text, file, mtimeMs: statSync(registryPath).mtimeMs };
}

/** Throws with a bounded key-level diff when the rows differ. */
export function assertRegistryTargets(actual, expected, label) {
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(actual, key));
  const extra = actualKeys.filter((key) => !Object.hasOwn(expected, key));
  const changed = expectedKeys.filter(
    (key) =>
      Object.hasOwn(actual, key) &&
      JSON.stringify(actual[key]) !== JSON.stringify(expected[key]),
  );
  if (missing.length || extra.length || changed.length)
    throw new Error(
      `${label}: registry rows differ (missing ${missing.length}: ${missing.slice(0, 5).join(', ')}; extra ${extra.length}: ${extra.slice(0, 5).join(', ')}; changed ${changed.length}: ${changed.slice(0, 5).join(', ')})`,
    );
}

export function withoutKeys(targets, keys) {
  const removed = new Set(keys);
  return Object.fromEntries(
    Object.entries(targets).filter(([key]) => !removed.has(key)),
  );
}

function registryTemps(registryDir) {
  return readdirSync(registryDir).filter((name) =>
    REGISTRY_TEMP_PATTERN.test(name),
  );
}

function assertNoRegistryTemps(registryDir, label) {
  const temps = registryTemps(registryDir);
  if (temps.length > 0)
    throw new Error(`${label}: left registry temp files ${temps.join(', ')}`);
}

const round = (value) => Math.round(value * 1_000) / 1_000;

function intervalUnion(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current = null;
  for (const [start, end] of sorted) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else current[1] = Math.max(current[1], end);
  }
  if (current) total += current[1] - current[0];
  return total;
}

const OP_FIELDS = Object.freeze({
  read: 'readMs',
  mkdir: 'mkdirMs',
  'plain-write': 'plainWriteMs',
  'temp-open': 'tempOpenMs',
  'temp-write': 'tempWriteMs',
  'file-fsync': 'fileFsyncMs',
  'temp-close': 'tempCloseMs',
  'temp-unlink': 'tempUnlinkMs',
  rename: 'renameMs',
  'dir-open': 'dirOpenMs',
  'dir-fsync': 'dirFsyncMs',
  'dir-close': 'dirCloseMs',
});
const INSTALL_OPS = new Set(['plain-write', 'rename']);
const WRITE_START_OPS = new Set(['plain-write', 'temp-open']);
const SYNC_LOOKUP_OPS = new Set(['stat-sync', 'read-sync']);

function firstDirEvent(dirEvents, claimed, op, from, until) {
  return dirEvents.find(
    (event) =>
      !claimed.has(event) &&
      event.op === op &&
      event.startedAt >= from &&
      event.endedAt <= until,
  );
}

/**
 * Attributes traced registry I/O to one main IPC handler window. A registry
 * access starts at a registry read and owns the registry-file events up to
 * the next read. The registry directory is shared with review-chat writers,
 * so a directory event is claimed only in the registry's own sequence: the
 * `mkdir` between the read and the first write, and the open, sync and close
 * right after the rename. Other directory events are reported unattributed;
 * one that starts inside a claimed flush makes the claim ambiguous.
 * `registrySpanMs` runs from each access's read to its last claimed event, so
 * its non-I/O part is parse, serialize and queue hops; handler time outside
 * the spans is the rest of the cleanup. With sequential accesses the parts
 * add up: handler = non-registry + registry non-I/O + read + mkdir + write
 * install + durable flush, where the flush is the file fsync plus the
 * directory open, fsync and close that only a durable write performs.
 */
export function attributeRegistryWindow(events, window) {
  const inWindow = events
    .filter(
      (event) =>
        event.startedAt >= window.startedAt &&
        event.startedAt <= window.endedAt,
    )
    .sort((a, b) => a.startedAt - b.startedAt);
  const dirEvents = inWindow.filter((event) => event.kind === 'dir');
  const accesses = [];
  let current = null;
  for (const event of inWindow) {
    if (event.kind === 'dir' || SYNC_LOOKUP_OPS.has(event.op)) continue;
    if (event.op === 'read' || !current) {
      current = { events: [], orphan: event.op !== 'read' };
      accesses.push(current);
    }
    current.events.push(event);
  }
  const claimed = new Set();
  const flushSpans = [];
  accesses.forEach((access, index) => {
    const until = accesses[index + 1]?.events[0].startedAt ?? window.endedAt;
    const read = access.events[0];
    const writeStart = access.events.find((event) =>
      WRITE_START_OPS.has(event.op),
    );
    const claim = (event) => {
      if (!event) return null;
      claimed.add(event);
      access.events.push(event);
      return event;
    };
    if (writeStart)
      claim(
        firstDirEvent(
          dirEvents,
          claimed,
          'mkdir',
          read.endedAt,
          writeStart.startedAt,
        ),
      );
    const rename = access.events.find((event) => event.op === 'rename');
    if (!rename) return;
    const open = claim(
      firstDirEvent(dirEvents, claimed, 'dir-open', rename.endedAt, until),
    );
    if (!open) return;
    const sync = claim(
      firstDirEvent(dirEvents, claimed, 'dir-fsync', open.endedAt, until),
    );
    const close = claim(
      firstDirEvent(
        dirEvents,
        claimed,
        'dir-close',
        (sync ?? open).endedAt,
        until,
      ),
    );
    flushSpans.push([rename.endedAt, (close ?? sync ?? open).endedAt]);
  });
  const totals = Object.fromEntries(
    Object.values(OP_FIELDS).map((field) => [field, 0]),
  );
  for (const access of accesses)
    for (const event of access.events) {
      const field = OP_FIELDS[event.op];
      if (field) totals[field] += event.ms;
    }
  const unattributed = dirEvents.filter((event) => !claimed.has(event));
  const unattributedDirMs = unattributed.reduce(
    (sum, event) => sum + event.ms,
    0,
  );
  // A foreign directory event inside the registry's own flush could have been
  // claimed in place of the registry's; the split is then unknown.
  const ambiguousDirEvents = unattributed.filter((event) =>
    flushSpans.some(
      ([start, end]) => event.startedAt >= start && event.startedAt <= end,
    ),
  ).length;
  const syncLookupMs = inWindow
    .filter((event) => SYNC_LOOKUP_OPS.has(event.op))
    .reduce((sum, event) => sum + event.ms, 0);
  const span = (access) =>
    Math.max(...access.events.map((event) => event.endedAt)) -
    access.events[0].startedAt;
  const registrySpanMs = accesses.reduce(
    (sum, access) => sum + span(access),
    0,
  );
  const registryIoMs = accesses.reduce(
    (sum, access) =>
      sum +
      intervalUnion(
        access.events.map((event) => [event.startedAt, event.endedAt]),
      ),
    0,
  );
  const handlerMs = window.endedAt - window.startedAt;
  const dirSyncTotalMs =
    totals.dirOpenMs + totals.dirFsyncMs + totals.dirCloseMs;
  const result = {
    handlerMs,
    registrySpanMs,
    registryIoMs,
    registryNonIoMs: registrySpanMs - registryIoMs,
    nonRegistryHandlerMs: handlerMs - registrySpanMs,
    durableFlushMs: totals.fileFsyncMs + dirSyncTotalMs,
    dirSyncTotalMs,
    writeInstallMs:
      totals.plainWriteMs +
      totals.tempOpenMs +
      totals.tempWriteMs +
      totals.tempCloseMs +
      totals.tempUnlinkMs +
      totals.renameMs,
    ...totals,
    syncLookupMs,
    unattributedDirMs,
  };
  return {
    ...Object.fromEntries(
      Object.entries(result).map(([key, value]) => [key, round(value)]),
    ),
    reads: inWindow.filter((event) => event.op === 'read').length,
    mutations: accesses.filter((access) =>
      access.events.some((event) => INSTALL_OPS.has(event.op)),
    ).length,
    orphanAccesses: accesses.filter((access) => access.orphan).length,
    unattributedDirEvents: unattributed.length,
    ambiguousDirEvents,
    syncLookups: inWindow.filter((event) => SYNC_LOOKUP_OPS.has(event.op))
      .length,
    errors: accesses
      .flatMap((access) => access.events)
      .filter((event) => event.error).length,
  };
}

const TRACE_TIMING_FIELDS = Object.freeze([
  ['handlerMs', 'handler'],
  ['registrySpanMs', 'registry_span'],
  ['registryIoMs', 'registry_io'],
  ['registryNonIoMs', 'registry_non_io'],
  ['nonRegistryHandlerMs', 'non_registry_handler'],
  ['durableFlushMs', 'durable_flush'],
  ['fileFsyncMs', 'file_fsync'],
  ['dirSyncTotalMs', 'dir_sync_total'],
  ['writeInstallMs', 'write_install'],
  ['readMs', 'read'],
  ['mkdirMs', 'mkdir'],
  ['syncLookupMs', 'sync_lookup'],
]);

/**
 * Registry file events outside every probed handler window, sync lookups
 * excluded. A write there means a cleanup the routes did not account for,
 * such as a duplicate external-snapshot cleanup, ran during the workload.
 */
export function registryEventsOutsideWindows(events, windows) {
  const outside = events.filter(
    (event) =>
      event.kind !== 'dir' &&
      !SYNC_LOOKUP_OPS.has(event.op) &&
      !windows.some(
        (window) =>
          event.startedAt >= window.startedAt &&
          event.startedAt <= (window.endedAt ?? Infinity),
      ),
  );
  return {
    reads: outside.filter((event) => event.op === 'read').length,
    writes: outside.filter((event) => INSTALL_OPS.has(event.op)).length,
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Per-launch medians as `<route>_<field>_ms` timing entries. */
export function traceTimings(attributionsByRoute) {
  const timings = {};
  for (const [route, attributions] of Object.entries(attributionsByRoute)) {
    for (const [field, name] of TRACE_TIMING_FIELDS) {
      const value = median(attributions.map((entry) => entry[field]));
      if (value !== null) timings[`${route}_${name}_ms`] = round(value);
    }
  }
  return timings;
}

/**
 * Installs pass-through wrappers on the probed IPC handlers (both arms; one
 * closure per call) and, for the trace arm only, on the fs functions the
 * registry uses, recording just calls whose path is in the registry
 * directory. Nothing is mocked: every wrapper calls the original. Runs in
 * Electron main through `evaluate`, so it uses only its arguments and globals.
 */
export function codeReviewRegistryProbeMain({ ipcMain }, options) {
  if (globalThis[options.probeGlobal])
    throw new Error('The code review registry probe is already installed');
  const now = () => performance.timeOrigin + performance.now();
  // `waiters` are in-main completion callbacks, so the driver never polls
  // main while a measured handler runs.
  const probe = { ipc: [], events: [], missing: [], waiters: new Set() };
  globalThis[options.probeGlobal] = probe;
  const handlers = ipcMain._invokeHandlers;
  for (const channel of options.channels) {
    const original = handlers?.get(channel);
    if (typeof original !== 'function')
      throw new Error(`Missing IPC handler ${channel}`);
    handlers.set(channel, async (event, ...args) => {
      const request = args[0];
      const entry = {
        channel,
        target:
          (channel === options.purgeChannel
            ? request?.containerId
            : request?.worktreeId) ?? null,
        startedAt: now(),
        endedAt: null,
        ok: null,
      };
      probe.ipc.push(entry);
      try {
        const result = await original(event, ...args);
        entry.ok = true;
        return result;
      } catch (error) {
        entry.ok = false;
        entry.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        entry.endedAt = now();
        for (const waiter of [...probe.waiters]) waiter();
      }
    });
  }
  if (!options.fsTrace) return { fsTrace: false, missing: [] };

  const fsp = process.getBuiltinModule('node:fs/promises');
  const fs = process.getBuiltinModule('node:fs');
  const nodePath = process.getBuiltinModule('node:path');
  const marker = `${nodePath.sep}${options.dirSegments.join(nodePath.sep)}`;
  const toText = (value) =>
    typeof value === 'string'
      ? value
      : value instanceof URL
        ? value.pathname
        : Buffer.isBuffer(value)
          ? value.toString()
          : null;
  const classify = (value) => {
    const text = toText(value);
    if (!text) return null;
    const normalized = nodePath.normalize(text).replace(/[\\/]+$/, '');
    if (normalized.endsWith(marker)) return 'dir';
    if (!nodePath.dirname(normalized).endsWith(marker)) return null;
    const base = nodePath.basename(normalized);
    if (base === options.registryFile) return 'registry';
    if (base.startsWith(`.${options.registryFile}.`) && base.endsWith('.tmp'))
      return 'registry-temp';
    return null;
  };
  const record = (op, kind, startedAt, error) => {
    const endedAt = now();
    probe.events.push({
      op,
      kind,
      startedAt,
      endedAt,
      ms: endedAt - startedAt,
      ...(error ? { error: String(error.code ?? error) } : {}),
    });
  };
  const timed = (op, kind, call) => {
    const startedAt = now();
    let pending;
    try {
      pending = call();
    } catch (error) {
      record(op, kind, startedAt, error);
      throw error;
    }
    return Promise.resolve(pending).then(
      (value) => {
        record(op, kind, startedAt);
        return value;
      },
      (error) => {
        record(op, kind, startedAt, error);
        throw error;
      },
    );
  };
  const wrapAsync = (name, op, pathIndex, kinds) => {
    const original = fsp[name];
    if (typeof original !== 'function') {
      probe.missing.push(`fs/promises.${name}`);
      return;
    }
    fsp[name] = function codeReviewRegistryTraced(...args) {
      const kind = classify(args[pathIndex]);
      if (!kind || !kinds.includes(kind))
        return Reflect.apply(original, this, args);
      return timed(op, kind, () => Reflect.apply(original, this, args));
    };
  };
  wrapAsync('readFile', 'read', 0, ['registry']);
  wrapAsync('writeFile', 'plain-write', 0, ['registry']);
  wrapAsync('mkdir', 'mkdir', 0, ['dir']);
  wrapAsync('rename', 'rename', 1, ['registry']);
  wrapAsync('unlink', 'temp-unlink', 0, ['registry-temp']);
  const originalOpen = fsp.open;
  if (typeof originalOpen !== 'function')
    probe.missing.push('fs/promises.open');
  else
    fsp.open = function codeReviewRegistryTracedOpen(...args) {
      const kind = classify(args[0]);
      if (kind !== 'registry-temp' && kind !== 'dir')
        return Reflect.apply(originalOpen, this, args);
      const dir = kind === 'dir';
      return timed(dir ? 'dir-open' : 'temp-open', kind, () =>
        Reflect.apply(originalOpen, this, args),
      ).then((handle) => {
        const methods = dir
          ? [
              ['sync', 'dir-fsync'],
              ['close', 'dir-close'],
            ]
          : [
              ['writeFile', 'temp-write'],
              ['sync', 'file-fsync'],
              ['close', 'temp-close'],
            ];
        for (const [method, op] of methods) {
          const original = handle[method];
          if (typeof original !== 'function') {
            probe.missing.push(`FileHandle.${method}`);
            continue;
          }
          handle[method] = (...methodArgs) =>
            timed(op, kind, () => Reflect.apply(original, handle, methodArgs));
        }
        return handle;
      });
    };
  for (const [name, op] of [
    ['statSync', 'stat-sync'],
    ['readFileSync', 'read-sync'],
  ]) {
    const original = fs[name];
    if (typeof original !== 'function') {
      probe.missing.push(`fs.${name}`);
      continue;
    }
    fs[name] = function codeReviewRegistryTracedSync(...args) {
      if (classify(args[0]) !== 'registry')
        return Reflect.apply(original, this, args);
      const startedAt = now();
      try {
        const value = Reflect.apply(original, this, args);
        record(op, 'registry', startedAt);
        return value;
      } catch (error) {
        record(op, 'registry', startedAt, error);
        throw error;
      }
    };
  }
  return { fsTrace: true, missing: probe.missing };
}

/** Options for `codeReviewRegistryProbeMain`, which runs in Electron main. */
export function registryProbeOptions(fsTrace) {
  return {
    fsTrace,
    probeGlobal: PROBE_GLOBAL,
    channels: Object.values(PROBED_IPC_CHANNELS),
    purgeChannel: PROBED_IPC_CHANNELS.purge,
    dirSegments: REGISTRY_DIR_SEGMENTS,
    registryFile: REGISTRY_FILE,
  };
}

function installRegistryProbe(electronApp, { fsTrace }) {
  return electronApp.evaluate(
    codeReviewRegistryProbeMain,
    registryProbeOptions(fsTrace),
  );
}

/** Probe records, optionally only the fs events that start in one window. */
function readProbe(electronApp, window = null) {
  return electronApp.evaluate(
    (_electron, { probeGlobal, window }) => {
      const probe = globalThis[probeGlobal];
      return {
        ipc: probe.ipc,
        events: window
          ? probe.events.filter(
              (event) =>
                event.startedAt >= window.startedAt &&
                event.startedAt <= window.endedAt,
            )
          : probe.events,
      };
    },
    { probeGlobal: PROBE_GLOBAL, window },
  );
}

/**
 * Runs in Electron main: resolves with the one ended entry for a channel and
 * target, woken by the probe's own handler wrapper rather than by polling.
 * A second call for the same target fails instead of being ignored.
 */
export function waitForProbedHandlerMain(
  _electron,
  { probeGlobal, channel, target, timeoutMs },
) {
  const probe = globalThis[probeGlobal];
  return new Promise((resolve, reject) => {
    let timer = null;
    const settle = () => {
      const entries = probe.ipc.filter(
        (entry) => entry.channel === channel && entry.target === target,
      );
      if (entries.length > 1)
        reject(
          new Error(`${channel} ran ${entries.length} times for ${target}`),
        );
      else if (entries.length === 1 && entries[0].endedAt !== null)
        resolve({ ...entries[0] });
      else return false;
      if (timer) clearTimeout(timer);
      probe.waiters.delete(settle);
      return true;
    };
    if (settle()) return;
    probe.waiters.add(settle);
    timer = setTimeout(() => {
      probe.waiters.delete(settle);
      reject(
        new Error(`${channel} for ${target} did not finish in ${timeoutMs} ms`),
      );
    }, timeoutMs);
  });
}

/** The single ended handler entry for one channel and target. */
async function waitForHandler(electronApp, channel, target, timeoutMs) {
  const entry = await electronApp.evaluate(waitForProbedHandlerMain, {
    probeGlobal: PROBE_GLOBAL,
    channel,
    target,
    timeoutMs,
  });
  if (!entry.ok)
    throw new Error(`${channel} for ${target} failed: ${entry.error}`);
  return entry;
}

/**
 * Renderer-clock timer: the committing click's pointer-down event time to
 * the frame after `goneSelector` leaves the DOM. Pointer-down, because menu
 * items may act before or without a click event. `rearm` restarts it before
 * a confirmation click so only the committing click counts.
 */
async function armRemovalTimer(page, label, goneSelector) {
  await page.evaluate(
    ({ timerGlobal, label, goneSelector }) => {
      const timers = (window[timerGlobal] ??= {});
      const state = { clickAt: null, goneAt: null, paintAt: null };
      const onPointerDown = (event) => {
        if (state.clickAt === null) state.clickAt = event.timeStamp;
      };
      const observer = new MutationObserver(() => {
        if (state.clickAt === null || state.goneAt !== null) return;
        if (document.querySelector(goneSelector)) return;
        state.goneAt = performance.now();
        observer.disconnect();
        document.removeEventListener('pointerdown', onPointerDown, true);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            state.paintAt = performance.now();
          }),
        );
      });
      document.addEventListener('pointerdown', onPointerDown, true);
      // Only the attributes the selector reads, so unrelated renders do not
      // run the check.
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributeFilter: ['data-testid', 'data-worktree-id'],
      });
      state.rearm = () => {
        state.clickAt = null;
      };
      timers[label] = state;
    },
    { timerGlobal: TIMER_GLOBAL, label, goneSelector },
  );
}

function rearmRemovalTimer(page, label) {
  return page.evaluate(
    ({ timerGlobal, label }) => window[timerGlobal][label].rearm(),
    { timerGlobal: TIMER_GLOBAL, label },
  );
}

async function readRemovalTimer(page, label, timeoutMs) {
  await page.waitForFunction(
    ({ timerGlobal, label }) => window[timerGlobal]?.[label]?.paintAt != null,
    { timerGlobal: TIMER_GLOBAL, label },
    { timeout: timeoutMs },
  );
  const state = await page.evaluate(
    ({ timerGlobal, label }) => {
      const { clickAt, goneAt, paintAt } = window[timerGlobal][label];
      return { clickAt, goneAt, paintAt, timeOrigin: performance.timeOrigin };
    },
    { timerGlobal: TIMER_GLOBAL, label },
  );
  if (state.clickAt === null)
    throw new Error(`${label}: no committing pointer-down was observed`);
  return {
    paintConfirmedMs: round(state.paintAt - state.clickAt),
    domRemovedMs: round(state.goneAt - state.clickAt),
    // Epoch clock, comparable with main's handler entries.
    clickEpochMs: state.timeOrigin + state.clickAt,
    paintEpochMs: state.timeOrigin + state.paintAt,
  };
}

/**
 * Runs in the renderer: back-to-back preferences IPC while an operation
 * runs. `active` is the round trip in flight, so a stop can wait for it.
 */
export function startMainPingRenderer(pingGlobal) {
  const ping = { samples: [], errors: [], stopped: false, active: null };
  globalThis[pingGlobal] = ping;
  void (async () => {
    while (!ping.stopped) {
      const startedAt = performance.now();
      ping.active = new Promise((resolve) =>
        resolve(globalThis.api.loadPreferences()),
      ).then(
        () => {
          ping.samples.push({
            startedAt: performance.timeOrigin + startedAt,
            ms: performance.now() - startedAt,
          });
        },
        (error) => {
          ping.errors.push(String(error?.message ?? error));
        },
      );
      await ping.active;
      ping.active = null;
      if (ping.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  })();
}

/**
 * Runs in the renderer: starts no further round trips, then waits for the
 * one in flight, which is the slowest when main was blocked at the end.
 * One that never settles fails the measurement instead of being dropped.
 */
export async function stopMainPingRenderer({ pingGlobal, timeoutMs }) {
  const ping = globalThis[pingGlobal];
  ping.stopped = true;
  if (ping.active) {
    let timer = null;
    const settled = await Promise.race([
      ping.active.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!settled)
      throw new Error(`A main IPC ping did not settle in ${timeoutMs} ms`);
  }
  return { samples: [...ping.samples], errors: [...ping.errors] };
}

function startMainPing(page) {
  return page.evaluate(startMainPingRenderer, PING_GLOBAL);
}

/**
 * Stops the ping and keeps the round trips that started inside the
 * operation, from the committing pointer-down to its completion (epoch ms).
 */
async function stopMainPing(page, route, operation) {
  const { samples, errors } = await page.evaluate(stopMainPingRenderer, {
    pingGlobal: PING_GLOBAL,
    timeoutMs: HANDLER_TIMEOUT_MS,
  });
  if (errors.length > 0)
    throw new Error(
      `The ${route} main IPC ping failed ${errors.length} time(s): ${errors[0]}`,
    );
  return samples
    .filter(
      (sample) =>
        sample.startedAt >= operation.fromEpochMs &&
        sample.startedAt <= operation.toEpochMs,
    )
    .map((sample) => sample.ms);
}

function percentileOf(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
  ];
}

function pushMeasuredTask(tasks, kind, durationMs, metadata = {}) {
  tasks.push({ kind, status: 'ok', durationMs, ...metadata });
}

function sidebarRow(page, worktreeId) {
  return page
    .getByTestId('app-sidebar')
    .locator(`[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`)
    .first();
}

function rowSelector(worktreeId) {
  return `[data-testid="app-sidebar"] [data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function expandWorkspace(page, workspace) {
  const header = page
    .getByTestId('app-sidebar')
    .locator(`[data-sidebar-workspace-id="${workspace.id}"]`)
    .first()
    .getByRole('button', {
      name: new RegExp(`^(?:Expand|Collapse) ${escapeRegExp(workspace.name)}$`),
    })
    .first();
  await expect(header).toBeVisible({ timeout: 30_000 });
  if ((await header.getAttribute('aria-label')) === `Expand ${workspace.name}`)
    await header.click();
}

/**
 * Removal toasts stay until dismissed and can cover the Archived viewer's
 * header actions; dismiss them through their own control, as
 * archived-containers.spec.mjs does, before any timer is armed.
 */
async function dismissToasts(page) {
  const dismiss = page.locator('[data-testid="toast-dismiss"]:visible');
  while ((await dismiss.count()) > 0) {
    try {
      await dismiss.first().click({ timeout: 2_000 });
    } catch (error) {
      // A toast may expire during its exit animation; only that is accepted.
      if ((await dismiss.count()) > 0) throw error;
    }
  }
}

async function returnToKeptWorktree(app, page, fixture) {
  await app.openMainPage();
  await expandWorkspace(page, fixture.workspace);
  await app.selectWorktree(fixture.keepWorktreeId, {
    expandDefaultActivityRail: false,
  });
}

/**
 * Opens the row menu and chooses Delete. Returns once the removal has been
 * committed: by the menu item when no confirmation is needed, otherwise by
 * the dialog's action. The timer counts only the committing click.
 */
async function deleteFromSidebar(page, worktreeId, timerLabel) {
  const row = sidebarRow(page, worktreeId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  const menuItem = page.getByTestId('worktree-actions-menu-delete');
  await expect(menuItem).toBeVisible();
  await armRemovalTimer(page, timerLabel, rowSelector(worktreeId));
  await menuItem.click();
  const dialog = page.getByRole('dialog', { name: /^Delete worktree/ });
  await expect
    .poll(async () => (await dialog.isVisible()) || (await row.count()) === 0, {
      timeout: 30_000,
      intervals: [10],
    })
    .toBe(true);
  const confirmDialogShown = await dialog.isVisible();
  if (confirmDialogShown) {
    await rearmRemovalTimer(page, timerLabel);
    // The action's test id names its branch outcome, so this finds it only
    // while the switch keeps the local branch (its default), as in
    // archive-missing-worktree-chat.spec.mjs.
    await dialog.getByTestId('worktree-removal-preserve-branch').click();
  }
  return { confirmDialogShown };
}

function readWorktreeIds(worktreesPath) {
  return JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees.map(
    (worktree) => worktree.id,
  );
}

function containerManifestPath(fixture, worktreeId) {
  return path.join(
    fixture.workspaceRoot,
    'archived-containers',
    worktreeId,
    'container.json',
  );
}

function assertTraceShape(route, attribution, expectedMutations) {
  if (attribution.mutations !== expectedMutations)
    throw new Error(
      `The registry trace saw ${attribution.mutations} mutations for ${route}; expected ${expectedMutations}. Attribution is unavailable for this bundle.`,
    );
  if (attribution.orphanAccesses > 0 || attribution.errors > 0)
    throw new Error(
      `The registry trace for ${route} has ${attribution.orphanAccesses} unattributed accesses and ${attribution.errors} failed calls`,
    );
  if (attribution.ambiguousDirEvents > 0)
    throw new Error(
      `The registry trace for ${route} saw ${attribution.ambiguousDirEvents} foreign directory event(s) inside a registry flush; its flush attribution is ambiguous`,
    );
}

const HANDLER_TIMEOUT_MS = 120_000;

/** Run state shared by the route steps of one launch. */
function createRun({ page, app, electronApp, tasks, fixture }, trace) {
  return {
    page,
    app,
    electronApp,
    tasks,
    fixture,
    trace,
    expected: { ...fixture.registry.file.targets },
    handlerMs: {
      register: [],
      delete_retained: [],
      purge: [],
      missing_delete: [],
    },
    traceAttributions: { register: [], purge: [], missing_delete: [] },
    pings: { purge: [], missing_delete: [] },
    // Which click committed each sidebar removal; the bypass depends on
    // diff stats having loaded, so both arms report the paths they took.
    confirmDialogs: {
      delete_retained: { shown: 0, skipped: 0 },
      missing_delete: { shown: 0, skipped: 0 },
    },
  };
}

function countConfirmDialog(run, route, shown) {
  run.confirmDialogs[route][shown ? 'shown' : 'skipped'] += 1;
}

/** Fails when a route's rows were removed before its own operation ran. */
function assertRowsPresent(run, id, label) {
  const { targets } = readRegistry(run.fixture.registryPath).file;
  const missing = run.fixture.registry.matchingKeys[id].filter(
    (key) => !Object.hasOwn(targets, key),
  );
  if (missing.length > 0)
    throw new Error(
      `${label}: ${missing.length} of ${id}'s rows were removed before its own operation (${missing.join(', ')}); a background cleanup ran first`,
    );
  assertRegistryNow(run, label);
}

/**
 * The traced arm's attribution of one handler window. `expectedMutations`
 * null marks the retained-delete control, which must not write the registry.
 */
async function attributeHandler(run, route, entry, expectedMutations) {
  if (!run.trace) return {};
  const { events } = await readProbe(run.electronApp, entry);
  const registryTrace = attributeRegistryWindow(events, entry);
  if (expectedMutations !== null)
    assertTraceShape(route, registryTrace, expectedMutations);
  else if (registryTrace.mutations > 0)
    throw new Error(
      `The ${route} control wrote the registry ${registryTrace.mutations} time(s)`,
    );
  run.traceAttributions[route]?.push(registryTrace);
  return { registryTrace };
}

function assertRegistryNow(run, label) {
  assertRegistryTargets(
    readRegistry(run.fixture.registryPath).file.targets,
    run.expected,
    label,
  );
}

function handlerDuration(entry) {
  return round(entry.endedAt - entry.startedAt);
}

/** Retained register IPC: sequential awaited calls, as its handler awaits. */
async function measureRegister(run, iterations) {
  const { page, fixture, tasks } = run;
  const requests = Array.from({ length: iterations }, (_, index) => ({
    projectId: fixture.workspace.id,
    worktreeId: `crr-register-${index + 1}`,
  }));
  const roundTrips = await page.evaluate(async (list) => {
    if (typeof window.api?.codeReview?.registerTarget !== 'function')
      throw new Error('window.api.codeReview.registerTarget is unavailable');
    const durations = [];
    for (const request of list) {
      const startedAt = performance.now();
      await window.api.codeReview.registerTarget(request);
      durations.push(performance.now() - startedAt);
    }
    return durations;
  }, requests);
  for (const [index, request] of requests.entries()) {
    const entry = await waitForHandler(
      run.electronApp,
      PROBED_IPC_CHANNELS.register,
      request.worktreeId,
      HANDLER_TIMEOUT_MS,
    );
    const handlerMs = handlerDuration(entry);
    const traced = await attributeHandler(run, 'register', entry, 1);
    pushMeasuredTask(
      tasks,
      'register_ipc_round_trip',
      round(roundTrips[index]),
      {
        iteration: index + 1,
        clock: 'renderer',
        mainHandlerMs: handlerMs,
        ...traced,
      },
    );
    pushMeasuredTask(tasks, 'register_main_handler', handlerMs, {
      iteration: index + 1,
      clock: 'main',
    });
    run.handlerMs.register.push(handlerMs);
    run.expected[`${request.projectId}--${request.worktreeId}`] = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
    };
  }
  assertRegistryNow(run, 'After register');
  assertNoRegistryTemps(fixture.registryDir, 'Register');
  return requests.length;
}

/** Control: Delete with the checkout present retains a container. */
async function measureRetainedDelete(run, id, iteration) {
  const { page, fixture, tasks } = run;
  const before = readRegistry(fixture.registryPath);
  const label = `delete-retained-${id}`;
  const { confirmDialogShown } = await deleteFromSidebar(page, id, label);
  countConfirmDialog(run, 'delete_retained', confirmDialogShown);
  const rowHidden = await readRemovalTimer(page, label, HANDLER_TIMEOUT_MS);
  const archived = await waitForHandler(
    run.electronApp,
    PROBED_IPC_CHANNELS.archive,
    id,
    HANDLER_TIMEOUT_MS,
  );
  if (!existsSync(containerManifestPath(fixture, id)))
    throw new Error(`Delete of ${id} committed no retained container`);
  const after = readRegistry(fixture.registryPath);
  if (after.text !== before.text || after.mtimeMs !== before.mtimeMs)
    throw new Error(`The retained delete of ${id} rewrote the registry`);
  const handlerMs = handlerDuration(archived);
  pushMeasuredTask(
    tasks,
    'delete_retained_click_to_row_hidden',
    rowHidden.paintConfirmedMs,
    {
      iteration,
      clock: 'renderer',
      domRemovedMs: rowHidden.domRemovedMs,
      confirmDialogShown,
      optimisticRowRemoval: true,
    },
  );
  pushMeasuredTask(tasks, 'delete_retained_main_handler', handlerMs, {
    iteration,
    clock: 'main',
    ...(await attributeHandler(run, 'delete_retained', archived, null)),
  });
  run.handlerMs.delete_retained.push(handlerMs);
}

/** From the committing pointer-down to the later of paint and main's end. */
function operationWindow(timer, entry) {
  return {
    fromEpochMs: timer.clickEpochMs,
    toEpochMs: Math.max(timer.paintEpochMs, entry.endedAt),
  };
}

/**
 * Delete permanently from the More page's archived worktree: the purge route. The
 * viewer closes only after the purge IPC resolves, and the purge awaits the
 * registry removals, so the user-visible measure includes them.
 */
async function measurePurge(run, id, iteration) {
  const { page, fixture, tasks } = run;
  const archivedLink = page.getByTestId(
    `sidebar-project-${fixture.workspace.id}-archived-link`,
  );
  await expect(archivedLink).toBeVisible({ timeout: 30_000 });
  await archivedLink.click();
  // The More page opens an archived worktree from its card's ⋯ menu.
  const actions = page.getByTestId(`more-worktrees-actions-${id}`);
  await expect(actions).toBeVisible({ timeout: 30_000 });
  await actions.click();
  await page.getByTestId(`more-worktrees-open-action-${id}`).click();
  const viewer = page.getByTestId('archived-container-view');
  await expect(viewer).toBeVisible({ timeout: 30_000 });
  await dismissToasts(page);
  await viewer.getByTestId('archived-delete-permanently').click();
  const confirm = viewer.getByRole('button', { name: 'Delete?' });
  await expect(confirm).toBeVisible();
  assertRowsPresent(run, id, `Before purging ${id}`);
  const label = `purge-${id}`;
  await armRemovalTimer(page, label, '[data-testid="archived-container-view"]');
  await startMainPing(page);
  await confirm.click();
  const viewerClosed = await readRemovalTimer(page, label, HANDLER_TIMEOUT_MS);
  const purged = await waitForHandler(
    run.electronApp,
    PROBED_IPC_CHANNELS.purge,
    id,
    HANDLER_TIMEOUT_MS,
  );
  run.pings.purge.push(
    ...(await stopMainPing(
      page,
      'purge',
      operationWindow(viewerClosed, purged),
    )),
  );
  const removedKeys = fixture.registry.matchingKeys[id];
  run.expected = withoutKeys(run.expected, removedKeys);
  assertRegistryNow(run, `After purging ${id}`);
  if (existsSync(path.dirname(containerManifestPath(fixture, id))))
    throw new Error(`Purging ${id} left its archived container`);
  const handlerMs = handlerDuration(purged);
  const traced = await attributeHandler(
    run,
    'purge',
    purged,
    removedKeys.length,
  );
  pushMeasuredTask(
    tasks,
    'purge_click_to_viewer_closed',
    viewerClosed.paintConfirmedMs,
    {
      iteration,
      clock: 'renderer',
      domRemovedMs: viewerClosed.domRemovedMs,
      mainHandlerMs: handlerMs,
    },
  );
  pushMeasuredTask(tasks, 'purge_main_handler', handlerMs, {
    iteration,
    clock: 'main',
    removedRows: removedKeys.length,
    ...traced,
  });
  run.handlerMs.purge.push(handlerMs);
}

/**
 * Delete with the checkout missing: a hard delete. As in
 * archive-missing-worktree-chat.spec.mjs, the row is shown healthy, then its
 * checkout is deleted while the app runs, before any timer starts; the
 * health result is delivered as the sidebar's poll would (hidden windows
 * pause it), and the row's issue indicator must show before Delete. The row
 * hides before main finishes, so main's handler time is the completion
 * measure.
 */
async function measureMissingDelete(run, id, iteration) {
  const { page, fixture, tasks } = run;
  const row = sidebarRow(page, id);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(
    row.getByLabel('Worktree issue - click for details'),
  ).toHaveCount(0);
  if (!readWorktreeIds(fixture.worktreesPath).includes(id))
    throw new Error(`${id}'s worktree record was gone before its checkout`);
  if (existsSync(containerManifestPath(fixture, id)))
    throw new Error(`${id} was archived before its checkout was removed`);
  removeMissingCheckout(fixture, id);
  const health = await page.evaluate(
    (request) => window.api.retryWorktreeHealthCheck(request),
    { projectId: fixture.workspace.id, worktreeId: id },
  );
  if (
    health?.healthy !== false ||
    health.issue?.code !== 'missing-worktree-path' ||
    !health.worktree
  )
    throw new Error(
      `The missing checkout ${id} reported ${health?.healthy ? 'healthy' : `issue ${health?.issue?.code ?? 'none'}`}`,
    );
  await run.electronApp.evaluate(
    ({ BrowserWindow }, event) => {
      const [mainWindow] = BrowserWindow.getAllWindows();
      if (!mainWindow) throw new Error('Missing main window');
      mainWindow.webContents.send('workspace:worktrees-updated', event);
    },
    { workspaceId: fixture.workspace.id, worktree: health.worktree },
  );
  await expect(
    row.getByLabel('Worktree issue - click for details'),
  ).toBeVisible({ timeout: 30_000 });
  await dismissToasts(page);
  assertRowsPresent(run, id, `Before deleting missing ${id}`);
  const label = `missing-delete-${id}`;
  await startMainPing(page);
  const { confirmDialogShown } = await deleteFromSidebar(page, id, label);
  countConfirmDialog(run, 'missing_delete', confirmDialogShown);
  const rowHidden = await readRemovalTimer(page, label, HANDLER_TIMEOUT_MS);
  const deleted = await waitForHandler(
    run.electronApp,
    PROBED_IPC_CHANNELS.archive,
    id,
    HANDLER_TIMEOUT_MS,
  );
  run.pings.missing_delete.push(
    ...(await stopMainPing(
      page,
      'missing_delete',
      operationWindow(rowHidden, deleted),
    )),
  );
  const removedKeys = fixture.registry.matchingKeys[id];
  run.expected = withoutKeys(run.expected, removedKeys);
  assertRegistryNow(run, `After deleting missing ${id}`);
  if (readWorktreeIds(fixture.worktreesPath).includes(id))
    throw new Error(`Deleting missing ${id} left its worktree record`);
  if (existsSync(containerManifestPath(fixture, id)))
    throw new Error(`Deleting missing ${id} retained a container`);
  const handlerMs = handlerDuration(deleted);
  const traced = await attributeHandler(
    run,
    'missing_delete',
    deleted,
    removedKeys.length,
  );
  pushMeasuredTask(
    tasks,
    'missing_delete_click_to_row_hidden',
    rowHidden.paintConfirmedMs,
    {
      iteration,
      clock: 'renderer',
      domRemovedMs: rowHidden.domRemovedMs,
      confirmDialogShown,
      optimisticRowRemoval: true,
    },
  );
  pushMeasuredTask(tasks, 'missing_delete_main_handler', handlerMs, {
    iteration,
    clock: 'main',
    removedRows: removedKeys.length,
    ...traced,
  });
  run.handlerMs.missing_delete.push(handlerMs);
}

/** Per-launch foreground and trace timings; fails when a probe saw nothing. */
function recordRunTimings(run) {
  const foreground = {};
  for (const [route, samples] of Object.entries(run.pings)) {
    if (samples.length === 0)
      throw new Error(`The ${route} main IPC ping recorded no samples`);
    foreground[`${route}_ipc_ping_p95_ms`] = round(percentileOf(samples, 0.95));
    foreground[`${route}_ipc_ping_max_ms`] = round(Math.max(...samples));
  }
  run.tasks.timings.registry_foreground = foreground;
}

/**
 * Trace arm only: the per-launch attribution medians, after checking that
 * the trace saw registry I/O and that nothing outside the probed handlers
 * wrote the registry while the workload ran.
 */
async function recordTraceTimings(run) {
  if (!run.trace) return null;
  if (
    !Object.values(run.traceAttributions)
      .flat()
      .some((entry) => entry.registryIoMs > 0)
  )
    throw new Error('The registry trace observed no registry I/O');
  const { ipc, events } = await readProbe(run.electronApp);
  const outside = registryEventsOutsideWindows(events, ipc);
  if (outside.writes > 0)
    throw new Error(
      `The registry was written ${outside.writes} time(s) outside the probed handlers; a cleanup the routes do not account for ran during the workload`,
    );
  run.tasks.timings.registry_trace = traceTimings(run.traceAttributions);
  return { outsideHandlerReads: outside.reads };
}

export async function runCodeReviewRegistryCleanup(context, { trace }) {
  const { config, fixture } = context;
  const startup = readRegistry(fixture.registryPath);
  if (startup.text !== fixture.seededRegistryText)
    throw new Error('Startup rewrote the seeded Code Review registry');
  assertMissingCheckoutsPresent(fixture);
  const probe = await installRegistryProbe(context.electronApp, {
    fsTrace: trace,
  });
  if (probe.missing.length > 0)
    throw new Error(
      `The registry trace could not wrap ${probe.missing.join(', ')}`,
    );
  const run = createRun(context, trace);

  await returnToKeptWorktree(run.app, run.page, fixture);
  for (const id of [...fixture.deleteIds, ...fixture.missingIds])
    await expect(sidebarRow(run.page, id)).toBeVisible({ timeout: 30_000 });

  const registered = await measureRegister(
    run,
    config.codeReviewRegistryRegisterIterations,
  );
  for (const [index, id] of fixture.deleteIds.entries()) {
    await measureRetainedDelete(run, id, index + 1);
    await measurePurge(run, id, index + 1);
    await returnToKeptWorktree(run.app, run.page, fixture);
  }
  for (const [index, id] of fixture.missingIds.entries())
    await measureMissingDelete(run, id, index + 1);

  const final = readRegistry(fixture.registryPath);
  assertRegistryTargets(final.file.targets, run.expected, 'Final registry');
  assertNoRegistryTemps(fixture.registryDir, 'Final registry');
  recordRunTimings(run);
  const traceCheck = await recordTraceTimings(run);

  const seededRows = Object.keys(fixture.registry.file.targets).length;
  const finalRows = Object.keys(final.file.targets).length;
  return {
    trace,
    registry: {
      seededRows,
      matchingRowsPerRemovedWorktree: config.codeReviewRegistryMatchingRows,
      unrelatedRows: fixture.registry.unrelatedKeys.length,
      registered,
      removedRows: seededRows + registered - finalRows,
      finalRows,
    },
    routes: Object.fromEntries(
      Object.entries(run.handlerMs).map(([route, values]) => [
        route,
        { count: values.length, medianHandlerMs: round(median(values)) },
      ]),
    ),
    pingSamples: Object.fromEntries(
      Object.entries(run.pings).map(([route, samples]) => [
        route,
        samples.length,
      ]),
    ),
    confirmDialogs: run.confirmDialogs,
    ...(traceCheck ? { traceCheck } : {}),
  };
}
