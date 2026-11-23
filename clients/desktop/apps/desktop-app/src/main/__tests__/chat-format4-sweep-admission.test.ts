/**
 * The repository's format 4 sweep admission (CAN-7178): it never waits
 * behind or takes a scope from another holder, yields to a user who arrives
 * before its load, and unloads only a scope it alone still holds.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import type { DeltaJournalBoundary } from '../lib/chat-delta-journal/writer';
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
