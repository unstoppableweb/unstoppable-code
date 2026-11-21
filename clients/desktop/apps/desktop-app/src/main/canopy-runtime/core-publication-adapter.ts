import {
  CanopyOperationError,
  canopyCancelledError,
  canopyUnavailableError,
  type CanopyDispatcherInstructionHandlerMap,
} from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import { PUBLICATION_SHARE_ERROR_CODES } from '@canopy/protocol/canopy-core';
import { markSharedRunCommentsSeen } from '../lib/shared-run-comments-registry';
import type { DesktopInstructionDefinitions } from './desktop-instruction-definitions';

/*
 * Registers `core.publication.comment.markSeen` on the desktop dispatcher
 * (CAN-4169 PR 2) over the shared-run comments registry. A shared run's
 * `publicationId` is its `clientLocalRunId`. `runs:comments:markSeen`, and
 * Remote Control through it, reaches the seen marker only through here.
 */

export interface CorePublicationAdapter {
  instructions: Pick<
    CanopyDispatcherInstructionHandlerMap<DesktopInstructionDefinitions>,
    'core.publication.comment.markSeen'
  >;
  /**
   * Cancels every write still queued, a timed-out one included, and waits
   * for the ones already running.
   */
  close(): Promise<void>;
}

/** markSeen writes one adapter holds at once, timed-out ones included. */
export const MAX_PENDING_MARKS = 512;

function notWatched(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: PUBLICATION_SHARE_ERROR_CODES.NOT_FOUND,
    message: 'This shared run is not watched for comments.',
    retry: { kind: 'never' },
  });
}

function keyReused(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    message: 'This idempotency key was used with other parameters.',
    retry: { kind: 'never' },
  });
}

export function createCorePublicationAdapter(): CorePublicationAdapter {
  // Only a failure that offers a retry may run again under its key. Terminal
  // ones stay, so the key keeps refusing other parameters: not_found, and a
  // raw registry failure, which the dispatcher reports as internal, never.
  const forget = (error: unknown): boolean =>
    error instanceof CanopyOperationError &&
    error.payload.retry.kind !== 'never';
  const marks = new KeyedOutcomes<{
    seenRevision: number;
    unreadCount: number;
  }>({
    reusedError: keyReused,
    forget,
    // Room for settled replays even while the pending cap is full.
    max: 2 * MAX_PENDING_MARKS,
  });
  const closing = new AbortController();
  // Every accepted write counts toward the cap; close waits only for the
  // ones already writing, since a queued one cancels on its turn.
  const pending = new Set<Promise<unknown>>();
  const writing = new Set<Promise<unknown>>();
  return {
    close: async (): Promise<void> => {
      closing.abort('shutdown');
      await Promise.allSettled(writing);
    },
    instructions: {
      'core.publication.comment.markSeen': (params, context) =>
        marks.run(context, params, () => {
          // A deadline frees the dispatcher's call but not its queued write,
          // so the writes are bounded here; a same-key retry joins first.
          if (pending.size >= MAX_PENDING_MARKS)
            return Promise.reject(
              canopyUnavailableError(undefined, {
                kind: 'same_idempotency_key',
              }),
            );
          const write = (async (): Promise<{
            seenRevision: number;
            unreadCount: number;
          }> => {
            // A deadline means the caller stopped waiting, so the write still
            // lands and its key stays bound; a cancel or shutdown stops it.
            const cancel = new AbortController();
            const onAbort = (): void => {
              const reason: unknown = closing.signal.aborted
                ? closing.signal.reason
                : context.signal.reason;
              if (reason !== 'deadline') cancel.abort(reason);
            };
            const signals = [context.signal, closing.signal];
            for (const signal of signals) {
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort, { once: true });
            }
            try {
              const updated = await markSharedRunCommentsSeen(
                params.publicationId,
                params.throughRevision,
                cancel.signal,
                () => writing.add(write),
              ).catch((error: unknown) => {
                // Only the cancel itself; a write that failed for its own
                // reason stays internal.
                if (cancel.signal.aborted && error === cancel.signal.reason)
                  throw canopyCancelledError();
                throw error;
              });
              if (!updated) throw notWatched();
              return {
                seenRevision: updated.lastSeenCommentRevision,
                unreadCount: updated.unreadCommentCount,
              };
            } finally {
              for (const signal of signals)
                signal.removeEventListener('abort', onAbort);
            }
          })();
          pending.add(write);
          const drop = (): void => {
            pending.delete(write);
            writing.delete(write);
          };
          write.then(drop, drop);
          return write;
        }),
    },
  };
}
