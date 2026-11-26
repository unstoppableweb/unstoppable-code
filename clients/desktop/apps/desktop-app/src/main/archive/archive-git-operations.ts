import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type {
  ArchivedContainerDiskUsage,
  ArchivedGitChangesSummary,
  ArchivedGitRepositoryState,
  ArchivedPullRequestCapture,
} from '@canopy/desktop-shared/types';
import { archivedGitStateVersion } from '@canopy/desktop-shared/lib/archived-container-contracts';
import { killProcessGroupByPid } from '@canopy/execution-engine/node/lib/process-kill';
import type { Stats } from 'node:fs';
import { assertArchiveWorktreeRemoval } from '../lib/archive-worktree-postconditions';
import { renameArchiveQuarantine } from '../lib/archive-quarantine';
import { isPathInside } from '../lib/path-safety';
import { isErrnoException } from '../lib/type-guards';
import { mapWithConcurrency } from '../lib/concurrency';
import { getWorktreeDeleteTimeoutMs } from '../lib/worktree-delete-config';
import { removeWindowsWorktreeReparsePoints } from '../lib/windows-worktree-reparse-points';
import {
  isRegistrationCleanupLock,
  removeAbsentWorktreeRegistrations,
} from '../lib/worktree-registration-removal';
import {
  measureDirectoryBytes,
  removeArchiveTree,
} from './archive-file-operations';
import {
  assertWorktreeSnapshotSupported,
  captureHeadCommitSha,
  captureIndexTreeSha,
  captureWorkingTreeSha,
  createSnapshotCommit,
  setGitTreeSnapshotRuntime,
} from '../lib/git-tree-snapshot';
import { isWorktreeSnapshotRefusalError } from '../lib/worktree-snapshot-refusal';
import type {
  ArchiveGitCaptureRepositoryInput,
  ArchiveGitCommandEnvironment,
} from './archive-io-protocol';
import { ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE } from './archive-io-protocol';

const GIT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const CAPTURE_CONCURRENCY = 2;

export interface ArchiveChildObserver {
  started(pid: number): void;
  exited(pid: number, code: number | null, signal: NodeJS.Signals | null): void;
}

export class ArchiveGitCommandError extends Error {
  public constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly timedOut = false,
  ) {
    super(message);
    this.name = 'ArchiveGitCommandError';
  }
}

export class ArchiveGitRecoveryRequiredError extends Error {
  public readonly code = ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE;

  public constructor(message: string) {
    super(message);
    this.name = 'ArchiveGitRecoveryRequiredError';
  }
}

