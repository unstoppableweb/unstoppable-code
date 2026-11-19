import {
  isOrchestratorLabel,
  ORCHESTRATOR_FORMER_LABEL,
} from '@canopy/protocol';
import { createHash } from 'node:crypto';
import {
  APP_ADVISOR_BOT_ID,
  parseBotAction,
  type BotAction,
  type BotRow,
  type BotTaskRow,
  type BotChatRow,
  type BotsListAction,
  type BotsListResult,
  type BotsListTasksResult,
  type BotsListTaskChatsResult,
} from '@canopy/desktop-shared/lib/bot-discovery';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import type { ProjectDiscoveryCaller } from '../index';
import { decideAppAdvisorAccessForCaller } from '../../lib/app-advisor-project-agent-access';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { DiscoveryError } from '../errors';
import { matchesChatFilters } from '../chats-list';
import { listAuthorizedProjects } from '../owner-policy';
import {
  cursorBinding,
  pageRows,
  toDiscoveryJson,
  validateCursor,
} from '../paging';
import { dispatchBotReadAction } from '../reads';
import {
  ensureBotRegistryLoaded,
  registeredBots,
  requireBot,
  type RegisteredBot,
} from './registry';
import { botAccessAgent, requireBotAccess, readBotEntries } from './target';
import { listBotChatRows, listBotTaskRows } from './rows';
import {
  isBotsExperimentEnabled,
  readVisibleBots,
} from '../../bots/visibility';

export async function isBotAccessAllowed(
  caller: ProjectDiscoveryCaller,
): Promise<boolean> {
  const agent = botAccessAgent(caller);
  if (!agent) return true;
  try {
    return (await decideAppAdvisorAccessForCaller(agent)).allowed;
  } catch {
    return false;
  }
}

type BotListAction = Extract<BotAction, { sort: string }>;

function sortValue(
  row: {
    name?: string;
    title?: string;
    createdAt?: string;
    lastActivityAt?: string;
  },
  sort: BotListAction['sort'],
): string {
  if (sort === 'name') return (row.name ?? '').toLowerCase();
  if (sort === 'title') return (row.title ?? '').toLowerCase();
  return (sort === 'created_at' ? row.createdAt : row.lastActivityAt) ?? '';
}

function taskIncarnation(row: BotTaskRow): string {
  return JSON.stringify({
    taskId: row.taskId,
    createdAt: row.createdAt,
    title: row.title,
    status: row.status,
    retentionState: row.retentionState,
    pinned: row.details.pinned,
    hasUserChanges: row.details.hasUserChanges,
    titleOverride: row.details.titleOverride,
  });
}

function chatIdentity(row: BotChatRow): { id: string; incarnation: string } {
  return {
    id: JSON.stringify([row.taskId, row.chatId]),
    incarnation: JSON.stringify({
      createdAt: row.createdAt,
      title: row.title,
      description: row.description,
      model: row.model,
      hasPluginSelections: row.hasPluginSelections,
      retentionState: row.retentionState,
      providerType: row.providerType,
      executionHarness: row.executionHarness,
    }),
  };
}

/** Pin all static metadata, including already-returned rows, not runtime samples. */
function metadataBinding<T>(
  binding: string,
  rows: T[],
  identity: (row: T) => { id: string; incarnation: string },
): string {
  const items = rows
    .map(identity)
    .sort((left, right) => left.id.localeCompare(right.id));
  return (
    binding + createHash('sha256').update(JSON.stringify(items)).digest('hex')
  );
}

/** Orchestrator still answers to its former name for agents that learned it. */
function botNames(bot: RegisteredBot): readonly string[] {
  return bot.botId === APP_ADVISOR_BOT_ID
    ? [bot.name, ORCHESTRATOR_FORMER_LABEL]
    : [bot.name];
}

function botNameMatches(bot: RegisteredBot, name: string): boolean {
  return bot.botId === APP_ADVISOR_BOT_ID
    ? isOrchestratorLabel(name)
    : name.toLowerCase() === bot.name.toLowerCase();
}

