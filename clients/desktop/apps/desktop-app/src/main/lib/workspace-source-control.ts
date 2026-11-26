import { z } from 'zod';
import {
  w5CompositionLocks,
  commitW5BoundaryStep,
  decodeW5CompositionOutcome,
} from './w5-composition-operation';
import {
  checkW5ExpectedRevision,
  runW5BoundaryOperation,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import {
  W5RevisionConflictError,
  W5FileWriteRefusedError,
} from './w5-commit-log-file-store';
import { currentW5CommitScope, type W5CommitOptions } from './w5-commit-scope';
import {
  applySourceInitializationTo,
  sourceInitializationHookOverlays,
  WorkspaceSourceRepoRefusedError,
  type WorkspaceSourceRepoRefusal,
} from './worktree-record-decision-apply';
import { applyWorkspaceManifestDecision } from './workspace-record-decision-port';
import { WORKSPACE_MANIFEST_STORAGE, withStorageAdmission } from './w5-storage';
import { pipelineHookBindingsEnabled } from './workspace-source-record-policy';
import { w5LifecycleReceiptCaller, type W5WireCall } from './w5-wire-call';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { restoreWorkspaceRootInstructions } from '@canopy/core-runtime/node/workspace/workspace-instructions';
import {
  isHookTriggerName,
  normalizeHookInputMap,
  type HookAction,
  type HookOverrides,
} from '@canopy/desktop-shared/hooks';
import type { ScriptDefinition } from '@canopy/desktop-shared/scripts';
import type {
  CanopyJsonFile,
  CanopyJsonRepoEntry,
  WorkspaceConfigFile,
  WorkspaceInitGitResponse,
  WorkspaceSourceWarning,
  WorkspaceWorktreeRepairIssue,
} from '@canopy/desktop-shared/types';
import {
  createWorktree,
  getRemoteUrl,
  isGitRepo,
  stageAllChanges,
  commitWithLocalIdentity,
} from './git';
import { initializeRepositoryThroughWorker } from '../canopy-runtime/worker-git-repository-creation-dispatch';
import {
  getDefaultReposDir,
  getWorkspaceClaudeMdPath,
  getWorkspaceWorktreeRootRepoDir,
} from './paths';
import {
  readCanopyJson,
  writeCanopyJson,
  validateCanopyJson,
} from './canopy-json';
import {
  WORKSPACE_SOURCE_REPO_INITIAL_COMMIT_MESSAGE,
  ensureGitignoreContainsReposEntry,
  findAvailableWorkspaceSourceRepoPath,
  gitignoreContainsReposEntry,
  sanitizeWorkspaceSourceRepoName,
} from '@canopy/desktop-shared/node/lib/workspace-source-repo';
import {
  ensureAgentsMdSymlink,
  isProjectInstructionFileReadable,
  resolveProjectInstructionFile,
  restoreProjectInstructionFiles,
} from './instruction-files';
import { readWorkspaceIndexEntry } from './sidebar-items';
import { validateId } from './validation';
import {
  readWorkspaceConfig,
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';
import { safeRemoveWorktree } from './safe-remove-worktree';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

const WORKSPACE_ROOT_RESTORE_SKIP = new Set<string>([
  '.git',
  '.gitignore',
  'AGENTS.md',
  'canopy.json',
  'CLAUDE.md',
]);

interface BuiltWorkspaceManifest {
  manifest: CanopyJsonFile;
  localConfig: WorkspaceConfigFile;
  warnings: WorkspaceSourceWarning[];
}

/** The caller of a source repository initialization (CAN-3819). */
export type WorkspaceSourceRepoInitializeSource =
  /** `workspace:init-git` from the project settings. */
  | 'workspace_settings'
  /** A new multi-repo project, in its create commit (D2). */
  | 'workspace_create'
  /** A temporary project being promoted to a regular one. */
  | 'temporary_promote';

/** `core.workspace.sourceRepo.initialize`. */
export interface WorkspaceSourceRepoInitializeRequest extends W5BoundaryOptions {
  workspaceId: string;
  /** The repository folder name; the project name when omitted. */
  repoName?: string;
  /**
   * The project name, which the create and promote callers already hold.
   * Project settings omit it and the project's index entry supplies it.
   */
  workspaceName?: string;
  source: WorkspaceSourceRepoInitializeSource;
  /** A registered wire call's receipt scope and admission (W7b-4). */
  wireCall?: W5WireCall;
}

export {
  WorkspaceSourceRepoRefusedError,
  type WorkspaceSourceRepoRefusal,
} from './worktree-record-decision-apply';

const ALREADY_INITIALIZED_MESSAGE = 'Project already has a source repository';

const sourceRepoWarningCodes = {
  'missing-remote': 'missing-remote',
  'duplicate-source-repo': 'duplicate-source-repo',
  'duplicate-repo-binding': 'duplicate-repo-binding',
  'duplicate-single-project': 'duplicate-single-project',
  'local-hook-plugin-selections': 'local-hook-plugin-selections',
} satisfies { [Code in WorkspaceSourceWarning['code']]: Code };

const sourceRepoOutcomeSchema = z.object({
  sourceRepoPath: z.string(),
  manifest: z
    .unknown()
    .transform((value) =>
      validateCanopyJson(value, 'Saved source repository outcome'),
    ),
  warnings: z.array(
    z.object({
      code: z.enum(sourceRepoWarningCodes),
      message: z.string(),
      repoId: z.string().optional(),
      repoName: z.string().optional(),
    }),
  ),
});

function refuseSourceRepo(
  reason: WorkspaceSourceRepoRefusal,
  message: string,
): WorkspaceSourceRepoRefusedError {
  return new WorkspaceSourceRepoRefusedError(reason, message);
}

/**
 * Applies what the source repository took over to the configuration read in
 * the write queue: each repository the manifest was built from becomes a
 * manifest or local repository as the build decided, repositories added
 * since are left as they are, workspace scripts move into `canopy.json` and
 * hooks keep their local overlays.
 */
function recordSourceRepo(
  config: WorkspaceConfigFile,
  built: BuiltWorkspaceManifest,
  sourceRepoPath: string,
): void {
  applySourceInitializationTo(
    config,
    {
      kind: 'workspace.source.initialize',
      repositories: built.localConfig.repos,
      sourceRepoPath,
    },
    pipelineHookBindingsEnabled(),
  );
}

/**
 * The typed in-process `core.workspace.sourceRepo.initialize` boundary
 * (CAN-3819): creates and commits a multi-repo project's source repository
 * under the managed repos directory, from the project settings
 * (`workspace:init-git`), a new multi-repo project and a temporary project's
 * promotion.
 *
 * A missing project and, from the settings, a temporary project are refused
 * before anything is created, as is a project that already has a source
 * repository. The source repository path, the repositories the manifest took
 * over and the moved scripts are recorded on the configuration read inside
 * its write queue, so a repository or setting changed while the repository
 * was being committed is kept. A source repository recorded in the meantime
 * is refused and the new repository folder is left in place; nothing is
 * deleted. Standalone keyed attempts reserve before Git, keep recovery state
 * after uncertain effects, and save their historical result only after root
 * worktree repair. Parent composition retains its own binding and receipt.
 * The operation stays unregistered.
 */
export async function initializeWorkspaceSourceRepo(
  request: WorkspaceSourceRepoInitializeRequest,
  transition?: { commit: W5CommitOptions; beforeEffects?: () => void },
): Promise<WorkspaceInitGitResponse> {
  validateId(request.workspaceId, 'workspaceId');
  if (
    (request.idempotencyKey !== undefined ||
      request.expectedRevision !== undefined) &&
    (transition || currentW5CommitScope())
  ) {
    throw refuseSourceRepo(
      'invalid-request',
      'Standalone source initialization revision or retry options cannot join a parent commit',
    );
  }
  if (transition)
    return initializeWorkspaceSourceRepoAdmitted(request, transition);
  if (
    request.idempotencyKey === undefined &&
    request.expectedRevision === undefined
  )
    return initializeWorkspaceSourceRepoAdmitted(request);
  return withStorageAdmission([WORKSPACE_MANIFEST_STORAGE], () => {
    const parameters = { ...request };
    delete parameters.expectedRevision;
    delete parameters.idempotencyKey;
    delete parameters.wireCall;
    return runW5BoundaryOperation<WorkspaceInitGitResponse>(
      {
        operation: 'core.workspace.sourceRepo.initialize',
        caller: w5LifecycleReceiptCaller(
          'workspace-source-initialization',
          request.wireCall,
        ),
        idempotencyKey: request.idempotencyKey,
        parameters,
        admit: request.wireCall?.admit,
        recheckAtOutcome: true,
        isPreEffectRefusal: (error) =>
          error instanceof WorkspaceSourceRepoRefusedError ||
          error instanceof W5RevisionConflictError ||
          error instanceof W5FileWriteRefusedError,
      },
      (outcome) => decodeW5CompositionOutcome(sourceRepoOutcomeSchema, outcome),
      async (commit, attempt) => {
        const resource = {
          kind: 'workspace',
          workspaceId: request.workspaceId,
        } as const;
        commit.expectedRevisions = w5ExpectedRevision(
          resource,
          request.expectedRevision,
        );
        await checkW5ExpectedRevision(resource, request.expectedRevision);
        return initializeWorkspaceSourceRepoAdmitted(request, {
          commit,
          beforeEffects: attempt?.beforeEffects,
        });
      },
    );
  });
}

async function initializeWorkspaceSourceRepoAdmitted(
  request: WorkspaceSourceRepoInitializeRequest,
  transition?: { commit: W5CommitOptions; beforeEffects?: () => void },
): Promise<WorkspaceInitGitResponse> {
  const { workspaceId } = request;
  const detail = await readWorkspaceConfigDetailed(workspaceId);
  if (detail.authority === 'absent') {
    throw refuseSourceRepo('not-found', `Project ${workspaceId} not found`);
  }
  if (detail.authority === 'unreadable') {
    throw refuseSourceRepo(
      'configuration-unavailable',
      new WorkspaceConfigUnreadableError(detail.unserved).message,
    );
  }
  const localConfig = detail.config;
  if (request.source === 'workspace_settings' && localConfig.temporary) {
    throw refuseSourceRepo(
      'temporary',
      'Promote this temporary project before initializing source control.',
    );
  }
  if (localConfig.sourceRepoPath) {
    throw refuseSourceRepo('already-initialized', ALREADY_INITIALIZED_MESSAGE);
  }
  const workspaceName =
    request.workspaceName ??
    (await readWorkspaceIndexEntry(workspaceId))?.name ??
    workspaceId;

  transition?.beforeEffects?.();
  const prepared = await prepareWorkspaceSourceRepo(
    request,
    localConfig,
    workspaceName,
  );
  const { built, sourceRepoPath } = prepared;

  try {
    const stageInitializedSourceRepo = (): Promise<void> =>
      applyWorkspaceManifestDecision(workspaceId, {
        kind: 'workspace.source.initialize',
        repositories: built.localConfig.repos,
        sourceRepoPath,
      });
    await commitW5BoundaryStep(
      transition?.commit,
      transition ? w5CompositionLocks({ manifests: [workspaceId] }) : [],
      stageInitializedSourceRepo,
    );
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError) {
      throw refuseSourceRepo('configuration-unavailable', error.message);
    }
    throw error;
  }
  if (
    request.idempotencyKey !== undefined ||
    request.expectedRevision !== undefined
  ) {
    await repairExistingWorkspaceRootWorktrees(workspaceId, {
      persistRemovalCleanup: false,
    });
  } else {
    await repairExistingWorkspaceRootWorktrees(workspaceId);
  }

  return {
    sourceRepoPath,
    manifest: built.manifest,
    warnings: built.warnings,
  };
}

/** Provisions source control before a new workspace enters its W5 write scope. */
export async function prepareNewWorkspaceSourceRepo(
  workspaceId: string,
  workspaceName: string,
  config: WorkspaceConfigFile,
  plannedSourceRepoPath?: string,
): Promise<string> {
  validateId(workspaceId, 'workspaceId');
  const { built, sourceRepoPath } = await prepareWorkspaceSourceRepo(
    { workspaceId, workspaceName, source: 'workspace_create' },
    config,
    workspaceName,
    plannedSourceRepoPath,
  );
  recordSourceRepo(config, built, sourceRepoPath);
  return sourceRepoPath;
}

async function prepareWorkspaceSourceRepo(
  request: WorkspaceSourceRepoInitializeRequest,
  localConfig: WorkspaceConfigFile,
  workspaceName: string,
  plannedSourceRepoPath?: string,
): Promise<{ built: BuiltWorkspaceManifest; sourceRepoPath: string }> {
  const { workspaceId } = request;
  const destinationRoot = await ensureDefaultReposDir();
  const preferredName = sanitizeWorkspaceSourceRepoName(
    request.repoName ?? workspaceName,
  );
  const sourceRepoPath =
    plannedSourceRepoPath ??
    (await findAvailableWorkspaceSourceRepoPath(
      destinationRoot,
      preferredName,
    ));

  // Validate and prepare the portable manifest before creating a repository.
  const built = await buildWorkspaceManifest(localConfig);

  await mkdir(sourceRepoPath, {
    recursive: plannedSourceRepoPath === undefined,
  });
  await initializeRepositoryThroughWorker({
    kind: 'empty',
    directory: sourceRepoPath,
  });

  await writeWorkspaceRootFiles(
    sourceRepoPath,
    built.manifest,
    true,
    getWorkspaceClaudeMdPath(workspaceId),
  );

  await stageAllChanges(sourceRepoPath);
  await commitWithLocalIdentity(
    sourceRepoPath,
    WORKSPACE_SOURCE_REPO_INITIAL_COMMIT_MESSAGE,
  );

  return { built, sourceRepoPath };
}

export async function repairExistingWorkspaceRootWorktrees(
  workspaceId: string,
  options?: { persistRemovalCleanup: false },
): Promise<void> {
  // Startup project loading can overlap automatic archival. Re-read targets
  // only after acquiring the same operation lock used by capture and deletion.
  const { withArchivedWorkspaceOperationLock } =
    await import('./archived-containers');
  return withArchivedWorkspaceOperationLock(workspaceId, () =>
    repairExistingWorkspaceRootWorktreesWithoutOperationLock(
      workspaceId,
      options,
    ),
  );
}

async function repairExistingWorkspaceRootWorktreesWithoutOperationLock(
  workspaceId: string,
  options?: { persistRemovalCleanup: false },
): Promise<void> {
  const config = await readWorkspaceConfig(workspaceId);
  if (!config.sourceRepoPath) {
    return;
  }
  const referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
    config.sourceRepoPath,
  );

  const worktrees = options
    ? await readWorkspaceWorktrees(workspaceId, options)
    : await readWorkspaceWorktrees(workspaceId);
  const failures: string[] = [];

  for (const worktree of worktrees) {
    const worktreeRoot = getWorkspaceWorktreeRootRepoDir(
      workspaceId,
      worktree.id,
    );
    if (!(await pathExists(worktreeRoot))) {
      continue;
    }

    try {
      await repairExistingWorkspaceRootWorktree(
        workspaceId,
        worktree.id,
        worktree.branchName.trim() || worktree.id,
        referenceRepoPath,
      );
    } catch (error) {
      failures.push(
        `${worktree.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to repair ${failures.length} project root worktrees:\n${failures.join('\n')}`,
    );
  }
}

export async function validateWorkspaceRootWorktree(
  workspaceId: string,
  worktreeId: string,
): Promise<WorkspaceWorktreeRepairIssue[]> {
  const worktreeRoot = getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId);
  const issues: WorkspaceWorktreeRepairIssue[] = [];

  if (!(await gitignoreContainsReposEntry(worktreeRoot))) {
    const gitignorePath = join(worktreeRoot, '.gitignore');
    issues.push({
      code: (await pathExists(gitignorePath))
        ? 'invalid-gitignore'
        : 'missing-gitignore',
      message: '.gitignore must include "repos/" for nested project repos',
      blocking: true,
    });
  }

  try {
    const manifest = await readCanopyJson(worktreeRoot);
    if (manifest === null) {
      issues.push({
        code: 'missing-canopy-json',
        message: 'canopy.json is missing from the project root',
        blocking: true,
      });
    }
  } catch (error) {
    issues.push({
      code: 'invalid-canopy-json',
      message:
        error instanceof Error ? error.message : 'canopy.json is invalid',
      blocking: true,
    });
  }

  const [hasAgentsMd, hasClaudeMd] = await settleAll([
    isProjectInstructionFileReadable(worktreeRoot, 'AGENTS.md').catch(
      () => false,
    ),
    isProjectInstructionFileReadable(worktreeRoot, 'CLAUDE.md').catch(
      () => false,
    ),
  ]);
  if (!hasAgentsMd && !hasClaudeMd) {
    issues.push({
      code: 'missing-claude-md',
      message: 'AGENTS.md is missing from the project root',
      blocking: false,
    });
  }

  if (!hasAgentsMd) {
    issues.push({
      code: 'invalid-agents-md',
      message: 'AGENTS.md must mirror CLAUDE.md',
      blocking: false,
    });
  }

  return issues;
}

