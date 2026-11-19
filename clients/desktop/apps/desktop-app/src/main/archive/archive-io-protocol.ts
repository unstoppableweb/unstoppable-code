import { isArchiveErrorFrame } from '../lib/archive-error-frames';
import { isAbsolute } from 'node:path';
import type {
  ArchivedContainerDiskUsage,
  ArchivedGitChangesSummary,
  ArchivedGitRepositoryState,
  ArchivedPullRequestCapture,
} from '@canopy/desktop-shared/types';

export const ARCHIVE_IO_PROTOCOL_VERSION = 1 as const;
export const ARCHIVE_IO_GIT_TIMEOUT_CODE = 'ARCHIVE_IO_GIT_TIMEOUT' as const;
export const ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE =
  'ARCHIVE_IO_GIT_RECOVERY_REQUIRED' as const;

export interface ArchiveRequestIdentity {
  version: typeof ARCHIVE_IO_PROTOCOL_VERSION;
  requestId: string;
  operationId: string;
  projectId: string;
  containerId: string;
  /** Main-process generation fence; the worker validates its wire shape only. */
  expectedCreatedAt: string;
}

export interface ArchiveChatStorageDescriptor {
  workspaceRoot: string;
  scopeId: string;
  legacyPaths?: readonly string[];
}

export interface ArchivePayloadCopyEntry {
  kind: 'file' | 'directory';
  source: string;
  destination: string;
  missingSource: 'ignore' | 'error';
  /** Copy the selected children, not the source directory itself. */
  contentsOnly?: boolean;
  /** Immediate child names omitted when contentsOnly is true. */
  excludeNames?: readonly string[];
}

export interface ArchiveGitCaptureRepositoryInput {
  repoId: string;
  repoName: string;
  relativePath: string;
  referenceRepoPath: string;
  worktreeRepoPath: string;
  comparisonBaseBranch?: string;
  comparisonBaseRefs?: readonly string[];
  comparisonBaseCommit?: string;
  baseBranchCommit?: string;
  snapshotRef: string;
}

export interface ArchiveGitCommandEnvironment {
  executable: string;
  env: Record<string, string>;
}

export type ArchiveIoOperationRequest =
  | (ArchiveRequestIdentity & {
      type: 'copy-chat-storage';
      input: {
        source: ArchiveChatStorageDescriptor;
        destination: ArchiveChatStorageDescriptor;
      };
    })
  | (ArchiveRequestIdentity & {
      type: 'copy-payload';
      input: {
        sourceRoots: readonly string[];
        destinationRoot: string;
        entries: readonly ArchivePayloadCopyEntry[];
      };
    })
  | (ArchiveRequestIdentity & {
      type: 'capture-git';
      input: {
        git: ArchiveGitCommandEnvironment;
        stagedDescriptorPath: string;
        repositories: readonly ArchiveGitCaptureRepositoryInput[];
      };
    })
  | (ArchiveRequestIdentity & {
      type: 'complete-git-capture';
      input: {
        stagedDescriptorPath: string;
        repositories: readonly ArchivedGitRepositoryState[];
        gitChanges: ArchivedGitChangesSummary;
        pullRequestMetadata: ArchivedPullRequestCapture;
      };
    })
  | (ArchiveRequestIdentity & {
      type: 'prepare-teardown';
      input: {
        canonicalPath: string;
        quarantinePath: string;
        expectedCanonicalRealPath?: string;
      };
    })
  | (ArchiveRequestIdentity & {
      type: 'remove-worktree';
      input: {
        git: ArchiveGitCommandEnvironment;
        referenceRepoPath: string;
        expectedRepositoryIdentity: string;
        worktreePath: string;
        /** Where the checkout was before a move Git may not have followed. */
        preMoveWorktreePath?: string;
      };
    })
  | (ArchiveRequestIdentity & {
      type: 'remove-directory';
      input: {
        path: string;
        allowedRoot: string;
        /** Refuse unless the directory still has this stat identity (CAN-5334). */
        expectedIdentity?: { dev: number; ino: number; birthtimeMs: number };
        /** Required with `expectedIdentity`: the sibling it is moved to first. */
        asidePath?: string;
      };
    })
  | (ArchiveRequestIdentity & {
      type: 'reset-directory';
      input: {
        path: string;
        allowedRoot: string;
        preserveNames: readonly string[];
      };
    })
  | (ArchiveRequestIdentity & {
      type: 'delete-branches';
      input: {
        git: ArchiveGitCommandEnvironment;
        branches: readonly {
          referenceRepoPath: string;
          expectedRepositoryIdentity: string;
          branchName: string;
          expectedTip: string;
          mode: 'force' | 'merged-only';
        }[];
      };
    })
  | (ArchiveRequestIdentity & {
      type: 'measure-disk-usage';
      input: {
        git: ArchiveGitCommandEnvironment;
        containerDirectory: string;
        repositories: readonly ArchivedGitRepositoryState[];
        computedAt: string;
      };
    });

