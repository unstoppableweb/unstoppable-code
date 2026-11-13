import type {
  PipelineExecutionListPage,
  PipelineExecutionListQuery,
} from '@canopy/core-runtime/node/pipeline';
import type { WorkerPipelineExecutionView } from '@canopy/protocol/canopy-core';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/execution-engine/types/pipeline';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import { projectPipelineExecutionView } from '@canopy/execution-engine/node/pipelines/execution-projection';

/*
 * `worker.pipeline.execution.list` over an execution store (CAN-6117). The
 * filters read the store's cached summaries, so a page loads and projects
 * only the executions it returns.
 */

/** A run's owner for filtering: one that recorded none is Personal. */
function ownerKey(summary: ExecutionSummary): string {
  const context = parseWorkspaceContext(
    summary.execution_context ?? 'personal',
  );
  if (context === null) return '';
  return context.kind === 'organization'
    ? `org:${context.organizationId.toLowerCase()}`
    : 'personal';
}

/** Every filter but run scope, which a summary can't always tell. */
function matches(
  summary: ExecutionSummary,
  query: PipelineExecutionListQuery,
): boolean {
  return (
    (query.workspaceId === undefined ||
      summary.project_id === query.workspaceId) &&
    (query.worktreeId === undefined ||
      summary.worktree_id === query.worktreeId) &&
    (query.owner === undefined || ownerKey(summary) === query.owner) &&
    (query.pipelineId === undefined ||
      summary.pipeline_id === query.pipelineId) &&
    (query.statuses === undefined || query.statuses.includes(summary.status))
  );
}

type RunScope = NonNullable<PipelineExecutionListQuery['runScopes']>[number];

/**
 * The run scopes an execution may have from its summary alone. A run without
 * a worktree is a directory or a global run; one with a worktree is a
 * worktree run or a directory run that keeps its worktree for listing, as
 * Cowork and App Advisor runs do. Only the state tells either pair apart.
 */
function summaryRunScopes(summary: ExecutionSummary): readonly RunScope[] {
  return summary.worktree_id !== undefined
    ? ['worktree', 'directory']
    : ['directory', 'global'];
}

interface ListKey {
  readonly id: string;
  readonly time: number;
}

/** Newest first, then by execution id in code-unit order, both descending. */
function before(left: ListKey, right: ListKey): number {
  if (left.time !== right.time) return right.time - left.time;
  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}

/**
 * One list page. `summaries` is every execution the store holds; `load`
 * reads one execution's current state, `null` once it is gone.
 */
export async function listPipelineExecutionPage(
  summaries: readonly ExecutionSummary[],
  load: (executionId: string) => Promise<ExecutionState | null>,
  query: PipelineExecutionListQuery,
): Promise<PipelineExecutionListPage> {
  const after: ListKey | null = query.after && {
    id: query.after.executionId,
    time: Date.parse(query.after.startedAt),
  };
  const { runScopes } = query;
  const candidates = summaries
    .filter((summary) => matches(summary, query))
    .filter(
      (summary) =>
        runScopes === undefined ||
        summaryRunScopes(summary).some((scope) => runScopes.includes(scope)),
    )
    .map((summary) => ({
      id: summary.id,
      time: Date.parse(summary.started_at),
      // Only a filter that tells two of a summary's possible scopes apart reads state.
      exact:
        runScopes === undefined ||
        summaryRunScopes(summary).every((scope) => runScopes.includes(scope)),
    }))
    .filter(({ time }) => !Number.isNaN(time))
    .sort(before)
    .filter((key) => after === null || before(after, key) < 0);
  const executions: WorkerPipelineExecutionView[] = [];
  let index = 0;
  for (
    ;
    index < candidates.length && executions.length < query.limit;
    index++
  ) {
    const state = await load(candidates[index].id);
    if (state === null) continue;
    const view = projectPipelineExecutionView(state, { detail: query.detail });
    if (
      candidates[index].exact ||
      runScopes?.includes(view.execution.runScope) === true
    )
      executions.push(view);
  }
  // A full page leaves `index` on the first candidate it didn't read.
  return { executions, more: index < candidates.length };
}
