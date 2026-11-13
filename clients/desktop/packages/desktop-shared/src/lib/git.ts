import {
  assertWorkingDirectoryAvailable,
  workingDirectoryLaunchError,
} from '../node/lib/working-directory';
import { execFile } from 'node:child_process';
import { open, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { withGitRequestContextEnv } from '../node/git-request-context';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import { getGitExecutableCommand } from './git-executable';

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 1024 * 1024 * 8;
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_FILE_BYTES = 512_000;
const MAX_UNCOMMITTED_DIFF_CHARS = 50_000;
const REMOTE_DEFAULT_BRANCH_TIMEOUT_MS = 30_000;
// 60s TTL avoids repeated probes while bounding stale default-branch results.
const REMOTE_DEFAULT_BRANCH_CACHE_TTL_MS = 60_000;

interface RemoteDefaultBranchCacheEntry {
  value: string;
  expiresAt: number;
}

const remoteDefaultBranchCache = new Map<
  string,
  RemoteDefaultBranchCacheEntry
>();
const remoteDefaultBranchInFlight = new Map<string, Promise<string | null>>();

export type GitExecutableResolver = () => Promise<string>;

let gitExecutableResolver: GitExecutableResolver | null = null;

export function setGitExecutableResolver(
  resolver: GitExecutableResolver | null,
): void {
  gitExecutableResolver = resolver;
}

async function resolveGitExecutable(): Promise<string> {
  return gitExecutableResolver
    ? gitExecutableResolver()
    : getGitExecutableCommand(process.env);
}

export function resetRemoteDefaultBranchCacheForTests(): void {
  remoteDefaultBranchCache.clear();
  remoteDefaultBranchInFlight.clear();
}

function awaitRemoteDefaultBranchResolution(
  resolution: Promise<string | null>,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string | null> {
  if (options.signal?.aborted === true) {
    return Promise.reject(
      new DOMException('The operation was aborted', 'AbortError'),
    );
  }
  if (options.signal === undefined && options.timeoutMs === undefined) {
    return resolution;
  }

  return new Promise((resolve, reject) => {
    const abort = (): void =>
      reject(new DOMException('The operation was aborted', 'AbortError'));
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            const error = new Error(
              'Remote default branch resolution timed out',
            );
            Object.assign(error, { code: 'ETIMEDOUT' });
            reject(error);
          }, options.timeoutMs);

    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', abort);
      if (timeout !== undefined) clearTimeout(timeout);
    };
    resolution.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function runGit(
  args: string[],
  cwd?: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  await assertWorkingDirectoryAvailable(cwd);
  const { stdout } = await execFileAsync(await resolveGitExecutable(), args, {
    cwd,
    env: withGitRequestContextEnv(
      getEnhancedEnv({ environment: { runtime: 'canopy' } }),
    ),
    maxBuffer: MAX_BUFFER_BYTES,
    signal: options?.signal,
    timeout: options?.timeoutMs,
    windowsHide: process.platform === 'win32',
  }).catch(async (error: unknown) => {
    throw await workingDirectoryLaunchError(error, cwd);
  });

  return stdout.trim();
}

async function runGitRaw(args: string[], cwd?: string): Promise<string> {
  await assertWorkingDirectoryAvailable(cwd);
  const { stdout } = await execFileAsync(await resolveGitExecutable(), args, {
    cwd,
    env: withGitRequestContextEnv(
      getEnhancedEnv({ environment: { runtime: 'canopy' } }),
    ),
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: process.platform === 'win32',
  }).catch(async (error: unknown) => {
    throw await workingDirectoryLaunchError(error, cwd);
  });
  return stdout;
}

function resolveGitPath(repoPath: string, gitPath: string): string {
  return isAbsolute(gitPath) ? gitPath : join(repoPath, gitPath);
}

async function getGitPath(repoPath: string, gitPath: string): Promise<string> {
  return resolveGitPath(
    repoPath,
    await runGit(['rev-parse', '--git-path', gitPath], repoPath),
  );
}

export async function getRemoteHeadBranch(
  repoPath: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const output = await runGit(
    ['ls-remote', '--symref', 'origin', 'HEAD'],
    repoPath,
    {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? REMOTE_DEFAULT_BRANCH_TIMEOUT_MS,
    },
  );
  return output.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m)?.[1] ?? null;
}

export async function getLocalRemoteHeadBranch(
  repoPath: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    const ref = await runGit(
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      repoPath,
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? REMOTE_DEFAULT_BRANCH_TIMEOUT_MS,
      },
    );
    const branch = ref.replace('refs/remotes/origin/', '');
    return branch || null;
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    return null;
  }
}

export async function setLocalRemoteHeadBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  await runGit(['remote', 'set-head', 'origin', branch], repoPath);
}

