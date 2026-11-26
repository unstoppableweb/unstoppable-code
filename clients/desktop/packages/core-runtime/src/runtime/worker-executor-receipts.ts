import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  safeParseCanopySchema,
  type CanopyErrorPayload,
  type CanopyInstructionDefinitionMap,
  type CanopyJsonValue,
} from '@canopy/protocol/canopy-core';

import { translateCanopyHandlerError } from './dispatcher';
import {
  CanopyOperationError,
  canopyInvalidHandlerResultError,
} from './errors';
import { dispatchTagScope, type DispatchTagScope } from './dispatch-tag-scope';
import type { CanopyHandlerContext } from './types';

/**
 * What the worker knows about one keyed instruction it received: still
 * running, or how its handler settled. The handler's own settlement, not the
 * reply the dispatcher sent, which a cancel or deadline can cut short.
 */
export type WorkerExecutorReceipt =
  | { state: 'running' }
  /** `result` is absent when it is not bounded JSON (32 KiB). */
  | { state: 'completed'; result?: CanopyJsonValue }
  | { state: 'failed'; error: CanopyErrorPayload };

/**
 * What a lookup answers (CAN-4733): never received this run, still running,
 * settled, or received but no longer kept.
 */
export type WorkerExecutorReceiptView =
  | { state: 'absent' }
  | { state: 'running' }
  | { state: 'forgotten' }
  | {
      state: 'settled';
      outcome:
        | { status: 'completed'; result?: CanopyJsonValue }
        | { status: 'failed'; error: CanopyErrorPayload };
    };

/** A receipt that crossed the worker pair, or undefined when malformed. */
export function parseWorkerExecutorReceipt(
  value: unknown,
): WorkerExecutorReceipt | undefined {
  if (typeof value !== 'object' || value === null || !('state' in value))
    return undefined;
  if (value.state === 'running') return { state: 'running' };
  if (value.state === 'completed') {
    if (!('result' in value)) return { state: 'completed' };
    const result = CanopyJsonValueSchema.safeParse(value.result);
    return result.success
      ? { state: 'completed', result: result.data }
      : undefined;
  }
  if (value.state === 'failed' && 'error' in value) {
    const error = CanopyErrorPayloadSchema.safeParse(value.error);
    return error.success ? { state: 'failed', error: error.data } : undefined;
  }
  return undefined;
}

// Method-derived, so typed instruction handler maps widen without casts.
type InstructionHandler = {
  run(params: unknown, context: CanopyHandlerContext): unknown;
}['run'];

interface Entry {
  /** Resolves when the handler settles; the receipt is final from then on. */
  readonly settled: Promise<void>;
  receipt: WorkerExecutorReceipt;
  /** Set only for a replayed operation: the first request's parameters. */
  readonly fingerprint?: string;
  /** A replayed operation's full completed result, whatever its size. */
  replayResult?: { readonly value: unknown; readonly size: number };
}

/** Settled receipts the core has not released yet, beyond which the oldest go. */
export const WORKER_EXECUTOR_RECEIPTS_MAX = 4_096;

/**
 * Keys a replayed operation may accept in one worker run. Every accepted key
 * is remembered for the run, by digest once its receipt is gone, so a late
 * repeat is refused instead of run again; past the bound, new keys are
 * refused instead of letting an old one become runnable.
 */
export const WORKER_EXECUTOR_REPLAYED_KEYS_MAX = 1_048_576;

/**
 * Dispatch tags one peer (an interface caller's principal and client
 * instance, as the core scopes them) may record or seal in one worker run,
 * so one peer exhausting its share leaves every other peer's tags working.
 * The run-wide bound above still caps all peers together.
 */
export const WORKER_EXECUTOR_DISPATCH_TAGS_PER_PEER_MAX = 65_536;

/**
 * Serialized size, in UTF-16 code units, of the full results replayed
 * operations keep for replay, whatever the receipt's bounded copy holds.
 * Past it the oldest settled receipts are forgotten, and their keys refused.
 */
