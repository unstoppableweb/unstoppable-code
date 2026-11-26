'use client';

import { create } from 'zustand';

export type SubagentQueuedDraftState =
  | 'queued'
  | 'sending'
  | 'interrupting'
  | 'awaiting-settle'
  | 'failed';

/** One user message waiting for or being delivered to a managed subagent. */
export interface SubagentQueuedDraft {
  readonly id: string;
  readonly text: string;
  readonly state: SubagentQueuedDraftState;
  readonly error?: string;
  /** The host's raw reason for `error`, offered through Copy details. */
  readonly errorDetails?: string;
  readonly retryOnStatusChange?: boolean;
  readonly retryOperation?: 'follow_up' | 'steer' | 'interrupt';
  /** An accepted steer awaiting its delivery outcome on the delegate. */
  readonly deliveryOperationId?: string;
  /** The delegate's control before the steer, which does not supersede it. */
  readonly deliveryBaselineOperationId?: string;
}

/** The module-lifetime draft state for one root-chat/subagent pair. */
export interface SubagentComposerDraftState {
  readonly input: string;
  readonly recipientId: string | null;
  readonly queue: readonly SubagentQueuedDraft[];
  readonly inFlight: boolean;
  readonly error: string | null;
  /** The host's raw reason for `error`, offered through Copy details. */
  readonly errorDetails: string | null;
  /**
   * Do not send the next queued follow-up until the accepted run is seen,
   * live or already settled in a later run generation.
   */
  readonly waitForLiveAfterFollowUp: boolean;
  /** The latest run generation when the waited-on follow-up was sent. */
  readonly followUpFromRunGeneration: number | null;
}

interface SubagentComposerStoreState {
  readonly drafts: Readonly<Record<string, SubagentComposerDraftState>>;
  ensureDraft: (key: string, recipientId: string) => void;
  setInput: (key: string, input: string) => void;
  setRecipientId: (key: string, recipientId: string) => void;
  enqueueDraft: (
    key: string,
    text: string,
    position?: 'front' | 'back',
  ) => string;
  updateQueuedDraft: (
    key: string,
    id: string,
    update: (draft: SubagentQueuedDraft) => SubagentQueuedDraft,
  ) => void;
  removeQueuedDraft: (key: string, id: string) => void;
  beginOperation: (key: string) => boolean;
  endOperation: (key: string) => void;
  setError: (key: string, error: string | null, details?: string) => void;
  setWaitForLiveAfterFollowUp: (
    key: string,
    wait: boolean,
    fromRunGeneration?: number,
  ) => void;
  forgetRootChat: (rootChatId: string) => void;
}

const EMPTY_DRAFT: SubagentComposerDraftState = {
  input: '',
  recipientId: null,
  queue: [],
  inFlight: false,
  error: null,
  errorDetails: null,
  waitForLiveAfterFollowUp: false,
  followUpFromRunGeneration: null,
};

let draftSequence = 0;

/** Stable in-memory key that cannot collide on delimiter-containing IDs. */
export function subagentDraftKey(
  rootChatId: string,
  subagentId: string,
): string {
  return `subagent:${encodeURIComponent(rootChatId)}:${encodeURIComponent(subagentId)}`;
}

function patchDraft(
  state: SubagentComposerStoreState,
  key: string,
  patch: Partial<SubagentComposerDraftState>,
): Readonly<Record<string, SubagentComposerDraftState>> {
  const current = state.drafts[key] ?? EMPTY_DRAFT;
  return { ...state.drafts, [key]: { ...current, ...patch } };
}

/**
 * Shared composer drafts survive panel unmounts and tab switches. They are
 * intentionally in-memory only and are forgotten when a root chat is deleted.
 */
export const useSubagentComposerStore = create<SubagentComposerStoreState>()(
  (set) => ({
    drafts: {},
    ensureDraft: (key, recipientId): void => {
      set((state) => {
        if (state.drafts[key]) return state;
        return {
          drafts: { ...state.drafts, [key]: { ...EMPTY_DRAFT, recipientId } },
        };
      });
    },
    setInput: (key, input): void => {
      set((state) => ({
        drafts: patchDraft(state, key, { input, error: null }),
      }));
    },
    setRecipientId: (key, recipientId): void => {
      set((state) => ({ drafts: patchDraft(state, key, { recipientId }) }));
    },
    enqueueDraft: (key, text, position = 'back'): string => {
      const id = `subagent-message-${Date.now()}-${++draftSequence}`;
      set((state) => {
        const current = state.drafts[key] ?? EMPTY_DRAFT;
        const queuedDraft: SubagentQueuedDraft = { id, text, state: 'queued' };
        return {
          drafts: {
            ...state.drafts,
            [key]: {
              ...current,
              queue:
                position === 'front'
                  ? [queuedDraft, ...current.queue]
                  : [...current.queue, queuedDraft],
              error: null,
            },
          },
        };
      });
      return id;
    },
    updateQueuedDraft: (key, id, update): void => {
      set((state) => {
        const current = state.drafts[key] ?? EMPTY_DRAFT;
        const queue = current.queue.map((draft) =>
          draft.id === id ? update(draft) : draft,
        );
        return { drafts: patchDraft(state, key, { queue }) };
      });
    },
    removeQueuedDraft: (key, id): void => {
      set((state) => {
        const current = state.drafts[key] ?? EMPTY_DRAFT;
        return {
          drafts: patchDraft(state, key, {
            queue: current.queue.filter((draft) => draft.id !== id),
          }),
        };
      });
    },
    beginOperation: (key): boolean => {
      let started = false;
      set((state) => {
        const current = state.drafts[key] ?? EMPTY_DRAFT;
        if (current.inFlight) return state;
        started = true;
        return {
          drafts: patchDraft(state, key, { inFlight: true, error: null }),
        };
      });
      return started;
    },
    endOperation: (key): void => {
      set((state) => ({ drafts: patchDraft(state, key, { inFlight: false }) }));
    },
    setError: (key, error, details): void => {
      set((state) => ({
        drafts: patchDraft(state, key, {
          error,
          errorDetails: details ?? null,
        }),
      }));
    },
    setWaitForLiveAfterFollowUp: (key, wait, fromRunGeneration): void => {
      set((state) => ({
        drafts: patchDraft(state, key, {
          waitForLiveAfterFollowUp: wait,
          followUpFromRunGeneration:
            wait && fromRunGeneration !== undefined ? fromRunGeneration : null,
        }),
      }));
    },
    forgetRootChat: (rootChatId): void => {
      const prefix = `subagent:${encodeURIComponent(rootChatId)}:`;
      set((state) => {
        const drafts = Object.fromEntries(
          Object.entries(state.drafts).filter(
            ([key]) => !key.startsWith(prefix),
          ),
        );
        return { drafts };
      });
    },
  }),
);

/** A stable empty value for a key that has not yet been initialized. */
export function getSubagentComposerDraft(
  key: string,
): SubagentComposerDraftState {
  return useSubagentComposerStore.getState().drafts[key] ?? EMPTY_DRAFT;
}

/** Select one key's state without subscribing to updates for other chats. */
export function useSubagentComposerDraft(
  key: string,
): SubagentComposerDraftState {
  return useSubagentComposerStore((state) => state.drafts[key] ?? EMPTY_DRAFT);
}

/** Drop all in-memory composer state belonging to a deleted root chat. */
export function forgetSubagentDrafts(rootChatId: string): void {
  useSubagentComposerStore.getState().forgetRootChat(rootChatId);
}
