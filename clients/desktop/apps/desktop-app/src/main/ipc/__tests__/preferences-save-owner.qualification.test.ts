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

// A save the remote bridge replays for a paired computer comes from this
// sender; every other sender is a window on this computer.
const mockPairedBridgeSenderId = 99;
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (
    sender: { id?: number } | undefined,
  ): string | null =>
    sender?.id === mockPairedBridgeSenderId ? 'paired-computer' : null,
}));

const mockReleaseFlavor: { value: 'stable' | 'rc' | 'internal' } = {
  value: 'stable',
};
jest.mock('../../lib/app-identity', () => ({
  ...jest.requireActual<typeof AppIdentityModule>('../../lib/app-identity'),
  getCanopyReleaseFlavor: (): 'stable' | 'rc' | 'internal' =>
    mockReleaseFlavor.value,
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mockHandlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));

const mockStore: {
  preferences: PreferencesData;
  commits: Array<Partial<PreferencesData>>;
  unconfirmed: boolean;
} = {
  preferences: DEFAULT_PREFERENCES,
  commits: [],
  unconfirmed: false,
};
jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../../lib/preferences-store',
  ),
  arePreferencesUnconfirmed: (): boolean => mockStore.unconfirmed,
  readPreferencesFile: (): Promise<PreferencesData> =>
    Promise.resolve({ ...mockStore.preferences }),
  readLatestPreferencesFile: (): Promise<PreferencesData> =>
    Promise.resolve({ ...mockStore.preferences }),
  // The repository's serialized commit: the updater sees the stored
  // preferences, and a throw writes nothing.
  updatePreferencesFileWithPrevious: (
    updater: (latest: PreferencesData) => Partial<PreferencesData>,
    onCommitted?: (committed: PreferencesData) => void,
  ): Promise<{ previous: PreferencesData; next: PreferencesData }> => {
    const previous = { ...mockStore.preferences };
    try {
      const patch = updater(previous);
      mockStore.commits.push(patch);
      mockStore.preferences = { ...previous, ...patch };
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    onCommitted?.(mockStore.preferences);
    return Promise.resolve({ previous, next: { ...mockStore.preferences } });
  },
}));

