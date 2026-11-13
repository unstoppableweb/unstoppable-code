/**
 * Propagates permanent terminal-panel closes to the bound PTY/session store.
 * Moving, reordering, popping out, collapsing, and whole-layout teardown keep
 * the binding alive (or intentionally skip destruction on teardown).
 */
import {
  getAuxPanelLayoutOwnerKey,
  usePanelLayoutStore,
  type WorktreePanelLayout,
} from '@/stores/panelLayoutStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { ensureTerminalWorktreeHydrated } from '@/stores/terminalStore';
import { useTerminalActivityStore } from '@/stores/terminalActivityStore';
import { disposeInstance } from '@/lib/terminal-instances';

let installed = false;
let pending = false;
let lastBindings = new Map<string, Set<string>>();

function collect(
  layouts: Record<string, WorktreePanelLayout>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const [layoutKey, layout] of Object.entries(layouts)) {
    const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
    const ids = result.get(ownerKey) ?? new Set<string>();
    result.set(ownerKey, ids);
    for (const group of Object.values(layout.groups)) {
      for (const tab of group.tabs) {
        const terminalId =
          tab.kind === 'terminal' ? tab.instance?.terminalId : undefined;
        if (terminalId) ids.add(terminalId);
      }
    }
  }
  return result;
}

function splitOwnerKey(ownerKey: string): {
  projectId: string;
  worktreeId: string;
} {
  const separator = ownerKey.indexOf('/');
  return {
    projectId: ownerKey.slice(0, separator),
    worktreeId: ownerKey.slice(separator + 1),
  };
}

async function closeTerminalBinding(
  ownerKey: string,
  projectId: string,
  worktreeId: string,
  terminalId: string,
): Promise<void> {
  let session =
    useTerminalStore.getState().worktrees[ownerKey]?.sessions[terminalId];
  if (session === undefined) {
    await ensureTerminalWorktreeHydrated(projectId, worktreeId).catch(
      () => undefined,
    );
    if (
      collect(usePanelLayoutStore.getState().layouts)
        .get(ownerKey)
        ?.has(terminalId)
    ) {
      return;
    }
    session =
      useTerminalStore.getState().worktrees[ownerKey]?.sessions[terminalId];
  }
  if (session === undefined || session.live) {
    useTerminalActivityStore.getState().markUserInitiatedClose(terminalId);
    void window.api.terminal.kill({ terminalId }).catch(() => undefined);
  }
  useTerminalStore.getState().removeTerminal(projectId, worktreeId, terminalId);
  disposeInstance(terminalId);
}

/**
 * Closes one terminal binding on behalf of a caller performing a DELIBERATE
 * whole-layout replacement (layout reset): the incremental sweep treats a
 * missing layout family as transient teardown and leaves sessions alone, so
 * a reset that omits a terminal panel from the rebuilt default must close
 * the orphaned PTY itself. Re-checks live bindings first, so a terminal the
 * rebuilt layout still hosts is left untouched.
 */
export function closeOmittedTerminalBinding(
  ownerKey: string,
  terminalId: string,
): void {
  const { projectId, worktreeId } = splitOwnerKey(ownerKey);
  void closeTerminalBinding(ownerKey, projectId, worktreeId, terminalId);
}

function sweep(): void {
  const current = collect(usePanelLayoutStore.getState().layouts);
  for (const [ownerKey, previousIds] of Array.from(lastBindings.entries())) {
    const currentIds = current.get(ownerKey);
    if (!currentIds) continue; // whole layout family teardown
    const { projectId, worktreeId } = splitOwnerKey(ownerKey);
    for (const terminalId of Array.from(previousIds)) {
      if (currentIds.has(terminalId)) continue;
      void closeTerminalBinding(ownerKey, projectId, worktreeId, terminalId);
    }
  }
  lastBindings = current;
}

export function initTerminalPanelSync(): void {
  if (installed) return;
  installed = true;
  lastBindings = collect(usePanelLayoutStore.getState().layouts);
  usePanelLayoutStore.subscribe(() => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      sweep();
    });
  });
}
