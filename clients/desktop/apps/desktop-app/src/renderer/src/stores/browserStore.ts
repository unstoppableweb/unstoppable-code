// ---------------------------------------------------------------------------
// In-app browser store (renderer-only, per-worktree)
// ---------------------------------------------------------------------------
//
// Owns the renderer-side state for the repeatable Browser panels:
//   - the flat ordered session list per worktree (`browserOrder`) and the
//     explicitly active session (`activeBrowserId`)
//   - authoritative `BrowserSessionSnapshot` mirror per browser id
//   - lazy hydration of persisted worktree browser state (restored as inert
//     entries; a live `WebContentsView` is (re)created when a visible
//     `BrowserPane` mounts — see `ensureLiveView`)
//   - bounded console / network / recording ring buffers per browser
//   - inspector visibility + selected inspector tab per browser
//
// The main process owns the authoritative session table AND its persistence;
// this store mirrors it from `browser:event` snapshots and IPC responses.
// Panel placement is persisted separately in `panel-layout.json`; permanent
// destruction is driven by the panel lifecycle coordinator
// (`lib/panels/browser-panel-sync.ts`) calling `destroyBrowser`.

import { create } from 'zustand';
import type {
  BrowserConsoleEntry,
  BrowserDownloadTransfer,
  BrowserFileChooser,
  BrowserPrintRequest,
  BrowserAuthRequest,
  BrowserHandoff,
  BrowserHandoffEvent,
  BrowserHandoffHydration,
  BrowserJavaScriptDialog,
  BrowserNetworkEntry,
  BrowserRecordingResult,
  BrowserRecordingStep,
  BrowserSearchEngine,
  BrowserSessionSnapshot,
  BrowserThemeMode,
  BrowserTransfer,
  BrowserTransferCommand,
  BrowserTransferCommandResult,
  LoadWorktreeBrowserStateResponse,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_BROWSER_SEARCH_ENGINE_ID,
  resolveBrowserSearchEngine,
} from '@canopy/desktop-shared/lib/browser-search-engines';
import { isInAppBrowserAvailable } from '@/lib/remote-control/in-app-browser-availability';
import { isWebCoreScope } from '@/lib/chat-authority';
import { webCoreUnavailable } from '@/stores/chat/web-core/web-core-chat-backend';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ring-buffer cap for console entries (mirrors the backend cap). */
const MAX_CONSOLE_ENTRIES = 500;
/** Ring-buffer cap for network entries (mirrors the backend cap). */
const MAX_NETWORK_ENTRIES = 1000;
/** Ring-buffer cap for recording steps (mirrors the backend cap). */
const MAX_RECORDING_STEPS = 1000;
/** Transfers kept per browser (the largest page `listTransfers` returns). */
const MAX_TRANSFERS = 100;

/** Inspector sub-panels, in display (tab) order. */
export type BrowserInspectorTabId =
  | 'console'
  | 'network'
  | 'recording'
  | 'snapshots'
  | 'files';

export const DEFAULT_BROWSER_INSPECTOR_TAB: BrowserInspectorTabId = 'console';

/** A captured screenshot surfaced in the inspector's Snapshots panel. */
export interface BrowserScreenshotEntry {
  id: string;
  filename: string;
  attachmentPath?: string;
  dataUrl?: string;
  capturedAt: number;
  /** Whether this snapshot has already been staged on the chat draft. */
  attached: boolean;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-worktree browser session state: the normalized flat order, the
 * explicitly active session, the snapshot mirror, and which sessions have a
 * live `WebContentsView` right now.
 */
export interface WorktreeBrowserBucket {
  /** Browser ids in stable order (mirrors persisted `browserOrder`). */
  browserOrder: string[];
  /** Explicitly active browser id, or `null` when none was ever selected. */
  activeBrowserId: string | null;
  /** Authoritative-ish snapshot mirror keyed by browser id. */
  browsers: Record<string, BrowserSessionSnapshot>;
  /** Browser ids with a live `WebContentsView` right now. */
  live: ReadonlySet<string>;
  /** Renderer has been rehydrated from persisted worktree state. */
  hydrated: boolean;
  /** Present when the last hydration attempt failed (corrupt/future state). */
  hydrationError?: string;
}

/**
 * Renderer mirror of main's pending browser handoff for one worktree. Main owns
 * the lifecycle; `revision` orders hydration against live events so an older
 * snapshot can never resurrect a released handoff.
 */
export interface BrowserHandoffMirror {
  handoff: BrowserHandoff | null;
  revision: number;
}

/** How a handoff event changed the mirror. Only `requested` may draw focus. */
export type BrowserHandoffEventOutcome =
  | 'requested'
  | 'duplicate'
  | 'released'
  | 'ignored';

export interface OpenBrowserOptions {
  url?: string;
  themeMode?: BrowserThemeMode;
  /** An id main allocated for the tab, as for a page's new-window open. */
  browserId?: string;
}

interface BrowserState {
  /** Current global URL policy preference for in-app browser navigation. */
  localServersOnly: boolean;
  /**
   * Routes ordinary app content links into the selected worktree's built-in
   * browser. Authentication and explicit external actions bypass it.
   */
  openAppLinksInBuiltInBrowser: boolean;
  /** Asks the OS to make this app the default browser for other apps' links. */
  useAsSystemDefaultBrowser: boolean;
  /** The Browser bar's search engine: a built-in id or a custom engine's. */
  searchEngineId: string;
  /** Search engines the user added in Settings → Browser. */
  customSearchEngines: readonly BrowserSearchEngine[];
  browserPreferencesLoaded: boolean;
  /** Keyed by `${projectId}/${worktreeId}`. */
  worktrees: Record<string, WorktreeBrowserBucket>;
  /** Console ring buffers keyed by browser id. */
  consoleEntries: Record<string, BrowserConsoleEntry[]>;
  /** Network ring buffers keyed by browser id (upserted by `requestId`). */
  networkEntries: Record<string, BrowserNetworkEntry[]>;
  /** Recording state keyed by browser id. */
  recordings: Record<string, BrowserRecordingResult>;
  /** Captured screenshots keyed by browser id (newest last). */
  screenshots: Record<string, BrowserScreenshotEntry[]>;
  /** App-owned JavaScript dialogs currently blocking a browser page. */
  dialogs: Record<string, BrowserJavaScriptDialog>;
  /** File choosers an agent's action opened, waiting for an answer. */
  fileChoosers: Record<string, BrowserFileChooser>;
  /** Prints a page asked for during an agent's action, waiting for an answer. */
  printRequests: Record<string, BrowserPrintRequest>;
  /** HTTP sign-ins a page waits on, for the user to answer. */
  authRequests: Record<string, BrowserAuthRequest>;
  /** Inspector visibility keyed by browser id. */
  inspectorOpen: Record<string, boolean>;
  /** Selected inspector tab keyed by browser id. */
  inspectorTab: Record<string, BrowserInspectorTabId>;
  /** Last viewed diagnostic timestamps keyed by browser id. */
  diagnosticsSeenAt: Record<string, { console?: number; network?: number }>;
  /**
   * This browser's task transfers keyed by browser id, newest first. Kept
   * across a profile switch: a record belongs to the task, and its owner was
   * captured when the download started.
   */
  transfers: Record<string, BrowserTransfer[]>;
  /** Blocked automatic downloads awaiting **Allow more downloads**. */
  blockedDownloads: Record<string, number>;
  /** The download whose completion the pane is announcing. */
  downloadToasts: Record<string, BrowserDownloadTransfer>;
  /**
   * Browser ids whose backend session is still being created (a renderer
   * `openBrowser`, a main-driven agent open, or an `ensureLiveView`
   * rematerialization). Their panes show the opening spinner.
   */
  openingBrowserIds: Readonly<Record<string, true>>;
  /** Pending handoffs keyed by `${projectId}/${worktreeId}` (main-owned). */
  browserHandoffs: Readonly<Record<string, BrowserHandoffMirror>>;

  // -- Hydration -------------------------------------------------------------
  hydrateWorktree: (projectId: string, worktreeId: string) => Promise<void>;
  /**
   * Re-runs a failed hydration. Clears/replaces the recorded error only when
   * hydration succeeds, then completes any pending panel-layout migration
   * recovery for the worktree (see `setBrowserHydrationRecoveryHandler`).
   */
  retryHydration: (projectId: string, worktreeId: string) => Promise<void>;
  loadBrowserPreferences: () => Promise<void>;
  setLocalServersOnly: (enabled: boolean) => void;
  setOpenAppLinksInBuiltInBrowser: (enabled: boolean) => void;
  setUseAsSystemDefaultBrowser: (enabled: boolean) => void;
  /** Mirrors the saved search engine choice and the user's own engines. */
  applySearchPreferences: (
    preferences: Pick<
      PreferencesData,
      'inAppBrowserSearchEngineId' | 'inAppBrowserCustomSearchEngines'
    >,
  ) => void;

