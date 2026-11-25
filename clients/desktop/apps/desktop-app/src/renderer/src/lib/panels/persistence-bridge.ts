/**
 * Panel-layout persistence bridge (Phase 5, extended in Phase 9) — the single
 * renderer seam between the panel layout store and `window.api.panelLayout`.
 *
 * This deliberately lives OUTSIDE `panelLayoutStore`: the store stays a pure
 * grid model whose unit tests run without a preload bridge, and persistence
 * policy (debounce, aux folding, popped-out orchestration) has exactly one
 * module to evolve (compare `chatStore`'s in-store `scheduleSave`, which
 * predates that concern).
 *
 * Responsibilities:
 *
 * - **Restore-or-default** ({@link ensureWorktreePanelLayout}): on the first
 *   open of a worktree key, load `panel-layout.json` through IPC and rebuild
 *   the grid via `restoreLayout` (which validates with `migratePanelLayout`);
 *   fall back to {@link ensureDefaultWorktreeLayout} for missing/corrupt
 *   files or IPC failures. The load is awaited BEFORE anything is built, so
 *   the grid mounts exactly once — no default-then-restore flash. Both this
 *   path and {@link applySavedDefaultLayout}'s saved-template load run the
 *   raw parsed JSON through `sanitizeRawPlanPanelBindings` BEFORE
 *   `migratePanelLayout`: the protocol validator rejects a shape-invalid
 *   plan `instance` by failing the WHOLE file, so plan-only entries are
 *   sanitized pre-migration and shape-valid-but-invalid/duplicate plan
 *   entries stay pruned post-migration by `pruneInvalidBoundPanelEntries`.
 * - **Popped-out window restore** (Phase 9, parent-orchestrated per doc 05
 *   §7.5 / doc 10 D4): after a successful main-grid restore, every persisted
 *   `poppedOut` entry is handed to `restorePoppedWindow`, which re-opens the
 *   aux OS window at its persisted bounds and rebuilds its layout — or, when
 *   the window cannot be opened, merges the entry's tabs back into the
 *   worktree layout (the data-loss guard). A merge-back schedules an
 *   immediate save so the file stops claiming the window is popped out.
 * - **Debounced save**: a store subscription schedules a 500ms-debounced
 *   (chatStore `scheduleSave` convention) `serializeLayout` save whenever a
 *   hydrated worktree's layout record commits or its size-only grid revision
 *   bumps. Topology `revision` bumps and tab/active/MRU changes both produce a
 *   new record object, so record identity is the trigger for those changes;
 *   sash/container/even-arrange size changes mutate the grid in place and use
 *   the store's `layoutSizeRevisions` signal. Auxiliary-window layout commits
 *   (`${worktreeKey}#aux:*`) FOLD into the owning worktree's debounced save:
 *   there is exactly one `panel-layout.json` per worktree, whose `poppedOut`
 *   section snapshots every open aux window (grid + OS bounds) at save time.
 *   Hydration gating keeps the restore/default commits themselves from
 *   echoing a save.
 * - **Dispose**: `disposeLayout` (worktree archive) cancels any pending save
 *   so a trailing debounce cannot resurrect a file that main-process worktree
 *   cleanup just deleted. File deletion itself is main's job
 *   (`worktree-data-cleanup.ts` removes the whole `worktree-data/{worktreeId}`
 *   tree); the renderer never deletes.
 *
 * Two later additions close former gaps:
 *
 * - **Aux bounds watch** ({@link createAuxWindowBoundsWatcher}): moving or
 *   resizing an aux OS window commits nothing in the layout store, so
 *   `AuxPanelWindow` drives a snapshot-compare watcher from its existing
 *   500ms close-poll tick (plus the child's `resize` event) that dirties the
 *   owning worktree's debounced save via {@link schedulePanelLayoutSave};
 *   bounds are still read live at save time.
 * - **Teardown flush** ({@link flushPendingPanelLayoutSaves}): a quit landing
 *   inside the 500ms debounce window used to lose the last change; `pagehide`
 *   / `beforeunload` listeners (installed once with the save subscription)
 *   now fire every pending save immediately.
 */
import {
  migratePanelLayout,
  type SerializablePanelLayoutFile,
  type SerializedPoppedPanelWindow,
} from '@canopy/protocol';
import {
  forkPanelLayoutForTabs,
  type ForkedPanelTabBinding,
} from '@canopy/desktop-shared/panels/fork-layout';
import {
  getAuxPanelLayoutOwnerKey,
  getPanelInstanceKey,
  isAuxPanelLayoutKey,
  pruneInvalidBoundPanelEntries,
  sanitizeRawPlanPanelBindings,
  usePanelLayoutStore,
  type WorktreePanelLayout,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { closeOmittedTerminalBinding } from '@/lib/panels/terminal-panel-sync';
import { requestBrowserSessionDestruction } from '@/lib/panels/browser-panel-sync';
import { releaseOmittedPipelinePanelUi } from '@/lib/panels/pipeline-panel-sync';
import {
  activeChatTabSeed,
  ensureDefaultWorktreeLayout,
} from './default-layout';
import { DEFAULT_TERMINAL_GROUP_ID } from './panel-group-ids';
import { retargetTemplateForWorktree } from './default-layout-template';
import {
  prepareBrowserPanelMigration,
  readBrowserStateAhead,
} from './browser-panel-migration';
import {
  dropWorktreeLayoutReadAhead,
  readWorktreeLayoutAhead,
  savedWorktreeLayoutReadAhead,
  worktreeLayoutReadAheadSettled,
  worktreeModeReadAhead,
} from './layout-read-ahead';
import { panelSurfaceForWorktreeKey } from './panel-surface';
import {
  hideOptionalMinimalRegions,
  isMinimalLayoutShape,
  planMinimalLayout,
  repairMinimalLayout,
  type MinimalAuxiliaryLayoutSource,
} from './minimal-layout';
import { usesSimplifiedMinimalDefaults } from './minimal-layout-defaults';
import { withoutEphemeralPanels } from './ephemeral-panels';
import { useChatStore } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useBrowserStore } from '@/stores/browserStore';
import {
  ensureTerminalWorktreeHydrated,
  useTerminalStore,
} from '@/stores/terminalStore';
import { ensureTerminalDrawerExitSubscription } from '@/components/terminal/terminalDrawerExitSubscription';
import { chatTabToPanelSeed } from './chat-panel-binding';
import { browserPanelIdFor } from './browser-panel-identity';
import { terminalPanelIdFor } from './terminal-panel-identity';
import {
  getWorkspaceLayoutMode,
  useWorkspaceLayoutModeStore,
} from '@/stores/workspaceLayoutModeStore';
import { maybeOpenStartPage } from './start-page';
import { webCorePanelLayouts } from './panel-layout-storage';
import { isWebCoreScope } from '@/lib/chat-authority';
import {
  ensureScopePanelRules,
  layoutScopeServesPanelKind,
  removeScopeUnavailablePanels,
} from './scope-panel-kinds';
import {
  advancePanelHydrationGeneration,
  isPanelHydrationGenerationCurrent,
  panelHydrationGeneration,
} from './hydration-generation';
export { saveCurrentLayoutAsDefault } from './default-layout-save';

/** Matches the chatStore `scheduleSave` debounce for persisted UI state. */
const SAVE_DEBOUNCE_MS = 500;

