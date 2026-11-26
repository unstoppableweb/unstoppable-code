// The real preferences store over a temporary data root (CAN-4472). Each
// launch() loads a fresh copy of the store, as a relaunch of the app would.
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import type * as AtomicFileModule from '../atomic-file';
import type * as PreferencesStoreModule from '../preferences-store';
import type * as UiScaleCommandsModule from '../ui-scale-commands';
import type * as UiZoomModule from '../ui-zoom';
import type { ClientLocalPreferences } from '@canopy/desktop-shared/node/preferences/client-local-preferences';

let mockPreferencesFilePath = '';
jest.mock('../paths', () => ({
  getPreferencesFilePath: (): string => mockPreferencesFilePath,
  getClientPreferencesFilePath: (): string =>
    path.join(path.dirname(mockPreferencesFilePath), 'client-preferences.json'),
}));

// Fails a chosen client-local document write, by file name and position.
let mockClientWriteFault: ((file: string, index: number) => boolean) | null =
  null;
let mockClientWrites = 0;
// A crash: after this many durable client-local steps (installs and
// removals), every later one fails, as if the process had died.
let mockCrashAfter: number | null = null;
let mockClientSteps = 0;
function mockClientStepCrashes(target: unknown): boolean {
  if (!path.basename(String(target)).startsWith('client-preferences'))
    return false;
  mockClientSteps += 1;
  return mockCrashAfter !== null && mockClientSteps > mockCrashAfter;
}
jest.mock('../atomic-file', () => {
  const actual: typeof AtomicFileModule = jest.requireActual('../atomic-file');
  return {
    ...actual,
    writeFileAtomically: (
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): ReturnType<typeof actual.writeFileAtomically> => {
      const file = path.basename(String(args[0]));
      if (mockClientStepCrashes(args[0]))
        return Promise.reject(new Error(`injected crash: ${file}`));
      if (file.startsWith('client-preferences')) {
        mockClientWrites += 1;
        if (mockClientWriteFault?.(file, mockClientWrites))
          return Promise.reject(new Error(`injected failure: ${file}`));
      }
      return actual.writeFileAtomically(...args);
    },
  };
});
jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    rm: (
      ...args: Parameters<typeof actual.rm>
    ): ReturnType<typeof actual.rm> =>
      mockClientStepCrashes(args[0])
        ? Promise.reject(new Error('injected crash: rm'))
        : actual.rm(...args),
  };
});

const mockZoomFanOut = jest.fn();
jest.mock('../ui-zoom', () => ({
  ...jest.requireActual<typeof UiZoomModule>('../ui-zoom'),
  applyUiZoomToAllWindows: (factor: number): void => {
    mockZoomFanOut(factor);
  },
}));

/** A value for every client-local key that differs from its default. */
const CHANGED: ClientLocalPreferences = {
  windowBounds: { x: 10, y: 20, width: 1200, height: 800 },
  windowMaximized: true,
  windowFullScreen: true,
  appAdvisorDialogBounds: { x: 5, y: 6, width: 900, height: 700 },
  theme: 'ocean',
  colorMode: 'dark',
  sidebarAppearance: 'opaque',
  scrollbarBehavior: 'always',
  worktreeDiffStatsStyle: 'complete',
  uiScale: 125,
  sidebarWidth: 300,
  sidebarCollapsed: true,
  sidebarCodeSectionCollapsed: true,
  sidebarCoworkSectionCollapsed: true,
  sidebarOrchestratorCollapsed: true,
  appAdvisorNavCollapsed: true,
  worktreePanelPercent: 40,
  kanbanWorktreePanelPercent: 45,
  activityPanelExpanded: true,
  kanbanActivityPanelExpanded: true,
  activityPanelWidthPercent: 30,
  kanbanActivityPanelWidthPercent: 35,
  kanbanChatPanelVisible: true,
  pipelineChatPanelVisible: false,
  pipelineChatPanelWidthPercent: 50,
  terminalDrawerCollapsed: false,
  terminalDrawerHeight: 420,
};
const MOVED_KEYS = Object.keys(CHANGED);
// Each launch loads its own error class, so match the latch's refusal by text.
const LATCH_REFUSAL = 'Preferences could not be read. Changes were not saved.';

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

