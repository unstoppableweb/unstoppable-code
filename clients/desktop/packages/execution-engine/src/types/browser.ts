// ---------------------------------------------------------------------------
// In-app browser shared types
// ---------------------------------------------------------------------------
//
// These types describe the transport contract between the renderer (frontend)
// and the Electron main process (backend) for the in-app browser / UI
// inspection feature. They define *shapes and surfaces only* — runtime
// behavior lives in the backend (`BrowserService`, IPC handlers, CDP capture,
// agent actions) and the frontend (`browserStore`, Browser panels).
//
// All browser IPC payloads route by `browserId` (a UUID assigned at create
// time). The main-side `BrowserService` owns the authoritative session table
// and stamps every outbound {@link BrowserEvent} from it.

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

import type {
  BrowserProfileBinding,
  BrowserProfileSelection,
  BrowserProfileRecord,
  BrowserProfilesApi,
  BrowserTaskScope,
} from '@canopy/protocol/browser-profiles';
import type {
  BROWSER_AGENT_ACTION_STATUSES,
  BROWSER_AGENT_OUTCOME_UNKNOWN_REASONS,
} from '@canopy/protocol/delegation/browser-agent';
import type {
  BrowserAutomationCommand,
  BrowserConsoleLevel,
  BrowserJavaScriptDialogResponse,
  BrowserProfileSwitchRequest,
  BrowserSavePdfRequest,
  BrowserTransferStatus,
} from '@canopy/protocol/browser';
export * from '@canopy/protocol/browser';
export type {
  BrowserProfileBinding,
  BrowserProfileRecord,
  BrowserProfileSelection,
  BrowserTaskScope,
  BrowserTaskSlot,
} from '@canopy/protocol/browser-profiles';

/** Theme the embedded page is asked to render with. */
/** `system` sets no color scheme on the page, so it follows the app's theme. */
export type BrowserThemeMode = 'system' | 'light' | 'dark';

/**
 * Coarse load lifecycle state for an embedded browser view. `'idle'` is the
 * pre-navigation state, `'loading'` while a navigation is in flight, `'ready'`
 * once the page has loaded, and `'failed'` when the navigation was rejected or
 * errored.
 */
export type BrowserLoadStatus = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * Compatibility discriminator retained by the current-UI-state wire shape.
 * `'browser'` identifies a relevant visible Browser panel.
 */
export type BrowserDrawerTabId = 'terminal' | 'browser';

/**
 * Authoritative wire snapshot of a single embedded browser view. Emitted by
 * the main process over {@link BrowserEvent} (`snapshot` / `load-failed`) and
 * returned by most `window.api.browser.*` mutators so the renderer can replace
 * its local state without re-deriving it.
 */
export interface BrowserSessionSnapshot {
  /** Present after the version-2 profile binding has been resolved by main. */
  profile?: BrowserProfileBinding;
  profileInfo?: Pick<
    BrowserProfileRecord,
    'displayName' | 'color' | 'kind' | 'agentPermissions' | 'metadataRevision'
  >;
  taskScope?: BrowserTaskScope;
  /** UUID, globally unique across all worktrees and projects. */
  id: string;
  /** Owning project id (worktree-scoped). */
  projectId: string;
  /** Owning worktree id (worktree-scoped). */
  worktreeId: string;
  /** Unix-ms timestamp the view was created. */
  createdAt: number;
  /** Unix-ms timestamp of the most recent snapshot update. */
  updatedAt: number;
  /** Current committed URL. */
  url: string;
  /** Current document title. */
  title: string;
  /** Current page favicon URL, when Electron has reported one. */
  faviconUrl?: string;
  /** Coarse load lifecycle state. */
  status: BrowserLoadStatus;
  /** Whether the embedded view can navigate back in its history. */
  canGoBack: boolean;
  /** Whether the embedded view can navigate forward in its history. */
  canGoForward: boolean;
  /** Whether a navigation is currently in flight. */
  loading: boolean;
  /** Theme the embedded page is rendering with. */
  themeMode: BrowserThemeMode;
  /** Whether element pick (inspection) mode is active. */
  pickMode: boolean;
  /** Whether an interaction recording is in progress. */
  recording: boolean;
  /** Most recent navigation/load error string, when one occurred. */
  lastError?: string;
}

/**
 * Normalized browser-session layout metadata for one worktree. Outer panel
 * placement is persisted separately in `panel-layout.json`; this state only
 * records ordered sessions and the explicit active session.
 */
export interface WorktreeBrowserLayoutState {
  /** Browser ids in stable persisted order. */
  browserOrder: string[];
  /** Explicitly active browser id, or `null` when no session is active. */
  activeBrowserId: string | null;
}

/**
 * On-disk worktree browser persistence file stored under `worktree-data/`.
 * `version` is present so future persistence migrations have a reliable
 * discriminator.
 */
export interface PersistedWorktreeBrowserStateFile extends WorktreeBrowserLayoutState {
  version: 1 | 2;
  browsers: BrowserSessionSnapshot[];
}