/** Keys whose restore-or-default completed; only these schedule saves. */
const hydratedKeys = new Set<string>();
/** In-flight restore-or-default work, deduped per key. */
const ensurePromises = new Map<string, Promise<void>>();
/** Pending debounced saves, keyed per worktree key. */
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Worktree keys whose panel-layout persistence is SUSPENDED (failed browser
 * migration recovery — see `browser-panel-migration.ts`). Suspended keys
 * schedule no saves, so the untouched on-disk files re-enter recovery on the
 * next launch; a successful hydration Retry resumes persistence.
 */
const suspendedKeys = new Set<string>();

// Automatic host sizing and focus restore do not customize a fresh entry.
const customizedKeys = new Set<string>();
const layoutDimensions = new Map<string, { width: number; height: number }>();
const inFlightSaves = new Map<string, Promise<void>>();
const failedSaves = new Set<string>();
const automaticSaveKeys = new Map<string, number>();

async function withAutomaticLayoutChanges<T>(
  worktreeKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  automaticSaveKeys.set(
    worktreeKey,
    (automaticSaveKeys.get(worktreeKey) ?? 0) + 1,
  );
  try {
    return await operation();
  } finally {
    const remaining = (automaticSaveKeys.get(worktreeKey) ?? 1) - 1;
    if (remaining === 0) automaticSaveKeys.delete(worktreeKey);
    else automaticSaveKeys.set(worktreeKey, remaining);
  }
}

function rememberLayoutDimensions(worktreeKey: string): void {
  const grid = usePanelLayoutStore.getState().layouts[worktreeKey]?.grid;
  if (grid)
    layoutDimensions.set(worktreeKey, {
      width: grid.width,
      height: grid.height,
    });
}

function groupContent(layout: WorktreePanelLayout): string {
  return JSON.stringify(
    Object.entries(layout.groups).map(([id, group]) => ({
      id,
      tabs: group.tabs,
      activePanelId: group.activePanelId,
      collapsed: group.collapsed
        ? { edge: group.collapsed.edge, auto: group.collapsed.auto }
        : null,
    })),
  );
}

let unsubscribe: (() => void) | null = null;
let previousLayouts: Record<string, WorktreePanelLayout> = {};
let previousLayoutSizeRevisions: Record<string, number> = {};

/**
 * Splits a `${projectId}/${worktreeId}` worktree key (ids match
 * `/^[a-z0-9][a-z0-9-]*$/`, so the first `/` is unambiguous).
 */
function splitWorktreeKey(worktreeKey: string): {
  projectId: string;
  worktreeId: string;
} {
  const separator = worktreeKey.indexOf('/');
  return {
    projectId: worktreeKey.slice(0, separator),
    worktreeId: worktreeKey.slice(separator + 1),
  };
}

function reconcileMinimalContent(
  worktreeKey: string,
  persisted: SerializablePanelLayoutFile,
): {
  current: SerializablePanelLayoutFile;
  auxiliary: MinimalAuxiliaryLayoutSource[];
  missing: SerializablePanelLayoutFile[];
} {
  const chatScope = useChatStore.getState().worktreeChats[worktreeKey];
  const terminalBucket = useTerminalStore.getState().worktrees[worktreeKey];
  const livePanels = [
    ...(chatScope?.tabs ?? []).map(chatTabToPanelSeed),
    ...(
      useBrowserStore.getState().worktrees[worktreeKey]?.browserOrder ?? []
    ).map((browserId) => ({
      panelId: browserPanelIdFor(browserId),
      kind: 'browser' as const,
      instance: { browserId },
    })),
    ...Object.keys(terminalBucket?.sessions ?? {}).map((terminalId) => ({
      panelId: terminalPanelIdFor(terminalId),
      kind: 'terminal' as const,
      instance: { terminalId },
    })),
  ];
  const liveKeys = new Set(
    livePanels.map((panel) => getPanelInstanceKey(panel)),
  );
  // One retained panel per instance key across the main grid and every
  // popped-out grid (main first, then windows in file order). This is what
  // keeps `pipeline-execution` and `subagent-chat` bindings unique when
  // Minimal folds auxiliary windows into the main grid. Neither kind has a
  // live source to reconcile against, so they are not dynamic kinds:
  // persisted tabs are kept as-is rather than dropped for being absent from
  // a live store.
  const retainedKeys = new Set<string>();
  const dynamicKinds = new Set(['chat', 'file-diff', 'browser', 'terminal']);
  const retainPanel = (
    panel: Parameters<typeof getPanelInstanceKey>[0],
  ): boolean => {
    const key = getPanelInstanceKey(panel);
    if (retainedKeys.has(key)) return false;
    if (dynamicKinds.has(panel.kind)) {
      if (panel.kind === 'terminal' && terminalBucket?.hydrated !== true) {
        retainedKeys.add(key);
        return true;
      }
      if (
        (panel.kind === 'chat' || panel.kind === 'file-diff') &&
        chatScope === undefined
      ) {
        retainedKeys.add(key);
        return true;
      }
      if (!liveKeys.has(key)) return false;
    }
    retainedKeys.add(key);
    return true;
  };
  const filterNode = (
    node: SerializablePanelLayoutFile['grid']['root'],
  ): SerializablePanelLayoutFile['grid']['root'] => {
    if (node.type === 'branch') {
      return { ...node, children: node.children.map(filterNode) };
    }
    const panels = node.panels.filter(retainPanel);
    return { ...node, panels };
  };
  const current: SerializablePanelLayoutFile = {
    ...persisted,
    grid: { ...persisted.grid, root: filterNode(persisted.grid.root) },
  };
  const auxiliary = (persisted.poppedOut ?? []).map((entry) => ({
    layout: {
      version: 1 as const,
      grid: { ...entry.grid, root: filterNode(entry.grid.root) },
      activeGroupId: entry.activeGroupId ?? entry.sourceGroupId,
      mostRecentActiveGroupIds: entry.mostRecentActiveGroupIds ?? [
        entry.sourceGroupId,
      ],
    },
    sourceWasBottom:
      entry.sourceGroupId === DEFAULT_TERMINAL_GROUP_ID ||
      entry.returnTarget?.direction === 'down',
  }));
  const missingPanels = livePanels.filter(
    (panel) => !retainedKeys.has(getPanelInstanceKey(panel)),
  );
  const missing: SerializablePanelLayoutFile = {
    version: 1,
    grid: {
      orientation: 1,
      width: 1200,
      height: 800,
      root: {
        type: 'leaf',
        groupId: 'group-live-content-source',
        panels: missingPanels,
        activePanelId: null,
        size: 600,
      },
    },
    activeGroupId: 'group-live-content-source',
    mostRecentActiveGroupIds: ['group-live-content-source'],
  };
  return {
    current,
    auxiliary,
    missing: missingPanels.length > 0 ? [missing] : [],
  };
}

function canonicalLiveMinimalLayout(
  worktreeKey: string,
  persisted: SerializablePanelLayoutFile,
): SerializablePanelLayoutFile {
  const { current, auxiliary, missing } = reconcileMinimalContent(
    worktreeKey,
    persisted,
  );
  return repairMinimalLayout(current, [...auxiliary, ...missing], {
    // Minimal adds nothing to the Side Panel and keeps what it holds.
    seedSidePanels: !usesSimplifiedMinimalDefaults(worktreeKey),
  });
}

