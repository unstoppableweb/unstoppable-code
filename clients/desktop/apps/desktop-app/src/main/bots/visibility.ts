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
  projectVisible(record: BotRecord): Promise<BotRecord>;
} {
  async function withVisiblePins(
    record: BotRecord,
    warning: { logged: boolean },
  ): Promise<BotRecord> {
    const pins: BotPin[] = [];
    for (const pin of record.pins) {
      try {
        if (await dependencies.projectExists(pin.projectId)) pins.push(pin);
      } catch {
        if (!warning.logged) {
          warning.logged = true;
          try {
            logMainProcessWarn(
              '[bots] Saved project pin could not be verified; hiding it.',
            );
          } catch {
            // A logging failure must not block visibility checks.
          }
        }
      }
    }
    return { ...record, pins };
  }

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
    const warning = { logged: false };
    for (const record of records)
      visible.push(await withVisiblePins(record, warning));
    return dependencies.isEnabled()
      ? visible
      : visible.filter((record) => record.botId === APP_ADVISOR_BOT_ID);
  }

  async function readVisibleBot(botId: string): Promise<BotRecord> {
    const record = (await readVisibleBots()).find((bot) => bot.botId === botId);
    if (!record) throw new BotRegistryError('unknown_bot');
    return record;
  }

  /** Filter pins on the supplied record, including a replayed receipt. */
  function projectVisible(record: BotRecord): Promise<BotRecord> {
    return withVisiblePins(record, { logged: false });
  }

  return { readVisibleBots, readVisibleBot, projectVisible };
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

export function projectVisible(record: BotRecord): Promise<BotRecord> {
  return mainBotVisibility().projectVisible(record);
}
