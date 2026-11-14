'use client';

import {
  useEffect,
  useId,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  CheckIcon,
  ChevronLeftMediumIcon,
  CloseLargeIcon,
} from '../../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { Button } from '../Button';
import { Markdown } from '../Markdown';
import { Notice, NoticeButton } from '../Notice';
import { OverlayScrollArea } from '../OverlayScrollArea';
import { TextInput } from '../Field';
import { ComposerIconButton } from './ComposerIconButton';
import {
  COMPOSER_PROMPT_HEADER_CLASS,
  COMPOSER_PROMPT_HEADER_WITH_GLYPH_CLASS,
  COMPOSER_PROMPT_ROW_GLYPH_CLASS,
  COMPOSER_PROMPT_ROWS_CLASS,
  isTypingOutside,
} from './ComposerPrompt';
import { ComposerPromptTextRow } from './ComposerPromptTextRow';
import { ComposerPromptRowButton } from './PlanApprovalPrompt';
import { QuestionOptionText } from './QuestionOptionText';
import type { QuestionPromptState } from './useQuestionPrompt';

const CHECK_SIZE = 12;

/** A chosen answer's number circle: the neutral fill with the checkmark. */
const ROW_GLYPH_CHECKED_CLASS =
  'flex size-8 shrink-0 items-center justify-center rounded-full bg-fg-primary [color:var(--bg-base)]';

// The question reads as the plan prompt's title, wrapping instead of
// truncating since a question can run several lines.
const QUESTION_PROSE_CLASS =
  'prose prose-sm leading-5 prose-p:leading-5 [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-p:my-0 prose-code:fg-accent prose-code:before:content-none prose-code:after:content-none prose-a:fg-accent prose-strong:fg-primary';

export interface QuestionPromptProps {
  readonly prompt: QuestionPromptState;
  /**
   * False renders only the text row, so a host that mounts the prompt
   * whether or not a question waits keeps its editor mounted.
   */
  readonly expanded?: boolean;
  /** The in-flight request, if any. */
  readonly busy: 'answer' | 'dismiss' | null;
  /** Which request last failed, so its notice can offer a retry. */
  readonly errorKind: 'submit' | 'dismiss' | null;
  readonly disconnected?: boolean;
  /**
   * The answers cannot change: a send that got no decision, which only its
   * retry may resend.
   */
  readonly locked?: boolean;
  /** Why this viewer cannot answer; shown in place of the answers' notice. */
  readonly readOnlyHint?: string;
  /** Closes the prompt and keeps the question waiting. */
  readonly onClose: () => void;
  /** Re-sends the failed answer or skip. */
  readonly onRetry: () => void;
  /**
   * Returns the composer's typed text and empties the composer. A picked
   * answer carries that text as its own answer, so nothing stays behind.
   */
  readonly takeText?: () => string;
  /** The text row: the composer's editor, microphone, and send. */
  readonly children: ReactNode;
}

/**
 * The composer while the agent waits on a question: it asks the question and
 * offers numbered answers above the text row, as the plan prompt does.
 *
 * - A single choice acts as soon as it is clicked (or its number pressed).
 * - Multiple choices toggle; the composer's send sends them.
 * - A text question has no answers: the composer's input is the answer.
 * - A number, a date, or a private value shows its field above the text row.
 * - A long list scrolls within the box.
 *
 * With several questions, one shows at a time: Back returns to the previous
 * one and the dots show where you are. Skip, in send's place until something
 * is answered, dismisses the request; x or Escape closes the prompt and keeps
 * the question waiting.
 */
