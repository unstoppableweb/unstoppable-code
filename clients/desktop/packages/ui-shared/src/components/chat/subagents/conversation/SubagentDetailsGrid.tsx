import type { JSX, ReactNode } from 'react';
import type { SubagentNode, SubagentTree } from '@canopy/agent-transcript';
import type { SubagentWorktreeSummaryState } from '../types';
import {
  SUBAGENT_DETAILS_LINEAGE,
  SUBAGENT_DETAILS_COST,
  SUBAGENT_DETAILS_SETUP,
  SUBAGENT_DETAILS_WORKFLOW,
  SUBAGENT_DETAILS_WORKTREE,
} from '../subagent-copy';
import type { SubagentLineageTarget } from './SubagentLineageDetails';
import { SubagentLineageDetails } from './SubagentLineageDetails';
import { SubagentSetupDetails } from './SubagentSetupDetails';
import { SubagentWorktreeDetails } from './SubagentWorktreeDetails';
import { SubagentWorkflowDetails } from './SubagentWorkflowDetails';
import { Heading } from '../../../../primitives/Heading';

export interface SubagentDetailsGridProps {
  readonly layout: 'columns' | 'stacked';
  readonly tree: SubagentTree;
  readonly node: SubagentNode;
  readonly ancestors: readonly SubagentNode[];
  readonly executionMode?: 'foreground' | 'background';
  readonly worktree?: SubagentWorktreeSummaryState;
  /** The Cost section body; when set, Setup drops its Usage row. */
  readonly cost?: ReactNode;
  readonly onOpenLineage: (target: SubagentLineageTarget) => void;
  readonly onShowChanges?: () => void;
  readonly onOpenWorkflow?: (runId: string) => void;
  /** Tallest the details may grow before they scroll, in pixels. */
  readonly maxHeight?: number;
}

/** Details height cap when the host has not measured its panel yet. */
const DEFAULT_DETAILS_MAX_HEIGHT = 256;

/** Setup and Lineage with optional Worktree or Workflow details. */
export function SubagentDetailsGrid({
  layout,
  tree,
  node,
  ancestors,
  executionMode,
  worktree,
  cost,
  onOpenLineage,
  onShowChanges,
  onOpenWorkflow,
  maxHeight = DEFAULT_DETAILS_MAX_HEIGHT,
}: SubagentDetailsGridProps): JSX.Element {
  const showWorkflow = node.kind === 'workflow-agent';
  const showWorktree = !showWorkflow && worktree !== undefined;
  // Cost takes a column after Setup; Worktree or Workflow adds the final column.
  const costColumn = cost === undefined ? '' : ' minmax(0, 1fr)';
  const columns =
    showWorkflow || showWorktree
      ? `minmax(0, 1fr)${costColumn} minmax(0, 1fr) minmax(0, 1.2fr)`
      : `minmax(0, 1.2fr)${costColumn} minmax(0, 1fr)`;
  return (
    <div
      className="grid grid-cols-1 items-start gap-x-8 gap-y-5 overflow-y-auto overscroll-contain border-t px-4 pb-4 pt-3"
      data-layout={layout}
      data-testid="subagent-chat-details"
      style={{
        maxHeight,
        ...(layout === 'columns' ? { gridTemplateColumns: columns } : {}),
      }}
    >
      <section
        data-testid="subagent-chat-details-setup"
        className="flex min-w-0 flex-col gap-2"
      >
        <Heading level={3} variant="label">
          {SUBAGENT_DETAILS_SETUP}
        </Heading>
        <SubagentSetupDetails
          node={node}
          executionMode={executionMode}
          showUsage={cost === undefined}
        />
      </section>
      {cost !== undefined ? (
        <section
          data-testid="subagent-chat-details-cost"
          className="flex min-w-0 flex-col gap-2"
        >
          <Heading level={3} variant="label">
            {SUBAGENT_DETAILS_COST}
          </Heading>
          {cost}
        </section>
      ) : null}
      <section
        data-testid="subagent-chat-details-lineage"
        className="flex min-w-0 flex-col gap-2"
      >
        <Heading level={3} variant="label">
          {SUBAGENT_DETAILS_LINEAGE}
        </Heading>
        <SubagentLineageDetails
          tree={tree}
          node={node}
          ancestors={ancestors}
          onOpenLineage={onOpenLineage}
        />
      </section>
      {showWorkflow ? (
        <section
          data-testid="subagent-chat-details-workflow"
          className="flex min-w-0 flex-col gap-2"
        >
          <Heading level={3} variant="label">
            {SUBAGENT_DETAILS_WORKFLOW}
          </Heading>
          <SubagentWorkflowDetails
            tree={tree}
            node={node}
            onOpenWorkflow={onOpenWorkflow}
          />
        </section>
      ) : null}
      {showWorktree && worktree ? (
        <section
          data-testid="subagent-chat-details-worktree"
          className="flex min-w-0 flex-col gap-2"
        >
          <Heading level={3} variant="label">
            {SUBAGENT_DETAILS_WORKTREE}
          </Heading>
          <SubagentWorktreeDetails
            state={worktree}
            onShowChanges={onShowChanges}
          />
        </section>
      ) : null}
    </div>
  );
}
