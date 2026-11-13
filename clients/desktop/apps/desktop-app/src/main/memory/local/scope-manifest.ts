import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  MEMORY_LOCAL_FORMAT_VERSION,
  MEMORY_MANIFEST_FILENAME,
  MemoryManifestFileSchema,
  type MemoryManifestFile,
} from '@canopy/protocol/memory-sync';
import { isRecord } from '../../lib/type-guards';
import { backfillMemoryScope } from './backfill';
import {
  ensureOwnerOnlyDir,
  isNodeError,
  sweepAbandonedMemoryWrites,
  writeMemoryFileAtomically,
} from './memory-files';

/*
 * `manifest.json` of a device-local scope. Version 2 carries the scope's
 * incarnation and document revision, which every document write advances
 * under the scope lock, and the oldest writer format allowed to change the
 * scope. A build that predates version 2 rewrites it to version 1; the next
 * write here backfills again under a new incarnation.
 */

export const LOCAL_MEMORY_READ_ONLY_MESSAGE = `These memories were saved by a newer version of ${BRAND.displayName}. Update ${BRAND.displayName} to change them.`;

export class LocalMemoryScopeReadOnlyError extends Error {
  constructor() {
    super(LOCAL_MEMORY_READ_ONLY_MESSAGE);
    this.name = 'LocalMemoryScopeReadOnlyError';
  }
}

type ManifestState =
  /** No manifest, version 1, or one this build cannot parse. */
  | { kind: 'legacy'; raw: Record<string, unknown> }
  | { kind: 'current'; manifest: MemoryManifestFile }
  /** A later version: kept as written; its own `minWriterFormat` gates writes. */
  | { kind: 'newer'; raw: Record<string, unknown> };

async function readManifestState(scopeDir: string): Promise<ManifestState> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(join(scopeDir, MEMORY_MANIFEST_FILENAME), 'utf8'),
    );
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || error instanceof SyntaxError) {
      return { kind: 'legacy', raw: {} };
    }
    throw error;
  }
  if (!isRecord(raw)) return { kind: 'legacy', raw: {} };
  if (typeof raw.version === 'number' && raw.version > 2) {
    return { kind: 'newer', raw };
  }
  const parsed = MemoryManifestFileSchema.safeParse(raw);
  return parsed.success
    ? { kind: 'current', manifest: parsed.data }
    : { kind: 'legacy', raw };
}

/**
 * Fails closed: a manifest naming a `minWriterFormat` this build cannot
 * read as a number, or above its own format, makes the scope read-only.
 */
function isWritable(state: ManifestState): boolean {
  if (state.kind === 'current') {
    return state.manifest.minWriterFormat <= MEMORY_LOCAL_FORMAT_VERSION;
  }
  const minWriterFormat = state.raw.minWriterFormat;
  if (state.kind === 'newer') {
    return (
      typeof minWriterFormat === 'number' &&
      minWriterFormat <= MEMORY_LOCAL_FORMAT_VERSION
    );
  }
  return (
    minWriterFormat === undefined ||
    (typeof minWriterFormat === 'number' &&
      minWriterFormat <= MEMORY_LOCAL_FORMAT_VERSION)
  );
}

/**
 * Whether an existing scope this build may write still needs its backfill,
 * so a reader about to hand out revisions of its files can run it first.
 */
export async function memoryScopeNeedsBackfill(
  scopeDir: string,
): Promise<boolean> {
  try {
    if (!(await stat(scopeDir)).isDirectory()) return false;
  } catch {
    return false;
  }
  const state = await readManifestState(scopeDir);
  if (!isWritable(state) || state.kind === 'newer') return false;
  return state.kind === 'legacy' || state.manifest.backfilledAt === null;
}

