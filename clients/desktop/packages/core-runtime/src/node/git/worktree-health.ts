import { isAbsolute, join, resolve } from 'node:path';
import type { WorkerGitWorktreeHealthCode } from '@canopy/protocol/canopy-core';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/protocol/ui-labels';
import { isUnreadablePathError } from '../filesystem/unreadable-path-error';

/** A broken repository of a multi-repository worktree, as the host reports it. */
export interface WorktreeHealthRepoIssue {
  repoId: string;
  repoName: string;
  repoPath: string;
  code: WorkerGitWorktreeHealthCode;
  message: string;
  gitError?: string;
}

/**
 * The host's full health issue, with paths, names, messages and Git output.
 * It never crosses a portable boundary; the canonical result keeps its codes.
 */
export interface WorktreeHealthIssue {
  status: 'broken';
  code: WorkerGitWorktreeHealthCode;
  message: string;
  checkedAt: string;
  worktreePath: string;
  gitError?: string;
  repoIssues?: WorktreeHealthRepoIssue[];
}

export interface WorktreeHealthRepoEntry {
  repoId: string;
  repoName: string;
  repoPath: string;
}

export interface WorktreeHealthPathKind {
  isDirectory(): boolean;
  isFile(): boolean;
}

/** The workspace facts the check needs; `type` is the workspace type. */
export interface WorktreeHealthWorkspace {
  readonly type: string;
  readonly repos: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly hasSourceRepository: boolean;
}

/**
 * Host ports for one worktree's check. A rejected `stat`, `lstat` or
 * `readText` reads as absent, except a system error that does not mean a
 * missing path (`EACCES`, `EPERM`, `EIO`), which reads as unreadable; a
 * rejected Git confirmation is a Git error.
 */
export interface WorktreeHealthSources {
  readonly worktreePath: string;
  readWorkspace(): Promise<WorktreeHealthWorkspace>;
  /** The worktree root (when it is a checkout) and each directory under `repos/`. */
  listRepositoryEntries(): Promise<readonly WorktreeHealthRepoEntry[]>;
  /** The worktree row's `includedRepoIds`; rejects or resolves undefined without a row. */
  readIncludedRepoIds(): Promise<readonly string[] | undefined>;
  stat(path: string): Promise<WorktreeHealthPathKind>;
  lstat(path: string): Promise<WorktreeHealthPathKind>;
  readText(path: string): Promise<string>;
  /** `git rev-parse --is-inside-work-tree` in `path`: stdout, or the Git failure. */
  confirmWorkTree(path: string): Promise<string>;
  now(): Date;
}

interface RepoHealthFailure {
  ok: false;
  code: WorkerGitWorktreeHealthCode;
  message: string;
  gitError?: string;
  shouldConfirmWithGit?: boolean;
}

type RepoHealthResult = { ok: true } | RepoHealthFailure;

const MESSAGES: Record<WorkerGitWorktreeHealthCode, string> = {
  'missing-worktree-path': 'Worktree directory does not exist.',
  'missing-git-metadata': 'Git metadata is missing for this worktree.',
  'invalid-git-worktree':
    'Git metadata for this worktree is incomplete or points to a missing location.',
  'missing-repository': 'One or more repositories in this project are missing.',
  'git-error': 'Git could not validate this worktree.',
  unreadable: 'This worktree could not be read.',
};

function failure(
  code: WorkerGitWorktreeHealthCode,
  details: { gitError?: string; shouldConfirmWithGit?: boolean } = {},
): RepoHealthFailure {
  return { ok: false, code, message: MESSAGES[code], ...details };
}

/** Resolves a portable gitdir file relative to its checkout. */
export function parseGitDirectoryFile(
  raw: string,
  repoPath: string,
): string | null {
  const value = /^gitdir:\s*(.+)\s*$/m.exec(raw)?.[1];
  return value ? (isAbsolute(value) ? value : resolve(repoPath, value)) : null;
}

