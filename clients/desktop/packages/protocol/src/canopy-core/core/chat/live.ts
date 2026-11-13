import { z } from 'zod';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../shared';

const id = z.string().min(1).max(512);
/** A UTF-16 length of the provisional text the client holds. */
const offset = z.number().int().nonnegative();

/**
 * The minor schema revision this stream serves (protocol rule 5, CAN-6116):
 * revision 2 adds `tool` items and a turn's `startedAt`. A runtime advertises
 * it in its manifest; a client asks for it with `revision` only when it is
 * advertised, and a client that does not ask gets revision 1 output.
 */
export const CORE_CHAT_LIVE_EVENTS_SCHEMA_REVISION = 2;

/** One chat: the task (`worktreeId`) of its workspace, and the chat itself. */
export const CoreChatLiveEventsParamsSchema = z.strictObject({
  scope: z.strictObject({ workspaceId: id, worktreeId: id, chatId: id }),
  /** Accepted for symmetry; every open starts from the chat's current state. */
  cursor: CanopyStreamCursorSchema.nullable().optional(),
  /** Revision 2 output, sent only when the runtime advertises it. */
  revision: z.literal(CORE_CHAT_LIVE_EVENTS_SCHEMA_REVISION).optional(),
});

export const CoreChatLiveEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});

/**
 * The running turn's provisional reply, never part of the transcript. `turn`
 * carries all of it, `append` what was added since the previous item, at the
 * lengths the client holds; `idle` says no turn runs.
 */
export const CoreChatLiveEventsItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('turn'),
    chatId: id,
    turnId: id,
    /** The prompt this reply answers, as a transcript message id. */
    promptMessageId: id.nullable(),
    text: z.string(),
    reasoning: z.string(),
    state: z.enum(['streaming', 'finished']),
    finishReason: z.string().min(1).max(64).optional(),
    /**
     * On a finished turn, the id of the transcript message the reply was
     * committed as, when the core names it: the client drops the provisional
     * reply once its transcript holds that message.
     */
    messageId: id.optional(),
    /** Revision 2: when the turn started, for its running timer. */
    startedAt: z.iso.datetime({ offset: true }).optional(),
  }),
  z.strictObject({
    kind: z.literal('append'),
    chatId: id,
    turnId: id,
    textOffset: offset,
    text: z.string(),
    reasoningOffset: offset,
    reasoning: z.string(),
  }),
  z.strictObject({ kind: z.literal('idle'), chatId: id }),
  /**
   * Revision 2: one of the running turn's own tool calls, sent again when
   * its result arrives. The client keeps a turn's tools by `toolUseId` in
   * the order they first came, and starts over at the turn's next
   * `streaming` turn item, which every attach sends before its tools.
   */
  z.strictObject({
    kind: z.literal('tool'),
    chatId: id,
    turnId: id,
    toolUseId: id,
    toolName: z.string().min(1).max(512),
    input: z.string(),
    /** The reply text's length when the call came: where its card goes. */
    textOffset: offset,
    result: z
      .strictObject({ output: z.string(), isError: z.boolean() })
      .optional(),
  }),
]);
export type CoreChatLiveEventsItem = z.output<
  typeof CoreChatLiveEventsItemSchema
>;

export const CoreChatLiveEventsErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(['core.chat.notFound']).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreChatLiveEventsEndSchema = CanopyStreamEndSchema.extend({
  error: CoreChatLiveEventsErrorSchema.nullable(),
});

// Served by the web core only (CAN-5984): a cloud chat's reply as Agentic Core
// streams it. Kept out of CORE_STREAM_DEFINITIONS because the desktop
// dispatcher requires a handler for every definition it is given; the desktop
// core does not advertise it, so clients answer capability_unavailable.
export const CORE_CHAT_LIVE_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'core',
  {
    'core.chat.live.events': defineCanopyStream({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.read'],
      params: CoreChatLiveEventsParamsSchema,
      item: CoreChatLiveEventsItemSchema,
      end: CoreChatLiveEventsEndSchema,
      openResult: CoreChatLiveEventsOpenResultSchema,
      error: CoreChatLiveEventsErrorSchema,
    }),
  },
);
