import { randomUUID } from 'node:crypto';
import type { BrowserWindow, WebContents } from 'electron';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  REVIEW_GRANTS,
  ReviewCommentThreadSchema,
  type CanopyCallerDescriptor,
  type CodeReviewRecord,
  type ReviewCommentThread as ReviewThreadRecord,
  type ReviewScope,
  type ReviewStateFailure,
} from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  buildCodeReviewScopeKey,
  normalizeCodeReviewFile,
  type CodeReviewArmRequest,
  type CodeReviewFile,
  type CodeReviewGenerateRequest,
  type CodeReviewGenerationResult,
  type CodeReviewGetRequest,
  type CodeReviewGetResponse,
  type CodeReviewModalOpenRequest,
  type CodeReviewSaveCommentsRequest,
  type CodeReviewStateMutationFailure,
  type RegisterCodeReviewRequest,
} from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';
import { validateId } from '../lib/validation';
import {
  requestManualCodeReviewRefresh,
  setCodeReviewModalOpen,
} from '../lib/code-review-scheduler';
import { registerCodeReviewTarget } from '../lib/code-review-registry';
import { CodeReviewStateAdmissionError } from '../lib/code-review-persistence';

type ReviewDispatcher = Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>;

function reviewCaller(
  caller: CanopyCallerDescriptor,
  access: 'read' | 'write',
): CanopyCallerDescriptor {
  return { ...caller, grants: [REVIEW_GRANTS[access]] };
}

function validateScope(request: CodeReviewGetRequest): ReviewScope {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  return { projectId: request.projectId, worktreeId: request.worktreeId };
}

/**
 * The error these channels answered before they dispatched: a failure the
 * dispatcher reports as internal, and code-review persistence's CAN-6848
 * refusal, keep their original error; another typed refusal is answered as
 * it is.
 */
function legacyError(error: unknown): unknown {
  if (
    error instanceof CanopyOperationError &&
    (error.runtimeCause instanceof CodeReviewStateAdmissionError ||
      (error.runtimeCause instanceof Error &&
        error.payload.kind === 'internal'))
  )
    return error.runtimeCause;
  return error;
}

/**
 * `mutationFailure` as code-review persistence words its refusal: its code
 * and message come from persistence's own error. The file path isn't part
 * of `mutationFailure`, so none is given.
 */
function mutationFailure(
  scope: ReviewScope,
  reason: ReviewStateFailure,
): CodeReviewStateMutationFailure {
  const refusal = new CodeReviewStateAdmissionError(
    scope.projectId,
    scope.worktreeId,
    '',
    reason,
  );
  return {
    code: refusal.code,
    reason: refusal.reason,
    message: refusal.message,
  };
}

/**
 * The desktop's view of a review `core.review` answered, with the count of
 * annotations its read left out.
 */
function desktopReview(review: CodeReviewRecord): CodeReviewFile {
  const file = normalizeCodeReviewFile(review);
  const skippedAnnotations = review.annotations?.skippedAnnotations;
  return file.annotations && skippedAnnotations !== undefined
    ? { ...file, annotations: { ...file.annotations, skippedAnnotations } }
    : file;
}

async function projected<Result>(call: () => Promise<Result>): Promise<Result> {
  try {
    return await call();
  } catch (error) {
    throw legacyError(error);
  }
}

/**
 * Threads as the operation takes them. One the store would not read refuses
 * the save before dispatch, with the message it always had (CAN-6667).
 */
function savableThreads(threads: readonly unknown[]): ReviewThreadRecord[] {
  return threads.map((thread) => {
    const parsed = ReviewCommentThreadSchema.safeParse(thread);
    if (!parsed.success)
      throw new Error('This comment thread could not be saved.');
    return parsed.data;
  });
}

export async function getCodeReviewForIpc(
  dispatcher: ReviewDispatcher,
  caller: CanopyCallerDescriptor,
  request: CodeReviewGetRequest,
): Promise<CodeReviewGetResponse> {
  const scope = validateScope(request);
  const result = await projected(() =>
    dispatcher.query(
      'core.review.get',
      { scope },
      { caller: reviewCaller(caller, 'read') },
    ),
  );
  return {
    review: desktopReview(result.review),
    fingerprint: result.fingerprint,
    ...(result.skippedCommentThreads === undefined
      ? {}
      : { skippedCommentThreads: result.skippedCommentThreads }),
    ...(result.stateFailure === undefined
      ? {}
      : { mutationFailure: mutationFailure(scope, result.stateFailure) }),
  };
}

