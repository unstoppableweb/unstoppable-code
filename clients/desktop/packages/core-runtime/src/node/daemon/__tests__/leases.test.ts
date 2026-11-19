import type {
  CanopySchemaOutput,
  CoreClientLeaseAcquireParamsSchema,
} from '@canopy/protocol/canopy-core';
import {
  createCanopyLeaseRegistry,
  createCanopyObligationRegistry,
  startCanopyIdleGrace,
  type CanopyDaemonClock,
} from '../leases';
import { CanopyOperationError } from '../../../runtime/errors';

type AcquireParams = CanopySchemaOutput<
  typeof CoreClientLeaseAcquireParamsSchema
>;

function manualClock(): CanopyDaemonClock & { advance(ms: number): void } {
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer(run, delayMs): { cancel(): void } {
      const timer = { at: now + delayMs, run };
      timers.add(timer);
      return { cancel: () => void timers.delete(timer) };
    },
    advance(ms): void {
      now += ms;
      for (const timer of Array.from(timers).sort((a, b) => a.at - b.at))
        if (timer.at <= now && timers.delete(timer)) timer.run();
    },
  };
}

function thrown(run: () => unknown): CanopyOperationError['payload'] {
  try {
    run();
  } catch (error) {
    if (error instanceof CanopyOperationError) return error.payload;
    throw error;
  }
  throw new Error('Expected an operation error.');
}

let key = 0;
function params(overrides: Partial<AcquireParams> = {}): AcquireParams {
  return {
    clientInstanceId: 'client-1',
    interfaceKind: 'desktop',
    label: 'Desktop',
    interactive: true,
    foreground: true,
    renewalIntervalMs: 15_000,
    _meta: { idempotencyKey: `key-${(key += 1)}` },
    ...overrides,
  };
}

function setup(): {
  clock: ReturnType<typeof manualClock>;
  leases: ReturnType<typeof createCanopyLeaseRegistry>;
  ends: string[];
} {
  const clock = manualClock();
  const leases = createCanopyLeaseRegistry({}, clock);
  const ends: string[] = [];
  leases.onEnd((lease, end) => ends.push(`${lease.leaseId}:${end}`));
  return { clock, leases, ends };
}

