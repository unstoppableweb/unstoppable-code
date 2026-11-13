import { createInMemoryFramedPair } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CoreClientLeaseAcquireParamsSchema,
  CoreClientLeaseReleaseParamsSchema,
  CoreClientLeaseRenewParamsSchema,
  type CanopyErrorPayload,
  type CoreClientLease,
  type CoreRuntimeInitializeResult,
} from '@canopy/protocol/canopy-core';

import { createCanopyClient, type CanopyClient } from '../../index';
import {
  CanonicalCoreError,
  canonicalInitializeResult,
  serveCanonicalCore,
  type CanonicalCoreServer,
  type CanonicalHandlers,
} from './canonical-core';

const ACQUIRE = 'core.client.lease.acquire' as const;
const RENEW = 'core.client.lease.renew' as const;
const RELEASE = 'core.client.lease.release' as const;
const METHODS = [ACQUIRE, RENEW, RELEASE];
type LeaseMethod = (typeof METHODS)[number];

/** Carries every transport instruction: a superset of the lease port. */
export type LeaseTestClient = CanopyClient<
  Record<never, never>,
  typeof CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  Record<never, never>
>;

export const leaseError = (
  code: 'notFound' | 'invalidState' | 'revisionConflict',
): CanopyErrorPayload => ({
  kind: code === 'notFound' ? 'not_found' : 'conflict',
  message: `Lease ${code}.`,
  code: `core.client.lease.${code}`,
  retry: { kind: 'never' },
});

export interface LeaseCall {
  readonly method: LeaseMethod;
  readonly params: Record<string, unknown>;
  readonly connection: number;
}

type Held = { revision: number; connection: number; clientInstanceId: string };
/**
 * A typed error, a gate before answering, or a committed answer whose reply
 * `deliver` holds and `fail` replaces with an error: a lost reply.
 */
type Outcome =
  | CanopyErrorPayload
  | Promise<void>
  | { readonly deliver?: Promise<void>; readonly fail?: CanopyErrorPayload };

/**
 * Fake core lease registry shared across connections: leases outlive their
 * connection until `evict`, and a reconnect naming a held `previousLeaseId`
 * keeps it while `retain` is set. A keyed acquire replays its original
 * outcome from any connection, rebinding a lease only while it is held.
 */
export class FakeLeaseCore {
  readonly calls: LeaseCall[] = [];
  readonly leases = new Map<string, Held>();
  readonly servers: CanopyFramedConnection[] = [];
  renewAfterMs = 15_000;
  ttlMs = 60_000;
  retain = true;
  private readonly scripted = new Map<LeaseMethod, Outcome[]>();
  private readonly byKey = new Map<
    string,
    CoreClientLease | CanopyErrorPayload
  >();
  private nextLease = 1;

  /** Queues outcomes for the next calls of `method`. */
  script(method: LeaseMethod, ...outcomes: Outcome[]): void {
    this.scripted.set(method, [
      ...(this.scripted.get(method) ?? []),
      ...outcomes,
    ]);
  }

  callsOf(method: LeaseMethod): LeaseCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async connect(): Promise<LeaseTestClient> {
    const { client: connection, server } = await createInMemoryFramedPair();
    this.serve(server);
    return createCanopyClient({
      connection,
      clientName: 'lease-test',
      clientVersion: '1.0.0',
      definitions: {
        queries: {},
        instructions: CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
        streams: {},
      },
    });
  }

  /**
   * Serves the lease operations, plus `handlers`, on any server end, for
   * example one an HTTP test server opened.
   */
  serve(
    server: CanopyFramedConnection,
    options: {
      readonly handlers?: CanonicalHandlers;
      /** Replaces fields of the initialize result, lease-only by default. */
      readonly initialize?: Partial<CoreRuntimeInitializeResult>;
    } = {},
  ): CanonicalCoreServer {
    const index = this.servers.push(server) - 1;
    const handle =
      (method: LeaseMethod) =>
      async (params: Record<string, unknown>): Promise<unknown> => {
        this.calls.push({ method, params, connection: index });
        const outcome = this.scripted.get(method)?.shift();
        if (outcome instanceof Promise) await outcome;
        else if (outcome && !('kind' in outcome)) {
          const answer = this.answer(method, index, params);
          await outcome.deliver;
          if (outcome.fail) throw new CanonicalCoreError(outcome.fail);
          return answer;
        } else if (outcome) {
          this.remember(method, params, outcome);
          throw new CanonicalCoreError(outcome);
        }
        return this.answer(method, index, params);
      };
    const handlers = {
      ...options.handlers,
      ...Object.fromEntries(METHODS.map((m) => [m, handle(m)])),
    };
    const capabilities = { operations: METHODS, events: [], streams: [] };
    return serveCanonicalCore(server, handlers, {
      initialize: canonicalInitializeResult({
        capabilities,
        ...options.initialize,
      }),
    });
  }

  evict(leaseId: string): void {
    this.leases.delete(leaseId);
  }

  /** A terminal acquire error is its key's outcome; a retryable one is not. */
  private remember(
    method: LeaseMethod,
    raw: Record<string, unknown>,
    error: CanopyErrorPayload,
  ): void {
    const { kind } = error.retry;
    if (method !== ACQUIRE || kind.startsWith('same_')) return;
    const { _meta } = CoreClientLeaseAcquireParamsSchema.parse(raw);
    this.byKey.set(_meta.idempotencyKey, error);
  }

  private answer(
    method: LeaseMethod,
    connection: number,
    raw: Record<string, unknown>,
  ): unknown {
    const bound = Array.from(this.leases).find(
      ([, held]) => held.connection === connection,
    );
    if (method === ACQUIRE) {
      const params = CoreClientLeaseAcquireParamsSchema.parse(raw);
      const cached = this.byKey.get(params._meta.idempotencyKey);
      if (cached && !('leaseId' in cached))
        throw new CanonicalCoreError(cached);
      if (cached) {
        const held = this.leases.get(cached.leaseId);
        if (held) held.connection = connection;
        return cached;
      }
      if (bound) this.leases.delete(bound[0]);
      const previous = params.previousLeaseId;
      const leaseId =
        previous && this.retain && this.leases.has(previous)
          ? previous
          : `lease-${this.nextLease++}`;
      const lease = this.grant(leaseId, connection, params.clientInstanceId);
      this.byKey.set(params._meta.idempotencyKey, lease);
      return lease;
    }
    if (method === RENEW) {
      const { expectedRevision } = CoreClientLeaseRenewParamsSchema.parse(raw);
      if (!bound) throw new CanonicalCoreError(leaseError('notFound'));
      const [leaseId, held] = bound;
      if (held.revision !== expectedRevision)
        throw new CanonicalCoreError(leaseError('revisionConflict'));
      return this.grant(leaseId, connection, held.clientInstanceId);
    }
    CoreClientLeaseReleaseParamsSchema.parse(raw);
    if (bound) this.leases.delete(bound[0]);
    return {
      released: bound !== undefined,
      releasedRegistrationCount: 0,
      failedRequestIds: [],
    };
  }

  private grant(
    leaseId: string,
    connection: number,
    clientInstanceId: string,
  ): CoreClientLease {
    const revision = (this.leases.get(leaseId)?.revision ?? -1) + 1;
    this.leases.set(leaseId, { revision, connection, clientInstanceId });
    return {
      leaseId,
      clientInstanceId,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      renewAfterMs: this.renewAfterMs,
      revision,
    };
  }
}
