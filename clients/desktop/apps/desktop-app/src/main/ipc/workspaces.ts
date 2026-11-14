import { worktreeRemovalIntent } from '@canopy/protocol/portal/worktree-recovery';
import { sourceChangeGit } from '../canopy-runtime/worker-git-worktree-adapter';
import type { ScriptActionsAddMetadata } from '@canopy/protocol/script-actions';
import { normalizeRepositoryCloneUrl } from '@canopy/protocol/portal';
import { bindCombinationAfterJoin } from '../lib/adhoc-combination-binding';
import { requestOrgProjectAutoConversion } from '../services/org-project-auto-conversion-host';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import {
  projectedWorkspaceMetadataCommands,
  type ProjectedWorkspaceMetadataCommands,
} from '../canopy-runtime/workspace-metadata-dispatch';
import {
  projectedWorkspaceLifecycleCommands,
  type ProjectedWorkspaceLifecycleCommands,
} from '../canopy-runtime/workspace-lifecycle-dispatch';
import {
  projectedSourceCompositionCommands,
  type ProjectedSourceCompositionCommands,
} from '../canopy-runtime/source-composition-dispatch';
import { inferCloneRepoName } from '../lib/git-clone-progress';
import type { DesktopIpcCallerResolver } from './file-tree';
import {
  projectedWorkspaceGuardedCommands,
  type ProjectedWorkspaceGuardedCommands,
} from '../canopy-runtime/workspace-guarded-dispatch';
import {
  IPC_CHANNELS,
  type AddWorkspaceFromFolderCheck,
  type CheckAddWorkspaceFromFolderRequest,
  type AddWorkspaceFromFolderRequest,
  type AddWorkspaceFromRemoteRequest,
  type AddRepoToWorkspaceResponse,
  type AddRepoToWorkspaceRequest,
  type AddRepoToWorktreeRequest,
  type AdhocExistingWorktreeCombineRequest,
  type AdhocExistingWorktreeCombineResponse,
  type AdhocMultiRepoCombineRequest,
  type AdhocMultiRepoCombineResponse,
  type AdhocMultiRepoJoinOptionsRequest,
  type AdhocMultiRepoJoinOptionsResponse,
  type ArchiveWorktreeResponse,
  type ArchiveWorkspaceWorktreeRequest,
  type ConvertWorkspaceTypeRequest,
  type CreateNewWorkspaceRequest,
  type CreateTemporaryWorkspaceFromReposRequest,
  type CreateTemporaryWorkspaceFromReposResponse,
  type CreateTemporaryWorkspaceFromWorkspacesRequest,
  type CreateTemporaryWorkspaceWorktreeFromReposResponse,
  type CreateTemporaryWorkspaceWorktreeFromWorkspacesResponse,
  type CreateWorkspaceWorktreeResponse,
  type CreateWorkspaceWorktreeRequest,
  type DeleteWorkspaceRequest,
  type ExistingWorktreeJoinOptionsRequest,
  type ExistingWorktreeJoinOptionsResponse,
  type MultiRepoSidebarItem,
  type PromoteTemporaryWorkspaceRequest,
  type ReadWorkspaceReadinessRequest,
  type ReadWorkspaceReadinessResponse,
  type ReadWorkspaceDriftSummaryRequest,
  type ReadWorkspaceDriftSummaryResponse,
  type SidebarItem,
  type RemoveRepoFromWorkspaceRequest,
  type RemoveRepoFromWorktreeRequest,
  type SaveDefaultPluginsRequest,
  type SaveWorkspaceClaudeMdRequest,
  type SetWorkspaceArchiveRetentionRequest,
  type SetWorkspaceStartPageRequest,
  type SetWorkspacePrivateMemoryRequest,
  type ResolveProjectStartPageRequest,
  type ResolveProjectStartPageResponse,
  type SplitTemporaryWorkspacePreviewRequest,
  type SplitTemporaryWorkspacePreviewResponse,
  type SplitTemporaryWorkspaceDestructiveApprovalRequest,
  type SplitTemporaryWorkspaceDestructiveApprovalResponse,
  type SplitTemporaryWorkspaceRequest,
  type SplitTemporaryWorkspaceResponse,
  type WorkspaceAttachOriginRequest,
  type WorkspaceApplySourceChangesRequest,
  type WorkspaceApplySourceChangesResponse,
  type WorkspaceClaudeMdRequest,
  type WorkspaceImportFromRepoRequest,
  type WorkspaceImportFromRepoResponse,
  type WorkspaceInitGitRequest,
  type WorkspaceInitGitResponse,
  type WorkspaceRequestReferenceRepoRefreshRequest,
  type WorkspaceRepairWorktreeRequest,
  type WorkspaceRepairWorktreeResponse,
  type WorktreeGitReadyEvent,
  type WorkspaceResolveReferenceRepoWarningRequest,
  type WorkspaceRepoData,
  type WorkspaceSettingsDataRequest,
  type ReadWorkspaceScriptsRequest,
  type MergeWorkspaceScriptsRequest,
  type WorkspaceSettingsDataResponse,
} from '@canopy/desktop-shared/types';
import {
  addRemoteAndSync,
  createWorktree,
  createWorktreeForExistingBranch,
  createWorktreeFromStartPoint,
  deleteBranch,
  doesLocalBranchExist,
  doesRemoteBranchExist,
  fetchOrigin,
  isRegisteredWorktreePath,
  getCurrentBranch,
  getRepoRootFromWorktree,
} from '../lib/git';
import { getWorktreeDataDir, getWorkspaceWorktreeRepoDir } from '../lib/paths';
import {
  getWorkspaceInstructions,
  updateWorkspaceInstructions,
} from '../canopy-runtime/workspace-instructions-dispatch';
import { validateId } from '../lib/validation';
import { getCloneJobs } from '../services/clone-jobs-host';
import {
  classifyGitHubAuthFailure,
  GitHubAuthFailureError,
} from '../lib/github-push-auth-failure';
import {
  assertMutuallyExclusiveWorktreeBaseSources,
  validateOptionalWorktreeBaseBranch,
} from './worktree-create-validation';
import { assertNotSplitLocked } from '../services/split-lock-service';
import { WORKTREE_LIST_STORAGE, withStorageAdmission } from '../lib/w5-storage';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { reconcileWorktreeRecovery } from '../lib/worktree-repair';
import { settleWorktreeGitSetup } from '../lib/worktree-git-setup';
import { getOrgMemberMultiRepoSync } from '../lib/org-member-multi-repo-sync-deps';
import { resolveProjectStartPage } from '../lib/project-start-page';
import { assertStartPageFeatureEnabled } from '../lib/start-page-feature-flag';
import { convertWorkspaceType } from '../lib/workspace-type-conversion';
import { saveDefaultPluginsAndVisibility } from '../lib/workspace-default-plugins-save';
import { readWorkspaceRepoOrThrow } from '../lib/workspace-script-config';
import { setWorkspacePrivateMemory } from '../memory/local/private-memory-setting';
import { sendToAllWindows } from '../lib/window-send';
import { deleteWorkspaceById } from '../lib/workspace-deletion';
import { registerIpcHandler } from './register';
import { archiveWorktree } from '../lib/worktree-archive';
import { withTypedArchiveRefusal } from '../lib/worktree-discard';
import { readWorkspaceScriptCommands } from '../lib/script-source-info';
import { mergeWorkspaceScriptCommands } from '../lib/script-definition-saves';
import { triggerDiscovery } from './worktree-discovery';
import { readPreferencesFile } from './preferences';
import {
  deletePrTrackingState,
  getWorkspaceRepoStorageKey,
} from '../lib/github-pr-hook-state';
import { stopHooksForRepoTarget } from '../lib/hook-runner';
import {
  invalidateWorktreeDiffStats,
  refreshWorktreeDiffStats,
  removeCachedWorktreeDiffStats,
  removeCachedWorkspaceDiffStats,
} from '../services/worktree-diff-stats-cache';

