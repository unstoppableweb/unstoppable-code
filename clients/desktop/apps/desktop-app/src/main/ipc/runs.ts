import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { ShareOperationResult } from '@canopy/protocol/sharing';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  PUBLICATION_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { toShareOperationResult } from '../sharing/share-operation-result';
import {
  IPC_CHANNELS,
  type CreateRunCommentThreadRequest,
  type ListRunCommentsRequest,
  type ListRunCommentsResponse,
  type MarkRunCommentsSeenRequest,
  type MarkRunCommentsSeenResponse,
  type ReplyRunCommentThreadRequest,
  type RunCommentMutationResponse,
  type SetRunCommentThreadStatusRequest,
  type ShareRunEligibilityRequest,
  type ShareRunEligibilityResponse,
  type ShareRunRequest,
  type ShareRunResponse,
  type UnshareRunRequest,
  type UnshareRunResponse,
} from '@canopy/desktop-shared/types';
import {
  getShareRunEligibility,
  shareRun,
  unshareRun,
} from '../lib/shared-run-sync';
import { getSharedRunAutoUpdater } from '../services/shared-run-auto-updater';
import {
  normalizeCount,
  sharedRunIdempotencyKey,
} from '../lib/shared-run-comments-registry';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type { DesktopIpcCallerResolver } from './file-tree';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

function validateSessionRef(request: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): void {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.chatId, 'chatId');
}

/**
 * Comment thread ids are server-minted with a client prefix — today always
 * `web:<uuid>`, since the server mints the id regardless of whether the create
 * arrived from the web app or from this desktop call-through. They intentionally
 * do NOT satisfy `validateId`'s `[a-z0-9-]` shape. Bound them to the server's
 * `VarChar(128)` column and reject control characters / path separators
 * instead; the id is then percent-encoded into the request path. The character
 * class stays permissive enough to accept a differently-prefixed id if the
 * server ever mints one.
 */
function validateCommentThreadId(threadId: string): void {
  if (
    typeof threadId !== 'string' ||
    threadId.length === 0 ||
    threadId.length > 128 ||
    !/^[A-Za-z0-9:_-]+$/.test(threadId)
  ) {
    throw new Error('Invalid threadId');
  }
}

/** The window's run share, which App Advisor's runs.share shares (CAN-6003). */
export async function shareRunForWindow(
  request: ShareRunRequest,
): Promise<ShareOperationResult<ShareRunResponse>> {
  validateSessionRef(request);
  if (request.teamId !== undefined) {
    validateId(request.teamId, 'teamId');
  }
  if (request.organizationId !== undefined) {
    validateId(request.organizationId, 'organizationId');
  }
  return toShareOperationResult(() => shareRun(request));
}

/** The window's run unshare, which App Advisor's runs.unshare shares (CAN-6003). */
export async function unshareRunForWindow(
  request: UnshareRunRequest,
): Promise<UnshareRunResponse> {
  validateSessionRef(request);
  // Cancel any pending auto-reshare for this session first, so unsharing
  // can't be undone by a debounced timer resurrecting the deleted grant.
  getSharedRunAutoUpdater().cancelPending(
    request.projectId,
    request.worktreeId,
    request.chatId,
  );
  return unshareRun(request);
}

/**
 * `runs:comments:markSeen` as a projection of
 * `core.publication.comment.markSeen` (CAN-4169): a run nobody watches reads
 * as nothing seen and nothing unread, and a failed write rejects with its
 * own error, as before the move.
 */
