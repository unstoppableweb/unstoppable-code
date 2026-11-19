import type { RemoteControlChatMessage } from '@canopy/protocol/remote-control/shell';
import { readChatPromptSource } from '@canopy/protocol/remote-control/shell';
import type { SentPromptSummary } from '@canopy/app-state';
import { hostMessagePresentation } from '@canopy/ui-shared/components';

// Parsing a prompt for host content is not free, and a transcript update
// rescans every prompt, so each text keeps its answer.
const hostPromptTexts = new Map<string, boolean>();
const HOST_PROMPT_TEXT_CACHE_LIMIT = 500;

/**
 * Whether `text` is a prompt the person wrote. A fired watcher or a
 * delegate's steering request reaches a chat as host text and arrives on its
 * own. Hosts do not project hidden messages into a shared transcript.
 */
export function isPersonPromptText(text: string): boolean {
  let isHost = hostPromptTexts.get(text);
  if (isHost === undefined) {
    isHost = hostMessagePresentation(text) !== undefined;
    if (hostPromptTexts.size >= HOST_PROMPT_TEXT_CACHE_LIMIT)
      hostPromptTexts.clear();
    hostPromptTexts.set(text, isHost);
  }
  return !isHost;
}

/** The transcript side of a {@link SentPromptSummary}. */
export function summarizeTranscriptPrompts(
  messages: readonly RemoteControlChatMessage[],
): Pick<SentPromptSummary, 'latest' | 'promptCount'> {
  let latest: SentPromptSummary['latest'] = null;
  let promptCount = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role !== 'user' ||
      readChatPromptSource(message) !== 'human' ||
      !isPersonPromptText(message.text)
    )
      continue;
    latest ??= { id: message.messageId, timestamp: message.createdAtMs };
    promptCount += 1;
  }
  return { latest, promptCount };
}
