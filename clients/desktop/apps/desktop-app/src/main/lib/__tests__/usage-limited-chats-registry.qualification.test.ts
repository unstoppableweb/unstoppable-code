/**
 * CAN-4475 R0-F5, usage-limit interruption records on the in-app host
 * (CAN-7176): the guarantees the registry keeps today, against its real
 * file. Recording interrupted chats at quit keeps every existing usage and
 * authentication reason, a provider sign-in replaces its chat's entry, a
 * clear keeps a newer interruption than the one it finishes, and the strict
 * write publishes the whole new file or leaves the old one.
 */
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsageLimitedChatEntry } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import {
  clearUsageLimitedChat,
  readUsageLimitedChats,
  recordInterruptedChats,
} from '../usage-limited-chats-registry';
import { getUsageLimitedChatsFilePath } from '../paths';

jest.mock('../../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: () => void; clear: () => void } => ({
    mark: (): void => undefined,
    clear: (): void => undefined,
  }),
}));

// Fails the rename that publishes the registry, as a crash before it would.
const mockFault: { renameTo?: string } = {};
jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    rename: (from: string, to: string): Promise<void> =>
      to === mockFault.renameTo
        ? Promise.reject(new Error('simulated crash'))
        : actual.rename(from, to),
  };
});

let root: string;
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'r0-usage-limited-'));
  process.env.CANOPY_DATA_DIR = root;
  resetResolvedCanopyDataDirForTests();
});

afterEach(async () => {
  delete mockFault.renameTo;
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  resetResolvedCanopyDataDirForTests();
  await rm(root, { recursive: true, force: true });
});

function chat(
  chatId: string,
  resumeReason: UsageLimitedChatEntry['resumeReason'],
  detectedAt: number,
): UsageLimitedChatEntry {
  return {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId,
    provider: 'claude',
    detectedAt,
    resumeReason,
    workspaceName: 'Workspace',
    chatTitle: chatId,
  };
}

function byChat(
  entries: UsageLimitedChatEntry[],
): Record<string, string | undefined> {
  return Object.fromEntries(
    entries.map((entry) => [entry.chatId, entry.resumeReason]),
  );
}

it('R0-F5 registry: quit records each interrupted chat once and keeps every existing usage and authentication reason', async () => {
  await recordInterruptedChats([
    chat('limited', 'usage_limit', 1),
    chat('signed-out', 'authentication', 2),
  ]);
  await recordInterruptedChats([
    chat('limited', 'app_shutdown', 10),
    chat('signed-out', 'app_shutdown', 10),
    chat('running', 'app_shutdown', 10),
    chat('running', 'app_shutdown', 11),
  ]);
  const entries = await readUsageLimitedChats(true);
  expect(byChat(entries)).toEqual({
    limited: 'usage_limit',
    'signed-out': 'authentication',
    running: 'app_shutdown',
  });
  expect(entries.filter((entry) => entry.chatId === 'running')).toHaveLength(1);
});

it('R0-F5 registry: a provider sign-in interruption replaces its chat entry', async () => {
  await recordInterruptedChats([chat('chat', 'app_shutdown', 1)]);
  await recordInterruptedChats([chat('chat', 'provider_sign_in', 2)]);
  const entries = await readUsageLimitedChats(true);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    resumeReason: 'provider_sign_in',
    detectedAt: 2,
  });
});

it('R0-F5 registry: a clear keeps an interruption newer than the resume it finishes, and an exact clear removes only its own', async () => {
  await recordInterruptedChats([chat('chat', 'app_shutdown', 100)]);
  await clearUsageLimitedChat(
    { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' },
    { onlyIfDetectedBefore: 100 },
  );
  expect(await readUsageLimitedChats(true)).toHaveLength(1);
  await clearUsageLimitedChat(
    { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' },
    { onlyIfDetectedAt: 99 },
  );
  expect(await readUsageLimitedChats(true)).toHaveLength(1);
  await clearUsageLimitedChat(
    { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' },
    { onlyIfDetectedAt: 100 },
  );
  expect(await readUsageLimitedChats(true)).toEqual([]);
});

it('R0-F5 registry: a strict write stopped before its rename leaves the previous file whole', async () => {
  await recordInterruptedChats([chat('first', 'app_shutdown', 1)]);
  const before = await readFile(getUsageLimitedChatsFilePath(), 'utf8');
  mockFault.renameTo = getUsageLimitedChatsFilePath();
  await expect(
    recordInterruptedChats([chat('second', 'app_shutdown', 2)]),
  ).rejects.toThrow('simulated crash');
  delete mockFault.renameTo;
  expect(await readFile(getUsageLimitedChatsFilePath(), 'utf8')).toBe(before);
  expect(byChat(await readUsageLimitedChats(true))).toEqual({
    first: 'app_shutdown',
  });
});
