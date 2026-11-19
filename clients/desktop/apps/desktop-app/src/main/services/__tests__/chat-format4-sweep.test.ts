/**
 * The background format 4 promotion sweep (CAN-7178): what it finds, what it
 * offers, when it waits and what it writes. The repository's own admission,
 * load and promotion are pinned separately; here the target is a recorder.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { ChatStorageV2 } from '../../lib/chat-storage-v2';
import { promoteToFormat4Journal } from '../../lib/chat-delta-journal/writer';
import { ChatStateV2Backend } from '../chat-state-v2-backend';
import type { ChatScopeKey } from '../chat-state-contracts';
import type { ChatFormat4Outcome } from '../chat-format4-telemetry';
import {
  CHAT_FORMAT4_SWEEP_FIRST_RETRY_MS,
  CHAT_FORMAT4_SWEEP_HELD_RETRY_MS,
  CHAT_FORMAT4_SWEEP_IDLE_MS,
  CHAT_FORMAT4_SWEEP_MIN_GAP_MS,
  CHAT_FORMAT4_SWEEP_PASS_INTERVAL_MS,
  CHAT_FORMAT4_SWEEP_COMPILED_ON,
  CHAT_FORMAT4_SWEEP_DISK_MARGIN_BYTES,
  CHAT_FORMAT4_SWEEP_SESSION_ATTEMPTS,
  ChatFormat4Sweep,
  chatFormat4FreeBytes,
  chatFormat4SweepComplete,
  chatFormat4SweepDonePath,
  chatFormat4SweepKey,
  listChatFormat4SweepCandidates,
  readChatFormat4SweepState,
  startChatFormat4Sweep,
  type ChatFormat4SweepAttempt,
  type ChatFormat4SweepClock,
  type ChatFormat4SweepConditions,
} from '../chat-format4-sweep';
import {
  message,
  scopeSource,
} from '../../__tests__/helpers/chat-delta-journal-harness';

jest.setTimeout(60_000);

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'format4-sweep-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const APP_MANAGED = new Set([
  'app-advisor',
  CODE_REVIEW_CHAT_PROJECT_ID,
  'shared-container-viewer',
]);

/** The same file families the canonical resolver gives each scope kind. */
function pathsFor(scope: ChatScopeKey): {
  tabs: string;
  archives: string;
  journal: string;
} {
  if (scope.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    return {
      tabs: join(dataDir, 'plan-explore-chats', `${scope.worktreeId}.json`),
      archives: join(
        dataDir,
        'workspaces',
        PLAN_EXPLORE_CHAT_PROJECT_ID,
        'chat-archives',
        `${scope.worktreeId}.json`,
      ),
      journal: join(dataDir, 'chat-journals', `${scope.worktreeId}.jsonl`),
    };
  }
  const root = join(
    dataDir,
    APP_MANAGED.has(scope.projectId) ? 'app-workspaces' : 'workspaces',
    scope.projectId,
  );
  return {
    tabs: join(root, 'chats', `${scope.worktreeId}.json`),
    archives: join(root, 'chat-archives', `${scope.worktreeId}.json`),
    journal: join(root, 'chat-journals', `${scope.worktreeId}.jsonl`),
  };
}

const resolveStore = (scope: ChatScopeKey): ChatStorageV2 =>
  ChatStorageV2.fromLegacyPaths(pathsFor(scope));

async function seedV2(scope: ChatScopeKey): Promise<ChatStorageV2> {
  const store = resolveStore(scope);
  await store.migrate(
    scopeSource([{ id: 'chat', messages: [message('m1', 'Hello', 'user')] }]),
  );
  return store;
}

async function seedV3(scope: ChatScopeKey): Promise<ChatStorageV2> {
  const store = await seedV2(scope);
  const backend = new ChatStateV2Backend(store, {
    enableFormat4: true,
    deltaJournal: {},
  });
  await backend.promoteToDeltaJournal();
  backend.releaseJournal();
  return store;
}

async function seedV4(scope: ChatScopeKey): Promise<ChatStorageV2> {
  const store = await seedV3(scope);
  await promoteToFormat4Journal(store);
  return store;
}

async function seedLegacy(scope: ChatScopeKey): Promise<void> {
  const { tabs } = pathsFor(scope);
  await mkdir(join(tabs, '..'), { recursive: true });
  await writeFile(tabs, JSON.stringify({ version: 1, tabs: [] }));
}

const WORKTREE = { projectId: 'project-a', worktreeId: 'worktree-1' };
const COWORK = { projectId: 'project-b', worktreeId: 'home' };
const ADVISOR = { projectId: 'app-advisor', worktreeId: 'entry-1' };
const PLAN = { projectId: PLAN_EXPLORE_CHAT_PROJECT_ID, worktreeId: 'plan-1' };
const REVIEW = {
  projectId: CODE_REVIEW_CHAT_PROJECT_ID,
  worktreeId: 'review-1',
};
const DONE = { projectId: 'project-c', worktreeId: 'worktree-9' };