class ArchiveGitCaptureRollbackError extends Error {
  public constructor(public readonly errors: readonly Error[]) {
    super(
      'Archive Git capture failed and snapshot refs could not be fully rolled back.',
    );
    this.name = 'ArchiveGitCaptureRollbackError';
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function canonicalizeMissingPath(path: string): Promise<string> {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (true) {
    try {
      return resolve(await realpath(ancestor), relative(ancestor, absolute));
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
      // A dangling symlink is an existing path with an unresolvable target.
      // Do not treat its lexical parent as authority for the target.
      try {
        await lstat(ancestor);
      } catch (statError) {
        if (!isErrnoException(statError) || statError.code !== 'ENOENT') {
          throw statError;
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
        continue;
      }
      throw error;
    }
  }
}

function quarantineIdentity(stats: {
  dev: number;
  ino: number;
  birthtimeMs: number;
}): { dev: number; ino: number; birthtimeMs: number } {
  return {
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  };
}

export async function runArchiveGit(args: {
  git: ArchiveGitCommandEnvironment;
  cwd: string;
  arguments: readonly string[];
  signal: AbortSignal;
  child: ArchiveChildObserver;
  timeoutMs?: number;
  preserveWhitespace?: boolean;
}): Promise<string> {
  if (args.signal.aborted) throw new Error('Archive I/O request cancelled.');
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(args.git.executable, [...args.arguments], {
      cwd: args.cwd,
      env: { ...args.git.env, LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1' },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let spawned = false;
    let timedOut = false;
    let processError: Error | undefined;
    const finish = (error?: Error, output?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      args.signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolvePromise(output ?? '');
    };
    const stop = (): void => {
      if (child.pid) {
        void killProcessGroupByPid(child.pid, 'SIGKILL').catch(() => undefined);
      } else {
        child.kill('SIGKILL');
      }
    };
    const abort = (): void => {
      stop();
    };
    args.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, args.timeoutMs ?? GIT_TIMEOUT_MS);
    timeout.unref?.();
    child.once('spawn', () => {
      spawned = true;
      if (child.pid) args.child.started(child.pid);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length + stderr.length > GIT_OUTPUT_LIMIT) stop();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stdout.length + stderr.length > GIT_OUTPUT_LIMIT) stop();
    });
    child.once('error', (error) => {
      if (!spawned) finish(error);
      else {
        processError = error;
        stop();
      }
    });
    child.once('close', (code, signal) => {
      if (spawned && child.pid) args.child.exited(child.pid, code, signal);
      if (processError) {
        finish(processError);
      } else if (args.signal.aborted) {
        finish(new Error('Archive I/O request cancelled.'));
      } else if (stdout.length + stderr.length > GIT_OUTPUT_LIMIT) {
        finish(new Error('Archive Git output exceeded its limit.'));
      } else if (code !== 0) {
        finish(
          new ArchiveGitCommandError(
            timedOut
              ? 'Archive Git command timed out.'
              : stderr.toString('utf8').trim() ||
                  `Archive Git command exited with code ${String(code)}.`,
            code,
            timedOut,
          ),
        );
      } else {
        const output = stdout.toString('utf8');
        finish(undefined, args.preserveWhitespace ? output : output.trim());
      }
    });
  });
}

async function writeJsonDurably(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function completeArchiveGitCapture(args: {
  stagedDescriptorPath: string;
  repositories: readonly ArchivedGitRepositoryState[];
  gitChanges: ArchivedGitChangesSummary;
  pullRequestMetadata: ArchivedPullRequestCapture;
}): Promise<void> {
  await writeJsonDurably(args.stagedDescriptorPath, {
    version: archivedGitStateVersion(args.repositories),
    status: 'ready',
    repositories: args.repositories,
    gitChanges: args.gitChanges,
    pullRequestMetadata: args.pullRequestMetadata,
  });
}

function parseShortstat(output: string): {
  fileCount: number;
  insertions: number;
  deletions: number;
} {
  if (!output.trim()) return { fileCount: 0, insertions: 0, deletions: 0 };
  const fileCount = /([0-9]+) files? changed/.exec(output)?.[1];
  const insertions = /([0-9]+) insertions?\(\+\)/.exec(output)?.[1];
  const deletions = /([0-9]+) deletions?\(-\)/.exec(output)?.[1];
  if (!fileCount) throw new Error(`Unable to parse Git shortstat: ${output}`);
  return {
    fileCount: Number.parseInt(fileCount, 10),
    insertions: insertions ? Number.parseInt(insertions, 10) : 0,
    deletions: deletions ? Number.parseInt(deletions, 10) : 0,
  };
}

async function repairRegisteredWorktreePointer(args: {
  git: ArchiveGitCommandEnvironment;
  referenceRepoPath: string;
  worktreeRepoPath: string;
  signal: AbortSignal;
  child: ArchiveChildObserver;
}): Promise<void> {
  const expectedCommonDir = await realpath(
    await runArchiveGit({
      ...args,
      cwd: args.referenceRepoPath,
      arguments: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    }),
  );
  const readCommonDir = async (): Promise<string> =>
    realpath(
      await runArchiveGit({
        ...args,
        cwd: args.worktreeRepoPath,
        arguments: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      }),
    );
  let pointerExists = false;
  let linkedPointer = false;
  try {
    const pointer = await lstat(join(args.worktreeRepoPath, '.git'));
    if (pointer.isSymbolicLink()) {
      throw new Error('Worktree Git metadata is a symbolic link.');
    }
    pointerExists = true;
    linkedPointer = pointer.isFile();
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
  if (pointerExists) {
    const currentCommonDir = await readCommonDir().catch(() => null);
    if (currentCommonDir === expectedCommonDir) {
      if (linkedPointer) {
        const privateGitDir = await runArchiveGit({
          ...args,
          cwd: args.worktreeRepoPath,
          arguments: ['rev-parse', '--absolute-git-dir'],
        });
        const registeredPointer = (
          await readFile(join(privateGitDir, 'gitdir'), 'utf8')
        ).trim();
        if (
          (await realpath(registeredPointer)) !==
          (await realpath(join(args.worktreeRepoPath, '.git')))
        ) {
          throw new Error(
            'The Git pointer belongs to another worktree; its private index was preserved.',
          );
        }
      }
      return;
    }
    if (currentCommonDir !== null) {
      throw new Error('The worktree belongs to a different Git repository.');
    }
  }
  const registered = (
    await runArchiveGit({
      ...args,
      cwd: args.referenceRepoPath,
      arguments: ['worktree', 'list', '--porcelain', '-z'],
    })
  )
    .split('\0')
    .filter((field) => field.startsWith('worktree '));
  const targetPath = await realpath(args.worktreeRepoPath);
  let matches = 0;
  for (const entry of registered) {
    const registeredPath = await realpath(
      entry.slice('worktree '.length),
    ).catch(() => null);
    if (registeredPath === targetPath) matches += 1;
  }
  if (matches !== 1) {
    const pointerText = linkedPointer
      ? await readFile(join(args.worktreeRepoPath, '.git'), 'utf8').catch(
          () => null,
        )
      : null;
    const privateDirFromPointer = /^gitdir:\s*(.+)\s*$/m.exec(
      pointerText ?? '',
    )?.[1];
    const privateGitDir = privateDirFromPointer
      ? resolve(args.worktreeRepoPath, privateDirFromPointer.trim())
      : null;
    const missingSourceOwnedMetadata =
      privateGitDir !== null &&
      !(await exists(privateGitDir)) &&
      isPathInside(
        await canonicalizeMissingPath(join(expectedCommonDir, 'worktrees')),
        await canonicalizeMissingPath(privateGitDir),
      );
    const message =
      'The damaged worktree has no unique Git registration; its files were preserved.';
    throw missingSourceOwnedMetadata
      ? new ArchiveGitRecoveryRequiredError(message)
      : new Error(message);
  }
  await runArchiveGit({
    ...args,
    cwd: args.referenceRepoPath,
    arguments: ['worktree', 'repair', args.worktreeRepoPath],
  }).catch(() => undefined);
  if ((await readCommonDir()) !== expectedCommonDir) {
    throw new Error(
      'Git worktree repair did not restore the expected repository.',
    );
  }
}

export async function captureArchiveGit(args: {
  git: ArchiveGitCommandEnvironment;
  stagedDescriptorPath: string;
  repositories: readonly ArchiveGitCaptureRepositoryInput[];
  signal: AbortSignal;
  child: ArchiveChildObserver;
  onProgress?: (stage: string) => void;
}): Promise<{
  repositories: ArchivedGitRepositoryState[];
  gitChanges: ArchivedGitChangesSummary;
}> {
  setGitTreeSnapshotRuntime({
    resolveExecutable: () => Promise.resolve(args.git.executable),
    environment: () => args.git.env,
    signal: args.signal,
    detached: process.platform !== 'win32',
    childStarted: (pid) => args.child.started(pid),
    childExited: (pid, code, signal) => args.child.exited(pid, code, signal),
    terminateChild: (pid) => killProcessGroupByPid(pid, 'SIGKILL'),
  });
  const captured: ArchivedGitRepositoryState[] = [];
  const pinned = new Map<
    string,
    { referenceRepoPath: string; snapshotCommit: string }
  >();
  const captureErrors: Error[] = [];
  await writeJsonDurably(args.stagedDescriptorPath, {
    version: archivedGitStateVersion(captured),
    status: 'capturing',
    repositories: captured,
  });
  let publication = Promise.resolve();
  await mapWithConcurrency(
    args.repositories,
    CAPTURE_CONCURRENCY,
    async (input): Promise<void> => {
      try {
        if (args.signal.aborted)
          throw new Error('Archive I/O request cancelled.');
        await repairRegisteredWorktreePointer({
          git: args.git,
          referenceRepoPath: input.referenceRepoPath,
          worktreeRepoPath: input.worktreeRepoPath,
          signal: args.signal,
          child: args.child,
        });
        const { attributePolicy, attributes } =
          await assertWorktreeSnapshotSupported(
            input.worktreeRepoPath,
            'negotiate',
          );
        const headCommit = await captureHeadCommitSha(input.worktreeRepoPath);
        if (!headCommit) {
          throw new Error(`Repository ${input.repoName} has no HEAD commit.`);
        }
        const [headTree, indexTree] = await Promise.all([
          runArchiveGit({
            ...args,
            cwd: input.worktreeRepoPath,
            arguments: ['rev-parse', `${headCommit}^{tree}`],
          }),
          captureIndexTreeSha(input.worktreeRepoPath, attributes),
        ]);
        const indexSnapshotCommit =
          indexTree === headTree
            ? headCommit
            : await createSnapshotCommit({
                repoPath: input.worktreeRepoPath,
                treeSha: indexTree,
                parentCommit: headCommit,
                message: 'Archived index snapshot',
              });
        // Under an attribute source this pins decrypted git-crypt bytes under
        // refs/app/archived-containers. Accepted by the owner (CAN-6776 q-4):
        // the plaintext is already in the checkout and Canopy never pushes
        // those refs; the acceptance also covers anyone who can read the
        // source repository's local object store after the worktree is gone.
        // Revisit if it starts publishing them or sharing that repository.
        const workingTree = await captureWorkingTreeSha(
          input.worktreeRepoPath,
          attributes,
        );
        const worktreeSnapshotCommit =
          workingTree === indexTree
            ? indexSnapshotCommit
            : await createSnapshotCommit({
                repoPath: input.worktreeRepoPath,
                treeSha: workingTree,
                parentCommit: indexSnapshotCommit,
                message: 'Archived working tree snapshot',
              });
        const branchRef = await runArchiveGit({
          ...args,
          cwd: input.worktreeRepoPath,
          arguments: ['symbolic-ref', '--quiet', 'HEAD'],
          preserveWhitespace: true,
        }).catch((error: unknown) => {
          if (error instanceof ArchiveGitCommandError && error.exitCode === 1)
            return undefined;
          throw error;
        });
        const branchName = branchRef?.startsWith('refs/heads/')
          ? branchRef.slice('refs/heads/'.length).replace(/\r?\n$/, '')
          : undefined;
        let comparisonBaseCommit = input.comparisonBaseCommit || headCommit;
        let baseBranchCommit = input.baseBranchCommit;
        for (const candidate of input.comparisonBaseRefs ?? []) {
          try {
            baseBranchCommit = await runArchiveGit({
              ...args,
              cwd: input.worktreeRepoPath,
              arguments: ['rev-parse', '--verify', `${candidate}^{commit}`],
            });
            comparisonBaseCommit = await runArchiveGit({
              ...args,
              cwd: input.worktreeRepoPath,
              arguments: ['merge-base', headCommit, candidate],
            });
            break;
          } catch {
            baseBranchCommit = undefined;
          }
        }
        await runArchiveGit({
          ...args,
          cwd: input.referenceRepoPath,
          arguments: ['update-ref', input.snapshotRef, worktreeSnapshotCommit],
        });
        pinned.set(input.snapshotRef, {
          referenceRepoPath: input.referenceRepoPath,
          snapshotCommit: worktreeSnapshotCommit,
        });
        const repository: ArchivedGitRepositoryState = {
          repoId: input.repoId,
          repoName: input.repoName,
          relativePath: input.relativePath,
          referenceRepoPath: input.referenceRepoPath,
          ...(branchName ? { branchName } : {}),
          ...(input.comparisonBaseBranch
            ? { comparisonBaseBranch: input.comparisonBaseBranch }
            : {}),
          ...(baseBranchCommit ? { baseBranchCommit } : {}),
          comparisonBaseCommit,
          headCommit,
          indexSnapshotCommit,
          worktreeSnapshotCommit,
          snapshotRef: input.snapshotRef,
          ...(attributePolicy ? { attributePolicy } : {}),
        };
        publication = publication.then(async () => {
          captured.push(repository);
          captured.sort((left, right) =>
            left.repoId.localeCompare(right.repoId),
          );
          await writeJsonDurably(args.stagedDescriptorPath, {
            version: archivedGitStateVersion(captured),
            status: 'capturing',
            repositories: captured,
          });
          args.onProgress?.('repository-captured');
        });
        await publication;
      } catch (error) {
        captureErrors.push(normalizeError(error));
      }
    },
  );
  if (captureErrors.length > 0) {
    const rollbackResults = await Promise.allSettled(
      Array.from(pinned.entries(), ([snapshotRef, pinnedRef]) =>
        runArchiveGit({
          ...args,
          cwd: pinnedRef.referenceRepoPath,
          arguments: [
            'update-ref',
            '-d',
            snapshotRef,
            pinnedRef.snapshotCommit,
          ],
        }),
      ),
    );
    const rollbackErrors = rollbackResults.flatMap((result) =>
      result.status === 'rejected' ? [normalizeError(result.reason)] : [],
    );
    if (rollbackErrors.length > 0) {
      throw new ArchiveGitCaptureRollbackError([
        ...captureErrors,
        ...rollbackErrors,
      ]);
    }
    // A files-only recovery may follow only when every repository failed in
    // a way it covers. Any other failure wins, so a refusal in one repository
    // never masks a raw Git failure in another.
    throw (
      captureErrors.find(
        (error) =>
          !(error instanceof ArchiveGitRecoveryRequiredError) &&
          !isWorktreeSnapshotRefusalError(error),
      ) ??
      captureErrors.find(isWorktreeSnapshotRefusalError) ??
      captureErrors[0]
    );
  }
  const capturedAt = new Date().toISOString();
  try {
    const summaries = await mapWithConcurrency(
      captured,
      CAPTURE_CONCURRENCY,
      async (repository) => {
        const output = await runArchiveGit({
          ...args,
          cwd: repository.referenceRepoPath,
          arguments: [
            'diff',
            '--shortstat',
            '--find-renames',
            '--find-copies',
            '--no-ext-diff',
            '--no-textconv',
            repository.comparisonBaseCommit,
            repository.worktreeSnapshotCommit,
          ],
        });
        return {
          repoId: repository.repoId,
          repoName: repository.repoName,
          ...parseShortstat(output),
        };
      },
    );
    return {
      repositories: captured,
      gitChanges: {
        status: 'complete',
        capturedAt,
        fileCount: summaries.reduce((sum, value) => sum + value.fileCount, 0),
        insertions: summaries.reduce((sum, value) => sum + value.insertions, 0),
        deletions: summaries.reduce((sum, value) => sum + value.deletions, 0),
        repositories: summaries,
      },
    };
  } catch {
    return {
      repositories: captured,
      gitChanges: { status: 'unavailable', capturedAt },
    };
  }
}

export async function prepareArchiveTeardown(args: {
  canonicalPath: string;
  quarantinePath: string;
  expectedCanonicalRealPath?: string;
  signal: AbortSignal;
  child: ArchiveChildObserver;
}): Promise<{
  canonicalPath: string;
  quarantinePath: string;
  alreadyRemoved: boolean;
  quarantineIdentity?: { dev: number; ino: number; birthtimeMs: number };
}> {
  const original = await lstat(args.canonicalPath).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!original) {
    const quarantine = await lstat(args.quarantinePath).catch(
      (error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (quarantine?.isSymbolicLink()) {
      throw new Error('Archive teardown quarantine is a symbolic link.');
    }
    return {
      canonicalPath: args.canonicalPath,
      quarantinePath: args.quarantinePath,
      alreadyRemoved: !quarantine,
      ...(quarantine
        ? { quarantineIdentity: quarantineIdentity(quarantine) }
        : {}),
    };
  }
  if (original.isSymbolicLink()) {
    throw new Error('Archive teardown target is a symbolic link.');
  }
  if (await exists(args.quarantinePath)) {
    throw new Error('Archive teardown quarantine already exists.');
  }
  if (args.expectedCanonicalRealPath) {
    const actual = await realpath(args.canonicalPath);
    if (resolve(actual) !== resolve(args.expectedCanonicalRealPath)) {
      throw new Error('Archive teardown target identity changed.');
    }
  }
  const movedIdentity = await renameArchiveQuarantine(
    args.canonicalPath,
    args.quarantinePath,
  );
  return {
    canonicalPath: args.canonicalPath,
    quarantinePath: args.quarantinePath,
    alreadyRemoved: false,
    quarantineIdentity: movedIdentity,
  };
}

export async function removeArchiveWorktree(args: {
  git: ArchiveGitCommandEnvironment;
  referenceRepoPath: string;
  expectedRepositoryIdentity: string;
  worktreePath: string;
  preMoveWorktreePath?: string;
  signal: AbortSignal;
  child: ArchiveChildObserver;
}): Promise<void> {
  const repositoryIdentity = resolve(
    await runArchiveGit({
      ...args,
      cwd: args.referenceRepoPath,
      arguments: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    }),
  );
  if (repositoryIdentity !== resolve(args.expectedRepositoryIdentity)) {
    throw new Error('Archive worktree repository identity changed.');
  }
  const registered = await runArchiveGit({
    ...args,
    cwd: args.referenceRepoPath,
    arguments: ['worktree', 'list', '--porcelain', '-z'],
  });
  const expectedPath = await realpath(args.worktreePath).catch(() =>
    resolve(args.worktreePath),
  );
  let isRegistered = false;
  const records = registered.split('\0\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const fields = record.split('\0');
    const pathField = fields.find((field) => field.startsWith('worktree '));
    if (!pathField) continue;
    const candidate = pathField.slice('worktree '.length);
    const candidatePath = await realpath(candidate).catch(() =>
      resolve(candidate),
    );
    if (candidatePath === expectedPath) {
      // Preserve Git's protections before delegating bulk deletion to the
      // filesystem worker. --force alone does not authorize either case.
      if (index === 0 || fields.includes('bare')) {
        throw new Error('Archive removal cannot target the main worktree.');
      }
      const lock = fields.find(
        (field) => field === 'locked' || field.startsWith('locked '),
      );
      if (lock !== undefined) {
        // An interrupted registration cleanup's lock: it removes the entry.
        if (
          isRegistrationCleanupLock(lock.slice('locked '.length)) &&
          !(await exists(args.worktreePath))
        )
          break;
        throw new Error('Archive removal cannot target a locked worktree.');
      }
      isRegistered = true;
      break;
    }
  }
  if (isRegistered) {
    const administration = await clearArchiveWorktreeContents(
      args.worktreePath,
      repositoryIdentity,
      args.signal,
      args,
    );
    try {
      await runArchiveGit({
        ...args,
        cwd: args.referenceRepoPath,
        arguments: ['worktree', 'remove', '--force', '--', args.worktreePath],
        timeoutMs: getWorktreeDeleteTimeoutMs(args.git.env),
      });
    } catch (error) {
      try {
        if (!administration || !(error instanceof ArchiveGitCommandError))
          throw error;
        await reconcileArchiveGitRemoval(args, administration);
      } catch {
        if (args.signal.aborted)
          throw new Error('Archive I/O request cancelled.');
        // Keep Git's error primary, including when a later filesystem race
        // leaves partial metadata cleanup. There is no rollback guarantee.
        throw error;
      }
    }
  }
  await removeAbsentWorktreeRegistrations(
    repositoryIdentity,
    args.preMoveWorktreePath === undefined
      ? [args.worktreePath]
      : [args.worktreePath, args.preMoveWorktreePath],
    { signal: args.signal },
  );
}

interface ArchiveWorktreeAdministration {
  path: string;
  identity: Stats;
}

// CAN-5717: observed after Git's partial removal; the writer is unconfirmed.
// Only this regular metadata file is disposable under this local policy.
const DISPOSABLE_ARCHIVE_GIT_METADATA = '.DS_Store';

async function reconcileArchiveGitRemoval(
  args: Parameters<typeof removeArchiveWorktree>[0],
  administration: ArchiveWorktreeAdministration,
): Promise<void> {
  const assertNotCancelled = (): void => {
    if (args.signal.aborted) throw new Error('Archive I/O request cancelled.');
  };
  assertNotCancelled();
  await assertArchiveWorktreeRemoval(
    args.preMoveWorktreePath === undefined
      ? [args.worktreePath]
      : [args.worktreePath, args.preMoveWorktreePath],
    await runArchiveGit({
      ...args,
      cwd: args.referenceRepoPath,
      arguments: ['worktree', 'list', '--porcelain', '-z'],
    }),
  );
  const assertIdentity = async (): Promise<Stats | null> => {
    assertNotCancelled();
    const actual = await lstat(administration.path).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return null;
      throw error;
    });
    if (
      actual &&
      (!actual.isDirectory() ||
        actual.isSymbolicLink() ||
        actual.dev !== administration.identity.dev ||
        actual.ino !== administration.identity.ino ||
        actual.birthtimeMs !== administration.identity.birthtimeMs)
    ) {
      throw new Error('Archive Git administration identity changed.');
    }
    return actual;
  };
  if (!(await assertIdentity())) {
    assertNotCancelled();
    return;
  }
  const validateEntries = async (): Promise<string[]> => {
    const entries = await readdir(administration.path);
    for (const entry of entries) {
      if (
        entry !== DISPOSABLE_ARCHIVE_GIT_METADATA ||
        !(await lstat(join(administration.path, entry))).isFile()
      ) {
        throw new Error('Archive Git administration contains unexpected data.');
      }
    }
    return entries;
  };
  // Validate everything before mutating anything, then recheck immediately
  // before each unlink/rmdir. Node has no directory-handle-relative unlinkat
  // or rmdir API: replacement between the last check and mutation remains a
  // path-based race. Never use recursive removal to widen this policy.
  const entries = await validateEntries();
  for (const entry of entries) {
    await validateEntries();
    if (!(await assertIdentity()))
      throw new Error('Archive Git administration disappeared.');
    const path = join(administration.path, entry);
    if (!(await lstat(path)).isFile())
      throw new Error('Archive Git metadata changed.');
    assertNotCancelled();
    await unlink(path);
  }
  if ((await validateEntries()).length !== 0)
    throw new Error('Archive Git administration changed.');
  if (!(await assertIdentity()))
    throw new Error('Archive Git administration disappeared.');
  assertNotCancelled();
  await rmdir(administration.path);
  assertNotCancelled();
}

/**
 * The archive facade has already verified the snapshots and quarantined this
 * checkout under its removal lock. Git's recursive unlink loop can exhaust the
 * command deadline on dependency/build trees, leaving a partial checkout. Do
 * that bulk I/O asynchronously in this worker, outside the Git command budget.
 * Keep the root and Git pointer intact until Git unregisters the empty checkout,
 * so interruption remains resumable through the existing quarantine journal.
 */
async function clearArchiveWorktreeContents(
  worktreePath: string,
  repositoryIdentity: string,
  signal: AbortSignal,
  gitArgs: Pick<
    Parameters<typeof runArchiveGit>[0],
    'git' | 'signal' | 'child'
  >,
): Promise<ArchiveWorktreeAdministration | null> {
  const original = await lstat(worktreePath).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!original) return null;
  if (!original.isDirectory() || original.isSymbolicLink()) {
    throw new Error('Archive worktree removal target must be a directory.');
  }
  const assertUnchanged = async (): Promise<void> => {
    if (signal.aborted) throw new Error('Archive I/O request cancelled.');
    const current = await lstat(worktreePath);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      current.birthtimeMs !== original.birthtimeMs
    ) {
      throw new Error('Archive worktree removal target identity changed.');
    }
  };
  const gitPointer = await lstat(join(worktreePath, '.git')).catch(
    (error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (!gitPointer?.isFile()) {
    throw new Error('Archive worktree Git pointer must be a regular file.');
  }
  const pointer = await readFile(join(worktreePath, '.git'), 'utf8');
  if (!pointer.startsWith('gitdir: ')) {
    throw new Error('Archive worktree Git pointer is invalid.');
  }
  const gitDirectory = await realpath(
    resolve(worktreePath, pointer.slice('gitdir: '.length).trim()),
  );
  const commonDirectory = await realpath(
    resolve(
      gitDirectory,
      (await readFile(join(gitDirectory, 'commondir'), 'utf8')).trim(),
    ),
  );
  const backPointer = await realpath(
    resolve(
      gitDirectory,
      (await readFile(join(gitDirectory, 'gitdir'), 'utf8')).trim(),
    ),
  );
  if (
    commonDirectory !== (await realpath(repositoryIdentity)) ||
    backPointer !== (await realpath(join(worktreePath, '.git')))
  ) {
    throw new Error('Archive worktree Git pointer identity changed.');
  }
  const administrationIdentity = await lstat(gitDirectory);
  if (
    !administrationIdentity.isDirectory() ||
    administrationIdentity.isSymbolicLink() ||
    dirname(gitDirectory) !==
      (await realpath(join(commonDirectory, 'worktrees')))
  ) {
    throw new Error(
      'Archive Git administration is outside the repository worktree area.',
    );
  }
  let pointerEntry: string | undefined;
  for (const entry of await readdir(worktreePath)) {
    const entryStat = await lstat(join(worktreePath, entry));
    if (
      entryStat.dev === gitPointer.dev &&
      entryStat.ino === gitPointer.ino &&
      entryStat.birthtimeMs === gitPointer.birthtimeMs
    ) {
      if (pointerEntry !== undefined) {
        throw new Error('Archive worktree Git pointer is ambiguous.');
      }
      pointerEntry = entry;
    }
  }
  if (pointerEntry === undefined) {
    throw new Error('Archive worktree Git pointer identity changed.');
  }
  // Git normally refuses removal of a populated submodule. Do not erase its
  // ignored files first and accidentally bypass that protection.
  const index = await runArchiveGit({
    ...gitArgs,
    cwd: worktreePath,
    arguments: ['ls-files', '--stage', '-z'],
  });
  for (const record of index.split('\0')) {
    if (!record.startsWith('160000 ')) continue;
    const separator = record.indexOf('\t');
    if (separator < 0) continue;
    const submodulePath = join(worktreePath, record.slice(separator + 1));
    const submodule = await lstat(submodulePath).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return null;
      throw error;
    });
    if (submodule?.isDirectory() && (await readdir(submodulePath)).length > 0) {
      throw new Error('Archive worktree contains a populated submodule.');
    }
  }
  await assertUnchanged();
  await removeWindowsWorktreeReparsePoints(worktreePath);
  for (const entry of await readdir(worktreePath)) {
    if (entry === pointerEntry) continue;
    await assertUnchanged();
    // rm removes symlink entries themselves, never their external targets.
    // Await each entry so failures/cancellation cannot release the lifecycle
    // lock while sibling removals are still running.
    await removeArchiveTree(
      join(worktreePath, entry),
      worktreePath,
      assertUnchanged,
      { maxRetries: process.platform === 'win32' ? 50 : 2 },
    );
  }
  await assertUnchanged();
  const finalEntries = await readdir(worktreePath);
  const finalPointer = await lstat(join(worktreePath, pointerEntry));
  if (
    finalEntries.length !== 1 ||
    finalEntries[0] !== pointerEntry ||
    finalPointer.dev !== gitPointer.dev ||
    finalPointer.ino !== gitPointer.ino ||
    finalPointer.birthtimeMs !== gitPointer.birthtimeMs
  ) {
    throw new Error('Archive worktree contents changed during removal.');
  }
  return { path: gitDirectory, identity: administrationIdentity };
}

