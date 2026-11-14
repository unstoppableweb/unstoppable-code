import type {
  ArchivedContainerDiskUsage,
  ArchivedContainerManifest,
  ArchivedContainerManifestBase,
  ArchivedContainerSummary,
  ArchivedContainerSummaryBase,
  ArchivedGitBaseBranchSummary,
  ArchivedGitChangesSummary,
  ArchivedGitRepositoryState,
  ArchivedGitState,
  ArchivedPullRequestCapture,
  ArchivedPullRequestMetadata,
  ArchivedPullRequestRepositoryCapture,
} from '../types';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const GIT_OBJECT_ID_RE = /^[0-9a-f]{40,64}$/;
const ARCHIVED_GIT_REF_PREFIX = 'refs/app/archived-containers';

/** Both pre-generation archives and isolated captures remain readable. */
export function isArchivedGitSnapshotRef(
  workspaceId: string,
  containerId: string,
  repoId: string,
  ref: string,
): boolean {
  const prefix = `${ARCHIVED_GIT_REF_PREFIX}/${workspaceId}/${containerId}/`;
  if (ref === `${prefix}${repoId}`) return true;
  if (!ref.startsWith(`${prefix}__generations__/`)) return false;
  const suffix = ref.slice(`${prefix}__generations__/`.length).split('/');
  return (
    suffix.length === 2 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      suffix[0] ?? '',
    ) &&
    suffix[1] === repoId
  );
}

function isArchivedContainerKind(
  value: unknown,
): value is 'worktree' | 'work-entry' {
  return value === 'worktree' || value === 'work-entry';
}

function isRestoredTo(
  value: unknown,
): value is NonNullable<ArchivedContainerManifestBase['restoredTo']> {
  return (
    isRecord(value) &&
    isArchivedContainerKind(value.kind) &&
    isNonEmptyString(value.id) &&
    isIsoDate(value.restoredAt) &&
    (value.createdAt === undefined || isIsoDate(value.createdAt))
  );
}

function isRecoveryRestoreStaging(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.kind === 'worktree' &&
    typeof value.id === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(value.id) &&
    isIsoDate(value.createdAt)
  );
}

function isArchivedContainerDiskUsage(
  value: unknown,
): value is ArchivedContainerDiskUsage {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.filesBytes) &&
    isNonNegativeInteger(value.gitBytes) &&
    (value.gitBytesComplete === undefined ||
      typeof value.gitBytesComplete === 'boolean') &&
    isNonNegativeInteger(value.totalBytes) &&
    value.totalBytes === Number(value.filesBytes) + Number(value.gitBytes) &&
    isIsoDate(value.computedAt)
  );
}

function hasValidManifestBase(value: UnknownRecord): boolean {
  return (
    isNonEmptyString(value.id) &&
    (value.diskUsage === undefined ||
      isArchivedContainerDiskUsage(value.diskUsage)) &&
    isNonEmptyString(value.projectId) &&
    isNonEmptyString(value.name) &&
    isOptionalString(value.label) &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.archivedAt) &&
    Number.isInteger(value.retentionDays) &&
    Number(value.retentionDays) >= 1 &&
    isIsoDate(value.expiresAt) &&
    (value.lockedAt === undefined || isIsoDate(value.lockedAt)) &&
    isNonNegativeInteger(value.chatCount) &&
    isNonNegativeInteger(value.archivedChatCount) &&
    isNonNegativeInteger(value.executionCount) &&
    (value.executionRestorePending === undefined ||
      typeof value.executionRestorePending === 'boolean') &&
    isOptionalString(value.branchName) &&
    (value.workspaceType === undefined ||
      value.workspaceType === 'single-repo' ||
      value.workspaceType === 'multi-repo') &&
    (value.restoreScope === undefined ||
      value.restoreScope === 'workspace-root-only') &&
    (value.restoredTo === undefined || isRestoredTo(value.restoredTo))
  );
}

