'use client';

import { ContinueInterruptedSessionRow } from '@canopy/ui-shared/components';
import { useCallback, useId, useState, type JSX, type ReactNode } from 'react';
import {
  HomeSection,
  SuggestionRow,
  SuggestionRowTrailing,
} from '@canopy/ui-shared';
import { Button } from '@canopy/ui-shared/components';
import {
  ApprovalAskIcon,
  ChatIcon,
  ChevronDownMediumIcon,
  CircleCheckIcon,
  CloseMediumIcon,
  HistoryIcon,
  PlansIcon,
  QuestionMarkIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  buildContinueSectionModel,
  continueAttentionStatus,
  continueAttentionSubject,
  type ContinueAttentionItem,
  type ContinueInterruptedTarget,
  type ContinueLastViewed,
} from './continue-attention';

/**
 * One interrupted chat or pipeline, named instead of counted. The row reads
 * `{prefix} {title} {suffix}`, such as "Resume Fix login" or "Fix login
 * waiting for Codex reset", with `Interrupted · {kind} · {worktree} ·
 * {workspace}` as context; blank context segments are left out.
 */
export interface ContinueInterruptedSession {
  /** Non-empty display title; hosts fall back to the count row otherwise. */
  readonly title: string;
  readonly prefix?: string;
  readonly suffix?: string;
  /** A kind label for entries that are not chats, such as "Pipeline". */
  readonly kindLabel?: string;
  readonly worktreeName?: string;
  readonly workspaceName?: string;
  /** The chat's worktree; a matching Last viewed offer merges into this row. */
  readonly mergeTarget?: ContinueInterruptedTarget;
  /** Navigates to the session without resuming it; absent without a destination. */
  readonly onOpen?: () => void;
}

/** The interrupted-sessions row, on hosts that track interrupted sessions. */
export interface ContinueSectionInterrupted {
  readonly count: number;
  /** Names the single interrupted entry; the count copy shows otherwise. */
  readonly session?: ContinueInterruptedSession | null;
  /**
   * Host copy when it knows more than the count, such as sessions waiting
   * for a usage reset. Defaults to "Resume N interrupted sessions".
   */
  readonly label?: string;
  /** Full text for a label the visible row may truncate. */
  readonly accessibleLabel?: string;
  readonly onResume: () => void;
  readonly onDismiss: () => void;
}

/** Attention rows shown before Show more, and how many each click adds. */
export const CONTINUE_FIRST_PAGE_ROWS = 5;
export const CONTINUE_SHOW_MORE_ROWS = 10;

function defaultInterruptedLabel(count: number): string {
  return `Resume ${count} interrupted session${count === 1 ? '' : 's'}`;
}

function interruptedContext(session: ContinueInterruptedSession): string {
  return [
    'Interrupted',
    session.kindLabel,
    session.worktreeName,
    session.workspaceName,
  ]
    .filter((segment): segment is string => Boolean(segment?.trim()))
    .join(' · ');
}

/**
 * Last viewed's masked secondary text: chat, worktree, then workspace. Blank
 * names and names that repeat the destination or an earlier segment are left
 * out, whether or not the host already resolved them.
 */
function LastViewedContext({
  lastViewed,
}: {
  readonly lastViewed: ContinueLastViewed;
}): JSX.Element {
  const destination = lastViewed.destinationName.trim();
  const chatTitle = lastViewed.chatTitle?.trim();
  const worktreeName = lastViewed.worktreeName?.trim();
  const showChat = Boolean(chatTitle) && chatTitle !== destination;
  const showWorktree =
    Boolean(worktreeName) &&
    worktreeName !== destination &&
    worktreeName !== chatTitle;
  return (
    <span className={`${REPLAY_MASK_CLASS} pl-2 fg-quaternary`}>
      {showChat ? (
        <>
          <span data-testid="home-resume-chat-title">{chatTitle}</span>
          {' · '}
        </>
      ) : null}
      {showWorktree ? (
        <>
          <span data-testid="home-resume-worktree-name">{worktreeName}</span>
          {' · '}
        </>
      ) : null}
      {lastViewed.workspaceName}
    </span>
  );
}

export interface ContinueSectionProps {
  readonly onVisibilityChange?: (visible: boolean) => void;
  /** Host observers share the lifetime of the visible section. */
  readonly children?: ReactNode;
  readonly attention: readonly ContinueAttentionItem[];
  readonly onOpenAttention: (item: ContinueAttentionItem) => void;
  /** Hosts without a persisted destination pass none. */
  readonly lastViewed?: ContinueLastViewed | null;
  readonly onOpenLastViewed?: () => void;
  readonly interrupted?: ContinueSectionInterrupted | null;
  /**
   * A destination listing every unread result. Without one, every unread row
   * shows, since capping would hide results with no way to reach them.
   */
  readonly onOpenUnreadOverflow?: () => void;
  /**
   * Hosts that also read the model (App Advisor) own how many attention rows
   * are shown; the section keeps its own count otherwise.
   */
  readonly attentionPaging?: ContinueAttentionPaging;
}

