import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EXTERNAL_PROJECT_PROVIDERS,
  type ExternalProjectProvider,
} from '@canopy/desktop-shared/types';
import { getExternalProjectImportsFilePath } from '../lib/paths';
import { isRecord } from '../lib/type-guards';

/**
 * Canopy-owned import ledger for the bulk Claude/Codex project import
 * (CAN-2439). Provider stores are discovery inputs only; this file is what
 * makes repeat scans idempotent: a root that already became a project is
 * reported as imported instead of duplicated, and a provider session that
 * already became a chat is not offered again.
 *
 * Versioned (`version: 1`), normalized on read, and written atomically.
 * Missing or corrupt files fall back to an empty ledger — losing the ledger
 * only weakens de-duplication (the workspace registry still catches exact
 * path matches); it never fabricates imports.
 */

export const EXTERNAL_PROJECT_IMPORTS_FILE_VERSION = 1;

type ExternalProjectBackingProvider = 'claude' | 'codex' | 'opencode';

export interface ExternalProjectImportedSession {
  chatId: string;
  worktreeId: string;
  importedAt: string;
  backingProvider?: ExternalProjectBackingProvider;
  archived?: boolean;
  /** Other source ids that resolve to this chat (same session, other store). */
  aliasIds?: string[];
}

export interface ExternalProjectImportLedgerEntry {
  workspaceId: string;
  rootPath: string;
  providers: ExternalProjectProvider[];
  importedAt: string;
  /**
   * Worktree or Work Entry the newest chat import for this project went to.
   * Recorded as soon as the destination exists, independently of the
   * per-session records, so a retry still finds it when a session write
   * failed after the tabs were persisted.
   */
  chatWorktreeId?: string;
  sessions: Record<string, ExternalProjectImportedSession>;
}

export interface ExternalProjectImportLedger {
  imports: Record<string, ExternalProjectImportLedgerEntry>;
  lastScanAt: string | null;
  inviteShownAt: string | null;
}

interface ExternalProjectImportLedgerFile extends ExternalProjectImportLedger {
  version: number;
  updatedAt: string;
}

let cache: ExternalProjectImportLedger | null = null;
let writeChain: Promise<void> = Promise.resolve();

function emptyLedger(): ExternalProjectImportLedger {
  return { imports: {}, lastScanAt: null, inviteShownAt: null };
}

const PROVIDER_NAMES: readonly string[] = EXTERNAL_PROJECT_PROVIDERS;

function isProvider(value: unknown): value is ExternalProjectProvider {
  return typeof value === 'string' && PROVIDER_NAMES.includes(value);
}

const BACKING_PROVIDERS: readonly string[] = ['claude', 'codex', 'opencode'];

function isBackingProvider(
  value: unknown,
): value is ExternalProjectBackingProvider {
  return typeof value === 'string' && BACKING_PROVIDERS.includes(value);
}

