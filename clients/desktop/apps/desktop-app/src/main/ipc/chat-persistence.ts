import { classifyError } from '@canopy/protocol/app-errors/classification';
import { IdentifierValidationError } from '../lib/identifier-validation-error';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  hasDelegationLifecycle,
  closeDelegationScope,
} from '../agents/delegation/lifecycle';
import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  type ArchivedChatSummary,
  type ChatAdhocMigrateTabsRequest,
  type ChatAdhocMigrateTabsResponse,
  type ChatArchiveTabRequest,
  type ChatFlushScopeRequest,
  type ChatForkOpenWorktreeTabsRequest,
  type ChatForkOpenWorktreeTabsResponse,
  type ChatForkedTabBinding,
  type ChatLoadTabsRequest,
  type ChatLoadArchivesRequest,
  type ChatMarkAllArchivesReadRequest,
  type ChatMarkArchiveReadRequest,
  type ChatReadArchiveRequest,
  type ChatReadArchiveResponse,
  type ChatRestoreArchiveRequest,
  type ChatRestoreArchiveResponse,
  type ChatTabsFile,
  type ChatCommandRequest,
  type PersistedChatBlock,
  type PersistedChatMessage,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  groupIntoTurns,
  type TurnBlock,
  type TurnMessage,
} from '@canopy/desktop-shared/lib/turn-utils';
import {
  readChatArchivesFile,
  toArchivedChatSummary,
} from '../lib/chat-archives';
import { type ChatTabsWriteDelta } from '../lib/chat-tabs';
import { adhocMigrateWorktreeTabs } from '../lib/adhoc-migrate-tabs';
import {
  forkOpenWorktreeTabs,
  SourceApprovalChangedDuringBranchError,
} from '../lib/worktree-open-tabs-fork';
import { isPersistedChatTab } from '../lib/chat-tabs-reader';
import { normalizeWorkspaceChatsForInheritedPluginDefaults } from '../lib/inherited-plugin-defaults-normalization';
import { setBeforeProjectPluginDefaultsChangeHandler } from '../lib/workspace-persistence';
import { outsideW5CommitScope } from '../lib/w5-commit-scope';
import { outsideStorageAdmission } from '@canopy/execution-engine/node/lib/storage-admission';
import { settlePersistedInterruptedMessages } from '../lib/persisted-chat-settle';
import {
  projectAppAdvisorChatSummariesStrict,
  projectAppAdvisorChatSummaryRemovals,
  projectWorktreeChatSummariesStrict,
  projectWorktreeChatSummaryRemovals,
  projectWorktreeChatTodosStrict,
  projectWorktreeChatTodoRemovals,
} from '../services/chat-service';
import { logMainProcessError } from '../lib/main-process-logging';
import { projectWorktreeMcpServersForChat } from '../portal/adapters/mcp-adapter';
import { isCanopyPortalActive } from '../portal/portal-event-bus';
import { getPipelineRunChatLinks } from '../services/pipeline-run-chat-links';
import {
  buildSessionKey,
  destroySession,
  getActiveChatIds,
  markChatSessionIdle,
  markSessionTeardownCause,
} from '../agents/session-manager';
import { cancelChatTurn } from '../lib/chat-turn-cancel';
import { releaseArchivedChatSessionWhenIdle } from '../lib/archived-chat-session-release';
import { sendToWindow, sendToWindowDetailed } from '../lib/window-send';
import { registerIpcHandler } from './register';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../canopy-runtime/core-chat-command-adapter';
import type { DesktopCanopyRuntimeAccessors } from './index';
import {
  validateId,
  validateMessageAnchorId,
  validateWorktreeChatScope,
} from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  cancelArchivedChatDeferredToolsReload,
  recordChatArchived,
  recordChatRestored,
  removeArchivedChatDelegateWatchers,
} from '../lib/chat-archive-bookkeeping';
import { getChatStateService } from '../services/chat-state-service';
import { registerLedgerChatArchivedSource } from '../ledger/session-end-sweep-ports';
import {
  ACCOUNT_MCP_REF_LOADER_WAIT,
  normalizeAccountMcpSelections,
  normalizeAccountMcpTombstones,
} from '../mcp/account-catalog';
import { hasLegacyAccountMcpRefs } from '@canopy/desktop-shared/lib/effective-plugin-selections';