export interface ContinueAttentionPaging {
  readonly shownRows: number;
  readonly onShowMore: () => void;
}

/** Section-owned paging: 5 rows, then 10 more per Show more. */
export function useContinueAttentionPaging(): ContinueAttentionPaging {
  const [shownRows, setShownRows] = useState(CONTINUE_FIRST_PAGE_ROWS);
  const onShowMore = useCallback(
    (): void => setShownRows((count) => count + CONTINUE_SHOW_MORE_ROWS),
    [],
  );
  return { shownRows, onShowMore };
}

function attentionIcon(item: ContinueAttentionItem): ReactNode {
  switch (item.kind) {
    case 'question':
      return <QuestionMarkIcon size={16} aria-hidden="true" />;
    case 'tool-approval':
      return <ApprovalAskIcon size={16} aria-hidden="true" />;
    case 'plan-review':
      return <PlansIcon size={16} aria-hidden="true" />;
    case 'unread':
      return item.completed === true && item.target.kind === 'chat' ? (
        <CircleCheckIcon size={16} aria-hidden="true" />
      ) : (
        <ChatIcon size={16} aria-hidden="true" />
      );
  }
}

function AttentionRow({
  item,
  onOpen,
}: {
  readonly item: ContinueAttentionItem;
  readonly onOpen: (item: ContinueAttentionItem) => void;
}): JSX.Element {
  const { target } = item;
  const isChat = target.kind === 'chat';
  return (
    <li
      data-testid={`home-continue-${item.kind}-row`}
      data-attention-kind={item.kind}
      data-target-kind={target.kind}
      data-workspace-id={target.workspaceId}
      data-worktree-id={target.worktreeId}
      {...(target.kind === 'chat' ? { 'data-chat-id': target.chatId } : {})}
    >
      <SuggestionRow
        icon={attentionIcon(item)}
        data-testid="home-continue-attention-button"
        onClick={(): void => onOpen(item)}
      >
        {/* Titles and names are user-authored: masked, and the accessible
            name comes from this same masked text rather than an attribute. */}
        <span
          data-testid="home-continue-attention-subject"
          className={REPLAY_MASK_CLASS}
        >
          {continueAttentionSubject(item)}
        </span>{' '}
        {/* An unread row's icon already says what happened (a check for a
            finished chat, a bubble for a reply), so its status phrase is
            for screen readers only. */}
        <span className={item.kind === 'unread' ? 'sr-only' : undefined}>
          {continueAttentionStatus(item)}
        </span>
        <span
          data-testid="home-continue-attention-context"
          className={`${REPLAY_MASK_CLASS} pl-2 fg-quaternary`}
        >
          {isChat ? `${item.worktreeName} · ` : ''}
          {item.workspaceName}
        </span>
      </SuggestionRow>
    </li>
  );
}

/**
 * Shared "Continue" recommendations below the Home composer (desktop Home and
 * Portal New Task): the interrupted-sessions row, chats waiting for input,
 * unread results, then the Last viewed destination. Hosts own state,
 * navigation, and read semantics; this component only orders and renders.
 */