export const WORKER_EXECUTOR_REPLAY_RESULTS_MAX = 64 * 1024 * 1024;

/**
 * Keyed instructions whose repeated key replays the first request's
 * settlement instead of running again (CAN-4733), the digest that binds a
 * key to its parameters (it never sees `_meta`), and the short digest a key
 * is remembered by once its receipt is gone.
 */
export interface WorkerExecutorReplay {
  readonly operations: ReadonlySet<string>;
  fingerprint(params: unknown): string;
  keyDigest(key: string): string;
}

/** Why a key was refused rather than run or replayed. */
export type WorkerExecutorReplayRefusal =
  | 'key-reused'
  | 'not-retained'
  | 'keys-exhausted'
  | 'tag-reused'
  | 'not-started'
  | 'tag-unscoped';

const REFUSALS: Record<
  WorkerExecutorReplayRefusal,
  Pick<CanopyErrorPayload, 'kind' | 'message'>
> = {
  'key-reused': {
    kind: 'conflict',
    message: 'This idempotency key was already used for a different request.',
  },
  'not-retained': {
    kind: 'failed_precondition',
    message:
      'The outcome of the request with this idempotency key is no longer kept.',
  },
  'keys-exhausted': {
    kind: 'resource_exhausted',
    message:
      'This worker accepts no more keyed requests of this kind until it restarts.',
  },
  'tag-reused': {
    kind: 'conflict',
    message: 'This dispatch tag was already used for another dispatch.',
  },
  'not-started': {
    kind: 'failed_precondition',
    message:
      'This dispatch tag was sealed before the dispatch arrived, so it was refused before it ran. Send it again with a new tag.',
  },
  'tag-unscoped': {
    kind: 'invalid_argument',
    message: 'This dispatch tag was not scoped to a caller by the core.',
  },
};

/** Which dispatch tag bound refused a tag. */
export type WorkerExecutorTagBound = 'peer' | 'principal' | 'worker';

/**
 * A dispatch tag bound's message names its scope, because a worker binding
 * carries the message across but not the details.
 */
const TAG_BOUND_MESSAGES: Record<WorkerExecutorTagBound, string> = {
  peer: 'This caller may record no more dispatch tags on this worker until it restarts.',
  principal:
    "This caller's principal may record no more dispatch tags on this worker, from any of its sessions, until it restarts.",
  worker:
    'This worker accepts no more dispatch tags from any caller until it restarts.',
};

function replayRefusal(
  reason: WorkerExecutorReplayRefusal,
  scope?: WorkerExecutorTagBound,
): CanopyOperationError {
  return new CanopyOperationError({
    ...REFUSALS[reason],
    ...(scope && { message: TAG_BOUND_MESSAGES[scope] }),
    details: { receipt: reason, ...(scope && { scope }) },
    retry: { kind: 'never' },
  });
}

function withoutMeta(params: unknown): unknown {
  if (typeof params !== 'object' || params === null || Array.isArray(params))
    return params;
  return Object.fromEntries(
    Object.entries(params).filter(([name]) => name !== '_meta'),
  );
}