/** Pixel rectangle in renderer (CSS) coordinates. */
export interface BrowserRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single console message captured from an embedded browser view. */
export interface BrowserConsoleEntry {
  id: string;
  browserId: string;
  runtimeGeneration?: number;
  timestamp: number;
  level: BrowserConsoleLevel;
  text: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/**
 * A single network request captured from an embedded browser view. The
 * renderer upserts entries by `requestId`, so optional response fields
 * (`status`, `statusText`, `mimeType`, `fromCache`, `durationMs`, `failed`,
 * `errorText`) fill in over the request lifetime.
 */
export interface BrowserNetworkEntry {
  id: string;
  browserId: string;
  runtimeGeneration?: number;
  requestId: string;
  timestamp: number;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  fromCache?: boolean;
  durationMs?: number;
  failed?: boolean;
  errorText?: string;
}

// ---------------------------------------------------------------------------
// Element snapshot types
// ---------------------------------------------------------------------------

/**
 * A candidate locator for a picked element, ordered by the backend from most
 * to least robust. `playwright`, when present, is the rendered Playwright
 * locator expression for this candidate.
 */
export interface BrowserLocatorCandidate {
  kind:
    | 'testId'
    | 'role'
    | 'label'
    | 'placeholder'
    | 'text'
    | 'alt'
    | 'title'
    | 'css'
    | 'domPath';
  value: string;
  name?: string;
  unique: boolean;
  confidence: 'high' | 'medium' | 'low';
  playwright?: string;
}

/**
 * Full snapshot of an element captured via pick mode or {@link
 * BrowserInspectRequest}. Carries the locator candidates the renderer surfaces
 * for "Pick & Polish" attachment staging plus enough context (bounds, DOM
 * path, outer HTML) to describe the element to an agent.
 */
export interface BrowserElementSnapshot {
  browserId: string;
  runtimeGeneration?: number;
  url: string;
  title: string;
  capturedAt: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  themeMode: BrowserThemeMode;
  tagName: string;
  role?: string;
  accessibleName?: string;
  text?: string;
  value?: string;
  /** True when the value is withheld because it is a password, one-time code, or payment card field. */
  valueRedacted?: boolean;
  attributes: Record<string, string>;
  bounds: BrowserRectangle;
  /** The child frame the element is in; absent for the top document. */
  frameRef?: string;
  /** `true` inside an open or closed shadow root; absent otherwise. */
  inShadowRoot?: boolean;
  preferredLocator?: BrowserLocatorCandidate;
  locatorCandidates: BrowserLocatorCandidate[];
  domPath: string[];
  outerHtml: string;
  screenshotAttachmentPath?: string;
}

// ---------------------------------------------------------------------------
// IPC request / response payloads
// ---------------------------------------------------------------------------

export interface BrowserCreateRequest {
  selection?: BrowserProfileSelection;
  projectId: string;
  worktreeId: string;
  url?: string;
  themeMode?: BrowserThemeMode;
  /**
   * Optional: rebind to a persisted browser id when recreating a view after an
   * app restart so saved panel/session references stay valid. Omitted => new
   * UUID.
   */
  browserId?: string;
  expectedRuntimeGeneration?: number;
}

/** App-owned, transient sign-in views. Never restored as workspace browsers. */
export const MCP_OAUTH_BROWSER_SCOPE = {
  projectId: 'app-oauth',
  worktreeId: 'mcp',
} as const;

export function isMcpOAuthBrowserScope(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    projectId === MCP_OAUTH_BROWSER_SCOPE.projectId &&
    worktreeId === MCP_OAUTH_BROWSER_SCOPE.worktreeId
  );
}

/** Explicitly selects or clears the saved active browser for one worktree. */
export interface BrowserSetActiveRequest {
  projectId: string;
  worktreeId: string;
  browserId: string | null;
}

export interface BrowserNavigateRequest {
  browserId: string;
  expectedRuntimeGeneration?: number;
  url: string;
}

export interface BrowserSetBoundsRequest {
  browserId: string;
  expectedRuntimeGeneration?: number;
  bounds: BrowserRectangle;
  visible: boolean;
  /**
   * The page area's corner radii, in the same CSS px as `bounds`, so the
   * native view rounds only the corners where it meets its card's rounded
   * corners. Absent keeps the view's current radii.
   */
  cornerRadii?: BrowserCornerRadii;
  /**
   * The renderer's viewport (CSS px) when it measured `bounds`. With it the
   * host can tell how the area moves with the window, and place the view at
   * a new window size before the renderer has laid that size out.
   */
  viewport?: { width: number; height: number };
}

export interface BrowserCornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

export interface BrowserGetConsoleRequest {
  browserId?: string;
  expectedRuntimeGeneration?: number;
  projectId?: string;
  worktreeId?: string;
  level?: BrowserConsoleLevel;
  since?: number;
  limit?: number;
}

export interface BrowserGetNetworkRequest {
  browserId?: string;
  expectedRuntimeGeneration?: number;
  projectId?: string;
  worktreeId?: string;
  status?: number;
  failed?: boolean;
  urlContains?: string;
  since?: number;
  limit?: number;
}

export interface BrowserHandoff {
  handoffId: string;
  projectId: string;
  worktreeId: string;
  browserId: string;
  runtimeGeneration?: number;
  origin: { projectId: string; worktreeId: string; chatTabId: string };
  requestedAt: number;
}

export interface BrowserHandoffHydration {
  /** Monotonic process-local revision; an older hydration must not override live events. */
  revision: number;
  handoff: BrowserHandoff | null;
}

export type LoadWorktreeBrowserStateResponse = BrowserHandoffHydrationEnvelope &
  (
    | {
        status: 'loaded';
        state: PersistedWorktreeBrowserStateFile;
      }
    | {
        /** No persisted browser-state.json exists for the worktree yet. */
        status: 'missing';
        state: null;
      }
    | {
        /** Existing state was invalid; empty defaults are used without rewriting it. */
        status: 'fallback';
        state: PersistedWorktreeBrowserStateFile;
        error: string;
      }
    | {
        /** An existing file was unreadable, unsupported, or invalid. */
        status: 'rejected';
        state: null;
        error: string;
      }
  );

/** Transient metadata is never part of browser-state.json. */
export interface BrowserHandoffHydrationEnvelope {
  handoffState?: BrowserHandoffHydration;
}

export interface SaveWorktreeBrowserStateRequest {
  projectId: string;
  worktreeId: string;
  state: PersistedWorktreeBrowserStateFile;
}

export interface BrowserInspectRequest {
  browserId: string;
  expectedRuntimeGeneration?: number;
  ref?: string;
  locator?: string;
  /** Frame ref or iframe CSS selector; scopes locator evaluation only. */
  frame?: string;
  x?: number;
  y?: number;
}

export interface BrowserInputSnapshotFilter {
  /** Only rows in this frame ref or iframe CSS selector. */
  frame?: string;
  /** Exact, case-insensitive HTML input type such as text, email, or checkbox. */
  inputType?: string;
  /** Exact, case-insensitive semantic role such as textbox, button, or link. */
  role?: string;
  /** Case-insensitive fuzzy match across accessible name, text, and placeholder. */
  name?: string;
}

export interface BrowserInputSnapshotRequest {
  browserId: string;
  expectedRuntimeGeneration?: number;
  filter?: BrowserInputSnapshotFilter;
  /** Zero-based result offset for pagination. */
  offset?: number;
  /** Maximum controls to return. The agent action caps this at 100. */
  limit?: number;
}