/**
 * Minimal layout for a worktree being opened. A Minimal-shaped layout keeps
 * its tabs, order, and hidden or shown regions. Under early access, a layout
 * converted to Minimal here for the first time (a Minimal worktree whose
 * saved layout is not Minimal-shaped yet) starts with the Side Panel and
 * Bottom Drawer hidden.
 */
function minimalLayoutOnLoad(
  worktreeKey: string,
  persisted: SerializablePanelLayoutFile,
): SerializablePanelLayoutFile {
  const canonical = canonicalLiveMinimalLayout(worktreeKey, persisted);
  const hide =
    usesSimplifiedMinimalDefaults(worktreeKey) &&
    !isMinimalLayoutShape(persisted);
  return hide ? hideOptionalMinimalRegions(canonical) : canonical;
}

/**
 * Each worktree's last Minimal repair on revisit: the file handed to
 * `restoreLayout` and the layout that came out of it, both serialized.
 */
const minimalRevisitRepairs = new Map<
  string,
  { readonly file: string; readonly result: string }
>();

function layoutServesEveryPanelKind(
  worktreeKey: string,
  file: SerializablePanelLayoutFile,
): boolean {
  const servesNode = (
    node: SerializablePanelLayoutFile['grid']['root'],
  ): boolean =>
    node.type === 'branch'
      ? node.children.every(servesNode)
      : node.panels.every((panel) =>
          layoutScopeServesPanelKind(worktreeKey, panel.kind),
        );
  return servesNode(file.grid.root);
}

/**
 * Brings a Minimal worktree's in-memory layout back to Minimal's shape when
 * the worktree is shown again: tabs of closed chats, terminals and browsers
 * go, new ones arrive, and a group the layout lost is rebuilt.
 *
 * `restoreLayout` rebuilds the whole grid, which re-renders every panel of
 * the worktree a second time on each switch. So the rebuild is skipped when
 * it is known to change nothing: the layout is exactly what the last repair
 * left, and repairing it gives exactly the file that repair restored from.
 * `restoreLayout` builds its result from that file alone (plus the kinds the
 * scope refuses, checked here), so it would build the same layout again.
 * Anything else (a moved tab, a resized group, a new chat) runs the rebuild.
 */
function repairMinimalLayoutOnRevisit(worktreeKey: string): boolean {
  const store = usePanelLayoutStore.getState();
  const current = store.serializeLayout(worktreeKey);
  if (current === null) return false;
  const repaired = minimalLayoutOnLoad(worktreeKey, current);
  const file = JSON.stringify(repaired);
  const known = minimalRevisitRepairs.get(worktreeKey);
  if (
    known !== undefined &&
    known.file === file &&
    known.result === JSON.stringify(current) &&
    layoutServesEveryPanelKind(worktreeKey, repaired)
  ) {
    return true;
  }
  minimalRevisitRepairs.delete(worktreeKey);
  if (!store.restoreLayout(worktreeKey, repaired)) return true;
  const result = usePanelLayoutStore.getState().serializeLayout(worktreeKey);
  if (result !== null) {
    minimalRevisitRepairs.set(worktreeKey, {
      file,
      result: JSON.stringify(result),
    });
  }
  return true;
}

function cancelPendingSave(worktreeKey: string): void {
  const timer = pendingSaves.get(worktreeKey);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingSaves.delete(worktreeKey);
  }
}

/** Fallback persisted bounds when the live read yields unusable numbers
 * (matches the fresh pop-out `window.open` size; restore clamps to a
 * visible display in main, so `0,0` is safe). */
const AUX_BOUNDS_FALLBACK = { x: 0, y: 0, width: 900, height: 600 } as const;

/**
 * The subset of `Window` the aux bounds reads need. Structural on purpose so
 * unit tests can drive the bounds watcher with a plain fake instead of a
 * realm-real `Window`.
 */
export type AuxWindowBoundsSource = Pick<
  Window,
  'closed' | 'screenX' | 'screenY' | 'outerWidth' | 'outerHeight'
>;

/**
 * Live OS bounds of an aux child window, read from the opener realm
 * (`about:blank` children are same-origin, so `screenX`/`outerWidth` & co.
 * are directly readable). Returns `null` only when the window is already
 * closed or the cross-window read throws mid-teardown — the entry is then
 * skipped, because a closing window's tabs are about to merge back anyway.
 * Unusable (non-finite) reads fall back to defaults instead of dropping the
 * entry: losing bounds fidelity beats losing the popped-out tabs.
 */
function readAuxWindowBounds(
  childWindow: AuxWindowBoundsSource,
): SerializedPoppedPanelWindow['bounds'] | null {
  try {
    if (childWindow.closed) {
      return null;
    }
    const bounds = {
      x: childWindow.screenX,
      y: childWindow.screenY,
      width: childWindow.outerWidth,
      height: childWindow.outerHeight,
    };
    return Object.values(bounds).every((value) => Number.isFinite(value))
      ? bounds
      : AUX_BOUNDS_FALLBACK;
  } catch {
    return null;
  }
}

/**
 * Snapshots every open aux window of `worktreeKey` into persisted
 * `poppedOut` entries: the aux layout serialized through the SAME
 * `serializeLayout` path as the main grid (its leaves carry the tab
 * metadata), plus the window's live OS bounds and merge-back target.
 */
function collectPoppedOutWindows(
  worktreeKey: string,
): SerializedPoppedPanelWindow[] {
  const layoutStore = usePanelLayoutStore.getState();
  const entries: SerializedPoppedPanelWindow[] = [];
  for (const record of Object.values(
    usePanelWindowsStore.getState().auxWindows,
  )) {
    if (record.worktreeKey !== worktreeKey || record.status !== 'open') {
      continue;
    }
    const auxFile = layoutStore.serializeLayout(record.layoutKey);
    if (auxFile === null) {
      continue;
    }
    const bounds = readAuxWindowBounds(record.childWindow);
    if (bounds === null) {
      continue;
    }
    entries.push({
      windowId: record.auxWindowId,
      grid: auxFile.grid,
      bounds,
      sourceGroupId: record.sourceGroupId,
      ...(record.returnTarget !== undefined
        ? { returnTarget: record.returnTarget }
        : {}),
      activeGroupId: auxFile.activeGroupId,
      mostRecentActiveGroupIds: auxFile.mostRecentActiveGroupIds,
    });
  }
  return entries;
}

function snapshotLiveWorktreePanelLayout(
  worktreeKey: string,
): SerializablePanelLayoutFile | null {
  const file = usePanelLayoutStore.getState().serializeLayout(worktreeKey);
  if (file === null) return null;
  const poppedOut = collectPoppedOutWindows(worktreeKey);
  // New tabs are never written (older builds reject the kind).
  return withoutEphemeralPanels(
    poppedOut.length > 0 ? { ...file, poppedOut } : file,
  );
}

