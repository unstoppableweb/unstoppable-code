import { showsRawErrorDetail } from '@canopy/protocol/app-errors';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  FeedbackDiagnosticsExpiredError,
  FeedbackOutcomeUnknownError,
  FeedbackReportResultSchema,
  FeedbackSubmissionConflictError,
  type FeedbackReportClient,
  type FeedbackReportContext,
  type FeedbackReportError,
  type FeedbackReportResult,
} from '@canopy/protocol/feedback-report';
import type {
  FeedbackArea,
  FeedbackPrepareRequest,
} from '@canopy/desktop-shared/types';
import { extractIpcErrorMessage } from '@/lib/errors';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/**
 * Build the slim, serializable UI-context snapshot attached to a feedback
 * report. Reads the already-sanitized current-UI-state envelope that App
 * Advisor also uses, so no free-form transcript or file content can leak in.
 */
function buildFeedbackContext(): FeedbackReportContext {
  const snapshot = useCurrentUiStateStore.getState().envelope.snapshot;
  const worktree = snapshot.selectedWorktree;
  const chat = snapshot.activeChat;
  const workspaceName = worktree?.workspaceDisplayName ?? worktree?.projectName;
  // The standalone-chat project id is not part of the sanitized UI snapshot, so
  // read it directly from its store. Only meaningful on the standalone chat
  // page, where it lets diagnostics attach that chat project's transcripts.
  const chatProjectId =
    snapshot.activePage === 'chat'
      ? useStandaloneChatStore.getState().activeChatProjectId
      : undefined;
  return {
    ...(snapshot.activePage ? { activePage: snapshot.activePage } : {}),
    ...(worktree?.projectId ? { workspaceId: worktree.projectId } : {}),
    ...(workspaceName ? { workspaceName } : {}),
    ...(worktree?.worktreeId ? { worktreeId: worktree.worktreeId } : {}),
    ...(worktree?.worktreeName ? { worktreeName: worktree.worktreeName } : {}),
    ...(chatProjectId ? { chatProjectId } : {}),
    ...(chat?.chatId ? { chatId: chat.chatId } : {}),
    ...(chat?.providerType ? { provider: chat.providerType } : {}),
    ...(chat?.model ? { model: chat.model } : {}),
    ...(typeof window.platform === 'string'
      ? { platform: window.platform }
      : {}),
  };
}

function mapContextToArea(context: FeedbackReportContext): FeedbackArea {
  switch (context.activePage) {
    case 'pipelines':
    // The Library is where the Pipelines page went (CAN-3981).
    case 'workflows-library':
      return 'pipelines';
    case 'plugins':
      return 'plugins';
    case 'audit':
    case 'audit-trail':
      return 'audit-trail';
    case 'usage':
      return 'usage';
    case 'settings':
      return 'settings';
    case 'chat':
      return 'chat';
    case 'main':
      return context.worktreeId ? 'worktrees' : 'overview';
    default:
      return 'overview';
  }
}

/**
 * Best-effort mapping of the captured context onto a `prepareFeedback` request
 * for an older host's offline fallback. Mirrors the backend's context→area
 * mapping; core diagnostics are always included.
 */
function buildFallbackPrepareRequest(
  context: FeedbackReportContext,
  description: string,
  error: FeedbackReportError | undefined,
): FeedbackPrepareRequest {
  const area = mapContextToArea(context);
  const base = { description, area, ...(error ? { error } : {}) };
  if (area === 'worktrees' && context.workspaceId && context.worktreeId) {
    return {
      ...base,
      workspaceSelections: [
        {
          workspaceId: context.workspaceId,
          worktreeIds: [context.worktreeId],
        },
      ],
      includeChatDetails: true,
    };
  }
  if (area === 'chat' && context.chatProjectId) {
    return {
      ...base,
      chatProjectIds: [context.chatProjectId],
      includeChatDetails: true,
    };
  }
  return base;
}

interface HostFeedbackCapabilities {
  /** The host has the exact-snapshot channels. */
  readonly snapshots: boolean;
  /** The host accepts `source` on report errors (CAN-6895). */
  readonly errorSource: boolean;
}

/**
 * One probe of the host executing these calls. Not cached: Remote Control can
 * switch hosts between calls.
 */
async function probeHostCapabilities(): Promise<HostFeedbackCapabilities> {
  try {
    const capabilities = await window.api.feedbackDiagnosticsCapabilities();
    const snapshots =
      capabilities.snapshots === true && capabilities.version === 1;
    return {
      snapshots,
      errorSource: snapshots && capabilities.errorSource === true,
    };
  } catch (error) {
    reportClientAppError(error);
    // An older host refuses the unknown channel.
    return { snapshots: false, errorSource: false };
  }
}

/**
 * Older hosts parse report errors strictly and reject an unknown `source` key,
 * even one set to undefined, so omit the key unless the host accepts it.
 */
function errorForHost(
  error: FeedbackReportError | undefined,
  errorSource: boolean,
): FeedbackReportError | undefined {
  if (error === undefined || errorSource || !('source' in error)) return error;
  const { source, ...rest } = error;
  void source;
  return rest;
}

const SNAPSHOT_GONE_PATTERN =
  /Prepare a new (diagnostics )?preview|Prepare diagnostics again|Reopen the report/;