export interface BrowserInputSnapshotItem {
  /** Page-lifetime reference accepted by browser click/fill/press/inspect actions. */
  ref: string;
  /**
   * The child frame the control is in, for frame-scoped locators; absent
   * for the top document, whose frameRef is in `frames`.
   */
  frameRef?: string;
  /** `true` inside an open or closed shadow root; absent otherwise. */
  inShadowRoot?: boolean;
  /** Whether its bounds intersect the top-level viewport. */
  inViewport?: boolean;
  tagName: string;
  role?: string;
  inputType?: string;
  name?: string;
  text?: string;
  placeholder?: string;
  value?: string;
  /** True when the value is withheld because it is a password, one-time code, or payment card field. */
  valueRedacted?: boolean;
  disabled: boolean;
  /** Native state or `aria-checked`; `mixed` for an indeterminate control. */
  checked?: boolean | 'mixed';
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean | 'mixed';
  required?: boolean;
  invalid?: boolean;
  readOnly?: boolean;
  /** An input or textarea that takes text, or a contenteditable element. */
  editable?: boolean;
  /** First 20 options of a select or listbox. Omitted for a secret select. */
  options?: BrowserInputOption[];
  /** All options, including those past the first 20. */
  optionCount?: number;
  /** True when `options` is withheld because the select is secret. */
  optionsRedacted?: boolean;
  /** Only the constraints the control declares. */
  constraints?: {
    pattern?: string;
    min?: string;
    max?: string;
    step?: string;
    minLength?: number;
    maxLength?: number;
    accept?: string;
    multiple?: boolean;
  };
  /** Expected value format of a compound input, such as `YYYY-MM-DD`. */
  format?: string;
  bounds: BrowserRectangle;
  locator?: string;
}

export interface BrowserInputSnapshotResponse {
  browserId: string;
  runtimeGeneration?: number;
  url: string;
  title: string;
  capturedAt: string;
  filter: BrowserInputSnapshotFilter;
  offset: number;
  limit: number;
  total: number;
  returned: number;
  truncated: boolean;
  nextOffset?: number;
  inputs: BrowserInputSnapshotItem[];
  /**
   * The top document's layout viewport, in CSS pixels, whatever `frame`
   * filter applies; absent when it could not be read for the snapshot's
   * document.
   */
  viewport?: { width: number; height: number };
  /** The top document's scrolling element: offsets and maxima, CSS px. */
  scroll?: { x: number; y: number; maxX: number; maxY: number };
  /** Frame coverage; URLs contain only origin and pathname. */
  frames?: Array<{
    frameRef: string;
    url: string;
    status: 'included' | 'omitted';
    reason?: string;
  }>;
}

export interface BrowserScreenshotRequest {
  browserId: string;
  expectedRuntimeGeneration?: number;
  saveToAttachments?: boolean;
  /**
   * `freeze-frame` asks for the fast, lossy stand-in a pane shows while an
   * overlay covers its native view. Omitted means a lossless PNG capture.
   */
  purpose?: 'freeze-frame';
}

export interface BrowserScreenshotResponse {
  runtimeGeneration?: number;
  attachmentPath?: string;
  dataUrl?: string;
}

// ---------------------------------------------------------------------------
// JavaScript dialog types
// ---------------------------------------------------------------------------

export type BrowserJavaScriptDialogType =
  | 'alert'
  | 'confirm'
  | 'prompt'
  | 'beforeunload';

/**
 * Ephemeral JavaScript dialog currently blocking an embedded page. Dialogs
 * are owned by the live WebContents and must never be persisted with browser
 * session snapshots.
 */
export interface BrowserJavaScriptDialog {
  id: string;
  browserId: string;
  runtimeGeneration?: number;
  type: BrowserJavaScriptDialogType;
  message: string;
  defaultPrompt?: string;
  url: string;
  frameId?: string;
  openedAt: number;
}

/**
 * A file chooser that a page opened during an agent's action, waiting for
 * `upload_files` or `request_files` with its id, or for the user. Ephemeral,
 * like a JavaScript dialog: owned by the live page, never persisted.
 */
export interface BrowserFileChooser {
  id: string;
  browserId: string;
  runtimeGeneration?: number;
  /** Origin of the frame that owns the file input. */
  frameOrigin: string;
  /** Origin of the page. */
  topOrigin: string;
  multiple: boolean;
  /** The input picks a folder (`webkitdirectory`). */
  directory?: boolean;
  /** The input's `accept` attribute. */
  accept?: string;
  openedAt: number;
  /** Ends then, or sooner when its frame navigates. */
  expiresAt: number;
}

/**
 * A page's `window.print()` during an agent's action, waiting for the agent
 * (`handle_dialog`: accept saves a PDF) or the user (the pane banner).
 * Ephemeral like a file chooser: owned by the live page, never persisted.
 */
export interface BrowserPrintRequest {
  id: string;
  browserId: string;
  runtimeGeneration?: number;
  /** Origin of the frame that called `print()`. */
  frameOrigin: string;
  /** Origin of the page. */
  topOrigin: string;
  openedAt: number;
  /** Ends then, or sooner when its frame or the page navigates. */
  expiresAt: number;
}

export interface BrowserAnswerPrintRequestRequest {
  browserId: string;
  printRequestId: string;
  /**
   * Save the page as a PDF task file, open the native print dialog (the
   * user's banner only), or dismiss the request.
   */
  answer: 'save_pdf' | 'print' | 'dismiss';
}

export interface BrowserAnswerPrintRequestResult {
  ok: boolean;
  /** The saved PDF, for `save_pdf`. */
  transfer?: BrowserDownloadTransfer;
  error?: BrowserTransferError;
}

/**
 * An HTTP authentication challenge (the `login` event), held for the user:
 * the pane notice's **Sign in…** opens an app-owned credentials dialog.
 * Agents read it and can only cancel it; credentials never reach them and
 * are never saved. Ephemeral: owned by the live page, never persisted.
 */
export interface BrowserAuthRequest {
  id: string;
  browserId: string;
  runtimeGeneration?: number;
  /** The origin that asked: the page's, or the proxy's for proxy auth. */
  origin: string;
  /** The server's realm, as it sent it. */
  realm?: string;
  isProxy: boolean;
  openedAt: number;
  /** Cancelled then, as Cancel would. */
  expiresAt: number;
}

export interface BrowserAnswerAuthRequestRequest {
  browserId: string;
  authRequestId: string;
  answer: 'sign_in' | 'cancel';
  /** For `sign_in`: the user's credentials, passed on and never kept. */
  username?: string;
  password?: string;
}

export interface BrowserAnswerFileChooserRequest {
  browserId: string;
  chooserId: string;
  /** Open the native picker for the user, or dismiss the chooser. */
  answer: 'choose' | 'dismiss';
}

export interface BrowserHandleJavaScriptDialogRequest extends BrowserJavaScriptDialogResponse {
  browserId: string;
  expectedRuntimeGeneration?: number;
  dialogId: string;
}

