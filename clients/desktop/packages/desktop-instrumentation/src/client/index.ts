import { connectPostHogSession } from './posthog-session';
import {
  getPostHogInstrumentationReadiness,
  getDesktopInstrumentationConfig,
} from '../config';
import { sanitizeInstrumentationContext } from '../privacy';
import {
  createPostHogOperationTracker,
  type DesktopOperationName,
  type DesktopOperationOutcome,
  type PostHogOperationEvent,
} from '../operations';
import {
  POSTHOG_PROPERTY_DENYLIST,
  sanitizePostHogEvent,
} from '../posthog-privacy';
import {
  createPostHogRuntimeController,
  isPostHogErrorEvent,
} from './posthog-runtime';
import { buildPostHogSessionRecordingOptions } from './posthog-replay-options';

/** The session recording options the desktop starts PostHog with. */
export { buildPostHogSessionRecordingOptions } from './posthog-replay-options';
import { POSTHOG_CLICK_INIT_OPTIONS } from './posthog-autocapture-options';
import { createPostHogScreenTracker } from './posthog-screen-tracking';
import { flushPostHogHeatmaps } from './posthog-heatmaps';
import {
  createPostHogAccountTracker,
  type PostHogAccountTracker,
} from '../posthog-account';
import {
  POSTHOG_APP_ADVISOR_ROUTE,
  POSTHOG_MAIN_ROUTE,
  POSTHOG_PAGEVIEW_EVENT,
  type PostHogRoute,
} from '../posthog-routes';
import {
  APP_ERROR_POSTHOG_EVENT,
  APP_ERROR_VIEW_POSTHOG_EVENT,
  buildAppErrorViewPostHogProperties,
  buildFeedbackReportTelemetry,
  type AppErrorTelemetrySessions,
  appErrorException,
  buildAppErrorPostHogProperties,
} from '../app-error-telemetry';
import type { FeedbackReportTelemetry } from '@canopy/protocol/feedback-report';
import {
  createAppErrorHandler,
  type AppError,
  type AppErrorHandler,
  type AppErrorReport,
  type AppErrorReportOptions,
  type AppErrorRecord,
  type AppErrorThrownType,
} from '@canopy/protocol/app-errors';
import type { PostHog } from 'posthog-js/dist/module.full.no-external';
import type {
  DesktopInstrumentationClientInitOptions,
  DesktopInstrumentationContext,
  PostHogRuntimeFlags,
  DesktopInstrumentationErrorOptions,
  DesktopInstrumentationFeatureFlagValue,
  DesktopInstrumentationFailureReason,
  DesktopInstrumentationInitResult,
  DesktopInstrumentationOperationOptions,
} from '../types';

type FeatureFlagValue = Exclude<
  DesktopInstrumentationFeatureFlagValue,
  undefined
>;
type FeatureFlagReporter = (key: string, value: FeatureFlagValue) => void;
type OperationReporter = (operation: PostHogOperationEvent) => void;
type AppErrorPostHogEvent = {
  event: typeof APP_ERROR_POSTHOG_EVENT | typeof APP_ERROR_VIEW_POSTHOG_EVENT;
  properties: ReturnType<typeof buildAppErrorPostHogProperties>;
};
type AppErrorReporter = (event: AppErrorPostHogEvent) => void;
type ExceptionReporter = (
  error: unknown,
  properties: DesktopInstrumentationContext | undefined,
) => void;

function safelyInvoke(callback: () => void): void {
  try {
    callback();
  } catch {
    // Instrumentation must never affect the app path.
  }
}

let disposePostHog: (() => void) | undefined;
let reportPostHogFeatureFlagEvaluation: FeatureFlagReporter | undefined;
let reportPostHogOperation: OperationReporter | undefined;
let reportPostHogAppError: AppErrorReporter | undefined;
let reportPostHogException: ExceptionReporter | undefined;
let posthogAppErrorSession: AppErrorTelemetrySessions['posthog'];
let isPostHogOperationStartEligible: (() => boolean) | undefined;
/** Bounds operations that finish while the SDK is still initializing. */
const MAX_PENDING_POSTHOG_OPERATIONS = 50;
/** Bounds handled errors reported while the SDK is still initializing. */
const MAX_PENDING_POSTHOG_EXCEPTIONS = 20;
let posthogInitialization:
  | Promise<DesktopInstrumentationInitResult>
  | undefined;