function saveNow(worktreeKey: string): Promise<void> {
  // Single-writer property (doc 10 A4), documented at the one save entry
  // point: exactly ONE main window exists per app instance, it owns every
  // aux child window (children are script-less `about:blank` documents whose
  // layouts live in THIS renderer's stores), and every panel-layout write
  // flows through this module. No election is needed under the current
  // one-main-window architecture — the property holds structurally. If a
  // second MAIN window (not aux child) ever renders worktree layouts, saves
  // must be routed through an elected owner per worktree key instead of
  // writing directly (see chatStore's `isSentinelWriteAllowed` gate for the
  // existing pattern).
  const file = snapshotLiveWorktreePanelLayout(worktreeKey);
  if (file === null) {
    return Promise.resolve();
  }
  const { projectId, worktreeId } = splitWorktreeKey(worktreeKey);
  const hasUserChanges = customizedKeys.has(worktreeKey);
  const request = { projectId, worktreeId, layout: file, hasUserChanges };
  // A layout read ahead before this save no longer says what is saved. It is
  // dropped again once the save settles, for a read that went out meanwhile.
  dropWorktreeLayoutReadAhead(worktreeKey);
  const promise = isWebCoreScope(projectId)
    ? Promise.resolve(webCorePanelLayouts.saveLayout(request))
    : window.api.panelLayout.saveWorktreeLayout(request);
  inFlightSaves.set(worktreeKey, promise);
  void promise.then(
    () => {
      dropWorktreeLayoutReadAhead(worktreeKey);
      if (inFlightSaves.get(worktreeKey) === promise)
        failedSaves.delete(worktreeKey);
      if (hasUserChanges) {
        useStandaloneChatStore
          .getState()
          .markWorkEntryCustomized(projectId, worktreeId);
      }
      if (inFlightSaves.get(worktreeKey) === promise)
        inFlightSaves.delete(worktreeKey);
    },
    () => {
      dropWorktreeLayoutReadAhead(worktreeKey);
      if (inFlightSaves.get(worktreeKey) === promise) {
        inFlightSaves.delete(worktreeKey);
        failedSaves.add(worktreeKey);
      }
    },
  );
  return promise;
}

export interface ForkWorktreePanelLayoutRequest {
  readonly projectId: string;
  readonly sourceWorktreeId: string;
  readonly destinationWorktreeId: string;
  readonly tabBindings: ReadonlyMap<string, ForkedPanelTabBinding>;
}

/**
 * Copies the source worktree's current panel layout to a newly-created
 * worktree, remapping every chat/file panel to its cloned destination tab.
 * A live source snapshot wins over disk so a branch action cannot miss the
 * user's most recent split, reorder, resize, or pop-out change.
 */
export async function forkWorktreePanelLayout({
  projectId,
  sourceWorktreeId,
  destinationWorktreeId,
  tabBindings,
}: ForkWorktreePanelLayoutRequest): Promise<boolean> {
  installSaveSubscription();
  const sourceKey = `${projectId}/${sourceWorktreeId}`;
  const destinationKey = `${projectId}/${destinationWorktreeId}`;
  let source: unknown = snapshotLiveWorktreePanelLayout(sourceKey);
  if (source === null) {
    try {
      source = (
        await window.api.panelLayout.loadWorktreeLayout({
          projectId,
          worktreeId: sourceWorktreeId,
        })
      ).layout;
    } catch {
      return false;
    }
  }

  const layout = forkPanelLayoutForTabs(source, tabBindings, {
    nextAuxWindowId: () => {
      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2);
      return `aux-${id}`;
    },
  });
  if (layout === null) return false;

  // A newly registered worktree can already have mounted a default layout in
  // the background. Remove it before persisting the copy so selection takes
  // the normal restore path and mounts the copied grid exactly once.
  cancelPendingSave(destinationKey);
  usePanelWindowsStore.getState().disposeWorktreeAuxWindows(destinationKey);
  usePanelLayoutStore.getState().disposeLayout(destinationKey);
  hydratedKeys.delete(destinationKey);
  // The copy replaces whatever was read ahead for the destination, before
  // the save and for a read that went out while it was under way.
  dropWorktreeLayoutReadAhead(destinationKey);
  try {
    await window.api.panelLayout.saveWorktreeLayout({
      projectId,
      worktreeId: destinationWorktreeId,
      layout,
    });
  } finally {
    dropWorktreeLayoutReadAhead(destinationKey);
  }
  return true;
}

function scheduleSave(worktreeKey: string): void {
  // Defensive filter: aux layouts never get their own file — aux changes are
  // folded into the OWNING worktree key by `handleLayoutsChanged`, and only
  // `ensureWorktreePanelLayout` (never called with aux keys) hydrates keys.
  if (isAuxPanelLayoutKey(worktreeKey)) {
    return;
  }
  if (suspendedKeys.has(worktreeKey)) {
    return;
  }
  cancelPendingSave(worktreeKey);
  pendingSaves.set(
    worktreeKey,
    setTimeout((): void => {
      pendingSaves.delete(worktreeKey);
      void saveNow(worktreeKey).catch(() => undefined);
    }, SAVE_DEBOUNCE_MS),
  );
}

/**
 * Narrow scheduling seam for changes the layout store cannot see — currently
 * only aux OS-window bounds (moving/resizing a child window commits nothing
 * in `panelLayoutStore`, but bounds are read live at save time, so dirtying
 * the owner's debounced save is sufficient). Only hydrated worktree keys
 * schedule, mirroring the store-subscription gate; aux layout keys are
 * rejected inside `scheduleSave` like everywhere else.
 */
export function schedulePanelLayoutSave(
  worktreeKey: string,
  options: { userInitiated?: boolean } = {},
): void {
  if (!hydratedKeys.has(worktreeKey)) {
    return;
  }
  if (options.userInitiated !== false) customizedKeys.add(worktreeKey);
  scheduleSave(worktreeKey);
}

/**
 * Suspends panel-layout persistence for a worktree (failed browser-state
 * migration recovery: the in-memory layout holds a non-persistable recovery
 * panel, and the on-disk files must stay untouched). Any pending save is
 * cancelled.
 */
export function suspendPanelLayoutPersistence(worktreeKey: string): void {
  suspendedKeys.add(worktreeKey);
  cancelPendingSave(worktreeKey);
}

/**
 * Resumes persistence after a successful migration recovery and schedules an
 * immediate (debounced) save so the now-bound layout reaches disk.
 */
export function resumePanelLayoutPersistence(worktreeKey: string): void {
  if (!suspendedKeys.delete(worktreeKey)) {
    return;
  }
  if (hydratedKeys.has(worktreeKey)) {
    scheduleSave(worktreeKey);
  }
}

/**
 * Undoes a collapse that Canopy — not the user — seeded, once the group has
 * gained content worth showing (CAN-2836). The caller owns the content signal;
 * this function owns the layout preconditions and the persistence ordering.
 *
 * Returns `false` without mutating when:
 *
 * - the worktree has not finished hydrating. This is the reason the expand
 *   lives HERE rather than at the call site: `handleLayoutsChanged` assigns
 *   `previousLayouts` BEFORE the hydration filter, so a commit made mid-
 *   hydration is silently absorbed and never reaches disk. In practice a
 *   content-bearing panel cannot render before the layout record exists, but
 *   the ordering is stated in the one module that owns it.
 * - the group is not collapsed, or its collapse carries no `auto` flag (a
 *   user's collapse is never undone).
 * - persistence is suspended for this worktree (browser-panel-migration
 *   recovery). The expand would mutate memory but never reach disk, so the
 *   `auto` flag would survive on disk and the at-most-once guarantee below
 *   would silently degrade to per-session. Declining keeps the flag intact in
 *   BOTH places, so the reopen is deferred rather than lost. Note
 *   `resumePanelLayoutPersistence` only schedules a save — it does not bump
 *   the layout revision `useAutoExpandActivityRail` subscribes to — so the
 *   in-session retry rides on the next layout MUTATION. If recovery makes no
 *   further mutation, the surviving on-disk flag retries at next launch.
 * - a group is maximized. `expandGroup` does not refuse on a maximized layout
 *   — it silently exits maximize — so expanding here would yank the user out
 *   of a maximized chat. The `auto` flag survives, so the next layout
 *   revision retries naturally.
 *
 * On success the flag is spent: `expandGroup` clears `collapsed` outright, so
 * the reopen happens at most once. Focus deliberately stays where it is — the
 * rail gaining content is not a reason to pull the caret off the composer —
 * and the save is left to the existing store subscription.
 */