/** A virtual clock: sleeping advances time at once and records the wait. */
function virtualClock(): ChatFormat4SweepClock & {
  sleeps: number[];
  time: number;
} {
  const clock = {
    time: 1_000_000,
    sleeps: [] as number[],
    now: (): number => clock.time,
    sleep: async (ms: number, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) return;
      clock.sleeps.push(ms);
      clock.time += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return clock;
}

function idleConditions(
  overrides: Partial<ChatFormat4SweepConditions> = {},
): ChatFormat4SweepConditions {
  return {
    turnInFlight: () => false,
    idleMs: () => CHAT_FORMAT4_SWEEP_IDLE_MS,
    onBattery: () => false,
    freeBytes: () => Promise.resolve(1024 ** 4),
    ...overrides,
  };
}

/** A target that promotes for real through the store, unless told otherwise. */
function recordingTarget(
  answer: (scope: ChatScopeKey) => ChatFormat4SweepAttempt | undefined = () =>
    undefined,
): {
  calls: string[];
  allowed: boolean;
  sweepFormat4: (scope: ChatScopeKey) => Promise<ChatFormat4SweepAttempt>;
  promotionAllowed: () => boolean;
} {
  const target = {
    calls: [] as string[],
    allowed: true,
    async sweepFormat4(scope: ChatScopeKey): Promise<ChatFormat4SweepAttempt> {
      target.calls.push(`${scope.projectId}/${scope.worktreeId}`);
      const scripted = answer(scope);
      if (scripted) return scripted;
      const store = resolveStore(scope);
      if ((await store.format()) === 'v4')
        return { outcome: 'already_format4' };
      await store
        .migrate(
          scopeSource([
            { id: 'chat', messages: [message('m1', 'Hello', 'user')] },
          ]),
        )
        .catch(() => undefined);
      if ((await store.format()) === 'v2') {
        const backend = new ChatStateV2Backend(store, {
          enableFormat4: true,
          deltaJournal: {},
        });
        await backend.promoteToDeltaJournal();
        backend.releaseJournal();
      }
      await promoteToFormat4Journal(store);
      return { outcome: 'promoted' };
    },
    promotionAllowed: (): boolean => target.allowed,
  };
  return target;
}

function sweep(
  target: ReturnType<typeof recordingTarget>,
  options: {
    clock?: ReturnType<typeof virtualClock>;
    conditions?: ChatFormat4SweepConditions;
    reports?: ChatFormat4Outcome[];
    resolveStore?: (scope: ChatScopeKey) => ChatStorageV2;
  } = {},
): ChatFormat4Sweep {
  return new ChatFormat4Sweep({
    dataDir,
    target,
    resolveStore: options.resolveStore ?? resolveStore,
    conditions: options.conditions ?? idleConditions(),
    clock: options.clock ?? virtualClock(),
    report: (outcome) => options.reports?.push(outcome),
  });
}

describe('the inventory', () => {
  it('finds every stored scope below format 4 by its manifest alone, and leaves viewer and code-review scopes out of the offer', async () => {
    await seedV3(WORKTREE);
    await seedV2(COWORK);
    await seedV3(ADVISOR);
    await seedV3(PLAN);
    await seedV3(REVIEW);
    await seedV4(DONE);
    await seedLegacy({ projectId: 'project-d', worktreeId: 'old' });

    const inventory = await listChatFormat4SweepCandidates(
      dataDir,
      resolveStore,
    );
    const formats = Object.fromEntries(
      inventory.candidates.map((item) => [
        `${item.scope.projectId}/${item.scope.worktreeId}`,
        [item.format, item.excluded],
      ]),
    );
    expect(formats).toEqual({
      'project-a/worktree-1': ['v3', false],
      'project-b/home': ['v2', false],
      'app-advisor/entry-1': ['v3', false],
      [`${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1`]: ['v3', false],
      [`${CODE_REVIEW_CHAT_PROJECT_ID}/review-1`]: ['v3', true],
      'project-c/worktree-9': ['v4', false],
      'project-d/old': ['v1', false],
    });
    expect(inventory.unmapped).toBe(0);
  });

  it('counts a stored scope it cannot map back to a scope key as unmapped', async () => {
    await mkdir(join(dataDir, 'chat-storage-manifests'), { recursive: true });
    await writeFile(
      join(dataDir, 'chat-storage-manifests', 'stray.json'),
      JSON.stringify({ version: 3 }),
    );
    const inventory = await listChatFormat4SweepCandidates(
      dataDir,
      resolveStore,
    );
    expect(inventory.unmapped).toBe(1);
  });
});

describe('a pass', () => {
  it('promotes every offered scope once and writes the done marker only when nothing is left below format 4', async () => {
    await seedV3(WORKTREE);
    await seedV2(COWORK);
    await seedV4(DONE);
    const target = recordingTarget();
    const reports: ChatFormat4Outcome[] = [];
    const result = await sweep(target, { reports }).runPass();

    expect(target.calls.sort()).toEqual([
      'project-a/worktree-1',
      'project-b/home',
    ]);
    expect(result).toMatchObject({
      status: 'complete',
      promoted: 2,
      remaining: 0,
    });
    expect(await resolveStore(WORKTREE).format()).toBe('v4');
    expect(await resolveStore(COWORK).format()).toBe('v4');
    expect(await chatFormat4SweepComplete(dataDir)).toBe(true);
    expect(reports).toContainEqual({
      event: 'sweep_pass_completed',
      remaining: 0,
    });
  });

  it('never offers an excluded scope, and keeps the sweep incomplete while one is below format 4', async () => {
    await seedV3(REVIEW);
    const target = recordingTarget();
    const result = await sweep(target).runPass();
    expect(target.calls).toEqual([]);
    expect(result.status).toBe('remaining');
    expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
  });

  it('waits at least four times the last scope’s time, and never less than the minimum gap', async () => {
    await seedV3(WORKTREE);
    await seedV3(COWORK);
    const clock = virtualClock();
    const target = recordingTarget(() => {
      clock.time += 10_000;
      return { outcome: 'promoted' };
    });
    await sweep(target, { clock }).runPass();
    expect(clock.sleeps).toEqual([40_000, 40_000]);

    const quick = virtualClock();
    await sweep(
      recordingTarget(() => ({ outcome: 'promoted' })),
      {
        clock: quick,
      },
    ).runPass();
    expect(quick.sleeps).toEqual([
      CHAT_FORMAT4_SWEEP_MIN_GAP_MS,
      CHAT_FORMAT4_SWEEP_MIN_GAP_MS,
    ]);
  });

  it('checks the disk again before writing the done marker, so a target that only claims success leaves it unwritten', async () => {
    await seedV3(WORKTREE);
    const result = await sweep(
      recordingTarget(() => ({ outcome: 'promoted' })),
    ).runPass();
    expect(result.status).toBe('remaining');
    expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
  });
});

describe('a held scope', () => {
  it('is skipped with no write, offered again later, and never lets the done marker through', async () => {
    const store = await seedV3(WORKTREE);
    const manifestBefore = await readFile(store.manifestPath);
    const clock = virtualClock();
    const target = recordingTarget(() => ({ outcome: 'held' }));
    const running = sweep(target, { clock });

    const first = await running.runPass();
    expect(first.status).toBe('remaining');
    expect(target.calls).toEqual(['project-a/worktree-1']);
    expect(await readFile(store.manifestPath)).toEqual(manifestBefore);
    expect(await chatFormat4SweepComplete(dataDir)).toBe(false);

    await running.runPass();
    expect(target.calls).toHaveLength(1);
    clock.time += CHAT_FORMAT4_SWEEP_HELD_RETRY_MS[0];
    await running.runPass();
    expect(target.calls).toHaveLength(2);
  });
});

/** Waits, in real time and bounded, until the sweep has reported `event`. */
async function untilReported(
  reports: readonly ChatFormat4Outcome[],
  event: ChatFormat4Outcome['event'],
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!reports.some((item) => item.event === event)) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Yields one event-loop turn at a time until `done` holds, bounded in real
 * time rather than by a turn count: each sweep pass waits on real disk I/O,
 * which a loaded runner can stretch past any fixed number of turns. Checking
 * every turn keeps a running sweep's virtual clock from passing the test.
 * Throws when the deadline passes, so a test never goes on without the state
 * it waited for.
 */
async function untilTurn(
  done: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await done())) {
    if (Date.now() > deadline)
      throw new Error('The sweep did not reach the awaited state within 30 s.');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('pacing', () => {
  it.each([
    ['a turn in flight', { turnInFlight: (): boolean => true }, 'activity'],
    [
      'recent input',
      { idleMs: (): number => CHAT_FORMAT4_SWEEP_IDLE_MS - 1 },
      'activity',
    ],
    ['battery power', { onBattery: (): boolean => true }, 'battery'],
  ] as const)(
    'with %s, no scope starts and the pause is reported once',
    async (_label, override, reason) => {
      await seedV3(WORKTREE);
      const target = recordingTarget();
      const reports: ChatFormat4Outcome[] = [];
      const clock = virtualClock();
      const running = sweep(target, {
        clock,
        reports,
        conditions: idleConditions(override),
      });
      const pass = running.runPass();
      await untilReported(reports, 'sweep_paused');
      await running.stop();
      await pass;
      expect(target.calls).toEqual([]);
      expect(reports.filter((item) => item.event === 'sweep_paused')).toEqual([
        { event: 'sweep_paused', reason },
      ]);
    },
  );

  it('reports the pause even when the inventory is slower than the test runner (CI, review round 8)', async () => {
    await seedV3(WORKTREE);
    const target = recordingTarget();
    const reports: ChatFormat4Outcome[] = [];
    const slowStore = (scope: ChatScopeKey): ChatStorageV2 => {
      const store = resolveStore(scope);
      const read = store.format.bind(store);
      return Object.assign(store, {
        format: async (): Promise<
          Awaited<ReturnType<ChatStorageV2['format']>>
        > => {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          return read();
        },
      });
    };
    const running = sweep(target, {
      reports,
      resolveStore: slowStore,
      conditions: idleConditions({ turnInFlight: (): boolean => true }),
    });
    const pass = running.runPass();
    await untilReported(reports, 'sweep_paused');
    await running.stop();
    await pass;
    expect(target.calls).toEqual([]);
    expect(reports.filter((item) => item.event === 'sweep_paused')).toEqual([
      { event: 'sweep_paused', reason: 'activity' },
    ]);
  });

  it('skips a scope without room for twice its size plus the margin', async () => {
    await seedV3(WORKTREE);
    const target = recordingTarget();
    const reports: ChatFormat4Outcome[] = [];
    await sweep(target, {
      reports,
      conditions: idleConditions({ freeBytes: () => Promise.resolve(1024) }),
    }).runPass();
    expect(target.calls).toEqual([]);
    expect(reports).toContainEqual({ event: 'sweep_paused', reason: 'disk' });
  });
});

describe('the format 4 stop switch', () => {
  it('with the switch off, no scope is offered and nothing is marked complete', async () => {
    await seedV3(WORKTREE);
    const target = recordingTarget();
    target.allowed = false;
    const reports: ChatFormat4Outcome[] = [];
    const result = await sweep(target, { reports }).runPass();
    expect(result.status).toBe('withheld');
    expect(target.calls).toEqual([]);
    expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
    expect(reports).toEqual([{ event: 'sweep_paused', reason: 'switch_off' }]);
  });

  it('turned off mid-pass, stops before the next scope', async () => {
    await seedV3(WORKTREE);
    await seedV3(COWORK);
    const target = recordingTarget(() => {
      target.allowed = false;
      return { outcome: 'promoted' };
    });
    const result = await sweep(target).runPass();
    expect(target.calls).toHaveLength(1);
    expect(result.status).toBe('withheld');
  });
});

describe('a persistently failing scope', () => {
  it('takes five attempts a session, then sits out 1, 2 and 4 launches, and never blocks the others', async () => {
    await seedV3(WORKTREE);
    await seedV3(COWORK);
    const failing = 'project-a/worktree-1';
    const key = chatFormat4SweepKey(resolveStore(WORKTREE).directory);
    const answer = (
      scope: ChatScopeKey,
    ): ChatFormat4SweepAttempt | undefined =>
      `${scope.projectId}/${scope.worktreeId}` === failing
        ? { outcome: 'failed', reason: 'integrity' }
        : undefined;

    const launches: Array<{ attempts: number; backedOff: number }> = [];
    for (let launch = 0; launch < 8; launch += 1) {
      const target = recordingTarget(answer);
      const reports: ChatFormat4Outcome[] = [];
      const clock = virtualClock();
      const running = sweep(target, { clock, reports });
      await running.beginLaunch();
      for (let pass = 0; pass < 10; pass += 1) {
        clock.time += 3_600_000;
        await running.runPass();
      }
      launches.push({
        attempts: target.calls.filter((call) => call === failing).length,
        backedOff: reports.filter(
          (item) => item.event === 'sweep_scope_backed_off',
        ).length,
      });
      expect(await resolveStore(COWORK).format()).toBe('v4');
    }

    const offered = launches.map((item) => item.attempts > 0);
    // Launch 1 fails it 5 times; it then sits out 1, then 2, then 4 launches.
    expect(offered).toEqual([
      true,
      false,
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(launches[0]).toEqual({
      attempts: CHAT_FORMAT4_SWEEP_SESSION_ATTEMPTS,
      backedOff: 1,
    });
    const state = await readChatFormat4SweepState(dataDir);
    expect(state.scopes[key]?.failedSessions).toBe(3);
    expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
  });

  it('reports only a reason code, never a scope identifier', async () => {
    await seedV3(WORKTREE);
    const reports: ChatFormat4Outcome[] = [];
    const clock = virtualClock();
    const running = sweep(
      recordingTarget(() => ({ outcome: 'failed', reason: 'disk_full' })),
      { clock, reports },
    );
    for (let pass = 0; pass < CHAT_FORMAT4_SWEEP_SESSION_ATTEMPTS; pass += 1) {
      clock.time += 3_600_000;
      await running.runPass();
    }
    const backedOff = reports.filter(
      (item) => item.event === 'sweep_scope_backed_off',
    );
    expect(backedOff).toEqual([
      { event: 'sweep_scope_backed_off', reason: 'disk_full' },
    ]);
    expect(JSON.stringify(reports)).not.toMatch(/project-a|worktree-1/);
  });
});

describe('the state file', () => {
  it('counts launches and keeps only content-free keys', async () => {
    await seedV3(WORKTREE);
    for (let launch = 0; launch < 2; launch += 1) {
      const running = sweep(recordingTarget(() => ({ outcome: 'held' })));
      await running.beginLaunch();
      await running.runPass();
    }
    const raw = await readFile(
      join(dataDir, 'chat-format4-sweep-state.json'),
      'utf8',
    );
    expect(JSON.parse(raw)).toMatchObject({ version: 1, launch: 2 });
    expect(raw).not.toMatch(/project-a|worktree-1/);
    await expect(
      stat(join(dataDir, 'chat-format4-sweep-complete.json')),
    ).rejects.toThrow();
  });
});

/** A Node timer's `hasRef()`, read without trusting the spy's `any`. */
function timerHasRef(timer: unknown): boolean | undefined {
  if (typeof timer !== 'object' || timer === null) return undefined;
  const method: unknown = Reflect.get(timer, 'hasRef');
  return typeof method === 'function'
    ? Boolean(Reflect.apply(method, timer, []))
    : undefined;
}

describe('the real clock', () => {
  it('waits on an unref’d setTimeout, so the sweep never keeps the app alive, and stop wakes it at once', async () => {
    const timers = jest.spyOn(global, 'setTimeout');
    try {
      const running = new ChatFormat4Sweep({
        dataDir,
        target: recordingTarget(),
        resolveStore,
        conditions: idleConditions(),
      });
      running.start(60_000);
      const call = timers.mock.calls.findIndex(([, ms]) => ms === 60_000);
      expect(call).toBeGreaterThanOrEqual(0);
      const timer: unknown = timers.mock.results[call]?.value;
      expect(timerHasRef(timer)).toBe(false);
      await expect(running.stop()).resolves.toBeUndefined();
    } finally {
      timers.mockRestore();
    }
  });
});

describe('dormant in this release (CAN-7178 PR 1)', () => {
  it('is compiled off, and admits no scope even with the format 4 switch on', async () => {
    expect(CHAT_FORMAT4_SWEEP_COMPILED_ON).toBe(false);
    await seedV3(WORKTREE);
    const sweepFormat4 = jest.fn(
      (): Promise<ChatFormat4SweepAttempt> =>
        Promise.resolve({ outcome: 'promoted' }),
    );
    const previous = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = dataDir;
    resetResolvedCanopyDataDirForTests();
    jest.useFakeTimers();
    try {
      expect(
        startChatFormat4Sweep({ sweepFormat4 }, () => true),
      ).toBeUndefined();
      await jest.advanceTimersByTimeAsync(7 * 24 * 3_600_000);
    } finally {
      jest.useRealTimers();
      if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = previous;
      resetResolvedCanopyDataDirForTests();
    }
    expect(sweepFormat4).not.toHaveBeenCalled();
    expect(await resolveStore(WORKTREE).format()).toBe('v3');
    await expect(
      stat(join(dataDir, 'chat-format4-sweep-state.json')),
    ).rejects.toThrow();
  });
});

describe('review round 1 fixes', () => {
  it('does not count the code-review registry as a scope, so the done marker is written', async () => {
    await seedV3(WORKTREE);
    const registry = join(
      dataDir,
      'app-workspaces',
      CODE_REVIEW_CHAT_PROJECT_ID,
      'chats',
      'registry.json',
    );
    await mkdir(join(registry, '..'), { recursive: true });
    await writeFile(registry, JSON.stringify({ version: 1, entries: {} }));
    const result = await sweep(recordingTarget()).runPass();
    expect(result.status).toBe('complete');
    expect(await chatFormat4SweepComplete(dataDir)).toBe(true);
  });

  it('checks free space on the nearest existing folder for a legacy-only workspace, and treats unknown space as no room', async () => {
    const legacy = { projectId: 'project-legacy', worktreeId: 'old' };
    await seedLegacy(legacy);
    const asked: string[] = [];
    const target = recordingTarget();
    const reports: ChatFormat4Outcome[] = [];
    await sweep(target, {
      reports,
      conditions: idleConditions({
        freeBytes: (path): Promise<number | undefined> => {
          asked.push(path);
          return Promise.resolve(undefined);
        },
      }),
    }).runPass();
    expect(target.calls).toEqual([]);
    expect(reports).toContainEqual({ event: 'sweep_paused', reason: 'disk' });
    expect(asked).toHaveLength(1);
    expect((await stat(asked[0] ?? '')).isDirectory()).toBe(true);
  });
});

describe('free space that cannot be read', () => {
  it('reads as unknown for a path with no existing ancestor, and unknown space pauses the sweep on disk', async () => {
    expect(
      await chatFormat4FreeBytes(join(dataDir, 'missing', 'volume', 'scope')),
    ).toBeUndefined();
    await seedV3(WORKTREE);
    const target = recordingTarget();
    const reports: ChatFormat4Outcome[] = [];
    await sweep(target, {
      reports,
      conditions: idleConditions({
        freeBytes: (): Promise<number | undefined> =>
          Promise.resolve(undefined),
      }),
    }).runPass();
    expect(target.calls).toEqual([]);
    expect(reports).toContainEqual({ event: 'sweep_paused', reason: 'disk' });
  });
});

describe('legacy scopes the inventory keeps (review round 2)', () => {
  async function inventoryOf(
    write: (paths: { tabs: string; archives: string }) => Promise<void>,
  ): Promise<string[]> {
    const scope = { projectId: 'project-legacy', worktreeId: 'old' };
    const paths = pathsFor(scope);
    await mkdir(join(paths.tabs, '..'), { recursive: true });
    await mkdir(join(paths.archives, '..'), { recursive: true });
    await write(paths);
    const inventory = await listChatFormat4SweepCandidates(
      dataDir,
      resolveStore,
    );
    return inventory.candidates.map(
      (item) => `${item.scope.worktreeId}:${item.format}`,
    );
  }

  it('keeps a scope whose primary file is corrupt but has a .bak snapshot', async () => {
    expect(
      await inventoryOf(async ({ tabs }) => {
        await writeFile(tabs, '{ corrupt');
        await writeFile(
          `${tabs}.bak`,
          JSON.stringify({ version: 1, tabs: [] }),
        );
      }),
    ).toEqual(['old:v1']);
  });

  it('keeps a scope whose primary file is corrupt with no snapshot, so it is offered and counted', async () => {
    expect(
      await inventoryOf(async ({ tabs }) => {
        await writeFile(tabs, '{ corrupt');
      }),
    ).toEqual(['old:v1']);
  });

  it('keeps a scope that has only its archives file', async () => {
    expect(
      await inventoryOf(async ({ archives }) => {
        await writeFile(archives, JSON.stringify({ version: 1, archived: [] }));
      }),
    ).toEqual(['old:v1']);
  });

  it('skips a primary JSON file that is not a chats file, with nothing beside it', async () => {
    expect(
      await inventoryOf(async ({ tabs }) => {
        await writeFile(tabs, JSON.stringify({ version: 1, entries: {} }));
      }),
    ).toEqual([]);
  });
});

describe('archives are not swept (SWAN, 17 Nov)', () => {
  it('counts a legacy scope with only its archived-tabs file but never offers it, and leaves that file byte-unchanged', async () => {
    const scope = { projectId: 'project-legacy', worktreeId: 'archived-only' };
    const { archives } = pathsFor(scope);
    await mkdir(join(archives, '..'), { recursive: true });
    await writeFile(archives, JSON.stringify({ version: 1, archived: [] }));
    const before = await readFile(archives);
    const target = recordingTarget();
    const result = await sweep(target).runPass();
    expect(target.calls).toEqual([]);
    expect(result.status).toBe('remaining');
    expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
    expect(await readFile(archives)).toEqual(before);
  });

  it('counts a legacy scope with only its tabs backup or only its journal, offers neither, and leaves both byte-unchanged (review round 3, SWAN 17 Nov)', async () => {
    const backupOnly = { projectId: 'project-legacy', worktreeId: 'bak-only' };
    const planBackupOnly = {
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-bak',
    };
    const journalOnly = {
      projectId: 'project-legacy',
      worktreeId: 'journal-only',
    };
    const planJournalOnly = {
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-journal',
    };
    const kept: string[] = [];
    for (const scope of [backupOnly, planBackupOnly]) {
      const { tabs } = pathsFor(scope);
      await mkdir(join(tabs, '..'), { recursive: true });
      await writeFile(`${tabs}.bak`, JSON.stringify({ version: 1, tabs: [] }));
      kept.push(`${tabs}.bak`);
    }
    for (const scope of [journalOnly, planJournalOnly]) {
      const { journal } = pathsFor(scope);
      await mkdir(join(journal, '..'), { recursive: true });
      await writeFile(journal, '{"revision":1}\n');
      kept.push(journal);
    }
    const before = await Promise.all(kept.map((path) => readFile(path)));
    const inventory = await listChatFormat4SweepCandidates(
      dataDir,
      resolveStore,
    );
    expect(
      inventory.candidates
        .map((item) => `${item.scope.worktreeId}:${String(item.excluded)}`)
        .sort(),
    ).toEqual([
      'bak-only:true',
      'journal-only:true',
      'plan-bak:true',
      'plan-journal:true',
    ]);
    const target = recordingTarget();
    const result = await sweep(target).runPass();
    expect(target.calls).toEqual([]);
    expect(result).toMatchObject({ status: 'remaining', remaining: 4 });
    expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
    expect(await Promise.all(kept.map((path) => readFile(path)))).toEqual(
      before,
    );
    for (const scope of [backupOnly, planBackupOnly])
      await expect(stat(pathsFor(scope).tabs)).rejects.toThrow();
  });

  it('with every other scope in format 4, one journal-only scope still keeps the sweep pending and never complete (SWAN, 17 Nov)', async () => {
    await seedV4(WORKTREE);
    await seedV4(COWORK);
    await seedV3(DONE);
    const journalOnly = { projectId: 'project-legacy', worktreeId: 'j-only' };
    const { journal } = pathsFor(journalOnly);
    await mkdir(join(journal, '..'), { recursive: true });
    await writeFile(journal, '');
    await writeFile(
      chatFormat4SweepDonePath(dataDir),
      JSON.stringify({ stale: true }),
    );
    const target = recordingTarget();
    for (let pass = 0; pass < 3; pass += 1) {
      const result = await sweep(target).runPass();
      expect(result).toMatchObject({ status: 'remaining', remaining: 1 });
      expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
    }
    expect(target.calls).toEqual([`${DONE.projectId}/${DONE.worktreeId}`]);
    expect(await readFile(journal, 'utf8')).toBe('');
  });

  it('never reads an archived container into the inventory, and writes nothing under it', async () => {
    await seedV3(WORKTREE);
    const container = join(
      dataDir,
      'workspaces',
      WORKTREE.projectId,
      'archived-containers',
      'container-1',
    );
    await mkdir(join(container, 'chats'), { recursive: true });
    const chats = join(container, 'chats', 'home.json');
    await writeFile(chats, JSON.stringify({ version: 1, tabs: [] }));
    const before = await readFile(chats);
    const inventory = await listChatFormat4SweepCandidates(
      dataDir,
      resolveStore,
    );
    expect(inventory.candidates.map((item) => item.scope.worktreeId)).toEqual([
      'worktree-1',
    ]);
    const result = await sweep(recordingTarget()).runPass();
    expect(result.status).toBe('complete');
    expect(await readFile(chats)).toEqual(before);
    expect((await readdir(container, { recursive: true })).sort()).toEqual([
      'chats',
      join('chats', 'home.json'),
    ]);
  });
});

describe('legacy scopes the sweep can only partly read (review round 4)', () => {
  const scope = { projectId: 'project-legacy', worktreeId: 'locked' };

  it('keeps a scope whose tabs file it cannot read, so the sweep never completes over it', async () => {
    const { tabs } = pathsFor(scope);
    await mkdir(join(tabs, '..'), { recursive: true });
    await writeFile(tabs, JSON.stringify({ version: 1, tabs: [] }));
    await chmod(tabs, 0o000);
    try {
      const inventory = await listChatFormat4SweepCandidates(
        dataDir,
        resolveStore,
      );
      expect(
        inventory.candidates.map((item) => [
          item.scope.worktreeId,
          item.format,
          item.excluded,
        ]),
      ).toEqual([['locked', 'v1', false]]);
      const target = recordingTarget(() => ({
        outcome: 'failed',
        reason: 'permission',
      }));
      const result = await sweep(target).runPass();
      expect(target.calls).toEqual(['project-legacy/locked']);
      expect(result.status).toBe('remaining');
      expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
    } finally {
      await chmod(tabs, 0o600);
    }
  });

  it('counts a tabs backup toward the room a scope needs, since migration can recover from it', async () => {
    const { tabs } = pathsFor(scope);
    await mkdir(join(tabs, '..'), { recursive: true });
    await writeFile(tabs, '{]');
    const backup = Buffer.alloc(1024 * 1024, 0x20);
    await writeFile(`${tabs}.bak`, backup);
    const inventory = await listChatFormat4SweepCandidates(
      dataDir,
      resolveStore,
    );
    expect(inventory.candidates[0]?.bytes).toBeGreaterThanOrEqual(
      backup.length,
    );
    const target = recordingTarget();
    const reports: ChatFormat4Outcome[] = [];
    await sweep(target, {
      reports,
      conditions: idleConditions({
        freeBytes: (): Promise<number | undefined> =>
          Promise.resolve(CHAT_FORMAT4_SWEEP_DISK_MARGIN_BYTES + backup.length),
      }),
    }).runPass();
    expect(target.calls).toEqual([]);
    expect(reports).toContainEqual({ event: 'sweep_paused', reason: 'disk' });
  });
});

describe('a sweep that keeps going (review round 5)', () => {
  it('counts a workspace whose chat folder it cannot list, and still sweeps every other workspace', async () => {
    await seedV3(WORKTREE);
    await seedV3(COWORK);
    const locked = join(dataDir, 'workspaces', 'project-z', 'chats');
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o000);
    try {
      const inventory = await listChatFormat4SweepCandidates(
        dataDir,
        resolveStore,
      );
      expect(inventory.unmapped).toBeGreaterThanOrEqual(1);
      const target = recordingTarget();
      const result = await sweep(target).runPass();
      expect(target.calls.sort()).toEqual([
        `${WORKTREE.projectId}/${WORKTREE.worktreeId}`,
        `${COWORK.projectId}/${COWORK.worktreeId}`,
      ]);
      expect(result.status).toBe('remaining');
      expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it('retries a failing scope on its own backoff, 30 s and doubling, not at the next ten-minute pass', async () => {
    await seedV3(WORKTREE);
    const clock = virtualClock();
    const times: number[] = [];
    let stopping: Promise<void> | undefined;
    const target = recordingTarget(() => {
      times.push(clock.time);
      if (times.length === CHAT_FORMAT4_SWEEP_SESSION_ATTEMPTS)
        stopping = running.stop();
      return { outcome: 'failed', reason: 'io' };
    });
    const running = sweep(target, { clock });
    running.start(0);
    await untilTurn(() => stopping !== undefined);
    await stopping;
    expect(times).toHaveLength(CHAT_FORMAT4_SWEEP_SESSION_ATTEMPTS);
    const gaps = times
      .slice(1)
      .map((time, index) => time - (times[index] ?? 0));
    gaps.forEach((gap, index) => {
      const backoff = CHAT_FORMAT4_SWEEP_FIRST_RETRY_MS * 2 ** index;
      expect(gap).toBeGreaterThanOrEqual(backoff);
      expect(gap).toBeLessThan(backoff + CHAT_FORMAT4_SWEEP_MIN_GAP_MS * 4);
    });
  });
});

describe('a sweep that keeps going (review round 6)', () => {
  it('keeps waiting while the switch reads off, then sweeps once it turns on', async () => {
    await seedV3(WORKTREE);
    const clock = virtualClock();
    const reports: ChatFormat4Outcome[] = [];
    const target = recordingTarget();
    target.allowed = false;
    const running = sweep(target, { clock, reports });
    running.start(0);
    await untilTurn(() =>
      reports.some(
        (item) => item.event === 'sweep_paused' && item.reason === 'switch_off',
      ),
    );
    expect(target.calls).toEqual([]);
    target.allowed = true;
    await untilTurn(() => chatFormat4SweepComplete(dataDir));
    await running.stop();
    expect(target.calls).toEqual([
      `${WORKTREE.projectId}/${WORKTREE.worktreeId}`,
    ]);
    expect(await chatFormat4SweepComplete(dataDir)).toBe(true);
  });

  it('retries a failed scope as soon as it is due, even when the pass ran past its deadline', async () => {
    await seedV3(WORKTREE);
    const clock = virtualClock();
    const failed: number[] = [];
    let stopping: Promise<void> | undefined;
    const target = recordingTarget(() => {
      failed.push(clock.time);
      clock.time += 60_000;
      if (failed.length === 2) stopping = running.stop();
      return { outcome: 'failed', reason: 'io' };
    });
    const running = sweep(target, { clock });
    running.start(0);
    await untilTurn(() => stopping !== undefined);
    await stopping;
    expect(failed).toHaveLength(2);
    expect((failed[1] ?? 0) - (failed[0] ?? 0)).toBeLessThan(
      CHAT_FORMAT4_SWEEP_PASS_INTERVAL_MS,
    );
  });
});

describe('a sweep that stays paced (review round 7)', () => {
  it('while a failed scope waits on disk room, passes stay a pass interval apart instead of every few seconds', async () => {
    await seedV3(WORKTREE);
    const clock = virtualClock();
    const start = clock.time;
    const reports: ChatFormat4Outcome[] = [];
    let roomChecks = 0;
    const target = recordingTarget(() => ({
      outcome: 'failed',
      reason: 'disk_full',
    }));
    const running = sweep(target, {
      clock,
      reports,
      conditions: idleConditions({
        freeBytes: (): Promise<number | undefined> => {
          roomChecks += 1;
          return Promise.resolve(roomChecks === 1 ? 1024 ** 4 : 0);
        },
      }),
    });
    running.start(0);
    await untilTurn(
      () => clock.time - start >= 3 * CHAT_FORMAT4_SWEEP_PASS_INTERVAL_MS,
    );
    await running.stop();
    expect(target.calls).toHaveLength(1);
    expect(
      reports.filter((item) => item.event === 'sweep_pass_completed').length,
    ).toBeLessThanOrEqual(4);
  });
});
