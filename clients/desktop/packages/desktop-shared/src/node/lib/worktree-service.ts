import { worktreeListProcessLock } from '@canopy/execution-engine/node/w5-host-cohort/process-file-lock';
import {
  lockCheckout,
  ownedCliWorktreeCreations,
  WorktreeCreationConflictError,
} from './worktree-create-records';
export { WorktreeCreationConflictError } from './worktree-create-records';
import { removeGitWorktree } from './worktree-create-effects';
export { ensureAgentsMdSymlinkOrCopy } from './worktree-create-effects';
export {
  createSingleRepoWorktree,
  createMultiRepoWorktree,
} from './worktree-create-legacy';
import { mkdir, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import type {
  ArchiveWorktreeResponse,
  WorktreeData,
  WorktreeGitFailedEvent,
  WorktreeGitReadyEvent,
} from '../../types';
import {
  writeFileAtomically,
  type AtomicFileStorage,
} from '@canopy/execution-engine/node/lib/atomic-file';
import { withStorageAdmission } from '@canopy/execution-engine/node/lib/storage-admission';
import { getWorkspaceItem } from './workspace-cli-reads';
import {
  getMultiRepoRepoWorktreeDir,
  getMultiRepoRootWorktreeDir,
  getMultiRepoWorktreeDir,
  getSingleRepoWorktreeDir,
  getWorktreesFilePath,
  normalizeWorktree,
} from './worktree-cli-reads';

import { BrowserProfileRepository } from '../browser-profiles/repository';
import { resolveBrowserTaskOwner } from '../browser-profiles/owners';
import {
  DEFERRED_BROWSER_RETIREMENT_WARNING,
  prepareBrowserTaskRetirement,
} from '../browser-profiles/lifecycle';
import { settleAll } from './detached-work';

export type { WorktreeCliRepoEntry } from './worktree-cli-reads';
export {
  aggregateMultiRepoDiffStats,
  getWorktreeCliRecord,
  getWorktreeStats,
  listWorktreeCliRepoEntries,
  listWorktreeCliRows,
  listWorktreePipelineExecutions,
} from './worktree-cli-reads';

async function withBrowserTaskRetirement(
  workspaceId: string,
  worktreeId: string,
  operation: () => Promise<ArchiveWorktreeResponse>,
): Promise<ArchiveWorktreeResponse> {
  const dataRoot = getCanopyDataDir();
  const repository = new BrowserProfileRepository(
    path.join(dataRoot, 'browser-profiles'),
  );
  // Browser profile metadata never holds an archive. An unfenced or uncommitted
  // profile whose owner is removed is retired by desktop owner reconciliation.
  let deferred = false;
  let retirementId: string | null = null;
  try {
    const owner = await resolveBrowserTaskOwner(
      dataRoot,
      workspaceId,
      worktreeId,
    );
    retirementId = owner
      ? await prepareBrowserTaskRetirement(repository, dataRoot, owner)
      : null;
  } catch {
    deferred = true;
  }
  // A CLI failure during Git removal has an uncertain outcome. Leave its durable
  // fence for desktop recovery instead of reviving a potentially removed owner.
  const result = await operation();
  if (retirementId) {
    try {
      await repository.commitRetirement(retirementId, {
        kind: 'owner_removed',
        ownerOperationId: retirementId,
      });
    } catch {
      deferred = true;
    }
  }
  return deferred
    ? {
        ...result,
        warnings: [...result.warnings, DEFERRED_BROWSER_RETIREMENT_WARNING],
      }
    : result;
}

export type NodeWindowHandle = { readonly __nodeWindowHandle?: never };

export interface CreateWorktreeServiceOptions {
  workspaceId: string;
  existingWorktreeIds?: string[];
  branchName?: string;
  baseWorktreeId?: string;
  baseBranch?: string;
  repairWorkspaceRoot?: boolean;
  restoreClaudeMd?: boolean;
  startPostCreateSetup?: boolean;
  /** Defaults to true. Restore-style callers can explicitly suppress seeding. */
  seedPanelLayoutMode?: boolean;
  startProjectPostCreateSetup?: ProjectWorktreePostCreateSetup;
  startWorkspacePostCreateSetup?: WorkspaceWorktreePostCreateSetup;
  getWindow?: () => NodeWindowHandle | null;
  deferGitSetup?: boolean;
  onGitReady?: (event: WorktreeGitReadyEvent) => void;
  onGitFailed?: (event: WorktreeGitFailedEvent) => void;
}

export interface WorktreeArchiveLiveServices {
  cleanupLiveState?: (projectId: string, worktreeId: string) => Promise<void>;
  purgeObservabilityData?: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
}

export type ProjectWorktreePostCreateSetup = (params: {
  projectId: string;
  worktreeId: string;
  project: { repoPath: string };
  getWindow: () => NodeWindowHandle | null;
}) => void | Promise<void>;

export type WorkspaceWorktreePostCreateSetup = (params: {
  workspaceId: string;
  worktreeId: string;
  workspaceRootPath: string;
  repos: Array<{ id: string; name: string; repoPath: string }>;
  getWindow: () => NodeWindowHandle | null;
}) => void | Promise<void>;

interface WorktreesFile {
  version: 1;
  worktrees: WorktreeData[];
}

interface ArchiveSingleRepoOptions {
  workspaceId: string;
  worktreeId: string;
  repoPath?: string;
  observabilityMode?: 'persisted-only' | 'live-service';
  liveServices?: WorktreeArchiveLiveServices;
}

interface ArchiveMultiRepoOptions {
  workspaceId: string;
  worktreeId: string;
  observabilityMode?: 'persisted-only' | 'live-service';
  liveServices?: WorktreeArchiveLiveServices;
}

// Shared W5 writers run in CLI commands and headless built-in actions.
const WORKTREE_LIST_STORAGE: AtomicFileStorage = {
  namespace: 'worktree_list',
  writer: 'desktop_cli',
};

/** Git removal completed; metadata persistence still needs recovery. */
export class WorktreeArchiveMetadataError extends Error {
  constructor(
    readonly worktreeId: string,
    readonly path: string,
    cause: unknown,
  ) {
    super(
      'The checkout was removed, but its worktree list could not be saved.',
    );
    this.name = 'WorktreeArchiveMetadataError';
    Object.defineProperty(this, 'cause', { value: cause, configurable: true });
  }
}

interface CliWorktree extends WorktreeData {
  cliCreationToken?: string;
}
function lockWorktreeList<T>(
  workspaceId: string,
  work: () => Promise<T>,
): Promise<T> {
  return worktreeListProcessLock(getCanopyDataDir())(
    [getWorktreesFilePath(workspaceId)],
    work,
  );
}

/** Mutations must preserve unknown row fields and refuse unreadable lists. */
async function readMutableWorktrees(
  workspaceId: string,
): Promise<CliWorktree[]> {
  let raw: string;
  try {
    raw = await readFile(getWorktreesFilePath(workspaceId), 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return [];
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('worktrees' in value) ||
    !Array.isArray(value.worktrees) ||
    !value.worktrees.every(
      (row: unknown): row is CliWorktree =>
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        typeof row.id === 'string' &&
        'branchName' in row &&
        typeof row.branchName === 'string' &&
        'createdAt' in row &&
        typeof row.createdAt === 'string',
    )
  )
    throw new Error('The worktree list cannot be read safely.');
  return value.worktrees.map((row) => ({ ...row, ...normalizeWorktree(row) }));
}

async function removeWorktreeRecord(
  workspaceId: string,
  worktreeId: string,
): Promise<void> {
  try {
    await lockWorktreeList(workspaceId, async () => {
      const current = await readMutableWorktrees(workspaceId);
      await writeWorktrees(
        workspaceId,
        current.filter((row) => row.id !== worktreeId),
      );
      ownedCliWorktreeCreations.delete(
        getWorktreesFilePath(workspaceId) + ':' + worktreeId,
      );
    });
  } catch (cause) {
    throw new WorktreeArchiveMetadataError(
      worktreeId,
      getWorktreesFilePath(workspaceId),
      cause,
    );
  }
}

async function writeWorktrees(
  workspaceId: string,
  worktrees: WorktreeData[],
): Promise<void> {
  const filePath = getWorktreesFilePath(workspaceId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: WorktreesFile = { version: 1, worktrees };
  await writeFileAtomically(filePath, JSON.stringify(payload, null, 2), {
    encoding: 'utf8',
    storage: WORKTREE_LIST_STORAGE,
  });
}

export function rollbackPersistedReservation(
  ...args: Parameters<typeof rollbackAdmittedReservation>
): Promise<void> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    lockCheckout(args[0], args[1], () => rollbackAdmittedReservation(...args)),
  );
}

async function rollbackAdmittedReservation(
  workspaceId: string,
  worktreeId: string,
  metadataDir: string,
  expectedToken?: string,
): Promise<void> {
  await lockWorktreeList(workspaceId, async () => {
    const current = await readMutableWorktrees(workspaceId);
    const owned = current.find((row) => row.id === worktreeId);
    expectedToken ??= ownedCliWorktreeCreations.get(
      getWorktreesFilePath(workspaceId) + ':' + worktreeId,
    );
    if (!expectedToken || owned?.cliCreationToken !== expectedToken)
      throw new WorktreeCreationConflictError(worktreeId, [metadataDir]);
    await writeWorktrees(
      workspaceId,
      current.filter((row) => row !== owned),
    );
    await rm(metadataDir, { recursive: true, force: true });
    ownedCliWorktreeCreations.delete(
      getWorktreesFilePath(workspaceId) + ':' + worktreeId,
    );
  });
}

export function rollbackWorkspaceWorktree(
  ...args: Parameters<typeof rollbackAdmittedWorkspaceWorktree>
): Promise<void> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    lockCheckout(args[0], args[1], () =>
      rollbackAdmittedWorkspaceWorktree(...args),
    ),
  );
}