async function writeManifest(
  scopeDir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await writeMemoryFileAtomically(
    scopeDir,
    join(scopeDir, MEMORY_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function backfillAndWriteManifest(
  scopeDir: string,
  state: Exclude<ManifestState, { kind: 'newer' }>,
): Promise<void> {
  const { complete } = await backfillMemoryScope(scopeDir);
  const now = new Date().toISOString();
  // An incomplete backfill leaves `backfilledAt` null: the next write retries.
  const backfilledAt = complete ? now : null;
  const manifest: MemoryManifestFile =
    state.kind === 'current'
      ? { ...state.manifest, backfilledAt }
      : {
          ...state.raw,
          version: 2,
          incarnation: randomUUID(),
          revision: 0,
          minWriterFormat: MEMORY_LOCAL_FORMAT_VERSION,
          createdAt: now,
          backfilledAt,
          binding: null,
          migratedTo: [],
        };
  await writeManifest(scopeDir, manifest);
}

/**
 * Readies a scope for a write: refuses a read-only scope with
 * {@link LocalMemoryScopeReadOnlyError}, removes the temp files of writes a
 * crash cut short, and backfills a scope this build has not yet given a
 * version 2 manifest. Callers hold the scope lock.
 */
export async function prepareMemoryScopeForWrite(
  scopeDir: string,
): Promise<void> {
  await ensureOwnerOnlyDir(scopeDir);
  const state = await readManifestState(scopeDir);
  if (!isWritable(state)) throw new LocalMemoryScopeReadOnlyError();
  await sweepAbandonedMemoryWrites(scopeDir);
  if (state.kind === 'newer') return;
  if (state.kind === 'current' && state.manifest.backfilledAt !== null) return;
  await backfillAndWriteManifest(scopeDir, state);
}

/**
 * Gives a new account replica its version 2 manifest, bound to its account
 * and cloud scope. A replica starts empty, so there is nothing to backfill.
 * Keeps a manifest that is already there. Callers hold the scope lock.
 */
export async function createReplicaManifest(
  scopeDir: string,
  binding: NonNullable<MemoryManifestFile['binding']>,
): Promise<void> {
  await ensureOwnerOnlyDir(scopeDir);
  const state = await readManifestState(scopeDir);
  if (state.kind !== 'legacy' || Object.keys(state.raw).length > 0) return;
  const now = new Date().toISOString();
  const manifest: MemoryManifestFile = {
    version: 2,
    incarnation: randomUUID(),
    revision: 0,
    minWriterFormat: MEMORY_LOCAL_FORMAT_VERSION,
    createdAt: now,
    backfilledAt: now,
    binding,
    migratedTo: [],
  };
  await writeManifest(scopeDir, manifest);
}

/**
 * Names the cloud scope an account replica's manifest is bound to again,
 * after the cloud keyed that scope to another project (design §21.6, §22).
 * A manifest this build may not write is left as it is. Callers hold the
 * scope lock.
 */
export async function rebindReplicaManifest(
  scopeDir: string,
  binding: NonNullable<MemoryManifestFile['binding']>,
): Promise<void> {
  const state = await readManifestState(scopeDir);
  if (!isWritable(state) || state.kind === 'legacy') return;
  await writeManifest(
    scopeDir,
    state.kind === 'current'
      ? { ...state.manifest, binding }
      : { ...state.raw, binding },
  );
}

/**
 * The scope's document revision as an opaque token: equal tokens mean no
 * document write happened in between, in any process.
 */
export async function readMemoryScopeRevision(
  scopeDir: string,
): Promise<string> {
  const state = await readManifestState(scopeDir);
  if (state.kind === 'current') {
    return `${state.manifest.incarnation}:${state.manifest.revision}`;
  }
  if (state.kind === 'newer') {
    return `${String(state.raw.incarnation)}:${String(state.raw.revision)}`;
  }
  return `legacy:${randomUUID()}`;
}

/** Advances the scope's document revision. Callers hold the scope lock. */
export async function advanceMemoryScopeRevision(
  scopeDir: string,
): Promise<void> {
  let state = await readManifestState(scopeDir);
  if (state.kind === 'legacy') {
    // An older build rewrote the manifest since this lock was taken.
    await prepareMemoryScopeForWrite(scopeDir);
    state = await readManifestState(scopeDir);
  }
  if (state.kind === 'current') {
    await writeManifest(scopeDir, {
      ...state.manifest,
      revision: state.manifest.revision + 1,
    });
    return;
  }
  if (state.kind === 'newer' && typeof state.raw.revision === 'number') {
    await writeManifest(scopeDir, {
      ...state.raw,
      revision: state.raw.revision + 1,
    });
    return;
  }
  throw new LocalMemoryScopeReadOnlyError();
}
