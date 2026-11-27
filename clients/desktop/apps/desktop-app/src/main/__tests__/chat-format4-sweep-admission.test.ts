/**
 * The repository's format 4 sweep admission (CAN-7178): it never waits
 * behind or takes a scope from another holder, yields to a user who arrives
 * before its load, and unloads only a scope it alone still holds.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import type { DeltaJournalBoundary } from '../lib/chat-delta-journal/writer';
import { ChatDeltaJournalIntegrityError } from '../lib/chat-delta-journal/format';
import { ChatTranscriptIntegrityError } from '../lib/chat-transcript-log';
import {
  ensureFormat4,
  runChatFormat4PreHandoffPass,
} from '../services/chat-format4-pre-handoff';
import { isChatFormat4PromotionEnabled } from '../services/chat-format4-promotion-flag';
import { createEmptyChatTabsFile } from '@canopy/desktop-shared/persisted-chat-state';
import type { ChatFormat4Outcome } from '../services/chat-format4-telemetry';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import type { ChatScopeKey } from '../services/chat-state-contracts';
import {
  ChatFormat4Sweep,
  chatFormat4SweepComplete,
  repositoryChatFormat4SweepTarget,
  type ChatFormat4SweepAttempt,
} from '../services/chat-format4-sweep';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import {
  drainOpenRepositories,
  idle,
  streaming,
} from './helpers/chat-delta-journal-scope';

jest.setTimeout(60_000);

const SCOPE: ChatScopeKey = { projectId: 'project', worktreeId: 'scope' };

let dataDir: string;
let promotion = true;
let pinned = false;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'format4-sweep-admission-'));
  process.env.CANOPY_DATA_DIR = dataDir;
  resetResolvedCanopyDataDirForTests();
  promotion = true;
  pinned = false;
});

afterEach(async () => {
  await drainOpenRepositories();
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(dataDir, { recursive: true, force: true });
});

function pathsFor(scope: ChatScopeKey): {
  tabs: string;
  archives: string;
  journal: string;
} {
  const workspace = join(dataDir, 'workspaces', scope.projectId);
  return {
    tabs: join(workspace, 'chats', `${scope.worktreeId}.json`),
    archives: join(workspace, 'chat-archives', `${scope.worktreeId}.json`),
    journal: join(workspace, 'chat-journals', `${scope.worktreeId}.jsonl`),
  };
}

const storeFor = (scope: ChatScopeKey = SCOPE): ChatStorageV2 =>
  ChatStorageV2.fromLegacyPaths(pathsFor(scope));

/** A format 3 scope with one acknowledged record; its turn is settled unless `streamingLeft`. */
async function seedV3(
  scope: ChatScopeKey = SCOPE,
  streamingLeft = false,
): Promise<ChatStorageV2> {
  const store = storeFor(scope);
  await store.migrate(
    scopeSource([
      { id: 'chat', messages: [message('initial', 'Initial', 'user')] },
    ]),
  );
  const backend = new ChatStateV2Backend(store, {
    enableFormat4: true,
    deltaJournal: {},
  });
  await backend.promoteToDeltaJournal();
  await backend.transact(
    () => [
      streaming('chat', 'initial'),
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: message('pending', 'Pending'),
      },
      ...(streamingLeft ? [] : [idle('chat')]),
    ],
    { source: 'provider', mutationId: 'pending' },
  );
  backend.releaseJournal();
  return store;
}

function repository(
  onBoundary?: (point: DeltaJournalBoundary) => Promise<void>,
): ChatStateV2Repository {
  return new ChatStateV2Repository({
    resolvePaths: pathsFor,
    enableFormat4: true,
    format4Promotion: () => promotion,
    isScopePinned: () => pinned,
    deltaJournalIncrementalStreamMetadata: true,
    deltaJournalIdleCheckpointMs: 60_000,
    idleScopeUnloadMs: 0,
    ...(onBoundary ? { deltaJournalOnBoundary: onBoundary } : {}),
  });
}

async function rows(target: ChatStateV2Repository): Promise<string[]> {
  const state = await target.getState(SCOPE, {
    chatIds: ['chat'],
    fullTranscript: true,
  });
  return state.tabsFile.tabs[0]?.messages.map((row) => row.id) ?? [];
}

