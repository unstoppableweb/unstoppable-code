import { createHash } from 'node:crypto';
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { ExecutionSecretBinding } from '@canopy/protocol/canopy-core';
import {
  AGENT_SECRET_NAME_PATTERN,
  AGENT_SECRET_VALUE_MAX_LENGTH,
} from '@canopy/protocol/agent-secrets';
import { writeFileAtomically } from '../lib/atomic-file';
import { isMissingFileError } from '../lib/fs-utils';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  getAgentChatSecretsFilePath,
  getAgentSecretAuditFilePath,
} from '../lib/paths';
import { getSecretStoragePolicy } from '../lib/secure-storage-policy';
import { isRecord } from '../lib/type-guards';
import { storedSecretRef } from '../lib/stored-secrets';

/*
 * ChatSecretStore: the secrets a person gave an agent through
 * RequestSecrets, kept per chat in Electron main, which runs the chat's
 * commands (CONTRACTS.md §8). Electron main owns it until the daemon vault
 * takes agent secrets (PLAN.md §9).
 *
 * - Values are encrypted with safe storage when persisted; there is no
 *   plaintext fallback. Without secure storage, values stay in this
 *   process's memory for the app session and are never written.
 * - Nothing here returns a value over IPC. Values leave only through the
 *   execution-secret grant reader (`readChatSecretsForExecution`), which a
 *   single-use, 5-minute grant gates.
 * - A chat's secrets are deleted when the chat is archived or deleted and
 *   seven days after they were given.
 * - A value the chat no longer holds because it was revoked or replaced is
 *   retired (CONTRACTS.md §4a): no command can read it again, but it stays,
 *   encrypted like a live value, for redaction only until the chat ends or
 *   its own seven days run out, so a later echo of it (an old file, a log)
 *   is still masked.
 */

export const CHAT_SECRET_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The stored-secret family execution-secret bindings name for chat secrets. */
export const CHAT_SECRET_FAMILY = 'agent.chat';

export interface ChatSecretScope {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

interface StoredEntry {
  /** safeStorage ciphertext, base64. Absent for a session-only value. */
  ciphertext?: string;
  /** Plaintext, only for a session-only value; never written. */
  memoryValue?: string;
  createdAt: number;
  expiresAt: number;
  /** When a command last received it; metadata for the Secrets chip. */
  lastUsedAt?: number;
}

interface ChatRecord {
  scope: ChatSecretScope;
  secrets: Map<string, StoredEntry>;
  /** Revoked and replaced values: for redaction only, never for a command. */
  retired: Array<{ name: string; entry: StoredEntry }>;
}

/**
 * The most retired values one chat keeps. A submission that would retire
 * more is refused rather than forget one, since a forgotten value would no
 * longer be masked.
 */
export const CHAT_SECRET_MAX_RETIRED = 1024;

/** A value the chat holds or held can't be read back to hide it. */
export class ChatSecretValuesUnreadableError extends Error {
  constructor() {
    super('A chat secret value could not be read back.');
    this.name = 'ChatSecretValuesUnreadableError';
  }
}

/**
 * A file WriteSecretsFile wrote, with the values it wrote, kept apart from
 * any chat's live secrets: the file keeps those values on disk after the
 * chat's secrets change, expire or go, so its redaction must too.
 */
interface SecretFileRecord {
  /** The chat that last wrote it. */
  scope: ChatSecretScope;
  values: Array<{ name: string; entry: StoredEntry }>;
  /**
   * When the sweep first found the file gone. Its values stay, for
   * redaction only, for {@link CHAT_SECRET_TTL_MS} more: a rename or copy
   * can still hold them.
   */
  goneAt?: number;
  /**
   * The store's values were lost (it was damaged) but this registration was
   * read back from the separate registrations file: the file holds values
   * nothing can redact, so Canopy's views of it are withheld.
   */
  lost?: boolean;
}

/**
 * The most distinct values one secrets file may have been given. A merge
 * keeps earlier values in the file, so none is ever dropped from its
 * record; a write past this is refused instead (replace starts afresh).
 */
export const SECRET_FILE_MAX_VALUES = 1024;

/** A secrets file's values can't be read back to redact it. */
export class SecretFileValuesUnavailableError extends Error {
  constructor() {
    super("A secrets file's values could not be read.");
    this.name = 'SecretFileValuesUnavailableError';
  }
}

/**
 * A secrets file's values were lost when the store was damaged, so nothing
 * can redact them.
 */
export class SecretFileValuesLostError extends SecretFileValuesUnavailableError {
  constructor() {
    super();
    this.name = 'SecretFileValuesLostError';
  }
}

/** A secrets file would hold more values than its record keeps. */
export class SecretFileFullError extends Error {
  constructor() {
    super('This secrets file has been given too many different values.');
    this.name = 'SecretFileFullError';
  }
}

interface PersistedFile {
  version: 1;
  chats: Array<{
    scope: ChatSecretScope;
    secrets: Record<
      string,
      {
        ciphertext: string;
        createdAt: number;
        expiresAt: number;
        lastUsedAt?: number;
      }
    >;
    /** Revoked and replaced values, kept for redaction only. */
    retired?: Array<{
      name: string;
      ciphertext: string;
      createdAt: number;
      expiresAt: number;
    }>;
  }>;
  /** Secrets files and the values written to them, encrypted. */
  files?: Array<{
    path: string;
    scope: ChatSecretScope;
    /**
     * `ciphertext` is absent for a value secure storage couldn't keep;
     * `expiresAt` is set on one a replace displaced.
     */
    values: Array<{ name: string; ciphertext?: string; expiresAt?: number }>;
    goneAt?: number;
    lost?: boolean;
  }>;
}

export type AgentSecretAuditEvent =
  | 'requested'
  | 'provided'
  | 'declined'
  | 'expired'
  | 'revoked'
  | 'used';

/** What the Secrets chip shows about one held secret: never its value. */
export interface ChatSecretSummary {
  readonly name: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastUsedAt?: number;
  /** `session` when the value stays in memory for this app session only. */
  readonly storage: 'encrypted' | 'session';
  /**
   * Identifies this value for the app session: a value given again under
   * the same name gets a new one. In memory only; never shown.
   */
  readonly serial: number;
}

/**
 * `values` when the chat's held values changed (given, replaced, revoked or
 * expired); `usage` when only a last-use time moved.
 */
export type ChatSecretChange = 'values' | 'usage';

export type ChatSecretListener = (
  scope: ChatSecretScope,
  change: ChatSecretChange,
) => void;

export interface AgentSecretAuditEntry {
  event: AgentSecretAuditEvent;
  scope: ChatSecretScope;
  names: readonly string[];
  /** For `provided`: where each value came from. */
  sources?: Readonly<Record<string, 'entered' | 'chat'>>;
  /** For `revoked` and `expired`: why. */
  reason?: string;
  tool?: 'RequestSecrets' | 'RunWithSecrets' | 'WriteSecretsFile';
  /** For a RunWithSecrets `used`: SHA-256 of the command, never the command. */
  commandDigest?: string;
  /** For a WriteSecretsFile `used`: the file, relative to the worktree. */
  path?: string;
}

function readUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

function chatKey(scope: ChatSecretScope): string {
  return [scope.projectId, scope.worktreeId, scope.chatId].join('\0');
}

/** The stable record id a chat's bindings name; reveals nothing about values. */
export function chatSecretRecord(scope: ChatSecretScope): string {
  return createHash('sha256')
    .update(`canopy.agent-chat-secrets.v1\0${chatKey(scope)}`)
    .digest('base64url');
}

/**
 * Adds a value to redaction groups, each of which takes a name at most once
 * (a redactor maps one value to each name). A value already present is
 * skipped.
 */
function addToGroups(
  groups: Array<Record<string, string>>,
  name: string,
  value: string,
): void {
  if (groups.some((group) => group[name] === value)) return;
  const group = groups.find((candidate) => !(name in candidate));
  if (group) group[name] = value;
  else groups.push({ [name]: value });
}

/**
 * Whether `path` is surely gone. Only "no such file" counts: an access error
 * says nothing about the file, whose record must then stay.
 */
async function fileIsGone(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    );
  }
}

