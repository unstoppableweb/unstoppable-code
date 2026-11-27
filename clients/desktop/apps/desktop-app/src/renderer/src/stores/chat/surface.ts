// Renderer-surface detection and Bot chat-state single-writer policy
// guards shared by the chat store modules.
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { isOneWindowEnabled } from '../oneWindowStore';
import { withRequiredPipelineEditorSkill } from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import { isCoworkChatTarget } from '@/lib/cowork';
import {
  isWorktreeArchiveSuppressedForChatActivity,
  useProjectsStore,
} from '../projectsStore';
import { useNavigationStore } from '../navigationStore';

export { withRequiredPipelineEditorSkill } from '@canopy/desktop-shared/lib/pipeline-editor-tools';

// ---------------------------------------------------------------------------
// Bot chat-state single-writer policy
// ---------------------------------------------------------------------------
//
// Bot chat state lives in BOTH renderers (the main window keeps a read-only
// mirror so the Sidebar can derive thinking/unread status; the Bot renderer
// owns the authoritative writes). Without a guard, both renderers
// would issue commands for the same target and race on
// `activeTabId`/unread/tab metadata.
//
// `__chatStoreSurface` records which renderer this module instance is
// running in (detected from the URL `surface` parameter at module load
// time, matching `main.tsx`'s `getRendererSurface`). All Bot writes
// (typed commands, Bot `activeTabId` mutations, Bot `attentionDismissedAt`
// persistence) are gated by `isSentinelWriteAllowed` so only the Bot renderer
// ever issues the canonical persisted state. The main renderer is restricted
// to nav-status-derivation
// in-memory updates (tab `status`/`unread`/`attentionDismissedAt`/
// `description`) — see Phase 8 of the frontend plan.
//
// Do NOT relax this guard to dual-writer behavior. Manual check 15 in the
// plan ("send several messages while hidden, reopen, transcript matches
// the nav-status implied") and the chat-store single-writer tests verify
// ownership stays one-sided.
export function detectChatStoreSurface(): 'main' | 'app-advisor' {
  if (typeof window === 'undefined' || !window.location) return 'main';
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('surface') === 'app-advisor' ? 'app-advisor' : 'main';
  } catch {
    return 'main';
  }
}

export const __chatStoreSurface: 'main' | 'app-advisor' =
  detectChatStoreSurface();

/**
 * The legacy pre-entry App Advisor slot `(app-advisor, 'global')`. Read-only:
 * it is not a valid destination for new messages and exists only so archived
 * pre-entry history remains browsable.
 */
export function isLegacyAppAdvisorGlobalTarget(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    // Default Bot only: the legacy global slot belongs to the Orchestrator.
    projectId === APP_ADVISOR_PROJECT_ID &&
    worktreeId === APP_ADVISOR_WORKTREE_ID
  );
}

/**
 * The embedded pipeline-editor assistant runs in the main window against the
 * pipeline-editor sentinel target. Like the other sentinel chats it is a
 * synthetic (non-worktree) target, and — unlike a normal Claude worktree chat —
 * it must always use the Canopy-native SDK runtime: the managed Claude Code
 * terminal cannot host the pipeline-editor MCP tools (and crashes in the
 * scratch cwd), so this target is forced to `canopy` interface mode everywhere.
 */
export function isPipelineEditorChatTarget(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    projectId === PIPELINE_EDITOR_PROJECT_ID &&
    worktreeId === PIPELINE_EDITOR_WORKTREE_ID
  );
}

export function withRequiredPluginSelectionsForTarget(
  projectId: string,
  worktreeId: string,
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections | undefined {
  return isPipelineEditorChatTarget(projectId, worktreeId)
    ? withRequiredPipelineEditorSkill(selections)
    : selections;
}

/**
 * Returns true when this renderer is allowed to persist/mutate the
 * canonical chat state for `(projectId, worktreeId)`. For non-Bot targets
 * this is always true; for Bot targets only the Bot renderer
 * (`__chatStoreSurface === 'app-advisor'`) may write. The main renderer falls
 * through to in-memory-only nav-status
 * derivation when this returns false.
 */
export function isSentinelWriteAllowed(
  projectId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  worktreeId: string,
): boolean {
  if (!isBotProjectId(projectId)) return true;
  return __chatStoreSurface === 'app-advisor';
}

export function isReadOnlyAppAdvisorMirrorTarget(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    isBotProjectId(projectId) && !isSentinelWriteAllowed(projectId, worktreeId)
  );
}

export function isSyntheticChatTarget(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    isCoworkChatTarget(projectId) ||
    projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
    projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
    isBotProjectId(projectId) ||
    isPipelineEditorChatTarget(projectId, worktreeId)
  );
}

/**
 * Whether closing a used chat tab archives it into the worktree
 * `ArchivedChatsFile` instead of hard-deleting. Cowork chats archive through
 * this same standard flow; the remaining synthetic scopes stay hard-delete.
 */
export function shouldArchiveChatTargetOnClose(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    isCoworkChatTarget(projectId) ||
    !isSyntheticChatTarget(projectId, worktreeId)
  );
}

export function canReceiveWorktreeChatActivity(
  projectId: string,
  worktreeId: string,
): boolean {
  if (isSyntheticChatTarget(projectId, worktreeId)) {
    return true;
  }

  if (isPairedComputerId(projectId)) {
    return isOneWindowEnabled();
  }

  if (isWorktreeArchiveSuppressedForChatActivity(projectId, worktreeId)) {
    return true;
  }

  const projectsState = useProjectsStore.getState();
  return canNavigateToWorktreeFromSidebarItems(
    projectsState.projects,
    projectId,
    worktreeId,
    projectsState.hasHydratedProjects,
  );
}

export function isAppAdvisorWindowFocused(): boolean {
  const navigation = useNavigationStore.getState();
  return navigation.appAdvisorOpen && navigation.appAdvisorFocused;
}
