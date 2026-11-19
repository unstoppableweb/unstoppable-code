import { GIT_AUTHENTICATION_FAILURE_PATTERNS } from '../../lib/git-error-classification';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  writeFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { SharedContainerAccessBlockReason } from '@canopy/desktop-shared/types';
import type {
  SharedContainerRevisionLayout,
  SharedContainerRevisionLayoutV2,
  SharedContainerRevisionSnapshotRepository,
  AnySharedContainerRevisionLayout,
} from '@canopy/protocol/shared-containers';
import {
  MAX_SHARED_CONTAINER_MATERIALIZED_BYTES,
  MAX_SHARED_CONTAINER_MATERIALIZED_FILES,
  MAX_SHARED_CONTAINER_REPOSITORIES,
} from '@canopy/protocol/shared-containers';
import {
  cloneRepoAtCommit,
  classifySharedContainerSymlinkTarget,
  decodeUtf8SymlinkTarget,
  fetchRemoteCommit,
  getRemoteUrl,
  initializeRepoFromSnapshotBundle,
  materializeGitCommitRaw,
  RawGitTreeSymlinkUnsupportedError,
  warmCommitRangeDiffObjects,
} from '../../lib/git';
import {
  getGitHubBrokerCredentialPort,
  type GitHubBrokerCredentialLease,
} from '../../lib/github-broker/credential-port';
import { getGitHubClient } from '../../lib/github-client';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { sanitizeRemoteUrl } from '../../lib/plan-share-repos';
import {
  reserveMaterializedPath,
  resolveMaterializedPath,
} from './path-safety';
import {
  makeReplicaTreeReadOnly,
  makeReplicaTreeWritable,
} from '../replica/store';
import type { SharedContainerProjectionUsage } from './projection-budget';
import { fileContainsLfsAttributes } from '../git-lfs';

/**
 * Alias of the IPC-visible union so a new access state cannot be added here
 * without also reaching `SharedContainerReplicaState` and the preload guard.
 */
export type SharedContainerCodeBlockReason = SharedContainerAccessBlockReason;

function isSnapshotRepository(
  repository:
    | SharedContainerRevisionLayout['repositories'][number]
    | SharedContainerRevisionLayoutV2['repositories'][number],
): repository is SharedContainerRevisionSnapshotRepository {
  return 'source' in repository && repository.source === 'snapshot';
}

export type MaterializeCodeResult =
  | { ok: true }
  | {
      ok: false;
      block: {
        reason: SharedContainerCodeBlockReason;
        message: string;
        repository: string;
      };
    };

export interface MaterializeCodeRevisionOptions {
  layout: AnySharedContainerRevisionLayout;
  artifactsDir: string;
  reposDir: string;
  /**
   * Where the per-repository "committed range is readable offline" markers are
   * written (CAN-2551).
   *
   * A marker is written only after both halves of {@link
   * MaterializeCodeDependencies.prepareCommittedRange} succeed. The reader
   * gates the committed group on it, because the merge-base commit being
   * present locally does not imply its blobs are: the fetch and the warm are
   * separate steps, and once the tree is sealed read-only git can no longer
   * fetch the missing blobs at read time — it would render an empty, unchanged
   * diff instead of the error state.
   */
  committedRangesDir: string;
  /**
   * Called once per repository, immediately before this materializer first
   * writes into that repository's directory (CAN-2551).
   *
   * A revision bump may hand this function a checkout borrowed from the
   * previous revision. Everything below rewrites such a checkout in place —
   * a discarding `rm` on a remote mismatch, a clone, a fetch, then
   * `materializeGitCommitRaw` wiping the working tree — so once this fires the
   * borrowed tree holds the new revision's content and can no longer be handed
   * back. The caller uses it to choose between restoring the previous revision
   * and invalidating it, so it must fire *before* the first write, not after.
   */
  onRepositoryMutating?: (repoId: string) => void;
  artifactPathsById: ReadonlyMap<string, string>;
  artifactSizesById?: ReadonlyMap<string, bigint>;
  initialProjectionUsage?: Readonly<SharedContainerProjectionUsage>;
  assertStorageAvailable?: () => Promise<void>;
  signal?: AbortSignal;
}

export const SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS = 5 * 60_000;

interface SharedContainerGitOperationOptions {
  commitSha?: string;
  signal?: AbortSignal;
  skipLfsSmudge?: boolean;
  timeoutMs?: number;
}