/**
 * The staging file `writePrivateFileAtomically` writes next to `target`
 * before renaming it into place: `.<name>.<uuid>.tmp`. It holds the same
 * values until the rename, so it is treated as the secrets file itself.
 */
const STAGING_NAME =
  /^\.(.+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/** How old a staging file must be before the sweep deletes it. */
const STALE_STAGING_MS = 10 * 60 * 1000;

/** Whether `path` is inside `folder` (both absolute and canonical). */
function isInsideFolder(folder: string, path: string): boolean {
  const rest = relative(folder, path);
  return (
    rest !== '' &&
    rest !== '..' &&
    !rest.startsWith(`..${sep}`) &&
    !isAbsolute(rest)
  );
}

function validScope(value: unknown): value is ChatSecretScope {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0 &&
    typeof value.worktreeId === 'string' &&
    value.worktreeId.length > 0 &&
    typeof value.chatId === 'string' &&
    value.chatId.length > 0
  );
}

export class ChatSecretStore {
  private readonly chats = new Map<string, ChatRecord>();
  private loaded: Promise<void> | null = null;
  /**
   * Revocations whose store couldn't be read yet. The read that succeeds
   * applies them before anything else sees its values.
   */
  private readonly pendingRevocations = new Set<() => unknown>();
  /** The entry each put replaced, so an undo can step past refused ones. */
  private readonly replaced = new WeakMap<StoredEntry, StoredEntry>();
  /** Entries whose put was undone: never put back. */
  private readonly refused = new WeakSet<StoredEntry>();
  /** Set once the file has been read; synchronous readers wait for it. */
  private loadSettled = false;
  /** The file was damaged and no secret has been provided since. */
  private damaged = false;
  /** Secrets files by absolute path. */
  private readonly secretFiles = new Map<string, SecretFileRecord>();
  /** Secrets files registered whose write hasn't finished: kept by the sweep. */
  private readonly writingSecretFiles = new Map<string, number>();
  /** Decrypted values by entry, for synchronous redaction. */
  private readonly decrypted = new WeakMap<StoredEntry, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<ChatSecretListener>();
  /** Per chat, bumped whenever its held values change. In memory only. */
  private readonly revisions = new Map<string, number>();
  /** Expired entries already announced to listeners. */
  private readonly expiryNoticed = new WeakSet<StoredEntry>();
  /** `ChatSecretSummary.serial` per entry, given on first describe. */
  private readonly serials = new WeakMap<StoredEntry, number>();
  private nextSerial = 1;
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      filePath?: () => string;
      auditFilePath?: () => string;
      now?: () => number;
      /** Test seam; defaults to reading the file as UTF-8. */
      readFile?: (path: string) => Promise<string>;
      /** Test seam; defaults to Electron safe storage. */
      encryption?: {
        available(): boolean;
        encrypt(text: string): Buffer;
        decrypt(ciphertext: Buffer): string;
      };
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private encryption(): {
    available(): boolean;
    encrypt(text: string): Buffer;
    decrypt(ciphertext: Buffer): string;
  } {
    if (this.options.encryption) return this.options.encryption;
    const policy = getSecretStoragePolicy();
    return {
      available: (): boolean => {
        try {
          return policy.isWriteAvailable();
        } catch {
          return false;
        }
      },
      encrypt: (text) => policy.encrypt(text),
      decrypt: (ciphertext) => policy.decrypt(ciphertext),
    };
  }

  private filePath(): string {
    return (this.options.filePath ?? getAgentChatSecretsFilePath)();
  }

  /** Whether the file has been read, so the synchronous readers are current. */
  isLoaded(): boolean {
    return this.loadSettled;
  }

  /** `session` when values can only stay in memory for this app session. */
  storageMode(): 'encrypted' | 'session' {
    return this.encryption().available() ? 'encrypted' : 'session';
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Reads the file once. A read that fails for any reason but a missing file,
   * a file this version doesn't understand, or one with a record it can't
   * read, rejects and isn't cached, so every operation fails (and the next
   * one reads again) rather than start from a store missing values, whose
   * views would show them and whose next write would delete them. Only a
   * file that isn't JSON at all counts as damaged: nothing in it can be
   * decrypted, and the registrations file must then name its secrets files.
   */
  private load(): Promise<void> {
    this.loaded ??= this.read().then(
      () => {
        this.loadSettled = true;
      },
      (error: unknown) => {
        // Nothing of a failed read stays: the next read starts over.
        this.loaded = null;
        this.chats.clear();
        this.secretFiles.clear();
        this.damaged = false;
        throw error;
      },
    );
    return this.loaded;
  }

