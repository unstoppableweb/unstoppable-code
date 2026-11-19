import type { AgentProviderType } from '@canopy/agent-transcript';
import type { UsageDataPolicySnapshot } from '../execution-types';
import type {
  AgentAuditHistoryRequest,
  AgentAuditHistoryResponse,
  AgentAuditTranscriptRequest,
  AgentAuditTranscriptResponse,
  AgentObservabilitySnapshot,
  AgentObservabilityUpdateEvent,
  UsageMetricsRequest,
  UsageMetricsResponse,
  UsageMetricsViewRequest,
  UsageMetricsViewResponse,
  UsageTabSummaryRequest,
  UsageTabSummaryResponse,
  UsageTimeseriesRequest,
  UsageTimeseriesResponse,
} from '@canopy/protocol/observability';

// The audit and usage record contracts live in `@canopy/protocol/observability`
// (CAN-4136); this module keeps the preload API and instrumentation types.
export * from '@canopy/protocol/observability';

/** A closed set: an error message can quote paths or received values. */
export const DESKTOP_INSTRUMENTATION_INIT_FAILURE_REASONS = [
  'missing_project_key',
  'shutdown',
  'anonymous_id_unavailable',
  'session_bridge_unavailable',
  'sdk_init_failed',
] as const;

export type DesktopInstrumentationInitFailureReason =
  (typeof DESKTOP_INSTRUMENTATION_INIT_FAILURE_REASONS)[number];

export interface DesktopInstrumentationInitFailureDiagnosticRequest {
  surface: 'main' | 'app-advisor';
  reason: `posthog: ${DesktopInstrumentationInitFailureReason}`;
}

export interface PostHogSessionState {
  sessionId: string;
  revision: number;
}

/** How this launch relates to the install, from the host's local state. */
export interface PostHogInstallLaunch {
  /** The analytics identity was created now and no earlier install data exists. */
  isFirstLaunch: boolean;
  /** The analytics identity was created now over existing install data. */
  isReinstall: boolean;
  /** Observed desktop acceptance on this install; absent for unknown metadata. */
  isInvitedInstall?: boolean;
}

/**
 * The focused chat's committed row count (its transcript descriptor's
 * `committedMessageCount`), as the lower bound of its bucket: 0, 1,000, 5,000,
 * 20,000 or 50,000 rows and over.
 */
export type RendererChatRowsBucket = 0 | 1_000 | 5_000 | 20_000 | 50_000;

/**
 * `user-callback` invokers a long frame's script may name. Chromium reports
 * these fixed callback kinds; any other value is recorded as `null`.
 */
export const RENDERER_LONG_FRAME_CALLBACK_INVOKERS = [
  'TimerHandler:setTimeout',
  'TimerHandler:setInterval',
  'FrameRequestCallback',
  'IdleRequestCallback',
  'ResizeObserverCallback',
  'IntersectionObserverCallback',
  'MutationCallback',
  'PerformanceObserverCallback',
] as const;

/**
 * Standard DOM event handler names an `event-listener` script may name, taken
 * from the end of Chromium's invoker (`BUTTON#save.onclick` → `onclick`). The
 * target element, its id, classes and attributes are never kept, and any
 * other event is recorded as `null`.
 */
export const RENDERER_LONG_FRAME_EVENT_INVOKERS = [
  'onclick',
  'ondblclick',
  'oncontextmenu',
  'onmousedown',
  'onmouseup',
  'onmousemove',
  'onpointerdown',
  'onpointerup',
  'onpointermove',
  'onwheel',
  'onscroll',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'onbeforeinput',
  'oninput',
  'onchange',
  'oncompositionend',
  'onfocus',
  'onblur',
  'onfocusin',
  'onfocusout',
  'oncopy',
  'oncut',
  'onpaste',
  'ondragover',
  'ondrop',
  'onresize',
  'onselectionchange',
  'onvisibilitychange',
  'onload',
  'onerror',
  'onmessage',
  'ontransitionend',
  'onanimationend',
] as const;