function refreshCachedDiffStats(workspaceId: string, worktreeId: string): void {
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  invalidateWorktreeDiffStats(workspaceId, worktreeId);
  trackDetachedWork(() => refreshWorktreeDiffStats(workspaceId, worktreeId));
}
import {
  readWorkspaceSettingsData,
  readEffectiveWorkspaceConfig,
} from '../lib/workspace-source';
import { readWorkspaceDriftSummary } from '../lib/workspace-drift';
import { applySourceChanges } from '../lib/workspace-source-changes';
import { resolveWorkspaceReferenceRepoPath } from '../lib/workspace-reference-repo';
import { computeWorkspaceReadinessAudit } from '../lib/workspace-readiness';
import {
  initializeWorkspaceSourceRepo,
  repairWorkspaceRootWorktree,
} from '../lib/workspace-source-control';
import {
  requestRefresh,
  resolveWarning,
} from '../lib/workspace-reference-repo-poller';
import { queueTrackedGitHubWorktreeSync } from '../lib/post-archive-sync';
import { startWorkspaceWorktreePostCreateSetup } from '../lib/workspace-worktree-runtime';
import { startProjectWorktreePostCreateSetup } from '../lib/project-worktree-runtime';
import { sendToWindow } from '../lib/window-send';
import { pathExists } from '../lib/fs-utils';
import { safeRemoveWorktree } from '../lib/safe-remove-worktree';
import {
  checkAddWorkspaceFromFolder,
  type AddWorkspaceFromRemoteProgress,
} from '../lib/workspace-service';
import { createWorkspace } from '../lib/workspace-creation';
import {
  combineWorktreeWithWorkspace,
  createOrReuseTemporaryWorkspaceFromRepos,
  createOrReuseTemporaryWorkspaceFromWorkspaces,
  listAdhocMultiRepoJoinOptions,
  promoteTemporaryWorkspace,
} from '../lib/adhoc-multi-repo-workspaces';
import {
  combineWorktreeWithExistingWorktree,
  listExistingWorktreeJoinOptions,
} from '../lib/adhoc-existing-worktree-join';
import {
  previewSplitTemporaryWorkspaceWorktree,
  splitTemporaryWorkspaceWorktree,
} from '../lib/split-temporary-workspace';
import {
  consumeSplitTemporaryWorkspaceDestructiveApproval,
  createSplitTemporaryWorkspaceDestructiveApproval,
} from '../lib/split-temporary-workspace-approval';
import { addRepoCheckoutToWorktree } from '../lib/workspace-repo-mutators';
import { createWorktreeFromSelection } from '../lib/worktree-creation';
import { resolveWorktreeCreationSelection } from '../lib/worktree-creation-selection';
import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from '../lib/worktree-live-cleanup';
import {
  recordWorkspaceCrudTelemetry,
  recordWorktreeCrudTelemetry,
} from '../lib/desktop-telemetry';
import {
  settleAll,
  settleEach,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

function validateSplitTemporaryWorkspaceRequest(
  request:
    | SplitTemporaryWorkspaceRequest
    | SplitTemporaryWorkspaceDestructiveApprovalRequest,
): void {
  validateId(request.workspaceId, 'workspaceId');
  validateId(request.worktreeId, 'worktreeId');
  if (
    request.selections === null ||
    typeof request.selections !== 'object' ||
    Array.isArray(request.selections)
  ) {
    throw new Error('selections must be a repoId → selection record');
  }
  for (const [repoId, selection] of Object.entries(request.selections)) {
    validateId(repoId, 'selections repoId');
    if (selection !== 'split' && selection !== 'remove') {
      throw new Error(
        `Invalid SplitTemporaryWorkspaceRequest selection: ${String(selection)}`,
      );
    }
  }
  if (
    request.rootAction !== undefined &&
    request.rootAction !== 'archive' &&
    request.rootAction !== 'delete'
  ) {
    throw new Error(
      `Invalid SplitTemporaryWorkspaceRequest rootAction: ${String(request.rootAction)}`,
    );
  }
  if (
    'destructiveApprovalToken' in request &&
    request.destructiveApprovalToken !== undefined &&
    (typeof request.destructiveApprovalToken !== 'string' ||
      request.destructiveApprovalToken.length === 0)
  ) {
    throw new Error('destructiveApprovalToken must be a non-empty string');
  }
}

function getAdhocAddedReposForSetup(
  response: AdhocMultiRepoCombineResponse,
): WorkspaceRepoData[] {
  const addedRepoIds = new Set(
    response.repoMappings
      .filter((mapping) => mapping.oldWorktreePath === undefined)
      .map((mapping) => mapping.destinationRepoId),
  );
  if (addedRepoIds.size === 0) {
    return [];
  }
  return response.destinationWorkspace.repos.filter((repo) =>
    addedRepoIds.has(repo.id),
  );
}

async function createInitialWorktreeForTemporaryWorkspaceResponse(
  response: CreateTemporaryWorkspaceFromReposResponse,
  getWindow: () => BrowserWindow | null,
): Promise<CreateTemporaryWorkspaceWorktreeFromReposResponse> {
  if (response.workspace.type === 'cowork') {
    throw new Error('Cannot create a worktree for a cowork project.');
  }

  const existingWorktreeIds = response.workspace.worktrees.map(
    (worktree) => worktree.id,
  );

  if (response.workspace.type === 'single-repo') {
    const worktree = (
      await createWorktreeFromSelection({
        workspaceId: response.workspace.id,
        workspaceKind: 'single-repo',
        branch: { kind: 'default' },
        base: { kind: 'repository-default' },
        existingWorktreeIds,
        startPostCreateSetup: true,
        startProjectPostCreateSetup: startProjectWorktreePostCreateSetup,
        getWindow,
        deferGitSetup: true,
        onGitReady: (payload): void => {
          refreshCachedDiffStats(payload.projectId, payload.worktreeId);
          const window = getWindow();
          if (!window) {
            return;
          }
          sendToWindow(window, IPC_CHANNELS.worktreeGitReady, payload);
        },
        onGitFailed: (payload): void => {
          const window = getWindow();
          if (!window) {
            return;
          }
          sendToWindow(window, IPC_CHANNELS.worktreeGitFailed, payload);
        },
      })
    ).response;
    return { ...response, worktree };
  }

  const worktree = (
    await createWorktreeFromSelection({
      workspaceId: response.workspace.id,
      workspaceKind: 'multi-repo',
      branch: { kind: 'default' },
      base: { kind: 'repository-default' },
      existingWorktreeIds,
      startPostCreateSetup: true,
      startWorkspacePostCreateSetup: startWorkspaceWorktreePostCreateSetup,
      getWindow,
      deferGitSetup: true,
      onGitReady: (payload): void => {
        refreshCachedDiffStats(payload.projectId, payload.worktreeId);
        const window = getWindow();
        if (!window) {
          return;
        }
        sendToWindow(window, IPC_CHANNELS.worktreeGitReady, payload);
      },
      onGitFailed: (payload): void => {
        const window = getWindow();
        if (!window) {
          return;
        }
        sendToWindow(window, IPC_CHANNELS.worktreeGitFailed, payload);
      },
    })
  ).response;
  return { ...response, worktree };
}

/*
 * The window's calls as owners, so App Advisor's actions in Electron main
 * make the same ones (CAN-6003).
 */

export async function readWorkspaceSettingsDataForCaller(
  request: WorkspaceSettingsDataRequest,
): Promise<WorkspaceSettingsDataResponse> {
  validateId(request.workspaceId, 'workspaceId');
  return readWorkspaceSettingsData(request.workspaceId, request.worktreeId);
}

export function registerWorkspaceHandlers(
  getWindow: () => BrowserWindow | null,
  runtime: {
    dispatcher: Pick<
      DesktopCanopyDispatcher,
      'queryWorktreeListForLegacyIpc' | 'query' | 'instruction'
    >;
    resolveCaller: DesktopIpcCallerResolver;
  },
): void {
  const metadataCommands = (
    event: Parameters<DesktopIpcCallerResolver>[0],
  ): ProjectedWorkspaceMetadataCommands =>
    projectedWorkspaceMetadataCommands({
      dispatcher: runtime.dispatcher,
      caller: runtime.resolveCaller(event),
    });
  const lifecycleCommands = (
    event: Parameters<DesktopIpcCallerResolver>[0],
  ): ProjectedWorkspaceLifecycleCommands =>
    projectedWorkspaceLifecycleCommands({
      dispatcher: runtime.dispatcher,
      caller: runtime.resolveCaller(event),
    });
  const guardedCommands = (
    event: Parameters<DesktopIpcCallerResolver>[0],
  ): ProjectedWorkspaceGuardedCommands =>
    projectedWorkspaceGuardedCommands({
      dispatcher: runtime.dispatcher,
      caller: runtime.resolveCaller(event),
    });
  const sourceCompositionCommands = (
    event: Parameters<DesktopIpcCallerResolver>[0],
  ): ProjectedSourceCompositionCommands =>
    projectedSourceCompositionCommands({
      dispatcher: runtime.dispatcher,
      caller: runtime.resolveCaller(event),
    });
  registerIpcHandler(
    IPC_CHANNELS.workspaceCheckAddFromFolder,
    async (
      _event,
      request: CheckAddWorkspaceFromFolderRequest,
    ): Promise<AddWorkspaceFromFolderCheck> =>
      checkAddWorkspaceFromFolder(request),
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceAddFromFolder,
    async (
      event,
      request: AddWorkspaceFromFolderRequest,
    ): Promise<SidebarItem & ScriptActionsAddMetadata> => {
      const { workspace, scriptActionsOperationId } = await lifecycleCommands(
        event,
      ).importFolder(request.repoPath, () =>
        createWorkspace({
          source: 'folder',
          variant: { kind: 'local-folder', folderPath: request.repoPath },
        }),
      );
      return { ...workspace, scriptActionsOperationId };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceAddFromRemote,
    async (
      event,
      request: AddWorkspaceFromRemoteRequest,
    ): Promise<SidebarItem & ScriptActionsAddMetadata> => {
      const { jobId } = request;
      const remoteUrl = normalizeRepositoryCloneUrl(request.remoteUrl);
      if (jobId !== undefined) validateId(jobId, 'jobId');
      const commands = lifecycleCommands(event);
      const clone = async (
        progress?: AddWorkspaceFromRemoteProgress,
      ): Promise<SidebarItem & ScriptActionsAddMetadata> => {
        // The wire names what the clone names itself; the request runs as is.
        const { workspace, scriptActionsOperationId } =
          await commands.importRemote(
            { remoteUrl, name: inferCloneRepoName(remoteUrl) },
            () =>
              createWorkspace({
                source: 'remote',
                variant: {
                  kind: 'remote-clone',
                  remoteUrl,
                  destinationDir: request.destinationDir,
                  ...(progress ? { progress } : {}),
                },
              }),
          );
        return { ...workspace, scriptActionsOperationId };
      };
      // Typed outside the job so job snapshots keep the plain clone error.
      const rethrowAuthFailure = (error: unknown): never => {
        if (
          classifyGitHubAuthFailure(remoteUrl, error) ===
          'github_not_authenticated'
        )
          throw new GitHubAuthFailureError(error);
        throw error;
      };
      return (
        jobId === undefined
          ? clone()
          : getCloneJobs().run(
              {
                id: jobId,
                remoteUrl,
                preserveDestinationOnFailure: true,
              },
              (job) =>
                clone({
                  signal: job.signal,
                  onDestination: job.setDestination,
                  onProgress: job.progress,
                  onCloned: job.finishing,
                }),
            )
      ).catch(rethrowAuthFailure);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceCreateNew,
    async (
      event,
      request: CreateNewWorkspaceRequest,
    ): Promise<SidebarItem & ScriptActionsAddMetadata> => {
      const { workspace, scriptActionsOperationId } = await lifecycleCommands(
        event,
      ).createWorkspace(
        { name: request.name, workspaceKind: 'single_repo' },
        () =>
          createWorkspace({
            source: 'new_single_repo',
            variant: { kind: 'new-single-repo', name: request.name },
          }),
      );
      return { ...workspace, scriptActionsOperationId };
    },
  );

  // ---- Create workspace ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceCreate,
    async (
      event,
      request: CreateNewWorkspaceRequest,
    ): Promise<MultiRepoSidebarItem & ScriptActionsAddMetadata> => {
      // Created and indexed in one commit; the renderer no longer completes
      // the create with projects:save (CAN-3799 D11).
      const { workspace, scriptActionsOperationId } = await lifecycleCommands(
        event,
      ).createWorkspace(
        { name: request.name, workspaceKind: 'multi_repo' },
        () =>
          createWorkspace({
            source: 'new_multi_repo',
            variant: { kind: 'new-multi-repo', name: request.name },
          }),
      );
      if (workspace.type !== 'multi-repo') {
        throw new Error(
          'Created project was persisted with an unexpected type',
        );
      }
      return { ...workspace, scriptActionsOperationId };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceCreateTemporaryFromRepos,
    async (
      _event,
      request: CreateTemporaryWorkspaceFromReposRequest,
    ): Promise<CreateTemporaryWorkspaceFromReposResponse> => {
      validateTemporaryWorkspaceRepos(request.repos);
      const response = await createOrReuseTemporaryWorkspaceFromRepos(
        request.repos,
      );
      requestOrgProjectAutoConversion();
      recordWorkspaceCrudTelemetry({
        action: 'create',
        workspaceId: response.workspace.id,
        source: 'temporary_from_repos',
      });
      return response;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceCreateTemporaryWorktreeFromRepos,
    async (
      _event,
      request: CreateTemporaryWorkspaceFromReposRequest,
    ): Promise<CreateTemporaryWorkspaceWorktreeFromReposResponse> => {
      validateTemporaryWorkspaceRepos(request.repos);

      const response = await createOrReuseTemporaryWorkspaceFromRepos(
        request.repos,
      );
      const created = await createInitialWorktreeForTemporaryWorkspaceResponse(
        response,
        getWindow,
      );
      requestOrgProjectAutoConversion();
      recordWorkspaceCrudTelemetry({
        action: 'create',
        workspaceId: created.workspace.id,
        source: 'temporary_worktree_from_repos',
      });
      recordWorktreeCrudTelemetry({
        action: 'create',
        workspaceId: created.workspace.id,
        source: 'temporary_worktree_from_repos',
      });
      return created;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceCreateTemporaryWorktreeFromWorkspaces,
    async (
      _event,
      request: CreateTemporaryWorkspaceFromWorkspacesRequest,
    ): Promise<CreateTemporaryWorkspaceWorktreeFromWorkspacesResponse> => {
      if (
        !Array.isArray(request.workspaceIds) ||
        request.workspaceIds.length === 0
      ) {
        throw new Error('Choose at least one project');
      }
      for (const workspaceId of request.workspaceIds) {
        validateId(workspaceId, 'workspaceId');
      }

      const response = await createOrReuseTemporaryWorkspaceFromWorkspaces(
        request.workspaceIds,
      );
      const created = await createInitialWorktreeForTemporaryWorkspaceResponse(
        response,
        getWindow,
      );
      requestOrgProjectAutoConversion();
      recordWorkspaceCrudTelemetry({
        action: 'create',
        workspaceId: created.workspace.id,
        source: 'temporary_worktree_from_workspaces',
      });
      recordWorktreeCrudTelemetry({
        action: 'create',
        workspaceId: created.workspace.id,
        source: 'temporary_worktree_from_workspaces',
      });
      return created;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceInitGit,
    async (
      event,
      request: WorkspaceInitGitRequest,
    ): Promise<WorkspaceInitGitResponse> => {
      validateId(request.workspaceId, 'workspaceId');
      return sourceCompositionCommands(event).initializeSourceRepo(
        {
          workspaceId: request.workspaceId,
          ...(request.repoName !== undefined && { repoName: request.repoName }),
        },
        () =>
          initializeWorkspaceSourceRepo({
            workspaceId: request.workspaceId,
            repoName: request.repoName,
            source: 'workspace_settings',
          }),
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceAttachOrigin,
    async (_event, request: WorkspaceAttachOriginRequest): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      const config = await readWorkspaceConfig(request.workspaceId);
      if (config.temporary === true) {
        throw new Error(
          'Promote this temporary project before attaching a remote.',
        );
      }
      if (!config.sourceRepoPath) {
        throw new Error('Project does not have a source repository');
      }

      const referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
        config.sourceRepoPath,
      );
      await addRemoteAndSync(referenceRepoPath, request.remoteUrl.trim());
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceReadSettingsData,
    (_event, request: WorkspaceSettingsDataRequest) =>
      readWorkspaceSettingsDataForCaller(request),
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceReadReadiness,
    async (
      _event,
      request: ReadWorkspaceReadinessRequest,
    ): Promise<ReadWorkspaceReadinessResponse> => {
      validateId(request.workspaceId, 'workspaceId');
      if (request.worktreeId !== undefined) {
        validateId(request.worktreeId, 'worktreeId');
      }
      return computeWorkspaceReadinessAudit(
        request.workspaceId,
        request.worktreeId,
      );
    },
  );

  registerIpcHandler<[SetWorkspaceArchiveRetentionRequest], void>(
    IPC_CHANNELS.workspaceSetArchiveRetention,
    async (
      event,
      request: SetWorkspaceArchiveRetentionRequest,
    ): Promise<void> => {
      await guardedCommands(event).updateRetention({
        workspaceId: request.workspaceId,
        patch: {
          archiveRetentionDays: request.archiveRetentionDays,
          ...(request.autoArchiveDays !== undefined
            ? { autoArchiveDays: request.autoArchiveDays }
            : {}),
          ...(request.autoArchiveDeleteBranch !== undefined
            ? { autoArchiveDeleteBranch: request.autoArchiveDeleteBranch }
            : {}),
        },
        source: 'workspace_settings',
      });
    },
  );

  registerIpcHandler<[SetWorkspaceStartPageRequest], void>(
    IPC_CHANNELS.workspaceSetStartPage,
    async (event, request): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      assertStartPageFeatureEnabled();
      await metadataCommands(event).updateMetadata({
        workspaceId: request.workspaceId,
        patch: {
          // Omitted clears the local override; null explicitly disables it.
          startPage:
            request.startPage === undefined
              ? { kind: 'inherit' }
              : { kind: 'set', startPage: request.startPage },
        },
        source: 'desktop_set_start_page',
      });
    },
  );

  registerIpcHandler<[SetWorkspacePrivateMemoryRequest], SidebarItem>(
    IPC_CHANNELS.workspaceSetPrivateMemory,
    async (event, request): Promise<SidebarItem> => {
      validateId(request.workspaceId, 'workspaceId');
      if (request.worktreeId !== undefined)
        validateId(request.worktreeId, 'worktreeId');
      if (typeof request.privateMemory !== 'boolean') {
        throw new Error('Private memory must be a boolean');
      }
      const item = await setWorkspacePrivateMemory(
        {
          projectId: request.workspaceId,
          worktreeId: request.worktreeId ?? request.workspaceId,
          privateMemory: request.privateMemory,
        },
        (update) => metadataCommands(event).updatePrivateMemory(update),
      );
      sendToAllWindows(IPC_CHANNELS.workspacePrivateMemoryChanged, item.id);
      return item;
    },
  );

  registerIpcHandler<
    [ResolveProjectStartPageRequest],
    ResolveProjectStartPageResponse
  >(
    IPC_CHANNELS.startPageResolve,
    async (_event, request): Promise<ResolveProjectStartPageResponse> => {
      validateId(request.projectId, 'projectId');
      if (request.worktreeId !== undefined) {
        validateId(request.worktreeId, 'worktreeId');
      }
      return resolveProjectStartPage(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceResolveReferenceRepoWarning,
    async (
      _event,
      request: WorkspaceResolveReferenceRepoWarningRequest,
    ): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      await resolveWarning(request.workspaceId, request.warningCode);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceRequestReferenceRepoRefresh,
    (_event, request: WorkspaceRequestReferenceRepoRefreshRequest): void => {
      validateId(request.workspaceId, 'workspaceId');
      requestRefresh(request.workspaceId, request.force ?? false);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceApplySourceChanges,
    async (
      event,
      request: WorkspaceApplySourceChangesRequest,
    ): Promise<WorkspaceApplySourceChangesResponse> => {
      validateId(request.workspaceId, 'workspaceId');
      if (request.startPage !== undefined) {
        assertStartPageFeatureEnabled();
      }
      if (request.target.mode === 'existing') {
        validateId(request.target.worktreeId, 'worktreeId');
      }

      const response = await sourceCompositionCommands(
        event,
      ).applySourceChanges(request.workspaceId, request, () =>
        getOrgMemberMultiRepoSync().applySourceChanges(
          request.workspaceId,
          request,
          () =>
            applySourceChanges({
              kind: 'workspace',
              git: sourceChangeGit(
                request.workspaceId,
                runtime.dispatcher,
                runtime.resolveCaller(event),
              ),
              source: 'workspace_settings',
              request,
              getWindow,
              onApplied: (event) => {
                const window = getWindow();
                if (!window) {
                  return;
                }
                sendToWindow(
                  window,
                  IPC_CHANNELS.workspaceSourceChangesApplied,
                  event,
                );
              },
            }),
        ),
      );
      requestRefresh(request.workspaceId, true);
      recordWorkspaceCrudTelemetry({
        action: 'update',
        workspaceId: request.workspaceId,
        source: 'apply_source_changes',
      });
      return response;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceReadDriftSummary,
    async (
      _event,
      request: ReadWorkspaceDriftSummaryRequest,
    ): Promise<ReadWorkspaceDriftSummaryResponse> => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.worktreeId, 'worktreeId');
      return readWorkspaceDriftSummary(request.workspaceId, request.worktreeId);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceConvertType,
    async (event, request: ConvertWorkspaceTypeRequest): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');

      const targetType =
        request.targetType === 'multi-repo' ? 'multi-repo' : 'single-repo';
      await sourceCompositionCommands(event).convertType(
        {
          workspaceId: request.workspaceId,
          targetType,
          ...(request.claudeMdMode !== undefined && {
            claudeMdMode: request.claudeMdMode,
          }),
        },
        () =>
          convertWorkspaceType({
            workspaceId: request.workspaceId,
            targetType,
            claudeMdMode: request.claudeMdMode,
            source: 'workspace_settings',
          }),
      );
      recordWorkspaceCrudTelemetry({
        action: 'convert',
        workspaceId: request.workspaceId,
        source: request.targetType,
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceImportFromRepo,
    async (
      _event,
      request: WorkspaceImportFromRepoRequest,
    ): Promise<WorkspaceImportFromRepoResponse> => {
      const { workspace, clonedRepoIds, scriptActionsOperationId } =
        await createWorkspace({
          source: 'import_from_repo',
          variant: { kind: 'repository-manifest', repoPath: request.repoPath },
        });
      if (workspace.type !== 'multi-repo') {
        throw new Error(
          'Imported project was persisted with an unexpected type',
        );
      }
      return { workspace, clonedRepoIds, scriptActionsOperationId };
    },
  );

  // Validate combine requests before delegating to the backend service and
  // triggering any follow-up discovery or setup work required by the response.
  registerIpcHandler(
    IPC_CHANNELS.workspaceCombineWorktreeWithWorkspace,
    async (
      _event,
      request: AdhocMultiRepoCombineRequest,
    ): Promise<AdhocMultiRepoCombineResponse> => {
      validateId(request.sourceWorkspaceId, 'sourceWorkspaceId');
      validateId(request.sourceWorktreeId, 'sourceWorktreeId');
      if (
        request.joinWorkspaceId !== undefined &&
        typeof request.joinWorkspaceId !== 'string'
      ) {
        throw new Error('joinWorkspaceId must be a string');
      }
      if (
        request.joinWorkspaceIds !== undefined &&
        (!Array.isArray(request.joinWorkspaceIds) ||
          request.joinWorkspaceIds.some(
            (joinWorkspaceId) => typeof joinWorkspaceId !== 'string',
          ))
      ) {
        throw new Error('joinWorkspaceIds must be an array of strings');
      }
      const joinWorkspaceIds = [
        ...(request.joinWorkspaceIds ?? []),
        ...(request.joinWorkspaceId ? [request.joinWorkspaceId] : []),
      ];
      if (joinWorkspaceIds.length === 0) {
        throw new Error('Choose at least one project to add');
      }
      for (const joinWorkspaceId of joinWorkspaceIds) {
        validateId(joinWorkspaceId, 'joinWorkspaceId');
      }
      if (
        request.mode !== 'temporary' &&
        request.mode !== 'update-source-workspace'
      ) {
        throw new Error(
          `Invalid AdhocMultiRepoCombineRequest.mode: ${String(request.mode)}`,
        );
      }
      const response = await bindCombinationAfterJoin(
        await combineWorktreeWithWorkspace(request),
        request.mode,
      );
      const setupRepos = getAdhocAddedReposForSetup(response);
      if (setupRepos.length > 0) {
        trackDetachedWork(() =>
          startWorkspaceWorktreePostCreateSetup({
            workspaceId: response.destinationWorkspaceId,
            worktreeId: response.destinationWorktreeId,
            repos: setupRepos,
            getWindow,
          }),
        );
      } else if (request.mode === 'update-source-workspace') {
        triggerDiscovery(
          response.destinationWorkspaceId,
          response.destinationWorktreeId,
          getWindow,
        );
      }
      requestOrgProjectAutoConversion();
      recordWorkspaceCrudTelemetry({
        action: 'update',
        workspaceId: response.destinationWorkspaceId,
        source: 'combine_worktree',
      });
      recordWorktreeCrudTelemetry({
        action: 'create',
        workspaceId: response.destinationWorkspaceId,
        source: 'combine_worktree',
      });
      return response;
    },
  );

  // ---- Adhoc multi-repo: list eligible join workspaces ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceListAdhocMultiRepoJoinOptions,
    async (
      _event,
      request: AdhocMultiRepoJoinOptionsRequest,
    ): Promise<AdhocMultiRepoJoinOptionsResponse> => {
      validateId(request.sourceWorkspaceId, 'sourceWorkspaceId');
      return listAdhocMultiRepoJoinOptions(request);
    },
  );

  // ---- Existing-worktree join: combine source with an existing worktree ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceCombineWorktreeWithExistingWorktree,
    async (
      _event,
      request: AdhocExistingWorktreeCombineRequest,
    ): Promise<AdhocExistingWorktreeCombineResponse> => {
      validateId(request.sourceWorkspaceId, 'sourceWorkspaceId');
      validateId(request.sourceWorktreeId, 'sourceWorktreeId');
      validateId(request.joinWorkspaceId, 'joinWorkspaceId');
      validateId(request.joinWorktreeId, 'joinWorktreeId');
      if (
        request.mode !== 'temporary' &&
        request.mode !== 'update-source-workspace'
      ) {
        throw new Error(
          `Invalid AdhocExistingWorktreeCombineRequest.mode: ${String(
            request.mode,
          )}`,
        );
      }
      const response = await bindCombinationAfterJoin(
        await combineWorktreeWithExistingWorktree(request),
        request.mode,
      );
      // Joined checkouts arrive with their setup already run in the original
      // worktree, so there is no post-create setup pass; refresh discovery on
      // the destination instead.
      triggerDiscovery(
        response.destinationWorkspaceId,
        response.destinationWorktreeId,
        getWindow,
      );
      requestOrgProjectAutoConversion();
      recordWorkspaceCrudTelemetry({
        action: 'update',
        workspaceId: response.destinationWorkspaceId,
        source: 'combine_existing_worktree',
      });
      recordWorktreeCrudTelemetry({
        action:
          request.mode === 'update-source-workspace' ? 'update' : 'create',
        workspaceId: response.destinationWorkspaceId,
        source: 'combine_existing_worktree',
      });
      return response;
    },
  );

  // ---- Existing-worktree join: list eligible existing worktrees ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceListExistingWorktreeJoinOptions,
    async (
      _event,
      request: ExistingWorktreeJoinOptionsRequest,
    ): Promise<ExistingWorktreeJoinOptionsResponse> => {
      validateId(request.sourceWorkspaceId, 'sourceWorkspaceId');
      validateId(request.sourceWorktreeId, 'sourceWorktreeId');
      return listExistingWorktreeJoinOptions(request);
    },
  );

  // ---- Adhoc multi-repo: promote temporary workspace ----
  registerIpcHandler(
    IPC_CHANNELS.workspacePromoteTemporary,
    async (
      event,
      request: PromoteTemporaryWorkspaceRequest,
    ): Promise<MultiRepoSidebarItem> => {
      validateId(request.workspaceId, 'workspaceId');
      if (
        typeof request.name !== 'string' ||
        request.name.trim().length === 0
      ) {
        throw new Error('PromoteTemporaryWorkspaceRequest.name is required');
      }
      const workspace = await sourceCompositionCommands(event).promote(
        { workspaceId: request.workspaceId, name: request.name },
        () => promoteTemporaryWorkspace(request),
      );
      recordWorkspaceCrudTelemetry({
        action: 'promote',
        workspaceId: request.workspaceId,
        source: 'temporary',
      });
      return workspace;
    },
  );

  // ---- Adhoc multi-repo: split temporary workspace worktree ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceSplitTemporaryPreview,
    async (
      _event,
      request: SplitTemporaryWorkspacePreviewRequest,
    ): Promise<SplitTemporaryWorkspacePreviewResponse> => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.worktreeId, 'worktreeId');
      return previewSplitTemporaryWorkspaceWorktree(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSplitTemporaryApproveDestructive,
    async (
      _event,
      request: SplitTemporaryWorkspaceDestructiveApprovalRequest,
    ): Promise<SplitTemporaryWorkspaceDestructiveApprovalResponse> => {
      validateSplitTemporaryWorkspaceRequest(request);
      if (
        typeof request.previewRevision !== 'string' ||
        request.previewRevision.length === 0
      ) {
        throw new Error(
          'SplitTemporaryWorkspaceDestructiveApprovalRequest.previewRevision is required',
        );
      }
      assertNotSplitLocked(
        request.workspaceId,
        request.worktreeId,
        'approving the project split',
      );
      const preview = await previewSplitTemporaryWorkspaceWorktree(request);
      return {
        approvalToken: createSplitTemporaryWorkspaceDestructiveApproval(
          request,
          preview,
        ),
      };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSplitTemporary,
    async (
      _event,
      request: SplitTemporaryWorkspaceRequest,
    ): Promise<SplitTemporaryWorkspaceResponse> => {
      validateSplitTemporaryWorkspaceRequest(request);

      // Split PR lockdown: refuse to dissolve a worktree mid-split.
      assertNotSplitLocked(
        request.workspaceId,
        request.worktreeId,
        'splitting the project',
      );
      const response = await splitTemporaryWorkspaceWorktree(request, {
        consumeDestructiveApproval: (preview): void => {
          consumeSplitTemporaryWorkspaceDestructiveApproval(request, preview);
        },
        liveServices: {
          cleanupLiveState: cleanupLiveWorktreeState,
          purgeObservabilityData: purgeLiveWorktreeObservabilityData,
        },
        onSplitWorktreeReady: (payload): void => {
          const window = getWindow();
          if (!window) {
            return;
          }
          sendToWindow(window, IPC_CHANNELS.worktreeGitReady, payload);
        },
        onSplitWorktreeFailed: (payload): void => {
          const window = getWindow();
          if (!window) {
            return;
          }
          sendToWindow(window, IPC_CHANNELS.worktreeGitFailed, payload);
        },
        onComplete: (payload): void => {
          if (payload.success) requestOrgProjectAutoConversion();
          queueTrackedGitHubWorktreeSync();
          const window = getWindow();
          if (!window) {
            return;
          }
          sendToWindow(
            window,
            IPC_CHANNELS.workspaceSplitTemporaryComplete,
            payload,
          );
        },
      });
      recordWorktreeCrudTelemetry({
        action: 'delete',
        workspaceId: request.workspaceId,
        source: 'split_temporary_workspace',
      });
      return response;
    },
  );

  // ---- Add repo to workspace ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceAddRepo,
    async (
      event,
      request: AddRepoToWorkspaceRequest,
    ): Promise<AddRepoToWorkspaceResponse> => {
      validateId(request.workspaceId, 'workspaceId');
      if (!request.repoPath || !isAbsolute(request.repoPath)) {
        throw new Error('repoPath must be an absolute path');
      }

      // Resolved before the organization sync, so an untrusted sender changes nothing.
      const commands = metadataCommands(event);
      // An organization's multi-repo project takes only the organization's
      // repositories, and the organization follows the change (CAN-3546).
      let scriptActionsOperationId: string | undefined;
      const response = {
        repo: await getOrgMemberMultiRepoSync().addRepo(
          request.workspaceId,
          request.repoPath,
          // `addToSourceControl` is deprecated and ignored: a repository
          // enters `canopy.json` through `workspace:apply-source-changes`.
          async () => {
            const added = await commands.addRepository({
              workspaceId: request.workspaceId,
              source: 'workspace_settings',
              repository: { repoPath: request.repoPath },
            });
            scriptActionsOperationId = added.scriptActionsOperationId;
            return added;
          },
        ),
      };
      recordWorkspaceCrudTelemetry({
        action: 'update',
        workspaceId: request.workspaceId,
        source: 'add_repo',
      });
      return { ...response, scriptActionsOperationId };
    },
  );

  // ---- Remove repo from workspace (config-only; worktree cleanup is user-driven) ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceRemoveRepo,
    async (event, request: RemoveRepoFromWorkspaceRequest): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.repoId, 'repoId');

      const commands = metadataCommands(event);
      await getOrgMemberMultiRepoSync().removeRepo(
        request.workspaceId,
        request.repoId,
        async (): Promise<void> => {
          await commands.removeRepository({
            workspaceId: request.workspaceId,
            repoId: request.repoId,
            source: 'workspace_settings',
          });
        },
      );
      recordWorkspaceCrudTelemetry({
        action: 'update',
        workspaceId: request.workspaceId,
        source: 'remove_repo',
      });
    },
  );

  // ---- Create workspace worktree (all repos) ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceCreateWorktree,
    async (
      event,
      request: CreateWorkspaceWorktreeRequest,
    ): Promise<CreateWorkspaceWorktreeResponse> => {
      validateId(request.workspaceId, 'workspaceId');
      assertMutuallyExclusiveWorktreeBaseSources(request);
      const baseBranch = validateOptionalWorktreeBaseBranch(request.baseBranch);
      if (request.baseWorktreeId) {
        validateId(request.baseWorktreeId, 'baseWorktreeId');
      }

      const response = (
        await lifecycleCommands(event).createWorktree(
          {
            workspaceId: request.workspaceId,
            branchName: request.branchName,
            existingBranch: request.existingBranch,
            suggestedBranch: request.suggestedBranch,
            baseBranch,
            baseWorktreeId: request.baseWorktreeId,
            sidebarItemGroupId: request.sidebarItemGroupId,
          },
          () =>
            createWorktreeFromSelection({
              workspaceId: request.workspaceId,
              workspaceKind: 'multi-repo',
              ...resolveWorktreeCreationSelection(
                {
                  baseWorktreeId: request.baseWorktreeId,
                  baseBranch,
                  existingBranch: request.existingBranch,
                  branchName: request.branchName,
                  suggestedBranch: request.suggestedBranch,
                },
                'multi-repo',
              ),
              sidebarItemGroupId: request.sidebarItemGroupId,
              existingWorktreeIds: request.existingWorktreeIds,
              startPostCreateSetup: true,
              startWorkspacePostCreateSetup:
                startWorkspaceWorktreePostCreateSetup,
              getWindow,
              deferGitSetup: true,
              onGitReady: (payload): void => {
                refreshCachedDiffStats(payload.projectId, payload.worktreeId);
                const window = getWindow();
                if (!window) {
                  return;
                }
                sendToWindow(window, IPC_CHANNELS.worktreeGitReady, payload);
              },
              onGitFailed: (payload): void => {
                const window = getWindow();
                if (!window) {
                  return;
                }
                sendToWindow(window, IPC_CHANNELS.worktreeGitFailed, payload);
              },
              onNeedsRepair: (payload): void => {
                const window = getWindow();
                if (!window) {
                  return;
                }
                sendToWindow(window, IPC_CHANNELS.worktreeNeedsRepair, payload);
              },
            }),
        )
      ).response;
      recordWorktreeCrudTelemetry({
        action: 'create',
        workspaceId: request.workspaceId,
        source: 'multi_repo',
      });
      return response;
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceRepairWorktree,
    async (
      event,
      request: WorkspaceRepairWorktreeRequest,
    ): Promise<WorkspaceRepairWorktreeResponse> => {
      return withStorageAdmission([WORKTREE_LIST_STORAGE], async () => {
        validateId(request.workspaceId, 'workspaceId');
        validateId(request.worktreeId, 'worktreeId');
        const { legacyResult: worktrees } =
          await runtime.dispatcher.queryWorktreeListForLegacyIpc(
            { scope: { workspaceId: request.workspaceId } },
            { caller: runtime.resolveCaller(event) },
          );
        if (!Array.isArray(worktrees)) {
          throw new Error('Scoped worktree projection was not captured.');
        }
        const retainedCreation = worktrees.find(
          (row) =>
            row.id === request.worktreeId &&
            row.creation?.state === 'recovery-required' &&
            row.creation.phase === 'source-root-repair' &&
            row.setupPhase === 'git-pending',
        );
        const retainedOperationId = retainedCreation?.creation?.operationId;
        const includedRepoIds = worktrees.find(
          (row) => row.id === request.worktreeId,
        )?.includedRepoIds;
        const assertRetainedIncarnation = async (): Promise<void> => {
          if (!retainedCreation || !retainedOperationId) return;
          const currentResult =
            await runtime.dispatcher.queryWorktreeListForLegacyIpc(
              { scope: { workspaceId: request.workspaceId } },
              { caller: runtime.resolveCaller(event) },
            );
          if (!Array.isArray(currentResult.legacyResult)) {
            throw new Error('Scoped worktree projection was not captured.');
          }
          const current = currentResult.legacyResult.find(
            (row) => row.id === request.worktreeId,
          );
          if (
            !current ||
            current.createdAt !== retainedCreation.createdAt ||
            current.creation?.operationId !== retainedOperationId
          ) {
            throw new Error(
              'Worktree creation changed while repairing its checkout; recovery is required.',
            );
          }
        };
        await assertRetainedIncarnation();
        await mkdir(
          getWorktreeDataDir(request.workspaceId, request.worktreeId),
          {
            recursive: true,
          },
        );

        const issues = await repairWorkspaceRootWorktree(
          request.workspaceId,
          request.worktreeId,
          request.restoreClaudeMd ?? true,
        );
        if (issues.some((issue) => issue.blocking)) {
          throw new Error(issues.map((issue) => issue.message).join('\n'));
        }
        await assertRetainedIncarnation();

        const effectiveConfig = await readEffectiveWorkspaceConfig(
          request.workspaceId,
        );
        const createResults = await settleEach(
          effectiveConfig.repos
            // Repair restores only the repositories the worktree selected; a
            // missing scope means every configured repository, [] root-only.
            .filter(
              (repo) =>
                includedRepoIds === undefined ||
                includedRepoIds.includes(repo.id),
            )
            .map(async (repo) => {
              const repoWorktreePath = getWorkspaceWorktreeRepoDir(
                request.workspaceId,
                request.worktreeId,
                repo.id,
              );
              await assertRetainedIncarnation();
              if (await pathExists(repoWorktreePath)) {
                if (
                  !(await isRegisteredWorktreePath(
                    repo.repoPath,
                    repoWorktreePath,
                  ))
                ) {
                  throw new Error(
                    `Repo "${repo.name}" has an existing directory that is not a registered worktree`,
                  );
                }
                return repo.id;
              }

              await mkdir(dirname(repoWorktreePath), { recursive: true });
              await assertRetainedIncarnation();
              const trackedRepoBaseBranch =
                request.trackedRepoBaseBranches?.[repo.id];
              if (request.existingBranch) {
                await fetchOrigin(repo.repoPath);
                const [localBranchExists, remoteBranchExists] = await settleAll(
                  [
                    doesLocalBranchExist(repo.repoPath, request.existingBranch),
                    doesRemoteBranchExist(
                      repo.repoPath,
                      request.existingBranch,
                    ),
                  ],
                );
                const hasExistingBranch =
                  localBranchExists || remoteBranchExists;
                const createdBranchName = hasExistingBranch
                  ? await createWorktreeForExistingBranch(
                      repo.repoPath,
                      repoWorktreePath,
                      request.existingBranch,
                    )
                  : await createWorktree(
                      repo.repoPath,
                      repoWorktreePath,
                      request.branchName,
                    );
                const expectedBranchName = hasExistingBranch
                  ? request.existingBranch
                  : request.branchName;
                if (createdBranchName !== expectedBranchName) {
                  throw new Error(
                    `Repo "${repo.name}" checked out branch "${createdBranchName}" instead of "${expectedBranchName}"`,
                  );
                }
              } else if (trackedRepoBaseBranch) {
                const createdBranchName = await createWorktreeFromStartPoint(
                  repo.repoPath,
                  repoWorktreePath,
                  request.branchName,
                  trackedRepoBaseBranch,
                );
                if (createdBranchName !== request.branchName) {
                  throw new Error(
                    `Repo "${repo.name}" created branch "${createdBranchName}" instead of "${request.branchName}"`,
                  );
                }
              } else {
                await createWorktree(
                  repo.repoPath,
                  repoWorktreePath,
                  request.branchName,
                );
              }
              return repo.id;
            }),
        );

        const failed = createResults.filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        if (failed.length > 0) {
          const reasons = failed
            .map((result) =>
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            )
            .join('\n');
          throw new Error(reasons);
        }

        await assertRetainedIncarnation();
        let createdAt: string | undefined;
        if (retainedCreation?.creation && retainedOperationId) {
          const completed = await reconcileWorktreeRecovery({
            kind: 'complete-source-root-repair',
            workspaceId: request.workspaceId,
            worktreeId: request.worktreeId,
            createdAt: retainedCreation.createdAt,
            operationId: retainedOperationId,
          });
          if (
            completed.worktree?.creation?.operationId !== retainedOperationId ||
            completed.worktree?.creation?.state !== 'complete'
          ) {
            throw new Error(
              'Worktree creation changed while repairing its checkout.',
            );
          }
          createdAt = completed.worktree.createdAt;
          // The deferred create ended at needs-repair without a ready event,
          // so this completion is the row's readiness decision. Announce it
          // like a finished Phase B: the renderer releases work it queued
          // while the row was pending.
          const readyEvent: WorktreeGitReadyEvent = {
            projectId: request.workspaceId,
            worktreeId: request.worktreeId,
            branchName: completed.worktree.branchName,
          };
          refreshCachedDiffStats(request.workspaceId, request.worktreeId);
          sendToWindow(getWindow(), IPC_CHANNELS.worktreeGitReady, readyEvent);
        }

        // A deferred create that stopped at needs-repair left its Git setup
        // pending; this repair is its outcome, so sends held for the setup
        // dispatch now.
        settleWorktreeGitSetup(
          request.workspaceId,
          request.worktreeId,
          'ready',
        );
        triggerDiscovery(request.workspaceId, request.worktreeId, getWindow);
        recordWorktreeCrudTelemetry({
          action: 'repair',
          workspaceId: request.workspaceId,
          source: 'multi_repo',
        });
        return {
          id: request.worktreeId,
          branchName: request.branchName,
          ...(createdAt === undefined ? {} : { createdAt }),
          trackedRepoBaseBranches: request.trackedRepoBaseBranches,
        };
      });
    },
  );

  // ---- Add a single repo to a single worktree ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceAddRepoToWorktree,
    async (_event, request: AddRepoToWorktreeRequest): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.repoId, 'repoId');

      const repo = await readWorkspaceRepoOrThrow({
        workspaceId: request.workspaceId,
        repoId: request.repoId,
        notFoundMessage: `Repo ${request.repoId} not found in project config`,
      });

      await addRepoCheckoutToWorktree(
        request.workspaceId,
        request.worktreeId,
        repo,
      );
      recordWorktreeCrudTelemetry({
        action: 'update',
        workspaceId: request.workspaceId,
        source: 'add_repo_to_worktree',
      });
    },
  );

  // ---- Remove a single repo from a single worktree ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceRemoveRepoFromWorktree,
    async (_event, request: RemoveRepoFromWorktreeRequest): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.repoId, 'repoId');

      const repoWorktreePath = getWorkspaceWorktreeRepoDir(
        request.workspaceId,
        request.worktreeId,
        request.repoId,
      );
      await stopHooksForRepoTarget({
        projectId: request.workspaceId,
        worktreeId: request.worktreeId,
        repoId: request.repoId,
      }).catch(() => {});
      await deletePrTrackingState({
        projectId: request.workspaceId,
        worktreeId: request.worktreeId,
        repoStorageKey: getWorkspaceRepoStorageKey(request.repoId),
      }).catch(() => {});

      // Get the branch before removing
      let branchToDelete: string | null = null;
      try {
        const branch = await getCurrentBranch(repoWorktreePath);
        if (branch && branch !== 'HEAD') branchToDelete = branch;
      } catch {
        // Worktree may already be gone
      }

      // Discover the source repo path from git metadata
      const repoPath = await getRepoRootFromWorktree(repoWorktreePath).catch(
        () => null,
      );

      if (repoPath) {
        await safeRemoveWorktree(
          repoPath,
          repoWorktreePath,
          'projects safeRemoveWorktree',
        );
        if (branchToDelete) {
          const prefs = await readPreferencesFile();
          if (prefs.deleteBranchOnArchive) {
            try {
              await deleteBranch(repoPath, branchToDelete);
            } catch {
              // Branch may already be deleted or not exist
            }
          }
        }
      } else {
        // Fallback: just force-remove the directory
        await rm(repoWorktreePath, { recursive: true, force: true });
      }
      recordWorktreeCrudTelemetry({
        action: 'update',
        workspaceId: request.workspaceId,
        source: 'remove_repo_from_worktree',
      });
    },
  );

  // ---- Archive workspace worktree ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceArchiveWorktree,
    async (
      event,
      request: ArchiveWorkspaceWorktreeRequest,
    ): Promise<ArchiveWorktreeResponse> => {
      validateId(request.workspaceId, 'workspaceId');
      validateId(request.worktreeId, 'worktreeId');
      if (request.remainingWorktreeOrder) {
        for (
          let index = 0;
          index < request.remainingWorktreeOrder.length;
          index += 1
        ) {
          validateId(
            request.remainingWorktreeOrder[index],
            `remainingWorktreeOrder[${index}]`,
          );
        }
      }
      if (request.expectedRemainingWorktreeOrder) {
        for (
          let index = 0;
          index < request.expectedRemainingWorktreeOrder.length;
          index += 1
        ) {
          validateId(
            request.expectedRemainingWorktreeOrder[index],
            `expectedRemainingWorktreeOrder[${index}]`,
          );
        }
      }

      const lifecycle = lifecycleCommands(event);
      const response = await withTypedArchiveRefusal(
        { ...request, intent: worktreeRemovalIntent(request.lockAfterArchive) },
        () =>
          lifecycle.archiveWorktree(request, () =>
            archiveWorktree(
              {
                workspaceId: request.workspaceId,
                worktreeId: request.worktreeId,
                source: 'multi_repo',
                expectedKind: 'multi-repo',
                expectedCreatedAt: request.expectedCreatedAt,
                expectedBranchName: request.expectedBranchName,
                deleteBranch: request.deleteBranch,
                lockAfterArchive: request.lockAfterArchive,
                deleteWithoutRetentionIfMissing:
                  request.deleteWithoutRetentionIfMissing,
                remainingWorktreeOrder: request.remainingWorktreeOrder,
                expectedRemainingWorktreeOrder:
                  request.expectedRemainingWorktreeOrder,
              },
              { telemetryParent: 'inherit' },
            ),
          ),
      );
      if (!response.refusal)
        removeCachedWorktreeDiffStats(request.workspaceId, request.worktreeId);
      return response;
    },
  );

  // ---- Delete workspace (remove persisted directory) ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceDelete,
    async (event, request: DeleteWorkspaceRequest): Promise<void> => {
      if (request.supersedeInterruptedDeletion !== undefined)
        validateId(
          request.supersedeInterruptedDeletion,
          'supersedeInterruptedDeletion',
        );
      // Shared with the browser Remote Control portal adapter
      // (`portal.workspace.delete`) so the two surfaces tear a workspace down
      // identically (cowork detach/delete vs. persisted-dir removal).
      await lifecycleCommands(event).deleteWorkspace(request, () =>
        deleteWorkspaceById(
          request.workspaceId,
          'multi_repo_workspace_delete',
          {
            supersedeInterruptedDeletion: request.supersedeInterruptedDeletion,
          },
        ),
      );
      removeCachedWorkspaceDiffStats(request.workspaceId);
    },
  );

  // ---- Load CLAUDE.md (core.workspace.instructions.get) ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceLoadClaudeMd,
    async (event, request: WorkspaceClaudeMdRequest): Promise<string> => {
      // Read the field first so a missing payload keeps its legacy TypeError.
      const workspaceId = request.workspaceId;
      return getWorkspaceInstructions(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        workspaceId,
      );
    },
  );

  // ---- Save CLAUDE.md (core.workspace.instructions.update) ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceSaveClaudeMd,
    async (event, request: SaveWorkspaceClaudeMdRequest): Promise<void> => {
      const workspaceId = request.workspaceId;
      await updateWorkspaceInstructions(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        workspaceId,
        request.content,
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceReadScripts,
    async (
      event,
      request: ReadWorkspaceScriptsRequest,
    ): Promise<Record<string, string>> =>
      readWorkspaceScriptCommands(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request.workspaceId,
      ),
  );
  registerIpcHandler(
    IPC_CHANNELS.workspaceMergeScripts,
    async (event, request: MergeWorkspaceScriptsRequest): Promise<void> =>
      mergeWorkspaceScriptCommands(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request,
      ),
  );

  // ---- Save default plugin selections ----
  registerIpcHandler(
    IPC_CHANNELS.workspaceSaveDefaultPlugins,
    async (event, request: SaveDefaultPluginsRequest): Promise<void> => {
      validateId(request.projectId, 'project id');
      const commands = guardedCommands(event);
      await saveDefaultPluginsAndVisibility(
        request,
        'workspace_settings',
        (update) => commands.updatePlugins(update),
      );
    },
  );
}