type Probe<T> =
  | { kind: 'present'; value: T }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

/** Only a missing path (or an error without a system code) reads as absent. */
async function probe<T>(read: Promise<T>): Promise<Probe<T>> {
  try {
    return { kind: 'present', value: await read };
  } catch (error) {
    return { kind: isUnreadablePathError(error) ? 'unreadable' : 'absent' };
  }
}

async function inspectGitMetadata(
  sources: WorktreeHealthSources,
  repoPath: string,
): Promise<RepoHealthResult> {
  const dirStat = await probe(sources.stat(repoPath));
  if (dirStat.kind === 'unreadable') return failure('unreadable');
  if (dirStat.kind === 'absent' || !dirStat.value.isDirectory())
    return failure('missing-worktree-path');

  const dotGitPath = join(repoPath, '.git');
  const dotGitStat = await probe(sources.lstat(dotGitPath));
  if (dotGitStat.kind === 'unreadable') return failure('unreadable');
  if (dotGitStat.kind === 'absent') return failure('missing-git-metadata');
  if (!dotGitStat.value.isFile())
    return failure('invalid-git-worktree', { shouldConfirmWithGit: true });

  const rawRead = await probe(sources.readText(dotGitPath));
  if (rawRead.kind === 'unreadable') return failure('unreadable');
  const raw = rawRead.kind === 'present' ? rawRead.value : '';
  const gitDir = parseGitDirectoryFile(raw, repoPath);
  if (!gitDir) return failure('invalid-git-worktree');
  const gitDirStat = await probe(sources.stat(gitDir));
  if (gitDirStat.kind === 'unreadable') return failure('unreadable');
  if (gitDirStat.kind === 'absent')
    return failure('invalid-git-worktree', {
      gitError: `Missing gitdir target: ${gitDir}`,
    });
  if (!gitDirStat.value.isDirectory())
    return failure('invalid-git-worktree', {
      gitError: `Invalid gitdir target: ${gitDir}`,
      shouldConfirmWithGit: true,
    });
  return failure('invalid-git-worktree', { shouldConfirmWithGit: true });
}

async function confirmWithGit(
  sources: WorktreeHealthSources,
  repoPath: string,
): Promise<RepoHealthResult> {
  try {
    const stdout = await sources.confirmWorkTree(repoPath);
    return stdout.trim() === 'true'
      ? { ok: true }
      : failure('invalid-git-worktree');
  } catch (error) {
    return failure('git-error', {
      gitError: error instanceof Error ? error.message : String(error),
    });
  }
}

async function validateRepoPath(
  sources: WorktreeHealthSources,
  repoPath: string,
): Promise<RepoHealthResult> {
  const result = await inspectGitMetadata(sources, repoPath);
  if (result.ok || !result.shouldConfirmWithGit) return result;
  return confirmWithGit(sources, repoPath);
}

// Property order and present-but-undefined properties are part of the legacy
// response, which IPC delivers by structured clone.
function toRepoIssue(
  entry: WorktreeHealthRepoEntry,
  result: RepoHealthFailure,
): WorktreeHealthRepoIssue {
  return {
    repoId: entry.repoId,
    repoName: entry.repoName,
    repoPath: entry.repoPath,
    code: result.code,
    message: result.message,
    gitError: result.gitError,
  };
}

function createIssue(
  sources: WorktreeHealthSources,
  params: {
    code: WorkerGitWorktreeHealthCode;
    gitError?: string;
    repoIssues?: WorktreeHealthRepoIssue[];
  },
): WorktreeHealthIssue {
  return {
    status: 'broken',
    code: params.code,
    message: MESSAGES[params.code],
    checkedAt: sources.now().toISOString(),
    worktreePath: sources.worktreePath,
    gitError: params.gitError,
    repoIssues: params.repoIssues,
  };
}

