// ---------------------------------------------------------------------------
// Terminal drawer store (renderer-only, per-worktree)
// ---------------------------------------------------------------------------
//
// Owns the renderer-side state for the terminal drawer feature:
//   - groups, splits, focused pane, active group
//   - per-group stable ordinal (SPLIT N / TERMINAL N labels)
//   - lazy hydration from persisted worktree terminal metadata
//   - live/exited session flags for historical terminal entries

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { TerminalClient } from '@canopy/app-core';
import {
  registerTerminalClientReset,
  requireTerminalClient,
} from './terminal-client-binding';
import {
  isPersistenceCancellation,
  reportStorePersistenceError,
} from '../client-store-lifecycle';
import {
  DEFAULT_TERMINAL_DRAWER_COLLAPSED,
  TERMINAL_CUSTOM_NAME_MAX_LENGTH,
  type LoadWorktreeTerminalStateResponse,
  type SaveWorktreeTerminalStateRequest,
  type TerminalExitEvent,
  type TerminalGroup,
  type TerminalSession,
} from '@canopy/protocol/terminal';
import { useTerminalActivityStore } from './terminal-activity-store';

/**
 * Terminal metadata tracked in the renderer for both live and historical
 * entries. Live PTYs are identified by `live === true`; exited historical
 * terminals stay in the worktree drawer until the user explicitly removes
 * them.
 */
export interface KnownTerminalSession extends TerminalSession {
  live: boolean;
  scrollbackLines: string[];
  exitCode: number | null;
  signal: string | null;
}

interface HydrationEdits {
  exits: Map<string, TerminalExitEvent>;
  terminalNames: Set<string>;
  groupNames: Set<string>;
  terminalGroups: Map<string, string>;
}

/**
 * Per-worktree state. `nextGroupOrdinal` is a monotonically-increasing
 * counter used to stamp every new group with a stable "SPLIT N" / "TERMINAL N"
 * label that survives deletes.
 */
export interface WorktreeTerminalBucket {
  /** Whether this worktree's terminal drawer is collapsed. */
  drawerCollapsed: boolean;
  groups: TerminalGroup[];
  activeGroupId: string | null;
  nextGroupOrdinal: number;
  /** Per-group stable ordinal assigned at creation time. */
  groupOrdinals: Record<string, number>;
  /** Terminal metadata keyed by terminal id. */
  sessions: Record<string, KnownTerminalSession>;
  /** Renderer has been rehydrated from persisted worktree state. */
  hydrated: boolean;
  /** A load or status probe could not read terminal history (CAN-7051). */
  historyUnavailable?: boolean;
  /** New terminal history is held in memory, not saved yet (CAN-7051). */
  historyHeld?: boolean;
  /** False when a status probe found an older peer without status-only support. */
  historyRefreshSupported?: boolean;
  /** Changes only when an unavailable history load recovers. */
  historyRevision?: number;
  /** The saving view's cumulative token, continued across refreshes (CAN-7051). */
  viewToken?: string;
  /** Whether the load that issued `viewToken` had only partial history. */
  viewTokenPartial?: boolean;
}

interface TerminalState {
  /** Keyed by `${projectId}/${worktreeId}`. */
  worktrees: Record<string, WorktreeTerminalBucket>;
  /** User-assigned names keyed by terminal id. */
  terminalCustomNames: Record<string, string>;
  /** User-assigned names keyed by group id. */
  groupCustomNames: Record<string, string>;

  /** Action: hydrate one worktree from main-side persisted state. */
  hydrateWorktree: (
    projectId: string,
    worktreeId: string,
    options?: { automatic?: boolean },
  ) => Promise<void>;

  /** Action: collapse or expand one worktree's terminal drawer. */
  setDrawerCollapsed: (
    projectId: string,
    worktreeId: string,
    collapsed: boolean,
  ) => void;

  /**
   * Action: set or clear a user-assigned name for an individual terminal.
   * Pass `null` or an empty string to clear.
   */
  setTerminalName: (
    projectId: string,
    worktreeId: string,
    terminalId: string,
    name: string | null,
  ) => void;

  /**
   * Action: set or clear a user-assigned name for a group. Pass `null` or an
   * empty string to clear.
   */
  setGroupName: (
    projectId: string,
    worktreeId: string,
    groupId: string,
    name: string | null,
  ) => void;

  /** Action: create a new group with a single newly-spawned terminal. */
  addGroupWithTerminal: (
    session: TerminalSession,
    options?: { activate?: boolean },
  ) => void;

  /** Action: mark a historical terminal as live again after lazy restore. */
  markTerminalLive: (session: TerminalSession) => void;

  /** Action: add a newly-spawned terminal as a new pane inside an existing group. */
  splitGroup: (
    projectId: string,
    worktreeId: string,
    groupId: string,
    session: TerminalSession,
  ) => void;

  /** Action: focus a pane. */
  setFocusedTerminal: (
    projectId: string,
    worktreeId: string,
    groupId: string,
    terminalId: string,
  ) => void;

  /** Action: activate a group. */
  setActiveGroup: (
    projectId: string,
    worktreeId: string,
    groupId: string,
  ) => void;

  /** Action: update the split flex-basis fractions for a group. */
  setSplitSizes: (
    projectId: string,
    worktreeId: string,
    groupId: string,
    sizes: number[],
  ) => void;

  /**
   * Action: remove a terminal entry from the drawer. If this was the last pane
   * in the group, the group itself is removed. When the active group is
   * removed, `activeGroupId` falls back to the first remaining group (or
   * `null`).
   */
  removeTerminal: (
    projectId: string,
    worktreeId: string,
    terminalId: string,
  ) => void;

  /** Action: kill a whole group and remove its persisted entries. */
  removeGroup: (projectId: string, worktreeId: string, groupId: string) => void;

  /** Action: apply a `terminalExit` push event without removing the entry. */
  applyExit: (event: TerminalExitEvent) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SPLIT_SIZE_PERSIST_DEBOUNCE_MS = 120;

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function emptyBucket(): WorktreeTerminalBucket {
  return {
    drawerCollapsed: DEFAULT_TERMINAL_DRAWER_COLLAPSED,
    groups: [],
    activeGroupId: null,
    nextGroupOrdinal: 1,
    groupOrdinals: {},
    sessions: {},
    hydrated: false,
  };
}

function newGroupId(): string {
  return crypto.randomUUID();
}

function normalizeSplitSizes(count: number, existing?: number[]): number[] {
  if (count <= 0) {
    return [];
  }
  if (existing && existing.length === count) {
    const total = existing.reduce((sum, value) => sum + value, 0);
    if (total > 0) {
      return existing.map((value) => value / total);
    }
  }
  const even = 1 / count;
  const sizes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    sizes.push(even);
  }
  return sizes;
}

function sanitizeCustomName(name: string | null): string | null {
  if (name === null) {
    return null;
  }
  const trimmed = name.trim().slice(0, TERMINAL_CUSTOM_NAME_MAX_LENGTH);
  return trimmed.length === 0 ? null : trimmed;
}

