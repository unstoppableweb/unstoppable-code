import { realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import {
  filesystemFileReadError,
  readFilesystemFile,
  resolveFilesystemLink,
  type FilesystemFileRead,
  type FilesystemFileReadIo,
  type FilesystemLinkBase,
  type FilesystemLinkIo,
  type FilesystemLinkResolved,
} from '@canopy/core-runtime/node';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  CanopyQueryHandlerMap,
  CanopyWorkspaceScope,
  WorkerFilesystemFileReadResult,
  WorkerFilesystemLinkResolveResult,
} from '@canopy/protocol/canopy-core';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  getFileBrowserRoots,
  type FileBrowserRootsResult,
} from '../lib/file-browser-roots';
import { validateId } from '../lib/validation';
import {
  requireDesktopScope,
  translateFilesServiceError,
} from './worker-filesystem-adapter';

export interface WorkerFilesystemReadServices {
  getFileBrowserRoots(
    projectId: string,
    worktreeId: string,
  ): Promise<FileBrowserRootsResult>;
}

/** Per-request hooks the legacy `file:read-content` projection installs. */
export interface WorkerFilesystemReadProjection {
  /** Roots the projection already read for this request's scope, if any. */
  roots(projectId: string, worktreeId: string): FileBrowserRootsResult | null;
  /** The engine's read, with the exact `mtimeMs` the legacy shape carries. */
  capture(read: FilesystemFileRead): void;
  /**
   * The host path of a markdown base the legacy `file-reference:resolve`
   * projection could not express as a root-relative file, if any. It never
   * crosses a binding.
   */
  linkHostBase?(): string | null;
  /** The engine's link resolution, with the matched root's trusted path. */
  captureLink?(resolved: FilesystemLinkResolved): void;
}

export interface WorkerFilesystemReadAdapterOptions {
  services?: WorkerFilesystemReadServices;
  projection?: WorkerFilesystemReadProjection;
  io?: FilesystemFileReadIo;
  linkIo?: FilesystemLinkIo;
}

type WorkerFilesystemReadHandlerMap = Pick<
  CanopyQueryHandlerMap,
  'worker.filesystem.file.read' | 'worker.filesystem.link.resolve'
>;

export const DEFAULT_FILE_READ_SERVICES: WorkerFilesystemReadServices = {
  getFileBrowserRoots,
};

/** The desktop preview cap `file:read-content` has always used. */
export const LEGACY_FILE_CONTENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Keeps typed `worker.filesystem.<namespace>.*` failures; any other failure
 * (a roots read, an ID check, an unexpected fs error) is translated as the
 * Files adapter translates it, with the original error as its runtime cause.
 */
function toFilesystemReadError(
  error: unknown,
  namespace: 'file' | 'link',
): unknown {
  if (
    error instanceof CanopyOperationError &&
    (error.payload.code === undefined ||
      error.payload.code.startsWith(`worker.filesystem.${namespace}.`))
  )
    return error;
  const translated = translateFilesServiceError(error);
  return new CanopyOperationError(
    translated.payload,
    translated.runtimeCause ?? error,
  );
}

/**
 * `worker.filesystem.file.read` on the desktop dispatcher. Roots come from
 * the desktop file-browser roots on every call (or from the legacy
 * projection that already read them); the read is the core-runtime engine.
 */
export function createWorkerFilesystemReadAdapter(
  options: WorkerFilesystemReadAdapterOptions = {},
): WorkerFilesystemReadHandlerMap {
  const services = options.services ?? DEFAULT_FILE_READ_SERVICES;
  /** The scope's desktop file-browser roots, or the projection's copy. */
  const readAdapterRoots = async (
    scope: CanopyWorkspaceScope,
  ): Promise<FileBrowserRootsResult> => {
    const { projectId, worktreeId } = requireDesktopScope(scope);
    validateId(projectId, 'projectId');
    validateId(worktreeId, 'worktreeId');
    // The sealed viewer reads through its no-follow replica reader only.
    if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
      throw new CanopyOperationError({
        kind: 'capability_unavailable',
        message:
          'The shared-container viewer reads files through its own reader.',
        retry: { kind: 'never' },
      });
    return (
      options.projection?.roots(projectId, worktreeId) ??
      (await services.getFileBrowserRoots(projectId, worktreeId))
    );
  };
  return {
    'worker.filesystem.file.read': async (
      params,
    ): Promise<WorkerFilesystemFileReadResult> => {
      try {
        const { roots } = await readAdapterRoots(params.scope);
        const read = await readFilesystemFile({
          roots: roots.map((root) => ({
            id: root.repoId,
            absolutePath: root.absolutePath,
          })),
          fileRootId: params.fileRootId,
          relativePath: params.relativePath,
          maxBytes: params.maxBytes,
          ...(options.io && { io: options.io }),
        });
        options.projection?.capture(read);
        return read.result;
      } catch (error) {
        throw toFilesystemReadError(error, 'file');
      }
    },
    'worker.filesystem.link.resolve': async (
      params,
    ): Promise<WorkerFilesystemLinkResolveResult> => {
      try {
        const { roots } = await readAdapterRoots(params.scope);
        const hostBase = options.projection?.linkHostBase?.() ?? null;
        const base: FilesystemLinkBase | undefined = params.base
          ? { kind: 'root', ...params.base }
          : hostBase !== null
            ? { kind: 'host', absolutePath: hostBase }
            : undefined;
        const resolved = await resolveFilesystemLink({
          roots: roots.map((root) => ({
            id: root.repoId,
            name: root.repoName,
            absolutePath: root.absolutePath,
          })),
          mode: params.mode,
          href: params.href,
          ...(base && { base }),
          ...(options.linkIo && { io: options.linkIo }),
        });
        options.projection?.captureLink?.(resolved);
        return resolved.result;
      } catch (error) {
        throw toFilesystemReadError(error, 'link');
      }
    },
  };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

function inside(path: string, root: string): boolean {
  return (
    path === root ||
    path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  );
}

/**
 * Host projection of a scoped `file:read-content` path onto a root identity.
 * The path is resolved as the legacy reader opened it (following symlinks)
 * and assigned to the deepest root whose resolved path contains it, so the
 * engine reads the same file. `null` is a path that does not exist, which
 * the legacy reader answered as missing before checking containment.
 */
export async function resolveLegacyFileReadIdentity(
  roots: FileBrowserRootsResult,
  absolutePath: string,
): Promise<{ fileRootId: string; relativePath: string } | null> {
  let target: string;
  try {
    target = await realpath(absolutePath);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  let owner: { fileRootId: string; relativePath: string } | null = null;
  let ownerDepth = -1;
  let isRoot = false;
  for (const root of roots.roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(root.absolutePath);
    } catch {
      continue;
    }
    if (!inside(target, resolvedRoot)) continue;
    if (target === resolvedRoot) {
      isRoot = true;
      continue;
    }
    if (resolvedRoot.length > ownerDepth) {
      ownerDepth = resolvedRoot.length;
      owner = {
        fileRootId: root.repoId,
        relativePath: relative(resolvedRoot, target).split(sep).join('/'),
      };
    }
  }
  if (owner) return owner;
  // A root directory has no root-relative path of its own.
  throw filesystemFileReadError(isRoot ? 'notRegularFile' : 'outsideRoots');
}