describe('a scope the sweep alone holds', () => {
  it('is promoted and unloaded again, and the next admission finds it in format 4', async () => {
    await seedV3();
    const target = repository();
    expect(await target.sweepFormat4(SCOPE)).toEqual({ outcome: 'promoted' });
    expect(await storeFor().format()).toBe('v4');
    expect(target.getLifecycle(SCOPE)).toBe('unloaded');
    // Nothing the load queued brings it back once its cleanup has run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(target.getLifecycle(SCOPE)).toBe('unloaded');
    expect(await target.sweepFormat4(SCOPE)).toEqual({
      outcome: 'already_format4',
    });
    expect(await rows(target)).toEqual(['initial', 'pending']);
    await target.drainAll();
  });

  it('a scope whose turn was left streaming stays loaded, as the idle unload would keep it', async () => {
    await seedV3(SCOPE, true);
    const target = repository();
    expect(await target.sweepFormat4(SCOPE)).toEqual({ outcome: 'promoted' });
    expect(target.getLifecycle(SCOPE)).toBe('ready');
    expect(target.residencySnapshot()[0]?.blockers).toContain(
      'maintenance-dirty',
    );
    await target.drainAll();
  });

  it('with the switch off, reaches format 3 at most, says so, and is unloaded', async () => {
    await seedV3();
    promotion = false;
    const target = repository();
    expect(await target.sweepFormat4(SCOPE)).toEqual({ outcome: 'withheld' });
    expect(await storeFor().format()).toBe('v3');
    expect(target.getLifecycle(SCOPE)).toBe('unloaded');
    await target.drainAll();
  });
});

describe('a scope someone else holds (the lease rule)', () => {
  it('a scope a window has open is refused without a read or a write, stays open, and the sweep writes no done marker', async () => {
    const store = await seedV3();
    promotion = false;
    const target = repository();
    expect(await rows(target)).toEqual(['initial', 'pending']);
    expect(target.getLifecycle(SCOPE)).toBe('ready');
    const manifest = await readFile(store.manifestPath);
    promotion = true;

    expect(await target.sweepFormat4(SCOPE)).toEqual({ outcome: 'held' });
    expect(target.getLifecycle(SCOPE)).toBe('ready');
    expect(await readFile(store.manifestPath)).toEqual(manifest);

    const pass = await new ChatFormat4Sweep({
      dataDir,
      target: {
        ...repositoryChatFormat4SweepTarget(target, () => promotion),
        sweepAllowed: (): boolean => true,
      },
      resolveStore: storeFor,
      conditions: {
        turnInFlight: (): boolean => false,
        idleMs: (): number => Number.MAX_SAFE_INTEGER,
        onBattery: (): boolean => false,
        freeBytes: (): Promise<number | undefined> =>
          Promise.resolve(1024 ** 4),
      },
      clock: {
        now: (): number => 0,
        sleep: (): Promise<void> => Promise.resolve(),
      },
    }).runPass();
    expect(pass.status).toBe('remaining');
    expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
    expect(await readFile(store.manifestPath)).toEqual(manifest);
    await target.drainAll();
  });

  it('a user open queued before the admission is refused, and the user still reads every row', async () => {
    await seedV3();
    const target = repository();
    const user = rows(target);
    expect(await target.sweepFormat4(SCOPE)).toEqual({ outcome: 'held' });
    expect(await user).toEqual(['initial', 'pending']);
    await target.drainAll();
  });

  it('admits no scope once the repository drains, a viewer scope included (viewer promotion: chat-format4-sweep-viewer-scopes.test.ts)', async () => {
    const viewer = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'replica',
    };
    await seedV3(viewer);
    await seedV3();
    const target = repository();
    await target.drainAll();
    expect(await target.sweepFormat4(viewer)).toEqual({ outcome: 'held' });
    expect(await storeFor(viewer).format()).toBe('v3');
    expect(await target.sweepFormat4(SCOPE)).toEqual({ outcome: 'held' });
    expect(await storeFor().format()).toBe('v3');
  });
});

describe('a user who opens the scope while the sweep holds it', () => {
  it('arriving before the sweep’s load: the sweep yields at once, and the user’s own open runs as it would with no sweep', async () => {
    await seedV3();
    const target = repository();
    const sweeping = target.sweepFormat4(SCOPE);
    const user = rows(target);
    expect(await sweeping).toEqual({ outcome: 'held' });
    expect(await user).toEqual(['initial', 'pending']);
    expect(target.getLifecycle(SCOPE)).toBe('ready');
    // The user's own load promoted it, exactly as an open does without a sweep.
    expect(await storeFor().format()).toBe('v4');
    await target.drainAll();
  });

  it('a window opening it during the promotion waits for that one promotion, and the scope stays open for it', async () => {
    await seedV3();
    let user: Promise<string[]> | undefined;
    const target: ChatStateV2Repository = repository((point) => {
      if (point === 'catalog-temp-written' && !user) {
        pinned = true;
        user = rows(target);
      }
      return Promise.resolve();
    });
    expect(await target.sweepFormat4(SCOPE)).toEqual({ outcome: 'promoted' });
    if (!user)
      throw new Error('The window never opened the scope during the promotion');
    expect(await user).toEqual(['initial', 'pending']);
    expect(target.getLifecycle(SCOPE)).toBe('ready');
    expect(await storeFor().format()).toBe('v4');
    await target.drainAll();
  });
});

