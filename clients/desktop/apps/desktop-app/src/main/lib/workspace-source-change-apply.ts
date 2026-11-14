import type { SourceChangeGit } from '../canopy-runtime/worker-git-worktree-adapter';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { applyProjectInstructionsChange } from '@canopy/core-runtime/node/workspace/workspace-instructions';
import { dirname, join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import {
  isHookTriggerName,
  normalizeHookInputMap,
  type HookInputMap,
} from '@canopy/desktop-shared/hooks';
import {
  normalizeScriptInputMap,
  type ScriptDefinition,
  type ScriptInputMap,
} from '@canopy/desktop-shared/scripts';
import {
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/execution-engine/plugin-refs';
import type {
  CanopyJsonFile,
  CanopyJsonRepoEntry,
  WorkspaceApplySourceRepoAdd,
  WorkspaceApplySourceChangesRequest,
  WorkspaceApplySourceChangesResponse,
  WorkspaceSourceChangesAppliedEvent,
  WorkspaceConfigFile,
  WorkspaceRepoData,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { generateUniqueAnimalName } from './animals';
import {
  WORKSPACE_MANIFEST_STORAGE,
  WORKTREE_LIST_STORAGE,
  withStorageAdmission,
} from './w5-storage';
import {
  resolveOptionalProjectInstructionFile,
  writeProjectInstructionFile,
} from './instruction-files';
import { readCanopyJson, writeCanopyJson } from './canopy-json';
import { getRepoRootFromWorktree } from './git';
import {
  getWorktreeDataDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
  getWorkspaceWorktreesRootDir,
} from './paths';
import {
  readWorkspaceConfig,
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
} from './workspace-persistence';
import {
  applyWorkspaceManifestDecision,
  applyWorktreeListRemoval,
  applyWorktreeListUpdate,
} from './workspace-record-decision-port';
import { syncSourceChangeRepoBindings } from './worktree-record-decision-apply';
import type {
  SourceChangeBindingsDecision,
  WorktreeListUpdateOutcome,
} from './worktree-record-decisions';
import {
  WorkspaceSourceChangesRefusedError,
  type WorkspaceSourceChangesRefusal,
} from './workspace-source-change-refusal';
import type { SourceChangesTransition } from './workspace-source-changes';
import {
  commitW5BoundaryStep,
  w5CompositionLocks,
} from './w5-composition-operation';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from './w5-commit-log-file-store';
import { remoteUrlsMatch } from './repo-url-matcher';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';
import {
  repairWorkspaceRootWorktree,
  validateWorkspaceRootWorktree,
} from './workspace-source-control';
import {
  deletePrTrackingState,
  getWorkspaceRepoStorageKey,
} from './github-pr-hook-state';
import { stopHooksForRepoTarget } from './hook-runner';
import {
  resolveWorkspaceWorktreeBranchName,
  startWorkspaceRepoSetupAndDiscovery,
  startWorkspaceWorktreePostCreateSetup,
} from './workspace-worktree-runtime';
import {
  detachedWorkCallback,
  settleAll,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

interface TargetWorkspaceContext {
  worktreeId: string;
  branchName: string;
  createdWorktree: boolean;
  referenceRepoPath: string;
}

interface NormalizedWorkspaceApplySourceRepoAdd extends WorkspaceApplySourceRepoAdd {
  repoId: string;
}

interface NormalizedWorkspaceApplySourceChangesRequest extends Omit<
  WorkspaceApplySourceChangesRequest,
  'repoAdds'
> {
  repoAdds?: NormalizedWorkspaceApplySourceRepoAdd[];
}

interface PreparedRepoWorktree {
  repo: WorkspaceRepoData;
  repoId: string;
  manifestUrl: string;
}

function applyWorkspaceManifestStartPage(
  manifest: CanopyJsonFile,
  startPage: WorkspaceApplySourceChangesRequest['startPage'],
): void {
  if (startPage === undefined) return;
  if (startPage === null) {
    delete manifest.startPage;
    return;
  }
  if (!isProjectStartPage(startPage)) {
    throw new WorkspaceSourceChangesRefusedError(
      'invalid-request',
      'Invalid start page',
    );
  }
  manifest.startPage = startPage;
}

function slugifyRepoId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function createUniqueRepoId(baseId: string, existingIds: Set<string>): string {
  if (!existingIds.has(baseId)) {
    return baseId;
  }

  let suffix = 2;
  while (existingIds.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

async function readExistingWorkspaceRepoIds(
  workspaceId: string,
  config: WorkspaceConfigFile,
  manifest: CanopyJsonFile,
): Promise<Set<string>> {
  const existingRepoIds = new Set<string>([
    ...config.repos.map((repo) => repo.id),
    ...(manifest.repos ?? []).map((repo) => repo.id),
  ]);
  const worktreesRootDir = getWorkspaceWorktreesRootDir(workspaceId);

  try {
    const worktreeDirs = await readdir(worktreesRootDir, {
      withFileTypes: true,
    });
    for (const worktreeDir of worktreeDirs) {
      if (!worktreeDir.isDirectory()) {
        continue;
      }

      const repoDirs = await readdir(
        join(worktreesRootDir, worktreeDir.name, 'repos'),
        {
          withFileTypes: true,
        },
      ).catch(() => []);
      for (const repoDir of repoDirs) {
        if (repoDir.isDirectory()) {
          existingRepoIds.add(repoDir.name);
        }
      }
    }
  } catch {
    // The worktrees directory may not exist yet.
  }

  return existingRepoIds;
}

export async function normalizeWorkspaceApplySourceChangesRequest(params: {
  workspaceId: string;
  config: WorkspaceConfigFile;
  manifest: CanopyJsonFile;
  request: WorkspaceApplySourceChangesRequest;
}): Promise<NormalizedWorkspaceApplySourceChangesRequest> {
  const repoAdds = params.request.repoAdds;
  if (!repoAdds) {
    return {
      ...params.request,
      repoAdds: undefined,
    };
  }

  const needsGeneratedRepoId = repoAdds.some(
    (repoAdd) => !Boolean(repoAdd.repoId?.trim()),
  );
  const existingRepoIds = needsGeneratedRepoId
    ? await readExistingWorkspaceRepoIds(
        params.workspaceId,
        params.config,
        params.manifest,
      )
    : new Set<string>();

  const normalizedRepoAdds = repoAdds.map(
    (repoAdd): NormalizedWorkspaceApplySourceRepoAdd => {
      const explicitRepoId = repoAdd.repoId?.trim();
      if (explicitRepoId) {
        existingRepoIds.add(explicitRepoId);
        return {
          ...repoAdd,
          repoId: explicitRepoId,
        };
      }

      const generatedRepoId = createUniqueRepoId(
        slugifyRepoId(repoAdd.repoName) || 'repo',
        existingRepoIds,
      );
      existingRepoIds.add(generatedRepoId);

      return {
        ...repoAdd,
        repoId: generatedRepoId,
      };
    },
  );

  return {
    ...params.request,
    repoAdds: normalizedRepoAdds,
  };
}

function toManifestWorkspaceScripts(
  scripts: ScriptInputMap | undefined,
): CanopyJsonFile['scripts'] {
  const normalized = normalizeScriptInputMap(scripts);
  if (!normalized) {
    return undefined;
  }

  const entries = Object.entries(normalized).filter(
    (entry): entry is [string, string | ScriptDefinition] => entry[1] !== null,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function toManifestRepoScripts(
  scripts: ScriptInputMap | undefined,
): CanopyJsonRepoEntry['scripts'] {
  return normalizeScriptInputMap(scripts);
}

function toManifestWorkspaceHooks(
  hooks: HookInputMap | undefined,
): CanopyJsonFile['hooks'] {
  const normalized = normalizeHookInputMap(hooks);
  if (!normalized) {
    return undefined;
  }

  const nextHooks: NonNullable<CanopyJsonFile['hooks']> = {};
  for (const [triggerName, actions] of Object.entries(normalized)) {
    if (isHookTriggerName(triggerName) && Array.isArray(actions)) {
      nextHooks[triggerName] = actions;
    }
  }

  return Object.keys(nextHooks).length > 0 ? nextHooks : undefined;
}

function toManifestRepoHooks(
  hooks: HookInputMap | undefined,
): CanopyJsonRepoEntry['hooks'] {
  const normalized = normalizeHookInputMap(hooks);
  if (!normalized) {
    return undefined;
  }

  const nextHooks: NonNullable<CanopyJsonRepoEntry['hooks']> = {};
  for (const [triggerName, actions] of Object.entries(normalized)) {
    if (isHookTriggerName(triggerName)) {
      nextHooks[triggerName] = actions;
    }
  }

  return Object.keys(nextHooks).length > 0 ? nextHooks : undefined;
}

function mergeRepoScripts(
  manifest: CanopyJsonFile,
  request: NormalizedWorkspaceApplySourceChangesRequest,
): void {
  if (!manifest.repos) {
    manifest.repos = [];
  }

  const repoAddsById = new Map(
    (request.repoAdds ?? []).map((repo) => [repo.repoId, repo]),
  );

  for (const repoChange of request.repoScriptChanges ?? []) {
    const manifestRepo = manifest.repos.find(
      (repo) => repo.id === repoChange.repoId,
    );
    const pendingAddedRepo = repoAddsById.get(repoChange.repoId);
    if (!manifestRepo && !pendingAddedRepo) {
      throw new Error(
        `Cannot apply scripts for repo ${repoChange.repoId} because it is not present in the project manifest`,
      );
    }

    if (manifestRepo) {
      const scripts = toManifestRepoScripts(repoChange.scripts);
      if (scripts) {
        manifestRepo.scripts = scripts;
      } else {
        delete manifestRepo.scripts;
      }
      continue;
    }

    if (pendingAddedRepo) {
      pendingAddedRepo.scripts = repoChange.scripts;
    }
  }
}

function mergeRepoHooks(
  manifest: CanopyJsonFile,
  request: NormalizedWorkspaceApplySourceChangesRequest,
): void {
  if (!manifest.repos) {
    manifest.repos = [];
  }

  const repoAddsById = new Map(
    (request.repoAdds ?? []).map((repo) => [repo.repoId, repo]),
  );

  for (const repoChange of request.repoHookChanges ?? []) {
    const manifestRepo = manifest.repos.find(
      (repo) => repo.id === repoChange.repoId,
    );
    const pendingAddedRepo = repoAddsById.get(repoChange.repoId);
    if (!manifestRepo && !pendingAddedRepo) {
      throw new Error(
        `Cannot apply hooks for repo ${repoChange.repoId} because it is not present in the project manifest`,
      );
    }

    if (manifestRepo) {
      const hooks = toManifestRepoHooks(repoChange.hooks);
      if (hooks) {
        manifestRepo.hooks = hooks;
      } else {
        delete manifestRepo.hooks;
      }
      continue;
    }

    if (pendingAddedRepo) {
      pendingAddedRepo.hooks = repoChange.hooks;
    }
  }
}

async function safeRemoveRepoWorktree(
  git: SourceChangeGit,
  repoPath: string | null,
  worktreePath: string,
): Promise<void> {
  if (repoPath) {
    try {
      await git.removeWorktree(repoPath, worktreePath);
      return;
    } catch {
      // Fall back to force-removing the directory.
    }
  }

  await rm(worktreePath, { recursive: true, force: true });
  if (repoPath) {
    git.bestEffortPruneWorktrees(
      repoPath,
      'workspace-source-change-apply cleanupWorktreeDirectory',
    );
  }
}

async function readExistingTargetManifest(
  workspaceId: string,
  worktreeId: string,
): Promise<CanopyJsonFile> {
  return (
    (await readCanopyJson(
      getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId),
    )) ?? ({ version: 1, repos: [] } satisfies CanopyJsonFile)
  );
}

function ensureManifestRepos(manifest: CanopyJsonFile): CanopyJsonRepoEntry[] {
  if (!manifest.repos) {
    manifest.repos = [];
  }
  return manifest.repos;
}

function remoteUrlsReferToSameRepo(left: string, right: string): boolean {
  return left === right || remoteUrlsMatch(left, right);
}

function findLocalRepoBinding(
  config: WorkspaceConfigFile,
  repoId: string,
  remoteUrl: string,
): WorkspaceRepoData | undefined {
  return config.repos.find(
    (repo) =>
      repo.id === repoId ||
      (typeof repo.manifestUrl === 'string' &&
        remoteUrlsReferToSameRepo(repo.manifestUrl, remoteUrl)),
  );
}

type RepoAddStep =
  | { status: 'bound'; binding: WorkspaceRepoData }
  | { status: 'repository-id-conflict' }
  | { status: 'repository-not-local' };

/**
 * Saves one addition to `repos` (unless its repository is already there)
 * and finds its checkout. The apply and its keyed admission both run this,
 * so they refuse the same additions.
 */
function stageRepoAdd(
  repos: CanopyJsonRepoEntry[],
  config: WorkspaceConfigFile,
  repoAdd: NormalizedWorkspaceApplySourceRepoAdd,
  repoUrl: string,
): RepoAddStep {
  const existingById = repos.find((repo) => repo.id === repoAdd.repoId);
  if (existingById && !remoteUrlsReferToSameRepo(existingById.url, repoUrl)) {
    return { status: 'repository-id-conflict' };
  }
  if (
    !existingById &&
    !repos.some((repo) => remoteUrlsReferToSameRepo(repo.url, repoUrl))
  ) {
    const nextRepo: CanopyJsonRepoEntry = {
      id: repoAdd.repoId,
      name: repoAdd.repoName,
      url: repoUrl,
    };
    const scripts = toManifestRepoScripts(repoAdd.scripts);
    if (scripts) {
      nextRepo.scripts = scripts;
    }
    const hooks = toManifestRepoHooks(repoAdd.hooks);
    if (hooks) {
      nextRepo.hooks = hooks;
    }
    repos.push(nextRepo);
  }

  const binding =
    findLocalRepoBinding(config, repoAdd.repoId, repoUrl) ??
    (repoAdd.repoPath
      ? ({
          id: repoAdd.repoId,
          name: repoAdd.repoName,
          repoPath: repoAdd.repoPath,
          source: 'manifest',
          manifestUrl: repoUrl,
        } satisfies WorkspaceRepoData)
      : undefined);
  return binding
    ? { status: 'bound', binding }
    : { status: 'repository-not-local' };
}

function refuseRepoAdd(
  reason: WorkspaceSourceChangesRefusal,
  message: string,
): never {
  throw new WorkspaceSourceChangesRefusedError(reason, message);
}

/** The `canopy.json` an apply edits: its worktree's, or the source checkout a new one starts from. */
async function readAdmissionTargetManifest(
  request: WorkspaceApplySourceChangesRequest,
  config: WorkspaceConfigFile,
): Promise<CanopyJsonFile> {
  if (request.target.mode === 'existing') {
    return readExistingTargetManifest(
      request.workspaceId,
      request.target.worktreeId,
    );
  }
  const empty: CanopyJsonFile = { version: 1, repos: [] };
  if (!config.sourceRepoPath) {
    return empty;
  }
  const referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
    config.sourceRepoPath,
  );
  // The new worktree starts from a commit, not this working copy, so an
  // unreadable copy leaves the conflict check to the apply.
  return (await readCanopyJson(referenceRepoPath).catch(() => null)) ?? empty;
}

/**
 * `prepareRepoAdds`' refusals (`stageRepoAdd`) for additions without a
 * `repoPath` (a wire change), in memory on the target's `canopy.json`, so a
 * keyed caller refuses them before its reservation instead of failing inside
 * the apply. Removals apply first, as in the apply. A new worktree's
 * `canopy.json` is read from the source checkout, which a fetch of its
 * default branch may still move.
 */
export async function checkRepoAddsWithoutPaths(
  request: WorkspaceApplySourceChangesRequest,
): Promise<void> {
  const additions = request.repoAdds ?? [];
  if (additions.length === 0) {
    return;
  }
  for (const add of additions) {
    if (add.repoPath !== undefined) {
      throw new Error('Only additions without a repoPath are checked here');
    }
    if (!add.remoteUrl.trim()) {
      refuseRepoAdd('invalid-request', `${add.repoName} needs a remote URL.`);
    }
  }
  const detail = await readWorkspaceConfigDetailed(request.workspaceId);
  if (detail.authority !== 'ok') {
    refuseRepoAdd(
      'configuration-unavailable',
      "Couldn't read this project's settings. Try again.",
    );
  }
  const { config } = detail;
  const manifest = await readAdmissionTargetManifest(request, config);
  const normalized = await normalizeWorkspaceApplySourceChangesRequest({
    workspaceId: request.workspaceId,
    config,
    manifest,
    request,
  });
  applyRepoRemovalsToManifest({ request: normalized, manifest });
  const repos = ensureManifestRepos(manifest);
  for (const add of normalized.repoAdds ?? []) {
    const step = stageRepoAdd(repos, config, add, add.remoteUrl.trim());
    if (step.status === 'repository-id-conflict') {
      refuseRepoAdd(
        'repository-id-conflict',
        `${add.repoId} is already in this project's canopy.json with a different remote URL. Choose another repository ID.`,
      );
    }
    if (step.status === 'repository-not-local') {
      refuseRepoAdd(
        'repository-not-local',
        `${add.repoName} has no checkout on this device. Add it to this project here first.`,
      );
    }
  }
}

async function applyClaudeMdChange(
  workspaceId: string,
  worktreeId: string,
  claudeMd: string | undefined,
): Promise<void> {
  if (claudeMd === undefined) {
    return;
  }

  await applyProjectInstructionsChange(
    await resolveOptionalProjectInstructionFile(
      getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId),
    ),
    claudeMd,
    {
      readText: (path) => readFile(path, 'utf8'),
      write: writeProjectInstructionFile,
    },
  );
}

function applyWorkspaceScriptChanges(
  manifest: CanopyJsonFile,
  workspaceScripts: ScriptInputMap | undefined,
): void {
  if (workspaceScripts === undefined) {
    return;
  }

  const scripts = toManifestWorkspaceScripts(workspaceScripts);
  if (scripts) {
    manifest.scripts = scripts;
  } else {
    delete manifest.scripts;
  }
}

function applyWorkspaceHookChanges(
  manifest: CanopyJsonFile,
  workspaceHooks: HookInputMap | undefined,
): void {
  if (workspaceHooks === undefined) {
    return;
  }

  const hooks = toManifestWorkspaceHooks(workspaceHooks);
  if (hooks) {
    manifest.hooks = hooks;
  } else {
    delete manifest.hooks;
  }
}

function dedupeShareablePluginRefs(
  plugins: readonly ShareablePluginRef[],
): ShareablePluginRef[] {
  const seenKeys = new Set<string>();
  const result: ShareablePluginRef[] = [];
  for (const plugin of plugins) {
    const key = getShareablePluginRefKey(plugin);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    result.push(plugin);
  }
  return result;
}

function applyWorkspacePluginChanges(
  manifest: CanopyJsonFile,
  plugins: ShareablePluginRef[] | undefined,
): void {
  if (plugins === undefined) {
    return;
  }

  const nextPlugins = dedupeShareablePluginRefs(plugins);
  if (nextPlugins.length === 0) {
    delete manifest.plugins;
    return;
  }

  manifest.plugins = nextPlugins;
}

async function prepareRepoAdds(params: {
  request: NormalizedWorkspaceApplySourceChangesRequest;
  workspaceId: string;
  worktreeId: string;
  config: WorkspaceConfigFile;
  manifest: CanopyJsonFile;
}): Promise<PreparedRepoWorktree[]> {
  const repos = ensureManifestRepos(params.manifest);
  const repoWorktreesToCreate: PreparedRepoWorktree[] = [];

  for (const repoAdd of params.request.repoAdds ?? []) {
    const repoUrl = repoAdd.remoteUrl.trim();
    if (!repoUrl) {
      throw new Error(`Repo ${repoAdd.repoId} is missing a remote URL`);
    }

    const step = stageRepoAdd(repos, params.config, repoAdd, repoUrl);
    if (step.status === 'repository-id-conflict') {
      throw new Error(
        `Repo ${repoAdd.repoId} already exists in canopy.json with a different URL`,
      );
    }
    if (step.status === 'repository-not-local') {
      throw new Error(
        `Repo ${repoAdd.repoId} has no local binding and no repoPath was supplied`,
      );
    }
    const { binding } = step;

    const repoWorktreePath = getWorkspaceWorktreeRepoDir(
      params.workspaceId,
      params.worktreeId,
      repoAdd.repoId,
    );
    const worktreeExists = await readFile(
      join(repoWorktreePath, '.git'),
      'utf8',
    )
      .then((): boolean => true)
      .catch((): boolean => false);
    if (worktreeExists) {
      continue;
    }

    repoWorktreesToCreate.push({
      repo: {
        ...binding,
        source: 'manifest',
        manifestUrl: repoUrl,
      },
      repoId: repoAdd.repoId,
      manifestUrl: repoUrl,
    });
  }

  return repoWorktreesToCreate;
}

async function createPreparedRepoWorktrees(
  git: SourceChangeGit,
  params: {
    workspaceId: string;
    worktreeId: string;
    repos: PreparedRepoWorktree[];
    createdWorktree: boolean;
    getWindow: () => BrowserWindow | null;
  },
): Promise<void> {
  await settleAll(
    params.repos.map(async (prepared) => {
      const repoWorktreePath = getWorkspaceWorktreeRepoDir(
        params.workspaceId,
        params.worktreeId,
        prepared.repoId,
      );
      const branchName = await resolveWorkspaceWorktreeBranchName(
        params.workspaceId,
        params.worktreeId,
        prepared.repoId,
      );
      await mkdir(dirname(repoWorktreePath), { recursive: true });
      await git.createWorktree(
        prepared.repo.repoPath,
        repoWorktreePath,
        branchName,
      );

      if (!params.createdWorktree) {
        detachedWorkCallback(() =>
          startWorkspaceRepoSetupAndDiscovery({
            workspaceId: params.workspaceId,
            worktreeId: params.worktreeId,
            repo: prepared.repo,
            getWindow: params.getWindow,
          }),
        )();
      }
    }),
  );
}

async function createWorkspaceRepoWorktrees(
  git: SourceChangeGit,
  params: {
    workspaceId: string;
    worktreeId: string;
    branchName: string;
    repos: WorkspaceRepoData[];
  },
): Promise<void> {
  await settleAll(
    params.repos.map(async (repo) => {
      const repoWorktreePath = getWorkspaceWorktreeRepoDir(
        params.workspaceId,
        params.worktreeId,
        repo.id,
      );
      await mkdir(dirname(repoWorktreePath), { recursive: true });
      await git.createWorktree(
        repo.repoPath,
        repoWorktreePath,
        params.branchName,
      );
    }),
  );
}

function applyRepoRemovalsToManifest(params: {
  request: WorkspaceApplySourceChangesRequest;
  manifest: CanopyJsonFile;
}): string[] {
  const repoRemovals = new Set(params.request.repoRemovals ?? []);
  if (repoRemovals.size === 0) {
    return [];
  }

  if (params.manifest.repos) {
    params.manifest.repos = params.manifest.repos.filter(
      (repo) => !repoRemovals.has(repo.id),
    );
  }

  return Array.from(repoRemovals);
}

async function removeRepoWorktrees(
  git: SourceChangeGit,
  params: {
    workspaceId: string;
    worktreeId: string;
    repoIds: string[];
  },
): Promise<void> {
  for (const repoId of params.repoIds) {
    await stopHooksForRepoTarget({
      projectId: params.workspaceId,
      worktreeId: params.worktreeId,
      repoId,
    }).catch(() => {});
    await deletePrTrackingState({
      projectId: params.workspaceId,
      worktreeId: params.worktreeId,
      repoStorageKey: getWorkspaceRepoStorageKey(repoId),
    }).catch(() => {});

    const repoWorktreePath = getWorkspaceWorktreeRepoDir(
      params.workspaceId,
      params.worktreeId,
      repoId,
    );
    const repoPath = await getRepoRootFromWorktree(repoWorktreePath).catch(
      (): null => null,
    );
    await safeRemoveRepoWorktree(git, repoPath, repoWorktreePath);
  }
}

function sourceChangeBindingsDecision(
  manifest: CanopyJsonFile,
  request: NormalizedWorkspaceApplySourceChangesRequest,
): SourceChangeBindingsDecision {
  return {
    kind: 'workspace.sourceChanges.bindings',
    manifestRepositories: (manifest.repos ?? []).map(({ id, name, url }) => ({
      id,
      name,
      url,
    })),
    repositoryAdds: (request.repoAdds ?? []).map(({ repoId, repoPath }) => ({
      repoId,
      repoPath,
    })),
    repositoryRemovals: [...(request.repoRemovals ?? [])],
  };
}

function syncLocalRepoBindings(
  config: WorkspaceConfigFile,
  bindings: SourceChangeBindingsDecision,
): {
  config: WorkspaceConfigFile;
  updated: boolean;
} {
  const synced = syncSourceChangeRepoBindings(config.repos, bindings);
  return {
    config: synced.updated ? { ...config, repos: synced.repos } : config,
    updated: synced.updated,
  };
}

async function rollbackCreatedWorktree(
  git: SourceChangeGit,
  workspaceId: string,
  context: TargetWorkspaceContext,
  repos: WorkspaceRepoData[],
): Promise<void> {
  for (const repo of repos) {
    const repoWorktreePath = getWorkspaceWorktreeRepoDir(
      workspaceId,
      context.worktreeId,
      repo.id,
    );
    await safeRemoveRepoWorktree(git, repo.repoPath, repoWorktreePath).catch(
      (): Promise<void> => Promise.resolve(),
    );
  }

  await safeRemoveRepoWorktree(
    git,
    context.referenceRepoPath,
    getWorkspaceWorktreeRootRepoDir(workspaceId, context.worktreeId),
  ).catch((): Promise<void> => Promise.resolve());
  await rm(
    join(getWorkspaceWorktreesRootDir(workspaceId), context.worktreeId),
    { recursive: true, force: true },
  );
}

async function ensureTargetWorkspaceWorktree(
  git: SourceChangeGit,
  request: WorkspaceApplySourceChangesRequest,
  referenceRepoPath: string,
  transition?: SourceChangesTransition<WorkspaceApplySourceChangesResponse>,
): Promise<TargetWorkspaceContext> {
  if (request.target.mode === 'existing') {
    const existingTarget = request.target;
    const worktrees = await readWorkspaceWorktrees(
      request.workspaceId,
      transition ? { persistRemovalCleanup: false } : undefined,
    );
    const worktree = worktrees.find(
      (entry) => entry.id === existingTarget.worktreeId,
    );
    if (!worktree) {
      throw new WorkspaceSourceChangesRefusedError(
        'not-found',
        `Project worktree ${existingTarget.worktreeId} was not found`,
      );
    }

    return {
      worktreeId: worktree.id,
      branchName: worktree.branchName,
      createdWorktree: false,
      referenceRepoPath,
    };
  }

  const worktrees = await readWorkspaceWorktrees(
    request.workspaceId,
    transition ? { persistRemovalCleanup: false } : undefined,
  );
  const existingIds = new Set<string>(request.target.existingWorktreeIds);
  for (const worktree of worktrees) {
    existingIds.add(worktree.id);
  }
  const worktreeId = generateUniqueAnimalName(existingIds);
  const worktreeRootPath = getWorkspaceWorktreeRootRepoDir(
    request.workspaceId,
    worktreeId,
  );

  transition?.beforeEffects?.();
  await mkdir(dirname(worktreeRootPath), { recursive: true });
  await mkdir(getWorktreeDataDir(request.workspaceId, worktreeId), {
    recursive: true,
  });
  const branchName = await git.createWorktree(
    referenceRepoPath,
    worktreeRootPath,
    worktreeId,
  );
  const targetContext: TargetWorkspaceContext = {
    worktreeId,
    branchName,
    createdWorktree: true,
    referenceRepoPath,
  };

  const repairIssues = await validateWorkspaceRootWorktree(
    request.workspaceId,
    worktreeId,
  );
  const blockingIssues = repairIssues.filter((issue) => issue.blocking);
  if (blockingIssues.length > 0) {
    const repairedIssues = await repairWorkspaceRootWorktree(
      request.workspaceId,
      worktreeId,
      true,
    );
    if (repairedIssues.some((issue) => issue.blocking)) {
      await rollbackCreatedWorktree(
        git,
        request.workspaceId,
        targetContext,
        [],
      );
      throw new Error(repairedIssues.map((issue) => issue.message).join('\n'));
    }
  }

  const row: WorktreeData = {
    id: worktreeId,
    branchName,
    createdAt: new Date().toISOString(),
  };
  const stageTargetWorktree = (): Promise<WorktreeListUpdateOutcome> =>
    applyWorktreeListUpdate(
      request.workspaceId,
      { kind: 'workspace.sourceChanges.target.record', worktree: row },
      {},
    );
  await commitW5BoundaryStep(
    transition?.commit,
    transition ? w5CompositionLocks({ lists: [request.workspaceId] }) : [],
    stageTargetWorktree,
  );

  return targetContext;
}

export function applyWorkspaceSourceChangesToWorktree(
  request: WorkspaceApplySourceChangesRequest,
  getWindow: () => BrowserWindow | null,
  git: SourceChangeGit,
  onApplied?: (event: WorkspaceSourceChangesAppliedEvent) => void,
  transition?: SourceChangesTransition<WorkspaceApplySourceChangesResponse>,
): Promise<WorkspaceApplySourceChangesResponse> {
  return withStorageAdmission(
    request.target.mode === 'new'
      ? [WORKSPACE_MANIFEST_STORAGE, WORKTREE_LIST_STORAGE]
      : [WORKSPACE_MANIFEST_STORAGE],
    () =>
      applyAdmittedWorkspaceSourceChanges(
        git,
        request,
        getWindow,
        onApplied,
        transition,
      ),
  );
}

async function applyAdmittedWorkspaceSourceChanges(
  git: SourceChangeGit,
  request: WorkspaceApplySourceChangesRequest,
  getWindow: () => BrowserWindow | null,
  onApplied?: (event: WorkspaceSourceChangesAppliedEvent) => void,
  transition?: SourceChangesTransition<WorkspaceApplySourceChangesResponse>,
): Promise<WorkspaceApplySourceChangesResponse> {
  const config = await readWorkspaceConfig(request.workspaceId);
  if (!config.sourceRepoPath) {
    throw new WorkspaceSourceChangesRefusedError(
      'no-source-repository',
      'Project does not have a source repository',
    );
  }

  const referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
    config.sourceRepoPath,
  );
  const targetContext = await ensureTargetWorkspaceWorktree(
    git,
    request,
    referenceRepoPath,
    transition,
  );
  transition?.beforeEffects?.();
  await mkdir(
    getWorktreeDataDir(request.workspaceId, targetContext.worktreeId),
    {
      recursive: true,
    },
  );

  const targetManifest = await readExistingTargetManifest(
    request.workspaceId,
    targetContext.worktreeId,
  );
  const normalizedRequest = await normalizeWorkspaceApplySourceChangesRequest({
    workspaceId: request.workspaceId,
    config,
    manifest: targetManifest,
    request,
  });

  let acceptanceStarted = false;
  try {
    await applyClaudeMdChange(
      normalizedRequest.workspaceId,
      targetContext.worktreeId,
      normalizedRequest.claudeMd,
    );

    applyWorkspaceScriptChanges(
      targetManifest,
      normalizedRequest.workspaceScripts,
    );
    applyWorkspaceHookChanges(targetManifest, normalizedRequest.workspaceHooks);
    applyWorkspacePluginChanges(
      targetManifest,
      normalizedRequest.workspacePlugins,
    );
    applyWorkspaceManifestStartPage(
      targetManifest,
      normalizedRequest.startPage,
    );
    mergeRepoScripts(targetManifest, normalizedRequest);
    mergeRepoHooks(targetManifest, normalizedRequest);
    const repoIdsToRemove = applyRepoRemovalsToManifest({
      request: normalizedRequest,
      manifest: targetManifest,
    });
    const repoWorktreesToCreate = await prepareRepoAdds({
      request: normalizedRequest,
      workspaceId: normalizedRequest.workspaceId,
      worktreeId: targetContext.worktreeId,
      config,
      manifest: targetManifest,
    });

    await writeCanopyJson(
      getWorkspaceWorktreeRootRepoDir(
        normalizedRequest.workspaceId,
        targetContext.worktreeId,
      ),
      targetManifest,
    );
    onApplied?.({
      clientRequestId: request.clientRequestId,
      workspaceId: normalizedRequest.workspaceId,
      worktreeId: targetContext.worktreeId,
      branchName: targetContext.branchName,
      createdWorktree: targetContext.createdWorktree,
    });

    const bindings = sourceChangeBindingsDecision(
      targetManifest,
      normalizedRequest,
    );
    const syncedBindings = syncLocalRepoBindings(config, bindings);

    const result: WorkspaceApplySourceChangesResponse = {
      worktreeId: targetContext.worktreeId,
      branchName: targetContext.branchName,
      createdWorktree: targetContext.createdWorktree,
      localRepoBindingsUpdated: syncedBindings.updated,
      referenceRepoPath,
    };
    // Canonical bindings must settle before admission and the accepted receipt retire.
    if (syncedBindings.updated) {
      // An uncertain canonical decision must not delete the already-applied checkout.
      acceptanceStarted = true;
      await applyWorkspaceManifestDecision(
        normalizedRequest.workspaceId,
        bindings,
      );
    }
    acceptanceStarted ||= transition !== undefined;
    const accepted = transition ? await transition.complete(result) : result;

    // Tracked, so it stays admitted after the apply returns.
    trackDetachedWork(() =>
      (async (): Promise<void> => {
        try {
          await removeRepoWorktrees(git, {
            workspaceId: normalizedRequest.workspaceId,
            worktreeId: targetContext.worktreeId,
            repoIds: repoIdsToRemove,
          });

          if (targetContext.createdWorktree) {
            const refreshedConfig = syncedBindings.config;
            // New worktrees are populated from the post-sync config so newly
            // added manifest repos and pre-existing workspace repos are created
            // together with one branch name.
            await createWorkspaceRepoWorktrees(git, {
              workspaceId: normalizedRequest.workspaceId,
              worktreeId: targetContext.worktreeId,
              branchName: targetContext.branchName,
              repos: refreshedConfig.repos,
            });
            detachedWorkCallback(() =>
              startWorkspaceWorktreePostCreateSetup({
                workspaceId: normalizedRequest.workspaceId,
                worktreeId: targetContext.worktreeId,
                repos: refreshedConfig.repos,
                getWindow,
              }),
            )();
            return;
          }

          await createPreparedRepoWorktrees(git, {
            workspaceId: normalizedRequest.workspaceId,
            worktreeId: targetContext.worktreeId,
            repos: repoWorktreesToCreate,
            createdWorktree: targetContext.createdWorktree,
            getWindow,
          });
        } catch (backgroundError) {
          // eslint-disable-next-line no-console
          console.error(
            'Failed to finish project source apply background repo work:',
            backgroundError,
          );
        }
      })(),
    );

    return accepted;
  } catch (error) {
    if (
      targetContext.createdWorktree &&
      !acceptanceStarted &&
      (!transition ||
        !(
          error instanceof W5RevisionConflictError ||
          error instanceof W5FileWriteRefusedError
        ))
    ) {
      await rollbackCreatedWorktree(
        git,
        normalizedRequest.workspaceId,
        targetContext,
        [],
      );
      await applyWorktreeListRemoval(
        normalizedRequest.workspaceId,
        {
          kind: 'workspace.sourceChanges.target.remove',
          worktreeId: targetContext.worktreeId,
        },
        {},
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}
