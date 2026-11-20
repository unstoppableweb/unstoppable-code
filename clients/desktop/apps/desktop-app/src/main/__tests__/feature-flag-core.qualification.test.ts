// CAN-4181 migration golden: core.featureFlag.* on the desktop dispatcher.
// The real FeatureFlagService stays the one evaluator; core serves only the
// flags the registry assigns to core or to both, from that evaluator, and no
// client-supplied value reaches it. Only the LaunchDarkly SDK, the targeting
// context and IPC registration are replaced. The suite runs on its own data
// and secure directories, never inherited ones.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanopyOperationError,
  createCanopyDispatcher,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import {
  createCoreFeatureFlagHandlers,
  type CoreFeatureFlagHost,
} from '@canopy/core-runtime/feature-flag';
import {
  CORE_FEATURE_FLAG_QUERY_DEFINITIONS,
  CORE_FEATURE_FLAG_STREAM_DEFINITIONS,
  FEATURE_FLAG_GRANTS,
  type CanopyCallerDescriptor,
  type CanopyStreamCursor,
  type FeatureFlagEvent,
} from '@canopy/protocol/canopy-core';
import {
  CLIENT_FEATURE_FLAGS,
  CORE_FEATURE_FLAG_KEYS,
  getDefaultFeatureFlagSnapshot,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { createCoreFeatureFlagAdapter } from '../canopy-runtime/core-feature-flag-adapter';
import { DESKTOP_QUERY_DEFINITIONS } from '../canopy-runtime/desktop-query-definitions';
import { DESKTOP_STREAM_DEFINITIONS } from '../canopy-runtime/desktop-stream-definitions';
import { RELAY_DEFINITIONS } from '../canopy-runtime/renderer-relay/definitions';
import {
  disposeFeatureFlagService,
  getFeatureFlagService,
  type FeatureFlagService,
} from '../feature-flags';
import { LAUNCHDARKLY_RETRY_TRIGGER_MIN_INTERVAL_MS } from '../feature-flags/service';
import {
  disposeLabsExperimentsService,
  getLabsExperimentsService,
} from '../services/labs-experiments-runtime';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

// The targeting context key; a test changes it to make another identity.
const mockTargeting = { key: 'anonymous-install' };
jest.mock('../feature-flags/context', () => ({
  ...jest.requireActual<object>('../feature-flags/context'),
  buildDesktopFeatureFlagContext: (): Promise<object> =>
    Promise.resolve({
      kind: 'user',
      key: mockTargeting.key,
      anonymous: true,
    }),
}));

// The signed-in Canopy account the Labs runtime's account wiring sees.
const mockAccounts = {
  current: null as object | null,
  listeners: new Set<(account: object | null) => void>(),
  publish(account: object | null): void {
    this.current = account;
    for (const listener of this.listeners) listener(account);
  },
};
jest.mock('../lib/canopy-cloud-account-store', () => ({
  ...jest.requireActual<object>('../lib/canopy-cloud-account-store'),
  peekCanopyCloudAccount: (): object | null => mockAccounts.current,
  subscribeCanopyCloudAccountChanges: (
    listener: (account: object | null) => void,
  ): (() => void) => {
    mockAccounts.listeners.add(listener);
    return (): void => {
      mockAccounts.listeners.delete(listener);
    };
  },
  subscribeCanopyCloudAccountConfirmations: (): (() => void) => () => {},
}));
// Labs choices never reach a server here.
jest.mock('../canopy-cloud/config', () => ({
  ...jest.requireActual<object>('../canopy-cloud/config'),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.golden.invalid',
}));
jest.mock('../canopy-cloud/client', () => ({
  ...jest.requireActual<object>('../canopy-cloud/client'),
  requestCanopyCloudJson: (): Promise<never> =>
    Promise.reject(new Error('No Canopy Cloud in the golden.')),
}));

const ld = {
  values: {} as Record<string, unknown>,
  changeListeners: new Set<() => void>(),
  initError: null as Error | null,
};
const fakeLaunchDarkly = {
  initialize: (): object => ({
    variation: (key: string, fallback: unknown): unknown =>
      key in ld.values ? ld.values[key] : fallback,
    on: (_event: string, listener: () => void): void => {
      ld.changeListeners.add(listener);
    },
    off: (_event: string, listener: () => void): void => {
      ld.changeListeners.delete(listener);
    },
    waitForInitialization: (): Promise<void> =>
      ld.initError ? Promise.reject(ld.initError) : Promise.resolve(),
    identify: (): Promise<void> => Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
  }),
};
jest.mock('@canopy/desktop-shared/node/lib/packaged-module-loader', () => ({
  ...jest.requireActual<object>(
    '@canopy/desktop-shared/node/lib/packaged-module-loader',
  ),
  loadRequiredNodeModule: (): object => fakeLaunchDarkly,
}));
jest.mock('../lib/web-contents-send', () => ({
  ...jest.requireActual<object>('../lib/web-contents-send'),
  sendToWebContents: (): boolean => true,
}));

const GUEST = CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key;
const SIGN_IN_REQUIRED = CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key;

const suiteRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ff-core-golden-')));
const ISOLATED_DIRS = {
  CANOPY_DATA_DIR: join(suiteRoot, 'data'),
  CANOPY_SECURE_DATA_DIR: join(suiteRoot, 'secure'),
};
const inherited = Object.fromEntries(
  Object.keys(ISOLATED_DIRS).map((name) => [name, process.env[name]]),
);

const renderer: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [FEATURE_FLAG_GRANTS.read],
};

