import {
  IPC_CHANNELS,
  type AppAdvisorWatcherChatFiringHoldRequest,
  type AppAdvisorWatcherCreateRequest,
  type AppAdvisorWatcherDeleteRequest,
  type AppAdvisorWatcherDestination,
  type AppAdvisorWatcherSummary,
  type AppAdvisorWatcherUpdateRequest,
  type SetupAppAdvisorWatchersResult,
} from '@canopy/desktop-shared/types';
import { sendToWindow } from '../lib/window-send';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { registerIpcHandler } from './register';
import type { WindowAccessors } from './index';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import { deliverWatcherMessageToChat } from '../services/watcher-chat-delivery';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateStringId(value: unknown, label: string): void {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${label}: must be a string`);
  }
  validateId(value, label);
}

function validateDestination(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new Error(`${label} is required.`);
  }
  validateStringId(value.projectId, `${label}.projectId`);
  validateStringId(value.worktreeId, `${label}.worktreeId`);
  validateStringId(value.chatId, `${label}.chatId`);
}

function validateWatcherTarget(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error('watcher.target is required.');
  }
  switch (value.kind) {
    case 'worktree_chat':
      validateStringId(value.projectId, 'watcher.target.projectId');
      validateStringId(value.worktreeId, 'watcher.target.worktreeId');
      validateStringId(value.chatId, 'watcher.target.chatId');
      break;
    case 'standalone_chat':
      validateStringId(value.projectId, 'watcher.target.projectId');
      validateStringId(value.chatId, 'watcher.target.chatId');
      break;
    case 'worktree_chat_scope':
      validateStringId(value.projectId, 'watcher.target.projectId');
      validateStringId(value.worktreeId, 'watcher.target.worktreeId');
      break;
    case 'standalone_chat_project':
      validateStringId(value.projectId, 'watcher.target.projectId');
      break;
    case 'worktree_pipeline':
      validateStringId(value.projectId, 'watcher.target.projectId');
      validateStringId(value.worktreeId, 'watcher.target.worktreeId');
      if (value.executionId !== undefined) {
        validateStringId(value.executionId, 'watcher.target.executionId');
      }
      break;
    case 'worktree_hook':
      validateStringId(value.projectId, 'watcher.target.projectId');
      validateStringId(value.worktreeId, 'watcher.target.worktreeId');
      if (value.repoId !== undefined) {
        if (typeof value.repoId !== 'string') {
          throw new Error('Invalid watcher.target.repoId: must be a string');
        }
        validateOptionalRepoId(value.repoId, 'watcher.target.repoId');
      }
      break;
    default:
      throw new Error('Invalid watcher.target.kind.');
  }
}

function validateHoldRequest(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error('Watcher hold request is required.');
  }
  if (value.scope !== 'worktree' && value.scope !== 'standalone') {
    throw new Error('Invalid scope.');
  }
  validateStringId(value.projectId, 'projectId');
  validateStringId(value.worktreeId, 'worktreeId');
  validateStringId(value.chatId, 'chatId');
}

export function registerAppAdvisorWatcherHandlers(
  accessors: WindowAccessors,
): void {
  const service = getAppAdvisorWatcherService();

  service.configure(
    {
      getMainWindow: accessors.getMainWindow,
      getAppAdvisorWindow: accessors.getAppAdvisorWindow,
      ensureAppAdvisorWindow: accessors.ensureAppAdvisorWindow,
      sendAppAdvisorWindowCommand: accessors.sendAppAdvisorWindowCommand,
      sendChatWindowCommand: accessors.sendChatWindowCommand,
      deliverWatcherMessage: deliverWatcherMessageToChat,
      onChange: (watchers: AppAdvisorWatcherSummary[]) => {
        sendToWindow(
          accessors.getMainWindow(),
          IPC_CHANNELS.appAdvisorWatchersChanged,
          watchers,
        );
        sendToWindow(
          accessors.getAppAdvisorWindow(),
          IPC_CHANNELS.appAdvisorWatchersChanged,
          watchers,
        );
      },
    },
    { deferStartupRecovery: true },
  );

  registerIpcHandler<
    [
      | {
          destinationChatId?: string;
          destination?: AppAdvisorWatcherDestination;
        }
      | undefined,
    ],
    AppAdvisorWatcherSummary[]
  >(IPC_CHANNELS.appAdvisorWatchersList, (_event, request) =>
    service.list(request?.destination ?? request?.destinationChatId),
  );

  registerIpcHandler<[], AppAdvisorWatcherSummary[]>(
    IPC_CHANNELS.appAdvisorWatchersCompletedList,
    () => service.listCompleted(),
  );

  registerIpcHandler<
    [AppAdvisorWatcherDeleteRequest | { watcherId: string }],
    { ok: true } | { ok: false; error: string }
  >(IPC_CHANNELS.appAdvisorWatcherDelete, async (_event, request) => {
    try {
      if (!request || typeof request !== 'object') {
        return { ok: false, error: 'Watcher delete request is required.' };
      }
      validateId(request.watcherId, 'watcherId');
      const deleted = await service.deleteWatcher(request.watcherId, {
        notifySubscriber:
          'notifySubscriber' in request && request.notifySubscriber === true,
      });
      return deleted
        ? { ok: true }
        : { ok: false, error: 'Watcher not found or currently firing.' };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  registerIpcHandler<
    [AppAdvisorWatcherCreateRequest],
    SetupAppAdvisorWatchersResult
  >(IPC_CHANNELS.appAdvisorWatcherCreate, async (_event, request) => {
    if (!request || typeof request !== 'object' || !request.watcher) {
      return { ok: false, error: 'Watcher create request is required.' };
    }
    const { destination, watcher } = request;
    try {
      validateDestination(destination, 'destination');
      validateWatcherTarget(watcher.target);
      if (
        watcher.followUpInstruction !== undefined &&
        typeof watcher.followUpInstruction !== 'string'
      ) {
        return {
          ok: false,
          error: 'Invalid watcher.followUpInstruction: must be a string',
        };
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // A delegate recipient is captured only from a delegate's own tool
    // runtime; watchers created from the UI always notify the chat.
    return service.setup(
      { watchers: [watcher] },
      {
        projectId: destination.projectId,
        worktreeId: destination.worktreeId,
        chatId: destination.chatId,
        ...(destination.chatTitle !== undefined
          ? { chatTitle: destination.chatTitle }
          : {}),
      },
    );
  });

  registerIpcHandler<
    [AppAdvisorWatcherUpdateRequest],
    { ok: true } | { ok: false; error: string }
  >(IPC_CHANNELS.appAdvisorWatcherUpdate, async (_event, request) => {
    try {
      if (!request || typeof request !== 'object') {
        return { ok: false, error: 'Watcher update request is required.' };
      }
      validateId(request.watcherId, 'watcherId');
      if (
        request.followUpInstruction !== undefined &&
        typeof request.followUpInstruction !== 'string'
      ) {
        return {
          ok: false,
          error: 'Invalid followUpInstruction: must be a string',
        };
      }
      return await service.updateWatcherFollowUp(
        request.watcherId,
        request.followUpInstruction,
      );
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  registerIpcHandler<[AppAdvisorWatcherChatFiringHoldRequest], { ok: true }>(
    IPC_CHANNELS.appAdvisorWatcherHoldFiring,
    (_event, request) => {
      validateHoldRequest(request);
      service.holdChatFiring(request);
      return { ok: true };
    },
  );

  registerIpcHandler<[AppAdvisorWatcherChatFiringHoldRequest], { ok: true }>(
    IPC_CHANNELS.appAdvisorWatcherReleaseFiring,
    async (_event, request) => {
      validateHoldRequest(request);
      await service.releaseChatFiring(request);
      return { ok: true };
    },
  );

  registerIpcHandler<
    [
      {
        watcherId: string;
        deliveryId: string;
        stage?: 'received' | 'completed';
        ok: boolean;
        error?: string;
      },
    ],
    { ok: true }
  >(IPC_CHANNELS.appAdvisorWatcherMessageDelivery, (_event, request) => {
    validateId(request.watcherId, 'watcherId');
    validateId(request.deliveryId, 'deliveryId');
    service.acknowledgeWatcherMessageDelivery(
      request.watcherId,
      request.deliveryId,
      {
        stage: request.stage,
        ok: request.ok === true,
        error: request.error,
      },
    );
    return { ok: true };
  });
}
