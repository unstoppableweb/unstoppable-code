import {
  normalizeRepositoryCloneUrl,
  repositoryNameFromCloneUrl,
} from '@canopy/protocol/portal';
import { realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import type { W5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { acquireW5DesktopDeleteGate } from '@canopy/core-platform/w5-process-file-lock';
import { W5CommitRefusedError } from '@canopy/core-runtime/node/w5/commit-log/errors';
import { createW5KeyedOperationRunner } from '@canopy/core-runtime/node/w5/keyed-operation';
import {
  workspaceCreationDiagnosticsSchema,
  type WorkspaceCreationDiagnostics,
  type WorkspaceCreationRepository,
} from '@canopy/core-runtime/node/w5/commit-log/reservation-diagnostics';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { getDefaultWorkspaceClaudeMd } from '../../constants/workspace-templates';
import type {
  CanopyJsonFile,
  SidebarItem,
  WorkspaceCliRecord,
  WorkspaceRepoData,
} from '../../types';
import { hasManifestRepos } from '../lib/canopy-json';
import { assertImportFolderExists } from '../lib/import-folder';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import { getWorkspacesRootDir } from '../lib/workspace-cli-reads';
import { admitRoutedW5Storage } from './record-store';
import {
  acquireWorkspacePath,
  availableWorkspacePath,
  cloneWorkspaceSource,
  ensureWorkspaceSource,
  initializeWorkspaceSource,
  isWorkspaceGitRepository,
  readWorkspaceSource,
  workspacePathExists,
} from './workspace-create-effects';
import {
  allocateWorkspaceIdentity,
  assertWorkspaceImportable,
  assertWorkspaceBindingAvailable,
  matchingWorkspaceBinding,
  publishRoutedWorkspace,
  readWorkspaceCreationSnapshot,
  requireKnownWorkspaceBindings,
  workspacePathHasRecordedOwner,
  resolveWorkspaceBindings,
  workspaceIdBase,
} from './workspace-create-records';
import { assertNoConflictingW5Reservation } from './worktree-delete-records';

export class CliWorkspaceDestinationExistsError extends Error {
  readonly code = 'EEXIST';
  readonly reason = 'destination-exists';
  constructor(readonly path: string) {
    super(`Destination already exists: ${path}`);
    this.name = 'CliWorkspaceDestinationExistsError';
  }
}

export type RoutedWorkspaceCreateRequest =
  | { kind: 'import'; repoPath: string }
  | { kind: 'remote'; remoteUrl: string; destinationDir: string }
  | { kind: 'single' | 'multi'; name: string };

/** Borrowed by remote→manifest preparation; never opens/closes a store or lease. */
export interface RoutedWorkspaceCreateContext {
  store: W5CommitLogFileStore;
  idempotencyKey: string;
  signal: AbortSignal;
  /** The CLI single-repo command keeps its source-file initialization contract. */
  initializationProfile?: 'cli';
}

function decodeWorkspaceOutcome(value: unknown): WorkspaceCliRecord {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.record))
    throw new Error('The saved project result is unreadable.');
  const record = value.record;
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.color !== 'string' ||
    typeof record.order !== 'number' ||
    !Number.isSafeInteger(record.order) ||
    typeof record.collapsed !== 'boolean' ||
    typeof record.rootPath !== 'string' ||
    (record.type !== 'cowork' &&
      record.type !== 'single-repo' &&
      record.type !== 'multi-repo') ||
    !Array.isArray(record.repos) ||
    !Array.isArray(record.worktrees) ||
    record.worktrees.length !== 0 ||
    record.worktreeCount !== 0 ||
    record.repoCount !== record.repos.length ||
    (record.repoPath !== undefined && typeof record.repoPath !== 'string') ||
    (record.sourceRepoPath !== undefined &&
      typeof record.sourceRepoPath !== 'string')
  )
    throw new Error('The saved project result is unreadable.');
  const repos: WorkspaceCliRecord['repos'] = record.repos.map(
    (repo: unknown) => {
      if (
        !isRecord(repo) ||
        typeof repo.id !== 'string' ||
        typeof repo.name !== 'string' ||
        typeof repo.repoPath !== 'string' ||
        (repo.source !== undefined &&
          repo.source !== 'local' &&
          repo.source !== 'manifest') ||
        (repo.manifestUrl !== undefined && typeof repo.manifestUrl !== 'string')
      )
        throw new Error('The saved project repository is unreadable.');
      return {
        id: repo.id,
        name: repo.name,
        repoPath: repo.repoPath,
        ...(repo.source !== undefined && { source: repo.source }),
        ...(repo.manifestUrl !== undefined && {
          manifestUrl: repo.manifestUrl,
        }),
      };
    },
  );
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    color: record.color,
    order: record.order,
    collapsed: record.collapsed,
    rootPath: record.rootPath,
    ...(record.repoPath !== undefined && { repoPath: record.repoPath }),
    ...(record.sourceRepoPath !== undefined && {
      sourceRepoPath: record.sourceRepoPath,
    }),
    repoCount: repos.length,
    worktreeCount: 0,
    repos,
    worktrees: [],
  };
}

