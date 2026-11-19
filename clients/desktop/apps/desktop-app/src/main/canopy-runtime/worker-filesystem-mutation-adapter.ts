import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { FileSaveConflictError } from '@canopy/protocol/file-save-conflict';
import {
  WORKER_FILESYSTEM_DIRECTORY_CREATE_ERROR_CODES,
  WORKER_FILESYSTEM_ENTRY_COPY_ERROR_CODES,
  WORKER_FILESYSTEM_ENTRY_ERROR_CODES,
  WORKER_FILESYSTEM_FILE_WRITE_ERROR_CODES,
  type CanopyCallerDescriptor,
  type CanopyWorkspaceScope,
  type WorkerFilesystemDirectoryCreateErrorCode,
  type WorkerFilesystemDirectoryCreateParams,
  type WorkerFilesystemDirectoryCreateResult,
  type WorkerFilesystemEntryCopyErrorCode,
  type WorkerFilesystemEntryCopyParams,
  type WorkerFilesystemEntryCopyResult,
  type WorkerFilesystemEntryDeleteParams,
  type WorkerFilesystemEntryDeleteResult,
  type WorkerFilesystemEntryErrorCode,
  type WorkerFilesystemEntryMoveParams,
  type WorkerFilesystemEntryMoveResult,
  type WorkerFilesystemFileWriteErrorCode,
  type WorkerFilesystemFileWriteParams,
  type WorkerFilesystemFileWriteResult,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  type CanopyDispatcherInstructionHandlerMap,
  type CanopyInstructionOptions,
  type PlatformServices,
} from '@canopy/core-runtime';
import {
  copyFilesystemEntry,
  createFilesystemDirectory,
  deleteFilesystemEntry,
  moveFilesystemEntry,
  normalizeEntryDeletePath,
  normalizeEntryTransferPaths,
  normalizeFileCreatePath,
  writeFilesystemFile,
  type FilesystemEntryDeleteIo,
  type FilesystemEntryMutationHost,
  type FilesystemEntryRoot,
  type FilesystemEntryTransferIo,
  type FilesystemFileWriteIo,
} from '@canopy/core-runtime/node';
import type {
  FileTreeMutationRequest,
  FileTreeMutationResponse,
} from '@canopy/desktop-shared/types';
import { getFileBrowserRoots } from '../lib/file-browser-roots';
import { assertWritableScope } from '../lib/read-only-scope';
import { resolveWorktreeTargetIds } from '../lib/resolve-worktree';
import { isRecord } from '../lib/type-guards';
import type { DesktopMutationInstructionDefinitions } from './desktop-instruction-definitions';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import {
  RemoteControlServiceError,
  type RemoteControlServiceErrorCode,
} from '../services/remote-control-service-error';
import {
  SplitLockError,
  assertNotSplitLocked,
} from '../services/split-lock-service';
import {
  requireDesktopScope,
  translateFilesServiceError,
} from './worker-filesystem-adapter';

/*
 * `worker.filesystem.entry.delete`, `.copy` and `.move` (CAN-4101) and
 * `worker.filesystem.file.write` and `.directory.create` (CAN-4100) on the
 * desktop dispatcher: the desktop host port behind the core-runtime engines,
 * and the `file-tree:mutate` and `file:save-content` projections over them.
 */

/** The text editor's save cap, which `file:save-content` checks first. */
const DESKTOP_FILE_WRITE_LIMIT_BYTES = 5 * 1024 * 1024;

/** The target whose Auto Delete reservation the running text save holds. */
let heldTextSaveReservationStore: AsyncLocalStorage<string> | undefined;

// Built on first use: this file does no host work at import (CAN-4100).
// Its imports still do, e.g. split-lock-service's AsyncLocalStorage.
function heldTextSaveReservation(): AsyncLocalStorage<string> {
  heldTextSaveReservationStore ??= new AsyncLocalStorage<string>();
  return heldTextSaveReservationStore;
}

function reservationKey(projectId: string, worktreeId: string): string {
  return `${projectId}\0${worktreeId}`;
}