export interface MaterializeCodeDependencies {
  /** A lease on the resolved GitHub credential; null when there is none. */
  resolveGitHubCredential(): Promise<GitHubBrokerCredentialLease | null>;
  probeRepository(
    owner: string,
    repository: string,
    credential: GitHubBrokerCredentialLease,
    signal?: AbortSignal,
  ): Promise<void>;
  probeCommit(
    owner: string,
    repository: string,
    sha: string,
    credential: GitHubBrokerCredentialLease,
    signal?: AbortSignal,
  ): Promise<string>;
  inspectRepositoryTree(
    owner: string,
    repository: string,
    treeSha: string,
    credential: GitHubBrokerCredentialLease,
    signal?: AbortSignal,
  ): Promise<{
    fileCount: number;
    totalBytes: bigint;
    containsSymlinks?: boolean;
  }>;
  cloneRepo(
    remoteUrl: string,
    destination: string,
    options?: SharedContainerGitOperationOptions,
  ): Promise<void>;
  fetchOrigin(
    repoPath: string,
    signal?: AbortSignal,
    options?: { commitSha?: string; timeoutMs?: number },
  ): Promise<void>;
  materializeRawCommit(
    repoPath: string,
    sha: string,
    options: {
      allowPromisorFetch?: boolean;
      maxFiles?: number;
      maxBytes?: bigint;
      rejectSymlinks?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<{ fileCount: number; totalBytes: bigint }>;
  prepareSnapshot?(
    bundlePath: string,
    destination: string,
    commitSha: string,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void>;
  /**
   * Make the publisher's committed history readable offline (CAN-2551).
   *
   * Fetches only the merge-base commit — still `--filter=blob:none`, still
   * depth one — then walks the two-commit diff so the blobs those changed paths
   * need land before the replica tree is sealed read-only. Nothing outside the
   * branch's own diff is fetched, so the bounded-clone guarantee holds.
   */
  prepareCommittedRange(
    repoPath: string,
    mergeBaseSha: string,
    baseCommitSha: string,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<void>;
  /**
   * Configured `origin` of an existing checkout, or `null` when there is none
   * and when reading it fails.
   *
   * A reused checkout is matched into staging by repository id alone, which is
   * a manifest-controlled string. This is the second half of that match: the
   * checkout must also point at the repository the manifest names, or the
   * incremental fetch below would pull `origin` from whatever repository the
   * previous revision happened to reference (CAN-2551).
   */
  readOriginUrl(repoPath: string): Promise<string | null>;
}

const defaultDependencies: MaterializeCodeDependencies = {
  resolveGitHubCredential: async () =>
    (await getGitHubBrokerCredentialPort().lease('resolved'))?.lease ?? null,
  probeRepository: async (owner, repository, credential, signal) => {
    await getGitHubClient().enqueue(
      (octokit) =>
        octokit.request('GET /repos/{owner}/{repo}', {
          owner,
          repo: repository,
        }),
      'high',
      { credential, ...(signal ? { signal } : {}) },
    );
  },
  probeCommit: async (owner, repository, sha, credential, signal) => {
    const response = await getGitHubClient().enqueue(
      (octokit) =>
        octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
          owner,
          repo: repository,
          ref: sha,
        }),
      'high',
      { credential, ...(signal ? { signal } : {}) },
    );
    return response.data.commit.tree.sha;
  },
  inspectRepositoryTree: async (
    owner,
    repository,
    treeSha,
    credential,
    signal,
  ) => {
    const response = await getGitHubClient().enqueue(
      (octokit) =>
        octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
          owner,
          repo: repository,
          tree_sha: treeSha,
          recursive: '1',
        }),
      'high',
      { credential, ...(signal ? { signal } : {}) },
    );
    if (response.data.truncated) {
      throw new Error(
        'Shared-container repository tree is too large to inspect',
      );
    }
    let fileCount = 0;
    let totalBytes = BigInt(0);
    let containsSymlinks = false;
    for (const entry of response.data.tree) {
      if (entry.type !== 'blob') continue;
      if (entry.mode === '120000') containsSymlinks = true;
      if (!Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0) {
        throw new Error(
          'Shared-container repository tree has an invalid blob size',
        );
      }
      fileCount += 1;
      totalBytes += BigInt(entry.size ?? 0);
    }
    return { fileCount, totalBytes, containsSymlinks };
  },
  cloneRepo: async (remoteUrl, destination, options) => {
    if (!options?.commitSha) {
      throw new Error('Shared-container clone requires a commit SHA');
    }
    await cloneRepoAtCommit(remoteUrl, destination, options.commitSha, {
      nonInteractive: true,
      skipLfsSmudge: options?.skipLfsSmudge,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  },
  prepareCommittedRange: async (
    repoPath,
    mergeBaseSha,
    baseCommitSha,
    options,
  ) => {
    await fetchRemoteCommit(repoPath, mergeBaseSha, {
      signal: options.signal,
      nonInteractive: true,
      timeoutMs: options.timeoutMs,
      skipLfsSmudge: true,
    });
    await warmCommitRangeDiffObjects(repoPath, mergeBaseSha, baseCommitSha, {
      signal: options.signal,
      nonInteractive: true,
      timeoutMs: options.timeoutMs,
      skipLfsSmudge: true,
    });
  },
  readOriginUrl: (repoPath) => getRemoteUrl(repoPath),
  fetchOrigin: async (repoPath, signal, options) => {
    if (!options?.commitSha) {
      throw new Error('Shared-container fetch requires a commit SHA');
    }
    await fetchRemoteCommit(repoPath, options.commitSha, {
      signal,
      nonInteractive: true,
      timeoutMs: options?.timeoutMs,
      skipLfsSmudge: true,
    });
  },
  materializeRawCommit: async (repoPath, sha, options) => {
    const seen = new Set<string>();
    return materializeGitCommitRaw(repoPath, sha, {
      ...options,
      resolveDestination: (relativePath) =>
        resolveMaterializedPath(
          repoPath,
          reserveMaterializedPath(seen, relativePath),
        ),
    });
  },
  prepareSnapshot: (bundlePath, destination, commitSha, options) =>
    initializeRepoFromSnapshotBundle(
      bundlePath,
      destination,
      commitSha,
      options,
    ),
};

function gitFailureOutput(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const record = error as Record<string, unknown>;
  return [record.message, record.stderr, record.stdout]
    .filter((value) => typeof value === 'string' || Buffer.isBuffer(value))
    .map(String)
    .join('\n');
}

function isGitAuthenticationFailure(error: unknown): boolean {
  const output = gitFailureOutput(error);
  return GIT_AUTHENTICATION_FAILURE_PATTERNS.some((pattern) =>
    pattern.test(output),
  );
}

export function parseGitHubRemote(
  remoteUrl: string,
): { owner: string; repository: string } | null {
  const scp =
    /^(?:[^@\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(
      remoteUrl,
    );
  if (scp) return { owner: scp[1], repository: scp[2] };
  try {
    const url = new URL(remoteUrl);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const segments = url.pathname.replace(/^\//, '').split('/');
    if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
    return {
      owner: segments[0],
      repository: segments[1].replace(/\.git$/i, ''),
    };
  } catch {
    return null;
  }
}

/**
 * Whether an existing checkout points at the repository the manifest names.
 *
 * Compared on parsed GitHub coordinates rather than raw URL text so an `https`
 * checkout and an `scp`-style manifest remote for the same repository still
 * match. Anything that cannot be read or parsed answers `false`: the caller's
 * fallback is a fresh clone, which is always correct and only ever slower.
 */
async function checkoutMatchesRemote(
  repoDir: string,
  expected: { owner: string; repository: string } | null,
  dependencies: MaterializeCodeDependencies,
): Promise<boolean> {
  if (!expected) return false;
  let configured: string | null;
  try {
    configured = await dependencies.readOriginUrl(repoDir);
  } catch {
    return false;
  }
  if (!configured) return false;
  const sanitizedConfigured = sanitizeRemoteUrl(configured);
  const actual = sanitizedConfigured
    ? parseGitHubRemote(sanitizedConfigured)
    : null;
  if (!actual) return false;
  return (
    actual.owner.toLowerCase() === expected.owner.toLowerCase() &&
    actual.repository.toLowerCase() === expected.repository.toLowerCase()
  );
}

function statusOf(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'status' in error
    ? (error as { status?: number }).status
    : undefined;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

async function containsLfsAttributes(root: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await containsLfsAttributes(entryPath)) return true;
    } else if (entry.isFile() && entry.name === '.gitattributes') {
      if (await fileContainsLfsAttributes(entryPath)) return true;
    }
  }
  return false;
}

function blocked(
  reason: SharedContainerCodeBlockReason,
  repository: string,
  detail: string,
): MaterializeCodeResult {
  return {
    ok: false,
    block: { reason, repository, message: `${repository}: ${detail}` },
  };
}

function assertRepositoryOverlayPath(relative: string): void {
  if (relative.split('/').some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error(
      `Shared-container repository overlay targets reserved Git metadata: ${relative}`,
    );
  }
}

async function resolveVerifiedOverlayDestination(
  root: string,
  relativePath: string,
): Promise<string> {
  const canonicalRoot = await realpath(root);
  const segments = relativePath.split('/');
  let parent = canonicalRoot;
  for (const segment of segments.slice(0, -1)) {
    const candidate = join(parent, segment);
    try {
      const info = await lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(
          `Shared-container overlay parent is not a real directory or is a symbolic link: ${relativePath}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(candidate);
    }
    const canonical = await realpath(candidate);
    const contained = relative(canonicalRoot, canonical);
    if (
      contained === '..' ||
      contained.startsWith(`..${sep}`) ||
      contained.startsWith(sep)
    ) {
      throw new Error(
        `Shared-container overlay escaped its repository: ${relativePath}`,
      );
    }
    parent = canonical;
  }
  return join(parent, basename(relativePath));
}

async function removeEmptyDirectoryTree(
  root: string,
  relativePath: string,
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(
        `Shared-container overlay cannot replace a non-empty directory: ${relativePath}`,
      );
    }
    await removeEmptyDirectoryTree(join(root, entry.name), relativePath);
  }
  await rmdir(root);
}

interface ProjectionUsage {
  files: number;
  bytes: bigint;
}

function assertProjectionUsageWithinLimits(usage: ProjectionUsage): void {
  if (usage.files > MAX_SHARED_CONTAINER_MATERIALIZED_FILES) {
    throw new Error('Shared-container projection file limit exceeded');
  }
  if (usage.bytes > BigInt(MAX_SHARED_CONTAINER_MATERIALIZED_BYTES)) {
    throw new Error('Shared-container projection byte limit exceeded');
  }
}

async function measureSnapshotWorkingTree(
  root: string,
): Promise<ProjectionUsage> {
  const usage: ProjectionUsage = { files: 0, bytes: BigInt(0) };
  const visit = async (
    directory: string,
    repositoryRoot: boolean,
  ): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (repositoryRoot && entry.name === '.git') continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await visit(path, false);
        continue;
      }
      if (!info.isFile() && !info.isSymbolicLink()) {
        throw new Error('Snapshot working tree contains an unsupported entry');
      }
      usage.files += 1;
      usage.bytes += info.isSymbolicLink()
        ? BigInt((await readlink(path, { encoding: 'buffer' })).byteLength)
        : BigInt(info.size);
    }
  };
  await visit(root, true);
  return usage;
}

function validateCodeProjectionBudget(
  options: MaterializeCodeRevisionOptions,
): ProjectionUsage {
  const usage: ProjectionUsage = { files: 0, bytes: BigInt(0) };
  if (!options.artifactSizesById) return usage;
  for (const repository of options.layout.repositories) {
    if ('source' in repository && repository.source === 'snapshot') {
      usage.files += repository.snapshot.treeFileCount;
      usage.bytes += BigInt(repository.snapshot.treeBytes);
      assertProjectionUsageWithinLimits(usage);
    }
    for (const file of repository.files) {
      if (file.status === 'deleted' || !file.artifactId) continue;
      const size = options.artifactSizesById.get(file.artifactId);
      if (size === undefined) {
        throw new Error(
          `Shared-container projection references missing artifact: ${file.artifactId}`,
        );
      }
      usage.files += 1;
      usage.bytes += size;
      assertProjectionUsageWithinLimits(usage);
    }
  }
  return usage;
}

export async function materializeCodeRevision(
  options: MaterializeCodeRevisionOptions,
  dependencies: MaterializeCodeDependencies = defaultDependencies,
): Promise<MaterializeCodeResult> {
  const projectionUsage = options.initialProjectionUsage
    ? { ...options.initialProjectionUsage }
    : validateCodeProjectionBudget(options);
  assertProjectionUsageWithinLimits(projectionUsage);
  if (options.layout.containerType !== 'CODE_WORKTREE') {
    throw new Error('Code materializer received a Cowork layout');
  }
  if (options.layout.repositories.length > MAX_SHARED_CONTAINER_REPOSITORIES) {
    throw new Error('Shared-container repository limit exceeded');
  }
  const disclosedRepositoryIds = new Set(
    options.layout.repositories.map((repository) =>
      repository.repoId.normalize('NFC'),
    ),
  );
  const referencedArtifactIds = new Set(
    options.layout.repositories.flatMap((repository) => [
      ...repository.files.flatMap((file) =>
        file.status !== 'deleted' && file.artifactId ? [file.artifactId] : [],
      ),
      ...('source' in repository && repository.source === 'snapshot'
        ? repository.snapshot.bundleArtifactIds
        : []),
    ]),
  );
  for (const artifactPath of Array.from(options.artifactPathsById.values())) {
    const match = /^repos\/([^/]+)\/(?:files|snapshot)\/[a-f0-9]{64}$/.exec(
      artifactPath,
    );
    if (match && !disclosedRepositoryIds.has(match[1].normalize('NFC'))) {
      throw new Error(
        `Shared-container repository artifact has no repository coordinates: ${artifactPath}`,
      );
    }
  }
  for (const [artifactId, artifactPath] of Array.from(
    options.artifactPathsById.entries(),
  )) {
    if (
      artifactPath.startsWith('repos/') &&
      !referencedArtifactIds.has(artifactId)
    ) {
      throw new Error(
        `Shared-container repository artifact is not declared by container.json: ${artifactPath}`,
      );
    }
  }
  const repositoryIds = new Set<string>();
  for (const repository of options.layout.repositories) {
    const isSnapshot = isSnapshotRepository(repository);
    const label = isSnapshot
      ? repository.repoName
      : `${repository.owner}/${repository.repository}`;
    if (
      process.platform === 'win32' &&
      repository.files.some((file) => file.mode === '120000')
    ) {
      return blocked(
        'symlink-unsupported',
        label,
        'symbolic links are not supported on Windows',
      );
    }
    const repoId = reserveMaterializedPath(repositoryIds, repository.repoId);
    const repoDir = resolveMaterializedPath(options.reposDir, repoId);
    // Past this line every branch writes into `repoDir`.
    options.onRepositoryMutating?.(repoId);
    if (isSnapshot) {
      const bundlePath = join(
        dirname(repoDir),
        `.snapshot-${repoId}-${randomUUID()}.bundle`,
      );
      try {
        if (await pathExists(repoDir)) {
          await makeReplicaTreeWritable(repoDir).catch(() => undefined);
          await rm(repoDir, { recursive: true, force: true });
        }
        await mkdir(dirname(repoDir), { recursive: true });
        const bundle = await open(
          bundlePath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        try {
          for (const artifactId of repository.snapshot.bundleArtifactIds) {
            const artifactPath = options.artifactPathsById.get(artifactId);
            if (
              !artifactPath ||
              !artifactPath.startsWith(`repos/${repoId}/snapshot/`)
            ) {
              throw new Error(
                `No verified snapshot artifact exists for ${repository.repoName}`,
              );
            }
            await bundle.writeFile(
              await readFile(
                resolveMaterializedPath(options.artifactsDir, artifactPath),
              ),
            );
          }
        } finally {
          await bundle.close();
        }
        const prepareSnapshot: NonNullable<
          MaterializeCodeDependencies['prepareSnapshot']
        > = (bundle, destination, commit, operationOptions): Promise<void> => {
          if (dependencies.prepareSnapshot) {
            return dependencies.prepareSnapshot(
              bundle,
              destination,
              commit,
              operationOptions,
            );
          }
          return initializeRepoFromSnapshotBundle(
            bundle,
            destination,
            commit,
            operationOptions,
          );
        };
        await prepareSnapshot(bundlePath, repoDir, repository.baseCommitSha, {
          signal: options.signal,
          timeoutMs: SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
        });
        let rawUsage: Awaited<
          ReturnType<MaterializeCodeDependencies['materializeRawCommit']>
        >;
        try {
          rawUsage = await dependencies.materializeRawCommit(
            repoDir,
            repository.baseCommitSha,
            {
              allowPromisorFetch: false,
              maxFiles: repository.snapshot.treeFileCount,
              maxBytes: BigInt(repository.snapshot.treeBytes),
              rejectSymlinks: process.platform === 'win32',
              signal: options.signal,
              timeoutMs: SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
            },
          );
        } catch (error) {
          if (error instanceof RawGitTreeSymlinkUnsupportedError) {
            await makeReplicaTreeWritable(repoDir).catch(() => undefined);
            await rm(repoDir, { recursive: true, force: true });
            return blocked(
              'symlink-unsupported',
              label,
              'symbolic links are not supported on Windows',
            );
          }
          throw error;
        }
        if (
          rawUsage.fileCount !== repository.snapshot.treeFileCount ||
          rawUsage.totalBytes !== BigInt(repository.snapshot.treeBytes)
        ) {
          throw new Error(
            'Snapshot Git tree does not match the authenticated manifest',
          );
        }
        await options.assertStorageAvailable?.();
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (await pathExists(repoDir)) {
          await makeReplicaTreeReadOnly(repoDir).catch(() => undefined);
        }
        throw error;
      } finally {
        await rm(bundlePath, { force: true });
      }
    } else {
      const sanitized = sanitizeRemoteUrl(repository.remoteUrl);
      const coordinates = sanitized ? parseGitHubRemote(sanitized) : null;
      if (!sanitized || !coordinates) {
        return blocked(
          'unsupported-remote-host',
          label,
          'only GitHub remotes are supported',
        );
      }
      const credential = await dependencies.resolveGitHubCredential();
      if (!credential) {
        return blocked(
          'github-not-connected',
          label,
          'connect GitHub to verify access',
        );
      }
      try {
        await dependencies.probeRepository(
          coordinates.owner,
          coordinates.repository,
          credential,
          options.signal,
        );
      } catch (error) {
        if (statusOf(error) === 403 || statusOf(error) === 404) {
          return blocked(
            'repository-access-missing',
            label,
            'repository access is missing',
          );
        }
        throw error;
      }
      let treeSha: string;
      try {
        treeSha = await dependencies.probeCommit(
          coordinates.owner,
          coordinates.repository,
          repository.baseCommitSha,
          credential,
          options.signal,
        );
      } catch (error) {
        if (statusOf(error) === 403 || statusOf(error) === 404) {
          return blocked(
            'commit-unavailable',
            label,
            `commit ${repository.baseCommitSha} is unavailable`,
          );
        }
        throw error;
      }
      const baseTree = await dependencies.inspectRepositoryTree(
        coordinates.owner,
        coordinates.repository,
        treeSha,
        credential,
        options.signal,
      );
      if (process.platform === 'win32' && baseTree.containsSymlinks) {
        return blocked(
          'symlink-unsupported',
          label,
          'symbolic links are not supported on Windows',
        );
      }
      try {
        const hasCheckout = await pathExists(join(repoDir, '.git'));
        const reusable =
          hasCheckout &&
          (await checkoutMatchesRemote(repoDir, coordinates, dependencies));
        if (hasCheckout && !reusable) {
          await makeReplicaTreeWritable(repoDir).catch(() => undefined);
          await rm(repoDir, { recursive: true, force: true });
        }
        if (!reusable) {
          await mkdir(dirname(repoDir), { recursive: true });
          await dependencies.cloneRepo(sanitized, repoDir, {
            commitSha: repository.baseCommitSha,
            signal: options.signal,
            skipLfsSmudge: true,
            timeoutMs: SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
          });
        } else {
          await makeReplicaTreeWritable(repoDir);
          await dependencies.fetchOrigin(repoDir, options.signal, {
            commitSha: repository.baseCommitSha,
            timeoutMs: SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
          });
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (await pathExists(repoDir)) {
          await makeReplicaTreeReadOnly(repoDir).catch(() => undefined);
        }
        if (!isGitAuthenticationFailure(error)) throw error;
        return blocked(
          'git-credentials-missing',
          label,
          'ambient git credentials could not fetch the repository',
        );
      }
      await options.assertStorageAvailable?.();
      if (options.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const rawUsage = await dependencies.materializeRawCommit(
        repoDir,
        repository.baseCommitSha,
        {
          signal: options.signal,
          timeoutMs: SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
        },
      );
      if (
        rawUsage.fileCount !== baseTree.fileCount ||
        rawUsage.totalBytes !== baseTree.totalBytes
      ) {
        throw new Error(
          'Raw Git tree does not match the authenticated repository tree',
        );
      }
      await options.assertStorageAvailable?.();
      if (
        repository.mergeBaseSha &&
        repository.mergeBaseSha !== repository.baseCommitSha
      ) {
        let committedRangeReady = false;
        try {
          await dependencies.prepareCommittedRange(
            repoDir,
            repository.mergeBaseSha,
            repository.baseCommitSha,
            {
              signal: options.signal,
              timeoutMs: SHARED_CONTAINER_GIT_OPERATION_TIMEOUT_MS,
            },
          );
          committedRangeReady = true;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          logMainProcessWarn(
            '[shared-containers] committed range unavailable for a shared repository',
            error,
          );
        }
        if (committedRangeReady) {
          await options.assertStorageAvailable?.();
          await mkdir(options.committedRangesDir, { recursive: true });
          await writeFile(
            resolveMaterializedPath(options.committedRangesDir, repoId),
            repository.mergeBaseSha,
            'utf8',
          );
          await options.assertStorageAvailable?.();
        }
      }
    }
    try {
      if (await containsLfsAttributes(repoDir)) {
        return blocked(
          'lfs-unsupported',
          label,
          'Git LFS repositories are not supported',
        );
      }
      const seen = new Set<string>();
      const files = repository.files
        .map((file) => {
          const relative = reserveMaterializedPath(seen, file.path);
          // The authenticated layout is publisher-controlled. Never allow it
          // to mutate checkout metadata, including case variants on macOS/Windows.
          assertRepositoryOverlayPath(relative);
          return { file, relative };
        })
        // Git emits descendant deletions before an untracked parent symlink,
        // but the authenticated layout is not trusted to preserve that order.
        .sort(
          (left, right) =>
            Number(left.file.status !== 'deleted') -
            Number(right.file.status !== 'deleted'),
        );
      for (const { file, relative } of files) {
        const destination = await resolveVerifiedOverlayDestination(
          repoDir,
          relative,
        );
        if (file.status === 'deleted') {
          await rm(destination, { force: true });
          continue;
        }
        if (!file.artifactId) {
          throw new Error(`No artifact id exists for ${file.path}`);
        }
        const artifactPath = options.artifactPathsById.get(file.artifactId);
        if (
          !artifactPath ||
          !artifactPath.startsWith(`repos/${repoId}/files/`)
        ) {
          throw new Error(`No verified artifact exists for ${file.path}`);
        }
        const source = resolveMaterializedPath(
          options.artifactsDir,
          artifactPath,
        );
        const bytes = await readFile(source);
        const temporary = join(
          dirname(destination),
          `.overlay-${randomUUID()}.tmp`,
        );
        try {
          if (file.mode === '120000') {
            const target = decodeUtf8SymlinkTarget(
              bytes,
              `Invalid symbolic link target for ${file.path}`,
            );
            if (
              classifySharedContainerSymlinkTarget(relative, target) !==
              'in-repository'
            ) {
              throw new Error(`Invalid symbolic link target for ${file.path}`);
            }
            await symlink(target, temporary);
            try {
              const current = await lstat(destination);
              if (current.isDirectory() && !current.isSymbolicLink()) {
                await removeEmptyDirectoryTree(destination, relative);
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
            }
            await rename(temporary, destination);
            continue;
          }
          const outputMode =
            file.mode === '100755'
              ? 0o500
              : file.mode === '100644'
                ? 0o400
                : null;
          if (outputMode === null) {
            throw new Error(`Unsupported Git file mode ${file.mode}`);
          }
          const handle = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            outputMode,
          );
          try {
            await handle.writeFile(bytes);
          } finally {
            await handle.close();
          }
          await chmod(temporary, outputMode);
          // Rename replaces the leaf itself, so a symlink from the base commit
          // becomes the approved regular file without ever being followed.
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      if (isSnapshot) {
        const finalUsage = await measureSnapshotWorkingTree(repoDir);
        const declaredFileCount =
          repository.snapshot.treeFileCount +
          repository.files.reduce(
            (delta, file) =>
              delta +
              (file.status === 'added'
                ? 1
                : file.status === 'deleted'
                  ? -1
                  : 0),
            0,
          );
        projectionUsage.files += finalUsage.files - declaredFileCount;
        projectionUsage.bytes +=
          finalUsage.bytes - BigInt(repository.snapshot.treeBytes);
        assertProjectionUsageWithinLimits(projectionUsage);
      }
      await options.assertStorageAvailable?.();
    } finally {
      await makeReplicaTreeReadOnly(repoDir);
    }
  }
  return { ok: true };
}