function optionalIso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function normalizeSessions(
  value: unknown,
): Record<string, ExternalProjectImportedSession> {
  if (!isRecord(value)) return {};
  const sessions: Record<string, ExternalProjectImportedSession> = {};
  for (const [sessionId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    if (
      typeof raw.chatId !== 'string' ||
      typeof raw.worktreeId !== 'string' ||
      typeof raw.importedAt !== 'string'
    ) {
      continue;
    }
    const aliasIds = Array.isArray(raw.aliasIds)
      ? Array.from(new Set(raw.aliasIds.filter((id) => typeof id === 'string')))
      : [];
    sessions[sessionId] = {
      chatId: raw.chatId,
      worktreeId: raw.worktreeId,
      importedAt: raw.importedAt,
      ...(isBackingProvider(raw.backingProvider)
        ? { backingProvider: raw.backingProvider }
        : {}),
      ...(typeof raw.archived === 'boolean' ? { archived: raw.archived } : {}),
      ...(aliasIds.length > 0 ? { aliasIds } : {}),
    };
  }
  return sessions;
}

export function normalizeExternalProjectImportLedger(
  raw: unknown,
): ExternalProjectImportLedger {
  if (!isRecord(raw)) return emptyLedger();
  const imports: Record<string, ExternalProjectImportLedgerEntry> = {};
  if (isRecord(raw.imports)) {
    for (const [candidateId, entry] of Object.entries(raw.imports)) {
      if (!isRecord(entry)) continue;
      if (
        typeof entry.workspaceId !== 'string' ||
        typeof entry.rootPath !== 'string' ||
        typeof entry.importedAt !== 'string'
      ) {
        continue;
      }
      const providers = Array.isArray(entry.providers)
        ? entry.providers.filter(isProvider)
        : [];
      imports[candidateId] = {
        workspaceId: entry.workspaceId,
        rootPath: entry.rootPath,
        providers,
        importedAt: entry.importedAt,
        ...(typeof entry.chatWorktreeId === 'string' && entry.chatWorktreeId
          ? { chatWorktreeId: entry.chatWorktreeId }
          : {}),
        sessions: normalizeSessions(entry.sessions),
      };
    }
  }
  return {
    imports,
    lastScanAt: optionalIso(raw.lastScanAt),
    inviteShownAt: optionalIso(raw.inviteShownAt),
  };
}

async function loadLedgerFromDisk(): Promise<ExternalProjectImportLedger> {
  try {
    const raw = await readFile(getExternalProjectImportsFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return normalizeExternalProjectImportLedger(parsed);
  } catch {
    return emptyLedger();
  }
}

function cloneLedger(
  ledger: ExternalProjectImportLedger,
): ExternalProjectImportLedger {
  return {
    imports: Object.fromEntries(
      Object.entries(ledger.imports).map(([id, entry]) => [
        id,
        {
          ...entry,
          providers: [...entry.providers],
          sessions: { ...entry.sessions },
        },
      ]),
    ),
    lastScanAt: ledger.lastScanAt,
    inviteShownAt: ledger.inviteShownAt,
  };
}

export async function readExternalProjectImportLedger(): Promise<ExternalProjectImportLedger> {
  cache ??= await loadLedgerFromDisk();
  return cloneLedger(cache);
}

async function persist(ledger: ExternalProjectImportLedger): Promise<void> {
  const filePath = getExternalProjectImportsFilePath();
  const file: ExternalProjectImportLedgerFile = {
    version: EXTERNAL_PROJECT_IMPORTS_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    ...ledger,
  };
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(file, null, 2), 'utf8');
  try {
    await rename(temporary, filePath);
  } catch (error) {
    // The random suffix means no later run would reclaim a leaked temp file.
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function mutateLedger(
  mutate: (ledger: ExternalProjectImportLedger) => void,
): Promise<ExternalProjectImportLedger> {
  const run = writeChain.then(async () => {
    const current = cloneLedger(cache ?? (await loadLedgerFromDisk()));
    mutate(current);
    await persist(current);
    cache = current;
  });
  writeChain = run.catch(() => undefined);
  await run;
  return readExternalProjectImportLedger();
}

export function recordExternalProjectImport(args: {
  candidateId: string;
  workspaceId: string;
  rootPath: string;
  providers: ExternalProjectProvider[];
  importedAt?: string;
}): Promise<ExternalProjectImportLedger> {
  return mutateLedger((ledger) => {
    const existing = ledger.imports[args.candidateId];
    ledger.imports[args.candidateId] = {
      workspaceId: args.workspaceId,
      rootPath: args.rootPath,
      providers: Array.from(
        new Set([...(existing?.providers ?? []), ...args.providers]),
      ),
      importedAt:
        existing?.importedAt ?? args.importedAt ?? new Date().toISOString(),
      ...(existing?.chatWorktreeId
        ? { chatWorktreeId: existing.chatWorktreeId }
        : {}),
      sessions: existing?.sessions ?? {},
    };
  });
}

/**
 * Drops a project's ledger entry when it still records no chats. Used when
 * an already-tracked project was ledgered provisionally so its chat
 * destination could be recorded, and then no chat landed; leaving the entry
 * would hide the candidate as imported. An entry that has since gained
 * session records (another run got there first) is kept.
 */
export function removeExternalProjectImport(
  candidateId: string,
): Promise<ExternalProjectImportLedger> {
  return mutateLedger((ledger) => {
    const entry = ledger.imports[candidateId];
    if (!entry || Object.keys(entry.sessions).length > 0) return;
    delete ledger.imports[candidateId];
  });
}

/** Names the destination a chat import is about to fill, before any chat lands. */
export function recordExternalProjectChatDestination(args: {
  candidateId: string;
  worktreeId: string;
}): Promise<ExternalProjectImportLedger> {
  return mutateLedger((ledger) => {
    const entry = ledger.imports[args.candidateId];
    if (!entry) return;
    entry.chatWorktreeId = args.worktreeId;
  });
}

/** What the import records for one chat: the ledger key plus its session record. */
export interface ExternalProjectSessionImport extends Omit<
  ExternalProjectImportedSession,
  'importedAt'
> {
  sessionId: string;
}

/** One ledger write for every chat an import run produced for a candidate. */
export function recordExternalProjectSessionImports(args: {
  candidateId: string;
  sessions: ReadonlyArray<ExternalProjectSessionImport>;
  importedAt?: string;
}): Promise<ExternalProjectImportLedger> {
  return mutateLedger((ledger) => {
    const entry = ledger.imports[args.candidateId];
    if (!entry) return;
    const importedAt = args.importedAt ?? new Date().toISOString();
    for (const { sessionId, ...record } of args.sessions) {
      entry.sessions[sessionId] = { ...record, importedAt };
    }
  });
}

/**
 * The ledger record a discovered session already became, if any. A session is
 * recorded under its store id (T3 `thread_id`, OpenCode `session_v2.id`) or
 * its own id, and a T3 thread also names its native session as an alias, so
 * a rescan finds the import whether the conversation now shows up as the T3
 * thread or as the Codex, Claude, or OpenCode session behind it. The session's
 * own aliases are looked up as keys too: a chat imported through the agent's
 * record is keyed by the native id, which a T3 thread still carries after
 * that record is gone.
 */
export function findImportedSession(
  sessions: Readonly<Record<string, ExternalProjectImportedSession>>,
  session: { id: string; storeId?: string; aliasIds?: readonly string[] },
): ExternalProjectImportedSession | undefined {
  const ids = [session.storeId, session.id, ...(session.aliasIds ?? [])].filter(
    (id): id is string => id !== undefined,
  );
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(sessions, id)) return sessions[id];
  }
  return Object.values(sessions).find((record) =>
    record.aliasIds?.some((alias) => ids.includes(alias)),
  );
}

export function markExternalProjectScan(
  at: string = new Date().toISOString(),
): Promise<ExternalProjectImportLedger> {
  return mutateLedger((ledger) => {
    ledger.lastScanAt = at;
  });
}

export function markExternalProjectInviteShown(
  at: string = new Date().toISOString(),
): Promise<ExternalProjectImportLedger> {
  return mutateLedger((ledger) => {
    ledger.inviteShownAt = at;
  });
}

/** Test-only: forget the in-memory copy so the next read hits disk. */
export function resetExternalProjectImportLedgerForTests(): void {
  cache = null;
  writeChain = Promise.resolve();
}
