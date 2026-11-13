import {
  assertNoDestructiveRecovery,
  hasDestructiveLifecycle,
  refuseInterruptedArchiveJournal,
  assertNoLegacyArchiveRecovery,
  readWorkspaceDestructiveRecoveries,
} from './w5-destructive-recovery';
import { execFile } from 'node:child_process';
import { assertArchiveWorktreeRemoval } from './archive-worktree-postconditions';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ARCHIVED_CONTAINER_CHANGES_DEFAULT_PAGE_SIZE,
  ARCHIVED_CONTAINER_CHANGES_MAX_EXPLORABLE_RECORDS,
  ARCHIVED_CONTAINER_CHANGES_MAX_PAGE_SIZE,
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  type ArchivedContainerListChangesRequest,
  type ArchivedContainerListChangesResponse,
  type ArchivedContainerManifestV2,
  type ArchivedContainerReadChangeDiffRequest,
  type ArchivedContainerReadChangeDiffResponse,
  type ArchivedGitChangesSummary,
  type ArchivedGitRepositoryState,
  type ArchivedGitState,
  type ArchivedPullRequestCapture,
  type ArchivedPullRequestMetadata,
  type ArchivedPullRequestRepositoryCapture,
  type ChangedFileInfo,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import { mapWithConcurrency } from './concurrency';
import {
  assertGitObject,
  archiveGitEnv,
  assertWorktreeSnapshotSupported,
  captureHeadCommitSha,
  captureIndexTreeSha,
  captureWorkingTreeSha,
  ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE,
  restoreIndexAndWorkingTreeSnapshot,
  streamArchiveTreeDiff,
  setGitTreeSnapshotRuntime,
} from './git-tree-snapshot';
import {
  getFileDiffBetweenTreesWithPaths,
  getGitCommonDir,
  removeWindowsWorktreeReparsePoints,
} from './git';
import { fetchArchivedPullRequestMetadata } from './github-pr';
import {
  getArchivedContainerManifestPath,
  getArchivedContainerGitStateStagedPath,
  getArchivedContainerWorkspaceRootDir,
  getArchivedContainersRootDir,
  getWorkspaceWorktreeDir,
} from './paths';
import { resolveProjectReferenceRepoPath } from './project-reference-repo';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';
import { resolveEffectiveBaseBranchForRepo } from './worktree-base-branches';
import { readWorkspaceConfig } from './workspace-persistence';
import { readEffectiveWorkspaceConfig } from './workspace-source';
import { isErrnoException, isRecord } from './type-guards';
import { validateId } from './validation';
import { isPathInside } from './path-safety';
import { captureArchivedWorkspaceRootPayload } from './archived-workspace-root-payload';
import type { ArchivedQuarantineIdentity } from './archive-quarantine';
export { renameArchiveQuarantine } from './archive-quarantine';
import {
  assertGitMetadataSelfContained,
  classifyUnmanagedWorktreeRepository,
  listUnmanagedWorktreeRepositories,
} from './unmanaged-worktree-repository';
import { runArchiveIoRequest } from '../archive/archive-io-runner';
import { removeTreeWithoutAsar } from './remove-tree-without-asar';
import { removeAbsentWorktreeRegistrations } from './worktree-registration-removal';
import {
  ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE,
  type ArchiveIoOperationRequest,
} from '../archive/archive-io-protocol';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const GIT_OBJECT_ID_RE = /^[0-9a-f]{40,64}$/;
const ARCHIVE_REF_NAMESPACE = 'refs/app/archived-containers';
const CAPTURE_CONCURRENCY = 2;
const PULL_REQUEST_CAPTURE_TIMEOUT_MS = 5_000;
const ARCHIVE_CACHE_MAX_ENTRIES = 4;
const ARCHIVE_CACHE_MAX_RECORDS = 100_000;
setGitTreeSnapshotRuntime({
  resolveExecutable: () => getResolvedGitExecutableForSpawn(process.env),
  environment: () => process.env,
});

type ArchiveIoExecutor = typeof runArchiveIoRequest;
let archiveIoExecutor: ArchiveIoExecutor = runArchiveIoRequest;

export function setArchivedContainerGitIoExecutorForTests(
  executor?: ArchiveIoExecutor,
): void {
  archiveIoExecutor = executor ?? runArchiveIoRequest;
}

interface ArchivedGitTeardownJournal {
  phase: 'quarantine-pending' | 'verified';
  canonicalPath: string;
  quarantinePath: string;
  enteredAt: string;
  quarantineIdentity?: ArchivedQuarantineIdentity;
  branchDeletionTargets?: ArchivedContainerBranchDeletion[];
  pendingBranchDeletions?: ArchivedContainerBranchDeletion[];
  branchDeletionMode?: ArchivedContainerBranchDeletionMode;
  preserveBranches?: true;
  workspaceRootPayload?: {
    digest: string;
    standaloneRepoIds: string[];
  };
}

function quarantineIdentity(stats: Stats): ArchivedQuarantineIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  };
}

function quarantineIdentityMatches(
  stats: Stats,
  identity: ArchivedQuarantineIdentity,
): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.dev === identity.dev &&
    stats.ino === identity.ino &&
    stats.birthtimeMs === identity.birthtimeMs
  );
}

export type ArchivedContainerBranchDeletionMode = 'force' | 'merged-only';

export interface ArchivedContainerBranchDeletion {
  repoId: string;
  referenceRepoPath: string;
  repositoryIdentity: string;
  branchName: string;
  expectedTip: string;
}

export interface ArchivedGitCapturingStagedDescriptor {
  version: 1;
  status: 'capturing';
  repositories: ArchivedGitRepositoryState[];
  teardown?: ArchivedGitTeardownJournal;
}

export interface ArchivedGitReadyStagedDescriptor {
  version: 1;
  status: 'ready';
  repositories: ArchivedGitRepositoryState[];
  gitChanges: ArchivedGitChangesSummary;
  pullRequestMetadata: ArchivedPullRequestCapture;
  teardown?: ArchivedGitTeardownJournal;
}

export type ArchivedGitStagedDescriptor =
  | ArchivedGitCapturingStagedDescriptor
  | ArchivedGitReadyStagedDescriptor;

export class MissingWorktreeIncompleteArchivedGitCaptureError extends Error {
  constructor() {
    super('An incomplete archived Git capture requires recovery.');
    this.name = 'MissingWorktreeIncompleteArchivedGitCaptureError';
  }
}

export function isMissingWorktreeIncompleteArchivedGitCaptureError(
  error: unknown,
): error is MissingWorktreeIncompleteArchivedGitCaptureError {
  return error instanceof MissingWorktreeIncompleteArchivedGitCaptureError;
}

export class InterruptedArchivedGitTeardownRequiresRecoveryError extends Error {
  constructor() {
    super('An incomplete archived Git capture requires recovery.');
    this.name = 'InterruptedArchivedGitTeardownRequiresRecoveryError';
  }
}

export function isArchivedGitCaptureRecoveryRequiredError(
  error: unknown,
): error is
  | MissingWorktreeIncompleteArchivedGitCaptureError
  | InterruptedArchivedGitTeardownRequiresRecoveryError
  | (Error & { code: typeof ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE }) {
  return (
    isMissingWorktreeIncompleteArchivedGitCaptureError(error) ||
    error instanceof InterruptedArchivedGitTeardownRequiresRecoveryError ||
    (error instanceof Error &&
      'code' in error &&
      error.code === ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE)
  );
}

interface ArchivedRepositoryDefinition {
  repoId: string;
  repoName: string;
  relativePath: string;
  referenceRepoPath: string;
  worktreeRepoPath?: string;
}

export interface ArchivedContainerTeardownTarget {
  repoId: string;
  referenceRepoPath: string;
  quarantineRepoPath: string;
  /** Where the checkout was before the quarantine move. */
  preMoveRepoPath: string;
  branchName?: string;
  expectedBranchTip?: string;
}

export interface ArchivedContainerTeardownPlan {
  canonicalPath: string;
  quarantinePath: string;
  alreadyRemoved: boolean;
  targets: ArchivedContainerTeardownTarget[];
  pendingBranchDeletions?: ArchivedContainerBranchDeletion[];
  branchDeletionMode?: ArchivedContainerBranchDeletionMode;
}

async function runGit(
  repoPath: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await execFileAsync(
    await getResolvedGitExecutableForSpawn(),
    args,
    {
      cwd: repoPath,
      env: archiveGitEnv(),
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: process.platform === 'win32',
    },
  );
  return stdout.trim();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function writeJsonDurably(
  filePath: string,
  value: unknown,
): Promise<void> {
  const tempPath = join(dirname(filePath), `.git-state-${randomUUID()}.tmp`);
  await mkdir(dirname(filePath), { recursive: true });
  let handle;
  try {
    handle = await open(tempPath, 'wx');
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(filePath), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isGitRepositoryState(
  value: unknown,
): value is ArchivedGitRepositoryState {
  return (
    isRecord(value) &&
    typeof value.repoId === 'string' &&
    value.repoId.length > 0 &&
    typeof value.repoName === 'string' &&
    value.repoName.length > 0 &&
    typeof value.relativePath === 'string' &&
    typeof value.referenceRepoPath === 'string' &&
    isAbsolute(value.referenceRepoPath) &&
    (value.branchName === undefined ||
      (typeof value.branchName === 'string' && value.branchName.length > 0)) &&
    (value.comparisonBaseBranch === undefined ||
      (typeof value.comparisonBaseBranch === 'string' &&
        value.comparisonBaseBranch.length > 0)) &&
    (value.baseBranchCommit === undefined ||
      (typeof value.comparisonBaseBranch === 'string' &&
        typeof value.baseBranchCommit === 'string' &&
        GIT_OBJECT_ID_RE.test(value.baseBranchCommit))) &&
    GIT_OBJECT_ID_RE.test(String(value.comparisonBaseCommit)) &&
    GIT_OBJECT_ID_RE.test(String(value.headCommit)) &&
    GIT_OBJECT_ID_RE.test(String(value.indexSnapshotCommit)) &&
    GIT_OBJECT_ID_RE.test(String(value.worktreeSnapshotCommit)) &&
    typeof value.snapshotRef === 'string' &&
    value.snapshotRef.length > 0
  );
}

function isGitChanges(value: unknown): value is ArchivedGitChangesSummary {
  if (!isRecord(value) || !isIsoDate(value.capturedAt)) return false;
  if (value.status === 'unavailable') return true;
  return (
    value.status === 'complete' &&
    [value.fileCount, value.insertions, value.deletions].every(
      (count) => Number.isInteger(count) && Number(count) >= 0,
    ) &&
    Array.isArray(value.repositories) &&
    value.repositories.every(
      (repository) =>
        isRecord(repository) &&
        typeof repository.repoId === 'string' &&
        repository.repoId.length > 0 &&
        typeof repository.repoName === 'string' &&
        repository.repoName.length > 0 &&
        [
          repository.fileCount,
          repository.insertions,
          repository.deletions,
        ].every((count) => Number.isInteger(count) && Number(count) >= 0),
    )
  );
}

function isArchivedPullRequestMetadata(
  value: unknown,
): value is ArchivedPullRequestMetadata {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.number) ||
    Number(value.number) <= 0 ||
    typeof value.url !== 'string' ||
    typeof value.title !== 'string' ||
    value.title.trim().length === 0 ||
    (value.state !== 'open' &&
      value.state !== 'draft' &&
      value.state !== 'closed' &&
      value.state !== 'merged') ||
    (value.baseRefName !== undefined &&
      (typeof value.baseRefName !== 'string' ||
        value.baseRefName.trim().length === 0)) ||
    !isIsoDate(value.updatedAt)
  ) {
    return false;
  }
  try {
    const url = new URL(value.url);
    const path = /^\/[^/]+\/[^/]+\/pull\/([1-9][0-9]*)$/.exec(url.pathname);
    return (
      url.protocol === 'https:' &&
      url.host === 'github.com' &&
      url.username === '' &&
      url.password === '' &&
      path?.[1] === String(value.number)
    );
  } catch {
    return false;
  }
}

function isPullRequestRepositoryCapture(
  value: unknown,
): value is ArchivedPullRequestRepositoryCapture {
  if (
    !isRecord(value) ||
    typeof value.repoId !== 'string' ||
    value.repoId.length === 0 ||
    typeof value.repoName !== 'string' ||
    value.repoName.length === 0
  ) {
    return false;
  }
  if (value.status === 'unavailable') {
    return !Object.prototype.hasOwnProperty.call(value, 'pullRequest');
  }
  return (
    value.status === 'complete' &&
    Object.prototype.hasOwnProperty.call(value, 'pullRequest') &&
    (value.pullRequest === null ||
      isArchivedPullRequestMetadata(value.pullRequest))
  );
}

function isPullRequestCapture(
  value: unknown,
  repositories: ArchivedGitRepositoryState[],
): value is ArchivedPullRequestCapture {
  if (
    !isRecord(value) ||
    !isIsoDate(value.capturedAt) ||
    !Array.isArray(value.repositories) ||
    !value.repositories.every(isPullRequestRepositoryCapture)
  ) {
    return false;
  }
  const repositoriesById = new Map(
    repositories.map((repository) => [repository.repoId, repository]),
  );
  const capturedIds = value.repositories.map((repository) => repository.repoId);
  return (
    new Set(capturedIds).size === capturedIds.length &&
    capturedIds.length === repositories.length &&
    value.repositories.every(
      (repository) =>
        repositoriesById.get(repository.repoId)?.repoName ===
        repository.repoName,
    )
  );
}

function isTeardownJournal(
  value: unknown,
): value is ArchivedGitTeardownJournal {
  const isBranchDeletionList = (candidate: unknown): boolean =>
    candidate === undefined ||
    (Array.isArray(candidate) &&
      candidate.every(
        (deletion) =>
          isRecord(deletion) &&
          typeof deletion.repoId === 'string' &&
          deletion.repoId.length > 0 &&
          typeof deletion.referenceRepoPath === 'string' &&
          isAbsolute(deletion.referenceRepoPath) &&
          typeof deletion.repositoryIdentity === 'string' &&
          isAbsolute(deletion.repositoryIdentity) &&
          typeof deletion.branchName === 'string' &&
          deletion.branchName.length > 0 &&
          typeof deletion.expectedTip === 'string' &&
          GIT_OBJECT_ID_RE.test(deletion.expectedTip),
      ));
  return (
    isRecord(value) &&
    (value.phase === 'quarantine-pending' || value.phase === 'verified') &&
    typeof value.canonicalPath === 'string' &&
    typeof value.quarantinePath === 'string' &&
    isAbsolute(value.canonicalPath) &&
    isAbsolute(value.quarantinePath) &&
    isIsoDate(value.enteredAt) &&
    (value.quarantineIdentity === undefined ||
      (isRecord(value.quarantineIdentity) &&
        typeof value.quarantineIdentity.dev === 'number' &&
        typeof value.quarantineIdentity.ino === 'number' &&
        typeof value.quarantineIdentity.birthtimeMs === 'number')) &&
    isBranchDeletionList(value.branchDeletionTargets) &&
    isBranchDeletionList(value.pendingBranchDeletions) &&
    (value.branchDeletionMode === undefined ||
      value.branchDeletionMode === 'force' ||
      value.branchDeletionMode === 'merged-only') &&
    (value.preserveBranches === undefined || value.preserveBranches === true) &&
    (value.workspaceRootPayload === undefined ||
      (value.phase === 'verified' &&
        isRecord(value.workspaceRootPayload) &&
        typeof value.workspaceRootPayload.digest === 'string' &&
        /^[0-9a-f]{64}$/.test(value.workspaceRootPayload.digest) &&
        Array.isArray(value.workspaceRootPayload.standaloneRepoIds) &&
        value.workspaceRootPayload.standaloneRepoIds.length > 0 &&
        new Set(value.workspaceRootPayload.standaloneRepoIds).size ===
          value.workspaceRootPayload.standaloneRepoIds.length &&
        value.workspaceRootPayload.standaloneRepoIds.every(
          (repoId) =>
            typeof repoId === 'string' &&
            repoId.length > 0 &&
            repoId !== '.' &&
            repoId !== '..' &&
            !repoId.includes('/') &&
            !repoId.includes('\\') &&
            !repoId.includes('\0'),
        )))
  );
}

function isStagedDescriptor(
  value: unknown,
): value is ArchivedGitStagedDescriptor {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.status !== 'capturing' && value.status !== 'ready') ||
    !Array.isArray(value.repositories) ||
    !value.repositories.every(isGitRepositoryState) ||
    (value.teardown !== undefined && !isTeardownJournal(value.teardown))
  ) {
    return false;
  }
  return (
    (value.status === 'capturing' &&
      value.gitChanges === undefined &&
      value.pullRequestMetadata === undefined) ||
    (value.status === 'ready' &&
      isGitChanges(value.gitChanges) &&
      isPullRequestCapture(value.pullRequestMetadata, value.repositories))
  );
}