async function rollbackAdmittedWorkspaceWorktree(
  workspaceId: string,
  worktreeId: string,
  worktreeDir: string,
  repos: Array<{ id: string; name: string; repoPath: string }>,
  _repoIds?: string[],
  sourceRepoPath?: string,
  expectedToken?: string,
): Promise<void> {
  expectedToken ??= ownedCliWorktreeCreations.get(
    getWorktreesFilePath(workspaceId) + ':' + worktreeId,
  );
  // Old callers without invocation provenance must recover manually.
  await lockWorktreeList(workspaceId, async () => {
    const current = await readMutableWorktrees(workspaceId);
    if (
      !expectedToken ||
      !current.some(
        (row) =>
          row.id === worktreeId && row.cliCreationToken === expectedToken,
      )
    )
      throw new WorktreeCreationConflictError(worktreeId, [worktreeDir]);
  });
  await settleAll(
    repos.map((repo) =>
      removeGitWorktree(
        repo.repoPath,
        getMultiRepoRepoWorktreeDir(workspaceId, worktreeId, repo.id),
      ),
    ),
  );
  if (sourceRepoPath) {
    await removeGitWorktree(
      sourceRepoPath,
      getMultiRepoRootWorktreeDir(workspaceId, worktreeId),
    );
  }
  await rm(worktreeDir, { recursive: true, force: true });
  await rollbackAdmittedReservation(
    workspaceId,
    worktreeId,
    worktreeDir,
    expectedToken,
  );
}

