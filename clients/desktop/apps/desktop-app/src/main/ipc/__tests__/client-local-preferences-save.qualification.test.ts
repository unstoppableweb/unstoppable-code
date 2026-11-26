// preferences:save over the real store (CAN-4472, r2 seam C1–C3): a purely
// client-local save still runs the save's effects, and a latched domain still
// refuses it before any effect.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

import type * as PathsModule from '../../lib/paths';
import {
  flushPreferencesWrites,
  readPreferencesFile,
  resetPreferencesLoadErrorForTests,
} from '../../lib/preferences-store';
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
