import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { AgentActionCatalogEntry } from '../../catalog/types';
import type { CloudChatAction } from './actions';

const requiredFeatureFlag = CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key;

export const cloudChatActionCatalog: readonly AgentActionCatalogEntry<
  CloudChatAction['type'],
  CloudChatAction
>[] = [
  {
    type: 'cloud_chats.list',
    category: 'navigation',
    summary:
      "List the signed-in account's cloud cowork chats in the selected context, as the sidebar shows them.",
    fields: [],
    example: { type: 'cloud_chats.list' },
    keywords: [
      'cloud chats',
      'cloud cowork',
      'cloud projects',
      'list cloud chats',
      'web chats',
    ],
    notes: [
      'Returns each chat id, its project id and name, and its title; never chat content.',
      'Answers surface_unavailable while cloud chats are off or offline in the main window.',
    ],
    requiredFeatureFlag,
  },
  {
    type: 'cloud_chats.open',
    category: 'navigation',
    summary: 'Open a cloud cowork chat in the main window.',
    fields: [
      {
        name: 'chatId',
        type: 'string',
        required: true,
        description: 'A chat id from cloud_chats.list.',
      },
    ],
    example: { type: 'cloud_chats.open', chatId: 'chat-id' },
    keywords: ['open cloud chat', 'show cloud chat', 'cloud cowork chat'],
    notes: [
      'Refuses a chat id the sidebar does not list (not_found). The current UI state names the open cloud chat.',
    ],
    requiredFeatureFlag,
  },
];
