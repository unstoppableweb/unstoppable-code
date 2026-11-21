import type { UsageLimitedChatItem } from '../execution-types';
import {
  computeUsageLimitResumePrompt,
  type PersistedChatMessage,
} from '@canopy/agent-transcript';

// The resume rule lives in `@canopy/agent-transcript` so the browser-safe
// Remote Control adapter shares it; re-exported here for existing importers.
export {
  computeUsageLimitResumePrompt,
  isAgentActivityBlock,
  isLatestUserMessageHidden,
  messageHasAgentActivity,
  transcriptHasAgentActivity,
  USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
  type UsageLimitResumePrompt,
} from '@canopy/agent-transcript';

/** Missing, empty or promptless history cannot support a confident preview. */
export function describeUsageLimitResumePromptKind(
  messages: readonly PersistedChatMessage[] | undefined,
): UsageLimitedChatItem['resumePromptKind'] {
  if (
    !messages?.some(
      (message) =>
        message.role === 'user' &&
        (message.blocks.length === 0 ||
          !message.blocks.every((block) => block.type === 'tool_result')),
    )
  )
    return undefined;
  return computeUsageLimitResumePrompt(messages).resendsUserMessage
    ? 'resend_user_message'
    : 'continue';
}
