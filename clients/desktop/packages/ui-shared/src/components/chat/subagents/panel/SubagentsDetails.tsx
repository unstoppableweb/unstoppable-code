import type { JSX } from 'react';
import {
  subagentAncestors,
  type SubagentNode,
  type SubagentTree,
} from '@canopy/agent-transcript';
import {
  SUBAGENT_OPEN_CHAT_LABEL,
  SUBAGENT_OPEN_WORKFLOW_LABEL,
  SUBAGENT_STOP_WORKFLOW_FAILED_LABEL,
  SUBAGENT_STOP_WORKFLOW_LABEL,
  SUBAGENT_STOPPING_WORKFLOW_LABEL,
  SUBAGENTS_CLOSE_DETAILS_LABEL,
  SUBAGENTS_FOCUS_LABEL,
  SUBAGENTS_INSPECTOR_CHAT,
  SUBAGENTS_INSPECTOR_CHANGES,
  SUBAGENTS_INSPECTOR_LINEAGE,
  SUBAGENTS_INSPECTOR_MODEL,
  SUBAGENTS_INSPECTOR_PHASES,
  SUBAGENTS_INSPECTOR_RUN,
  SUBAGENTS_INSPECTOR_STARTED,
  SUBAGENTS_INSPECTOR_STARTED_NONE_CLASSIC,
  SUBAGENTS_INSPECTOR_TIME,
  SUBAGENTS_INSPECTOR_USAGE,
  SUBAGENTS_INSPECTOR_WORKSPACE,
  SUBAGENTS_STOP_FAILED_LABEL,
  SUBAGENT_SHOW_CHANGES_LABEL,
  subagentFilesCountLabel,
  subagentStatusDetail,
  subagentWorkflowRunPositionLabel,
  subagentWorkflowUsageLabel,
  subagentWorkspaceLabel,
} from '../subagent-copy';
import {
  DELEGATED_AGENT_STOP_ACCESSIBLE_LABEL,
  DELEGATED_AGENT_STOPPING_LABEL,
} from '../../delegated-agent-copy';
import { TASK_STOP_LABEL } from '../../TaskStopButton';
import type { SubagentChangeTotals } from '../types';
import {
  ArrowUpRightIcon,
  ChatIcon,
  CloseIcon,
  StopIcon,
} from '../../../../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../../../../lib/replay-privacy';
import { Button } from '../../../Button';
import { PaneSheet } from '../../../Sheet';
import { ExecutionActionButton } from '../../../ExecutionActionButton';
import { ErrorBanner } from '../../../StatusBlocks';
import { SubagentChangesLabel } from '../common/SubagentChangesLabel';
import { SubagentHarnessMark } from '../common/SubagentHarnessMark';
import {
  SubagentWorkflowMark,
  SubagentWorkflowPhaseCountText,
  SubagentWorkflowRunStatusText,
  subagentWorkflowPhases,
} from '../common/SubagentWorkflow';
import {
  formatSubagentDuration,
  formatSubagentElapsed,
} from '../common/subagent-format';
import {
  SubagentStatusGlyph,
  subagentStatusInk,
} from '../common/SubagentStatusGlyph';
import { Fact, FactList } from '../../../FactList';
import { Heading } from '../../../Heading';