function isArchivedGitRepositoryState(
  value: unknown,
): value is ArchivedGitRepositoryState {
  return (
    isRecord(value) &&
    isNonEmptyString(value.repoId) &&
    isNonEmptyString(value.repoName) &&
    typeof value.relativePath === 'string' &&
    isNonEmptyString(value.referenceRepoPath) &&
    isOptionalString(value.branchName) &&
    isOptionalString(value.comparisonBaseBranch) &&
    (value.baseBranchCommit === undefined ||
      (typeof value.comparisonBaseBranch === 'string' &&
        typeof value.baseBranchCommit === 'string' &&
        GIT_OBJECT_ID_RE.test(value.baseBranchCommit))) &&
    typeof value.comparisonBaseCommit === 'string' &&
    GIT_OBJECT_ID_RE.test(value.comparisonBaseCommit) &&
    typeof value.headCommit === 'string' &&
    GIT_OBJECT_ID_RE.test(value.headCommit) &&
    typeof value.indexSnapshotCommit === 'string' &&
    GIT_OBJECT_ID_RE.test(value.indexSnapshotCommit) &&
    typeof value.worktreeSnapshotCommit === 'string' &&
    GIT_OBJECT_ID_RE.test(value.worktreeSnapshotCommit) &&
    isNonEmptyString(value.snapshotRef)
  );
}

function isArchivedGitState(
  value: unknown,
  options: { allowEmptyRepositories?: boolean } = {},
): value is ArchivedGitState {
  if (
    isRecord(value) &&
    value.version === 1 &&
    value.diffFormatVersion === 1 &&
    Array.isArray(value.repositories) &&
    (value.repositories.length > 0 ||
      options.allowEmptyRepositories === true) &&
    value.repositories.every(isArchivedGitRepositoryState)
  ) {
    const repoIds = value.repositories.map((repository) => repository.repoId);
    const refs = value.repositories.map((repository) => repository.snapshotRef);
    return (
      new Set(repoIds).size === repoIds.length &&
      new Set(refs).size === refs.length
    );
  }
  return false;
}

function isArchivedGitChangesSummary(
  value: unknown,
): value is ArchivedGitChangesSummary {
  if (!isRecord(value) || !isIsoDate(value.capturedAt)) return false;
  if (value.status === 'unavailable') return true;
  return (
    value.status === 'complete' &&
    isNonNegativeInteger(value.fileCount) &&
    isNonNegativeInteger(value.insertions) &&
    isNonNegativeInteger(value.deletions) &&
    Array.isArray(value.repositories) &&
    value.repositories.every(
      (repository) =>
        isRecord(repository) &&
        isNonEmptyString(repository.repoId) &&
        isNonEmptyString(repository.repoName) &&
        isNonNegativeInteger(repository.fileCount) &&
        isNonNegativeInteger(repository.insertions) &&
        isNonNegativeInteger(repository.deletions),
    )
  );
}

function isArchivedPullRequestState(
  value: unknown,
): value is ArchivedPullRequestMetadata['state'] {
  return (
    value === 'open' ||
    value === 'draft' ||
    value === 'closed' ||
    value === 'merged'
  );
}

