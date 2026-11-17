import type {
  DeferredToolReloadHost,
  DeferredToolReloadScope,
} from '@canopy/core-runtime/node/agent/deferred-tools';
import { mergeDeferredToolsReloadAdditions } from '@canopy/desktop-shared/lib/chat-plugin-selections-merge';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
  DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  buildDeferredToolsReloadContinuation,
  type AgentProviderType,
  type AssistantMode,
  type ChatInterfaceMode,
  type ChatTabPluginSelections,
  type ChatUpdatePluginsRequest,
  type ChatUpdatePluginsResponse,
  type DeferredResourceSummary,
  type DeferredToolsReloadAdditions,
  type DeferredToolsReloadScopeKey,
  type PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { armTurnLifecycleContinuation } from '../agents/provider-turn-lifecycle';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  buildDeferredToolsCatalog,
  classifyLoadItems,
  encodeDeferredCatalogRef,
  encodeMcpRef,
  encodePluginRef,
  encodeSkillRef,
} from './catalog';
import {
  getRegisteredResumeHandler,
  type DeferredToolsResumeHandler,
} from './reload-coordinator';

/** What the desktop attaches to each core reload. */
export interface DesktopDeferredToolReloadPayload {
  readonly providerType?: AgentProviderType;
  readonly assistantMode?: AssistantMode;
  readonly interfaceMode?: ChatInterfaceMode;
  readonly additions: DeferredToolsReloadAdditions;
  readonly enabledResources: readonly DeferredResourceSummary[];
}

export interface DesktopDeferredToolReloadHostDeps {
  revalidateCatalog(
    payload: DesktopDeferredToolReloadPayload,
  ): Promise<string | null>;
  readCanonicalTab(scope: DeferredToolsReloadScopeKey): Promise<{
    pluginSelections?: ChatTabPluginSelections;
    sdkSessionId?: string;
  } | null>;
  readLiveTurnUserMessageId(
    scope: DeferredToolsReloadScopeKey,
  ): Promise<string | null>;
  applyChatPluginSelectionsUpdate(
    req: ChatUpdatePluginsRequest,
  ): Promise<ChatUpdatePluginsResponse>;
  resumeHandlerFor(
    scope: DeferredToolsReloadScopeKey,
  ): DeferredToolsResumeHandler | undefined;
  armContinuation(
    scope: DeferredToolsReloadScopeKey,
    cause: {
      userMessageId: string;
      spawnedBy: { toolUseId: string; toolsLoaded: true };
    } | null,
  ): void;
  ingestChatEvent(input: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    data: Record<string, unknown>;
    turnUserMessageId?: string;
    mutationId: string;
  }): Promise<void>;
  /** Durably append a system message to the chat once per mutation id. */
  appendSystemNotice(
    scope: DeferredToolsReloadScopeKey,
    message: PersistedChatMessage,
    mutationId: string,
  ): Promise<void>;
  onTurnCancelled(
    scope: DeferredToolsReloadScopeKey,
    userMessageId: string,
  ): void;
  now(): number;
}

async function revalidateCatalog(
  payload: DesktopDeferredToolReloadPayload,
): Promise<string | null> {
  const provider =
    payload.providerType === 'copilot'
      ? 'copilot'
      : payload.providerType === 'codex'
        ? 'codex'
        : payload.providerType === 'ollama'
          ? 'ollama'
          : payload.providerType === 'opencode'
            ? 'opencode'
            : payload.providerType === 'antigravity'
              ? 'antigravity'
              : 'claude';
  const catalog = await buildDeferredToolsCatalog({
    provider,
    pluginSelections: undefined,
  });
  // Admission already required each ref to have been issued to the chat;
  // revalidation only rechecks that the catalog still offers it.
  const classified = classifyLoadItems(
    catalog,
    [
      ...payload.additions.skillRefs.map((ref) =>
        encodeDeferredCatalogRef(encodeSkillRef(ref.sourceId, ref.skillName)),
      ),
      ...payload.additions.pluginRefs.map((ref) =>
        encodeDeferredCatalogRef(
          encodePluginRef(ref.marketplaceId, ref.pluginName),
        ),
      ),
      ...payload.additions.mcpServerRefs.map((ref) =>
        encodeDeferredCatalogRef(encodeMcpRef(ref.serverId, ref.configId)),
      ),
    ],
    () => true,
  );
  if (classified.rejected.length > 0) {
    const rejected = classified.rejected[0];
    return `${rejected.ref}: ${rejected.message}`;
  }
  return null;
}

