import { isReplayableAppAdvisorResponse } from '@canopy/desktop-shared/lib/app-advisor-replay';
import { isSidebarItemGroupId } from '@canopy/protocol/sidebar';
import type { BrowserWindow, WebContents } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  IPC_CHANNELS,
  type AgentArtifactNavigationRequest,
  type AgentArtifactNavigationResponse,
  type AppAdvisorAction,
  type AppAdvisorAskUserAnswer,
  type AppAdvisorAskUserQuestion,
  type AppAdvisorBrowserAction,
  type AppAdvisorClaudeMdLoadResponse,
  type AppAdvisorClaudeMdSaveRequest,
  type AppAdvisorRendererToolCancellation,
  type AppAdvisorRendererToolRequest,
  type AppAdvisorRendererToolResponse,
  type AppAdvisorSettingsLoadResponse,
  type AppAdvisorSettingsPatchRequest,
  type AppAdvisorSettingsPatchResponse,
  type AppAdvisorSettingsSaveRequest,
  type AppAdvisorSettingsSaveResponse,
  type AppAdvisorSettingsViewResponse,
  type AppAdvisorUiStateEnvelope,
  type AppAdvisorWindowOpenRequest,
  type AppAdvisorWindowBatchRemovalDialog,
  type AppAdvisorDockResult,
  type AppAdvisorWindowState,
  type AppAdvisorWindowUiState,
  type OpenTurnFileRequest,
  type ShowFilesRendererResult,
  getAppAdvisorRendererToolRequestOriginChatId,
  getRendererToolRequestScopeKey,
} from '@canopy/desktop-shared/types';
import {
  normalizeAgentArtifactNavigationError,
  normalizeAgentArtifactNavigationRequest,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import { OPENCODE_CONNECTION_TIMEOUT_MS } from '@canopy/desktop-shared/types/opencode-connection';
import { ASK_USER_TIMEOUT_MS } from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  BROWSER_TYPING_BUDGET_MAX_MS,
  browserTypingBudgetMs,
} from '@canopy/agent-actions/families/browser/typing-budget';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import { cancelBrowserAutomation } from '../browser/automation-cancellation';
import { focusWindow } from '../lib/main-window-focus';
import { openExternalGuarded } from '../lib/open-external';
import { sendToWindowDetailed } from '../lib/window-send';
import { sendToWebContents } from '../lib/web-contents-send';
import {
  validateAgentModelId,
  validateId,
  validateOptionalRepoId,
} from '../lib/validation';
import { validatePipelineRuntimeIdentifier } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  isAppAdvisorBrowserAction,
  targetsAppAdvisorSurface,
} from '@canopy/desktop-shared/remote-control/surfaces';
import { registerIpcHandler } from './register';
import { setLatestAppAdvisorWindowUiState } from '../app-advisor/window-ui-state';
import { isRecord } from '../lib/type-guards';
import type {
  InterfaceToolOutcome,
  InterfaceToolPayload,
} from '@canopy/core-runtime/node/client';
import {
  getSessionInterfaceToolRegistry,
  interfaceToolAudienceOf,
} from '../agents/interface-tool-binding';

export { getLatestAppAdvisorWindowUiState } from '../app-advisor/window-ui-state';

const TOOL_REQUEST_TIMEOUT_MS = 30_000;
const ASK_USER_REQUEST_TIMEOUT_MS = ASK_USER_TIMEOUT_MS;
const BROWSER_ACTION_TIMEOUT_DEFAULT_MS = 5_000;
const BROWSER_WAIT_FOR_TIMEOUT_DEFAULT_MS = 10_000;
const BROWSER_ACTION_TIMEOUT_MAX_MS = 60_000;
const BROWSER_WAIT_FOR_TIMEOUT_MAX_MS = 120_000;
const BROWSER_BRIDGE_TIMEOUT_PADDING_MS = 15_000;
const COMPLETED_RESPONSE_CACHE_LIMIT = 100;

type PendingRequest = {
  request: AppAdvisorRendererToolRequest;
  resolve: (response: AppAdvisorRendererToolResponse) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** The renderer window the request was sent to, once it was. */
  target: BrowserWindow | null;
  /**
   * The windows that answer it: this computer's, or a controlling computer's.
   * A controller reconnecting gets new windows, so this follows `routeKey`.
   */
  surfaces: AppAdvisorRendererToolSurfaces;
  /** The controlling computer that answers it, or null for this one. */
  routeKey: string | null;
};

/**
 * App Advisor window operations for a controlling computer's windows (remote
 * access). The same calls this computer's own App Advisor window answers.
 */
export interface RemoteAppAdvisorWindowHost extends AppAdvisorRendererToolSurfaces {
  /** The controlling computer; the same across its reconnects. */
  readonly routeKey: string;
  /** Brings forward the controller's window that shows this computer. */
  focusMainWindow: () => Promise<void>;
  closeAppAdvisorWindow: () => Promise<AppAdvisorWindowState>;
  toggleAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
  getAppAdvisorWindowState: () => AppAdvisorWindowState;
  markAppAdvisorWindowRendererReady: () => AppAdvisorWindowState;
  reportAppAdvisorWindowUiState: (state: AppAdvisorWindowUiState) => void;
}

let remoteWindowHostForSender:
  | ((sender: WebContents) => RemoteAppAdvisorWindowHost | null)
  | null = null;
let rendererToolRouter:
  | ((
      request: AppAdvisorRendererToolRequest,
    ) => RemoteAppAdvisorWindowHost | null)
  | null = null;

/**
 * Remote access: App Advisor window calls from a controlling computer's
 * window are answered by that controller's App Advisor window, not this
 * computer's.
 */
export function setRemoteAppAdvisorWindowHostResolver(
  resolver: ((sender: WebContents) => RemoteAppAdvisorWindowHost | null) | null,
): void {
  remoteWindowHostForSender = resolver;
}

/**
 * Remote access: picks the windows that answer a renderer tool request when
 * they are not this computer's own, for a chat driven from another computer.
 */
export function setRendererToolSurfaceRouter(
  router:
    | ((
        request: AppAdvisorRendererToolRequest,
      ) => RemoteAppAdvisorWindowHost | null)
    | null,
): void {
  rendererToolRouter = router;
}

export function routeRendererToolRequest(
  request: AppAdvisorRendererToolRequest,
): RemoteAppAdvisorWindowHost | null {
  return rendererToolRouter?.(request) ?? null;
}

function isRendererToolResponse(
  reply: InterfaceToolPayload,
): reply is InterfaceToolPayload & AppAdvisorRendererToolResponse {
  const { error } = reply;
  return (
    typeof reply.requestId === 'string' &&
    typeof reply.ok === 'boolean' &&
    (error === undefined ||
      (typeof error === 'object' && error !== null && !Array.isArray(error)))
  );
}

/** CAN-4131: today's response shapes for a lease-bound call's outcome. */
export function interfaceToolOutcomeToRendererResponse(
  outcome: InterfaceToolOutcome,
  request: AppAdvisorRendererToolRequest,
): AppAdvisorRendererToolResponse {
  const invalid: AppAdvisorRendererToolResponse = {
    requestId: request.requestId,
    ok: false,
    error: {
      code: 'execution_failed',
      message: 'The window returned an invalid result.',
      retryable: false,
    },
  };
  if (outcome.ok)
    return isRendererToolResponse(outcome.reply)
      ? { ...outcome.reply, requestId: request.requestId }
      : invalid;
  switch (outcome.error.kind) {
    case 'capability_unavailable':
    case 'unavailable':
    case 'resource_exhausted':
      return surfaceUnavailableResponse(request);
    case 'deadline_exceeded':
      return timeoutResponse(request.requestId);
    case 'cancelled':
      return cancelledResponse(request.requestId);
    default:
      return invalid;
  }
}

let interfaceToolReplyHandler:
  | ((
      senderWebContentsId: number,
      response: unknown,
    ) => 'claimed' | 'not_claimed')
  | null = null;
