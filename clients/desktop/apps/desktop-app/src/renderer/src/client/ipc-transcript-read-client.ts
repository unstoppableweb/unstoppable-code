import type {
  DelegationPage,
  DelegationPageRequest,
  TranscriptReadClient,
  TranscriptReadResult,
  TranscriptReadSource,
} from '@canopy/app-core';
import {
  createWebCoreTranscriptReadClient,
  type WebCoreTranscriptScope,
} from '@canopy/app-state/core-cowork';
import {
  CoreChatContentReadResultSchema,
  CoreChatTranscriptBoundedBlocksPageResultSchema,
  parseCoreChatChildPage,
} from '@canopy/protocol/canopy-core';
import { transcriptReadFailure } from '@canopy/protocol/remote-control/shell';
import type { CanopyCoreRelayReply } from '../../../shared/canopy-core-relay';
import { createRelayCoreCoworkInvoker } from '@/cloud-chats/relay-invoker';
import { webCoreLocalId } from '@/lib/chat-authority';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPage(value: unknown): TranscriptReadResult<DelegationPage> {
  const page = parseCoreChatChildPage(value);
  return page ? { ok: true, value: page } : { ok: false, kind: 'failed' };
}

function failure<T>(error: unknown): TranscriptReadResult<T> {
  if (
    isRecord(error) &&
    (error.kind === 'cancelled' || error.name === 'AbortError')
  )
    return { ok: false, kind: 'cancelled' };
  return { ok: false, kind: transcriptReadFailure(error) };
}

/**
 * Abort fences only: the relay cannot cancel one request. In particular this
 * promise stays pending until the relay settles, so the store retains its permit.
 */
async function invoke<T>(
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  validate: (value: unknown) => TranscriptReadResult<T>,
): Promise<TranscriptReadResult<T>> {
  if (signal.aborted) return { ok: false, kind: 'cancelled' };
  try {
    if (typeof window === 'undefined' || !window.canopyCore) {
      return { ok: false, kind: 'unavailable' };
    }
    const reply: CanopyCoreRelayReply = await window.canopyCore.invoke({
      kind: 'request',
      method,
      params,
    });
    if (signal.aborted) return { ok: false, kind: 'cancelled' };
    return reply.ok ? validate(reply.value) : failure(reply.error);
  } catch (error) {
    return signal.aborted ? { ok: false, kind: 'cancelled' } : failure(error);
  }
}

const localTranscriptReadClient: TranscriptReadClient = {
  delegationPage: (request, signal) =>
    invoke('core.chat.transcript.page', { ...request }, signal, readPage),
  content: (request, signal) =>
    invoke('core.chat.content.read', { ...request }, signal, (value) => {
      const parsed = CoreChatContentReadResultSchema.safeParse(value);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, kind: 'failed' };
    }),
  blocks: (request, signal) =>
    invoke(
      'core.chat.transcript.blocks.page',
      { ...request, projection: 'bounded-v1' },
      signal,
      (value) => {
        const parsed =
          CoreChatTranscriptBoundedBlocksPageResultSchema.safeParse(value);
        if (!parsed.success) return { ok: false, kind: 'failed' };
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
      },
    ),
};

const UNAVAILABLE = { ok: false, kind: 'unavailable' } as const;

/**
 * A cloud chat's own delegate, as its web core ids: null unless the chat's
 * transcript holds that delegate's card (CAN-7027). Installed with the cloud
 * chat runtime, which reads the chat store; until then every cloud read is
 * refused.
 */
type CloudDelegationScope = (
  request: DelegationPageRequest,
) => WebCoreTranscriptScope | null;

let cloudDelegationScope: CloudDelegationScope = () => null;

export function setCloudDelegationScope(resolve: CloudDelegationScope): void {
  cloudDelegationScope = resolve;
}

/** Whether a source names the web core: cloud, local, or neither (mixed). */
function sourceAuthority(
  source: TranscriptReadSource,
): 'web-core' | 'local' | 'mixed' {
  const ids = [source.scope.workspaceId, source.scope.worktreeId];
  const cloud = ids.filter((id) => webCoreLocalId(id) !== null).length;
  if (cloud === 0) return 'local';
  return cloud === ids.length ? 'web-core' : 'mixed';
}

/**
 * The window's transcript reads. A cloud chat's delegate pages go to the web
 * core over the relay, only for a delegate on that chat's own card; a local
 * chat's reads go to the local core as before. A cloud source never reaches
 * the local core, and its bodies and block pages are unavailable, as the web
 * core doesn't serve them here.
 */
export const ipcTranscriptReadClient: TranscriptReadClient = {
  delegationPage: (request, signal) => {
    const authority = sourceAuthority(request);
    if (authority === 'local')
      return localTranscriptReadClient.delegationPage(request, signal);
    const scope =
      authority === 'web-core' ? cloudDelegationScope(request) : null;
    if (scope === null || typeof window === 'undefined' || !window.canopyCore)
      return Promise.resolve(UNAVAILABLE);
    const relay = window.canopyCore;
    return createWebCoreTranscriptReadClient({
      invoker: () => createRelayCoreCoworkInvoker(relay),
      scopeFor: () => scope,
    }).delegationPage(request, signal);
  },
  content: (request, signal) =>
    sourceAuthority(request) === 'local'
      ? localTranscriptReadClient.content(request, signal)
      : Promise.resolve(UNAVAILABLE),
  blocks: (request, signal) =>
    sourceAuthority(request) === 'local'
      ? localTranscriptReadClient.blocks(request, signal)
      : Promise.resolve(UNAVAILABLE),
};