export type RendererLongFrameInvoker =
  | (typeof RENDERER_LONG_FRAME_CALLBACK_INVOKERS)[number]
  | (typeof RENDERER_LONG_FRAME_EVENT_INVOKERS)[number];

/**
 * One script Chromium attributed to a long frame. Chromium attributes none
 * of the app's own scripts (served from `file://` or `app-renderer://`) and
 * no work entered from a preload IPC listener, so for app code this is
 * normally empty. What it does attribute has no known provenance, so no
 * source name, URL or function name is kept.
 */
export interface RendererLongFrameScript {
  /** `invokerType`, grouped as the window's invoker counts are. */
  invokerType: 'user-callback' | 'event-listener' | 'promise' | 'script';
  /**
   * A fixed callback kind for `user-callback`, or a standard event handler
   * name for `event-listener`; otherwise, and for every other type, `null`.
   */
  invoker: RendererLongFrameInvoker | null;
  /**
   * The scheme of the script's source URL: `none` when it has none (for
   * example evaluated code), `other` for any scheme not listed.
   */
  sourceKind: 'none' | 'http' | 'blob' | 'data' | 'other';
  durationMs: number;
}

/** A long animation frame of at least 1 s, with what can be attributed to it. */
export interface RendererLongFrame {
  durationMs: number;
  blockingMs: number;
  /**
   * Frame start to `renderStart` (the whole frame when it had no rendering
   * update): tasks, their scripts and microtasks.
   */
  scriptMs: number;
  /** `renderStart` to `styleAndLayoutStart`: animation frame callbacks and observers. */
  renderMs: number;
  /** `styleAndLayoutStart` to the end of the frame: style, layout and paint. */
  layoutMs: number;
  /**
   * Chat state, chat event and terminal deliveries that started during the
   * frame. `deliveryMs` is their synchronous apply plus the microtasks queued
   * during it, such as React's render of an immediate store update; not
   * microtasks those queue in turn. Streamed content renders on the next
   * animation frame instead, inside `renderMs`.
   */
  deliveries: {
    chatState: number;
    chatEvent: number;
    terminal: number;
    deliveryMs: number;
  };
  /**
   * Committed row bucket of the window's largest focused chat when the frame
   * was reported; `null` with no focused chat or no known committed count.
   */
  focusedChatRows: RendererChatRowsBucket | null;
  /** The longest attributed scripts, at most 3, longest first. */
  scripts: RendererLongFrameScript[];
}

/**
 * One renderer's frame and chat delivery numbers for one diagnostic window
 * (about 30 s), sent on `observability:record-renderer-summary` and recorded
 * on this device only as the `renderer_frame_summary` app diagnostic. Every
 * field is a count, a duration in milliseconds, a flag, a row-count bucket,
 * or a value from a fixed vocabulary: no chat, path, URL, source or function
 * name, or other content.
 */
export interface RendererDiagnosticsSummary {
  /** Length of the window the summary covers. */
  windowMs: number;
  /** The renderer shows another computer (a remote access window). */
  remoteWindow: boolean;
  /** Long animation frames (`long-animation-frame` entries). */
  frames: {
    count: number;
    p95Ms: number;
    maxMs: number;
    /** Summed `blockingDuration`. */
    blockingMs: number;
    /**
     * Script entries by invoker type; promise and script types are combined.
     * Zero for the app's own code, which Chromium does not attribute.
     */
    invokers: {
      userCallback: number;
      eventListener: number;
      promise: number;
      script: number;
    };
    /** Frames of at least 1 s, longest first, at most 3. */
    long: RendererLongFrame[];
  };
  /**
   * `chat:state-changed`: changes attributed by their chat to on screen (the
   * window's focused or warm chats) or off screen; changes without a chat are
   * scope-level. Messages and apply time are bucketed by whether all of a
   * message's chat changes were on screen, all off screen, or mixed.
   */
  chatState: {
    onScreenChanges: number;
    offScreenChanges: number;
    scopeChanges: number;
    onScreenMessages: number;
    offScreenMessages: number;
    mixedMessages: number;
    onScreenApplyMs: number;
    offScreenApplyMs: number;
    mixedApplyMs: number;
  };
  /** Raw `chat:event`, by its chat; `canopy_delegation` events apart. */
  chatEvent: {
    onScreenEvents: number;
    offScreenEvents: number;
    delegationEvents: number;
    onScreenApplyMs: number;
    offScreenApplyMs: number;
    delegationApplyMs: number;
  };
  /** Terminal output, counted once per delivery at the terminal client. */
  terminal: {
    deliveries: number;
    applyMs: number;
  };
}