describe('the working set during a sweep', () => {
  it('unloads each scope as soon as its step ends, so the sweep never holds more than one resident scope', async () => {
    const scopes = [0, 1, 2, 3].map((index) => ({
      projectId: 'project',
      worktreeId: `scope-${index}`,
    }));
    for (const scope of scopes) await seedV3(scope);
    let peak = 0;
    const resident = (): number =>
      target
        .residencySnapshot()
        .filter(
          (entry) => entry.lifecycle !== 'unloaded' || entry.backendResident,
        ).length;
    const target: ChatStateV2Repository = repository((point) => {
      if (point === 'catalog-temp-written') peak = Math.max(peak, resident());
      return Promise.resolve();
    });
    const admission = repositoryChatFormat4SweepTarget(target, () => true);
    const afterEachStep: number[] = [];
    const pass = await new ChatFormat4Sweep({
      dataDir,
      target: {
        promotionAllowed: (): boolean => true,
        sweepAllowed: (): boolean => true,
        async sweepFormat4(scope): Promise<ChatFormat4SweepAttempt> {
          const attempt = await admission.sweepFormat4(scope);
          afterEachStep.push(resident());
          return attempt;
        },
      },
      resolveStore: storeFor,
      conditions: {
        turnInFlight: (): boolean => false,
        idleMs: (): number => Number.MAX_SAFE_INTEGER,
        onBattery: (): boolean => false,
        freeBytes: (): Promise<number | undefined> =>
          Promise.resolve(1024 ** 4),
      },
      clock: {
        now: (): number => 0,
        sleep: (): Promise<void> => Promise.resolve(),
      },
    }).runPass();
    expect(pass).toMatchObject({ status: 'complete', promoted: 4 });
    expect(afterEachStep).toEqual([0, 0, 0, 0]);
    expect(peak).toBe(1);
    for (const scope of scopes)
      expect(await storeFor(scope).format()).toBe('v4');
    await target.drainAll();
  });
});

describe('a scope whose load fails (review round 1)', () => {
  it('fails on every offer instead of reading as held, backs off 5 a session then 1, 2 and 4 launches, and never writes the done marker', async () => {
    const store = await seedV3();
    await writeFile(store.manifestPath, '{ not json');
    const offeredPerLaunch: number[] = [];
    let backedOff = 0;
    for (let launch = 0; launch < 8; launch += 1) {
      const target = repository();
      let offered = 0;
      let now = 0;
      const sweep = new ChatFormat4Sweep({
        dataDir,
        target: {
          promotionAllowed: (): boolean => true,
          sweepAllowed: (): boolean => true,
          async sweepFormat4(scope): Promise<ChatFormat4SweepAttempt> {
            offered += 1;
            const attempt = await repositoryChatFormat4SweepTarget(
              target,
              () => true,
            ).sweepFormat4(scope);
            expect(attempt.outcome).toBe('failed');
            return attempt;
          },
        },
        resolveStore: storeFor,
        report: (outcome): void => {
          if (outcome.event === 'sweep_scope_backed_off') backedOff += 1;
        },
        conditions: {
          turnInFlight: (): boolean => false,
          idleMs: (): number => Number.MAX_SAFE_INTEGER,
          onBattery: (): boolean => false,
          freeBytes: (): Promise<number | undefined> =>
            Promise.resolve(1024 ** 4),
        },
        clock: {
          now: (): number => now,
          sleep: (): Promise<void> => Promise.resolve(),
        },
      });
      await sweep.beginLaunch();
      for (let pass = 0; pass < 8; pass += 1) {
        now += 3_600_000;
        await sweep.runPass();
      }
      offeredPerLaunch.push(offered);
      await target.drainAll();
    }
    expect(offeredPerLaunch).toEqual([5, 0, 5, 0, 0, 5, 0, 0]);
    expect(backedOff).toBe(3);
    expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
  });
});

