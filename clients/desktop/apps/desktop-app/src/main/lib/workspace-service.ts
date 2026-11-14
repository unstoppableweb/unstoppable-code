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
import {
  normalizeRepositoryCloneUrl,
  repositoryNameFromCloneUrl,
} from '@canopy/protocol/portal';
import { normalizeWorkspaceOwner } from '@canopy/execution-engine/lib/workspace-owner';
import type { MultiRepoSetupRepository } from './org-project-setup-journal';
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
import {
  cloneRepo,
  cloneRepoWithLiveProgress,
  getGitCommonDir,
  getRemoteUrl,
  initLocalRepo,
  isGitRepo,
} from './git';
import {
  getDataDir,
  getDefaultReposDir,
  getWorkspaceClaudeMdPath,
  getWorkspaceDir,
} from './paths';
import { validateId } from './validation';
import type { GitCloneProgressUpdate } from './git-clone-progress';
import { inferCloneRepoName } from './git-clone-progress';
import { readAllSidebarItems, readWorkspaceIndexEntry } from './sidebar-items';
import {
  applyWorkspaceAdditionDecision,
  applyWorkspaceCreationDecision,
} from './workspace-creation-decision-port';
import { workspaceCreationIds } from './worktree-record-decision-apply';
import type { WorkspaceCreationDecision } from './worktree-record-decisions';
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
import { remoteUrlsMatch } from './repo-url-matcher';
import {
  readWorkspaceConfig,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';
import { prepareNewWorkspaceSourceRepo } from './workspace-source-control';
import { refreshOrganizationOwner } from './workspace-ownership';
import { ensureAgentsMdSymlink } from './instruction-files';
import { scaffoldWorkspaceInstructions } from '@canopy/core-runtime/node/workspace/workspace-instructions';
import { createExternalCoworkWorkspace } from './cowork-workspace-crud';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import { refuseWorkspaceCreation } from './workspace-creation-refusal';
import { sanitizeWorkspaceSourceRepoName } from '@canopy/desktop-shared/node/lib/workspace-source-repo';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

interface ExistingWorkspaceBinding {
  workspaceName: string;
  repoPath: string;
  remoteUrl: string | null;
}

interface ExistingRepoBinding {
  repoId: string;
  repoName: string;
  repoPath: string;
  remoteUrl: string | null;
}

interface ImportedWorkspaceArtifacts {
  workspace: MultiRepoSidebarItem;
  childWorkspaces: SingleRepoSidebarItem[];
  clonedRepoIds: string[];
}

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
  const release =
    await acquireSplitDestinationWorkspaceIdentityLock(identityKey);
  try {
    return await operation();
  } finally {
    release();
  }
}

async function acquireSplitDestinationWorkspaceIdentityLock(
  identityKey: string,
): Promise<() => void> {
  const previous = splitDestinationWorkspaceLocks.get(identityKey);
  let releaseLock: (() => void) | undefined;
  const current = new Promise<void>((resolveLock) => {
    releaseLock = resolveLock;
  });
  splitDestinationWorkspaceLocks.set(identityKey, current);
  await previous;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseLock?.();
    if (splitDestinationWorkspaceLocks.get(identityKey) === current) {
      splitDestinationWorkspaceLocks.delete(identityKey);
    }
  };
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

function inferRepoNameFromRemote(remoteUrl: string): string {
  return repositoryNameFromCloneUrl(remoteUrl);
}

function buildSingleRepoSidebarItem(
  id: string,
  name: string,
  repoPath: string,
  order: number,
): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id,
    name,
    repoPath,
    color: getNextSidebarColor(order),
    worktrees: [],
    collapsed: false,
    order,
  };
}

function buildMultiRepoSidebarItem(
  id: string,
  name: string,
  repos: WorkspaceConfigFile['repos'],
  order: number,
  sourceRepoPath: string,
  scripts?: MultiRepoSidebarItem['scripts'],
): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id,
    name,
    color: getNextSidebarColor(order),
    repos,
    worktrees: [],
    collapsed: false,
    order,
    sourceRepoPath,
    scripts,
  };
}

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

