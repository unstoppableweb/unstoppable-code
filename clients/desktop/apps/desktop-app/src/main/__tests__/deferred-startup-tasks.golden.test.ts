// CAN-4175 capture golden: the deferred startup background tasks, pinned on
// unchanged code before startup work moves to the daemon's initiated-work
// engine (CAN-5092 places it). It asserts when the tasks run, which run on
// each platform and build, the Codex staging sweep's cadence, what cancel and
// quit stop, and that one failing task does not stop the others. It asserts
// observable behaviour only: timings through fake timers, the runner's emitted
// scheduling event, which tasks ran or were cancelled, the quit drain and the
// recorded diagnostics; never the runner's internal names or the order in which
// it calls its tasks, so a refactor of the tasks cannot break it for no reason.
// Every task is a recording stub; the managed marketplace receipts task is an
// opaque task, recorded by name only.
import type { BrowserWindow } from 'electron';
import type * as DeferredRunner from '../startup-background-tasks';

type Listener = () => void;

interface MockState {
  calls: string[];
  e2e: boolean;
  immediate: boolean;
  automaticCalls: boolean;
  skillsRejects: boolean;
  ledgerThrows: boolean;
  diagnostics: string[];
  events: { name: string; data?: unknown }[];
}

const mockState: MockState = {
  calls: [],
  e2e: false,
  immediate: false,
  automaticCalls: true,
  skillsRejects: false,
  ledgerThrows: false,
  diagnostics: [],
  events: [],
};

function mockRecord(name: string): void {
  mockState.calls.push(name);
}

jest.mock('../skills/skill-service', () => ({
  checkUpdates: (): Promise<{ success: boolean }> => {
    mockRecord('skills-update-check');
    return mockState.skillsRejects
      ? Promise.reject(new Error('offline'))
      : Promise.resolve({ success: true });
  },
}));
jest.mock('../plugins/plugin-service', () => ({
  reconcileManagedMarketplaceReceiptsAtStartup: (): { status: string } => {
    mockRecord('marketplace-receipts');
    return { status: 'reconciled' };
  },
  refreshMarketplaces: (): Promise<{ success: boolean }> => {
    mockRecord('marketplace-refresh');
    return Promise.resolve({ success: true });
  },
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordAppDiagnostic: (diagnostic: { reason: string }) => void;
  } => ({
    recordAppDiagnostic: (diagnostic): void => {
      mockState.diagnostics.push(diagnostic.reason);
    },
  }),
}));
jest.mock('../feedback/turn-feedback-client', () => ({
  flushTurnFeedbackOutbox: (): Promise<void> => {
    mockRecord('turn-feedback-flush');
    return Promise.resolve();
  },
}));
jest.mock('../canopy-cloud/shared-item-subscriptions', () => ({
  flushSharedItemSubscriptions: (): Promise<void> => {
    mockRecord('shared-item-subscriptions-flush');
    return Promise.resolve();
  },
}));
jest.mock('../lib/window-send', () => ({
  sendToWindowDetailed: (): void => undefined,
}));
jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockState.e2e,
}));
jest.mock('../local-only/policy', () => ({
  allowsAutomaticCall: (): boolean => mockState.automaticCalls,
  runsDeferredStartupTasksImmediately: (): boolean => mockState.immediate,
}));
jest.mock('../lib/realistic-startup-performance', () => ({
  isRealisticStartupPerformanceEnabled: (): boolean => false,
  recordRealisticStartupPerformanceEvent: (
    name: string,
    data?: unknown,
  ): void => {
    mockState.events.push({ name, data });
  },
}));
jest.mock('../memory/local/import/import-job', () => ({
  enqueueStartupLocalMemoryImportBatch: (): Promise<void> => {
    mockRecord('local-memory-import');
    return Promise.resolve();
  },
}));
jest.mock('../plugins/codex-staging-janitor', () => ({
  sweepCodexMarketplaceStaging: (): Promise<void> => {
    mockRecord('codex-staging-sweep');
    return Promise.resolve();
  },
}));
jest.mock('../blueprints/blueprint-catalog', () => ({
  prefetchBlueprints: (): Promise<boolean> => {
    mockRecord('blueprint-prefetch');
    return Promise.resolve(true);
  },
}));
jest.mock('../ledger/lifecycle', () => ({
  reconcileLedgerScopesAtStartup: (): Promise<string> => {
    mockRecord('ledger-scope-reconcile');
    return mockState.ledgerThrows
      ? Promise.reject(new Error('ledger unavailable'))
      : Promise.resolve('settled');
  },
}));
jest.mock('../ledger/summary-reconciliation', () => ({
  reconcileSummaryPublications: (): Promise<void> => {
    mockRecord('ledger-summary-publications');
    return Promise.resolve();
  },
}));
jest.mock('../agents/delegation/startup-stream-repair', () => ({
  startStartupStreamRepair: (): Promise<Record<string, number>> => {
    mockRecord('stream-repair');
    return Promise.resolve({
      discovered: 0,
      repaired: 0,
      skipped: 0,
      failed: 0,
      durationMs: 0,
    });
  },
  shutdownStartupStreamRepair: (): Promise<void> => {
    mockRecord('stream-repair-shutdown');
    return Promise.resolve();
  },
}));