export async function deleteArchiveBranches(args: {
  git: ArchiveGitCommandEnvironment;
  branches: readonly {
    referenceRepoPath: string;
    expectedRepositoryIdentity: string;
    branchName: string;
    expectedTip: string;
    mode: 'force' | 'merged-only';
  }[];
  signal: AbortSignal;
  child: ArchiveChildObserver;
}): Promise<number> {
  let deleted = 0;
  for (const branch of args.branches) {
    const repositoryIdentity = resolve(
      await runArchiveGit({
        ...args,
        cwd: branch.referenceRepoPath,
        arguments: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      }),
    );
    if (repositoryIdentity !== resolve(branch.expectedRepositoryIdentity)) {
      throw new Error('Archive branch repository identity changed.');
    }
    const ref = `refs/heads/${branch.branchName}`;
    const actual = await runArchiveGit({
      ...args,
      cwd: branch.referenceRepoPath,
      arguments: ['rev-parse', '--verify', ref],
    }).catch(() => null);
    if (actual === null) continue;
    if (actual !== branch.expectedTip) {
      throw new Error(`Archive branch ${branch.branchName} changed.`);
    }
    const worktrees = await runArchiveGit({
      ...args,
      cwd: branch.referenceRepoPath,
      arguments: ['worktree', 'list', '--porcelain', '-z'],
    });
    let worktreePath: string | null = null;
    for (const field of worktrees.split('\0')) {
      if (field.startsWith('worktree ')) {
        worktreePath = field.slice('worktree '.length);
      } else if (field === `branch ${ref}` && worktreePath) {
        throw new Error(
          `Cannot delete branch "${branch.branchName}" because it is checked out at ${worktreePath}`,
        );
      } else if (field === '') {
        worktreePath = null;
      }
    }
    if (branch.mode === 'merged-only') {
      try {
        await runArchiveGit({
          ...args,
          cwd: branch.referenceRepoPath,
          arguments: [
            'merge-base',
            '--is-ancestor',
            branch.expectedTip,
            'HEAD',
          ],
        });
      } catch (error) {
        if (error instanceof ArchiveGitCommandError && error.exitCode === 1) {
          continue;
        }
        throw error;
      }
    }
    await runArchiveGit({
      ...args,
      cwd: branch.referenceRepoPath,
      arguments: ['update-ref', '-d', ref, branch.expectedTip],
    });
    deleted += 1;
  }
  return deleted;
}

export async function measureArchiveDiskUsage(args: {
  git: ArchiveGitCommandEnvironment;
  containerDirectory: string;
  repositories: readonly ArchivedGitRepositoryState[];
  computedAt: string;
  signal: AbortSignal;
  child: ArchiveChildObserver;
}): Promise<ArchivedContainerDiskUsage> {
  const filesBytes = await measureDirectoryBytes(args.containerDirectory);
  let gitBytes = 0;
  let gitBytesComplete = true;
  for (const repository of args.repositories) {
    try {
      const output = await runArchiveGit({
        ...args,
        cwd: repository.referenceRepoPath,
        arguments: [
          'rev-list',
          '--disk-usage',
          '--objects',
          repository.worktreeSnapshotCommit,
          '--not',
          repository.comparisonBaseCommit,
        ],
      });
      const bytes = Number.parseInt(output, 10);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error();
      gitBytes += bytes;
    } catch {
      gitBytesComplete = false;
    }
  }
  return {
    filesBytes,
    gitBytes,
    gitBytesComplete,
    totalBytes: filesBytes + gitBytes,
    computedAt: args.computedAt,
  };
}

export async function readArchiveGitDescriptor(path: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return parsed;
}
