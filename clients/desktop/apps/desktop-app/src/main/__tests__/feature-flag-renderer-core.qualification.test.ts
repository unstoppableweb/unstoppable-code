// CAN-4181 F5 migration golden: the desktop renderer reads the flags core
// owns or shares through core.featureFlag.* on the renderer relay, and
// interface flags through the feature-flags:* channels. The real
// FeatureFlagService, IPC handlers and broadcast, desktop runtime, renderer
// relay with its trusted-surface check, preload relay API and renderer store
// run together; only the LaunchDarkly SDK, the targeting context, IPC
// registration and webContents delivery are replaced.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import {
  CLIENT_FEATURE_FLAGS,
  CORE_FEATURE_FLAG_KEYS,
  getDefaultFeatureFlagSnapshot,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  RemoteControlContext,
  UsageDataPolicySnapshot,
} from '@canopy/desktop-shared/types';
import {
  disposePostHogInstrumentationClient,
  initializeDesktopInstrumentationClient,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import type { CanopyCoreRelayRequest } from '../../shared/canopy-core-relay';
import { createCanopyCoreRelayApi } from '../../preload/api/canopy-core-relay-api';
import { findSecretSpans } from '@canopy/protocol/secret-redaction';
import { pastedSecretGuardEnabled } from '../../renderer/src/components/chat/usePastedSecretGuard';
import { createPostHogFlagSource } from '../../renderer/src/lib/instrumentation/posthog-flag-source';
import { useFeatureFlagsStore } from '../../renderer/src/stores/featureFlagsStore';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { createInterimInMemoryBindingProvider } from '../canopy-runtime/renderer-relay/interim-in-memory-binding';
import {
  createRendererRelay,
  type RendererRelay,
  type RendererRelayEvent,
  type RendererRelayOptions,
} from '../canopy-runtime/renderer-relay/relay';
import { resolveTrustedRelaySurface } from '../canopy-runtime/renderer-relay/trusted-surface';
import {
  disposeFeatureFlagService,
  getFeatureFlagService,
} from '../feature-flags';
import { RENDERER_RELAY_GRANTS } from '../ipc/canopy-core-relay';
import { registerFeatureFlagHandlers } from '../ipc/feature-flags';

jest.setTimeout(20_000);

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
    Promise.resolve({ kind: 'user', key: mockTargeting.key, anonymous: true }),
}));

const ld = {
  values: {} as Record<string, unknown>,
  changeListeners: new Set<() => void>(),
  // A failing identify makes the service publish its own error snapshot.
  identifyError: null as Error | null,
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
    waitForInitialization: (): Promise<void> => Promise.resolve(),
    identify: (): Promise<void> =>
      ld.identifyError ? Promise.reject(ld.identifyError) : Promise.resolve(),
    close: (): Promise<void> => Promise.resolve(),
  }),
};
jest.mock('@canopy/desktop-shared/node/lib/packaged-module-loader', () => ({
  ...jest.requireActual<object>(
    '@canopy/desktop-shared/node/lib/packaged-module-loader',
  ),
  loadRequiredNodeModule: (): object => fakeLaunchDarkly,
}));

// Main's feature-flags:snapshot-changed broadcast reaches the renderer's
// onSnapshotChanged listeners; `muted` holds it back to prove the core path.
const mockIpc = {
  muted: false,
  listeners: new Set<(snapshot: unknown) => void>(),
};
jest.mock('../lib/web-contents-send', () => ({
  ...jest.requireActual<object>('../lib/web-contents-send'),
  sendToWebContents: (
    _contents: unknown,
    channel: string,
    payload: unknown,
  ): boolean => {
    if (channel === 'feature-flags:snapshot-changed' && !mockIpc.muted)
      for (const listener of mockIpc.listeners) listener(payload);
    return true;
  },
}));

// Enough of the browser SDK for the renderer's PostHog client to initialize.
const mockPostHogSdk = {
  init: jest.fn(),
  onSessionId: jest.fn(() => (): void => undefined),
  capture: jest.fn<void, [string, unknown?]>(),
  captureException: jest.fn(),
  register_for_session: jest.fn(),
  unregister_for_session: jest.fn(),
  sessionManager: { setBootstrapSessionId: (): boolean => true },
  requestRouter: { endpointFor: (): string => 'http://127.0.0.1:18763/s/' },
  _send_request: jest.fn(),
  _send_retriable_request: jest.fn(),
  _retryQueue: {
    retriableRequest: jest.fn(),
    unload: jest.fn(),
    resume: jest.fn(),
  },
  _requestQueue: { unload: jest.fn() },
  set_config: jest.fn(),
  opt_out_capturing: jest.fn(),
  opt_in_capturing: jest.fn(),
  startSessionRecording: jest.fn(),
  stopSessionRecording: jest.fn(),
  sessionRecordingStarted: jest.fn(() => false),
  sessionRecording: { onRemoteConfig: jest.fn() },
};
jest.mock(
  'posthog-js/dist/module.full.no-external',
  () => ({ __esModule: true, default: mockPostHogSdk }),
  { virtual: true },
);