/** CAN-4131: replies to lease-delivered calls are claimed before the legacy settle. */
export function setInterfaceToolReplyHandler(
  handler: typeof interfaceToolReplyHandler,
): void {
  interfaceToolReplyHandler = handler;
}
/** CAN-4131: deliver one lease-bound call to its renderer. */
export function sendInterfaceToolRequest(
  webContents: WebContents,
  request: AppAdvisorRendererToolRequest,
): boolean {
  if (webContents.isDestroyed()) return false;
  // Through the send interceptors, so a remote-control bridge forwards the
  // call to its controller's window (CAN-5823).
  sendToWebContents(webContents, IPC_CHANNELS.appAdvisorToolRequest, request);
  return true;
}
/** CAN-4131: tell a renderer a lease-bound call ended without its reply. */
export function sendInterfaceToolCancellation(
  webContents: WebContents,
  cancellation: AppAdvisorRendererToolCancellation,
): boolean {
  if (webContents.isDestroyed()) return false;
  sendToWebContents(
    webContents,
    IPC_CHANNELS.appAdvisorToolRequestCancelled,
    cancellation,
  );
  return true;
}

/**
 * An action that timed out may still be running in its renderer, so a retry
 * with its request id waits for it instead of running it again. The fence
 * ends with the late result, when that renderer navigates, crashes, or
 * closes (so the action can no longer report), or after a bounded time.
 */
type TimedOutRequest = {
  waiters: Set<(response: AppAdvisorRendererToolResponse) => void>;
  release: () => void;
};

const TIMED_OUT_FENCE_MS = 10 * 60_000;

// Keyed by origin chat plus request ID: request IDs are only unique within a
// chat, so another chat's response must never settle or replay this one.
const pending = new Map<string, PendingRequest>();
const timedOut = new Map<string, TimedOutRequest>();
const completed = new Map<string, AppAdvisorRendererToolResponse>();

function requestKey(request: AppAdvisorRendererToolRequest): string {
  return getRendererToolRequestScopeKey(
    request.requestId,
    getAppAdvisorRendererToolRequestOriginChatId(request),
  );
}

function responseKey(response: AppAdvisorRendererToolResponse): string {
  return getRendererToolRequestScopeKey(
    response.requestId,
    response.originChatId,
  );
}
let latestUiState: AppAdvisorUiStateEnvelope | null = null;

/**
 * Backend operations consumed by the typed App Advisor IPC adapter. Keeping
 * these injected prevents the transport module from owning filesystem,
 * persistence, retention, or scaffold behavior.
 */
export interface AppAdvisorWorkspaceOperations {
  settingsLoad(): Promise<AppAdvisorSettingsLoadResponse>;
  settingsSave(
    settings: AppAdvisorSettingsSaveRequest,
  ): Promise<AppAdvisorSettingsSaveResponse>;
  loadClaudeMd(): Promise<AppAdvisorClaudeMdLoadResponse>;
  saveClaudeMd(contents: AppAdvisorClaudeMdSaveRequest): Promise<void>;
}

export interface AppAdvisorRendererToolSurfaces {
  getMainWindow: () => BrowserWindow | null;
  getAppAdvisorWindow: () => BrowserWindow | null;
  openAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
  ensureAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
}

export interface AppAdvisorWindowAccessors extends AppAdvisorRendererToolSurfaces {
  /** `options` is untrusted renderer input (`AppAdvisorWindowCloseOptions`). */
  closeAppAdvisorWindow: (options?: unknown) => Promise<AppAdvisorWindowState>;
  toggleAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
  getAppAdvisorWindowState: () => AppAdvisorWindowState;
  markAppAdvisorWindowRendererReady: (
    sender?: WebContents,
  ) => AppAdvisorWindowState;
  /** Resizes the floating panel; the size is untrusted renderer input. */
  setAppAdvisorFloatingSize: (size: unknown) => AppAdvisorWindowState;
  /**
   * Places the docked Orchestrator page; the request is untrusted renderer
   * input, accepted only from the main window's page.
   */
  setAppAdvisorDock: (
    sender: WebContents,
    request: unknown,
  ) => Promise<AppAdvisorDockResult>;
  /**
   * Optional test/host override for applying one allowlisted artifact
   * destination. Production uses the built-in main-window focus + typed-action
   * router when this is absent.
   */
  openAgentArtifact?: (
    request: AgentArtifactNavigationRequest,
  ) => Promise<AgentArtifactNavigationResponse>;
}

/** Every artifact destination that opens inside the main window. */
type InAppArtifactNavigationRequest = Exclude<
  AgentArtifactNavigationRequest,
  { kind: 'github_workflow_run' | 'external_url' }
>;

function artifactNavigationAction(
  request: InAppArtifactNavigationRequest,
): AppAdvisorAction {
  switch (request.kind) {
    case 'pipeline_editor':
      return {
        type: 'pipeline.open_editor',
        pipelineId: request.pipelineId,
        ...(request.projectId ? { projectId: request.projectId } : {}),
        ...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
        ...(request.repoId ? { repoId: request.repoId } : {}),
        ...(request.sharedRemoteId
          ? { sharedRemoteId: request.sharedRemoteId }
          : {}),
      };
    case 'pipeline_execution':
      // Carries the run's owner and job: the main window's opener checks the
      // owner against the run and opens the run's own panel there.
      return {
        type: 'pipeline.open_run',
        executionId: request.executionId,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        ...(request.jobId ? { jobId: request.jobId } : {}),
      };
    case 'installed_skill':
      return {
        type: 'skills.open_viewer',
        sourceId: request.sourceId,
        skillName: request.skillName,
        ...(request.filePath ? { filePath: request.filePath } : {}),
      };
    case 'shared_skill':
      return { type: 'skills.open_shared_viewer', skillId: request.skillId };
    case 'automation_editor':
      return {
        type: 'automation.open_editor',
        id: request.activityId,
        ...(request.section ? { section: request.section } : {}),
        ...(request.runId ? { runId: request.runId } : {}),
      };
    case 'agent_editor':
    case 'shared_agent':
      return {
        type: 'agents.open_editor',
        agentId: request.agentId,
        source: request.kind === 'agent_editor' ? 'local' : 'shared',
      };
    case 'capability_entry':
      return { type: 'capabilities.open_entry', entry: request.entry };
  }
}

function validateArtifactNavigationIds(
  request: AgentArtifactNavigationRequest,
): void {
  switch (request.kind) {
    case 'pipeline_editor':
      if (request.source !== 'project' && request.source !== 'shared') {
        validateId(request.pipelineId, 'pipeline id');
      }
      if (request.projectId) validateId(request.projectId, 'project id');
      if (request.worktreeId) validateId(request.worktreeId, 'worktree id');
      validateOptionalRepoId(request.repoId, 'repository id');
      if (request.sharedRemoteId) {
        validateId(request.sharedRemoteId, 'shared pipeline id');
      }
      return;
    case 'pipeline_execution':
      validateId(request.executionId, 'execution id');
      validateId(request.projectId, 'project id');
      validateId(request.worktreeId, 'worktree id');
      if (request.jobId !== undefined) {
        validatePipelineRuntimeIdentifier(request.jobId, 'job id');
      }
      return;
    case 'agent_editor':
      validateAgentModelId(request.agentId, 'agent id');
      return;
    case 'shared_agent':
      validateId(request.agentId, 'shared agent id');
      return;
    case 'capability_entry':
    case 'external_url':
      return;
    case 'shared_skill':
      validateId(request.skillId, 'shared skill id');
      return;
    case 'automation_editor':
      validateId(request.activityId, 'activity id');
      return;
    case 'installed_skill':
      // Installed skill locators intentionally use source-qualified names such
      // as `custom:app`; their shared normalizer owns that format contract.
      return;
    case 'github_workflow_run':
      // The shared normalizer already restricted the repository, run id, and
      // GitHub.com `https` URL; there is no local id to validate.
      return;
  }
}

