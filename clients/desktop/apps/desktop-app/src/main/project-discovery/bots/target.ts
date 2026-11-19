import type {
  BotsGetLastAgentResponseAction,
  BotsGetLastUserMessageAction,
  BotsReadHistoryAction,
} from '@canopy/desktop-shared/lib/bot-discovery';
import {
  APP_ADVISOR_WORKTREE_ID,
  COWORK_HOME_WORKTREE_ID,
  type CoworkWorkEntryData,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import {
  ADVISOR_ACCESS_DISABLED,
  ADVISOR_ACCESS_DISABLED_MESSAGE,
  decideAppAdvisorAccessForCaller,
} from '../../lib/app-advisor-project-agent-access';
import {
  resolveProjectSavedOwner,
  type ResolvedProjectOwner,
} from '../../lib/project-owner';
import { getWorkspaceContextService } from '../../lib/workspace-context-service';
import type { BotChatReadContext } from '../chat-target';
import { DiscoveryError } from '../errors';
import type { ProjectDiscoveryCaller } from '../index';
import { readProjectEntries } from '../sources';
import { readTaskRuntimeSnapshot } from '../runtime-state';
import { botChatRow } from './rows';
import { ensureBotRegistryLoaded, requireBot } from './registry';

export type BotReadAction =
  | BotsGetLastUserMessageAction
  | BotsGetLastAgentResponseAction
  | BotsReadHistoryAction;

export interface BotAccessContext {
  accountEpoch: number;
  caller: ProjectDiscoveryCaller;
  owner: ResolvedProjectOwner | null;
  gate: { allowed: true };
}

/**
 * The project agent whose access gates bot targets, or null when none does:
 * a Bot itself, and pipeline runs that no project agent started.
 */
export function botAccessAgent(
  caller: ProjectDiscoveryCaller,
): { projectId: string; worktreeId: string } | null {
  if (caller.kind === 'app_advisor') return null;
  if (caller.kind === 'pipeline') {
    // A Bot origin has no project-agent setting.
    return caller.agentOrigin && !isBotProjectId(caller.agentOrigin.projectId)
      ? {
          projectId: caller.agentOrigin.projectId,
          worktreeId: caller.agentOrigin.worktreeId,
        }
      : null;
  }
  return { projectId: caller.projectId, worktreeId: caller.worktreeId };
}

/**
 * Advisor is never evaluated by the project-agent setting, nor is a
 * user-originated pipeline run; an agent-originated one is gated by its agent.
 */
async function assertGate(caller: ProjectDiscoveryCaller): Promise<void> {
  const agent = botAccessAgent(caller);
  if (!agent) return;
  const decision = await decideAppAdvisorAccessForCaller(agent);
  if (!decision.allowed)
    throw new DiscoveryError(
      ADVISOR_ACCESS_DISABLED,
      decision.reason === 'owner_unknown'
        ? 'The project owner could not be determined. Orchestrator bot actions are unavailable until the owner can be verified.'
        : ADVISOR_ACCESS_DISABLED_MESSAGE,
    );
}

/** Gate before cursor lookup or bot storage, draining queued account changes. */
export async function requireBotAccess(
  caller: ProjectDiscoveryCaller,
): Promise<BotAccessContext> {
  await assertGate(caller);
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  const accountEpoch = service.accountEpoch();
  const agent = botAccessAgent(caller);
  const owner = agent
    ? await resolveProjectSavedOwner(agent)
    : caller.kind === 'pipeline'
      ? caller.owner
      : null;
  await service.whenIdle();
  await assertGate(caller);
  if (accountEpoch !== service.accountEpoch())
    throw new DiscoveryError(
      'cursor_context_changed',
      'This bot context changed. Restart the request.',
    );
  // Do not allow a transient unknown owner to pass a later successful probe.
  if (owner?.kind === 'unknown')
    throw new DiscoveryError(
      ADVISOR_ACCESS_DISABLED,
      'The project owner could not be determined. Orchestrator bot actions are unavailable until the owner can be verified.',
    );
  return { accountEpoch, caller, owner, gate: { allowed: true } };
}

/** Shared by counts, enumeration and every explicit bot target. */
export function isBotTaskEligible(entry: CoworkWorkEntryData): boolean {
  return (
    entry.id !== APP_ADVISOR_WORKTREE_ID && entry.id !== COWORK_HOME_WORKTREE_ID
  );
}

export async function readBotEntries(
  botId: string,
): Promise<CoworkWorkEntryData[]> {
  await ensureBotRegistryLoaded();
  const bot = requireBot(botId);
  return (await readProjectEntries(bot.projectId)).entries.filter(
    isBotTaskEligible,
  );
}

export async function resolveBotReadBinding(
  action: BotReadAction,
  caller: ProjectDiscoveryCaller,
): Promise<{ binding: string; context: BotChatReadContext }> {
  const access = await requireBotAccess(caller);
  await ensureBotRegistryLoaded();
  const bot = requireBot(action.botId);
  const entry = (await readBotEntries(bot.botId)).find(
    (candidate) => candidate.id === action.taskId,
  );
  if (!entry) throw new DiscoveryError('not_found', 'Task was not found.');
  const snapshot = await readTaskRuntimeSnapshot(bot.projectId, entry.id);
  const tab = snapshot.tabsFile.tabs.find(
    (candidate) => candidate.id === action.chatId && candidate.kind !== 'file',
  );
  if (!tab) throw new DiscoveryError('not_found', 'Chat was not found.');
  const row = botChatRow(bot.botId, entry.id, tab, snapshot);
  const context: BotChatReadContext = {
    kind: 'bot',
    address: { botId: bot.botId, taskId: entry.id, chatId: tab.id },
    projectType: 'cowork',
    scope: { workspaceId: bot.projectId, worktreeId: entry.id, chatId: tab.id },
    tab,
    snapshot,
    row,
  };
  const latest = await requireBotAccess(caller);
  if (JSON.stringify(access) !== JSON.stringify(latest))
    throw new DiscoveryError(
      'cursor_context_changed',
      'This bot context changed. Restart the request.',
    );
  return {
    context,
    binding: JSON.stringify({
      access,
      address: context.address,
      scope: context.scope,
      task: {
        id: entry.id,
        createdAt: entry.createdAt,
        title: entry.title,
        status: entry.status,
        pinned: entry.pinned,
      },
      chat: {
        createdAt: row.createdAt,
        title: row.title,
        retentionState: row.retentionState,
        providerType: row.providerType,
        executionHarness: row.executionHarness,
      },
      type: action.type,
      filters:
        action.type === 'bots.read_history'
          ? {
              query: action.query?.toLowerCase(),
              roles: action.roles ? [...action.roles].sort() : undefined,
              order: action.order,
            }
          : undefined,
    }),
  };
}
