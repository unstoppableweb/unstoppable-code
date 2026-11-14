import {
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type {
  LedgerFeedAnswerActions,
  LedgerLiveQuestion,
  LedgerLiveQuestionAnswer,
} from '@canopy/app-core';
import type {
  LedgerFeedWorkCloseIntent,
  LedgerNeedsYouItem,
} from '@canopy/app-state/ledger-feed';
import {
  Button,
  TRANSCRIPT_PROSE_CLASS,
  ChatComposerShell,
  ChoiceList,
  ChoiceListRow,
  ComposerSendButton,
  EmptyState,
  ErrorBanner,
  FormField,
  LEDGER_ENTRY_MARKDOWN_OPTIONS,
  Markdown,
  StatusGlyph,
  TextArea,
  TextInput,
  WorkPath,
  type LedgerDensity,
} from '@canopy/ui-shared/components';
import {
  PLAN_APPROVAL_BOX_CLASS,
  PLAN_APPROVAL_EDITOR_CONTAINER_CLASS,
  PlanApprovalPrompt,
  type PlanApprovalOption,
} from '@canopy/ui-shared/components/chat/PlanApprovalPrompt';
import { formatLedgerRelativeTime } from '@canopy/ui-shared/lib';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import type { LedgerChatTarget, LedgerLiveWait } from '@canopy/app-core';
import type { LedgerActorLabel } from '@canopy/protocol/canopy-core';
import type { LedgerViewScope } from '@canopy/protocol/ledger-view';
import { validateQuestionControlAnswers } from '@canopy/protocol/portal';
import {
  ledgerScopeWorkPath,
  type LedgerScopeNamesFor,
} from './ledger-work-path';
import { FeedSectionHeading } from './ledger-feed-sections';
import {
  LedgerCloseIntentPrompt,
  type LedgerCloseIntentChoice,
} from './ledger-close-intent';
import { Surface } from '@canopy/ui-shared/components';

type ActionResult =
  /** `needsChoice`: nothing was written yet; the close waits on `closeIntent`. */
  | { readonly ok: true; readonly needsChoice?: true }
  | { readonly ok: false; readonly message: string };

export interface LedgerFeedNeedsYouProps {
  readonly items: readonly LedgerNeedsYouItem[];
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  /** `panel` in a Feed panel, `page` on the Feed page (the default). */
  readonly layout?: LedgerDensity;
  /** Draw nothing while nothing needs the person, as the Feed panel does. */
  readonly hideWhenEmpty?: boolean;
  readonly scopeNames: LedgerScopeNamesFor;
  readonly onOpenScope?: (scope: LedgerViewScope) => void;
  /** The scope already shown by a panel, which makes its work path start below it. */
  readonly pathRoot?: LedgerViewScope;
  readonly answers: LedgerFeedAnswerActions | null;
  readonly onMarkCompleted: (item: LedgerNeedsYouItem) => Promise<ActionResult>;
  readonly onOpenReview: (item: LedgerNeedsYouItem) => void;
  readonly reviewsStatus: 'idle' | 'loading' | 'ready' | 'problem';
  /** A pending close of a review that still has open tasks (L05). */
  readonly closeIntent?: LedgerFeedWorkCloseIntent | null;
  readonly onResolveCloseIntent?: (
    choice: LedgerCloseIntentChoice,
  ) => Promise<ActionResult> | void;
  readonly onRetryReviews: () => void;
  readonly now: number;
}

interface LedgerFeedNeedsYouRowProps extends Omit<
  LedgerFeedNeedsYouProps,
  'actors' | 'items' | 'reviewsStatus' | 'onRetryReviews'
> {
  readonly item: LedgerNeedsYouItem;
}

function waitChatTarget(wait: LedgerLiveWait): LedgerChatTarget | null {
  return wait.chatId === null
    ? null
    : {
        projectId: wait.projectId,
        worktreeId: wait.worktreeId,
        chatId: wait.chatId,
      };
}

function hasTypedAnswerField(question: LedgerLiveQuestion): boolean {
  return (
    question.control === 'text' ||
    question.control === 'textarea' ||
    question.control === 'number' ||
    question.control === 'date' ||
    question.allowOther ||
    // A secret with nothing to choose is answered only by typing it.
    (question.secret && question.options.length === 0)
  );
}

/**
 * A plan to read in place, rendered as the chat renders it, at the row's full
 * width; images stay text and links stay safe, as in any Feed entry. A long
 * plan shows its start; Show more opens a taller view that scrolls, so the
 * row never grows without bound.
 */
function PlanPreview({ text }: { readonly text: string }): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = bodyRef.current;
    // Measured while collapsed, so a short plan offers no Show more.
    if (node === null || expanded) return;
    setOverflows(node.scrollHeight > node.clientHeight + 1);
  }, [expanded, text]);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Surface variant="group" size="small" className="w-full overflow-hidden">
        <div
          ref={bodyRef}
          data-testid="feed-needs-you-plan-text"
          data-expanded={expanded ? 'true' : undefined}
          className={`px-3 py-2 ${expanded ? 'max-h-96 overflow-y-auto' : 'max-h-48 overflow-hidden'} ${REPLAY_BLOCK_CLASS}`}
        >
          <div className={TRANSCRIPT_PROSE_CLASS}>
            <Markdown options={LEDGER_ENTRY_MARKDOWN_OPTIONS}>{text}</Markdown>
          </div>
        </div>
      </Surface>
      {overflows || expanded ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="feed-needs-you-plan-more"
          aria-expanded={expanded}
          onClick={(): void => setExpanded((current) => !current)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </div>
  );
}