function focusMainWindow(window: BrowserWindow | null): void {
  // Same restore/show/focus/moveTop behavior as before, now sharing the single
  // implementation in `lib/main-window-focus` instead of duplicating it.
  focusWindow(window, { moveTop: true });
}

async function openAgentArtifactInMainWindow(
  request: AgentArtifactNavigationRequest,
  accessors: AppAdvisorWindowAccessors,
  remote: RemoteAppAdvisorWindowHost | null = null,
): Promise<AgentArtifactNavigationResponse> {
  if (request.kind === 'external_url') {
    await openExternalGuarded(request.url);
    return { ok: true };
  }
  if (request.kind === 'github_workflow_run') {
    // The window showing this computer opens the page on its own computer.
    if (remote) {
      return {
        ok: false,
        error: {
          code: 'navigation_failed',
          message: 'Open the workflow run from this window again.',
          retryable: true,
        },
      };
    }
    // A workflow run has no in-app destination: open GitHub's own page in the
    // user's browser without touching main-window focus.
    await openExternalGuarded(request.htmlUrl);
    return { ok: true };
  }
  // Opens where it was clicked: a controlling computer's window opens it
  // there, whoever drives the chat.
  if (remote) void remote.focusMainWindow().catch(() => undefined);
  else focusMainWindow(accessors.getMainWindow());
  const response = await requestAppAdvisorRendererTool(
    {
      kind: 'dispatch_action',
      requestId: randomUUID(),
      action: artifactNavigationAction(request),
      originWorktreeId: APP_ADVISOR_WORKTREE_ID,
    },
    remote ?? accessors,
    { followChatDriver: false },
  );
  if (response.ok) return { ok: true };
  return {
    ok: false,
    error: normalizeAgentArtifactNavigationError(response.error),
  };
}

/**
 * Recently answered ask-user questions, retained for the portal summary
 * projection (CAN-2608). App Advisor questions have no file-backed
 * `PersistedPendingQuestion` record (unlike worktree chats), so once the
 * pending entry settles this map is the only evidence the portal can use to
 * render the answered card (read-only answer bubbles) instead of a perpetual
 * pending spinner. Insertion-ordered and capped like the completed-response
 * cache; dismissals are not retained (the folded tool_result resolves the
 * card on its own).
 */
// Keyed by chat plus request ID, like the pending and completed maps.
const answeredQuestions = new Map<
  string,
  {
    requestId: string;
    chatId: string;
    question: AppAdvisorAskUserQuestion;
    answer: AppAdvisorAskUserAnswer;
  }
>();
const ANSWERED_QUESTION_CACHE_LIMIT = 50;

// Ready paired views observe the existing registry independently of which
// computer started a turn. Their bridge sender owns the subscription lifetime.
const questionViews = new Map<number, RemoteAppAdvisorWindowHost>();

function publishQuestionToControllers(
  request: AppAdvisorRendererToolRequest,
  settled: boolean,
  originalRouteKey: string | null,
): void {
  if (request.kind !== 'ask_user_question' || !request.chatId) return;
  const windows = new Set<BrowserWindow>();
  for (const view of questionViews.values()) {
    if (view.routeKey === originalRouteKey) continue;
    const window = view.getAppAdvisorWindow();
    if (window && !windows.has(window)) {
      windows.add(window);
      if (settled) {
        sendToWindowDetailed(
          window,
          IPC_CHANNELS.appAdvisorToolRequestCancelled,
          {
            requestId: request.requestId,
            originChatId: request.chatId,
          },
        );
      } else {
        sendToWindowDetailed(
          window,
          IPC_CHANNELS.appAdvisorToolRequest,
          request,
        );
      }
    }
  }
}

function rememberAnsweredQuestion(
  request: AppAdvisorRendererToolRequest,
  response: AppAdvisorRendererToolResponse,
): void {
  if (
    request.kind !== 'ask_user_question' ||
    !request.chatId ||
    !response.ok ||
    !response.answer
  ) {
    return;
  }
  // Secret answers never enter this map in plaintext: the projection puts the
  // retained answer on the portal wire verbatim, and the UI only MASKS secret
  // freeform text at render time. Mirror the Codex display redaction
  // (`app-server-client.ts` formatAskUserAnswers).
  const answer =
    request.question.secret === true && response.answer.freeformText
      ? { ...response.answer, freeformText: '[hidden]' }
      : response.answer;
  // One retained entry per chat+question text, latest wins. The transcript's
  // tool_use parts carry no requestId/toolUseId for App Advisor questions, so
  // the browser matches retained answers by question text alone — several
  // same-text entries would all resolve to the first. Known limitation: a
  // repeated identical question shows the LATEST answer on every occurrence
  // (still strictly better than the pre-CAN-2608 perpetual spinner).
  for (const [key, entry] of Array.from(answeredQuestions.entries())) {
    if (
      entry.chatId === request.chatId &&
      entry.question.question === request.question.question
    ) {
      answeredQuestions.delete(key);
    }
  }
  answeredQuestions.set(requestKey(request), {
    requestId: request.requestId,
    chatId: request.chatId,
    question: request.question,
    answer,
  });
  if (answeredQuestions.size > ANSWERED_QUESTION_CACHE_LIMIT) {
    const firstKey = answeredQuestions.keys().next().value;
    if (firstKey !== undefined) {
      answeredQuestions.delete(firstKey);
    }
  }
}

function rememberCompletedResponse(
  key: string,
  response: AppAdvisorRendererToolResponse,
): void {
  if (!isReplayableAppAdvisorResponse(response)) {
    completed.delete(key);
    return;
  }
  completed.set(key, response);
  if (completed.size > COMPLETED_RESPONSE_CACHE_LIMIT) {
    const firstKey = completed.keys().next().value;
    if (firstKey !== undefined) {
      completed.delete(firstKey);
    }
  }
}

/**
 * First settlement wins for responses that arrive with no pending record. A
 * request can be settled from two sides (the renderer round-trip and the
 * portal answer/dismiss commands, CAN-2565); a late loser must not replace
 * the cached settlement duplicate lookups will replay.
 */
function rememberCompletedResponseIfAbsent(
  key: string,
  response: AppAdvisorRendererToolResponse,
): void {
  if (completed.has(key)) {
    return;
  }
  rememberCompletedResponse(key, response);
}

function createFallbackUiState(): AppAdvisorUiStateEnvelope {
  const snapshot: AppAdvisorUiStateEnvelope['snapshot'] = {
    activePage: 'main',
    archivedContainers: {
      count: 0,
      viewerOpen: false,
    },
    overlays: {
      commandPaletteOpen: false,
      fileSearchPaletteOpen: false,
      prPickerOpen: false,
      canopyPortalOpen: false,
      appAdvisorOpen: false,
    },
  };
  return {
    version: 1,
    revision: 0,
    capturedAt: new Date().toISOString(),
    digest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    snapshot,
  };
}

export function getLatestAppAdvisorUiState(): AppAdvisorUiStateEnvelope {
  return latestUiState ?? createFallbackUiState();
}

export function setLatestAppAdvisorUiState(
  state: AppAdvisorUiStateEnvelope | undefined,
): void {
  if (state?.version === 1) {
    latestUiState = state;
  }
}

