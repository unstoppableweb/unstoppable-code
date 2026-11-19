import type {
  PersistedPendingQuestion,
  RemoteControlAskUserQuestionState,
} from '@canopy/desktop-shared/types';

/**
 * Project one chat's persisted AskUserQuestion entries for the Portal. Worktree
 * and Cowork chat summaries share it so web consumers see one shape.
 */
export function projectRemoteControlQuestionStates(
  chatId: string,
  pending: readonly PersistedPendingQuestion[],
): RemoteControlAskUserQuestionState[] {
  return pending
    .filter(
      (entry) => entry.chatId === chatId && entry.dismissedAt === undefined,
    )
    .map((entry) => ({
      requestId: entry.requestId,
      ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}),
      questions: entry.questions,
      answered: entry.answeredAt !== undefined,
      // Contract: awaiting entries never carry answers — only project them
      // once `answeredAt` is set, even if a partial record has both fields.
      ...(entry.answeredAt !== undefined && entry.answers
        ? { answers: entry.answers }
        : {}),
    }));
}
