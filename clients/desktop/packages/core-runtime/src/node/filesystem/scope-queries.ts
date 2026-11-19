import {
  type CanopyWorkspaceScope,
  type WorkerFilesystemRootsListParams,
  type WorkerFilesystemRootsListResult,
  type WorkerFilesystemDirectoryListParams,
  type WorkerFilesystemDirectoryListResult,
  type WorkerFilesystemFileReadParams,
  type WorkerFilesystemFileReadResult,
  type WorkerFilesystemSearchParams,
  type WorkerFilesystemSearchResult,
  type WorkerFilesystemLinkResolveParams,
  type WorkerFilesystemLinkResolveResult,
} from '@canopy/protocol/canopy-core';
import { isSafeFilesystemRelativePath } from './relative-path';
import { CanopyOperationError } from '../../runtime/errors';
import { createCatalogRevision } from './catalog-revision';
import {
  readFilesystemDirectory,
  type DirectoryReadOptions,
} from './directory-reader';
import {
  encodedFileReadResultBytes,
  filesystemFileReadError,
  readFilesystemFile,
  type FilesystemFileReadIo,
} from './file-reader';
import {
  filesystemSearchError,
  type FilesystemSearchEngine,
  type FilesystemSearchInputs,
  type FilesystemSearchPage,
} from './file-search';
import { resolveFilesystemLink, type FilesystemLinkIo } from './link-resolver';
import { readRootVisibility, type FilesystemRootCatalog } from './root-catalog';
import {
  readFilesystemScope,
  filesystemScopeError,
  isFilesystemSnapshotUnavailable,
  type FilesystemReadOperation,
  type FilesystemScopeDependencies,
} from './scope-reader';
import { isUnreadablePathError } from './unreadable-path-error';

async function snapshot(
  scope: CanopyWorkspaceScope,
  dependencies: FilesystemScopeDependencies,
  operation: FilesystemReadOperation,
): Promise<{ catalog: FilesystemRootCatalog; catalogRevision: string }> {
  // Visibility is a view of directory contents, not part of the trusted root mapping.
  const catalog = await readFilesystemScope(
    scope,
    { ...dependencies, rootVisibility: () => Promise.resolve(true) },
    operation,
  );
  const key = JSON.stringify([
    dependencies.authorityId,
    dependencies.targetId,
    dependencies.organizationId ?? null,
    scope.workspaceId,
    scope.worktreeId ?? null,
    catalog.containerCreatedAt,
  ]);
  try {
    return {
      catalog,
      catalogRevision: await createCatalogRevision(catalog, dependencies, key),
    };
  } catch (error) {
    // A root identity the system refused to read is not an invalid scope.
    throw isUnreadablePathError(error)
      ? filesystemScopeError(operation, 'snapshotUnavailable', error)
      : filesystemScopeError(operation, 'invalidState');
  }
}

/** Opt-in adapters must refuse unversioned daemon results, without a legacy fallback. */
export function requireFilesystemCatalogRevision(
  result: { catalogRevision?: unknown },
  operation: FilesystemReadOperation,
): string {
  if (
    typeof result.catalogRevision !== 'string' ||
    result.catalogRevision.length === 0 ||
    result.catalogRevision.length > 128
  ) {
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      code: `worker.filesystem.${operation}.invalidState`,
      message:
        'This filesystem response has no supported catalog revision. Update the daemon before using trusted filesystem reads.',
      retry: { kind: 'never' },
    });
  }
  return result.catalogRevision;
}

/** R4 supplies local projection; this guard re-resolves authority without relisting a directory. */
export async function withVerifiedFilesystemCatalog<Result>(
  scope: CanopyWorkspaceScope,
  catalogRevision: string,
  dependencies: FilesystemScopeDependencies,
  operation: FilesystemReadOperation,
  project: (catalog: FilesystemRootCatalog) => Promise<Result>,
): Promise<Result> {
  const current = async (): Promise<Awaited<ReturnType<typeof snapshot>>> => {
    try {
      return await snapshot(scope, dependencies, operation);
    } catch (error) {
      // A catalog that can't be read is not a changed one: a refresh would
      // fail the same way, so the caller must not retry on it.
      if (isFilesystemSnapshotUnavailable(error)) throw error;
      throw filesystemScopeError(operation, 'revisionConflict');
    }
  };
  const before = await current();
  if (before.catalogRevision !== catalogRevision)
    throw filesystemScopeError(operation, 'revisionConflict');
  const result = await project(before.catalog);
  if ((await current()).catalogRevision !== catalogRevision)
    throw filesystemScopeError(operation, 'revisionConflict');
  return result;
}

