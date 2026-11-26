// Equivalence golden for the native effects of a preferences save (CAN-4474):
// keep-awake, close-to-tray, the activation schedule, the focus shortcut and
// the default browser. It mocks the host modules beneath the ports (plus the
// store and broadcast), never the ports, so it runs unchanged before and after
// those effects move behind host ports.

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp', on: jest.fn() },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
  nativeTheme: { themeSource: 'system' },
  shell: { openPath: jest.fn() },
}));

jest.mock('../../lib/native-crash-policy', () => ({
  nativeCrashAnnotation: {
    suspendForOptOut: jest.fn(),
    resumeAfterOptIn: jest.fn(),
  },
}));

const mockPairedBridgeSenderId = 99;
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (
    sender: { id?: number } | undefined,
  ): string | null =>
    sender?.id === mockPairedBridgeSenderId ? 'paired-computer' : null,
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mockHandlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));

// One ordered record of every native effect, write and broadcast.
const mockEvents: string[] = [];

const mockStore: {
  preferences: PreferencesData;
  commits: Array<Partial<PreferencesData>>;
  directWrites: Array<Partial<PreferencesData>>;
  failDirectWrite: boolean;
} = {
  preferences: DEFAULT_PREFERENCES,
  commits: [],
  directWrites: [],
  failDirectWrite: false,
};
jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../../lib/preferences-store',
  ),
  arePreferencesUnconfirmed: (): boolean => false,
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: (): Promise<PreferencesData> =>
    Promise.resolve({ ...mockStore.preferences }),
  readLatestPreferencesFile: (): Promise<PreferencesData> =>
    Promise.resolve({ ...mockStore.preferences }),
  // The save's serialized commit: the updater sees the stored preferences.
  updatePreferencesFileWithPrevious: (
    updater: (latest: PreferencesData) => Partial<PreferencesData>,
    onCommitted?: (committed: PreferencesData) => void,
  ): Promise<{ previous: PreferencesData; next: PreferencesData }> => {
    const previous = { ...mockStore.preferences };
    const patch = updater(previous);
    mockStore.commits.push(patch);
    mockStore.preferences = { ...previous, ...patch };
    mockEvents.push('commit');
    onCommitted?.(mockStore.preferences);
    return Promise.resolve({ previous, next: { ...mockStore.preferences } });
  },
  // Every other writer: the shortcut's corrective write and the telemetry
  // opt-in.
  updatePreferencesFile: async (
    updater: (
      latest: PreferencesData,
    ) => Partial<PreferencesData> | Promise<Partial<PreferencesData>>,
    onCommitted?: (committed: PreferencesData) => void,
  ): Promise<PreferencesData> => {
    if (mockStore.failDirectWrite) {
      mockEvents.push('write:failed');
      throw new Error('disk full');
    }
    const patch = await updater({ ...mockStore.preferences });
    mockStore.directWrites.push(patch);
    mockStore.preferences = { ...mockStore.preferences, ...patch };
    mockEvents.push('write');
    onCommitted?.(mockStore.preferences);
    return { ...mockStore.preferences };
  },
}));

jest.mock('../../lib/preferences-broadcast', () => ({
  ...jest.requireActual<typeof PreferencesBroadcastModule>(
    '../../lib/preferences-broadcast',
  ),
  broadcastPreferencesSynced: (preferences: {
    globalFocusShortcut?: string;
  }): void => {
    mockEvents.push(`broadcast:${preferences.globalFocusShortcut ?? ''}`);
  },
  broadcastPreferencesChanged: jest.fn(),
}));

const mockKeepAwake = { setEnabled: jest.fn() };
jest.mock('../../power/wake-lock-service', () => ({
  ...jest.requireActual<typeof WakeLockServiceModule>(
    '../../power/wake-lock-service',
  ),
  getWakeLockService: (): typeof mockKeepAwake => mockKeepAwake,
}));

const mockTray = { created: true };
jest.mock('../../lifecycle/background-presence', () => ({
  ...jest.requireActual<typeof BackgroundPresenceModule>(
    '../../lifecycle/background-presence',
  ),
  setCloseToTrayPreference: (enabled: boolean): void => {
    mockEvents.push(`tray:closeToTray:${String(enabled)}`);
  },
  syncActivationTray: (): boolean => {
    mockEvents.push('tray:sync');
    return mockTray.created;
  },
}));

jest.mock('../../notifications/campaigns/scheduler', () => ({
  ...jest.requireActual<typeof SchedulerModule>(
    '../../notifications/campaigns/scheduler',
  ),
  requestActivationRecompute: (): void => {
    mockEvents.push('schedule:recompute');
  },
}));