function isMatchingGitHubPullRequestUrl(
  value: unknown,
  pullRequestNumber: number,
): value is string {
  if (typeof value !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const pathMatch = /^\/[^/]+\/[^/]+\/pull\/([1-9][0-9]*)$/.exec(
    parsed.pathname,
  );
  return (
    parsed.protocol === 'https:' &&
    parsed.host === 'github.com' &&
    parsed.username === '' &&
    parsed.password === '' &&
    pathMatch?.[1] === String(pullRequestNumber)
  );
}

function isArchivedPullRequestMetadata(
  value: unknown,
): value is ArchivedPullRequestMetadata {
  return (
    isRecord(value) &&
    isPositiveInteger(value.number) &&
    isMatchingGitHubPullRequestUrl(value.url, value.number) &&
    isNonBlankString(value.title) &&
    isArchivedPullRequestState(value.state) &&
    (value.baseRefName === undefined || isNonBlankString(value.baseRefName)) &&
    isIsoDate(value.updatedAt)
  );
}

function isArchivedPullRequestRepositoryCapture(
  value: unknown,
): value is ArchivedPullRequestRepositoryCapture {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.repoId) ||
    !isNonEmptyString(value.repoName)
  ) {
    return false;
  }
  if (value.status === 'unavailable') {
    return !hasOwn(value, 'pullRequest');
  }
  return (
    value.status === 'complete' &&
    hasOwn(value, 'pullRequest') &&
    (value.pullRequest === null ||
      isArchivedPullRequestMetadata(value.pullRequest))
  );
}

function isArchivedPullRequestCapture(
  value: unknown,
  gitState: ArchivedGitState,
): value is ArchivedPullRequestCapture {
  if (
    !isRecord(value) ||
    !isIsoDate(value.capturedAt) ||
    !Array.isArray(value.repositories) ||
    !value.repositories.every(isArchivedPullRequestRepositoryCapture)
  ) {
    return false;
  }
  const repositoryIds = value.repositories.map(
    (repository) => repository.repoId,
  );
  const stateRepositoriesById = new Map(
    gitState.repositories.map((repository) => [repository.repoId, repository]),
  );
  return (
    new Set(repositoryIds).size === repositoryIds.length &&
    repositoryIds.length === gitState.repositories.length &&
    repositoryIds.every((repoId) => stateRepositoriesById.has(repoId)) &&
    value.repositories.every(
      (repository) =>
        stateRepositoriesById.get(repository.repoId)?.repoName ===
        repository.repoName,
    )
  );
}

