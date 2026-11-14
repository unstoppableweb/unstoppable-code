import { useId, useMemo, useState, type JSX } from 'react';
import { useStore } from 'zustand';
import type {
  LedgerFeedAnswerActions,
  LedgerLiveSnapshot,
} from '@canopy/app-core';
import {
  filterWorkRowViews,
  ledgerDoingNowText,
  ledgerProgressInfo,
  ledgerVisibleWorkTreeRows,
  ledgerWorkRowMatchesRootChat,
  ledgerWorkStatusCounts,
  ledgerWorkTreeRows,
  sortWorkRowViews,
  deriveWorkRowViews,
  LEDGER_OPEN_TASK_STATUSES,
  LEDGER_WORK_STATUSES,
  type LedgerFeedWorkStore,
  type LedgerFeedWorkActionResult,
  type LedgerFeedWorkCloseIntent,
  type LedgerWorkRowView,
  type LedgerWorkSortColumn,
  type LedgerWorkTreeRow,
} from '@canopy/app-state/ledger-feed';
import {
  isLedgerTerminalStatus,
  type LedgerActorLabel,
  type LedgerActorRef,
  type LedgerOwnerCandidate,
  type LedgerRootChatFilter,
} from '@canopy/protocol/canopy-core';
import {
  isLedgerTaskViewScope,
  type LedgerFeedRow,
  type LedgerFeedWorkRow,
  type LedgerViewActorHost,
  type LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import {
  AgentStateGlyph,
  Button,
  CenteredLoadingSpinner,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  DelayedLoadingPlaceholder,
  Disclosure,
  EmptyState,
  ErrorBanner,
  Heading,
  LedgerEntryMarkdown,
  LedgerStatusPill,
  ListRow,
  ProgressDots,
  StatusGlyph,
  StatusCounts,
  TextInput,
  WorkPath,
} from '@canopy/ui-shared/components';
import { ChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  formatLedgerRelativeTime,
  ledgerActorName,
} from '@canopy/ui-shared/lib';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import { problemCopy } from './ledger-problem-copy';
import {
  LEDGER_WORK_STATUS_LABELS,
  LEDGER_WORK_STATUS_GLYPHS,
  FeedSectionHeading,
  WorkStatusLabel,
} from './ledger-feed-sections';
import {
  LedgerCloseIntentPrompt,
  ledgerCloseIntentCopy,
} from './ledger-close-intent';
import {
  LedgerLeftOpenNote,
  LedgerLeftOpenTrigger,
  useLedgerLeftOpenShown,
} from './ledger-left-open';
import {
  ledgerScopeWorkPath,
  type LedgerScopeNames,
  type LedgerScopeNamesFor,
} from './ledger-work-path';
import { Surface } from '@canopy/ui-shared/components';

export interface LedgerFeedOperationsProps {
  readonly store: LedgerFeedWorkStore;
  readonly snapshot: LedgerLiveSnapshot | null;
  readonly scopeNames: LedgerScopeNamesFor;
  readonly onOpenScope?: (scope: LedgerViewScope) => void;
  readonly answers: LedgerFeedAnswerActions | null;
  readonly personActorId?: string | null;
  readonly personName: string;
  readonly now: number;
  readonly onOpenEntry?: (scope: LedgerViewScope, entryId: string) => void;
  readonly layout?: 'page' | 'panel';
  readonly pathRoot?: LedgerViewScope;
  readonly leftOpenActions?: LedgerFeedOperationsLeftOpenActions;
  /**
   * Draw nothing while there is no work and no problem, including during the
   * first read, as the Feed panel does.
   */
  readonly hideWhenEmpty?: boolean;
  /** Only rows on this root chat's line, as the Feed panel's picker sets. */
  readonly rootChat?: LedgerRootChatFilter | null;
}

export interface LedgerFeedOperationsLeftOpenActions {
  readonly candidates: readonly LedgerOwnerCandidate[];
  readonly ownersStatus: 'idle' | 'loading' | 'ready' | 'problem';
  readonly loadOwners: () => void;
  readonly assignOwner: (
    scope: LedgerViewScope,
    entryId: string,
    owner: LedgerOwnerCandidate | null,
  ) => Promise<void> | void;
}

function namesForWorkRow(
  row: LedgerWorkRowView['row'],
  scopeNames: LedgerScopeNamesFor,
): LedgerScopeNames | null {
  // The host's names come first, so a row reads like Activity's rows.
  const names = scopeNames(row.scope);
  if (names !== null || row.projectName === null) return names;
  return { projectName: row.projectName, taskName: row.taskName };
}

function DoingNowContent({
  view,
}: {
  readonly view: LedgerWorkRowView;
}): JSX.Element | null {
  const doingNow = view.doingNow;
  if (doingNow === null) return null;
  const copy = ledgerDoingNowText(doingNow);
  if (copy === null) return null;
  switch (doingNow.kind) {
    case 'wait':
      return (
        <span className={`text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}>
          {copy}
        </span>
      );
    case 'review':
      return (
        <span className="text-xs fg-secondary">
          To review: <span className={REPLAY_MASK_CLASS}>{doingNow.task}</span>
        </span>
      );
    case 'catching_up':
      return <span className="text-xs fg-secondary">{copy}</span>;
    case 'working':
      return (
        <span className="text-xs fg-secondary">
          <span className={REPLAY_MASK_CLASS}>{doingNow.task}</span>
          {' · '}
          <span className={REPLAY_BLOCK_CLASS}>{doingNow.agentName}</span>
        </span>
      );
    case 'blocked':
      return (
        <span className="text-xs fg-secondary">
          Blocked: <span className={REPLAY_MASK_CLASS}>{doingNow.task}</span>
        </span>
      );
    case 'failed':
      return (
        <span className="text-xs fg-secondary">
          Failed: <span className={REPLAY_MASK_CLASS}>{doingNow.task}</span>
        </span>
      );
    case 'next':
      return (
        <span className="text-xs fg-secondary">
          Next: <span className={REPLAY_MASK_CLASS}>{doingNow.task}</span>
        </span>
      );
  }
}

interface MessageDestination {
  readonly target: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  } | null;
  readonly reason: string | null;
}

function messageDestination(
  row: LedgerWorkRowView['row'],
  actorHosts: Readonly<Record<string, LedgerViewActorHost>>,
  personActorId: string | null | undefined,
): MessageDestination {
  const owner = row.item.owner;
  const ownerIsPerson =
    owner.kind === 'user' || owner.actorId === personActorId;
  if (ownerIsPerson) {
    return row.chatId === null || !isLedgerTaskViewScope(row.scope)
      ? { target: null, reason: 'No chat is available for this task.' }
      : {
          target: { ...row.scope, chatId: row.chatId },
          reason: null,
        };
  }
  const host = actorHosts[owner.actorId];
  if (host === undefined) {
    return { target: null, reason: 'This owner has no chat on this device.' };
  }
  if (host.kind === 'chat') {
    return {
      target: {
        projectId: host.projectId,
        worktreeId: host.worktreeId,
        chatId: host.chatId,
      },
      reason: null,
    };
  }
  if (host.kind === 'delegation') {
    return host.rootChatId === null
      ? { target: null, reason: 'This owner has no root chat to message.' }
      : {
          target: {
            projectId: host.projectId,
            worktreeId: host.worktreeId,
            chatId: host.rootChatId,
          },
          reason: null,
        };
  }
  return {
    target: null,
    reason: 'This pipeline owner has no chat to message.',
  };
}

function ownerName(
  actor: LedgerActorRef,
  actors: Readonly<Record<string, LedgerActorLabel>>,
  personActorId: string | null | undefined,
  personName: string,
): string {
  return actor.kind === 'user' || actor.actorId === personActorId
    ? personName
    : ledgerActorName(actor, actors);
}

function ownerReplayClass(actor: LedgerActorRef): string {
  if (actor.kind === 'user') return REPLAY_BLOCK_CLASS;
  if (actor.kind === 'chat') return REPLAY_MASK_CLASS;
  return '';
}

function MessageField({
  destination,
  answers,
}: {
  readonly destination: MessageDestination;
  readonly answers: LedgerFeedAnswerActions | null;
}): JSX.Element {
  const inputId = useId();
  const reasonId = useId();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = destination.target;
  const disabledReason =
    answers === null ? "Messaging isn't available here." : destination.reason;
  const disabled = disabledReason !== null || pending;

  const send = async (): Promise<void> => {
    if (answers === null || target === null || message.trim().length === 0)
      return;
    setPending(true);
    setError(null);
    try {
      const result = await answers.sendMessage(target, message);
      if (result.ok) {
        setMessage('');
      } else {
        setError(result.message);
      }
    } catch {
      setError("Couldn't send the message. Try again.");
    } finally {
      setPending(false);
    }
  };

  const openChat = async (): Promise<void> => {
    if (answers === null || target === null) return;
    setPending(true);
    setError(null);
    try {
      const result = await answers.openChat(target);
      if (!result.ok) setError(result.message);
    } catch {
      setError("Couldn't open the chat. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="feed-row-message-field">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <TextInput
          id={inputId}
          data-testid="feed-row-message-input"
          value={message}
          disabled={disabled}
          placeholder="Message…"
          aria-describedby={disabledReason === null ? undefined : reasonId}
          aria-label="Message owner"
          onChange={(event): void => setMessage(event.currentTarget.value)}
          className="min-w-48 flex-1"
        />
        <Button
          type="button"
          data-testid="feed-row-message-send"
          size="sm"
          variant="primary"
          disabled={disabled || message.trim().length === 0}
          onClick={(): void => void send()}
        >
          Send
        </Button>
        {answers !== null && target !== null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={(): void => void openChat()}
          >
            Open chat
          </Button>
        ) : null}
      </div>
      {disabledReason === null ? null : (
        <p id={reasonId} className="text-xs fg-tertiary">
          {disabledReason}
        </p>
      )}
      <ErrorBanner
        errorSource="feed-operations-message-error"
        className=""
        error={error}
        testId="feed-operations-message-error"
      />
    </div>
  );
}

function TreeEntryRow({
  row,
  workRow,
  store,
  actors,
  snapshot,
  onOpenEntry,
  scope,
  personActorId,
  personName,
  now,
  leftOpenActions,
  closeIntent,
  open,
  onToggle,
}: {
  readonly row: LedgerWorkTreeRow;
  /** Its details, and the tasks under it, show below it. */
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly workRow: LedgerFeedWorkRow;
  readonly store: LedgerFeedWorkStore;
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly snapshot: LedgerLiveSnapshot | null;
  readonly onOpenEntry?: (scope: LedgerViewScope, entryId: string) => void;
  readonly scope: LedgerViewScope;
  readonly personActorId: string | null | undefined;
  readonly personName: string;
  readonly now: number;
  readonly leftOpenActions?: LedgerFeedOperationsLeftOpenActions;
  readonly closeIntent: LedgerFeedWorkCloseIntent | null;
}): JSX.Element {
  const entry = row.entry;
  const live = snapshot?.agents[entry.owner.actorId];
  const canTakeIt =
    entry.owner.kind === 'user' || entry.owner.actorId === personActorId;
  const leftOpenShown = useLedgerLeftOpenShown(
    leftOpenActions === undefined ? undefined : entry.leftOpen,
    entry.owner.kind,
    live,
  );
  const [leftOpenOptions, setLeftOpenOptions] = useState(false);
  const markCompleted = (): Promise<LedgerFeedWorkActionResult> => {
    const feedRow: LedgerFeedRow = {
      entry,
      ledgerId: workRow.ledgerId,
      scopeKind: workRow.scopeKind,
      scopeArchived: workRow.scopeArchived,
      origin: { kind: 'this_device', scope: workRow.scope },
    };
    return store.getState().markCompleted(feedRow, { origin: 'row' });
  };
  const updated = formatLedgerRelativeTime(entry.updatedAt, new Date(now));
  // The details sit under the title, past the chevron.
  const details = (
    <div className="pl-5">
      <Surface
        variant="group"
        size="small"
        className="min-w-0"
        data-testid="feed-operations-tree-details"
      >
        <div className="flex flex-col items-start gap-2 px-3 py-2">
          {entry.content.trim() === '' ? null : (
            <div className={`w-full min-w-0 ${REPLAY_BLOCK_CLASS}`}>
              <LedgerEntryMarkdown
                content={entry.content}
                density="panel"
                data-testid="feed-operations-tree-content"
              />
            </div>
          )}
          <p className="text-2xs fg-tertiary">
            <span className={ownerReplayClass(entry.owner)}>
              Owner: {ownerName(entry.owner, actors, personActorId, personName)}
            </span>
            {' · '}
            <span className={ownerReplayClass(entry.author)}>
              Added by{' '}
              {ownerName(entry.author, actors, personActorId, personName)}
            </span>
            {' · '}
            {/* "Just now" is the only capitalized form; it sits mid-sentence. */}
            Updated {updated === 'Just now' ? 'just now' : updated}
          </p>
          {onOpenEntry === undefined ? null : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="feed-operations-tree-open-entry"
              onClick={(event): void => {
                event.stopPropagation();
                onOpenEntry(scope, entry.entryId);
              }}
            >
              Open entry
            </Button>
          )}
        </div>
      </Surface>
    </div>
  );
  // The task opens in place to its details and to the tasks under it.
  const label = (
    <span className="flex min-w-0 items-center gap-2">
      <LedgerStatusPill
        status={entry.status}
        data-testid="feed-operations-tree-status"
      />
      <span
        className={`min-w-0 truncate text-xs font-normal fg-primary ${REPLAY_MASK_CLASS}`}
      >
        {entry.title}
      </span>
      {row.showOwner ? (
        <span
          className={`min-w-0 truncate text-2xs fg-tertiary ${ownerReplayClass(entry.owner)}`}
        >
          {ownerName(entry.owner, actors, personActorId, personName)}
        </span>
      ) : null}
      {row.ownerStateVisible && live?.phase === 'working' ? (
        <AgentStateGlyph
          state="working"
          unread={live.unread}
          testId="feed-operations-owner-state"
        />
      ) : null}
      {row.ownerStateVisible && live?.phase === 'background' ? (
        <AgentStateGlyph
          state="background"
          backgroundTasks={live.backgroundTasks}
          unread={live.unread}
          testId="feed-operations-owner-state"
        />
      ) : null}
    </span>
  );
  const rowContent = (
    <>
      <Disclosure
        label={label}
        open={open}
        onOpenChange={onToggle}
        dataTestId="feed-operations-tree-disclosure"
        toggleTestId="feed-operations-tree-toggle"
        className="min-w-0 flex-1"
      >
        {details}
      </Disclosure>
      {/* A parent task's dots are its own tasks; the warning sits last. */}
      {row.childStatuses.length > 0 ||
      (leftOpenShown && entry.leftOpen !== undefined) ? (
        <span className="flex h-6 shrink-0 items-center gap-2">
          {row.childStatuses.length > 0 ? (
            <ProgressDots
              statuses={row.childStatuses}
              testId="feed-operations-tree-progress"
            />
          ) : null}
          {leftOpenShown && entry.leftOpen !== undefined ? (
            <LedgerLeftOpenTrigger
              leftOpen={entry.leftOpen}
              now={now}
              open={leftOpenOptions}
              onToggle={(): void => setLeftOpenOptions((open) => !open)}
              testId="feed-operations-tree-left-open"
            />
          ) : null}
        </span>
      ) : null}
    </>
  );
  const leftOpenNote =
    leftOpenActions === undefined ||
    entry.leftOpen === undefined ||
    !leftOpenShown ||
    !leftOpenOptions ? null : (
      <div className={ownerReplayClass(entry.owner)}>
        <LedgerLeftOpenNote
          leftOpen={entry.leftOpen}
          now={now}
          ownerName={ownerName(entry.owner, actors, personActorId, personName)}
          ownerActorId={entry.owner.actorId}
          candidates={leftOpenActions.candidates}
          ownersStatus={leftOpenActions.ownersStatus}
          onLoadOwners={leftOpenActions.loadOwners}
          onHandTo={(owner) =>
            leftOpenActions.assignOwner(scope, entry.entryId, owner)
          }
          onTakeIt={() =>
            leftOpenActions.assignOwner(scope, entry.entryId, null)
          }
          onClose={markCompleted}
          takeItDisabled={canTakeIt}
          testId="feed-operations-tree-left-open"
        />
      </div>
    );
  const closePrompt =
    closeIntent?.origin === 'row' && closeIntent.entryId === entry.entryId ? (
      <LedgerCloseIntentPrompt
        openCount={closeIntent.openCount}
        openCountIsLowerBound={closeIntent.openCountIsLowerBound}
        kind={entry.type === 'OPERATION' ? 'OPERATION' : 'TASK'}
        onChoose={(choice) => store.getState().resolveCloseIntent(choice)}
        testId="feed-operations-tree-close-intent"
      />
    ) : null;
  // One structure whether or not the options show, so the Left open trigger
  // keeps its identity, and its focus, as they open and close.
  return (
    <div
      data-testid="feed-operations-tree-row"
      data-entry-id={entry.entryId}
      className="flex min-w-0 flex-col gap-2 py-1"
      style={{ marginInlineStart: `${row.depth * 20}px` }}
    >
      <div className="flex min-w-0 items-start gap-2">{rowContent}</div>
      {leftOpenNote}
      {closePrompt}
    </div>
  );
}

type WorkTreeProblemValue = NonNullable<
  ReturnType<LedgerFeedWorkStore['getState']>['trees'][string]
>['problem'];

function WorkTreeProblem({
  problem,
  onRetry,
}: {
  readonly problem: WorkTreeProblemValue;
  readonly onRetry: () => void;
}): JSX.Element {
  const copy =
    problem === null
      ? { message: "Couldn't load this entry. Try again.", retry: true }
      : problemCopy(problem, 'entry');
  return (
    <ErrorBanner
      errorSource="feed-operations-tree-problem"
      className=""
      error={copy.message}
      testId="feed-operations-tree-problem"
      {...(copy.retry ? { onRetry } : {})}
    />
  );
}

function WorkRowDetails({
  view,
  store,
  tree,
  actors,
  snapshot,
  answers,
  personActorId,
  personName,
  now,
  leftOpenActions,
  closeIntent,
  onOpenEntry,
}: {
  readonly view: LedgerWorkRowView;
  readonly store: LedgerFeedWorkStore;
  readonly tree:
    | ReturnType<LedgerFeedWorkStore['getState']>['trees'][string]
    | undefined;
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly snapshot: LedgerLiveSnapshot | null;
  readonly answers: LedgerFeedAnswerActions | null;
  readonly personActorId: string | null | undefined;
  readonly personName: string;
  readonly now: number;
  readonly leftOpenActions?: LedgerFeedOperationsLeftOpenActions;
  readonly closeIntent: LedgerFeedWorkCloseIntent | null;
  readonly onOpenEntry?: (scope: LedgerViewScope, entryId: string) => void;
}): JSX.Element {
  const item = view.row.item;
  const destination = messageDestination(
    view.row,
    store.getState().work.actorHosts,
    personActorId,
  );
  // The opened row already names the item: its tree is what is under it.
  const treeRows =
    tree?.status === 'ready'
      ? ledgerWorkTreeRows(
          tree.nodes.filter((node) => node.entryId !== item.entryId),
          item.owner,
        )
      : [];
  // Tasks start closed: the tree shows its top level until one opens.
  const [openTreeIds, setOpenTreeIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleTreeRow = (entryId: string): void =>
    setOpenTreeIds((current) => {
      const next = new Set(current);
      if (!next.delete(entryId)) next.add(entryId);
      return next;
    });
  const visibleTreeRows = ledgerVisibleWorkTreeRows(treeRows, openTreeIds);

  const retryTree = (): void => {
    void (async (): Promise<void> => {
      await store.getState().toggleOpen(item.entryId);
      await store.getState().toggleOpen(item.entryId);
    })();
  };

  return (
    <div
      className="flex flex-col gap-3 py-2"
      data-testid="feed-operations-row-details"
      data-entry-id={item.entryId}
    >
      {tree === undefined || tree.status === 'loading' ? (
        <DelayedLoadingPlaceholder slowNote="Still loading tasks…">
          <CenteredLoadingSpinner />
        </DelayedLoadingPlaceholder>
      ) : tree.status === 'problem' ? (
        <WorkTreeProblem problem={tree.problem} onRetry={retryTree} />
      ) : treeRows.length === 0 ? (
        <p className="text-xs fg-tertiary">No tasks in this operation.</p>
      ) : (
        <div className="flex flex-col" data-testid="feed-operations-tree">
          {visibleTreeRows.map(({ row: treeRow }) => (
            <TreeEntryRow
              key={treeRow.entry.entryId}
              row={treeRow}
              open={openTreeIds.has(treeRow.entry.entryId)}
              onToggle={(): void => toggleTreeRow(treeRow.entry.entryId)}
              workRow={view.row}
              store={store}
              actors={actors}
              snapshot={snapshot}
              onOpenEntry={onOpenEntry}
              scope={view.row.scope}
              personActorId={personActorId}
              personName={personName}
              now={now}
              leftOpenActions={leftOpenActions}
              closeIntent={closeIntent}
            />
          ))}
        </div>
      )}
      <MessageField destination={destination} answers={answers} />
    </div>
  );
}

function WorkOperationRow({
  view,
  store,
  tree,
  actors,
  snapshot,
  scopeNames,
  onOpenScope,
  onOpenEntry,
  answers,
  personActorId,
  personName,
  now,
}: {
  readonly view: LedgerWorkRowView;
  readonly store: LedgerFeedWorkStore;
  readonly tree:
    | ReturnType<LedgerFeedWorkStore['getState']>['trees'][string]
    | undefined;
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly snapshot: LedgerLiveSnapshot | null;
  readonly scopeNames: LedgerScopeNamesFor;
  readonly onOpenScope?: (scope: LedgerViewScope) => void;
  readonly onOpenEntry?: (scope: LedgerViewScope, entryId: string) => void;
  readonly answers: LedgerFeedAnswerActions | null;
  readonly personActorId: string | null | undefined;
  readonly personName: string;
  readonly now: number;
}): JSX.Element {
  const item = view.row.item;
  const expanded = store.getState().openIds.includes(item.entryId);
  const progress = ledgerProgressInfo(item);
  const names = namesForWorkRow(view.row, scopeNames);
  const workPath = ledgerScopeWorkPath(view.row.scope, names, {
    fallback: item.title,
    ...(onOpenScope === undefined ? {} : { onOpenScope }),
  });
  const toggle = (): void => {
    void store.getState().toggleOpen(item.entryId);
  };
  return (
    <>
      <DataTableRow
        data-testid="feed-operations-row"
        data-status={view.status}
        data-entry-id={item.entryId}
        aria-expanded={expanded}
        aria-label={item.title}
        onActivate={toggle}
        verticalAlign="top"
      >
        <DataTableCell>
          <WorkStatusLabel status={view.status} />
        </DataTableCell>
        <DataTableCell tone="primary" overflow="truncate">
          <div className="flex min-w-0 flex-col gap-1">
            <span
              data-testid="feed-operations-title"
              className={`truncate font-medium ${REPLAY_MASK_CLASS}`}
            >
              {item.title}
            </span>
            <div className={`text-xs fg-tertiary ${REPLAY_MASK_CLASS}`}>
              <WorkPath parts={workPath} />
            </div>
          </div>
        </DataTableCell>
        <DataTableCell>
          {progress.show ? (
            <ProgressDots
              statuses={progress.statuses}
              counts={progress.counts}
              testId="feed-operations-progress"
            />
          ) : null}
        </DataTableCell>
        <DataTableCell overflow="wrap">
          <DoingNowContent view={view} />
        </DataTableCell>
        <DataTableCell tone="tertiary">
          <time dateTime={view.lastActivityAt}>
            {formatLedgerRelativeTime(view.lastActivityAt, new Date(now))}
          </time>
        </DataTableCell>
      </DataTableRow>
      {expanded ? (
        <DataTableRow data-entry-id={item.entryId}>
          <DataTableCell colSpan={5} overflow="wrap">
            <WorkRowDetails
              view={view}
              store={store}
              tree={tree}
              actors={actors}
              snapshot={snapshot}
              answers={answers}
              personActorId={personActorId}
              personName={personName}
              now={now}
              closeIntent={null}
              onOpenEntry={onOpenEntry}
            />
          </DataTableCell>
        </DataTableRow>
      ) : null}
    </>
  );
}

/**
 * The open tasks under a row. The opened row's tree counts them at any depth;
 * until it loads, the row's open leaves stand in, which miss an open task whose
 * own tasks are closed.
 */
function openTaskCount(
  item: LedgerWorkRowView['row']['item'],
  tree: PanelWorkTree,
): number {
  if (tree?.status === 'ready') {
    return tree.nodes.filter(
      (node) =>
        node.entryId !== item.entryId &&
        LEDGER_OPEN_TASK_STATUSES.includes(node.status),
    ).length;
  }
  return (
    (item.leafCounts.TODO ?? 0) +
    (item.leafCounts.IN_PROGRESS ?? 0) +
    (item.leafCounts.BLOCKED ?? 0) +
    (item.leafCounts.NEEDS_REVIEW ?? 0)
  );
}

type PanelWorkTree =
  | ReturnType<LedgerFeedWorkStore['getState']>['trees'][string]
  | undefined;

function PanelWorkRowActions({
  view,
  store,
  tree,
}: {
  readonly view: LedgerWorkRowView;
  readonly store: LedgerFeedWorkStore;
  readonly tree: PanelWorkTree;
}): JSX.Element | null {
  const item = view.row.item;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isTerminal = isLedgerTerminalStatus(item.status);
  const openCount = openTaskCount(item, tree);

  const markCompleted = (): void => {
    setPending(true);
    setError(null);
    void store
      .getState()
      .markCompleted(item.entryId)
      .then((result): void => {
        if (!result.ok) setError(result.message);
      })
      .catch((): void => {
        setError("Couldn't complete this entry. Try again.");
      })
      .finally((): void => setPending(false));
  };

  const moveOutOpenTasks = (): void => {
    setPending(true);
    setError(null);
    void store
      .getState()
      .moveOutOpenTasks(item.entryId)
      .then((result): void => {
        if (!result.ok) setError(result.message);
      })
      .catch((): void => {
        setError("Couldn't move the tasks out. Try again.");
      })
      .finally((): void => setPending(false));
  };

  if (!isTerminal) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Button
          type="button"
          data-testid="feed-operations-complete"
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={markCompleted}
        >
          Mark completed
        </Button>
        <ErrorBanner
          errorSource="ledger-feed-operations"
          className=""
          error={error}
        />
      </div>
    );
  }

  if (item.type !== 'OPERATION' || openCount === 0) return null;
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-xs fg-secondary">
        {ledgerCloseIntentCopy(openCount, 'OPERATION')}
      </p>
      <Button
        type="button"
        data-testid="feed-operations-move-out"
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={moveOutOpenTasks}
      >
        Move them out
      </Button>
      <ErrorBanner
        errorSource="ledger-feed-operations"
        className=""
        error={error}
      />
    </div>
  );
}

function PanelWorkOperationRow({
  view,
  store,
  tree,
  actors,
  snapshot,
  scopeNames,
  onOpenScope,
  onOpenEntry,
  answers,
  personActorId,
  personName,
  pathRoot,
  closeIntent,
  now,
  leftOpenActions,
}: {
  readonly view: LedgerWorkRowView;
  readonly store: LedgerFeedWorkStore;
  readonly tree:
    | ReturnType<LedgerFeedWorkStore['getState']>['trees'][string]
    | undefined;
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
  readonly snapshot: LedgerLiveSnapshot | null;
  readonly scopeNames: LedgerScopeNamesFor;
  readonly onOpenScope?: (scope: LedgerViewScope) => void;
  readonly onOpenEntry?: (scope: LedgerViewScope, entryId: string) => void;
  readonly answers: LedgerFeedAnswerActions | null;
  readonly personActorId: string | null | undefined;
  readonly personName: string;
  readonly pathRoot?: LedgerViewScope;
  readonly closeIntent: LedgerFeedWorkCloseIntent | null;
  readonly now: number;
  readonly leftOpenActions?: LedgerFeedOperationsLeftOpenActions;
}): JSX.Element {
  const item = view.row.item;
  const expanded = store.getState().openIds.includes(item.entryId);
  const canTakeIt =
    item.owner.kind === 'user' || item.owner.actorId === personActorId;
  const leftOpenShown = useLedgerLeftOpenShown(
    leftOpenActions === undefined ? undefined : item.leftOpen,
    item.owner.kind,
    snapshot?.agents[item.owner.actorId],
  );
  const [leftOpenOptions, setLeftOpenOptions] = useState(false);
  const progress = ledgerProgressInfo(item);
  const names = namesForWorkRow(view.row, scopeNames);
  const workPath = ledgerScopeWorkPath(view.row.scope, names, {
    fallback: item.title,
    ...(onOpenScope === undefined ? {} : { onOpenScope }),
    ...(pathRoot === undefined ? {} : { root: pathRoot }),
  });
  const toggle = (): void => {
    void store.getState().toggleOpen(item.entryId);
  };

  return (
    <li
      data-testid="feed-operations-row"
      data-layout="panel"
      data-status={view.status}
      data-entry-id={item.entryId}
      className="flex flex-col gap-2 border-b border-line-base px-3 py-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        {/* Centred on the title's 32px row. */}
        <span className="flex h-8 shrink-0 items-center">
          <StatusGlyph
            state={LEDGER_WORK_STATUS_GLYPHS[view.status]}
            size={14}
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <ListRow
              data-testid="feed-operations-title"
              aria-expanded={expanded}
              onClick={toggle}
              className="flex-1"
              trailing={
                <ChevronRightMediumIcon
                  size={16}
                  aria-hidden="true"
                  className={`transition-transform duration-150 motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
                />
              }
            >
              <span className={`font-medium ${REPLAY_MASK_CLASS}`}>
                {item.title}
              </span>
            </ListRow>
            {progress.show ? (
              <ProgressDots
                statuses={progress.statuses}
                counts={progress.counts}
                testId="feed-operations-progress"
              />
            ) : null}
            {leftOpenShown && item.leftOpen !== undefined ? (
              <LedgerLeftOpenTrigger
                leftOpen={item.leftOpen}
                now={now}
                open={leftOpenOptions}
                onToggle={(): void => setLeftOpenOptions((open) => !open)}
                testId="feed-operations-left-open"
              />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs fg-secondary">
              {LEDGER_WORK_STATUS_LABELS[view.status]}
            </span>
            <DoingNowContent view={view} />
          </div>
          {workPath.length === 0 ? null : (
            <div className={`text-xs fg-tertiary ${REPLAY_MASK_CLASS}`}>
              <WorkPath parts={workPath} />
            </div>
          )}
        </div>
      </div>
      {leftOpenActions === undefined ||
      item.leftOpen === undefined ||
      !leftOpenShown ||
      !leftOpenOptions ? null : (
        <div className={ownerReplayClass(item.owner)}>
          <LedgerLeftOpenNote
            leftOpen={item.leftOpen}
            now={now}
            ownerName={ownerName(item.owner, actors, personActorId, personName)}
            ownerActorId={item.owner.actorId}
            candidates={leftOpenActions.candidates}
            ownersStatus={leftOpenActions.ownersStatus}
            onLoadOwners={leftOpenActions.loadOwners}
            onHandTo={(owner) =>
              leftOpenActions.assignOwner(view.row.scope, item.entryId, owner)
            }
            onTakeIt={() =>
              leftOpenActions.assignOwner(view.row.scope, item.entryId, null)
            }
            onClose={() => store.getState().markCompleted(item.entryId)}
            takeItDisabled={canTakeIt}
            testId="feed-operations-left-open"
          />
        </div>
      )}
      {closeIntent?.origin === 'row' && closeIntent.entryId === item.entryId ? (
        <LedgerCloseIntentPrompt
          openCount={closeIntent.openCount}
          openCountIsLowerBound={closeIntent.openCountIsLowerBound}
          kind={item.type === 'OPERATION' ? 'OPERATION' : 'TASK'}
          onChoose={(choice) => store.getState().resolveCloseIntent(choice)}
        />
      ) : null}
      {expanded ? (
        <div className="flex flex-col gap-3">
          <WorkRowDetails
            view={view}
            store={store}
            tree={tree}
            actors={actors}
            snapshot={snapshot}
            answers={answers}
            personActorId={personActorId}
            personName={personName}
            now={now}
            leftOpenActions={leftOpenActions}
            closeIntent={closeIntent}
            onOpenEntry={onOpenEntry}
          />
          <PanelWorkRowActions view={view} store={store} tree={tree} />
        </div>
      ) : null}
    </li>
  );
}

/** The panel shows this many Operations rows, and this many more each time. */
const LEDGER_PANEL_WORK_PAGE_SIZE = 20;

export function LedgerFeedOperations({
  store,
  snapshot,
  scopeNames,
  onOpenScope,
  answers,
  personActorId,
  personName,
  now,
  onOpenEntry,
  layout = 'page',
  pathRoot,
  leftOpenActions,
  hideWhenEmpty = false,
  rootChat = null,
}: LedgerFeedOperationsProps): JSX.Element | null {
  const state = useStore(store);
  // A busy task can hold hundreds of top-level tasks; the panel renders them
  // a page at a time, as Activity does.
  const [panelRowLimit, setPanelRowLimit] = useState(
    LEDGER_PANEL_WORK_PAGE_SIZE,
  );
  const views = useMemo(
    () =>
      deriveWorkRowViews(
        rootChat === null
          ? state.work.rows
          : state.work.rows.filter((row) =>
              ledgerWorkRowMatchesRootChat(
                row,
                rootChat,
                state.work.actorHosts,
              ),
            ),
        state.actors,
        snapshot,
      ),
    [rootChat, state.actors, state.work.actorHosts, state.work.rows, snapshot],
  );
  // Counts take every row, older ones included; the list leaves older rows
  // out until the person shows them.
  const counts = useMemo(() => ledgerWorkStatusCounts(views), [views]);
  const filtered = useMemo(
    () => filterWorkRowViews(views, state.statusFilter),
    [state.statusFilter, views],
  );
  const olderInFilter = filtered.filter(
    (view) => view.row.older === true,
  ).length;
  const listed = useMemo(
    () =>
      state.olderShown
        ? filtered
        : filtered.filter((view) => view.row.older !== true),
    [filtered, state.olderShown],
  );
  const sorted = useMemo(
    () => sortWorkRowViews(listed, state.sort),
    [listed, state.sort],
  );
  const operationRows = sorted.filter((view) => view.group === 'operation');
  const noOperationRows = sorted.filter(
    (view) => view.group === 'no_operation',
  );
  const visibleRows = [...operationRows, ...noOperationRows];
  const panelOperationRows = operationRows.slice(0, panelRowLimit);
  const panelNoOperationRows = noOperationRows.slice(
    0,
    Math.max(0, panelRowLimit - operationRows.length),
  );
  const panelHiddenCount = Math.max(0, visibleRows.length - panelRowLimit);
  const showOlderControls = olderInFilter > 0;
  const loadingFirstPage =
    !state.work.settled &&
    (state.work.status === 'idle' || state.work.status === 'loading');
  const workProblem = state.work.problem;
  const initialProblem = !state.work.settled && workProblem !== null;
  const workProblemCopy =
    workProblem === null ? null : problemCopy(workProblem, 'list');

  const toggleSort = (column: LedgerWorkSortColumn): void => {
    state.toggleSort(column);
  };
  const sortDirection = (
    column: LedgerWorkSortColumn,
  ): 'asc' | 'desc' | null =>
    state.sort.column === column ? state.sort.direction : null;

  const renderPanelRow = (view: LedgerWorkRowView): JSX.Element => (
    <PanelWorkOperationRow
      key={view.key}
      view={view}
      store={store}
      tree={state.trees[view.row.item.entryId]}
      actors={state.actors}
      snapshot={snapshot}
      scopeNames={scopeNames}
      onOpenScope={onOpenScope}
      onOpenEntry={onOpenEntry}
      answers={answers}
      personActorId={personActorId}
      personName={personName}
      pathRoot={pathRoot}
      closeIntent={state.closeIntent}
      now={now}
      leftOpenActions={leftOpenActions}
    />
  );

  if (hideWhenEmpty && views.length === 0 && workProblem === null) return null;

  return (
    <section data-testid="feed-operations" className="flex flex-col gap-3">
      <FeedSectionHeading
        title="Operations"
        count={views.length}
        testId="feed-operations-heading"
      />
      <StatusCounts
        items={LEDGER_WORK_STATUSES.map((status) => ({
          status,
          label: LEDGER_WORK_STATUS_LABELS[status],
          count: counts[status],
        }))}
        total={LEDGER_WORK_STATUSES.reduce(
          (sum, status) => sum + counts[status],
          0,
        )}
        selected={state.statusFilter}
        onSelect={(status): void => state.setStatusFilter(status)}
        testId="feed-status-counts"
      />
      {state.work.truncated ? (
        <p
          data-testid="feed-operations-truncated"
          className="text-xs fg-tertiary"
        >
          Showing the first 1,000 operations and tasks.
        </p>
      ) : null}
      {workProblemCopy === null ? null : (
        <ErrorBanner
          errorSource="feed-operations-problem"
          className=""
          error={workProblemCopy.message}
          testId="feed-operations-problem"
          {...(workProblemCopy.retry
            ? {
                onRetry: (): void =>
                  void store.getState().load({ refresh: true }),
              }
            : {})}
        />
      )}
      {loadingFirstPage ? (
        <DelayedLoadingPlaceholder slowNote="Still loading operations…">
          <CenteredLoadingSpinner />
        </DelayedLoadingPlaceholder>
      ) : initialProblem ? null : visibleRows.length === 0 ? (
        <EmptyState
          testId="feed-operations-empty"
          title={
            olderInFilter > 0
              ? state.statusFilter === null
                ? 'No recent operations.'
                : 'No recent matching operations.'
              : state.statusFilter === null
                ? 'No operations yet.'
                : 'No matching operations.'
          }
          tone="quiet"
          inset="none"
        />
      ) : layout === 'panel' ? (
        <div
          className="flex flex-col"
          data-testid="feed-operations-list-region"
        >
          <ul
            role="list"
            aria-label="Operations"
            data-testid="feed-operations-list"
            className="m-0 list-none p-0"
          >
            {panelOperationRows.map(renderPanelRow)}
          </ul>
          {panelNoOperationRows.length === 0 ? null : (
            <section aria-labelledby="feed-operations-no-operation">
              <div className="px-3 py-2">
                <Heading
                  level={3}
                  variant="label"
                  id="feed-operations-no-operation"
                  data-testid="feed-operations-no-operation"
                >
                  No operation
                </Heading>
              </div>
              <ul
                role="list"
                aria-label="No operation"
                className="m-0 list-none p-0"
              >
                {panelNoOperationRows.map(renderPanelRow)}
              </ul>
            </section>
          )}
          {panelHiddenCount === 0 ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              data-testid="feed-operations-show-more"
              aria-label={`Show more operations and tasks (${panelHiddenCount} remaining)`}
              onClick={(): void =>
                setPanelRowLimit((limit) => limit + LEDGER_PANEL_WORK_PAGE_SIZE)
              }
            >
              {`Show more (${panelHiddenCount})`}
            </Button>
          )}
        </div>
      ) : (
        <DataTableFrame
          caption="Operations"
          layout="fixed"
          minWidth="47.5rem"
          testId="feed-operations-table-region"
        >
          <DataTableHead>
            <DataTableHeaderCell
              width="9rem"
              sort={{
                direction: sortDirection('status'),
                onToggle: (): void => toggleSort('status'),
                testId: 'feed-sort-status',
              }}
            >
              Status
            </DataTableHeaderCell>
            <DataTableHeaderCell
              width="30%"
              sort={{
                direction: sortDirection('operation'),
                onToggle: (): void => toggleSort('operation'),
                testId: 'feed-sort-operation',
              }}
            >
              Operation
            </DataTableHeaderCell>
            <DataTableHeaderCell
              width="10rem"
              sort={{
                direction: sortDirection('progress'),
                onToggle: (): void => toggleSort('progress'),
                testId: 'feed-sort-progress',
              }}
            >
              Progress
            </DataTableHeaderCell>
            <DataTableHeaderCell>Doing now</DataTableHeaderCell>
            <DataTableHeaderCell
              width="9rem"
              sort={{
                direction: sortDirection('lastActivity'),
                onToggle: (): void => toggleSort('lastActivity'),
                testId: 'feed-sort-lastActivity',
              }}
            >
              Last activity
            </DataTableHeaderCell>
          </DataTableHead>
          <DataTableBody>
            {operationRows.map((view) => (
              <WorkOperationRow
                key={view.key}
                view={view}
                store={store}
                tree={state.trees[view.row.item.entryId]}
                actors={state.actors}
                snapshot={snapshot}
                scopeNames={scopeNames}
                onOpenScope={onOpenScope}
                onOpenEntry={onOpenEntry}
                answers={answers}
                personActorId={personActorId}
                personName={personName}
                now={now}
              />
            ))}
          </DataTableBody>
          {noOperationRows.length === 0 ? null : (
            <DataTableBody>
              <DataTableRow data-testid="feed-operations-no-operation">
                <DataTableCell colSpan={5} rowHeader>
                  No operation
                </DataTableCell>
              </DataTableRow>
              {noOperationRows.map((view) => (
                <WorkOperationRow
                  key={view.key}
                  view={view}
                  store={store}
                  tree={state.trees[view.row.item.entryId]}
                  actors={state.actors}
                  snapshot={snapshot}
                  scopeNames={scopeNames}
                  onOpenScope={onOpenScope}
                  onOpenEntry={onOpenEntry}
                  answers={answers}
                  personActorId={personActorId}
                  personName={personName}
                  now={now}
                />
              ))}
            </DataTableBody>
          )}
        </DataTableFrame>
      )}
      {showOlderControls ? (
        <div className="flex justify-start">
          <Button
            type="button"
            data-testid="feed-show-older"
            size="sm"
            variant="ghost"
            onClick={(): void =>
              state.olderShown
                ? store.getState().hideOlder()
                : store.getState().showOlder()
            }
          >
            {state.olderShown ? 'Hide older' : `Show ${olderInFilter} older`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
