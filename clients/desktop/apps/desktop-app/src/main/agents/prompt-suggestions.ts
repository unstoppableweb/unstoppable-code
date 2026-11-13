import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  PROMPT_SUGGESTION_EVENT_TYPE,
  type PromptSuggestionEventData,
} from '@canopy/desktop-shared/types';
import { PROMPT_SUGGESTIONS_EXPERIMENT_ID } from '@canopy/desktop-shared/lib/labs-experiments';
import { getLabsExperimentsService } from '../services/labs-experiments-runtime';
import { sendToWindow } from '../lib/window-send';

/**
 * Whether the `prompt-suggestions` Labs experiment is on, read live from
 * main's snapshot. Off before the snapshot is ready, and off if Labs cannot be
 * read, so a provider is never asked for a suggestion by default.
 */
export function isPromptSuggestionsEnabled(): boolean {
  try {
    const snapshot = getLabsExperimentsService().getSnapshot();
    return (
      snapshot.ready &&
      snapshot.experiments.some(
        (entry) =>
          entry.id === PROMPT_SUGGESTIONS_EXPERIMENT_ID && entry.enabled,
      )
    );
  } catch {
    return false;
  }
}

/**
 * Sends a provider's predicted next message to the window as a transient
 * `chat:event`, outside admission and commit, so it is never written to the
 * transcript. Dropped when the experiment was switched off since the provider
 * was asked, or when the text is empty.
 */
export function sendPromptSuggestion(
  getWindow: () => BrowserWindow | null,
  target: { projectId: string; worktreeId: string; chatId: string },
  suggestion: unknown,
  turnUserMessageId: string,
): void {
  if (typeof suggestion !== 'string') return;
  const text = suggestion.trim();
  if (!text || !isPromptSuggestionsEnabled()) return;
  const data: PromptSuggestionEventData = {
    type: PROMPT_SUGGESTION_EVENT_TYPE,
    text,
    turnUserMessageId,
  };
  sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, { ...target, data });
}