function isPrePullRequestReadyDescriptor(value: unknown): value is {
  version: 1;
  status: 'ready';
  repositories: ArchivedGitRepositoryState[];
  gitChanges: ArchivedGitChangesSummary;
  teardown?: ArchivedGitTeardownJournal;
} {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.status === 'ready' &&
    Array.isArray(value.repositories) &&
    value.repositories.every(isGitRepositoryState) &&
    isGitChanges(value.gitChanges) &&
    value.pullRequestMetadata === undefined &&
    (value.teardown === undefined || isTeardownJournal(value.teardown))
  );
}

export async function readArchivedGitStagedDescriptor(
  workspaceId: string,
  containerId: string,
  /**
   * `recoveryOnly` skips the pinned-repository check. `readOnly` returns a
   * legacy ready descriptor normalized but leaves the file as it is, for
   * admission checks that must run before any effect.
   */
  options?: { recoveryOnly?: boolean; readOnly?: boolean },
): Promise<ArchivedGitStagedDescriptor | null> {
  const filePath = getArchivedContainerGitStateStagedPath(
    workspaceId,
    containerId,
  );
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid archived Git staged descriptor: ${filePath}`);
  }
  if (isPrePullRequestReadyDescriptor(parsed)) {
    // A ready capture with a teardown journal may be the only remaining copy.
    // Missing optional PR metadata must never downgrade that capture to partial.
    if (parsed.teardown) {
      const descriptor: ArchivedGitReadyStagedDescriptor = {
        ...parsed,
        pullRequestMetadata: {
          capturedAt: parsed.teardown.enteredAt,
          repositories: parsed.repositories.map(({ repoId, repoName }) => ({
            repoId,
            repoName,
            status: 'unavailable',
          })),
        },
      };
      const config = await readWorkspaceConfig(workspaceId);
      if (config.type !== 'single-repo' && config.type !== 'multi-repo') {
        throw new Error('The archived worktree project type has changed.');
      }
      const definitions = await resolveRepositoryDefinitions({
        workspaceId,
        workspaceType: config.type,
      });
      assertStateMatchesDefinitions({
        workspaceId,
        containerId,
        repositories: descriptor.repositories,
        definitions,
        allowAdditionalDefinitions: config.type === 'multi-repo',
      });
      const canonicalPath = resolve(
        getWorkspaceWorktreeDir(workspaceId, containerId),
      );
      if (
        resolve(parsed.teardown.canonicalPath) !== canonicalPath ||
        resolve(parsed.teardown.quarantinePath) !==
          quarantinePathFor(canonicalPath)
      ) {
        throw new Error(
          'Archived Git recovery paths failed integrity validation.',
        );
      }
      if (!options?.recoveryOnly) {
        await validatePinnedRepositories(descriptor.repositories);
      }
      if (!options?.readOnly) {
        await persistStagedDescriptor(workspaceId, containerId, descriptor);
      }
      return descriptor;
    }
    return {
      version: 1,
      status: 'capturing',
      repositories: parsed.repositories,
      ...(parsed.teardown ? { teardown: parsed.teardown } : {}),
    };
  }
  if (!isStagedDescriptor(parsed)) {
    throw new Error(`Invalid archived Git staged descriptor: ${filePath}`);
  }
  return parsed;
}

async function persistStagedDescriptor(
  workspaceId: string,
  containerId: string,
  descriptor: ArchivedGitStagedDescriptor,
): Promise<void> {
  await writeJsonDurably(
    getArchivedContainerGitStateStagedPath(workspaceId, containerId),
    descriptor,
  );
}

function validateRepoId(repoId: string): void {
  if (
    repoId !== SINGLE_REPO_USAGE_REPO_ID &&
    repoId !== WORKSPACE_ROOT_REPO_ID
  ) {
    validateId(repoId, 'repoId');
  }
}

export function buildArchivedContainerSnapshotRef(
  workspaceId: string,
  containerId: string,
  repoId: string,
): string {
  validateId(workspaceId, 'workspaceId');
  validateId(containerId, 'containerId');
  validateRepoId(repoId);
  return `${ARCHIVE_REF_NAMESPACE}/${workspaceId}/${containerId}/${repoId}`;
}

async function assertValidRef(
  repoPath: string,
  refName: string,
): Promise<void> {
  await runGit(repoPath, ['check-ref-format', refName]);
}

async function readRef(
  repoPath: string,
  refName: string,
): Promise<string | null> {
  try {
    return await runGit(repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      refName,
    ]);
  } catch (error) {
    if (isRecord(error) && error.code === 1) return null;
    throw error;
  }
}

export async function pinArchivedContainerSnapshotRef(args: {
  repoPath: string;
  refName: string;
  commit: string;
}): Promise<void> {
  await assertValidRef(args.repoPath, args.refName);
  await assertGitObject(args.repoPath, args.commit, 'commit');
  const existing = await readRef(args.repoPath, args.refName);
  if (existing !== null && existing !== args.commit) {
    throw new Error(
      `Archived Git ref ${args.refName} points to an unexpected object.`,
    );
  }
  if (existing === null) {
    await runGit(args.repoPath, ['update-ref', args.refName, args.commit]);
  }
  const verified = await readRef(args.repoPath, args.refName);
  if (verified !== args.commit) {
    throw new Error(`Failed to pin archived Git ref ${args.refName}.`);
  }
}

/**
 * CAN-5334: read-only. Where a recorded snapshot ref stands in `repoPath`,
 * and whether that repository holds the recorded snapshot commit, which only
 * the captured repository has. Git failures throw.
 */
export async function inspectArchivedContainerSnapshotRef(args: {
  repoPath: string;
  refName: string;
  expectedCommit: string;
}): Promise<{ ref: 'absent' | 'expected' | 'other'; commitPresent: boolean }> {
  await assertValidRef(args.repoPath, args.refName);
  const existing = await readRef(args.repoPath, args.refName);
  const commitPresent =
    GIT_OBJECT_ID_RE.test(args.expectedCommit) &&
    (await readRef(args.repoPath, `${args.expectedCommit}^{commit}`)) ===
      args.expectedCommit;
  return {
    ref:
      existing === null
        ? 'absent'
        : existing === args.expectedCommit
          ? 'expected'
          : 'other',
    commitPresent,
  };
}

export async function deleteArchivedContainerSnapshotRef(args: {
  repoPath: string;
  refName: string;
  expectedCommit: string;
}): Promise<void> {
  await assertValidRef(args.repoPath, args.refName);
  const existing = await readRef(args.repoPath, args.refName);
  if (existing === null) return;
  if (existing !== args.expectedCommit) {
    throw new Error(
      `Archived Git ref ${args.refName} points to an unexpected object.`,
    );
  }
  await runGit(args.repoPath, [
    'update-ref',
    '-d',
    args.refName,
    args.expectedCommit,
  ]);
  if ((await readRef(args.repoPath, args.refName)) !== null) {
    throw new Error(`Failed to release archived Git ref ${args.refName}.`);
  }
}

async function resolveRepositoryDefinitions(args: {
  workspaceId: string;
  workspaceType: 'single-repo' | 'multi-repo';
  worktreeRootPath?: string;
}): Promise<ArchivedRepositoryDefinition[]> {
  const canonicalRoot = args.worktreeRootPath
    ? resolve(args.worktreeRootPath)
    : undefined;
  if (args.workspaceType === 'single-repo') {
    const config = await readWorkspaceConfig(args.workspaceId);
    if (config.type !== 'single-repo' || !config.repoPath) {
      throw new Error(
        'The archived worktree source repository is unavailable.',
      );
    }
    const referenceRepoPath = resolve(
      await resolveProjectReferenceRepoPath(config.repoPath),
    );
    return [
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: basename(referenceRepoPath),
        relativePath: '.',
        referenceRepoPath,
        ...(canonicalRoot ? { worktreeRepoPath: canonicalRoot } : {}),
      },
    ];
  }

  const config = await readEffectiveWorkspaceConfig(args.workspaceId);
  if (config.localConfig.type !== 'multi-repo') {
    throw new Error('The archived worktree project type has changed.');
  }
  const definitions: ArchivedRepositoryDefinition[] = [];
  if (config.sourceRepoPath) {
    definitions.push({
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoName: WORKSPACE_ROOT_REPO_NAME,
      relativePath: '.',
      referenceRepoPath: resolve(
        await resolveWorkspaceReferenceRepoPath(config.sourceRepoPath),
      ),
      ...(canonicalRoot ? { worktreeRepoPath: canonicalRoot } : {}),
    });
  }
  for (const repo of config.repos) {
    validateId(repo.id, 'repoId');
    definitions.push({
      repoId: repo.id,
      repoName: repo.name,
      relativePath: `repos/${repo.id}`,
      referenceRepoPath: resolve(repo.repoPath),
      ...(canonicalRoot
        ? { worktreeRepoPath: join(canonicalRoot, 'repos', repo.id) }
        : {}),
    });
  }
  return definitions.sort((left, right) =>
    left.repoId.localeCompare(right.repoId),
  );
}

function assertStateMatchesDefinitions(args: {
  workspaceId: string;
  containerId: string;
  repositories: ArchivedGitRepositoryState[];
  definitions: ArchivedRepositoryDefinition[];
  allowAdditionalDefinitions?: boolean;
}): void {
  if (
    !args.allowAdditionalDefinitions &&
    args.repositories.length !== args.definitions.length
  ) {
    throw new Error(
      'The archived repository set no longer matches the project.',
    );
  }
  const byId = new Map(
    args.definitions.map((definition) => [definition.repoId, definition]),
  );
  const seen = new Set<string>();
  for (const repository of args.repositories) {
    if (seen.has(repository.repoId)) {
      throw new Error(`Duplicate archived repository id: ${repository.repoId}`);
    }
    seen.add(repository.repoId);
    const definition = byId.get(repository.repoId);
    const expectedRef = buildArchivedContainerSnapshotRef(
      args.workspaceId,
      args.containerId,
      repository.repoId,
    );
    if (
      !definition ||
      resolve(repository.referenceRepoPath) !== definition.referenceRepoPath ||
      repository.relativePath !== definition.relativePath ||
      repository.snapshotRef !== expectedRef
    ) {
      throw new Error(
        `Archived repository ${repository.repoId} failed integrity validation.`,
      );
    }
  }
}

export async function assertArchivedGitStateMatchesWorkspace(args: {
  workspaceId: string;
  containerId: string;
  workspaceType: 'single-repo' | 'multi-repo';
  gitState: ArchivedGitState;
}): Promise<void> {
  const definitions = await resolveRepositoryDefinitions({
    workspaceId: args.workspaceId,
    workspaceType: args.workspaceType,
  });
  assertStateMatchesDefinitions({
    workspaceId: args.workspaceId,
    containerId: args.containerId,
    repositories: args.gitState.repositories,
    definitions,
    allowAdditionalDefinitions: args.workspaceType === 'multi-repo',
  });
}

export function assertArchivedGitStateManifestIdentity(args: {
  workspaceId: string;
  containerId: string;
  workspaceType: 'single-repo' | 'multi-repo';
  gitState: ArchivedGitState;
  allowEmptyRepositories?: boolean;
}): void {
  if (
    args.gitState.version !== 1 ||
    args.gitState.diffFormatVersion !== 1 ||
    (args.gitState.repositories.length === 0 && !args.allowEmptyRepositories)
  ) {
    throw new Error('Invalid archived Git state version.');
  }
  const seen = new Set<string>();
  for (const repository of args.gitState.repositories) {
    if (!isGitRepositoryState(repository) || seen.has(repository.repoId)) {
      throw new Error('Invalid archived Git repository state.');
    }
    seen.add(repository.repoId);
    const expectedRelativePath =
      repository.repoId === SINGLE_REPO_USAGE_REPO_ID ||
      repository.repoId === WORKSPACE_ROOT_REPO_ID
        ? '.'
        : `repos/${repository.repoId}`;
    if (
      repository.relativePath !== expectedRelativePath ||
      repository.snapshotRef !==
        buildArchivedContainerSnapshotRef(
          args.workspaceId,
          args.containerId,
          repository.repoId,
        )
    ) {
      throw new Error('Invalid archived Git repository identity.');
    }
  }
  if (
    args.workspaceType === 'single-repo' &&
    (args.gitState.repositories.length !== 1 ||
      args.gitState.repositories[0]?.repoId !== SINGLE_REPO_USAGE_REPO_ID)
  ) {
    throw new Error('Invalid single-repository archived Git state.');
  }
}

/** Capture one bounded, immutable pull-request result per Git repository. */
export async function captureArchivedPullRequestMetadata(
  repositories: ArchivedGitRepositoryState[],
): Promise<ArchivedPullRequestCapture> {
  const orderedRepositories = [...repositories].sort((left, right) =>
    left.repoId.localeCompare(right.repoId),
  );
  const capturedAt = new Date().toISOString();
  const capturedRepositories = await mapWithConcurrency(
    orderedRepositories,
    CAPTURE_CONCURRENCY,
    async (repository): Promise<ArchivedPullRequestRepositoryCapture> => {
      if (!repository.branchName) {
        return {
          repoId: repository.repoId,
          repoName: repository.repoName,
          status: 'unavailable',
        };
      }

      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Archived pull request lookup timed out.'));
        }, PULL_REQUEST_CAPTURE_TIMEOUT_MS);
        timeout.unref?.();
      });
      try {
        const pullRequest = await Promise.race([
          fetchArchivedPullRequestMetadata(
            repository.referenceRepoPath,
            repository.branchName,
            {
              timeoutMs: PULL_REQUEST_CAPTURE_TIMEOUT_MS,
              signal: controller.signal,
            },
          ),
          timedOut,
        ]);
        return {
          repoId: repository.repoId,
          repoName: repository.repoName,
          status: 'complete',
          pullRequest,
        };
      } catch {
        return {
          repoId: repository.repoId,
          repoName: repository.repoName,
          status: 'unavailable',
        };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  );
  return {
    capturedAt,
    repositories: capturedRepositories,
  };
}

async function validatePinnedRepositories(
  repositories: ArchivedGitRepositoryState[],
): Promise<void> {
  for (const repository of repositories) {
    try {
      await Promise.all([
        assertGitObject(
          repository.referenceRepoPath,
          repository.comparisonBaseCommit,
          'commit',
        ),
        assertGitObject(
          repository.referenceRepoPath,
          repository.headCommit,
          'commit',
        ),
        assertGitObject(
          repository.referenceRepoPath,
          repository.indexSnapshotCommit,
          'commit',
        ),
        assertGitObject(
          repository.referenceRepoPath,
          repository.worktreeSnapshotCommit,
          'commit',
        ),
      ]);
      if (
        (await readRef(
          repository.referenceRepoPath,
          repository.snapshotRef,
        )) !== repository.worktreeSnapshotCommit
      ) {
        throw new Error('its retained snapshot ref is missing or stale');
      }
    } catch (error) {
      throw new Error(
        `Archived Git state for repository ${repository.repoName} is unavailable; the archive was preserved. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export async function repinArchivedGitState(
  gitState: ArchivedGitState,
): Promise<void> {
  for (const repository of gitState.repositories) {
    await pinArchivedContainerSnapshotRef({
      repoPath: repository.referenceRepoPath,
      refName: repository.snapshotRef,
      commit: repository.worktreeSnapshotCommit,
    });
  }
}

export async function releaseArchivedGitState(
  gitState: ArchivedGitState,
  operations: {
    deleteRef?: typeof deleteArchivedContainerSnapshotRef;
  } = {},
): Promise<void> {
  const deleteRef = operations.deleteRef ?? deleteArchivedContainerSnapshotRef;
  try {
    for (const repository of gitState.repositories) {
      await deleteRef({
        repoPath: repository.referenceRepoPath,
        refName: repository.snapshotRef,
        expectedCommit: repository.worktreeSnapshotCommit,
      });
    }
  } catch (error) {
    await repinArchivedGitState(gitState).catch((repinError) => {
      // eslint-disable-next-line no-console
      console.error(
        'Failed to re-pin archived Git refs after release failure.',
        repinError,
      );
    });
    throw error;
  }
}

function archiveGitEnvironment(executable: string): {
  executable: string;
  env: Record<string, string>;
} {
  return {
    executable,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  };
}

async function buildArchiveGitCaptureInputs(args: {
  workspaceId: string;
  containerId: string;
  definitions: readonly ArchivedRepositoryDefinition[];
}): Promise<
  Extract<
    ArchiveIoOperationRequest,
    { type: 'capture-git' }
  >['input']['repositories']
> {
  return Promise.all(
    args.definitions.map(async (definition) => {
      if (!definition.worktreeRepoPath) {
        throw new Error(
          `Repository ${definition.repoName} is missing from the worktree.`,
        );
      }
      const effective = await resolveEffectiveBaseBranchForRepo({
        projectId: args.workspaceId,
        worktreeId: args.containerId,
        repoId: definition.repoId,
        repoPath: definition.worktreeRepoPath,
        allowRemoteLookup: false,
      }).catch(() => ({ branch: null }));
      const comparisonBaseBranch = effective.branch?.trim() || undefined;
      const comparisonBaseRefs = comparisonBaseBranch
        ? comparisonBaseBranch.startsWith('origin/')
          ? [
              `refs/remotes/origin/${comparisonBaseBranch.slice(
                'origin/'.length,
              )}`,
            ]
          : [
              `refs/remotes/origin/${comparisonBaseBranch}`,
              `refs/heads/${comparisonBaseBranch}`,
            ]
        : [];
      return {
        repoId: definition.repoId,
        repoName: definition.repoName,
        relativePath: definition.relativePath,
        referenceRepoPath: definition.referenceRepoPath,
        worktreeRepoPath: definition.worktreeRepoPath,
        ...(comparisonBaseBranch ? { comparisonBaseBranch } : {}),
        comparisonBaseRefs,
        snapshotRef: buildArchivedContainerSnapshotRef(
          args.workspaceId,
          args.containerId,
          definition.repoId,
        ),
      };
    }),
  );
}

/**
 * The repositories a Git capture of this worktree archives. Throws where the
 * capture refuses its repository set, before any Git effect of its own.
 */
async function selectArchivedGitCaptureDefinitions(args: {
  workspaceId: string;
  containerId: string;
  workspaceType: 'single-repo' | 'multi-repo';
  canonicalPath: string;
  persistedWorktree: WorktreeData;
  staged: ArchivedGitStagedDescriptor | null;
  allowEmptyRepositories?: boolean;
}): Promise<ArchivedRepositoryDefinition[]> {
  let definitions = await resolveRepositoryDefinitions({
    workspaceId: args.workspaceId,
    workspaceType: args.workspaceType,
    worktreeRootPath: args.canonicalPath,
  });
  if (args.workspaceType === 'multi-repo') {
    const includedRepoIds = args.persistedWorktree.includedRepoIds;
    if (includedRepoIds) {
      const included = new Set(includedRepoIds);
      definitions = definitions.filter(
        (definition) =>
          definition.repoId === WORKSPACE_ROOT_REPO_ID ||
          included.has(definition.repoId),
      );
    } else if (args.staged?.status === 'ready') {
      definitions = capturedRepositoryDefinitions(
        definitions,
        args.staged.repositories,
      );
    } else {
      const presentDefinitions: ArchivedRepositoryDefinition[] = [];
      for (const definition of definitions) {
        if (
          definition.worktreeRepoPath &&
          (await pathExists(definition.worktreeRepoPath))
        ) {
          presentDefinitions.push(definition);
        }
      }
      definitions = presentDefinitions;
    }
  }
  if (definitions.length === 0 && !args.allowEmptyRepositories) {
    throw new Error('The worktree has no configured repositories to archive.');
  }
  if (args.staged?.status === 'ready') {
    assertStateMatchesDefinitions({
      workspaceId: args.workspaceId,
      containerId: args.containerId,
      repositories: args.staged.repositories,
      definitions,
    });
  }
  return definitions;
}

/**
 * Read-only (CAN-4985): the source repositories a Git capture of this worktree
 * would open, given its staged descriptor. Throws where that capture rejects
 * its repository set: a configuration it cannot resolve, no repository, or a
 * ready capture that no longer matches the configuration.
 */
export async function readArchivedGitCaptureSourceRepositories(args: {
  workspaceId: string;
  containerId: string;
  workspaceType: 'single-repo' | 'multi-repo';
  persistedWorktree: WorktreeData;
  staged: ArchivedGitStagedDescriptor | null;
}): Promise<string[]> {
  validateId(args.workspaceId, 'workspaceId');
  validateId(args.containerId, 'containerId');
  const definitions = await selectArchivedGitCaptureDefinitions({
    ...args,
    canonicalPath: resolve(
      getWorkspaceWorktreeDir(args.workspaceId, args.containerId),
    ),
  });
  return definitions.map((definition) => definition.referenceRepoPath);
}

export async function captureArchivedContainerGitState(args: {
  workspaceId: string;
  containerId: string;
  workspaceType: 'single-repo' | 'multi-repo';
  worktreePath: string;
  persistedWorktree: WorktreeData;
  /** Root-only multi-repo archives may contain files but no Git checkout. */
  allowEmptyRepositories?: boolean;
}): Promise<{
  gitState: ArchivedGitState;
  gitChanges: ArchivedGitChangesSummary;
  pullRequestMetadata: ArchivedPullRequestCapture;
}> {
  validateId(args.workspaceId, 'workspaceId');
  validateId(args.containerId, 'containerId');
  if (args.persistedWorktree.id !== args.containerId) {
    throw new Error('Archived worktree identity changed before Git capture.');
  }
  const canonicalPath = resolve(
    getWorkspaceWorktreeDir(args.workspaceId, args.containerId),
  );
  if (resolve(args.worktreePath) !== canonicalPath) {
    throw new Error('Invalid archived worktree capture path.');
  }
  let existing = await readArchivedGitStagedDescriptor(
    args.workspaceId,
    args.containerId,
  );
  // CAN-3039: a checkout deleted outside the app cannot be captured, whether or
  // not an earlier attempt already staged a partial descriptor. Report it the
  // same way in both cases so the archive path degrades to a Git-less container
  // instead of failing once with a raw per-repository capture error and only
  // succeeding on the retry that finds the descriptor this attempt stages.
  // A `ready` descriptor still resolves below — its snapshots are already
  // pinned outside the worktree — and a teardown journal deliberately keeps
  // requiring recovery, since its canonical path is absent by design.
  if (!existing || (existing.status === 'capturing' && !existing.teardown)) {
    if (
      args.allowEmptyRepositories !== true &&
      !(await pathExists(canonicalPath))
    ) {
      throw new MissingWorktreeIncompleteArchivedGitCaptureError();
    }
  }
  const definitions = await selectArchivedGitCaptureDefinitions({
    workspaceId: args.workspaceId,
    containerId: args.containerId,
    workspaceType: args.workspaceType,
    canonicalPath,
    persistedWorktree: args.persistedWorktree,
    staged: existing,
    allowEmptyRepositories: args.allowEmptyRepositories,
  });

  if (existing?.status === 'ready') {
    const quarantinePath = quarantinePathFor(canonicalPath);
    const [canonicalExists, quarantineExists] = await Promise.all([
      pathExists(canonicalPath),
      pathExists(quarantinePath),
    ]);
    const canSafelyRecapture =
      canonicalExists &&
      (!existing.teardown ||
        (existing.teardown.phase === 'quarantine-pending' &&
          !quarantineExists));
    try {
      await validatePinnedRepositories(existing.repositories);
      if (
        canSafelyRecapture &&
        !(await snapshotsMatchAtPath({
          repositories: existing.repositories,
          rootPath: canonicalPath,
        }))
      ) {
        throw new Error('The staged archived Git state is stale.');
      }
    } catch (error) {
      if (!canSafelyRecapture) throw error;
      await releaseArchivedGitState({
        version: 1,
        diffFormatVersion: 1,
        repositories: existing.repositories,
      });
      await rm(
        getArchivedContainerGitStateStagedPath(
          args.workspaceId,
          args.containerId,
        ),
        { force: true },
      );
      existing = null;
    }
    if (existing) {
      return {
        gitState: {
          version: 1,
          diffFormatVersion: 1,
          repositories: existing.repositories,
        },
        gitChanges: existing.gitChanges,
        pullRequestMetadata: existing.pullRequestMetadata,
      };
    }
  }
  if (existing) {
    if (existing.teardown) {
      throw new InterruptedArchivedGitTeardownRequiresRecoveryError();
    }
    if (!(await pathExists(canonicalPath))) {
      throw new MissingWorktreeIncompleteArchivedGitCaptureError();
    }
    await releaseArchivedGitState({
      version: 1,
      diffFormatVersion: 1,
      repositories: existing.repositories,
    });
    await rm(
      getArchivedContainerGitStateStagedPath(
        args.workspaceId,
        args.containerId,
      ),
      { force: true },
    );
  }

  let descriptor: ArchivedGitCapturingStagedDescriptor = {
    version: 1,
    status: 'capturing',
    repositories: [],
  };
  try {
    const git = archiveGitEnvironment(
      await getResolvedGitExecutableForSpawn(process.env),
    );
    const captured = await archiveIoExecutor({
      version: 1,
      type: 'capture-git',
      requestId: randomUUID(),
      operationId: `archive:${args.workspaceId}:${args.containerId}:capture-git`,
      projectId: args.workspaceId,
      containerId: args.containerId,
      expectedCreatedAt: args.persistedWorktree.createdAt,
      input: {
        git,
        stagedDescriptorPath: getArchivedContainerGitStateStagedPath(
          args.workspaceId,
          args.containerId,
        ),
        repositories: await buildArchiveGitCaptureInputs({
          workspaceId: args.workspaceId,
          containerId: args.containerId,
          definitions,
        }),
      },
    });
    descriptor = {
      version: 1,
      status: 'capturing',
      repositories: captured.repositories,
    };
    await validatePinnedRepositories(descriptor.repositories);
    const gitChanges = captured.gitChanges;
    const pullRequestMetadata = await captureArchivedPullRequestMetadata(
      descriptor.repositories,
    );
    await archiveIoExecutor({
      version: 1,
      type: 'complete-git-capture',
      requestId: randomUUID(),
      operationId: `archive:${args.workspaceId}:${args.containerId}:complete-git-capture`,
      projectId: args.workspaceId,
      containerId: args.containerId,
      expectedCreatedAt: args.persistedWorktree.createdAt,
      input: {
        stagedDescriptorPath: getArchivedContainerGitStateStagedPath(
          args.workspaceId,
          args.containerId,
        ),
        repositories: descriptor.repositories,
        gitChanges,
        pullRequestMetadata,
      },
    });
    return {
      gitState: {
        version: 1,
        diffFormatVersion: 1,
        repositories: descriptor.repositories,
      },
      gitChanges,
      pullRequestMetadata,
    };
  } catch (error) {
    // The worker publishes each pinned ref to the staged descriptor before it
    // reports success. Re-read that durable state because a lost response can
    // leave the in-memory descriptor empty even though refs were published.
    // Preserve every valid descriptor here: the next capture/retention pass is
    // the single recovery owner and can release exactly the recorded refs.
    try {
      const publishedDescriptor = await readArchivedGitStagedDescriptor(
        args.workspaceId,
        args.containerId,
      );
      if (!publishedDescriptor && descriptor.repositories.length > 0) {
        await persistStagedDescriptor(
          args.workspaceId,
          args.containerId,
          descriptor,
        );
      }
    } catch {
      // Keep unreadable recovery evidence intact for explicit repair.
    }
    throw error;
  }
}

function quarantinePathFor(canonicalPath: string): string {
  return join(
    dirname(canonicalPath),
    `.${basename(canonicalPath)}.archive-quarantine`,
  );
}

async function listArchivedContainerTeardownTargets(
  descriptor: ArchivedGitStagedDescriptor,
  canonicalPath: string,
  quarantinePath: string,
  retainedRootPath: string,
): Promise<ArchivedContainerTeardownTarget[]> {
  const canonicalQuarantinePath = await realpath(quarantinePath);
  const targets: ArchivedContainerTeardownTarget[] = [];
  for (const repository of descriptor.repositories) {
    const configuredPath =
      repository.relativePath === '.'
        ? quarantinePath
        : join(quarantinePath, repository.relativePath);
    if (!isPathInside(quarantinePath, configuredPath)) {
      throw new Error(
        'Archived Git teardown target escaped its quarantine root.',
      );
    }
    const expectedCanonicalPath =
      repository.relativePath === '.'
        ? canonicalQuarantinePath
        : resolve(canonicalQuarantinePath, repository.relativePath);
    const canonicalTargetPath = await realpath(configuredPath).catch(
      (error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') {
          // Git worktree removal can complete for one child before a crash.
          // Keep its expected lexical path so stale registrations can still
          // be compared and pruned while teardown continues for siblings.
          return expectedCanonicalPath;
        }
        throw error;
      },
    );
    if (!isPathInside(canonicalQuarantinePath, canonicalTargetPath)) {
      throw new Error(
        'Archived Git teardown target escaped its quarantine root.',
      );
    }
    targets.push({
      repoId: repository.repoId,
      referenceRepoPath: repository.referenceRepoPath,
      quarantineRepoPath: canonicalTargetPath,
      preMoveRepoPath: join(canonicalPath, repository.relativePath),
      ...(repository.branchName
        ? {
            branchName: repository.branchName,
            expectedBranchTip: repository.headCommit,
          }
        : {}),
    });
  }
  const knownPaths = new Set(
    targets.map((target) => resolve(target.quarantineRepoPath)),
  );
  const reposPath = join(quarantinePath, 'repos');
  const entries = await readdir(reposPath, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return [];
      throw error;
    },
  );
  if (entries.length === 0) return targets;
  const canonicalReposPath = await realpath(reposPath);
  if (!isPathInside(canonicalQuarantinePath, canonicalReposPath)) {
    throw new Error(
      'Archived Git quarantine repository path escaped its quarantine root.',
    );
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stalePath = resolve(reposPath, entry.name);
    const canonicalStalePath = await realpath(stalePath);
    if (knownPaths.has(canonicalStalePath)) continue;
    if (!isPathInside(canonicalReposPath, canonicalStalePath)) {
      throw new Error(
        'Archived Git teardown target escaped its quarantine repository path.',
      );
    }
    if (
      descriptor.teardown?.workspaceRootPayload?.standaloneRepoIds.includes(
        entry.name,
      )
    ) {
      await assertRetainedCloneDependenciesUnchanged(
        canonicalStalePath,
        join(retainedRootPath, 'repos', entry.name),
      );
      continue;
    }
    const repository =
      await classifyUnmanagedWorktreeRepository(canonicalStalePath);
    if (repository.kind === 'directory') continue;
    if (repository.kind === 'standalone-clone') {
      throw new Error(
        `Repository ${entry.name} has no verified retained payload. The quarantine was preserved.`,
      );
    }
    const referenceRepoPath = repository.referenceRepoPath;
    const branchName = await runGit(canonicalStalePath, [
      'branch',
      '--show-current',
    ])
      .then((value) => value || undefined)
      .catch(() => undefined);
    const expectedBranchTip = branchName
      ? await runGit(referenceRepoPath, [
          'rev-parse',
          `refs/heads/${branchName}`,
        ]).catch(() => undefined)
      : undefined;
    targets.push({
      repoId: entry.name,
      referenceRepoPath,
      quarantineRepoPath: canonicalStalePath,
      preMoveRepoPath: join(canonicalPath, 'repos', entry.name),
      ...(branchName ? { branchName } : {}),
      ...(expectedBranchTip ? { expectedBranchTip } : {}),
    });
  }
  return targets;
}

