import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS, type WorktreeData } from '@canopy/desktop-shared/types';
import { windowAgentInterfacePort } from '../agents/agent-interface-port';
import { createAgentChatWorktree } from '../lib/agent-chat-worktree';
import {
  launchCiCheckFixChat,
  launchMergeConflictResolutionChat,
  launchPrCommentTriageChat,
} from '../lib/builtin-gh-chat';
import { assertWritableScope } from '../lib/read-only-scope';
import {
  readAllSidebarItems,
  resolveWorktreeEffectiveFor,
} from '../lib/sidebar-items';
import { sendToAllWindows } from '../lib/window-send';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import { setWorktreeHooksPaused } from '../lib/workspace-script-hook-settings';
import { updateWorktree } from '../lib/worktree-update';
import { readPreferencesFile } from '../lib/preferences-store';
import { changeWorktreeHookPause } from '../services/hooks-service';
import { isSplitLocked } from '../services/split-lock-service';
import { getWorktreeDiffStatsOnly } from '../lib/worktree-service';
import type { AdvisorWorktreeActionHost } from './advisor-worktree-actions';

/**
 * The main owners behind App Advisor's moved worktree actions (CAN-5997).
 * Writes go through the keyed W5 boundaries as App Advisor; the updated row
 * is announced to every window, as main's other worktree writes are.
 */
export function mainAdvisorWorktreeActionHost(options: {
  getMainWindow: () => BrowserWindow | null;
  selectWorktree: AdvisorWorktreeActionHost['selectWorktree'];
  /** A fresh Git status read of the worktree; rejects when it fails. */
  /** The project's stored worktree rows. */
  readWorktrees?: (workspaceId: string) => Promise<WorktreeData[]>;
  readSourceStatus?: (
    projectId: string,
    worktreeId: string,
  ) => Promise<unknown>;
}): AdvisorWorktreeActionHost {
  const readSourceStatus = options.readSourceStatus ?? getWorktreeDiffStatsOnly;
  const readWorktrees = options.readWorktrees ?? readWorkspaceWorktrees;
  // The keyed writers return a portable projection, not the full row the
  // renderer keeps, so windows are told to reload the project's worktrees.
  const announce = (workspaceId: string): void => {
    sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, { workspaceId });
  };
  return {
    readItems: async () => (await readAllSidebarItems()).items,
    readWorktreeEffective: async (projectId, worktreeId) =>
      (
        await resolveWorktreeEffectiveFor(projectId, 'worktree.effective', [
          worktreeId,
        ])
      )[worktreeId],
    updateWorktree: async (request) => {
      const { worktree } = await updateWorktree(request);
      announce(request.workspaceId);
      return worktree;
    },
    setPausedHookKeys: async (request) => {
      const { worktree } = await changeWorktreeHookPause(
        {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          change: { kind: 'replace', pausedHookKeys: request.pausedHookKeys },
          source: 'app_advisor',
        },
        (change) =>
          setWorktreeHooksPaused({
            ...change,
            idempotencyKey: request.idempotencyKey,
          }),
      );
      announce(request.projectId);
      return worktree;
    },
    verifySourceStatus: async (projectId, worktreeId) => {
      // A fresh read, never the cached entry a failed refresh falls back to.
      try {
        await readSourceStatus(projectId, worktreeId);
        return true;
      } catch {
        return false;
      }
    },
    hasMainWindow: () => {
      const window = options.getMainWindow();
      return window !== null && !window.isDestroyed();
    },
    createWorktree: async (request) => {
      const created = await createAgentChatWorktree({
        ...request,
        callerSource: 'app-advisor',
        interfacePort: windowAgentInterfacePort(options.getMainWindow),
      });
      // Windows reload worktrees on a debounce; send the full list, which
      // they apply at once, so a following select finds the new row.
      if (created.status === 'created')
        sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, {
          workspaceId: request.workspaceId,
          worktrees: await readWorktrees(request.workspaceId),
        });
      return created;
    },
    isSplitLocked,
    launchFixChat: async (type, request) => {
      assertWritableScope(request.projectId);
      const startFixChat =
        type === 'worktree.start_ci_check_fix'
          ? launchCiCheckFixChat
          : type === 'worktree.start_merge_conflict_resolution'
            ? launchMergeConflictResolutionChat
            : launchPrCommentTriageChat;
      return startFixChat({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        ...(request.repoId ? { selectedRepoId: request.repoId } : {}),
        prefs: await readPreferencesFile(),
        context: {
          repoName: request.repoName,
          branchName: request.branchName,
        },
        getWindow: options.getMainWindow,
      });
    },
    selectWorktree: options.selectWorktree,
  };
}
