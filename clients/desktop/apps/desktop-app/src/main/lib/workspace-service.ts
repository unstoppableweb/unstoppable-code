import { CloneCancelledError } from '../services/clone-jobs';
import { w5CompositionLocks } from './w5-composition-operation';
import { commitW5BoundaryStep } from './w5-composition-operation';
import type { W5CommitOptions } from './w5-commit-scope';
import {
  commitWorkspaceCreation,
  recordWorkspaceCreationRepository,
  withLocalWorkspaceCreation,
  reserveWorkspaceCreation,
  pendingWorkspaceCreationIds,
  pendingWorkspaceCreationPaths,
  workspaceCreationPathOccupied,
  markWorkspaceCreationEffectsStarted,
  type WorkspaceCreationReservationOptions,
} from './w5-workspace-creation-commit';
import { getW5IdentityStore } from './w5-commit-log-file-store';
import { isW5CaptureWorkspaceId } from '../w5-commit-log/commit-log-worker-contract';
import { runInW5CapturedView } from './w5-read-view';
import { fingerprintW5File } from '@canopy/core-runtime/node/w5/commit-log/fingerprint';
import {
  CompositionRecordRefusedError,
  createTemporaryCompositionRecords,
  indexTemporaryCompositionWorkspace,
  cleanupCompositionDestination,
} from './workspace-composition-records';
import { normalizeWorkspaceOwner } from '@canopy/execution-engine/lib/workspace-owner';
import type {
  BoundCopyRepository,
  MultiRepoSetupRepository,
} from './org-project-setup-journal';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type AddWorkspaceFromFolderCheck,
  type CheckAddWorkspaceFromFolderRequest,
  type MultiRepoSidebarItem,
  type SidebarItem,
  type SingleRepoSidebarItem,
  type WorkspaceCliRecord,
  type WorkspaceConfigFile,
  type WorkspaceImportFromRepoResponse,
} from '@canopy/desktop-shared/types';
import { PROJECT_COLORS } from '@canopy/desktop-shared/constants/project-colors';
import { getDefaultWorkspaceClaudeMd } from '@canopy/desktop-shared/constants/workspace-templates';
import { assertImportFolderExists } from '@canopy/desktop-shared/node/lib/import-folder';
import { getGitCommonDir, getRemoteUrl, isGitRepo } from './git';
import {
  cloneRepositoryThroughWorker,
  initializeRepositoryThroughWorker,
} from '../canopy-runtime/worker-git-repository-creation-dispatch';
import {
  getDataDir,
  getDefaultReposDir,
  getWorkspaceClaudeMdPath,
  getWorkspaceDir,
} from './paths';
import { validateId } from './validation';
import {
  redactRemoteUrlCredentials,
  type GitCloneProgressUpdate,
} from './git-clone-progress';
import { readAllSidebarItems, readWorkspaceIndexEntry } from './sidebar-items';
import {
  applyWorkspaceAdditionDecision,
  applyWorkspaceCreationDecision,
} from './workspace-creation-decision-port';
import type { DesktopWorkspaceCreateTypes } from '@canopy/desktop-shared/node/worktree-record-decisions';
import {
  acquireKeyedLock,
  cloneRemoteWorkspace,
  commitNewWorkspace,
  importManifestWorkspace,
  refuseTrackedRepository,
  refuseWorkspaceCreation,
  stageWorkspaceAddition,
  type TrackedRepositoryRemote,
  type WorkspaceImportPorts,
  type WorkspaceRootRemote,
} from '@canopy/core-runtime/node/workspace/create-orchestration';
import { getSidebarItemsPreserveWorkspaceIds } from './sidebar-items-preservation';
import { slugify } from './string-utils';
import {
  allocateSafeWorkspaceId,
  safeWorkspaceIdBase,
} from '@canopy/core-runtime/node/identifiers';
import { pathExists } from './fs-utils';
import { PROJECT_W5_STORAGE, withStorageAdmission } from './w5-storage';
import { isPathInside } from './path-safety';
import {
  hasManifestRepos,
  readCanopyJson,
  writeCanopyJson,
} from './canopy-json';
import { normalizeRemoteUrl, remoteUrlsMatch } from './repo-url-matcher';
import { reserveUniqueDestination } from './unique-destination';
import {
  readWorkspaceConfig,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';
import { prepareNewWorkspaceSourceRepo } from './workspace-source-control';
import { refreshOrganizationOwner } from './workspace-ownership';
import { ensureAgentsMdSymlink } from './instruction-files';
import { scaffoldWorkspaceInstructions } from '@canopy/core-runtime/node/workspace/workspace-instructions';
import { createExternalCoworkWorkspace } from './cowork-workspace-crud';
import {
  ownsWorkspaceMutation,
  serializeWorkspaceMutation,
} from './chat-project-operation-queue';
import { sanitizeWorkspaceSourceRepoName } from '@canopy/desktop-shared/node/lib/workspace-source-repo';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

const splitDestinationWorkspaceLocks = new Map<string, Promise<void>>();
let splitDestinationWorkspaceCreationLock: Promise<void> | undefined;

/** Ends the project clones that have no clone job, which the app's quit would otherwise orphan. */
const untrackedClonesStop = new AbortController();

/**
 * Stops those clones' `git` at quit, as `shutdownCloneJobs` stops clone jobs.
 * Their checkout and creation record stay for launch recovery.
 */
export function stopUntrackedWorkspaceClones(): void {
  untrackedClonesStop.abort();
}

async function withSplitDestinationWorkspaceLock<T>(
  identityKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireKeyedLock(
    splitDestinationWorkspaceLocks,
    identityKey,
  );
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function withSplitDestinationWorkspaceCreationLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = splitDestinationWorkspaceCreationLock;
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  splitDestinationWorkspaceCreationLock = current;
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (splitDestinationWorkspaceCreationLock === current) {
      splitDestinationWorkspaceCreationLock = undefined;
    }
  }
}

function getNextSidebarColor(itemCount: number): string {
  return PROJECT_COLORS[itemCount % PROJECT_COLORS.length];
}

/** The desktop's ports for core create orchestration (CAN-4096 C1, C2). */
const createPorts: WorkspaceImportPorts<
  DesktopWorkspaceCreateTypes,
  AddWorkspaceFromRemoteProgress
