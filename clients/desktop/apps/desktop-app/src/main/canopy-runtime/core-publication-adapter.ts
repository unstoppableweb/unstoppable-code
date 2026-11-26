import { createHash } from 'node:crypto';
import {
  CanopyOperationError,
  canopyCancelledError,
  canopyUnavailableError,
  type CanopyDispatcherHandlerMap,
  type CanopyDispatcherInstructionHandlerMap,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import {
  PUBLICATION_COMMENT_ERROR_CODES,
  PUBLICATION_SHARE_ERROR_CODES,
  SharedRunCommentStateSchema,
  type CanopyRetryDirective,
  type SharedRunCommentState,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';
import type { SharedRunDetail } from '@canopy/protocol/runs';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { readSharedRunMetadata } from '../lib/chat-tabs-reader';
import {
  markSharedRunCommentsSeen,
  readSharedRunCommentEntry,
  registerSharedRunForComments,
} from '../lib/shared-run-comments-registry';
import {
  assertRunCommentsCapability,
  createRunCommentThread,
  getSharedRun,
  replyToRunCommentThread,
  setRunCommentThreadStatus,
} from '../runs/canopy-server-client';
import type { DesktopInstructionDefinitions } from './desktop-instruction-definitions';
import type { DesktopQueryDefinitions } from './desktop-query-definitions';

/*
 * Registers `core.publication.comment.*` on the desktop dispatcher (CAN-4169):
 * markSeen (PR 2) over the shared-run comments registry, and list, create,
 * reply and update (PR 3b) over the hosted runs routes. A shared run's
 * `publicationId` is its `clientLocalRunId`; the comment threads name the
 * shared chat, whose share metadata gives the hosted run. The runs:comments
 * channels, and Remote Control through them, reach comments only through here.
 */

export interface CorePublicationAdapter {
  queries: Pick<
    CanopyDispatcherHandlerMap<DesktopQueryDefinitions>,
    'core.publication.comment.list'
  >;
  instructions: Pick<
    CanopyDispatcherInstructionHandlerMap<DesktopInstructionDefinitions>,
    | 'core.publication.comment.markSeen'
    | 'core.publication.comment.create'
    | 'core.publication.comment.reply'
    | 'core.publication.comment.update'
  >;
  /**
   * Cancels every write still queued, a timed-out one included, and waits
   * for the ones already running.
   */
  close(): Promise<void>;
}

/** markSeen writes one adapter holds at once, timed-out ones included. */
export const MAX_PENDING_MARKS = 512;

/** Settled comment-thread write keys kept for replay. */
const MAX_KEYED_COMMENT_WRITES = 512;

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

interface SharedChat {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

// Comments are server-authoritative: the run always comes from the freshly
// read share metadata, never a cached value.
async function sharedRunExternalId(chat: SharedChat): Promise<string | null> {
  const meta = await readSharedRunMetadata(
    chat.projectId,
    chat.worktreeId,
    chat.chatId,
  );
  return meta?.externalId ?? null;
}

const REFRESH: CanopyRetryDirective = {
  kind: 'after_refresh',
  resource: 'core.publication.comment.list',
};

function operationError(
  kind: CanopyOperationError['payload']['kind'],
  message: string,
  retry: CanopyRetryDirective,
  code?: (typeof PUBLICATION_COMMENT_ERROR_CODES)[keyof typeof PUBLICATION_COMMENT_ERROR_CODES],
): CanopyOperationError {
  return new CanopyOperationError({
    kind,
    message: message.slice(0, 4_096),
    retry,
    ...(code ? { code } : {}),
  });
}

async function requireExternalId(chat: SharedChat): Promise<string> {
  const externalId = await sharedRunExternalId(chat);
  if (!externalId)
    throw operationError(
      'failed_precondition',
      'This chat is not currently shared as a run.',
      REFRESH,
    );
  return externalId;
}

const validated = (error: unknown): error is CanopyCloudClientError =>
  error instanceof CanopyCloudClientError &&
  error.code === 'http-error' &&
  error.isValidatedServerError;

/** A failed hosted read: nothing changed, so `unavailable` may be retried. */
function readError(
  error: unknown,
  unavailableRetry: CanopyRetryDirective,
): unknown {
  if (validated(error) && error.status === 401)
    return operationError('unauthenticated', error.message, REFRESH);
  // Hosted answers a lost grant and a missing run with the same 404.
  if (validated(error) && error.status === 404)
    return operationError('not_found', error.message, { kind: 'never' });
  if (
    error instanceof CanopyCloudClientError &&
    (error.code === 'missing-api-key' || error.code === 'cloud-not-configured')
  )
    return operationError('unauthenticated', error.message, REFRESH);
  if (error instanceof CanopyCloudClientError)
    return operationError('unavailable', error.message, unavailableRetry);
  // A 2xx that isn't a run's comments is a failed read too.
  return operationError(
    'unavailable',
    'The shared run could not be read.',
    unavailableRetry,
  );
}

/**
 * A failed hosted write. The hosted routes take no idempotency key, so once
 * the request has left the process any failure but a validated refusal may
 * have landed and is never retried.
 */
function writeError(error: unknown, sent: boolean): unknown {
  if (!sent) {
    if (!(error instanceof CanopyCloudClientError)) return error;
    return error.code === 'missing-api-key' ||
      error.code === 'cloud-not-configured'
      ? operationError('unauthenticated', error.message, REFRESH)
      : // No run-comments-v1, or the capability probe failed.
        operationError('failed_precondition', error.message, REFRESH);
  }
  if (validated(error)) {
    const never: CanopyRetryDirective = { kind: 'never' };
    switch (error.status) {
      case 400:
        return operationError('invalid_argument', error.message, never);
      case 401:
        return operationError('unauthenticated', error.message, REFRESH);
      case 404:
        return operationError('not_found', error.message, never);
      case 409:
        // Rolled back after its serializable retries ran out.
        return operationError(
          'conflict',
          error.message,
          {
            kind: 'same_idempotency_key',
            delayMs: Math.min(
              Math.max(error.retryAfterMs ?? 1_000, 1),
              86_400_000,
            ),
          },
          PUBLICATION_COMMENT_ERROR_CODES.WRITE_CONTENDED,
        );
      case 429:
        return operationError(
          'resource_exhausted',
          error.message,
          never,
          PUBLICATION_COMMENT_ERROR_CODES.LIMIT_REACHED,
        );
    }
  }
  return operationError(
    'unavailable',
    'The comment may have been saved. Reload the comments before sending it again.',
    { kind: 'never' },
    PUBLICATION_COMMENT_ERROR_CODES.SEND_UNCERTAIN,
  );
}

const ANCHOR_TEXT_LENGTH = 256;

async function runCommentsSupported(): Promise<boolean> {
  try {
    await assertRunCommentsCapability();
    return true;
  } catch (error) {
    if (!(error instanceof CanopyCloudClientError)) throw error;
    if (
      error.code === 'unsupported-capability' ||
      error.code === 'missing-api-key' ||
      error.code === 'cloud-not-configured'
    )
      return false;
    if (validated(error) && error.status === 401)
      throw operationError('unauthenticated', error.message, REFRESH);
    throw operationError('unavailable', error.message, {
      kind: 'same_request',
    });
  }
}

/**
 * A message's text with whitespace runs collapsed and trimmed, cut at
 * ANCHOR_TEXT_LENGTH code units. It walks code points, so a cut never splits
 * a surrogate pair, and stops at the bound instead of normalizing the whole
 * message.
 */
function anchorPreview(text: string): string | null {
  let preview = '';
  let gap = false;
  for (const char of text) {
    if (/\s/.test(char)) {
      gap = preview.length > 0;
      continue;
    }
    const next = gap ? ` ${char}` : char;
    if (preview.length + next.length > ANCHOR_TEXT_LENGTH) break;
    preview += next;
    gap = false;
  }
  return preview.length > 0 ? preview : null;
}

/** The comment state of a run detail; its transcript, diff and plans stay behind. */
function commentState(detail: SharedRunDetail): SharedRunCommentState {
  // Many threads can anchor to one message: preview each message once.
  const texts = new Map<string, string>();
  for (const message of detail.messages)
    if (!texts.has(message.messageId))
      texts.set(message.messageId, message.text);
  const previews = new Map<string, string | null>();
  const anchorText = (
    thread: SharedRunDetail['commentThreads'][number],
  ): string | null => {
    if (thread.anchor.kind !== 'message' || thread.anchorState === 'orphaned')
      return null;
    const { messageId } = thread.anchor;
    let preview = previews.get(messageId);
    if (preview === undefined) {
      preview = anchorPreview(texts.get(messageId) ?? '');
      previews.set(messageId, preview);
    }
    return preview;
  };
  return {
    commentThreads: detail.commentThreads.map((thread) => ({
      id: thread.id,
      status: thread.status,
      anchor:
        thread.anchor.kind === 'message'
          ? { kind: 'message', messageId: thread.anchor.messageId }
          : { kind: 'run' },
      anchorState: thread.anchorState,
      anchorText: anchorText(thread),
      createdAt: thread.createdAt,
      comments: thread.comments.map((comment) => ({
        id: comment.id,
        author: {
          userId: comment.author.userId,
          displayName: comment.author.displayName,
          image: comment.author.image,
        },
        body: comment.body,
        createdAt: comment.createdAt,
      })),
    })),
    commentRevision: detail.commentRevision,
    viewerUserId: detail.viewerUserId,
  };
}

/** The run's current comment state, read and checked as one hosted read. */
function readComments(
  externalId: string,
  unavailableRetry: CanopyRetryDirective,
): Promise<SharedRunCommentState> {
  return getSharedRun(externalId)
    .then((detail) => SharedRunCommentStateSchema.parse(commentState(detail)))
    .catch((error: unknown) => {
      throw readError(error, unavailableRetry);
    });
}

export function createCorePublicationAdapter(): CorePublicationAdapter {
  const closing = new AbortController();
  // Only a failure that offers a retry may run again under its key. Terminal
  // ones stay, so the key keeps refusing other parameters: not_found, and a
  // raw registry failure, which the dispatcher reports as internal, never.
  const forget = (error: unknown): boolean =>
    error instanceof CanopyOperationError &&
    error.payload.retry.kind !== 'never';
  // A landed write keeps only the hosted run it was sent to, so a key's
  // replay re-reads that run instead of holding a whole run's comments.
  // A forgotten (contended) outcome drops its params here; the key's
  // receipt below still refuses others (the CAN-7515 gap).
  const commentWrites = new KeyedOutcomes<string>({
    reusedError: keyReused,
    // A reused key's refusal must not bind the key to the other params.
    forget: (error): boolean =>
      forget(error) ||
      (error instanceof CanopyOperationError &&
        error.payload.kind === 'conflict'),
    max: MAX_KEYED_COMMENT_WRITES,
  });
  // Every key whose write may have landed, kept past the outcome cache's
  // eviction so the hosted write is never sent twice: its params'
  // fingerprint, and the run once it landed. A refusal the cloud confirmed
  // drops it; a contended one keeps only the fingerprint, free to resend.
  // shortcut: one entry of short strings per landed or uncertain write (and per 409), for the process's life and lost on restart; the hosted routes deduplicating by key replaces it (CAN-7897).
  const sentKeys = new Map<
    string,
    { fingerprint: string; run?: string; resend?: true }
  >();
  const writeComment = async (
    params: SharedChat,
    context: CanopyHandlerContext,
    send: (
      externalId: string,
      init: { beforeRequest: () => Promise<void> },
    ) => Promise<SharedRunDetail>,
  ): Promise<{ comments: SharedRunCommentState }> => {
    let landed: SharedRunCommentState | undefined;
    const { idempotencyKey } = context.metadata;
    const id =
      idempotencyKey === undefined
        ? undefined
        : `${context.caller.principalId}\0${idempotencyKey}`;
    const fingerprint = createHash('sha256')
      .update(stableStringify(params) ?? 'null')
      .digest('hex');
    const externalId = await commentWrites.run(context, params, async () => {
      const receipt = id === undefined ? undefined : sentKeys.get(id);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw keyReused();
        if (receipt.run !== undefined) return receipt.run;
        if (!receipt.resend) throw writeError(undefined, true);
      }
      const target = await requireExternalId(params);
      let sent = false;
      landed = await send(target, {
        beforeRequest: () => {
          // A cancelled call or a closing runtime sends nothing; a deadline
          // only means the caller stopped waiting, so the write still goes.
          const stopped = closing.signal.aborted
            ? closing.signal
            : context.signal.aborted
              ? context.signal
              : undefined;
          if (stopped && stopped.reason !== 'deadline')
            return Promise.reject(
              operationError(
                'cancelled',
                'The comment was cancelled before it was sent.',
                // What the dispatcher answers a cancelled caller with.
                { kind: 'never' },
              ),
            );
          sent = true;
          if (id !== undefined) sentKeys.set(id, { fingerprint });
          return Promise.resolve();
        },
      })
        // A reply that isn't a run's comments fails after the send, so it is
        // uncertain too, and the key replays that refusal.
        .then((detail) =>
          SharedRunCommentStateSchema.parse(commentState(detail)),
        )
        .catch((error: unknown) => {
          // The cloud's own refusal landed nothing.
          if (id !== undefined && sent && validated(error)) {
            if (error.status === 409)
              sentKeys.set(id, { fingerprint, resend: true });
            else sentKeys.delete(id);
          }
          throw writeError(error, sent);
        });
      if (id !== undefined) sentKeys.set(id, { fingerprint, run: target });
      return target;
    });
    if (landed) return { comments: landed };
    // A replay or a same-key join: never send again; re-read the run the
    // write went to, as it is now, so a caller who lost access fails closed.
    return {
      comments: await readComments(externalId, {
        kind: 'same_idempotency_key',
      }),
    };
  };

  const marks = new KeyedOutcomes<{
    seenRevision: number;
    unreadCount: number;
  }>({
    reusedError: keyReused,
    forget,
    // Room for settled replays even while the pending cap is full.
    max: 2 * MAX_PENDING_MARKS,
  });
  // Every accepted write counts toward the cap; close waits only for the
  // ones already writing, since a queued one cancels on its turn.
  const pending = new Set<Promise<unknown>>();
  const writing = new Set<Promise<unknown>>();
  return {
    close: async (): Promise<void> => {
      closing.abort('shutdown');
      await Promise.allSettled(writing);
    },
    queries: {
      'core.publication.comment.list': async (params) => {
        const entry = await readSharedRunCommentEntry(params);
        const lastSeenCommentRevision = entry?.lastSeenCommentRevision ?? 0;
        const externalId = await sharedRunExternalId(params);
        // Not shared, signed out, or a Cloud without comment routes: degrade
        // to "no comments", so an older server never breaks the chat UI. A
        // probe that fails is an outage, not an answer.
        if (!externalId || !(await runCommentsSupported()))
          return { comments: null, lastSeenCommentRevision };
        // Backfill: a run shared before comments shipped was never
        // registered, so it would never be polled and markSeen would miss
        // it. Best-effort: a failed write on this read must never turn "show
        // me the comments" into an error; the next read retries it.
        if (!entry)
          await registerSharedRunForComments({ ...params, externalId }).catch(
            () => undefined,
          );
        return {
          comments: await readComments(externalId, { kind: 'same_request' }),
          lastSeenCommentRevision,
        };
      },
    },
    instructions: {
      'core.publication.comment.create': (params, context) =>
        writeComment(params, context, (externalId, init) =>
          createRunCommentThread(externalId, params.body, params.anchor, init),
        ),
      'core.publication.comment.reply': (params, context) =>
        writeComment(params, context, (externalId, init) =>
          replyToRunCommentThread(
            externalId,
            params.threadId,
            params.body,
            init,
          ),
        ),
      'core.publication.comment.update': (params, context) =>
        writeComment(params, context, (externalId, init) =>
          setRunCommentThreadStatus(
            externalId,
            params.threadId,
            params.status,
            init,
          ),
        ),
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
