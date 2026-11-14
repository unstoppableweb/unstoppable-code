// Store-free, props-in/callbacks-out presentation for a Canopy AskUserQuestion.
// Shared between the desktop renderer (via a thin store-connected wrapper) and
// the web portal (via the ChatPartView interaction context / message-renderer).
// This module is display-only: NO stores, IPC, fetching, Electron, or Next
// imports — hosts thread in the projected protocol state plus submit/dismiss
// callbacks.
import { Dot } from '../Badge';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  PortalAskUserQuestion,
  PortalAskUserQuestionAnswer,
  PortalAskUserQuestionState,
} from '@canopy/protocol/portal';
import { validateQuestionControlAnswers } from '@canopy/protocol/portal';
import { MessagesSquare, ChevronDownMediumIcon } from '../../icons/AppIcons';
import { Button } from '../Button';
import { ChoiceField, ChoiceMark } from '../Choice';
import { Kbd } from '../Kbd';
import { Select, TextArea, TextInput, FieldError } from '../Field';
import { Notice } from '../Notice';
import { QuestionOptionText } from './QuestionOptionText';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '../../lib/replay-privacy';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Question identity (matching lives in `ask-user-question-presentation.ts`)
// ---------------------------------------------------------------------------

/** Whether a tool-use id was minted by a Codex ask-user path (`codex-*`). */
export function isCodexAskUserToolUseId(
  toolUseId: string | undefined,
): boolean {
  return typeof toolUseId === 'string' && toolUseId.startsWith('codex-');
}

/**
 * Parse the ordered question text from a serialized AskUserQuestion tool input
 * (`{ questions: [{ question }] }`). Returns `undefined` when the input is not
 * parseable question JSON, so only an exact tool-use id can match it.
 */
export function parseAskUserQuestionTexts(
  input: string | undefined,
): string[] | undefined {
  if (!input) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.questions)) return undefined;
  const texts: string[] = [];
  for (const entry of parsed.questions) {
    if (!isRecord(entry) || typeof entry.question !== 'string')
      return undefined;
    texts.push(entry.question);
  }
  return texts.length > 0 ? texts : undefined;
}

// ---------------------------------------------------------------------------
// Answered read-only display
// ---------------------------------------------------------------------------

/**
 * Normalized answered-display row consumed by {@link AnsweredQuestionsBlock}.
 * `answer` is the already-joined selected options (', '); `additional` is the
 * optional freeform text. `secret` masks `additional` as `[hidden]` even if an
 * unredacted value reaches the component (defense-in-depth).
 */
export interface AnsweredQuestionDisplay {
  question: string;
  answer: string;
  additional?: string;
  secret?: boolean;
}

/** Map projected protocol answers into the normalized answered-display rows. */
export function answersToDisplay(
  answers: readonly PortalAskUserQuestionAnswer[],
  questions?: readonly PortalAskUserQuestion[],
): AnsweredQuestionDisplay[] {
  if (!Array.isArray(answers)) return [];
  return answers.flatMap((answer: unknown, i: number) => {
    // Restored/projected data may predate validation. Malformed answers still
    // settle the record, but must never fabricate text or crash the transcript.
    if (
      !isRecord(answer) ||
      typeof answer.question !== 'string' ||
      !Array.isArray(answer.selectedOptions) ||
      !answer.selectedOptions.every(
        (option: unknown) => typeof option === 'string',
      )
    )
      return [];
    return [
      {
        question: answer.question,
        answer: answer.selectedOptions.join(', '),
        ...(typeof answer.freeformText === 'string' && answer.freeformText
          ? { additional: answer.freeformText }
          : {}),
        ...(questions?.[i]?.secret ? { secret: true } : {}),
      },
    ];
  });
}