export interface ArchiveIoCancelRequest {
  version: typeof ARCHIVE_IO_PROTOCOL_VERSION;
  type: 'cancel';
  requestId: string;
  operationId: string;
}

export interface ArchiveIoShutdownRequest {
  version: typeof ARCHIVE_IO_PROTOCOL_VERSION;
  type: 'shutdown';
}

export type ArchiveIoRequest =
  | ArchiveIoOperationRequest
  | ArchiveIoCancelRequest
  | ArchiveIoShutdownRequest;

export interface ArchiveIoResultMap {
  'copy-chat-storage': { copied: true };
  'copy-payload': { files: number; directories: number; bytes: number };
  'capture-git': {
    repositories: ArchivedGitRepositoryState[];
    gitChanges: ArchivedGitChangesSummary;
  };
  'complete-git-capture': { completed: true };
  'prepare-teardown': {
    canonicalPath: string;
    quarantinePath: string;
    alreadyRemoved: boolean;
    quarantineIdentity?: {
      dev: number;
      ino: number;
      birthtimeMs: number;
    };
  };
  'remove-worktree': { removed: true };
  'remove-directory': { removed: true };
  'reset-directory': { removedEntries: number };
  'delete-branches': { deleted: number };
  'measure-disk-usage': ArchivedContainerDiskUsage;
}

export type ArchiveIoOperationType = keyof ArchiveIoResultMap;

function isArchiveIoOperationType(
  value: unknown,
): value is ArchiveIoOperationType {
  return (
    value === 'copy-chat-storage' ||
    value === 'copy-payload' ||
    value === 'capture-git' ||
    value === 'complete-git-capture' ||
    value === 'prepare-teardown' ||
    value === 'remove-worktree' ||
    value === 'remove-directory' ||
    value === 'reset-directory' ||
    value === 'delete-branches' ||
    value === 'measure-disk-usage'
  );
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validArchivedGitRepository(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmpty(value.repoId) &&
    nonEmpty(value.repoName) &&
    nonEmpty(value.relativePath) &&
    absolute(value.referenceRepoPath) &&
    (value.branchName === undefined || nonEmpty(value.branchName)) &&
    (value.comparisonBaseBranch === undefined ||
      nonEmpty(value.comparisonBaseBranch)) &&
    (value.baseBranchCommit === undefined ||
      nonEmpty(value.baseBranchCommit)) &&
    nonEmpty(value.comparisonBaseCommit) &&
    nonEmpty(value.headCommit) &&
    nonEmpty(value.indexSnapshotCommit) &&
    nonEmpty(value.worktreeSnapshotCommit) &&
    nonEmpty(value.snapshotRef)
  );
}