/**
 * Cowork sidebar badge freshness: work-entry rows derive their thinking
 * spinner and unread badge from the `work-entries:list` IPC, so every cowork
 * chat-tabs write nudges the renderer to re-list. Throttled per workspace
 * (leading + trailing) because streaming turns persist on a ~500ms debounce —
 * without the trailing edge the final post-turn state (spinner off, unread
 * on) could be missed.
 */
const COWORK_META_NUDGE_INTERVAL_MS = 1_000;
const coworkMetaNudges = new Map<
  string,
  { timer: NodeJS.Timeout | null; lastEmitMs: number }
>();

function scheduleCoworkMetaNudge(
  workspaceId: string,
  getWindow: () => BrowserWindow | null,
): void {
  let state = coworkMetaNudges.get(workspaceId);
  if (!state) {
    state = { timer: null, lastEmitMs: 0 };
    coworkMetaNudges.set(workspaceId, state);
  }
  if (state.timer) {
    return;
  }
  const nudgeState = state;
  const delay = Math.max(
    0,
    COWORK_META_NUDGE_INTERVAL_MS - (Date.now() - nudgeState.lastEmitMs),
  );
  nudgeState.timer = setTimeout(() => {
    nudgeState.timer = null;
    nudgeState.lastEmitMs = Date.now();
    sendToWindow(getWindow(), IPC_CHANNELS.standaloneChatMetaUpdated, {
      projectId: workspaceId,
    });
  }, delay);
}

/** Cowork sidebar re-list; other workspaces have no Work Entry rows to refresh. */
export function nudgeCoworkWorkEntrySidebar(
  getWindow: () => BrowserWindow | null,
  projectId: string,
): void {
  if (isCoworkWorkspace(projectId)) {
    scheduleCoworkMetaNudge(projectId, getWindow);
  }
}

/**
 * Portal chat-summary/todo/MCP projection throttle. Canonical materialization
 * fires on every committed provider batch (~25 ms during streaming); the full
 * Portal re-projection is leading+trailing throttled per scope so a connected
 * portal stays live without re-serializing summaries on every batch.
 */
const PORTAL_PROJECTION_INTERVAL_MS = 1_000;

interface ProjectionFailure {
  error: unknown;
}

/** Called once, with the failure when the projection run rejected. */
type PortalProjectionWaiter = (failure: ProjectionFailure | undefined) => void;

function rethrowProjectionFailure(
  failure: ProjectionFailure | undefined,
): void {
  if (failure) throw failure.error;
}

const portalProjectionThrottles = new Map<
  string,
  {
    timer: NodeJS.Timeout | null;
    lastRunMs: number;
    latest: ChatTabsFile;
    /** Materializations the next run covers; it projects the latest one. */
    waiters: PortalProjectionWaiter[];
  }
>();