function serializeSettingsSaveRequest(
  settings: AppAdvisorSettingsSaveRequest,
): AppAdvisorSettingsSaveRequest {
  if (
    settings.description !== undefined &&
    typeof settings.description !== 'string'
  ) {
    throw new Error('Invalid App Advisor description');
  }
  if (
    settings.archiveRetentionDays !== undefined &&
    settings.archiveRetentionDays !== null &&
    (typeof settings.archiveRetentionDays !== 'number' ||
      !Number.isInteger(settings.archiveRetentionDays) ||
      settings.archiveRetentionDays < 0 ||
      settings.archiveRetentionDays > MAX_ARCHIVE_RETENTION_DAYS)
  ) {
    throw new Error('Invalid App Advisor deletion retention');
  }
  if (
    settings.autoArchiveDays !== undefined &&
    settings.autoArchiveDays !== null &&
    (typeof settings.autoArchiveDays !== 'number' ||
      !Number.isInteger(settings.autoArchiveDays) ||
      settings.autoArchiveDays < 1 ||
      settings.autoArchiveDays > MAX_ARCHIVE_RETENTION_DAYS)
  ) {
    throw new Error('Invalid App Advisor Auto Delete inactivity');
  }
  return {
    ...(settings.description !== undefined
      ? { description: settings.description }
      : {}),
    ...(settings.archiveRetentionDays !== undefined
      ? { archiveRetentionDays: settings.archiveRetentionDays }
      : {}),
    ...(settings.autoArchiveDays !== undefined
      ? { autoArchiveDays: settings.autoArchiveDays }
      : {}),
  };
}

/**
 * The popout nav's open batch removal dialog, reduced to its mode, count,
 * and phase; `null` when closed and `undefined` when not reported. Throws on
 * a malformed one.
 */
function serializeBatchRemovalDialog(
  value: unknown,
): AppAdvisorWindowBatchRemovalDialog | null | undefined {
  if (value === undefined || value === null) return value;
  if (!isRecord(value)) {
    throw new Error('Invalid App Advisor window UI state');
  }
  const { open, mode, phase, count } = value;
  if (
    open !== true ||
    (mode !== 'archive' && mode !== 'delete') ||
    (phase !== 'confirm' && phase !== 'running' && phase !== 'results') ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    throw new Error('Invalid App Advisor window UI state');
  }
  return { open: true, mode, count, phase };
}

function serializeWindowUiState(
  state: AppAdvisorWindowUiState,
): AppAdvisorWindowUiState {
  if (
    !(
      state.activeWorkEntryId === null ||
      typeof state.activeWorkEntryId === 'string'
    ) ||
    !(state.activeChatId === null || typeof state.activeChatId === 'string') ||
    !(
      state.groupEditorId === undefined ||
      state.groupEditorId === null ||
      isSidebarItemGroupId(state.groupEditorId)
    ) ||
    typeof state.navCollapsed !== 'boolean' ||
    typeof state.settingsModalOpen !== 'boolean' ||
    typeof state.archivedOverviewOpen !== 'boolean' ||
    !(
      state.archivedOverviewWorkspaceId === null ||
      typeof state.archivedOverviewWorkspaceId === 'string'
    ) ||
    typeof state.emptyTrashConfirmationOpen !== 'boolean' ||
    typeof state.emptyTrashRunning !== 'boolean' ||
    !(
      state.lastArchivedOverviewRequestId === null ||
      typeof state.lastArchivedOverviewRequestId === 'string'
    ) ||
    !(
      state.lastArchivedOverviewConfirmationOpened === null ||
      typeof state.lastArchivedOverviewConfirmationOpened === 'boolean'
    ) ||
    !(
      state.hasUnsentDraft === undefined ||
      typeof state.hasUnsentDraft === 'boolean'
    )
  ) {
    throw new Error('Invalid App Advisor window UI state');
  }
  const batchRemovalDialog = serializeBatchRemovalDialog(
    state.batchRemovalDialog,
  );
  if (state.activeWorkEntryId !== null) {
    validateId(state.activeWorkEntryId, 'activeWorkEntryId');
  }
  if (state.activeChatId !== null) {
    validateId(state.activeChatId, 'activeChatId');
  }
  if (state.archivedOverviewWorkspaceId !== null) {
    validateId(
      state.archivedOverviewWorkspaceId,
      'archivedOverviewWorkspaceId',
    );
  }
  if (state.lastArchivedOverviewRequestId !== null) {
    validateId(
      state.lastArchivedOverviewRequestId,
      'lastArchivedOverviewRequestId',
    );
  }
  return {
    activeWorkEntryId: state.activeWorkEntryId,
    activeChatId: state.activeChatId,
    navCollapsed: state.navCollapsed,
    groupEditorId: state.groupEditorId ?? null,
    settingsModalOpen: state.settingsModalOpen,
    archivedOverviewOpen: state.archivedOverviewOpen,
    archivedOverviewWorkspaceId: state.archivedOverviewWorkspaceId,
    emptyTrashConfirmationOpen: state.emptyTrashConfirmationOpen,
    emptyTrashRunning: state.emptyTrashRunning,
    lastArchivedOverviewRequestId: state.lastArchivedOverviewRequestId,
    lastArchivedOverviewConfirmationOpened:
      state.lastArchivedOverviewConfirmationOpened,
    ...(state.hasUnsentDraft === undefined
      ? {}
      : { hasUnsentDraft: state.hasUnsentDraft }),
    ...(batchRemovalDialog === undefined ? {} : { batchRemovalDialog }),
  };
}

function requireWorkspaceOperations(
  operations: AppAdvisorWorkspaceOperations | undefined,
): AppAdvisorWorkspaceOperations {
  if (!operations) {
    throw new Error('App Advisor project operations are unavailable');
  }
  return operations;
}

export function timeoutResponse(
  requestId: string,
): AppAdvisorRendererToolResponse {
  return {
    requestId,
    ok: false,
    uiState: latestUiState ?? undefined,
    error: {
      code: 'timeout',
      message: 'Timed out waiting for the Orchestrator renderer bridge.',
      retryable: true,
    },
  };
}

export function surfaceUnavailableResponse(
  request: AppAdvisorRendererToolRequest,
): AppAdvisorRendererToolResponse {
  return {
    requestId: request.requestId,
    ok: false,
    uiState: latestUiState ?? undefined,
    error: {
      code: 'surface_unavailable',
      message: targetsAppAdvisorSurface(request)
        ? 'The Orchestrator window is unavailable.'
        : `The main ${BRAND.displayName} window renderer bridge is unavailable.`,
      retryable: true,
    },
  };
}

export function cancelledResponse(
  requestId: string,
): AppAdvisorRendererToolResponse {
  return {
    requestId,
    ok: false,
    uiState: latestUiState ?? undefined,
    error: {
      code: 'execution_failed',
      message: 'ask_user_cancelled',
      retryable: false,
    },
  };
}

function clampBrowserActionTimeoutMs(
  timeoutMs: number | undefined,
  defaultTimeoutMs: number,
  maxTimeoutMs: number,
): number {
  const finiteTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? timeoutMs
      : defaultTimeoutMs;
  return Math.min(maxTimeoutMs, Math.max(1, finiteTimeoutMs));
}

function browserTypingBudgetForAction(action: AppAdvisorBrowserAction): number {
  switch (action.type) {
    case 'browser.type':
      return browserTypingBudgetMs(action.text.length, action.delayMs);
    case 'browser.fill': {
      const budgetMs = browserTypingBudgetMs(action.text.length);
      return budgetMs <= BROWSER_TYPING_BUDGET_MAX_MS ? budgetMs : 0;
    }
    case 'browser.select_option':
      return action.searchText === undefined
        ? 0
        : browserTypingBudgetMs(action.searchText.length);
    default:
      return 0;
  }
}

