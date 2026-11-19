import {
  legacyChatWatcherToCanonical,
  type CanonicalChatWatcherEntry,
  type ChatWatcherAvailability,
  type ChatWatcherEvidence,
  type ResolvedChatWatcherTarget,
  type TrustedChatWatcherRecipient,
  type UnresolvedLegacyChatWatcher,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  COWORK_HOME_WORKTREE_ID,
  type ProjectOwnerContext,
} from '@canopy/desktop-shared/types';
import {
  botIdForProjectId,
  isBotProjectId,
} from '@canopy/protocol/chat-targets';
import { isRetiredPlanChatScope } from '@canopy/desktop-shared/lib/retired-chat-scopes';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import {
  assertWorkspaceTargetRuntimeStartAllowed,
  isWorkspaceTargetRemovalPending,
} from '../lib/workspace-target-exclusion';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import {
  getCallerOwner,
  requireAuthorizedProjectIdentity,
} from '../project-discovery/owner-policy';
import {
  resolveAuthorizedWatcherChat,
  type AuthorizedWatcherChatIdentity,
} from '../project-discovery/chat-target';
import {
  isDiscoverableWorkEntry,
  isDiscoverableWorktree,
  listDiscoverableTaskIds,
} from '../project-discovery/chats-list';
import {
  readCommittedTaskSnapshot,
  readProjectEntries,
  readProjectWorktree,
} from '../project-discovery/sources';
import {
  ensureBotRegistryLoaded,
  requireBot,
  requireBotWorkspace,
} from '../project-discovery/bots/registry';
import {
  isBotTaskEligible,
  readBotEntries,
  requireBotAccess,
} from '../project-discovery/bots/target';
import {
  recordWatcherAccessRead,
  recordWatcherInspectResource,
} from '../observability/work-aggregates';

/** Safe to project: never propagate target-derived errors from policy/storage. */
export class ChatWatcherAccessError extends Error {
  public constructor(public readonly reason: ChatWatcherAvailability) {
    super('Chat watcher access is unavailable.');
    this.name = 'ChatWatcherAccessError';
  }
}

export type ChatWatcherAccessDecision =
  | {
      allowed: true;
      target: ResolvedChatWatcherTarget;
      caller: ProjectDiscoveryCaller;
      accountEpoch: number;
      sourceOwner: ProjectOwnerContext | null;
      resourceIncarnation: string;
      /** Main-only, authorized scope for TranscriptReader's bound turn query. */
      context?: AuthorizedWatcherChatIdentity;
    }
  | { allowed: false; reason: ChatWatcherAvailability };

export type LegacyChatWatcherAccessResolution =
  | {
      ok: true;
      entry: CanonicalChatWatcherEntry;
      target: ResolvedChatWatcherTarget;
    }
  | { ok: false; reason: ChatWatcherAvailability };

const resourceCaller: ProjectDiscoveryCaller = {
  kind: 'app_advisor',
  chatId: 'chat-watcher-resource-policy',
};

function callerFor(
  trusted: TrustedChatWatcherRecipient,
): ProjectDiscoveryCaller {
  const { destination, recipient } = trusted;
  // Reject inconsistent main-side identities rather than silently switching a
  // delegate's authority or letting a destination decoration create a delegate.
  if (
    (recipient.kind === 'root' && destination.delegationId !== undefined) ||
    (recipient.kind === 'delegate' &&
      (!recipient.delegationId ||
        (destination.delegationId !== undefined &&
          destination.delegationId !== recipient.delegationId)))
  ) {
    throw new ChatWatcherAccessError('runtime_unavailable');
  }
  return isBotProjectId(destination.projectId)
    ? { kind: 'app_advisor', chatId: destination.chatId }
    : {
        kind: 'project_agent',
        projectId: destination.projectId,
        worktreeId: destination.worktreeId,
        chatId: destination.chatId,
      };
}

function sameOwner(
  left: ProjectOwnerContext | null,
  right: ProjectOwnerContext | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    (left.kind === 'personal' ||
      (right.kind === 'organization' &&
        left.organizationId.toLowerCase() ===
          right.organizationId.toLowerCase()))
  );
}

class AccountChangedDuringRead extends Error {}

/** Every await drains already queued account transitions before using its result. */
async function coherentRead<T>(
  epoch: number,
  read: () => Promise<T>,
): Promise<T> {
  const result = await read().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const service = getWorkspaceContextService();
  await service.whenIdle();
  if (service.accountEpoch() !== epoch) throw new AccountChangedDuringRead();
  if (!result.ok) throw result.error;
  return result.value;
}

async function beginRead(): Promise<number> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  return service.accountEpoch();
}

