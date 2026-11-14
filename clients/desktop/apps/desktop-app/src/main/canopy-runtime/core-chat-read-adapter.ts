import {
  CoreChatContentReadResultSchema,
  CoreChatTranscriptPageResultSchema,
  CoreChatTranscriptBlocksPageResultSchema,
  CoreChatSendReceiptResultSchema,
  type CoreChatContentReadResult,
  type CoreChatTranscriptBlocksPageResult,
  type CoreChatSendReceiptResult,
  type CoreChatTranscriptPageResult,
  type CoreChatTranscriptSearchResult,
  type CoreChatToolOutputReadResult,
  type CoreChatVisualReadResult,
  type CanopyQueryHandlerMap,
  type CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import type {
  ChatStateCommandPort,
  ChatStateLoadError,
  ChatTranscriptSearchResult,
  ChatToolOutputResponse,
} from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import { getChatStateCommandPort } from '../ipc/chat-state';
import { IdentifierValidationError } from '../lib/identifier-validation-error';
import { fitBoundedBlockPage } from './bounded-block-page';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { ChatVisualReadError } from '../lib/chat-visual-read-errors';

export interface CoreChatReadServices {
  getPort(): ChatStateCommandPort | null;
}

export interface CoreChatReadCapture {
  requestId(): string | undefined;
  page(result: TranscriptPage): void;
  search(result: ChatTranscriptSearchResult): void;
  toolOutput(result: ChatToolOutputResponse): void;
  toolOutputPending(read: Promise<ChatToolOutputResponse>): void;
}

type ChatReadHandlers = Pick<
  CanopyQueryHandlerMap<CanopyHandlerContext>,
  | 'core.chat.transcript.page'
  | 'core.chat.transcript.search'
  | 'core.chat.toolOutput.read'
  | 'core.chat.content.read'
  | 'core.chat.transcript.blocks.page'
  | 'core.chat.visual.read'
  | 'core.chat.send.receipt'
>;

/** Sources a visual read can name that no longer exist or never did. */
function isMissingVisualSource(error: unknown, chatId: string): boolean {
  return (
    error instanceof Error &&
    (error.message === `Unknown chat: ${chatId}` ||
      error.message === 'Standalone archive not found' ||
      error.message === 'Archived chat payloads have already been restored' ||
      /^Archived container .+ was not found$/.test(error.message))
  );
}

/** A revision this host does not advertise, refused before any read. */
export function unservedRevision(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    message: 'Desktop chats do not serve this revision.',
    details: { unsupported: ['revision'], reason: 'unserved' },
    retry: { kind: 'after_refresh', resource: 'core.runtime.manifest.get' },
  });
}

function visualOperationError(
  kind: 'not_found' | 'failed_precondition' | 'invalid_argument' | 'cancelled',
  message: string,
  error: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind,
      message,
      ...(kind === 'not_found'
        ? { code: 'core.chat.visual.read.notFound' }
        : kind === 'failed_precondition'
          ? { code: 'core.chat.visual.read.invalidState' }
          : {}),
      retry: { kind: 'never' },
    },
    error,
  );
}

/**
 * Visual reads use fixed messages: a storage or filesystem message can carry
 * a host path, which must not cross the portable boundary.
 */
function translateVisualError(error: unknown, chatId: string): never {
  if (error instanceof CanopyOperationError) throw error;
  if (error instanceof ChatVisualReadError)
    throw visualOperationError(
      error.reason === 'not_found' ? 'not_found' : 'failed_precondition',
      error.message,
      error,
    );
  if (error instanceof Error && error.name === 'AbortError')
    throw visualOperationError(
      'cancelled',
      'Chat visual read cancelled.',
      error,
    );
  if (isMissingVisualSource(error, chatId))
    throw visualOperationError('not_found', 'Chat visual not found.', error);
  if (error instanceof IdentifierValidationError)
    throw visualOperationError(
      'invalid_argument',
      'Invalid chat visual request.',
      error,
    );
  if (isChatStateLoadError(error))
    throw new CanopyOperationError(
      {
        kind:
          error.code === 'invalid_request'
            ? 'invalid_argument'
            : error.code === 'unavailable'
              ? 'unavailable'
              : 'failed_precondition',
        message: 'Chat state is unavailable for this visual read.',
        retry: { kind: 'never' },
      },
      error,
    );
  throw new CanopyOperationError(
    {
      kind: 'internal',
      message: 'Chat visual read failed.',
      retry: { kind: 'never' },
    },
    error,
  );
}

