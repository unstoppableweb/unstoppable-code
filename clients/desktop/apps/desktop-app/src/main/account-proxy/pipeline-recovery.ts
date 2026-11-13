import { createHash } from 'node:crypto';
import type { ResumeQueueEntry } from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import {
  loadExecutionState,
  listExecutionSummaries,
} from '@canopy/execution-engine/node/pipelines/executor';
import {
  canResumeAccountProxyChat,
  type AccountProxyPipelineInterruption,
} from './quota-recovery';

/** Includes matrix and nested reasons projected onto their owning root run. */
export function projectAccountProxyPipelineInterruptions(
  state: ExecutionState,
  workspaceName = 'Local workflows',
): AccountProxyPipelineInterruption[] {
  if (
    state.hidden ||
    state.parent_execution_id ||
    (state.status !== 'paused' && state.status !== 'running')
  )
    return [];
  const grouped = new Map<
    string,
    { connectionId: string; reasons: ExecutionState['status_reasons'] }
  >();
  for (const reason of state.status_reasons) {
    const connectionId = reason.account_proxy_connection_id;
    if (
      !connectionId ||
      reason.kind !== 'provider_usage_limit' ||
      reason.auto_resume_suppressed ||
      (reason.provider !== 'claude' && reason.provider !== 'codex')
    )
      continue;
    const step = state.jobs[reason.source.job_id]?.steps[reason.source.step_id];
    if (!step?.agent_recovery && !reason.source.child_execution_id) continue;
    // Separate pools for each harness can recover at different times.
    const key = JSON.stringify([connectionId, reason.provider]);
    const group = grouped.get(key) ?? { connectionId, reasons: [] };
    group.reasons.push(reason);
    grouped.set(key, group);
  }
  return Array.from(
    grouped.values(),
    ({ connectionId, reasons }): AccountProxyPipelineInterruption => {
      const requirements = reasons.flatMap((reason) => {
        const provider = reason.provider;
        const detectedAt = Date.parse(reason.detected_at);
        if (!provider || !Number.isFinite(detectedAt)) return [];
        const resetsAt = reason.resets_at ? Date.parse(reason.resets_at) : NaN;
        return [
          {
            provider,
            accountProxyConnectionId: connectionId,
            detectedAt,
            ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
          },
        ];
      });
      const ids = reasons.map((reason) => reason.id).sort();
      return {
        requirements,
        item: {
          target: {
            kind: 'pipeline',
            executionId: state.id,
            statusReasonIds: ids,
          },
          accountProxyConnectionId: connectionId,
          accountProxyDetectedAt: Math.max(
            ...requirements.map((entry) => entry.detectedAt),
          ),
          providers: Array.from(
            new Set(requirements.map((entry) => entry.provider)),
          ),
          interruptionId: `proxy-reasons:${createHash('sha256').update(JSON.stringify(ids)).digest('hex')}`,
          title: state.pipeline_snapshot.name,
          workspaceName,
        },
      };
    },
  ).filter((entry) => entry.requirements.length > 0);
}

export async function readAccountProxyPipelineInterruptions(
  executionsDir: string,
  resolveWorkspaceName?: (
    projectId: string,
    worktreeId?: string,
  ) => Promise<string | undefined>,
): Promise<AccountProxyPipelineInterruption[]> {
  const summaries = await listExecutionSummaries(executionsDir);
  const interrupted: AccountProxyPipelineInterruption[] = [];
  for (const summary of summaries) {
    if (
      summary.hidden ||
      summary.parent_execution_id ||
      (summary.status !== 'paused' && summary.status !== 'running')
    )
      continue;
    const state = await loadExecutionState(summary.id, executionsDir).catch(
      () => null,
    );
    if (state) {
      const workspaceName = state.project_id
        ? await resolveWorkspaceName?.(state.project_id, state.worktree_id)
        : undefined;
      interrupted.push(
        ...projectAccountProxyPipelineInterruptions(state, workspaceName),
      );
    }
  }
  return interrupted;
}

export function canResumeAccountProxyPipelineEntry(
  entry: ResumeQueueEntry,
  state: ExecutionState | null,
  status: AccountProxyStatus,
  now: number,
): boolean {
  if (entry.target.kind !== 'pipeline' || !state) return false;
  const current = projectAccountProxyPipelineInterruptions(state);
  const selected = new Set(entry.target.statusReasonIds);
  const matching = current.filter(
    (candidate) =>
      candidate.item.accountProxyConnectionId ===
        entry.accountProxyConnectionId &&
      candidate.item.target.kind === 'pipeline' &&
      candidate.item.target.statusReasonIds.some((id) => selected.has(id)),
  );
  const currentIds = new Set(
    matching.flatMap((candidate) =>
      candidate.item.target.kind === 'pipeline'
        ? candidate.item.target.statusReasonIds
        : [],
    ),
  );
  if (
    !matching.length ||
    !entry.target.statusReasonIds.every((id) => currentIds.has(id))
  )
    return false;
  return matching
    .flatMap((candidate) => candidate.requirements)
    .every((requirement) =>
      canResumeAccountProxyChat(requirement, status, now),
    );
}