type FlagDispatcher = CanopyDispatcher<
  typeof CORE_FEATURE_FLAG_QUERY_DEFINITIONS,
  Record<never, never>,
  typeof CORE_FEATURE_FLAG_STREAM_DEFINITIONS
>;

/** The production adapter over the desktop host, or handlers over a test host. */
function dispatcherOver(
  host?: CoreFeatureFlagHost,
  retain = 256,
): FlagDispatcher {
  const flagHandlers =
    host === undefined
      ? createCoreFeatureFlagAdapter()
      : createCoreFeatureFlagHandlers(host, { epoch: 'golden', retain });
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_FEATURE_FLAG_QUERY_DEFINITIONS,
      instructions: {},
      streams: CORE_FEATURE_FLAG_STREAM_DEFINITIONS,
    },
    handlers: {
      queries: flagHandlers.queries,
      instructions: {},
      streams: flagHandlers.streams,
    },
  });
}

/** The process-wide service the IPC handlers and main gates read. */
async function liveService(
  values: Record<string, unknown>,
): Promise<FeatureFlagService> {
  ld.values = values;
  process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'test-id';
  const service = getFeatureFlagService();
  await service.initialize();
  return service;
}

async function refusal(
  call: Promise<unknown>,
): Promise<CanopyOperationError['payload']> {
  try {
    await call;
  } catch (error) {
    if (error instanceof CanopyOperationError) return error.payload;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** Opens the events stream and collects its items with their cursors. */
async function collect(
  dispatcher: FlagDispatcher,
  params: { keys?: string[]; cursor?: CanopyStreamCursor | null },
  onItem?: (event: FeatureFlagEvent) => void,
  onEnd?: () => void,
): Promise<{
  items: Array<{ cursor: CanopyStreamCursor; event: FeatureFlagEvent }>;
  ended: () => unknown;
  close: () => void;
}> {
  const items: Array<{ cursor: CanopyStreamCursor; event: FeatureFlagEvent }> =
    [];
  let endError: unknown;
  const handle = await dispatcher.openStream(
    'core.featureFlag.events',
    params,
    {
      caller: renderer,
      onFrame: (frame) => {
        if (frame.kind === 'item') {
          items.push({ cursor: frame.cursor, event: frame.item });
          onItem?.(frame.item);
        } else {
          endError = frame.error;
          onEnd?.();
        }
      },
    },
  );
  return { items, ended: () => endError, close: () => handle.close() };
}

/** A refused open ends the stream with the error and no item. */
async function openRefusal(
  dispatcher: FlagDispatcher,
  cursor: CanopyStreamCursor,
): Promise<unknown> {
  const opened = await collect(dispatcher, { cursor });
  await settle();
  expect(opened.items).toEqual([]);
  return opened.ended();
}

const settle = (): Promise<void> => new Promise((done) => setImmediate(done));

beforeAll(() => {
  for (const [name, dir] of Object.entries(ISOLATED_DIRS)) {
    mkdirSync(dir, { recursive: true });
    process.env[name] = dir;
  }
});

afterAll(() => {
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
  rmSync(suiteRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await disposeLabsExperimentsService();
  await disposeFeatureFlagService();
  ld.changeListeners.clear();
  ld.initError = null;
  mockTargeting.key = 'anonymous-install';
  mockAccounts.current = null;
  mockAccounts.listeners.clear();
  jest.restoreAllMocks();
});

/**
 * Opens a stream before a targeting change and returns the check that the
 * change ended it and refuses its cursor.
 */
async function expectResetAfter(
  dispatcher: FlagDispatcher,
): Promise<() => Promise<void>> {
  const stream = await collect(dispatcher, { keys: [GUEST] });
  await settle();
  const cursor = stream.items[0]?.cursor;
  if (!cursor) throw new Error('no cursor before the change');
  return async (): Promise<void> => {
    expect(stream.ended()).toMatchObject({
      code: 'core.featureFlag.snapshotRequired',
    });
    expect(await openRefusal(dispatcher, cursor)).toMatchObject({
      code: 'core.featureFlag.snapshotRequired',
    });
  };
}

describe('core.featureFlag on the desktop dispatcher (CAN-4181)', () => {
  it('composes both operations for the desktop dispatcher and the renderer relay, with no write', () => {
    expect(DESKTOP_QUERY_DEFINITIONS).toHaveProperty([
      'core.featureFlag.snapshot.get',
    ]);
    expect(DESKTOP_STREAM_DEFINITIONS).toHaveProperty([
      'core.featureFlag.events',
    ]);
    expect(RELAY_DEFINITIONS.queries).toHaveProperty([
      'core.featureFlag.snapshot.get',
    ]);
    expect(RELAY_DEFINITIONS.streams).toHaveProperty([
      'core.featureFlag.events',
    ]);
    expect(
      Object.keys(RELAY_DEFINITIONS.instructions).filter((name) =>
        name.startsWith('core.featureFlag.'),
      ),
    ).toEqual([]);
  });

  it('serves exactly the core and shared flags, from the evaluator main gates read', async () => {
    const service = await liveService({
      [GUEST]: true,
      [SIGN_IN_REQUIRED]: true,
    });
    const dispatcher = dispatcherOver();

    const all = await dispatcher.query(
      'core.featureFlag.snapshot.get',
      {},
      { caller: renderer },
    );
    expect(Object.keys(all.flags).sort()).toEqual(
      [...CORE_FEATURE_FLAG_KEYS].sort(),
    );
    expect(all.provenance).toEqual({
      status: 'ready',
      initialized: true,
      error: null,
    });
    const values: Record<string, unknown> = service.getSnapshot().values;
    for (const [key, value] of Object.entries(all.flags))
      expect(value).toBe(values[key]);
    expect(service.isEnabled(GUEST)).toBe(true);
    expect(all.flags[GUEST]).toBe(true);

    // An interface-only key is left out like an unknown one.
    const narrowed = await dispatcher.query(
      'core.featureFlag.snapshot.get',
      { keys: [GUEST, SIGN_IN_REQUIRED, 'canopy-not-a-flag'] },
      { caller: renderer },
    );
    expect(narrowed.flags).toEqual({ [GUEST]: true });

    // The legacy channel still answers with the same evaluator's values.
    const { registerFeatureFlagHandlers } =
      await import('../ipc/feature-flags');
    registerFeatureFlagHandlers(() => null);
    const legacy = await handlers.get(IPC_CHANNELS.featureFlagsGetSnapshot)?.(
      {},
    );
    expect(legacy).toMatchObject({ values: all.flags });
  });

  it('never lets a client open a path core keeps closed', async () => {
    const service = await liveService({ [GUEST]: false });
    const dispatcher = dispatcherOver();

    for (const forged of [
      { flags: { [GUEST]: true } },
      { values: { [GUEST]: true } },
      { keys: [GUEST], provenance: { status: 'ready' } },
    ])
      expect(
        (
          await refusal(
            dispatcher.query('core.featureFlag.snapshot.get', forged as never, {
              caller: renderer,
            }),
          )
        ).kind,
      ).toBe('invalid_argument');
    expect(
      (
        await refusal(
          dispatcher.query(
            'core.featureFlag.snapshot.get',
            {},
            { caller: { ...renderer, grants: [] } },
          ),
        )
      ).kind,
    ).toBe('permission_denied');

    const after = await dispatcher.query(
      'core.featureFlag.snapshot.get',
      { keys: [GUEST] },
      { caller: renderer },
    );
    expect(after.flags).toEqual({ [GUEST]: false });
    expect(service.isEnabled(GUEST)).toBe(false);
  });

  it('streams each change in revision order and resumes from a cursor', async () => {
    await liveService({ [GUEST]: false });
    const dispatcher = dispatcherOver();

    const live = await collect(dispatcher, { keys: [GUEST, SIGN_IN_REQUIRED] });
    await settle();
    expect(
      live.items.map(({ event }) => [event.revision, event.changed]),
    ).toEqual([[0, { [GUEST]: false }]]);

    // A change outside core's flags never makes a revision.
    ld.values = { [GUEST]: false, [SIGN_IN_REQUIRED]: true };
    for (const listener of ld.changeListeners) listener();
    await settle();
    ld.values = { [GUEST]: true, [SIGN_IN_REQUIRED]: true };
    for (const listener of ld.changeListeners) listener();
    await settle();
    expect(
      live.items.map(({ event }) => [event.revision, event.changed]),
    ).toEqual([
      [0, { [GUEST]: false }],
      [1, { [GUEST]: true }],
    ]);
    live.close();

    const resumed = await collect(dispatcher, {
      cursor: live.items[0]?.cursor,
    });
    await settle();
    expect(
      resumed.items.map(({ event }) => [event.revision, event.changed]),
    ).toEqual([[1, { [GUEST]: true }]]);
    resumed.close();

    const foreign = await openRefusal(dispatcher, {
      daemonEpoch: 'another-epoch',
      sequence: 0,
    });
    expect(foreign).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.featureFlag.snapshotRequired',
      details: { reason: 'SNAPSHOT_REQUIRED' },
    });
  });

  it('asks for a snapshot past retention', async () => {
    let snapshot: FeatureFlagSnapshot =
      getDefaultFeatureFlagSnapshot('initializing');
    const listeners = new Set<() => void>();
    const dispatcher = dispatcherOver(
      {
        snapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return (): void => {
            listeners.delete(listener);
          };
        },
      },
      1,
    );
    const publish = (next: FeatureFlagSnapshot): void => {
      snapshot = next;
      for (const listener of listeners) listener();
    };
    publish({ ...snapshot, status: 'error', error: 'x'.repeat(5_000) });
    publish({
      ...snapshot,
      values: { ...snapshot.values, [GUEST]: !snapshot.values[GUEST] },
    });

    const now = await dispatcher.query(
      'core.featureFlag.snapshot.get',
      {},
      { caller: renderer },
    );
    expect(now.revision).toBe(2);
    expect(now.provenance.status).toBe('error');
    expect(
      await openRefusal(dispatcher, { daemonEpoch: 'golden', sequence: 0 }),
    ).toMatchObject({ code: 'core.featureFlag.snapshotRequired' });

    // A refresh that changes nothing makes no revision, but core reports
    // the fresh evaluation time in the snapshot and a newly opened stream.
    const refreshedAt = '2026-11-20T01:30:00.000Z';
    publish({ ...snapshot, updatedAt: refreshedAt });
    const refreshed = await dispatcher.query(
      'core.featureFlag.snapshot.get',
      {},
      { caller: renderer },
    );
    expect(refreshed).toMatchObject({ revision: 2, evaluatedAt: refreshedAt });
    const reopened = await collect(dispatcher, {});
    await settle();
    expect(reopened.items.map(({ event }) => event)).toMatchObject([
      { revision: 2, evaluatedAt: refreshedAt },
    ]);
    reopened.close();
  });

  it('never serves the raw evaluator error, which can name host paths', async () => {
    const service = await liveService({ [GUEST]: true });
    const dispatcher = dispatcherOver();
    const stream = await collect(dispatcher, {});
    await settle();

    const hostPath =
      '/Users/golden-user/Library/Application Support/Canopy/launchdarkly';
    ld.initError = new Error(
      `EACCES: permission denied, open '${hostPath}/identity.json'`,
    );
    await service.initialize();
    await settle();
    // The desktop host keeps the raw error for its own logs.
    expect(service.getSnapshot().error).toContain(hostPath);

    const now = await dispatcher.query(
      'core.featureFlag.snapshot.get',
      {},
      { caller: renderer },
    );
    expect(now.provenance.status).toBe('error');
    expect(typeof now.provenance.error).toBe('string');
    const served = JSON.stringify([
      now,
      stream.items.map(({ event }) => event),
    ]);
    for (const hostDetail of ['golden-user', '/Users/', 'identity.json'])
      expect(served).not.toContain(hostDetail);
    // The stream reports the failure with the same message and stays open.
    expect(stream.items.at(-1)?.event.provenance).toEqual(now.provenance);
    expect(stream.ended()).toBeUndefined();
    stream.close();
  });

  it('forgets the previous account when the targeting context changes', async () => {
    const service = await liveService({ [GUEST]: true });
    const dispatcher = dispatcherOver();
    // A client that reopens straight from the end frame, as the error asks.
    let reopened: ReturnType<typeof collect> | undefined;
    const before = await collect(
      dispatcher,
      { keys: [GUEST] },
      undefined,
      () => {
        reopened = collect(dispatcher, { keys: [GUEST] });
      },
    );
    await settle();
    const cursor = before.items[0]?.cursor;
    expect(before.items.map(({ event }) => event.changed)).toEqual([
      { [GUEST]: true },
    ]);

    // Signing in to another account resets the targeting context.
    service.invalidateContext();
    await settle();
    expect(before.ended()).toMatchObject({
      code: 'core.featureFlag.snapshotRequired',
    });
    // The reopened stream sees only the new account's values.
    const reopenedStream = await reopened;
    expect(reopenedStream?.items.map(({ event }) => event.changed)).toEqual([
      { [GUEST]: service.isEnabled(GUEST) },
    ]);
    expect(service.isEnabled(GUEST)).toBe(false);
    reopenedStream?.close();
    if (!cursor) throw new Error('no cursor before the switch');
    expect(await openRefusal(dispatcher, cursor)).toMatchObject({
      code: 'core.featureFlag.snapshotRequired',
    });
    const after = await collect(dispatcher, { keys: [GUEST] });
    await settle();
    expect(after.items[0]?.cursor.daemonEpoch).not.toBe(cursor.daemonEpoch);
    after.close();
  });

  it('ends a lagging reader after its unread items, and the end frame invalidates them', async () => {
    const service = await liveService({ [GUEST]: false });
    const dispatcher = dispatcherOver();
    // A pull reader that reads nothing until after the switch.
    const handle = await dispatcher.openStream(
      'core.featureFlag.events',
      { keys: [GUEST] },
      { caller: renderer },
    );
    ld.values = { [GUEST]: true };
    for (const listener of ld.changeListeners) listener();
    service.invalidateContext();

    const read: unknown[] = [];
    for await (const frame of handle.frames)
      read.push(
        frame.kind === 'item' ? frame.item.changed[GUEST] : frame.error?.code,
      );
    // Items queued before the switch still come first; the reset end frame
    // that follows invalidates them, so the reader re-reads the snapshot.
    expect(read).toEqual([false, true, 'core.featureFlag.snapshotRequired']);
    const now = await dispatcher.query(
      'core.featureFlag.snapshot.get',
      { keys: [GUEST] },
      { caller: renderer },
    );
    expect(now.flags).toEqual({ [GUEST]: false });
    expect(service.isEnabled(GUEST)).toBe(false);
    handle.close();
  });

  it('forgets every earlier account across back-to-back switches', async () => {
    const service = await liveService({ [GUEST]: true });
    const dispatcher = dispatcherOver();
    const streams: Array<Awaited<ReturnType<typeof collect>>> = [];
    // Each stream reopens straight from its end frame, as the error asks.
    const open = async (): Promise<void> => {
      streams.push(
        await collect(dispatcher, { keys: [GUEST] }, undefined, () => {
          void open();
        }),
      );
    };
    await open();
    await settle();

    service.invalidateContext();
    service.invalidateContext();
    await settle();
    expect(streams.map(({ items }) => items[0]?.cursor.daemonEpoch)).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
    expect(
      new Set(streams.map(({ items }) => items[0]?.cursor.daemonEpoch)).size,
    ).toBe(3);
    // Only the stream opened before the switches saw the first account.
    expect(
      streams.map(({ items }) => items.map(({ event }) => event.changed)),
    ).toEqual([
      [{ [GUEST]: true }],
      [{ [GUEST]: false }],
      [{ [GUEST]: false }],
    ]);
    expect(streams.map(({ ended }) => ended() !== undefined)).toEqual([
      true,
      true,
      false,
    ]);
    for (const stream of streams) stream.close();
  });

  it('forgets the previous targeting identity when LaunchDarkly restarts under another', async () => {
    const service = await liveService({ [GUEST]: true });
    const dispatcher = dispatcherOver();
    const before = await collect(dispatcher, { keys: [GUEST] });
    await settle();
    const cursor = before.items[0]?.cursor;
    if (!cursor) throw new Error('no cursor before the restart');
    ld.values = { [GUEST]: false };
    for (const listener of ld.changeListeners) listener();
    await settle();
    expect(before.items.map(({ event }) => event.changed)).toEqual([
      { [GUEST]: true },
      { [GUEST]: false },
    ]);

    // A restart, as a recovery retry makes, that targets another identity.
    mockTargeting.key = 'another-install';
    ld.values = { [GUEST]: true };
    await service.initialize();
    await settle();
    expect(before.ended()).toMatchObject({
      code: 'core.featureFlag.snapshotRequired',
    });
    expect(await openRefusal(dispatcher, cursor)).toMatchObject({
      code: 'core.featureFlag.snapshotRequired',
    });
  });

  it('forgets the previous targeting identity when a recovery retry restarts under another', async () => {
    const service = await liveService({ [GUEST]: true });
    const dispatcher = dispatcherOver();
    const reset = await expectResetAfter(dispatcher);

    // A failed start leaves a backoff retry pending, as an outage does.
    ld.initError = new Error('LaunchDarkly is unreachable.');
    await service.initialize();
    ld.initError = null;
    // Window focus retries early, under another identity.
    mockTargeting.key = 'another-install';
    ld.values = { [GUEST]: false };
    const now = Date.now();
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(now + LAUNCHDARKLY_RETRY_TRIGGER_MIN_INTERVAL_MS);
    service.requestRetry('window_focus');
    for (let turn = 0; turn < 5; turn += 1) await settle();
    expect(service.getSnapshot().values[GUEST]).toBe(false);
    await reset();
  });

  it('forgets the previous targeting identity when a context refresh targets another', async () => {
    const service = await liveService({ [GUEST]: true });
    const dispatcher = dispatcherOver();
    const reset = await expectResetAfter(dispatcher);

    mockTargeting.key = 'another-install';
    ld.values = { [GUEST]: false };
    await service.refreshContext();
    await settle();
    await reset();
  });

  it('forgets the previous account on account switch and sign-out through the Labs account wiring', async () => {
    mockAccounts.current = {
      apiKey: 'golden-key-a',
      account: { id: 'golden-account-a' },
    };
    await liveService({ [GUEST]: true });
    getLabsExperimentsService();
    const dispatcher = dispatcherOver();

    for (const next of [
      { apiKey: 'golden-key-b', account: { id: 'golden-account-b' } },
      null,
    ]) {
      const reset = await expectResetAfter(dispatcher);
      mockAccounts.publish(next);
      await settle();
      await reset();
    }
  });

  it('keeps a stream reopened in the newest epoch when an older reset is still queued', async () => {
    const service = await liveService({ [GUEST]: false });
    const dispatcher = dispatcherOver();
    let reopened: ReturnType<typeof collect> | undefined;
    let switched = false;
    // Two account switches made while a revision is being delivered queue
    // two resets; the stream reopened from the first one is already current.
    const first = await collect(
      dispatcher,
      { keys: [GUEST] },
      (event) => {
        if (event.revision === 0 || switched) return;
        switched = true;
        service.invalidateContext();
        service.invalidateContext();
      },
      () => {
        reopened = collect(dispatcher, { keys: [GUEST] });
      },
    );
    await settle();
    ld.values = { [GUEST]: true };
    for (const listener of ld.changeListeners) listener();
    await settle();
    expect(first.ended()).toMatchObject({
      code: 'core.featureFlag.snapshotRequired',
    });
    const current = await reopened;
    expect(current?.items.map(({ event }) => event.changed)).toEqual([
      { [GUEST]: service.isEnabled(GUEST) },
    ]);
    expect(current?.items[0]?.cursor.daemonEpoch).not.toBe(
      first.items[0]?.cursor.daemonEpoch,
    );
    expect(current?.ended()).toBeUndefined();
    current?.close();
  });

  it('delivers revisions in order when a subscriber changes flags mid-delivery', async () => {
    let snapshot: FeatureFlagSnapshot =
      getDefaultFeatureFlagSnapshot('not_configured');
    const listeners = new Set<() => void>();
    const dispatcher = dispatcherOver({
      snapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    });
    const flip = (): void => {
      snapshot = {
        ...snapshot,
        values: { ...snapshot.values, [GUEST]: !snapshot.values[GUEST] },
      };
      for (const listener of [...listeners]) listener();
    };

    // A change made from the opening event still reaches that stream.
    let flippedOnOpen = false;
    const opening = await collect(dispatcher, {}, () => {
      if (flippedOnOpen) return;
      flippedOnOpen = true;
      flip();
    });
    await settle();
    expect(opening.items.map(({ event }) => event.revision)).toEqual([0, 1]);

    // A change made by one subscriber while revision 2 is being delivered
    // reaches every subscriber after revision 2, never before it.
    let flippedLive = false;
    const first = await collect(dispatcher, {}, (event) => {
      if (event.revision !== 2 || flippedLive) return;
      flippedLive = true;
      flip();
    });
    const second = await collect(dispatcher, {});
    await settle();
    flip();
    await settle();
    for (const stream of [opening, first, second]) {
      const revisions = stream.items.map(({ event }) => event.revision);
      expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
      expect(revisions.slice(-2)).toEqual([2, 3]);
      expect(stream.ended()).toBeUndefined();
      stream.close();
    }

    // Changes held while a stream opens all arrive in order, even when
    // delivering one of them makes another change.
    const held = await collect(dispatcher, {}, (event) => {
      if (event.revision === 3) {
        flip();
        flip();
      } else if (event.revision === 4) flip();
    });
    await settle();
    expect(held.items.map(({ event }) => event.revision)).toEqual([3, 4, 5, 6]);
    held.close();
  });
});