function createKnownSession(
  session: TerminalSession,
  options?: {
    live?: boolean;
    scrollbackLines?: string[];
    exitCode?: number | null;
    signal?: string | null;
  },
): KnownTerminalSession {
  return {
    ...session,
    live: options?.live ?? true,
    scrollbackLines: options?.scrollbackLines ?? [],
    exitCode: options?.exitCode ?? null,
    signal: options?.signal ?? null,
  };
}

function buildSaveRequest(
  state: TerminalState,
  projectId: string,
  worktreeId: string,
  forgetTerminalIds?: string[],
  clearedTerminalNames: readonly string[] = [],
): SaveWorktreeTerminalStateRequest {
  const bucket =
    state.worktrees[worktreeKey(projectId, worktreeId)] ?? emptyBucket();
  const groupIds = new Set(bucket.groups.map((group) => group.id));
  const terminalIds = new Set(Object.keys(bucket.sessions));
  const terminalCustomNames: Record<string, string> = {};
  const groupCustomNames: Record<string, string> = {};

  for (const terminalId of Array.from(terminalIds)) {
    const customName = state.terminalCustomNames[terminalId];
    if (customName !== undefined) {
      terminalCustomNames[terminalId] = customName;
    }
  }

  for (const groupId of Array.from(groupIds)) {
    const customName = state.groupCustomNames[groupId];
    if (customName !== undefined) {
      groupCustomNames[groupId] = customName;
    }
  }

  return {
    projectId,
    worktreeId,
    drawerCollapsed: bucket.drawerCollapsed,
    groups: bucket.groups.map((group) => ({
      id: group.id,
      terminalIds: [...group.terminalIds],
      focusedTerminalId: group.focusedTerminalId,
      splitSizes: [...group.splitSizes],
    })),
    activeGroupId: bucket.activeGroupId,
    nextGroupOrdinal: bucket.nextGroupOrdinal,
    groupOrdinals: { ...bucket.groupOrdinals },
    terminalCustomNames,
    groupCustomNames,
    // Declared, so an omitted (perhaps unseen) name is never read as a clear.
    clearedTerminalNames: clearedTerminalNames.filter((terminalId) =>
      terminalIds.has(terminalId),
    ),
    ...(bucket.viewToken !== undefined && { viewToken: bucket.viewToken }),
    ...(forgetTerminalIds && { forgetTerminalIds }),
  };
}

