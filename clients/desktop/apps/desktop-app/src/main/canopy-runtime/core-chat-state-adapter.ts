import type {
  CanopyQueryHandlerMap,
  CanopyQueryResult,
  CanopyStreamCursor,
  CanopyWorkspaceScope,
  CoreChatNoBillingSource,
  CoreChatTabSettings,
  CoreChatTabUsage,
  CoreChatTodoItem,
  CoreChatUsageLimit,
} from '@canopy/protocol/canopy-core';
import type {
  ChatStateCommandPort,
  ChatStateSnapshot,
  ChatRuntimeStatus,
  ChatTabUsage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { projectChatRuntime } from '../services/chat-state-projection';
import {
  CanopyOperationError,
  canopyCapabilityUnavailableError,
  canopyInvalidArgumentError,
  canopyInternalError,
} from '@canopy/core-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { chatDisplayLabel } from '@canopy/protocol';
import type { ChatEventReplayLog } from './chat-event-replay-log';
import { unservedRevision } from './core-chat-read-adapter';

export interface ChatStateProjectionCapture {
  captureState(result: ChatStateSnapshot): void;
}

type ChatStateQueries = Pick<
  CanopyQueryHandlerMap,
  'core.chat.snapshot.get' | 'core.chat.list'
>;
type CoreChatSnapshotGetResult = CanopyQueryResult<'core.chat.snapshot.get'>;
type CoreChatListResult = CanopyQueryResult<'core.chat.list'>;

function requireLocalScope(scope: CanopyWorkspaceScope): void {
  if (
    scope.targetId !== undefined ||
    (scope.authorityId !== undefined &&
      scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
  ) {
    throw canopyCapabilityUnavailableError(
      'The selected chat authority or target is unavailable.',
    );
  }
}

/** The committed settings a client shows for a chat tab (CAN-4110 D9). */
export function projectChatTabSettings(
  tab: PersistedChatTab,
): CoreChatTabSettings {
  const speed = tab.modelConfig?.speed;
  const fastMode = tab.modelConfig?.fastMode ?? tab.codexFastModeEnabled;
  return {
    model: tab.model ?? null,
    providerId: tab.providerType ?? null,
    executionHarness: tab.executionHarness ?? null,
    modelSelectionMode: tab.modelSelectionMode === 'auto' ? 'auto' : 'manual',
    thinkingLevel: tab.modelConfig?.thinkingLevel ?? tab.thinkingLevel ?? null,
    speed:
      typeof speed === 'string'
        ? speed
        : fastMode === true
          ? 'fast'
          : fastMode === false
            ? 'standard'
            : null,
    planMode: tab.planMode === true,
    approvalMode: tab.approvalMode ?? null,
    interfaceMode: tab.interfaceMode ?? null,
    customTitle: tab.customTitle ?? null,
  };
}

const MAX_TODO_ID_LENGTH = 512;

/** A descriptor's TODO items in their portable form, or undefined when it has none. */
export function projectChatTodos(
  items:
    | readonly {
        id: string;
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
      }[]
    | undefined,
): CoreChatTodoItem[] | undefined {
  if (items === undefined) return undefined;
  // Model-authored ids are unbounded; one the schema rejects would fail the
  // whole snapshot, so that item is left out instead.
  return items
    .filter(({ id }) => id.length > 0 && id.length <= MAX_TODO_ID_LENGTH)
    .map(({ id, content, status }) => ({ id, content, status }));
}

function usageCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function isUsageProvider(provider: string): provider is 'claude' | 'codex' {
  return provider === 'claude' || provider === 'codex';
}

/** D13: committed usage as shown; malformed numbers read as 0. */
export function projectChatTabUsage(
  usage: ChatTabUsage | undefined,
): CoreChatTabUsage | undefined {
  if (usage === undefined) return undefined;
  return {
    contextTokens: usageCount(usage.contextTokens),
    contextWindow: usageCount(usage.contextWindow),
    maxOutputTokens: usageCount(usage.maxOutputTokens),
    inputTokens: usageCount(usage.inputTokens),
    outputTokens: usageCount(usage.outputTokens),
    cacheReadInputTokens: usageCount(usage.cacheReadInputTokens),
    cacheCreationInputTokens: usageCount(usage.cacheCreationInputTokens),
    totalCostUsd:
      Number.isFinite(usage.totalCostUsd) && usage.totalCostUsd >= 0
        ? usage.totalCostUsd
        : 0,
    numTurns: usageCount(usage.numTurns),
    model: typeof usage.model === 'string' ? usage.model.slice(0, 256) : '',
  };
}

/** D13: the last usage-limit banner without its message or request id. */
export function projectChatUsageLimit(
  tab: PersistedChatTab,
): CoreChatUsageLimit | undefined {
  const banner = tab.llmProviderUsageLimitBanner;
  if (!banner || !isUsageProvider(banner.provider)) return undefined;
  return {
    provider: banner.provider,
    detectedAt: usageCount(banner.detectedAt),
    ...(banner.resetsAt === undefined
      ? {}
      : { resetsAt: usageCount(banner.resetsAt) }),
    dismissed:
      tab.dismissedLlmProviderUsageLimitBannerKey === banner.dismissKey,
  };
}

export function projectChatNoBillingSource(
  tab: PersistedChatTab,
): CoreChatNoBillingSource | undefined {
  const state = tab.aiCreditsNoBillingSource;
  if (!state || !isUsageProvider(state.provider)) return undefined;
  return { provider: state.provider, detectedAt: usageCount(state.detectedAt) };
}

function projectChatTabExtras(
  tab: PersistedChatTab,
): Pick<
  CoreChatSnapshotGetResult['tabs']['items'][number],
  | 'settings'
  | 'todos'
  | 'taskTodos'
  | 'usage'
  | 'usageLimit'
  | 'noBillingSource'
> {
  if ((tab.kind ?? 'chat') !== 'chat') return {};
  const todos = projectChatTodos(tab.transcript?.todos);
  const taskTodos = projectChatTodos(tab.transcript?.taskTodos);
  const usage = projectChatTabUsage(tab.usage);
  const usageLimit = projectChatUsageLimit(tab);
  const noBillingSource = projectChatNoBillingSource(tab);
  return {
    settings: projectChatTabSettings(tab),
    ...(todos === undefined ? {} : { todos }),
    ...(taskTodos === undefined ? {} : { taskTodos }),
    ...(usage === undefined ? {} : { usage }),
    ...(usageLimit === undefined ? {} : { usageLimit }),
    ...(noBillingSource === undefined ? {} : { noBillingSource }),
  };
}

function projectSnapshot(
  snapshot: ChatStateSnapshot,
  chatId?: string,
  eventsCursor?: CanopyStreamCursor,
): CoreChatSnapshotGetResult {
  const selectedTabs = chatId
    ? snapshot.tabsFile.tabs.filter((tab) => tab.id === chatId)
    : snapshot.tabsFile.tabs;
  const selectedArchives = chatId
    ? snapshot.archives.filter((archive) => archive.chatId === chatId)
    : snapshot.archives;
  const runtimeByChatId: CoreChatSnapshotGetResult['runtimeByChatId'] = {};
  for (const [id, runtime] of Object.entries(snapshot.runtimeByChatId)) {
    if (chatId && id !== chatId) continue;
    const projectedRuntime = projectChatRuntime(runtime);
    runtimeByChatId[id] = {
      status: projectedRuntime.status,
      queuedMessageIds: projectedRuntime.queuedMessageIds,
      ...(projectedRuntime.lastActivityAt === undefined
        ? {}
        : { lastActivityAt: projectedRuntime.lastActivityAt }),
    };
  }
  return {
    workspaceId: snapshot.projectId,
    worktreeId: snapshot.worktreeId,
    revision: snapshot.revision,
    ...(eventsCursor ? { eventsCursor } : {}),
    tabs: {
      activeTabId: snapshot.tabsFile.activeTabId,
      items: selectedTabs.map((tab) => ({
        ...(tab.trackedPlanImplementation === undefined
          ? {}
          : { trackedPlanImplementation: tab.trackedPlanImplementation }),
        chatId: tab.id,
        title: chatDisplayLabel({
          customTitle: tab.customTitle,
          fallback: tab.title,
        }),
        kind: tab.kind ?? 'chat',
        createdAt: tab.createdAt,
        ...(tab.unread === undefined ? {} : { unread: tab.unread }),
        ...(tab.providerType === undefined
          ? {}
          : { providerId: tab.providerType }),
        ...projectChatTabExtras(tab),
        ...(tab.transcript?.transcriptRevision === undefined
          ? {}
          : { transcriptRevision: tab.transcript.transcriptRevision }),
      })),
    },
    archives: selectedArchives.map((archive) => ({
      chatId: archive.chatId,
      title: chatDisplayLabel({
        customTitle: archive.customTitle,
        fallback: archive.title,
      }),
      archivedAt: archive.archivedAt,
      createdAt: archive.createdAt,
      turnCount: archive.turnCount,
      unread: archive.unread,
      restorable: archive.restorable,
    })),
    runtimeByChatId,
    queue: snapshot.queue
      .filter((item) => !chatId || item.chatId === chatId)
      .map((item) => ({
        chatId: item.chatId,
        entries: item.queue.map((entry) => ({
          id: entry.id,
          origin: entry.origin,
          enqueuedAtMs: entry.enqueuedAtMs,
          revision: entry.revision ?? 1,
        })),
      })),
  };
}

export function listState(
  status: ChatRuntimeStatus | undefined,
): CoreChatListResult['items'][number]['state'] {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'starting':
    case 'streaming':
    case 'completing':
      return 'running';
    case 'awaiting_input':
      return 'awaiting_user';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

export function createCoreChatStateAdapter(
  getPort: () => ChatStateCommandPort | null,
  capture?: ChatStateProjectionCapture,
  replay?: ChatEventReplayLog,
): ChatStateQueries {
  return {
    'core.chat.snapshot.get': async (
      params,
    ): Promise<CoreChatSnapshotGetResult> => {
      // A cloud chat's session (CAN-6509); desktop advertises no revision.
      if (params.revision !== undefined) throw unservedRevision();
      requireLocalScope(params.scope);
      const port = getPort();
      if (!port) throw new Error('Chat state service is unavailable.');
      const finishCursor = replay?.attach()
        ? replay.beginSnapshot({
            projectId: params.scope.workspaceId,
            worktreeId: params.scope.worktreeId,
          })
        : undefined;
      let snapshot: ChatStateSnapshot;
      try {
        snapshot = await port.getState({
          projectId: params.scope.workspaceId,
          worktreeId: params.scope.worktreeId,
        });
      } catch (error) {
        throw canopyInternalError('Chat state read failed.', error);
      }
      capture?.captureState(snapshot);
      return projectSnapshot(
        snapshot,
        params.chatId,
        finishCursor?.(snapshot.revision),
      );
    },
    'core.chat.list': async (params): Promise<CoreChatListResult> => {
      requireLocalScope(params.scope);
      const port = getPort();
      if (!port) throw new Error('Chat state service is unavailable.');
      const snapshot = await port.getState({
        projectId: params.scope.workspaceId,
        worktreeId: params.scope.worktreeId,
      });
      const cursorParts = params.cursor?.match(/^(0|[1-9]\d*):(0|[1-9]\d*)$/);
      const cursorRevision = cursorParts ? Number(cursorParts[1]) : 0;
      const offset = cursorParts ? Number(cursorParts[2]) : 0;
      if (
        (params.cursor !== undefined && cursorParts === null) ||
        !Number.isSafeInteger(cursorRevision) ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw canopyInvalidArgumentError('Invalid chat list cursor.');
      if (cursorParts && cursorRevision !== snapshot.revision)
        throw new CanopyOperationError({
          kind: 'conflict',
          message: 'Chat list changed; restart from the first page.',
          retry: { kind: 'never' },
        });
      const pageSize = params.pageSize ?? 100;
      const items: CoreChatListResult['items'] = [
        ...snapshot.tabsFile.tabs
          .filter((tab) => (tab.kind ?? 'chat') === 'chat')
          .map((tab) => ({
            chatId: tab.id,
            workspaceId: snapshot.projectId,
            worktreeId: snapshot.worktreeId,
            title: chatDisplayLabel({
              customTitle: tab.customTitle,
              fallback: tab.title,
            }),
            state: listState(snapshot.runtimeByChatId[tab.id]?.status),
            revision: snapshot.revision,
            createdAt: tab.createdAt,
            ...(tab.providerType === undefined
              ? {}
              : { providerId: tab.providerType }),
            ...(tab.model === undefined ? {} : { modelId: tab.model }),
          })),
        ...snapshot.archives.map((archive) => ({
          chatId: archive.chatId,
          workspaceId: snapshot.projectId,
          worktreeId: snapshot.worktreeId,
          title: chatDisplayLabel({
            customTitle: archive.customTitle,
            fallback: archive.title,
          }),
          state: 'archived' as const,
          revision: snapshot.revision,
          createdAt: archive.createdAt,
        })),
      ];
      const page = items.slice(offset, offset + pageSize);
      const nextOffset = offset + page.length;
      return {
        items: page,
        nextCursor:
          nextOffset < items.length
            ? `${snapshot.revision}:${nextOffset}`
            : null,
      };
    },
  };
}
