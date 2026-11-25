import { useCallback, useEffect, useRef, useState } from 'react';
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

/** The request the composer asks and where its answer or skip goes. */
export interface ComposerActiveQuestion {
  readonly pending: ComposerPendingQuestion | undefined;
  /** Undefined means the chat store's awaited answer and dismiss actions. */
  readonly delivery: ComposerQuestionDelivery | undefined;
}

/**
 * Picks the composer's question, App Advisor's own first, with the delivery
 * of the store it came from. An App Advisor chat also asks through the
 * chat's MCP questions (the injected AskUserQuestion tool), which only the
 * chat store can answer or skip, so delivery follows the question's source,
 * never the kind of composer.
 */
export function selectComposerQuestion(
  appAdvisor: ComposerPendingQuestion | undefined,
  appAdvisorDelivery: ComposerQuestionDelivery,
  chat: ComposerPendingQuestion | undefined,
): ComposerActiveQuestion {
  return appAdvisor
    ? { pending: appAdvisor, delivery: appAdvisorDelivery }
    : { pending: chat, delivery: undefined };
}

/** An answer or skip that failed: its request and the exact send to retry. */
interface FailedDelivery {
  readonly requestId: string;
  readonly kind: 'submit' | 'dismiss';
  readonly send: () => Promise<unknown>;
}

/**
 * Connects a pending question to the composer's question prompt: the
 * step-by-step answer state plus its delivery (the chat store's awaited
 * answer and dismiss actions unless `delivery` says otherwise). A request
 * stays mounted (through `onDeliveryChange`) until its delivery settles, so
 * a failure keeps the prompt open with a retry. `liveRequestIds` lists every
 * request the composer can still ask; a failure is forgotten, with the
 * answer it holds, once its request is no longer among them.
 */
export function useComposerQuestionPrompt(
  pending: ComposerPendingQuestion | undefined,
  onDeliveryChange: (requestId: string, retained: boolean) => void,
  delivery: ComposerQuestionDelivery | undefined,
  liveRequestIds: ReadonlySet<string>,
): ComposerQuestionPrompt {
  const answerChatQuestion = useChatStore((s) => s.answerMcpQuestionAndWait);
  const dismissChatQuestion = useChatStore((s) => s.dismissMcpQuestionAndWait);
  const answerQuestion = delivery?.answer ?? answerChatQuestion;
  const dismissQuestion = delivery?.dismiss ?? dismissChatQuestion;
  const disconnected = useChatSurfaceScope()?.disconnected === true;
  const [busy, setBusy] = useState<'answer' | 'dismiss' | null>(null);
  const [failures, setFailures] = useState<ReadonlyMap<string, FailedDelivery>>(
    () => new Map(),
  );
  const requestId = pending?.requestId ?? '';
  // Failures are kept per request: another request taking the composer (an
  // App Advisor question asks first) shows no error and cannot retry one,
  // since that would settle it with the other request's answer, and its own
  // sends leave the failed request's retry in place for when it returns.
  const activeFailure = failures.get(requestId) ?? null;
  const errorKind = activeFailure?.kind ?? null;

  // A request that expired, was cancelled or settled elsewhere takes its
  // failure with it, and a failure that lands after it ended is not kept.
  const live = useRef(liveRequestIds);
  useEffect(() => {
    live.current = liveRequestIds;
    setFailures((previous) => {
      const kept = [...previous].filter(([id]) => liveRequestIds.has(id));
      return kept.length === previous.size ? previous : new Map(kept);
    });
  }, [liveRequestIds]);

  const deliver = useCallback(
    (attempt: FailedDelivery): void => {
      const record = (failed: boolean): void =>
        setFailures((previous) => {
          const keep = failed && live.current.has(attempt.requestId);
          if (!keep && !previous.has(attempt.requestId)) return previous;
          const next = new Map(previous);
          if (keep) next.set(attempt.requestId, attempt);
          else next.delete(attempt.requestId);
          return next;
        });
      setBusy(attempt.kind === 'submit' ? 'answer' : 'dismiss');
      record(false);
      onDeliveryChange(attempt.requestId, true);
      void attempt
        .send()
        .then(() => onDeliveryChange(attempt.requestId, false))
        .catch(() => record(true))
        .finally(() => setBusy(null));
    },
    [onDeliveryChange],
  );

  const submit = useCallback(
    (answers: RemoteControlAskUserQuestionAnswer[]): void => {
      if (!requestId) return;
      deliver({
        requestId,
        kind: 'submit',
        send: () => answerQuestion(requestId, answers),
      });
    },
    [answerQuestion, deliver, requestId],
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
    deliver({
      requestId,
      kind: 'dismiss',
      send: () => dismissQuestion(requestId),
    });
  }, [deliver, discard, dismissQuestion, requestId]);

  const retry = useCallback((): void => {
    if (!activeFailure) return;
    // The form reopens after a failure, so edits since then saved again.
    discard();
    // The same request through the same delivery it failed on.
    deliver(activeFailure);
  }, [activeFailure, deliver, discard]);

  return { prompt, busy, errorKind, disconnected, skip, retry };
}
