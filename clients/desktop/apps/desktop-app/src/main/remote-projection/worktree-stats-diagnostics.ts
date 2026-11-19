import { performance } from 'node:perf_hooks';
import { getObservabilityService } from '../observability';

export function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

export function elapsedSinceTimestamp(
  timestamp: string,
  nowMs = Date.now(),
): number | undefined {
  const startedAt = Date.parse(timestamp);
  if (!Number.isFinite(startedAt)) {
    return undefined;
  }
  return Math.max(0, nowMs - startedAt);
}

export function recordWorktreeStatsTiming(input: {
  workspaceId: string;
  worktreeId: string;
  elapsedMs: number;
  diffStatsElapsedMs?: number;
  skipFetch?: boolean;
  mode: 'full' | 'diff_only';
  outcome?: 'success' | 'failure';
}): void {
  try {
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'worktree_stats_timing',
      sessionKey: `worktree-stats:${input.workspaceId}:${input.worktreeId}`,
      projectId: input.workspaceId,
      worktreeId: input.worktreeId,
      chatId: '',
      providerType: 'unknown',
      elapsedMs: input.elapsedMs,
      worktreeStatsMode: input.mode,
      ...(input.outcome === undefined
        ? {}
        : { worktreeStatsOutcome: input.outcome }),
      ...(input.skipFetch === undefined
        ? {}
        : { worktreeStatsSkipFetch: input.skipFetch }),
      ...(input.diffStatsElapsedMs === undefined
        ? {}
        : { diffStatsElapsedMs: input.diffStatsElapsedMs }),
    });
  } catch {
    // Diagnostics must never affect stats collection.
  }
}
