/**
 * Format 4 delegation registry checkpoint crash images (CAN-6191).
 *
 * A chat's registry checkpoint stages its identities' segments and indexes,
 * replaces the chat manifest once, then publishes each identity's head. Each
 * image stops the checkpoint at one rename and fails every later one, as a
 * crash would. The manifest must never be behind a published head, and
 * replaying the journal must recover every entry with the chat checkpoint
 * and with the one-identity-at-a-time checkpoint that v1.16 and v1.17 use.
 * test:platform-services runs it on Linux, macOS and Windows.
 */
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  DelegationRegistryStore,
  registrySnapshotDigest,
} from '../lib/chat-delta-journal/delegation-registry-store';
import type {
  DelegationRegistryCheckpoint,
  DelegationRegistryJournalEffect,
} from '../lib/chat-delta-journal/delegation-registry-api';

// Fails a rename when set: a crash just before that file is published.
const mockFsFaults: { failRename?: (from: string, to: string) => boolean } = {};
jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    rename: (from: string, to: string): Promise<void> =>
      mockFsFaults.failRename?.(from, to)
        ? Promise.reject(new Error('simulated crash before rename'))
        : actual.rename(from, to),
  };
});

const chatId = 'chat-crash';
const delegationIds = ['first', 'second', 'third'];

function generation(delegationId: string): DelegationRegistryJournalEffect {
  return {
    kind: 'delegation-generation',
    identity: { chatId, delegationId },
    entry: {
      version: 1,
      kind: 'generation',
      chatId,
      delegationId,
      runGeneration: 1,
      createdAt: 10,
      store: 'stream',
      origin: { kind: 'launch' },
      executionMode: 'background',
    },
  };
}

function result(delegationId: string): DelegationRegistryJournalEffect {
  return {
    kind: 'delegation-result',
    target: { kind: 'delegation', chatId, delegationId, runGeneration: 1 },
    entry: {
      version: 1,
      kind: 'result',
      resultIndex: 1,
      runGeneration: 1,
      settlementKey: `settlement-${delegationId}`,
      settlementDigest: 'b'.repeat(64),
      outcome: { status: 'completed', finishedAt: 20 },
      answer: {
        kind: 'body',
        role: 'final',
        byteLength: 5,
        encoding: 'utf8',
        sha256: 'a'.repeat(64),
        ref: {
          version: 1,
          artifactId: `answer-${delegationId}`,
          byteLength: 5,
          sha256: 'a'.repeat(64),
          encoding: 'utf-8',
          mediaType: 'text/plain',
        },
      },
      settlement: {
        streamRevision: 2,
        contentRevision: 2,
        finalItemCount: 0,
        finalItemsDigest: 'c'.repeat(64),
      },
    },
  };
}

const results = delegationIds.map(result);

async function highWaters(
  store: DelegationRegistryStore,
): Promise<DelegationRegistryCheckpoint[]> {
  const checkpoints: DelegationRegistryCheckpoint[] = [];
  for (const delegationId of delegationIds)
    checkpoints.push(await store.highWater({ chatId, delegationId }));
  return checkpoints;
}

/** The released builds' recovery: one identity at a time. */
async function checkpointEach(store: DelegationRegistryStore): Promise<void> {
  for (const checkpoint of await highWaters(store))
    await store.checkpoint(checkpoint);
}

async function manifestRevision(root: string): Promise<number> {
  const value: unknown = JSON.parse(
    await readFile(
      join(root, 'delegations', chatId, 'registry', 'manifest.json'),
      'utf8',
    ),
  );
  const revision: unknown =
    typeof value === 'object' && value !== null
      ? Reflect.get(value, 'revision')
      : undefined;
  if (typeof revision !== 'number') throw new Error('Unreadable manifest');
  return revision;
}

