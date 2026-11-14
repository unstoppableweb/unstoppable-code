import type { ChatReadSelection } from '../services/chat-state-v2-backend';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  getProviderForModel,
  type ArchivedChatEntry,
  type ArchivedChatSummary,
  type ArchivedChatsFile,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { KeyedAsyncLock } from './keyed-async-lock';
import {
  resolveChatArchivesFilePath,
  resolveChatTabsFilePath,
  resolveChatJournalFilePath,
} from './resolve-worktree';
import { ChatStorageV2 } from './chat-storage-v2';
import { isPersistedChatTab } from './chat-tabs-reader';
import { isRecord } from './type-guards';

export type { ArchivedChatsFile } from '@canopy/desktop-shared/types';

export const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const archiveMutationLocks = new KeyedAsyncLock();

interface ArchivedChatsFileEnvelope extends Omit<
  ArchivedChatsFile,
  'archived'
> {
  archived: unknown[];
}

function isArchivedChatsFileEnvelope(
  value: unknown,
): value is ArchivedChatsFileEnvelope {
  return (
    isRecord(value) && value.version === 1 && Array.isArray(value.archived)
  );
}

function emptyArchivesFile(): ArchivedChatsFile {
  return {
    version: 1,
    archived: [],
  };
}

export async function readChatArchivesFile(
  projectId: string,
  worktreeId: string,
  selection: ChatReadSelection = {},
): Promise<ArchivedChatsFile> {
  // Lazy import breaks the compatibility archive/state projection cycle.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  return getChatStateService().getCompatibilityArchives(
    {
      projectId,
      worktreeId,
    },
    selection,
  );
}

/** Metadata-only archive read without migration, recovery or checkpoint writes. */
export async function readChatArchiveMetadata(
  projectId: string,
  worktreeId: string,
): Promise<ArchivedChatsFile> {
  const storage = ChatStorageV2.fromLegacyPaths({
    tabs: resolveChatTabsFilePath(projectId, worktreeId),
    archives: resolveChatArchivesFilePath(projectId, worktreeId),
    journal: resolveChatJournalFilePath(projectId, worktreeId),
  });
  if ((await storage.authority()) === 'v1') {
    const legacy = await readChatArchivesFileUnlocked(projectId, worktreeId);
    // Migration can publish authority and remove the legacy file during the read.
    if ((await storage.authority()) === 'v1') return legacy;
  }
  const { archive } = await storage.indexes();
  return {
    version: 1,
    archived: archive.archived.map((entry) => ({
      ...entry,
      tab: { ...entry.tab, messages: [] },
    })),
  };
}

/**
 * Compatibility index reader. Only a missing file projects as an empty index;
 * malformed content fails closed so destructive callers cannot mistake
 * corruption for an authoritative empty store.
 */
export async function readChatArchivesFileForIndex(
  projectId: string,
  worktreeId: string,
): Promise<ArchivedChatsFile> {
  return readChatArchivesFile(projectId, worktreeId);
}

/** Test-only snapshot reader for low-level storage coverage. */
export async function readChatArchivesSnapshotForTests(
  projectId: string,
  worktreeId: string,
): Promise<ArchivedChatsFile> {
  await waitForArchiveMutation(projectId, worktreeId);
  return readChatArchivesFileUnlocked(projectId, worktreeId);
}

async function readChatArchivesFileUnlocked(
  projectId: string,
  worktreeId: string,
): Promise<ArchivedChatsFile> {
  try {
    return await readChatArchivesFileStrict(projectId, worktreeId);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return emptyArchivesFile();
    }
    throw error;
  }
}

async function readChatArchivesFileStrict(
  projectId: string,
  worktreeId: string,
): Promise<ArchivedChatsFile> {
  const filePath = resolveChatArchivesFilePath(projectId, worktreeId);
  const raw = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);

  if (!isArchivedChatsFileEnvelope(parsed)) {
    throw new ChatArchiveFileCorruptionError(
      `Invalid chat archives file: ${filePath}`,
    );
  }

  if (!parsed.archived.every(isArchivedChatEntry)) {
    throw new ChatArchiveFileCorruptionError(
      `Invalid chat archive entry in file: ${filePath}`,
    );
  }

  return { ...parsed, archived: parsed.archived };
}

class ChatArchiveFileCorruptionError extends Error {}

export async function writeChatArchivesSnapshotForTests(
  projectId: string,
  worktreeId: string,
  data: ArchivedChatsFile,
): Promise<void> {
  const filePath = resolveChatArchivesFilePath(projectId, worktreeId);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Deprecated compatibility adapter; canonical persistence is service-owned. */
export async function writeChatArchivesFile(
  projectId: string,
  worktreeId: string,
  data: ArchivedChatsFile,
  options: { authoritative?: boolean } = {},
): Promise<void> {
  // Lazy import breaks the compatibility archive/state projection cycle.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  await getChatStateService().replaceCompatibilityArchives(
    { projectId, worktreeId },
    data,
    options,
  );
}

