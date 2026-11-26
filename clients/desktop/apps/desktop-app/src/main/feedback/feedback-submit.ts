import { createHash, randomUUID } from 'node:crypto';
import {
  encodeFeedbackReportError,
  FEEDBACK_OUTCOME_UNKNOWN_CODE,
  FeedbackOutcomeUnknownError,
  FeedbackReferenceIdSchema,
  FeedbackReportSubmissionSchema,
  FeedbackSubmissionConflictError,
  type FeedbackReportErrorWire,
  type FeedbackReportTelemetry,
} from '@canopy/protocol/feedback-report';
import {
  withFeedbackDiagnostics,
  releaseFeedbackDiagnostics,
} from './feedback-snapshots';
import { buildFeedbackPrepareRequest } from './feedback-scope';
import { readFile, rm } from 'node:fs/promises';
import {
  FEEDBACK_REPORT_TYPES,
  type FeedbackContextSnapshot,
  type FeedbackSubmitRequest,
  type FeedbackSubmitResponse,
} from '@canopy/desktop-shared/types';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  cleanupStaleTemporaryFeedbackBundles,
  prepareFeedbackBundle,
  releaseTemporaryFeedbackBundle,
} from './feedback-bundle';

const FEEDBACK_REPORTS_PATH = '/api/v1/feedback/reports';
const FEEDBACK_ATTACHMENT_COMMIT_PATH =
  '/api/v1/feedback/reports/attachment-commit';
// Matches `MAX_FEEDBACK_UPLOAD_BYTES` in apps/web/src/lib/uploads/gcs-config.ts:
// the server issues no upload URL for a larger bundle.
const FEEDBACK_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Wire contract for the `POST /api/v1/feedback/reports` request body. Kept in
 * sync with the web route handler in
 * `apps/web/src/app/api/v1/feedback/reports/route.ts`.
 */
interface FeedbackReportCreatePayload {
  type: FeedbackSubmitRequest['type'];
  title?: string;
  description: string;
  context: FeedbackContextSnapshot;
  // Wire field intentionally named `attachDiagnostics`, not `includeDiagnostics`:
  // Unstoppable Domains' Fastly Next-Gen WAF flags the literal JSON key
  // `"includeDiagnostics":` as an attack signal and blocks the request at the
  // edge (403) before it reaches this route. The renderer/IPC field is still
  // `includeDiagnostics`; only the HTTP body key diverges. Keep this in sync
  // with `validateFeedbackReportBody` in apps/web.
  attachDiagnostics: boolean;
  diagnosticsSizeBytes?: number;
  error?: FeedbackReportErrorWire;
  telemetry?: FeedbackReportTelemetry;
  submissionId?: string;
}

interface FeedbackReportCreateResponse {
  // `reportId` (the internal issue id) stays inside the main process: it is only
  // used to commit the diagnostics attachment and is never surfaced to the
  // renderer/user. The backend also returns an issue identifier/URL, but we
  // deliberately do not read or forward them to avoid leaking internal details.
  reportId: string;
  referenceId?: string;
  diagnosticsStatus?: FeedbackSubmitResponse['diagnosticsStatus'];
  uploadUrl?: string;
  filePath?: string;
}

interface FeedbackAttachmentCommitResponse {
  ok: boolean;
}

/**
 * Orchestrates a first-class feedback submission:
 *   1. Build the diagnostics zip to a temp file (when requested).
 *   2. Create the Linear issue via the Canopy Cloud backend.
 *   3. Upload the zip to the GCS signed URL returned by step 2.
 *   4. Commit the attachment so the backend attaches it to the issue.
 *   5. Clean up the temp file and return a minimal success marker (no internal
 *      issue identifier or URL is surfaced to the renderer/user).
 *
 * Diagnostics upload/attachment is best-effort: a failure there does not fail
 * the submission because the issue has already been filed.
 */
const inFlight = new Map<
  string,
  { fingerprint: string; promise: Promise<FeedbackSubmitResponse> }
>();

