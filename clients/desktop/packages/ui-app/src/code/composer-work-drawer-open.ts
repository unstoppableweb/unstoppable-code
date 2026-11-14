'use client';

import { useSyncExternalStore } from 'react';

/**
 * The composer work drawer's open card, shared by every composer in the
 * window. The drawer stays as the user left it: opened, it stays open across
 * sent messages, chat, tab and worktree switches, and the moments its work
 * runs out, until the user closes it (its pill, its minus button or Esc).
 * The value is the kind of work last opened (`running`, `queued`, …), or
 * null once closed.
 */
let openKind: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string | null {
  return openKind;
}

/** Nothing renders open on the server. */
function getServerSnapshot(): null {
  return null;
}

export function setComposerWorkDrawerOpenKind(kind: string | null): void {
  if (openKind === kind) return;
  openKind = kind;
  for (const listener of listeners) listener();
}

export function useComposerWorkDrawerOpenKind(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