  // -- Session lifecycle -----------------------------------------------------
  /**
   * Creates a new backend browser session and mirrors it locally only after
   * backend success. Never introduces duplicate `browserOrder` entries.
   */
  createBrowser: (
    projectId: string,
    worktreeId: string,
    options?: { url?: string; themeMode?: BrowserThemeMode },
  ) => Promise<BrowserSessionSnapshot>;
  /**
   * Renderer-first open: publishes a placeholder session (URL prefilled)
   * under a fresh id synchronously, so a bound panel can be placed on the
   * same frame as the click, then creates the backend session in the
   * background. `ready` resolves to the live snapshot, or `null` when the
   * open was cancelled (the tab was closed) or failed (the placeholder then
   * carries `status: 'failed'` and `lastError`). `ready` never rejects.
   * Returns `null`, opening nothing, where the in-app browser is unavailable
   * (a window that shows another computer).
   */
  openBrowser: (
    projectId: string,
    worktreeId: string,
    options?: OpenBrowserOptions,
  ) => PendingBrowserOpen | null;
  /**
   * Publishes a placeholder for a session the MAIN process is creating
   * (agent `browser.open`), announced by an `open-pending` push event. The
   * matching `open-requested` event (or `destroyed` on failure) settles it
   * through {@link BrowserState.settleExternalBrowserOpen}.
   */
  trackExternalBrowserOpen: (target: {
    projectId: string;
    worktreeId: string;
    browserId: string;
    url?: string;
  }) => void;
  /** Settles an open tracked by {@link BrowserState.trackExternalBrowserOpen}. */
  settleExternalBrowserOpen: (browserId: string) => void;
  /**
   * The user submitted `url` in a tab whose session does not exist yet: show
   * it loading now. Blank snapshots from the in-flight create keep showing it
   * until the navigation reports a real URL or fails. Returns whether the
   * navigation was recorded (false for a live tab, which navigates directly).
   */
  startPendingNavigation: (browserId: string, url: string) => boolean;
  /** Drops a pending navigation that never reached the backend. */
  clearPendingNavigation: (browserId: string) => void;
  /**
   * Permanently destroys exactly the given session (exact-ID, idempotent).
   * Local snapshot + keyed UI state are removed after the backend confirms
   * (destroy errors for an already-gone session are treated as success).
   */
  destroyBrowser: (
    projectId: string,
    worktreeId: string,
    browserId: string,
  ) => Promise<void>;
  /**
   * Explicitly selects (or clears, with `null`) the worktree's active
   * browser. Deduplicates repeated selections; a failed IPC call does not
   * claim durable success, so the next focus event naturally retries.
   */
  setActiveBrowser: (
    projectId: string,
    worktreeId: string,
    browserId: string | null,
  ) => Promise<void>;
  /**
   * Release every native view owned by a worktree while retaining the
   * persisted browser metadata. Used when the last Browser panel for the
   * worktree unmounts so reopening can recreate fresh views without leaving
   * Chromium renderer processes behind.
   */
  releaseWorktreeViews: (projectId: string, worktreeId: string) => void;
  /**
   * Ensure a live `WebContentsView` exists for a (persisted or freshly
   * created) browser id, recreating it via `browser.create` reusing the same
   * id so saved panel/session references stay valid. Exact-ID; call only for
   * visible panes or explicit actions that require a view.
   */
  ensureLiveView: (
    projectId: string,
    worktreeId: string,
    browserId: string,
  ) => Promise<void>;
  /**
   * Mirrors a main-supplied snapshot into the bucket (open-requested push
   * events), appending it to `browserOrder` when new. Marks the id live.
   */
  registerBrowserSnapshot: (snapshot: BrowserSessionSnapshot) => void;
  /**
   * Drops one session's local snapshot, order entry, live flag, and keyed UI
   * state WITHOUT calling the backend (used after backend-confirmed
   * destruction and for independent `destroyed` push events).
   */
  dropBrowserSession: (
    projectId: string,
    worktreeId: string,
    browserId: string,
  ) => void;
  /**
   * Forgets everything held for a worktree, WITHOUT calling the backend, so
   * its next mount hydrates from persisted state again. Used when main may
   * replace that state while the worktree is unmounted (a shared container
   * viewer reset): sessions kept here would otherwise be rebound into the
   * restored layout.
   */
  forgetWorktree: (projectId: string, worktreeId: string) => void;
  /**
   * Dev-server / link `Open`: opens a new tab with the URL prefilled through
   * {@link BrowserState.openBrowser}. Returns synchronously with the targeted
   * browser id (for immediate exact-ID panel activation), whether this call
   * created it (for safe rollback), and the background `ready` promise, or
   * `null` where the in-app browser is unavailable.
   */
  openUrlFromDevServer: (
    projectId: string,
    worktreeId: string,
    hit: { url: string; label?: string },
  ) => {
    browserId: string;
    createdNewSession: boolean;
    ready: Promise<BrowserSessionSnapshot | null>;
  } | null;

  // -- Event ingestion (from `browser:event`) --------------------------------
  applySnapshot: (snapshot: BrowserSessionSnapshot) => void;
  appendConsoleEntry: (browserId: string, entry: BrowserConsoleEntry) => void;
  upsertNetworkEntry: (browserId: string, entry: BrowserNetworkEntry) => void;
  appendRecordingStep: (browserId: string, step: BrowserRecordingStep) => void;
  setRecordingState: (browserId: string, recording: boolean) => void;
  setRecordingResult: (
    browserId: string,
    result: BrowserRecordingResult,
  ) => void;
  setDialog: (browserId: string, dialog: BrowserJavaScriptDialog) => void;
  clearDialog: (browserId: string, dialogId?: string) => void;
  setFileChooser: (
    browserId: string,
    chooser: BrowserFileChooser | null,
  ) => void;
  setPrintRequest: (
    browserId: string,
    request: BrowserPrintRequest | null,
  ) => void;
  setAuthRequest: (
    browserId: string,
    request: BrowserAuthRequest | null,
  ) => void;

  // -- Diagnostics controls --------------------------------------------------
  clearConsole: (browserId: string) => void;
  clearNetwork: (browserId: string) => void;
  clearRecording: (browserId: string) => void;
  acknowledgeConsoleErrors: (browserId: string) => void;
  acknowledgeNetworkFailures: (browserId: string) => void;

  // -- Screenshots -----------------------------------------------------------
  addScreenshot: (browserId: string, entry: BrowserScreenshotEntry) => void;
  markScreenshotAttached: (browserId: string, screenshotId: string) => void;
  removeScreenshot: (browserId: string, screenshotId: string) => void;

  // -- Handoffs --------------------------------------------------------------
  /** Applies a live handoff push event; never focuses anything itself. */
  applyBrowserHandoffEvent: (
    event: BrowserHandoffEvent,
  ) => BrowserHandoffEventOutcome;
  /** Restores protection from hydration without replaying any focus. */
  applyBrowserHandoffHydration: (
    projectId: string,
    worktreeId: string,
    hydration: BrowserHandoffHydration,
  ) => void;

  // -- Inspector UI ----------------------------------------------------------
  setInspectorOpen: (browserId: string, open: boolean) => void;
  toggleInspector: (browserId: string) => void;
  setInspectorTab: (browserId: string, tab: BrowserInspectorTabId) => void;
  /** Opens the inspector on the Files tab (the browser bar's Downloads). */
  openFilesPanel: (browserId: string) => void;

