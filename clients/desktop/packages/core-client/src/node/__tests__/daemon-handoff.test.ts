import {
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';

import { CanopyClientError, toCanopyClientError } from '../../errors';
import {
  CANOPY_DAEMON_W5_HOST_CHECK,
  classifyCanopyDaemonCapability,
  waitForCanopyDaemonRelease,
  type CanopyDaemonCapability,
  type CanopyDaemonCapabilityInput,
  type CanopyDaemonReleaseWaitOptions,
} from '../daemon-handoff';
import { canopyDaemonRefusal } from '../daemon-refusal';
import type { CanopyDescriptorState } from '../descriptor';
import { descriptorFor, ScriptedDaemon } from './fixtures/scripted-daemon';

const CAPTURE = 'core.workspaceRecords.capture';
const COMMIT = 'core.workspaceRecords.commit';
const REQUIRED = { [CAPTURE]: { version: 1 }, [COMMIT]: { version: 1 } };

const manifest = (
  ...names: string[]
): CanopyDaemonCapabilityInput['manifest'] => ({
  has: (kind, name): boolean => kind === 'operations' && names.includes(name),
});
const op = (
  name: string,
  version = 1,
  available = true,
): { name: string; version: number; available: boolean } => ({
  name,
  version,
  available,
});
const w5Check = (
  status: 'pass' | 'warn' | 'fail',
  reason?: string,
): NonNullable<CanopyDaemonCapabilityInput['checks']>[number] => ({
  name: CANOPY_DAEMON_W5_HOST_CHECK,
  status,
  message: null,
  ...(reason !== undefined && { reason }),
});
const ACCEPT: CanopyDaemonCapability = { kind: 'accept' };
const WAIT: CanopyDaemonCapability = { kind: 'wait' };
const SKEW: CanopyDaemonCapability = {
  kind: 'refuse',
  refusal: 'version_skew',
};
const WRITER_HELD: CanopyDaemonCapability = {
  kind: 'refuse',
  refusal: 'writer_held',
};

describe('classifyCanopyDaemonCapability', () => {
  const all = manifest(CAPTURE, COMMIT);
  type Case = Omit<CanopyDaemonCapabilityInput, 'required' | 'operations'> &
    Partial<Pick<CanopyDaemonCapabilityInput, 'operations'>>;
  it.each<[string, Case, CanopyDaemonCapability]>([
    [
      'all advertised, but manifest.get lists none of them',
      { manifest: all, operations: [] },
      SKEW,
    ],
    [
      'all advertised at the required versions',
      { manifest: all, operations: [op(CAPTURE), op(COMMIT)] },
      ACCEPT,
    ],
    [
      'all advertised while degraded by an unrelated check',
      {
        manifest: all,
        checks: [
          { name: 'core.daemon.git', status: 'warn', message: 'slow' },
          w5Check('pass'),
        ],
      },
      ACCEPT,
    ],
    [
      'none advertised, the W5 writer held (warn)',
      { manifest: manifest(), checks: [w5Check('warn', 'writer_unavailable')] },
      WRITER_HELD,
    ],
    [
      'none advertised, the W5 writer held (fail)',
      { manifest: manifest(), checks: [w5Check('fail', 'writer_unavailable')] },
      WRITER_HELD,
    ],
    ['none advertised, health not read', { manifest: manifest() }, WAIT],
    [
      'none advertised, no W5 check (an old daemon)',
      {
        manifest: manifest(),
        checks: [{ name: 'core.runtime', status: 'pass', message: null }],
      },
      WAIT,
    ],
    [
      'none advertised, an unknown W5 reason',
      { manifest: manifest(), checks: [w5Check('warn', 'maintenance_held')] },
      WAIT,
    ],
    [
      'none advertised, a W5 check without a reason',
      { manifest: manifest(), checks: [w5Check('warn')] },
      WAIT,
    ],
    [
      'none advertised, a passing W5 check names a stale reason',
      { manifest: manifest(), checks: [w5Check('pass', 'writer_unavailable')] },
      WAIT,
    ],
    [
      'the names advertised only as events',
      {
        manifest: {
          has: (kind, name): boolean =>
            kind === 'events' && [CAPTURE, COMMIT].includes(name),
        },
      },
      WAIT,
    ],
    ['only some advertised', { manifest: manifest(CAPTURE) }, SKEW],
    [
      'an operation at another version (RC and prod skew)',
      { manifest: all, operations: [op(CAPTURE), op(COMMIT, 2)] },
      SKEW,
    ],
    [
      'an operation listed unavailable',
      { manifest: all, operations: [op(CAPTURE), op(COMMIT, 1, false)] },
      SKEW,
    ],
    [
      'an operation missing from manifest.get',
      { manifest: all, operations: [op(CAPTURE)] },
      SKEW,
    ],
  ])('%s', (_, input, want) => {
    expect(
      classifyCanopyDaemonCapability({
        required: REQUIRED,
        operations: [op(CAPTURE), op(COMMIT)],
        ...input,
      }),
    ).toEqual(want);
  });

  it('takes protocol definition maps as the required set', () => {
    const required = {
      ...CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
      ...CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
    };
    const names = Object.keys(required);
    const operations = Object.entries(required).map(([name, d]) =>
      op(name, d.version),
    );
    expect(
      classifyCanopyDaemonCapability({
        required,
        manifest: manifest(...names),
        operations,
      }),
    ).toEqual(ACCEPT);
    expect(
      classifyCanopyDaemonCapability({
        required,
        manifest: manifest(...names.slice(1)),
        operations,
      }),
    ).toEqual(SKEW);
  });

  it('never accepts without the manifest.get versions', () => {
    // @ts-expect-error: calls carry no version, so skew is caught only here.
    const unversioned: CanopyDaemonCapabilityInput = {
      required: REQUIRED,
      manifest: all,
    };
    expect(() => classifyCanopyDaemonCapability(unversioned)).toThrow();
  });

  it('rejects an empty required set', () => {
    let thrown: unknown;
    try {
      classifyCanopyDaemonCapability({
        required: {},
        manifest: manifest(),
        operations: [],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CanopyClientError);
    expect(toCanopyClientError(thrown).payload.kind).toBe('invalid_argument');
  });
});

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

type Settled<V> = V | { error: ReturnType<typeof toCanopyClientError> };
async function settle<V>(pending: Promise<V>, ms: number): Promise<Settled<V>> {
  const settled = pending.catch((error: unknown) => ({
    error: toCanopyClientError(error),
  }));
  await jest.advanceTimersByTimeAsync(ms);
  return settled;
}

const waitOut = (
  world: ScriptedDaemon,
  overrides: Partial<CanopyDaemonReleaseWaitOptions> = {},
): Promise<CanopyDescriptorState> =>
  waitForCanopyDaemonRelease({
    ports: world,
    descriptor: descriptorFor(7),
    ...overrides,
  });

describe('waitForCanopyDaemonRelease', () => {
  it.each<[string, (w: ScriptedDaemon) => void, CanopyDescriptorState]>([
    [
      'its process exits',
      (w): void => w.exit(7),
      { kind: 'stale', reason: 'process_exited' },
    ],
    [
      'it withdraws its descriptor',
      (w): void => void (w.raw = null),
      { kind: 'absent' },
    ],
    [
      'another daemon replaces it',
      (w): void => w.publish(8),
      { kind: 'live', descriptor: descriptorFor(8) },
    ],
    [
      'another daemon reuses its PID',
      (w): void => {
        w.live.set(7, 'replacement-start');
        w.raw = { ...descriptorFor(7), startIdentity: 'replacement-start' };
      },
      {
        kind: 'live',
        descriptor: { ...descriptorFor(7), startIdentity: 'replacement-start' },
      },
    ],
  ])(
    'waits, reading only the descriptor, until %s',
    async (_, release, want) => {
      const world = new ScriptedDaemon();
      world.publish(7);
      setTimeout(() => release(world), 30_000);
      let finished = false;
      const pending = waitOut(world).then((state) => {
        finished = true;
        return state;
      });
      await jest.advanceTimersByTimeAsync(29_999);
      expect(finished).toBe(false);
      await jest.advanceTimersByTimeAsync(251);
      expect(finished).toBe(true);
      expect(await pending).toEqual(want);
      expect(world.count('read')).toBeGreaterThan(100);
      expect(
        world.events.filter((e) => !/^(read|inspect:\d+)$/.test(e)),
      ).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('waits out the same daemon even while it is incompatible', async () => {
    const world = new ScriptedDaemon();
    world.publish(7, 3);
    setTimeout(() => world.exit(7), 1_000);
    expect(
      await settle(waitOut(world, { descriptor: descriptorFor(7, 3) }), 1_250),
    ).toMatchObject({ kind: 'stale' });
  });

  it('refuses peer_held at its default 45 s bound', async () => {
    const world = new ScriptedDaemon();
    world.publish(7);
    const pending = waitOut(world);
    const early = await settle(
      Promise.race([pending, new Promise((d) => setTimeout(d, 44_999))]),
      44_999,
    );
    expect(early).toBeUndefined();
    const outcome = await settle(pending, 1);
    const error = 'error' in outcome ? outcome.error : undefined;
    expect(error).toBeInstanceOf(CanopyClientError);
    expect(canopyDaemonRefusal(error)).toBe('peer_held');
    expect(error?.payload.kind).toBe('failed_precondition');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps cancellation and malformed descriptors as their own failures', async () => {
    const world = new ScriptedDaemon();
    world.publish(7);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 500);
    const cancelled = await settle(
      waitOut(world, { signal: abort.signal }),
      500,
    );
    expect(cancelled).toMatchObject({
      error: { payload: { kind: 'cancelled' } },
    });
    world.raw = { pid: 7 };
    const malformed = await settle(waitOut(world), 0);
    expect(malformed).toMatchObject({
      error: { payload: { kind: 'failed_precondition' } },
    });
    const error = 'error' in malformed ? malformed.error : undefined;
    expect(canopyDaemonRefusal(error)).toBeNull();
    // A failing read keeps its step and errno, never its text (CAN-7137).
    world.gates.set('read', () =>
      Promise.reject(
        Object.assign(new Error('/private secret'), { code: 'EBUSY' }),
      ),
    );
    const failed = await settle(waitOut(world), 0);
    expect(failed).toMatchObject({
      error: {
        payload: {
          kind: 'unavailable',
          message: 'Core discovery failed.',
          details: { errno: 'EBUSY', operation: 'read_descriptor' },
        },
      },
    });
    expect(JSON.stringify(failed)).not.toContain('/private');
  });
});
