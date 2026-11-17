import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
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
}

interface ChatRecord {
  scope: ChatSecretScope;
  secrets: Map<string, StoredEntry>;
}

interface PersistedFile {
  version: 1;
  chats: Array<{
    scope: ChatSecretScope;
    secrets: Record<
      string,
      { ciphertext: string; createdAt: number; expiresAt: number }
    >;
  }>;
}

export type AgentSecretAuditEvent =
  | 'requested'
  | 'provided'
  | 'declined'
  | 'expired'
  | 'revoked';

export interface AgentSecretAuditEntry {
  event: AgentSecretAuditEvent;
  scope: ChatSecretScope;
  names: readonly string[];
  /** For `provided`: where each value came from. */
  sources?: Readonly<Record<string, 'entered' | 'chat'>>;
  /** For `revoked` and `expired`: why. */
  reason?: string;
  tool?: 'RequestSecrets';
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
  private queue: Promise<unknown> = Promise.resolve();

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
   * or a file this version doesn't understand, rejects and isn't cached, so
   * every operation fails (and the next one reads again) rather than start
   * from an empty store whose next write would delete the file. Only a file
   * that isn't JSON at all counts as empty: nothing in it can be decrypted.
   */
  private load(): Promise<void> {
    this.loaded ??= this.read().catch((error: unknown) => {
      this.loaded = null;
      throw error;
    });
    return this.loaded;
  }

  private async read(): Promise<void> {
    let raw: string;
    try {
      raw = await (this.options.readFile ?? readUtf8)(this.filePath());
    } catch (error) {
      if (isMissingFileError(error)) return;
      logMainProcessWarn('[agent-secrets] Could not read chat secrets');
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      logMainProcessWarn('[agent-secrets] Chat secrets file is damaged');
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
    for (const chat of value.chats) {
      if (!isRecord(chat) || !validScope(chat.scope) || !isRecord(chat.secrets))
        continue;
      const secrets = new Map<string, StoredEntry>();
      for (const [name, entry] of Object.entries(chat.secrets)) {
        if (
          !AGENT_SECRET_NAME_PATTERN.test(name) ||
          !isRecord(entry) ||
          typeof entry.ciphertext !== 'string' ||
          typeof entry.createdAt !== 'number' ||
          typeof entry.expiresAt !== 'number'
        )
          continue;
        secrets.set(name, {
          ciphertext: entry.ciphertext,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
        });
      }
      const scope: ChatSecretScope = {
        projectId: chat.scope.projectId,
        worktreeId: chat.scope.worktreeId,
        chatId: chat.scope.chatId,
      };
      if (secrets.size) this.chats.set(chatKey(scope), { scope, secrets });
    }
    for (const revoke of this.pendingRevocations) revoke();
    this.pendingRevocations.clear();
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
        };
      }
      if (Object.keys(secrets).length)
        file.chats.push({ scope: chat.scope, secrets });
    }
    const path = this.filePath();
    if (!file.chats.length) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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

  /** Every name this chat holds now. */
  listNames(scope: ChatSecretScope): Promise<string[]> {
    return this.enqueue(async () => {
      await this.load();
      return [...(this.live(scope)?.keys() ?? [])].sort();
    });
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
      };
      const previous = new Map(chat.secrets);
      for (const [name, entry] of prepared) {
        const earlier = previous.get(name);
        if (earlier) this.replaced.set(entry, earlier);
        chat.secrets.set(name, entry);
      }
      this.chats.set(key, chat);
      const restore = (): void => {
        chat.secrets.clear();
        for (const [name, entry] of previous) chat.secrets.set(name, entry);
        if (chat.secrets.size) this.chats.set(key, chat);
        else this.chats.delete(key);
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
            if (earlier) current.secrets.set(name, earlier);
            else current.secrets.delete(name);
          }
          if (!current.secrets.size) this.chats.delete(key);
        });
      if (!encrypted && !prepared.some(([name]) => previous.has(name)))
        return undo;
      try {
        await this.persist();
      } catch (error) {
        // Roll back so memory never holds what disk refused.
        restore();
        throw error;
      }
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
  private mutate<T>(change: () => T): Promise<T> {
    return this.enqueue(async () => {
      await this.load();
      const result = change();
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
   * Deletes `names` (every name when omitted) from a chat. Resolves the names
   * removed.
   */
  remove(scope: ChatSecretScope, names?: readonly string[]): Promise<string[]> {
    return this.revoke(() => {
      const key = chatKey(scope);
      const chat = this.chats.get(key);
      if (!chat) return [];
      const removed: string[] = [];
      for (const name of names ?? [...chat.secrets.keys()]) {
        if (!chat.secrets.delete(name)) continue;
        removed.push(name);
      }
      if (!chat.secrets.size) this.chats.delete(key);
      return removed.sort();
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
      return removed;
    });
  }

  /**
   * Deletes every expired value and rewrites the file, which also retries a
   * deletion an earlier write refused. Resolves what it removed, per chat.
   */
  sweepExpired(): Promise<Array<{ scope: ChatSecretScope; names: string[] }>> {
    return this.mutate(() => {
      const now = this.now();
      const swept: Array<{ scope: ChatSecretScope; names: string[] }> = [];
      for (const [key, chat] of this.chats) {
        const names: string[] = [];
        for (const [name, entry] of chat.secrets) {
          if (entry.expiresAt > now) continue;
          chat.secrets.delete(name);
          names.push(name);
        }
        if (!chat.secrets.size) this.chats.delete(key);
        if (names.length)
          swept.push({ scope: chat.scope, names: names.sort() });
      }
      return swept;
    });
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
          if (value !== undefined) values.set(ref, value);
        }
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
