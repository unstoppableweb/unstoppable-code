import type { SourceChangeGit } from '../canopy-runtime/worker-git-worktree-adapter';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  ProjectApplySourceChangesRequest,
  ProjectApplySourceChangesResponse,
  ProjectSourceChangesAppliedEvent,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type { BrowserWindow } from 'electron';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import { generateUniqueAnimalName } from './animals';
import {
  getCanopyJsonPath,
  readCanopyJson,
  writeCanopyJson,
} from './canopy-json';
import { getWorktreeDataDir, getWorktreeDir } from './paths';
import { ensureWorktreeMetadataDirectory } from './worktree-metadata-reservation';
import { resolveProjectReferenceRepoPath } from './project-reference-repo';
import { startProjectWorktreePostCreateSetup } from './project-worktree-runtime';
import { detachedWorkCallback } from '@canopy/desktop-shared/node/lib/detached-work';
import { validateAbsolutePath } from './validation';
import { WORKTREE_LIST_STORAGE, withStorageAdmission } from './w5-storage';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from './workspace-persistence';
import {
  applyWorktreeListRemoval,
  applyWorktreeListUpdate,
} from './workspace-record-decision-port';
import { WorkspaceSourceChangesRefusedError } from './workspace-source-change-refusal';
import type { SourceChangesTransition } from './workspace-source-changes';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  commitW5BoundaryStep,
  w5CompositionLocks,
} from './w5-composition-operation';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from './w5-commit-log-file-store';

interface TargetProjectContext {
  worktreeId: string;
  branchName: string;
  createdWorktree: boolean;
  referenceRepoPath: string;
  worktreePath: string;
}

function applyProjectManifestScripts(
  manifest: CanopyJsonFile,
  scripts: ScriptInputMap | undefined,
): void {
  if (scripts === undefined) {
    return;
  }

  const normalizedScripts = normalizeScriptInputMap(scripts);
  if (!normalizedScripts) {
    delete manifest.scripts;
    return;
  }

  const entries = Object.entries(normalizedScripts).filter(
    (entry): entry is [string, string | ScriptDefinition] => entry[1] !== null,
  );
  if (entries.length === 0) {
    delete manifest.scripts;
    return;
  }

  manifest.scripts = Object.fromEntries(entries);
}