export function submitFeedback(
  request: FeedbackSubmitRequest,
  options?: {
    owner: string;
    exact?: boolean;
    validateOwner?: () => Promise<void>;
  },
): Promise<FeedbackSubmitResponse> {
  const parsed = FeedbackReportSubmissionSchema.parse(request);
  if (options?.exact && !parsed.submissionId)
    throw new Error('A submission ID is required.');
  if (
    options?.exact &&
    parsed.includeDiagnostics &&
    !parsed.diagnosticsSnapshotId
  )
    throw new Error('Prepare a diagnostics preview before sending.');
  const key =
    parsed.submissionId && options
      ? `${options.owner}:${parsed.submissionId}`
      : undefined;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(parsed))
    .digest('hex');
  const existing = key ? inFlight.get(key) : undefined;
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new FeedbackSubmissionConflictError();
    return existing.promise;
  }
  if (key && inFlight.size >= 100)
    throw new Error('Too many feedback submissions are pending.');
  const promise =
    parsed.includeDiagnostics && parsed.diagnosticsSnapshotId
      ? withFeedbackDiagnostics(
          options?.owner ?? '',
          parsed.diagnosticsSnapshotId,
          async (path, metadata) => {
            const result = await submitPreparedFeedback(
              parsed,
              { path, sizeBytes: metadata.sizeBytes },
              options?.validateOwner,
            );
            if (result.diagnosticsStatus === 'attached')
              await releaseFeedbackDiagnostics(
                options?.owner ?? '',
                parsed.diagnosticsSnapshotId ?? '',
              );
            return result;
          },
          {
            context: parsed.context,
            ...(parsed.error ? { error: parsed.error } : {}),
          },
        )
      : submitPreparedFeedback(parsed, undefined, options?.validateOwner);
  if (key) {
    inFlight.set(key, { fingerprint, promise });
    void promise.then(
      (result) => {
        if (
          result.diagnosticsStatus === 'unavailable' ||
          result.diagnosticsStatus === 'pending'
        )
          inFlight.delete(key);
        else {
          const timer = setTimeout(() => inFlight.delete(key), 30 * 60 * 1000);
          timer.unref();
        }
      },
      () => inFlight.delete(key),
    );
  }
  return promise;
}

async function submitPreparedFeedback(
  request: FeedbackSubmitRequest,
  snapshot?: { path: string; sizeBytes: number },
  validateOwner?: () => Promise<void>,
): Promise<FeedbackSubmitResponse> {
  validateSubmitRequest(request);

  await validateOwner?.();
  const credentialContext = await resolveCanopyCloudCredentialContext();
  const description = request.description.trim();
  const title = request.title?.trim();

  let bundlePath = snapshot?.path;
  let bundleSizeBytes = snapshot?.sizeBytes;
  if (request.includeDiagnostics && !snapshot) {
    // The sweep is deliberately best-effort even if a host adapter fails.
    await cleanupStaleTemporaryFeedbackBundles().catch(() => undefined);
    try {
      const prepareRequest = buildFeedbackPrepareRequest(request, description);
      let bundle = await prepareFeedbackBundle(prepareRequest, {
        destination: 'temp',
      });
      if (bundle.sizeBytes > FEEDBACK_UPLOAD_MAX_BYTES) {
        // Preserve the legacy dump-only retry, including compressible contents
        // above preview limits that have always attached successfully.
        await discardTemporaryBundle(bundle.absolutePath);
        bundle = await prepareFeedbackBundle(prepareRequest, {
          destination: 'temp',
          includeCrashDumps: false,
        });
        if (bundle.sizeBytes > FEEDBACK_UPLOAD_MAX_BYTES) {
          await discardTemporaryBundle(bundle.absolutePath);
          bundle = await prepareFeedbackBundle(prepareRequest, {
            destination: 'temp',
            includeCrashDumps: false,
            bounded: true,
            oversizedRetryContext: request.context,
          });
        }
      }
      bundlePath = bundle.absolutePath;
      bundleSizeBytes = bundle.sizeBytes;
    } catch (error) {
      logMainProcessWarn('Feedback diagnostics preparation failed', {
        category: preparationFailureCategory(error),
      });
    }
  }

  try {
    const createPayload: FeedbackReportCreatePayload = {
      type: request.type,
      submissionId: request.submissionId ?? randomUUID(),
      ...(request.error
        ? { error: encodeFeedbackReportError(request.error) }
        : {}),
      ...(request.telemetry ? { telemetry: request.telemetry } : {}),
      description,
      context: request.context,
      attachDiagnostics: request.includeDiagnostics && bundlePath !== undefined,
      ...(title && title.length > 0 ? { title } : {}),
      ...(bundleSizeBytes !== undefined
        ? { diagnosticsSizeBytes: bundleSizeBytes }
        : {}),
    };

    const created = await requestCanopyCloudJson<FeedbackReportCreateResponse>(
      FEEDBACK_REPORTS_PATH,
      {
        method: 'POST',
        credentialContext,
        beforeRequest: validateOwner,
        body: JSON.stringify(createPayload),
      },
    ).catch(throwSubmissionFailure);

    // A 2xx without the existing filing acknowledgement may have created the
    // issue. Keep this intent available for recovery instead of claiming success.
    if (
      !created ||
      typeof created.reportId !== 'string' ||
      created.reportId.trim().length === 0
    )
      throw new FeedbackOutcomeUnknownError();

    let diagnosticsStatus =
      created.diagnosticsStatus ??
      (request.includeDiagnostics ? 'unavailable' : 'not-requested');
    if (
      bundlePath !== undefined &&
      created.uploadUrl !== undefined &&
      created.filePath !== undefined
    ) {
      diagnosticsStatus = await uploadAndCommitDiagnostics({
        bundlePath,
        credentialContext,
        validateOwner,
        uploadUrl: created.uploadUrl,
        filePath: created.filePath,
        reportId: created.reportId,
      });
    }

    // The issue is filed; an unreadable reference is simply not shown.
    const referenceId = FeedbackReferenceIdSchema.safeParse(
      created.referenceId,
    );
    return {
      submitted: true,
      diagnosticsStatus,
      ...(referenceId.success ? { referenceId: referenceId.data } : {}),
    };
  } finally {
    if (bundlePath !== undefined && !snapshot) {
      await discardTemporaryBundle(bundlePath);
    }
  }
}

