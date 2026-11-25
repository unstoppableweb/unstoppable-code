/**
 * Legacy Browser panel-layout migration (pre-restore).
 *
 * The panel system historically persisted ONE singleton `browser` panel with
 * no instance binding, while the browser sessions themselves lived in a
 * separate grouped `browser-state.json`. The refactored contract requires
 * every Browser panel to bind exactly one persisted session
 * (`instance.browserId`), and the protocol validator now rejects unbound
 * Browser entries outright — so a legacy layout must be transformed BEFORE
 * `migratePanelLayout`/`restoreLayout` ever see it.
 *
 * Invoked by the persistence bridge (`ensureWorktreePanelLayout`):
 *
 * 1. Hydrate the backend's normalized browser state (order + explicit active
 *    id) before touching the legacy layout.
 * 2. Replace the legacy Browser placeholder at its original tab position with
 *    one bound Browser panel per `browserOrder` entry, preserving the
 *    placeholder's pinned state on every migrated tab and its active-tab
 *    treatment (`activeBrowserId` panel when the placeholder was active).
 * 3. Keep the placeholder's panel id for the FIRST browser; later panels get
 *    deterministic `panel-browser-${browserId}` ids so repeated migration is
 *    idempotent.
 * 4. After a successful restore, reconcile sessions ⇄ panels: preserved
 *    sessions with no bound panel are rebound into the layout, while bound
 *    panels whose session vanished are conclusively stale (panel closed +
 *    toast). Neither direction runs on failed hydration.
 * 5. Persist the normalized browser state and (via the bridge) the bound
 *    layout only after hydration, binding, validation, and restore all
 *    succeed.
 *
 * Hydration failure from corrupt/future browser state binds no real session
 * and rewrites neither file: the placeholder is replaced only in memory with
 * one recovery Browser panel using {@link RECOVERY_BROWSER_ID}, panel-layout
 * persistence for the worktree is suspended, and a successful hydration
 * `Retry` (routed through `setBrowserHydrationRecoveryHandler`) completes the
 * migration and resumes persistence. Closing the recovery panel destroys
 * nothing; the untouched files re-enter recovery on the next launch.
 */
import type {
  BrowserSessionSnapshot,
  PersistedWorktreeBrowserStateFile,
} from '@canopy/desktop-shared/types';
import {
  ensureBrowserWorktreeHydrated,
  setBrowserHydrationRecoveryHandler,
  useBrowserStore,
  type WorktreeBrowserBucket,
} from '@/stores/browserStore';
import {
  findPanelByInstanceKey,
  getPanelInstanceKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useGitHubStore } from '@/stores/githubStore';
import { readRemoteControlContext } from '@/stores/remoteControlStore';
import {
  resumePanelLayoutPersistence,
  schedulePanelLayoutSave,
  suspendPanelLayoutPersistence,
} from './persistence-bridge';
import {
  browserPanelIdFor,
  isRecoveryBrowserId,
  RECOVERY_BROWSER_ID,
} from './browser-panel-identity';

export {
  browserPanelIdFor,
  isRecoveryBrowserId,
  RECOVERY_BROWSER_ID,
} from './browser-panel-identity';

/**
 * Reserved, never-persisted browser id bound to the in-memory recovery panel
 * while hydration of the worktree's browser state is failing. Satisfies the
 * renderer instance contract (trimmed, non-empty) but is excluded from
 * lifecycle destruction, persistence, and stale-panel reconciliation.
 */
export const STALE_BROWSER_PANEL_TOAST =
  'Browser session is no longer available.';

/** Worktree keys whose migration is parked in recovery mode. */
const pendingRecoveries = new Set<string>();

export function hasPendingBrowserMigrationRecovery(
  worktreeKey: string,
): boolean {
  return pendingRecoveries.has(worktreeKey);
}