function applyProjectManifestHooks(
  manifest: CanopyJsonFile,
  hooks: HookInputMap | undefined,
): void {
  if (hooks === undefined) {
    return;
  }

  const normalizedHooks = normalizeHookInputMap(hooks);
  if (!normalizedHooks) {
    delete manifest.hooks;
    return;
  }

  const nextHooks: NonNullable<CanopyJsonFile['hooks']> = {};
  for (const [triggerName, actions] of Object.entries(normalizedHooks)) {
    if (isHookTriggerName(triggerName) && Array.isArray(actions)) {
      nextHooks[triggerName] = actions;
    }
  }
  if (Object.keys(nextHooks).length === 0) {
    delete manifest.hooks;
    return;
  }

  manifest.hooks = nextHooks;
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

function applyProjectManifestPlugins(
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

function applyProjectManifestStartPage(
  manifest: CanopyJsonFile,
  startPage: ProjectApplySourceChangesRequest['startPage'],
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

async function rollbackCreatedProjectWorktree(
  git: SourceChangeGit,
  projectId: string,
  context: TargetProjectContext,
): Promise<void> {
  try {
    await git.removeWorktree(context.referenceRepoPath, context.worktreePath);
  } catch {
    await rm(context.worktreePath, { recursive: true, force: true });
    git.bestEffortPruneWorktrees(
      context.referenceRepoPath,
      'project-source-change-apply rollbackCreatedProjectWorktree',
    );
  }

  await applyWorktreeListRemoval(
    projectId,
    {
      kind: 'workspace.sourceChanges.target.remove',
      worktreeId: context.worktreeId,
    },
    {},
  );
}

/**
 * Records a target worktree created for a source change: one row appended to
 * the list read under its lock, so rows written while the checkout was made
 * are kept as they are (CAN-3819). An id taken in the meantime is refused.
 */
async function appendTargetWorktree(
  projectId: string,
  row: WorktreeData,
): Promise<void> {
  await applyWorktreeListUpdate(
    projectId,
    { kind: 'workspace.sourceChanges.target.record', worktree: row },
    {},
  );
}

async function ensureTargetProjectWorktree(
  git: SourceChangeGit,
  request: ProjectApplySourceChangesRequest,
  referenceRepoPath: string,
  transition?: SourceChangesTransition<ProjectApplySourceChangesResponse>,
): Promise<TargetProjectContext> {
  const worktrees = await readWorkspaceWorktrees(
    request.projectId,
    transition ? { persistRemovalCleanup: false } : undefined,
  );
  if (request.target.mode === 'existing') {
    const target = request.target;
    const worktree = worktrees.find((entry) => entry.id === target.worktreeId);
    if (!worktree) {
      throw new WorkspaceSourceChangesRefusedError(
        'not-found',
        `Project worktree ${target.worktreeId} was not found`,
      );
    }

    return {
      worktreeId: worktree.id,
      branchName: worktree.branchName,
      createdWorktree: false,
      referenceRepoPath,
      worktreePath: getWorktreeDir(request.projectId, worktree.id),
    };
  }

  const existingIds = new Set<string>(request.target.existingWorktreeIds);
  for (const worktree of worktrees) {
    existingIds.add(worktree.id);
  }

  const worktreeId = generateUniqueAnimalName(existingIds);
  const worktreePath = getWorktreeDir(request.projectId, worktreeId);

  transition?.beforeEffects?.();
  await mkdir(dirname(worktreePath), { recursive: true });
  await ensureWorktreeMetadataDirectory(
    getWorktreeDataDir(request.projectId, worktreeId),
  );
  const branchName = await git.createWorktree(
    referenceRepoPath,
    worktreePath,
    worktreeId,
  );
  const targetContext: TargetProjectContext = {
    worktreeId,
    branchName,
    createdWorktree: true,
    referenceRepoPath,
    worktreePath,
  };

  try {
    await commitW5BoundaryStep(
      transition?.commit,
      transition ? w5CompositionLocks({ lists: [request.projectId] }) : [],
      () =>
        appendTargetWorktree(request.projectId, {
          id: worktreeId,
          branchName,
          createdAt: new Date().toISOString(),
        }),
    );
  } catch (error) {
    if (
      !transition ||
      !(
        error instanceof W5RevisionConflictError ||
        error instanceof W5FileWriteRefusedError ||
        (error instanceof W5CommitRefusedError &&
          error.reason === 'unapplied-change')
      )
    )
      await rollbackCreatedProjectWorktree(
        git,
        request.projectId,
        targetContext,
      );
    throw error;
  }

  return targetContext;
}

function isRecoverableTargetManifestError(
  repoPath: string,
  error: unknown,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const canopyJsonPath = getCanopyJsonPath(repoPath);
  return error.message.startsWith(`${canopyJsonPath}:`);
}

export function applyProjectSourceChangesToWorktree(
  request: ProjectApplySourceChangesRequest,
  getWindow: () => BrowserWindow | null,
  git: SourceChangeGit,
  onApplied?: (event: ProjectSourceChangesAppliedEvent) => void,
  transition?: SourceChangesTransition<ProjectApplySourceChangesResponse>,
): Promise<ProjectApplySourceChangesResponse> {
  return withStorageAdmission(
    request.target.mode === 'new' ? [WORKTREE_LIST_STORAGE] : [],
    () =>
      applyAdmittedProjectSourceChanges(
        git,
        request,
        getWindow,
        onApplied,
        transition,
      ),
  );
}

async function applyAdmittedProjectSourceChanges(
  git: SourceChangeGit,
  request: ProjectApplySourceChangesRequest,
  getWindow: () => BrowserWindow | null,
  onApplied?: (event: ProjectSourceChangesAppliedEvent) => void,
  transition?: SourceChangesTransition<ProjectApplySourceChangesResponse>,
): Promise<ProjectApplySourceChangesResponse> {
  const config = await readWorkspaceConfig(request.projectId);
  if (config.type !== 'single-repo' || !config.repoPath) {
    throw new WorkspaceSourceChangesRefusedError(
      'not-single-repo',
      `Project ${request.projectId} is not a single-repo project`,
    );
  }
  validateAbsolutePath(config.repoPath, 'repoPath');

  const referenceRepoPath = await resolveProjectReferenceRepoPath(
    config.repoPath,
  );
  const targetContext = await ensureTargetProjectWorktree(
    git,
    request,
    referenceRepoPath,
    transition,
  );
  transition?.beforeEffects?.();
  await ensureWorktreeMetadataDirectory(
    getWorktreeDataDir(request.projectId, targetContext.worktreeId),
  );

  let manifest: CanopyJsonFile;
  try {
    manifest = (await readCanopyJson(targetContext.worktreePath)) ?? {
      version: 1,
    };
  } catch (error) {
    if (!isRecoverableTargetManifestError(targetContext.worktreePath, error)) {
      throw error;
    }

    manifest = {
      version: 1,
    };
  }

  let acceptanceStarted = false;
  try {
    applyProjectManifestScripts(manifest, request.scripts);
    applyProjectManifestHooks(manifest, request.hooks);
    applyProjectManifestPlugins(manifest, request.plugins);
    applyProjectManifestStartPage(manifest, request.startPage);
    await writeCanopyJson(targetContext.worktreePath, manifest);
    onApplied?.({
      clientRequestId: request.clientRequestId,
      projectId: request.projectId,
      worktreeId: targetContext.worktreeId,
      branchName: targetContext.branchName,
      createdWorktree: targetContext.createdWorktree,
    });

    const result: ProjectApplySourceChangesResponse = {
      worktreeId: targetContext.worktreeId,
      branchName: targetContext.branchName,
      createdWorktree: targetContext.createdWorktree,
      referenceRepoPath,
    };
    acceptanceStarted = transition !== undefined;
    const accepted = transition ? await transition.complete(result) : result;
    if (targetContext.createdWorktree) {
      const project = { repoPath: config.repoPath, scripts: config.scripts };
      detachedWorkCallback(() =>
        startProjectWorktreePostCreateSetup({
          projectId: request.projectId,
          worktreeId: targetContext.worktreeId,
          project,
          getWindow,
        }),
      )();
    }

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
      await rollbackCreatedProjectWorktree(
        git,
        request.projectId,
        targetContext,
      ).catch(() => {});
    }

    throw error instanceof Error ? error : new Error(String(error));
  }
}