> = {
  serialize: (operation, cancellation) =>
    serializeWorkspaceMutation(operation, cancellation),
  ownsSerialization: () => ownsWorkspaceMutation(),
  plan: {
    readItems: async () => (await readAllSidebarItems()).items,
    singleRepoItem: ({ id, name, repoPath, order }) => ({
      type: 'single-repo',
      id,
      name,
      repoPath,
      color: getNextSidebarColor(order),
      worktrees: [],
      collapsed: false,
      order,
    }),
    multiRepoItem: ({ id, name, repos, sourceRepoPath, order }) => ({
      type: 'multi-repo',
      id,
      name,
      color: getNextSidebarColor(order),
      repos,
      worktrees: [],
      collapsed: false,
      order,
      sourceRepoPath,
      scripts: undefined,
    }),
    manifestRepositories: (members) =>
      members.map(({ id, name, repoPath, manifestUrl }) => ({
        id,
        name,
        repoPath,
        source: 'manifest',
        manifestUrl,
      })),
    availableWorkspaceId: (name, taken) =>
      buildAvailableWorkspaceId(name, taken),
    trackingWorkspaceName: (items, repoPath) =>
      findTrackedWorkspaceForRepoPath(items, repoPath)?.name,
    manifestSourceWorkspaceName: (items, repoPath) =>
      items.find(
        (item) =>
          item.type === 'multi-repo' && item.sourceRepoPath === repoPath,
      )?.name,
    repositoryRemotes: (items) => resolveExistingRepoBindings(items),
    workspaceRootRemotes: (items) => resolveExistingWorkspaceBindings(items),
  },
  reservation: {
    commit: (publish, workspaceIds) =>
      commitWorkspaceCreation(publish, workspaceIds),
    markEffectsStarted: () => markWorkspaceCreationEffectsStarted(),
    reserveLocal: (workspaceId, ownedPaths, work, expectedWorkspaceRecords) =>
      withLocalWorkspaceCreation(
        workspaceId,
        [getWorkspaceDir(workspaceId), ...ownedPaths],
        work,
        { expectedWorkspaceRecords },
      ),
    reserve: (workspaceId, ownedPaths, options) =>
      reserveWorkspaceCreation(
        workspaceId,
        [getWorkspaceDir(workspaceId), ...ownedPaths],
        options,
      ),
    recordRepository: (repository) =>
      recordWorkspaceCreationRepository(repository),
  },
  decisions: { applyWorkspaceAdditionDecision, applyWorkspaceCreationDecision },
  git: {
    clone: async (url, destination, progress) => {
      await (progress
        ? cloneRepositoryThroughWorker({
            kind: 'live-progress',
            url,
            destination,
            signal: progress.signal,
            onProgress: progress.onProgress,
          })
        : cloneRepositoryThroughWorker({
            kind: 'clone',
            url,
            destination,
            signal: untrackedClonesStop.signal,
          }));
    },
    cancelled: () => new CloneCancelledError(),
    normalizeRemote: (url) => normalizeRemoteUrl(url),
    sameRemote: (left, right) => remoteUrlsMatch(left, right),
    redactCredentials: (url) => redactRemoteUrlCredentials(url),
  },
  files: {
    readManifestMembers: async (repoPath) => {
      const manifest = await readCanopyJson(repoPath);
      return hasManifestRepos(manifest) ? (manifest.repos ?? []) : undefined;
    },
    managedReposDirectory: () => getDefaultReposDir(),
    uniqueDestination: (directory, preferredName) =>
      ensureUniqueDestination(directory, preferredName),
    createDestination: async (parentDirectory, destination) => {
      await mkdir(parentDirectory, { recursive: true });
      await mkdir(destination);
    },
    ensureSingleRepoManifest: (repoPath) =>
      ensureSingleRepoCanopyJson(repoPath),
  },
};

function isVisibleWorkspaceItem(item: SidebarItem): boolean {
  return !isRetiredTemporaryWorkspace(item);
}

async function readExistingSidebarItems(options?: {
  includeEmptyTemporary?: boolean;
  persistRemovalCleanup?: false;
}): Promise<SidebarItem[]> {
  const { items } =
    options?.persistRemovalCleanup === false
      ? await readAllSidebarItems({ persistRemovalCleanup: false })
      : await readAllSidebarItems();
  return options?.includeEmptyTemporary === true
    ? items
    : items.filter(isVisibleWorkspaceItem);
}

/**
 * Workspace IDs held for creations that register their workspace only after
 * long work, such as a cloud project setup that clones first (CAN-5192).
 * Every ID this module allocates skips them. A live hold covers an ID from
 * its allocation until its holder records it durably; a registered holder
 * lists the IDs it has recorded, so they stay held across launches.
 */
const heldWorkspaceIds = new Set<string>();
const workspaceIdentityHolders = new Set<() => Promise<readonly string[]>>();

/** Adds a durable holder of workspace IDs; the returned function removes it. */
export function registerWorkspaceIdentityHolder(
  holder: () => Promise<readonly string[]>,
): () => void {
  workspaceIdentityHolders.add(holder);
  return (): void => {
    workspaceIdentityHolders.delete(holder);
  };
}

export interface WorkspaceIdentityHold {
  readonly workspaceId: string;
  /** Ends the live hold; the ID stays held while a holder still lists it. */
  release(this: void): void;
}

/**
 * Allocates an ID for a workspace a caller registers later and holds it, in
 * the workspace mutation queue every allocation here serializes through. The
 * caller registers it with that explicit ID, and releases the hold once its
 * own durable record holds the ID or it gives the creation up.
 */
export function holdAvailableWorkspaceId(
  workspaceName: string,
): Promise<WorkspaceIdentityHold> {
  return serializeWorkspaceMutation(async () => {
    const items = await readExistingSidebarItems({
      includeEmptyTemporary: true,
    });
    const workspaceId = await buildAvailableWorkspaceId(workspaceName, items);
    heldWorkspaceIds.add(workspaceId);
    return {
      workspaceId,
      release: (): void => {
        heldWorkspaceIds.delete(workspaceId);
      },
    };
  });
}

async function heldWorkspaceIdentities(): Promise<string[]> {
  const listed = await settleAll(
    [...workspaceIdentityHolders].map((holder) => holder()),
  );
  return [...heldWorkspaceIds, ...listed.flat()];
}

async function buildAvailableWorkspaceId(
  workspaceName: string,
  existingItems: ReadonlyArray<Pick<SidebarItem, 'id'>>,
): Promise<string> {
  const reservedItems = [
    ...existingItems,
    ...(await pendingWorkspaceCreationIds()).map((id) => ({ id })),
    ...(await heldWorkspaceIdentities()).map((id) => ({ id })),
  ];
  while (true) {
    const candidate = buildWorkspaceId(workspaceName, reservedItems);
    const [indexEntry, directoryExists] = await settleAll([
      readWorkspaceIndexEntry(candidate),
      workspaceCreationPathOccupied(getWorkspaceDir(candidate)),
    ]);
    if (!indexEntry && !directoryExists) {
      return candidate;
    }
    reservedItems.push({ id: candidate });
  }
}

async function ensureUniqueDestination(
  baseDir: string,
  preferredName: string,
): Promise<string> {
  let candidate = join(baseDir, preferredName);
  let suffix = 2;
  const pendingPaths = new Set(await pendingWorkspaceCreationPaths());

  while (
    candidate === resolve(baseDir) ||
    pendingPaths.has(candidate) ||
    // A dangling symlink still occupies the path; exclusive mkdir would refuse it.
    (await workspaceCreationPathOccupied(candidate))
  ) {
    candidate = join(baseDir, `${preferredName}-${suffix}`);
    suffix += 1;
  }

  return candidate;
}