function timeoutMsForRequest(request: AppAdvisorRendererToolRequest): number {
  if (
    request.kind === 'dispatch_action' &&
    request.action.type === 'opencode.connection' &&
    request.action.operation === 'connect'
  ) {
    // Let the owned setup deadline abort and settle before the bridge expires.
    return OPENCODE_CONNECTION_TIMEOUT_MS + TOOL_REQUEST_TIMEOUT_MS;
  }
  if (request.kind === 'ask_user_question') {
    return ASK_USER_REQUEST_TIMEOUT_MS;
  }
  if (request.kind !== 'dispatch_action') {
    return TOOL_REQUEST_TIMEOUT_MS;
  }

  switch (request.action.type) {
    case 'browser.click':
    case 'browser.fill':
    case 'browser.set_checked':
    case 'browser.select_option':
    case 'browser.type':
    case 'browser.press':
    case 'browser.hover':
    case 'browser.scroll':
    case 'browser.drag':
    case 'browser.focus': {
      const actionTimeoutMs = clampBrowserActionTimeoutMs(
        request.action.timeoutMs,
        BROWSER_ACTION_TIMEOUT_DEFAULT_MS,
        BROWSER_ACTION_TIMEOUT_MAX_MS,
      );
      return (
        Math.max(
          TOOL_REQUEST_TIMEOUT_MS,
          actionTimeoutMs * 2 + BROWSER_BRIDGE_TIMEOUT_PADDING_MS,
        ) + browserTypingBudgetForAction(request.action)
      );
    }
    case 'browser.save_pdf':
      return Math.max(
        TOOL_REQUEST_TIMEOUT_MS,
        clampBrowserActionTimeoutMs(request.action.timeoutMs, 30_000, 60_000) +
          BROWSER_BRIDGE_TIMEOUT_PADDING_MS,
      );
    case 'browser.wait_for': {
      const actionTimeoutMs = clampBrowserActionTimeoutMs(
        request.action.timeoutMs,
        BROWSER_WAIT_FOR_TIMEOUT_DEFAULT_MS,
        BROWSER_WAIT_FOR_TIMEOUT_MAX_MS,
      );
      return Math.max(
        TOOL_REQUEST_TIMEOUT_MS,
        actionTimeoutMs + BROWSER_BRIDGE_TIMEOUT_PADDING_MS,
      );
    }
    // These wait for the user to answer this chat's approval prompt.
    case 'browser.upload_files':
    case 'browser.request_files':
    case 'browser.drop_files':
    case 'browser.save_download':
    case 'worktree.set_base_branch':
      return ASK_USER_REQUEST_TIMEOUT_MS;
    default:
      return TOOL_REQUEST_TIMEOUT_MS;
  }
}

function cancelBrowserAutomationForRequest(
  request: AppAdvisorRendererToolRequest,
): void {
  if (
    request.kind === 'dispatch_action' &&
    isAppAdvisorBrowserAction(request.action)
  ) {
    cancelBrowserAutomation(request.requestId);
  }
}

function notifyRendererToolCancellation(
  request: AppAdvisorRendererToolRequest,
  surfaces: AppAdvisorRendererToolSurfaces,
): void {
  const target = targetsAppAdvisorSurface(request)
    ? surfaces.getAppAdvisorWindow()
    : surfaces.getMainWindow();
  const originChatId = getAppAdvisorRendererToolRequestOriginChatId(request);
  sendToWindowDetailed(target, IPC_CHANNELS.appAdvisorToolRequestCancelled, {
    requestId: request.requestId,
    ...(originChatId ? { originChatId } : {}),
  });
}

async function sendRendererToolRequest(
  request: AppAdvisorRendererToolRequest,
  surfaces: AppAdvisorRendererToolSurfaces,
  signal: AbortSignal | undefined,
  isPending: () => boolean,
  onTarget?: (target: BrowserWindow | null) => void,
): Promise<'cancelled' | 'delivered' | 'unavailable'> {
  if (signal?.aborted || !isPending()) {
    return 'cancelled';
  }
  const targetsAppAdvisorWindow = targetsAppAdvisorSurface(request);
  const target = targetsAppAdvisorWindow
    ? await (async (): Promise<BrowserWindow | null> => {
        const backgroundPresentation =
          (request.kind === 'dispatch_action' &&
            isAppAdvisorBrowserAction(request.action)) ||
          (request.kind === 'show_files' &&
            request.payload.intent === 'agent' &&
            request.payload.presentation === 'background');
        const prepareSurface = backgroundPresentation
          ? surfaces.ensureAppAdvisorWindow
          : surfaces.openAppAdvisorWindow;
        await prepareSurface({
          // Browser tools and background file presentation use the hidden-safe
          // create path so neither show() nor focus() can interrupt another window. Other
          // agent-driven open is `background`: the window is revealed, but it
          // only takes OS focus when this app is already frontmost (CAN-1993).
          ...(backgroundPresentation ? {} : { focus: true, background: true }),
          ...(request.kind === 'dispatch_action'
            ? { workEntryId: request.originWorktreeId }
            : request.kind === 'show_files'
              ? { workEntryId: request.payload.target.worktreeId }
              : {}),
        });
        return surfaces.getAppAdvisorWindow();
      })()
    : surfaces.getMainWindow();

  if (signal?.aborted || !isPending()) {
    return 'cancelled';
  }

  onTarget?.(target);
  return sendToWindowDetailed(
    target,
    IPC_CHANNELS.appAdvisorToolRequest,
    request,
  ).delivered
    ? 'delivered'
    : 'unavailable';
}

function fenceTimedOutRequest(
  key: string,
  requestId: string,
  target: BrowserWindow | null,
): void {
  const waiters = new Set<(response: AppAdvisorRendererToolResponse) => void>();
  const release = (): void => {
    clearTimeout(expiry);
    if (target && !target.isDestroyed()) {
      target.webContents.removeListener('did-navigate', reset);
      target.webContents.removeListener('render-process-gone', reset);
      target.webContents.removeListener('destroyed', reset);
    }
    if (timedOut.get(key)?.release === release) {
      timedOut.delete(key);
    }
  };
  const reset = (): void => {
    release();
    waiters.forEach((waiter) => waiter(timeoutResponse(requestId)));
  };
  const expiry = setTimeout(reset, TIMED_OUT_FENCE_MS);
  if (target && !target.isDestroyed()) {
    target.webContents.once('did-navigate', reset);
    target.webContents.once('render-process-gone', reset);
    target.webContents.once('destroyed', reset);
  }
  timedOut.get(key)?.release();
  timedOut.set(key, { waiters, release });
}

function settleTimedOutRequest(
  key: string,
  response: AppAdvisorRendererToolResponse,
): void {
  const fence = timedOut.get(key);
  if (!fence) return;
  fence.release();
  fence.waiters.forEach((waiter) => waiter(response));
}

/** A retry of a fenced request waits for its late result, up to a timeout. */
function joinTimedOutRequest(
  fence: TimedOutRequest,
  request: AppAdvisorRendererToolRequest,
): Promise<AppAdvisorRendererToolResponse> {
  return new Promise((resolve) => {
    const finish = (response: AppAdvisorRendererToolResponse): void => {
      clearTimeout(timer);
      fence.waiters.delete(finish);
      resolve(response);
    };
    const timer = setTimeout(
      () => finish(timeoutResponse(request.requestId)),
      timeoutMsForRequest(request),
    );
    fence.waiters.add(finish);
  });
}

function settlePendingRequest(
  key: string,
  response: AppAdvisorRendererToolResponse,
): void {
  const request = pending.get(key);
  if (!request) {
    rememberCompletedResponseIfAbsent(key, response);
    settleTimedOutRequest(key, completed.get(key) ?? response);
    return;
  }
  if (request.timer !== null) {
    clearTimeout(request.timer);
  }
  pending.delete(key);
  rememberAnsweredQuestion(request.request, response);
  rememberCompletedResponse(key, response);
  request.resolve(response);
  if (request.request.kind === 'ask_user_question') {
    // An answer on another view also retires the original renderer card.
    notifyRendererToolCancellation(request.request, request.surfaces);
    publishQuestionToControllers(request.request, true, request.routeKey);
  }
  projectAppAdvisorPendingQuestionState(request.request);
}

/**
 * Re-project the owning chat's `app_advisor_chat` portal summary after an
 * ask-user question is created or settled, so connected portal clients see
 * pending-question cards appear and disappear live (CAN-2565). Best-effort and
 * dynamic-imported: the pending-request registry must stay loadable without
 * the portal/service graph, and a projection failure must never affect the
 * renderer round-trip being settled.
 */
