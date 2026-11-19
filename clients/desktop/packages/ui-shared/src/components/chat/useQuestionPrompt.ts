import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  validateQuestionControlAnswers,
  type RemoteControlAskUserQuestion,
  type RemoteControlAskUserQuestionAnswer,
} from '@canopy/protocol/remote-control/shell';
import {
  clearQuestionPromptProgress,
  readQuestionPromptProgress,
  saveQuestionPromptProgress,
} from './question-prompt-progress';

/**
 * How the composer asks one question:
 * - `choice`: numbered answers that act on click (single choice). A long
 *   list scrolls within the box; there is no dropdown.
 * - `multi`: numbered answers that toggle, sent with the composer's send.
 * - `text`: no answers; the composer's own input is the answer.
 * - `field`: a field above the text row (number, date, or a private value),
 *   sent with the composer's send.
 */
export type QuestionStepKind = 'choice' | 'multi' | 'text' | 'field';

export function questionStepKind(
  question: RemoteControlAskUserQuestion,
): QuestionStepKind {
  const { control } = question;
  // A private value without answers asks in the masked field, whatever its
  // control (Codex sends one with none), so it never reaches the composer.
  if (question.secret && question.options.length === 0) return 'field';
  const choiceControl =
    control === undefined || control === 'buttons' || control === 'select';
  if (choiceControl && question.multiSelect === true) return 'multi';
  if (choiceControl) {
    // A classic question with no options asks only for its Other text.
    return control === undefined && question.options.length === 0
      ? 'text'
      : 'choice';
  }
  if ((control === 'text' || control === 'textarea') && !question.secret)
    return 'text';
  return 'field';
}

/**
 * Whether typing in the composer answers this question. Direct text questions
 * take it as the answer; every choice takes it as the person's own answer,
 * unless the provider cannot accept one (`allowOther: false`). Otherwise the
 * composer keeps sending chat messages, as it does while a plan waits.
 */
export function questionAcceptsText(
  question: RemoteControlAskUserQuestion,
): boolean {
  const kind = questionStepKind(question);
  if (kind === 'text') return true;
  // A private value's typed answer would show in the composer and its draft.
  if (kind === 'field' || question.secret) return false;
  return question.allowOther !== false;
}

function answerFor(
  question: RemoteControlAskUserQuestion,
  selected: readonly string[],
  text: string,
): RemoteControlAskUserQuestionAnswer {
  const freeform = text.trim();
  return {
    ...(question.id ? { questionId: question.id } : {}),
    question: question.question,
    selectedOptions: [...selected],
    ...(freeform ? { freeformText: freeform } : {}),
  };
}

/**
 * The composer's placeholder while a question shows: the answer for a text
 * question, an own answer beside choices, or a chat message when typing
 * cannot answer it.
 */
export function questionPromptPlaceholder(
  question: RemoteControlAskUserQuestion,
): string {
  if (!questionAcceptsText(question)) return 'Send a message instead';
  return questionStepKind(question) === 'text'
    ? (question.placeholder ?? 'Type your answer')
    : 'Or type your own answer';
}

const EMPTY_QUESTION: RemoteControlAskUserQuestion = {
  question: '',
  options: [],
};
const NO_SELECTION: readonly string[] = [];

export interface QuestionPromptState {
  readonly step: number;
  readonly stepCount: number;
  readonly question: RemoteControlAskUserQuestion;
  readonly kind: QuestionStepKind;
  /** Typing in the composer answers the current question. */
  readonly acceptsText: boolean;
  /** Options chosen on the current step. */
  readonly selected: readonly string[];
  /** The current step's field value (`field` kind). */
  readonly fieldValue: string;
  readonly validationError: string | null;
  /**
   * Pick a single-choice answer: it records and moves on at once, with any
   * typed own answer as its freeform.
   */
  readonly pick: (option: string, text?: string) => void;
  /** Toggle a multiple-choice answer. */
  readonly toggle: (option: string) => void;
  readonly setFieldValue: (value: string) => void;
  /**
   * Whether the composer's send should answer this step (with `text` as the
   * typed value) rather than send a chat message.
   */
  readonly sendAnswers: (text: string) => boolean;
  /** Whether that answer is complete enough to send. */
  readonly canSend: (text: string) => boolean;
  /**
   * Whether nothing is answered yet: no typed text, no pick, no field value.
   * The composer offers Skip in send's place until something is.
   */
  readonly skips: (text: string) => boolean;
  /** Answer the current step with the typed text, then move on or submit. */
  readonly send: (text: string) => void;
  readonly back: () => void;
  /** Forget this request's kept progress, for a skip. */
  readonly discard: () => void;
}

