import { spawn } from 'node:child_process';
import { withGitRequestContextEnv } from '@canopy/desktop-shared/node/git-request-context';
import {
  copyFile,
  access,
  lstat,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChangedFileInfo } from '@canopy/desktop-shared/types';
import { parseDiffOutput } from './git-diff-parser';
import { isErrnoException } from './type-guards';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 1024 * 1024 * 8;
const ARCHIVE_DIFF_TIMEOUT_MS = 60_000;
export const ARCHIVE_DIFF_MAX_RECORDS = 50_000;
export const ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE =
  'Archived Git diff was cancelled.';
const INDEX_FLAG_PATH_CHECK_CONCURRENCY = 32;
const GIT_OBJECT_ID_RE = /^[0-9a-f]{40,64}$/;
const BYTE_PRESERVING_GIT_CONFIG = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.eol=lf',
];

export interface GitTreeSnapshotRuntime {
  resolveExecutable(): Promise<string>;
  environment(): NodeJS.ProcessEnv;
  signal?: AbortSignal;
  detached?: boolean;
  childStarted?(pid: number): void;
  childExited?(
    pid: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void;
  terminateChild?(pid: number): Promise<void>;
}

let gitTreeSnapshotRuntime: GitTreeSnapshotRuntime = {
  resolveExecutable: (): Promise<string> =>
    Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
  environment: (): NodeJS.ProcessEnv => process.env,
};

export function setGitTreeSnapshotRuntime(
  runtime?: GitTreeSnapshotRuntime,
): void {
  gitTreeSnapshotRuntime = runtime ?? {
    resolveExecutable: (): Promise<string> =>
      Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
    environment: (): NodeJS.ProcessEnv => process.env,
  };
}

export function archiveGitEnv(
  env: NodeJS.ProcessEnv = gitTreeSnapshotRuntime.environment(),
): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {
    ...env,
    LC_ALL: 'C',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  // A desktop launched from a Git hook/editor may inherit another checkout's
  // discovery or private-index settings. Only our explicit index overrides may
  // select archive input; ambient Git configuration remains otherwise intact.
  for (const name of Object.keys(isolated)) {
    if (
      /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(
        name,
      )
    ) {
      delete isolated[name];
    }
  }
  return isolated;
}

function getBytePreservingGitConfig(): string[] {
  if (process.platform === 'win32') return BYTE_PRESERVING_GIT_CONFIG;
  return [...BYTE_PRESERVING_GIT_CONFIG, '-c', 'core.fileMode=true'];
}

function buildGitEnv(
  indexPath: string,
  repoPath: string,
  gitDir: string,
): NodeJS.ProcessEnv {
  return {
    ...archiveGitEnv(),
    GIT_INDEX_FILE: indexPath,
    GIT_WORK_TREE: repoPath,
    GIT_DIR: gitDir,
  };
}

async function runGitCommand(args: {
  repoPath: string;
  gitArgs: string[];
  env: NodeJS.ProcessEnv;
  input?: string;
  trim?: boolean;
}): Promise<string> {
  const runtime = gitTreeSnapshotRuntime;
  if (runtime.signal?.aborted) {
    throw new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE);
  }
  const executable = await runtime.resolveExecutable();
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(executable, args.gitArgs, {
      cwd: args.repoPath,
      // Whichever runtime is installed, launches carry the active Git
      // request context for diagnostic attribution (CAN-4397).
      env: withGitRequestContextEnv(args.env),
      detached: runtime.detached ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let spawned = false;
    let terminationError: Error | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runtime.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else {
        const value = stdout.toString('utf8');
        resolvePromise(args.trim === false ? value : value.trim());
      }
    };
    const stop = (error: Error): void => {
      terminationError ??= error;
      if (child.pid && runtime.terminateChild) {
        void runtime.terminateChild(child.pid).catch(() => {
          child.kill('SIGKILL');
        });
      } else {
        child.kill('SIGKILL');
      }
    };
    const abort = (): void =>
      stop(new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE));
    const timer = setTimeout(
      () => stop(new Error('Git command timed out.')),
      GIT_TIMEOUT_MS,
    );
    timer.unref?.();
    runtime.signal?.addEventListener('abort', abort, { once: true });
    child.once('spawn', () => {
      spawned = true;
      if (child.pid) runtime.childStarted?.(child.pid);
      if (runtime.signal?.aborted) abort();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length + stderr.length > GIT_MAX_BUFFER) {
        stop(new Error('Git command output exceeded its limit.'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stdout.length + stderr.length > GIT_MAX_BUFFER) {
        stop(new Error('Git command output exceeded its limit.'));
      }
    });
    child.once('error', (error) => {
      if (!spawned) finish(terminationError ?? error);
      else stop(error);
    });
    child.once('close', (code, signal) => {
      if (child.pid) runtime.childExited?.(child.pid, code, signal);
      if (terminationError) {
        finish(terminationError);
      } else if (code !== 0) {
        finish(
          new Error(
            stderr.toString('utf8').trim() ||
              `Git command exited with code ${String(code)}.`,
          ),
        );
      } else {
        finish();
      }
    });
    child.stdin.on('error', (error) => {
      if (!isErrnoException(error) || error.code !== 'EPIPE') stop(error);
    });
    child.stdin.end(args.input);
  });
}

