// CAN-4181 capture golden: feature flag evaluation as Electron main serves it
// today, pinned before core.featureFlag.* takes it over. Electron main is the
// only evaluator: it drives the real FeatureFlagService through each
// LaunchDarkly state (unconfigured, configured but unavailable, live, a later
// outage, local-only), the real feature-flags:* handlers with values a client
// forges, and the real guest-mode gate in disconnectCanopyCloudAccount. Only
// the LaunchDarkly SDK, the targeting context, the guest mint and IPC
// registration are replaced. Each mode's defaults are pinned in this
// suite's snapshot, so changing one is a deliberate re-record, and the suite
// runs on its own data and secure directories, never inherited ones.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { BrowserWindow } from 'electron';
import {
  CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
  CLIENT_FEATURE_FLAGS,
  getClientFeatureFlagDefaults,
  getLocalOnlyClientFeatureFlagDefaults,
  isCoreFeatureFlagKey,
  type FeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  disposeFeatureFlagService,
  FeatureFlagService,
  getFeatureFlagService,
} from '../feature-flags';
import type { FeatureFlagAppDiagnostic } from '../feature-flags/service';

// The first import of ipc/settings takes several seconds.
jest.setTimeout(60_000);

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

let localOnly = false;
jest.mock('../local-only/profile', () => ({
  ...jest.requireActual<object>('../local-only/profile'),
  isLocalOnlyBuild: (): boolean => localOnly,
}));

jest.mock('../feature-flags/context', () => ({
  ...jest.requireActual<object>('../feature-flags/context'),
  buildDesktopFeatureFlagContext: (): Promise<object> =>
    Promise.resolve({
      kind: 'user',
      key: 'anonymous-install',
      anonymous: true,
    }),
}));

type Ld = {
  values: Record<string, unknown>;
  start: 'ok' | 'fail';
  identify: 'ok' | 'fail';
  changeListeners: Set<() => void>;
  starts: number;
};
const ld: Ld = {
  values: {},
  start: 'ok',
  identify: 'ok',
  changeListeners: new Set(),
  starts: 0,
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
    waitForInitialization: (): Promise<void> => {
      ld.starts += 1;
      return ld.start === 'ok'
        ? Promise.resolve()
        : Promise.reject(new Error('LaunchDarkly unreachable'));
    },
    identify: (): Promise<void> =>
      ld.identify === 'ok'
        ? Promise.resolve()
        : Promise.reject(new Error('LaunchDarkly identify failed')),
    close: (): Promise<void> => Promise.resolve(),
  }),
};
jest.mock('@canopy/desktop-shared/node/lib/packaged-module-loader', () => ({
  ...jest.requireActual<object>(
    '@canopy/desktop-shared/node/lib/packaged-module-loader',
  ),
  loadRequiredNodeModule: (): object => fakeLaunchDarkly,
}));

const pushed: Array<{ channel: string; payload: unknown }> = [];
jest.mock('../lib/web-contents-send', () => ({
  ...jest.requireActual<object>('../lib/web-contents-send'),
  sendToWebContents: (
    _target: unknown,
    channel: string,
    payload: unknown,
  ): boolean => {
    pushed.push({ channel, payload });
    return true;
  },
}));

const mintGuest = jest.fn();
jest.mock('../canopy-cloud/guest-auth', () => ({
  ...jest.requireActual<object>('../canopy-cloud/guest-auth'),
  mintGuest: (): unknown => mintGuest(),
}));

const GUEST = CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key;
const DISABLED_DEFAULTS = getClientFeatureFlagDefaults('launchdarkly_disabled');
const UNAVAILABLE_DEFAULTS =
  CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS;
const BOOLEAN_KEYS = Object.values(CLIENT_FEATURE_FLAGS)
  .map(({ key }) => key)
  .filter((key) => typeof UNAVAILABLE_DEFAULTS[key] === 'boolean');

function configureLaunchDarkly(configured: boolean): void {
  if (configured) process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID = 'test-id';
  else delete process.env.LAUNCHDARKLY_DESKTOP_CLIENT_SIDE_ID;
}