/**
 * Step-by-step state for a pending question request asked in the composer.
 * One question shows at a time; the last step submits every answer through
 * `onSubmit`. Progress is kept per request (see `question-prompt-progress`),
 * so a remount or a return to an earlier request picks up where it was left;
 * it is forgotten on submit or `discard`.
 */
export function useQuestionPrompt({
  requestId,
  questions,
  onSubmit,
}: {
  readonly requestId: string;
  readonly questions: readonly RemoteControlAskUserQuestion[];
  readonly onSubmit: (answers: RemoteControlAskUserQuestionAnswer[]) => void;
}): QuestionPromptState {
  const [step, setStep] = useState(
    () => readQuestionPromptProgress(requestId)?.step ?? 0,
  );
  const [selections, setSelections] = useState<ReadonlyMap<number, string[]>>(
    () => readQuestionPromptProgress(requestId)?.selections ?? new Map(),
  );
  const [texts, setTexts] = useState<ReadonlyMap<number, string>>(
    () => readQuestionPromptProgress(requestId)?.texts ?? new Map(),
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const previousRequest = useRef(requestId);
  useEffect(() => {
    if (previousRequest.current === requestId) return;
    previousRequest.current = requestId;
    const kept = readQuestionPromptProgress(requestId);
    setStep(kept?.step ?? 0);
    setSelections(kept?.selections ?? new Map());
    setTexts(kept?.texts ?? new Map());
    setValidationError(null);
  }, [requestId]);

  // Saved from each handler with the state it sets, never from an effect, so
  // a submit or a request change cannot write stale answers back.
  const keep = useCallback(
    (
      nextStep: number,
      nextSelections: ReadonlyMap<number, string[]>,
      nextTexts: ReadonlyMap<number, string>,
    ): void => {
      if (!requestId) return;
      saveQuestionPromptProgress(requestId, {
        step: nextStep,
        selections: new Map(nextSelections),
        texts: new Map(nextTexts),
      });
    },
    [requestId],
  );

  const stepCount = questions.length;
  const safeStep = Math.min(step, Math.max(0, stepCount - 1));
  const question = useMemo<RemoteControlAskUserQuestion>(
    () => questions[safeStep] ?? EMPTY_QUESTION,
    [questions, safeStep],
  );
  const kind = questionStepKind(question);
  const acceptsText = questionAcceptsText(question);
  const selected = useMemo<readonly string[]>(
    () => selections.get(safeStep) ?? NO_SELECTION,
    [selections, safeStep],
  );
  const fieldValue = texts.get(safeStep) ?? '';

  const stepAnswer = useCallback(
    (index: number, text: string): RemoteControlAskUserQuestionAnswer => {
      const entry = questions[index];
      if (!entry) return { question: '', selectedOptions: [] };
      return answerFor(entry, selections.get(index) ?? [], text);
    },
    [questions, selections],
  );

  const advance = useCallback(
    (
      nextSelections: ReadonlyMap<number, string[]>,
      nextTexts: ReadonlyMap<number, string>,
    ): void => {
      setSelections(nextSelections);
      setTexts(nextTexts);
      setValidationError(null);
      if (safeStep < stepCount - 1) {
        setStep(safeStep + 1);
        keep(safeStep + 1, nextSelections, nextTexts);
        return;
      }
      if (requestId) clearQuestionPromptProgress(requestId);
      onSubmit(
        questions.map((entry, index) =>
          answerFor(
            entry,
            nextSelections.get(index) ?? [],
            nextTexts.get(index) ?? '',
          ),
        ),
      );
    },
    [keep, onSubmit, questions, requestId, safeStep, stepCount],
  );

  const stepError = useCallback(
    (
      index: number,
      answer: RemoteControlAskUserQuestionAnswer,
    ): string | null => {
      const entry = questions[index];
      if (!entry) return null;
      return validateQuestionControlAnswers([entry], [answer]) ?? null;
    },
    [questions],
  );

  const pick = useCallback(
    (option: string, text = ''): void => {
      const nextSelections = new Map(selections).set(safeStep, [option]);
      const nextTexts = new Map(texts);
      if (text.trim()) nextTexts.set(safeStep, text);
      else nextTexts.delete(safeStep);
      advance(nextSelections, nextTexts);
    },
    [advance, safeStep, selections, texts],
  );

  const toggle = useCallback(
    (option: string): void => {
      const current = selections.get(safeStep) ?? [];
      const next = current.includes(option)
        ? current.filter((entry) => entry !== option)
        : [...current, option];
      const nextSelections = new Map(selections).set(safeStep, next);
      setSelections(nextSelections);
      setValidationError(null);
      keep(safeStep, nextSelections, texts);
    },
    [keep, safeStep, selections, texts],
  );

  const setFieldValue = useCallback(
    (value: string): void => {
      if (kind === 'field' && question.control === 'select') {
        const nextSelections = new Map(selections).set(
          safeStep,
          value ? [value] : [],
        );
        setSelections(nextSelections);
        keep(safeStep, nextSelections, texts);
      } else {
        const nextTexts = new Map(texts).set(safeStep, value);
        setTexts(nextTexts);
        keep(safeStep, selections, nextTexts);
      }
      setValidationError(null);
    },
    [keep, kind, question.control, safeStep, selections, texts],
  );

  /** The typed text a send would record for this step. */
  const typedValue = useCallback(
    (text: string): string => {
      if (kind === 'field' && question.control !== 'select') return fieldValue;
      // The composer clears after each answer, so a step reached with Back
      // keeps its earlier typed answer unless something new is typed.
      return text.trim().length === 0 ? fieldValue : text;
    },
    [fieldValue, kind, question.control],
  );

  const sendAnswers = useCallback(
    (text: string): boolean => {
      const typed = text.trim().length > 0;
      if (acceptsText) return kind !== 'choice' || typed;
      // A step that takes no typed text: send answers it while the composer
      // is empty; typed text goes out as a chat message instead.
      return kind !== 'choice' && !typed;
    },
    [acceptsText, kind],
  );

  const canSend = useCallback(
    (text: string): boolean => {
      if (!sendAnswers(text)) return false;
      const answer =
        kind === 'choice'
          ? answerFor(question, [], text)
          : stepAnswer(safeStep, typedValue(text));
      // The shared validator owns required, allowed options, and formats.
      return stepError(safeStep, answer) === null;
    },
    [kind, question, safeStep, sendAnswers, stepAnswer, stepError, typedValue],
  );

  const skips = useCallback(
    (text: string): boolean =>
      text.trim().length === 0 &&
      selected.length === 0 &&
      fieldValue.trim().length === 0,
    [fieldValue, selected],
  );

  const send = useCallback(
    (text: string): void => {
      const value = typedValue(text);
      const nextSelections =
        kind === 'choice'
          ? new Map(selections).set(safeStep, [])
          : new Map(selections);
      const answer = answerFor(
        question,
        nextSelections.get(safeStep) ?? [],
        value,
      );
      const error = stepError(safeStep, answer);
      if (error) {
        setValidationError(error);
        return;
      }
      advance(nextSelections, new Map(texts).set(safeStep, value));
    },
    [
      advance,
      kind,
      question,
      safeStep,
      selections,
      stepError,
      texts,
      typedValue,
    ],
  );

  const back = useCallback((): void => {
    const previousStep = Math.max(0, safeStep - 1);
    setValidationError(null);
    setStep(previousStep);
    keep(previousStep, selections, texts);
  }, [keep, safeStep, selections, texts]);

  const discard = useCallback((): void => {
    if (requestId) clearQuestionPromptProgress(requestId);
  }, [requestId]);

  return useMemo(
    () => ({
      step: safeStep,
      stepCount,
      question,
      kind,
      acceptsText,
      selected,
      fieldValue,
      validationError,
      pick,
      toggle,
      setFieldValue,
      sendAnswers,
      canSend,
      skips,
      send,
      back,
      discard,
    }),
    [
      safeStep,
      stepCount,
      question,
      kind,
      acceptsText,
      selected,
      fieldValue,
      validationError,
      pick,
      toggle,
      setFieldValue,
      sendAnswers,
      canSend,
      skips,
      send,
      back,
      discard,
    ],
  );
}