export function disposePostHogInstrumentationClient(): void {
  // Pending summaries need the provider this is about to tear down.
  disposeClientAppErrorHandler();
  const dispose = disposePostHog;
  disposePostHog = undefined;
  posthogInitialization = undefined;
  dispose?.();
}

async function initializePostHogClient(
  options: DesktopInstrumentationClientInitOptions,
): Promise<DesktopInstrumentationInitResult> {
  const config = getDesktopInstrumentationConfig();
  const readiness = getPostHogInstrumentationReadiness(config.posthog);
  if (!readiness.enabled) {
    return { enabled: false, provider: 'posthog', reason: readiness.reason };
  }
  let session: Awaited<ReturnType<typeof connectPostHogSession>> | undefined;
  let flags: PostHogRuntimeFlags | undefined;
  let waitingForFlags = true;
  let controller: ReturnType<typeof createPostHogRuntimeController> | undefined;
  let screenTracker: ReturnType<typeof createPostHogScreenTracker> | undefined;
  let revision = 0;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let unloadInstalled = false;
  let appErrorSession: AppErrorTelemetrySessions['posthog'];
  let posthog: PostHog | undefined;
  let account: PostHogAccountTracker | undefined;
  let releaseIdentityWait: (() => void) | undefined;
  // Before the first snapshot, buffer; afterwards each category follows the
  // LaunchDarkly capture flag and the member's effective usage-data choice.
  const eventsPermitted = (): boolean =>
    waitingForFlags ||
    (flags?.captureEnabled === true && flags.productAnalytics === true);
  const errorsPermitted = (): boolean =>
    waitingForFlags ||
    (flags?.captureEnabled === true && flags.errorReports === true);
  const eligibleStart = (): boolean => !disposed && eventsPermitted();
  isPostHogOperationStartEligible = eligibleStart;
  const pendingEvaluations = new Map<string, FeatureFlagValue>();
  const reportedEvaluations = new Map<string, FeatureFlagValue>();
  const reportEvaluation: FeatureFlagReporter = (key, value) => {
    if (disposed) return;
    if (!posthog || !controller) {
      if (!eventsPermitted()) return;
      // Flag-store hydration need not wait for the SDK or its host identity.
      // Retain current state, not an unbounded history of startup snapshots.
      pendingEvaluations.set(key, value);
      return;
    }
    if (!controller.allowsEvent('$feature_flag_called')) return;
    // A disconnected session bridge drops the SDK event in before_send.
    // Leave this value eligible for the next evaluation after recovery.
    if (!session?.allowsCapture()) return;
    if (reportedEvaluations.has(key) && reportedEvaluations.get(key) === value)
      return;
    posthog.capture('$feature_flag_called', {
      $feature_flag: key,
      $feature_flag_response: value,
    });
    reportedEvaluations.set(key, value);
  };
  reportPostHogFeatureFlagEvaluation = reportEvaluation;
  const pendingOperations: Array<PostHogOperationEvent | AppErrorPostHogEvent> =
    [];
  const reportEvent = (
    operation: PostHogOperationEvent | AppErrorPostHogEvent,
  ): void => {
    if (disposed) return;
    if (!posthog || !controller) {
      if (
        !(isPostHogErrorEvent(operation.event)
          ? errorsPermitted()
          : eventsPermitted())
      )
        return;
      pendingOperations.push(operation);
      if (pendingOperations.length > MAX_PENDING_POSTHOG_OPERATIONS)
        pendingOperations.shift();
      return;
    }
    if (!controller.allowsEvent(operation.event)) return;
    posthog.capture(operation.event, operation.properties);
  };
  const reportOperation: OperationReporter = reportEvent;
  const reportAppError: AppErrorReporter = reportEvent;
  reportPostHogOperation = reportOperation;
  reportPostHogAppError = reportAppError;
  const pendingExceptions: Array<{
    error: unknown;
    properties: DesktopInstrumentationContext | undefined;
  }> = [];
  // Handled errors only. SDK autocapture owns uncaught errors and rejections,
  // which before_send drops until the capture flag is known.
  const reportException: ExceptionReporter = (error, properties) => {
    if (disposed) return;
    if (!posthog || !controller) {
      if (!errorsPermitted()) return;
      pendingExceptions.push({ error, properties });
      if (pendingExceptions.length > MAX_PENDING_POSTHOG_EXCEPTIONS)
        pendingExceptions.shift();
      return;
    }
    if (!controller.allowsEvent('$exception')) return;
    posthog.captureException(error, properties);
  };
  reportPostHogException = reportException;
  const disposeOnUnload = (): void => {
    disposeClientAppErrorHandler();
    dispose();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (unloadInstalled && typeof window !== 'undefined') {
      window.removeEventListener('unload', disposeOnUnload);
      unloadInstalled = false;
    }
    if (posthogAppErrorSession === appErrorSession)
      posthogAppErrorSession = undefined;
    screenTracker?.dispose();
    if (reportPostHogFeatureFlagEvaluation === reportEvaluation)
      reportPostHogFeatureFlagEvaluation = undefined;
    if (reportPostHogOperation === reportOperation)
      reportPostHogOperation = undefined;
    if (reportPostHogAppError === reportAppError)
      reportPostHogAppError = undefined;
    if (reportPostHogException === reportException)
      reportPostHogException = undefined;
    if (isPostHogOperationStartEligible === eligibleStart)
      isPostHogOperationStartEligible = undefined;
    posthogOperations.discardAcquisitionStarts();
    pendingEvaluations.clear();
    reportedEvaluations.clear();
    pendingOperations.length = 0;
    pendingExceptions.length = 0;
    account?.dispose();
    unsubscribe?.();
    session?.dispose();
    controller?.dispose();
    releaseIdentityWait?.();
  };
  const discardRefusedPending = (): void => {
    if (!eventsPermitted()) {
      posthogOperations.discardAcquisitionStarts();
      pendingEvaluations.clear();
    }
    const keepEvents = eventsPermitted();
    const keepErrors = errorsPermitted();
    const kept = pendingOperations.filter((operation) =>
      isPostHogErrorEvent(operation.event) ? keepErrors : keepEvents,
    );
    pendingOperations.length = 0;
    pendingOperations.push(...kept);
    if (!keepErrors) pendingExceptions.length = 0;
  };
  disposePostHog = dispose;
  try {
    account = createPostHogAccountTracker(
      options.posthogAccount,
      (): void => undefined,
    );
    // Subscribe before reading, and never let a stale read undo a push.
    unsubscribe = options.posthogFlags?.onSnapshotChanged((next) => {
      if (disposed) return;
      // Close disabled-period folds while both the reporter and controller
      // still reject errors. The first eligible recurrence gets its own record.
      if (!errorsPermitted() && next.captureEnabled && next.errorReports) {
        appErrorHandler?.flush();
      }
      revision++;
      flags = next;
      waitingForFlags = false;
      discardRefusedPending();
      if (eventsPermitted() || errorsPermitted()) releaseIdentityWait?.();
      safelyInvoke(() => {
        controller?.update(next);
        screenTracker?.setCaptureEnabled(
          controller?.allowsEvent(POSTHOG_PAGEVIEW_EVENT) ?? false,
        );
      });
    });
    const initialRevision = revision;
    try {
      const initialFlags = await options.posthogFlags?.getSnapshot();
      if (revision === initialRevision) flags = initialFlags;
    } catch {
      // Unknown configuration is not the LaunchDarkly-unconfigured mode.
      // Remain closed; a later authoritative push can recover capture.
    }
    waitingForFlags = false;
    discardRefusedPending();
    // Asking the host for the identity creates `posthog-context.json`, so
    // wait while both categories are closed; a later push or dispose ends it.
    if (!disposed && !eventsPermitted() && !errorsPermitted()) {
      await new Promise<void>((resolve) => {
        releaseIdentityWait = resolve;
      });
      releaseIdentityWait = undefined;
    }
    if (disposed)
      return { enabled: false, provider: 'posthog', reason: 'disabled' };
    // The host owns this provider-specific UUID. Neither the SDK's own random
    // identity nor the account identity may be used as a fallback.
    const [module, anonymousId] = await Promise.all([
      import('posthog-js/dist/module.full.no-external'),
      options.getPostHogAnonymousId?.(),
    ]);
    if (
      !anonymousId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        anonymousId,
      )
    ) {
      throw new Error('PostHog anonymous identity is unavailable');
    }
    if (disposed)
      return { enabled: false, provider: 'posthog', reason: 'disabled' };
    posthog = module.default;
    if (!options.posthogSession)
      throw new Error('PostHog session bridge is unavailable');
    session = await connectPostHogSession(posthog, options.posthogSession);
    const surfaceRoute =
      options.surface === 'app-advisor'
        ? POSTHOG_APP_ADVISOR_ROUTE
        : POSTHOG_MAIN_ROUTE;
    const currentScreenRoute = (): PostHogRoute =>
      screenTracker?.route ?? surfaceRoute;
    const replayOptions =
      buildPostHogSessionRecordingOptions(currentScreenRoute);
    posthog.init(readiness.config.projectKey, {
      api_host: readiness.config.host,
      persistence: 'localStorage',
      bootstrap: {
        distinctID: anonymousId,
        isIdentifiedID: false,
        sessionID: session.sessionId,
      },
      opt_out_capturing_by_default: true,
      // Uncaught errors and unhandled rejections; console errors stay off.
      capture_exceptions: true,
      capture_performance: false,
      enable_recording_console_log: false,
      disable_surveys: true,
      disable_product_tours: true,
      disable_session_recording: true,
      session_recording: replayOptions,
      ...POSTHOG_CLICK_INIT_OPTIONS,
      capture_pageview: false,
      capture_pageleave: false,
      person_profiles: 'identified_only',
      // No remote configuration or extensions are needed for explicit events.
      // Pin both switches so an SDK/project default cannot add a CDN request.
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
      property_denylist: [...POSTHOG_PROPERTY_DENYLIST],
      before_send: (event) => {
        try {
          if (
            !event ||
            !controller?.allowsEvent(event.event) ||
            event.properties.distinct_id !== anonymousId ||
            event.event === '$identify' ||
            event.event === '$set' ||
            event.event === '$unset'
          )
            return null;
          if (event.event === '$exception') {
            const exceptions: unknown = event.properties.$exception_list;
            if (Array.isArray(exceptions) && exceptions.length === 1) {
              const exception: unknown = exceptions[0];
              if (
                exception &&
                typeof exception === 'object' &&
                'value' in exception &&
                exception.value ===
                  'ResizeObserver loop completed with undelivered notifications.'
              )
                return null;
            }
          }
          // Main alone owns the installation profile. SDK-cached person
          // properties must not restore an earlier account on a later event.
          const properties: Record<string, unknown> = { ...event.properties };
          delete properties.$set;
          delete properties.$set_once;
          const envelope = { ...event };
          delete envelope.$set;
          delete envelope.$set_once;
          // The account domain and person profile follow Usage analytics,
          // not Error reports, as they do in main.
          const domain = eventsPermitted() ? account?.domain : undefined;
          return (
            session?.filter(
              sanitizePostHogEvent(
                {
                  ...envelope,
                  properties: {
                    ...properties,
                    surface: options.surface,
                    $is_identified: false,
                    $process_person_profile: domain !== undefined,
                    ...(domain !== undefined && {
                      email_domain: domain,
                    }),
                  },
                },
                {
                  preserveBrowserProjectToken: true,
                  exceptionBuild: config,
                  ...(event.event === '$snapshot' && {
                    passthroughProperties: ['$snapshot_data'],
                  }),
                  screenRoute: currentScreenRoute(),
                },
              ),
            ) ?? null
          );
        } catch {
          // Fail closed: the SDK otherwise retains an event when a hook throws.
          return null;
        }
      },
    });
    const activeSession = session;
    controller = createPostHogRuntimeController(
      posthog,
      readiness.config,
      flags,
      replayOptions,
      (listener) => activeSession.onAdopted(listener),
    );
    activeSession.start();
    if (!disposed) {
      const sdk = posthog;
      const activeController = controller;
      appErrorSession = {
        getSessionId: (): unknown =>
          activeSession.allowsCapture() &&
          activeController.allowsEvent(APP_ERROR_POSTHOG_EVENT)
            ? sdk.get_session_id()
            : undefined,
        isRecording: (): unknown => sdk.sessionRecordingStarted(),
        getReplayUrl: (): unknown => sdk.get_session_replay_url(),
      };
      posthogAppErrorSession = appErrorSession;
    }
    if (options.posthogRoutes) {
      const sdk = posthog;
      screenTracker = createPostHogScreenTracker({
        sdk: posthog,
        source: options.posthogRoutes,
        captureEnabled: controller.allowsEvent(POSTHOG_PAGEVIEW_EVENT),
        allowsCapture: () => activeSession.allowsCapture(),
        onAdopted: (listener): (() => void) =>
          activeSession.onAdopted(listener),
        onCaptureAvailable: (listener): (() => void) =>
          activeSession.onCaptureAvailable(listener),
        onRouteLeave: (route): void => flushPostHogHeatmaps(sdk, route),
        ...(typeof window !== 'undefined' ? { pageLifecycle: window } : {}),
      });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('unload', disposeOnUnload, { once: true });
      unloadInstalled = true;
    }
    if (controller.allowsEvent('app_opened')) {
      posthog.capture('app_opened', { surface: options.surface });
    }
    pendingEvaluations.forEach((value, key) => {
      safelyInvoke(() => reportEvaluation(key, value));
    });
    pendingEvaluations.clear();
    pendingOperations.splice(0).forEach((operation) => {
      safelyInvoke(() => reportOperation(operation));
    });
    pendingExceptions.splice(0).forEach(({ error, properties }) => {
      safelyInvoke(() => reportException(error, properties));
    });
    return { enabled: true, provider: 'posthog' };
  } catch (error) {
    dispose();
    if (disposePostHog === dispose) disposePostHog = undefined;
    return {
      enabled: false,
      provider: 'posthog',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const posthogOperations = createPostHogOperationTracker({
  appVersion: getDesktopInstrumentationConfig().appVersion,
});
let operationSurface: DesktopInstrumentationClientInitOptions['surface'] =
  'main';

function forwardPostHogOperation(
  name: DesktopOperationName,
  outcome: DesktopOperationOutcome,
  options: DesktopInstrumentationOperationOptions | undefined,
): void {
  safelyInvoke(() => {
    // Finish even without a reporter so the start time is released.
    const operation = posthogOperations.finish(
      name,
      outcome,
      operationSurface,
      options,
    );
    if (!operation || !reportPostHogOperation) return;
    reportPostHogOperation({
      event: operation.event,
      properties:
        sanitizeInstrumentationContext(operation.properties) ??
        operation.properties,
    });
  });
}

export async function initializeDesktopInstrumentationClient(
  options: DesktopInstrumentationClientInitOptions,
): Promise<DesktopInstrumentationInitResult[]> {
  const report = (
    result: DesktopInstrumentationInitResult,
  ): DesktopInstrumentationInitResult => {
    safelyInvoke(() => options.onProviderInitialized?.(result));
    return result;
  };
  operationSurface = options.surface;
  return [
    await (posthogInitialization ??= initializePostHogClient(options)).then(
      report,
    ),
  ];
}

export function startClientOperation(
  name: DesktopOperationName,
  options?: DesktopInstrumentationOperationOptions,
): void {
  safelyInvoke(() =>
    posthogOperations.start(
      name,
      options,
      isPostHogOperationStartEligible?.() ?? false,
    ),
  );
}

export function succeedClientOperation(
  name: DesktopOperationName,
  options?: DesktopInstrumentationOperationOptions,
): void {
  forwardPostHogOperation(name, { status: 'success' }, options);
}

export function failClientOperation(
  name: DesktopOperationName,
  failureReason: DesktopInstrumentationFailureReason,
  options?: DesktopInstrumentationOperationOptions,
): void {
  forwardPostHogOperation(name, { status: 'failure', failureReason }, options);
}

/**
 * Reports a handled error as a PostHog `$exception`. Uncaught errors and
 * unhandled rejections reach PostHog through SDK autocapture; do not route
 * them here as well, or each would be reported twice.
 */
export function captureClientInstrumentationError(
  error: unknown,
  options?: DesktopInstrumentationErrorOptions,
): void {
  safelyInvoke(() =>
    reportPostHogException?.(
      error,
      sanitizeInstrumentationContext(options?.context),
    ),
  );
}

export function addClientFeatureFlagEvaluation(
  key: string,
  value: DesktopInstrumentationFeatureFlagValue,
): void {
  if (value === undefined) return;
  safelyInvoke(() => reportPostHogFeatureFlagEvaluation?.(key, value));
}

const appErrorSessions: AppErrorTelemetrySessions = {
  posthog: {
    getSessionId: () => posthogAppErrorSession?.getSessionId(),
    isRecording: () => posthogAppErrorSession?.isRecording(),
    getReplayUrl: () => posthogAppErrorSession?.getReplayUrl(),
  },
};

function captureAppErrorInPostHog(
  record: AppErrorRecord,
  frames: readonly string[],
  thrownType?: AppErrorThrownType,
): void {
  const properties = buildAppErrorPostHogProperties(record);
  reportPostHogAppError?.({ event: APP_ERROR_POSTHOG_EVENT, properties });
  if (!record.isRepeatSummary) {
    reportPostHogException?.(
      appErrorException(record, frames),
      thrownType === undefined
        ? properties
        : { ...properties, thrown_type: thrownType },
    );
  }
}

let appErrorHandler: AppErrorHandler | undefined;

function createClientAppErrorHandler(appVersion: string): AppErrorHandler {
  return createAppErrorHandler({
    host: 'renderer',
    appVersion,
    sinks: [],
    diagnosticSink: captureAppErrorInPostHog,
  });
}

/** Created on first use so importing this module starts nothing. */
export function getClientAppErrorHandler(): AppErrorHandler {
  if (appErrorHandler) return appErrorHandler;
  const appVersion = getDesktopInstrumentationConfig().appVersion ?? 'unknown';
  try {
    appErrorHandler = createClientAppErrorHandler(appVersion);
  } catch {
    // An unusable build version must not stop errors from being classified.
    appErrorHandler = createClientAppErrorHandler('unknown');
  }
  return appErrorHandler;
}

type ClientAppErrorResolver = (value: unknown) => AppError | undefined;

let appErrorResolverRegistration: {
  readonly resolver: ClientAppErrorResolver;
} | null = null;

/**
 * Lets the host swap a caught value for the shape its origin already built, so
 * a failure another process recorded is not recorded again. The returned
 * uninstaller only removes its own registration, so a stale one cannot remove a
 * newer install.
 */
export function setClientAppErrorResolver(
  resolver: ClientAppErrorResolver,
): () => void {
  const own = { resolver };
  appErrorResolverRegistration = own;
  return (): void => {
    if (appErrorResolverRegistration === own)
      appErrorResolverRegistration = null;
  };
}

const MAX_VIEWED_APP_ERROR_REFERENCES = 128;
const viewedAppErrorReferences = new Set<string>();

/**
 * `recordedBy` keeps this renderer from recording a second failure, which would
 * also lose its link to this session's replay. This marker keeps the link.
 */
function linkRecordedAppErrorToSession(error: AppError): void {
  if (
    error.recordedBy === undefined ||
    !reportPostHogAppError ||
    viewedAppErrorReferences.has(error.referenceId)
  )
    return;
  if (viewedAppErrorReferences.size >= MAX_VIEWED_APP_ERROR_REFERENCES) {
    const oldest = viewedAppErrorReferences.values().next();
    if (!oldest.done) viewedAppErrorReferences.delete(oldest.value);
  }
  viewedAppErrorReferences.add(error.referenceId);
  reportPostHogAppError({
    event: APP_ERROR_VIEW_POSTHOG_EVENT,
    properties: buildAppErrorViewPostHogProperties(
      error,
      getDesktopInstrumentationConfig().appVersion ?? 'unknown',
    ),
  });
}

/** Never throws: a failed lookup keeps the caught value. */
export function resolveClientAppError(value: unknown): unknown {
  try {
    const resolved = appErrorResolverRegistration?.resolver(value);
    if (!resolved) return value;
    safelyInvoke(() => linkRecordedAppErrorToSession(resolved));
    return resolved;
  } catch {
    // The caught value still reaches the existing classification.
    return value;
  }
}

export function reportClientAppError(
  value: unknown,
  options?: AppErrorReportOptions,
): AppErrorReport | undefined {
  try {
    return getClientAppErrorHandler().report(
      resolveClientAppError(value),
      options,
    );
  } catch (error) {
    // Recovery must survive unavailable configuration, clocks or randomness.
    // Do not recursively report a failure of the reporting infrastructure.
    captureClientInstrumentationError(error);
    return undefined;
  }
}

/** Validated session links for an error caught right now. */
export function readClientErrorTelemetry(): FeedbackReportTelemetry {
  return buildFeedbackReportTelemetry(appErrorSessions);
}

/** Flushes pending summaries; the next use reads current configuration. */
export function disposeClientAppErrorHandler(): void {
  appErrorHandler?.dispose();
  appErrorHandler = undefined;
  viewedAppErrorReferences.clear();
}
