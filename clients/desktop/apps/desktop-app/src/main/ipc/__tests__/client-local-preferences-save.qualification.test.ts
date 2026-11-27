// preferences:save over the real store (CAN-4472, r2 seam C1–C3): a purely
// client-local save still runs the save's effects, and a latched domain still
// refuses it before any effect. CAN-7991: with the daemon port selected and
// nothing read yet, a client-local save needs no daemon and applies no
// domain defaults, even when a read lands while it saves.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanopyClientError } from '@canopy/core-client';
import type { PreferencesDocumentRoute } from '../../canopy-runtime/preferences-daemon-client';
import type * as DomainPortModule from '../../lib/preferences-domain-port';
import type { DomainPreferencesPort } from '../../lib/preferences-domain-port';

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

let mockPreferencesFilePath = '';
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../../lib/paths'),
  getPreferencesFilePath: (): string => mockPreferencesFilePath,
  getClientPreferencesFilePath: (): string =>
    path.join(path.dirname(mockPreferencesFilePath), 'client-preferences.json'),
}));

const mockSetEnabled = jest.fn();
jest.mock('../../power/wake-lock-service', () => ({
  getWakeLockService: (): { setEnabled: (enabled: boolean) => void } => ({
    setEnabled: mockSetEnabled,
  }),
}));

const mockBroadcast = jest.fn();
jest.mock('../../lib/preferences-broadcast', () => ({
  broadcastPreferencesSynced: (...args: unknown[]): void => {
    mockBroadcast(...args);
  },
  broadcastPreferencesChanged: jest.fn(),
}));

// The store's port, as the flip selects it: in process unless a test sets one.
const mockSelected: { port: DomainPreferencesPort | null } = { port: null };
jest.mock('../../lib/preferences-domain-port', () => {
  const actual = jest.requireActual<typeof DomainPortModule>(
    '../../lib/preferences-domain-port',
  );
  return {
    ...actual,
    selectDomainPreferences: (
      ...args: Parameters<typeof actual.selectDomainPreferences>
    ): DomainPreferencesPort => {
      const inProcess = actual.selectDomainPreferences(...args);
      const port = (): DomainPreferencesPort => mockSelected.port ?? inProcess;
      return {
        readStoredPayload: () => port().readStoredPayload(),
        read: (view) => port().read(view),
        readAuthority: (options) => port().readAuthority(options),
        hasPersistedState: () => port().hasPersistedState(),
        update: (updater, onCommitted, options) =>
          port().update(updater, onCommitted, options),
        stampGeneration: (isStopped) => port().stampGeneration(isStopped),
        flush: () => port().flush(),
        idle: () => port().idle(),
        isRecoveryLatched: () => port().isRecoveryLatched(),
        peekLoadError: () => port().peekLoadError(),
        acknowledgeLoadError: () => port().acknowledgeLoadError(),
        migrationTimestamp: () => port().migrationTimestamp(),
        resetForTests: () => port().resetForTests(),
        readLegacyClientLocal: () => port().readLegacyClientLocal(),
        readStoredProductAnalyticsChoice: () =>
          port().readStoredProductAnalyticsChoice(),
      };
    },
  };
});

import { nativeTheme } from 'electron';
import type * as PathsModule from '../../lib/paths';
import {
  arePreferencesUnconfirmed,
  createDaemonDomainPreferences,
  flushPreferencesWrites,
  readLatestPreferencesFile,
  readPreferencesFile,
  resetPreferencesLoadErrorForTests,
  updatePreferencesFile,
  updatePreferencesFileWithPrevious,
} from '../../lib/preferences-store';
import { applyUiScaleCommand } from '../../lib/ui-scale-commands';
import { savePreferencesPatch } from '../preferences';

let dir = '';

async function readPreferencesRecord(
  name: string,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path.join(dir, name), 'utf8');
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('preferences' in parsed) ||
    typeof parsed.preferences !== 'object' ||
    parsed.preferences === null
  )
    return null;
  return Object.fromEntries(Object.entries(parsed.preferences));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'client-local-save-'));
  mockPreferencesFilePath = path.join(dir, 'preferences.json');
  mockSetEnabled.mockClear();
  mockBroadcast.mockClear();
  resetPreferencesLoadErrorForTests();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await flushPreferencesWrites().catch(() => undefined);
  resetPreferencesLoadErrorForTests();
  jest.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

it('a client-local save runs the save effects with the merged value and leaves preferences.json alone', async () => {
  await writeFile(
    mockPreferencesFilePath,
    JSON.stringify({
      version: 1,
      preferences: { keepSystemAwakeWhileAgentsActive: false },
    }),
  );
  const before = await readFile(mockPreferencesFilePath, 'utf8');
  const saved = await savePreferencesPatch({ sidebarWidth: 300 });
  expect(saved).toMatchObject({
    sidebarWidth: 300,
    keepSystemAwakeWhileAgentsActive: false,
  });
  expect(saved).not.toHaveProperty('__preferencesUnconfirmed');
  expect(mockSetEnabled).toHaveBeenCalledWith(false);
  await flushPreferencesWrites();
  expect(await readFile(mockPreferencesFilePath, 'utf8')).toBe(before);
  expect(await readPreferencesRecord('client-preferences.json')).toMatchObject({
    sidebarWidth: 300,
  });
});