describe('a sweep step that fails (review round 2)', () => {
  const resident = (target: ChatStateV2Repository): number =>
    target
      .residencySnapshot()
      .filter(
        (entry) => entry.lifecycle !== 'unloaded' || entry.backendResident,
      ).length;

  it('when promotion fails after a good load, unloads the scope and the next offer fails again instead of reading as held', async () => {
    await seedV3();
    const target = repository((point) =>
      point === 'catalog-temp-written'
        ? Promise.reject(new Error('fault:catalog'))
        : Promise.resolve(),
    );
    expect(await target.sweepFormat4(SCOPE)).toEqual({ outcome: 'failed' });
    expect(resident(target)).toBe(0);
    expect(await storeFor().format()).toBe('v3');
    expect((await target.sweepFormat4(SCOPE)).outcome).toBe('failed');
    expect(resident(target)).toBe(0);
    await target.drainAll();
  });

  it('when load ends in recovery_error with the scope resident, releases it, and the next offer loads it afresh', async () => {
    await seedV3();
    const target = repository();
    const promote = jest
      .spyOn(ChatStateV2Backend.prototype, 'promoteToFormat4')
      .mockRejectedValueOnce(new Error('fault:reopen'));
    try {
      const first = await target.sweepFormat4(SCOPE);
      expect(first.outcome).toBe('failed');
      expect(resident(target)).toBe(0);
      expect(target.getLifecycle(SCOPE)).toBe('unloaded');
    } finally {
      promote.mockRestore();
    }
    expect(await target.sweepFormat4(SCOPE)).toEqual({ outcome: 'promoted' });
    expect(resident(target)).toBe(0);
    await target.drainAll();
  });

  it('when the format read after a good load fails, reports failed and still unloads the scope (review round 3)', async () => {
    await seedV3();
    const target = repository();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with apply(this) below.
    const promote = ChatStateV2Backend.prototype.promoteToFormat4;
    let promoted = false;
    const promoteSpy = jest
      .spyOn(ChatStateV2Backend.prototype, 'promoteToFormat4')
      .mockImplementation(async function (
        this: ChatStateV2Backend,
        ...args: Parameters<ChatStateV2Backend['promoteToFormat4']>
      ) {
        const value = await promote.apply(this, args);
        promoted = true;
        return value;
      });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with call(this) below.
    const format = ChatStorageV2.prototype.format;
    const formatSpy = jest
      .spyOn(ChatStorageV2.prototype, 'format')
      .mockImplementation(function (this: ChatStorageV2) {
        if (promoted) {
          promoted = false;
          return Promise.reject(
            Object.assign(new Error('fault:probe'), { code: 'EIO' }),
          );
        }
        return format.call(this);
      });
    try {
      const attempt = await repositoryChatFormat4SweepTarget(
        target,
        () => true,
      ).sweepFormat4(SCOPE);
      expect(attempt).toEqual({ outcome: 'failed', reason: 'io' });
      expect(resident(target)).toBe(0);
      expect(target.getLifecycle(SCOPE)).toBe('unloaded');
    } finally {
      formatSpy.mockRestore();
      promoteSpy.mockRestore();
    }
    expect(await target.sweepFormat4(SCOPE)).toEqual({
      outcome: 'already_format4',
    });
    await target.drainAll();
  });

  it('reports the root failure class of a load that fails, not the load error that wraps it (review round 3)', async () => {
    await seedV3();
    const target = repository();
    const promote = jest
      .spyOn(ChatStateV2Backend.prototype, 'promoteToFormat4')
      .mockRejectedValue(
        Object.assign(new Error('fault:full'), { code: 'ENOSPC' }),
      );
    try {
      expect(
        await repositoryChatFormat4SweepTarget(target, () => true).sweepFormat4(
          SCOPE,
        ),
      ).toEqual({ outcome: 'failed', reason: 'disk_full' });
    } finally {
      promote.mockRestore();
    }
    await target.drainAll();
  });
});