export interface BrowserHandleJavaScriptDialogResponse extends BrowserJavaScriptDialogResponse {
  runtimeGeneration?: number;
  dialog: BrowserJavaScriptDialog;
}

/** One option of a select, a listbox, or a combobox's list. */
export interface BrowserInputOption {
  value: string;
  /**
   * The value is longer than a snapshot gives, so it was cut short: choose
   * the option by label or index instead.
   */
  valueTruncated?: boolean;
  label: string;
  selected: boolean;
  disabled: boolean;
}

export interface BrowserAutomationRequest {
  browserId?: string;
  expectedRuntimeGeneration?: number;
  projectId?: string;
  worktreeId?: string;
  /** The App Advisor tool request ID, so main can cancel the action. */
  cancellationKey?: string;
  /**
   * The chat whose approval session answers an action that asks, such as
   * `upload_files`. Without it such an action is denied.
   */
  approvalChat?: { projectId: string; worktreeId: string; chatId: string };
  command: BrowserAutomationCommand;
}

export interface BrowserWaitForResult {
  satisfied: boolean;
  elapsedMs: number;
  /** State observed when the wait ended. URLs carry origin and path only. */
  observed: {
    url?: string;
    readyState?: 'loading' | 'interactive' | 'complete';
    matchCount?: number;
    visibleCount?: number;
    inflightRequests?: number;
    /** The download waited for, as it was when the wait ended. */
    download?: BrowserDownloadTransfer;
    /** The upload waited for, as it was when the wait ended. */
    upload?: BrowserUploadTransfer;
  };
}

export type BrowserActionStatus =
  (typeof BROWSER_AGENT_ACTION_STATUSES)[number];
export type BrowserInputMode = 'trusted' | 'synthetic' | 'direct';

export type BrowserActionErrorCode =
  | 'target_not_found'
  | 'target_stale'
  | 'target_ambiguous'
  | 'target_not_visible'
  | 'target_disabled'
  | 'target_obscured'
  | 'not_editable'
  | 'unsupported_control'
  | 'option_not_found'
  | 'frame_unavailable'
  | 'timeout'
  | 'cancelled'
  | 'policy_denied'
  | 'approval_denied'
  | 'file_not_eligible'
  | 'file_changed'
  | 'origin_changed'
  | 'chooser_expired'
  | 'disk_full'
  | 'unsupported_capability'
  | 'execution_failed'
  // A dialog already pending before dispatch is not an actionable target.
  | 'dialog_pending';

export interface BrowserActionError {
  code: BrowserActionErrorCode;
  message: string;
  retryable: boolean;
  next?: string;
  candidates?: BrowserLocatorCandidate[];
  /** For a select: its options, at most 50. Never set for a secret select. */
  options?: BrowserInputOption[];
  candidatesRedacted?: boolean;
}

export interface BrowserActionTargetState {
  ref?: string;
  // Frame identity is added with the phase 04 page model.
  tagName: string;
  role?: string;
  name?: string;
  inputType?: string;
  value?: string;
  valueRedacted?: boolean;
  checked?: boolean | 'mixed';
  selectedOptions?: Array<{ value: string; label: string }>;
  /**
   * A select's or list's options, at most 50, when a choice failed after
   * input was sent. Never set for a secret select.
   */
  options?: BrowserInputOption[];
  optionsRedacted?: boolean;
  expanded?: boolean;
  pressed?: boolean | 'mixed';
  disabled: boolean;
  focused: boolean;
  invalid?: boolean;
  validationMessage?: string;
  inViewport: boolean;
  bounds: BrowserRectangle;
}

/**
 * The scroll position of what an action scrolled, read after it settled. A
 * point-in-time observation: content a page loads later is not counted.
 */
export interface BrowserScrollEffect {
  /** The top document's scrolling element, or an element container. */
  container: 'page' | 'element';
  /** The axis the action scrolled. */
  axis: 'x' | 'y';
  /** Offsets from the start of each axis (right-to-left normalized), CSS px. */
  x: number;
  y: number;
  maxX: number;
  maxY: number;
  /** At the minimum (`atStart`) or maximum (`atEnd`) of `axis`, within 1 px. */
  atStart: boolean;
  atEnd: boolean;
  /** The position on `axis` changed. */
  moved: boolean;
  /** The scrollable size on `axis` grew during the action. */
  contentGrew: boolean;
}

export interface BrowserActionEffects {
  navigation?: {
    kind: 'none' | 'same_document' | 'new_document';
    url?: string;
    committed: boolean;
  };
  dialog?: BrowserJavaScriptDialog;
  /** A file chooser this action opened; answer it with `chooserId`. */
  fileChooser?: BrowserFileChooser;
  /** A print this action's page asked for; answer it with `handle_dialog`. */
  printRequest?: BrowserPrintRequest;
  /** Downloads this action started, as they were when the action ended. */
  downloads?: BrowserDownloadTransfer[];
  /**
   * A page's `window.open` this action caused: the URL opened in a new tab
   * (`browserId`), opened in the user's browser, or was blocked.
   */
  popup?: {
    url: string;
    handled: 'blocked' | 'opened_externally' | 'opened_in_tab';
    browserId?: string;
  };
  permissionDenied?: string[];
  /** The scroll position of the container or page that a scroll moved. */
  scroll?: BrowserScrollEffect;
  domChanged?: boolean;
  focusMoved?: boolean;
}

export interface BrowserActionReceipt {
  actionId: string;
  sequence: number;
  kind: BrowserAutomationCommand['kind'];
  status: BrowserActionStatus;
  /** Present exactly when status is outcome_unknown. */
  outcomeReason?: (typeof BROWSER_AGENT_OUTCOME_UNKNOWN_REASONS)[number];
  inputMode?: BrowserInputMode;
  target?: BrowserActionTargetState;
  effects?: BrowserActionEffects;
  warnings?: string[];
  readback?: {
    code: 'invalid_format' | 'state_unchanged';
    expectedFormat?: string;
    next?: string;
  };
  /** Only a failure established before input dispatch. */
  error?: BrowserActionError;
  /** `upload_files`: the upload, with its files' names and sizes. */
  upload?: BrowserUploadTransfer;
  /** `request_files`: the files the user chose, by name and size only. */
  requestedFiles?: Array<{ name: string; sizeBytes: number }>;
  durationMs: number;
}

/** Delivered unchanged when a runtime is lost after input dispatch. */
export interface BrowserPostDispatchUnknown {
  kind: 'post-dispatch-unknown';
  receipt: BrowserActionReceipt;
  capturedRuntimeGeneration: number;
}

