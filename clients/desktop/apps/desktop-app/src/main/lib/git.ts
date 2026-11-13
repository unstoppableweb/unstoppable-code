import {
  assertWorkingDirectoryAvailable,
  workingDirectoryLaunchError,
} from '@canopy/desktop-shared/node/lib/working-directory';
import {
  classifyGitError,
  rethrowClassifiedGitError,
} from './git-error-classification';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { devNull } from 'node:os';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  resolve,
} from 'node:path';
import { promisify } from 'node:util';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type {
  ChangedFileInfo,
  ChangedFileStatus,
  FileDiffImagePreview,
  ListBranchesResponse,
} from '@canopy/desktop-shared/types';
import {
  addGitWorktree,
  classifyWorktreeAddFailure,
  readGitHeadState,
  appendBranchSuffix,
  checkoutGitBranch,
  createGitBranch,
  deleteGitBranch,
  GIT_BRANCH_LIST_REF_ARGS,
  gitChangeSetReadArgs,
  hasGitBranchRefConflict,
  listGitBranches,
  parentBranchNames,
  parseGitCheckedOutBranches,
  parseGitWorktreeListPorcelain,
  selectAvailableGitBranchName,
  mergeGitBranches,
  type GitMergeWritePort,
  type GitBranchDeletePort,
  type GitBranchNameReads,
  type GitBranchWritePort,
  type GitChangeSetReader,
} from '@canopy/core-runtime/node/git';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import {
  isGitCloneProgressLine,
  parseGitCloneProgressLine,
  redactRemoteUrlCredentialsInText,
  type GitCloneProgressUpdate,
} from './git-clone-progress';
import {
  estimateUntrackedChanges,
  estimateUntrackedInsertions,
  MAX_UNTRACKED_FILES,
} from './untracked-line-estimate';
import { getEnhancedEnv } from '@canopy/execution-engine/pipelines/config-paths';
import { withGitRequestContextEnv } from '@canopy/desktop-shared/node/git-request-context';
import {
  getCurrentBranch,
  getCurrentBranchDisplayName,
  getRemoteDefaultBranch,
  getRepoRootFromWorktree,
  hasUncommittedChanges,
  setGitExecutableResolver,
} from '@canopy/desktop-shared/lib/git';
import { BRAND } from '@canopy/brand/current';
import {
  lowerSpawnedProcessPriority,
  prepareBackgroundProcessLaunch,
} from './background-process';
import { getCanopyJsonPath, writeCanopyJson } from './canopy-json';
import {
  invalidateGitFetchFreshness,
  readGitFetchFreshness,
  recordGitFetchFailure,
  recordGitFetchSuccess,
  type GitFetchFreshnessIdentity,
} from './git-fetch-freshness';
import { getWorktreeDeleteTimeoutMs } from './worktree-delete-config';
import {
  terminateProcessesReferencingPath,
  withLinuxWorktreeRemovalVerification,
  WorktreeProcessCleanupError,
} from './worktree-process-cleanup';
import { removeWindowsWorktreeReparsePoints } from './windows-worktree-reparse-points';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';
export { removeWindowsWorktreeReparsePoints } from './windows-worktree-reparse-points';
import {
  bufferContainsLfsAttributes,
  fileContainsLfsAttributes,
  MAX_GIT_ATTRIBUTES_INSPECTION_BYTES,
} from '../shared-containers/git-lfs';

const execFileAsync: typeof execFile.__promisify__ = promisify(execFile);
if (typeof setGitExecutableResolver === 'function') {
  setGitExecutableResolver(getResolvedGitExecutableForSpawn);
}
export const WORKTREE_GIT_TIMEOUT_MS = 30_000;
const SHARED_CONTAINER_GIT_REMOTE_TIMEOUT_MS = 10_000;
/**
 * Push budget for the shared-container recovery flow.
 *
 * Deliberately separate from `SHARED_CONTAINER_GIT_REMOTE_TIMEOUT_MS`, which
 * is sized for metadata probes (`ls-remote` / `cat-file`). A push transfers
 * objects, so a large repository or a slow uplink routinely needs more than
 * the probe budget. Sharing the probe timeout made the recovery button fail
 * permanently for exactly those users, because every retry hit the same
 * ceiling.
 */
const SHARED_CONTAINER_GIT_PUSH_TIMEOUT_MS = 120_000;
const CHECK_IGNORE_CHUNK_SIZE = 5_000;
const IGNORED_LISTING_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_DIFF_PREVIEW_BYTES = 5 * 1024 * 1024;

export interface RawGitTreeUsage {
  fileCount: number;
  totalBytes: bigint;
}

export class RawGitTreeSymlinkUnsupportedError extends Error {
  constructor() {
    super('Raw Git tree contains a symbolic link');
    this.name = 'RawGitTreeSymlinkUnsupportedError';
  }
}

export interface MaterializeGitCommitRawOptions {
  /**
   * Optional guards. Shared-container base checkouts pass neither: their bytes
   * come from the caller's own authenticated access to a repository whose share
   * the recipient explicitly accepted, so they are neither charged to the
   * artifact quota nor capped.
   */
  maxFiles?: number;
  maxBytes?: bigint;
  rejectSymlinks?: boolean;
  /**
   * Defaults to true for replica materialization, where missing promisor blobs
   * may be fetched while authenticated access is available. Set false only
   * when every required blob has already been materialized locally.
   */
  allowPromisorFetch?: boolean;
  resolveDestination: (relativePath: string) => string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const IMAGE_DIFF_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

export {
  commitWithMessage,
  getCommitLog,
  getCurrentBranch,
  getFullDiff,
  getRepoRootFromWorktree,
  getRemoteDefaultBranch,
  getRemoteHeadBranch,
  getLocalRemoteHeadBranch,
  setLocalRemoteHeadBranch,
  getUncommittedDiff,
  getCanopyJsonHash,
  hasBranchBeenPushedToRemote,
  readBranchPublication,
  hasRemoteTrackingBranch,
  hasUncommittedChanges,
  hasUnpulledCommits,
  hasUnpushedCommits,
  pushBranch,
  resetRemoteDefaultBranchCacheForTests,
  stageAllChanges,
} from '@canopy/desktop-shared/lib/git';

export { getCurrentBranchDisplayName };

async function runGit(
  args: string[],
  cwd?: string,
  options?: {
    timeoutMs?: number;
    maxBuffer?: number;
    preserveWhitespace?: boolean;
    stdin?: string;
    signal?: AbortSignal;
    backgroundPriority?: boolean;
    disableReplaceObjects?: boolean;
    nonInteractive?: boolean;
    skipLfsSmudge?: boolean;
  },
): Promise<string> {
  await assertWorkingDirectoryAvailable(cwd);
  const launch = prepareBackgroundProcessLaunch(
    await getResolvedGitExecutableForSpawn(),
    args,
    options?.backgroundPriority === true,
  );
  if (options?.stdin !== undefined) {
    const stdinInput = options.stdin;
    return new Promise((resolvePromise, reject) => {
      const child = execFile(
        launch.command,
        launch.args,
        {
          cwd,
          env: {
            ...withGitRequestContextEnv(
              getEnhancedEnv({
                includeCanopySecrets: false,
                environment: false,
              }),
            ),
            ...(options?.disableReplaceObjects
              ? { GIT_NO_REPLACE_OBJECTS: '1' }
              : {}),
            ...(options?.nonInteractive
              ? { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
              : {}),
            ...(options?.skipLfsSmudge ? { GIT_LFS_SKIP_SMUDGE: '1' } : {}),
          },
          maxBuffer: 1024 * 1024 * 8,
          timeout: options?.timeoutMs,
          signal: options?.signal,
          windowsHide: process.platform === 'win32',
        },
        (error, stdout, stderr) => {
          if (error) {
            const trimmedStderr = stderr?.trim();
            const baseMessage =
              error instanceof Error
                ? error.message
                : 'git command with stdin input failed';
            const messageIncludesStderr = Boolean(
              trimmedStderr && baseMessage.includes(trimmedStderr),
            );
            void workingDirectoryLaunchError(error, cwd).then((launchError) =>
              reject(
                classifyGitError(
                  new Error(
                    launchError !== error && launchError instanceof Error
                      ? launchError.message
                      : trimmedStderr && !messageIncludesStderr
                        ? `${baseMessage}\n${trimmedStderr}`
                        : baseMessage,
                  ),
                ),
              ),
            );
            return;
          }
          resolvePromise(stdout.trim());
        },
      );
      if (launch.lowerPriorityAfterSpawn && typeof child.pid === 'number') {
        lowerSpawnedProcessPriority(child.pid);
      }
      // ChildProcess errors do not cover errors emitted by its stdin stream.
      child.stdin?.on('error', reject);
      child.stdin?.end(stdinInput);
    });
  }

  const pending = execFileAsync(launch.command, launch.args, {
    cwd,
    env: {
      ...withGitRequestContextEnv(
        getEnhancedEnv({
          includeCanopySecrets: false,
          environment: false,
        }),
      ),
      ...(options?.disableReplaceObjects
        ? { GIT_NO_REPLACE_OBJECTS: '1' }
        : {}),
      ...(options?.nonInteractive
        ? { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
        : {}),
      ...(options?.skipLfsSmudge ? { GIT_LFS_SKIP_SMUDGE: '1' } : {}),
    },
    maxBuffer: options?.maxBuffer ?? 1024 * 1024 * 8,
    timeout: options?.timeoutMs,
    signal: options?.signal,
    windowsHide: process.platform === 'win32',
  });
  if (launch.lowerPriorityAfterSpawn && typeof pending.child.pid === 'number') {
    lowerSpawnedProcessPriority(pending.child.pid);
  }
  const { stdout } = await pending.catch(async (error: unknown) =>
    rethrowClassifiedGitError(await workingDirectoryLaunchError(error, cwd)),
  );

  return options?.preserveWhitespace ? stdout : stdout.trim();
}

async function runGitRaw(
  args: string[],
  cwd?: string,
  options?: { disableReplaceObjects?: boolean },
): Promise<string> {
  await assertWorkingDirectoryAvailable(cwd);
  const { stdout } = await execFileAsync(
    await getResolvedGitExecutableForSpawn(),
    args,
    {
      cwd,
      env: {
        ...withGitRequestContextEnv({ ...process.env }),
        ...(options?.disableReplaceObjects
          ? { GIT_NO_REPLACE_OBJECTS: '1' }
          : {}),
      },
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: process.platform === 'win32',
    },
  ).catch(rethrowClassifiedGitError);
  return stdout;
}

async function runGitBuffer(
  args: string[],
  cwd?: string,
  options?: { disableReplaceObjects?: boolean },
): Promise<Buffer> {
  await assertWorkingDirectoryAvailable(cwd);
  const { stdout } = await execFileAsync(
    await getResolvedGitExecutableForSpawn(),
    args,
    {
      cwd,
      env: {
        ...withGitRequestContextEnv({ ...process.env }),
        ...(options?.disableReplaceObjects
          ? { GIT_NO_REPLACE_OBJECTS: '1' }
          : {}),
      },
      encoding: 'buffer',
      maxBuffer: MAX_IMAGE_DIFF_PREVIEW_BYTES + 1024,
      windowsHide: process.platform === 'win32',
    },
  ).catch(rethrowClassifiedGitError);

  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function runGitUntrimmedBuffer(
  args: string[],
  cwd: string,
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<Buffer> {
  const launch = prepareBackgroundProcessLaunch(
    await getResolvedGitExecutableForSpawn(),
    args,
    false,
  );
  await assertWorkingDirectoryAvailable(cwd);
  const { stdout } = await execFileAsync(launch.command, launch.args, {
    cwd,
    env: withGitRequestContextEnv(
      getEnhancedEnv({ includeCanopySecrets: false, environment: false }),
    ),
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 64,
    timeout: options.timeoutMs,
    signal: options.signal,
    windowsHide: process.platform === 'win32',
  }).catch(rethrowClassifiedGitError);
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

function disableGitHooks(args: string[]): string[] {
  return ['-c', `core.hooksPath=${devNull}`, ...args];
}

const TURN_DIFF_REF_NAMESPACE = 'refs/app/turn-diff-trees';
const GIT_OBJECT_ID_RE = /^[0-9a-f]{40,64}$/;
const fetchOriginPromises = new Map<string, Promise<void>>();
const worktreeRemovalQueues = new Map<string, Promise<void>>();
/** Last completion time per repository/origin fetch key, consulted by TTL-aware callers. */
const fetchOriginCompletedAtMs = new Map<string, number>();
/** Shorter retry window for failed automatic fetches. */
const fetchOriginRetryAfterAtMs = new Map<string, number>();
const FETCH_ORIGIN_IDENTITY_CACHE_TTL_MS = 5_000;
const fetchOriginIdentityCache = new Map<
  string,
  { originUrl: string | null; resolvedAt: number }
>();
const fetchOriginIdentityPromises = new Map<string, Promise<string | null>>();

function abortSignalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Git fetch was aborted.');
}

async function waitForPromiseWithSignal(
  promise: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await promise;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortSignalError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
    if (signal.aborted) onAbort();
  });
}

async function resolveFetchOriginUrl(
  commonDir: string,
  repoPath: string,
): Promise<string | null> {
  const cached = fetchOriginIdentityCache.get(commonDir);
  const cachedAge = cached ? Date.now() - cached.resolvedAt : -1;
  if (
    cached &&
    cachedAge >= 0 &&
    cachedAge < FETCH_ORIGIN_IDENTITY_CACHE_TTL_MS
  ) {
    return cached.originUrl;
  }

  const activeLookup = fetchOriginIdentityPromises.get(commonDir);
  if (activeLookup) {
    return activeLookup;
  }

  const lookup = getRemoteUrl(repoPath).then((originUrl) => {
    fetchOriginIdentityCache.set(commonDir, {
      originUrl,
      resolvedAt: Date.now(),
    });
    return originUrl;
  });
  fetchOriginIdentityPromises.set(commonDir, lookup);
  try {
    return await lookup;
  } finally {
    if (fetchOriginIdentityPromises.get(commonDir) === lookup) {
      fetchOriginIdentityPromises.delete(commonDir);
    }
  }
}

function fetchOriginStateKey(
  fetchKey: string,
  originUrl: string | null,
): string {
  const originHash = createHash('sha256')
    .update(originUrl ?? '')
    .digest('hex');
  return `${fetchKey}\0${originHash}`;
}

async function invalidateFetchOriginFreshness(
  commonDir: string,
  originUrl: string | null,
): Promise<void> {
  for (const fetchKey of [commonDir, `${commonDir}#prune`]) {
    const stateKey = fetchOriginStateKey(fetchKey, originUrl);
    fetchOriginCompletedAtMs.delete(stateKey);
    fetchOriginRetryAfterAtMs.delete(stateKey);
  }

  if (!originUrl) return;

  await Promise.all(
    [false, true].map((prune) =>
      invalidateGitFetchFreshness({ commonDir, originUrl, prune }).catch(
        () => undefined,
      ),
    ),
  );
}

function buildTurnDiffRefPrefix(projectId: string, worktreeId: string): string {
  return `${TURN_DIFF_REF_NAMESPACE}/${projectId}/${worktreeId}`;
}

function buildTurnDiffRefName(
  projectId: string,
  worktreeId: string,
  treeSha: string,
): string {
  return `${buildTurnDiffRefPrefix(projectId, worktreeId)}/${treeSha}`;
}

function resolveGitPath(repoPath: string, gitPath: string): string {
  return isAbsolute(gitPath) ? gitPath : resolve(repoPath, gitPath);
}

async function resolveGitCommonDir(repoPath: string): Promise<string> {
  const gitCommonDir = await runGit(
    ['rev-parse', '--git-common-dir'],
    repoPath,
  );
  return resolveGitPath(repoPath, gitCommonDir);
}

export async function getGitCommonDir(repoPath: string): Promise<string> {
  // macOS exposes /var through the /private/var symlink. Electron launches can
  // therefore observe two spellings for the same repository across processes,
  // which would split any durable state keyed by the common Git directory.
  return realpath(await resolveGitCommonDir(repoPath));
}

export async function getGitPath(
  repoPath: string,
  gitPath: string,
): Promise<string> {
  const resolvedGitPath = await runGit(
    ['rev-parse', '--git-path', gitPath],
    repoPath,
  );
  return resolveGitPath(repoPath, resolvedGitPath);
}

export interface GitHeadWatchState {
  headPath: string;
  branchName: string | null;
}

async function getGitHeadWatchStateWithGit(
  repoPath: string,
): Promise<GitHeadWatchState> {
  const output = await runGit(
    ['rev-parse', '--git-path', 'HEAD', '--abbrev-ref', 'HEAD'],
    repoPath,
  );
  const separatorIndex = output.lastIndexOf('\n');
  if (separatorIndex < 0) {
    throw new Error('Git did not return HEAD path and branch state');
  }
  const gitHeadPath = output.slice(0, separatorIndex).trim();
  const abbreviatedBranch = output.slice(separatorIndex + 1).trim();
  if (!gitHeadPath || !abbreviatedBranch) {
    throw new Error('Git returned incomplete HEAD path and branch state');
  }

  return {
    headPath: resolveGitPath(repoPath, gitHeadPath),
    branchName:
      abbreviatedBranch === 'HEAD'
        ? await getCurrentBranchDisplayName(repoPath).catch(() => null)
        : abbreviatedBranch,
  };
}

async function getGitHeadWatchStateFromFilesystem(
  repoPath: string,
): Promise<GitHeadWatchState> {
  const dotGitPath = resolve(repoPath, '.git');
  const dotGitStats = await stat(dotGitPath);
  let gitDirectory = dotGitPath;
  if (dotGitStats.isFile()) {
    const gitFile = (await readFile(dotGitPath, 'utf8')).trim();
    const match = /^gitdir:\s*(.+)$/i.exec(gitFile);
    if (!match?.[1]) {
      throw new Error('Git worktree pointer did not contain a gitdir');
    }
    gitDirectory = resolve(dirname(dotGitPath), match[1]);
  } else if (!dotGitStats.isDirectory()) {
    throw new Error('Git metadata path is not a file or directory');
  }

  const headPath = join(gitDirectory, 'HEAD');
  const head = (await readFile(headPath, 'utf8')).trim();
  const branchPrefix = 'ref: refs/heads/';
  if (head.startsWith(branchPrefix) && head.length > branchPrefix.length) {
    return {
      headPath,
      branchName: head.slice(branchPrefix.length),
    };
  }
  if (!head) {
    throw new Error('Git HEAD file was empty');
  }
  return {
    headPath,
    branchName: await getCurrentBranchDisplayName(repoPath).catch(() => null),
  };
}

export async function getGitHeadWatchState(
  repoPath: string,
): Promise<GitHeadWatchState> {
  try {
    return await getGitHeadWatchStateFromFilesystem(repoPath);
  } catch {
    return getGitHeadWatchStateWithGit(repoPath);
  }
}

export async function getComparisonDiff(
  repoPath: string,
  baseBranch: string,
): Promise<string> {
  const mergeBase = await getMergeBaseForBranch(repoPath, baseBranch);
  if (!mergeBase) {
    return '';
  }
  return runGitRaw(['diff', mergeBase, 'HEAD'], repoPath);
}

export async function getHeadCommitSha(
  repoPath: string,
): Promise<string | null> {
  try {
    const sha = await runGit(['rev-parse', 'HEAD'], repoPath);
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Git's `ext::` remote helper executes an arbitrary command, and the `--`
 * separator does not stop it: `--` only ends OPTION parsing, so `ext::sh -c
 * ...` is still honoured as a remote. `getRemoteHeadCommitSha` is reached from
 * an UNATTENDED background marketplace refresh using a persisted `sourceUrl`,
 * with no user in the loop to notice, so the transport is allowlisted here
 * rather than relying on the separator. `cloneRepo` has the same exposure but
 * is always user-initiated.
 */
const ALLOWED_GIT_REMOTE_SCHEMES = ['https', 'http', 'ssh', 'git', 'file'];

/**
 * Returns the normalized remote when its transport is allowed, otherwise
 * `null`. Callers must pass the RETURNED value to git, not the original -
 * validating one string and shelling out with another is how a guard silently
 * stops guarding.
 */
function allowedGitRemoteTransport(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed || trimmed.startsWith('-')) {
    return null;
  }
  // Windows drive-letter path (`C:\repos\x`). Checked before the scheme test,
  // which would otherwise read `C` as a scheme and reject it - leaving a
  // local-path Codex-only marketplace on Windows unable to resolve a remote
  // revision at all.
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }
  // scp-style shorthand: user@host:path (no scheme, no `::` helper syntax).
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/.test(trimmed)) {
    return trimmed;
  }
  // Require the `://` separator explicitly. `<scheme>::` is git's REMOTE-HELPER
  // syntax, not a transport: `ext::sh -c ...` runs an arbitrary command, and
  // matching a bare `:` would let `ssh::payload` inherit the allowlisted name
  // `ssh` while still selecting a helper.
  const scheme = trimmed.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//)?.[1];
  if (scheme) {
    return ALLOWED_GIT_REMOTE_SCHEMES.includes(scheme.toLowerCase())
      ? trimmed
      : null;
  }
  // GitHub `owner/repo` shorthand, the form marketplaces are commonly
  // persisted in. Without this it falls through as a bare local path and
  // `ls-remote` fails, so a Codex-only marketplace stored in shorthand could
  // never resolve a remote revision and so could never automatically escape
  // structural suppression.
  //
  // The optional `@<ref>` suffix mirrors `parseGitHubSource`
  // (`skills/source-parser.ts`), which accepts and strips it. Keep the two in
  // step: a shape that parser admits but this one rejects silently reopens the
  // gap above for that source.
  const shorthand = trimmed.match(
    /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:@[^/\s]+)?$/,
  );
  if (shorthand) {
    return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  }
  // No scheme at all: a bare local path, which is never a helper. Anything
  // still carrying `::` is helper syntax and is refused.
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) || trimmed.includes('::')
    ? null
    : trimmed;
}