export function QuestionPrompt({
  prompt,
  expanded = true,
  busy,
  errorKind,
  disconnected = false,
  locked: answersLocked = false,
  readOnlyHint,
  onClose,
  onRetry,
  takeText,
  children,
}: QuestionPromptProps): JSX.Element {
  const titleId = useId();
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const { question, kind, step, stepCount } = prompt;
  const locked =
    busy !== null ||
    disconnected ||
    answersLocked ||
    readOnlyHint !== undefined;
  const rows = kind === 'choice' || kind === 'multi' ? question.options : [];

  const focusRow = (index: number): void => {
    rowRefs.current[index]?.focus();
  };

  const choose = (option: string): void => {
    if (locked) return;
    if (kind === 'multi') prompt.toggle(option);
    // Typed text that cannot go with the pick stays in the composer.
    else
      prompt.pick(
        option,
        prompt.acceptsText && !question.keepTextOnPick
          ? takeText?.()
          : undefined,
      );
  };

  const handleRowKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const stepBy = event.key === 'ArrowDown' ? 1 : -1;
      focusRow((index + stepBy + rows.length) % rows.length);
      return;
    }
    const picked = Number.parseInt(event.key, 10);
    if (Number.isInteger(picked) && picked >= 1 && picked <= rows.length) {
      event.preventDefault();
      const option = rows[picked - 1];
      if (option !== undefined) choose(option);
    }
  };

  const notice = readOnlyHint
    ? {
        intent: 'neutral' as const,
        title: undefined,
        message: readOnlyHint,
        retry: false,
      }
    : disconnected
      ? {
          intent: 'neutral' as const,
          title: undefined,
          message: 'Reconnect to answer this question.',
          retry: false,
        }
      : errorKind === 'submit'
        ? {
            intent: 'destructive' as const,
            title: "Couldn't send your answer",
            message: 'Your answer is kept.',
            retry: true,
          }
        : errorKind === 'dismiss'
          ? {
              intent: 'destructive' as const,
              title: "Couldn't skip this question",
              message: "It's still waiting.",
              retry: true,
            }
          : prompt.validationError
            ? {
                intent: 'destructive' as const,
                title: undefined,
                message: prompt.validationError,
                retry: false,
              }
            : null;

  const optional = question.control !== undefined && !question.required;

  // A step with a field puts the cursor in it as it shows; other steps leave
  // the composer's input to the composer.
  useEffect(() => {
    if (!expanded || kind !== 'field') return;
    if (!isTypingOutside(rootRef.current)) fieldRef.current?.focus();
  }, [expanded, kind, step]);

  return (
    <div
      ref={rootRef}
      data-testid={expanded ? 'chat-question-prompt' : undefined}
      data-question-kind={expanded ? kind : undefined}
      className={
        expanded
          ? `${REPLAY_BLOCK_CLASS} flex flex-col gap-1 text-pretty`
          : 'contents'
      }
      onKeyDown={(event): void => {
        if (!expanded || event.key !== 'Escape' || event.defaultPrevented)
          return;
        event.preventDefault();
        onClose();
      }}
    >
      {expanded && (
        <>
          {/* The title's first line centres on x's 32px circle. */}
          <div
            className={`${
              step > 0
                ? COMPOSER_PROMPT_HEADER_WITH_GLYPH_CLASS
                : COMPOSER_PROMPT_HEADER_CLASS
            } items-start`}
          >
            {step > 0 && (
              <ComposerIconButton
                capsule
                tone="strong"
                aria-label="Previous question"
                onClick={prompt.back}
                disabled={locked}
                data-testid="chat-question-back"
              >
                <ChevronLeftMediumIcon size={16} />
              </ComposerIconButton>
            )}
            <div
              id={titleId}
              className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 py-1.5 text-s font-medium fg-primary"
            >
              {question.header && (
                <span className="fg-tertiary">{question.header}</span>
              )}
              <div className={`min-w-0 ${QUESTION_PROSE_CLASS}`}>
                <Markdown>{question.question}</Markdown>
              </div>
              {optional && (
                <span className="font-normal fg-tertiary">Optional</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {stepCount > 1 && (
                <ol
                  aria-label="Question progress"
                  className="flex items-center gap-2 px-1"
                >
                  {Array.from({ length: stepCount }, (_, index) => (
                    <li
                      key={index}
                      aria-label={`Question ${index + 1} of ${stepCount}`}
                      aria-current={index === step ? 'step' : undefined}
                      className={`size-1.25 rounded-full ${
                        index === step ? 'bg-fg-primary' : 'bg-fg-quaternary'
                      }`}
                    />
                  ))}
                </ol>
              )}
              <ComposerIconButton
                capsule
                tone="strong"
                aria-label="Close"
                onClick={onClose}
                data-testid="chat-question-close"
              >
                <CloseLargeIcon size={16} />
              </ComposerIconButton>
            </div>
          </div>

          {rows.length > 0 && (
            // A long list scrolls within the box rather than covering the chat.
            <OverlayScrollArea viewportClassName="max-h-[min(40vh,20rem)]">
              <div
                role="group"
                aria-labelledby={titleId}
                className={COMPOSER_PROMPT_ROWS_CLASS}
              >
                {rows.map((option, index) => {
                  const description = question.optionDescriptions?.[index];
                  const chosen =
                    kind === 'multi' && prompt.selected.includes(option);
                  return (
                    <ComposerPromptRowButton
                      key={option}
                      ref={(element): void => {
                        rowRefs.current[index] = element;
                      }}
                      disabled={locked}
                      {...(kind === 'multi' ? { 'aria-pressed': chosen } : {})}
                      data-testid={`chat-question-option-${index}`}
                      onClick={(): void => choose(option)}
                      onKeyDown={(event): void =>
                        handleRowKeyDown(event, index)
                      }
                    >
                      <span
                        aria-hidden
                        className={
                          chosen
                            ? ROW_GLYPH_CHECKED_CLASS
                            : COMPOSER_PROMPT_ROW_GLYPH_CLASS
                        }
                      >
                        {chosen ? <CheckIcon size={CHECK_SIZE} /> : index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <QuestionOptionText
                          label={option}
                          description={description}
                        />
                      </span>
                    </ComposerPromptRowButton>
                  );
                })}
              </div>
            </OverlayScrollArea>
          )}

          {kind === 'field' && (
            <div className="px-1 pb-1">
              <TextInput
                ref={fieldRef}
                aria-labelledby={titleId}
                type={
                  question.secret
                    ? 'password'
                    : question.control === 'number' ||
                        question.control === 'date'
                      ? question.control
                      : 'text'
                }
                step={question.control === 'number' ? 'any' : undefined}
                value={prompt.fieldValue}
                placeholder={question.placeholder ?? 'Reply…'}
                disabled={locked}
                required={question.required}
                onChange={(event): void =>
                  prompt.setFieldValue(event.target.value)
                }
                onKeyDown={(event): void => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  if (prompt.canSend('')) prompt.send('');
                }}
                data-testid="chat-question-field"
              />
            </div>
          )}

          {notice && (
            // Padded, not a margin, so the box owns its spacing (legacy-spacing).
            <div className="px-1">
              <Notice
                errorSource="chat-question-notice"
                intent={notice.intent}
                title={notice.title}
                data-testid="chat-question-notice"
                {...(notice.retry
                  ? {
                      actions: (
                        <NoticeButton
                          variant="primary"
                          onClick={onRetry}
                          disabled={busy !== null}
                          data-testid="chat-question-retry"
                        >
                          Try again
                        </NoticeButton>
                      ),
                    }
                  : {})}
              >
                {notice.message}
              </Notice>
            </div>
          )}
        </>
      )}

      {/* Typing your own answer reads as one more answer: a pen in the
          numbers' column. */}
      <ComposerPromptTextRow
        withPen={expanded && rows.length > 0 && prompt.acceptsText}
        plain={!expanded}
      >
        {children}
      </ComposerPromptTextRow>
    </div>
  );
}

export interface QuestionSkipButtonProps {
  readonly busy: 'answer' | 'dismiss' | null;
  readonly disabled?: boolean;
  readonly onSkip: () => void;
}

/**
 * Send's place in the question prompt's text row while nothing is answered:
 * dismisses the question. Typing, picking, or filling the field brings send
 * back.
 */
export function QuestionSkipButton({
  busy,
  disabled = false,
  onSkip,
}: QuestionSkipButtonProps): JSX.Element {
  // The shared 32px capsule, as queued-message Cancel is: the composer's
  // text size with the button's own side padding.
  return (
    <Button
      size="md"
      variant="secondary"
      onClick={onSkip}
      disabled={disabled || busy !== null}
      aria-busy={busy === 'dismiss'}
      data-testid="chat-question-skip"
    >
      {busy === 'dismiss' ? 'Skipping…' : 'Skip'}
    </Button>
  );
}