async function persistPendingBranchDeletions(
  workspaceId: string,
  containerId: string,
  descriptor: ArchivedGitStagedDescriptor,
  requestedMode?: ArchivedContainerBranchDeletionMode,
): Promise<ArchivedGitStagedDescriptor> {
  if (!descriptor.teardown) return descriptor;
  const branchDeletionTargets = await buildBranchDeletionTargets(
    descriptor.repositories,
  );
  const branchDeletionMode =
    descriptor.teardown.branchDeletionMode ?? requestedMode ?? 'force';
  const teardown = { ...descriptor.teardown };
  delete teardown.preserveBranches;
  const updated: ArchivedGitStagedDescriptor = {
    ...descriptor,
    teardown: {
      ...teardown,
      branchDeletionTargets,
      pendingBranchDeletions: branchDeletionTargets,
      branchDeletionMode,
    },
  };
  await persistStagedDescriptor(workspaceId, containerId, updated);
  return updated;
}

async function buildBranchDeletionTargets(
  repositories: ArchivedGitRepositoryState[],
): Promise<ArchivedContainerBranchDeletion[]> {
  const deletions: ArchivedContainerBranchDeletion[] = [];
  for (const repository of repositories) {
    if (!repository.branchName) continue;
    deletions.push({
      repoId: repository.repoId,
      referenceRepoPath: repository.referenceRepoPath,
      repositoryIdentity: await getGitCommonDir(repository.referenceRepoPath),
      branchName: repository.branchName,
      expectedTip: repository.headCommit,
    });
  }
  return deletions;
}

