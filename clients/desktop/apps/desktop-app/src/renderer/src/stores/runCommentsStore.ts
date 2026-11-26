import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Which shared run's comments panel is open (CAN-397).
//
// Deliberately holds ONLY the routing target, never comment data. Comments are
// server-authoritative: the panel fetches through `runs:comments:*` IPC and
// keeps the server's comment state in local component state. There is no
// desktop-local comment store and no merge algorithm — mirroring the same rule
// the main process and the web viewer follow.
// ---------------------------------------------------------------------------

/** Chat whose shared run the comments panel is showing. */
export interface RunCommentsTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** Chat title, for the panel header. */
  title: string;
}

interface RunCommentsState {
  target: RunCommentsTarget | null;
  open: (target: RunCommentsTarget) => void;
  close: () => void;
}

export const useRunCommentsStore = create<RunCommentsState>((set) => ({
  target: null,
  open: (target): void => set({ target }),
  close: (): void => set({ target: null }),
}));

/** Imperative opener for non-React callers (menus, notification click). */
export function openRunComments(target: RunCommentsTarget): void {
  useRunCommentsStore.getState().open(target);
}
