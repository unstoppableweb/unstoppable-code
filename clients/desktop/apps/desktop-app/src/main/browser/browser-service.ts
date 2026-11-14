import { classifyError } from '@canopy/protocol/app-errors/classification';
import {
  browserHandoffs,
  type BrowserHandoffAdmission,
} from './browser-handoffs';
import {
  applyBrowserViewFrameLayout,
  createBrowserViewFrame,
  layoutBrowserViewFrame,
  SQUARE_CORNERS,
  type BrowserViewFrame,
} from './browser-view-frame';
import type {
  BrowserCornerRadii,
  BrowserHandoff,
  BrowserServiceEvent,
  ShowFilesChatOrigin,
} from '@canopy/desktop-shared/types';
import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { BrowserScratchOwner } from '@canopy/desktop-shared/node/browser-profiles/owned-scratch';
import { browserTaskOwnerIds } from '@canopy/desktop-shared/node/browser-profiles/owners';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type AppLinkBrowserEvent,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserConsoleEntry,
  type BrowserCreateRequest,
  type BrowserElementSnapshot,
  type BrowserEvent,
  type BrowserFindInPageRequest,
  type BrowserGetConsoleRequest,
  type BrowserGetNetworkRequest,
  type BrowserHandleJavaScriptDialogRequest,
  type BrowserHandleJavaScriptDialogResponse,
  type BrowserInputSnapshotRequest,
  type BrowserInputSnapshotResponse,
  type BrowserInspectRequest,
  type BrowserJavaScriptDialog,
  type BrowserJavaScriptDialogResponse,
  type BrowserJavaScriptDialogType,
  type BrowserLoadStatus,
  type BrowserNavigateRequest,
  type BrowserNetworkEntry,
  type BrowserRecordingResult,
  type BrowserRecordingStep,
  type BrowserRectangle,
  type BrowserScreenshotRequest,
  type BrowserScreenshotResponse,
  type BrowserSessionSnapshot,
  type BrowserSetBoundsRequest,
  type BrowserStopFindInPageAction,
  type BrowserThemeMode,
  type LoadWorktreeBrowserStateResponse,
  type PersistedWorktreeBrowserStateFile,
  type ResourceMetadata,
  type SaveWorktreeBrowserStateRequest,
  type WorktreeBrowserLayoutState,
} from '@canopy/desktop-shared/types';
import type {
  BrowserListTransfersRequest,
  BrowserListTransfersResult,
  BrowserCancelTransferRequest,
  BrowserCancelTransferResult,
  BrowserDownloadTransfer,
  BrowserSaveDownloadRequest,
  BrowserSaveDownloadResult,
  BrowserSavePdfRequest,
  BrowserPrintRequest,
  BrowserAuthRequest,
  BrowserAnswerAuthRequestRequest,
  BrowserActionEffects,
  BrowserAnswerPrintRequestRequest,
  BrowserAnswerPrintRequestResult,
  BrowserSavePdfResult,
  BrowserTransfer,
  BrowserTransferErrorCode,
  BrowserTransferCommand,
  BrowserTransferCommandResult,
  BrowserUploadTransfer,
  BrowserAutomationCommand,
  BrowserKeyModifier,
  BrowserMouseButton,
  BrowserProfileSwitchRequest,
  BrowserProfileSwitchResult,
} from '@canopy/execution-engine/types/browser';
import { isMcpOAuthBrowserScope } from '@canopy/execution-engine/types/browser';
import type {
  BrowserClearPreview,
  BrowserProfileRecord,
  BrowserProfileUsage,
} from '@canopy/protocol/browser-profiles';
import {
  browserTaskScopeTuple,
  isBrowserProfileSelection,
  isProfileId,
  type BrowserTaskScope,
} from '@canopy/protocol/browser-profiles';
import {
  WebContentsView,
  dialog,
  ipcMain,
  session,
  type BrowserWindow,
  type OpenDialogOptions,
  type IpcMainEvent,
  type Rectangle,
  type WebContents,
} from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KeyedAsyncLock } from '../lib/keyed-async-lock';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  openExternalGuarded,
  openFileInDefaultWebBrowser,
} from '../lib/open-external';
import {
  READ_ONLY_SCOPE_ERROR,
  assertPathOutsideSharedContainerReplicas,
} from '../lib/read-only-scope';
import { rendererContentsOf } from '../lib/renderer-surface';
import { cssRectToWindowDips } from '../lib/ui-zoom';
import {
  registerIpcSurface,
  sendToWebContents,
} from '../lib/web-contents-send';
import { sendToWindow } from '../lib/window-send';
import {
  getResourceMonitorService,
  type ResourceRegistrationHandle,
} from '../resource-monitor';
import {
  assertSharedContainerViewerFileForRead,
  resolveSharedContainerViewerReadRoots,
  type SharedContainerViewerReadRoot,
} from '../shared-containers/read/viewer-root';
import { BrowserDownloads } from './browser-downloads';
import {
  loadAndMigrateWorktreeBrowserState,
  loadWorktreeBrowserState,
  loadWorktreeBrowserStateAsync,
  saveWorktreeBrowserState,
  type BrowserStateCommit,
} from './browser-persistence';
import { BrowserProfileData } from './browser-profile-data';
import type { BrowserProfileResolution } from './browser-profile-service';
import {
  getBrowserProfileService,
  type BrowserProfileAuthority,
} from './browser-profile-service';
import {
  BrowserSwitchJournal,
  browserProfileSwitchDigest,
  performBrowserProfileSwitch,
} from './browser-profile-switch';
import {
  resolveBrowserShortcutAction,
  type BrowserShortcutAction,
} from './browser-shortcuts';
import {
  isAllowedInAppBrowserUrl,
  isFileBrowserUrl,
  isSafeExternalBrowserUrl,
  normalizeBrowserUrlInput,
  sameBrowserUrl,
} from './browser-url-policy';
import { runSetChecked } from './actions/set-checked';
import { runSelectOption } from './actions/select-option';
import { runType } from './actions/type';
import { runFill } from './actions/fill';
import { refuseClickControl } from './actions/click-control';
import {
  FormActionError,
  mergeFormActionTargetState,
  type FormActionOptions,
  type FormActionResult,
} from './actions/form-action';
import { actionTypingBudgetMs } from './actions/typing-budget';
import { dispatchHover } from './actions/hover';
import { dispatchDrag } from './actions/drag';
import {
  dispatchAmountScroll,
  scrollEffect,
  waitForScrollStability,
  type AmountScrollResult,
} from './actions/scroll';
import { pointerRecording } from './actions/pointer-recording';
import {
  downloadRecording,
  printRecording,
  recordingScriptBody,
  uploadRecording,
} from './actions/file-recording';
import { type ScrollState } from './frames/scroll-state';
import {
  PageModelHost,
  type PageModelBuildOptions,
} from './frames/page-model-host';
import { type BrowserPageModel } from './frames/model-types';
import {
  normalizeTextQuery,
  type ActionTargetRequest,
  type ResolvedActionTarget,
} from './frames/action-targets';
import { nodeAtViewportPoint } from './frames/host-cdp';
import { type DocumentMapping } from './actions/actionability';
import { LocatorRequestError } from './frames/locator-requests';
import {
  actionTargetRequest,
  holdActionTarget,
  resolutionMessage,
  TargetDialogError,
  TargetResolutionError,
} from './actions/held-target';
import { syntheticActionDeclaration } from './actions/synthetic-action';
import {
  browserReadTargetFailure,
  decodeBrowserReadTargetError,
} from '@canopy/desktop-shared/browser/read-target-error';
import {
  cancelDocumentCommands,
  documentCommand,
  type DocumentCommands,
} from './actions/document-command';
import {
  FrameDelivery,
  isPressEvent,
  mouseButtonNumber,
} from './actions/frame-delivery';
import { holdInputRecorder } from './actions/held-recorder';
import {
  MainFrameNavigationGate,
  READ_NAVIGATION_WAIT_MS,
} from './navigation-read-gate';
import { dialogFromTargetDocument } from './actions/target-document';
import {
  ActionLaneRegistry,
  type ActionLane,
  type ActionLaneContext,
  type ActionLaneUnknownReason,
} from './actions/action-lane';
import {
  parseKeyCombo,
  buildKeyEventSequence,
  isChordRefused,
} from './actions/key-definitions';
import {
  checkActionability,
  type ActionabilityResult,
} from './actions/actionability';
import {
  dispatchClick,
  dispatchFocus,
  dispatchPress,
  dispatchTargetedPress,
  type InputAttribution,
} from './actions/input-dispatch';
import {
  BrowserWaitForInvalidTargetError,
  BrowserWaitForNavigationError,
  waitForBrowserCondition,
  type BrowserWaitForProbe,
} from './actions/wait-for';
import {
  requestFrame,
  validateBrowserAutomationCommand,
} from './actions/automation-validation';
import {
  captureEffectBaseline,
  collectBrowserEffects,
  sanitizeNavigationUrl,
} from './actions/effects';
import {
  describeFileInput,
  describeFileInputNode,
  fileInputConnected,
  frameOrigins,
  type FileInputInfo,
} from './actions/upload-files';
import {
  FILE_CHOOSER_LIFETIME_MS,
  chooserDialogOptions,
} from './files/choosers';
import {
  NATIVE_PRINT_EXPRESSION,
  NATIVE_PRINT_WORLD,
  PRINT_BINDING,
  PRINT_REQUEST_LIFETIME_MS,
  printBlockedBySandbox,
  printBridgeScript,
} from './actions/print-bridge';
import {
  attachmentUploadSource,
  workspaceUploadSource,
  type UploadSource,
} from './files/uploads';
import { readChatTranscript } from '../lib/chat-tabs-reader';
import { resolveAgentAttachmentsDir } from '../lib/agent-attachments';
import {
  BrowserTaskFiles,
  type BrowserTaskFilesScope,
  type BrowserRuntimeKey,
} from './files/task-files';
import {
  prepareChosenDestination,
  prepareWorkspaceDestination,
} from './files/workspace-copy';
import { requestChatApproval } from '../approvals/approval-session-registry';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { getObservabilityService } from '../observability';
import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  type BrowserActionReceipt,
  type BrowserActionError,
  type BrowserActionErrorCode,
  type BrowserActionTargetState,
  type BrowserInputMode,
  type BrowserPostDispatchUnknown,
  type BrowserAnswerFileChooserRequest,
  type BrowserFileChooser,
  type BrowserFileInputTarget,
} from '@canopy/desktop-shared/types';
import { denyPermission, onPermissionDenied } from './permission-denials';

const CONSOLE_LIMIT = 500;
const NETWORK_LIMIT = 1000;
const RECORDING_LIMIT = 1000;
const JAVASCRIPT_DIALOG_MESSAGE_LIMIT = 10_000;
const JAVASCRIPT_DIALOG_PROMPT_LIMIT = 10_000;
const JAVASCRIPT_DIALOG_CLOSE_TIMEOUT_MS = 3000;
const NAVIGATION_ACTION_RETURN_TIMEOUT_MS = 1500;
/** How long an agent tab's first load waits for its pane to show it. */
const INITIAL_LOAD_PANE_WAIT_MS = 1500;
/** Bounds an action's fill and describe, as the preload's former prepared commands were. */
const PREPARED_COMMAND_TIMEOUT_MS = 15_000;
const APP_PROMPT_BRIDGE_KEY = '__canopyBrowserAppPromptBridge_v1';
const APP_PROMPT_BRIDGE_MARKER = 'canopy-browser-app-prompt-v1';
/** Chromium `ERR_ABORTED` — a navigation superseded by a newer one or stopped. */
const ERR_ABORTED_CODE = -3;
/**
 * Chromium `ERR_FAILED`. Electron's `loadURL` rejects with it when a load
 * stops and nothing finished or failed it, as when its response is saved as a
 * download.
 */
const ERR_FAILED_CODE = -2;
/** How DevTools reports a request Chromium aborted. */
const ABORTED_REQUEST_ERROR = 'net::ERR_ABORTED';
/** How long a download's start may precede the report that its request was aborted. */
const SAVED_REQUEST_WINDOW_MS = 10_000;
const SAVED_REQUEST_LIMIT = 20;
/**
 * How long a navigate that was aborted waits to hear that a download took its
 * response. Chromium aborts the navigation first and announces the download after.
 */
const DOWNLOAD_ANNOUNCEMENT_WAIT_MS = 400;
/** Chromium `ERR_FILE_NOT_FOUND`. */
const ERR_FILE_NOT_FOUND_CODE = -6;
/** Chromium `ERR_ACCESS_DENIED`. */
const ERR_ACCESS_DENIED_CODE = -10;
/** Upper bound for a single CDP `debugger.sendCommand` so it cannot hang. */
const DEBUGGER_COMMAND_TIMEOUT_MS = 2000;

/**
 * The page's emulated `prefers-color-scheme`. `system` clears the override
 * (an empty value), so the page follows the app's own theme.
 */
function emulatedColorScheme(mode: BrowserThemeMode): string {
  return mode === 'system' ? '' : mode;
}
const SCREENSHOT_CAPTURE_ATTEMPTS = 3;
const SCREENSHOT_REPAINT_INTERVAL_MS = 16;
const SCREENSHOT_DATA_URL_PREFIX = 'data:image/png;base64,';
// Overlay freeze frames stand in for the native view for as long as a menu or
// dialog covers it, so they must arrive within a frame or two. PNG-encoding a
// full-resolution page takes about a second for noisy or gradient-heavy
// content; JPEG at this quality takes milliseconds and is visually equivalent.
const FREEZE_FRAME_JPEG_QUALITY = 90;
const FREEZE_FRAME_DATA_URL_PREFIX = 'data:image/jpeg;base64,';
let browserScreenshotObservationSequence = 0;

interface BrowserScreenshotObservationContext {
  callback: (observation: Record<string, unknown>) => void;
  requestSequence: number;
  requestedBrowserId: string;
  requestedBrowserIdTruncated: boolean;
  resolvedBrowserId: string;
  resolvedBrowserIdTruncated: boolean;
}

function isScreenshotObservationCallback(
  value: unknown,
): value is BrowserScreenshotObservationContext['callback'] {
  return typeof value === 'function';
}
const PRELOAD_COMMAND_CHANNEL = 'canopy-browser-view:command';

function isProfilelessBrowserScope(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    isMcpOAuthBrowserScope(projectId, worktreeId) ||
    projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID
  );
}

function profilelessBrowserPartition(
  projectId: string,
  worktreeId: string,
): string {
  return isMcpOAuthBrowserScope(projectId, worktreeId)
    ? 'mcp-oauth'
    : `persist:canopy-browser-shared-container-${encodeURIComponent(worktreeId)}`;
}

function isTrustedLocalFileSource(url: string | undefined): boolean {
  return (
    typeof url === 'string' &&
    isFileBrowserUrl(url) &&
    isAllowedInAppBrowserUrl(url, false)
  );
}

const PRELOAD_RESULT_CHANNEL = 'canopy-browser-view:result';
const PRELOAD_EVENT_CHANNEL = 'canopy-browser-view:event';
/**
 * The only request the E2E measurement hook accepts: one page-model build,
 * timed, with or without the cache and the optional stages.
 */
interface PageModelMeasurementRequest {
  kind: 'build';
  browserId: string;
  options: PageModelBuildOptions;
}

declare global {
  // Measures page-model builds for the performance scenario and the
  // page-model spec; assigned only in E2E builds. It cannot change routing.
  var __CANOPY_E2E_BROWSER_PAGE_MODEL__:
    | ((request: PageModelMeasurementRequest) => Promise<unknown>)
    | undefined;
}

const MEASUREMENT_REQUEST_MESSAGE =
  'The page-model hook only measures a build: { kind: "build", browserId, options: { cache: "use" | "bypass", accessibility?, listeners? } }.';

/** The hook's request, or a thrown error naming the one shape it takes. */
function measurementRequest(value: unknown): PageModelMeasurementRequest {
  const options = isRecord(value) ? value.options : undefined;
  if (
    !isRecord(value) ||
    value.kind !== 'build' ||
    typeof value.browserId !== 'string' ||
    !isRecord(options) ||
    (options.cache !== 'use' && options.cache !== 'bypass') ||
    (options.accessibility !== undefined &&
      typeof options.accessibility !== 'boolean') ||
    (options.listeners !== undefined && typeof options.listeners !== 'boolean')
  )
    throw new Error(MEASUREMENT_REQUEST_MESSAGE);
  return {
    kind: 'build',
    browserId: value.browserId,
    options: {
      cache: options.cache,
      ...(typeof options.accessibility === 'boolean'
        ? { accessibility: options.accessibility }
        : {}),
      ...(typeof options.listeners === 'boolean'
        ? { listeners: options.listeners }
        : {}),
    },
  };
}

// Agent snapshots, inspect, waits and actions run on the page model; the
// preload takes only pick mode and recording.
type BrowserPreloadCommandType = 'setPickMode' | 'setRecording';

interface BrowserPreloadCommand {
  requestId: string;
  type: BrowserPreloadCommandType;
  payload: unknown;
}

interface BrowserPreloadResult {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface AgentActionWindow {
  from: number;
  /** Set, with `secret`, when the action ends. */
  to?: number;
  secret?: boolean;
  /** A step was left out, so the omission is already recorded. */
  omitted?: boolean;
  held: Array<{ step: BrowserRecordingStep; secretElement: boolean }>;
  /** Downloads the action started, recorded after its own steps. */
  downloads?: BrowserRecordingStep[];
}

interface BrowserPreloadEvent {
  type:
    | 'element-picked'
    | 'recording-step'
    | 'pick-cancelled'
    | 'user-interaction';
  browserId?: string;
  snapshot?: BrowserElementSnapshot;
  step?: BrowserRecordingStep;
  /** The page recorder treated the step's element as secret. */
  secretElement?: boolean;
  interaction?: {
    type: string;
    button?: number;
    key?: string;
    clientX?: number;
    clientY?: number;
    timestamp: number;
  };
}

interface ElectronJavaScriptDialogInfo {
  dialogType: string;
  messageText: string;
  defaultPromptText?: string;
  frame?: {
    url?: string;
  };
}

type ElectronJavaScriptDialogCallback = (
  success: boolean,
  userInput: string,
) => void;

interface AppOwnedJavaScriptDialog {
  dialogId: string;
  callback: ElectronJavaScriptDialogCallback;
}

interface BrowserDialogCorrelation {
  dialog: BrowserJavaScriptDialog;
  privateSeen: boolean;
  cdpSeen: boolean;
  closedAt?: number;
  answer?: { accept: boolean; promptText: string };
}

type BeforeUnloadAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'reload' }
  | { kind: 'profile-switch' };

interface AppOwnedBeforeUnloadDialog {
  dialogId: string;
  action: BeforeUnloadAction;
}

interface AppOwnedPromptPause {
  dialogId: string;
  callFrameId: string;
  handling: boolean;
}

interface PrearmedPageDialogCapture {
  type: BrowserJavaScriptDialogType;
  message: string;
  defaultPrompt?: string;
  url: string;
  openedAt: number;
}

interface LiveBrowserSession {
  snapshot: BrowserSessionSnapshot;
  view: WebContentsView;
  /** Views that place and round `view` in its host window. */
  viewFrame: BrowserViewFrame;
  hostWindow: BrowserWindow | null;
  hostClosedHandler?: () => void;
  resourceHandle?: ResourceRegistrationHandle;
  bounds: BrowserRectangle;
  visible: boolean;
  /**
   * A tab-cycle chord came from this page, so the page held keyboard focus.
   * The next visibility change consumes it: hiding hands focus to the host
   * (see `showView`).
   */
  cycledFromPage?: boolean;
  /** The page area's corner radii in host CSS px (see `setBounds`). */
  cornerRadii: BrowserCornerRadii;
  console: BrowserConsoleEntry[];
  network: BrowserNetworkEntry[];
  networkStartedAt: Map<string, number>;
  inflightRequestIds: Set<string>;
  lastNetworkActivityAt?: number;
  recordingSteps: BrowserRecordingStep[];
  /** When recording last started; downloads that began earlier are not steps. */
  recordingStartedAt?: number;
  /**
   * Downloads already recorded since then, so a cleared or trimmed
   * recording never gets a running download's step back.
   */
  recordedDownloads?: Set<string>;
  navigationSequence: number;
  /**
   * The load in progress and what the tab showed before it. A response saved
   * as a download ends its load without finishing or failing it, and the tab
   * is then as it was.
   */
  load?: {
    origin: Pick<BrowserSessionSnapshot, 'url' | 'status' | 'lastError'>;
    savedAsDownload: boolean;
    /** Aborted navigates waiting to hear whether a download took their response. */
    announced: Array<(saved: boolean) => void>;
  };
  /** When each response was saved as a download, by URL, until its request is reported aborted. */
  savedRequests?: Map<string, number>;
  actionDocumentRevision?: number;
  actionMutationCount?: number;
  actionMutationAt?: number;
  actionSettleListeners?: Set<() => void>;
  expectedAgentInput?: Array<{
    type: string;
    button?: number;
    key?: string;
    clientX?: number;
    clientY?: number;
    timestamp: number;
    expiresAt: number;
    confirm?: () => void;
  }>;
  /**
   * When recent agent drags ran. The page recorder sees the events a drag
   * causes (a slider's input and change, the click after it); the drag is
   * recorded once, as itself, so page steps from inside a window are dropped.
   */
  agentDragWindows?: Array<{ from: number; to?: number }>;
  agentEditorWindows?: Array<{ from: number; to?: number }>;
  /**
   * Recent targeted agent actions. The page recorder knows a secret form
   * control, not everything the page model holds secret: an ARIA list, an
   * editing host, or what is inside one. A page step from inside a window
   * waits for the action to end. When the action's target was secret, the
   * step is kept only if the recorder itself treated its element as secret;
   * the others become one omission.
   */
  agentActionWindows?: AgentActionWindow[];
  activeActionDialog?: (dialog: BrowserJavaScriptDialog) => void;
  activeActionContext?: ActionLaneContext;
  presentationRevision: number;
  presentationChangedAt?: number;
  inputPresentationRevision?: number;
  hasBeenShown?: boolean;
  /**
   * An agent tab's first load, held until its pane shows the view at a real
   * size. A view that was never shown lays its page out at 0×0.
   */
  deferredInitialLoad?: {
    url: string;
    timer: ReturnType<typeof setTimeout>;
    started: Promise<BrowserSessionSnapshot>;
    /** Starts the load (`true`) or drops it for a newer navigation. */
    settle: (load: boolean) => void;
  };
  /**
   * The URL a held first load started. A request for it while it still loads
   * (the renderer's create for the placed tab) is not a new navigation:
   * restarting the load would leave its first request unfinished. Cleared when
   * loading stops, a navigation starts, or the page starts another load.
   */
  heldLoadUrl?: string;
  navigationChainAllowsFileTargets: boolean;
  mainFrameId?: string;
  pendingCommands: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout?: ReturnType<typeof setTimeout>;
    }
  >;
  pendingDialogWaiters: Set<(dialog: BrowserJavaScriptDialog) => void>;
  pendingDialog?: BrowserJavaScriptDialog;
  /** One chooser an agent's action opened, until answered or ended. */
  pendingFileChooser?: PendingFileChooser;
  /** The native picker is open for a chooser the user opened. */
  userFileChooserOpen?: boolean;
  /** Reading a chooser an agent's action opened, so the action can report it. */
  fileChooserOpening?: Promise<void>;
  /** One print an agent's action asked for, until answered or ended. */
  pendingPrintRequest?: PendingPrintRequest;
  /** Reading a print an agent's action asked for, so the action can report it. */
  printRequestOpening?: Promise<void>;
  /** Print calls whose frame is still being read. */
  printCalls?: Set<PrintCall>;
  /** One HTTP sign-in the page waits on, until the user answers or it ends. */
  pendingAuthRequest?: PendingAuthRequest;
  /** Popups and denied permission requests agents' actions caused. */
  actionPopups?: Array<{
    actionId: string;
    popup: NonNullable<BrowserActionEffects['popup']>;
  }>;
  actionPermissionsDenied?: Array<{ actionId: string; permission: string }>;
  dialogAnswers?: Map<string, Promise<BrowserHandleJavaScriptDialogResponse>>;
  dialogCorrelations?: BrowserDialogCorrelation[];
  answeredDialogCallbacks?: WeakSet<ElectronJavaScriptDialogCallback>;
  pendingDialogClose?: {
    dialogId: string;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  };
  appDialog?: AppOwnedJavaScriptDialog;
  appBeforeUnloadDialog?: AppOwnedBeforeUnloadDialog;
  pendingBeforeUnloadAction?: BeforeUnloadAction;
  profileSwitchDecision?: (accept: boolean) => void;
  profileSwitchClosingAccepted?: boolean;
  allowNextBeforeUnload: boolean;
  appPromptPause?: AppOwnedPromptPause;
  appPromptBridgeSourceUrl: string;
  pendingAppPromptBridgeSourceUrls: Set<string>;
  appPromptBridgeScriptIds: Map<number, Set<string>>;
  executionContextFrames: Map<
    number,
    {
      frameId: string;
      origin: string;
      type: string;
      name: string;
    }
  >;
  frameUrls: Map<string, string>;
  observationSessions: Set<string>;
  pageModel: PageModelHost;
  /** Whether a main-frame navigation's document is on its way (E2). */
  mainFrameNavigation: MainFrameNavigationGate;
  /**
   * Page model commands bound to the main document (wait probes, an
   * action's fill and describe), cancelled when it is replaced or the
   * renderer is lost, as the preload's prepared commands were.
   */
  documentCommands?: DocumentCommands['documentCommands'];
  attachmentPaths: Set<string>;
  viewerReadRoots?: SharedContainerViewerReadRoot[];
  viewerFileLocation?: { repoId: string; relativePath: string };
  approvedViewerFileUrl?: string;
}

function browserIsNavigating(state: LiveBrowserSession): boolean {
  return state.snapshot.loading || state.snapshot.status === 'loading';
}

interface BrowserSessionArtifacts {
  console: BrowserConsoleEntry[];
  network: BrowserNetworkEntry[];
  networkStartedAt: Map<string, number>;
  recordingSteps: BrowserRecordingStep[];
  attachmentPaths: Set<string>;
}

interface WorktreeBrowserState extends WorktreeBrowserLayoutState {
  projectId: string;
  worktreeId: string;
  snapshots: Map<string, BrowserSessionSnapshot>;
}

type BrowserNavigationHistory = WebContents['navigationHistory'];

type BrowserAutomationRetainedResponse = Omit<
  BrowserAutomationResponse,
  'browser'
>;

type BrowserAutomationRetainedOutcome =
  | { kind: 'response'; response: BrowserAutomationRetainedResponse }
  | BrowserAutomationRetainedUnknown;

interface BrowserAutomationRetainedUnknown extends BrowserPostDispatchUnknown {
  repeated?: true;
  dialog?: BrowserJavaScriptDialog;
  handledDialog?: BrowserHandleJavaScriptDialogResponse;
}

type BrowserAutomationRuntimeResult =
  | BrowserAutomationResponse
  | BrowserAutomationRetainedUnknown;

interface BrowserAutomationReplayEntry {
  fingerprint: string;
  outcome?: BrowserAutomationRetainedOutcome;
  pending?: Promise<BrowserAutomationRetainedOutcome>;
}

interface BrowserAutomationReplayStore {
  entries: Map<string, BrowserAutomationReplayEntry>;
}

function canonicalAutomationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalAutomationValue);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort())
    sorted[key] = canonicalAutomationValue(value[key]);
  return sorted;
}

function canonicalAutomationJson(value: unknown): string {
  return JSON.stringify(canonicalAutomationValue(value)) ?? 'undefined';
}

function browserAutomationTimeoutMs(
  command: Exclude<BrowserAutomationCommand, { kind: 'inspect' }>,
): number {
  // request_files waits for the user without a limit; this bounds its steps.
  if (command.kind === 'request_files') return REQUEST_FILES_STEP_TIMEOUT_MS;
  return (
    command.timeoutMs ??
    (command.kind === 'wait_for'
      ? 10_000
      : command.kind === 'upload_files' || command.kind === 'drop_files'
        ? UPLOAD_STAGING_WAIT_MS
        : 5_000)
  );
}

function browserAutomationFingerprint(
  command: Exclude<BrowserAutomationCommand, { kind: 'inspect' }>,
): string {
  const { actionId: ignoredActionId, ...fingerprintCommand } = command;
  void ignoredActionId;
  if (command.kind === 'click') {
    return canonicalAutomationJson({
      ...fingerprintCommand,
      timeoutMs: command.timeoutMs ?? 5_000,
      button: command.button ?? 'left',
      clickCount: command.clickCount ?? 1,
    });
  }
  if (command.kind === 'type')
    return canonicalAutomationJson({
      ...fingerprintCommand,
      timeoutMs: command.timeoutMs ?? 5_000,
      delayMs: command.delayMs ?? 0,
    });
  if (command.kind === 'drag')
    return canonicalAutomationJson({
      ...fingerprintCommand,
      timeoutMs: command.timeoutMs ?? 5000,
      steps: command.steps ?? 10,
    });
  if (
    command.kind === 'scroll' &&
    command.direction !== undefined &&
    command.pixels === undefined
  )
    return canonicalAutomationJson({
      ...fingerprintCommand,
      timeoutMs: command.timeoutMs ?? 5000,
      pages: command.pages ?? 1,
    });
  if (command.kind === 'wait_for') {
    return canonicalAutomationJson({
      ...fingerprintCommand,
      timeoutMs: command.timeoutMs ?? 10_000,
      state:
        command.locator !== undefined || command.text !== undefined
          ? (command.state ?? 'visible')
          : command.state,
    });
  }
  return canonicalAutomationJson(
    command.kind === 'request_files'
      ? fingerprintCommand
      : { ...fingerprintCommand, timeoutMs: command.timeoutMs ?? 5_000 },
  );
}

function compactBrowserAutomationResponse(
  response: BrowserAutomationResponse,
): BrowserAutomationRetainedOutcome {
  return {
    kind: 'response',
    response: {
      ...(response.runtimeGeneration !== undefined
        ? { runtimeGeneration: response.runtimeGeneration }
        : {}),
      ok: response.ok,
      ...(response.element ? { element: response.element } : {}),
      ...(response.handledDialog
        ? { handledDialog: response.handledDialog }
        : {}),
      ...(response.dialog ? { dialog: response.dialog } : {}),
      ...(response.completed !== undefined
        ? { completed: response.completed }
        : {}),
      ...(response.receipt ? { receipt: response.receipt } : {}),
      ...(response.waitFor ? { waitFor: response.waitFor } : {}),
      ...(response.error ? { error: response.error } : {}),
    },
  };
}

class BrowserDialogPendingError extends Error {
  constructor(readonly dialog: BrowserJavaScriptDialog) {
    super(
      `Browser JavaScript dialog is pending: ${dialog.type} ${JSON.stringify(
        dialog.message.slice(0, 200),
      )}. Use browser.handle_dialog to respond.`,
    );
    this.name = 'BrowserDialogPendingError';
  }
}

type BrowserConsoleCapture = Omit<
  BrowserConsoleEntry,
  'id' | 'browserId' | 'timestamp'
>;

export {
  getBrowserService,
  setBrowserService,
} from './browser-service-registry';

export interface BrowserServiceOptions {
  /** Legacy/default host used for non-App-Advisor projects. */
  getWindow: () => BrowserWindow | null;
  /** Selects the renderer window that owns a project's native browser views. */
  resolveHostWindow?: (projectId: string) => BrowserWindow | null;
  /**
   * Runs after a browser view joins a window's native views, so a view that
   * must stay on top there (the early access App Advisor panel) can re-raise.
   */
  onViewAttached?: (window: BrowserWindow) => void;
  profileAuthority?: BrowserProfileAuthority;
  /** Reads the browser retention experiment; defaults to main's Labs projection. */
  experimentalFeaturesEnabled?: () => boolean;
  /** The workspace root `browser.save_download` paths are relative to. */
  resolveWorkspaceRoot?: (scope: BrowserTaskFilesScope) => string;
  /** The native open dialog for a file chooser; the chosen paths, or none. */
  showOpenDialog?: (
    window: BrowserWindow | null,
    options: OpenDialogOptions,
  ) => Promise<string[]>;
  /** The files a chat's messages attached, by path; defaults to its transcript. */
  chatAttachmentPaths?: (
    chat: NonNullable<BrowserAutomationRequest['approvalChat']>,
  ) => Promise<string[]>;
  /** The folder a chat's attachments are kept in. */
  resolveAttachmentsFolder?: (
    chat: NonNullable<BrowserAutomationRequest['approvalChat']>,
  ) => string;
}

const FRAME_OWNER_NAMES = new Set([
  'IFRAME',
  'FRAME',
  'OBJECT',
  'EMBED',
  'FENCEDFRAME',
  'PORTAL',
]);

/**
 * Whether the browser's own hit test at `point` (the session's viewport)
 * finds a node of `frameId` that hosts no other frame, so a drop there
 * reaches that frame's document.
 */
async function dropLandsInFrame(
  send: (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<unknown>,
  sessionId: string,
  frameId: string,
  point: { x: number; y: number },
): Promise<boolean> {
  try {
    const hit = await nodeAtViewportPoint(send, sessionId, point);
    if (!hit || hit.frameId !== frameId) return false;
    const described = await send(
      'DOM.describeNode',
      { backendNodeId: hit.backendNodeId },
      sessionId || undefined,
    );
    const nodeName =
      isRecord(described) && isRecord(described.node)
        ? described.node.nodeName
        : undefined;
    return (
      typeof nodeName === 'string' &&
      !FRAME_OWNER_NAMES.has(nodeName.toUpperCase())
    );
  } catch {
    return false;
  }
}

/** The files the user attached to a chat, as its messages name them. */
async function transcriptAttachmentPaths(
  chat: NonNullable<BrowserAutomationRequest['approvalChat']>,
): Promise<string[]> {
  const messages = await readChatTranscript(
    chat.projectId,
    chat.worktreeId,
    chat.chatId,
  );
  return messages.flatMap((message) => [
    ...(message.attachmentPaths ?? []),
    ...(message.attachmentPromptContexts ?? []).map(
      (context) => context.attachmentPath,
    ),
  ]);
}

/** A file input as an upload or a file request attaches to it. */
type ResolvedFileInput = FileInputInfo & {
  sessionId: string;
  frameId: string;
  loaderId: string;
  frameOrigin: string;
  topOrigin: string;
  /** The pending chooser it came from, which ends once files are attached. */
  chooserId?: string;
  /** When that chooser opened, to tell whether the recording saw it open. */
  chooserOpenedAt?: number;
  /** While recording: the input's replayable locator, if it has one. */
  recordingLocator?: string;
};

/** A chooser an agent's action opened, with what the browser needs to answer it. */
interface PendingFileChooser extends BrowserFileChooser {
  sessionId: string;
  frameId: string;
  backendNodeId: number;
  loaderId: string;
  actionId: string;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingAuthRequest extends BrowserAuthRequest {
  /** Chromium's callbacks for the challenge, and any same-realm repeats. */
  callbacks: Array<(username?: string, password?: string) => void>;
  timer: ReturnType<typeof setTimeout>;
}

function authRequestDto(request: PendingAuthRequest): BrowserAuthRequest {
  return {
    id: request.id,
    browserId: request.browserId,
    ...(request.runtimeGeneration === undefined
      ? {}
      : { runtimeGeneration: request.runtimeGeneration }),
    origin: request.origin,
    ...(request.realm ? { realm: request.realm } : {}),
    isProxy: request.isProxy,
    openedAt: request.openedAt,
    expiresAt: request.expiresAt,
  };
}

/** A sign-in the user leaves unanswered is cancelled after this long. */
const AUTH_REQUEST_LIFETIME_MS = 5 * 60_000;
/** Effects keep this many popups and permission denials per browser. */
const ACTION_EFFECT_RECORD_LIMIT = 50;

/** A page's `print()` call while main reads its frame. */
interface PrintCall {
  sessionId: string;
  frameId: string;
  /** Its frame or the page navigated or went away meanwhile. */
  stale: boolean;
}

interface PendingPrintRequest extends BrowserPrintRequest {
  sessionId: string;
  frameId: string;
  actionId: string;
  timer: ReturnType<typeof setTimeout>;
}

function printRequestDto(request: PendingPrintRequest): BrowserPrintRequest {
  return {
    id: request.id,
    browserId: request.browserId,
    ...(request.runtimeGeneration === undefined
      ? {}
      : { runtimeGeneration: request.runtimeGeneration }),
    frameOrigin: request.frameOrigin,
    topOrigin: request.topOrigin,
    openedAt: request.openedAt,
    expiresAt: request.expiresAt,
  };
}

function fileChooserDto(chooser: PendingFileChooser): BrowserFileChooser {
  return {
    id: chooser.id,
    browserId: chooser.browserId,
    ...(chooser.runtimeGeneration === undefined
      ? {}
      : { runtimeGeneration: chooser.runtimeGeneration }),
    frameOrigin: chooser.frameOrigin,
    topOrigin: chooser.topOrigin,
    multiple: chooser.multiple,
    ...(chooser.directory ? { directory: true } : {}),
    ...(chooser.accept ? { accept: chooser.accept } : {}),
    openedAt: chooser.openedAt,
    expiresAt: chooser.expiresAt,
  };
}

/** A site's host for a prompt title; the origin itself when it has none. */
function originHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** A chosen file's size; a folder (from a folder input) counts as 0. */
function chosenFileSize(path: string): number {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function showNativeOpenDialog(
  window: BrowserWindow | null,
  options: OpenDialogOptions,
): Promise<string[]> {
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

const SNAPSHOT_PERSISTENCE_DELAY_MS = 250;
const SAVE_DOWNLOAD_TIMEOUT_MS = 30_000;
/** How long `upload_files` waits for staging before it reports progress. */
const UPLOAD_STAGING_WAIT_MS = 30_000;
const UPLOAD_ATTACH_TIMEOUT_MS = 30_000;
const REQUEST_FILES_STEP_TIMEOUT_MS = 30_000;
const PDF_NAME_LENGTH = 50;
const SAVE_PDF_TIMEOUT_MS = 30_000;
const SAVE_PDF_TIMEOUT_MAX_MS = 60_000;
const PDF_PAGE_SIZES = {
  letter: 'Letter',
  legal: 'Legal',
  a4: 'A4',
  a3: 'A3',
  tabloid: 'Tabloid',
} as const;
/** `save_pdf`'s request as Electron's print options: browser-use's set. */
function pdfOptions(
  request: BrowserSavePdfRequest,
): Parameters<WebContents['printToPDF']>[0] {
  const small = 'font-size: 8px; width: 100%; padding: 0 12px;';
  return {
    landscape: request.landscape ?? false,
    printBackground: request.printBackground ?? true,
    scale: request.scale ?? 1,
    pageSize: PDF_PAGE_SIZES[request.paperFormat ?? 'letter'],
    ...(request.pageRanges ? { pageRanges: request.pageRanges } : {}),
    displayHeaderFooter: request.displayHeaderFooter ?? false,
    ...(request.displayHeaderFooter
      ? {
          headerTemplate: `<div style="${small}"><span class="url"></span></div>`,
          footerTemplate: `<div style="${small} text-align: right;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
        }
      : {}),
    preferCSSPageSize: true,
  };
}
/** The same options under Playwright's `page.pdf()` names. */
function playwrightPdfOptions(
  request: BrowserSavePdfRequest,
): Record<string, unknown> {
  const { pageSize, ...options } = pdfOptions(request);
  return {
    landscape: options.landscape,
    printBackground: options.printBackground,
    scale: options.scale,
    format: pageSize,
    ...(options.pageRanges ? { pageRanges: options.pageRanges } : {}),
    displayHeaderFooter: options.displayHeaderFooter,
    ...(options.headerTemplate
      ? {
          headerTemplate: options.headerTemplate,
          footerTemplate: options.footerTemplate,
        }
      : {}),
    preferCSSPageSize: options.preferCSSPageSize,
  };
}
/**
 * Rejects when `promise` outlasts `ms` or `signal` aborts; the work itself
 * goes on.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const stop = (): void => rejectPromise(new Error('Cancelled.'));
    const timer = setTimeout(() => rejectPromise(new Error('Timed out.')), ms);
    signal.addEventListener('abort', stop, { once: true });
    promise
      .then(resolvePromise, (error: unknown) =>
        rejectPromise(
          error instanceof Error ? error : new Error(String(error)),
        ),
      )
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      });
  });
}
const FILE_INPUT_LEFT =
  'The file input left the page before the files were attached, so nothing was attached.';
const DROP_TARGET_LEFT =
  'The drop target left the page before the files were dropped, so nothing was dropped.';
/** How long a drop waits for its target to be reachable after approval. */
const DROP_TARGET_WAIT_MS = 5_000;
/** How long an action waits to report a chooser it opened that is still being read. */
const CHOOSER_REPORT_WAIT_MS = 1_000;
const SAVE_DOWNLOAD_MAX_TIMEOUT_MS = 120_000;
const COPY_CANCEL_WAIT_MS = 10_000;

/** Host operations a Files panel command may need. */
interface BrowserTransferHost {
  revealInFolder(path: string): void;
  /** Opens the save dialog with this file name. Undefined when dismissed. */
  chooseSavePath?(defaultName: string): Promise<string | undefined>;
}

function now(): number {
  return Date.now();
}

function uuid(): string {
  return randomUUID();
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}\0${worktreeId}`;
}

/** Key handling follows the host OS; an unsupported one behaves like Linux. */
function hostKeyPlatform(): NodeJS.Platform {
  return hostOperatingSystem() ?? 'linux';
}

function browserViewPreloadPath(): string {
  return join(__dirname, '../preload/browser-view.js');
}

function withoutElectronUserAgentToken(userAgent: string): string {
  return userAgent
    .split(/\s+/)
    .filter((product) => !/^Electron\/[^\s]+$/.test(product))
    .join(' ');
}

function toSnapshotForHydration(
  snapshot: BrowserSessionSnapshot,
): BrowserSessionSnapshot {
  return {
    ...snapshot,
    updatedAt: now(),
    status: 'idle',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    recording: false,
    pickMode: false,
  };
}

function updateSnapshot(
  session: LiveBrowserSession,
  patch: Partial<BrowserSessionSnapshot>,
): BrowserSessionSnapshot {
  session.snapshot = {
    ...session.snapshot,
    ...patch,
    updatedAt: now(),
  };
  return session.snapshot;
}

function pushRing<T>(items: T[], item: T, max: number): void {
  items.push(item);
  if (items.length > max) {
    items.splice(0, items.length - max);
  }
}

/** The inside of a single-quoted script literal: line breaks are escaped too. */
function escapePlaywrightString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildPlaywrightScript(steps: BrowserRecordingStep[]): string {
  const body = recordingScriptBody(steps);
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    "test('recorded browser flow', async ({ page }) => {",
    body
      .split('\n')
      .filter(Boolean)
      .map((line) => `  ${line}`)
      .join('\n'),
    '});',
  ].join('\n');
}

function recordingGotoStep(url: string): BrowserRecordingStep {
  return {
    id: uuid(),
    action: 'goto',
    value: url,
    playwright: `await page.goto('${escapePlaywrightString(url)}');`,
    timestamp: now(),
  };
}

function rectangleFromCapture(rect?: BrowserRectangle): Rectangle {
  return {
    x: Math.max(0, Math.round(rect?.x ?? 0)),
    y: Math.max(0, Math.round(rect?.y ?? 0)),
    width: Math.max(1, Math.round(rect?.width ?? 1)),
    height: Math.max(1, Math.round(rect?.height ?? 1)),
  };
}

/**
 * The zoom of the renderer a pane rectangle was measured in. The interface
 * scale is a page zoom (`lib/ui-zoom.ts`), so one CSS px of the host renderer
 * is `zoomFactor` window DIPs, which is what a native child view is
 * positioned in.
 */
function hostZoomFactor(win: BrowserWindow | null): number {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return 1;
  const factor = win.webContents.getZoomFactor();
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

function snapshotUrlFromWebContents(url: string, fallback: string): string {
  if (url === 'about:blank' && fallback.length === 0) {
    return '';
  }
  return url || fallback;
}

function uiSelectionFilename(browserId: string): string {
  return `ui-selection-${browserId}-${timestampForFilename()}-${uuid().slice(0, 8)}.png`;
}

function scopedFallbackMatches(
  state: LiveBrowserSession,
  request: { projectId?: string; worktreeId?: string },
): boolean {
  return (
    request.projectId !== undefined &&
    request.worktreeId !== undefined &&
    state.snapshot.projectId === request.projectId &&
    state.snapshot.worktreeId === request.worktreeId
  );
}

function normalizeStatusForLoadStart(): BrowserLoadStatus {
  return 'loading';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function browserCdpCommandError(command: string, cause: unknown): Error {
  if (cause instanceof Error) return cause;
  let detail: string;
  try {
    detail = JSON.stringify(cause) ?? String(cause);
  } catch {
    detail = String(cause);
  }
  return new Error(`Browser CDP command failed: ${command}: ${detail}`);
}

/**
 * WebContentsView does not expose Electron's internal owner-window hook in
 * its public types, so resolve and validate the method at runtime.
 */
function setWebContentsOwnerWindow(
  webContents: WebContents,
  window: BrowserWindow | null,
): void {
  const setOwnerWindow: unknown = Reflect.get(webContents, '_setOwnerWindow');
  if (typeof setOwnerWindow !== 'function') {
    throw new Error('Electron WebContents owner-window hook is unavailable.');
  }
  Reflect.apply(setOwnerWindow, webContents, [window]);
}

function attachElectronPrivateDialogEvents(
  webContents: WebContents,
  onRunDialog: (
    info: ElectronJavaScriptDialogInfo,
    callback: ElectronJavaScriptDialogCallback,
  ) => void,
  onCancelDialogs: () => void,
): void {
  const removeAllListeners: unknown = Reflect.get(
    webContents,
    'removeAllListeners',
  );
  const on: unknown = Reflect.get(webContents, 'on');
  if (typeof removeAllListeners !== 'function' || typeof on !== 'function') {
    throw new Error('Electron private dialog events are unavailable.');
  }
  Reflect.apply(removeAllListeners, webContents, ['-run-dialog']);
  Reflect.apply(on, webContents, ['-run-dialog', onRunDialog]);
  Reflect.apply(on, webContents, ['-cancel-dialogs', onCancelDialogs]);
}

function trustedBrowserFrameUrl(
  frameUrl: string | undefined,
  origin: string | undefined,
): string | null {
  for (const candidate of [frameUrl, origin]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (
        parsed.protocol === 'http:' ||
        parsed.protocol === 'https:' ||
        (parsed.protocol === 'file:' && parsed.hostname === '')
      ) {
        return parsed.href;
      }
    } catch {
      // Ignore opaque or malformed frame origins.
    }
  }
  return null;
}

function describeBrowserLoadFailure(
  errorCode: number,
  description: string,
  rawUrl: string,
): string {
  if (
    errorCode !== ERR_FILE_NOT_FOUND_CODE &&
    errorCode !== ERR_ACCESS_DENIED_CODE
  ) {
    return description;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:') return description;
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const encodedName = pathSegments[pathSegments.length - 1];
    const name = encodedName ? decodeURIComponent(encodedName) : 'local file';
    return errorCode === ERR_FILE_NOT_FOUND_CODE
      ? `Couldn't open ${name}. The file wasn't found.`
      : `Couldn't open ${name}. Access was denied.`;
  } catch {
    return description;
  }
}

function thrownBrowserLoadErrorCode(error: unknown): number | undefined {
  const description = error instanceof Error ? error.message : String(error);
  const errorRecord = isRecord(error) ? error : {};
  const explicitCode = errorRecord.errno;
  const matchedCode = /\((-?\d+)\)/.exec(description)?.[1];
  return typeof explicitCode === 'number'
    ? explicitCode
    : matchedCode !== undefined
      ? Number(matchedCode)
      : description.includes('ERR_FILE_NOT_FOUND')
        ? ERR_FILE_NOT_FOUND_CODE
        : description.includes('ERR_ACCESS_DENIED')
          ? ERR_ACCESS_DENIED_CODE
          : undefined;
}

function describeThrownBrowserLoadFailure(
  error: unknown,
  rawUrl: string,
): string {
  const description = error instanceof Error ? error.message : String(error);
  const errorCode = thrownBrowserLoadErrorCode(error);
  return errorCode === undefined
    ? description
    : describeBrowserLoadFailure(errorCode, description, rawUrl);
}

function browserJavaScriptDialogType(
  value: unknown,
): BrowserJavaScriptDialogType | null {
  switch (value) {
    case 'alert':
    case 'confirm':
    case 'prompt':
    case 'beforeunload':
      return value;
    default:
      return null;
  }
}

function appOwnedPromptBridgeScript(sourceUrl: string): string {
  const bridgeKey = JSON.stringify(APP_PROMPT_BRIDGE_KEY);
  const bridgeMarker = JSON.stringify(APP_PROMPT_BRIDGE_MARKER);
  return `(() => {
    const root = globalThis;
    if (root.prompt?.[${bridgeKey}] === ${bridgeMarker}) return;
    const replacement = function canopyAppOwnedPrompt(message, defaultPrompt) {
      const previousBridge = root[${bridgeKey}];
      const bridge = {
        marker: ${bridgeMarker},
        message: arguments.length > 0 ? String(message) : '',
        defaultPrompt: arguments.length > 1 ? String(defaultPrompt) : '',
        result: null,
      };
      root[${bridgeKey}] = bridge;
      debugger;
      const result = typeof bridge.result === 'string' ? bridge.result : null;
      if (root[${bridgeKey}] === bridge) {
        if (previousBridge === undefined) delete root[${bridgeKey}];
        else root[${bridgeKey}] = previousBridge;
      }
      return result;
    };
    Object.defineProperty(replacement, ${bridgeKey}, {
      value: ${bridgeMarker},
    });
    root.prompt = replacement;
  })()
//# sourceURL=${sourceUrl}`;
}

function runtimeStateFromPersisted(
  projectId: string,
  worktreeId: string,
  state: PersistedWorktreeBrowserStateFile,
): WorktreeBrowserState {
  return {
    projectId,
    worktreeId,
    browserOrder: [...state.browserOrder],
    activeBrowserId: state.activeBrowserId,
    snapshots: new Map(
      state.browsers.map((snapshot) => [
        snapshot.id,
        toSnapshotForHydration(snapshot),
      ]),
    ),
  };
}

function persistedStateFromRuntime(
  state: WorktreeBrowserState,
): PersistedWorktreeBrowserStateFile {
  return {
    version: 2,
    browserOrder: [...state.browserOrder],
    activeBrowserId: state.activeBrowserId,
    browsers: state.browserOrder.map((browserId) => {
      const snapshot = state.snapshots.get(browserId);
      if (!snapshot) {
        throw new Error(`Browser ${browserId} has no persisted snapshot.`);
      }
      return { ...snapshot };
    }),
  };
}

function cloneWorktreeState(state: WorktreeBrowserState): WorktreeBrowserState {
  return {
    ...state,
    browserOrder: [...state.browserOrder],
    snapshots: new Map(
      Array.from(state.snapshots, ([browserId, snapshot]) => [
        browserId,
        { ...snapshot },
      ]),
    ),
  };
}

function browserDisplayUrl(url: string): string | undefined {
  if (!url || url === 'about:blank') {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

function browserResourceLabel(snapshot: BrowserSessionSnapshot): string {
  const title = snapshot.title.trim();
  if (title.length > 0) {
    return title;
  }
  return browserDisplayUrl(snapshot.url) ?? 'In-app browser';
}

function consoleLevel(level: string): BrowserConsoleEntry['level'] {
  switch (level) {
    case 'warning':
    case 'error':
    case 'debug':
    case 'info':
      return level;
    default:
      return 'log';
  }
}

function navigationHistory(contents: WebContents): BrowserNavigationHistory {
  return contents.navigationHistory;
}

function canGoBack(contents: WebContents): boolean {
  return navigationHistory(contents).canGoBack();
}

function canGoForward(contents: WebContents): boolean {
  return navigationHistory(contents).canGoForward();
}

function goBack(contents: WebContents): void {
  navigationHistory(contents).goBack();
}

function goForward(contents: WebContents): void {
  navigationHistory(contents).goForward();
}

function isInternalBrowserConsoleNoise(entry: BrowserConsoleCapture): boolean {
  const source = entry.url ?? '';
  if (source.startsWith('node:electron/')) {
    return true;
  }
  return entry.text.includes('Electron Security Warning');
}

export class BrowserService {
  private dataRuntime?: BrowserProfileData;
  get profileData(): BrowserProfileData {
    return (this.dataRuntime ??= new BrowserProfileData(this));
  }
  readonly taskFiles = new BrowserTaskFiles({
    emit: (event): void => {
      if (event.type !== 'transfer' && event.type !== 'download-blocked')
        return;
      if (event.type === 'transfer') this.recordDownloadStep(event.transfer);
      const owner = this.findBrowserOwner(event.browserId);
      this.emit(
        event,
        this.sessions.get(event.browserId)?.hostWindow ??
          (owner
            ? (this.options.resolveHostWindow?.(owner.projectId) ??
              this.options.getWindow())
            : null),
      );
    },
    recordEvent: (scope, event): void => {
      getObservabilityService().recordSessionDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        sessionKey: `${scope.projectId}:${scope.worktreeId}:`,
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: '',
        providerType: 'unknown',
        ...event,
      });
    },
  });
  readonly downloads = new BrowserDownloads(
    (id) => this.findByWebContentsId(id)?.snapshot,
    undefined,
    this.taskFiles,
  );
  private localServersOnly = false;
  private shuttingDown = false;
  private userInteractionGeneration = 0;
  private readonly actionLanes = new ActionLaneRegistry();
  /** `save_pdf` prints still running, by download id, so they can be cancelled. */
  private readonly printing = new Map<
    string,
    { cancel: AbortController; done: Promise<void> }
  >();
  private readonly automationReplays = new WeakMap<
    ActionLane,
    BrowserAutomationReplayStore
  >();
  private readonly waitForControllers = new WeakMap<
    LiveBrowserSession,
    Set<AbortController>
  >();
  private readonly postDispatchUnknownResults = new WeakSet<object>();
  private readonly sessions = new Map<string, LiveBrowserSession>();
  private readonly worktreeStates = new Map<string, WorktreeBrowserState>();
  private readonly sessionArtifacts = new Map<
    string,
    BrowserSessionArtifacts
  >();
  private readonly destroying = new Map<string, Promise<void>>();
  /**
   * Tabs main asked the renderer to open for a page's new-window request,
   * until their session exists: the opener's profile, and whether an agent's
   * action caused it, so a create or its Retry keeps both.
   */
  private readonly popupTabs = new Map<
    string,
    { selection?: BrowserCreateRequest['selection']; agent: boolean }
  >();
  private readonly liveDisposals = new Map<string, Promise<void>>();
  private readonly persistenceQueues = new KeyedAsyncLock();
  private readonly mutationQueues = new KeyedAsyncLock();
  private readonly bindingCommits = new Map<string, Set<AbortController>>();
  private readonly profileRecoveries = new Map<
    string,
    Set<{ controller: AbortController; promise: Promise<void> }>
  >();
  private readonly rejectedWorktreeStates = new Map<string, string>();
  private readonly snapshotPersistenceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly preloadResultHandler = (
    event: IpcMainEvent,
    result: BrowserPreloadResult,
  ): void => {
    this.handlePreloadResult(event.sender.id, result);
  };
  private readonly preloadEventHandler = (
    event: IpcMainEvent,
    payload: BrowserPreloadEvent,
  ): void => {
    this.handlePreloadEvent(event.sender.id, payload);
  };

  constructor(private readonly options: BrowserServiceOptions) {
    this.downloads.setStartObserver((browserId, url): void =>
      this.noteDownloadStarted(browserId, url),
    );
    onPermissionDenied((contents, permission): void =>
      this.notePermissionDenied(contents, permission),
    );
    ipcMain.on(PRELOAD_RESULT_CHANNEL, this.preloadResultHandler);
    ipcMain.on(PRELOAD_EVENT_CHANNEL, this.preloadEventHandler);
    // The measurement hook is compile-time E2E-only and never routes reads.
    if (__CANOPY_E2E__) {
      globalThis.__CANOPY_E2E_BROWSER_PAGE_MODEL__ =
        this.pageModelMeasurementHook;
    }
  }

  setLocalServersOnly(enabled: boolean): void {
    this.localServersOnly = enabled;
  }

  getUserInteractionGeneration(): number {
    return this.userInteractionGeneration;
  }

  isUrlAllowedInApp(rawUrl: string): boolean {
    return isAllowedInAppBrowserUrl(rawUrl, this.localServersOnly);
  }

  private readonly creations = new Map<
    string,
    Promise<BrowserSessionSnapshot>
  >();
  private readonly creationAdmissions = new Map<
    string,
    Set<{ cancelled: boolean; taskKey: string }>
  >();
  private readonly pendingBrowserBindings = new Map<
    string,
    BrowserSessionSnapshot
  >();
  private readonly creationProfiles = new Map<string, string>();
  private readonly taskCreations = new Map<
    string,
    Set<Promise<BrowserSessionSnapshot>>
  >();

  // Carry the captured account through asynchronous dispatch helpers. Checking
  // only the returned result is too late for a queued click or navigation.
  private readonly runtimeCommand = new AsyncLocalStorage<{
    browserId: string;
    generation?: number;
    state?: LiveBrowserSession;
    rehydrate: boolean;
    dialog: boolean;
  }>();

  private assertCommandTarget(browserId: string): void {
    const command = this.runtimeCommand.getStore();
    if (!command) return;
    const state = this.sessions.get(browserId);
    const snapshot =
      state?.snapshot ??
      this.findBrowserOwner(browserId)?.snapshots.get(browserId);
    // Restoring a profiled session starts its next runtime generation. A
    // profile-less session (sign-in pages, shared-container viewers) has no
    // generation to advance, so it keeps none rather than expecting one.
    const expected =
      command.rehydrate && !command.state && state?.snapshot.profile
        ? (command.generation ?? 0) + 1
        : command.generation;
    if (
      command.browserId !== browserId ||
      (command.generation !== undefined &&
        snapshot?.profile?.runtimeGeneration !== expected) ||
      (command.state && state !== command.state)
    )
      throw new BrowserProfileError(
        'stale_runtime',
        'The browser changed before this command could run. Refresh the tab.',
      );
    if (!command.dialog && this.switching.has(browserId))
      throw new BrowserProfileError(
        'operation_conflict',
        'This tab has a pending profile switch.',
      );
    if (snapshot?.profile)
      this.assertProfileAvailable(snapshot.profile.resolvedProfileId);
    if (!command.state && state) {
      command.state = state;
      command.generation = expected;
    }
  }

  async withRuntimeTarget<T>(
    target: { browserId: string; expectedRuntimeGeneration?: number },
    operation: () => T | Promise<T>,
    options: {
      dialog?: boolean;
      presentation?: boolean;
      removesView?: boolean;
      rehydrate?: boolean;
    } = {},
  ): Promise<T> {
    const state = this.sessions.get(target.browserId);
    const owner = this.findBrowserOwner(target.browserId);
    const snapshot = state?.snapshot ?? owner?.snapshots.get(target.browserId);
    if (
      snapshot?.profile &&
      target.expectedRuntimeGeneration !== snapshot.profile.runtimeGeneration &&
      // The first generation has never changed, so omitting it is not stale.
      !(
        target.expectedRuntimeGeneration === undefined &&
        snapshot.profile.runtimeGeneration === 1
      )
    )
      throw new BrowserProfileError(
        'stale_runtime',
        target.expectedRuntimeGeneration === undefined
          ? 'expectedRuntimeGeneration is required for this tab. Pass profile.runtimeGeneration from the browser.open or browser.list result.'
          : 'The browser profile changed since expectedRuntimeGeneration was read. Call browser.list and use the tab’s current profile.runtimeGeneration.',
      );
    if (
      !options.dialog &&
      !options.presentation &&
      this.switching.has(target.browserId)
    )
      throw new BrowserProfileError(
        'operation_conflict',
        'This tab has a pending profile switch. Resolve its dialog or wait for completion.',
      );
    const generation = snapshot?.profile?.runtimeGeneration;
    const presentationRevision =
      options.presentation && state
        ? (state.presentationRevision += 1)
        : undefined;
    if (options.presentation && state) this.noteInputPresentation(state);
    // Experimental: presentation (bounds/visibility) only moves or hides a
    // live view whose profile was authorized when the view was created, and
    // profile retirement disposes that view. Re-resolving the profile here
    // costs several serialized registry reads per call, so the native view
    // lagged a frame-rate stream of resize and tab-switch updates.
    const skipPresentationAuthorization =
      options.presentation === true &&
      state !== undefined &&
      (this.options.experimentalFeaturesEnabled ?? ((): boolean => true))();
    if (snapshot?.profile) {
      this.assertProfileAvailable(snapshot.profile.resolvedProfileId);
    }
    if (snapshot?.profile && !skipPresentationAuthorization) {
      const authority =
        this.options.profileAuthority ?? getBrowserProfileService();
      await authority.resolve(
        snapshot.projectId,
        snapshot.worktreeId,
        snapshot,
      );
      const current = this.sessions.get(target.browserId);
      if (
        (state && current !== state) ||
        (current && current.snapshot.profile?.runtimeGeneration !== generation)
      )
        throw new BrowserProfileError(
          'stale_runtime',
          'The browser changed while the command was being authorized.',
        );
    }
    if (
      presentationRevision !== undefined &&
      state?.presentationRevision !== presentationRevision
    )
      throw new BrowserProfileError(
        'operation_conflict',
        'A newer presentation request replaced this command.',
      );
    // assertCommandTarget updates this admission when an inert view rehydrates.
    // Keep it independently of the session map: disposal removes that live view.
    const admission = {
      browserId: target.browserId,
      generation,
      state,
      rehydrate: options.rehydrate === true,
      dialog: options.dialog === true || options.presentation === true,
    };
    const result = await this.runtimeCommand.run(admission, operation);
    if (!options.removesView) {
      const current = this.sessions.get(target.browserId);
      const latest =
        current?.snapshot ??
        this.findBrowserOwner(target.browserId)?.snapshots.get(
          target.browserId,
        );
      const expected =
        options.rehydrate && !state && current
          ? (generation ?? 0) + 1
          : generation;
      if (
        isRecord(result) &&
        this.postDispatchUnknownResults.has(result) &&
        result.kind === 'post-dispatch-unknown' &&
        result.capturedRuntimeGeneration === (admission.generation ?? 0)
      )
        return result;
      if (
        (generation !== undefined &&
          latest?.profile?.runtimeGeneration !== expected) ||
        (state && current !== state && !options.rehydrate)
      )
        throw new BrowserProfileError(
          'stale_runtime',
          'The browser changed while this command was running. Its old result was discarded.',
        );
    }
    // Include the captured epoch on non-snapshot wire responses as well. The
    // broker's compound responses already include the browser snapshot.
    if (
      generation !== undefined &&
      !options.removesView &&
      result &&
      typeof result === 'object'
    ) {
      const stamp = (value: unknown): void => {
        if (isRecord(value) && !('ok' in value))
          value.runtimeGeneration =
            this.sessions.get(target.browserId)?.snapshot.profile
              ?.runtimeGeneration ?? generation;
      };
      if (Array.isArray(result)) result.forEach(stamp);
      else stamp(result);
      return result;
    }
    return result;
  }

  private readonly switchOperations = new Map<
    string,
    {
      digest: string;
      browserId: string;
      profileIds: Set<string>;
      promise: Promise<BrowserProfileSwitchResult>;
    }
  >();
  private readonly switching = new Map<string, AbortController>();
  private switchJournal(): BrowserSwitchJournal {
    return new BrowserSwitchJournal(
      join(getBrowserProfileService().dataRoot, 'browser-profile-switches'),
    );
  }

  async switchProfile(
    request: BrowserProfileSwitchRequest,
    actor: 'user' | 'agent' = 'user',
    signal?: AbortSignal,
  ): Promise<BrowserProfileSwitchResult> {
    signal?.throwIfAborted();
    if (
      !isProfileId(request.operationId) ||
      !isProfileId(request.browserId) ||
      !Number.isSafeInteger(request.expectedRuntimeGeneration) ||
      request.expectedRuntimeGeneration < 1 ||
      !isBrowserProfileSelection(request.selection) ||
      !['replace', 'new-tab'].includes(request.mode)
    )
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid profile switch request. Refresh the tab and try again.',
      );
    const digest = browserProfileSwitchDigest(request);
    const running = this.switchOperations.get(request.operationId);
    if (running) {
      if (running.digest !== digest)
        throw new BrowserProfileError(
          'operation_conflict',
          'The switch operation ID has different input.',
        );
      return actor === 'agent'
        ? this.switchResultOrDialog(request, running.promise)
        : running.promise;
    }
    const sourceProfileId = (
      this.sessions.get(request.browserId)?.snapshot.profile ??
      this.findBrowserOwner(request.browserId)?.snapshots.get(request.browserId)
        ?.profile
    )?.resolvedProfileId;
    const operation = this.performProfileSwitch(request, actor, signal);
    this.switchOperations.set(request.operationId, {
      digest,
      browserId: request.browserId,
      profileIds: new Set([
        ...(sourceProfileId ? [sourceProfileId] : []),
        ...(request.selection.kind === 'named'
          ? [request.selection.profileId]
          : []),
      ]),
      promise: operation,
    });
    void operation
      .finally(() => {
        this.switchOperations.delete(request.operationId);
      })
      .catch(() => undefined);
    return actor === 'agent'
      ? this.switchResultOrDialog(request, operation)
      : operation;
  }

  private async switchResultOrDialog(
    request: BrowserProfileSwitchRequest,
    operation: Promise<BrowserProfileSwitchResult>,
  ): Promise<BrowserProfileSwitchResult> {
    const state = this.sessions.get(request.browserId);
    if (!state) return operation;
    const pendingResult = (
      dialog: BrowserJavaScriptDialog,
    ): BrowserProfileSwitchResult => ({
      status: 'pending',
      operationId: request.operationId,
      browser: structuredClone(state.snapshot),
      dialog: { ...dialog },
      message:
        'Resolve this page dialog, then retry the same switch operation ID to collect its result.',
    });
    if (
      state.appBeforeUnloadDialog?.action.kind === 'profile-switch' &&
      state.pendingDialog
    )
      return pendingResult(state.pendingDialog);
    let listener: (dialog: BrowserJavaScriptDialog) => void = () => undefined;
    const dialog = new Promise<BrowserProfileSwitchResult>((resolve) => {
      listener = (value): void => resolve(pendingResult(value));
      state.pendingDialogWaiters.add(listener);
    });
    try {
      return await Promise.race([operation, dialog]);
    } finally {
      state.pendingDialogWaiters.delete(listener);
    }
  }

  hasLiveBrowser(browserId: string): boolean {
    return this.sessions.has(browserId);
  }

  private async performProfileSwitch(
    request: BrowserProfileSwitchRequest,
    actor: 'user' | 'agent',
    signal?: AbortSignal,
  ): Promise<BrowserProfileSwitchResult> {
    const journal = this.switchJournal();
    const previous = await journal.find(request);
    if (previous?.result) {
      const slot = await getBrowserProfileService().taskContext(
        previous.source.projectId,
        previous.source.worktreeId,
      );
      if (slot.incarnationId !== previous.source.profile?.taskIncarnationId)
        throw new BrowserProfileError(
          'scope_retired',
          'This switch belongs to a retired task incarnation. Refresh the current task.',
        );
      return previous.result;
    }
    if (previous)
      throw new BrowserProfileError(
        'recovery_required',
        'An interrupted switch needs tab recovery before retrying.',
      );
    if (this.switching.has(request.browserId))
      throw new BrowserProfileError(
        'operation_conflict',
        'This tab already has a pending profile switch.',
      );
    const owner = this.findBrowserOwner(request.browserId);
    const source = owner?.snapshots.get(request.browserId);
    if (!source?.profile)
      throw new BrowserProfileError(
        'profile_unavailable',
        'Refresh the existing tab before switching profiles.',
      );
    if (source.profile.runtimeGeneration !== request.expectedRuntimeGeneration)
      throw new BrowserProfileError(
        'stale_runtime',
        'The tab changed profiles. Refresh before issuing another command.',
      );
    this.assertProfileAvailable(source.profile.resolvedProfileId);
    this.switchOperations
      .get(request.operationId)
      ?.profileIds.add(source.profile.resolvedProfileId);
    const controller = new AbortController();
    const cancelFromCaller = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) cancelFromCaller();
    else signal?.addEventListener('abort', cancelFromCaller, { once: true });
    this.switching.set(request.browserId, controller);
    const authority =
      this.options.profileAuthority ?? getBrowserProfileService();
    let sourceState = this.sessions.get(request.browserId);
    try {
      const resolution = await authority.resolve(
        source.projectId,
        source.worktreeId,
        undefined,
        { selection: request.selection, actor },
      );
      this.switchOperations
        .get(request.operationId)
        ?.profileIds.add(resolution.profile.profileId);
      this.assertProfileAvailable(resolution.profile.profileId);
      resolution.binding.runtimeGeneration =
        request.mode === 'replace' ? source.profile.runtimeGeneration + 1 : 1;
      const target: BrowserSessionSnapshot = {
        ...toSnapshotForHydration(source),
        id: request.mode === 'replace' ? source.id : uuid(),
        profile: resolution.binding,
        taskScope: resolution.owner.scope,
        profileInfo: {
          displayName: resolution.profile.displayName,
          kind: resolution.profile.kind,
          color: resolution.profile.color,
          agentPermissions: resolution.profile.agentPermissions,
          metadataRevision: resolution.profile.metadataRevision,
        },
      };
      const sourceCopy = structuredClone(source);
      const record = await journal.begin(request, sourceCopy, target);
      const authorize = async (): Promise<void> => {
        if (controller.signal.aborted)
          throw new BrowserProfileError(
            'cancelled',
            'The owning task cancelled the profile switch.',
          );
        this.assertProfileAvailable(resolution.profile.profileId);
        await authority.assertActive(resolution);
      };
      const saveSnapshot = async (
        snapshot: BrowserSessionSnapshot,
        commitBinding?: BrowserStateCommit,
      ): Promise<void> => {
        await this.mutateBindingState(
          snapshot.projectId,
          snapshot.worktreeId,
          (next) => {
            next.snapshots.set(snapshot.id, { ...snapshot });
            if (!next.browserOrder.includes(snapshot.id))
              next.browserOrder.push(snapshot.id);
            return true;
          },
          commitBinding,
          commitBinding ? controller.signal : undefined,
        );
      };
      const result = await performBrowserProfileSwitch(journal, record, {
        allocate: async () => {
          this.downloads.observe(await authority.acquireSession(resolution));
          return this.allocateProfileView(resolution.partition);
        },
        discard: (view) => {
          if (!view.webContents.isDestroyed())
            view.webContents.close({ waitForBeforeUnload: false });
          return Promise.resolve();
        },
        authorize,
        closeSource: async () => {
          if (!sourceState) return true;
          const accepted = await this.closeSourceForProfileSwitch(
            sourceState,
            authorize,
            controller.signal,
          );
          if (accepted) {
            await this.disposeLiveViewInternal(source.id, false);
            sourceState = undefined;
          }
          return accepted;
        },
        commit: async (_view, saveDecision) => {
          let targetWritten = false;
          try {
            await saveSnapshot(target, async (write) => {
              const commit = async (): Promise<void> => {
                if (controller.signal.aborted)
                  throw new BrowserProfileError(
                    'cancelled',
                    'The owning task cancelled the profile switch.',
                  );
                this.assertProfileAvailable(resolution.profile.profileId);
                await write();
                targetWritten = true;
                await saveDecision();
              };
              if (authority.commitBinding)
                await authority.commitBinding(resolution, commit);
              else {
                await authorize();
                await commit();
              }
            });
          } catch (error) {
            // A replaced tab is restored by reloadSource. A new tab has its
            // own id, so nothing else removes a target that reached the file.
            if (request.mode === 'new-tab' && targetWritten)
              await this.withdrawUnconfirmedBinding(target, undefined);
            throw error;
          }
          resolution.agentEnableRequired = false;
        },
        openTarget: async (view) => {
          // Recorded attachments retain source ownership; only runtime observations reset.
          const artifacts = this.sessionArtifacts.get(target.id);
          if (artifacts) {
            artifacts.console.length = 0;
            artifacts.network.length = 0;
            artifacts.networkStartedAt.clear();
            artifacts.recordingSteps.length = 0;
          }
          return this.createSerialized(
            {
              projectId: target.projectId,
              worktreeId: target.worktreeId,
              browserId: target.id,
              url: sourceCopy.url,
              themeMode: sourceCopy.themeMode,
            },
            'user',
            { resolution, view },
          );
        },
        reloadSource: async () => {
          if (request.mode === 'new-tab') return sourceCopy;
          // Retirement can cancel a save queued behind its workspace lock.
          // Validate the original owner before attempting rollback persistence
          // so the retirement drain never waits for that same lock again.
          if (controller.signal.aborted)
            await authority.assertActive(
              await authority.resolve(
                source.projectId,
                source.worktreeId,
                sourceCopy,
              ),
            );
          const sourceBinding = sourceCopy.profile;
          if (!sourceBinding)
            throw new BrowserProfileError(
              'recovery_required',
              'The source profile binding is unavailable.',
            );
          const restored = {
            ...sourceCopy,
            profile: {
              ...sourceBinding,
              runtimeGeneration: sourceBinding.runtimeGeneration + 1,
            },
          };
          await saveSnapshot(restored);
          try {
            return await this.createSerialized({
              projectId: source.projectId,
              worktreeId: source.worktreeId,
              browserId: source.id,
              url: sourceCopy.url,
            });
          } catch (error) {
            restored.status = 'failed';
            restored.lastError =
              'The original profile needs recovery after a failed switch.';
            await saveSnapshot(restored);
            throw error;
          }
        },
      });
      return result;
    } finally {
      signal?.removeEventListener('abort', cancelFromCaller);
      this.switching.delete(request.browserId);
    }
  }

  private allocateProfileView(
    partition: string,
    privateSignIn = false,
  ): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: privateSignIn ? undefined : browserViewPreloadPath(),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        partition,
      },
    });
    registerIpcSurface(view.webContents, 'browser');
    view.webContents.setUserAgent(
      withoutElectronUserAgentToken(view.webContents.getUserAgent()),
    );
    return view;
  }

  private closeSourceForProfileSwitch(
    state: LiveBrowserSession,
    authorize: () => Promise<void>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (state.pendingDialog)
      throw new BrowserProfileError(
        'dialog_pending',
        'Resolve the current page dialog before switching profiles.',
      );
    const contents = state.view.webContents;
    if (contents.isDestroyed()) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (accepted: boolean, error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancelled);
        contents.removeListener('destroyed', destroyed);
        state.profileSwitchDecision = undefined;
        state.profileSwitchClosingAccepted = false;
        if (state.appBeforeUnloadDialog?.action.kind === 'profile-switch') {
          const dialogId = state.appBeforeUnloadDialog.dialogId;
          state.appBeforeUnloadDialog = undefined;
          state.pendingDialog = undefined;
          this.emit({
            type: 'dialog-closed',
            runtimeGeneration: state.snapshot.profile?.runtimeGeneration,
            browserId: state.snapshot.id,
            dialogId,
          });
        }
        state.pendingBeforeUnloadAction = undefined;
        if (error)
          reject(
            error instanceof Error
              ? error
              : new Error(
                  'The source page could not close for the profile switch.',
                ),
          );
        else resolve(accepted);
      };
      const cancelled = (): void => finish(false);
      const destroyed = (): void => finish(true);
      signal.addEventListener('abort', cancelled, { once: true });
      contents.once('destroyed', destroyed);
      state.profileSwitchDecision = (accept): void => {
        if (!accept) {
          finish(false);
          return;
        }
        // The original native veto must settle before a second close is issued.
        setImmediate(() => {
          void authorize()
            .then(() => {
              if (settled) return;
              clearTimeout(timeout);
              timeout = setTimeout(
                () =>
                  finish(
                    false,
                    new BrowserProfileError(
                      'storage_unavailable',
                      'The source page did not close.',
                    ),
                  ),
                5_000,
              );
              state.allowNextBeforeUnload = true;
              state.profileSwitchClosingAccepted = true;
              contents.close({ waitForBeforeUnload: true });
            })
            .catch((error) => finish(false, error));
        });
      };
      timeout = setTimeout(() => finish(false), 300_000);
      state.pendingBeforeUnloadAction = { kind: 'profile-switch' };
      void authorize()
        .then(() => {
          if (!settled) contents.close({ waitForBeforeUnload: true });
        })
        .catch((error) => finish(false, error));
    });
  }

  private async recoverProfileSwitches(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    if (
      this.options.profileAuthority ||
      isMcpOAuthBrowserScope(projectId, worktreeId)
    )
      return;
    // Register before the first journal read. Removal can begin while an open
    // is still recovering, before it appears in taskCreations or bindingCommits.
    const key = worktreeKey(projectId, worktreeId);
    const controller = new AbortController();
    const recovery = {
      controller,
      promise: Promise.resolve().then(() =>
        this.recoverProfileSwitchesForTask(
          projectId,
          worktreeId,
          controller.signal,
        ),
      ),
    };
    const pending =
      this.profileRecoveries.get(key) ?? new Set<typeof recovery>();
    pending.add(recovery);
    this.profileRecoveries.set(key, pending);
    try {
      await recovery.promise;
    } finally {
      pending.delete(recovery);
      if (pending.size === 0) this.profileRecoveries.delete(key);
    }
  }

  private async recoverProfileSwitchesForTask(
    projectId: string,
    worktreeId: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const journal = this.switchJournal();
    const records = await journal.pending(projectId, worktreeId);
    signal.throwIfAborted();
    for (const record of records) {
      signal.throwIfAborted();
      if (this.switchOperations.has(record.operationId)) continue;
      const slot = await getBrowserProfileService().taskContext(
        projectId,
        worktreeId,
      );
      signal.throwIfAborted();
      if (slot.incarnationId !== record.source.profile?.taskIncarnationId) {
        // The decision belongs to an earlier owner. Preserve the current task's
        // binding; an old journal is never authority to restore retired storage.
        await journal.update(record, 'aborted', {
          status: 'cancelled',
          browser: record.source,
        });
        continue;
      }
      const targetCommitted = record.stage === 'target_committed';
      const selected = targetCommitted ? record.target : record.source;
      await this.mutateBindingState(
        projectId,
        worktreeId,
        (state) => {
          const current = state.snapshots.get(record.target.id);
          if (
            current?.profile &&
            current.profile.runtimeGeneration >
              (record.target.profile?.runtimeGeneration ?? 0)
          )
            return false;
          if (record.mode === 'new-tab' && !targetCommitted) {
            state.snapshots.delete(record.target.id);
            state.browserOrder = state.browserOrder.filter(
              (id) => id !== record.target.id,
            );
            return true;
          }
          state.snapshots.set(selected.id, { ...selected });
          if (!state.browserOrder.includes(selected.id))
            state.browserOrder.push(selected.id);
          return true;
        },
        undefined,
        signal,
      );
      signal.throwIfAborted();
      await journal.update(record, targetCommitted ? 'complete' : 'aborted', {
        status: targetCommitted ? 'complete' : 'cancelled',
        browser: selected,
      });
    }
  }

  private readonly profileFences = new Set<string>();
  private readonly maintenanceFences = new Set<string>();

  setMaintenanceFence(profileId: string, enabled: boolean): void {
    if (enabled) {
      if (
        Array.from(this.switchOperations.values()).some((operation) =>
          operation.profileIds.has(profileId),
        )
      )
        throw new BrowserProfileError(
          'operation_conflict',
          'Finish or cancel this profile’s pending switch before clearing its data.',
        );
      if (this.profileFences.has(profileId))
        throw new BrowserProfileError(
          'operation_conflict',
          'This profile is being changed. Wait for the operation to finish.',
        );
      this.maintenanceFences.add(profileId);
    } else this.maintenanceFences.delete(profileId);
  }

  async drainProfileCreations(profileId: string): Promise<void> {
    // Unresolved creations have not passed profile admission yet. They will
    // observe the fence after resolving; only admitted work needs draining.
    await Promise.allSettled([
      ...Array.from(this.creations.entries())
        .filter(
          ([browserId]) => this.creationProfiles.get(browserId) === profileId,
        )
        .map(([, operation]) => operation),
    ]);
  }

  captureProfileViews(profileId: string): {
    snapshot: BrowserSessionSnapshot;
    bounds: Rectangle;
    visible: boolean;
    cornerRadii: BrowserCornerRadii;
  }[] {
    return Array.from(this.sessions.values())
      .filter(
        (state) => state.snapshot.profile?.resolvedProfileId === profileId,
      )
      .map((state) => ({
        snapshot: structuredClone(state.snapshot),
        bounds: { ...state.bounds },
        visible: state.visible,
        cornerRadii: { ...state.cornerRadii },
      }));
  }

  async resumeProfileViews(
    tabs: ReturnType<BrowserService['captureProfileViews']>,
  ): Promise<void> {
    let next = 0;
    const resume = async (): Promise<void> => {
      while (next < tabs.length) {
        const tab = tabs[next++];
        const { snapshot } = tab;
        if (!snapshot.profile) continue;
        try {
          await this.create(
            {
              browserId: snapshot.id,
              projectId: snapshot.projectId,
              worktreeId: snapshot.worktreeId,
              themeMode: snapshot.themeMode,
            },
            'user',
            snapshot.profile,
          );
          this.setBounds({
            browserId: snapshot.id,
            bounds: tab.bounds,
            visible: tab.visible,
            cornerRadii: tab.cornerRadii,
          });
          this.setVisible(snapshot.id, tab.visible);
        } catch {
          // A task may retire during maintenance. Never recreate its owner or account.
        }
      }
    };
    // Bound native view allocation without letting one slow page delay every tab.
    await Promise.all(Array.from({ length: Math.min(4, tabs.length) }, resume));
  }

  async rebindProfileViews(
    preview: BrowserClearPreview,
    generation: number,
  ): Promise<void> {
    const profile = await getBrowserProfileService().repository.get(
      preview.profileId,
    );
    if (profile.storageGeneration !== generation)
      throw new BrowserProfileError(
        'profile_unavailable',
        'The profile changed before its tabs could be restored.',
      );
    for (const tab of preview.tabs) {
      let snapshot: BrowserSessionSnapshot | undefined;
      await this.mutateWorktreeState(tab.projectId, tab.worktreeId, (state) => {
        const current = state.snapshots.get(tab.browserId);
        if (
          current?.profile?.resolvedProfileId !== preview.profileId ||
          !tab.taskIncarnationId ||
          current.profile.taskIncarnationId !== tab.taskIncarnationId
        )
          return false;
        if (
          current.profile.storageGeneration === generation &&
          current.profile.runtimeGeneration === tab.runtimeGeneration + 1
        )
          return false;
        if (
          current.profile.storageGeneration !== preview.storageGeneration ||
          current.profile.runtimeGeneration !== tab.runtimeGeneration
        )
          throw new BrowserProfileError(
            'stale_runtime',
            'An affected browser tab changed before maintenance completed.',
          );
        snapshot = {
          ...current,
          profile: {
            ...current.profile,
            storageGeneration: generation,
            runtimeGeneration: tab.runtimeGeneration + 1,
          },
          profileInfo: {
            displayName: profile.displayName,
            kind: profile.kind,
            color: profile.color,
            metadataRevision: profile.metadataRevision,
            agentPermissions: profile.agentPermissions,
          },
          loading: false,
          status: 'idle',
          recording: false,
          pickMode: false,
          lastError: undefined,
        };
        state.snapshots.set(tab.browserId, snapshot);
        return true;
      });
      if (snapshot)
        this.emit(
          {
            type: 'snapshot',
            browserId: tab.browserId,
            snapshot,
            runtimeGeneration: snapshot.profile?.runtimeGeneration,
          },
          this.resolveHostWindow(tab.projectId),
        );
    }
  }

  matchesScratchOwner(owner: BrowserScratchOwner): boolean {
    const state = this.sessions.get(owner.browserId);
    return (
      !!state &&
      this.isCurrentLiveSession(state) &&
      this.snapshotMatchesScratch(state.snapshot, owner)
    );
  }
  private snapshotMatchesScratch(
    snapshot: BrowserSessionSnapshot,
    owner: BrowserScratchOwner,
  ): boolean {
    const binding = snapshot.profile;
    return (
      binding?.resolvedProfileId === owner.profileId &&
      binding.storageGeneration === owner.storageGeneration &&
      binding.runtimeGeneration === owner.runtimeGeneration &&
      binding.taskIncarnationId === owner.taskIncarnationId &&
      !!snapshot.taskScope &&
      JSON.stringify(snapshot.taskScope) === JSON.stringify(owner.taskScope)
    );
  }
  async scratchOwnerSnapshot(
    owner: BrowserScratchOwner,
    allowPersisted: boolean,
  ): Promise<BrowserSessionSnapshot | undefined> {
    if (!allowPersisted)
      return this.matchesScratchOwner(owner)
        ? this.sessions.get(owner.browserId)?.snapshot
        : undefined;
    const ids = browserTaskOwnerIds(owner.taskScope);
    const loaded = await loadWorktreeBrowserStateAsync(
      ids.projectId,
      ids.worktreeId,
    );
    const snapshot =
      loaded.status === 'loaded'
        ? loaded.state.browsers.find((tab) => tab.id === owner.browserId)
        : undefined;
    return snapshot && this.snapshotMatchesScratch(snapshot, owner)
      ? snapshot
      : undefined;
  }

  assertProfileAvailable(profileId: string): void {
    if (this.shuttingDown)
      throw new BrowserProfileError(
        'cancelled',
        'The browser is shutting down.',
      );
    if (
      this.profileFences.has(profileId) ||
      this.maintenanceFences.has(profileId)
    )
      throw new BrowserProfileError(
        'operation_conflict',
        'This profile is being changed. Wait for the operation to finish.',
      );
  }

  async withProfileFence<T>(
    profileId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertProfileAvailable(profileId);
    this.profileFences.add(profileId);
    try {
      await Promise.allSettled(Array.from(this.creations.values()));
      return await operation();
    } finally {
      this.profileFences.delete(profileId);
    }
  }

  async profileUsage(profileId: string): Promise<BrowserProfileUsage> {
    const slots = await getBrowserProfileService().repository.listTaskSlots();
    const tabs = new Map<string, BrowserProfileUsage['tabs'][number]>();
    const defaults: BrowserProfileUsage['defaults'] = [];
    for (const slot of slots) {
      if (slot.lifecycle !== 'active') continue;
      if (
        slot.defaultSelection.kind === 'named' &&
        slot.defaultSelection.profileId === profileId
      )
        defaults.push(slot.scope);
      const { projectId, worktreeId } = browserTaskOwnerIds(slot.scope);
      const key = worktreeKey(projectId, worktreeId);
      const rejected = this.rejectedWorktreeStates.get(key);
      if (rejected !== undefined)
        throw new BrowserProfileError('recovery_required', rejected);
      const memory = this.worktreeStates.get(key);
      const loaded = memory
        ? null
        : await loadWorktreeBrowserStateAsync(projectId, worktreeId);
      if (loaded?.status === 'fallback' || loaded?.status === 'rejected')
        throw new BrowserProfileError('recovery_required', loaded.error);
      const snapshots = memory
        ? Array.from(memory.snapshots.values())
        : loaded?.status === 'loaded'
          ? loaded.state.browsers
          : [];
      for (const snapshot of snapshots)
        if (snapshot.profile?.resolvedProfileId === profileId)
          tabs.set(snapshot.id, {
            browserId: snapshot.id,
            projectId,
            worktreeId,
            runtimeGeneration: snapshot.profile.runtimeGeneration,
            taskIncarnationId: snapshot.profile.taskIncarnationId,
          });
    }
    for (const { snapshot } of Array.from(this.sessions.values()))
      if (snapshot.profile?.resolvedProfileId === profileId)
        tabs.set(snapshot.id, {
          browserId: snapshot.id,
          projectId: snapshot.projectId,
          worktreeId: snapshot.worktreeId,
          runtimeGeneration: snapshot.profile.runtimeGeneration,
          taskIncarnationId: snapshot.profile.taskIncarnationId,
        });
    return {
      tabs: Array.from(tabs.values()).sort((a, b) =>
        a.browserId.localeCompare(b.browserId),
      ),
      defaults,
    };
  }

  refreshProfileMetadata(profile: BrowserProfileRecord): Promise<void> {
    for (const state of Array.from(this.sessions.values())) {
      if (state.snapshot.profile?.resolvedProfileId !== profile.profileId)
        continue;
      state.snapshot.profileInfo = {
        displayName: profile.displayName,
        kind: profile.kind,
        color: profile.color,
        agentPermissions: profile.agentPermissions,
        metadataRevision: profile.metadataRevision,
      };
      this.emitSnapshot(state);
    }
    return Promise.resolve();
  }

  async markProfileUnavailable(profileId: string): Promise<void> {
    for (const tab of (await this.profileUsage(profileId)).tabs) {
      let snapshot: BrowserSessionSnapshot | undefined;
      await this.mutateWorktreeState(tab.projectId, tab.worktreeId, (state) => {
        const current = state.snapshots.get(tab.browserId);
        if (current?.profile?.resolvedProfileId !== profileId) return false;
        snapshot = {
          ...current,
          profileInfo: undefined,
          status: 'failed',
          loading: false,
          lastError:
            'This browser profile was deleted. Choose another profile to use this tab.',
        };
        state.snapshots.set(tab.browserId, snapshot);
        return true;
      });
      if (snapshot)
        this.emit(
          {
            type: 'load-failed',
            browserId: tab.browserId,
            snapshot,
            runtimeGeneration: snapshot.profile?.runtimeGeneration,
          },
          this.resolveHostWindow(tab.projectId),
        );
    }
  }

  async disposeProfileViews(profileId: string): Promise<void> {
    this.downloads.cancelProfile(profileId);
    await Promise.all(
      Array.from(this.sessions.values())
        .filter(
          (state) => state.snapshot.profile?.resolvedProfileId === profileId,
        )
        .map((state) => this.disposeLiveViewInternal(state.snapshot.id, false)),
    );
  }

  async create(
    request: BrowserCreateRequest,
    actor: 'user' | 'agent' = 'user',
    // Main-owned maintenance identity, never read from caller request fields.
    restoreBinding?: BrowserProfileResolution['binding'],
  ): Promise<BrowserSessionSnapshot> {
    const popup =
      request.browserId === undefined
        ? undefined
        : this.popupTabs.get(request.browserId);
    if (!popup) return this.createSession(request, actor, restoreBinding);
    // An agent's popup tab is the agent's new tab: its profile must allow it.
    const snapshot = await this.createSession(
      { ...request, selection: request.selection ?? popup.selection },
      popup.agent ? 'agent' : actor,
      restoreBinding,
    );
    this.popupTabs.delete(snapshot.id);
    return snapshot;
  }

  private async createSession(
    request: BrowserCreateRequest,
    actor: 'user' | 'agent',
    restoreBinding?: BrowserProfileResolution['binding'],
  ): Promise<BrowserSessionSnapshot> {
    const browserId = request.browserId ?? uuid();
    return this.withCreationAdmission(
      browserId,
      worktreeKey(request.projectId, request.worktreeId),
      async (assertCreationCurrent) => {
        // Transient consent pages never join the persistent profile registry.
        if (!isProfilelessBrowserScope(request.projectId, request.worktreeId)) {
          if (!this.options.profileAuthority)
            await this.profileData.ensureReady();
          assertCreationCurrent();
          await this.recoverProfileSwitches(
            request.projectId,
            request.worktreeId,
          );
        }
        assertCreationCurrent();
        if (request.browserId && this.switching.has(request.browserId))
          throw new BrowserProfileError(
            'operation_conflict',
            'This tab has a pending profile switch.',
          );
        const operation = (this.creations.get(browserId) ?? Promise.resolve())
          .catch(() => undefined)
          .then(() =>
            this.createSerialized(
              { ...request, browserId },
              actor,
              undefined,
              restoreBinding,
              assertCreationCurrent,
            ),
          );
        this.creations.set(browserId, operation);
        const key = worktreeKey(request.projectId, request.worktreeId);
        const pending =
          this.taskCreations.get(key) ??
          new Set<Promise<BrowserSessionSnapshot>>();
        pending.add(operation);
        this.taskCreations.set(key, pending);
        try {
          return await operation;
        } finally {
          if (this.creations.get(browserId) === operation) {
            this.creations.delete(browserId);
            this.creationProfiles.delete(browserId);
          }
          pending.delete(operation);
          if (pending.size === 0) this.taskCreations.delete(key);
        }
      },
    );
  }

  private async withCreationAdmission<T>(
    browserId: string,
    taskKey: string,
    operation: (assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    // Keep cancellation alive across destroy's completion without retaining closed IDs.
    const admission = { cancelled: false, taskKey };
    const pending = this.creationAdmissions.get(browserId) ?? new Set();
    pending.add(admission);
    this.creationAdmissions.set(browserId, pending);
    try {
      return await operation(() => {
        if (admission.cancelled)
          throw new BrowserProfileError(
            'stale_runtime',
            'This tab was closed while it was opening.',
          );
      });
    } finally {
      pending.delete(admission);
      if (pending.size === 0) this.creationAdmissions.delete(browserId);
    }
  }

  private async createSerialized(
    request: BrowserCreateRequest,
    actor: 'user' | 'agent' = 'user',
    prepared?: { resolution: BrowserProfileResolution; view: WebContentsView },
    restoreBinding?: BrowserProfileResolution['binding'],
    assertCreationCurrent?: () => void,
  ): Promise<BrowserSessionSnapshot> {
    if (!assertCreationCurrent) {
      const browserId = request.browserId ?? uuid();
      return this.withCreationAdmission(
        browserId,
        worktreeKey(request.projectId, request.worktreeId),
        (assertCurrent) =>
          this.createSerialized(
            { ...request, browserId },
            actor,
            prepared,
            restoreBinding,
            assertCurrent,
          ),
      );
    }
    assertCreationCurrent();
    if (request.browserId) this.assertCommandTarget(request.browserId);
    if (request.browserId && this.destroying.has(request.browserId)) {
      throw new Error(`Browser ${request.browserId} is being destroyed.`);
    }
    const existing =
      request.browserId !== undefined
        ? this.sessions.get(request.browserId)
        : undefined;
    if (existing) {
      if (existing.snapshot.profile) {
        this.assertProfileAvailable(
          existing.snapshot.profile.resolvedProfileId,
        );
        if (this.creations.has(existing.snapshot.id))
          this.creationProfiles.set(
            existing.snapshot.id,
            existing.snapshot.profile.resolvedProfileId,
          );
      }
      this.assertRestoreBinding(existing.snapshot.profile, restoreBinding);
      if (
        request.selection &&
        (request.selection.kind !== existing.snapshot.profile?.selection.kind ||
          (request.selection.kind === 'named' &&
            request.selection.profileId !==
              existing.snapshot.profile?.resolvedProfileId))
      )
        throw new BrowserProfileError(
          'invalid_request',
          'Use profile switching to change an existing tab.',
        );
      if (
        existing.snapshot.projectId !== request.projectId ||
        existing.snapshot.worktreeId !== request.worktreeId
      ) {
        throw new Error(
          `Browser ${existing.snapshot.id} does not belong to the supplied project/worktree.`,
        );
      }
      const normalizedUrl =
        request.url !== undefined ? normalizeBrowserUrlInput(request.url) : '';
      if (
        normalizedUrl &&
        normalizedUrl !== 'about:blank' &&
        !this.holdsInitialLoad(existing, normalizedUrl) &&
        (!sameBrowserUrl(normalizedUrl, existing.snapshot.url) ||
          !sameBrowserUrl(existing.view.webContents.getURL(), normalizedUrl)) &&
        this.isUrlAllowedInApp(normalizedUrl)
      ) {
        const result = await this.navigate({
          browserId: existing.snapshot.id,
          url: normalizedUrl,
        });
        assertCreationCurrent();
        this.assertCurrentLiveSession(existing);
        return result;
      }
      return existing.snapshot;
    }

    const worktreeState = this.ensureWorktreeState(
      request.projectId,
      request.worktreeId,
    );
    const rejected = this.rejectedWorktreeStates.get(
      worktreeKey(request.projectId, request.worktreeId),
    );
    if (rejected !== undefined)
      throw new BrowserProfileError('recovery_required', rejected);
    const browserId = request.browserId ?? uuid();
    const owner = this.findBrowserOwner(browserId);
    if (
      owner &&
      (owner.projectId !== request.projectId ||
        owner.worktreeId !== request.worktreeId)
    ) {
      throw new Error(
        `Browser ${browserId} does not belong to the supplied project/worktree.`,
      );
    }
    const persistedSnapshot = worktreeState.snapshots.get(browserId);
    this.assertRestoreBinding(persistedSnapshot?.profile, restoreBinding);
    const createdAt = now();
    const privateSignIn = isMcpOAuthBrowserScope(
      request.projectId,
      request.worktreeId,
    );
    const profileless = isProfilelessBrowserScope(
      request.projectId,
      request.worktreeId,
    );
    if (privateSignIn && request.selection)
      throw new BrowserProfileError(
        'invalid_request',
        'Sign-in pages do not use browser profiles.',
      );
    const profileAuthority =
      this.options.profileAuthority ?? getBrowserProfileService();
    const resolution = profileless
      ? undefined
      : (prepared?.resolution ??
        (await profileAuthority.resolve(
          request.projectId,
          request.worktreeId,
          persistedSnapshot,
          { selection: request.selection, actor },
        )));
    assertCreationCurrent();
    this.assertRestoreBinding(resolution?.binding, restoreBinding);
    if (resolution) {
      if (this.creations.has(browserId))
        this.creationProfiles.set(browserId, resolution.profile.profileId);
      this.assertProfileAvailable(resolution.profile.profileId);
    }
    await this.taskFiles.bind({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
    });
    assertCreationCurrent();
    const partition =
      resolution?.partition ??
      profilelessBrowserPartition(request.projectId, request.worktreeId);
    if (resolution) {
      const nativeSession = await profileAuthority.acquireSession(resolution);
      assertCreationCurrent();
      this.downloads.observe(nativeSession);
    } else {
      const nativeSession = session.fromPartition(partition);
      nativeSession.setPermissionRequestHandler(denyPermission);
      nativeSession.setPermissionCheckHandler(() => false);
      if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
        nativeSession.webRequest.onBeforeRequest(
          { urls: ['file://*/*'] },
          (details, callback) => {
            let absolutePath: string;
            try {
              absolutePath = fileURLToPath(details.url);
            } catch {
              callback({ cancel: true });
              return;
            }
            void assertSharedContainerViewerFileForRead(
              request.worktreeId,
              absolutePath,
            ).then(
              () => callback({ cancel: false }),
              () => callback({ cancel: true }),
            );
          },
        );
      }
    }
    const view =
      prepared?.view ?? this.allocateProfileView(partition, privateSignIn);
    const snapshot: BrowserSessionSnapshot = persistedSnapshot
      ? {
          ...toSnapshotForHydration(persistedSnapshot),
          ...(request.themeMode ? { themeMode: request.themeMode } : {}),
        }
      : {
          id: browserId,
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          createdAt,
          updatedAt: createdAt,
          url: '',
          title: '',
          status: 'idle',
          canGoBack: false,
          canGoForward: false,
          loading: false,
          themeMode: request.themeMode ?? 'light',
          pickMode: false,
          recording: false,
        };
    if (resolution) {
      snapshot.profile = resolution.binding;
      snapshot.profileInfo = {
        displayName: resolution.profile.displayName,
        kind: resolution.profile.kind,
        color: resolution.profile.color,
        metadataRevision: resolution.profile.metadataRevision,
        agentPermissions: resolution.profile.agentPermissions,
      };
      snapshot.taskScope = resolution.owner.scope;
    }
    const artifacts =
      this.sessionArtifacts.get(browserId) ?? this.createSessionArtifacts();
    this.sessionArtifacts.set(browserId, artifacts);
    const sessionState: LiveBrowserSession = {
      snapshot,
      view,
      viewFrame: createBrowserViewFrame(view),
      hostWindow: this.resolveHostWindow(request.projectId),
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      visible: false,
      cornerRadii: { ...SQUARE_CORNERS },
      console: artifacts.console,
      network: artifacts.network,
      networkStartedAt: artifacts.networkStartedAt,
      inflightRequestIds: new Set(),
      lastNetworkActivityAt: undefined,
      recordingSteps: artifacts.recordingSteps,
      navigationSequence: 0,
      presentationRevision: 0,
      navigationChainAllowsFileTargets: false,
      pendingCommands: new Map(),
      pendingDialogWaiters: new Set(),
      allowNextBeforeUnload: false,
      appPromptBridgeSourceUrl: `canopy://browser-app-prompt/${uuid()}.js`,
      pendingAppPromptBridgeSourceUrls: new Set(),
      appPromptBridgeScriptIds: new Map(),
      executionContextFrames: new Map(),
      frameUrls: new Map(),
      observationSessions: new Set(),
      mainFrameNavigation: new MainFrameNavigationGate(),
      pageModel: new PageModelHost({
        now: Date.now,
        send: (method, params, sessionId): Promise<unknown> => {
          const debug = view.webContents.debugger;
          return sessionId
            ? debug.sendCommand(method, params, sessionId)
            : debug.sendCommand(method, params);
        },
      }),
      attachmentPaths: artifacts.attachmentPaths,
      ...(request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID
        ? {
            viewerReadRoots: await resolveSharedContainerViewerReadRoots(
              request.worktreeId,
            ),
          }
        : {}),
    };
    try {
      if (!prepared && resolution) {
        this.assertProfileAvailable(resolution.profile.profileId);
        await this.mutateBindingState(
          request.projectId,
          request.worktreeId,
          (nextState) => {
            assertCreationCurrent();
            this.assertRestoreBinding(
              nextState.snapshots.get(browserId)?.profile,
              restoreBinding,
            );
            // First binding ownership is not published until its save completes.
            this.pendingBrowserBindings.set(browserId, snapshot);
            nextState.snapshots.set(browserId, { ...snapshot });
            if (!nextState.browserOrder.includes(browserId)) {
              nextState.browserOrder.push(browserId);
            }
            return true;
          },
          async (write) => {
            const commit = async (): Promise<void> => {
              assertCreationCurrent();
              this.assertProfileAvailable(resolution.profile.profileId);
              await write();
            };
            if (profileAuthority.commitBinding)
              await profileAuthority.commitBinding(resolution, commit);
            else {
              await profileAuthority.assertActive(resolution);
              await commit();
            }
          },
        ).finally(() => {
          if (this.pendingBrowserBindings.get(browserId) === snapshot)
            this.pendingBrowserBindings.delete(browserId);
        });
        assertCreationCurrent();
        try {
          await profileAuthority.assertActive(resolution);
        } catch (error) {
          await this.withdrawUnconfirmedBinding(snapshot, persistedSnapshot);
          throw error;
        }
        resolution.agentEnableRequired = false;
      }
      assertCreationCurrent();
    } catch (error) {
      try {
        if (view.webContents && !view.webContents.isDestroyed()) {
          view.webContents.close({ waitForBeforeUnload: false });
        }
      } catch {
        // Creation failed before the view became service-owned.
      }
      if (
        !this.sessions.has(browserId) &&
        this.sessionArtifacts.get(browserId) === artifacts
      )
        this.sessionArtifacts.delete(browserId);
      throw error;
    }
    this.sessions.set(browserId, sessionState);
    const assertPublished = (): void => {
      assertCreationCurrent();
      this.assertCurrentLiveSession(sessionState);
    };
    this.attachAppOwnedDialogController(sessionState);
    if (sessionState.hostWindow) {
      const hostClosedHandler = (): void => {
        void this.disposeLiveView(browserId);
      };
      sessionState.hostClosedHandler = hostClosedHandler;
      sessionState.hostWindow.once('closed', hostClosedHandler);
    }
    this.registerBrowserResource(sessionState);
    this.attachView(sessionState);
    this.attachWebContentsListeners(sessionState);
    this.attachDebugger(sessionState);
    assertPublished();
    try {
      if (resolution) await profileAuthority.assertActive(resolution);
    } catch (error) {
      assertPublished();
      await this.destroy(browserId);
      throw error;
    }
    assertPublished();
    // Apply theme emulation without blocking view creation/navigation: the CDP
    // command can stall on a slow page, and the snapshot already carries the
    // theme, so awaiting it here would needlessly delay (or hang) `create`.
    void this.setTheme(browserId, snapshot.themeMode);

    const normalizedUrl = normalizeBrowserUrlInput(
      request.url ?? persistedSnapshot?.url ?? 'about:blank',
    );
    if (
      normalizedUrl !== 'about:blank' &&
      this.isUrlAllowedInApp(normalizedUrl)
    ) {
      // An agent tab opens behind a tab already on screen, so its pane never
      // shows it and holding its load would only delay it.
      if (
        actor === 'agent' &&
        !sessionState.hasBeenShown &&
        !this.hasShownBrowser(request.projectId, request.worktreeId, browserId)
      )
        this.deferInitialLoad(sessionState, normalizedUrl);
      else {
        try {
          await this.loadInitialUrl(sessionState, normalizedUrl);
        } catch (error) {
          if (!(privateSignIn && this.pageClosedItself(sessionState)))
            throw error;
        }
      }
    } else {
      this.emitSnapshot(sessionState);
    }
    // A sign-in page closes itself at its callback, sometimes before its
    // first load returns. That is how sign-in ends, not a failed open: the
    // sign-in flow reports the outcome, and closing the pane destroys the tab.
    if (privateSignIn && this.pageClosedItself(sessionState)) {
      assertCreationCurrent();
      return sessionState.snapshot;
    }
    assertPublished();
    await this.persistLiveSnapshot(sessionState, assertPublished);
    assertPublished();
    return sessionState.snapshot;
  }

  /**
   * Restores the prior tab state when a saved binding fails confirmation.
   * `previous` is what the tab held before the save; a tab with no earlier
   * snapshot is removed. A failure after the state file was written but before
   * memory took the save leaves the tab absent from memory, so the file is
   * rewritten from memory. A tab written again since the save is left alone.
   */
  private async withdrawUnconfirmedBinding(
    saved: BrowserSessionSnapshot,
    previous: BrowserSessionSnapshot | undefined,
  ): Promise<void> {
    const binding = saved.profile;
    if (!binding) return;
    await this.mutateWorktreeState(
      saved.projectId,
      saved.worktreeId,
      (next) => {
        if (!next.snapshots.has(saved.id)) return true;
        const current = next.snapshots.get(saved.id)?.profile;
        if (
          current?.resolvedProfileId !== binding.resolvedProfileId ||
          current.taskIncarnationId !== binding.taskIncarnationId ||
          current.storageGeneration !== binding.storageGeneration ||
          current.runtimeGeneration !== binding.runtimeGeneration
        )
          return false;
        if (previous) {
          next.snapshots.set(saved.id, { ...previous });
          return true;
        }
        next.snapshots.delete(saved.id);
        const index = next.browserOrder.indexOf(saved.id);
        if (index >= 0) next.browserOrder.splice(index, 1);
        if (next.activeBrowserId === saved.id)
          next.activeBrowserId =
            next.browserOrder[
              Math.min(Math.max(index, 0), next.browserOrder.length - 1)
            ] ?? null;
        return true;
      },
    ).catch((error: unknown) => {
      // The caller reports the refused confirmation. A withdrawal that could
      // not be saved leaves the binding in the file, so it must not go
      // unrecorded. Only the code: the message can name a local path.
      logMainProcessWarn('Browser binding withdrawal could not be saved', {
        operation: 'browser_binding_withdrawal',
        code:
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'other',
      });
    });
  }

  private assertRestoreBinding(
    current: BrowserSessionSnapshot['profile'],
    expected: BrowserProfileResolution['binding'] | undefined,
  ): void {
    if (
      expected &&
      (current?.taskIncarnationId !== expected.taskIncarnationId ||
        current?.resolvedProfileId !== expected.resolvedProfileId)
    )
      throw new BrowserProfileError(
        'stale_runtime',
        'This tab was closed or its task or profile changed during maintenance.',
      );
  }

  async destroy(browserId: string): Promise<void> {
    this.assertCommandTarget(browserId);
    this.popupTabs.delete(browserId);
    browserHandoffs.releaseBrowser(browserId);
    // Ownerless and queued admissions must also observe this permanent close.
    for (const admission of Array.from(
      this.creationAdmissions.get(browserId) ?? [],
    ))
      admission.cancelled = true;
    const inProgress = this.destroying.get(browserId);
    if (inProgress) return inProgress;
    if (
      !this.sessions.has(browserId) &&
      !this.findBrowserOwner(browserId) &&
      !this.pendingBrowserBindings.has(browserId)
    )
      return;
    const destruction = this.performPermanentDestroy(browserId).finally(() => {
      this.destroying.delete(browserId);
    });
    this.destroying.set(browserId, destruction);
    return destruction;
  }

  async disposeLiveView(browserId: string): Promise<void> {
    this.assertCommandTarget(browserId);
    if (this.destroying.has(browserId)) {
      await this.destroying.get(browserId);
      return;
    }
    return this.disposeLiveViewInternal(browserId, true);
  }

  requestHandoff(
    browser: BrowserSessionSnapshot,
    origin: ShowFilesChatOrigin,
    hostWindow: BrowserWindow | null,
    createdNewSession: boolean,
    admission?: BrowserHandoffAdmission,
  ): BrowserHandoff {
    const state = this.sessions.get(browser.id);
    if (
      !state ||
      (admission &&
        !browserHandoffs.isAdmissionCurrent(
          browser.projectId,
          browser.worktreeId,
          origin,
          admission,
        )) ||
      state.snapshot.status === 'failed' ||
      !this.isCurrentLiveSession(state) ||
      state.snapshot.projectId !== browser.projectId ||
      state.snapshot.worktreeId !== browser.worktreeId ||
      state.snapshot.profile?.runtimeGeneration !==
        browser.profile?.runtimeGeneration
    ) {
      throw new BrowserProfileError(
        'stale_runtime',
        'The browser changed or closed before the handoff.',
      );
    }
    const pending = browserHandoffs.snapshot(
      browser.projectId,
      browser.worktreeId,
    ).handoff;
    const duplicate =
      pending?.browserId === browser.id &&
      pending.runtimeGeneration === browser.profile?.runtimeGeneration &&
      pending.origin.projectId === origin.projectId &&
      pending.origin.worktreeId === origin.worktreeId &&
      pending.origin.chatTabId === origin.chatTabId;
    if (!duplicate)
      this.emit(
        {
          type: 'open-requested',
          browserId: browser.id,
          snapshot: browser,
          originChatTabId: origin.chatTabId,
          createdNewSession,
          runtimeGeneration: browser.profile?.runtimeGeneration,
        } satisfies BrowserEvent,
        hostWindow,
      );
    return browserHandoffs.request(
      {
        projectId: browser.projectId,
        worktreeId: browser.worktreeId,
        browserId: browser.id,
        runtimeGeneration: browser.profile?.runtimeGeneration,
        origin,
      },
      (event) => this.emit(event, hostWindow),
    );
  }

  async loadWorktreeState(
    projectId: string,
    worktreeId: string,
  ): Promise<LoadWorktreeBrowserStateResponse> {
    const response = await this.loadWorktreeStateWithHandoff(
      projectId,
      worktreeId,
    );
    return {
      ...response,
      handoffState: browserHandoffs.snapshot(projectId, worktreeId),
    };
  }

  private async loadWorktreeStateWithHandoff(
    projectId: string,
    worktreeId: string,
  ): Promise<LoadWorktreeBrowserStateResponse> {
    await this.taskFiles.bind({ projectId, worktreeId });
    await this.recoverProfileSwitches(projectId, worktreeId);
    const response = await loadAndMigrateWorktreeBrowserState(
      projectId,
      worktreeId,
    );
    if (response.status === 'loaded') {
      const key = worktreeKey(projectId, worktreeId);
      this.rejectedWorktreeStates.delete(key);
      const runtimeState = runtimeStateFromPersisted(
        projectId,
        worktreeId,
        response.state,
      );
      for (const sessionState of Array.from(this.sessions.values())) {
        const snapshot = sessionState.snapshot;
        if (
          snapshot.projectId !== projectId ||
          snapshot.worktreeId !== worktreeId
        ) {
          continue;
        }
        runtimeState.snapshots.set(snapshot.id, { ...snapshot });
        if (!runtimeState.browserOrder.includes(snapshot.id)) {
          runtimeState.browserOrder.push(snapshot.id);
        }
      }
      this.worktreeStates.set(key, runtimeState);
      return {
        status: 'loaded',
        state: persistedStateFromRuntime(runtimeState),
      };
    }
    if (response.status === 'fallback') {
      const key = worktreeKey(projectId, worktreeId);
      this.rejectedWorktreeStates.set(key, response.error);
      this.worktreeStates.set(
        key,
        runtimeStateFromPersisted(projectId, worktreeId, response.state),
      );
      return response;
    }
    if (response.status === 'rejected') {
      const key = worktreeKey(projectId, worktreeId);
      this.rejectedWorktreeStates.set(key, response.error);
      this.worktreeStates.set(
        key,
        this.createEmptyWorktreeState(projectId, worktreeId),
      );
      return response;
    }
    this.rejectedWorktreeStates.delete(worktreeKey(projectId, worktreeId));
    this.worktreeStates.set(
      worktreeKey(projectId, worktreeId),
      this.createEmptyWorktreeState(projectId, worktreeId),
    );
    return response;
  }

  async saveWorktreeState(
    request: SaveWorktreeBrowserStateRequest,
  ): Promise<void> {
    const replacement = runtimeStateFromPersisted(
      request.projectId,
      request.worktreeId,
      request.state,
    );
    await this.mutateWorktreeState(
      request.projectId,
      request.worktreeId,
      (nextState) => {
        nextState.browserOrder = [...replacement.browserOrder];
        nextState.activeBrowserId = replacement.activeBrowserId;
        nextState.snapshots = new Map(
          Array.from(replacement.snapshots, ([browserId, snapshot]) => {
            const authoritative = nextState.snapshots.get(browserId);
            const rendererOwned = structuredClone(snapshot);
            delete rendererOwned.profile;
            delete rendererOwned.taskScope;
            const merged: BrowserSessionSnapshot = {
              ...rendererOwned,
              ...(authoritative?.profile
                ? { profile: structuredClone(authoritative.profile) }
                : {}),
              ...(authoritative?.taskScope
                ? { taskScope: structuredClone(authoritative.taskScope) }
                : {}),
            };
            return [browserId, merged];
          }),
        );
        return true;
      },
    );
  }

  async setActiveBrowser(
    projectId: string,
    worktreeId: string,
    browserId: string | null,
  ): Promise<void> {
    await Promise.resolve();
    await this.mutateWorktreeState(projectId, worktreeId, (nextState) => {
      if (browserId !== null && !this.isOwnedBrowser(nextState, browserId)) {
        throw new Error(
          `Browser ${browserId} does not belong to the supplied project/worktree.`,
        );
      }
      if (nextState.activeBrowserId === browserId) return false;
      nextState.activeBrowserId = browserId;
      return true;
    });
  }

  setBounds(request: BrowserSetBoundsRequest): void {
    const state = this.requireSession(request.browserId);
    this.noteInputPresentation(state);
    if (request.visible) state.hasBeenShown = true;
    state.bounds = request.bounds;
    state.visible = request.visible;
    // The pane reports its client rect in the host renderer's CSS px; the
    // view is positioned in window DIPs, which differ under the interface
    // scale zoom. The pane resends on every `resize`, which a zoom change
    // fires, so the view follows the zoom without a separate hook.
    const zoom = hostZoomFactor(state.hostWindow);
    // A native view paints over the renderer's rounded card corners, so the
    // page rounds the corners its area rounds and keeps the rest square.
    if (request.cornerRadii) {
      state.cornerRadii = { ...request.cornerRadii };
    }
    const radii = state.cornerRadii;
    applyBrowserViewFrameLayout(
      state.viewFrame,
      state.view,
      layoutBrowserViewFrame(
        rectangleFromCapture(cssRectToWindowDips(request.bounds, zoom)),
        {
          topLeft: radii.topLeft * zoom,
          topRight: radii.topRight * zoom,
          bottomRight: radii.bottomRight * zoom,
          bottomLeft: radii.bottomLeft * zoom,
        },
      ),
    );
    this.showView(state, request.visible);
    this.updateBrowserResource(state);
    if (
      request.visible &&
      request.bounds.width > 0 &&
      request.bounds.height > 0
    )
      state.deferredInitialLoad?.settle(true);
  }

  setVisible(browserId: string, visible: boolean): void {
    const state = this.requireSession(browserId, 'external.state_changed');
    this.noteInputPresentation(state);
    if (visible) state.hasBeenShown = true;
    state.visible = visible;
    this.showView(state, visible);
    this.updateBrowserResource(state);
  }

  /**
   * The frame takes input over the page area, so it hides with the page.
   * Hiding the page that owns keyboard focus hands focus to the host
   * renderer; otherwise keystrokes would go to a hidden page until the user
   * clicks. A tab-cycle chord pressed in the page relies on this, since the
   * renderer only hides the page when it selects another tab. `isFocused()`
   * is false while the window itself lacks OS focus, so the chord also
   * records that the page held focus.
   */
  private showView(state: LiveBrowserSession, visible: boolean): void {
    const hidesFocusedPage =
      !visible &&
      (state.cycledFromPage === true ||
        state.view.webContents?.isFocused() === true);
    state.cycledFromPage = undefined;
    state.viewFrame.frame.setVisible(visible);
    state.view.setVisible(visible);
    const host = state.hostWindow;
    if (hidesFocusedPage && host && !host.isDestroyed()) {
      rendererContentsOf(host.webContents).focus();
    }
  }

  async navigate(
    request: BrowserNavigateRequest,
  ): Promise<BrowserSessionSnapshot> {
    const state = this.requireSession(request.browserId);
    const url = normalizeBrowserUrlInput(request.url);
    if (this.holdsInitialLoad(state, url))
      return state.deferredInitialLoad?.started ?? state.snapshot;
    // Any other navigation replaces the held first load.
    state.deferredInitialLoad?.settle(false);
    state.heldLoadUrl = undefined;
    if (state.snapshot.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
      await this.assertViewerNavigationAllowed(state, url);
    }
    if (!this.isUrlAllowedInApp(url)) {
      updateSnapshot(state, {
        status: 'failed',
        loading: false,
        lastError: this.localServersOnly
          ? "Couldn't open this page. Enter a local file path or a localhost, 127.0.0.1, or [::1] URL."
          : "Couldn't open this page. Enter an http or https URL, or the full path to a local file.",
      });
      this.emitForSession(state, {
        type: 'load-failed',
        browserId: state.snapshot.id,
        snapshot: state.snapshot,
      });
      throw new Error(state.snapshot.lastError);
    }
    if (
      sameBrowserUrl(state.snapshot.url, url) &&
      sameBrowserUrl(state.view.webContents.getURL(), url)
    ) {
      state.pendingBeforeUnloadAction = { kind: 'reload' };
      state.view.webContents.reload();
      return state.snapshot;
    }
    state.pendingBeforeUnloadAction = { kind: 'navigate', url };
    return this.loadUrlWithBoundedWait(state, url);
  }

  /** Repoint file-backed recipient tabs before the previous revision is pruned. */
  async refreshSharedContainerViewer(containerId: string): Promise<void> {
    const roots = await resolveSharedContainerViewerReadRoots(containerId);
    const sessions = Array.from(this.sessions.values()).filter(
      (state) =>
        state.snapshot.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID &&
        state.snapshot.worktreeId === containerId,
    );
    await Promise.all(
      sessions.map(async (state) => {
        const location =
          state.viewerFileLocation ??
          this.viewerLocationForUrl(state, state.snapshot.url);
        state.viewerReadRoots = roots;
        if (!location) return;
        const root = roots.find(
          (candidate) => candidate.repoId === location.repoId,
        );
        try {
          if (!root) throw new Error('Published browser root was removed');
          const target = resolve(root.absolutePath, location.relativePath);
          await assertSharedContainerViewerFileForRead(containerId, target);
          await this.navigate({
            browserId: state.snapshot.id,
            url: pathToFileURL(target).href,
          });
        } catch {
          state.viewerFileLocation = undefined;
          state.approvedViewerFileUrl = undefined;
          await this.loadUrlWithBoundedWait(state, 'about:blank').catch(
            () => undefined,
          );
        }
      }),
    );
  }

  back(browserId: string): Promise<BrowserSessionSnapshot> {
    const state = this.requireSession(browserId);
    if (canGoBack(state.view.webContents)) {
      state.pendingBeforeUnloadAction = { kind: 'back' };
      goBack(state.view.webContents);
    }
    return Promise.resolve(this.refreshNavigationState(state));
  }

  forward(browserId: string): Promise<BrowserSessionSnapshot> {
    const state = this.requireSession(browserId);
    if (canGoForward(state.view.webContents)) {
      state.pendingBeforeUnloadAction = { kind: 'forward' };
      goForward(state.view.webContents);
    }
    return Promise.resolve(this.refreshNavigationState(state));
  }

  /**
   * Executes one browser-page hotkey action (see `browser-shortcuts.ts`).
   * History navigation uses the focused tab's own `webContents` history and
   * is a safe no-op when the direction is unavailable (`back`/`forward`
   * already guard with `canGoBack`/`canGoForward`). Renderer-focus actions
   * (`new-tab` / `focus-address-bar` / `find-in-page` / `close-tab`) hand
   * keyboard focus back to the host renderer first so it can focus its own
   * input, or keep focus after the page's panel closes. `toggle-sidebar` and
   * the tab-cycle actions (`select-next-tab` / `select-previous-tab`)
   * preserve focus in the browser page: a cycle that selects another tab
   * hides this page, and `showView` then hands focus to the host, while one
   * with nothing to select leaves the page focused.
   */
  private handleBrowserShortcut(
    state: LiveBrowserSession,
    action: BrowserShortcutAction,
  ): void {
    const browserId = state.snapshot.id;
    if (action === 'back') {
      void this.back(browserId).catch(() => undefined);
      return;
    }
    if (action === 'forward') {
      void this.forward(browserId).catch(() => undefined);
      return;
    }
    const host = state.hostWindow;
    const cyclesTabs =
      action === 'select-next-tab' || action === 'select-previous-tab';
    if (cyclesTabs) {
      state.cycledFromPage = true;
    }
    if (
      !cyclesTabs &&
      action !== 'toggle-sidebar' &&
      host &&
      !host.isDestroyed()
    ) {
      // The renderer the window stands for: under early access the App
      // Advisor window's own page is blank and its renderer is a view.
      rendererContentsOf(host.webContents).focus();
    }
    this.emitForSession(state, {
      type: 'shortcut',
      browserId,
      snapshot: state.snapshot,
      action,
    });
  }

  reload(browserId: string): Promise<BrowserSessionSnapshot> {
    const state = this.requireSession(browserId);
    state.pendingBeforeUnloadAction = { kind: 'reload' };
    state.view.webContents.reload();
    return Promise.resolve(this.refreshNavigationState(state));
  }

  stop(browserId: string): Promise<BrowserSessionSnapshot> {
    const state = this.requireSession(browserId);
    this.endAuthRequest(state);
    // A held first load has not started, so stopping the page cannot end it.
    state.deferredInitialLoad?.settle(false);
    state.view.webContents.stop();
    return Promise.resolve(this.refreshNavigationState(state));
  }

  /**
   * Native find in the page (CAN-3048). Electron throws on empty text, so
   * whitespace-only text is rejected here. `findNext` follows the contract
   * (true moves within the current search). Counts arrive later as
   * `find-result` events carrying the returned request id.
   */
  findInPage(
    browserId: string,
    text: string,
    options: Pick<BrowserFindInPageRequest, 'findNext' | 'forward'>,
  ): Promise<number> {
    // The executor runs synchronously; a throw becomes a rejection.
    return new Promise((resolvePromise) => {
      const state = this.requireSession(browserId);
      if (text.trim().length === 0) {
        throw new Error('Find text must not be empty.');
      }
      this.assertCurrentLiveSession(state);
      // Electron's `findNext: true` begins a new find session, the inverse of
      // the contract's `findNext` (a follow-up request). A fresh query sent
      // with Electron's `false` never reports `found-in-page`.
      const isFollowUp = options.findNext ?? false;
      resolvePromise(
        state.view.webContents.findInPage(text, {
          findNext: !isFollowUp,
          forward: options.forward ?? true,
        }),
      );
    });
  }

  stopFindInPage(
    browserId: string,
    action: BrowserStopFindInPageAction,
  ): Promise<void> {
    return new Promise((resolvePromise) => {
      const state = this.requireSession(browserId);
      this.assertCurrentLiveSession(state);
      state.view.webContents.stopFindInPage(action);
      resolvePromise();
    });
  }

  async setTheme(
    browserId: string,
    themeMode: BrowserThemeMode,
  ): Promise<BrowserSessionSnapshot> {
    const state = this.requireSession(browserId);
    updateSnapshot(state, { themeMode });
    // Early access: show the new mode now. The page emulation below can wait
    // up to its bounded timeout on a busy page, and the menu should not wait
    // with it.
    if ((this.options.experimentalFeaturesEnabled ?? ((): boolean => true))()) {
      this.emitSnapshot(state);
    }
    try {
      if (state.view.webContents.debugger.isAttached()) {
        // The CDP command can hang indefinitely when the target page is
        // unresponsive; bound it so callers (notably `create`) never block.
        await this.sendDebuggerCommandWithBoundedWait(
          state,
          'Emulation.setEmulatedMedia',
          {
            features: [
              {
                name: 'prefers-color-scheme',
                value: emulatedColorScheme(themeMode),
              },
            ],
          },
        );
      }
    } catch (error) {
      this.captureConsole(state, {
        level: 'warning',
        text: `Failed to set browser theme emulation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    this.emitSnapshot(state);
    return state.snapshot;
  }

  private async sendDebuggerCommandWithBoundedWait(
    state: LiveBrowserSession,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    const completion = state.view.webContents.debugger.sendCommand(
      command,
      params,
    );
    const commandPromise = (
      state.activeActionContext
        ? state.activeActionContext.trackCommand(completion)
        : completion
    ).then(
      () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      },
      (error: unknown) => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        throw browserCdpCommandError(command, error);
      },
    );
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => {
        timeout = undefined;
        resolve('timeout');
      }, DEBUGGER_COMMAND_TIMEOUT_MS);
    });

    const result = await Promise.race([commandPromise, timeoutPromise]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (result === 'timeout') {
      void commandPromise.catch((error: unknown) => {
        this.captureConsole(state, {
          level: 'warning',
          text: `Browser CDP command ${command} failed after timeout: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
      return false;
    }
    return true;
  }

  private async sendDebuggerCommandResultWithBoundedWait(
    state: LiveBrowserSession,
    command: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        reject(new Error(`Browser CDP command timed out: ${command}`));
      }, DEBUGGER_COMMAND_TIMEOUT_MS);
      const debug = state.view.webContents.debugger;
      const operation = sessionId
        ? debug.sendCommand(command, params, sessionId)
        : debug.sendCommand(command, params);
      if (state.activeActionContext)
        void state.activeActionContext.trackCommand(operation);
      void operation.then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(browserCdpCommandError(command, error));
        },
      );
    });
  }

  async setPickMode(
    browserId: string,
    enabled: boolean,
  ): Promise<BrowserSessionSnapshot> {
    const state = this.requireSession(browserId);
    await this.sendPreloadCommand(state, 'setPickMode', { browserId, enabled });
    updateSnapshot(state, { pickMode: enabled });
    this.emitSnapshot(state);
    return state.snapshot;
  }

  async startRecording(browserId: string): Promise<BrowserSessionSnapshot> {
    const state = this.requireSession(browserId);
    if (!state.snapshot.recording) {
      await this.sendPreloadCommand(state, 'setRecording', {
        browserId,
        enabled: true,
      });
      updateSnapshot(state, { recording: true });
      state.recordingStartedAt = now();
      state.recordedDownloads = new Set();
      if (state.snapshot.url && state.snapshot.url !== 'about:blank') {
        this.addRecordingStep(state, recordingGotoStep(state.snapshot.url));
      }
      this.emitForSession(state, {
        type: 'recording-state',
        browserId,
        recording: true,
      });
      this.emitSnapshot(state);
    }
    return state.snapshot;
  }

  async stopRecording(browserId: string): Promise<BrowserRecordingResult> {
    const state = this.requireSession(browserId);
    if (state.snapshot.recording) {
      await this.sendPreloadCommand(state, 'setRecording', {
        browserId,
        enabled: false,
      });
      updateSnapshot(state, { recording: false });
      this.emitForSession(state, {
        type: 'recording-state',
        browserId,
        recording: false,
      });
      this.emitSnapshot(state);
    }
    return this.getRecording(browserId);
  }

  clearRecording(browserId: string): void {
    const state = this.requireSession(browserId);
    state.recordingSteps.length = 0;
    // What began before the clear stays out of the cleared recording.
    if (state.snapshot.recording) state.recordingStartedAt = now();
  }

  getRecording(browserId: string): BrowserRecordingResult {
    const state = this.requireSession(browserId);
    this.assertAutomationAllowed(state);
    return {
      browserId,
      recording: state.snapshot.recording,
      steps: [...state.recordingSteps],
      playwrightScript: buildPlaywrightScript(state.recordingSteps),
    };
  }

  getConsole(request: BrowserGetConsoleRequest): BrowserConsoleEntry[] {
    const state = request.browserId
      ? this.requireSession(request.browserId)
      : null;
    if (state) this.assertAutomationAllowed(state);
    const entries = state
      ? state.console
      : this.resolveFallbackSessions(request).flatMap(
          (sessionState) => sessionState.console,
        );
    return entries
      .filter((entry) => !request.level || entry.level === request.level)
      .filter(
        (entry) =>
          request.since === undefined || entry.timestamp >= request.since,
      )
      .slice(-(request.limit ?? CONSOLE_LIMIT));
  }

  getNetwork(request: BrowserGetNetworkRequest): BrowserNetworkEntry[] {
    const state = request.browserId
      ? this.requireSession(request.browserId)
      : null;
    if (state) this.assertAutomationAllowed(state);
    const entries = state
      ? state.network
      : this.resolveFallbackSessions(request).flatMap(
          (sessionState) => sessionState.network,
        );
    return entries
      .filter(
        (entry) =>
          request.status === undefined || entry.status === request.status,
      )
      .filter(
        (entry) =>
          request.failed === undefined || entry.failed === request.failed,
      )
      .filter(
        (entry) =>
          !request.urlContains || entry.url.includes(request.urlContains),
      )
      .filter(
        (entry) =>
          request.since === undefined || entry.timestamp >= request.since,
      )
      .slice(-(request.limit ?? NETWORK_LIMIT));
  }

  private transferScope(browserId: string): BrowserTaskFilesScope {
    this.assertCommandTarget(browserId);
    const state = this.sessions.get(browserId);
    if (state) this.assertAutomationAllowed(state);
    const owner = this.findBrowserOwner(browserId);
    if (!owner) throw new Error('This browser tab is no longer available.');
    return { projectId: owner.projectId, worktreeId: owner.worktreeId };
  }

  listTransfers(
    request: BrowserListTransfersRequest,
  ): BrowserListTransfersResult {
    return this.taskFiles.list(
      this.transferScope(request.browserId),
      request.browserId,
      request,
    );
  }

  async cancelTransfer(
    request: BrowserCancelTransferRequest,
  ): Promise<BrowserCancelTransferResult> {
    const scope = this.transferScope(request.browserId);
    const transfer = this.taskFiles.get(scope, request.transferId);
    if (!transfer || transfer.browserId !== request.browserId)
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: 'This download is no longer available.',
        },
      };
    if (transfer.kind === 'copy') return this.cancelCopy(scope, transfer);
    if (transfer.kind === 'upload') return this.cancelUpload(scope, transfer);
    if (
      transfer.status !== 'in_progress' &&
      transfer.status !== 'paused' &&
      !(transfer.status === 'interrupted' && transfer.canResume)
    )
      return { ok: true, transfer };
    const print = this.printing.get(request.transferId);
    if (print) {
      print.cancel.abort();
      await print.done;
    } else {
      this.downloads.cancelDownload(scope, request.transferId);
      await this.downloads.drain();
    }
    const current = this.taskFiles.get(scope, request.transferId);
    if (
      current &&
      current.status !== 'in_progress' &&
      current.status !== 'paused' &&
      !(
        current.status === 'interrupted' &&
        current.kind === 'download' &&
        current.canResume
      )
    )
      return { ok: true, transfer: current };
    return {
      ok: false,
      transfer: current ?? transfer,
      error: {
        code: 'not_cancellable',
        message: 'This download could not be cancelled.',
      },
    };
  }

  private async cancelUpload(
    scope: BrowserTaskFilesScope,
    transfer: BrowserUploadTransfer,
  ): Promise<BrowserCancelTransferResult> {
    if (transfer.status === 'attached')
      return {
        ok: false,
        transfer,
        error: {
          code: 'not_cancellable',
          message:
            'These files are attached, so the upload can no longer be cancelled: the page may already hold them.',
        },
      };
    if (
      transfer.status !== 'staging' &&
      transfer.status !== 'awaiting_approval'
    )
      return { ok: true, transfer };
    this.taskFiles.cancelUpload(scope, transfer.id);
    const current =
      (await this.taskFiles.waitForTransfer(scope, transfer.id, {
        signal: AbortSignal.timeout(COPY_CANCEL_WAIT_MS),
      })) ?? this.taskFiles.get(scope, transfer.id);
    if (current?.kind === 'upload' && current.status === 'cancelled')
      return { ok: true, transfer: current };
    return {
      ok: false,
      transfer: current ?? transfer,
      error: {
        code: 'not_cancellable',
        message:
          current?.kind === 'upload' && current.status === 'attached'
            ? 'These files are attached, so the upload can no longer be cancelled: the page may already hold them.'
            : 'This upload could not be cancelled.',
      },
    };
  }

  private async cancelCopy(
    scope: BrowserTaskFilesScope,
    transfer: BrowserTransfer,
  ): Promise<BrowserCancelTransferResult> {
    if (transfer.status !== 'in_progress') return { ok: true, transfer };
    this.taskFiles.cancelCopy(scope, transfer.id);
    const current =
      (await this.taskFiles.waitForTransfer(scope, transfer.id, {
        signal: AbortSignal.timeout(COPY_CANCEL_WAIT_MS),
      })) ?? this.taskFiles.get(scope, transfer.id);
    if (current && current.status !== 'in_progress')
      return { ok: true, transfer: current };
    return {
      ok: false,
      transfer: current ?? transfer,
      error: {
        code: 'not_cancellable',
        message: 'This copy could not be cancelled.',
      },
    };
  }

  /** The browser's pending file chooser, if one waits for an answer. */
  getFileChooser(browserId: string): BrowserFileChooser | null {
    const chooser = this.requireSession(browserId).pendingFileChooser;
    return chooser ? fileChooserDto(chooser) : null;
  }

  /**
   * `browser.save_pdf`: prints the page to a PDF and saves it as a `print`
   * download in the task's files, named from the page title.
   */
  async savePdf(request: BrowserSavePdfRequest): Promise<BrowserSavePdfResult> {
    const scope = this.transferScope(request.browserId);
    const state = this.requireSession(request.browserId);
    const failure = (
      code: BrowserTransferErrorCode,
      message: string,
    ): BrowserSavePdfResult => ({ ok: false, error: { code, message } });
    const title = (request.fileName ?? state.view.webContents.getTitle())
      .trim()
      .slice(0, PDF_NAME_LENGTH);
    const suggestedName = /\.pdf$/i.test(title)
      ? title
      : `${title || 'page'}.pdf`;
    const downloadId = randomUUID();
    const admission = this.taskFiles.admitDownload({
      scope,
      runtime: {
        browserId: request.browserId,
        runtimeGeneration: state.snapshot.profile?.runtimeGeneration ?? 0,
        taskIncarnationId: state.snapshot.profile?.taskIncarnationId ?? '',
      },
      downloadId,
      suggestedName,
      url: state.snapshot.url,
      mimeType: 'application/pdf',
      totalBytes: null,
      source: 'print',
      ...(request.actionId ? { actionId: request.actionId } : {}),
    });
    if (!admission.ok)
      return admission.reason === 'rate_limited'
        ? failure(
            'download_rate_limited',
            'This browser has too many downloads right now. Try again shortly.',
          )
        : failure('download_failed', "The PDF couldn't be saved.");
    // cancel_transfer and the Files panel's Cancel stop the print here.
    const cancel = new AbortController();
    const work = this.printToTaskFile(
      state,
      request,
      { scope, downloadId, stagingPath: admission.stagingPath },
      cancel.signal,
    );
    this.printing.set(downloadId, {
      cancel,
      done: work.then(
        () => undefined,
        () => undefined,
      ),
    });
    try {
      return await work;
    } finally {
      this.printing.delete(downloadId);
    }
  }

  /**
   * Files that attached, recorded where they attach, so an attach that ends
   * after its action's wait is a step too. The step takes the time the
   * attach was sent, so it goes before a download the attach started.
   */
  private recordUploadStep(
    state: LiveBrowserSession,
    step: Parameters<typeof uploadRecording>[0],
    sentAt: number,
    /** When the chooser it answers opened. */
    chooserOpenedAt?: number,
  ): void {
    // Sent before this recording started: it belongs to an earlier one.
    if (!state.snapshot.recording || sentAt < (state.recordingStartedAt ?? 0))
      return;
    this.addRecordingStep(state, {
      ...uploadRecording(step),
      timestamp: sentAt,
      // The script waits for the chooser from the step that opened it.
      ...(step.via === 'chooser' && chooserOpenedAt !== undefined
        ? { chooserOpenedAt }
        : {}),
    });
  }

  /**
   * How an upload's step replays: on its input, its chooser, or a drop. A
   * chooser opened before recording started has no recorded step that
   * opens it, so a wait for it would never end.
   */
  private uploadStep(
    state: LiveBrowserSession,
    input: ResolvedFileInput,
    names: string[],
    drop = false,
  ): Parameters<typeof uploadRecording>[0] {
    return {
      names,
      ...(input.recordingLocator ? { locator: input.recordingLocator } : {}),
      via: drop
        ? 'drop'
        : input.chooserId &&
            this.chooserOpenedWhileRecording(state, input.chooserOpenedAt)
          ? 'chooser'
          : 'input',
    };
  }

  private chooserOpenedWhileRecording(
    state: LiveBrowserSession,
    openedAt: number | undefined,
  ): boolean {
    return (
      openedAt !== undefined &&
      openedAt >= (state.recordingStartedAt ?? Infinity)
    );
  }

  /** A download that began while recording: the step before it started it. */
  private recordDownloadStep(transfer: BrowserTransfer): void {
    if (
      transfer.kind !== 'download' ||
      transfer.source === 'print' ||
      transfer.source === 'pdf_document'
    )
      return;
    const state = this.sessions.get(transfer.browserId);
    if (
      !state?.snapshot.recording ||
      transfer.startedAt < (state.recordingStartedAt ?? Infinity)
    )
      return;
    const recorded = (state.recordedDownloads ??= new Set());
    if (recorded.has(transfer.id)) return;
    recorded.add(transfer.id);
    const step = {
      ...downloadRecording(transfer.fileName),
      id: `download:${transfer.id}`,
      timestamp: transfer.startedAt,
    };
    // An agent action's own step can be written once it settles, after a
    // download it started; the download waits for the action to end.
    const action = (state.agentActionWindows ?? []).find(
      (window) => window.to === undefined,
    );
    if (action) (action.downloads ??= []).push(step);
    else this.addRecordingStep(state, step);
  }

  private async printToTaskFile(
    state: LiveBrowserSession,
    request: BrowserSavePdfRequest,
    download: {
      scope: BrowserTaskFilesScope;
      downloadId: string;
      stagingPath: string;
    },
    signal: AbortSignal,
  ): Promise<BrowserSavePdfResult> {
    const { scope, downloadId } = download;
    const failure = (message: string): BrowserSavePdfResult => {
      const current = this.taskFiles.get(scope, downloadId);
      return {
        ok: false,
        ...(current?.kind === 'download' ? { transfer: current } : {}),
        error: { code: 'download_failed', message },
      };
    };
    try {
      const printedAt = Date.now();
      const pdf = await withTimeout(
        state.view.webContents.printToPDF(pdfOptions(request)),
        Math.min(
          request.timeoutMs ?? SAVE_PDF_TIMEOUT_MS,
          SAVE_PDF_TIMEOUT_MAX_MS,
        ),
        signal,
      );
      if (!signal.aborted) {
        // Recorded where the page was printed, before the file is saved, so a
        // step taken meanwhile comes after it.
        if (
          state.snapshot.recording &&
          printedAt >= (state.recordingStartedAt ?? 0)
        )
          this.addRecordingStep(state, {
            ...printRecording(playwrightPdfOptions(request)),
            timestamp: printedAt,
          });
        await writeFile(download.stagingPath, pdf, { flag: 'wx' });
        this.taskFiles.updateDownload(downloadId, {
          receivedBytes: pdf.length,
          totalBytes: pdf.length,
          status: 'in_progress',
        });
      }
    } catch {
      if (!signal.aborted) {
        const message = request.pageRanges
          ? "The page couldn't be printed to a PDF. Check that pageRanges is within the page's length."
          : "The page couldn't be printed to a PDF.";
        await this.taskFiles.discardDownload(downloadId, 'failed', {
          code: 'download_failed',
          message,
        });
        return failure(message);
      }
    }
    // A cancel during the write is honored too: the file is removed.
    if (signal.aborted) {
      await this.taskFiles.discardDownload(downloadId, 'cancelled');
      return failure('The PDF was cancelled before it was saved.');
    }
    await this.taskFiles.completeDownload(downloadId);
    const saved = this.taskFiles.get(scope, downloadId);
    return saved?.kind === 'download' && saved.status === 'complete'
      ? { ok: true, transfer: saved }
      : failure(
          saved?.kind === 'download' && saved.error
            ? saved.error.message
            : "The PDF couldn't be saved.",
        );
  }

  /**
   * Copies a finished download into the browser task's workspace after the
   * calling chat's approval session allows the `file-write`, so it follows
   * that chat's mode. Without a chat to ask, the write is denied. Returns the
   * finished copy, or its progress once `timeoutMs` passes; the copy goes on.
   */
  async saveDownload(
    request: BrowserSaveDownloadRequest & { actionId?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<BrowserSaveDownloadResult> {
    const scope = this.transferScope(request.browserId);
    const download = this.taskFiles.get(scope, request.downloadId);
    if (
      !download ||
      download.kind !== 'download' ||
      download.browserId !== request.browserId
    )
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: 'This browser has no download with that id.',
        },
      };
    if (download.status !== 'complete')
      return {
        ok: false,
        error: {
          code: 'file_not_eligible',
          message: 'Only a finished download can be saved.',
        },
      };
    let root: string;
    try {
      root = (
        this.options.resolveWorkspaceRoot ??
        ((target: BrowserTaskFilesScope): string =>
          resolveWorktreeCwd(target.projectId, target.worktreeId))
      )(scope);
    } catch {
      return {
        ok: false,
        error: {
          code: 'file_not_eligible',
          message: "This task's workspace is not available.",
        },
      };
    }
    const prepared = await prepareWorkspaceDestination(root, request.path);
    if (!prepared.ok) return { ok: false, error: prepared.error };
    const { destination } = prepared;
    if (destination.exists && !request.overwrite)
      return {
        ok: false,
        error: {
          code: 'destination_exists',
          message:
            'A file with that name already exists. Set overwrite to replace it.',
        },
      };
    const displayPath = request.path
      .split(/[\\/]/)
      .filter((segment) => segment !== '' && segment !== '.')
      .join('/');
    const chat = request.approvalChat;
    const outcome = chat
      ? await requestChatApproval(
          chat.projectId,
          chat.worktreeId,
          chat.chatId,
          { kind: 'file-write', path: destination.path },
          {
            title: `Save ${download.fileName} to ${displayPath}?`,
            ...(destination.exists
              ? { description: 'This replaces the file that has this name.' }
              : {}),
            details: { kind: 'file-write', path: destination.path },
          },
        )
      : undefined;
    if (outcome?.decision !== 'allow')
      return {
        ok: false,
        error: {
          code: 'approval_denied',
          message: 'Saving the download was not approved.',
        },
      };
    const started = this.taskFiles.startCopy(scope, {
      browserId: request.browserId,
      downloadId: download.id,
      source: 'agent',
      ...(request.actionId ? { actionId: request.actionId } : {}),
      destinationName: displayPath,
      destination,
      overwrite: request.overwrite === true,
    });
    if (!started.ok) return { ok: false, error: started.error };
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(
        Math.max(request.timeoutMs ?? SAVE_DOWNLOAD_TIMEOUT_MS, 0),
        SAVE_DOWNLOAD_MAX_TIMEOUT_MS,
      ),
    );
    const abort = (): void => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    let settled: BrowserTransfer | undefined;
    try {
      settled = await this.taskFiles.waitForTransfer(
        scope,
        started.transfer.id,
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
    const latest = settled ?? this.taskFiles.get(scope, started.transfer.id);
    const transfer = latest?.kind === 'copy' ? latest : started.transfer;
    if (transfer.status === 'complete' || transfer.status === 'in_progress')
      return { ok: true, transfer };
    return {
      ok: false,
      transfer,
      error: transfer.error ?? {
        code: 'copy_failed',
        message: 'The copy failed.',
      },
    };
  }

  /** Save a copy: the user picks the place in the save dialog, so no approval is asked. */
  private async saveCopy(
    scope: BrowserTaskFilesScope,
    transfer: BrowserDownloadTransfer,
    host: BrowserTransferHost,
  ): Promise<BrowserTransferCommandResult> {
    if (transfer.status !== 'complete' || !host.chooseSavePath)
      return {
        ok: false,
        transfer,
        error: {
          code: 'file_not_eligible',
          message: 'Only a finished download can be copied.',
        },
      };
    let chosen: string | undefined;
    try {
      chosen = await host.chooseSavePath(transfer.fileName);
    } catch {
      // Host errors may name local paths; only the bounded failure reaches callers.
      return {
        ok: false,
        transfer,
        error: { code: 'copy_failed', message: 'The copy failed.' },
      };
    }
    if (!chosen) return { ok: true, dismissed: true };
    const prepared = await prepareChosenDestination(chosen);
    if (!prepared.ok) return { ok: false, transfer, error: prepared.error };
    const started = this.taskFiles.startCopy(scope, {
      browserId: transfer.browserId,
      downloadId: transfer.id,
      source: 'user',
      destinationName: prepared.destination.name,
      destination: prepared.destination,
      // The save dialog has already asked about replacing a file.
      overwrite: true,
    });
    return started.ok
      ? { ok: true, transfer: started.transfer }
      : { ok: false, transfer, error: started.error };
  }

  async transferCommand(
    command: BrowserTransferCommand,
    host: BrowserTransferHost,
  ): Promise<BrowserTransferCommandResult> {
    if (command.kind === 'cancel') return this.cancelTransfer(command);
    const scope = this.transferScope(command.browserId);
    if (command.kind === 'allow_more') {
      this.taskFiles.allowMore(command.browserId);
      return { ok: true };
    }
    const transfer = this.taskFiles.get(scope, command.transferId);
    if (
      !transfer ||
      transfer.kind !== 'download' ||
      transfer.browserId !== command.browserId
    )
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: 'This download is no longer available.',
        },
      };
    if (command.kind === 'save_copy')
      return this.saveCopy(scope, transfer, host);
    if (command.kind === 'attach') {
      try {
        const path = await this.taskFiles.resolveLocalPath(
          scope,
          command.transferId,
        );
        if (path) return { ok: true, transfer, attachPath: path };
      } catch {
        // Host errors may name local paths; only the bounded failure reaches callers.
      }
      return {
        ok: false,
        transfer,
        error: {
          code: 'not_found',
          message: 'The downloaded file is no longer available.',
        },
      };
    }
    if (command.kind === 'resume') {
      const resumed = await this.downloads.resumeDownload(
        scope,
        command.transferId,
      );
      await this.downloads.drain();
      const current = this.taskFiles.get(scope, command.transferId) ?? transfer;
      return resumed
        ? { ok: true, transfer: current }
        : {
            ok: false,
            transfer: current,
            error: {
              code: 'not_resumable',
              message:
                'This download cannot be resumed. Start it again from the page.',
            },
          };
    }
    try {
      const path = await this.taskFiles.resolveLocalPath(
        scope,
        command.transferId,
      );
      if (path) {
        host.revealInFolder(path);
        return { ok: true, transfer };
      }
    } catch {
      // Host errors may name local paths; only the bounded failure reaches callers.
    }
    return {
      ok: false,
      transfer,
      error: {
        code: 'not_found',
        message: 'The downloaded file is no longer available.',
      },
    };
  }

  async screenshot(
    request: BrowserScreenshotRequest,
  ): Promise<BrowserScreenshotResponse> {
    const state = this.requireSession(request.browserId);
    this.assertAutomationAllowed(state);
    if (request.purpose === 'freeze-frame') {
      return { dataUrl: await this.captureFreezeFrame(state) };
    }
    let observation: BrowserScreenshotObservationContext | undefined;
    if (__CANOPY_E2E__) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(
          globalThis,
          '__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__',
        );
        if (
          descriptor &&
          Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
          isScreenshotObservationCallback(descriptor.value)
        ) {
          const boundId = (
            value: string,
          ): { value: string; truncated: boolean } => {
            let bounded = '';
            let bytes = 0;
            for (const character of value) {
              const characterBytes = Buffer.byteLength(character);
              if (bytes + characterBytes > 128) {
                return { value: bounded, truncated: true };
              }
              bounded += character;
              bytes += characterBytes;
            }
            return { value: bounded, truncated: false };
          };
          const requested = boundId(request.browserId);
          const resolved = boundId(state.snapshot.id);
          browserScreenshotObservationSequence =
            browserScreenshotObservationSequence >= Number.MAX_SAFE_INTEGER
              ? 1
              : browserScreenshotObservationSequence + 1;
          observation = {
            callback: descriptor.value,
            requestSequence: browserScreenshotObservationSequence,
            requestedBrowserId: requested.value,
            requestedBrowserIdTruncated: requested.truncated,
            resolvedBrowserId: resolved.value,
            resolvedBrowserIdTruncated: resolved.truncated,
          };
        }
      } catch {
        observation = undefined;
      }
    }
    if (!request.saveToAttachments) {
      const capture = await this.captureValidScreenshot(
        state,
        false,
        observation,
      );
      this.assertCurrentLiveSession(state);
      return { dataUrl: capture.dataUrl };
    }
    const capture = await this.captureValidScreenshot(state, true, observation);
    const filePath = await this.writeAttachment(
      state,
      `browser-screenshot-${state.snapshot.id}-${timestampForFilename()}-${uuid().slice(0, 8)}.png`,
      capture.png,
    );
    return { attachmentPath: filePath, dataUrl: capture.dataUrl };
  }

  private async captureFreezeFrame(state: LiveBrowserSession): Promise<string> {
    for (let attempt = 0; attempt < SCREENSHOT_CAPTURE_ATTEMPTS; attempt += 1) {
      const image = await state.view.webContents.capturePage();
      this.assertCurrentLiveSession(state);
      if (!image.isEmpty()) {
        const jpeg = image.toJPEG(FREEZE_FRAME_JPEG_QUALITY);
        if (jpeg.byteLength > 0) {
          return `${FREEZE_FRAME_DATA_URL_PREFIX}${jpeg.toString('base64')}`;
        }
      }
      if (attempt + 1 < SCREENSHOT_CAPTURE_ATTEMPTS) {
        state.view.webContents.invalidate();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, SCREENSHOT_REPAINT_INTERVAL_MS);
        });
        this.assertCurrentLiveSession(state);
      }
    }
    throw new Error('Browser screenshot is unavailable.');
  }

  private async captureValidScreenshot(
    state: LiveBrowserSession,
    includePng: true,
    observation?: BrowserScreenshotObservationContext,
  ): Promise<{ dataUrl: string; png: Buffer }>;
  private async captureValidScreenshot(
    state: LiveBrowserSession,
    includePng: false,
    observation?: BrowserScreenshotObservationContext,
  ): Promise<{ dataUrl: string; png?: undefined }>;
  private async captureValidScreenshot(
    state: LiveBrowserSession,
    includePng: boolean,
    observation?: BrowserScreenshotObservationContext,
  ): Promise<{ dataUrl: string; png?: Buffer }> {
    let observe:
      | ((phase: string, details?: Record<string, unknown>) => void)
      | undefined;
    if (__CANOPY_E2E__ && observation) {
      observe = (phase, details = {}): void => {
        try {
          let projectionUnavailable = '';
          const unavailable = (field: string): void => {
            projectionUnavailable = projectionUnavailable
              ? `${projectionUnavailable},${field}`
              : field;
          };
          let webContentsId: number | null = null;
          try {
            const value = state.view.webContents.id;
            if (Number.isInteger(value) && value > 0) webContentsId = value;
            else unavailable('web-contents-id');
          } catch {
            unavailable('web-contents-id');
          }
          let hostWindowId: number | null = null;
          try {
            const value = state.hostWindow?.id;
            if (value === undefined || value === null) {
              unavailable('host-window-id');
            } else if (Number.isInteger(value) && value > 0) {
              hostWindowId = value;
            } else {
              unavailable('host-window-id');
            }
          } catch {
            unavailable('host-window-id');
          }
          let stateBounds: Record<string, number> | null = null;
          try {
            const { x, y, width, height } = state.bounds;
            if ([x, y, width, height].every(Number.isFinite)) {
              stateBounds = { x, y, width, height };
            } else {
              unavailable('state-bounds');
            }
          } catch {
            unavailable('state-bounds');
          }
          let stateVisible: boolean | null = null;
          try {
            if (typeof state.visible === 'boolean')
              stateVisible = state.visible;
            else unavailable('state-visible');
          } catch {
            unavailable('state-visible');
          }
          let nativeGeometry: Record<string, unknown> | undefined;
          if (phase === 'capture-entered' || phase === 'capture-returned') {
            const nativeUnavailable: string[] = [];
            const nativeUnavailableField = (field: string): void => {
              nativeUnavailable.push(field);
            };
            const rectangle = (
              field: string,
              read: () => {
                x: number;
                y: number;
                width: number;
                height: number;
              },
            ): Record<string, number> | null => {
              try {
                const { x, y, width, height } = read();
                if ([x, y, width, height].every(Number.isFinite)) {
                  return { x, y, width, height };
                }
              } catch {
                /* Report the fixed unavailable code below. */
              }
              nativeUnavailableField(field);
              return null;
            };
            const boolean = (
              field: string,
              read: () => unknown,
            ): boolean | null => {
              try {
                const value = read();
                if (typeof value === 'boolean') return value;
              } catch {
                /* Report the fixed unavailable code below. */
              }
              nativeUnavailableField(field);
              return null;
            };
            // The page's place in the window is its frame's (the page itself
            // is positioned inside the frame's rounded clip).
            const viewBounds = rectangle('view-bounds', () =>
              state.viewFrame.frame.getBounds(),
            );
            const viewVisible = boolean('view-visible', () =>
              state.view.getVisible(),
            );
            const webContentsDestroyed = boolean('web-contents-destroyed', () =>
              state.view.webContents.isDestroyed(),
            );
            let hostDestroyed: boolean | null = null;
            let hostVisible: boolean | null = null;
            let hostMinimized: boolean | null = null;
            let hostBounds: Record<string, number> | null = null;
            let hostContentBounds: Record<string, number> | null = null;
            let contentViewBounds: Record<string, number> | null = null;
            let contentViewVisible: boolean | null = null;
            let directChildCount: number | null = null;
            let directChildInspectedCount: number | null = null;
            let directChildMembership:
              | 'present'
              | 'absent'
              | 'unknown-overflow'
              | 'unavailable' = 'unavailable';
            let directChildOverflow: boolean | null = null;
            const unavailableHostDependents = (): void => {
              for (const field of [
                'host-visible',
                'host-minimized',
                'host-bounds',
                'host-content-bounds',
                'content-view-bounds',
                'content-view-visible',
                'direct-children',
              ]) {
                nativeUnavailableField(field);
              }
            };
            const host = state.hostWindow;
            if (host) {
              hostDestroyed = boolean('host-destroyed', () =>
                host.isDestroyed(),
              );
              if (hostDestroyed === false) {
                hostVisible = boolean('host-visible', () => host.isVisible());
                hostMinimized = boolean('host-minimized', () =>
                  host.isMinimized(),
                );
                hostBounds = rectangle('host-bounds', () => host.getBounds());
                hostContentBounds = rectangle('host-content-bounds', () =>
                  host.getContentBounds(),
                );
                let contentView: typeof host.contentView | null = null;
                try {
                  contentView = host.contentView;
                } catch {
                  contentView = null;
                }
                if (contentView) {
                  contentViewBounds = rectangle('content-view-bounds', () =>
                    contentView.getBounds(),
                  );
                  contentViewVisible = boolean('content-view-visible', () =>
                    contentView.getVisible(),
                  );
                  try {
                    const children = contentView.children;
                    if (!Array.isArray(children)) {
                      throw new Error('Direct children are unavailable');
                    }
                    directChildCount = children.length;
                    directChildOverflow = children.length > 32;
                    const maximum = Math.min(children.length, 32);
                    let found = false;
                    let inspected = 0;
                    for (let index = 0; index < maximum; index += 1) {
                      inspected++;
                      if (children[index] === state.viewFrame.frame) {
                        found = true;
                        break;
                      }
                    }
                    directChildInspectedCount = inspected;
                    directChildMembership = found
                      ? 'present'
                      : directChildOverflow
                        ? 'unknown-overflow'
                        : 'absent';
                  } catch {
                    nativeUnavailableField('direct-children');
                  }
                } else {
                  for (const field of [
                    'content-view-bounds',
                    'content-view-visible',
                    'direct-children',
                  ]) {
                    nativeUnavailableField(field);
                  }
                }
              } else {
                unavailableHostDependents();
              }
            } else {
              nativeUnavailableField('host-destroyed');
              unavailableHostDependents();
            }
            nativeGeometry = {
              viewBounds,
              viewVisible,
              webContentsDestroyed,
              hostDestroyed,
              hostVisible,
              hostMinimized,
              hostBounds,
              hostContentBounds,
              contentViewBounds,
              contentViewVisible,
              directChildCount,
              directChildInspectedCount,
              directChildMembership,
              directChildOverflow,
              ...(nativeUnavailable.length
                ? {
                    nativeGeometryUnavailable: nativeUnavailable.join(','),
                  }
                : {}),
            };
          }
          observation.callback({
            phase,
            requestSequence: observation.requestSequence,
            requestedBrowserId: observation.requestedBrowserId,
            requestedBrowserIdTruncated:
              observation.requestedBrowserIdTruncated,
            resolvedBrowserId: observation.resolvedBrowserId,
            resolvedBrowserIdTruncated: observation.resolvedBrowserIdTruncated,
            webContentsId,
            hostWindowId,
            stateBounds,
            stateVisible,
            ...(projectionUnavailable ? { projectionUnavailable } : {}),
            ...(nativeGeometry ?? {}),
            ...details,
          });
        } catch {
          /* A diagnostic observer must not change the screenshot result. */
        }
      };
    }
    for (let attempt = 0; attempt < SCREENSHOT_CAPTURE_ATTEMPTS; attempt += 1) {
      const attemptNumber = attempt + 1;
      if (__CANOPY_E2E__ && observe) {
        observe('capture-entered', {
          attempt: attemptNumber,
          captureEnteredNs: process.hrtime.bigint().toString(),
        });
      }
      let image: Awaited<
        ReturnType<LiveBrowserSession['view']['webContents']['capturePage']>
      >;
      try {
        image = await state.view.webContents.capturePage();
      } catch (error) {
        if (__CANOPY_E2E__ && observe) {
          observe('operation-threw', {
            attempt: attemptNumber,
            operation: 'capture-page',
            outcome: 'threw',
            thrownType: error === null ? 'null' : typeof error,
          });
        }
        throw error;
      }
      const captureReturnedNs =
        __CANOPY_E2E__ && observe
          ? process.hrtime.bigint().toString()
          : undefined;
      try {
        this.assertCurrentLiveSession(state);
      } catch (error) {
        if (__CANOPY_E2E__ && observe) {
          observe('operation-threw', {
            attempt: attemptNumber,
            operation: 'post-capture-live-session-assertion',
            outcome: 'threw',
            thrownType: error === null ? 'null' : typeof error,
            ...(captureReturnedNs ? { captureReturnedNs } : {}),
          });
        }
        throw error;
      }
      if (__CANOPY_E2E__ && observe) {
        observe('capture-returned', {
          attempt: attemptNumber,
          captureReturnedNs,
          liveSessionAssertion: 'passed',
        });
      }
      let dataUrl: string;
      try {
        dataUrl = image.toDataURL();
      } catch (error) {
        if (__CANOPY_E2E__ && observe) {
          observe('operation-threw', {
            attempt: attemptNumber,
            operation: 'to-data-url',
            outcome: 'threw',
            thrownType: error === null ? 'null' : typeof error,
          });
        }
        throw error;
      }
      let png: Buffer | undefined;
      if (includePng) {
        try {
          png = image.toPNG();
        } catch (error) {
          if (__CANOPY_E2E__ && observe) {
            observe('operation-threw', {
              attempt: attemptNumber,
              operation: 'to-png',
              outcome: 'threw',
              thrownType: error === null ? 'null' : typeof error,
            });
          }
          throw error;
        }
      }
      let imageEmpty: boolean;
      try {
        imageEmpty = image.isEmpty();
      } catch (error) {
        if (__CANOPY_E2E__ && observe) {
          observe('operation-threw', {
            attempt: attemptNumber,
            operation: 'is-empty',
            outcome: 'threw',
            thrownType: error === null ? 'null' : typeof error,
          });
        }
        throw error;
      }
      let encodingPrefixValid: boolean | 'not-evaluated' = 'not-evaluated';
      let encodingNonempty: boolean | 'not-evaluated' = 'not-evaluated';
      let dataUrlLength: number | undefined;
      let valid = false;
      if (!imageEmpty) {
        encodingPrefixValid = dataUrl.startsWith(SCREENSHOT_DATA_URL_PREFIX);
        if (encodingPrefixValid) {
          dataUrlLength = dataUrl.length;
          encodingNonempty = dataUrlLength > SCREENSHOT_DATA_URL_PREFIX.length;
          if (encodingNonempty) {
            valid = !includePng || (png !== undefined && png.byteLength > 0);
          }
        }
      }
      if (__CANOPY_E2E__ && observe) {
        observe('validation', {
          attempt: attemptNumber,
          validationNs: process.hrtime.bigint().toString(),
          liveSessionAssertion: 'passed',
          imageEmpty,
          encodingPrefixValid,
          encodingNonempty,
          ...(dataUrlLength === undefined ? {} : { dataUrlLength }),
        });
      }
      if (valid) {
        return { dataUrl, ...(png !== undefined ? { png } : {}) };
      }
      if (attempt + 1 < SCREENSHOT_CAPTURE_ATTEMPTS) {
        try {
          state.view.webContents.invalidate();
        } catch (error) {
          if (__CANOPY_E2E__ && observe) {
            observe('operation-threw', {
              attempt: attemptNumber,
              operation: 'invalidate',
              outcome: 'threw',
              thrownType: error === null ? 'null' : typeof error,
            });
          }
          throw error;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, SCREENSHOT_REPAINT_INTERVAL_MS);
        });
        try {
          this.assertCurrentLiveSession(state);
        } catch (error) {
          if (__CANOPY_E2E__ && observe) {
            observe('operation-threw', {
              attempt: attemptNumber,
              operation: 'post-invalidate-live-session-assertion',
              outcome: 'threw',
              thrownType: error === null ? 'null' : typeof error,
            });
          }
          throw error;
        }
      }
    }
    if (__CANOPY_E2E__ && observe) {
      observe('capture-exhausted', {
        attempt: SCREENSHOT_CAPTURE_ATTEMPTS,
      });
    }
    throw new Error(
      `Browser screenshot is unavailable.${this.signInNotice(state)}`,
    );
  }

  /** E2E only: times one page-model build (see `measurementRequest`). */
  private readonly pageModelMeasurementHook = async (
    input: PageModelMeasurementRequest,
  ): Promise<unknown> => {
    const request = measurementRequest(input);
    const state = this.requireSession(request.browserId);
    this.assertAutomationAllowed(state);
    if (state.pendingDialog)
      throw new BrowserDialogPendingError(state.pendingDialog);
    await this.ensurePageModelReady(state);
    const result = await state.pageModel.build(request.options);
    this.assertCurrentLiveSession(state);
    const model = result.model;
    return {
      durationMs: result.durationMs,
      cached: result.cached,
      coverage: model.coverage,
      counts: {
        nodes: model.nodes.length,
        frames: model.frames.length,
        inputs: model.nodes.filter((node) =>
          ['input', 'textarea', 'select'].includes(node.tagName.toLowerCase()),
        ).length,
        // What the optional stages found, so a spec can tell a stage
        // that ran from one that saw nothing.
        accessibilityNodes: model.accessibility.length,
        listenerHits: model.listeners.reduce(
          (total, entry) => total + entry.backendNodeIds.length,
          0,
        ),
      },
      timings: model.timings,
      styleSupplement: model.styleSupplement,
    };
  };

  private async ensurePageModelReady(state: LiveBrowserSession): Promise<void> {
    // A never-navigated view holds renderer CDP commands indefinitely. Do not
    // await discovery for it; the builder reports root_not_navigated instead.
    const host = state.pageModel;
    const url = state.view.webContents.getURL();
    if (url && url !== 'about:blank' && !host.hasNavigatedRoot()) {
      await host.discoverFrames().catch(() => undefined);
    }
  }

  private async pageModelPage(
    state: LiveBrowserSession,
  ): Promise<BrowserPageModel['page']> {
    const result = state.pageModel.hasNavigatedRoot()
      ? await this.sendDebuggerCommandResultWithBoundedWait(
          state,
          'Runtime.evaluate',
          {
            expression:
              '({width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio})',
            returnByValue: true,
          },
        ).catch(() => undefined)
      : undefined;
    const remote =
      isRecord(result) && isRecord(result.result)
        ? result.result.value
        : undefined;
    const viewport = isRecord(remote) ? remote : {};
    const finite = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    this.assertCurrentLiveSession(state);
    return {
      browserId: state.snapshot.id,
      runtimeGeneration: state.snapshot.profile?.runtimeGeneration,
      url: state.view.webContents.getURL(),
      title: state.snapshot.title,
      viewport: {
        width: finite(viewport.width, state.bounds.width),
        height: finite(viewport.height, state.bounds.height),
        deviceScaleFactor: finite(viewport.deviceScaleFactor, 1),
      },
      themeMode: state.snapshot.themeMode,
    };
  }

  /**
   * A read that arrives while the main frame navigates waits for the new
   * document, up to READ_NAVIGATION_WAIT_MS, so the document being
   * replaced does not answer it (phase 04b E2): until it has committed and
   * fired DOMContentLoaded, or the navigation failed or stopped. A dialog,
   * the request's abort or the view closing ends the wait early; after the
   * bound the read proceeds with whatever document is there.
   */
  private async awaitMainFrameDocument(
    state: LiveBrowserSession,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!state.mainFrameNavigation.inFlight) return;
    await state.mainFrameNavigation.wait({
      timeoutMs: READ_NAVIGATION_WAIT_MS,
      ...(signal ? { signal } : {}),
      interrupt: (end) => {
        state.pendingDialogWaiters.add(end);
        return (): void => {
          state.pendingDialogWaiters.delete(end);
        };
      },
    });
    signal?.throwIfAborted();
    this.assertCurrentLiveSession(state);
    if (state.pendingDialog)
      throw new BrowserDialogPendingError(state.pendingDialog);
  }

  async inspect(
    request: BrowserInspectRequest,
    signal?: AbortSignal,
  ): Promise<BrowserElementSnapshot> {
    const state = this.requireSession(request.browserId);
    this.assertAutomationAllowed(state);
    const frame = requestFrame(request.frame);
    if (state.pendingDialog) {
      throw new BrowserDialogPendingError(state.pendingDialog);
    }
    await this.awaitMainFrameDocument(state, signal);
    await this.ensurePageModelReady(state);
    const result = await state.pageModel.inspect(
      request,
      () => this.pageModelPage(state),
      frame === undefined ? {} : { frame },
    );
    this.assertCurrentLiveSession(state);
    return result;
  }

  async inputSnapshot(
    request: BrowserInputSnapshotRequest,
  ): Promise<BrowserInputSnapshotResponse> {
    const state = this.requireSession(request.browserId);
    this.assertAutomationAllowed(state);
    const frame = requestFrame(request.filter?.frame);
    if (state.pendingDialog) {
      throw new BrowserDialogPendingError(state.pendingDialog);
    }
    await this.awaitMainFrameDocument(state);
    await this.ensurePageModelReady(state);
    const result = await state.pageModel.snapshot(
      request,
      () => this.pageModelPage(state),
      frame === undefined ? {} : { frame },
    );
    this.assertCurrentLiveSession(state);
    return result;
  }

  getDialog(browserId: string): BrowserJavaScriptDialog | null {
    const state = this.requireSession(browserId);
    return state.pendingDialog ? { ...state.pendingDialog } : null;
  }

  async handleDialog(
    request: BrowserHandleJavaScriptDialogRequest,
  ): Promise<BrowserHandleJavaScriptDialogResponse> {
    const state = this.requireSession(request.browserId);
    const answers =
      state.dialogAnswers ??
      new Map<string, Promise<BrowserHandleJavaScriptDialogResponse>>();
    state.dialogAnswers = answers;
    const existing = answers.get(request.dialogId);
    if (existing) return await existing;
    // Claim a dialog answer once across private Electron and CDP transports.
    // Retain the same result for late duplicates, even after the close event.
    const answer = this.performHandleDialog(state, request);
    answers.set(request.dialogId, answer);
    while (answers.size > 64) {
      const oldest = answers.keys().next().value;
      if (oldest === undefined) break;
      answers.delete(oldest);
    }
    // Observe immediately; callers still receive the original rejection.
    void answer.catch((): void => {
      if (
        state.pendingDialog?.id === request.dialogId &&
        answers.get(request.dialogId) === answer
      )
        answers.delete(request.dialogId);
    });
    return await answer;
  }

  private async performHandleDialog(
    state: LiveBrowserSession,
    request: BrowserHandleJavaScriptDialogRequest,
  ): Promise<BrowserHandleJavaScriptDialogResponse> {
    const dialog = state.pendingDialog;
    if (!dialog) {
      throw new Error(`Browser ${request.browserId} has no pending dialog.`);
    }
    if (dialog.id !== request.dialogId) {
      throw new Error(
        `Browser dialog ${request.dialogId} is stale; current dialog is ${dialog.id}.`,
      );
    }
    const promptText = request.promptText?.slice(
      0,
      JAVASCRIPT_DIALOG_PROMPT_LIMIT,
    );
    const promptPause =
      state.appPromptPause?.dialogId === dialog.id
        ? state.appPromptPause
        : undefined;
    if (promptPause) {
      return await this.handlePausedAppPrompt(
        state,
        dialog,
        promptPause,
        request.accept,
        promptText,
      );
    }
    const beforeUnloadDialog =
      state.appBeforeUnloadDialog?.dialogId === dialog.id
        ? state.appBeforeUnloadDialog
        : undefined;
    if (beforeUnloadDialog) {
      return this.handleBeforeUnloadDialog(
        state,
        dialog,
        beforeUnloadDialog,
        request.accept,
      );
    }
    if (state.pendingDialogClose) {
      throw new Error(`Browser dialog ${dialog.id} is already being handled.`);
    }
    const close = this.createDialogCloseWaiter(state, dialog.id);
    const appDialog =
      state.appDialog?.dialogId === dialog.id ? state.appDialog : undefined;
    const correlation = state.dialogCorrelations?.find(
      (item) => item.dialog.id === dialog.id,
    );
    if (correlation)
      correlation.answer = {
        accept: request.accept,
        promptText: request.accept
          ? (promptText ?? dialog.defaultPrompt ?? '')
          : '',
      };
    if (appDialog) {
      state.appDialog = undefined;
    }
    const handlingPromise = appDialog
      ? Promise.resolve().then(() => {
          this.answerPrivateDialog(
            state,
            appDialog.callback,
            request.accept,
            request.accept ? (promptText ?? dialog.defaultPrompt ?? '') : '',
          );
          return true;
        })
      : this.sendDebuggerCommandWithBoundedWait(
          state,
          'Page.handleJavaScriptDialog',
          {
            accept: request.accept,
            ...(promptText !== undefined ? { promptText } : {}),
          },
        );
    let handled: boolean;
    try {
      handled = await handlingPromise;
    } catch (error) {
      this.cancelDialogCloseWaiter(state, close);
      throw error;
    }
    if (!handled) {
      this.cancelDialogCloseWaiter(state, close);
      throw new Error(
        `Timed out handling browser JavaScript dialog ${dialog.id}.`,
      );
    }
    await close.promise;
    return {
      dialog: { ...dialog },
      accept: request.accept,
      ...(promptText !== undefined ? { promptText } : {}),
    };
  }

  async automation(
    request: BrowserAutomationRequest,
    signal?: AbortSignal,
  ): Promise<BrowserAutomationRuntimeResult> {
    const validationError = validateBrowserAutomationCommand(request.command);
    if (validationError) {
      return {
        ok: false,
        error: { code: 'invalid_payload', message: validationError },
      };
    }
    if (request.command.kind === 'inspect') signal?.throwIfAborted();
    const browserId =
      request.browserId ?? this.resolveFallbackBrowserId(request) ?? null;
    if (!browserId) {
      return {
        ok: false,
        error: { code: 'not_found', message: 'No browser is available.' },
      };
    }
    this.assertCommandTarget(browserId);
    const state = this.sessions.get(browserId);
    if (!state) {
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: `Browser ${browserId} not found.`,
        },
      };
    }
    if (
      isMcpOAuthBrowserScope(
        state.snapshot.projectId,
        state.snapshot.worktreeId,
      )
    ) {
      return {
        ok: false,
        error: {
          code: 'not_found',
          message:
            'Sign-in pages are private. Complete sign-in yourself in the browser.',
        },
      };
    }
    if (request.command.kind !== 'inspect') {
      return this.runBrowserAutomationCommand(
        state,
        request.command,
        signal,
        request.approvalChat,
      );
    }
    if (state.pendingDialog) {
      return {
        ok: true,
        completed: false,
        browser: state.snapshot,
        dialog: { ...state.pendingDialog },
      };
    }
    try {
      const element = await this.inspect(
        { ...request.command, browserId },
        signal,
      );
      return { ok: true, completed: true, browser: state.snapshot, element };
    } catch (error) {
      // An abort while the read waited rejects, as one before it does.
      if (signal?.aborted && error === signal.reason) throw error;
      if (error instanceof BrowserDialogPendingError)
        return {
          ok: true,
          completed: false,
          browser: state.snapshot,
          dialog: { ...error.dialog },
        };
      // A target that did not resolve fails like an action refusal (E3).
      const readFailure = decodeBrowserReadTargetError(error);
      if (readFailure)
        return {
          ok: false,
          browser: state.snapshot,
          error: browserReadTargetFailure(readFailure),
        };
      return {
        ok: false,
        browser: state.snapshot,
        error: {
          code: 'execution_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private actionLaneFor(state: LiveBrowserSession): ActionLane {
    const generation = state.snapshot.profile?.runtimeGeneration ?? 0;
    return this.actionLanes.laneFor(
      state,
      generation,
      (key, epoch) =>
        key === state &&
        this.isCurrentLiveSession(state) &&
        (state.snapshot.profile?.runtimeGeneration ?? 0) === epoch,
    );
  }

  private runBrowserAutomationCommand(
    state: LiveBrowserSession,
    command: Exclude<BrowserAutomationCommand, { kind: 'inspect' }>,
    signal?: AbortSignal,
    approvalChat?: BrowserAutomationRequest['approvalChat'],
  ): Promise<BrowserAutomationRuntimeResult> {
    const execute = async (): Promise<BrowserAutomationRuntimeResult> => {
      if (command.kind === 'upload_files' || command.kind === 'drop_files')
        return this.runBrowserUploadFiles(state, command, signal, approvalChat);
      if (command.kind === 'request_files')
        return this.runBrowserRequestFiles(
          state,
          command,
          signal,
          approvalChat,
        );
      if (command.kind !== 'wait_for')
        return this.runBrowserInputAction(state, command, signal);
      state.pageModel.actionBoundary();
      try {
        return await this.runBrowserWaitFor(state, command, signal);
      } finally {
        state.pageModel.actionBoundary();
      }
    };
    return this.runWithAutomationReplay(state, command, execute);
  }

  private async runWithAutomationReplay(
    state: LiveBrowserSession,
    command: Exclude<BrowserAutomationCommand, { kind: 'inspect' }>,
    execute: () => Promise<BrowserAutomationRuntimeResult>,
  ): Promise<BrowserAutomationRuntimeResult> {
    const actionId = command.actionId;
    if (actionId === undefined) return execute();
    const lane = this.actionLaneFor(state);
    let store = this.automationReplays.get(lane);
    if (!store) {
      store = { entries: new Map() };
      this.automationReplays.set(lane, store);
    }
    const fingerprint = browserAutomationFingerprint(command);
    const existing = store.entries.get(actionId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return {
          ok: false,
          browser: state.snapshot,
          error: {
            code: 'invalid_payload',
            message: `Action id ${actionId} was already used for a different command. Use a new action id.`,
          },
        };
      }
      const outcome = existing.outcome ?? (await existing.pending);
      if (!outcome) {
        return {
          ok: false,
          browser: state.snapshot,
          error: {
            code: 'execution_failed',
            message: `Action id ${actionId} did not produce a result.`,
          },
        };
      }
      return this.replayAutomationOutcome(outcome, state);
    }

    const entry: BrowserAutomationReplayEntry = { fingerprint };
    const entries = store.entries;
    entries.set(actionId, entry);
    // Start now, not on a later microtask, so the action enters the lane in
    // arrival order relative to commands without an actionId.
    let started: Promise<BrowserAutomationRuntimeResult>;
    try {
      started = execute();
    } catch (error) {
      started = Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    const pending = started.then(
      (result): BrowserAutomationRetainedOutcome =>
        'ok' in result
          ? compactBrowserAutomationResponse(result)
          : {
              kind: 'post-dispatch-unknown',
              receipt: result.receipt,
              capturedRuntimeGeneration: result.capturedRuntimeGeneration,
              ...(result.repeated ? { repeated: true } : {}),
              ...(result.dialog ? { dialog: result.dialog } : {}),
              ...(result.handledDialog
                ? { handledDialog: result.handledDialog }
                : {}),
            },
      (error: unknown): BrowserAutomationRetainedOutcome =>
        compactBrowserAutomationResponse({
          ok: false,
          browser: state.snapshot,
          error: {
            code: 'execution_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        }),
    );
    entry.pending = pending;
    void pending.then((outcome): void => {
      entry.outcome = outcome;
      entry.pending = undefined;
      // Nothing reached the page, so a retry or a new command may use the id.
      if (
        outcome.kind === 'response' &&
        outcome.response.receipt?.status === 'not_executed' &&
        entries.get(actionId) === entry
      )
        entries.delete(actionId);
    });
    const outcome = await pending;
    return this.replayAutomationOutcome(outcome, state, false);
  }

  private replayAutomationOutcome(
    outcome: BrowserAutomationRetainedOutcome,
    state: LiveBrowserSession,
    repeated = true,
  ): BrowserAutomationRuntimeResult {
    if (outcome.kind === 'post-dispatch-unknown') {
      const unknown: BrowserAutomationRetainedUnknown = {
        kind: 'post-dispatch-unknown',
        receipt: outcome.receipt,
        capturedRuntimeGeneration: outcome.capturedRuntimeGeneration,
        ...(repeated ? { repeated: true } : {}),
        ...(outcome.dialog ? { dialog: outcome.dialog } : {}),
        ...(outcome.handledDialog
          ? { handledDialog: outcome.handledDialog }
          : {}),
      };
      this.postDispatchUnknownResults.add(unknown);
      return unknown;
    }
    return {
      ...outcome.response,
      browser: state.snapshot,
      ...(repeated ? { repeated: true } : {}),
    };
  }

  private noteInputPresentation(state: LiveBrowserSession): void {
    state.presentationChangedAt = Date.now();
    state.inputPresentationRevision =
      (state.inputPresentationRevision ?? 0) + 1;
  }

  private async waitForInputPresentation(
    state: LiveBrowserSession,
    send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    signal: AbortSignal,
    budget: { deadline?: number },
  ): Promise<void> {
    // Initial attachment is deliberately hidden; it must never hold up agents.
    if (!state.visible && !state.hasBeenShown) return;
    const changedAt = state.presentationChangedAt;
    const recent = changedAt !== undefined && Date.now() - changedAt < 250;
    if (
      !recent &&
      !state.visible &&
      (!state.hostWindow || state.hostWindow.isDestroyed())
    )
      return;
    const readViewport = async (): Promise<boolean> => {
      signal.throwIfAborted();
      const response = await send('Runtime.evaluate', {
        expression: '({ width: innerWidth, height: innerHeight })',
        returnByValue: true,
      });
      const value =
        isRecord(response) && isRecord(response.result)
          ? response.result.value
          : undefined;
      return (
        isRecord(value) &&
        typeof value.width === 'number' &&
        typeof value.height === 'number' &&
        value.width > 0 &&
        value.height > 0
      );
    };
    if (!recent && (await readViewport())) return;
    budget.deadline ??= Date.now() + 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = (): void => undefined;
    const stopped = new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        resolve,
        Math.max(0, (budget.deadline ?? Date.now()) - Date.now()),
      );
      abort = (): void =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Browser input was cancelled.'),
        );
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    let finished = false;
    const wait = async (): Promise<void> => {
      while (!finished && !signal.aborted) {
        if (
          (await readViewport()) &&
          Date.now() - (state.presentationChangedAt ?? 0) >= 100
        )
          return;
        if (finished) return;
        await this.pauseBrowserInput(25, signal);
      }
      signal.throwIfAborted();
    };
    // A slow CDP sample is bounded too. The race observes late rejections.
    try {
      await Promise.race([wait(), stopped]);
    } finally {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  private async pauseBrowserInput(
    ms: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      const abort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', abort, { once: true });
    });
    signal.throwIfAborted();
  }

  /** Phase 03: input only is serialized; reads and dialog answers stay independent. */
  private async runBrowserInputAction(
    state: LiveBrowserSession,
    command: Exclude<
      BrowserAutomationCommand,
      {
        kind:
          | 'inspect'
          | 'wait_for'
          | 'upload_files'
          | 'request_files'
          | 'drop_files';
      }
    >,
    signal?: AbortSignal,
  ): Promise<BrowserAutomationRuntimeResult> {
    const startedAt = Date.now();
    const actionId = command.actionId ?? randomUUID();
    const timeoutMs = browserAutomationTimeoutMs(command);
    const generation = state.snapshot.profile?.runtimeGeneration ?? 0;
    const runtime: BrowserRuntimeKey = {
      browserId: state.snapshot.id,
      runtimeGeneration: generation,
      taskIncarnationId: state.snapshot.profile?.taskIncarnationId ?? '',
    };
    const lane = this.actionLaneFor(state);
    let failure: BrowserActionError | undefined;
    let inputMode: BrowserInputMode | undefined;
    let formResult: FormActionResult | undefined;
    let inputStarted = false;
    let handledDialogForUnknown:
      | BrowserHandleJavaScriptDialogResponse
      | undefined;
    let dialogForUnknown: BrowserJavaScriptDialog | undefined;
    const warnings: string[] = [];
    const receipt = (
      sequence: number,
      status: BrowserActionReceipt['status'],
    ): BrowserActionReceipt => ({
      actionId,
      sequence,
      kind: command.kind,
      status,
      ...(inputMode &&
      (inputStarted ||
        !['fill', 'type', 'set_checked', 'select_option'].includes(
          command.kind,
        ))
        ? { inputMode }
        : {}),
      ...(warnings.length ? { warnings: [...warnings] } : {}),
      durationMs: Date.now() - startedAt,
    });
    const fail: (code: BrowserActionErrorCode, message?: string) => never = (
      code,
      message,
    ) => {
      failure = browserInputError(code, message);
      throw new Error(failure.message);
    };
    const outcome = await lane.run(
      async (context): Promise<BrowserAutomationResponse> => {
        const host = state.pageModel;
        // D11: tracking is not released from here until the action's
        // cleanup, so never between its effect baseline and its effects.
        context.registerCleanup(host.beginActivity());
        host.actionBoundary();
        context.registerCleanup((): void => host.actionBoundary());
        if (state.snapshot.pickMode && command.kind !== 'fill')
          fail(
            'execution_failed',
            'The user is picking an element. Try again after they finish.',
          );
        if (state.pendingDialog) {
          fail('dialog_pending');
        }
        const combo =
          command.kind === 'press'
            ? parseKeyCombo(command.key, hostKeyPlatform())
            : undefined;
        if (combo && !combo.ok)
          fail('execution_failed', 'The requested key is not supported.');
        if (combo?.ok && isChordRefused(combo, hostKeyPlatform()))
          fail(
            'policy_denied',
            'This keyboard shortcut is reserved or could paste private clipboard data.',
          );
        if (state.mainFrameId === undefined) {
          // Page.enable may miss the initial commit. Discover identity only on
          // the input-action path, before resolution or any dispatch boundary.
          const revision = state.actionDocumentRevision ?? 0;
          const value: unknown =
            await state.view.webContents.debugger.sendCommand(
              'Page.getFrameTree',
              {},
            );
          context.signal.throwIfAborted();
          if (
            state.mainFrameId === undefined &&
            (state.actionDocumentRevision ?? 0) === revision &&
            isRecord(value) &&
            isRecord(value.frameTree) &&
            isRecord(value.frameTree.frame)
          ) {
            const frame = value.frameTree.frame;
            const frameId = optionalString(frame.id);
            if (frameId) {
              state.mainFrameId = frameId;
              const url = optionalString(frame.url);
              if (url) state.frameUrls.set(frameId, url);
            }
          }
        }
        const actionFrame = state.mainFrameId;
        const actionDocumentUrl = state.snapshot.url;
        const actionDocumentRevision = state.actionDocumentRevision ?? 0;
        let blockedDialog: BrowserJavaScriptDialog | undefined;
        const dialogBlockedCommands = new Set<(error: Error) => void>();
        const blockOnDialog = (dialog: BrowserJavaScriptDialog): void => {
          blockedDialog = dialog;
          dialogForUnknown = dialog;
          for (const reject of Array.from(dialogBlockedCommands))
            reject(new BrowserDialogPendingError(dialog));
          this.rejectPendingCommandsForDialog(state, dialog);
        };
        // Observe the real completion/rejection, but do not drain a command that
        // Chromium has suspended on a dialog already reported to the caller.
        const dialogAwareCommand = <T>(command: Promise<T>): Promise<T> =>
          new Promise((resolve, reject) => {
            const fail = (error: Error): void => {
              dialogBlockedCommands.delete(fail);
              reject(error);
            };
            dialogBlockedCommands.add(fail);
            void command.then(
              (value): void => {
                dialogBlockedCommands.delete(fail);
                resolve(value);
              },
              (error: unknown): void => {
                dialogBlockedCommands.delete(fail);
                reject(
                  error instanceof Error ? error : new Error(String(error)),
                );
              },
            );
            if (blockedDialog)
              fail(new BrowserDialogPendingError(blockedDialog));
          });
        let dispatched = false;
        let editorInput = false;
        let editorValueInputSent = false;
        // Set once the target resolves: input by coordinates or keys goes to
        // whatever document the target's frame shows, so it must still be
        // the target's (review R2 finding 1).
        const fence = { document: (): void => undefined };
        const dispatchContext: ActionLaneContext = {
          ...context,
          beginDispatch: (): void => {
            if (!dispatched) {
              fence.document();
              if (state.pendingDialog) fail('dialog_pending');
              state.activeActionDialog =
                inputMode !== 'synthetic' ? onActionDialog : undefined;
            }
            context.beginDispatch();
            if (!dispatched) this.taskFiles.setAttribution(runtime, actionId);
            dispatched = true;
            inputStarted = true;
            state.activeActionContext = dispatchContext;
          },
        };
        // Called after a press reached the page, for a frame target's
        // delivery confirmation; set once its recorder is armed.
        let afterPress: (() => void) | undefined;
        /** Any CDP session; `''` or none is the root (the top-level page). */
        const send = (
          method: string,
          params: Record<string, unknown>,
          sessionId?: string,
        ): Promise<unknown> => {
          context.signal.throwIfAborted();
          // Synchronously before every input event, the click's move,
          // press and release included (held input is released through
          // cleanupSend, unfenced, so nothing stays pressed).
          if (
            method.startsWith('Input.') ||
            method === 'DOM.focus' ||
            (method === 'Runtime.callFunctionOn' && params.userGesture === true)
          )
            fence.document();
          if (
            editorInput &&
            ((method === 'Input.dispatchKeyEvent' &&
              params.type === 'keyDown' &&
              typeof params.text === 'string') ||
              (method === 'Runtime.callFunctionOn' &&
                params.userGesture === true))
          )
            editorValueInputSent = true;
          const debug = state.view.webContents.debugger;
          const promise = sessionId
            ? debug.sendCommand(method, params, sessionId)
            : debug.sendCommand(method, params);
          const tracked = dispatched
            ? context.trackCommand(dialogAwareCommand(promise))
            : promise;
          if (afterPress && isPressEvent(method, params)) {
            const confirm = afterPress;
            void tracked.then(confirm, () => undefined);
          }
          return tracked;
        };
        const cleanupSend = (
          method: string,
          params: Record<string, unknown>,
          sessionId?: string,
        ): Promise<unknown> => {
          const debug = state.view.webContents.debugger;
          const promise = sessionId
            ? debug.sendCommand(method, params, sessionId)
            : debug.sendCommand(method, params);
          return dispatched
            ? context.trackCommand(dialogAwareCommand(promise))
            : promise;
        };
        context.registerCleanup((): void => {
          state.activeActionDialog = undefined;
          state.activeActionContext = undefined;
        });
        if (
          (command.kind === 'hover' || command.kind === 'drag') &&
          !state.hasBeenShown
        )
          fail(
            'target_not_visible',
            'The browser view has not been shown, so it has no size.',
          );
        const request = actionTargetRequest(command);
        if (!request) fail('target_not_found');
        // Page.enable can miss the initial commit; the model needs the
        // root frame's identity before it can resolve anything.
        await this.ensurePageModelReady(state);
        context.signal.throwIfAborted();
        // D7: one resolution to an identity and a retained object in the
        // target's own session; nothing re-runs a locator after dispatch.
        const hold = async (
          request: Parameters<typeof holdActionTarget>[0]['request'],
        ): Promise<ResolvedActionTarget> => {
          try {
            return await holdActionTarget({
              host,
              request,
              lane: context,
              isDispatched: () => dispatched,
              watchDialogs: (listener) => {
                state.pendingDialogWaiters.add(listener);
                if (state.pendingDialog) listener(state.pendingDialog);
                return (): void => {
                  state.pendingDialogWaiters.delete(listener);
                };
              },
            });
          } catch (error) {
            if (error instanceof TargetDialogError) fail('dialog_pending');
            if (error instanceof TargetResolutionError)
              fail(error.code, resolutionMessage(error));
            throw error;
          }
        };
        // A hover past the top or left edge leaves the page (exit-intent
        // popups watch for it): the target is the page, and the move goes to
        // the point itself.
        const offPagePoint =
          command.kind === 'hover' &&
          command.x !== undefined &&
          command.y !== undefined &&
          (command.x < 0 || command.y < 0)
            ? { x: command.x, y: command.y }
            : undefined;
        const target = await hold(offPagePoint ? { kind: 'page' } : request);
        let destination: ResolvedActionTarget | undefined;
        const sameDocument = (other: ResolvedActionTarget): boolean =>
          other.identity.sessionId === target.identity.sessionId &&
          other.identity.frameId === target.identity.frameId &&
          other.identity.loaderId === target.identity.loaderId;
        const wrongDragDocument = (): never =>
          fail(
            'unsupported_capability',
            'Drag works within one document; the destination is in another frame.',
          );
        if (
          command.kind === 'drag' &&
          (command.to.ref !== undefined || command.to.locator !== undefined)
        ) {
          destination = await hold(
            command.to.ref !== undefined
              ? { kind: 'ref', ref: command.to.ref }
              : {
                  kind: 'locator',
                  locator: command.to.locator,
                  frame: command.to.frame,
                },
          );
          if (!sameDocument(destination)) wrongDragDocument();
        }
        const resolvedTarget = target;
        const scrollFences: ResolvedActionTarget[] = [];
        fence.document = (): void => {
          if (
            host.isTargetDocumentCurrent(resolvedTarget) &&
            (!destination || host.isTargetDocumentCurrent(destination)) &&
            scrollFences.every((owner) => host.isTargetDocumentCurrent(owner))
          )
            return;
          // After dispatch began, the lane reports the outcome unknown.
          if (dispatched)
            throw new Error(
              'The frame showed another document before all input was sent.',
            );
          fail(
            'frame_unavailable',
            'The frame navigated or closed before input was sent. Run browser.input_snapshot for current references.',
          );
        };
        const formAction =
          command.kind === 'fill' ||
          command.kind === 'type' ||
          command.kind === 'set_checked' ||
          command.kind === 'select_option';
        let hostTarget: ResolvedActionTarget | undefined;
        // Read before input for every target, so the receipt keeps it
        // secret even when the page drops its secret marker.
        let secret = true;
        if (formAction || command.kind === 'click') {
          hostTarget = await host.hostActionTarget(target);
          context.signal.throwIfAborted();
          fence.document();
          if (!hostTarget) fail('target_stale');
          secret = await host.isActionTargetSecret(target);
          if (command.kind === 'click') {
            try {
              await refuseClickControl({ send, target: hostTarget, secret });
            } catch (error) {
              if (error instanceof FormActionError) failure = error.error;
              throw error;
            }
          }
        } else {
          secret = await host.isActionTargetSecret(target);
          context.signal.throwIfAborted();
        }
        // What the page recorder reports from here on waits for the action
        // to end, when it is known whether the target was secret: a list
        // can turn out secret when it opens, or only as the input runs.
        const actionWindow: AgentActionWindow = { from: Date.now(), held: [] };
        pushRing((state.agentActionWindows ??= []), actionWindow, 8);
        context.registerCleanup(async (): Promise<void> => {
          this.taskFiles.setAttribution(runtime, undefined);
          const held = actionWindow.held.length > 0 && state.snapshot.recording;
          // A failed check counts as secret.
          actionWindow.secret =
            secret ||
            (held &&
              (await host.isActionTargetSecret(target).catch(() => true)));
          actionWindow.to = Date.now();
          // Page steps and downloads in the order they happened; on a tie the
          // page step goes first, as it is what started the download.
          const entries = [
            ...actionWindow.held.splice(0).map((page) => ({
              at: page.step.timestamp,
              page,
            })),
            ...(actionWindow.downloads ?? []).splice(0).map((download) => ({
              at: download.timestamp,
              download,
            })),
          ].sort(
            (a, b) =>
              a.at - b.at || Number('download' in a) - Number('download' in b),
          );
          for (const entry of entries) {
            // What began before this recording started, or was cleared,
            // belongs to an earlier one.
            if (
              !state.snapshot.recording ||
              entry.at < (state.recordingStartedAt ?? 0)
            )
              continue;
            if ('page' in entry)
              this.recordActionPageStep(
                state,
                actionWindow,
                entry.page.step,
                entry.page.secretElement,
              );
            else this.addRecordingStep(state, entry.download);
          }
        });
        const targetSession = target.identity.sessionId;
        const targetFrame = host.registry.getFrame(target.identity.frameId);
        // The top-level document: its delivery confirmation, dialog rules
        // and focus are phase 03's. Any other frame uses its own.
        const topDocument =
          targetSession === '' && targetFrame?.parentId === undefined;
        const frameUrl = targetFrame?.url;
        let mapping: DocumentMapping | undefined;
        // One coordinate rule for every target (see actionability.ts).
        const frameMapping = async (): Promise<DocumentMapping | undefined> => {
          mapping = await host.documentMapping(target);
          return mapping;
        };
        const outerHitTest = (point: {
          x: number;
          y: number;
        }): Promise<{ receivesEvents: boolean; cover?: string }> =>
          host.outerHitTest(target, point);
        const untargetedPress =
          (command.kind === 'press' || command.kind === 'type') &&
          command.ref === undefined &&
          command.locator === undefined;
        const presentationBudget: { deadline?: number } = {};
        const forcedClick = command.kind === 'click' && command.force === true;
        if (
          (command.kind === 'click' ||
            command.kind === 'hover' ||
            command.kind === 'drag') &&
          !forcedClick
        )
          await this.waitForInputPresentation(
            state,
            send,
            context.signal,
            presentationBudget,
          );
        let checkedPresentationRevision = state.inputPresentationRevision;
        const exactHoverPoint =
          command.kind === 'hover' && command.x !== undefined && !offPagePoint
            ? await host.sessionPoint(target, { x: command.x, y: command.y })
            : undefined;
        if (
          command.kind === 'hover' &&
          command.x !== undefined &&
          !offPagePoint &&
          !exactHoverPoint
        )
          fail('frame_unavailable');
        // A form action waits, as `focus` does, for an attached and enabled
        // target until timeoutMs; its own algorithm reads the rest.
        const actionable: ActionabilityResult =
          command.kind === 'scroll'
            ? { status: 'ready' }
            : offPagePoint
              ? { status: 'ready', point: offPagePoint }
              : forcedClick
                ? { status: 'ready' }
                : untargetedPress
                  ? { status: 'ready' }
                  : await checkActionability({
                      send,
                      sessionId: targetSession,
                      objectId: target.objectId,
                      backendNodeId: target.identity.backendNodeId,
                      action: formAction ? 'focus' : command.kind,
                      ...(exactHoverPoint
                        ? { exactPoint: exactHoverPoint, scrollIntoView: false }
                        : {}),
                      ...(command.kind === 'click' && command.position
                        ? { position: command.position }
                        : {}),
                      timeoutMs,
                      signal: context.signal,
                      frameMapping,
                      outerHitTest,
                    });
        if (actionable.status === 'not_executed')
          fail(actionable.code, actionable.message);
        if (command.kind === 'press') {
          await this.waitForInputPresentation(
            state,
            send,
            context.signal,
            presentationBudget,
          );
          checkedPresentationRevision = state.inputPresentationRevision;
        }
        if (actionable.status === 'fallback' && !forcedClick)
          warnings.push(actionable.warning);
        context.signal.throwIfAborted();
        // D11: DOM events flow for every session before the baseline, so
        // effects.domChanged and the settle window see the whole page.
        await host.establishTracking();
        context.signal.throwIfAborted();
        let dragEnd: { x: number; y: number } | undefined;
        if (command.kind === 'drag') {
          if (actionable.status !== 'ready' || !actionable.point)
            fail('target_not_visible');
          const start = actionable.point;
          if (!destination) {
            const topStart = await host.topPoint(target, start);
            if (!topStart) fail('frame_unavailable');
            const topEnd =
              command.to.x !== undefined
                ? { x: command.to.x, y: command.to.y }
                : command.to.dx !== undefined
                  ? {
                      x: topStart.x + command.to.dx,
                      y: topStart.y + command.to.dy,
                    }
                  : undefined;
            if (!topEnd || topEnd.x < 0 || topEnd.y < 0)
              fail(
                'target_not_visible',
                'The drag destination is not in view with the source.',
              );
            const endpoint = await host.sessionPoint(target, topEnd);
            const viewport = await host.readDocumentViewport(target);
            const map = await frameMapping();
            if (!endpoint || !viewport || !map) fail('frame_unavailable');
            const localX = (endpoint.x - map.originX) / map.scaleX,
              localY = (endpoint.y - map.originY) / map.scaleY;
            if (
              localX < 0 ||
              localY < 0 ||
              localX >= viewport.width ||
              localY >= viewport.height
            )
              fail(
                'target_not_visible',
                'The drag destination is not in view with the source.',
              );
            try {
              destination = await hold({ kind: 'point', ...topEnd });
            } catch (error) {
              if (
                error instanceof Error &&
                failure?.code === 'target_not_found'
              )
                fail(
                  'target_not_visible',
                  'The drag destination is not in view with the source.',
                );
              throw error;
            }
            if (!sameDocument(destination)) wrongDragDocument();
            dragEnd =
              destination.point ?? (await host.sessionPoint(target, topEnd));
          }
          const endCheck = await checkActionability({
            send,
            sessionId: targetSession,
            objectId: destination.objectId,
            backendNodeId: destination.identity.backendNodeId,
            action: 'hover',
            scrollIntoView: false,
            ...(dragEnd ? { exactPoint: dragEnd } : {}),
            timeoutMs,
            signal: context.signal,
            frameMapping: () => host.documentMapping(destination ?? target),
            outerHitTest: (point) =>
              host.outerHitTest(destination ?? target, point),
          });
          if (endCheck.status === 'not_executed')
            fail(
              endCheck.code,
              endCheck.code === 'target_not_visible'
                ? 'The drag destination is not in view with the source.'
                : endCheck.message,
            );
          if (endCheck.status !== 'ready' || !endCheck.point)
            fail(
              'target_not_visible',
              'The drag destination is not in view with the source.',
            );
          dragEnd = endCheck.point;
          // Destination holding/checks may take time; refresh the source without scrolling again.
          const sourceCheck = await checkActionability({
            send,
            sessionId: targetSession,
            objectId: target.objectId,
            backendNodeId: target.identity.backendNodeId,
            action: 'drag',
            scrollIntoView: false,
            timeoutMs,
            signal: context.signal,
            frameMapping,
            outerHitTest,
          });
          if (sourceCheck.status === 'not_executed')
            fail(sourceCheck.code, sourceCheck.message);
          if (sourceCheck.status !== 'ready' || !sourceCheck.point)
            fail('target_not_visible');
          actionable.point = sourceCheck.point;
        }
        // A hover or drag on an element scrolled it into view before its
        // point was measured; a hover at a point scrolled nothing.
        const elementSource =
          command.kind === 'drag' ||
          (command.kind === 'hover' && command.x === undefined);
        const recordingLocator =
          state.snapshot.recording &&
          (command.kind === 'scroll' ||
            command.kind === 'fill' ||
            command.kind === 'type' ||
            elementSource)
            ? await host.recordingLocator(target).catch(() => undefined)
            : undefined;
        const recordingStart =
          state.snapshot.recording &&
          actionable.status === 'ready' &&
          actionable.point
            ? await host.topPoint(target, actionable.point)
            : undefined;
        // Where the element's box was when that point was measured, so the
        // recorded step can find the point from the element again.
        const recordingOrigin =
          recordingStart && recordingLocator && elementSource
            ? await host.boxOrigin(target).catch(() => undefined)
            : undefined;
        const recordingSource = {
          point: recordingStart,
          ...(recordingOrigin
            ? { locator: recordingLocator, origin: recordingOrigin }
            : { unlocated: elementSource }),
        };
        const recordingEnd =
          state.snapshot.recording && dragEnd
            ? await host.topPoint(target, dragEnd)
            : undefined;
        let scrollResult: AmountScrollResult | undefined;
        const scrollOwners: Array<{
          target: ResolvedActionTarget;
          before: ScrollState;
          page: boolean;
        }> = [];
        if (command.kind === 'scroll') {
          if (command.direction !== undefined) {
            const before = await host.readScrollState(target);
            const axis =
              command.direction === 'left' || command.direction === 'right'
                ? 'x'
                : 'y';
            const page =
              command.ref === undefined && command.locator === undefined;
            if (!page && !(axis === 'x' ? before.scriptX : before.scriptY))
              fail(
                'unsupported_control',
                'This element does not scroll in that direction. Use browser.scroll without a target to scroll the page.',
              );
            scrollOwners.push({ target, before, page });
          } else {
            const page = await hold({ kind: 'page' });
            const ancestors = await host.scrollAncestors(
              target,
              (sessionId) => {
                context.registerCleanup(async (): Promise<void> => {
                  await cleanupSend(
                    'Runtime.releaseObjectGroup',
                    { objectGroup: target.objectGroup },
                    sessionId,
                  ).catch(() => undefined);
                });
              },
            );
            // For a text match these start at the text node, so they hold
            // the element around the text and any scroller around its slot.
            for (const owner of ancestors) {
              scrollOwners.push({
                target: owner,
                before: await host.readScrollState(owner),
                page:
                  owner.identity.frameId === page.identity.frameId &&
                  owner.identity.backendNodeId === page.identity.backendNodeId,
              });
            }
            if (!scrollOwners.some((owner) => owner.page))
              scrollOwners.push({
                target: page,
                before: await host.readScrollState(page),
                page: true,
              });
          }
        }
        scrollFences.push(...scrollOwners.map((owner) => owner.target));
        const focusDocument = topDocument
          ? undefined
          : { objectId: target.objectId, sessionId: targetSession };
        const baseline = await captureEffectBaseline({
          send,
          mutationCount: () => state.actionMutationCount ?? 0,
          ...(focusDocument ? { focusDocument } : {}),
        });
        const navigationBefore = state.navigationSequence;
        const urlBefore = state.snapshot.url;
        let focusEmulated = true;
        if (command.kind !== 'focus' && command.kind !== 'scroll') {
          try {
            await send('Emulation.setFocusEmulationEnabled', {
              enabled: true,
            });
          } catch {
            focusEmulated = false;
            if (command.kind === 'hover' || command.kind === 'drag')
              fail(
                'execution_failed',
                'The browser view cannot receive pointer input.',
              );
            warnings.push(
              'Focus emulation was unavailable; used the direct element action.',
            );
          }
        }
        context.signal.throwIfAborted();
        if (state.pendingDialog) fail('dialog_pending');
        const dialogResponse =
          'dialogResponse' in command ? command.dialogResponse : undefined;
        let handling: Promise<void> | undefined;
        const consumed = new Set<string>();
        let responseConsumed = false;
        // The document the action ran in: the top-level page's, as in
        // phase 03, or the target frame's, which a dialog from that frame
        // must come from (same frame, same document, same URL) to be
        // answered by a pre-armed response.
        const dialogMatchesDocument = (
          dialog: BrowserJavaScriptDialog,
        ): boolean => {
          if (topDocument)
            return (
              actionFrame !== undefined &&
              dialog.frameId === actionFrame &&
              state.mainFrameId === actionFrame &&
              (state.actionDocumentRevision ?? 0) === actionDocumentRevision &&
              dialog.url === actionDocumentUrl &&
              state.snapshot.url === actionDocumentUrl
            );
          return (
            dialogFromTargetDocument(
              dialog,
              target.identity,
              frameUrl,
              host.registry.getFrame(target.identity.frameId),
            ) && (state.actionDocumentRevision ?? 0) === actionDocumentRevision
          );
        };
        const onActionDialog = (dialog: BrowserJavaScriptDialog): void => {
          if (context.signal.aborted) return;
          if (
            !dialogResponse ||
            (dialog.frameId !== undefined && !dialogMatchesDocument(dialog)) ||
            (topDocument
              ? dialog.url !== actionDocumentUrl
              : !dialogFromTargetDocument(
                  { ...dialog, frameId: target.identity.frameId },
                  target.identity,
                  frameUrl,
                  host.registry.getFrame(target.identity.frameId),
                )) ||
            (state.actionDocumentRevision ?? 0) !== actionDocumentRevision
          ) {
            blockOnDialog(dialog);
            return;
          }
          if (responseConsumed || consumed.has(dialog.id)) return;
          consumed.add(dialog.id);
          responseConsumed = true;
          handling = Promise.resolve()
            .then(async (): Promise<void> => {
              // A private callback alone supplies no CDP frame identity. Wait for
              // its correlated CDP report before exposing any pre-armed text.
              const deadline = Date.now() + 250;
              while (
                state.pendingDialog?.id === dialog.id &&
                Date.now() < deadline &&
                (state.pendingDialog.frameId === undefined ||
                  state.appDialog?.dialogId !== dialog.id)
              ) {
                await this.pauseBrowserInput(
                  Math.min(25, deadline - Date.now()),
                  context.signal,
                );
              }
              const pending = state.pendingDialog;
              if (
                !pending ||
                pending.id !== dialog.id ||
                !dialogMatchesDocument(pending)
              ) {
                if (pending) blockOnDialog(pending);
                return;
              }
              handledDialogForUnknown = await this.handleDialog({
                browserId: state.snapshot.id,
                dialogId: pending.id,
                ...dialogResponse,
              });
            })
            .catch((): void => {
              warnings.push(
                'The pre-armed dialog response could not be acknowledged.',
              );
              if (state.pendingDialog) blockOnDialog(state.pendingDialog);
            });
        };
        const delivery = {
          expected: false,
          matched: false,
          deadline: Infinity,
          finished: false,
        };
        const actionExpectations: NonNullable<
          LiveBrowserSession['expectedAgentInput']
        > = [];
        context.registerCleanup((): void => {
          delivery.finished = true;
          actionExpectations.forEach((item) => {
            item.expiresAt = Math.min(item.expiresAt, Date.now() + 2_000);
          });
        });
        // The main frame's preload reports trusted input only for its own
        // document. Input to a target in any other frame is confirmed by a
        // recorder in that frame's document; without one it stays
        // unconfirmed, and the receipt says so.
        fence.document();
        const recorder =
          topDocument || command.kind === 'hover' || command.kind === 'scroll'
            ? undefined
            : await holdInputRecorder({
                arm: () => host.armInputRecorder(resolvedTarget),
                lane: context,
                isDispatched: () => dispatched,
              });
        context.signal.throwIfAborted();
        fence.document();
        const frameDelivery =
          topDocument || command.kind === 'hover' || command.kind === 'scroll'
            ? undefined
            : new FrameDelivery({
                recorder,
                track: <T>(command: Promise<T>): Promise<T> =>
                  context.trackCommand(command),
                open: (): boolean =>
                  !delivery.finished && Date.now() <= delivery.deadline,
                onMatch: (): void => {
                  delivery.matched = true;
                  this.notifyActionSettle(state);
                },
                mapping: (): DocumentMapping | undefined => mapping,
              });
        if (frameDelivery)
          afterPress = (): void => {
            void frameDelivery.confirm();
          };
        const beforeInput = (event: InputAttribution): void => {
          if (
            event.type !== 'mousePressed' &&
            event.type !== 'keyDown' &&
            event.type !== 'rawKeyDown'
          )
            return;
          if (formAction) inputMode = 'trusted';
          const first = !delivery.expected;
          delivery.expected = true;
          if (frameDelivery) {
            frameDelivery.expect(event);
            return;
          }
          const expected = state.expectedAgentInput ?? [];
          state.expectedAgentInput = expected.filter(
            (item) => Date.now() <= item.expiresAt,
          );
          const expectation = {
            type: event.type === 'mousePressed' ? 'pointerdown' : 'keydown',
            ...(event.type === 'mousePressed'
              ? {
                  button: mouseButtonNumber(event.button),
                  clientX: event.x,
                  clientY: event.y,
                }
              : { key: event.key }),
            timestamp: event.timestamp,
            expiresAt: Date.now() + 13_000,
            ...(first
              ? {
                  confirm: (): void => {
                    if (!delivery.finished && Date.now() <= delivery.deadline) {
                      delivery.matched = true;
                      this.notifyActionSettle(state);
                    }
                  },
                }
              : {}),
          };
          actionExpectations.push(expectation);
          state.expectedAgentInput.push(expectation);
          state.expectedAgentInput = state.expectedAgentInput.slice(-16);
        };
        if (
          command.kind !== 'fill' &&
          !forcedClick &&
          state.inputPresentationRevision !== checkedPresentationRevision
        )
          await this.waitForInputPresentation(
            state,
            send,
            context.signal,
            presentationBudget,
          );
        let completed = true;
        let pendingDialog: BrowserJavaScriptDialog | undefined;
        const synthetic = async (
          kind: 'click' | 'press',
          key: string | undefined,
          clickOptions?: {
            button?: BrowserMouseButton;
            clickCount?: number;
            modifiers?: BrowserKeyModifier[];
          },
        ): Promise<void> => {
          // The retained single-evaluation wrapper consumes only its first dialog.
          // A second native dialog must not reuse that already-consumed answer.
          state.activeActionDialog = undefined;
          const capture = await this.dispatchTrustedBrowserAction(
            state,
            kind,
            key,
            dialogResponse,
            { objectId: target.objectId, sessionId: targetSession },
            dispatchContext,
            clickOptions,
          );
          if (capture)
            handledDialogForUnknown = this.handledInterceptedPageDialog(
              state,
              capture,
              dialogResponse,
            );
        };
        if (command.kind === 'hover') {
          if (actionable.status !== 'ready' || !actionable.point)
            fail('target_not_visible');
          inputMode = 'trusted';
          // Leaving fires only for a pointer that was inside: enter at the edge first.
          if (offPagePoint) {
            const viewport = await host.readDocumentViewport(target);
            const inside = (value: number, size = Infinity): number =>
              Math.min(Math.max(1, value), size - 1);
            await dispatchHover({
              send,
              sessionId: '',
              lane: dispatchContext,
              point: {
                x: inside(offPagePoint.x, viewport?.width),
                y: inside(offPagePoint.y, viewport?.height),
              },
            });
          }
          await dispatchHover({
            send,
            // The off-page point is in top-level viewport coordinates.
            sessionId: offPagePoint ? '' : targetSession,
            lane: dispatchContext,
            point: actionable.point,
          });
          // shortcut: an off-page move is not recorded; add a mouse.move step if recordings need it.
          if (state.snapshot.recording && !offPagePoint)
            this.addRecordingStep(
              state,
              pointerRecording({ action: 'hover', ...recordingSource }),
            );
        } else if (command.kind === 'drag') {
          if (actionable.status !== 'ready' || !actionable.point || !dragEnd)
            fail('target_not_visible');
          inputMode = 'trusted';
          const dragWindow: { from: number; to?: number } = {
            from: Date.now(),
          };
          pushRing((state.agentDragWindows ??= []), dragWindow, 8);
          context.registerCleanup((): void => {
            dragWindow.to = Date.now();
          });
          const drag = await dispatchDrag({
            send,
            cleanupSend,
            sessionId: targetSession,
            lane: dispatchContext,
            from: actionable.point,
            to: dragEnd,
            steps: command.steps,
            modifiers: command.modifiers,
            beforeInput,
            subscribe: (listener) => {
              const debug = state.view.webContents.debugger;
              const onMessage = (
                _event: unknown,
                method: string,
                params: unknown,
                sessionId?: string,
              ): void => {
                if (
                  method === 'Input.dragIntercepted' &&
                  (sessionId ?? '') === targetSession &&
                  isRecord(params)
                )
                  listener(params.data);
              };
              debug.on('message', onMessage);
              return (): void => {
                debug.removeListener('message', onMessage);
              };
            },
          });
          if (drag.undelivered)
            warnings.push(
              'The page started a drag after the pointer was released; it was cancelled, not dropped.',
            );
          if (state.snapshot.recording)
            this.addRecordingStep(
              state,
              pointerRecording({
                action: 'drag',
                ...recordingSource,
                destination: recordingEnd,
                steps: command.steps,
                modifiers: command.modifiers,
              }),
            );
        } else if (command.kind === 'scroll') {
          if (command.direction !== undefined) {
            const owner = scrollOwners[0];
            if (!owner)
              fail(
                'execution_failed',
                'The scroll position could not be read.',
              );
            const axis =
              command.direction === 'left' || command.direction === 'right'
                ? 'x'
                : 'y';
            let pageSize =
              axis === 'x' ? owner.before.width : owner.before.height;
            let pagePoint: { x: number; y: number } | undefined;
            if (owner.page) {
              const metrics = await send(
                'Page.getLayoutMetrics',
                {},
                targetSession,
              ).catch(() => undefined);
              const viewport =
                isRecord(metrics) && isRecord(metrics.cssVisualViewport)
                  ? metrics.cssVisualViewport
                  : undefined;
              const size =
                axis === 'x' ? viewport?.clientWidth : viewport?.clientHeight;
              pageSize =
                typeof size === 'number' && size > 0 && Number.isFinite(size)
                  ? size
                  : 1000;
              if (
                typeof viewport?.clientWidth === 'number' &&
                typeof viewport.clientHeight === 'number'
              )
                pagePoint = {
                  x: viewport.clientWidth / 2,
                  y: viewport.clientHeight / 2,
                };
            }
            scrollResult = await dispatchAmountScroll({
              send,
              sessionId: targetSession,
              lane: dispatchContext,
              direction: command.direction,
              pages: command.pages,
              pixels: command.pixels,
              pageSize,
              fence: fence.document,
              read: () => host.readScrollState(target),
              isVisible: () => state.visible,
              recordingPoint: state.snapshot.recording
                ? (point): Promise<{ x: number; y: number } | undefined> =>
                    host.topPoint(target, point)
                : undefined,
              script: (dx, dy, beforeWrite) =>
                host.scrollBy(target, dx, dy, send, beforeWrite),
              wheelPoint: async () => {
                const current = await host.readScrollState(target);
                const local = owner.page
                  ? (pagePoint ?? current.point)
                  : current.point;
                const map = await frameMapping();
                if (!local || !map) return undefined;
                return host.wheelPoint(
                  target,
                  {
                    x: map.originX + map.scaleX * local.x,
                    y: map.originY + map.scaleY * local.y,
                  },
                  axis,
                );
              },
            });
            inputMode = scrollResult.inputMode;
            warnings.push(...scrollResult.warnings);
          } else {
            inputMode = 'direct';
            const scrollNode =
              target.scrollNode ?? target.identity.backendNodeId;
            // Chromium rejects the scroll for a node with no layout
            // (display: none), for which it reports no quads. Ask first, so
            // that is a refusal with a reason and not an unknown outcome
            // after the boundary. A display: contents element has quads
            // and scrolls.
            const quads = await send(
              'DOM.getContentQuads',
              { backendNodeId: scrollNode },
              targetSession,
            ).catch(() => undefined);
            const rendered =
              isRecord(quads) &&
              !(Array.isArray(quads.quads) && quads.quads.length === 0);
            if (!rendered)
              fail(
                'target_not_visible',
                'The element is not rendered, so it cannot be scrolled into view.',
              );
            // One text node can hold a whole log, and Chromium does not
            // move a node that is partly in view. Given where the words are
            // inside the node, it brings them into view itself, through
            // every scroller, slot, transform and frame around them.
            const words =
              command.toText === undefined
                ? undefined
                : await host
                    .textMatchRect(target, normalizeTextQuery(command.toText))
                    .catch(() => undefined);
            fence.document();
            context.signal.throwIfAborted();
            dispatchContext.beginDispatch();
            await send(
              'DOM.scrollIntoViewIfNeeded',
              { backendNodeId: scrollNode, ...(words ? { rect: words } : {}) },
              targetSession,
            );
            if (
              command.toText !== undefined &&
              (await host
                .textMatchShown(target, normalizeTextQuery(command.toText))
                .catch(() => undefined)) === false
            )
              warnings.push(
                'The matched text is still clipped or out of view after scrolling.',
              );
          }
          await Promise.all(
            scrollOwners.map((owner) =>
              waitForScrollStability(
                () => host.readScrollState(owner.target),
                context.signal,
              ),
            ),
          );
          host.actionBoundary();
          if (state.snapshot.recording)
            this.addRecordingStep(
              state,
              pointerRecording({
                action: 'scroll',
                locator: recordingLocator,
                scroll: scrollResult,
                ...(command.toText === undefined
                  ? {}
                  : { text: normalizeTextQuery(command.toText) }),
                page:
                  command.direction !== undefined &&
                  command.ref === undefined &&
                  command.locator === undefined,
                point: scrollResult?.point
                  ? await host.topPoint(target, scrollResult.point)
                  : undefined,
              }),
            );
        } else if (
          command.kind === 'fill' ||
          command.kind === 'type' ||
          command.kind === 'set_checked' ||
          command.kind === 'select_option'
        ) {
          if (!hostTarget) fail('target_stale');
          const formTarget = hostTarget;
          const formOptions: FormActionOptions = {
            send,
            cleanupSend,
            lane: dispatchContext,
            target: formTarget,
            secret,
            refreshSecret: async (): Promise<boolean> => {
              if (!secret) secret = await host.isActionTargetSecret(target);
              return secret;
            },
            classifyInputTarget: async (inputTarget): Promise<boolean> => {
              if (!secret)
                secret = await host
                  .isActionTargetSecret(inputTarget)
                  .catch(() => true);
              return secret;
            },
            markSecret: (): void => {
              secret = true;
            },
            pickMode: state.snapshot.pickMode,
            onEditor: (): void => {
              editorInput = true;
              const editorWindow: { from: number; to?: number } = {
                from: Date.now(),
              };
              pushRing((state.agentEditorWindows ??= []), editorWindow, 8);
              context.registerCleanup((): void => {
                editorWindow.to = Date.now();
              });
            },
            timeoutMs,
            beforeInput,
            getPendingDialog: () => state.pendingDialog,
            focus: (related) =>
              dispatchFocus({
                send,
                cleanupSend,
                sessionId: targetSession,
                lane: dispatchContext,
                objectId: related?.objectId ?? formTarget.objectId,
                backendNodeId:
                  related?.backendNodeId ?? formTarget.identity.backendNodeId,
                timeoutMs,
                frameMapping,
                outerHitTest,
                beforeInput,
                getPendingDialog: () => state.pendingDialog,
              }),
            click: async (
              related,
              clickCount,
            ): Promise<Awaited<ReturnType<typeof dispatchClick>>> => {
              fence.document();
              await this.waitForInputPresentation(
                state,
                send,
                context.signal,
                presentationBudget,
              );
              if (!focusEmulated)
                throw new FormActionError(
                  browserInputError(
                    'execution_failed',
                    'The browser view cannot receive pointer input.',
                  ),
                );
              const relatedTarget: ResolvedActionTarget = {
                ...target,
                objectId: related.objectId,
                identity: {
                  ...target.identity,
                  backendNodeId: related.backendNodeId,
                },
              };
              const ready = await checkActionability({
                send,
                sessionId: targetSession,
                objectId: related.objectId,
                backendNodeId: related.backendNodeId,
                action: 'click',
                timeoutMs,
                signal: context.signal,
                canUseDirectFallback: false,
                frameMapping: () => host.documentMapping(relatedTarget),
                outerHitTest: (point) =>
                  host.outerHitTest(relatedTarget, point),
              });
              if (ready.status === 'not_executed')
                throw new FormActionError(
                  browserInputError(ready.code, ready.message),
                );
              if (ready.status !== 'ready' || !ready.point)
                throw new FormActionError(
                  browserInputError('target_not_visible'),
                );
              return dispatchClick({
                send,
                cleanupSend,
                sessionId: targetSession,
                lane: dispatchContext,
                point: ready.point,
                clickCount,
                beforeInput,
                getPendingDialog: () => state.pendingDialog,
              });
            },
          };
          try {
            if (command.kind === 'fill') {
              inputMode = 'direct';
              formResult = await runFill({
                ...formOptions,
                text: command.text,
                platform: hostKeyPlatform(),
                fillDirect: async (): Promise<unknown> => {
                  // A fill is completion-only, as the preload's was: cancelling
                  // the action does not end the wait, so the lane admits the
                  // next action only after this fill stopped (or its document
                  // went away, or 15 s passed). A cancelled fill stops before
                  // its setter, and nothing writes once this wait gives up.
                  const stopFill = new AbortController();
                  const stop = (): void => stopFill.abort();
                  context.signal.addEventListener('abort', stop, {
                    once: true,
                  });
                  if (context.signal.aborted) stop();
                  try {
                    const value = await dialogAwareCommand(
                      documentCommand(
                        state,
                        'fill-prepared',
                        host.fillActionTarget(
                          target,
                          command.text,
                          stopFill.signal,
                          send,
                        ),
                        undefined,
                        PREPARED_COMMAND_TIMEOUT_MS,
                      ),
                    );
                    if (value !== 'filled')
                      throw new Error(
                        value === 'not_fillable'
                          ? 'The prepared fill target is not fillable.'
                          : 'Prepared fill target became unavailable.',
                      );
                    return value;
                  } finally {
                    context.signal.removeEventListener('abort', stop);
                    stop();
                  }
                },
              });
            } else if (command.kind === 'type') {
              inputMode = 'trusted';
              formResult = await runType({
                ...formOptions,
                text: command.text,
                delayMs: command.delayMs,
                targeted: !untargetedPress,
              });
            } else if (command.kind === 'set_checked') {
              inputMode = 'trusted';
              formResult = await runSetChecked({
                ...formOptions,
                checked: command.checked,
              });
            } else {
              inputMode = 'direct';
              const choice =
                command.values !== undefined
                  ? { values: command.values }
                  : command.labels !== undefined
                    ? { labels: command.labels }
                    : { indexes: command.indexes };
              formResult = await runSelectOption({
                ...formOptions,
                choice,
                searchText: command.searchText,
              });
            }
          } catch (error) {
            if (error instanceof FormActionError) failure = error.error;
            throw error;
          }
          // A control already in the requested state needs no input. The
          // action still ran, so it crosses the boundary to settle and
          // describe the target like any other.
          if (!dispatched) dispatchContext.beginDispatch();
          inputMode = formResult.inputMode;
          warnings.push(...(formResult.warnings ?? []));
          completed = formResult.completed !== false;
          pendingDialog = formResult.dialog;
          const editorLocator = formResult.recordingTarget
            ? await host
                .recordingLocator(formResult.recordingTarget)
                .catch(() => undefined)
            : recordingLocator;
          // The input's real target can be secret when the original was
          // not: the page may mark the editor on focus, or the input went to
          // a secret editing host. Both are checked again before the text is
          // recorded, and a failed check counts as secret.
          const inputTarget = formResult.recordingTarget;
          const recordSecret = async (): Promise<boolean> =>
            secret ||
            (await host.isActionTargetSecret(target).catch(() => true)) ||
            (inputTarget !== undefined &&
              (await host.isActionTargetSecret(inputTarget).catch(() => true)));
          if (
            formResult.editor &&
            editorValueInputSent &&
            completed &&
            state.snapshot.recording &&
            editorLocator &&
            (command.kind === 'fill' || command.kind === 'type') &&
            !(await recordSecret())
          ) {
            // A fill replaces the editor's text; a type adds to it at the
            // caret, so it replays as typing.
            const text = escapePlaywrightString(command.text);
            // A readback says the text was not entered as asked: typing
            // stopped when the editor lost focus, or the editor did not end
            // up holding it. The step then carries no text, since a replay
            // would enter what this run did not.
            const entered = formResult.readback === undefined;
            this.addRecordingStep(state, {
              id: randomUUID(),
              action: command.kind === 'fill' ? 'fill' : 'press',
              locator: editorLocator,
              ...(entered ? { value: command.text } : {}),
              playwright: !entered
                ? `// An editor ${command.kind} stopped before its text was entered; it is not replayed.`
                : command.kind === 'fill'
                  ? `await ${editorLocator}.fill('${text}');`
                  : `await ${editorLocator}.pressSequentially('${text}');`,
              timestamp: Date.now(),
            });
          }
        } else if (
          (command.kind === 'click' || command.kind === 'press') &&
          (forcedClick || actionable.status === 'fallback' || !focusEmulated)
        ) {
          inputMode = 'synthetic';
          if (forcedClick)
            warnings.push('Forced: clicked the element directly.');
          await synthetic(
            command.kind,
            command.kind === 'press' ? command.key : undefined,
            command.kind === 'click'
              ? {
                  button: command.button,
                  clickCount: command.clickCount,
                  modifiers: command.modifiers,
                }
              : undefined,
          );
        } else if (command.kind === 'click') {
          if (actionable.status !== 'ready') fail('target_not_visible');
          if (!actionable.point) fail('target_not_visible');
          inputMode = 'trusted';
          const clicked = await dispatchClick({
            send,
            cleanupSend,
            sessionId: targetSession,
            lane: dispatchContext,
            point: actionable.point,
            button: command.button,
            clickCount: command.clickCount,
            modifiers: command.modifiers,
            beforeInput,
            getPendingDialog: () => state.pendingDialog,
          });
          completed = clicked.completed;
          if (!clicked.completed) pendingDialog = clicked.dialog;
        } else if (command.kind === 'focus') {
          inputMode = 'trusted';
          const focused = await dispatchFocus({
            send,
            cleanupSend,
            sessionId: targetSession,
            lane: dispatchContext,
            objectId: target.objectId,
            backendNodeId: target.identity.backendNodeId,
            timeoutMs,
            frameMapping,
            outerHitTest,
            beforeInput,
            getPendingDialog: () => state.pendingDialog,
          });
          completed = focused.completed;
          if (!focused.completed) pendingDialog = focused.dialog;
          if ('warning' in focused && focused.warning)
            warnings.push(focused.warning);
        } else if (command.kind === 'press' && combo?.ok) {
          inputMode = 'trusted';
          const events = buildKeyEventSequence(combo, hostKeyPlatform());
          if (command.ref !== undefined || command.locator !== undefined) {
            const pressed = await dispatchTargetedPress({
              send,
              cleanupSend,
              sessionId: targetSession,
              lane: dispatchContext,
              objectId: target.objectId,
              events,
              beforeInput,
              getPendingDialog: () => state.pendingDialog,
              syntheticFallback: () => synthetic('press', command.key),
            });
            inputMode = pressed.inputMode;
            if ('completed' in pressed && pressed.completed === false) {
              completed = false;
              pendingDialog = pressed.dialog;
            }
            if ('warning' in pressed) warnings.push(pressed.warning);
          } else {
            // Keys go to the focused element's session (an out-of-process
            // frame's focus is in its own widget).
            const pressed = await dispatchPress({
              send,
              cleanupSend,
              sessionId: targetSession,
              lane: dispatchContext,
              events,
              beforeInput,
              getPendingDialog: () => state.pendingDialog,
            });
            if (pressed.completed === false) {
              completed = false;
              pendingDialog = pressed.dialog;
            }
          }
        }
        context.signal.throwIfAborted();
        const dispatchCompletedAt = Date.now();
        delivery.deadline = dispatchCompletedAt + 1_000;
        if (frameDelivery && delivery.expected && inputMode === 'trusted')
          void context
            .trackCommand(frameDelivery.poll(context.signal))
            .catch(() => undefined);
        if (handling) await handling;
        pendingDialog = state.pendingDialog ?? pendingDialog;
        dialogForUnknown = pendingDialog;
        actionExpectations.forEach((item) => {
          item.expiresAt = delivery.deadline + 2_000;
        });
        const effects = await collectBrowserEffects({
          getDownloads: () => this.taskFiles.forAction(runtime, actionId),
          send,
          before: baseline,
          startedAt: dispatchCompletedAt,
          mutationCount: () => state.actionMutationCount ?? 0,
          lastMutationAt: () => state.actionMutationAt,
          getPendingDialog: () => state.pendingDialog ?? pendingDialog,
          signal: context.signal,
          timeoutMs,
          ...(formResult?.settleMs ? { waitMs: 50 + formResult.settleMs } : {}),
          ...(focusDocument ? { focusDocument } : {}),
          navigationStarted: () =>
            state.snapshot.loading ||
            state.navigationSequence !== navigationBefore ||
            state.snapshot.url !== urlBefore,
          navigationCommitted: () =>
            !state.snapshot.loading && state.snapshot.status !== 'loading',
          deliveryConfirmed:
            inputMode === 'trusted' && delivery.expected
              ? (): boolean => delivery.matched
              : undefined,
          deliveryDeadline: delivery.deadline,
          pendingDialogCorrelationUntil: () => {
            let until: number | undefined;
            for (const record of state.dialogCorrelations ?? []) {
              const deadline = record.dialog.openedAt + 2_000;
              if (
                (!record.privateSeen || !record.cdpSeen) &&
                Date.now() < deadline
              )
                until = Math.max(until ?? deadline, deadline);
            }
            return until;
          },
          subscribeSettle: (listener): (() => void) => {
            const listeners =
              state.actionSettleListeners ?? new Set<() => void>();
            state.actionSettleListeners = listeners;
            listeners.add(listener);
            return (): void => {
              listeners.delete(listener);
            };
          },
        });
        // A chooser or print this action opened is still being read; report it.
        const openings = [
          state.fileChooserOpening,
          state.printRequestOpening,
        ].filter((opening) => opening !== undefined);
        if (openings.length > 0)
          await Promise.race([
            Promise.all(openings),
            new Promise<void>((resolveWait) => {
              setTimeout(resolveWait, CHOOSER_REPORT_WAIT_MS).unref?.();
            }),
          ]);
        const chooser = state.pendingFileChooser;
        if (chooser?.actionId === actionId)
          effects.fileChooser = fileChooserDto(chooser);
        const print = state.pendingPrintRequest;
        if (print?.actionId === actionId)
          effects.printRequest = printRequestDto(print);
        const popup = state.actionPopups?.find(
          (record) => record.actionId === actionId,
        );
        if (popup) effects.popup = popup.popup;
        const denied = Array.from(
          new Set(
            (state.actionPermissionsDenied ?? [])
              .filter((record) => record.actionId === actionId)
              .map((record) => record.permission),
          ),
        );
        if (denied.length > 0) effects.permissionDenied = denied;
        if (command.kind === 'scroll') {
          const observations = await Promise.all(
            scrollOwners.map(async (owner) => ({
              ...owner,
              after: await host.readScrollState(owner.target),
            })),
          );
          const owner =
            command.direction !== undefined
              ? observations[0]
              : (observations.find(
                  (owner) =>
                    owner.before.x !== owner.after.x ||
                    owner.before.y !== owner.after.y,
                ) ?? observations.find((owner) => owner.page));
          if (owner) {
            const axis =
              command.direction !== undefined
                ? command.direction === 'left' || command.direction === 'right'
                  ? 'x'
                  : 'y'
                : Math.abs(owner.after.x - owner.before.x) >
                    Math.abs(owner.after.y - owner.before.y)
                  ? 'x'
                  : 'y';
            effects.scroll = scrollEffect(
              owner.before,
              owner.after,
              owner.page ? 'page' : 'element',
              axis,
            );
          }
          host.actionBoundary();
        }
        if (handling) await handling;
        const unconfirmed =
          inputMode === 'trusted' && delivery.expected && !delivery.matched;
        delivery.finished = true;
        if (unconfirmed) {
          completed = false;
          warnings.push(
            'The page did not report receiving the input; it may not have been delivered.',
          );
        }
        state.activeActionDialog = undefined;
        let described: BrowserActionTargetState | undefined;
        if (!state.pendingDialog) {
          try {
            // The retained node, read after the action (costs one model
            // build for names and refs); identity may be gone after
            // navigation, and the locator is never re-run.
            described = await context.trackCommand(
              documentCommand(
                state,
                'describe-prepared',
                host.describeActionTarget(
                  formResult?.recordingTarget ?? target,
                  // Secret before input stays secret in the receipt.
                  { secret },
                ),
                context.signal,
                PREPARED_COMMAND_TIMEOUT_MS,
              ),
            );
          } catch {
            described = undefined;
          }
        }
        if (!described)
          warnings.push(
            'The prepared target is no longer readable; target state was omitted.',
          );
        if (command.kind === 'focus' && described && !described.focused)
          warnings.push('The target could not be focused.');
        pendingDialog = state.pendingDialog ?? pendingDialog;
        dialogForUnknown = pendingDialog;
        const finalReceipt: BrowserActionReceipt = {
          ...receipt(
            context.sequence,
            unconfirmed || (pendingDialog && !completed)
              ? 'outcome_unknown'
              : 'executed',
          ),
          ...(unconfirmed || (pendingDialog && !completed)
            ? { outcomeReason: 'dispatch_timeout' }
            : {}),
          ...(described
            ? {
                target: mergeFormActionTargetState(
                  described,
                  formResult?.target,
                ),
              }
            : {}),
          ...(formResult?.readback ? { readback: formResult.readback } : {}),
          effects,
        };
        return {
          ok: true,
          completed: completed && !pendingDialog,
          browser: state.snapshot,
          receipt: finalReceipt,
          ...(handledDialogForUnknown
            ? { handledDialog: handledDialogForUnknown }
            : {}),
          ...(pendingDialog ? { dialog: { ...pendingDialog } } : {}),
        };
      },
      {
        signal,
        timeoutMs:
          Math.max(10_000, 2 * timeoutMs + 5_000) +
          actionTypingBudgetMs(command),
      },
    );
    if (outcome.status === 'executed') return outcome.value;
    if (outcome.status === 'outcome_unknown') {
      const unknownReceipt: BrowserActionReceipt = {
        ...receipt(outcome.sequence, 'outcome_unknown'),
        outcomeReason: outcome.reason,
      };
      if (
        !this.isCurrentLiveSession(state) ||
        outcome.reason === 'runtime_lost'
      ) {
        const reportedDialog = dialogForUnknown ?? state.pendingDialog;
        const unknown: BrowserAutomationRetainedUnknown = {
          kind: 'post-dispatch-unknown',
          receipt: unknownReceipt,
          capturedRuntimeGeneration: generation,
          ...(reportedDialog ? { dialog: { ...reportedDialog } } : {}),
          ...(handledDialogForUnknown
            ? { handledDialog: handledDialogForUnknown }
            : {}),
        };
        this.postDispatchUnknownResults.add(unknown);
        return unknown;
      }
      return {
        ok: true,
        completed: false,
        browser: state.snapshot,
        receipt: unknownReceipt,
        ...(handledDialogForUnknown
          ? { handledDialog: handledDialogForUnknown }
          : {}),
        ...(state.pendingDialog ? { dialog: { ...state.pendingDialog } } : {}),
      };
    }
    const actionError =
      failure ?? browserInputError(outcome.code, outcome.message);
    const failedReceipt: BrowserActionReceipt = {
      ...receipt(outcome.sequence, 'not_executed'),
      error: actionError,
    };
    if (actionError.code === 'dialog_pending')
      return {
        ok: true,
        completed: false,
        browser: state.snapshot,
        receipt: failedReceipt,
        ...(state.pendingDialog ? { dialog: { ...state.pendingDialog } } : {}),
      };
    return {
      ok: false,
      browser: state.snapshot,
      receipt: failedReceipt,
      error: {
        code:
          actionError.code === 'policy_denied'
            ? 'authorization_conflict'
            : actionError.code.startsWith('target_') ||
                actionError.code === 'not_editable' ||
                actionError.code === 'unsupported_control' ||
                actionError.code === 'frame_unavailable'
              ? 'invalid_target'
              : actionError.code === 'option_not_found'
                ? 'validation_failed'
                : actionError.code === 'timeout'
                  ? 'timeout'
                  : 'execution_failed',
        message: actionError.message,
        details: failedReceipt,
      },
    };
  }

  /**
   * `browser.upload_files`: finds the file input in the action lane, stages
   * the named files outside it, asks the calling chat's approval session, and
   * attaches the staged copies in the lane again only while the input's
   * document and origin are the ones approved and the copies still hold the
   * approved bytes. Any failure attaches nothing.
   */
  private async runBrowserUploadFiles(
    state: LiveBrowserSession,
    command: Extract<
      BrowserAutomationCommand,
      { kind: 'upload_files' | 'drop_files' }
    >,
    signal: AbortSignal | undefined,
    approvalChat: BrowserAutomationRequest['approvalChat'],
  ): Promise<BrowserAutomationRuntimeResult> {
    const startedAt = Date.now();
    const actionId = command.actionId ?? randomUUID();
    const timeoutMs = browserAutomationTimeoutMs(command);
    const scope: BrowserTaskFilesScope = {
      projectId: state.snapshot.projectId,
      worktreeId: state.snapshot.worktreeId,
    };
    const browserId = state.snapshot.id;
    const receipt = (
      sequence: number,
      status: BrowserActionReceipt['status'],
      extra: Partial<BrowserActionReceipt> = {},
    ): BrowserActionReceipt => ({
      actionId,
      sequence,
      kind: command.kind,
      status,
      ...extra,
      durationMs: Date.now() - startedAt,
    });
    const refuse = (
      sequence: number,
      error: BrowserActionError,
      upload?: BrowserUploadTransfer,
    ): BrowserAutomationRuntimeResult => {
      const failed = receipt(sequence, 'not_executed', {
        error,
        ...(upload ? { upload } : {}),
      });
      return {
        ok: false,
        browser: state.snapshot,
        receipt: failed,
        error: {
          code:
            error.code === 'approval_denied' || error.code === 'policy_denied'
              ? 'authorization_conflict'
              : error.code.startsWith('target_') ||
                  error.code === 'unsupported_control' ||
                  error.code === 'frame_unavailable'
                ? 'invalid_target'
                : error.code === 'file_not_eligible'
                  ? 'validation_failed'
                  : error.code === 'timeout'
                    ? 'timeout'
                    : 'execution_failed',
          message: error.message,
          details: failed,
        },
      };
    };

    // 1. The file input or drop target, its frame's document, and the
    // origins, in the lane.
    const drop = command.kind === 'drop_files';
    const found = await this.resolveFileInput(
      state,
      command,
      signal,
      timeoutMs,
      drop,
    );
    const sequence = found.sequence;
    const input = found.input;
    if (!input)
      return refuse(
        sequence,
        found.failure ?? browserInputError('execution_failed'),
      );

    // 2. The files: all eligible, or nothing is staged and nothing prompts.
    if (command.files.length > 1 && !input.multiple)
      return refuse(
        sequence,
        browserInputError(
          'unsupported_control',
          'This file input takes one file. Upload one file, or use an input that accepts several.',
        ),
      );
    if (!approvalChat)
      return refuse(
        sequence,
        browserInputError(
          'approval_denied',
          'Uploads need a chat that can show approvals.',
        ),
      );
    let root: string | undefined;
    let attached: string[] | undefined;
    const sources: UploadSource[] = [];
    for (const file of command.files) {
      if (file.downloadId !== undefined) {
        const resolved = this.taskFiles.downloadUploadSource(
          scope,
          browserId,
          file.downloadId,
        );
        if (!resolved.ok)
          return refuse(
            sequence,
            browserInputError('file_not_eligible', resolved.error.message),
          );
        sources.push(resolved.source);
        continue;
      }
      if (file.attachmentId !== undefined) {
        attached ??= await (
          this.options.chatAttachmentPaths ?? transcriptAttachmentPaths
        )(approvalChat).catch((): undefined => undefined);
        const resolved = attached
          ? attachmentUploadSource(
              (
                this.options.resolveAttachmentsFolder ??
                ((target): string =>
                  resolveAgentAttachmentsDir(
                    target.projectId,
                    target.worktreeId,
                  ))
              )(approvalChat),
              file.attachmentId,
              attached,
            )
          : undefined;
        if (!resolved?.ok)
          return refuse(
            sequence,
            browserInputError(
              'file_not_eligible',
              resolved?.error.message ??
                "This chat's attachments could not be read.",
            ),
          );
        sources.push(resolved.source);
        continue;
      }
      try {
        root ??= (
          this.options.resolveWorkspaceRoot ??
          ((target: BrowserTaskFilesScope): string =>
            resolveWorktreeCwd(target.projectId, target.worktreeId))
        )(scope);
      } catch {
        return refuse(
          sequence,
          browserInputError(
            'file_not_eligible',
            "This task's workspace is not available.",
          ),
        );
      }
      const resolved = workspaceUploadSource(root, file.path ?? '');
      if (!resolved.ok)
        return refuse(
          sequence,
          browserInputError('file_not_eligible', resolved.error.message),
        );
      sources.push(resolved.source);
    }

    // 3. Stage, then ask and attach; past the wait, staging goes on.
    const started = this.taskFiles.startUpload(scope, {
      browserId,
      actionId,
      frameOrigin: input.frameOrigin,
      topOrigin: input.topOrigin,
      sources,
    });
    if (!started.ok)
      return refuse(
        sequence,
        browserInputError('execution_failed', started.error.message),
      );
    const uploadId = started.transfer.id;
    const finished = this.finishUpload(
      state,
      scope,
      uploadId,
      input,
      approvalChat,
      sources.map((source) => source.requestedPath),
      drop ? actionTargetRequest(command) : undefined,
    );
    const stagingWait = new AbortController();
    const timer = setTimeout(() => stagingWait.abort(), timeoutMs);
    const stopOnAbort = (): void => {
      this.taskFiles.cancelUpload(scope, uploadId);
    };
    signal?.addEventListener('abort', stopOnAbort, { once: true });
    if (signal?.aborted) stopOnAbort();
    let staged: BrowserTransfer | undefined;
    try {
      staged = await this.taskFiles.waitForTransfer(scope, uploadId, {
        signal: stagingWait.signal,
        staged: true,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!staged) {
      signal?.removeEventListener('abort', stopOnAbort);
      const current = this.taskFiles.get(scope, uploadId);
      return {
        ok: true,
        completed: true,
        browser: state.snapshot,
        receipt: receipt(sequence, 'executed', {
          ...(current?.kind === 'upload' ? { upload: current } : {}),
          warnings: [
            `Staging continues. Wait for it with browser.wait_for({ upload: { uploadId: '${uploadId}' } }).`,
          ],
        }),
      };
    }
    let end: Awaited<typeof finished>;
    try {
      end = await finished;
    } finally {
      signal?.removeEventListener('abort', stopOnAbort);
    }
    const ended = end.upload;
    if (end.unknown)
      return {
        ok: true,
        completed: false,
        browser: state.snapshot,
        receipt: receipt(sequence, 'outcome_unknown', {
          outcomeReason: end.unknown,
          ...(ended ? { upload: ended } : {}),
          warnings: [
            `It is not known yet whether the files were attached. Wait for the upload with browser.wait_for({ upload: { uploadId: '${uploadId}' } }) before uploading again.`,
          ],
        }),
      };
    if (ended?.status === 'attached') {
      return {
        ok: true,
        completed: true,
        browser: state.snapshot,
        receipt: receipt(sequence, 'executed', {
          upload: ended,
          ...(input.accept
            ? {
                warnings: [
                  `The input suggests ${input.accept}; the page decides whether it accepts these files.`,
                ],
              }
            : {}),
        }),
      };
    }
    const code: BrowserActionErrorCode = end.chooserEnded
      ? 'chooser_expired'
      : ended?.status === 'cancelled'
        ? 'cancelled'
        : ended?.error?.code === 'approval_denied'
          ? 'approval_denied'
          : ended?.error?.code === 'file_not_eligible'
            ? 'file_not_eligible'
            : ended?.error?.code === 'file_changed'
              ? 'file_changed'
              : ended?.error?.code === 'origin_changed'
                ? 'origin_changed'
                : ended?.error?.code === 'disk_full'
                  ? 'disk_full'
                  : 'execution_failed';
    return refuse(
      sequence,
      browserInputError(
        code,
        ended?.error?.message ??
          (code === 'cancelled' ? 'The upload was cancelled.' : undefined),
      ),
      ended,
    );
  }

  /**
   * The file input an action names, read in the action lane: the target, an
   * input inside or near it, or the input of a pending chooser. The lane
   * reports a run that sent no input as not executed, so the read hands its
   * result out here.
   */
  private async resolveFileInput(
    state: LiveBrowserSession,
    command: BrowserFileInputTarget,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    /** `drop_files`: the target itself is where the files go, input or not. */
    drop = false,
  ): Promise<{
    sequence: number;
    input?: ResolvedFileInput;
    failure?: BrowserActionError;
  }> {
    let failure: BrowserActionError | undefined;
    const fail = (code: BrowserActionErrorCode, message?: string): never => {
      failure = browserInputError(code, message);
      throw new Error(failure.message);
    };
    const lane = this.actionLaneFor(state);
    // The lane reports a run that sent no input as not executed, so this
    // read hands its result out here.
    let resolved: ResolvedFileInput | undefined;
    const found = await lane.run(
      async (context): Promise<void> => {
        const host = state.pageModel;
        context.registerCleanup(host.beginActivity());
        if (state.snapshot.pickMode)
          fail(
            'execution_failed',
            'The user is picking an element. Try again after they finish.',
          );
        if (state.pendingDialog) fail('dialog_pending');
        await this.ensurePageModelReady(state);
        context.signal.throwIfAborted();
        const send = (
          method: string,
          params: Record<string, unknown>,
          sessionId?: string,
        ): Promise<unknown> => {
          context.signal.throwIfAborted();
          const debug = state.view.webContents.debugger;
          return sessionId
            ? debug.sendCommand(method, params, sessionId)
            : debug.sendCommand(method, params);
        };
        if (command.chooserId !== undefined) {
          resolved = await this.pendingChooserInput(
            state,
            command.chooserId,
            send,
          );
          if (!resolved) fail('chooser_expired');
          if (
            !resolved?.frameOrigin.startsWith('https://') &&
            !resolved?.frameOrigin.startsWith('http://')
          )
            fail(
              'unsupported_control',
              'This frame has no web origin to approve an upload for.',
            );
          return;
        }
        const request =
          command.ref !== undefined
            ? { kind: 'ref' as const, ref: command.ref }
            : {
                kind: 'locator' as const,
                locator: command.locator,
                ...(command.frame === undefined
                  ? {}
                  : { frame: command.frame }),
              };
        let target: ResolvedActionTarget;
        try {
          target = await holdActionTarget({
            host,
            request,
            lane: context,
            isDispatched: () => false,
            watchDialogs: (listener) => {
              state.pendingDialogWaiters.add(listener);
              if (state.pendingDialog) listener(state.pendingDialog);
              return (): void => {
                state.pendingDialogWaiters.delete(listener);
              };
            },
          });
        } catch (error) {
          if (error instanceof TargetDialogError) fail('dialog_pending');
          if (error instanceof TargetResolutionError)
            fail(error.code, resolutionMessage(error));
          throw error;
        }
        // holdActionTarget releases the target in the lane's cleanup.
        const held = target;
        const input = drop
          ? { backendNodeId: held.identity.backendNodeId, multiple: true }
          : await describeFileInput(send, held);
        if (!input)
          fail(
            'unsupported_control',
            'No file input was found at or near the target. Run browser.input_snapshot to find one.',
          );
        const origins = await frameOrigins(
          send,
          held.identity.sessionId,
          held.identity.frameId,
        );
        // The browser's own record of the frame's document; the attach
        // compares against it, since a cross-site frame's model identity can
        // name another loader.
        if (!origins) fail('frame_unavailable');
        if (
          !origins?.frameOrigin.startsWith('https://') &&
          !origins?.frameOrigin.startsWith('http://')
        )
          fail(
            'unsupported_control',
            'This frame has no web origin to approve an upload for.',
          );
        if (!input || !origins) return fail('target_not_found');
        // The input the files go to, which can be a hidden one beside the
        // target: replay sets the files there.
        const recordingLocator = state.snapshot.recording
          ? await host
              .recordingLocator({
                ...held,
                identity: {
                  ...held.identity,
                  backendNodeId: input.backendNodeId,
                },
              })
              .catch(() => undefined)
          : undefined;
        resolved = {
          ...input,
          sessionId: held.identity.sessionId,
          frameId: held.identity.frameId,
          loaderId: origins.loaderId,
          frameOrigin: origins.frameOrigin,
          topOrigin: origins.topOrigin,
          ...(recordingLocator ? { recordingLocator } : {}),
        };
      },
      { signal, timeoutMs: Math.max(10_000, 2 * timeoutMs + 5_000) },
    );
    const input = resolved;
    if (input && !failure) return { sequence: found.sequence, input };
    return {
      sequence: found.sequence,
      failure:
        failure ??
        browserInputError(
          found.status === 'not_executed' && found.code !== 'execution_failed'
            ? found.code
            : 'execution_failed',
          found.status === 'not_executed' && found.code !== 'execution_failed'
            ? found.message
            : undefined,
        ),
    };
  }

  /**
   * `browser.request_files`: asks the calling chat's user to choose files for
   * a file input, then attaches what they pick, unstaged, as the page's own
   * picker would. Waits for the user without a limit, like an approval.
   */
  private async runBrowserRequestFiles(
    state: LiveBrowserSession,
    command: Extract<BrowserAutomationCommand, { kind: 'request_files' }>,
    signal: AbortSignal | undefined,
    approvalChat: BrowserAutomationRequest['approvalChat'],
  ): Promise<BrowserAutomationRuntimeResult> {
    const startedAt = Date.now();
    const actionId = command.actionId ?? randomUUID();
    const receipt = (
      sequence: number,
      status: BrowserActionReceipt['status'],
      extra: Partial<BrowserActionReceipt> = {},
    ): BrowserActionReceipt => ({
      actionId,
      sequence,
      kind: 'request_files',
      status,
      ...extra,
      durationMs: Date.now() - startedAt,
    });
    const refuse = (
      sequence: number,
      error: BrowserActionError,
    ): BrowserAutomationRuntimeResult => {
      const failed = receipt(sequence, 'not_executed', { error });
      return {
        ok: false,
        browser: state.snapshot,
        receipt: failed,
        error: {
          code:
            error.code === 'approval_denied'
              ? 'authorization_conflict'
              : error.code.startsWith('target_') ||
                  error.code === 'unsupported_control' ||
                  error.code === 'frame_unavailable' ||
                  error.code === 'chooser_expired'
                ? 'invalid_target'
                : 'execution_failed',
          message: error.message,
          details: failed,
        },
      };
    };
    const found = await this.resolveFileInput(
      state,
      command,
      signal,
      REQUEST_FILES_STEP_TIMEOUT_MS,
    );
    const sequence = found.sequence;
    const input = found.input;
    if (!input)
      return refuse(
        sequence,
        found.failure ?? browserInputError('execution_failed'),
      );
    if (!approvalChat)
      return refuse(
        sequence,
        browserInputError(
          'approval_denied',
          'Asking for files needs a chat that can show approvals.',
        ),
      );
    const host = originHost(input.frameOrigin);
    const title = input.multiple
      ? `Choose files for ${host}`
      : `Choose a file for ${host}`;
    const outcome = await requestChatApproval(
      approvalChat.projectId,
      approvalChat.worktreeId,
      approvalChat.chatId,
      {
        kind: 'browser-file-request',
        origin: input.frameOrigin,
        topOrigin: input.topOrigin,
        multiple: input.multiple,
      },
      {
        title,
        details: {
          kind: 'browser-file-request',
          origin: input.frameOrigin,
          topOrigin: input.topOrigin,
          ...(command.purpose ? { purpose: command.purpose } : {}),
          multiple: input.multiple,
        },
      },
    );
    if (outcome.decision !== 'allow')
      return refuse(
        sequence,
        browserInputError(
          'approval_denied',
          'The user declined to choose files.',
        ),
      );
    if (signal?.aborted)
      return refuse(sequence, browserInputError('cancelled'));
    if (this.chooserEnded(state, input))
      return refuse(sequence, browserInputError('chooser_expired'));
    const paths = await this.pickFiles(
      state,
      chooserDialogOptions({
        multiple: input.multiple,
        directory: input.directory,
        accept: input.accept,
        title,
      }),
    );
    if (paths.length === 0)
      return refuse(
        sequence,
        browserInputError(
          'cancelled',
          'The user closed the file picker without choosing files.',
        ),
      );
    const requestedFiles = paths.map((path) => ({
      name: basename(path),
      sizeBytes: chosenFileSize(path),
    }));
    let reason: { code: BrowserActionErrorCode; message: string } | undefined;
    let sent: Promise<unknown> | undefined;
    /** When the files were sent to the page, for the recorded step's place. */
    let sentAt = Date.now();
    const attached = await this.actionLaneFor(state).run(
      async (context): Promise<boolean> => {
        const send = (
          method: string,
          params: Record<string, unknown>,
          sessionId?: string,
        ): Promise<unknown> => {
          context.signal.throwIfAborted();
          const debug = state.view.webContents.debugger;
          return sessionId
            ? debug.sendCommand(method, params, sessionId)
            : debug.sendCommand(method, params);
        };
        const current = await frameOrigins(
          send,
          input.sessionId,
          input.frameId,
        );
        if (!current || current.frameOrigin !== input.frameOrigin) {
          reason = {
            code: 'origin_changed',
            message:
              'The page that asked for the files now shows another site, so nothing was attached.',
          };
          return false;
        }
        if (current.loaderId !== input.loaderId) {
          reason = {
            code: 'execution_failed',
            message:
              'The page changed before the files were attached, so nothing was attached.',
          };
          return false;
        }
        const left = !(await fileInputConnected(
          send,
          input.sessionId,
          input.backendNodeId,
        ));
        // A chooser whose input left the page has ended.
        if (left && input.chooserId)
          this.endFileChooser(state, input.chooserId);
        // The user may have answered or dismissed the chooser meanwhile.
        if (this.chooserEnded(state, input)) {
          reason = {
            code: 'chooser_expired',
            message:
              'The file chooser ended before the files were attached, so nothing was attached.',
          };
          return false;
        }
        if (left) {
          reason = { code: 'execution_failed', message: FILE_INPUT_LEFT };
          return false;
        }
        context.beginDispatch();
        sentAt = Date.now();
        sent = send(
          'DOM.setFileInputFiles',
          { files: paths, backendNodeId: input.backendNodeId },
          input.sessionId || undefined,
        );
        await context.trackCommand(sent);
        return true;
      },
      { signal, timeoutMs: REQUEST_FILES_STEP_TIMEOUT_MS },
    );
    const names = requestedFiles.map((file) => file.name);
    if (attached.status === 'executed' && attached.value) {
      this.endChooserFor(state, input);
      this.recordUploadStep(
        state,
        this.uploadStep(state, input, names),
        sentAt,
        input.chooserOpenedAt,
      );
      return {
        ok: true,
        completed: true,
        browser: state.snapshot,
        receipt: receipt(sequence, 'executed', { requestedFiles }),
      };
    }
    if (attached.status === 'outcome_unknown') {
      // The browser may still attach the files; once it does, the chooser is answered.
      if (sent)
        void sent.then(
          () => {
            this.endChooserFor(state, input);
            this.recordUploadStep(
              state,
              this.uploadStep(state, input, names),
              sentAt,
              input.chooserOpenedAt,
            );
          },
          () => undefined,
        );
      return {
        ok: true,
        completed: false,
        browser: state.snapshot,
        receipt: receipt(sequence, 'outcome_unknown', {
          outcomeReason: attached.reason,
          requestedFiles,
        }),
      };
    }
    return refuse(
      sequence,
      browserInputError(
        reason?.code ?? 'execution_failed',
        reason?.message ?? "The files couldn't be attached.",
      ),
    );
  }

  /** Debugger commands for chooser reads and answers outside the action lane. */
  private chooserSend(
    state: LiveBrowserSession,
  ): (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<unknown> {
    return (method, params, sessionId) => {
      const debug = state.view.webContents.debugger;
      return sessionId
        ? debug.sendCommand(method, params, sessionId)
        : debug.sendCommand(method, params);
    };
  }

  /** Whether a chooser an input came from has ended since it was read. */
  private chooserEnded(
    state: LiveBrowserSession,
    input: ResolvedFileInput,
  ): boolean {
    return (
      input.chooserId !== undefined &&
      state.pendingFileChooser?.id !== input.chooserId
    );
  }

  /** The input of pending chooser `chooserId`, while its frame shows the same document. */
  private async pendingChooserInput(
    state: LiveBrowserSession,
    chooserId: string,
    send: (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>,
  ): Promise<ResolvedFileInput | undefined> {
    const chooser = state.pendingFileChooser;
    if (!chooser || chooser.id !== chooserId) return undefined;
    const [origins, input, connected] = await Promise.all([
      frameOrigins(send, chooser.sessionId, chooser.frameId),
      describeFileInputNode(send, chooser.sessionId, chooser.backendNodeId),
      fileInputConnected(send, chooser.sessionId, chooser.backendNodeId),
    ]);
    if (
      !origins ||
      !input ||
      !connected ||
      origins.loaderId !== chooser.loaderId
    ) {
      this.endFileChooser(state, chooser.id);
      return undefined;
    }
    return {
      ...input,
      multiple: chooser.multiple,
      sessionId: chooser.sessionId,
      frameId: chooser.frameId,
      loaderId: chooser.loaderId,
      frameOrigin: origins.frameOrigin,
      topOrigin: origins.topOrigin,
      chooserId: chooser.id,
      chooserOpenedAt: chooser.openedAt,
    };
  }

  /**
   * A page opened a file chooser. Inside an agent's action it waits for the
   * agent or the user; otherwise the user opened it, and the native picker
   * opens as it would without interception.
   */
  private handleFileChooserOpened(
    state: LiveBrowserSession,
    params: Record<string, unknown>,
    sessionId: string,
  ): void {
    const backendNodeId =
      typeof params.backendNodeId === 'number'
        ? params.backendNodeId
        : undefined;
    const frameId = optionalString(params.frameId);
    if (backendNodeId === undefined || !frameId) return;
    const opened = {
      sessionId,
      frameId,
      backendNodeId,
      multiple: params.mode === 'selectMultiple',
    };
    const actionId = this.taskFiles.attributionFor({
      browserId: state.snapshot.id,
      runtimeGeneration: state.snapshot.profile?.runtimeGeneration ?? 0,
      taskIncarnationId: state.snapshot.profile?.taskIncarnationId ?? '',
    });
    const report = (error: unknown): void =>
      this.captureConsole(state, {
        level: 'warning',
        text: `A file chooser could not be opened: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    if (actionId === undefined) {
      void this.openUserFileChooser(state, opened).catch(report);
      return;
    }
    const opening = this.openAgentFileChooser(state, opened, actionId)
      .catch(report)
      .finally(() => {
        if (state.fileChooserOpening === opening)
          state.fileChooserOpening = undefined;
      });
    state.fileChooserOpening = opening;
  }

  private async openAgentFileChooser(
    state: LiveBrowserSession,
    opened: {
      sessionId: string;
      frameId: string;
      backendNodeId: number;
      multiple: boolean;
    },
    actionId: string,
  ): Promise<void> {
    if (state.pendingFileChooser) {
      this.captureConsole(state, {
        level: 'warning',
        text: 'Ignored a file chooser while another one was waiting for an answer.',
      });
      return;
    }
    const send = this.chooserSend(state);
    const [origins, input] = await Promise.all([
      frameOrigins(send, opened.sessionId, opened.frameId),
      describeFileInputNode(send, opened.sessionId, opened.backendNodeId),
    ]);
    if (
      !origins ||
      !input ||
      state.pendingFileChooser ||
      !this.isCurrentLiveSession(state)
    )
      return;
    const openedAt = now();
    const id = `chooser-${uuid()}`;
    const generation = state.snapshot.profile?.runtimeGeneration;
    const timer = setTimeout(
      () => this.endFileChooser(state, id),
      FILE_CHOOSER_LIFETIME_MS,
    );
    timer.unref?.();
    const chooser: PendingFileChooser = {
      id,
      browserId: state.snapshot.id,
      ...(generation === undefined ? {} : { runtimeGeneration: generation }),
      frameOrigin: origins.frameOrigin,
      topOrigin: origins.topOrigin,
      multiple: opened.multiple,
      ...(input.directory ? { directory: true } : {}),
      ...(input.accept ? { accept: input.accept } : {}),
      openedAt,
      expiresAt: openedAt + FILE_CHOOSER_LIFETIME_MS,
      sessionId: opened.sessionId,
      frameId: opened.frameId,
      backendNodeId: opened.backendNodeId,
      loaderId: origins.loaderId,
      actionId,
      timer,
    };
    state.pendingFileChooser = chooser;
    this.emitForSession(state, {
      type: 'file-chooser',
      browserId: state.snapshot.id,
      chooser: fileChooserDto(chooser),
    });
  }

  /** The user's own chooser: the native picker, then their picks, unstaged. */
  private async openUserFileChooser(
    state: LiveBrowserSession,
    opened: {
      sessionId: string;
      frameId: string;
      backendNodeId: number;
      multiple: boolean;
    },
  ): Promise<void> {
    if (state.userFileChooserOpen) return;
    state.userFileChooserOpen = true;
    const openedAt = Date.now();
    try {
      const send = this.chooserSend(state);
      const [origins, input] = await Promise.all([
        frameOrigins(send, opened.sessionId, opened.frameId),
        describeFileInputNode(send, opened.sessionId, opened.backendNodeId),
      ]);
      if (!origins || !input) return;
      const paths = await this.pickFiles(
        state,
        chooserDialogOptions({
          multiple: opened.multiple,
          directory: input.directory,
          accept: input.accept,
        }),
      );
      if (paths.length === 0) return;
      // Ended first, so the agent can't replace the user's pick.
      this.endChooserFor(state, opened);
      await this.attachPickedFiles(
        state,
        { ...opened, loaderId: origins.loaderId },
        paths,
        openedAt,
      );
    } finally {
      state.userFileChooserOpen = false;
    }
  }

  private pickFiles(
    state: LiveBrowserSession,
    options: OpenDialogOptions,
  ): Promise<string[]> {
    const window =
      state.hostWindow && !state.hostWindow.isDestroyed()
        ? state.hostWindow
        : this.options.getWindow();
    return (this.options.showOpenDialog ?? showNativeOpenDialog)(
      window,
      options,
    );
  }

  /** Attaches files the user picked while the frame still shows the same document. */
  private async attachPickedFiles(
    state: LiveBrowserSession,
    target: {
      sessionId: string;
      frameId: string;
      loaderId: string;
      backendNodeId: number;
    },
    paths: string[],
    /** When the chooser opened. */
    openedAt: number,
  ): Promise<boolean> {
    if (!this.isCurrentLiveSession(state)) return false;
    const send = this.chooserSend(state);
    const [origins, connected] = await Promise.all([
      frameOrigins(send, target.sessionId, target.frameId),
      fileInputConnected(send, target.sessionId, target.backendNodeId),
    ]);
    if (!origins || !connected || origins.loaderId !== target.loaderId)
      return false;
    const sentAt = Date.now();
    await send(
      'DOM.setFileInputFiles',
      { files: paths, backendNodeId: target.backendNodeId },
      target.sessionId || undefined,
    );
    // The page recorder sees only the click that opened the chooser.
    this.recordUploadStep(
      state,
      {
        names: paths.map((path) => basename(path)),
        via: this.chooserOpenedWhileRecording(state, openedAt)
          ? 'chooser'
          : 'input',
      },
      sentAt,
      openedAt,
    );
    return true;
  }

  /** Files for an input answer the pending chooser for that input, however the input was named. */
  private endChooserFor(
    state: LiveBrowserSession,
    input: { sessionId: string; frameId: string; backendNodeId: number },
  ): void {
    const pending = state.pendingFileChooser;
    if (
      pending &&
      pending.sessionId === input.sessionId &&
      pending.frameId === input.frameId &&
      pending.backendNodeId === input.backendNodeId
    )
      this.endFileChooser(state, pending.id);
  }

  private endFileChooser(state: LiveBrowserSession, chooserId?: string): void {
    const chooser = state.pendingFileChooser;
    if (!chooser || (chooserId !== undefined && chooser.id !== chooserId))
      return;
    clearTimeout(chooser.timer);
    state.pendingFileChooser = undefined;
    this.emitForSession(state, {
      type: 'file-chooser',
      browserId: state.snapshot.id,
      chooser: null,
    });
  }

  /** A pending chooser ends when its frame shows another document or goes away. */
  private expireFileChooserFor(
    state: LiveBrowserSession,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const chooser = state.pendingFileChooser;
    if (!chooser) return;
    if (method === 'Page.frameDetached') {
      if (params.frameId === chooser.frameId) this.endFileChooser(state);
      return;
    }
    const frame = isRecord(params.frame) ? params.frame : undefined;
    if (!frame) return;
    if (frame.id === chooser.frameId || frame.parentId === undefined)
      this.endFileChooser(state);
  }

  /**
   * A page's `print()`: during an agent's action it becomes the browser's
   * pending print request; otherwise the native print dialog opens.
   */
  private handlePrintCalled(
    state: LiveBrowserSession,
    params: Record<string, unknown>,
    sessionId: string,
  ): void {
    const contextId = params.executionContextId;
    const frameId =
      typeof contextId === 'number'
        ? state.pageModel.contextFrame(sessionId, contextId)
        : undefined;
    if (!frameId) return;
    // One print at a time: a request still waiting, even after the action
    // that asked for it ended, holds any later call.
    if (state.pendingPrintRequest) {
      this.captureConsole(state, {
        level: 'warning',
        text: 'Ignored a print request while another one was waiting for an answer.',
      });
      return;
    }
    const actionId = this.taskFiles.attributionFor({
      browserId: state.snapshot.id,
      runtimeGeneration: state.snapshot.profile?.runtimeGeneration ?? 0,
      taskIncarnationId: state.snapshot.profile?.taskIncarnationId ?? '',
    });
    const { call, untrack } = this.trackPrintCall(state, {
      sessionId,
      frameId,
    });
    const routing = this.routePrintCall(state, call, actionId)
      .catch((error: unknown) =>
        this.captureConsole(state, {
          level: 'warning',
          text: `A print request could not be opened: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      )
      .finally(() => {
        untrack();
        if (state.printRequestOpening === routing)
          state.printRequestOpening = undefined;
      });
    if (actionId !== undefined) state.printRequestOpening = routing;
  }

  /** A navigation or detach while a print call is handled makes it stale. */
  private trackPrintCall(
    state: LiveBrowserSession,
    frame: { sessionId: string; frameId: string },
  ): { call: PrintCall; untrack: () => void } {
    const call: PrintCall = { ...frame, stale: false };
    const calls = state.printCalls ?? new Set<PrintCall>();
    state.printCalls = calls;
    calls.add(call);
    return { call, untrack: (): void => void calls.delete(call) };
  }

  private async routePrintCall(
    state: LiveBrowserSession,
    call: PrintCall,
    actionId: string | undefined,
  ): Promise<void> {
    // Blink's own print, replayed, applies Blink's rules itself.
    if (actionId === undefined) {
      await this.openNativePrint(state, call);
      return;
    }
    // A held request never reaches Blink, so main applies its sandbox rule.
    const blocked = await printBlockedBySandbox(
      {
        getFrame: (frameId) => state.pageModel.registry.getFrame(frameId),
        send: this.chooserSend(state),
      },
      call.frameId,
    );
    if (blocked || call.stale) return;
    await this.openAgentPrintRequest(state, call, actionId);
  }

  private async openAgentPrintRequest(
    state: LiveBrowserSession,
    frame: PrintCall,
    actionId: string,
  ): Promise<void> {
    if (state.pendingPrintRequest) {
      this.captureConsole(state, {
        level: 'warning',
        text: 'Ignored a print request while another one was waiting for an answer.',
      });
      return;
    }
    const origins = await frameOrigins(
      this.chooserSend(state),
      frame.sessionId,
      frame.frameId,
    );
    if (
      !origins ||
      frame.stale ||
      state.pendingPrintRequest ||
      !this.isCurrentLiveSession(state)
    )
      return;
    const openedAt = now();
    const id = `print-${uuid()}`;
    const generation = state.snapshot.profile?.runtimeGeneration;
    const timer = setTimeout(
      () => this.endPrintRequest(state, id),
      PRINT_REQUEST_LIFETIME_MS,
    );
    timer.unref?.();
    state.pendingPrintRequest = {
      id,
      browserId: state.snapshot.id,
      ...(generation === undefined ? {} : { runtimeGeneration: generation }),
      frameOrigin: origins.frameOrigin,
      topOrigin: origins.topOrigin,
      openedAt,
      expiresAt: openedAt + PRINT_REQUEST_LIFETIME_MS,
      sessionId: frame.sessionId,
      frameId: frame.frameId,
      actionId,
      timer,
    };
    this.emitForSession(state, {
      type: 'print-request',
      browserId: state.snapshot.id,
      request: printRequestDto(state.pendingPrintRequest),
    });
  }

  /**
   * The native print dialog for a call outside an agent's action: Blink's own
   * `print()` in an isolated world of the calling frame, so its sandbox,
   * throttling, and frame rules apply as they did before interception. The
   * call is dropped if its document went, or a request opened, while the
   * world was created. The evaluation returns once the dialog closes, so
   * nothing waits on it.
   */
  private async openNativePrint(
    state: LiveBrowserSession,
    call: PrintCall,
  ): Promise<void> {
    const send = this.chooserSend(state);
    const session = call.sessionId || undefined;
    const world = await send(
      'Page.createIsolatedWorld',
      { frameId: call.frameId, worldName: NATIVE_PRINT_WORLD },
      session,
    ).catch(() => undefined);
    const contextId = isRecord(world) ? world.executionContextId : undefined;
    if (
      typeof contextId !== 'number' ||
      call.stale ||
      state.pendingPrintRequest ||
      !this.isCurrentLiveSession(state)
    )
      return;
    void send(
      'Runtime.evaluate',
      // No userGesture: a forged activation would let any page loop the
      // dialog past Blink's throttling, or use activation-gated APIs.
      { expression: NATIVE_PRINT_EXPRESSION, contextId },
      session,
    ).catch(() => undefined);
  }

  private endPrintRequest(state: LiveBrowserSession, requestId?: string): void {
    const request = state.pendingPrintRequest;
    if (!request || (requestId !== undefined && request.id !== requestId))
      return;
    clearTimeout(request.timer);
    state.pendingPrintRequest = undefined;
    this.emitForSession(state, {
      type: 'print-request',
      browserId: state.snapshot.id,
      request: null,
    });
  }

  /** A pending print request ends when its frame or the page navigates. */
  private expirePrintRequestFor(
    state: LiveBrowserSession,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const frame = isRecord(params.frame) ? params.frame : undefined;
    const ends = (frameId: string): boolean =>
      method === 'Page.frameDetached'
        ? params.frameId === frameId
        : !!frame && (frame.id === frameId || frame.parentId === undefined);
    // Calls still being read belong to the document that just went.
    for (const call of Array.from(state.printCalls ?? []))
      if (ends(call.frameId)) call.stale = true;
    const request = state.pendingPrintRequest;
    if (request && ends(request.frameId)) this.endPrintRequest(state);
  }

  /** The browser's pending print request, if one waits for an answer. */
  getPrintRequest(browserId: string): BrowserPrintRequest | null {
    const request = this.requireSession(browserId).pendingPrintRequest;
    return request ? printRequestDto(request) : null;
  }

  /**
   * Answers the pending print request: `save_pdf` (an agent's accept, or the
   * banner) saves the page as a PDF task file, `print` (the banner only)
   * opens the native print dialog, and `dismiss` ends it.
   */
  async answerPrintRequest(
    request: BrowserAnswerPrintRequestRequest,
  ): Promise<BrowserAnswerPrintRequestResult> {
    const state = this.sessions.get(request.browserId);
    const pending = state?.pendingPrintRequest;
    if (!state || !pending || pending.id !== request.printRequestId)
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: 'This print request is no longer pending.',
        },
      };
    this.endPrintRequest(state, pending.id);
    if (request.answer === 'dismiss') return { ok: true };
    if (request.answer === 'print') {
      const { call, untrack } = this.trackPrintCall(state, pending);
      void this.openNativePrint(state, call).finally(untrack);
      return { ok: true };
    }
    return this.savePdf({ browserId: request.browserId });
  }

  /**
   * An HTTP authentication challenge: held for the user, who answers it from
   * the pane notice and the app's credentials dialog. Agents can read or
   * cancel it, never answer it. A same-realm repeat joins the pending one;
   * anything else waiting at the same time is cancelled.
   */
  private handleLogin(
    state: LiveBrowserSession,
    url: string,
    authInfo: { isProxy: boolean; host: string; port: number; realm: string },
    callback: (username?: string, password?: string) => void,
  ): void {
    if (!this.isCurrentLiveSession(state)) {
      callback();
      return;
    }
    let origin = authInfo.host;
    try {
      origin = authInfo.isProxy
        ? `${authInfo.host}:${String(authInfo.port)}`
        : new URL(url).origin;
    } catch {
      // The host alone names it.
    }
    const pending = state.pendingAuthRequest;
    if (pending) {
      if (
        pending.origin === origin &&
        pending.isProxy === authInfo.isProxy &&
        (pending.realm ?? '') === authInfo.realm
      )
        pending.callbacks.push(callback);
      else callback();
      return;
    }
    const id = `auth-${uuid()}`;
    const openedAt = now();
    const generation = state.snapshot.profile?.runtimeGeneration;
    const timer = setTimeout(
      () => this.endAuthRequest(state, id),
      AUTH_REQUEST_LIFETIME_MS,
    );
    timer.unref?.();
    state.pendingAuthRequest = {
      id,
      browserId: state.snapshot.id,
      ...(generation === undefined ? {} : { runtimeGeneration: generation }),
      origin,
      ...(authInfo.realm ? { realm: authInfo.realm } : {}),
      isProxy: authInfo.isProxy,
      openedAt,
      expiresAt: openedAt + AUTH_REQUEST_LIFETIME_MS,
      callbacks: [callback],
      timer,
    };
    this.emitForSession(state, {
      type: 'auth-request',
      browserId: state.snapshot.id,
      request: authRequestDto(state.pendingAuthRequest),
    });
  }

  /** Ends a pending sign-in, cancelling it unless it was just answered. */
  private endAuthRequest(state: LiveBrowserSession, requestId?: string): void {
    const request = state.pendingAuthRequest;
    if (!request || (requestId !== undefined && request.id !== requestId))
      return;
    clearTimeout(request.timer);
    state.pendingAuthRequest = undefined;
    for (const callback of request.callbacks) callback();
    this.emitForSession(state, {
      type: 'auth-request',
      browserId: state.snapshot.id,
      request: null,
    });
  }

  /** Why the page shows nothing while an HTTP sign-in waits for the user. */
  private signInNotice(state: LiveBrowserSession): string {
    const pending = state.pendingAuthRequest;
    return pending
      ? ` The page is waiting for a sign-in to ${pending.origin}; only the user can sign in. Ask them, or cancel it with browser.handle_dialog.`
      : '';
  }

  /** The browser's pending sign-in, if one waits for the user. */
  getAuthRequest(browserId: string): BrowserAuthRequest | null {
    const request = this.requireSession(browserId).pendingAuthRequest;
    return request ? authRequestDto(request) : null;
  }

  /**
   * Answers a pending sign-in: the user's credentials from the app's dialog,
   * passed to Chromium and never kept, or a cancel (the user, an agent, or
   * the timer).
   */
  answerAuthRequest(request: BrowserAnswerAuthRequestRequest): {
    ok: boolean;
  } {
    const state = this.sessions.get(request.browserId);
    const pending = state?.pendingAuthRequest;
    if (!state || !pending || pending.id !== request.authRequestId)
      return { ok: false };
    if (request.answer === 'cancel') {
      this.endAuthRequest(state, pending.id);
      return { ok: true };
    }
    clearTimeout(pending.timer);
    state.pendingAuthRequest = undefined;
    for (const callback of pending.callbacks)
      callback(request.username ?? '', request.password ?? '');
    this.emitForSession(state, {
      type: 'auth-request',
      browserId: state.snapshot.id,
      request: null,
    });
    return { ok: true };
  }

  /**
   * A `window.open` during an agent's action, for its `effects.popup`.
   * Returns the record so a failed external open can mark it blocked.
   */
  private noteActionPopup(
    state: LiveBrowserSession,
    url: string,
    handled: NonNullable<BrowserActionEffects['popup']>['handled'],
  ): NonNullable<BrowserActionEffects['popup']> | undefined {
    const actionId = this.taskFiles.attributionFor({
      browserId: state.snapshot.id,
      runtimeGeneration: state.snapshot.profile?.runtimeGeneration ?? 0,
      taskIncarnationId: state.snapshot.profile?.taskIncarnationId ?? '',
    });
    if (actionId === undefined) return undefined;
    const popups = state.actionPopups ?? [];
    state.actionPopups = popups;
    const popup = {
      // Origin and path only, as navigation effects report a URL; for
      // another scheme, such as mailto:, the scheme alone.
      url:
        sanitizeNavigationUrl(url) ??
        /^[a-z][a-z\d+.-]*:/i.exec(url)?.[0].toLowerCase() ??
        'about:blank',
      handled,
    };
    popups.push({ actionId, popup });
    popups.splice(0, Math.max(0, popups.length - ACTION_EFFECT_RECORD_LIMIT));
    return popup;
  }

  /** A denied permission request during an agent's action. */
  private notePermissionDenied(
    contents: WebContents,
    permission: string,
  ): void {
    const state = Array.from(this.sessions.values()).find(
      (candidate) => candidate.view.webContents === contents,
    );
    if (!state) return;
    const actionId = this.taskFiles.attributionFor({
      browserId: state.snapshot.id,
      runtimeGeneration: state.snapshot.profile?.runtimeGeneration ?? 0,
      taskIncarnationId: state.snapshot.profile?.taskIncarnationId ?? '',
    });
    if (actionId === undefined) return;
    const denied = state.actionPermissionsDenied ?? [];
    state.actionPermissionsDenied = denied;
    denied.push({ actionId, permission });
    denied.splice(0, Math.max(0, denied.length - ACTION_EFFECT_RECORD_LIMIT));
  }

  /** The user answers a pending chooser from its banner. */
  async answerFileChooser(
    request: BrowserAnswerFileChooserRequest,
  ): Promise<{ ok: boolean }> {
    const state = this.sessions.get(request.browserId);
    const chooser = state?.pendingFileChooser;
    if (!state || !chooser || chooser.id !== request.chooserId)
      return { ok: false };
    if (request.answer === 'dismiss') {
      this.endFileChooser(state, chooser.id);
      return { ok: true };
    }
    if (
      !(await fileInputConnected(
        this.chooserSend(state),
        chooser.sessionId,
        chooser.backendNodeId,
      ))
    ) {
      this.endFileChooser(state, chooser.id);
      return { ok: false };
    }
    const paths = await this.pickFiles(
      state,
      chooserDialogOptions({
        multiple: chooser.multiple,
        directory: chooser.directory,
        accept: chooser.accept,
      }),
    );
    if (paths.length === 0 || state.pendingFileChooser !== chooser)
      return { ok: false };
    // Ended first, so an agent's attach checked meanwhile attaches nothing.
    this.endFileChooser(state, chooser.id);
    return {
      ok: await this.attachPickedFiles(state, chooser, paths, chooser.openedAt),
    };
  }

  /**
   * Drops files at a point, as a user dragging them there would: dragenter,
   * dragover, then drop (spike S6). A drag left open by a failure is
   * cancelled, so the page is not left mid-drag.
   */
  private async dispatchFileDrop(
    state: LiveBrowserSession,
    context: ActionLaneContext,
    send: (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>,
    sessionId: string,
    point: { x: number; y: number },
    files: string[],
    onDrop: (sent: Promise<unknown>) => void,
  ): Promise<void> {
    const data = { items: [], files, dragOperationsMask: 1 };
    let entered = false;
    let dropped = false;
    try {
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        const event = send(
          'Input.dispatchDragEvent',
          { type, ...point, data, modifiers: 0 },
          sessionId,
        );
        if (type === 'drop') onDrop(event);
        entered = true;
        await context.trackCommand(event);
        if (type === 'drop') dropped = true;
      }
    } finally {
      if (entered && !dropped) {
        const debug = state.view.webContents.debugger;
        const cancel = { type: 'dragCancel', ...point, data, modifiers: 0 };
        void (
          sessionId
            ? debug.sendCommand('Input.dispatchDragEvent', cancel, sessionId)
            : debug.sendCommand('Input.dispatchDragEvent', cancel)
        ).catch(() => undefined);
      }
    }
  }

  /**
   * Waits for staging, asks the chat, then attaches; resolves with the
   * upload's end, or with why it is unknown when the attach outlasted its time.
   */
  private async finishUpload(
    state: LiveBrowserSession,
    scope: BrowserTaskFilesScope,
    uploadId: string,
    input: ResolvedFileInput,
    chat: NonNullable<BrowserAutomationRequest['approvalChat']>,
    /** Per file, the path asked for when a link made it differ. */
    requestedPaths: Array<string | undefined>,
    /** `drop_files`: the target, found again to drop the files on it. */
    dropTarget?: ActionTargetRequest,
  ): Promise<{
    upload?: BrowserUploadTransfer;
    unknown?: ActionLaneUnknownReason;
    /** The chooser the input came from ended before the files were attached. */
    chooserEnded?: true;
  }> {
    const staged = await this.taskFiles.waitForTransfer(scope, uploadId, {
      signal: new AbortController().signal,
      staged: true,
    });
    if (staged?.kind !== 'upload' || staged.status !== 'awaiting_approval')
      return { upload: staged?.kind === 'upload' ? staged : undefined };
    const attachedStep = this.uploadStep(
      state,
      input,
      staged.files.map((file) => file.name),
      dropTarget !== undefined,
    );
    const files = staged.files.map((file) => ({
      displayPath: file.displayPath,
      sizeBytes: file.sizeBytes,
    }));
    // Deny rules also match the link a file was asked for by.
    const checked = staged.files.map((file, index) => {
      const requestedPath = requestedPaths[index];
      return {
        displayPath: file.displayPath,
        ...(requestedPath ? { requestedPath } : {}),
        sizeBytes: file.sizeBytes,
      };
    });
    const host = ((): string => {
      try {
        return new URL(input.frameOrigin).host;
      } catch {
        return input.frameOrigin;
      }
    })();
    const outcome = await requestChatApproval(
      chat.projectId,
      chat.worktreeId,
      chat.chatId,
      {
        kind: 'browser-upload',
        origin: input.frameOrigin,
        topOrigin: input.topOrigin,
        files: checked,
      },
      {
        title:
          files.length === 1
            ? `Upload ${staged.files[0]?.name ?? 'a file'} to ${host}?`
            : `Upload ${files.length} files to ${host}?`,
        details: {
          kind: 'browser-upload',
          origin: input.frameOrigin,
          topOrigin: input.topOrigin,
          files,
        },
        suggestedTarget: { kind: 'browser-upload', origin: input.frameOrigin },
      },
    );
    if (outcome.decision !== 'allow')
      return {
        upload: await this.taskFiles.endUpload(scope, uploadId, {
          status: 'denied',
          error: {
            code: 'approval_denied',
            message: 'The upload was not approved.',
          },
        }),
      };
    // A cancel while the prompt was open wins; so does a closed browser.
    if (!this.taskFiles.beginAttach(scope, uploadId)) {
      const current = this.taskFiles.get(scope, uploadId);
      return { upload: current?.kind === 'upload' ? current : undefined };
    }
    const failed = async (
      code: 'origin_changed' | 'file_changed' | 'upload_failed',
      message: string,
    ): Promise<{ upload?: BrowserUploadTransfer }> => ({
      upload: await this.taskFiles.endUpload(scope, uploadId, {
        status: 'failed',
        error: { code, message },
      }),
    });
    if (!this.isCurrentLiveSession(state))
      return failed(
        'upload_failed',
        'The browser closed before the files were attached.',
      );
    let reason:
      | {
          code: 'origin_changed' | 'file_changed' | 'upload_failed';
          message: string;
        }
      | undefined;
    let sent: Promise<unknown> | undefined;
    /** When the files were sent to the page, for the recorded step's place. */
    let sentAt = Date.now();
    let chooserEnded = false;
    const attached = await this.actionLaneFor(state).run(
      async (context): Promise<boolean> => {
        const send = (
          method: string,
          params: Record<string, unknown>,
          sessionId?: string,
        ): Promise<unknown> => {
          context.signal.throwIfAborted();
          const debug = state.view.webContents.debugger;
          return sessionId
            ? debug.sendCommand(method, params, sessionId)
            : debug.sendCommand(method, params);
        };
        const now = await frameOrigins(send, input.sessionId, input.frameId);
        if (!now || now.frameOrigin !== input.frameOrigin) {
          reason = {
            code: 'origin_changed',
            message:
              'The page that asked for the files now shows another site, so nothing was attached.',
          };
          return false;
        }
        if (now.loaderId !== input.loaderId) {
          reason = {
            code: 'upload_failed',
            message:
              'The page changed before the files were attached, so nothing was attached.',
          };
          return false;
        }
        const paths = this.taskFiles.stagedUploadPaths(scope, uploadId);
        if (
          !paths ||
          !(await this.taskFiles.stagedUploadMatches(scope, uploadId))
        ) {
          reason = {
            code: 'file_changed',
            message:
              'A staged file no longer matches what was approved, so nothing was attached.',
          };
          return false;
        }
        // A drop goes to the target's point now, so the target is found
        // again; it must be the node that was approved.
        let dropPoint: { x: number; y: number } | undefined;
        if (dropTarget) {
          const host = state.pageModel;
          context.registerCleanup(host.beginActivity());
          await this.ensurePageModelReady(state);
          const target = await holdActionTarget({
            host,
            request: dropTarget,
            lane: context,
            isDispatched: () => false,
            watchDialogs: (listener) => {
              state.pendingDialogWaiters.add(listener);
              if (state.pendingDialog) listener(state.pendingDialog);
              return (): void => {
                state.pendingDialogWaiters.delete(listener);
              };
            },
          }).catch((): undefined => undefined);
          if (
            !target ||
            target.identity.backendNodeId !== input.backendNodeId ||
            target.identity.sessionId !== input.sessionId ||
            target.identity.frameId !== input.frameId
          ) {
            reason = {
              code: 'upload_failed',
              message:
                'The drop target changed before the files were dropped, so nothing was dropped.',
            };
            return false;
          }
          const actionable = await checkActionability({
            send,
            sessionId: target.identity.sessionId,
            objectId: target.objectId,
            backendNodeId: target.identity.backendNodeId,
            action: 'hover',
            timeoutMs: DROP_TARGET_WAIT_MS,
            signal: context.signal,
            frameMapping: () => host.documentMapping(target),
            outerHitTest: (point) => host.outerHitTest(target, point),
          });
          // A drop goes to whichever frame is at the point: one embedded in
          // the target would get files approved for the target's site.
          const lands =
            actionable.status === 'ready' && actionable.point
              ? await dropLandsInFrame(
                  send,
                  input.sessionId,
                  input.frameId,
                  actionable.point,
                )
              : false;
          if (actionable.status !== 'ready' || !actionable.point || !lands) {
            reason = {
              code: 'upload_failed',
              message:
                actionable.status === 'ready' && actionable.point
                  ? 'Another frame is at the drop point, so nothing was dropped.'
                  : actionable.status === 'not_executed' && actionable.message
                    ? `${actionable.message} Nothing was dropped.`
                    : `The drop target can't be reached on the page (${
                        actionable.status === 'not_executed'
                          ? actionable.code
                          : actionable.status === 'fallback'
                            ? actionable.reason
                            : 'no_point'
                      }), so nothing was dropped.`,
            };
            return false;
          }
          dropPoint = actionable.point;
        }
        const left = !(await fileInputConnected(
          send,
          input.sessionId,
          input.backendNodeId,
        ));
        // A chooser whose input left the page has ended.
        if (left && input.chooserId)
          this.endFileChooser(state, input.chooserId);
        // The user may have answered or dismissed the chooser meanwhile.
        if (this.chooserEnded(state, input)) {
          chooserEnded = true;
          reason = {
            code: 'upload_failed',
            message:
              'The file chooser ended before the files were attached, so nothing was attached.',
          };
          return false;
        }
        if (left) {
          reason = {
            code: 'upload_failed',
            message: dropTarget ? DROP_TARGET_LEFT : FILE_INPUT_LEFT,
          };
          return false;
        }
        context.beginDispatch();
        sentAt = Date.now();
        if (dropPoint) {
          await this.dispatchFileDrop(
            state,
            context,
            send,
            input.sessionId,
            dropPoint,
            paths,
            (drop) => {
              sent = drop;
            },
          );
          return true;
        }
        sent = send(
          'DOM.setFileInputFiles',
          { files: paths, backendNodeId: input.backendNodeId },
          input.sessionId,
        );
        await context.trackCommand(sent);
        return true;
      },
      { timeoutMs: UPLOAD_ATTACH_TIMEOUT_MS },
    );
    if (attached.status === 'executed' && attached.value) {
      this.endChooserFor(state, input);
      // Recorded as the files land, before the record is saved, so a step
      // the user takes meanwhile comes after it.
      this.recordUploadStep(state, attachedStep, sentAt, input.chooserOpenedAt);
      return {
        upload: await this.taskFiles.endUpload(scope, uploadId, {
          status: 'attached',
        }),
      };
    }
    if (attached.status === 'outcome_unknown') {
      // The browser may still attach and read the copies, so the upload
      // keeps them and ends when its command does; a closed browser ends it.
      void (sent ?? Promise.reject(new Error('Nothing was sent.')))
        .then(
          () => {
            this.endChooserFor(state, input);
            this.recordUploadStep(
              state,
              attachedStep,
              sentAt,
              input.chooserOpenedAt,
            );
            return this.taskFiles.endUpload(scope, uploadId, {
              status: 'attached',
            });
          },
          () => failed('upload_failed', "The files couldn't be attached."),
        )
        .catch(() => undefined);
      const current = this.taskFiles.get(scope, uploadId);
      return {
        upload: current?.kind === 'upload' ? current : undefined,
        unknown: attached.reason,
      };
    }
    const end = await failed(
      reason?.code ?? 'upload_failed',
      reason?.message ?? "The files couldn't be attached.",
    );
    return chooserEnded ? { ...end, chooserEnded: true } : end;
  }

  private async runBrowserWaitFor(
    state: LiveBrowserSession,
    command: Extract<BrowserAutomationCommand, { kind: 'wait_for' }>,
    signal?: AbortSignal,
  ): Promise<BrowserAutomationResponse> {
    const startedAt = Date.now();
    const timeoutMs = browserAutomationTimeoutMs(command);
    const generation = state.snapshot.profile?.runtimeGeneration ?? 0;
    const lane = this.actionLaneFor(state);
    const sequence = lane.reserveSequence();
    const actionId = command.actionId ?? randomUUID();
    const controller = new AbortController();
    const abortFromCaller = (): void =>
      controller.abort(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('Browser wait was cancelled.', 'AbortError'),
      );
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
    let controllers = this.waitForControllers.get(state);
    if (!controllers) {
      controllers = new Set();
      this.waitForControllers.set(state, controllers);
    }
    controllers.add(controller);
    // D11: a wait is agent activity; tracking is not released during it.
    const endActivity = state.pageModel.beginActivity();
    const currentRuntime = (): boolean =>
      this.waitForControllers.get(state)?.has(controller) === true &&
      this.isCurrentLiveSession(state) &&
      (state.snapshot.profile?.runtimeGeneration ?? 0) === generation;
    const failureReceipt = (
      code: BrowserActionErrorCode,
      message: string,
      durationMs = Date.now() - startedAt,
    ): BrowserActionReceipt => ({
      actionId,
      sequence,
      kind: 'wait_for',
      status: 'not_executed',
      error: browserInputError(code, message),
      durationMs,
    });
    const fail = (
      code: BrowserActionErrorCode,
      errorCode: NonNullable<BrowserAutomationResponse['error']>['code'],
      message: string,
    ): BrowserAutomationResponse => {
      const receipt = failureReceipt(code, message);
      return {
        ok: false,
        browser: state.snapshot,
        receipt,
        error: { code: errorCode, message, details: receipt },
      };
    };
    try {
      const scope = {
        projectId: state.snapshot.projectId,
        worktreeId: state.snapshot.worktreeId,
      };
      const browserId = state.snapshot.id;
      if (command.upload !== undefined) {
        const known = this.taskFiles.get(scope, command.upload.uploadId);
        if (known?.kind !== 'upload' || known.browserId !== browserId)
          return fail(
            'target_not_found',
            'invalid_target',
            'This browser has no upload with that id.',
          );
        const ended = await this.taskFiles.waitForTransfer(scope, known.id, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(timeoutMs),
          ]),
        });
        if (!ended && signal?.aborted)
          return fail(
            'cancelled',
            'execution_failed',
            'The browser wait was cancelled before the upload ended.',
          );
        const latest = ended ?? this.taskFiles.get(scope, known.id);
        const elapsedMs = Date.now() - startedAt;
        return {
          ok: true,
          completed: true,
          browser: state.snapshot,
          receipt: {
            actionId,
            sequence,
            kind: 'wait_for',
            status: 'executed',
            durationMs: elapsedMs,
          },
          waitFor: {
            satisfied: ended !== undefined,
            elapsedMs,
            observed: latest?.kind === 'upload' ? { upload: latest } : {},
          },
        };
      }
      const outcome = await waitForBrowserCondition({
        waitForDownload: (options) =>
          this.taskFiles.waitForDownload(scope, browserId, options),
        command,
        timeoutMs,
        signal: controller.signal,
        probe: async (
          probeSignal: AbortSignal,
          deadline: number,
        ): Promise<BrowserWaitForProbe> => {
          if (command.url !== undefined)
            return {
              matchCount: 0,
              visibleCount: 0,
              readyState: browserIsNavigating(state) ? 'loading' : 'complete',
            };
          const documentRevision = state.actionDocumentRevision ?? 0;
          try {
            // Every non-URL probe reads the top document, even load-state
            // waits that build no model. Page.enable can miss its commit.
            await this.ensurePageModelReady(state);
            // The page model's probe, in every frame or the `frame` scope;
            // bounded like the preload command it replaced.
            const value = await documentCommand(
              state,
              'wait-for-probe',
              state.pageModel.waitProbe({
                ...(command.locator !== undefined
                  ? { locator: command.locator }
                  : command.text !== undefined
                    ? { text: command.text }
                    : {}),
                ...(command.frame === undefined
                  ? {}
                  : { frame: command.frame }),
              }),
              probeSignal,
              Math.max(1, deadline - Date.now() + 250),
            );
            if ((state.actionDocumentRevision ?? 0) !== documentRevision)
              throw new BrowserWaitForNavigationError(
                'The browser document was replaced during the wait.',
              );
            return value;
          } catch (error) {
            if (!currentRuntime())
              throw new BrowserWaitForNavigationError(
                'The browser runtime changed during the wait.',
              );
            if ((state.actionDocumentRevision ?? 0) !== documentRevision)
              throw new BrowserWaitForNavigationError(
                'The browser document was replaced during the wait.',
              );
            if (
              error instanceof LocatorRequestError ||
              isInvalidWaitForTargetError(error)
            )
              throw new BrowserWaitForInvalidTargetError(
                error instanceof Error
                  ? error.message
                  : 'The wait target selector is invalid.',
              );
            throw error;
          }
        },
        getUrl: () => state.view.webContents.getURL(),
        getInflightRequestCount: () => state.inflightRequestIds.size,
        getLastNetworkActivityAt: () => state.lastNetworkActivityAt,
        isRuntimeCurrent: currentRuntime,
        isNavigating: () => browserIsNavigating(state),
        getPendingDialog: () => state.pendingDialog,
      });
      if (outcome.status === 'completed' || outcome.status === 'timeout') {
        const receipt: BrowserActionReceipt = {
          actionId,
          sequence,
          kind: 'wait_for',
          status: 'executed',
          durationMs: outcome.waitFor.elapsedMs,
        };
        return {
          ok: true,
          completed: true,
          browser: state.snapshot,
          receipt,
          waitFor: outcome.waitFor,
        };
      }
      if (outcome.status === 'dialog') {
        const receipt = failureReceipt(
          'dialog_pending',
          'A JavaScript dialog is pending.',
        );
        return {
          ok: true,
          completed: false,
          browser: state.snapshot,
          receipt,
          dialog: { ...outcome.dialog },
        };
      }
      if (outcome.status === 'cancelled')
        return fail(
          'cancelled',
          'execution_failed',
          'The browser wait was cancelled before a match was observed.',
        );
      if (outcome.status === 'invalid_target')
        return fail('target_not_found', 'invalid_target', outcome.message);
      if (outcome.status === 'runtime_lost')
        return fail(
          'execution_failed',
          'execution_failed',
          'The browser runtime changed while waiting.',
        );
      return fail(
        'execution_failed',
        'execution_failed',
        `${outcome.message}${this.signInNotice(state)}`,
      );
    } finally {
      endActivity();
      signal?.removeEventListener('abort', abortFromCaller);
      const active = this.waitForControllers.get(state);
      active?.delete(controller);
      if (active?.size === 0) this.waitForControllers.delete(state);
    }
  }

  listWorktreeBrowsers(
    projectId: string,
    worktreeId: string,
  ): BrowserSessionSnapshot[] {
    const state = this.ensureWorktreeState(projectId, worktreeId);
    const ordered = state.browserOrder.flatMap((browserId) => {
      const snapshot =
        this.sessions.get(browserId)?.snapshot ??
        state.snapshots.get(browserId);
      return snapshot ? [{ ...snapshot }] : [];
    });
    const orderedIds = new Set(ordered.map((snapshot) => snapshot.id));
    const untrackedLive = Array.from(this.sessions.values())
      .filter(
        (sessionState) =>
          sessionState.snapshot.projectId === projectId &&
          sessionState.snapshot.worktreeId === worktreeId &&
          !orderedIds.has(sessionState.snapshot.id),
      )
      .map((sessionState) => ({ ...sessionState.snapshot }));
    return [...ordered, ...untrackedLive];
  }

  resolveActiveBrowserId(projectId: string, worktreeId: string): string | null {
    const state = this.ensureWorktreeState(projectId, worktreeId);
    if (
      state.activeBrowserId &&
      this.isOwnedBrowser(state, state.activeBrowserId)
    ) {
      return state.activeBrowserId;
    }
    const fallback =
      state.browserOrder.find((browserId) =>
        this.isOwnedBrowser(state, browserId),
      ) ??
      Array.from(this.sessions.values()).find(
        (sessionState) =>
          sessionState.snapshot.projectId === projectId &&
          sessionState.snapshot.worktreeId === worktreeId,
      )?.snapshot.id ??
      null;
    if (fallback !== state.activeBrowserId) {
      void this.mutateWorktreeState(projectId, worktreeId, (nextState) => {
        const nextFallback =
          nextState.browserOrder.find((browserId) =>
            this.isOwnedBrowser(nextState, browserId),
          ) ??
          Array.from(this.sessions.values()).find(
            (sessionState) =>
              sessionState.snapshot.projectId === projectId &&
              sessionState.snapshot.worktreeId === worktreeId,
          )?.snapshot.id ??
          null;
        if (nextState.activeBrowserId === nextFallback) return false;
        nextState.activeBrowserId = nextFallback;
        return true;
      }).catch(() => undefined);
    }
    return fallback;
  }

  async openExternal(rawUrl: string): Promise<void> {
    const url = normalizeBrowserUrlInput(rawUrl);
    if (!isSafeExternalBrowserUrl(url)) {
      throw new Error(
        "Couldn't open this URL externally. Enter an http or https URL.",
      );
    }
    await openExternalGuarded(url);
  }

  /**
   * Open a tab's current local file page in the default web browser. Only
   * the tab's current page URL is accepted, so this path cannot reach a file
   * the tab has not navigated to.
   */
  async openFilePageExternally(
    browserId: string,
    rawUrl: string,
  ): Promise<void> {
    const state = this.sessions.get(browserId);
    if (!state) throw new Error("Couldn't find that browser tab.");
    const url = normalizeBrowserUrlInput(rawUrl);
    const invalidUrlMessage =
      "Couldn't open this URL externally. Enter an http or https URL.";
    if (!isFileBrowserUrl(url) || !isAllowedInAppBrowserUrl(url, false)) {
      throw new Error(invalidUrlMessage);
    }
    if (!sameBrowserUrl(url, state.snapshot.url)) {
      throw new Error(
        "Couldn't open this file externally. Reload the page and try again.",
      );
    }
    if (state.snapshot.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
      throw new Error(READ_ONLY_SCOPE_ERROR);
    }
    let absolutePath: string;
    try {
      absolutePath = fileURLToPath(url);
    } catch {
      throw new Error(invalidUrlMessage);
    }
    await assertPathOutsideSharedContainerReplicas(absolutePath);
    await openFileInDefaultWebBrowser(url);
  }

  async cleanupRetiredTaskScratch(
    scope: BrowserTaskScope,
    incarnationId: string,
  ): Promise<void> {
    const slot = await getBrowserProfileService().repository.getTask(scope);
    if (slot?.incarnationId === incarnationId && slot.lifecycle !== 'retired')
      throw new BrowserProfileError(
        'operation_conflict',
        'Browser temporary data cannot be removed before task retirement commits.',
      );
    const key = browserTaskScopeTuple(scope);
    await this.profileData.scratch.cleanup(
      (owner) =>
        owner.taskIncarnationId === incarnationId &&
        browserTaskScopeTuple(owner.taskScope) === key,
    );
  }

  async destroyWorktree(
    projectId: string,
    worktreeId: string,
    options?: { clearStorage?: boolean; deletingTarget?: boolean },
  ): Promise<void> {
    // Credential retirement is coordinated with owner commit by the profile
    // lifecycle service. This method only stops/removes logical browser tabs.
    const scope = { projectId, worktreeId };
    if (options?.deletingTarget) this.taskFiles.fence(scope);
    browserHandoffs.releaseWorktree(projectId, worktreeId);
    this.downloads.cancelTask(projectId, worktreeId);
    const key = worktreeKey(projectId, worktreeId);
    this.cancelSnapshotPersistence(key);
    const browserIds = new Set<string>();
    try {
      for (const id of this.ensureWorktreeState(projectId, worktreeId)
        .browserOrder)
        browserIds.add(id);
    } catch {
      // Invalid persisted state must not prevent live view or storage cleanup.
    }
    for (const state of Array.from(this.sessions.values())) {
      if (
        state.snapshot.projectId === projectId &&
        state.snapshot.worktreeId === worktreeId
      )
        browserIds.add(state.snapshot.id);
    }
    const errors: unknown[] = [];
    for (const browserId of Array.from(browserIds)) {
      const sessionState = this.sessions.get(browserId);
      const hostWindow = sessionState?.hostWindow;
      const runtimeGeneration =
        sessionState?.snapshot.profile?.runtimeGeneration;
      try {
        await this.disposeLiveViewInternal(browserId, false);
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.cleanupBrowserArtifacts(browserId);
      } catch (error) {
        errors.push(error);
      }
      this.sessionArtifacts.delete(browserId);
      this.emit(
        { type: 'destroyed', browserId, runtimeGeneration },
        hostWindow,
      );
    }
    if (options?.deletingTarget) {
      try {
        await this.downloads.drain();
        await this.taskFiles.drain();
        await this.taskFiles.removeTask(scope);
      } catch (error) {
        errors.push(error);
      }
    }
    this.cancelSnapshotPersistence(key);
    if (!options?.deletingTarget) {
      // Split stops browsers while keeping the worktree. Persist its empty list
      // so old tabs cannot reappear; target deletion removes this file itself.
      try {
        await this.persistWorktreeState(
          this.createEmptyWorktreeState(projectId, worktreeId),
        );
      } catch (error) {
        errors.push(error);
      }
    }
    this.worktreeStates.delete(key);
    this.rejectedWorktreeStates.delete(key);
    if (errors.length)
      throw new Error(
        'Browser cleanup failed: ' + errors.map(String).join('; '),
      );
  }

  async disposeWorktreeViews(
    projectId: string,
    worktreeId: string,
    /** Runs after in-flight opens settle, right before downloads are
     * cancelled, and again before each view closes; a throw stops the
     * remaining teardown. */
    beforeTeardown?: () => void,
  ): Promise<void> {
    const taskKey = worktreeKey(projectId, worktreeId);
    // Admission precedes metadata/session acquisition. Retirement must also
    // cancel opens that have not reached the binding-save queue yet.
    this.creationAdmissions.forEach((pending) => {
      pending.forEach((admission) => {
        if (admission.taskKey === taskKey) admission.cancelled = true;
      });
    });
    const recoveries = Array.from(this.profileRecoveries.get(taskKey) ?? []);
    for (const { controller } of recoveries)
      controller.abort(
        new BrowserProfileError(
          'scope_retired',
          'The browser task is no longer active.',
        ),
      );
    for (const controller of Array.from(
      this.bindingCommits.get(worktreeKey(projectId, worktreeId)) ?? [],
    ))
      controller.abort(
        new BrowserProfileError(
          'scope_retired',
          'The browser task is no longer active.',
        ),
      );
    const switches: Promise<BrowserProfileSwitchResult>[] = [];
    for (const [id, controller] of Array.from(this.switching)) {
      const owner = this.findBrowserOwner(id);
      if (owner?.projectId === projectId && owner.worktreeId === worktreeId) {
        controller.abort();
        for (const operation of Array.from(this.switchOperations.values()))
          if (operation.browserId === id) switches.push(operation.promise);
      }
    }
    await Promise.allSettled(switches);
    await Promise.allSettled(recoveries.map(({ promise }) => promise));
    await Promise.allSettled(
      Array.from(
        this.taskCreations.get(worktreeKey(projectId, worktreeId)) ?? [],
      ),
    );
    const ids = Array.from(this.sessions.values())
      .filter(
        (state) =>
          state.snapshot.projectId === projectId &&
          state.snapshot.worktreeId === worktreeId,
      )
      .map((state) => state.snapshot.id);
    beforeTeardown?.();
    this.downloads.cancelTask(projectId, worktreeId);
    for (const id of ids) {
      // Each close awaits; recheck before the next one. A close that already
      // started finishes, so no view is left half torn down; closing a view
      // destroys no data, and the deletion rechecks before its data steps.
      beforeTeardown?.();
      await this.disposeLiveView(id);
    }
  }

  async shutdown(): Promise<void> {
    if (
      __CANOPY_E2E__ &&
      globalThis.__CANOPY_E2E_BROWSER_PAGE_MODEL__ ===
        this.pageModelMeasurementHook
    ) {
      delete globalThis.__CANOPY_E2E_BROWSER_PAGE_MODEL__;
    }
    this.shuttingDown = true;
    await this.dataRuntime?.shutdown();
    const persistenceErrors: unknown[] = [];
    const worktreeKeys = new Set<string>();
    for (const sessionState of Array.from(this.sessions.values())) {
      this.rememberLiveSnapshot(sessionState);
      worktreeKeys.add(
        worktreeKey(
          sessionState.snapshot.projectId,
          sessionState.snapshot.worktreeId,
        ),
      );
    }
    for (const key of Array.from(worktreeKeys)) {
      const state = this.worktreeStates.get(key);
      if (!state) continue;
      try {
        await this.mutateWorktreeState(
          state.projectId,
          state.worktreeId,
          () => true,
        );
      } catch (error) {
        persistenceErrors.push(error);
      }
    }
    await Promise.all(
      Array.from(this.sessions.keys()).map((id) =>
        this.disposeLiveViewInternal(id, false),
      ),
    );
    this.downloads.dispose();
    ipcMain.removeListener(PRELOAD_RESULT_CHANNEL, this.preloadResultHandler);
    ipcMain.removeListener(PRELOAD_EVENT_CHANNEL, this.preloadEventHandler);
    if (persistenceErrors.length > 0) {
      throw persistenceErrors[0];
    }
  }

  async saveRecordingArtifact(
    browserId: string,
    expectedRuntimeGeneration: number,
    script: string,
  ): Promise<string> {
    const state = this.requireSession(browserId);
    if (state.snapshot.profile?.runtimeGeneration !== expectedRuntimeGeneration)
      throw new BrowserProfileError(
        'stale_runtime',
        'The browser changed before the recording could be saved.',
      );
    return this.writeAttachment(
      state,
      'recording.md',
      Buffer.from(
        ['# Browser Recording', '', '```ts', script, '```', ''].join('\n'),
      ),
    );
  }

  /** Presentation metadata only; registration does not grant filesystem deletion authority. */
  registerArtifact(browserId: string, filePath: string): void {
    if (!this.findBrowserOwner(browserId)) {
      throw new Error(`Browser ${browserId} not found.`);
    }
    const artifacts =
      this.sessionArtifacts.get(browserId) ?? this.createSessionArtifacts();
    artifacts.attachmentPaths.add(filePath);
    this.sessionArtifacts.set(browserId, artifacts);
  }

  getLifecycleStats(): {
    liveViews: number;
    persistedSessions: number;
    pendingCommands: number;
    destroyingSessions: number;
    trackedArtifacts: number;
  } {
    return {
      liveViews: this.sessions.size,
      persistedSessions: Array.from(this.worktreeStates.values()).reduce(
        (total, state) => total + state.snapshots.size,
        0,
      ),
      pendingCommands: Array.from(this.sessions.values()).reduce(
        (total, state) =>
          total +
          state.pendingCommands.size +
          (state.documentCommands?.size ?? 0),
        0,
      ),
      destroyingSessions: this.destroying.size,
      trackedArtifacts: Array.from(this.sessionArtifacts.values()).reduce(
        (total, artifacts) => total + artifacts.attachmentPaths.size,
        0,
      ),
    };
  }

  private createEmptyWorktreeState(
    projectId: string,
    worktreeId: string,
  ): WorktreeBrowserState {
    return {
      projectId,
      worktreeId,
      browserOrder: [],
      activeBrowserId: null,
      snapshots: new Map(),
    };
  }

  private createSessionArtifacts(): BrowserSessionArtifacts {
    return {
      console: [],
      network: [],
      networkStartedAt: new Map(),
      recordingSteps: [],
      attachmentPaths: new Set(),
    };
  }

  private ensureWorktreeState(
    projectId: string,
    worktreeId: string,
  ): WorktreeBrowserState {
    const key = worktreeKey(projectId, worktreeId);
    const existing = this.worktreeStates.get(key);
    if (existing) return existing;
    const response = loadWorktreeBrowserState(projectId, worktreeId);
    const state =
      response.status === 'loaded'
        ? runtimeStateFromPersisted(projectId, worktreeId, response.state)
        : this.createEmptyWorktreeState(projectId, worktreeId);
    if (response.status === 'fallback' || response.status === 'rejected') {
      // Keep the rejected file recoverable and block new bindings until a later
      // explicit load observes a valid or missing file.
      this.rejectedWorktreeStates.set(key, response.error);
    } else {
      this.rejectedWorktreeStates.delete(key);
    }
    this.worktreeStates.set(key, state);
    return state;
  }

  private async mutateBindingState(
    projectId: string,
    worktreeId: string,
    mutate: (state: WorktreeBrowserState) => boolean,
    commitBinding?: BrowserStateCommit,
    signal?: AbortSignal,
  ): Promise<WorktreeBrowserState> {
    const key = worktreeKey(projectId, worktreeId);
    const controller = new AbortController();
    const pending = this.bindingCommits.get(key) ?? new Set<AbortController>();
    pending.add(controller);
    this.bindingCommits.set(key, pending);
    try {
      return await this.mutateWorktreeState(
        projectId,
        worktreeId,
        mutate,
        commitBinding,
        signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal,
      );
    } finally {
      pending.delete(controller);
      if (pending.size === 0) this.bindingCommits.delete(key);
    }
  }

  private mutateWorktreeState(
    projectId: string,
    worktreeId: string,
    mutate: (state: WorktreeBrowserState) => boolean,
    commitBinding?: BrowserStateCommit,
    signal?: AbortSignal,
  ): Promise<WorktreeBrowserState> {
    const key = worktreeKey(projectId, worktreeId);
    this.ensureWorktreeState(projectId, worktreeId);
    const run = async (): Promise<WorktreeBrowserState> => {
      const current =
        this.worktreeStates.get(key) ??
        this.ensureWorktreeState(projectId, worktreeId);
      const nextState = cloneWorktreeState(current);
      if (!mutate(nextState)) return current;
      if (!this.rejectedWorktreeStates.has(key)) {
        await this.persistWorktreeState(nextState, commitBinding, signal);
      }
      this.mergeLiveSnapshots(nextState);
      this.worktreeStates.set(key, nextState);
      return nextState;
    };
    return this.mutationQueues.run(key, run, signal);
  }

  private persistWorktreeState(
    state: WorktreeBrowserState,
    commitBinding?: BrowserStateCommit,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = worktreeKey(state.projectId, state.worktreeId);
    this.cancelSnapshotPersistence(key);
    const request: SaveWorktreeBrowserStateRequest = {
      projectId: state.projectId,
      worktreeId: state.worktreeId,
      state: persistedStateFromRuntime(state),
    };
    return this.enqueuePersistence(key, request, commitBinding, signal);
  }

  private enqueuePersistence(
    key: string,
    request: SaveWorktreeBrowserStateRequest,
    commitBinding?: BrowserStateCommit,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.persistenceQueues.run(
      key,
      () =>
        commitBinding || signal
          ? saveWorktreeBrowserState(request, commitBinding, signal)
          : saveWorktreeBrowserState(request),
      signal,
    );
  }

  private cancelSnapshotPersistence(key: string): void {
    const timer = this.snapshotPersistenceTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.snapshotPersistenceTimers.delete(key);
    }
  }

  private scheduleSnapshotPersistence(state: LiveBrowserSession): void {
    const key = worktreeKey(
      state.snapshot.projectId,
      state.snapshot.worktreeId,
    );
    this.cancelSnapshotPersistence(key);
    const timer = setTimeout(() => {
      this.snapshotPersistenceTimers.delete(key);
      const current = this.worktreeStates.get(key);
      if (current) {
        void this.mutateWorktreeState(
          current.projectId,
          current.worktreeId,
          () => true,
        ).catch(() => undefined);
      }
    }, SNAPSHOT_PERSISTENCE_DELAY_MS);
    this.snapshotPersistenceTimers.set(key, timer);
  }

  private rememberLiveSnapshot(state: LiveBrowserSession): void {
    const key = worktreeKey(
      state.snapshot.projectId,
      state.snapshot.worktreeId,
    );
    const worktreeState = this.worktreeStates.get(key);
    if (!worktreeState) return;
    worktreeState.snapshots.set(state.snapshot.id, { ...state.snapshot });
    if (!worktreeState.browserOrder.includes(state.snapshot.id)) {
      worktreeState.browserOrder.push(state.snapshot.id);
    }
  }

  private mergeLiveSnapshots(state: WorktreeBrowserState): void {
    for (const sessionState of Array.from(this.sessions.values())) {
      const snapshot = sessionState.snapshot;
      if (
        snapshot.projectId !== state.projectId ||
        snapshot.worktreeId !== state.worktreeId
      ) {
        continue;
      }
      state.snapshots.set(snapshot.id, { ...snapshot });
      if (!state.browserOrder.includes(snapshot.id)) {
        state.browserOrder.push(snapshot.id);
      }
    }
  }

  private async persistLiveSnapshot(
    state: LiveBrowserSession,
    assertCurrent?: () => void,
  ): Promise<void> {
    await this.mutateWorktreeState(
      state.snapshot.projectId,
      state.snapshot.worktreeId,
      (nextState) => {
        assertCurrent?.();
        if (this.sessions.get(state.snapshot.id) !== state) return false;
        nextState.snapshots.set(state.snapshot.id, { ...state.snapshot });
        if (!nextState.browserOrder.includes(state.snapshot.id)) {
          nextState.browserOrder.push(state.snapshot.id);
        }
        return true;
      },
    );
  }

  private isOwnedBrowser(
    state: WorktreeBrowserState,
    browserId: string,
  ): boolean {
    const persisted = state.snapshots.get(browserId);
    if (
      persisted?.projectId === state.projectId &&
      persisted.worktreeId === state.worktreeId
    ) {
      return true;
    }
    const live = this.sessions.get(browserId)?.snapshot;
    return (
      live?.projectId === state.projectId &&
      live.worktreeId === state.worktreeId
    );
  }

  private findBrowserOwner(browserId: string): WorktreeBrowserState | null {
    const live = this.sessions.get(browserId)?.snapshot;
    if (live) {
      return this.ensureWorktreeState(live.projectId, live.worktreeId);
    }
    return (
      Array.from(this.worktreeStates.values()).find((state) =>
        state.snapshots.has(browserId),
      ) ?? null
    );
  }

  private async performPermanentDestroy(browserId: string): Promise<void> {
    const live = this.sessions.get(browserId);
    const pendingBinding = this.pendingBrowserBindings.get(browserId);
    const ownerSnapshot = live?.snapshot ?? pendingBinding;
    const hostWindow = live?.hostWindow;
    const owner =
      this.findBrowserOwner(browserId) ??
      (ownerSnapshot
        ? this.ensureWorktreeState(
            ownerSnapshot.projectId,
            ownerSnapshot.worktreeId,
          )
        : null);
    if (!owner) return;
    const removedIndex = owner.browserOrder.indexOf(browserId);
    if (
      removedIndex < 0 &&
      !owner.snapshots.has(browserId) &&
      !live &&
      !pendingBinding
    )
      return;

    await this.disposeLiveViewInternal(browserId, false);

    const latest =
      this.worktreeStates.get(worktreeKey(owner.projectId, owner.worktreeId)) ??
      owner;
    await this.mutateWorktreeState(
      latest.projectId,
      latest.worktreeId,
      (nextState) => {
        const currentIndex = nextState.browserOrder.indexOf(browserId);
        if (currentIndex >= 0) {
          nextState.browserOrder.splice(currentIndex, 1);
        }
        const removedSnapshot = nextState.snapshots.delete(browserId);
        if (nextState.activeBrowserId === browserId) {
          nextState.activeBrowserId =
            nextState.browserOrder[
              Math.min(
                currentIndex >= 0 ? currentIndex : removedIndex,
                nextState.browserOrder.length - 1,
              )
            ] ?? null;
        }
        return currentIndex >= 0 || removedSnapshot;
      },
    );
    await this.cleanupBrowserArtifacts(browserId);
    this.sessionArtifacts.delete(browserId);
    this.emit(
      {
        type: 'destroyed',
        browserId,
        runtimeGeneration:
          live?.snapshot.profile?.runtimeGeneration ??
          owner.snapshots.get(browserId)?.profile?.runtimeGeneration ??
          pendingBinding?.profile?.runtimeGeneration,
      },
      hostWindow,
    );
  }

  private disposeLiveViewInternal(
    browserId: string,
    preserveSnapshot: boolean,
  ): Promise<void> {
    const inProgress = this.liveDisposals.get(browserId);
    if (inProgress) return inProgress;
    const disposal = this.performLiveDisposal(
      browserId,
      preserveSnapshot,
    ).finally(() => {
      this.liveDisposals.delete(browserId);
    });
    this.liveDisposals.set(browserId, disposal);
    return disposal;
  }

  private async performLiveDisposal(
    browserId: string,
    preserveSnapshot: boolean,
  ): Promise<void> {
    const state = this.sessions.get(browserId);
    if (!state) return;
    // Its pages can no longer read the staged copies of its uploads.
    await this.taskFiles
      .releaseUploads(
        {
          projectId: state.snapshot.projectId,
          worktreeId: state.snapshot.worktreeId,
        },
        browserId,
      )
      .catch(() => undefined);
    if (state.pendingFileChooser) {
      clearTimeout(state.pendingFileChooser.timer);
      state.pendingFileChooser = undefined;
      // The renderer keeps the browser across a worktree switch; end its notice.
      this.emit(
        {
          type: 'file-chooser',
          runtimeGeneration: state.snapshot.profile?.runtimeGeneration,
          browserId,
          chooser: null,
        },
        state.hostWindow,
      );
    }
    if (state.pendingAuthRequest) {
      const auth = state.pendingAuthRequest;
      clearTimeout(auth.timer);
      state.pendingAuthRequest = undefined;
      for (const callback of auth.callbacks) callback();
      this.emit(
        {
          type: 'auth-request',
          runtimeGeneration: state.snapshot.profile?.runtimeGeneration,
          browserId,
          request: null,
        },
        state.hostWindow,
      );
    }
    if (state.pendingPrintRequest) {
      clearTimeout(state.pendingPrintRequest.timer);
      state.pendingPrintRequest = undefined;
      this.emit(
        {
          type: 'print-request',
          runtimeGeneration: state.snapshot.profile?.runtimeGeneration,
          browserId,
          request: null,
        },
        state.hostWindow,
      );
    }
    const waits = this.waitForControllers.get(state);
    this.waitForControllers.delete(state);
    waits?.forEach((controller) =>
      controller.abort(new Error('The browser runtime was disposed.')),
    );
    this.actionLanes.disposeFor(state);
    state.pageModel.dispose();
    state.mainFrameNavigation.stopped();
    state.activeActionDialog = undefined;
    let persistenceError: unknown;
    if (preserveSnapshot) {
      try {
        await this.persistLiveSnapshot(state);
      } catch (error) {
        persistenceError = error;
      }
    }
    if (this.sessions.get(browserId) === state) {
      this.sessions.delete(browserId);
    }
    for (const pending of Array.from(state.pendingCommands.values())) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Browser live view was disposed.'));
    }
    state.pendingCommands.clear();
    if (state.pendingDialogClose) {
      const close = state.pendingDialogClose;
      state.pendingDialogClose = undefined;
      clearTimeout(close.timeout);
      close.reject(new Error('Browser live view was disposed.'));
    }
    const pendingDialogId = state.pendingDialog?.id;
    state.pendingDialog = undefined;
    state.appDialog = undefined;
    state.appPromptPause = undefined;
    if (pendingDialogId) {
      this.emit(
        {
          type: 'dialog-closed',
          runtimeGeneration: state.snapshot.profile?.runtimeGeneration,
          browserId,
          dialogId: pendingDialogId,
        },
        state.hostWindow,
      );
    }
    state.networkStartedAt.clear();
    state.inflightRequestIds.clear();
    state.lastNetworkActivityAt = undefined;
    state.resourceHandle?.unregister();
    state.resourceHandle = undefined;
    const { webContents } = state.view;
    const win = state.hostWindow;
    if (win && state.hostClosedHandler) {
      win.removeListener('closed', state.hostClosedHandler);
      state.hostClosedHandler = undefined;
    }
    try {
      this.showView(state, false);
    } catch {
      // The native view may already be gone during teardown.
    }
    try {
      win?.contentView.removeChildView(state.viewFrame.frame);
    } catch {
      // The parent view may already be gone during teardown.
    }
    // Electron clears WebContentsView.webContents after a successful native
    // close. The profile-switch path deliberately waits for that close first.
    if (!webContents) {
      if (persistenceError)
        throw persistenceError instanceof Error
          ? persistenceError
          : new Error('Browser live-view persistence failed.');
      return;
    }
    try {
      if (!webContents.isDestroyed()) {
        setWebContentsOwnerWindow(webContents, null);
      }
    } catch {
      // Owner cleanup is best-effort once the host or contents is gone.
    }
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          if (webContents.debugger.isAttached()) {
            webContents.debugger.detach();
          }
        } catch {
          // Debugger may already be detached as the contents closes.
        }
        try {
          if (
            typeof webContents.isDevToolsOpened === 'function' &&
            webContents.isDevToolsOpened()
          ) {
            webContents.closeDevTools();
          }
        } catch {
          // DevTools may already be closed.
        }
        webContents.removeAllListeners();
        try {
          if (!webContents.isDestroyed()) {
            webContents.close({ waitForBeforeUnload: false });
          }
        } catch {
          // Close is best-effort after ownership has been released.
        }
        resolve();
      });
    });
    if (persistenceError) {
      throw persistenceError instanceof Error
        ? persistenceError
        : new Error('Browser live-view persistence failed.');
    }
  }

  private async cleanupBrowserArtifacts(browserId: string): Promise<void> {
    await this.dataRuntime?.scratch.cleanup(
      (owner) => owner.browserId === browserId,
    );
  }

  private resolveHostWindow(projectId: string): BrowserWindow | null {
    return (
      this.options.resolveHostWindow?.(projectId) ?? this.options.getWindow()
    );
  }

  private attachView(state: LiveBrowserSession): void {
    const win = state.hostWindow;
    if (win && !win.isDestroyed()) {
      this.noteInputPresentation(state);
      win.contentView.addChildView(state.viewFrame.frame);
      setWebContentsOwnerWindow(state.view.webContents, win);
      this.showView(state, false);
      this.options.onViewAttached?.(win);
    }
  }

  /**
   * Own Electron's private JavaScript-dialog callback so the renderer can
   * present one consistent app-owned surface for alert(), confirm(), prompt(),
   * and beforeunload. Leaving the callback unresolved preserves the browser's
   * synchronous modal semantics while the app UI responds asynchronously.
   */
  private attachAppOwnedDialogController(state: LiveBrowserSession): void {
    const contents = state.view.webContents;
    attachElectronPrivateDialogEvents(
      contents,
      (
        info: ElectronJavaScriptDialogInfo,
        callback: ElectronJavaScriptDialogCallback,
      ): void => {
        this.openAppOwnedJavaScriptDialog(state, info, callback);
      },
      () => {
        const dialogId =
          state.appDialog?.dialogId ?? state.pendingDialogClose?.dialogId;
        state.appDialog = undefined;
        if (!dialogId || state.pendingDialog?.id !== dialogId) {
          return;
        }
        state.pendingDialog = undefined;
        this.closeCorrelatedDialog(state, dialogId);
        this.emitForSession(state, {
          type: 'dialog-closed',
          browserId: state.snapshot.id,
          dialogId,
        });
        if (state.pendingDialogClose?.dialogId === dialogId) {
          const close = state.pendingDialogClose;
          state.pendingDialogClose = undefined;
          clearTimeout(close.timeout);
          close.resolve();
        }
      },
    );
  }

  private handleWillPreventUnload(
    state: LiveBrowserSession,
    event: { preventDefault: () => void },
  ): void {
    if (state.allowNextBeforeUnload) {
      state.allowNextBeforeUnload = false;
      state.pendingBeforeUnloadAction = undefined;
      event.preventDefault();
      return;
    }
    if (state.pendingDialog && state.pendingDialog.type !== 'beforeunload') {
      return;
    }
    const action = state.pendingBeforeUnloadAction ?? { kind: 'reload' };
    const dialog: BrowserJavaScriptDialog = {
      id: state.pendingDialog?.id ?? uuid(),
      browserId: state.snapshot.id,
      type: 'beforeunload',
      message: 'Changes you made may not be saved.',
      url: state.snapshot.url,
      openedAt: now(),
    };
    state.pendingDialog = dialog;
    state.appBeforeUnloadDialog = {
      dialogId: dialog.id,
      action,
    };
    this.publishPendingDialog(state, dialog);
  }

  private handleBeforeUnloadDialog(
    state: LiveBrowserSession,
    dialog: BrowserJavaScriptDialog,
    beforeUnload: AppOwnedBeforeUnloadDialog,
    accept: boolean,
  ): BrowserHandleJavaScriptDialogResponse {
    state.appBeforeUnloadDialog = undefined;
    state.pendingDialog = undefined;
    state.pendingBeforeUnloadAction = undefined;
    this.emitForSession(state, {
      type: 'dialog-closed',
      browserId: state.snapshot.id,
      dialogId: dialog.id,
    });
    if (beforeUnload.action.kind === 'profile-switch') {
      state.profileSwitchDecision?.(accept);
    } else if (accept) {
      state.allowNextBeforeUnload = true;
      this.replayBeforeUnloadAction(state, beforeUnload.action);
    } else {
      state.navigationChainAllowsFileTargets = isFileBrowserUrl(
        state.view.webContents.getURL(),
      );
    }
    return {
      dialog: { ...dialog },
      accept,
    };
  }

  private replayBeforeUnloadAction(
    state: LiveBrowserSession,
    action: BeforeUnloadAction,
  ): void {
    const contents = state.view.webContents;
    if (action.kind === 'navigate') {
      void this.loadUrlWithBoundedWait(state, action.url);
      return;
    }
    if (action.kind === 'back') {
      goBack(contents);
      return;
    }
    if (action.kind === 'forward') {
      goForward(contents);
      return;
    }
    contents.reload();
  }

  private handledInterceptedPageDialog(
    state: LiveBrowserSession,
    capture: PrearmedPageDialogCapture,
    response: BrowserJavaScriptDialogResponse | undefined,
  ): BrowserHandleJavaScriptDialogResponse {
    return {
      dialog: {
        id: uuid(),
        browserId: state.snapshot.id,
        type: capture.type,
        message: capture.message,
        ...(capture.defaultPrompt
          ? { defaultPrompt: capture.defaultPrompt }
          : {}),
        url: capture.url,
        openedAt: capture.openedAt,
      },
      accept: response?.accept ?? false,
      ...(response?.promptText !== undefined
        ? {
            promptText: response.promptText.slice(
              0,
              JAVASCRIPT_DIALOG_PROMPT_LIMIT,
            ),
          }
        : {}),
    };
  }

  private prearmedPageDialogCapture(
    state: LiveBrowserSession,
    value: unknown,
  ): PrearmedPageDialogCapture | null {
    if (!isRecord(value)) return null;
    const type = browserJavaScriptDialogType(value.type);
    if (!type) return null;
    const defaultPrompt = optionalString(value.defaultPrompt).slice(
      0,
      JAVASCRIPT_DIALOG_PROMPT_LIMIT,
    );
    return {
      type,
      message: optionalString(value.message).slice(
        0,
        JAVASCRIPT_DIALOG_MESSAGE_LIMIT,
      ),
      ...(defaultPrompt ? { defaultPrompt } : {}),
      url: optionalString(value.url, state.snapshot.url),
      openedAt:
        typeof value.openedAt === 'number' ? value.openedAt : Date.now(),
    };
  }

  private answerPrivateDialog(
    state: LiveBrowserSession,
    callback: ElectronJavaScriptDialogCallback,
    accept: boolean,
    promptText: string,
  ): void {
    const answered =
      state.answeredDialogCallbacks ??
      new WeakSet<ElectronJavaScriptDialogCallback>();
    state.answeredDialogCallbacks = answered;
    if (answered.has(callback)) return;
    answered.add(callback);
    callback(accept, promptText);
  }

  private correlateDialogSource(
    state: LiveBrowserSession,
    dialog: BrowserJavaScriptDialog,
    source: 'private' | 'cdp',
  ): void {
    const records = (state.dialogCorrelations ?? []).filter(
      (item) =>
        item.closedAt === undefined || Date.now() - item.closedAt <= 2_000,
    );
    let record = records.find((item) => item.dialog.id === dialog.id);
    if (!record) {
      record = { dialog, privateSeen: false, cdpSeen: false };
      records.push(record);
    }
    record.dialog = dialog;
    if (source === 'private') record.privateSeen = true;
    else record.cdpSeen = true;
    state.dialogCorrelations = records.slice(-16);
    this.notifyActionSettle(state);
  }

  private recentDialogOtherSource(
    state: LiveBrowserSession,
    source: 'private' | 'cdp',
    type: BrowserJavaScriptDialog['type'],
    message: string,
    url: string,
    frameId?: string,
  ): BrowserDialogCorrelation | undefined {
    return state.dialogCorrelations?.find(
      (item) =>
        item.closedAt !== undefined &&
        Date.now() - item.dialog.openedAt <= 2_000 &&
        item.answer !== undefined &&
        !(source === 'private' ? item.privateSeen : item.cdpSeen) &&
        item.dialog.type === type &&
        item.dialog.message === message &&
        item.dialog.url === url &&
        (!frameId || !item.dialog.frameId || item.dialog.frameId === frameId),
    );
  }

  private closeCorrelatedDialog(
    state: LiveBrowserSession,
    dialogId: string,
  ): void {
    const record = state.dialogCorrelations?.find(
      (item) => item.dialog.id === dialogId,
    );
    if (record) record.closedAt = Date.now();
  }

  private openAppOwnedJavaScriptDialog(
    state: LiveBrowserSession,
    info: ElectronJavaScriptDialogInfo,
    callback: ElectronJavaScriptDialogCallback,
  ): void {
    if (state.answeredDialogCallbacks?.has(callback)) return;
    if (!this.isCurrentLiveSession(state)) {
      callback(false, '');
      return;
    }
    const type = browserJavaScriptDialogType(info.dialogType);
    if (
      type === 'beforeunload' &&
      (state.allowNextBeforeUnload || state.profileSwitchClosingAccepted)
    ) {
      callback(true, '');
      return;
    }
    const existing = state.pendingDialog;
    const recent =
      !existing && type
        ? this.recentDialogOtherSource(
            state,
            'private',
            type,
            info.messageText.slice(0, JAVASCRIPT_DIALOG_MESSAGE_LIMIT),
            optionalString(info.frame?.url, state.snapshot.url),
          )
        : undefined;
    if (recent) {
      recent.privateSeen = true;
      this.notifyActionSettle(state);
      // Chromium has already accepted this answer. Release Electron's delayed
      // callback with the identical answer, never a second/default dismissal.
      if (recent.answer) {
        try {
          this.answerPrivateDialog(
            state,
            callback,
            recent.answer.accept,
            recent.answer.promptText,
          );
        } catch (error) {
          this.captureConsole(state, {
            level: 'warning',
            text: `Failed to release a closed browser dialog callback: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      return;
    }
    if (
      existing &&
      existing.type === type &&
      existing.message ===
        info.messageText.slice(0, JAVASCRIPT_DIALOG_MESSAGE_LIMIT) &&
      (state.appDialog?.dialogId === existing.id ||
        state.pendingDialogClose?.dialogId === existing.id)
    ) {
      // This is the private notification for the already claimed native
      // dialog. Calling its callback would race the selected answer transport.
      this.correlateDialogSource(state, existing, 'private');
      return;
    }
    if (!type || state.appDialog || state.pendingDialogClose) {
      callback(false, '');
      return;
    }

    if (
      existing &&
      (existing.type !== type ||
        existing.message !==
          info.messageText.slice(0, JAVASCRIPT_DIALOG_MESSAGE_LIMIT))
    ) {
      callback(false, '');
      return;
    }
    const defaultPrompt = optionalString(info.defaultPromptText).slice(
      0,
      JAVASCRIPT_DIALOG_PROMPT_LIMIT,
    );
    const dialog: BrowserJavaScriptDialog = existing ?? {
      id: uuid(),
      browserId: state.snapshot.id,
      type,
      message: info.messageText.slice(0, JAVASCRIPT_DIALOG_MESSAGE_LIMIT),
      ...(defaultPrompt ? { defaultPrompt } : {}),
      url: optionalString(info.frame?.url, state.snapshot.url),
      openedAt: now(),
    };
    state.pendingDialog = dialog;
    this.correlateDialogSource(state, dialog, 'private');
    state.appDialog = {
      dialogId: dialog.id,
      callback,
    };

    if (!existing) {
      this.publishPendingDialog(state, dialog);
    }
  }

  private publishPendingDialog(
    state: LiveBrowserSession,
    dialog: BrowserJavaScriptDialog,
  ): void {
    state.activeActionDialog?.(dialog);
    for (const resolve of Array.from(state.pendingDialogWaiters)) {
      resolve(dialog);
    }
    state.pendingDialogWaiters.clear();
    this.emitForSession(state, {
      type: 'dialog-opened',
      browserId: state.snapshot.id,
      dialog: { ...dialog },
    });
    this.rejectPendingCommandsForDialog(state, dialog);
  }

  private async handlePausedAppPrompt(
    state: LiveBrowserSession,
    dialog: BrowserJavaScriptDialog,
    pause: AppOwnedPromptPause,
    accept: boolean,
    promptText: string | undefined,
  ): Promise<BrowserHandleJavaScriptDialogResponse> {
    if (pause.handling) {
      throw new Error(`Browser dialog ${dialog.id} is already being handled.`);
    }
    pause.handling = true;
    const resolvedPromptText = promptText ?? dialog.defaultPrompt ?? '';
    const bridgeResult = accept ? JSON.stringify(resolvedPromptText) : 'null';
    try {
      const assignment = await this.sendDebuggerCommandResultWithBoundedWait(
        state,
        'Debugger.evaluateOnCallFrame',
        {
          callFrameId: pause.callFrameId,
          expression: `(() => {
            if (!bridge || bridge.marker !== ${JSON.stringify(APP_PROMPT_BRIDGE_MARKER)}) return false;
            bridge.result = ${bridgeResult};
            return true;
          })()`,
          returnByValue: true,
        },
      );
      const assignmentResult =
        isRecord(assignment) && isRecord(assignment.result)
          ? assignment.result
          : {};
      if (isRecord(assignment) && isRecord(assignment.exceptionDetails)) {
        throw new Error(
          optionalString(
            assignment.exceptionDetails.text,
            'Could not set the browser prompt response.',
          ),
        );
      }
      if (assignmentResult.value !== true) {
        throw new Error('The browser prompt bridge is no longer available.');
      }

      state.appPromptPause = undefined;
      try {
        await this.sendDebuggerCommandResultWithBoundedWait(
          state,
          'Debugger.resume',
        );
      } catch (error) {
        state.appPromptPause = pause;
        throw error;
      }
      if (state.pendingDialog?.id === dialog.id) {
        state.pendingDialog = undefined;
        this.emitForSession(state, {
          type: 'dialog-closed',
          browserId: state.snapshot.id,
          dialogId: dialog.id,
        });
      }
      return {
        dialog: { ...dialog },
        accept,
        ...(accept ? { promptText: resolvedPromptText } : {}),
      };
    } catch (error) {
      pause.handling = false;
      throw error;
    }
  }

  private browserRendererPid(state: LiveBrowserSession): number | undefined {
    const contents = state.view.webContents;
    try {
      if (contents.isDestroyed()) {
        return undefined;
      }
      const pid = contents.getOSProcessId();
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  private browserResourceMetadata(state: LiveBrowserSession): ResourceMetadata {
    const { snapshot } = state;
    const title = snapshot.title.trim();
    const displayUrl = browserDisplayUrl(snapshot.url);
    return {
      type: 'browser',
      browser: {
        projectId: snapshot.projectId,
        worktreeId: snapshot.worktreeId,
        browserId: snapshot.id,
        ...(title.length > 0 ? { title } : {}),
        ...(displayUrl ? { displayUrl } : {}),
        visible: state.visible,
        status: snapshot.status,
      },
    };
  }

  private registerBrowserResource(state: LiveBrowserSession): void {
    state.resourceHandle = getResourceMonitorService().registerProcess({
      id: `browser:${state.snapshot.id}`,
      groupId: 'browser',
      kind: 'in-app-browser',
      label: browserResourceLabel(state.snapshot),
      pid: this.browserRendererPid(state),
      startedAt: new Date(state.snapshot.createdAt).toISOString(),
      metadata: this.browserResourceMetadata(state),
    });
  }

  private updateBrowserResource(state: LiveBrowserSession): void {
    state.resourceHandle?.update({
      label: browserResourceLabel(state.snapshot),
      pid: this.browserRendererPid(state),
      metadata: this.browserResourceMetadata(state),
    });
  }

  private attachWebContentsListeners(state: LiveBrowserSession): void {
    const contents = state.view.webContents;
    // Browser-owned hotkeys must work while the native page owns keyboard
    // focus (ECW-7984): the renderer's global shortcut handler never sees
    // keydowns routed to this webContents, so the chords are intercepted
    // here. `event.preventDefault()` consumes a handled chord exactly once —
    // it never reaches page JavaScript, and it cannot also fire in the main
    // renderer window (focus is here, not there).
    contents.on('before-input-event', (event, input) => {
      const action = resolveBrowserShortcutAction(input, process.platform);
      if (action === null) {
        return;
      }
      event.preventDefault();
      this.handleBrowserShortcut(state, action);
    });
    contents.on('found-in-page', (_event, result) => {
      this.emitForSession(state, {
        type: 'find-result',
        browserId: state.snapshot.id,
        requestId: result.requestId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate,
      });
    });
    contents.on('did-start-loading', () => {
      state.pendingBeforeUnloadAction = undefined;
      state.allowNextBeforeUnload = false;
      this.beginLoad(state);
      updateSnapshot(state, {
        status: normalizeStatusForLoadStart(),
        loading: true,
        lastError: undefined,
      });
      this.emitSnapshot(state);
    });
    contents.on('did-stop-loading', () => {
      state.heldLoadUrl = undefined;
      state.mainFrameNavigation.stopped();
      // Nothing finishes or fails a load whose response was saved as a download.
      if (state.load?.savedAsDownload && state.snapshot.status === 'loading') {
        this.restoreLoadOrigin(state);
        return;
      }
      this.refreshNavigationState(state);
    });
    contents.on('dom-ready', () => {
      state.mainFrameNavigation.domContentLoaded();
    });
    contents.on('did-finish-load', () => {
      this.refreshNavigationState(state, { status: 'ready', loading: false });
      void this.observeCommittedFrameTree(state);
      void this.ensureAppOwnedPromptBridge(state);
      this.restoreRecordingIfNeeded(state);
    });
    contents.on(
      'did-fail-load',
      (_event, errorCode, description, url, isMainFrame) => {
        if (!isMainFrame) return;
        // ERR_ABORTED (-3) is not a real load failure: it fires when a newer
        // navigation (or an explicit stop) supersedes the current one. Surfacing
        // it as "failed" would flash an error page while the superseding load is
        // still resolving, so ignore it. A read waiting on the navigation
        // waits for the newer one, or for the stop's `did-stop-loading`.
        if (errorCode === ERR_ABORTED_CODE) return;
        state.mainFrameNavigation.stopped();
        state.navigationChainAllowsFileTargets = isFileBrowserUrl(
          contents.getURL(),
        );
        updateSnapshot(state, {
          url: snapshotUrlFromWebContents(url, state.snapshot.url),
          status: 'failed',
          loading: false,
          lastError: describeBrowserLoadFailure(errorCode, description, url),
        });
        this.emitForSession(state, {
          type: 'load-failed',
          browserId: state.snapshot.id,
          snapshot: state.snapshot,
        });
      },
    );
    contents.on('page-title-updated', (_event, title) => {
      updateSnapshot(state, { title });
      this.emitSnapshot(state);
    });
    contents.on('page-favicon-updated', (_event, favicons) => {
      const faviconUrl = favicons.find((entry) => entry.length > 0);
      updateSnapshot(state, { faviconUrl });
      this.emitSnapshot(state);
    });
    contents.on('did-navigate', (_event, url) => {
      state.mainFrameNavigation.committed();
      state.actionDocumentRevision = (state.actionDocumentRevision ?? 0) + 1;
      cancelDocumentCommands(
        state,
        new Error('Browser main-frame document was replaced.'),
      );
      this.handleCommittedNavigation(state, url);
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        this.handleCommittedNavigation(state, url);
      }
    });
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      // A page-started load (link, form, history) is not the held first load.
      if (
        state.heldLoadUrl !== undefined &&
        !sameBrowserUrl(details.url, state.heldLoadUrl)
      )
        state.heldLoadUrl = undefined;
      // A sign-in belongs to the load that hit it; the next page's own
      // challenge must reach the user.
      this.endAuthRequest(state);
      state.mainFrameNavigation.started();
      state.navigationChainAllowsFileTargets =
        isFileBrowserUrl(contents.getURL()) && isFileBrowserUrl(details.url);
    });
    contents.on('will-navigate', (event, url) => {
      state.navigationChainAllowsFileTargets =
        isTrustedLocalFileSource(event.initiator?.url) && isFileBrowserUrl(url);
      if (this.isUrlAllowedInApp(url)) {
        state.pendingBeforeUnloadAction = { kind: 'navigate', url };
      }
      this.guardInAppNavigation(state, event, url);
    });
    contents.on('will-redirect', (event, url) => {
      this.guardInAppNavigation(state, event, url);
    });
    contents.on('will-prevent-unload', (event) => {
      this.handleWillPreventUnload(state, event);
    });
    contents.setWindowOpenHandler((details) => {
      const targetIsFile = isFileBrowserUrl(details.url);
      if (
        this.isUrlAllowedInApp(details.url) &&
        (!targetIsFile || isTrustedLocalFileSource(details.referrer?.url))
      ) {
        const { projectId, worktreeId } = state.snapshot;
        // A sign-in view has no tabs, so its popups continue in it.
        if (isMcpOAuthBrowserScope(projectId, worktreeId)) {
          this.noteActionPopup(state, details.url, 'opened_in_tab');
          void this.navigate({
            browserId: state.snapshot.id,
            url: details.url,
          });
        } else {
          const newBrowserId = randomUUID();
          const popup = this.noteActionPopup(
            state,
            details.url,
            'opened_in_tab',
          );
          if (popup) popup.browserId = newBrowserId;
          const selection = state.snapshot.profile?.selection;
          this.popupTabs.set(newBrowserId, {
            ...(selection ? { selection } : {}),
            agent: popup !== undefined,
          });
          // The new tab is a separate session, so the page keeps no opener.
          this.emitForSession(state, {
            type: 'new-tab-requested',
            browserId: state.snapshot.id,
            snapshot: state.snapshot,
            url: details.url,
            newBrowserId,
            ...(popup ? { presentation: 'background' } : {}),
          });
        }
      } else if (targetIsFile) {
        this.noteActionPopup(state, details.url, 'blocked');
        this.captureConsole(state, {
          level: 'warning',
          text: 'A web page cannot navigate directly to a local file.',
        });
      } else if (!targetIsFile) {
        const popup = this.noteActionPopup(
          state,
          details.url,
          isSafeExternalBrowserUrl(details.url)
            ? 'opened_externally'
            : 'blocked',
        );
        void this.openExternal(details.url).catch((error) => {
          // shortcut: a failure after the action's receipt is not corrected there.
          if (popup) popup.handled = 'blocked';
          this.captureConsole(state, {
            level: 'warning',
            text: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return { action: 'deny' };
    });
    // HTTP auth waits for the user's own credentials; see handleLogin.
    contents.on('login', (event, details, authInfo, callback) => {
      event.preventDefault();
      this.handleLogin(state, details.url, authInfo, callback);
    });
    contents.on('render-process-gone', (_event, details) => {
      state.mainFrameNavigation.stopped();
      cancelDocumentCommands(
        state,
        new Error('Browser renderer process was lost.'),
      );
      updateSnapshot(state, {
        status: 'failed',
        loading: false,
        lastError: `Renderer process gone: ${details.reason}`,
      });
      this.emitForSession(state, {
        type: 'load-failed',
        browserId: state.snapshot.id,
        snapshot: state.snapshot,
      });
    });
    contents.on('unresponsive', () => {
      this.captureConsole(state, {
        level: 'warning',
        text: 'Embedded browser became unresponsive.',
      });
      updateSnapshot(state, {
        status: 'failed',
        loading: false,
        lastError: 'Embedded browser became unresponsive.',
      });
      this.emitForSession(state, {
        type: 'load-failed',
        browserId: state.snapshot.id,
        snapshot: state.snapshot,
      });
    });
  }

  private readonly observationReads = new WeakMap<
    LiveBrowserSession,
    Map<string, Promise<void>>
  >();
  private observeCommittedFrameTree(
    state: LiveBrowserSession,
    sessionId = '',
  ): Promise<void> {
    const reads =
      this.observationReads.get(state) ?? new Map<string, Promise<void>>();
    const pending = reads.get(sessionId);
    if (pending) return pending;
    const data = this.dataRuntime;
    const binding = state.snapshot.profile;
    if (
      !data ||
      !binding ||
      this.maintenanceFences.has(binding.resolvedProfileId)
    )
      return Promise.resolve();
    const sequence = state.navigationSequence;
    const operation = (async (): Promise<void> => {
      // Page.enable can still be pending when a new renderer first navigates.
      // Reading the committed tree fills that gap without running page code.
      const value = await this.sendDebuggerCommandResultWithBoundedWait(
        state,
        'Page.getFrameTree',
        undefined,
        sessionId,
      );
      if (
        !this.isCurrentLiveSession(state) ||
        state.navigationSequence !== sequence ||
        this.maintenanceFences.has(binding.resolvedProfileId)
      )
        return;
      if (
        !isRecord(value) ||
        !isRecord(value.frameTree) ||
        !isRecord(value.frameTree.frame)
      )
        return;
      const topUrl = sessionId
        ? state.view.webContents.getURL()
        : value.frameTree.frame.url;
      if (typeof topUrl !== 'string' || !/^https?:/.test(topUrl)) return;
      const queue: unknown[] = [value.frameTree];
      for (let index = 0; index < queue.length && index < 1000; index++) {
        const tree = queue[index];
        if (!isRecord(tree) || !isRecord(tree.frame)) continue;
        data.observations.record(
          binding.resolvedProfileId,
          binding.storageGeneration,
          tree.frame.url,
          topUrl,
          tree.frame.domainAndRegistry,
        );
        if (Array.isArray(tree.childFrames))
          queue.push(
            ...(tree.childFrames as unknown[]).slice(
              0,
              Math.max(0, 1001 - queue.length),
            ),
          );
      }
      if (queue.length > 1000)
        data.observations.record(
          binding.resolvedProfileId,
          binding.storageGeneration,
          null,
          null,
          null,
        );
    })()
      .catch(() => undefined)
      .finally(() => reads.delete(sessionId));
    reads.set(sessionId, operation);
    this.observationReads.set(state, reads);
    return operation;
  }

  private attachDebugger(state: LiveBrowserSession): void {
    const debug = state.view.webContents.debugger;
    const reportFailure = (error: unknown): void => {
      this.captureConsole(state, {
        level: 'warning',
        text: `Failed to attach browser diagnostics: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    };
    try {
      if (!debug.isAttached()) {
        debug.attach('1.3');
      }
      debug.on('message', (_event, method, params, sessionId) => {
        this.handleDebuggerMessage(state, method, params, sessionId);
      });
      // Queued, never awaited: a view that has not navigated yet has no
      // renderer, so Chromium holds renderer-bound commands until the first
      // navigation starts one. Waiting here delayed every new tab by the full
      // command timeout without the commands ever answering in time. Closing
      // a tab before it navigates rejects them; that session no longer
      // captures console entries, so the report is dropped.
      void this.installAppOwnedPromptBridge(state).catch(reportFailure);
      void Promise.allSettled([
        this.enableFrameObservations(state),
        debug.sendCommand('Runtime.enable'),
        // Only a session's first DOM.enable decides whether DOM.getDocument
        // reports whitespace-only text, which textContent-derived names need.
        // Nothing sends a DOM command to the root session before this one.
        debug.sendCommand('DOM.enable', { includeWhitespace: 'all' }),
        debug.sendCommand('Network.enable'),
        debug.sendCommand('Log.enable'),
        // CDP does not expose Emulation.enable; setting emulated media initializes the domain.
        debug.sendCommand('Emulation.setEmulatedMedia', {
          features: [
            {
              name: 'prefers-color-scheme',
              value: emulatedColorScheme(state.snapshot.themeMode),
            },
          ],
        }),
        // CAN-1993: automations must keep working while the user is in another
        // app. Focus emulation makes the page (`document.hasFocus()`, `:focus`,
        // focus-gated input handlers) behave as focused without the native
        // view ever requesting OS focus, so a background run never has a
        // reason to pull the window forward.
        debug.sendCommand('Emulation.setFocusEmulationEnabled', {
          enabled: true,
        }),
      ]);
    } catch (error) {
      reportFailure(error);
    }
  }

  // Electron 42 cancels prompt() before either its private dialog event or
  // CDP reports it. Install a main-world wrapper for every new document and
  // enable the Debugger domain so the wrapper can preserve the synchronous
  // call stack while the app-owned prompt UI responds asynchronously. The
  // first document is covered by `ensureAppOwnedPromptBridge` after its load.
  private async installAppOwnedPromptBridge(
    state: LiveBrowserSession,
  ): Promise<void> {
    const debug = state.view.webContents.debugger;
    const enabled = Promise.all([
      debug.sendCommand('Debugger.enable'),
      debug.sendCommand('Page.enable'),
    ]);
    // The page model's document-start trackers (D4), queued right behind
    // Page.enable in this same turn. Commands wait for the renderer the first
    // navigation starts and then run in order, so the trackers are in place
    // before that navigation's child documents. Awaiting Page.enable first
    // let same-process frames of the first page start untracked. Registered
    // after every Page.enable, since Page.disable drops registered scripts.
    const trackers = state.pageModel.installTrackers('').catch(() => false);
    await enabled;
    // Choosers the page opens come here instead of opening a native picker.
    void debug
      .sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      .catch(() => undefined);
    // So do the page's prints, through the wrapper's binding (09b).
    void debug
      .sendCommand('Runtime.addBinding', { name: PRINT_BINDING })
      .then(() =>
        debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: printBridgeScript(),
        }),
      )
      .catch(() => undefined);
    await Promise.all([
      debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: appOwnedPromptBridgeScript(state.appPromptBridgeSourceUrl),
      }),
      trackers,
    ]);
  }

  private async ensureAppOwnedPromptBridge(
    state: LiveBrowserSession,
  ): Promise<void> {
    const sourceUrl = `canopy://browser-app-prompt/${uuid()}.js`;
    state.pendingAppPromptBridgeSourceUrls.add(sourceUrl);
    try {
      const evaluation = await this.sendDebuggerCommandResultWithBoundedWait(
        state,
        'Runtime.evaluate',
        {
          expression: appOwnedPromptBridgeScript(sourceUrl),
          returnByValue: true,
        },
      );
      if (isRecord(evaluation) && isRecord(evaluation.exceptionDetails)) {
        throw new Error(
          optionalString(
            evaluation.exceptionDetails.text,
            'Browser prompt bridge evaluation failed.',
          ),
        );
      }
    } catch (error) {
      this.captureConsole(state, {
        level: 'warning',
        text: `Failed to install the app-owned browser prompt bridge: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } finally {
      state.pendingAppPromptBridgeSourceUrls.delete(sourceUrl);
    }
    // The first document may start before the print wrapper is registered.
    await this.sendDebuggerCommandResultWithBoundedWait(
      state,
      'Runtime.evaluate',
      { expression: printBridgeScript() },
    ).catch(() => undefined);
  }

  /**
   * A child session's prints: the binding first, then the wrapper for later
   * documents and for the document the session attached to.
   */
  private async installPrintBridge(
    state: LiveBrowserSession,
    sessionId: string,
  ): Promise<void> {
    await this.sendDebuggerCommandResultWithBoundedWait(
      state,
      'Runtime.addBinding',
      { name: PRINT_BINDING },
      sessionId,
    ).catch(() => undefined);
    await Promise.all([
      this.sendDebuggerCommandResultWithBoundedWait(
        state,
        'Page.addScriptToEvaluateOnNewDocument',
        { source: printBridgeScript() },
        sessionId,
      ).catch(() => undefined),
      this.sendDebuggerCommandResultWithBoundedWait(
        state,
        'Runtime.evaluate',
        { expression: printBridgeScript() },
        sessionId,
      ).catch(() => undefined),
    ]);
  }

  private async enableFrameObservations(
    state: LiveBrowserSession,
    sessionId?: string,
  ): Promise<void> {
    // A child session's first DOM.enable decides whether DOM.getDocument
    // reports whitespace-only text. It is sent synchronously here, from the
    // attach event that registered the session with the page model, so no
    // page model request can reach the session before it.
    const domEnabled = sessionId
      ? this.sendDebuggerCommandResultWithBoundedWait(
          state,
          'DOM.enable',
          { includeWhitespace: 'all' },
          sessionId,
        ).catch(() => undefined)
      : undefined;
    await this.sendDebuggerCommandResultWithBoundedWait(
      state,
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
      },
      sessionId,
    );
    if (sessionId) {
      await this.sendDebuggerCommandResultWithBoundedWait(
        state,
        'Runtime.enable',
        undefined,
        sessionId,
      );
      await domEnabled;
      await this.sendDebuggerCommandResultWithBoundedWait(
        state,
        'Page.enable',
        undefined,
        sessionId,
      );
      await this.sendDebuggerCommandResultWithBoundedWait(
        state,
        'Page.setInterceptFileChooserDialog',
        { enabled: true },
        sessionId,
      ).catch(() => undefined);
      await this.installPrintBridge(state, sessionId);
      // Later documents of this session are tracked from their start; the
      // current one may have started first and stays unknown (D4).
      await state.pageModel.installTrackers(sessionId).catch(() => false);
      await state.pageModel.discoverFrames(sessionId);
      await this.observeCommittedFrameTree(state, sessionId);
    }
  }

  private notifyActionSettle(state: LiveBrowserSession): void {
    state.actionSettleListeners?.forEach((listener) => listener());
  }

  private handleDebuggerMessage(
    state: LiveBrowserSession,
    method: string,
    params: unknown,
    sessionId?: string,
  ): void {
    if (!this.isCurrentLiveSession(state)) return;
    try {
      this.processDebuggerMessage(state, method, params, sessionId);
    } finally {
      this.notifyActionSettle(state);
    }
  }

  private processDebuggerMessage(
    state: LiveBrowserSession,
    method: string,
    params: unknown,
    sessionId?: string,
  ): void {
    // Registry, contexts and cache revisions must observe ALL sessions before
    // child events return below (every Runtime.executionContext* event of
    // every session too); actionMutationCount counts DOM events of every
    // session, which flow while tracking is on (D11).
    state.pageModel.noteEvent(method, params, sessionId ?? '');
    if (method.startsWith('DOM.')) {
      state.actionMutationCount = (state.actionMutationCount ?? 0) + 1;
      state.actionMutationAt = Date.now();
    }
    if (!this.isCurrentLiveSession(state)) return;
    if (!isRecord(params)) return;
    if (method === 'Target.attachedToTarget') {
      const info = isRecord(params.targetInfo) ? params.targetInfo : {};
      if (info.type !== 'iframe' || typeof params.sessionId !== 'string')
        return;
      const childId = params.sessionId;
      if (state.observationSessions.size >= 1000) {
        // The capped session is not usable even before CDP confirms detachment.
        state.pageModel.detachSession(childId);
        const binding = state.snapshot.profile;
        if (binding)
          this.dataRuntime?.observations.record(
            binding.resolvedProfileId,
            binding.storageGeneration,
            null,
            null,
            null,
          );
        void this.sendDebuggerCommandResultWithBoundedWait(
          state,
          'Target.detachFromTarget',
          { sessionId: childId },
        ).catch(() => undefined);
        return;
      }
      state.observationSessions.add(childId);
      void this.enableFrameObservations(state, childId).catch(() => undefined);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      if (typeof params.sessionId === 'string') {
        state.observationSessions.delete(params.sessionId);
        if (state.pendingFileChooser?.sessionId === params.sessionId)
          this.endFileChooser(state);
        if (state.pendingPrintRequest?.sessionId === params.sessionId)
          this.endPrintRequest(state);
        for (const call of Array.from(state.printCalls ?? []))
          if (call.sessionId === params.sessionId) call.stale = true;
      }
      return;
    }
    if (method === 'Runtime.bindingCalled') {
      if (
        params.name === PRINT_BINDING &&
        (!sessionId || state.observationSessions.has(sessionId))
      )
        this.handlePrintCalled(state, params, sessionId ?? '');
      return;
    }
    if (method === 'Page.fileChooserOpened') {
      if (!sessionId || state.observationSessions.has(sessionId))
        this.handleFileChooserOpened(state, params, sessionId ?? '');
      return;
    }
    if (method === 'Page.frameNavigated' || method === 'Page.frameDetached') {
      this.expireFileChooserFor(state, method, params);
      this.expirePrintRequestFor(state, method, params);
      // A sign-in belongs to the load that hit it; a new page ends it.
      const frame = isRecord(params.frame) ? params.frame : undefined;
      if (
        method === 'Page.frameNavigated' &&
        !sessionId &&
        frame?.parentId === undefined
      )
        this.endAuthRequest(state);
    }
    // Child Page events use their own CDP namespace; they must never replace
    // the top-level URL, prompt state, execution contexts, or network entries.
    if (sessionId) {
      if (!state.observationSessions.has(sessionId)) return;
      const binding = state.snapshot.profile;
      if (
        method === 'Page.frameNavigated' &&
        binding &&
        isRecord(params.frame) &&
        typeof params.frame.url === 'string' &&
        /^https?:/.test(params.frame.url) &&
        !this.maintenanceFences.has(binding.resolvedProfileId)
      )
        this.dataRuntime?.observations.record(
          binding.resolvedProfileId,
          binding.storageGeneration,
          params.frame.url,
          state.view.webContents.getURL(),
          params.frame.domainAndRegistry,
        );
      if (method === 'Page.loadEventFired')
        void this.observeCommittedFrameTree(state, sessionId);
      return;
    }
    if (method === 'Runtime.executionContextCreated') {
      const context = isRecord(params.context) ? params.context : {};
      const auxData = isRecord(context.auxData) ? context.auxData : {};
      const executionContextId = context.id;
      const frameId = optionalString(auxData.frameId);
      if (
        typeof executionContextId === 'number' &&
        Number.isInteger(executionContextId) &&
        frameId
      ) {
        state.executionContextFrames.set(executionContextId, {
          frameId,
          origin: optionalString(context.origin),
          type: optionalString(auxData.type),
          name: optionalString(context.name),
        });
      }
      return;
    }
    if (method === 'Debugger.scriptParsed') {
      const executionContextId = params.executionContextId;
      const scriptId = optionalString(params.scriptId);
      const sourceUrl = optionalString(params.url);
      if (
        typeof executionContextId === 'number' &&
        Number.isInteger(executionContextId) &&
        scriptId
      ) {
        const existing =
          state.appPromptBridgeScriptIds.get(executionContextId) ?? new Set();
        const isInitialBridge =
          sourceUrl === state.appPromptBridgeSourceUrl && existing.size === 0;
        const isServiceReinstall =
          state.pendingAppPromptBridgeSourceUrls.has(sourceUrl);
        if (isInitialBridge || isServiceReinstall) {
          existing.add(scriptId);
          state.appPromptBridgeScriptIds.set(executionContextId, existing);
        }
      }
      return;
    }
    if (method === 'Runtime.executionContextDestroyed') {
      const executionContextId = params.executionContextId;
      if (typeof executionContextId === 'number') {
        state.appPromptBridgeScriptIds.delete(executionContextId);
        state.executionContextFrames.delete(executionContextId);
      }
      return;
    }
    if (
      method === 'Runtime.executionContextsCleared' ||
      method === 'Debugger.globalObjectCleared'
    ) {
      state.appPromptBridgeScriptIds.clear();
      state.executionContextFrames.clear();
      return;
    }
    if (method === 'Debugger.paused') {
      void this.handleDebuggerPaused(state, params);
      return;
    }
    if (method === 'Debugger.resumed') {
      const promptPause = state.appPromptPause;
      state.appPromptPause = undefined;
      if (promptPause && state.pendingDialog?.id === promptPause.dialogId) {
        state.pendingDialog = undefined;
        this.emitForSession(state, {
          type: 'dialog-closed',
          browserId: state.snapshot.id,
          dialogId: promptPause.dialogId,
        });
      }
      return;
    }
    if (method === 'Page.javascriptDialogOpening') {
      this.handleJavaScriptDialogOpening(state, params);
      return;
    }
    if (method === 'Page.javascriptDialogClosed') {
      // The native veto closes Chromium's temporary beforeunload dialog. The
      // app's choice remains open until the user/agent explicitly answers it.
      if (
        state.appBeforeUnloadDialog?.dialogId === state.pendingDialog?.id &&
        state.appBeforeUnloadDialog
      )
        return;
      const dialogId = state.pendingDialog?.id;
      state.pendingDialog = undefined;
      state.appDialog = undefined;
      if (dialogId) {
        this.closeCorrelatedDialog(state, dialogId);
        this.emitForSession(state, {
          type: 'dialog-closed',
          browserId: state.snapshot.id,
          dialogId,
        });
      }
      if (dialogId && state.pendingDialogClose?.dialogId === dialogId) {
        const close = state.pendingDialogClose;
        state.pendingDialogClose = undefined;
        clearTimeout(close.timeout);
        close.resolve();
      }
      return;
    }
    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params.args) ? params.args : [];
      this.captureConsole(state, {
        level: consoleLevel(optionalString(params.type, 'log')),
        text: args
          .map((arg) =>
            isRecord(arg) && typeof arg.value !== 'undefined'
              ? optionalString(arg.value, JSON.stringify(arg.value) ?? '')
              : isRecord(arg) && typeof arg.description === 'string'
                ? arg.description
                : '',
          )
          .filter(Boolean)
          .join(' '),
      });
      return;
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = isRecord(params.exceptionDetails)
        ? params.exceptionDetails
        : {};
      const text = optionalString(details.text, 'Uncaught exception');
      // Chromium puts only "Uncaught" in text; the message is in the exception.
      const description = isRecord(details.exception)
        ? optionalString(details.exception.description)
        : '';
      this.captureConsole(state, {
        level: 'error',
        text: description ? `${text} ${description}` : text,
      });
      return;
    }
    if (method === 'Page.frameNavigated') {
      const frame = isRecord(params.frame) ? params.frame : {};
      const frameId = optionalString(frame.id);
      const parentId = optionalString(frame.parentId);
      const url = optionalString(frame.url);
      if (frameId && url) {
        state.frameUrls.set(frameId, url);
      }
      const binding = state.snapshot.profile;
      if (
        binding &&
        url &&
        (parentId || /^https?:/.test(url)) &&
        this.dataRuntime &&
        !this.maintenanceFences.has(binding.resolvedProfileId)
      ) {
        this.dataRuntime.observations.record(
          binding.resolvedProfileId,
          binding.storageGeneration,
          url,
          parentId ? state.frameUrls.get(state.mainFrameId ?? '') : url,
          frame.domainAndRegistry,
        );
      }
      if (frameId && !parentId) {
        state.actionDocumentRevision = (state.actionDocumentRevision ?? 0) + 1;
        cancelDocumentCommands(
          state,
          new Error('Browser main-frame document was replaced.'),
        );
        state.mainFrameId = frameId;
        if (url) {
          this.handleCommittedNavigation(state, url);
        }
      }
      return;
    }
    if (method === 'Page.navigatedWithinDocument') {
      const frameId = optionalString(params.frameId);
      const url = optionalString(params.url);
      if (frameId && url) {
        state.frameUrls.set(frameId, url);
      }
      if (url && (!state.mainFrameId || frameId === state.mainFrameId)) {
        this.handleCommittedNavigation(state, url);
      }
      return;
    }
    if (method === 'Page.frameDetached') {
      const frameId = optionalString(params.frameId);
      if (frameId) {
        state.frameUrls.delete(frameId);
      }
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const requestId = optionalString(params.requestId);
      const request = isRecord(params.request) ? params.request : {};
      const redirect = isRecord(params.redirectResponse)
        ? params.redirectResponse
        : undefined;
      if (requestId && redirect) {
        const durationMs = this.consumeNetworkDuration(state, requestId);
        const statusText = optionalString(redirect.statusText) || undefined;
        const mimeType = optionalString(redirect.mimeType) || undefined;
        this.upsertNetwork(state, {
          id: requestId,
          browserId: state.snapshot.id,
          requestId,
          timestamp: now(),
          method: '',
          url: optionalString(redirect.url),
          ...(typeof redirect.status === 'number'
            ? { status: redirect.status }
            : {}),
          ...(statusText ? { statusText } : {}),
          ...(mimeType ? { mimeType } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        });
      }
      const entry: BrowserNetworkEntry = {
        id: requestId || uuid(),
        browserId: state.snapshot.id,
        requestId,
        timestamp: now(),
        method: optionalString(request.method, 'GET'),
        url: optionalString(request.url),
        resourceType: typeof params.type === 'string' ? params.type : undefined,
      };
      this.rememberNetworkStart(state, requestId, entry.timestamp);
      if (requestId) state.inflightRequestIds.add(requestId);
      state.lastNetworkActivityAt = Date.now();
      this.upsertNetwork(state, entry);
      return;
    }
    if (method === 'Network.responseReceived') {
      const requestId = optionalString(params.requestId);
      const response = isRecord(params.response) ? params.response : {};
      state.lastNetworkActivityAt = Date.now();
      this.upsertNetwork(state, {
        id: requestId || uuid(),
        browserId: state.snapshot.id,
        requestId,
        timestamp: now(),
        method: '',
        url: optionalString(response.url),
        status:
          typeof response.status === 'number' ? response.status : undefined,
        statusText:
          typeof response.statusText === 'string'
            ? response.statusText
            : undefined,
        mimeType:
          typeof response.mimeType === 'string' ? response.mimeType : undefined,
        fromCache:
          response.fromDiskCache === true ||
          response.fromPrefetchCache === true,
        durationMs: this.consumeNetworkDuration(state, requestId),
      });
      return;
    }
    if (method === 'Network.loadingFailed') {
      const requestId = optionalString(params.requestId);
      if (requestId) state.inflightRequestIds.delete(requestId);
      state.lastNetworkActivityAt = Date.now();
      const errorText =
        typeof params.errorText === 'string' ? params.errorText : 'failed';
      const saved =
        errorText === ABORTED_REQUEST_ERROR &&
        this.consumeSavedRequest(
          state,
          state.network.find((entry) => entry.requestId === requestId)?.url,
        );
      this.upsertNetwork(state, {
        id: requestId || uuid(),
        browserId: state.snapshot.id,
        requestId,
        timestamp: now(),
        method: '',
        url: '',
        // Chromium aborts the request of a response it saves as a download.
        ...(saved ? { failed: false } : { failed: true, errorText }),
        durationMs: this.consumeNetworkDuration(state, requestId),
      });
      return;
    }
    if (method === 'Network.loadingFinished') {
      const requestId = optionalString(params.requestId);
      if (requestId) state.inflightRequestIds.delete(requestId);
      state.lastNetworkActivityAt = Date.now();
    }
  }

  private async handleDebuggerPaused(
    state: LiveBrowserSession,
    params: Record<string, unknown>,
  ): Promise<void> {
    const callFrames = Array.isArray(params.callFrames)
      ? params.callFrames
      : [];
    const topFrame = isRecord(callFrames[0]) ? callFrames[0] : null;
    const callFrameId = optionalString(topFrame?.callFrameId);
    const location = isRecord(topFrame?.location) ? topFrame.location : null;
    const scriptId = optionalString(location?.scriptId);
    const trustedExecutionContext = Array.from(
      state.appPromptBridgeScriptIds.entries(),
    ).find(([, trustedScriptIds]) => trustedScriptIds.has(scriptId))?.[0];
    const frameContext =
      trustedExecutionContext !== undefined
        ? state.executionContextFrames.get(trustedExecutionContext)
        : undefined;
    const dialogUrl = trustedBrowserFrameUrl(
      frameContext ? state.frameUrls.get(frameContext.frameId) : undefined,
      frameContext?.origin,
    );
    const isTrustedPromptFrame =
      optionalString(topFrame?.functionName) === 'canopyAppOwnedPrompt' &&
      trustedExecutionContext !== undefined;
    if (!callFrameId || !isTrustedPromptFrame || !dialogUrl) {
      await this.resumeUnownedDebuggerPause(state);
      return;
    }

    try {
      const evaluation = await this.sendDebuggerCommandResultWithBoundedWait(
        state,
        'Debugger.evaluateOnCallFrame',
        {
          callFrameId,
          expression: `(() => {
              if (!bridge || bridge.marker !== ${JSON.stringify(APP_PROMPT_BRIDGE_MARKER)}) return null;
              return {
                marker: bridge.marker,
                message: String(bridge.message ?? ''),
                defaultPrompt: String(bridge.defaultPrompt ?? ''),
              };
            })()`,
          returnByValue: true,
        },
      );
      const remoteResult =
        isRecord(evaluation) && isRecord(evaluation.result)
          ? evaluation.result
          : {};
      const bridge = isRecord(remoteResult.value) ? remoteResult.value : null;
      if (!bridge || bridge.marker !== APP_PROMPT_BRIDGE_MARKER) {
        await this.resumeUnownedDebuggerPause(state);
        return;
      }
      if (state.pendingDialog) {
        this.captureConsole(state, {
          level: 'warning',
          text: 'Cancelled a browser prompt while another JavaScript dialog was pending.',
        });
        await this.resumeUnownedDebuggerPause(state);
        return;
      }

      const defaultPrompt = optionalString(bridge.defaultPrompt).slice(
        0,
        JAVASCRIPT_DIALOG_PROMPT_LIMIT,
      );
      const dialog: BrowserJavaScriptDialog = {
        id: uuid(),
        browserId: state.snapshot.id,
        type: 'prompt',
        message: optionalString(bridge.message).slice(
          0,
          JAVASCRIPT_DIALOG_MESSAGE_LIMIT,
        ),
        ...(defaultPrompt ? { defaultPrompt } : {}),
        url: dialogUrl,
        ...(frameContext?.frameId ? { frameId: frameContext.frameId } : {}),
        openedAt: now(),
      };
      state.pendingDialog = dialog;
      state.appPromptPause = {
        dialogId: dialog.id,
        callFrameId,
        handling: false,
      };
      this.publishPendingDialog(state, dialog);
    } catch (error) {
      this.captureConsole(state, {
        level: 'warning',
        text: `Failed to open the app-owned browser prompt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      await this.resumeUnownedDebuggerPause(state);
    }
  }

  private async resumeUnownedDebuggerPause(
    state: LiveBrowserSession,
  ): Promise<void> {
    try {
      await this.sendDebuggerCommandResultWithBoundedWait(
        state,
        'Debugger.resume',
      );
    } catch (error) {
      this.captureConsole(state, {
        level: 'warning',
        text: `Failed to resume an embedded browser debugger pause: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  private handleJavaScriptDialogOpening(
    state: LiveBrowserSession,
    params: Record<string, unknown>,
  ): void {
    const type = browserJavaScriptDialogType(params.type);
    if (
      type === 'beforeunload' &&
      (state.allowNextBeforeUnload || state.profileSwitchClosingAccepted)
    )
      return;
    if (!type) {
      return;
    }
    const defaultPrompt = optionalString(params.defaultPrompt).slice(
      0,
      JAVASCRIPT_DIALOG_PROMPT_LIMIT,
    );
    const frameId = optionalString(params.frameId);
    const existing = state.pendingDialog;
    const message = optionalString(params.message).slice(
      0,
      JAVASCRIPT_DIALOG_MESSAGE_LIMIT,
    );
    const recent = !existing
      ? this.recentDialogOtherSource(
          state,
          'cdp',
          type,
          message,
          optionalString(params.url, state.snapshot.url),
          frameId,
        )
      : undefined;
    if (recent) {
      recent.cdpSeen = true;
      this.notifyActionSettle(state);
      return;
    }
    if (existing && (existing.type !== type || existing.message !== message)) {
      this.captureConsole(state, {
        level: 'warning',
        text: 'Ignored a second JavaScript dialog while another dialog was pending.',
      });
      return;
    }
    const dialog: BrowserJavaScriptDialog = existing
      ? {
          ...existing,
          ...(defaultPrompt && !existing.defaultPrompt
            ? { defaultPrompt }
            : {}),
          url: optionalString(params.url, existing.url),
          ...(frameId ? { frameId } : {}),
        }
      : {
          id: uuid(),
          browserId: state.snapshot.id,
          type,
          message,
          ...(defaultPrompt ? { defaultPrompt } : {}),
          url: optionalString(params.url, state.snapshot.url),
          ...(frameId ? { frameId } : {}),
          openedAt: now(),
        };
    state.pendingDialog = dialog;

    this.correlateDialogSource(state, dialog, 'cdp');

    // Electron's private event can arrive before CDP. Re-publish here so the
    // renderer receives CDP-only metadata such as prompt default text and the
    // exact frame URL even when it already rendered the initial dialog.
    this.publishPendingDialog(state, dialog);
  }

  private rejectPendingCommandsForDialog(
    state: LiveBrowserSession,
    dialog: BrowserJavaScriptDialog,
  ): void {
    for (const [id, pending] of Array.from(state.pendingCommands.entries())) {
      clearTimeout(pending.timeout);
      pending.reject(new BrowserDialogPendingError(dialog));
      state.pendingCommands.delete(id);
    }
  }

  private createDialogCloseWaiter(
    state: LiveBrowserSession,
    dialogId: string,
  ): NonNullable<LiveBrowserSession['pendingDialogClose']> {
    let resolve: () => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = (): void => resolvePromise();
      reject = (error: Error): void => rejectPromise(error);
    });
    // The close event can fail while the debugger command is still in flight.
    // Attach a rejection observer now; handleDialog still awaits the original
    // promise and propagates the same error to its caller.
    void promise.catch(() => undefined);
    const close: NonNullable<LiveBrowserSession['pendingDialogClose']> = {
      dialogId,
      promise,
      resolve,
      reject,
      timeout: setTimeout(() => {
        if (state.pendingDialogClose !== close) return;
        state.pendingDialogClose = undefined;
        reject(
          new Error(
            `Timed out waiting for browser JavaScript dialog ${dialogId} to close.`,
          ),
        );
      }, JAVASCRIPT_DIALOG_CLOSE_TIMEOUT_MS),
    };
    state.pendingDialogClose = close;
    return close;
  }

  private cancelDialogCloseWaiter(
    state: LiveBrowserSession,
    close: NonNullable<LiveBrowserSession['pendingDialogClose']>,
  ): void {
    if (state.pendingDialogClose === close) {
      state.pendingDialogClose = undefined;
    }
    clearTimeout(close.timeout);
    close.resolve();
  }

  private handleCommittedNavigation(
    state: LiveBrowserSession,
    url: string,
  ): void {
    if (url === 'about:blank' && state.snapshot.url.length === 0) {
      this.refreshNavigationState(state, {
        url: '',
        status: 'idle',
        loading: false,
      });
      return;
    }
    this.refreshNavigationState(state, {
      url,
      status: 'ready',
      loading: false,
      faviconUrl: undefined,
    });
    if (state.snapshot.recording) {
      this.addRecordingStep(state, recordingGotoStep(url));
    }
  }

  private viewerLocationForUrl(
    state: LiveBrowserSession,
    url: string,
  ): { repoId: string; relativePath: string } | undefined {
    if (
      state.snapshot.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID ||
      !isFileBrowserUrl(url)
    ) {
      return undefined;
    }
    let target: string;
    try {
      target = resolve(fileURLToPath(url));
    } catch {
      return undefined;
    }
    for (const root of state.viewerReadRoots ?? []) {
      const relativePath = relative(resolve(root.absolutePath), target);
      if (
        relativePath !== '..' &&
        !relativePath.startsWith(`..${sep}`) &&
        !isAbsolute(relativePath)
      ) {
        return {
          repoId: root.repoId,
          relativePath: relativePath.split(sep).join('/'),
        };
      }
    }
    return undefined;
  }

  private async assertViewerNavigationAllowed(
    state: LiveBrowserSession,
    url: string,
  ): Promise<void> {
    if (state.snapshot.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID) {
      return;
    }
    if (!isFileBrowserUrl(url)) {
      state.viewerFileLocation = undefined;
      return;
    }
    const resolved = await assertSharedContainerViewerFileForRead(
      state.snapshot.worktreeId,
      fileURLToPath(url),
    );
    state.viewerReadRoots = await resolveSharedContainerViewerReadRoots(
      state.snapshot.worktreeId,
    );
    state.viewerFileLocation = {
      repoId: resolved.root.repoId,
      relativePath: resolved.relativePath,
    };
    state.approvedViewerFileUrl = url;
  }

  private guardInAppNavigation(
    state: LiveBrowserSession,
    event: { preventDefault: () => void },
    url: string,
  ): void {
    const targetIsFile = isFileBrowserUrl(url);
    if (
      targetIsFile &&
      state.snapshot.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID
    ) {
      if (state.approvedViewerFileUrl === url) {
        state.approvedViewerFileUrl = undefined;
        return;
      }
      event.preventDefault();
      if (state.navigationChainAllowsFileTargets) {
        void this.navigate({ browserId: state.snapshot.id, url }).catch(
          (error) => {
            this.captureConsole(state, {
              level: 'warning',
              text: error instanceof Error ? error.message : String(error),
            });
          },
        );
      }
      return;
    }
    const viewerFileAllowed =
      state.snapshot.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID ||
      !targetIsFile ||
      this.viewerLocationForUrl(state, url) !== undefined;
    if (
      this.isUrlAllowedInApp(url) &&
      (!targetIsFile || state.navigationChainAllowsFileTargets) &&
      viewerFileAllowed
    ) {
      if (!targetIsFile) {
        state.navigationChainAllowsFileTargets = false;
      }
      return;
    }
    event.preventDefault();
    if (targetIsFile) {
      state.pendingBeforeUnloadAction = undefined;
      this.captureConsole(state, {
        level: 'warning',
        text: 'A web page cannot navigate directly to a local file.',
      });
      return;
    }
    void this.openExternal(url).catch((error) => {
      this.captureConsole(state, {
        level: 'warning',
        text: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private restoreRecordingIfNeeded(state: LiveBrowserSession): void {
    if (!state.snapshot.recording) {
      return;
    }
    void this.sendPreloadCommand(state, 'setRecording', {
      browserId: state.snapshot.id,
      enabled: true,
    }).catch((error) => {
      this.captureConsole(state, {
        level: 'warning',
        text: `Failed to restore browser recording: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    });
  }

  private refreshNavigationState(
    state: LiveBrowserSession,
    patch: Partial<BrowserSessionSnapshot> = {},
  ): BrowserSessionSnapshot {
    if (!this.isCurrentLiveSession(state)) return state.snapshot;
    const contents = state.view.webContents;
    updateSnapshot(state, {
      url: snapshotUrlFromWebContents(contents.getURL(), state.snapshot.url),
      title: contents.getTitle(),
      canGoBack: canGoBack(contents),
      canGoForward: canGoForward(contents),
      loading: contents.isLoading(),
      ...patch,
    });
    this.emitSnapshot(state);
    return state.snapshot;
  }

  /** Remembers what the tab showed as a load starts. A load already under way keeps its origin. */
  private beginLoad(state: LiveBrowserSession): void {
    const { url, status, lastError } = state.snapshot;
    const superseded = state.load;
    state.load = {
      origin:
        status === 'loading' && superseded
          ? superseded.origin
          : { url, status, lastError },
      savedAsDownload: false,
      announced: [],
    };
    for (const settle of superseded?.announced ?? []) settle(false);
  }

  /**
   * Whether a download took the response of the load that was just aborted.
   * Chromium announces the download after it aborts the navigation.
   */
  private downloadAnnounced(state: LiveBrowserSession): Promise<boolean> {
    const load = state.load;
    if (!load || load.savedAsDownload)
      return Promise.resolve(load?.savedAsDownload === true);
    return new Promise<boolean>((resolve): void => {
      const timer = setTimeout((): void => {
        load.announced = load.announced.filter(
          (waiting): boolean => waiting !== settle,
        );
        resolve(false);
      }, DOWNLOAD_ANNOUNCEMENT_WAIT_MS);
      timer.unref?.();
      const settle = (saved: boolean): void => {
        clearTimeout(timer);
        resolve(saved);
      };
      load.announced.push(settle);
    });
  }

  /** The response was saved, not shown: the tab still shows what it did before that load. */
  private restoreLoadOrigin(state: LiveBrowserSession): void {
    const origin = state.load?.origin;
    if (!origin) return;
    const shown = state.view.webContents.getURL();
    state.navigationChainAllowsFileTargets = isFileBrowserUrl(shown);
    this.refreshNavigationState(state, {
      url: snapshotUrlFromWebContents(shown, origin.url),
      status:
        origin.status === 'loading'
          ? shown
            ? 'ready'
            : 'idle'
          : origin.status,
      loading: false,
      lastError: origin.lastError,
    });
  }

  /**
   * A navigation that turns into a download is not a failed load, and the
   * request Chromium aborts for it is not a failed request.
   */
  private noteDownloadStarted(browserId: string, url: string): void {
    const state = this.sessions.get(browserId);
    if (!state) return;
    const load = state.load;
    if (load && state.snapshot.status === 'loading') {
      load.savedAsDownload = true;
      // Chromium aborts the navigation before it announces the download, so
      // this load has usually stopped already.
      if (!state.view.webContents.isLoading()) this.restoreLoadOrigin(state);
      for (const settle of load.announced.splice(0)) settle(true);
    }
    let reported: BrowserNetworkEntry | undefined;
    for (const entry of state.network) if (entry.url === url) reported = entry;
    if (reported?.failed && reported.errorText === ABORTED_REQUEST_ERROR) {
      this.upsertNetwork(state, {
        ...reported,
        failed: false,
        errorText: undefined,
      });
      return;
    }
    const saved = (state.savedRequests ??= new Map<string, number>());
    saved.delete(url);
    saved.set(url, Date.now());
    const oldest = saved.keys().next();
    if (saved.size > SAVED_REQUEST_LIMIT && !oldest.done)
      saved.delete(oldest.value);
  }

  private consumeSavedRequest(
    state: LiveBrowserSession,
    url: string | undefined,
  ): boolean {
    const savedAt =
      url === undefined ? undefined : state.savedRequests?.get(url);
    if (url === undefined || savedAt === undefined) return false;
    state.savedRequests?.delete(url);
    return Date.now() - savedAt <= SAVED_REQUEST_WINDOW_MS;
  }

  /** A new tab's first load; a refused or failed load marks the tab failed. */
  private async loadInitialUrl(
    state: LiveBrowserSession,
    url: string,
  ): Promise<BrowserSessionSnapshot> {
    try {
      return await this.navigate({ browserId: state.snapshot.id, url });
    } catch (error) {
      this.assertCurrentLiveSession(state);
      updateSnapshot(state, {
        url,
        status: 'failed',
        loading: false,
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.emitForSession(state, {
        type: 'load-failed',
        browserId: state.snapshot.id,
        snapshot: state.snapshot,
      });
      return state.snapshot;
    }
  }

  /**
   * Holds a never-shown agent tab's first load until its pane shows the view
   * at a real size, or for `INITIAL_LOAD_PANE_WAIT_MS` when no pane does.
   * Sizing a hidden view does not reach its page, and a page that measures
   * the window while loading keeps the 0×0 it saw.
   */
  private deferInitialLoad(state: LiveBrowserSession, url: string): void {
    // The blank tab is the load's origin: a first load that becomes a
    // download, or a stopped hold, returns the tab to it.
    const origin = {
      url: state.snapshot.url,
      status: state.snapshot.status,
      lastError: state.snapshot.lastError,
    };
    // `loading: false` lets the pane show the view so it can size it; status
    // `loading` keeps the pane's idle backstop from requesting the page again.
    updateSnapshot(state, {
      url,
      status: 'loading',
      loading: false,
      lastError: undefined,
    });
    this.emitSnapshot(state);
    let settle!: (load: boolean) => void;
    const started = new Promise<BrowserSessionSnapshot>((resolve) => {
      settle = (load: boolean): void => {
        if (state.deferredInitialLoad !== deferred) return;
        clearTimeout(deferred.timer);
        state.deferredInitialLoad = undefined;
        if (!this.isCurrentLiveSession(state)) {
          resolve(state.snapshot);
          return;
        }
        // Restored before any load starts, so `beginLoad` records it as the
        // origin; the caller emits the state that follows.
        updateSnapshot(state, { ...origin, loading: false });
        if (!load) {
          resolve(state.snapshot);
          return;
        }
        // navigate marks the tab loading before its first await, so the
        // marker only covers requests made while this load is in flight.
        const loaded = this.loadInitialUrl(state, url).catch(
          () => state.snapshot,
        );
        state.heldLoadUrl = url;
        resolve(loaded);
      };
    });
    const deferred = {
      url,
      started,
      settle: (load: boolean): void => settle(load),
      timer: setTimeout(() => settle(true), INITIAL_LOAD_PANE_WAIT_MS),
    };
    state.deferredInitialLoad = deferred;
  }

  /** Whether another of the task's tabs is on screen. */
  private hasShownBrowser(
    projectId: string,
    worktreeId: string,
    exceptBrowserId: string,
  ): boolean {
    return Array.from(this.sessions.values()).some(
      (session) =>
        session.visible &&
        session.snapshot.id !== exceptBrowserId &&
        session.snapshot.projectId === projectId &&
        session.snapshot.worktreeId === worktreeId,
    );
  }

  /** Whether a held first load of `url` is waiting for its pane or loading. */
  private holdsInitialLoad(state: LiveBrowserSession, url: string): boolean {
    if (state.deferredInitialLoad)
      return sameBrowserUrl(state.deferredInitialLoad.url, url);
    return (
      state.heldLoadUrl !== undefined &&
      state.snapshot.loading &&
      sameBrowserUrl(state.heldLoadUrl, url)
    );
  }

  /** Resolves once a held first load has started, or at once without one. */
  waitForInitialLoad(browserId: string): Promise<BrowserSessionSnapshot> {
    const state = this.requireSession(browserId);
    return (
      state.deferredInitialLoad?.started ?? Promise.resolve(state.snapshot)
    );
  }

  private async loadUrlWithBoundedWait(
    state: LiveBrowserSession,
    url: string,
  ): Promise<BrowserSessionSnapshot> {
    const navigationSequence = (state.navigationSequence += 1);
    state.navigationChainAllowsFileTargets = isFileBrowserUrl(url);
    this.beginLoad(state);
    updateSnapshot(state, {
      url,
      status: normalizeStatusForLoadStart(),
      loading: true,
      lastError: undefined,
    });
    this.emitSnapshot(state);

    let loadPromise: Promise<void>;
    try {
      loadPromise = state.view.webContents.loadURL(url);
    } catch (error) {
      this.markNavigationLoadFailed(state, navigationSequence, url, error);
      return state.snapshot;
    }

    const guardedLoad = loadPromise.then(
      async () => {
        await this.ensureAppOwnedPromptBridge(state);
        if (this.isCurrentNavigation(state, navigationSequence, url)) {
          this.refreshNavigationState(state, {
            url,
            status: 'ready',
            loading: false,
            lastError: undefined,
          });
        }
      },
      async (error) => {
        // loadURL rejects when its response was saved as a download. That
        // load did not fail.
        const code = thrownBrowserLoadErrorCode(error);
        if (
          (code === ERR_FAILED_CODE || code === ERR_ABORTED_CODE) &&
          (await this.downloadAnnounced(state))
        ) {
          if (this.isCurrentNavigation(state, navigationSequence, url))
            this.restoreLoadOrigin(state);
          return;
        }
        this.markNavigationLoadFailed(state, navigationSequence, url, error);
      },
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        guardedLoad,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, NAVIGATION_ACTION_RETURN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    return state.snapshot;
  }

  private isCurrentNavigation(
    state: LiveBrowserSession,
    navigationSequence: number,
    url: string,
  ): boolean {
    return (
      this.isCurrentLiveSession(state) &&
      state.navigationSequence === navigationSequence &&
      state.snapshot.url === url
    );
  }

  private markNavigationLoadFailed(
    state: LiveBrowserSession,
    navigationSequence: number,
    url: string,
    error: unknown,
  ): void {
    if (!this.isCurrentNavigation(state, navigationSequence, url)) {
      return;
    }
    state.navigationChainAllowsFileTargets = isFileBrowserUrl(
      state.view.webContents.getURL(),
    );
    updateSnapshot(state, {
      url,
      status: 'failed',
      loading: false,
      lastError: describeThrownBrowserLoadFailure(error, url),
    });
    this.emitForSession(state, {
      type: 'load-failed',
      browserId: state.snapshot.id,
      snapshot: state.snapshot,
    });
  }

  private captureConsole(
    state: LiveBrowserSession,
    entry: BrowserConsoleCapture,
  ): void {
    if (!this.isCurrentLiveSession(state)) return;
    if (!entry.text) return;
    if (isInternalBrowserConsoleNoise(entry)) return;
    const captured: BrowserConsoleEntry = {
      id: uuid(),
      browserId: state.snapshot.id,
      timestamp: now(),
      ...entry,
    };
    pushRing(state.console, captured, CONSOLE_LIMIT);
    this.emitForSession(state, {
      type: 'console',
      browserId: state.snapshot.id,
      entry: captured,
    });
  }

  private upsertNetwork(
    state: LiveBrowserSession,
    entry: BrowserNetworkEntry,
  ): void {
    const existingIndex = state.network.findIndex(
      (candidate) => candidate.requestId === entry.requestId,
    );
    const existing = existingIndex >= 0 ? state.network[existingIndex] : null;
    const merged: BrowserNetworkEntry = {
      ...(existing ?? entry),
      ...entry,
      method: entry.method || existing?.method || 'GET',
      url: entry.url || existing?.url || '',
      timestamp: existing?.timestamp ?? entry.timestamp,
    };
    if (existingIndex >= 0) {
      state.network[existingIndex] = merged;
    } else {
      if (state.network.length >= NETWORK_LIMIT) {
        const removed = state.network.shift();
        if (removed?.requestId) {
          state.networkStartedAt.delete(removed.requestId);
        }
      }
      state.network.push(merged);
    }
    this.emitForSession(state, {
      type: 'network',
      browserId: state.snapshot.id,
      entry: merged,
    });
  }

  private rememberNetworkStart(
    state: LiveBrowserSession,
    requestId: string,
    timestamp: number,
  ): void {
    if (!requestId) return;
    state.networkStartedAt.set(requestId, timestamp);
    while (state.networkStartedAt.size > NETWORK_LIMIT) {
      const first = state.networkStartedAt.keys().next().value;
      if (typeof first !== 'string') return;
      state.networkStartedAt.delete(first);
    }
  }

  private consumeNetworkDuration(
    state: LiveBrowserSession,
    requestId: string,
  ): number | undefined {
    const startedAt = state.networkStartedAt.get(requestId);
    state.networkStartedAt.delete(requestId);
    return startedAt === undefined ? undefined : Math.max(0, now() - startedAt);
  }

  /**
   * Records a page step from a finished agent action. When the action's
   * target was secret and the page recorder did not treat the step's element
   * as secret, its locator or value can hold the secret: the step is left
   * out, and the first one left out is recorded as an omission.
   */
  private recordActionPageStep(
    state: LiveBrowserSession,
    action: AgentActionWindow,
    step: BrowserRecordingStep,
    secretElement: boolean,
  ): void {
    if (!action.secret || secretElement) {
      this.addRecordingStep(state, step);
      return;
    }
    if (action.omitted) return;
    action.omitted = true;
    this.addRecordingStep(state, {
      id: randomUUID(),
      action: step.action,
      valueRedacted: true,
      playwright: '// Secret interaction omitted from recording.',
      timestamp: step.timestamp,
    });
  }

  private addRecordingStep(
    state: LiveBrowserSession,
    step: BrowserRecordingStep,
  ): void {
    if (!this.isCurrentLiveSession(state)) return;
    // A page step can reach main after the download it started, held for
    // its agent action or reported late; it goes before that download.
    const steps = state.recordingSteps;
    let index = steps.length;
    // An upload or print is recorded after the files land or the page is
    // printed, under the time it began, so it goes before any step taken
    // since.
    const backdated = step.action === 'upload' || step.action === 'print';
    while (index > 0) {
      const previous = steps[index - 1];
      if (
        !previous ||
        !(backdated && previous.action !== 'download'
          ? previous.timestamp > step.timestamp
          : // A download that started in the same millisecond came after it too.
            previous.action === 'download' &&
            previous.timestamp >= step.timestamp)
      )
        break;
      index -= 1;
    }
    steps.splice(index, 0, step);
    steps.splice(0, Math.max(0, steps.length - RECORDING_LIMIT));
    this.emitForSession(state, {
      type: 'recording-step',
      browserId: state.snapshot.id,
      step,
    });
  }

  private assertAutomationAllowed(state: LiveBrowserSession): void {
    if (
      isMcpOAuthBrowserScope(
        state.snapshot.projectId,
        state.snapshot.worktreeId,
      )
    ) {
      throw new Error(
        'Sign-in pages are private. Complete sign-in yourself in the browser.',
      );
    }
  }

  /** Pick mode and recording, in the main frame's preload. */
  private async sendPreloadCommand(
    state: LiveBrowserSession,
    type: BrowserPreloadCommandType,
    payload: unknown,
  ): Promise<unknown> {
    this.assertAutomationAllowed(state);
    if (state.view.webContents.isDestroyed()) {
      throw new Error('Browser is destroyed.');
    }
    const requestId = uuid();
    const command: BrowserPreloadCommand = { requestId, type, payload };
    return await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);
        state.pendingCommands.delete(requestId);
        return true;
      };
      const finishResolve = (value: unknown): void => {
        if (cleanup()) resolve(value);
      };
      const finishReject = (error: Error): void => {
        if (cleanup()) reject(error);
      };
      const timeout = setTimeout(() => {
        finishReject(new Error(`Browser command timed out: ${type}`));
      }, 10_000);
      state.pendingCommands.set(requestId, {
        resolve: finishResolve,
        reject: (error) =>
          finishReject(
            error instanceof Error ? error : new Error(String(error)),
          ),
        timeout,
      });
      sendToWebContents(
        state.view.webContents,
        PRELOAD_COMMAND_CHANNEL,
        command,
      );
    });
  }

  /**
   * Invoke the action's retained target through CDP with a Chromium user
   * gesture, in the target's own session (the forced, covered and
   * no-focus fallbacks). When a dialog response is supplied, the dialog
   * wrappers and the requested action run in the same main-world
   * evaluation. This prevents unrelated page activity from consuming a
   * response between interceptor installation and action dispatch. The
   * retained object is the action's; its lane cleanup releases it.
   */
  private async dispatchTrustedBrowserAction(
    state: LiveBrowserSession,
    kind: 'click' | 'press',
    key: string | undefined,
    dialogResponse: BrowserJavaScriptDialogResponse | undefined,
    target: { objectId: string; sessionId: string },
    lane: ActionLaneContext,
    clickOptions?: {
      button?: BrowserMouseButton;
      clickCount?: number;
      modifiers?: BrowserKeyModifier[];
    },
  ): Promise<PrearmedPageDialogCapture | null> {
    let resolveDialog: (dialog: BrowserJavaScriptDialog) => void = () =>
      undefined;
    const dialogPromise = new Promise<BrowserJavaScriptDialog>((resolve) => {
      resolveDialog = resolve;
      state.pendingDialogWaiters.add(resolve);
    });
    const evaluationPromise = (async (): Promise<{
      completed: true;
      capture: PrearmedPageDialogCapture | null;
    }> => {
      lane.beginDispatch();
      const debug = state.view.webContents.debugger;
      const send = (params: Record<string, unknown>): Promise<unknown> =>
        target.sessionId
          ? debug.sendCommand(
              'Runtime.callFunctionOn',
              params,
              target.sessionId,
            )
          : debug.sendCommand('Runtime.callFunctionOn', params);
      const command = send({
        objectId: target.objectId,
        functionDeclaration: syntheticActionDeclaration(
          {
            kind,
            ...(key === undefined ? {} : { key }),
            ...clickOptions,
            ...(dialogResponse ? { dialogResponse } : {}),
          },
          JAVASCRIPT_DIALOG_PROMPT_LIMIT,
        ),
        returnByValue: true,
        awaitPromise: false,
        userGesture: true,
      });
      const response: unknown = await lane.trackCommand(command);
      if (isRecord(response) && isRecord(response.exceptionDetails)) {
        const exception = isRecord(response.exceptionDetails.exception)
          ? response.exceptionDetails.exception
          : {};
        throw new Error(
          optionalString(
            exception.description,
            optionalString(
              response.exceptionDetails.text,
              `Trusted browser ${kind} evaluation failed.`,
            ),
          ),
        );
      }
      const remoteResult =
        isRecord(response) && isRecord(response.result) ? response.result : {};
      const value = isRecord(remoteResult.value) ? remoteResult.value : {};
      const capture = this.prearmedPageDialogCapture(state, value.capture);
      return { completed: true, capture };
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        evaluationPromise,
        dialogPromise,
        new Promise<'timeout'>((resolve) => {
          timeout = setTimeout(
            () => resolve('timeout'),
            DEBUGGER_COMMAND_TIMEOUT_MS,
          );
        }),
      ]);
      if (outcome === 'timeout') {
        throw new Error(`Timed out dispatching trusted browser ${kind}.`);
      }
      if ('completed' in outcome) {
        return outcome.capture;
      }
      // The private Electron event and the CDP event describe the same
      // dialog. CDP commonly follows immediately with richer prompt/frame
      // metadata, so let that event run and return the merged state rather
      // than the private event's earlier snapshot.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const pendingDialog =
        state.pendingDialog?.id === outcome.id ? state.pendingDialog : outcome;
      throw new BrowserDialogPendingError(pendingDialog);
    } finally {
      if (timeout) clearTimeout(timeout);
      state.pendingDialogWaiters.delete(resolveDialog);
      void evaluationPromise.catch(() => undefined);
    }
  }

  private handlePreloadResult(
    webContentsId: number,
    result: BrowserPreloadResult,
  ): void {
    const state = this.findByWebContentsId(webContentsId);
    const pending = state?.pendingCommands.get(result.requestId);
    if (!state || !pending) return;
    state.pendingCommands.delete(result.requestId);
    clearTimeout(pending.timeout);
    if (result.ok) {
      pending.resolve(result.result);
    } else {
      pending.reject(new Error(result.error ?? 'Browser command failed.'));
    }
  }

  private handlePreloadEvent(
    webContentsId: number,
    payload: BrowserPreloadEvent,
  ): void {
    const state = this.findByWebContentsId(webContentsId);
    if (!state) return;
    if (payload.type === 'user-interaction') {
      const interaction = payload.interaction;
      const expected = state.expectedAgentInput ?? [];
      const now = Date.now();
      state.expectedAgentInput = expected.filter(
        (item) => now <= item.expiresAt,
      );
      const index = interaction
        ? state.expectedAgentInput.findIndex(
            (item) =>
              item.type === interaction.type &&
              Math.abs(item.timestamp - interaction.timestamp) <= 500 &&
              (item.type === 'keydown'
                ? item.key === interaction.key
                : item.button === interaction.button &&
                  typeof item.clientX === 'number' &&
                  typeof item.clientY === 'number' &&
                  typeof interaction.clientX === 'number' &&
                  typeof interaction.clientY === 'number' &&
                  Math.abs(item.clientX - interaction.clientX) <= 2 &&
                  Math.abs(item.clientY - interaction.clientY) <= 2),
          )
        : -1;
      if (index >= 0) {
        const [matched] = state.expectedAgentInput.splice(index, 1);
        matched?.confirm?.();
        return;
      }
      this.userInteractionGeneration += 1;
      this.emitForSession(state, {
        type: 'user-interaction',
        browserId: state.snapshot.id,
      });
      return;
    }
    if (payload.type === 'element-picked' && payload.snapshot) {
      void this.handleElementPicked(state, payload.snapshot);
      return;
    }
    if (payload.type === 'recording-step' && payload.step) {
      // A report can arrive after agent input ended; the step's own time decides.
      const at = payload.step.timestamp;
      if (
        [
          ...(state.agentDragWindows ?? []),
          ...(state.agentEditorWindows ?? []),
        ].some(
          (input) =>
            at >= input.from && (input.to === undefined || at <= input.to),
        )
      )
        return;
      const action = (state.agentActionWindows ?? []).find(
        (input) =>
          at >= input.from && (input.to === undefined || at <= input.to),
      );
      const secretElement = payload.secretElement === true;
      if (!action) this.addRecordingStep(state, payload.step);
      else if (action.to === undefined)
        action.held.push({ step: payload.step, secretElement });
      else
        this.recordActionPageStep(state, action, payload.step, secretElement);
      return;
    }
    if (payload.type === 'pick-cancelled') {
      updateSnapshot(state, { pickMode: false });
      this.emitSnapshot(state);
    }
  }

  private async handleElementPicked(
    state: LiveBrowserSession,
    snapshot: BrowserElementSnapshot,
  ): Promise<void> {
    updateSnapshot(state, { pickMode: false });
    const snapshotWithScreenshot = await this.captureElementScreenshot(
      state,
      snapshot,
    );
    if (!this.isCurrentLiveSession(state)) return;
    this.emitForSession(state, {
      type: 'element-picked',
      browserId: state.snapshot.id,
      snapshot: snapshotWithScreenshot,
    });
    this.emitSnapshot(state);
  }

  private async captureElementScreenshot(
    state: LiveBrowserSession,
    snapshot: BrowserElementSnapshot,
  ): Promise<BrowserElementSnapshot> {
    try {
      const image = await state.view.webContents.capturePage(
        rectangleFromCapture(snapshot.bounds),
      );
      this.assertCurrentLiveSession(state);
      const screenshotAttachmentPath = await this.writeAttachment(
        state,
        uiSelectionFilename(state.snapshot.id),
        image.toPNG(),
      );
      return { ...snapshot, screenshotAttachmentPath };
    } catch (error) {
      this.captureConsole(state, {
        level: 'warning',
        text: `Failed to capture selected element screenshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return snapshot;
    }
  }

  private findByWebContentsId(
    webContentsId: number,
  ): LiveBrowserSession | null {
    return (
      Array.from(this.sessions.values()).find(
        (state) => state.view.webContents?.id === webContentsId,
      ) ?? null
    );
  }

  private requireSession(
    browserId: string,
    unavailableCode?: 'external.state_changed',
  ): LiveBrowserSession {
    this.assertCommandTarget(browserId);
    const destroying = this.destroying.has(browserId);
    const state = destroying ? undefined : this.sessions.get(browserId);
    if (!state) {
      const error = new Error(
        destroying
          ? `Browser ${browserId} is being destroyed.`
          : `Browser ${browserId} not found.`,
      );
      throw unavailableCode ? classifyError(error, unavailableCode) : error;
    }
    return state;
  }

  private isCurrentLiveSession(state: LiveBrowserSession): boolean {
    return (
      !this.destroying.has(state.snapshot.id) &&
      this.sessions.get(state.snapshot.id) === state &&
      Boolean(state.view.webContents && !state.view.webContents.isDestroyed())
    );
  }

  /** The page closed its own contents; no one is destroying the tab. */
  private pageClosedItself(state: LiveBrowserSession): boolean {
    return (
      !this.destroying.has(state.snapshot.id) &&
      this.sessions.get(state.snapshot.id) === state &&
      !(state.view.webContents && !state.view.webContents.isDestroyed())
    );
  }

  private assertCurrentLiveSession(state: LiveBrowserSession): void {
    if (!this.isCurrentLiveSession(state)) {
      throw new Error(`Browser ${state.snapshot.id} is no longer available.`);
    }
  }

  private resolveFallbackBrowserId(request: {
    projectId?: string;
    worktreeId?: string;
  }): string | null {
    const { projectId, worktreeId } = request;
    const hasProject = projectId !== undefined;
    const hasWorktree = worktreeId !== undefined;
    if (hasProject !== hasWorktree) {
      return null;
    }
    if (projectId !== undefined && worktreeId !== undefined) {
      const active = this.resolveActiveBrowserId(projectId, worktreeId);
      if (active && this.sessions.has(active)) {
        return active;
      }
      return (
        this.resolveFallbackSessions(request).find(
          (state) =>
            state.snapshot.projectId === projectId &&
            state.snapshot.worktreeId === worktreeId,
        )?.snapshot.id ?? null
      );
    }
    return this.resolveFallbackSessions(request)[0]?.snapshot.id ?? null;
  }

  private resolveFallbackSessions(request: {
    projectId?: string;
    worktreeId?: string;
  }): LiveBrowserSession[] {
    const sessions = Array.from(this.sessions.values()).filter(
      (state) =>
        !isMcpOAuthBrowserScope(
          state.snapshot.projectId,
          state.snapshot.worktreeId,
        ),
    );
    const { projectId, worktreeId } = request;
    const hasProject = projectId !== undefined;
    const hasWorktree = worktreeId !== undefined;
    if (hasProject !== hasWorktree) {
      return [];
    }
    if (projectId !== undefined && worktreeId !== undefined) {
      return sessions.filter((state) => scopedFallbackMatches(state, request));
    }
    return sessions;
  }

  private emitSnapshot(state: LiveBrowserSession): void {
    this.notifyActionSettle(state);
    if (!this.isCurrentLiveSession(state)) return;
    this.rememberLiveSnapshot(state);
    this.scheduleSnapshotPersistence(state);
    this.emitForSession(state, {
      type: 'snapshot',
      browserId: state.snapshot.id,
      snapshot: state.snapshot,
    });
  }

  /**
   * Session-scoped browser events only. App-link routing events ride the same
   * `browser:event` channel but are emitted by `app-link-router.ts`, and carry
   * no `browserId`, so they are excluded here rather than guarded per-branch.
   */
  private emitForSession(
    state: LiveBrowserSession,
    event: Exclude<BrowserServiceEvent, AppLinkBrowserEvent>,
    hostWindow?: BrowserWindow | null,
  ): void {
    if (!this.isCurrentLiveSession(state)) return;
    this.emit(
      {
        ...event,
        runtimeGeneration: state.snapshot.profile?.runtimeGeneration,
      },
      hostWindow,
    );
  }

  private emit(
    event: Exclude<BrowserServiceEvent, AppLinkBrowserEvent>,
    hostWindow?: BrowserWindow | null,
  ): void {
    if (event.type === 'destroyed')
      browserHandoffs.releaseBrowser(event.browserId);
    if (event.type === 'load-failed') {
      const state = this.sessions.get(event.browserId);
      if (state && this.isCurrentLiveSession(state)) {
        this.rememberLiveSnapshot(state);
        this.scheduleSnapshotPersistence(state);
      }
    }
    if (event.type === 'snapshot' || event.type === 'load-failed') {
      const state = this.sessions.get(event.browserId);
      if (state) {
        this.updateBrowserResource(state);
      }
    }
    const state = this.sessions.get(event.browserId);
    sendToWindow(
      hostWindow ?? state?.hostWindow ?? null,
      IPC_CHANNELS.browserEvent,
      event,
    );
  }

  private async writeAttachment(
    state: LiveBrowserSession,
    filename: string,
    buffer: Buffer,
  ): Promise<string> {
    this.assertCurrentLiveSession(state);
    const binding = state.snapshot.profile;
    if (!binding || !state.snapshot.taskScope)
      throw new BrowserProfileError(
        'scope_unresolved',
        'Browser temporary data requires a current profile binding.',
      );
    const owner: BrowserScratchOwner = {
      browserId: state.snapshot.id,
      profileId: binding.resolvedProfileId,
      storageGeneration: binding.storageGeneration,
      runtimeGeneration: binding.runtimeGeneration,
      taskScope: structuredClone(state.snapshot.taskScope),
      taskIncarnationId: binding.taskIncarnationId,
    };
    const filePath = await this.profileData.scratch.write(
      owner,
      filename.endsWith('.md') ? 'md' : 'png',
      buffer,
    );
    state.attachmentPaths.add(filePath);
    return filePath;
  }
}

function timestampForFilename(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace('.', '-')
    .replace('Z', '');
}

export const BROWSER_VIEW_PRELOAD_CHANNELS = {
  command: PRELOAD_COMMAND_CHANNEL,
  result: PRELOAD_RESULT_CHANNEL,
  event: PRELOAD_EVENT_CHANNEL,
} as const;

function browserInputError(
  code: BrowserActionErrorCode,
  message?: string,
): BrowserActionError {
  const messages: Partial<Record<BrowserActionErrorCode, string>> = {
    target_not_found:
      'No element matched the target. Refresh the input snapshot.',
    target_stale:
      'The prepared target is no longer in this document. Refresh the input snapshot.',
    target_ambiguous:
      'More than one element matched the target. Use a current input reference.',
    target_disabled: 'The target remained disabled.',
    target_not_visible: 'The target has no visible input point.',
    target_obscured: 'The target is covered and cannot be invoked directly.',
    not_editable: 'The target is not editable.',
    dialog_pending: 'A JavaScript dialog is pending.',
    execution_failed: 'Browser input failed before dispatch.',
    cancelled: 'The browser action was cancelled before input was sent.',
    chooser_expired:
      'That file chooser is no longer open: its page navigated, its input was removed, or it expired. Repeat the action that opened it.',
  };
  const retryable =
    code === 'target_disabled' ||
    code === 'target_not_visible' ||
    code === 'target_obscured' ||
    code === 'timeout';
  return {
    code,
    message: message ?? messages[code] ?? 'Browser input could not be sent.',
    retryable,
    ...(code === 'target_not_found' ||
    code === 'target_stale' ||
    code === 'target_ambiguous' ||
    code === 'frame_unavailable'
      ? { next: 'browser.input_snapshot' }
      : {}),
  };
}

function isInvalidWaitForTargetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /invalid (?:css )?(?:locator|selector)|selector syntax|syntaxerror|failed to parse selector|unsupported (?:playwright[- ]like )?(?:locator|selector)|(?:locator|selector).*unsupported/i.test(
    error.message,
  );
}
