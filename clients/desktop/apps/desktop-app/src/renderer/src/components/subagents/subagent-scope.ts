/**
 * Identity helpers shared by the desktop subagent viewer hosts: the
 * worktree, Work Entry or App Advisor scope a Subagents panel and its
 * subagent chats belong to.
 */
import { isWebCoreScope } from '@/lib/chat-authority';
import { isCoworkChatTarget } from '@/lib/cowork';

/** The worktree (or Cowork Work Entry / App Advisor slot) a panel lives in. */
export interface SubagentHostScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

/** A root chat inside a scope. */
export interface SubagentRootChatTarget extends SubagentHostScope {
  readonly chatId: string;
}

/**
 * The shared view-state store's scope key: one Subagents panel per
 * worktree, Work Entry or App Advisor (D4).
 */
export function subagentScopeKey(scope: SubagentHostScope): string {
  return `${scope.projectId}/${scope.worktreeId}`;
}

/**
 * Whether the scope has a worktree whose workspace and changes the viewer
 * may show (D27). Work Entry (Cowork) and App Advisor scopes do not; the
 * panel layout's own surface classification decides it, the same way the
 * panel registry picks a scope's default layout. Nor does a cloud scope:
 * its worktree isn't on this computer (CAN-7133).
 */
export function subagentScopeShowsWorkspaceDetails(
  scope: SubagentHostScope,
): boolean {
  return (
    !isCoworkChatTarget(scope.projectId) && !isWebCoreScope(scope.projectId)
  );
}