/** The `PlatformServices` members entry instructions use. */
export type DesktopEntryMutationPlatform = Pick<
  PlatformServices,
  'os' | 'trash'
>;

type DeleteFileTreeRequest = Extract<
  FileTreeMutationRequest,
  { operation: 'delete' }
>;

type TransferFileTreeRequest = Extract<
  FileTreeMutationRequest,
  { operation: 'copy' | 'move' }
>;

type CreateFileTreeRequest = Extract<
  FileTreeMutationRequest,
  { operation: 'create-file' | 'create-directory' }
>;

/**
 * Host refusals keep their original error as the runtime cause, which the
 * IPC projection rethrows; other callers get a typed kind.
 */
function hostError(error: unknown): CanopyOperationError {
  if (error instanceof CanopyOperationError) return error;
  if (error instanceof SplitLockError)
    return new CanopyOperationError(
      {
        kind: 'failed_precondition',
        message: error.message,
        retry: { kind: 'never' },
      },
      error,
    );
  const translated = translateFilesServiceError(error);
  return new CanopyOperationError(translated.payload, translated.runtimeCause);
}

async function hostCall<Result>(
  call: () => Result | Promise<Result>,
): Promise<Result> {
  try {
    return await call();
  } catch (error) {
    throw hostError(error);
  }
}

/** The explorer's prelude and roots, as `mutateFileTree` checks them. */
export function createDesktopEntryMutationHost(
  platform: DesktopEntryMutationPlatform,
): FilesystemEntryMutationHost {
  return {
    os: platform.os,
    ...(platform.trash && { trash: platform.trash }),
    assertMutable: (scope) =>
      hostCall(() => {
        const { projectId, worktreeId } = requireDesktopScope(scope);
        validateId(projectId, 'projectId');
        validateId(worktreeId, 'worktreeId');
        try {
          assertWritableScope(projectId);
        } catch (error) {
          throw new CanopyOperationError(
            {
              kind: 'permission_denied',
              message:
                error instanceof Error && error.message
                  ? error.message
                  : 'This scope is read-only.',
              retry: { kind: 'never' },
            },
            error,
          );
        }
        const target = resolveWorktreeTargetIds(projectId, worktreeId);
        if (!target) {
          throw new RemoteControlServiceError(
            'invalid_target',
            'Managed file-tree target could not be resolved.',
          );
        }
        assertNotSplitLocked(
          target.projectId,
          target.worktreeId,
          'updating files',
        );
      }),
    roots: (scope) =>
      hostCall(async () => {
        const { projectId, worktreeId } = requireDesktopScope(scope);
        validateId(projectId, 'workspaceLocalId');
        validateId(worktreeId, 'worktreeLocalId');
        const { roots } = await getFileBrowserRoots(projectId, worktreeId);
        return roots.map((root) => ({
          fileRootId: root.repoId,
          absolutePath: root.absolutePath,
          excludedDescendantRoots: root.excludedDescendantRoots,
        }));
      }),
    fileWriteLimitBytes: DESKTOP_FILE_WRITE_LIMIT_BYTES,
    // Holds Auto Delete off the worktree while a replace runs, as the text
    // save did. The text save projection already holds it: a second hold
    // would refuse once archiving waits on the first.
    admitWrite: async (scope, run) => {
      const release = await hostCall(async () => {
        const { projectId, worktreeId } = requireDesktopScope(scope);
        if (
          heldTextSaveReservation().getStore() ===
          reservationKey(projectId, worktreeId)
        )
          return (): void => undefined;
        const { reserveWorkspaceTargetRuntimeStart } =
          await import('../lib/workspace-target-exclusion');
        try {
          return reserveWorkspaceTargetRuntimeStart(projectId, worktreeId);
        } catch (error) {
          throw new CanopyOperationError(
            {
              kind: 'failed_precondition',
              message:
                error instanceof Error && error.message
                  ? error.message
                  : 'This worktree is being removed.',
              retry: { kind: 'never' },
            },
            error,
          );
        }
      });
      try {
        return await run();
      } finally {
        release();
      }
    },
    beforeReplace: (scope) =>
      hostCall(async () => {
        const { projectId, worktreeId } = requireDesktopScope(scope);
        const { touchWorkspaceTarget } =
          await import('../lib/workspace-activity');
        await touchWorkspaceTarget(projectId, worktreeId);
      }),
  };
}