function ActionError({
  message,
}: {
  readonly message: string | null;
}): JSX.Element | null {
  return message === null ? null : (
    <ErrorBanner
      errorSource="feed-needs-you-error"
      className=""
      error={message}
      testId="feed-needs-you-error"
      blockMessageFromReplay
    />
  );
}

function NeedsYouRow({
  item,
  scopeNames,
  onOpenScope,
  pathRoot,
  answers,
  onMarkCompleted,
  onOpenReview,
  closeIntent,
  onResolveCloseIntent,
  now,
}: LedgerFeedNeedsYouRowProps): JSX.Element {
  // A plan is answered in place (L17), once opened from its title: its text,
  // approval and reply show without Open chat, which leaves the Feed.
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const [freeformText, setFreeformText] = useState<
    Readonly<Record<string, string>>
  >({});
  const [planReply, setPlanReply] = useState('');
  const wait = item.wait;
  const titleClass =
    item.kind === 'question' || item.kind === 'plan' || item.kind === 'approval'
      ? REPLAY_BLOCK_CLASS
      : REPLAY_MASK_CLASS;
  const workPath = ledgerScopeWorkPath(item.scope, scopeNames(item.scope), {
    fallback: 'Work',
    ...(onOpenScope === undefined ? {} : { onOpenScope }),
    ...(pathRoot === undefined ? {} : { root: pathRoot }),
  });

  const runAction = async (
    action: () => Promise<ActionResult>,
    success?: string,
    failure?: string,
  ): Promise<void> => {
    setPending(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await action();
      if (result.ok) {
        setOutcome(result.needsChoice === true ? null : (success ?? null));
      } else {
        setError(failure ?? result.message);
      }
    } catch {
      setError("Couldn't complete this action. Try again.");
    } finally {
      setPending(false);
    }
  };

  const chooseOption = (
    questionKey: string,
    option: string,
    multiSelect: boolean,
  ): void => {
    setSelectedOptions((current) => {
      const selected = current[questionKey] ?? [];
      const next = selected.includes(option)
        ? selected.filter((value) => value !== option)
        : multiSelect
          ? [...selected, option]
          : [option];
      return { ...current, [questionKey]: next };
    });
  };

  const submitQuestion = (): Promise<void> => {
    if (wait === undefined || answers === null) return Promise.resolve();
    const questions = wait.questions ?? [];
    const questionAnswers: LedgerLiveQuestionAnswer[] = questions.map(
      (question, index) => {
        const questionKey = question.id ?? String(index);
        const freeform = freeformText[questionKey];
        return {
          ...(question.id === undefined ? {} : { questionId: question.id }),
          question: question.question,
          selectedOptions: selectedOptions[questionKey] ?? [],
          ...(hasTypedAnswerField(question) &&
          freeform !== undefined &&
          freeform.length > 0
            ? { freeformText: freeform }
            : {}),
        };
      },
    );
    const validationMessage = validateQuestionControlAnswers(
      questions.map((question) => ({
        ...(question.id === undefined ? {} : { id: question.id }),
        question: question.question,
        options: [...question.options],
        multiSelect: question.multiSelect,
        allowOther: question.allowOther,
        ...(question.control === undefined
          ? {}
          : { control: question.control }),
        ...(question.required === undefined
          ? {}
          : { required: question.required }),
      })),
      questionAnswers.map((answer) => ({
        ...answer,
        selectedOptions: [...answer.selectedOptions],
      })),
    );
    if (validationMessage !== undefined) {
      setError(validationMessage);
      return Promise.resolve();
    }
    return runAction(
      () => answers.answerQuestion(wait, questionAnswers),
      'Answer sent.',
    );
  };

  const title = (
    <span
      className={`min-w-0 truncate text-s font-medium fg-primary ${titleClass}`}
    >
      {item.title}
    </span>
  );
  const renderOpenWaitButton = (
    label: string,
    testId: string,
    openWait: LedgerLiveWait,
    showDetails: boolean,
  ): JSX.Element | null => {
    if (answers === null) return null;
    return (
      <Button
        type="button"
        size="sm"
        variant="secondary"
        data-testid={testId}
        disabled={pending}
        onClick={(): void => {
          if (showDetails) setExpanded(true);
          void runAction(() => answers.openWait(openWait));
        }}
      >
        {label}
      </Button>
    );
  };

  const renderQuestionDetails = (): JSX.Element | null => {
    if (wait === undefined) return null;
    const questions = wait.questions ?? [];
    const chatTarget = waitChatTarget(wait);
    return (
      <div className="flex flex-col gap-3" data-testid="feed-needs-you-details">
        {questions.map((question, questionIndex) => {
          const questionKey = question.id ?? String(questionIndex);
          const hasControlField =
            question.control === 'text' ||
            question.control === 'textarea' ||
            question.control === 'number' ||
            question.control === 'date';
          const showTypedField = hasTypedAnswerField(question);
          const answerLabel =
            hasControlField || question.options.length === 0
              ? 'Answer'
              : 'Other answer';
          const answerType = question.secret
            ? 'password'
            : question.control === 'number' || question.control === 'date'
              ? question.control
              : 'text';
          return (
            <div key={questionKey} className="flex min-w-0 flex-col gap-2">
              <p
                className={`text-xs font-medium fg-primary ${REPLAY_BLOCK_CLASS}`}
              >
                {question.header === undefined ? null : (
                  <span className="block">{question.header}</span>
                )}
                {question.question}
              </p>
              {hasControlField || question.options.length === 0 ? null : (
                <ChoiceList
                  aria-label={question.question}
                  kind={question.multiSelect ? 'checkbox' : 'radio'}
                >
                  {question.options.map((option, optionIndex) => {
                    const description =
                      question.optionDescriptions?.[optionIndex];
                    return (
                      <ChoiceListRow
                        key={`${questionKey}:${optionIndex}`}
                        kind={question.multiSelect ? 'checkbox' : 'radio'}
                        selected={(selectedOptions[questionKey] ?? []).includes(
                          option,
                        )}
                        disabled={pending || outcome !== null}
                        onClick={(): void =>
                          chooseOption(
                            questionKey,
                            option,
                            question.multiSelect,
                          )
                        }
                      >
                        <span className={`block ${REPLAY_BLOCK_CLASS}`}>
                          {option}
                        </span>
                        {description === undefined ? null : (
                          <span
                            className={`block text-xs fg-tertiary ${REPLAY_BLOCK_CLASS}`}
                          >
                            {description}
                          </span>
                        )}
                      </ChoiceListRow>
                    );
                  })}
                </ChoiceList>
              )}
              {showTypedField ? (
                <FormField label={answerLabel}>
                  {(control) =>
                    question.control === 'textarea' ? (
                      <TextArea
                        {...control}
                        data-testid="feed-needs-you-question-answer"
                        value={freeformText[questionKey] ?? ''}
                        disabled={pending || outcome !== null}
                        required={question.required}
                        placeholder={question.placeholder}
                        onChange={(event): void => {
                          const value = event.currentTarget.value;
                          setFreeformText((current) => ({
                            ...current,
                            [questionKey]: value,
                          }));
                        }}
                      />
                    ) : (
                      <TextInput
                        {...control}
                        data-testid="feed-needs-you-question-answer"
                        type={answerType}
                        value={freeformText[questionKey] ?? ''}
                        disabled={pending || outcome !== null}
                        required={question.required}
                        placeholder={question.placeholder}
                        onChange={(event): void => {
                          const value = event.currentTarget.value;
                          setFreeformText((current) => ({
                            ...current,
                            [questionKey]: value,
                          }));
                        }}
                      />
                    )
                  }
                </FormField>
              ) : null}
            </div>
          );
        })}
        {questions.length === 0 ? (
          <p className={`text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}>
            {wait.title}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {outcome === null ? (
            <Button
              type="button"
              data-testid="feed-needs-you-send"
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={(): void => void submitQuestion()}
            >
              Send
            </Button>
          ) : (
            <span role="status" className="text-xs fg-secondary">
              {outcome}
            </span>
          )}
          {answers !== null && chatTarget !== null ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="feed-needs-you-open"
              disabled={pending}
              onClick={(): void =>
                void runAction(() => answers.openChat(chatTarget))
              }
            >
              Open chat
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  const sendPlanReply = (): void => {
    if (wait === undefined || answers === null) return;
    const reply = planReply.trim();
    if (reply.length === 0 || pending) return;
    void runAction(() => answers.rejectPlan(wait, reply), 'Reply sent.');
  };

  const onPlanReplyKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    sendPlanReply();
  };

  // The plan's answers are its chat's: the same prompt, options and text row.
  const renderPlanDetails = (): JSX.Element | null => {
    if (wait === undefined || answers === null) return null;
    const offered = answers.planAnswers?.(wait) ?? {
      implement: true,
      workflow: false,
    };
    const canRunAsWorkflow =
      offered.workflow && answers.runPlanAsWorkflow !== undefined;
    const options: PlanApprovalOption[] = [
      {
        label: offered.implement
          ? 'Yes, implement this plan'
          : 'Implementation unavailable',
        onSelect: (): void =>
          void runAction(() => answers.approvePlan(wait), 'Plan approved.'),
        disabled: pending || !offered.implement,
        testId: 'feed-needs-you-approve-plan',
      },
      ...(canRunAsWorkflow
        ? [
            {
              label: 'Run it as a workflow',
              onSelect: (): void =>
                void runAction(
                  () =>
                    answers.runPlanAsWorkflow?.(wait) ??
                    Promise.resolve({
                      ok: false,
                      message: "That plan can't run as a workflow here.",
                    }),
                ),
              disabled: pending,
              testId: 'feed-needs-you-plan-workflow',
            },
          ]
        : []),
    ];
    return (
      <div
        className="flex min-w-0 flex-col gap-3"
        data-testid="feed-needs-you-details"
      >
        <PlanPreview text={wait.detail ?? wait.title} />
        {outcome === null ? (
          <ChatComposerShell
            layout="plan-approval"
            dataTestId="feed-needs-you-plan-prompt"
          >
            <div className={PLAN_APPROVAL_BOX_CLASS}>
              <PlanApprovalPrompt options={options}>
                <div
                  className={`min-w-0 flex-1 ${PLAN_APPROVAL_EDITOR_CONTAINER_CLASS}`}
                >
                  <TextArea
                    variant="composer"
                    data-testid="feed-needs-you-plan-reply"
                    value={planReply}
                    disabled={pending}
                    aria-label="What to do differently"
                    placeholder="No, explain what to do differently"
                    onChange={(event): void =>
                      setPlanReply(event.currentTarget.value)
                    }
                    onKeyDown={onPlanReplyKeyDown}
                  />
                </div>
                <ComposerSendButton
                  kind="send"
                  onSend={sendPlanReply}
                  disabled={pending || planReply.trim().length === 0}
                  pending={false}
                  dataTestId="feed-needs-you-send"
                />
              </PlanApprovalPrompt>
            </div>
          </ChatComposerShell>
        ) : (
          <span role="status" className="text-xs fg-secondary">
            {outcome}
          </span>
        )}
      </div>
    );
  };

  const renderDetails = (): JSX.Element | null => {
    if (!expanded) return null;
    switch (item.kind) {
      case 'question':
        return renderQuestionDetails();
      case 'plan':
        return renderPlanDetails();
      case 'approval':
        return wait === undefined ? null : (
          <p
            data-testid="feed-needs-you-details"
            className={`text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}
          >
            Tool: {wait.title}
          </p>
        );
      case 'failed_run':
      case 'review':
        return null;
    }
  };

  const renderActions = (): JSX.Element => {
    switch (item.kind) {
      case 'question':
        return outcome === null ? (
          <Button
            type="button"
            data-testid="feed-needs-you-answer"
            size="sm"
            variant="secondary"
            disabled={pending}
            aria-expanded={expanded}
            onClick={(): void => setExpanded(true)}
          >
            Answer
          </Button>
        ) : (
          <span role="status" className="text-xs fg-secondary">
            {outcome}
          </span>
        );
      case 'plan':
        return wait === undefined ? (
          <span className="text-xs fg-tertiary">Plan details unavailable</span>
        ) : answers === null ? (
          <span className="text-xs fg-tertiary">Plan details unavailable</span>
        ) : (
          <>
            {/* A plan opens in place to its text and answers. */}
            <Button
              type="button"
              data-testid="feed-needs-you-plan-toggle"
              size="sm"
              variant="secondary"
              aria-expanded={expanded}
              onClick={(): void => setExpanded((current) => !current)}
            >
              {expanded ? 'Hide plan' : 'Review plan'}
            </Button>
            {renderOpenWaitButton(
              'Open chat',
              'feed-needs-you-open',
              wait,
              false,
            )}
          </>
        );
      case 'approval':
        return wait === undefined ? (
          <span className="text-xs fg-tertiary">Open chat unavailable</span>
        ) : (
          (renderOpenWaitButton(
            'Open chat',
            'feed-needs-you-open',
            wait,
            true,
          ) ?? (
            <span className="text-xs fg-tertiary">Open chat unavailable</span>
          ))
        );
      case 'failed_run':
        return (
          <div className="flex flex-wrap items-center gap-2">
            {outcome === null && wait !== undefined && answers !== null ? (
              <Button
                type="button"
                data-testid="feed-needs-you-retry"
                aria-label={`Try again for ${item.title}`}
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={(): void =>
                  void runAction(() => answers.retryRun(wait), 'Trying again.')
                }
              >
                Try again
              </Button>
            ) : outcome !== null ? (
              <span role="status" className="text-xs fg-secondary">
                {outcome}
              </span>
            ) : null}
            {wait === undefined
              ? null
              : renderOpenWaitButton(
                  'Open run',
                  'feed-needs-you-open',
                  wait,
                  false,
                )}
          </div>
        );
      case 'review': {
        const review = item.review;
        return (
          <div className="flex flex-wrap items-center gap-2">
            {outcome === null ? (
              <Button
                type="button"
                data-testid="feed-needs-you-mark-completed"
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={(): void =>
                  void runAction(
                    () => onMarkCompleted(item),
                    'Marked completed.',
                    "Couldn't mark this entry as completed. Try again.",
                  )
                }
              >
                Mark completed
              </Button>
            ) : (
              <span role="status" className="text-xs fg-secondary">
                {outcome}
              </span>
            )}
            <Button
              type="button"
              data-testid="feed-needs-you-open"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={(): void => onOpenReview(item)}
            >
              Open entry
            </Button>
            {review !== undefined &&
            closeIntent?.origin === 'review' &&
            closeIntent.entryId === review.entry.entryId &&
            onResolveCloseIntent !== undefined ? (
              <div className="w-full">
                <LedgerCloseIntentPrompt
                  openCount={closeIntent.openCount}
                  openCountIsLowerBound={closeIntent.openCountIsLowerBound}
                  kind={
                    review.entry.type === 'OPERATION' ? 'OPERATION' : 'TASK'
                  }
                  onChoose={onResolveCloseIntent}
                />
              </div>
            ) : null}
          </div>
        );
      }
    }
  };

  return (
    <div
      data-testid="feed-needs-you-row"
      data-kind={item.kind}
      className="flex flex-col gap-2 border-b border-line-base py-3 last:border-b-0"
    >
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <StatusGlyph state="needs-you" size={14} label="Needs you" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {title}
          <div className={`text-xs fg-tertiary ${REPLAY_MASK_CLASS}`}>
            <WorkPath parts={workPath} testId="feed-needs-you-path" />
          </div>
        </div>
        {item.time === null ? null : (
          <time
            dateTime={item.time}
            className="shrink-0 text-xs fg-tertiary"
            aria-label={formatLedgerRelativeTime(item.time, new Date(now))}
          >
            {formatLedgerRelativeTime(item.time, new Date(now))}
          </time>
        )}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {renderActions()}
        </div>
      </div>
      {error === null ? null : <ActionError message={error} />}
      {renderDetails()}
    </div>
  );
}

export function LedgerFeedNeedsYou({
  items,
  layout = 'page',
  scopeNames,
  onOpenScope,
  pathRoot,
  answers,
  onMarkCompleted,
  onOpenReview,
  reviewsStatus,
  onRetryReviews,
  closeIntent = null,
  onResolveCloseIntent,
  now,
  hideWhenEmpty = false,
}: LedgerFeedNeedsYouProps): JSX.Element | null {
  const visibleItems =
    answers === null ? items.filter((item) => item.kind === 'review') : items;
  if (hideWhenEmpty && visibleItems.length === 0 && reviewsStatus !== 'problem')
    return null;
  return (
    <section data-testid="feed-needs-you" className="flex flex-col gap-2">
      <FeedSectionHeading
        title="Needs you"
        count={visibleItems.length}
        testId="feed-needs-you-heading"
      />
      {reviewsStatus === 'problem' ? (
        <div className="flex flex-wrap items-center gap-2 text-xs fg-secondary">
          <p role="status">Couldn't check reviews.</p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid="feed-needs-you-retry"
            onClick={onRetryReviews}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {visibleItems.length === 0 ? (
        reviewsStatus === 'ready' ? (
          <EmptyState
            title="Nothing needs you right now."
            tone="quiet"
            inset="none"
            testId="feed-needs-you-empty"
          />
        ) : null
      ) : (
        <div className="flex flex-col">
          {visibleItems.map((item) => (
            <NeedsYouRow
              key={item.key}
              item={item}
              layout={layout}
              scopeNames={scopeNames}
              onOpenScope={onOpenScope}
              pathRoot={pathRoot}
              answers={answers}
              onMarkCompleted={onMarkCompleted}
              onOpenReview={onOpenReview}
              closeIntent={closeIntent}
              onResolveCloseIntent={onResolveCloseIntent}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  );
}
