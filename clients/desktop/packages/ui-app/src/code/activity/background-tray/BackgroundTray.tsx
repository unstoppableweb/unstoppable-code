'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import {
  AgentStateGlyph,
  Button,
  ComposerDrawerSection,
  Count,
  Dot,
  OverlayScrollArea,
  SubagentViewTreeAction,
  Tooltip,
  type DotTone,
  type SubagentChatTarget,
} from '@canopy/ui-shared/components';
import { PipelineIcon } from '@canopy/ui-shared/icons';
import {
  AgentIcon,
  ChevronDownIcon,
  ChevronTopMediumIcon,
  GitHubIcon,
  GitPullRequestIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { isTerminalBackgroundProcessStatus } from '@canopy/ui-shared/lib';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';
import type { BackgroundTaskHostActions } from '../background-tasks-section';
import { BackgroundTaskDetailModal } from '../BackgroundTaskDetailModal';
import { StopAllBackgroundWorkControl } from '../../agent-activity/StopAllBackgroundWorkControl';
import { StopAllDelegatesControl } from '../../agent-activity/StopAllDelegatesControl';
import { AgentRow, type BackgroundTrayAgent } from './AgentRow';
import { GROUP_LABEL_PX, useDrawerClock } from './drawer-layout';
import { runCornerDot, summarizeDrawer } from './drawer-summary';
import { DrawerRow } from './DrawerRow';
import { DRAWER_ROW_LIST_CLASS } from './drawer-presentation';
import {
  RUN_STATUS_LABELS,
  RunRow,
  type BackgroundTrayRun,
  type BackgroundTrayRunKind,
} from './RunRow';
import { TASK_KIND_GLYPHS, TaskRow } from './TaskRow';
import {
  WatcherRow,
  type BackgroundTrayWatcher,
  type DeleteBackgroundTrayWatcher,
} from './WatcherRow';
export type {
  BackgroundTrayWatcher,
  DeleteBackgroundTrayWatcher,
} from './WatcherRow';
import {
  CompletedWorkDialog,
  CompletedWorkTrigger,
} from './CompletedWorkDialog';
import {
  ComposerWorkDrawer,
  type ComposerWorkDrawerSections,
} from '../../ComposerWorkDrawer';

export type {
  BackgroundTrayRun,
  BackgroundTrayRunDag,
  BackgroundTrayRunKind,
  BackgroundTrayRunStatus,
} from './RunRow';

export interface BackgroundTrayProps {
  readonly chatId: string;
  /** The chat's background tasks; finished ones are not listed. */
  readonly tasks: readonly BackgroundTask[];
  /**
   * What the host can do with them: Stop, the detail modal and its output,
   * workflow progress. Absent, or a missing member, removes that control.
   */
  readonly taskActions?: BackgroundTaskHostActions;
  /**
   * The chat's live background subagents: Claude and Codex native agents and
   * managed delegates. A Claude agent's own task (`taskId`) is listed once,
   * as the agent.
   */
  readonly agents?: readonly BackgroundTrayAgent[];
  /**
   * Live or queued background delegates the host counts but cannot list
   * (the Portal's transcript window may not reach an old delegate's card).
   */
  readonly unlistedDelegations?: number;
  /**
   * The live runs the chat follows: pipeline runs, and GitHub runs its
   * watchers follow. Finished runs stay listed until dismissed, so the host
   * passes only runs it saw running and has not dismissed.
   */
  readonly runs?: readonly BackgroundTrayRun[];
  readonly watchers?: readonly BackgroundTrayWatcher[];
  readonly onDeleteWatcher?: DeleteBackgroundTrayWatcher;
  /** Opens a subagent's chat; absent, agent inspectors offer no Open chat. */
  readonly onOpenAgent?: (target: SubagentChatTarget) => void;
  /** Stops one delegate; resolves `true` once the host accepted it. */
  readonly onStopAgent?: (agent: BackgroundTrayAgent) => Promise<boolean>;
  /** Opens the chat's subagent tree; offered while agents are listed. */
  readonly onViewTree?: () => void;
  /**
   * Stops every delegation; resolves `true` once the host accepted it.
   * Offered while two or more delegates are listed.
   */
  readonly onStopAllDelegations?: () => Promise<boolean>;
  /**
   * Stops every live background task and agent of the chat, as the host's
   * backend resolves them (security B6); resolves `true` once accepted.
   * Offered while two or more of the listed items can stop.
   */
  readonly onStopAllBackgroundWork?: () => Promise<boolean>;
  readonly onStopRun?: (runId: string) => void;
  /** Opens a run waiting for input, where the user answers it. */
  readonly onRespondRun?: (runId: string) => void;
  readonly onResumeRun?: (runId: string) => void;
  readonly onDismissRun?: (runId: string) => void;
  /** Opens a run: its detail, or a GitHub run's page; absent, no Open run. */
  readonly onOpenRun?: (runId: string) => void;
  readonly onOpenGitHubRun?: (runId: string) => void;
  /** Opens one job from the run inspector's job bar. */
  readonly onRunJobClick?: (runId: string, jobId: string) => void;
  /** The run's watcher button, in its inspector. */
  readonly renderRunWatcher?: (run: BackgroundTrayRun) => ReactNode;
  /**
   * `drawer` (default): its own section of the composer drawer, a summary
   * line that opens the list. `tab`: only the list, always open. `grouped`:
   * the composer work pills (`ComposerWorkDrawer`), with `composerQueue` as
   * the Queued pill.
   */
  readonly presentation?: 'drawer' | 'tab' | 'grouped';
  readonly composerQueue?: {
    readonly count: number;
    readonly panel: ReactNode;
  };
  /** Wrap the list while retaining its detail owner outside conditional panels. */
  readonly renderWithDetails?: (
    list: ReactNode,
    details: ReactNode,
    sections: ComposerWorkDrawerSections,
  ) => ReactNode;
}

const KIND_ORDER: readonly BackgroundTask['kind'][] = [
  'agent',
  'bash',
  'workflow',
  'task',
];

const KIND_LABELS: Record<BackgroundTask['kind'], string> = {
  agent: 'Agents',
  bash: 'Commands',
  workflow: 'Workflows',
  task: 'Tasks',
};

const RUN_KIND_LABELS: Record<BackgroundTrayRunKind, string> = {
  pipeline: 'Pipeline runs',
  github: 'GitHub runs',
  'github-pr': 'Pull requests',
};

/**
 * The leading dot while nothing runs: the most pressing state first. A
 * succeeded run you have not seen is a new result, so it takes `unread` like
 * other unseen results (`success` is for live connections).
 */
const DOT_TONES = {
  'needs-input': 'attention',
  failed: 'danger',
  cancelled: 'filter',
  completed: 'filter',
  succeeded: 'unread',
} as const satisfies Record<string, DotTone>;

const DOT_LABELS = {
  'needs-input': 'Needs input',
  failed: 'A run failed',
  cancelled: 'A run was cancelled',
  completed: 'Runs finished',
  succeeded: 'Runs finished',
} as const;

type TrayGroup = 'needs-you' | 'running' | 'watching' | 'finished';

const NO_AGENTS: readonly BackgroundTrayAgent[] = [];

/** `N delegates`, or `N more delegates` beside listed agents. */
function unlistedDelegatesLabel(count: number, listed: number): string {
  const noun = count === 1 ? 'delegate' : 'delegates';
  return listed > 0 ? `${count} more ${noun}` : `${count} ${noun}`;
}

const GROUP_LABELS: Record<TrayGroup, string> = {
  'needs-you': 'Needs you',
  running: 'Running',
  watching: 'Watching',
  finished: 'Finished',
};

/**
 * The composer's background drawer (D5, D6, D7, D10): a section of the
 * composer's `ComposerDrawer` while the chat has background work, absent
 * otherwise. Collapsed, it is one line: a leading glyph, a summary in
 * priority order and one icon per kind of work, each with its count and a
 * hover breakdown. The summary and the chevron both toggle it. Expanded, the
 * list opens under that line in groups (Needs you, Running, Finished) with
 * sticky labels, and scrolls past its cap; a row opens its inspector in
 * place, one at a time, and the header offers View tree, Stop all
 * delegates and Stop all background work. Esc closes it. Hosts supply the items; a host without the data
 * passes none.
 */
export function BackgroundTray({
  chatId,
  tasks,
  taskActions,
  agents = NO_AGENTS,
  unlistedDelegations = 0,
  runs = [],
  watchers = [],
  onDeleteWatcher,
  onOpenAgent,
  onStopAgent,
  onViewTree,
  onStopAllDelegations,
  onStopAllBackgroundWork,
  onStopRun,
  onRespondRun,
  onResumeRun,
  onDismissRun,
  onOpenRun,
  onOpenGitHubRun,
  onRunJobClick,
  renderRunWatcher,
  presentation = 'drawer',
  composerQueue,
  renderWithDetails,
}: BackgroundTrayProps): JSX.Element | null {
  const grouped = presentation === 'grouped';
  const tab = presentation === 'tab' || grouped;
  const [expandedState, setExpanded] = useState(false);
  // In a tab the list is the whole surface, so it is always open.
  const expanded = grouped ? expandedState : tab || expandedState;
  // One inspector at a time, by row key: opening a row closes the open one.
  const [inspectedKey, setInspectedKey] = useState<string | null>(null);
  const [completedInspectedKeys, setCompletedInspectedKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [completedChatId, setCompletedChatId] = useState<string | null>(null);
  const completedRestoreFocusRef = useRef<HTMLElement | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const listId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [listVisible, setListVisible] = useState(false);
  const setListRef = useCallback((node: HTMLDivElement | null): void => {
    listRef.current = node;
    setListVisible(node !== null);
  }, []);
  // The detail owner survives closed tabs, but hidden rows need no clock.
  const now = useDrawerClock(
    tasks.length + agents.length + runs.length > 0 &&
      expanded &&
      listVisible &&
      (!renderWithDetails || expandedState),
  );
  // A Claude agent's task is listed once, as its agent.
  const agentTaskIds = new Set(agents.map((agent) => agent.taskId));
  const live = tasks.filter(
    (task) =>
      !isTerminalBackgroundProcessStatus(task.status) &&
      !agentTaskIds.has(task.id),
  );
  const detailTask =
    detailTaskId === null
      ? null
      : (tasks.find((task) => task.id === detailTaskId) ?? null);
  const onSelectedTaskChange = taskActions?.onSelectedTaskChange;
  // A task that leaves takes its open modal with it.
  useEffect(() => {
    if (detailTaskId !== null && detailTask === null) {
      setDetailTaskId(null);
      onSelectedTaskChange?.(null);
    }
  }, [detailTask, detailTaskId, onSelectedTaskChange]);

  const {
    text: workSummary,
    running,
    approvalAgents,
    runningAgents,
    needsInputRuns,
    pausedRuns,
    runningRuns,
    finishedRuns,
    dot,
    labelled,
  } = summarizeDrawer(live, agents, runs, unlistedDelegations);
  const summary = [
    workSummary,
    watchers.length > 0 ? `${watchers.length} watching` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // PR lifecycle history belongs to Pull requests, not completed work.
  const completedRuns = finishedRuns.filter((run) => run.kind !== 'github-pr');
  if (
    completedChatId !== null &&
    (completedChatId !== chatId || completedRuns.length === 0)
  )
    setCompletedChatId(null);
  const openDetail = taskActions?.getDetail
    ? (task: BackgroundTask): void => {
        setDetailTaskId(task.id);
        onSelectedTaskChange?.(task);
      }
    : undefined;
  const closeDetail = (): void => {
    setDetailTaskId(null);
    onSelectedTaskChange?.(null);
  };
  const detailModal = detailTask && (
    <BackgroundTaskDetailModal
      task={detailTask}
      actions={taskActions}
      onClose={closeDetail}
    />
  );
  const renderSurface = (surface: ReactNode): JSX.Element => (
    <>
      {renderWithDetails ? (
        renderWithDetails(surface, detailModal, groupedSections)
      ) : (
        <>
          {surface}
          {detailModal}
        </>
      )}
      {tab && completedModal}
    </>
  );
  // Labels show once more than one group has work; revealed rows clear them.
  const topInset = tab ? 0 : labelled ? GROUP_LABEL_PX : 0;
  // An inspector whose item left the list is closed, and stays closed if
  // the item comes back.
  const openKey =
    inspectedKey !== null &&
    (live.some((task) => `task:${task.id}` === inspectedKey) ||
      agents.some((agent) => `agent:${agent.id}` === inspectedKey) ||
      runs.some((run) => `run:${run.id}` === inspectedKey) ||
      watchers.some((watcher) => `watcher:${watcher.id}` === inspectedKey))
      ? inspectedKey
      : null;
  if (inspectedKey !== null && openKey === null) setInspectedKey(null);
  const toggleRow = (key: string): void =>
    setInspectedKey((current) => (current === key ? null : key));
  const agentRow = (agent: BackgroundTrayAgent): JSX.Element => (
    <AgentRow
      key={agent.id}
      agent={agent}
      task={tasks.find((task) => task.id === agent.taskId)}
      taskActions={taskActions}
      now={now}
      open={openKey === `agent:${agent.id}`}
      onToggle={(): void => toggleRow(`agent:${agent.id}`)}
      onOpen={onOpenAgent}
      onStop={onStopAgent}
      listRef={listRef}
      topInset={topInset}
    />
  );
  const delegateIds = agents.flatMap((agent) =>
    agent.kind === 'delegate' ? [agent.id] : [],
  );
  const delegates = delegateIds.length;
  // What Stop all background work covers: the listed tasks and agents the
  // host can stop. Delegates keep their own Stop all.
  const stoppableIds = [
    ...live.flatMap((task) =>
      task.canStop && taskActions?.stopTarget?.(task) ? [task.id] : [],
    ),
    ...agents.flatMap((agent) => {
      const task = tasks.find((candidate) => candidate.id === agent.taskId);
      return task !== undefined &&
        !isTerminalBackgroundProcessStatus(task.status) &&
        task.canStop &&
        taskActions?.stopTarget?.(task)
        ? [task.id]
        : [];
    }),
  ];

  const renderRunRow = (
    run: BackgroundTrayRun,
    open: boolean,
    onToggle: (key: string) => void,
    closeCompletedHistory = false,
  ): JSX.Element => {
    const openRun =
      run.kind === 'pipeline' ? onOpenRun : (onOpenGitHubRun ?? onOpenRun);
    return (
      <RunRow
        key={run.id}
        run={run}
        now={now}
        open={open}
        onToggle={(): void => onToggle(`run:${run.id}`)}
        onStop={onStopRun}
        onRespond={onRespondRun}
        onResume={onResumeRun}
        onDismiss={onDismissRun}
        onOpen={
          closeCompletedHistory && openRun
            ? (runId): void => {
                setCompletedChatId(null);
                openRun(runId);
              }
            : openRun
        }
        onJobClick={
          closeCompletedHistory && onRunJobClick
            ? (runId, jobId): void => {
                setCompletedChatId(null);
                onRunJobClick(runId, jobId);
              }
            : onRunJobClick
        }
        renderWatcher={renderRunWatcher}
        listRef={listRef}
        topInset={topInset}
      />
    );
  };
  const runRow = (run: BackgroundTrayRun): JSX.Element =>
    renderRunRow(run, openKey === `run:${run.id}`, toggleRow);
  const toggleCompletedRow = (key: string): void =>
    setCompletedInspectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const executionRows: ReactNode[] = [
    ...runningAgents.map(agentRow),
    ...(unlistedDelegations > 0
      ? [
          <DrawerRow
            key="unlisted-delegates"
            rowKey="unlisted-delegates"
            testId="background-tray-unlisted-delegates"
            glyph={<AgentIcon size={14} aria-hidden="true" />}
            name={unlistedDelegatesLabel(unlistedDelegations, delegates)}
            listRef={listRef}
            topInset={topInset}
          />,
        ]
      : []),
    ...live.map((task) => (
      <TaskRow
        key={task.id}
        task={task}
        actions={taskActions}
        now={now}
        open={openKey === `task:${task.id}`}
        onToggle={(): void => toggleRow(`task:${task.id}`)}
        onOpenDetail={openDetail}
        listRef={listRef}
        topInset={topInset}
      />
    )),
    ...runningRuns.filter((run) => run.kind === 'pipeline').map(runRow),
  ];
  const watcherRows = watchers.map((watcher) => (
    <WatcherRow
      key={`${chatId}:${watcher.id}`}
      watcher={watcher}
      open={openKey === `watcher:${watcher.id}`}
      onToggle={(): void => toggleRow(`watcher:${watcher.id}`)}
      onDelete={onDeleteWatcher}
      listRef={listRef}
    />
  ));
  const groups: ReadonlyArray<{ group: TrayGroup; rows: ReactNode[] }> = [
    {
      group: 'needs-you' as const,
      rows: [
        ...approvalAgents.map(agentRow),
        ...needsInputRuns.map(runRow),
        ...pausedRuns.map(runRow),
      ],
    },
    {
      group: 'running' as const,
      rows: [
        ...executionRows,
        ...runningRuns.filter((run) => run.kind !== 'pipeline').map(runRow),
      ],
    },
    { group: 'watching' as const, rows: watcherRows },
    { group: 'finished' as const, rows: finishedRuns.map(runRow) },
  ].filter(({ rows }) => rows.length > 0);
  const toggle = (): void => setExpanded((open) => !open);
  // Esc closes the open list and goes no further. Caught in the capture
  // phase, because row actions stop their keydowns from bubbling; focus
  // returns to the toggle, since the focused row goes away. An open detail
  // modal keeps its own Esc, even with focus still on its Open button.
  // A tab has no list to close, so Esc stays with the composer.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (tab || event.key !== 'Escape' || !expanded || detailTask !== null)
      return;
    event.preventDefault();
    event.stopPropagation();
    setExpanded(false);
    toggleRef.current?.focus();
  };

  const viewTree = agents.length > 0 && onViewTree && (
    <SubagentViewTreeAction
      onClick={onViewTree}
      appearance={tab ? 'section' : 'default'}
      dataTestId="background-tray-view-tree"
    />
  );
  const stopAll = delegateIds.length >= 2 && onStopAllDelegations && (
    // Keyed by chat: a Stop all question asked about one chat must not
    // survive into another chat's drawer.
    <StopAllDelegatesControl
      key={chatId}
      appearance={tab ? 'section' : 'default'}
      liveDelegationIds={delegateIds}
      onStopAll={onStopAllDelegations}
      testId="background-tray-stop-all"
    />
  );
  const stopAllWork = stoppableIds.length >= 2 && onStopAllBackgroundWork && (
    <StopAllBackgroundWorkControl
      key={chatId}
      appearance={tab ? 'section' : 'default'}
      liveTaskIds={stoppableIds}
      onStopAll={onStopAllBackgroundWork}
    />
  );
  const watchingRuns = runningRuns.filter((run) => run.kind === 'github');
  const pullRequests = runs.filter((run) => run.kind === 'github-pr');
  const completedModal = (
    <CompletedWorkDialog
      count={completedRuns.length}
      shown={completedChatId === chatId}
      expandedKeys={completedInspectedKeys}
      restoreFocusRef={completedRestoreFocusRef}
      onClose={(): void => setCompletedChatId(null)}
    >
      {completedRuns.map((run) =>
        renderRunRow(
          run,
          completedInspectedKeys.has(`run:${run.id}`),
          toggleCompletedRow,
          true,
        ),
      )}
    </CompletedWorkDialog>
  );
  const groupedSections: ComposerWorkDrawerSections = {
    viewportRef: setListRef,
    onExpandedChange: setExpanded,
    needsYou:
      needsInputRuns.length + pausedRuns.length + approvalAgents.length > 0 ? (
        <ul className={DRAWER_ROW_LIST_CLASS}>
          {groups.find(({ group }) => group === 'needs-you')?.rows}
        </ul>
      ) : null,
    running:
      executionRows.length > 0 ? (
        <ul className={DRAWER_ROW_LIST_CLASS}>{executionRows}</ul>
      ) : null,
    watching:
      watchingRuns.length + watchers.length > 0 ? (
        <ul className={DRAWER_ROW_LIST_CLASS}>
          {watchingRuns.map(runRow)}
          {watcherRows}
        </ul>
      ) : null,
    pullRequests:
      pullRequests.length > 0 ? (
        <ul className={DRAWER_ROW_LIST_CLASS}>{pullRequests.map(runRow)}</ul>
      ) : null,
    completed:
      completedRuns.length > 0 ? (
        <CompletedWorkTrigger
          count={completedRuns.length}
          restoreFocusRef={completedRestoreFocusRef}
          onOpen={(): void => {
            setCompletedInspectedKeys(new Set());
            setCompletedChatId(chatId);
          }}
        />
      ) : null,
    controls: (
      <span className="inline-flex items-center gap-0">
        {viewTree}
        {stopAll}
        {stopAllWork}
      </span>
    ),
  };
  const counts = backgroundTrayCounts({
    tasks,
    agents,
    runs,
    watchers,
    unlistedDelegations,
  });
  if (grouped)
    return renderSurface(
      <ComposerWorkDrawer
        queuedCount={composerQueue?.count ?? 0}
        queuedPanel={composerQueue?.panel}
        background={{
          count: counts.items,
          needsYou: counts.needsYou,
          running: counts.running,
          watching: counts.watching,
          pullRequests: counts.pullRequests,
          sections: groupedSections,
          viewportRef: setListRef,
          onExpandedChange: setExpanded,
        }}
      />,
    );
  const list = (
    <OverlayScrollArea
      // The list's cap (D10), as a variable the inspectors' caps subtract
      // from (drawer-layout.tsx). A tab sits under the drawer's tab row, so
      // its list stops lower.
      className={
        tab
          ? '[--background-drawer-list-max:min(16.75rem,35vh)]'
          : 'mt-1 [--background-drawer-list-max:min(22rem,45vh)]'
      }
      viewportClassName="max-h-[var(--background-drawer-list-max)] overflow-x-hidden"
      viewportRef={setListRef}
      viewportProps={{
        id: listId,
        'data-testid': 'background-tray-rows',
      }}
      // In a tab the bottom fade waits 2px and stays short, so the last row
      // ends on the drawer's edge rather than fading into the composer.
      edgeFadeSize={tab ? 6 : 16}
      edgeFadeTopSize={tab ? 16 : undefined}
      edgeFadeBottomInset={tab ? 2 : undefined}
      // Rows fade as they pass under the sticky label, not the label.
      edgeFadeTopInset={topInset}
    >
      <div className={tab ? 'flex flex-col gap-2 pb-1' : 'flex flex-col'}>
        {tab && (viewTree || stopAll || stopAllWork) && (
          // The tab row has no room for the header's actions; they lead
          // the list instead.
          <div className="flex h-9 items-center justify-end pr-1">
            {viewTree}
            {stopAll}
            {stopAllWork}
          </div>
        )}
        {groups.map(({ group, rows }) => (
          // Each label sticks within its own group, so the next group's
          // label pushes it out, as the sidebar's section headers do.
          <section
            key={group}
            aria-label={GROUP_LABELS[group]}
            className="flex flex-col"
            data-tray-group={group}
          >
            {(labelled || group === 'watching') && (
              <p
                className="sticky top-0 z-10 flex h-7 items-end bg-depth px-2.75 pb-1 text-s fg-tertiary"
                data-testid="background-tray-group-label"
              >
                {GROUP_LABELS[group]}
              </p>
            )}
            <ul className="flex flex-col">{rows}</ul>
          </section>
        ))}
      </div>
    </OverlayScrollArea>
  );

  if (tab) {
    return renderSurface(
      summary !== '' ? (
        <div
          className="flex min-w-0 flex-col"
          data-testid="background-tray"
          data-expanded
          data-presentation="tab"
        >
          {list}
        </div>
      ) : null,
    );
  }

  // The drawer leaves once nothing runs; a task's open modal stays, in the
  // same place so it keeps its stream through the flush window.
  return renderSurface(
    summary !== '' ? (
      <ComposerDrawerSection>
        <div
          className="flex min-w-0 flex-col text-s"
          data-testid="background-tray"
          data-expanded={expanded}
          // While open the drawer owns Esc: the desktop's capture-phase
          // cancel-turn shortcut skips targets inside this marker.
          data-chat-cancel-shortcut-ignore={expanded ? 'true' : undefined}
          onKeyDownCapture={onKeyDownCapture}
        >
          <div className="flex h-7 min-w-0 items-center gap-1">
            <button
              type="button"
              className="focus-ring flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-xl pl-1 pr-2 text-left hover:bg-fg-primary/[0.04]"
              aria-expanded={expanded}
              aria-controls={expanded ? listId : undefined}
              onClick={toggle}
              data-testid="background-tray-header"
            >
              <span className="flex h-7 w-6 shrink-0 items-center justify-center">
                {dot === null ? (
                  <AgentStateGlyph
                    state="background"
                    backgroundTasks={running}
                  />
                ) : (
                  <Dot
                    tone={DOT_TONES[dot]}
                    size="large"
                    label={DOT_LABELS[dot]}
                    data-testid="background-tray-dot"
                  />
                )}
              </span>
              <span
                className="min-w-0 truncate fg-secondary"
                data-testid="background-tray-summary"
              >
                {summary}
              </span>
            </button>
            {/* Outside the toggle so each icon can host its own hover. The
              open list names every item, so the icons give way to its
              actions. */}
            {expanded ? (
              <>
                {viewTree}
                {stopAll}
                {stopAllWork}
              </>
            ) : (
              <CollapsedKinds
                live={live}
                agents={agents}
                unlistedDelegations={unlistedDelegations}
                runs={runs}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="compact"
              iconOnly
              aria-expanded={expanded}
              aria-controls={expanded ? listId : undefined}
              aria-label={
                expanded ? 'Hide background work' : 'Show background work'
              }
              ref={toggleRef}
              onClick={toggle}
              data-testid="background-tray-toggle"
              data-chevron={expanded ? 'down' : 'up'}
            >
              {/* The drawer grows upward as it opens: up to open, down to close. */}
              {expanded ? (
                <ChevronDownIcon size={14} aria-hidden="true" />
              ) : (
                <ChevronTopMediumIcon size={14} aria-hidden="true" />
              )}
            </Button>
          </div>
          {expanded && list}
        </div>
      </ComposerDrawerSection>
    ) : null,
  );
}

/** What the Background tab's label counts, from the tray's own inputs. */
export interface BackgroundTrayCounts {
  /** Rows the list shows: tasks, agents, unlisted delegates and runs. */
  readonly items: number;
  /** Agents waiting on an approval, and runs waiting on input or paused. */
  readonly needsYou: number;
  /** Work still running, for the tab's background glyph. */
  readonly running: number;
  readonly watching: number;
  readonly pullRequests: number;
}

/** The Background tab's counts, filtered as `BackgroundTray` lists them. */
export function backgroundTrayCounts({
  tasks,
  agents = NO_AGENTS,
  runs = [],
  watchers = [],
  unlistedDelegations = 0,
}: Pick<
  BackgroundTrayProps,
  'tasks' | 'agents' | 'runs' | 'watchers' | 'unlistedDelegations'
>): BackgroundTrayCounts {
  const agentTaskIds = new Set(agents.map((agent) => agent.taskId));
  const live = tasks.filter(
    (task) =>
      !isTerminalBackgroundProcessStatus(task.status) &&
      !agentTaskIds.has(task.id),
  );
  const summary = summarizeDrawer(live, agents, runs, unlistedDelegations);
  return {
    items:
      live.length +
      agents.length +
      (unlistedDelegations > 0 ? 1 : 0) +
      runs.length +
      watchers.length,
    needsYou:
      summary.approvalAgents.length +
      summary.needsInputRuns.length +
      summary.pausedRuns.length,
    running:
      summary.running -
      summary.runningRuns.filter((run) => run.kind !== 'pipeline').length,
    watching:
      summary.runningRuns.filter((run) => run.kind === 'github').length +
      watchers.length,
    pullRequests: runs.filter((run) => run.kind === 'github-pr').length,
  };
}

/** The collapsed header's kind icons: one per kind, a count when several. */
function CollapsedKinds({
  live,
  agents,
  unlistedDelegations,
  runs,
}: {
  readonly live: readonly BackgroundTask[];
  readonly agents: readonly BackgroundTrayAgent[];
  readonly unlistedDelegations: number;
  readonly runs: readonly BackgroundTrayRun[];
}): JSX.Element {
  const kinds = KIND_ORDER.flatMap((kind) => {
    const titles = [
      ...(kind === 'agent' ? agents : []),
      ...live.filter((task) => task.kind === kind),
    ].map((item) => ({ id: item.id, title: item.title }));
    const unlisted = kind === 'agent' ? unlistedDelegations : 0;
    return titles.length + unlisted === 0
      ? []
      : [{ kind, count: titles.length + unlisted, titles, unlisted }];
  });
  return (
    <>
      {kinds.map(({ kind, count, titles, unlisted }) => (
        <Tooltip
          key={kind}
          label={
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{KIND_LABELS[kind]}</span>
              {titles.map((item) => (
                <span key={item.id} className={REPLAY_BLOCK_CLASS}>
                  {item.title}
                </span>
              ))}
              {unlisted > 0 && (
                <span>{unlistedDelegatesLabel(unlisted, titles.length)}</span>
              )}
            </span>
          }
        >
          <span
            className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-sm px-1 fg-tertiary"
            aria-label={`${KIND_LABELS[kind]}: ${count}`}
            role="img"
            data-testid={`background-tray-kind-${kind}`}
          >
            {TASK_KIND_GLYPHS[kind]}
            {count > 1 && <Count value={count} aria-hidden />}
          </span>
        </Tooltip>
      ))}
      {(['pipeline', 'github', 'github-pr'] as const).map((kind) => {
        const ofKind = runs.filter((run) => run.kind === kind);
        if (ofKind.length === 0) return null;
        const runDot = runCornerDot(ofKind);
        return (
          <Tooltip
            key={kind}
            label={
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{RUN_KIND_LABELS[kind]}</span>
                {ofKind.map((run) => (
                  <span key={run.id}>
                    <span className={REPLAY_MASK_CLASS}>{run.name}</span>
                    {`: ${run.statusLabel ?? RUN_STATUS_LABELS[run.status]}`}
                  </span>
                ))}
              </span>
            }
          >
            <span
              className="relative inline-flex h-6 shrink-0 items-center gap-0.5 rounded-sm px-1 fg-tertiary"
              aria-label={`${RUN_KIND_LABELS[kind]}: ${ofKind.length}`}
              role="img"
              data-testid={`background-tray-kind-${kind}`}
              data-dot={runDot ?? undefined}
            >
              {kind === 'github-pr' ? (
                <GitPullRequestIcon size={14} aria-hidden="true" />
              ) : kind === 'github' ? (
                <GitHubIcon size={14} aria-hidden="true" />
              ) : (
                <PipelineIcon size="sm" aria-hidden="true" />
              )}
              {ofKind.length > 1 && <Count value={ofKind.length} aria-hidden />}
              {runDot !== null && (
                <Dot
                  tone={runDot === 'failed' ? 'danger' : 'attention'}
                  className="absolute right-0.5 top-0.5"
                />
              )}
            </span>
          </Tooltip>
        );
      })}
    </>
  );
}