async function launchZoom(): Promise<{
  store: typeof PreferencesStoreModule;
  zoom: typeof UiScaleCommandsModule;
}> {
  let store: typeof PreferencesStoreModule | undefined;
  let zoom: typeof UiScaleCommandsModule | undefined;
  await jest.isolateModulesAsync(async () => {
    store = await import('../preferences-store');
    zoom = await import('../ui-scale-commands');
  });
  if (!store || !zoom) throw new Error('the zoom command did not load');
  launched.push(store);
  return { store, zoom };
}

/** Quits: waits for every write and its last-good refresh. */
async function quit(store: typeof PreferencesStoreModule): Promise<void> {
  await store.flushPreferencesWrites();
  store.stopPreferencesGenerationStamp();
}

function file(name: string): string {
  return path.join(dir, name);
}

async function readText(name: string): Promise<string | null> {
  try {
    return await readFile(file(name), 'utf8');
  } catch {
    return null;
  }
}

async function readPreferencesRecord(
  name: string,
): Promise<Record<string, unknown>> {
  const text = await readText(name);
  if (text === null) throw new Error(`${name} is missing`);
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('preferences' in parsed) ||
    typeof parsed.preferences !== 'object' ||
    parsed.preferences === null
  )
    throw new Error(`${name} holds no preferences record`);
  return Object.fromEntries(Object.entries(parsed.preferences));
}

function movedKeysOf(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    MOVED_KEYS.filter((key) => key in record).map((key) => [key, record[key]]),
  );
}

/** A preferences.json as a build before CAN-4472 wrote it. */
async function writeLegacyPreferences(
  preferences: Record<string, unknown>,
  name = 'preferences.json',
  envelope: Record<string, unknown> = { version: 1 },
): Promise<void> {
  await writeFile(
    file(name),
    JSON.stringify({ ...envelope, preferences }, null, 2),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'client-preferences-'));
  mockPreferencesFilePath = file('preferences.json');
  mockClientWriteFault = null;
  mockClientWrites = 0;
  mockCrashAfter = null;
  mockClientSteps = 0;
  mockZoomFanOut.mockClear();
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

describe('first launch after the split (CAN-4472)', () => {
  it('a fresh profile writes nothing, then each save writes only its document (G1, G3)', async () => {
    const store = await launch();
    expect(await store.readPreferencesFile()).toMatchObject({
      theme: 'default',
      sidebarWidth: 280,
    });
    await quit(store);
    expect(await readdir(dir)).toEqual([]);

    await store.updatePreferencesFile(() => ({ theme: 'forest' }));
    await quit(store);
    expect(await readText('preferences.json')).toBeNull();
    expect((await readPreferencesRecord('client-preferences.json')).theme).toBe(
      'forest',
    );

    await store.updatePreferencesFile(() => ({ fileAutoSave: true }));
    await quit(store);
    const domain = await readPreferencesRecord('preferences.json');
    expect(domain.fileAutoSave).toBe(true);
    // A fresh domain document never gains a client-local key.
    expect(movedKeysOf(domain)).toEqual({});
  });

  it('a profile from before the split keeps every value, and preferences.json keeps its frozen copy (G2)', async () => {
    await writeLegacyPreferences({ ...CHANGED, fileAutoSave: true });
    const before = await readText('preferences.json');

    const store = await launch();
    expect(await store.readPreferencesFile()).toMatchObject({
      ...CHANGED,
      fileAutoSave: true,
    });
    await quit(store);
    expect(await readText('preferences.json')).toBe(before);
    expect(
      movedKeysOf(await readPreferencesRecord('client-preferences.json')),
    ).toEqual(CHANGED);

    const relaunched = await launch();
    expect(await relaunched.readPreferencesFile()).toMatchObject(CHANGED);
  });

  it.each([1, 2, 3])(
    'a crash at client-local write %i loses no value on the next launch',
    async (failing) => {
      await writeLegacyPreferences({ ...CHANGED });
      mockClientWriteFault = (_file, index): boolean => index === failing;
      const store = await launch();
      // Whatever failed, this session serves the seeded values.
      expect(await store.readPreferencesFile()).toMatchObject(CHANGED);
      await quit(store);

      mockClientWriteFault = null;
      const relaunched = await launch();
      expect(await relaunched.readPreferencesFile()).toMatchObject(CHANGED);
      await quit(relaunched);
      const third = await launch();
      expect(await third.readPreferencesFile()).toMatchObject(CHANGED);
    },
  );

  it('a failed seed commit is carried by the next patch-shaped save (G6)', async () => {
    await writeLegacyPreferences({ ...CHANGED });
    mockClientWriteFault = (): boolean => mockClientWrites <= 3;
    const store = await launch();
    await store.readPreferencesFile();
    mockClientWriteFault = null;
    await store.updatePreferencesFile(() => ({ sidebarWidth: 333 }));
    await quit(store);
    expect(
      movedKeysOf(await readPreferencesRecord('client-preferences.json')),
    ).toEqual({ ...CHANGED, sidebarWidth: 333 });
  });
});