export interface BrowserAutomationResponse {
  runtimeGeneration?: number;
  ok: boolean;
  browser?: BrowserSessionSnapshot;
  element?: BrowserElementSnapshot;
  /**
   * Present after a pre-armed response has intercepted the page dialog, or
   * after Chromium acknowledges a fallback CDP dialog response.
   */
  handledDialog?: BrowserHandleJavaScriptDialogResponse;
  /**
   * Present when page execution stopped at an unhandled JavaScript dialog.
   * `completed` is false in that case because the original page command has
   * not returned yet.
   */
  dialog?: BrowserJavaScriptDialog;
  completed?: boolean;
  receipt?: BrowserActionReceipt;
  /** Present for wait_for. */
  waitFor?: BrowserWaitForResult;
  /** The response was replayed for a repeated actionId; nothing ran again. */
  repeated?: true;
  error?: {
    code:
      | 'not_found'
      | 'invalid_payload'
      | 'invalid_target'
      | 'validation_failed'
      | 'authorization_conflict'
      | 'timeout'
      | 'execution_failed';
    message: string;
    /**
     * An action's receipt, or for an inspect whose target did not resolve
     * the same error an action refusal carries (`details.error`).
     */
    details?: BrowserActionReceipt | { error: BrowserActionError };
  };
}

// ---------------------------------------------------------------------------
// Recording types
// ---------------------------------------------------------------------------
//
// {@link BrowserRecordingStep} is one recorded action; {@link
// BrowserRecordingResult} is what `BrowserApi.stopRecording` / `getRecording`
// and the `browser.stop_recording` agent action return — accumulated steps
// plus the rendered Playwright script.

export interface BrowserRecordingStep {
  id: string;
  action:
    | 'goto'
    | 'click'
    | 'fill'
    | 'press'
    | 'select'
    | 'check'
    | 'uncheck'
    | 'submit'
    | 'hover'
    | 'scroll'
    | 'drag'
    | 'upload'
    | 'download'
    | 'print';
  locator?: string;
  /** For a download, the task file's name; `filechooser` for an upload that answered a chooser. */
  value?: string;
  /** Every selected value of a multiple select; `value` stays the first. For an upload, its files' names. */
  values?: string[];
  /** True when the value is withheld because it is a password, one-time code, or payment card field. */
  valueRedacted?: boolean;
  /** For an upload that answered a file chooser: when that chooser opened, so the script waits for it from the step that opened it. */
  chooserOpenedAt?: number;
  playwright: string;
  timestamp: number;
}

export interface BrowserRecordingResult {
  browserId: string;
  runtimeGeneration?: number;
  recording: boolean;
  steps: BrowserRecordingStep[];
  playwrightScript: string;
}

// ---------------------------------------------------------------------------
// Event union (main → renderer)
// ---------------------------------------------------------------------------
//
// Emitted over `IPC_CHANNELS.browserEvent`. Consumed by the renderer
// `browserStore`, the Pick & Polish attachment handler, and the
// console/network/recording panels (all frontend). The `network` event fires
// both when a request starts and when it completes/fails (renderer upserts by
// `requestId`), so `status`/`failed`/`durationMs` fill in over the request
// lifetime.

/**
 * Renderer-owned actions requested by a browser-page hotkey (ECW-7984). The
 * main process intercepts browser chords via `before-input-event` on the page
 * `WebContentsView` (the renderer never sees keydowns while the native page
 * owns keyboard focus) and forwards renderer-owned actions here: `new-tab`
 * creates + selects a new browser tab in the same worktree context and
 * focuses its address bar; `focus-address-bar` focuses the existing tab's
 * address bar; `toggle-sidebar` toggles the app sidebar; `find-in-page` opens
 * the renderer's find bar in browser mode for this tab (CAN-3048);
 * `close-tab` closes this tab's panel through the renderer's canonical
 * panel-close path (same as the tab "X"), so session teardown and Minimal's
 * fixed-topology refusal behave like a manual close.
 * `select-next-tab` / `select-previous-tab` (CAN-4616) select the tab after
 * or before this browser's own tab in its panel group, as the panel
 * tab-cycle shortcuts do. History back/forward chords are handled entirely in
 * the main process and never emit this event.
 */
export type BrowserShortcutEventAction =
  | 'new-tab'
  | 'focus-address-bar'
  | 'toggle-sidebar'
  | 'find-in-page'
  | 'close-tab'
  | 'select-next-tab'
  | 'select-previous-tab';

/**
 * Native find-in-page request (CAN-3048). `text` must contain a
 * non-whitespace character. `findNext: false` (default) starts a new search;
 * `true` moves to the next match of the same text in the `forward` direction
 * (default `true`).
 */
export interface BrowserFindInPageRequest {
  browserId: string;
  expectedRuntimeGeneration?: number;
  text: string;
  findNext?: boolean;
  forward?: boolean;
}

/** What to do with the active match when find-in-page stops. */
export type BrowserStopFindInPageAction =
  | 'clearSelection'
  | 'keepSelection'
  | 'activateSelection';

export interface BrowserStopFindInPageRequest {
  browserId: string;
  expectedRuntimeGeneration?: number;
  action: BrowserStopFindInPageAction;
}

/**
 * `link-context-menu` is the explicit "Open in browser" link menu choice: it
 * bypasses the app-link preference and has no external fallback.
 */
export type AppLinkOpenRequestSource =
  | 'app-link'
  | 'system-default'
  | 'link-context-menu';

export type BrowserOpenLinkRequestPhase =
  | 'acknowledge'
  | 'reserve'
  | 'complete';

/**
 * One response in the system-default delivery handshake. `acknowledge`
 * confirms worktree context, `reserve` transfers mutation ownership to the
 * renderer, and `complete` releases main's buffered OS URL only after panel
 * placement (or reports failure so main performs the external fallback).
 */
export interface BrowserOpenLinkRequestResolution {
  requestId: string;
  handled: boolean;
  phase: BrowserOpenLinkRequestPhase;
}

/**
 * App-link push contract, folded into {@link BrowserEvent} so the renderer's
 * single `browser:event` subscription handles it alongside session events.
 *
 * - `app-link-open-requested` asks the renderer to take an ordinary content
 *   link into the selected worktree's built-in browser. The renderer MUST
 *   answer every request through `browser.resolveOpenLinkRequest`; declining
 *   (or never answering) leaves main's external fallback in charge.
 * - `app-link-local-only-conflict` reports a link that was forced external
 *   because "Only allow local sites" is on, so the renderer can explain it
 *   instead of failing silently.
 * - `settings-link-open-requested` asks the renderer to open a link to a web
 *   account or organization settings page inside Settings. The renderer MUST
 *   answer through `browser.resolveOpenLinkRequest` with phase `acknowledge`;
 *   declining (or never answering) leaves ordinary app-link routing in charge.
 */
