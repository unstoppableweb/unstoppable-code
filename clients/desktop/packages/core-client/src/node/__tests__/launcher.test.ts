import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';

import { toCanopyClientError, CanopyClientError } from '../../errors';
import {
  attachOrStartCanopyDaemon,
  type CanopyDaemonLaunchOptions,
  type CanopyDaemonLaunchResult,
} from '../launcher';
import type { CanopySpawnedDaemon } from '../launcher-ports';
import {
  canopyDaemonRefusal,
  canopyDaemonRefusalError,
} from '../daemon-refusal';
import {
  descriptorFor,
  ScriptedDaemon,
  type ScriptedPort,
} from './fixtures/scripted-daemon';

const HASH = 'a'.repeat(64);
const CLAIMED = ['read', 'acquire', 'read'];
const INSPECT = ['read', 'inspect:7'];
type Overrides = Partial<CanopyDaemonLaunchOptions<string>>;
type Outcome = CanopyDaemonLaunchResult<string> | { error: CanopyErrorPayload };

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/** Moves the monotonic clock past every deadline without delivering any timer. */
const jumpClock = (): void =>
  void jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 6e4);

function launch(
  world: ScriptedDaemon,
  overrides: Overrides = {},
): Promise<CanopyDaemonLaunchResult<string>> {
  return attachOrStartCanopyDaemon<string>({
    dataRoot: '/private/data',
    dataRootHash: HASH,
    runtimeMode: 'production',
    daemon: { executable: '/private/bin/canopy', args: ['daemon'] },
    ports: world,
    attach: world.attach,
    dispose: (client) => void world.events.push(`dispose:${client}`),
    platform: 'darwin',
    timeoutMs: 1_000,
    ...overrides,
  });
}

/** Advances fake time past the deadline; failures must never echo paths or secrets. */
async function run(
  launching: Promise<CanopyDaemonLaunchResult<string>>,
): Promise<Outcome> {
  const settled = launching.catch(
    (error: unknown): Outcome => ({
      error: toCanopyClientError(error).payload,
    }),
  );
  await jest.advanceTimersByTimeAsync(1_000);
  const outcome = await settled;
  if ('error' in outcome)
    expect(JSON.stringify(outcome)).not.toMatch(/private|secret/);
  return outcome;
}

it('attaches to a live daemon with its token and hash, never claiming', async () => {
  const world = new ScriptedDaemon();
  world.publish(7);
  expect(await run(launch(world))).toEqual({
    value: 'client-1',
    descriptor: descriptorFor(7),
    started: false,
  });
  expect(world.events).toEqual([
    'read',
    'inspect:7',
    'token:secret-token-ref',
    'attach:1000',
  ]);
  const auth = { secret: 'secret', dataRootHash: HASH };
  const path = '/private/run/core.sock';
  expect(world.endpoints).toEqual([{ kind: 'socket', path, auth }]);
});