export function archiveSingleRepoWorktree(
  ...args: Parameters<typeof archiveAdmittedSingleRepoWorktree>
): Promise<ArchiveWorktreeResponse> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    lockCheckout(args[0].workspaceId, args[0].worktreeId, () =>
      archiveAdmittedSingleRepoWorktree(...args),
    ),
  );
}

async function archiveAdmittedSingleRepoWorktree(
  options: ArchiveSingleRepoOptions,
): Promise<ArchiveWorktreeResponse> {
  return withBrowserTaskRetirement(
    options.workspaceId,
    options.worktreeId,
    async () => {
      const workspace = await getWorkspaceItem(options.workspaceId);
      const repoPath =
        options.repoPath ??
        (workspace.type === 'single-repo' ? workspace.repoPath : null);
      if (!repoPath) {
        throw new Error(`Project ${options.workspaceId} is not single-repo`);
      }
      await removeGitWorktree(
        repoPath,
        getSingleRepoWorktreeDir(options.workspaceId, options.worktreeId),
      );
      await removeWorktreeRecord(options.workspaceId, options.worktreeId);
      return { success: true, warnings: [] };
    },
  );
}

export function archiveMultiRepoWorktree(
  ...args: Parameters<typeof archiveAdmittedMultiRepoWorktree>
): Promise<ArchiveWorktreeResponse> {
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    lockCheckout(args[0].workspaceId, args[0].worktreeId, () =>
      archiveAdmittedMultiRepoWorktree(...args),
    ),
  );
}

async function archiveAdmittedMultiRepoWorktree(
  options: ArchiveMultiRepoOptions,
): Promise<ArchiveWorktreeResponse> {
  return withBrowserTaskRetirement(
    options.workspaceId,
    options.worktreeId,
    async () => {
      const workspace = await getWorkspaceItem(options.workspaceId);
      if (workspace.type !== 'multi-repo') {
        throw new Error(`Project ${options.workspaceId} is not multi-repo`);
      }
      for (const repo of workspace.repos) {
        await removeGitWorktree(
          repo.repoPath,
          getMultiRepoRepoWorktreeDir(
            options.workspaceId,
            options.worktreeId,
            repo.id,
          ),
        );
      }
      if (workspace.sourceRepoPath) {
        await removeGitWorktree(
          workspace.sourceRepoPath,
          getMultiRepoRootWorktreeDir(options.workspaceId, options.worktreeId),
        );
      }
      await rm(
        getMultiRepoWorktreeDir(options.workspaceId, options.worktreeId),
        {
          recursive: true,
          force: true,
        },
      );
      await removeWorktreeRecord(options.workspaceId, options.worktreeId);
      return { success: true, warnings: [] };
    },
  );
}