/** Grouped read-only answers; secret freeform is always shown as `[hidden]`. */
export const AnsweredQuestionsBlock = memo(function AnsweredQuestionsBlock({
  answers,
}: {
  answers: readonly AnsweredQuestionDisplay[];
}): JSX.Element {
  // Clean chat look: one 12px inset on every side, and answers 12px apart
  // across their hairline, the same as the inset.
  return (
    <div
      className={`flex flex-col gap-2 rounded-2xl border border-line-base bg-tertiary text-s text-pretty canopy-small-icon-stroke p-3`}
      data-testid="answered-questions"
    >
      <div className="flex items-center gap-2 fg-tertiary">
        <MessagesSquare width={14} height={14} aria-hidden="true" />
        <span>Answers</span>
      </div>
      <div className={`flex flex-col gap-3`}>
        {answers.map((answer, i) => {
          const additional =
            answer.secret && answer.additional ? '[hidden]' : answer.additional;
          return (
            <div
              key={i}
              className={`flex flex-col gap-1${
                i === 0 ? '' : ' border-t border-line-base pt-3'
              }`}
              data-testid="answered-question"
            >
              <div
                className={`${REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words fg-tertiary`}
              >
                {answer.question}
              </div>
              <div
                className={`${REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words fg-primary`}
              >
                {answer.answer ? (
                  <>
                    {answer.answer}
                    {additional && (
                      <span className="fg-primary">
                        {', '}
                        {additional}
                      </span>
                    )}
                  </>
                ) : additional ? (
                  additional
                ) : (
                  <span className="fg-tertiary">No selection</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Interactive question form
// ---------------------------------------------------------------------------

/**
 * Serializable in-progress answers for one question request, so a host can
 * keep them while the card is unmounted (for example across a panel switch).
 * Keys of `selections` and `otherTexts`, and entries of `otherSelected`, are
 * question indexes. May contain secret answers: hosts must keep drafts in
 * memory only.
 */
export interface AskUserQuestionDraft {
  readonly step: number;
  readonly selections: Readonly<Record<number, readonly string[]>>;
  readonly otherSelected: readonly number[];
  readonly otherTexts: Readonly<Record<number, string>>;
  readonly minimized?: boolean;
}

export interface AskUserQuestionCardProps {
  /** Projected protocol state for this question request. */
  state: PortalAskUserQuestionState;
  /** Optional host markdown renderer for question/header text. */
  renderMarkdown?: (markdown: string) => ReactNode;
  /** Hard-disable all controls (e.g. host not connected). */
  disabled?: boolean;
  /** Async questions preselect the first option but never submit automatically. */
  defaultFirstOption?: boolean;
  /** The in-flight action, if any. Drives button labels + `aria-busy`. */
  busy?: 'answer' | 'dismiss' | null;
  /** When true, render read-only with the reconnect helper. */
  disconnected?: boolean;
  /** Which action last failed, so the matching retry copy is shown. */
  errorKind?: 'submit' | 'dismiss' | null;
  /** Submit the structured answers (raw freeform; host redacts for display). */
  onSubmit: (answers: PortalAskUserQuestionAnswer[]) => void;
  /** Dismiss the question without answering. */
  onDismiss: () => void;
  /**
   * Render without the card's own surface, for a host that places the form
   * inside a surface it already draws (the desktop composer dock).
   */
  embedded?: boolean;
  /**
   * In-progress answers to restore for `state.requestId`. Read only on mount
   * and when the request changes; when present it replaces
   * `defaultFirstOption` seeding.
   */
  draft?: AskUserQuestionDraft;
  /**
   * Reported with the next form state each time the person changes a step,
   * selection, freeform text or the minimized state. Not reported for submit,
   * dismiss, or a request change.
   */
  onDraftChange?: (draft: AskUserQuestionDraft) => void;
}

/** Local form state behind the interactive card. */
interface QuestionForm {
  readonly step: number;
  readonly minimized: boolean;
  // Per-question selected real options (Other tracked separately, never as a
  // magic option string that could collide with a genuine option value).
  readonly selections: ReadonlyMap<number, ReadonlySet<string>>;
  readonly otherSelected: ReadonlySet<number>;
  readonly otherTexts: ReadonlyMap<number, string>;
}

function seededForm(
  questions: readonly PortalAskUserQuestion[],
  defaultFirstOption: boolean,
): QuestionForm {
  return {
    step: 0,
    minimized: false,
    selections: new Map(
      questions.flatMap((question, index) =>
        defaultFirstOption && question.options[0]
          ? [[index, new Set([question.options[0]])] as const]
          : [],
      ),
    ),
    otherSelected: new Set(
      questions.flatMap((question, index) =>
        defaultFirstOption && question.options.length === 0 ? [index] : [],
      ),
    ),
    otherTexts: new Map(),
  };
}

function formFromDraft(
  draft: AskUserQuestionDraft,
  questionCount: number,
): QuestionForm {
  return {
    step: Math.max(0, Math.min(draft.step, questionCount - 1)),
    minimized: draft.minimized === true,
    selections: new Map(
      Object.entries(draft.selections).map(
        ([index, options]) => [Number(index), new Set(options)] as const,
      ),
    ),
    otherSelected: new Set(draft.otherSelected),
    otherTexts: new Map(
      Object.entries(draft.otherTexts).map(
        ([index, text]) => [Number(index), text] as const,
      ),
    ),
  };
}

function draftFromForm(form: QuestionForm): AskUserQuestionDraft {
  return {
    step: form.step,
    selections: Object.fromEntries(
      Array.from(form.selections, ([index, options]) => [
        index,
        Array.from(options),
      ]),
    ),
    otherSelected: Array.from(form.otherSelected),
    otherTexts: Object.fromEntries(form.otherTexts),
    minimized: form.minimized,
  };
}

function initialForm(
  draft: AskUserQuestionDraft | undefined,
  questions: readonly PortalAskUserQuestion[],
  defaultFirstOption: boolean,
): QuestionForm {
  return draft
    ? formFromDraft(draft, questions.length)
    : seededForm(questions, defaultFirstOption);
}

const TOUCH_TARGET = 'pointer-coarse:min-h-11';
/** Short `select` lists read faster as visible rows than behind a dropdown. */
const SELECT_AS_ROWS_MAX_OPTIONS = 5;

type PresentedControl = PortalAskUserQuestion['control'];

/**
 * Whether a choice question offers "Other" for the person's own answer: every
 * choice does, unless the provider cannot accept one.
 */
function offersOwnAnswer(question: PortalAskUserQuestion): boolean {
  const choice =
    question.control === undefined ||
    question.control === 'buttons' ||
    question.control === 'select';
  return choice && question.allowOther !== false;
}

/**
 * The control the card actually draws for a question. A multi-select `select`
 * always renders as checkbox rows: the native list box cannot take our
 * styling and hides multiple selection behind modifier-clicks.
 */
function presentedControl(question: PortalAskUserQuestion): PresentedControl {
  return question.control === 'select' &&
    (question.multiSelect === true ||
      question.options.length <= SELECT_AS_ROWS_MAX_OPTIONS)
    ? 'buttons'
    : question.control;
}

// One 8px inset on every side: 8 + the 20px text line + 8 fills the 36px row,
// and the 44px coarse-pointer row takes 12px so its content stays centred.
const OPTION_ROW_CLASSES = `group/option flex min-h-9 w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 pointer-coarse:py-3 text-left text-s fg-primary outline-none hover:bg-subtle focus-visible:bg-subtle has-[:focus-visible]:bg-subtle disabled:cursor-not-allowed disabled:fg-disabled has-[:disabled]:cursor-not-allowed has-[:disabled]:fg-disabled ${TOUCH_TARGET}`;

/**
 * A row whose choice is a `ChoiceField`: the row keeps the hover and focus
 * fill, and the field's `row` layout makes its label the padded, touch-sized
 * row itself, so a click anywhere on the row (its padding and letter hint
 * included) toggles the choice.
 */
const OPTION_FIELD_ROW_CLASSES =
  'group/option flex w-full rounded-lg text-left hover:bg-subtle has-[:focus-visible]:bg-subtle';

/** Letter shortcut, shown while the row is hovered or focused. */
function ChoiceShortcut({ index }: { index: number }): JSX.Element | null {
  if (index >= 26) return null;
  return (
    // The cap is 18px on the row's 20px text line, so 1px down centres it.
    <span
      aria-hidden="true"
      data-testid="ask-user-question-choice-shortcut"
      className="ml-auto mt-px flex opacity-0 group-hover/option:opacity-100 group-focus-visible/option:opacity-100 option-focus-visible-inside:opacity-100"
    >
      <Kbd shortcut={[String.fromCharCode(65 + index)]} />
    </span>
  );
}

/** The `Select` value (an option's index) of a single-select answer. */
function selectedOptionValue(
  options: readonly string[],
  selected: ReadonlySet<string>,
): string | null {
  const [chosen] = selected;
  const index = chosen === undefined ? -1 : options.indexOf(chosen);
  return index === -1 ? null : String(index);
}

function isDirectField(question: PortalAskUserQuestion): boolean {
  return (
    question.control === 'text' ||
    question.control === 'textarea' ||
    question.control === 'number' ||
    question.control === 'date'
  );
}

function AskUserQuestionCardImpl({
  state,
  renderMarkdown,
  disabled,
  defaultFirstOption = false,
  busy,
  disconnected,
  errorKind,
  onSubmit,
  onDismiss,
  embedded = false,
  draft,
  onDraftChange,
}: AskUserQuestionCardProps): JSX.Element {
  // Behind refs so a host's per-render values neither re-seed the form nor
  // re-run effects.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const [form, setForm] = useState<QuestionForm>(() =>
    initialForm(draft, state.questions, defaultFirstOption),
  );
  // The latest form, so each handler computes and reports the exact next state
  // it sets, even before React re-renders.
  const formRef = useRef(form);
  const commitForm = useCallback(
    (change: (current: QuestionForm) => QuestionForm): void => {
      const next = change(formRef.current);
      if (next === formRef.current) return;
      formRef.current = next;
      setForm(next);
      onDraftChangeRef.current?.(draftFromForm(next));
    },
    [],
  );
  const { step, minimized, selections, otherSelected, otherTexts } = form;
  const setStep = useCallback(
    (change: (current: number) => number): void =>
      commitForm((current) => ({ ...current, step: change(current.step) })),
    [commitForm],
  );
  const setMinimized = useCallback(
    (next: boolean): void =>
      commitForm((current) =>
        current.minimized === next ? current : { ...current, minimized: next },
      ),
    [commitForm],
  );
  const minimizedButton = useRef<HTMLButtonElement>(null);
  // Seeded from the restored form so only a user toggle moves focus.
  const previouslyMinimized = useRef(minimized);
  const stepHeading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (previouslyMinimized.current === minimized) return;
    if (minimized) minimizedButton.current?.focus();
    else if (previouslyMinimized.current) stepHeading.current?.focus();
    previouslyMinimized.current = minimized;
  }, [minimized]);
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current !== step) stepHeading.current?.focus();
    previousStep.current = step;
  }, [step]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const validationErrorId = useId();

  // Reset local form state whenever the request changes so a recycled card
  // never carries a previous prompt's selection: restore the new request's
  // draft when the host has one. Not reported, so the previous form is never
  // reported under the new request.
  const prevRequestId = useRef(state.requestId);
  useEffect(() => {
    if (prevRequestId.current !== state.requestId) {
      prevRequestId.current = state.requestId;
      const next = initialForm(
        draftRef.current,
        state.questions,
        defaultFirstOption,
      );
      formRef.current = next;
      setForm(next);
      setValidationError(null);
    }
  }, [state.requestId, state.questions, defaultFirstOption]);

  const renderText = useCallback(
    (text: string): ReactNode => (renderMarkdown ? renderMarkdown(text) : text),
    [renderMarkdown],
  );

  const toggleOption = useCallback(
    (qIdx: number, option: string, multiSelect: boolean) => {
      commitForm((prev) => {
        const options = new Set(prev.selections.get(qIdx) ?? []);
        if (multiSelect) {
          if (options.has(option)) options.delete(option);
          else options.add(option);
        } else {
          options.clear();
          options.add(option);
        }
        const nextOther = new Set(prev.otherSelected);
        // Radio semantics: choosing a concrete option clears Other.
        if (!multiSelect) nextOther.delete(qIdx);
        return {
          ...prev,
          selections: new Map(prev.selections).set(qIdx, options),
          otherSelected: nextOther,
        };
      });
    },
    [commitForm],
  );

  const toggleOther = useCallback(
    (qIdx: number, multiSelect: boolean) => {
      commitForm((prev) => {
        const nextOther = new Set(prev.otherSelected);
        if (nextOther.has(qIdx)) nextOther.delete(qIdx);
        else nextOther.add(qIdx);
        // Radio semantics: choosing Other clears the concrete selections.
        const nextSelections =
          !multiSelect && prev.selections.has(qIdx)
            ? new Map(prev.selections).set(qIdx, new Set<string>())
            : prev.selections;
        return {
          ...prev,
          otherSelected: nextOther,
          selections: nextSelections,
        };
      });
    },
    [commitForm],
  );

  const setOtherText = useCallback(
    (qIdx: number, value: string) => {
      commitForm((prev) => ({
        ...prev,
        otherTexts: new Map(prev.otherTexts).set(qIdx, value),
      }));
    },
    [commitForm],
  );

  const answers = useMemo<PortalAskUserQuestionAnswer[]>(
    () =>
      state.questions.map((q, idx) => {
        const selectedOptions = Array.from(selections.get(idx) ?? []);
        const freeform =
          isDirectField(q) || otherSelected.has(idx)
            ? otherTexts.get(idx)?.trim()
            : undefined;
        return {
          ...(q.id ? { questionId: q.id } : {}),
          question: q.question,
          selectedOptions,
          ...(freeform ? { freeformText: freeform } : {}),
        };
      }),
    [state.questions, selections, otherSelected, otherTexts],
  );

  const handleSubmit = useCallback(() => {
    if (disabled || disconnected || busy != null) return;
    const isLastStep = step >= state.questions.length - 1;
    const error = validateQuestionControlAnswers(
      isLastStep ? state.questions : [state.questions[step]],
      isLastStep ? answers : [answers[step]],
    );
    if (error) {
      setValidationError(error);
      return;
    }
    setValidationError(null);
    if (!isLastStep) {
      setStep((current) => current + 1);
      return;
    }
    onSubmit(answers);
  }, [
    step,
    state.questions,
    answers,
    onSubmit,
    disabled,
    disconnected,
    busy,
    setStep,
  ]);

  const controlsDisabled =
    disabled === true || disconnected === true || busy != null;

  // Delivery state the user should know about while the form stays open.
  const deliveryNotice = disconnected
    ? {
        intent: 'neutral' as const,
        title: undefined,
        message: 'Reconnect to answer this question.',
      }
    : errorKind === 'submit'
      ? {
          intent: 'destructive' as const,
          title: "Couldn't send your answer",
          message: 'Try again.',
        }
      : errorKind === 'dismiss'
        ? {
            intent: 'destructive' as const,
            title: "Couldn't skip this question",
            message: 'Try again.',
          }
        : null;

  // Answered records render read-only, never the interactive form.
  if (state.answered) {
    return (
      <div data-testid="ask-user-question-card">
        <AnsweredQuestionsBlock
          answers={answersToDisplay(state.answers ?? [], state.questions)}
        />
      </div>
    );
  }

  const pendingLabel =
    state.questions.length === 1
      ? '1 question'
      : `${state.questions.length} questions`;

  if (minimized) {
    return (
      <div
        data-testid="ask-user-question-card"
        className={embedded ? 'p-2' : undefined}
      >
        <Button
          ref={minimizedButton}
          variant="secondary"
          size="sm"
          aria-expanded={false}
          aria-label={`Show ${pendingLabel}`}
          data-testid="ask-user-question-minimized"
          onClick={() => setMinimized(false)}
        >
          <Dot tone="attention" />
          <span className="tabular-nums">{pendingLabel}</span>
        </Button>
      </div>
    );
  }

  const q = state.questions[step];
  const control = q ? presentedControl(q) : undefined;
  const stepInvalid =
    q !== undefined &&
    answers[step] !== undefined &&
    validateQuestionControlAnswers([q], [answers[step]]) !== undefined;
  const selected: ReadonlySet<string> = selections.get(step) ?? new Set();
  const isMulti = q?.multiSelect === true;
  const groupName = `q-${state.requestId}-${step}`;
  const nativeField =
    q !== undefined && (isDirectField(q) || control === 'select');
  const QuestionLabel = nativeField ? 'label' : 'div';
  // Content-bearing names point at blocked text: replay records attributes.
  const headerId = `${groupName}-header`;
  const questionId = `${groupName}-question`;

  return (
    <form
      data-testid="ask-user-question-card"
      tabIndex={0}
      aria-label="Question controls"
      className={
        embedded
          ? 'flex w-full flex-col gap-3 p-3 text-pretty outline-none'
          : 'flex w-full flex-col gap-3 overflow-hidden rounded-2xl border border-line-base bg-tertiary p-3 text-pretty'
      }
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
      onKeyDown={(event) => {
        if (controlsDisabled || event.nativeEvent.isComposing || event.repeat)
          return;
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const editing =
          target.matches(
            'input:not([type="radio"]):not([type="checkbox"]), textarea, select',
          ) || target.isContentEditable;
        if (event.altKey && !event.metaKey && !event.ctrlKey) {
          if (event.key === 'ArrowLeft' && step > 0) {
            event.preventDefault();
            setValidationError(null);
            setStep((current) => current - 1);
          } else if (
            event.key === 'ArrowRight' &&
            step < state.questions.length - 1
          ) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
          const explicitAdvance = event.metaKey || event.ctrlKey;
          const actionButton = target.closest(
            'button:not([data-question-option])',
          );
          if (explicitAdvance || (!actionButton && !target.matches('select'))) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
          return;
        }
        if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
        const question = state.questions[step];
        const questionControl = question
          ? presentedControl(question)
          : undefined;
        if (!question || (questionControl && questionControl !== 'buttons'))
          return;
        const index = event.key.toLowerCase().charCodeAt(0) - 97;
        if (
          event.key.length === 1 &&
          index >= 0 &&
          index < Math.min(question.options.length, 26)
        ) {
          event.preventDefault();
          toggleOption(
            step,
            question.options[index],
            question.multiSelect === true,
          );
        } else if (
          event.key.length === 1 &&
          index === question.options.length &&
          index < 26 &&
          offersOwnAnswer(question)
        ) {
          event.preventDefault();
          toggleOther(step, question.multiSelect === true);
        }
      }}
    >
      {q && (
        <div
          role="group"
          aria-labelledby={q.header ? `${headerId} ${questionId}` : questionId}
          ref={stepHeading}
          tabIndex={-1}
          className="flex flex-col outline-none gap-2"
        >
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {q.header && (
                <div
                  id={headerId}
                  className={`${REPLAY_BLOCK_CLASS} text-xs fg-secondary`}
                >
                  {renderText(q.header)}
                </div>
              )}
              <QuestionLabel
                htmlFor={nativeField ? groupName : undefined}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-s fg-primary"
              >
                <span
                  id={questionId}
                  className={`${REPLAY_BLOCK_CLASS} min-w-0`}
                >
                  {renderText(q.question)}
                </span>
                {q.control && !q.required && (
                  <span className="fg-tertiary">Optional</span>
                )}
              </QuestionLabel>
            </div>
            <div className="-mr-1 -mt-1 flex shrink-0 items-center gap-3">
              {state.questions.length > 1 && (
                <ol
                  aria-label="Question progress"
                  className="flex items-center gap-1.5"
                >
                  {state.questions.map((_, index) => (
                    <li
                      key={index}
                      aria-label={`Question ${index + 1} of ${state.questions.length}`}
                      aria-current={index === step ? 'step' : undefined}
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${index === step ? 'bg-fg-primary' : 'bg-fg-quaternary'}`}
                    />
                  ))}
                </ol>
              )}
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Minimize questions"
                aria-expanded={true}
                onClick={() => setMinimized(true)}
                disabled={controlsDisabled}
                data-testid="ask-user-question-close"
              >
                <ChevronDownMediumIcon size={16} aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div className="-mx-2 flex flex-col gap-0.5">
            {isDirectField(q) ? (
              // The agent writes the placeholder; replay masks it and records the field.
              <div className={`${REPLAY_MASK_CLASS} px-2`}>
                {q.control === 'textarea' && !q.secret ? (
                  <TextArea
                    id={groupName}
                    aria-labelledby={questionId}
                    value={otherTexts.get(step) ?? ''}
                    onChange={(e) => setOtherText(step, e.target.value)}
                    disabled={controlsDisabled}
                    required={q.required}
                    placeholder={q.placeholder ?? 'Reply…'}
                  />
                ) : (
                  <TextInput
                    id={groupName}
                    aria-labelledby={questionId}
                    type={q.secret ? 'password' : q.control}
                    value={otherTexts.get(step) ?? ''}
                    onChange={(e) => setOtherText(step, e.target.value)}
                    disabled={controlsDisabled}
                    required={q.required}
                    placeholder={q.placeholder ?? 'Reply…'}
                    step={q.control === 'number' ? 'any' : undefined}
                  />
                )}
              </div>
            ) : control === 'select' ? (
              <div className="px-2">
                <Select
                  id={groupName}
                  aria-labelledby={questionId}
                  // Values are indexes: replay records them.
                  options={q.options.map((option, optionIndex) => ({
                    value: String(optionIndex),
                    label: option,
                  }))}
                  value={selectedOptionValue(q.options, selected)}
                  placeholder={q.placeholder ?? 'Choose an option'}
                  blockLabelsInReplay
                  disabled={controlsDisabled}
                  required={q.required}
                  onValueChange={(value) => {
                    const option = q.options[Number(value)];
                    if (option === undefined) return;
                    commitForm((prev) => ({
                      ...prev,
                      selections: new Map(prev.selections).set(
                        step,
                        new Set([option]),
                      ),
                    }));
                  }}
                />
              </div>
            ) : control === 'buttons' ? (
              q.options.map((option, optionIndex) => (
                <button
                  key={option}
                  type="button"
                  aria-labelledby={`${groupName}-option-${optionIndex}`}
                  data-question-option="true"
                  aria-keyshortcuts={
                    optionIndex < 26
                      ? String.fromCharCode(65 + optionIndex)
                      : undefined
                  }
                  aria-pressed={selected.has(option)}
                  disabled={controlsDisabled}
                  onClick={() => toggleOption(step, option, isMulti)}
                  className={OPTION_ROW_CLASSES}
                >
                  <ChoiceMark
                    kind={isMulti ? 'checkbox' : 'radio'}
                    checked={selected.has(option)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <QuestionOptionText
                      id={`${groupName}-option-${optionIndex}`}
                      label={option}
                    />
                  </span>
                  <ChoiceShortcut index={optionIndex} />
                </button>
              ))
            ) : (
              q.options.map((opt, optIdx) => {
                const description = q.optionDescriptions?.[optIdx];
                return (
                  <div key={opt} className={OPTION_FIELD_ROW_CLASSES}>
                    <ChoiceField
                      kind={isMulti ? 'checkbox' : 'radio'}
                      layout="row"
                      name={groupName}
                      aria-keyshortcuts={
                        optIdx < 26
                          ? String.fromCharCode(65 + optIdx)
                          : undefined
                      }
                      checked={selected.has(opt)}
                      disabled={controlsDisabled}
                      onChange={() => toggleOption(step, opt, isMulti)}
                      label={
                        <QuestionOptionText
                          label={opt}
                          description={description}
                          descriptionStyle="caption"
                        />
                      }
                      end={<ChoiceShortcut index={optIdx} />}
                    />
                  </div>
                );
              })
            )}

            {offersOwnAnswer(q) && (
              <>
                <div className={OPTION_FIELD_ROW_CLASSES}>
                  <ChoiceField
                    kind={isMulti ? 'checkbox' : 'radio'}
                    layout="row"
                    name={groupName}
                    checked={otherSelected.has(step)}
                    disabled={controlsDisabled}
                    onChange={() => toggleOther(step, isMulti)}
                    label="Other"
                    end={<ChoiceShortcut index={q.options.length} />}
                  />
                </div>
                {otherSelected.has(step) && (
                  <div className="px-2 pt-1">
                    {q.secret ? (
                      <TextInput
                        type="password"
                        value={otherTexts.get(step) ?? ''}
                        disabled={controlsDisabled}
                        onChange={(e) => setOtherText(step, e.target.value)}
                        placeholder="Type your answer…"
                      />
                    ) : (
                      <TextArea
                        value={otherTexts.get(step) ?? ''}
                        disabled={controlsDisabled}
                        onChange={(e) => setOtherText(step, e.target.value)}
                        placeholder="Type your answer…"
                      />
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {deliveryNotice && (
        <Notice
          errorSource="ask-user-question-helper"
          intent={deliveryNotice.intent}
          title={deliveryNotice.title}
          data-testid="ask-user-question-helper"
        >
          {deliveryNotice.message}
        </Notice>
      )}

      {validationError && (
        <div>
          <FieldError id={validationErrorId} announce>
            {/* The message can quote the question. */}
            <span className={REPLAY_BLOCK_CLASS}>{validationError}</span>
          </FieldError>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {step > 0 && (
          <Button
            variant="ghost"
            size="sm"
            disabled={controlsDisabled}
            className="-ml-2.5"
            onClick={() => {
              setValidationError(null);
              setStep((current) => current - 1);
            }}
          >
            Back
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            disabled={controlsDisabled}
            aria-busy={busy === 'dismiss'}
            data-testid="ask-user-question-dismiss"
            className="min-w-14"
          >
            {busy === 'dismiss' ? 'Skipping…' : 'Skip'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            disabled={controlsDisabled || stepInvalid}
            aria-busy={busy === 'answer'}
            data-testid="ask-user-question-submit"
            className="min-w-14"
          >
            {busy === 'answer'
              ? 'Sending…'
              : step < state.questions.length - 1
                ? 'Next'
                : 'Send'}
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * Memoized so a streaming transcript frame that appends a new part does not
 * re-render an unrelated, already-settled card.
 */
export const AskUserQuestionCard = memo(AskUserQuestionCardImpl);