function worktreeKeyOf(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Raw-layout inspection / transformation (pre-validation JSON surgery)
// ---------------------------------------------------------------------------

interface RawLeaf {
  leaf: Record<string, unknown>;
  panels: unknown[];
}

function collectRawLeaves(node: unknown, out: RawLeaf[]): void {
  if (!isRecord(node)) {
    return;
  }
  if (node.type === 'leaf' && Array.isArray(node.panels)) {
    out.push({ leaf: node, panels: node.panels });
    return;
  }
  if (node.type === 'branch' && Array.isArray(node.children)) {
    for (const child of node.children) {
      collectRawLeaves(child, out);
    }
  }
}

function rawLeavesOf(rawLayout: unknown): RawLeaf[] {
  if (!isRecord(rawLayout)) {
    return [];
  }
  const grid = rawLayout.grid;
  if (!isRecord(grid)) {
    return [];
  }
  const leaves: RawLeaf[] = [];
  collectRawLeaves(grid.root, leaves);
  return leaves;
}

function isBrowserEntry(entry: unknown): entry is Record<string, unknown> {
  return isRecord(entry) && entry.kind === 'browser';
}

function boundBrowserIdOf(entry: Record<string, unknown>): string | null {
  const instance = entry.instance;
  if (!isRecord(instance)) {
    return null;
  }
  const browserId = instance.browserId;
  return typeof browserId === 'string' && browserId.trim().length > 0
    ? browserId
    : null;
}

/** Whether an entry is a LEGACY unbound Browser placeholder. */
function isLegacyBrowserPlaceholder(entry: unknown): boolean {
  return isBrowserEntry(entry) && boundBrowserIdOf(entry) === null;
}

/** Whether the raw layout contains an unbound legacy Browser placeholder. */
export function rawLayoutHasLegacyBrowserPlaceholder(
  rawLayout: unknown,
): boolean {
  return rawLeavesOf(rawLayout).some(({ panels }) =>
    panels.some(isLegacyBrowserPlaceholder),
  );
}

/** Bound browser ids already present in the raw layout. */
function rawBoundBrowserIds(rawLayout: unknown): Set<string> {
  const ids = new Set<string>();
  for (const { panels } of rawLeavesOf(rawLayout)) {
    for (const entry of panels) {
      if (isBrowserEntry(entry)) {
        const id = boundBrowserIdOf(entry);
        if (id !== null) {
          ids.add(id);
        }
      }
    }
  }
  return ids;
}

/**
 * Adds one never-persisted recovery Browser entry to the first raw leaf when
 * the layout has no Browser entry of its own. The transformation is pure and
 * intentionally best-effort: a missing/corrupt panel layout has no usable
 * leaf, so `finalize('default')` inserts the same recovery panel into the
 * freshly built default layout instead.
 */
function appendRecoveryPanelToRawLayout(rawLayout: unknown): unknown {
  if (!isRecord(rawLayout) || !isRecord(rawLayout.grid)) {
    return rawLayout;
  }
  let inserted = false;
  const transformNode = (node: unknown): unknown => {
    if (!isRecord(node)) {
      return node;
    }
    if (node.type === 'branch' && isUnknownArray(node.children)) {
      return { ...node, children: node.children.map(transformNode) };
    }
    if (inserted || node.type !== 'leaf' || !isUnknownArray(node.panels)) {
      return node;
    }
    inserted = true;
    const panels = node.panels;
    return {
      ...node,
      panels: [
        ...panels,
        {
          panelId: browserPanelIdFor(RECOVERY_BROWSER_ID),
          kind: 'browser',
          instance: { browserId: RECOVERY_BROWSER_ID },
        },
      ],
    };
  };
  return {
    ...rawLayout,
    grid: {
      ...rawLayout.grid,
      root: transformNode(rawLayout.grid.root),
    },
  };
}

interface BoundBrowserEntrySeed {
  panelId: string;
  browserId: string;
}

/**
 * Replaces the first legacy Browser placeholder in `rawLayout` with bound
 * Browser entries (one per `browserIds` entry, in order, at the placeholder's
 * position). Extra unbound placeholders are dropped. Pure: returns a deep-ish
 * transformed copy; the input is not mutated.
 */
function replacePlaceholderInRawLayout(
  rawLayout: unknown,
  browserIds: readonly string[],
  activeBrowserId: string | null,
): unknown {
  if (!isRecord(rawLayout) || !isRecord(rawLayout.grid)) {
    return rawLayout;
  }
  let replaced = false;

  const transformNode = (node: unknown): unknown => {
    if (!isRecord(node)) {
      return node;
    }
    if (node.type === 'branch' && Array.isArray(node.children)) {
      return { ...node, children: node.children.map(transformNode) };
    }
    if (node.type !== 'leaf' || !isUnknownArray(node.panels)) {
      return node;
    }
    const placeholderIndex = node.panels.findIndex(isLegacyBrowserPlaceholder);
    if (placeholderIndex === -1) {
      return node;
    }

    const placeholder = node.panels[placeholderIndex];
    if (!isRecord(placeholder)) {
      return node;
    }
    const placeholderPanelId =
      typeof placeholder.panelId === 'string' && placeholder.panelId.length > 0
        ? placeholder.panelId
        : browserIds.length > 0
          ? browserPanelIdFor(browserIds[0])
          : 'panel-browser';
    const pinned = placeholder.pinned === true;

    const seeds: BoundBrowserEntrySeed[] = replaced
      ? []
      : browserIds.map((browserId, index) => ({
          // Preserve the original placeholder panel id for the first browser;
          // later panel ids derive from their browser ids (deterministic, so
          // retries/repeated migration produce the same layout).
          panelId:
            index === 0 ? placeholderPanelId : browserPanelIdFor(browserId),
          browserId,
        }));
    replaced = true;

    const boundEntries = seeds.map((seed) => ({
      panelId: seed.panelId,
      kind: 'browser',
      instance: { browserId: seed.browserId },
      ...(pinned ? { pinned: true } : {}),
    }));

    const panels: unknown[] = [];
    for (let index = 0; index < node.panels.length; index += 1) {
      const entry: unknown = node.panels[index];
      if (index === placeholderIndex) {
        panels.push(...boundEntries);
        continue;
      }
      // Any further unbound placeholders are dropped (there can only be one
      // legacy singleton; duplicates would violate the bound contract).
      if (isLegacyBrowserPlaceholder(entry)) {
        continue;
      }
      panels.push(entry);
    }

    let activePanelId = node.activePanelId;
    if (activePanelId === placeholder.panelId) {
      if (boundEntries.length === 0) {
        const firstPanel = panels[0];
        activePanelId =
          isRecord(firstPanel) && typeof firstPanel.panelId === 'string'
            ? firstPanel.panelId
            : null;
      } else {
        // The placeholder was active: activate the panel bound to the
        // normalized active browser (first bound panel otherwise).
        const activeSeed =
          activeBrowserId !== null
            ? seeds.find((seed) => seed.browserId === activeBrowserId)
            : undefined;
        activePanelId = (activeSeed ?? seeds[0]).panelId;
      }
    }

    return { ...node, panels, activePanelId };
  };

  return {
    ...rawLayout,
    grid: {
      ...rawLayout.grid,
      root: transformNode(rawLayout.grid.root),
    },
  };
}

// ---------------------------------------------------------------------------
// Browser-state persistence
// ---------------------------------------------------------------------------

function buildPersistedState(
  bucket: WorktreeBrowserBucket,
): PersistedWorktreeBrowserStateFile {
  return {
    version: 1,
    browserOrder: [...bucket.browserOrder],
    activeBrowserId: bucket.activeBrowserId,
    browsers: bucket.browserOrder
      .map((browserId) => bucket.browsers[browserId])
      .filter((snapshot): snapshot is BrowserSessionSnapshot =>
        Boolean(snapshot),
      ),
  };
}

async function saveNormalizedBrowserState(worktreeKey: string): Promise<void> {
  const bucket = useBrowserStore.getState().worktrees[worktreeKey];
  if (!bucket?.hydrated) {
    return;
  }
  const { projectId, worktreeId } = splitWorktreeKey(worktreeKey);
  await window.api.browser
    .saveWorktreeState({
      projectId,
      worktreeId,
      state: buildPersistedState(bucket),
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Post-restore reconciliation
// ---------------------------------------------------------------------------

/** Bound browser ids across a worktree's live layout family. */
function liveBoundBrowserIds(worktreeKey: string): Map<
  string,
  {
    layoutKey: string;
    groupId: string;
    panelId: string;
  }
> {
  const layouts = usePanelLayoutStore.getState().layouts;
  const bound = new Map<
    string,
    { layoutKey: string; groupId: string; panelId: string }
  >();
  for (const [layoutKey, layout] of Object.entries(layouts)) {
    if (layoutKey !== worktreeKey && !layoutKey.startsWith(`${worktreeKey}#`)) {
      continue;
    }
    for (const [groupId, group] of Object.entries(layout.groups)) {
      for (const tab of group.tabs) {
        if (tab.kind !== 'browser') {
          continue;
        }
        const browserId = tab.instance?.browserId;
        if (browserId !== undefined && browserId.length > 0) {
          bound.set(browserId, { layoutKey, groupId, panelId: tab.panelId });
        }
      }
    }
  }
  return bound;
}

/**
 * Reconciles hydrated sessions ⇄ bound panels after a successful restore:
 * - a bound panel whose session is missing after SUCCESSFUL hydration is
 *   conclusively stale: the panel is removed and a toast shown.
 *
 * Never called when hydration failed. Returns whether anything changed.
 */
function reconcileSessionsWithPanels(worktreeKey: string): boolean {
  const { projectId, worktreeId } = splitWorktreeKey(worktreeKey);
  const bucket = useBrowserStore.getState().worktrees[worktreeKey];
  if (!bucket?.hydrated) {
    return false;
  }
  const bound = liveBoundBrowserIds(worktreeKey);
  let changed = false;

  // Bound panels whose session vanished → conclusively stale.
  for (const [browserId, location] of Array.from(bound.entries())) {
    if (isRecoveryBrowserId(browserId)) {
      continue;
    }
    if (bucket.browsers[browserId] !== undefined) {
      continue;
    }
    changed = true;
    usePanelLayoutStore
      .getState()
      .closeTab(location.layoutKey, location.groupId, location.panelId);
    useGitHubStore
      .getState()
      .addToast(STALE_BROWSER_PANEL_TOAST, 'warning', undefined, {
        projectId,
        worktreeId,
      });
  }

  return changed;
}

/**
 * Ensures a failed hydration always has a reachable Retry surface, including
 * worktrees that did not already contain a Browser panel. Existing bound
 * Browser panels are already recovery surfaces and are left untouched.
 */
function appendRecoveryPanelToLiveLayout(worktreeKey: string): boolean {
  if (liveBoundBrowserIds(worktreeKey).size > 0) {
    return false;
  }
  const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
  const groupId =
    layout?.activeGroupId ?? Object.keys(layout?.groups ?? {})[0] ?? null;
  if (groupId === null) {
    return false;
  }
  return (
    (usePanelLayoutStore.getState().addTab(worktreeKey, groupId, 'browser', {
      panelId: browserPanelIdFor(RECOVERY_BROWSER_ID),
      instance: { browserId: RECOVERY_BROWSER_ID },
    }) ??
      usePanelLayoutStore.getState().addTab(worktreeKey, groupId, 'browser', {
        instance: { browserId: RECOVERY_BROWSER_ID },
      })) !== null
  );
}

// ---------------------------------------------------------------------------
// The migration plan
// ---------------------------------------------------------------------------

export interface BrowserPanelMigrationPlan {
  /** The (possibly transformed) layout value to validate and restore. */
  readonly layout: unknown;
  /** Hydration failed; the layout binds only the in-memory recovery panel. */
  readonly recovery: boolean;
  /** A legacy placeholder was replaced with bound panels. */
  readonly migrated: boolean;
  /**
   * Runs the post-restore half of the migration. `outcome` is `'restored'`
   * when `restoreLayout` succeeded on {@link layout}, `'default'` when the
   * caller fell back to a default layout (missing/corrupt file).
   */
  finalize(outcome: 'restored' | 'default'): Promise<void>;
}

/**
 * Reads a worktree's browser state, which
 * {@link prepareBrowserPanelMigration} waits for. A first visit starts this
 * with its layout read, so the two overlap; the migration then finds the
 * state there, or joins the read under way.
 */
export function readBrowserStateAhead(worktreeKey: string): Promise<void> {
  if (readRemoteControlContext().mode === 'remote') return Promise.resolve();
  const { projectId, worktreeId } = splitWorktreeKey(worktreeKey);
  return ensureBrowserWorktreeHydrated(projectId, worktreeId);
}

/**
 * Pre-restore migration entry point. Hydrates the worktree's browser state,
 * then transforms a legacy layout's unbound Browser placeholder into bound
 * Browser panels (or the recovery placeholder when hydration failed). Safe
 * to call for every layout load; non-legacy layouts pass through unchanged
 * (with reconciliation still applied in `finalize`). Remote windows preserve
 * the host layout without hydrating or reconciling native browser state.
 */
export async function prepareBrowserPanelMigration(
  worktreeKey: string,
  rawLayout: unknown,
): Promise<BrowserPanelMigrationPlan> {
  // Native browser state is unavailable through desktop remote control.
  // Preserve host layout bindings without treating the blocked API as corrupt
  // data or adding a recovery tab.
  if (readRemoteControlContext().mode === 'remote') {
    const hasPlaceholder = rawLayoutHasLegacyBrowserPlaceholder(rawLayout);
    if (hasPlaceholder) {
      // Unbound Browser entries cannot be restored remotely. Remove them only
      // in memory and protect the host file until local migration can bind its
      // sessions. Fresh and already-bound layouts remain safe to save.
      suspendPanelLayoutPersistence(worktreeKey);
    }
    return {
      layout: hasPlaceholder
        ? replacePlaceholderInRawLayout(rawLayout, [], null)
        : rawLayout,
      recovery: false,
      migrated: false,
      finalize: () => Promise.resolve(),
    };
  }

  const { projectId, worktreeId } = splitWorktreeKey(worktreeKey);
  const hasPlaceholder = rawLayoutHasLegacyBrowserPlaceholder(rawLayout);

  // 1. Hydrate the backend's normalized browser state FIRST.
  await ensureBrowserWorktreeHydrated(projectId, worktreeId).catch(
    () => undefined,
  );
  let bucket = useBrowserStore.getState().worktrees[worktreeKey];
  const hydrated = bucket?.hydrated === true;

  if (!hydrated) {
    // Corrupt/future browser state must never become an unrecoverable dead
    // end. Park EVERY layout shape in recovery and suspend panel persistence:
    // a legacy placeholder is rebound in memory, an already-bound Browser
    // panel serves the same Retry UI unchanged, and a layout with no Browser
    // entry receives a never-persisted recovery panel.
    pendingRecoveries.add(worktreeKey);
    suspendPanelLayoutPersistence(worktreeKey);
    const alreadyBound = rawBoundBrowserIds(rawLayout);
    const layout = hasPlaceholder
      ? replacePlaceholderInRawLayout(
          rawLayout,
          [RECOVERY_BROWSER_ID],
          RECOVERY_BROWSER_ID,
        )
      : alreadyBound.size > 0
        ? rawLayout
        : appendRecoveryPanelToRawLayout(rawLayout);
    return {
      layout,
      recovery: true,
      migrated: false,
      finalize: (): Promise<void> => {
        // A missing/corrupt panel layout could not receive the raw recovery
        // entry above. The caller has now built its default layout, so add the
        // reachable Retry surface there. Persistence remains suspended and
        // neither file is rewritten.
        appendRecoveryPanelToLiveLayout(worktreeKey);
        return Promise.resolve();
      },
    };
  }

  // Hydration succeeded (possibly after a previous failure this session).
  pendingRecoveries.delete(worktreeKey);

  let migrated = false;
  let layout = rawLayout;
  if (hasPlaceholder) {
    bucket = useBrowserStore.getState().worktrees[worktreeKey];
    let browserOrder = bucket ? [...bucket.browserOrder] : [];
    // Ids already bound elsewhere in the raw layout must not bind twice.
    const alreadyBound = rawBoundBrowserIds(rawLayout);
    browserOrder = browserOrder.filter((id) => !alreadyBound.has(id));
    if (browserOrder.length === 0 && alreadyBound.size === 0) {
      // Legacy placeholder with no sessions: create one blank browser and
      // bind it, preserving the placeholder position/pinned/active treatment.
      try {
        const snapshot = await useBrowserStore
          .getState()
          .createBrowser(projectId, worktreeId);
        browserOrder = [snapshot.id];
      } catch {
        browserOrder = [];
      }
    }
    if (browserOrder.length > 0) {
      const activeBrowserId =
        useBrowserStore.getState().worktrees[worktreeKey]?.activeBrowserId ??
        null;
      layout = replacePlaceholderInRawLayout(
        rawLayout,
        browserOrder,
        activeBrowserId,
      );
      migrated = true;
    } else {
      // No sessions could be bound (creation failed): drop the placeholder
      // so the rest of the layout still restores.
      layout = replacePlaceholderInRawLayout(rawLayout, [], null);
    }
  }

  return {
    layout,
    recovery: false,
    migrated,
    finalize: async (outcome): Promise<void> => {
      if (outcome === 'default') {
        // Missing or corrupt panel layout: do not infer an intentional
        // close — append every preserved Browser tab to the active/default
        // group of the freshly built default layout.
        const appended = appendPreservedBrowserTabs(worktreeKey);
        if (appended) {
          await saveNormalizedBrowserState(worktreeKey);
          schedulePanelLayoutSave(worktreeKey, { userInitiated: false });
        }
        return;
      }
      // A valid legacy layout may legitimately contain no Browser panel: the
      // old singleton close path disposed views while retaining session
      // metadata. Rebind those sessions before stale-panel reconciliation so
      // an upgrade can never infer an intentional permanent deletion.
      const appended = appendPreservedBrowserTabs(worktreeKey);
      const reconciled = reconcileSessionsWithPanels(worktreeKey);
      if (migrated || appended || reconciled) {
        // Save normalized browser state and the bound panel layout only
        // after hydration, binding, validation, and restore all succeeded.
        await saveNormalizedBrowserState(worktreeKey);
        schedulePanelLayoutSave(worktreeKey, { userInitiated: false });
      }
    },
  };
}

/**
 * Appends a bound Browser tab for every hydrated session to the worktree's
 * active (or first) group. Used when the panel layout file was missing or
 * corrupt and a default layout was built instead. Returns whether any tab
 * was added.
 */
function appendPreservedBrowserTabs(worktreeKey: string): boolean {
  const bucket = useBrowserStore.getState().worktrees[worktreeKey];
  if (!bucket?.hydrated || bucket.browserOrder.length === 0) {
    return false;
  }
  const store = usePanelLayoutStore.getState();
  const layout = store.layouts[worktreeKey];
  if (!layout) {
    return false;
  }
  const groupId = layout.activeGroupId ?? Object.keys(layout.groups)[0] ?? null;
  if (groupId === null) {
    return false;
  }
  let added = false;
  for (const browserId of bucket.browserOrder) {
    const instanceKey = getPanelInstanceKey({
      kind: 'browser',
      instance: { browserId },
    });
    if (findPanelByInstanceKey(worktreeKey, instanceKey) !== null) {
      continue;
    }
    const panelId =
      usePanelLayoutStore.getState().addTab(worktreeKey, groupId, 'browser', {
        panelId: browserPanelIdFor(browserId),
        instance: { browserId },
      }) ??
      usePanelLayoutStore.getState().addTab(worktreeKey, groupId, 'browser', {
        instance: { browserId },
      });
    if (panelId !== null) {
      added = true;
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// Recovery completion (hydration Retry)
// ---------------------------------------------------------------------------

/**
 * Completes a parked migration after hydration succeeds on Retry: replaces
 * the in-memory recovery panel with real bound Browser panels, resumes
 * panel-layout persistence, and saves both files. Installed on the browser
 * store as the hydration-recovery handler.
 */
export async function completeBrowserMigrationRecovery(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const worktreeKey = worktreeKeyOf(projectId, worktreeId);
  if (!pendingRecoveries.has(worktreeKey)) {
    return;
  }
  const bucket = useBrowserStore.getState().worktrees[worktreeKey];
  if (!bucket?.hydrated) {
    return;
  }

  const recoveryLocation = findPanelByInstanceKey(
    worktreeKey,
    getPanelInstanceKey({
      kind: 'browser',
      instance: { browserId: RECOVERY_BROWSER_ID },
    }),
  );
  if (recoveryLocation === null) {
    // Already-migrated layouts use their existing bound Browser panels as the
    // recovery surface and therefore have no special placeholder to replace.
    // Reconcile only now that hydration succeeded, then resume normal writes.
    // If no Browser panel remains, the recovery placeholder was closed; keep
    // both files untouched so recovery is re-entered next launch.
    if (liveBoundBrowserIds(worktreeKey).size > 0) {
      appendPreservedBrowserTabs(worktreeKey);
      reconcileSessionsWithPanels(worktreeKey);
      await saveNormalizedBrowserState(worktreeKey);
      pendingRecoveries.delete(worktreeKey);
      resumePanelLayoutPersistence(worktreeKey);
      schedulePanelLayoutSave(worktreeKey, { userInitiated: false });
    }
    return;
  }

  const store = usePanelLayoutStore.getState();
  const layout = store.layouts[recoveryLocation.layoutKey];
  const group = layout?.groups[recoveryLocation.groupId];
  const recoveryTab = group?.tabs.find(
    (tab) => tab.panelId === recoveryLocation.panelId,
  );
  if (!layout || !group || !recoveryTab) {
    return;
  }
  const wasActive = group.activePanelId === recoveryLocation.panelId;
  const pinned = recoveryTab.pinned === true;

  const alreadyBoundSessionIds = new Set(
    Array.from(liveBoundBrowserIds(worktreeKey).keys()).filter(
      (browserId) =>
        !isRecoveryBrowserId(browserId) &&
        bucket.browsers[browserId] !== undefined,
    ),
  );
  let browserOrder = bucket.browserOrder.filter(
    (browserId) => !alreadyBoundSessionIds.has(browserId),
  );
  if (browserOrder.length === 0 && alreadyBoundSessionIds.size > 0) {
    // Every restored session is already bound elsewhere. Drop only the
    // temporary recovery placeholder; rebinding here would violate the
    // one-panel-per-session invariant.
    usePanelLayoutStore
      .getState()
      .closeTab(
        recoveryLocation.layoutKey,
        recoveryLocation.groupId,
        recoveryLocation.panelId,
      );
    reconcileSessionsWithPanels(worktreeKey);
    await saveNormalizedBrowserState(worktreeKey);
    pendingRecoveries.delete(worktreeKey);
    resumePanelLayoutPersistence(worktreeKey);
    schedulePanelLayoutSave(worktreeKey, { userInitiated: false });
    return;
  }
  if (browserOrder.length === 0) {
    try {
      const snapshot = await useBrowserStore
        .getState()
        .createBrowser(projectId, worktreeId);
      browserOrder = [snapshot.id];
    } catch {
      return; // Stay in recovery; a later Retry can try again.
    }
  }

  // First browser keeps the recovery panel's slot (which itself preserved
  // the original placeholder panel id); the rest insert after it.
  const [firstBrowserId, ...restBrowserIds] = browserOrder;
  const replaced = usePanelLayoutStore
    .getState()
    .replaceTab(
      recoveryLocation.layoutKey,
      recoveryLocation.groupId,
      recoveryLocation.panelId,
      {
        panelId: recoveryLocation.panelId,
        kind: 'browser',
        instance: { browserId: firstBrowserId },
        ...(pinned ? { pinned: true } : {}),
      },
    );
  if (!replaced) {
    return;
  }
  let previousPanelId = recoveryLocation.panelId;
  for (const browserId of restBrowserIds) {
    const panelId = usePanelLayoutStore
      .getState()
      .addTab(recoveryLocation.layoutKey, recoveryLocation.groupId, 'browser', {
        panelId: browserPanelIdFor(browserId),
        instance: { browserId },
      });
    if (panelId === null) {
      continue;
    }
    if (pinned) {
      usePanelLayoutStore
        .getState()
        .setTabPinned(
          recoveryLocation.layoutKey,
          recoveryLocation.groupId,
          panelId,
          true,
        );
    }
    const currentGroup =
      usePanelLayoutStore.getState().layouts[recoveryLocation.layoutKey]
        ?.groups[recoveryLocation.groupId];
    const anchorIndex =
      currentGroup?.tabs.findIndex((tab) => tab.panelId === previousPanelId) ??
      -1;
    if (anchorIndex !== -1) {
      usePanelLayoutStore
        .getState()
        .reorderTab(
          recoveryLocation.layoutKey,
          recoveryLocation.groupId,
          panelId,
          anchorIndex + 1,
        );
    }
    previousPanelId = panelId;
  }

  if (wasActive) {
    const activeBrowserId =
      useBrowserStore.getState().worktrees[worktreeKey]?.activeBrowserId;
    const activePanel =
      activeBrowserId !== null && activeBrowserId !== undefined
        ? findPanelByInstanceKey(
            worktreeKey,
            getPanelInstanceKey({
              kind: 'browser',
              instance: { browserId: activeBrowserId },
            }),
          )
        : null;
    if (activePanel !== null) {
      usePanelLayoutStore
        .getState()
        .selectTab(
          activePanel.layoutKey,
          activePanel.groupId,
          activePanel.panelId,
          {
            focus: false,
          },
        );
    }
  }

  reconcileSessionsWithPanels(worktreeKey);
  await saveNormalizedBrowserState(worktreeKey);
  pendingRecoveries.delete(worktreeKey);
  resumePanelLayoutPersistence(worktreeKey);
  schedulePanelLayoutSave(worktreeKey, { userInitiated: false });
}

// Route the browser store's hydration Retry through recovery completion.
setBrowserHydrationRecoveryHandler(completeBrowserMigrationRecovery);