it('under a latched domain the same save is refused before any effect', async () => {
  await writeFile(mockPreferencesFilePath, '{ damaged');
  await readPreferencesFile();
  await expect(savePreferencesPatch({ sidebarWidth: 300 })).rejects.toThrow(
    'Preferences could not be read. Changes were not saved.',
  );
  expect(mockSetEnabled).not.toHaveBeenCalled();
  await flushPreferencesWrites();
  expect(await readPreferencesRecord('client-preferences.json')).toBeNull();
});

it('with the daemon port selected, nothing read and the daemon down, a theme or zoom save applies only its client-local effects', async () => {
  await writeFile(
    path.join(dir, 'client-preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { colorMode: 'light', uiScale: 100 },
    }),
  );
  const sent: string[] = [];
  const down = (name: string) => (): Promise<never> => {
    sent.push(name);
    return Promise.reject(
      new CanopyClientError({
        kind: 'unavailable',
        message: 'The daemon is not running.',
        retry: { kind: 'same_request' },
      }),
    );
  };
  const route: PreferencesDocumentRoute = {
    clientInstanceId: 'electron-main-preferences',
    get: down('get'),
    legacyClientLocal: down('legacyClientLocal'),
    update: down('update'),
    ownerUpdate: down('ownerUpdate'),
    acknowledgeLoadError: down('acknowledgeLoadError'),
    subscribe: () => () => undefined,
  };
  const daemonPort = createDaemonDomainPreferences(route);
  mockSelected.port = daemonPort;
  try {
    // The reply says its domain keys are stand-ins, so no renderer takes
    // them as the member's settings; only the client-local keys are saved.
    await expect(
      savePreferencesPatch({ colorMode: 'dark' }),
    ).resolves.toMatchObject({
      colorMode: 'dark',
      __preferencesUnconfirmed: true,
    });
    await expect(
      savePreferencesPatch({ uiScale: 110 }, { view: 'persisted' }),
    ).resolves.toMatchObject({ uiScale: 110, __preferencesUnconfirmed: true });
    expect(nativeTheme.themeSource).toBe('dark');
    await expect(applyUiScaleCommand('in')).resolves.toBeGreaterThan(100);
    const observed = jest.fn();
    await updatePreferencesFile(() => ({ sidebarWidth: 280 }), observed);
    expect(sent).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
    // The domain part is the defaults standing in for an unread document:
    // unconfirmed, never applied, cached or broadcast as the member's.
    expect(arePreferencesUnconfirmed()).toBe(true);
    expect(mockSetEnabled).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
    // Nor served as the latest: that read still needs the daemon.
    await expect(readLatestPreferencesFile()).rejects.toThrow(
      'The daemon is not running.',
    );
    await flushPreferencesWrites();
    expect(
      await readPreferencesRecord('client-preferences.json'),
    ).toMatchObject({ colorMode: 'dark', sidebarWidth: 280 });
  } finally {
    daemonPort.close();
    mockSelected.port = null;
  }
});

it("a daemon read landing during a cold client-only save never makes that save's defaults stored", async () => {
  await writeFile(
    path.join(dir, 'client-preferences.json'),
    JSON.stringify({ version: 1, preferences: { colorMode: 'light' } }),
  );
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const route: PreferencesDocumentRoute = {
    clientInstanceId: 'electron-main-preferences',
    get: async () => {
      await held;
      return {
        revision: `sha256:${'a'.repeat(64)}`,
        value: { keepSystemAwakeWhileAgentsActive: false },
        enforcedPaths: [],
        loadError: null,
      };
    },
    legacyClientLocal: () => Promise.resolve({ kind: 'missing' }),
    update: () => Promise.reject(new Error('no write is sent')),
    ownerUpdate: () => Promise.reject(new Error('no write is sent')),
    acknowledgeLoadError: () => Promise.resolve(undefined),
    subscribe: () => () => undefined,
  };
  const daemonPort = createDaemonDomainPreferences(route);
  mockSelected.port = daemonPort;
  try {
    // The read is in flight; each save releases it once the port has
    // answered on the defaults, so it lands during the client write.
    const load = readPreferencesFile();
    const observed = jest.fn();
    const change = await updatePreferencesFileWithPrevious(() => {
      setTimeout(release, 0);
      return { sidebarWidth: 300 };
    }, observed);
    await load;
    expect(change.domainUnread).toBe(true);
    expect(observed).not.toHaveBeenCalled();
    expect(await readPreferencesFile()).toMatchObject({
      keepSystemAwakeWhileAgentsActive: false,
      sidebarWidth: 300,
    });
  } finally {
    daemonPort.close();
    mockSelected.port = null;
  }

  const second = createDaemonDomainPreferences({
    ...route,
    get: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        revision: `sha256:${'b'.repeat(64)}`,
        value: { keepSystemAwakeWhileAgentsActive: false },
        enforcedPaths: [],
        loadError: null,
      };
    },
  });
  mockSelected.port = second;
  resetPreferencesLoadErrorForTests();
  try {
    const load = readPreferencesFile();
    const saved = await savePreferencesPatch({ colorMode: 'dark' });
    await load;
    expect(arePreferencesUnconfirmed()).toBe(false);
    expect(saved).toMatchObject({ __preferencesUnconfirmed: true });
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockSetEnabled).not.toHaveBeenCalled();
  } finally {
    second.close();
    mockSelected.port = null;
  }
});
