import { create } from 'zustand';
import type { PromptSuggestion } from '@canopy/ui-shared';
import {
  chatBannerKey,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';

/**
 * Suggestions outlive their chats here, so keep only the most recently
 * updated ones. The composer drops a stale one by its turn anyway.
 */
const MAX_PROMPT_SUGGESTIONS = 64;

interface PromptSuggestionEntry {
  suggestion: PromptSuggestion;
  /** Escape dismissed it; a later suggestion clears this. */
  dismissed: boolean;
}

interface PromptSuggestionStore {
  byChat: Record<string, PromptSuggestionEntry | undefined>;
  setSuggestion: (
    target: ChatBannerTarget,
    suggestion: PromptSuggestion,
  ) => void;
  dismiss: (target: ChatBannerTarget) => void;
}

/**
 * Each chat's latest next prompt suggestion (the `prompt-suggestions` Labs
 * experiment), fed by main's transient `canopy_prompt_suggestion` chat event.
 * Renderer memory only: never persisted and never part of the transcript.
 */
export const usePromptSuggestionStore = create<PromptSuggestionStore>(
  (set) => ({
    byChat: {},
    setSuggestion: (target, suggestion): void => {
      const key = chatBannerKey(target);
      set((state) => {
        const byChat = { ...state.byChat };
        // Re-insert so the key order is least recently updated first.
        delete byChat[key];
        byChat[key] = { suggestion, dismissed: false };
        const keys = Object.keys(byChat);
        for (const stale of keys.slice(
          0,
          Math.max(0, keys.length - MAX_PROMPT_SUGGESTIONS),
        ))
          delete byChat[stale];
        return { byChat };
      });
    },
    dismiss: (target): void => {
      const key = chatBannerKey(target);
      set((state) => {
        const entry = state.byChat[key];
        if (!entry || entry.dismissed) return state;
        return {
          byChat: { ...state.byChat, [key]: { ...entry, dismissed: true } },
        };
      });
    },
  }),
);

/** The chat's latest suggestion and whether Escape dismissed it. */
export function usePromptSuggestionEntry(
  target: ChatBannerTarget | null,
): PromptSuggestionEntry | undefined {
  return usePromptSuggestionStore((state) =>
    target ? state.byChat[chatBannerKey(target)] : undefined,
  );
}
