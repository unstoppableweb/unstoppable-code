import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getGitHubRefreshLedgerFilePath } from './paths';

const LEDGER_VERSION = 1;
const MAX_LEDGER_ENTRIES = 2_000;
const FAILURE_BACKOFF_BASE_MS = 2_000;
const FAILURE_BACKOFF_MAX_MS = 20_000;

export interface GitHubRefreshLedgerEntry {
  createdAt?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  dataUpdatedAt?: string;
  nextDueAt?: string;
  lastFailureAt?: string;
  retryAfterAt?: string;
  consecutiveFailures: number;
}

interface GitHubRefreshLedgerFile {
  version: 1;
  entries: Record<string, GitHubRefreshLedgerEntry>;
}

let loadedLedger: GitHubRefreshLedgerFile | null = null;
let loadPromise: Promise<GitHubRefreshLedgerFile> | null = null;
let writeChain = Promise.resolve();

function readProperty(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function ledgerKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }
  return value;
}

function parseEntry(value: unknown): GitHubRefreshLedgerEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const createdAt = readProperty(value, 'createdAt');
  const lastAttemptAt = parseTimestamp(readProperty(value, 'lastAttemptAt'));
  const lastSuccessAt = parseTimestamp(readProperty(value, 'lastSuccessAt'));
  const dataUpdatedAt = parseTimestamp(readProperty(value, 'dataUpdatedAt'));
  const nextDueAt = parseTimestamp(readProperty(value, 'nextDueAt'));
  const lastFailureAt = parseTimestamp(readProperty(value, 'lastFailureAt'));
  const retryAfterAt = parseTimestamp(readProperty(value, 'retryAfterAt'));
  const storedConsecutiveFailures = readProperty(value, 'consecutiveFailures');
  const consecutiveFailures =
    typeof storedConsecutiveFailures === 'number' &&
    Number.isSafeInteger(storedConsecutiveFailures) &&
    storedConsecutiveFailures >= 0
      ? storedConsecutiveFailures
      : 0;
  return {
    ...(typeof createdAt === 'string' ? { createdAt } : {}),
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(dataUpdatedAt ? { dataUpdatedAt } : {}),
    ...(nextDueAt ? { nextDueAt } : {}),
    ...(lastFailureAt ? { lastFailureAt } : {}),
    ...(retryAfterAt ? { retryAfterAt } : {}),
    consecutiveFailures,
  };
}

async function loadLedger(): Promise<GitHubRefreshLedgerFile> {
  if (loadedLedger) {
    return loadedLedger;
  }
  if (loadPromise) {
    return loadPromise;
  }
  loadPromise = (async (): Promise<GitHubRefreshLedgerFile> => {
    const entries: Record<string, GitHubRefreshLedgerEntry> = {};
    try {
      const parsed: unknown = JSON.parse(
        await readFile(getGitHubRefreshLedgerFilePath(), 'utf8'),
      );
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        readProperty(parsed, 'version') === LEDGER_VERSION
      ) {
        const rawEntries = readProperty(parsed, 'entries');
        if (
          typeof rawEntries === 'object' &&
          rawEntries !== null &&
          !Array.isArray(rawEntries)
        ) {
          for (const [key, rawEntry] of Object.entries(rawEntries)) {
            const entry = parseEntry(rawEntry);
            if (entry) {
              entries[key] = entry;
            }
          }
        }
      }
    } catch {
      // A missing or corrupt advisory ledger is a cold-cache miss.
    }
    loadedLedger = { version: LEDGER_VERSION, entries };
    return loadedLedger;
  })();
  return loadPromise;
}

function pruneEntries(entries: Record<string, GitHubRefreshLedgerEntry>): void {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_LEDGER_ENTRIES) {
    return;
  }
  keys
    .sort((left, right) => {
      const leftAt = Date.parse(
        entries[left]?.lastAttemptAt ?? entries[left]?.lastSuccessAt ?? '',
      );
      const rightAt = Date.parse(
        entries[right]?.lastAttemptAt ?? entries[right]?.lastSuccessAt ?? '',
      );
      return (leftAt || 0) - (rightAt || 0);
    })
    .slice(0, keys.length - MAX_LEDGER_ENTRIES)
    .forEach((key) => delete entries[key]);
}