export async function armCodeReviewForIpc(
  dispatcher: ReviewDispatcher,
  caller: CanopyCallerDescriptor,
  request: CodeReviewArmRequest,
): Promise<CodeReviewGenerationResult> {
  const scope = validateScope(request);
  return projected(() =>
    dispatcher.instruction(
      'core.review.arm',
      { scope },
      {
        caller: reviewCaller(caller, 'write'),
        metadata: { idempotencyKey: randomUUID() },
      },
    ),
  );
}

export async function saveCodeReviewCommentsForIpc(
  dispatcher: ReviewDispatcher,
  caller: CanopyCallerDescriptor,
  request: CodeReviewSaveCommentsRequest,
): Promise<CodeReviewFile | null> {
  const scope = validateScope(request);
  const commentThreads = savableThreads(request.commentThreads);
  const baseCommentThreads =
    request.baseCommentThreads === undefined
      ? undefined
      : savableThreads(request.baseCommentThreads);
  const { review } = await projected(() =>
    dispatcher.instruction(
      'core.review.comment.upsert',
      {
        scope,
        commentThreads,
        baseCommentThreadIds: request.baseCommentThreadIds,
        baseCommentThreads,
      },
      {
        caller: reviewCaller(caller, 'write'),
        metadata: { idempotencyKey: randomUUID() },
      },
    ),
  );
  return desktopReview(review);
}

const visibilityLeases = new WeakMap<WebContents, Map<string, () => void>>();

export function registerCodeReviewHandlers(
  getWindow: () => BrowserWindow | null,
  dispatcher: ReviewDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
): void {
  registerIpcHandler<[CodeReviewGetRequest], CodeReviewGetResponse>(
    IPC_CHANNELS.codeReviewGet,
    (event, request) =>
      getCodeReviewForIpc(dispatcher, resolveCaller(event), request),
  );

  // Arming runs the review's generation and answers its status; the
  // scheduler still runs it until CAN-4167 PR 2d.
  registerIpcHandler<[CodeReviewArmRequest], CodeReviewGenerationResult>(
    IPC_CHANNELS.codeReviewArm,
    (event, request) =>
      armCodeReviewForIpc(dispatcher, resolveCaller(event), request),
  );

  registerIpcHandler<[CodeReviewGenerateRequest], CodeReviewGenerationResult>(
    IPC_CHANNELS.codeReviewGenerate,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return requestManualCodeReviewRefresh(request, getWindow);
    },
  );

  registerIpcHandler<[CodeReviewSaveCommentsRequest], CodeReviewFile | null>(
    IPC_CHANNELS.codeReviewSaveComments,
    (event, request) =>
      saveCodeReviewCommentsForIpc(dispatcher, resolveCaller(event), request),
  );

  registerIpcHandler<[RegisterCodeReviewRequest], void>(
    IPC_CHANNELS.codeReviewRegister,
    async (_event, request) => {
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.projectId, 'projectId');
      // The IPC request carries the REAL ids; compute the versioned scope key
      // and store the full ref so downstream resolution never parses it back.
      // Historical `p--w` rows keep their keys and are never reassigned here.
      await registerCodeReviewTarget(
        buildCodeReviewScopeKey(request.projectId, request.worktreeId),
        { projectId: request.projectId, worktreeId: request.worktreeId },
      );
    },
  );

  registerIpcHandler<[CodeReviewModalOpenRequest], void>(
    IPC_CHANNELS.codeReviewModalOpen,
    (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      if (typeof request.open !== 'boolean')
        throw new Error('open must be a boolean');
      if (request.consumerId !== undefined)
        validateId(request.consumerId, 'consumerId');
      if (_event.sender) {
        let leases = visibilityLeases.get(_event.sender);
        if (!leases) {
          leases = new Map();
          visibilityLeases.set(_event.sender, leases);
          const ownedLeases = leases;
          const release = (): void => {
            for (const close of Array.from(ownedLeases.values())) close();
            ownedLeases.clear();
          };
          _event.sender.once('destroyed', release);
          _event.sender.on('render-process-gone', release);
        }
        const key = `${request.projectId}/${request.worktreeId}/${request.consumerId ?? 'legacy'}`;
        if (request.open)
          leases.set(key, () =>
            setCodeReviewModalOpen(
              request,
              false,
              getWindow,
              request.consumerId,
            ),
          );
        else leases.delete(key);
      }
      setCodeReviewModalOpen(
        request,
        request.open,
        getWindow,
        request.consumerId,
      );
    },
  );
}
