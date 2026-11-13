'use client';

import {
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import {
  AnsiOutput,
  SpinnerStyleProvider,
  StatusGlyph,
  EmptyStateRow,
  joinDetails,
} from '@canopy/ui-shared/components';
import {
  AgentIcon,
  CodeIcon,
  GraphIcon,
  TaskIcon,
  TerminalIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { formatElapsed } from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type {
  BackgroundTaskHostActions,
  BackgroundWorkflowAgentProgress,
  BackgroundWorkflowProgress,
} from '../background-tasks-section';
import { backgroundTaskStopAccessibleLabel } from '../BackgroundProcessesSectionBody';
import { TaskStopAction } from '../TaskStopAction';
import { CappedRegion, TAIL_CAP, TAIL_LINES } from './drawer-layout';
import {
  DrawerRow,
  InspectorOpenAction,
  InspectorSection,
  InspectorSubtitle,
} from './DrawerRow';
import { DrawerRowPresentationContext } from './drawer-presentation';

/** A background task's glyph. Workflows fan out into agents (D9). */
export const TASK_KIND_GLYPHS: Readonly<
  Record<BackgroundTask['kind'], JSX.Element>
> = {
  agent: <AgentIcon size="sm" aria-hidden="true" />,
  bash: <TerminalIcon size="sm" aria-hidden="true" />,
  workflow: <GraphIcon size="sm" aria-hidden="true" />,
  task: <TaskIcon size="sm" aria-hidden="true" />,
};

const OPEN_LABELS: Record<BackgroundTask['kind'], string> = {
  bash: 'Open output',
  workflow: 'Open run',
  agent: 'Open details',
  task: 'Open details',
};

function lastOutputLine(task: BackgroundTask): string | null {
  for (let index = task.outputLines.length - 1; index >= 0; index -= 1) {
    const line = task.outputLines[index]?.trim();
    if (line) return line;
  }
  return null;
}

/** A leading terminal marker: prompts, Vitest's ❯ and pass/fail ticks. */
const TERMINAL_MARKER = /^[\s❯›>$#✓✔✗✘×]+/u;

/** What the task is doing now, for its row; nothing that repeats its name. */
function taskDetail(task: BackgroundTask): string | null {
  const detail =
    task.kind === 'bash'
      ? (lastOutputLine(task)?.replace(TERMINAL_MARKER, '') ?? null)
      : (task.lastDescription ?? task.summary);
  return detail === task.title || detail === '' ? null : detail;
}

function ShellInspector({
  task,
  command,
  streamsOutput,
}: {
  readonly task: BackgroundTask;
  readonly command: string;
  readonly streamsOutput: boolean;
}): JSX.Element {
  const redesigned = useContext(DrawerRowPresentationContext) !== 'legacy';
  const Subtitle = redesigned ? InspectorSubtitle : Fragment;
  return (
    <>
      <Subtitle>
        <code
          className={`${REPLAY_BLOCK_CLASS} truncate font-mono text-s ${redesigned ? '' : 'fg-secondary'}`}
        >
          $ {command}
        </code>
      </Subtitle>
      <InspectorSection>
        {streamsOutput ? (
          <div className={REPLAY_BLOCK_CLASS}>
            <AnsiOutput
              lines={task.outputLines}
              variant="tail"
              maxRenderLines={TAIL_LINES}
              style={{ maxHeight: TAIL_CAP }}
              placeholder="No output yet"
            />
          </div>
        ) : (
          <p>Output shows in the desktop app.</p>
        )}
      </InspectorSection>
    </>
  );
}

const AGENT_GLYPH_STATES = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
} as const satisfies Record<BackgroundWorkflowAgentProgress['state'], string>;

function workflowProgressLine(progress: BackgroundWorkflowProgress): ReactNode {
  const done = progress.agents.filter((agent) => agent.state === 'done').length;
  return joinDetails([
    progress.phaseIndex !== null && progress.phaseCount > 0
      ? `Phase ${String(progress.phaseIndex + 1)} of ${String(progress.phaseCount)}`
      : null,
    progress.phaseTitle,
    progress.agents.length > 0
      ? `${String(done)} of ${String(progress.agents.length)} agents done`
      : null,
  ]);
}

function WorkflowInspector({
  task,
  runId,
  subscribe,
}: {
  readonly task: BackgroundTask;
  /** The host's run id, once known: a new run is read afresh. */
  readonly runId: string | null;
  readonly subscribe?: BackgroundTaskHostActions['subscribeWorkflowProgress'];
}): JSX.Element {
  const redesigned = useContext(DrawerRowPresentationContext) !== 'legacy';
  const Subtitle = redesigned ? InspectorSubtitle : Fragment;
  const [progress, setProgress] = useState<BackgroundWorkflowProgress | null>(
    null,
  );
  // Hosts rebuild the task and their actions on every update (another
  // task's output, a progress line); the subscription follows the run, not
  // those references, so it keeps its own poll.
  const latest = useRef({ task, subscribe });
  useEffect(() => {
    latest.current = { task, subscribe };
  });
  const canSubscribe = subscribe !== undefined;
  // Read only while this inspector is open; unmounting unsubscribes.
  useEffect(
    () => latest.current.subscribe?.(latest.current.task, setProgress),
    [task.id, runId, canSubscribe],
  );
  const line = progress === null ? null : workflowProgressLine(progress);
  return (
    <>
      <Subtitle>
        <p
          className={`${REPLAY_BLOCK_CLASS} ${redesigned ? '' : 'fg-secondary'}`}
        >
          {line ?? (task.lastDescription || task.summary || 'Starting')}
        </p>
      </Subtitle>
      {progress !== null && progress.agents.length > 0 && (
        <InspectorSection>
          <CappedRegion>
            <ul
              className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-2`}
              data-testid="background-tray-workflow-agents"
            >
              {progress.agents.map((agent) => (
                <li
                  key={agent.id}
                  className="flex min-w-0 items-center gap-2.5"
                >
                  <span className="flex w-3.5 shrink-0 justify-center">
                    <SpinnerStyleProvider value="comet">
                      <StatusGlyph
                        state={AGENT_GLYPH_STATES[agent.state]}
                        size={14}
                      />
                    </SpinnerStyleProvider>
                  </span>
                  {/* The activity follows the name, as on the drawer rows. */}
                  <span className="min-w-0 max-w-1/2 shrink-0 truncate fg-primary">
                    {agent.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate fg-tertiary">
                    {agent.activity ?? ''}
                  </span>
                </li>
              ))}
            </ul>
          </CappedRegion>
        </InspectorSection>
      )}
    </>
  );
}

function DetailsInspector({
  task,
}: {
  readonly task: BackgroundTask;
}): JSX.Element {
  const redesigned = useContext(DrawerRowPresentationContext) !== 'legacy';
  const Subtitle = redesigned ? InspectorSubtitle : Fragment;
  return (
    <Subtitle>
      {!redesigned && task.lastDescription !== null && (
        <p
          className={`${REPLAY_BLOCK_CLASS} ${redesigned ? '' : 'fg-secondary'}`}
        >
          {task.lastDescription}
        </p>
      )}
      {task.summary !== null && task.summary !== task.lastDescription && (
        <p className={`${REPLAY_BLOCK_CLASS} line-clamp-3 fg-tertiary`}>
          {task.summary}
        </p>
      )}
      {task.lastDescription === null && task.summary === null && (
        <EmptyStateRow title="No updates yet" />
      )}
    </Subtitle>
  );
}

export interface TaskRowProps {
  readonly task: BackgroundTask;
  readonly actions?: BackgroundTaskHostActions;
  readonly now: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Opens the task's detail modal; absent, the inspector offers no Open. */
  readonly onOpenDetail?: (task: BackgroundTask) => void;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly topInset: number;
}

/** A background task's row and inspector: shell, workflow or task (D6). */
export function TaskRow({
  task,
  actions,
  now,
  open,
  onToggle,
  onOpenDetail,
  listRef,
  topInset,
}: TaskRowProps): JSX.Element {
  const presentation = useContext(DrawerRowPresentationContext);
  const stopTarget = actions?.stopTarget?.(task) ?? null;
  const detail = taskDetail(task);
  const elapsed =
    task.status === 'queued'
      ? 'Queued'
      : task.startedAt !== null
        ? formatElapsed(now - task.startedAt)
        : undefined;
  const renderInspector = (): JSX.Element => {
    const hostDetail = actions?.getDetail?.(task) ?? null;
    return (
      <>
        {task.kind === 'bash' ? (
          <ShellInspector
            task={task}
            command={hostDetail?.command ?? task.title}
            streamsOutput={hostDetail !== null}
          />
        ) : task.kind === 'workflow' ? (
          <WorkflowInspector
            task={task}
            runId={hostDetail?.runId ?? null}
            subscribe={actions?.subscribeWorkflowProgress}
          />
        ) : (
          <DetailsInspector task={task} />
        )}
        {presentation === 'legacy' && onOpenDetail && (
          <InspectorOpenAction
            label={OPEN_LABELS[task.kind]}
            onClick={(): void => onOpenDetail(task)}
          />
        )}
      </>
    );
  };
  return (
    <DrawerRow
      rowKey={`task:${task.id}`}
      testId="background-tray-row"
      // A live task is running: its kind's glyph, and the name shimmers.
      glyph={TASK_KIND_GLYPHS[task.kind]}
      running={task.status !== 'queued'}
      // Descriptions fall back to the command or prompt.
      name={<span className={REPLAY_BLOCK_CLASS}>{task.title}</span>}
      detail={
        detail === null ? undefined : task.kind === 'bash' ? (
          // Output, under the app's code glyph instead of the terminal's own
          // marker; the open row shows the raw tail.
          <span className="flex min-w-0 items-center gap-1.5">
            <CodeIcon size={14} aria-hidden="true" className="shrink-0" />
            <span className={`${REPLAY_BLOCK_CLASS} truncate`}>{detail}</span>
          </span>
        ) : (
          <span className={REPLAY_BLOCK_CLASS}>{detail}</span>
        )
      }
      trailing={presentation === 'legacy' ? elapsed : undefined}
      status={presentation !== 'legacy' ? elapsed : undefined}
      openAction={
        onOpenDetail
          ? {
              label: OPEN_LABELS[task.kind],
              onClick: (): void => onOpenDetail(task),
            }
          : undefined
      }
      action={
        stopTarget && task.canStop ? (
          <TaskStopAction
            target={stopTarget}
            live
            accessibleLabel={backgroundTaskStopAccessibleLabel(task.kind)}
            dataTestId="background-tray-row-stop"
            onError={actions?.onStopError}
            appearance={presentation === 'legacy' ? 'row' : 'drawer'}
            stopKeyDownPropagation={presentation === 'legacy'}
          />
        ) : undefined
      }
      inspector={
        presentation === 'legacy' ||
        task.kind === 'bash' ||
        (task.kind === 'workflow' &&
          Boolean(
            actions?.getDetail?.(task)?.runId &&
            actions?.subscribeWorkflowProgress,
          )) ||
        Boolean(task.summary && task.summary !== detail)
          ? { open, onToggle, render: renderInspector }
          : undefined
      }
      listRef={listRef}
      topInset={topInset}
    />
  );
}
