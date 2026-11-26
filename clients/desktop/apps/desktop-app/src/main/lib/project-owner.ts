import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type AutomationAction,
  type ProjectOwnerContext,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import {
  agentAutomationTargetProject,
  type AgentAutomationTargetProject,
} from '@canopy/desktop-shared/lib/agent-automation-policy';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  backgroundExecutionContextEnabled,
  captureBackgroundExecutionContext,
  resolveBackgroundWorkspaceTarget,
} from '../services/background-execution-context';
import { getCodeReviewTarget } from './code-review-registry';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import { logMainProcessWarn } from './main-process-logging';
import { getPlanExploreTarget } from './plan-explore-registry';

/**
 * A project's saved owner as policy sees it. `none` is a Bot, which
 * deliberately has no workspace owner; `unknown` means the owner could not be
 * read and every caller must fail closed.
 */
export type ResolvedProjectOwner =
  | ProjectOwnerContext
  | { kind: 'none' }
  | { kind: 'unknown' };

export interface ProjectOwnerTarget {
  projectId: string;
  /**
   * Needed for the legacy standalone sentinel and the plan/code-review chat
   * sentinels, which name their real project through the worktree id.
   */
  worktreeId?: string;
}

async function resolveRealTarget(
  target: ProjectOwnerTarget,
): Promise<ProjectOwnerTarget | null> {
  if (target.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    return target.worktreeId ? getPlanExploreTarget(target.worktreeId) : null;
  }
  if (target.projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    return target.worktreeId ? getCodeReviewTarget(target.worktreeId) : null;
  }
  return target;
}

/**
 * The Pipeline Editor has no project. It works in the selected owner, the
 * one its workflow list shows, so its reads and writes stay in that owner
 * like a project agent's stay in its project's (organization decision
 * source: the selected navigation context).
 */
async function pipelineEditorOwner(): Promise<ResolvedProjectOwner> {
  if (!backgroundExecutionContextEnabled()) return { kind: 'personal' };
  const selected = await captureBackgroundExecutionContext();
  if (selected === undefined) return { kind: 'personal' };
  const owner = parseWorkspaceContext(selected);
  if (!owner) return { kind: 'unknown' };
  return owner.kind === 'organization'
    ? { kind: 'organization', organizationId: owner.organizationId }
    : { kind: 'personal' };
}

/**
 * Resolve a project's saved owner: the owning organization of an org-owned
 * workspace (including an organization's Chats project), otherwise Personal.
 * A linked Personal code project is Personal. Session captures and
 * membership order are never consulted, and the selected navigation context
 * only for the projectless Pipeline Editor.
 */
export async function resolveProjectSavedOwner(
  target: ProjectOwnerTarget,
): Promise<ResolvedProjectOwner> {
  if (isBotProjectId(target.projectId)) return { kind: 'none' };
  try {
    if (target.projectId === PIPELINE_EDITOR_PROJECT_ID)
      return await pipelineEditorOwner();
    const realTarget = await resolveRealTarget(target);
    if (!realTarget) return { kind: 'unknown' };
    if (isBotProjectId(realTarget.projectId)) {
      return { kind: 'none' };
    }
    const { workspaceOwner } = await resolveBackgroundWorkspaceTarget(
      realTarget.projectId,
      realTarget.worktreeId,
    );
    return workspaceOwner.kind === 'organization'
      ? { kind: 'organization', organizationId: workspaceOwner.organizationId }
      : { kind: 'personal' };
  } catch (error) {
    logMainProcessWarn(
      '[project-owner] saved owner resolution failed; treating it as unknown',
      error,
    );
    return { kind: 'unknown' };
  }
}

/** Whether two saved owners are the same Personal or organization owner. */
export function isSameProjectOwner(
  left: ProjectOwnerContext,
  right: ProjectOwnerContext,
): boolean {
  if (left.kind === 'personal' || right.kind === 'personal') {
    return left.kind === right.kind;
  }
  return (
    left.organizationId.toLowerCase() === right.organizationId.toLowerCase()
  );
}

/**
 * Whether a target names no workspace at all, as opposed to one whose owner
 * cannot be read. A missing target must look exactly like another owner's.
 */
async function isMissingProjectTarget(
  target: ProjectOwnerTarget,
): Promise<boolean> {
  try {
    const realTarget = await resolveRealTarget(target);
    if (!realTarget) return true;
    const workspaceId =
      realTarget.projectId === STANDALONE_CHAT_PROJECT_ID
        ? realTarget.worktreeId
          ? resolveCoworkWorkspaceId(realTarget.worktreeId)
          : undefined
        : realTarget.projectId;
    if (!workspaceId) return true;
    const { readWorkspaceConfigDetailed } =
      await import('./workspace-persistence');
    return (
      (await readWorkspaceConfigDetailed(workspaceId)).authority === 'absent'
    );
  } catch {
    return false;
  }
}

/**
 * Same-owner rule outcome for a code or cowork caller reaching a target
 * project. `hidden` means the target must look exactly like an unknown one:
 * another owner, a Bot, or a project that does not exist.
 * An owner that exists but cannot be read is reported as a typed context
 * failure, for the caller or for the target.
 */
export type SameOwnerDecision =
  | { kind: 'allowed' }
  | { kind: 'hidden' }
  | { kind: 'caller_owner_unknown' }
  | { kind: 'target_owner_unknown' };

export interface SameOwnerAccessDependencies {
  resolveTargetOwner: (
    target: ProjectOwnerTarget,
  ) => Promise<ResolvedProjectOwner>;
  isMissingTarget: (target: ProjectOwnerTarget) => Promise<boolean>;
}

const DEFAULT_SAME_OWNER_DEPENDENCIES: SameOwnerAccessDependencies = {
  resolveTargetOwner: resolveProjectSavedOwner,
  isMissingTarget: isMissingProjectTarget,
};

/**
 * Apply the same-owner rule. Resolve the caller once with
 * {@link resolveProjectSavedOwner} and pass it in. Bots (owner `none`) are not
 * owner-limited.
 */
export async function decideSameOwnerAccess(
  callerOwner: ResolvedProjectOwner,
  target: ProjectOwnerTarget,
  dependencies: SameOwnerAccessDependencies = DEFAULT_SAME_OWNER_DEPENDENCIES,
): Promise<SameOwnerDecision> {
  if (callerOwner.kind === 'none') return { kind: 'allowed' };
  if (callerOwner.kind === 'unknown') return { kind: 'caller_owner_unknown' };
  const targetOwner = await dependencies.resolveTargetOwner(target);
  if (targetOwner.kind === 'none') return { kind: 'hidden' };
  if (targetOwner.kind === 'unknown') {
    return (await dependencies.isMissingTarget(target))
      ? { kind: 'hidden' }
      : { kind: 'target_owner_unknown' };
  }
  return isSameProjectOwner(callerOwner, targetOwner)
    ? { kind: 'allowed' }
    : { kind: 'hidden' };
}

/**
 * The project an automation targets for the owner rule, with a legacy
 * standalone chat project ID mapped to its current cowork workspace, the same
 * mapping the automations service uses when it runs the action.
 */
export function resolveAutomationTargetProject(
  action: AutomationAction,
): AgentAutomationTargetProject {
  const target = agentAutomationTargetProject(action);
  if (target.kind !== 'project' || action.type !== 'standalone_prompt') {
    return target;
  }
  return { ...target, projectId: resolveCoworkWorkspaceId(target.projectId) };
}
