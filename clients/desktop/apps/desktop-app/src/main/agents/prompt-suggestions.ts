import {
  PROMPT_SUGGESTION_EVENT_TYPE,
  type PromptSuggestionEventData,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';
import type { AgentInterfacePort } from './agent-interface-port';

/**
 * Whether the person has next prompt suggestions on (Settings → Models →
 * Next prompt suggestions, on by default). Unreadable preferences use the
 * default.
 */
export async function readPromptSuggestionsEnabled(): Promise<boolean> {
  try {
    const preferences = await readPreferencesFile();
    return preferences.promptSuggestionsEnabled !== false;
  } catch {
    return DEFAULT_PREFERENCES.promptSuggestionsEnabled !== false;
  }
}

/**
 * Sends a provider's predicted next message to the chat's interfaces as a transient
 * `chat:event`, outside admission and commit, so it is never written to the
 * transcript. Dropped when the setting was switched off since the provider
 * was asked, or when the text is empty.
 */
export async function sendPromptSuggestion(
  interfacePort: AgentInterfacePort,
  target: { projectId: string; worktreeId: string; chatId: string },
  suggestion: unknown,
  turnUserMessageId: string,
): Promise<void> {
  if (typeof suggestion !== 'string') return;
  const text = suggestion.trim();
  if (!text || !(await readPromptSuggestionsEnabled())) return;
  const data: PromptSuggestionEventData = {
    type: PROMPT_SUGGESTION_EVENT_TYPE,
    text,
    turnUserMessageId,
  };
  interfacePort.publishPromptSuggestion(target, data);
}
