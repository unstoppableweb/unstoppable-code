import { BRAND } from '@canopy/brand/current';
import type {
  SharedRunCommentAnchor,
  SharedRunCommentThreadStatus,
  SharedRunCreateRequest,
  SharedRunDetail,
  SharedRunRef,
  SharedRunUnshareResult,
} from '@canopy/protocol/runs';
import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
  requestCanopyCloudJson,
  type CanopyCloudJsonRequestInit,
} from '../canopy-cloud/client';

/** `beforeRequest` runs just before the write leaves the process. */
type CommentWriteInit = Pick<CanopyCloudJsonRequestInit, 'beforeRequest'>;

const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;
const RUNS_CAPABILITY = 'runs-crud-v1';
/**
 * Two-way run comments (CAN-397) are their own capability, NOT part of
 * `runs-crud-v1`: every already-deployed Canopy Cloud advertises run CRUD but
 * has no comment routes, so reusing that capability would make a newer desktop
 * call endpoints that 404. Gating on this instead lets a desktop pointed at an
 * older server degrade to "no comments".
 */
const RUN_COMMENTS_CAPABILITY = 'run-comments-v1';

export async function createSharedRun(
  request: SharedRunCreateRequest,
): Promise<SharedRunRef> {
  await assertCanopyCloudCapability(RUNS_CAPABILITY);
  return requestCanopyCloudJson<SharedRunRef>(`${API_PREFIX}/runs`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function getSharedRun(remoteId: string): Promise<SharedRunDetail> {
  await assertCanopyCloudCapability(RUNS_CAPABILITY);
  return requestCanopyCloudJson<SharedRunDetail>(
    `${API_PREFIX}/runs/${encodeURIComponent(remoteId)}`,
  );
}

/**
 * Whether the connected Canopy Cloud advertises the run-comments capability.
 * Callers (the background poller, the comment IPC handlers) use this to degrade
 * to "no comments" against an older server instead of surfacing an error.
 */
export async function supportsRunComments(): Promise<boolean> {
  try {
    await assertCanopyCloudCapability(RUN_COMMENTS_CAPABILITY);
    return true;
  } catch {
    // Either the capability is genuinely absent or the capability probe could
    // not complete (offline / signed out). Both mean "no comments this tick";
    // a background poll must never throw.
    return false;
  }
}

/**
 * Throws unless the connected Canopy Cloud advertises run comments: the
 * capability's own refusal when it doesn't, or the probe's failure.
 */
export async function assertRunCommentsCapability(): Promise<void> {
  await assertCanopyCloudCapability(RUN_COMMENTS_CAPABILITY);
}

/** Author a new comment thread on a shared run (whole-run or message-anchored). */
export async function createRunCommentThread(
  remoteId: string,
  body: string,
  anchor?: SharedRunCommentAnchor,
  init?: CommentWriteInit,
): Promise<SharedRunDetail> {
  await assertCanopyCloudCapability(RUN_COMMENTS_CAPABILITY);
  return requestCanopyCloudJson<SharedRunDetail>(
    `${API_PREFIX}/runs/${encodeURIComponent(remoteId)}/comments`,
    {
      ...init,
      method: 'POST',
      body: JSON.stringify({ body, ...(anchor ? { anchor } : {}) }),
    },
  );
}

/** Reply to an existing comment thread on a shared run. */
export async function replyToRunCommentThread(
  remoteId: string,
  threadId: string,
  body: string,
  init?: CommentWriteInit,
): Promise<SharedRunDetail> {
  await assertCanopyCloudCapability(RUN_COMMENTS_CAPABILITY);
  return requestCanopyCloudJson<SharedRunDetail>(
    `${API_PREFIX}/runs/${encodeURIComponent(remoteId)}/comments/${encodeURIComponent(
      threadId,
    )}`,
    { ...init, method: 'POST', body: JSON.stringify({ body }) },
  );
}

/** Open or resolve a comment thread on a shared run. */
export async function setRunCommentThreadStatus(
  remoteId: string,
  threadId: string,
  status: SharedRunCommentThreadStatus,
  init?: CommentWriteInit,
): Promise<SharedRunDetail> {
  await assertCanopyCloudCapability(RUN_COMMENTS_CAPABILITY);
  return requestCanopyCloudJson<SharedRunDetail>(
    `${API_PREFIX}/runs/${encodeURIComponent(remoteId)}/comments/${encodeURIComponent(
      threadId,
    )}`,
    { ...init, method: 'PATCH', body: JSON.stringify({ status }) },
  );
}

/**
 * Unshare (hard-delete) a shared run by the desktop's authoritative
 * `clientLocalRunId`. The web route resolves the row via the
 * `(createdByUserId, clientLocalRunId)` unique, so the client never depends on
 * a locally-stored `externalId` that may be stale.
 *
 * Idempotent by design: the web route returns a uniform 404 for both "no such
 * grant" and "not authorized" so run existence is never leaked. Because the
 * desktop persists `SharedRunMetadata` locally, the Cloud row can legitimately
 * already be gone (unshared from another device, admin-deleted, or a
 * double-click race). We map that 404 onto `{ unshared: false }` — an
 * already-absent no-op — so callers can always converge the local "Shared"
 * indicator instead of surfacing a hard error and leaving it stuck.
 */
export async function unshareSharedRunByClientLocalId(
  clientLocalRunId: string,
): Promise<SharedRunUnshareResult> {
  await assertCanopyCloudCapability(RUNS_CAPABILITY);
  try {
    return await requestCanopyCloudJson<SharedRunUnshareResult>(
      `${API_PREFIX}/runs/${encodeURIComponent(clientLocalRunId)}`,
      { method: 'DELETE' },
    );
  } catch (error) {
    if (error instanceof CanopyCloudClientError && error.status === 404) {
      return { unshared: false };
    }
    throw error;
  }
}