const GUEST = CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key; // both
const AUTOCAPTURE = CLIENT_FEATURE_FLAGS.canopyPostHogAutocaptureEnabled.key; // interface
const CAPTURE = CLIENT_FEATURE_FLAGS.canopyPostHogCaptureEnabled.key; // both
// Off in the default snapshot, so only core can show it on before IPC answers.
const RELEASE_NOTES = CLIENT_FEATURE_FLAGS.canopySharedReleaseNotesEnabled.key; // both
// The composer's pasted-secret guard (usePastedSecretGuard) reads this one.
const SECRET_GUARD = CLIENT_FEATURE_FLAGS.canopySharedAgentSecretRequests.key; // both

const suiteRoot = realpathSync(
  mkdtempSync(join(tmpdir(), 'ff-renderer-golden-')),
);
const ISOLATED_DIRS = {
  CANOPY_DATA_DIR: join(suiteRoot, 'data'),
  CANOPY_SECURE_DATA_DIR: join(suiteRoot, 'secure'),
};
const inherited = Object.fromEntries(
  Object.keys(ISOLATED_DIRS).map((name) => [name, process.env[name]]),
);

/** A window's webContents and main frame, as the relay's surface check reads them. */
function rendererPage(
  id: number,
  url: string,
): {
  event: RendererRelayEvent;
  window: {
    isDestroyed: () => boolean;
    webContents: RendererRelayEvent['sender'];
  };
} {
  const frame = { url, detached: false, isDestroyed: (): boolean => false };
  const sender: RendererRelayEvent['sender'] = {
    id,
    mainFrame: frame,
    getURL: (): string => frame.url,
    isDestroyed: (): boolean => false,
    on: () => undefined,
    removeListener: () => undefined,
  };
  return {
    event: { sender, senderFrame: frame },
    window: { isDestroyed: (): boolean => false, webContents: sender },
  };
}

const MAIN_URL = 'canopy://app/index.html';
const ADVISOR_URL = 'canopy://app/app-advisor.html';
const mainPage = rendererPage(7, MAIN_URL);
const advisorPage = rendererPage(8, ADVISOR_URL);
const strangerPage = rendererPage(9, 'https://example.invalid/');

let runtime: ReturnType<typeof createDesktopRuntime>;
let relay: RendererRelay;
let calls: string[];
let remote: RemoteControlContext;
let refuseRelay: boolean;
let refuseOpen: boolean;
let holdReRead: Promise<void> | null;
let stopFollowing: (() => void) | null;
// Items the events stream delivered, as distinct from snapshot reads.
let streamItems: number;
// Holds: the IPC hydrate, every stream item, and the next snapshot.get reply.
let holdHydrate: Promise<void> | null;
let holdStreamItems: Promise<void> | null;
let holdSnapshotReply: Promise<void> | null;
let heldSnapshotReplies: number;
// Stream items the relay already answered that wait on holdStreamItems.
let heldStreamItems: number;
// The window's `online` listeners, and the refreshContext calls they make.
const onlineListeners = new Set<() => void>();
let refreshContexts: number;
// Main's usage-data policy; null fails the read.
let usageDataPolicy: UsageDataPolicySnapshot | null;

/** The main window's renderer: its preload relay API over the real relay. */
function installRenderer(): void {
  const canopyCore = createCanopyCoreRelayApi({
    invoke: async (_channel: string, request: CanopyCoreRelayRequest) => {
      const label =
        'method' in request
          ? `${request.kind} ${request.method}`
          : request.kind;
      calls.push(label);
      if (
        holdReRead !== null &&
        label === 'request core.featureFlag.snapshot.get' &&
        calls.filter((call) => call === label).length > 1
      )
        await holdReRead;
      const refused = refuseRelay || (refuseOpen && label === OPEN_EVENTS);
      const reply = await relay.invoke(
        refused ? strangerPage.event : mainPage.event,
        request,
      );
      // A relay that fails while a call is in flight loses that call's reply.
      if (refuseRelay && !refused)
        return relay.invoke(strangerPage.event, request);
      if (label === SNAPSHOT_GET && holdSnapshotReply !== null) {
        // The reply is already read; only its delivery waits.
        const hold = holdSnapshotReply;
        holdSnapshotReply = null;
        heldSnapshotReplies++;
        await hold;
      }
      if (
        request.kind === 'readStream' &&
        reply.ok &&
        typeof reply.value === 'object' &&
        reply.value !== null &&
        Reflect.get(reply.value, 'kind') === 'item'
      ) {
        if (holdStreamItems !== null) {
          heldStreamItems++;
          await holdStreamItems;
        }
        streamItems++;
      }
      return reply;
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      canopyCore,
      addEventListener: (type: string, listener: () => void): void => {
        if (type === 'online') onlineListeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void): void => {
        if (type === 'online') onlineListeners.delete(listener);
      },
      api: {
        remoteControl: { getContext: () => remote },
        // The PostHog flag source also reads main's usage-data policy.
        observability: {
          getUsageDataPolicy: (): Promise<UsageDataPolicySnapshot> =>
            usageDataPolicy
              ? Promise.resolve(usageDataPolicy)
              : Promise.reject(new Error('no usage-data policy')),
          onUsageDataPolicyChanged: (): (() => void) => () => undefined,
        },
        featureFlags: {
          refreshContext: (): Promise<void> => {
            refreshContexts++;
            return Promise.resolve();
          },
          getSnapshot: async (): Promise<unknown> => {
            if (holdHydrate !== null) await holdHydrate;
            return handlers.get(IPC_CHANNELS.featureFlagsGetSnapshot)?.({});
          },
          onSnapshotChanged: (
            listener: (snapshot: unknown) => void,
          ): (() => void) => {
            mockIpc.listeners.add(listener);
            return (): void => {
              mockIpc.listeners.delete(listener);
            };
          },
        },
      },
    },
  });
}

