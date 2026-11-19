import {
  CanopyErrorPayloadSchema,
  type CanopyErrorPayload,
  type CanopyQueryHandlerMap,
  type CanopyWorkspaceScope,
  type WorkerFilesystemDirectoryListResult,
  type WorkerFilesystemRootsListResult,
} from '@canopy/protocol/canopy-core';
import type {
  FileTreeDirectoryRequest,
  FileTreeDirectoryResponse,
  FileTreeRootsRequest,
  FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import { IdentifierValidationError } from '../lib/identifier-validation-error';
import { RemoteControlServiceError } from '../services/remote-control-service-error';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

export interface WorkerFilesystemServices {
  listFileTreeRoots(
    request: FileTreeRootsRequest,
  ): Promise<FileTreeRootsResponse>;
  listFileTreeDirectory(
    request: FileTreeDirectoryRequest,
  ): Promise<FileTreeDirectoryResponse>;
}

export interface WorkerFilesystemProjectionCapture {
  captureRoots(result: FileTreeRootsResponse): void;
  captureDirectory(result: FileTreeDirectoryResponse): void;
}

type WorkerFilesystemHandlerMap = Pick<
  CanopyQueryHandlerMap,
  'worker.filesystem.roots.list' | 'worker.filesystem.directory.list'
>;

export function requireDesktopScope(scope: CanopyWorkspaceScope): {
  projectId: string;
  worktreeId: string;
} {
  if (scope.workspaceId === undefined || scope.worktreeId === undefined) {
    throw new RemoteControlServiceError(
      'invalid_payload',
      'Desktop filesystem operations require workspaceId and worktreeId.',
    );
  }
  // Phase 0A has no enrolled target registry. Never reinterpret an explicit
  // remote selection as permission to read the local checkout.
  if (
    scope.targetId !== undefined ||
    (scope.authorityId !== undefined &&
      scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
  ) {
    throw new WorkerFilesystemAdapterError(
      {
        kind: 'capability_unavailable',
        message: 'The selected filesystem authority or target is unavailable.',
        retry: { kind: 'never' },
      },
      undefined,
    );
  }
  return { projectId: scope.workspaceId, worktreeId: scope.worktreeId };
}

export class WorkerFilesystemAdapterError extends Error {
  public readonly payload: CanopyErrorPayload;
  public readonly runtimeCause: unknown;

  public constructor(payload: CanopyErrorPayload, runtimeCause: unknown) {
    const validatedPayload = CanopyErrorPayloadSchema.parse(payload);
    super(validatedPayload.message);
    this.name = 'WorkerFilesystemAdapterError';
    this.payload = validatedPayload;
    Object.defineProperty(this, 'runtimeCause', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: runtimeCause,
    });
  }

  public toJSON(): CanopyErrorPayload {
    return this.payload;
  }
}

function isIdentifierValidationError(error: unknown): error is Error {
  return error instanceof IdentifierValidationError;
}

/** The direct reader's typed form of a Files service failure. */
export function translateFilesServiceError(
  error: unknown,
): WorkerFilesystemAdapterError {
  if (error instanceof WorkerFilesystemAdapterError) return error;
  if (error instanceof RemoteControlServiceError) {
    const kind =
      error.code === 'invalid_payload' || error.code === 'invalid_target'
        ? 'invalid_argument'
        : error.code === 'not_found'
          ? 'not_found'
          : 'internal';
    return new WorkerFilesystemAdapterError(
      { kind, message: error.message, retry: { kind: 'never' } },
      error,
    );
  }
  if (isIdentifierValidationError(error)) {
    return new WorkerFilesystemAdapterError(
      {
        kind: 'invalid_argument',
        message: error.message,
        retry: { kind: 'never' },
      },
      error,
    );
  }
  return new WorkerFilesystemAdapterError(
    {
      kind: 'internal',
      message: 'Filesystem operation failed.',
      retry: { kind: 'never' },
    },
    error,
  );
}

export function createWorkerFilesystemAdapter(
  services: WorkerFilesystemServices,
  projectionCapture?: WorkerFilesystemProjectionCapture,
): WorkerFilesystemHandlerMap {
  return {
    'worker.filesystem.roots.list': async (
      params,
    ): Promise<WorkerFilesystemRootsListResult> => {
      try {
        const result = await services.listFileTreeRoots(
          requireDesktopScope(params.scope),
        );
        projectionCapture?.captureRoots(result);
        return {
          roots: result.roots.map((root) => ({
            fileRootId: root.repoId,
            name: root.repoName,
            kind: root.rootKind,
          })),
        };
      } catch (error) {
        throw translateFilesServiceError(error);
      }
    },
    'worker.filesystem.directory.list': async (
      params,
    ): Promise<WorkerFilesystemDirectoryListResult> => {
      try {
        const scope = requireDesktopScope(params.scope);
        const result = await services.listFileTreeDirectory({
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          repoId: params.fileRootId,
          relativeDir: params.relativePath,
        });
        projectionCapture?.captureDirectory(result);
        return {
          entries: result.entries.map((entry) => ({
            name: entry.name,
            relativePath: entry.relativePath,
            kind: entry.kind,
            isIgnored: entry.isIgnored,
            isIndexExcluded: entry.isIndexExcluded,
            isSymlink: entry.isSymlink,
            hasChildren: entry.hasChildren,
          })),
          ...(result.ignoreStateUnknown === true && {
            ignoreStateUnknown: true,
          }),
        };
      } catch (error) {
        throw translateFilesServiceError(error);
      }
    },
  };
}