function validateTemporaryWorkspaceRepos(
  repos: CreateTemporaryWorkspaceFromReposRequest['repos'],
): void {
  if (!Array.isArray(repos) || repos.length === 0) {
    throw new Error('Choose at least one repository');
  }
  for (const repo of repos as unknown[]) {
    if (!isRecord(repo) || typeof repo.path !== 'string') {
      throw new Error('Repository paths must be absolute');
    }
    if (!isAbsolute(repo.path)) {
      throw new Error('Repository paths must be absolute');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Collects every repo path still referenced by the given (already-loaded)
 * sidebar items, covering every repo-bearing field: single-repo `repoPath`,
 * multi-repo `sourceRepoPath`, and each multi-repo `repos[].repoPath`. Cowork
 * workspaces carry no repo-shadow-eligible paths and are skipped.
 *
 * Callers that need this to reflect a just-completed workspace deletion must
 * re-read the sidebar items after the deletion completes rather than reusing
 * a list captured before the deletion, or the deleted workspace's repos will
 * still count as referenced.
 */
export function collectReferencedRepoPaths(items: SidebarItem[]): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (item.type === 'single-repo') {
      paths.push(item.repoPath);
    } else if (item.type === 'multi-repo') {
      if (item.sourceRepoPath) {
        paths.push(item.sourceRepoPath);
      }
      for (const repo of item.repos) {
        paths.push(repo.repoPath);
      }
    }
  }
  return paths;
}