export async function getRemoteHeadCommitSha(
  remote: string,
): Promise<string | null> {
  const allowedRemote = allowedGitRemoteTransport(remote);
  if (allowedRemote === null) {
    return null;
  }
  try {
    const output = await runGit(
      ['ls-remote', '--', allowedRemote, 'HEAD'],
      undefined,
      {
        nonInteractive: true,
        timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
      },
    );
    const sha = output.split(/\s+/, 1)[0];
    return sha && /^[a-fA-F0-9]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Raw unified diff of the working tree (committed + uncommitted tracked
 * changes) against the branch's merge-base with its comparison base. Falls
 * back to diffing against HEAD when no merge base resolves. Untracked files
 * are NOT included — code-review-diff.ts appends them separately.
 */
export async function getCombinedDiffText(
  repoPath: string,
  baseBranch?: string,
  resolvedMergeBase?: string | null,
): Promise<string> {
  const mergeBase =
    resolvedMergeBase === undefined
      ? await getMergeBaseForBranch(repoPath, baseBranch)
      : resolvedMergeBase;
  try {
    return await runGitRaw(['diff', mergeBase ?? 'HEAD'], repoPath);
  } catch {
    return '';
  }
}

export async function listUntrackedFiles(repoPath: string): Promise<string[]> {
  try {
    // -z emits NUL-separated raw paths; without it git C-quotes non-ASCII
    // names ("caf\303\251.txt"), which no caller expects.
    const output = await runGitRaw(
      ['ls-files', '--others', '--exclude-standard', '-z'],
      repoPath,
    );
    return output.split('\0').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export type RawDiffStatus = 'A' | 'D' | 'M' | 'T' | 'U';

export interface RawDiffEntry {
  path: string;
  status: RawDiffStatus;
  srcMode: string;
  dstMode: string;
}

export interface StrictWorkingTreeGitOptions {
  timeoutMs: number;
  signal: AbortSignal;
}

function decodeStrictGitPaths(buffer: Buffer): string[] {
  const decoded = buffer.toString('utf8');
  if (decoded.includes('\uFFFD')) {
    throw new Error('Repository contains a non-UTF-8 path');
  }
  return decoded.split('\0').filter(Boolean);
}

export async function listWorkingTreeDiffAgainstHead(
  repoPath: string,
  options: StrictWorkingTreeGitOptions,
): Promise<RawDiffEntry[]> {
  return listWorkingTreeDiffAgainstCommit(repoPath, 'HEAD', options);
}

export async function listWorkingTreeDiffAgainstCommit(
  repoPath: string,
  sha: string,
  options: StrictWorkingTreeGitOptions,
): Promise<RawDiffEntry[]> {
  const records = decodeStrictGitPaths(
    await runGitUntrimmedBuffer(
      ['diff', sha, '--raw', '-z', '--no-renames'],
      repoPath,
      options,
    ),
  );
  const result: RawDiffEntry[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const header = records[index];
    const path = records[index + 1];
    if (!header || !path) throw new Error('Git returned malformed raw diff');
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(header);
    if (!match || !['A', 'D', 'M', 'T', 'U'].includes(match[3])) {
      throw new Error(`Git returned unsupported raw diff status: ${header}`);
    }
    result.push({
      srcMode: match[1],
      dstMode: match[2],
      status: match[3] as RawDiffStatus,
      path,
    });
  }
  return result;
}

export async function listUnchangedWorkingTreePaths(
  repoPath: string,
  options: StrictWorkingTreeGitOptions,
): Promise<ReadonlySet<string>> {
  const records = decodeStrictGitPaths(
    await runGitUntrimmedBuffer(
      ['diff', 'HEAD', '--numstat', '-z', '--no-renames'],
      repoPath,
      options,
    ),
  );
  const unchanged = new Set<string>();
  for (const record of records) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Git returned malformed numstat output');
    if (match[1] === '0' && match[2] === '0') unchanged.add(match[3]);
  }
  return unchanged;
}

export async function listUntrackedFilesStrict(
  repoPath: string,
  options: StrictWorkingTreeGitOptions,
): Promise<string[]> {
  return decodeStrictGitPaths(
    await runGitUntrimmedBuffer(
      ['ls-files', '--others', '--exclude-standard', '-z'],
      repoPath,
      options,
    ),
  );
}

export async function getHeadCommitShaStrict(
  repoPath: string,
  options: StrictWorkingTreeGitOptions,
): Promise<string | null> {
  try {
    const output = await runGitUntrimmedBuffer(
      ['rev-parse', '--verify', 'HEAD'],
      repoPath,
      options,
    );
    const sha = output.toString('utf8').trim();
    if (!/^[a-fA-F0-9]{40}$/.test(sha)) {
      throw new Error('Git returned an invalid HEAD commit');
    }
    return sha;
  } catch (error) {
    try {
      await runGitUntrimmedBuffer(
        ['symbolic-ref', '-q', 'HEAD'],
        repoPath,
        options,
      );
      return null;
    } catch {
      throw error;
    }
  }
}

export async function countTrackedFiles(
  repoPath: string,
  options: StrictWorkingTreeGitOptions,
): Promise<number> {
  const launch = prepareBackgroundProcessLaunch(
    await getResolvedGitExecutableForSpawn(),
    ['ls-files', '-z'],
    false,
  );
  return new Promise<number>((resolveCount, rejectCount) => {
    const child = spawn(launch.command, launch.args, {
      cwd: repoPath,
      env: withGitRequestContextEnv(
        getEnhancedEnv({ includeCanopySecrets: false, environment: false }),
      ),
      signal: options.signal,
      timeout: options.timeoutMs,
      windowsHide: process.platform === 'win32',
    });
    if (launch.lowerPriorityAfterSpawn && typeof child.pid === 'number') {
      lowerSpawnedProcessPriority(child.pid);
    }
    let count = 0;
    let stderr = '';
    child.stdout.on('data', (value: unknown) => {
      if (!Buffer.isBuffer(value)) {
        child.kill();
        rejectCount(new Error('Git returned non-binary tracked paths'));
        return;
      }
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] === 0) count += 1;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.once('error', rejectCount);
    child.once('close', (exitCode) => {
      if (exitCode === 0) resolveCount(count);
      else
        rejectCount(new Error(stderr.trim() || 'Unable to list tracked files'));
    });
  });
}

export async function repositoryUsesGitLfs(
  repoPath: string,
  options: StrictWorkingTreeGitOptions,
): Promise<boolean> {
  const headCommit = await getHeadCommitShaStrict(repoPath, options);
  if (headCommit) {
    const headAttributes = decodeStrictGitPaths(
      await runGitUntrimmedBuffer(
        [
          'ls-tree',
          '-rz',
          '--name-only',
          headCommit,
          '--',
          '**/.gitattributes',
          '.gitattributes',
        ],
        repoPath,
        options,
      ),
    );
    for (const path of headAttributes) {
      const objectSpec = `${headCommit}:${path}`;
      const sizeBuffer = await runGitUntrimmedBuffer(
        ['cat-file', '-s', objectSpec],
        repoPath,
        options,
      );
      const sizeText = sizeBuffer.toString('utf8').trim();
      if (!/^\d+$/.test(sizeText)) {
        throw new Error('Git returned an invalid attributes blob size');
      }
      if (BigInt(sizeText) > BigInt(MAX_GIT_ATTRIBUTES_INSPECTION_BYTES)) {
        return true;
      }
      const contents = await runGitUntrimmedBuffer(
        ['cat-file', 'blob', objectSpec],
        repoPath,
        options,
      );
      if (bufferContainsLfsAttributes(contents)) return true;
    }
  }

  const workingAttributes = decodeStrictGitPaths(
    await runGitUntrimmedBuffer(
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '**/.gitattributes',
        '.gitattributes',
      ],
      repoPath,
      options,
    ),
  );
  for (const path of workingAttributes) {
    try {
      if (await fileContainsLfsAttributes(join(repoPath, path))) return true;
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
  }
  return false;
}

export type SharedContainerSymlinkTargetClassification =
  | 'in-repository'
  | 'escaping'
  | 'oversized';

export interface RepositoryTreeEntry {
  mode: string;
  type: 'blob' | 'commit' | 'tree';
  objectId: string;
  path: string;
  symlinkTarget?: string;
  symlinkEscapesRepository?: boolean;
  symlinkTargetClassification?: SharedContainerSymlinkTargetClassification;
}

export function decodeUtf8SymlinkTarget(
  bytes: Uint8Array,
  errorMessage: string,
): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(errorMessage);
  }
}

export function isInRepositorySymlinkTarget(
  linkPath: string,
  target: string,
): boolean {
  if (
    target.length === 0 ||
    target.includes('\0') ||
    posix.isAbsolute(target) ||
    /^[A-Za-z]:/.test(target)
  ) {
    return false;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(linkPath), target));
  return resolved !== '..' && !resolved.startsWith('../');
}

// macOS rejects symlink targets at or above its 1 KiB path limit. Keep the
// publisher and every recipient path below that host boundary so an accepted
// target is materializable rather than becoming an OS-dependent failure.
export const MAX_SHARED_CONTAINER_SYMLINK_TARGET_BYTES = 1023;

export function classifySharedContainerSymlinkTarget(
  linkPath: string,
  target: string,
): SharedContainerSymlinkTargetClassification {
  if (!isInRepositorySymlinkTarget(linkPath, target)) return 'escaping';
  if (
    Buffer.byteLength(target, 'utf8') >
    MAX_SHARED_CONTAINER_SYMLINK_TARGET_BYTES
  ) {
    return 'oversized';
  }
  return 'in-repository';
}

export async function inspectRepositoryTreeEntryKinds(
  repoPath: string,
  options: StrictWorkingTreeGitOptions,
): Promise<RepositoryTreeEntry[]> {
  const records = decodeStrictGitPaths(
    await runGitUntrimmedBuffer(
      ['ls-tree', '-rz', '--full-tree', 'HEAD'],
      repoPath,
      options,
    ),
  );
  const entries: RepositoryTreeEntry[] = [];
  for (const record of records) {
    const match =
      /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`Git returned malformed tree entry: ${record}`);
    const entry: RepositoryTreeEntry = {
      mode: match[1],
      type: match[2] as RepositoryTreeEntry['type'],
      objectId: match[3],
      path: match[4],
    };
    if (entry.mode !== '120000') {
      entries.push(entry);
      continue;
    }
    const sizeBuffer = await runGitUntrimmedBuffer(
      ['cat-file', '-s', entry.objectId],
      repoPath,
      options,
    );
    const sizeText = sizeBuffer.toString('utf8').trim();
    if (!/^\d+$/.test(sizeText)) {
      throw new Error('Git returned an invalid symlink blob size');
    }
    if (BigInt(sizeText) > BigInt(MAX_SHARED_CONTAINER_SYMLINK_TARGET_BYTES)) {
      entries.push({
        ...entry,
        symlinkTargetClassification: 'oversized',
      });
      continue;
    }
    const targetBuffer = await runGitUntrimmedBuffer(
      ['cat-file', 'blob', entry.objectId],
      repoPath,
      options,
    );
    const target = decodeUtf8SymlinkTarget(
      targetBuffer,
      'Repository contains a non-UTF-8 symlink target',
    );
    const classification = classifySharedContainerSymlinkTarget(
      entry.path,
      target,
    );
    entries.push({
      ...entry,
      symlinkTarget: target,
      symlinkEscapesRepository: classification === 'escaping',
      symlinkTargetClassification: classification,
    });
  }
  return entries;
}

export async function persistTurnDiffTreeRef(
  repoPath: string,
  projectId: string,
  worktreeId: string,
  treeSha: string,
): Promise<void> {
  if (!GIT_OBJECT_ID_RE.test(treeSha)) {
    throw new Error('Invalid tree SHA');
  }

  await runGit(
    [
      'update-ref',
      buildTurnDiffRefName(projectId, worktreeId, treeSha),
      treeSha,
    ],
    repoPath,
  );
}

export async function cleanupPersistedTurnDiffTreeRefs(
  repoPath: string,
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const refPrefix = buildTurnDiffRefPrefix(projectId, worktreeId);
  const output = await runGit(
    ['for-each-ref', '--format=%(refname)', refPrefix],
    repoPath,
  );
  const refs = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  // Archive holds storage admission until every started deletion settles.
  await settleAll(
    refs.map((refName) => runGit(['update-ref', '-d', refName], repoPath)),
  );
}

export { appendBranchSuffix };

export async function doesLocalBranchExist(
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  try {
    await runGit(
      ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
      repoPath,
    );
    return true;
  } catch {
    return false;
  }
}

export async function doesRemoteBranchExist(
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  try {
    await runGit(
      ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branchName}`],
      repoPath,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch one origin branch into its tracking ref, for a branch that was pushed
 * after the last fetch (a just-opened pull request's head). Rejects when the
 * fetch fails; the checkout policy reads that as a missing branch.
 */
async function fetchOriginBranchRef(
  repoPath: string,
  branchName: string,
): Promise<void> {
  await runGit(
    [
      'fetch',
      '--no-tags',
      'origin',
      `refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
    ],
    repoPath,
    {
      signal: AbortSignal.timeout(SHARED_CONTAINER_GIT_REMOTE_TIMEOUT_MS),
      nonInteractive: true,
    },
  );
}

/**
 * Resolve an origin branch against the live remote instead of trusting the
 * local tracking ref, which may remain after the branch was deleted remotely.
 * Transport/authentication failures intentionally propagate so callers can
 * distinguish an inconclusive probe from a confirmed missing branch.
 */
export async function getLiveOriginBranchSha(
  repoPath: string,
  branchName: string,
): Promise<string | null> {
  const refName = `refs/heads/${branchName}`;
  const signal = AbortSignal.timeout(SHARED_CONTAINER_GIT_REMOTE_TIMEOUT_MS);
  const output = await runGit(
    ['ls-remote', '--heads', 'origin', refName],
    repoPath,
    { signal, nonInteractive: true },
  );
  for (const line of output.split('\n')) {
    const [sha, resolvedRefName] = line.trim().split(/\s+/, 2);
    if (
      resolvedRefName === refName &&
      typeof sha === 'string' &&
      /^[0-9a-f]{40}$/i.test(sha)
    ) {
      await runGit(['fetch', '--no-tags', 'origin', refName], repoPath, {
        signal,
        nonInteractive: true,
      });
      // Verify the advertised object directly. FETCH_HEAD is shared mutable
      // state for the worktree and may be rewritten by an unrelated background
      // fetch between these commands.
      await runGit(['cat-file', '-e', `${sha}^{commit}`], repoPath, {
        signal,
        nonInteractive: true,
      });
      return sha;
    }
  }
  return null;
}

