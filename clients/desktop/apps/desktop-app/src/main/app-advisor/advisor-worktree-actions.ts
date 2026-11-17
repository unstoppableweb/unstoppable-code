import { BRAND } from '@canopy/brand/current';
import { z } from 'zod';
import {
  workspaceSummary,
  worktreeSummary,
} from '@canopy/desktop-shared/lib/app-advisor-worktree-summaries';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import type {
  AppAdvisorAction,
  AppAdvisorActionError,
  AppAdvisorActionResponse,
  MultiRepoSidebarItem,
  SidebarItem,
  SingleRepoSidebarItem,
  WorktreeData,
  WorktreeEffectiveOverrides,
} from '@canopy/desktop-shared/types';
import type { AgentChatWorktreeResult } from '../lib/agent-chat-worktree';

/*
 * CAN-5997: App Advisor's worktree settings reads and writes, worktree
 * creation and the three fix-chat starts, in Electron main. Each answers as
 * the renderer dispatcher did, from main's own owners: the sidebar items,
 * the keyed core.worktree.update and core.worktree.hooks.setPaused writers,
 * the keyed core.worktree.create writer, the Split lock and the fix-chat
 * launchers. Selecting a worktree is a best-effort presentation.
 */

export const ADVISOR_WORKTREE_ACTION_TYPES = [
  'worktree.get_settings',
  'worktree.update_settings',
  'worktree.create',
  'worktree.start_ci_check_fix',
  'worktree.start_merge_conflict_resolution',
  'worktree.start_pr_comment_triage',
] as const;

type AdvisorWorktreeActionType = (typeof ADVISOR_WORKTREE_ACTION_TYPES)[number];

export type AdvisorWorktreeAction = Extract<
  AppAdvisorAction,
  { type: AdvisorWorktreeActionType }
>;

type FixChatAction = Extract<
  AdvisorWorktreeAction,
  {
    type:
      | 'worktree.start_ci_check_fix'
      | 'worktree.start_merge_conflict_resolution'
      | 'worktree.start_pr_comment_triage';
  }
>;

export function isAdvisorWorktreeAction(action: {
  type: string;
}): action is AdvisorWorktreeAction {
  return ADVISOR_WORKTREE_ACTION_TYPES.some((type) => type === action.type);
}