describe('the bounded pre-handoff pass (CAN-7178 PR 3)', () => {
  const A: ChatScopeKey = { projectId: 'project', worktreeId: 'alpha' };
  const B: ChatScopeKey = { projectId: 'project', worktreeId: 'beta' };

  async function seedV2(scope: ChatScopeKey): Promise<ChatStorageV2> {
    const store = storeFor(scope);
    await store.migrate(
      scopeSource([{ id: 'chat', messages: [message('m1', 'Hello', 'user')] }]),
    );
    return store;
  }

  /** A legacy scope holding one chat, as the legacy cleanup golden seeds it. */
  async function seedLegacy(scope: ChatScopeKey): Promise<void> {
    const { tabs } = pathsFor(scope);
    await mkdir(join(tabs, '..'), { recursive: true });
    await writeFile(
      tabs,
      `${JSON.stringify({
        version: 1,
        activeTabId: 'live',
        tabs: [
          {
            id: 'live',
            title: 'live',
            createdAt: '2026-11-12T00:00:00Z',
            messages: [
              {
                id: 'live-m1',
                role: 'user',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'Live chat' }],
              },
            ],
          },
        ],
      })}\n`,
    );
  }

  /** A legacy scope with no chats, as the app itself writes one. */
  async function seedEmptyLegacy(scope: ChatScopeKey): Promise<void> {
    const { tabs } = pathsFor(scope);
    await mkdir(join(tabs, '..'), { recursive: true });
    await writeFile(tabs, `${JSON.stringify(createEmptyChatTabsFile())}\n`);
  }

  /** Every file under the data root with its bytes, for byte-identity checks. */
  async function snapshot(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else files[path] = (await readFile(path)).toString('base64');
      }
    };
    await walk(dataDir);
    return files;
  }

  function pass(
    target: ChatStateV2Repository,
    bound: { deadlineAt: number; now?: () => number },
    report: (outcome: ChatFormat4Outcome) => void = (): void => undefined,
  ): ReturnType<typeof runChatFormat4PreHandoffPass> {
    return runChatFormat4PreHandoffPass({
      dataDir,
      repository: target,
      resolveStore: storeFor,
      report,
      ...bound,
    });
  }

  it('reads and writes no scope once its deadline has passed, and says the deadline ran out', async () => {
    await seedV3(A);
    await seedV3(B);
    const before = await snapshot();
    const target = repository();
    const result = await pass(target, { deadlineAt: 1_000, now: () => 2_000 });
    expect(result.results.map(({ result: r }) => r)).toEqual([
      { kind: 'still_format3', reason: 'deadline' },
      { kind: 'still_format3', reason: 'deadline' },
    ]);
    expect(result).toMatchObject({
      status: 'bound_exceeded',
      promoted: 0,
      remaining: 2,
    });
    expect(await snapshot()).toEqual(before);
    expect(target.getLifecycle(A)).toBe('unloaded');
    await target.drainAll();
  });

  it('finishes a promotion it started before the deadline, and starts no other', async () => {
    await seedV3(A);
    await seedV3(B);
    const target = repository();
    // The clock passes the deadline while the first promotion runs.
    let clock = 0;
    const sweep = target.sweepFormat4.bind(target);
    jest
      .spyOn(target, 'sweepFormat4')
      .mockImplementation(async (scope, options) => {
        const attempt = await sweep(scope, options);
        clock = 10_000;
        return attempt;
      });
    const result = await pass(target, { deadlineAt: 5_000, now: () => clock });
    const formats = [await storeFor(A).format(), await storeFor(B).format()];
    expect(formats.sort()).toEqual(['v3', 'v4']);
    expect(result).toMatchObject({
      status: 'bound_exceeded',
      promoted: 1,
      remaining: 1,
    });
    await target.drainAll();
  });

  it('brings every stored scope to format 4, from legacy (an empty one too), version 2 and format 3, a viewer scope included', async () => {
    const legacy = { projectId: 'project-legacy', worktreeId: 'old' };
    const emptyLegacy = { projectId: 'project-legacy', worktreeId: 'empty' };
    const viewer = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
    };
    const done = { projectId: 'project', worktreeId: 'done' };
    await seedLegacy(legacy);
    await seedEmptyLegacy(emptyLegacy);
    await seedV2(A);
    await seedV3(B);
    await seedV2(viewer);
    await seedV3(done);
    const earlier = repository();
    expect(await earlier.sweepFormat4(done)).toEqual({ outcome: 'promoted' });
    await earlier.drainAll();
    const doneManifest = await readFile(storeFor(done).manifestPath);
    const target = repository();
    const outcomes: ChatFormat4Outcome[] = [];
    const result = await pass(
      target,
      { deadlineAt: Date.now() + 20_000 },
      (outcome) => outcomes.push(outcome),
    );
    for (const scope of [legacy, emptyLegacy, A, B, viewer])
      expect(await storeFor(scope).format()).toBe('v4');
    expect(result.results).toHaveLength(5);
    for (const { result: r } of result.results)
      expect(r).toEqual({ kind: 'format4', promoted: true });
    expect(result).toMatchObject({
      status: 'complete',
      promoted: 5,
      remaining: 0,
    });
    // The scope already in format 4 is neither offered nor written.
    expect(await readFile(storeFor(done).manifestPath)).toEqual(doneManifest);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      event: 'prehandoff_completed',
      remaining: 0,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // It records nothing of its own: no state or done file appears.
    expect(await readdir(dataDir)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/format4-sweep/)]),
    );
    await target.drainAll();
  });

  it('in a build that hands chat storage to the daemon, promotes whatever the format 4 switch says', async () => {
    await seedV3(A);
    promotion = isChatFormat4PromotionEnabled(() => true);
    expect(promotion).toBe(true);
    const target = repository();
    const result = await pass(target, { deadlineAt: Date.now() + 20_000 });
    expect(result.results[0]?.result).toEqual({
      kind: 'format4',
      promoted: true,
    });
    expect(await storeFor(A).format()).toBe('v4');
    await target.drainAll();
  });

  it('with the switch off in a build that keeps chat storage, leaves the scope in format 3 for the next start', async () => {
    await seedV3(A);
    promotion = false;
    const target = repository();
    const result = await pass(target, { deadlineAt: Date.now() + 20_000 });
    expect(result.results[0]?.result).toEqual({
      kind: 'still_format3',
      reason: 'promotion_fault',
    });
    expect(await storeFor(A).format()).toBe('v3');
    await target.drainAll();
  });

  it('never waits for a scope someone else holds, and a second pass over format 4 scopes reads none', async () => {
    await seedV3(SCOPE);
    // The window opens it with promotion off, so it is still format 3 when held.
    promotion = false;
    const target = repository();
    expect(await rows(target)).toEqual(['initial', 'pending']);
    const manifest = await readFile(storeFor().manifestPath);
    promotion = true;
    const held = await pass(target, { deadlineAt: Date.now() + 20_000 });
    expect(held.results[0]?.result).toEqual({
      kind: 'still_format3',
      reason: 'busy',
    });
    expect(await readFile(storeFor().manifestPath)).toEqual(manifest);
    await target.drainAll();

    const fresh = repository();
    const first = await pass(fresh, { deadlineAt: Date.now() + 20_000 });
    expect(first.promoted).toBe(1);
    const before = await snapshot();
    const second = await pass(fresh, { deadlineAt: Date.now() + 20_000 });
    expect(second).toMatchObject({
      status: 'complete',
      results: [],
      promoted: 0,
      remaining: 0,
    });
    expect(await snapshot()).toEqual(before);
    await fresh.drainAll();
  });

  it('reports a newer format, a damaged store and a full disk as their failure, changing no byte', async () => {
    const newer = await seedV3(A);
    const manifest: unknown = JSON.parse(
      await readFile(newer.manifestPath, 'utf8'),
    );
    if (typeof manifest !== 'object' || manifest === null)
      throw new Error('Expected a manifest');
    Reflect.set(manifest, 'version', 5);
    await writeFile(newer.manifestPath, JSON.stringify(manifest));
    const target = repository();
    expect(
      await ensureFormat4(
        A,
        { deadlineAt: Date.now() + 20_000 },
        { repository: target, resolveStore: storeFor },
      ),
    ).toEqual({ kind: 'failed', reason: 'newer_format', retryable: false });

    await seedV3(B);
    const promote = jest.spyOn(
      ChatStateV2Backend.prototype,
      'promoteToFormat4',
    );
    try {
      promote.mockRejectedValueOnce(
        new ChatDeltaJournalIntegrityError('broken record'),
      );
      expect(
        await ensureFormat4(
          B,
          { deadlineAt: Date.now() + 20_000 },
          { repository: target, resolveStore: storeFor },
        ),
      ).toEqual({ kind: 'failed', reason: 'unreadable', retryable: false });
      promote.mockRejectedValueOnce(
        Object.assign(new Error('fault:full'), { code: 'ENOSPC' }),
      );
      expect(
        await ensureFormat4(
          B,
          { deadlineAt: Date.now() + 20_000 },
          { repository: target, resolveStore: storeFor },
        ),
      ).toEqual({ kind: 'failed', reason: 'io', retryable: true });
    } finally {
      promote.mockRestore();
    }
    expect(await storeFor(B).format()).toBe('v3');
    await target.drainAll();
  });

  /** A format 3 scope whose promotion fails with `error`; it stays format 3. */
  async function failedPromotion(error: Error): Promise<unknown> {
    await seedV3(B);
    const target = repository();
    const promote = jest
      .spyOn(ChatStateV2Backend.prototype, 'promoteToFormat4')
      .mockRejectedValueOnce(error);
    const result = await ensureFormat4(
      B,
      { deadlineAt: Date.now() + 20_000 },
      { repository: target, resolveStore: storeFor },
    ).finally(() => promote.mockRestore());
    await target.drainAll();
    expect(await storeFor(B).format()).toBe('v3');
    return result;
  }

  it('reports a transcript that holds less than its index describes as unreadable, not a retry', async () => {
    expect(
      await failedPromotion(
        new ChatTranscriptIntegrityError('transcript shorter than its index'),
      ),
    ).toEqual({ kind: 'failed', reason: 'unreadable', retryable: false });
  });

  it('reports an index that does not parse as unreadable, not a retry', async () => {
    expect(
      await failedPromotion(new SyntaxError('Unexpected end of JSON input')),
    ).toEqual({ kind: 'failed', reason: 'unreadable', retryable: false });
  });

  it('reports a format 3 failure it cannot name as unreadable, never as a retryable read', async () => {
    expect(
      await failedPromotion(new Error('an unnamed promotion failure')),
    ).toEqual({ kind: 'failed', reason: 'unreadable', retryable: false });
  });

  it('never lets a manifest read that doesn’t return hold it past the deadline: that scope counts as pending, and the pass reports the bound exceeded', async () => {
    await seedV3(A);
    const stalled = await seedV3(B);
    /** Every read of B's manifest never returns. */
    const resolveStore = (scope: ChatScopeKey): ChatStorageV2 => {
      const store = storeFor(scope);
      if (store.directory === stalled.directory)
        jest
          .spyOn(store, 'format')
          .mockReturnValue(new Promise<never>(() => undefined));
      return store;
    };
    const outcomes: ChatFormat4Outcome[] = [];
    const target = repository();
    const settled = await Promise.race([
      runChatFormat4PreHandoffPass({
        dataDir,
        repository: target,
        resolveStore,
        deadlineAt: Date.now() + 2_000,
        report: (outcome) => outcomes.push(outcome),
      }),
      new Promise<'hung'>((resolve) => {
        setTimeout(() => resolve('hung'), 15_000).unref();
      }),
    ]);
    if (settled === 'hung')
      throw new Error('The pass never returned past its deadline');
    expect(settled.status).toBe('bound_exceeded');
    expect(settled.remaining).toBeGreaterThanOrEqual(1);
    expect(
      settled.results.find(({ scope }) => scope.worktreeId === B.worktreeId)
        ?.result,
    ).toEqual({ kind: 'still_format3', reason: 'deadline' });
    expect(outcomes).toEqual([
      expect.objectContaining({ event: 'prehandoff_bound_exceeded' }),
    ]);
    expect(await storeFor(B).format()).toBe('v3');
    await target.drainAll();
  });

  it('checks the deadline again under the lease: when it passes during the repository’s own manifest read, nothing is admitted', async () => {
    await seedV3(A);
    const before = await snapshot();
    const target = repository();
    let clock = 0;
    let reads = 0;
    // The pass's own read is the first; the deadline passes during the
    // repository's read under the lease, before it asks to admit.
    const format = jest
      .spyOn(ChatStorageV2.prototype, 'format')
      .mockImplementation((): Promise<'v3'> => {
        reads += 1;
        if (reads >= 2) clock = 10_000;
        return Promise.resolve('v3');
      });
    const result = await ensureFormat4(
      A,
      { deadlineAt: 5_000, now: () => clock },
      { repository: target, resolveStore: storeFor },
    ).finally(() => format.mockRestore());
    expect(result).toEqual({ kind: 'still_format3', reason: 'deadline' });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(target.getLifecycle(A)).toBe('unloaded');
    expect(await storeFor(A).format()).toBe('v3');
    expect(await snapshot()).toEqual(before);
    await target.drainAll();
  });

  it('reports its pending count as unknown, never 0, when it abandons its scan of stored scopes', async () => {
    await seedV3(A);
    await seedV3(B);
    const before = await snapshot();
    const controller = new AbortController();
    let resolved = 0;
    // The scan is abandoned after it has found the first scope.
    const resolveStore = (scope: ChatScopeKey): ChatStorageV2 => {
      resolved += 1;
      if (resolved === 2) controller.abort();
      return storeFor(scope);
    };
    const outcomes: ChatFormat4Outcome[] = [];
    const target = repository();
    const result = await runChatFormat4PreHandoffPass({
      dataDir,
      repository: target,
      resolveStore,
      deadlineAt: Date.now() + 20_000,
      signal: controller.signal,
      report: (outcome) => outcomes.push(outcome),
    });
    expect(result).toMatchObject({
      status: 'bound_exceeded',
      deadlineHit: true,
      results: [],
      promoted: 0,
    });
    expect(result.remaining).toBeUndefined();
    expect(outcomes).toEqual([
      expect.objectContaining({ event: 'prehandoff_bound_exceeded' }),
    ]);
    expect(outcomes[0]).toHaveProperty('remaining', undefined);
    expect(await snapshot()).toEqual(before);
    await target.drainAll();
  });

  it('counts a truncated format 4 manifest as unreadable, never converts it, and never takes its lease', async () => {
    const store = await seedV3(A);
    const earlier = repository();
    expect(await earlier.sweepFormat4(A)).toEqual({ outcome: 'promoted' });
    await earlier.drainAll();
    const whole = await readFile(store.manifestPath, 'utf8');
    await writeFile(
      store.manifestPath,
      whole.slice(0, Math.floor(whole.length / 2)),
    );
    const before = await snapshot();
    const target = repository();
    const sweep = jest.spyOn(target, 'sweepFormat4');
    const result = await pass(target, { deadlineAt: Date.now() + 20_000 });
    expect(result.results).toEqual([
      {
        scope: A,
        result: { kind: 'failed', reason: 'unreadable', retryable: false },
      },
    ]);
    expect(result).toMatchObject({ status: 'incomplete', remaining: 1 });
    expect(sweep).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    await target.drainAll();
  });

  it('promotes only under the scope’s own lease: a window opening the scope during the pass’s promotion waits for it and reads every row', async () => {
    await seedV3(SCOPE);
    let user: Promise<string[]> | undefined;
    const target: ChatStateV2Repository = repository((point) => {
      if (point === 'catalog-temp-written' && !user) {
        pinned = true;
        user = rows(target);
      }
      return Promise.resolve();
    });
    const result = await pass(target, { deadlineAt: Date.now() + 20_000 });
    expect(result.results).toEqual([
      { scope: SCOPE, result: { kind: 'format4', promoted: true } },
    ]);
    if (!user)
      throw new Error('The window never opened the scope during the promotion');
    expect(await user).toEqual(['initial', 'pending']);
    expect(await storeFor().format()).toBe('v4');
    await target.drainAll();
  });

  it('leaves a scope without room for twice its size plus the margin as it is, and counts it as pending', async () => {
    await seedV3(A);
    const before = await snapshot();
    const target = repository();
    const sweep = jest.spyOn(target, 'sweepFormat4');
    const result = await runChatFormat4PreHandoffPass({
      dataDir,
      repository: target,
      resolveStore: storeFor,
      deadlineAt: Date.now() + 20_000,
      freeBytes: () => Promise.resolve(1024),
      report: () => undefined,
    });
    expect(result.results).toEqual([
      { scope: A, result: { kind: 'still_format3', reason: 'disk' } },
    ]);
    expect(result).toMatchObject({
      status: 'incomplete',
      remaining: 1,
      deadlineHit: false,
    });
    expect(sweep).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    await target.drainAll();
  });

  it('offers scopes in the sweep’s order, the most recently used first, one at a time unless told otherwise', async () => {
    const older = { projectId: 'project', worktreeId: 'aaa-older' };
    const newer = { projectId: 'project', worktreeId: 'zzz-newer' };
    const oldStore = await seedV3(older);
    const newStore = await seedV3(newer);
    const hourAgo = new Date(Date.now() - 3_600_000);
    await utimes(oldStore.manifestPath, hourAgo, hourAgo);
    const target = repository();
    const offered: string[] = [];
    let running = 0;
    let most = 0;
    const sweep = target.sweepFormat4.bind(target);
    jest
      .spyOn(target, 'sweepFormat4')
      .mockImplementation(async (scope, options) => {
        offered.push(scope.worktreeId);
        running += 1;
        most = Math.max(most, running);
        try {
          return await sweep(scope, options);
        } finally {
          running -= 1;
        }
      });
    const result = await pass(target, { deadlineAt: Date.now() + 20_000 });
    expect(offered).toEqual([newer.worktreeId, older.worktreeId]);
    expect(most).toBe(1);
    expect(result).toMatchObject({ status: 'complete', promoted: 2 });
    expect(await newStore.format()).toBe('v4');
    await target.drainAll();
  });
});