/** Shared callback and content props for the inspector and bottom drawer. */
export interface SubagentsDetailsProps {
  /** Complete source tree, used to show ancestry and started tasks. */
  readonly tree: SubagentTree;
  /** The selected task. */
  readonly node: SubagentNode;
  /** Whether the host exposes workspace and change details here. */
  readonly showWorkspaceDetails: boolean;
  /** Optional authorized totals for this task. */
  readonly changeTotals?: SubagentChangeTotals;
  /** Open this task's chat. */
  readonly onOpenChat: (node: SubagentNode) => void;
  /** Focus this task in the tree, when it has children. */
  readonly onFocus?: (node: SubagentNode) => void;
  /** Show the host's worktree changes view when workspace details are enabled. */
  readonly onShowChanges?: (node: SubagentNode) => void;
  /** Stop this live managed task and its descendants. */
  readonly onStop?: (node: SubagentNode) => void;
  /** Open this workflow run in the host's workflow view. */
  readonly onOpenWorkflow?: (run: SubagentNode) => void;
  /** Stop this live workflow run in the host. */
  readonly onStopWorkflow?: (run: SubagentNode) => void;
  /** Whether the Stop workflow request is currently in flight. */
  readonly stoppingWorkflow?: boolean;
  /** Reason returned by the host after a refused Stop workflow. */
  readonly stopWorkflowError?: string;
  /** Current clock for elapsed workflow run time. */
  readonly now?: number;
  /** Whether the Stop request is currently in flight. */
  readonly stopping?: boolean;
  /** Reason returned by the host after a refused Stop. */
  readonly stopError?: string;
  /** Dismiss the detail surface. */
  readonly onClose: () => void;
}

function SubagentsTaskDetailsBody({
  tree,
  node,
  showWorkspaceDetails,
  changeTotals,
  onOpenChat,
  onFocus,
  onShowChanges,
  onStop,
  stopping = false,
  stopError,
  onClose,
}: SubagentsDetailsProps): JSX.Element {
  const ancestors = [...subagentAncestors(tree, node.id)].reverse();
  const children = node.childIds.flatMap((childId) => {
    const child = tree.nodes.get(childId);
    return child ? [child.title] : [];
  });
  const workspace = subagentWorkspaceLabel(node);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <SubagentStatusGlyph status={node.status} size={14} />
          <Heading
            level={4}
            variant="title"
            truncate
            className="min-w-0 flex-1"
          >
            <span className={REPLAY_MASK_CLASS}>{node.title}</span>
          </Heading>
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            aria-label={SUBAGENTS_CLOSE_DETAILS_LABEL}
            data-testid="subagents-inspector-close"
            onClick={onClose}
          >
            <CloseIcon size={14} aria-hidden />
          </Button>
        </div>
        <span className={`text-xs ${subagentStatusInk(node.status)}`}>
          {subagentStatusDetail(node)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="compact"
          data-testid="subagents-inspector-open-chat"
          onClick={(): void => onOpenChat(node)}
        >
          <ArrowUpRightIcon size={14} aria-hidden />
          {SUBAGENT_OPEN_CHAT_LABEL}
        </Button>
        {onFocus ? (
          <Button
            variant="secondary"
            size="compact"
            data-testid="subagents-inspector-focus"
            onClick={(): void => onFocus(node)}
          >
            {SUBAGENTS_FOCUS_LABEL}
          </Button>
        ) : null}
        {onShowChanges ? (
          <Button
            variant="secondary"
            size="compact"
            data-testid="subagents-inspector-show-changes"
            onClick={(): void => onShowChanges(node)}
          >
            {SUBAGENT_SHOW_CHANGES_LABEL}
          </Button>
        ) : null}
        {onStop ? (
          <ExecutionActionButton
            label={stopping ? DELEGATED_AGENT_STOPPING_LABEL : TASK_STOP_LABEL}
            ariaLabel={DELEGATED_AGENT_STOP_ACCESSIBLE_LABEL}
            icon={<StopIcon size={14} aria-hidden />}
            variant="destructive"
            disabled={stopping}
            dataTestId="subagents-inspector-stop"
            onClick={(): void => onStop(node)}
            stopKeyDownPropagation={false}
          />
        ) : null}
      </div>

      {stopError ? (
        <ErrorBanner
          errorSource="subagents-task-details-body"
          className=""
          error={`${SUBAGENTS_STOP_FAILED_LABEL} ${stopError}`}
        />
      ) : null}

      <FactList rowGap="2">
        <Fact label={SUBAGENTS_INSPECTOR_MODEL}>
          <span className="flex min-w-0 items-center gap-1.5">
            <SubagentHarnessMark harnessId={node.harnessId} />
            <span className="truncate">{node.modelLabel ?? ''}</span>
            {node.thinkingLevel ? (
              <span className="shrink-0 fg-tertiary">
                · {node.thinkingLevel}
              </span>
            ) : null}
          </span>
        </Fact>
        {showWorkspaceDetails && workspace ? (
          <Fact label={SUBAGENTS_INSPECTOR_WORKSPACE}>{workspace}</Fact>
        ) : null}
        {showWorkspaceDetails && changeTotals ? (
          <Fact label={SUBAGENTS_INSPECTOR_CHANGES}>
            <span className="flex flex-wrap items-center gap-1.5">
              <SubagentChangesLabel
                additions={changeTotals.additions}
                deletions={changeTotals.deletions}
              />
              <span className="fg-tertiary">
                {subagentFilesCountLabel(changeTotals.filesChanged)}
              </span>
            </span>
          </Fact>
        ) : null}
        <Fact label={SUBAGENTS_INSPECTOR_LINEAGE}>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className={`${REPLAY_MASK_CLASS} truncate fg-tertiary`}>
              {tree.root.title}
            </span>
            {ancestors.map((ancestor) => (
              <span
                key={ancestor.id}
                className={`${REPLAY_MASK_CLASS} truncate fg-secondary`}
              >
                {ancestor.title}
              </span>
            ))}
          </span>
        </Fact>
        <Fact label={SUBAGENTS_INSPECTOR_STARTED}>
          {children.length > 0
            ? children.join(', ')
            : SUBAGENTS_INSPECTOR_STARTED_NONE_CLASSIC}
        </Fact>
      </FactList>
    </>
  );
}

