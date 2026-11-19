import { readFile } from 'node:fs/promises';
import type * as path from 'node:path';
import { AppErrorErrnoSchema } from '@canopy/protocol/app-errors';
import type { CanopyWorkspaceScope } from '@canopy/protocol/canopy-core';
import {
  COWORK_WORKSPACE_FILE_ROOT_ID,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/protocol/ui-labels';
import {
  classifyPersistedWorkspaceOwner,
  normalizeUuid,
} from '@canopy/protocol/workspace-owner';
import { CanopyOperationError } from '../../runtime/errors';
import { isErrnoException } from '../w5/maintenance-guards';
import {
  readWorkspaceIndex,
  readWorkspaceManifest,
  readWorktreeList,
  type WorkspaceFileRead,
  type WorkspaceIndexReadEntry,
} from '../workspace/read-formats';
import {
  buildCoworkRootCatalog,
  buildMultiRepoRootCatalog,
  buildSingleRepoRootCatalog,
  readRootVisibility,
  resolveCoworkWorkspaceRootName,
  type AttachmentsRootSource,
  type FilesystemRootCatalog,
  type NamedRootPath,
} from './root-catalog';
import { isUnreadablePathError } from './unreadable-path-error';

export interface FilesystemScopeDependencies {
  dataRoot: string;
  authorityId: string;
  targetId: string;
  organizationId?: string;
  paths: Pick<
    typeof path,
    'join' | 'resolve' | 'isAbsolute' | 'sep' | 'basename'
  >;
  coworkManagedDirName: string;
  readFile?(this: void, absolutePath: string): Promise<WorkspaceFileRead>;
  rootIdentity(this: void, absolutePath: string): Promise<string>;
  rootVisibility?(this: void, absolutePath: string): Promise<boolean>;
}

/** The `worker.filesystem.<operation>.*` namespace a scope failure uses. */
export type FilesystemReadOperation =
  | 'roots'
  | 'directory'
  | 'file'
  | 'search'
  | 'link';

export interface FilesystemScopeCatalog extends FilesystemRootCatalog {
  containerCreatedAt: string | null;
  /** Host-private source, even while hidden from the visible catalog. */
  attachmentSource: AttachmentsRootSource;
}

export function filesystemScopeError(
  operation: FilesystemReadOperation,
  reason:
    | 'invalidState'
    | 'notFound'
    | 'revisionConflict'
    | 'snapshotUnavailable',
  cause?: unknown,
): CanopyOperationError {
  // Only an allowlisted system code crosses, never its message or path.
  const errno =
    isErrnoException(cause) && AppErrorErrnoSchema.safeParse(cause.code).success
      ? cause.code
      : undefined;
  return new CanopyOperationError(
    {
      kind:
        reason === 'notFound'
          ? 'not_found'
          : reason === 'revisionConflict'
            ? 'conflict'
            : 'failed_precondition',
      code: `worker.filesystem.${operation}.${reason}`,
      message:
        reason === 'revisionConflict'
          ? 'Filesystem roots changed. Refresh the roots and retry.'
          : reason === 'notFound'
            ? 'The selected filesystem scope no longer exists.'
            : reason === 'snapshotUnavailable'
              ? 'The workspace records or roots for this filesystem scope could not be read.'
              : 'The selected filesystem scope cannot be resolved from trusted workspace records.',
      ...(errno !== undefined && { details: { errno } }),
      retry:
        reason === 'revisionConflict'
          ? { kind: 'after_refresh', resource: 'filesystem-roots' }
          : { kind: 'never' },
    },
    cause,
  );
}

/**
 * Whether a scope failure is a catalog the system refused to read (`EACCES`,
 * `EIO`), not a missing or invalid one.
 */
export function isFilesystemSnapshotUnavailable(
  error: unknown,
): error is CanopyOperationError {
  return (
    error instanceof CanopyOperationError &&
    error.payload.code?.startsWith('worker.filesystem.') === true &&
    error.payload.code.endsWith('.snapshotUnavailable')
  );
}

/**
 * A `snapshotUnavailable` failure for an operation outside the filesystem
 * namespace, which can't declare its code: the same failure and errno
 * without the code.
 */
export function filesystemSnapshotFailure(
  error: CanopyOperationError,
): CanopyOperationError {
  const { kind, message, details, retry } = error.payload;
  return new CanopyOperationError(
    { kind, message, ...(details !== undefined && { details }), retry },
    error.runtimeCause,
  );
}

async function readScopeFile(absolutePath: string): Promise<WorkspaceFileRead> {
  try {
    return { state: 'present', raw: await readFile(absolutePath, 'utf8') };
  } catch (error) {
    // A record the system refused to read is neither absent nor malformed.
    if (isUnreadablePathError(error)) throw error;
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

/** The scope's record reader; a read the system refused is `snapshotUnavailable`. */
function scopeFileReader(
  dependencies: Pick<FilesystemScopeDependencies, 'readFile'>,
  operation: FilesystemReadOperation,
): (absolutePath: string) => Promise<WorkspaceFileRead> {
  const read = dependencies.readFile ?? readScopeFile;
  return async (absolutePath) => {
    try {
      return await read(absolutePath);
    } catch (error) {
      if (isUnreadablePathError(error))
        throw filesystemScopeError(operation, 'snapshotUnavailable', error);
      throw error;
    }
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    /^[a-z0-9][a-z0-9-]*$/.test(value)
  );
}

/** A brand's managed Cowork folder name, such as `.canopy`. */
export const COWORK_MANAGED_DIR_NAME_PATTERN = /^\.[a-z0-9-]+$/;

type ScopeFailure = (reason?: 'invalidState' | 'notFound') => never;

/** Persisted organization id, or `undefined` for Personal; malformed fails closed. */
function persistedOrganizationId(
  config: Record<string, unknown>,
  fail: ScopeFailure,
): string | undefined {
  const owner = classifyPersistedWorkspaceOwner(config.owner);
  if (owner.kind === 'malformed') return fail();
  return owner.kind === 'organization' ? owner.owner.organizationId : undefined;
}

/** Selects trusted tracking without treating invalid selection or I/O as missing display metadata. */
export function readFilesystemWorkspaceIndexEntry(
  workspaceId: string,
  input: WorkspaceFileRead,
  operation: FilesystemReadOperation = 'roots',
): WorkspaceIndexReadEntry<string> {
  const fail = (
    reason: 'invalidState' | 'notFound' = 'invalidState',
  ): never => {
    throw filesystemScopeError(operation, reason);
  };
  if (!safeId(workspaceId)) fail();
  const index = readWorkspaceIndex(input, () => undefined);
  if (index.authority === 'unreadable') fail();
  const matches = index.entries.filter((entry) => entry.id === workspaceId);
  if (
    index.unreadableEntries.some(
      (entry) => typeof entry.id !== 'string' || entry.id === workspaceId,
    )
  )
    fail();
  if (matches.length === 0) fail('notFound');
  if (matches.length !== 1) fail();
  return matches[0] ?? fail();
}

/**
 * Selects one tracked workspace and reads its manifest. Every selector is
 * validated before the first read, so an unsafe id never reaches a path join.
 */
async function readSelectedManifest(
  scope: CanopyWorkspaceScope,
  dependencies: Omit<FilesystemScopeDependencies, 'organizationId'>,
  fail: ScopeFailure,
  operation: FilesystemReadOperation,
): Promise<{
  workspaceId: string;
  name: string;
  type: unknown;
  base: string;
  config: Record<string, unknown>;
}> {
  const { paths, dataRoot } = dependencies;
  if (
    !paths.isAbsolute(dataRoot) ||
    !safeId(scope.workspaceId) ||
    (scope.worktreeId !== undefined && !safeId(scope.worktreeId)) ||
    (scope.authorityId !== undefined &&
      scope.authorityId !== dependencies.authorityId) ||
    (scope.targetId !== undefined &&
      scope.targetId !== dependencies.targetId) ||
    (scope.organizationId !== undefined &&
      normalizeUuid(scope.organizationId) === null)
  )
    fail();
  const workspaceId = scope.workspaceId;
  if (!workspaceId) return fail();
  const read = scopeFileReader(dependencies, operation);
  const selected = readFilesystemWorkspaceIndexEntry(
    workspaceId,
    await read(paths.join(dataRoot, 'workspaces', 'index.json')),
    // Retain the operation-specific error supplied by this reader.
    operation,
  );
  const base = paths.join(dataRoot, 'workspaces', workspaceId);
  const manifest = readWorkspaceManifest(
    await read(paths.join(base, 'workspace.json')),
  );
  if (manifest.authority === 'absent') return fail('notFound');
  if (manifest.authority !== 'ok') return fail();
  const config = manifest.document;
  const type =
    config.type === undefined
      ? typeof config.repoPath === 'string'
        ? 'single-repo'
        : 'multi-repo'
      : config.type;
  if (type !== selected.type) fail();
  for (const key of ['workspaceId', 'authorityId', 'targetId'] as const) {
    const expected = key === 'workspaceId' ? workspaceId : dependencies[key];
    if (config[key] !== undefined && config[key] !== expected) fail();
  }
  return { workspaceId, name: selected.name, type, base, config };
}

/**
 * The selected workspace's owning organization from its trusted manifest, or
 * `undefined` for Personal. A request's `organizationId` is only a selector
 * checked against the persisted owner; it never establishes ownership.
 */
export async function resolveFilesystemScopeOwner(
  scope: CanopyWorkspaceScope,
  dependencies: Omit<FilesystemScopeDependencies, 'organizationId'>,
  operation: FilesystemReadOperation = 'roots',
): Promise<string | undefined> {
  const fail: ScopeFailure = (reason = 'invalidState') => {
    throw filesystemScopeError(operation, reason);
  };
  const { config } = await readSelectedManifest(
    scope,
    dependencies,
    fail,
    operation,
  );
  const organizationId = persistedOrganizationId(config, fail);
  if (
    scope.organizationId !== undefined &&
    normalizeUuid(scope.organizationId) !== organizationId
  )
    fail();
  return organizationId;
}

/** Reads canonical tracking records only; never registers paths or changes W5 state. */
export async function readFilesystemScope(
  scope: CanopyWorkspaceScope,
  dependencies: FilesystemScopeDependencies,
  operation: FilesystemReadOperation = 'roots',
): Promise<FilesystemScopeCatalog> {
  const fail: ScopeFailure = (reason = 'invalidState') => {
    throw filesystemScopeError(operation, reason);
  };
  const { paths } = dependencies;
  if (
    scope.organizationId !== undefined &&
    normalizeUuid(scope.organizationId) !== dependencies.organizationId
  )
    fail();
  const { workspaceId, name, type, base, config } = await readSelectedManifest(
    scope,
    dependencies,
    fail,
    operation,
  );
  if (persistedOrganizationId(config, fail) !== dependencies.organizationId)
    fail();
  const read = scopeFileReader(dependencies, operation);
  const attachments = async (
    absolutePath: string,
  ): Promise<{ absolutePath: string; visible: boolean }> => ({
    absolutePath,
    visible: await (dependencies.rootVisibility ?? readRootVisibility)(
      absolutePath,
    ),
  });
  const absolute = (value: unknown): string =>
    typeof value === 'string' &&
    paths.isAbsolute(value) &&
    !value.includes('\0')
      ? paths.resolve(value)
      : fail();
  let catalog: FilesystemRootCatalog;
  let attachmentSource: AttachmentsRootSource;
  let containerCreatedAt: string | null = null;
  if (type === 'cowork') {
    const worktreeId = scope.worktreeId ?? 'home';
    const entries = await read(paths.join(base, 'work-entries.json'));
    if (entries.state === 'absent') {
      if (worktreeId !== 'home') fail('notFound');
    } else {
      if (entries.state !== 'present') return fail();
      let document: unknown;
      try {
        document = JSON.parse(entries.raw);
      } catch {
        return fail();
      }
      if (
        !record(document) ||
        document.version !== 1 ||
        !Array.isArray(document.entries)
      )
        return fail();
      const rows = document.entries.filter(
        (row: unknown) => record(row) && row.id === worktreeId,
      );
      if (
        document.entries.some(
          (row: unknown) => !record(row) || typeof row.id !== 'string',
        )
      )
        fail();
      if (worktreeId === 'home') {
        // A registered home collides with the legacy workspace-home selector.
        if (rows.length !== 0) fail();
      } else {
        if (rows.length === 0) fail('notFound');
        const selectedEntry: unknown = rows[0];
        if (
          rows.length !== 1 ||
          !record(selectedEntry) ||
          typeof selectedEntry.createdAt !== 'string' ||
          (selectedEntry.title !== undefined &&
            typeof selectedEntry.title !== 'string')
        )
          return fail();
        containerCreatedAt = selectedEntry.createdAt;
      }
    }
    const home =
      config.externalPath === undefined && config.folderPath === undefined
        ? paths.join(base, 'home')
        : absolute(config.externalPath ?? config.folderPath);
    if (
      !COWORK_MANAGED_DIR_NAME_PATTERN.test(dependencies.coworkManagedDirName)
    )
      fail();
    const managed = paths.join(home, dependencies.coworkManagedDirName);
    attachmentSource = await attachments(paths.join(managed, 'attachments'));
    catalog = buildCoworkRootCatalog({
      workspace: {
        id: COWORK_WORKSPACE_FILE_ROOT_ID,
        name: resolveCoworkWorkspaceRootName(
          name,
          paths.basename(home) || home,
        ),
        absolutePath: home,
      },
      notesPath: paths.join(managed, 'notes'),
      promptsPath: paths.join(managed, 'prompts'),
      attachments: attachmentSource,
    });
  } else {
    if (!scope.worktreeId) return fail();
    const list = readWorktreeList(
      await read(paths.join(base, 'worktrees.json')),
    );
    if (list.authority === 'absent') fail('notFound');
    if (list.authority !== 'ok') return fail();
    if (list.unreadableRowIds.includes(scope.worktreeId)) fail();
    const rows = list.worktrees.filter((row) => row.id === scope.worktreeId);
    if (rows.length === 0) fail(list.complete ? 'notFound' : 'invalidState');
    if (rows.length !== 1) fail();
    containerCreatedAt = rows[0]?.createdAt ?? fail();
    if (
      rows[0]?.workspaceId !== undefined &&
      rows[0].workspaceId !== workspaceId
    )
      fail();
    const home = paths.join(base, 'worktrees', scope.worktreeId);
    attachmentSource = await attachments(
      paths.join(base, 'attachments', scope.worktreeId),
    );
    if (type === 'single-repo') {
      catalog = buildSingleRepoRootCatalog({
        repo: { id: workspaceId, name: workspaceId, absolutePath: home },
        attachments: attachmentSource,
      });
    } else {
      if (config.repos !== undefined && !Array.isArray(config.repos))
        return fail();
      const repos: NamedRootPath[] = [];
      const rawRepos = Array.isArray(config.repos) ? config.repos : [];
      for (const repo of rawRepos) {
        if (
          !record(repo) ||
          !safeId(repo.id) ||
          typeof repo.name !== 'string' ||
          typeof repo.repoPath !== 'string'
        )
          return fail();
        repos.push({
          id: repo.id,
          name: repo.name,
          absolutePath: paths.join(home, 'repos', repo.id),
        });
      }
      catalog = buildMultiRepoRootCatalog({
        workspaceRoot: {
          id: WORKSPACE_ROOT_REPO_ID,
          name: WORKSPACE_ROOT_REPO_NAME,
          absolutePath: home,
          gitAware:
            typeof config.sourceRepoPath === 'string' &&
            Boolean(config.sourceRepoPath),
        },
        reposDir: paths.join(home, 'repos'),
        repos,
        attachments: attachmentSource,
      });
    }
  }
  if (scope.repoId !== undefined && !catalog.byId.has(scope.repoId))
    fail('notFound');
  return { ...catalog, containerCreatedAt, attachmentSource };
}
