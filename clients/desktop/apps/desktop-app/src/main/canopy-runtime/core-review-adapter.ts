import { posix } from 'node:path';
import {
  CanopyOperationError,
  type CanopyDispatcherHandlerMap,
  type CanopyDispatcherInstructionHandlerMap,
} from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import {
  REVIEW_ERROR_CODES,
  ReviewAnnotationSchema,
  ReviewAnnotationsArtifactSchema,
  ReviewCommentThreadSchema,
  ReviewDiagramArtifactSchema,
  type CodeReviewRecord,
  type ReviewScope,
} from '@canopy/protocol/canopy-core';
import {
  isReviewCommentThread,
  type CodeReviewFile,
  type CodeReviewGenerationResult,
  type ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import { CodeReviewStateAdmissionError } from '../lib/code-review-persistence';
import type { DesktopInstructionDefinitions } from './desktop-instruction-definitions';
import type { DesktopQueryDefinitions } from './desktop-query-definitions';
import {
  desktopReviewOperations,
  type DesktopReviewOperations,
} from './review-operations';
import {
  publishDispatchedReviewChange,
  type DispatchedReviewChange,
} from './review-update-publisher';

/*
 * Registers code review state, `core.review.*`, on the desktop dispatcher
 * (CAN-4167 PR 2c): get, arm, comment.upsert and comment.reply over
 * desktop's code-review persistence, which stays the one module that reads,
 * admits and writes the review file. The `code-review:get`, `arm` and
 * `save-comments` IPC handlers and the agent comment tools reach review
 * state through these operations. Generation (`core.review.create`) and the
 * event stream join later. `core.review.comment.resolve` isn't composed:
 * persistence has no status change it makes under its lock, and its lock
 * isn't re-entrant, so a resolve composed here would read and then save
 * outside one lock and could bring back a thread deleted between the two.
 *
 * This adapter adds only what the contract needs on top: keyed writes, the
 * typed refusals, and the review as `core.review` answers it. A stored
 * thread or annotation the contract can't carry is left out of that answer
 * and counted; the stored file is unchanged.
 */

type ReviewQueryName = 'core.review.get';
type ReviewInstructionName =
  | 'core.review.arm'
  | 'core.review.comment.upsert'
  | 'core.review.comment.reply';

export interface CoreReviewAdapter {
  queries: Pick<
    CanopyDispatcherHandlerMap<DesktopQueryDefinitions>,
    ReviewQueryName
  >;
  instructions: Pick<
    CanopyDispatcherInstructionHandlerMap<DesktopInstructionDefinitions>,
    ReviewInstructionName
  >;
}

/** As code-review persistence words its deletion fence's refusal. */
const REVIEW_STOPPED_MESSAGE =
  'Code review state is being removed for this worktree.';

function keyReused(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    message: 'This idempotency key was used with other parameters.',
    retry: { kind: 'never' },
  });
}

function reviewStopped(cause?: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      code: REVIEW_ERROR_CODES.STOPPED,
      message: REVIEW_STOPPED_MESSAGE,
      details: { reason: 'STOPPED' },
      retry: { kind: 'never' },
    },
    cause,
  );
}

/**
 * Code-review persistence's CAN-6848 refusal, as `core.review` types it. It
 * keeps the refusal's message, and its reason in `details.stateFailure`;
 * the refusal itself is the runtime cause.
 */
function damagedState(
  refusal: CodeReviewStateAdmissionError,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      code: REVIEW_ERROR_CODES.DAMAGED_STATE,
      message: refusal.message,
      details: { reason: 'DAMAGED_STATE', stateFailure: refusal.reason },
      retry: { kind: 'never' },
    },
    refusal,
  );
}

function threadNotFound(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: REVIEW_ERROR_CODES.THREAD_NOT_FOUND,
    message: 'Comment thread not found.',
    details: { reason: 'THREAD_NOT_FOUND' },
    retry: { kind: 'never' },
  });
}

function unsavableThread(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    message: 'This comment thread could not be saved.',
    retry: { kind: 'never' },
  });
}

/** The operation's threads as persistence stores them. */
function storedThreads(threads: readonly unknown[]): ReviewCommentThread[] {
  return threads.map((thread) => {
    if (!isReviewCommentThread(thread)) throw unsavableThread();
    return thread;
  });
}

type AnnotationsRecord = NonNullable<CodeReviewRecord['annotations']>;
type DiagramsRecord = CodeReviewRecord['diagrams'];
type DiagramRecord = NonNullable<DiagramsRecord['logicDiff']>;

/**
 * The annotations as `core.review` answers them. A path is normalised before
 * the repository-relative check, so `./src/a.ts` names `src/a.ts`; one whose
 * path still isn't repository-relative is left out on its own and counted in
 * `skippedAnnotations`.
 */