async function clearPendingBranchDeletions(
  workspaceId: string,
  containerId: string,
  descriptor: ArchivedGitStagedDescriptor,
): Promise<ArchivedGitStagedDescriptor> {
  if (!descriptor.teardown) {
    return descriptor;
  }
  if (
    !descriptor.teardown.pendingBranchDeletions?.length &&
    descriptor.teardown.branchDeletionMode === undefined &&
    descriptor.teardown.preserveBranches === true
  ) {
    return descriptor;
  }
  const teardown = { ...descriptor.teardown };
  delete teardown.branchDeletionMode;
  const updated: ArchivedGitStagedDescriptor = {
    ...descriptor,
    teardown: {
      ...teardown,
      pendingBranchDeletions: [],
      preserveBranches: true,
    },
  };
  await persistStagedDescriptor(workspaceId, containerId, updated);
  return updated;
}

async function repairMovedWorktrees(
  definitions: ArchivedRepositoryDefinition[],
  rootPath: string,
): Promise<void> {
  for (const definition of definitions) {
    const movedPath =
      definition.relativePath === '.'
        ? rootPath
        : join(rootPath, definition.relativePath);
    await runGit(definition.referenceRepoPath, [
      'worktree',
      'repair',
      movedPath,
    ]);
  }
}

function capturedRepositoryDefinitions(
  definitions: ArchivedRepositoryDefinition[],
  repositories: ArchivedGitRepositoryState[],
): ArchivedRepositoryDefinition[] {
  const capturedRepoIds = new Set(
    repositories.map((repository) => repository.repoId),
  );
  return definitions.filter((definition) =>
    capturedRepoIds.has(definition.repoId),
  );
}