/** Runtime validator for both persisted archive-manifest versions. */
export function isArchivedContainerManifest(
  value: unknown,
): value is ArchivedContainerManifest {
  if (!isRecord(value) || !hasValidManifestBase(value)) return false;
  if (value.version === 1) return isArchivedContainerKind(value.kind);
  if (value.version === 3) {
    return (
      value.kind === 'worktree' &&
      (value.workspaceType === 'single-repo' ||
        value.workspaceType === 'multi-repo') &&
      isRecord(value.originalWorktree) &&
      value.originalWorktree.id === value.id &&
      isIsoDate(value.originalWorktree.createdAt) &&
      value.originalWorktree.createdAt === value.createdAt &&
      isNonEmptyString(value.originalWorktree.branchName) &&
      value.originalEntry === undefined &&
      value.gitState === undefined &&
      (value.restoreStaging === undefined ||
        isRecoveryRestoreStaging(value.restoreStaging)) &&
      isRecord(value.recovery) &&
      value.recovery.kind === 'files-only' &&
      (value.recovery.source === 'retained' ||
        value.recovery.source === 'partial' ||
        value.recovery.source === 'absent') &&
      typeof value.recovery.digest === 'string' &&
      /^[a-f0-9]{64}$/.test(value.recovery.digest) &&
      (value.recovery.gitCleanupPending === undefined ||
        typeof value.recovery.gitCleanupPending === 'boolean') &&
      typeof value.recovery.payloadId === 'string' &&
      /^[a-f0-9-]{36}$/.test(value.recovery.payloadId)
    );
  }
  if (
    value.version !== 2 ||
    value.kind !== 'worktree' ||
    (value.workspaceType !== 'single-repo' &&
      value.workspaceType !== 'multi-repo') ||
    !isRecord(value.originalWorktree) ||
    value.originalWorktree.id !== value.id ||
    !isNonEmptyString(value.originalWorktree.branchName) ||
    !isIsoDate(value.originalWorktree.createdAt) ||
    value.originalEntry !== undefined ||
    !isArchivedGitState(value.gitState, {
      allowEmptyRepositories: value.restoreScope === 'workspace-root-only',
    }) ||
    !isArchivedGitChangesSummary(value.gitChanges) ||
    !isArchivedPullRequestCapture(value.pullRequestMetadata, value.gitState)
  ) {
    return false;
  }
  const repositories = value.gitState.repositories;
  for (const repository of repositories) {
    const expectedRelativePath =
      repository.repoId === '__single_repo__' ||
      repository.repoId === '__workspace_root__'
        ? '.'
        : `repos/${repository.repoId}`;
    if (
      repository.relativePath !== expectedRelativePath ||
      !isArchivedGitSnapshotRef(
        String(value.projectId),
        String(value.id),
        repository.repoId,
        repository.snapshotRef,
      )
    ) {
      return false;
    }
  }
  if (
    value.workspaceType === 'single-repo' &&
    (repositories.length !== 1 || repositories[0]?.repoId !== '__single_repo__')
  ) {
    return false;
  }
  if (
    value.workspaceType === 'multi-repo' &&
    repositories.some((repository) => repository.repoId === '__single_repo__')
  ) {
    return false;
  }
  if (value.gitChanges.status === 'complete') {
    const changeIds = value.gitChanges.repositories.map(
      (repository) => repository.repoId,
    );
    const stateIds = repositories.map((repository) => repository.repoId);
    const changesById = new Map(
      value.gitChanges.repositories.map((repository) => [
        repository.repoId,
        repository,
      ]),
    );
    if (
      new Set(changeIds).size !== changeIds.length ||
      changeIds.length !== stateIds.length ||
      stateIds.some((repoId) => !changeIds.includes(repoId)) ||
      repositories.some(
        (repository) =>
          changesById.get(repository.repoId)?.repoName !== repository.repoName,
      ) ||
      value.gitChanges.fileCount !==
        value.gitChanges.repositories.reduce(
          (total, repository) => total + repository.fileCount,
          0,
        ) ||
      value.gitChanges.insertions !==
        value.gitChanges.repositories.reduce(
          (total, repository) => total + repository.insertions,
          0,
        ) ||
      value.gitChanges.deletions !==
        value.gitChanges.repositories.reduce(
          (total, repository) => total + repository.deletions,
          0,
        )
    ) {
      return false;
    }
  }
  return true;
}

function toSummaryBase(
  manifest: ArchivedContainerManifest,
): ArchivedContainerSummaryBase {
  return {
    id: manifest.id,
    projectId: manifest.projectId,
    name: manifest.name,
    ...(manifest.label !== undefined ? { label: manifest.label } : {}),
    createdAt: manifest.createdAt,
    archivedAt: manifest.archivedAt,
    retentionDays: manifest.retentionDays,
    expiresAt: manifest.expiresAt,
    ...(manifest.lockedAt !== undefined ? { lockedAt: manifest.lockedAt } : {}),
    chatCount: manifest.chatCount,
    archivedChatCount: manifest.archivedChatCount,
    executionCount: manifest.executionCount,
    ...(manifest.executionRestorePending
      ? { executionRestorePending: true }
      : {}),
    ...(manifest.branchName !== undefined
      ? { branchName: manifest.branchName }
      : {}),
    ...(manifest.workspaceType !== undefined
      ? { workspaceType: manifest.workspaceType }
      : {}),
    ...(manifest.diskUsage !== undefined
      ? {
          diskUsage: {
            filesBytes: manifest.diskUsage.filesBytes,
            gitBytes: manifest.diskUsage.gitBytes,
            ...(manifest.diskUsage.gitBytesComplete !== undefined
              ? { gitBytesComplete: manifest.diskUsage.gitBytesComplete }
              : {}),
            totalBytes: manifest.diskUsage.totalBytes,
            computedAt: manifest.diskUsage.computedAt,
          },
        }
      : {}),
    ...(manifest.restoredTo !== undefined
      ? {
          restoredTo: {
            kind: manifest.restoredTo.kind,
            id: manifest.restoredTo.id,
            restoredAt: manifest.restoredTo.restoredAt,
            ...(manifest.restoredTo.createdAt !== undefined
              ? { createdAt: manifest.restoredTo.createdAt }
              : {}),
          },
        }
      : {}),
  };
}