/**
 * What a remote access host forwarded to one controlling computer's session
 * in one diagnostic window (about 30 s), recorded on the host only as the
 * `remote_push_summary` app diagnostic. Counts and serialized bytes only: no
 * device, session, chat or path identity. Chat channels are split by the
 * interest that session's bridge window declared; with none declared, only
 * the totals are filled in.
 */
export interface RemotePushSummary {
  /** Length of the window the summary covers. */
  windowMs: number;
  /** The session's bridge window had a declared chat interest. */
  interestDeclared: boolean;
  /** Pushes on screen, off screen, or (state only) with changes of both. */
  chatState: {
    pushes: number;
    bytes: number;
    onScreenPushes: number;
    offScreenPushes: number;
    mixedPushes: number;
    onScreenBytes: number;
    offScreenBytes: number;
    mixedBytes: number;
  };
  chatEvent: {
    pushes: number;
    bytes: number;
    onScreenPushes: number;
    offScreenPushes: number;
    onScreenBytes: number;
    offScreenBytes: number;
  };
  terminal: { pushes: number; bytes: number };
  other: { pushes: number; bytes: number };
  /** Pushes the forwarder dropped as broadcast duplicates. */
  duplicateDrops: number;
}

export interface ObservabilityApi {
  loadSnapshot(): Promise<AgentObservabilitySnapshot>;
  loadHistory(
    request: AgentAuditHistoryRequest,
  ): Promise<AgentAuditHistoryResponse>;
  loadTranscript(
    request: AgentAuditTranscriptRequest,
  ): Promise<AgentAuditTranscriptResponse>;
  loadUsageTimeseries(
    request: UsageTimeseriesRequest,
  ): Promise<UsageTimeseriesResponse>;
  loadUsageMetrics(request: UsageMetricsRequest): Promise<UsageMetricsResponse>;
  loadUsageMetricsView(
    request: UsageMetricsViewRequest,
  ): Promise<UsageMetricsViewResponse>;
  loadUsageTabSummary(
    request: UsageTabSummaryRequest,
  ): Promise<UsageTabSummaryResponse>;
  refreshUsage(provider: AgentProviderType): Promise<void>;
  recordDesktopInstrumentationInitFailure(
    request: DesktopInstrumentationInitFailureDiagnosticRequest,
  ): Promise<void>;
  /** One-way: record this renderer's diagnostic summary on this device. */
  recordRendererSummary(summary: RendererDiagnosticsSummary): void;
  /** Null in a local-only build, which has no PostHog identity. */
  getPostHogAnonymousId(): Promise<string | null>;
  /** Normalized domain only; null for signed-out, guest, or unavailable accounts. */
  getPostHogEmailDomain(): Promise<string | null>;
  onPostHogEmailDomainUpdate(cb: (domain: string | null) => void): () => void;
  getPostHogSession(): Promise<PostHogSessionState>;
  reportPostHogSessionRotation(
    proposal: PostHogSessionState,
  ): Promise<PostHogSessionState>;
  onPostHogSessionUpdate(cb: (state: PostHogSessionState) => void): () => void;
  /** Main's effective usage-data policy for the selected workspace context. */
  getUsageDataPolicy(): Promise<UsageDataPolicySnapshot>;
  onUsageDataPolicyChanged(
    cb: (snapshot: UsageDataPolicySnapshot) => void,
  ): () => void;
  onUpdate(cb: (event: AgentObservabilityUpdateEvent) => void): () => void;
}
