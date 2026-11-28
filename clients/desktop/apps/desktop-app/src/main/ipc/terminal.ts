import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  ClaudeTerminalLaunchError,
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ClaudeTerminalLaunchRejectedResponse,
  type LoadWorktreeTerminalStateRequest,
  type LoadWorktreeTerminalStateResponse,
  type SaveWorktreeTerminalStateRequest,
  type TerminalAttachRequest,
  type TerminalAttachResponse,
  type TerminalKillRequest,
  type TerminalOutputEvent,
  type TerminalOutputProgressEvent,
  type TerminalRestoreRequest,
  type TerminalResizeRequest,
  type TerminalSession,
  type TerminalShellProfile,
  type TerminalSpawnRequest,
  type TerminalWindowConnectRequest,
  type TerminalWindowConnectResponse,
  type TerminalWindowReconnectRequest,
  type TerminalWindowRouteRequest,
  type TerminalWindowRouteResponse,
  type TerminalWriteRequest,
  type TerminalWriteDisposition,
  type ClaudeTerminalCleanupRequest,
  type ClaudeTerminalGetStateRequest,
  type ClaudeTerminalInterruptRequest,
  type ClaudeTerminalLaunchRequest,
  type ClaudeTerminalLaunchResponse,
  type ClaudeTerminalRuntimeState,
  type ClaudeTerminalSyncTranscriptRequest,
  type ClaudeTerminalSyncTranscriptResponse,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import type { WindowAccessors } from './index';
import { sendToWindow } from '../lib/window-send';
import {
  addRendererDeliveryBarrier,
  sendToWebContents,
  setRendererDeliveryFilter,
  type IpcSendTarget,
} from '../lib/web-contents-send';
import { IdentifierValidationError, validateId } from '../lib/validation';
import {
  closeTerminal,
  listTerminalProfiles,
  rememberTerminalInitialPrompt,
  restoreTerminalForRenderer,
  resizeTerminal,
  spawnTerminalForRenderer,
  writeTerminal,
} from '../services/terminal-service';
import type { WorkerTerminalEvent } from '@canopy/core-runtime/node/terminal';
import {
  TERMINAL_EVENT_CHANNELS,
  workerTerminal,
} from '../terminal/worker-terminal';
import { TerminalOutputDelivery } from '../terminal/output-delivery';
import type { DaemonTerminalRouteContext } from '../terminal/daemon-terminal-route';
import type {
  TerminalWindowAdmission,
  TerminalWindowSurface,
} from '../terminal/window-admission';
import { isCurrentDesktopMainFrame } from '../canopy-runtime/desktop-ipc-caller';
import { rendererContentsOf } from '../lib/renderer-surface';
import { assertNotSplitLocked } from '../services/split-lock-service';
import { terminalPersistenceStore } from '../terminal/persistence';
import { registerIpcHandler } from './register';
import {
  isTerminalReplyOnly,
  noteChatDriver,
} from '../remote-control/host/chat-drivers';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import { getClaudeTerminalSessionService } from '../integration/claude-terminal-session-service';
import { assertUntrustedChatInput } from '../agent-messaging/untrusted-input';
import { isLiveClaudeTerminal } from '../integration/claude-terminal-liveness';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { buildStandaloneChatLinkTarget } from '../lib/standalone-link-target';

/** A terminal that is not live, replayed from its record's history. */
async function replayFromRecord(
  terminalId: string,
): Promise<TerminalAttachResponse> {
  const release =
    await terminalPersistenceStore.prefetchPersistedEntry(terminalId);
  try {
    const indexed = terminalPersistenceStore.getTerminalMetadata(terminalId);
    if (indexed)
      assertNotSplitLocked(
        indexed.session.projectId,
        indexed.session.worktreeId,
        'attaching to a terminal',
      );
    return workerTerminal.replay(terminalId);
  } finally {
    release();
  }
}

