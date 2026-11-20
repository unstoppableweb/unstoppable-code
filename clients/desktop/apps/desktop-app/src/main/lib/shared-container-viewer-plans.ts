import type {
  TrackedPlanData,
  TrackedPlanListRequest,
  TrackedPlanSource,
} from '@canopy/desktop-shared/types';
import { getSharedContainerReader } from '../shared-containers/read/reader';
import { resolveSharedContainerViewerReadRoots } from '../shared-containers/read/viewer-root';

/*
 * A shared-container recipient's plans (the viewer project's read-only
 * scope), read from the container's sealed revision rather than the
 * tracked-plans store.
 */

const TRACKED_PLAN_SOURCES: ReadonlySet<string> = new Set<TrackedPlanSource>([
  'antigravity',
  'cursor',
  'claude',
  'codex',
  'opencode',
  'ollama',
  'pipeline',
  'imported',
  'detected',
]);

function isTrackedPlanSource(value: string): value is TrackedPlanSource {
  return TRACKED_PLAN_SOURCES.has(value);
}

export async function listViewerPlans(
  request: TrackedPlanListRequest,
): Promise<TrackedPlanData[]> {
  const roots = await resolveSharedContainerViewerReadRoots(request.worktreeId);
  const revisionId = roots[0]?.revisionId;
  if (!revisionId) return [];
  const reader = getSharedContainerReader();
  const summaries = [];
  let cursor: string | undefined;
  do {
    const page = await reader.listPlans({
      containerId: request.worktreeId,
      revisionId,
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    summaries.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return Promise.all(
    summaries.map(async ({ planId }) => {
      const plan = await reader.readPlan({
        containerId: request.worktreeId,
        revisionId,
        planId,
      });
      const source = isTrackedPlanSource(plan.source)
        ? plan.source
        : 'imported';
      const reviewStatus =
        plan.reviewStatus === 'approved' || plan.reviewStatus === 'dismissed'
          ? plan.reviewStatus
          : 'pending';
      return {
        id: plan.planId,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        source,
        title: plan.title,
        content: plan.content,
        reviewStatus,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        latestRevisionNumber: plan.latestRevisionNumber,
        ...(plan.approvedAt ? { approvedAt: plan.approvedAt } : {}),
        ...(plan.dismissedAt ? { dismissedAt: plan.dismissedAt } : {}),
        revisions: [],
        linkedExecutionIds: [],
        commentThreads: plan.commentThreads,
        ...(plan.lastEditSource === 'agent' ||
        plan.lastEditSource === 'pipeline'
          ? { lastEditSource: plan.lastEditSource }
          : {}),
        ...(plan.sourceRepoId ? { sourceRepoId: plan.sourceRepoId } : {}),
        ...(plan.sourceFilePath ? { sourceFilePath: plan.sourceFilePath } : {}),
      } satisfies TrackedPlanData;
    }),
  );
}