export function buildWorkspaceId(
  workspaceName: string,
  existingItems: ReadonlyArray<Pick<SidebarItem, 'id'>>,
): string {
  const existingIds = new Set(existingItems.map((item) => item.id));
  const workspaceId = allocateSafeWorkspaceId(workspaceName, existingIds);
  validateId(workspaceId, 'project id');
  return workspaceId;
}

function deriveTemporaryWorkspaceName(
  repos: WorkspaceConfigFile['repos'],
): string {
  if (repos.length === 0) {
    return 'Temporary project';
  }
  if (repos.length === 1) {
    return repos[0].name;
  }
  if (repos.length === 2) {
    return `${repos[0].name} & ${repos[1].name}`;
  }
  const head = repos
    .slice(0, repos.length - 1)
    .map((repo) => repo.name)
    .join(', ');
  return `${head} & ${repos[repos.length - 1].name}`;
}

export function createTemporaryMultiRepoWorkspace(
  ...args: Parameters<typeof createAdmittedTemporaryWorkspace>
): Promise<MultiRepoSidebarItem> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    createAdmittedTemporaryWorkspace(...args),
  );
}

async function createAdmittedTemporaryWorkspace(
  repos: WorkspaceConfigFile['repos'],
  options?: {
    repoIdentityKeys?: string[];
    sourceWorkspaceIds?: string[];
    commit?: W5CommitOptions;
  },
): Promise<MultiRepoSidebarItem> {
  return serializeWorkspaceMutation(async () => {
    const items = await readExistingSidebarItems({
      includeEmptyTemporary: true,
    });
    const name = deriveTemporaryWorkspaceName(repos);
    const id = await buildAvailableWorkspaceId(name, items);
    const wsDir = getWorkspaceDir(id);
    markWorkspaceCreationEffectsStarted();
    await mkdir(wsDir, { recursive: true });

    const workspace: MultiRepoSidebarItem = {
      type: 'multi-repo',
      id,
      name,
      color: getNextSidebarColor(items.length),
      repos,
      worktrees: [],
      collapsed: false,
      order: items.length,
      temporary: true,
      alwaysShow: false,
      ...(options?.sourceWorkspaceIds
        ? { temporarySourceWorkspaceIds: options.sourceWorkspaceIds }
        : {}),
      ...(options?.repoIdentityKeys
        ? { temporaryRepoIdentityKeys: options.repoIdentityKeys }
        : {}),
    };

    let seeded = false;
    try {
      await commitW5BoundaryStep(
        options?.commit,
        options?.commit
          ? w5CompositionLocks({ manifests: [id], lists: [id] })
          : [],
        () =>
          createTemporaryCompositionRecords({
            source: 'temporary_workspace_create',
            workspace,
          }),
      );
      seeded = true;
      await scaffoldWorkspaceInstructions(
        { content: getDefaultWorkspaceClaudeMd(name), agentsMdAlias: true },
        {
          writeClaudeMd: (content) =>
            writeFile(getWorkspaceClaudeMdPath(id), content, 'utf8'),
          ensureAgentsMdAlias: () => ensureAgentsMdSymlink(wsDir),
        },
      );
      await commitW5BoundaryStep(
        options?.commit,
        options?.commit ? w5CompositionLocks({ index: true }) : [],
        () =>
          indexTemporaryCompositionWorkspace({
            source: 'temporary_workspace_create',
            workspace,
          }),
      );
      // Refresh the type registry and known sidebar ids after the index commit.
      await readAllSidebarItems();
      return workspace;
    } catch (error) {
      if (seeded || !(error instanceof CompositionRecordRefusedError)) {
        await cleanupCompositionDestination({
          source: 'temporary_workspace_create',
          workspaceId: id,
        });
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  });
}

/** Applies the addition core builds through the record decision port (W6a1). */
async function stageAddedWorkspace(
  persisted: SidebarItem,
  previousItems: SidebarItem[],
  preserveWorkspaceIds: string[],
  scoped: boolean,
): Promise<SidebarItem> {
  const written = await stageWorkspaceAddition(createPorts.decisions, {
    item: persisted,
    previousItems,
    preserveWorkspaceIds,
    scoped,
  });
  const added = written.items.find((item) => item.id === persisted.id);
  if (!added) throw new WorkspaceConfigUnreadableError();
  return added;
}

async function persistAddedWorkspace(
  item: SidebarItem,
  commit?: W5CommitOptions,
): Promise<SidebarItem> {
  return serializeWorkspaceMutation(async () => {
    const sidebarItems = await readAllSidebarItems();
    const persisted = { ...item, order: sidebarItems.items.length };
    return commitW5BoundaryStep(
      commit,
      commit
        ? w5CompositionLocks({
            index: true,
            manifests: [item.id],
            lists: [item.id],
          })
        : [],
      () =>
        stageAddedWorkspace(
          persisted,
          sidebarItems.items,
          getSidebarItemsPreserveWorkspaceIds(sidebarItems),
          !!commit,
        ),
    );
  });
}

async function resolveExistingWorkspaceBindings(
  items: SidebarItem[],
): Promise<WorkspaceRootRemote[]> {
  const repoPaths = items.flatMap((item) => {
    if (item.type === 'single-repo') return [item.repoPath];
    if (item.type === 'cowork' || !item.sourceRepoPath) return [];
    return [item.sourceRepoPath];
  });

  return settleAll(
    repoPaths.map(async (repoPath) => ({
      repoPath,
      remoteUrl: await getRemoteUrl(repoPath),
    })),
  );
}

async function resolveExistingRepoBindings(
  items: SidebarItem[],
): Promise<TrackedRepositoryRemote[]> {
  const candidates = items.flatMap((item) => {
    if (item.type === 'single-repo') {
      return [{ repoName: item.name, repoPath: item.repoPath }];
    }

    if (item.type === 'cowork') {
      return [];
    }

    return item.repos.map((repo) => ({
      repoName: repo.name,
      repoPath: repo.repoPath,
    }));
  });

  return settleAll(
    candidates.map(async (candidate) => ({
      repoName: candidate.repoName,
      repoPath: candidate.repoPath,
      remoteUrl: await getRemoteUrl(candidate.repoPath),
    })),
  );
}

export async function ensureSingleRepoCanopyJson(
  repoPath: string,
): Promise<void> {
  const existing = await readCanopyJson(repoPath);
  if (existing === null) {
    markWorkspaceCreationEffectsStarted();
    await writeCanopyJson(repoPath, { version: 1 });
    return;
  }

  if (Object.prototype.hasOwnProperty.call(existing, 'repos')) {
    throw new Error(
      'Single-repo projects must not contain a "repos" field in canopy.json',
    );
  }
}

export async function listWorkspaceItems(options?: {
  includeEmptyTemporary?: boolean;
  persistRemovalCleanup?: false;
}): Promise<SidebarItem[]> {
  return readExistingSidebarItems(options);
}

export async function getWorkspaceItem(
  workspaceId: string,
): Promise<SidebarItem> {
  validateId(workspaceId, 'workspaceId');
  const items = await readExistingSidebarItems({ includeEmptyTemporary: true });
  const item = items.find((candidate) => candidate.id === workspaceId);
  if (!item) {
    throw new Error(`Project ${workspaceId} not found`);
  }
  return item;
}

async function resolveRealPath(candidatePath: string): Promise<string> {
  return realpath(candidatePath).catch(() => resolve(candidatePath));
}

function collectWorkspaceRootPaths(items: SidebarItem[]): string[] {
  const rootPaths: string[] = [];

  for (const item of items) {
    if (item.type === 'single-repo') {
      rootPaths.push(item.repoPath);
      continue;
    }

    if (item.type === 'multi-repo') {
      if (item.sourceRepoPath) {
        rootPaths.push(item.sourceRepoPath);
      }
      for (const repo of item.repos) {
        rootPaths.push(repo.repoPath);
      }
      continue;
    }

    if (item.externalPath) {
      rootPaths.push(item.externalPath);
    }
  }

  return rootPaths;
}

/**
 * Guards importing a non-git folder as an external cowork workspace: rejects
 * folders that live inside the Canopy data directory, folders that
 * themselves contain the Canopy data directory, folders that are already
 * tracked verbatim by an existing workspace/repo, folders nested inside an
 * existing workspace's/repo's root path, and folders that themselves contain
 * an existing workspace's/repo's root path. The last two containment
 * directions matter because an agent operating inside a cowork workspace can
 * read/write anything nested under that workspace's root — so a folder that
 * contains the data dir or another workspace root would leak access to all
 * Canopy data or every git workspace nested under it. Comparisons use
 * resolved real paths so symlinked folders can't bypass the containment
 * checks.
 */
export async function assertFolderIsImportable(
  resolvedFolderPath: string,
  items: SidebarItem[],
  options: { readonly allowInsideDataDir?: boolean } = {},
): Promise<void> {
  const resolvedDataDir = await resolveRealPath(getDataDir());
  if (
    options.allowInsideDataDir !== true &&
    (resolvedFolderPath === resolvedDataDir ||
      isPathInside(resolvedDataDir, resolvedFolderPath))
  ) {
    refuseWorkspaceCreation(
      'not-importable',
      `Cannot add a folder inside the app data directory: ${resolvedFolderPath}`,
    );
  }

  if (
    options.allowInsideDataDir !== true &&
    isPathInside(resolvedFolderPath, resolvedDataDir)
  ) {
    refuseWorkspaceCreation(
      'not-importable',
      `Cannot add a folder that contains the app data directory: ${resolvedFolderPath}`,
    );
  }

  const existingRootPaths = await settleAll(
    collectWorkspaceRootPaths(items).map((rootPath) =>
      resolveRealPath(rootPath),
    ),
  );

  for (const existingRootPath of existingRootPaths) {
    if (resolvedFolderPath === existingRootPath) {
      refuseWorkspaceCreation(
        'already-tracked',
        `This folder is already tracked as a project: ${resolvedFolderPath}`,
      );
    }

    if (isPathInside(existingRootPath, resolvedFolderPath)) {
      refuseWorkspaceCreation(
        'not-importable',
        `Cannot add a folder nested inside an existing project: ${resolvedFolderPath}`,
      );
    }

    if (isPathInside(resolvedFolderPath, existingRootPath)) {
      refuseWorkspaceCreation(
        'not-importable',
        `Cannot add a folder that contains an existing project: ${resolvedFolderPath}`,
      );
    }
  }
}

function findTrackedWorkspaceForRepoPath(
  items: readonly SidebarItem[],
  repoPath: string,
): SidebarItem | undefined {
  return items.find(
    (item) =>
      (item.type === 'single-repo' && item.repoPath === repoPath) ||
      (item.type === 'multi-repo' && item.sourceRepoPath === repoPath),
  );
}

/** Read-only host check; import must still validate against the live registry. */
export async function checkAddWorkspaceFromFolder(
  request: CheckAddWorkspaceFromFolderRequest,
): Promise<AddWorkspaceFromFolderCheck> {
  const repoPath = request?.repoPath;
  if (typeof repoPath !== 'string' || !isAbsolute(repoPath)) {
    throw new Error('repoPath must be an absolute path');
  }
  if (!(await isGitRepo(repoPath))) {
    return { status: 'not-tracked' };
  }
  const items = await readExistingSidebarItems({ includeEmptyTemporary: true });
  const duplicate = findTrackedWorkspaceForRepoPath(items, repoPath);
  if (!duplicate) {
    return { status: 'not-tracked' };
  }
  if (
    findTrackedWorkspaceForRepoPath(
      items.filter((item) => item !== duplicate),
      repoPath,
    )
  ) {
    throw new Error('Repository has conflicting tracked workspace bindings');
  }
  const owner = duplicate.owner;
  return {
    status: 'already-tracked',
    workspaceId: duplicate.id,
    owner: owner
      ? {
          type: owner.type,
          organizationId: owner.organizationId,
          projectId: owner.projectId,
          instanceId: owner.instanceId,
          bindingGeneration: owner.bindingGeneration,
        }
      : null,
  };
}

export function importWorkspaceFromRepoPath(
  ...args: Parameters<typeof importAdmittedWorkspaceFromRepoPath>
): Promise<SidebarItem> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    importAdmittedWorkspaceFromRepoPath(...args),
  );
}