interface ShortcutConfig {
  enabled: boolean;
  accelerator: string;
}
interface MockShortcutService {
  apply: jest.Mock<{ ok: boolean }, [ShortcutConfig]>;
  getActiveAccelerator: jest.Mock<string | null, []>;
}
const mockShortcut: { service: MockShortcutService | null } = {
  service: null,
};
jest.mock('../../lifecycle/global-focus-shortcut', () => ({
  ...jest.requireActual<typeof GlobalFocusShortcutModule>(
    '../../lifecycle/global-focus-shortcut',
  ),
  tryGetGlobalFocusShortcutService: (): MockShortcutService | null =>
    mockShortcut.service,
}));

interface BrowserRequest {
  enabled: boolean;
  promptForWindowsSettings?: boolean;
}
interface MockDefaultBrowserService {
  apply: jest.Mock<Promise<unknown>, [BrowserRequest]>;
}
const mockBrowser: { service: MockDefaultBrowserService | null } = {
  service: null,
};
jest.mock('../../browser/default-browser-registration', () => ({
  ...jest.requireActual<typeof DefaultBrowserRegistrationModule>(
    '../../browser/default-browser-registration',
  ),
  getDefaultBrowserRegistrationService: (): MockDefaultBrowserService => {
    if (mockBrowser.service === null) {
      throw new Error(
        'Default browser registration service is not initialized',
      );
    }
    return mockBrowser.service;
  },
}));

jest.mock('../../lib/data-sharing-opt-in-authority', () => ({
  ...jest.requireActual<typeof DataSharingOptInAuthorityModule>(
    '../../lib/data-sharing-opt-in-authority',
  ),
  requireDataSharingPersonalOptInAuthority: (): Promise<void> =>
    Promise.resolve(),
}));

jest.mock('../../canopy-runtime/pipeline-definition-dispatch', () => ({
  setPipelineDefinitionEnabled: (
    id: string,
    enabled: boolean,
  ): Promise<PreferencesData> => {
    mockStore.preferences = {
      ...mockStore.preferences,
      disabledPipelineIds: enabled ? [] : [id],
    };
    return Promise.resolve({ ...mockStore.preferences });
  },
}));

import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import {
  IPC_CHANNELS,
  type PreferencesData,
  type PreferencesSavePatch,
} from '@canopy/desktop-shared/types';
import type * as PreferencesStoreModule from '../../lib/preferences-store';
import type * as PreferencesBroadcastModule from '../../lib/preferences-broadcast';
import type * as WakeLockServiceModule from '../../power/wake-lock-service';
import type * as BackgroundPresenceModule from '../../lifecycle/background-presence';
import type * as SchedulerModule from '../../notifications/campaigns/scheduler';
import type * as GlobalFocusShortcutModule from '../../lifecycle/global-focus-shortcut';
import type * as DefaultBrowserRegistrationModule from '../../browser/default-browser-registration';
import type * as DataSharingOptInAuthorityModule from '../../lib/data-sharing-opt-in-authority';
import {
  registerPreferenceHandlers,
  savePreferencesPatch,
} from '../preferences';

const SAVED_CHORD = 'CommandOrControl+Shift+Space';
const ACCEPTED_CHORD = 'CommandOrControl+Alt+F12';
const REFUSED_CHORD = 'CommandOrControl+Alt+F13';

const localWindow = { sender: { id: 1 } };
const pairedComputer = { sender: { id: mockPairedBridgeSenderId } };

function handler(channel: string): Handler {
  const registered = mockHandlers.get(channel);
  if (!registered) throw new Error(`${channel} is not registered`);
  return registered;
}

function saveFromWindow(patch: PreferencesSavePatch): Promise<unknown> {
  return handler(IPC_CHANNELS.preferencesSave)(localWindow, patch);
}

function eventsMatching(prefix: string): string[] {
  return mockEvents.filter((event) => event.startsWith(prefix));
}