export async function getRemoteDefaultBranch(
  repoPath: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    allowNetwork?: boolean;
    preferRemote?: boolean;
  } = {},
): Promise<string | null> {
  const gitOptions = {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? REMOTE_DEFAULT_BRANCH_TIMEOUT_MS,
  };
  let commonDir = repoPath;
  try {
    commonDir =
      (await runGit(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        repoPath,
        gitOptions,
      )) || repoPath;
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    // Preserve the helper's best-effort behavior for invalid/unreadable repos.
  }
  // A local-only or local-first result must not suppress a later caller that
  // requires remote verification, so the resolution policy is part of the key.
  const resolutionPolicy =
    options.allowNetwork !== false && options.preferRemote === true
      ? 'remote-first'
      : options.allowNetwork === false
        ? 'local'
        : 'local-first';
  const cacheKey = `${commonDir}\0${resolutionPolicy}`;
  const now = Date.now();
  remoteDefaultBranchCache.forEach((entry, key) => {
    if (entry.expiresAt <= now) remoteDefaultBranchCache.delete(key);
  });
  const cached = remoteDefaultBranchCache.get(cacheKey);
  if (cached) return cached.value;

  const existing = remoteDefaultBranchInFlight.get(cacheKey);
  if (existing) return awaitRemoteDefaultBranchResolution(existing, options);

  const resolution = resolveRemoteDefaultBranch(
    repoPath,
    {
      allowNetwork: options.allowNetwork,
      preferRemote: options.preferRemote,
    },
    { timeoutMs: REMOTE_DEFAULT_BRANCH_TIMEOUT_MS },
  )
    .then((value) => {
      // Negative results are not cached so transient remote failures retry.
      if (value !== null) {
        remoteDefaultBranchCache.set(cacheKey, {
          value,
          expiresAt: Date.now() + REMOTE_DEFAULT_BRANCH_CACHE_TTL_MS,
        });
      }
      return value;
    })
    .finally(() => remoteDefaultBranchInFlight.delete(cacheKey));
  remoteDefaultBranchInFlight.set(cacheKey, resolution);
  return awaitRemoteDefaultBranchResolution(resolution, options);
}

async function resolveRemoteDefaultBranch(
  repoPath: string,
  options: {
    signal?: AbortSignal;
    allowNetwork?: boolean;
    preferRemote?: boolean;
  },
  gitOptions: { signal?: AbortSignal; timeoutMs: number },
): Promise<string | null> {
  if (options.allowNetwork !== false && options.preferRemote === true) {
    try {
      const remoteHead = await getRemoteHeadBranch(repoPath, gitOptions);
      if (remoteHead) return remoteHead;
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      // Remote HEAD could not be queried; fall back to local metadata.
    }
  }

  try {
    const ref = await runGit(
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      repoPath,
      gitOptions,
    );
    const branch = ref.replace('refs/remotes/origin/', '');
    if (branch) return branch;
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    // origin/HEAD not set
  }

  if (options.allowNetwork !== false && options.preferRemote !== true) {
    try {
      const output = await runGit(
        ['ls-remote', '--symref', 'origin', 'HEAD'],
        repoPath,
        gitOptions,
      );
      const headMatch = output.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
      if (headMatch?.[1]) return headMatch[1];
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      // Remote HEAD could not be queried; try conventional local refs.
    }
  }

  for (const candidate of ['main', 'master', 'develop']) {
    try {
      await runGit(
        ['rev-parse', '--verify', `refs/remotes/origin/${candidate}`],
        repoPath,
        gitOptions,
      );
      return candidate;
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      // Not found, try next
    }
  }

  return null;
}

export async function getCurrentBranch(worktreePath: string): Promise<string> {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
}

async function getRebaseHeadBranch(
  worktreePath: string,
): Promise<string | null> {
  for (const path of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
    try {
      const value = (
        await readFile(await getGitPath(worktreePath, path), 'utf8')
      ).trim();
      const branch = value.startsWith('refs/heads/')
        ? value.slice('refs/heads/'.length)
        : value;
      if (branch && branch !== 'HEAD') {
        return branch;
      }
    } catch {
      // Try the other rebase backend path.
    }
  }
  return null;
}

export async function getCurrentBranchDisplayName(
  worktreePath: string,
): Promise<string> {
  const branch = await getCurrentBranch(worktreePath);
  if (branch !== 'HEAD') {
    return branch;
  }
  return (await getRebaseHeadBranch(worktreePath)) ?? branch;
}

export async function getRepoRootFromWorktree(
  worktreePath: string,
): Promise<string> {
  const gitCommonDir = await runGit(
    ['rev-parse', '--git-common-dir'],
    worktreePath,
  );
  const resolved = isAbsolute(gitCommonDir)
    ? gitCommonDir
    : join(worktreePath, gitCommonDir);
  const gitDir = resolved.replace(/[/\\]worktrees[/\\][^/\\]+$/, '');
  return dirname(gitDir);
}

export async function getFullDiff(
  repoPath: string,
  baseBranch: string,
): Promise<string> {
  try {
    const output = await runGit(
      ['diff', `origin/${baseBranch}...HEAD`],
      repoPath,
    );
    return output.length > 50_000 ? output.slice(0, 50_000) : output;
  } catch {
    return '';
  }
}

export async function getCommitLog(
  repoPath: string,
  baseBranch: string,
): Promise<string> {
  try {
    return await runGit(
      ['log', `origin/${baseBranch}..HEAD`, '--oneline'],
      repoPath,
    );
  } catch {
    return '';
  }
}

