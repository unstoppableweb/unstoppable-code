import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { isExplicitWorktreeBaseBranch } from '@canopy/protocol/portal';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isExactBase(value: unknown): boolean {
  return typeof value === 'string' && isExplicitWorktreeBaseBranch(value);
}

function usesExactBase(
  channel: string,
  request: Record<string, unknown>,
): boolean {
  switch (channel) {
    case IPC_CHANNELS.worktreeCreateBranch:
      return request.baseBranchSource === 'catalog';
    case IPC_CHANNELS.worktreeCreate:
    case IPC_CHANNELS.workspaceCreateWorktree:
      return isExactBase(request.baseBranch);
    case IPC_CHANNELS.automationsCreate:
    case IPC_CHANNELS.automationsUpdate:
      return (
        isRecord(request.action) &&
        request.action.type === 'worktree_prompt' &&
        isExactBase(request.action.baseBranch)
      );
    default:
      return false;
  }
}

/** Refuse a new selection after reconnecting to an older peer. */
export function assertLegacyWorktreeBaseRequest(
  channel: string,
  request: unknown,
): void {
  if (isRecord(request) && usesExactBase(channel, request))
    throw new Error('Update both desktops to use this base branch.');
}
