import { BRAND } from '@canopy/brand/current';
import {
  boundShareFailureMessage,
  type ShareFailure,
  type ShareFailureCommitState,
  type ShareFailureKind,
  type ShareFailureStage,
  type ShareOperationResult,
} from '@canopy/protocol/sharing';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { trackCloudWrites } from '../canopy-cloud/cloud-write-tracking';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { RESOURCE_REFUSAL } from '../lib/resource-context-error';

const CLOUD_DISPLAY_NAME = `${BRAND.displayName} Cloud`;

const GENERIC_MESSAGE: Record<ShareFailureKind, string> = {
  authentication: `Sign in to ${CLOUD_DISPLAY_NAME} again to share.`,
  'organization-plan': 'This organization has no active plan.',
  permission: "You don't have permission to share with this audience.",
  conflict: 'This item changed on the server. Review it and try again.',
  'dependency-review':
    'The included files changed. Review them, then share again.',
  connection: `Couldn't reach ${CLOUD_DISPLAY_NAME}. Check your connection and try again.`,
  unavailable: 'Sharing is unavailable for this item.',
  unknown: "Couldn't share. Try again.",
};

/**
 * Error a share operation throws when it already knows the category and has a
 * user-safe message. Every other non-Cloud error is reported generically.
 */
export class ShareOperationError extends Error {
  constructor(
    readonly kind: ShareFailureKind,
    message: string,
    readonly stage?: ShareFailureStage,
  ) {
    super(message);
    this.name = 'ShareOperationError';
  }
}

/**
 * A blocked analysis: a file it can't take, or a dependency it can't
 * resolve. Still `dependency-review` for shares; a cloud copy tells it apart
 * from an analysis that went stale (CAN-6176).
 */
export class PackageAnalysisBlockedError extends ShareOperationError {
  constructor() {
    super(
      'dependency-review',
      'Dependencies are not ready to package. Resolve the listed problems first.',
      'prepare',
    );
    this.name = 'PackageAnalysisBlockedError';
  }
}

/** Tags an error with the share stage it escaped from. */
export class ShareStageError extends Error {
  constructor(
    readonly stage: ShareFailureStage,
    readonly failureCause: unknown,
  ) {
    super(
      failureCause instanceof Error
        ? failureCause.message
        : 'Share step failed.',
    );
    this.name = 'ShareStageError';
  }
}

/** Run `task`, tagging any failure with `stage` unless it already has one. */
export async function withShareStage<T>(
  stage: ShareFailureStage,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof ShareStageError) throw error;
    throw new ShareStageError(stage, error);
  }
}

/**
 * Connection failures are retryable before resource publication. Once a
 * publish request may have reached the server, its outcome is uncertain, and
 * after publication the share has landed; repeating either could duplicate it.
 */
function connectionFailureState(stage: ShareFailureStage): {
  commitState: ShareFailureCommitState;
  retryable: boolean;
} {
  if (stage === 'publish') return { commitState: 'unknown', retryable: false };
  // A landed share is never repeated: a retry could duplicate it.
  if (stage === 'finish') return { commitState: 'committed', retryable: false };
  return { commitState: 'not-committed', retryable: true };
}

function isConnectionStatus(status: number | undefined): boolean {
  return (
    status === undefined || status === 408 || status === 429 || status >= 500
  );
}

/** What the classifier knows about the operation a failure escaped from. */
export interface ShareFailureContext {
  /**
   * Whether the operation sent a Cloud write before failing. Track it with
   * {@link runClassifiedShare} rather than assuming nothing was written.
   */
  writeSent: boolean;
}