function assertLiveScope(projectId: string, taskId?: string): void {
  if (isRetiredPlanChatScope(projectId))
    throw new ChatWatcherAccessError('runtime_unavailable');
  if (taskId === undefined) return;
  if (
    taskId === COWORK_HOME_WORKTREE_ID ||
    isWorkspaceTargetRemovalPending(projectId, taskId)
  ) {
    throw new ChatWatcherAccessError('runtime_unavailable');
  }
  assertWorkspaceTargetRuntimeStartAllowed(projectId, taskId);
}

async function requireBotWorkspaceForProjectId(
  projectId: string,
): Promise<void> {
  const botId = botIdForProjectId(projectId);
  if (botId) {
    await ensureBotRegistryLoaded?.();
    requireBotWorkspace(botId);
  }
}

async function requireWatcherBotWorkspace(
  target: ResolvedChatWatcherTarget,
): Promise<void> {
  if (target.kind === 'bot') {
    await ensureBotRegistryLoaded?.();
    requireBotWorkspace(target.address.botId);
  } else await requireBotWorkspaceForProjectId(target.address.projectId);
}

type ResourceSnapshot = {
  binding: string;
  target: ResolvedChatWatcherTarget;
  sourceOwner: ProjectOwnerContext | null;
  resourceIncarnation: string;
  context?: AuthorizedWatcherChatIdentity;
};

/**
 * Discovery's JSON incarnation also contains mutable name/readiness metadata.
 * Project watcher evidence binds only stable identity/generation facts. Apply
 * the same projection to saved evidence so pre-change receipts survive renames;
 * opaque incarnation formats (including bot IDs) retain exact equality.
 */
export function normalizeChatWatcherResourceIncarnation(
  incarnation: string,
): string {
  try {
    const value: unknown = JSON.parse(incarnation);
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !('projectId' in value) ||
      typeof value.projectId !== 'string' ||
      !('type' in value) ||
      typeof value.type !== 'string'
    )
      return incarnation;
    return JSON.stringify({
      projectId: value.projectId,
      owner: 'owner' in value ? value.owner : undefined,
      type: value.type,
      binding: 'binding' in value ? value.binding : undefined,
      createdAt: 'createdAt' in value ? value.createdAt : undefined,
    });
  } catch {
    return incarnation;
  }
}

/** Advisor bypasses caller owner policy, never canonical resource eligibility. */
async function inspectResource(
  target: ResolvedChatWatcherTarget,
  epoch: number,
): Promise<ResourceSnapshot> {
  recordWatcherInspectResource();
  await requireWatcherBotWorkspace(target);
  const { address } = target;
  if (target.kind === 'bot' && 'botId' in address) {
    const bot = requireBot(address.botId);
    assertLiveScope(bot.projectId, address.taskId);
    await coherentRead(epoch, () => requireBotAccess(resourceCaller));
    let taskCreatedAt: string | undefined;
    if (address.taskId !== undefined) {
      const entries = await coherentRead(epoch, () => {
        recordWatcherAccessRead('registry.botEntries');
        return readBotEntries(bot.botId);
      });
      const entry = entries.find(
        (candidate) => candidate.id === address.taskId,
      );
      if (!entry || !isBotTaskEligible(entry))
        throw new ChatWatcherAccessError('runtime_unavailable');
      taskCreatedAt = entry.createdAt;
    }
    let context: AuthorizedWatcherChatIdentity | undefined;
    if ('chatId' in address && address.taskId !== undefined) {
      const snapshot = await coherentRead(epoch, () => {
        recordWatcherAccessRead('taskSnapshot');
        return readCommittedTaskSnapshot(bot.projectId, address.taskId);
      });
      const tab = snapshot.tabsFile.tabs.find(
        (candidate) =>
          candidate.id === address.chatId && candidate.kind !== 'file',
      );
      if (!tab) throw new ChatWatcherAccessError('runtime_unavailable');
      context = {
        scope: {
          workspaceId: bot.projectId,
          worktreeId: address.taskId,
          chatId: tab.id,
        },
        tab,
        snapshot,
      };
    }
    assertLiveScope(bot.projectId, address.taskId);
    return {
      target,
      sourceOwner: null,
      resourceIncarnation: bot.botId,
      binding: JSON.stringify([
        bot.botId,
        bot.projectId,
        address.taskId ?? null,
        taskCreatedAt ?? null,
        context?.tab.createdAt ?? null,
      ]),
      ...(context ? { context } : {}),
    };
  }
  if (target.kind !== 'project' || !('projectId' in address))
    throw new ChatWatcherAccessError('migration_required');
  assertLiveScope(address.projectId, address.taskId);
  const project = await coherentRead(epoch, () => {
    recordWatcherAccessRead('identity');
    return requireAuthorizedProjectIdentity(address.projectId, resourceCaller);
  });
  // Policy maps legacy aliases; explicit watcher targets must be canonical.
  if (project.projectId !== address.projectId)
    throw new ChatWatcherAccessError('runtime_unavailable');
  if (project.readiness !== 'ready' || project.synthetic)
    throw new ChatWatcherAccessError('runtime_unavailable');
  if (project.type !== target.projectType)
    throw new ChatWatcherAccessError('migration_required');
  let task: { id: string; createdAt?: string } | undefined;
  const taskId = address.taskId;
  if (taskId !== undefined) {
    if (project.type === 'cowork')
      task = (
        await coherentRead(epoch, () => {
          recordWatcherAccessRead('registry.coworkEntries');
          return readProjectEntries(address.projectId);
        })
      ).entries.find(
        (candidate) =>
          candidate.id === taskId && isDiscoverableWorkEntry(candidate),
      );
    else {
      const worktree = await coherentRead(epoch, () => {
        recordWatcherAccessRead('registry.worktrees');
        return readProjectWorktree(address.projectId, taskId);
      });
      task =
        worktree && isDiscoverableWorktree(worktree) ? worktree : undefined;
    }
    if (!task) throw new ChatWatcherAccessError('runtime_unavailable');
  }
  let context: AuthorizedWatcherChatIdentity | undefined;
  const authorizedTask = task;
  if ('chatId' in address && address.taskId !== undefined && authorizedTask) {
    const chatAddress = {
      projectId: address.projectId,
      taskId: address.taskId,
      chatId: address.chatId,
    };
    context = await coherentRead(epoch, () => {
      // Its one committed task snapshot read.
      recordWatcherAccessRead('taskSnapshot');
      return resolveAuthorizedWatcherChat(chatAddress, project, authorizedTask);
    });
  }
  assertLiveScope(address.projectId, address.taskId);
  const incarnation = normalizeChatWatcherResourceIncarnation(
    project.incarnation,
  );
  return {
    target,
    sourceOwner: project.owner,
    resourceIncarnation: incarnation,
    binding: JSON.stringify([
      incarnation,
      address.taskId ?? null,
      task?.createdAt ?? null,
      context?.tab.createdAt ?? null,
    ]),
    ...(context ? { context } : {}),
  };
}