it('claims, re-probes, then spawns once with explicit switches and the opaque handle', async () => {
  const world = new ScriptedDaemon();
  expect(await run(launch(world))).toMatchObject({
    value: 'client-1',
    descriptor: descriptorFor(900),
    started: true,
  });
  expect(world.events.slice(0, 4)).toEqual([
    'read',
    'acquire',
    'read',
    'spawn',
  ]);
  expect(world.spawns).toEqual([
    {
      executable: '/private/bin/canopy',
      args: [
        'daemon',
        '--data-root',
        '/private/data',
        '--runtime-mode',
        'production',
      ],
      signal: world.spawns[0]?.signal,
      claimHandle: world.handle,
    },
  ]);
  expect(world.spawns[0]?.claimHandle).toBe(world.handle);
  expect(world.spawns[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(world.count('release')).toBe(0);
});

it.each([null, 'reused-pid'])(
  'starts over a stale descriptor (%s)',
  async (identity) => {
    const world = new ScriptedDaemon();
    world.raw = descriptorFor(5);
    if (identity) world.live.set(5, identity);
    expect(await run(launch(world))).toMatchObject({ started: true });
    expect(world.count('spawn')).toBe(1);
  },
);

it('re-probes before spawning on Windows and hands off no claim', async () => {
  const world = new ScriptedDaemon();
  const ports = { descriptor: world.descriptor, supervisor: world.supervisor };
  const outcome = await run(launch(world, { platform: 'win32', ports }));
  expect(outcome).toMatchObject({ started: true });
  expect(world.events.slice(0, 3)).toEqual(['read', 'read', 'spawn']);
  expect(world.spawns[0]).not.toHaveProperty('claimHandle');
  const posix = await run(launch(world, { ports }));
  expect(posix).toMatchObject({ error: { kind: 'invalid_argument' } });
});

describe('on Windows without a startup claim', () => {
  const unclaimed = (
    world: ScriptedDaemon,
    signal?: AbortSignal,
  ): Overrides => ({
    platform: 'win32',
    ports: { descriptor: world.descriptor, supervisor: world.supervisor },
    ...(signal && { signal }),
  });

  it("attaches to a sibling launcher's daemon that publishes after its own child lost the endpoint", async () => {
    const world = new ScriptedDaemon();
    // Our daemon exits at once ("Endpoint is in use."); the winner publishes later.
    world.child = (pid): void => void setTimeout(() => world.exit(pid), 10);
    setTimeout(() => world.publish(7), 400);
    expect(await run(launch(world, unclaimed(world)))).toEqual({
      value: 'client-1',
      descriptor: descriptorFor(7),
      started: false,
    });
    expect(world.count('spawn')).toBe(1);
    // The exited child is rolled back before the winner's token is read.
    expect(world.events.slice(-3)).toEqual([
      'terminate:900',
      'token:secret-token-ref',
      'attach:600',
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ['nothing', null],
    ['its own stale descriptor', descriptorFor(900)],
  ] as const)(
    'reports an exit before readiness once the deadline passes with %s published',
    async (_, raw) => {
      const world = new ScriptedDaemon();
      world.child = (pid): void => {
        world.raw = raw;
        world.exit(pid);
      };
      const outcome = await run(launch(world, unclaimed(world)));
      expect(outcome).toMatchObject({
        error: {
          kind: 'unavailable',
          message: 'Core exited before it was ready.',
        },
      });
      expect(outcome).not.toHaveProperty('value');
      expect(world.count('spawn')).toBe(1);
      // Kept probing for a winner until the deadline instead of failing at once.
      expect(world.count('read')).toBeGreaterThan(5);
      expect(world.events).toContain('terminate:900');
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('reports a child exit during the final probe sleep instead of a timeout', async () => {
    const world = new ScriptedDaemon();
    world.child = (pid): void => void setTimeout(() => world.exit(pid), 950);
    const outcome = await run(launch(world, unclaimed(world)));
    expect(outcome).toMatchObject({
      error: {
        kind: 'unavailable',
        message: 'Core exited before it was ready.',
      },
    });
    expect(world.count('read')).toBeGreaterThan(5);
    expect(world.events).toContain('terminate:900');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports an exit while the final descriptor read is blocked', async () => {
    const world = new ScriptedDaemon();
    world.child = (pid): void => void setTimeout(() => world.exit(pid), 950);
    world.gates.set('read', () =>
      world.count('read') >= 10
        ? new Promise<never>(() => {})
        : Promise.resolve(),
    );
    const outcome = await run(launch(world, unclaimed(world)));
    expect(outcome).toMatchObject({
      error: {
        kind: 'unavailable',
        message: 'Core exited before it was ready.',
      },
    });
    expect(world.events).toContain('terminate:900');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports an exit after an unattachable live descriptor goes stale', async () => {
    const world = new ScriptedDaemon();
    world.refusals = 100;
    world.child = (pid): void => {
      setTimeout(() => world.publish(pid), 10);
      setTimeout(() => {
        world.raw = null;
        world.exit(pid);
      }, 950);
    };
    const outcome = await run(launch(world, unclaimed(world)));
    expect(world.count('attach')).toBeGreaterThan(0);
    expect(outcome).toMatchObject({
      error: {
        kind: 'unavailable',
        message: 'Core exited before it was ready.',
      },
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the timeout when only rollback makes the child exit', async () => {
    const world = new ScriptedDaemon();
    world.child = (): void => {};
    const outcome = await run(launch(world, unclaimed(world)));
    expect(outcome).toMatchObject({ error: { kind: 'deadline_exceeded' } });
    expect(world.events).toContain('terminate:900');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the timeout when the child exit is observed after the monotonic deadline', async () => {
    const world = new ScriptedDaemon();
    world.child = (pid): void =>
      void setTimeout(() => {
        jumpClock();
        world.exit(pid);
      }, 950);
    const outcome = await run(launch(world, unclaimed(world)));
    expect(outcome).toMatchObject({ error: { kind: 'deadline_exceeded' } });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops waiting for a winner when the caller cancels', async () => {
    const world = new ScriptedDaemon();
    const abort = new AbortController();
    world.child = (pid): void => world.exit(pid);
    setTimeout(() => abort.abort(), 300);
    const outcome = await run(launch(world, unclaimed(world, abort.signal)));
    expect(outcome).toMatchObject({ error: { kind: 'cancelled' } });
    expect(world.count('spawn')).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

it.each<[string, (world: ScriptedDaemon) => void, RegExp]>([
  [
    'incompatible live major',
    (w): void => w.publish(7, 3),
    /restart the daemon/i,
  ],
  ['malformed descriptor', (w): void => void (w.raw = { pid: 7 }), /malformed/],
])('fails closed on an %s without claiming', async (_, arrange, message) => {
  const world = new ScriptedDaemon();
  arrange(world);
  const outcome = await run(launch(world));
  expect(outcome).toMatchObject({ error: { kind: 'failed_precondition' } });
  expect(JSON.stringify(outcome)).toMatch(message);
  expect(world.count('acquire') + world.count('spawn')).toBe(0);
});

it('waits while the claim is held, then attaches to the winner without spawning', async () => {
  const world = new ScriptedDaemon();
  world.acquisitions = ['held', 'held', 'acquired'];
  setTimeout(() => world.publish(7), 150);
  const outcome = await run(launch(world));
  expect(outcome).toMatchObject({
    started: false,
    descriptor: descriptorFor(7),
  });
  expect(world.count('acquire')).toBe(2);
  expect(world.count('spawn')).toBe(0);
});

it('re-probes after the holder releases with nothing published, then spawns once', async () => {
  const world = new ScriptedDaemon();
  world.acquisitions = ['held', 'acquired'];
  expect(await run(launch(world))).toMatchObject({ started: true });
  expect(world.events.slice(0, 6)).toEqual([
    'read',
    'acquire',
    'read',
    'acquire',
    'read',
    'spawn',
  ]);
});

it('reports started false when a reused PID replaced the exited child', async () => {
  const world = new ScriptedDaemon();
  world.child = (pid): void =>
    void setTimeout(() => {
      world.exit(pid);
      world.live.set(pid, 'reused-start');
      world.raw = { ...descriptorFor(pid), startIdentity: 'reused-start' };
    }, 10);
  expect(await run(launch(world))).toMatchObject({
    value: 'client-1',
    started: false,
  });
  expect(world.count('spawn')).toBe(1);
  expect(world.released).toEqual([world.handle]);
});

/** Passes the next deadline check, then fails later ones: between two port calls. */
const preemptNext = (kind: string, abort: AbortController): void => {
  const now = performance.now();
  const clock = jest.spyOn(performance, 'now').mockReturnValueOnce(now);
  clock.mockImplementation(() =>
    kind === 'cancelled' ? (abort.abort(), now) : now + 6e4,
  );
};

it.each([
  ['spawn', 'deadline_exceeded'],
  ['spawn', 'cancelled'],
  ['release', 'deadline_exceeded'],
  ['release', 'cancelled'],
] as const)('releases a %s claim preempted by %s', async (port, kind) => {
  const world = new ScriptedDaemon();
  const abort = new AbortController();
  if (port === 'release')
    world.gates.set('acquire', () => Promise.resolve(world.publish(7)));
  world.gates.set('read', () =>
    Promise.resolve(world.count('read') === 2 && preemptNext(kind, abort)),
  );
  const outcome = await run(launch(world, { signal: abort.signal }));
  expect(outcome).toMatchObject({ error: { kind } });
  expect(world.released).toEqual([world.handle]);
  expect(world.count('spawn') + world.count('attach')).toBe(0);
});

type Arrange = (w: ScriptedDaemon, a: AbortController) => (() => void) | void;
const hangRead: Arrange = (w) =>
  void w.gates.set('read', () =>
    w.count('read') > 1 ? new Promise(() => {}) : Promise.resolve(),
  );
const onRead =
  (n: number, act: Arrange): Arrange =>
  (w, a) =>
    void w.gates.set('read', () =>
      Promise.resolve(w.count('read') === n && act(w, a)),
    );
const exitChild =
  (
    snapshot = 'none',
    result: ScriptedDaemon['releaseResult'] = 'released',
  ): Arrange =>
  (w) => {
    w.releaseResult = result;
    w.child = (pid): void => {
      if (snapshot === 'same' || snapshot === 'removed') w.publish(pid);
      if (snapshot === 'none') setTimeout(() => w.exit(pid), 50);
      else w.exit(pid);
      if (snapshot === 'removed') w.raw = null;
      if (snapshot === 'malformed') w.raw = { pid };
    };
  };
const underClaim =
  (result: ScriptedDaemon['releaseResult'] = 'released'): Arrange =>
  (w) => {
    w.releaseResult = result;
    w.gates.set('acquire', () => Promise.resolve(w.publish(7)));
  };
const noOwner = exitChild('none', 'not_owner');
const ambiguousExit = exitChild('none', 'ambiguous');
const notOwner: Arrange = (w, a) => {
  reacquire(w, a);
  w.releaseResult = 'not_owner';
};
const rejection = (): Promise<never> =>
  Promise.reject(new Error('/private secret'));
const rejectSpawn: Arrange = (w) => void w.gates.set('spawn', rejection);
const lateReject: Arrange = (w) =>
  void w.gates.set('spawn', () => (jumpClock(), rejection()));
const lateResolve: Arrange = (w) =>
  void w.gates.set('spawn', () => Promise.resolve(jumpClock()));
const cancelBefore: Arrange = (w, a) => {
  hangRead(w, a);
  setTimeout(() => a.abort(), 300);
};
const precheck: Arrange = onRead(2, (_, a) =>
  preemptNext('deadline_exceeded', a),
);
const duringExit: Arrange = onRead(3, (w) => w.exit(900));
const afterExit: Arrange = (w) => {
  w.refusals = Infinity;
  w.gates.set('attach', () => Promise.resolve(w.exit(900)));
};
const reacquire: Arrange = (w) => {
  w.refusals = 1;
  w.gates.set('acquire', () =>
    Promise.resolve(w.count('acquire') === 1 && w.publish(7)),
  );
  w.gates.set('attach', () => Promise.resolve(w.exit(7)));
};
const lateAcquire: Arrange = (w, a) => {
  hangRead(w, a);
  const gate = w.defer('acquire');
  return () => gate.open();
};
const noPublish: Arrange = (w) => void (w.child = (): void => {});
const cancelReady: Arrange = (w, a) => {
  w.child = (): void => {};
  setTimeout(() => a.abort(), 300);
};
const ambiguousLive = underClaim('ambiguous');
const malformedExit = exitChild('malformed');
const timeout = 'deadline_exceeded';
const unavailable = 'unavailable';
// Each token is released once unless a child without a confirmed exit may hold it.
it.each<[string, Arrange, string, boolean]>([
  ['live under claim', underClaim(), 'ok', false],
  ['live under claim not_owner', underClaim('not_owner'), 'ok', false],
  ['live under claim ambiguous', ambiguousLive, 'failed_precondition', false],
  ['deadline before spawn', hangRead, timeout, false],
  ['cancel before spawn', cancelBefore, 'cancelled', false],
  ['late acquisition', lateAcquire, timeout, false],
  ['monotonic spawn precheck', precheck, timeout, false],
  ['spawn rejection', rejectSpawn, unavailable, false],
  ['late spawn rejection', lateReject, timeout, false],
  ['late resolved spawn', lateResolve, timeout, false],
  ['exit before classification', exitChild(), unavailable, false],
  ['exit not_owner', noOwner, unavailable, false],
  ['exit ambiguous', ambiguousExit, unavailable, false],
  ['exit during classification', duringExit, unavailable, false],
  ['exit after classification', afterExit, unavailable, false],
  ['unseen publication removed', exitChild('removed'), unavailable, false],
  ['same-PID after exit', exitChild('same'), unavailable, false],
  ['malformed after exit', malformedExit, 'failed_precondition', false],
  ['readiness timeout', noPublish, timeout, false],
  ['readiness cancel', cancelReady, 'cancelled', false],
  ['started daemon', (): void => {}, 'ok', true],
  ['reacquisition', reacquire, 'ok', true],
  ['reacquisition not_owner', notOwner, 'ok', true],
])('applies the release rule after %s', async (name, arrange, kind, held) => {
  const world = new ScriptedDaemon();
  const abort = new AbortController();
  const settleLate = arrange(world, abort);
  const outcome = await run(launch(world, { signal: abort.signal }));
  settleLate?.();
  expect('error' in outcome ? outcome.error.kind : 'ok').toBe(kind);
  await jest.advanceTimersByTimeAsync(0);
  const { acquired, released } = world;
  const freed = held ? acquired.slice(0, -1) : acquired;
  expect(released.map((h) => acquired.indexOf(h))).toEqual(
    freed.map((_h, i) => i),
  );
  expect(world.freed.has(world.handle)).toBe(
    !held && world.releaseResult === 'released',
  );
  if (released[0] && world.releaseResult !== 'ambiguous') {
    const currentFreed = world.freed.has(world.handle);
    expect(await world.claim.release(released[0])).toBe('not_owner');
    expect(world.freed.has(world.handle)).toBe(currentFreed);
  }
  if (acquired.length > 1) {
    expect(acquired).toHaveLength(2);
    expect(acquired[1]).not.toBe(acquired[0]);
    expect(world.spawns[0]?.claimHandle).toBe(acquired[1]);
    expect(world.live.has(900)).toBe(true);
  }
  if (/before spawn|spawn precheck|late acquisition/.test(name))
    expect(world.count('spawn')).toBe(0);
  if (name.startsWith('readiness') || name.startsWith('exit '))
    expect(world.count('spawn')).toBe(1);
  if (name.startsWith('live under claim'))
    expect(world.count('attach')).toBe(kind === 'ok' ? 1 : 0);
  if (name.startsWith('live under claim') && kind === 'ok') {
    expect(outcome).toMatchObject({ value: 'client-1', started: false });
    expect(world.events.slice(0, 7)).toEqual([
      ...CLAIMED,
      'inspect:7',
      'release',
      'token:secret-token-ref',
      'attach:1000',
    ]);
  }
  if (name.startsWith('reacquisition')) {
    expect(outcome).toMatchObject({ started: true });
    const firstSpawn = world.events.indexOf('spawn');
    expect(
      world.events.slice(world.events.indexOf('attach:1000'), firstSpawn + 1),
    ).toEqual(['attach:1000', ...INSPECT, 'acquire', ...INSPECT, 'spawn']);
  }
  expect(world.count('spawn')).toBeLessThanOrEqual(1);
  expect(jest.getTimerCount()).toBe(0);
});

// Another PID after the child's exit: release once, then attach (or fail closed).
it.each([
  ['released', { value: 'client-2', started: false }],
  ['not_owner', { value: 'client-2', started: false }],
  ['ambiguous', { error: { kind: 'failed_precondition' } }],
] as const)('releases an exited child claim (%s)', async (result, want) => {
  const world = new ScriptedDaemon();
  world.releaseResult = result;
  world.refusals = 1;
  world.child = (pid): void =>
    void setTimeout(() => (world.exit(pid), world.publish(7)), 10);
  expect(await run(launch(world))).toMatchObject(want);
  expect(world.released).toEqual([world.handle]);
  expect(world.count('spawn')).toBe(1);
});

it.each(['deadline_exceeded', 'cancelled'] as const)(
  'releases an exited child claim preempted by %s',
  async (kind) => {
    const world = new ScriptedDaemon();
    const abort = new AbortController();
    world.child = (pid): void => world.exit(pid);
    // The post-classification check passes; the release precheck is preempted.
    world.gates.set('read', () =>
      Promise.resolve(world.count('read') === 3 && preemptNext(kind, abort)),
    );
    const outcome = await run(launch(world, { signal: abort.signal }));
    expect(outcome).toMatchObject({ error: { kind } });
    expect(world.events).toEqual([
      ...CLAIMED,
      'spawn',
      'read',
      'terminate:900',
      'release',
    ]);
    expect(world.released).toEqual([world.handle]);
    expect(world.count('spawn')).toBe(1);
  },
);

it.each([
  ['failed_precondition', 'ok', ''],
  ['unavailable', 'ok', ''],
  ['failed_precondition', timeout, 'Core startup timed out.'],
  ['unavailable', 'cancelled', 'Core startup was cancelled.'],
] as const)(
  'reports a %s release after an exit during attach (%s), never leaking the client',
  async (claim, kind, message) => {
    const world = new ScriptedDaemon();
    const abort = new AbortController();
    if (claim === 'unavailable') world.gates.set('release', rejection);
    else world.releaseResult = 'ambiguous';
    world.gates.set('attach', () => {
      if (kind !== 'ok') preemptNext(kind, abort);
      return Promise.resolve(world.exit(900));
    });
    const onClaimReleaseError = jest.fn<never, [CanopyClientError]>(() => {
      throw new Error('reporter failure');
    });
    const options = { signal: abort.signal, onClaimReleaseError };
    const outcome = await run(launch(world, options));
    expect(outcome).toMatchObject(
      kind === 'ok' ? { value: 'client-1' } : { error: { kind, message } },
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(world.count('release')).toBe(1);
    expect(world.count('dispose')).toBe(kind === 'ok' ? 0 : 1);
    const reported = onClaimReleaseError.mock.calls.map(([e]) => e.payload);
    expect(reported).toMatchObject([{ kind: claim }]);
    expect(JSON.stringify(reported)).not.toMatch(/private|secret/);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it.each([
  [false, { value: 'client-1', started: false }],
  [true, { error: { kind: 'unavailable' } }],
] as const)(
  'releases after a fresh probe of a child exiting mid-classification (published %s)',
  async (published, want) => {
    const world = new ScriptedDaemon();
    world.child = (): void => world.publish(7);
    world.gates.set('inspect', () => {
      if (world.count('inspect') > 1) return Promise.resolve();
      if (published) world.publish(900);
      world.exit(900);
      return Promise.resolve();
    });
    expect(await run(launch(world))).toMatchObject(want);
    expect(world.released).toEqual([world.handle]);
  },
);

// Probe 600 ms: the deadline lands in the next sleep; 100 ms: in the classification.
it.each([
  ['absent', 600, null, 'unavailable'],
  ['stale', 600, descriptorFor(5), 'unavailable'],
  ['absent', 100, null, 'deadline_exceeded'],
  ['same-PID', 100, descriptorFor(900), 'deadline_exceeded'],
  ['malformed', 100, { pid: 900 }, 'deadline_exceeded'],
] as const)(
  'releases a confirmed exit regardless of publication (%s, probe %s ms)',
  async (_, probeIntervalMs, raw, kind) => {
    const world = new ScriptedDaemon();
    world.child = (): void => {};
    world.gates.set('read', () => {
      if (world.count('read') !== 3) return Promise.resolve();
      world.raw = raw;
      world.exit(900);
      if (kind === 'deadline_exceeded') jumpClock();
      return Promise.resolve();
    });
    const outcome = await run(launch(world, { probeIntervalMs }));
    expect(outcome).toMatchObject({ error: { kind } });
    expect(world.released).toEqual([world.handle]);
  },
);

it('rolls back its uncommitted child when another PID publishes', async () => {
  const world = new ScriptedDaemon();
  world.child = (): void => void setTimeout(() => world.publish(7), 10);
  expect(await run(launch(world))).toMatchObject({ started: false });
  expect(world.events).toContain('terminate:900');
  expect(world.count('release')).toBe(1);
});

it('fails closed on an ambiguous claim', async () => {
  const world = new ScriptedDaemon();
  world.acquisitions = ['ambiguous'];
  const outcome = await run(launch(world));
  expect(outcome).toMatchObject({ error: { kind: 'failed_precondition' } });
  expect(world.count('spawn') + world.count('release')).toBe(0);
});

it('re-probes a live daemon that refuses until it accepts, never spawning', async () => {
  const world = new ScriptedDaemon();
  world.publish(7);
  world.refusals = 2;
  expect(await run(launch(world))).toMatchObject({ value: 'client-3' });
  world.refusals = Infinity;
  const outcome = await run(launch(world));
  expect(outcome).toMatchObject({ error: { kind: 'deadline_exceeded' } });
  expect(world.count('attach')).toBe(13);
  expect(world.count('acquire') + world.count('spawn')).toBe(0);
});

it.each([50, 150])(
  'releases after confirmed exit despite publication (exit at %s ms)',
  async (exitAt) => {
    const world = new ScriptedDaemon();
    world.refusals = Infinity;
    world.child = (pid): void => {
      setTimeout(() => world.publish(pid), 50);
      setTimeout(() => world.exit(pid), exitAt);
    };
    const outcome = await run(launch(world));
    expect(outcome).toMatchObject({ error: { kind: 'unavailable' } });
    expect(world.released).toEqual([world.handle]);
  },
);

it.each<[ScriptedPort, (world: ScriptedDaemon) => void]>([
  ['read', (): void => {}],
  ['inspect', (w): void => w.publish(7)],
  ['readToken', (w): void => w.publish(7)],
  ['attach', (w): void => w.publish(7)],
  ['acquire', (): void => {}],
  ['spawn', (): void => {}],
  ['release', (w): void => void (w.child = (pid): void => w.exit(pid))],
])('bounds a never-settling %s port by the deadline', async (port, arrange) => {
  const world = new ScriptedDaemon();
  arrange(world);
  world.hang(port);
  const outcome = await run(launch(world));
  expect(outcome).toMatchObject({ error: { kind: 'deadline_exceeded' } });
  expect(jest.getTimerCount()).toBe(0);
});

it.each(['fail', 'open'] as const)(
  'cleans up a spawn that settles after the deadline (%s)',
  async (how) => {
    const world = new ScriptedDaemon();
    world.child = (): void => {};
    const spawn = world.defer('spawn');
    const outcome = await run(launch(world));
    expect(outcome).toMatchObject({ error: { kind: 'deadline_exceeded' } });
    spawn[how]();
    await jest.advanceTimersByTimeAsync(0);
    const tail = how === 'open' ? ['terminate:900', 'release'] : ['release'];
    expect(world.events.slice(-tail.length - 1)).toEqual(['spawn', ...tail]);
    expect(world.released).toEqual([world.handle]);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it("keeps a late child's claim when its exit is unconfirmed within the cleanup window", async () => {
  const world = new ScriptedDaemon();
  world.child = (): void => {};
  world.terminateExits = false;
  const spawn = world.defer('spawn');
  await run(launch(world, { cleanupTimeoutMs: 2_000 }));
  spawn.open();
  await jest.advanceTimersByTimeAsync(1_999);
  expect(jest.getTimerCount()).toBe(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(world.count('terminate')).toBe(1);
  expect(world.count('release')).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

it('disposes a client that attaches after the deadline', async () => {
  const world = new ScriptedDaemon();
  world.publish(7);
  const attach = world.defer('attach');
  const outcome = await run(launch(world));
  expect(outcome).toMatchObject({ error: { kind: 'deadline_exceeded' } });
  attach.open();
  await jest.advanceTimersByTimeAsync(0);
  expect(world.events.at(-1)).toBe('dispose:client-1');
});

it('issues no port call once the monotonic deadline has passed', async () => {
  const base = performance.now();
  jest
    .spyOn(performance, 'now')
    .mockReturnValueOnce(base)
    .mockReturnValue(base + 6e4);
  const world = new ScriptedDaemon();
  const outcome = await run(launch(world));
  expect(outcome).toMatchObject({ error: { kind: 'deadline_exceeded' } });
  expect(world.events).toEqual([]);
});

it.each<[ScriptedPort, (world: ScriptedDaemon) => void, string[]]>([
  ['read', (): void => {}, ['read']],
  ['acquire', (): void => {}, ['read', 'acquire', 'release']],
  [
    'spawn',
    (): void => {},
    ['read', 'acquire', 'read', 'spawn', 'terminate:900', 'release'],
  ],
  [
    'attach',
    (w): void => w.publish(7),
    [
      'read',
      'inspect:7',
      'token:secret-token-ref',
      'attach:1000',
      'dispose:client-1',
    ],
  ],
])(
  'fails a %s settling past the monotonic deadline and cleans up its result',
  async (port, arrange, events) => {
    const world = new ScriptedDaemon();
    arrange(world);
    world.gates.set(port, () => Promise.resolve(jumpClock()));
    const outcome = await run(launch(world));
    expect(outcome).toMatchObject({ error: { kind: 'deadline_exceeded' } });
    expect(world.events).toEqual(events);
    const released =
      port === 'acquire' || port === 'spawn' ? [world.handle] : [];
    expect(world.released).toEqual(released);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it.each<ScriptedPort>(['readToken', 'acquire', 'spawn'])(
  'redacts a failing %s port',
  async (port) => {
    const world = new ScriptedDaemon();
    if (port === 'readToken') world.publish(7);
    world.gates.set(port, () => Promise.reject(new Error('/private secret')));
    const outcome = await run(launch(world));
    expect(outcome).toMatchObject({ error: { kind: 'unavailable' } });
    await jest.advanceTimersByTimeAsync(0);
    const released = port === 'spawn' ? [world.handle] : [];
    expect(world.released).toEqual(released);
  },
);

it.each<[string, Overrides]>([
  ['empty data root', { dataRoot: '' }],
  ['blank runtime mode', { runtimeMode: ' ' }],
  ['empty executable', { daemon: { executable: '' } }],
  ['uppercase hash', { dataRootHash: 'A'.repeat(64) }],
  ['short hash', { dataRootHash: 'a'.repeat(63) }],
  ['reserved switch', { daemon: { executable: 'c', args: ['--data-root'] } }],
  [
    'W5 host switch',
    { daemon: { executable: 'c', args: ['--w5-host', 'v1'] } },
  ],
  [
    'inline W5 host switch',
    { daemon: { executable: 'c', args: ['--w5-host=v1'] } },
  ],
  [
    'inline switch',
    { daemon: { executable: 'c', args: ['--runtime-mode=x'] } },
  ],
  ['no protocol versions', { protocolVersions: [] }],
  ['zero protocol version', { protocolVersions: [0] }],
  ['fractional timeout', { timeoutMs: 1.5 }],
  ['zero probe interval', { probeIntervalMs: 0 }],
  ['oversized cleanup window', { cleanupTimeoutMs: 2 ** 31 }],
])('rejects %s before any port call', async (_, overrides) => {
  const world = new ScriptedDaemon();
  const signal = AbortSignal.abort();
  const outcome = await run(launch(world, { ...overrides, signal }));
  expect(outcome).toMatchObject({ error: { kind: 'invalid_argument' } });
  expect(world.events).toEqual([]);
});

it('rolls back an assigned child after its root exits before publication', async () => {
  const world = new ScriptedDaemon();
  world.child = (pid): void => world.exit(pid);
  expect(await run(launch(world))).toMatchObject({
    error: { kind: 'unavailable' },
  });
  expect(world.events).toContain('terminate:900');
  expect(world.events.indexOf('terminate:900')).toBeLessThan(
    world.events.indexOf('release'),
  );
});

it('awaits assigned-child rollback when startup times out', async () => {
  const world = new ScriptedDaemon();
  world.child = (): void => {};
  const stop = world.defer('terminate');
  let returned = false;
  const result = launch(world).catch(() => {
    returned = true;
  });
  await jest.advanceTimersByTimeAsync(1_000);
  expect(world.events).toContain('terminate:900');
  expect(returned).toBe(false);
  stop.open();
  await jest.advanceTimersByTimeAsync(0);
  await result;
  expect(returned).toBe(true);
});

it('commits only the authenticated child and preserves it after success', async () => {
  const world = new ScriptedDaemon();
  const commit = jest.fn<void, [CanopySpawnedDaemon, AbortSignal]>();
  const ports = {
    ...world,
    descriptor: world.descriptor,
    claim: world.claim,
    supervisor: { ...world.supervisor, commitDaemon: commit },
  };
  expect(await run(launch(world, { ports }))).toMatchObject({ started: true });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0]?.[0].pid).toBe(900);
  expect(world.count('terminate')).toBe(0);
});

it('disposes the client and rolls back when ownership commitment fails', async () => {
  const world = new ScriptedDaemon();
  const ports = {
    descriptor: world.descriptor,
    claim: world.claim,
    supervisor: {
      ...world.supervisor,
      commitDaemon: (): never => {
        throw new Error('/private secret');
      },
    },
  };
  expect(await run(launch(world, { ports }))).toMatchObject({
    error: { kind: 'failed_precondition' },
  });
  expect(world.events).toContain('dispose:client-1');
  expect(world.events).toContain('terminate:900');
});

it('reports cleanup failure and keeps the claim when root exit does not confirm group cleanup', async () => {
  const world = new ScriptedDaemon();
  world.child = (pid): void => world.exit(pid);
  world.gates.set('terminate', rejection);
  expect(await run(launch(world))).toMatchObject({
    error: { kind: 'unavailable', message: 'Core cleanup failed.' },
  });
  expect(world.count('release')).toBe(0);
});

it('retains the claim when a rejected spawn cannot confirm partial-child cleanup', async () => {
  const world = new ScriptedDaemon();
  const ports = {
    descriptor: world.descriptor,
    claim: world.claim,
    supervisor: {
      ...world.supervisor,
      spawnDaemon: (): Promise<never> =>
        Promise.reject(
          Object.assign(
            new CanopyClientError({
              kind: 'unavailable',
              message: 'Core cleanup failed.',
              retry: { kind: 'never' },
            }),
            { cleanupUnconfirmed: true },
          ),
        ),
    },
  };
  expect(await run(launch(world, { ports }))).toMatchObject({
    error: { kind: 'unavailable' },
  });
  expect(world.count('release')).toBe(0);
});

it('passes a live cleanup cancellation signal to release only after group cleanup', async () => {
  const world = new ScriptedDaemon();
  world.child = (): void => {};
  const release = jest.spyOn(world.claim, 'release');
  await run(launch(world));
  expect(world.events.indexOf('terminate:900')).toBeLessThan(
    world.events.indexOf('release'),
  );
  expect(release).toHaveBeenCalledWith(world.handle, expect.any(AbortSignal));
});

it('reports not_launcher on an already-running daemon and never recycles it', async () => {
  const world = new ScriptedDaemon();
  world.publish(7);
  expect(
    await run(
      launch(world, {
        daemon: { executable: '/private/bin/canopy', migrationChannel: true },
      }),
    ),
  ).toMatchObject({ started: false, migration: 'not_launcher' });
  expect(world.events).not.toContain('spawn');
  expect(world.events.join(' ')).not.toMatch(/terminate|commit|acquire/);
});

describe('the W5 handoff contract (GB12)', () => {
  const W5_ARGS = ['--w5-host', 'v1'];
  /** A pre-spawn step that logs, snapshots the claim, then runs `body`. */
  const step = (
    world: ScriptedDaemon,
    body: (signal: AbortSignal) => Promise<void> = (): Promise<void> =>
      Promise.resolve(),
    timeoutMs = 2_000,
  ): {
    readonly hook: CanopyDaemonLaunchOptions<string>['beforeSpawn'];
    readonly signals: AbortSignal[];
    readonly held: boolean[];
  } => {
    const signals: AbortSignal[] = [];
    const held: boolean[] = [];
    return {
      signals,
      held,
      hook: {
        timeoutMs,
        run: (signal): Promise<void> => {
          world.events.push('beforeSpawn');
          signals.push(signal);
          held.push(
            world.acquired.length > 0 && !world.freed.has(world.handle),
          );
          return body(signal);
        },
      },
    };
  };

  it('appends --w5-host v1 only when the trusted host asks', async () => {
    const world = new ScriptedDaemon();
    const daemon = {
      executable: '/private/bin/canopy',
      args: ['daemon'],
      w5Host: true,
    };
    expect(await run(launch(world, { daemon }))).toMatchObject({
      started: true,
    });
    expect(world.spawns[0]?.args).toEqual([
      'daemon',
      '--data-root',
      '/private/data',
      '--runtime-mode',
      'production',
      ...W5_ARGS,
    ]);
    const plain = new ScriptedDaemon();
    await run(launch(plain));
    expect(plain.spawns[0]?.args).not.toContain('--w5-host');
  });

  it('runs beforeSpawn once, holding the claim, after the re-probe and before spawnDaemon', async () => {
    const world = new ScriptedDaemon();
    const { hook, held, signals } = step(world);
    expect(await run(launch(world, { beforeSpawn: hook }))).toMatchObject({
      started: true,
    });
    expect(world.events.slice(0, 5)).toEqual([
      ...CLAIMED,
      'beforeSpawn',
      'spawn',
    ]);
    expect(held).toEqual([true]);
    expect(signals[0]?.aborted).toBe(false);
    // The child adopts the claim the step ran under.
    expect(world.spawns[0]?.claimHandle).toBe(world.handle);
    expect(world.count('release')).toBe(0);
  });

  it.each<[string, (world: ScriptedDaemon) => void]>([
    ['a live daemon', (w): void => w.publish(7)],
    [
      'a winner published while the claim was held',
      (w): void => {
        w.acquisitions = ['held', 'held', 'acquired'];
        setTimeout(() => w.publish(7), 150);
      },
    ],
    [
      'a daemon published before the claimed re-probe',
      (w): void =>
        void w.gates.set('acquire', () => Promise.resolve(w.publish(7))),
    ],
  ])('never runs beforeSpawn when attaching to %s', async (_, arrange) => {
    const world = new ScriptedDaemon();
    arrange(world);
    const { hook } = step(world);
    expect(await run(launch(world, { beforeSpawn: hook }))).toMatchObject({
      started: false,
    });
    expect(world.count('beforeSpawn') + world.count('spawn')).toBe(0);
  });

  it.each<[string, () => Promise<void>, object]>([
    [
      'an untyped failure',
      (): Promise<void> => Promise.reject(new Error('/private secret')),
      { kind: 'internal', message: 'Core pre-spawn step failed.' },
    ],
    [
      'a typed refusal',
      (): Promise<void> =>
        Promise.reject(
          canopyDaemonRefusalError('writer_held', 'The W5 log is held.'),
        ),
      { kind: 'failed_precondition', details: { refusal: 'writer_held' } },
    ],
  ])(
    'releases the claim and spawns nothing after %s',
    async (_, body, error) => {
      const world = new ScriptedDaemon();
      const { hook } = step(world, body);
      const outcome = await run(launch(world, { beforeSpawn: hook }));
      expect(outcome).toMatchObject({ error });
      expect(world.count('spawn')).toBe(0);
      expect(world.released).toEqual([world.handle]);
      expect(world.freed.has(world.handle)).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('pauses the launch deadline for its own budget, then resumes what was left', async () => {
    const world = new ScriptedDaemon();
    // Longer than the whole 1000 ms launch deadline; within its 2000 ms budget.
    const { hook } = step(
      world,
      () => new Promise((done) => setTimeout(done, 1_500)),
    );
    const settled = launch(world, { beforeSpawn: hook });
    await jest.advanceTimersByTimeAsync(3_000);
    expect(await settled).toMatchObject({ started: true });
    // 1000 ms less one 100 ms probe sleep: the step's 1500 ms never counted.
    expect(world.events).toContain('attach:900');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fails at its own bound and keeps the claim until the late step settles', async () => {
    const world = new ScriptedDaemon();
    let finish = (): void => {};
    const { hook, signals } = step(
      world,
      () => new Promise<void>((done) => (finish = done)),
      300,
    );
    let outcome: Outcome | undefined;
    void launch(world, { beforeSpawn: hook }).then(
      (value) => (outcome = value),
      (error: unknown) =>
        (outcome = { error: toCanopyClientError(error).payload }),
    );
    await jest.advanceTimersByTimeAsync(300);
    expect(outcome).toMatchObject({
      error: {
        kind: 'deadline_exceeded',
        message: 'Core pre-spawn step timed out.',
      },
    });
    expect(signals[0]?.aborted).toBe(true);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(world.count('release')).toBe(0);
    finish();
    await jest.advanceTimersByTimeAsync(0);
    expect(world.released).toEqual([world.handle]);
    expect(world.count('spawn')).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops beforeSpawn when the caller cancels', async () => {
    const world = new ScriptedDaemon();
    const abort = new AbortController();
    const { hook, signals } = step(
      world,
      (signal) =>
        new Promise((_done, fail) =>
          signal.addEventListener('abort', () => fail(new Error('aborted'))),
        ),
    );
    setTimeout(() => abort.abort(), 100);
    const outcome = await run(
      launch(world, { beforeSpawn: hook, signal: abort.signal }),
    );
    expect(outcome).toMatchObject({ error: { kind: 'cancelled' } });
    expect(signals[0]?.aborted).toBe(true);
    expect(world.count('spawn')).toBe(0);
    expect(world.released).toEqual([world.handle]);
  });

  it.each<[string, Overrides, string]>([
    [
      'on Windows, which has no claim to hold',
      { platform: 'win32' },
      'capability_unavailable',
    ],
    [
      'with a fractional budget',
      {
        beforeSpawn: {
          timeoutMs: 1.5,
          run: (): Promise<void> => Promise.resolve(),
        },
      },
      'invalid_argument',
    ],
  ])(
    'refuses beforeSpawn %s before any port call',
    async (_, overrides, kind) => {
      const world = new ScriptedDaemon();
      const { hook } = step(world);
      const outcome = await run(
        launch(world, { beforeSpawn: hook, ...overrides }),
      );
      expect(outcome).toMatchObject({ error: { kind } });
      expect(world.events).toEqual([]);
    },
  );

  it('tags an exit before readiness as a typed refusal, keeping its kind', async () => {
    const world = new ScriptedDaemon();
    world.child = (pid): void => world.exit(pid);
    const settled = launch(world).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(1_000);
    const error = await settled;
    expect(canopyDaemonRefusal(error)).toBe('exited_before_ready');
    expect(toCanopyClientError(error).payload).toMatchObject({
      kind: 'unavailable',
      message: 'Core exited before it was ready.',
      retry: { kind: 'same_request' },
    });
  });
});

describe.each(['darwin', 'win32'] as const)(
  '%s owned child exit contract',
  (platform) => {
    it.each([
      [69, null, 'endpoint_repair_required'],
      [1, null, 'exited_before_ready'],
      [null, 'SIGKILL', 'exited_before_ready'],
      [null, null, 'exited_before_ready'],
      [69, 'SIGTERM', 'exited_before_ready'],
    ] as const)(
      'maps immediate exit %s / %s to %s',
      async (code, signal, refusal) => {
        const world = new ScriptedDaemon();
        world.child = (pid): void => world.exit(pid, code, signal);
        expect(await run(launch(world, { platform }))).toMatchObject({
          error: { kind: 'unavailable', details: { refusal } },
        });
      },
    );
    it('keeps failed owned-child cleanup primary over repair guidance', async () => {
      const world = new ScriptedDaemon();
      world.child = (pid): void => world.exit(pid, 69);
      world.gates.set('terminate', () =>
        Promise.resolve().then(() => {
          throw new Error('private path');
        }),
      );
      const result = await run(launch(world, { platform }));
      expect(result).toMatchObject({
        error: { message: 'Core cleanup failed.' },
      });
      if ('error' in result)
        expect(result.error.details).not.toEqual({
          refusal: 'endpoint_repair_required',
        });
    });
  },
);
it('refuses a live same-protocol daemon with an older secure layout before token reads or leases', async () => {
  const world = new ScriptedDaemon();
  world.publish(7);
  const result = await run(launch(world, { secureStorageLayout: 'nested-v1' }));
  expect(result).toMatchObject({ error: { kind: 'failed_precondition' } });
  expect(world.events).toEqual(['read', 'inspect:7']);
});

it('attaches when secure layout and protocol both match', async () => {
  const world = new ScriptedDaemon();
  world.publish(7);
  world.raw = { ...descriptorFor(7), secureStorageLayout: 'nested-v1' };
  expect(
    await run(launch(world, { secureStorageLayout: 'nested-v1' })),
  ).toMatchObject({ value: 'client-1', started: false });
});