/** Deprecated compatibility adapter; canonical persistence is service-owned. */
export async function removeChatArchive(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<ArchivedChatEntry | null> {
  // Lazy import breaks the compatibility archive/state projection cycle.
  const { getChatStateService } =
    await import('../services/chat-state-service');
  return getChatStateService().removeCompatibilityArchive(
    { projectId, worktreeId },
    chatId,
  );
}

/** Test-only read/modify/write helper for the low-level snapshot suite. */
export async function appendChatArchiveSnapshotForTests(
  projectId: string,
  worktreeId: string,
  entry: ArchivedChatEntry,
): Promise<ArchivedChatsFile> {
  return withArchiveMutationLock(projectId, worktreeId, async () => {
    const current = await readChatArchivesFileUnlocked(projectId, worktreeId);
    const next: ArchivedChatsFile = {
      version: 1,
      archived: [
        entry,
        ...current.archived.filter(
          (candidate) => candidate.tab.id !== entry.tab.id,
        ),
      ],
    };
    await writeChatArchivesSnapshotForTests(projectId, worktreeId, next);
    return next;
  });
}

/** Test-only read/modify/write helper for the low-level snapshot suite. */
export async function removeChatArchiveSnapshotForTests(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<ArchivedChatEntry | null> {
  return withArchiveMutationLock(projectId, worktreeId, async () => {
    const current = await readChatArchivesFileUnlocked(projectId, worktreeId);
    const entry = current.archived.find(
      (candidate) => candidate.tab.id === chatId,
    );
    if (!entry) {
      return null;
    }

    await writeChatArchivesSnapshotForTests(projectId, worktreeId, {
      version: 1,
      archived: current.archived.filter(
        (candidate) => candidate.tab.id !== chatId,
      ),
    });
    return entry;
  });
}

/**
 * Millisecond timestamp of the tab's most recent activity: the last message's
 * timestamp when present, else `createdAt`. Session resumability tracks when
 * the chat was last USED — a months-old chat that talked to its provider
 * yesterday resumes fine, while `createdAt` would wrongly mark it stale.
 */
export function getPersistedTabLastActivityAt(tab: PersistedChatTab): number {
  const createdAt = Date.parse(tab.createdAt);
  let latest = Number.isFinite(createdAt) ? createdAt : 0;
  if (tab.transcript)
    return Math.max(latest, tab.transcript.lastMessageAt ?? 0);
  // Messages are appended chronologically; walk from the end until a usable
  // timestamp appears so long transcripts stay O(1) in practice.
  for (let index = tab.messages.length - 1; index >= 0; index -= 1) {
    const timestamp = tab.messages[index]?.timestamp;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      latest = Math.max(latest, timestamp);
      break;
    }
  }
  return latest;
}

/** Whether the tab's provider session is young enough to attempt a resume. */
export function isTabWithinRestoreWindow(
  tab: PersistedChatTab,
  now: number,
): boolean {
  const lastActivityAt = getPersistedTabLastActivityAt(tab);
  return lastActivityAt > 0 && now - lastActivityAt <= RESTORE_WINDOW_MS;
}

export function toArchivedChatSummary(
  entry: ArchivedChatEntry,
  now: number,
): ArchivedChatSummary {
  const restorable = isTabWithinRestoreWindow(entry.tab, now);
  const providerType =
    entry.tab.providerType ??
    (entry.tab.model ? getProviderForModel(entry.tab.model) : undefined);

  return {
    chatId: entry.tab.id,
    title: entry.tab.title,
    ...(entry.tab.customTitle !== undefined
      ? { customTitle: entry.tab.customTitle }
      : {}),
    ...(entry.tab.description ? { description: entry.tab.description } : {}),
    ...(providerType ? { providerType } : {}),
    ...(entry.tab.model ? { model: entry.tab.model } : {}),
    turnCount: entry.turnCount,
    archivedAt: entry.archivedAt,
    createdAt: entry.tab.createdAt,
    restorable,
    unread: entry.unread === true,
  };
}

/** Set a single archived chat's `unread` flag to false. */
/** Test-only read/modify/write helper for the low-level snapshot suite. */
export async function markChatArchiveReadSnapshotForTests(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<ArchivedChatsFile> {
  return withArchiveMutationLock(projectId, worktreeId, async () => {
    const current = await readChatArchivesFileUnlocked(projectId, worktreeId);
    const next: ArchivedChatsFile = {
      version: 1,
      archived: current.archived.map((entry) =>
        entry.tab.id === chatId && entry.unread
          ? { ...entry, unread: false }
          : entry,
      ),
    };
    await writeChatArchivesSnapshotForTests(projectId, worktreeId, next);
    return next;
  });
}

/** Clear the `unread` flag on every archived chat for a worktree. */
/** Test-only read/modify/write helper for the low-level snapshot suite. */
export async function markAllChatArchivesReadSnapshotForTests(
  projectId: string,
  worktreeId: string,
): Promise<ArchivedChatsFile> {
  return withArchiveMutationLock(projectId, worktreeId, async () => {
    const current = await readChatArchivesFileUnlocked(projectId, worktreeId);
    const next: ArchivedChatsFile = {
      version: 1,
      archived: current.archived.map((entry) =>
        entry.unread ? { ...entry, unread: false } : entry,
      ),
    };
    await writeChatArchivesSnapshotForTests(projectId, worktreeId, next);
    return next;
  });
}

function isArchivedChatEntry(value: unknown): value is ArchivedChatEntry {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isPersistedChatTab(value.tab) &&
    typeof value.archivedAt === 'string' &&
    typeof value.turnCount === 'number'
  );
}

export function isArchivedChatsFile(
  value: unknown,
): value is ArchivedChatsFile {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    Array.isArray(value.archived) &&
    value.archived.every(isArchivedChatEntry)
  );
}

async function withArchiveMutationLock<T>(
  projectId: string,
  worktreeId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  return archiveMutationLocks.run(`${projectId}\0${worktreeId}`, mutate);
}

async function waitForArchiveMutation(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  await archiveMutationLocks.wait(`${projectId}\0${worktreeId}`);
}