describe('the frozen copy and the client-local document afterwards', () => {
  it('no save, stamp or recovery changes the frozen copy, and reads always show the client part (G4)', async () => {
    await writeLegacyPreferences({ ...CHANGED });
    const store = await launch();
    await store.readPreferencesFile();
    await store.updatePreferencesFile(() => ({
      theme: 'forest',
      navigationMode: 'work',
    }));
    // A stale wide snapshot carrying every client-local key.
    const stale = await store.readPreferencesFile();
    await store.updatePreferencesFile(() => ({
      ...stale,
      theme: 'dusk',
      fileAutoSave: true,
    }));
    await store.updatePreferencesFile(() => ({ fileAutoSave: false }));
    expect(await store.stampPreferencesGeneration()).not.toBe('failed');
    await quit(store);

    const domain = await readPreferencesRecord('preferences.json');
    expect(movedKeysOf(domain)).toEqual(CHANGED);
    expect(domain).toMatchObject({
      navigationMode: 'work',
      fileAutoSave: false,
    });

    // A damaged primary recovers from last-good, frozen copy and all.
    await writeFile(file('preferences.json'), '{ damaged');
    const relaunched = await launch();
    expect(await relaunched.readPreferencesFile()).toMatchObject({
      theme: 'dusk',
      navigationMode: 'work',
    });
    expect(relaunched.arePreferencesUnconfirmed()).toBe(false);
    await quit(relaunched);
    expect(
      movedKeysOf(await readPreferencesRecord('preferences.json')),
    ).toEqual(CHANGED);
  });

  it('once seeded the client document wins over what an older build writes (G5)', async () => {
    await writeLegacyPreferences({ ...CHANGED });
    const store = await launch();
    await store.updatePreferencesFile(() => ({ theme: 'forest' }));
    await quit(store);
    // An older build saves its own values for every key.
    await writeLegacyPreferences({
      ...CHANGED,
      theme: 'lime',
      sidebarWidth: 400,
      fileAutoSave: true,
    });
    const relaunched = await launch();
    expect(await relaunched.readPreferencesFile()).toMatchObject({
      theme: 'forest',
      sidebarWidth: CHANGED.sidebarWidth,
      fileAutoSave: true,
    });
  });

  it('a client-local save leaves preferences.json alone, with distinct merged previous and next (r1 case 9, C2, C3)', async () => {
    await writeLegacyPreferences({ ...CHANGED, fileAutoSave: true });
    const { store, zoom } = await launchZoom();
    await store.readPreferencesFile();
    const before = await readText('preferences.json');
    const committed: number[] = [];
    const { previous, next } = await store.updatePreferencesFileWithPrevious(
      () => ({ uiScale: 150 }),
      (value) => committed.push(value.uiScale),
    );
    expect(previous).not.toBe(next);
    expect(previous.uiScale).toBe(125);
    expect(next).toMatchObject({ uiScale: 150, fileAutoSave: true });
    expect(committed).toEqual([150]);
    await store.updatePreferencesFileWithPrevious(
      () => null,
      (value) => committed.push(value.uiScale),
    );
    expect(committed).toEqual([150]);

    // View > Zoom In steps the client-local scale and fans it out.
    expect(await zoom.applyUiScaleCommand('in')).toBe(155);
    expect(mockZoomFanOut).toHaveBeenCalledTimes(1);
    await quit(store);
    expect(await readText('preferences.json')).toBe(before);
    expect(
      (await readPreferencesRecord('client-preferences.json')).uiScale,
    ).toBe(155);
  });

  it("quit's flush waits for a save started just before it, first-launch seed included", async () => {
    await writeLegacyPreferences({ ...CHANGED });
    const store = await launch();
    void store.writePreferencesFile({ theme: 'retro' });
    await store.flushPreferencesWrites();
    expect(
      movedKeysOf(await readPreferencesRecord('client-preferences.json')),
    ).toEqual({ ...CHANGED, theme: 'retro' });
    void store.writePreferencesFile({ sidebarWidth: 333 });
    await store.flushPreferencesWrites();
    expect(
      (await readPreferencesRecord('client-preferences.json')).sidebarWidth,
    ).toBe(333);
  });

  it('the latest read waits for a client-local save in flight (C5)', async () => {
    const store = await launch();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = store.updatePreferencesFile(async () => {
      await gate;
      return { theme: 'retro' };
    });
    const latest = store.readLatestPreferencesFile();
    release();
    await saving;
    expect((await latest).theme).toBe('retro');
  });
});