async function importAdmittedWorkspaceFromRepoPath(
  repoPath: string,
): Promise<SidebarItem> {
  if (!isAbsolute(repoPath)) {
    refuseWorkspaceCreation(
      'invalid-path',
      'repoPath must be an absolute path',
    );
  }

  await assertImportFolderExists(repoPath);
  const isRepo = await isGitRepo(repoPath);
  if (!isRepo) {
    const resolvedFolderPath = await resolveRealPath(repoPath);
    return serializeWorkspaceMutation(async () => {
      const items = await readExistingSidebarItems({
        includeEmptyTemporary: true,
      });
      await assertFolderIsImportable(resolvedFolderPath, items);
      return createExternalCoworkWorkspace(resolvedFolderPath);
    });
  }

  const manifest = await readCanopyJson(repoPath);
  if (hasManifestRepos(manifest)) {
    return (await importManifestWorkspace(createPorts, repoPath)).workspace;
  }

  return commitNewWorkspace(
    createPorts,
    async (items) => {
      assertRepositoryNotTracked(items, repoPath);
      // Only once the import is admitted (F7): a rejected import leaves the
      // user's repository untouched.
      const name = basename(repoPath);
      return createPorts.plan.singleRepoItem({
        id: await buildAvailableWorkspaceId(name, items),
        name,
        repoPath,
        order: items.length,
      });
    },
    { effects: () => ensureSingleRepoCanopyJson(repoPath) },
  );
}

function assertRepositoryNotTracked(
  items: readonly SidebarItem[],
  repoPath: string,
): void {
  refuseTrackedRepository(createPorts.plan, items, repoPath);
}