function projectAppAdvisorPendingQuestionState(
  request: AppAdvisorRendererToolRequest,
): void {
  if (request.kind !== 'ask_user_question' || !request.chatId) {
    return;
  }
  const chatId = request.chatId;
  void (async (): Promise<void> => {
    const { isCanopyPortalActive } = await import('../portal/portal-event-bus');
    if (!isCanopyPortalActive()) {
      return;
    }
    const { resolveWorkEntryForChat } =
      await import('../lib/cowork-work-entries');
    const { entryId } = await resolveWorkEntryForChat(
      APP_ADVISOR_PROJECT_ID,
      chatId,
    );
    if (!entryId) {
      return;
    }
    const { projectAppAdvisorChatSummaries } =
      await import('../services/chat-service');
    await projectAppAdvisorChatSummaries(entryId);
  })().catch(() => undefined);
}

/**
 * Currently awaiting App Advisor ask-user questions, for the portal summary
 * projection (CAN-2565). `chatId` is absent for requests created before the
 * chat attribution existed (or by non-chat callers); those cannot be surfaced
 * on a chat card and are filtered out by the projection.
 */
export function listPendingAppAdvisorAskUserQuestions(): Array<{
  requestId: string;
  chatId?: string;
  question: AppAdvisorAskUserQuestion;
}> {
  const questions: Array<{
    requestId: string;
    chatId?: string;
    question: AppAdvisorAskUserQuestion;
  }> = [];
  for (const entry of Array.from(pending.values())) {
    if (entry.request.kind !== 'ask_user_question') {
      continue;
    }
    questions.push({
      requestId: entry.request.requestId,
      ...(entry.request.chatId ? { chatId: entry.request.chatId } : {}),
      question: entry.request.question,
    });
  }
  return questions;
}

/**
 * Recently answered App Advisor ask-user questions (capped, insertion-ordered)
 * for the portal summary projection (CAN-2608). Complements
 * {@link listPendingAppAdvisorAskUserQuestions}: pending entries render the
 * interactive card, these render the read-only answered card.
 */
export function listAnsweredAppAdvisorAskUserQuestions(): Array<{
  requestId: string;
  chatId: string;
  question: AppAdvisorAskUserQuestion;
  answer: AppAdvisorAskUserAnswer;
}> {
  return Array.from(answeredQuestions.values()).map((entry) => ({ ...entry }));
}

const askUserAnswerProvenance = new Map<string, 'person' | 'agent'>();

/**
 * Who answered this question, read once. Only a window's answer or a Portal
 * session of the signed-in user is a person's; anything else, or no record,
 * is an agent's.
 */
export function takeAppAdvisorAnswerProvenance(
  requestId: string,
): 'person' | 'agent' {
  const provenance = askUserAnswerProvenance.get(requestId);
  askUserAnswerProvenance.delete(requestId);
  return provenance ?? 'agent';
}

/**
 * Settle an awaiting ask-user question from outside the renderer round-trip
 * (the portal answer/dismiss commands, CAN-2565). `answer: null` means the
 * user dismissed the question without answering — settled with the same
 * failure shape the App Advisor renderer produces for a dismissal, so the
 * awaiting `requestUserAnswers` caller cannot tell the two apart. Returns
 * `false` when `requestId` is unknown, is not an ask-user request, or is not
 * bound to `chatId` — the lookup is scoped by chat, so a remote client cannot
 * settle another chat's question (a pending record with no recorded chat
 * cannot be verified and is refused the same way). The settlement itself
 * reuses `settlePendingRequest`, preserving the completed-response
 * idempotency cache.
 */
export function completeAppAdvisorAskUserRequest(
  requestId: string,
  chatId: string,
  answer: AppAdvisorAskUserAnswer | null,
  options?: { agentOriginated?: boolean },
): boolean {
  const key = getRendererToolRequestScopeKey(requestId, chatId);
  const entry = pending.get(key);
  if (
    !entry ||
    entry.request.kind !== 'ask_user_question' ||
    entry.request.chatId !== chatId
  ) {
    return false;
  }
  if (answer)
    askUserAnswerProvenance.set(
      requestId,
      options?.agentOriginated === false ? 'person' : 'agent',
    );
  settlePendingRequest(
    key,
    answer
      ? {
          requestId,
          ok: true,
          uiState: latestUiState ?? undefined,
          answer,
        }
      : {
          requestId,
          ok: false,
          uiState: latestUiState ?? undefined,
          error: {
            code: 'execution_failed',
            message: 'Orchestrator question was dismissed without an answer.',
          },
        },
  );
  return true;
}

export async function requestAppAdvisorRendererTool(
  request: AppAdvisorRendererToolRequest,
  surfaces: AppAdvisorRendererToolSurfaces,
  options?: {
    signal?: AbortSignal;
    /**
     * False for a user's own action in a known window: it runs in `surfaces`
     * even when the chat is driven from another computer.
     */
    followChatDriver?: boolean;
  },
): Promise<AppAdvisorRendererToolResponse> {
  const key = requestKey(request);
  const cached = completed.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }

  const fence = timedOut.get(key);
  if (fence) {
    return joinTimedOutRequest(fence, request);
  }

  const existing = pending.get(key);
  if (existing) {
    return new Promise((resolve) => {
      const previousResolve = existing.resolve;
      // Fan out duplicate requestIds: every observer resolves when the
      // renderer produces the single in-flight response.
      existing.resolve = (response): void => {
        previousResolve(response);
        resolve(response);
      };
    });
  }

  if (options?.signal?.aborted) {
    cancelBrowserAutomationForRequest(request);
    return cancelledResponse(request.requestId);
  }

  const routed =
    options?.followChatDriver === false
      ? null
      : (rendererToolRouter?.(request) ?? null);
  const routedSurfaces: AppAdvisorRendererToolSurfaces = routed ?? surfaces;
  const currentSurfaces = (): AppAdvisorRendererToolSurfaces =>
    pending.get(key)?.surfaces ?? routedSurfaces;
  return new Promise<AppAdvisorRendererToolResponse>((resolve) => {
    let settled = false;
    const isPendingRequest = (): boolean => !settled && pending.has(key);
    const abortPendingRequest = (): void => {
      if (!isPendingRequest()) {
        return;
      }
      cancelBrowserAutomationForRequest(request);
      notifyRendererToolCancellation(request, currentSurfaces());
      settlePendingRequest(key, cancelledResponse(request.requestId));
    };
    const timer = setTimeout(() => {
      if (!isPendingRequest()) {
        return;
      }
      cancelBrowserAutomationForRequest(request);
      notifyRendererToolCancellation(request, currentSurfaces());
      // Actions can change state and may not stop on cancellation.
      if (request.kind === 'dispatch_action') {
        fenceTimedOutRequest(
          key,
          request.requestId,
          pending.get(key)?.target ?? null,
        );
      }
      settlePendingRequest(key, timeoutResponse(request.requestId));
    }, timeoutMsForRequest(request));

    const resolveAndCleanup = (
      response: AppAdvisorRendererToolResponse,
    ): void => {
      settled = true;
      options?.signal?.removeEventListener('abort', abortPendingRequest);
      resolve(response);
    };
    pending.set(key, {
      request,
      resolve: resolveAndCleanup,
      timer,
      target: null,
      surfaces: routedSurfaces,
      routeKey: routed?.routeKey ?? null,
    });
    publishQuestionToControllers(request, false, routed?.routeKey ?? null);
    projectAppAdvisorPendingQuestionState(request);
    options?.signal?.addEventListener('abort', abortPendingRequest, {
      once: true,
    });
    const notDelivered = (): void => {
      if (pending.has(key) || timedOut.has(key)) {
        settlePendingRequest(key, surfaceUnavailableResponse(request));
      }
    };
    void sendRendererToolRequest(
      request,
      routedSurfaces,
      options?.signal,
      isPendingRequest,
      (target) => {
        const entry = pending.get(key);
        if (entry) entry.target = target;
      },
    )
      .then((delivery) => {
        if (delivery === 'unavailable') notDelivered();
      })
      .catch(notDelivered);
  });
}

