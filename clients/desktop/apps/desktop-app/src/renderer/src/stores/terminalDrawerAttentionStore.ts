import { create } from 'zustand';
import type {
  TerminalExitEvent,
  TerminalOutputProgressEvent,
  TerminalRunningChangedEvent,
} from '@canopy/desktop-shared/types';

interface TerminalAttentionEntry {
  running: boolean;
  unread: boolean;
  lastSequence: number;
}
interface WorktreeAttention {
  collapsed: boolean;
  terminals: Record<string, TerminalAttentionEntry>;
}
interface TerminalDrawerAttentionState {
  worktrees: Record<string, WorktreeAttention>;
  setCollapsed(worktreeKey: string, collapsed: boolean): void;
  applyRunning(event: TerminalRunningChangedEvent): void;
  /** Output bytes or, for a terminal this window reads itself, their progress. */
  applyOutput(event: TerminalOutputProgressEvent): void;
  applyExit(event: TerminalExitEvent): void;
  remove(worktreeKey: string, terminalId: string): void;
  reconcileSessions(
    sessions: readonly {
      id: string;
      projectId: string;
      worktreeId: string;
      running?: boolean;
      processName?: string | null;
    }[],
  ): void;
}

const keyFor = (event: { projectId: string; worktreeId: string }): string =>
  `${event.projectId}/${event.worktreeId}`;
const emptyEntry = (): TerminalAttentionEntry => ({
  running: false,
  unread: false,
  lastSequence: 0,
});

export const useTerminalDrawerAttentionStore =
  create<TerminalDrawerAttentionState>((set) => ({
    worktrees: {},
    setCollapsed: (worktreeKey, collapsed): void => {
      set((state) => {
        const current = state.worktrees[worktreeKey] ?? {
          collapsed: false,
          terminals: {},
        };
        const terminals = collapsed
          ? current.terminals
          : Object.fromEntries(
              Object.entries(current.terminals).map(([id, entry]) => [
                id,
                { ...entry, unread: false },
              ]),
            );
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeKey]: { collapsed, terminals },
          },
        };
      });
    },
    applyRunning: (event): void => {
      const worktreeKey = keyFor(event);
      set((state) => {
        const current = state.worktrees[worktreeKey] ?? {
          collapsed: false,
          terminals: {},
        };
        const entry = current.terminals[event.terminalId] ?? emptyEntry();
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeKey]: {
              ...current,
              terminals: {
                ...current.terminals,
                [event.terminalId]: { ...entry, running: event.running },
              },
            },
          },
        };
      });
    },
    applyOutput: (event): void => {
      const worktreeKey = keyFor(event);
      set((state) => {
        const current = state.worktrees[worktreeKey] ?? {
          collapsed: false,
          terminals: {},
        };
        const entry = current.terminals[event.terminalId] ?? emptyEntry();
        if (event.seq <= entry.lastSequence) return state;
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeKey]: {
              ...current,
              terminals: {
                ...current.terminals,
                [event.terminalId]: {
                  ...entry,
                  lastSequence: event.seq,
                  unread: entry.unread || current.collapsed,
                },
              },
            },
          },
        };
      });
    },
    applyExit: (event): void => {
      useTerminalDrawerAttentionStore.getState().applyRunning({
        ...event,
        running: false,
        processName: null,
      });
    },
    remove: (worktreeKey, terminalId): void => {
      set((state) => {
        const current = state.worktrees[worktreeKey];
        if (!current?.terminals[terminalId]) return state;
        const terminals = { ...current.terminals };
        delete terminals[terminalId];
        return {
          worktrees: {
            ...state.worktrees,
            [worktreeKey]: { ...current, terminals },
          },
        };
      });
    },
    reconcileSessions: (sessions): void => {
      const live = new Set(
        sessions.map(
          (session) =>
            `${session.projectId}/${session.worktreeId}/${session.id}`,
        ),
      );
      set((state) => {
        const worktrees = Object.fromEntries(
          Object.entries(state.worktrees).map(([worktreeKey, worktree]) => [
            worktreeKey,
            {
              ...worktree,
              terminals: Object.fromEntries(
                Object.entries(worktree.terminals).filter(([terminalId]) =>
                  live.has(`${worktreeKey}/${terminalId}`),
                ),
              ),
            },
          ]),
        );
        for (const session of sessions) {
          const worktreeKey = `${session.projectId}/${session.worktreeId}`;
          const current = worktrees[worktreeKey] ?? {
            collapsed: false,
            terminals: {},
          };
          const existing = current.terminals[session.id] ?? emptyEntry();
          worktrees[worktreeKey] = {
            ...current,
            terminals: {
              ...current.terminals,
              [session.id]: {
                ...existing,
                running: session.running === true,
              },
            },
          };
        }
        return { worktrees };
      });
    },
  }));

export function terminalDrawerNeedsAttention(worktreeKey: string): boolean {
  const state =
    useTerminalDrawerAttentionStore.getState().worktrees[worktreeKey];
  return Boolean(
    state?.collapsed &&
    Object.values(state.terminals).some(
      (entry) => entry.running || entry.unread,
    ),
  );
}
