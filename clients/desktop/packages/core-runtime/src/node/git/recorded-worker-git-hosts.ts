import { selectGitDefaultBranch } from './default-branch';
import { selectAvailableGitBranchName } from './branch-writes';
import { addGitWorktree } from './worktree-writes';
import { readGitHeadState } from './head-state';
import type { WorkerGitWorktreeWriteHost } from './worker-git-worktree-writes';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  CanopyWorkspaceScope,
  WorkerGitExecutableIssue,
  WorkerGitExecutableSource,
  WorkerGitRecordedRepositoryScope,
} from '@canopy/protocol/canopy-core';
import {
  getGitExecutableDetectionMode,
  getGitExecutableRequirement,
} from '@canopy/protocol/git-executable';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/protocol/ui-labels';
import {
  classifyPersistedWorkspaceOwner,
  normalizeUuid,
} from '@canopy/protocol/workspace-owner';
import {
  readWorkspaceIndex,
  readWorkspaceManifest,
  readWorktreeList,
  type WorkspaceFileRead,
} from '../workspace/read-formats';
import { parseGitWorktreeListPorcelain } from './branch-list';
import {
  GitBranchWriteInterrupted,
  parseGitCheckedOutBranches,
  type GitBranchDeletePort,
  type GitBranchWritePort,
} from './branch-writes';
import type { GitDefaultBranchFacts } from './default-branch';
import {
  GIT_CONVENTIONAL_DEFAULT_BRANCHES,
  GitRepositoryReadError,
  type GitExecutableSelectionFacts,
  type GitRepositoryReader,
  type GitRepositoryReadInvocation,
} from './repository-reads';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  GitRepositoryWriteError,
  type GitRepositoryWrite,
  type GitRepositoryWriteFailureCode,
  type GitRepositoryWriteOutput,
  type GitRepositoryWritePort,
} from './repository-writes';
import {
  WorkerGitScopeError,
  type WorkerGitBranchListHost,
} from './worker-git-branch-list';
import type { WorkerGitBranchWriteHost } from './worker-git-branch-writes';
import { createRecordedWorkerGitCommitPushHost } from './recorded-worker-git-commit-push-host';
import type { WorkerGitCommitPushHost } from './worker-git-commit-push';
import type { WorkerGitMergeHost } from './worker-git-merge';
import { createRecordedWorkerGitSyncHost } from './recorded-worker-git-sync-host';
import type { WorkerGitSyncWriteHost } from './worker-git-sync-writes';
import type {
  WorkerGitExecutableHost,
  WorkerGitExecutableObservation,
} from './worker-git-executable';
import { estimateGitUntrackedChanges } from './untracked-estimate';
import type { WorkerGitDiffHost } from './worker-git-diff';
import type { WorkerGitRemoteHost } from './worker-git-remote-get';
import type { WorkerGitWorktreeHealthHost } from './worker-git-worktree-health';
import type {
  WorktreeHealthPathKind,
  WorktreeHealthRepoEntry,
  WorktreeHealthSources,
} from './worktree-health';

/** The reads these hosts make outside Git; Node's by default. */
export interface WorkerGitRecordFiles {
  readRecord(this: void, absolutePath: string): Promise<WorkspaceFileRead>;
  readText(this: void, absolutePath: string): Promise<string>;
  stat(this: void, absolutePath: string): Promise<WorktreeHealthPathKind>;
  lstat(this: void, absolutePath: string): Promise<WorktreeHealthPathKind>;
  readDirectory(
    this: void,
    absolutePath: string,
  ): Promise<readonly { name: string; isDirectory(): boolean }[]>;
  realpath(this: void, absolutePath: string): Promise<string>;
}

export interface RecordedWorkerGitHostsOptions {
  /** The canonical data root whose workspace records select repositories. */
  readonly dataRoot: string;
  /** The verified authority the hosts serve; no target is served (D7). */
  readonly authorityId: string;
  /** The execution target whose records the hosts read. */
  readonly recordsTargetId: string;
  /** The host's Node.js platform and architecture, for executable status. */
  readonly os: string;
  readonly arch: string;
  /** Read-only repository reads and selection from the one Git read host. */
  readonly git: GitRepositoryReader;
  /**
   * The branch write commands, from the one Git write host. Absent, every
   * branch change fails as Git unavailable before any command runs.
   */
  readonly writes?: GitRepositoryWritePort;
  readonly files?: Partial<WorkerGitRecordFiles>;
  readonly now?: () => Date;
}

/** A repository location and the recorded roots its Git output may name. */
export interface RecordedGitRepository {
  readonly path: string;
  readonly recorded: readonly string[];
}

export interface RecordedGitWorktree {
  readonly record: RecordedGitWorkspace;
  readonly worktreeId: string;
  readonly worktreePath: string;
}