function cloudFailure(
  error: CanopyCloudClientError,
  requestedStage: ShareFailureStage,
  writeSent: boolean,
): ShareFailure {
  // A read that fails before any write (an owner lookup, a capability probe)
  // is a pre-flight failure rather than an uncertain publication. After a
  // write, a failed read (a rollback's pre-read) cannot prove that.
  const stage =
    requestedStage === 'publish' && error.failedRead && !writeSent
      ? 'access'
      : requestedStage;
  const metadata = {
    ...(error.status !== undefined ? { httpStatus: error.status } : {}),
    ...(error.serverCode !== undefined ? { serverCode: error.serverCode } : {}),
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    ...(error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
  const definite = (
    kind: ShareFailureKind,
    message: string,
    extra: Pick<ShareFailure, 'organizationId' | 'reason'> = {},
  ): ShareFailure => ({
    version: 1,
    kind,
    stage,
    message: boundShareFailureMessage(message),
    commitState: stage === 'finish' ? 'committed' : 'not-committed',
    retryable: false,
    ...metadata,
    ...extra,
  });
  const serverMessage = error.isValidatedServerError
    ? stripStatusPrefix(error.message)
    : undefined;

  if (error.code === 'cloud-not-configured' || error.code === 'missing-api-key')
    return definite('authentication', GENERIC_MESSAGE.authentication);
  if (error.code === 'unsupported-capability')
    return definite('unavailable', GENERIC_MESSAGE.unavailable);

  // Only the server's explicit `reason` identifies a billing lapse. The
  // shipped `telemetry_scope_prohibited` code is also sent for organization
  // data-sharing policy refusals, so it never implies a plan problem.
  if (error.serverReason === 'org_teams_lapsed')
    return definite(
      'organization-plan',
      serverMessage ?? GENERIC_MESSAGE['organization-plan'],
      {
        reason: 'org_teams_lapsed',
        ...(error.serverOrganizationId !== undefined
          ? { organizationId: error.serverOrganizationId }
          : {}),
      },
    );

  // A viewer role can read shared resources but not publish them; the
  // dialog explains the role rather than the audience.
  if (error.serverReason === 'publisher_role_required')
    return definite('permission', serverMessage ?? GENERIC_MESSAGE.permission, {
      reason: 'publisher_role_required',
    });

  if (error.isValidatedServerError && error.status !== undefined) {
    if (error.status === 401)
      return definite('authentication', GENERIC_MESSAGE.authentication);
    if (error.status === 403)
      return definite(
        'permission',
        serverMessage ?? GENERIC_MESSAGE.permission,
      );
    if (error.status === 409)
      return definite('conflict', serverMessage ?? GENERIC_MESSAGE.conflict);
    if (error.status === 404 || error.status === 426)
      return definite(
        'unavailable',
        serverMessage ?? GENERIC_MESSAGE.unavailable,
      );
    if (!isConnectionStatus(error.status))
      return definite('unknown', serverMessage ?? GENERIC_MESSAGE.unknown);
  }

  // Network failures, timeouts, throttling, 5xx and unvalidated HTTP
  // responses (gateways, captive portals) are all connection problems.
  return {
    version: 1,
    kind: 'connection',
    stage,
    message: GENERIC_MESSAGE.connection,
    ...connectionFailureState(stage),
    ...metadata,
  };
}

function stripStatusPrefix(message: string): string {
  return message.replace(/^HTTP \d{3}: /, '');
}

/**
 * Classify a share failure for transport to a share dialog. Credentials,
 * local paths, file contents and stacks never leave: non-Cloud errors are
 * reported with a generic message unless they are a {@link ShareOperationError}.
 */
export function shareFailureFromError(
  error: unknown,
  stage: ShareFailureStage,
  context: ShareFailureContext,
): ShareFailure {
  const { writeSent } = context;
  if (error instanceof ShareStageError)
    return shareFailureFromError(error.failureCause, error.stage, context);
  if (error instanceof CanopyCloudClientError)
    return cloudFailure(error, stage, writeSent);
  if (error instanceof ShareOperationError) {
    const failureStage = error.stage ?? stage;
    return {
      version: 1,
      kind: error.kind,
      stage: failureStage,
      message: boundShareFailureMessage(error.message),
      ...(error.kind === 'connection'
        ? connectionFailureState(failureStage)
        : {
            commitState:
              failureStage === 'finish' ? 'committed' : 'not-committed',
            retryable: false,
          }),
    };
  }
  if (
    !(stage === 'publish' && writeSent) &&
    error instanceof Error &&
    RESOURCE_REFUSAL.test(error.message.trim())
  ) {
    // Resource-context refusals are path-free by construction; before
    // publication they are definite, and the share dialog maps their reason
    // to a sentence. One raised while publishing after a write (recording a
    // shared agent's install) may follow a share that landed, so it falls
    // through to the uncertain outcome below.
    return {
      version: 1,
      kind: 'unavailable',
      stage,
      message: boundShareFailureMessage(error.message.trim()),
      commitState: 'not-committed',
      retryable: false,
    };
  }
  return {
    version: 1,
    kind: 'unknown',
    stage,
    message: GENERIC_MESSAGE.unknown,
    // A non-Cloud failure during publication is uncertain only once a Cloud
    // write may have reached the server; before that nothing was published.
    commitState:
      stage === 'publish' && writeSent
        ? 'unknown'
        : stage === 'finish'
          ? 'committed'
          : 'not-committed',
    retryable: false,
  };
}

/**
 * Run a share handler body and return its result as a
 * {@link ShareOperationResult}, so structured failures survive IPC (which
 * serializes rejections as message strings only).
 */
export async function toShareOperationResult<T>(
  task: () => Promise<T>,
  stage: ShareFailureStage = 'publish',
): Promise<ShareOperationResult<T>> {
  const outcome = await runClassifiedShare(task, stage);
  return outcome.ok
    ? { ok: true, value: outcome.value }
    : { ok: false, failure: outcome.failure };
}

/**
 * Run a share handler body, classifying a failure with whether the body had
 * sent a Cloud write. For handlers that report failures in their own result
 * shape; the original error is kept for their legacy message.
 */
export async function runClassifiedShare<T>(
  task: () => Promise<T>,
  stage: ShareFailureStage = 'publish',
): Promise<
  { ok: true; value: T } | { ok: false; error: unknown; failure: ShareFailure }
> {
  const tracked = trackCloudWrites(task);
  try {
    return { ok: true, value: await tracked.result };
  } catch (error) {
    const writeSent = tracked.writeSent();
    const failure = shareFailureFromError(error, stage, { writeSent });
    // Handlers resolve failures instead of rejecting, so this is the only
    // main-process trace. No messages, paths or contents.
    logMainProcessWarn('[sharing] Share failed', {
      stage: failure.stage,
      kind: failure.kind,
      commitState: failure.commitState,
      writeSent,
      errorName: shareErrorName(error),
      ...(failure.httpStatus !== undefined
        ? { httpStatus: failure.httpStatus }
        : {}),
      ...(failure.serverCode !== undefined
        ? { serverCode: failure.serverCode }
        : {}),
      ...(failure.requestId !== undefined
        ? { requestId: failure.requestId }
        : {}),
    });
    return { ok: false, error, failure };
  }
}

function shareErrorName(error: unknown): string {
  const cause = error instanceof ShareStageError ? error.failureCause : error;
  return cause instanceof Error ? cause.name : typeof cause;
}