function validArchivedGitRepoChanges(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmpty(value.repoId) &&
    nonEmpty(value.repoName) &&
    nonNegativeSafeInteger(value.fileCount) &&
    nonNegativeSafeInteger(value.insertions) &&
    nonNegativeSafeInteger(value.deletions)
  );
}

function validArchivedGitChanges(value: unknown): boolean {
  if (!isRecord(value) || !iso(value.capturedAt)) return false;
  if (value.status === 'unavailable') return true;
  return (
    value.status === 'complete' &&
    nonNegativeSafeInteger(value.fileCount) &&
    nonNegativeSafeInteger(value.insertions) &&
    nonNegativeSafeInteger(value.deletions) &&
    Array.isArray(value.repositories) &&
    value.repositories.every(validArchivedGitRepoChanges)
  );
}

export function isArchiveIoResult<T extends ArchiveIoOperationType>(
  operationType: T,
  result: unknown,
): result is ArchiveIoResultMap[T] {
  if (!isRecord(result)) return false;
  switch (operationType) {
    case 'copy-chat-storage':
      return result.copied === true;
    case 'copy-payload':
      return (
        nonNegativeSafeInteger(result.files) &&
        nonNegativeSafeInteger(result.directories) &&
        nonNegativeSafeInteger(result.bytes)
      );
    case 'capture-git':
      return (
        Array.isArray(result.repositories) &&
        result.repositories.every(validArchivedGitRepository) &&
        validArchivedGitChanges(result.gitChanges)
      );
    case 'complete-git-capture':
      return result.completed === true;
    case 'prepare-teardown':
      return (
        absolute(result.canonicalPath) &&
        absolute(result.quarantinePath) &&
        typeof result.alreadyRemoved === 'boolean' &&
        (result.quarantineIdentity === undefined ||
          (isRecord(result.quarantineIdentity) &&
            typeof result.quarantineIdentity.dev === 'number' &&
            typeof result.quarantineIdentity.ino === 'number' &&
            typeof result.quarantineIdentity.birthtimeMs === 'number')) &&
        (result.alreadyRemoved || result.quarantineIdentity !== undefined)
      );
    case 'remove-worktree':
    case 'remove-directory':
      return result.removed === true;
    case 'reset-directory':
      return nonNegativeSafeInteger(result.removedEntries);
    case 'delete-branches':
      return nonNegativeSafeInteger(result.deleted);
    case 'measure-disk-usage':
      return (
        nonNegativeSafeInteger(result.filesBytes) &&
        nonNegativeSafeInteger(result.gitBytes) &&
        nonNegativeSafeInteger(result.totalBytes) &&
        result.totalBytes === result.filesBytes + result.gitBytes &&
        (result.gitBytesComplete === undefined ||
          typeof result.gitBytesComplete === 'boolean') &&
        iso(result.computedAt)
      );
    default:
      return false;
  }
}