const DEFAULT_DEPS: DesktopDeferredToolReloadHostDeps = {
  revalidateCatalog,
  readCanonicalTab: async ({ projectId, worktreeId, chatId }) => {
    const { getChatStateService } =
      await import('../services/chat-state-service');
    const { tabs } = await getChatStateService().getCompatibilityTabs({
      projectId,
      worktreeId,
    });
    return tabs.find((tab) => tab.id === chatId) ?? null;
  },
  readLiveTurnUserMessageId: async (scope) => {
    const { getClaudeTerminalSessionService } =
      await import('../integration/claude-terminal-session-service');
    const terminalTurn =
      getClaudeTerminalSessionService().runningTurnUserMessageId(
        scope.projectId,
        scope.worktreeId,
        scope.chatId,
      );
    if (terminalTurn) return terminalTurn;
    const { getChatTurnOwnership } =
      await import('../services/chat-turn-ownership');
    const ownership = getChatTurnOwnership();
    if (!ownership.isBound()) return null;
    const snapshot = ownership.getSnapshot(scope);
    // Copilot and Codex end their own turn once they acknowledge, so the
    // interrupted turn may already be the last ended one.
    return (
      (
        snapshot.receipt?.state.current ??
        snapshot.committed?.state.current ??
        snapshot.receipt?.state.lastEnded ??
        snapshot.committed?.state.lastEnded
      )?.userMessageId ?? null
    );
  },
  applyChatPluginSelectionsUpdate: async (req) => {
    const { applyChatPluginSelectionsUpdate } = await import('../ipc/chat');
    return applyChatPluginSelectionsUpdate(req);
  },
  resumeHandlerFor: getRegisteredResumeHandler,
  armContinuation: armTurnLifecycleContinuation,
  ingestChatEvent: async (input) => {
    const { getChatStateService } =
      await import('../services/chat-state-service');
    await getChatStateService().ingestProviderEvent(input);
  },
  appendSystemNotice: async (
    { projectId, worktreeId, chatId },
    message,
    mutationId,
  ) => {
    const { getChatStateService } =
      await import('../services/chat-state-service');
    await getChatStateService().updateCompatibilityTab(
      { projectId, worktreeId },
      chatId,
      (tab) =>
        tab.messages.some((entry) => entry.id === message.id)
          ? null
          : { ...tab, messages: [...tab.messages, message] },
      mutationId,
    );
  },
  onTurnCancelled: (scope, userMessageId) => {
    void import('../services/chat-queue-service')
      .then(({ getChatQueueService }) =>
        getChatQueueService().onTurnTerminal(scope, 'cancelled', userMessageId),
      )
      .catch((error: unknown) =>
        logMainProcessWarn(
          '[deferred-tools] interrupted turn queue release failed',
          error,
        ),
      );
  },
  now: Date.now,
};

function toDesktopScope(
  scope: DeferredToolReloadScope,
): DeferredToolsReloadScopeKey {
  return {
    projectId: scope.workspaceId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
  };
}

/** Sentinel chats keep their selections in tabs the catalog resolver does not read. */
const UNMATERIALIZED_PROJECT_IDS: ReadonlySet<string> = new Set([
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
]);

const PROVIDERS_ENDING_THEIR_TURN: ReadonlySet<AgentProviderType | undefined> =
  new Set<AgentProviderType | undefined>(['copilot', 'codex']);

interface PendingReload {
  base: ChatTabPluginSelections | undefined;
  tabSdkSessionId: string | undefined;
  merged?: ChatTabPluginSelections;
}

/**
 * The desktop effects behind the core deferred-tool reload lifecycle
 * (CAN-4127): it reads canonical chat state, enables the additions through
 * the plugin picker's update effect, resumes the turn through its registered
 * handler, and settles a turn the reload interrupted but did not resume.
 */
