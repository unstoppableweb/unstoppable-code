import type { ProjectReadAction } from '@canopy/desktop-shared/lib/project-reads';
import { getWorkspaceContextService } from '../../lib/workspace-context-service';
import {
  resolveAuthorizedChat,
  type AuthorizedChatReadContext,
} from '../chat-target';
import { DiscoveryError } from '../errors';
import type { ProjectDiscoveryCaller } from '../index';
import { getCallerOwner, requireAuthorizedProject } from '../owner-policy';
import {
  readProjectEntries,
  readProjectWorktree,
  withProjectWorktreeReadMemo,
} from '../sources';

async function taskIdentity(
  context: AuthorizedChatReadContext,
): Promise<string> {
  const { projectId, taskId } = context.address;
  if (context.projectType === 'cowork') {
    const entry = (await readProjectEntries(projectId)).entries.find(
      (candidate) => candidate.id === taskId,
    );
    if (!entry) throw new DiscoveryError('not_found', 'Task was not found.');
    return JSON.stringify({
      id: entry.id,
      createdAt: entry.createdAt,
      title: entry.title,
      status: entry.status,
      pinned: entry.pinned,
    });
  }
  const task = await readProjectWorktree(projectId, taskId);
  if (!task) throw new DiscoveryError('not_found', 'Task was not found.');
  return JSON.stringify({
    id: task.id,
    createdAt: task.createdAt,
    branchName: task.branchName,
    label: task.label,
    status: task.status,
    hidden: task.hidden,
    trackedBaseBranch: task.trackedBaseBranch,
    trackedRepoBaseBranches: task.trackedRepoBaseBranches,
  });
}

/**
 * Drain account transitions before and after all asynchronous authorization
 * reads. Chat resolution and the task identity share one worktree list.
 */
export function resolveReadBinding(
  action: ProjectReadAction,
  caller: ProjectDiscoveryCaller,
): Promise<{ binding: string; context: AuthorizedChatReadContext }> {
  return withProjectWorktreeReadMemo(() => readBinding(action, caller));
}

async function readBinding(
  action: ProjectReadAction,
  caller: ProjectDiscoveryCaller,
): Promise<{ binding: string; context: AuthorizedChatReadContext }> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  const accountEpoch = service.accountEpoch();
  const owner = await getCallerOwner(caller);
  const project = await requireAuthorizedProject(action.projectId, caller);
  const context = await resolveAuthorizedChat(action, caller);
  const task = await taskIdentity(context);
  await service.whenIdle();
  if (accountEpoch !== service.accountEpoch())
    throw new DiscoveryError(
      'cursor_context_changed',
      'This history context changed. Restart the read.',
    );
  const filters =
    action.type === 'projects.read_history'
      ? {
          query: action.query?.toLowerCase(),
          roles: action.roles ? [...action.roles].sort() : undefined,
          order: action.order,
        }
      : undefined;
  return {
    context,
    binding: JSON.stringify({
      accountEpoch,
      caller,
      owner,
      project: {
        owner: project.owner,
        readiness: project.readiness,
        incarnation: project.incarnation,
      },
      address: context.address,
      scope: context.scope,
      task,
      chat: {
        createdAt: context.row.createdAt,
        title: context.row.title,
        retentionState: context.row.retentionState,
        providerType: context.row.providerType,
        executionHarness: context.row.executionHarness,
      },
      type: action.type,
      filters,
    }),
  };
}