async function listOriginBranchNames(
  repoPath: string,
  patterns: string[],
): Promise<string[]> {
  if (patterns.length === 0) {
    return [];
  }

  try {
    const output = await runGit(
      ['ls-remote', '--heads', 'origin', ...patterns],
      repoPath,
      { timeoutMs: WORKTREE_GIT_TIMEOUT_MS },
    );

    return output
      .split('\n')
      .map((line) => line.trim().split('\t')[1])
      .filter((refName): refName is string =>
        Boolean(refName?.startsWith('refs/heads/')),
      )
      .map((refName) => refName.slice('refs/heads/'.length));
  } catch {
    return [];
  }
}

export async function doesOriginBranchExist(
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  if (await doesRemoteBranchExist(repoPath, branchName)) {
    return true;
  }

  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) {
    return false;
  }

  const parents = parentBranchNames(branchName);
  const descendantPattern = `${branchName}/*`;
  const descendantPrefix = `${branchName}/`;
  const originBranchNames = await listOriginBranchNames(repoPath, [
    branchName,
    descendantPattern,
    ...parents,
  ]);

  return originBranchNames.some(
    (originBranchName) =>
      originBranchName === branchName ||
      originBranchName.startsWith(descendantPrefix) ||
      parents.includes(originBranchName),
  );
}

function normalizeBranchName(
  branchName: string | null | undefined,
): string | null {
  const trimmed = branchName?.trim();
  return trimmed ? trimmed : null;
}

async function listLocalBranchNames(repoPath: string): Promise<string[]> {
  const output = await runGit(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
    repoPath,
  );
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== 'HEAD');
}

function getLocalDefaultBranchCandidateRank(branchName: string): number {
  const normalized = branchName.toLowerCase();
  if (normalized === 'main') {
    return 0;
  }
  if (normalized === 'master') {
    return 1;
  }
  if (normalized === 'develop') {
    return 2;
  }
  if (normalized === 'dev') {
    return 3;
  }
  if (normalized === 'trunk') {
    return 4;
  }
  if (normalized === 'release') {
    return 5;
  }
  if (normalized.startsWith('release/')) {
    return 6;
  }
  if (!branchName.includes('/')) {
    return 10;
  }
  return 20;
}

async function resolveExistingBranchRef(
  repoPath: string,
  branchName: string,
): Promise<string | null> {
  if (await doesRemoteBranchExist(repoPath, branchName)) {
    return `origin/${branchName}`;
  }

  if (await doesLocalBranchExist(repoPath, branchName)) {
    return branchName;
  }

  return null;
}

async function resolveComparisonBaseRef(
  repoPath: string,
  baseBranch?: string,
): Promise<string | null> {
  const normalizedBaseBranch = normalizeBranchName(baseBranch);
  if (normalizedBaseBranch) {
    const explicitRef = await resolveExistingBranchRef(
      repoPath,
      normalizedBaseBranch,
    );
    if (explicitRef) {
      return explicitRef;
    }
  }

  const defaultBranch = normalizeBranchName(
    await getRemoteDefaultBranch(repoPath).catch(() => null),
  );
  if (!defaultBranch) {
    return null;
  }

  return resolveExistingBranchRef(repoPath, defaultBranch);
}

export async function getMergeBaseForBranch(
  repoPath: string,
  baseBranch?: string,
): Promise<string | null> {
  const comparisonBaseRef = await resolveComparisonBaseRef(
    repoPath,
    baseBranch,
  );
  if (!comparisonBaseRef) {
    return null;
  }

  try {
    const mergeBase = await runGit(
      ['merge-base', comparisonBaseRef, 'HEAD'],
      repoPath,
    );
    return mergeBase.trim() || null;
  } catch {
    return null;
  }
}

export async function listRemoteTrackingCandidates(
  repoPath: string,
  effectiveBaseBranch?: string,
): Promise<string[]> {
  const branch = await getCurrentBranch(repoPath).catch(() => null);
  const candidates: string[] = [];
  if (branch) {
    const upstream = await runGit(
      ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`],
      repoPath,
    ).catch(() => '');
    if (upstream) candidates.push(upstream);
    candidates.push(`origin/${branch}`);
  }
  if (effectiveBaseBranch) {
    candidates.push(
      effectiveBaseBranch.startsWith('origin/')
        ? effectiveBaseBranch
        : `origin/${effectiveBaseBranch}`,
    );
  }
  candidates.push('origin/HEAD');
  const existing: string[] = [];
  for (const candidate of Array.from(new Set(candidates))) {
    const resolved = await runGit(
      ['rev-parse', '--verify', `${candidate}^{commit}`],
      repoPath,
    ).catch(() => '');
    if (/^[a-fA-F0-9]{40}$/.test(resolved)) existing.push(candidate);
  }
  return existing;
}

/**
 * Read the local SHA a push/fetch last recorded for the current branch.
 *
 * The diff-stats sweep calls this frequently, so it deliberately performs no
 * network I/O and resolves exactly one commit ref: the configured upstream,
 * falling back to `origin/<branch>` when no upstream is configured.
 */
export async function getRemoteTrackingCommitSha(
  repoPath: string,
): Promise<string | null> {
  const branch = await getCurrentBranch(repoPath).catch(() => null);
  if (!branch || branch === 'HEAD') return null;
  const upstream = await runGit(
    ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`],
    repoPath,
  ).catch(() => '');
  const ref = upstream || `origin/${branch}`;
  const sha = await runGit(
    ['rev-parse', '--verify', `${ref}^{commit}`],
    repoPath,
  ).catch(() => '');
  return /^[a-fA-F0-9]{40}$/.test(sha) ? sha : null;
}

export async function mergeBase(
  repoPath: string,
  a: string,
  b: string,
): Promise<string | null> {
  const result = await runGit(['merge-base', a, b], repoPath).catch(() => '');
  return /^[a-fA-F0-9]{40}$/.test(result) ? result : null;
}

export async function countCommits(
  repoPath: string,
  range: string,
): Promise<number> {
  const result = await runGit(['rev-list', '--count', range], repoPath);
  const count = Number.parseInt(result, 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Git returned an invalid commit count');
  }
  return count;
}

export async function listTrackedFiles(
  cwd: string,
  options?: {
    pathspecs: string[];
    maxBuffer: number;
    timeoutMs: number;
    /** List only index entries, without untracked files. */
    cachedOnly?: boolean;
  },
): Promise<string[]> {
  const output = await runGit(
    [
      ...(options
        ? ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']
        : []),
      'ls-files',
      '--cached',
      ...(options?.cachedOnly ? [] : ['--others', '--exclude-standard']),
      ...(options ? ['-z', '--', ...options.pathspecs] : []),
    ],
    cwd,
    options ? { ...options, preserveWhitespace: true } : undefined,
  );
  return output.split(options ? '\0' : '\n').filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorExitCode(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const code = error.code;
  return typeof code === 'number' ? code : null;
}

function normalizeExecFileStdout(stdout: unknown): string {
  if (typeof stdout === 'string') {
    return stdout;
  }
  if (Buffer.isBuffer(stdout)) {
    return stdout.toString('utf8');
  }
  if (isRecord(stdout)) {
    return normalizeExecFileStdout(stdout.stdout);
  }
  return '';
}

function normalizeRejectedError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  return new Error('git check-ignore failed');
}

async function checkIgnoredPathChunk(
  cwd: string,
  relativePaths: string[],
): Promise<Set<string>> {
  if (relativePaths.length === 0) {
    return new Set();
  }

  const input = `${relativePaths.join('\0')}\0`;
  const executable = await getResolvedGitExecutableForSpawn();
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      executable,
      ['check-ignore', '-z', '--stdin'],
      {
        cwd,
        maxBuffer: 1024 * 1024 * 8,
        windowsHide: process.platform === 'win32',
      },
      (error, stdout) => {
        const output = normalizeExecFileStdout(stdout);
        const ignoredPaths = new Set(output.split('\0').filter(Boolean));
        if (!error) {
          resolvePromise(ignoredPaths);
          return;
        }
        if (getErrorExitCode(error) === 1) {
          resolvePromise(new Set());
          return;
        }
        reject(normalizeRejectedError(error));
      },
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(input);
  });
}

export async function checkIgnoredPaths(
  cwd: string,
  relativePaths: string[],
): Promise<Set<string>> {
  const ignoredPaths = new Set<string>();
  for (let i = 0; i < relativePaths.length; i += CHECK_IGNORE_CHUNK_SIZE) {
    const chunk = relativePaths.slice(i, i + CHECK_IGNORE_CHUNK_SIZE);
    const ignoredChunk = await checkIgnoredPathChunk(cwd, chunk);
    ignoredChunk.forEach((relativePath) => {
      ignoredPaths.add(relativePath);
    });
  }
  return ignoredPaths;
}

/**
 * Ignored untracked paths under `cwd`, relative to it, from one pass over the
 * working tree. A directory ignored as a whole is a single entry ending in
 * `/`, so the listing stays small. Use this for a whole-tree index:
 * `git check-ignore` tests paths one at a time (about 1.5 ms each in a large
 * repository, minutes for 150,000 files). Both report only untracked paths
 * under the standard exclude sources.
 */
export async function listIgnoredPathEntries(cwd: string): Promise<string[]> {
  const executable = await getResolvedGitExecutableForSpawn();
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
      ],
      {
        cwd,
        maxBuffer: IGNORED_LISTING_MAX_BUFFER_BYTES,
        windowsHide: process.platform === 'win32',
      },
      (error, stdout) => {
        if (error) {
          reject(normalizeRejectedError(error));
          return;
        }
        resolvePromise(
          normalizeExecFileStdout(stdout).split('\0').filter(Boolean),
        );
      },
    );
  });
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--git-dir'], dir);
    return true;
  } catch {
    return false;
  }
}

export async function getRepoName(dir: string): Promise<string> {
  const topLevelPath = await runGit(['rev-parse', '--show-toplevel'], dir);
  return basename(topLevelPath);
}

/**
 * Build the `git` argv for a clone.
 *
 * When `followRedirects` is false, `-c http.followRedirects=false` is placed
 * BEFORE the `clone` subcommand — the only position git honors a config
 * override — which refuses ALL HTTP redirects for this clone. That is the SSRF
 * defense the initial-URL allowlist cannot provide: an attacker-influenceable
 * https URL can pass address validation and then 3xx-redirect git to a
 * loopback/private/link-local host, which is never revalidated. `--` ends
 * option parsing so a hostile `url` (e.g. `--upload-pack=…`) cannot be read as
 * a git flag (argument injection).
 *
 * Exported for a deterministic command-construction test.
 */
export function buildCloneRepoArgs(
  url: string,
  destination: string,
  followRedirects: boolean,
  cloneFlags: readonly string[] = [],
): string[] {
  return [
    ...(followRedirects ? [] : ['-c', 'http.followRedirects=false']),
    'clone',
    ...cloneFlags,
    '--',
    url,
    destination,
  ];
}

export async function cloneRepo(
  url: string,
  destination: string,
  options?: {
    followRedirects?: boolean;
    nonInteractive?: boolean;
    skipLfsSmudge?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<void> {
  // Default stays redirect-following so unrelated callers (workspace/repo
  // clones of trusted remotes) are unchanged; only callers that pass
  // `followRedirects: false` (the portal external-install path) refuse them.
  await runGit(
    buildCloneRepoArgs(url, destination, options?.followRedirects !== false),
    undefined,
    {
      nonInteractive: options?.nonInteractive === true,
      skipLfsSmudge: options?.skipLfsSmudge === true,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    },
  );
}

const CLONE_STDERR_TAIL_BYTES = 16 * 1024;
const CLONE_TERMINATE_GRACE_MS = 3_000;

/**
 * `cloneRepo` for the interactive Add project flow: identical environment,
 * redirect policy, and checkout, plus live `--progress` reporting and
 * cancellation that reaches git's helper processes (`git-remote-https`,
 * `index-pack`). On POSIX git runs in its own process group so an abort can
 * signal the whole tree; SIGTERM lets git remove its partial directory, and
 * SIGKILL follows if it does not exit promptly. On Windows the tree is ended
 * with `taskkill /T`. The promise settles only after git has exited, so a
 * caller can safely remove the destination afterwards.
 */
export async function cloneRepoWithLiveProgress(
  url: string,
  destination: string,
  options: {
    signal?: AbortSignal;
    onProgress: (update: GitCloneProgressUpdate) => void;
  },
): Promise<void> {
  if (options.signal?.aborted) throw new Error('Clone cancelled');
  const executable = await getResolvedGitExecutableForSpawn();
  if (options.signal?.aborted) throw new Error('Clone cancelled');
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      executable,
      buildCloneRepoArgs(url, destination, true, ['--progress']),
      {
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: withGitRequestContextEnv(
          getEnhancedEnv({ includeCanopySecrets: false, environment: false }),
        ),
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let tail = '';
    let pending = '';
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined || child.exitCode !== null) return;
      if (process.platform === 'win32') {
        execFile(
          'taskkill',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          (): void => undefined,
        );
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* Already exited. */
      }
    };
    const abort = (): void => {
      if (aborted) return;
      aborted = true;
      signalTree('SIGTERM');
      killTimer = setTimeout(
        () => signalTree('SIGKILL'),
        CLONE_TERMINATE_GRACE_MS,
      );
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const cleanUp = (): void => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string): void => {
      tail = (tail + chunk).slice(-CLONE_STDERR_TAIL_BYTES);
      pending += chunk;
      const lines = pending.split(/[\r\n]/);
      pending = (lines.pop() ?? '').slice(-CLONE_STDERR_TAIL_BYTES);
      for (const line of lines) {
        const update = parseGitCloneProgressLine(line);
        if (update) options.onProgress(update);
      }
    });
    child.once('error', (error): void => {
      cleanUp();
      reject(error);
    });
    child.once('close', (code, signal): void => {
      cleanUp();
      if (aborted) {
        reject(new Error('Clone cancelled'));
        return;
      }
      if (code === 0) {
        resolvePromise();
        return;
      }
      const explanation = tail
        .split(/[\r\n]/)
        .filter((line) => !isGitCloneProgressLine(line))
        .join('\n')
        .trim();
      reject(
        new Error(
          redactRemoteUrlCredentialsInText(explanation) ||
            `git clone exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`,
        ),
      );
    });
  });
}

interface BoundedRemoteGitOptions {
  nonInteractive?: boolean;
  skipLfsSmudge?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Initialize a managed checkout without downloading repository history or
 * blobs outside one validated commit. The filtered, depth-one fetch leaves the
 * worktree empty; the caller can inspect its publisher-independent budget
 * before checkout lazily downloads the already-accounted blobs.
 */
export async function cloneRepoAtCommit(
  url: string,
  destination: string,
  commitSha: string,
  options: BoundedRemoteGitOptions = {},
): Promise<void> {
  if (!/^[a-fA-F0-9]{40}$/.test(commitSha)) {
    throw new Error('A full commit SHA is required for a bounded clone');
  }
  const runOptions = {
    nonInteractive: options.nonInteractive === true,
    skipLfsSmudge: options.skipLfsSmudge === true,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  };
  await runGit(['init', '--', destination], undefined, runOptions);
  await runGit(['remote', 'add', 'origin', url], destination, runOptions);
  await fetchRemoteCommit(destination, commitSha, options);
}

/** Fetch only one commit graph/tree, deferring its blobs until checkout. */
export async function fetchRemoteCommit(
  repoPath: string,
  commitSha: string,
  options: BoundedRemoteGitOptions = {},
): Promise<void> {
  if (!/^[a-fA-F0-9]{40}$/.test(commitSha)) {
    throw new Error('A full commit SHA is required for a bounded fetch');
  }
  await runGit(
    ['fetch', '--depth=1', '--filter=blob:none', 'origin', commitSha],
    repoPath,
    {
      nonInteractive: options.nonInteractive === true,
      skipLfsSmudge: options.skipLfsSmudge === true,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    },
  );
}

/** Initialize a local repository from the fixed ref in a verified snapshot bundle. */
export async function initializeRepoFromSnapshotBundle(
  bundlePath: string,
  destination: string,
  commitSha: string,
  options: BoundedRemoteGitOptions = {},
): Promise<void> {
  if (!/^[a-fA-F0-9]{40}$/.test(commitSha)) {
    throw new Error('A full commit SHA is required for a snapshot bundle');
  }
  const runOptions = {
    nonInteractive: true,
    skipLfsSmudge: true,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  };
  await runGit(['init', '--', destination], undefined, runOptions);
  await runGit(
    ['fetch', '--no-tags', bundlePath, 'refs/heads/snapshot'],
    destination,
    runOptions,
  );
  await runGit(
    ['cat-file', '-e', `${commitSha}^{commit}`],
    destination,
    runOptions,
  );
}

/**
 * Realize the blobs a two-commit diff needs, in one bounded pass.
 *
 * A shared-container replica is a `--filter=blob:none` partial clone whose tree
 * is sealed read-only once materialization finishes, so git can no longer write
 * lazily fetched objects at read time. Walking the diff here — while the tree is
 * still writable — hydrates exactly the blobs the changed paths need and nothing
 * else, so later committed-file reads are purely local (CAN-2551).
 *
 * The cost is bounded by the size of the branch's own diff, not by the
 * repository, which is why the whole tree is still never un-filtered.
 */
export async function warmCommitRangeDiffObjects(
  repoPath: string,
  oldCommitSha: string,
  newCommitSha: string,
  options: BoundedRemoteGitOptions = {},
): Promise<void> {
  if (
    !/^[a-fA-F0-9]{40}$/.test(oldCommitSha) ||
    !/^[a-fA-F0-9]{40}$/.test(newCommitSha)
  ) {
    throw new Error('Full commit SHAs are required to warm a diff range');
  }
  // The warm decides which blobs get hydrated, so its object view must match
  // the reader's exactly — every read-side call in this file disables object
  // replacement, and a mismatch here would leave the reader hitting missing
  // blobs behind a marker that says the range is ready (CAN-2551).
  await runGit(
    [
      'diff',
      '--numstat',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      oldCommitSha,
      newCommitSha,
    ],
    repoPath,
    {
      nonInteractive: options.nonInteractive === true,
      skipLfsSmudge: options.skipLfsSmudge === true,
      disableReplaceObjects: true,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    },
  );
}

/**
 * Materialize the literal blobs stored by a commit without invoking checkout,
 * clean/smudge filters, EOL conversion, or working-tree encodings.
 */
export async function materializeGitCommitRaw(
  repoPath: string,
  commitSha: string,
  options: MaterializeGitCommitRawOptions,
): Promise<RawGitTreeUsage> {
  if (!/^[a-fA-F0-9]{40}$/.test(commitSha)) {
    throw new Error('A full commit SHA is required for raw materialization');
  }
  const deadline =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? Date.now() + options.timeoutMs
      : null;
  const remainingTimeout = (): number | undefined => {
    if (deadline === null) return undefined;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('Raw Git materialization timed out');
    }
    return remaining;
  };
  const entries = (await readdir(repoPath)).filter((entry) => entry !== '.git');
  await Promise.all(
    entries.map((entry) =>
      rm(join(repoPath, entry), { recursive: true, force: true }),
    ),
  );
  const localOnlyGitConfig =
    options.allowPromisorFetch === false
      ? ['-c', 'remote.origin.promisor=false']
      : [];
  const listing = await runGit(
    [...localOnlyGitConfig, 'ls-tree', '-rz', '--full-tree', commitSha],
    repoPath,
    {
      signal: options.signal,
      timeoutMs: remainingTimeout(),
      nonInteractive: true,
      skipLfsSmudge: true,
      disableReplaceObjects: true,
    },
  );
  const records = listing.split('\0').filter(Boolean);
  if (options.maxFiles !== undefined && records.length > options.maxFiles) {
    throw new Error('Raw Git tree exceeds the materialized file limit');
  }
  const blobs = records
    .map((record) => {
      const tab = record.indexOf('\t');
      const header = tab >= 0 ? record.slice(0, tab) : '';
      const relativePath = tab >= 0 ? record.slice(tab + 1) : '';
      const match = /^(100644|100755|120000) blob ([a-f0-9]{40,64})$/.exec(
        header,
      );
      if (!match) {
        throw new Error('Raw Git tree contains an unsupported entry');
      }
      return {
        mode: match[1] as '100644' | '100755' | '120000',
        objectId: match[2],
        relativePath,
        destination: options.resolveDestination(relativePath),
      };
    })
    .sort(
      (left, right) =>
        Number(left.mode === '120000') - Number(right.mode === '120000'),
    );
  if (options.rejectSymlinks && blobs.some((blob) => blob.mode === '120000')) {
    throw new RawGitTreeSymlinkUnsupportedError();
  }