export async function repairWorkspaceRootWorktree(
  workspaceId: string,
  worktreeId: string,
  restoreClaudeMd: boolean,
): Promise<WorkspaceWorktreeRepairIssue[]> {
  const config = await readWorkspaceConfig(workspaceId);
  if (!config.sourceRepoPath) {
    throw new Error('Project does not have a source repository');
  }
  const referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
    config.sourceRepoPath,
  );

  const manifest =
    (await readCanopyJson(referenceRepoPath).catch(() => null)) ??
    buildRepairManifest(config);
  const worktreeRoot = getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId);

  await writeWorkspaceRootFiles(
    worktreeRoot,
    manifest,
    restoreClaudeMd,
    join(referenceRepoPath, 'CLAUDE.md'),
  );
  return validateWorkspaceRootWorktree(workspaceId, worktreeId);
}

export async function buildWorkspaceManifest(
  config: WorkspaceConfigFile,
): Promise<BuiltWorkspaceManifest> {
  const warnings: WorkspaceSourceWarning[] = [];
  const manifestRepos: CanopyJsonRepoEntry[] = [];
  const localRepos: WorkspaceConfigFile['repos'] = [];

  for (const repo of config.repos) {
    const remoteUrl = await getRemoteUrl(repo.repoPath);
    if (remoteUrl) {
      manifestRepos.push({
        id: repo.id,
        name: repo.name,
        url: remoteUrl,
        ...(repo.scripts ? { scripts: repo.scripts } : {}),
        ...(repo.hooks
          ? {
              hooks: normalizeManifestRepoHooks(
                repo.hooks,
                warnings,
                repo.id,
                repo.name,
              ),
            }
          : {}),
      });
      localRepos.push({
        ...repo,
        source: 'manifest',
        manifestUrl: remoteUrl,
        scripts: undefined,
        hooks: extractLocalHookOverlays(repo.hooks),
      });
      continue;
    }

    warnings.push({
      code: 'missing-remote',
      repoId: repo.id,
      repoName: repo.name,
      message: `${repo.name} has no origin remote and remains local-only`,
    });
    localRepos.push({
      ...repo,
      source: 'local',
      manifestUrl: undefined,
    });
  }

  const manifest: CanopyJsonFile = {
    version: 1,
    ...(config.scripts
      ? { scripts: filterManifestScripts(config.scripts) }
      : {}),
    ...(config.hooks
      ? { hooks: normalizeManifestWorkspaceHooks(config.hooks, warnings) }
      : {}),
    repos: manifestRepos,
  };

  return {
    manifest,
    localConfig: {
      ...config,
      repos: localRepos,
      scripts: undefined,
      hooks: extractLocalHookOverlays(config.hooks),
    },
    warnings,
  };
}

