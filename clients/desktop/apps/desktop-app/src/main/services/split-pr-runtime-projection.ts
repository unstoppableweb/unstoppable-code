import type {
  PortalWorktreeSplitPrStatus,
  PortalSessionShellState,
} from '@canopy/protocol/portal';
import type { SplitPrProgressEvent } from '@canopy/desktop-shared/types/github';
import { requestDesktopSessionSnapshotInvalidation } from './desktop-session-snapshot-invalidation';

type SplitPrProjection = Pick<
  PortalSessionShellState['worktrees'][number],
  'splitPrStatus' | 'splitPrStatusMessage'
>;

export interface SplitPrProgressProjection {
  readonly status: PortalWorktreeSplitPrStatus;
  readonly message: string;
  readonly locked: boolean;
}

const runtimeByWorktree = new Map<string, SplitPrProjection>();

function key(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}/${worktreeId}`;
}

export function setSplitPrRuntimeProjection(
  workspaceId: string,
  worktreeId: string,
  status: PortalWorktreeSplitPrStatus,
  message: string,
): void {
  runtimeByWorktree.set(key(workspaceId, worktreeId), {
    splitPrStatus: status,
    splitPrStatusMessage: message,
  });
  requestDesktopSessionSnapshotInvalidation('split-pr.set');
}

export function clearSplitPrRuntimeProjection(
  workspaceId: string,
  worktreeId: string,
): void {
  if (runtimeByWorktree.delete(key(workspaceId, worktreeId))) {
    requestDesktopSessionSnapshotInvalidation('split-pr.clear');
  }
}

export function getSplitPrRuntimeProjection(
  workspaceId: string,
  worktreeId: string,
): SplitPrProjection | undefined {
  return runtimeByWorktree.get(key(workspaceId, worktreeId));
}

export function projectSplitPrProgress(
  event: SplitPrProgressEvent,
): SplitPrProgressProjection {
  if (event.phase === 'done') {
    return {
      status: 'completed',
      message: 'All child PRs created',
      locked: false,
    };
  }
  if (event.phase === 'error' || event.phase === 'cancelled') {
    return {
      status: 'failed',
      message:
        event.error ??
        event.message ??
        (event.phase === 'cancelled'
          ? 'Split cancelled'
          : 'Preparing the split'),
      locked: false,
    };
  }
  return {
    status: 'running',
    message: event.error ?? event.message ?? 'Preparing the split',
    locked: true,
  };
}
