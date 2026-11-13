import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  type CanopyErrorPayload,
  type CanopyJsonValue,
  type CanopyStreamCursor,
  type CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../runtime/errors';
import type { EventJournal, JournalEntry } from './event-journal';
import {
  defineRuntimeModule,
  type RuntimeModule,
} from './runtime-profile-graph';

const SUBSCRIBE = 'core.events.subscribe';
const ACK = 'core.events.ack';
/** The web core's default (CAN-4157), so both cores bound delivery alike. */
const DEFAULT_MAX_IN_FLIGHT = 256;
/** Matched entries held for one subscriber before its stream ends. */
const DEFAULT_MAX_PENDING = 1_024;

/** One journaled event; the module adds its cursor and id when it serves it. */
export interface CoreEventRecord {
  readonly name: string;
  readonly scope: CanopyWorkspaceScope;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, CanopyJsonValue>>;
}

export interface CoreEventsModuleOptions {
  /** Its epoch must be the runtime's `daemonEpoch`: clients reject any other. */
  readonly journal: EventJournal<CoreEventRecord>;
  /** Served families; a subscriber may name these or a dot-boundary refinement. */
  readonly families: readonly string[];
  /** Events under a served family this core never emits; naming one is refused. */
  readonly unserved?: readonly string[];
  /** Matched entries waiting for room before the stream ends; default 1,024. */
  readonly maxPending?: number;
}

interface Subscription {
  /** Ack scoping: only the opening client instance acknowledges. */
  readonly owner: string;
  acknowledged: number;
  lastSent: number;
  /** Sequences sent and not yet acknowledged, ascending. */
  readonly inFlight: number[];
  readonly pump: () => void;
}

/** Dot-boundary prefix: `core.workspace` matches `core.workspace.committed`. */
function familyMatches(family: string, name: string): boolean {
  return name === family || name.startsWith(`${family}.`);
}

/** Field by field; an absent subscriber field matches every event. */
function scopeMatches(
  wanted: CanopyWorkspaceScope | undefined,
  scope: CanopyWorkspaceScope,
): boolean {
  if (!wanted) return true;
  const actual: Readonly<Record<string, string | undefined>> = scope;
  return Object.entries(wanted).every(
    ([key, value]) => value === undefined || actual[key] === value,
  );
}

const refusal = (payload: CanopyErrorPayload): CanopyOperationError =>
  new CanopyOperationError(payload);

/**
 * `core.events.subscribe` and `core.events.ack` over one host journal (W5e,
 * CAN-5497). It conforms to the contract the web core landed first
 * (CAN-4157): a null cursor is accepted as null and replays the journal's
 * latest entry; a foreign, expired or future cursor ends the stream with
 * `core.events.snapshotRequired`; at most `maxInFlight` items (default 256)
 * wait for acknowledgement; an unknown, ended or foreign-epoch ack is
 * `core.events.notFound`; an unserved family is `capability_unavailable`.
 */