export function createWorkerFilesystemMutationAdapter(
  host: FilesystemEntryMutationHost,
  io?: FilesystemEntryDeleteIo,
  transferIo?: FilesystemEntryTransferIo,
  writeIo?: FilesystemFileWriteIo,
): CanopyDispatcherInstructionHandlerMap<DesktopMutationInstructionDefinitions> {
  return {
    'worker.filesystem.file.write': (params, context) =>
      writeFilesystemFile(params, {
        host,
        signal: context.signal,
        ...(writeIo && { io: writeIo }),
      }),
    'worker.filesystem.directory.create': (params, context) =>
      createFilesystemDirectory(params, {
        host,
        signal: context.signal,
        ...(writeIo && { io: writeIo }),
      }),
    'worker.filesystem.entry.delete': (params, context) =>
      deleteFilesystemEntry(params, {
        host,
        signal: context.signal,
        ...(io && { io }),
      }),
    'worker.filesystem.entry.copy': (params, context) =>
      copyFilesystemEntry(params, {
        host,
        signal: context.signal,
        ...(transferIo && { io: transferIo }),
      }),
    'worker.filesystem.entry.move': (params, context) =>
      moveFilesystemEntry(params, {
        host,
        signal: context.signal,
        ...(transferIo && { io: transferIo }),
      }),
  };
}

// A switch, not a keyed map: the census reads `worker.*` keys in adapter
// files as registered operations.
type FileTreeMutationErrorCode =
  | WorkerFilesystemEntryErrorCode
  | WorkerFilesystemEntryCopyErrorCode
  | WorkerFilesystemFileWriteErrorCode
  | WorkerFilesystemDirectoryCreateErrorCode;

function legacyErrorCode(
  code: FileTreeMutationErrorCode,
): RemoteControlServiceErrorCode {
  switch (code) {
    // Unreachable here: the projection sends `recursive: true`, the host
    // compares no entry version, a create never replaces, and a split lock
    // fails as the host's own error. Listed so the switch stays exhaustive.
    case 'worker.filesystem.entry.invalidState':
    case 'worker.filesystem.entry.revisionConflict':
    case 'worker.filesystem.source.conflict':
    case 'worker.filesystem.split.locked':
    case 'worker.filesystem.file.invalidState':
    case 'worker.filesystem.file.revisionConflict':
      return 'invalid_target';
    case 'worker.filesystem.entry.notFound':
    case 'worker.filesystem.source.notFound':
    case 'worker.filesystem.root.notFound':
    case 'worker.filesystem.file.notFound':
      return 'not_found';
    case 'worker.filesystem.trash.unavailable':
    case 'worker.filesystem.trash.failed':
      return 'execution_failed';
    case 'worker.filesystem.entry.invalidPath':
    case 'worker.filesystem.entry.outsideRoot':
    case 'worker.filesystem.entry.changed':
    case 'worker.filesystem.entry.exists':
    case 'worker.filesystem.entry.nested':
    case 'worker.filesystem.entry.crossRootSymlink':
    case 'worker.filesystem.destination.exists':
    case 'worker.filesystem.path.escape':
    case 'worker.filesystem.destination.nested':
    case 'worker.filesystem.symlink.rejected':
    case 'worker.filesystem.root.excluded':
    case 'worker.filesystem.path.invalid':
      return 'invalid_target';
  }
}

function isEntryErrorCode(
  code: string | undefined,
): code is FileTreeMutationErrorCode {
  return [
    ...WORKER_FILESYSTEM_ENTRY_ERROR_CODES,
    ...WORKER_FILESYSTEM_ENTRY_COPY_ERROR_CODES,
    ...WORKER_FILESYSTEM_FILE_WRITE_ERROR_CODES,
    ...WORKER_FILESYSTEM_DIRECTORY_CREATE_ERROR_CODES,
  ].some((candidate) => candidate === code);
}