async function snapshotsMatchAtPath(args: {
  repositories: ArchivedGitRepositoryState[];
  rootPath: string;
}): Promise<boolean> {
  for (const repository of args.repositories) {
    const repoPath =
      repository.relativePath === '.'
        ? args.rootPath
        : join(args.rootPath, repository.relativePath);
    try {
      await assertWorktreeSnapshotSupported(repoPath);
      const [
        head,
        indexTree,
        worktreeTree,
        expectedIndexTree,
        expectedWorktreeTree,
      ] = await Promise.all([
        captureHeadCommitSha(repoPath),
        captureIndexTreeSha(repoPath),
        captureWorkingTreeSha(repoPath),
        runGit(repository.referenceRepoPath, [
          'rev-parse',
          `${repository.indexSnapshotCommit}^{tree}`,
        ]),
        runGit(repository.referenceRepoPath, [
          'rev-parse',
          `${repository.worktreeSnapshotCommit}^{tree}`,
        ]),
      ]);
      if (
        head !== repository.headCommit ||
        indexTree !== expectedIndexTree ||
        worktreeTree !== expectedWorktreeTree
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * CAN-5334: whether an unverified checkout quarantine still matches its
 * pinned snapshots, as a project deletion's redo would decide, with Git
 * failures kept apart from a mismatch. It runs the redo's own idempotent
 * `git worktree repair` first; nothing else is written. `snapshotsMatchAtPath`
 * keeps its boolean contract.
 */
export async function verifyArchivedGitQuarantineSnapshots(
  workspaceId: string,
  containerId: string,
): Promise<'match' | 'mismatch' | 'error'> {
  try {
    const descriptor = await readArchivedGitStagedDescriptor(
      workspaceId,
      containerId,
      { readOnly: true, recoveryOnly: true },
    );
    const canonicalPath = resolve(
      getWorkspaceWorktreeDir(workspaceId, containerId),
    );
    const quarantinePath = quarantinePathFor(canonicalPath);
    if (
      !descriptor?.teardown ||
      descriptor.repositories.length === 0 ||
      resolve(descriptor.teardown.quarantinePath) !== quarantinePath
    )
      return 'error';
    const config = await readWorkspaceConfig(workspaceId);
    if (config.type !== 'single-repo' && config.type !== 'multi-repo')
      return 'error';
    const definitions = await resolveRepositoryDefinitions({
      workspaceId,
      workspaceType: config.type,
    });
    await repairMovedWorktrees(
      capturedRepositoryDefinitions(definitions, descriptor.repositories),
      quarantinePath,
    );
    for (const repository of descriptor.repositories) {
      const repoPath =
        repository.relativePath === '.'
          ? quarantinePath
          : join(quarantinePath, repository.relativePath);
      await assertWorktreeSnapshotSupported(repoPath);
      const [head, indexTree, worktreeTree, expectedIndex, expectedWorktree] =
        await Promise.all([
          captureHeadCommitSha(repoPath),
          captureIndexTreeSha(repoPath),
          captureWorkingTreeSha(repoPath),
          runGit(repository.referenceRepoPath, [
            'rev-parse',
            `${repository.indexSnapshotCommit}^{tree}`,
          ]),
          runGit(repository.referenceRepoPath, [
            'rev-parse',
            `${repository.worktreeSnapshotCommit}^{tree}`,
          ]),
        ]);
      if (
        head !== repository.headCommit ||
        indexTree !== expectedIndex ||
        worktreeTree !== expectedWorktree
      )
        return 'mismatch';
    }
    return 'match';
  } catch {
    return 'error';
  }
}

export async function assertArchivedGitQuarantineOwned(args: {
  descriptor: ArchivedGitStagedDescriptor;
  quarantinePath: string;
}): Promise<void> {
  const stats = await lstat(args.quarantinePath);
  const identity = args.descriptor.teardown?.quarantineIdentity;
  const owned = identity
    ? quarantineIdentityMatches(stats, identity)
    : args.descriptor.repositories.length > 0 &&
      (await snapshotsMatchAtPath({
        repositories: args.descriptor.repositories,
        rootPath: args.quarantinePath,
      }));
  if (!owned) {
    throw new Error(
      'The interrupted archive quarantine changed identity; its files were preserved.',
    );
  }
}

export async function workspaceRootPayloadDigest(args: {
  rootPath: string;
  managedRepoIds?: ReadonlySet<string>;
}): Promise<string | null> {
  if (!(await pathExists(args.rootPath))) return null;
  const digest = createHash('sha256');
  // A new ReadStream allocates fresh backing buffers for every small file.
  // Reuse one buffer across this walk; concurrent digest calls own their own.
  let readBuffer: Buffer | undefined;
  const walk = async (
    directory: string,
    relativeDirectory: string,
  ): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (
        relativeDirectory === '' &&
        entry.name === '.git' &&
        args.managedRepoIds !== undefined
      )
        continue;
      if (
        relativeDirectory === '' &&
        entry.name === 'repos' &&
        args.managedRepoIds !== undefined
      ) {
        const repoEntries = await readdir(join(directory, entry.name), {
          withFileTypes: true,
        });
        if (
          repoEntries.every((repoEntry) =>
            args.managedRepoIds?.has(repoEntry.name),
          )
        ) {
          continue;
        }
      }
      if (
        relativeDirectory === 'repos' &&
        args.managedRepoIds?.has(entry.name)
      ) {
        continue;
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const entryPath = join(directory, entry.name);
      const stats = await lstat(entryPath);
      const mode =
        relativeDirectory === '' && entry.name === 'repos'
          ? 0
          : stats.mode & 0o777;
      digest.update(`${relativePath}\0${mode}\0`);
      if (stats.isDirectory()) {
        digest.update('directory\0');
        await walk(entryPath, relativePath);
      } else if (stats.isSymbolicLink()) {
        digest.update(`symlink\0${await readlink(entryPath)}\0`);
      } else if (stats.isFile()) {
        digest.update(`file\0${stats.size}\0`);
        readBuffer ??= Buffer.allocUnsafe(64 * 1024);
        const handle = await open(entryPath, 'r');
        try {
          while (true) {
            const { bytesRead } = await handle.read(
              readBuffer,
              0,
              readBuffer.length,
              null,
            );
            if (bytesRead === 0) break;
            digest.update(readBuffer.subarray(0, bytesRead));
          }
        } finally {
          await handle.close();
        }
        digest.update('\0');
      } else {
        digest.update('unsupported\0');
      }
    }
  };
  await walk(args.rootPath, '');
  return digest.digest('hex');
}

async function workspaceRootPayloadMatchesAtPath(args: {
  workspaceId: string;
  containerId: string;
  rootPath: string;
  managedRepoIds: readonly string[];
}): Promise<boolean> {
  try {
    const [capturedDigest, quarantinedDigest] = await Promise.all([
      workspaceRootPayloadDigest({
        rootPath: getArchivedContainerWorkspaceRootDir(
          args.workspaceId,
          args.containerId,
        ),
      }),
      workspaceRootPayloadDigest({
        rootPath: args.rootPath,
        managedRepoIds: new Set(args.managedRepoIds),
      }),
    ]);
    return capturedDigest !== null && capturedDigest === quarantinedDigest;
  } catch {
    return false;
  }
}

async function optionalGitMetadataInfo(path: string): Promise<Stats | null> {
  return lstat(path).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  });
}

async function assertRetainedCloneDependenciesUnchanged(
  repositoryPath: string,
  retainedRepositoryPath: string,
): Promise<void> {
  const changed = (): Error =>
    new Error(
      `Repository Git dependencies changed after archival: ${repositoryPath}. The quarantine was preserved.`,
    );
  const retainedGitInfo = await optionalGitMetadataInfo(
    join(retainedRepositoryPath, '.git'),
  );
  const bare = !retainedGitInfo;
  const localGitInfo = await optionalGitMetadataInfo(
    join(repositoryPath, '.git'),
  );
  if (bare && localGitInfo) throw changed();
  if (!bare && !localGitInfo) {
    const repository = await classifyUnmanagedWorktreeRepository(
      repositoryPath,
    ).catch(() => {
      throw changed();
    });
    if (repository.kind !== 'directory') throw changed();
    return;
  }
  const gitPath = bare ? repositoryPath : join(repositoryPath, '.git');
  const gitInfo = await optionalGitMetadataInfo(gitPath);
  if (gitInfo && !gitInfo.isDirectory()) throw changed();
  await assertGitMetadataSelfContained(
    gitPath,
    bare ? retainedRepositoryPath : join(retainedRepositoryPath, '.git'),
  ).catch(() => {
    throw changed();
  });
}

async function retainUnmanagedClonePayload(args: {
  workspaceId: string;
  containerId: string;
  descriptor: ArchivedGitStagedDescriptor;
  quarantinePath: string;
  expectedCreatedAt?: string;
}): Promise<ArchivedGitStagedDescriptor> {
  const teardown = args.descriptor.teardown;
  if (!teardown || teardown.phase !== 'verified') {
    throw new Error(
      'Repository payload retention requires a verified quarantine.',
    );
  }
  const destination = getArchivedContainerWorkspaceRootDir(
    args.workspaceId,
    args.containerId,
  );
  if (teardown.workspaceRootPayload) {
    const digest = await workspaceRootPayloadDigest({ rootPath: destination });
    if (digest !== teardown.workspaceRootPayload.digest) {
      throw new Error(
        'The retained repository payload changed or is missing. The quarantine was preserved.',
      );
    }
    return args.descriptor;
  }
  const managedRepoIds = args.descriptor.repositories
    .filter((repository) => repository.relativePath !== '.')
    .map((repository) => repository.repoId);
  const inventory = await listUnmanagedWorktreeRepositories(
    args.quarantinePath,
    managedRepoIds,
  );
  const standaloneRepoIds = inventory
    .filter((entry) => entry.repository.kind === 'standalone-clone')
    .map((entry) => entry.repoId)
    .sort();
  if (standaloneRepoIds.length === 0) return args.descriptor;
  if (inventory.some((entry) => entry.repository.kind === 'linked-worktree')) {
    throw new Error(
      'Cannot retain temporary clones alongside unmanaged linked worktrees. Move the linked worktrees outside this worktree and try again.',
    );
  }
  if (!(await pathExists(destination))) {
    const expectedCreatedAt =
      args.expectedCreatedAt ?? '1970-01-01T00:00:00.000Z';
    await captureArchivedWorkspaceRootPayload({
      source: args.quarantinePath,
      destination,
      managedRepoIds,
      copyExecutor: async (input) => {
        await archiveIoExecutor({
          version: 1,
          type: 'copy-payload',
          requestId: randomUUID(),
          operationId: `archive:${args.workspaceId}:${args.containerId}:retain-unmanaged-clones`,
          projectId: args.workspaceId,
          containerId: args.containerId,
          expectedCreatedAt,
          input,
        });
      },
      removeExecutor: async (input) => {
        await archiveIoExecutor({
          version: 1,
          type: 'remove-directory',
          requestId: randomUUID(),
          operationId: `archive:${args.workspaceId}:${args.containerId}:remove-retained-clone-staging:${basename(input.path)}`,
          projectId: args.workspaceId,
          containerId: args.containerId,
          expectedCreatedAt,
          input,
        });
      },
    });
  }
  const [capturedDigest, sourceDigest] = await Promise.all([
    workspaceRootPayloadDigest({ rootPath: destination }),
    workspaceRootPayloadDigest({
      rootPath: args.quarantinePath,
      managedRepoIds: new Set(managedRepoIds),
    }),
  ]);
  if (capturedDigest === null || capturedDigest !== sourceDigest) {
    throw new Error(
      'The retained repository payload does not match the quarantine. The quarantine was preserved.',
    );
  }
  const descriptor: ArchivedGitStagedDescriptor = {
    ...args.descriptor,
    teardown: {
      ...teardown,
      workspaceRootPayload: { digest: capturedDigest, standaloneRepoIds },
    },
  };
  await persistStagedDescriptor(args.workspaceId, args.containerId, descriptor);
  return descriptor;
}

async function rollbackPendingQuarantine(args: {
  workspaceId: string;
  containerId: string;
  descriptor: ArchivedGitStagedDescriptor;
  definitions: ArchivedRepositoryDefinition[];
  canonicalPath: string;
  quarantinePath: string;
}): Promise<never> {
  if (hasDestructiveLifecycle())
    throw new Error(
      'Archive quarantine requires manual recovery; preserve both paths.',
    );
  try {
    await rename(args.quarantinePath, args.canonicalPath);
    await repairMovedWorktrees(args.definitions, args.canonicalPath);
  } catch (rollbackError) {
    throw new Error(
      `The worktree changed while it was being archived, and automatic recovery could not move it back. Preserve the quarantine at ${args.quarantinePath}. ${
        rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError)
      }`,
    );
  }

  const { teardown: _teardown, ...capture } = args.descriptor;
  void _teardown;
  try {
    // Persist the canonical-path state before releasing refs. If this cleanup
    // is interrupted, the next capture verifies the live checkout and safely
    // discards any stale ready descriptor before recapturing it.
    await persistStagedDescriptor(args.workspaceId, args.containerId, capture);
    await releaseArchivedGitState({
      version: 1,
      diffFormatVersion: 1,
      repositories: capture.repositories,
    });
    await rm(
      getArchivedContainerGitStateStagedPath(
        args.workspaceId,
        args.containerId,
      ),
      { force: true },
    );
  } catch (cleanupError) {
    throw new Error(
      `The worktree changed while it was being archived. The checkout was restored, but archived Git cleanup did not complete; retry the archive. ${
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError)
      }`,
    );
  }
  throw new Error(
    'The worktree changed while it was being archived. Try again.',
  );
}

/**
 * Establishes the irreversible-delete commit point. The whole checkout is
 * first renamed on the same volume, repaired, and revalidated against the
 * pinned snapshots. Callers may delete only the returned quarantine path.
 */
export async function prepareArchivedContainerTeardown(args: {
  workspaceId: string;
  containerId: string;
  workspaceType: 'single-repo' | 'multi-repo';
  gitState: ArchivedGitState;
  deleteBranches?: boolean;
  branchDeletionMode?: ArchivedContainerBranchDeletionMode;
  workspaceRootCapture?: {
    managedRepoIds: readonly string[];
  };
  expectedCreatedAt?: string;
}): Promise<ArchivedContainerTeardownPlan> {
  const canonicalPath = resolve(
    getWorkspaceWorktreeDir(args.workspaceId, args.containerId),
  );
  const quarantinePath = quarantinePathFor(canonicalPath);
  const definitions = await resolveRepositoryDefinitions({
    workspaceId: args.workspaceId,
    workspaceType: args.workspaceType,
  });
  assertStateMatchesDefinitions({
    workspaceId: args.workspaceId,
    containerId: args.containerId,
    repositories: args.gitState.repositories,
    definitions,
    allowAdditionalDefinitions: args.workspaceType === 'multi-repo',
  });
  await validatePinnedRepositories(args.gitState.repositories);
  const loadedDescriptor = await readArchivedGitStagedDescriptor(
    args.workspaceId,
    args.containerId,
  );
  if (!loadedDescriptor || loadedDescriptor.status !== 'ready') {
    throw new Error('Archived Git state is not ready for teardown.');
  }
  let descriptor: ArchivedGitStagedDescriptor = loadedDescriptor;
  const requestedBranchDeletionMode =
    args.branchDeletionMode ??
    (args.deleteBranches === true ? ('force' as const) : undefined);
  assertStateMatchesDefinitions({
    workspaceId: args.workspaceId,
    containerId: args.containerId,
    repositories: descriptor.repositories,
    definitions,
    allowAdditionalDefinitions: args.workspaceType === 'multi-repo',
  });
  if (
    JSON.stringify(descriptor.repositories) !==
    JSON.stringify(args.gitState.repositories)
  ) {
    throw new Error('Archived Git state changed before teardown.');
  }
  const repairDefinitions = capturedRepositoryDefinitions(
    definitions,
    descriptor.repositories,
  );

  if (descriptor.teardown) {
    if (
      resolve(descriptor.teardown.canonicalPath) !== canonicalPath ||
      resolve(descriptor.teardown.quarantinePath) !== quarantinePath
    ) {
      throw new Error(
        'Archived Git teardown paths failed integrity validation.',
      );
    }
    if (
      args.deleteBranches !== false &&
      descriptor.teardown.pendingBranchDeletions?.length
    ) {
      descriptor = await persistPendingBranchDeletions(
        args.workspaceId,
        args.containerId,
        descriptor,
        requestedBranchDeletionMode,
      );
    }
  }

  let canonicalExists = await pathExists(canonicalPath);
  let quarantineExists = await pathExists(quarantinePath);
  if (descriptor.teardown?.phase === 'verified') {
    if (quarantineExists) {
      await assertArchivedGitQuarantineOwned({
        descriptor,
        quarantinePath,
      });
    }
    descriptor = await retainUnmanagedClonePayload({
      workspaceId: args.workspaceId,
      containerId: args.containerId,
      descriptor,
      quarantinePath,
      expectedCreatedAt: args.expectedCreatedAt,
    });
    if (args.deleteBranches === false) {
      descriptor = await clearPendingBranchDeletions(
        args.workspaceId,
        args.containerId,
        descriptor,
      );
    } else if (args.deleteBranches === true) {
      descriptor = await persistPendingBranchDeletions(
        args.workspaceId,
        args.containerId,
        descriptor,
        requestedBranchDeletionMode,
      );
    }
    if (quarantineExists) {
      return {
        canonicalPath,
        quarantinePath,
        alreadyRemoved: false,
        targets: await listArchivedContainerTeardownTargets(
          descriptor,
          canonicalPath,
          quarantinePath,
          getArchivedContainerWorkspaceRootDir(
            args.workspaceId,
            args.containerId,
          ),
        ),
        pendingBranchDeletions:
          descriptor.teardown?.pendingBranchDeletions ?? [],
        branchDeletionMode: descriptor.teardown?.branchDeletionMode,
      };
    }
    // CAN-5717: skipping the worker must not skip its removal postconditions.
    // A verified descriptor is not evidence that Git actually unregistered the
    // checkout. Retry cannot attribute a gitdir-less orphan, so never scan or
    // delete administrative residue here, regardless of its contents.
    for (const repository of descriptor.repositories) {
      await assertArchiveWorktreeRemoval(
        [
          canonicalPath,
          quarantinePath,
          join(canonicalPath, repository.relativePath),
          join(quarantinePath, repository.relativePath),
        ],
        await runGit(repository.referenceRepoPath, [
          'worktree',
          'list',
          '--porcelain',
          '-z',
        ]),
      );
    }
    return {
      canonicalPath,
      quarantinePath,
      alreadyRemoved: true,
      targets: [],
      pendingBranchDeletions: descriptor.teardown?.pendingBranchDeletions ?? [],
      branchDeletionMode: descriptor.teardown?.branchDeletionMode,
    };
  }

  if (descriptor.teardown?.phase === 'quarantine-pending') {
    if (canonicalExists && quarantineExists) {
      throw new Error(
        `Archived Git recovery found both the live worktree and quarantine. Preserve ${quarantinePath} for manual recovery.`,
      );
    }
    if (!canonicalExists && !quarantineExists) {
      throw new Error(
        'Archived Git recovery could not find either the live worktree or its quarantine.',
      );
    }
    if (canonicalExists) {
      const { teardown: _teardown, ...capture } = descriptor;
      void _teardown;
      descriptor = capture;
      await persistStagedDescriptor(
        args.workspaceId,
        args.containerId,
        descriptor,
      );
    } else {
      if (descriptor.teardown.quarantineIdentity) {
        await assertArchivedGitQuarantineOwned({
          descriptor,
          quarantinePath,
        });
      }
      await repairMovedWorktrees(repairDefinitions, quarantinePath);
      if (
        !(await snapshotsMatchAtPath({
          repositories: descriptor.repositories,
          rootPath: quarantinePath,
        })) ||
        (args.workspaceRootCapture !== undefined &&
          !(await workspaceRootPayloadMatchesAtPath({
            workspaceId: args.workspaceId,
            containerId: args.containerId,
            rootPath: quarantinePath,
            managedRepoIds: args.workspaceRootCapture.managedRepoIds,
          })))
      ) {
        await rollbackPendingQuarantine({
          workspaceId: args.workspaceId,
          containerId: args.containerId,
          descriptor,
          definitions: repairDefinitions,
          canonicalPath,
          quarantinePath,
        });
      }
      descriptor = {
        ...descriptor,
        teardown: {
          ...descriptor.teardown,
          phase: 'verified',
          canonicalPath,
          quarantinePath,
          enteredAt: descriptor.teardown.enteredAt,
          quarantineIdentity: quarantineIdentity(await lstat(quarantinePath)),
        },
      };
      await persistStagedDescriptor(
        args.workspaceId,
        args.containerId,
        descriptor,
      );
      canonicalExists = false;
      quarantineExists = true;
    }
  }

  if (!descriptor.teardown) {
    canonicalExists = await pathExists(canonicalPath);
    quarantineExists = await pathExists(quarantinePath);
    if (!canonicalExists) {
      throw new Error('The worktree disappeared before it could be archived.');
    }
    if (quarantineExists) {
      throw new Error(
        `Archive quarantine already exists at ${quarantinePath}; preserve it for manual recovery.`,
      );
    }
    const enteredAt = new Date().toISOString();
    const branchDeletionTargets = requestedBranchDeletionMode
      ? await buildBranchDeletionTargets(descriptor.repositories)
      : undefined;
    descriptor = {
      ...descriptor,
      teardown: {
        phase: 'quarantine-pending',
        canonicalPath,
        quarantinePath,
        enteredAt,
        ...(branchDeletionTargets
          ? {
              branchDeletionTargets,
              pendingBranchDeletions: branchDeletionTargets,
              branchDeletionMode: requestedBranchDeletionMode,
            }
          : {}),
      },
    };
    await persistStagedDescriptor(
      args.workspaceId,
      args.containerId,
      descriptor,
    );
    const moved = await archiveIoExecutor({
      version: 1,
      type: 'prepare-teardown',
      requestId: randomUUID(),
      operationId: `archive:${args.workspaceId}:${args.containerId}:prepare-teardown`,
      projectId: args.workspaceId,
      containerId: args.containerId,
      expectedCreatedAt: args.expectedCreatedAt ?? '1970-01-01T00:00:00.000Z',
      input: {
        canonicalPath,
        quarantinePath,
        expectedCanonicalRealPath: await realpath(canonicalPath),
      },
    });
    if (!moved.quarantineIdentity) {
      throw new Error('Archive teardown did not return quarantine identity.');
    }
    descriptor = {
      ...descriptor,
      teardown: {
        ...descriptor.teardown,
        phase: 'quarantine-pending',
        canonicalPath,
        quarantinePath,
        enteredAt,
        quarantineIdentity: moved.quarantineIdentity,
      },
    };
    await persistStagedDescriptor(
      args.workspaceId,
      args.containerId,
      descriptor,
    );
    await repairMovedWorktrees(repairDefinitions, quarantinePath);
    if (
      !(await snapshotsMatchAtPath({
        repositories: descriptor.repositories,
        rootPath: quarantinePath,
      })) ||
      (args.workspaceRootCapture !== undefined &&
        !(await workspaceRootPayloadMatchesAtPath({
          workspaceId: args.workspaceId,
          containerId: args.containerId,
          rootPath: quarantinePath,
          managedRepoIds: args.workspaceRootCapture.managedRepoIds,
        })))
    ) {
      await rollbackPendingQuarantine({
        workspaceId: args.workspaceId,
        containerId: args.containerId,
        descriptor,
        definitions: repairDefinitions,
        canonicalPath,
        quarantinePath,
      });
    }
    descriptor = {
      ...descriptor,
      teardown: {
        ...descriptor.teardown,
        phase: 'verified',
        canonicalPath,
        quarantinePath,
        enteredAt,
      },
    };
    await persistStagedDescriptor(
      args.workspaceId,
      args.containerId,
      descriptor,
    );
  }

  descriptor = await retainUnmanagedClonePayload({
    workspaceId: args.workspaceId,
    containerId: args.containerId,
    descriptor,
    quarantinePath,
    expectedCreatedAt: args.expectedCreatedAt,
  });
  if (args.deleteBranches === false) {
    descriptor = await clearPendingBranchDeletions(
      args.workspaceId,
      args.containerId,
      descriptor,
    );
  } else if (args.deleteBranches === true) {
    descriptor = await persistPendingBranchDeletions(
      args.workspaceId,
      args.containerId,
      descriptor,
      requestedBranchDeletionMode,
    );
  }

  return {
    canonicalPath,
    quarantinePath,
    alreadyRemoved: false,
    targets: await listArchivedContainerTeardownTargets(
      descriptor,
      canonicalPath,
      quarantinePath,
      getArchivedContainerWorkspaceRootDir(args.workspaceId, args.containerId),
    ),
    pendingBranchDeletions: descriptor.teardown?.pendingBranchDeletions ?? [],
    branchDeletionMode: descriptor.teardown?.branchDeletionMode,
  };
}

export async function completeArchivedContainerGitCapture(
  workspaceId: string,
  containerId: string,
): Promise<void> {
  await rm(getArchivedContainerGitStateStagedPath(workspaceId, containerId), {
    force: true,
  });
}

/** Releases only disposable, pre-teardown capture state for the janitor. */
export async function discardIncompleteArchivedGitCapture(
  workspaceId: string,
  containerId: string,
  options?: { allowMissingWorktree?: boolean },
): Promise<boolean> {
  const descriptor = await readArchivedGitStagedDescriptor(
    workspaceId,
    containerId,
  );
  if (!descriptor) return true;
  if (descriptor.status === 'ready' || descriptor.teardown) return false;
  const canonicalPath = resolve(
    getWorkspaceWorktreeDir(workspaceId, containerId),
  );
  if (
    !(await pathExists(canonicalPath)) &&
    options?.allowMissingWorktree !== true
  ) {
    return false;
  }
  const config = await readWorkspaceConfig(workspaceId);
  if (config.type !== 'single-repo' && config.type !== 'multi-repo') {
    return false;
  }
  const definitions = await resolveRepositoryDefinitions({
    workspaceId,
    workspaceType: config.type,
  });
  assertPartialStateMatchesDefinitions({
    workspaceId,
    containerId,
    repositories: descriptor.repositories,
    definitions,
  });
  await releaseArchivedGitState({
    version: 1,
    diffFormatVersion: 1,
    repositories: descriptor.repositories,
  });
  await completeArchivedContainerGitCapture(workspaceId, containerId);
  return true;
}

export async function assertArchivedGitStateRestorable(
  manifest: ArchivedContainerManifestV2,
): Promise<void> {
  assertArchivedGitStateManifestIdentity({
    workspaceId: manifest.projectId,
    containerId: manifest.id,
    workspaceType: manifest.workspaceType ?? 'single-repo',
    gitState: manifest.gitState,
    allowEmptyRepositories: manifest.restoreScope === 'workspace-root-only',
  });
  const definitions = await resolveRepositoryDefinitions({
    workspaceId: manifest.projectId,
    workspaceType: manifest.workspaceType ?? 'single-repo',
  });
  assertStateMatchesDefinitions({
    workspaceId: manifest.projectId,
    containerId: manifest.id,
    repositories: manifest.gitState.repositories,
    definitions,
    allowAdditionalDefinitions: true,
  });
  await validatePinnedRepositories(manifest.gitState.repositories);
}

export interface ArchivedContainerRestoreBaseBranches {
  /** Repo-specific base spellings accepted by worktree creation. */
  baseBranchesByRepo: Record<string, string>;
  /** User-facing warnings returned with an otherwise successful restore. */
  warnings: string[];
}

function restoreBaseBranchCandidates(
  branchName: string,
): Array<{ ref: string; createBranch: string }> {
  if (branchName.startsWith('refs/heads/')) {
    const localName = branchName.slice('refs/heads/'.length);
    return [{ ref: branchName, createBranch: localName }];
  }
  if (branchName.startsWith('refs/remotes/origin/')) {
    const remoteName = branchName.slice('refs/remotes/origin/'.length);
    return [{ ref: branchName, createBranch: `origin/${remoteName}` }];
  }
  if (branchName.startsWith('origin/')) {
    const remoteName = branchName.slice('origin/'.length);
    return [
      {
        ref: `refs/remotes/origin/${remoteName}`,
        createBranch: branchName,
      },
    ];
  }
  return [
    { ref: `refs/heads/${branchName}`, createBranch: branchName },
    {
      ref: `refs/remotes/origin/${branchName}`,
      createBranch: `origin/${branchName}`,
    },
  ];
}

/**
 * Selects only locally available base refs that still contain their captured
 * archive-time tip. No fetch is performed: a stale, deleted, or rewritten
 * branch falls back to the existing restore start point and produces a toast
 * warning after restore succeeds.
 */
export async function resolveArchivedContainerRestoreBaseBranches(
  manifest: ArchivedContainerManifestV2,
): Promise<ArchivedContainerRestoreBaseBranches> {
  const baseBranchesByRepo: Record<string, string> = {};
  const warnings: string[] = [];
  for (const repository of manifest.gitState.repositories) {
    const branchName = repository.comparisonBaseBranch?.trim();
    const commit = repository.baseBranchCommit;
    if (!branchName || !commit) {
      warnings.push(
        `No archived base branch was recorded for ${repository.repoName}. Restored that repository using the current project default; review its base branch.`,
      );
      continue;
    }
    let selected: string | undefined;
    for (const candidate of restoreBaseBranchCandidates(branchName)) {
      const currentTip = await readRef(
        repository.referenceRepoPath,
        candidate.ref,
      );
      if (!currentTip) continue;
      try {
        await runGit(repository.referenceRepoPath, [
          'merge-base',
          '--is-ancestor',
          commit,
          currentTip,
        ]);
        selected = candidate.createBranch;
        break;
      } catch {
        // The ref exists but was rewritten, or the archived tip is unavailable.
      }
    }
    if (selected) {
      baseBranchesByRepo[repository.repoId] = selected;
      continue;
    }
    warnings.push(
      `Base branch "${branchName}" for ${repository.repoName} no longer contains archived commit ${commit.slice(0, 8)}. Restored that repository using the current project default; review its base branch.`,
    );
  }
  return { baseBranchesByRepo, warnings };
}

/**
 * Validates purge targets without requiring refs that may already have been
 * released by an interrupted prior purge. Existing refs must still match the
 * immutable manifest; all repository paths and ref names are recomputed.
 */
export async function assertArchivedGitStatePurgeable(
  manifest: Pick<
    ArchivedContainerManifestV2,
    'projectId' | 'id' | 'workspaceType' | 'gitState' | 'restoreScope'
  >,
): Promise<void> {
  assertArchivedGitStateManifestIdentity({
    workspaceId: manifest.projectId,
    containerId: manifest.id,
    workspaceType: manifest.workspaceType,
    gitState: manifest.gitState,
    allowEmptyRepositories: manifest.restoreScope === 'workspace-root-only',
  });
  const definitions = await resolveRepositoryDefinitions({
    workspaceId: manifest.projectId,
    workspaceType: manifest.workspaceType,
  });
  assertStateMatchesDefinitions({
    workspaceId: manifest.projectId,
    containerId: manifest.id,
    repositories: manifest.gitState.repositories,
    definitions,
    allowAdditionalDefinitions: true,
  });
  for (const repository of manifest.gitState.repositories) {
    const existing = await readRef(
      repository.referenceRepoPath,
      repository.snapshotRef,
    );
    if (existing !== null && existing !== repository.worktreeSnapshotCommit) {
      throw new Error(
        `Archived Git ref ${repository.snapshotRef} points to an unexpected object.`,
      );
    }
  }
}

export async function restoreArchivedContainerGitState(args: {
  manifest: ArchivedContainerManifestV2;
  destinationId: string;
  destinationRootPath: string;
  preserveDescendantHead?: boolean;
}): Promise<void> {
  await assertArchivedGitStateRestorable(args.manifest);
  const expectedDestination = resolve(
    getWorkspaceWorktreeDir(args.manifest.projectId, args.destinationId),
  );
  if (resolve(args.destinationRootPath) !== expectedDestination) {
    throw new Error('Invalid archived Git restore destination.');
  }
  for (const repository of args.manifest.gitState.repositories) {
    const destinationRepoPath =
      repository.relativePath === '.'
        ? expectedDestination
        : join(expectedDestination, repository.relativePath);
    await restoreIndexAndWorkingTreeSnapshot({
      repoPath: destinationRepoPath,
      headCommit: repository.headCommit,
      indexSnapshotCommit: repository.indexSnapshotCommit,
      worktreeSnapshotCommit: repository.worktreeSnapshotCommit,
      preserveDescendantHead: args.preserveDescendantHead,
    });
  }
}

interface CachedArchiveChanges {
  key: string;
  workspaceId: string;
  containerId: string;
  fingerprint: string;
  files: ChangedFileInfo[];
  totalCount: number;
}

const changesCache = new Map<string, CachedArchiveChanges>();
interface ArchiveChangesGenerationEntry {
  workspaceId: string;
  containerId: string;
  token: symbol;
  controller: AbortController;
  promise: Promise<CachedArchiveChanges>;
}

const changesGenerationPromises = new Map<
  string,
  ArchiveChangesGenerationEntry
>();
const changesInvalidations = new Map<string, symbol>();
const changesOperations = new Map<string, Map<symbol, Promise<unknown>>>();

function changesContainerKey(workspaceId: string, containerId: string): string {
  return `${workspaceId}:${containerId}`;
}

function runArchivedChangesOperation<T>(
  workspaceId: string,
  containerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const containerKey = changesContainerKey(workspaceId, containerId);
  if (changesInvalidations.has(containerKey)) {
    return Promise.reject(
      new Error(
        'Archived Git changes are unavailable while this container is being purged.',
      ),
    );
  }
  const token = Symbol(containerKey);
  const promise = operation();
  const tracked = promise.finally(() => {
    const active = changesOperations.get(containerKey);
    active?.delete(token);
    if (active?.size === 0) changesOperations.delete(containerKey);
  });
  const active =
    changesOperations.get(containerKey) ?? new Map<symbol, Promise<unknown>>();
  active.set(token, tracked);
  changesOperations.set(containerKey, active);
  return tracked;
}

function archiveFingerprint(manifest: ArchivedContainerManifestV2): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: manifest.gitState.version,
        diffFormatVersion: manifest.gitState.diffFormatVersion,
        repositories: manifest.gitState.repositories.map((repository) => ({
          repoId: repository.repoId,
          comparisonBaseCommit: repository.comparisonBaseCommit,
          worktreeSnapshotCommit: repository.worktreeSnapshotCommit,
          snapshotRef: repository.snapshotRef,
        })),
      }),
    )
    .digest('hex');
}