/**
 * The cached UI state a chat may target implicitly. The cache describes this
 * computer's screen, so a chat driven from a controlling computer gets none
 * and asks that computer instead.
 */
export function getCachedAppAdvisorUiStateForChat(
  originChatTabId: string | undefined,
): AppAdvisorUiStateEnvelope | null {
  const routed =
    originChatTabId !== undefined &&
    rendererToolRouter?.({
      kind: 'get_current_ui_state',
      requestId: '',
      originChatTabId,
    }) != null;
  return routed ? null : getLatestAppAdvisorUiState();
}

export async function requestCurrentAppAdvisorUiState(
  surfaces: AppAdvisorRendererToolSurfaces,
  originChatTabId?: string,
): Promise<AppAdvisorUiStateEnvelope> {
  const request: AppAdvisorRendererToolRequest = {
    kind: 'get_current_ui_state',
    requestId: randomUUID(),
    ...(originChatTabId ? { originChatTabId } : {}),
  };
  const routedToController = rendererToolRouter?.(request) != null;
  const response = await requestAppAdvisorRendererTool(request, surfaces);
  if (response.ok && response.uiState) {
    // A controlling computer's window describes that window, not this
    // computer's screen.
    if (!routedToController) setLatestAppAdvisorUiState(response.uiState);
    return response.uiState;
  }
  // Cached state remains useful to retained consumers, but a fresh request
  // must not advertise cached availability when the renderer cannot refresh.
  return createFallbackUiState();
}

/**
 * CAN-4131: GetCurrentUiState for an App Advisor session. Served by the main
 * window's interface lease, or for a chat driven from another computer by
 * that computer's window lease (CAN-5823); an unbound session gets the
 * fallback state without a call.
 */
