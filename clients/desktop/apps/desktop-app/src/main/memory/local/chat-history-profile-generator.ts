import {
  getStructuredHelperQueryErrorUsage,
  type StructuredHelperQueryResult,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  finalizeObservedHelperTask,
  startObservedHelperTask,
} from '../../lib/helper-observed-task';
import { localMemoryScopeDir } from './scope-resolver';
import {
  CHAT_HISTORY_PROFILE_RESULT_VALIDATION_SCHEMA,
  CHAT_HISTORY_PROFILE_SCHEMA,
  buildChatHistoryProfilePrompt,
  isChatHistoryProfileEnvelope,
  type ChatHistoryProfileGenerator,
} from './chat-history-profile';
import { runLocalMemoryStructuredHelper } from './structured-helper';
import { isHelperNoBillingSourceError } from '../../agents/helper-no-billing-source';

/**
 * Asks the user's local memory model what their chat titles support, as a
 * report-only structured helper recorded in the audit trail. The caller
 * validates the output and finalizes the observed task once the profile is
 * saved (or not).
 */
export const generateChatHistoryProfile: ChatHistoryProfileGenerator = async (
  prepared,
  helperModel,
) => {
  const { systemPrompt, userMessage } = buildChatHistoryProfilePrompt(prepared);
  const taskKey = `helper:local-memory-chat-profile:${Date.now()}`;
  startObservedHelperTask({
    taskKey,
    eventType: 'local_memory_chat_profile',
    label: 'Chat History Profile',
    model: helperModel.model,
    modelConfig: helperModel.modelConfig,
  });
  let result: StructuredHelperQueryResult<{ facts: unknown[] }>;
  try {
    result = await runLocalMemoryStructuredHelper({
      taskKey,
      kind: 'local-memory-chat-profile',
      label: 'Local Memory Chat Profile',
      scopeDir: localMemoryScopeDir({ scope: 'user' }),
      helperModel,
      systemPrompt,
      userMessage,
      schema: CHAT_HISTORY_PROFILE_SCHEMA,
      resultValidationSchema: CHAT_HISTORY_PROFILE_RESULT_VALIDATION_SCHEMA,
      isResult: isChatHistoryProfileEnvelope,
    });
  } catch (error) {
    finalizeObservedHelperTask(
      taskKey,
      // Refused before any spawn (CAN-7062); the refresh maps it to a skip.
      isHelperNoBillingSourceError(error) ? 'cancelled' : 'failure',
      error instanceof Error ? error.message : String(error),
      getStructuredHelperQueryErrorUsage(error),
    );
    throw error;
  }
  const usage = result.usage;
  let finalized = false;
  return {
    output: result.value,
    finalize: (status, error): void => {
      if (finalized) return;
      finalized = true;
      finalizeObservedHelperTask(taskKey, status, error, usage);
    },
  };
};