export interface RecordedWorkerGitHosts {
  readonly worktreeWrite: WorkerGitWorktreeWriteHost;
  readonly branchList: WorkerGitBranchListHost<RecordedGitRepository>;
  readonly branchWrite: WorkerGitBranchWriteHost<RecordedGitRepository, string>;
  /** `worker.git.fetch` and `worker.git.pull`, on the branch writes' checkouts. */
  readonly syncWrite: WorkerGitSyncWriteHost<RecordedGitRepository>;
  readonly commitPush: WorkerGitCommitPushHost<RecordedGitRepository>;
  readonly mergeWrite: WorkerGitMergeHost<RecordedGitRepository>;
  readonly remote: WorkerGitRemoteHost<string>;
  readonly worktreeHealth: WorkerGitWorktreeHealthHost<RecordedGitWorktree>;
  readonly executable: WorkerGitExecutableHost;
  /** Changed files only: no patch reads, so `paths` is refused (CAN-4103). */
  readonly diff: WorkerGitDiffHost<string>;
}

/** A repository a workspace record names. */
export interface RecordedGitRepo {
  readonly id: string;
  readonly name: string;
  readonly repoPath: string | null;
}

/** One tracked workspace's record, as these hosts read it. */
export interface RecordedGitWorkspace {
  readonly workspaceId: string;
  readonly type: 'single-repo' | 'multi-repo' | 'cowork';
  readonly base: string;
  readonly repoPath: string | null;
  readonly sourceRepoPath: string | null;
  readonly repos: readonly RecordedGitRepo[];
}

async function readRecordFile(
  absolutePath: string,
): Promise<WorkspaceFileRead> {
  try {
    return { state: 'present', raw: await readFile(absolutePath, 'utf8') };
  } catch (error) {
    return {
      state:
        typeof error === 'object' &&
        error !== null &&
        Reflect.get(error, 'code') === 'ENOENT'
          ? 'absent'
          : 'unreadable',
    };
  }
}

const NODE_FILES: WorkerGitRecordFiles = {
  readRecord: readRecordFile,
  readText: (absolutePath) => readFile(absolutePath, 'utf8'),
  stat: (absolutePath) => stat(absolutePath),
  lstat: (absolutePath) => lstat(absolutePath),
  readDirectory: (absolutePath) =>
    readdir(absolutePath, { withFileTypes: true }),
  realpath: (absolutePath) => realpath(absolutePath),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The scope reader's workspace and worktree id rule.
function safeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    /^[a-z0-9][a-z0-9-]*$/.test(value)
  );
}

const invalid = (message: string): WorkerGitScopeError =>
  new WorkerGitScopeError('invalid', message);
const unresolved = (): WorkerGitScopeError =>
  new WorkerGitScopeError(
    'unsupported',
    'The selected scope cannot be resolved from trusted workspace records.',
  );

/** A recorded location Git can run in: absolute, without NUL. */
function usablePath(value: unknown): string | null {
  return typeof value === 'string' &&
    value !== '' &&
    isAbsolute(value) &&
    !value.includes('\0')
    ? resolve(value)
    : null;
}

const firstLine = (output: string): string => output.trim();

/** The request's signal and forwarded environment, for each Git read it makes. */
function invocationOf({
  signal,
  execution,
}: CanopyHandlerContext): GitRepositoryReadInvocation {
  return { signal, environment: execution?.childEnvironment };
}

const CANCELLED_MESSAGE = 'The operation was cancelled.';

const UNAVAILABLE_WRITES: GitRepositoryWritePort = Object.freeze({
  run: () => Promise.reject(new GitRepositoryWriteError('git_unavailable')),
});

/** Write-host failures that mean no Git ran: the change is unavailable. */
const UNAVAILABLE_WRITE_CODES: ReadonlySet<GitRepositoryWriteFailureCode> =
  new Set(['stopped', 'git_unavailable']);

/**
 * Worktree-list failures in which Git itself answered, or printed past the
 * 8 MiB the desktop's runner also refuses: retrying cannot change them.
 */
const BEST_EFFORT_READ_CODES: ReadonlySet<GitRepositoryReadError['code']> =
  new Set(['exit_status', 'invalid_request', 'output_limit']);

/**
 * `worker.git.*` hosts over canonical workspace records and a read-only Git
 * host: every repository location comes from a tracked record, and a root
 * derived from Git output is used only when the records name it. Reads only:
 * no Canopy store, ref or preference is written.
 */