  const isPromisorRemote = await runGit(
    [
      'config',
      '--bool',
      '--default',
      'false',
      '--get',
      'remote.origin.promisor',
    ],
    repoPath,
    { timeoutMs: remainingTimeout() },
  ).then((value) => value === 'true');
  if (
    options.allowPromisorFetch !== false &&
    isPromisorRemote &&
    blobs.length > 0
  ) {
    await runGit(
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--stdin',
        'origin',
      ],
      repoPath,
      {
        stdin: `${Array.from(new Set(blobs.map(({ objectId }) => objectId))).join('\n')}\n`,
        signal: options.signal,
        timeoutMs: remainingTimeout(),
        nonInteractive: true,
        skipLfsSmudge: true,
        disableReplaceObjects: true,
      },
    );
  }
  if (blobs.length === 0) {
    return { fileCount: 0, totalBytes: BigInt(0) };
  }

  const launch = prepareBackgroundProcessLaunch(
    await getResolvedGitExecutableForSpawn(),
    [...localOnlyGitConfig, 'cat-file', '--batch'],
    false,
  );
  const child = spawn(launch.command, launch.args, {
    cwd: repoPath,
    env: {
      ...withGitRequestContextEnv(
        getEnhancedEnv({ includeCanopySecrets: false, environment: false }),
      ),
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_LFS_SKIP_SMUDGE: '1',
      ...(options.allowPromisorFetch === false
        ? { GIT_NO_LAZY_FETCH: '1' }
        : {}),
    },
    signal: options.signal,
    timeout: remainingTimeout(),
    windowsHide: process.platform === 'win32',
  });
  if (launch.lowerPriorityAfterSpawn && typeof child.pid === 'number') {
    lowerSpawnedProcessPriority(child.pid);
  }
  child.stdin.on('error', () => undefined);
  child.stdin.end(`${blobs.map(({ objectId }) => objectId).join('\n')}\n`);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  const childCompletion = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  void childCompletion.catch(() => undefined);
  const stdout = child.stdout[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  const fillPending = async (): Promise<void> => {
    const next = await stdout.next();
    if (next.done) {
      throw new Error(stderr.trim() || 'Raw Git blob stream ended early');
    }
    const value: unknown = next.value;
    if (!Buffer.isBuffer(value)) {
      throw new Error('Raw Git blob stream returned invalid data');
    }
    const chunk = Buffer.from(value);
    pending =
      pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
  };
  const readHeader = async (): Promise<string> => {
    let newline = pending.indexOf(0x0a);
    while (newline < 0) {
      if (pending.byteLength > 256) {
        throw new Error('Raw Git blob header is invalid');
      }
      await fillPending();
      newline = pending.indexOf(0x0a);
    }
    const header = pending.subarray(0, newline).toString('ascii');
    pending = pending.subarray(newline + 1);
    return header;
  };
  const writeBlob = async (
    handle: Awaited<ReturnType<typeof open>>,
    size: bigint,
  ): Promise<void> => {
    let remaining = size;
    while (remaining > BigInt(0)) {
      if (pending.byteLength === 0) await fillPending();
      const length =
        remaining < BigInt(pending.byteLength)
          ? Number(remaining)
          : pending.byteLength;
      const bytes = pending.subarray(0, length);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, offset);
        if (bytesWritten === 0) {
          throw new Error('Unable to persist raw Git blob');
        }
        offset += bytesWritten;
      }
      pending = pending.subarray(length);
      remaining -= BigInt(length);
    }
    if (pending.byteLength === 0) await fillPending();
    if (pending[0] !== 0x0a) {
      throw new Error('Raw Git blob separator is invalid');
    }
    pending = pending.subarray(1);
  };
  const readBlob = async (size: bigint): Promise<Buffer | null> => {
    const bytes =
      size <= BigInt(MAX_SHARED_CONTAINER_SYMLINK_TARGET_BYTES)
        ? Buffer.alloc(Number(size))
        : null;
    let remaining = size;
    let offset = 0;
    while (remaining > BigInt(0)) {
      if (pending.byteLength === 0) await fillPending();
      const length =
        remaining < BigInt(pending.byteLength)
          ? Number(remaining)
          : pending.byteLength;
      if (bytes) pending.copy(bytes, offset, 0, length);
      pending = pending.subarray(length);
      offset += length;
      remaining -= BigInt(length);
    }
    if (pending.byteLength === 0) await fillPending();
    if (pending[0] !== 0x0a) {
      throw new Error('Raw Git blob separator is invalid');
    }
    pending = pending.subarray(1);
    return bytes;
  };

  let totalBytes = BigInt(0);
  try {
    for (const blob of blobs) {
      remainingTimeout();
      const header = await readHeader();
      const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(header);
      if (!match || match[1] !== blob.objectId) {
        throw new Error('Raw Git blob header is invalid');
      }
      const blobBytes = BigInt(match[2]);
      totalBytes += blobBytes;
      if (options.maxBytes !== undefined && totalBytes > options.maxBytes) {
        throw new Error('Raw Git tree exceeds the materialized byte limit');
      }
      await mkdir(dirname(blob.destination), { recursive: true });
      const temporaryPath = `${blob.destination}.canopy-raw-${randomUUID()}`;
      if (blob.mode === '120000') {
        const targetBytes = await readBlob(blobBytes);
        if (!targetBytes) continue;
        const target = decodeUtf8SymlinkTarget(
          targetBytes,
          'Raw Git tree contains a non-UTF-8 symlink target',
        );
        if (
          classifySharedContainerSymlinkTarget(blob.relativePath, target) !==
          'in-repository'
        ) {
          continue;
        }
        await symlink(target, temporaryPath);
        try {
          await rename(temporaryPath, blob.destination);
        } finally {
          await rm(temporaryPath, { force: true });
        }
        continue;
      }
      const handle = await open(
        temporaryPath,
        'wx',
        blob.mode === '100755' ? 0o755 : 0o644,
      );
      try {
        await writeBlob(handle, blobBytes);
        await handle.close();
        await rename(temporaryPath, blob.destination);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temporaryPath, { force: true });
        throw error;
      }
    }
    const exitCode = await childCompletion;
    if (exitCode !== 0) {
      throw new Error(stderr.trim() || 'Unable to read raw Git blobs');
    }
  } catch (error) {
    child.kill();
    await childCompletion.catch(() => undefined);
    throw error;
  }
  return { fileCount: records.length, totalBytes };
}

export async function fetchOrigin(
  repoPath: string,
  options: Parameters<typeof fetchAvailableOrigin>[1] = {},
): Promise<void> {
  // Only automatic observations may silently skip an unavailable target.
  // Explicit and lifecycle fetches keep their ordinary Git success/error contract.
  if (options.ttlMs !== undefined) {
    const { withGitReadPath } = await import('./worktree-read-availability');
    return withGitReadPath(repoPath, undefined, () =>
      fetchAvailableOrigin(repoPath, options),
    );
  }
  return fetchAvailableOrigin(repoPath, options);
}