export type AppLinkBrowserEvent =
  | {
      type: 'app-link-open-requested';
      requestId: string;
      url: string;
      source: AppLinkOpenRequestSource;
      /**
       * System-default launches stay buffered until the renderer reports that
       * placement (or its external fallback) actually completed.
       */
      awaitCompletion?: boolean;
      /**
       * False when main only needs to confirm worktree context before emitting
       * a local-only conflict. The renderer acknowledges context but must not
       * place a browser panel for that request.
       */
      openInApp: boolean;
    }
  | {
      type: 'app-link-local-only-conflict';
      url: string;
    }
  | {
      type: 'settings-link-open-requested';
      requestId: string;
      /** The full link, for diagnostics and symmetry with the other variants. */
      url: string;
      /** The settings path with its query and fragment. */
      path: string;
    };

export type DefaultBrowserRegistrationFailure =
  | 'registration-refused'
  | 'user-action-required'
  | 'unsupported';

export interface DefaultBrowserRegistrationStatus {
  enabled: boolean;
  registered: boolean;
  platform: 'darwin' | 'win32' | 'linux';
  failure?: DefaultBrowserRegistrationFailure;
}

export type BrowserHandoffEvent = (
  | {
      type: 'handoff-requested';
      browserId: string;
      handoff: BrowserHandoff;
      revision: number;
    }
  | {
      type: 'handoff-released';
      browserId: string;
      handoffId: string;
      projectId: string;
      worktreeId: string;
      revision: number;
    }
) & { runtimeGeneration?: number };

/** Server push contract; the frontend handoff step adopts this union. */
export type BrowserServiceEvent = BrowserEvent | BrowserHandoffEvent;

export type BrowserEvent = (
  | AppLinkBrowserEvent
  | { type: 'snapshot'; browserId: string; snapshot: BrowserSessionSnapshot }
  | {
      /**
       * Main is creating a new session for an agent `browser.open` under this
       * pre-allocated id. The renderer places the tab (URL prefilled) right
       * away; `open-requested` follows on success, `destroyed` on failure.
       */
      type: 'open-pending';
      presentation?: 'foreground' | 'background';
      browserId: string;
      projectId: string;
      worktreeId: string;
      url?: string;
      originChatTabId: string;
    }
  | {
      type: 'open-requested';
      presentation?: 'foreground' | 'background';
      browserId: string;
      snapshot: BrowserSessionSnapshot;
      originChatTabId: string;
      /**
       * True only when this action created a new persisted session. Lets the
       * renderer roll it back if its bound panel cannot be placed, without
       * ever destroying an existing browser the action merely reused.
       */
      createdNewSession: boolean;
    }
  | {
      type: 'shortcut';
      browserId: string;
      snapshot: BrowserSessionSnapshot;
      action: BrowserShortcutEventAction;
    }
  | {
      /**
       * The page opened `url` in a new window (`target="_blank"`,
       * `window.open`), which main denied. The renderer opens it in a new tab
       * under `newBrowserId`, in the opener's worktree; main gives the
       * session the opener's profile. `background` marks a popup an agent's
       * action caused: its tab opens without taking focus.
       */
      type: 'new-tab-requested';
      presentation?: 'background';
      browserId: string;
      snapshot: BrowserSessionSnapshot;
      url: string;
      newBrowserId: string;
    }
  | { type: 'user-interaction'; browserId: string }
  | {
      /**
       * Native `found-in-page` result for one find request (CAN-3048).
       * Results arrive in several updates; `finalUpdate` marks the
       * authoritative one. `activeMatchOrdinal` is 1-based; `matches` is 0
       * when nothing matched. Consumers drop results whose `requestId` is
       * older than the latest `findInPage` call they issued.
       */
      type: 'find-result';
      browserId: string;
      requestId: number;
      activeMatchOrdinal: number;
      matches: number;
      finalUpdate: boolean;
    }
  | { type: 'destroyed'; browserId: string }
  | { type: 'console'; browserId: string; entry: BrowserConsoleEntry }
  | { type: 'network'; browserId: string; entry: BrowserNetworkEntry }
  | { type: 'load-failed'; browserId: string; snapshot: BrowserSessionSnapshot }
  | {
      type: 'element-picked';
      browserId: string;
      snapshot: BrowserElementSnapshot;
    }
  | { type: 'recording-step'; browserId: string; step: BrowserRecordingStep }
  | { type: 'recording-state'; browserId: string; recording: boolean }
  | {
      type: 'dialog-opened';
      browserId: string;
      dialog: BrowserJavaScriptDialog;
    }
  | {
      type: 'dialog-closed';
      browserId: string;
      dialogId: string;
    }
  | {
      /** The browser's pending file chooser opened, or ended (`null`). */
      type: 'file-chooser';
      browserId: string;
      chooser: BrowserFileChooser | null;
    }
  | {
      /** The browser's pending print request opened, or ended (`null`). */
      type: 'print-request';
      browserId: string;
      request: BrowserPrintRequest | null;
    }
  | {
      /** The browser's pending sign-in opened, or ended (`null`). */
      type: 'auth-request';
      browserId: string;
      request: BrowserAuthRequest | null;
    }
  | {
      /**
       * A download's record changed. Not runtime-generation scoped: the
       * record's owner was captured when it started.
       */
      type: 'transfer';
      browserId: string;
      transfer: BrowserTransfer;
    }
  | {
      /** Page-started downloads the per-browser guard cancelled, coalesced. */
      type: 'download-blocked';
      browserId: string;
      blockedCount: number;
    }
) & { runtimeGeneration?: number };

export type BrowserDownloadSource = 'user' | 'agent' | 'print' | 'pdf_document';

export type BrowserTransferErrorCode =
  | 'disk_full'
  | 'download_failed'
  | 'download_rate_limited'
  | 'not_found'
  | 'not_cancellable'
  | 'not_resumable'
  /** The chat's approval session denied the write, or no approval prompt was available. */
  | 'approval_denied'
  /** A file already has the name and `overwrite` was not set. */
  | 'destination_exists'
  /** The source or destination is not a safe target for the copy. */
  | 'file_not_eligible'
  /** Not a relative path inside the workspace, or not a usable file name. */
  | 'invalid_path'
  /** The copy failed, or a quit or crash interrupted it. */
  | 'copy_failed'
  /** A staged upload file no longer matches the bytes that were approved. */
  | 'file_changed'
  /** The frame that owns the file input now shows another origin. */
  | 'origin_changed'
  /** The upload could not be staged or attached, or a quit or crash interrupted it. */
  | 'upload_failed';