function SubagentsWorkflowRunDetailsBody({
  tree,
  node: run,
  onOpenWorkflow,
  onFocus,
  onStopWorkflow,
  stoppingWorkflow = false,
  stopWorkflowError,
  now,
  onClose,
}: SubagentsDetailsProps): JSX.Element {
  const phases = subagentWorkflowPhases(tree, run);
  const usage = subagentWorkflowUsageLabel(
    run.workflow?.tokens,
    run.workflow?.toolCalls,
  );
  const time =
    run.workflow?.durationMs !== undefined
      ? formatSubagentDuration(run.workflow.durationMs)
      : now !== undefined
        ? formatSubagentElapsed(run, now)
        : '';
  const hasActions = Boolean(onOpenWorkflow || onFocus || onStopWorkflow);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <SubagentWorkflowMark size={14} />
          <Heading
            level={4}
            variant="title"
            truncate
            className="min-w-0 flex-1"
          >
            <span className={REPLAY_MASK_CLASS}>{run.title}</span>
          </Heading>
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            aria-label={SUBAGENTS_CLOSE_DETAILS_LABEL}
            data-testid="subagents-inspector-close"
            onClick={onClose}
          >
            <CloseIcon size={14} aria-hidden />
          </Button>
        </div>
        <span className="text-xs">
          <SubagentWorkflowRunStatusText tree={tree} run={run} />
        </span>
      </div>

      {hasActions ? (
        <div className="flex flex-wrap items-center gap-2">
          {onOpenWorkflow ? (
            <Button
              variant="primary"
              size="compact"
              data-testid="subagents-inspector-open-workflow"
              onClick={(): void => onOpenWorkflow(run)}
            >
              <ArrowUpRightIcon size={14} aria-hidden />
              {SUBAGENT_OPEN_WORKFLOW_LABEL}
            </Button>
          ) : null}
          {onFocus ? (
            <Button
              variant="secondary"
              size="compact"
              data-testid="subagents-inspector-focus"
              onClick={(): void => onFocus(run)}
            >
              {SUBAGENTS_FOCUS_LABEL}
            </Button>
          ) : null}
          {onStopWorkflow ? (
            <ExecutionActionButton
              label={
                stoppingWorkflow
                  ? SUBAGENT_STOPPING_WORKFLOW_LABEL
                  : SUBAGENT_STOP_WORKFLOW_LABEL
              }
              ariaLabel={SUBAGENT_STOP_WORKFLOW_LABEL}
              icon={<StopIcon size={14} aria-hidden />}
              variant="destructive"
              disabled={stoppingWorkflow}
              dataTestId="subagents-inspector-stop-workflow"
              onClick={(): void => onStopWorkflow(run)}
              stopKeyDownPropagation={false}
            />
          ) : null}
        </div>
      ) : null}

      {stopWorkflowError ? (
        <ErrorBanner
          errorSource="subagents-workflow-run-details-body"
          className=""
          error={`${SUBAGENT_STOP_WORKFLOW_FAILED_LABEL} ${stopWorkflowError}`}
        />
      ) : null}

      <FactList rowGap="2">
        <Fact label={SUBAGENTS_INSPECTOR_CHAT}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="inline-flex shrink-0 fg-secondary">
              <ChatIcon size={12} aria-hidden />
            </span>
            <span className={`${REPLAY_MASK_CLASS} min-w-0 truncate`}>
              {tree.root.title}
            </span>
          </span>
        </Fact>
        {run.workflow ? (
          <Fact label={SUBAGENTS_INSPECTOR_RUN}>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>
                {subagentWorkflowRunPositionLabel(
                  run.workflow.runOrdinal,
                  run.workflow.runCount,
                )}
              </span>
              <span className="truncate font-mono text-2xs fg-tertiary">
                {run.workflow.runId}
              </span>
            </span>
          </Fact>
        ) : null}
        {phases.length > 0 ? (
          <Fact label={SUBAGENTS_INSPECTOR_PHASES}>
            <span className="flex min-w-0 flex-col gap-1">
              {phases.map((phase) => (
                <span
                  key={phase.id}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  <SubagentStatusGlyph status={phase.status} size={10} />
                  <span
                    className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate`}
                  >
                    {phase.title}
                  </span>
                  <span className="shrink-0">
                    <SubagentWorkflowPhaseCountText
                      tree={tree}
                      phase={phase}
                      quiet
                    />
                  </span>
                </span>
              ))}
            </span>
          </Fact>
        ) : null}
        {usage ? <Fact label={SUBAGENTS_INSPECTOR_USAGE}>{usage}</Fact> : null}
        {time ? <Fact label={SUBAGENTS_INSPECTOR_TIME}>{time}</Fact> : null}
      </FactList>
    </>
  );
}

function SubagentsWorkflowPhaseDetailsBody({
  node,
  onClose,
}: SubagentsDetailsProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <SubagentWorkflowMark size={14} />
        <Heading level={4} variant="title" truncate className="min-w-0 flex-1">
          <span className={REPLAY_MASK_CLASS}>{node.title}</span>
        </Heading>
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          aria-label={SUBAGENTS_CLOSE_DETAILS_LABEL}
          data-testid="subagents-inspector-close"
          onClick={onClose}
        >
          <CloseIcon size={14} aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function SubagentsDetailsBody(props: SubagentsDetailsProps): JSX.Element {
  if (props.node.kind === 'workflow-run')
    return <SubagentsWorkflowRunDetailsBody {...props} />;
  if (props.node.kind === 'workflow-phase')
    return <SubagentsWorkflowPhaseDetailsBody {...props} />;
  return <SubagentsTaskDetailsBody {...props} />;
}

/** Wide-panel detail column displayed beside the tree or list. */
export function SubagentsInspector(props: SubagentsDetailsProps): JSX.Element {
  return (
    <aside
      data-testid="subagents-inspector"
      className="flex w-80 shrink-0 flex-col gap-4 overflow-hidden border-l bg-base p-4"
    >
      <SubagentsDetailsBody {...props} />
    </aside>
  );
}

/** Narrow-panel detail drawer; canvas mode clears its zoom controls. */
export function SubagentsDrawer({
  over,
  ...props
}: SubagentsDetailsProps & { readonly over: 'canvas' | 'list' }): JSX.Element {
  return (
    <PaneSheet
      placement="bottom"
      start={over === 'canvas' ? 'controls' : 'edge'}
      aria-label="Agent details"
      data-testid="subagents-drawer"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <SubagentsDetailsBody {...props} />
      </div>
    </PaneSheet>
  );
}