describe('an unreadable client-local document rebuilds, never refuses', () => {
  it('without any source it serves defaults, saves, and persists on the next launch (r1 case 6)', async () => {
    await writeFile(file('client-preferences.json'), '{ damaged');
    const store = await launch();
    expect(await store.readPreferencesFile()).toMatchObject({
      theme: 'default',
    });
    await store.updatePreferencesFile(() => ({ theme: 'forest' }));
    await quit(store);
    expect(
      (await readdir(dir)).filter((name) =>
        name.startsWith('client-preferences.backup-'),
      ),
    ).toHaveLength(1);
    const relaunched = await launch();
    expect((await relaunched.readPreferencesFile()).theme).toBe('forest');
  });

  it('it rebuilds from the client last-good, else the frozen copy, never defaults (G14)', async () => {
    await writeLegacyPreferences({ ...CHANGED });
    const store = await launch();
    await store.updatePreferencesFile(() => ({ theme: 'dusk' }));
    await quit(store);

    await writeFile(file('client-preferences.json'), '{ damaged');
    const fromLastGood = await launch();
    expect(await fromLastGood.readPreferencesFile()).toMatchObject({
      ...CHANGED,
      theme: 'dusk',
    });
    await quit(fromLastGood);

    await writeFile(file('client-preferences.json'), '{ damaged');
    await rm(file('client-preferences.last-good.json'), { force: true });
    const fromFrozenCopy = await launch();
    expect(await fromFrozenCopy.readPreferencesFile()).toMatchObject(CHANGED);
    await quit(fromFrozenCopy);
    expect(
      movedKeysOf(await readPreferencesRecord('client-preferences.json')),
    ).toEqual(CHANGED);
  });
});

