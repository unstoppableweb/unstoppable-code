import { W5FileWriteRefusedError } from './errors';
import {
  isCleanConflictEvidence,
  isTransientUnwrittenFailureEvidence,
} from './apply-evidence';
import { CORE_WORKSPACE_RECORDS_LIMITS } from '@canopy/protocol/canopy-core';

import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  fingerprintW5File,
  type W5CommitLog,
  type W5FileChange,
  type W5PendingCommit,
} from './commit-log';

/** A point the applier passes; tests stop the process at each one. */
export type W5ApplyStep =
  | { kind: 'before-file'; commitId: number; path: string }
  | { kind: 'after-file'; commitId: number; path: string }
  | { kind: 'before-mark-applied'; commitId: number };

/**
 * How the host makes the applier's writes durable. `writeFileDurably` installs
 * complete contents atomically (sibling temp file, fsync, rename, then a sync
 * of its folder); `syncDirectory` makes a folder's entries durable. The host
 * decides what each means on its platform, such as skipping folder syncs
 * where folders cannot be opened.
 */
export interface W5DurabilityPort {
  readonly syncDirectory: (directoryPath: string) => Promise<void>;
  readonly writeFileDurably: (path: string, contents: string) => Promise<void>;
}

export interface W5ApplyOptions {
  /** The W5 data root; every file a commit writes must be inside it. */
  root: string;
  durability: W5DurabilityPort;
  onStep?: (step: W5ApplyStep) => void;
  /** Explicit historical operation policy; cold maintenance hosts omit it. */
  healCleanConflictOperations?: ReadonlySet<string>;
  onAbandoned?: (entry: { commitId: number; operation: string }) => void;
  /** Host-bound exclusion at the execution owner, including replay. */
  processLock?: W5ProcessFileLock;
}

export type W5ProcessFileLock = <T>(
  paths: readonly string[],
  work: () => Promise<T>,
) => Promise<T>;

/** A typed live apply result proves this attempt wrote nothing. */
export function isCleanApplyConflict(
  result: W5ApplyResult,
): result is Extract<W5ApplyResult, { status: 'recovery-required' }> {
  return (
    result.status === 'recovery-required' &&
    result.conflicts.length > 0 &&
    result.written.length === 0 &&
    result.error === undefined
  );
}

/** A live apply stopped on a transient I/O error before writing anything. */
export function isTransientUnwrittenApplyFailure(
  result: W5ApplyResult,
): boolean {
  return (
    result.status === 'recovery-required' &&
    isTransientUnwrittenFailureEvidence({
      conflicts: result.conflicts,
      written: result.written,
      ...(result.error === undefined ? {} : { error: result.error }),
    })
  );
}

export type W5ApplyResult =
  | { status: 'applied' }
  | {
      status: 'recovery-required';
      /** Files whose contents match neither side of the change. */
      conflicts: W5FileConflict[];
      /** Files this attempt wrote before it stopped. */
      written: string[];
      /** An unexpected failure that stopped the apply, if any. */
      error?: string;
    };

export interface W5FileConflict {
  path: string;
  expected: string | null;
  actual: string | null;
}