export function createRecordedWorkerGitHosts(
  options: RecordedWorkerGitHostsOptions,
): RecordedWorkerGitHosts {
  const { dataRoot, authorityId, recordsTargetId, git } = options;
  if (!isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot)
    throw new Error('Recorded Git hosts require a canonical data root.');
  if (authorityId.trim() === '' || recordsTargetId.trim() === '')
    throw new Error('Recorded Git hosts require an authority and a target.');
  const files: WorkerGitRecordFiles = { ...NODE_FILES, ...options.files };
  const now = options.now ?? ((): Date => new Date());

  /** Validates every selector before the first read; returns the owner selector. */
  function checkSelectors(scope: CanopyWorkspaceScope): string | undefined {
    if (!safeId(scope.workspaceId))
      throw invalid('The workspace id is invalid.');
    if (scope.worktreeId !== undefined && !safeId(scope.worktreeId))
      throw invalid('The worktree id is invalid.');
    if (
      scope.repoId !== undefined &&
      scope.repoId !== WORKSPACE_ROOT_REPO_ID &&
      !safeId(scope.repoId)
    )
      throw invalid('The repository id is invalid.');
    if (scope.organizationId === undefined) return undefined;
    const selector = normalizeUuid(scope.organizationId);
    if (selector === null) throw invalid('The organization id is invalid.');
    return selector;
  }

  /** The one readable index entry for `workspaceId`. */
  async function indexEntry(
    workspaceId: string,
  ): Promise<RecordedGitWorkspace['type']> {
    const index = readWorkspaceIndex(
      await files.readRecord(join(dataRoot, 'workspaces', 'index.json')),
      () => undefined,
    );
    if (index.authority === 'unreadable' || index.authority === 'absent')
      throw unresolved();
    if (
      index.unreadableEntries.some(
        (entry) => typeof entry.id !== 'string' || entry.id === workspaceId,
      )
    )
      throw unresolved();
    const [selected, ...others] = index.entries.filter(
      (entry) => entry.id === workspaceId,
    );
    if (!selected || others.length > 0) throw unresolved();
    return selected.type;
  }

  function recordedRepos(config: Record<string, unknown>): RecordedGitRepo[] {
    if (config.repos !== undefined && !Array.isArray(config.repos))
      throw unresolved();
    const repos: RecordedGitRepo[] = [];
    for (const repo of Array.isArray(config.repos) ? config.repos : []) {
      if (
        !isRecord(repo) ||
        !safeId(repo.id) ||
        typeof repo.name !== 'string' ||
        typeof repo.repoPath !== 'string'
      )
        throw unresolved();
      repos.push({
        id: repo.id,
        name: repo.name,
        repoPath: usablePath(repo.repoPath),
      });
    }
    return repos;
  }

  /** Refuses a manifest for another workspace, authority, target or owner. */
  function checkManifest(
    config: Record<string, unknown>,
    workspaceId: string,
    selector: string | undefined,
  ): void {
    const expected = { workspaceId, authorityId, targetId: recordsTargetId };
    for (const key of ['workspaceId', 'authorityId', 'targetId'] as const)
      if (config[key] !== undefined && config[key] !== expected[key])
        throw unresolved();
    const owner = classifyPersistedWorkspaceOwner(config.owner);
    if (owner.kind === 'malformed') throw unresolved();
    const organizationId =
      owner.kind === 'organization' ? owner.owner.organizationId : undefined;
    if (selector !== undefined && selector !== organizationId)
      throw unresolved();
  }

  /** One tracked workspace's manifest, read with the scope reader's checks. */
  async function readWorkspace(
    scope: CanopyWorkspaceScope,
  ): Promise<RecordedGitWorkspace> {
    const selector = checkSelectors(scope);
    const workspaceId = scope.workspaceId ?? '';
    const type = await indexEntry(workspaceId);
    const base = join(dataRoot, 'workspaces', workspaceId);
    const manifest = readWorkspaceManifest(
      await files.readRecord(join(base, 'workspace.json')),
    );
    if (manifest.authority !== 'ok') throw unresolved();
    const config = manifest.document;
    const declared =
      config.type === undefined
        ? typeof config.repoPath === 'string'
          ? 'single-repo'
          : 'multi-repo'
        : config.type;
    if (declared !== type) throw unresolved();
    checkManifest(config, workspaceId, selector);
    return {
      workspaceId,
      type,
      base,
      repoPath: type === 'single-repo' ? usablePath(config.repoPath) : null,
      sourceRepoPath: usablePath(config.sourceRepoPath),
      repos: recordedRepos(config),
    };
  }

  /** Every repository location the workspace records. */
  function recordedLocations(record: RecordedGitWorkspace): string[] {
    return [
      record.repoPath,
      record.sourceRepoPath,
      ...record.repos.map(({ repoPath }) => repoPath),
    ].filter((location): location is string => location !== null);
  }

  async function sameLocation(left: string, right: string): Promise<boolean> {
    if (left === right) return true;
    const [realLeft, realRight] = await Promise.all([
      files.realpath(left).catch(() => null),
      files.realpath(right).catch(() => null),
    ]);
    return realLeft !== null && realLeft === realRight;
  }

  /**
   * The main repository root Git names for `checkout` (desktop's
   * `getRepoRootFromWorktree`), as the recorded location it matches; `null`
   * when no recorded location, or `checkout` itself, is that root.
   */
  async function recordedRoot(
    checkout: string,
    recorded: readonly string[],
    invocation: GitRepositoryReadInvocation,
  ): Promise<string | null> {
    const commonDir = firstLine(
      await git.read({ kind: 'common-dir' }, checkout, invocation),
    );
    const resolved = isAbsolute(commonDir)
      ? commonDir
      : join(checkout, commonDir);
    const root = dirname(resolved.replace(/[/\\]worktrees[/\\][^/\\]+$/, ''));
    for (const candidate of [checkout, ...recorded])
      if (await sameLocation(root, candidate)) return candidate;
    return null;
  }

  /** A configured reference location at its recorded main root, else as configured. */
  async function referenceRoot(
    configured: string,
    record: RecordedGitWorkspace,
    invocation: GitRepositoryReadInvocation,
  ): Promise<string> {
    try {
      return (
        (await recordedRoot(
          configured,
          recordedLocations(record),
          invocation,
        )) ?? configured
      );
    } catch {
      invocation.signal.throwIfAborted();
      return configured;
    }
  }

  /** A worktree a tracked code workspace lists. */
  async function readWorktree(
    record: RecordedGitWorkspace,
    worktreeId: string,
  ): Promise<string> {
    if (record.type === 'cowork') throw unresolved();
    const list = readWorktreeList(
      await files.readRecord(join(record.base, 'worktrees.json')),
    );
    if (list.authority !== 'ok' || list.unreadableRowIds.includes(worktreeId))
      throw unresolved();
    const rows = list.worktrees.filter((row) => row.id === worktreeId);
    const [row] = rows;
    if (
      rows.length !== 1 ||
      (row?.workspaceId !== undefined && row.workspaceId !== record.workspaceId)
    )
      throw unresolved();
    return join(record.base, 'worktrees', worktreeId);
  }

  const read = (
    kind: 'origin-url' | 'remote-names' | 'git-dir' | 'remote-head',
    cwd: string,
    invocation: GitRepositoryReadInvocation,
  ): Promise<string> => git.read({ kind }, cwd, invocation);

  function defaultBranchFacts(
    path: string,
    invocation: GitRepositoryReadInvocation,
  ): GitDefaultBranchFacts {
    const { signal } = invocation;
    return {
      // Recorded freshness is the in-process projection's; this host reads
      // no Canopy store.
      readHint: () => Promise.resolve(null),
      readRemoteHead: async () =>
        (await read('remote-head', path, invocation)).match(
          /^ref: refs\/heads\/([^\t\r\n]+)\tHEAD\r?$/m,
        )?.[1] ?? null,
      readLocalOriginHead: async (): Promise<string | null> => {
        try {
          const ref = await git.read({ kind: 'origin-head' }, path, invocation);
          return (
            ref.replace(/\r?\n$/, '').replace('refs/remotes/origin/', '') ||
            null
          );
        } catch {
          signal.throwIfAborted();
          return null;
        }
      },
      readConventional: async (): Promise<string | null> => {
        for (const branch of GIT_CONVENTIONAL_DEFAULT_BRANCHES) {
          try {
            await git.read({ kind: 'origin-branch', branch }, path, invocation);
            return branch;
          } catch {
            signal.throwIfAborted();
          }
        }
        return null;
      },
    };
  }

  /** The checkout a listed worktree, or its member `repoId`, names. */
  async function recordedCheckout(
    record: RecordedGitWorkspace,
    scope: CanopyWorkspaceScope,
  ): Promise<RecordedGitRepository> {
    const home = await readWorktree(record, scope.worktreeId ?? '');
    if (scope.repoId === undefined || scope.repoId === WORKSPACE_ROOT_REPO_ID)
      return {
        path: home,
        recorded: [record.repoPath ?? record.sourceRepoPath].filter(
          (location): location is string => location !== null,
        ),
      };
    const member =
      record.type === 'multi-repo'
        ? record.repos.find(({ id }) => id === scope.repoId)
        : undefined;
    if (!member) throw unresolved();
    return {
      path: join(home, 'repos', member.id),
      recorded: member.repoPath === null ? [] : [member.repoPath],
    };
  }

  /** `worktree list --porcelain` in the recorded main root of `path`. */
  async function readRecordedWorktreeList(
    { path, recorded }: RecordedGitRepository,
    invocation: GitRepositoryReadInvocation,
  ): Promise<{ output: string; checkoutPath: string }> {
    const root = await recordedRoot(path, recorded, invocation);
    if (root === null) throw new GitRepositoryReadError('invalid_request');
    return {
      output: await git.read({ kind: 'worktree-list' }, root, invocation),
      checkoutPath: path,
    };
  }

  const branchList: WorkerGitBranchListHost<RecordedGitRepository> = {
    authorityId,
    resolveRepository: async ({ scope, repository }, context) => {
      const record = await readWorkspace(scope);
      if (repository.kind === 'reference') {
        const configured =
          record.type === 'single-repo'
            ? record.repoPath
            : record.type === 'multi-repo'
              ? record.sourceRepoPath
              : null;
        if (configured === null) return null;
        const path = await referenceRoot(
          configured,
          record,
          invocationOf(context),
        );
        return { path, recorded: [path] };
      }
      return recordedCheckout(record, scope);
    },
    reads: (checkout, context) => {
      const invocation = invocationOf(context);
      return {
        readBranchRefs: () =>
          git.read({ kind: 'branch-refs' }, checkout.path, invocation),
        readWorktreeList: () => readRecordedWorktreeList(checkout, invocation),
        defaultBranchFacts: defaultBranchFacts(checkout.path, invocation),
        readHeadUnborn: async () =>
          (
            await readGitHeadState(checkout.path, {
              verifyCommit: () =>
                git.read({ kind: 'head-commit' }, checkout.path, invocation),
              signal: invocation.signal,
            })
          ).headUnborn,
      };
    },
    now: () => now().getTime(),
  };

  const writes = options.writes ?? UNAVAILABLE_WRITES;

  /**
   * The write host's commands in `cwd`. A write host that is stopping or has
   * no Git interrupts the change instead of answering. No write takes a
   * signal, but after a cancel an effect that has not started does not start.
   * Every command runs with the request's forwarded environment (CAN-5496).
   */
  function writeCommands(
    cwd: string,
    { signal, environment }: GitRepositoryReadInvocation,
  ): {
    readonly run: (
      write: GitRepositoryWrite,
    ) => Promise<GitRepositoryWriteOutput>;
    readonly succeeded: (write: GitRepositoryWrite) => Promise<string>;
    readonly unlessCancelled: (write: GitRepositoryWrite) => Promise<void>;
    readonly probe: (write: GitRepositoryWrite) => Promise<boolean>;
  } {
    const run = async (
      write: GitRepositoryWrite,
    ): Promise<GitRepositoryWriteOutput> => {
      try {
        return await writes.run(write, cwd, environment);
      } catch (error) {
        if (
          error instanceof GitRepositoryWriteError &&
          UNAVAILABLE_WRITE_CODES.has(error.code)
        )
          throw new GitBranchWriteInterrupted(
            'unavailable',
            error.message,
            error,
          );
        throw error;
      }
    };
    const succeeded = async (write: GitRepositoryWrite): Promise<string> => {
      const { exitCode, stdout } = await run(write);
      if (exitCode !== 0) throw new GitRepositoryWriteError('exit_status');
      return stdout;
    };
    return {
      run,
      succeeded,
      // The caller was already answered `cancelled`: a fetch or effect that
      // has not started does not start. A started one still runs to its end.
      unlessCancelled: async (write) => {
        if (signal.aborted)
          throw new GitBranchWriteInterrupted('cancelled', CANCELLED_MESSAGE);
        await succeeded(write);
      },
      probe: async (write) => {
        try {
          return (await run(write)).exitCode === 0;
        } catch (error) {
          if (
            error instanceof GitRepositoryWriteError &&
            error.code === 'invalid_request'
          )
            return false;
          throw error;
        }
      },
    };
  }

  /**
   * A worktree listing cut short by the dispatcher signal or by the read
   * host interrupts the change; Git's own failure is the caller's to judge.
   */
  async function interruptibleListing<T>(
    signal: AbortSignal,
    list: () => Promise<T>,
  ): Promise<T> {
    try {
      return await list();
    } catch (error) {
      if (signal.aborted)
        throw new GitBranchWriteInterrupted(
          'cancelled',
          CANCELLED_MESSAGE,
          error,
        );
      if (
        error instanceof GitRepositoryReadError &&
        BEST_EFFORT_READ_CODES.has(error.code)
      )
        throw error;
      throw new GitBranchWriteInterrupted(
        'unavailable',
        error instanceof GitRepositoryReadError
          ? error.message
          : 'The Git host is unavailable.',
        error,
      );
    }
  }

  /**
   * The branch write port over the write host. A probe answers `false` only
   * when Git ran and said no (or the host refused the value, which no ref can
   * match), as the desktop's did; reads and effects reject. A worktree
   * listing Git fails reads as no occupied branch.
   */
  function branchWritePort(
    checkout: RecordedGitRepository,
    invocation: GitRepositoryReadInvocation,
  ): GitBranchWritePort {
    const { run, succeeded, unlessCancelled, probe } = writeCommands(
      checkout.path,
      invocation,
    );
    const readHeadRef = async (): Promise<string | null> => {
      const { exitCode, stdout } = await run({ kind: 'symbolic-head' });
      if (exitCode === 1) return null;
      if (exitCode !== 0) throw new GitRepositoryWriteError('exit_status');
      return stdout.replace(/\r?\n$/, '');
    };
    return {
      signal: invocation.signal,
      hasUncommittedChanges: async () =>
        firstLine(await succeeded({ kind: 'status' })).length > 0,
      readWorktreeList: () =>
        interruptibleListing(invocation.signal, () =>
          readRecordedWorktreeList(checkout, invocation),
        ),
      localBranchExists: (branch) => probe({ kind: 'local-branch', branch }),
      remoteBranchExists: (branch) => probe({ kind: 'remote-branch', branch }),
      fetchRemoteBranch: (branch) =>
        unlessCancelled({ kind: 'fetch-origin-branch', branch }),
      isValidBranchName: (name) => probe({ kind: 'check-branch-name', name }),
      listLocalBranchesUnder: async (name) =>
        firstLine(await succeeded({ kind: 'local-branches-under', name })),
      currentBranch: async () => {
        const ref = await readHeadRef();
        return ref?.startsWith('refs/heads/')
          ? ref.slice('refs/heads/'.length)
          : 'HEAD';
      },
      readHeadRef,
      checkout: async (branch, continuingCreation) => {
        const write = { kind: 'checkout', branch } as const;
        if (continuingCreation) await succeeded(write);
        else await unlessCancelled(write);
      },
      resolveCatalogBranch: async (branch, remote) => {
        const { exitCode, stdout } = await run({
          kind: 'catalog-branch-tip',
          branch,
          remote,
        });
        if (exitCode === 0) return firstLine(stdout);
        if (exitCode !== 128) throw new GitRepositoryWriteError('exit_status');
        return undefined;
      },
      readTrackingConfig: async () => {
        const { exitCode, stdout } = await run({
          kind: 'branch-tracking-config',
        });
        if (exitCode === 1) return '';
        if (exitCode !== 0) throw new GitRepositoryWriteError('exit_status');
        return stdout;
      },
      checkoutNewBranch: (name, startPoint) =>
        unlessCancelled({ kind: 'checkout-new-branch', name, startPoint }),
      createBranch: async (name, startPoint) => {
        await succeeded({ kind: 'prepare-new-branch', name, startPoint });
      },
      renameCurrentBranch: (name) =>
        unlessCancelled({ kind: 'rename-current-branch', name }),
    };
  }

  /**
   * The branch delete port over the write host, in a recorded repository.
   * The worktree listing runs through the read host; any Git failure of it
   * rejects, as the desktop's did.
   */
  function branchDeletePort(
    repository: string,
    invocation: GitRepositoryReadInvocation,
  ): GitBranchDeletePort {
    const { unlessCancelled } = writeCommands(repository, invocation);
    return {
      listCheckedOutBranches: () =>
        interruptibleListing(invocation.signal, async () =>
          parseGitCheckedOutBranches(
            await git.read({ kind: 'worktree-list' }, repository, invocation),
          ),
        ),
      deleteBranch: (branch, force) =>
        unlessCancelled({
          kind: force ? 'force-delete-branch' : 'delete-branch',
          branch,
        }),
      deleteBranchRef: (branch, tip) =>
        unlessCancelled({ kind: 'delete-branch-ref', branch, tip }),
    };
  }

  /**
   * The repository a workspace record names for `repoId`: its own repository
   * (single-repo, or a multi-repo source repository) for an absent id or
   * `__workspace_root__`, else that multi-repo member's.
   */
  function recordedRepositoryLocation(
    record: RecordedGitWorkspace,
    repoId: string | undefined,
  ): string | null {
    if (repoId === undefined || repoId === WORKSPACE_ROOT_REPO_ID)
      return record.type === 'single-repo'
        ? record.repoPath
        : record.type === 'multi-repo'
          ? record.sourceRepoPath
          : null;
    if (record.type !== 'multi-repo') return null;
    return record.repos.find(({ id }) => id === repoId)?.repoPath ?? null;
  }

  function recordedRepository(
    record: RecordedGitWorkspace,
    scope: WorkerGitRecordedRepositoryScope,
  ): string {
    const location = recordedRepositoryLocation(record, scope.repoId);
    if (location === null) throw unresolved();
    return location;
  }

  const branchWrite: WorkerGitBranchWriteHost<RecordedGitRepository, string> = {
    authorityId,
    resolveCheckout: async (scope) =>
      recordedCheckout(await readWorkspace(scope), scope),
    port: (checkout, context) =>
      branchWritePort(checkout, invocationOf(context)),
    resolveRepository: async (scope) =>
      recordedRepository(await readWorkspace(scope), scope),
    deletePort: (repository, context) =>
      branchDeletePort(repository, invocationOf(context)),
  };

  const worktreeWrite: WorkerGitWorktreeWriteHost = {
    authorityId,
    resolve: async (scope, context, operation) => {
      const record = await readWorkspace(scope);
      if (operation === 'remove' && scope.worktreeId !== undefined)
        await readWorktree(record, scope.worktreeId);
      const configured = recordedRepository(record, scope);
      const invocation = invocationOf(context);
      // Mutations (including their prerequisite reads) finish once admitted.
      const mutationInvocation = {
        ...invocation,
        signal: new AbortController().signal,
      };
      const repository = await referenceRoot(
        configured,
        record,
        mutationInvocation,
      );
      const commands = writeCommands(repository, mutationInvocation);
      const target =
        scope.worktreeId === undefined
          ? undefined
          : join(
              record.base,
              'worktrees',
              scope.worktreeId,
              ...(scope.repoId !== undefined &&
              scope.repoId !== WORKSPACE_ROOT_REPO_ID
                ? ['repos', scope.repoId]
                : []),
            );
      const requireTarget = (): string => {
        if (!target) throw unresolved();
        return target;
      };
      return {
        add: (branch) =>
          addGitWorktree(
            {
              fetch: async () => {
                try {
                  await commands.succeeded({
                    kind: 'fetch-origin',
                    prune: false,
                  });
                } catch (error) {
                  if (error instanceof GitBranchWriteInterrupted) throw error;
                }
              },
              defaultBranch: async () =>
                (
                  await selectGitDefaultBranch(
                    defaultBranchFacts(repository, mutationInvocation),
                    { now: now().getTime() },
                  )
                ).defaultBranch,
              localBranchExists: (branch) =>
                commands.probe({ kind: 'local-branch', branch }),
              availableBranchName: (name) =>
                selectAvailableGitBranchName(
                  branchWritePort(
                    { path: repository, recorded: [repository] },
                    mutationInvocation,
                  ),
                  name,
                ),
              add: async (branch, startPoint, create) => {
                await commands.succeeded({
                  kind: 'worktree-add',
                  path: requireTarget(),
                  branch,
                  startPoint,
                  create,
                });
              },
            },
            branch,
          ),
        remove: async () => {
          await commands.succeeded({
            kind: 'worktree-remove',
            path: requireTarget(),
          });
        },
        prune: async () => {
          await commands.succeeded({ kind: 'worktree-prune' });
        },
      };
    },
  };

  const remote: WorkerGitRemoteHost<string> = {
    authorityId,
    resolveRepository: async ({ scope, repository }, context) => {
      const record = await readWorkspace(scope);
      if (repository.kind === 'source')
        return record.sourceRepoPath === null
          ? null
          : referenceRoot(record.sourceRepoPath, record, invocationOf(context));
      return recordedRepositoryLocation(record, scope.repoId);
    },
    reads: (path, context) => {
      const invocation = invocationOf(context);
      return {
        // desktop `getRemoteUrlStrict`: an absent origin is null, any other
        // failure rejects.
        readOriginUrl: async (): Promise<string | null> => {
          try {
            return firstLine(await read('origin-url', path, invocation));
          } catch (error) {
            invocation.signal.throwIfAborted();
            const remotes = (await read('remote-names', path, invocation))
              .split('\n')
              .map((name) => name.trim());
            if (!remotes.includes('origin')) return null;
            throw error;
          }
        },
        isRepository: () =>
          read('git-dir', path, invocation).then(
            () => true,
            () => false,
          ),
      };
    },
  };

  function healthSources(
    { record, worktreeId, worktreePath }: RecordedGitWorktree,
    invocation: GitRepositoryReadInvocation,
  ): WorktreeHealthSources {
    const isRepository = (path: string): Promise<boolean> =>
      read('git-dir', path, invocation).then(
        () => true,
        () => false,
      );
    return {
      worktreePath,
      readWorkspace: () =>
        Promise.resolve({
          type: record.type,
          repos: record.repos.map(({ id, name }) => ({ id, name })),
          hasSourceRepository: record.sourceRepoPath !== null,
        }),
      // desktop `listWorkspaceWorktreeRepoEntries`.
      listRepositoryEntries: async (): Promise<WorktreeHealthRepoEntry[]> => {
        const entries: WorktreeHealthRepoEntry[] = [];
        if (
          record.type === 'multi-repo' &&
          (record.sourceRepoPath !== null || (await isRepository(worktreePath)))
        )
          entries.push({
            repoId: WORKSPACE_ROOT_REPO_ID,
            repoName: WORKSPACE_ROOT_REPO_NAME,
            repoPath: worktreePath,
          });
        const names = new Map(record.repos.map(({ id, name }) => [id, name]));
        const reposDir = join(worktreePath, 'repos');
        for (const entry of await files
          .readDirectory(reposDir)
          .catch(() => [])) {
          if (!entry.isDirectory()) continue;
          entries.push({
            repoId: entry.name,
            repoName: names.get(entry.name) ?? entry.name,
            repoPath: join(reposDir, entry.name),
          });
        }
        return entries;
      },
      readIncludedRepoIds: async (): Promise<string[] | undefined> => {
        const list = readWorktreeList(
          await files.readRecord(join(record.base, 'worktrees.json')),
        );
        if (list.authority !== 'ok') return undefined;
        const included = list.worktrees.find(
          (row) => row.id === worktreeId,
        )?.includedRepoIds;
        return Array.isArray(included) &&
          included.every((id) => typeof id === 'string')
          ? included
          : undefined;
      },
      stat: (path) => files.stat(path),
      lstat: (path) => files.lstat(path),
      readText: (path) => files.readText(path),
      confirmWorkTree: (path) =>
        git.read({ kind: 'inside-work-tree' }, path, invocation),
      now,
    };
  }

  const worktreeHealth: WorkerGitWorktreeHealthHost<RecordedGitWorktree> = {
    authorityId,
    resolveWorktree: async ({ scope }) => {
      const record = await readWorkspace(scope);
      if (record.type === 'cowork') throw unresolved();
      // The check reports a missing worktree; it needs no list row.
      return {
        record,
        worktreeId: scope.worktreeId,
        worktreePath: join(record.base, 'worktrees', scope.worktreeId),
      };
    },
    sources: (worktree, context) =>
      healthSources(worktree, invocationOf(context)),
  };

  const mode = getGitExecutableDetectionMode(options.os, options.arch);
  function sourceOf(
    facts: Extract<GitExecutableSelectionFacts, { ready: true }>,
  ): WorkerGitExecutableSource {
    switch (facts.origin) {
      case 'saved':
        return mode === 'linux' ? 'user-selected' : 'cache';
      case 'override':
        return mode === 'linux' ? 'user-selected' : 'auto-detected';
      case 'discovery-cache':
        return 'cache';
      case 'login-path':
        return 'login-path';
      case 'system':
        return 'system';
      case 'discovered':
        return 'auto-detected';
      case 'unvalidated':
        return facts.override ? 'cache' : 'not-found';
    }
  }

  function issueOf(
    facts: Extract<GitExecutableSelectionFacts, { ready: false }>,
  ): WorkerGitExecutableIssue {
    if (facts.explicit) return 'selected-unusable';
    return facts.code === 'selection_rejected'
      ? 'candidate-unusable'
      : 'not-found';
  }

  const executable: WorkerGitExecutableHost = {
    authorityId,
    detect: async ({ recheck }, { signal }) => {
      const facts = await git.selectExecutable({ recheck, signal });
      const requirement = getGitExecutableRequirement(options.os, options.arch);
      const status = {
        ...requirement,
        wingetAvailable:
          options.os === 'win32' && (facts.wingetAvailable ?? false),
        checkedAt: now().toISOString(),
      };
      if (facts.ready) {
        const observation: WorkerGitExecutableObservation = {
          status: {
            ...status,
            ready: true,
            version: facts.version,
            source: sourceOf(facts),
          },
          issue: null,
        };
        return observation;
      }
      if (
        facts.code !== 'git_unavailable' &&
        facts.code !== 'selection_rejected'
      )
        throw new GitRepositoryReadError(facts.code);
      return {
        status: { ...status, ready: false, version: null, source: 'not-found' },
        issue: issueOf(facts),
      };
    },
  };

  const diff: WorkerGitDiffHost<string> = {
    authorityId,
    // desktop `resolveDiffRepository`, over the records: the worktree must be
    // listed, and a member is a directory under its `repos/`.
    resolveRepository: async ({ scope, repoId }) => {
      if (scope.worktreeId === undefined)
        throw invalid('The worktree id is invalid.');
      const record = await readWorkspace(scope);
      const home = await readWorktree(record, scope.worktreeId);
      if (repoId === WORKSPACE_ROOT_REPO_ID) return home;
      if (record.type !== 'multi-repo' || !safeId(repoId)) return null;
      const path = join(home, 'repos', repoId);
      const entry = await files.lstat(path).catch(() => null);
      return entry?.isDirectory() === true ? path : null;
    },
    // `diff.get` does not accept `_execution`, so the environment is the
    // daemon's own (recorded debt, CAN-4729).
    reads: (path, context) => {
      const invocation = invocationOf(context);
      return {
        read: (read) => git.read(read, path, invocation),
        estimateUntracked: (paths) =>
          estimateGitUntrackedChanges(path, paths, { confined: true }),
      };
    },
  };

  const mergeWrite: WorkerGitMergeHost<RecordedGitRepository> = {
    authorityId,
    resolveCheckout: (scope, context) =>
      branchWrite.resolveCheckout(scope, context),
    port: (checkout, context) => {
      const invocation = invocationOf(context);
      const commands = (cwd: string): ReturnType<typeof writeCommands> =>
        writeCommands(cwd, invocation);
      return {
        currentBranch: async () =>
          (
            await commands(checkout.path).succeeded({ kind: 'current-branch' })
          ).trim(),
        repositoryRoot: async () => {
          const root = await interruptibleListing(invocation.signal, () =>
            recordedRoot(checkout.path, checkout.recorded, invocation),
          );
          if (root === null) throw unresolved();
          return root;
        },
        localBranchExists: (root, branch) =>
          commands(root).probe({ kind: 'local-branch', branch }),
        baseWorktree: async (root, branch) => {
          const output = await commands(root).succeeded({
            kind: 'merge-worktree-list',
          });
          return (
            parseGitWorktreeListPorcelain(output).find(
              (entry) => entry.branchName === branch,
            )?.worktreePath ?? null
          );
        },
        temporaryWorktree: () => join(tmpdir(), `git-merge-${randomUUID()}`),
        addWorktree: (root, path, branch) =>
          commands(root).unlessCancelled({
            kind: 'merge-worktree-add',
            path,
            branch,
          }),
        isDirty: async (path) =>
          (await commands(path).succeeded({ kind: 'status' })).trim().length >
          0,
        merge: (path, branch) =>
          commands(path).unlessCancelled({ kind: 'merge-local', branch }),
        hasUnmergedPaths: async (path) =>
          (await commands(path).succeeded({ kind: 'porcelain-status' }))
            .split('\n')
            .some((line) => /^(U[UADM]|[ADM]U|DD|AA)/.test(line)),
        // Cleanup must run after cancellation, too.
        abort: async (path) => {
          await commands(path).succeeded({ kind: 'merge-abort' });
        },
        head: async (path) =>
          (await commands(path).succeeded({ kind: 'merge-head' })).trim(),
        removeWorktree: async (root, path) => {
          await commands(root).succeeded({
            kind: 'merge-worktree-remove',
            path,
          });
        },
      };
    },
  };

  const syncWrite = createRecordedWorkerGitSyncHost({
    authorityId,
    resolveCheckout: (scope, context) =>
      branchWrite.resolveCheckout(scope, context),
    writes,
    stat: (absolutePath) => files.stat(absolutePath),
  });

  return {
    branchList,
    branchWrite,
    worktreeWrite,
    syncWrite,
    commitPush: createRecordedWorkerGitCommitPushHost({
      authorityId,
      writes,
      resolveCheckout: (scope, context) =>
        branchWrite.resolveCheckout(scope, context),
    }),
    mergeWrite,
    remote,
    worktreeHealth,
    executable,
    diff,
  };
}