async function persistLedger(ledger: GitHubRefreshLedgerFile): Promise<void> {
  const filePath = getGitHubRefreshLedgerFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  pruneEntries(ledger.entries);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function updateEntry(
  projectId: string,
  worktreeId: string,
  createdAt: string | undefined,
  updater: (entry: GitHubRefreshLedgerEntry) => GitHubRefreshLedgerEntry,
): Promise<GitHubRefreshLedgerEntry> {
  let updated: GitHubRefreshLedgerEntry | undefined;
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      const ledger = await loadLedger();
      const key = ledgerKey(projectId, worktreeId);
      const stored = ledger.entries[key];
      const current =
        stored &&
        (!createdAt || !stored.createdAt || stored.createdAt === createdAt)
          ? stored
          : { consecutiveFailures: 0 };
      updated = updater({
        ...current,
        ...(createdAt ? { createdAt } : {}),
      });
      ledger.entries[key] = updated;
      await persistLedger(ledger);
    });
  await writeChain;
  return updated ?? { consecutiveFailures: 0 };
}

export async function readGitHubRefreshLedgerEntry(
  projectId: string,
  worktreeId: string,
  createdAt?: string,
): Promise<GitHubRefreshLedgerEntry | null> {
  await writeChain;
  const ledger = await loadLedger();
  const entry = ledger.entries[ledgerKey(projectId, worktreeId)];
  if (
    !entry ||
    (createdAt && entry.createdAt && entry.createdAt !== createdAt)
  ) {
    return null;
  }
  return { ...entry };
}

export async function recordGitHubRefreshAttempt(args: {
  projectId: string;
  worktreeId: string;
  createdAt?: string;
  attemptedAt: number;
}): Promise<void> {
  await updateEntry(
    args.projectId,
    args.worktreeId,
    args.createdAt,
    (entry) => ({
      ...entry,
      lastAttemptAt: new Date(args.attemptedAt).toISOString(),
    }),
  );
}

export async function recordGitHubRefreshSuccess(args: {
  projectId: string;
  worktreeId: string;
  createdAt?: string;
  succeededAt: number;
  dataChanged: boolean;
  nextDueAt: number;
}): Promise<void> {
  await updateEntry(
    args.projectId,
    args.worktreeId,
    args.createdAt,
    (entry) => ({
      ...entry,
      lastAttemptAt:
        entry.lastAttemptAt ?? new Date(args.succeededAt).toISOString(),
      lastSuccessAt: new Date(args.succeededAt).toISOString(),
      dataUpdatedAt:
        args.dataChanged || !entry.dataUpdatedAt
          ? new Date(args.succeededAt).toISOString()
          : entry.dataUpdatedAt,
      nextDueAt: new Date(args.nextDueAt).toISOString(),
      consecutiveFailures: 0,
      lastFailureAt: undefined,
      retryAfterAt: undefined,
    }),
  );
}

export async function recordGitHubRefreshFailure(args: {
  projectId: string;
  worktreeId: string;
  createdAt?: string;
  failedAt: number;
}): Promise<GitHubRefreshLedgerEntry> {
  return updateEntry(
    args.projectId,
    args.worktreeId,
    args.createdAt,
    (entry) => {
      const consecutiveFailures = entry.consecutiveFailures + 1;
      const backoffMs = Math.min(
        FAILURE_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1),
        FAILURE_BACKOFF_MAX_MS,
      );
      return {
        ...entry,
        lastAttemptAt:
          entry.lastAttemptAt ?? new Date(args.failedAt).toISOString(),
        lastFailureAt: new Date(args.failedAt).toISOString(),
        retryAfterAt: new Date(args.failedAt + backoffMs).toISOString(),
        consecutiveFailures,
      };
    },
  );
}

/** Serialized with attempts/results, so retiring a worktree cannot lose a neighbor's write. */
export async function removeGitHubRefreshLedgerEntry(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      const ledger = await loadLedger();
      if (!(ledgerKey(projectId, worktreeId) in ledger.entries)) return;
      delete ledger.entries[ledgerKey(projectId, worktreeId)];
      await persistLedger(ledger);
    });
  await writeChain;
}