export interface WorkerExecutorReceipts {
  /**
   * Wraps the worker's instruction handlers. A keyed request is recorded
   * under its caller, operation and idempotency key before its handler runs.
   * For most operations a repeated key reaches its handler as before, and
   * only the first is recorded. For a replayed operation a repeated key
   * never runs the handler again: it waits for and returns the first
   * request's settlement, and is refused when its parameters differ or that
   * settlement is no longer kept.
   */
  wrap<H extends Readonly<Record<string, InstructionHandler>>>(
    handlers: H,
  ): Record<string, InstructionHandler>;
  /**
   * The receipt for a keyed request once its handler settles; null when the
   * worker never received it. Waits for a running handler.
   */
  settled(
    principalId: string,
    operation: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkerExecutorReceipt | null>;
  /** The core recorded this outcome; the worker forgets it. */
  release(principalId: string, operation: string, idempotencyKey: string): void;
  /**
   * How one dispatch stands, without waiting, replaying or recording
   * anything: by a keyed request's idempotency key or by its report-only
   * dispatch tag. Absent may still be a dispatch on its way.
   */
  lookup(
    principalId: string,
    operation: string,
    lookup: { idempotencyKey: string } | { dispatchId: string },
  ): WorkerExecutorReceiptView;
  /**
   * How one tagged dispatch stands, sealing the tag when the worker never
   * received it: in the same synchronous step a dispatch records its tag, so
   * a dispatch carrying it that arrives later is refused before it runs, and
   * absent is final for this worker run. Past the tag bound nothing can be
   * sealed, so an unknown tag answers forgotten.
   */
  seal(
    principalId: string,
    operation: string,
    dispatchId: string,
  ): WorkerExecutorReceiptView;
}

const keyOf = (principalId: string, operation: string, key: string): string =>
  JSON.stringify([principalId, operation, key]);
const dispatchKeyOf = (
  principalId: string,
  operation: string,
  dispatchId: string,
): string => JSON.stringify([principalId, operation, 'dispatch', dispatchId]);

/**
 * The executor half of shared idempotency (`execution-targets.yaml`
 * `shared_idempotency`): the bundled worker remembers each keyed instruction
 * it received, so the core can resolve an unknown reply by asking for it
 * instead of sending it again (`unknown_outcome`). In memory: the bundled
 * worker shares the core's process, so a restart loses both, and the core's
 * operation ledger reconciles the interrupted work. A worker in its own
 * process needs these to persist (CAN-5073).
 */
export function createWorkerExecutorReceipts(
  definitions: CanopyInstructionDefinitionMap,
  options: {
    max?: number;
    replay?: WorkerExecutorReplay;
    maxReplayedKeys?: number;
    maxDispatchTagsPerPeer?: number;
    /**
     * Dispatch tags a caller principal may record or seal in one run,
     * across all its peers, or undefined for a principal bounded only by
     * the run-wide bound. It is given the principal as the tag carries it
     * (`dispatchTagPrincipal`). A host whose callers can open new peers at
     * will bounds them, so one principal rotating peers can't take the run.
     */
    maxDispatchTagsForPrincipal?: (principal: string) => number | undefined;
    maxReplayResults?: number;
    /** Flat digests of forgotten keys and tags; without it they are kept verbatim. */
    digest?: (text: string) => string;
  } = {},
): WorkerExecutorReceipts {
  const max = options.max ?? WORKER_EXECUTOR_RECEIPTS_MAX;
  const maxReplayedKeys =
    options.maxReplayedKeys ?? WORKER_EXECUTOR_REPLAYED_KEYS_MAX;
  const maxDispatchTagsPerPeer =
    options.maxDispatchTagsPerPeer ??
    WORKER_EXECUTOR_DISPATCH_TAGS_PER_PEER_MAX;
  const maxReplayResults =
    options.maxReplayResults ?? WORKER_EXECUTOR_REPLAY_RESULTS_MAX;
  // Kept replay results' total size, against `maxReplayResults`.
  let replayResultsSize = 0;
  const { replay } = options;
  const entries = new Map<string, Entry>();
  // Settlement order, for eviction past the bound.
  const settledOrder = new Set<string>();
  // Replayed keys whose receipt is gone, by digest; never evicted.
  const forgotten = new Set<string>();
  // Replayed keys accepted this run; bounds `forgotten`.
  let replayedKeys = 0;
  const digest: ((text: string) => string) | undefined =
    options.digest ??
    (replay ? (text: string): string => replay.keyDigest(text) : undefined);
  const digestOf = (id: string): string => (digest ? digest(id) : id);
  // Keys of other keyed operations whose receipt is gone, oldest first; only
  // what a lookup reports, since those operations never replay. Once one is
  // dropped, an unknown key reads forgotten: absent must mean never received.
  const lapsed = new Set<string>();
  let lapsedOverflowed = false;
  const rememberLapsed = (digest: string): void => {
    lapsed.add(digest);
    while (lapsed.size > maxReplayedKeys) {
      const oldest = lapsed.values().next().value;
      if (oldest === undefined) break;
      lapsed.delete(oldest);
      lapsedOverflowed = true;
    }
  };
  const forget = (id: string): void => {
    const entry = entries.get(id);
    entries.delete(id);
    settledOrder.delete(id);
    if (entry?.replayResult) replayResultsSize -= entry.replayResult.size;
    if (entry?.fingerprint !== undefined) forgotten.add(digestOf(id));
    else if (entry) rememberLapsed(digestOf(id));
  };
  // Report-only receipts by dispatch tag, for every instruction (CAN-4733).
  const dispatches = new Map<string, Entry>();
  const dispatchOrder = new Set<string>();
  const forgottenDispatches = new Set<string>();
  // Tags sealed while absent; a dispatch carrying one is refused unrun.
  const sealedDispatches = new Set<string>();
  // Tags dispatched or sealed this run; bounds both sets.
  let dispatchTags = 0;
  const peerDispatchTags = new Map<string, number>();
  const principalDispatchTags = new Map<string, number>();
  const { maxDispatchTagsForPrincipal } = options;
  const principalBound = (principal: string): number =>
    maxDispatchTagsForPrincipal?.(principal) ?? Number.POSITIVE_INFINITY;
  /** Why a peer may record no more tags, or undefined when it may. */
  const tagBound = ({
    principal,
    peer,
  }: DispatchTagScope): WorkerExecutorTagBound | undefined =>
    dispatchTags >= maxReplayedKeys
      ? 'worker'
      : (principalDispatchTags.get(principal) ?? 0) >= principalBound(principal)
        ? 'principal'
        : (peerDispatchTags.get(peer) ?? 0) >= maxDispatchTagsPerPeer
          ? 'peer'
          : undefined;
  const countTag = ({ principal, peer }: DispatchTagScope): void => {
    dispatchTags += 1;
    peerDispatchTags.set(peer, (peerDispatchTags.get(peer) ?? 0) + 1);
    principalDispatchTags.set(
      principal,
      (principalDispatchTags.get(principal) ?? 0) + 1,
    );
  };
  /** The core-issued scope of a tag; a tag the core did not scope is refused. */
  const scopeOf = (tag: string): DispatchTagScope => {
    const scope = dispatchTagScope(tag);
    if (scope === undefined) throw replayRefusal('tag-unscoped');
    return scope;
  };
  const forgetDispatch = (id: string): void => {
    dispatches.delete(id);
    dispatchOrder.delete(id);
    forgottenDispatches.add(digestOf(id));
  };
  const replayed = async (
    entry: Entry,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (entry.receipt.state === 'running') {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void =>
          reject(
            // The earlier request may still commit, so this answer never says
            // whether it did: unavailable, as a lost reply reads (CAN-7196).
            new CanopyOperationError({
              kind: 'unavailable',
              message:
                'The request stopped waiting for the earlier request with its idempotency key.',
              retry: { kind: 'same_idempotency_key' },
            }),
          );
        signal.addEventListener('abort', onAbort, { once: true });
        void entry.settled.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
    const { receipt } = entry;
    if (receipt.state === 'failed')
      throw new CanopyOperationError({
        ...receipt.error,
        retry: { kind: 'never' },
      });
    if (receipt.state === 'completed' && entry.replayResult)
      return entry.replayResult.value;
    throw replayRefusal('not-retained');
  };
  const run = (
    name: string,
    handler: InstructionHandler,
    params: unknown,
    context: CanopyHandlerContext,
  ): unknown => {
    const tag = context.metadata.dispatchId;
    const definition = definitions[name];
    if (tag === undefined || definition === undefined)
      return runKeyed(name, handler, params, context);
    const scope = dispatchTagScope(tag);
    if (scope === undefined)
      return Promise.reject(replayRefusal('tag-unscoped'));
    const id = dispatchKeyOf(context.caller.principalId, name, tag);
    if (dispatches.has(id) || forgottenDispatches.has(digestOf(id)))
      return Promise.reject(replayRefusal('tag-reused'));
    if (sealedDispatches.has(digestOf(id)))
      return Promise.reject(replayRefusal('not-started'));
    const bound = tagBound(scope);
    if (bound) return Promise.reject(replayRefusal('keys-exhausted', bound));
    countTag(scope);
    let markSettled: () => void = () => undefined;
    const entry: Entry = {
      settled: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
      receipt: { state: 'running' },
    };
    dispatches.set(id, entry);
    const settle = (receipt: WorkerExecutorReceipt): void => {
      entry.receipt = receipt;
      dispatchOrder.add(id);
      while (dispatchOrder.size > max) {
        const oldest = dispatchOrder.values().next().value;
        if (oldest === undefined) break;
        forgetDispatch(oldest);
      }
      markSettled();
    };
    return Promise.resolve()
      .then(() => runKeyed(name, handler, params, context))
      .then(
        (raw) => {
          const parsed = safeParseCanopySchema(definition.result, raw);
          const json = parsed.success
            ? CanopyJsonValueSchema.safeParse(parsed.data)
            : undefined;
          settle(
            !parsed.success
              ? {
                  state: 'failed',
                  error: canopyInvalidHandlerResultError().payload,
                }
              : json?.success
                ? { state: 'completed', result: json.data }
                : { state: 'completed' },
          );
          return raw;
        },
        (error: unknown) => {
          settle({
            state: 'failed',
            error: translateCanopyHandlerError(definition, error).payload,
          });
          throw error;
        },
      );
  };
  const runKeyed = (
    name: string,
    handler: InstructionHandler,
    params: unknown,
    context: CanopyHandlerContext,
  ): unknown => {
    const key = context.metadata.idempotencyKey;
    const definition = definitions[name];
    if (key === undefined || definition === undefined)
      return handler(params, context);
    const id = keyOf(context.caller.principalId, name, key);
    const fingerprint = replay?.operations.has(name)
      ? replay.fingerprint(withoutMeta(params))
      : undefined;
    const existing = entries.get(id);
    if (fingerprint !== undefined) {
      if (existing)
        return existing.fingerprint === fingerprint
          ? replayed(existing, context.signal)
          : Promise.reject(replayRefusal('key-reused'));
      if (forgotten.has(digestOf(id)))
        return Promise.reject(replayRefusal('not-retained'));
      if (replayedKeys >= maxReplayedKeys)
        return Promise.reject(replayRefusal('keys-exhausted'));
      replayedKeys += 1;
    } else if (existing) return handler(params, context);
    let markSettled: () => void = () => undefined;
    const entry: Entry = {
      settled: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
      receipt: { state: 'running' },
      ...(fingerprint !== undefined && { fingerprint }),
    };
    entries.set(id, entry);
    const settle = (
      receipt: WorkerExecutorReceipt,
      replayResult?: { value: unknown; size: number },
    ): void => {
      entry.receipt = receipt;
      if (replayResult) {
        entry.replayResult = replayResult;
        replayResultsSize += replayResult.size;
      }
      settledOrder.add(id);
      while (settledOrder.size > max || replayResultsSize > maxReplayResults) {
        const oldest = settledOrder.values().next().value;
        if (oldest === undefined) break;
        forget(oldest);
      }
      markSettled();
    };
    return Promise.resolve()
      .then(() => handler(params, context))
      .then(
        (raw) => {
          const parsed = safeParseCanopySchema(definition.result, raw);
          if (!parsed.success)
            settle({
              state: 'failed',
              error: canopyInvalidHandlerResultError().payload,
            });
          else {
            // The work completed either way; only a bounded result is kept,
            // except that replay keeps the full result for its repeats.
            const json = CanopyJsonValueSchema.safeParse(parsed.data);
            settle(
              json.success
                ? { state: 'completed', result: json.data }
                : { state: 'completed' },
              fingerprint === undefined
                ? undefined
                : {
                    value: parsed.data,
                    size: JSON.stringify(parsed.data)?.length ?? 0,
                  },
            );
          }
          return raw;
        },
        (error: unknown) => {
          settle({
            state: 'failed',
            error: translateCanopyHandlerError(definition, error).payload,
          });
          throw error;
        },
      );
  };
  return {
    wrap: (handlers) =>
      Object.fromEntries(
        Object.entries(handlers).map(([name, handler]) => [
          name,
          (params: unknown, context: CanopyHandlerContext): unknown =>
            run(name, handler, params, context),
        ]),
      ),
    settled: async (
      principalId,
      operation,
      idempotencyKey,
      signal,
    ): Promise<WorkerExecutorReceipt | null> => {
      const entry = entries.get(keyOf(principalId, operation, idempotencyKey));
      if (!entry) return null;
      if (entry.receipt.state === 'running') {
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void =>
            reject(
              signal?.reason instanceof Error
                ? signal.reason
                : new Error('The receipt wait was aborted.'),
            );
          signal?.addEventListener('abort', onAbort, { once: true });
          void entry.settled.then(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
        });
      }
      return entry.receipt;
    },
    release: (principalId, operation, idempotencyKey): void => {
      const id = keyOf(principalId, operation, idempotencyKey);
      const entry = entries.get(id);
      if (!entry || entry.receipt.state === 'running') return;
      forget(id);
    },
    lookup: (principalId, operation, lookup): WorkerExecutorReceiptView => {
      if ('dispatchId' in lookup) {
        scopeOf(lookup.dispatchId);
        const id = dispatchKeyOf(principalId, operation, lookup.dispatchId);
        const entry = dispatches.get(id);
        if (entry) return viewOf(entry.receipt);
        return forgottenDispatches.has(digestOf(id))
          ? { state: 'forgotten' }
          : { state: 'absent' };
      }
      const id = keyOf(principalId, operation, lookup.idempotencyKey);
      const entry = entries.get(id);
      if (entry) return viewOf(entry.receipt);
      const gone = digestOf(id);
      return forgotten.has(gone) ||
        lapsed.has(gone) ||
        (lapsedOverflowed && !replay?.operations.has(operation))
        ? { state: 'forgotten' }
        : { state: 'absent' };
    },
    seal: (principalId, operation, dispatchId): WorkerExecutorReceiptView => {
      const scope = scopeOf(dispatchId);
      const id = dispatchKeyOf(principalId, operation, dispatchId);
      const entry = dispatches.get(id);
      if (entry) return viewOf(entry.receipt);
      const gone = digestOf(id);
      if (forgottenDispatches.has(gone)) return { state: 'forgotten' };
      if (sealedDispatches.has(gone)) return { state: 'absent' };
      if (tagBound(scope)) return { state: 'forgotten' };
      sealedDispatches.add(gone);
      countTag(scope);
      return { state: 'absent' };
    },
  };
}

function viewOf(receipt: WorkerExecutorReceipt): WorkerExecutorReceiptView {
  if (receipt.state === 'running') return { state: 'running' };
  if (receipt.state === 'failed')
    return {
      state: 'settled',
      outcome: { status: 'failed', error: receipt.error },
    };
  return {
    state: 'settled',
    outcome:
      'result' in receipt
        ? { status: 'completed', result: receipt.result }
        : { status: 'completed' },
  };
}