async function runGitWithEnv(
  repoPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return runGitCommand({ repoPath, gitArgs: args, env });
}

async function runGitWithEnvAndInput(
  repoPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input: string,
): Promise<void> {
  await runGitCommand({ repoPath, gitArgs: args, env, input });
}

async function clearWorktreeOnlyIndexFlags(
  repoPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const entries = await runGitWithEnv(repoPath, ['ls-files', '-v', '-z'], env);
  const parsedEntries = entries
    .split('\0')
    .filter(Boolean)
    .map((entry) => ({ status: entry[0], path: entry.slice(2) }));
  const assumeUnchangedPaths = parsedEntries
    .filter(({ status }) => status === status.toLowerCase())
    .map(({ path }) => path);
  const skipWorktreeCandidates = parsedEntries
    .filter(({ status }) => status === 'S' || status === 's')
    .map(({ path }) => path);
  const skipWorktreePaths: string[] = [];
  const absentSkipWorktreePaths: string[] = [];
  for (
    let offset = 0;
    offset < skipWorktreeCandidates.length;
    offset += INDEX_FLAG_PATH_CHECK_CONCURRENCY
  ) {
    const candidates = skipWorktreeCandidates.slice(
      offset,
      offset + INDEX_FLAG_PATH_CHECK_CONCURRENCY,
    );
    const checked = await Promise.all(
      candidates.map(async (path) => {
        try {
          await lstat(join(repoPath, path));
          return { path, exists: true };
        } catch (error) {
          if (
            isErrnoException(error) &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          ) {
            return { path, exists: false };
          }
          throw error;
        }
      }),
    );
    for (const { path, exists } of checked) {
      (exists ? skipWorktreePaths : absentSkipWorktreePaths).push(path);
    }
  }
  for (const [flag, paths] of [
    ['--no-assume-unchanged', assumeUnchangedPaths],
    ['--no-skip-worktree', skipWorktreePaths],
  ] as const) {
    if (paths.length === 0) continue;
    await runGitWithEnvAndInput(
      repoPath,
      ['update-index', flag, '-z', '--stdin'],
      env,
      `${paths.join('\0')}\0`,
    );
  }
  return absentSkipWorktreePaths;
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  return runGitWithEnv(repoPath, args, archiveGitEnv());
}

async function runGitRawText(
  repoPath: string,
  args: string[],
): Promise<string> {
  return runGitCommand({
    repoPath,
    gitArgs: args,
    env: archiveGitEnv(),
    trim: false,
  });
}

async function assertNoTransformingFilters(
  repoPath: string,
  snapshotPaths: string,
): Promise<void> {
  if (snapshotPaths.length === 0) return;

  const transformingAttributes = [
    'filter',
    'text',
    'eol',
    'working-tree-encoding',
    'ident',
    'crlf',
  ];
  // Git repeats each path for all six attributes, including unspecified
  // values. Validate triplets as they arrive instead of buffering a response
  // that can be many times larger than the path list.
  let field = 0;
  let relativePath = '';
  let attribute = '';
  await streamGitNulTokens({
    repoPath,
    gitArgs: ['check-attr', '-z', '--stdin', ...transformingAttributes],
    input: snapshotPaths,
    operation: 'attribute check',
    timeoutMs: GIT_TIMEOUT_MS,
    onToken(token) {
      if (field === 0) relativePath = token;
      else if (field === 1) attribute = token;
      else if (token !== 'unspecified' && token !== 'unset') {
        const description =
          attribute === 'filter'
            ? 'transforming Git filter'
            : `transforming Git attribute "${attribute}"`;
        throw new Error(
          `Cannot archive a worktree with a ${description}: ${relativePath}`,
        );
      }
      field = (field + 1) % 3;
    },
    validateComplete() {
      if (field !== 0) {
        throw new Error(
          'Archived Git attribute check returned an incomplete record.',
        );
      }
    },
  });
}

