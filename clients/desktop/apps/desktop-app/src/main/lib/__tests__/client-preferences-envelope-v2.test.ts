// CAN-7925 (CAN-5722 slice C): Electron main's merged preferences view reads
// envelope version 2 as version 1, both when the client-local document seeds
// from preferences.json and when it reads client-preferences.json or rebuilds
// it from its last-good, and this build writes only version 1.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as PreferencesStoreModule from '../preferences-store';

let mockPreferencesFilePath = '';
jest.mock('../paths', () => ({
  getPreferencesFilePath: (): string => mockPreferencesFilePath,
  getClientPreferencesFilePath: (): string =>
    path.join(path.dirname(mockPreferencesFilePath), 'client-preferences.json'),
}));

const CLIENT_LOCAL = {
  theme: 'ocean',
  colorMode: 'dark',
  uiScale: 125,
  sidebarWidth: 300,
  sidebarCollapsed: true,
  windowBounds: { x: 10, y: 20, width: 1200, height: 800 },
};
const DOMAIN = { fileAutoSave: true };

let dir = '';
let launched: Array<typeof PreferencesStoreModule> = [];

async function launch(): Promise<typeof PreferencesStoreModule> {
  let store: typeof PreferencesStoreModule | undefined;
  await jest.isolateModulesAsync(async () => {
    store = await import('../preferences-store');
  });
  if (!store) throw new Error('the preferences store did not load');
  launched.push(store);
  return store;
}

async function quit(store: typeof PreferencesStoreModule): Promise<void> {
  await store.flushPreferencesWrites();
  store.stopPreferencesGenerationStamp();
}

function file(name: string): string {
  return path.join(dir, name);
}

async function writeEnvelope(
  name: string,
  version: number,
  preferences: object,
): Promise<string> {
  const text = JSON.stringify({ version, preferences }, null, 2);
  await writeFile(file(name), text);
  return text;
}

async function versionOf(name: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(file(name), 'utf8'));
  return typeof parsed === 'object' && parsed !== null && 'version' in parsed
    ? parsed.version
    : undefined;
}

/** Every file but `kept` (left byte-identical) carries a version-1 envelope. */
async function expectOnlyVersionOneWrites(kept: {
  name: string;
  text: string;
}): Promise<void> {
  for (const name of await readdir(dir)) {
    if (
      name === kept.name &&
      (await readFile(file(name), 'utf8')) === kept.text
    )
      continue;
    expect([name, await versionOf(name)]).toEqual([name, 1]);
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'client-preferences-v2-'));
  mockPreferencesFilePath = file('preferences.json');
  launched = [];
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const store of launched) {
    await store.flushPreferencesWrites().catch(() => undefined);
    store.stopPreferencesGenerationStamp();
  }
  jest.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('preferences envelope v2 in the client-local split (CAN-7925)', () => {
  it.each([1, 2])(
    'seeds client-local values from a version %i preferences.json',
    async (version) => {
      const primary = await writeEnvelope('preferences.json', version, {
        ...DOMAIN,
        ...CLIENT_LOCAL,
      });
      const store = await launch();
      expect(await store.readPreferencesFile()).toMatchObject({
        ...DOMAIN,
        ...CLIENT_LOCAL,
      });
      expect(store.arePreferencesUnconfirmed()).toBe(false);
      await quit(store);
      expect(await versionOf('client-preferences.json')).toBe(1);
      await expectOnlyVersionOneWrites({
        name: 'preferences.json',
        text: primary,
      });

      await store.updatePreferencesFile(() => ({ fileAutoSave: false }));
      await quit(store);
      expect(await versionOf('preferences.json')).toBe(1);
    },
  );

  it.each([1, 2])(
    'reads a version %i client-preferences.json without rebuilding it',
    async (version) => {
      const client = await writeEnvelope(
        'client-preferences.json',
        version,
        CLIENT_LOCAL,
      );
      const store = await launch();
      expect(await store.readPreferencesFile()).toMatchObject(CLIENT_LOCAL);
      await quit(store);
      expect(await readdir(dir)).toEqual(['client-preferences.json']);
      expect(await readFile(file('client-preferences.json'), 'utf8')).toBe(
        client,
      );

      await store.updatePreferencesFile(() => ({ theme: 'forest' }));
      await quit(store);
      expect((await store.readPreferencesFile()).theme).toBe('forest');
      expect(await versionOf('client-preferences.json')).toBe(1);
    },
  );

  it.each([1, 2])(
    'rebuilds an unparseable client-preferences.json from a version %i last-good',
    async (version) => {
      await writeEnvelope('preferences.json', 1, { theme: 'forest' });
      await writeFile(file('client-preferences.json'), '{ damaged');
      const lastGood = await writeEnvelope(
        'client-preferences.last-good.json',
        version,
        CLIENT_LOCAL,
      );
      const store = await launch();
      expect(await store.readPreferencesFile()).toMatchObject(CLIENT_LOCAL);
      await quit(store);
      for (const name of await readdir(dir)) {
        if (!name.startsWith('client-preferences.backup-')) continue;
        expect(await readFile(file(name), 'utf8')).toBe('{ damaged');
        await rm(file(name));
      }
      await expectOnlyVersionOneWrites({
        name: 'client-preferences.last-good.json',
        text: lastGood,
      });
    },
  );
});