export async function listFilesystemScopeRoots(
  params: WorkerFilesystemRootsListParams,
  dependencies: FilesystemScopeDependencies,
): Promise<WorkerFilesystemRootsListResult> {
  const initial = await snapshot(params.scope, dependencies, 'roots');
  if (
    params.catalogRevision !== undefined &&
    params.catalogRevision !== initial.catalogRevision
  )
    throw filesystemScopeError('roots', 'revisionConflict');
  return withVerifiedFilesystemCatalog(
    params.scope,
    initial.catalogRevision,
    dependencies,
    'roots',
    async (catalog) => {
      const visible = await Promise.all(
        catalog.roots.map(
          async (root) =>
            root.kind !== 'attachments' ||
            (await (dependencies.rootVisibility ?? readRootVisibility)(
              root.absolutePath,
            )),
        ),
      );
      return {
        catalogRevision: initial.catalogRevision,
        roots: catalog.roots
          .filter((_root, index) => visible[index])
          .map((root) => ({
            fileRootId: root.id,
            name: root.name,
            kind: root.kind,
          })),
      };
    },
  );
}

export async function listFilesystemScopeDirectory(
  params: WorkerFilesystemDirectoryListParams,
  dependencies: FilesystemScopeDependencies,
  options: DirectoryReadOptions,
): Promise<WorkerFilesystemDirectoryListResult> {
  if (
    params.relativePath.includes('\0') ||
    (params.relativePath !== '' &&
      !isSafeFilesystemRelativePath(params.relativePath))
  )
    throw filesystemScopeError('directory', 'invalidState');
  const initial = await snapshot(params.scope, dependencies, 'directory');
  if (
    params.catalogRevision !== undefined &&
    params.catalogRevision !== initial.catalogRevision
  )
    throw filesystemScopeError('directory', 'revisionConflict');
  return withVerifiedFilesystemCatalog(
    params.scope,
    initial.catalogRevision,
    dependencies,
    'directory',
    async (catalog) => {
      const root = catalog.byId.get(params.fileRootId);
      if (!root) throw filesystemScopeError('directory', 'notFound');
      const ignore = { unknown: false };
      const entries = await readFilesystemDirectory(root, params.relativePath, {
        ...options,
        onIgnoreStateUnknown: () => {
          ignore.unknown = true;
        },
      }).catch((error: unknown) => {
        throw filesystemScopeError('directory', 'invalidState', error);
      });
      return {
        catalogRevision: initial.catalogRevision,
        ...(ignore.unknown && { ignoreStateUnknown: true }),
        entries: entries.map((entry) => ({
          name: entry.name,
          relativePath: entry.relativePath,
          kind: entry.kind,
          isIgnored: entry.isIgnored,
          isIndexExcluded: entry.isIndexExcluded,
          isSymlink: entry.isSymlink,
          hasChildren: entry.hasChildren,
        })),
      };
    },
  );
}

export interface FilesystemScopeFileReadOptions {
  /**
   * The JSON-encoded result budget of the binding that carries the result;
   * omitted on an unframed in-process host.
   */
  readonly maxResultBytes?: number;
  readonly io?: FilesystemFileReadIo;
}

/**
 * `worker.filesystem.file.read` over the trusted scope catalog: the read runs
 * between two catalog resolutions and any root of the scope may contain the
 * resolved file.
 */