async function gitMetadataExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false;
    }
    throw error;
  }
}

async function assertNoNestedGitRepositoriesInTrackedPaths(
  repoPath: string,
  trackedPaths: string,
): Promise<void> {
  const ancestors = new Set<string>();
  for (const relativePath of trackedPaths.split('\0').filter(Boolean)) {
    let parent = dirname(relativePath);
    while (parent !== '.' && parent !== '') {
      ancestors.add(parent);
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }

  for (const relativePath of Array.from(ancestors)) {
    const hasGitMetadata = await gitMetadataExists(
      join(repoPath, relativePath, '.git'),
    );
    if (hasGitMetadata) {
      throw Object.assign(
        new Error(
          `Cannot archive an embedded Git repository containing outer-repository files: ${relativePath}`,
        ),
        { code: 'GIT_CAPTURE_NESTED_REPOSITORY' },
      );
    }
  }
}

async function hasHeadCommit(repoPath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function captureHeadCommitSha(
  repoPath: string,
): Promise<string | undefined> {
  try {
    const sha = await runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** Captures the live index without changing either the index or checkout. */
export async function captureIndexTreeSha(repoPath: string): Promise<string> {
  return runGit(repoPath, ['write-tree']);
}

/**
 * Rejects index/worktree states that cannot be reconstructed exactly by the
 * archive's three-commit snapshot chain.
 */
export async function assertWorktreeSnapshotSupported(
  repoPath: string,
): Promise<void> {
  const [
    unmerged,
    porcelainV1,
    porcelainV2,
    untracked,
    trackedPaths,
    snapshotPaths,
  ] = await Promise.all([
    runGit(repoPath, ['ls-files', '--unmerged', '-z']),
    runGitRawText(repoPath, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=no',
      '--ignore-submodules=none',
    ]),
    runGitRawText(repoPath, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=no',
      '--ignore-submodules=none',
    ]),
    runGitRawText(repoPath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
    runGitRawText(repoPath, ['ls-files', '--cached', '-z']),
    runGitRawText(repoPath, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ]),
  ]);

  if (
    unmerged.length > 0 ||
    porcelainV2.split('\0').some((line) => line.startsWith('u '))
  ) {
    throw Object.assign(
      new Error('Cannot archive a worktree with unresolved conflicts.'),
      { code: 'GIT_CAPTURE_CONFLICTS' },
    );
  }

  const hasIntentToAddV1 = porcelainV1
    .split('\0')
    .some((line) => line.startsWith(' A '));
  const hasIntentToAddV2 = porcelainV2
    .split('\0')
    .some((line) => /^(?:1|2) \.A /.test(line));
  if (hasIntentToAddV1 || hasIntentToAddV2) {
    throw Object.assign(
      new Error(
        'Cannot archive files marked intent-to-add. Stage or unstage them first.',
      ),
      { code: 'GIT_CAPTURE_INTENT_TO_ADD' },
    );
  }

  const hasDirtySubmodule = porcelainV2.split('\0').some((line) => {
    if (!line.startsWith('1 ') && !line.startsWith('2 ')) return false;
    const submodule = line.split(' ', 4)[2];
    return (
      submodule?.startsWith('S') === true &&
      (submodule[2] !== '.' || submodule[3] !== '.')
    );
  });
  if (hasDirtySubmodule) {
    throw Object.assign(
      new Error('Cannot archive a worktree with dirty nested submodules.'),
      { code: 'GIT_CAPTURE_DIRTY_SUBMODULE' },
    );
  }

  for (const relativePath of untracked.split('\0').filter(Boolean)) {
    const untrackedPath = join(repoPath, relativePath);
    const isDirectory = await lstat(untrackedPath)
      .then((info) => info.isDirectory())
      .catch(() => false);
    if (!isDirectory) continue;
    const hasGitMetadata = await gitMetadataExists(join(untrackedPath, '.git'));
    if (hasGitMetadata) {
      throw Object.assign(
        new Error(
          `Cannot archive an untracked nested Git repository: ${relativePath}`,
        ),
        { code: 'GIT_CAPTURE_NESTED_REPOSITORY' },
      );
    }
  }

  await assertNoNestedGitRepositoriesInTrackedPaths(repoPath, trackedPaths);
  await assertNoTransformingFilters(repoPath, snapshotPaths);
}

export async function createSnapshotCommit(args: {
  repoPath: string;
  treeSha: string;
  parentCommit: string;
  message: string;
}): Promise<string> {
  const fixedIdentityEnv: NodeJS.ProcessEnv = {
    ...archiveGitEnv(),
    GIT_AUTHOR_NAME: 'Archived Worktree Snapshot',
    GIT_AUTHOR_EMAIL: 'snapshot@invalid.local',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Archived Worktree Snapshot',
    GIT_COMMITTER_EMAIL: 'snapshot@invalid.local',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  return runGitWithEnv(
    args.repoPath,
    [
      '-c',
      'commit.gpgSign=false',
      'commit-tree',
      args.treeSha,
      '-p',
      args.parentCommit,
      '-m',
      args.message,
    ],
    fixedIdentityEnv,
  );
}

export async function assertGitObject(
  repoPath: string,
  oid: string,
  expectedType: 'blob' | 'tree' | 'commit' | 'tag',
): Promise<void> {
  if (!GIT_OBJECT_ID_RE.test(oid)) {
    throw new Error(`Invalid Git object id: ${oid}`);
  }
  const actualType = await runGit(repoPath, ['cat-file', '-t', oid]).catch(
    () => '',
  );
  if (actualType !== expectedType) {
    throw new Error(
      `Archived Git object ${oid} is missing or is not a ${expectedType}.`,
    );
  }
}

export async function restoreIndexAndWorkingTreeSnapshot(args: {
  repoPath: string;
  headCommit: string;
  indexSnapshotCommit: string;
  worktreeSnapshotCommit: string;
  /**
   * Keep a current HEAD that descends from the archived HEAD and replay only
   * the archived staged/unstaged deltas onto it. Used when restore safely
   * reuses a preserved local branch that has advanced since archive time.
   */
  preserveDescendantHead?: boolean;
}): Promise<void> {
  await Promise.all([
    assertGitObject(args.repoPath, args.headCommit, 'commit'),
    assertGitObject(args.repoPath, args.indexSnapshotCommit, 'commit'),
    assertGitObject(args.repoPath, args.worktreeSnapshotCommit, 'commit'),
  ]);
  if (args.preserveDescendantHead) {
    const currentHead = await runGit(args.repoPath, ['rev-parse', 'HEAD']);
    const mergeBase = await runGit(args.repoPath, [
      'merge-base',
      args.headCommit,
      currentHead,
    ]);
    if (mergeBase !== args.headCommit) {
      throw new Error(
        `Local branch no longer contains archived commit ${args.headCommit.slice(0, 8)}.`,
      );
    }
    if (currentHead !== args.headCommit) {
      let restoredIndexTree = `${currentHead}^{tree}`;
      if (args.indexSnapshotCommit !== args.headCommit) {
        await runGit(args.repoPath, [
          ...getBytePreservingGitConfig(),
          'cherry-pick',
          '--no-commit',
          args.indexSnapshotCommit,
        ]);
        restoredIndexTree = await runGit(args.repoPath, ['write-tree']);
      }
      if (args.worktreeSnapshotCommit !== args.indexSnapshotCommit) {
        await runGit(args.repoPath, [
          ...getBytePreservingGitConfig(),
          'cherry-pick',
          '--no-commit',
          args.worktreeSnapshotCommit,
        ]);
        await runGit(args.repoPath, [
          ...getBytePreservingGitConfig(),
          'read-tree',
          '--reset',
          restoredIndexTree,
        ]);
      }
      return;
    }
  }

  await runGit(args.repoPath, [
    ...getBytePreservingGitConfig(),
    'reset',
    '--hard',
    args.headCommit,
  ]);
  await runGit(args.repoPath, [
    ...getBytePreservingGitConfig(),
    'read-tree',
    '--reset',
    '-u',
    args.worktreeSnapshotCommit,
  ]);
  await runGit(args.repoPath, [
    ...getBytePreservingGitConfig(),
    'read-tree',
    '--reset',
    args.indexSnapshotCommit,
  ]);
}

async function getGitDir(repoPath: string): Promise<string> {
  const gitDir = await runGit(repoPath, ['rev-parse', '--git-dir']);
  return isAbsolute(gitDir) ? gitDir : join(repoPath, gitDir);
}

async function getGitPath(repoPath: string, gitPath: string): Promise<string> {
  const resolvedPath = await runGit(repoPath, [
    'rev-parse',
    '--git-path',
    gitPath,
  ]);
  return isAbsolute(resolvedPath) ? resolvedPath : join(repoPath, resolvedPath);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function cleanupTempIndex(indexPath: string): Promise<void> {
  await Promise.all([
    unlink(indexPath).catch(() => undefined),
    unlink(`${indexPath}.lock`).catch(() => undefined),
  ]);
}

export async function captureWorkingTreeSha(repoPath: string): Promise<string> {
  const indexPath = join(tmpdir(), `canopy-idx-${randomUUID()}`);
  const gitDir = await getGitDir(repoPath);
  const env = buildGitEnv(indexPath, repoPath, gitDir);
  const repoIndexPath = await getGitPath(repoPath, 'index');

  try {
    let absentSkipWorktreePaths: string[] = [];
    if (await pathExists(repoIndexPath)) {
      // Git rehashes entries no older than the index file's own mtime. A copy
      // gets a new mtime, so keep the source's: same-size edits made in the
      // same timestamp tick as its last write would otherwise look clean. Read
      // it before copying, so a concurrent rewrite only makes it older.
      const sourceIndex = await stat(repoIndexPath);
      await copyFile(repoIndexPath, indexPath);
      await utimes(indexPath, sourceIndex.atime, sourceIndex.mtime);
      const unmergedEntries = await runGitWithEnv(
        repoPath,
        ['ls-files', '--unmerged'],
        env,
      );
      if (unmergedEntries.length > 0) {
        // A conflicted index cannot be written as a tree. Seed from HEAD and
        // let add --all collapse the working copy back to stage-zero entries.
        await runGitWithEnv(
          repoPath,
          [...getBytePreservingGitConfig(), 'read-tree', 'HEAD'],
          env,
        );
      } else {
        // Clear only flags that can hide on-disk edits. Rebuilding via
        // write-tree/read-tree would discard the copied index's stat cache and
        // force every snapshot caller to rehash the entire worktree.
        absentSkipWorktreePaths = await clearWorktreeOnlyIndexFlags(
          repoPath,
          env,
        );
        const autocrlf = await runGitWithEnv(
          repoPath,
          ['config', '--default', 'false', '--get', 'core.autocrlf'],
          env,
        );
        if (autocrlf === 'true' || autocrlf === 'input') {
          // A copied stat-clean index may still point at a normalized blob.
          // Re-read its tree with byte-preserving config so the subsequent add
          // must hash the actual working-tree bytes.
          const indexTree = await runGitWithEnv(repoPath, ['write-tree'], env);
          await unlink(indexPath);
          await runGitWithEnv(
            repoPath,
            [...getBytePreservingGitConfig(), 'read-tree', indexTree],
            env,
          );
        }
      }
    } else if (await hasHeadCommit(repoPath)) {
      await runGitWithEnv(
        repoPath,
        [...getBytePreservingGitConfig(), 'read-tree', 'HEAD'],
        env,
      );
    } else {
      await runGitWithEnv(
        repoPath,
        [...getBytePreservingGitConfig(), 'read-tree', '--empty'],
        env,
      );
    }

    await runGitWithEnvAndInput(
      repoPath,
      [
        ...getBytePreservingGitConfig(),
        'add',
        '--all',
        '--sparse',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      env,
      `${[
        '.',
        ...absentSkipWorktreePaths.map((path) => `:(exclude,literal)${path}`),
      ].join('\0')}\0`,
    );
    const treeSha = await runGitWithEnv(repoPath, ['write-tree'], env);
    return treeSha;
  } finally {
    await cleanupTempIndex(indexPath);
  }
}

export async function diffTreeObjects(
  repoPath: string,
  startTree: string,
  endTree: string,
): Promise<ChangedFileInfo[]> {
  const startTreeRef = `${startTree}^{tree}`;
  const endTreeRef = `${endTree}^{tree}`;

  const [statusOutput, numstatOutput] = await Promise.all([
    runGitWithEnv(
      repoPath,
      [
        'diff',
        '--name-status',
        '--find-renames',
        '--find-copies',
        startTreeRef,
        endTreeRef,
      ],
      { ...process.env },
    ),
    runGitWithEnv(
      repoPath,
      [
        'diff',
        '--numstat',
        '--find-renames',
        '--find-copies',
        startTreeRef,
        endTreeRef,
      ],
      { ...process.env },
    ),
  ]);

  return Array.from(parseDiffOutput(statusOutput, numstatOutput).values());
}

export interface StreamingTreeDiffResult {
  files: ChangedFileInfo[];
  totalCount: number;
  truncated: boolean;
}

function parseNumstatCount(value: string): number {
  return value === '-' ? 0 : Number.parseInt(value, 10) || 0;
}

function mapDiffStatus(statusCode: string): ChangedFileInfo['status'] {
  switch (statusCode[0]) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'unmerged';
    case 'T':
      return 'type-changed';
    default:
      return 'unknown';
  }
}

export async function streamGitNulTokens(args: {
  repoPath: string;
  gitArgs: string[];
  timeoutMs: number;
  onToken: (token: string) => void;
  validateComplete?: () => void;
  signal?: AbortSignal;
  input?: string;
  operation?: 'diff' | 'attribute check';
}): Promise<void> {
  const runtime = gitTreeSnapshotRuntime;
  const signals = [args.signal, runtime.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (signals.some((signal) => signal.aborted)) {
    throw new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE);
  }
  const executable = await runtime.resolveExecutable();
  const operation = `Archived Git ${args.operation ?? 'diff'}`;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args.gitArgs, {
      cwd: args.repoPath,
      env: withGitRequestContextEnv(archiveGitEnv()),
      detached: runtime.detached ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    let settled = false;
    let spawned = false;
    let terminationError: Error | undefined;
    let stdinError: Error | undefined;
    let carry = '';
    let stderr = '';
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const signal of signals) {
        signal.removeEventListener('abort', onAbort);
      }
      if (error) reject(error);
      else resolvePromise();
    };
    const terminateAfterClose = (error: Error): void => {
      terminationError ??= error;
      if (child.pid && runtime.terminateChild) {
        void runtime.terminateChild(child.pid).catch(() => {
          child.kill('SIGKILL');
        });
      } else {
        child.kill('SIGKILL');
      }
    };
    const onAbort = (): void => {
      terminateAfterClose(new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE));
    };
    const timer = setTimeout(
      () => {
        terminateAfterClose(new Error(`${operation} timed out.`));
      },
      Math.max(1, args.timeoutMs),
    );
    timer.unref?.();
    for (const signal of signals) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (signals.some((signal) => signal.aborted)) onAbort();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled || terminationError) return;
      try {
        const tokens = `${carry}${chunk}`.split('\0');
        carry = tokens.pop() ?? '';
        for (const token of tokens) args.onToken(token);
      } catch (error) {
        terminateAfterClose(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) {
        stderr += chunk.slice(0, 64 * 1024 - stderr.length);
      }
    });
    child.once('spawn', () => {
      spawned = true;
      if (child.pid) runtime.childStarted?.(child.pid);
    });
    child.on('error', (error) => {
      if (!spawned) {
        finish(terminationError ?? error);
      } else {
        terminationError ??= error;
      }
    });
    child.on('close', (code, signal) => {
      if (child.pid) runtime.childExited?.(child.pid, code, signal);
      if (settled) return;
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code !== 0) {
        finish(
          new Error(
            `${operation} failed (${signal ?? String(code)}): ${stderr.trim()}`,
          ),
        );
        return;
      }
      if (carry.length > 0) {
        finish(new Error(`${operation} returned an incomplete record.`));
        return;
      }
      try {
        args.validateComplete?.();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (stdinError) {
        finish(stdinError);
        return;
      }
      finish();
    });
    // A child can close stdin after emitting malformed output. Defer EPIPE
    // until close so output and completion validation retain precedence. Other
    // stdin failures still terminate the child, but none escape unhandled.
    child.stdin.on('error', (error) => {
      stdinError ??= error;
      if (!isErrnoException(error) || error.code !== 'EPIPE') {
        terminateAfterClose(error);
      }
    });
    child.stdin.end(args.input);
  });
}