/**
 * Clone hooks for the interactive Add project flow. When present the clone
 * reports live progress and can be cancelled; without them the clone runs
 * exactly as it always has (portal and other callers).
 */
export interface AddWorkspaceFromRemoteProgress {
  signal: AbortSignal;
  /**
   * Called with the exclusively reserved checkout directory, and a release
   * for its creation identity once the caller has removed that directory.
   */
  onDestination: (
    path: string,
    releaseRemovedDestination: () => Promise<void>,
  ) => void;
  onProgress: (update: GitCloneProgressUpdate) => void;
  /** Called once the checkout is complete and the project is being added. */
  onCloned: () => void;
}

export function addWorkspaceFromRemote(
  ...args: Parameters<typeof addAdmittedWorkspaceFromRemote>
): Promise<SidebarItem> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    addAdmittedWorkspaceFromRemote(...args),
  );
}

function addAdmittedWorkspaceFromRemote(
  remoteUrl: string,
  destinationDir: string,
  progress?: AddWorkspaceFromRemoteProgress,
): Promise<SidebarItem> {
  return cloneRemoteWorkspace(createPorts, remoteUrl, destinationDir, progress);
}

/**
 * Register an existing on-disk repository as a single-repo project without
 * touching the repository itself. The bulk Claude/Codex import (CAN-2439)
 * promises to leave source folders unchanged, so unlike
 * `importWorkspaceFromRepoPath` this never writes `canopy.json`; the manifest
 * stays optional and is only read when it already exists. An exact path or
 * source-repo duplicate throws, matching the interactive add-folder flow.
 */
export function registerSingleRepoWorkspaceWithoutManifest(
  ...args: Parameters<typeof registerAdmittedSingleRepoWorkspace>
): Promise<SingleRepoSidebarItem> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    registerAdmittedSingleRepoWorkspace(...args),
  );
}

async function registerAdmittedSingleRepoWorkspace(
  repoPath: string,
  preferredName?: string,
): Promise<SingleRepoSidebarItem> {
  if (!isAbsolute(repoPath)) {
    refuseWorkspaceCreation(
      'invalid-path',
      'repoPath must be an absolute path',
    );
  }
  const manifest = await readCanopyJson(repoPath);
  if (hasManifestRepos(manifest)) {
    refuseWorkspaceCreation(
      'not-importable',
      'This repository declares a multi-repo project; add it from the sidebar instead',
    );
  }
  return withSplitDestinationWorkspaceCreationLock(async () => {
    // The caller's scan may be stale: re-verify the folder is still a
    // repository and still importable against the live registry.
    if (!(await isGitRepo(repoPath))) {
      refuseWorkspaceCreation(
        'not-a-repository',
        'This folder is no longer a git repository',
      );
    }
    return commitNewWorkspace(
      createPorts,
      async (items) => {
        assertRepositoryNotTracked(items, repoPath);
        await assertFolderIsImportable(await resolveRealPath(repoPath), items);
        const name = preferredName?.trim() || basename(repoPath);
        return createPorts.plan.singleRepoItem({
          id: await buildAvailableWorkspaceId(name, items),
          name,
          repoPath,
          order: items.length,
        });
      },
      {},
    );
  });
}

/**
 * Find-or-create the single-repo workspace tracking an existing on-disk repo.
 * Used by the temporary-workspace split flow, which needs a destination
 * workspace for each kept child repo. Unlike `importWorkspaceFromRepoPath`,
 * an exact single-repo duplicate is returned instead of throwing, and no
 * multi-repo `sourceRepoPath` duplicate check applies (the split destination
 * must be a single-repo workspace regardless).
 */
/**
 * The explicit workspace id a caller asked for belongs to something else.
 * Nothing was written when this is thrown, which is what lets a caller undo
 * whatever it had staged for that id.
 */
export class WorkspaceIdentityInUseError extends Error {
  constructor() {
    super('Workspace identity is already in use');
    this.name = 'WorkspaceIdentityInUseError';
  }
}

export async function findOrCreateSingleRepoWorkspaceForRepo(
  repoPath: string,
  preferredName?: string,
  options?: {
    splitDestinationLeaseHeld?: boolean;
    owner?: WorkspaceOwnerBinding;
    localWorkspaceId?: string;
    commit?: W5CommitOptions;
  },
): Promise<{ workspace: SingleRepoSidebarItem; created: boolean }> {
  if (!isAbsolute(repoPath)) {
    throw new Error('repoPath must be an absolute path');
  }
  const owner = normalizeWorkspaceOwner(options?.owner);
  if (options?.owner && !owner)
    throw new Error('Invalid organization workspace binding');
  if (options?.localWorkspaceId)
    validateId(options.localWorkspaceId, 'workspace id');
  const identityKey = await getGitCommonDir(repoPath);
  const findOrCreate = async (): Promise<{
    workspace: SingleRepoSidebarItem;
    created: boolean;
  }> => {
    return withSplitDestinationWorkspaceCreationLock(async () => {
      // Re-read, de-duplicate by repository identity, allocate the id, and
      // persist under one global creation lock. Identity-scoped locking alone
      // cannot prevent different repositories with the same preferred name
      // from allocating the same workspace id from the same sidebar snapshot.
      const items = await readExistingSidebarItems({
        includeEmptyTemporary: true,
      });
      for (const item of items) {
        if (item.type !== 'single-repo') {
          continue;
        }
        const itemIdentity = await getGitCommonDir(item.repoPath).catch(
          () => null,
        );
        if (itemIdentity === identityKey) {
          if (owner) {
            const existing = item.owner;
            const sameBinding =
              existing?.type === 'organization' &&
              existing.organizationId === owner.organizationId &&
              existing.projectId === owner.projectId &&
              existing.instanceId === owner.instanceId &&
              item.id === options?.localWorkspaceId;
            if (!sameBinding)
              throw new Error(
                'Existing workspace has a different organization binding',
              );
            // Same organization, project and instance: only the fence moved,
            // which is what a re-claim after an expired lease does. A fence
            // only ever advances, so a lower generation is a stale caller
            // rather than a re-claim, and letting it write would undo a
            // newer claim the server has already issued.
            //
            // The refresh is decided against `workspace.json`, not the sidebar
            // snapshot this loop is walking: the snapshot was read before the
            // lock and can already be behind, and the config is what is about
            // to be overwritten. So it is decided on the binding read inside
            // the config write queue, and it has to still be the same binding:
            // a file that changed underneath, or that cannot be read, is not
            // something to write an owner over (CAN-3819). The caller is told
            // what the workspace now says, not what the snapshot held.
            const persisted = await refreshOrganizationOwner({
              workspaceId: item.id,
              source: 'org_project_reclaim',
              owner,
            });
            return {
              workspace: { ...item, owner: persisted },
              created: false,
            };
          }
          return { workspace: item, created: false };
        }
      }

      if (!owner) await ensureSingleRepoCanopyJson(repoPath);
      const name = preferredName?.trim() || basename(repoPath);
      const workspaceId =
        options?.localWorkspaceId ??
        (await buildAvailableWorkspaceId(name, items));
      if (items.some((item) => item.id === workspaceId))
        throw new WorkspaceIdentityInUseError();
      // The projection above only shows workspaces that could be built from
      // their config. An id whose index entry exists but whose config write
      // never landed is invisible there, and if its directory is missing too
      // the id looks free — so the index itself is asked directly. Nothing
      // written down proves such an entry is this setup's, so it refuses.
      if (
        options?.localWorkspaceId &&
        (await readWorkspaceIndexEntry(workspaceId)) !== null
      )
        throw new WorkspaceIdentityInUseError();
      if (
        options?.localWorkspaceId &&
        (await pathExists(getWorkspaceDir(workspaceId)))
      ) {
        // A directory with no sidebar row may only be reused by the setup that
        // owns it, and owning it has to be written down: a missing or
        // unreadable `workspace.json` proves nothing about who put the
        // directory there, so it refuses like any other stranger.
        const existing = await readWorkspaceConfig(workspaceId).catch(
          () => null,
        );
        const existingOwner = existing?.owner;
        // The instance has to match too: another claim of the same project is
        // a different setup, and letting it adopt this directory would
        // overwrite the owner binding of a checkout it never made.
        const orphanOfThisSetup =
          owner &&
          existingOwner !== undefined &&
          existingOwner.type === 'organization' &&
          existingOwner.organizationId === owner.organizationId &&
          existingOwner.projectId === owner.projectId &&
          existingOwner.instanceId === owner.instanceId &&
          // And the fence still only moves forward here: a stale caller must
          // not revive a setup a newer server claim has already superseded by
          // writing its older generation over what is on disk.
          existingOwner.bindingGeneration <= owner.bindingGeneration;
        if (!orphanOfThisSetup) throw new WorkspaceIdentityInUseError();
      }
      const workspace = createPorts.plan.singleRepoItem({
        id: workspaceId,
        name,
        repoPath,
        order: items.length,
      });
      if (owner) workspace.owner = owner;
      const persisted = await persistAddedWorkspace(workspace, options?.commit);
      if (persisted.type !== 'single-repo') {
        throw new Error(
          'Destination project was persisted with an unexpected type',
        );
      }
      return { workspace: persisted, created: true };
    });
  };
  const admitted = (): ReturnType<typeof findOrCreate> =>
    withStorageAdmission(PROJECT_W5_STORAGE, findOrCreate);
  return options?.splitDestinationLeaseHeld
    ? admitted()
    : withSplitDestinationWorkspaceLock(identityKey, admitted);
}

