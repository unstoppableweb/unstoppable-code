import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { getBrandOwnedDataDirRoots } from '@canopy/execution-engine/canopy-paths';
import { getDataDir } from '../lib/paths';
import { isRecord } from '../lib/type-guards';
import { createReadPool, readFileHead, type ReadPool } from './file-head';
import { DEFAULT_DISCOVERY_LIMITS } from './types';

/**
 * The native OpenCode session ids Canopy's own runs recorded. OpenCode keeps
 * no origin on a session and Canopy does not tag the ones it creates, but the
 * three places Canopy runs OpenCode each persist a binding file holding the
 * native id, so those files are the one precise signal that a session in
 * OpenCode's database is Canopy's rather than the user's. Only the binding
 * files are read; OpenCode's own database is never opened here.
 *
 * - Chats: `<worktree-data>/<worktree>/opencode-sessions/<profile>/host-session.json`
 * - Delegates: `<worktree-data>/<worktree>/delegation/opencode-sessions/<delegation>/host-session.json`
 * - Pipelines: `pipeline-executions/<execution>/opencode-sessions/<digest>.json`
 *
 * Each records the id as `sessionId`. Every data root this brand owns is
 * scanned (the running build's, and the other builds' and historical ones),
 * since another build's chats land in the same OpenCode database. The set is
 * best-effort: an unreadable or malformed binding is skipped, and past the
 * file cap only the most recently written bindings are read.
 */

export interface OwnOpenCodeSessionOptions {
  /** The one data directory to scan; defaults to every data root the brand owns. */
  dataDir?: string;
  limits?: { maxFiles: number };
  /** Called with the number of binding files left unread past the cap. */
  onTruncated?: (skipped: number) => void;
}

const DEFAULT_MAX_FILES = 20000;
/** A binding is a few hundred bytes; anything larger is not one. */
const BINDING_HEAD_BYTES = 64 * 1024;
const BINDING_FILE = 'host-session.json';
const OPENCODE_SESSIONS = 'opencode-sessions';
/** Workspace roots under the data directory; app-managed chats live apart. */
const WORKSPACE_ROOTS = ['workspaces', 'app-workspaces'];

async function listEntries(pool: ReadPool, dir: string): Promise<Dirent[]> {
  try {
    return await pool.run(() => readdir(dir, { withFileTypes: true }));
  } catch {
    // A root that was never created, or removed mid-scan, holds nothing.
    return [];
  }
}

async function listSubdirectories(
  pool: ReadPool,
  dir: string,
): Promise<string[]> {
  const entries = await listEntries(pool, dir);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name));
}

async function flatMapAsync<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R[]>,
): Promise<R[]> {
  return (await Promise.all(items.map(fn))).flat();
}

/** Worktree chat and delegate bindings: one `host-session.json` per profile directory. */
async function hostSessionBindings(
  pool: ReadPool,
  dataDir: string,
): Promise<string[]> {
  const workspaces = await flatMapAsync(WORKSPACE_ROOTS, (root) =>
    listSubdirectories(pool, join(dataDir, root)),
  );
  const worktrees = await flatMapAsync(workspaces, (workspace) =>
    listSubdirectories(pool, join(workspace, 'worktree-data')),
  );
  const profileRoots = worktrees.flatMap((worktree) => [
    join(worktree, OPENCODE_SESSIONS),
    join(worktree, 'delegation', OPENCODE_SESSIONS),
  ]);
  const profiles = await flatMapAsync(profileRoots, (root) =>
    listSubdirectories(pool, root),
  );
  return profiles.map((profile) => join(profile, BINDING_FILE));
}

/** Pipeline bindings: one `<digest>.json` per native session, beside the profile directories. */
async function pipelineBindings(
  pool: ReadPool,
  dataDir: string,
): Promise<string[]> {
  const executions = await listSubdirectories(
    pool,
    join(dataDir, 'pipeline-executions'),
  );
  return flatMapAsync(executions, async (execution) => {
    const root = join(execution, OPENCODE_SESSIONS);
    const entries = await listEntries(pool, root);
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(root, entry.name));
  });
}

async function readSessionId(
  pool: ReadPool,
  file: string,
): Promise<string | null> {
  try {
    const text = await pool.run(() => readFileHead(file, BINDING_HEAD_BYTES));
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    const { sessionId } = parsed;
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
  } catch {
    return null;
  }
}

async function modifiedMs(pool: ReadPool, file: string): Promise<number> {
  try {
    return (await pool.run(() => stat(file))).mtimeMs;
  } catch {
    return 0;
  }
}

/** The newest `maxFiles` of `files` by modification time. */
async function newestFiles(
  pool: ReadPool,
  files: string[],
  maxFiles: number,
): Promise<string[]> {
  const times = await Promise.all(files.map((file) => modifiedMs(pool, file)));
  return files
    .map((file, index) => ({ file, time: times[index] }))
    .sort((left, right) => right.time - left.time)
    .slice(0, maxFiles)
    .map((entry) => entry.file);
}

export async function collectOwnOpenCodeSessionIds(
  options: OwnOpenCodeSessionOptions = {},
): Promise<Set<string>> {
  const dataDirs = options.dataDir
    ? [options.dataDir]
    : Array.from(new Set([getDataDir(), ...getBrandOwnedDataDirRoots()]));
  const maxFiles = Math.max(0, options.limits?.maxFiles ?? DEFAULT_MAX_FILES);
  const pool = createReadPool(DEFAULT_DISCOVERY_LIMITS.maxConcurrentReads);
  const found = Array.from(
    new Set(
      await flatMapAsync(dataDirs, async (dataDir) =>
        (
          await Promise.all([
            hostSessionBindings(pool, dataDir),
            pipelineBindings(pool, dataDir),
          ])
        ).flat(),
      ),
    ),
  );
  let files = found;
  if (found.length > maxFiles) {
    files = await newestFiles(pool, found, maxFiles);
    options.onTruncated?.(found.length - files.length);
  }
  const ids = await Promise.all(files.map((file) => readSessionId(pool, file)));
  const own = new Set<string>();
  for (const id of ids) if (id !== null) own.add(id);
  return own;
}