import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import {
  IPC_CHANNELS,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import type * as PreferencesStoreModule from '../../lib/preferences-store';
import type * as AppIdentityModule from '../../lib/app-identity';
import {
  applyOneWindowChoice,
  isOneWindowEnabled,
  onOneWindowEnabledChanged,
} from '../../lib/one-window-switch';
import { nativeCrashAnnotation } from '../../lib/native-crash-policy';
import {
  registerPreferenceHandlers,
  savePreferencesPatch,
} from '../preferences';

beforeEach(() => {
  mockStore.preferences = { ...DEFAULT_PREFERENCES, navigationMode: 'code' };
  mockStore.commits = [];
  mockStore.unconfirmed = false;
  mockReleaseFlavor.value = 'stable';
  mockHandlers.clear();
  registerPreferenceHandlers();
});

describe("the window's preferences save as a shared owner (CAN-6004)", () => {
  it('preferences:save is savePreferencesPatch: the same patch commits and the same preferences come back', async () => {
    const handler = mockHandlers.get(IPC_CHANNELS.preferencesSave);
    if (!handler) throw new Error('preferences:save is not registered');
    const fromWindow = await handler({}, { navigationMode: 'work' });
    expect(mockStore.commits).toEqual([{ navigationMode: 'work' }]);
    expect(fromWindow).toMatchObject({ navigationMode: 'work' });
    const fromMain = await savePreferencesPatch({ navigationMode: 'code' });
    expect(mockStore.commits).toEqual([
      { navigationMode: 'work' },
      { navigationMode: 'code' },
    ]);
    expect(fromMain).toMatchObject({ navigationMode: 'code' });
  });

  it.each([undefined, null])(
    'renderer saves cannot replace a Copilot custody receipt with %s',
    async (replacement) => {
      const receipt: NonNullable<PreferencesData['copilotVaultSelection']> = {
        version: 1,
        identity: {
          operationId: 'setup-operation',
          epoch: 'account-epoch',
          account: { host: 'https://github.com', login: 'pilot', id: '1' },
          origin: 'setup',
        },
        pinGeneration: 'receipt-generation',
        pin: null,
        state: 'prepared',
      };
      mockStore.preferences = {
        ...mockStore.preferences,
        copilotVaultSelection: receipt,
      };
      const handler = mockHandlers.get(IPC_CHANNELS.preferencesSave);
      if (!handler) throw new Error('preferences:save is not registered');
      await handler(
        {},
        {
          navigationMode: 'work',
          copilotVaultSelection: replacement,
        },
      );
      expect(mockStore.commits).toEqual([{ navigationMode: 'work' }]);
      expect(mockStore.preferences.copilotVaultSelection).toEqual(receipt);
    },
  );

  it('clears native crash eligibility before saving opt-out and resumes only after opt-in commits', async () => {
    const suspend = jest.mocked(nativeCrashAnnotation.suspendForOptOut);
    const resume = jest.mocked(nativeCrashAnnotation.resumeAfterOptIn);
    suspend.mockImplementationOnce((): void => {
      expect(mockStore.preferences.usageData.errorReports).toBe(true);
      expect(mockStore.commits).toHaveLength(0);
    });
    await savePreferencesPatch({
      usageData: { ...mockStore.preferences.usageData, errorReports: false },
    });
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();

    resume.mockImplementationOnce((): void => {
      expect(mockStore.preferences.usageData.errorReports).toBe(true);
      expect(mockStore.commits).toHaveLength(2);
    });
    await savePreferencesPatch({
      usageData: { ...mockStore.preferences.usageData, errorReports: true },
    });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('a usage-data toggle merges only its key over the latest denied choices', async () => {
    mockStore.preferences = {
      ...mockStore.preferences,
      usageData: {
        ...mockStore.preferences.usageData,
        productAnalytics: false,
      },
    };
    const handler = mockHandlers.get(IPC_CHANNELS.preferencesSave);
    if (!handler) throw new Error('preferences:save is not registered');
    await handler({}, { usageData: { errorReports: false } });
    expect(mockStore.preferences.usageData.productAnalytics).toBe(false);
    expect(mockStore.preferences.usageData.errorReports).toBe(false);
    expect(mockStore.preferences.usageData.sessionReplay).toBe(true);
  });

  it('a per-key usage-data save cannot clear the host Copilot receipt or lift another denial', async () => {
    const receipt: NonNullable<PreferencesData['copilotVaultSelection']> = {
      version: 1,
      identity: {
        operationId: 'setup-operation',
        epoch: 'account-epoch',
        account: { host: 'https://github.com', login: 'pilot', id: '1' },
        origin: 'setup',
      },
      pinGeneration: 'receipt-generation',
      pin: null,
      state: 'prepared',
    };
    mockStore.preferences = {
      ...mockStore.preferences,
      copilotVaultSelection: receipt,
      usageData: {
        ...mockStore.preferences.usageData,
        productAnalytics: false,
      },
    };
    const handler = mockHandlers.get(IPC_CHANNELS.preferencesSave);
    if (!handler) throw new Error('preferences:save is not registered');
    await handler(
      {},
      {
        copilotVaultSelection: null,
        usageData: { errorReports: false },
      },
    );
    expect(mockStore.commits).toEqual([
      {
        usageData: {
          ...DEFAULT_PREFERENCES.usageData,
          productAnalytics: false,
          errorReports: false,
        },
      },
    ]);
    expect(mockStore.preferences.copilotVaultSelection).toEqual(receipt);
    expect(mockStore.preferences.usageData).toMatchObject({
      productAnalytics: false,
      errorReports: false,
      sessionReplay: true,
    });
  });

  it('a precondition runs inside the commit with the stored preferences, and its refusal writes nothing', async () => {
    const seen: string[] = [];
    await expect(
      savePreferencesPatch({ navigationMode: 'work' }, undefined, (latest) => {
        seen.push(latest.navigationMode);
        throw new Error('The settings changed.');
      }),
    ).rejects.toThrow('The settings changed.');
    expect(seen).toEqual(['code']);
    expect(mockStore.commits).toEqual([]);
    expect(mockStore.preferences.navigationMode).toBe('code');
  });
});

describe("this computer's one-window switch (CAN-7755)", () => {
  const localWindow = { sender: { id: 1 } };
  const pairedComputer = { sender: { id: mockPairedBridgeSenderId } };

  beforeEach(() => {
    // Main's read lives for the process; start each case from startup's
    // "no choice" in this case's build.
    applyOneWindowChoice(undefined, false);
  });

  it("main's read follows each committed save, and a paired computer's save never changes it", async () => {
    const handler = mockHandlers.get(IPC_CHANNELS.preferencesSave);
    if (!handler) throw new Error('preferences:save is not registered');
    const heard: boolean[] = [];
    const stop = onOneWindowEnabledChanged((enabled) => heard.push(enabled));
    try {
      await handler(localWindow, { oneWindowEnabled: true });
      expect(mockStore.preferences.oneWindowEnabled).toBe(true);
      expect(isOneWindowEnabled()).toBe(true);

      await handler(pairedComputer, {
        oneWindowEnabled: false,
        navigationMode: 'work',
      });
      expect(mockStore.commits.at(-1)).toEqual({ navigationMode: 'work' });
      expect(mockStore.preferences.oneWindowEnabled).toBe(true);
      expect(isOneWindowEnabled()).toBe(true);

      await handler(localWindow, { oneWindowEnabled: false });
      expect(isOneWindowEnabled()).toBe(false);
      expect(heard.slice(-2)).toEqual([true, false]);
    } finally {
      stop();
    }
  });

  it.each([
    ['internal', true],
    ['rc', false],
    ['stable', false],
  ] as const)(
    'without a choice a %s build reads %s, and a choice overrides it',
    async (flavor, byDefault) => {
      mockReleaseFlavor.value = flavor;
      await savePreferencesPatch({ navigationMode: 'work' });
      expect(mockStore.preferences.oneWindowEnabled).toBeUndefined();
      expect(isOneWindowEnabled()).toBe(byDefault);
      await savePreferencesPatch({ oneWindowEnabled: !byDefault });
      expect(isOneWindowEnabled()).toBe(!byDefault);
    },
  );

  it('reads off while preferences are unconfirmed, even with a choice on an internal build', async () => {
    mockReleaseFlavor.value = 'internal';
    await savePreferencesPatch({ oneWindowEnabled: true });
    expect(isOneWindowEnabled()).toBe(true);
    // A failed recovery latched: the stored values aren't the person's.
    mockStore.unconfirmed = true;
    await savePreferencesPatch({ navigationMode: 'work' });
    expect(isOneWindowEnabled()).toBe(false);
    mockStore.unconfirmed = false;
    await savePreferencesPatch({ navigationMode: 'code' });
    expect(isOneWindowEnabled()).toBe(true);
  });
});