function touchCache(entry: CachedArchiveChanges): CachedArchiveChanges {
  changesCache.delete(entry.key);
  changesCache.set(entry.key, entry);
  return entry;
}

function trimChangesCache(): void {
  const recordCount = (): number =>
    Array.from(changesCache.values()).reduce(
      (total, entry) => total + entry.files.length,
      0,
    );
  while (
    changesCache.size > ARCHIVE_CACHE_MAX_ENTRIES ||
    recordCount() > ARCHIVE_CACHE_MAX_RECORDS
  ) {
    const oldest = changesCache.keys().next().value;
    if (!oldest) return;
    changesCache.delete(oldest);
  }
}

function compareChangedFiles(
  left: ChangedFileInfo,
  right: ChangedFileInfo,
): number {
  return (
    (left.repoName ?? '').localeCompare(right.repoName ?? '') ||
    (left.repoId ?? '').localeCompare(right.repoId ?? '') ||
    left.path.localeCompare(right.path)
  );
}

async function generateArchiveChanges(
  manifest: ArchivedContainerManifestV2,
  fingerprint: string,
  signal: AbortSignal,
): Promise<CachedArchiveChanges> {
  const repositories = [...manifest.gitState.repositories].sort(
    (left, right) =>
      left.repoName.localeCompare(right.repoName) ||
      left.repoId.localeCompare(right.repoId),
  );
  const files: ChangedFileInfo[] = [];
  let totalCount = 0;
  for (const repository of repositories) {
    if (signal.aborted) {
      throw new Error(ARCHIVED_GIT_DIFF_CANCELLED_MESSAGE);
    }
    const remaining = Math.max(
      0,
      ARCHIVED_CONTAINER_CHANGES_MAX_EXPLORABLE_RECORDS - files.length,
    );
    const diff = await streamArchiveTreeDiff(
      repository.referenceRepoPath,
      repository.comparisonBaseCommit,
      repository.worktreeSnapshotCommit,
      remaining,
      signal,
    );
    totalCount += diff.totalCount;
    files.push(
      ...diff.files.map((file) => ({
        ...file,
        repoId: repository.repoId,
        repoName: repository.repoName,
      })),
    );
  }
  files.sort(compareChangedFiles);
  if (
    manifest.gitChanges.status === 'complete' &&
    manifest.gitChanges.fileCount !== totalCount
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      'Archived Git changed-file count differs from captured summary.',
      {
        workspaceId: manifest.projectId,
        containerId: manifest.id,
        captured: manifest.gitChanges.fileCount,
        computed: totalCount,
      },
    );
  }
  const key = `${manifest.projectId}:${manifest.id}:${fingerprint}`;
  return {
    key,
    workspaceId: manifest.projectId,
    containerId: manifest.id,
    fingerprint,
    files,
    totalCount,
  };
}