  private async read(): Promise<void> {
    let raw: string;
    try {
      raw = await (this.options.readFile ?? readUtf8)(this.filePath());
    } catch (error) {
      if (isMissingFileError(error)) {
        // The paths file is written first and removed last, so one left
        // without the store means the store was lost: its files are marked
        // lost, like a damaged store's.
        await this.readLostRegistrations();
        if (this.secretFiles.size) {
          logMainProcessWarn('[agent-secrets] Chat secrets file is missing');
          this.damaged = true;
        }
        return;
      }
      logMainProcessWarn('[agent-secrets] Could not read chat secrets');
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      // Nothing in it can be decrypted, but files it registered still hold
      // values: they come back from the registrations file, marked lost, and
      // secret tools refuse until the person provides secrets again.
      logMainProcessWarn('[agent-secrets] Chat secrets file is damaged');
      this.damaged = true;
      await this.readLostRegistrations();
      return;
    }
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !Array.isArray(value.chats)
    ) {
      logMainProcessWarn(
        '[agent-secrets] Chat secrets file has an unknown format',
      );
      throw new Error('Unknown chat secrets file format');
    }
    // A record this version can't read could hold a value: the read fails
    // rather than drop it.
    const unreadable = (): Error => {
      logMainProcessWarn('[agent-secrets] Chat secrets file has a bad record');
      return new Error('Unreadable chat secrets record');
    };
    for (const chat of value.chats) {
      if (!isRecord(chat) || !validScope(chat.scope) || !isRecord(chat.secrets))
        throw unreadable();
      const secrets = new Map<string, StoredEntry>();
      for (const [name, entry] of Object.entries(chat.secrets)) {
        if (
          !AGENT_SECRET_NAME_PATTERN.test(name) ||
          !isRecord(entry) ||
          typeof entry.ciphertext !== 'string' ||
          typeof entry.createdAt !== 'number' ||
          typeof entry.expiresAt !== 'number'
        )
          throw unreadable();
        secrets.set(name, {
          ciphertext: entry.ciphertext,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          ...(typeof entry.lastUsedAt === 'number'
            ? { lastUsedAt: entry.lastUsedAt }
            : {}),
        });
      }
      const retired: ChatRecord['retired'] = [];
      if (chat.retired !== undefined && !Array.isArray(chat.retired))
        throw unreadable();
      const retiredItems: unknown[] = Array.isArray(chat.retired)
        ? chat.retired
        : [];
      for (const item of retiredItems) {
        if (
          !isRecord(item) ||
          typeof item.name !== 'string' ||
          !AGENT_SECRET_NAME_PATTERN.test(item.name) ||
          typeof item.ciphertext !== 'string' ||
          typeof item.createdAt !== 'number' ||
          typeof item.expiresAt !== 'number'
        )
          throw unreadable();
        retired.push({
          name: item.name,
          entry: {
            ciphertext: item.ciphertext,
            createdAt: item.createdAt,
            expiresAt: item.expiresAt,
          },
        });
      }
      const scope: ChatSecretScope = {
        projectId: chat.scope.projectId,
        worktreeId: chat.scope.worktreeId,
        chatId: chat.scope.chatId,
      };
      if (secrets.size || retired.length)
        this.chats.set(chatKey(scope), { scope, secrets, retired });
    }
    if (value.files !== undefined && !Array.isArray(value.files))
      throw unreadable();
    const files: unknown[] = Array.isArray(value.files) ? value.files : [];
    for (const record of files) {
      if (
        !isRecord(record) ||
        typeof record.path !== 'string' ||
        !isAbsolute(record.path) ||
        !validScope(record.scope) ||
        !Array.isArray(record.values)
      )
        throw unreadable();
      const entries: unknown[] = record.values;
      const values: SecretFileRecord['values'] = [];
      for (const item of entries) {
        if (
          !isRecord(item) ||
          typeof item.name !== 'string' ||
          !AGENT_SECRET_NAME_PATTERN.test(item.name) ||
          (item.ciphertext !== undefined && typeof item.ciphertext !== 'string')
        )
          throw unreadable();
        // A file value never expires on its own: the file holds it. One
        // without ciphertext was kept in memory only; the marker stays, so
        // the file is still treated as holding secrets it can't redact.
        values.push({
          name: item.name,
          entry: {
            ...(typeof item.ciphertext === 'string'
              ? { ciphertext: item.ciphertext }
              : {}),
            createdAt: 0,
            expiresAt:
              typeof item.expiresAt === 'number' &&
              Number.isFinite(item.expiresAt)
                ? item.expiresAt
                : Number.POSITIVE_INFINITY,
          },
        });
      }
      const lost = record.lost === true;
      if (values.length || lost)
        this.secretFiles.set(record.path, {
          scope: {
            projectId: record.scope.projectId,
            worktreeId: record.scope.worktreeId,
            chatId: record.scope.chatId,
          },
          values,
          ...(typeof record.goneAt === 'number' &&
          Number.isFinite(record.goneAt)
            ? { goneAt: record.goneAt }
            : {}),
          ...(lost ? { lost } : {}),
        });
    }
    for (const revoke of this.pendingRevocations) revoke();
    this.pendingRevocations.clear();
    this.scheduleExpiryNotice();
  }

  /** Where secrets files are registered by path alone, apart from values. */
  private registrationsPath(): string {
    return join(dirname(this.filePath()), 'secret-file-paths.json');
  }

  /**
   * After the store was found damaged: the registered secrets files, read
   * from the registrations file and marked as having lost their values. Only
   * a missing registrations file means none were registered; one that can't
   * be read or parsed, or holds a record it can't read, rejects, so the load
   * fails and views of those files stay unavailable.
   */
  private async readLostRegistrations(): Promise<void> {
    let raw: string;
    try {
      raw = await (this.options.readFile ?? readUtf8)(this.registrationsPath());
    } catch (error) {
      if (isMissingFileError(error)) return;
      logMainProcessWarn('[agent-secrets] Could not read secrets file paths');
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.files)
    )
      throw new Error('Unknown secrets file paths format');
    const files: unknown[] = parsed.files;
    for (const item of files) {
      if (
        !isRecord(item) ||
        typeof item.path !== 'string' ||
        !isAbsolute(item.path) ||
        !validScope(item.scope)
      )
        throw new Error('Unreadable secrets file paths record');
      this.secretFiles.set(item.path, {
        scope: {
          projectId: item.scope.projectId,
          worktreeId: item.scope.worktreeId,
          chatId: item.scope.chatId,
        },
        values: [],
        lost: true,
      });
    }
  }

  /**
   * True when the store was found damaged and the person hasn't provided
   * secrets since: values it held are gone, so secret tools refuse.
   */
  isDamaged(): boolean {
    return this.damaged;
  }

  /** True for a secrets file whose values the store lost when damaged. */
  secretFileValuesLost(absolutePath: string): boolean {
    const recorded = this.recordedPathFor(absolutePath);
    return (
      recorded !== undefined && this.secretFiles.get(recorded)?.lost === true
    );
  }

  private async persist(): Promise<void> {
    const file: PersistedFile = { version: 1, chats: [] };
    for (const chat of this.chats.values()) {
      const secrets: PersistedFile['chats'][number]['secrets'] = {};
      for (const [name, entry] of chat.secrets) {
        if (entry.ciphertext === undefined) continue;
        secrets[name] = {
          ciphertext: entry.ciphertext,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          ...(entry.lastUsedAt !== undefined
            ? { lastUsedAt: entry.lastUsedAt }
            : {}),
        };
      }
      const retired: NonNullable<PersistedFile['chats'][number]['retired']> =
        [];
      for (const { name, entry } of chat.retired)
        if (entry.ciphertext !== undefined)
          retired.push({
            name,
            ciphertext: entry.ciphertext,
            createdAt: entry.createdAt,
            expiresAt: entry.expiresAt,
          });
      if (Object.keys(secrets).length || retired.length)
        file.chats.push({
          scope: chat.scope,
          secrets,
          ...(retired.length ? { retired } : {}),
        });
    }
    const files: NonNullable<PersistedFile['files']> = [];
    for (const [path, record] of this.secretFiles) {
      // A value secure storage couldn't keep is written as its name only.
      const values = record.values.map(({ name, entry }) => ({
        name,
        ...(entry.ciphertext !== undefined
          ? { ciphertext: entry.ciphertext }
          : {}),
        ...(Number.isFinite(entry.expiresAt)
          ? { expiresAt: entry.expiresAt }
          : {}),
      }));
      if (values.length || record.lost)
        files.push({
          path,
          scope: record.scope,
          values,
          ...(record.goneAt !== undefined ? { goneAt: record.goneAt } : {}),
          ...(record.lost ? { lost: true } : {}),
        });
    }
    if (files.length) file.files = files;
    const path = this.filePath();
    const registrations = this.registrationsPath();
    if (!file.chats.length && !files.length) {
      await rm(path, { force: true });
      await rm(registrations, { force: true });
      return;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Paths alone, apart from the values, so a damaged store still knows
    // which files hold secrets. Written first: a file is never registered
    // only where damage could lose it.
    await writeFileAtomically(
      registrations,
      `${JSON.stringify({
        version: 1,
        files: files.map(({ path: filePath, scope }) => ({
          path: filePath,
          scope,
        })),
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await writeFileAtomically(path, `${JSON.stringify(file)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  /**
   * The chat's unexpired entries. A read view only: expired entries stay in
   * the map until `sweepExpired` or `remove` deletes them, which also
   * rewrites the file, so their ciphertext never outlives its bookkeeping.
   */
  private live(scope: ChatSecretScope): Map<string, StoredEntry> | undefined {
    const chat = this.chats.get(chatKey(scope));
    if (!chat) return undefined;
    const now = this.now();
    return new Map(
      [...chat.secrets].filter(([, entry]) => entry.expiresAt > now),
    );
  }

  /** Forgets a chat that holds nothing, live or retired. */
  private dropIfEmpty(key: string, chat: ChatRecord): void {
    if (!chat.secrets.size && !chat.retired.length) this.chats.delete(key);
  }

  /**
   * Keeps `entry`, a value the chat no longer holds under `name`, for
   * redaction only, unless it has already expired.
   */
  private retire(chat: ChatRecord, name: string, entry: StoredEntry): void {
    if (entry.expiresAt <= this.now()) return;
    if (!chat.retired.some((item) => item.entry === entry))
      chat.retired.push({ name, entry });
  }

  /** The names among `names` this chat holds now. */
  heldNames(
    scope: ChatSecretScope,
    names: readonly string[],
  ): Promise<string[]> {
    return this.enqueue(async () => {
      await this.load();
      const secrets = this.live(scope);
      return names.filter((name) => secrets?.has(name) === true);
    });
  }

  /**
   * The names among `names` the chat holds in memory only (given while
   * secure storage was unavailable, or as session-only): their values must
   * not outlive this app session, so they never go into a file.
   */
  sessionOnlyNames(
    scope: ChatSecretScope,
    names: readonly string[],
  ): Promise<string[]> {
    return this.enqueue(async () => {
      await this.load();
      const secrets = this.live(scope);
      return names.filter(
        (name) => secrets?.get(name)?.memoryValue !== undefined,
      );
    });
  }

  /**
   * Whether the chat holds each of `values` (secret name and value) now as
   * an encrypted entry, not one kept for this session only: checked against
   * the exact values a write redeemed, after any submission that raced it.
   */
  holdsEncrypted(
    scope: ChatSecretScope,
    values: ReadonlyArray<{ name: string; value: string }>,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      await this.load();
      const secrets = this.live(scope);
      return values.every(({ name, value }) => {
        const entry = secrets?.get(name);
        return (
          entry !== undefined &&
          entry.ciphertext !== undefined &&
          this.plaintext(entry) === value
        );
      });
    });
  }

  /** Every name this chat holds now. */
  listNames(scope: ChatSecretScope): Promise<string[]> {
    return this.enqueue(async () => {
      await this.load();
      return [...(this.live(scope)?.keys() ?? [])].sort();
    });
  }

  /**
   * Metadata for every secret this chat holds now, sorted by name: what the
   * Secrets chip lists. Never a value.
   */
  describe(scope: ChatSecretScope): Promise<ChatSecretSummary[]> {
    return this.enqueue(async () => {
      await this.load();
      return [...(this.live(scope) ?? [])]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, entry]) => ({
          name,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          ...(entry.lastUsedAt !== undefined
            ? { lastUsedAt: entry.lastUsedAt }
            : {}),
          storage: entry.ciphertext === undefined ? 'session' : 'encrypted',
          serial: this.serialOf(entry),
        }));
    });
  }

  private serialOf(entry: StoredEntry): number {
    let serial = this.serials.get(entry);
    if (serial === undefined) {
      serial = this.nextSerial;
      this.nextSerial += 1;
      this.serials.set(entry, serial);
    }
    return serial;
  }

  /**
   * Records that values were handed to a command now (a grant read), for
   * the chip's last use, then writes it best effort: a write that fails
   * keeps the time in memory until the next write.
   */
  private recordUse(chat: ChatRecord, entries: readonly StoredEntry[]): void {
    if (!entries.length) return;
    const now = this.now();
    for (const entry of entries) entry.lastUsedAt = now;
    this.notify(chat.scope, 'usage');
    void this.enqueue(() =>
      this.persist().catch(() => {
        logMainProcessWarn('[agent-secrets] Could not record a last use');
      }),
    );
  }

  /**
   * Tells listeners about values whose seven days ran out since the last
   * notice, so a command environment holding one drops it at once rather
   * than at the hourly sweep. Reads already skip expired values.
   */
  noticeExpired(): void {
    const now = this.now();
    for (const chat of this.chats.values()) {
      let expired = false;
      for (const entry of chat.secrets.values()) {
        if (entry.expiresAt > now || this.expiryNoticed.has(entry)) continue;
        this.expiryNoticed.add(entry);
        expired = true;
      }
      if (expired) this.notify(chat.scope, 'values');
    }
    this.scheduleExpiryNotice();
  }

  /** Arms one timer for the next value to expire. */
  private scheduleExpiryNotice(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const now = this.now();
    let next = Infinity;
    for (const chat of this.chats.values())
      for (const entry of chat.secrets.values())
        if (!this.expiryNoticed.has(entry) && entry.expiresAt < next)
          next = entry.expiresAt;
    if (next === Infinity) return;
    // setTimeout holds at most 2^31 - 1 ms; a later expiry re-arms.
    const delay = Math.min(Math.max(next - now, 0) + 50, 2 ** 31 - 1);
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.noticeExpired();
    }, delay);
    this.expiryTimer.unref?.();
  }

  /**
   * The chat's values revision: it changes whenever the values it holds
   * change, so a host that applied them can tell they are stale. In memory.
   */
  valuesRevision(scope: ChatSecretScope): number {
    return this.revisions.get(chatKey(scope)) ?? 0;
  }

  /** Calls `listener` after each change to a chat's secrets. */
  subscribe(listener: ChatSecretListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(scope: ChatSecretScope, change: ChatSecretChange): void {
    if (change === 'values') {
      const key = chatKey(scope);
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
      this.scheduleExpiryNotice();
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(scope, change);
      } catch {
        logMainProcessWarn('[agent-secrets] A chat secret listener failed');
      }
    }
  }

  /**
   * Stores values for a chat, replacing values it held under those names.
   * Encrypts and writes before resolving; without secure storage, keeps them
   * in memory only. `sessionOnly` keeps them in memory even when secure
   * storage is available, for a form that told the person so. Refuses names
   * and values outside the contract.
   */
  put(
    scope: ChatSecretScope,
    values: Readonly<Record<string, string>>,
    options: { sessionOnly?: boolean } = {},
  ): Promise<() => Promise<void>> {
    return this.enqueue(async () => {
      await this.load();
      const entries = Object.entries(values);
      for (const [name, value] of entries) {
        if (!AGENT_SECRET_NAME_PATTERN.test(name))
          throw new Error('Invalid secret name');
        if (
          value.trim().length === 0 ||
          value.length > AGENT_SECRET_VALUE_MAX_LENGTH
        )
          throw new Error('Invalid secret value');
      }
      const noop = (): Promise<void> => Promise.resolve();
      if (!entries.length) return noop;
      const encryption = this.encryption();
      const encrypted = options.sessionOnly !== true && encryption.available();
      const now = this.now();
      const prepared = entries.map(([name, value]): [string, StoredEntry] => [
        name,
        encrypted
          ? {
              ciphertext: encryption.encrypt(value).toString('base64'),
              createdAt: now,
              expiresAt: now + CHAT_SECRET_TTL_MS,
            }
          : {
              memoryValue: value,
              createdAt: now,
              expiresAt: now + CHAT_SECRET_TTL_MS,
            },
      ]);
      const key = chatKey(scope);
      const chat = this.chats.get(key) ?? {
        scope: {
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          chatId: scope.chatId,
        },
        secrets: new Map<string, StoredEntry>(),
        retired: [],
      };
      const previous = new Map(chat.secrets);
      const previousRetired = [...chat.retired];
      for (const [name, entry] of prepared) {
        const earlier = previous.get(name);
        if (earlier) {
          this.replaced.set(entry, earlier);
          // The replaced value is never readable again, but an echo of it
          // stays masked.
          this.retire(chat, name, earlier);
        }
        chat.secrets.set(name, entry);
      }
      if (chat.retired.length > CHAT_SECRET_MAX_RETIRED) {
        chat.retired.splice(0, chat.retired.length, ...previousRetired);
        chat.secrets.clear();
        for (const [name, entry] of previous) chat.secrets.set(name, entry);
        throw new Error('This chat has replaced its secrets too many times');
      }
      this.chats.set(key, chat);
      const restore = (): void => {
        chat.secrets.clear();
        for (const [name, entry] of previous) chat.secrets.set(name, entry);
        chat.retired.splice(0, chat.retired.length, ...previousRetired);
        this.chats.set(key, chat);
        this.dropIfEmpty(key, chat);
      };
      // Undoes exactly this put: a name it replaced gets its earlier value
      // and expiry back, and a name it added goes. A name something else
      // has replaced or removed since, or a chat revoked since, is left as
      // it is, so an undo never brings back a revoked secret. An earlier
      // value whose own put was undone (overlapping requests settling out
      // of order) is stepped past, so an undo never brings back a refused
      // one either.
      const undo = (): Promise<void> =>
        this.mutate(() => {
          for (const [, entry] of prepared) this.refused.add(entry);
          const current = this.chats.get(key);
          if (!current) return;
          for (const [name, entry] of prepared) {
            if (current.secrets.get(name) !== entry) continue;
            let earlier = this.replaced.get(entry);
            while (earlier && this.refused.has(earlier))
              earlier = this.replaced.get(earlier);
            if (earlier) {
              // Live again, so no longer retired.
              current.secrets.set(name, earlier);
              current.retired = current.retired.filter(
                (item) => item.entry !== earlier,
              );
            } else current.secrets.delete(name);
          }
          this.dropIfEmpty(key, current);
          this.notify(current.scope, 'values');
        });
      if (!encrypted && !prepared.some(([name]) => previous.has(name))) {
        // The person provided secrets again since a damaged store lost them.
        this.damaged = false;
        this.notify(chat.scope, 'values');
        return undo;
      }
      try {
        await this.persist();
      } catch (error) {
        // Roll back so memory never holds what disk refused.
        restore();
        throw error;
      }
      this.damaged = false;
      this.notify(chat.scope, 'values');
      return undo;
    });
  }

  /**
   * Runs an in-memory change, then rewrites the file. Every change here takes
   * values away (a deletion, an expiry or an undo), so it stands in memory
   * even when the write fails: nothing reads those values again. Every write
   * rewrites the whole file from memory, so the next one (the hourly sweep at
   * the latest) carries a change an earlier write refused.
   */
  private mutate<T>(change: () => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.load();
      const result = await change();
      await this.persist();
      return result;
    });
  }

  /**
   * A deletion that outlives a failed read: when the store can't be read,
   * the deletion waits and the next read that succeeds applies it, so a
   * revoked value is never readable again.
   */
  private revoke<T>(deletion: () => T): Promise<T> {
    return this.enqueue(async () => {
      try {
        await this.load();
      } catch (error) {
        this.pendingRevocations.add(deletion);
        throw error;
      }
      const result = deletion();
      await this.persist();
      return result;
    });
  }

  /**
   * Revokes `names` (every name when omitted) in a chat: no command can read
   * them again, and their values are kept for redaction only. Resolves the
   * names revoked.
   */
  remove(scope: ChatSecretScope, names?: readonly string[]): Promise<string[]> {
    return this.revoke(() => {
      const key = chatKey(scope);
      const chat = this.chats.get(key);
      if (!chat) return [];
      const removed: string[] = [];
      for (const name of names ?? [...chat.secrets.keys()]) {
        const entry = chat.secrets.get(name);
        if (!entry) continue;
        chat.secrets.delete(name);
        this.retire(chat, name, entry);
        removed.push(name);
      }
      this.dropIfEmpty(key, chat);
      if (removed.length) this.notify(chat.scope, 'values');
      return removed.sort();
    });
  }

  /**
   * Deletes everything a chat that ended (closed, archived or deleted)
   * held, its retired values too. Resolves the names it still held.
   */
  endChat(scope: ChatSecretScope): Promise<string[]> {
    return this.revoke(() => {
      const key = chatKey(scope);
      const chat = this.chats.get(key);
      if (!chat) return [];
      this.chats.delete(key);
      // Listeners follow, so a Full-access chat's commands lose the values
      // too (its ambient file is emptied) even when its session lives on.
      this.notify(chat.scope, 'values');
      return [...chat.secrets.keys()].sort();
    });
  }

  /** Deletes every secret of every chat in a worktree or work entry. */
  removeScope(scope: {
    projectId: string;
    worktreeId: string;
  }): Promise<Array<{ scope: ChatSecretScope; names: string[] }>> {
    return this.revoke(() => {
      const removed: Array<{ scope: ChatSecretScope; names: string[] }> = [];
      for (const [key, chat] of this.chats) {
        if (
          chat.scope.projectId !== scope.projectId ||
          chat.scope.worktreeId !== scope.worktreeId
        )
          continue;
        removed.push({
          scope: chat.scope,
          names: [...chat.secrets.keys()].sort(),
        });
        this.chats.delete(key);
      }
      // Secrets files are left to the sweep: removing a work entry can leave
      // its folder (a Cowork project's own folder, say), and a file in it, or
      // a copy of one, still holds the values.
      for (const { scope: removedScope } of removed)
        this.notify(removedScope, 'values');
      return removed;
    });
  }

  /**
   * Deletes every expired value and rewrites the file, which also retries a
   * deletion an earlier write refused. Resolves what it removed, per chat.
   */
  sweepExpired(): Promise<Array<{ scope: ChatSecretScope; names: string[] }>> {
    return this.mutate(async () => {
      const now = this.now();
      const swept: Array<{ scope: ChatSecretScope; names: string[] }> = [];
      const changed: ChatSecretScope[] = [];
      for (const [key, chat] of this.chats) {
        const names: string[] = [];
        let unannounced = false;
        for (const [name, entry] of chat.secrets) {
          if (entry.expiresAt > now) continue;
          // One already announced at expiry changed nothing the chat can
          // use now; announcing it again would make a Codex process that
          // started since look stale.
          if (!this.expiryNoticed.has(entry)) unannounced = true;
          chat.secrets.delete(name);
          names.push(name);
        }
        // A retired value goes when its own seven days run out.
        chat.retired = chat.retired.filter(
          ({ entry }) => entry.expiresAt > now,
        );
        this.dropIfEmpty(key, chat);
        if (names.length)
          swept.push({ scope: chat.scope, names: names.sort() });
        if (unannounced) changed.push(chat.scope);
      }
      // A secrets file someone deleted or renamed keeps its values for
      // redaction for seven more days, since a rename or copy can still hold
      // them, then they go. One being written may not exist yet. A staging
      // file a crash left behind holds the values too: it goes once it is
      // old enough.
      for (const [path, found] of [...this.secretFiles]) {
        if (this.writingSecretFiles.has(path)) continue;
        // Values a replace retired go when their seven days run out.
        const values = found.values.filter(
          ({ entry }) => entry.expiresAt > now,
        );
        if (!values.length && !found.lost) {
          this.secretFiles.delete(path);
          continue;
        }
        const record =
          values.length === found.values.length ? found : { ...found, values };
        if (record !== found) this.secretFiles.set(path, record);
        const stagingLeft = await this.removeStaleStagingFiles(path);
        if (stagingLeft || !(await fileIsGone(path))) {
          if (record.goneAt !== undefined)
            this.secretFiles.set(path, {
              scope: record.scope,
              values: record.values,
              ...(record.lost ? { lost: true } : {}),
            });
          continue;
        }
        // A file whose values were lost has none to keep for redaction.
        if (record.lost) {
          this.secretFiles.delete(path);
          continue;
        }
        if (record.goneAt === undefined)
          this.secretFiles.set(path, { ...record, goneAt: now });
        else if (record.goneAt + CHAT_SECRET_TTL_MS <= now)
          this.secretFiles.delete(path);
      }
      for (const scope of changed) this.notify(scope, 'values');
      return swept;
    });
  }

  /**
   * Loads the file now, so the synchronous readers below see what it holds.
   * Startup calls it once; every other method loads on its own.
   */
  ensureLoaded(): Promise<void> {
    return this.enqueue(() => this.load());
  }

  /**
   * The values RunWithSecrets redacts from a chat's command, grouped so each
   * group holds a name at most once: the chat's live values first, then
   * every other value recorded for its worktree: revoked and replaced
   * values (CONTRACTS.md §4a), the other chats' values
   * and the values written to secrets files, which stay on disk after the
   * chats' secrets change or go. `root`, the folder commands run in, adds the
   * secrets files under it that other entries (Cowork tasks of one folder)
   * wrote. Empty until the file has loaded (`ensureLoaded`). For the
   * redactor only: never return the result over IPC, or put it in a reply,
   * log or record. `strict` throws {@link ChatSecretValuesUnreadableError}
   * (or {@link SecretFileValuesUnavailableError} for a secrets file's value)
   * when any of those values can't be read back, and
   * {@link SecretFileValuesLostError} for one of those secrets files whose
   * values a damaged store lost; otherwise it is skipped.
   */
  redactionGroups(
    scope: ChatSecretScope,
    options: { strict?: boolean; root?: string } = {},
  ): Array<Record<string, string>> {
    if (!this.loadSettled) return [];
    const strict = options.strict === true;
    const groups: Array<Record<string, string>> = [];
    const live: Record<string, string> = {};
    for (const [name, entry] of this.live(scope) ?? []) {
      const value = this.plaintext(entry);
      if (value === undefined) {
        if (strict) throw new ChatSecretValuesUnreadableError();
        continue;
      }
      live[name] = value;
    }
    if (Object.keys(live).length) groups.push(live);
    this.addRecordedValues(groups, scope, strict, options.root, strict);
    return groups;
  }

  /**
   * Every value recorded, for redacting what Canopy shows (file views,
   * diffs), whatever path holds the value: each chat's live, revoked and
   * replaced values, and the values written to secrets files, including one
   * renamed or deleted in the last seven days. Every worktree's, since work
   * entries can share one folder under different ids. Grouped as
   * {@link redactionGroups}. Throws {@link ChatSecretValuesUnreadableError}
   * or {@link SecretFileValuesUnavailableError} when one can't be read back,
   * so a view is refused rather than shown unredacted; `strict: false`
   * skips such a value instead. Empty until the file has loaded
   * (`ensureLoaded`). For the redactor only.
   */
  viewRedactionGroups(
    options: { strict?: boolean } = {},
  ): Array<Record<string, string>> {
    if (!this.loadSettled) return [];
    const groups: Array<Record<string, string>> = [];
    this.addRecordedValues(groups, undefined, options.strict !== false);
    return groups;
  }

  /**
   * Adds the values recorded for `scope`'s worktree (every worktree without
   * one), as {@link viewRedactionGroups} describes. `strict` throws when a
   * value can't be read back; otherwise it is skipped. `lostFails` throws
   * for a secrets file whose values were lost; views withhold such a file
   * by its path instead.
   */
  private addRecordedValues(
    groups: Array<Record<string, string>>,
    scope: { projectId: string; worktreeId: string } | undefined,
    strict: boolean,
    root?: string,
    lostFails = false,
  ): void {
    const inScope = (other: {
      projectId: string;
      worktreeId: string;
    }): boolean =>
      scope === undefined ||
      (other.projectId === scope.projectId &&
        other.worktreeId === scope.worktreeId);
    const add = (name: string, entry: StoredEntry, unreadable: Error): void => {
      const value = this.plaintext(entry);
      if (value === undefined) {
        if (strict) throw unreadable;
        return;
      }
      addToGroups(groups, name, value);
    };
    const now = this.now();
    for (const chat of this.chats.values()) {
      if (!inScope(chat.scope)) continue;
      for (const [name, entry] of chat.secrets)
        add(name, entry, new ChatSecretValuesUnreadableError());
      for (const { name, entry } of chat.retired)
        if (entry.expiresAt > now)
          add(name, entry, new ChatSecretValuesUnreadableError());
    }
    for (const [path, record] of this.secretFiles) {
      if (
        !inScope(record.scope) &&
        !(root !== undefined && isInsideFolder(root, path))
      )
        continue;
      if (lostFails && record.lost === true)
        throw new SecretFileValuesLostError();
      for (const { name, entry } of record.values)
        add(name, entry, new SecretFileValuesUnavailableError());
    }
  }

  private plaintext(entry: StoredEntry): string | undefined {
    if (entry.memoryValue !== undefined) return entry.memoryValue;
    if (entry.ciphertext === undefined) return undefined;
    const cached = this.decrypted.get(entry);
    if (cached !== undefined) return cached;
    try {
      const value = this.encryption().decrypt(
        Buffer.from(entry.ciphertext, 'base64'),
      );
      this.decrypted.set(entry, value);
      return value;
    } catch {
      return undefined;
    }
  }

  /**
   * Records that WriteSecretsFile is writing `values` (secret name and
   * value) to `absolutePath` for a chat. Kept, encrypted like the chat's own
   * values, until the file is gone, so Canopy's views of it stay redacted
   * after the chat's secrets change, expire or are revoked, and whichever
   * chats wrote it. Without secure storage the values stay in memory only.
   */
  registerSecretFile(
    scope: ChatSecretScope,
    absolutePath: string,
    values: ReadonlyArray<{ name: string; value: string }>,
    options: { replace?: boolean } = {},
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.load();
      // A replace can always be written: only its own values count against
      // the cap, though earlier ones stay until the write succeeds.
      if (options.replace === true && values.length > SECRET_FILE_MAX_VALUES)
        throw new SecretFileFullError();
      const encryption = this.encryption();
      const encrypted = encryption.available();
      const record = this.secretFiles.get(absolutePath);
      // Earlier values stay until a replace has actually written the file
      // (`keepOnlySecretFileValues`): a failed write leaves them on disk.
      const kept = record ? [...record.values] : [];
      for (const { name, value } of values) {
        const index = kept.findIndex(
          (item) => item.name === name && this.plaintext(item.entry) === value,
        );
        const existing = index === -1 ? undefined : kept[index];
        if (existing) {
          // A retired value written again is in the file again.
          if (Number.isFinite(existing.entry.expiresAt))
            kept[index] = {
              name,
              entry: {
                ...existing.entry,
                expiresAt: Number.POSITIVE_INFINITY,
              },
            };
          continue;
        }
        const entry: StoredEntry = encrypted
          ? {
              ciphertext: encryption.encrypt(value).toString('base64'),
              createdAt: this.now(),
              expiresAt: Number.POSITIVE_INFINITY,
            }
          : {
              memoryValue: value,
              createdAt: this.now(),
              expiresAt: Number.POSITIVE_INFINITY,
            };
        kept.push({ name, entry });
      }
      if (
        options.replace !== true &&
        kept.filter(({ entry }) => !Number.isFinite(entry.expiresAt)).length >
          SECRET_FILE_MAX_VALUES
      )
        throw new SecretFileFullError();
      const next: SecretFileRecord = {
        scope: {
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          chatId: scope.chatId,
        },
        values: kept,
        // The file still holds the values the store lost until a replace is
        // installed (`keepOnlySecretFileValues` clears the mark then).
        ...(record?.lost ? { lost: true } : {}),
      };
      this.secretFiles.set(absolutePath, next);
      try {
        await this.persist();
      } catch (error) {
        // Keep the record in memory: redacting more is the safe side.
        logMainProcessWarn("[agent-secrets] Couldn't record a secrets file");
        throw error;
      }
    });
  }

  /**
   * Marks `absolutePath` as being written, so the expiry sweep keeps its
   * record while the file doesn't exist yet. Call {@link finishSecretFileWrite}
   * when the write settles, whatever its outcome.
   */
  beginSecretFileWrite(absolutePath: string): void {
    this.writingSecretFiles.set(
      absolutePath,
      (this.writingSecretFiles.get(absolutePath) ?? 0) + 1,
    );
  }

  finishSecretFileWrite(absolutePath: string): void {
    const count = (this.writingSecretFiles.get(absolutePath) ?? 1) - 1;
    if (count > 0) this.writingSecretFiles.set(absolutePath, count);
    else this.writingSecretFiles.delete(absolutePath);
  }

  /**
   * After a replace wrote the file, retires the values it no longer holds:
   * they stay, for redaction only, for {@link CHAT_SECRET_TTL_MS} more, since
   * a copy of the old file can still hold them. `values` (secret name and
   * value) are the ones the file now holds.
   */
  keepOnlySecretFileValues(
    absolutePath: string,
    values: ReadonlyArray<{ name: string; value: string }>,
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.load();
      const record = this.secretFiles.get(absolutePath);
      if (!record) return;
      const retireAt = this.now() + CHAT_SECRET_TTL_MS;
      const next = record.values.map((item) =>
        values.some(
          ({ name, value }) =>
            item.name === name && this.plaintext(item.entry) === value,
        ) || Number.isFinite(item.entry.expiresAt)
          ? item
          : { name: item.name, entry: { ...item.entry, expiresAt: retireAt } },
      );
      // The file the replace installed no longer holds lost values.
      const installed: SecretFileRecord = { ...record, values: next };
      delete installed.lost;
      this.secretFiles.set(absolutePath, installed);
      await this.persist();
    });
  }

  /**
   * Deletes staging files a crashed write left next to `target`, once old
   * enough. Resolves whether one may remain (too young to delete, or the
   * folder couldn't be read for a reason but its absence).
   */
  private async removeStaleStagingFiles(target: string): Promise<boolean> {
    const folder = dirname(target);
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return !(await fileIsGone(folder));
    }
    const cutoff = this.now() - STALE_STAGING_MS;
    let left = false;
    for (const name of names) {
      if (STAGING_NAME.exec(name)?.[1] !== basename(target)) continue;
      const path = join(folder, name);
      try {
        if ((await lstat(path)).mtimeMs < cutoff)
          await rm(path, { force: true });
        else left = true;
      } catch {
        if (!(await fileIsGone(path))) left = true;
      }
    }
    return left;
  }

  /**
   * The recorded secrets file `absolutePath` is, or whose staging file it
   * is; undefined when neither.
   */
  private recordedPathFor(absolutePath: string): string | undefined {
    if (this.secretFiles.has(absolutePath)) return absolutePath;
    const name = STAGING_NAME.exec(basename(absolutePath))?.[1];
    if (name === undefined) return undefined;
    const target = join(dirname(absolutePath), name);
    return this.secretFiles.has(target) ? target : undefined;
  }

  /**
   * True when WriteSecretsFile wrote `absolutePath`, or is writing it, and
   * the sweep hasn't found it gone.
   */
  isSecretFile(absolutePath: string): boolean {
    const recorded = this.recordedPathFor(absolutePath);
    return (
      recorded !== undefined &&
      this.secretFiles.get(recorded)?.goneAt === undefined
    );
  }

  /**
   * Plaintext for the execution-secret reader only. Never call this from an
   * IPC handler or put the result in a reply, log or record.
   */
  readForExecution(
    record: string,
    refs: readonly string[],
  ): Promise<Map<string, string>> {
    return this.enqueue(async () => {
      await this.load();
      const values = new Map<string, string>();
      for (const chat of this.chats.values()) {
        if (chatSecretRecord(chat.scope) !== record) continue;
        const secrets = this.live(chat.scope);
        if (!secrets) break;
        const used: StoredEntry[] = [];
        for (const [name, entry] of secrets) {
          const ref = storedSecretRef(CHAT_SECRET_FAMILY, record, name);
          if (!refs.includes(ref)) continue;
          const value =
            entry.memoryValue ??
            (entry.ciphertext !== undefined
              ? this.encryption().decrypt(
                  Buffer.from(entry.ciphertext, 'base64'),
                )
              : undefined);
          if (value !== undefined) {
            values.set(ref, value);
            used.push(entry);
          }
        }
        this.recordUse(chat, used);
        break;
      }
      return values;
    });
  }

  /** Appends a metadata-only audit event. Never fails the caller. */
  async audit(entry: AgentSecretAuditEntry): Promise<void> {
    const path = (this.options.auditFilePath ?? getAgentSecretAuditFilePath)();
    const line = {
      at: new Date(this.now()).toISOString(),
      event: entry.event,
      projectId: entry.scope.projectId,
      worktreeId: entry.scope.worktreeId,
      chatId: entry.scope.chatId,
      names: [...entry.names].sort(),
      ...(entry.sources ? { sources: entry.sources } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.tool ? { tool: entry.tool } : {}),
      ...(entry.commandDigest ? { commandDigest: entry.commandDigest } : {}),
      ...(entry.path ? { path: entry.path } : {}),
    };
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, `${JSON.stringify(line)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      logMainProcessWarn('[agent-secrets] Could not record an audit event');
    }
  }
}

/**
 * Execution-secret bindings that give a command chat secrets as environment
 * variables: `env` maps each variable to a secret name. The bindings are
 * references; a grant staged with them is what reads the values (U2b).
 */
export function chatSecretBindings(
  scope: ChatSecretScope,
  env: Readonly<Record<string, string>>,
): ExecutionSecretBinding[] {
  const record = chatSecretRecord(scope);
  return Object.entries(env).map(([variable, name]) => ({
    name: variable,
    source: {
      kind: 'stored-secret',
      family: CHAT_SECRET_FAMILY,
      record,
      ref: storedSecretRef(CHAT_SECRET_FAMILY, record, name),
    },
  }));
}

let store: ChatSecretStore | null = null;

export function getChatSecretStore(): ChatSecretStore {
  return (store ??= new ChatSecretStore());
}

export function setChatSecretStoreForTests(next: ChatSecretStore | null): void {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('Only tests may replace the chat secret store.');
  store = next;
}