async function fetchAvailableOrigin(
  repoPath: string,
  options: {
    prune?: boolean;
    signal?: AbortSignal;
    ttlMs?: number;
    backgroundPriority?: boolean;
    nonInteractive?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const prune = options.prune === true;
  // Deduplicate concurrent fetches per git common dir, but keep pruned and
  // non-pruned fetches on separate keys: a caller that needs stale
  // `origin/<b>` refs pruned must not be satisfied by an in-flight
  // non-pruning fetch that leaves them behind.
  const commonDir = await getGitCommonDir(repoPath).catch(() => repoPath);
  const fetchKey = prune ? `${commonDir}#prune` : commonDir;
  const originUrl = await resolveFetchOriginUrl(commonDir, repoPath);
  const stateKey = fetchOriginStateKey(fetchKey, originUrl);
  const fetchIdentity: GitFetchFreshnessIdentity | null = originUrl
    ? { commonDir, originUrl, prune }
    : null;
  let freshnessIdentity: GitFetchFreshnessIdentity | null = null;
  // `ttlMs` callers (periodic diff-stats refresh) accept bounded staleness:
  // every worktree of a repo shares the same common dir, so without a TTL a
  // fleet of worktrees re-fetches the same remote once per poll cycle each.
  // User-initiated flows (push/pull/branch dialogs) omit `ttlMs` and always
  // fetch. Successful automatic freshness is advisory and durable across app
  // relaunches; origin identity is part of validation so a changed remote is a
  // cold miss. Failed automatic fetches use a shorter process-local and durable
  // retry window so an offline machine is not retried on every poll tick.
  if (options.ttlMs !== undefined) {
    const now = Date.now();
    const retryAfterAt = fetchOriginRetryAfterAtMs.get(stateKey);
    if (retryAfterAt !== undefined && now < retryAfterAt) {
      return;
    }
    const completedAt = fetchOriginCompletedAtMs.get(stateKey);
    if (completedAt !== undefined && now - completedAt < options.ttlMs) {
      return;
    }

    freshnessIdentity = fetchIdentity;
    if (freshnessIdentity) {
      const durableFreshness = await readGitFetchFreshness(
        freshnessIdentity,
      ).catch(() => null);
      const durableRetryAfterAt = Date.parse(
        durableFreshness?.retryAfterAt ?? '',
      );
      if (Number.isFinite(durableRetryAfterAt)) {
        if (now < durableRetryAfterAt) {
          fetchOriginRetryAfterAtMs.set(stateKey, durableRetryAfterAt);
          return;
        }
      } else {
        const durableSuccessAt = Date.parse(
          durableFreshness?.lastSuccessAt ?? '',
        );
        if (
          Number.isFinite(durableSuccessAt) &&
          now - durableSuccessAt < options.ttlMs
        ) {
          fetchOriginCompletedAtMs.set(stateKey, durableSuccessAt);
          return;
        }
      }
    }
  }
  const activeFetch = fetchOriginPromises.get(stateKey);
  if (activeFetch) {
    try {
      await waitForPromiseWithSignal(activeFetch, options.signal);
    } catch (error) {
      if (options.signal === undefined) {
        return;
      }
      await invalidateFetchOriginFreshness(commonDir, originUrl);
      throw error;
    }
    return;
  }

  const args = prune ? ['fetch', '--prune', 'origin'] : ['fetch', 'origin'];
  if (options.signal !== undefined) {
    try {
      await runGit(args, repoPath, {
        signal: options.signal,
        backgroundPriority: options.backgroundPriority,
        nonInteractive: options.nonInteractive,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      await invalidateFetchOriginFreshness(commonDir, originUrl);
      throw error;
    }
    const succeededAt = Date.now();
    fetchOriginCompletedAtMs.set(stateKey, succeededAt);
    fetchOriginRetryAfterAtMs.delete(stateKey);
    if (freshnessIdentity) {
      await recordGitFetchSuccess({
        identity: freshnessIdentity,
        succeededAt,
      }).catch(() => undefined);
    }
    return;
  }
  const fetchPromise = runGit(args, repoPath, {
    backgroundPriority: options.backgroundPriority,
    nonInteractive: options.nonInteractive,
    timeoutMs: options.timeoutMs,
  })
    .then(async () => {
      const succeededAt = Date.now();
      fetchOriginCompletedAtMs.set(stateKey, succeededAt);
      fetchOriginRetryAfterAtMs.delete(stateKey);
      if (freshnessIdentity) {
        await recordGitFetchSuccess({
          identity: freshnessIdentity,
          succeededAt,
        }).catch(() => undefined);
      }
    })
    .catch(async (error: unknown) => {
      const failedAt = Date.now();
      if (freshnessIdentity) {
        const fallbackRetryAfterAt = failedAt + 30_000;
        fetchOriginRetryAfterAtMs.set(stateKey, fallbackRetryAfterAt);
        const entry = await recordGitFetchFailure({
          identity: freshnessIdentity,
          failedAt,
        }).catch(() => null);
        const retryAfterAt = Date.parse(entry?.retryAfterAt ?? '');
        if (Number.isFinite(retryAfterAt)) {
          fetchOriginRetryAfterAtMs.set(stateKey, retryAfterAt);
        }
      } else {
        fetchOriginCompletedAtMs.set(stateKey, failedAt);
      }
      throw error;
    })
    .finally((): void => {
      fetchOriginPromises.delete(stateKey);
    });
  fetchOriginPromises.set(stateKey, fetchPromise);
  await fetchPromise.catch(() => undefined);
}

export async function getAheadBehindCounts(
  repoPath: string,
  localRef: string,
  remoteRef: string,
): Promise<{ ahead: number; behind: number }> {
  const output = await runGit(
    ['rev-list', '--left-right', '--count', `${localRef}...${remoteRef}`],
    repoPath,
  );
  const [aheadRaw, behindRaw] = output.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadRaw ?? '0', 10);
  const behind = Number.parseInt(behindRaw ?? '0', 10);
  return {
    ahead: Number.isNaN(ahead) ? 0 : ahead,
    behind: Number.isNaN(behind) ? 0 : behind,
  };
}

export async function pullBranchFastForward(
  repoPath: string,
  branchName: string,
): Promise<void> {
  await runGit(['pull', '--ff-only', 'origin', branchName], repoPath);
}

export async function pullBranchRebase(
  repoPath: string,
  branchName: string,
): Promise<void> {
  await runGit(
    ['pull', '--rebase', '--autostash', 'origin', branchName],
    repoPath,
  );
}

export async function isRebaseInProgress(repoPath: string): Promise<boolean> {
  const [mergePath, applyPath] = await Promise.all([
    runGit(['rev-parse', '--git-path', 'rebase-merge'], repoPath),
    runGit(['rev-parse', '--git-path', 'rebase-apply'], repoPath),
  ]);
  const [merge, apply] = await Promise.all([
    stat(resolveGitPath(repoPath, mergePath)).then(
      () => true,
      () => false,
    ),
    stat(resolveGitPath(repoPath, applyPath)).then(
      () => true,
      () => false,
    ),
  ]);
  return merge || apply;
}

export async function hasAutostashEntry(repoPath: string): Promise<boolean> {
  try {
    const output = await runGit(['stash', 'list'], repoPath);
    return output.split('\n').some((line) => line.includes('autostash'));
  } catch {
    return false;
  }
}

export async function hasUnmergedPaths(repoPath: string): Promise<boolean> {
  try {
    const output = await runGit(['status', '--porcelain=v1'], repoPath);
    return output
      .split('\n')
      .some((line) => /^(U[UADM]|[ADM]U|DD|AA)/.test(line));
  } catch {
    return false;
  }
}

export async function discardUncommittedChanges(
  repoPath: string,
): Promise<void> {
  await runGit(['reset', '--hard', 'HEAD'], repoPath);
  await runGit(['clean', '-fd'], repoPath);
}

export interface SnapshotRestoreRef {
  treeSha: string;
  headCommitSha?: string;
}

/**
 * Restore a repository to a previously captured snapshot.
 *
 * - When `headCommitSha` is provided, hard-resets HEAD to that commit so
 *   commits the agent created during a turn are rolled back.
 * - Then overlays the captured working-tree state via `read-tree --reset -u`
 *   so any uncommitted edits at snapshot time are restored.
 * - Finally `git clean -fd` removes files that were created since the
 *   snapshot. Ignored files (gitignored build artifacts like `node_modules`)
 *   are left alone.
 *
 * The order matters: the HEAD reset is what makes the index/working tree
 * match the captured commit; `read-tree --reset -u` then puts in any
 * uncommitted state that existed at snapshot time.
 */
export async function restoreToSnapshot(
  repoPath: string,
  ref: SnapshotRestoreRef,
): Promise<void> {
  if (!GIT_OBJECT_ID_RE.test(ref.treeSha)) {
    throw new Error('Invalid tree SHA');
  }
  if (
    ref.headCommitSha !== undefined &&
    !GIT_OBJECT_ID_RE.test(ref.headCommitSha)
  ) {
    throw new Error('Invalid HEAD commit SHA');
  }

  if (ref.headCommitSha) {
    await runGit(
      disableGitHooks(['reset', '--hard', ref.headCommitSha]),
      repoPath,
    );
  } else {
    let headExists = false;
    try {
      await runGit(
        disableGitHooks(['rev-parse', '--verify', 'HEAD']),
        repoPath,
      );
      headExists = true;
    } catch {
      headExists = false;
    }
    if (headExists) {
      await runGit(disableGitHooks(['update-ref', '-d', 'HEAD']), repoPath);
    }
    await runGit(disableGitHooks(['read-tree', '--empty']), repoPath);
  }

  await runGit(
    disableGitHooks(['read-tree', '--reset', '-u', ref.treeSha]),
    repoPath,
  );
  await runGit(disableGitHooks(['clean', '-fd']), repoPath);
}

/**
 * Revert a single uncommitted file to its HEAD state.
 * Strategy varies by status to handle files that may not exist in HEAD.
 */
export async function revertUncommittedFile(
  repoPath: string,
  filePath: string,
  status: ChangedFileStatus,
  previousPath?: string,
): Promise<void> {
  switch (status) {
    case 'untracked':
      await unlink(join(repoPath, filePath));
      break;

    case 'added':
      // Newly staged files don't exist in HEAD; git rm -f reliably removes them.
      await runGit(['rm', '-f', '--', filePath], repoPath);
      break;

    case 'copied':
      // Remove the copy; the original at previousPath is unchanged.
      await runGit(['rm', '-f', '--', filePath], repoPath);
      break;

    case 'renamed': {
      if (!previousPath) {
        throw new Error(
          `Cannot revert renamed file "${filePath}": previousPath is required`,
        );
      }
      // A rename is delete(previousPath) + add(filePath); restore both.
      await runGit(
        [
          'restore',
          '--source=HEAD',
          '--staged',
          '--worktree',
          '--',
          filePath,
          previousPath,
        ],
        repoPath,
      );
      break;
    }

    case 'modified':
    case 'deleted':
    case 'type-changed':
    case 'unmerged':
      await runGit(
        ['restore', '--source=HEAD', '--staged', '--worktree', '--', filePath],
        repoPath,
      );
      break;

    case 'unknown':
      throw new Error(
        `Cannot revert file "${filePath}": unknown status is not supported`,
      );

    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled file status: ${String(_exhaustive)}`);
    }
  }
}

export async function checkoutLocalOrRemoteBranch(
  repoPath: string,
  branchName: string,
): Promise<void> {
  if (await doesLocalBranchExist(repoPath, branchName)) {
    await runGit(['checkout', branchName], repoPath);
    return;
  }

  await runGit(
    ['checkout', '-b', branchName, '--track', `origin/${branchName}`],
    repoPath,
  );
}

async function abortMerge(repoPath: string): Promise<void> {
  try {
    await runGit(['merge', '--abort'], repoPath);
  } catch {
    // No merge in progress
  }
}

async function removeOriginRemote(repoPath: string): Promise<void> {
  try {
    await runGit(['remote', 'remove', 'origin'], repoPath);
  } catch {
    // Best-effort cleanup so linking can be retried.
  }
}

/** The local-branch reads that decide whether a new name is free. */
function gitBranchNameReads(repoPath: string): GitBranchNameReads {
  return {
    localBranchExists: (branch) => doesLocalBranchExist(repoPath, branch),
    listLocalBranchesUnder: (name) =>
      runGit(
        ['for-each-ref', '--format=%(refname)', `refs/heads/${name}/`],
        repoPath,
      ),
  };
}

/**
 * Check whether creating a branch with the given name would conflict with
 * existing refs in the hierarchy (e.g. "robin" conflicts when
 * "robin/api-382/logger-test" already exists, because git stores refs as
 * files/directories and a name can't be both).
 */
function hasRefConflict(
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  return hasGitBranchRefConflict(gitBranchNameReads(repoPath), branchName);
}

export async function validateBranchName(
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  try {
    await runGit(['check-ref-format', '--branch', branchName], repoPath);
    return true;
  } catch (error) {
    // Git exits 128 for an invalid branch. Missing/unusable Git is not a name
    // collision: keep its actionable error instead of exhausting generated IDs.
    if (
      hostOperatingSystem() === 'linux' &&
      !(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 128
      )
    ) {
      throw error;
    }
    return false;
  }
}

export async function isBranchNameAvailable(
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  if (!(await validateBranchName(repoPath, branchName))) {
    return false;
  }

  if (await doesLocalBranchExist(repoPath, branchName)) {
    return false;
  }

  return !(await hasRefConflict(repoPath, branchName));
}

export async function resolveSharedAvailableBranchName(
  repoPaths: string[],
  branchName: string,
): Promise<string | null> {
  if (repoPaths.length === 0) {
    return null;
  }

  const preferredAvailability = await Promise.all(
    repoPaths.map((repoPath) => isBranchNameAvailable(repoPath, branchName)),
  );
  if (preferredAvailability.every(Boolean)) {
    return branchName;
  }

  for (let i = 2; i <= 100; i += 1) {
    const candidate = appendBranchSuffix(branchName, i);
    const candidateAvailability = await Promise.all(
      repoPaths.map((repoPath) => isBranchNameAvailable(repoPath, candidate)),
    );
    if (candidateAvailability.every(Boolean)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Return a branch name that is safe to create.  If `branchName` would collide
 * with an existing ref hierarchy, appends `-2`, `-3`, … until a free name is
 * found.
 */
function safeBranchName(repoPath: string, branchName: string): Promise<string> {
  return selectAvailableGitBranchName(gitBranchNameReads(repoPath), branchName);
}

export async function listRegisteredWorktreePaths(
  repoPath: string,
): Promise<Set<string>> {
  const output = await runGit(['worktree', 'list', '--porcelain'], repoPath);
  const registeredPaths = new Set<string>();

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('worktree ')) {
      continue;
    }

    const worktreePath = line.slice('worktree '.length).trim();
    if (worktreePath) {
      registeredPaths.add(worktreePath);
    }
  }

  return registeredPaths;
}

export async function isRegisteredWorktreePath(
  repoPath: string,
  worktreePath: string,
): Promise<boolean> {
  const registeredPaths = await listRegisteredWorktreePaths(repoPath);
  const realWorktreePath = await realpath(worktreePath).catch(() =>
    resolve(worktreePath),
  );

  for (const registeredPath of Array.from(registeredPaths)) {
    const realRegisteredPath = await realpath(registeredPath).catch(() =>
      resolve(registeredPath),
    );
    if (realRegisteredPath === realWorktreePath) {
      return true;
    }
  }

  return false;
}

async function findExistingWorktreePathForBranch(
  repoRoot: string,
  branchName: string,
): Promise<string | null> {
  const output = await runGit(['worktree', 'list', '--porcelain'], repoRoot);
  const worktreeEntry = parseGitWorktreeListPorcelain(output).find(
    (entry) => entry.branchName === branchName,
  );
  return worktreeEntry?.worktreePath ?? null;
}

async function readBranchListWorktrees(
  worktreePath: string,
): Promise<{ output: string; checkoutPath: string }> {
  const repoRoot = await getRepoRootFromWorktree(worktreePath);
  const output = await runGit(['worktree', 'list', '--porcelain'], repoRoot);
  return { output, checkoutPath: worktreePath };
}

/** Read-only equivalent of branch -d's upstream-or-main-HEAD merge gate. */
export async function readLocalBranchMergeState(
  repoPath: string,
  branchName: string,
): Promise<{ exists: boolean; merged: boolean }> {
  const ref = `refs/heads/${branchName}`;
  const rows = await runGit(
    ['for-each-ref', '--format=%(refname) %(objectname) %(upstream)', ref],
    repoPath,
  );
  const row = rows.split('\n').find((line) => line.split(' ')[0] === ref);
  if (!row) return { exists: false, merged: true };
  const [, tip, upstream] = row.split(' ');
  if (!tip) throw new Error('Cannot resolve the local branch tip.');
  // Like branch -d, a configured upstream that no longer resolves (pruned
  // after its remote branch was deleted) falls back to HEAD.
  const configuredBase = upstream
    ? await runGit(
        ['rev-parse', '--verify', '--quiet', upstream],
        repoPath,
      ).catch(() => '')
    : '';
  const base =
    configuredBase ||
    (await runGit(['rev-parse', '--verify', 'HEAD'], repoPath));
  try {
    await runGit(['merge-base', '--is-ancestor', tip, base], repoPath);
    return { exists: true, merged: true };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 1
    )
      return { exists: true, merged: false };
    throw error;
  }
}

/** The Git reads `worker.git.branch.list` runs in one checkout. */
export function gitBranchListReads(worktreePath: string): {
  readBranchRefs(): Promise<string>;
  readWorktreeList(): Promise<{ output: string; checkoutPath: string }>;
  readHeadUnborn(): Promise<boolean | undefined>;
} {
  return {
    readBranchRefs: () => runGit([...GIT_BRANCH_LIST_REF_ARGS], worktreePath),
    readWorktreeList: () => readBranchListWorktrees(worktreePath),
    readHeadUnborn: async () =>
      (
        await readGitHeadState(worktreePath, {
          verifyCommit: () =>
            runGit(
              ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
              worktreePath,
              { timeoutMs: 2000, maxBuffer: 4096 },
            ),
        })
      ).headUnborn,
  };
}

export async function listBranches(
  worktreePath: string,
  options: {
    resolveDefaultBranch?: (repoPath: string) => Promise<string | null>;
  } = {},
): Promise<ListBranchesResponse> {
  return listGitBranches(
    {
      ...gitBranchListReads(worktreePath),
      resolveDefaultBranch: () =>
        options.resolveDefaultBranch
          ? options.resolveDefaultBranch(worktreePath)
          : getRemoteDefaultBranch(worktreePath),
    },
    (defaultBranch) => defaultBranch,
  );
}

/**
 * The desktop's port for `worker.git.checkout` and `worker.git.branch.create`
 * in one checkout: today's runners and environments. Status and the current
 * branch use the desktop-shared runner (with the user's Canopy environment);
 * the rest use this module's runner, and only the single-branch fetch is
 * non-interactive. No effect takes a signal.
 */
export function gitBranchWritePort(worktreePath: string): GitBranchWritePort {
  return {
    hasUncommittedChanges: () => hasUncommittedChanges(worktreePath),
    readWorktreeList: () => readBranchListWorktrees(worktreePath),
    remoteBranchExists: (branch) => doesRemoteBranchExist(worktreePath, branch),
    fetchRemoteBranch: (branch) => fetchOriginBranchRef(worktreePath, branch),
    isValidBranchName: (name) => validateBranchName(worktreePath, name),
    ...gitBranchNameReads(worktreePath),
    currentBranch: () => getCurrentBranch(worktreePath),
    checkout: async (branch) => {
      await runGit(['checkout', branch], worktreePath);
    },
    checkoutNewBranch: async (name, startPoint) => {
      await runGit(['checkout', '-b', name, startPoint], worktreePath);
    },
    renameCurrentBranch: (name) => renameBranch(worktreePath, name),
  };
}

/**
 * The `worker.git.branch.delete` port over one repository: today's
 * main-process runner for the listing and both effects.
 */
export function gitBranchDeletePort(repoPath: string): GitBranchDeletePort {
  return {
    listCheckedOutBranches: () => listCheckedOutBranches(repoPath),
    deleteBranch: async (branch, force) => {
      await runGit(['branch', force ? '-D' : '-d', branch], repoPath);
    },
    deleteBranchRef: async (branch, tip) => {
      await runGit(['update-ref', '-d', `refs/heads/${branch}`, tip], repoPath);
    },
  };
}

export function checkoutBranch(
  worktreePath: string,
  branchName: string,
): Promise<void> {
  return checkoutGitBranch(gitBranchWritePort(worktreePath), branchName);
}

export function createBranchAndCheckout(
  worktreePath: string,
  newBranchName: string,
  startPoint: string,
): Promise<string> {
  return createGitBranch(
    gitBranchWritePort(worktreePath),
    newBranchName,
    startPoint,
  );
}

export async function createWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  options: { backgroundPriority?: boolean } = {},
): Promise<string> {
  return addGitWorktree(
    {
      fetch: () =>
        fetchOrigin(repoPath, {
          backgroundPriority: options.backgroundPriority,
        }),
      defaultBranch: () =>
        getRemoteDefaultBranch(repoPath, { preferRemote: true }),
      localBranchExists: (branch) => doesLocalBranchExist(repoPath, branch),
      availableBranchName: (branch) => safeBranchName(repoPath, branch),
      add: async (branch, startPoint, create) => {
        await runWorktreeAdd(
          disableGitHooks([
            'worktree',
            'add',
            ...(create ? ['-b', branch, worktreePath] : [worktreePath, branch]),
            ...(create && startPoint ? [startPoint] : []),
          ]),
          repoPath,
          create ? (startPoint ?? 'HEAD') : branch,
          options,
        );
      },
    },
    branchName,
  );
}

/**
 * Whether `branchName` is currently checked out at any worktree of the repo.
 * git refuses to check the same branch out at two worktrees, so creation
 * flows use this to fall back to a fresh branch instead of failing with
 * "fatal: '<branch>' is already checked out at '<path>'".
 */
export async function isBranchCheckedOutInAnyWorktree(
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  try {
    return (
      (await findExistingWorktreePathForBranch(repoPath, branchName)) !== null
    );
  } catch {
    return false;
  }
}

/**
 * `createWorktree`, but resilient to the seed branch being checked out at
 * another worktree of the same repo (typically the destination worktree left
 * behind by a previous split of the same combination): instead of failing,
 * a fresh uniquified branch is created at the seed branch's tip so the new
 * checkout still starts from the same commit.
 */
export async function createWorktreeAvoidingCheckedOutBranch(
  repoPath: string,
  worktreePath: string,
  seedBranch: string,
  options: { backgroundPriority?: boolean } = {},
): Promise<string> {
  if (
    (await doesLocalBranchExist(repoPath, seedBranch)) &&
    (await isBranchCheckedOutInAnyWorktree(repoPath, seedBranch))
  ) {
    return createWorktreeFromStartPoint(
      repoPath,
      worktreePath,
      seedBranch,
      seedBranch,
      options,
    );
  }
  return createWorktree(repoPath, worktreePath, seedBranch, options);
}

export async function createWorktreeFromStartPoint(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  startPoint: string,
  options: { backgroundPriority?: boolean } = {},
): Promise<string> {
  const resolvedName = await safeBranchName(repoPath, branchName);
  await runWorktreeAdd(
    disableGitHooks([
      'worktree',
      'add',
      '-b',
      resolvedName,
      worktreePath,
      startPoint,
    ]),
    repoPath,
    startPoint,
    options,
  );
  return resolvedName;
}

/** Preserve successful creation cost; diagnose only the failed add itself. */
async function runWorktreeAdd(
  args: string[],
  repoPath: string,
  startPoint: string,
  options: { backgroundPriority?: boolean },
): Promise<void> {
  try {
    await runGit(args, repoPath, options);
  } catch (error) {
    await classifyWorktreeAddFailure(error, repoPath, startPoint, () =>
      runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], repoPath, {
        timeoutMs: 2000,
        maxBuffer: 4096,
      }),
    );
    throw error;
  }
}

export function parseWorktreeListPorcelain(
  output: string,
): Map<string, string> {
  return parseGitCheckedOutBranches(output);
}

export async function listCheckedOutBranches(
  repoPath: string,
): Promise<Map<string, string>> {
  const output = await runGit(['worktree', 'list', '--porcelain'], repoPath);
  return parseWorktreeListPorcelain(output);
}

export async function checkoutDetachedRef(
  worktreePath: string,
  ref: string,
  options?: {
    signal?: AbortSignal;
    skipLfsSmudge?: boolean;
    timeoutMs?: number;
  },
): Promise<void> {
  await runGit(disableGitHooks(['checkout', '--detach', ref]), worktreePath, {
    signal: options?.signal,
    skipLfsSmudge: options?.skipLfsSmudge,
    timeoutMs: options?.timeoutMs,
  });
}

export async function createWorktreeForExistingBranch(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  options: { backgroundPriority?: boolean } = {},
): Promise<string> {
  await fetchOrigin(repoPath, {
    backgroundPriority: options.backgroundPriority,
  });
  if (await doesLocalBranchExist(repoPath, branchName)) {
    await runGit(
      disableGitHooks(['worktree', 'add', worktreePath, branchName]),
      repoPath,
      { backgroundPriority: options.backgroundPriority },
    );
    return branchName;
  }
  if (await doesRemoteBranchExist(repoPath, branchName)) {
    await runGit(
      disableGitHooks([
        'worktree',
        'add',
        '--track',
        '-b',
        branchName,
        worktreePath,
        `origin/${branchName}`,
      ]),
      repoPath,
      { backgroundPriority: options.backgroundPriority },
    );
    return branchName;
  }
  throw new Error(`Branch "${branchName}" was not found`);
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  return withWorktreeRemovalLock(repoPath, (removeLockedWorktree) =>
    removeLockedWorktree(worktreePath),
  );
}

async function removeWorktreeWithoutLock(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  await terminateProcessesReferencingPath(worktreePath).catch(
    (error: unknown) => {
      // On Linux a process that outlives termination can keep writing into
      // the checkout after Git unlinks it, so that failure stops removal.
      if (
        hostOperatingSystem() === 'linux' &&
        error instanceof WorktreeProcessCleanupError
      ) {
        throw error;
      }
      // Elsewhere process cleanup is best effort. Git removal remains
      // authoritative and must still run when process enumeration is
      // unavailable.
      // eslint-disable-next-line no-console
      console.warn('Failed to clean up processes for removed worktree.', {
        worktreePath,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  const removeCheckout = async (): Promise<void> => {
    await removeWindowsWorktreeReparsePoints(worktreePath);
    await runGit(['worktree', 'remove', '--force', worktreePath], repoPath, {
      timeoutMs: getWorktreeDeleteTimeoutMs(),
    });
  };
  if (hostOperatingSystem() !== 'linux') {
    await removeCheckout();
    return;
  }
  // Checks Canopy-owned writers before removal and again after, so a retained
  // directory and a removed-but-still-written one are reported distinctly.
  await withLinuxWorktreeRemovalVerification(worktreePath, removeCheckout);
}

export async function withWorktreeRemovalLock<T>(
  repoPath: string,
  operation: (
    removeLockedWorktree: (worktreePath: string) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const queueKey = resolve(repoPath);
  const previous = worktreeRemovalQueues.get(queueKey) ?? Promise.resolve();
  const removal = previous
    .catch(() => undefined)
    .then(() =>
      operation((worktreePath) =>
        removeWorktreeWithoutLock(repoPath, worktreePath),
      ),
    );
  const settled = removal.then(
    () => undefined,
    () => undefined,
  );
  worktreeRemovalQueues.set(queueKey, settled);

  try {
    return await removal;
  } finally {
    if (worktreeRemovalQueues.get(queueKey) === settled) {
      worktreeRemovalQueues.delete(queueKey);
    }
  }
}

export async function getWorktreeTopLevel(
  worktreePath: string,
): Promise<string> {
  return runGit(['rev-parse', '--show-toplevel'], worktreePath, {
    timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
  });
}

export async function moveWorktree(
  repoPath: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  try {
    await runGit(['worktree', 'move', oldPath, newPath], repoPath, {
      timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
    });
    return;
  } catch (error) {
    const gitStillRecognizesOldPath = await isRegisteredWorktreePath(
      repoPath,
      oldPath,
    ).catch(() => true);
    if (gitStillRecognizesOldPath) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    const topLevel = await getWorktreeTopLevel(oldPath).catch(() => null);
    if (!topLevel) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    const realOldPath = await realpath(oldPath).catch(() => null);
    if (!realOldPath) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    const realTopLevel = await realpath(topLevel).catch(() =>
      resolve(topLevel),
    );
    if (realTopLevel !== realOldPath) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    await rename(oldPath, newPath);
  }
}

export async function pruneWorktrees(
  repoPath: string,
  options?: { signal?: AbortSignal },
): Promise<void> {
  await runGit(['worktree', 'prune'], repoPath, {
    timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
    signal: options?.signal,
  });
}

export function bestEffortPruneWorktrees(
  repoPath: string,
  context: string,
): void {
  void pruneWorktrees(repoPath).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(`[git] pruneWorktrees fallback failed (${context})`, {
      error,
      repoPath,
    });
  });
}

// The `worker.git.branch.delete` policy in process, for the lifecycle
// callers CAN-4098 moves onto the instruction.
export function deleteBranch(
  repoPath: string,
  branchName: string,
): Promise<void> {
  return deleteGitBranch(gitBranchDeletePort(repoPath), branchName, {
    kind: 'merged',
  });
}

export function forceDeleteBranch(
  repoPath: string,
  branchName: string,
): Promise<void> {
  return deleteGitBranch(gitBranchDeletePort(repoPath), branchName, {
    kind: 'force',
  });
}

export function deleteBranchIfMatches(
  repoPath: string,
  branchName: string,
  expectedTip: string,
): Promise<void> {
  return deleteGitBranch(gitBranchDeletePort(repoPath), branchName, {
    kind: 'tip',
    tip: expectedTip,
  });
}

export async function renameBranch(
  worktreePath: string,
  newName: string,
): Promise<void> {
  await runGit(['branch', '-m', newName], worktreePath);
}

export async function getDiffStats(
  worktreePath: string,
  baseBranch?: string,
): Promise<{ insertions: number; deletions: number }> {
  return getDiffStatsAgainst(
    worktreePath,
    await resolveDiffStatsBase(worktreePath, baseBranch),
  );
}

/**
 * The revision diff stats compare the working tree with: with a base branch,
 * the merge base of `origin/<base>` (or the local branch when the remote ref
 * is missing) and HEAD, so the stats cover everything since the branch
 * diverged without upstream changes; otherwise, or without a merge base,
 * `HEAD`.
 */
export async function resolveDiffStatsBase(
  worktreePath: string,
  baseBranch?: string,
): Promise<string> {
  if (!baseBranch) return 'HEAD';
  return (await getMergeBaseForBranch(worktreePath, baseBranch)) ?? 'HEAD';
}

/** `git diff <diffRef> --shortstat`, as diff stats read it. */
export function readDiffShortstat(
  worktreePath: string,
  diffRef: string,
): Promise<string> {
  return runGit(['diff', diffRef, '--shortstat'], worktreePath);
}

/** The insertion and deletion totals of a `--shortstat` line. */
export function parseDiffShortstat(shortstat: string): {
  insertions: number;
  deletions: number;
} {
  const insertionsMatch = shortstat.match(/(\d+)\sinsertions?\(\+\)/);
  const deletionsMatch = shortstat.match(/(\d+)\sdeletions?\(-\)/);
  return {
    insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0,
  };
}

/**
 * The `core.quotePath` Git applies to a listing: `true` when unset, Git's
 * default, and `null` when Git refuses the configuration, which fails every
 * listing.
 */
export async function readGitQuotePath(
  worktreePath: string,
): Promise<boolean | null> {
  try {
    return (
      (await runGit(
        ['config', '--type=bool', '--get', 'core.quotePath'],
        worktreePath,
      )) !== 'false'
    );
  } catch (error) {
    // `git config --get` exits 1, and only 1, for an unset key.
    return Reflect.get(Object(error), 'code') === 1 ? true : null;
  }
}

/** {@link getDiffStats} against an already selected revision. */
export async function getDiffStatsAgainst(
  worktreePath: string,
  diffRef: string,
): Promise<{ insertions: number; deletions: number }> {
  const [shortstat, untrackedOutput] = await Promise.all([
    readDiffShortstat(worktreePath, diffRef),
    runGit(['ls-files', '--others', '--exclude-standard'], worktreePath).catch(
      () => '',
    ),
  ]);

  const totals = parseDiffShortstat(shortstat);
  let { insertions } = totals;
  const { deletions } = totals;

  if (untrackedOutput) {
    const files = untrackedOutput
      .split('\n')
      .filter(Boolean)
      .slice(0, MAX_UNTRACKED_FILES);
    const lineCounts = await estimateUntrackedInsertions(worktreePath, files);
    for (const count of lineCounts) {
      insertions += count;
    }
  }

  return { insertions, deletions };
}

export { parseDiffOutput } from './git-diff-parser';
import { decodeGitPath, parseDiffOutput } from './git-diff-parser';

export async function getChangedFilesList(
  worktreePath: string,
): Promise<ChangedFileInfo[]> {
  // `core.quotePath=false` on all four commands for the same reason as
  // `getCommittedFilesList` below: git's default C-quotes and octal-escapes
  // non-ASCII paths, and `ls-files` does it too. The unmerged listing omits
  // `-z` so paths containing backslashes, quotes, or control characters use
  // the same C-quoted fields as `diff`; quoted tabs and newlines stay on one
  // line. The builders decode those fields to actual filename identity.
  //
  // This helper feeds display surfaces — the activity panel and the
  // shared-container share preview — which rendered `"caf\303\251.md"`
  // verbatim. It is *not* the publish path: the manifest's uncommitted half
  // goes through `listWorkingTreeDiffAgainstHead` and `listUntrackedFilesStrict`,
  // which are already `-z` and unaffected (CAN-2551).
  // `diff HEAD` can omit unmerged index paths (merge, rebase, cherry-pick, or
  // revert).
  const [statusOutput, numstatOutput, untrackedOutput, unmergedOutput] =
    await Promise.all([
      runGit(
        [
          '-c',
          'core.quotePath=false',
          'diff',
          'HEAD',
          '--name-status',
          '--find-renames',
          '--find-copies',
        ],
        worktreePath,
      ).catch(() => ''),
      runGit(
        [
          '-c',
          'core.quotePath=false',
          'diff',
          'HEAD',
          '--numstat',
          '--find-renames',
          '--find-copies',
        ],
        worktreePath,
      ).catch(() => ''),
      runGit(
        [
          '-c',
          'core.quotePath=false',
          'ls-files',
          '--others',
          '--exclude-standard',
        ],
        worktreePath,
      ).catch(() => ''),
      runGit(
        ['-c', 'core.quotePath=false', 'ls-files', '--unmerged'],
        worktreePath,
      ).catch(() => ''),
    ]);

  return buildChangedFilesList(worktreePath, {
    statusOutput,
    numstatOutput,
    untrackedOutput,
    unmergedOutput,
  });
}

/** The four outputs `getChangedFilesList` reads, trimmed; `''` on failure. */
export interface ChangedFilesListOutputs {
  readonly statusOutput: string;
  readonly numstatOutput: string;
  readonly untrackedOutput: string;
  readonly unmergedOutput: string;
}

/**
 * The changed-files list of `getChangedFilesList`'s outputs. The
 * `activity:changed-files` projection rebuilds these outputs from the
 * canonical engine's reads (CAN-4103).
 */
export async function buildChangedFilesList(
  worktreePath: string,
  {
    statusOutput,
    numstatOutput,
    untrackedOutput,
    unmergedOutput,
  }: ChangedFilesListOutputs,
  estimate: typeof estimateUntrackedChanges = estimateUntrackedChanges,
): Promise<ChangedFileInfo[]> {
  const changedFiles = parseDiffOutput(statusOutput, numstatOutput);

  const unmergedPaths = new Set<string>();
  for (const entry of unmergedOutput.split('\n').filter(Boolean)) {
    const pathStart = entry.indexOf('\t');
    if (pathStart === -1) continue;
    unmergedPaths.add(decodeGitPath(entry.slice(pathStart + 1)));
  }

  unmergedPaths.forEach((path: string) => {
    const existing = changedFiles.get(path);
    changedFiles.set(
      path,
      existing
        ? { ...existing, status: 'unmerged' }
        : { path, status: 'unmerged', insertions: 0, deletions: 0 },
    );
  });

  const untrackedFiles = untrackedOutput
    .split('\n')
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED_FILES)
    .map(decodeGitPath);
  const untrackedChanges = await estimate(worktreePath, untrackedFiles);

  untrackedFiles.forEach((path, index) => {
    if (changedFiles.has(path)) return;
    const change = untrackedChanges[index];
    changedFiles.set(path, {
      path,
      status: 'untracked',
      insertions: change?.insertions ?? 0,
      deletions: 0,
      ...(change?.binary === true ? { binary: true } : {}),
    });
  });

  return Array.from(changedFiles.values()).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

export async function getCommittedFilesList(
  worktreePath: string,
  baseBranch?: string,
): Promise<ChangedFileInfo[]> {
  const mergeBase = await getMergeBaseForBranch(worktreePath, baseBranch);
  if (!mergeBase) {
    return [];
  }
  return getCommittedFilesBetween(worktreePath, mergeBase, 'HEAD');
}

export async function getCommittedFilesBetween(
  worktreePath: string,
  fromSha: string,
  toSha: string,
): Promise<ChangedFileInfo[]> {
  // `core.quotePath=false` keeps non-ASCII paths as raw UTF-8. Git's default
  // renders them C-quoted and octal-escaped (`"caf\303\251.md"`): before
  // CAN-2551, the activity panel showed the escaped form, and
  // shared-container publishing rejected the quotes outright and dropped every
  // accented, CJK, or emoji-named committed file from the manifest with no
  // disclosure. Other C-quoted fields are decoded by the builder (CAN-3224);
  // downstream portability validation remains responsible for publication.
  const [statusOutput, numstatOutput] = await Promise.all([
    runGit(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        `${fromSha}..${toSha}`,
        '--name-status',
        '--find-renames',
        '--find-copies',
      ],
      worktreePath,
    ).catch(() => ''),
    runGit(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        `${fromSha}..${toSha}`,
        '--numstat',
        '--find-renames',
        '--find-copies',
      ],
      worktreePath,
    ).catch(() => ''),
  ]);

  return buildCommittedFilesList(statusOutput, numstatOutput);
}

/** The committed-files list of `getCommittedFilesBetween`'s two outputs. */
export function buildCommittedFilesList(
  statusOutput: string,
  numstatOutput: string,
): ChangedFileInfo[] {
  const files = parseDiffOutput(statusOutput, numstatOutput);
  return Array.from(files.values()).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

/**
 * Host reads for the `worker.git.diff.get` change-set engine, with the
 * environment and executable every desktop Git command uses (D8). Output is
 * untrimmed; the legacy listing's 8 MiB limit is applied when its outputs are
 * rebuilt, so these reads allow more.
 */
export function gitChangeSetReads(repoPath: string): GitChangeSetReader {
  return {
    read: (read) =>
      runGit(gitChangeSetReadArgs(read), repoPath, {
        preserveWhitespace: true,
        maxBuffer: 32 * 1024 * 1024,
      }),
    estimateUntracked: (paths) => estimateUntrackedChanges(repoPath, paths),
  };
}

export async function initGitRepo(dir: string): Promise<void> {
  await runGit(['init'], dir);
}

export async function initLocalRepo(
  dir: string,
  name: string,
  manifest: Parameters<typeof writeCanopyJson>[1] = { version: 1 },
): Promise<void> {
  await initGitRepo(dir);
  await writeFile(join(dir, 'README.md'), `# ${name}\n`, 'utf-8');
  await writeFile(
    join(dir, '.gitignore'),
    `# ${BRAND.displayName} multi-repo child repositories\nrepos/\n`,
    'utf-8',
  );
  await writeCanopyJson(dir, manifest);
  await runGit(
    ['add', 'README.md', '.gitignore', basename(getCanopyJsonPath(dir))],
    dir,
  );
  await commitWithLocalIdentity(dir, 'Initial commit');
}

export async function commitWithLocalIdentity(
  repoPath: string,
  message: string,
): Promise<string> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error('Commit message must not be empty');
  }
  await runGit(
    [
      '-c',
      `user.name=${BRAND.displayName}`,
      '-c',
      `user.email=${BRAND.internalName}@local.invalid`,
      'commit',
      '-m',
      trimmed,
    ],
    repoPath,
  );
  return runGit(['rev-parse', 'HEAD'], repoPath);
}

export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    return await runGit(['remote', 'get-url', 'origin'], repoPath);
  } catch {
    return null;
  }
}