function isMissingPathError(error: unknown): boolean {
  const code: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'code')
      : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function readFingerprint(path: string): Promise<string | null> {
  try {
    return fingerprintW5File(await readFile(path, 'utf8'));
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

/** Execution-owner preflight, while holding process exclusion and before decision. */
export async function preflightW5CommitFiles(
  files: readonly W5FileChange[],
  root: string,
): Promise<void> {
  for (const file of files) {
    await assertInsideRoot(file.path, root);
    if ((await readFingerprint(file.path)) !== file.previousFingerprint)
      throw new W5FileWriteRefusedError(file.path);
  }
}

/**
 * fsync a file. Opened for writing: Windows flushes a file only through a
 * handle with write access, and these are the app's own writable files.
 */
async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Folder entries are made durable once per commit, by
 * {@link syncFoldersToRoot}; files are flushed as they are written, and a file
 * an earlier, crashed attempt already wrote is flushed here. Unchanged
 * dependencies need no write access or file flush.
 */
async function syncDoneChange(file: W5FileChange): Promise<void> {
  if (
    file.contents !== null &&
    file.previousFingerprint !== fingerprintW5File(file.contents)
  ) {
    await syncFile(file.path);
  }
}

/**
 * Before a commit counts as applied, flush every existing folder from each
 * of its files up to the root: entries an earlier, crashed attempt created
 * or removed, new folders, and removals whose own folder is gone are all
 * recorded in one of them.
 */
async function syncFoldersToRoot(
  files: readonly W5FileChange[],
  root: string,
  durability: W5DurabilityPort,
): Promise<void> {
  const resolvedRoot = resolve(root);
  const folders = new Set<string>();
  for (const file of files) {
    // Compared as paths, not text, and bounded by the filesystem root, so
    // any spelling of the root ends the walk.
    for (let folder = dirname(resolve(file.path)); ; folder = dirname(folder)) {
      folders.add(folder);
      if (relative(resolvedRoot, folder) === '' || dirname(folder) === folder)
        break;
    }
  }
  for (const folder of Array.from(folders)) {
    try {
      await durability.syncDirectory(folder);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
}

function isInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/** The nearest folder on the way up from `path` that exists. */
async function nearestExistingFolder(path: string): Promise<string> {
  for (let folder = path; ; folder = dirname(folder)) {
    try {
      return await realpath(folder);
    } catch (error) {
      if (!isMissingPathError(error) || dirname(folder) === folder) throw error;
    }
  }
}

/**
 * Every file must be inside the data root, both as a path and as resolved
 * on disk: a symlinked folder inside the root cannot send a write elsewhere.
 */
async function assertInsideRoot(path: string, root: string): Promise<void> {
  const resolvedPath = resolve(path);
  const inside =
    isInside(resolve(root), resolvedPath) &&
    (await realpath(root).then(async (realRoot) => {
      const realFolder = await nearestExistingFolder(dirname(resolvedPath));
      return realFolder === realRoot || isInside(realRoot, realFolder);
    }));
  if (!inside) {
    throw new Error(`A W5 commit file is outside the data root: ${path}`);
  }
}

async function writeChange(
  file: W5FileChange,
  durability: W5DurabilityPort,
): Promise<void> {
  if (file.contents === null) {
    await rm(file.path, { force: true });
    return;
  }
  await mkdir(dirname(file.path), { recursive: true });
  await durability.writeFileDurably(file.path, file.contents);
}

/**
 * Bring the files of one committed change up to date, then mark it applied.
 * A file already holding the new contents (written before a crash) is kept
 * and synced. A file holding anything other than the contents the change
 * replaced was changed out of band: it is never overwritten, and the commit
 * waits for manual recovery (CAN-3799 D3). Each file is checked again right
 * before it is written, and any unexpected failure also leaves the commit
 * waiting for recovery rather than failing the caller.
 *
 * Participating CLI list mutations and host workers share execution-owner
 * process exclusion. Retained raw workspace/folder writers are inventoried
 * compatibility debt, so the fingerprint check remains necessary.
 */
export async function applyW5Commit(
  log: W5CommitLog,
  commit: W5PendingCommit,
  options: W5ApplyOptions,
): Promise<W5ApplyResult> {
  if (options.processLock) {
    const { processLock, ...unlocked } = options;
    return processLock(
      commit.files.map((file) => file.path),
      () => applyW5Commit(log, commit, unlocked),
    );
  }
  const written: string[] = [];
  const stop = (conflicts: W5FileConflict[], error?: string): W5ApplyResult => {
    log.markCommitRecoveryRequired(commit.commitId, {
      conflicts,
      written,
      ...(error === undefined ? {} : { error }),
    });
    return {
      status: 'recovery-required',
      conflicts,
      written,
      ...(error === undefined ? {} : { error }),
    };
  };
  // Every file operation uses the exact path that was checked: the OS would
  // otherwise follow a symlink before applying a later `..` in the raw path.
  const files: W5FileChange[] = commit.files.map((file) => ({
    ...file,
    path: resolve(file.path),
  }));
  try {
    for (const file of files) {
      await assertInsideRoot(file.path, options.root);
    }
    const conflicts: W5FileConflict[] = [];
    for (const file of files) {
      const conflict = await checkFile(file);
      if (conflict) conflicts.push(conflict);
    }
    if (conflicts.length > 0) return stop(conflicts);
    for (const file of files) {
      const conflict = await checkFile(file);
      if (conflict) return stop([conflict]);
      if (
        (await readFingerprint(file.path)) === fingerprintW5File(file.contents)
      ) {
        await syncDoneChange(file);
        continue;
      }
      options.onStep?.({
        kind: 'before-file',
        commitId: commit.commitId,
        path: file.path,
      });
      await writeChange(file, options.durability);
      written.push(file.path);
      options.onStep?.({
        kind: 'after-file',
        commitId: commit.commitId,
        path: file.path,
      });
    }
    await syncFoldersToRoot(files, options.root, options.durability);
  } catch (error) {
    return stop([], error instanceof Error ? error.message : String(error));
  }
  options.onStep?.({ kind: 'before-mark-applied', commitId: commit.commitId });
  log.markApplied(commit.commitId);
  return { status: 'applied' };
}

/** A conflict when a file holds neither side of the change. */
async function checkFile(file: W5FileChange): Promise<W5FileConflict | null> {
  const actual = await readFingerprint(file.path);
  if (
    actual === fingerprintW5File(file.contents) ||
    actual === file.previousFingerprint
  ) {
    return null;
  }
  return { path: file.path, expected: file.previousFingerprint, actual };
}

export interface W5RecoveryReport {
  /** Oldest successful heals, bounded to the wire evidence-row limit. */
  abandoned?: Array<{ commitId: number; operation: string }>;

  applied: number[];
  recoveryRequired: number[];
  interruptedReservations: number;
  /** Present when interrupted operations still require manual recovery. */
  recoveryRequiredReservations?: string[];
  /** Worker-supplied summaries, excluding file images and raw error text. */
  recoveryRequiredDetails?: Array<{
    commitId: number;
    conflictCount: number;
    writtenFileCount: number;
    unexpectedFailure: boolean;
  }>;
}

/**
 * Launch recovery, before anything reads W5 state: finish every committed
 * change in commit order, and mark each reservation an earlier process left
 * held as needing manual recovery. Uncertain effects are never resumed or
 * undone.
 */
export async function recoverW5CommitLog(
  log: W5CommitLog,
  options: W5ApplyOptions,
): Promise<W5RecoveryReport> {
  const interruptedReservations = log.markInterruptedReservations();
  const applied: number[] = [];
  for (const commit of log.listPendingCommits()) {
    const result = await applyW5Commit(log, commit, options);
    if (result.status === 'applied') applied.push(commit.commitId);
  }
  // CAN-5680: an unkeyed list write that stopped on a transient I/O error
  // before writing anything is applied again. If the file changed meanwhile,
  // the attempt ends as a clean conflict, which the loop below drops.
  for (const row of log.listRecoveryRequiredCommits()) {
    if (
      !options.healCleanConflictOperations?.has(row.operation) ||
      row.hasReceipt ||
      !row.transientFailure
    )
      continue;
    log.retryRecoveryRequiredCommit(row.commitId);
    const pending = log
      .listPendingCommits()
      .find((commit) => commit.commitId === row.commitId);
    if (!pending) continue;
    const result = await applyW5Commit(log, pending, options);
    if (result.status === 'applied') applied.push(row.commitId);
    // Still failing: it stays pending, and the next write applies it first.
    else if (isTransientUnwrittenApplyFailure(result))
      log.retryRecoveryRequiredCommit(row.commitId);
  }
  const abandoned: NonNullable<W5RecoveryReport['abandoned']> = [];
  for (const row of log.listRecoveryRequiredCommits()) {
    if (
      !options.healCleanConflictOperations?.has(row.operation) ||
      row.hasReceipt ||
      row.fileCount !== 1 ||
      !isCleanConflictEvidence(row.diagnostics)
    )
      continue;
    log.abandonRecoveryRequiredCommit(row.commitId);
    const entry = { commitId: row.commitId, operation: row.operation };
    options.onAbandoned?.(entry);
    if (abandoned.length < CORE_WORKSPACE_RECORDS_LIMITS.evidenceRows)
      abandoned.push(entry);
  }
  log.compact();
  const recoveryRequiredReservations = log
    .listReservations()
    .filter((reservation) => reservation.state === 'recovery-required')
    .map((reservation) => reservation.reservationId);
  return {
    applied,
    ...(abandoned.length ? { abandoned } : {}),
    // Every commit still waiting, including those an earlier launch found.
    recoveryRequired: log.listRecoveryRequiredCommitIds(),
    interruptedReservations,
    ...(recoveryRequiredReservations.length === 0
      ? {}
      : { recoveryRequiredReservations }),
  };
}