async function until(
  check: () => boolean,
  what: string,
  ms = 5_000,
): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; )
    if (check()) return;
    else await new Promise((done) => setTimeout(done, 5));
  throw new Error(`timed out waiting for ${what}`);
}

const store = (): ReturnType<typeof useFeatureFlagsStore.getState> =>
  useFeatureFlagsStore.getState();
// What feature-flags:get-snapshot answers: the service's own snapshot.
const ipcValues = (): FeatureFlagSnapshot['values'] =>
  getFeatureFlagService().getSnapshot().values;
const changeLaunchDarkly = (values: Record<string, unknown>): void => {
  ld.values = values;
  for (const listener of ld.changeListeners) listener();
};
const count = (label: string): number =>
  calls.filter((call) => call === label).length;
const SNAPSHOT_GET = 'request core.featureFlag.snapshot.get';
const OPEN_EVENTS = 'openStream core.featureFlag.events';

async function start(
  values: Record<string, unknown>,
  limits?: RendererRelayOptions['limits'],
): Promise<void> {
  ld.values = values;
  process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'test-id';
  await getFeatureFlagService().initialize();
  registerFeatureFlagHandlers(() => null);
  // One runtime per service: the adapter binds the service on its first call.
  runtime = createDesktopRuntime();
  relay = createRendererRelay({
    bindingProvider: createInterimInMemoryBindingProvider(runtime),
    resolveSurface: (event) =>
      resolveTrustedRelaySurface(
        event,
        [
          { surface: 'main', window: mainPage.window, url: MAIN_URL },
          {
            surface: 'app-advisor',
            window: advisorPage.window,
            url: ADVISOR_URL,
          },
        ],
        RENDERER_RELAY_GRANTS,
      ),
    limits,
  });
  installRenderer();
}

// A product event the renderer's PostHog client sends while capture is on.
const OPERATION_EVENT = 'onboarding:first_run_import_view';
const sentOperations = (): number =>
  mockPostHogSdk.capture.mock.calls.filter(
    ([event]) => event === OPERATION_EVENT,
  ).length;

/**
 * Starts the renderer's PostHog client on the real flag source, as
 * startRenderer does before App mounts, with Usage analytics allowed.
 */
async function startInstrumentation(): Promise<void> {
  const allowed = {
    productAnalytics: true,
    errorReports: false,
    sessionReplay: false,
    activeUseSignal: false,
    featureFlagIdentity: false,
    skillSafetyCheck: false,
  };
  usageDataPolicy = {
    preferences: allowed,
    effective: allowed,
    prohibitedBy: {},
  };
  Object.assign(globalThis, {
    __CANOPY_POSTHOG_ENABLED__: true,
    __CANOPY_POSTHOG_PROJECT_KEY__: 'phc_test',
    __CANOPY_POSTHOG_HOST__: 'http://127.0.0.1:18763',
  });
  const session = {
    sessionId: '01890000-0000-7000-8000-000000000000',
    revision: 0,
  };
  expect(
    await initializeDesktopInstrumentationClient({
      surface: 'main',
      posthogFlags: createPostHogFlagSource(),
      getPostHogAnonymousId: () =>
        Promise.resolve('22222222-2222-4222-8222-222222222222'),
      posthogSession: {
        get: () => Promise.resolve(session),
        report: (proposal) => Promise.resolve(proposal),
        subscribe: (): (() => void) => (): void => undefined,
      },
    }),
  ).toEqual([{ enabled: true, provider: 'posthog' }]);
}

async function followCore(): Promise<void> {
  stopFollowing = store().follow();
  await until(() => store().core !== null, 'core flags in the store');
}

beforeAll(() => {
  for (const [name, dir] of Object.entries(ISOLATED_DIRS)) {
    mkdirSync(dir, { recursive: true });
    process.env[name] = dir;
  }
  jest
    .spyOn(BrowserWindow, 'getAllWindows')
    .mockReturnValue([
      Object.assign(new BrowserWindow(), { isDestroyed: () => false }),
    ]);
});

beforeEach(() => {
  calls = [];
  remote = { mode: 'local' };
  refuseRelay = false;
  refuseOpen = false;
  streamItems = 0;
  refreshContexts = 0;
  usageDataPolicy = null;
  mockPostHogSdk.capture.mockClear();
  ld.identifyError = null;
  holdHydrate = null;
  holdStreamItems = null;
  holdSnapshotReply = null;
  heldSnapshotReplies = 0;
  heldStreamItems = 0;
  holdReRead = null;
  stopFollowing = null;
  mockIpc.muted = false;
  const initial = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.setState({
    snapshot: initial,
    ipcSnapshot: initial,
    core: null,
  });
});