/** Rejects, after logging, when either projection fails. */
function runPortalChatProjection(
  projectId: string,
  worktreeId: string,
  data: ChatTabsFile,
): Promise<void> {
  // Publish pipeline_run chat-turn link changes from this commit burst
  // (CAN-3619). Only scopes with an index (built on first Portal run
  // projection) do work; failures never reach the committed chat.
  const links = getPipelineRunChatLinks()
    .refresh({ projectId, worktreeId })
    .catch((error: unknown) => {
      logMainProcessError(
        'Pipeline run chat link projection failed on chat materialization',
        error,
      );
      throw error;
    });
  const summaries = (async (): Promise<void> => {
    if (isCoworkWorkspace(projectId)) {
      // Keep the large standalone-chat service graph off Electron startup;
      // routine chat persistence does not need it until cowork projection runs.
      const { emitStandaloneWorkEntrySummaryStrict } =
        await import('../services/standalone-chat-service');
      await emitStandaloneWorkEntrySummaryStrict(projectId, worktreeId, data);
      return;
    }
    if (projectId === APP_ADVISOR_PROJECT_ID) {
      await projectAppAdvisorChatSummariesStrict(worktreeId);
      return;
    }
    await projectWorktreeChatSummariesStrict({
      workspaceId: projectId,
      worktreeId,
    });
    await projectWorktreeChatTodosStrict({
      workspaceId: projectId,
      worktreeId,
    });
    const activeChat = data.tabs.find(
      (tab) => tab.id === data.activeTabId && (tab.kind ?? 'chat') === 'chat',
    );
    await projectWorktreeMcpServersForChat(
      {
        workspaceLocalId: projectId,
        worktreeLocalId: worktreeId,
      },
      activeChat,
    );
  })().catch((error: unknown) => {
    logMainProcessError(
      'Portal projection failed on chat materialization',
      error,
    );
    throw error;
  });
  return Promise.all([links, summaries]).then(() => undefined);
}

/**
 * Post-commit projection of a canonical chat materialization to the Portal
 * and cowork sidebar surfaces. Installed as part of the chat-tabs write
 * observer in `index.ts`; before the cutover these side effects ran inside
 * the renderer-driven `chat:save-tabs` choke point. Resolves once the Portal
 * removals and the throttled run covering `data` land, or at once with no
 * Portal session; rejects when either fails, so the observer can retry.
 */
export function projectChatTabsMaterialization(
  getWindow: () => BrowserWindow | null,
  projectId: string,
  worktreeId: string,
  data: ChatTabsFile,
  delta: ChatTabsWriteDelta | undefined,
): Promise<void> {
  // Cowork: work-entry list metadata (title/unread/streaming badges)
  // derives from the materialized tabs, so nudge the sidebar to re-list.
  nudgeCoworkWorkEntrySidebar(getWindow, projectId);
  // Mark changed chats for derived pipeline_run chat links even while no
  // portal is attached, so an index built earlier never serves stale links.
  let invalidationFailure: ProjectionFailure | undefined;
  try {
    getPipelineRunChatLinks().noteChatsMaterialized(
      { projectId, worktreeId },
      delta,
    );
  } catch (error) {
    logMainProcessError('Pipeline run chat link invalidation failed', error);
    invalidationFailure = { error };
  }
  const invalidation = Promise.resolve(invalidationFailure).then(
    rethrowProjectionFailure,
  );
  if (!isCanopyPortalActive()) {
    return invalidation;
  }
  // Closed tabs must reach the portal promptly and unconditionally — the
  // projection layer is upsert-only, so a bare re-projection would never
  // evict a closed tab. Removals are rare and never throttled.
  const removedChatIds = delta?.removedTabIds ?? [];
  let removals = Promise.resolve();
  if (removedChatIds.length > 0) {
    if (isCoworkWorkspace(projectId)) {
      // Keep the large standalone-chat service graph off Electron startup;
      // routine chat persistence does not need it until cowork removal runs.
      removals = import('../services/standalone-chat-service')
        .then(({ emitStandaloneChatRemovals }) => {
          emitStandaloneChatRemovals(projectId, removedChatIds);
        })
        .catch((error: unknown) => {
          logMainProcessError('Portal cowork removal failed', error);
          throw error;
        });
    } else if (projectId === APP_ADVISOR_PROJECT_ID) {
      projectAppAdvisorChatSummaryRemovals({
        removedChatIds: [...removedChatIds],
      });
    } else {
      projectWorktreeChatSummaryRemovals({
        workspaceId: projectId,
        worktreeId,
        removedChatIds: [...removedChatIds],
      });
      projectWorktreeChatTodoRemovals({
        workspaceId: projectId,
        worktreeId,
        removedChatIds: [...removedChatIds],
      });
    }
  }
  const key = `${projectId}/${worktreeId}`;
  let state = portalProjectionThrottles.get(key);
  if (!state) {
    state = { timer: null, lastRunMs: 0, latest: data, waiters: [] };
    portalProjectionThrottles.set(key, state);
  } else {
    state.latest = data;
  }
  const throttle = state;
  const projected = new Promise<ProjectionFailure | undefined>((waiter) => {
    throttle.waiters.push(waiter);
  }).then(rethrowProjectionFailure);
  const settled = Promise.all([invalidation, removals, projected]).then(
    () => undefined,
  );
  if (throttle.timer) {
    return settled;
  }
  const delay = Math.max(
    0,
    PORTAL_PROJECTION_INTERVAL_MS - (Date.now() - throttle.lastRunMs),
  );
  throttle.timer = setTimeout(() => {
    throttle.timer = null;
    throttle.lastRunMs = Date.now();
    const waiters = throttle.waiters.splice(0);
    // A synchronous throw rejects `run` too.
    const run = (async (): Promise<void> =>
      runPortalChatProjection(projectId, worktreeId, throttle.latest))();
    void run.then(
      () => waiters.forEach((waiter) => waiter(undefined)),
      (error: unknown) => waiters.forEach((waiter) => waiter({ error })),
    );
  }, delay);
  throttle.timer.unref?.();
  return settled;
}