function failureReason(error: unknown): ChatWatcherAvailability {
  if (error instanceof ChatWatcherAccessError) return error.reason;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'advisor_access_disabled'
  ) {
    return 'advisor_access_disabled';
  }
  return 'runtime_unavailable';
}

/**
 * Current eligibility is sampled twice around caller policy. Comparing stable
 * resource facts catches owner/parent recreation without an account event;
 * runtime state, activity and transcript revision deliberately are not bindings.
 * Reinvoke after enrichment and at each delivery ingress, never cache an allow.
 */
export async function decideChatWatcherAccess(
  recipient: TrustedChatWatcherRecipient,
  target: ResolvedChatWatcherTarget,
  evidence?: ChatWatcherEvidence,
): Promise<ChatWatcherAccessDecision> {
  try {
    await requireWatcherBotWorkspace(target);
  } catch (error) {
    return { allowed: false, reason: failureReason(error) };
  }
  // A routine account refresh invalidates the sample, not the durable event.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const caller = callerFor(recipient);
      const accountEpoch = await beginRead();
      if (target.kind === 'bot')
        await coherentRead(accountEpoch, () => requireBotAccess(caller));
      const first = await inspectResource(target, accountEpoch);
      const owner = await coherentRead(accountEpoch, () =>
        getCallerOwner(caller),
      );
      if (
        target.kind === 'project' &&
        caller.kind !== 'app_advisor' &&
        !sameOwner(owner, first.sourceOwner)
      )
        throw new ChatWatcherAccessError('owner_boundary');
      if (target.kind === 'bot')
        await coherentRead(accountEpoch, () => requireBotAccess(caller));
      const latest = await inspectResource(target, accountEpoch);
      const latestOwner = await coherentRead(accountEpoch, () =>
        getCallerOwner(caller),
      );
      if (
        !sameOwner(owner, latestOwner) ||
        !sameOwner(first.sourceOwner, latest.sourceOwner) ||
        first.binding !== latest.binding
      )
        throw new ChatWatcherAccessError('runtime_unavailable');
      // Recheck setting after resource awaits, so a revoked gate never enriches.
      if (target.kind === 'bot')
        await coherentRead(accountEpoch, () => requireBotAccess(caller));
      if (evidence) {
        if (!sameOwner(evidence.sourceOwner, latest.sourceOwner))
          throw new ChatWatcherAccessError('owner_boundary');
        if (
          evidence.resourceIncarnation !== undefined &&
          normalizeChatWatcherResourceIncarnation(
            evidence.resourceIncarnation,
          ) !== latest.resourceIncarnation
        )
          throw new ChatWatcherAccessError('migration_required');
      }
      if (target.kind === 'bot')
        assertLiveScope(
          requireBot(target.address.botId).projectId,
          target.address.taskId,
        );
      else assertLiveScope(target.address.projectId, target.address.taskId);
      return {
        allowed: true,
        target: latest.target,
        sourceOwner: latest.sourceOwner,
        resourceIncarnation: latest.resourceIncarnation,
        ...(latest.context ? { context: latest.context } : {}),
        caller,
        accountEpoch,
      };
    } catch (error) {
      if (error instanceof AccountChangedDuringRead) continue;
      return { allowed: false, reason: failureReason(error) };
    }
  }
  return { allowed: false, reason: 'runtime_unavailable' };
}