/**
 * Hold the repository-identity lock across a complete split transaction.
 * This prevents another split from discovering a just-created destination
 * while its creator is still able to roll that workspace back.
 */
export async function acquireSplitDestinationWorkspaceLease(
  repoPath: string,
): Promise<() => void> {
  return acquireSplitDestinationWorkspaceLeases([repoPath]);
}

/** Acquire multiple identity leases in a stable order to avoid lock cycles. */
export async function acquireSplitDestinationWorkspaceLeases(
  repoPaths: string[],
): Promise<() => void> {
  for (const repoPath of repoPaths) {
    if (!isAbsolute(repoPath)) {
      throw new Error('repoPath must be an absolute path');
    }
  }
  const identityKeys = Array.from(
    new Set(await settleAll(repoPaths.map((path) => getGitCommonDir(path)))),
  ).sort();
  const releases: Array<() => void> = [];
  try {
    for (const identityKey of identityKeys) {
      releases.push(
        await acquireKeyedLock(splitDestinationWorkspaceLocks, identityKey),
      );
    }
  } catch (error) {
    for (const release of releases.reverse()) {
      release();
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    for (const release of releases.reverse()) {
      release();
    }
  };
}

export function createNewSingleRepoWorkspace(
  ...args: Parameters<typeof createAdmittedSingleRepoWorkspace>
): Promise<SidebarItem> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    createAdmittedSingleRepoWorkspace(...args),
  );
}

async function createAdmittedSingleRepoWorkspace(
  name: string,
): Promise<SidebarItem> {
  const normalizedName = name.trim();
  if (!normalizedName)
    refuseWorkspaceCreation('name-required', 'Project name is required');
  return commitNewWorkspace(
    createPorts,
    async (items) =>
      createPorts.plan.singleRepoItem({
        id: await buildAvailableWorkspaceId(normalizedName, items),
        name: normalizedName,
        repoPath: await ensureUniqueDestination(
          getDefaultReposDir(),
          safeWorkspaceIdBase(normalizedName),
        ),
        order: items.length,
      }),
    {
      ownedPaths: (item) =>
        item.type === 'single-repo' ? [item.repoPath] : [],
      effects: async (item) => {
        if (item.type !== 'single-repo')
          throw new Error('Unexpected workspace type');
        markWorkspaceCreationEffectsStarted();
        await mkdir(getDefaultReposDir(), { recursive: true });
        // Exclusive creation refuses a path replaced after planning; never adopt it.
        await mkdir(item.repoPath);
        await initializeRepositoryThroughWorker({
          kind: 'seeded',
          directory: item.repoPath,
          name: normalizedName,
        });
        await ensureSingleRepoCanopyJson(item.repoPath);
      },
    },
  );
}

/** Create a new empty repository folder without adding it to the sidebar. */
export async function initNewLocalRepoFolder(name: string): Promise<string> {
  const normalizedName = name.trim();
  if (!normalizedName) {
    refuseWorkspaceCreation('name-required', 'Project name is required');
  }
  const destinationRoot = getDefaultReposDir();
  markWorkspaceCreationEffectsStarted();
  await mkdir(destinationRoot, { recursive: true });
  // Reserved atomically, so two creates of one name never share a folder.
  const destinationPath = await reserveUniqueDestination(
    destinationRoot,
    slugify(normalizedName) || 'workspace',
  );
  await initializeRepositoryThroughWorker({
    kind: 'seeded',
    directory: destinationPath,
    name: normalizedName,
  });
  await ensureSingleRepoCanopyJson(destinationPath);
  return destinationPath;
}

/**
 * Prepare a new multi-repo workspace's instructions and source repo before
 * canonical publication. Workspace serialization covers id allocation (D12);
 * the later W5 scope publishes its manifest, list and index together (D11).
 */
async function prepareNewMultiRepoWorkspace(
  id: string,
  normalizedName: string,
  plannedSourceRepoPath: string,
): Promise<string> {
  const wsDir = getWorkspaceDir(id);
  markWorkspaceCreationEffectsStarted();
  await mkdir(dirname(wsDir), { recursive: true });
  await mkdir(wsDir);
  const config: WorkspaceConfigFile = {
    version: 1,
    type: 'multi-repo',
    repos: [],
  };
  // Unchanged: this local copy has never had an AGENTS.md alias.
  await scaffoldWorkspaceInstructions(
    {
      content: getDefaultWorkspaceClaudeMd(normalizedName),
      agentsMdAlias: false,
    },
    {
      writeClaudeMd: (content) =>
        writeFile(getWorkspaceClaudeMdPath(id), content, 'utf8'),
      ensureAgentsMdAlias: () => ensureAgentsMdSymlink(wsDir),
    },
  );
  return prepareNewWorkspaceSourceRepo(
    id,
    normalizedName,
    config,
    plannedSourceRepoPath,
  );
}