export function ContinueSection({
  onVisibilityChange,
  children,
  attention,
  onOpenAttention,
  lastViewed = null,
  onOpenLastViewed,
  interrupted = null,
  onOpenUnreadOverflow,
  attentionPaging,
}: ContinueSectionProps): JSX.Element | null {
  const headingId = useId();
  const ownPaging = useContinueAttentionPaging();
  const paging = attentionPaging ?? ownPaging;
  const interruptedVisible = interrupted !== null && interrupted.count > 0;
  const interruptedSession = interrupted?.session ?? null;
  const model = buildContinueSectionModel({
    attention,
    lastViewed,
    interruptedVisible,
    interruptedTarget: interruptedSession?.mergeTarget ?? null,
    hasUnreadOverflowDestination: onOpenUnreadOverflow !== undefined,
    shownAttentionRows: paging.shownRows,
  });
  if (!model.visible) return <>{children}</>;

  return (
    <HomeSection
      onVisibilityChange={onVisibilityChange}
      sectionId="continue"
      title="Continue"
      testId="home-resume-card"
      headingId={headingId}
    >
      {children}
      <ul className="flex flex-col">
        {interrupted !== null && interruptedVisible ? (
          <ContinueInterruptedSessionRow
            role="status"
            aria-live="polite"
            data-testid="home-interrupted-sessions-banner"
          >
            <SuggestionRow
              icon={<WarningIcon size={16} aria-hidden="true" />}
              data-testid="home-interrupted-sessions-resume"
              // A named row's accessible name is its own visible text.
              {...(interruptedSession === null
                ? {
                    'aria-label':
                      interrupted.accessibleLabel ??
                      'Resume interrupted sessions',
                  }
                : {})}
              trailingControl={interruptedSession?.onOpen ? 'wide' : true}
              onClick={interrupted.onResume}
            >
              {interruptedSession === null ? (
                <span data-testid="home-interrupted-sessions-details">
                  {interrupted.label ??
                    defaultInterruptedLabel(interrupted.count)}
                </span>
              ) : (
                <span data-testid="home-interrupted-sessions-details">
                  {interruptedSession.prefix
                    ? `${interruptedSession.prefix} `
                    : ''}
                  {/* Titles and names are user-authored: masked. */}
                  <span
                    data-testid="home-interrupted-sessions-title"
                    className={REPLAY_MASK_CLASS}
                  >
                    {interruptedSession.title}
                  </span>
                  {interruptedSession.suffix
                    ? ` ${interruptedSession.suffix}`
                    : ''}{' '}
                  <span
                    data-testid="home-interrupted-sessions-context"
                    className={`${REPLAY_MASK_CLASS} pl-2 fg-quaternary`}
                  >
                    {interruptedContext(interruptedSession)}
                  </span>
                </span>
              )}
            </SuggestionRow>
            <SuggestionRowTrailing>
              {interruptedSession?.onOpen ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="compact"
                  data-testid="home-interrupted-sessions-open"
                  onClick={interruptedSession.onOpen}
                >
                  Open
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="compact"
                iconOnly
                aria-label="Dismiss"
                data-testid="home-interrupted-sessions-dismiss"
                onClick={interrupted.onDismiss}
              >
                <CloseMediumIcon size="sm" />
              </Button>
            </SuggestionRowTrailing>
          </ContinueInterruptedSessionRow>
        ) : null}
        {model.shownAttention.map((item) => (
          <AttentionRow
            key={rowKey(item)}
            item={item}
            onOpen={onOpenAttention}
          />
        ))}
        {/* Right under the rows it reveals, before Last viewed. */}
        {/* Deviation from docs/design/interaction.md ("Show more" opens with
            Disclosure): Continue pages its rows with one more SuggestionRow,
            so the control keeps the rows' pitch (Daniil, 2026-11-03). */}
        {model.hiddenAttentionCount > 0 ? (
          <li>
            <SuggestionRow
              icon={<ChevronDownMediumIcon size={16} aria-hidden="true" />}
              tone="muted"
              data-testid="home-continue-show-more"
              onClick={paging.onShowMore}
            >
              Show more
            </SuggestionRow>
          </li>
        ) : null}
        {model.unreadOverflowCount > 0 && onOpenUnreadOverflow ? (
          <li>
            <SuggestionRow
              icon={<ChatIcon size={16} aria-hidden="true" />}
              data-testid="home-continue-unread-overflow"
              onClick={onOpenUnreadOverflow}
            >
              {`See ${model.unreadOverflowCount} more unread ${
                model.unreadOverflowCount === 1 ? 'result' : 'results'
              }`}
            </SuggestionRow>
          </li>
        ) : null}
        {lastViewed !== null && model.lastViewedVisible ? (
          <li data-testid="home-resume-details">
            <SuggestionRow
              icon={<HistoryIcon size={16} aria-hidden="true" />}
              data-testid="home-resume-button"
              onClick={onOpenLastViewed}
            >
              <span>Last viewed: </span>
              <span
                data-testid="home-resume-destination"
                className={REPLAY_MASK_CLASS}
              >
                {lastViewed.destinationName}
              </span>
              <LastViewedContext lastViewed={lastViewed} />
              {lastViewed.activity ? (
                <span
                  data-testid="home-resume-activity"
                  className="pl-2 fg-secondary"
                >
                  · {lastViewed.activity}
                </span>
              ) : null}
            </SuggestionRow>
          </li>
        ) : null}
      </ul>
    </HomeSection>
  );
}

function rowKey(item: ContinueAttentionItem): string {
  const { target } = item;
  return target.kind === 'chat'
    ? `chat:${target.workspaceId}/${target.worktreeId}/${target.chatId}`
    : `worktree:${target.workspaceId}/${target.worktreeId}`;
}