/**
 * Names the two failures the form acts on, matching the web adapter. They cross
 * IPC and the remote tunnel as `name: message` strings; the server's prose does
 * not identify them.
 */
function throwSubmissionFailure(error: unknown): never {
  if (error instanceof CanopyCloudClientError) {
    // A lost response may still have filed the report.
    if (
      error.serverCode === FEEDBACK_OUTCOME_UNKNOWN_CODE ||
      error.code === 'network-error' ||
      error.code === 'invalid-response'
    )
      throw new FeedbackOutcomeUnknownError();
    if (error.status === 409) throw new FeedbackSubmissionConflictError();
  }
  throw error;
}

async function discardTemporaryBundle(bundlePath: string): Promise<void> {
  try {
    await rm(bundlePath, { force: true }).catch(() => undefined);
  } finally {
    releaseTemporaryFeedbackBundle(bundlePath);
  }
}

async function uploadAndCommitDiagnostics(params: {
  bundlePath: string;
  credentialContext: CanopyCloudCredentialContext;
  validateOwner?: () => Promise<void>;
  uploadUrl: string;
  filePath: string;
  reportId: string;
}): Promise<'attached' | 'unavailable'> {
  try {
    await params.validateOwner?.();
    const bytes = await readFile(params.bundlePath);
    const uploadResponse = await fetch(params.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(bytes.byteLength),
      },
      body: bytes,
    });
    if (!uploadResponse.ok) return 'unavailable';
    const committed =
      await requestCanopyCloudJson<FeedbackAttachmentCommitResponse>(
        FEEDBACK_ATTACHMENT_COMMIT_PATH,
        {
          method: 'POST',
          credentialContext: params.credentialContext,
          beforeRequest: params.validateOwner,
          body: JSON.stringify({
            reportId: params.reportId,
            filePath: params.filePath,
          }),
        },
      );
    return committed.ok ? 'attached' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function validateSubmitRequest(request: FeedbackSubmitRequest): void {
  if (!FEEDBACK_REPORT_TYPES.includes(request.type)) {
    throw new Error(`Invalid feedback report type: ${request.type}`);
  }
  if (
    typeof request.description !== 'string' ||
    request.description.trim().length === 0
  ) {
    throw new Error('Feedback description is required');
  }
}

function preparationFailureCategory(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'missing';
    case 'EACCES':
    case 'EPERM':
      return 'inaccessible';
    case 'EMFILE':
    case 'ENFILE':
      return 'resource-limit';
    case 'ENOSPC':
    case 'EIO':
      return 'io';
    default:
      return 'unknown';
  }
}