export async function pushBranch(repoPath: string): Promise<void> {
  await runGit(['push', '-u', 'origin', 'HEAD'], repoPath);
}

export async function hasUncommittedChanges(
  repoPath: string,
): Promise<boolean> {
  const status = await runGit(
    ['status', '--porcelain', '--untracked-files=normal'],
    repoPath,
  );
  return status.length > 0;
}

export async function hasRemoteTrackingBranch(
  repoPath: string,
): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], repoPath);
    return true;
  } catch {
    return false;
  }
}

export async function hasBranchBeenPushedToRemote(
  repoPath: string,
): Promise<boolean> {
  return (await readBranchPublication(repoPath)) === true;
}

/** Null means the probe failed, rather than a confirmed missing remote ref. */
export async function readBranchPublication(
  repoPath: string,
): Promise<boolean | null> {
  try {
    const branch = await runGit(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      repoPath,
    );
    if (!branch || branch === 'HEAD') return null;
    try {
      await runGit(
        ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
        repoPath,
      );
      return true;
    } catch (error) {
      return typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 1
        ? false
        : null;
    }
  } catch {
    return null;
  }
}

export async function hasUnpushedCommits(repoPath: string): Promise<boolean> {
  try {
    const output = await runGit(
      ['rev-list', '@{u}..HEAD', '--count'],
      repoPath,
    );
    return Number.parseInt(output.trim(), 10) > 0;
  } catch {
    return false;
  }
}

export async function hasUnpulledCommits(repoPath: string): Promise<boolean> {
  try {
    const branch = await runGit(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      repoPath,
    );
    if (!branch || branch === 'HEAD') return false;

    // Only count commits against this branch's own remote-tracking ref, not
    // `@{u}`. A worktree created via `git worktree add -b foo <path> origin/main`
    // inherits `origin/main` as its upstream until the branch is pushed with
    // `-u`, which makes `HEAD..@{u}` count unrelated base-branch commits and
    // would falsely trigger the Pull option.
    const remoteRef = `refs/remotes/origin/${branch}`;
    try {
      await runGit(['show-ref', '--verify', '--quiet', remoteRef], repoPath);
    } catch {
      return false;
    }

    const output = await runGit(
      ['rev-list', '--count', `HEAD..${remoteRef}`],
      repoPath,
    );
    return Number.parseInt(output.trim(), 10) > 0;
  } catch {
    return false;
  }
}

export async function stageAllChanges(repoPath: string): Promise<void> {
  await runGit(['add', '-A'], repoPath);
}

export async function commitWithMessage(
  repoPath: string,
  message: string,
): Promise<string> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error('Commit message must not be empty');
  }
  await runGit(['commit', '-m', trimmed], repoPath);
  return runGit(['rev-parse', 'HEAD'], repoPath);
}

/**
 * Return a content hash of canopy.json in the given repo/worktree path.
 * Uses `git hash-object` on the working-copy file so the hash reflects
 * uncommitted edits. Returns `null` when the file does not exist.
 */
export async function getCanopyJsonHash(
  repoPath: string,
): Promise<string | null> {
  try {
    return await runGit(
      ['hash-object', join(repoPath, 'canopy.json')],
      repoPath,
    );
  } catch {
    return null;
  }
}

export async function getUncommittedDiff(repoPath: string): Promise<string> {
  const [trackedDiff, untrackedOutput] = await Promise.all([
    runGitRaw(['diff', 'HEAD'], repoPath).catch(() => ''),
    runGit(['ls-files', '--others', '--exclude-standard'], repoPath).catch(
      () => '',
    ),
  ]);

  let result = trackedDiff;

  if (result.length >= MAX_UNCOMMITTED_DIFF_CHARS) {
    return result.slice(0, MAX_UNCOMMITTED_DIFF_CHARS);
  }

  const untrackedFiles = untrackedOutput
    .split('\n')
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED_FILES);

  for (const file of untrackedFiles) {
    if (result.length >= MAX_UNCOMMITTED_DIFF_CHARS) {
      break;
    }

    try {
      const filePath = join(repoPath, file);
      const st = await stat(filePath);
      if (st.size > MAX_UNTRACKED_FILE_BYTES) {
        continue;
      }

      const fh = await open(filePath, 'r');
      let isBinary = false;
      try {
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await fh.read(buf, 0, 8192, 0);
        isBinary = buf.subarray(0, bytesRead).includes(0);
      } finally {
        await fh.close();
      }
      if (isBinary) {
        continue;
      }

      const content = await readFile(filePath, 'utf-8');
      result += `\ndiff --git a/${file} b/${file}\n`;
      result += 'new file mode 100644\n';
      result += '--- /dev/null\n';
      result += `+++ b/${file}\n`;
      for (const line of content.split('\n')) {
        result += `+${line}\n`;
        if (result.length >= MAX_UNCOMMITTED_DIFF_CHARS) {
          return result.slice(0, MAX_UNCOMMITTED_DIFF_CHARS);
        }
      }
    } catch {
      // Best effort. Skip unreadable files.
    }
  }

  return result;
}
