import type {
  ChatMetadata,
  PageResult,
  ProjectTaskRow,
} from './project-discovery';
import type { HistoryResult, LastMessageResult } from './project-reads';
import { firstIssueMessage } from '@canopy/agent-actions/families/projects/actions';
import {
  BOT_READ_TYPES as BOT_ACTION_TYPES,
  botReadActionSchema as botActionSchema,
  type BotReadAction as BotAction,
} from '@canopy/agent-actions/families/bots/actions';

// The schemas moved to the shared bots action family. This module's bot
// actions are its discovery and reads; the writes live in chat-send-actions.
export {
  APP_ADVISOR_BOT_ID,
  BOT_READ_TYPES as BOT_ACTION_TYPES,
  botReadActionSchema as botActionSchema,
  botsGetLastAgentResponseActionSchema,
  botsGetLastUserMessageActionSchema,
  botsListActionSchema,
  botsListTaskChatsActionSchema,
  botsListTasksActionSchema,
  botsReadHistoryActionSchema,
  type BotReadAction as BotAction,
  type BotsGetLastAgentResponseAction,
  type BotsGetLastUserMessageAction,
  type BotsListAction,
  type BotsListTaskChatsAction,
  type BotsListTasksAction,
  type BotsReadHistoryAction,
} from '@canopy/agent-actions/families/bots/actions';

export type BotChatAddress = {
  botId: string;
  taskId: string;
  chatId: string;
};

export type BotRow = {
  botId: string;
  name: string;
  /** Present only while the user-defined Bots experiment is enabled. */
  kind?: 'default' | 'custom';
  description?: string | null;
  scope?: 'default' | 'global' | 'pinned';
  pins?: { projectId: string; name: string }[];
  showInSidebar?: boolean;
  availability: 'available' | 'unavailable';
  unavailableReason?: string;
  taskCount: number | null;
  // Only operations the bot implements today; never steering or scheduling.
  capabilities: {
    listTasks: boolean;
    readChats: boolean;
    sendMessages: boolean;
    createTasks: boolean;
    createChats: boolean;
    watchChats: boolean;
  };
};

export type BotTaskRow = Omit<
  Extract<ProjectTaskRow, { kind: 'work_entry' }>,
  'projectId'
> & { botId: string };
export type BotChatRow = BotChatAddress & ChatMetadata;
export type BotsListResult = PageResult<BotRow>;
export type BotsListTasksResult = PageResult<BotTaskRow> & { botId: string };
export type BotsListTaskChatsResult = PageResult<BotChatRow> & {
  botId: string;
  taskId?: string;
};
export type BotLastMessageResult = Omit<LastMessageResult, 'address'> & {
  address: BotChatAddress;
};
export type BotHistoryResult = Omit<HistoryResult, 'address'> & {
  address: BotChatAddress;
};

export function parseBotAction(
  value: unknown,
): { ok: true; action: BotAction } | { ok: false; message: string } {
  const parsed = botActionSchema.safeParse(value);
  if (parsed.success) return { ok: true, action: parsed.data };
  return {
    ok: false,
    message: firstIssueMessage(parsed.error, 'Invalid bot action'),
  };
}

export function isBotActionType(type: string): type is BotAction['type'] {
  return BOT_ACTION_TYPES.some((actionType) => actionType === type);
}
