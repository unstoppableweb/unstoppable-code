import { useCallback, useRef, useState } from 'react';
import type {
  RemoteControlAskUserQuestion,
  RemoteControlAskUserQuestionAnswer,
} from '@canopy/protocol/remote-control/shell';
import { useChatSurfaceScope } from '@/stores/chat/surface-store';
import { useChatStore } from '@/stores/chatStore';
import {
  useQuestionPrompt,
  type QuestionPromptState,
} from '@canopy/ui-shared/components/chat/useQuestionPrompt';

/** A waiting request the composer asks: one or more questions. */
export interface ComposerPendingQuestion {
  readonly requestId: string;
  readonly questions: readonly RemoteControlAskUserQuestion[];
}

/**
 * Where a question's answer or skip goes. Chats answer through the chat
 * store's awaited actions; App Advisor answers through its own store.
 */
export interface ComposerQuestionDelivery {
  readonly answer: (
    requestId: string,
    answers: RemoteControlAskUserQuestionAnswer[],
  ) => Promise<unknown>;
  readonly dismiss: (requestId: string) => Promise<unknown>;
}

export interface ComposerQuestionPrompt {
  readonly prompt: QuestionPromptState;
  readonly busy: 'answer' | 'dismiss' | null;
  readonly errorKind: 'submit' | 'dismiss' | null;
  readonly disconnected: boolean;
  readonly skip: () => void;
  /** Re-sends the last answers or skip after a delivery failure. */
  readonly retry: () => void;
}

const NO_QUESTIONS: readonly RemoteControlAskUserQuestion[] = [];

/**
 * Connects a pending question to the composer's question prompt: the
 * step-by-step answer state plus its delivery (the chat store's awaited
 * answer and dismiss actions unless `delivery` says otherwise). A request
 * stays mounted (through `onDeliveryChange`) until its delivery settles, so
 * a failure keeps the prompt open with a retry.
 */
export function useComposerQuestionPrompt(
  pending: ComposerPendingQuestion | undefined,
  onDeliveryChange: (requestId: string, retained: boolean) => void,
  delivery?: ComposerQuestionDelivery,
): ComposerQuestionPrompt {
  const answerChatQuestion = useChatStore((s) => s.answerMcpQuestionAndWait);
  const dismissChatQuestion = useChatStore((s) => s.dismissMcpQuestionAndWait);
  const answerQuestion = delivery?.answer ?? answerChatQuestion;
  const dismissQuestion = delivery?.dismiss ?? dismissChatQuestion;
  const disconnected = useChatSurfaceScope()?.disconnected === true;
  const [busy, setBusy] = useState<'answer' | 'dismiss' | null>(null);
  const [errorKind, setErrorKind] = useState<'submit' | 'dismiss' | null>(null);
  const lastAnswers = useRef<RemoteControlAskUserQuestionAnswer[] | null>(null);
  const requestId = pending?.requestId ?? '';

  const submit = useCallback(
    (answers: RemoteControlAskUserQuestionAnswer[]): void => {
      if (!requestId) return;
      lastAnswers.current = answers;
      setBusy('answer');
      setErrorKind(null);
      onDeliveryChange(requestId, true);
      void answerQuestion(requestId, answers)
        .then(() => onDeliveryChange(requestId, false))
        .catch(() => setErrorKind('submit'))
        .finally(() => setBusy(null));
    },
    [answerQuestion, onDeliveryChange, requestId],
  );

  const prompt = useQuestionPrompt({
    requestId,
    questions: pending?.questions ?? NO_QUESTIONS,
    onSubmit: submit,
  });
  const { discard } = prompt;

  const skip = useCallback((): void => {
    if (!requestId) return;
    discard();
    setBusy('dismiss');
    setErrorKind(null);
    onDeliveryChange(requestId, true);
    void dismissQuestion(requestId)
      .then(() => onDeliveryChange(requestId, false))
      .catch(() => setErrorKind('dismiss'))
      .finally(() => setBusy(null));
  }, [discard, dismissQuestion, onDeliveryChange, requestId]);

  const retry = useCallback((): void => {
    if (errorKind === 'dismiss') skip();
    else if (lastAnswers.current) {
      // The form reopens after a failure, so edits since then saved again.
      discard();
      submit(lastAnswers.current);
    }
  }, [discard, errorKind, skip, submit]);

  return { prompt, busy, errorKind, disconnected, skip, retry };
}