function deferred(): { promise: Promise<unknown>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<unknown>((onResolve) => {
    resolve = (): void => onResolve(undefined);
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  mockStore.preferences = {
    ...DEFAULT_PREFERENCES,
    keepSystemAwakeWhileAgentsActive: true,
    closeToTray: true,
    globalFocusShortcutEnabled: true,
    globalFocusShortcut: SAVED_CHORD,
    useAsSystemDefaultBrowser: false,
  };
  mockStore.commits = [];
  mockStore.directWrites = [];
  mockStore.failDirectWrite = false;
  mockEvents.length = 0;
  mockKeepAwake.setEnabled.mockReset();
  mockTray.created = true;
  mockShortcut.service = {
    apply: jest.fn<{ ok: boolean }, [ShortcutConfig]>(() => ({ ok: true })),
    getActiveAccelerator: jest.fn((): string | null => SAVED_CHORD),
  };
  mockBrowser.service = {
    apply: jest.fn<Promise<unknown>, [BrowserRequest]>(() => {
      mockEvents.push('browser:apply');
      return Promise.resolve({ registered: true });
    }),
  };
  mockHandlers.clear();
  registerPreferenceHandlers();
});

describe('keep-awake and close-to-tray follow every save', () => {
  it('a client-local key alone still applies both, from the window and from main', async () => {
    await saveFromWindow({ sidebarWidth: 320 });
    expect(mockKeepAwake.setEnabled.mock.calls).toEqual([[true]]);
    expect(eventsMatching('tray:')).toEqual([
      'tray:closeToTray:true',
      'tray:sync',
    ]);

    mockStore.preferences = {
      ...mockStore.preferences,
      keepSystemAwakeWhileAgentsActive: false,
      closeToTray: false,
    };
    await savePreferencesPatch({ sidebarWidth: 300 });
    expect(mockKeepAwake.setEnabled.mock.calls).toEqual([[true], [false]]);
    expect(eventsMatching('tray:').slice(2)).toEqual([
      'tray:closeToTray:false',
      'tray:sync',
    ]);
  });

  it('the saved values reach both effects', async () => {
    await saveFromWindow({
      keepSystemAwakeWhileAgentsActive: false,
      closeToTray: false,
    });
    expect(mockKeepAwake.setEnabled.mock.calls).toEqual([[false]]);
    expect(eventsMatching('tray:')).toEqual([
      'tray:closeToTray:false',
      'tray:sync',
    ]);
  });

  it('a tray that cannot be created turns close-to-tray off in memory only', async () => {
    mockTray.created = false;
    await saveFromWindow({ closeToTray: true });
    expect(eventsMatching('tray:')).toEqual([
      'tray:closeToTray:true',
      'tray:sync',
      'tray:closeToTray:false',
    ]);
    expect(mockStore.commits).toEqual([{ closeToTray: true }]);
    expect(mockStore.directWrites).toEqual([]);
    expect(mockStore.preferences.closeToTray).toBe(true);
    expect(eventsMatching('broadcast:')).toHaveLength(1);
  });
});

describe('the activation schedule re-arms only for notification inputs', () => {
  it.each<[string, PreferencesSavePatch]>([
    [
      'osNotifications',
      {
        osNotifications: {
          ...DEFAULT_PREFERENCES.osNotifications,
          enabled: true,
        },
      },
    ],
    [
      'activationQuietHours',
      { activationQuietHours: DEFAULT_PREFERENCES.activationQuietHours },
    ],
    [
      'promotionalNotifications',
      {
        promotionalNotifications: DEFAULT_PREFERENCES.promotionalNotifications,
      },
    ],
  ])('%s causes exactly one recompute', async (_key, patch) => {
    await saveFromWindow(patch);
    expect(eventsMatching('schedule:')).toEqual(['schedule:recompute']);
  });

  it('other keys cause none', async () => {
    await saveFromWindow({ sidebarWidth: 320, closeToTray: false });
    expect(eventsMatching('schedule:')).toEqual([]);
  });
});

describe('the focus shortcut re-syncs after a plain save', () => {
  it('an accepted chord writes nothing more', async () => {
    await saveFromWindow({ globalFocusShortcut: ACCEPTED_CHORD });
    expect(mockShortcut.service?.apply.mock.calls).toEqual([
      [{ enabled: true, accelerator: ACCEPTED_CHORD }],
    ]);
    expect(mockStore.directWrites).toEqual([]);
    expect(eventsMatching('broadcast:')).toEqual([
      `broadcast:${ACCEPTED_CHORD}`,
    ]);
  });

  it('a refused chord writes the working one back, broadcasts it after the save, then re-applies it', async () => {
    const service = mockShortcut.service;
    if (!service) throw new Error('no shortcut service');
    service.apply.mockImplementation((config) => {
      mockEvents.push(`shortcut:apply:${config.accelerator}`);
      return { ok: config.accelerator !== REFUSED_CHORD };
    });
    await saveFromWindow({ globalFocusShortcut: REFUSED_CHORD });
    expect(mockStore.directWrites).toEqual([
      { globalFocusShortcut: SAVED_CHORD },
    ]);
    expect(mockStore.preferences.globalFocusShortcut).toBe(SAVED_CHORD);
    expect(
      mockEvents.filter(
        (event) =>
          event.startsWith('broadcast:') ||
          event.startsWith('shortcut:') ||
          event === 'write',
      ),
    ).toEqual([
      `broadcast:${REFUSED_CHORD}`,
      `shortcut:apply:${REFUSED_CHORD}`,
      'write',
      `broadcast:${SAVED_CHORD}`,
      `shortcut:apply:${SAVED_CHORD}`,
    ]);
  });

  it('a refused chord with nothing else registered writes nothing', async () => {
    const service = mockShortcut.service;
    if (!service) throw new Error('no shortcut service');
    service.apply.mockReturnValue({ ok: false });
    service.getActiveAccelerator.mockReturnValue(null);
    await saveFromWindow({ globalFocusShortcutEnabled: true });
    expect(service.apply).toHaveBeenCalledTimes(1);
    expect(mockStore.directWrites).toEqual([]);
  });

  it('before the shortcut service exists, nothing happens', async () => {
    mockShortcut.service = null;
    await expect(
      saveFromWindow({ globalFocusShortcut: REFUSED_CHORD }),
    ).resolves.toBeDefined();
    expect(mockStore.directWrites).toEqual([]);
    expect(eventsMatching('broadcast:')).toHaveLength(1);
  });

  it('a failed corrective write still resolves the committed save', async () => {
    const service = mockShortcut.service;
    if (!service) throw new Error('no shortcut service');
    service.apply.mockImplementation((config) => ({
      ok: config.accelerator !== REFUSED_CHORD,
    }));
    mockStore.failDirectWrite = true;
    await expect(
      saveFromWindow({ globalFocusShortcut: REFUSED_CHORD }),
    ).resolves.toBeDefined();
    expect(mockEvents).toContain('write:failed');
    expect(service.apply).toHaveBeenCalledTimes(1);
  });

  it('keys other than the shortcut leave it alone', async () => {
    await saveFromWindow({ sidebarWidth: 320 });
    expect(mockShortcut.service?.apply).not.toHaveBeenCalled();
  });
});

describe('the default browser registers in commit order', () => {
  it('is requested inside the commit, before the first broadcast', async () => {
    await saveFromWindow({ useAsSystemDefaultBrowser: true });
    expect(mockBrowser.service?.apply.mock.calls).toEqual([
      [{ enabled: true, promptForWindowsSettings: true }],
    ]);
    const order = mockEvents.filter(
      (event) =>
        event === 'commit' ||
        event === 'browser:apply' ||
        event.startsWith('broadcast:'),
    );
    expect(order).toEqual([
      'commit',
      'browser:apply',
      `broadcast:${SAVED_CHORD}`,
    ]);
  });

  it('turning it off never prompts', async () => {
    await saveFromWindow({ useAsSystemDefaultBrowser: false });
    expect(mockBrowser.service?.apply.mock.calls).toEqual([
      [{ enabled: false, promptForWindowsSettings: false }],
    ]);
  });

  it('overlapping saves register one at a time in commit order, and each save waits for its own', async () => {
    const service = mockBrowser.service;
    if (!service) throw new Error('no default browser service');
    const first = deferred();
    service.apply
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => Promise.resolve({ registered: false }));
    let firstSettled = false;
    const firstSave = saveFromWindow({ useAsSystemDefaultBrowser: true }).then(
      (result) => {
        firstSettled = true;
        return result;
      },
    );
    const secondSave = saveFromWindow({ useAsSystemDefaultBrowser: false });
    await settle();
    expect(mockStore.commits).toEqual([
      { useAsSystemDefaultBrowser: true },
      { useAsSystemDefaultBrowser: false },
    ]);
    expect(service.apply.mock.calls).toEqual([
      [{ enabled: true, promptForWindowsSettings: true }],
    ]);
    expect(firstSettled).toBe(false);

    first.resolve();
    await Promise.all([firstSave, secondSave]);
    expect(service.apply.mock.calls).toEqual([
      [{ enabled: true, promptForWindowsSettings: true }],
      [{ enabled: false, promptForWindowsSettings: false }],
    ]);
  });

  it('a refused registration still lets the next overlapping one apply', async () => {
    const service = mockBrowser.service;
    if (!service) throw new Error('no default browser service');
    let refuseFirst = (): void => undefined;
    service.apply
      .mockImplementationOnce(
        () =>
          new Promise<unknown>((_resolve, reject) => {
            refuseFirst = (): void => reject(new Error('refused'));
          }),
      )
      .mockImplementationOnce(() => Promise.resolve({ registered: false }));
    const firstSave = saveFromWindow({ useAsSystemDefaultBrowser: true });
    const secondSave = saveFromWindow({ useAsSystemDefaultBrowser: false });
    await settle();
    expect(service.apply).toHaveBeenCalledTimes(1);

    refuseFirst();
    await expect(Promise.all([firstSave, secondSave])).resolves.toHaveLength(2);
    expect(mockStore.preferences.useAsSystemDefaultBrowser).toBe(false);
    expect(service.apply.mock.calls).toEqual([
      [{ enabled: true, promptForWindowsSettings: true }],
      [{ enabled: false, promptForWindowsSettings: false }],
    ]);
  });

  it('a refused registration keeps the committed save', async () => {
    mockBrowser.service?.apply.mockImplementation(() =>
      Promise.reject(new Error('refused')),
    );
    await expect(
      saveFromWindow({ useAsSystemDefaultBrowser: true }),
    ).resolves.toMatchObject({ useAsSystemDefaultBrowser: true });
    expect(mockStore.preferences.useAsSystemDefaultBrowser).toBe(true);
  });

  it('before the registration service exists, the save still resolves', async () => {
    mockBrowser.service = null;
    await expect(
      saveFromWindow({ useAsSystemDefaultBrowser: true }),
    ).resolves.toMatchObject({ useAsSystemDefaultBrowser: true });
  });

  it('keys other than the default browser leave it alone', async () => {
    await saveFromWindow({ sidebarWidth: 320 });
    expect(mockBrowser.service?.apply).not.toHaveBeenCalled();
  });
});

