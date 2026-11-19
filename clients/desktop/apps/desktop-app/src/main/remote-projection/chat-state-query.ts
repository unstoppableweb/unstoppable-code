import type { ChatStateSnapshot } from '@canopy/desktop-shared/types';
import type {
  CoreChatSendReceiptParams,
  CoreChatSendReceiptResult,
  CoreChatTranscriptPageParams,
  CoreChatTranscriptPageResult,
  CoreChatTranscriptBlocksPageParams,
  CoreChatTranscriptBoundedBlocksPageResult,
  CoreChatContentReadParams,
  CoreChatContentReadResult,
} from '@canopy/protocol/canopy-core';
import { CoreChatTranscriptBoundedBlocksPageResultSchema } from '@canopy/protocol/canopy-core';
import type { ChatTranscriptPageRequest } from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import type { CanopyQueryOptions } from '@canopy/core-runtime';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import type { RemoteControlAdapterContext } from './adapter-context';

export function createRemoteControlReadOptions(
  context: RemoteControlAdapterContext,
  canRead: (() => boolean) | undefined,
  unavailableMessage = 'Portal transcript authorization is unavailable.',
  signal?: AbortSignal,
): CanopyQueryOptions {
  if (!context.sessionId || canRead?.() !== true)
    throw new Error(unavailableMessage);
  return {
    ...(signal ? { signal } : {}),
    caller: {
      principalId: 'local-desktop-user',
      clientInstanceId: `portal-session:${context.sessionId}`,
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'portal' as const,
      grants: ['core.chat.read'],
    },
  };
}

export async function queryRemoteControlChatTranscriptPage(
  context: RemoteControlAdapterContext,
  request: ChatTranscriptPageRequest,
): Promise<TranscriptPage> {
  const { projectId, worktreeId, chatId, standaloneHistory, ...params } =
    request;
  const { legacyResult } =
    await getActiveDesktopRuntime().queryChatTranscriptPageForLegacyIpc(
      {
        ...params,
        ...(standaloneHistory ? { standaloneHistory: true as const } : {}),
        scope: { workspaceId: projectId, worktreeId, chatId },
      },
      createRemoteControlReadOptions(
        context,
        context.canReadAssets,
        'Portal asset authorization is unavailable.',
      ),
    );
  if (context.canReadAssets?.() !== true)
    throw new Error('Portal asset authorization was revoked.');
  return legacyResult;
}

export async function queryRemoteControlChatSendReceipt(
  context: RemoteControlAdapterContext,
  request: CoreChatSendReceiptParams,
): Promise<CoreChatSendReceiptResult> {
  const result = await getActiveDesktopRuntime().query(
    'core.chat.send.receipt',
    request,
    createRemoteControlReadOptions(
      context,
      context.canReadAssets,
      'Portal asset authorization is unavailable.',
    ),
  );
  if (context.canReadAssets?.() !== true)
    throw new Error('Portal asset authorization was revoked.');
  return result;
}

export async function queryRemoteControlDelegationTranscriptPage(
  context: RemoteControlAdapterContext,
  request: CoreChatTranscriptPageParams,
  signal: AbortSignal,
): Promise<CoreChatTranscriptPageResult> {
  const result = await getActiveDesktopRuntime().query(
    'core.chat.transcript.page',
    request,
    createRemoteControlReadOptions(
      context,
      context.canReadTranscripts,
      undefined,
      signal,
    ),
  );
  if (context.canReadTranscripts?.() !== true)
    throw new Error('Portal transcript authorization was revoked.');
  return result;
}

export async function queryRemoteControlTranscriptBlocksPage(
  context: RemoteControlAdapterContext,
  request: CoreChatTranscriptBlocksPageParams,
  signal: AbortSignal,
): Promise<CoreChatTranscriptBoundedBlocksPageResult> {
  const result = await getActiveDesktopRuntime().query(
    'core.chat.transcript.blocks.page',
    request,
    createRemoteControlReadOptions(
      context,
      context.canReadTranscripts,
      undefined,
      signal,
    ),
  );
  if (context.canReadTranscripts?.() !== true)
    throw new Error('Portal transcript authorization was revoked.');
  return CoreChatTranscriptBoundedBlocksPageResultSchema.parse(result);
}

export async function queryRemoteControlTranscriptContent(
  context: RemoteControlAdapterContext,
  request: CoreChatContentReadParams,
  signal: AbortSignal,
): Promise<CoreChatContentReadResult> {
  const result = await getActiveDesktopRuntime().query(
    'core.chat.content.read',
    request,
    createRemoteControlReadOptions(
      context,
      context.canReadTranscripts,
      undefined,
      signal,
    ),
  );
  if (context.canReadTranscripts?.() !== true)
    throw new Error('Portal transcript authorization was revoked.');
  return result;
}

export async function queryRemoteControlChatState(
  context: RemoteControlAdapterContext,
  request: { projectId: string; worktreeId: string },
): Promise<ChatStateSnapshot> {
  if (!context.sessionId) throw new Error('Portal session is unavailable.');
  const { legacyResult } =
    await getActiveDesktopRuntime().queryChatStateForLegacyIpc(
      {
        scope: {
          workspaceId: request.projectId,
          worktreeId: request.worktreeId,
        },
      },
      {
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: `portal-session:${context.sessionId}`,
          authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
          interfaceKind: 'portal',
          grants: ['core.chat.read'],
        },
      },
    );
  return legacyResult;
}
