import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  IPC_CHANNELS,
  type AgentProviderType,
  type ChatSessionCloudExportDeleteRequest,
  type ChatSessionCloudExportDeleteResponse,
  type ChatSessionCloudExportListRequest,
  type ChatSessionCloudExportListResponse,
  type ChatSessionExportRequest,
  type ChatSessionExportResponse,
  type ChatSessionImportDiscardRequest,
  type ChatSessionImportDiscardResponse,
  type ChatSessionImportInspectRequest,
  type ChatSessionImportInspectResponse,
  type ChatSessionImportRequest,
  type ChatSessionImportResponse,
} from '@canopy/desktop-shared/types';
import {
  CoreChatTransferDeleteParamsSchema,
  CoreChatTransferExportParamsSchema,
  CoreChatTransferImportDiscardParamsSchema,
  CoreChatTransferImportInspectParamsSchema,
  CoreChatTransferImportParamsSchema,
  CoreChatTransferListParamsSchema,
} from '@canopy/protocol/canopy-core';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { preserveRuntimeCauseError } from '../canopy-runtime/runtime-cause-error';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

function transferCaller(grant: 'core.chat.read' | 'core.chat.write'): {
  principalId: string;
  clientInstanceId: string;
  authorityId: string;
  interfaceKind: 'desktop';
  grants: ('core.chat.read' | 'core.chat.write')[];
} {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: 'desktop-main-session-transfer',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop' as const,
    grants: [grant],
  };
}

const PROVIDER_TYPES: Record<AgentProviderType, true> = {
  claude: true,
  codex: true,
  ollama: true,
  cursor: true,
  opencode: true,
  copilot: true,
  antigravity: true,
};

function isAgentProviderType(value: string): value is AgentProviderType {
  return Object.prototype.hasOwnProperty.call(PROVIDER_TYPES, value);
}

function transferKey(): string {
  return `session-transfer-${randomUUID()}`;
}

export function registerSessionTransferHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  // The core transfer host resolves the main window itself.
  void getWindow;
  registerIpcHandler<[ChatSessionExportRequest], ChatSessionExportResponse>(
    IPC_CHANNELS.chatSessionExport,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.chatId, 'chatId');
      const key = transferKey();
      const result = await preserveRuntimeCauseError(
        getActiveDesktopRuntime().instruction(
          'core.chat.transfer.export',
          CoreChatTransferExportParamsSchema.parse({
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            chatId: request.chatId,
            _meta: { idempotencyKey: key },
          }),
          {
            caller: transferCaller('core.chat.write'),
            metadata: { idempotencyKey: key },
          },
        ),
      );
      return {
        exportId: result.transferId,
        title: result.title,
        sizeBytes: result.sizeBytes,
        warnings: result.warnings,
      };
    },
  );

  registerIpcHandler<
    [ChatSessionCloudExportListRequest],
    ChatSessionCloudExportListResponse
  >(IPC_CHANNELS.chatSessionCloudExportList, async (_event, request) => {
    const result = await preserveRuntimeCauseError(
      getActiveDesktopRuntime().query(
        'core.chat.transfer.list',
        CoreChatTransferListParamsSchema.parse({
          ...(request.q === undefined ? {} : { query: request.q }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.limit === undefined
            ? {}
            : { limit: Math.min(request.limit, 200) }),
        }),
        { caller: transferCaller('core.chat.read') },
      ),
    );
    return {
      data: result.transfers.map(({ transferId, ...rest }) => ({
        id: transferId,
        ...rest,
      })),
      nextCursor: result.nextCursor,
    };
  });

  registerIpcHandler<
    [ChatSessionCloudExportDeleteRequest],
    ChatSessionCloudExportDeleteResponse
  >(IPC_CHANNELS.chatSessionCloudExportDelete, async (_event, request) => {
    validateId(request.exportId, 'exportId');
    const key = transferKey();
    await preserveRuntimeCauseError(
      getActiveDesktopRuntime().instruction(
        'core.chat.transfer.delete',
        CoreChatTransferDeleteParamsSchema.parse({
          transferId: request.exportId,
          _meta: { idempotencyKey: key },
        }),
        {
          caller: transferCaller('core.chat.write'),
          metadata: { idempotencyKey: key },
        },
      ),
    );
    return { deleted: true };
  });

  registerIpcHandler<
    [ChatSessionImportInspectRequest],
    ChatSessionImportInspectResponse
  >(IPC_CHANNELS.chatSessionImportInspect, async (_event, request) => {
    validateId(request.workspaceId, 'workspaceId');
    validateId(request.exportId, 'exportId');
    const { transferId, manifestSummary, ...rest } =
      await preserveRuntimeCauseError(
        getActiveDesktopRuntime().instruction(
          'core.chat.transfer.import.inspect',
          CoreChatTransferImportInspectParamsSchema.parse({
            transferId: request.exportId,
            workspaceId: request.workspaceId,
          }),
          { caller: transferCaller('core.chat.write') },
        ),
      );
    const { provider, ...manifest } = manifestSummary;
    return {
      exportId: transferId,
      manifestSummary: {
        ...manifest,
        ...(provider !== undefined && isAgentProviderType(provider)
          ? { provider }
          : {}),
      },
      ...rest,
    };
  });

  registerIpcHandler<[ChatSessionImportRequest], ChatSessionImportResponse>(
    IPC_CHANNELS.chatSessionImport,
    async (_event, request) => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.exportId, 'exportId');
      const key = transferKey();
      return preserveRuntimeCauseError(
        getActiveDesktopRuntime().instruction(
          'core.chat.transfer.import',
          CoreChatTransferImportParamsSchema.parse({
            transferId: request.exportId,
            workspaceId: request.workspaceId,
            ...(request.installMissing === undefined
              ? {}
              : { installMissing: request.installMissing }),
            _meta: { idempotencyKey: key },
          }),
          {
            caller: transferCaller('core.chat.write'),
            metadata: { idempotencyKey: key },
          },
        ),
      );
    },
  );

  registerIpcHandler<
    [ChatSessionImportDiscardRequest],
    ChatSessionImportDiscardResponse
  >(IPC_CHANNELS.chatSessionImportDiscard, async (_event, request) => {
    validateId(request.exportId, 'exportId');
    const key = transferKey();
    await preserveRuntimeCauseError(
      getActiveDesktopRuntime().instruction(
        'core.chat.transfer.import.discard',
        CoreChatTransferImportDiscardParamsSchema.parse({
          transferId: request.exportId,
          _meta: { idempotencyKey: key },
        }),
        {
          caller: transferCaller('core.chat.write'),
          metadata: { idempotencyKey: key },
        },
      ),
    );
    return { discarded: true };
  });
}
