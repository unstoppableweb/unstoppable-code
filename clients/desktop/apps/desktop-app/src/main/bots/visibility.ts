import type { BotPin, BotRecord } from '@canopy/protocol/canopy-core';
import { APP_ADVISOR_BOT_ID } from '@canopy/protocol/chat-targets';
import {
  BotRegistryError,
  getBotRegistryStore,
  type BotRegistryStore,
} from './registry-store';
import { isBotsExperimentEnabled } from './gate';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { savedLocalProjectExists } from './saved-projects';
export { isBotsExperimentEnabled } from './gate';

interface BotVisibilityDependencies {
  store: BotRegistryStore;
  isEnabled: () => boolean;
  projectExists: (projectId: string) => Promise<boolean>;
}

export function createBotVisibility(dependencies: BotVisibilityDependencies): {
  readVisibleBots(): Promise<BotRecord[]>;
  readVisibleBot(botId: string): Promise<BotRecord>;
} {
  async function readVisibleBots(): Promise<BotRecord[]> {
    await dependencies.store.load();
    const enabled = dependencies.isEnabled();
    const records = dependencies.store
      .snapshot()
      .filter(
        (record) =>
          record.deletedAt === null &&
          (enabled || record.botId === APP_ADVISOR_BOT_ID),
      );
    const visible: BotRecord[] = [];
    let loggedUnconfirmedPin = false;
    for (const record of records) {
      const pins: BotPin[] = [];
      for (const pin of record.pins) {
        try {
          if (await dependencies.projectExists(pin.projectId)) pins.push(pin);
        } catch {
          if (!loggedUnconfirmedPin) {
            loggedUnconfirmedPin = true;
            try {
              logMainProcessWarn(
                '[bots] Saved project pin could not be verified; hiding it.',
              );
            } catch {
              // A logging failure must not block visibility reads.
            }
          }
        }
      }
      visible.push({ ...record, pins });
    }
    return dependencies.isEnabled()
      ? visible
      : visible.filter((record) => record.botId === APP_ADVISOR_BOT_ID);
  }

  async function readVisibleBot(botId: string): Promise<BotRecord> {
    const record = (await readVisibleBots()).find((bot) => bot.botId === botId);
    if (!record) throw new BotRegistryError('unknown_bot');
    return record;
  }

  return { readVisibleBots, readVisibleBot };
}

function mainBotVisibility(): ReturnType<typeof createBotVisibility> {
  return createBotVisibility({
    store: getBotRegistryStore(),
    isEnabled: isBotsExperimentEnabled,
    projectExists: savedLocalProjectExists,
  });
}

export async function readVisibleBots(): Promise<BotRecord[]> {
  return mainBotVisibility().readVisibleBots();
}

export async function readVisibleBot(botId: string): Promise<BotRecord> {
  return mainBotVisibility().readVisibleBot(botId);
}
