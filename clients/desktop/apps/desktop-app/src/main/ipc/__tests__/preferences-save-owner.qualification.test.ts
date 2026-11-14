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
} = {
  preferences: DEFAULT_PREFERENCES,
  commits: [],
};
jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../../lib/preferences-store',
  ),
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
import { nativeCrashAnnotation } from '../../lib/native-crash-policy';
import {
  registerPreferenceHandlers,
  savePreferencesPatch,
} from '../preferences';

beforeEach(() => {
  mockStore.preferences = { ...DEFAULT_PREFERENCES, navigationMode: 'code' };
  mockStore.commits = [];
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