function newService(random = 0.5): {
  service: FeatureFlagService;
  diagnostics: FeatureFlagAppDiagnostic[];
} {
  const diagnostics: FeatureFlagAppDiagnostic[] = [];
  const service = new FeatureFlagService({ random: (): number => random });
  service.setDiagnosticRecorder((record) => diagnostics.push(record));
  return { service, diagnostics };
}

function forgedClientSnapshot(): FeatureFlagSnapshot {
  const values = { ...UNAVAILABLE_DEFAULTS };
  for (const key of BOOLEAN_KEYS) Object.assign(values, { [key]: true });
  return {
    values,
    status: 'ready',
    initialized: true,
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

// Never an inherited data or secure directory: disconnect deletes the stored
// account and writes consent through the real preferences writer.
const suiteRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ff-golden-')));
const ISOLATED_DIRS = {
  CANOPY_DATA_DIR: join(suiteRoot, 'data'),
  CANOPY_SECURE_DATA_DIR: join(suiteRoot, 'secure'),
} as const;
const inheritedDirs = Object.fromEntries(
  Object.keys(ISOLATED_DIRS).map((name) => [name, process.env[name]]),
);
beforeAll(() => {
  for (const [name, dir] of Object.entries(ISOLATED_DIRS)) {
    process.env[name] = dir;
    mkdirSync(dir);
  }
});
afterAll(async () => {
  // The guest restore saves preferences, and each save refreshes the
  // last-good backup in the background; let it land before the root goes.
  const { flushPreferencesWrites } = await import('../lib/preferences-store');
  await flushPreferencesWrites();
  for (const [name, value] of Object.entries(inheritedDirs)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(suiteRoot, { recursive: true, force: true });
});

/** Lets the retry's async start settle under fake timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  localOnly = false;
  ld.values = {};
  ld.start = 'ok';
  ld.identify = 'ok';
  ld.changeListeners.clear();
  ld.starts = 0;
  handlers.clear();
  pushed.length = 0;
  mintGuest.mockReset();
  configureLaunchDarkly(false);
});

afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await disposeFeatureFlagService();
});

describe('FeatureFlagService states', () => {
  it('serves LaunchDarkly-disabled defaults when unconfigured', async () => {
    const { service, diagnostics } = newService();
    const snapshot = await service.initialize();

    expect(snapshot.status).toBe('not_configured');
    expect(snapshot.error).toBeNull();
    expect(snapshot.values).toEqual(DISABLED_DEFAULTS);
    expect(snapshot.values).toMatchSnapshot('LaunchDarkly-disabled defaults');
    expect(service.isEnabled(GUEST)).toBe(DISABLED_DEFAULTS[GUEST] === true);
    expect(diagnostics).toEqual([]);
    await service.dispose();
  });

  it('serves enabled-unavailable fallbacks when configured but unreachable, then recovers on the jittered retry', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    configureLaunchDarkly(true);
    ld.start = 'fail';
    // 0.75 jitters the first 15 s delay by +10 percent: 16.5 s.
    const { service, diagnostics } = newService(0.75);
    const snapshot = await service.initialize();

    expect(snapshot.status).toBe('error');
    expect(snapshot.error).toBe('LaunchDarkly unreachable');
    expect(snapshot.values).toEqual(UNAVAILABLE_DEFAULTS);
    expect(snapshot.values).toMatchSnapshot(
      'configured-but-unavailable fallbacks',
    );
    expect(service.isEnabled(GUEST)).toBe(UNAVAILABLE_DEFAULTS[GUEST] === true);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'feature_flags_unavailable',
        featureFlagFailedAttempts: 1,
        featureFlagValuesSource: 'unavailable_fallback',
        retryAfterMs: 16_500,
      }),
    ]);

    ld.start = 'ok';
    ld.values = { [GUEST]: !UNAVAILABLE_DEFAULTS[GUEST] };
    await jest.advanceTimersByTimeAsync(16_499);
    await settle();
    expect(ld.starts).toBe(1);
    expect(service.getSnapshot().status).toBe('error');

    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(ld.starts).toBe(2);
    expect(service.getSnapshot()).toEqual(
      expect.objectContaining({ status: 'ready', error: null }),
    );
    expect(service.isEnabled(GUEST)).toBe(!UNAVAILABLE_DEFAULTS[GUEST]);
    expect(diagnostics.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'feature_flags_recovered',
        featureFlagFailedAttempts: 1,
        featureFlagRecoveryTrigger: 'backoff',
      }),
    );
    await service.dispose();
  });

  it('projects live values and replaces wrongly typed ones with their fallback', async () => {
    configureLaunchDarkly(true);
    ld.values = { [GUEST]: !UNAVAILABLE_DEFAULTS[GUEST] };
    const wrongTypeKey = BOOLEAN_KEYS.filter(isCoreFeatureFlagKey).find(
      (key) => key !== GUEST,
    );
    if (!wrongTypeKey) throw new Error('No second boolean flag');
    ld.values[wrongTypeKey] = 'yes';
    const { service } = newService();
    const snapshot = await service.initialize();

    expect(snapshot.status).toBe('ready');
    expect(snapshot.initialized).toBe(true);
    expect(snapshot.values[GUEST]).toBe(!UNAVAILABLE_DEFAULTS[GUEST]);
    expect(snapshot.values[wrongTypeKey]).toBe(
      UNAVAILABLE_DEFAULTS[wrongTypeKey],
    );
    expect(service.getLiveBooleanValue(wrongTypeKey)).toBeUndefined();
    await service.dispose();
  });

  it('keeps the last live values through a later outage', async () => {
    configureLaunchDarkly(true);
    // A live value unlike both defaults, so a reset to either is visible.
    const distinctKey = BOOLEAN_KEYS.find(
      (key) =>
        key !== GUEST && DISABLED_DEFAULTS[key] === UNAVAILABLE_DEFAULTS[key],
    );
    if (!distinctKey) throw new Error('No flag with equal defaults');
    ld.values = {
      [GUEST]: !UNAVAILABLE_DEFAULTS[GUEST],
      [distinctKey]: !UNAVAILABLE_DEFAULTS[distinctKey],
    };
    const { service, diagnostics } = newService();
    const live = await service.initialize();
    expect(live.status).toBe('ready');
    ld.identify = 'fail';
    const snapshot = await service.refreshContext();

    expect(snapshot.status).toBe('error');
    expect(snapshot.values).toEqual(live.values);
    expect(snapshot.values[distinctKey]).not.toBe(
      DISABLED_DEFAULTS[distinctKey],
    );
    expect(diagnostics.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'feature_flags_unavailable',
        featureFlagValuesSource: 'last_live',
      }),
    );
    await service.dispose();
  });

  it('serves local-only defaults even with a client-side ID', async () => {
    localOnly = true;
    configureLaunchDarkly(true);
    ld.values = Object.fromEntries(BOOLEAN_KEYS.map((key) => [key, true]));
    const { service } = newService();
    const snapshot = await service.initialize();

    expect(snapshot.values).toEqual(getLocalOnlyClientFeatureFlagDefaults());
    expect(snapshot.values).toMatchSnapshot('local-only defaults');
    expect(snapshot.status).toBe('not_configured');
    await service.dispose();
  });
});

describe('client input never reaches main evaluation', () => {
  it('ignores forged values on every feature-flags channel and pushes only main state', async () => {
    configureLaunchDarkly(true);
    ld.start = 'fail';
    jest
      .spyOn(BrowserWindow, 'getAllWindows')
      .mockReturnValue([new BrowserWindow()]);
    const { registerFeatureFlagHandlers } =
      await import('../ipc/feature-flags');
    registerFeatureFlagHandlers(() => null);
    const service = getFeatureFlagService();
    await service.initialize();
    const forged = forgedClientSnapshot();

    const beforeRead = service.getSnapshot();
    pushed.length = 0;
    const read = await handlers.get(IPC_CHANNELS.featureFlagsGetSnapshot)?.(
      { sender: { id: 1 } },
      forged,
    );
    expect(read).toEqual(beforeRead);
    expect(service.getSnapshot()).toEqual(beforeRead);
    // A read answers the caller only; it never broadcasts.
    expect(pushed).toEqual([]);
    const emitted: FeatureFlagSnapshot[] = [];
    const stopRecording = service.onSnapshotChanged((snapshot) =>
      emitted.push(snapshot),
    );
    const refreshed = await handlers.get(
      IPC_CHANNELS.featureFlagsRefreshContext,
    )?.({ sender: { id: 1 } }, forged);
    stopRecording();
    const afterRefresh = service.getSnapshot();

    expect(handlers.has(IPC_CHANNELS.featureFlagsSnapshotChanged)).toBe(false);
    expect(refreshed).toEqual(afterRefresh);
    expect(afterRefresh).toEqual(
      expect.objectContaining({
        status: 'error',
        error: 'LaunchDarkly unreachable',
        values: UNAVAILABLE_DEFAULTS,
      }),
    );
    expect(service.isEnabled(GUEST)).toBe(UNAVAILABLE_DEFAULTS[GUEST] === true);
    // Every refresh broadcast, in order, is main's own snapshot at that step;
    // the renderer applies each one, so intermediate pushes count too.
    for (const { channel } of pushed) {
      expect(channel).toBe(IPC_CHANNELS.featureFlagsSnapshotChanged);
    }
    expect(pushed.map(({ payload }) => payload)).toEqual(emitted);
    expect(
      emitted.map(({ status, error, values }) => ({ status, error, values })),
    ).toEqual([
      { status: 'initializing', error: null, values: UNAVAILABLE_DEFAULTS },
      {
        status: 'error',
        error: 'LaunchDarkly unreachable',
        values: UNAVAILABLE_DEFAULTS,
      },
    ]);
    expect(emitted.at(-1)).toEqual(afterRefresh);
  });
});

describe('the guest-mode gate in Electron main', () => {
  const guestAccount = { authMode: 'guest', credentialSource: 'guest' };

  async function disconnectWith(
    configured: boolean,
  ): Promise<{ minted: number; account: unknown }> {
    configureLaunchDarkly(configured);
    ld.start = 'fail';
    await getFeatureFlagService().initialize();
    const { getCanopyCloudAccountFilePath, getDataDir } =
      await import('../lib/paths');
    expect(realpathSync(getDataDir())).toBe(ISOLATED_DIRS.CANOPY_DATA_DIR);
    // Separator-neutral: native paths on Windows use backslashes.
    const accountFromRoot = relative(
      suiteRoot,
      getCanopyCloudAccountFilePath(),
    );
    expect(
      accountFromRoot.startsWith('..') || isAbsolute(accountFromRoot),
    ).toBe(false);
    const { writePreferencesFile } = await import('../lib/preferences-store');
    await writePreferencesFile({
      legalConsentAcceptedAt: '2026-01-01T00:00:00.000Z',
    });
    mintGuest.mockResolvedValue({
      status: { capabilities: [] },
      account: guestAccount,
    });
    const { disconnectCanopyCloudAccount } = await import('../ipc/settings');
    const account = await disconnectCanopyCloudAccount();
    return { minted: mintGuest.mock.calls.length, account };
  }

  it('stays closed when LaunchDarkly is configured but unavailable, whatever the client believes', async () => {
    expect(UNAVAILABLE_DEFAULTS[GUEST]).toBe(false);
    const { toPublicCanopyCloudAccountState } =
      await import('../lib/canopy-cloud-account-store');
    expect(await disconnectWith(true)).toEqual({
      minted: 0,
      account: toPublicCanopyCloudAccountState(null),
    });
  });

  it('opens on the unconfigured default and restores a guest session', async () => {
    expect(DISABLED_DEFAULTS[GUEST]).toBe(true);
    const result = await disconnectWith(false);
    expect(result.minted).toBe(1);
    expect(result.account).toBe(guestAccount);
  });
});
