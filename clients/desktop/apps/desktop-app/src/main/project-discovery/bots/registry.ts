import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type { BotKind } from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_BOT_ID,
  APP_ADVISOR_PROJECT_ID,
  projectIdForBotId,
  type BotId,
} from '@canopy/protocol/chat-targets';
import type { BotRow } from '@canopy/desktop-shared/lib/bot-discovery';
import { getBotRegistryStore } from '../../bots/registry-store';
import { isBotsExperimentEnabled } from '../../bots/visibility';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { DiscoveryError } from '../errors';

export interface RegisteredBot {
  botId: string;
  projectId: string;
  kind: BotKind;
  name: string;
  capabilities: BotRow['capabilities'];
}

const advisor: RegisteredBot = {
  botId: APP_ADVISOR_BOT_ID,
  projectId: APP_ADVISOR_PROJECT_ID,
  kind: 'default',
  name: ORCHESTRATOR_LABEL,
  capabilities: {
    listTasks: true,
    readChats: true,
    sendMessages: true,
    createTasks: true,
    createChats: true,
    watchChats: true,
  },
};

/** Load saved Bots before a synchronous lookup needs the registry snapshot. */
export async function ensureBotRegistryLoaded(): Promise<void> {
  try {
    await getBotRegistryStore().load();
  } catch (error) {
    try {
      logMainProcessWarn(
        '[bots] Bot registry could not be loaded; continuing with the default Bot.',
        error,
      );
    } catch {
      // A logging failure must not turn a degraded read into a failed lookup.
    }
  }
}

function customBot(record: {
  botId: BotId;
  kind: BotKind;
  name: string;
  deletedAt: string | null;
}): RegisteredBot | null {
  if (record.kind !== 'custom' || record.deletedAt !== null) return null;
  return {
    botId: record.botId,
    projectId: projectIdForBotId(record.botId),
    kind: record.kind,
    name: record.name,
    capabilities: {
      listTasks: true,
      readChats: true,
      sendMessages: false,
      createTasks: false,
      createChats: false,
      watchChats: false,
    },
  };
}

/** Public IDs only: the internal workspace ID is never a bot alias. */
export function requireBot(botId: string): RegisteredBot {
  const bot = registeredBots().find((candidate) => candidate.botId === botId);
  if (!bot) throw new DiscoveryError('unknown_bot', 'Bot was not found.');
  return bot;
}

/** BOTS-04 will provision custom workspaces; until then execution is unsupported. */
export function requireBotWorkspace(botId: string): RegisteredBot {
  const bot = requireBot(botId);
  if (bot.kind === 'custom')
    throw new DiscoveryError(
      'unsupported_action',
      'Bot workspace is not available yet.',
    );
  return bot;
}

export function registeredBots(): readonly RegisteredBot[] {
  if (!isBotsExperimentEnabled()) return [advisor];
  const customBots = getBotRegistryStore()
    .snapshot()
    .flatMap((record) => {
      const bot = customBot(record);
      return bot ? [bot] : [];
    });
  return [advisor, ...customBots];
}
