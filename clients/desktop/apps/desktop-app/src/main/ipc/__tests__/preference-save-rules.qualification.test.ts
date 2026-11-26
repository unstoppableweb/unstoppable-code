// The preference save rules through Electron's preferences:save (CAN-7935):
// the table the shared module is qualified against, driven through the
// window's save, with today's refusal messages.
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

const mockStore: {
  preferences: PreferencesData;
  reads: number;
  commits: Array<Partial<PreferencesData>>;
} = { preferences: DEFAULT_PREFERENCES, reads: 0, commits: [] };
jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../../lib/preferences-store',
  ),
  arePreferencesUnconfirmed: (): boolean => false,
  readPreferencesFile: (): Promise<PreferencesData> => {
    mockStore.reads += 1;
    return Promise.resolve({ ...mockStore.preferences });
  },
  readLatestPreferencesFile: (): Promise<PreferencesData> =>
    Promise.resolve({ ...mockStore.preferences }),
  updatePreferencesFileWithPrevious: (
    updater: (latest: PreferencesData) => Partial<PreferencesData>,
    onCommitted?: (committed: PreferencesData) => void,
  ): Promise<{ previous: PreferencesData; next: PreferencesData }> => {
    const previous = { ...mockStore.preferences };
    const patch = updater(previous);
    mockStore.commits.push(patch);
    mockStore.preferences = { ...previous, ...patch };
    onCommitted?.(mockStore.preferences);
    return Promise.resolve({ previous, next: { ...mockStore.preferences } });
  },
}));

import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import {
  IPC_CHANNELS,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import { PREFERENCE_SAVE_RULE_CASES } from '@canopy/protocol/canopy-core/core/config/testing';
import type * as PreferencesStoreModule from '../../lib/preferences-store';
import { registerPreferenceHandlers } from '../preferences';

const REFUSAL_MESSAGES: Record<string, string> = {
  approvalDefaults:
    'Approval defaults must be saved with setApprovalDefaultPreference.',
  claudeModAdmissions:
    'Claude Mod consent and the kill switch must be changed with the typed Claude Mod admission service.',
  claudeModsDisabled:
    'Claude Mod consent and the kill switch must be changed with the typed Claude Mod admission service.',
  accountProxyConnection:
    'The account proxy connection must be changed with accountProxy.connect.',
  copilotAccount:
    'The Copilot account must be changed with copilotConnection.connect.',
};

const localWindow = { sender: { id: 1 } };
const pairedComputer = { sender: { id: mockPairedBridgeSenderId } };

function save(event: unknown, patch: unknown): Promise<unknown> {
  const handler = mockHandlers.get(IPC_CHANNELS.preferencesSave);
  if (!handler) throw new Error('preferences:save is not registered');
  return handler(event, patch);
}

/** What the commit writes for a save the rules admit with `dropped` removed. */
function expectedCommit(
  patch: Readonly<Record<string, unknown>>,
  dropped: readonly string[],
): Record<string, unknown> {
  const written = Object.fromEntries(
    Object.entries(patch).filter(([key]) => !dropped.includes(key)),
  );
  const usageData = patch.usageData;
  if (typeof usageData === 'object' && usageData !== null)
    written.usageData = { ...mockStore.preferences.usageData, ...usageData };
  return written;
}

beforeEach(() => {
  mockStore.preferences = { ...DEFAULT_PREFERENCES, navigationMode: 'code' };
  mockStore.reads = 0;
  mockStore.commits = [];
  mockHandlers.clear();
  registerPreferenceHandlers();
});

describe('the preference save rules through preferences:save (CAN-7935)', () => {
  it.each(PREFERENCE_SAVE_RULE_CASES.map((rule) => [rule.name, rule]))(
    '%s',
    async (_name, { patch, outcome }) => {
      if ('refused' in outcome) {
        // An Error matches on its exact message, not a substring.
        await expect(save(localWindow, patch)).rejects.toThrow(
          new Error(REFUSAL_MESSAGES[outcome.refused]),
        );
        // Refused before the stored preferences are even read.
        expect(mockStore.reads).toBe(0);
        expect(mockStore.commits).toEqual([]);
        return;
      }
      const expected = expectedCommit(patch, outcome.dropped);
      await save(localWindow, patch);
      expect(mockStore.commits).toEqual([expected]);
    },
  );

  it.each([undefined, null])(
    'a usage-data key set to %s does not count toward a one-key intent',
    async (usageData) => {
      await save(localWindow, {
        googleSubscriptionDisconnected: true,
        usageData,
      });
      expect(mockStore.commits).toEqual([
        { googleSubscriptionDisconnected: true },
      ]);
    },
  );

  it("a paired computer's one-window choice is removed before the intents count keys", async () => {
    await save(pairedComputer, {
      oneWindowEnabled: false,
      googleSubscriptionDisconnected: true,
    });
    expect(mockStore.commits).toEqual([
      { googleSubscriptionDisconnected: true },
    ]);
  });
});