function cloneGitChanges(
  gitChanges: ArchivedGitChangesSummary,
): ArchivedGitChangesSummary {
  if (gitChanges.status === 'unavailable') {
    return {
      status: 'unavailable',
      capturedAt: gitChanges.capturedAt,
    };
  }
  return {
    status: 'complete',
    capturedAt: gitChanges.capturedAt,
    fileCount: gitChanges.fileCount,
    insertions: gitChanges.insertions,
    deletions: gitChanges.deletions,
    repositories: gitChanges.repositories.map((repository) => ({
      repoId: repository.repoId,
      repoName: repository.repoName,
      fileCount: repository.fileCount,
      insertions: repository.insertions,
      deletions: repository.deletions,
    })),
  };
}

function cloneBaseBranches(
  gitState: ArchivedGitState,
): ArchivedGitBaseBranchSummary[] {
  return gitState.repositories.map((repository) => {
    if (repository.comparisonBaseBranch && repository.baseBranchCommit) {
      return {
        repoId: repository.repoId,
        repoName: repository.repoName,
        status: 'complete',
        branchName: repository.comparisonBaseBranch,
        commit: repository.baseBranchCommit,
      };
    }
    return {
      repoId: repository.repoId,
      repoName: repository.repoName,
      status: 'unavailable',
      ...(repository.comparisonBaseBranch
        ? { branchName: repository.comparisonBaseBranch }
        : {}),
    };
  });
}

function clonePullRequestCapture(
  capture: ArchivedPullRequestCapture,
): ArchivedPullRequestCapture {
  return {
    capturedAt: capture.capturedAt,
    repositories: capture.repositories.map((repository) => {
      if (repository.status === 'unavailable') {
        return {
          repoId: repository.repoId,
          repoName: repository.repoName,
          status: 'unavailable',
        };
      }
      return {
        repoId: repository.repoId,
        repoName: repository.repoName,
        status: 'complete',
        pullRequest:
          repository.pullRequest === null
            ? null
            : {
                number: repository.pullRequest.number,
                url: repository.pullRequest.url,
                title: repository.pullRequest.title,
                state: repository.pullRequest.state,
                ...(repository.pullRequest.baseRefName !== undefined
                  ? { baseRefName: repository.pullRequest.baseRefName }
                  : {}),
                updatedAt: repository.pullRequest.updatedAt,
              },
      };
    }),
  };
}

/**
 * Whitelist projection from persisted metadata to the renderer contract.
 * Never replace this with a broad object spread: version 2 deliberately drops
 * Git object ids, refs, and absolute repository paths from `gitState`.
 */
export function toArchivedContainerSummary(
  manifest: ArchivedContainerManifest,
): ArchivedContainerSummary {
  const base = toSummaryBase(manifest);
  if (manifest.version === 3) {
    return {
      ...base,
      version: 3,
      kind: 'worktree',
      recovery: {
        kind: 'files-only',
        source: manifest.recovery.source,
        ...(manifest.recovery.gitCleanupPending
          ? { gitCleanupPending: true }
          : {}),
      },
    };
  }
  if (manifest.version === 2) {
    return {
      ...base,
      version: 2,
      kind: 'worktree',
      baseBranches: cloneBaseBranches(manifest.gitState),
      gitChanges: cloneGitChanges(manifest.gitChanges),
      pullRequestMetadata: clonePullRequestCapture(
        manifest.pullRequestMetadata,
      ),
    };
  }
  return {
    ...base,
    version: 1,
    kind: manifest.kind,
  };
}