describe('a legacy scope no reader can recover, in the pre-handoff pass (CAN-7851)', () => {
  async function seedLegacyTabs(text: string): Promise<void> {
    const { tabs } = pathsFor(SCOPE);
    await mkdir(join(tabs, '..'), { recursive: true });
    await writeFile(tabs, text);
  }

  async function ensure(): Promise<Awaited<ReturnType<typeof ensureFormat4>>> {
    const target = repository();
    try {
      return await ensureFormat4(
        SCOPE,
        { deadlineAt: Date.now() + 20_000 },
        { repository: target, resolveStore: storeFor },
      );
    } finally {
      await target.drainAll();
    }
  }

  it('reports a tabs file that parses but is not a valid chats file as unreadable, not a retryable migration, and changes no byte', async () => {
    const text = `${JSON.stringify({ version: 1, activeTabId: 'x', tabs: [{ id: 5 }] })}\n`;
    await seedLegacyTabs(text);
    expect(await ensure()).toEqual({
      kind: 'failed',
      reason: 'unreadable',
      retryable: false,
    });
    expect(await readFile(pathsFor(SCOPE).tabs, 'utf8')).toBe(text);
    expect(await storeFor().format()).toBe('v1');
  });

  it('reports a tabs file that does not parse as unreadable, not a retryable migration, and changes no byte', async () => {
    const text = '{ "version": 1, "tabs": [';
    await seedLegacyTabs(text);
    expect(await ensure()).toEqual({
      kind: 'failed',
      reason: 'unreadable',
      retryable: false,
    });
    expect(await readFile(pathsFor(SCOPE).tabs, 'utf8')).toBe(text);
  });
});