function annotationsRecord(
  artifact: NonNullable<CodeReviewFile['annotations']>,
): AnnotationsRecord | undefined {
  const stored = artifact.data?.annotations ?? [];
  const annotations = stored.flatMap((annotation) => {
    const parsed = ReviewAnnotationSchema.safeParse({
      ...annotation,
      filePath: posix.normalize(annotation.filePath),
    });
    return parsed.success ? [parsed.data] : [];
  });
  const skipped = stored.length - annotations.length;
  const parsed = ReviewAnnotationsArtifactSchema.safeParse({
    derivedFromFingerprint: artifact.derivedFromFingerprint,
    status: artifact.status,
    data: artifact.data === null ? null : { ...artifact.data, annotations },
    ...(artifact.generatedAt === undefined
      ? {}
      : { generatedAt: artifact.generatedAt }),
    ...(artifact.error === undefined ? {} : { error: artifact.error }),
    ...(skipped > 0 ? { skippedAnnotations: skipped } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

function diagramRecord(artifact: unknown): DiagramRecord | undefined {
  const parsed = ReviewDiagramArtifactSchema.safeParse(artifact);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The stored review as `core.review` answers it, and how many stored threads
 * that leaves out: one persistence reads whose anchor path isn't
 * repository-relative. Persistence keeps such a thread on disk.
 */
function reviewRecord(file: CodeReviewFile): {
  review: CodeReviewRecord;
  skippedCommentThreads: number;
} {
  const commentThreads = file.commentThreads.flatMap((thread) => {
    const parsed = ReviewCommentThreadSchema.safeParse(thread);
    return parsed.success ? [parsed.data] : [];
  });
  const diagrams: DiagramsRecord = {};
  const logicDiff = diagramRecord(file.diagrams.logicDiff);
  if (logicDiff) diagrams.logicDiff = logicDiff;
  const dataModelDiff = diagramRecord(file.diagrams.dataModelDiff);
  if (dataModelDiff) diagrams.dataModelDiff = dataModelDiff;
  const annotations = file.annotations && annotationsRecord(file.annotations);
  return {
    review: {
      version: 1,
      armed: file.armed,
      ...(file.armedAt === undefined ? {} : { armedAt: file.armedAt }),
      commentThreads,
      ...(annotations ? { annotations } : {}),
      diagrams,
    },
    skippedCommentThreads: file.commentThreads.length - commentThreads.length,
  };
}

export interface CoreReviewAdapterOptions {
  operations?: DesktopReviewOperations;
  publish?: (change: DispatchedReviewChange) => Promise<void>;
}

export function createCoreReviewAdapter({
  operations = desktopReviewOperations,
  publish = publishDispatchedReviewChange,
}: CoreReviewAdapterOptions = {}): CoreReviewAdapter {
  // A repeat under the same caller and key answers the first outcome without
  // writing again; a failed attempt may be retried under its key.
  const forget = (): boolean => true;
  const arms = new KeyedOutcomes<CodeReviewGenerationResult>({
    reusedError: keyReused,
    forget,
  });
  const writes = {
    upsert: new KeyedOutcomes<{ review: CodeReviewRecord }>({
      reusedError: keyReused,
      forget,
    }),
    reply: new KeyedOutcomes<{ review: CodeReviewRecord }>({
      reusedError: keyReused,
      forget,
    }),
  };

  /** A persistence failure as `core.review` types it. */
  const refusal = (scope: ReviewScope, error: unknown): unknown => {
    if (error instanceof CodeReviewStateAdmissionError)
      return damagedState(error);
    // Persistence's deletion fence refuses with a plain error.
    if (!(error instanceof CanopyOperationError) && operations.stopped(scope))
      return reviewStopped(error);
    return error;
  };

  /**
   * One persistence write. A worktree being removed is refused before
   * persistence is called, in the same turn, so persistence's own fence
   * check can't refuse it first with an untyped error.
   */
  const write = async <Result>(
    scope: ReviewScope,
    run: () => Promise<Result>,
  ): Promise<Result> => {
    if (operations.stopped(scope)) throw reviewStopped();
    try {
      return await run();
    } catch (error) {
      throw refusal(scope, error);
    }
  };

  const committed = async (
    scope: ReviewScope,
    review: CodeReviewFile | null,
  ): Promise<{ review: CodeReviewRecord }> => {
    if (!review) throw threadNotFound();
    await publish({ scope, review });
    return { review: reviewRecord(review).review };
  };

  return {
    queries: {
      'core.review.get': async ({ scope }) => {
        const [stored, fingerprint] = await Promise.all([
          operations.read(scope),
          operations.fingerprint(scope),
        ]);
        const { review, skippedCommentThreads } = reviewRecord(stored.review);
        const skipped =
          (stored.skippedCommentThreads ?? 0) + skippedCommentThreads;
        return {
          review,
          fingerprint,
          ...(skipped > 0 ? { skippedCommentThreads: skipped } : {}),
          ...(stored.mutationFailure
            ? { stateFailure: stored.mutationFailure.reason }
            : {}),
        };
      },
    },
    instructions: {
      'core.review.arm': (params, context) =>
        arms.run(context, params, async () => {
          try {
            return await operations.arm(params.scope);
          } catch (error) {
            const typed = refusal(params.scope, error);
            // A worktree being removed arms nothing, as desktop always
            // answered.
            if (
              typed instanceof CanopyOperationError &&
              typed.payload.code === REVIEW_ERROR_CODES.STOPPED
            )
              return { status: 'stopped' };
            throw typed;
          }
        }),
      'core.review.comment.upsert': (params, context) =>
        writes.upsert.run(context, params, async () => {
          const commentThreads = storedThreads(params.commentThreads);
          const baseCommentThreads =
            params.baseCommentThreads === undefined
              ? undefined
              : storedThreads(params.baseCommentThreads);
          return committed(
            params.scope,
            await write(params.scope, () =>
              operations.upsertComments({
                scope: params.scope,
                commentThreads,
                ...(params.baseCommentThreadIds === undefined
                  ? {}
                  : { baseCommentThreadIds: params.baseCommentThreadIds }),
                ...(baseCommentThreads === undefined
                  ? {}
                  : { baseCommentThreads }),
              }),
            ),
          );
        }),
      'core.review.comment.reply': (params, context) =>
        writes.reply.run(context, params, async () =>
          committed(
            params.scope,
            await write(params.scope, () =>
              operations.reply({
                scope: params.scope,
                threadId: params.threadId,
                body: params.body,
                ...(params.resolve === undefined
                  ? {}
                  : { resolve: params.resolve }),
              }),
            ),
          ),
        ),
    },
  };
}