export type ArchiveIoResponse =
  | { version: 1; type: 'ready'; workerPid: number }
  | { version: 1; type: 'accepted'; requestId: string }
  | {
      version: 1;
      type: 'started';
      requestId: string;
      operationId: string;
      workerPid: number;
    }
  | {
      version: 1;
      type: 'progress';
      requestId: string;
      stage: string;
      files?: number;
      bytes?: number;
    }
  | {
      version: 1;
      type: 'child-started';
      requestId: string;
      pid: number;
    }
  | {
      version: 1;
      type: 'child-exited';
      requestId: string;
      pid: number;
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | {
      version: 1;
      type: 'result';
      requestId: string;
      operationType: ArchiveIoOperationType;
      result: ArchiveIoResultMap[ArchiveIoOperationType];
    }
  | {
      version: 1;
      type: 'error';
      requestId: string;
      code: string;
      message: string;
      failureCode?: string;
      frames?: readonly string[];
    }
  | {
      version: 1;
      type: 'cleanup-complete';
      requestId: string;
      childCleanup: 'not-required' | 'cooperative' | 'forced';
    }
  | { version: 1; type: 'shutdown-complete' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function iso(value: unknown): value is string {
  return (
    nonEmpty(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function absolute(value: unknown): value is string {
  return nonEmpty(value) && isAbsolute(value);
}

function validGit(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmpty(value.executable) &&
    isRecord(value.env) &&
    Object.values(value.env).every((entry) => typeof entry === 'string')
  );
}

function validChatStorage(value: unknown): boolean {
  return (
    isRecord(value) &&
    absolute(value.workspaceRoot) &&
    nonEmpty(value.scopeId) &&
    (value.legacyPaths === undefined ||
      (Array.isArray(value.legacyPaths) && value.legacyPaths.every(absolute)))
  );
}

function validPayloadEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.kind === 'file' || value.kind === 'directory') &&
    absolute(value.source) &&
    absolute(value.destination) &&
    (value.missingSource === 'ignore' || value.missingSource === 'error') &&
    (value.contentsOnly === undefined ||
      typeof value.contentsOnly === 'boolean') &&
    (value.excludeNames === undefined ||
      (Array.isArray(value.excludeNames) &&
        value.excludeNames.every(
          (entry) =>
            nonEmpty(entry) &&
            entry !== '.' &&
            entry !== '..' &&
            !entry.includes('/') &&
            !entry.includes('\\'),
        )))
  );
}

function validPreservedName(value: unknown): value is string {
  return (
    nonEmpty(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function validCaptureRepository(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonEmpty(value.repoId) &&
    nonEmpty(value.repoName) &&
    nonEmpty(value.relativePath) &&
    absolute(value.referenceRepoPath) &&
    absolute(value.worktreeRepoPath) &&
    nonEmpty(value.snapshotRef) &&
    (value.comparisonBaseRefs === undefined ||
      (Array.isArray(value.comparisonBaseRefs) &&
        value.comparisonBaseRefs.every(nonEmpty)))
  );
}

function validIdentity(value: Record<string, unknown>): boolean {
  return (
    value.version === ARCHIVE_IO_PROTOCOL_VERSION &&
    nonEmpty(value.requestId) &&
    nonEmpty(value.operationId) &&
    nonEmpty(value.projectId) &&
    nonEmpty(value.containerId) &&
    iso(value.expectedCreatedAt)
  );
}

export function isArchiveIoRequest(value: unknown): value is ArchiveIoRequest {
  if (!isRecord(value) || value.version !== ARCHIVE_IO_PROTOCOL_VERSION) {
    return false;
  }
  if (value.type === 'shutdown') return true;
  if (value.type === 'cancel') {
    return nonEmpty(value.requestId) && nonEmpty(value.operationId);
  }
  if (!validIdentity(value) || !isRecord(value.input)) return false;
  const input = value.input;
  switch (value.type) {
    case 'copy-chat-storage':
      return (
        validChatStorage(input.source) && validChatStorage(input.destination)
      );
    case 'copy-payload':
      return (
        absolute(input.destinationRoot) &&
        Array.isArray(input.sourceRoots) &&
        input.sourceRoots.length > 0 &&
        input.sourceRoots.every(absolute) &&
        Array.isArray(input.entries) &&
        input.entries.every(validPayloadEntry)
      );
    case 'capture-git':
      return (
        validGit(input.git) &&
        absolute(input.stagedDescriptorPath) &&
        Array.isArray(input.repositories) &&
        input.repositories.every(validCaptureRepository)
      );
    case 'complete-git-capture':
      return (
        absolute(input.stagedDescriptorPath) &&
        Array.isArray(input.repositories) &&
        isRecord(input.gitChanges) &&
        isRecord(input.pullRequestMetadata)
      );
    case 'prepare-teardown':
      return (
        absolute(input.canonicalPath) &&
        absolute(input.quarantinePath) &&
        (input.expectedCanonicalRealPath === undefined ||
          absolute(input.expectedCanonicalRealPath))
      );
    case 'remove-worktree':
      return (
        validGit(input.git) &&
        absolute(input.referenceRepoPath) &&
        absolute(input.expectedRepositoryIdentity) &&
        absolute(input.worktreePath) &&
        (input.preMoveWorktreePath === undefined ||
          absolute(input.preMoveWorktreePath))
      );
    case 'remove-directory':
      return (
        absolute(input.path) &&
        absolute(input.allowedRoot) &&
        (input.expectedIdentity === undefined
          ? input.asidePath === undefined
          : isRecord(input.expectedIdentity) &&
            typeof input.expectedIdentity.dev === 'number' &&
            typeof input.expectedIdentity.ino === 'number' &&
            typeof input.expectedIdentity.birthtimeMs === 'number' &&
            absolute(input.asidePath))
      );
    case 'reset-directory':
      return (
        absolute(input.path) &&
        absolute(input.allowedRoot) &&
        Array.isArray(input.preserveNames) &&
        input.preserveNames.every(validPreservedName)
      );
    case 'delete-branches':
      return (
        validGit(input.git) &&
        Array.isArray(input.branches) &&
        input.branches.every(
          (branch) =>
            isRecord(branch) &&
            absolute(branch.referenceRepoPath) &&
            absolute(branch.expectedRepositoryIdentity) &&
            nonEmpty(branch.branchName) &&
            nonEmpty(branch.expectedTip) &&
            (branch.mode === 'force' || branch.mode === 'merged-only'),
        )
      );
    case 'measure-disk-usage':
      return (
        absolute(input.containerDirectory) &&
        validGit(input.git) &&
        Array.isArray(input.repositories) &&
        iso(input.computedAt)
      );
    default:
      return false;
  }
}

export function isArchiveIoResponse(
  value: unknown,
): value is ArchiveIoResponse {
  if (!isRecord(value) || value.version !== ARCHIVE_IO_PROTOCOL_VERSION) {
    return false;
  }
  if (value.type === 'ready' || value.type === 'shutdown-complete') {
    return (
      value.type === 'shutdown-complete' ||
      (Number.isInteger(value.workerPid) && Number(value.workerPid) > 0)
    );
  }
  if (!nonEmpty(value.requestId)) return false;
  switch (value.type) {
    case 'accepted':
      return true;
    case 'started':
      return (
        nonEmpty(value.operationId) &&
        Number.isInteger(value.workerPid) &&
        Number(value.workerPid) > 0
      );
    case 'progress':
      return (
        nonEmpty(value.stage) &&
        (value.files === undefined || nonNegativeSafeInteger(value.files)) &&
        (value.bytes === undefined || nonNegativeSafeInteger(value.bytes))
      );
    case 'child-started':
      return Number.isInteger(value.pid) && Number(value.pid) > 0;
    case 'child-exited':
      return (
        Number.isInteger(value.pid) &&
        (value.code === null || Number.isInteger(value.code)) &&
        (value.signal === null || nonEmpty(value.signal))
      );
    case 'result':
      return (
        isArchiveIoOperationType(value.operationType) &&
        isArchiveIoResult(value.operationType, value.result)
      );
    case 'error':
      return (
        nonEmpty(value.code) &&
        nonEmpty(value.message) &&
        (value.failureCode === undefined ||
          typeof value.failureCode === 'string') &&
        (value.frames === undefined ||
          (Array.isArray(value.frames) &&
            value.frames.length <= 64 &&
            value.frames.every(
              (frame: unknown) =>
                isArchiveErrorFrame(frame) && frame.length <= 4096,
            )))
      );
    case 'cleanup-complete':
      return (
        value.childCleanup === 'not-required' ||
        value.childCleanup === 'cooperative' ||
        value.childCleanup === 'forced'
      );
    default:
      return false;
  }
}

export function isMeasurementRequest(
  request: ArchiveIoOperationRequest,
): boolean {
  return request.type === 'measure-disk-usage';
}
