/**
 * Code-review scopes reach format 4 through the background sweep (CAN-7178),
 * but only once their namespace has qualified for the current routing
 * (CAN-6848). Until then, or while the chat state service deletes the scope,
 * the sweep holds it: no read, no write, and a later sweep offers it again.
 * The sweep never spends the namespace guardrail's one report per effect,
 * which belongs to a user acting on a review.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import type * as CodeReviewAdmissionModule from '../lib/code-review-storage-admission';
import {
  getCodeReviewNamespaceGuardrail,
  noteCodeReviewNamespaceEffect,
} from '../lib/code-review-storage-admission';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import type { ChatScopeKey } from '../services/chat-state-contracts';
import {
  CHAT_FORMAT4_SWEEP_HELD_RETRY_MS,
  CHAT_FORMAT4_SWEEP_IDLE_MS,
  ChatFormat4Sweep,
  chatFormat4SweepComplete,
  listChatFormat4SweepCandidates,
  repositoryChatFormat4SweepTarget,
  type ChatFormat4SweepAdmission,
  type ChatFormat4SweepPassResult,
} from '../services/chat-format4-sweep';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import { drainOpenRepositories } from './helpers/chat-delta-journal-scope';

// Qualification itself is CAN-6848's (code-review-storage-admission.ts); the
// sweep only reads its result. The cold load's wait resolves at once here,
// and every guardrail note is recorded and still runs the real note.
jest.mock('../lib/code-review-storage-admission', () => {
  const actual = jest.requireActual<typeof CodeReviewAdmissionModule>(
    '../lib/code-review-storage-admission',
  );
  return {
    ...actual,
    ensureCodeReviewNamespaceQualification: jest.fn(
      (): Promise<undefined> => Promise.resolve(undefined),
    ),
    noteCodeReviewNamespaceEffect: jest.fn(
      actual.noteCodeReviewNamespaceEffect,
    ),
  };
});

jest.setTimeout(60_000);

const REVIEW: ChatScopeKey = {
  projectId: CODE_REVIEW_CHAT_PROJECT_ID,
  worktreeId: 'review-1',
};
const SECOND: ChatScopeKey = {
  projectId: CODE_REVIEW_CHAT_PROJECT_ID,
  worktreeId: 'review-2',
};

let dataDir: string;
let qualified = false;
let deleting = false;
const previousDataDir = process.env.CANOPY_DATA_DIR;
const notes = jest.mocked(noteCodeReviewNamespaceEffect);

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'format4-sweep-review-'));
  process.env.CANOPY_DATA_DIR = dataDir;
  resetResolvedCanopyDataDirForTests();
  qualified = false;
  deleting = false;
  notes.mockClear();
});

afterEach(async () => {
  await drainOpenRepositories();
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(dataDir, { recursive: true, force: true });
});

/** Code-review chats live in their app-managed root, beside the registry. */
function pathsFor(scope: ChatScopeKey): {
  tabs: string;
  archives: string;
  journal: string;
} {
  const root = join(
    dataDir,
    scope.projectId === CODE_REVIEW_CHAT_PROJECT_ID
      ? 'app-workspaces'
      : 'workspaces',
    scope.projectId,
  );
  return {
    tabs: join(root, 'chats', `${scope.worktreeId}.json`),
    archives: join(root, 'chat-archives', `${scope.worktreeId}.json`),
    journal: join(root, 'chat-journals', `${scope.worktreeId}.jsonl`),
  };
}

const storeFor = (scope: ChatScopeKey = REVIEW): ChatStorageV2 =>
  ChatStorageV2.fromLegacyPaths(pathsFor(scope));

const registryPath = (): string =>
  join(
    dataDir,
    'app-workspaces',
    CODE_REVIEW_CHAT_PROJECT_ID,
    'chats',
    'registry.json',
  );

function repository(): ChatStateV2Repository {
  return new ChatStateV2Repository({
    resolvePaths: pathsFor,
    enableFormat4: true,
    format4Promotion: (): boolean => true,
    deltaJournalIncrementalStreamMetadata: true,
    deltaJournalIdleCheckpointMs: 60_000,
    idleScopeUnloadMs: 0,
  });
}