function normalizeRequest(
  request: RoutedWorkspaceCreateRequest,
  profile?: 'cli',
): RoutedWorkspaceCreateRequest {
  if (request.kind === 'import')
    return { ...request, repoPath: resolve(request.repoPath) };
  if (request.kind === 'remote')
    return {
      ...request,
      remoteUrl: normalizeRepositoryCloneUrl(request.remoteUrl.trim()),
      destinationDir: resolve(request.destinationDir),
    };
  return {
    ...request,
    name:
      request.kind === 'single' && profile === 'cli'
        ? request.name
        : request.name.trim(),
  };
}

function assertRepositoryDirectoryName(name: string): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('\0') ||
    name !== posix.basename(name) ||
    name !== win32.basename(name)
  )
    throw new Error('Repository name must be a single directory name.');
}

function remoteRepositoryDirectoryName(remoteUrl: string): string {
  const remotePath = /^[a-z][a-z\d+.-]*:\/\//i.test(remoteUrl)
    ? remoteUrl.replace(/[?#].*$/s, '')
    : /^[^/\\]+@[^/\\]+:/.test(remoteUrl)
      ? remoteUrl.slice(remoteUrl.indexOf(':') + 1)
      : remoteUrl;
  const literalPath = remotePath.replace(/\/+$/, '');
  // Validate before URL parsing can normalize dot segments or split separators.
  assertRepositoryDirectoryName(
    literalPath
      .split('/')
      .pop()
      ?.replace(/\.git$/i, '') ?? '',
  );
  const name = repositoryNameFromCloneUrl(
    literalPath.replace(/\.git$/i, '.git'),
  );
  assertRepositoryDirectoryName(name);
  return name;
}

/** One authoritative admission, one provisioning pass, then fresh publication decisions. */
export function createRoutedCliWorkspace(
  request: RoutedWorkspaceCreateRequest,
  context: RoutedWorkspaceCreateContext,
): Promise<WorkspaceCliRecord> {
  const normalized = normalizeRequest(request, context.initializationProfile);
  const { store, signal } = context;
  let identity: string | undefined;
  let name = '';
  let source = '';
  let cowork = false;
  let manifest: CanopyJsonFile | null = null;
  let diagnostics: WorkspaceCreationDiagnostics | undefined;
  const keyed = createW5KeyedOperationRunner({
    getReceiptStore: () => ({
      lookupReceipt: (
        receipt,
      ): ReturnType<W5CommitLogFileStore['lookupReceipt']> =>
        store.lookupReceipt(receipt),
      releaseReservation: (id): Promise<void> => store.releaseReservation(id),
      markReservationRecoveryRequired: (id, failure): Promise<void> =>
        store.markReservationRecoveryRequired(id, failure),
      reserve: async (input): Promise<void> => {
        // Receipt lookup has already happened. A replay never touches a source path.
        signal.throwIfAborted();
        if (normalized.kind === 'import') {
          await assertImportFolderExists(normalized.repoPath);
          source = normalized.repoPath;
          cowork = !(await isWorkspaceGitRepository(source));
          if (cowork) source = await realpath(source);
          manifest = cowork ? null : await readWorkspaceSource(source);
          name = basename(source) || 'Repository';
        } else if (normalized.kind === 'remote') {
          if (!normalized.remoteUrl)
            throw new Error('Repository URL is required.');
          remoteRepositoryDirectoryName(normalized.remoteUrl);
          source = normalized.destinationDir;
          name = basename(source);
          if (!name) throw new Error('Destination directory is required.');
          if (await workspacePathExists(source))
            throw new CliWorkspaceDestinationExistsError(source);
        } else {
          name = normalized.name;
          if (!name) throw new Error('Project name is required.');
          source = join(getCanopyDataDir(), 'repos', workspaceIdBase(name));
        }
        const conflictedIdentities: string[] = [];
        // Identity conflicts are returned no-decision refusals. Only admission is retried.
        for (let attempt = 1; ; attempt += 1) {
          signal.throwIfAborted();
          const snapshot = await readWorkspaceCreationSnapshot(store);
          if (normalized.kind === 'remote')
            requireKnownWorkspaceBindings(snapshot);
          if (normalized.kind === 'import')
            await assertWorkspaceImportable(snapshot, source, cowork);
          if (
            snapshot.entries.length + 4 + 2 * (manifest?.repos?.length ?? 0) >
            256
          )
            throw new Error(
              'The atomic project publication exceeds the record limit.',
            );
          identity = await allocateWorkspaceIdentity(
            store,
            name,
            snapshot.entries,
            conflictedIdentities,
          );
          await assertNoConflictingW5Reservation(
            store,
            identity,
            undefined,
            'core.worktree.delete',
          );
          for (const member of manifest?.repos ?? []) {
            assertRepositoryDirectoryName(member.name);
            workspaceIdBase(member.name);
          }
          diagnostics = {
            kind: 'local-workspace-create',
            workspaceId: identity,
            ownedPaths: [],
            phase: 'before-canonical-commit',
            repositories: [],
          };
          try {
            await store.reserve({
              ...input,
              workspaceIdentity: identity,
              diagnostics,
            });
            return;
          } catch (error) {
            if (
              !(error instanceof W5CommitRefusedError) ||
              error.reason !== 'identity-conflict' ||
              attempt >= 3
            )
              throw error;
            conflictedIdentities.push(identity);
          }
        }
      },
    }),
  });
  return admitRoutedW5Storage(
    [
      { namespace: 'workspace_index', writer: 'desktop_cli' },
      { namespace: 'workspace_manifest', writer: 'desktop_cli' },
      { namespace: 'worktree_list', writer: 'desktop_cli' },
    ],
    () =>
      keyed(
        {
          caller:
            normalized.kind === 'import' || normalized.kind === 'remote'
              ? 'workspace-import'
              : 'workspace-create',
          operation:
            normalized.kind === 'import' || normalized.kind === 'remote'
              ? 'core.workspace.import'
              : 'core.workspace.create',
          idempotencyKey: context.idempotencyKey,
          parameters: context.initializationProfile
            ? {
                ...normalized,
                initializationProfile: context.initializationProfile,
              }
            : normalized,
          isPreEffectRefusal: () => false,
          hold: async (run) => {
            const gate = await acquireW5DesktopDeleteGate(
              getCanopyDataDir(),
              'desktop',
            );
            try {
              signal.throwIfAborted();
              return await run();
            } finally {
              gate.close();
            }
          },
        },
        decodeWorkspaceOutcome,
        async (binding, attempt) => {
          const id = identity;
          const reservationId = binding.reservationId;
          if (!id || !reservationId || !diagnostics)
            throw new Error('Missing workspace identity reservation.');
          const instructions = getDefaultWorkspaceClaudeMd(name);
          const record = async (
            step: WorkspaceCreationRepository,
          ): Promise<void> => {
            if (step.status === 'planned' || step.status === 'started')
              signal.throwIfAborted();
            if (!diagnostics) throw new Error('Missing creation diagnostics.');
            const rows = (diagnostics.repositories ?? []).filter(
              (row) => row.id !== step.id || row.role !== step.role,
            );
            diagnostics = workspaceCreationDiagnosticsSchema.parse({
              ...diagnostics,
              phase:
                step.role === 'member'
                  ? 'member-import'
                  : step.action === 'clone'
                    ? 'remote-clone'
                    : 'source-initialization',
              ownedPaths: [
                ...new Set([
                  ...diagnostics.ownedPaths,
                  ...(step.owned && step.status !== 'planned'
                    ? [step.path]
                    : []),
                ]),
              ],
              repositories: [...rows, step],
            });
            await store.updateReservationDiagnostics(
              reservationId,
              diagnostics,
            );
          };
          const provision = async (
            base: string,
            preferredName: string,
            repoId: string,
            role: 'source' | 'member',
            action: 'initialize' | 'clone',
            url?: string,
            exactDestination = false,
          ): Promise<string> => {
            // Only exclusive mkdir claims ownership; a rival advances the disk suffix.
            for (
              let attemptNumber = 1;
              attemptNumber <= 10000;
              attemptNumber += 1
            ) {
              signal.throwIfAborted();
              const snapshot = await readWorkspaceCreationSnapshot(store);
              const candidate = exactDestination
                ? join(base, preferredName)
                : await availableWorkspacePath(
                    base,
                    preferredName,
                    async (path) =>
                      !(await workspacePathHasRecordedOwner(snapshot, path)),
                  );
              if (
                exactDestination &&
                (await workspacePathHasRecordedOwner(snapshot, candidate))
              )
                throw attempt.validationError(
                  new CliWorkspaceDestinationExistsError(candidate),
                );
              await record({
                id: repoId,
                role,
                action,
                owned: true,
                path: candidate,
                status: 'planned',
              });
              attempt.beforeEffects();
              try {
                await acquireWorkspacePath(candidate, signal);
              } catch (error) {
                if (
                  typeof error !== 'object' ||
                  error === null ||
                  Reflect.get(error, 'code') !== 'EEXIST' ||
                  Reflect.get(error, 'path') !== candidate
                )
                  throw error;
                if (exactDestination)
                  throw attempt.confirmEffectsAbsent(
                    new CliWorkspaceDestinationExistsError(candidate),
                  );
                continue;
              }
              const step = {
                id: repoId,
                role,
                action,
                owned: true,
                path: candidate,
              } as const;
              await record({ ...step, status: 'acquired' });
              await record({ ...step, status: 'started' });
              signal.throwIfAborted();
              if (action === 'clone') {
                if (!url) throw new Error('Missing clone URL.');
                await cloneWorkspaceSource(url, candidate, signal);
              } else
                await initializeWorkspaceSource(
                  candidate,
                  name,
                  normalized.kind === 'multi',
                  instructions,
                  signal,
                  context.initializationProfile,
                );
              await record({ ...step, status: 'completed' });
              return candidate;
            }
            throw new Error('No available project directory.');
          };
          if (normalized.kind === 'remote') {
            source = await provision(
              dirname(normalized.destinationDir),
              basename(normalized.destinationDir),
              'source',
              'source',
              'clone',
              normalized.remoteUrl,
              true,
            );
            manifest = await readWorkspaceSource(source);
          } else if (
            normalized.kind === 'single' ||
            normalized.kind === 'multi'
          ) {
            source = await provision(
              join(getCanopyDataDir(), 'repos'),
              workspaceIdBase(name),
              'source',
              'source',
              'initialize',
            );
            manifest = await readWorkspaceSource(source);
          } else {
            await record({
              id: 'source',
              role: 'source',
              action: 'import',
              owned: false,
              status: 'completed',
            });
          }
          if (!cowork && manifest === null) {
            signal.throwIfAborted();
            attempt.beforeEffects();
            manifest = await ensureWorkspaceSource(source, signal);
          }
          const repos: WorkspaceRepoData[] = [];
          if (!cowork && hasManifestRepos(manifest)) {
            const snapshot = await readWorkspaceCreationSnapshot(store);
            for (const member of manifest.repos) {
              assertRepositoryDirectoryName(member.name);
              workspaceIdBase(member.name);
            }
            if (snapshot.entries.length + 4 + 2 * manifest.repos.length > 256)
              throw new Error(
                'The atomic project publication exceeds the record limit.',
              );
            for (const member of manifest.repos) {
              signal.throwIfAborted();
              const current = await readWorkspaceCreationSnapshot(store);
              await resolveWorkspaceBindings(current);
              const reused = matchingWorkspaceBinding(
                current.bindings,
                member.url,
              );
              if (reused)
                await assertWorkspaceBindingAvailable(
                  store,
                  current.bindings,
                  reused.path,
                );
              const path =
                reused?.path ??
                (await provision(
                  join(getCanopyDataDir(), 'repos'),
                  member.name,
                  member.id,
                  'member',
                  'clone',
                  member.url,
                ));
              if (reused)
                await record({
                  id: member.id,
                  role: 'member',
                  action: 'import',
                  owned: false,
                  status: 'completed',
                });
              repos.push({
                id: member.id,
                name: reused?.name ?? member.name,
                repoPath: path,
                source: 'manifest',
                manifestUrl: member.url,
                scripts: member.scripts,
                hooks: member.hooks,
              });
            }
          }
          const common = { id, name, color: '', collapsed: false, order: 0 };
          const item: SidebarItem = cowork
            ? { ...common, type: 'cowork', externalPath: source }
            : hasManifestRepos(manifest)
              ? {
                  ...common,
                  type: 'multi-repo',
                  sourceRepoPath: source,
                  repos,
                  worktrees: [],
                }
              : {
                  ...common,
                  type: 'single-repo',
                  repoPath: source,
                  worktrees: [],
                };
          if (normalized.kind === 'multi') {
            const sidecar = {
              id: 'instructions',
              role: 'source',
              action: 'initialize',
              owned: true,
              path: join(getWorkspacesRootDir(), id),
            } as const;
            await record({ ...sidecar, status: 'planned' });
            signal.throwIfAborted();
            attempt.beforeEffects();
            await acquireWorkspacePath(sidecar.path, signal);
            await record({ ...sidecar, status: 'acquired' });
            await record({ ...sidecar, status: 'started' });
            signal.throwIfAborted();
            // Non-W5 sidecar must finish before the keyed success becomes replayable.
            await writeFile(join(sidecar.path, 'CLAUDE.md'), instructions, {
              flag: 'wx',
            });
            await record({ ...sidecar, status: 'completed' });
          }
          return publishRoutedWorkspace({
            store,
            binding,
            item,
            imported:
              normalized.kind === 'import' || normalized.kind === 'remote',
            signal,
          });
        },
      ),
  );
}