function requireScope(scope: CanopyWorkspaceScope): {
  projectId: string;
  worktreeId: string;
  chatId: string;
} {
  if (!scope.workspaceId || !scope.worktreeId || !scope.chatId) {
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'Chat reads require workspaceId, worktreeId and chatId.',
      retry: { kind: 'never' },
    });
  }
  if (
    scope.targetId !== undefined ||
    (scope.authorityId !== undefined &&
      scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
  ) {
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected chat authority or target is unavailable.',
      retry: { kind: 'never' },
    });
  }
  return {
    projectId: scope.workspaceId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
  };
}

function requirePort(services: CoreChatReadServices): ChatStateCommandPort {
  const port = services.getPort();
  if (!port) {
    throw new CanopyOperationError({
      kind: 'unavailable',
      message: 'The chat state service is temporarily unavailable.',
      retry: { kind: 'same_request' },
    });
  }
  return port;
}

function isChatStateLoadError(
  error: unknown,
): error is Error & ChatStateLoadError {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : undefined;
  return (
    error.name === 'ChatStateLoadError' &&
    (code === 'recovery_error' ||
      code === 'unavailable' ||
      code === 'invalid_request')
  );
}

function translateError(error: unknown, chatId?: string): never {
  if (error instanceof CanopyOperationError) throw error;
  const message =
    error instanceof Error && error.message
      ? error.message.slice(0, 4096)
      : 'Chat read failed.';
  const kind =
    error instanceof IdentifierValidationError
      ? 'invalid_argument'
      : error instanceof Error &&
          (error.message === 'Invalid transcript page cursor' ||
            error.message === 'Unknown transcript turn' ||
            error.message === 'Invalid turn page cursor' ||
            error.message === 'Invalid transcript block range' ||
            error.message === 'Invalid tool output range' ||
            error.message === 'Tool output offset splits a UTF-8 character' ||
            error.message === 'Tool output offset splits a UTF-16 code unit')
        ? 'invalid_argument'
        : error instanceof Error &&
            (error.message === 'Unknown child stream' ||
              error.message === 'Transcript message not found' ||
              error.message ===
                'Transcript field has no stored body for this row')
          ? 'not_found'
          : error instanceof Error &&
              (error.message === 'Stale transcript stream cursor' ||
                error.message === 'Stale transcript blocks cursor')
            ? 'failed_precondition'
            : error instanceof Error &&
                (error.message === 'Standalone archive not found' ||
                  (chatId !== undefined &&
                    error.message === `Unknown chat: ${chatId}`))
              ? 'not_found'
              : isChatStateLoadError(error)
                ? error.code === 'invalid_request'
                  ? 'invalid_argument'
                  : error.code === 'unavailable'
                    ? 'unavailable'
                    : 'failed_precondition'
                : error instanceof Error && error.name === 'AbortError'
                  ? 'cancelled'
                  : 'internal';
  throw new CanopyOperationError(
    {
      kind,
      ...(error instanceof Error &&
      error.message === 'Stale transcript blocks cursor'
        ? { code: 'core.chat.transcript.blocks.page.staleCursor' }
        : {}),
      message,
      retry: { kind: 'never' },
    },
    error,
  );
}

function portablePage(
  page: TranscriptPage,
): ReturnType<typeof CoreChatTranscriptPageResultSchema.parse> {
  const projectMessage = (
    message: TranscriptPage['messages'][number],
  ): Record<string, unknown> => ({
    ...message,
    blocks: portableBlocks(message.blocks),
  });
  const serialized = JSON.stringify(
    {
      ...page,
      // Tile paths belong to the host-local compatibility result captured
      // above. Portable consumers need worker file handles before receiving
      // these deliverables, just as attachments need host projection today.
      turns: page.turns?.map((turn) =>
        turn.files
          ? Object.fromEntries(
              Object.entries(turn).filter(([key]) => key !== 'files'),
            )
          : turn,
      ),
      messages: page.messages
        .filter((message) => !message.hidden)
        .map(projectMessage),
      latestHumanMessage:
        page.latestHumanMessage && !page.latestHumanMessage.hidden
          ? projectMessage(page.latestHumanMessage)
          : undefined,
    },
    (key: string, value: unknown): unknown => {
      if (
        key === 'absolutePath' ||
        key === 'attachmentPath' ||
        key === 'attachmentPaths' ||
        key === 'attachmentPromptContexts'
      )
        return undefined;
      return value;
    },
  );
  return CoreChatTranscriptPageResultSchema.parse(JSON.parse(serialized));
}

/**
 * Child pages cross the renderer relay, whose replies are capped at 1 MiB.
 * The backend already keeps a page's rows within 768 KiB; this is the guard
 * on the whole result, so an oversized page fails here, not in the relay.
 */
const CHILD_PAGE_RESULT_BYTES = 960_000;

const HOST_PATH_FIELDS = [
  'absolutePath',
  'attachmentPath',
  'attachmentPaths',
  'attachmentPromptContexts',
];