/**
 * Streams the immutable tree comparison. Only `maxRecords` rows are retained;
 * the real total continues to be counted without buffering the tail.
 */
export async function streamArchiveTreeDiff(
  repoPath: string,
  startTree: string,
  endTree: string,
  maxRecords = ARCHIVE_DIFF_MAX_RECORDS,
  signal?: AbortSignal,
): Promise<StreamingTreeDiffResult> {
  if (signal?.aborted) {
    throw new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE);
  }
  const deadline = Date.now() + ARCHIVE_DIFF_TIMEOUT_MS;
  const baseArgs = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    '--find-copies',
    '-z',
    `${startTree}^{tree}`,
    `${endTree}^{tree}`,
  ];
  const files: ChangedFileInfo[] = [];
  let totalCount = 0;
  let statusCode: string | null = null;
  let previousPath: string | null = null;

  await streamGitNulTokens({
    repoPath,
    gitArgs: [...baseArgs.slice(0, 1), '--name-status', ...baseArgs.slice(1)],
    timeoutMs: deadline - Date.now(),
    ...(signal ? { signal } : {}),
    onToken(token) {
      if (statusCode === null) {
        if (!token) return;
        statusCode = token;
        return;
      }
      if (
        (statusCode.startsWith('R') || statusCode.startsWith('C')) &&
        previousPath === null
      ) {
        previousPath = token;
        return;
      }
      totalCount += 1;
      if (files.length < maxRecords) {
        files.push({
          path: token,
          status: mapDiffStatus(statusCode),
          insertions: 0,
          deletions: 0,
          ...(previousPath !== null ? { previousPath } : {}),
        });
      }
      statusCode = null;
      previousPath = null;
    },
  });
  if (statusCode !== null || previousPath !== null) {
    throw new Error('Archived Git name-status output was incomplete.');
  }
  if (signal?.aborted) {
    throw new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE);
  }

  let numstatCount = 0;
  let pendingCounts: [number, number] | null = null;
  let pendingOldPath: string | null = null;
  const applyNumstat = (
    path: string,
    oldPath: string | undefined,
    counts: [number, number],
  ): void => {
    if (numstatCount < files.length) {
      const record = files[numstatCount];
      if (record.path !== path || record.previousPath !== oldPath) {
        throw new Error(
          'Archived Git diff streams returned different ordering.',
        );
      }
      record.insertions = counts[0];
      record.deletions = counts[1];
    }
    numstatCount += 1;
  };

  await streamGitNulTokens({
    repoPath,
    gitArgs: [...baseArgs.slice(0, 1), '--numstat', ...baseArgs.slice(1)],
    timeoutMs: deadline - Date.now(),
    ...(signal ? { signal } : {}),
    onToken(token) {
      if (pendingCounts !== null) {
        if (pendingOldPath === null) {
          pendingOldPath = token;
          return;
        }
        applyNumstat(token, pendingOldPath, pendingCounts);
        pendingCounts = null;
        pendingOldPath = null;
        return;
      }
      if (!token) return;
      const firstTab = token.indexOf('\t');
      const secondTab = token.indexOf('\t', firstTab + 1);
      if (firstTab < 0 || secondTab < 0) {
        throw new Error('Archived Git numstat output was malformed.');
      }
      const counts: [number, number] = [
        parseNumstatCount(token.slice(0, firstTab)),
        parseNumstatCount(token.slice(firstTab + 1, secondTab)),
      ];
      const path = token.slice(secondTab + 1);
      if (path.length === 0) {
        pendingCounts = counts;
        return;
      }
      applyNumstat(path, undefined, counts);
    },
  });
  if (pendingCounts !== null || pendingOldPath !== null) {
    throw new Error('Archived Git numstat output was incomplete.');
  }
  if (numstatCount !== totalCount) {
    throw new Error(
      'Archived Git diff streams returned different record counts.',
    );
  }

  return {
    files,
    totalCount,
    truncated: totalCount > files.length,
  };
}
