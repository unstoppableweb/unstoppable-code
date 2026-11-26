import type { TerminalSession } from '@canopy/desktop-shared/types';
import {
  hasPendingTerminalPlacement,
  onTerminalPlacementsSettled,
  registerTerminalClientReset,
  requireTerminalClientLifetime,
} from '@canopy/app-state/terminal';
import {
  ensureTerminalWorktreeHydrated,
  selectBucket,
  useTerminalStore,
} from '@/stores/terminalStore';
import {
  ensureTerminalPanelVisible,
  getTerminalPanelBindings,
} from '@/lib/panels/terminal-panel-activation';
import {
  getAuxPanelLayoutOwnerKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { isWebCoreScope } from '@/lib/chat-authority';
import { layoutScopeServesPanelKind } from '@/lib/panels/scope-panel-kinds';
import { registerWorktreeRemovalListener } from '@/lib/worktree-removal-listeners';

const materializations = new Map<
  string,
  { hydration: Promise<void>; promise: Promise<void> }
>();
interface MaterializationScope {
  hydration: Promise<void>;
  reconcile: () => void;
  dispose: () => void;
  probe?: () => LegacyTerminalPanelMaterializationProbe;
}
export interface LegacyTerminalPanelMaterializationProbe {
  readonly observing: boolean;
  readonly sessionUpdates: number;
  readonly layoutUpdates: number;
}
const scopes = new Map<string, MaterializationScope>();

export function probeLegacyTerminalPanelMaterializationForE2e(
  worktreeKey: string,
): (() => LegacyTerminalPanelMaterializationProbe) | undefined {
  if (!__CANOPY_E2E__) return undefined;
  return scopes.get(worktreeKey)?.probe;
}

function disposeLegacyTerminalPanelMaterialization(worktreeKey: string): void {
  scopes.get(worktreeKey)?.dispose();
  scopes.delete(worktreeKey);
  materializations.delete(worktreeKey);
}

registerWorktreeRemovalListener(disposeLegacyTerminalPanelMaterialization);

registerTerminalClientReset((): void => {
  materializations.clear();
  for (const scope of scopes.values()) scope.dispose();
  scopes.clear();
});

function terminalTitle(session: TerminalSession): string {
  return session.title?.trim() || 'Terminal';
}

function observeLegacyTerminalPanels(
  projectId: string,
  worktreeId: string,
  worktreeKey: string,
  hydration: Promise<void>,
): MaterializationScope {
  const lifetime = requireTerminalClientLifetime();
  // Retain successful bindings across pane unmounts: Close must not become
  // an invitation to reopen a session while close-sync catches up.
  const materialized = new Set(getTerminalPanelBindings(worktreeKey));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let sessionUpdates = 0;
  let layoutUpdates = 0;
  const rememberBindings = (): void => {
    for (const id of getTerminalPanelBindings(worktreeKey))
      materialized.add(id);
  };
  const reconcile = (): void => {
    if (!active || !lifetime.isCurrent()) return;
    if (
      isWebCoreScope(worktreeId) &&
      !layoutScopeServesPanelKind(worktreeKey, 'terminal')
    )
      return;
    // An explicit spawn binds its own shell; settling reschedules this pass.
    if (hasPendingTerminalPlacement(projectId, worktreeId)) return;
    rememberBindings();
    const bucket = selectBucket(
      useTerminalStore.getState(),
      projectId,
      worktreeId,
    );
    if (!bucket) return;
    for (const group of bucket.groups) {
      for (const id of group.terminalIds) {
        const session = bucket.sessions[id];
        if (!session || materialized.has(id)) continue;
        const placed = ensureTerminalPanelVisible(worktreeKey, undefined, {
          terminalId: id,
          title: terminalTitle(session),
          focus: false,
        });
        // No destination yet is retryable, not a completed materialization.
        if (placed !== null) materialized.add(id);
      }
    }
  };
  const schedule = (): void => {
    if (timer !== undefined) return;
    // Spawn publishes its session before binding the requested main/aux pane.
    // Let the originating action finish, then re-read its binding.
    timer = setTimeout((): void => {
      timer = undefined;
      reconcile();
    }, 0);
  };
  const stopSessions = useTerminalStore.subscribe((state, previous): void => {
    if (__CANOPY_E2E__) sessionUpdates += 1;
    const next = selectBucket(state, projectId, worktreeId);
    const before = selectBucket(previous, projectId, worktreeId);
    if (before !== undefined && next === undefined) {
      const scope = scopes.get(worktreeKey);
      if (scope?.reconcile === reconcile) {
        disposeLegacyTerminalPanelMaterialization(worktreeKey);
      }
      return;
    }
    if (next?.sessions !== before?.sessions || next?.groups !== before?.groups)
      schedule();
  });
  const stopLayouts = usePanelLayoutStore.subscribe((state, previous): void => {
    if (__CANOPY_E2E__) layoutUpdates += 1;
    if (state.layouts === previous.layouts) return;
    const changedFamily = Object.keys({
      ...state.layouts,
      ...previous.layouts,
    }).some(
      (key) =>
        (key === worktreeKey ||
          getAuxPanelLayoutOwnerKey(key) === worktreeKey) &&
        state.layouts[key] !== previous.layouts[key],
    );
    if (!changedFamily) return;
    rememberBindings();
    schedule();
  });
  const stopPlacements = onTerminalPlacementsSettled(
    (settledProjectId, settledWorktreeId): void => {
      if (settledProjectId === projectId && settledWorktreeId === worktreeId)
        schedule();
    },
  );
  return {
    hydration,
    reconcile,
    dispose: (): void => {
      active = false;
      stopSessions();
      stopLayouts();
      stopPlacements();
      if (timer !== undefined) clearTimeout(timer);
    },
    ...(__CANOPY_E2E__
      ? {
          probe: (): LegacyTerminalPanelMaterializationProbe => ({
            observing: active,
            sessionUpdates,
            layoutUpdates,
          }),
        }
      : {}),
  };
}

export function ensureLegacyTerminalPanelsMaterialized(
  projectId: string,
  worktreeId: string,
  worktreeKey: string,
): Promise<void> {
  // A cloud chat's terminals are its terminal client's. With them off, a
  // panel still mounted while the cowork page closes it has nothing to load,
  // and main must never be asked with the chat's ids (CAN-6175 R10).
  if (
    isWebCoreScope(worktreeId) &&
    !layoutScopeServesPanelKind(worktreeKey, 'terminal')
  )
    return Promise.resolve();
  const hydration = ensureTerminalWorktreeHydrated(projectId, worktreeId);
  const existing = materializations.get(worktreeKey);
  if (existing?.hydration === hydration) return existing.promise;

  let scope = scopes.get(worktreeKey);
  // Purge can invalidate an initial load before it publishes any bucket.
  // Its replacement hydration must not inherit that scope's suppression.
  if (
    scope !== undefined &&
    scope.hydration !== hydration &&
    selectBucket(useTerminalStore.getState(), projectId, worktreeId) ===
      undefined
  ) {
    scope.dispose();
    scope = undefined;
  }
  if (scope === undefined) {
    scope = observeLegacyTerminalPanels(
      projectId,
      worktreeId,
      worktreeKey,
      hydration,
    );
    scopes.set(worktreeKey, scope);
  }
  const materialization = hydration.then(scope.reconcile).finally((): void => {
    if (materializations.get(worktreeKey)?.promise === materialization)
      materializations.delete(worktreeKey);
  });
  materializations.set(worktreeKey, { hydration, promise: materialization });
  return materialization;
}