describe('other saves that apply preference effects', () => {
  it('the telemetry opt-in applies keep-awake and close-to-tray only', async () => {
    mockShortcut.service?.apply.mockClear();
    const result = await handler(IPC_CHANNELS.telemetrySharingEnableForFeature)(
      localWindow,
      { feature: 'shared-projects', organizationId: null },
    );
    expect(result).toMatchObject({ status: 'saved' });
    expect(mockKeepAwake.setEnabled.mock.calls).toEqual([[true]]);
    expect(eventsMatching('tray:')).toEqual([
      'tray:closeToTray:true',
      'tray:sync',
    ]);
    expect(eventsMatching('schedule:')).toEqual([]);
    expect(mockShortcut.service?.apply).not.toHaveBeenCalled();
    expect(mockBrowser.service?.apply).not.toHaveBeenCalled();
  });

  it('disabling a pipeline applies keep-awake and close-to-tray only', async () => {
    await handler(IPC_CHANNELS.preferencesSetPipelineDisabled)(localWindow, {
      id: 'nightly-review',
      disabled: true,
    });
    expect(mockStore.preferences.disabledPipelineIds).toEqual([
      'nightly-review',
    ]);
    expect(mockKeepAwake.setEnabled.mock.calls).toEqual([[true]]);
    expect(eventsMatching('tray:')).toEqual([
      'tray:closeToTray:true',
      'tray:sync',
    ]);
    expect(eventsMatching('schedule:')).toEqual([]);
    expect(mockShortcut.service?.apply).not.toHaveBeenCalled();
    expect(mockBrowser.service?.apply).not.toHaveBeenCalled();
  });

  it("a paired computer's save drives this computer's effects", async () => {
    await handler(IPC_CHANNELS.preferencesSave)(pairedComputer, {
      keepSystemAwakeWhileAgentsActive: false,
      useAsSystemDefaultBrowser: true,
      promotionalNotifications: DEFAULT_PREFERENCES.promotionalNotifications,
      globalFocusShortcutEnabled: false,
    });
    expect(mockKeepAwake.setEnabled.mock.calls).toEqual([[false]]);
    expect(eventsMatching('tray:')).toEqual([
      'tray:closeToTray:true',
      'tray:sync',
    ]);
    expect(eventsMatching('schedule:')).toEqual(['schedule:recompute']);
    expect(mockShortcut.service?.apply.mock.calls).toEqual([
      [{ enabled: false, accelerator: SAVED_CHORD }],
    ]);
    expect(mockBrowser.service?.apply.mock.calls).toEqual([
      [{ enabled: true, promptForWindowsSettings: true }],
    ]);
  });
});