function mergeHydratedWorktree(
  previousBucket: WorktreeTerminalBucket | undefined,
  response: LoadWorktreeTerminalStateResponse,
  lifecycleChanged: (terminalId: string) => boolean,
  removed: ReadonlySet<string>,
  rejectedMemberships: ReadonlySet<string>,
  edits: HydrationEdits,
): WorktreeTerminalBucket {
  const bucket = previousBucket ?? emptyBucket();
  const liveTerminalIds = new Set(response.liveTerminalIds);
  const partial = response.history?.status === 'unavailable';
  const sessions: Record<string, KnownTerminalSession> = {};
  for (const terminal of response.terminals) {
    const id = terminal.session.id;
    if (removed.has(id)) continue;
    if (lifecycleChanged(id) && bucket.sessions[id] !== undefined) continue;
    const exit = edits.exits.get(id);
    const cached = bucket.sessions[id];
    const session = createKnownSession(terminal.session, {
      live: exit === undefined && liveTerminalIds.has(id),
      // Partial loads may include a live session with only its unsaved tail.
      scrollbackLines: [
        ...(partial && cached && cached.scrollbackLines.length > 0
          ? cached.scrollbackLines
          : terminal.scrollbackLines),
      ],
      exitCode: exit === undefined ? terminal.exitCode : exit.exitCode,
      signal: exit === undefined ? terminal.signal : exit.signal,
    });
    sessions[id] = session;
  }

  // A load that could not read history (CAN-7051) omits exited terminals it
  // could not see; the drawer keeps what it already showed.
  for (const session of Object.values(bucket.sessions)) {
    if (removed.has(session.id)) continue;
    // Only lifecycle publications invalidate history. Metadata/output projections
    // can replace session objects without superseding the requested history.
    if (
      lifecycleChanged(session.id) ||
      rejectedMemberships.has(session.id) ||
      ((session.live || partial) && sessions[session.id] === undefined)
    ) {
      sessions[session.id] = session;
    }
  }

  // A partial live projection may synthesize a group without its saved binding.
  const cachedMemberships = new Map<string, string>();
  if (partial)
    for (const group of bucket.groups)
      for (const id of group.terminalIds)
        if (!cachedMemberships.has(id)) cachedMemberships.set(id, group.id);
  const memberships = new Map<string, string>();
  const groups = response.groups.flatMap((group): TerminalGroup[] => {
    const terminalIds = group.terminalIds.filter((id) => {
      const cachedGroup = cachedMemberships.get(id);
      if (
        sessions[id] === undefined ||
        memberships.has(id) ||
        (cachedGroup !== undefined && cachedGroup !== group.id)
      )
        return false;
      memberships.set(id, group.id);
      return true;
    });
    if (terminalIds.length === 0) return [];
    return [
      {
        id: group.id,
        terminalIds,
        focusedTerminalId: terminalIds.includes(group.focusedTerminalId)
          ? group.focusedTerminalId
          : terminalIds[0],
        splitSizes: normalizeSplitSizes(terminalIds.length, group.splitSizes),
      },
    ];
  });
  const groupsById = new Map(groups.map((group) => [group.id, group]));

  for (const previousGroup of bucket.groups) {
    const terminalIds = previousGroup.terminalIds.filter((terminalId) => {
      const assignedGroup = memberships.get(terminalId);
      if (
        sessions[terminalId] === undefined ||
        (assignedGroup !== undefined && assignedGroup !== previousGroup.id)
      )
        return false;
      memberships.set(terminalId, previousGroup.id);
      return true;
    });
    if (terminalIds.length === 0) {
      continue;
    }

    const existingGroup = groupsById.get(previousGroup.id);
    if (existingGroup !== undefined) {
      const mergedTerminalIds = [...existingGroup.terminalIds];
      for (const terminalId of terminalIds) {
        if (!mergedTerminalIds.includes(terminalId)) {
          mergedTerminalIds.push(terminalId);
        }
      }

      const splitSizesSource =
        previousGroup.splitSizes.length === mergedTerminalIds.length
          ? previousGroup.splitSizes
          : existingGroup.splitSizes;
      existingGroup.terminalIds = mergedTerminalIds;
      existingGroup.focusedTerminalId = mergedTerminalIds.includes(
        previousGroup.focusedTerminalId,
      )
        ? previousGroup.focusedTerminalId
        : mergedTerminalIds[0];
      existingGroup.splitSizes = normalizeSplitSizes(
        mergedTerminalIds.length,
        splitSizesSource,
      );
      continue;
    }

    const mergedGroup: TerminalGroup = {
      id: previousGroup.id,
      terminalIds,
      focusedTerminalId: terminalIds.includes(previousGroup.focusedTerminalId)
        ? previousGroup.focusedTerminalId
        : terminalIds[0],
      splitSizes: normalizeSplitSizes(
        terminalIds.length,
        previousGroup.splitSizes,
      ),
    };
    groups.push(mergedGroup);
    groupsById.set(mergedGroup.id, mergedGroup);
  }

  const groupOrdinals: Record<string, number> = {};
  for (const group of groups) {
    const ordinal = response.groupOrdinals[group.id];
    if (ordinal !== undefined) groupOrdinals[group.id] = ordinal;
  }
  for (const group of bucket.groups) {
    const ordinal = bucket.groupOrdinals[group.id];
    if (ordinal !== undefined && groupsById.has(group.id)) {
      groupOrdinals[group.id] = ordinal;
    }
  }

  const merged: WorktreeTerminalBucket = {
    ...bucket,
    drawerCollapsed:
      previousBucket === undefined
        ? response.drawerCollapsed
        : bucket.drawerCollapsed,
    groups,
    activeGroupId:
      bucket.activeGroupId !== null && groupsById.has(bucket.activeGroupId)
        ? bucket.activeGroupId
        : response.activeGroupId === null
          ? null
          : groupsById.has(response.activeGroupId)
            ? response.activeGroupId
            : (groups[0]?.id ?? null),
    nextGroupOrdinal: Math.max(
      response.nextGroupOrdinal,
      bucket.nextGroupOrdinal,
    ),
    groupOrdinals,
    sessions,
    hydrated: true,
    historyUnavailable: response.history?.status === 'unavailable',
    historyHeld: response.historyHeld === true,
    historyRevision:
      (bucket.historyRevision ?? 0) +
      (bucket.historyUnavailable && response.history?.status === 'available'
        ? 1
        : 0),
  };
  // Main issues cumulative successors for the retained token carried by loads.
  // Display retention and pending edits do not need to infer save authority.
  if (response.viewToken === undefined) {
    delete merged.viewToken;
    delete merged.viewTokenPartial;
  } else {
    merged.viewToken = response.viewToken;
    merged.viewTokenPartial = partial;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface TerminalStoreController {
  store: UseBoundStore<StoreApi<TerminalState>>;
  ensureHydrated: (projectId: string, worktreeId: string) => Promise<void>;
  reset: () => void;
  purgeWorktrees: (worktreeIds: readonly string[]) => void;
  observeHistory: (projectId: string, worktreeId: string) => () => void;
}

export interface TerminalRemovedEvent {
  projectId: string;
  worktreeId: string;
  terminalId: string;
}
const removedListeners = new Set<(event: TerminalRemovedEvent) => void>();
export function addTerminalRemovedListener(
  listener: (event: TerminalRemovedEvent) => void,
): () => void {
  removedListeners.add(listener);
  return (): void => {
    removedListeners.delete(listener);
  };
}
function notifyTerminalRemoved(
  projectId: string,
  worktreeId: string,
  terminalId: string,
): void {
  for (const listener of Array.from(removedListeners))
    listener({ projectId, worktreeId, terminalId });
}

interface HistoryOutage {
  unavailable: boolean;
  /** Available confirmations while probes still report this outage. */
  disputes: number;
  /** When a disputed confirmation may be rechecked; never while one runs. */
  recheckAt: number;
}

// A probe cannot tell a lagging reading from a new outage after recovery.
function settleHistoryOutage(
  outage: HistoryOutage,
  unavailable: boolean,
): void {
  outage.unavailable = unavailable;
  if (unavailable) {
    outage.recheckAt = Number.POSITIVE_INFINITY;
    return;
  }
  outage.recheckAt =
    Date.now() + Math.min(60_000, 10_000 * 2 ** Math.min(outage.disputes, 3));
  outage.disputes += 1;
}

export interface TerminalStoreOptions {
  /**
   * Records one failed save. Defaults to the host recorder installed with
   * `setStorePersistenceErrorReporter`.
   */
  readonly report?: (error: unknown) => void;
}

export function createTerminalStore(
  getClient: () => TerminalClient,
  options: TerminalStoreOptions = {},
): TerminalStoreController {
  const report =
    options.report ??
    ((error: unknown): void =>
      reportStorePersistenceError('terminal-save', error));
  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const hydrationPromises = new Map<string, Promise<void>>();
  const manualHistoryLoads = new Map<string, Promise<void>>();
  let generation = 0;
  const worktreeGenerations = new Map<string, number>();
  const hydrationSequences = new Map<string, number>();
  const terminalLifecycleVersions = new Map<string, Map<string, number>>();
  const removedTerminals = new Map<string, Set<string>>();
  const removedMemberships = new Map<string, Map<string, Set<string>>>();
  const pendingHydrationEdits = new Map<string, Set<HydrationEdits>>();
  const historyOutages = new Map<string, HistoryOutage>();
  let nextLifecycleVersion = 0;
  const historyObservers = new Map<
    string,
    { users: number; stop: () => void }
  >();

  function retireMemberships(
    key: string,
    groupId: string,
    terminalIds: readonly string[],
  ): void {
    const groups =
      removedMemberships.get(key) ?? new Map<string, Set<string>>();
    const ids = groups.get(groupId) ?? new Set<string>();
    for (const id of terminalIds) ids.add(id);
    groups.set(groupId, ids);
    removedMemberships.set(key, groups);
  }

  function assignTerminalGroup(
    state: TerminalState,
    key: string,
    terminalId: string,
    groupId: string,
  ): {
    bucket: WorktreeTerminalBucket;
    groupCustomNames: Record<string, string>;
  } {
    for (const edits of pendingHydrationEdits.get(key) ?? [])
      edits.terminalGroups.set(terminalId, groupId);

    const bucket = state.worktrees[key] ?? emptyBucket();
    // Spawn/split assign one terminal group; panel-layout tabs are separate.
    // Recovery may publish first; group keys do not encode reliable provenance.
    if (
      !bucket.groups.some(
        (group) =>
          group.id !== groupId && group.terminalIds.includes(terminalId),
      )
    )
      return { bucket, groupCustomNames: state.groupCustomNames };

    const removedGroupIds = new Set<string>();
    const groups = bucket.groups.flatMap((group): TerminalGroup[] => {
      if (group.id === groupId || !group.terminalIds.includes(terminalId))
        return [group];
      retireMemberships(key, group.id, [terminalId]);
      const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
      if (terminalIds.length === 0) {
        removedGroupIds.add(group.id);
        return [];
      }
      return [
        {
          ...group,
          terminalIds,
          focusedTerminalId: terminalIds.includes(group.focusedTerminalId)
            ? group.focusedTerminalId
            : terminalIds[0],
          splitSizes: normalizeSplitSizes(terminalIds.length),
        },
      ];
    });
    const groupOrdinals = { ...bucket.groupOrdinals };
    const groupCustomNames = { ...state.groupCustomNames };
    for (const removedGroupId of removedGroupIds) {
      delete groupOrdinals[removedGroupId];
      delete groupCustomNames[removedGroupId];
    }
    return {
      bucket: {
        ...bucket,
        groups,
        groupOrdinals,
        activeGroupId:
          bucket.activeGroupId !== null &&
          removedGroupIds.has(bucket.activeGroupId)
            ? groupId
            : bucket.activeGroupId,
      },
      groupCustomNames,
    };
  }

  function publishTerminalLifecycle(
    key: string,
    terminalId: string,
    removed = false,
  ): void {
    let versions = terminalLifecycleVersions.get(key);
    if (versions === undefined) {
      versions = new Map();
      terminalLifecycleVersions.set(key, versions);
    }
    versions.set(terminalId, ++nextLifecycleVersion);
    if (removed) {
      const ids = removedTerminals.get(key) ?? new Set<string>();
      ids.add(terminalId);
      removedTerminals.set(key, ids);
    } else {
      // An explicit spawn/rebind starts a new lifecycle for a closed ID.
      removedTerminals.get(key)?.delete(terminalId);
    }
  }

  // One output-free probe per visible worktree, not per split pane. Failed
  // history loads confirm once per outage, then retry after reachability returns.
  // An available confirmation that probes dispute is rechecked with backoff.
  function observeHistory(projectId: string, worktreeId: string): () => void {
    const key = worktreeKey(projectId, worktreeId);
    const bucket = store.getState().worktrees[key];
    if (!bucket?.hydrated || bucket.historyRefreshSupported === false)
      return (): void => undefined;
    const existing = historyObservers.get(key);
    if (existing) {
      existing.users += 1;
      return historyObserverRelease(key, existing);
    }
    const client = getClient();
    const currentGeneration = generation;
    const worktreeGeneration = worktreeGenerations.get(key);
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let recoveryAttempts = 0;
    let recoveryRetryAt = 0;
    let recoveryRevision = bucket.historyRevision ?? 0;
    const current = (): boolean =>
      active &&
      generation === currentGeneration &&
      worktreeGenerations.get(key) === worktreeGeneration;
    const observer = {
      users: 1,
      stop: (): void => {
        active = false;
        if (timer !== undefined) clearTimeout(timer);
      },
    };
    historyObservers.set(key, observer);
    const refresh = async (): Promise<void> => {
      try {
        if (!current()) return;
        if (manualHistoryLoads.has(key)) return;
        const hydrationSequence = hydrationSequences.get(key);
        const response = await client.query('terminal.worktreeState.get', {
          projectId,
          worktreeId,
          historyStatusOnly: true,
        });
        if (!current() || hydrationSequences.get(key) !== hydrationSequence)
          return;
        const bucket = store.getState().worktrees[key];
        if (!bucket) return;
        // A probe reflects only daemon health, so recovery loads that fail or
        // stay unavailable back off until history loads or a probe reports
        // unavailable, when the next reachability retries at once.
        if (
          !bucket.historyUnavailable ||
          response.history?.status !== 'available' ||
          (bucket.historyRevision ?? 0) !== recoveryRevision
        ) {
          recoveryAttempts = 0;
          recoveryRetryAt = 0;
          recoveryRevision = bucket.historyRevision ?? 0;
        }
        // An older peer ignores the optional field and returns a full load.
        // Never merge it as status or repeatedly poll its history.
        if (response.historyRefreshSupported !== true) {
          store.setState((state) => ({
            worktrees: {
              ...state.worktrees,
              [key]: { ...bucket, historyRefreshSupported: false },
            },
          }));
          observer.stop();
          return;
        }
        const historyHeld = response.historyHeld === true;
        const probedOutage = response.history?.status === 'unavailable';
        const knownOutage = historyOutages.get(key);
        const newOutage = probedOutage && knownOutage === undefined;
        const confirmOutage =
          (newOutage && !bucket.historyUnavailable) ||
          (probedOutage &&
            knownOutage !== undefined &&
            !knownOutage.unavailable &&
            Date.now() >= knownOutage.recheckAt);
        if (response.history?.status === 'available')
          historyOutages.delete(key);
        else if (newOutage)
          historyOutages.set(key, {
            unavailable: bucket.historyUnavailable === true,
            disputes: 0,
            recheckAt: Number.POSITIVE_INFINITY,
          });
        if (confirmOutage && knownOutage !== undefined)
          knownOutage.recheckAt = Number.POSITIVE_INFINITY;
        const historyUnavailable =
          historyOutages.get(key)?.unavailable ?? bucket.historyUnavailable;
        if (
          bucket.historyHeld !== historyHeld ||
          bucket.historyUnavailable !== historyUnavailable
        )
          store.setState((state) => ({
            worktrees: {
              ...state.worktrees,
              [key]: { ...bucket, historyHeld, historyUnavailable },
            },
          }));
        if (
          confirmOutage ||
          (bucket.historyUnavailable &&
            response.history?.status === 'available' &&
            Date.now() >= recoveryRetryAt)
        ) {
          try {
            // A daemon-only probe cannot see readable legacy history; a prior
            // unavailable load already checked that fallback.
            // A visibility-bound load must not supersede an explicit retry.
            await (manualHistoryLoads.get(key) ??
              loadWorktree(projectId, worktreeId, current, confirmOutage));
          } finally {
            // Reachability can return before a worktree's legacy import finishes.
            // Keep status probes cheap while unsuccessful full loads back off.
            if (current()) {
              const recovered = store.getState().worktrees[key];
              if (recovered?.historyUnavailable) {
                recoveryRetryAt =
                  Date.now() +
                  Math.min(30_000, 2_000 * 2 ** Math.min(recoveryAttempts, 4));
                recoveryAttempts += 1;
              } else {
                recoveryAttempts = 0;
                recoveryRetryAt = 0;
              }
              recoveryRevision = recovered?.historyRevision ?? 0;
            }
          }
        }
      } catch {
        // Keep the notice and the current terminal; nothing blocks user work.
      } finally {
        if (current()) timer = setTimeout((): void => void refresh(), 2_000);
      }
    };
    void refresh();
    return historyObserverRelease(key, observer);
  }

  function historyObserverRelease(
    key: string,
    observer: { users: number; stop: () => void },
  ): () => void {
    let released = false;
    return (): void => {
      if (released || historyObservers.get(key) !== observer) return;
      released = true;
      observer.users -= 1;
      if (observer.users > 0) return;
      observer.stop();
      historyObservers.delete(key);
    };
  }
  function persistWorktreeState(
    projectId: string,
    worktreeId: string,
    forgetTerminalIds?: string[],
    clearedTerminalNames?: readonly string[],
  ): void {
    const request = buildSaveRequest(
      store.getState(),
      projectId,
      worktreeId,
      forgetTerminalIds,
      clearedTerminalNames,
    );
    void getClient()
      .command('terminal.worktreeState.save', request)
      .catch((error: unknown): void => {
        // A dispatched save cannot be retracted on reset. Consume transport
        // failures without retrying this host's snapshot through a new binding.
        // Record each failed save once: a lost layout or forget is otherwise
        // invisible.
        if (isPersistenceCancellation(error)) return;
        try {
          report(error);
        } catch {
          // Recording is best effort and must not break the store.
        }
      });
  }

  function clearPersistTimer(key: string): void {
    const timer = persistTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      persistTimers.delete(key);
    }
  }

  function schedulePersistWorktreeState(
    projectId: string,
    worktreeId: string,
    delayMs: number,
  ): void {
    const key = worktreeKey(projectId, worktreeId);
    clearPersistTimer(key);
    persistTimers.set(
      key,
      setTimeout((): void => {
        persistTimers.delete(key);
        persistWorktreeState(projectId, worktreeId);
      }, delayMs),
    );
  }

  function hydrateWorktree(
    projectId: string,
    worktreeId: string,
    options?: { automatic?: boolean },
  ): Promise<void> {
    const key = worktreeKey(projectId, worktreeId);
    // Older peers retry through the Surface rather than the status observer.
    if (options?.automatic)
      return manualHistoryLoads.get(key) ?? loadWorktree(projectId, worktreeId);
    const promise = loadWorktree(projectId, worktreeId).finally(() => {
      if (manualHistoryLoads.get(key) === promise)
        manualHistoryLoads.delete(key);
    });
    manualHistoryLoads.set(key, promise);
    return promise;
  }

  async function loadWorktree(
    projectId: string,
    worktreeId: string,
    isCurrent: () => boolean = () => true,
    confirmOutage = false,
  ): Promise<void> {
    const currentGeneration = generation;
    const key = worktreeKey(projectId, worktreeId);
    const worktreeGeneration = worktreeGenerations.get(key) ?? 0;
    worktreeGenerations.set(key, worktreeGeneration);
    const sequence = (hydrationSequences.get(key) ?? 0) + 1;
    hydrationSequences.set(key, sequence);
    const outage = historyOutages.get(key);
    const lifecycleVersionsAtRequestStart = new Map(
      terminalLifecycleVersions.get(key),
    );
    const edits: HydrationEdits = {
      exits: new Map(),
      terminalNames: new Set(),
      groupNames: new Set(),
      terminalGroups: new Map(),
    };
    const pending = pendingHydrationEdits.get(key) ?? new Set<HydrationEdits>();
    pending.add(edits);
    pendingHydrationEdits.set(key, pending);
    const client = getClient();
    let response: LoadWorktreeTerminalStateResponse;
    try {
      const retainedViewToken = store.getState().worktrees[key]?.viewToken;
      response = await client.query('terminal.worktreeState.get', {
        projectId,
        worktreeId,
        ...(confirmOutage && { historyConfirmationOnly: true }),
        ...(!confirmOutage &&
          retainedViewToken !== undefined && { retainedViewToken }),
      });
    } catch (error) {
      if (
        outage !== undefined &&
        historyOutages.get(key) === outage &&
        hydrationSequences.get(key) === sequence &&
        generation === currentGeneration &&
        worktreeGenerations.get(key) === worktreeGeneration
      ) {
        settleHistoryOutage(outage, true);
        const bucket = store.getState().worktrees[key];
        if (isCurrent() && bucket)
          store.setState((state) => ({
            worktrees: {
              ...state.worktrees,
              [key]: { ...bucket, historyUnavailable: true },
            },
          }));
      }
      throw error;
    } finally {
      pending.delete(edits);
      if (pending.size === 0 && pendingHydrationEdits.get(key) === pending)
        pendingHydrationEdits.delete(key);
    }
    if (
      hydrationSequences.get(key) !== sequence ||
      generation !== currentGeneration ||
      worktreeGenerations.get(key) !== worktreeGeneration
    )
      return;
    if (confirmOutage && response.historyRefreshSupported !== true) return;
    // Remember a confirmation that outlives its pane, without publishing hidden
    // history. A new visibility lease can use the result without another load.
    if (outage !== undefined && historyOutages.get(key) === outage)
      settleHistoryOutage(outage, response.history?.status === 'unavailable');
    if (!isCurrent()) return;
    store.setState((state) => {
      const key = worktreeKey(projectId, worktreeId);
      const previousBucket = state.worktrees[key];
      // Confirmation observes fallback availability without merging layout.
      if (confirmOutage && previousBucket) {
        return {
          worktrees: {
            ...state.worktrees,
            [key]: {
              ...previousBucket,
              historyUnavailable: response.history?.status === 'unavailable',
              historyHeld: response.historyHeld === true,
            },
          },
        };
      }
      // Closed memberships and newer local assignments win over stale layouts.
      const rejectedMemberships = new Set<string>();
      const responseGroups = response.groups.flatMap(
        (group): TerminalGroup[] => {
          const terminalIds = group.terminalIds.filter((id) => {
            const assignedGroup = edits.terminalGroups.get(id);
            if (
              !removedMemberships.get(key)?.get(group.id)?.has(id) &&
              (assignedGroup === undefined || assignedGroup === group.id)
            )
              return true;
            rejectedMemberships.add(id);
            return false;
          });
          return terminalIds.length === 0 ? [] : [{ ...group, terminalIds }];
        },
      );
      for (const group of responseGroups)
        for (const id of group.terminalIds) rejectedMemberships.delete(id);
      const nextBucket = mergeHydratedWorktree(
        previousBucket,
        {
          ...response,
          groups: responseGroups,
          terminals: response.terminals.filter(
            ({ session }) => !rejectedMemberships.has(session.id),
          ),
        },
        (terminalId) =>
          terminalLifecycleVersions.get(key)?.get(terminalId) !==
          lifecycleVersionsAtRequestStart.get(terminalId),
        removedTerminals.get(key) ?? new Set(),
        rejectedMemberships,
        edits,
      );

      const nextTerminalCustomNames = { ...state.terminalCustomNames };
      const nextGroupCustomNames = { ...state.groupCustomNames };
      // Partial loads can include live sessions without their record names.
      // Missing names are authoritative only on a full load (R6-F2).
      if (previousBucket) {
        const partial = response.history?.status === 'unavailable';
        for (const terminalId of Object.keys(previousBucket.sessions)) {
          if (
            (!partial || nextBucket.sessions[terminalId] === undefined) &&
            !rejectedMemberships.has(terminalId) &&
            !edits.terminalNames.has(terminalId)
          )
            delete nextTerminalCustomNames[terminalId];
        }
        const keptGroups = new Set(nextBucket.groups.map((group) => group.id));
        for (const group of previousBucket.groups) {
          if (
            (!partial || !keptGroups.has(group.id)) &&
            !edits.groupNames.has(group.id)
          )
            delete nextGroupCustomNames[group.id];
        }
      }

      for (const [terminalId, customName] of Object.entries(
        response.terminalCustomNames,
      )) {
        if (
          !removedTerminals.get(key)?.has(terminalId) &&
          !rejectedMemberships.has(terminalId) &&
          !edits.terminalNames.has(terminalId)
        )
          nextTerminalCustomNames[terminalId] = customName;
      }

      for (const [groupId, customName] of Object.entries(
        response.groupCustomNames,
      )) {
        if (
          nextBucket.groups.some((group) => group.id === groupId) &&
          !edits.groupNames.has(groupId)
        )
          nextGroupCustomNames[groupId] = customName;
      }

      return {
        worktrees: { ...state.worktrees, [key]: nextBucket },
        terminalCustomNames: nextTerminalCustomNames,
        groupCustomNames: nextGroupCustomNames,
      };
    });
  }

  const store = create<TerminalState>((set, get) => ({
    worktrees: {},
    terminalCustomNames: {},
    groupCustomNames: {},

    hydrateWorktree,

    setDrawerCollapsed: (projectId, worktreeId, collapsed): void => {
      let shouldPersist = false;
      set((state) => {
        const key = worktreeKey(projectId, worktreeId);
        const bucket = state.worktrees[key] ?? emptyBucket();
        if (bucket.drawerCollapsed === collapsed) {
          return state;
        }
        shouldPersist = bucket.hydrated;
        return {
          worktrees: {
            ...state.worktrees,
            [key]: { ...bucket, drawerCollapsed: collapsed },
          },
        };
      });
      if (shouldPersist) {
        persistWorktreeState(projectId, worktreeId);
      }
    },

    setTerminalName: (projectId, worktreeId, terminalId, name): void => {
      for (const edits of pendingHydrationEdits.get(
        worktreeKey(projectId, worktreeId),
      ) ?? [])
        edits.terminalNames.add(terminalId);
      const sanitized = sanitizeCustomName(name);
      let shouldPersist = false;
      const clears =
        sanitized === null && terminalId in get().terminalCustomNames;
      set((state) => {
        const next = { ...state.terminalCustomNames };
        if (sanitized === null) {
          if (!(terminalId in next)) {
            return state;
          }
          delete next[terminalId];
        } else {
          if (next[terminalId] === sanitized) {
            return state;
          }
          next[terminalId] = sanitized;
        }
        // Before the worktree state loads, a save would overwrite the saved
        // layout and the other terminals' names with this near-empty one.
        shouldPersist =
          state.worktrees[worktreeKey(projectId, worktreeId)]?.hydrated ===
          true;
        return { terminalCustomNames: next };
      });
      if (shouldPersist) {
        persistWorktreeState(
          projectId,
          worktreeId,
          undefined,
          clears ? [terminalId] : [],
        );
      }
    },

    setGroupName: (projectId, worktreeId, groupId, name): void => {
      for (const edits of pendingHydrationEdits.get(
        worktreeKey(projectId, worktreeId),
      ) ?? [])
        edits.groupNames.add(groupId);
      const sanitized = sanitizeCustomName(name);
      set((state) => {
        const next = { ...state.groupCustomNames };
        if (sanitized === null) {
          if (!(groupId in next)) {
            return state;
          }
          delete next[groupId];
        } else {
          if (next[groupId] === sanitized) {
            return state;
          }
          next[groupId] = sanitized;
        }
        return { groupCustomNames: next };
      });
      persistWorktreeState(projectId, worktreeId);
    },

    addGroupWithTerminal: (session, options): void => {
      set((state) => {
        const key = worktreeKey(session.projectId, session.worktreeId);
        const groupId = newGroupId();
        const { bucket, groupCustomNames } = assignTerminalGroup(
          state,
          key,
          session.id,
          groupId,
        );
        const ordinal = bucket.nextGroupOrdinal;
        publishTerminalLifecycle(key, session.id);
        const nextBucket: WorktreeTerminalBucket = {
          ...bucket,
          groups: [
            ...bucket.groups,
            {
              id: groupId,
              terminalIds: [session.id],
              focusedTerminalId: session.id,
              splitSizes: [1],
            },
          ],
          activeGroupId:
            options?.activate === false ? bucket.activeGroupId : groupId,
          nextGroupOrdinal: ordinal + 1,
          groupOrdinals: { ...bucket.groupOrdinals, [groupId]: ordinal },
          sessions: {
            ...bucket.sessions,
            [session.id]: createKnownSession(session, { live: true }),
          },
          hydrated: true,
        };
        return {
          worktrees: { ...state.worktrees, [key]: nextBucket },
          groupCustomNames,
        };
      });
      persistWorktreeState(session.projectId, session.worktreeId);
    },

    markTerminalLive: (session): void => {
      set((state) => {
        const key = worktreeKey(session.projectId, session.worktreeId);
        const bucket = state.worktrees[key];
        if (!bucket || bucket.sessions[session.id] === undefined) {
          return state;
        }

        const previous = bucket.sessions[session.id];
        publishTerminalLifecycle(key, session.id);
        const nextBucket: WorktreeTerminalBucket = {
          ...bucket,
          sessions: {
            ...bucket.sessions,
            [session.id]: createKnownSession(session, {
              live: true,
              scrollbackLines: previous.scrollbackLines,
              exitCode: null,
              signal: null,
            }),
          },
        };
        return { worktrees: { ...state.worktrees, [key]: nextBucket } };
      });
    },

    splitGroup: (projectId, worktreeId, groupId, session): void => {
      set((state) => {
        const key = worktreeKey(projectId, worktreeId);
        const currentBucket = state.worktrees[key];
        if (!currentBucket) {
          return state;
        }
        const group = currentBucket.groups.find(
          (entry) => entry.id === groupId,
        );
        if (!group) {
          return state;
        }
        const { bucket, groupCustomNames } = assignTerminalGroup(
          state,
          key,
          session.id,
          groupId,
        );
        publishTerminalLifecycle(key, session.id);
        const nextTerminalIds = group.terminalIds.includes(session.id)
          ? group.terminalIds
          : [...group.terminalIds, session.id];
        removedMemberships.get(key)?.get(groupId)?.delete(session.id);
        const nextGroup: TerminalGroup = {
          ...group,
          terminalIds: nextTerminalIds,
          focusedTerminalId: session.id,
          splitSizes: normalizeSplitSizes(
            nextTerminalIds.length,
            group.splitSizes,
          ),
        };
        const nextBucket: WorktreeTerminalBucket = {
          ...bucket,
          groups: bucket.groups.map((entry) =>
            entry.id === groupId ? nextGroup : entry,
          ),
          activeGroupId: groupId,
          sessions: {
            ...bucket.sessions,
            [session.id]: createKnownSession(session, { live: true }),
          },
        };
        return {
          worktrees: { ...state.worktrees, [key]: nextBucket },
          groupCustomNames,
        };
      });
      persistWorktreeState(projectId, worktreeId);
    },

    setFocusedTerminal: (projectId, worktreeId, groupId, terminalId): void => {
      set((state) => {
        const key = worktreeKey(projectId, worktreeId);
        const bucket = state.worktrees[key];
        if (!bucket) {
          return state;
        }
        const group = bucket.groups.find((entry) => entry.id === groupId);
        if (!group || !group.terminalIds.includes(terminalId)) {
          return state;
        }
        const nextBucket: WorktreeTerminalBucket = {
          ...bucket,
          groups: bucket.groups.map((entry) =>
            entry.id === groupId
              ? { ...entry, focusedTerminalId: terminalId }
              : entry,
          ),
          activeGroupId: groupId,
        };
        return { worktrees: { ...state.worktrees, [key]: nextBucket } };
      });
      persistWorktreeState(projectId, worktreeId);
    },

    setActiveGroup: (projectId, worktreeId, groupId): void => {
      set((state) => {
        const key = worktreeKey(projectId, worktreeId);
        const bucket = state.worktrees[key];
        if (!bucket || !bucket.groups.some((group) => group.id === groupId)) {
          return state;
        }
        return {
          worktrees: {
            ...state.worktrees,
            [key]: { ...bucket, activeGroupId: groupId },
          },
        };
      });
      persistWorktreeState(projectId, worktreeId);
    },

    setSplitSizes: (projectId, worktreeId, groupId, sizes): void => {
      set((state) => {
        const key = worktreeKey(projectId, worktreeId);
        const bucket = state.worktrees[key];
        if (!bucket) {
          return state;
        }
        const nextBucket: WorktreeTerminalBucket = {
          ...bucket,
          groups: bucket.groups.map((group) =>
            group.id === groupId
              ? {
                  ...group,
                  splitSizes: normalizeSplitSizes(
                    group.terminalIds.length,
                    sizes,
                  ),
                }
              : group,
          ),
        };
        return { worktrees: { ...state.worktrees, [key]: nextBucket } };
      });
      schedulePersistWorktreeState(
        projectId,
        worktreeId,
        SPLIT_SIZE_PERSIST_DEBOUNCE_MS,
      );
    },

    removeTerminal: (projectId, worktreeId, terminalId): void => {
      set((state) => {
        const key = worktreeKey(projectId, worktreeId);
        const bucket = state.worktrees[key];
        if (!bucket) {
          return state;
        }

        let removedGroupId: string | null = null;
        const rebuiltGroups: TerminalGroup[] = [];
        for (const group of bucket.groups) {
          if (!group.terminalIds.includes(terminalId)) {
            rebuiltGroups.push(group);
            continue;
          }

          retireMemberships(key, group.id, [terminalId]);

          const nextTerminalIds = group.terminalIds.filter(
            (id) => id !== terminalId,
          );
          if (nextTerminalIds.length === 0) {
            removedGroupId = group.id;
            continue;
          }

          const nextFocusedTerminalId =
            group.focusedTerminalId === terminalId
              ? nextTerminalIds[0]
              : group.focusedTerminalId;
          rebuiltGroups.push({
            ...group,
            terminalIds: nextTerminalIds,
            focusedTerminalId: nextFocusedTerminalId,
            splitSizes: normalizeSplitSizes(nextTerminalIds.length),
          });
        }

        const nextGroupOrdinals = { ...bucket.groupOrdinals };
        if (removedGroupId !== null) {
          delete nextGroupOrdinals[removedGroupId];
        }

        const nextSessions = { ...bucket.sessions };
        delete nextSessions[terminalId];
        publishTerminalLifecycle(key, terminalId, true);

        const nextTerminalCustomNames = { ...state.terminalCustomNames };
        delete nextTerminalCustomNames[terminalId];

        const nextGroupCustomNames = { ...state.groupCustomNames };
        if (removedGroupId !== null) {
          delete nextGroupCustomNames[removedGroupId];
        }

        const nextActiveGroupId =
          removedGroupId !== null && bucket.activeGroupId === removedGroupId
            ? (rebuiltGroups[0]?.id ?? null)
            : bucket.activeGroupId;

        return {
          worktrees: {
            ...state.worktrees,
            [key]: {
              ...bucket,
              groups: rebuiltGroups,
              activeGroupId: nextActiveGroupId,
              groupOrdinals: nextGroupOrdinals,
              sessions: nextSessions,
            },
          },
          terminalCustomNames: nextTerminalCustomNames,
          groupCustomNames: nextGroupCustomNames,
        };
      });
      // Drop the matching activity entry so the indicator does not stay pinned
      // forever after the terminal is removed from the drawer.
      useTerminalActivityStore
        .getState()
        .handleTerminalRemoved(projectId, worktreeId, terminalId);
      notifyTerminalRemoved(projectId, worktreeId, terminalId);
      persistWorktreeState(projectId, worktreeId, [terminalId]);
    },

    removeGroup: (projectId, worktreeId, groupId): void => {
      const bucket = get().worktrees[worktreeKey(projectId, worktreeId)];
      if (!bucket) {
        return;
      }

      const group = bucket.groups.find((entry) => entry.id === groupId);
      if (!group) {
        return;
      }

      for (const terminalId of group.terminalIds) {
        const session = bucket.sessions[terminalId];
        if (session?.live) {
          // Mark BEFORE the kill so the resulting SIGKILL `terminalExit` is
          // suppressed by the activity store / toasts hook.
          useTerminalActivityStore
            .getState()
            .markUserInitiatedClose(terminalId);
          void getClient().command('terminal.kill', { terminalId });
        }
      }

      set((state) => {
        const key = worktreeKey(projectId, worktreeId);
        const current = state.worktrees[key];
        if (!current) {
          return state;
        }

        const removedIndex = current.groups.findIndex(
          (entry) => entry.id === groupId,
        );
        const nextGroups = current.groups.filter(
          (entry) => entry.id !== groupId,
        );
        const nextSessions = { ...current.sessions };
        retireMemberships(key, groupId, group.terminalIds);
        const nextTerminalCustomNames = { ...state.terminalCustomNames };
        for (const terminalId of group.terminalIds) {
          delete nextSessions[terminalId];
          publishTerminalLifecycle(key, terminalId, true);
          delete nextTerminalCustomNames[terminalId];
        }

        const nextGroupOrdinals = { ...current.groupOrdinals };
        delete nextGroupOrdinals[groupId];
        const nextGroupCustomNames = { ...state.groupCustomNames };
        delete nextGroupCustomNames[groupId];

        return {
          worktrees: {
            ...state.worktrees,
            [key]: {
              ...current,
              groups: nextGroups,
              activeGroupId:
                current.activeGroupId === groupId
                  ? // Focus the neighbor (the tab to the left), not the first
                    // tab: [1,2,3,4] close active 4 → 3, not 1.
                    (nextGroups[Math.max(0, removedIndex - 1)]?.id ?? null)
                  : current.activeGroupId,
              groupOrdinals: nextGroupOrdinals,
              sessions: nextSessions,
            },
          },
          terminalCustomNames: nextTerminalCustomNames,
          groupCustomNames: nextGroupCustomNames,
        };
      });
      // Drop the matching activity entries so the indicator does not stay
      // pinned forever after the group is removed from the drawer.
      for (const terminalId of group.terminalIds) {
        useTerminalActivityStore
          .getState()
          .handleTerminalRemoved(projectId, worktreeId, terminalId);
        notifyTerminalRemoved(projectId, worktreeId, terminalId);
      }
      persistWorktreeState(projectId, worktreeId, [...group.terminalIds]);
    },

    applyExit: (event): void => {
      set((state) => {
        const key = worktreeKey(event.projectId, event.worktreeId);
        if (removedTerminals.get(key)?.has(event.terminalId)) return state;
        // Unknown exits are retained only by outstanding reads, not an
        // unbounded global dictionary of undiscovered terminal IDs.
        for (const edits of pendingHydrationEdits.get(key) ?? [])
          edits.exits.set(event.terminalId, event);
        const bucket = state.worktrees[key];
        if (!bucket) {
          return state;
        }

        const session = bucket.sessions[event.terminalId];
        if (!session) {
          return state;
        }

        publishTerminalLifecycle(key, event.terminalId);
        const nextBucket: WorktreeTerminalBucket = {
          ...bucket,
          sessions: {
            ...bucket.sessions,
            [event.terminalId]: {
              ...session,
              live: false,
              exitCode: event.exitCode,
              signal: event.signal,
            },
          },
        };
        return { worktrees: { ...state.worktrees, [key]: nextBucket } };
      });
    },
  }));

  function ensureHydrated(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    const key = worktreeKey(projectId, worktreeId);
    const bucket = store.getState().worktrees[key];
    if (bucket?.hydrated) {
      return Promise.resolve();
    }

    const existing = hydrationPromises.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const hydrationPromise = store
      .getState()
      .hydrateWorktree(projectId, worktreeId)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (hydrationPromises.get(key) === hydrationPromise)
          hydrationPromises.delete(key);
        throw error;
      });
    hydrationPromises.set(key, hydrationPromise);
    return hydrationPromise;
  }

  function purgeWorktrees(worktreeIds: readonly string[]): void {
    const state = store.getState();
    const worktrees = { ...state.worktrees };
    const terminalCustomNames = { ...state.terminalCustomNames };
    const groupCustomNames = { ...state.groupCustomNames };
    const removed: KnownTerminalSession[] = [];
    const keys = new Set([
      ...Object.keys(worktrees),
      ...Array.from(worktreeGenerations.keys()),
      ...Array.from(persistTimers.keys()),
      ...Array.from(hydrationPromises.keys()),
    ]);
    for (const key of Array.from(keys)) {
      if (!worktreeIds.some((id) => key.endsWith(`/${id}`))) continue;
      worktreeGenerations.set(key, (worktreeGenerations.get(key) ?? 0) + 1);
      terminalLifecycleVersions.delete(key);
      removedTerminals.delete(key);
      removedMemberships.delete(key);
      pendingHydrationEdits.delete(key);
      historyOutages.delete(key);
      historyObservers.get(key)?.stop();
      historyObservers.delete(key);
      clearPersistTimer(key);
      hydrationPromises.delete(key);
      manualHistoryLoads.delete(key);
      const bucket = worktrees[key];
      if (bucket) {
        for (const session of Object.values(bucket.sessions)) {
          delete terminalCustomNames[session.id];
          removed.push(session);
        }
        for (const group of bucket.groups) delete groupCustomNames[group.id];
      }
      delete worktrees[key];
    }
    store.setState({ worktrees, terminalCustomNames, groupCustomNames });
    for (const { projectId, worktreeId, id } of removed) {
      useTerminalActivityStore
        .getState()
        .handleTerminalRemoved(projectId, worktreeId, id);
      notifyTerminalRemoved(projectId, worktreeId, id);
    }
  }

  function reset(): void {
    generation += 1;
    for (const key of Array.from(persistTimers.keys())) clearPersistTimer(key);
    hydrationPromises.clear();
    manualHistoryLoads.clear();
    hydrationSequences.clear();
    terminalLifecycleVersions.clear();
    removedTerminals.clear();
    removedMemberships.clear();
    pendingHydrationEdits.clear();
    historyOutages.clear();
    worktreeGenerations.clear();
    for (const observer of historyObservers.values()) observer.stop();
    historyObservers.clear();
    store.setState({
      worktrees: {},
      terminalCustomNames: {},
      groupCustomNames: {},
    });
  }
  return { store, ensureHydrated, reset, purgeWorktrees, observeHistory };
}