async function publishedHighWaters(root: string): Promise<number[]> {
  const registry = join(root, 'delegations', chatId, 'registry');
  const values: number[] = [];
  for (const entry of await readdir(registry, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const head: unknown = JSON.parse(
      await readFile(join(registry, entry.name, 'head.json'), 'utf8'),
    );
    const highWater: unknown =
      typeof head === 'object' && head !== null
        ? Reflect.get(head, 'highWater')
        : undefined;
    if (typeof highWater === 'number') values.push(highWater);
  }
  return values.sort();
}

async function expectRecovered(root: string): Promise<void> {
  const reader = new DelegationRegistryStore(root);
  for (const effect of results) {
    if (effect.kind !== 'delegation-result') continue;
    const { delegationId } = effect.target;
    await expect(
      reader.result({ chatId, delegationId, resultIndex: 1 }),
    ).resolves.toEqual(effect.entry);
    await expect(
      reader.highWater({ chatId, delegationId }),
    ).resolves.toMatchObject({ highWater: 2 });
  }
}

const isHead = (to: string): boolean => to.endsWith(`${sep}head.json`);
/**
 * Where each image stops: the nth matching rename. Once tripped, every later
 * rename fails too, as after a crash.
 */
const crashPoints = {
  // A locator, while the identities' segments and indexes are staged.
  staging: {
    matches: (to: string): boolean =>
      !to.endsWith(`${sep}manifest.json`) &&
      !isHead(to) &&
      !to.endsWith(`${sep}checkpoint.json`),
    nth: 1,
  },
  manifest: {
    matches: (to: string): boolean => to.endsWith(`${sep}manifest.json`),
    nth: 1,
  },
  'first head': { matches: isHead, nth: 1 },
  // One head is published and the others are not.
  'second head': { matches: isHead, nth: 2 },
  'checkpoint file': {
    matches: (to: string): boolean => to.endsWith(`${sep}checkpoint.json`),
    nth: 1,
  },
} as const;
type CrashPoint = keyof typeof crashPoints;
const crashPointNames: CrashPoint[] = [
  'staging',
  'manifest',
  'first head',
  'second head',
  'checkpoint file',
];
/** Published heads past the first checkpoint, and whether the manifest moved. */
const expectedImage: Record<
  CrashPoint,
  { advanced: number; manifestAdvanced: boolean }
> = {
  staging: { advanced: 0, manifestAdvanced: false },
  manifest: { advanced: 0, manifestAdvanced: false },
  'first head': { advanced: 0, manifestAdvanced: true },
  'second head': { advanced: 1, manifestAdvanced: true },
  'checkpoint file': { advanced: 3, manifestAdvanced: true },
};

function armCrash(point: CrashPoint): void {
  const { matches, nth } = crashPoints[point];
  let seen = 0;
  let crashed = false;
  mockFsFaults.failRename = (_from, to): boolean => {
    if (!crashed && matches(to) && ++seen === nth) crashed = true;
    return crashed;
  };
}

/** Checkpoints the generations, appends the results, then crashes. */
async function crashImage(
  root: string,
  point: CrashPoint,
): Promise<{ before: string; beforeRevision: number }> {
  const writer = new DelegationRegistryStore(root);
  await writer.append(chatId, delegationIds.map(generation));
  await writer.checkpointChat(await highWaters(writer));
  const before = await registrySnapshotDigest(root, chatId);
  const beforeRevision = await manifestRevision(root);
  await writer.append(chatId, results);
  const checkpoints = await highWaters(writer);
  armCrash(point);
  await expect(writer.checkpointChat(checkpoints)).rejects.toThrow(
    'simulated crash before rename',
  );
  mockFsFaults.failRename = undefined;
  return { before, beforeRevision };
}

afterEach(() => {
  mockFsFaults.failRename = undefined;
});

describe('chat registry checkpoint crash images', () => {
  let clean: string;
  let cleanDigest: string;

  beforeAll(async () => {
    clean = await mkdtemp(join(tmpdir(), 'registry-crash-clean-'));
    const writer = new DelegationRegistryStore(clean);
    await writer.append(chatId, delegationIds.map(generation));
    await writer.checkpointChat(await highWaters(writer));
    await writer.append(chatId, results);
    await writer.checkpointChat(await highWaters(writer));
    cleanDigest = await registrySnapshotDigest(clean, chatId);
  });

  afterAll(async () => {
    await rm(clean, { recursive: true, force: true });
  });

  it('leaves the same files as checkpointing one identity at a time', async () => {
    const each = await mkdtemp(join(tmpdir(), 'registry-crash-each-'));
    try {
      const writer = new DelegationRegistryStore(each);
      await writer.append(chatId, delegationIds.map(generation));
      await checkpointEach(writer);
      await writer.append(chatId, results);
      await checkpointEach(writer);
      expect(await files(each)).toEqual(await files(clean));
    } finally {
      await rm(each, { recursive: true, force: true });
    }
  });

  it.each(crashPointNames)(
    'recovers a checkpoint stopped at the %s rename',
    async (point) => {
      for (const recovery of ['chat', 'each'] as const) {
        const root = await mkdtemp(join(tmpdir(), 'registry-crash-'));
        try {
          const { before, beforeRevision } = await crashImage(root, point);
          // Each image is the state it names, and the manifest is never
          // behind a published head.
          const advanced = (await publishedHighWaters(root)).filter(
            (highWater) => highWater > 1,
          ).length;
          const manifestAdvanced =
            (await manifestRevision(root)) > beforeRevision;
          expect({ advanced, manifestAdvanced }).toEqual(expectedImage[point]);
          if (advanced > 0) expect(manifestAdvanced).toBe(true);

          // Recovery replays the intact journal into a new store.
          const recovered = new DelegationRegistryStore(root);
          await recovered.append(chatId, results);
          if (recovery === 'chat')
            await recovered.checkpointChat(await highWaters(recovered));
          else await checkpointEach(recovered);
          await expectRecovered(root);
          const digest = await registrySnapshotDigest(root, chatId);
          expect(digest).not.toBe(before);
          // A crash before the manifest folds nothing twice.
          if (point === 'staging') expect(digest).toBe(cleanDigest);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});

/** Every file under a root, by relative path. */
async function files(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(root.length)] = (await readFile(path)).toString('base64');
  }
  return out;
}