async function markRunCommentsSeenForIpc(
  dispatcher: Pick<DesktopCanopyDispatcher, 'instruction'>,
  caller: CanopyCallerDescriptor,
  request: MarkRunCommentsSeenRequest,
): Promise<MarkRunCommentsSeenResponse> {
  validateSessionRef(request);
  try {
    const { seenRevision, unreadCount } = await dispatcher.instruction(
      'core.publication.comment.markSeen',
      {
        publicationId: sharedRunIdempotencyKey(
          request.projectId,
          request.worktreeId,
          request.chatId,
        ),
        throughRevision: normalizeCount(request.commentRevision),
      },
      {
        caller: { ...caller, grants: [PUBLICATION_GRANTS.write] },
        metadata: { idempotencyKey: randomUUID() },
      },
    );
    return {
      lastSeenCommentRevision: seenRevision,
      unreadCommentCount: unreadCount,
    };
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    if (error.payload.kind === 'not_found')
      return { lastSeenCommentRevision: 0, unreadCommentCount: 0 };
    // A Node errno error may come from another realm, which instanceof misses.
    if (
      error.payload.kind === 'internal' &&
      (error.runtimeCause instanceof Error ||
        types.isNativeError(error.runtimeCause))
    )
      throw error.runtimeCause;
    throw error;
  }
}

// The runs:comments channels project core.publication.comment.* with only
// the grants each operation needs.
const READ_GRANTS = [PUBLICATION_GRANTS.read, 'core.workspace.read'] as const;
const WRITE_GRANTS = [
  PUBLICATION_GRANTS.write,
  'core.workspace.write',
] as const;

export function registerRunsHandlers(
  dispatcher: Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>,
  resolveCaller: DesktopIpcCallerResolver,
): void {
  const writeAs = (
    event: Parameters<DesktopIpcCallerResolver>[0],
  ): {
    caller: CanopyCallerDescriptor;
    metadata: { idempotencyKey: string };
  } => ({
    caller: { ...resolveCaller(event), grants: [...WRITE_GRANTS] },
    metadata: { idempotencyKey: randomUUID() },
  });

  registerIpcHandler<[ShareRunRequest], ShareOperationResult<ShareRunResponse>>(
    IPC_CHANNELS.runsShare,
    (_event, request) => shareRunForWindow(request),
  );

  registerIpcHandler<[ShareRunEligibilityRequest], ShareRunEligibilityResponse>(
    IPC_CHANNELS.runsShareEligibility,
    async (_event, request) => {
      validateSessionRef(request);
      return getShareRunEligibility(request);
    },
  );

  registerIpcHandler<[UnshareRunRequest], UnshareRunResponse>(
    IPC_CHANNELS.runsUnshare,
    (_event, request) => unshareRunForWindow(request),
  );

  registerIpcHandler<[ListRunCommentsRequest], ListRunCommentsResponse>(
    IPC_CHANNELS.runsCommentsList,
    (event, request) => {
      validateSessionRef(request);
      return dispatcher.query('core.publication.comment.list', request, {
        caller: { ...resolveCaller(event), grants: [...READ_GRANTS] },
      });
    },
  );

  registerIpcHandler<
    [CreateRunCommentThreadRequest],
    RunCommentMutationResponse
  >(IPC_CHANNELS.runsCommentsCreate, (event, request) => {
    validateSessionRef(request);
    return dispatcher.instruction(
      'core.publication.comment.create',
      request,
      writeAs(event),
    );
  });

  registerIpcHandler<
    [ReplyRunCommentThreadRequest],
    RunCommentMutationResponse
  >(IPC_CHANNELS.runsCommentsReply, (event, request) => {
    validateSessionRef(request);
    validateCommentThreadId(request.threadId);
    return dispatcher.instruction(
      'core.publication.comment.reply',
      request,
      writeAs(event),
    );
  });

  registerIpcHandler<
    [SetRunCommentThreadStatusRequest],
    RunCommentMutationResponse
  >(IPC_CHANNELS.runsCommentsSetStatus, (event, request) => {
    validateSessionRef(request);
    validateCommentThreadId(request.threadId);
    return dispatcher.instruction(
      'core.publication.comment.update',
      request,
      writeAs(event),
    );
  });

  registerIpcHandler<[MarkRunCommentsSeenRequest], MarkRunCommentsSeenResponse>(
    IPC_CHANNELS.runsCommentsMarkSeen,
    (event, request) =>
      markRunCommentsSeenForIpc(dispatcher, resolveCaller(event), request),
  );
}
