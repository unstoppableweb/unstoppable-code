import type { PostHogSessionBridge } from './client/posthog-session';
import type { PostHogRoute } from './posthog-routes';
import type { PostHogAccountSource } from './posthog-account';
import type { DesktopInstrumentationInitFailureReason } from '@canopy/execution-engine/types/observability';

export type DesktopInstrumentationProvider = 'posthog';

export type DesktopInstrumentationSurface = 'main' | 'app-advisor';

export type DesktopInstrumentationFailureReason =
  | 'error'
  | 'abandoned'
  | 'other';

export type DesktopInstrumentationContextValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export type DesktopInstrumentationContext = Record<
  string,
  DesktopInstrumentationContextValue
>;

export type DesktopInstrumentationFeatureFlagValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export interface DesktopInstrumentationOperationOptions {
  operationKey?: string;
  context?: DesktopInstrumentationContext;
  description?: string;
}

export interface DesktopInstrumentationInitResult {
  enabled: boolean;
  provider: DesktopInstrumentationProvider;
  reason?: 'disabled' | DesktopInstrumentationInitFailureReason;
}

/** Host-projected flags. Missing or malformed values must fail closed. */
export interface PostHogRuntimeFlags {
  captureEnabled: unknown;
  sessionReplaySampleRate: unknown;
  autocaptureEnabled?: unknown;
  /** The member's effective Usage analytics choice (user and org policy). */
  productAnalytics?: unknown;
  /** The member's effective Error reports choice (user and org policy). */
  errorReports?: unknown;
  /** The member's effective Session recordings choice (user and org policy). */
  sessionReplay?: unknown;
}

/**
 * The seam through which a renderer publishes its current synthetic screen
 * route (see `./posthog-routes`) to the instrumentation client.
 *
 * This is an IN-PROCESS interface within a single renderer process — not an
 * IPC contract. There is no persisted route history and no cross-window
 * sharing; each renderer supplies its own source and is the sole authority for
 * its own route.
 *
 * Contract both sides must honor:
 *
 * - `getSnapshot()` is **synchronous, total, and cheap**. It always returns a
 *   valid catalog member. It never returns `undefined`, never throws, and must
 *   stay allocation-light: the consumer calls it during SDK initialization and
 *   the producer derives it on store updates that can fire at streaming-token
 *   frequency.
 *
 * - `subscribe()` notifies **only on a changed final route string**.
 *   Deduplication is the producer's responsibility. The consumer may therefore
 *   assume every notification is a real A→B transition and emit a
 *   `$pageleave`/`$pageview` pair per notification without re-comparing.
 *   Repeated A→A updates must emit nothing.
 *
 * - `subscribe()` returns an **idempotent unsubscribe**. Calling it more than
 *   once is safe and has no further effect.
 *
 * - **The consumer owns the subscription lifetime.** SDK initialization
 *   subscribes; SDK disposal unsubscribes. When instrumentation is disabled
 *   the consumer must not subscribe at all, so disabled instrumentation
 *   installs no ongoing tracking.
 *
 * - **A missing source means existing behavior.** When
 *   `DesktopInstrumentationClientInitOptions.posthogRoutes` is absent, the
 *   client keeps its current safe-surface fallback (`app://main` /
 *   `app://app-advisor` derived from `surface`) with no behavior change. Node
 *   and background callers pass nothing.
 */
export interface PostHogRouteSource {
  getSnapshot(): PostHogRoute;
  subscribe(listener: (route: PostHogRoute) => void): () => void;
}

export interface DesktopInstrumentationClientInitOptions {
  posthogFlags?: {
    getSnapshot: () => Promise<PostHogRuntimeFlags>;
    onSnapshotChanged: (
      listener: (flags: PostHogRuntimeFlags) => void,
    ) => () => void;
  };
  surface: DesktopInstrumentationSurface;
  getPostHogAnonymousId?: () => Promise<string | null>;
  posthogAccount?: PostHogAccountSource;
  posthogSession?: PostHogSessionBridge;
  /**
   * Optional per-renderer synthetic screen route source. Omitting it preserves
   * the existing safe-surface fallback verbatim; see {@link PostHogRouteSource}
   * for the full contract.
   */
  posthogRoutes?: PostHogRouteSource;
  onProviderInitialized?: (result: DesktopInstrumentationInitResult) => void;
}

export interface DesktopInstrumentationErrorOptions {
  context?: DesktopInstrumentationContext;
}