async function loadChangesManifest(
  workspaceId: string,
  containerId: string,
): Promise<ArchivedContainerManifestV2> {
  // Keep this local import to break the archived-containers <-> archived-git
  // module cycle while deferring archive-manifest loading until it is needed.
  const { readArchivedContainerManifest } =
    await import('./archived-containers');
  const manifest = await readArchivedContainerManifest(
    workspaceId,
    containerId,
  );
  if (manifest.version !== 2 || manifest.kind !== 'worktree') {
    throw new Error('Archived Git changes are unavailable for this container.');
  }
  if (manifest.restoredTo) {
    throw new Error(
      'Archived Git changes are unavailable after a partial restore.',
    );
  }
  return manifest;
}

async function getCachedArchiveChanges(
  manifest: ArchivedContainerManifestV2,
): Promise<CachedArchiveChanges> {
  if (
    changesInvalidations.has(
      changesContainerKey(manifest.projectId, manifest.id),
    )
  ) {
    throw new Error(
      'Archived Git changes are unavailable while this container is being purged.',
    );
  }
  await assertArchivedGitStateRestorable(manifest);
  const fingerprint = archiveFingerprint(manifest);
  const key = `${manifest.projectId}:${manifest.id}:${fingerprint}`;
  const cached = changesCache.get(key);
  if (cached) return touchCache(cached);
  const inFlight = changesGenerationPromises.get(key);
  if (inFlight) return inFlight.promise;
  const token = Symbol(key);
  const controller = new AbortController();
  const generated = generateArchiveChanges(
    manifest,
    fingerprint,
    controller.signal,
  )
    .then((entry) => {
      const current = changesGenerationPromises.get(key);
      if (!controller.signal.aborted && current?.token === token) {
        changesCache.set(key, entry);
        trimChangesCache();
      }
      return entry;
    })
    .finally(() => {
      if (changesGenerationPromises.get(key)?.token === token) {
        changesGenerationPromises.delete(key);
      }
    });
  changesGenerationPromises.set(key, {
    workspaceId: manifest.projectId,
    containerId: manifest.id,
    token,
    controller,
    promise: generated,
  });
  return generated;
}

interface ChangesCursor {
  version: 1;
  fingerprint: string;
  offset: number;
}

function encodeCursor(cursor: ChangesCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): ChangesCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid or stale archived changes cursor.');
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.fingerprint !== 'string' ||
    !Number.isInteger(parsed.offset) ||
    Number(parsed.offset) < 0
  ) {
    throw new Error('Invalid or stale archived changes cursor.');
  }
  const cursor: ChangesCursor = {
    version: parsed.version,
    fingerprint: parsed.fingerprint,
    offset: Number(parsed.offset),
  };
  return cursor;
}

function assertSafeArchivedPath(filePath: string): void {
  if (
    !filePath ||
    isAbsolute(filePath) ||
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    filePath.startsWith('\\\\') ||
    filePath.includes('\0') ||
    filePath
      .split(/[\\/]+/)
      .some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid archived file path.');
  }
}

async function listArchivedContainerChangesInternal(
  request: ArchivedContainerListChangesRequest,
): Promise<ArchivedContainerListChangesResponse> {
  const limit = request.limit ?? ARCHIVED_CONTAINER_CHANGES_DEFAULT_PAGE_SIZE;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > ARCHIVED_CONTAINER_CHANGES_MAX_PAGE_SIZE
  ) {
    throw new Error('Invalid archived changes page size.');
  }
  const manifest = await loadChangesManifest(
    request.projectId,
    request.containerId,
  );
  const entry = await getCachedArchiveChanges(manifest);
  let offset = 0;
  if (request.cursor) {
    const cursor = decodeCursor(request.cursor);
    if (
      cursor.fingerprint !== entry.fingerprint ||
      cursor.offset > entry.files.length
    ) {
      throw new Error('Invalid or stale archived changes cursor.');
    }
    offset = cursor.offset;
  }
  const files = entry.files.slice(offset, offset + limit);
  const nextOffset = offset + files.length;
  return {
    files,
    totalCount: entry.totalCount,
    nextCursor:
      nextOffset < entry.files.length
        ? encodeCursor({
            version: 1,
            fingerprint: entry.fingerprint,
            offset: nextOffset,
          })
        : null,
    truncated:
      entry.totalCount > ARCHIVED_CONTAINER_CHANGES_MAX_EXPLORABLE_RECORDS,
  };
}

export function listArchivedContainerChanges(
  request: ArchivedContainerListChangesRequest,
): Promise<ArchivedContainerListChangesResponse> {
  return runArchivedChangesOperation(
    request.projectId,
    request.containerId,
    () => listArchivedContainerChangesInternal(request),
  );
}

async function readArchivedContainerChangeDiffInternal(
  request: ArchivedContainerReadChangeDiffRequest,
): Promise<ArchivedContainerReadChangeDiffResponse> {
  assertSafeArchivedPath(request.filePath);
  validateRepoId(request.repoId);
  const manifest = await loadChangesManifest(
    request.projectId,
    request.containerId,
  );
  const entry = await getCachedArchiveChanges(manifest);
  const file = entry.files.find(
    (candidate) =>
      candidate.repoId === request.repoId &&
      candidate.path === request.filePath,
  );
  if (!file) {
    throw new Error(
      'The requested file is not part of this archived change set.',
    );
  }
  const repository = manifest.gitState.repositories.find(
    (candidate) => candidate.repoId === request.repoId,
  );
  if (!repository) throw new Error('Unknown archived repository.');
  const diff = await getFileDiffBetweenTreesWithPaths(
    repository.referenceRepoPath,
    file.previousPath ?? file.path,
    file.path,
    repository.comparisonBaseCommit,
    repository.worktreeSnapshotCommit,
    { disableReplaceObjects: true, disableTextconv: true },
  );
  return {
    ...diff,
    filePath: file.path,
    source: 'combined',
  };
}

export function readArchivedContainerChangeDiff(
  request: ArchivedContainerReadChangeDiffRequest,
): Promise<ArchivedContainerReadChangeDiffResponse> {
  return runArchivedChangesOperation(
    request.projectId,
    request.containerId,
    () => readArchivedContainerChangeDiffInternal(request),
  );
}

export async function invalidateArchivedContainerChanges(
  workspaceId: string,
  containerId: string,
  options?: { hold?: boolean },
): Promise<() => void> {
  const containerKey = changesContainerKey(workspaceId, containerId);
  const invalidationToken = Symbol(containerKey);
  changesInvalidations.set(containerKey, invalidationToken);
  const resume = (): void => {
    if (changesInvalidations.get(containerKey) === invalidationToken) {
      changesInvalidations.delete(containerKey);
    }
  };
  try {
    const removed: ArchiveChangesGenerationEntry[] = [];
    changesGenerationPromises.forEach((entry, key) => {
      if (
        entry.workspaceId === workspaceId &&
        entry.containerId === containerId
      ) {
        changesGenerationPromises.delete(key);
        entry.controller.abort();
        removed.push(entry);
      }
    });
    const active = Array.from(
      changesOperations.get(containerKey)?.values() ?? [],
    );
    await Promise.allSettled([
      ...removed.map((entry) => entry.promise),
      ...active,
    ]);
    changesCache.forEach((entry, key) => {
      if (
        entry.workspaceId === workspaceId &&
        entry.containerId === containerId
      ) {
        changesCache.delete(key);
      }
    });
    return resume;
  } finally {
    if (!options?.hold) resume();
  }
}

export function getArchivedContainerChangesService(): {
  listChanges: typeof listArchivedContainerChanges;
  readChangeDiff: typeof readArchivedContainerChangeDiff;
} {
  return {
    listChanges: listArchivedContainerChanges,
    readChangeDiff: readArchivedContainerChangeDiff,
  };
}

function assertPartialStateMatchesDefinitions(args: {
  workspaceId: string;
  containerId: string;
  repositories: ArchivedGitRepositoryState[];
  definitions: ArchivedRepositoryDefinition[];
}): void {
  const definitionsById = new Map(
    args.definitions.map((definition) => [definition.repoId, definition]),
  );
  const seen = new Set<string>();
  for (const repository of args.repositories) {
    const definition = definitionsById.get(repository.repoId);
    if (
      seen.has(repository.repoId) ||
      !definition ||
      resolve(repository.referenceRepoPath) !== definition.referenceRepoPath ||
      repository.relativePath !== definition.relativePath ||
      repository.snapshotRef !==
        buildArchivedContainerSnapshotRef(
          args.workspaceId,
          args.containerId,
          repository.repoId,
        )
    ) {
      throw new Error('Archived Git staged state failed integrity validation.');
    }
    seen.add(repository.repoId);
  }
}