type DeferredModule = typeof DeferredRunner;

/** Every task the runner starts once its gate fires. */
const TASKS = [
  'blueprint-prefetch',
  'codex-staging-sweep',
  'crash-dump-sweep',
  'ledger-scope-reconcile',
  'ledger-summary-publications',
  'local-memory-import',
  'marketplace-receipts',
  'marketplace-refresh',
  'shared-item-subscriptions-flush',
  'skills-update-check',
  'stream-repair',
  'turn-feedback-flush',
];

/** Which tasks ran, as a sorted list: the order of calls is not pinned. */
function ran(calls: readonly string[]): string[] {
  return [...calls].sort();
}

const EVERY_TASK = TASKS;
const PROVIDER_REFRESHES = new Set([
  'turn-feedback-flush',
  'shared-item-subscriptions-flush',
  'skills-update-check',
  'marketplace-refresh',
  'blueprint-prefetch',
]);
const HOUR = 60 * 60 * 1000;

interface FakeWindow {
  window: BrowserWindow;
  listeners: Map<string, Set<Listener>>;
  interact: () => void;
}

function fakeWindow(): FakeWindow {
  const listeners = new Map<string, Set<Listener>>();
  const webContents = {
    on: (event: string, listener: Listener): void => {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event: string, listener: Listener): void => {
      listeners.get(event)?.delete(listener);
    },
  };
  const window = { isDestroyed: (): boolean => false, webContents };
  return {
    // A structural stand-in: the runner reads only isDestroyed and webContents.
    window: window as unknown as BrowserWindow,
    listeners,
    interact: (): void => {
      for (const listener of listeners.get('before-input-event') ?? [])
        listener();
    },
  };
}

function attachedListeners(fake: FakeWindow): number {
  let count = 0;
  for (const set of fake.listeners.values()) count += set.size;
  return count;
}

let realPlatform: PropertyDescriptor | undefined;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

async function loadRunner(): Promise<DeferredModule> {
  let loaded: DeferredModule | undefined;
  await jest.isolateModulesAsync(async () => {
    loaded = await import('../startup-background-tasks');
  });
  if (!loaded) throw new Error('startup-background-tasks did not load');
  return loaded;
}

async function schedule(fake: FakeWindow): Promise<() => void> {
  const runner = await loadRunner();
  return runner.scheduleDeferredStartupBackgroundTasks(() => fake.window, {
    runCrashDumpSweep: (): Promise<void> => {
      mockRecord('crash-dump-sweep');
      return Promise.resolve();
    },
  });
}

async function elapse(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse('2026-11-19T09:00:00.000Z') });
  realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  setPlatform('darwin');
  mockState.calls = [];
  mockState.e2e = false;
  mockState.immediate = false;
  mockState.automaticCalls = true;
  mockState.skillsRejects = false;
  mockState.ledgerThrows = false;
  mockState.diagnostics = [];
  mockState.events = [];
  delete process.env['CANOPY_PERFORMANCE_LIVE_STARTUP_BACKGROUND'];
  delete process.env['CANOPY_E2E_STARTUP_STREAM_REPAIR'];
});

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  jest.useRealTimers();
});