/** Resolves main-owned project type and verifies the complete live parent chain. */
export async function resolveChatWatcherTarget(
  entry: CanonicalChatWatcherEntry,
): Promise<ResolvedChatWatcherTarget> {
  try {
    const entryTarget = entry.target;
    if ('botId' in entryTarget) {
      await ensureBotRegistryLoaded?.();
      requireBotWorkspace(entryTarget.botId);
    } else await requireBotWorkspaceForProjectId(entryTarget.projectId);
    const epoch = await beginRead();
    let target: ResolvedChatWatcherTarget;
    if ('projectId' in entryTarget) {
      const project = await coherentRead(epoch, () => {
        recordWatcherAccessRead('identity');
        return requireAuthorizedProjectIdentity(
          entryTarget.projectId,
          resourceCaller,
        );
      });
      target = {
        kind: 'project',
        projectType: project.type,
        address: entryTarget,
      };
    } else target = { kind: 'bot', address: entryTarget };
    const first = await inspectResource(target, epoch);
    const latest = await inspectResource(target, epoch);
    if (
      first.binding !== latest.binding ||
      !sameOwner(first.sourceOwner, latest.sourceOwner)
    )
      throw new ChatWatcherAccessError('runtime_unavailable');
    return target;
  } catch (error) {
    throw new ChatWatcherAccessError(failureReason(error));
  }
}

/**
 * Historical rows remain untouched. Resolve live cowork metadata through the
 * dispatcher, never assume task=chat or accept an archive-only match. Multiple
 * live parents are corruption, not permission to pick the first one.
 */
export async function resolveLegacyChatWatcher(
  legacy: UnresolvedLegacyChatWatcher,
): Promise<LegacyChatWatcherAccessResolution> {
  try {
    await requireBotWorkspaceForProjectId(legacy.target.projectId);
    const epoch = await beginRead();
    const project = await coherentRead(epoch, () => {
      recordWatcherAccessRead('identity');
      return requireAuthorizedProjectIdentity(
        legacy.target.projectId,
        resourceCaller,
      );
    });
    let address: ResolvedChatWatcherTarget & { kind: 'project' };
    if (legacy.trigger === 'standalone_chat_completion') {
      if (project.type !== 'cowork')
        return { ok: false, reason: 'migration_required' };
      const tasks = await coherentRead(epoch, () => {
        recordWatcherAccessRead('registry.taskIds');
        return listDiscoverableTaskIds(project.projectId, 'cowork');
      });
      const matches: string[] = [];
      for (const taskId of tasks) {
        assertLiveScope(project.projectId, taskId);
        const snapshot = await coherentRead(epoch, () => {
          recordWatcherAccessRead('taskSnapshot');
          return readCommittedTaskSnapshot(project.projectId, taskId);
        });
        if (
          snapshot.tabsFile.tabs.some(
            (tab) => tab.kind !== 'file' && tab.id === legacy.target.chatId,
          )
        )
          matches.push(taskId);
      }
      if (matches.length !== 1)
        return { ok: false, reason: 'migration_required' };
      address = {
        kind: 'project',
        projectType: project.type,
        address: {
          projectId: project.projectId,
          taskId: matches[0],
          chatId: legacy.target.chatId,
        },
      };
    } else if (legacy.trigger === 'standalone_new_chat_started') {
      address = {
        kind: 'project',
        projectType: project.type,
        address: { projectId: project.projectId },
      };
    } else {
      address = {
        kind: 'project',
        projectType: project.type,
        address: {
          projectId: project.projectId,
          taskId: legacy.target.worktreeId,
          ...('chatId' in legacy.target
            ? { chatId: legacy.target.chatId }
            : {}),
        },
      };
    }
    const canonical = legacyChatWatcherToCanonical(legacy, address);
    if (!canonical.ok) return canonical;
    const target = await coherentRead(epoch, () =>
      resolveChatWatcherTarget(canonical.entry),
    );
    return { ok: true, entry: canonical.entry, target };
  } catch {
    return { ok: false, reason: 'migration_required' };
  }
}
