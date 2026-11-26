import type { JSX } from 'react';
import type { SubagentNode, SubagentTree } from '@canopy/agent-transcript';
import { Button } from '../../../../primitives/Button';
import { ArrowUpRightIcon } from '../../../../icons/AppIcons';
import {
  SubagentWorkflowMark,
  subagentWorkflowRunOf,
  subagentWorkflowRunStatusLine,
} from '../common/SubagentWorkflow';
import {
  SUBAGENT_OPEN_WORKFLOW_LABEL,
  SUBAGENT_WORKFLOW_POSITION,
  SUBAGENT_WORKFLOW_RUN,
  SUBAGENT_WORKFLOW_STATUS,
  SUBAGENT_WORKFLOW_USAGE,
  subagentWorkflowAgentPositionLabel,
  subagentWorkflowUsageLabel,
} from '../subagent-copy';
import { REPLAY_MASK_CLASS } from '../../../../lib/replay-privacy';
import { Fact, FactList } from '../../../../primitives/FactList';

export interface SubagentWorkflowDetailsProps {
  readonly tree: SubagentTree;
  readonly node: SubagentNode;
  readonly onOpenWorkflow?: (runId: string) => void;
}

/** Workflow run context and usage for a workflow agent's chat. */
export function SubagentWorkflowDetails({
  tree,
  node,
  onOpenWorkflow,
}: SubagentWorkflowDetailsProps): JSX.Element {
  const workflow = node.workflow;
  const run = subagentWorkflowRunOf(tree, node);
  const runName = workflow?.runName ?? run?.workflow?.runName ?? run?.title;
  const runId = workflow?.runId ?? run?.workflow?.runId;
  const status = run ? subagentWorkflowRunStatusLine(tree, run) : undefined;
  const position = workflow
    ? subagentWorkflowAgentPositionLabel(
        workflow.agentPosition,
        workflow.agentCount,
        workflow.phaseIndex,
        workflow.phaseCount,
      )
    : null;
  const usage = workflow
    ? subagentWorkflowUsageLabel(workflow.tokens, workflow.toolCalls)
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <FactList>
        {runName || runId ? (
          <Fact label={SUBAGENT_WORKFLOW_RUN}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <SubagentWorkflowMark size={12} />
                {runName ? (
                  <span
                    className={`${REPLAY_MASK_CLASS} min-w-0 truncate`}
                    title={runName}
                  >
                    {runName}
                  </span>
                ) : null}
              </span>
              {runId ? (
                <span
                  className="truncate font-mono text-2xs fg-tertiary"
                  title={runId}
                >
                  {runId}
                </span>
              ) : null}
            </div>
          </Fact>
        ) : null}
        {status ? <Fact label={SUBAGENT_WORKFLOW_STATUS}>{status}</Fact> : null}
        {position ? (
          <Fact label={SUBAGENT_WORKFLOW_POSITION}>{position}</Fact>
        ) : null}
        {usage ? <Fact label={SUBAGENT_WORKFLOW_USAGE}>{usage}</Fact> : null}
      </FactList>
      {onOpenWorkflow && runId ? (
        <div>
          <Button
            variant="secondary"
            size="compact"
            data-testid="subagent-chat-open-workflow"
            onClick={(): void => onOpenWorkflow(runId)}
          >
            <ArrowUpRightIcon size={14} aria-hidden />
            {SUBAGENT_OPEN_WORKFLOW_LABEL}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