/**
 * What `mutateFileTree` threw: a host refusal or Node error as itself, an
 * engine refusal as the `RemoteControlServiceError` the explorer displays.
 */
export function toLegacyFileTreeMutationError(error: unknown): unknown {
  if (!(error instanceof CanopyOperationError)) return error;
  if (error.runtimeCause !== undefined) return error.runtimeCause;
  const { code, message } = error.payload;
  return isEntryErrorCode(code)
    ? new RemoteControlServiceError(legacyErrorCode(code), message)
    : new Error(message);
}

/** The delete/transfer projections need root identities, not host paths. */
export interface LegacyEntryMutationHost extends Pick<
  FilesystemEntryMutationHost,
  'os' | 'assertMutable'
> {
  roots(
    scope: CanopyWorkspaceScope,
  ): Promise<readonly { fileRootId: string }[]>;
}

export interface EntryDeleteDispatch {
  (
    params: WorkerFilesystemEntryDeleteParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerFilesystemEntryDeleteResult>;
}

/**
 * A `file-tree:mutate` delete over `worker.filesystem.entry.delete`. Without
 * a `repoId` the scope's only root is used, after the host's refusals, as
 * `mutateFileTree` resolved it; more than one root is ambiguous.
 */
export async function deleteFileTreeEntryForLegacyIpc(
  dispatch: EntryDeleteDispatch,
  host: LegacyEntryMutationHost,
  request: DeleteFileTreeRequest,
  options: { caller: CanopyCallerDescriptor },
): Promise<FileTreeMutationResponse> {
  const scope = {
    workspaceId: request.projectId,
    worktreeId: request.worktreeId,
  };
  try {
    // IPC payloads are unchecked: the target may be absent, null or a non-object.
    if (!isRecord(request.target)) {
      await host.assertMutable(scope);
      throw new RemoteControlServiceError(
        'invalid_payload',
        'Mutation target is missing.',
      );
    }
    validateOptionalRepoId(request.target.repoId, 'repoId');
    let fileRootId = request.target.repoId;
    if (fileRootId === undefined) {
      await host.assertMutable(scope);
      const roots = await host.roots(scope);
      const [only] = roots;
      if (roots.length !== 1 || !only) {
        throw new RemoteControlServiceError(
          'invalid_target',
          'File root is ambiguous; provide fileRootLocalId or repoId.',
        );
      }
      fileRootId = only.fileRootId;
    }
    // A fresh key per call: the host retains no outcome to replay
    // (CAN-4733), so a reused key would only delete again.
    const idempotencyKey = randomUUID();
    // No deadline and no signal: the explorer waits for the outcome.
    await dispatch(
      {
        scope,
        fileRootId,
        relativePath: request.target.relativePath,
        expectedVersion: null,
        recursive: true,
        disposition: request.useTrash ? 'trash' : 'permanent',
        _meta: { idempotencyKey },
      },
      { caller: options.caller, metadata: { idempotencyKey } },
    );
    // The engine accepted this path, so it normalizes again without throwing.
    return {
      operation: 'delete',
      target: {
        repoId: fileRootId,
        relativePath: normalizeEntryDeletePath(
          request.target.relativePath,
          host.os,
        ),
      },
    };
  } catch (error) {
    throw toLegacyFileTreeMutationError(error);
  }
}

export interface EntryCopyDispatch {
  (
    params: WorkerFilesystemEntryCopyParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerFilesystemEntryCopyResult>;
}

export interface EntryMoveDispatch {
  (
    params: WorkerFilesystemEntryMoveParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerFilesystemEntryMoveResult>;
}

/**
 * Each endpoint's root as `mutateFileTree` resolved it, source first: an
 * omitted `repoId` names the scope's only root, after the host's refusals.
 */
async function resolveTransferRootIds(
  host: LegacyEntryMutationHost,
  scope: CanopyWorkspaceScope,
  hints: readonly [string | undefined, string | undefined],
): Promise<[string, string]> {
  const [sourceHint, targetHint] = hints;
  if (sourceHint !== undefined && targetHint !== undefined)
    return [sourceHint, targetHint];
  await host.assertMutable(scope);
  const roots = await host.roots(scope);
  const resolve = (hint: string | undefined): string => {
    const [only] = roots;
    if (hint === undefined) {
      if (roots.length !== 1 || !only) {
        throw new RemoteControlServiceError(
          'invalid_target',
          'File root is ambiguous; provide fileRootLocalId or repoId.',
        );
      }
      return only.fileRootId;
    }
    if (!roots.some((root) => root.fileRootId === hint)) {
      throw new RemoteControlServiceError(
        'not_found',
        `Unknown file root: ${hint}`,
      );
    }
    return hint;
  };
  return [resolve(sourceHint), resolve(targetHint)];
}

/** IPC payloads are unchecked: an endpoint may be absent, null or a non-object. */
function missingTransferEndpoint(
  request: TransferFileTreeRequest,
): 'source' | 'target' | undefined {
  if (!('source' in request) || !isRecord(request.source)) return 'source';
  if (!isRecord(request.target)) return 'target';
  return undefined;
}

/**
 * The copy page requires a non-empty path, so the dispatcher would refuse
 * `''` before the engine gives the explorer its message. Runs the engine's
 * checks up to its path refusal here instead, in the engine's order.
 */
async function refuseEmptyCopyPath(
  host: LegacyEntryMutationHost,
  endpoints: {
    scope: CanopyWorkspaceScope;
    sourceFileRootId: string;
    sourceRelativePath: string;
    destinationFileRootId: string;
    destinationRelativePath: string;
  },
): Promise<void> {
  if (
    endpoints.sourceRelativePath !== '' &&
    endpoints.destinationRelativePath !== ''
  )
    return;
  await host.assertMutable(endpoints.scope);
  const roots = await host.roots(endpoints.scope);
  for (const fileRootId of [
    endpoints.sourceFileRootId,
    endpoints.destinationFileRootId,
  ])
    if (!roots.some((root) => root.fileRootId === fileRootId))
      throw new RemoteControlServiceError(
        'not_found',
        `Unknown file root: ${fileRootId}`,
      );
  normalizeEntryTransferPaths(
    endpoints.sourceRelativePath,
    endpoints.destinationRelativePath,
    host.os,
  );
}

/**
 * A `file-tree:mutate` copy or move (rename included) over
 * `worker.filesystem.entry.copy` or `.move`, answered and failing as
 * `mutateFileTree` did. A move always refuses an occupied destination; a copy
 * increments only when asked to.
 */
export async function transferFileTreeEntryForLegacyIpc(
  dispatch: { copy: EntryCopyDispatch; move: EntryMoveDispatch },
  host: LegacyEntryMutationHost,
  request: TransferFileTreeRequest,
  options: { caller: CanopyCallerDescriptor },
): Promise<FileTreeMutationResponse> {
  const scope = {
    workspaceId: request.projectId,
    worktreeId: request.worktreeId,
  };
  try {
    const missing = missingTransferEndpoint(request);
    if (missing) {
      await host.assertMutable(scope);
      throw new RemoteControlServiceError(
        'invalid_payload',
        `Mutation ${missing} is missing.`,
      );
    }
    validateOptionalRepoId(request.source.repoId, 'fileRootLocalId');
    validateOptionalRepoId(request.target.repoId, 'fileRootLocalId');
    const [sourceFileRootId, destinationFileRootId] =
      await resolveTransferRootIds(host, scope, [
        request.source.repoId,
        request.target.repoId,
      ]);
    // A fresh key per call: the host retains no outcome to replay
    // (CAN-4733), so a reused key would only act again.
    const idempotencyKey = randomUUID();
    const instructionOptions = {
      caller: options.caller,
      metadata: { idempotencyKey },
    };
    // No deadline and no signal: the explorer waits for the outcome.
    if (request.operation === 'copy') {
      const endpoints = {
        scope,
        sourceFileRootId,
        sourceRelativePath: request.source.relativePath,
        destinationFileRootId,
        destinationRelativePath: request.target.relativePath,
      };
      await refuseEmptyCopyPath(host, endpoints);
      const copied = await dispatch.copy(
        {
          ...endpoints,
          expectedSourceVersion: null,
          conflictPolicy:
            request.conflict === 'increment' ? 'increment' : 'error',
          _meta: { idempotencyKey },
        },
        instructionOptions,
      );
      return {
        operation: 'copy',
        source: {
          repoId: copied.sourceFileRootId,
          relativePath: copied.sourceRelativePath,
        },
        target: {
          repoId: copied.destinationFileRootId,
          relativePath: copied.destinationRelativePath,
        },
      };
    }
    const moved = await dispatch.move(
      {
        scope,
        sourceFileRootId,
        destinationFileRootId,
        fromRelativePath: request.source.relativePath,
        toRelativePath: request.target.relativePath,
        expectedSourceVersion: null,
        expectedDestinationAbsent: true,
        conflictPolicy: 'error',
        _meta: { idempotencyKey },
      },
      instructionOptions,
    );
    return {
      operation: 'move',
      source: {
        repoId: moved.sourceFileRootId,
        relativePath: moved.fromRelativePath,
      },
      target: {
        repoId: moved.destinationFileRootId,
        relativePath: moved.toRelativePath,
      },
    };
  } catch (error) {
    throw toLegacyFileTreeMutationError(error);
  }
}

export interface FileWriteDispatch {
  (
    params: WorkerFilesystemFileWriteParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerFilesystemFileWriteResult>;
}

export interface DirectoryCreateDispatch {
  (
    params: WorkerFilesystemDirectoryCreateParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerFilesystemDirectoryCreateResult>;
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

/**
 * The folder a create-file must make first: its parent, when that is missing.
 * Anything else the engine answers in its own order, so this never refuses.
 */
async function missingParentFolder(
  host: FilesystemEntryMutationHost,
  scope: CanopyWorkspaceScope,
  fileRootId: string,
  relativePath: string,
): Promise<{ relativePath: string; absolutePath: string } | undefined> {
  const root = (await host.roots(scope)).find(
    (candidate) => candidate.fileRootId === fileRootId,
  );
  if (!root) return undefined;
  let normalized: string;
  try {
    normalized = normalizeFileCreatePath(relativePath, host.os);
  } catch {
    return undefined;
  }
  const parent = posix.dirname(normalized);
  if (parent === '.') return undefined;
  const absolutePath = join(root.absolutePath, ...parent.split('/'));
  try {
    await stat(absolutePath);
    return undefined;
  } catch (error) {
    return errorCode(error) === 'ENOENT'
      ? { relativePath: parent, absolutePath }
      : undefined;
  }
}

async function isFolder(pathValue: string): Promise<boolean> {
  try {
    return (await stat(pathValue)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The create page requires a non-empty path, so the dispatcher would refuse
 * `''` before the engine gives the explorer its message. Runs the engine's
 * checks after the host refusals up to its path refusal here instead, in the
 * engine's order.
 */
async function refuseEmptyCreatePath(
  host: FilesystemEntryMutationHost,
  scope: CanopyWorkspaceScope,
  fileRootId: string,
  relativePath: string,
): Promise<void> {
  if (relativePath !== '') return;
  if (!(await host.roots(scope)).some((root) => root.fileRootId === fileRootId))
    throw new RemoteControlServiceError(
      'not_found',
      `Unknown file root: ${fileRootId}`,
    );
  normalizeFileCreatePath(relativePath, host.os);
}

/**
 * A `file-tree:mutate` create over `worker.filesystem.directory.create` and
 * `.file.write`, answered and failing as `mutateFileTree` did. A new file's
 * missing parent folders are created first, as the explorer did, then the
 * file exclusively; a failed write leaves those folders behind, as before.
 */
export async function createFileTreeEntryForLegacyIpc(
  dispatch: { file: FileWriteDispatch; directory: DirectoryCreateDispatch },
  host: FilesystemEntryMutationHost,
  request: CreateFileTreeRequest,
  options: { caller: CanopyCallerDescriptor },
): Promise<FileTreeMutationResponse> {
  const scope = {
    workspaceId: request.projectId,
    worktreeId: request.worktreeId,
  };
  // A fresh key per call: the host retains no outcome to replay (CAN-4733).
  const keyed = (): {
    meta: { idempotencyKey: string };
    options: CanopyInstructionOptions;
  } => {
    const idempotencyKey = randomUUID();
    return {
      meta: { idempotencyKey },
      options: { caller: options.caller, metadata: { idempotencyKey } },
    };
  };
  try {
    // The host refusals precede the root id's check, as in mutateFileTree.
    await host.assertMutable(scope);
    // IPC payloads are unchecked: the target may be absent, null or a non-object.
    if (!isRecord(request.target)) {
      throw new RemoteControlServiceError(
        'invalid_payload',
        'Mutation target is missing.',
      );
    }
    validateOptionalRepoId(request.target.repoId, 'fileRootLocalId');
    let fileRootId = request.target.repoId;
    if (fileRootId === undefined) {
      const roots = await host.roots(scope);
      const [only] = roots;
      if (roots.length !== 1 || !only) {
        throw new RemoteControlServiceError(
          'invalid_target',
          'File root is ambiguous; provide fileRootLocalId or repoId.',
        );
      }
      fileRootId = only.fileRootId;
    }
    const { relativePath } = request.target;
    // No deadline and no signal: the explorer waits for the outcome.
    if (request.operation === 'create-directory') {
      await refuseEmptyCreatePath(host, scope, fileRootId, relativePath);
      const call = keyed();
      const created = await dispatch.directory(
        {
          scope,
          fileRootId,
          relativePath,
          createParents: true,
          expectedAbsent: true,
          _meta: call.meta,
        },
        call.options,
      );
      return {
        operation: 'create-directory',
        target: {
          repoId: created.fileRootId,
          relativePath: created.relativePath,
        },
      };
    }
    const parent = await missingParentFolder(
      host,
      scope,
      fileRootId,
      relativePath,
    );
    if (parent !== undefined) {
      const call = keyed();
      try {
        await dispatch.directory(
          {
            scope,
            fileRootId,
            relativePath: parent.relativePath,
            createParents: true,
            expectedAbsent: true,
            _meta: call.meta,
          },
          call.options,
        );
      } catch (error) {
        // A folder made meanwhile passes, as `mkdir -p` let it; the file
        // create below still checks it is inside the root and no other root.
        if (
          !(error instanceof CanopyOperationError) ||
          error.payload.code !== 'worker.filesystem.entry.exists' ||
          !(await isFolder(parent.absolutePath))
        )
          throw error;
      }
    }
    const call = keyed();
    const written = await dispatch.file(
      {
        scope,
        fileRootId,
        relativePath,
        content: '',
        createOnly: true,
        _meta: call.meta,
      },
      call.options,
    );
    return {
      operation: 'create-file',
      target: { repoId: fileRootId, relativePath: written.relativePath },
    };
  } catch (error) {
    throw toLegacyFileTreeMutationError(error);
  }
}

/** One text save `file:save-content` validated against its save roots. */
export interface LegacyTextFileSave {
  readonly projectId: string;
  readonly worktreeId: string;
  /** The file's real path, inside one of the legacy save roots. */
  readonly realPath: string;
  readonly content: string;
  /** The version of the stat the legacy 1 ms check accepted. */
  readonly expectedVersion: string;
}

async function realpathOrNull(pathValue: string): Promise<string | null> {
  try {
    return await realpath(pathValue);
  } catch {
    return null;
  }
}

function isInside(pathValue: string, rootPath: string): boolean {
  return pathValue === rootPath || pathValue.startsWith(`${rootPath}${sep}`);
}

/**
 * The explorer root a saved file belongs to: the most specific one whose real
 * path holds the file outside its other roots. `null` names a save-only root
 * (CAN-4100 debt): a Cowork or App Advisor worktree attachment store, or a
 * folder under `repos/` that is no configured checkout.
 */
async function explorerRootForSave(
  roots: readonly FilesystemEntryRoot[],
  realPath: string,
): Promise<{ fileRootId: string; relativePath: string } | null> {
  let best: { fileRootId: string; rootReal: string } | null = null;
  for (const root of roots) {
    const rootReal = await realpathOrNull(root.absolutePath);
    if (rootReal === null || !isInside(realPath, rootReal)) continue;
    const excluded = await Promise.all(
      root.excludedDescendantRoots.map(realpathOrNull),
    );
    if (excluded.some((path) => path !== null && isInside(realPath, path)))
      continue;
    if (!best || rootReal.length > best.rootReal.length)
      best = { fileRootId: root.fileRootId, rootReal };
  }
  if (!best || best.rootReal === realPath) return null;
  return {
    fileRootId: best.fileRootId,
    relativePath: relative(best.rootReal, realPath).split(sep).join('/'),
  };
}

/** What the text save threw: a stale version as `FileSaveConflictError`. */
export function toLegacyFileSaveError(error: unknown): unknown {
  if (!(error instanceof CanopyOperationError)) return error;
  if (error.payload.code === 'worker.filesystem.file.revisionConflict')
    return new FileSaveConflictError();
  if (error.runtimeCause !== undefined) return error.runtimeCause;
  return new Error(error.payload.message);
}

/**
 * A `file:save-content` text save over `worker.filesystem.file.write`,
 * replacing the file in place under the version the legacy check accepted.
 * The caller holds the target's Auto Delete reservation; the replace joins it.
 * `unrouted` leaves the save to the caller's direct write (CAN-4100 debt): a
 * save-only root, a managed chat target that resolves to no worktree, a
 * scope whose explorer roots can't be read, or a POSIX name the engine's path
 * check refuses.
 */
export async function saveTextFileForLegacyIpc(
  dispatch: FileWriteDispatch,
  host: FilesystemEntryMutationHost,
  save: LegacyTextFileSave,
  options: { caller: CanopyCallerDescriptor },
): Promise<'written' | 'unrouted'> {
  try {
    if (resolveWorktreeTargetIds(save.projectId, save.worktreeId) === null)
      return 'unrouted';
    const scope = { workspaceId: save.projectId, worktreeId: save.worktreeId };
    let roots: readonly FilesystemEntryRoot[];
    try {
      roots = await host.roots(scope);
    } catch {
      // The legacy save never read the explorer's roots; a scope they can't
      // be read for keeps its direct write instead of a new refusal.
      return 'unrouted';
    }
    const route = await explorerRootForSave(roots, save.realPath);
    if (!route) return 'unrouted';
    // file.write's path check (the create shares it). On a real path inside
    // the root it refuses only POSIX names with `\` or a drive-like first
    // segment, which keep the direct write (CAN-4100 debt, case 7).
    try {
      normalizeFileCreatePath(route.relativePath, host.os);
    } catch {
      return 'unrouted';
    }
    // A fresh key per call: the host retains no outcome to replay (CAN-4733).
    const idempotencyKey = randomUUID();
    await heldTextSaveReservation().run(
      reservationKey(save.projectId, save.worktreeId),
      () =>
        dispatch(
          {
            scope,
            fileRootId: route.fileRootId,
            relativePath: route.relativePath,
            content: save.content,
            createOnly: false,
            expectedVersion: save.expectedVersion,
            _meta: { idempotencyKey },
          },
          { caller: options.caller, metadata: { idempotencyKey } },
        ),
    );
    return 'written';
  } catch (error) {
    throw toLegacyFileSaveError(error);
  }
}