export function createDesktopDeferredToolReloadHost(
  overrides: Partial<DesktopDeferredToolReloadHostDeps> = {},
): DeferredToolReloadHost<DesktopDeferredToolReloadPayload> {
  const deps: DesktopDeferredToolReloadHostDeps = {
    ...DEFAULT_DEPS,
    ...overrides,
  };
  const pending = new Map<string, PendingReload>();
  // The turn that made the Load call, read as soon as the provider
  // acknowledges: a later queued turn may start while the catalog is checked.
  const originatingTurns = new Map<string, Promise<string | null>>();
  const readOriginatingTurn = (
    requestId: string,
    scope: DeferredToolsReloadScopeKey,
  ): Promise<string | null> => {
    const read = deps
      .readLiveTurnUserMessageId(scope)
      .catch((error: unknown) => {
        logMainProcessWarn('[deferred-tools] originating turn read failed', {
          requestId,
          error,
        });
        return null;
      });
    originatingTurns.set(requestId, read);
    return read;
  };
  const takeOriginatingTurn = (
    requestId: string,
    scope: DeferredToolsReloadScopeKey,
  ): Promise<string | null> => {
    const read =
      originatingTurns.get(requestId) ?? readOriginatingTurn(requestId, scope);
    originatingTurns.delete(requestId);
    return read;
  };
  return {
    materializationScope: (reload) =>
      isBotProjectId(reload.scope.workspaceId) ||
      UNMATERIALIZED_PROJECT_IDS.has(reload.scope.workspaceId)
        ? null
        : reload.scope,
    revalidate: (reload) => {
      void readOriginatingTurn(reload.requestId, toDesktopScope(reload.scope));
      return deps.revalidateCatalog(reload.payload);
    },
    capture: async (reload) => {
      const scope = toDesktopScope(reload.scope);
      const tab = await deps.readCanonicalTab(scope);
      if (!tab) throw new Error('Chat tab was not found while updating tools');
      pending.set(reload.requestId, {
        base: tab.pluginSelections,
        tabSdkSessionId: tab.sdkSessionId,
      });
      return {
        userMessageId: await takeOriginatingTurn(reload.requestId, scope),
        sdkSessionId: tab.sdkSessionId ?? null,
      };
    },
    enable: async (reload, _capture, signal) => {
      signal.throwIfAborted();
      const scope = toDesktopScope(reload.scope);
      const entry = pending.get(reload.requestId);
      const merged = mergeDeferredToolsReloadAdditions(
        entry?.base,
        reload.payload.additions,
        scope,
      );
      const isCodex = reload.payload.providerType === 'codex';
      const response = await deps.applyChatPluginSelectionsUpdate({
        ...scope,
        pluginSelections: merged,
        materializeCodexThread: isCodex,
        ...(isCodex && entry?.tabSdkSessionId
          ? { expectedCurrentThreadId: entry.tabSdkSessionId }
          : {}),
      });
      if (entry) entry.merged = merged;
      return { sdkSessionId: response.sdkSessionId ?? null };
    },
    resume: async (reload, input, signal) => {
      const scope = toDesktopScope(reload.scope);
      try {
        const handler = deps.resumeHandlerFor(scope);
        if (!handler) throw new Error('No reload resume handler registered.');
        deps.armContinuation(scope, {
          userMessageId: input.userMessageId,
          spawnedBy: { toolUseId: reload.toolCallId, toolsLoaded: true },
        });
        try {
          await handler({
            scope,
            requestId: reload.requestId,
            toolCallId: reload.toolCallId,
            userMessageId: input.userMessageId,
            continuationText: buildDeferredToolsReloadContinuation(),
            enabledResources: [...reload.payload.enabledResources],
            sdkSessionId: input.sdkSessionId ?? undefined,
            providerType: reload.payload.providerType,
            interfaceMode: reload.payload.interfaceMode,
            pluginSelections: pending.get(reload.requestId)?.merged,
            signal,
          });
        } catch (error) {
          deps.armContinuation(scope, null);
          throw error;
        }
      } finally {
        pending.delete(reload.requestId);
      }
    },
    settleInterruptedTurn: async (reload, settlement) => {
      pending.delete(reload.requestId);
      const { outcome, interrupted } = settlement;
      // These providers end their own turn once they acknowledge the result,
      // so a reload that fails before interrupting still ended the turn.
      if (
        !interrupted &&
        !PROVIDERS_ENDING_THEIR_TURN.has(reload.payload.providerType)
      ) {
        originatingTurns.delete(reload.requestId);
        return;
      }
      const scope = toDesktopScope(reload.scope);
      const { requestId } = reload;
      const userMessageId =
        settlement.userMessageId ??
        (await takeOriginatingTurn(requestId, scope));
      originatingTurns.delete(requestId);
      const step = async (
        name: 'notice' | 'queue' | 'terminal',
        run: () => Promise<void> | void,
      ): Promise<void> => {
        try {
          await run();
        } catch (error) {
          logMainProcessWarn(
            '[deferred-tools] interrupted turn settlement failed',
            { requestId, step: name, error },
          );
        }
      };
      const text =
        outcome === 'enable_failed'
          ? DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE
          : outcome === 'resume_failed'
            ? DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE
            : null;
      if (text !== null)
        await step('notice', () =>
          deps.appendSystemNotice(
            scope,
            {
              id: `deferred-tools-reload:${requestId}:failure`,
              role: 'system',
              timestamp: deps.now(),
              blocks: [{ type: 'text', text }],
            },
            `deferred-tools-reload:${requestId}:notice`,
          ),
        );
      if (!userMessageId) return;
      await step('queue', () => deps.onTurnCancelled(scope, userMessageId));
      await step('terminal', () =>
        deps.ingestChatEvent({
          ...scope,
          data: {
            type: 'result',
            is_error: false,
            result: 'Cancelled',
            canopy_turn_user_message_id: userMessageId,
          },
          turnUserMessageId: userMessageId,
          mutationId: `deferred-tools-reload:${requestId}:terminal`,
        }),
      );
    },
  };
}