/**
 * Returns the configured origin URL while distinguishing an absent origin
 * from an operational Git failure. Use this when `null` changes control flow
 * rather than serving as best-effort display data.
 */
export async function getRemoteUrlStrict(
  repoPath: string,
): Promise<string | null> {
  try {
    return await runGit(['remote', 'get-url', 'origin'], repoPath);
  } catch (error) {
    const remotes = (await runGit(['remote'], repoPath))
      .split('\n')
      .map((remote) => remote.trim());
    if (!remotes.includes('origin')) {
      return null;
    }
    throw error;
  }
}

/**
 * Returns the URL `git push origin` would actually write to.
 *
 * `remote.origin.pushurl` may differ from the fetch URL, so a repository can
 * fetch from GitHub while pushing somewhere else entirely. Any check that
 * gates a push on "is this a GitHub remote?" must ask this, not
 * {@link getRemoteUrlStrict} — otherwise it validates one host and mutates
 * another. When no `pushurl` is configured Git falls back to the fetch URL,
 * so this returns the same value in the common case.
 *
 * Like {@link getRemoteUrlStrict}, an absent origin answers `null` while an
 * operational failure throws, so callers can tell "no remote" from "could not
 * look it up".
 */
export async function getPushRemoteUrlStrict(
  repoPath: string,
): Promise<string | null> {
  try {
    return await runGit(['remote', 'get-url', '--push', 'origin'], repoPath);
  } catch (error) {
    const remotes = (await runGit(['remote'], repoPath))
      .split('\n')
      .map((remote) => remote.trim());
    if (!remotes.includes('origin')) {
      return null;
    }
    throw error;
  }
}

export async function getLocalDefaultBranch(
  repoPath: string,
  excludeBranch?: string,
): Promise<string | null> {
  const repoRoot = await getRepoRootFromWorktree(repoPath);
  const currentRootBranch = await getCurrentBranch(repoRoot).catch(() => null);
  if (
    currentRootBranch &&
    currentRootBranch !== 'HEAD' &&
    currentRootBranch !== excludeBranch
  ) {
    return currentRootBranch;
  }

  const configuredDefaultBranch = normalizeBranchName(
    await runGit(['config', '--get', 'init.defaultBranch'], repoRoot).catch(
      () => null,
    ),
  );
  if (
    configuredDefaultBranch &&
    configuredDefaultBranch !== excludeBranch &&
    (await doesLocalBranchExist(repoRoot, configuredDefaultBranch))
  ) {
    return configuredDefaultBranch;
  }

  const localCandidates = (await listLocalBranchNames(repoRoot))
    .filter((candidate) => candidate !== excludeBranch)
    .sort((left, right) => {
      const rankDelta =
        getLocalDefaultBranchCandidateRank(left) -
        getLocalDefaultBranchCandidateRank(right);
      if (rankDelta !== 0) {
        return rankDelta;
      }
      return left.localeCompare(right);
    });

  return localCandidates[0] ?? null;
}

function extractGitErrorStderr(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) {
    return null;
  }

  const stderr = error.stderr;
  if (typeof stderr !== 'string') {
    return null;
  }

  const trimmed = stderr.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function gitMergeWritePort(
  repoPath: string,
  onFailure?: (error: unknown) => void,
): GitMergeWritePort {
  return {
    currentBranch: () => getCurrentBranch(repoPath),
    repositoryRoot: () => getRepoRootFromWorktree(repoPath),
    localBranchExists: (root, branch) => doesLocalBranchExist(root, branch),
    baseWorktree: (root, branch) =>
      findExistingWorktreePathForBranch(root, branch),
    temporaryWorktree: () =>
      join(tmpdir(), `${BRAND.internalName}-merge-${randomUUID()}`),
    addWorktree: async (root, path, branch) => {
      await runGit(['worktree', 'add', path, branch], root);
    },
    isDirty: async (path) =>
      (
        await runGit(
          ['status', '--porcelain', '--untracked-files=normal'],
          path,
        )
      ).trim().length > 0,
    merge: async (path, source, base) => {
      try {
        await runGit(['merge', '--no-edit', source], path);
      } catch (error) {
        const failure = new Error(
          extractGitErrorStderr(error) ??
            (error instanceof Error
              ? error.message
              : `Failed to merge "${source}" into "${base}"`),
        );
        onFailure?.(failure);
        throw failure;
      }
    },
    hasUnmergedPaths: (path) => hasUnmergedPaths(path),
    abort: (path) => abortMerge(path),
    head: (path) => runGit(['rev-parse', 'HEAD'], path),
    removeWorktree: async (root, path) => {
      await runGit(['worktree', 'remove', '--force', path], root);
    },
  };
}

export async function mergeBranchIntoLocalBase(
  repoPath: string,
  sourceBranch: string,
  baseBranch: string,
): Promise<string> {
  let failure: unknown;
  const result = await mergeGitBranches(
    gitMergeWritePort(repoPath, (error) => {
      failure = error;
    }),
    sourceBranch,
    baseBranch,
  );
  if (result.outcome === 'conflict') throw failure;
  return result.mergeCommitHash;
}

export async function hasCommitsAhead(
  repoPath: string,
  baseBranch?: string,
): Promise<boolean> {
  try {
    const comparisonBaseRef = await resolveComparisonBaseRef(
      repoPath,
      baseBranch,
    );
    if (!comparisonBaseRef) {
      return false;
    }
    const output = await runGit(
      ['rev-list', `${comparisonBaseRef}..HEAD`, '--count'],
      repoPath,
    );
    return Number.parseInt(output, 10) > 0;
  } catch {
    return false;
  }
}