describe('client lease registry', () => {
  it('clamps renewal intervals to 5–60 s and sets a four-renewal TTL', () => {
    const { leases } = setup();
    const low = leases.acquire('a', params({ renewalIntervalMs: 1_000 }));
    const high = leases.acquire(
      'b',
      params({ clientInstanceId: 'client-2', renewalIntervalMs: 300_000 }),
    );
    expect([low.renewAfterMs, high.renewAfterMs]).toEqual([5_000, 60_000]);
    expect(Date.parse(low.expiresAt)).toBe(20_000);
    expect(Date.parse(leases.acquire('c', params()).expiresAt)).toBe(60_000);
  });

  it('evicts at the TTL, and renew then reports notFound', () => {
    const { clock, leases, ends } = setup();
    const lease = leases.acquire('a', params());
    clock.advance(59_999);
    const renew = { interactive: true, foreground: true };
    expect(leases.renew('a', { ...renew, expectedRevision: 0 }).revision).toBe(
      1,
    );
    clock.advance(60_000);
    expect(ends).toEqual([`${lease.leaseId}:evicted`]);
    expect(
      thrown(() => leases.renew('a', { ...renew, expectedRevision: 1 })),
    ).toMatchObject({
      code: 'core.client.lease.notFound',
    });
  });

  it('rejects a stale renewal revision as revisionConflict', () => {
    const { leases } = setup();
    leases.acquire('a', params());
    expect(
      thrown(() =>
        leases.renew('a', {
          expectedRevision: 7,
          interactive: true,
          foreground: false,
        }),
      ),
    ).toMatchObject({
      kind: 'conflict',
      code: 'core.client.lease.revisionConflict',
      retry: { kind: 'after_refresh', resource: 'core.client.lease' },
    });
  });

  it('replays a keyed acquire and fences it after release', () => {
    const { leases } = setup();
    const request = params();
    const lease = leases.acquire('a', request);
    expect(leases.acquire('b', request).leaseId).toBe(lease.leaseId);
    expect(leases.holder(lease.leaseId)).toBe('b');
    expect(
      thrown(() => leases.acquire('b', { ...request, label: 'Changed' })),
    ).toMatchObject({ kind: 'invalid_argument', retry: { kind: 'never' } });
    expect(leases.release('b')).toBe(true);
    expect(leases.release('b')).toBe(false);
    expect(thrown(() => leases.acquire('c', request))).toMatchObject({
      code: 'core.client.lease.notFound',
    });
  });

  it('retains a detached lease for the same client within the grace only', () => {
    const { clock, leases, ends } = setup();
    const lease = leases.acquire('a', params());
    leases.detach('a');
    expect(leases.holder(lease.leaseId)).toBeNull();
    const other = leases.acquire(
      'b',
      params({ clientInstanceId: 'client-2', previousLeaseId: lease.leaseId }),
    );
    expect(other.leaseId).not.toBe(lease.leaseId);
    clock.advance(9_999);
    const kept = leases.acquire(
      'c',
      params({ previousLeaseId: lease.leaseId }),
    );
    expect(kept).toMatchObject({ leaseId: lease.leaseId, revision: 1 });
    leases.detach('c');
    clock.advance(10_000);
    expect(ends).toEqual([`${lease.leaseId}:evicted`]);
    expect(
      leases.acquire('d', params({ previousLeaseId: lease.leaseId })).leaseId,
    ).not.toBe(lease.leaseId);
  });

  it('holds one lease per connection', () => {
    const { leases } = setup();
    const lease = leases.acquire('a', params());
    expect(leases.acquire('a', params()).leaseId).toBe(lease.leaseId);
    expect(
      thrown(() =>
        leases.acquire('a', params({ clientInstanceId: 'client-2' })),
      ),
    ).toMatchObject({
      code: 'core.client.lease.invalidState',
    });
  });

  it('records a new key against a held lease and replays it after reconnect', () => {
    const { leases } = setup();
    const lease = leases.acquire('a', params());
    const retry = params();
    expect(leases.acquire('a', retry).leaseId).toBe(lease.leaseId);
    leases.detach('a');
    expect(leases.acquire('b', retry).leaseId).toBe(lease.leaseId);
  });

  it('never answers a replay with an unrelated held lease', () => {
    const { leases } = setup();
    const first = params();
    const original = leases.acquire('a', first);
    leases.release('a');
    leases.acquire('a', params());
    expect(thrown(() => leases.acquire('a', first))).toMatchObject({
      code: 'core.client.lease.notFound',
    });
    const other = params({ clientInstanceId: 'client-1' });
    leases.acquire('b', other);
    leases.detach('b');
    expect(thrown(() => leases.acquire('a', other))).toMatchObject({
      code: 'core.client.lease.invalidState',
    });
    expect(leases.lease('a')?.leaseId).not.toBe(original.leaseId);
  });

  it('rejects a previousLeaseId longer than a lease id', () => {
    const { leases } = setup();
    expect(
      thrown(() =>
        leases.acquire('a', params({ previousLeaseId: 'x'.repeat(513) })),
      ),
    ).toMatchObject({ kind: 'invalid_argument' });
  });

  it('moves a rebound lease off its previous connection', () => {
    const { leases } = setup();
    const lease = leases.acquire('a', params());
    leases.acquire('b', params({ previousLeaseId: lease.leaseId }));
    expect(leases.lease('a')).toBeNull();
    expect(leases.release('a')).toBe(false);
    expect(leases.lease('b')?.leaseId).toBe(lease.leaseId);
  });

  it('expires a lease on access even when its timer fires late', () => {
    let now = 0;
    const leases = createCanopyLeaseRegistry(
      {},
      {
        now: () => now,
        setTimer: (): { cancel(): void } => ({ cancel: () => undefined }),
      },
    );
    const lease = leases.acquire('a', params());
    now = 60_000;
    expect(
      thrown(() =>
        leases.renew('a', {
          expectedRevision: 0,
          interactive: true,
          foreground: true,
        }),
      ),
    ).toMatchObject({ code: 'core.client.lease.notFound' });
    const late = leases.acquire('a', params());
    leases.detach('a');
    now += 10_000;
    expect(
      leases.acquire('b', params({ previousLeaseId: late.leaseId })).leaseId,
    ).not.toBe(late.leaseId);
    expect(lease.leaseId).not.toBe(late.leaseId);
  });

  it('re-acquires a held lease only as itself, for its own client', () => {
    const { leases } = setup();
    const first = leases.acquire('a', params());
    leases.detach('a');
    const held = leases.acquire('b', params());
    expect(
      thrown(() =>
        leases.acquire('b', params({ previousLeaseId: first.leaseId })),
      ),
    ).toMatchObject({ code: 'core.client.lease.invalidState' });
    expect(leases.holder(first.leaseId)).toBeNull();
    expect(
      thrown(() =>
        leases.acquire(
          'b',
          params({
            clientInstanceId: 'client-2',
            previousLeaseId: held.leaseId,
          }),
        ),
      ),
    ).toMatchObject({ code: 'core.client.lease.invalidState' });
    expect(leases.size).toBe(2);
    expect(leases.lease('b')?.leaseId).toBe(held.leaseId);
    expect(
      leases.acquire('b', params({ previousLeaseId: held.leaseId })).leaseId,
    ).toBe(held.leaseId);
  });

  it('never revives an expired lease on disconnect', () => {
    let now = 0;
    const leases = createCanopyLeaseRegistry(
      {},
      {
        now: () => now,
        setTimer: (): { cancel(): void } => ({ cancel: () => undefined }),
      },
    );
    const lease = leases.acquire('a', params());
    now = 60_000;
    leases.detach('a');
    expect(leases.size).toBe(0);
    expect(leases.holder(lease.leaseId)).toBeNull();
    expect(
      leases.acquire('b', params({ previousLeaseId: lease.leaseId })).leaseId,
    ).not.toBe(lease.leaseId);
  });

  it('refuses acquires once closed', () => {
    const { leases } = setup();
    leases.close();
    expect(thrown(() => leases.acquire('a', params()))).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('rejects invalid timing options', () => {
    expect(() => createCanopyLeaseRegistry({ reconnectGraceMs: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      createCanopyLeaseRegistry({
        minRenewalIntervalMs: 10,
        maxRenewalIntervalMs: 5,
      }),
    ).toThrow(RangeError);
  });
});

describe('idle grace', () => {
  it('calls onIdle once after the grace with no lease or obligation', () => {
    const { clock, leases } = setup();
    const onIdle = jest.fn();
    startCanopyIdleGrace(
      leases,
      createCanopyObligationRegistry(),
      onIdle,
      { graceMs: 30_000 },
      clock,
    );
    clock.advance(29_999);
    expect(onIdle).not.toHaveBeenCalled();
    clock.advance(1);
    leases.acquire('a', params());
    leases.release('a');
    clock.advance(60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by a lease or an obligation and restarts after both end', () => {
    const { clock, leases } = setup();
    const obligations = createCanopyObligationRegistry();
    const onIdle = jest.fn();
    const idle = startCanopyIdleGrace(
      leases,
      obligations,
      onIdle,
      { graceMs: 30_000 },
      clock,
    );
    clock.advance(29_000);
    leases.acquire('a', params());
    const release = obligations.hold('test');
    leases.release('a');
    clock.advance(60_000);
    expect(onIdle).not.toHaveBeenCalled();
    release();
    release();
    expect(obligations.size).toBe(0);
    clock.advance(29_999);
    expect(onIdle).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    idle.close();
  });

  it('never fires once closed', () => {
    const { clock, leases } = setup();
    const onIdle = jest.fn();
    startCanopyIdleGrace(
      leases,
      createCanopyObligationRegistry(),
      onIdle,
      {},
      clock,
    ).close();
    clock.advance(60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
