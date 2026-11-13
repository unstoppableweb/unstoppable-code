'use client';

import {
  useContext,
  Fragment,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import {
  DELEGATED_AGENT_STOP_ACCESSIBLE_LABEL,
  DELEGATED_AGENT_STOP_WITH_DESCENDANTS_LABEL,
  SubagentStatusGlyph,
  Button,
  Tooltip,
  TaskStopButton,
  getToolDisplayInfo,
  subagentStatusLabel,
  type SubagentChatTarget,
  type SubagentStatus,
} from '@canopy/ui-shared/components';
import { formatElapsed } from '@canopy/ui-shared/lib';
import { AgentIcon, StopFilledIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { BackgroundTaskHostActions } from '../background-tasks-section';
import { backgroundTaskStopAccessibleLabel } from '../BackgroundProcessesSectionBody';
import { TaskStopAction } from '../TaskStopAction';
import { CappedRegion } from './drawer-layout';
import { DrawerRow, InspectorOpenAction, InspectorSection } from './DrawerRow';
import { DrawerRowPresentationContext } from './drawer-presentation';

/** Which provider runs a background subagent. */
export type BackgroundTrayAgentKind = 'claude' | 'codex' | 'delegate';

/** One tool call of an agent, as its host recorded it. */
export interface BackgroundTrayAgentStep {
  readonly id: string;
  readonly toolName: string;
  readonly input: string;
}

/** A background subagent, as the drawer lists it (D6). */
export interface BackgroundTrayAgent {
  /**
   * Stable within a chat: `claude:<toolUseId>`, `codex:<agentBlockId>` or
   * `managed:<delegationId>`.
   */
  readonly id: string;
  readonly kind: BackgroundTrayAgentKind;
  readonly title: string;
  readonly status: SubagentStatus;
  /** What it is doing now, when the host knows more than its last step. */
  readonly activity: string | null;
  /** Epoch ms. */
  readonly startedAt: number | null;
  /** Its tool calls, newest last, at most `AGENT_STEP_LIMIT`. */
  readonly steps: readonly BackgroundTrayAgentStep[];
  readonly prompt: string | null;
  /** Harness and model, one quiet line. */
  readonly meta: string | null;
  /**
   * The background task the provider runs it as (a Claude background
   * agent): the drawer lists the agent once, and stops it through that task.
   */
  readonly taskId: string | null;
  /** Whether the host stops it itself (`onStopAgent`); delegates only. */
  readonly canStop: boolean;
  /** Where Open chat goes; absent where the host cannot open its chat. */
  readonly target: SubagentChatTarget | null;
  /** A delegate whose Stop also ends live tasks it started. */
  readonly stopsDescendants?: boolean;
}

/** The most steps an agent row carries: the newest ones. */
export const AGENT_STEP_LIMIT = 20;

/** A live delegate's status: queued until it starts, then running or waiting on an approval. */
export function delegateAgentStatus(
  snapshot: Pick<AgentDelegationSnapshot, 'status' | 'approvalPending'>,
): SubagentStatus {
  if (snapshot.status === 'pending') return 'queued';
  return snapshot.approvalPending === true ? 'approval' : 'running';
}

/** A delegate's meta line, as both hosts show it: `Delegate · <model>`. */
export function delegateAgentMeta(snapshot: AgentDelegationSnapshot): string {
  const route = snapshot.routeSnapshot;
  const model =
    route?.runtimeModelLabel ??
    route?.selectedModelLabel ??
    route?.runtimeModelId ??
    snapshot.requestedModelId;
  return model ? `Delegate · ${model}` : 'Delegate';
}

/** The step label hosts and rows share, from the transcript's tool display. */
function stepLabel(step: BackgroundTrayAgentStep): ReactNode {
  return getToolDisplayInfo(step.toolName, step.input).label;
}

/**
 * What the agent is doing now: its activity, else its newest step; never a
 * repeat of its name (a task's first progress line is its description).
 */
function agentActivity(agent: BackgroundTrayAgent): ReactNode {
  if (agent.activity && agent.activity !== agent.title) return agent.activity;
  const step = agent.steps[agent.steps.length - 1];
  return step === undefined ? null : stepLabel(step);
}

function AgentInspector({
  agent,
}: {
  readonly agent: BackgroundTrayAgent;
}): JSX.Element {
  const redesigned = useContext(DrawerRowPresentationContext) !== 'legacy';
  const activity = agentActivity(agent);
  const steps = redesigned ? agent.steps.slice(-5) : agent.steps;
  const Region = redesigned ? Fragment : CappedRegion;
  return (
    <>
      {redesigned ? (
        steps.length === 0 &&
        agent.prompt &&
        agent.prompt !== agent.activity &&
        agent.prompt !== agent.title ? (
          <p
            className={`${REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words text-s fg-secondary`}
          >
            {agent.prompt}
          </p>
        ) : null
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          <SubagentStatusGlyph status={agent.status} />
          <span
            className={`${REPLAY_BLOCK_CLASS} min-w-0 truncate fg-secondary`}
          >
            {activity ?? subagentStatusLabel(agent.status)}
          </span>
        </div>
      )}
      {steps.length > 0 ? (
        <InspectorSection>
          <Region>
            <ul
              className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-2`}
              data-testid="background-tray-agent-steps"
            >
              {steps.map((step) => {
                const info = getToolDisplayInfo(step.toolName, step.input);
                return (
                  <li
                    key={step.id}
                    className="flex min-w-0 items-center gap-2.5"
                  >
                    <span className="inline-flex w-3.5 shrink-0 justify-center">
                      {info.icon}
                    </span>
                    <span className="min-w-0 truncate">{info.label}</span>
                  </li>
                );
              })}
            </ul>
          </Region>
        </InspectorSection>
      ) : !redesigned && agent.prompt ? (
        <p className={`${REPLAY_BLOCK_CLASS} line-clamp-3 fg-tertiary`}>
          {agent.prompt}
        </p>
      ) : null}
      {!redesigned && agent.meta && <p className="truncate">{agent.meta}</p>}
    </>
  );
}

/** A delegate's Stop: `Stopping…` until the host settles the request. */
function DelegateStop({
  agent,
  onStop,
}: {
  readonly agent: BackgroundTrayAgent;
  readonly onStop: (agent: BackgroundTrayAgent) => Promise<boolean>;
}): JSX.Element {
  const presentation = useContext(DrawerRowPresentationContext);
  const [stopping, setStopping] = useState(false);
  // Guards a second press before the first one re-renders the button.
  const sent = useRef(false);
  return (
    <TaskStopButton
      stopping={stopping}
      onStop={(): void => {
        if (sent.current) return;
        sent.current = true;
        setStopping(true);
        // A refused stop lets the user try again; an accepted one waits for
        // the delegate to leave the drawer.
        const settle = (accepted: boolean): void => {
          if (accepted) return;
          sent.current = false;
          setStopping(false);
        };
        onStop(agent).then(settle, () => settle(false));
      }}
      accessibleLabel={DELEGATED_AGENT_STOP_ACCESSIBLE_LABEL}
      appearance={presentation === 'legacy' ? 'row' : 'drawer'}
      stopKeyDownPropagation={presentation === 'legacy'}
      title={
        agent.stopsDescendants === true
          ? DELEGATED_AGENT_STOP_WITH_DESCENDANTS_LABEL
          : undefined
      }
      dataTestId="background-tray-agent-stop"
    />
  );
}

export interface AgentRowProps {
  readonly agent: BackgroundTrayAgent;
  /** The agent's own background task, when the host merged one into it. */
  readonly task: BackgroundTask | undefined;
  readonly taskActions?: BackgroundTaskHostActions;
  readonly now: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onOpen?: (target: SubagentChatTarget) => void;
  readonly onStop?: (agent: BackgroundTrayAgent) => Promise<boolean>;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly topInset: number;
}

/**
 * A background subagent's row and inspector (D6): its status, what it is
 * doing now, elapsed time and Stop; the inspector adds its steps, harness and
 * model, and Open chat. Codex native children have no Stop (turn-state D10).
 */
export function AgentRow({
  agent,
  task,
  taskActions,
  now,
  open,
  onToggle,
  onOpen,
  onStop,
  listRef,
  topInset,
}: AgentRowProps): JSX.Element {
  const presentation = useContext(DrawerRowPresentationContext);
  const activity = agentActivity(agent);
  const redesigned = presentation !== 'legacy';
  const active = ['queued', 'starting', 'running', 'approval', 'idle'].includes(
    agent.status,
  );
  const taskStopTarget =
    task !== undefined && task.canStop
      ? (taskActions?.stopTarget?.(task) ?? null)
      : null;
  const target = agent.target;
  const action =
    taskStopTarget !== null ? (
      // Generic: replay records attributes, and the title is conversation
      // content (only its text element is blocked).
      <TaskStopAction
        target={taskStopTarget}
        live
        accessibleLabel={backgroundTaskStopAccessibleLabel('agent')}
        dataTestId="background-tray-agent-stop"
        onError={taskActions?.onStopError}
        appearance={presentation === 'legacy' ? 'row' : 'drawer'}
        stopKeyDownPropagation={presentation === 'legacy'}
      />
    ) : agent.canStop && onStop ? (
      <DelegateStop agent={agent} onStop={onStop} />
    ) : redesigned && active ? (
      <Tooltip
        label={
          agent.kind === 'codex'
            ? 'This native Codex agent cannot be stopped independently.'
            : 'Stop is not available for this agent in this view.'
        }
      >
        <span className="inline-flex">
          <Button
            variant="ghost-overlay"
            size="compact"
            iconOnly
            disabled
            aria-label="Stop agent"
            data-testid="background-tray-agent-stop"
          >
            <StopFilledIcon size="sm" />
          </Button>
        </span>
      </Tooltip>
    ) : undefined;
  return (
    <DrawerRow
      rowKey={`agent:${agent.id}`}
      testId="background-tray-agent"
      // Running: the agent glyph and a shimmering name; queued or waiting on
      // an approval, its status.
      glyph={
        agent.status === 'running' ? (
          <AgentIcon size={14} aria-hidden="true" />
        ) : (
          <SubagentStatusGlyph status={agent.status} size={14} />
        )
      }
      running={agent.status === 'running'}
      // Agent descriptions come from the conversation.
      name={<span className={REPLAY_BLOCK_CLASS}>{agent.title}</span>}
      detail={
        activity === null ? undefined : (
          <span className={REPLAY_BLOCK_CLASS}>{activity}</span>
        )
      }
      status={
        redesigned
          ? agent.status === 'approval'
            ? subagentStatusLabel(agent.status)
            : agent.startedAt !== null
              ? formatElapsed(now - agent.startedAt)
              : undefined
          : undefined
      }
      trailing={
        !redesigned
          ? agent.status === 'approval'
            ? subagentStatusLabel(agent.status)
            : agent.startedAt !== null
              ? formatElapsed(now - agent.startedAt)
              : undefined
          : undefined
      }
      attention={agent.status === 'approval'}
      action={action}
      openAction={
        onOpen && target !== null
          ? { label: 'Open chat', onClick: (): void => onOpen(target) }
          : undefined
      }
      inspector={
        !redesigned ||
        agent.steps.length > 0 ||
        Boolean(
          agent.prompt &&
          agent.prompt !== agent.activity &&
          agent.prompt !== agent.title,
        )
          ? {
              open,
              onToggle,
              render: (): JSX.Element => (
                <>
                  <AgentInspector agent={agent} />
                  {presentation === 'legacy' && onOpen && target !== null && (
                    <InspectorOpenAction
                      label="Open chat"
                      onClick={(): void => onOpen(target)}
                    />
                  )}
                </>
              ),
            }
          : undefined
      }
      listRef={listRef}
      topInset={topInset}
    />
  );
}