const terminalStore = createTerminalStore(requireTerminalClient);
export const useTerminalStore = terminalStore.store;
export const ensureTerminalWorktreeHydrated = terminalStore.ensureHydrated;
export const purgeTerminalWorktrees = terminalStore.purgeWorktrees;
export const observeTerminalHistory = terminalStore.observeHistory;
registerTerminalClientReset(terminalStore.reset);
export {
  ensureTerminalExitSubscription,
  resetTerminalExitSubscriptionForTesting,
} from './terminal-exit-subscription';

// ---------------------------------------------------------------------------
// Selectors / derived helpers
// ---------------------------------------------------------------------------

/**
 * Derive the display label for a group. Groups with ≥2 terminals are rendered
 * as `SPLIT N`; single-pane groups as `TERMINAL N`. `N` is the group's stable
 * ordinal, preserved across deletes.
 */
export function formatGroupLabel(
  group: Pick<TerminalGroup, 'terminalIds'>,
  ordinal: number,
): string {
  const kind = group.terminalIds.length >= 2 ? 'SPLIT' : 'TERMINAL';
  return `${kind} ${ordinal}`;
}

/**
 * What a terminal row's label is resolved from: the worktree's groups and
 * their stable ordinals (a bucket's `groups` / `groupOrdinals`) plus the
 * user-assigned names. No session output is involved.
 */