export async function hasCommitsAheadOfUpstream(
  repoPath: string,
): Promise<boolean> {
  try {
    // No fetch: pushes from this checkout already update the remote-tracking
    // ref, and a network round-trip here can only clear rare false positives
    // for an advisory warning while hanging exports offline.
    const output = await runGit(
      ['rev-list', '@{upstream}..HEAD', '--count'],
      repoPath,
    );
    return Number.parseInt(output, 10) > 0;
  } catch {
    // A branch without an upstream has not been pushed in a form another
    // machine can fetch, so preserve the export warning in that case.
    return true;
  }
}

async function getLocalCommitCount(repoPath: string): Promise<number> {
  try {
    const output = await runGit(['rev-list', '--count', 'HEAD'], repoPath);
    return Number.parseInt(output, 10);
  } catch {
    return 0;
  }
}

const MAX_FILE_CONTENT_CHARS = 500_000;
const MAX_FILE_CONTENT_PREFIX_BYTES = (MAX_FILE_CONTENT_CHARS + 1) * 4;

async function getFileAtRef(
  worktreePath: string,
  ref: string,
  filePath: string,
  options?: { disableReplaceObjects?: boolean },
): Promise<string> {
  try {
    return await runGitRaw(
      ['show', `${ref}:${filePath}`],
      worktreePath,
      options,
    );
  } catch {
    return '';
  }
}

async function getWorkingTreeFile(
  worktreePath: string,
  filePath: string,
): Promise<string> {
  try {
    return await readFile(join(worktreePath, filePath), 'utf-8');
  } catch {
    return '';
  }
}

function isPreviewableImagePath(filePath: string): boolean {
  return extname(filePath).toLowerCase() in IMAGE_DIFF_MIME_MAP;
}

function imageDataUrl(filePath: string, data: Buffer): string {
  const extension = extname(filePath).toLowerCase();
  const mime = IMAGE_DIFF_MIME_MAP[extension] ?? 'application/octet-stream';
  return `data:${mime};base64,${data.toString('base64')}`;
}

async function getFileAtRefBuffer(
  worktreePath: string,
  ref: string,
  filePath: string,
  options?: { disableReplaceObjects?: boolean },
): Promise<Buffer | undefined> {
  try {
    const sizeRaw = await runGit(
      ['cat-file', '-s', `${ref}:${filePath}`],
      worktreePath,
      options,
    );
    const size = Number.parseInt(sizeRaw, 10);
    if (!Number.isFinite(size) || size > MAX_IMAGE_DIFF_PREVIEW_BYTES) {
      return undefined;
    }
    return await runGitBuffer(
      ['show', `${ref}:${filePath}`],
      worktreePath,
      options,
    );
  } catch {
    return undefined;
  }
}

function readGitBlobPrefix(
  worktreePath: string,
  objectSpec: string,
  maximumBytes: number,
): Promise<Buffer> {
  return readGitStdoutPrefix(
    worktreePath,
    ['cat-file', 'blob', objectSpec],
    maximumBytes,
  );
}

/**
 * The first `maximumBytes` of `git <args>` stdout in `cwd`; Git is stopped
 * once they are read. Rejects when Git fails before that.
 */