function buildRepairManifest(config: WorkspaceConfigFile): CanopyJsonFile {
  const manifestRepos: CanopyJsonRepoEntry[] = [];

  for (const repo of config.repos) {
    if (repo.source !== 'manifest' || !repo.manifestUrl) {
      continue;
    }

    manifestRepos.push({
      id: repo.id,
      name: repo.name,
      url: repo.manifestUrl,
    });
  }

  return {
    version: 1,
    repos: manifestRepos,
  };
}

async function writeWorkspaceRootFiles(
  targetDir: string,
  manifest: CanopyJsonFile,
  restoreClaudeMd: boolean,
  claudeMdSourcePath: string,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  await ensureGitignoreContainsReposEntry(targetDir);
  await writeCanopyJson(targetDir, manifest);

  try {
    await restoreWorkspaceRootInstructions(
      {
        targetDir,
        sourceDir: dirname(claudeMdSourcePath),
        restore: restoreClaudeMd,
      },
      {
        resolve: resolveProjectInstructionFile,
        agentsMdExists: () => pathExists(join(targetDir, 'AGENTS.md')),
        ensureAgentsMdAlias: () => ensureAgentsMdSymlink(targetDir),
        restore: (source, target) =>
          restoreProjectInstructionFiles(source, target),
      },
    );
  } catch {
    return;
  }
}