export interface TerminalRowLabelSources {
  readonly terminalCustomNames: Readonly<Record<string, string>>;
  readonly groupCustomNames: Readonly<Record<string, string>>;
  readonly groupOrdinals: Readonly<Record<string, number>>;
  readonly groups: readonly Pick<TerminalGroup, 'id' | 'terminalIds'>[];
}

/**
 * Display label for one terminal in a worktree's terminal status popover:
 * the terminal's custom name, else its group's custom name, else the group's
 * `TERMINAL N` / `SPLIT N` label, else `TERMINAL`. `groupId` is the group the
 * caller already knows (an activity entry's); when it is null, the group that
 * holds the terminal is looked up in `sources.groups`.
 */
export function resolveTerminalRowLabel(
  terminalId: string,
  groupId: string | null,
  sources: TerminalRowLabelSources,
): string {
  const customTerminalName = sources.terminalCustomNames[terminalId];
  if (customTerminalName) {
    return customTerminalName;
  }
  const resolvedGroupId =
    groupId ?? groupIdForTerminal(terminalId, sources.groups);
  if (resolvedGroupId) {
    const customGroupName = sources.groupCustomNames[resolvedGroupId];
    if (customGroupName) {
      return customGroupName;
    }
    const ordinal = sources.groupOrdinals[resolvedGroupId];
    const group = sources.groups.find(
      (candidate) => candidate.id === resolvedGroupId,
    );
    if (group && typeof ordinal === 'number') {
      return formatGroupLabel(group, ordinal);
    }
  }
  return 'TERMINAL';
}

/** The last group listing the terminal, matching a terminal→group index. */
function groupIdForTerminal(
  terminalId: string,
  groups: TerminalRowLabelSources['groups'],
): string | null {
  let found: string | null = null;
  for (const group of groups) {
    if (group.terminalIds.includes(terminalId)) {
      found = group.id;
    }
  }
  return found;
}

/**
 * Whether a loaded worktree has the terminal outside every group. Desktop
 * saves names only for grouped terminals, so such a terminal can't be renamed.
 */
export function isUngroupedTerminal(
  state: Pick<TerminalState, 'worktrees'>,
  terminalId: string,
): boolean {
  return Object.values(state.worktrees).some(
    (bucket) =>
      bucket.sessions[terminalId] !== undefined &&
      !bucket.groups.some((group) => group.terminalIds.includes(terminalId)),
  );
}

/** Return the bucket for a worktree, or `undefined` if none exists yet. */
export function selectBucket(
  state: TerminalState,
  projectId: string,
  worktreeId: string,
): WorktreeTerminalBucket | undefined {
  return state.worktrees[worktreeKey(projectId, worktreeId)];
}