/** Reserve an empty checkout directory before a tracked clone can use it. */
export async function reserveUniqueDestination(
  baseDir: string,
  preferredName: string,
): Promise<string> {
  let suffix = 1;
  while (true) {
    const name = suffix === 1 ? preferredName : `${preferredName}-${suffix}`;
    const candidate = join(baseDir, name);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      suffix += 1;
    }
  }
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

/** Applies the addition through the record decision port (W6a1). */
async function stageAddedWorkspace(
  persisted: SidebarItem,
  previousItems: SidebarItem[],
  preserveWorkspaceIds: string[],
  scoped: boolean,
): Promise<SidebarItem> {
  const written = await applyWorkspaceAdditionDecision({
    kind: 'workspace.add',
    item: persisted,
    scope: scoped
      ? { kind: 'workspace' }
      : { kind: 'sidebar', previousItems, preserveWorkspaceIds },
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

/**
 * Prepare against the live index under workspace serialization (CAN-3806),
 * then enter the W5 write scope only to publish the new records. Provisioning
 * never holds the writer gate; publication keeps unrelated observer edits.
 */
async function commitNewWorkspace<T extends SidebarItem>(
  prepare: (items: SidebarItem[]) => Promise<T>,
  local?: {
    effects?: (item: T) => Promise<void>;
    ownedPaths?: (item: T) => string[];
    expectedWorkspaceRecords?: WorkspaceCreationReservationOptions['expectedWorkspaceRecords'];
  },
): Promise<T> {
  return serializeWorkspaceMutation(async () => {
    const sidebarItems = await readAllSidebarItems();
    const { items } = sidebarItems;
    const item = await prepare(items);
    const persisted: T = { ...item, order: items.length };
    const publish = async (): Promise<T> => {
      await local?.effects?.(persisted);
      return stageNewWorkspaceCreation(persisted);
    };
    return local
      ? withLocalWorkspaceCreation(
          item.id,
          [getWorkspaceDir(item.id), ...(local.ownedPaths?.(item) ?? [])],
          publish,
          { expectedWorkspaceRecords: local.expectedWorkspaceRecords },
        )
      : publish();
  });
}

/**
 * Publishes the addition in its creation boundary step, through the record
 * decision port (W6a1); observer edits during provisioning survive.
 */
async function stageNewWorkspaceCreation<T extends SidebarItem>(
  persisted: T,
): Promise<T> {
  const decision: WorkspaceCreationDecision = {
    kind: 'workspace.create.publish',
    item: persisted,
  };
  return commitWorkspaceCreation(async () => {
    await applyWorkspaceCreationDecision(
      decision,
      markWorkspaceCreationEffectsStarted,
    );
    return persisted;
  }, workspaceCreationIds(decision));
}

async function resolveExistingWorkspaceBindings(
  items: SidebarItem[],
): Promise<ExistingWorkspaceBinding[]> {
  const candidates = items.flatMap((item) => {
    if (item.type === 'single-repo') {
      return [{ workspaceName: item.name, repoPath: item.repoPath }];
    }

    if (item.type === 'cowork' || !item.sourceRepoPath) {
      return [];
    }

    return [{ workspaceName: item.name, repoPath: item.sourceRepoPath }];
  });

  return settleAll(
    candidates.map(async (candidate) => ({
      workspaceName: candidate.workspaceName,
      repoPath: candidate.repoPath,
      remoteUrl: await getRemoteUrl(candidate.repoPath),
    })),
  );
}

async function resolveExistingRepoBindings(
  items: SidebarItem[],
): Promise<ExistingRepoBinding[]> {
  const candidates = items.flatMap((item) => {
    if (item.type === 'single-repo') {
      return [
        {
          repoId: item.id,
          repoName: item.name,
          repoPath: item.repoPath,
        },
      ];
    }

    if (item.type === 'cowork') {
      return [];
    }

    return item.repos.map((repo) => ({
      repoId: repo.id,
      repoName: repo.name,
      repoPath: repo.repoPath,
    }));
  });

  return settleAll(
    candidates.map(async (candidate) => ({
      repoId: candidate.repoId,
      repoName: candidate.repoName,
      repoPath: candidate.repoPath,
      remoteUrl: await getRemoteUrl(candidate.repoPath),
    })),
  );
}

function workspaceAlreadyExistsForRepo(
  workspaceBindings: ExistingWorkspaceBinding[],
  repoPath: string,
  remoteUrl: string | null,
): boolean {
  return workspaceBindings.some(
    (binding) =>
      binding.repoPath === repoPath ||
      (remoteUrl !== null &&
        binding.remoteUrl !== null &&
        remoteUrlsMatch(binding.remoteUrl, remoteUrl)),
  );
}

async function persistImportedWorkspaceArtifacts(
  artifacts: ImportedWorkspaceArtifacts,
): Promise<MultiRepoSidebarItem> {
  return serializeWorkspaceMutation(async () => {
    const sidebarItems = await readAllSidebarItems();
    const { items } = sidebarItems;
    const duplicateWorkspace = items.find(
      (item): item is MultiRepoSidebarItem =>
        item.type === 'multi-repo' &&
        item.sourceRepoPath === artifacts.workspace.sourceRepoPath,
    );
    if (duplicateWorkspace) {
      refuseWorkspaceCreation(
        'already-tracked',
        `This source repo is already attached to project "${duplicateWorkspace.name}"`,
      );
    }

    const workspace: MultiRepoSidebarItem = {
      ...artifacts.workspace,
      id: artifacts.workspace.id,
      color: getNextSidebarColor(items.length),
      order: items.length,
    };
    const childWorkspaces: SingleRepoSidebarItem[] = [];
    const workspaceBindings = await resolveExistingWorkspaceBindings(items);

    for (const preparedChild of artifacts.childWorkspaces) {
      const manifestUrl =
        artifacts.workspace.repos.find(
          (repo) => repo.repoPath === preparedChild.repoPath,
        )?.manifestUrl ?? null;
      if (
        workspaceAlreadyExistsForRepo(
          workspaceBindings,
          preparedChild.repoPath,
          manifestUrl,
        )
      ) {
        continue;
      }

      const additions = [workspace, ...childWorkspaces];
      const child: SingleRepoSidebarItem = {
        ...preparedChild,
        id: await buildAvailableWorkspaceId(
          preparedChild.name,
          items.concat(additions),
        ),
        color: getNextSidebarColor(items.length + additions.length),
        order: items.length + additions.length,
      };
      childWorkspaces.push(child);
      workspaceBindings.push({
        workspaceName: child.name,
        repoPath: child.repoPath,
        remoteUrl: manifestUrl,
      });
    }

    // Published through the record decision port (W6a1).
    const decision: WorkspaceCreationDecision = {
      kind: 'workspace.import.publish',
      workspace,
      childWorkspaces,
    };
    return commitWorkspaceCreation(async () => {
      await applyWorkspaceCreationDecision(
        decision,
        markWorkspaceCreationEffectsStarted,
      );
      return workspace;
    }, workspaceCreationIds(decision));
  });
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

async function importMultiRepoWorkspaceFromRepo<T>(
  repoPath: string,
  publish: (artifacts: ImportedWorkspaceArtifacts) => Promise<T>,
  reservedWorkspaceId?: string,
): Promise<T> {
  const admission = await serializeWorkspaceMutation(async () => {
    const manifest = await readCanopyJson(repoPath);
    if (!hasManifestRepos(manifest)) {
      refuseWorkspaceCreation(
        'not-a-manifest',
        'Selected repo does not contain a multi-repo canopy.json',
      );
    }
    const { items } = await readAllSidebarItems();
    const duplicate = items.find(
      (item) => item.type === 'multi-repo' && item.sourceRepoPath === repoPath,
    );
    if (duplicate) {
      refuseWorkspaceCreation(
        'already-tracked',
        `This source repo is already attached to project "${duplicate.name}"`,
      );
    }
    const workspaceName = basename(repoPath);
    const workspaceId =
      reservedWorkspaceId ??
      (await buildAvailableWorkspaceId(workspaceName, items));
    const reservation = reservedWorkspaceId
      ? undefined
      : await reserveWorkspaceCreation(workspaceId, [
          getWorkspaceDir(workspaceId),
        ]);
    if (reservation)
      await reservation.prepare(() =>
        recordWorkspaceCreationRepository({
          id: 'source',
          role: 'source',
          owned: false,
          action: 'import',
          status: 'completed',
        }),
      );
    return { manifest, workspaceId, workspaceName, reservation };
  });
  const provision = async (): Promise<T> => {
    const localRepos: WorkspaceConfigFile['repos'] = [];
    const clonedRepoIds: string[] = [];
    for (const manifestRepo of admission.manifest.repos ?? []) {
      const step = await serializeWorkspaceMutation(async () => {
        // A prior member clone may have overlapped other imports or installs.
        const { items } = await readAllSidebarItems();
        const bindings = await resolveExistingRepoBindings(items);
        const existing = bindings.find(
          (binding) =>
            binding.remoteUrl !== null &&
            remoteUrlsMatch(binding.remoteUrl, manifestRepo.url),
        );
        if (existing) {
          await recordWorkspaceCreationRepository({
            id: manifestRepo.id,
            role: 'member',
            owned: false,
            action: 'import',
            status: 'completed',
          });
          const repository: WorkspaceConfigFile['repos'][number] = {
            id: manifestRepo.id,
            name: existing.repoName,
            repoPath: existing.repoPath,
            source: 'manifest',
            manifestUrl: manifestRepo.url,
          };
          return { repository, cloned: false };
        }
        const destinationPath = await ensureUniqueDestination(
          getDefaultReposDir(),
          manifestRepo.name,
        );
        await recordWorkspaceCreationRepository({
          id: manifestRepo.id,
          role: 'member',
          owned: true,
          path: destinationPath,
          action: 'clone',
          status: 'started',
        });
        markWorkspaceCreationEffectsStarted();
        await mkdir(dirname(destinationPath), { recursive: true });
        await mkdir(destinationPath);
        const repository: WorkspaceConfigFile['repos'][number] = {
          id: manifestRepo.id,
          name: manifestRepo.name,
          repoPath: destinationPath,
          source: 'manifest',
          manifestUrl: manifestRepo.url,
        };
        return { repository, cloned: true };
      });
      if (step.cloned) {
        await cloneRepo(manifestRepo.url, step.repository.repoPath, {
          signal: untrackedClonesStop.signal,
        });
        await serializeWorkspaceMutation(() =>
          recordWorkspaceCreationRepository({
            id: manifestRepo.id,
            role: 'member',
            owned: true,
            path: step.repository.repoPath,
            action: 'clone',
            status: 'completed',
          }),
        );
        clonedRepoIds.push(manifestRepo.id);
      }
      localRepos.push(step.repository);
    }
    return serializeWorkspaceMutation(async () => {
      const { items } = await readAllSidebarItems();
      const workspace = buildMultiRepoSidebarItem(
        admission.workspaceId,
        admission.workspaceName,
        localRepos,
        items.length,
        repoPath,
        undefined,
      );
      const workspaceBindings = await resolveExistingWorkspaceBindings(items);
      const childWorkspaces: SingleRepoSidebarItem[] = [];
      for (const repo of localRepos) {
        if (
          !repo.manifestUrl ||
          workspaceAlreadyExistsForRepo(
            workspaceBindings,
            repo.repoPath,
            repo.manifestUrl,
          )
        )
          continue;
        const child = buildSingleRepoSidebarItem(
          buildWorkspaceId(repo.name, [
            ...items,
            workspace,
            ...childWorkspaces,
          ]),
          repo.name,
          repo.repoPath,
          items.length + 1 + childWorkspaces.length,
        );
        childWorkspaces.push(child);
        workspaceBindings.push({
          workspaceName: child.name,
          repoPath: child.repoPath,
          remoteUrl: repo.manifestUrl,
        });
      }
      return publish({ workspace, childWorkspaces, clonedRepoIds });
    });
  };
  return admission.reservation
    ? admission.reservation.run(provision)
    : provision();
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
    return importMultiRepoWorkspaceFromRepo(
      repoPath,
      persistImportedWorkspaceArtifacts,
    );
  }

  return commitNewWorkspace(
    async (items) => {
      assertRepositoryNotTracked(items, repoPath);
      // Only once the import is admitted (F7): a rejected import leaves the
      // user's repository untouched.
      const name = basename(repoPath);
      return buildSingleRepoSidebarItem(
        await buildAvailableWorkspaceId(name, items),
        name,
        repoPath,
        items.length,
      );
    },
    { effects: () => ensureSingleRepoCanopyJson(repoPath) },
  );
}

function assertRepositoryNotTracked(
  items: readonly SidebarItem[],
  repoPath: string,
): void {
  const duplicate = findTrackedWorkspaceForRepoPath(items, repoPath);
  if (duplicate) {
    refuseWorkspaceCreation(
      'already-tracked',
      `This repository is already tracked as project "${duplicate.name}"`,
    );
  }
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

async function addAdmittedWorkspaceFromRemote(
  remoteUrl: string,
  destinationDir: string,
  progress?: AddWorkspaceFromRemoteProgress,
): Promise<SidebarItem> {
  const normalizedRemoteUrl = normalizeRepositoryCloneUrl(remoteUrl);
  if (!normalizedRemoteUrl) {
    refuseWorkspaceCreation('invalid-remote', 'Remote URL is required');
  }

  const normalizedDestinationDir = destinationDir.trim();
  if (!normalizedDestinationDir || !isAbsolute(normalizedDestinationDir)) {
    refuseWorkspaceCreation(
      'invalid-path',
      'Destination directory must be an absolute path',
    );
  }

  const preferredName = progress
    ? inferCloneRepoName(normalizedRemoteUrl)
    : inferRepoNameFromRemote(normalizedRemoteUrl);
  if (!preferredName) {
    refuseWorkspaceCreation(
      'invalid-remote',
      'Unable to determine repository name from URL',
    );
  }

  // Check before joining the queue, and cancel a waiting admission immediately.
  if (progress?.signal.aborted) throw new CloneCancelledError();
  const admission = await serializeWorkspaceMutation(
    async () => {
      const { items } = await readAllSidebarItems();
      const workspaceId = await buildAvailableWorkspaceId(preferredName, items);
      const destinationPath = await ensureUniqueDestination(
        normalizedDestinationDir,
        preferredName,
      );
      const reservation = await reserveWorkspaceCreation(
        workspaceId,
        [getWorkspaceDir(workspaceId), destinationPath],
        { releaseBeforeEffects: true },
      );
      await reservation.prepare(async () => {
        if (progress?.signal.aborted) throw new CloneCancelledError();
        await recordWorkspaceCreationRepository({
          id: 'source',
          role: 'source',
          owned: true,
          path: destinationPath,
          action: 'clone',
          status: 'started',
        });
        await mkdir(normalizedDestinationDir, { recursive: true });
        await mkdir(destinationPath);
        markWorkspaceCreationEffectsStarted();
        progress?.onDestination(destinationPath, reservation.releaseRemoved);
      });
      return { workspaceId, destinationPath, reservation };
    },
    progress
      ? {
          signal: progress.signal,
          error: (): Error => new CloneCancelledError(),
        }
      : undefined,
  );
  return admission.reservation.run(async () => {
    const { destinationPath, workspaceId } = admission;
    if (progress) {
      await cloneRepoWithLiveProgress(normalizedRemoteUrl, destinationPath, {
        signal: progress.signal,
        onProgress: progress.onProgress,
      });
      if (progress.signal.aborted) throw new CloneCancelledError();
      progress.onCloned();
    } else {
      await cloneRepo(normalizedRemoteUrl, destinationPath, {
        signal: untrackedClonesStop.signal,
      });
    }
    await serializeWorkspaceMutation(() =>
      recordWorkspaceCreationRepository({
        id: 'source',
        role: 'source',
        owned: true,
        path: destinationPath,
        action: 'clone',
        status: 'completed',
      }),
    );
    const manifest = await readCanopyJson(destinationPath);
    if (hasManifestRepos(manifest))
      return importMultiRepoWorkspaceFromRepo(
        destinationPath,
        persistImportedWorkspaceArtifacts,
        workspaceId,
      );
    await ensureSingleRepoCanopyJson(destinationPath);
    return serializeWorkspaceMutation(async () => {
      const { items } = await readAllSidebarItems();
      assertRepositoryNotTracked(items, destinationPath);
      return stageNewWorkspaceCreation(
        buildSingleRepoSidebarItem(
          workspaceId,
          basename(destinationPath),
          destinationPath,
          items.length,
        ),
      );
    });
  });
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
    return commitNewWorkspace(async (items) => {
      assertRepositoryNotTracked(items, repoPath);
      await assertFolderIsImportable(await resolveRealPath(repoPath), items);
      const name = preferredName?.trim() || basename(repoPath);
      return buildSingleRepoSidebarItem(
        await buildAvailableWorkspaceId(name, items),
        name,
        repoPath,
        items.length,
      );
    }, {});
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
      const workspace = buildSingleRepoSidebarItem(
        workspaceId,
        name,
        repoPath,
        items.length,
      );
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
        await acquireSplitDestinationWorkspaceIdentityLock(identityKey),
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
    async (items) =>
      buildSingleRepoSidebarItem(
        await buildAvailableWorkspaceId(normalizedName, items),
        normalizedName,
        await ensureUniqueDestination(
          getDefaultReposDir(),
          safeWorkspaceIdBase(normalizedName),
        ),
        items.length,
      ),
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
        await initLocalRepo(item.repoPath, normalizedName);
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
  await initLocalRepo(destinationPath, normalizedName);
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
    async (items) => {
      const id = await buildAvailableWorkspaceId(normalizedName, items);
      const sourceRepoPath = await ensureUniqueDestination(
        getDefaultReposDir(),
        sanitizeWorkspaceSourceRepoName(normalizedName),
      );
      return buildMultiRepoSidebarItem(
        id,
        normalizedName,
        [],
        items.length,
        sourceRepoPath,
      );
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

  return importMultiRepoWorkspaceFromRepo(repoPath, async (artifacts) => ({
    workspace: await persistImportedWorkspaceArtifacts(artifacts),
    clonedRepoIds: artifacts.clonedRepoIds,
  }));
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

/** Trusted setup publication: no import, conversion, source mutation, or clone. */
export async function registerBoundMultiRepoWorkspace(input: {
  path: string;
  localWorkspaceId: string;
  owner: WorkspaceOwnerBinding;
  name: string;
  repositories: MultiRepoSetupRepository[];
}): Promise<MultiRepoSidebarItem> {
  const owner = normalizeWorkspaceOwner(input.owner);
  if (
    !owner ||
    !isAbsolute(input.path) ||
    input.repositories.length < 1 ||
    input.repositories.some((entry) => !entry.validated)
  )
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
        (live): Promise<MultiRepoSidebarItem> =>
          Promise.resolve({
            ...buildMultiRepoSidebarItem(
              input.localWorkspaceId,
              input.name,
              input.repositories.map((entry) => ({
                id: entry.relativePath.slice('repos/'.length),
                name: entry.repository.name,
                repoPath: join(input.path, entry.relativePath),
                source: 'manifest',
                manifestUrl: `https://${entry.repository.host}/${entry.repository.owner}/${entry.repository.name}.git`,
              })),
              live.length,
              input.path,
            ),
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
        (live): Promise<MultiRepoSidebarItem> =>
          Promise.resolve({
            ...buildMultiRepoSidebarItem(
              input.localWorkspaceId,
              input.name,
              input.repositories,
              live.length,
              input.path,
            ),
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
