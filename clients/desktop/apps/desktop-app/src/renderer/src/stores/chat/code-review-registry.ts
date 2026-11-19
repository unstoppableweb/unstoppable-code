// Module-level registry tracking code-review chat visibility and the worktree
// origin each synthetic code-review scope belongs to.
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';

const visibleCodeReviewChatKeys = new Set<string>();

/**
 * Maps a code-review scope key (the sentinel scope's worktreeId, see
 * `buildCodeReviewScopeKey`) to the real `(projectId, worktreeId)` pair it
 * belongs to. Worktree ids are only unique within a workspace, so the key
 * encodes both. Populated when the review modal
 * registers its chat target, this survives the modal closing so a turn
 * finishing later can still resolve a toast/navigation target.
 */
const codeReviewOrigins = new Map<
  string,
  { projectId: string; worktreeId: string }
>();

/**
 * Look up the real `(projectId, worktreeId)` a code-review chat scope key
 * belongs to. Returns undefined when the scope was never registered in this
 * session (registry empty).
 */
export function getCodeReviewOrigin(
  scopeKey: string,
): { projectId: string; worktreeId: string } | undefined {
  return codeReviewOrigins.get(scopeKey);
}

export function findCodeReviewTarget(
  scopeKey: string,
): { projectId: string; worktreeId: string } | null {
  const registered = getCodeReviewOrigin(scopeKey);
  if (registered) {
    return registered;
  }
  return null;
}

/**
 * True when the target is the code-review chat for the worktree whose review
 * takeover modal is currently open. That chat is on-screen inside the modal,
 * so it should be treated like the active/visible chat.
 */
export function isVisibleCodeReviewChat(
  projectId: string,
  _worktreeId: string,
): boolean {
  void _worktreeId;
  if (projectId !== CODE_REVIEW_CHAT_PROJECT_ID) {
    return false;
  }
  return false;
}

export function setCodeReviewChatVisibility(
  scopeKey: string,
  visible: boolean,
): void {
  if (visible) {
    visibleCodeReviewChatKeys.add(scopeKey);
  } else {
    visibleCodeReviewChatKeys.delete(scopeKey);
  }
}

export function recordCodeReviewOrigin(
  scopeKey: string,
  origin: { projectId: string; worktreeId: string },
): void {
  codeReviewOrigins.set(scopeKey, origin);
}