describe('a crash at any client-local step loses no value (r1 case 3)', () => {
  type CrashScenario = {
    readonly arrange: () => Promise<void>;
    readonly act: (store: typeof PreferencesStoreModule) => Promise<unknown>;
    /** What the next launch may show: the values before or after the act. */
    readonly outcomes: readonly Partial<ClientLocalPreferences>[];
  };

  /** A profile seeded by an earlier launch: both documents, written as the engine writes them. */
  async function seeded(
    patch: Partial<ClientLocalPreferences> = {},
  ): Promise<void> {
    await writeLegacyPreferences({ ...CHANGED });
    const envelope = { version: 1, generation: 1 };
    for (const name of [
      'client-preferences.json',
      'client-preferences.last-good.json',
    ])
      await writeLegacyPreferences({ ...CHANGED, ...patch }, name, envelope);
    await writeFile(
      file('client-preferences.generation.json'),
      JSON.stringify(envelope),
    );
  }

  /** Launches, runs, quits and lets the module graph go (many launches per test). */
  async function session<Result>(
    run: (store: typeof PreferencesStoreModule) => Promise<Result>,
  ): Promise<Result> {
    const store = await launch();
    try {
      return await run(store);
    } finally {
      await quit(store);
      launched = launched.filter((entry) => entry !== store);
    }
  }

  const SCENARIOS: Record<string, CrashScenario> = {
    'the first-launch seed': {
      arrange: () => writeLegacyPreferences({ ...CHANGED }),
      act: (store) => store.readPreferencesFile(),
      outcomes: [CHANGED],
    },
    'a client-local save': {
      arrange: () => seeded(),
      act: (store) =>
        store.updatePreferencesFile(() => ({
          theme: 'dusk',
          sidebarWidth: 333,
        })),
      outcomes: [CHANGED, { ...CHANGED, theme: 'dusk', sidebarWidth: 333 }],
    },
    'a rebuild from the client last-good': {
      arrange: async () => {
        await seeded({ theme: 'dusk' });
        await writeFile(file('client-preferences.json'), '{ damaged');
      },
      act: (store) => store.readPreferencesFile(),
      outcomes: [{ ...CHANGED, theme: 'dusk' }],
    },
    'a rebuild from the frozen copy': {
      arrange: async () => {
        await seeded();
        await writeFile(file('client-preferences.json'), '{ damaged');
        await rm(file('client-preferences.last-good.json'));
      },
      act: (store) => store.readPreferencesFile(),
      outcomes: [CHANGED],
    },
  };

  /** Runs one crash point in a fresh data root; resolves to what the next launch shows. */
  async function crashAt(
    scenario: CrashScenario,
    crashAfter: number | null,
  ): Promise<{ steps: number; shown: Record<string, unknown> }> {
    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(path.join(tmpdir(), 'client-preferences-crash-'));
    mockPreferencesFilePath = file('preferences.json');
    await scenario.arrange();
    mockClientSteps = 0;
    mockCrashAfter = crashAfter;
    // The store never refuses a client-local write, crash or not.
    await session((store) => scenario.act(store));
    const steps = mockClientSteps;
    mockCrashAfter = null;
    const shown = await session(async (store) =>
      movedKeysOf(
        Object.fromEntries(Object.entries(await store.readPreferencesFile())),
      ),
    );
    // Idempotent: the next launch reads exactly what this one shows.
    expect(
      movedKeysOf(await readPreferencesRecord('client-preferences.json')),
    ).toEqual(shown);
    return { steps, shown };
  }

  it.each(Object.keys(SCENARIOS))(
    '%s',
    async (name) => {
      const scenario = SCENARIOS[name];
      const { steps } = await crashAt(scenario, null);
      expect(steps).toBeGreaterThan(0);
      for (let crashAfter = 0; crashAfter < steps; crashAfter += 1) {
        const { shown } = await crashAt(scenario, crashAfter);
        const lossless = scenario.outcomes.some((outcome) =>
          MOVED_KEYS.every(
            (key) =>
              JSON.stringify(Reflect.get(outcome, key)) ===
              JSON.stringify(shown[key]),
          ),
        );
        // The crash point is in the expectation so a failure names it.
        expect({ crashAfter, lossless, shown }).toEqual({
          crashAfter,
          lossless: true,
          shown,
        });
      }
    },
    60_000,
  );

  it('a backup that cannot be written replaces nothing and serves the client last-good', async () => {
    await seeded({ theme: 'dusk' });
    await writeFile(file('client-preferences.json'), '{ damaged');
    mockClientWriteFault = (name): boolean =>
      name.startsWith('client-preferences.backup-');
    const store = await launch();
    expect(await store.readPreferencesFile()).toMatchObject({
      ...CHANGED,
      theme: 'dusk',
    });
    await quit(store);
    expect(await readText('client-preferences.json')).toBe('{ damaged');
    expect(await readText('client-preferences.last-good.json')).not.toBeNull();
  });
});