/**
 * Projects whose names a pin may show. A project index that can't be read
 * hides every pin (scope falls back to global) instead of failing the list.
 */
async function readPinProjects(
  caller: ProjectDiscoveryCaller,
): Promise<Awaited<ReturnType<typeof listAuthorizedProjects>>> {
  try {
    return await listAuthorizedProjects(caller);
  } catch (error) {
    logMainProcessWarn(
      '[bots] Pinned projects could not be read; hiding Bot pins.',
      error,
    );
    return [];
  }
}

async function listBots(
  action: BotsListAction,
  caller: ProjectDiscoveryCaller,
  visibleRecords: Awaited<ReturnType<typeof readVisibleBots>>,
): Promise<BotRow[]> {
  const experimentEnabled = isBotsExperimentEnabled();
  if (action.pinnedToProjectId !== undefined && !experimentEnabled)
    throw new DiscoveryError(
      'unsupported_filter',
      'Filtering bots by project is not supported while user-defined bots are unavailable.',
    );

  const bots = registeredBots();
  if (action.botIds) action.botIds.forEach(requireBot);

  const visibleById = new Map<string, (typeof visibleRecords)[number]>(
    visibleRecords.map((record) => [record.botId, record] as const),
  );
  const registeredIds = new Set(bots.map((bot) => bot.botId));
  if (
    experimentEnabled &&
    (bots.some((bot) => !visibleById.has(bot.botId)) ||
      visibleRecords.some(
        (record) =>
          record.kind === 'custom' && !registeredIds.has(record.botId),
      ))
  )
    throw new DiscoveryError(
      'cursor_context_changed',
      'This bot context changed. Restart the request.',
    );

  const authorizedProjects =
    experimentEnabled && visibleRecords.some((record) => record.pins.length > 0)
      ? await readPinProjects(caller)
      : [];
  const projectNames = new Map(
    authorizedProjects.map(
      (project) => [project.projectId, project.displayName] as const,
    ),
  );
  const rows: BotRow[] = [];
  for (const bot of bots) {
    if (action.botIds && !action.botIds.includes(bot.botId)) continue;
    if (action.availability && !action.availability.includes('available'))
      continue;
    if (action.name !== undefined && !botNameMatches(bot, action.name))
      continue;
    const record = visibleById.get(bot.botId);
    if (experimentEnabled && !record) continue;
    const pins =
      (experimentEnabled ? record?.pins : undefined)?.flatMap((pin) => {
        const name = projectNames.get(pin.projectId);
        return name === undefined ? [] : [{ projectId: pin.projectId, name }];
      }) ?? [];
    if (
      action.pinnedToProjectId !== undefined &&
      !pins.some((pin) => pin.projectId === action.pinnedToProjectId)
    )
      continue;
    if (
      action.query !== undefined &&
      ![
        bot.botId,
        ...botNames(bot),
        ...(experimentEnabled && record?.description
          ? [record.description]
          : []),
      ].some((value) =>
        value.toLowerCase().includes(action.query?.toLowerCase() ?? ''),
      )
    )
      continue;
    rows.push({
      botId: bot.botId,
      name: bot.name,
      availability: 'available',
      taskCount:
        bot.kind === 'custom' ? null : (await readBotEntries(bot.botId)).length,
      capabilities: bot.capabilities,
      ...(experimentEnabled && record
        ? {
            kind: bot.kind,
            description: record.description,
            scope:
              bot.kind === 'default'
                ? 'default'
                : pins.length === 0
                  ? 'global'
                  : 'pinned',
            pins,
            showInSidebar: record.showInSidebar,
          }
        : {}),
    });
  }
  return rows;
}

async function listBinding(
  action: BotListAction,
  caller: ProjectDiscoveryCaller,
): Promise<string> {
  const access = await requireBotAccess(caller);
  const owner =
    access.owner?.kind === 'personal' || access.owner?.kind === 'organization'
      ? access.owner
      : null;
  return (
    cursorBinding(action, caller, owner, access.accountEpoch) +
    JSON.stringify({
      gate: access.gate,
      botsExperimentEnabled: isBotsExperimentEnabled(),
    })
  );
}

