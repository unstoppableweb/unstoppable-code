/**
 * Target resolution shared by desktop main's pipeline host actions: maps a
 * request's project or bot to what main stores, reading persisted lists only.
 * Every miss is a `PipelineHostRefusal('not_found')`; an incompletely read
 * list or config is an error, never a miss.
 */
import {
  APP_ADVISOR_PROJECT_ID,
  type WorkspaceType,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  PipelineHostRefusal,
  type MoveToGroupInputs,
} from '@canopy/execution-engine/pipelines/host-actions';
import type { SidebarItemGroupScope } from '@canopy/protocol/sidebar';
import type { PipelineHostActionCaller } from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from '../lib/workspace-persistence';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { isWritableScope } from '../lib/read-only-scope';

export type PipelineHostTarget =
  | {
      kind: 'project';
      projectId: string;
      /** Absent when the step creates the task. */
      taskId?: string;
      workspaceType: WorkspaceType;
    }
  | { kind: 'bot'; botId: 'app_advisor'; taskId: string };

/**
 * Owner-policy seam. Throw `PipelineHostRefusal` to refuse; a cross-owner
 * target must read exactly like a missing one.
 */
export type PipelineHostOwnerCheck = (
  caller: PipelineHostActionCaller,
  target: PipelineHostTarget,
) => Promise<void>;

export interface ResolvedTask {
  target: PipelineHostTarget;
  scope: SidebarItemGroupScope;
}

export interface ResolvedHostProject {
  projectId: string;
  /** The id main stores the project under (a legacy cowork id maps to its workspace). */
  workspaceId: string;
  workspaceType: WorkspaceType;
}

const APP_ADVISOR_BOT_ID = 'app_advisor';

export function taskNotInProject(taskId: string, projectId: string): string {
  return `Task \`${taskId}\` isn't in project \`${projectId}\``;
}

export function projectUnavailable(projectId: string): string {
  return `Project \`${projectId}\` isn't available to this pipeline`;
}

export function botUnavailable(botId: string): string {
  return `Bot \`${botId}\` isn't available to this pipeline`;
}

export function taskNotInBot(taskId: string, botId: string): string {
  return `Task \`${taskId}\` isn't in bot \`${botId}\``;
}

export function chatNotInTask(chatId: string, taskId: string): string {
  return `Chat \`${chatId}\` isn't in task \`${taskId}\``;
}

export function messageNotInChat(messageId: string, chatId: string): string {
  return `Message \`${messageId}\` isn't in chat \`${chatId}\``;
}

/** A missing file reads as empty; any other read error is unexpected and propagates. */
export async function hasWorkEntry(
  workspaceId: string,
  entryId: string,
): Promise<boolean> {
  const { entries } = await readWorkEntriesFileStrict(workspaceId);
  return entries.some((entry) => entry.id === entryId);
}

/**
 * Reads the persisted list only: no worktree stats, fetch or cleanup write. A
 * miss is proof only when the list was read completely (or doesn't exist yet).
 * Archived worktrees aren't in the list, so they read as misses.
 */
export async function hasWorktree(
  projectId: string,
  worktreeId: string,
): Promise<boolean> {
  return (await findWorktree(projectId, worktreeId)) !== undefined;
}

/** {@link hasWorktree}, returning the listed row. */
async function findWorktree(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeData | undefined> {
  const { worktrees, authority } = await readWorkspaceWorktreesDetailed(
    projectId,
    { persistRemovalCleanup: false },
  );
  const found = worktrees.find((worktree) => worktree.id === worktreeId);
  if (found || authority === 'ok' || authority === 'absent') return found;
  throw new Error(
    `Worktrees for project \`${projectId}\` couldn't be fully read`,
  );
}

/** Null only for a missing project; an unreadable config is a read error, not a miss. */
export async function readProjectType(
  projectId: string,
  workspaceId: string,
): Promise<WorkspaceType | null> {
  const detail = await readWorkspaceConfigDetailed(workspaceId);
  if (detail.authority === 'unreadable') {
    throw new Error(`Project \`${projectId}\` couldn't be read`);
  }
  return detail.authority === 'ok' ? detail.config.type : null;
}

/**
 * The project half of {@link resolveTask}: App Advisor and the read-only
 * shared-container viewer aren't projects a pipeline can change, and a legacy
 * cowork chat-project id reads through its workspace.
 */
export async function resolveHostProject(
  projectId: string,
): Promise<ResolvedHostProject> {
  if (projectId === APP_ADVISOR_PROJECT_ID || !isWritableScope(projectId)) {
    throw new PipelineHostRefusal('not_found', projectUnavailable(projectId));
  }
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  const workspaceType = await readProjectType(projectId, workspaceId);
  if (workspaceType === null) {
    throw new PipelineHostRefusal('not_found', projectUnavailable(projectId));
  }
  return { projectId, workspaceId, workspaceType };
}

/** Whether a worktree project lists `taskId`; incompletely read lists throw. */
export function hostProjectHasWorktree(
  project: ResolvedHostProject,
  taskId: string,
): Promise<boolean> {
  return hasWorktree(project.workspaceId, taskId);
}

/** The listed task's `createdAt`, or null when the project doesn't list it; incompletely read lists throw. */
export async function hostProjectWorktreeCreatedAt(
  project: ResolvedHostProject,
  taskId: string,
): Promise<string | null> {
  return (await findWorktree(project.workspaceId, taskId))?.createdAt ?? null;
}

/** Throws `PipelineHostRefusal('not_found')` for any miss. */
export async function resolveTask(
  task: MoveToGroupInputs['task'],
): Promise<ResolvedTask> {
  if (task.kind === 'bot') {
    if (task.botId !== APP_ADVISOR_BOT_ID) {
      throw new PipelineHostRefusal('not_found', botUnavailable(task.botId));
    }
    if (!(await hasWorkEntry(APP_ADVISOR_PROJECT_ID, task.taskId))) {
      throw new PipelineHostRefusal(
        'not_found',
        taskNotInBot(task.taskId, APP_ADVISOR_BOT_ID),
      );
    }
    return {
      target: { kind: 'bot', botId: APP_ADVISOR_BOT_ID, taskId: task.taskId },
      scope: { appAdvisor: true },
    };
  }

  const project = await resolveHostProject(task.projectId);
  const found =
    project.workspaceType === 'cowork'
      ? await hasWorkEntry(project.workspaceId, task.taskId)
      : await hasWorktree(project.workspaceId, task.taskId);
  if (!found) {
    throw new PipelineHostRefusal(
      'not_found',
      taskNotInProject(task.taskId, task.projectId),
    );
  }
  return {
    target: {
      kind: 'project',
      projectId: task.projectId,
      taskId: task.taskId,
      workspaceType: project.workspaceType,
    },
    // The sidebar service maps cowork ids in its own scope resolution.
    scope: { workspaceLocalId: task.projectId },
  };
}