describe('a client-local primary that cannot be read at all', () => {
  it('is left in place and served from the last readable values', async () => {
    await writeLegacyPreferences({ ...CHANGED });
    const store = await launch();
    await store.updatePreferencesFile(() => ({ theme: 'dusk' }));
    await quit(store);
    // A read error, not a parse error: no bytes to keep, so nothing moves.
    await rm(file('client-preferences.json'));
    await mkdir(file('client-preferences.json'));
    const relaunched = await launch();
    expect((await relaunched.readPreferencesFile()).theme).toBe('dusk');
    await quit(relaunched);
    expect(await readdir(dir)).toContain('client-preferences.json');
  });
});

describe('a domain the engine will not accept seeds nothing (pending)', () => {
  it('a latched domain persists no client document and still refuses every save (G7, r2 Option A)', async () => {
    await writeFile(file('preferences.json'), '{ damaged');
    const store = await launch();
    await store.readPreferencesFile();
    expect(store.arePreferencesUnconfirmed()).toBe(true);
    for (const patch of [
      { theme: 'forest' as const },
      { theme: 'forest' as const, fileAutoSave: true },
    ]) {
      await expect(store.updatePreferencesFile(() => patch)).rejects.toThrow(
        LATCH_REFUSAL,
      );
    }
    expect((await store.readPreferencesFile()).theme).toBe('default');
    await quit(store);
    expect(await readText('client-preferences.json')).toBeNull();
  });

  it('a newer-format primary serves its last-good in memory and persists nothing (G11)', async () => {
    // Version 2 is readable since CAN-7925; 3 is the first unknown version.
    await writeLegacyPreferences({ fileAutoSave: true }, 'preferences.json', {
      version: 3,
    });
    await writeLegacyPreferences({ ...CHANGED }, 'preferences.last-good.json');
    const before = await readText('preferences.json');
    const store = await launch();
    expect(await store.readPreferencesFile()).toMatchObject(CHANGED);
    await expect(
      store.updatePreferencesFile(() => ({ sidebarWidth: 260 })),
    ).rejects.toThrow(LATCH_REFUSAL);
    await quit(store);
    expect(await readText('client-preferences.json')).toBeNull();
    expect(await readText('preferences.json')).toBe(before);
  });

  it('an unproven last-good serves in memory, persists nothing and keeps the refusal (G12)', async () => {
    await writeFile(file('preferences.json'), '{ damaged');
    await writeLegacyPreferences({ ...CHANGED }, 'preferences.last-good.json', {
      version: 1,
      generation: 1,
    });
    await writeFile(
      file('preferences.generation.json'),
      JSON.stringify({ version: 1, generation: 5 }),
    );
    const store = await launch();
    expect(await store.readPreferencesFile()).toMatchObject(CHANGED);
    expect(store.arePreferencesUnconfirmed()).toBe(true);
    await expect(
      store.updatePreferencesFile(() => ({ theme: 'forest' })),
    ).rejects.toThrow(LATCH_REFUSAL);
    await quit(store);
    expect(await readText('client-preferences.json')).toBeNull();
  });

  it('a domain record that refuses saves refuses a mixed patch whole, but not a client-local one (r1 case 8)', async () => {
    await writeLegacyPreferences({
      ...CHANGED,
      planModeHint: { version: 99 },
    });
    const store = await launch();
    await store.readPreferencesFile();
    await expect(
      store.updatePreferencesFile(() => ({
        theme: 'forest',
        fileAutoSave: true,
      })),
    ).rejects.toThrow('Plan mode hint preferences could not be read');
    expect((await store.readPreferencesFile()).theme).toBe(CHANGED.theme);
    await store.updatePreferencesFile(() => ({ theme: 'forest' }));
    expect((await store.readPreferencesFile()).theme).toBe('forest');
  });
});