export function expandActivityRailFromContent(
  worktreeKey: string,
  groupId: string,
): boolean {
  if (!hydratedKeys.has(worktreeKey) || suspendedKeys.has(worktreeKey)) {
    return false;
  }
  const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
  if (layout === undefined || layout.maximizedGroupId !== null) {
    return false;
  }
  if (layout.groups[groupId]?.collapsed?.auto !== true) {
    return false;
  }
  return usePanelLayoutStore
    .getState()
    .expandGroup(worktreeKey, groupId, { focus: false });
}

/** Whether a worktree's panel-layout persistence is currently suspended. */
export function isPanelLayoutPersistenceSuspended(
  worktreeKey: string,
): boolean {
  return suspendedKeys.has(worktreeKey);
}

/** See {@link createAuxWindowBoundsWatcher}. */
export interface AuxWindowBoundsWatcher {
  /**
   * Compares the live bounds against the last snapshot and, on change,
   * schedules the owning worktree's debounced save. Call from a periodic
   * tick and/or the child's `resize` event; closed/tearing-down windows are
   * ignored (close detection owns that path).
   */
  readonly check: () => void;
}

/**
 * Bounds watcher for one aux child window. Moving/resizing the aux OS window
 * commits nothing in the layout store, so without this a bounds-only change
 * would persist only with the NEXT committed layout mutation (or be lost).
 * `AuxPanelWindow` drives `check()` from its existing 500ms close-poll tick
 * (catches moves) plus the child window's `resize` event (prompt size
 * changes); the save itself re-reads bounds live, so the watcher only needs
 * to dirty the owner key — debouncing rides the shared 500ms save debounce.
 */
export function createAuxWindowBoundsWatcher(
  childWindow: AuxWindowBoundsSource,
  worktreeKey: string,
): AuxWindowBoundsWatcher {
  let lastBounds = readAuxWindowBounds(childWindow);
  return {
    check: (): void => {
      const bounds = readAuxWindowBounds(childWindow);
      if (bounds === null) {
        return;
      }
      if (
        lastBounds !== null &&
        bounds.x === lastBounds.x &&
        bounds.y === lastBounds.y &&
        bounds.width === lastBounds.width &&
        bounds.height === lastBounds.height
      ) {
        return;
      }
      lastBounds = bounds;
      schedulePanelLayoutSave(worktreeKey);
    },
  };
}

/**
 * Synchronously fires every pending debounced save. Wired to `pagehide` /
 * `beforeunload` so a quit landing inside the 500ms debounce window cannot
 * lose the last change: `saveNow` issues a fire-and-forget `invoke`, whose
 * SEND reaches the main process even while the renderer is unloading (the
 * response promise may never settle, which is fine — main's persistence
 * store flushes on quit). Idempotent: flushed keys leave `pendingSaves`.
 */
export function flushPendingPanelLayoutSaves(): void {
  for (const worktreeKey of Array.from(pendingSaves.keys())) {
    cancelPendingSave(worktreeKey);
    void saveNow(worktreeKey).catch(() => undefined);
  }
}

/** Commit pending entry layouts before the canonical empty-entry reuse check. */
export async function flushPanelLayoutSavesForProject(
  projectId: string,
): Promise<void> {
  for (const worktreeKey of Array.from(failedSaves)) {
    if (!worktreeKey.startsWith(`${projectId}/`)) continue;
    failedSaves.delete(worktreeKey);
    await saveNow(worktreeKey);
  }
  for (const worktreeKey of Array.from(pendingSaves.keys())) {
    if (!worktreeKey.startsWith(`${projectId}/`)) continue;
    cancelPendingSave(worktreeKey);
    await saveNow(worktreeKey);
  }
  await Promise.all(
    Array.from(inFlightSaves.entries())
      .filter(([key]) => key.startsWith(`${projectId}/`))
      .map(([, promise]) => promise),
  );
}

/**
 * Commits one worktree's pending layout save and resolves once the save IPC
 * has round-tripped, so main reads the layout that is on screen. The live
 * layout is snapshotted synchronously, before the first await, so a caller may
 * dispose the layout right after calling this. Rejects when the save fails.
 */
export async function flushPanelLayoutSaveForWorktree(
  worktreeKey: string,
): Promise<void> {
  if (failedSaves.delete(worktreeKey) || pendingSaves.has(worktreeKey)) {
    cancelPendingSave(worktreeKey);
    await saveNow(worktreeKey);
    return;
  }
  await inFlightSaves.get(worktreeKey);
}

let flushListenersInstalled = false;

function handleWindowTeardown(): void {
  flushPendingPanelLayoutSaves();
}

/** Installs the teardown flush listeners once (bridge init path). */
function installFlushOnTeardown(): void {
  if (flushListenersInstalled || typeof window === 'undefined') {
    return;
  }
  flushListenersInstalled = true;
  // `pagehide` is the reliable unload signal for Electron renderer teardown;
  // `beforeunload` is harmless belt-and-braces for orders where `pagehide`
  // is not delivered. Double delivery is safe (flush is idempotent).
  window.addEventListener('pagehide', handleWindowTeardown);
  window.addEventListener('beforeunload', handleWindowTeardown);
}

/**
 * Store subscription: every layout mutation commits a fresh record object
 * (`commitWork`), so record identity per key is the change signal for both
 * topology revisions and tab/active/MRU updates. Removed keys (disposeLayout)
 * drop their hydration flag and any pending save.
 *
 * Auxiliary-window layout changes (commits OR appearance/removal of an aux
 * key) fold into the OWNING worktree's debounced save: the aux grid is
 * persisted inside that worktree's `panel-layout.json` (`poppedOut`), so a
 * split/tab change inside a pulled-out window must dirty the owner file.
 */