function portableBlocks(blocks: readonly unknown[]): unknown[] {
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(project);
    if (typeof value !== 'object' || value === null) return value;
    const imageBlock = 'type' in value && value.type === 'image';
    const compactionBlock = 'type' in value && value.type === 'compaction_info';
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => {
          if (HOST_PATH_FIELDS.includes(key)) return false;
          if (imageBlock && key === 'path') return false;
          if (compactionBlock && key === 'transcriptPath') return false;
          return true;
        })
        .map(([key, child]) => [key, project(child)]),
    );
  };
  return blocks.map(project);
}

export function createCoreChatReadAdapter(
  services: CoreChatReadServices = { getPort: getChatStateCommandPort },
  capture?: CoreChatReadCapture,
): ChatReadHandlers {
  return {
    'core.chat.send.receipt': async (
      params,
    ): Promise<CoreChatSendReceiptResult> => {
      try {
        const chatScope = requireScope(params.scope);
        const port = requirePort(services);
        const identity = params.identity
          ? { chatId: chatScope.chatId, ...params.identity }
          : undefined;
        let receipt;
        if (identity && port.getPortalSendReceipt) {
          const probe = await port.getPortalSendReceipt({
            projectId: chatScope.projectId,
            worktreeId: chatScope.worktreeId,
            commandId: params.commandId,
            identity,
          });
          if (probe.outcome !== 'matched') return { outcome: probe.outcome };
          receipt = probe.receipt;
        } else {
          if (!port.getCommandReceipt) {
            throw new CanopyOperationError({
              kind: 'capability_unavailable',
              message: 'Chat send receipts are unavailable.',
              retry: { kind: 'never' },
            });
          }
          receipt = await port.getCommandReceipt({
            projectId: chatScope.projectId,
            worktreeId: chatScope.worktreeId,
            commandId: params.commandId,
          });
          if (!receipt) return { outcome: 'missing' };
          if (
            receipt.entityId !== chatScope.chatId ||
            !receipt.messageId ||
            (receipt.portalSend &&
              receipt.portalSend.chatId !== chatScope.chatId) ||
            (identity &&
              (receipt.messageId !== identity.userMessageId ||
                !receipt.portalSend ||
                receipt.portalSend.fingerprint !== identity.fingerprint))
          ) {
            return { outcome: 'conflict' };
          }
        }
        return CoreChatSendReceiptResultSchema.parse({
          outcome: 'matched',
          receipt: {
            commandId: receipt.commandId,
            revision: receipt.revision,
            outcome: receipt.outcome,
            ...(receipt.entityId ? { entityId: receipt.entityId } : {}),
            ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
          },
        });
      } catch (error) {
        return translateError(error, params.scope.chatId);
      }
    },
    'core.chat.transcript.page': async (
      params,
    ): Promise<CoreChatTranscriptPageResult> => {
      // A cloud chat's meters (CAN-6509); desktop advertises no revision.
      if (params.revision !== undefined) throw unservedRevision();
      try {
        const chatScope = requireScope(params.scope);
        const result = await requirePort(services).getTranscriptPage({
          ...chatScope,
          ...(params.archivedContainerId === undefined
            ? {}
            : { archivedContainerId: params.archivedContainerId }),
          ...(params.standaloneHistory === undefined
            ? {}
            : { standaloneHistory: params.standaloneHistory }),
          ...(params.target === undefined ? {} : { target: params.target }),
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          ...(params.before === undefined ? {} : { before: params.before }),
          ...(params.view === undefined ? {} : { view: params.view }),
          ...(params.turnId === undefined ? {} : { turnId: params.turnId }),
          ...(params.transcriptRevision === undefined
            ? {}
            : { transcriptRevision: params.transcriptRevision }),
        });
        capture?.page(result);
        const page = portablePage(result);
        if (
          params.target?.kind === 'delegation' &&
          Buffer.byteLength(JSON.stringify(page), 'utf8') >
            CHILD_PAGE_RESULT_BYTES
        )
          throw new CanopyOperationError({
            kind: 'resource_exhausted',
            message: 'The child transcript page is too large to return.',
            retry: { kind: 'never' },
          });
        return page;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Stale transcript stream cursor'
        )
          throw new CanopyOperationError(
            {
              kind: 'failed_precondition',
              code: 'core.chat.transcript.page.staleCursor',
              message: error.message,
              retry: { kind: 'never' },
            },
            error,
          );
        return translateError(error, params.scope.chatId);
      }
    },
    'core.chat.transcript.search': async (
      params,
      context,
    ): Promise<CoreChatTranscriptSearchResult> => {
      try {
        const chatScope = requireScope(params.scope);
        const result = await requirePort(services).searchTranscript(
          {
            ...chatScope,
            ...(params.target === undefined ? {} : { target: params.target }),
            query: params.query,
            requestId: capture?.requestId() ?? context.requestId,
          },
          context.signal,
        );
        capture?.search(result);
        return result;
      } catch (error) {
        return translateError(error, params.scope.chatId);
      }
    },
    'core.chat.toolOutput.read': async (
      params,
      context,
    ): Promise<CoreChatToolOutputReadResult> => {
      try {
        const chatScope = requireScope(params.scope);
        const read = requirePort(services).readToolOutput(
          {
            ...chatScope,
            ...(params.archivedContainerId === undefined
              ? {}
              : { archivedContainerId: params.archivedContainerId }),
            ...(params.standaloneHistory === undefined
              ? {}
              : { standaloneHistory: params.standaloneHistory }),
            ...(params.target === undefined ? {} : { target: params.target }),
            messageId: params.messageId,
            toolUseId: params.toolUseId,
            reference: params.reference,
            offset: params.offset,
            limit: params.limit,
            requestId: capture?.requestId() ?? context.requestId,
          },
          context.signal,
        );
        capture?.toolOutputPending(read);
        const result = await read;
        capture?.toolOutput(result);
        return result;
      } catch (error) {
        return translateError(error, params.scope.chatId);
      }
    },
    'core.chat.content.read': async (
      params,
      context,
    ): Promise<CoreChatContentReadResult> => {
      try {
        const chatScope = requireScope(params.scope);
        const port = requirePort(services);
        if (!port.readTranscriptContent) {
          throw new CanopyOperationError({
            kind: 'capability_unavailable',
            message: 'Transcript content reads are unavailable.',
            retry: { kind: 'never' },
          });
        }
        const result = await port.readTranscriptContent(
          {
            ...chatScope,
            ...(params.archivedContainerId === undefined
              ? {}
              : { archivedContainerId: params.archivedContainerId }),
            ...(params.standaloneHistory === undefined
              ? {}
              : { standaloneHistory: params.standaloneHistory }),
            ...(params.target === undefined ? {} : { target: params.target }),
            messageId: params.messageId,
            blockOrdinal: params.blockOrdinal,
            field: params.field,
            ...(params.fieldSource === undefined
              ? {}
              : { fieldSource: params.fieldSource }),
            requestId: capture?.requestId() ?? context.requestId,
            offset: params.offset,
            limit: params.limit,
          },
          context.signal,
        );
        return CoreChatContentReadResultSchema.parse(result);
      } catch (error) {
        return translateError(error, params.scope.chatId);
      }
    },
    'core.chat.transcript.blocks.page': async (
      params,
      context,
    ): Promise<CoreChatTranscriptBlocksPageResult> => {
      try {
        const chatScope = requireScope(params.scope);
        const port = requirePort(services);
        if (!port.getTranscriptBlocks) {
          throw new CanopyOperationError({
            kind: 'capability_unavailable',
            message: 'Transcript block reads are unavailable.',
            retry: { kind: 'never' },
          });
        }
        const request = {
          ...chatScope,
          ...(params.archivedContainerId === undefined
            ? {}
            : { archivedContainerId: params.archivedContainerId }),
          ...(params.standaloneHistory === undefined
            ? {}
            : { standaloneHistory: params.standaloneHistory }),
          ...(params.target === undefined ? {} : { target: params.target }),
          messageId: params.messageId,
          ...(params.firstBlockOrdinal === undefined
            ? {}
            : { firstBlockOrdinal: params.firstBlockOrdinal }),
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          limit: params.limit,
        };
        const read = port.getTranscriptBlocks.bind(port);
        if (params.projection === 'bounded-v1') {
          return await fitBoundedBlockPage(request, read, context.signal);
        }
        const result = await read(request, context.signal);
        return CoreChatTranscriptBlocksPageResultSchema.parse({
          ...result,
          blocks: portableBlocks(result.blocks),
        });
      } catch (error) {
        return translateError(error, params.scope.chatId);
      }
    },
    'core.chat.visual.read': async (
      params,
      context,
    ): Promise<CoreChatVisualReadResult> => {
      try {
        const chatScope = requireScope(params.scope);
        const result = await requirePort(services).readVisual(
          {
            ...chatScope,
            ...(params.archivedContainerId === undefined
              ? {}
              : { archivedContainerId: params.archivedContainerId }),
            ...(params.standaloneHistory === undefined
              ? {}
              : { standaloneHistory: params.standaloneHistory }),
            messageId: params.messageId,
            toolUseId: params.toolUseId,
            reference: params.reference,
            offset: params.offset,
            limit: params.limit,
          },
          context.signal,
        );
        return {
          data: Buffer.from(result.bytes).toString('base64'),
          offset: result.offset,
          length: result.length,
          byteLength: result.byteLength,
          sha256: result.sha256,
        };
      } catch (error) {
        return translateVisualError(error, params.scope.chatId);
      }
    },
  };
}