async function finishVerifiedTeardown(args: {
  workspaceId: string;
  containerId: string;
  descriptor: ArchivedGitStagedDescriptor;
  canonicalPath: string;
  quarantinePath: string;
}): Promise<void> {
  const descriptor = await retainUnmanagedClonePayload(args);
  // Validate retained dependencies while every link is still observable. If
  // cleanup ran first, a junction introduced after the receipt was written
  // could disappear before the dependency check and let recovery delete the
  // quarantine instead of preserving it for attention.
  const targets = await listArchivedContainerTeardownTargets(
    descriptor,
    args.canonicalPath,
    args.quarantinePath,
    getArchivedContainerWorkspaceRootDir(args.workspaceId, args.containerId),
  );
  // Once validation succeeds, fail closed before the registered-worktree
  // removal below can traverse a Windows directory junction. The shared
  // removal helper repeats this check for each registered worktree.
  await removeWindowsWorktreeReparsePoints(args.quarantinePath);
  targets.sort((left, right) =>
    resolve(left.quarantineRepoPath) === resolve(args.quarantinePath)
      ? 1
      : resolve(right.quarantineRepoPath) === resolve(args.quarantinePath)
        ? -1
        : 0,
  );
  for (const target of targets) {
    const registeredWorktrees = await runGit(target.referenceRepoPath, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ]);
    const resolvedQuarantineRepoPath = await realpath(
      target.quarantineRepoPath,
    ).catch(() => resolve(target.quarantineRepoPath));
    let isRegistered = false;
    for (const line of registeredWorktrees.split('\0')) {
      if (!line.startsWith('worktree ')) continue;
      const listedPath = line.slice('worktree '.length);
      const resolvedListedPath = await realpath(listedPath).catch(() =>
        resolve(listedPath),
      );
      if (resolvedListedPath === resolvedQuarantineRepoPath) {
        isRegistered = true;
        break;
      }
    }
    if (isRegistered && (await pathExists(target.quarantineRepoPath))) {
      await archiveIoExecutor({
        version: 1,
        type: 'remove-worktree',
        requestId: randomUUID(),
        operationId: `archive:${args.workspaceId}:${args.containerId}:recover-remove-worktree:${target.repoId}`,
        projectId: args.workspaceId,
        containerId: args.containerId,
        expectedCreatedAt: '1970-01-01T00:00:00.000Z',
        input: {
          git: archiveGitEnvironment(
            await getResolvedGitExecutableForSpawn(process.env),
          ),
          referenceRepoPath: target.referenceRepoPath,
          expectedRepositoryIdentity: await realpath(
            await getGitCommonDir(target.referenceRepoPath),
          ),
          worktreePath: target.quarantineRepoPath,
        },
      });
    }
    await removeAbsentWorktreeRegistrations(
      await getGitCommonDir(target.referenceRepoPath),
      [target.quarantineRepoPath, target.preMoveRepoPath],
    );
  }
  await removeWindowsWorktreeReparsePoints(args.quarantinePath);
  await removeTreeWithoutAsar(args.quarantinePath, {
    recursive: true,
    force: true,
  });
}

async function continueRecoveredArchive(args: {
  workspaceId: string;
  containerId: string;
  workspaceType: 'single-repo' | 'multi-repo';
  preserveBranches: boolean;
}): Promise<void> {
  // Re-enter the normal archive orchestration so the ready descriptor is
  // reused and the already-completed teardown advances through payload
  // relocation, version-2 manifest commit, and descriptor cleanup. The
  // dynamic import avoids the worktree-service -> archived-git module cycle.
  const worktreeService = await import('./worktree-service');
  const response =
    args.workspaceType === 'single-repo'
      ? await worktreeService.archiveSingleRepoWorktree({
          archiveTrigger: 'internal-rollback',
          workspaceId: args.workspaceId,
          worktreeId: args.containerId,
          retainAsArchivedContainer: true,
          ...(args.preserveBranches ? { deleteBranch: false } : {}),
        })
      : await worktreeService.archiveMultiRepoWorktree({
          archiveTrigger: 'internal-rollback',
          workspaceId: args.workspaceId,
          worktreeId: args.containerId,
          retainAsArchivedContainer: true,
          ...(args.preserveBranches ? { deleteBranch: false } : {}),
        });
  if (!response.success) {
    throw new Error('Recovered archive continuation failed.');
  }
}

/** Best-effort startup recovery for journals interrupted during quarantine. */
export async function recoverArchivedGitTeardownsForWorkspace(
  workspaceId: string,
): Promise<void> {
  // Intentional local import breaks the Git/recovery initialization cycle;
  // build:e2e verifies this module resolves in packaged Electron main bytecode.
  const { recoverArchivedFileTeardownsForWorkspace } =
    await import('./archived-container-recovery');
  await recoverArchivedFileTeardownsForWorkspace(workspaceId);
  const config = await readWorkspaceConfig(workspaceId);
  if (config.type !== 'single-repo' && config.type !== 'multi-repo') return;
  const definitions = await resolveRepositoryDefinitions({
    workspaceId,
    workspaceType: config.type,
  });
  let entries;
  try {
    entries = await readdir(getArchivedContainersRootDir(workspaceId), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      validateId(entry.name, 'containerId');
      await assertNoDestructiveRecovery(workspaceId, entry.name, true);
      let descriptor = await readArchivedGitStagedDescriptor(
        workspaceId,
        entry.name,
      );
      if (!descriptor?.teardown) continue;
      await refuseInterruptedArchiveJournal(
        workspaceId,
        entry.name,
        'staged-git-teardown',
      );
      assertPartialStateMatchesDefinitions({
        workspaceId,
        containerId: entry.name,
        repositories: descriptor.repositories,
        definitions,
      });
      const canonicalPath = resolve(
        getWorkspaceWorktreeDir(workspaceId, entry.name),
      );
      const quarantinePath = quarantinePathFor(canonicalPath);
      if (
        resolve(descriptor.teardown.canonicalPath) !== canonicalPath ||
        resolve(descriptor.teardown.quarantinePath) !== quarantinePath
      ) {
        throw new Error(
          'Archived Git recovery paths failed integrity validation.',
        );
      }
      const [canonicalExists, quarantineExists] = await Promise.all([
        pathExists(canonicalPath),
        pathExists(quarantinePath),
      ]);
      if (descriptor.teardown.phase === 'verified') {
        if (descriptor.status !== 'ready') {
          // Incomplete legacy descriptors may retain a verified journal. Keep
          // their quarantine and recovery material intact until recapture can
          // produce the metadata required to commit a version-2 archive.
          continue;
        }
        // A verified journal has crossed the irreversible boundary. Never
        // touch a recreated canonical occupant; finish only the recomputed
        // quarantine target and stale Git worktree registrations.
        if (quarantineExists) {
          await finishVerifiedTeardown({
            workspaceId,
            containerId: entry.name,
            descriptor,
            canonicalPath,
            quarantinePath,
          });
        }
        await continueRecoveredArchive({
          workspaceId,
          containerId: entry.name,
          workspaceType: config.type,
          preserveBranches: descriptor.teardown?.preserveBranches === true,
        });
        continue;
      }
      if (canonicalExists && !quarantineExists) {
        const { teardown: _teardown, ...capture } = descriptor;
        void _teardown;
        await persistStagedDescriptor(workspaceId, entry.name, capture);
        continue;
      }
      if (!canonicalExists && quarantineExists) {
        if (descriptor.status !== 'ready') {
          // Incomplete descriptors keep the quarantine as recovery material
          // until recapture can produce a commit-ready archive.
          continue;
        }
        const repairDefinitions = capturedRepositoryDefinitions(
          definitions,
          descriptor.repositories,
        );
        await repairMovedWorktrees(repairDefinitions, quarantinePath);
        if (
          !(await snapshotsMatchAtPath({
            repositories: descriptor.repositories,
            rootPath: quarantinePath,
          }))
        ) {
          await rollbackPendingQuarantine({
            workspaceId,
            containerId: entry.name,
            descriptor,
            definitions: repairDefinitions,
            canonicalPath,
            quarantinePath,
          });
        }
        descriptor = {
          ...descriptor,
          teardown: { ...descriptor.teardown, phase: 'verified' },
        };
        await persistStagedDescriptor(workspaceId, entry.name, descriptor);
        await finishVerifiedTeardown({
          workspaceId,
          containerId: entry.name,
          descriptor,
          canonicalPath,
          quarantinePath,
        });
        await continueRecoveredArchive({
          workspaceId,
          containerId: entry.name,
          workspaceType: config.type,
          preserveBranches: descriptor.teardown?.preserveBranches === true,
        });
        continue;
      }
      throw new Error(
        canonicalExists
          ? `Both the canonical worktree and quarantine exist at ${quarantinePath}.`
          : 'Neither the canonical worktree nor quarantine exists.',
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Archived Git teardown recovery requires attention.', {
        workspaceId,
        containerId: entry.name,
        error,
      });
    }
  }
}

/**
 * Removes only refs proven orphaned inside this workspace's namespace. A
 * corrupt manifest/descriptor aborts reconciliation conservatively; no GC is
 * run because other archives may share the object database.
 */
export async function reconcileArchivedGitRefsForWorkspace(
  workspaceId: string,
): Promise<void> {
  // Check only the workspace-level record here. Container records are
  // isolated below so one flagged archive cannot stop sibling ref pruning.
  await assertNoDestructiveRecovery(workspaceId, '', true);
  const config = await readWorkspaceConfig(workspaceId);
  if (config.type !== 'single-repo' && config.type !== 'multi-repo') return;
  const definitions = await resolveRepositoryDefinitions({
    workspaceId,
    workspaceType: config.type,
  });
  // Lifecycle evidence can outlive both the child's row and archive directory.
  const lifecycleProtectedPrefixes = new Set<string>();
  for (const record of await readWorkspaceDestructiveRecoveries(workspaceId)) {
    if (
      record.worktreeId === undefined ||
      (record.state === 'completed' && !record.cleanupRequired)
    )
      continue;
    validateId(record.worktreeId, 'containerId');
    lifecycleProtectedPrefixes.add(
      `${ARCHIVE_REF_NAMESPACE}/${workspaceId}/${record.worktreeId}/`,
    );
  }
  const keepByRepoPath = new Map<string, Set<string>>();
  const protectedPrefixesByRepoPath = new Map<string, Set<string>>();
  for (const definition of definitions) {
    keepByRepoPath.set(definition.referenceRepoPath, new Set());
    protectedPrefixesByRepoPath.set(
      definition.referenceRepoPath,
      new Set(lifecycleProtectedPrefixes),
    );
  }
  // Keep this local import to break the archived-containers <-> archived-git
  // module cycle; reconciliation itself runs in packaged Electron builds.
  const { listArchivedContainerManifests } =
    await import('./archived-containers');
  const manifests = await listArchivedContainerManifests(workspaceId);
  const manifestsById = new Map(
    manifests.map((manifest) => [manifest.id, manifest]),
  );
  let entries;
  try {
    entries = await readdir(getArchivedContainersRootDir(workspaceId), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // An unaddressable directory cannot be mapped to a safe archive-ref
    // namespace. Abort before pruning anything in this workspace.
    validateId(entry.name, 'containerId');
    try {
      await assertNoDestructiveRecovery(workspaceId, entry.name, true);
      await assertNoLegacyArchiveRecovery(workspaceId, entry.name);
      if (
        await pathExists(
          getArchivedContainerManifestPath(workspaceId, entry.name),
        )
      ) {
        const manifest = manifestsById.get(entry.name);
        if (!manifest) {
          throw new Error(
            'A corrupt archived container prevents safe ref reconciliation.',
          );
        }
        if (manifest.version === 2) {
          assertStateMatchesDefinitions({
            workspaceId,
            containerId: entry.name,
            repositories: manifest.gitState.repositories,
            definitions,
            allowAdditionalDefinitions: manifest.workspaceType === 'multi-repo',
          });
          for (const repository of manifest.gitState.repositories) {
            keepByRepoPath
              .get(resolve(repository.referenceRepoPath))
              ?.add(repository.snapshotRef);
          }
        }
      }
      const descriptor = await readArchivedGitStagedDescriptor(
        workspaceId,
        entry.name,
      );
      if (descriptor) {
        assertPartialStateMatchesDefinitions({
          workspaceId,
          containerId: entry.name,
          repositories: descriptor.repositories,
          definitions,
        });
        for (const repository of descriptor.repositories) {
          keepByRepoPath
            .get(resolve(repository.referenceRepoPath))
            ?.add(repository.snapshotRef);
        }
        // The capture worker pins each ref before publishing it here, so an
        // unfinished capture may own refs it never lists. A completed archive
        // can retain such a capture (CAN-3039); keep its whole namespace.
        if (descriptor.status === 'capturing') {
          const protectedPrefix = `${ARCHIVE_REF_NAMESPACE}/${workspaceId}/${entry.name}/`;
          for (const prefixes of Array.from(
            protectedPrefixesByRepoPath.values(),
          )) {
            prefixes.add(protectedPrefix);
          }
        }
      }
    } catch (error) {
      // One flagged/corrupt archive is retained for manual repair; sibling
      // archives remain eligible for reference pruning.
      const manifest = manifestsById.get(entry.name);
      const protectedPrefix = `${ARCHIVE_REF_NAMESPACE}/${workspaceId}/${entry.name}/`;
      for (const prefixes of Array.from(protectedPrefixesByRepoPath.values())) {
        prefixes.add(protectedPrefix);
      }
      if (manifest?.version === 2) {
        for (const repository of manifest.gitState.repositories) {
          keepByRepoPath
            .get(resolve(repository.referenceRepoPath))
            ?.add(repository.snapshotRef);
        }
      }
      // eslint-disable-next-line no-console
      console.warn('Skipping archived Git ref reconciliation for container.', {
        workspaceId,
        containerId: entry.name,
        error,
      });
    }
  }

  const prefix = `${ARCHIVE_REF_NAMESPACE}/${workspaceId}/`;
  for (const [repoPath, keep] of Array.from(keepByRepoPath.entries())) {
    const refs = (
      await runGit(repoPath, [
        'for-each-ref',
        '--format=%(refname)',
        `${ARCHIVE_REF_NAMESPACE}/${workspaceId}`,
      ])
    )
      .split('\n')
      .map((ref) => ref.trim())
      .filter((ref) => ref.startsWith(prefix));
    for (const ref of refs) {
      const protectedPrefixes = protectedPrefixesByRepoPath.get(repoPath);
      if (
        !keep.has(ref) &&
        !(
          protectedPrefixes !== undefined &&
          Array.from(protectedPrefixes).some((prefix) => ref.startsWith(prefix))
        )
      )
        await runGit(repoPath, ['update-ref', '-d', ref]);
    }
  }
}