export async function requestCurrentAppAdvisorUiStateThroughLease(input: {
  scope: { workspaceId: string; worktreeId: string; chatId: string };
  originChatTabId: string;
  bound: boolean;
  signal?: AbortSignal;
}): Promise<AppAdvisorUiStateEnvelope> {
  const request: AppAdvisorRendererToolRequest = {
    kind: 'get_current_ui_state',
    requestId: randomUUID(),
    originChatTabId: input.originChatTabId,
  };
  const registry = getSessionInterfaceToolRegistry();
  if (!input.bound || !registry) return createFallbackUiState();
  const audience = interfaceToolAudienceOf(input.scope.chatId);
  const outcome = await registry.invoke({
    toolName: 'ui.get_current_ui_state',
    input: { originChatTabId: input.originChatTabId },
    scope: input.scope,
    ...audience,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const response = interfaceToolOutcomeToRendererResponse(outcome, request);
  if (response.ok && response.uiState) {
    // A controlling computer's window describes that window, not this
    // computer's screen.
    if (audience.audience === undefined)
      setLatestAppAdvisorUiState(response.uiState);
    return response.uiState;
  }
  return createFallbackUiState();
}

/**
 * Sends pending questions again to an App Advisor window whose page just
 * (re)loaded: this computer's own, or, given `remote`, a controlling
 * computer's paired view. Paired views can answer any chat's pending question.
 */
export function redeliverPendingAppAdvisorAskUserRequests(
  getAppAdvisorWindow: () => BrowserWindow | null,
  remote?: RemoteAppAdvisorWindowHost,
): void {
  const win = getAppAdvisorWindow();
  for (const entry of Array.from(pending.values())) {
    if (entry.request.kind !== 'ask_user_question') {
      continue;
    }
    if (!remote && entry.routeKey !== null) continue;
    if (remote && entry.routeKey !== remote.routeKey && !entry.request.chatId)
      continue;
    // Replaying another computer's question must not change its execution or
    // presentation owner. Only its original controller replaces stale windows.
    if (remote && entry.routeKey === remote.routeKey) entry.surfaces = remote;
    sendToWindowDetailed(
      win,
      IPC_CHANNELS.appAdvisorToolRequest,
      entry.request,
    );
  }
}

export function registerAppAdvisorHandlers(
  accessors: AppAdvisorWindowAccessors,
  workspaceOperations?: AppAdvisorWorkspaceOperations,
): void {
  registerIpcHandler<[OpenTurnFileRequest], ShowFilesRendererResult>(
    IPC_CHANNELS.appAdvisorOpenTurnFile,
    async (event, request) => {
      if (
        !request ||
        typeof request.path !== 'string' ||
        !request.path.trim() ||
        request.path.includes('\0') ||
        request.origin?.projectId !== APP_ADVISOR_PROJECT_ID
      )
        throw new Error('Invalid file opening request.');
      validateId(request.target?.projectId, 'projectId');
      validateId(request.target?.worktreeId, 'worktreeId');
      validateId(request.origin.worktreeId, 'origin worktreeId');
      validateId(request.origin.chatTabId, 'chatTabId');
      if (request.focusReturnId !== undefined)
        validateId(request.focusReturnId, 'focusReturnId');
      if (request.reuseBrowserId !== undefined)
        validateId(request.reuseBrowserId, 'browserId');
      // Opens where it was clicked: a controlling computer's window opens it
      // there, whoever drives the chat.
      const remote = remoteWindowHostForSender?.(event.sender) ?? null;
      if (request.target.projectId !== APP_ADVISOR_PROJECT_ID) {
        if (remote) void remote.focusMainWindow().catch(() => undefined);
        else focusMainWindow(accessors.getMainWindow());
      }
      const { requestShowFiles } =
        await import('../canopy-tools/show-files-runtime');
      return requestShowFiles(
        {
          intent: 'user',
          files: [{ path: request.path }],
          target: request.target,
          origin: request.origin,
          ...(request.focusReturnId
            ? { focusReturnId: request.focusReturnId }
            : {}),
          ...(request.reuseBrowserId
            ? { reuseBrowserId: request.reuseBrowserId }
            : {}),
        },
        remote ?? accessors,
        { followChatDriver: false },
      );
    },
  );
  registerIpcHandler<[string], void>(
    IPC_CHANNELS.appAdvisorTurnFileClosed,
    (event, focusReturnId) => {
      validateId(focusReturnId, 'focusReturnId');
      // A file a controller's App Advisor opened closes in that controller's
      // main window, and its App Advisor window takes focus back.
      const surfaces = remoteWindowHostForSender?.(event.sender) ?? accessors;
      const mainWindow = surfaces.getMainWindow();
      if (!mainWindow || event.sender !== mainWindow.webContents)
        throw new Error(
          'File viewer close notifications must come from the main window.',
        );
      sendToWindowDetailed(
        surfaces.getAppAdvisorWindow(),
        IPC_CHANNELS.appAdvisorTurnFileClosed,
        focusReturnId,
      );
    },
  );
  registerIpcHandler<
    [AgentArtifactNavigationRequest],
    AgentArtifactNavigationResponse
  >(IPC_CHANNELS.appAdvisorOpenAgentArtifact, async (event, request) => {
    const normalized = normalizeAgentArtifactNavigationRequest(request);
    if (!normalized) {
      return {
        ok: false,
        error: {
          code: 'validation_failed',
          message: 'Invalid agent artifact navigation request.',
          retryable: false,
        },
      };
    }
    try {
      validateArtifactNavigationIds(normalized);
    } catch {
      return {
        ok: false,
        error: {
          code: 'validation_failed',
          message: 'Invalid agent artifact navigation request.',
          retryable: false,
        },
      };
    }
    try {
      const remote = event
        ? (remoteWindowHostForSender?.(event.sender) ?? null)
        : null;
      const response =
        accessors.openAgentArtifact && !remote
          ? await accessors.openAgentArtifact(normalized)
          : await openAgentArtifactInMainWindow(normalized, accessors, remote);
      return response.ok
        ? { ok: true }
        : {
            ok: false,
            error: normalizeAgentArtifactNavigationError(response.error),
          };
    } catch (error) {
      return {
        ok: false,
        error: normalizeAgentArtifactNavigationError({
          code: 'navigation_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Agent artifact navigation failed.',
          retryable: false,
        }),
      };
    }
  });

  registerIpcHandler<[AppAdvisorRendererToolResponse], void>(
    IPC_CHANNELS.appAdvisorToolResponse,
    (event, response) => {
      // A controlling computer's window describes that window, not this
      // computer's screen.
      if (!remoteWindowHostForSender?.(event.sender)) {
        setLatestAppAdvisorUiState(response.uiState);
      }
      if (interfaceToolReplyHandler?.(event.sender.id, response) === 'claimed')
        return;
      // Late/unknown responses must not replace an existing settlement: a
      // renderer dismissal racing a portal answer (CAN-2565) would otherwise
      // overwrite the answer duplicate lookups replay. A late response still
      // settles a timed-out request's fence.
      // The question card in a window (this computer's or the controlling
      // computer's) is where a person answers.
      const key = responseKey(response);
      if (
        response.ok &&
        response.answer &&
        pending.get(key)?.request.kind === 'ask_user_question'
      )
        askUserAnswerProvenance.set(response.requestId, 'person');
      settlePendingRequest(key, response);
    },
  );

  registerIpcHandler<[], AppAdvisorUiStateEnvelope>(
    IPC_CHANNELS.appAdvisorGetState,
    async (event) => {
      const remote = remoteWindowHostForSender?.(event.sender) ?? null;
      const response = await requestAppAdvisorRendererTool(
        { kind: 'get_current_ui_state', requestId: randomUUID() },
        remote ?? accessors,
      );
      if (remote) {
        return response.uiState ?? createFallbackUiState();
      }
      setLatestAppAdvisorUiState(response.uiState);
      return response.uiState ?? getLatestAppAdvisorUiState();
    },
  );

  registerIpcHandler<[], AppAdvisorSettingsLoadResponse>(
    IPC_CHANNELS.appAdvisorSettingsLoad,
    () => requireWorkspaceOperations(workspaceOperations).settingsLoad(),
  );

  registerIpcHandler<
    [AppAdvisorSettingsSaveRequest],
    AppAdvisorSettingsSaveResponse
  >(IPC_CHANNELS.appAdvisorSettingsSave, (_event, settings) => {
    const serialized = serializeSettingsSaveRequest(settings);
    return requireWorkspaceOperations(workspaceOperations)
      .settingsSave(serialized)
      .then((saved) => {
        sendToWindowDetailed(
          accessors.getMainWindow(),
          IPC_CHANNELS.appAdvisorSettingsChanged,
          saved,
        );
        sendToWindowDetailed(
          accessors.getAppAdvisorWindow(),
          IPC_CHANNELS.appAdvisorSettingsChanged,
          saved,
        );
        return saved;
      });
  });

  // The settings Portal's Orchestrator settings get and save serve, for
  // browser Remote Control (CAN-5985); the desktop modal keeps its own
  // channels above.
  // Loaded on first use: the settings view reaches the model catalog, whose
  // imports lead back to this module.
  registerIpcHandler<[], AppAdvisorSettingsViewResponse>(
    IPC_CHANNELS.appAdvisorSettingsView,
    async () => {
      const { readAppAdvisorSettingsView } =
        await import('../app-advisor/settings-view');
      return readAppAdvisorSettingsView();
    },
  );

  registerIpcHandler<
    [AppAdvisorSettingsPatchRequest],
    AppAdvisorSettingsPatchResponse
  >(IPC_CHANNELS.appAdvisorSettingsPatch, async (_event, patch) => {
    const { applyAppAdvisorSettingsPatch } =
      await import('../app-advisor/settings-view');
    return applyAppAdvisorSettingsPatch(patch, accessors);
  });

  registerIpcHandler<[], AppAdvisorClaudeMdLoadResponse>(
    IPC_CHANNELS.appAdvisorLoadClaudeMd,
    () => requireWorkspaceOperations(workspaceOperations).loadClaudeMd(),
  );

  registerIpcHandler<[AppAdvisorClaudeMdSaveRequest], void>(
    IPC_CHANNELS.appAdvisorSaveClaudeMd,
    (_event, contents) => {
      if (typeof contents !== 'string') {
        throw new Error('Invalid App Advisor CLAUDE.md contents');
      }
      return requireWorkspaceOperations(workspaceOperations).saveClaudeMd(
        contents,
      );
    },
  );

  registerIpcHandler<[AppAdvisorWindowUiState], void>(
    IPC_CHANNELS.appAdvisorReportWindowUiState,
    (event, state) => {
      const latestWindowUiState = serializeWindowUiState(state);
      const remote = remoteWindowHostForSender?.(event.sender);
      if (remote) {
        remote.reportAppAdvisorWindowUiState(latestWindowUiState);
        return;
      }
      setLatestAppAdvisorWindowUiState(latestWindowUiState);
      sendToWindowDetailed(
        accessors.getMainWindow(),
        IPC_CHANNELS.appAdvisorWindowUiStateChanged,
        latestWindowUiState,
      );
    },
  );

  registerIpcHandler<
    [AppAdvisorWindowOpenRequest | undefined],
    AppAdvisorWindowState
  >(IPC_CHANNELS.appAdvisorWindowOpen, (event, request) =>
    (
      remoteWindowHostForSender?.(event.sender) ?? accessors
    ).openAppAdvisorWindow(request),
  );

  registerIpcHandler<
    [AppAdvisorWindowOpenRequest | undefined],
    AppAdvisorWindowState
  >(IPC_CHANNELS.appAdvisorWindowEnsure, (event, request) =>
    (
      remoteWindowHostForSender?.(event.sender) ?? accessors
    ).ensureAppAdvisorWindow(request),
  );

  registerIpcHandler<[unknown], AppAdvisorWindowState>(
    IPC_CHANNELS.appAdvisorWindowClose,
    (event, options) => {
      const remote = remoteWindowHostForSender?.(event.sender);
      return remote
        ? remote.closeAppAdvisorWindow()
        : accessors.closeAppAdvisorWindow(options);
    },
  );

  registerIpcHandler<
    [AppAdvisorWindowOpenRequest | undefined],
    AppAdvisorWindowState
  >(IPC_CHANNELS.appAdvisorWindowToggle, (event, request) =>
    (
      remoteWindowHostForSender?.(event.sender) ?? accessors
    ).toggleAppAdvisorWindow(request),
  );

  registerIpcHandler<[], AppAdvisorWindowState>(
    IPC_CHANNELS.appAdvisorWindowGetState,
    (event) =>
      (
        remoteWindowHostForSender?.(event.sender) ?? accessors
      ).getAppAdvisorWindowState(),
  );

  registerIpcHandler<[], AppAdvisorWindowState>(
    IPC_CHANNELS.appAdvisorWindowRendererReady,
    (event) => {
      const remote = remoteWindowHostForSender?.(event.sender);
      if (remote && !questionViews.has(event.sender.id)) {
        const senderId = event.sender.id;
        questionViews.set(senderId, remote);
        event.sender.once('destroyed', () => questionViews.delete(senderId));
      }
      return remote
        ? remote.markAppAdvisorWindowRendererReady()
        : accessors.markAppAdvisorWindowRendererReady(event.sender);
    },
  );

  registerIpcHandler<[unknown], AppAdvisorWindowState>(
    IPC_CHANNELS.appAdvisorWindowSetFloatingSize,
    (_event, size) => accessors.setAppAdvisorFloatingSize(size),
  );

  registerIpcHandler<[unknown], AppAdvisorDockResult>(
    IPC_CHANNELS.appAdvisorWindowSetDock,
    (event, request) => accessors.setAppAdvisorDock(event.sender, request),
  );
}