export async function readFilesystemScopeFile(
  params: WorkerFilesystemFileReadParams,
  dependencies: FilesystemScopeDependencies,
  options: FilesystemScopeFileReadOptions = {},
): Promise<WorkerFilesystemFileReadResult> {
  const initial = await snapshot(params.scope, dependencies, 'file');
  if (
    params.catalogRevision !== undefined &&
    params.catalogRevision !== initial.catalogRevision
  )
    throw filesystemScopeError('file', 'revisionConflict');
  const result = await withVerifiedFilesystemCatalog(
    params.scope,
    initial.catalogRevision,
    dependencies,
    'file',
    async (catalog) => {
      const read = await readFilesystemFile({
        roots: catalog.roots,
        fileRootId: params.fileRootId,
        relativePath: params.relativePath,
        maxBytes: params.maxBytes,
        ...(options.io && { io: options.io }),
      });
      return { ...read.result, catalogRevision: initial.catalogRevision };
    },
  );
  if (
    options.maxResultBytes !== undefined &&
    encodedFileReadResultBytes(result) > options.maxResultBytes
  )
    throw filesystemFileReadError('tooLarge');
  return result;
}

export interface FilesystemScopeSearchOptions {
  /** The open walks cursors continue; one per host. */
  readonly engine: FilesystemSearchEngine;
  /** The request's matcher and Git ignore listing, read per new walk. */
  readonly inputs: () => Promise<FilesystemSearchInputs>;
  /** The JSON-encoded page budget of the binding that carries the result. */
  readonly maxResultBytes?: number;
  readonly signal?: AbortSignal;
}

/**
 * `worker.filesystem.search` over the trusted scope catalog. Every page runs
 * between two catalog resolutions, and a cursor continues only under the
 * revision its walk started under. Walk failures are `invalidState`.
 */
export async function searchFilesystemScope(
  params: WorkerFilesystemSearchParams,
  dependencies: FilesystemScopeDependencies,
  options: FilesystemScopeSearchOptions,
): Promise<WorkerFilesystemSearchResult> {
  if (params.mode !== 'name') throw filesystemSearchError('modeUnavailable');
  const initial = await snapshot(params.scope, dependencies, 'search');
  if (
    params.catalogRevision !== undefined &&
    params.catalogRevision !== initial.catalogRevision
  )
    throw filesystemScopeError('search', 'revisionConflict');
  return withVerifiedFilesystemCatalog(
    params.scope,
    initial.catalogRevision,
    dependencies,
    'search',
    async (catalog) => {
      let page: FilesystemSearchPage;
      try {
        page = await options.engine.search(params, {
          resolve: async () => {
            const root = catalog.byId.get(params.fileRootId);
            if (!root) throw filesystemSearchError('notFound');
            return { root, inputs: await options.inputs() };
          },
          revision: initial.catalogRevision,
          ...(options.maxResultBytes !== undefined && {
            maxResultBytes: options.maxResultBytes,
          }),
          ...(options.signal && { signal: options.signal }),
        });
      } catch (error) {
        if (error instanceof CanopyOperationError) throw error;
        options.signal?.throwIfAborted();
        throw filesystemScopeError('search', 'invalidState', error);
      }
      return { ...page.result, catalogRevision: initial.catalogRevision };
    },
  );
}

/**
 * `worker.filesystem.link.resolve` over the trusted scope catalog: the
 * resolution runs between two catalog resolutions, against every root of
 * the scope in catalog order.
 */
export async function resolveFilesystemScopeLink(
  params: WorkerFilesystemLinkResolveParams,
  dependencies: FilesystemScopeDependencies,
  options: { readonly io?: FilesystemLinkIo } = {},
): Promise<WorkerFilesystemLinkResolveResult> {
  const initial = await snapshot(params.scope, dependencies, 'link');
  if (
    params.catalogRevision !== undefined &&
    params.catalogRevision !== initial.catalogRevision
  )
    throw filesystemScopeError('link', 'revisionConflict');
  return withVerifiedFilesystemCatalog(
    params.scope,
    initial.catalogRevision,
    dependencies,
    'link',
    async (catalog) => {
      const resolved = await resolveFilesystemLink({
        roots: catalog.roots,
        mode: params.mode,
        href: params.href,
        ...(params.base && { base: { kind: 'root', ...params.base } }),
        ...(options.io && { io: options.io }),
      });
      return { ...resolved.result, catalogRevision: initial.catalogRevision };
    },
  );
}