function handleLayoutsChanged(
  layouts: Record<string, WorktreePanelLayout>,
): void {
  const previous = previousLayouts;
  previousLayouts = layouts;

  const keysToSave = new Set<string>();

  // A layout that left memory (its worktree deleted or archived, a shared
  // copy replaced) may be replaced on disk too: nothing read ahead for it is
  // used.
  for (const layoutKey of Object.keys(previous)) {
    if (layouts[layoutKey] === undefined) {
      dropWorktreeLayoutReadAhead(layoutKey);
    }
  }

  for (const worktreeKey of Array.from(hydratedKeys)) {
    const record = layouts[worktreeKey];
    if (record === undefined) {
      hydratedKeys.delete(worktreeKey);
      customizedKeys.delete(worktreeKey);
      failedSaves.delete(worktreeKey);
      layoutDimensions.delete(worktreeKey);
      inFlightSaves.delete(worktreeKey);
      minimalRevisitRepairs.delete(worktreeKey);
      cancelPendingSave(worktreeKey);
      continue;
    }
    if (record !== previous[worktreeKey]) {
      const before = previous[worktreeKey];
      if (
        before &&
        (record.revision !== before.revision ||
          groupContent(record) !== groupContent(before))
      ) {
        if (
          !automaticSaveKeys.has(worktreeKey) &&
          !suspendedKeys.has(worktreeKey)
        )
          customizedKeys.add(worktreeKey);
      }
      keysToSave.add(worktreeKey);
    }
  }

  const allKeys = Array.from(
    new Set([...Object.keys(layouts), ...Object.keys(previous)]),
  );
  for (const layoutKey of allKeys) {
    if (!isAuxPanelLayoutKey(layoutKey)) {
      continue;
    }
    if (layouts[layoutKey] === previous[layoutKey]) {
      continue;
    }
    const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey);
    if (ownerKey !== null && hydratedKeys.has(ownerKey)) {
      if (!automaticSaveKeys.has(ownerKey) && !suspendedKeys.has(ownerKey))
        customizedKeys.add(ownerKey);
      keysToSave.add(ownerKey);
    }
  }

  for (const worktreeKey of Array.from(keysToSave)) {
    scheduleSave(worktreeKey);
  }
}

function handleLayoutSizeRevisionsChanged(
  layouts: Record<string, WorktreePanelLayout>,
  layoutSizeRevisions: Record<string, number>,
): void {
  const previous = previousLayoutSizeRevisions;
  previousLayoutSizeRevisions = layoutSizeRevisions;

  const keysToSave = new Set<string>();

  for (const worktreeKey of Array.from(hydratedKeys)) {
    if (layouts[worktreeKey] === undefined) {
      continue;
    }
    if (layoutSizeRevisions[worktreeKey] !== previous[worktreeKey]) {
      const before = layoutDimensions.get(worktreeKey);
      const grid = layouts[worktreeKey].grid;
      if (before?.width === grid.width && before.height === grid.height) {
        if (
          !automaticSaveKeys.has(worktreeKey) &&
          !suspendedKeys.has(worktreeKey)
        )
          customizedKeys.add(worktreeKey);
      }
      rememberLayoutDimensions(worktreeKey);
      keysToSave.add(worktreeKey);
    }
  }

  const allKeys = Array.from(
    new Set([...Object.keys(layoutSizeRevisions), ...Object.keys(previous)]),
  );
  for (const layoutKey of allKeys) {
    if (!isAuxPanelLayoutKey(layoutKey)) {
      continue;
    }
    if (layoutSizeRevisions[layoutKey] === previous[layoutKey]) {
      continue;
    }
    const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey);
    if (ownerKey !== null && hydratedKeys.has(ownerKey)) {
      if (!automaticSaveKeys.has(ownerKey) && !suspendedKeys.has(ownerKey))
        customizedKeys.add(ownerKey);
      keysToSave.add(ownerKey);
    }
  }

  for (const worktreeKey of Array.from(keysToSave)) {
    scheduleSave(worktreeKey);
  }
}

function installSaveSubscription(): void {
  installFlushOnTeardown();
  if (unsubscribe !== null) {
    return;
  }
  previousLayouts = usePanelLayoutStore.getState().layouts;
  previousLayoutSizeRevisions =
    usePanelLayoutStore.getState().layoutSizeRevisions;
  unsubscribe = usePanelLayoutStore.subscribe((state) => {
    if (state.layouts !== previousLayouts) {
      handleLayoutsChanged(state.layouts);
    }
    if (state.layoutSizeRevisions !== previousLayoutSizeRevisions) {
      handleLayoutSizeRevisionsChanged(
        state.layouts,
        state.layoutSizeRevisions,
      );
    }
  });
}

/**
 * Applies the saved per-surface default layout to a worktree that has no
 * persisted layout of its own, retargeting the chat host to the worktree's
 * active chat. Returns `false` when no valid default is saved for the key's
 * surface or it has no chat host — the caller then builds the hardcoded
 * default.
 */
async function applySavedDefaultLayout(worktreeKey: string): Promise<boolean> {
  let template: SerializablePanelLayoutFile | null = null;
  try {
    const response = await window.api.panelLayout.loadDefaultLayout({
      surface: panelSurfaceForWorktreeKey(worktreeKey),
    });
    // A hand-edited default may carry a shape-invalid plan entry (e.g. a
    // non-string `planId`), which the protocol validator below would reject
    // as the WHOLE file. Sanitize plan-only raw entries first so one bad
    // entry never discards the rest of the saved default.
    const sanitized = sanitizeRawPlanPanelBindings(response.layout);
    const migrated = migratePanelLayout(sanitized);
    // A hand-edited default may also carry a shape-valid but semantically
    // invalid or duplicate plan entry; prune those post-migration rather than
    // discarding the whole saved default.
    template =
      migrated === null ? null : pruneInvalidBoundPanelEntries(migrated);
  } catch {
    template = null;
  }
  if (template === null) {
    return false;
  }
  const chatSeed = activeChatTabSeed(worktreeKey);
  const file = retargetTemplateForWorktree(template, chatSeed);
  if (file === null) {
    return false;
  }
  return usePanelLayoutStore.getState().restoreLayout(worktreeKey, file);
}

/**
 * Reads a worktree's saved layout from its store. A layout read ahead when
 * the user pointed at or pressed the worktree's row answers at once while it
 * is still current (see `layout-read-ahead.ts`).
 */
async function readSavedWorktreeLayout(
  worktreeKey: string,
): Promise<
  Awaited<ReturnType<typeof window.api.panelLayout.loadWorktreeLayout>>
> {
  const readAhead = savedWorktreeLayoutReadAhead(worktreeKey);
  if (readAhead !== undefined) return readAhead;
  const { projectId, worktreeId } = splitWorktreeKey(worktreeKey);
  return isWebCoreScope(projectId)
    ? webCorePanelLayouts.loadLayout({ projectId, worktreeId })
    : window.api.panelLayout.loadWorktreeLayout({ projectId, worktreeId });
}

/**
 * Restore-or-default entry point for WorktreePart's ensure-layout effect.
 * Awaits the persisted-layout load BEFORE building anything: a valid file
 * rebuilds the grid via `restoreLayout`, everything else (missing file,
 * failed validation, IPC error) builds the default layout. Concurrent calls
 * for the same key share one in-flight promise; a key whose layout is already
 * live resolves immediately.
 */
