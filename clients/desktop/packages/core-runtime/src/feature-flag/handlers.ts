import {
  CORE_FEATURE_FLAG_KEYS,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import {
  FEATURE_FLAG_ERROR_CODES,
  type CORE_FEATURE_FLAG_QUERY_DEFINITIONS,
  type CORE_FEATURE_FLAG_STREAM_DEFINITIONS,
  type FeatureFlagEvent,
  type FeatureFlagProvenance,
  type FeatureFlagSnapshotGetResult,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../runtime/errors';
import type {
  CanopyDispatcherHandlerMap,
  CanopyDispatcherStreamHandlerMap,
} from '../runtime/types';

/** The host's flag evaluator: desktop's FeatureFlagService, or a server evaluator. */
export interface CoreFeatureFlagHost {
  snapshot(): FeatureFlagSnapshot;
  /** Calls the listener after every change to the snapshot. */
  subscribe(listener: () => void): () => void;
  /**
   * Changes whenever the targeting context (the signed-in account) changes;
   * never carries the identity itself.
   */
  contextGeneration?(): number;
}

export interface CoreFeatureFlagHandlers {
  queries: CanopyDispatcherHandlerMap<
    typeof CORE_FEATURE_FLAG_QUERY_DEFINITIONS
  >;
  streams: CanopyDispatcherStreamHandlerMap<
    typeof CORE_FEATURE_FLAG_STREAM_DEFINITIONS
  >;
}

export interface CoreFeatureFlagHandlerOptions {
  /** Names this host's events stream; defaults to a random epoch. */
  readonly epoch?: string;
  /** Revisions a cursor can resume from (default 256). */
  readonly retain?: number;
}

type Values = Record<string, boolean | number | string>;

interface Subscriber {
  /** The epoch the stream opened in. */
  readonly epoch: string;
  deliver(entry: Revision): void;
  /** The targeting context changed: end the stream with snapshotRequired. */
  reset(): void;
}

interface Revision {
  readonly revision: number;
  readonly changed: Values;
  readonly provenanceChanged: boolean;
  readonly provenance: FeatureFlagProvenance;
  readonly evaluatedAt: string;
}

// The evaluator's own error text can name host paths and the OS user; it
// stays on the host, and clients get this instead, with status as the signal.
const EVALUATOR_ERROR = 'The feature flag evaluator reported an error.';

/** Only flags core owns or shares cross this contract. */
function coreValues(values: Readonly<Record<string, unknown>>): Values {
  const out: Values = {};
  for (const key of CORE_FEATURE_FLAG_KEYS) {
    const value = values[key];
    if (
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      out[key] = value;
  }
  return out;
}

function provenanceOf(snapshot: FeatureFlagSnapshot): FeatureFlagProvenance {
  return {
    status: snapshot.status,
    initialized: snapshot.initialized,
    error: snapshot.error === null ? null : EVALUATOR_ERROR,
  };
}

function narrow(values: Values, keys: readonly string[] | undefined): Values {
  if (keys === undefined) return { ...values };
  const out: Values = {};
  for (const key of keys)
    if (Object.prototype.hasOwnProperty.call(values, key))
      out[key] = values[key];
  return out;
}

function snapshotRequired(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: FEATURE_FLAG_ERROR_CODES.SNAPSHOT_REQUIRED,
    message:
      'The feature flag cursor belongs to another stream or is past retention. Read the snapshot, then reopen the stream without a cursor.',
    details: { reason: 'SNAPSHOT_REQUIRED' },
    retry: { kind: 'after_refresh', resource: 'core.featureFlag.events' },
  });
}

/**
 * `core.featureFlag.*` (CAN-4181) over one host evaluator. Core serves only
 * the flags the registry assigns to core or to both; a client never supplies
 * a value, so a client cannot open a path core keeps closed.
 */
export function createCoreFeatureFlagHandlers(
  host: CoreFeatureFlagHost,
  options: CoreFeatureFlagHandlerOptions = {},
): CoreFeatureFlagHandlers {
  let epoch = options.epoch ?? crypto.randomUUID();
  const retain = options.retain ?? 256;
  const initial = host.snapshot();
  let values = coreValues(initial.values);
  let provenance = provenanceOf(initial);
  let evaluatedAt = initial.updatedAt;
  let revision = 0;
  let generation = host.contextGeneration?.() ?? 0;
  const log: Revision[] = [];
  const subscribers = new Set<Subscriber>();

  // Delivery is serialized: a change a subscriber makes while revision N is
  // being delivered reaches every subscriber after N, never before it. A
  // string is a reset that ends the streams of that epoch only, so a stream
  // reopened in a newer epoch outlives an older reset still queued.
  const pending: Array<Revision | string> = [];
  let delivering = false;
  const deliver = (item: Revision | string): void => {
    pending.push(item);
    if (delivering) return;
    delivering = true;
    try {
      for (
        let next = pending.shift();
        next !== undefined;
        next = pending.shift()
      )
        for (const subscriber of [...subscribers])
          if (typeof next !== 'string') subscriber.deliver(next);
          else if (subscriber.epoch === next) subscriber.reset();
    } finally {
      delivering = false;
    }
  };

  // One subscription for the host's lifetime keeps revisions counting
  // whether or not a stream is open.
  host.subscribe(() => {
    const snapshot = host.snapshot();
    const next = coreValues(snapshot.values);
    const nextProvenance = provenanceOf(snapshot);
    const changed: Values = {};
    for (const [key, value] of Object.entries(next))
      if (values[key] !== value) changed[key] = value;
    const provenanceChanged =
      nextProvenance.status !== provenance.status ||
      nextProvenance.initialized !== provenance.initialized ||
      nextProvenance.error !== provenance.error;
    // A refresh that changes nothing is still a fresher evaluation.
    evaluatedAt = snapshot.updatedAt;
    const nextGeneration = host.contextGeneration?.() ?? generation;
    const contextChanged = nextGeneration !== generation;
    if (
      !contextChanged &&
      Object.keys(changed).length === 0 &&
      !provenanceChanged
    )
      return;
    values = next;
    provenance = nextProvenance;
    revision += 1;
    if (contextChanged) {
      // Another account's history must not replay: a targeting context
      // change ends open streams, drops the retained revisions and starts a
      // new epoch. The new values are installed first, so a stream reopened
      // from the end frame opens on them, never on the previous account's.
      const ended = epoch;
      generation = nextGeneration;
      epoch = crypto.randomUUID();
      log.length = 0;
      deliver(ended);
      return;
    }
    const entry: Revision = {
      revision,
      changed,
      provenanceChanged,
      provenance,
      evaluatedAt,
    };
    log.push(entry);
    if (log.length > retain) log.shift();
    deliver(entry);
  });

  return {
    queries: {
      'core.featureFlag.snapshot.get': (
        params,
      ): FeatureFlagSnapshotGetResult => ({
        revision,
        flags: narrow(values, params.keys),
        provenance,
        evaluatedAt,
      }),
    },
    streams: {
      'core.featureFlag.events': (params, _context, sink) => {
        const cursor = params.cursor ?? null;
        const oldest = log[0]?.revision ?? revision + 1;
        if (
          cursor !== null &&
          (cursor.daemonEpoch !== epoch ||
            cursor.sequence > revision ||
            (cursor.sequence < revision && oldest > cursor.sequence + 1))
        )
          return Promise.reject(snapshotRequired());
        const streamEpoch = epoch;
        let last = cursor?.sequence ?? -1;
        const emit = (at: number, event: FeatureFlagEvent): boolean => {
          if (at <= last) return true;
          last = at;
          return (
            sink.emitAt({ daemonEpoch: streamEpoch, sequence: at }, event) !==
            null
          );
        };
        // A revision that changes nothing in the caller's keys is skipped.
        const emitEntry = (entry: Revision): boolean => {
          const changed = narrow(entry.changed, params.keys);
          if (Object.keys(changed).length === 0 && !entry.provenanceChanged)
            return true;
          return emit(entry.revision, {
            revision: entry.revision,
            changed,
            provenance: entry.provenance,
            evaluatedAt: entry.evaluatedAt,
          });
        };
        // Attached before the opening events, which hold what arrives while
        // they are sent, so a change made from an opening event is not lost.
        let opening = true;
        const held: Revision[] = [];
        const subscriber: Subscriber = {
          epoch: streamEpoch,
          deliver: (entry) => {
            if (opening) held.push(entry);
            else if (!emitEntry(entry)) subscribers.delete(subscriber);
          },
          reset: () => {
            subscribers.delete(subscriber);
            sink.end('error', snapshotRequired().payload);
          },
        };
        subscribers.add(subscriber);
        const opened =
          cursor === null
            ? // Without a cursor the first event is the current state.
              emit(revision, {
                revision,
                changed: narrow(values, params.keys),
                provenance,
                evaluatedAt,
              })
            : [...log].every(
                (entry) =>
                  entry.revision <= cursor.sequence || emitEntry(entry),
              );
        // Still opening while held revisions drain, so a change made while
        // one is sent queues behind the rest instead of overtaking them.
        let drained = opened;
        for (
          let next = held.shift();
          drained && next !== undefined;
          next = held.shift()
        )
          drained = emitEntry(next);
        opening = false;
        if (!drained) {
          subscribers.delete(subscriber);
          return Promise.resolve();
        }
        return Promise.resolve(() => {
          subscribers.delete(subscriber);
        });
      },
    },
  };
}
