/**
 * Adapted from https://github.com/vercel-labs/skills
 * Original source: MIT License
 * https://github.com/vercel-labs/skills/blob/main/src/skill-lock.ts
 */

import * as fs from 'fs';
import { readFile, rm } from 'fs/promises';
import * as path from 'path';
import type {
  SkillLockFile,
  SkillLockEntry,
  SourceMetadata,
} from '@canopy/desktop-shared/types/skills';
import {
  getSkillsLockFilePath,
  getSkillsRootDir,
  getSourceDir,
  getSourceMetadataPath,
  getSkillDir,
  deriveSourceId,
} from './paths';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import {
  writeFileAtomically,
  writeFileAtomicallySync,
} from '@canopy/execution-engine/node/lib/atomic-file';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isErrnoException } from '../lib/type-guards';
import { fetchGitHubTree, getGitHubToken } from './skill-discovery';

const LOCK_VERSION = 2;

// ---------------------------------------------------------------------------
// Composite lock-key helpers
// ---------------------------------------------------------------------------

export function getLockKey(sourceId: string, skillName: string): string {
  return `${sourceId}/${skillName}`;
}

export function parseLockKey(key: string): {
  sourceId: string;
  skillName: string;
} {
  const lastSlash = key.lastIndexOf('/');
  if (lastSlash === -1) {
    throw new Error(`Invalid lock key (no separator): ${key}`);
  }
  return {
    sourceId: key.substring(0, lastSlash),
    skillName: key.substring(lastSlash + 1),
  };
}

// ---------------------------------------------------------------------------
// Read status
// ---------------------------------------------------------------------------

/** A lock this build must not write over, or a v1 migration it cannot finish. */
export class SkillLockFileError extends Error {
  constructor(
    readonly code: 'newer' | 'migration-conflict' | 'migration-failed',
    message: string,
  ) {
    super(message);
    this.name = 'SkillLockFileError';
  }
}

/** `stored` holds every entry, including ones this build cannot read. */
export type SkillLockRead =
  | { status: 'ok' | 'missing'; stored: Record<string, unknown> }
  | { status: 'damaged' }
  | { status: 'refused'; error: SkillLockFileError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fields readers rely on; other fields are carried as stored. */
function hasEntryFields(
  value: unknown,
): value is Omit<SkillLockEntry, 'sourceId'> {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    (value.sourceType === 'github' ||
      value.sourceType === 'local' ||
      value.sourceType === 'url')
  );
}