/** Tabs reach pickers with account MCP refs in the shared server key shape. */
async function withAccountMcpTabRefs(
  tabsFile: ChatTabsFile,
): Promise<ChatTabsFile> {
  const legacy = (tab: PersistedChatTab): boolean =>
    hasLegacyAccountMcpRefs(tab.pluginSelections) ||
    hasLegacyAccountMcpRefs(tab.disabledGlobalPluginSelections);
  if (!tabsFile.tabs.some(legacy)) return tabsFile;
  return {
    ...tabsFile,
    tabs: await Promise.all(
      tabsFile.tabs.map(
        async (tab): Promise<PersistedChatTab> =>
          legacy(tab)
            ? {
                ...tab,
                pluginSelections: await normalizeAccountMcpSelections(
                  tab.pluginSelections,
                  undefined,
                  ACCOUNT_MCP_REF_LOADER_WAIT,
                ),
                disabledGlobalPluginSelections:
                  await normalizeAccountMcpTombstones(
                    tab.disabledGlobalPluginSelections,
                    ACCOUNT_MCP_REF_LOADER_WAIT,
                  ),
              }
            : tab,
      ),
    ),
  };
}

export function registerChatPersistenceHandlers(
  getWindow: () => BrowserWindow | null = () => null,
  runtime?: DesktopCanopyRuntimeAccessors,
): void {
  // The Feed's session-end sweep re-checks a chat recipient before each
  // hand-back, so work never lands on a chat archived while it ran.
  registerLedgerChatArchivedSource(async (target, chatId) => {
    const archives = await readChatArchivesFile(
      target.projectId,
      target.worktreeId,
      { chatIds: [chatId], pageOnly: true },
    );
    return archives.archived.some((entry) => entry.tab.id === chatId);
  });
  // A defaults change normalizes inside its commit scope and its manifest
  // admission; the chat writes precede that decision and are not part of it
  // (CAN-4409), so their observers' writes admit at their own sinks
  // (CAN-4418).
  setBeforeProjectPluginDefaultsChangeHandler(
    (workspaceId, previousDefaults, previousProjectTombstones) =>
      outsideStorageAdmission(() =>
        outsideW5CommitScope(() =>
          normalizeWorkspaceChatsForInheritedPluginDefaults(
            workspaceId,
            previousDefaults,
            previousProjectTombstones,
          ),
        ),
      ),
  );
  registerIpcHandler<[ChatLoadTabsRequest], ChatTabsFile>(
    IPC_CHANNELS.chatLoadTabs,
    async (_event, req) => {
      // Queue state is recovered race-free via the chatQueueGetSnapshot pull
      // during renderer hydration; a push here would race the renderer's
      // listener attach after a reload.
      return withAccountMcpTabRefs(
        (await getChatStateService().getState(req)).tabsFile,
      );
    },
  );

  registerIpcHandler<[ChatFlushScopeRequest], void>(
    IPC_CHANNELS.chatFlushScope,
    async (_event, req) => {
      validateWorktreeChatScope(req.projectId, req.worktreeId);
      await getChatStateService().flushScope(req.projectId, req.worktreeId);
    },
  );

  registerIpcHandler<
    [ChatForkOpenWorktreeTabsRequest],
    ChatForkOpenWorktreeTabsResponse
  >(IPC_CHANNELS.chatForkOpenWorktreeTabs, async (_event, req) => {
    validateId(req.projectId, 'projectId');
    assertWritableScope(req.projectId);
    validateId(req.sourceWorktreeId, 'sourceWorktreeId');
    validateId(req.destinationWorktreeId, 'destinationWorktreeId');
    if (req.selectedTab) {
      validateId(req.selectedTab.sourceTabId, 'sourceTabId');
      validateId(req.selectedTab.destinationTab.id, 'destinationTab.id');
      if (
        req.selectedTab.destinationTab.messages.length !== 0 ||
        !isPersistedChatTab(req.selectedTab.destinationTab)
      )
        throw new Error('Selected branch metadata must be a valid empty tab');
      if (req.selectedTab.throughMessageId)
        validateMessageAnchorId(
          req.selectedTab.throughMessageId,
          'throughMessageId',
        );
    }
    // The desktop renderer forks its own live panel layout (which can be
    // ahead of the persisted one), so the IPC path skips main's layout fork.
    let bindings: ReadonlyMap<string, ChatForkedTabBinding>;
    try {
      bindings = await forkOpenWorktreeTabs({
        projectId: req.projectId,
        sourceWorktreeId: req.sourceWorktreeId,
        destinationWorktreeId: req.destinationWorktreeId,
        ...(req.selectedTab ? { selectedTab: req.selectedTab } : {}),
        forkPanelLayout: false,
      });
    } catch (error) {
      if (error instanceof SourceApprovalChangedDuringBranchError) {
        return { tabBindings: {}, failureCode: 'source_approval_changed' };
      }
      throw error;
    }
    const tabBindings: Record<string, ChatForkedTabBinding> = {};
    for (const [sourceTabId, binding] of Array.from(bindings.entries())) {
      tabBindings[sourceTabId] = {
        destinationTabId: binding.destinationTabId,
        ...(binding.destinationFilePath
          ? { destinationFilePath: binding.destinationFilePath }
          : {}),
      };
    }
    const selectedTabApprovalMode = req.selectedTab
      ? (
          await getChatStateService().getState({
            projectId: req.projectId,
            worktreeId: req.destinationWorktreeId,
          })
        ).tabsFile.tabs.find(
          (tab) => tab.id === req.selectedTab?.destinationTab.id,
        )?.approvalMode
      : undefined;
    return {
      tabBindings,
      ...(selectedTabApprovalMode ? { selectedTabApprovalMode } : {}),
    };
  });

  registerIpcHandler<
    [ChatAdhocMigrateTabsRequest],
    ChatAdhocMigrateTabsResponse
  >(IPC_CHANNELS.chatAdhocMigrateTabs, async (_event, req) => {
    validateId(req.sourceWorkspaceId, 'sourceWorkspaceId');
    assertWritableScope(req.sourceWorkspaceId);
    validateId(req.sourceWorktreeId, 'sourceWorktreeId');
    validateId(req.destinationWorkspaceId, 'destinationWorkspaceId');
    assertWritableScope(req.destinationWorkspaceId);
    validateId(req.destinationWorktreeId, 'destinationWorktreeId');
    if (req.sourceRootRepoIdRewrite !== undefined) {
      validateId(req.sourceRootRepoIdRewrite, 'sourceRootRepoIdRewrite');
    }
    for (const [sourceRepoId, destinationRepoId] of Object.entries(
      req.selectedRepoIdRewrites,
    )) {
      validateId(sourceRepoId, 'selectedRepoIdRewrites source repo id');
      validateId(
        destinationRepoId,
        'selectedRepoIdRewrites destination repo id',
      );
    }
    return adhocMigrateWorktreeTabs(req);
  });

  registerIpcHandler<[ChatArchiveTabRequest], ArchivedChatSummary[]>(
    IPC_CHANNELS.chatArchiveTab,
    async (_event, req) => {
      validateWorktreeChatScope(req.projectId, req.worktreeId);
      assertWritableScope(req.projectId);
      validateId(req.tabId, 'chatId');

      // Keep the chat open while delegates, provider agents, or workflows
      // need it. Auto-archive retries after they settle; user close surfaces
      // the specific blocking reason before any teardown or persistence.
      const { assertChatCanClose } = await import('../agents/background-work');
      assertChatCanClose(req.projectId, req.worktreeId, req.tabId);
      // Auto-archive also waits for a send being dispatched, such as an async
      // answer sent as the chat completes: archiving would reset its turn
      // state and strand the admitted send. It retries at the next completion.
      if (
        req.keepSession === true &&
        getChatStateService().isDispatchInFlight({
          projectId: req.projectId,
          worktreeId: req.worktreeId,
          chatId: req.tabId,
        })
      ) {
        throw new Error('A message to this chat is still being sent.');
      }
      if (req.keepSession !== true && hasDelegationLifecycle()) {
        await closeDelegationScope({
          projectId: req.projectId,
          worktreeId: req.worktreeId,
          chatId: req.tabId,
        });
      }

      // Archive the canonical tab — the renderer names it by id and can no
      // longer supply (and therefore never stale-overwrite) its snapshot.
      const chatState = getChatStateService();
      const live = await chatState.getCompatibilityTabs(
        { projectId: req.projectId, worktreeId: req.worktreeId },
        { chatIds: [req.tabId] },
      );
      const canonicalTab = live.tabs.find(
        (tab) => tab.id === req.tabId && (tab.kind ?? 'chat') === 'chat',
      );
      if (!canonicalTab) {
        throw new Error('Chat tab not found');
      }

      const shouldInterrupt =
        req.keepSession !== true &&
        getActiveChatIds(req.projectId, req.worktreeId).includes(req.tabId);
      const tabToArchive =
        req.keepSession === true
          ? canonicalTab
          : finalizeInterruptedArchiveTab(canonicalTab);
      const archivedAt = new Date().toISOString();
      const turnMessages = toTurnMessages(tabToArchive.messages);
      const turnCount = groupIntoTurns(turnMessages).filter(
        (entry) => entry.kind === 'turn-group',
      ).length;
      const updated = await chatState.archiveCompatibilityTab(
        { projectId: req.projectId, worktreeId: req.worktreeId },
        {
          tab: tabToArchive,
          archivedAt,
          turnCount,
          ...(req.unread ? { unread: true } : {}),
        },
      );
      const archivedChat = {
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        chatId: req.tabId,
      };
      await recordChatArchived(archivedChat, archivedAt);

      // Auto-archive keeps the session alive (`keepSession`) so a resumed turn
      // can still stream events and un-archive the chat. It must still clear
      // the active-turn gate; otherwise hook chats that wait for active chats
      // can remain queued behind an archived tab. The session is released
      // once it cannot start a turn by itself.
      if (req.keepSession === true) {
        markChatSessionIdle(req.projectId, req.worktreeId, req.tabId);
        releaseArchivedChatSessionWhenIdle(
          {
            projectId: req.projectId,
            worktreeId: req.worktreeId,
            chatId: req.tabId,
          },
          chatState,
        );
      } else {
        const scope = {
          projectId: req.projectId,
          worktreeId: req.worktreeId,
          chatId: req.tabId,
        };
        try {
          markSessionTeardownCause(
            buildSessionKey(req.projectId, req.worktreeId, req.tabId),
            'archive',
          );
        } catch {
          // Session-cause bookkeeping must never block chat archival.
        }
        cancelArchivedChatDeferredToolsReload(archivedChat);
        if (shouldInterrupt) {
          await cancelChatTurn(scope);
          sendToWindowDetailed(getWindow(), IPC_CHANNELS.chatEvent, {
            projectId: req.projectId,
            worktreeId: req.worktreeId,
            chatId: req.tabId,
            data: {
              type: 'result',
              is_error: false,
              result: 'Cancelled',
            },
          });
        }

        try {
          await destroySession(req.projectId, req.worktreeId, req.tabId);
        } catch (error) {
          // The archive is durable and must not fail on a best-effort process
          // teardown — by the time a close-tab snapshot arrives the session is
          // usually already gone, and refusing to archive would risk losing the
          // transcript over a benign hiccup. But a genuine teardown failure can
          // leave a provider process running, so surface it in logs rather than
          // swallowing it silently (which would make a leak indistinguishable
          // from a clean archive).
          // eslint-disable-next-line no-console
          console.error(
            `[chatArchiveTab] Failed to tear down provider session for ${req.worktreeId}/${req.tabId}:`,
            error,
          );
        }

        await removeArchivedChatDelegateWatchers(archivedChat);
      }

      const now = Date.now();
      return updated.archived.map((entry) => toArchivedChatSummary(entry, now));
    },
  );

  registerIpcHandler<[ChatLoadArchivesRequest], ArchivedChatSummary[]>(
    IPC_CHANNELS.chatLoadArchives,
    async (_event, req) => {
      if (!req || typeof req !== 'object')
        throw classifyError(
          new Error('Expected an archive listing request.'),
          'input.not_accepted',
        );
      try {
        validateWorktreeChatScope(req.projectId, req.worktreeId);
      } catch (error) {
        if (error instanceof IdentifierValidationError)
          throw classifyError(error, 'input.not_accepted');
        throw error;
      }

      const file = await getChatStateService().getCompatibilityArchives({
        projectId: req.projectId,
        worktreeId: req.worktreeId,
      });
      const now = Date.now();
      return file.archived.map((entry) => toArchivedChatSummary(entry, now));
    },
  );

  registerIpcHandler<[ChatReadArchiveRequest], ChatReadArchiveResponse>(
    IPC_CHANNELS.chatReadArchive,
    async (_event, req) => {
      validateWorktreeChatScope(req.projectId, req.worktreeId);
      validateId(req.chatId, 'chatId');

      const entry = await getChatStateService().readCompatibilityArchive(
        { projectId: req.projectId, worktreeId: req.worktreeId },
        req.chatId,
        req.fullTranscript === true,
      );
      if (!entry) {
        throw new Error('Archived chat not found');
      }

      return { tab: entry.tab };
    },
  );

  registerIpcHandler<[ChatRestoreArchiveRequest], ChatRestoreArchiveResponse>(
    IPC_CHANNELS.chatRestoreArchive,
    async (event, req) => {
      validateWorktreeChatScope(req.projectId, req.worktreeId);
      validateId(req.chatId, 'chatId');

      const entry = await getChatStateService().readCompatibilityArchive(
        { projectId: req.projectId, worktreeId: req.worktreeId },
        req.chatId,
        false,
      );
      if (!entry) {
        throw new Error('Archived chat not found');
      }

      const port = getChatStateService();
      const request: ChatCommandRequest = {
        schemaVersion: 1,
        commandId: randomUUID(),
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        command: {
          type: 'chat.restore_archive',
          archiveEntryId: req.chatId,
        },
      };
      const result = runtime
        ? await dispatchTrustedChatCommand(
            request,
            createChatCommandDispatchOptions(
              port,
              runtime.dispatcher,
              runtime.resolveCaller(event),
            ),
          )
        : await port.command(request);
      if (
        result.outcome !== 'applied' &&
        result.outcome !== 'already_applied'
      ) {
        throw new Error(result.reason ?? 'Archived chat could not be restored');
      }

      recordChatRestored(
        { projectId: req.projectId, worktreeId: req.worktreeId },
        entry.tab,
      );

      return { tab: entry.tab };
    },
  );

  registerIpcHandler<[ChatMarkArchiveReadRequest], ArchivedChatSummary[]>(
    IPC_CHANNELS.chatMarkArchiveRead,
    async (event, req) => {
      validateWorktreeChatScope(req.projectId, req.worktreeId);
      validateId(req.chatId, 'chatId');

      const port = getChatStateService();
      const request: ChatCommandRequest = {
        schemaVersion: 1,
        commandId: randomUUID(),
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        command: {
          type: 'chat.mark_archive_read',
          archiveEntryId: req.chatId,
          unread: false,
        },
      };
      if (runtime) {
        await dispatchTrustedChatCommand(
          request,
          createChatCommandDispatchOptions(
            port,
            runtime.dispatcher,
            runtime.resolveCaller(event),
          ),
        );
      } else {
        await port.command(request);
      }
      const updated = await getChatStateService().getCompatibilityArchives({
        projectId: req.projectId,
        worktreeId: req.worktreeId,
      });
      const now = Date.now();
      return updated.archived.map((entry) => toArchivedChatSummary(entry, now));
    },
  );

  registerIpcHandler<[ChatMarkAllArchivesReadRequest], ArchivedChatSummary[]>(
    IPC_CHANNELS.chatMarkAllArchivesRead,
    async (event, req) => {
      validateWorktreeChatScope(req.projectId, req.worktreeId);

      const port = getChatStateService();
      const request: ChatCommandRequest = {
        schemaVersion: 1,
        commandId: randomUUID(),
        projectId: req.projectId,
        worktreeId: req.worktreeId,
        command: { type: 'chat.mark_all_archives_read' },
      };
      if (runtime) {
        await dispatchTrustedChatCommand(
          request,
          createChatCommandDispatchOptions(
            port,
            runtime.dispatcher,
            runtime.resolveCaller(event),
          ),
        );
      } else {
        await port.command(request);
      }
      const updated = await getChatStateService().getCompatibilityArchives({
        projectId: req.projectId,
        worktreeId: req.worktreeId,
      });
      const now = Date.now();
      return updated.archived.map((entry) => toArchivedChatSummary(entry, now));
    },
  );
}

function toTurnMessages(messages: PersistedChatMessage[]): TurnMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    timestamp: message.timestamp,
    blocks: message.blocks.flatMap(toTurnBlocks),
  }));
}

function toTurnBlocks(block: PersistedChatBlock): TurnBlock[] {
  if (block.type === 'delegated_agent_call')
    return [{ ...block, subBlocks: [] }];
  if (block.type === 'tool_result' || block.type === 'codex_agent_call') {
    return [];
  }
  return [block];
}

function finalizeInterruptedArchiveTab(
  tab: PersistedChatTab,
): PersistedChatTab {
  const completedAt = Date.now();
  const closedMessages = settlePersistedInterruptedMessages(
    tab.messages,
    completedAt,
  );
  return closedMessages === tab.messages
    ? tab
    : { ...tab, messages: closedMessages };
}
