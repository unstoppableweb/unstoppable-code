import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  MemoryReplicaAccountFileSchema,
  MemorySyncOutboxFileSchema,
  MemorySyncStateFileSchema,
  type MemorySyncOutboxFile,
  type MemorySyncStateFile,
} from '@canopy/protocol/memory-sync';
import type { z } from 'zod';
import { rebindReplicaManifest } from '../local/scope-manifest';
import {
  isNodeError,
  writeMemoryFileAtomically,
  writeMemoryFileDurably,
} from '../local/memory-files';
import {
  memoryReplicaAccountFile,
  memorySyncOutboxFile,
  memorySyncStateFile,
} from './replica-layout';

/*
 * The bookkeeping files of a replica (design §16.1): `account.json` at the
 * account folder, and `sync-state.json` and `sync-outbox.json` in each scope.
 * They are loose on disk: a writer keeps every field it read, so a newer
 * build's additions survive an older build's rewrite. Scope files are
 * written under the scope lock, atomically.
 */

export type MemoryReplicaAccountFile = z.output<
  typeof MemoryReplicaAccountFileSchema
>;
export type MemoryReplicaBinding = MemorySyncStateFile['binding'];

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Undefined when absent; null when present but unreadable. */
export async function readMemorySyncState(
  scopeDir: string,
): Promise<MemorySyncStateFile | null | undefined> {
  const raw = await readJson(memorySyncStateFile(scopeDir));
  if (raw === undefined) return undefined;
  const parsed = MemorySyncStateFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function writeMemorySyncState(
  scopeDir: string,
  state: MemorySyncStateFile,
): Promise<void> {
  await writeMemoryFileAtomically(
    scopeDir,
    memorySyncStateFile(scopeDir),
    serialize(MemorySyncStateFileSchema.parse(state)),
  );
}

/**
 * Adds a conflict to `sync-state.json` as it is on disk, flushed, before the
 * document whose edit it keeps is replaced or removed. The rest of the state
 * a pull changes is written once the pull is done, so a pull cut short in
 * between replays with the conflict still recorded. The caller holds the
 * scope lock.
 */
export async function recordMemorySyncConflict(
  scopeDir: string,
  conflict: MemorySyncStateFile['conflicts'][number],
): Promise<void> {
  const state = await readMemorySyncState(scopeDir);
  if (state === undefined || state === null) {
    throw new Error('The memory replica has no readable sync state');
  }
  await writeMemoryFileDurably(
    scopeDir,
    memorySyncStateFile(scopeDir),
    serialize(
      MemorySyncStateFileSchema.parse({
        ...state,
        conflicts: [...state.conflicts, conflict],
      }),
    ),
    { replace: true },
  );
}

export function initialMemorySyncState(
  binding: MemoryReplicaBinding,
  deviceId: string,
): MemorySyncStateFile {
  return {
    version: 1,
    binding,
    deviceId,
    mode: 'syncing',
    cursor: null,
    baseRevision: 0,
    baseDocuments: {},
    localOnlyNoteIds: [],
    pendingCommit: null,
    conflicts: [],
    firstEnable: null,
    lastPulledAt: null,
    lastPushedAt: null,
    lastError: null,
  };
}

/** An empty outbox when the file is absent; null when it is unreadable. */
export async function readMemorySyncOutbox(
  scopeDir: string,
  binding: MemoryReplicaBinding,
): Promise<MemorySyncOutboxFile | null> {
  const raw = await readJson(memorySyncOutboxFile(scopeDir));
  if (raw === undefined) return { version: 1, binding, ops: [], usage: {} };
  const parsed = MemorySyncOutboxFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function writeMemorySyncOutbox(
  scopeDir: string,
  outbox: MemorySyncOutboxFile,
): Promise<void> {
  await writeMemoryFileAtomically(
    scopeDir,
    memorySyncOutboxFile(scopeDir),
    serialize(MemorySyncOutboxFileSchema.parse(outbox)),
  );
}

export async function readMemoryReplicaAccount(
  accountDir: string,
): Promise<MemoryReplicaAccountFile | null | undefined> {
  const raw = await readJson(memoryReplicaAccountFile(accountDir));
  if (raw === undefined) return undefined;
  const parsed = MemoryReplicaAccountFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Callers hold the account's sync engine lock. */
export async function writeMemoryReplicaAccount(
  accountDir: string,
  account: MemoryReplicaAccountFile,
): Promise<void> {
  await writeMemoryFileAtomically(
    accountDir,
    memoryReplicaAccountFile(accountDir),
    serialize(MemoryReplicaAccountFileSchema.parse(account)),
  );
}

/**
 * Binds a replica to its cloud scope again under another project: the cloud
 * keyed the scope it already holds to that project (design §21.6, §22), so
 * its files stay where they are. The manifest and outbox go first and
 * `sync-state.json` last, which the engine maps replicas by, so a crash
 * between them is finished by the next pass. The caller holds the scope lock.
 */
export async function rebindMemoryReplicaFiles(
  scopeDir: string,
  binding: MemoryReplicaBinding,
): Promise<void> {
  const state = await readMemorySyncState(scopeDir);
  if (state === undefined || state === null) {
    throw new Error('The memory replica has no readable sync state');
  }
  await rebindReplicaManifest(scopeDir, binding);
  const raw = await readJson(memorySyncOutboxFile(scopeDir));
  if (raw !== undefined) {
    const outbox = MemorySyncOutboxFileSchema.safeParse(raw);
    if (outbox.success) {
      await writeMemorySyncOutbox(scopeDir, { ...outbox.data, binding });
    }
  }
  await writeMemorySyncState(scopeDir, { ...state, binding });
}