/** The main owners these actions use; tests replace them. */
export interface AdvisorWorktreeActionHost {
  readItems(): Promise<SidebarItem[]>;
  /** One worktree's own scripts and hooks, resolved on demand (CAN-6933). */
  readWorktreeEffective(
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeEffectiveOverrides | undefined>;
  updateWorktree(request: {
    workspaceId: string;
    worktreeId: string;
    patch:
      | { hidden: boolean }
      | { branchGroupingOverride: 'group' | 'ungroup' | null };
    idempotencyKey: string;
  }): Promise<WorktreeData>;
  setPausedHookKeys(request: {
    projectId: string;
    worktreeId: string;
    pausedHookKeys: readonly string[];
    idempotencyKey: string;
  }): Promise<WorktreeData>;
  /** The worktree's fresh Git status could be read. */
  verifySourceStatus(projectId: string, worktreeId: string): Promise<boolean>;
  createWorktree(request: {
    workspaceId: string;
    baseWorktreeId?: string;
    baseBranch?: string;
    idempotencyKey: string;
  }): Promise<AgentChatWorktreeResult>;
  isSplitLocked(projectId: string, worktreeId: string): boolean;
  /** The fix-chat launchers show the new chat in the main window and need it. */
  hasMainWindow(): boolean;
  launchFixChat(
    type: FixChatAction['type'],
    request: {
      projectId: string;
      worktreeId: string;
      repoId?: string;
      repoName?: string;
      branchName?: string;
    },
  ): Promise<{ chatId: string }>;
  /** Selects the worktree in the main window when a lease serves it; never throws. */
  selectWorktree(projectId: string, worktreeId: string): Promise<void>;
}

export interface AdvisorWorktreeActionCall {
  requestId: string;
  /** A per-step idempotency key derived from the tool call. */
  keyFor(step: string): string;
}

type Outcome = Omit<AppAdvisorActionResponse, 'requestId'>;

const FIX_CHAT_NEEDS_WINDOW: AppAdvisorActionError = {
  code: 'surface_unavailable',
  message: `Starting a fix chat needs the ${BRAND.displayName} window open. Open the app and try again.`,
  retryable: true,
};

const SPLIT_LOCKED: AppAdvisorActionError = {
  code: 'surface_unavailable',
  message:
    'A Split PR is in progress for this worktree; it is locked until the split finishes.',
  retryable: true,
};

function failure(error: AppAdvisorActionError): Outcome {
  return { ok: false, error };
}

function findWorkspace(
  items: SidebarItem[],
  workspaceId: string,
): SidebarItem | { error: AppAdvisorActionError } {
  const workspace = items.find(
    (item) => item.id === workspaceId && !isRetiredTemporaryWorkspace(item),
  );
  return (
    workspace ?? {
      error: {
        code: 'not_found',
        message: `Project ${workspaceId} was not found.`,
      },
    }
  );
}

function findGitWorktree(
  items: SidebarItem[],
  projectId: string,
  worktreeId: string,
):
  | {
      workspace: SingleRepoSidebarItem | MultiRepoSidebarItem;
      worktree: WorktreeData;
    }
  | { error: AppAdvisorActionError } {
  const workspace = findWorkspace(items, projectId);
  if ('error' in workspace) return workspace;
  if (workspace.type === 'cowork')
    return {
      error: {
        code: 'unsupported_action',
        message: `Project ${projectId} is a cowork project and has no git worktrees.`,
      },
    };
  const worktree = workspace.worktrees.find(
    (candidate) => candidate.id === worktreeId,
  );
  if (!worktree)
    return {
      error: {
        code: 'not_found',
        message: `Worktree ${worktreeId} was not found in project ${projectId}.`,
      },
    };
  return { workspace, worktree };
}

function jsonValue(value: unknown): z.output<ReturnType<typeof z.json>> {
  return z.json().parse(JSON.parse(JSON.stringify(value ?? null)));
}

async function getSettings(
  action: Extract<AdvisorWorktreeAction, { type: 'worktree.get_settings' }>,
  host: AdvisorWorktreeActionHost,
): Promise<Outcome> {
  const target = findGitWorktree(
    await host.readItems(),
    action.projectId,
    action.worktreeId,
  );
  if ('error' in target) return failure(target.error);
  return {
    ok: true,
    result: {
      workspace: workspaceSummary(target.workspace),
      worktree: worktreeSummary(target.worktree),
      effectiveOverrides: jsonValue(
        await host.readWorktreeEffective(action.projectId, action.worktreeId),
      ),
    },
  };
}

async function updateSettings(
  action: Extract<AdvisorWorktreeAction, { type: 'worktree.update_settings' }>,
  host: AdvisorWorktreeActionHost,
  call: AdvisorWorktreeActionCall,
): Promise<Outcome> {
  const target = findGitWorktree(
    await host.readItems(),
    action.projectId,
    action.worktreeId,
  );
  if ('error' in target) return failure(target.error);
  if (action.hidden !== undefined)
    await host.updateWorktree({
      workspaceId: action.projectId,
      worktreeId: action.worktreeId,
      patch: { hidden: action.hidden },
      idempotencyKey: call.keyFor('hidden'),
    });
  if (action.pausedHookKeys !== undefined)
    await host.setPausedHookKeys({
      projectId: action.projectId,
      worktreeId: action.worktreeId,
      pausedHookKeys: action.pausedHookKeys,
      idempotencyKey: call.keyFor('paused-hooks'),
    });
  if (action.branchGroupingOverride !== undefined)
    await host.updateWorktree({
      workspaceId: action.projectId,
      worktreeId: action.worktreeId,
      patch: { branchGroupingOverride: action.branchGroupingOverride },
      idempotencyKey: call.keyFor('branch-grouping'),
    });
  const refreshed = findGitWorktree(
    await host.readItems(),
    action.projectId,
    action.worktreeId,
  );
  const workspace =
    'error' in refreshed ? target.workspace : refreshed.workspace;
  const worktree = 'error' in refreshed ? target.worktree : refreshed.worktree;
  return {
    ok: true,
    result: {
      workspace: workspaceSummary(workspace),
      worktree: worktreeSummary(worktree),
    },
  };
}

async function createWorktree(
  action: Extract<AdvisorWorktreeAction, { type: 'worktree.create' }>,
  host: AdvisorWorktreeActionHost,
  call: AdvisorWorktreeActionCall,
): Promise<Outcome> {
  if (action.baseWorktreeId !== undefined && action.baseBranch !== undefined)
    return failure({
      code: 'invalid_payload',
      message: 'Action worktree.create has invalid baseBranch.',
    });
  const workspace = findWorkspace(await host.readItems(), action.workspaceId);
  if ('error' in workspace) return failure(workspace.error);
  if (
    action.baseWorktreeId &&
    !(await host.verifySourceStatus(action.workspaceId, action.baseWorktreeId))
  )
    return failure({
      code: 'execution_failed',
      message: 'Fresh source worktree status could not be verified.',
      retryable: true,
    });
  const created = await host.createWorktree({
    workspaceId: action.workspaceId,
    ...(action.baseWorktreeId ? { baseWorktreeId: action.baseWorktreeId } : {}),
    ...(action.baseBranch ? { baseBranch: action.baseBranch } : {}),
    idempotencyKey: call.keyFor('worktree'),
  });
  if (created.status === 'needs-repair')
    return failure({
      code: 'surface_unavailable',
      message: created.message,
      retryable: false,
    });
  if (created.status === 'unavailable')
    return failure({
      code: 'execution_failed',
      message: created.message,
      retryable: true,
    });
  if (action.select !== false)
    await host.selectWorktree(action.workspaceId, created.worktreeId);
  return {
    ok: true,
    result: { workspaceId: action.workspaceId, worktreeId: created.worktreeId },
  };
}

async function startFixChat(
  action: FixChatAction,
  host: AdvisorWorktreeActionHost,
): Promise<Outcome> {
  const target = findGitWorktree(
    await host.readItems(),
    action.projectId,
    action.worktreeId,
  );
  if ('error' in target) return failure(target.error);
  if (host.isSplitLocked(action.projectId, action.worktreeId))
    return failure(SPLIT_LOCKED);
  if (!host.hasMainWindow()) return failure(FIX_CHAT_NEEDS_WINDOW);
  await host.selectWorktree(action.projectId, action.worktreeId);
  const response = await host.launchFixChat(action.type, {
    projectId: action.projectId,
    worktreeId: action.worktreeId,
    ...(action.repoId ? { repoId: action.repoId } : {}),
    ...(action.repoName ? { repoName: action.repoName } : {}),
    ...(action.branchName ? { branchName: action.branchName } : {}),
  });
  return {
    ok: true,
    result: {
      dispatchedAction: action.type,
      chatId: response.chatId,
      projectId: action.projectId,
      worktreeId: action.worktreeId,
      repoId: action.repoId ?? null,
    },
  };
}

/** One of {@link ADVISOR_WORKTREE_ACTION_TYPES}, in main. Never throws. */
export async function dispatchAdvisorWorktreeAction(
  action: AdvisorWorktreeAction,
  host: AdvisorWorktreeActionHost,
  call: AdvisorWorktreeActionCall,
): Promise<AppAdvisorActionResponse> {
  let outcome: Outcome;
  try {
    switch (action.type) {
      case 'worktree.get_settings':
        outcome = await getSettings(action, host);
        break;
      case 'worktree.update_settings':
        outcome = await updateSettings(action, host, call);
        break;
      case 'worktree.create':
        outcome = await createWorktree(action, host, call);
        break;
      case 'worktree.start_ci_check_fix':
      case 'worktree.start_merge_conflict_resolution':
      case 'worktree.start_pr_comment_triage':
        outcome = await startFixChat(action, host);
        break;
    }
  } catch (error) {
    outcome = failure({
      code: 'execution_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return { ...outcome, requestId: call.requestId };
}