describe('deferred startup background tasks (CAN-4175 capture)', () => {
  it('with no input, every task runs 5 s after scheduling', async () => {
    const fake = fakeWindow();
    await schedule(fake);
    // The runner announces its schedule: a 5 s first delay, a 5 s idle window
    // and a 60 s cap. A shorter first delay alone would still fire at 5 s.
    expect(
      mockState.events.filter(
        (event) => event.name === 'startup:skill-plugin-refresh:scheduled',
      ),
    ).toEqual([
      {
        name: 'startup:skill-plugin-refresh:scheduled',
        data: { delayMs: 5_000, idleMs: 5_000, maxDelayMs: 60_000 },
      },
    ]);
    await elapse(5_000);
    expect(ran(mockState.calls)).toEqual(EVERY_TASK);
    expect(attachedListeners(fake)).toBe(0);
  });

  it('nothing runs before the 5 s mark', async () => {
    const fake = fakeWindow();
    await schedule(fake);
    await elapse(4_999);
    expect(mockState.calls).toEqual([]);
    await elapse(1);
    expect(ran(mockState.calls)).toEqual(EVERY_TASK);
    expect(attachedListeners(fake)).toBe(0);
  });

  it('input keeps the tasks back until the window has had 5 s with none', async () => {
    const fake = fakeWindow();
    await schedule(fake);
    await elapse(4_000);
    fake.interact();
    await elapse(1_000);
    expect(mockState.calls).toEqual([]);
    await elapse(3_999);
    expect(mockState.calls).toEqual([]);
    await elapse(1);
    expect(ran(mockState.calls)).toEqual(EVERY_TASK);
  });

  it('constant input holds the tasks for at most 60 s', async () => {
    const fake = fakeWindow();
    await schedule(fake);
    for (let elapsed = 0; elapsed < 59_000; elapsed += 1_000) {
      fake.interact();
      await elapse(1_000);
    }
    expect(mockState.calls).toEqual([]);
    fake.interact();
    await elapse(1_000);
    expect(ran(mockState.calls)).toEqual(EVERY_TASK);
  });

  it('the local-only immediate seam runs every task at once', async () => {
    mockState.immediate = true;
    await schedule(fakeWindow());
    await elapse(0);
    expect(ran(mockState.calls)).toEqual(EVERY_TASK);
  });

  it('on Windows the provider refreshes are skipped and the local tasks still run', async () => {
    setPlatform('win32');
    await schedule(fakeWindow());
    await elapse(5_000);
    expect(ran(mockState.calls)).toEqual(
      TASKS.filter((task) => !PROVIDER_REFRESHES.has(task)),
    );
  });

  it('an E2E build without an opt-in schedules nothing', async () => {
    mockState.e2e = true;
    const fake = fakeWindow();
    const cancel = await schedule(fake);
    expect(jest.getTimerCount()).toBe(0);
    expect(attachedListeners(fake)).toBe(0);
    await elapse(HOUR);
    expect(mockState.calls).toEqual([]);
    expect(() => cancel()).not.toThrow();
  });

  it('an E2E build with only the stream-repair opt-in runs stream repair alone', async () => {
    mockState.e2e = true;
    process.env['CANOPY_E2E_STARTUP_STREAM_REPAIR'] = '1';
    await schedule(fakeWindow());
    await elapse(HOUR);
    expect(mockState.calls).toEqual(['stream-repair']);
  });

  it('the Codex staging sweep runs when the tasks fire, then every 12 hours', async () => {
    await schedule(fakeWindow());
    await elapse(5_000);
    const sweeps = (): number =>
      mockState.calls.filter((call) => call === 'codex-staging-sweep').length;
    expect(sweeps()).toBe(1);
    await elapse(12 * HOUR - 1);
    expect(sweeps()).toBe(1);
    await elapse(1);
    expect(sweeps()).toBe(2);
    await elapse(12 * HOUR);
    expect(sweeps()).toBe(3);
  });

  it('cancel before the tasks fire runs none of them and detaches the listeners', async () => {
    const fake = fakeWindow();
    const cancel = await schedule(fake);
    expect(attachedListeners(fake)).toBe(2);
    cancel();
    expect(attachedListeners(fake)).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    await elapse(HOUR);
    expect(mockState.calls).toEqual([]);
  });

  it('cancel after the tasks fire stops the Codex staging sweep interval', async () => {
    const cancel = await schedule(fakeWindow());
    await elapse(5_000);
    cancel();
    mockState.calls = [];
    await elapse(48 * HOUR);
    expect(mockState.calls).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("quit's stream-repair shutdown drains a started repair and is a no-op otherwise", async () => {
    const unstarted = await loadRunner();
    await unstarted.shutdownDeferredStartupStreamRepair();
    expect(mockState.calls).toEqual([]);

    const runner = await loadRunner();
    runner.scheduleDeferredStartupBackgroundTasks(() => fakeWindow().window);
    await elapse(5_000);
    expect(mockState.calls).toContain('stream-repair');
    mockState.calls = [];
    await runner.shutdownDeferredStartupStreamRepair();
    expect(mockState.calls).toEqual(['stream-repair-shutdown']);
  });

  it('a failing task records its fixed diagnostic and the other tasks still run', async () => {
    mockState.skillsRejects = true;
    mockState.ledgerThrows = true;
    await schedule(fakeWindow());
    await elapse(5_000);
    // The Summary publications wait for a settled Ledger pass, so they skip.
    expect(ran(mockState.calls)).toEqual(
      TASKS.filter((task) => task !== 'ledger-summary-publications'),
    );
    expect(mockState.diagnostics).toEqual(
      expect.arrayContaining([
        'ledger_scope_reconciliation: ledger unavailable',
        'skills_check_updates: offline',
      ]),
    );
    expect(mockState.diagnostics).toHaveLength(2);
  });
});