export async function dispatchBotAction(
  action: BotAction,
  caller: ProjectDiscoveryCaller,
): Promise<Omit<AppAdvisorActionResponse, 'requestId'>> {
  try {
    // A refusal always wins over cursor errors and unknown targets.
    await requireBotAccess(caller);
    await ensureBotRegistryLoaded?.();
    const parsed = parseBotAction(action);
    if (!parsed.ok)
      return {
        ok: false,
        error: { code: 'invalid_payload', message: parsed.message },
      };
    const input = parsed.action;
    const botsExperimentEnabled =
      input.type === 'bots.list' && isBotsExperimentEnabled();
    if (
      input.type === 'bots.list' &&
      input.pinnedToProjectId !== undefined &&
      !botsExperimentEnabled
    )
      throw new DiscoveryError(
        'unsupported_filter',
        'Filtering bots by project is not supported while user-defined bots are unavailable.',
      );
    const visibleRecords = botsExperimentEnabled ? await readVisibleBots() : [];
    if (input.type === 'bots.list') {
      input.botIds?.forEach(requireBot);
    } else requireBot(input.botId);
    if (
      input.type === 'bots.get_last_user_message' ||
      input.type === 'bots.get_last_agent_response' ||
      input.type === 'bots.read_history'
    )
      return await dispatchBotReadAction(input, caller);
    const binding = await listBinding(input, caller);
    validateCursor(input.cursor);
    let result: BotsListResult | BotsListTasksResult | BotsListTaskChatsResult;
    if (input.type === 'bots.list') {
      const rows = await listBots(input, caller, visibleRecords);
      result = pageRows(
        rows,
        input,
        binding,
        (row) => ({ id: row.botId, incarnation: JSON.stringify(row) }),
        (row) => sortValue(row, input.sort),
      );
    } else if (input.type === 'bots.list_tasks') {
      const candidates = await listBotTaskRows({
        ...input,
        hasRunningChats: undefined,
      });
      const identity = (
        row: BotTaskRow,
      ): { id: string; incarnation: string } => ({
        id: row.taskId,
        incarnation: taskIncarnation(row),
      });
      const rows =
        input.cursor || input.hasRunningChats === undefined
          ? candidates
          : candidates.filter(
              (row) => row.hasRunningChats === input.hasRunningChats,
            );
      const page = pageRows(
        rows,
        input,
        metadataBinding(binding, candidates, identity),
        identity,
        (row) => sortValue(row, input.sort),
        true,
      );
      result = { ...page, botId: input.botId };
    } else {
      const candidates = await listBotChatRows({
        ...input,
        runtimeStates: undefined,
        hasQueuedMessages: undefined,
      });
      const rows = input.cursor
        ? candidates
        : candidates.filter((row) => matchesChatFilters(input, row));
      const page = pageRows(
        rows,
        input,
        metadataBinding(binding, candidates, chatIdentity),
        chatIdentity,
        (row) => sortValue(row, input.sort),
        true,
      );
      result = {
        ...page,
        botId: input.botId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      };
    }
    if (binding !== (await listBinding(input, caller)))
      throw new DiscoveryError(
        'cursor_context_changed',
        'This bot context changed. Restart the request.',
      );
    return { ok: true, result: toDiscoveryJson(result) };
  } catch (error) {
    // An asynchronous read may fail concurrently with a settings change.
    try {
      await requireBotAccess(caller);
    } catch (gateError) {
      if (
        gateError instanceof DiscoveryError &&
        gateError.code === 'advisor_access_disabled'
      )
        return {
          ok: false,
          error: { code: gateError.code, message: gateError.message },
        };
    }
    if (error instanceof DiscoveryError)
      return { ok: false, error: { code: error.code, message: error.message } };
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Bot discovery metadata could not be read.',
      },
    };
  }
}