// By name: the remote tunnel wraps the rejection again, so it isn't always first.
const OUTCOME_UNKNOWN_PATTERN = /\bFeedbackOutcomeUnknownError\b/;
const SUBMISSION_CONFLICT_PATTERN = /\bFeedbackSubmissionConflictError\b/;
const ERROR_REPORT_UNAVAILABLE_COPY =
  'Error reporting is unavailable. Reconnect or update the app, then try again.';

/** Electron flattens handler errors to strings; restore what the UI acts on. */
function toReportError(error: unknown): Error {
  if (
    error instanceof FeedbackDiagnosticsExpiredError ||
    error instanceof FeedbackOutcomeUnknownError ||
    error instanceof FeedbackSubmissionConflictError
  )
    return error;
  const message = extractIpcErrorMessage(error);
  if (SNAPSHOT_GONE_PATTERN.test(message))
    return new FeedbackDiagnosticsExpiredError(message);
  const raw = error instanceof Error ? error.message : '';
  if (OUTCOME_UNKNOWN_PATTERN.test(raw))
    return new FeedbackOutcomeUnknownError(message);
  if (SUBMISSION_CONFLICT_PATTERN.test(raw))
    return new FeedbackSubmissionConflictError(message);
  return new Error(message);
}

async function withReportErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toReportError(error);
  }
}

function toResult(response: unknown): FeedbackReportResult {
  const parsed = FeedbackReportResultSchema.safeParse(response);
  return parsed.success ? parsed.data : {};
}

export function createDesktopFeedbackReportClient(): FeedbackReportClient {
  return {
    diagnosticTextVisibility: showsRawErrorDetail({
      releaseFlavor: __CANOPY_RELEASE_FLAVOR__,
      isDevelopment: process.env.NODE_ENV === 'development',
    })
      ? 'inline'
      : 'download-only',
    async draft() {
      // Read now, not after the awaits: this is where the person was.
      const context = buildFeedbackContext();
      const [appVersion, { snapshots }, account] = await Promise.all([
        // App version is best-effort; omit it on failure.
        window.api.update.getAppVersion().catch((error: unknown) => {
          reportClientAppError(error);
          return undefined;
        }),
        probeHostCapabilities(),
        Promise.resolve()
          .then(() => window.api.loadCanopyCloudAccount())
          .catch((error: unknown) => {
            reportClientAppError(error);
            return null;
          }),
      ]);
      return {
        context: {
          ...context,
          ...(typeof appVersion === 'string' && appVersion.length > 0
            ? { appVersion }
            : {}),
        },
        diagnostics: snapshots ? 'snapshot' : 'host-collected',
        errorReports:
          snapshots &&
          account?.hasApiKey === true &&
          (account.read === undefined || account.read === 'ok') &&
          !isGuestAccount(account),
      };
    },
    submit(request) {
      return withReportErrors(async () => {
        const { snapshots, errorSource } = await probeHostCapabilities();
        if (!snapshots && request.error)
          throw new Error(ERROR_REPORT_UNAVAILABLE_COPY);
        // A disconnected/replaced host cannot turn an inspected archive into
        // a fresh legacy collection. Ordinary old-host feedback still works.
        if (!snapshots && request.diagnosticsSnapshotId)
          throw new FeedbackDiagnosticsExpiredError();
        if (!snapshots)
          return toResult(await window.api.submitFeedback(request));
        const { error, ...rest } = request;
        const hostError = errorForHost(error, errorSource);
        return toResult(
          await window.api.submitFeedbackReport(
            hostError ? { ...rest, error: hostError } : rest,
          ),
        );
      });
    },
    prepareDiagnostics: ({ error, ...request }) =>
      withReportErrors(async () => {
        // Probe only when there is a key to gate, so other previews keep their
        // single round trip.
        const errorSource =
          error !== undefined && 'source' in error
            ? (await probeHostCapabilities()).errorSource
            : false;
        const hostError = errorForHost(error, errorSource);
        return window.api.prepareFeedbackDiagnostics(
          hostError ? { ...request, error: hostError } : request,
        );
      }),
    readDiagnosticsEntry: (snapshotId, entryPath) =>
      withReportErrors(() =>
        window.api.readFeedbackDiagnosticsEntry(snapshotId, entryPath),
      ),
    saveDiagnostics: (snapshotId) =>
      withReportErrors(() => window.api.saveFeedbackDiagnostics(snapshotId)),
    releaseDiagnostics: (snapshotId) =>
      withReportErrors(() => window.api.releaseFeedbackDiagnostics(snapshotId)),
    saveCollectedDiagnostics: ({ context, description, error }) =>
      withReportErrors(async () => {
        const capabilities = error ? await probeHostCapabilities() : undefined;
        if (capabilities && !capabilities.snapshots)
          throw new Error(ERROR_REPORT_UNAVAILABLE_COPY);
        const prepared = await window.api.prepareFeedback(
          buildFallbackPrepareRequest(
            context,
            description,
            errorForHost(error, capabilities?.errorSource === true),
          ),
        );
        await window.api.showInFinder({ absolutePath: prepared.absolutePath });
        return { filename: prepared.filename };
      }),
  };
}