export function createCoreEventsModule(
  options: CoreEventsModuleOptions,
): RuntimeModule {
  const { journal, families } = options;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  if (!Number.isSafeInteger(maxPending) || maxPending < 1)
    throw new RangeError('maxPending must be a positive integer.');
  const subscriptions = new Map<string, Subscription>();
  const unserved = options.unserved ?? [];
  const served = (family: string): boolean =>
    families.some((root) => familyMatches(root, family)) &&
    !unserved.some((name) => familyMatches(name, family));

  return defineRuntimeModule({
    name: 'core.events',
    plane: 'core',
    definitions: {
      queries: {},
      instructions: { [ACK]: CORE_TRANSPORT_INSTRUCTION_DEFINITIONS[ACK] },
      streams: { [SUBSCRIBE]: CORE_TRANSPORT_STREAM_DEFINITIONS[SUBSCRIBE] },
    },
    handlers: {
      queries: {},
      instructions: {
        [ACK]: (params, context) => {
          const subscription = subscriptions.get(params.subscriptionId);
          if (
            !subscription ||
            subscription.owner !== context.caller.clientInstanceId ||
            params.cursor.daemonEpoch !== journal.epoch
          )
            throw refusal({
              kind: 'not_found',
              code: 'core.events.notFound',
              message: 'The subscription was not found.',
              retry: { kind: 'never' },
            });
          // Never backwards and never past delivery: answers what it holds.
          const sequence = Math.min(
            params.cursor.sequence,
            subscription.lastSent,
          );
          if (sequence > subscription.acknowledged) {
            subscription.acknowledged = sequence;
            while (
              subscription.inFlight.length > 0 &&
              subscription.inFlight[0] <= sequence
            )
              subscription.inFlight.shift();
            subscription.pump();
          }
          return {
            acknowledgedCursor: {
              daemonEpoch: journal.epoch,
              sequence: subscription.acknowledged,
            },
          };
        },
      },
      streams: {
        [SUBSCRIBE]: (params, context, sink) => {
          const unsupported = params.families.filter(
            (family) => !served(family),
          );
          if (unsupported.length > 0)
            throw refusal({
              kind: 'capability_unavailable',
              message: `This core serves only the ${families.join(', ')} event families.`,
              details: { unsupported },
              retry: {
                kind: 'after_refresh',
                resource: 'core.runtime.manifest.get',
              },
            });
          const maxInFlight = params.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
          const accepted: CanopyStreamCursor | null = params.cursor ?? null;
          const pending: JournalEntry<CoreEventRecord>[] = [];
          let ended = false;
          const end = (error: CanopyErrorPayload): void => {
            ended = true;
            pending.length = 0;
            sink.end('error', error);
          };
          const subscription: Subscription = {
            owner: context.caller.clientInstanceId,
            acknowledged: accepted?.sequence ?? 0,
            lastSent: accepted?.sequence ?? 0,
            inFlight: [],
            pump: (): void => {
              while (
                !ended &&
                pending.length > 0 &&
                subscription.inFlight.length < maxInFlight
              ) {
                const entry = pending.shift();
                if (!entry) break;
                const { cursor, event } = entry;
                const sent = sink.emitAt(cursor, {
                  cursor,
                  eventId: `${cursor.daemonEpoch}#${cursor.sequence}`,
                  name: event.name,
                  scope: { ...event.scope },
                  occurredAt: event.occurredAt,
                  payload: { ...event.payload },
                });
                // The dispatcher ended the stream (buffer, caller or schema).
                if (!sent) {
                  ended = true;
                  return;
                }
                subscription.lastSent = cursor.sequence;
                subscription.inFlight.push(cursor.sequence);
              }
            },
          };
          const opened = journal.subscribe(accepted, (entry) => {
            if (ended) return;
            if (
              !params.families.some((family) =>
                familyMatches(family, entry.event.name),
              ) ||
              !scopeMatches(params.scope, entry.event.scope)
            )
              return;
            pending.push(entry);
            if (pending.length > maxPending) {
              end({
                kind: 'resource_exhausted',
                message:
                  'The subscriber fell too far behind; subscribe again from its cursor or a snapshot.',
                retry: { kind: 'after_refresh', resource: SUBSCRIBE },
              });
              return;
            }
            subscription.pump();
          });
          if (opened.kind === 'snapshot_required') {
            end({
              kind: 'failed_precondition',
              code: 'core.events.snapshotRequired',
              message: `The event cursor cannot resume (${opened.reason}); read a snapshot and subscribe again.`,
              retry: { kind: 'after_refresh', resource: SUBSCRIBE },
            });
            return Promise.resolve();
          }
          subscriptions.set(context.requestId, subscription);
          return Promise.resolve((): void => {
            ended = true;
            opened.unsubscribe();
            subscriptions.delete(context.requestId);
          });
        },
      },
    },
  });
}