function validateTerminalDimension(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: must be a positive integer`);
  }
}

function sendToMainAndAppAdvisor(
  accessors: Pick<WindowAccessors, 'getMainWindow' | 'getAppAdvisorWindow'>,
  channel: string,
  payload: unknown,
): void {
  sendToWindow(accessors.getMainWindow(), channel, payload);
  sendToWindow(accessors.getAppAdvisorWindow(), channel, payload);
}

function readEventTarget(
  payload: unknown,
): { projectId: string; worktreeId: string } | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  return typeof record.projectId === 'string' &&
    typeof record.worktreeId === 'string'
    ? { projectId: record.projectId, worktreeId: record.worktreeId }
    : null;
}

function normalizeTerminalWindowAccessors(
  accessors: WindowAccessors | (() => BrowserWindow | null),
): Pick<WindowAccessors, 'getMainWindow' | 'getAppAdvisorWindow'> &
  Partial<WindowAccessors> {
  if (typeof accessors === 'function') {
    return {
      getMainWindow: accessors,
      getAppAdvisorWindow: () => null,
    };
  }
  return accessors;
}

let removeTerminalOutputDelivery: (() => void) | undefined;
/** Set once a window is first admitted; until then main relays everything. */
let admittedWindows: Pick<TerminalWindowAdmission, 'reads'> | undefined;
/** Each admitted renderer, as the delivery filter's target names it. */
const windowSendTargets = new WeakMap<object, IpcSendTarget>();

const isOutputPayload = (value: unknown): value is TerminalOutputEvent =>
  typeof value === 'object' &&
  value !== null &&
  typeof Reflect.get(value, 'projectId') === 'string' &&
  typeof Reflect.get(value, 'worktreeId') === 'string' &&
  typeof Reflect.get(value, 'terminalId') === 'string' &&
  typeof Reflect.get(value, 'seq') === 'number' &&
  Reflect.get(value, 'data') instanceof Uint8Array;

/**
 * CAN-8070: a window that reads a terminal on its own connection gets no
 * bytes from main, only their `seq` for its attention and update watchers.
 * Observers still see the output, so Remote Control's copy is unchanged.
 */
function omitOutputReadDirectly(
  target: object,
  args: readonly unknown[],
): boolean {
  const event = args[0];
  if (!admittedWindows || !isOutputPayload(event)) return false;
  const sendTarget = windowSendTargets.get(target);
  if (!sendTarget || !admittedWindows.reads(target, event.terminalId))
    return false;
  // Progress means bytes arrived (the Linux update terminal reads it so).
  if (event.data.length === 0) return true;
  const progress: TerminalOutputProgressEvent = {
    projectId: event.projectId,
    worktreeId: event.worktreeId,
    terminalId: event.terminalId,
    seq: event.seq,
  };
  sendToWebContents(sendTarget, IPC_CHANNELS.terminalOutputProgress, progress);
  return true;
}

export function registerTerminalHandlers(
  windowAccessors: WindowAccessors | (() => BrowserWindow | null),
): void {
  const accessors = normalizeTerminalWindowAccessors(windowAccessors);
  const route = (
    channel: string,
    payload: WorkerTerminalEvent['payload'],
  ): void => {
    if (isBotProjectId(payload.projectId)) {
      sendToMainAndAppAdvisor(accessors, channel, payload);
      return;
    }
    sendToWindow(accessors.getMainWindow(), channel, payload);
  };
  // Renderer delivery only: PTY output is sent per frame, a lone echo at once.
  removeTerminalOutputDelivery?.();
  const output = new TerminalOutputDelivery({
    deliver: (event): void => {
      route(IPC_CHANNELS.terminalOutput, event);
    },
    now: (): number => performance.now(),
    setTimer: (callback, delayMs): (() => void) => {
      const timer = setTimeout(callback, delayMs);
      return (): void => {
        clearTimeout(timer);
      };
    },
  });
  // Any other message or invoke reply to a window first sends held output.
  const removeBarrier = addRendererDeliveryBarrier((_target, channel): void => {
    if (channel !== IPC_CHANNELS.terminalOutput) output.flushAll();
  });
  const removeFilter = setRendererDeliveryFilter(
    IPC_CHANNELS.terminalOutput,
    omitOutputReadDirectly,
  );
  removeTerminalOutputDelivery = (): void => {
    removeBarrier();
    removeFilter();
    output.dispose();
  };
  workerTerminal.setEventSink((event): void => {
    if (event.type === 'output') {
      output.push(event.payload);
      return;
    }
    output.flushAll();
    const channel = TERMINAL_EVENT_CHANNELS[event.type];
    route(channel, event.payload);
    if (event.type === 'exit') {
      output.forget(event.payload.terminalId);
    }
  });
  getClaudeTerminalSessionService().setEventSender((channel, payload): void => {
    const target = readEventTarget(payload);
    if (!target) {
      sendToWindow(accessors.getMainWindow(), channel, payload);
      return;
    }
    if (!isBotProjectId(target.projectId)) {
      sendToWindow(accessors.getMainWindow(), channel, payload);
      return;
    }
    sendToMainAndAppAdvisor(accessors, channel, payload);
  });
  // Terminal-mode turns bypass the Canopy-native send path, so the session
  // service requests description generation after a transcript sync imports
  // the chat's first user message.
  getClaudeTerminalSessionService().setChatSummaryScheduler((request): void => {
    if (
      isBotProjectId(request.projectId) ||
      request.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID
    ) {
      return;
    }
    let cwd: string;
    try {
      cwd = resolveWorktreeCwd(request.projectId, request.worktreeId);
    } catch {
      return;
    }
    const isLegacyStandaloneSentinel =
      request.projectId === STANDALONE_CHAT_PROJECT_ID;
    const isCoworkChat = isCoworkWorkspace(request.projectId);
    // Conceptual chat-project id for cowork history/meta persistence. The
    // legacy sentinel keying carried it in `worktreeId`; real cowork
    // workspace ids arrive directly in `projectId` (with `worktreeId` fixed
    // to the cowork home worktree slot).
    const standaloneChatProjectId = isLegacyStandaloneSentinel
      ? request.worktreeId
      : request.projectId;
    // Lazy import: `worktree-chat-turn` transitively loads the Claude SDK,
    // which must stay out of this module's static graph.
    void import('../lib/worktree-chat-turn')
      .then(({ scheduleChatSummary }) => {
        scheduleChatSummary({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: request.chatId,
          cwd,
          getWindow: () => accessors.getMainWindow(),
          workOwner: request.workOwner,
          ...(isCoworkChat
            ? {
                standaloneChatProjectId,
                linkTarget: buildStandaloneChatLinkTarget(
                  standaloneChatProjectId,
                  request.chatId,
                ),
              }
            : {}),
        });
      })
      .catch(() => undefined);
  });

  // CAN-5088: only this app's own windows may place a terminal in the
  // daemon; the remote-control bridge and Portal keep the in-process engine.
  const routeContext = (
    event: Pick<IpcMainInvokeEvent, 'sender'> | null | undefined,
  ): DaemonTerminalRouteContext => ({
    localWindow:
      event !== null &&
      event !== undefined &&
      resolveRemoteBridgeSender(event.sender) === null &&
      [accessors.getMainWindow(), accessors.getAppAdvisorWindow()].some(
        (window) =>
          window !== null &&
          window.webContents === event.sender &&
          !window.isDestroyed(),
      ),
  });

  // CAN-8068: the renderer of the main window or of the Orchestrator, keyed
  // on its web contents so the early access view qualifies wherever it is
  // hosted. Never the remote-control bridge, a child frame or a stale page.
  const terminalWindowSurface = (
    event:
      | Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>
      | null
      | undefined,
  ): TerminalWindowSurface | null => {
    if (!event || resolveRemoteBridgeSender(event.sender) !== null) return null;
    if (!isCurrentDesktopMainFrame(event.sender, event.senderFrame))
      return null;
    const main = accessors.getMainWindow();
    if (main && !main.isDestroyed() && main.webContents === event.sender)
      return 'main';
    const advisor = accessors.getAppAdvisorWindow();
    if (
      advisor &&
      !advisor.isDestroyed() &&
      rendererContentsOf(advisor.webContents) === event.sender
    )
      return 'orchestrator';
    return null;
  };

  registerIpcHandler<
    [TerminalWindowConnectRequest | TerminalWindowReconnectRequest | undefined],
    Promise<TerminalWindowConnectResponse | null>
  >(
    IPC_CHANNELS.terminalWindowConnect,
    async (event, request): Promise<TerminalWindowConnectResponse | null> => {
      const reconnect = Reflect.get(Object(request), 'reconnect') === true;
      const terminalId: unknown = Reflect.get(Object(request), 'terminalId');
      if (terminalId !== undefined) validateId(terminalId, 'terminalId');
      const surface = terminalWindowSurface(event);
      if (!event || surface === null) return null;
      const { terminalWindowAdmission } =
        await import('../terminal/daemon-terminal-route');
      const response = reconnect
        ? await terminalWindowAdmission.reconnect(event.sender, surface)
        : await terminalWindowAdmission.connect(
            event.sender,
            surface,
            typeof terminalId === 'string' ? terminalId : undefined,
          );
      if (response) {
        admittedWindows = terminalWindowAdmission;
        windowSendTargets.set(event.sender, event.sender);
      }
      return response;
    },
  );

  registerIpcHandler<
    [TerminalWindowRouteRequest],
    Promise<TerminalWindowRouteResponse | null>
  >(
    IPC_CHANNELS.terminalWindowRoute,
    async (event, request): Promise<TerminalWindowRouteResponse | null> => {
      validateId(request.terminalId, 'terminalId');
      const surface = terminalWindowSurface(event);
      if (!event || surface === null) return null;
      const { terminalWindowAdmission } =
        await import('../terminal/daemon-terminal-route');
      return terminalWindowAdmission.route(
        event.sender,
        surface,
        request.terminalId,
      );
    },
  );

  registerIpcHandler<[TerminalWindowRouteRequest], Promise<void>>(
    IPC_CHANNELS.terminalWindowRelease,
    async (event, request): Promise<void> => {
      validateId(request.terminalId, 'terminalId');
      const surface = terminalWindowSurface(event);
      if (!event || surface === null) return;
      // The same import as route, so a release and a route ask stay in order.
      const { terminalWindowAdmission } =
        await import('../terminal/daemon-terminal-route');
      terminalWindowAdmission.release(
        event.sender,
        surface,
        request.terminalId,
      );
    },
  );

  registerIpcHandler<[TerminalSpawnRequest], TerminalSession>(
    IPC_CHANNELS.terminalSpawn,
    async (event, request): Promise<TerminalSession> => {
      return spawnTerminalForRenderer(request, routeContext(event));
    },
  );

  registerIpcHandler<[], Promise<TerminalShellProfile[]>>(
    IPC_CHANNELS.terminalListProfiles,
    async () => {
      return listTerminalProfiles();
    },
  );

  registerIpcHandler<
    [TerminalAttachRequest],
    TerminalAttachResponse | Promise<TerminalAttachResponse>
  >(
    IPC_CHANNELS.terminalAttach,
    (
      _event,
      request,
    ): TerminalAttachResponse | Promise<TerminalAttachResponse> => {
      validateId(request.terminalId, 'terminalId');
      const session = workerTerminal
        .list()
        .find((entry) => entry.id === request.terminalId);
      if (session) {
        assertNotSplitLocked(
          session.projectId,
          session.worktreeId,
          'attaching to a terminal',
        );
        return workerTerminal.replay(request.terminalId);
      }
      // Not live: its history is read from the record (CAN-7051).
      return replayFromRecord(request.terminalId);
    },
  );

  registerIpcHandler<[TerminalRestoreRequest], TerminalSession>(
    IPC_CHANNELS.terminalRestore,
    async (event, request): Promise<TerminalSession> => {
      validateId(request.terminalId, 'terminalId');
      validateTerminalDimension(request.cols, 'cols');
      validateTerminalDimension(request.rows, 'rows');
      const session =
        workerTerminal
          .list()
          .find((entry) => entry.id === request.terminalId) ??
        terminalPersistenceStore.getTerminalMetadata(request.terminalId)
          ?.session;
      if (session) {
        assertNotSplitLocked(
          session.projectId,
          session.worktreeId,
          'restoring a terminal',
        );
      }
      return restoreTerminalForRenderer(request, session, routeContext(event));
    },
  );

  registerIpcHandler<
    [TerminalWriteRequest],
    TerminalWriteDisposition | Promise<TerminalWriteDisposition>
  >(
    IPC_CHANNELS.terminalWrite,
    (
      event,
      request,
    ): TerminalWriteDisposition | Promise<TerminalWriteDisposition> => {
      const terminalService = getClaudeTerminalSessionService();
      const refuse = (error: unknown): Promise<never> | never => {
        const settlement = terminalService.recordPlanImplementationWriteFailure(
          request.terminalId,
          request.idempotencyKey,
        );
        if (settlement)
          return settlement.then(() => {
            throw error;
          });
        throw error;
      };
      const write = ():
        | TerminalWriteDisposition
        | Promise<TerminalWriteDisposition> => {
        let disposition: TerminalWriteDisposition;
        try {
          disposition = writeTerminal(request);
        } catch (error: unknown) {
          return refuse(error);
        }
        // Typing into a chat's terminal drives that chat from this window; the
        // emulator answering a program's query does not.
        const chatId = workerTerminal.get(request.terminalId)?.chatId;
        if (chatId !== undefined && !isTerminalReplyOnly(request.data)) {
          noteChatDriver(
            chatId,
            event ? resolveRemoteBridgeSender(event.sender) : null,
          );
        }
        return disposition;
      };
      const authorization = terminalService.authorizeAgentInputTerminalWrite(
        request.terminalId,
        request.idempotencyKey,
      );
      return authorization ? authorization.then(write, refuse) : write();
    },
  );

  registerIpcHandler<[TerminalResizeRequest], void>(
    IPC_CHANNELS.terminalResize,
    (_event, request): void => {
      resizeTerminal(request);
    },
  );

  registerIpcHandler<[TerminalKillRequest], void>(
    IPC_CHANNELS.terminalKill,
    (_event, request): void => {
      closeTerminal(request);
    },
  );

  registerIpcHandler<
    [LoadWorktreeTerminalStateRequest],
    Promise<LoadWorktreeTerminalStateResponse>
  >(
    IPC_CHANNELS.terminalLoadWorktreeState,
    (_event, request): Promise<LoadWorktreeTerminalStateResponse> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return terminalPersistenceStore.loadWorktreeState(
        request.projectId,
        request.worktreeId,
        request.historyStatusOnly === true,
        request.historyConfirmationOnly === true,
        request.retainedViewToken,
      );
    },
  );

  registerIpcHandler<[SaveWorktreeTerminalStateRequest], void>(
    IPC_CHANNELS.terminalSaveWorktreeState,
    (_event, request): void => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      const forgetTerminalIds: unknown = request.forgetTerminalIds;
      if (forgetTerminalIds !== undefined) {
        if (!Array.isArray(forgetTerminalIds))
          throw new IdentifierValidationError(
            'Invalid forgetTerminalIds: must be an array',
          );
        for (const terminalId of forgetTerminalIds)
          validateId(terminalId, 'forgetTerminalIds');
      }
      terminalPersistenceStore.saveWorktreeState(request);
    },
  );

  registerIpcHandler<[], TerminalSession[]>(
    IPC_CHANNELS.terminalList,
    (): TerminalSession[] => {
      return workerTerminal.list();
    },
  );

  registerIpcHandler<
    [ClaudeTerminalLaunchRequest],
    Promise<ClaudeTerminalLaunchResponse | ClaudeTerminalLaunchRejectedResponse>
  >(IPC_CHANNELS.claudeTerminalLaunch, async (event, request) => {
    // A renderer snapshot may contain legitimate attribution from the
    // canonical transcript. The session service resolves the main-owned tab
    // first and checks this snapshot only if it must use it as a new seed.
    const requestFields = { ...request };
    delete requestFields.tabSnapshot;
    assertUntrustedChatInput(requestFields);
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateId(request.chatId, 'chatId');
    // A terminal chat's tools run where the user launched it from. Opening a
    // chat whose terminal is already live only shows it, so the computer
    // that last gave it input stays its driver.
    const launchedFrom = event ? resolveRemoteBridgeSender(event.sender) : null;
    const reusesLiveTerminal = isLiveClaudeTerminal(
      getClaudeTerminalSessionService().getState(
        request.projectId,
        request.worktreeId,
        request.chatId,
      ),
    );
    if (!reusesLiveTerminal) noteChatDriver(request.chatId, launchedFrom);
    if (
      request.initialPrompt !== undefined &&
      typeof request.initialPrompt !== 'string'
    ) {
      throw new Error('Invalid initialPrompt: must be a string');
    }
    if (request.initialPromptIdempotencyKey !== undefined) {
      validateId(
        request.initialPromptIdempotencyKey,
        'initialPromptIdempotencyKey',
      );
    }
    if (request.tabSnapshot !== undefined) {
      if (
        typeof request.tabSnapshot !== 'object' ||
        request.tabSnapshot === null ||
        request.tabSnapshot.id !== request.chatId ||
        !Array.isArray(request.tabSnapshot.messages)
      ) {
        throw new Error('Invalid tabSnapshot: must match chatId');
      }
    }
    if (
      request.assistantMode === 'app-advisor' &&
      !isBotProjectId(request.projectId)
    ) {
      throw new Error(
        'Claude Code App Advisor terminal mode requires App Advisor sentinel ids.',
      );
    }
    // App Advisor mode is keyed off the sentinel ids, not just an explicit
    // `assistantMode` flag: the auto-mode send path launches via
    // `ensureClaudeTerminal` without setting `assistantMode`, yet the route
    // still becomes app-advisor (the sentinel ids force it). The runtime must
    // be created on the same condition or `GetCurrentUiState` and the other
    // advisor tools fail with "App Advisor runtime unavailable".
    const isAppAdvisorLaunch =
      request.assistantMode === 'app-advisor' ||
      isBotProjectId(request.projectId);
    const appAdvisorRuntime =
      isAppAdvisorLaunch && typeof windowAccessors !== 'function'
        ? (await import('../app-advisor/runtime')).createAppAdvisorToolRuntime(
            windowAccessors,
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
            },
            { canFork: false },
          )
        : undefined;
    try {
      const response = await getClaudeTerminalSessionService().launch(request, {
        ...(appAdvisorRuntime ? { appAdvisorRuntime } : {}),
        getWindow: isAppAdvisorLaunch
          ? accessors.getAppAdvisorWindow
          : accessors.getMainWindow,
        fromRemoteBridge: launchedFrom !== null,
      });
      if (response.initialPromptSubmitted === true) {
        noteChatDriver(request.chatId, launchedFrom);
      }
      if (
        response.initialPromptSubmitted === true &&
        request.initialPromptIdempotencyKey
      ) {
        rememberTerminalInitialPrompt(
          response.terminalId,
          request.initialPromptIdempotencyKey,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof ClaudeTerminalLaunchError) {
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        };
      }
      throw error;
    }
  });

  registerIpcHandler<[ClaudeTerminalCleanupRequest], Promise<void>>(
    IPC_CHANNELS.claudeTerminalCleanup,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.chatId, 'chatId');
      await getClaudeTerminalSessionService().cleanup(request);
    },
  );

  registerIpcHandler<
    [ClaudeTerminalGetStateRequest],
    ClaudeTerminalRuntimeState | undefined
  >(IPC_CHANNELS.claudeTerminalGetState, (_event, request) => {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateId(request.chatId, 'chatId');
    return getClaudeTerminalSessionService().getState(
      request.projectId,
      request.worktreeId,
      request.chatId,
    );
  });

  registerIpcHandler<[ClaudeTerminalInterruptRequest], Promise<void>>(
    IPC_CHANNELS.claudeTerminalInterrupt,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.chatId, 'chatId');
      await getClaudeTerminalSessionService().interrupt(request);
    },
  );

  registerIpcHandler<
    [ClaudeTerminalSyncTranscriptRequest],
    Promise<ClaudeTerminalSyncTranscriptResponse>
  >(IPC_CHANNELS.claudeTerminalSyncTranscript, async (_event, request) => {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateId(request.chatId, 'chatId');
    return getClaudeTerminalSessionService().syncTranscriptForChat(request);
  });
}