function migrationFailed(error: unknown): SkillLockFileError {
  return error instanceof SkillLockFileError
    ? error
    : new SkillLockFileError(
        'migration-failed',
        `The version 1 skills lock could not be migrated and was kept: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
}

/** Absence, damage, a newer version and an unfinished migration stay distinct. */
export function readLockFileStatus(): SkillLockRead {
  // Folders are already moved: the migrated entries are the lock now.
  if (pendingMigration)
    return { status: 'ok', stored: pendingMigration.skills };
  let raw: string;
  try {
    raw = readLockText();
  } catch (error) {
    return isErrnoException(error) && error.code === 'ENOENT'
      ? { status: 'missing', stored: {} }
      : { status: 'damaged' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'damaged' };
  }
  if (!isRecord(parsed)) return { status: 'damaged' };
  // Before the payload shape: a newer lock may store skills differently.
  if (typeof parsed.version === 'number' && parsed.version > LOCK_VERSION) {
    return {
      status: 'refused',
      error: new SkillLockFileError(
        'newer',
        'The skills lock is from a newer version and was not changed.',
      ),
    };
  }
  if (!isRecord(parsed.skills)) return { status: 'damaged' };
  if (parsed.version === 1) {
    try {
      return { status: 'ok', stored: migrateV1Lock(parsed.skills, raw) };
    } catch (error) {
      return { status: 'refused', error: migrationFailed(error) };
    }
  }
  if (parsed.version !== LOCK_VERSION) return { status: 'damaged' };
  return { status: 'ok', stored: parsed.skills };
}

// ---------------------------------------------------------------------------
// v1 → v2 migration
// ---------------------------------------------------------------------------

/** A migration whose folders are moved and whose durable writes are running. */
interface PendingMigration {
  skills: Record<string, SkillLockEntry>;
  v1Raw: string;
  /** Fixed when the migration starts, so later I/O never follows a moved data root. */
  backupPath: string;
  /** An entry was left out of v2, so the v1 backup stays its only record. */
  skipped: boolean;
  sources: Map<string, SourceMetadata>;
  /** Settles once the backup and source metadata writes do, never rejects. */
  flushed: Promise<boolean>;
}
let pendingMigration: PendingMigration | undefined;
let migrationCommitted: Promise<void> = Promise.resolve();

/**
 * The status once a v1 migration that a read starts has committed or given
 * up; one that has not committed is uncertain, never a positive.
 */
export async function readCommittedLockStatus(): Promise<SkillLockRead> {
  readLockFileStatus();
  await migrationCommitted;
  const read = readLockFileStatus();
  return pendingMigration
    ? {
        status: 'refused',
        error: migrationFailed(
          new Error('The version 1 skills lock migration has not committed.'),
        ),
      }
    : read;
}

/** Settles once a started v1 migration has committed or given up. */
export function skillLockMigrationSettled(): Promise<void> {
  return migrationCommitted;
}

/**
 * Resumable: the v1 lock stays in place until the v2 lock is committed, a
 * folder already moved is skipped and source metadata is rewritten whole, so
 * a restart after any exit finishes the same migration. The moves happen on
 * the read; the durable writes run after it, so the startup read that finds a
 * v1 lock does not wait for a flush.
 */
function migrateV1Lock(
  v1Skills: Record<string, unknown>,
  v1Raw: string,
): Record<string, SkillLockEntry> {
  const rootDir = getSkillsRootDir();
  const moves: Array<{ oldDir: string; newDir: string; sourceId: string }> = [];
  const sources = new Map<string, SourceMetadata>();
  const skills: Record<string, SkillLockEntry> = {};

  let skipped = false;
  for (const [skillName, entry] of Object.entries(v1Skills)) {
    // Reject skill names with path separators or traversal segments
    if (
      skillName.includes('/') ||
      skillName.includes('\\') ||
      skillName === '..' ||
      skillName.includes('..' + path.sep)
    ) {
      skipped = true;
      continue;
    }
    if (!hasEntryFields(entry)) {
      throw new Error(`Unreadable version 1 entry ${skillName}`);
    }
    const sourceId = deriveSourceId(entry.sourceType, entry.source);
    // Its nested folder would be the source metadata file, so it stays flat.
    // A folder an earlier attempt moved there goes back; both is a conflict.
    const metadataPath = getSourceMetadataPath(sourceId);
    if (getSkillDir(sourceId, skillName) === metadataPath) {
      logMainProcessWarn(
        `[skills] Version 1 skill ${skillName} was not migrated: its name is reserved`,
      );
      if (fs.statSync(metadataPath, { throwIfNoEntry: false })?.isDirectory())
        moves.push({
          oldDir: metadataPath,
          newDir: path.join(rootDir, skillName),
          sourceId,
        });
      skipped = true;
      continue;
    }
    moves.push({
      oldDir: path.join(rootDir, skillName),
      newDir: getSkillDir(sourceId, skillName),
      sourceId,
    });
    if (!sources.has(sourceId)) {
      const metadata: SourceMetadata = {
        type: entry.sourceType,
        sourceId,
        url: entry.sourceUrl,
      };
      if (entry.sourceType === 'github') {
        const [owner, repo] = entry.source.split('/');
        metadata.owner = owner;
        metadata.repo = repo;
      }
      sources.set(sourceId, metadata);
    }
    skills[getLockKey(sourceId, skillName)] = { ...entry, sourceId };
  }

  // Refuse before any change: never write over a folder that is already there.
  const conflict = moves.find(
    ({ oldDir, newDir }) => fs.existsSync(oldDir) && fs.existsSync(newDir),
  );
  if (conflict) {
    throw new SkillLockFileError(
      'migration-conflict',
      `Both ${conflict.oldDir} and ${conflict.newDir} exist, so the version 1 skills lock was kept.`,
    );
  }

  // Every source gets its folder, even one whose skill folders are all gone.
  for (const sourceId of sources.keys()) {
    fs.mkdirSync(getSourceDir(sourceId), { recursive: true });
  }
  for (const { oldDir, newDir } of moves) {
    // A folder already moved, or gone, is skipped.
    try {
      fs.renameSync(oldDir, newDir);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
    }
  }
  const backupPath = `${getSkillsLockFilePath()}.v1`;
  // The backup and every source's metadata flush in one batch; each metadata
  // write also flushes its source folder's moves.
  const flushed = Promise.allSettled([
    // A backup an earlier, different v1 lock left is replaced, as on the
    // synchronous path.
    readFile(backupPath, 'utf-8').then(
      (text) => text === v1Raw || writeDurablyAsync(backupPath, v1Raw),
      () => writeDurablyAsync(backupPath, v1Raw),
    ),
    ...[...sources].map(([sourceId, metadata]) =>
      writeDurablyAsync(
        getSourceMetadataPath(sourceId),
        JSON.stringify(metadata, null, 2),
      ),
    ),
  ]).then((results) => {
    // Every write has settled, so none lands after the migration gives up.
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      logMainProcessWarn(
        '[skills] The version 1 skills lock was kept',
        failed.reason,
      );
      return null;
    }
    return results.every(
      (result) => result.status === 'fulfilled' && result.value,
    );
  });
  const migration: PendingMigration = {
    skipped,
    skills,
    v1Raw,
    backupPath,
    sources,
    flushed: flushed.then((confirmed) => confirmed === true),
  };
  pendingMigration = migration;
  migrationCommitted = flushed.then(async (confirmed) => {
    if (pendingMigration !== migration) return;
    const current = await readFile(getSkillsLockFilePath(), 'utf-8').catch(
      () => null,
    );
    // A lock write that ran meanwhile finished this migration itself.
    if (pendingMigration !== migration) return;
    pendingMigration = undefined;
    // A failed write keeps v1; the next read resumes the migration.
    if (confirmed === null) return;
    if (current !== v1Raw) return abandonMigration();
    // The lock last: v1 stays the record until every file above is durable.
    await commitV2Lock(skills, confirmed && !skipped, backupPath);
  });
  return skills;
}

function readLockText(): string {
  return fs.readFileSync(getSkillsLockFilePath(), 'utf-8');
}

function lockStillV1(v1Raw: string): boolean {
  try {
    return readLockText() === v1Raw;
  } catch {
    return false;
  }
}

/**
 * Another process replaced the lock during the flush: its lock stands, the
 * backup stays and the next read classifies it. Processes sharing one data
 * root are outside the store's single-owner contract (see Not claimed).
 */
function abandonMigration(): void {
  logMainProcessWarn(
    '[skills] The skills lock changed during its version 1 migration; the migration was abandoned',
  );
}

/** Writes the v2 lock; an unconfirmed flush keeps the only copy of v1. */
async function commitV2Lock(
  skills: Record<string, SkillLockEntry>,
  confirmed: boolean,
  backupPath: string,
): Promise<void> {
  try {
    if (writeLockFile(skills) && confirmed)
      await rm(backupPath, { force: true });
  } catch (error) {
    // v1 is still the record; the next read resumes the migration.
    logMainProcessWarn('[skills] The version 1 skills lock was kept', error);
  }
}

/**
 * A lock write cannot wait for a running migration, so it finishes the
 * migration's writes itself, in the same order, before its own.
 */
function finishPendingMigration(): void {
  const migration = pendingMigration;
  if (!migration) return;
  pendingMigration = undefined;
  // The backup always holds the v1 lock this migration replaces.
  let confirmed =
    writeDurably(migration.backupPath, migration.v1Raw) && !migration.skipped;
  for (const [sourceId, metadata] of migration.sources) {
    confirmed =
      writeDurably(
        getSourceMetadataPath(sourceId),
        JSON.stringify(metadata, null, 2),
      ) && confirmed;
  }
  if (!lockStillV1(migration.v1Raw)) return abandonMigration();
  // The running backup write may land after this, so the backup goes after it.
  const lockConfirmed = writeLockFile(migration.skills);
  migrationCommitted = migration.flushed.then(async () => {
    if (!lockConfirmed || !confirmed) return;
    await rm(migration.backupPath, { force: true }).catch((error: unknown) => {
      logMainProcessWarn('[skills] The version 1 backup was kept', error);
    });
  });
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/** The readable lock; a damaged, newer or unmigrated one reads as empty. */
export function readLockFile(): SkillLockFile {
  const read = readLockFileStatus();
  const stored =
    read.status === 'ok' || read.status === 'missing' ? read.stored : {};
  // Entries this build cannot read are hidden here and carried by writers.
  const skills: Record<string, SkillLockEntry> = {};
  for (const [key, entry] of Object.entries(stored)) {
    if (key.includes('/') && hasEntryFields(entry)) {
      skills[key] = { sourceId: parseLockKey(key).sourceId, ...entry };
    }
  }
  return { version: LOCK_VERSION, skills };
}

/** The status a writer acts on: a due or running v1 migration is finished first. */
function readLockStatusForWrite(): SkillLockRead {
  readLockFileStatus();
  // A read may start a migration, so finish until one leaves none running;
  // bounded, so a migration that keeps restarting refuses instead of spinning.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      finishPendingMigration();
    } catch (error) {
      return { status: 'refused', error: migrationFailed(error) };
    }
    const read = readLockFileStatus();
    if (!pendingMigration) return read;
  }
  return {
    status: 'refused',
    error: new SkillLockFileError(
      'migration-failed',
      'The version 1 skills lock migration did not finish, so nothing was written.',
    ),
  };
}

/** A damaged lock is copied aside before it is replaced; a refused one throws. */
function readLockForWrite(): Record<string, unknown> {
  const read = readLockStatusForWrite();
  if (read.status === 'refused') throw read.error;
  if (read.status !== 'damaged') return read.stored;
  const filePath = getSkillsLockFilePath();
  fs.copyFileSync(
    filePath,
    `${filePath}.damaged-${Date.now()}`,
    fs.constants.COPYFILE_EXCL,
  );
  return {};
}

/** False when the file is installed but its folder flush failed. */
async function writeDurablyAsync(
  filePath: string,
  text: string,
): Promise<boolean> {
  try {
    await writeFileAtomically(filePath, text, {
      encoding: 'utf8',
      durable: true,
    });
    return true;
  } catch (error) {
    if (!isStorageOutcomeUnknownError(error)) throw error;
    logMainProcessWarn(
      '[skills] Skills lock installed, but its folder flush failed',
      error,
    );
    return false;
  }
}

/** False when the file is installed but its folder flush failed. */
function writeDurably(filePath: string, text: string): boolean {
  try {
    writeFileAtomicallySync(filePath, text, {
      encoding: 'utf8',
      durable: true,
    });
    return true;
  } catch (error) {
    // Installed but its folder flush failed: every later read sees it.
    if (!isStorageOutcomeUnknownError(error)) throw error;
    logMainProcessWarn(
      '[skills] Skills lock installed, but its folder flush failed',
      error,
    );
    return false;
  }
}

function writeLockFile(skills: Record<string, unknown>): boolean {
  const filePath = getSkillsLockFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Sort skills alphabetically for clean diffs
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(skills).sort()) {
    sorted[key] = skills[key];
  }
  return writeDurably(
    filePath,
    JSON.stringify({ version: LOCK_VERSION, skills: sorted }, null, 2) + '\n',
  );
}

/** Throws when lock writes are refused; finishes a pending v1 migration. */
export function assertLockWritable(): void {
  const read = readLockStatusForWrite();
  if (read.status === 'refused') throw read.error;
}

// ---------------------------------------------------------------------------
// Entry management
// ---------------------------------------------------------------------------

/**
 * Add or replace entries by lock key in one durable write. The lock decides
 * installedAt (CAN-5239): an existing entry keeps its stored date, even an
 * empty legacy one, and a new key gets the host time. A caller-sent date is
 * ignored.
 */
export function addLockEntries(entries: Record<string, SkillLockEntry>): void {
  const skills = readLockForWrite();
  const now = new Date().toISOString();
  for (const [key, entry] of Object.entries(entries)) {
    const previous = skills[key];
    const installedAt = isRecord(previous)
      ? typeof previous.installedAt === 'string'
        ? previous.installedAt
        : ''
      : now;
    skills[key] = { ...entry, installedAt };
  }
  writeLockFile(skills);
}

export function addLockEntry(
  sourceId: string,
  skillName: string,
  entry: SkillLockEntry,
): void {
  addLockEntries({ [getLockKey(sourceId, skillName)]: entry });
}

export function removeLockEntry(sourceId: string, skillName: string): void {
  const skills = readLockForWrite();
  delete skills[getLockKey(sourceId, skillName)];
  writeLockFile(skills);
}

// ---------------------------------------------------------------------------
// GitHub tree SHA helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the current tree SHA for a skill's folder from GitHub.
 * Returns null if the folder cannot be found.
 */
export async function fetchSkillFolderHash(
  owner: string,
  repo: string,
  skillPath: string,
  branch?: string,
): Promise<string | null> {
  try {
    const token = await getGitHubToken();
    const { tree, treeSha } = await fetchGitHubTree(owner, repo, token, branch);

    // Root-level skills ('.' or '') use the root tree SHA
    if (!skillPath || skillPath === '.') {
      return treeSha ?? null;
    }

    // Look for the tree entry matching the skill folder path
    const entry = tree.find((e) => e.type === 'tree' && e.path === skillPath);

    return entry?.sha ?? null;
  } catch {
    return null;
  }
}

/**
 * Check whether a specific installed skill has an available update
 * by comparing the stored hash against the current GitHub tree SHA.
 */
export async function checkForUpdate(
  _skillName: string,
  entry: SkillLockEntry,
): Promise<boolean> {
  const [owner, repo] = entry.source.split('/');
  if (!owner || !repo) return false;

  const currentHash = await fetchSkillFolderHash(owner, repo, entry.skillPath);

  if (!currentHash) return false;
  return currentHash !== entry.skillFolderHash;
}