export interface BrowserTransferError {
  code: BrowserTransferErrorCode;
  message: string;
}

/** Host-neutral: never an absolute path. The host resolves `id` locally. */
export interface BrowserDownloadTransfer {
  kind: 'download';
  /** Also the BrowserDataJobs job id. */
  id: string;
  browserId: string;
  source: BrowserDownloadSource;
  /** The agent action that started it. */
  actionId?: string;
  /**
   * Origin and path of the URL only, never the query or fragment. A `blob:`
   * or `data:` URL is given as its scheme only.
   */
  origin: string;
  /** Sanitized and unique within the task's downloads folder. */
  fileName: string;
  mimeType?: string;
  receivedBytes: number;
  totalBytes: number | null;
  status: BrowserTransferStatus;
  /** An interrupted download that can resume in this session. */
  canResume?: boolean;
  error?: BrowserTransferError;
  startedAt: number;
  endedAt?: number;
}

/**
 * A copy of a finished download: `browser.save_download` into the workspace,
 * or Save a copy to a place the user chose. Host-neutral: the destination's
 * absolute path stays in the host.
 */
export interface BrowserCopyTransfer {
  kind: 'copy';
  id: string;
  browserId: string;
  /** The download this copies. */
  sourceId: string;
  /** `agent` for `browser.save_download`, `user` for Save a copy. */
  source: 'user' | 'agent';
  /** The agent action that started it. */
  actionId?: string;
  /**
   * The workspace-relative path for `browser.save_download`, or the chosen
   * file's name for Save a copy.
   */
  destinationName: string;
  copiedBytes: number;
  totalBytes: number;
  /** `in_progress`, `complete`, `cancelled`, or `failed`. A copy never resumes. */
  status: BrowserTransferStatus;
  error?: BrowserTransferError;
  startedAt: number;
  endedAt?: number;
}

export type BrowserUploadStatus =
  | 'staging'
  | 'awaiting_approval'
  | 'attached'
  | 'cancelled'
  | 'denied'
  | 'failed';

/**
 * Files an agent uploads to a page: staged as private copies, approved, then
 * attached to a file input. Host-neutral: the staged paths stay in the host.
 */
export interface BrowserUploadTransfer {
  kind: 'upload';
  id: string;
  browserId: string;
  /** The agent action that started it. */
  actionId?: string;
  /** Origin of the frame that owns the file input. */
  frameOrigin: string;
  /** Origin of the page. */
  topOrigin: string;
  files: Array<{
    name: string;
    /** Workspace-relative path, or `<name> (downloaded)` for a task download. */
    displayPath: string;
    sizeBytes: number;
    /** SHA-256 of the staged bytes, once staging finished. */
    sha256?: string;
  }>;
  stagedBytes: number;
  totalBytes: number;
  /** `attached` is final: page script may already hold the files. */
  status: BrowserUploadStatus;
  error?: BrowserTransferError;
  startedAt: number;
  endedAt?: number;
}

export type BrowserTransfer =
  | BrowserDownloadTransfer
  | BrowserCopyTransfer
  | BrowserUploadTransfer;

export interface BrowserListTransfersRequest {
  browserId: string;
  kind?: BrowserTransfer['kind'];
  /** Matches an upload by the same status name (`cancelled`, `failed`). */
  status?: BrowserTransferStatus;
  offset?: number;
  /** Default 25, maximum 100. */
  limit?: number;
}

export interface BrowserListTransfersResult {
  /** This browser's task's transfers, newest first. */
  transfers: BrowserTransfer[];
  total: number;
  offset: number;
  limit: number;
}

export interface BrowserCancelTransferRequest {
  browserId: string;
  transferId: string;
}

export interface BrowserCancelTransferResult {
  ok: boolean;
  transfer?: BrowserTransfer;
  /** A finished download cancels idempotently: ok, unchanged. */
  error?: BrowserTransferError;
}

/** Files panel commands, sent over one invoke channel. */
export type BrowserTransferCommand =
  | { kind: 'cancel'; browserId: string; transferId: string }
  | { kind: 'resume'; browserId: string; transferId: string }
  | { kind: 'show'; browserId: string; transferId: string }
  /** Opens the save dialog, then copies the finished download there. */
  | { kind: 'save_copy'; browserId: string; transferId: string }
  /** Resolves the finished download for the renderer's attachment import. */
  | { kind: 'attach'; browserId: string; transferId: string }
  | { kind: 'allow_more'; browserId: string };

export interface BrowserTransferCommandResult {
  ok: boolean;
  transfer?: BrowserTransfer;
  error?: BrowserTransferError;
  /** `save_copy`: the user dismissed the save dialog, so nothing was copied. */
  dismissed?: boolean;
  /**
   * `attach` only: a host path for the renderer's attachment import. Never in
   * a transfer record and never sent to an agent.
   */
  attachPath?: string;
}

export interface BrowserSaveDownloadRequest {
  browserId: string;
  downloadId: string;
  /** Relative to the root of the workspace the browser's task belongs to. */
  path: string;
  /** Replace a file that already has the name. Never replaces a directory. */
  overwrite?: boolean;
  /** How long to wait for the copy before returning its progress. */
  timeoutMs?: number;
  /** The chat whose approval session decides the write. Without it the write is denied. */
  approvalChat?: { projectId: string; worktreeId: string; chatId: string };
}

export interface BrowserSaveDownloadResult {
  ok: boolean;
  /** The copy: final, or its latest progress when `timeoutMs` passed first. */
  transfer?: BrowserCopyTransfer;
  error?: BrowserTransferError;
}

export interface BrowserSavePdfResult {
  ok: boolean;
  /** The PDF, a finished `print` download in the task's files. */
  transfer?: BrowserDownloadTransfer;
  error?: BrowserTransferError;
}

// ---------------------------------------------------------------------------
// Preload bridge surface
// ---------------------------------------------------------------------------

/**
 * Renderer-facing in-app browser API exposed at `window.api.browser`. Each
 * method wraps the matching `IPC_CHANNELS.browser*` `ipcRenderer.invoke`
 * channel; `onEvent` subscribes to the `IPC_CHANNELS.browserEvent` push
 * channel and returns an unsubscribe function, matching the existing preload
 * event-subscription conventions.
 *
 * Wired onto {@link Window['api']} in the desktop-app preload (`index.d.ts`
 * re-exports this surface and the bridge is implemented in `preload/index.ts`).
 */
