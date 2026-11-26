/**
 * Remote pickers show a managed provider that has no model rows, with the
 * reason it isn't ready, instead of leaving it out (CAN-6718). The desktop
 * projects one setup state per provider on `providerAvailability.setup`,
 * from cheap reads that never launch a provider; the shared pickers turn it
 * into one sentence; the web reads it back without trusting unknown values.
 */
import { readRemoteControlProviderSetupStatuses } from '@canopy/protocol/remote-control/shell';
import { modelPickerHarnessSetupReason } from '@canopy/ui-shared/components/modelPickerHarnessSetup';

const mockFlags = {
  antigravity: true,
  cursor: true,
  copilot: true,
  opencode: false,
};
jest.mock('../../antigravity/feature-flag', () => ({
  isAntigravityHarnessEnabled: (): boolean => mockFlags.antigravity,
}));
jest.mock('../../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => mockFlags.cursor,
}));
jest.mock('../../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: (): boolean => mockFlags.copilot,
}));
jest.mock('../../opencode/feature-flag', () => ({
  isOpenCodeHarnessEnabled: (): boolean => mockFlags.opencode,
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

const mockAntigravity: {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  /** Holds the next status read until released. */
  gate: Promise<void> | null;
} = { supported: true, installed: false, enabled: true, gate: null };
const mockStatusReads = jest.fn();
jest.mock('../../antigravity/connection', () => ({
  antigravityRuntimeStatus: async (): Promise<object> => {
    mockStatusReads();
    if (mockAntigravity.gate) await mockAntigravity.gate;
    return {
      supported: mockAntigravity.supported,
      installed: mockAntigravity.installed,
      managed: false,
      version: '1.5.1',
      phase: 'idle',
    };
  },
  isAntigravityConnectionEnabled: (): Promise<boolean> =>
    Promise.resolve(mockAntigravity.enabled),
}));
// Linux and macOS pin an Antigravity CLI; Windows doesn't.
let mockAntigravityPinned = true;
jest.mock('@canopy/desktop-shared/node/antigravity/runtime-artifacts', () => ({
  getAntigravityRuntimeArtifact: (): object | undefined =>
    mockAntigravityPinned ? { version: '1.5.1' } : undefined,
}));
// This host has no pinned Cursor runtime; Copilot has one.
jest.mock('@canopy/desktop-shared/node/cursor/runtime-metadata', () => ({
  getCursorRuntimeArtifact: (): undefined => undefined,
}));
const mockCursorStatus = jest.fn();
jest.mock('../../cursor/runtime-status', () => ({
  cursorConnectionStatus: (): unknown => mockCursorStatus(),
}));
jest.mock('@canopy/desktop-shared/node/copilot/runtime-metadata', () => ({
  getCopilotRuntimeArtifact: (): object => ({ archiveBytes: 1 }),
}));
const mockOpenCodeArtifact = jest.fn();
jest.mock('@canopy/desktop-shared/node/opencode/runtime-metadata', () => ({
  getOpenCodeRuntimeArtifact: (): unknown => mockOpenCodeArtifact(),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<object> =>
    Promise.resolve({ copilotEnabled: false }),
}));
const mockNotify = jest.fn(() => Promise.resolve());
const mockCatalogListeners: Array<() => Promise<void>> = [];
jest.mock('../agent-catalog-compatibility', () => ({
  notifyModelCatalogChanged: (): Promise<void> => mockNotify(),
  onModelCatalogChanged: (listener: () => Promise<void>): (() => void) => {
    mockCatalogListeners.push(listener);
    return () => undefined;
  },
}));

const mockRegistryBroadcast = jest.fn<void, []>();
jest.mock('../../models/model-registry', () => ({
  broadcastModelRegistryUpdated: (): void => mockRegistryBroadcast(),
}));

import { subscribeDesktopSessionSnapshotInvalidation } from '../../services/desktop-session-snapshot-invalidation';
import {
  deriveProviderSetupState,
  peekProviderSetupFacts,
  isProviderSetupWatched,
  peekRemoteControlProviderSetup,
  primeProviderSetupFacts,
  providerSetupForDestination,
  refreshProviderSetupFacts,
  resetProviderSetupFactsForTesting,
} from '../provider-setup-status';

beforeEach(() => {
  resetProviderSetupFactsForTesting();
  mockNotify.mockClear();
  mockCursorStatus.mockClear();
  mockOpenCodeArtifact.mockClear();
  mockCatalogListeners.length = 0;
  mockAntigravity.installed = false;
  mockAntigravity.gate = null;
  mockAntigravityPinned = true;
  mockStatusReads.mockClear();
  mockRegistryBroadcast.mockClear();
});

/** Every session-stale push (the one remote controllers re-project on). */
function recordStalePushes(): {
  count: () => number;
  settle: () => Promise<void>;
  stop: () => void;
} {
  let pushes = 0;
  const stop = subscribeDesktopSessionSnapshotInvalidation((): void => {
    pushes += 1;
  });
  return {
    count: (): number => pushes,
    // The invalidation is throttled; wait out its window.
    settle: (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 80)),
    stop,
  };
}

describe('provider setup state', () => {
  it('names the most specific reason first', () => {
    const derive = (
      facts: Parameters<typeof deriveProviderSetupState>[0]['facts'],
      available?: boolean,
      flagEnabled = true,
    ): ReturnType<typeof deriveProviderSetupState> =>
      deriveProviderSetupState({ flagEnabled, available, facts });
    expect(derive({ supported: true }, true, false)).toBe('flag_off');
    expect(derive({ supported: false, installed: false }, false)).toBe(
      'unsupported_host',
    );
    expect(derive({ supported: true, installed: true }, true)).toBe('ready');
    expect(derive({ supported: true, installed: false, enabled: false })).toBe(
      'not_installed',
    );
    expect(derive({ supported: true, installed: true, enabled: false })).toBe(
      'disabled',
    );
    expect(
      derive({ supported: true, installed: true, enabled: true }, false),
    ).toBe('unavailable');
    // Nothing checked yet says nothing.
    expect(derive(undefined)).toBeUndefined();
    expect(derive(undefined, true)).toBe('ready');
  });

  it('projects what it knows at once and reads the rest in the background, without launching a provider', async () => {
    // Cold: only the flags and availability are known.
    expect(peekRemoteControlProviderSetup({ antigravity: false })).toEqual({
      antigravity: 'unavailable',
      opencode: 'flag_off',
    });
    await refreshProviderSetupFacts();
    expect(
      peekRemoteControlProviderSetup({ antigravity: false, copilot: false }),
    ).toEqual({
      antigravity: 'not_installed',
      cursor: 'unsupported_host',
      copilot: 'disabled',
      opencode: 'flag_off',
    });
    // An unsupported Cursor host never reaches the install check, and an
    // unreleased provider is never read.
    expect(mockCursorStatus).not.toHaveBeenCalled();
    expect(mockOpenCodeArtifact).not.toHaveBeenCalled();
    expect(peekProviderSetupFacts('cursor')).toEqual({ supported: false });
  });

  it('pushes a fresh projection to controllers only when an answer changes, and rereads after a catalog change', async () => {
    const stale = recordStalePushes();
    try {
      await refreshProviderSetupFacts();
      await stale.settle();
      expect(stale.count()).toBe(1);
      expect(mockRegistryBroadcast).toHaveBeenCalledTimes(1);
      await refreshProviderSetupFacts();
      await stale.settle();
      expect(stale.count()).toBe(1);
      mockAntigravity.installed = true;
      await Promise.all(mockCatalogListeners.map((listener) => listener()));
      // The next projection starts a read because the catalog changed.
      peekRemoteControlProviderSetup({});
      await refreshProviderSetupFacts();
      await stale.settle();
      expect(stale.count()).toBe(2);
      expect(mockRegistryBroadcast).toHaveBeenCalledTimes(2);
      expect(
        peekRemoteControlProviderSetup({ antigravity: true }).antigravity,
      ).toBe('ready');
    } finally {
      stale.stop();
    }
  });

  it('a fresh refresh reads the host as it is now, even while an older read runs', async () => {
    let release: () => void = () => undefined;
    mockAntigravity.gate = new Promise((resolve) => {
      release = resolve;
    });
    const older = refreshProviderSetupFacts();
    // The older read is waiting on its status; the install finishes now.
    mockAntigravity.installed = true;
    const fresh = refreshProviderSetupFacts({ fresh: true });
    release();
    mockAntigravity.gate = null;
    await Promise.all([older, fresh]);
    expect(peekProviderSetupFacts('antigravity')).toMatchObject({
      installed: true,
    });
    expect(mockStatusReads).toHaveBeenCalledTimes(2);
  });

  // CAN-6718 review: projections are read on every desktop, so the facts
  // are read only once a remote session has attached.
  it('reads nothing in the background until a remote session attaches', async () => {
    expect(isProviderSetupWatched()).toBe(false);
    peekRemoteControlProviderSetup({});
    peekRemoteControlProviderSetup({});
    // Long enough for a read's lazy imports and status call to run.
    for (let i = 0; i < 5; i += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(mockStatusReads).not.toHaveBeenCalled();
    await primeProviderSetupFacts();
    // The attach waits only for the manifests; join the read it started.
    await refreshProviderSetupFacts();
    expect(isProviderSetupWatched()).toBe(true);
    expect(mockStatusReads).toHaveBeenCalledTimes(1);
    // A catalog change makes the next projection read again.
    await Promise.all(mockCatalogListeners.map((listener) => listener()));
    peekRemoteControlProviderSetup({});
    await refreshProviderSetupFacts();
    expect(mockStatusReads).toHaveBeenCalledTimes(2);
  });

  // CAN-6718 review: the sign-in dialog's two-second poll announces a
  // catalog change each time; a changed catalog makes the next projection
  // read again, but no sooner than ten seconds after the last read.
  it('rereads after catalog changes at most every ten seconds', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    try {
      await primeProviderSetupFacts();
      await refreshProviderSetupFacts();
      expect(mockStatusReads).toHaveBeenCalledTimes(1);
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 5; i += 1)
          await new Promise((resolve) => setImmediate(resolve));
      };
      for (let poll = 0; poll < 4; poll += 1) {
        jest.advanceTimersByTime(2_000);
        await Promise.all(mockCatalogListeners.map((listener) => listener()));
        peekRemoteControlProviderSetup({});
        await settle();
      }
      expect(mockStatusReads).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(2_000);
      await Promise.all(mockCatalogListeners.map((listener) => listener()));
      peekRemoteControlProviderSetup({});
      await settle();
      expect(mockStatusReads).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  // CAN-6718 review: the first remote projection must not wait for the full
  // read, nor show a provider as connectable on a host without its pin. The
  // attach waits only for the pinned-runtime manifest.
  it('knows from the manifest which providers a host can run before the full read', async () => {
    mockAntigravityPinned = false;
    let release: () => void = () => undefined;
    mockAntigravity.gate = new Promise((resolve) => {
      release = resolve;
    });
    await primeProviderSetupFacts();
    expect(
      peekRemoteControlProviderSetup({ antigravity: false, copilot: false }),
    ).toMatchObject({
      antigravity: 'unsupported_host',
      cursor: 'unsupported_host',
    });
    release();
    mockAntigravity.gate = null;
    await refreshProviderSetupFacts();
  });

  it('reads once when the first remote session attaches, so its first projection is not empty', async () => {
    const stale = recordStalePushes();
    try {
      await primeProviderSetupFacts();
      await stale.settle();
      expect(peekProviderSetupFacts('antigravity')).toBeDefined();
      expect(stale.count()).toBe(1);
      await primeProviderSetupFacts();
      expect(mockStatusReads).toHaveBeenCalledTimes(1);
    } finally {
      stale.stop();
    }
  });
});

// CAN-6718 review: App Advisor and other bot projects can't run Antigravity,
// so their catalogs leave it out; their pickers must not offer its setup.
describe('a destination’s setup map', () => {
  it('gives a destination that leaves Antigravity out no Antigravity reason', () => {
    const setup = { antigravity: 'not_installed', cursor: 'ready' } as const;
    expect(providerSetupForDestination(setup, { antigravity: false })).toEqual({
      cursor: 'ready',
    });
    expect(providerSetupForDestination(setup, { antigravity: true })).toEqual(
      setup,
    );
  });
});

describe('the wire and the pickers', () => {
  it('keeps only known providers and states from the wire', () => {
    expect(
      readRemoteControlProviderSetupStatuses({
        antigravity: 'not_installed',
        cursor: 'unsupported_host',
        copilot: 'some-new-state',
        claude: 'ready',
      }),
    ).toEqual({ antigravity: 'not_installed', cursor: 'unsupported_host' });
    expect(readRemoteControlProviderSetupStatuses(['ready'])).toBeUndefined();
    expect(readRemoteControlProviderSetupStatuses(undefined)).toBeUndefined();
  });

  it('gives each state one sentence for the paired computer and for this one', () => {
    const paired = { kind: 'paired' } as const;
    expect(
      modelPickerHarnessSetupReason('cursor', 'unsupported_host', paired),
    ).toBe(
      "Cursor isn't available for the paired computer's operating system yet.",
    );
    expect(
      modelPickerHarnessSetupReason('cursor', 'unsupported_host', {
        kind: 'local',
        platformName: 'Linux',
      }),
    ).toBe("Cursor isn't available on Linux yet.");
    expect(
      modelPickerHarnessSetupReason('antigravity', 'not_installed', paired),
    ).toBe('Install the Antigravity CLI in Settings on the paired computer.');
    expect(
      modelPickerHarnessSetupReason('antigravity', 'unavailable', paired),
    ).toBe('Connect your personal Google account on the paired computer.');
    expect(modelPickerHarnessSetupReason('copilot', 'disabled', paired)).toBe(
      'Connect GitHub Copilot in Settings on the paired computer.',
    );
  });
});