export function ensureWorktreePanelLayout(worktreeKey: string): Promise<void> {
  installSaveSubscription();
  ensureScopePanelRules();

  const inFlight = ensurePromises.get(worktreeKey);
  if (inFlight !== undefined) {
    return inFlight;
  }

  const generation = panelHydrationGeneration(worktreeKey);
  const promise = (async (): Promise<void> => {
    // A first visit reads the mode, the saved layout and the browser state.
    // None needs another's answer, so all three go out together: one after
    // another, the page's loading card stayed up for three round trips.
    const firstVisit =
      usePanelLayoutStore.getState().layouts[worktreeKey] === undefined;
    const [modeRead, savedLayoutRead] = await Promise.allSettled([
      useWorkspaceLayoutModeStore.getState().load(worktreeKey),
      firstVisit ? readSavedWorktreeLayout(worktreeKey) : null,
      firstVisit ? readBrowserStateAhead(worktreeKey) : null,
    ]);
    if (modeRead.status === 'rejected') throw modeRead.reason;
    const mode = modeRead.value;
    if (!isPanelHydrationGenerationCurrent(worktreeKey, generation)) return;
    if (
      mode === 'minimal' &&
      layoutScopeServesPanelKind(worktreeKey, 'terminal')
    ) {
      const { projectId, worktreeId } = splitWorktreeKey(worktreeKey);
      // Hydration can reattach a cloud shell before any pane mounts; its
      // exit must still reach the store (CAN-6939).
      ensureTerminalDrawerExitSubscription();
      await ensureTerminalWorktreeHydrated(projectId, worktreeId).catch(
        () => undefined,
      );
      if (!isPanelHydrationGenerationCurrent(worktreeKey, generation)) return;
    }
    if (usePanelLayoutStore.getState().layouts[worktreeKey] !== undefined) {
      if (mode === 'minimal') {
        if (!repairMinimalLayoutOnRevisit(worktreeKey)) return;
      }
      hydratedKeys.add(worktreeKey);
      rememberLayoutDimensions(worktreeKey);
      dropWorktreeLayoutReadAhead(worktreeKey);
      return;
    }
    let restored = false;
    let poppedOutMergedBack = false;
    let browserMigration: Awaited<
      ReturnType<typeof prepareBrowserPanelMigration>
    > | null = null;
    try {
      // A failed read falls back to the default layout, like any other
      // failure in here.
      if (savedLayoutRead.status === 'rejected') throw savedLayoutRead.reason;
      const response =
        savedLayoutRead.value ?? (await readSavedWorktreeLayout(worktreeKey));
      if (!isPanelHydrationGenerationCurrent(worktreeKey, generation)) return;
      if (
        response.layout !== null &&
        (typeof response.layout !== 'object' ||
          !('hasUserChanges' in response.layout) ||
          response.layout.hasUserChanges !== false)
      ) {
        customizedKeys.add(worktreeKey);
      }
      // Pre-restore browser migration: hydrates the worktree's normalized
      // browser state and rebinds a legacy (unbound) Browser placeholder to
      // per-session panels BEFORE validation — the protocol validator rejects
      // unbound Browser entries, so a legacy file must be transformed first.
      browserMigration = await prepareBrowserPanelMigration(
        worktreeKey,
        response.layout,
      );
      // A shape-invalid raw plan entry (e.g. a non-string `planId`, an
      // over-length string, or a non-object `instance`) would otherwise make
      // the protocol validator below reject the WHOLE file. Sanitize
      // plan-only raw entries first so one damaged entry never resets the
      // rest of a user's saved layout.
      const sanitized = sanitizeRawPlanPanelBindings(browserMigration.layout);
      let migrated = migratePanelLayout(sanitized);
      if (migrated !== null) {
        // Plan panels are also validated by shape only on the wire: drop
        // shape-valid-but-invalid or duplicate plan entries (main grid first,
        // then popped-out windows) so one bad entry never resets the whole
        // layout. The pruned `poppedOut` list is what feeds
        // `restorePoppedWindow` below.
        migrated = pruneInvalidBoundPanelEntries(migrated);
        if (mode === 'minimal') {
          migrated = minimalLayoutOnLoad(worktreeKey, migrated);
        }
        restored = usePanelLayoutStore
          .getState()
          .restoreLayout(worktreeKey, migrated);
        if (
          mode === 'advanced' &&
          restored &&
          migrated.poppedOut !== undefined
        ) {
          // Parent-orchestrated popped-out restore (doc 05 §7.5): the main
          // window re-creates every persisted aux window after the main grid
          // is live. A failed open merges that entry's tabs into the main
          // layout instead (data-loss guard), which must be saved promptly so
          // the file stops claiming the window is popped out.
          const windowsStore = usePanelWindowsStore.getState();
          for (const entry of migrated.poppedOut) {
            if (
              windowsStore.restorePoppedWindow(worktreeKey, entry) ===
              'merged-back'
            ) {
              poppedOutMergedBack = true;
            }
          }
        }
      }
    } catch {
      restored = false;
    }
    if (!restored) {
      const appliedSavedDefault =
        mode === 'advanced' && (await applySavedDefaultLayout(worktreeKey));
      if (!appliedSavedDefault) {
        ensureDefaultWorktreeLayout(worktreeKey);
      }
      if (mode === 'minimal') {
        const current = usePanelLayoutStore
          .getState()
          .serializeLayout(worktreeKey);
        if (current !== null) {
          const seeded = planMinimalLayout(current, [], {
            initial: true,
            // Simplified Minimal: the Side Panel starts empty and lists what can
            // be opened there.
            seedSidePanels: !usesSimplifiedMinimalDefaults(worktreeKey),
          }).layout;
          usePanelLayoutStore.getState().restoreLayout(
            worktreeKey,
            // Simplified Minimal: no automatic reopening of the Side Panel.
            usesSimplifiedMinimalDefaults(worktreeKey)
              ? hideOptionalMinimalRegions(seeded)
              : seeded,
          );
        }
      }
    }
    removeScopeUnavailablePanels(worktreeKey);
    hydratedKeys.add(worktreeKey);
    rememberLayoutDimensions(worktreeKey);
    // The layout is in memory from here on, and is what gets saved.
    dropWorktreeLayoutReadAhead(worktreeKey);
    void maybeOpenStartPage(worktreeKey, generation, !restored, (operation) =>
      withAutomaticLayoutChanges(worktreeKey, operation),
    );
    // Post-restore browser migration: reconcile sessions ⇄ bound panels and
    // persist the normalized state + bound layout (restored path), or append
    // preserved Browser tabs to the fresh default layout (fallback path).
    // Runs after `hydratedKeys.add` so migration-triggered saves schedule.
    if (browserMigration !== null) {
      await withAutomaticLayoutChanges(worktreeKey, () =>
        browserMigration
          .finalize(restored ? 'restored' : 'default')
          .catch(() => undefined),
      );
    }
    if (poppedOutMergedBack) {
      scheduleSave(worktreeKey);
    }
  })().finally(() => {
    if (ensurePromises.get(worktreeKey) === promise) {
      ensurePromises.delete(worktreeKey);
    }
  });

  ensurePromises.set(worktreeKey, promise);
  return promise;
}

/** A row pointed at reuses reads this recent instead of reading again. */
const POINTED_READ_REUSE_MS = 1000;
/** A pressed row reads again unless its reads only just went out. */
const PRESSED_READ_REUSE_MS = 150;

/**
 * How a sidebar row shows intent to open its worktree:
 *
 * - `point`: the pointer rests on it, or keyboard focus moved onto it;
 * - `press`: the pointer went down on it, and its click follows a moment
 *   later;
 * - `activate`: Enter or Space on the focused row, which opens it in the
 *   same task.
 */
export type WorktreeLayoutReadAheadIntent = 'point' | 'press' | 'activate';