export interface BrowserApi {
  profiles: BrowserProfilesApi;
  switchProfile(
    request: BrowserProfileSwitchRequest,
  ): Promise<BrowserProfileSwitchResult>;
  create(request: BrowserCreateRequest): Promise<BrowserSessionSnapshot>;
  destroy(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
  }): Promise<void>;
  disposeLiveView(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
  }): Promise<void>;
  loadWorktreeState(request: {
    projectId: string;
    worktreeId: string;
  }): Promise<LoadWorktreeBrowserStateResponse>;
  saveWorktreeState(request: SaveWorktreeBrowserStateRequest): Promise<void>;
  setActive(request: BrowserSetActiveRequest): Promise<void>;
  setBounds(request: BrowserSetBoundsRequest): Promise<void>;
  setVisible(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
    visible: boolean;
  }): Promise<void>;
  navigate(request: BrowserNavigateRequest): Promise<BrowserSessionSnapshot>;
  back(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
  }): Promise<BrowserSessionSnapshot>;
  forward(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
  }): Promise<BrowserSessionSnapshot>;
  reload(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
  }): Promise<BrowserSessionSnapshot>;
  stop(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
  }): Promise<BrowserSessionSnapshot>;
  setTheme(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
    themeMode: BrowserThemeMode;
  }): Promise<BrowserSessionSnapshot>;
  setPickMode(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
    enabled: boolean;
  }): Promise<BrowserSessionSnapshot>;
  startRecording(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
  }): Promise<BrowserSessionSnapshot>;
  stopRecording(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
  }): Promise<BrowserRecordingResult>;
  clearRecording(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
  }): Promise<void>;
  getRecording(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
  }): Promise<BrowserRecordingResult>;
  /**
   * Starts or continues a native find in the page (CAN-3048). Resolves with
   * the Electron request id that the matching `find-result` events carry.
   * Rejects for empty or whitespace-only text and for unavailable pages.
   */
  findInPage(request: BrowserFindInPageRequest): Promise<number>;
  /** Ends the page's native find and applies `action` to the active match. */
  stopFindInPage(request: BrowserStopFindInPageRequest): Promise<void>;
  /**
   * Always-external, never rerouted. Authentication hand-offs and explicit
   * "open in external browser" actions stay on this fail-closed path so a new
   * caller that forgets to opt in goes external, which is the safe direction.
   *
   * http(s) URLs ignore `browserId`. A `file:` URL is accepted only with the
   * `browserId` of the tab whose current page it is, and opens in the default
   * web browser, never the file type's registered handler.
   */
  openExternal(request: { url: string; browserId?: string }): Promise<void>;
  /**
   * Ordinary app content link: honors `openAppLinksInBuiltInBrowser` and may
   * be routed into the selected worktree's built-in browser.
   */
  openLink(request: { url: string }): Promise<void>;
  /**
   * Main-window renderer report of whether the link context menu may offer
   * "Open in browser" (a worktree is selected on the main page).
   */
  reportLinkBrowserTarget(request: { available: boolean }): void;
  /**
   * Answers an `app-link-open-requested` or `settings-link-open-requested`
   * push event.
   */
  resolveOpenLinkRequest(
    request: BrowserOpenLinkRequestResolution,
  ): Promise<boolean>;
  /** Verified OS default-browser registration state for Settings. */
  getDefaultRegistrationStatus(): Promise<DefaultBrowserRegistrationStatus>;
  onDefaultRegistrationStatusChanged(
    listener: (status: DefaultBrowserRegistrationStatus) => void,
  ): () => void;
  getConsole(request: BrowserGetConsoleRequest): Promise<BrowserConsoleEntry[]>;
  getNetwork(request: BrowserGetNetworkRequest): Promise<BrowserNetworkEntry[]>;
  screenshot(
    request: BrowserScreenshotRequest,
  ): Promise<{ attachmentPath?: string; dataUrl?: string }>;
  inputSnapshot(
    request: BrowserInputSnapshotRequest,
  ): Promise<BrowserInputSnapshotResponse>;
  inspect(request: BrowserInspectRequest): Promise<BrowserElementSnapshot>;
  getDialog(request: {
    browserId: string;
    expectedRuntimeGeneration?: number;
  }): Promise<BrowserJavaScriptDialog | null>;
  handleDialog(
    request: BrowserHandleJavaScriptDialogRequest,
  ): Promise<BrowserHandleJavaScriptDialogResponse>;
  automation(
    request: BrowserAutomationRequest,
  ): Promise<BrowserAutomationResponse>;
  listTransfers(
    request: BrowserListTransfersRequest,
  ): Promise<BrowserListTransfersResult>;
  transferCommand(
    command: BrowserTransferCommand,
  ): Promise<BrowserTransferCommandResult>;
  saveDownload(
    request: BrowserSaveDownloadRequest,
  ): Promise<BrowserSaveDownloadResult>;
  /** The user answers a pending chooser from its banner. */
  answerFileChooser(
    request: BrowserAnswerFileChooserRequest,
  ): Promise<{ ok: boolean }>;
  /** The browser's pending file chooser, if one waits. */
  getFileChooser(request: {
    browserId: string;
  }): Promise<BrowserFileChooser | null>;
  savePdf(request: BrowserSavePdfRequest): Promise<BrowserSavePdfResult>;
  /** The browser's pending print request, if one waits. */
  getPrintRequest(request: {
    browserId: string;
  }): Promise<BrowserPrintRequest | null>;
  answerPrintRequest(
    request: BrowserAnswerPrintRequestRequest,
  ): Promise<BrowserAnswerPrintRequestResult>;
  /** The browser's pending sign-in, if one waits. */
  getAuthRequest(request: {
    browserId: string;
  }): Promise<BrowserAuthRequest | null>;
  /** The user's answer from the credentials dialog, or a cancel. */
  answerAuthRequest(
    request: BrowserAnswerAuthRequestRequest,
  ): Promise<{ ok: boolean }>;
  onEvent(listener: (event: BrowserServiceEvent) => void): () => void;
}
export interface BrowserProfileSwitchResult {
  status:
    | 'complete'
    | 'cancelled'
    | 'source_reloaded_after_failure'
    | 'pending';
  browser: BrowserSessionSnapshot;
  message?: string;
  operationId?: string;
  dialog?: BrowserJavaScriptDialog;
}