async function repairExistingWorkspaceRootWorktree(
  workspaceId: string,
  worktreeId: string,
  branchName: string,
  referenceRepoPath: string,
): Promise<void> {
  const worktreeRoot = getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId);

  if (await isGitRepo(worktreeRoot)) {
    const existingIssues = await validateWorkspaceRootWorktree(
      workspaceId,
      worktreeId,
    );
    if (!existingIssues.some((issue) => issue.blocking)) {
      return;
    }

    const issues = await repairWorkspaceRootWorktree(
      workspaceId,
      worktreeId,
      true,
    );
    const blockingIssues = issues.filter((issue) => issue.blocking);
    if (blockingIssues.length > 0) {
      throw new Error(formatRepairIssues(blockingIssues));
    }
    return;
  }

  const shelvedDir = await shelveWorkspaceRootEntries(worktreeRoot, worktreeId);
  try {
    await createWorktree(referenceRepoPath, worktreeRoot, branchName);
    await restoreShelvedWorkspaceRootEntries(worktreeRoot, shelvedDir);
    const existingIssues = await validateWorkspaceRootWorktree(
      workspaceId,
      worktreeId,
    );
    const issues = existingIssues.some((issue) => issue.blocking)
      ? await repairWorkspaceRootWorktree(workspaceId, worktreeId, true)
      : existingIssues;
    const blockingIssues = issues.filter((issue) => issue.blocking);
    if (blockingIssues.length > 0) {
      throw new Error(formatRepairIssues(blockingIssues));
    }
  } catch (error) {
    await rollbackShelvedWorkspaceRootEntries(
      referenceRepoPath,
      worktreeRoot,
      shelvedDir,
    );
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function shelveWorkspaceRootEntries(
  worktreeRoot: string,
  worktreeId: string,
): Promise<string | null> {
  if (!(await pathExists(worktreeRoot))) {
    return null;
  }

  const entries = await readdir(worktreeRoot, { withFileTypes: true });
  if (entries.length === 0) {
    await rm(worktreeRoot, { recursive: true, force: true });
    return null;
  }

  const shelvedDir = join(dirname(worktreeRoot), `.${worktreeId}-root-repair`);
  await rm(shelvedDir, { recursive: true, force: true });
  await mkdir(shelvedDir, { recursive: true });

  for (const entry of entries) {
    await rename(join(worktreeRoot, entry.name), join(shelvedDir, entry.name));
  }

  await rm(worktreeRoot, { recursive: true, force: true });
  return shelvedDir;
}

async function restoreShelvedWorkspaceRootEntries(
  worktreeRoot: string,
  shelvedDir: string | null,
): Promise<void> {
  if (!shelvedDir || !(await pathExists(shelvedDir))) {
    return;
  }

  const entries = await readdir(shelvedDir, { withFileTypes: true });
  for (const entry of entries) {
    if (WORKSPACE_ROOT_RESTORE_SKIP.has(entry.name)) {
      continue;
    }

    const targetPath = join(worktreeRoot, entry.name);
    if (await pathExists(targetPath)) {
      continue;
    }

    await rename(join(shelvedDir, entry.name), targetPath);
  }

  await rm(shelvedDir, { recursive: true, force: true });
}

async function rollbackShelvedWorkspaceRootEntries(
  referenceRepoPath: string,
  worktreeRoot: string,
  shelvedDir: string | null,
): Promise<void> {
  if (await pathExists(worktreeRoot)) {
    try {
      await safeRemoveWorktree(
        referenceRepoPath,
        worktreeRoot,
        'workspace-source-control safeRemoveWorktree',
      );
    } catch {
      await rm(worktreeRoot, { recursive: true, force: true });
    }
  }

  if (!shelvedDir || !(await pathExists(shelvedDir))) {
    return;
  }

  await mkdir(worktreeRoot, { recursive: true });
  const entries = await readdir(shelvedDir, { withFileTypes: true });
  for (const entry of entries) {
    await rename(join(shelvedDir, entry.name), join(worktreeRoot, entry.name));
  }
  await rm(shelvedDir, { recursive: true, force: true });
}

function filterManifestScripts(
  scripts: WorkspaceConfigFile['scripts'],
): Record<string, string | ScriptDefinition> | undefined {
  if (!scripts) {
    return undefined;
  }

  const entries = Object.entries(scripts).filter(
    (entry): entry is [string, string | ScriptDefinition] => entry[1] !== null,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeManifestWorkspaceHooks(
  hooks: WorkspaceConfigFile['hooks'],
  warnings: WorkspaceSourceWarning[],
): CanopyJsonFile['hooks'] {
  const normalized = normalizeHookInputMap(hooks);
  if (!normalized) {
    return undefined;
  }

  const nextHooks: NonNullable<CanopyJsonFile['hooks']> = {};
  let strippedLocalSelections = false;
  for (const [triggerName, actions] of Object.entries(normalized)) {
    if (isHookTriggerName(triggerName) && Array.isArray(actions)) {
      const portable = portableManifestHookActions(actions);
      nextHooks[triggerName] = portable.actions;
      strippedLocalSelections ||= portable.strippedLocalSelections;
    }
  }
  if (strippedLocalSelections) {
    warnings.push({
      code: 'local-hook-plugin-selections',
      message:
        'Local hook plugin selections and installed mentions remain in project settings and were omitted from canopy.json.',
    });
  }
  return Object.keys(nextHooks).length > 0 ? nextHooks : undefined;
}

function normalizeManifestRepoHooks(
  hooks: WorkspaceConfigFile['repos'][number]['hooks'],
  warnings: WorkspaceSourceWarning[],
  repoId: string,
  repoName: string,
): CanopyJsonRepoEntry['hooks'] {
  const normalized = normalizeHookInputMap(hooks);
  if (!normalized) {
    return undefined;
  }

  const nextHooks: NonNullable<CanopyJsonRepoEntry['hooks']> = {};
  let strippedLocalSelections = false;
  for (const [triggerName, actions] of Object.entries(normalized)) {
    if (!isHookTriggerName(triggerName)) {
      continue;
    }
    if (actions === null) {
      nextHooks[triggerName] = null;
      continue;
    }
    if (Array.isArray(actions)) {
      const portable = portableManifestHookActions(actions);
      nextHooks[triggerName] = portable.actions;
      strippedLocalSelections ||= portable.strippedLocalSelections;
    }
  }

  if (strippedLocalSelections) {
    warnings.push({
      code: 'local-hook-plugin-selections',
      repoId,
      repoName,
      message: `${repoName} hook plugin selections and installed mentions remain local and were omitted from canopy.json.`,
    });
  }

  return Object.keys(nextHooks).length > 0 ? nextHooks : undefined;
}

function portableManifestHookActions(actions: HookAction[]): {
  actions: HookAction[];
  strippedLocalSelections: boolean;
} {
  let strippedLocalSelections = false;
  const portableActions = actions.map((action) => {
    const portableAction = { ...action };
    if (
      (portableAction.type === 'pipeline' || portableAction.type === 'chat') &&
      pipelineHookBindingsEnabled()
    ) {
      delete portableAction.executionContext;
      delete portableAction.localExecutionContextOverlay;
    }
    const hasLocalOnlyPluginState =
      portableAction.type === 'chat' &&
      (portableAction.pluginSelections !== undefined ||
        portableAction.localPluginSelectionOverlay === true ||
        portableAction.localPluginSelectionOverlayKey !== undefined ||
        portableAction.promptReferences?.some(
          (reference) =>
            reference.kind === 'plugin' &&
            reference.plugin.kind === 'installed',
        ) === true);
    if (!hasLocalOnlyPluginState) {
      return portableAction;
    }
    strippedLocalSelections = true;
    delete portableAction.pluginSelections;
    delete portableAction.localPluginSelectionOverlay;
    delete portableAction.localPluginSelectionOverlayKey;
    if (portableAction.type === 'chat' && portableAction.promptReferences) {
      const references = portableAction.promptReferences.filter(
        (reference) =>
          reference.kind !== 'plugin' || reference.plugin.kind !== 'installed',
      );
      if (references.length > 0) portableAction.promptReferences = references;
      else delete portableAction.promptReferences;
    }
    return portableAction;
  });
  return { actions: portableActions, strippedLocalSelections };
}

function extractLocalHookOverlays(
  hooks: WorkspaceConfigFile['hooks'],
): HookOverrides | undefined {
  return sourceInitializationHookOverlays(hooks, pipelineHookBindingsEnabled());
}

async function ensureDefaultReposDir(): Promise<string> {
  const reposDir = getDefaultReposDir();
  await mkdir(reposDir, { recursive: true });
  return reposDir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function formatRepairIssues(issues: WorkspaceWorktreeRepairIssue[]): string {
  return issues.map((issue) => issue.message).join('; ');
}