/**
 * Create a multi-repo workspace and index it in one commit (CAN-3806 D11). An
 * uncertain failure retains the identity and files for manual recovery.
 */
export function createAndPersistNewMultiRepoWorkspace(
  ...args: Parameters<typeof createAndPersistAdmittedMultiRepoWorkspace>
): Promise<MultiRepoSidebarItem> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    createAndPersistAdmittedMultiRepoWorkspace(...args),
  );
}

async function createAndPersistAdmittedMultiRepoWorkspace(
  name: string,
): Promise<MultiRepoSidebarItem> {
  const normalizedName = name.trim();
  if (!normalizedName) {
    refuseWorkspaceCreation('name-required', 'Project name is required');
  }
  return commitNewWorkspace(
    createPorts,
    async (items) => {
      const id = await buildAvailableWorkspaceId(normalizedName, items);
      const sourceRepoPath = await ensureUniqueDestination(
        getDefaultReposDir(),
        sanitizeWorkspaceSourceRepoName(normalizedName),
      );
      return createPorts.plan.multiRepoItem({
        id,
        name: normalizedName,
        repos: [],
        sourceRepoPath,
        order: items.length,
      });
    },
    {
      ownedPaths: (item) => (item.sourceRepoPath ? [item.sourceRepoPath] : []),
      effects: async (item) => {
        if (!item.sourceRepoPath)
          throw new Error('Missing planned source repository');
        await recordWorkspaceCreationRepository({
          id: 'source',
          role: 'source',
          owned: true,
          path: item.sourceRepoPath,
          action: 'initialize',
          status: 'started',
        });
        item.sourceRepoPath = await prepareNewMultiRepoWorkspace(
          item.id,
          normalizedName,
          item.sourceRepoPath,
        );
        await recordWorkspaceCreationRepository({
          id: 'source',
          role: 'source',
          owned: true,
          path: item.sourceRepoPath,
          action: 'initialize',
          status: 'completed',
        });
      },
    },
  );
}

export function importMultiRepoWorkspaceManifestFromRepo(
  ...args: Parameters<typeof importAdmittedWorkspaceManifest>
): Promise<WorkspaceImportFromRepoResponse> {
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    importAdmittedWorkspaceManifest(...args),
  );
}

async function importAdmittedWorkspaceManifest(
  repoPath: string,
): Promise<WorkspaceImportFromRepoResponse> {
  if (!repoPath || !isAbsolute(repoPath)) {
    refuseWorkspaceCreation(
      'invalid-path',
      'repoPath must be an absolute path',
    );
  }

  const isRepo = await isGitRepo(repoPath);
  if (!isRepo) {
    refuseWorkspaceCreation(
      'not-a-repository',
      `Not a git repository: ${repoPath}`,
    );
  }

  return importManifestWorkspace(createPorts, repoPath);
}

export function toWorkspaceCliRecord(item: SidebarItem): WorkspaceCliRecord {
  if (item.type === 'single-repo') {
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      color: item.color,
      order: item.order,
      collapsed: item.collapsed ?? false,
      rootPath: item.repoPath,
      repoPath: item.repoPath,
      repoCount: 1,
      worktreeCount: item.worktrees.length,
      repos: [
        {
          id: item.id,
          name: item.name,
          repoPath: item.repoPath,
        },
      ],
      worktrees: item.worktrees,
    };
  }

  if (item.type === 'cowork') {
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      color: item.color,
      order: item.order,
      collapsed: item.collapsed ?? false,
      rootPath: item.externalPath ?? getWorkspaceDir(item.id),
      repoCount: 0,
      worktreeCount: 0,
      repos: [],
      worktrees: [],
    };
  }

  const rootPath = item.sourceRepoPath ?? getWorkspaceDir(item.id);
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    color: item.color,
    order: item.order,
    collapsed: item.collapsed ?? false,
    rootPath,
    ...(item.sourceRepoPath ? { sourceRepoPath: item.sourceRepoPath } : {}),
    repoCount: item.repos.length,
    worktreeCount: item.worktrees.length,
    repos: item.repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      repoPath: repo.repoPath,
      source: repo.source ?? 'local',
      manifestUrl: repo.manifestUrl,
    })),
    worktrees: item.worktrees,
  };
}

/**
 * The repositories a bound multi-repo publication registers: a setup's
 * validated clones, or a new organization copy's staged checkouts (CAN-4856).
 */
export type BoundMultiRepoRepositories =
  | { repositories: MultiRepoSetupRepository[]; copyRepositories?: never }
  | { copyRepositories: BoundCopyRepository[]; repositories?: never };

/** The manifest URL a setup or copy registration records for a repository. */
function manifestUrlFor(repository: {
  host: string;
  owner: string;
  name: string;
}): string {
  return `https://${repository.host}/${repository.owner}/${repository.name}.git`;
}

/**
 * Trusted setup publication: no import, conversion, source mutation, or clone.
 * A copy's held repository registers from its manifest URL as setup's does; a
 * snapshot (no holder) registers as a local repository with no URL, so an
 * all-snapshot copy has local repositories and no links.
 */
