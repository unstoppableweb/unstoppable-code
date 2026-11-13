import type { TerminalSession } from '@canopy/desktop-shared/types';
import {
  registerTerminalClientReset,
  requireTerminalClientLifetime,
} from '@canopy/app-state/terminal';
import {
  ensureTerminalWorktreeHydrated,
  selectBucket,
  useTerminalStore,
} from '@/stores/terminalStore';
import { ensureTerminalPanelVisible } from '@/lib/panels/terminal-panel-activation';
import { isWebCoreScope } from '@/lib/chat-authority';
import { layoutScopeServesPanelKind } from '@/lib/panels/scope-panel-kinds';

const materializations = new Map<string, Promise<void>>();
registerTerminalClientReset(() => materializations.clear());

function terminalTitle(session: TerminalSession): string {
  return session.title?.trim() || 'Terminal';
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
  const existing = materializations.get(worktreeKey);
  if (existing) return existing;

  const lifetime = requireTerminalClientLifetime();
  const materialization = ensureTerminalWorktreeHydrated(projectId, worktreeId)
    .then(() => {
      if (!lifetime.isCurrent()) return;
      const hydrated = selectBucket(
        useTerminalStore.getState(),
        projectId,
        worktreeId,
      );
      if (!hydrated) return;

      // Lift every legacy nested group/pane into the workspace tab system.
      // The first session replaces the default unbound placeholder in place;
      // the rest append beside it without stealing focus or expanding a
      // collapsed group during hydration.
      for (const group of hydrated.groups) {
        for (const id of group.terminalIds) {
          const known = hydrated.sessions[id];
          if (!known) continue;
          ensureTerminalPanelVisible(worktreeKey, undefined, {
            terminalId: id,
            title: terminalTitle(known),
            focus: false,
          });
        }
      }
    })
    .catch((error: unknown) => {
      if (materializations.get(worktreeKey) === materialization)
        materializations.delete(worktreeKey);
      throw error;
    });
  materializations.set(worktreeKey, materialization);
  return materialization;
}