/** A code-review scope at format 3 with one review chat. */
async function seedV3(scope: ChatScopeKey = REVIEW): Promise<void> {
  const store = storeFor(scope);
  await store.migrate(
    scopeSource([
      { id: 'review', messages: [message('m1', 'Review this', 'user')] },
    ]),
  );
  const backend = new ChatStateV2Backend(store, {
    enableFormat4: true,
    deltaJournal: {},
  });
  await backend.promoteToDeltaJournal();
  backend.releaseJournal();
  expect(await store.format()).toBe('v3');
}

/** Everything under the scope's store and its legacy files, byte for byte. */
async function bytes(scope: ChatScopeKey = REVIEW): Promise<string | null> {
  return readFile(storeFor(scope).manifestPath, 'utf8').catch(() => null);
}

function sweep(
  target: ChatStateV2Repository,
  admission: ChatFormat4SweepAdmission = {
    codeReviewQualified: (): boolean => qualified,
    isScopeDeleting: (): boolean => deleting,
  },
): { sweep: ChatFormat4Sweep; clock: { time: number } } {
  const clock = { time: 1_000_000 };
  return {
    clock,
    sweep: new ChatFormat4Sweep({
      dataDir,
      target: {
        ...repositoryChatFormat4SweepTarget(
          target,
          (): boolean => true,
          admission,
        ),
        sweepAllowed: (): boolean => true,
      },
      resolveStore: storeFor,
      conditions: {
        turnInFlight: (): boolean => false,
        idleMs: (): number => CHAT_FORMAT4_SWEEP_IDLE_MS,
        onBattery: (): boolean => false,
        freeBytes: (): Promise<number | undefined> =>
          Promise.resolve(1024 ** 4),
      },
      clock: {
        now: (): number => clock.time,
        sleep: async (ms: number): Promise<void> => {
          clock.time += ms;
          await new Promise((resolve) => setImmediate(resolve));
        },
      },
    }),
  };
}

async function chatIds(target: ChatStateV2Repository): Promise<string[]> {
  return (await target.getState(REVIEW)).tabsFile.tabs.map((tab) => tab.id);
}

describe('a code-review scope whose namespace has qualified', () => {
  it('is offered and promoted by the sweep, and its review chat reads back', async () => {
    await seedV3();
    qualified = true;
    const target = repository();
    const result: ChatFormat4SweepPassResult =
      await sweep(target).sweep.runPass();
    expect(result).toMatchObject({ status: 'complete', promoted: 1 });
    expect(await storeFor().format()).toBe('v4');
    expect(await chatIds(target)).toEqual(['review']);
    await target.drainAll();
  });

  it('records no guardrail report: the namespace witness stays empty', async () => {
    await seedV3();
    qualified = true;
    const target = repository();
    await sweep(target).sweep.runPass();
    expect(await storeFor().format()).toBe('v4');
    expect(getCodeReviewNamespaceGuardrail().proceeded).toEqual([]);
    await target.drainAll();
  });
});

describe('a code-review scope whose namespace has not qualified', () => {
  it('is held, unsettled or failed alike: the store is byte-unchanged, nothing is noted, and the sweep stays incomplete', async () => {
    await seedV3();
    const before = await bytes();
    const target = repository();
    const result = await sweep(target).sweep.runPass();
    expect(result.status).toBe('remaining');
    expect(await bytes()).toBe(before);
    expect(await storeFor().format()).toBe('v3');
    expect(notes).not.toHaveBeenCalled();
    expect(await chatFormat4SweepComplete(dataDir)).toBe(false);
    await target.drainAll();
  });

  it('unsettled, then qualified: the held scope is offered again and promoted on the next sweep', async () => {
    await seedV3();
    const target = repository();
    const run = sweep(target);
    expect((await run.sweep.runPass()).status).toBe('remaining');
    expect(await storeFor().format()).toBe('v3');
    qualified = true;
    run.clock.time += CHAT_FORMAT4_SWEEP_HELD_RETRY_MS[0] ?? 0;
    expect(await run.sweep.runPass()).toMatchObject({
      status: 'complete',
      promoted: 1,
    });
    expect(await storeFor().format()).toBe('v4');
    await target.drainAll();
  });

  it('qualified, then the routing moves: the next code-review scope is held', async () => {
    await seedV3(REVIEW);
    await seedV3(SECOND);
    const target = repository();
    let checks = 0;
    // Each scope's admission reads the guardrail twice: before its offer and
    // again under the lease. The routing moves once the first is promoted.
    const result = await sweep(target, {
      codeReviewQualified: (): boolean => {
        checks += 1;
        return checks <= 2;
      },
    }).sweep.runPass();
    expect(result).toMatchObject({ status: 'remaining', promoted: 1 });
    const formats = [
      await storeFor(REVIEW).format(),
      await storeFor(SECOND).format(),
    ].sort();
    expect(formats).toEqual(['v3', 'v4']);
    await target.drainAll();
  });

  it('flipping to failed between the sweep’s check and its load holds the scope, with no guardrail note and the store byte-unchanged', async () => {
    await seedV3();
    const before = await bytes();
    const target = repository();
    let checks = 0;
    const result = await sweep(target, {
      codeReviewQualified: (): boolean => {
        checks += 1;
        return checks === 1;
      },
    }).sweep.runPass();
    expect(result.status).toBe('remaining');
    expect(await bytes()).toBe(before);
    expect(notes).not.toHaveBeenCalled();
    expect(getCodeReviewNamespaceGuardrail().proceeded).toEqual([]);
    expect(checks).toBe(2);
    await target.drainAll();
  });
});