afterEach(async () => {
  disposePostHogInstrumentationClient();
  Object.assign(globalThis, {
    __CANOPY_POSTHOG_ENABLED__: false,
    __CANOPY_POSTHOG_PROJECT_KEY__: '',
    __CANOPY_POSTHOG_HOST__: 'https://us.i.posthog.com',
  });
  stopFollowing?.();
  mockIpc.listeners.clear();
  onlineListeners.clear();
  relay?.dispose();
  await runtime?.shutdown();
  await disposeFeatureFlagService();
  ld.changeListeners.clear();
  mockTargeting.key = 'anonymous-install';
});

afterAll(() => {
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
  Reflect.deleteProperty(globalThis, 'window');
  rmSync(suiteRoot, { recursive: true, force: true });
});

describe('desktop renderer flags through core.featureFlag (CAN-4181 F5)', () => {
  it('reads core and shared flags through core.featureFlag.snapshot.get, and interface flags over IPC', async () => {
    await start({ [GUEST]: true, [AUTOCAPTURE]: true, [RELEASE_NOTES]: true });
    // IPC hasn't answered (hydrate held, broadcasts muted) and the first
    // stream item is held, so only the snapshot read can paint core's values.
    mockIpc.muted = true;
    let releaseIpc = (): void => undefined;
    holdHydrate = new Promise((done) => {
      releaseIpc = done;
    });
    let releaseStream = (): void => undefined;
    holdStreamItems = new Promise((done) => {
      releaseStream = done;
    });
    await followCore();
    expect(streamItems).toBe(0);
    expect(store().ipcSnapshot.values[RELEASE_NOTES]).toBe(false);
    expect(store().snapshot.values[RELEASE_NOTES]).toBe(true);
    mockIpc.muted = false;
    releaseIpc();
    releaseStream();
    // The hydrate lands after the stream opened, so core reads once more.
    await until(
      () =>
        streamItems >= 1 &&
        store().core !== null &&
        store().ipcSnapshot.values[RELEASE_NOTES] === true,
      'the IPC hydrate and the first stream item',
    );

    expect(count(SNAPSHOT_GET)).toBeGreaterThanOrEqual(1);
    const service = getFeatureFlagService().getSnapshot();
    expect(Object.keys(store().core?.flags ?? {}).sort()).toEqual(
      [...CORE_FEATURE_FLAG_KEYS].sort(),
    );
    for (const key of CORE_FEATURE_FLAG_KEYS)
      expect(store().snapshot.values[key]).toBe(service.values[key]);
    expect(store().snapshot.values[GUEST]).toBe(true);
    expect(store().snapshot.values[AUTOCAPTURE]).toBe(ipcValues()[AUTOCAPTURE]);
    expect(store().snapshot.status).toBe('ready');
  });

  it('follows a core flag change on core.featureFlag.events with the IPC broadcast held back', async () => {
    await start({ [GUEST]: false });
    await followCore();
    await until(() => streamItems === 1, 'the first stream item');
    const snapshotReads = count(SNAPSHOT_GET);

    mockIpc.muted = true;
    changeLaunchDarkly({ [GUEST]: true });
    await until(
      () => store().snapshot.values[GUEST] === true,
      'the streamed change',
    );
    // A stream item carried the change, not a retried snapshot read.
    expect(streamItems).toBe(2);
    expect(count(SNAPSHOT_GET)).toBe(snapshotReads);
    expect(store().ipcSnapshot.values[GUEST]).toBe(false);
  });

  it('on an account switch drops core values at the end frame, re-reads the snapshot, reopens and follows the new account', async () => {
    await start({ [GUEST]: true });
    await followCore();
    await until(() => count(OPEN_EVENTS) === 1, 'the events stream');
    // What the store shows from the end frame's discard on.
    const seen: unknown[] = [];
    let discarded = false;
    const unsubscribe = useFeatureFlagsStore.subscribe((state) => {
      discarded ||= state.core === null;
      if (discarded) seen.push(state.snapshot.values[GUEST]);
    });

    // Startup may read twice: an IPC hydrate overtaking the first read drops it.
    const reads = count(SNAPSHOT_GET);
    mockTargeting.key = 'another-account';
    getFeatureFlagService().invalidateContext();
    await until(
      () => count(SNAPSHOT_GET) === reads + 1 && count(OPEN_EVENTS) === 2,
      'the re-read and the reopened stream',
    );
    await until(
      () => store().core?.provenance.status === 'initializing',
      'the new epoch',
    );
    // Nothing of the previous account shows once its stream ended.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(true);
    expect(store().snapshot.values[GUEST]).toBe(false);

    mockIpc.muted = true;
    await getFeatureFlagService().refreshContext();
    await until(
      () => store().snapshot.values[GUEST] === true,
      'the new account, streamed',
    );
    unsubscribe();
  });

  it('shows the IPC values of the same service after the end frame until the re-read lands', async () => {
    await start({ [GUEST]: true, [AUTOCAPTURE]: true });
    await followCore();
    await until(() => count(OPEN_EVENTS) === 1, 'the events stream');
    let release = (): void => undefined;
    holdReRead = new Promise((done) => {
      release = done;
    });

    // The follower's own retry waits, which a snapshotRequired end skips.
    const retryWaits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = jest
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback: () => void, ms?: number) => {
        const caller = (new Error().stack ?? '')
          .split('\n')
          .slice(1)
          .find((frame) => !/jest-mock|qualification\.test/.test(frame));
        if (caller?.includes('core-feature-flag-client') === true)
          retryWaits.push(ms ?? 0);
        return realSetTimeout(callback, ms);
      });
    const reads = count(SNAPSHOT_GET);
    try {
      // IPC's broadcast is held, so only the end frame can drop core.
      mockIpc.muted = true;
      getFeatureFlagService().invalidateContext();
      await until(() => store().core === null, 'the discard');
      expect(store().ipcSnapshot.values[GUEST]).toBe(true);
      await until(() => count(SNAPSHOT_GET) === reads + 1, 'the held re-read');
      expect(retryWaits).toEqual([]);
    } finally {
      spy.mockRestore();
    }

    mockIpc.muted = false;
    const next = getFeatureFlagService().getSnapshot();
    for (const listener of mockIpc.listeners) listener(next);
    expect(store().snapshot.values).toEqual(ipcValues());
    expect(store().snapshot.values[GUEST]).toBe(false);

    release();
    await until(() => store().core !== null, 'the re-read');
    expect(store().snapshot.values[GUEST]).toBe(false);
  });

  it('drops core values on a late IPC broadcast, whose values and interface flags show until core reads again', async () => {
    await start({ [GUEST]: true, [AUTOCAPTURE]: false });
    await followCore();
    const stale = getFeatureFlagService().getSnapshot();

    for (const listener of mockIpc.listeners)
      listener({
        ...stale,
        values: { ...stale.values, [GUEST]: false, [AUTOCAPTURE]: true },
      });
    // An IPC snapshot may be another account's, so it never sits under core's.
    expect(store().core).toBeNull();
    expect(store().snapshot.values[GUEST]).toBe(false);
    expect(store().snapshot.values[AUTOCAPTURE]).toBe(true);
  });

  it('in Remote Control mode makes no relay call and follows the tunneled IPC alone', async () => {
    await start({ [GUEST]: false });
    remote = {
      mode: 'remote',
      deviceId: 'device-1',
      name: 'Other Mac',
      platform: 'darwin',
    };
    stopFollowing = store().follow();
    await until(
      () => store().snapshot.values[GUEST] === false,
      'the IPC hydrate',
    );

    changeLaunchDarkly({ [GUEST]: true });
    await until(
      () => store().snapshot.values[GUEST] === true,
      'the IPC broadcast',
    );
    expect(calls).toEqual([]);
    expect(store().core).toBeNull();
  });

  it('falls back to IPC while the relay refuses, and follows core once it answers', async () => {
    await start({ [GUEST]: false });
    refuseRelay = true;
    stopFollowing = store().follow();
    await until(
      () => calls.length > 0 && store().snapshot.values[GUEST] === false,
      'IPC values',
    );
    expect(store().core).toBeNull();
    changeLaunchDarkly({ [GUEST]: true });
    await until(
      () => store().snapshot.values[GUEST] === true,
      'the IPC broadcast',
    );
    expect(store().core).toBeNull();

    refuseRelay = false;
    await until(() => store().core !== null, 'core after the retry', 10_000);
    expect(store().snapshot.values[GUEST]).toBe(true);
  });

  it('keeps App Advisor on IPC: its relay surface refuses core.featureFlag, and hydrate reads IPC alone', async () => {
    await start({ [GUEST]: true });
    for (const request of [
      { kind: 'request', method: 'core.featureFlag.snapshot.get', params: {} },
      { kind: 'openStream', method: 'core.featureFlag.events', params: {} },
    ])
      expect(await relay.invoke(advisorPage.event, request)).toMatchObject({
        ok: false,
        error: { kind: 'capability_unavailable' },
      });

    await store().hydrate();
    expect(calls).toEqual([]);
    expect(store().snapshot.values).toEqual(ipcValues());
  });

  it('backs off, doubling to 30 s, when the stream fails after every successful snapshot read', async () => {
    await start({ [GUEST]: true });
    refuseOpen = true;
    // The follower's retry waits, run at once so the schedule shows quickly.
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = jest
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback: () => void, ms?: number) => {
        // Only a wait the client itself schedules, not a relay timer it reaches.
        const caller = (new Error().stack ?? '')
          .split('\n')
          .slice(1)
          .find((frame) => !/jest-mock|qualification\.test/.test(frame));
        if (caller?.includes('core-feature-flag-client') !== true)
          return realSetTimeout(callback, ms);
        waits.push(ms ?? 0);
        return realSetTimeout(callback, 0);
      });
    try {
      stopFollowing = store().follow();
      await until(() => waits.length >= 7, 'seven retry waits');
      expect(waits.slice(0, 7)).toEqual([
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
      ]);
      // Every retry read the snapshot, and no stream ever opened.
      expect(count(SNAPSHOT_GET)).toBeGreaterThanOrEqual(7);
      expect(streamItems).toBe(0);
    } finally {
      stopFollowing?.();
      stopFollowing = null;
      spy.mockRestore();
    }
  });

  it('stops PostHog capture when the kill switch flips before App mounts', async () => {
    await start({ [CAPTURE]: true });
    // Instrumentation starts before the startup gate renders App, so nothing
    // follows the store yet.
    await startInstrumentation();
    succeedClientOperation('canopy.first_run_import_view');
    expect(sentOperations()).toBe(1);
    const source = createPostHogFlagSource();
    const capture: unknown[] = [];
    const stop = source.onSnapshotChanged((flags) => {
      capture.push(flags.captureEnabled);
    });
    expect((await source.getSnapshot()).captureEnabled).toBe(true);

    changeLaunchDarkly({ [CAPTURE]: false });
    await until(() => capture.at(-1) === false, 'capture off');
    succeedClientOperation('canopy.first_run_import_view');
    expect(sentOperations()).toBe(1);
    stop();
  });

  it("keeps PostHog capture off on a fresh IPC false after a relay failure loses core's update", async () => {
    await start({ [CAPTURE]: true });
    await followCore();
    await until(() => streamItems === 1, 'the first stream item');
    await startInstrumentation();
    succeedClientOperation('canopy.first_run_import_view');
    expect(sentOperations()).toBe(1);
    const source = createPostHogFlagSource();
    const capture: unknown[] = [];
    const stop = source.onSnapshotChanged((flags) => {
      capture.push(flags.captureEnabled);
    });

    // The relay loses core's read of the kill switch while IPC's broadcast
    // of it is held back: the failure alone drops core.
    refuseRelay = true;
    mockIpc.muted = true;
    changeLaunchDarkly({ [CAPTURE]: false });
    await until(() => store().core === null, 'core no longer fresh');
    expect(store().ipcSnapshot.values[CAPTURE]).toBe(true);

    mockIpc.muted = false;
    const killed = getFeatureFlagService().getSnapshot();
    for (const listener of mockIpc.listeners) listener(killed);
    expect(store().snapshot.values[CAPTURE]).toBe(false);
    await until(() => capture.at(-1) === false, 'capture off');
    expect((await source.getSnapshot()).captureEnabled).toBe(false);
    succeedClientOperation('canopy.first_run_import_view');
    expect(sentOperations()).toBe(1);
    stop();
  });

  it('reads the IPC error status, not a cached core ready, after a relay failure, so going online retries LaunchDarkly', async () => {
    await start({ [GUEST]: true });
    await followCore();
    await until(() => streamItems === 1, 'the first stream item');
    expect(store().snapshot.status).toBe('ready');

    refuseRelay = true;
    ld.identifyError = new Error('LaunchDarkly unreachable');
    await getFeatureFlagService().refreshContext();
    expect(store().ipcSnapshot.status).toBe('error');
    await until(
      () => store().snapshot.status === 'error',
      'the IPC error status',
    );

    for (const listener of onlineListeners) listener();
    expect(refreshContexts).toBe(1);
  });

  it('retries LaunchDarkly on online when IPC reports an error core has not streamed yet', async () => {
    await start({ [GUEST]: true });
    await followCore();
    await until(() => streamItems === 1, 'the first stream item');
    let release = (): void => undefined;
    holdStreamItems = new Promise((done) => {
      release = done;
    });

    ld.identifyError = new Error('LaunchDarkly unreachable');
    await getFeatureFlagService().refreshContext();
    expect(store().ipcSnapshot.status).toBe('error');
    // Core lags: its item for the error is held, and the IPC snapshot has
    // dropped core's ready.
    expect(store().core).toBeNull();
    for (const listener of onlineListeners) listener();
    expect(refreshContexts).toBe(1);

    release();
    await until(
      () => store().core?.provenance.status === 'error',
      'core catching up',
    );
  });

  it('never paints a snapshot read for the previous account once IPC delivers the next one, and reads core again', async () => {
    await start({ [GUEST]: true });
    // The previous account's IPC snapshot is in place before the follower
    // starts, and its hydrate and first stream item are held, so only the
    // account switch's IPC snapshot can overtake the held read.
    useFeatureFlagsStore
      .getState()
      .setSnapshot(getFeatureFlagService().getSnapshot());
    let releaseHydrate = (): void => undefined;
    holdHydrate = new Promise((done) => {
      releaseHydrate = done;
    });
    let releaseStream = (): void => undefined;
    holdStreamItems = new Promise((done) => {
      releaseStream = done;
    });
    let releaseRead = (): void => undefined;
    holdSnapshotReply = new Promise((done) => {
      releaseRead = done;
    });
    stopFollowing = store().follow();
    await until(
      () => heldSnapshotReplies === 1,
      "the first account's snapshot read, held",
    );
    expect(store().ipcSnapshot.values[GUEST]).toBe(true);
    // What the store shows from the next account's IPC snapshot on.
    const seen: unknown[] = [];
    let switched = false;
    const unsubscribe = useFeatureFlagsStore.subscribe((state) => {
      if (switched) seen.push(state.snapshot.values[GUEST]);
    });

    switched = true;
    mockTargeting.key = 'another-account';
    getFeatureFlagService().invalidateContext();
    expect(store().ipcSnapshot.values[GUEST]).toBe(false);
    const reads = count(SNAPSHOT_GET);
    releaseRead();
    await until(() => store().core !== null, 'core read again');
    expect(seen).not.toContain(true);
    expect(count(SNAPSHOT_GET)).toBeGreaterThan(reads);
    expect(store().snapshot.values[GUEST]).toBe(false);
    releaseHydrate();
    releaseStream();
    unsubscribe();
  });

  it('scans a pasted secret on a fresh IPC true while core last read false, from the relay failure until core reads again', async () => {
    const pasted = `token ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
    await start({ [SECRET_GUARD]: false });
    await followCore();
    await until(() => streamItems === 1, 'the first stream item');
    expect(store().isEnabled(SECRET_GUARD)).toBe(false);

    refuseRelay = true;
    changeLaunchDarkly({ [SECRET_GUARD]: true });
    await until(
      () => store().ipcSnapshot.values[SECRET_GUARD] === true,
      'the IPC guard',
    );
    // usePastedSecretGuard's gate: on, its paste handler scans the text.
    await until(() => store().isEnabled(SECRET_GUARD), 'the guard on');
    expect(findSecretSpans(pasted).length).toBeGreaterThan(0);

    // Reconnected, but core has not read again yet: IPC still wins.
    let release = (): void => undefined;
    holdReRead = new Promise((done) => {
      release = done;
    });
    const reads = count(SNAPSHOT_GET);
    refuseRelay = false;
    await until(() => count(SNAPSHOT_GET) > reads, 'the held re-read', 10_000);
    expect(store().core).toBeNull();
    expect(store().isEnabled(SECRET_GUARD)).toBe(true);

    release();
    await until(() => store().core !== null, 'core read again');
    expect(store().isEnabled(SECRET_GUARD)).toBe(true);
  });

  it("turns the paste guard's selector on, and its scanner finds a pasted secret, while core reads the guard off and IPC has it on", async () => {
    const pasted = `token ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
    await start({ [SECRET_GUARD]: false });
    await followCore();
    await until(() => streamItems === 1, 'the first stream item');
    expect(pastedSecretGuardEnabled(store())).toBe(false);

    // IPC publishes the guard on, which drops core; the flag service still
    // has it off.
    const stale = getFeatureFlagService().getSnapshot();
    for (const listener of mockIpc.listeners)
      listener({ ...stale, values: { ...stale.values, [SECRET_GUARD]: true } });
    expect(store().core).toBeNull();
    // Core's next item is dropped, and its re-read lands fresh with off.
    const reads = count(SNAPSHOT_GET);
    mockIpc.muted = true;
    changeLaunchDarkly({ [SECRET_GUARD]: false, [GUEST]: true });
    await until(
      () => count(SNAPSHOT_GET) > reads && store().core !== null,
      "core's re-read",
    );
    expect(store().core?.flags[SECRET_GUARD]).toBe(false);
    expect(store().snapshot.values[SECRET_GUARD]).toBe(false);
    expect(store().ipcSnapshot.values[SECRET_GUARD]).toBe(true);
    // usePastedSecretGuard's gate fails closed: IPC's on decides, and its
    // paste handler scans.
    expect(pastedSecretGuardEnabled(store())).toBe(true);
    expect(findSecretSpans(pasted).length).toBeGreaterThan(0);

    // Core catches up once the flag service turns the guard on.
    mockIpc.muted = false;
    changeLaunchDarkly({ [SECRET_GUARD]: true, [GUEST]: true });
    await until(
      () => store().core?.flags[SECRET_GUARD] === true,
      'core catching up',
    );
    expect(pastedSecretGuardEnabled(store())).toBe(true);
  });

  it("never paints the previous account's queued stream item once IPC delivers the next account's snapshot", async () => {
    await start({ [GUEST]: false });
    await followCore();
    await until(() => streamItems === 1, 'the first stream item');
    let release = (): void => undefined;
    holdStreamItems = new Promise((done) => {
      release = done;
    });
    // The previous account's change reaches core's stream alone, and its item
    // waits in the relay ahead of the end frame.
    mockIpc.muted = true;
    changeLaunchDarkly({ [GUEST]: true });
    await until(
      () => heldStreamItems === 1,
      "the previous account's queued item",
    );
    mockIpc.muted = false;
    const seen: unknown[] = [];
    const unsubscribe = useFeatureFlagsStore.subscribe((state) => {
      seen.push(state.snapshot.values[GUEST]);
    });

    mockTargeting.key = 'another-account';
    ld.values = { [GUEST]: false };
    getFeatureFlagService().invalidateContext();
    expect(store().ipcSnapshot.values[GUEST]).toBe(false);
    const opens = count(OPEN_EVENTS);
    release();
    await until(
      () => count(OPEN_EVENTS) === opens + 1 && store().core !== null,
      'core read again',
    );
    expect(seen).not.toContain(true);
    expect(store().snapshot.values[GUEST]).toBe(false);
    unsubscribe();
  });

  it('reads core again once for an IPC snapshot that lands after the stream opened, and follows the new stream', async () => {
    await start({ [GUEST]: false });
    await followCore();
    await until(() => streamItems === 1, 'the first stream item');
    const reads = count(SNAPSHOT_GET);
    const opens = count(OPEN_EVENTS);

    // IPC broadcasts the change before core's item for it arrives.
    changeLaunchDarkly({ [GUEST]: true });
    await until(
      () => count(OPEN_EVENTS) === opens + 1 && store().core !== null,
      'the re-read and the reopened stream',
    );
    expect(count(SNAPSHOT_GET)).toBe(reads + 1);
    expect(store().snapshot.values[GUEST]).toBe(true);

    // The new stream records that IPC snapshot, so its items apply.
    mockIpc.muted = true;
    changeLaunchDarkly({ [GUEST]: false });
    await until(
      () => store().snapshot.values[GUEST] === false,
      'the streamed change',
    );
    expect(count(SNAPSHOT_GET)).toBe(reads + 1);
    expect(count(OPEN_EVENTS)).toBe(opens + 1);
  });

  it("shows the next account's IPC guest mode at once over the previous account's core values, until core reads again", async () => {
    await start({ [GUEST]: true });
    await followCore();
    await until(() => streamItems === 1, 'the first stream item');
    expect(store().isEnabled(GUEST)).toBe(true);
    let release = (): void => undefined;
    holdReRead = new Promise((done) => {
      release = done;
    });

    const reads = count(SNAPSHOT_GET);
    mockTargeting.key = 'another-account';
    ld.values = { [GUEST]: false };
    getFeatureFlagService().invalidateContext();
    // App.tsx's sign-in gate and guest-credential mint read this selector.
    expect(store().isEnabled(GUEST)).toBe(false);
    expect(store().core).toBeNull();
    await until(() => count(SNAPSHOT_GET) === reads + 1, 'the held re-read');
    expect(store().isEnabled(GUEST)).toBe(false);

    release();
    await until(() => store().core !== null, 'core read again');
    // Core wins again: the next account's value streams with IPC held back.
    mockIpc.muted = true;
    ld.values = { [GUEST]: true };
    await getFeatureFlagService().refreshContext();
    await until(() => store().isEnabled(GUEST), 'the streamed change');
    expect(store().ipcSnapshot.values[GUEST]).toBe(false);
  });

  it("keeps one settlement handler on a quiet stream's pending pull across read deadlines", async () => {
    await start({ [GUEST]: true });
    const quiet = createRendererRelay({
      bindingProvider: createInterimInMemoryBindingProvider(runtime),
      resolveSurface: (event) =>
        resolveTrustedRelaySurface(
          event,
          [{ surface: 'main', window: mainPage.window, url: MAIN_URL }],
          RENDERER_RELAY_GRANTS,
        ),
      limits: { deadlineMs: 20 },
    });
    const then = jest.spyOn(Promise.prototype, 'then');
    try {
      const opened = await quiet.invoke(mainPage.event, {
        kind: 'openStream',
        method: 'core.featureFlag.events',
        params: {},
      });
      const subscriptionId: unknown = opened.ok
        ? Reflect.get(Object(opened.value), 'subscriptionId')
        : undefined;
      if (typeof subscriptionId !== 'string') throw new Error('no stream');
      const read = (): ReturnType<RendererRelay['invoke']> =>
        quiet.invoke(mainPage.event, { kind: 'readStream', subscriptionId });
      expect(await read()).toMatchObject({ ok: true, value: { kind: 'item' } });

      // Each read of the quiet stream passes its deadline and leaves the
      // same pull pending; no pull gains a reaction per read.
      then.mockClear();
      for (let attempt = 0; attempt < 20; attempt++)
        expect(await read()).toMatchObject({
          ok: false,
          error: { kind: 'deadline_exceeded' },
        });
      const reactions = new Map<unknown, number>();
      for (const promise of then.mock.contexts)
        reactions.set(promise, (reactions.get(promise) ?? 0) + 1);
      expect(Math.max(...reactions.values())).toBeLessThanOrEqual(2);

      // The pull those reads kept is the one the next change settles.
      then.mockRestore();
      changeLaunchDarkly({ [GUEST]: false });
      let reply = await read();
      for (let attempt = 0; attempt < 25 && !reply.ok; attempt++) {
        expect(reply).toMatchObject({ error: { kind: 'deadline_exceeded' } });
        reply = await read();
      }
      expect(reply).toMatchObject({
        ok: true,
        value: { kind: 'item', item: { changed: { [GUEST]: false } } },
      });
    } finally {
      then.mockRestore();
      quiet.dispose();
    }
  });

  it('reads core again after an IPC snapshot for an interface flag, while its stream stays quiet', async () => {
    // A short read deadline, so the quiet stream's read times out quickly.
    await start({ [AUTOCAPTURE]: false }, { deadlineMs: 50 });
    await followCore();
    await until(() => streamItems === 1, 'the first stream item');
    const reads = count(SNAPSHOT_GET);
    const items = streamItems;

    // An interface-only change: IPC broadcasts it, core streams nothing.
    // The re-read is held, so no reopened stream can deliver meanwhile.
    let release = (): void => undefined;
    holdReRead = new Promise((done) => {
      release = done;
    });
    changeLaunchDarkly({ [AUTOCAPTURE]: true });
    expect(store().core).toBeNull();
    await until(() => count(SNAPSHOT_GET) > reads, 'core read again', 2_000);
    expect(streamItems).toBe(items);

    release();
    await until(() => store().core !== null, "core's values back");
    expect(Object.keys(store().core?.flags ?? {}).sort()).toEqual(
      [...CORE_FEATURE_FLAG_KEYS].sort(),
    );
    expect(store().snapshot.values[AUTOCAPTURE]).toBe(true);
  });
});
