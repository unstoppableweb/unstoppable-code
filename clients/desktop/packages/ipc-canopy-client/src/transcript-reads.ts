/**
 * Delegate transcript reads over the narrow `chat:read-delegation-*` channels
 * (CAN-7432), for a controller that has no transcript-read port of its own.
 * The host serves each read from the core transcript operations, only for a
 * delegation child of the named chat, and answers with the typed reply
 * envelope; this client validates the value against the same core schemas
 * the desktop's local reader uses. Reads resolve and never reject.
 */
import type {
  CanopyCapabilities,
  DelegationBlocksPage,
  DelegationPage,
  TranscriptContentRange,
  TranscriptReadClient,
  TranscriptReadResult,
  TranscriptReadSource,
} from '@canopy/app-core';
import {
  CoreChatContentReadResultSchema,
  CoreChatTranscriptBoundedBlocksPageResultSchema,
  parseCoreChatChildPage,
} from '@canopy/protocol/canopy-core';
import { CHANNEL_UNAVAILABLE_CODE } from '@canopy/protocol/remote-control';
import { RemoteControlTranscriptReadReplySchema } from '@canopy/protocol/remote-control/delegation-reads';
import type { RemoteIpcChannel } from '@canopy/protocol/remote-control/channels';
import { REMOTE_IPC_CHANNELS } from '@canopy/protocol/remote-control/channels';
import {
  REMOTE_IPC_UNAUTHORIZED_CODE,
  type ChannelClient,
} from './channel-client';
import { anyReply } from './decoders';

const C = REMOTE_IPC_CHANNELS;

const CANCELLED = { ok: false, kind: 'cancelled' } as const;
const UNAVAILABLE = { ok: false, kind: 'unavailable' } as const;
const FAILED = { ok: false, kind: 'failed' } as const;

/** The channel was refused: by this controller's list or by the host. */
function isRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return false;
  return (
    error.code === CHANNEL_UNAVAILABLE_CODE ||
    error.code === REMOTE_IPC_UNAUTHORIZED_CODE
  );
}

/** The wire scope every delegation read carries. */
function wireScope(source: TranscriptReadSource): Record<string, unknown> {
  return {
    projectId: source.scope.workspaceId,
    worktreeId: source.scope.worktreeId,
    chatId: source.scope.chatId,
    ...(source.archivedContainerId === undefined
      ? {}
      : { archivedContainerId: source.archivedContainerId }),
  };
}

function readPage(value: unknown): TranscriptReadResult<DelegationPage> {
  const page = parseCoreChatChildPage(value);
  return page ? { ok: true, value: page } : FAILED;
}

function readContent(
  value: unknown,
): TranscriptReadResult<TranscriptContentRange> {
  const parsed = CoreChatContentReadResultSchema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : FAILED;
}

function readBlocks(
  value: unknown,
): TranscriptReadResult<DelegationBlocksPage> {
  const parsed =
    CoreChatTranscriptBoundedBlocksPageResultSchema.safeParse(value);
  if (!parsed.success) return FAILED;
  const page = parsed.data;
  return {
    ok: true,
    value: {
      messageId: page.messageId,
      firstBlockOrdinal: page.firstBlockOrdinal,
      entries: page.entries,
      blockCount: page.blockCount,
      transcriptRevision: page.transcriptRevision,
      ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      ...(page.nextBlockOrdinal !== undefined
        ? { nextBlockOrdinal: page.nextBlockOrdinal }
        : {}),
      ...(page.runTruncated ? { runTruncated: page.runTruncated } : {}),
    },
  };
}

/**
 * One read of `source`, sending `request` on `channel`. A standalone-history
 * source is not served over these channels (CAN-7432): it resolves
 * `unavailable` without sending anything.
 */
async function read<T>(
  channels: ChannelClient,
  channel: RemoteIpcChannel,
  source: TranscriptReadSource,
  request: Record<string, unknown>,
  signal: AbortSignal,
  validate: (value: unknown) => TranscriptReadResult<T>,
): Promise<TranscriptReadResult<T>> {
  if (signal.aborted) return CANCELLED;
  if (source.standaloneHistory === true) return UNAVAILABLE;
  let reply: unknown;
  try {
    reply = await channels.invoke(channel, anyReply<unknown>(), request);
  } catch (error) {
    if (signal.aborted) return CANCELLED;
    return isRefused(error) ? UNAVAILABLE : FAILED;
  }
  if (signal.aborted) return CANCELLED;
  const envelope = RemoteControlTranscriptReadReplySchema.safeParse(reply);
  if (!envelope.success) return FAILED;
  if (!envelope.data.ok) return { ok: false, kind: envelope.data.reason };
  return validate(envelope.data.value);
}

/**
 * A {@link TranscriptReadClient} over the delegation read channels. Block
 * pages need `delegationBlockReads`, read from `capabilities()` on each call;
 * a primary target's content is never read here.
 */
export function createChannelTranscriptReadClient(
  channels: ChannelClient,
  capabilities: () => CanopyCapabilities,
): TranscriptReadClient {
  return {
    delegationPage: (request, signal) =>
      read(
        channels,
        C.chatReadDelegationPage,
        request,
        {
          ...wireScope(request),
          target: request.target,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        },
        signal,
        readPage,
      ),
    content: (request, signal) => {
      if (signal.aborted) return Promise.resolve(CANCELLED);
      const target = request.target;
      if (target.kind !== 'delegation') return Promise.resolve(UNAVAILABLE);
      return read(
        channels,
        C.chatReadDelegationContent,
        request,
        {
          ...wireScope(request),
          target,
          messageId: request.messageId,
          blockOrdinal: request.blockOrdinal,
          field: request.field,
          ...(request.fieldSource === undefined
            ? {}
            : { fieldSource: request.fieldSource }),
          offset: request.offset,
          limit: request.limit,
        },
        signal,
        readContent,
      );
    },
    blocks: (request, signal) => {
      if (signal.aborted) return Promise.resolve(CANCELLED);
      if (capabilities().delegationBlockReads !== true)
        return Promise.resolve(UNAVAILABLE);
      return read(
        channels,
        C.chatReadDelegationBlocks,
        request,
        {
          ...wireScope(request),
          target: request.target,
          messageId: request.messageId,
          ...(request.firstBlockOrdinal === undefined
            ? {}
            : { firstBlockOrdinal: request.firstBlockOrdinal }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          limit: request.limit,
        },
        signal,
        readBlocks,
      );
    },
  };
}