export async function readGitStdoutPrefix(
  cwd: string,
  args: string[],
  maximumBytes: number,
): Promise<Buffer> {
  const launch = prepareBackgroundProcessLaunch(
    await getResolvedGitExecutableForSpawn(),
    args,
    false,
  );
  return new Promise<Buffer>((resolvePrefix, rejectPrefix) => {
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: withGitRequestContextEnv(
        getEnhancedEnv({ includeCanopySecrets: false, environment: false }),
      ),
      windowsHide: hostPlatformOperatingSystem() === 'win32',
    });
    if (launch.lowerPriorityAfterSpawn && typeof child.pid === 'number') {
      lowerSpawnedProcessPriority(child.pid);
    }
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let reachedLimit = false;
    let settled = false;
    let stderr = '';
    child.stdout.on('data', (value: unknown) => {
      if (reachedLimit) return;
      if (!Buffer.isBuffer(value)) {
        child.kill();
        if (!settled) {
          settled = true;
          rejectPrefix(new Error('Git returned invalid output'));
        }
        return;
      }
      const remaining = maximumBytes - bytesRead;
      const selected = value.subarray(0, remaining);
      if (selected.byteLength > 0) {
        chunks.push(Buffer.from(selected));
        bytesRead += selected.byteLength;
      }
      if (bytesRead >= maximumBytes) {
        reachedLimit = true;
        child.kill();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.once('error', (error) => {
      if (settled || reachedLimit) return;
      settled = true;
      rejectPrefix(error);
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      if (exitCode === 0 || reachedLimit) {
        resolvePrefix(Buffer.concat(chunks, bytesRead));
        return;
      }
      rejectPrefix(new Error(stderr.trim() || 'Git command failed'));
    });
  });
}

async function getFileAtRefPrefix(
  worktreePath: string,
  ref: string,
  filePath: string,
): Promise<{ data: Buffer; truncated: boolean }> {
  try {
    const objectSpec = `${ref}:${filePath}`;
    const sizeRaw = await runGit(['cat-file', '-s', objectSpec], worktreePath);
    if (!/^\d+$/.test(sizeRaw))
      throw new Error('Git returned invalid blob size');
    const size = BigInt(sizeRaw);
    const prefixSize = Number(
      size > BigInt(MAX_FILE_CONTENT_PREFIX_BYTES)
        ? BigInt(MAX_FILE_CONTENT_PREFIX_BYTES)
        : size,
    );
    if (prefixSize === 0) {
      return { data: Buffer.alloc(0), truncated: false };
    }
    const data =
      size > BigInt(MAX_FILE_CONTENT_PREFIX_BYTES)
        ? await readGitBlobPrefix(worktreePath, objectSpec, prefixSize)
        : await runGitBuffer(['cat-file', 'blob', objectSpec], worktreePath);
    return {
      data,
      truncated: size > BigInt(data.byteLength),
    };
  } catch {
    return { data: Buffer.alloc(0), truncated: false };
  }
}

async function getWorkingTreeFileBuffer(
  worktreePath: string,
  filePath: string,
): Promise<Buffer | undefined> {
  try {
    const fullPath = join(worktreePath, filePath);
    const fileStat = await stat(fullPath);
    if (fileStat.size > MAX_IMAGE_DIFF_PREVIEW_BYTES) {
      return undefined;
    }
    const data = await readFile(fullPath);
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
  } catch {
    return undefined;
  }
}

async function buildImageDiffContent(
  filePath: string,
  oldData: Promise<Buffer | undefined>,
  newData: Promise<Buffer | undefined>,
): Promise<FileDiffContent> {
  const [oldBuffer, newBuffer] = await Promise.all([oldData, newData]);
  const imagePreview: FileDiffImagePreview = {};
  if (oldBuffer) {
    imagePreview.oldDataUrl = imageDataUrl(filePath, oldBuffer);
  }
  if (newBuffer) {
    imagePreview.newDataUrl = imageDataUrl(filePath, newBuffer);
  }
  const result: FileDiffContent = {
    oldValue: '',
    newValue: '',
    truncated: false,
    binary: true,
  };
  if (imagePreview.oldDataUrl || imagePreview.newDataUrl) {
    result.imagePreview = imagePreview;
  }
  return result;
}

async function buildImageDiffContentWithPaths(
  oldFilePath: string,
  newFilePath: string,
  oldData: Promise<Buffer | undefined>,
  newData: Promise<Buffer | undefined>,
): Promise<FileDiffContent> {
  const [oldBuffer, newBuffer] = await Promise.all([oldData, newData]);
  const imagePreview: FileDiffImagePreview = {};
  if (oldBuffer) {
    imagePreview.oldDataUrl = imageDataUrl(oldFilePath, oldBuffer);
  }
  if (newBuffer) {
    imagePreview.newDataUrl = imageDataUrl(newFilePath, newBuffer);
  }
  return {
    oldValue: '',
    newValue: '',
    truncated: false,
    binary: true,
    ...(imagePreview.oldDataUrl || imagePreview.newDataUrl
      ? { imagePreview }
      : {}),
  };
}

async function isFileBinary(
  worktreePath: string,
  filePath: string,
  oldRef?: string,
  newRef?: string,
  options?: {
    disableReplaceObjects?: boolean;
    disableTextconv?: boolean;
  },
): Promise<boolean> {
  try {
    const diffSafetyArgs = options?.disableTextconv
      ? ['--no-ext-diff', '--no-textconv']
      : [];
    let diffArgs: string[];
    if (oldRef && newRef) {
      diffArgs = [
        'diff',
        oldRef,
        newRef,
        '--numstat',
        ...diffSafetyArgs,
        '--',
        filePath,
      ];
    } else if (oldRef) {
      diffArgs = [
        'diff',
        oldRef,
        '--numstat',
        ...diffSafetyArgs,
        '--',
        filePath,
      ];
    } else {
      diffArgs = [
        'diff',
        'HEAD',
        '--numstat',
        ...diffSafetyArgs,
        '--',
        filePath,
      ];
    }
    const numstat = await runGit(diffArgs, worktreePath, options);
    if (numstat.startsWith('-\t-\t')) return true;
  } catch {
    // Ignore — might be untracked
  }

  // Fallback: check file content for null bytes (first 8KB only)
  try {
    const fullPath = join(worktreePath, filePath);
    const fh = await open(fullPath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, 8192, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export interface FileDiffContent {
  oldValue: string;
  newValue: string;
  truncated: boolean;
  binary: boolean;
  imagePreview?: FileDiffImagePreview;
}

function truncateContent(value: string): { value: string; truncated: boolean } {
  if (value.length > MAX_FILE_CONTENT_CHARS) {
    return { value: value.slice(0, MAX_FILE_CONTENT_CHARS), truncated: true };
  }
  return { value, truncated: false };
}

/** Build a bounded read-only diff for authenticated content with no Git base. */
export async function getAddedFileDiff(
  filePath: string,
  data: Buffer,
): Promise<FileDiffContent> {
  if (isPreviewableImagePath(filePath)) {
    return buildImageDiffContent(
      filePath,
      Promise.resolve(undefined),
      Promise.resolve(
        data.length <= MAX_IMAGE_DIFF_PREVIEW_BYTES ? data : undefined,
      ),
    );
  }
  if (data.subarray(0, 8192).includes(0)) {
    return { oldValue: '', newValue: '', truncated: false, binary: true };
  }
  const content = truncateContent(data.toString('utf8'));
  return {
    oldValue: '',
    newValue: content.value,
    truncated: content.truncated,
    binary: false,
  };
}

export async function getFileDiffUncommitted(
  worktreePath: string,
  filePath: string,
  options?: { authenticatedWorkingTreeData: Buffer | null },
): Promise<FileDiffContent> {
  if (options) {
    const newBuffer = options.authenticatedWorkingTreeData;
    if (isPreviewableImagePath(filePath)) {
      return buildImageDiffContent(
        filePath,
        getFileAtRefBuffer(worktreePath, 'HEAD', filePath),
        Promise.resolve(
          newBuffer && newBuffer.length <= MAX_IMAGE_DIFF_PREVIEW_BYTES
            ? newBuffer
            : undefined,
        ),
      );
    }
    const oldPrefix = await getFileAtRefPrefix(worktreePath, 'HEAD', filePath);
    if (
      oldPrefix.data.subarray(0, 8192).includes(0) ||
      newBuffer?.subarray(0, 8192).includes(0)
    ) {
      return { oldValue: '', newValue: '', truncated: false, binary: true };
    }
    const newRaw = newBuffer?.toString('utf8') ?? '';
    const old = truncateContent(oldPrefix.data.toString('utf8'));
    const nw = truncateContent(newRaw);
    return {
      oldValue: old.value,
      newValue: nw.value,
      truncated: oldPrefix.truncated || old.truncated || nw.truncated,
      binary: false,
    };
  }
  if (isPreviewableImagePath(filePath)) {
    return buildImageDiffContent(
      filePath,
      getFileAtRefBuffer(worktreePath, 'HEAD', filePath),
      getWorkingTreeFileBuffer(worktreePath, filePath),
    );
  }
  if (await isFileBinary(worktreePath, filePath, 'HEAD')) {
    return { oldValue: '', newValue: '', truncated: false, binary: true };
  }
  const oldRaw = await getFileAtRef(worktreePath, 'HEAD', filePath);
  const newRaw = await getWorkingTreeFile(worktreePath, filePath);
  const old = truncateContent(oldRaw);
  const nw = truncateContent(newRaw);
  return {
    oldValue: old.value,
    newValue: nw.value,
    truncated: old.truncated || nw.truncated,
    binary: false,
  };
}

/**
 * Diff one path between two explicit commits.
 *
 * Unlike {@link getFileDiffCommitted} this never resolves a branch name, so it
 * works in a bounded shared-container replica where only the two commits
 * themselves were fetched and no local branch ref exists (CAN-2551).
 */
export async function getFileDiffBetweenCommits(
  repoPath: string,
  filePath: string,
  oldCommitSha: string,
  newCommitSha: string,
): Promise<FileDiffContent> {
  if (
    !/^[a-fA-F0-9]{40}$/.test(oldCommitSha) ||
    !/^[a-fA-F0-9]{40}$/.test(newCommitSha)
  ) {
    throw new Error('Full commit SHAs are required to diff between commits');
  }
  // A shared-container replica is another user's repository, so its config must
  // never drive object replacement or a textconv filter — not just on the probe
  // but on every read that produces what the recipient actually sees. The
  // materializer's own git calls set the same flag (CAN-2551).
  const untrustedRepoOptions = { disableReplaceObjects: true } as const;
  if (isPreviewableImagePath(filePath)) {
    return buildImageDiffContent(
      filePath,
      getFileAtRefBuffer(
        repoPath,
        oldCommitSha,
        filePath,
        untrustedRepoOptions,
      ),
      getFileAtRefBuffer(
        repoPath,
        newCommitSha,
        filePath,
        untrustedRepoOptions,
      ),
    );
  }
  if (
    await isFileBinary(repoPath, filePath, oldCommitSha, newCommitSha, {
      disableReplaceObjects: true,
      disableTextconv: true,
    })
  ) {
    return { oldValue: '', newValue: '', truncated: false, binary: true };
  }
  const oldRaw = await getFileAtRef(
    repoPath,
    oldCommitSha,
    filePath,
    untrustedRepoOptions,
  );
  const newRaw = await getFileAtRef(
    repoPath,
    newCommitSha,
    filePath,
    untrustedRepoOptions,
  );
  const old = truncateContent(oldRaw);
  const nw = truncateContent(newRaw);
  return {
    oldValue: old.value,
    newValue: nw.value,
    truncated: old.truncated || nw.truncated,
    binary: false,
  };
}

/** True when `commitSha` is present locally, without contacting the remote. */
export async function hasLocalCommit(
  repoPath: string,
  commitSha: string,
): Promise<boolean> {
  if (!/^[a-fA-F0-9]{40}$/.test(commitSha)) return false;
  try {
    await runGit(['cat-file', '-e', `${commitSha}^{commit}`], repoPath, {
      disableReplaceObjects: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getFileDiffCommitted(
  worktreePath: string,
  filePath: string,
  baseBranch?: string,
): Promise<FileDiffContent> {
  const mergeBase = await getMergeBaseForBranch(worktreePath, baseBranch);
  if (!mergeBase)
    return { oldValue: '', newValue: '', truncated: false, binary: false };
  if (isPreviewableImagePath(filePath)) {
    return buildImageDiffContent(
      filePath,
      getFileAtRefBuffer(worktreePath, mergeBase, filePath),
      getFileAtRefBuffer(worktreePath, 'HEAD', filePath),
    );
  }
  if (await isFileBinary(worktreePath, filePath, mergeBase, 'HEAD')) {
    return { oldValue: '', newValue: '', truncated: false, binary: true };
  }
  const oldRaw = await getFileAtRef(worktreePath, mergeBase, filePath);
  const newRaw = await getFileAtRef(worktreePath, 'HEAD', filePath);
  const old = truncateContent(oldRaw);
  const nw = truncateContent(newRaw);
  return {
    oldValue: old.value,
    newValue: nw.value,
    truncated: old.truncated || nw.truncated,
    binary: false,
  };
}

export async function getFileDiffCombined(
  worktreePath: string,
  filePath: string,
  baseBranch?: string,
): Promise<FileDiffContent> {
  const mergeBase = await getMergeBaseForBranch(worktreePath, baseBranch);
  const ref = mergeBase ?? 'HEAD';
  if (isPreviewableImagePath(filePath)) {
    return buildImageDiffContent(
      filePath,
      getFileAtRefBuffer(worktreePath, ref, filePath),
      getWorkingTreeFileBuffer(worktreePath, filePath),
    );
  }
  if (await isFileBinary(worktreePath, filePath, ref)) {
    return { oldValue: '', newValue: '', truncated: false, binary: true };
  }
  const oldRaw = await getFileAtRef(worktreePath, ref, filePath);
  const newRaw = await getWorkingTreeFile(worktreePath, filePath);
  const old = truncateContent(oldRaw);
  const nw = truncateContent(newRaw);
  return {
    oldValue: old.value,
    newValue: nw.value,
    truncated: old.truncated || nw.truncated,
    binary: false,
  };
}

export async function getFileDiffBetweenTrees(
  repoPath: string,
  filePath: string,
  startTree: string,
  endTree: string,
): Promise<FileDiffContent> {
  return getFileDiffBetweenTreesWithPaths(
    repoPath,
    filePath,
    filePath,
    startTree,
    endTree,
  );
}

/**
 * Trusted tree-to-tree reader for rename/copy records. Callers must derive the
 * old path from Git's immutable changed-file set rather than renderer input.
 */
export async function getFileDiffBetweenTreesWithPaths(
  repoPath: string,
  oldFilePath: string,
  newFilePath: string,
  startTree: string,
  endTree: string,
  options?: {
    disableReplaceObjects?: boolean;
    disableTextconv?: boolean;
  },
): Promise<FileDiffContent> {
  if (
    isPreviewableImagePath(oldFilePath) ||
    isPreviewableImagePath(newFilePath)
  ) {
    return buildImageDiffContentWithPaths(
      oldFilePath,
      newFilePath,
      getFileAtRefBuffer(repoPath, startTree, oldFilePath, options),
      getFileAtRefBuffer(repoPath, endTree, newFilePath, options),
    );
  }
  if (
    oldFilePath === newFilePath &&
    (await isFileBinary(repoPath, newFilePath, startTree, endTree, options))
  ) {
    return { oldValue: '', newValue: '', truncated: false, binary: true };
  }
  const numstat =
    oldFilePath === newFilePath
      ? ''
      : await runGit(
          [
            'diff',
            startTree,
            endTree,
            '--numstat',
            '--no-ext-diff',
            ...(options?.disableTextconv ? ['--no-textconv'] : []),
            '--',
            oldFilePath,
            newFilePath,
          ],
          repoPath,
          options,
        ).catch(() => '');
  if (
    oldFilePath !== newFilePath &&
    numstat.split('\n').some((line) => line.startsWith('-\t-\t'))
  ) {
    return { oldValue: '', newValue: '', truncated: false, binary: true };
  }
  const oldRaw = await getFileAtRef(repoPath, startTree, oldFilePath, options);
  const newRaw = await getFileAtRef(repoPath, endTree, newFilePath, options);
  const old = truncateContent(oldRaw);
  const nw = truncateContent(newRaw);
  return {
    oldValue: old.value,
    newValue: nw.value,
    truncated: old.truncated || nw.truncated,
    binary: false,
  };
}

export async function addRemoteAndSync(
  repoPath: string,
  remoteUrl: string,
): Promise<void> {
  await runGit(['remote', 'add', 'origin', remoteUrl], repoPath);

  try {
    await runGit(['fetch', 'origin'], repoPath);

    const [defaultBranch, currentBranch, commitCount] = await Promise.all([
      getRemoteDefaultBranch(repoPath),
      getCurrentBranch(repoPath),
      getLocalCommitCount(repoPath),
    ]);

    if (defaultBranch) {
      // Only use -X theirs for fresh repos (single initial commit) to avoid
      // silently overwriting user content in repos with real work.
      const mergeStrategy =
        commitCount <= 1 ? ['-X', 'theirs'] : ['-X', 'ours'];

      await runGit(
        [
          'pull',
          '--no-rebase',
          '--no-edit',
          ...mergeStrategy,
          'origin',
          defaultBranch,
          '--allow-unrelated-histories',
        ],
        repoPath,
      );

      // Best-effort push — may fail due to branch protection rules
      const pushTarget =
        currentBranch === defaultBranch ? 'HEAD' : `HEAD:${defaultBranch}`;
      try {
        await runGit(['push', '-u', 'origin', pushTarget], repoPath);
      } catch {
        // Push rejected (e.g. protected branch) — link is still valid
      }
      return;
    }

    // Best-effort push for repos with no detected default branch
    try {
      await runGit(['push', '-u', 'origin', 'HEAD'], repoPath);
    } catch {
      // Push rejected — link is still valid
    }
  } catch (cause) {
    await abortMerge(repoPath);
    await removeOriginRemote(repoPath);
    const detail = cause instanceof Error ? cause.message : 'Unknown git error';
    throw new Error(`Failed to link remote: ${detail}`);
  }
}

/**
 * Create a commit, allowing an empty tree (no staged changes). Used by the
 * split-PR carve engine, which sometimes needs a commit boundary even when a
 * carved slice has no file changes of its own.
 */
export async function commitAllowEmpty(
  worktreePath: string,
  message: string,
): Promise<void> {
  await runGit(['commit', '--allow-empty', '-m', message], worktreePath);
}

/**
 * Apply a patch to both the index and working tree via stdin.
 * `unidiffZero` maps to `--unidiff-zero`, used for zero-context patches.
 */
export async function applyIndexPatch(
  worktreePath: string,
  patchText: string,
  options: { unidiffZero: boolean },
): Promise<void> {
  const args = ['apply', '--index'];
  if (options.unidiffZero) {
    args.push('--unidiff-zero');
  }
  await runGit(args, worktreePath, { stdin: patchText });
}

/**
 * Apply a patch to the working tree with Git's three-way merge fallback.
 */
export async function applyPatch3Way(
  worktreePath: string,
  patchText: string,
): Promise<{ appliedWithConflicts: boolean }> {
  if (patchText.length === 0) {
    return { appliedWithConflicts: false };
  }
  try {
    await runGit(['apply', '--3way', '--whitespace=nowarn'], worktreePath, {
      stdin: patchText,
    });
    return { appliedWithConflicts: false };
  } catch (error) {
    // `git apply --3way` exits 1 after WRITING conflict markers when the
    // three-way merge conflicts ("Applied patch to '<file>' with conflicts.").
    // That outcome is a partial success, not a no-op — callers must tell the
    // user to resolve markers rather than claim nothing was applied.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('with conflicts')) {
      return { appliedWithConflicts: true };
    }
    throw error;
  }
}

/**
 * Uncommitted tracked changes (worktree + index vs HEAD) as a `--binary`
 * patch that `git apply` can re-apply losslessly, including modified binary
 * files. Unlike {@link getCombinedDiffText} this THROWS on failure: it backs
 * session export, where silently returning '' would drop the user's changes
 * from the bundle without any warning.
 */
export async function getUncommittedBinaryDiffText(
  repoPath: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    await getResolvedGitExecutableForSpawn(),
    ['diff', '--binary', 'HEAD'],
    {
      cwd: repoPath,
      // Binary patches inflate quickly; keep headroom well above the default
      // runner's 8MB so a large asset edit fails the export loudly, not often.
      maxBuffer: 1024 * 1024 * 128,
      windowsHide: process.platform === 'win32',
    },
  );
  return stdout;
}

/**
 * Restore specific paths in the working tree and index to their state at
 * `ref`.
 */
export async function checkoutPathsFromRef(
  worktreePath: string,
  ref: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  await runGit(['checkout', ref, '--', ...paths], worktreePath);
}

/**
 * Remove paths from the working tree and index.
 */
export async function removePaths(
  worktreePath: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  await runGit(['rm', '-f', '--', ...paths], worktreePath);
}

/**
 * Merge `branch` into the current branch with `--no-ff`, always creating a
 * merge commit even when a fast-forward would be possible.
 */
export async function mergeBranch(
  worktreePath: string,
  branch: string,
  message: string,
): Promise<void> {
  await runGit(['merge', '--no-ff', '-m', message, branch], worktreePath);
}

/**
 * Delete a local branch. `force` maps to `-D` instead of `-d`.
 */
export async function deleteLocalBranch(
  repoPath: string,
  branch: string,
  force: boolean,
): Promise<void> {
  await runGit(['branch', force ? '-D' : '-d', branch], repoPath);
}

/**
 * Resolve the tree SHA that `ref` points to.
 */
export async function getTreeSha(
  repoPath: string,
  ref: string,
): Promise<string> {
  return runGit(['rev-parse', `${ref}^{tree}`], repoPath);
}

/**
 * Return whether `ancestor` is an ancestor of `descendant`.
 *
 * `git merge-base --is-ancestor` exits 1 when `ancestor` is not an ancestor
 * of `descendant`, which this treats as a normal `false` result. Any other
 * failure (e.g. exit code 128 for a bad/unknown revision) is rethrown so
 * callers gating mutating operations on this don't silently treat a typo'd
 * SHA or missing ref as a negative answer.
 */
export async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await runGit(
      ['merge-base', '--is-ancestor', ancestor, descendant],
      repoPath,
    );
    return true;
  } catch (error) {
    if (getErrorExitCode(error) === 1) {
      return false;
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Resolve `ref` to a full commit SHA.
 */
export async function resolveRefSha(
  repoPath: string,
  ref: string,
): Promise<string> {
  return runGit(['rev-parse', ref], repoPath);
}

/**
 * Push a local branch to a same-named remote branch on origin. Never force
 * pushes — callers that need to overwrite remote history must handle that
 * explicitly elsewhere.
 */
export async function pushNamedBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  await runGit(['push', '-u', 'origin', `${branch}:${branch}`], repoPath);
}

/**
 * Push `branch` to a same-named branch on `origin` for the shared-container
 * recovery flow, under the same bounded remote timeout and non-interactive
 * credential policy the readiness probe uses.
 *
 * Deliberately narrow: an argument array (never a shell string), no force
 * option, no refspec rewriting, and no working-tree mutation. It publishes the
 * commit `branch` already points at; it never stages, commits, or checks out.
 * Kept separate from `pushNamedBranch` so the PR-splitter's interactive,
 * unbounded push behavior is unchanged.
 *
 * Also omits `-u` on purpose. `pushNamedBranch` sets upstream because its
 * callers want the branch tracked afterwards; this one is a repair step whose
 * only job is to make the commit reachable on `origin`. The readiness
 * classification never consults `branch.<name>.remote`/`.merge` — it resolves
 * the same-named branch against the live remote — so setting upstream would
 * silently rewrite the user's local Git config (changing what a later `git
 * pull` outside Canopy does) to no benefit here.
 */
export async function pushBranchToOriginNonInteractive(
  repoPath: string,
  branch: string,
): Promise<void> {
  await runGit(['push', 'origin', `${branch}:${branch}`], repoPath, {
    timeoutMs: SHARED_CONTAINER_GIT_PUSH_TIMEOUT_MS,
    nonInteractive: true,
  });
}

/**
 * Hard-reset the working tree and index to `ref`. Used by the carve engine
 * to restore a worktree after a failed carve attempt.
 */
export async function resetHardTo(
  worktreePath: string,
  ref: string,
  options?: {
    signal?: AbortSignal;
    skipLfsSmudge?: boolean;
    timeoutMs?: number;
  },
): Promise<void> {
  await runGit(['reset', '--hard', ref], worktreePath, {
    signal: options?.signal,
    skipLfsSmudge: options?.skipLfsSmudge,
    timeoutMs: options?.timeoutMs,
  });
}

/**
 * Remove untracked files and directories from the working tree. Used by the
 * carve engine to finish a restore after `resetHardTo`: a hard reset reverts
 * tracked changes but leaves behind files the carve materialized via
 * `checkoutPathsFromRef` that did not exist at the restore ref. Ignored files
 * (gitignored build artifacts) are intentionally left alone.
 */
export async function cleanUntrackedFiles(
  worktreePath: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  await runGit(['clean', '-fd'], worktreePath, options);
}

/**
 * Return the short name of the branch currently checked out in `worktreePath`,
 * or null when HEAD is detached. Used by the split-PR orchestrator to resolve
 * the original PR's head branch for a fresh (non-resume) run.
 */
export async function getCheckedOutBranch(
  worktreePath: string,
): Promise<string | null> {
  try {
    const name = await runGit(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      worktreePath,
    );
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Create a branch pointing at `startPoint` WITHOUT switching the repo's
 * checkout. Uses `git branch <name> <startPoint>` plumbing so the user's
 * working tree is never mutated. Used by the split-PR orchestrator to create
 * the integration branch and reconstruct-tip scaffolding off the original
 * worktree path without disturbing what it has checked out.
 */
export async function createBranchAt(
  repoPath: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await runGit(['branch', branch, startPoint], repoPath);
}

/**
 * Create `branch` pointing at a fresh empty commit on top of `startPoint`,
 * WITHOUT switching the repo's checkout. Uses `git commit-tree` plumbing to
 * mint a commit that reuses `startPoint`'s tree with `startPoint` as its single
 * parent, then points `branch` at it via `git branch`. This is the no-checkout
 * equivalent of `git commit --allow-empty` and is used to seed the split-PR
 * integration branch with its initialization commit so Octokit's `pulls.create`
 * has a real head commit while the file diff stays empty.
 */
export async function createBranchWithEmptyCommit(
  repoPath: string,
  branch: string,
  startPoint: string,
  message: string,
): Promise<string> {
  const startTree = await runGit(
    ['rev-parse', `${startPoint}^{tree}`],
    repoPath,
  );
  const commitSha = await runGit(
    ['commit-tree', startTree, '-p', startPoint, '-m', message],
    repoPath,
  );
  await runGit(['branch', branch, commitSha], repoPath);
  return commitSha;
}

/**
 * Add a temporary detached worktree at `worktreePath` checked out at `ref`,
 * WITHOUT switching the primary repo's checkout. Callers MUST remove it via
 * `removeGitWorktree` in a finally block. Used by the split-PR reconstruct-tip
 * check so leaf-branch merges happen in a throwaway worktree rather than the
 * user's checkout.
 */
export async function addDetachedWorktree(
  repoPath: string,
  worktreePath: string,
  ref: string,
  options?: { signal?: AbortSignal },
): Promise<void> {
  await runGit(
    disableGitHooks(['worktree', 'add', '--detach', worktreePath, ref]),
    repoPath,
    { signal: options?.signal },
  );
}

/**
 * Remove a worktree previously added via `addDetachedWorktree`. Forced so a
 * dirty temp worktree (e.g. a merge left mid-flight) is still cleaned up.
 */
export async function removeGitWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  await runGit(['worktree', 'remove', '--force', worktreePath], repoPath);
}

/** Parse one CR/LF-delimited git progress line. */
export function parseCloneProgress(line: string): number | null {
  const match = /(?:Receiving objects|Resolving deltas):\s+(\d{1,3})%/.exec(
    line,
  );
  if (!match) return null;
  const percent = Number(match[1]);
  return percent <= 100 ? percent : null;
}

export class GitCloneError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Asynchronous clone with bounded stderr and cancellation of credential-helper children. */
export async function cloneRepoWithProgress(
  url: string,
  destination: string,
  options: {
    nonInteractive: true;
    signal?: AbortSignal;
    timeoutMs?: number;
    onProgress: (percent: number) => void;
  },
): Promise<void> {
  const executable = await getResolvedGitExecutableForSpawn();
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60 * 1000);
  if (options.signal?.aborted) throw new GitCloneError('Clone cancelled', '');
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      executable,
      [
        '-c',
        `core.hooksPath=${devNull}`,
        'clone',
        // Checkout is the first moment repository-controlled content gets a
        // say, and a committed `.gitattributes` can name any filter driver the
        // user happens to have configured globally — not just LFS. So nothing
        // is checked out here at all; `checkoutClonedWorktree` populates the
        // tree afterwards with filters disabled wholesale.
        '--no-checkout',
        '--progress',
        '--',
        url,
        destination,
      ],
      {
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: {
          ...getEnhancedEnv({
            includeCanopySecrets: false,
            environment: false,
          }),
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_LFS_SKIP_SMUDGE: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let tail = Buffer.alloc(0);
    let pending = '';
    let stopped = false;
    let lastPercent: number | null = null;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        execFile(
          'taskkill',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          (): void => {},
        );
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    };
    const timer = setTimeout(stop, options.timeoutMs ?? 15 * 60 * 1000);
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    const clean = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
    };
    child.stderr.on('data', (chunk: Buffer): void => {
      tail = Buffer.concat([tail, chunk]).subarray(-8192);
      pending += chunk.toString('utf8');
      const lines = pending.split(/[\r\n]/);
      pending = (lines.pop() ?? '').slice(-8192);
      for (const line of lines) {
        const percent = parseCloneProgress(line);
        if (percent !== null && percent !== lastPercent) {
          lastPercent = percent;
          options.onProgress(percent);
        }
      }
    });
    child.once('error', (error): void => {
      clean();
      reject(new GitCloneError(error.message, tail.toString('utf8')));
    });
    child.once('close', (code): void => {
      clean();
      if (code === 0 && !stopped) resolvePromise();
      else
        reject(
          new GitCloneError(
            stopped ? 'Clone cancelled or timed out' : 'Clone failed',
            tail.toString('utf8'),
          ),
        );
    });
  });
  // Populating the tree is part of cloning, not a step a caller can forget:
  // the `--no-checkout` above is only safe because this runs. It shares the
  // caller's deadline rather than starting a second one — the claim lease this
  // budget protects does not restart either.
  await checkoutClonedWorktree(destination, {
    signal: options.signal,
    timeoutMs: Math.max(1, deadline - Date.now()),
  });
}

/**
 * Populate the working tree of a `--no-checkout` clone without letting the
 * repository choose what runs on this machine.
 *
 * `.git/info/attributes` outranks any `.gitattributes` committed in the tree,
 * so one `* -filter` line unsets the filter attribute for every path. That
 * covers whatever driver the repository names, not a list of the ones we
 * thought of — LFS included — and needs no knowledge of the user's global Git
 * configuration.
 */
async function checkoutClonedWorktree(
  repoPath: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const attributes = join(repoPath, '.git', 'info', 'attributes');
  // A clone made from a configured `init.templateDir` can arrive with this
  // file already written. It is the user's, not ours, so it is put back
  // exactly as found — byte for byte, since attributes files are not required
  // to be UTF-8 — and the safety rule below is for this checkout only. A file
  // that exists but cannot be read is not something to overwrite and then
  // delete, so the clone stops instead.
  const original = await readFile(attributes).catch((error: unknown): null => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return null;
    throw new GitCloneError(
      'Could not read the repository attributes file',
      String(error),
    );
  });
  await mkdir(dirname(attributes), { recursive: true });
  await writeFile(attributes, '* -filter -diff -merge -text\n', 'utf8');
  try {
    // A repository with no commits has nothing to populate, and asking for HEAD
    // there exits non-zero rather than returning nothing. `--quiet` makes that
    // exit code the only signal, so the two cases are told apart by asking
    // whether any ref exists at all: no refs means an empty repository, while a
    // HEAD that will not resolve in a repository that has refs is a clone whose
    // remote HEAD points at a deleted or renamed branch — populating nothing
    // there would look like success.
    const head = await runGit(
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      repoPath,
      { nonInteractive: true, signal: options?.signal },
    ).catch((): string => '');
    if (head === '') {
      const refs = await runGit(['for-each-ref', '--count=1'], repoPath, {
        nonInteractive: true,
        signal: options?.signal,
      }).catch((): string => '');
      if (refs !== '')
        throw new GitCloneError(
          'Clone has no usable default branch',
          `HEAD did not resolve in ${repoPath}`,
        );
      return;
    }
    await runGit(
      // The clone disables hooks for itself; this is a second invocation and
      // needs saying again. A committed `post-checkout` would otherwise run
      // here, which is exactly what checking out untrusted content must not do.
      ['-c', `core.hooksPath=${devNull}`, 'checkout', 'HEAD', '--', '.'],
      repoPath,
      {
        nonInteractive: true,
        skipLfsSmudge: true,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      },
    );
  } finally {
    // The file exists to make *this* checkout safe. Leaving it behind would
    // silently disable LFS, diff and merge drivers, and text normalization for
    // every later operation in the user's own repository.
    if (original === null) await rm(attributes, { force: true });
    else await writeFile(attributes, original);
  }
}
