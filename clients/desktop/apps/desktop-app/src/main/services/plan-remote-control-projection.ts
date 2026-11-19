import type {
  RemoteControlEntityEnvelope,
  RemoteControlPlanDetail,
  RemoteControlPlanSummary,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { worktreeScopedParentLocalId } from '@canopy/protocol/remote-control/shell';

/** The Portal's view of tracked plans: its summary, detail and entity shapes. */

export function toPlanSummary(plan: TrackedPlanData): RemoteControlPlanSummary {
  return {
    workspaceLocalId: plan.projectId,
    worktreeLocalId: plan.worktreeId,
    planId: plan.id,
    title: plan.title,
    status: plan.reviewStatus,
    source: plan.source,
    // Only imported plans name their source file; detected plans keep the
    // path as a local dedup key and agent plans have none.
    ...(plan.source === 'imported' && plan.sourceFilePath
      ? { sourceFilePath: plan.sourceFilePath }
      : {}),
    updatedAt: plan.updatedAt,
  };
}

export function toPlanDetail(plan: TrackedPlanData): RemoteControlPlanDetail {
  return {
    ...toPlanSummary(plan),
    // Transport plan §1.4: `content` is the canonical markdown body field.
    // `body` is retained for backward compatibility with pre-rollout
    // payloads — emitters MUST populate `content` and consumers MAY fall
    // back to `body` for in-flight legacy frames.
    content: plan.content,
    body: plan.content,
    reviewStatus: plan.reviewStatus,
    approvedAt: plan.approvedAt ?? null,
    dismissedAt: plan.dismissedAt ?? null,
    hidden: plan.hidden,
    latestRevisionNumber: plan.latestRevisionNumber,
    // Mirror the canonical revision counter under the shorter alias too so
    // renderers that just want "v3" can read `revisionNumber` directly.
    revisionNumber: plan.latestRevisionNumber,
  };
}

/** Historical reads must never substitute the current revision's Markdown. */
export function toRequestedPlanDetail(
  plan: TrackedPlanData,
  revisionNumber: number | undefined,
): RemoteControlPlanDetail | null {
  const detail = toPlanDetail(plan);
  if (
    revisionNumber === undefined ||
    revisionNumber === plan.latestRevisionNumber
  ) {
    return detail;
  }
  const revision = plan.revisions.find(
    (candidate) => candidate.revisionNumber === revisionNumber,
  );
  if (!revision) return null;
  return {
    ...detail,
    content: revision.content,
    body: revision.content,
    revisionNumber: revision.revisionNumber,
    source: revision.source,
    status: revision.reviewStatus,
    reviewStatus: revision.reviewStatus,
    approvedAt: revision.approvedAt ?? null,
    dismissedAt: revision.dismissedAt ?? null,
  };
}

export function planToRemoteControlEntity(
  plan: RemoteControlPlanSummary,
): RemoteControlEntityEnvelope {
  return {
    entityType: 'plan',
    localId: plan.planId,
    parentLocalId: worktreeScopedParentLocalId(
      plan.workspaceLocalId,
      plan.worktreeLocalId,
    ),
    payload: plan,
  };
}
