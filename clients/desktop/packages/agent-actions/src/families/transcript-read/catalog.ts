import { z } from 'zod';
import type {
  AgentActionCatalogEntry,
  AgentActionField,
} from '../../catalog/types';
import type { AgentActionFamilyJsonSchema } from '../../surface/family';
import type { AgentJsonSchema } from '../../tools/definition';
import {
  transcriptBlocksActionSchema,
  transcriptContentActionSchema,
  transcriptPageActionSchema,
  transcriptReadTargetSchema,
  type TranscriptReadActionType,
} from './actions';

const target = {
  kind: 'delegation',
  chatId: 'owner-chat',
  delegationId: 'child-run',
  runGeneration: 1,
};
const cloudPageNote =
  'Cloud chats have no delegation runs yet, so this answers unsupported_action there.';
const cloudNote =
  'Cloud chats read only primary transcripts of chats in the current project: use {kind: "primary", chatId} with a known message id. Cloud chats have no delegation runs yet, so delegation targets answer unsupported_action there.';
const discoveryNote =
  'Use ListDelegates and InspectDelegate for your runs, or delegation.tree in App Advisor. Other chats, historical runs and archives require a known owner and run locator. Page results provide message ids and block ordinals.';
const fields: Record<string, AgentActionField> = {
  target: {
    name: 'target',
    type: 'object',
    required: true,
    description:
      'Owner chat and exact run: {kind: "delegation", chatId, delegationId, runGeneration}. Generation must be a positive safe integer; identities are at most 256 characters. Content and block reads also accept {kind: "primary", chatId}.',
  },
  cursor: {
    name: 'cursor',
    type: 'string',
    required: false,
    description:
      'Opaque cursor from the preceding page, 1–2,048 characters. Bound to its owner, target, revision and read kind. A stale or foreign cursor requires restarting without a cursor.',
  },
  messageId: {
    name: 'messageId',
    type: 'string',
    required: true,
    description: 'Message id from the transcript page, 1–512 characters.',
  },
  blockOrdinal: {
    name: 'blockOrdinal',
    type: 'number',
    required: true,
    description: 'Nonnegative absolute block ordinal in the message.',
  },
  field: {
    name: 'field',
    type: 'string',
    required: true,
    description:
      'Readable field: text, input, output, partialText or finalText.',
  },
  fieldSource: {
    name: 'fieldSource',
    type: 'string',
    required: false,
    description:
      'logical (default) reads the complete displayed field, whether inline or stored apart. stored reads only a body stored apart from its row.',
  },
  offset: {
    name: 'offset',
    type: 'number',
    required: true,
    description:
      'Nonnegative byte offset in the body’s stored encoding, not a character index. Continue with nextOffset unchanged.',
  },
  limit: {
    name: 'limit',
    type: 'number',
    required: false,
    description:
      'Content bytes: 4–65,536, default 16,384. Block entries: 1–512, default 16.',
  },
  firstBlockOrdinal: {
    name: 'firstBlockOrdinal',
    type: 'number',
    required: false,
    description:
      'First absolute block ordinal, default zero. Never combine with cursor.',
  },
};
function selectFields(names: string[]): AgentActionField[] {
  return names.flatMap((name) => (fields[name] ? [fields[name]] : []));
}

export function transcriptReadActionCatalog(): readonly AgentActionCatalogEntry<TranscriptReadActionType>[] {
  const rows: AgentActionCatalogEntry<TranscriptReadActionType>[] = [
    {
      type: 'chat.transcript.page',
      category: 'chat',
      summary:
        'Read the newest retained page of a child run, then follow its cursor to older pages.',
      fields: selectFields(['target', 'cursor']),
      example: { type: 'chat.transcript.page', target },
      keywords: ['delegation', 'child', 'transcript', 'page', 'history'],
      notes: [
        cloudPageNote,
        discoveryNote,
        'Delegation targets only. Up to 500 rows, 768 KiB stored selection and 960,000 bytes for the core result. Rows within a page are oldest to newest; no cursor means completion. runTruncated means retained-source loss, not another page. Use chat.get for the latest primary response.',
      ],
    },
    {
      type: 'chat.content.read',
      category: 'chat',
      summary:
        'Read a complete message field in byte ranges, including text shortened in a preview.',
      fields: selectFields([
        'target',
        'messageId',
        'blockOrdinal',
        'field',
        'fieldSource',
        'offset',
        'limit',
      ]),
      example: {
        type: 'chat.content.read',
        target,
        messageId: 'message-1',
        blockOrdinal: 0,
        field: 'text',
        offset: 0,
      },
      keywords: ['body', 'content', 'read', 'bytes', 'text'],
      notes: [
        cloudNote,
        discoveryNote,
        'Ranges bound the reply, not cold storage I/O. Preserve text and nextOffset exactly; offsets use the stored encoding.',
      ],
    },
    {
      type: 'chat.transcript.blocks.page',
      category: 'chat',
      summary:
        'Read a bounded page of message blocks, with previews for larger fields.',
      fields: selectFields([
        'target',
        'messageId',
        'firstBlockOrdinal',
        'cursor',
        'limit',
      ]),
      example: {
        type: 'chat.transcript.blocks.page',
        target,
        messageId: 'message-1',
      },
      keywords: ['blocks', 'transcript', 'preview', 'page'],
      notes: [
        cloudNote,
        discoveryNote,
        'Always bounded-v1: at most 512 entries and 768 KiB, with readable previews up to 4,000 characters. Preserve absolute ordinals and omittedFields; open full fields with chat.content.read using logical.',
      ],
    },
  ];
  return rows.map((row) => ({
    ...row,
    notes: [
      ...(row.notes ?? []),
      'The pretty-printed action reply and its JSON text wrapper must fit 1 MiB; larger replies fail with quota_exceeded, never clipped. Retry content with a smaller limit or read known message blocks and fields individually. Page selection has no adjustable limit. Legacy acquisition may still read the whole source.',
    ],
  }));
}

function jsonSchema(schema: z.ZodType): AgentJsonSchema {
  return z
    .record(z.string(), z.json())
    .parse(
      Object.fromEntries(
        Object.entries(z.toJSONSchema(schema, { io: 'input' })).filter(
          ([key]) => key !== '~standard' && key !== '$schema',
        ),
      ),
    );
}
const schemas = [
  transcriptPageActionSchema,
  transcriptContentActionSchema,
  transcriptBlocksActionSchema,
];
export const transcriptReadDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    target: jsonSchema(transcriptReadTargetSchema),
    ...Object.fromEntries(
      Object.entries(transcriptContentActionSchema.shape)
        .filter(([key]) => key !== 'type' && key !== 'target')
        .map(([key, value]) => [key, jsonSchema(value)]),
    ),
    ...Object.fromEntries(
      Object.entries(transcriptBlocksActionSchema.shape)
        .filter(([key]) => key !== 'type' && key !== 'target')
        .map(([key, value]) => [key, jsonSchema(value)]),
    ),
    limit: {
      anyOf: [
        jsonSchema(transcriptContentActionSchema.shape.limit),
        jsonSchema(transcriptBlocksActionSchema.shape.limit),
      ],
    },
  },
  allOf: [
    ...schemas.map((schema) => ({
      if: {
        properties: { type: { const: schema.shape.type.value } },
        required: ['type'],
      },
      then: jsonSchema(schema),
    })),
    {
      if: {
        properties: { type: { const: 'chat.transcript.blocks.page' } },
        required: ['type'],
      },
      then: { not: { required: ['cursor', 'firstBlockOrdinal'] } },
    },
  ],
};