function aggregateRepoIssues(
  sources: WorktreeHealthSources,
  repoIssues: WorktreeHealthRepoIssue[],
): WorktreeHealthIssue | null {
  if (repoIssues.length === 0) return null;
  const firstIssue = repoIssues[0];
  const code = repoIssues.some((issue) => issue.code === 'missing-repository')
    ? 'missing-repository'
    : (firstIssue?.code ?? 'git-error');
  const onlyIssue = repoIssues.length === 1 ? firstIssue : undefined;
  return createIssue(sources, {
    code,
    gitError: onlyIssue?.gitError,
    repoIssues,
  });
}

async function collectRepoIssues(
  sources: WorktreeHealthSources,
  workspace: WorktreeHealthWorkspace,
): Promise<WorktreeHealthRepoIssue[]> {
  const { worktreePath } = sources;
  const repoIssues: WorktreeHealthRepoIssue[] = [];
  // An unreadable `repos/` hides every checkout; it is not a missing one.
  let entries: readonly WorktreeHealthRepoEntry[] = [];
  let listingUnreadable = false;
  try {
    entries = await sources.listRepositoryEntries();
  } catch (error) {
    if (!isUnreadablePathError(error)) throw error;
    listingUnreadable = true;
  }
  const presentRepoIds = new Set(entries.map((entry) => entry.repoId));
  const includedRepoIds = await sources
    .readIncludedRepoIds()
    .catch(() => undefined);
  const expectedRepoIds =
    includedRepoIds === undefined ? null : new Set(includedRepoIds);
  const isExpected = (repoId: string): boolean =>
    !expectedRepoIds || expectedRepoIds.has(repoId);

  for (const configured of workspace.repos) {
    if (isExpected(configured.id) && !presentRepoIds.has(configured.id))
      repoIssues.push({
        repoId: configured.id,
        repoName: configured.name || configured.id,
        repoPath: join(worktreePath, 'repos', configured.id),
        code: listingUnreadable ? 'unreadable' : 'missing-repository',
        message: listingUnreadable
          ? 'Repository directory could not be read.'
          : 'Repository directory is missing from this worktree.',
      });
  }

  for (const entry of entries) {
    // Explicitly scoped worktrees may carry user-owned payload directories
    // beneath repos/. Only configured, included checkout ids are Git repos.
    if (entry.repoId === WORKSPACE_ROOT_REPO_ID || !isExpected(entry.repoId))
      continue;
    const result = await validateRepoPath(sources, entry.repoPath);
    if (!result.ok) repoIssues.push(toRepoIssue(entry, result));
  }

  if (workspace.hasSourceRepository) {
    const result = await validateRepoPath(sources, worktreePath);
    if (!result.ok)
      repoIssues.push(
        toRepoIssue(
          {
            repoId: WORKSPACE_ROOT_REPO_ID,
            repoName: WORKSPACE_ROOT_REPO_NAME,
            repoPath: worktreePath,
          },
          result,
        ),
      );
  }
  return repoIssues;
}

/**
 * Checks one worktree's checkout, or a multi-repository worktree's root and
 * repository checkouts. Reads only: the caller records the issue. `null`
 * means healthy.
 */
export async function inspectWorktreeHealth(
  sources: WorktreeHealthSources,
): Promise<WorktreeHealthIssue | null> {
  const workspace = await sources.readWorkspace();

  if (workspace.type === 'single-repo') {
    const result = await validateRepoPath(sources, sources.worktreePath);
    if (result.ok) return null;
    return createIssue(sources, {
      code: result.code,
      gitError: result.gitError,
    });
  }

  const rootStat = await probe(sources.stat(sources.worktreePath));
  if (rootStat.kind === 'unreadable')
    return createIssue(sources, { code: 'unreadable' });
  if (rootStat.kind === 'absent' || !rootStat.value.isDirectory())
    return createIssue(sources, { code: 'missing-worktree-path' });

  return aggregateRepoIssues(
    sources,
    await collectRepoIssues(sources, workspace),
  );
}