  // -- Transfers ---------------------------------------------------------------
  /** Loads this browser's transfers from main and merges live updates. */
  hydrateTransfers: (browserId: string) => Promise<void>;
  /** Applies a `transfer` event or a command result. */
  upsertTransfer: (browserId: string, transfer: BrowserTransfer) => void;
  noteDownloadsBlocked: (browserId: string, blockedCount: number) => void;
  dismissDownloadsBlocked: (browserId: string) => void;
  /** Resets the page's download rate window and clears the notice. */
  allowMoreDownloads: (browserId: string) => Promise<void>;
  dismissDownloadToast: (browserId: string, transferId: string) => void;
  runTransferCommand: (
    command: BrowserTransferCommand,
  ) => Promise<BrowserTransferCommandResult>;
}

/** Result of {@link BrowserState.openBrowser}. */
export interface PendingBrowserOpen {
  browserId: string;
  /** Live snapshot once the backend session exists; `null` if cancelled/failed. */
  ready: Promise<BrowserSessionSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hydrationPromises = new Map<string, Promise<void>>();

/**
 * Backend creations for placeholder sessions, keyed by browser id. `cancelled`
 * is set synchronously by `destroyBrowser` so a create that has not been sent
 * yet is never sent (a destroy that reaches main first would otherwise be
 * followed by a create nobody wants). `settled` resolves when the backend
 * session exists or the open ends.
 */
interface PendingOpenRecord {
  cancelled: boolean;
  settled: Promise<void>;
  settle: () => void;
}
const pendingOpens = new Map<string, PendingOpenRecord>();

function newPendingOpenRecord(): PendingOpenRecord {
  let settle = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { cancelled: false, settled, settle };
}

/** Whether this placeholder browser was closed while it was still opening. */
export function isBrowserOpenCancelled(browserId: string): boolean {
  return pendingOpens.get(browserId)?.cancelled === true;
}

/** Session shown while the backend creates it: URL prefilled, not live. */
function placeholderSnapshot(
  projectId: string,
  worktreeId: string,
  browserId: string,
  url: string,
  themeMode: BrowserThemeMode | undefined,
): BrowserSessionSnapshot {
  const createdAt = Date.now();
  const hasUrl = url.length > 0 && url !== 'about:blank';
  return {
    id: browserId,
    projectId,
    worktreeId,
    createdAt,
    updatedAt: createdAt,
    url,
    title: '',
    status: hasUrl ? 'loading' : 'idle',
    canGoBack: false,
    canGoForward: false,
    loading: hasUrl,
    themeMode: themeMode ?? 'light',
    pickMode: false,
    recording: false,
  };
}

/**
 * URLs submitted in tabs whose session did not exist yet, keyed by browser id.
 * Blank snapshots (the session being created without a URL) must not replace
 * the submitted URL and its loading state before the navigation lands.
 */
const pendingNavigations = new Map<string, string>();

function isBlankBrowserUrl(url: string): boolean {
  return url.length === 0 || url === 'about:blank';
}

/**
 * The latest URL submitted before the session existed that is still waiting
 * to be loaded. Undefined once a snapshot reported that URL (or its failure),
 * i.e. the session's own create already loaded it.
 */
export function pendingBrowserNavigationUrl(
  browserId: string,
): string | undefined {
  return pendingNavigations.get(browserId);
}

/** Keeps a submitted URL visible over a blank snapshot; clears it otherwise. */
function withPendingNavigation(
  snapshot: BrowserSessionSnapshot,
): BrowserSessionSnapshot {
  const url = pendingNavigations.get(snapshot.id);
  if (url === undefined) {
    return snapshot;
  }
  if (
    snapshot.url === url ||
    (snapshot.status === 'failed' && isBlankBrowserUrl(snapshot.url))
  ) {
    // The session loaded (or failed to load) the submitted URL itself, or
    // the session could not be created at all.
    pendingNavigations.delete(snapshot.id);
    return snapshot;
  }
  if (!isBlankBrowserUrl(snapshot.url)) {
    // A different page (the tab's original URL) is loading; the submitted
    // URL is navigated once the session exists.
    return snapshot;
  }
  return { ...snapshot, url, status: 'loading', loading: true };
}

function withOpening(
  opening: Readonly<Record<string, true>>,
  browserId: string,
  isOpening: boolean,
): Readonly<Record<string, true>> {
  if ((opening[browserId] === true) === isOpening) {
    return opening;
  }
  const next = { ...opening };
  if (isOpening) {
    next[browserId] = true;
  } else {
    delete next[browserId];
  }
  return next;
}
interface ActiveSelectionCoordinator {
  /** Last value confirmed by the main-process persistence authority. */
  confirmedValue: string | null;
  /** Latest optimistic renderer request. */
  latestValue: string | null;
  latestOk: boolean;
  latestPending: boolean;
  sequence: number;
  /** Serializes IPC writes so an older slow write cannot win last. */
  tail: Promise<void>;
}

const activeSelectionCoordinators = new Map<
  string,
  ActiveSelectionCoordinator
>();
const ensureViewPromises = new Map<
  string,
  { epoch: number; promise: Promise<void> }
>();
const liveViewEpochs = new Map<string, number>();
const releaseViewPromises = new Map<string, Promise<void>>();

function activeSelectionCoordinatorFor(
  key: string,
  initialValue: string | null,
): ActiveSelectionCoordinator {
  let coordinator = activeSelectionCoordinators.get(key);
  if (coordinator === undefined) {
    coordinator = {
      confirmedValue: initialValue,
      latestValue: initialValue,
      latestOk: true,
      latestPending: false,
      sequence: 0,
      tail: Promise.resolve(),
    };
    activeSelectionCoordinators.set(key, coordinator);
  }
  return coordinator;
}

function browserSearchPreferences(
  preferences: Pick<
    PreferencesData,
    'inAppBrowserSearchEngineId' | 'inAppBrowserCustomSearchEngines'
  >,
): Pick<BrowserState, 'searchEngineId' | 'customSearchEngines'> {
  return {
    searchEngineId:
      preferences.inAppBrowserSearchEngineId ??
      DEFAULT_BROWSER_SEARCH_ENGINE_ID,
    customSearchEngines: preferences.inAppBrowserCustomSearchEngines ?? [],
  };
}

/** The engine the Browser bar searches with, falling back to Google. */
export function selectActiveSearchEngine(
  state: Pick<BrowserState, 'searchEngineId' | 'customSearchEngines'>,
): BrowserSearchEngine {
  return resolveBrowserSearchEngine(
    state.searchEngineId,
    state.customSearchEngines,
  );
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function emptyBucket(): WorktreeBrowserBucket {
  return {
    browserOrder: [],
    activeBrowserId: null,
    browsers: {},
    live: new Set<string>(),
    hydrated: false,
  };
}

function withLive(
  live: ReadonlySet<string>,
  browserId: string,
  isLive: boolean,
): ReadonlySet<string> {
  if (live.has(browserId) === isLive) {
    return live;
  }
  const next = new Set(live);
  if (isLive) {
    next.add(browserId);
  } else {
    next.delete(browserId);
  }
  return next;
}

/** Restores a persisted snapshot as an inert entry (no live view yet). */
function inertSnapshot(
  snapshot: BrowserSessionSnapshot,
): BrowserSessionSnapshot {
  return {
    ...snapshot,
    status: 'idle',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    pickMode: false,
    recording: false,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback;
}

/** Find the `${projectId}/${worktreeId}` bucket containing a browser id. */
export function findWorktreeKeyForBrowser(
  state: Pick<BrowserState, 'worktrees'>,
  browserId: string,
): string | null {
  for (const [key, bucket] of Object.entries(state.worktrees)) {
    if (bucket.browsers[browserId] !== undefined) {
      return key;
    }
  }
  return null;
}

function ringPush<T>(buffer: T[] | undefined, entry: T, max: number): T[] {
  const next = buffer ? [...buffer, entry] : [entry];
  if (next.length > max) {
    return next.slice(next.length - max);
  }
  return next;
}

function emptyRecording(browserId: string): BrowserRecordingResult {
  return {
    browserId,
    recording: false,
    steps: [],
    playwrightScript: '',
  };
}

function disposeBrowserView(browserId: string): Promise<void> {
  void window.api.browser
    .setVisible({ browserId, visible: false })
    .catch(() => undefined);
  return new Promise((resolve) => {
    setTimeout(() => {
      void window.api.browser
        .disposeLiveView({ browserId })
        .catch(() => undefined)
        .finally(resolve);
    }, 0);
  });
}
/** Records a failed backend create on its placeholder (kept, not live). */
function markBrowserOpenFailed(
  key: string,
  browserId: string,
  message: string,
): void {
  // The submitted URL stays on the tab, so Retry opens it.
  pendingNavigations.delete(browserId);
  useBrowserStore.setState((state) => {
    const bucket = state.worktrees[key];
    const snapshot = bucket?.browsers[browserId];
    if (!bucket || snapshot === undefined) {
      return state;
    }
    return {
      worktrees: {
        ...state.worktrees,
        [key]: {
          ...bucket,
          browsers: {
            ...bucket.browsers,
            [browserId]: {
              ...snapshot,
              status: 'failed',
              loading: false,
              lastError: message,
              updatedAt: Date.now(),
            },
          },
          live: withLive(bucket.live, browserId, false),
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Migration-recovery seam
// ---------------------------------------------------------------------------

type HydrationRecoveryHandler = (
  projectId: string,
  worktreeId: string,
) => Promise<void>;

let hydrationRecoveryHandler: HydrationRecoveryHandler | null = null;

/**
 * Installed by the browser panel-layout migration module so a successful
 * hydration Retry also completes any pending migration recovery (rebinding
 * the recovery placeholder panel and resuming layout persistence).
 */
export function setBrowserHydrationRecoveryHandler(
  handler: HydrationRecoveryHandler | null,
): void {
  hydrationRecoveryHandler = handler;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useBrowserStore = create<BrowserState>((set, get) => ({
  localServersOnly: false,
  openAppLinksInBuiltInBrowser: true,
  useAsSystemDefaultBrowser: false,
  searchEngineId: DEFAULT_BROWSER_SEARCH_ENGINE_ID,
  customSearchEngines: [],
  browserPreferencesLoaded: false,
  worktrees: {},
  consoleEntries: {},
  networkEntries: {},
  recordings: {},
  screenshots: {},
  dialogs: {},
  fileChoosers: {},
  printRequests: {},
  authRequests: {},
  inspectorOpen: {},
  inspectorTab: {},
  diagnosticsSeenAt: {},
  transfers: {},
  blockedDownloads: {},
  downloadToasts: {},
  openingBrowserIds: {},
  browserHandoffs: {},

  loadBrowserPreferences: async (): Promise<void> => {
    if (get().browserPreferencesLoaded) {
      return;
    }
    try {
      const preferences = await window.api.loadPreferences();
      set({
        localServersOnly: preferences.inAppBrowserLocalServersOnly === true,
        openAppLinksInBuiltInBrowser:
          preferences.openAppLinksInBuiltInBrowser === true,
        useAsSystemDefaultBrowser:
          preferences.useAsSystemDefaultBrowser === true,
        ...browserSearchPreferences(preferences),
        browserPreferencesLoaded: true,
      });
    } catch {
      set({ browserPreferencesLoaded: true });
    }
  },

  setLocalServersOnly: (enabled): void => {
    set({ localServersOnly: enabled, browserPreferencesLoaded: true });
  },

  setOpenAppLinksInBuiltInBrowser: (enabled): void => {
    set({
      openAppLinksInBuiltInBrowser: enabled,
      browserPreferencesLoaded: true,
    });
  },

  setUseAsSystemDefaultBrowser: (enabled): void => {
    set({
      useAsSystemDefaultBrowser: enabled,
      browserPreferencesLoaded: true,
    });
  },

  applySearchPreferences: (preferences): void => {
    set(browserSearchPreferences(preferences));
  },

  hydrateWorktree: async (projectId, worktreeId): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    if (get().worktrees[key] === undefined) {
      // A genuinely fresh bucket must not inherit settled coordinator state
      // from an earlier lifetime of the same worktree key.
      activeSelectionCoordinators.delete(key);
    }
    let response: LoadWorktreeBrowserStateResponse;
    try {
      // main keeps browser state for local worktrees only; a web core scope
      // has none to restore (CAN-6175 D1).
      response = isWebCoreScope(projectId)
        ? { status: 'missing', state: null }
        : await window.api.browser.loadWorktreeState({
            projectId,
            worktreeId,
          });
    } catch (error) {
      // Corrupt/future persisted state (or IPC failure). Record the error so
      // Browser surfaces can show the recoverable-hydration-failure state; the
      // persisted file is never rewritten from here.
      const message = errorMessage(
        error,
        'Browser state could not be restored.',
      );
      set((state) => {
        const previous = state.worktrees[key];
        if (previous?.hydrated) {
          return state;
        }
        return {
          worktrees: {
            ...state.worktrees,
            [key]: {
              ...(previous ?? emptyBucket()),
              hydrated: false,
              hydrationError: message,
            },
          },
        };
      });
      return;
    }

    if (response.handoffState !== undefined) {
      get().applyBrowserHandoffHydration(
        projectId,
        worktreeId,
        response.handoffState,
      );
    }

    if (response.status === 'rejected') {
      set((state) => {
        const previous = state.worktrees[key];
        if (previous?.hydrated) {
          return state;
        }
        return {
          worktrees: {
            ...state.worktrees,
            [key]: {
              ...(previous ?? emptyBucket()),
              hydrated: false,
              hydrationError: response.error,
            },
          },
        };
      });
      return;
    }

    set((state) => {
      const previous = state.worktrees[key];
      // Already-live buckets win over a (re)hydrate so we never clobber live
      // session ids; only fill in when nothing is hydrated yet.
      if (previous?.hydrated) {
        return state;
      }
      const persisted = response.state;
      const base = previous ?? emptyBucket();
      if (!persisted) {
        const next: WorktreeBrowserBucket = {
          ...base,
          hydrated: true,
        };
        delete next.hydrationError;
        return { worktrees: { ...state.worktrees, [key]: next } };
      }

      const browsers: Record<string, BrowserSessionSnapshot> = {};
      const browserOrder: string[] = [];
      for (const browserId of persisted.browserOrder) {
        const snapshot = persisted.browsers.find(
          (candidate) => candidate.id === browserId,
        );
        if (snapshot === undefined || browsers[browserId] !== undefined) {
          continue;
        }
        browsers[browserId] = inertSnapshot(snapshot);
        browserOrder.push(browserId);
      }
      // Defensive: keep snapshots the normalized order somehow missed.
      for (const snapshot of persisted.browsers) {
        if (browsers[snapshot.id] === undefined) {
          browsers[snapshot.id] = inertSnapshot(snapshot);
          browserOrder.push(snapshot.id);
        }
      }
      // Sessions created locally before hydration finished stay tracked.
      for (const browserId of base.browserOrder) {
        const pending = base.browsers[browserId];
        if (pending !== undefined && browsers[browserId] === undefined) {
          browsers[browserId] = pending;
          browserOrder.push(browserId);
        }
      }

      // A tab the user just opened (still being created) and selected while
      // hydration ran keeps its selection; it is persisted once it exists.
      const locallyOpenedActive =
        base.activeBrowserId !== null &&
        pendingOpens.has(base.activeBrowserId) &&
        browsers[base.activeBrowserId] !== undefined
          ? base.activeBrowserId
          : null;
      const activeBrowserId =
        locallyOpenedActive ??
        (persisted.activeBrowserId !== null &&
        browsers[persisted.activeBrowserId] !== undefined
          ? persisted.activeBrowserId
          : base.activeBrowserId !== null &&
              browsers[base.activeBrowserId] !== undefined
            ? base.activeBrowserId
            : null);

      const next: WorktreeBrowserBucket = {
        browserOrder,
        activeBrowserId,
        browsers,
        live: base.live,
        hydrated: true,
        ...(response.status === 'fallback'
          ? { hydrationError: response.error }
          : {}),
      };
      return { worktrees: { ...state.worktrees, [key]: next } };
    });
    const coordinator = activeSelectionCoordinators.get(key);
    if (coordinator !== undefined && !coordinator.latestPending) {
      // A fresh authoritative hydration supersedes any settled selection
      // bookkeeping retained for this worktree key.
      activeSelectionCoordinators.delete(key);
    }
  },

  retryHydration: async (projectId, worktreeId): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    await get().hydrateWorktree(projectId, worktreeId);
    const bucket = get().worktrees[key];
    if (!bucket?.hydrated) {
      return;
    }
    // Success: also complete any pending panel-layout migration recovery so
    // the recovery placeholder panel is replaced with real bound panels.
    await hydrationRecoveryHandler?.(projectId, worktreeId);
  },

  createBrowser: async (
    projectId,
    worktreeId,
    options,
  ): Promise<BrowserSessionSnapshot> => {
    if (isWebCoreScope(projectId)) throw webCoreUnavailable('The browser');
    const snapshot = await window.api.browser.create({
      projectId,
      worktreeId,
      ...(options?.url !== undefined && options.url.length > 0
        ? { url: options.url }
        : {}),
      ...(options?.themeMode ? { themeMode: options.themeMode } : {}),
    });
    get().registerBrowserSnapshot(snapshot);
    return snapshot;
  },

  openBrowser: (projectId, worktreeId, options): PendingBrowserOpen | null => {
    // No placeholder for a session that can never be created here: its tab
    // could not render, and its rollback would need the blocked destroy.
    // A web core scope has no main-side browser sessions either.
    if (!isInAppBrowserAvailable() || isWebCoreScope(projectId)) {
      return null;
    }
    const key = worktreeKey(projectId, worktreeId);
    const browserId = options?.browserId ?? crypto.randomUUID();
    const url = options?.url ?? '';
    const record = newPendingOpenRecord();
    pendingOpens.set(browserId, record);
    set((state) => {
      const bucket = state.worktrees[key] ?? emptyBucket();
      return {
        worktrees: {
          ...state.worktrees,
          [key]: {
            ...bucket,
            browserOrder: [...bucket.browserOrder, browserId],
            browsers: {
              ...bucket.browsers,
              [browserId]: placeholderSnapshot(
                projectId,
                worktreeId,
                browserId,
                url,
                options?.themeMode,
              ),
            },
          },
        },
        openingBrowserIds: withOpening(
          state.openingBrowserIds,
          browserId,
          true,
        ),
      };
    });
    // A view created after the worktree released its views (the user left
    // before the backend finished) is disposed again, as in `ensureLiveView`.
    const epoch = liveViewEpochs.get(key) ?? 0;
    const tracked = (): BrowserSessionSnapshot | undefined =>
      get().worktrees[key]?.browsers[browserId];

    const ready = (async (): Promise<BrowserSessionSnapshot | null> => {
      await ensureBrowserWorktreeHydrated(projectId, worktreeId).catch(
        () => undefined,
      );
      if (record.cancelled || tracked() === undefined) {
        return null;
      }
      let snapshot: BrowserSessionSnapshot;
      try {
        snapshot = await window.api.browser.create({
          projectId,
          worktreeId,
          browserId,
          ...(url.length > 0 ? { url } : {}),
          ...(options?.themeMode ? { themeMode: options.themeMode } : {}),
        });
      } catch (error) {
        if (!record.cancelled) {
          markBrowserOpenFailed(
            key,
            browserId,
            errorMessage(error, 'Browser could not be opened.'),
          );
        }
        return null;
      }
      if (record.cancelled || tracked() === undefined) {
        return null;
      }
      if ((liveViewEpochs.get(key) ?? 0) !== epoch) {
        set((state) => {
          const bucket = state.worktrees[key];
          if (!bucket || bucket.browsers[browserId] === undefined) {
            return state;
          }
          return {
            worktrees: {
              ...state.worktrees,
              [key]: {
                ...bucket,
                browsers: {
                  ...bucket.browsers,
                  // Keep a URL the user submitted so the recreated view loads it.
                  [browserId]: inertSnapshot(withPendingNavigation(snapshot)),
                },
                live: withLive(bucket.live, browserId, false),
              },
            },
          };
        });
        await disposeBrowserView(browserId);
        return snapshot;
      }
      get().applySnapshot(snapshot);
      return snapshot;
    })().finally(() => {
      if (pendingOpens.get(browserId) === record) {
        pendingOpens.delete(browserId);
      }
      set((state) => ({
        openingBrowserIds: withOpening(
          state.openingBrowserIds,
          browserId,
          false,
        ),
      }));
      record.settle();
    });
    return { browserId, ready };
  },

  trackExternalBrowserOpen: ({
    projectId,
    worktreeId,
    browserId,
    url,
  }): void => {
    const key = worktreeKey(projectId, worktreeId);
    if (
      pendingOpens.has(browserId) ||
      get().worktrees[key]?.browsers[browserId] !== undefined
    ) {
      return;
    }
    pendingOpens.set(browserId, newPendingOpenRecord());
    set((state) => {
      const bucket = state.worktrees[key] ?? emptyBucket();
      return {
        worktrees: {
          ...state.worktrees,
          [key]: {
            ...bucket,
            browserOrder: [...bucket.browserOrder, browserId],
            browsers: {
              ...bucket.browsers,
              [browserId]: placeholderSnapshot(
                projectId,
                worktreeId,
                browserId,
                url ?? '',
                undefined,
              ),
            },
          },
        },
        openingBrowserIds: withOpening(
          state.openingBrowserIds,
          browserId,
          true,
        ),
      };
    });
  },

  settleExternalBrowserOpen: (browserId): void => {
    const record = pendingOpens.get(browserId);
    if (record === undefined) {
      return;
    }
    pendingOpens.delete(browserId);
    set((state) => ({
      openingBrowserIds: withOpening(state.openingBrowserIds, browserId, false),
    }));
    record.settle();
  },

  startPendingNavigation: (browserId, url): boolean => {
    const key = findWorktreeKeyForBrowser(get(), browserId);
    const bucket = key === null ? undefined : get().worktrees[key];
    const snapshot = bucket?.browsers[browserId];
    if (key === null || !bucket || !snapshot || bucket.live.has(browserId)) {
      return false;
    }
    pendingNavigations.set(browserId, url);
    set((state) => {
      const current = state.worktrees[key];
      const currentSnapshot = current?.browsers[browserId];
      if (!current || currentSnapshot === undefined) {
        return state;
      }
      return {
        worktrees: {
          ...state.worktrees,
          [key]: {
            ...current,
            browsers: {
              ...current.browsers,
              [browserId]: {
                ...currentSnapshot,
                url,
                status: 'loading',
                loading: true,
                lastError: undefined,
                updatedAt: Date.now(),
              },
            },
          },
        },
      };
    });
    return true;
  },

  clearPendingNavigation: (browserId): void => {
    pendingNavigations.delete(browserId);
  },

  destroyBrowser: async (projectId, worktreeId, browserId): Promise<void> => {
    // Closing a tab that is still opening: a create that has not been sent
    // is never sent. One already in flight is cancelled by main's destroy.
    const pendingOpen = pendingOpens.get(browserId);
    if (pendingOpen !== undefined) {
      pendingOpen.cancelled = true;
    }
    // Hide/detach presentation first, then request permanent destruction.
    await window.api.browser
      .setVisible({ browserId, visible: false })
      .catch(() => undefined);
    // The service treats an already-destroyed/unknown id as success. Any
    // rejection is therefore a material persistence/cleanup failure and
    // must leave renderer state intact so destruction remains retryable.
    await window.api.browser.destroy({ browserId });
    get().dropBrowserSession(projectId, worktreeId, browserId);
  },

  setActiveBrowser: async (projectId, worktreeId, browserId): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    const bucket = get().worktrees[key];
    if (browserId !== null && bucket?.browsers[browserId] === undefined) {
      // Unknown ids are not selections. Do not optimistically mutate and do
      // not send a guaranteed-to-reject ownership request to the backend.
      return;
    }
    const pendingOpen =
      browserId !== null ? pendingOpens.get(browserId) : undefined;
    if (browserId !== null && pendingOpen !== undefined) {
      // Main does not know this id until its create lands. Select it locally
      // now and persist once it exists, unless the user moved on meanwhile.
      set((state) => {
        const current = state.worktrees[key];
        if (!current || current.activeBrowserId === browserId) {
          return state;
        }
        return {
          worktrees: {
            ...state.worktrees,
            [key]: { ...current, activeBrowserId: browserId },
          },
        };
      });
      await pendingOpen.settled;
      const settled = get().worktrees[key];
      if (
        settled?.activeBrowserId === browserId &&
        settled.live.has(browserId) &&
        !pendingOpens.has(browserId)
      ) {
        // The local selection above never reached the backend; do not let
        // the dedupe treat it as confirmed.
        const coordinator = activeSelectionCoordinatorFor(key, browserId);
        if (
          coordinator.latestValue === browserId &&
          !coordinator.latestPending
        ) {
          coordinator.latestOk = false;
        }
        await get().setActiveBrowser(projectId, worktreeId, browserId);
      }
      return;
    }
    const coordinator = activeSelectionCoordinatorFor(
      key,
      bucket?.activeBrowserId ?? null,
    );
    if (
      coordinator.latestValue === browserId &&
      (bucket?.activeBrowserId ?? null) === browserId
    ) {
      if (coordinator.latestOk) {
        return;
      }
      if (coordinator.latestPending) {
        // Pointer + focus capture commonly report the same interaction. Share
        // the queued request instead of appending duplicate persistence work.
        return coordinator.tail;
      }
    }
    set((state) => {
      const current = state.worktrees[key] ?? emptyBucket();
      if (current.activeBrowserId === browserId && state.worktrees[key]) {
        return state;
      }
      return {
        worktrees: {
          ...state.worktrees,
          [key]: { ...current, activeBrowserId: browserId },
        },
      };
    });
    const sequence = ++coordinator.sequence;
    coordinator.latestValue = browserId;
    coordinator.latestOk = false;
    coordinator.latestPending = true;

    const request = coordinator.tail.then(() =>
      window.api.browser.setActive({ projectId, worktreeId, browserId }),
    );
    const settled = request.then(
      () => {
        coordinator.confirmedValue = browserId;
        if (coordinator.sequence === sequence) {
          coordinator.latestOk = true;
          coordinator.latestPending = false;
        }
      },
      () => {
        if (coordinator.sequence !== sequence) {
          return;
        }
        // The latest write failed. Restore the last value that actually
        // reached the backend; an earlier queued failure never rolls back a
        // newer optimistic tab selection.
        coordinator.latestOk = false;
        coordinator.latestPending = false;
        const confirmedValue = coordinator.confirmedValue;
        set((state) => {
          const current = state.worktrees[key];
          if (!current || current.activeBrowserId !== browserId) {
            return state;
          }
          const restoredActiveBrowserId =
            confirmedValue === null ||
            current.browsers[confirmedValue] !== undefined
              ? confirmedValue
              : null;
          return {
            worktrees: {
              ...state.worktrees,
              [key]: {
                ...current,
                activeBrowserId: restoredActiveBrowserId,
              },
            },
          };
        });
      },
    );
    coordinator.tail = settled;
    await settled;
  },

  forgetWorktree: (projectId, worktreeId): void => {
    const key = worktreeKey(projectId, worktreeId);
    const bucket = get().worktrees[key];
    if (!bucket) {
      return;
    }
    for (const browserId of Object.keys(bucket.browsers)) {
      get().dropBrowserSession(projectId, worktreeId, browserId);
    }
    set((state) => {
      const worktrees = { ...state.worktrees };
      delete worktrees[key];
      return { worktrees };
    });
    activeSelectionCoordinators.delete(key);
  },

  releaseWorktreeViews: (projectId, worktreeId): void => {
    const key = worktreeKey(projectId, worktreeId);
    const epoch = (liveViewEpochs.get(key) ?? 0) + 1;
    liveViewEpochs.set(key, epoch);

    const bucket = get().worktrees[key];
    if (!bucket) {
      return;
    }
    const browserIds = Object.keys(bucket.browsers);
    if (browserIds.length === 0) {
      return;
    }

    set((state) => {
      const current = state.worktrees[key];
      if (!current) {
        return state;
      }
      return {
        worktrees: {
          ...state.worktrees,
          [key]: {
            ...current,
            live: new Set<string>(),
          },
        },
      };
    });

    const release = Promise.all(
      browserIds.map((browserId) => disposeBrowserView(browserId)),
    ).then(() => {
      // A final native title/load event can publish a snapshot while main
      // persists and closes the views, marking them live again. Complete the
      // release before ensureLiveView checks whether recreation is needed.
      if (liveViewEpochs.get(key) !== epoch) {
        return;
      }
      set((state) => {
        const current = state.worktrees[key];
        if (!current) {
          return state;
        }
        const live = new Set(current.live);
        for (const browserId of browserIds) {
          live.delete(browserId);
        }
        if (live.size === current.live.size) {
          return state;
        }
        return {
          worktrees: { ...state.worktrees, [key]: { ...current, live } },
        };
      });
    });
    releaseViewPromises.set(key, release);
    void release.finally(() => {
      if (releaseViewPromises.get(key) === release) {
        releaseViewPromises.delete(key);
      }
    });
  },

  ensureLiveView: async (projectId, worktreeId, browserId): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    const pendingRelease = releaseViewPromises.get(key);
    if (pendingRelease) {
      await pendingRelease;
    }
    const pendingOpen = pendingOpens.get(browserId);
    if (pendingOpen !== undefined) {
      // The session is being opened; its outcome (live, failed, or closed)
      // is final for this call. A failed open is retried explicitly.
      await pendingOpen.settled;
      return;
    }
    const bucket = get().worktrees[key];
    if (!bucket || bucket.browsers[browserId] === undefined) {
      return;
    }
    if (bucket.live.has(browserId)) {
      return;
    }
    const epoch = liveViewEpochs.get(key) ?? 0;
    const inFlight = ensureViewPromises.get(browserId);
    if (inFlight !== undefined) {
      if (inFlight.epoch === epoch) {
        return inFlight.promise;
      }
      await inFlight.promise;
      return get().ensureLiveView(projectId, worktreeId, browserId);
    }
    const desiredUrl = bucket.browsers[browserId]?.url;
    const themeMode = bucket.browsers[browserId]?.themeMode;
    const request = { epoch, promise: Promise.resolve() };
    set((state) => ({
      openingBrowserIds: withOpening(state.openingBrowserIds, browserId, true),
    }));
    request.promise = (async (): Promise<void> => {
      try {
        const snapshot = await window.api.browser.create({
          projectId,
          worktreeId,
          browserId,
          ...(desiredUrl && desiredUrl.length > 0 ? { url: desiredUrl } : {}),
          ...(themeMode ? { themeMode } : {}),
        });
        if ((liveViewEpochs.get(key) ?? 0) !== epoch) {
          await disposeBrowserView(browserId);
          return;
        }
        get().applySnapshot(snapshot);
      } catch (error) {
        const message = errorMessage(error, 'Browser failed to load.');
        set((state) => {
          const current = state.worktrees[key];
          const currentSnapshot = current?.browsers[browserId];
          if (!current || currentSnapshot === undefined) {
            return state;
          }
          return {
            worktrees: {
              ...state.worktrees,
              [key]: {
                ...current,
                browsers: {
                  ...current.browsers,
                  [browserId]: {
                    ...currentSnapshot,
                    status: 'failed',
                    loading: false,
                    lastError: message,
                    updatedAt: Date.now(),
                  },
                },
                live: withLive(current.live, browserId, false),
              },
            },
          };
        });
      } finally {
        if (ensureViewPromises.get(browserId) === request) {
          ensureViewPromises.delete(browserId);
          set((state) => ({
            openingBrowserIds: withOpening(
              state.openingBrowserIds,
              browserId,
              false,
            ),
          }));
        }
      }
    })();
    ensureViewPromises.set(browserId, request);
    return request.promise;
  },

  registerBrowserSnapshot: (snapshot): void => {
    set((state) => {
      const key = worktreeKey(snapshot.projectId, snapshot.worktreeId);
      const bucket = state.worktrees[key] ?? emptyBucket();
      const browserOrder = bucket.browserOrder.includes(snapshot.id)
        ? bucket.browserOrder
        : [...bucket.browserOrder, snapshot.id];
      return {
        worktrees: {
          ...state.worktrees,
          [key]: {
            ...bucket,
            browserOrder,
            browsers: { ...bucket.browsers, [snapshot.id]: snapshot },
            live: withLive(bucket.live, snapshot.id, true),
          },
        },
      };
    });
  },

  dropBrowserSession: (projectId, worktreeId, browserId): void => {
    set((state) => {
      const key = worktreeKey(projectId, worktreeId);
      const bucket = state.worktrees[key];
      if (!bucket || bucket.browsers[browserId] === undefined) {
        return state;
      }
      const browsers = { ...bucket.browsers };
      delete browsers[browserId];
      const browserOrder = bucket.browserOrder.filter(
        (candidate) => candidate !== browserId,
      );
      const removedIndex = bucket.browserOrder.indexOf(browserId);
      const replacementActiveBrowserId =
        browserOrder[
          Math.min(
            removedIndex >= 0 ? removedIndex : 0,
            browserOrder.length - 1,
          )
        ] ?? null;
      return {
        worktrees: {
          ...state.worktrees,
          [key]: {
            ...bucket,
            browserOrder,
            activeBrowserId:
              bucket.activeBrowserId === browserId
                ? replacementActiveBrowserId
                : bucket.activeBrowserId,
            browsers,
            live: withLive(bucket.live, browserId, false),
          },
        },
        openingBrowserIds: withOpening(
          state.openingBrowserIds,
          browserId,
          false,
        ),
      };
    });
    const pendingOpen = pendingOpens.get(browserId);
    if (pendingOpen !== undefined) {
      pendingOpen.cancelled = true;
      pendingOpens.delete(browserId);
      pendingOpen.settle();
    }
    pendingNavigations.delete(browserId);
    discardDiagnostics(browserId);
    discardTransfers(browserId);
  },

  openUrlFromDevServer: (
    projectId,
    worktreeId,
    hit,
  ): {
    browserId: string;
    createdNewSession: boolean;
    ready: Promise<BrowserSessionSnapshot | null>;
  } | null => {
    // The task default profile is resolved by main for each new logical tab.
    // URL equality alone cannot select an existing tab's account.
    const opened = get().openBrowser(projectId, worktreeId, { url: hit.url });
    return opened === null ? null : { ...opened, createdNewSession: true };
  },

  applySnapshot: (incoming): void => {
    const snapshot = withPendingNavigation(incoming);
    const current =
      get().worktrees[worktreeKey(snapshot.projectId, snapshot.worktreeId)]
        ?.browsers[snapshot.id];
    if (
      current?.profile &&
      (!snapshot.profile ||
        snapshot.profile.runtimeGeneration < current.profile.runtimeGeneration)
    )
      return;
    if (
      current?.profile &&
      snapshot.profile &&
      snapshot.profile.runtimeGeneration > current.profile.runtimeGeneration
    )
      discardDiagnostics(snapshot.id);
    set((state) => {
      const key = worktreeKey(snapshot.projectId, snapshot.worktreeId);
      const bucket = state.worktrees[key];
      if (!bucket || bucket.browsers[snapshot.id] === undefined) {
        // Snapshot for a browser we do not track (already removed) — ignore.
        return state;
      }
      return {
        worktrees: {
          ...state.worktrees,
          [key]: {
            ...bucket,
            browsers: { ...bucket.browsers, [snapshot.id]: snapshot },
            live: withLive(bucket.live, snapshot.id, true),
          },
        },
      };
    });
  },

  appendConsoleEntry: (browserId, entry): void => {
    set((state) => {
      const nextEntries = ringPush(
        state.consoleEntries[browserId],
        entry,
        MAX_CONSOLE_ENTRIES,
      );
      const consoleVisible =
        state.inspectorOpen[browserId] === true &&
        (state.inspectorTab[browserId] ?? DEFAULT_BROWSER_INSPECTOR_TAB) ===
          'console';
      const nextSeenAt =
        entry.level === 'error' && consoleVisible
          ? {
              ...state.diagnosticsSeenAt,
              [browserId]: {
                ...state.diagnosticsSeenAt[browserId],
                console: Math.max(
                  state.diagnosticsSeenAt[browserId]?.console ?? 0,
                  entry.timestamp,
                ),
              },
            }
          : state.diagnosticsSeenAt;
      return {
        consoleEntries: {
          ...state.consoleEntries,
          [browserId]: nextEntries,
        },
        diagnosticsSeenAt: nextSeenAt,
      };
    });
  },

  upsertNetworkEntry: (browserId, entry): void => {
    set((state) => {
      const existing = state.networkEntries[browserId] ?? [];
      const index = existing.findIndex(
        (candidate) => candidate.requestId === entry.requestId,
      );
      let next: BrowserNetworkEntry[];
      if (index >= 0) {
        next = [...existing];
        next[index] = { ...existing[index], ...entry };
      } else {
        next = ringPush(existing, entry, MAX_NETWORK_ENTRIES);
      }
      const networkVisible =
        state.inspectorOpen[browserId] === true &&
        state.inspectorTab[browserId] === 'network';
      const nextSeenAt =
        entry.failed === true && networkVisible
          ? {
              ...state.diagnosticsSeenAt,
              [browserId]: {
                ...state.diagnosticsSeenAt[browserId],
                network: Math.max(
                  state.diagnosticsSeenAt[browserId]?.network ?? 0,
                  entry.timestamp,
                ),
              },
            }
          : state.diagnosticsSeenAt;
      return {
        networkEntries: { ...state.networkEntries, [browserId]: next },
        diagnosticsSeenAt: nextSeenAt,
      };
    });
  },

  appendRecordingStep: (browserId, step): void => {
    set((state) => {
      const current = state.recordings[browserId] ?? emptyRecording(browserId);
      const steps = ringPush(current.steps, step, MAX_RECORDING_STEPS);
      return {
        recordings: {
          ...state.recordings,
          [browserId]: { ...current, recording: true, steps },
        },
      };
    });
  },

  setRecordingState: (browserId, recording): void => {
    set((state) => {
      const current = state.recordings[browserId] ?? emptyRecording(browserId);
      return {
        recordings: {
          ...state.recordings,
          [browserId]: { ...current, recording },
        },
      };
    });
  },

  setRecordingResult: (browserId, result): void => {
    set((state) => ({
      recordings: { ...state.recordings, [browserId]: result },
    }));
  },

  setDialog: (browserId, dialog): void => {
    set((state) => ({
      dialogs: { ...state.dialogs, [browserId]: dialog },
    }));
  },

  clearDialog: (browserId, dialogId): void => {
    set((state) => {
      const current = state.dialogs[browserId];
      if (!current || (dialogId !== undefined && current.id !== dialogId)) {
        return state;
      }
      const dialogs = { ...state.dialogs };
      delete dialogs[browserId];
      return { dialogs };
    });
  },

  setAuthRequest: (browserId, request): void => {
    set((state) => {
      if (request) {
        return {
          authRequests: { ...state.authRequests, [browserId]: request },
        };
      }
      if (!state.authRequests[browserId]) return state;
      const authRequests = { ...state.authRequests };
      delete authRequests[browserId];
      return { authRequests };
    });
  },

  setPrintRequest: (browserId, request): void => {
    set((state) => {
      if (request) {
        return {
          printRequests: { ...state.printRequests, [browserId]: request },
        };
      }
      if (!state.printRequests[browserId]) return state;
      const printRequests = { ...state.printRequests };
      delete printRequests[browserId];
      return { printRequests };
    });
  },

  setFileChooser: (browserId, chooser): void => {
    set((state) => {
      if (chooser) {
        return {
          fileChoosers: { ...state.fileChoosers, [browserId]: chooser },
        };
      }
      if (!state.fileChoosers[browserId]) return state;
      const fileChoosers = { ...state.fileChoosers };
      delete fileChoosers[browserId];
      return { fileChoosers };
    });
  },

  clearConsole: (browserId): void => {
    set((state) => {
      if (state.consoleEntries[browserId] === undefined) {
        return state;
      }
      const next = { ...state.consoleEntries };
      delete next[browserId];
      return { consoleEntries: next };
    });
  },

  clearNetwork: (browserId): void => {
    // No backend "clear network" channel exists; the inspector renders the
    // renderer-side mirror, so clearing the local ring buffer is sufficient.
    set((state) => {
      if (state.networkEntries[browserId] === undefined) {
        return state;
      }
      const next = { ...state.networkEntries };
      delete next[browserId];
      return { networkEntries: next };
    });
  },

  clearRecording: (browserId): void => {
    set((state) => ({
      recordings: {
        ...state.recordings,
        [browserId]: emptyRecording(browserId),
      },
    }));
    void window.api.browser
      .clearRecording({ browserId })
      .catch(() => undefined);
  },

  acknowledgeConsoleErrors: (browserId): void => {
    set((state) => {
      const latest = latestConsoleErrorTimestamp(state, browserId);
      if (latest === undefined) {
        return state;
      }
      const current = state.diagnosticsSeenAt[browserId];
      if ((current?.console ?? 0) >= latest) {
        return state;
      }
      return {
        diagnosticsSeenAt: {
          ...state.diagnosticsSeenAt,
          [browserId]: { ...current, console: latest },
        },
      };
    });
  },

  acknowledgeNetworkFailures: (browserId): void => {
    set((state) => {
      const latest = latestNetworkFailureTimestamp(state, browserId);
      if (latest === undefined) {
        return state;
      }
      const current = state.diagnosticsSeenAt[browserId];
      if ((current?.network ?? 0) >= latest) {
        return state;
      }
      return {
        diagnosticsSeenAt: {
          ...state.diagnosticsSeenAt,
          [browserId]: { ...current, network: latest },
        },
      };
    });
  },

  addScreenshot: (browserId, entry): void => {
    set((state) => ({
      screenshots: {
        ...state.screenshots,
        [browserId]: [...(state.screenshots[browserId] ?? []), entry],
      },
    }));
  },

  markScreenshotAttached: (browserId, screenshotId): void => {
    set((state) => {
      const entries = state.screenshots[browserId];
      if (!entries) {
        return state;
      }
      return {
        screenshots: {
          ...state.screenshots,
          [browserId]: entries.map((entry) =>
            entry.id === screenshotId ? { ...entry, attached: true } : entry,
          ),
        },
      };
    });
  },

  removeScreenshot: (browserId, screenshotId): void => {
    set((state) => {
      const entries = state.screenshots[browserId];
      if (!entries) {
        return state;
      }
      const nextEntries = entries.filter((entry) => entry.id !== screenshotId);
      const screenshots = { ...state.screenshots };
      if (nextEntries.length > 0) {
        screenshots[browserId] = nextEntries;
      } else {
        delete screenshots[browserId];
      }
      return { screenshots };
    });
  },

  applyBrowserHandoffEvent: (event): BrowserHandoffEventOutcome => {
    const key =
      event.type === 'handoff-requested'
        ? worktreeKey(event.handoff.projectId, event.handoff.worktreeId)
        : worktreeKey(event.projectId, event.worktreeId);
    const current = get().browserHandoffs[key];
    if (current !== undefined && event.revision <= current.revision) {
      return 'ignored';
    }
    const previous = current?.handoff ?? null;
    let outcome: BrowserHandoffEventOutcome;
    let handoff: BrowserHandoff | null;
    if (event.type === 'handoff-requested') {
      outcome =
        previous?.handoffId === event.handoff.handoffId
          ? 'duplicate'
          : 'requested';
      handoff = event.handoff;
    } else if (previous?.handoffId === event.handoffId) {
      outcome = 'released';
      handoff = null;
    } else {
      // A stale release must never clear a replacement handoff.
      outcome = 'ignored';
      handoff = previous;
    }
    set((state) => ({
      browserHandoffs: {
        ...state.browserHandoffs,
        [key]: { handoff, revision: event.revision },
      },
    }));
    return outcome;
  },

  applyBrowserHandoffHydration: (projectId, worktreeId, hydration): void => {
    const key = worktreeKey(projectId, worktreeId);
    const current = get().browserHandoffs[key];
    if (current !== undefined && hydration.revision < current.revision) {
      return;
    }
    set((state) => ({
      browserHandoffs: {
        ...state.browserHandoffs,
        [key]: { handoff: hydration.handoff, revision: hydration.revision },
      },
    }));
  },

  setInspectorOpen: (browserId, open): void => {
    set((state) => ({
      inspectorOpen: { ...state.inspectorOpen, [browserId]: open },
    }));
  },

  toggleInspector: (browserId): void => {
    set((state) => ({
      inspectorOpen: {
        ...state.inspectorOpen,
        [browserId]: !state.inspectorOpen[browserId],
      },
    }));
  },

  setInspectorTab: (browserId, tab): void => {
    set((state) => ({
      inspectorTab: { ...state.inspectorTab, [browserId]: tab },
    }));
  },

  openFilesPanel: (browserId): void => {
    set((state) => ({
      inspectorOpen: { ...state.inspectorOpen, [browserId]: true },
      inspectorTab: { ...state.inspectorTab, [browserId]: 'files' },
    }));
  },

  hydrateTransfers: async (browserId): Promise<void> => {
    const requestedAt = transferUpdateSequence;
    // The newest page, and every download that can still finish, however
    // old: those keep their row and their Cancel.
    const [newest, running, interrupted] = await Promise.all([
      window.api.browser.listTransfers({ browserId, limit: MAX_TRANSFERS }),
      listUnfinishedTransfers(browserId, 'in_progress'),
      listUnfinishedTransfers(browserId, 'interrupted'),
    ]);
    set((state) => {
      const current = state.transfers[browserId] ?? [];
      const byId = new Map(current.map((transfer) => [transfer.id, transfer]));
      for (const listed of [...newest.transfers, ...running, ...interrupted]) {
        const existing = byId.get(listed.id);
        // An event that arrived while the list was loading is newer than
        // the listed record.
        const updatedSince =
          (transferUpdatedAt.get(transferKey(browserId, listed.id)) ?? -1) >=
          requestedAt;
        byId.set(
          listed.id,
          existing && updatedSince ? existing : mergeTransfer(existing, listed),
        );
      }
      return {
        transfers: {
          ...state.transfers,
          [browserId]: orderTransfers(Array.from(byId.values())),
        },
      };
    });
  },

  upsertTransfer: (browserId, transfer): void => {
    transferUpdatedAt.set(
      transferKey(browserId, transfer.id),
      transferUpdateSequence,
    );
    transferUpdateSequence += 1;
    set((state) => {
      const current = state.transfers[browserId] ?? [];
      const existing = current.find((entry) => entry.id === transfer.id);
      const next = mergeTransfer(existing, transfer);
      const completed =
        next.kind === 'download' &&
        next.status === 'complete' &&
        existing?.status !== 'complete';
      return {
        transfers: {
          ...state.transfers,
          [browserId]: orderTransfers([
            next,
            ...current.filter((entry) => entry.id !== transfer.id),
          ]),
        },
        ...(completed
          ? { downloadToasts: { ...state.downloadToasts, [browserId]: next } }
          : {}),
      };
    });
  },

  noteDownloadsBlocked: (browserId, blockedCount): void => {
    set((state) => ({
      blockedDownloads: {
        ...state.blockedDownloads,
        [browserId]: Math.max(
          state.blockedDownloads[browserId] ?? 0,
          blockedCount,
        ),
      },
    }));
  },

  dismissDownloadsBlocked: (browserId): void => {
    set((state) => {
      if (state.blockedDownloads[browserId] === undefined) {
        return state;
      }
      const blockedDownloads = { ...state.blockedDownloads };
      delete blockedDownloads[browserId];
      return { blockedDownloads };
    });
  },

  allowMoreDownloads: async (browserId): Promise<void> => {
    const result = await get().runTransferCommand({
      kind: 'allow_more',
      browserId,
    });
    if (result.ok) {
      get().dismissDownloadsBlocked(browserId);
    }
  },

  dismissDownloadToast: (browserId, transferId): void => {
    set((state) => {
      if (state.downloadToasts[browserId]?.id !== transferId) {
        return state;
      }
      const downloadToasts = { ...state.downloadToasts };
      delete downloadToasts[browserId];
      return { downloadToasts };
    });
  },

  runTransferCommand: async (
    command,
  ): Promise<BrowserTransferCommandResult> => {
    const result = await window.api.browser.transferCommand(command);
    if (result.transfer) {
      get().upsertTransfer(command.browserId, result.transfer);
    }
    return result;
  },
}));

/**
 * Monotonic counter stamped on each live transfer update, so a list that was
 * requested before an update cannot overwrite it when it resolves.
 */
let transferUpdateSequence = 0;
const transferUpdatedAt = new Map<string, number>();

function transferKey(browserId: string, transferId: string): string {
  return `${browserId}\0${transferId}`;
}

const FINAL_TRANSFER_STATUSES: ReadonlySet<BrowserTransfer['status']> = new Set<
  BrowserTransfer['status']
>(['complete', 'cancelled', 'failed', 'attached', 'denied']);

function isFinalTransfer(transfer: BrowserTransfer): boolean {
  return (
    FINAL_TRANSFER_STATUSES.has(transfer.status) ||
    (transfer.status === 'interrupted' &&
      (transfer.kind !== 'download' || transfer.canResume !== true))
  );
}

/** A finished record never moves back to a running state. */
function mergeTransfer(
  existing: BrowserTransfer | undefined,
  incoming: BrowserTransfer,
): BrowserTransfer {
  if (existing && isFinalTransfer(existing) && !isFinalTransfer(incoming)) {
    return existing;
  }
  return incoming;
}

/**
 * Newest first, capped at MAX_TRANSFERS. The cap drops only finished records:
 * a running download stays listed, with its Cancel, however old it is.
 */
function orderTransfers(transfers: BrowserTransfer[]): BrowserTransfer[] {
  const sorted = [...transfers].sort((a, b) => b.startedAt - a.startedAt);
  let finishedRoom =
    MAX_TRANSFERS -
    sorted.filter((transfer) => !isFinalTransfer(transfer)).length;
  return sorted.filter((transfer) => {
    if (!isFinalTransfer(transfer)) return true;
    finishedRoom -= 1;
    return finishedRoom >= 0;
  });
}

/** How many pages of one status a load reads, at most. */
const MAX_TRANSFER_PAGES = 50;

/**
 * Every transfer with this status that can still finish, read page by page:
 * an interrupted list mixes resumable downloads with finished ones.
 */
async function listUnfinishedTransfers(
  browserId: string,
  status: 'in_progress' | 'interrupted',
): Promise<BrowserTransfer[]> {
  const unfinished: BrowserTransfer[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_TRANSFER_PAGES; page += 1) {
    const result = await window.api.browser.listTransfers({
      browserId,
      status,
      offset,
      limit: MAX_TRANSFERS,
    });
    unfinished.push(...result.transfers.filter((t) => !isFinalTransfer(t)));
    offset += result.transfers.length;
    if (result.transfers.length === 0 || offset >= result.total) break;
  }
  return unfinished;
}

/** Drop the transfer mirror for a removed browser id. */
function discardTransfers(browserId: string): void {
  Array.from(transferUpdatedAt.keys())
    .filter((key) => key.startsWith(`${browserId}\0`))
    .forEach((key) => transferUpdatedAt.delete(key));
  useBrowserStore.setState((state) => {
    const transfers = { ...state.transfers };
    const blockedDownloads = { ...state.blockedDownloads };
    const downloadToasts = { ...state.downloadToasts };
    delete transfers[browserId];
    delete blockedDownloads[browserId];
    delete downloadToasts[browserId];
    return { transfers, blockedDownloads, downloadToasts };
  });
}

/** Drop all diagnostics/inspector state for a removed browser id. */
function discardDiagnostics(browserId: string): void {
  useBrowserStore.setState((state) => {
    const consoleEntries = { ...state.consoleEntries };
    const networkEntries = { ...state.networkEntries };
    const recordings = { ...state.recordings };
    const screenshots = { ...state.screenshots };
    const dialogs = { ...state.dialogs };
    const fileChoosers = { ...state.fileChoosers };
    const printRequests = { ...state.printRequests };
    const authRequests = { ...state.authRequests };
    const inspectorOpen = { ...state.inspectorOpen };
    const inspectorTab = { ...state.inspectorTab };
    const diagnosticsSeenAt = { ...state.diagnosticsSeenAt };
    delete consoleEntries[browserId];
    delete networkEntries[browserId];
    delete recordings[browserId];
    delete screenshots[browserId];
    delete dialogs[browserId];
    delete fileChoosers[browserId];
    delete printRequests[browserId];
    delete authRequests[browserId];
    delete inspectorOpen[browserId];
    delete inspectorTab[browserId];
    delete diagnosticsSeenAt[browserId];
    return {
      consoleEntries,
      networkEntries,
      recordings,
      screenshots,
      dialogs,
      fileChoosers,
      printRequests,
      authRequests,
      inspectorOpen,
      inspectorTab,
      diagnosticsSeenAt,
    };
  });
}

function latestConsoleErrorTimestamp(
  state: BrowserState,
  browserId: string,
): number | undefined {
  return state.consoleEntries[browserId]
    ?.filter((entry) => entry.level === 'error')
    .reduce<
      number | undefined
    >((latest, entry) => (latest === undefined ? entry.timestamp : Math.max(latest, entry.timestamp)), undefined);
}

function latestNetworkFailureTimestamp(
  state: BrowserState,
  browserId: string,
): number | undefined {
  return state.networkEntries[browserId]
    ?.filter((entry) => entry.failed === true)
    .reduce<
      number | undefined
    >((latest, entry) => (latest === undefined ? entry.timestamp : Math.max(latest, entry.timestamp)), undefined);
}

// ---------------------------------------------------------------------------
// Selectors / derived helpers
// ---------------------------------------------------------------------------

export function selectBrowserBucket(
  state: BrowserState,
  projectId: string,
  worktreeId: string,
): WorktreeBrowserBucket | undefined {
  return state.worktrees[worktreeKey(projectId, worktreeId)];
}

/** The worktree's pending browser handoff, if main reported one. */
export function selectBrowserHandoff(
  state: Pick<BrowserState, 'browserHandoffs'>,
  projectId: string,
  worktreeId: string,
): BrowserHandoff | null {
  return (
    state.browserHandoffs[worktreeKey(projectId, worktreeId)]?.handoff ?? null
  );
}

/** One browser's snapshot, resolved by exact id within its worktree bucket. */
export function selectBrowserSnapshot(
  state: Pick<BrowserState, 'worktrees'>,
  projectId: string,
  worktreeId: string,
  browserId: string,
): BrowserSessionSnapshot | undefined {
  return state.worktrees[worktreeKey(projectId, worktreeId)]?.browsers[
    browserId
  ];
}

/**
 * Whether exactly this browser is loading a navigation with a live view.
 * Per-browser on purpose: one session's loading state must not rerender or
 * light up unrelated Browser tabs.
 */
export function useBrowserLoading(browserId: string | undefined): boolean {
  return useBrowserStore((state) => {
    if (browserId === undefined) {
      return false;
    }
    for (const bucket of Object.values(state.worktrees)) {
      const snapshot = bucket.browsers[browserId];
      if (snapshot !== undefined) {
        // Not while the session itself is still being set up: the pane shows
        // that state, and the tab dot is for page loads only.
        return (
          snapshot.loading &&
          bucket.live.has(browserId) &&
          state.openingBrowserIds[browserId] !== true
        );
      }
    }
    return false;
  });
}

/** Count of recent console entries at `error` level for a browser. */
export function selectConsoleErrorCount(
  state: BrowserState,
  browserId: string,
): number {
  const entries = state.consoleEntries[browserId];
  if (!entries) {
    return 0;
  }
  return entries.filter((entry) => entry.level === 'error').length;
}

/** Count of recent failed network requests for a browser. */
export function selectFailedRequestCount(
  state: BrowserState,
  browserId: string,
): number {
  const entries = state.networkEntries[browserId];
  if (!entries) {
    return 0;
  }
  return entries.filter((entry) => entry.failed === true).length;
}

export function selectUnreadConsoleErrorCount(
  state: BrowserState,
  browserId: string,
): number {
  const entries = state.consoleEntries[browserId];
  if (!entries) {
    return 0;
  }
  const seenAt = state.diagnosticsSeenAt[browserId]?.console ?? 0;
  return entries.filter(
    (entry) => entry.level === 'error' && entry.timestamp > seenAt,
  ).length;
}

export function selectUnreadFailedRequestCount(
  state: BrowserState,
  browserId: string,
): number {
  const entries = state.networkEntries[browserId];
  if (!entries) {
    return 0;
  }
  const seenAt = state.diagnosticsSeenAt[browserId]?.network ?? 0;
  return entries.filter(
    (entry) => entry.failed === true && entry.timestamp > seenAt,
  ).length;
}

/**
 * Downloads still in flight for a browser: running, paused, or interrupted
 * with a resume available this session.
 */
export function isActiveTransfer(transfer: BrowserTransfer): boolean {
  return !isFinalTransfer(transfer);
}

export function selectActiveTransferCount(
  state: BrowserState,
  browserId: string,
): number {
  return (state.transfers[browserId] ?? []).filter(
    (transfer) => transfer.kind === 'download' && isActiveTransfer(transfer),
  ).length;
}

export function selectUnreadDiagnosticCount(
  state: BrowserState,
  browserId: string,
): number {
  return (
    selectUnreadConsoleErrorCount(state, browserId) +
    selectUnreadFailedRequestCount(state, browserId)
  );
}

export function ensureBrowserWorktreeHydrated(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const key = worktreeKey(projectId, worktreeId);
  const bucket = useBrowserStore.getState().worktrees[key];
  if (bucket?.hydrated) {
    return Promise.resolve();
  }
  const existing = hydrationPromises.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const promise = useBrowserStore
    .getState()
    .hydrateWorktree(projectId, worktreeId)
    .finally(() => {
      hydrationPromises.delete(key);
    });
  hydrationPromises.set(key, promise);
  return promise;
}