export async function registerBoundMultiRepoWorkspace(
  input: {
    path: string;
    localWorkspaceId: string;
    owner: WorkspaceOwnerBinding;
    name: string;
  } & BoundMultiRepoRepositories,
): Promise<MultiRepoSidebarItem> {
  const owner = normalizeWorkspaceOwner(input.owner);
  const repos: WorkspaceConfigFile['repos'] | null = input.copyRepositories
    ? input.copyRepositories.map((entry) => ({
        id: entry.relativePath.slice('repos/'.length),
        name: entry.repository?.name ?? entry.name,
        repoPath: join(input.path, entry.relativePath),
        ...(entry.repository
          ? {
              source: 'manifest' as const,
              manifestUrl: manifestUrlFor(entry.repository),
            }
          : { source: 'local' as const }),
      }))
    : input.repositories.some((entry) => !entry.validated)
      ? null
      : input.repositories.map((entry) => ({
          id: entry.relativePath.slice('repos/'.length),
          name: entry.repository.name,
          repoPath: join(input.path, entry.relativePath),
          source: 'manifest' as const,
          manifestUrl: manifestUrlFor(entry.repository),
        }));
  if (!owner || !isAbsolute(input.path) || !repos || repos.length < 1)
    throw new Error('Invalid bound multi-repo setup');
  validateId(input.localWorkspaceId, 'workspace id');
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    withSplitDestinationWorkspaceCreationLock(async () => {
      const items = await readExistingSidebarItems({
        includeEmptyTemporary: true,
      });
      const current = items.find((item) => item.id === input.localWorkspaceId);
      if (current) {
        if (
          current.type !== 'multi-repo' ||
          current.sourceRepoPath !== input.path ||
          current.owner?.organizationId !== owner.organizationId ||
          current.owner.projectId !== owner.projectId ||
          current.owner.instanceId !== owner.instanceId
        )
          throw new WorkspaceIdentityInUseError();
        const persisted = await refreshOrganizationOwner({
          workspaceId: current.id,
          source: 'org_project_reclaim',
          owner,
        });
        return { ...current, owner: persisted };
      }
      if (await readWorkspaceIndexEntry(input.localWorkspaceId))
        throw new WorkspaceIdentityInUseError();
      let expectedWorkspaceRecords: WorkspaceCreationReservationOptions['expectedWorkspaceRecords'];
      if (await pathExists(getWorkspaceDir(input.localWorkspaceId))) {
        const store = getW5IdentityStore();
        const captured =
          store && isW5CaptureWorkspaceId(input.localWorkspaceId)
            ? await store.capture?.({
                files: [
                  { kind: 'manifest', workspaceId: input.localWorkspaceId },
                  { kind: 'worktrees', workspaceId: input.localWorkspaceId },
                ],
                discoverWorkspaces: false,
              })
            : undefined;
        if (
          store &&
          isW5CaptureWorkspaceId(input.localWorkspaceId) &&
          !captured
        )
          throw new WorkspaceIdentityInUseError();
        if (captured) {
          const fingerprint = (
            kind: 'manifest' | 'worktrees',
          ): string | null => {
            const image = captured.capture.files.find(
              (file) => file.kind === kind,
            );
            if (!image || image.state === 'unreadable')
              throw new WorkspaceIdentityInUseError();
            return fingerprintW5File(
              image.state === 'present'
                ? Buffer.from(image.base64, 'base64').toString('utf8')
                : null,
            );
          };
          expectedWorkspaceRecords = {
            manifest: fingerprint('manifest'),
            worktrees: fingerprint('worktrees'),
          };
        }
        const orphan = captured
          ? await runInW5CapturedView(captured.capture, captured.root, () =>
              readWorkspaceConfig(input.localWorkspaceId),
            )
          : await readWorkspaceConfig(input.localWorkspaceId);
        if (
          !orphan ||
          orphan.type !== 'multi-repo' ||
          orphan.sourceRepoPath !== input.path ||
          orphan.owner?.organizationId !== owner.organizationId ||
          orphan.owner.projectId !== owner.projectId ||
          orphan.owner.instanceId !== owner.instanceId ||
          orphan.owner.bindingGeneration > owner.bindingGeneration
        )
          throw new WorkspaceIdentityInUseError();
      }
      return commitNewWorkspace(
        createPorts,
        (live): Promise<MultiRepoSidebarItem> =>
          Promise.resolve({
            ...createPorts.plan.multiRepoItem({
              id: input.localWorkspaceId,
              name: input.name,
              repos,
              sourceRepoPath: input.path,
              order: live.length,
            }),
            owner,
          }),
        {
          expectedWorkspaceRecords,
          effects: async () => {
            await mkdir(getWorkspaceDir(input.localWorkspaceId), {
              recursive: true,
            });
            await scaffoldWorkspaceInstructions(
              {
                content: getDefaultWorkspaceClaudeMd(input.name),
                agentsMdAlias: false,
              },
              {
                writeClaudeMd: (content) =>
                  writeFile(
                    getWorkspaceClaudeMdPath(input.localWorkspaceId),
                    content,
                    'utf8',
                  ),
                ensureAgentsMdAlias: () =>
                  ensureAgentsMdSymlink(
                    getWorkspaceDir(input.localWorkspaceId),
                  ),
              },
            );
          },
        },
      );
    }),
  );
}

/**
 * Index a Personal multi-repository cloud project a device set up
 * (CAN-5192): its root at `path` and the repositories it cloned under it,
 * with the ones the user declined recorded as suppressed. Idempotent for a
 * resumed setup: the same id at the same root returns the workspace already
 * indexed.
 */
export async function registerCloudProjectMultiRepoWorkspace(input: {
  path: string;
  localWorkspaceId: string;
  name: string;
  repositories: WorkspaceConfigFile['repos'];
  suppressedRepoIds: string[];
}): Promise<MultiRepoSidebarItem> {
  if (
    !isAbsolute(input.path) ||
    input.repositories.some((repo) => !isAbsolute(repo.repoPath))
  )
    throw new Error('Invalid cloud project setup');
  validateId(input.localWorkspaceId, 'workspace id');
  for (const repo of input.repositories) validateId(repo.id, 'repository id');
  return withStorageAdmission(PROJECT_W5_STORAGE, () =>
    withSplitDestinationWorkspaceCreationLock(async () => {
      const items = await readExistingSidebarItems({
        includeEmptyTemporary: true,
      });
      const current = items.find((item) => item.id === input.localWorkspaceId);
      if (current) {
        if (
          current.type !== 'multi-repo' ||
          current.sourceRepoPath !== input.path ||
          current.owner !== undefined
        )
          throw new WorkspaceIdentityInUseError();
        return current;
      }
      if (await readWorkspaceIndexEntry(input.localWorkspaceId))
        throw new WorkspaceIdentityInUseError();
      if (await pathExists(getWorkspaceDir(input.localWorkspaceId))) {
        const orphan = await readWorkspaceConfig(input.localWorkspaceId);
        if (
          !orphan ||
          orphan.type !== 'multi-repo' ||
          orphan.sourceRepoPath !== input.path ||
          orphan.owner !== undefined
        )
          throw new WorkspaceIdentityInUseError();
      }
      return commitNewWorkspace(
        createPorts,
        (live): Promise<MultiRepoSidebarItem> =>
          Promise.resolve({
            ...createPorts.plan.multiRepoItem({
              id: input.localWorkspaceId,
              name: input.name,
              repos: input.repositories,
              sourceRepoPath: input.path,
              order: live.length,
            }),
            ...(input.suppressedRepoIds.length > 0
              ? { suppressedRepoIds: input.suppressedRepoIds }
              : {}),
          }),
        {
          effects: async () => {
            await mkdir(getWorkspaceDir(input.localWorkspaceId), {
              recursive: true,
            });
            await scaffoldWorkspaceInstructions(
              {
                content: getDefaultWorkspaceClaudeMd(input.name),
                agentsMdAlias: false,
              },
              {
                writeClaudeMd: (content) =>
                  writeFile(
                    getWorkspaceClaudeMdPath(input.localWorkspaceId),
                    content,
                    'utf8',
                  ),
                ensureAgentsMdAlias: () =>
                  ensureAgentsMdSymlink(
                    getWorkspaceDir(input.localWorkspaceId),
                  ),
              },
            );
          },
        },
      );
    }),
  );
}