/**
 * Gets ready what {@link ensureWorktreePanelLayout} waits for on a first
 * visit, for a worktree whose sidebar row shows intent to open it. With all
 * of it in memory when the click lands, hydration finishes in the click's
 * own frame and the grid mounts without the loading card being painted.
 *
 * Pointing at the row (or moving keyboard focus onto it) only reads: the
 * saved mode and the saved layout are kept as raw answers, which expire if
 * the row is not opened (`layout-read-ahead.ts`).
 *
 * Pressing the row is followed by its click a moment later, so it also
 * starts the two store hydrations the visit itself starts next: the
 * worktree's browser state and, for a Minimal worktree that has terminals,
 * its terminal state. Both are the visit's own deduplicated calls made early,
 * so the visit joins them instead of starting over. They fill store buckets
 * only: no panel, window, browser view or terminal attachment is made, and a
 * press that is not followed by a visit leaves the same buckets a visited
 * and left worktree has. A cloud scope is left to its visit, whose terminal
 * hydration can reattach a shell.
 *
 * Activating the row from the keyboard is its press, made in the same task
 * as the visit: the two hydrations start before the visit renders, and side
 * by side instead of the terminal read waiting for the browser read. Only
 * the reads kept from when focus moved onto the row are used: reading the
 * mode and the layout again would only duplicate the visit's own reads.
 *
 * Nothing here builds a layout, restores a popped-out window or saves.
 */
export function readWorktreePanelLayoutAhead(
  worktreeKey: string,
  options: { intent: WorktreeLayoutReadAheadIntent },
): void {
  if (isAuxPanelLayoutKey(worktreeKey)) return;
  const { projectId, worktreeId } = splitWorktreeKey(worktreeKey);
  if (projectId === '' || worktreeId === '' || isWebCoreScope(projectId)) {
    return;
  }
  // A layout in memory, or one whose hydration is under way, reads nothing.
  if (
    usePanelLayoutStore.getState().layouts[worktreeKey] !== undefined ||
    ensurePromises.has(worktreeKey)
  ) {
    return;
  }
  const { intent } = options;
  const read =
    intent === 'activate'
      ? worktreeLayoutReadAheadSettled(worktreeKey)
      : readWorktreeLayoutAhead(
          worktreeKey,
          intent === 'press' ? PRESSED_READ_REUSE_MS : POINTED_READ_REUSE_MS,
        );
  if (intent === 'point') return;
  // `allSettled`: a hydration that fails here is the visit's to report, when
  // it makes the same call and finds the state missing.
  void Promise.allSettled([
    Promise.resolve().then(() => readBrowserStateAhead(worktreeKey)),
    // Without a kept mode, the visit's own mode read decides on terminals.
    read?.then((): Promise<void> | undefined => {
      const mode = worktreeModeReadAhead(worktreeKey)?.mode;
      if (
        mode !== 'minimal' ||
        !layoutScopeServesPanelKind(worktreeKey, 'terminal') ||
        usePanelLayoutStore.getState().layouts[worktreeKey] !== undefined
      ) {
        return undefined;
      }
      return ensureTerminalWorktreeHydrated(projectId, worktreeId);
    }),
  ]);
}

export function disposeWorktreePanelHydration(worktreeKey: string): void {
  advancePanelHydrationGeneration(worktreeKey);
  ensurePromises.delete(worktreeKey);
  useWorkspaceLayoutModeStore.getState().dispose(worktreeKey);
}

/**
 * Resets a worktree's layout back to the surface default: disposes the live
 * layout, rebuilds from the saved per-surface default template (or the
 * hardcoded default when none is saved), and persists the result. Returns
 * `false` when the key has no live layout to reset. Popped-out aux windows
 * are not merged back; their windows are closed and their persisted entries
 * dropped with the layout.
 */
/**
 * Terminal and browser bindings across a worktree's layout FAMILY (main +
 * aux layouts). Captured around a layout reset: the incremental panel⇄
 * resource sweeps treat a disposed family as transient teardown, so
 * resources whose panels the rebuilt default omits must be closed
 * explicitly or their PTYs/browser sessions leak.
 */
function collectFamilyResourceBindings(worktreeKey: string): {
  terminals: Set<string>;
  browsers: Set<string>;
} {
  const terminals = new Set<string>();
  const browsers = new Set<string>();
  const layouts = usePanelLayoutStore.getState().layouts;
  for (const [key, layout] of Object.entries(layouts)) {
    if (key !== worktreeKey && getAuxPanelLayoutOwnerKey(key) !== worktreeKey) {
      continue;
    }
    for (const group of Object.values(layout.groups)) {
      for (const tab of group.tabs) {
        if (tab.kind === 'terminal' && tab.instance?.terminalId) {
          terminals.add(tab.instance.terminalId);
        } else if (tab.kind === 'browser' && tab.instance?.browserId) {
          browsers.add(tab.instance.browserId);
        }
      }
    }
  }
  return { terminals, browsers };
}

export async function resetLayoutToDefault(
  worktreeKey: string,
): Promise<boolean> {
  if (getWorkspaceLayoutMode(worktreeKey) === 'minimal') return false;
  const store = usePanelLayoutStore.getState();
  if (store.layouts[worktreeKey] === undefined) {
    return false;
  }
  // Suspended persistence (failed browser-state migration recovery) refuses
  // the reset outright: the rebuild would discard the recovery panel for the
  // session while `scheduleSave` silently skips suspended keys — reporting a
  // success that never reaches disk and returns undone on restart.
  if (suspendedKeys.has(worktreeKey)) {
    return false;
  }
  cancelPendingSave(worktreeKey);
  dropWorktreeLayoutReadAhead(worktreeKey);
  // Captured BEFORE disposal: the panel⇄resource sweeps skip a disposed
  // family (transient teardown), so omitted resources must be closed here.
  const boundBefore = collectFamilyResourceBindings(worktreeKey);
  // Close popped-out windows BEFORE rebuilding: the post-reset save snapshots
  // every still-open aux window back into the persisted file, so leaving them
  // alive would resurrect their entries — and their OS windows — in what is
  // supposed to be the pristine default layout.
  usePanelWindowsStore.getState().disposeWorktreeAuxWindows(worktreeKey);
  store.disposeLayout(worktreeKey);
  hydratedKeys.delete(worktreeKey);
  const appliedSavedDefault = await applySavedDefaultLayout(worktreeKey);
  if (!appliedSavedDefault) {
    ensureDefaultWorktreeLayout(worktreeKey);
  }
  hydratedKeys.add(worktreeKey);
  // Terminal PTYs and browser sessions whose panels the rebuilt default does
  // not host would otherwise keep running with no UI to manage them.
  const boundAfter = collectFamilyResourceBindings(worktreeKey);
  const separator = worktreeKey.indexOf('/');
  const projectId = worktreeKey.slice(0, separator);
  const worktreeId = worktreeKey.slice(separator + 1);
  boundBefore.terminals.forEach((terminalId) => {
    if (!boundAfter.terminals.has(terminalId)) {
      closeOmittedTerminalBinding(worktreeKey, terminalId);
    }
  });
  boundBefore.browsers.forEach((browserId) => {
    if (!boundAfter.browsers.has(browserId)) {
      requestBrowserSessionDestruction(projectId, worktreeId, browserId);
    }
  });
  // Run tabs the default omits were closed by the reset; drop their view
  // state (the diff sweep treats the family rebuild as teardown).
  releaseOmittedPipelinePanelUi(worktreeKey);
  scheduleSave(worktreeKey);
  return true;
}