describe('the review registry beside the chats', () => {
  it('is byte-unchanged after a pass that migrates and promotes a legacy code-review scope next to it', async () => {
    const registry = JSON.stringify({ version: 1, entries: {} });
    await mkdir(dirname(registryPath()), { recursive: true });
    await writeFile(registryPath(), registry);
    await writeFile(
      pathsFor(REVIEW).tabs,
      JSON.stringify({
        version: 1,
        activeTabId: 'review',
        tabs: [
          {
            id: 'review',
            title: 'review',
            createdAt: '2026-11-19T00:00:00Z',
            messages: [
              {
                id: 'review-m1',
                role: 'user',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'Review this' }],
              },
            ],
          },
        ],
      }),
    );
    qualified = true;
    const target = repository();
    const result = await sweep(target).sweep.runPass();
    expect(result).toMatchObject({ status: 'complete', promoted: 1 });
    expect(await storeFor().format()).toBe('v4');
    expect(await readFile(registryPath(), 'utf8')).toBe(registry);
    expect(await chatIds(target)).toEqual(['review']);
    await target.drainAll();
  });
});

describe('a code-review chat file outside its canonical root', () => {
  it('is counted unmapped and never loaded', async () => {
    const stray = join(
      dataDir,
      'workspaces',
      CODE_REVIEW_CHAT_PROJECT_ID,
      'chats',
      'old.json',
    );
    const text = JSON.stringify({ version: 1, activeTabId: '', tabs: [] });
    await mkdir(dirname(stray), { recursive: true });
    await writeFile(stray, text);
    qualified = true;
    const inventory = await listChatFormat4SweepCandidates(dataDir, storeFor);
    expect(inventory.unmapped).toBe(1);
    expect(inventory.candidates).toEqual([]);
    const target = repository();
    const result = await sweep(target).sweep.runPass();
    expect(result).toMatchObject({ status: 'remaining', promoted: 0 });
    expect(await readFile(stray, 'utf8')).toBe(text);
    await target.drainAll();
  });
});

describe('a scope the chat state service is deleting', () => {
  it('is held with no read or write, and promoted by a later sweep once the deletion has ended', async () => {
    await seedV3();
    qualified = true;
    deleting = true;
    const before = await bytes();
    const target = repository();
    const run = sweep(target);
    expect((await run.sweep.runPass()).status).toBe('remaining');
    expect(await bytes()).toBe(before);
    expect(notes).not.toHaveBeenCalled();
    deleting = false;
    run.clock.time += CHAT_FORMAT4_SWEEP_HELD_RETRY_MS[0] ?? 0;
    expect(await run.sweep.runPass()).toMatchObject({
      status: 'complete',
      promoted: 1,
    });
    await target.drainAll();
  });
});

describe('an ordinary open of a code-review scope', () => {
  it('still promotes it as before, through the cold-load wait and the guardrail notes', async () => {
    await seedV3();
    const target = repository();
    expect(await chatIds(target)).toEqual(['review']);
    await target.drainAll();
    expect(await storeFor().format()).toBe('v4');
    expect(notes.mock.calls.map(([effect]) => effect)).toEqual(
      expect.arrayContaining(['cold_load', 'promotion']),
    );
  });
});
