import { resolveReplayLocation } from '@canopy/execution-engine/node/pipelines/executor/replay-location';
import type { PipelineReadPort } from '@canopy/desktop-shared/lib/automation-share/port';
import type { PipelineRunLocationRequest } from '@canopy/desktop-shared/types/pipeline-cloud-runs';
import { buildPipelineSecretBindings } from '../execution-secrets/bindings';
import type { RedeemedExecutionSecrets } from '@canopy/core-runtime/node/execution-secrets';
import type { ShareFailure } from '@canopy/protocol/sharing';
import { runClassifiedShare } from '../sharing/share-operation-result';
import { isDeepStrictEqual } from 'node:util';
import { pipelineSpeedError } from './codex-speed';
import {
  pipelineContextResources,
  backgroundExecutionDeniedMessage,
  backgroundExecutionRetryMessage,
} from '@canopy/desktop-shared/node/background-execution-context';
import {
  accountMayRunIn,
  authorizeBackgroundExecution,
  backgroundExecutionContextEnabled,
  captureBackgroundExecutionContext,
} from '../services/background-execution-context';
import {
  authorizeProjectPipelineRequest,
  assertStoredPipelineContext,
  readStoredPipelineContext,
  filterStoredPipelineContexts,
  filterProjectPipelineContexts,
} from './pipeline-install-context';
import { parseWorkspaceContext } from '@canopy/protocol/workspace-context';
import type { ResourceContextInput } from '@canopy/execution-engine/lib/resource-context-policy';
import {
  assertPipelineContext,
  assertPipelineContextSnapshot,
  pipelineContextSnapshot,
  pipelineResourceContextEnabled,
} from './resource-lanes';
import { authorizePipelineReplay } from './pipeline-replay-authorization';
import {
  startManagedCuratedPipelineSync,
  stopManagedCuratedPipelineSync,
} from './curated-pipeline-catalog';
import { registerCuratedPipelineHandlers } from './curated-pipeline-handlers';
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { app, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  CANOPY_CLOUD_DISPLAY_NAME,
  CANOPY_CLOUD_SERVER_ID,
} from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  CanopyCloudClientError,
  isTransientCanopyCloudFailure,
} from '../canopy-cloud/client';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { registerIpcHandler } from '../ipc/register';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import { isDaemonPipelineExecutionHandle } from './daemon-pipeline-execution';
import {
  isOwnRendererSender,
  withDaemonPipelineRoute,
  type DaemonPipelineRouteContext,
} from './daemon-pipeline-route-context';
import type { RendererSurfaceWindow } from '../lib/renderer-surface';
import { isPathInside } from '../lib/path-safety';
import { isWorkEntryWorkspace } from '../lib/workspace-registry';
import { withWorkspaceTargetRuntimeStartReservation } from '../lib/workspace-target-exclusion';
import { sendToAllWindows } from '../lib/window-send';
import {
  logMainProcessError,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import { isUsageInitiationSource } from '@canopy/desktop-shared/lib/turn-utils';
import * as service from './pipeline-service';
import { getStoredPipelineIndexEntry } from '@canopy/execution-engine/pipelines/store';
import {
  createSharedPipeline,
  deleteSharedPipeline,
  getSharedPipeline,
  getSharedPipelineForExecutionContext,
  listSharedOrganizations,
  listSharedPipelines,
  updateSharedPipeline,
  publishPipelinePublicShare,
  revokePipelinePublicShare,
  listSharedTeams,
} from './canopy-server-client';
import { getProjectPipelinesDirCandidates } from './config-paths';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type {
  PortalPipelineExecutionListResult,
  PortalPipelineGetResult,
  PortalPipelineRun,
  PortalPipelineSummary,
} from '@canopy/protocol/portal';
import type {
  ListPipelineCapabilityRefsRequest,
  ListPipelineCapabilityRefsResponse,
  ListSharedOrganizationsRequest,
  ListSharedOrganizationsResponse,
  ListSharedPipelinesRequest,
  ListSharedPipelinesResponse,
  ListSharedTeamsRequest,
  ListSharedTeamsResponse,
  LoadModelAliasPreferencesRequest,
  LoadModelAliasPreferencesResponse,
  Pipeline,
  PipelineCapabilityRefsEntry,
  PipelineCapabilitySummary,
  PipelineData,
  PipelineInfo,
  IPCResult,
  PipelineExecutionStartResult,
  PipelineAdvisorSnapshot,
  PipelineLookupRequest,
  PipelinePackageAnalyzeRequest,
  PipelinePackageCancelAnalysisRequest,
  PipelinePackageCreateSharedRequest,
  PipelinePackageInstallRecordV1,
  PipelinePackageInstallRequest,
  PipelinePackageInstallResult,
  PipelinePackageReadiness,
  PipelinePackageReadinessRequest,
  PipelineSaveInput,
  ProjectPipelineRequest,
  ResolvePluginCollectionsRequest,
  ResolvePluginCollectionsResponse,
  RetryMatrixJobRequest,
  CancelMatrixVariantRequest,
  SaveModelAliasPreferencesRequest,
  SaveModelAliasPreferencesResponse,
  SavePluginCollectionPreferencesRequest,
  SavePluginCollectionPreferencesResponse,
  SharedPipelineDeleteRequest,
  SharedPipelineDetail,
  SharedPipelineGetRequest,
  SharedPipelinePublicShareInfo,
  SharedPipelineRequest,
  SharedPipelineSaveImpact,
  SharedPipelineSummary,
  SharedPipelineWriteRequest,
  StoredPipelineLookupRequest,
  PipelineExecutionInitiator,
} from '@canopy/execution-engine/types/pipeline';
import type { UsageInitiationSource } from '@canopy/desktop-shared/types';
import {
  encodeMatrixIpcErrorMessage,
  getTriggerTypes,
} from '@canopy/execution-engine/types/pipeline';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { buildSharedPipelineId } from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import {
  normalizePipeline,
  validatePipelineRuntimeIdentifier,
} from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { getDefaultShellTypeForCurrentProcess } from '@canopy/execution-engine/node/pipelines/default-shell';
import { listBuiltinActions, resolveAction } from './action-resolver';
import {
  beginExecutionPause,
  createPipelineExecutionId,
  getGlobalExecutionWorkspaceDir,
  getStepLogFilePath,
  isKnownOrphanedExecution,
  isPathInsideExecutionsDir,
  isTopLevelGlobalRun,
  listExecutionSummaries,
  loadExecutionState,
  prepareMatrixJobRetryState,
  prepareMatrixVariantCancellation,
  MatrixExecutorInactiveError,
  saveExecutionState,
  setExecutionHidden,
  type ExecutePipelineRequestOptions,
  type ExecutionHandle,
  type ExecutionEvent,
  type ExecutionOptions,
  type ExecutionRuntime,
  type ExecutionState,
  type SharedPipelineExecutionSource,
  type StepLogLocator,
  type StepLogReadOptions,
} from '@canopy/execution-engine/node/pipelines/executor';
import { readStepLogFile } from '@canopy/execution-engine/node/pipelines/executor/step-log-positions';
import { createElectronExecutionRuntime } from './execution-runtime';
import {
  discoverProjectPipelines,
  getCreatedAt,
  getProjectPipelineId,
  loadProjectPipelineFromDisk,
} from './project-pipeline-discovery';
import { readPreferencesFile } from '../lib/preferences-store';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { validateId } from '../lib/validation';
import { enqueueKnownPrFastRefresh } from '../lib/github-poller';
import { buildPipelinePreferenceEnv } from './preference-env';
import { getObservabilityService } from '../observability';
import { createDesktopPipelineObservabilityFeed } from '../observability/ingest';
import { readTrackedPlanData, updatePlan } from '../services/plans-service';
import { CURSOR_PLAN_EXECUTION_UNAVAILABLE } from '@canopy/desktop-shared/plan-review';
import { isCursorPlanExecutionUnavailable } from '@canopy/app-core/client';
import { assertNotSplitLocked } from '../services/split-lock-service';
import { buildPipelineBaseBranchEnv } from './worktree-base-branch-env';
import { readEnvironmentConfig } from '../lib/user-environment-store';
import { resolveEnvironmentForRuntime } from '@canopy/desktop-shared/lib/user-environment';
import {
  loadPipelineModelAliasPreferences,
  loadPipelinePluginCollectionPreferences,
  normalizePipelinePluginCollectionPreferences,
  savePipelineModelAliasPreferences,
  savePipelinePluginCollectionPreferences,
} from '@canopy/execution-engine/node/pipelines/plugin-collection-store';
import {
  isPipelineLocalMetadataReadable,
  readPipelineLocalMetadata,
  recordUserPipelineOwner,
  setUserPipelineAgentAuthor,
} from './pipeline-local-metadata-store';
import {
  WORKFLOW_DUPLICATE_FAILED,
  copyWorkflowNameToSchedules,
  copyWorkflowPageFacts,
  withWorkflowPageInfo,
  workflowPageDuplicateRefusal,
} from '../automations/workflow-schedules';
import {
  getUserPipelineOwner,
  isLocalUserPipeline,
  PipelineNowOwnedError,
  readUserPipelineLocalRunOwner,
  resolveExecutionOwnerContext,
  selectedOwnerContext,
  validatePipelineOwnerTargetsOnSave,
} from './pipeline-owner-policy';
import {
  isPersonStart,
  localUserPipelineIdForRequest,
  preflightGlobalStart,
} from './pipeline-global-start';
import { resolvePipelinePluginCollections } from './plugin-collection-resolver';
import {
  buildPipelineDefaultDisplay,
  collectPipelineCapabilityRefs,
} from '@canopy/execution-engine/pipelines/plugin-collections';
import {
  loadShareablePluginCatalog,
  matchShareablePluginRef,
} from '../plugins/shareable-plugin-resolution';
import {
  getActiveExecutionHandle,
  hasActiveExecution,
  isExecutionReservedBy,
  releaseExecutionReservation,
  reserveExecution,
  trackExecution,
  tryReserveExecution,
} from './pipeline-execution-registry';
import { getResourceMonitorService } from '../resource-monitor';
import { createPipelineRunObservers } from './pipeline-run-observers';
import { getPipelineAdvisorService } from './pipeline-advisor';
import {
  listPipelineAdvisorSnapshots,
  readPipelineAdvisorSnapshot,
} from './pipeline-advisor-store';
import { withPipelineCrudTelemetry } from './instrumentation';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import { noteAutomationPipelineEvent } from '../automations/pipeline-run-chat-sends';
import { getCachedClaudeAuthStatusObserved } from '../auth/provider-auth-state';
import { resumePipelineExecutionFromMain } from './pipeline-resume-service';
import { getEffectiveClaudeWorkerModePreferences } from '../lib/claude-tui-workers';
import { recordPipelineUsageEvent } from './pipeline-usage-events';
import {
  notePipelineExecutionEvent,
  withPipelineTransientRetryState,
} from './transient-error-retry-scheduler';
import { broadcastPipelineExecutionEvent } from './pipeline-execution-event-broadcaster';
import {
  admitCuratedRunDefinition,
  admitStoredRunDefinition,
} from './run-definition-admission';
import {
  setPipelineExecutionFanOut,
  settlePipelineExecutionEvent,
  type PipelineControlSettlement,
  type PipelineExecutionFanOut,
  pipelineExecutorControls,
  readStoredPipelineExecution,
} from './pipeline-worker-host';
import type { PipelineControlRequest } from '@canopy/core-runtime/node/pipeline';
import {
  cancelPipelineThroughLocalWorker,
  controlPipelineThroughLocalWorker,
  followExecutionHandle,
  startPipelineThroughLocalWorker,
} from './pipeline-worker-dispatch';
import { isSharedPipelineLocalId } from '@canopy/protocol/pipelines';
import {
  deleteUserPipeline,
  duplicatePipelineDefinition,
  importRemotePipeline,
  listDesktopPipelines,
  PIPELINE_DEFINITION_DESKTOP_CALLER,
  pipelineWriteErrorMessage,
  readDesktopPipeline,
  saveUserPipeline,
} from '../canopy-runtime/pipeline-definition-dispatch';
import {
  analyzePackageRequest,
  cancelPackageAnalysis,
  createPackagedSharedPipeline,
  getPackageReadiness,
  installPublicPackageShare,
  listPackageInstalls,
  resolveInstalledPipelinePackageForExecution,
  downloadSharedPipelinePackageForExecution,
  assertSharedPipelineMatchesAutomationInstallPin,
  SharedPipelinePinMismatchError,
  updateSharedPipelinePreservingPackage,
} from './pipeline-package-service';
import { getSharedPipelineSaveImpact } from './shared-pipeline-save-impact';
import {
  resolvePipelineAssetExecutionOptions,
  type PipelineAssetIdentity,
} from './pipeline-asset-resolution';

export { getSharedPipelineSaveImpact } from './shared-pipeline-save-impact';

export { cancelAllActivePipelineExecutions } from './pipeline-execution-registry';

type ResumePipelineOptions = Partial<
  Pick<
    ExecutionOptions,
    | 'cwd'
    | 'env'
    | 'inputs'
    | 'repoPath'
    | 'inputAnswers'
    | 'pauseResponses'
    | 'statusReasonIds'
  >
>;

const activeRerunSources = new Set<string>();
const activeMatrixRetryJobs = new Set<string>();

async function shouldUsePipelineAgentTerminalMode(
  preferredMode: 'canopy' | 'terminal',
): Promise<boolean> {
  if (preferredMode !== 'terminal') {
    return false;
  }
  const authStatus = await getCachedClaudeAuthStatusObserved(
    'pipeline-terminal-mode',
    { forceRefresh: true },
  );
  return authStatus.authenticated;
}

function getEffectivePipelinesMode(
  preferences: Pick<
    PreferencesData,
    'canopyBackgroundProcessesMode' | 'pipelinesMode'
  >,
): 'canopy' | 'terminal' {
  return getEffectiveClaudeWorkerModePreferences(preferences).pipelinesMode;
}

async function resolvePipelineRuntimeEnv(workspaceId?: string): Promise<{
  env: Record<string, string>;
}> {
  try {
    const { data } = await readEnvironmentConfig();
    const resolved = resolveEnvironmentForRuntime(data, {
      runtime: 'pipeline',
      ...(workspaceId ? { workspaceId } : {}),
    });
    return {
      env: resolved.publicApplied,
    };
  } catch {
    return { env: {} };
  }
}

async function hydrateAdvisorSnapshotPipelineStartedAt(
  snapshot: PipelineAdvisorSnapshot | null,
  executionId: string,
  executionsDir: string,
): Promise<PipelineAdvisorSnapshot | null> {
  if (!snapshot || snapshot.executionId !== executionId) {
    return null;
  }
  if (snapshot.pipelineStartedAt) {
    return snapshot;
  }

  const active = getActiveExecutionHandle(executionId);
  const state =
    active?.getState() ??
    (await loadExecutionState(executionId, executionsDir));
  return state?.started_at
    ? { ...snapshot, pipelineStartedAt: state.started_at }
    : snapshot;
}

function createMonitoredElectronExecutionRuntime(
  getWindow?: () => BrowserWindow | null,
): ExecutionOptions['runtime'] {
  const runtime = createElectronExecutionRuntime(getWindow);
  runtime.resourceMonitor = getResourceMonitorService();
  return runtime;
}

const OBSERVER_TERMINAL_STATUSES: ReadonlySet<ExecutionState['status']> =
  new Set<ExecutionState['status']>(['success', 'failure', 'cancelled']);

/**
 * Give a started execution its browser projection.
 *
 * The renderer has always had an ambient channel (`emitExecutionEvent` fires
 * for every execution regardless of its source); this is the browser's
 * equivalent. Attached here rather than at each call site because this helper
 * is the one seam every start, retry, and replay already passes through.
 *
 * Observers attach after the handle exists, so the earliest events can predate
 * them — `prime` republishes the current state to cover that edge.
 */
function attachPipelineRunObservers(handle: ExecutionHandle): void {
  if (!handle.addObservers) return;
  const observers = createPipelineRunObservers(handle.id);
  if (!observers) return;
  let dispose: (() => void) | undefined;
  const onEvent: NonNullable<ExecutionOptions['onEvent']> = (event) => {
    try {
      observers.onEvent(event);
    } finally {
      if (OBSERVER_TERMINAL_STATUSES.has(event.state.status)) {
        dispose?.();
        dispose = undefined;
      }
    }
  };
  dispose = handle.addObservers({
    onEvent,
    onStepOutput: observers.onStepOutput,
  });
  observers.prime?.(handle.getState());
}

function trackExecutionWithAdvisor(
  handle: ExecutionHandle,
  runtime: ExecutionRuntime,
  getWindow: () => BrowserWindow | null,
  onSettled?: () => void,
  reservationId: string = handle.id,
): void {
  if (isDaemonPipelineExecutionHandle(handle)) {
    // A daemon run is mirrored, not tracked: quitting the app never pauses
    // it, and it settles through its own events (CAN-5086 D12).
    releaseExecutionReservation(reservationId);
    followExecutionHandle(handle);
    getPipelineAdvisorService().watchExecution({ handle, runtime, getWindow });
    attachPipelineRunObservers(handle);
    void handle.waitForCompletion().then(
      () => onSettled?.(),
      () => onSettled?.(),
    );
    return;
  }
  trackExecution(handle, onSettled, reservationId);
  // A started, resumed or replayed execution's subscribers and run record
  // follow its handle.
  followExecutionHandle(handle);
  getPipelineAdvisorService().watchExecution({ handle, runtime, getWindow });
  attachPipelineRunObservers(handle);
}

type MainProcessExecutePipelineRequestOptions =
  ExecutePipelineRequestOptions & {
    /**
     * Internal-only preallocated id used by hook-pipeline queue reservations.
     * Renderer IPC execute requests are sanitized before reaching this type.
     */
    executionId?: string;
    /**
     * Internal package owned by the automation that launched a bundled local
     * pipeline. Renderer IPC requests never populate this field.
     */
    automationPipelinePackage?: ExecutionOptions['pipelinePackage'];
    /** Fresh foreground dispatch marker; never accepted from renderer IPC. */
    allowUnverifiedForegroundChildren?: boolean;
  };

async function setupAppAdvisorPipelineWatchersForExecution(args: {
  state: ExecutionState;
  watcherSetups?: ExecutePipelineRequestOptions['appAdvisorPipelineWatchers'];
  projectId?: string;
  worktreeId?: string;
}): Promise<void> {
  const { state, watcherSetups } = args;
  if (!watcherSetups || watcherSetups.length === 0) {
    return;
  }

  const projectId = state.project_id ?? args.projectId;
  const worktreeId = state.worktree_id ?? args.worktreeId;
  if (!projectId || !worktreeId) {
    throw new Error(
      'Unable to create selected pipeline watcher: execution is not scoped to a worktree.',
    );
  }

  const service = getAppAdvisorWatcherService();
  for (const setup of watcherSetups) {
    const result = await service.setup(
      {
        watchers: [
          {
            trigger: 'worktree_pipeline_completion',
            target: {
              kind: 'worktree_pipeline',
              projectId,
              worktreeId,
              executionId: state.id,
              pipelineId: state.pipeline_id,
              ...(setup.watcher.terminalStatuses
                ? { terminalStatuses: setup.watcher.terminalStatuses }
                : {}),
            },
            ...(setup.watcher.label ? { label: setup.watcher.label } : {}),
            ...(setup.watcher.followUpInstruction
              ? { followUpInstruction: setup.watcher.followUpInstruction }
              : {}),
            ...(setup.watcher.allowDuplicate !== undefined
              ? { allowDuplicate: setup.watcher.allowDuplicate }
              : {}),
          },
        ],
      },
      setup.destination,
    );
    if (!result.ok) {
      throw new Error(
        `Unable to create selected pipeline watcher: ${result.error}`,
      );
    }
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The data-dir identity of a top-level run: a stored user pipeline's local
 * id; else the absolute file of a project pipeline; else a stable source key
 * for curated, shared and bundled pipelines, so their data dir survives
 * revisions and app updates. Inline runs have none.
 */
function pipelineAssetIdentity(input: {
  userPipelineId: string | undefined;
  curatedId: string | undefined;
  sharedPipeline: ExecutePipelineRequestOptions['sharedPipeline'];
  projectPipelineSourcePath: string | undefined;
  pipelinePreferenceLocator: ExecutionOptions['pipelinePreferenceLocator'];
}): PipelineAssetIdentity {
  if (input.userPipelineId) return { localPipelineId: input.userPipelineId };
  if (input.projectPipelineSourcePath)
    return { sourcePath: input.projectPipelineSourcePath };
  if (input.curatedId) return { sourcePath: input.curatedId };
  if (input.sharedPipeline)
    return {
      sourcePath: `shared:${input.sharedPipeline.serverId}:${input.sharedPipeline.remoteId}`,
    };
  const locator = input.pipelinePreferenceLocator;
  if (locator?.type === 'file') return { sourcePath: locator.value };
  if (locator?.type === 'stored')
    return { sourcePath: `${locator.source}:${locator.value}` };
  return {};
}

function formatPipelineExecutionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProjectPipelineRequest(
  request: PipelineLookupRequest,
): request is ProjectPipelineRequest {
  return (
    typeof request === 'object' &&
    request !== null &&
    'cwd' in request &&
    'filePath' in request &&
    typeof request.id === 'string' &&
    typeof request.cwd === 'string' &&
    typeof request.filePath === 'string'
  );
}

function isSharedPipelineRequest(
  request: PipelineLookupRequest,
): request is SharedPipelineRequest {
  return (
    typeof request === 'object' &&
    request !== null &&
    'source' in request &&
    request.source === 'shared' &&
    'remoteId' in request &&
    typeof request.remoteId === 'string'
  );
}

/**
 * Annotate a local user pipeline read with its saved owner. A store that
 * can't be read marks the owner unreadable rather than showing the pipeline
 * unowned; the read itself still serves the editor and other callers. With
 * organization projects off every run is Personal, so the saved owner is
 * neither shown nor read.
 */
function withLocalRunOwner<
  T extends { success: boolean; data?: PipelineData; error?: string },
>(result: T): T {
  if (
    !result.success ||
    result.data?.info.source !== 'user' ||
    !backgroundExecutionContextEnabled()
  )
    return result;
  try {
    const owner = readUserPipelineLocalRunOwner(result.data.info.id);
    if (owner === undefined) return result;
    return { ...result, data: { ...result.data, localRunOwner: owner } };
  } catch {
    return {
      ...result,
      data: { ...result.data, localRunOwnerUnreadable: true },
    };
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildSharedPipelinePreferenceLocator(
  serverId: string,
  remoteId: string,
): { type: 'shared'; value: string } {
  return {
    type: 'shared',
    value: `${serverId}:${remoteId}`,
  };
}

function withDefaultSharedPipelineScopes<T extends SharedPipelineSummary>(
  pipeline: T,
): T {
  return {
    ...pipeline,
    scopes: pipeline.scopes ?? ['directory'],
  };
}

function hydrateSharedPipelineDetailScopes(
  detail: SharedPipelineDetail,
): SharedPipelineDetail {
  try {
    const normalized = normalizePipeline(
      parsePipelineText(detail.rawPipeline),
      {
        defaultShell: getDefaultShellTypeForCurrentProcess(),
      },
    );
    return { ...detail, scopes: normalized.scope };
  } catch {
    return withDefaultSharedPipelineScopes(detail);
  }
}

async function cacheSharedPipelineForExecution(args: {
  serverId: string;
  remoteId: string;
  projectId?: string;
  installPin?: NonNullable<ExecutionOptions['sharedPipeline']>['installPin'];
  runtime: ReturnType<typeof createElectronExecutionRuntime>;
  executionId: string;
  executionContext?: string;
}): Promise<{
  pipeline: Pipeline;
  owner: unknown;
  sharedPipelineSource: SharedPipelineExecutionSource;
  pipelinePackage?: ExecutionOptions['pipelinePackage'];
}> {
  const { serverId, remoteId, installPin, runtime, executionId } = args;
  let detail: SharedPipelineDetail;
  try {
    detail = await (args.executionContext !== undefined
      ? getSharedPipelineForExecutionContext(remoteId)
      : getSharedPipeline(remoteId));
  } catch (error) {
    if (args.executionContext !== undefined) {
      if (isTransientCanopyCloudFailure(error))
        throw new Error(backgroundExecutionRetryMessage('run'));
      if (
        (error instanceof CanopyCloudClientError &&
          error.isValidatedServerError &&
          (error.status === 403 || error.status === 404)) ||
        (error instanceof Error &&
          error.message === 'Workflow unavailable (access-removed)')
      )
        throw new Error(backgroundExecutionDeniedMessage('access-removed'));
    }
    throw error;
  }
  await assertPipelineContext(
    { owner: detail.owner },
    args.projectId,
    args.executionContext,
  );
  if (installPin) {
    assertSharedPipelineMatchesAutomationInstallPin(detail, installPin);
  }
  const executionDir = path.join(runtime.executionsDir, executionId);
  await mkdir(executionDir, { recursive: true });
  const cachedPipelinePath = path.join(executionDir, 'shared-pipeline.yaml');
  await writeFile(cachedPipelinePath, detail.rawPipeline, 'utf8');

  return {
    pipeline: parsePipelineText(detail.rawPipeline),
    owner: detail.owner ?? { shareScope: detail.shareScope },
    sharedPipelineSource: {
      type: 'shared',
      serverId,
      serverName: CANOPY_CLOUD_DISPLAY_NAME,
      remoteId,
      cachedPipelinePath,
      fetchedAt: new Date().toISOString(),
    },
    ...(detail.distributionMode === 'package' && detail.package?.digest
      ? {
          pipelinePackage: await downloadSharedPipelinePackageForExecution({
            remoteId,
            rawPipeline: detail.rawPipeline,
            packageDigest: detail.package.digest,
          }),
        }
      : {}),
  };
}

/**
 * The definition a lookup names: a store lookup resolves only a user or
 * bundled id, one with a source only that source.
 */
function pipelineLookupDefinition(
  request: PipelineLookupRequest,
):
  | { definitionId: string; stored: boolean; source?: 'user' | 'bundled' }
  | undefined {
  if (isCuratedPipelineLookup(request))
    return { definitionId: request.id, stored: false };
  if (typeof request === 'string')
    return { definitionId: request, stored: !request.startsWith('curated:') };
  if (isSharedPipelineRequest(request))
    return {
      definitionId: buildSharedPipelineId(
        CANOPY_CLOUD_SERVER_ID,
        request.remoteId,
      ),
      stored: false,
    };
  if (isStoredPipelineLookupRequest(request))
    return {
      definitionId: request.id,
      stored: true,
      source: request.source === 'bundled' ? 'bundled' : 'user',
    };
  return undefined;
}

function isStoredDefinitionId(definitionId: string): boolean {
  return (
    !isSharedPipelineLocalId(definitionId) &&
    !definitionId.startsWith('project--')
  );
}

/** The definition a duplicate request copies through core; project files by host path are not one. */
function duplicateSourceId(request: PipelineLookupRequest): string | undefined {
  if (typeof request === 'string') return request;
  if (isCuratedPipelineLookup(request)) return request.id;
  if (isSharedPipelineRequest(request))
    return buildSharedPipelineId(CANOPY_CLOUD_SERVER_ID, request.remoteId);
  return undefined;
}

function isCuratedPipelineLookup(
  request: PipelineLookupRequest,
): request is StoredPipelineLookupRequest {
  return (
    typeof request === 'object' &&
    request !== null &&
    'source' in request &&
    request.source === 'curated' &&
    'id' in request &&
    typeof request.id === 'string'
  );
}

function isStoredPipelineLookupRequest(
  request: PipelineLookupRequest,
): request is StoredPipelineLookupRequest {
  return (
    typeof request === 'object' &&
    request !== null &&
    'source' in request &&
    'id' in request &&
    typeof request.id === 'string' &&
    (request.source === 'bundled' || request.source === 'user')
  );
}

function getPipelineLookupTelemetrySource(
  request: PipelineLookupRequest,
): 'bundled' | 'user' | 'project' | 'shared' | 'curated' | 'unknown' {
  if (isCuratedPipelineLookup(request)) return 'curated';
  if (isSharedPipelineRequest(request)) {
    return 'shared';
  }
  if (isProjectPipelineRequest(request)) {
    return 'project';
  }
  if (isStoredPipelineLookupRequest(request)) {
    return request.source;
  }
  return 'unknown';
}
function isYamlPipelinePath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.yaml' || extension === '.yml';
}

export async function validateProjectPipelineAccess(
  request: ProjectPipelineRequest,
): Promise<
  | { success: true; data: { filePath: string; rootDir: string } }
  | {
      success: false;
      error: string;
    }
> {
  if (!path.isAbsolute(request.cwd)) {
    return {
      success: false,
      error: 'Project pipeline cwd must be absolute',
    };
  }

  if (!path.isAbsolute(request.filePath)) {
    return {
      success: false,
      error: 'Project pipeline filePath must be absolute',
    };
  }

  const normalizedFilePath = path.resolve(request.filePath);
  const rootDir = getProjectPipelinesDirCandidates(request.cwd).find(
    (candidate) => isPathInside(candidate, normalizedFilePath),
  );
  if (!rootDir) {
    return {
      success: false,
      error:
        'Project pipeline filePath must stay inside a project pipelines directory',
    };
  }

  if (!isYamlPipelinePath(normalizedFilePath)) {
    return {
      success: false,
      error: 'Project pipeline filePath must be a .yml or .yaml file',
    };
  }

  const relativeFilePath = path
    .relative(rootDir, normalizedFilePath)
    .split(path.sep)
    .join('/');
  const expectedId = getProjectPipelineId(relativeFilePath);
  if (request.id !== expectedId) {
    return {
      success: false,
      error: 'Project pipeline id does not match filePath',
    };
  }

  try {
    const [resolvedRealPath, resolvedRootDir] = await Promise.all([
      realpath(normalizedFilePath),
      realpath(rootDir),
    ]);
    if (!isPathInside(resolvedRootDir, resolvedRealPath)) {
      return {
        success: false,
        error:
          'Project pipeline symlink target must stay inside .canopy/pipelines',
      };
    }
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  return {
    success: true,
    data: {
      filePath: normalizedFilePath,
      rootDir,
    },
  };
}

async function loadProjectPipelineData(
  request: ProjectPipelineRequest,
): Promise<
  | {
      success: true;
      data: PipelineData;
    }
  | {
      success: false;
      error: string;
    }
> {
  if (pipelineResourceContextEnabled()) {
    try {
      await authorizeProjectPipelineRequest(request);
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  }
  const validated = await validateProjectPipelineAccess(request);
  if (!validated.success) {
    return validated;
  }

  try {
    const [content, fileStats] = await Promise.all([
      loadProjectPipelineFromDisk(validated.data.filePath),
      stat(validated.data.filePath),
    ]);
    const relativeFilePath = path
      .relative(validated.data.rootDir, validated.data.filePath)
      .split(path.sep)
      .join('/');

    return {
      success: true,
      data: {
        info: {
          id: request.id,
          name: content.name,
          description: content.description ?? '',
          icon: content.icon ?? '',
          filename: relativeFilePath,
          createdAt: getCreatedAt(fileStats),
          updatedAt: fileStats.mtime.toISOString(),
          source: 'project',
          readonly: true,
          filePath: validated.data.filePath,
        },
        content,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function persistPipelineRemoteMetadata(
  request: Pick<
    SharedPipelineWriteRequest,
    'sourcePipeline' | 'sourcePipelineId' | 'shareScope'
  >,
  detail: SharedPipelineDetail,
):
  | ReturnType<typeof service.writePipelineRemoteMetadata>
  | ReturnType<typeof service.writeProjectPipelineRemoteMetadata>
  | undefined {
  const remote = {
    accountId: detail.createdBy.id,
    remoteId: detail.id,
    contentHash: detail.contentHash,
    shareScope: detail.shareScope ?? request.shareScope ?? 'private',
    sharedAt: detail.updatedAt,
  };
  if (request.sourcePipeline?.kind === 'project') {
    return service.writeProjectPipelineRemoteMetadata(
      request.sourcePipeline.pipelineFilePath,
      remote,
    );
  }
  const sourceId =
    request.sourcePipeline?.kind === 'stored'
      ? request.sourcePipeline.source === 'user'
        ? request.sourcePipeline.id
        : undefined
      : request.sourcePipelineId;
  return sourceId
    ? service.writePipelineRemoteMetadata(sourceId, remote)
    : undefined;
}

/**
 * Saves a pipeline the editor holds, as the editor's Save button does: core
 * validates it and refuses a stale revision. The Pipeline Editor's agent
 * saves run this too (CAN-5822), so they keep its owner rules.
 */
export async function saveEditorPipeline(
  input: PipelineSaveInput,
): Promise<IPCResult<PipelineInfo>> {
  if (pipelineResourceContextEnabled() && input.id) {
    try {
      await assertStoredPipelineContext(input.id);
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  }
  // An existing pipeline keeps its owner; a new one takes the selected one.
  const existingUserPipelineId =
    input.id && isLocalUserPipeline(input.id) ? input.id : undefined;
  const ownerContext =
    existingUserPipelineId !== undefined
      ? await getUserPipelineOwner(existingUserPipelineId)
      : await selectedOwnerContext();
  // Saving in the editor as the user records the owner of a new pipeline
  // and clears any agent marker.
  const recordUserSave = (savedId: string): void => {
    if (existingUserPipelineId === undefined)
      recordUserPipelineOwner(savedId, ownerContext);
    setUserPipelineAgentAuthor(savedId, null);
  };
  if (input.sourceRemoteId) {
    // Core reads and validates the share itself, never the renderer's
    // copy, and installs it with its receipt (with resource contexts on)
    // and subscription.
    try {
      validateId(input.sourceRemoteId, 'sourceRemoteId');
      const installed = await importRemotePipeline({
        remoteDefinitionId: buildSharedPipelineId(
          CANOPY_CLOUD_SERVER_ID,
          input.sourceRemoteId,
        ),
        expectedRemoteVersion: null,
        nameOverride: input.name,
        ...(input.id ? { definitionId: input.id } : {}),
      });
      recordUserSave(installed.id);
      return { success: true, data: installed };
    } catch (error) {
      return { success: false, error: pipelineWriteErrorMessage(error) };
    }
  }
  const ownerRefusal = await validatePipelineOwnerTargetsOnSave(
    input.content,
    ownerContext,
  );
  if (ownerRefusal !== null) return { success: false, error: ownerRefusal };
  // Core validates, refuses a stale revision, and runs the store's
  // effects; this projection keeps the legacy result and owner records.
  const result = await withPipelineCrudTelemetry(
    {
      action: input.id ? 'update' : 'create',
      source: 'user',
      hasPipelineId: Boolean(input.id),
    },
    (): Promise<IPCResult<PipelineInfo>> =>
      saveUserPipeline({
        ...(input.id ? { id: input.id } : {}),
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
        name: input.name,
        description: input.description,
        icon: input.icon,
        content: input.content,
        ...(input.rawContent === undefined
          ? {}
          : { rawContent: input.rawContent }),
      }),
  );
  if (result.success && result.data) {
    recordUserSave(result.data.id);
    // Decision 6 (CAN-5782): a workflow page's schedules take its name.
    if (existingUserPipelineId !== undefined) {
      await copyWorkflowNameToSchedules(result.data.id, input.name);
      // P7 (CAN-6183): its cloud schedules run the workflow as saved.
      const { getAutomationsService } = await import('../automations/service');
      await getAutomationsService()
        .syncCloudSchedulesAfterPipelineSave(result.data.id, input.name)
        .catch(() => undefined);
    }
  }
  return result;
}

/** Updates a shared pipeline the editor holds, as the editor's Save button does. */
export async function updateSharedPipelineFromEditor(
  request: SharedPipelineWriteRequest & { remoteId: string },
): Promise<
  | { success: true; data: SharedPipelineDetail }
  | { success: false; error: string; failure: ShareFailure }
> {
  return withPipelineCrudTelemetry(
    { action: 'shared_update', source: 'shared', hasPipelineId: true },
    async () => {
      const outcome = await runClassifiedShare(async () => {
        const options = {
          expectedContentHash: request.expectedContentHash,
          shareScope: request.shareScope,
          teamId: request.teamId,
          organizationId: request.organizationId,
          distributionMode: request.distributionMode,
          committedPackageUploadId: request.committedPackageUploadId,
          revokePublicShare: request.revokePublicShare,
        };
        const updated = request.distributionMode
          ? await updateSharedPipeline(
              request.remoteId,
              request.rawPipeline,
              options,
            )
          : await updateSharedPipelinePreservingPackage(
              request.remoteId,
              request.rawPipeline,
              undefined,
              options,
            );
        const detail = hydrateSharedPipelineDetailScopes(updated);
        const linked = persistPipelineRemoteMetadata(request, detail);
        if (linked && !linked.success) {
          throw new Error(
            linked.error ?? 'Failed to store workflow share link.',
          );
        }
        return detail;
      });
      return outcome.ok
        ? { success: true, data: outcome.value }
        : {
            success: false,
            error: toErrorMessage(outcome.error),
            failure: outcome.failure,
          };
    },
  );
}

/** A worktree a hosted controller reads pipelines in, by local IDs. */
interface WorktreePipelineScope {
  projectId: string;
  worktreeId: string;
}

function worktreePipelineScope(value: unknown): WorktreePipelineScope;
function worktreePipelineScope(
  value: unknown,
  options: { optionalWorktree: true },
): { projectId: string; worktreeId?: string };
function worktreePipelineScope(
  value: unknown,
  options: { optionalWorktree?: true } = {},
): { projectId: string; worktreeId?: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('projectId' in value) ||
    typeof value.projectId !== 'string'
  ) {
    throw new Error('A project is required.');
  }
  validateId(value.projectId, 'projectId');
  const worktreeId = 'worktreeId' in value ? value.worktreeId : undefined;
  if (worktreeId === undefined && options.optionalWorktree === true) {
    return { projectId: value.projectId };
  }
  if (typeof worktreeId !== 'string') {
    throw new Error('A worktree is required.');
  }
  validateId(worktreeId, 'worktreeId');
  return { projectId: value.projectId, worktreeId };
}

/*
 * The window's calls as owners, so App Advisor's actions in Electron main
 * make the same ones (CAN-6003).
 */

export function listPipelinesForCaller(): ReturnType<
  PipelineReadPort['pipelines']['list']
> {
  return withPipelineCrudTelemetry(
    { action: 'list', source: 'unknown' },
    async (): Promise<IPCResult<PipelineInfo[]>> => {
      startManagedCuratedPipelineSync();
      // Core lists the stored and catalog definitions, in its order. An
      // unavailable account or catalog never hides local pipelines.
      let rows: PipelineInfo[];
      try {
        rows = (
          await listDesktopPipelines(
            { sources: ['bundled', 'user', 'curated'] },
            PIPELINE_DEFINITION_DESKTOP_CALLER,
          )
        ).rows;
      } catch (error) {
        return { success: false, error: pipelineWriteErrorMessage(error) };
      }
      // CAN-5782: the Workflow page reads a pipeline's schedule facts
      // from the list, so they exist with zero schedules.
      rows = await withWorkflowPageInfo(rows);
      if (!pipelineResourceContextEnabled())
        return { success: true, data: rows };
      return {
        success: true,
        data: await filterStoredPipelineContexts(rows),
      };
    },
  );
}

export async function getPipelineForCaller(
  request: PipelineLookupRequest,
): Promise<Awaited<ReturnType<PipelineReadPort['pipelines']['get']>>> {
  return withPipelineCrudTelemetry(
    {
      action: 'get',
      source: getPipelineLookupTelemetrySource(request),
      hasPipelineId:
        typeof request === 'string' ||
        (typeof request === 'object' && request !== null && 'id' in request),
    },
    async () => {
      if (pipelineResourceContextEnabled()) {
        const localId =
          typeof request === 'string'
            ? request
            : 'id' in request
              ? request.id
              : undefined;
        if (localId) {
          try {
            if (isProjectPipelineRequest(request))
              await authorizeProjectPipelineRequest(request);
            else await assertStoredPipelineContext(localId);
          } catch (error) {
            return { success: false, error: toErrorMessage(error) };
          }
        }
      }

      // A project file named by host path is read where it was found;
      // core reads project definitions by worktree scope.
      if (isProjectPipelineRequest(request))
        return loadProjectPipelineData(request);
      const lookup = pipelineLookupDefinition(request);
      if (!lookup)
        return { success: false, error: 'Invalid pipeline lookup request' };
      // Store lookups never resolve a share or a project file.
      if (lookup.stored && !isStoredDefinitionId(lookup.definitionId))
        return {
          success: false,
          error: `Workflow not found: ${lookup.definitionId}`,
        };
      // Core's get takes no source, so a bundled definition a user one
      // shadows is read from the bundled store directly, without
      // touching the shadow.
      if (
        lookup.source === 'bundled' &&
        getStoredPipelineIndexEntry(lookup.definitionId, 'user')
      )
        return withLocalRunOwner(
          service.getStoredPipelineBySource('bundled', lookup.definitionId),
        );
      let data: PipelineData;
      try {
        data = await readDesktopPipeline(
          lookup.definitionId,
          {},
          PIPELINE_DEFINITION_DESKTOP_CALLER,
        );
      } catch (error) {
        return { success: false, error: pipelineWriteErrorMessage(error) };
      }
      if (lookup.source !== undefined && data.info.source !== lookup.source)
        return {
          success: false,
          error: `Workflow not found: ${lookup.definitionId}`,
        };
      return withLocalRunOwner({ success: true, data });
    },
  );
}

export async function getSharedPipelineForCaller(
  request: SharedPipelineGetRequest,
): Promise<Awaited<ReturnType<PipelineReadPort['pipelines']['getShared']>>> {
  return withPipelineCrudTelemetry(
    { action: 'shared_get', source: 'shared', hasPipelineId: true },
    async () => {
      try {
        return {
          success: true,
          data: hydrateSharedPipelineDetailScopes(
            await getSharedPipeline(request.remoteId),
          ),
        };
      } catch (error) {
        return {
          success: false,
          error: toErrorMessage(error),
        };
      }
    },
  );
}

export function discoverProjectPipelinesForCaller(
  cwd: string,
): ReturnType<PipelineReadPort['pipelines']['discoverProject']> {
  return withPipelineCrudTelemetry(
    { action: 'discover', source: 'project', hasProjectContext: true },
    async () => {
      if (!path.isAbsolute(cwd)) {
        return {
          success: false,
          error: 'cwd must be an absolute path',
        };
      }
      return discoverProjectPipelines(cwd)
        .then(async (data) => ({
          success: true,
          data: await filterProjectPipelineContexts(data, cwd),
        }))
        .catch((error) => ({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }));
    },
  );
}

export function registerPipelineHandlers(): void {
  registerCuratedPipelineHandlers();
  app.once('will-quit', stopManagedCuratedPipelineSync);
  registerIpcHandler(PIPELINE_CHANNELS.LIST, () => listPipelinesForCaller());
  registerIpcHandler(
    PIPELINE_CHANNELS.DISCOVER_PROJECT,
    (_event, cwd: string) => discoverProjectPipelinesForCaller(cwd),
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.GET,
    (_event, request: PipelineLookupRequest) => getPipelineForCaller(request),
  );
  registerIpcHandler(PIPELINE_CHANNELS.SAVE, (_, input: PipelineSaveInput) =>
    saveEditorPipeline(input),
  );
  // Core deletes the definition with its preferences, local metadata,
  // subscription ledger entry and package install.
  registerIpcHandler(PIPELINE_CHANNELS.DELETE, (_, id: string) => {
    return withPipelineCrudTelemetry(
      { action: 'delete', source: 'user', hasPipelineId: true },
      (): Promise<IPCResult> => deleteUserPipeline(id, null),
    );
  });
  registerIpcHandler(
    PIPELINE_CHANNELS.DUPLICATE,
    async (_event, request: PipelineLookupRequest) => {
      // A copy belongs to the selected owner and carries no agent marker.
      const copyOwner = await selectedOwnerContext();
      const duplicated = await withPipelineCrudTelemetry(
        {
          action: 'duplicate',
          source: getPipelineLookupTelemetrySource(request),
          hasPipelineId: true,
        },
        async () => {
          if (pipelineResourceContextEnabled()) {
            try {
              if (isProjectPipelineRequest(request)) {
                const { owner } =
                  await authorizeProjectPipelineRequest(request);
                if (owner.type === 'organization')
                  throw new Error('Workflow unavailable (context-mismatch)');
              } else {
                const localId =
                  typeof request === 'string'
                    ? request
                    : 'id' in request
                      ? request.id
                      : undefined;
                if (localId?.startsWith('project--'))
                  throw new Error('Workflow unavailable (unknown-provenance)');
                if (localId) await assertStoredPipelineContext(localId);
              }
            } catch (error) {
              return { success: false, error: toErrorMessage(error) };
            }
          }

          const sourceId = duplicateSourceId(request);
          if (sourceId !== undefined && isLocalUserPipeline(sourceId)) {
            const refusal = await workflowPageDuplicateRefusal(sourceId);
            if (refusal) return { success: false, error: refusal };
          }
          if (sourceId !== undefined)
            return duplicatePipelineDefinition(sourceId, {});
          if (!isProjectPipelineRequest(request))
            return {
              success: false,
              error: 'Invalid pipeline lookup request for duplication',
            };
          // Core reads project definitions by worktree scope; this request
          // names the file by host path, so its copy is saved through core
          // from the checked file.
          const loaded = await loadProjectPipelineData(request);
          if (!loaded.success) return loaded;
          const name = `${loaded.data.content.name} (Copy)`;
          const content = { ...loaded.data.content, name };
          delete content.readonly;
          return saveUserPipeline({
            name,
            description: loaded.data.content.description ?? '',
            icon: loaded.data.content.icon ?? '',
            content,
          });
        },
      );
      if (duplicated.success && duplicated.data) {
        recordUserPipelineOwner(duplicated.data.id, copyOwner);
        const sourceId = duplicateSourceId(request);
        // A copy whose workflow facts didn't persist is removed: an
        // Orchestrator copy would otherwise show its prompt to agents.
        if (sourceId !== undefined && isLocalUserPipeline(sourceId)) {
          const copied = await copyWorkflowPageFacts(
            sourceId,
            duplicated.data.id,
          ).catch((error: unknown): false => {
            logMainProcessError('Failed to copy a workflow’s facts', error);
            return false;
          });
          if (!copied) {
            await deleteUserPipeline(duplicated.data.id, null);
            return { success: false, error: WORKFLOW_DUPLICATE_FAILED };
          }
        }
      }
      return duplicated;
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SHARED_LIST,
    async (
      _event,
      request: ListSharedPipelinesRequest,
    ): Promise<
      | { success: true; data: ListSharedPipelinesResponse }
      | { success: false; error: string }
    > => {
      return withPipelineCrudTelemetry(
        {
          action: 'shared_list',
          source: 'shared',
          hasSearchQuery: Boolean(request.q?.trim()),
          triggerType: request.triggerType,
        },
        async () => {
          try {
            const response = await listSharedPipelines({
              limit: request.limit,
              cursor: request.cursor,
              q: request.q,
              triggerType: request.triggerType,
              createdBy: request.createdBy,
            });
            return {
              success: true,
              data: {
                serverId: CANOPY_CLOUD_SERVER_ID,
                data: response.data.map(withDefaultSharedPipelineScopes),
                nextCursor: response.nextCursor,
              },
            };
          } catch (error) {
            return {
              success: false,
              error: toErrorMessage(error),
            };
          }
        },
      );
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SHARED_GET,
    (_event, request: SharedPipelineGetRequest) =>
      getSharedPipelineForCaller(request),
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SHARED_CREATE,
    async (
      _event,
      request: SharedPipelineWriteRequest,
    ): Promise<
      | { success: true; data: SharedPipelineDetail }
      | { success: false; error: string; failure: ShareFailure }
    > => {
      return withPipelineCrudTelemetry(
        {
          action: 'shared_create',
          source: 'shared',
          shareScope: request.shareScope,
        },
        async () => {
          const outcome = await runClassifiedShare(async () => {
            if (pipelineResourceContextEnabled() && request.sourcePipelineId)
              validateId(request.sourcePipelineId, 'sourcePipelineId');
            const created = await createSharedPipeline({
              ...(pipelineResourceContextEnabled()
                ? {
                    sourcePipeline: request.sourcePipeline,
                    sourcePipelineId: request.sourcePipelineId,
                  }
                : {}),
              rawPipeline: request.rawPipeline,
              shareScope: request.shareScope,
              teamId: request.teamId,
              organizationId: request.organizationId,
              distributionMode: request.distributionMode,
              committedPackageUploadId: request.committedPackageUploadId,
            });
            const linked = persistPipelineRemoteMetadata(request, created);
            if (linked && !linked.success) {
              await deleteSharedPipeline(created.id);
              throw new Error(
                linked.error ?? 'Failed to store workflow share link.',
              );
            }
            return hydrateSharedPipelineDetailScopes(created);
          });
          return outcome.ok
            ? { success: true, data: outcome.value }
            : {
                success: false,
                error: toErrorMessage(outcome.error),
                failure: outcome.failure,
              };
        },
      );
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.ANALYZE_PACKAGE,
    async (_event, request: PipelinePackageAnalyzeRequest) => {
      try {
        return { success: true, data: await analyzePackageRequest(request) };
      } catch (error) {
        // The Share dialog shows only this message, so keep the full error
        // (stack and code) in the main log. The pipeline text is not logged.
        logMainProcessError(
          `[pipelines] Package analysis failed for ${request.pipelineId ?? 'an unsaved pipeline'}`,
          error,
        );
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.CANCEL_PACKAGE_ANALYSIS,
    (_event, request: PipelinePackageCancelAnalysisRequest) => {
      cancelPackageAnalysis(request.analysisId);
      return { success: true };
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SHARED_CREATE_PACKAGED,
    async (
      event,
      request: PipelinePackageCreateSharedRequest,
    ): Promise<
      | { success: true; data: SharedPipelineDetail }
      | { success: false; error: string; failure: ShareFailure }
    > => {
      const outcome = await runClassifiedShare(async () => {
        const created = await createPackagedSharedPipeline(request, () =>
          BrowserWindow.fromWebContents(event.sender),
        );
        const linked = persistPipelineRemoteMetadata(request, created);
        if (linked && !linked.success) {
          if (!request.remoteId) await deleteSharedPipeline(created.id);
          throw new Error(
            linked.error ?? 'Failed to store workflow share link.',
          );
        }
        return hydrateSharedPipelineDetailScopes(created);
      });
      return outcome.ok
        ? { success: true, data: outcome.value }
        : {
            success: false,
            error: toErrorMessage(outcome.error),
            failure: outcome.failure,
          };
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.PACKAGE_INSTALLS_LIST,
    async (): Promise<
      | { success: true; data: PipelinePackageInstallRecordV1[] }
      | { success: false; error: string }
    > => {
      try {
        return { success: true, data: await listPackageInstalls() };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.INSTALL_PACKAGE_SHARE,
    async (
      _event,
      request: PipelinePackageInstallRequest,
    ): Promise<
      | { success: true; data: PipelinePackageInstallResult }
      | { success: false; error: string }
    > => {
      try {
        return {
          success: true,
          data: await installPublicPackageShare(request, () =>
            BrowserWindow.getFocusedWindow(),
          ),
        };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.PACKAGE_READINESS,
    async (
      _event,
      request: PipelinePackageReadinessRequest,
    ): Promise<
      | { success: true; data: PipelinePackageReadiness }
      | { success: false; error: string }
    > => {
      try {
        return { success: true, data: await getPackageReadiness(request) };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SHARED_UPDATE_IMPACT,
    async (
      _event,
      remoteId: string,
    ): Promise<IPCResult<SharedPipelineSaveImpact>> => {
      try {
        validateId(remoteId, 'remoteId');
        return {
          success: true,
          data: await getSharedPipelineSaveImpact(remoteId),
        };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SHARED_UPDATE,
    (_event, request: SharedPipelineWriteRequest & { remoteId: string }) =>
      updateSharedPipelineFromEditor(request),
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SHARED_DELETE,
    async (
      _event,
      request: SharedPipelineDeleteRequest,
    ): Promise<{ success: true } | { success: false; error: string }> => {
      return withPipelineCrudTelemetry(
        { action: 'shared_delete', source: 'shared', hasPipelineId: true },
        async () => {
          try {
            await deleteSharedPipeline(request.remoteId);
            // The Portal shared list memoizes cloud rows and hides the
            // author's linked share; once the link is cleared below, a stale
            // memo would list the deleted share as a separate row.
            const { clearSharedPipelineListCache } =
              await import('../services/pipelines-service');
            clearSharedPipelineListCache();
            const cleared = service.clearPipelineRemoteMetadataByRemoteId(
              request.remoteId,
            );
            const projectCleared =
              service.clearProjectPipelineRemoteMetadataByRemoteId(
                request.remoteId,
              );
            if (!cleared.success || !projectCleared.success) {
              throw new Error(
                cleared.error ??
                  projectCleared.error ??
                  'Failed to clear workflow share link.',
              );
            }
            return { success: true };
          } catch (error) {
            return {
              success: false,
              error: toErrorMessage(error),
            };
          }
        },
      );
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SHARED_PUBLIC_PUBLISH,
    async (
      _event,
      remoteId: string,
    ): Promise<
      | { success: true; data: SharedPipelinePublicShareInfo }
      | { success: false; error: string }
    > => {
      try {
        validateId(remoteId, 'remoteId');
        return {
          success: true,
          data: await publishPipelinePublicShare(remoteId),
        };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SHARED_PUBLIC_REVOKE,
    async (
      _event,
      remoteId: string,
    ): Promise<{ success: true } | { success: false; error: string }> => {
      try {
        validateId(remoteId, 'remoteId');
        await revokePipelinePublicShare(remoteId);
        return { success: true };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SHARED_ORGANIZATIONS_LIST,
    async (
      _event,
      request: ListSharedOrganizationsRequest,
    ): Promise<
      | { success: true; data: ListSharedOrganizationsResponse }
      | { success: false; error: string }
    > => {
      try {
        const response = await listSharedOrganizations({
          q: request.q,
          limit: request.limit,
        });
        return {
          success: true,
          data: {
            serverId: CANOPY_CLOUD_SERVER_ID,
            data: response.data,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: toErrorMessage(error),
        };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SHARED_TEAMS_LIST,
    async (
      _event,
      request: ListSharedTeamsRequest,
    ): Promise<
      | { success: true; data: ListSharedTeamsResponse }
      | { success: false; error: string }
    > => {
      try {
        const response = await listSharedTeams({
          q: request.q,
          limit: request.limit,
        });
        return {
          success: true,
          data: {
            serverId: CANOPY_CLOUD_SERVER_ID,
            data: response.data,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: toErrorMessage(error),
        };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.RESOLVE_ACTION,
    (_, usesRef: string, repoPath?: string) => {
      try {
        return {
          success: true,
          data: resolveAction(usesRef, repoPath),
        };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );
  registerIpcHandler(PIPELINE_CHANNELS.LIST_ACTIONS, () => {
    try {
      return {
        success: true,
        data: listBuiltinActions(),
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
  registerIpcHandler(
    PIPELINE_CHANNELS.RESOLVE_PLUGIN_COLLECTIONS,
    async (
      _event,
      request: ResolvePluginCollectionsRequest,
    ): Promise<
      | {
          success: true;
          data: ResolvePluginCollectionsResponse;
        }
      | { success: false; error: string }
    > => {
      try {
        const pipeline =
          'yaml' in request.pipeline
            ? parsePipelineText(request.pipeline.yaml)
            : request.pipeline;
        const normalized = normalizePipeline(pipeline, {
          defaultShell: getDefaultShellTypeForCurrentProcess(),
        });
        const storedPreferences = request.pipelinePreferenceLocator
          ? loadPipelinePluginCollectionPreferences(
              request.pipelinePreferenceLocator,
            )
          : {};
        const draftPreferences = normalizePipelinePluginCollectionPreferences(
          request.draftPreferences,
        );
        const effectivePreferences = {
          ...storedPreferences,
          ...draftPreferences,
        };
        const resolution = await resolvePipelinePluginCollections(
          normalized.plugin_collections,
          effectivePreferences,
        );
        return {
          success: true,
          data: {
            previewItems: resolution.previewItems,
            effectivePreferences,
            validation: {
              hasBlockingErrors: Object.values(resolution.snapshots).some(
                (snapshot) => snapshot.unresolvedRequiredDefaults.length > 0,
              ),
              messages: resolution.messages,
            },
          },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  // Capability summary for every locally readable pipeline (CAN-2382).
  // Powers the "Related pipelines" sections on skill/plugin detail pages and
  // the "Related skills and plugins" section on the pipeline detail surface.
  // Shared Cloud pipelines are deliberately excluded: summarizing them would
  // require fetching every remote YAML, and unauthorized/unavailable items
  // must never appear as recommendations.
  registerIpcHandler(
    PIPELINE_CHANNELS.LIST_CAPABILITY_REFS,
    async (
      _event,
      request?: ListPipelineCapabilityRefsRequest,
    ): Promise<
      | { success: true; data: ListPipelineCapabilityRefsResponse }
      | { success: false; error: string }
    > => {
      try {
        const catalog = await loadShareablePluginCatalog();
        const summarize = (content: Pipeline): PipelineCapabilitySummary[] =>
          collectPipelineCapabilityRefs(content).map((ref) => {
            const display = buildPipelineDefaultDisplay(ref.defaultRef);
            const match = matchShareablePluginRef(ref.defaultRef, catalog);
            return {
              key: ref.key,
              kind: ref.kind,
              required: ref.required,
              collectionId: ref.collectionId,
              collectionName: ref.collectionName,
              displayName: display.title,
              displaySource: display.subtitle,
              matchState: match.matchState,
              ...(match.matchState === 'matched'
                ? { selection: match.selection }
                : {}),
            };
          });

        const entries: PipelineCapabilityRefsEntry[] = [];
        const stored = await service.listPipelineCapabilityData();
        if (!stored.success || !stored.data) {
          throw new Error(stored.error || 'Failed to load stored pipelines');
        }
        for (const data of stored.data) {
          const info = data.info;
          if (info.source !== 'bundled' && info.source !== 'user') {
            continue;
          }
          entries.push({
            id: info.id,
            source: info.source,
            name: info.name,
            icon: info.icon,
            capabilities: summarize(data.content),
          });
        }

        const cwd = request?.cwd;
        if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
          // Project discovery is best-effort: a missing or unreadable project
          // pipelines directory must not fail the stored summaries.
          try {
            const projectInfos = await discoverProjectPipelines(cwd);
            for (const info of projectInfos) {
              if (!info.filePath) {
                continue;
              }
              const data = await loadProjectPipelineData({
                id: info.id,
                cwd,
                filePath: info.filePath,
              });
              if (!data.success || !data.data) {
                continue;
              }
              entries.push({
                id: info.id,
                source: 'project',
                name: info.name,
                icon: info.icon,
                filePath: info.filePath,
                capabilities: summarize(data.data.content),
              });
            }
          } catch {
            // Ignore project discovery failures.
          }
        }

        return { success: true, data: { pipelines: entries } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.LOAD_MODEL_ALIAS_PREFERENCES,
    (
      _event,
      request: LoadModelAliasPreferencesRequest,
    ):
      | {
          success: true;
          data: LoadModelAliasPreferencesResponse;
        }
      | { success: false; error: string } => {
      try {
        const preferences = request.pipelinePreferenceLocator
          ? loadPipelineModelAliasPreferences(request.pipelinePreferenceLocator)
          : {};
        return { success: true, data: { preferences } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SAVE_MODEL_ALIAS_PREFERENCES,
    async (
      _event,
      request: SaveModelAliasPreferencesRequest,
    ): Promise<
      | {
          success: true;
          data: SaveModelAliasPreferencesResponse;
        }
      | { success: false; error: string }
    > => {
      try {
        if (!request.pipelinePreferenceLocator) {
          return {
            success: true,
            data: { ok: false, reason: 'missing-locator' },
          };
        }
        const saved = await savePipelineModelAliasPreferences(
          request.pipelinePreferenceLocator,
          request.preferences,
          'electron_main',
          {
            ...(request.aliasIds ? { aliasIds: request.aliasIds } : {}),
            ...(request.basePreferences
              ? { base: request.basePreferences }
              : {}),
          },
        );
        return { success: true, data: { ok: true, ...saved } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  registerIpcHandler(
    PIPELINE_CHANNELS.SAVE_PLUGIN_COLLECTION_PREFERENCES,
    async (
      _event,
      request: SavePluginCollectionPreferencesRequest,
    ): Promise<
      | {
          success: true;
          data: SavePluginCollectionPreferencesResponse;
        }
      | { success: false; error: string }
    > => {
      try {
        if (!request.pipelinePreferenceLocator) {
          return {
            success: true,
            data: { ok: false, reason: 'missing-locator' },
          };
        }
        const saved = await savePipelinePluginCollectionPreferences(
          request.pipelinePreferenceLocator,
          request.preferences,
          'electron_main',
          request.basePreferences ? { base: request.basePreferences } : {},
        );
        return { success: true, data: { ok: true, ...saved } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stats = await stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function resolveStoredExecutionCwd(
  state: ExecutionState,
): Promise<string> {
  if (state.target?.scope === 'directory') {
    if (await directoryExists(state.target.path)) {
      return state.target.path;
    }
    throw new Error(
      `Directory target path does not exist: ${state.target.path}`,
    );
  }

  if (state.target?.scope === 'worktree') {
    if (await directoryExists(state.target.path)) {
      return state.target.path;
    }
    throw new Error(
      `Worktree target "${state.target.workspace_id}/${state.target.worktree_id}" no longer exists`,
    );
  }

  if (state.project_id && state.worktree_id) {
    try {
      const resolvedCwd = resolveWorktreeCwd(
        state.project_id,
        state.worktree_id,
      );
      if (await pathExists(resolvedCwd)) {
        return resolvedCwd;
      }
    } catch {
      if (state.scope === 'worktree') {
        throw new Error(
          `Worktree target "${state.project_id}/${state.worktree_id}" no longer exists`,
        );
      }
    }
  }

  return state.cwd;
}

async function loadExecutionForReplay(
  executionId: string,
  runtime = createMonitoredElectronExecutionRuntime(),
): Promise<{
  runtime: ExecutionOptions['runtime'];
  state: ExecutionState;
}> {
  const storedState = await loadExecutionState(
    executionId,
    runtime.executionsDir,
  );
  const state = storedState
    ? await resolveReplayLocation(storedState, runtime)
    : null;
  if (!state) {
    throw new Error(`Execution "${executionId}" not found`);
  }

  const speedError = pipelineSpeedError(state.model_config);
  if (speedError) throw new Error(speedError);

  return { runtime, state };
}

async function buildReplayBaseBranchEnv(
  cwd: string,
  state: Pick<ExecutionState, 'project_id' | 'worktree_id'>,
): Promise<Record<string, string>> {
  return buildPipelineBaseBranchEnv({
    cwd,
    projectId: state.project_id,
    worktreeId: state.worktree_id,
  });
}

/** The desktop's own observers of an execution event; watchers settle apart. */
function fanOutExecutionEvent(
  getWindow: () => BrowserWindow | null,
  event: ExecutionEvent,
): void {
  notePipelineExecutionEvent(event, getWindow);
  createDesktopPipelineObservabilityFeed().onExecutionEvent(event);
  recordPipelineUsageEvent(event);
  noteAutomationPipelineEvent(event);
  if (
    (event.type === 'execution.completed' ||
      event.type === 'execution.failed') &&
    (event.state.status === 'success' || event.state.status === 'failure') &&
    event.state.project_id &&
    event.state.worktree_id
  ) {
    void enqueueKnownPrFastRefresh(
      event.state.project_id,
      event.state.worktree_id,
    ).catch(() => undefined);
  }
  broadcastPipelineExecutionEvent(event);
}

/** An event an entry point reports itself rather than through the worker. */
function emitExecutionEvent(
  getWindow: () => BrowserWindow | null,
  event: ExecutionEvent,
): void {
  fanOutExecutionEvent(getWindow, event);
  void settlePipelineExecutionEvent(event).catch(() => undefined);
}

function emitStepOutputEvent(
  getWindow: () => BrowserWindow | null,
  event: Parameters<NonNullable<ExecutionOptions['onStepOutput']>>[0],
): void {
  createDesktopPipelineObservabilityFeed().onStepOutput(event);
  void getWindow;
  sendToAllWindows(PIPELINE_CHANNELS.STEP_OUTPUT_EVENT, event);
}

function pipelineExecutionFanOut(
  getWindow: () => BrowserWindow | null,
): PipelineExecutionFanOut {
  return {
    onEvent: (event) => fanOutExecutionEvent(getWindow, event),
    onStepOutput: (event) => emitStepOutputEvent(getWindow, event),
    onSettled: (event) => {
      void Promise.resolve(
        getAppAdvisorWatcherService().handlePipelineTerminalEvent(event),
      ).catch(() => undefined);
    },
  };
}

/** The nested pipeline executions an execution started. */
export async function cancelPipelineExecutionFromMain(args: {
  executionId: string;
  getWindow: () => BrowserWindow | null;
}): Promise<ExecutionState> {
  // The local worker retires the execution tree's paused agents as Ledger
  // owners, asks a live handle to stop, and takes the durable cancellation
  // path, which force-finalizes a wedged run after its bounded window.
  // The worker broadcasts the settled cancel to windows and watchers.
  return cancelPipelineThroughLocalWorker(args.executionId);
}

setPipelineExecutionFanOut(pipelineExecutionFanOut(() => null));

// Renderer EXECUTE is also tunneled for Portal remote control, so `portal`
// stays a foreground usage source here. Its recorded identity is still `user`:
// `{ kind: 'portal' }` is only the direct Portal `runPipeline` command in main.
const RENDERER_INITIATION_SOURCES: ReadonlySet<UsageInitiationSource> =
  new Set<UsageInitiationSource>(['user', 'app_advisor', 'portal']);

function sanitizeRendererExecuteOptions(
  options: ExecutePipelineRequestOptions,
): ExecutePipelineRequestOptions {
  const sanitized: ExecutePipelineRequestOptions = {
    cwd: options.cwd,
    pipelineId: options.pipelineId,
  };

  if (options.env !== undefined) {
    sanitized.env = options.env;
  }
  if (options.inputs !== undefined) {
    sanitized.inputs = options.inputs;
  }
  if (options.repoPath !== undefined) {
    sanitized.repoPath = options.repoPath;
  }
  if (options.scope !== undefined) {
    sanitized.scope = options.scope;
  }
  if (options.target !== undefined) {
    sanitized.target = options.target;
  }
  if (options.eventName !== undefined) {
    sanitized.eventName = options.eventName;
  }
  if (options.eventData !== undefined) {
    sanitized.eventData = options.eventData;
  }
  if (options.modelConfig !== undefined) {
    sanitized.modelConfig = options.modelConfig;
  }
  if (options.projectId !== undefined) {
    sanitized.projectId = options.projectId;
  }
  if (options.worktreeId !== undefined) {
    sanitized.worktreeId = options.worktreeId;
  }
  if (options.chatId !== undefined) {
    sanitized.chatId = options.chatId;
  }
  if (options.planId !== undefined) {
    sanitized.planId = options.planId;
  }
  // The renderer is always a foreground caller; background sources are set
  // only by main's own trusted callers. App Advisor's global runs start in
  // main, so a renderer global start is always a person's.
  if (
    options.initiationSource !== undefined &&
    isUsageInitiationSource(options.initiationSource) &&
    RENDERER_INITIATION_SOURCES.has(options.initiationSource) &&
    !(
      options.initiationSource === 'app_advisor' &&
      (options.scope === 'global' || options.target?.scope === 'global')
    )
  ) {
    sanitized.initiationSource = options.initiationSource;
  }
  if (options.pipelinePreferenceLocator !== undefined) {
    sanitized.pipelinePreferenceLocator = options.pipelinePreferenceLocator;
  }
  if (options.pluginCollectionPreferences !== undefined) {
    sanitized.pluginCollectionPreferences = options.pluginCollectionPreferences;
  }
  if (options.modelAliasPreferences !== undefined) {
    sanitized.modelAliasPreferences = options.modelAliasPreferences;
  }
  if (options.pipelineFilePath !== undefined) {
    sanitized.pipelineFilePath = options.pipelineFilePath;
  }
  if (options.sharedPipeline !== undefined) {
    sanitized.sharedPipeline = options.sharedPipeline;
  }
  if (options.appAdvisorPipelineWatchers !== undefined) {
    sanitized.appAdvisorPipelineWatchers = options.appAdvisorPipelineWatchers;
  }
  // Only a serialized owner is kept; main validates it against the saved
  // owner and the account's memberships before the run starts.
  if (
    typeof options.requestedOwner === 'string' &&
    parseWorkspaceContext(options.requestedOwner) !== null
  ) {
    sanitized.requestedOwner = options.requestedOwner;
  }
  // Identity is recorded from the sanitized usage source only; a renderer
  // `initiator` or `agentOrigin` is never honored.
  sanitized.initiator =
    sanitized.initiationSource === 'app_advisor'
      ? { kind: 'app_advisor' }
      : { kind: 'user' };

  return sanitized;
}

/**
 * Running a pipeline against a plan (`plan_ready`) counts as implicit approval
 * of that plan. This is the single main-process choke point every trigger
 * source funnels through (renderer EXECUTE, Portal/web `runPipeline`, and App
 * Advisor `pipeline.run`), so approval/sync happens here instead of being
 * duplicated across scattered renderer call sites.
 *
 * `updatePlan` no-ops when the plan id does not exist and only records the
 * `plan_approved` usage event on the real `pending -> approved` transition, so
 * re-approval is idempotent. Best-effort: a failure here must never fail the
 * pipeline run.
 */
async function applyImplicitPlanApproval(args: {
  options: MainProcessExecutePipelineRequestOptions;
  executionId: string;
}): Promise<void> {
  const { options, executionId } = args;
  const planId = options.planId ?? options.eventData?.plan_ready?.planId;
  const { projectId, worktreeId } = options;
  // A run targets a plan when it carries a resolvable plan id AND is either a
  // `plan_ready`-typed run (desktop renderer + App Advisor convention) or a
  // Portal/web `runPipeline` call. Portal plan-ready commands now carry the
  // trigger name as well as `planId`; the source fallback remains for older
  // Portal commands and other plan-targeted dispatches.
  const targetsPlan =
    options.eventName === 'plan_ready' || options.initiationSource === 'portal';
  if (!targetsPlan || !planId || !projectId || !worktreeId) {
    return;
  }
  const initiationSource =
    options.initiationSource ??
    (options.eventName === 'plan_ready' ? 'user' : undefined);

  try {
    await updatePlan({
      projectId,
      worktreeId,
      planId,
      reviewStatus: 'approved',
      approvedAt: new Date().toISOString(),
      linkedExecutionId: executionId,
      ...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
      ...(initiationSource !== undefined ? { initiationSource } : {}),
    });
  } catch (error) {
    // No worktree id is recorded here, honoring the app-diagnostics boundary;
    // the plan id alone is enough to triage without crossing into worktree
    // scope. The pipeline run itself already started successfully.
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'implicit_plan_approval_failed',
      reason: `implicit plan approval failed (planId=${planId})`,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startPipelineExecutionFromMain(args: {
  pipeline: Pipeline;
  options: MainProcessExecutePipelineRequestOptions;
  getWindow: () => BrowserWindow | null;
  onEvent?: ExecutionOptions['onEvent'];
  onStepOutput?: ExecutionOptions['onStepOutput'];
  executionReservationClaimed?: boolean;
}): Promise<PipelineExecutionStartResult> {
  const speedError = pipelineSpeedError(args.options.modelConfig);
  if (speedError) return { success: false, error: speedError };
  // A global start is refused before any reservation, owner binding, scratch
  // folder, or watcher exists, including when its owner checks can't read.
  const globalRefusal = await preflightGlobalStart(args.pipeline, args.options);
  if (globalRefusal)
    return {
      success: false,
      error: globalRefusal.message,
      ...(globalRefusal.code !== undefined
        ? { errorCode: globalRefusal.code }
        : {}),
    };
  const { projectId, worktreeId } = args.options;
  const planId =
    args.options.planId ?? args.options.eventData?.plan_ready?.planId;
  if (planId && projectId && worktreeId) {
    const plan = await readTrackedPlanData({ projectId, worktreeId, planId });
    if (isCursorPlanExecutionUnavailable(plan)) {
      return { success: false, error: CURSOR_PLAN_EXECUTION_UNAVAILABLE };
    }
  }
  if (projectId && worktreeId) {
    return withWorkspaceTargetRuntimeStartReservation(
      projectId,
      worktreeId,
      () => startPipelineExecutionFromMainWithStartReservation(args),
    );
  }
  return startPipelineExecutionFromMainWithStartReservation(args);
}

async function startPipelineExecutionFromMainWithStartReservation(args: {
  pipeline: Pipeline;
  options: MainProcessExecutePipelineRequestOptions;
  getWindow: () => BrowserWindow | null;
  onEvent?: ExecutionOptions['onEvent'];
  onStepOutput?: ExecutionOptions['onStepOutput'];
  executionReservationClaimed?: boolean;
}): Promise<PipelineExecutionStartResult> {
  // Cowork and App Advisor runs are always directory-scoped at their
  // workspace root: without an explicit scope the executor infers `worktree`
  // from projectId+worktreeId (`inferExecutionScope`), which would route the
  // cowork `'home'` id or an App Advisor work-entry id into git worktree
  // target resolution ("Worktree target ... no longer exists"). Forcing here
  // covers every run source (renderer EXECUTE, portal, agent pipeline.run,
  // execution chains) at one choke point; projectId/worktreeId stay on the
  // options so `project_id`/`worktree_id` persist onto ExecutionState for
  // listing and watchers. Worktree-only pipelines then fail the executor's
  // own top-level scope gate with a scope error instead of a git one.
  const { options } = args;
  if (
    options.projectId !== undefined &&
    isWorkEntryWorkspace(options.projectId) &&
    options.cwd !== undefined
  ) {
    return startPipelineExecutionFromMainInternal({
      ...args,
      options: {
        ...options,
        scope: 'directory',
        target: { scope: 'directory', path: options.cwd },
      },
    });
  }
  return startPipelineExecutionFromMainInternal(args);
}

async function withReplayTargetRuntimeStartReservation<T>(
  state: ExecutionState,
  operation: () => Promise<T>,
): Promise<T> {
  if (state.project_id && state.worktree_id) {
    return withWorkspaceTargetRuntimeStartReservation(
      state.project_id,
      state.worktree_id,
      operation,
    );
  }
  return operation();
}

type RetryPipelineExecutionArgs = {
  executionId: string;
  portalCommandId?: string;
  getWindow: () => BrowserWindow | null;
  onEvent?: ExecutionOptions['onEvent'];
  onStepOutput?: ExecutionOptions['onStepOutput'];
};

type ReplayResult =
  | { success: true; data: ExecutionState }
  | { success: false; error: string };

/**
 * Run a replay entry point's host side as a recovery control through core
 * and the local worker (CAN-4141), keeping its `{ success }` result.
 */
async function replayThroughLocalWorker(
  control: PipelineControlRequest,
  replay: (secrets: RedeemedExecutionSecrets) => Promise<ReplayResult>,
): Promise<ReplayResult> {
  try {
    const stored = await readStoredPipelineExecution(
      control.params.executionId,
    );
    const secretBindings = await buildPipelineSecretBindings({
      workspaceId: stored?.project_id,
    });
    const { state } = await controlPipelineThroughLocalWorker(
      control,
      async (_control, _signal, secrets) => {
        const result = await replay(secrets);
        if (!result.success) throw new Error(result.error);
        return { outcome: 'started', state: result.data };
      },
      'client',
      secretBindings,
    );
    return { success: true, data: state };
  } catch (error) {
    return { success: false, error: formatPipelineExecutionError(error) };
  }
}

/** Retry an execution's failed work in place, as a recovery control. */
export async function retryPipelineExecutionFromMain(
  args: RetryPipelineExecutionArgs,
): Promise<ReplayResult> {
  try {
    validateId(args.executionId, 'executionId');
  } catch (error) {
    return { success: false, error: formatPipelineExecutionError(error) };
  }
  return replayThroughLocalWorker(
    {
      operation: 'worker.pipeline.execution.retry',
      params: {
        requestId: args.portalCommandId ?? randomUUID(),
        executionId: args.executionId,
        mode: 'failed_only',
      },
    },
    (secrets) => retryOnLocalWorker(args, secrets),
  );
}

async function retryOnLocalWorker(
  args: RetryPipelineExecutionArgs,
  secrets: RedeemedExecutionSecrets,
): Promise<ReplayResult> {
  const { executionId, getWindow } = args;
  let releaseResourceGuard: (() => void) | null = null;
  let ownsExecutionReservation = false;
  try {
    const resourceGuard =
      getResourceMonitorService().reservePipelineExecutionStart();
    releaseResourceGuard = (): void => resourceGuard.release();

    validateId(executionId, 'executionId');
    if (hasActiveExecution(executionId)) {
      throw new Error(`Execution "${executionId}" is already running`);
    }

    reserveExecution(executionId);
    ownsExecutionReservation = true;
    releaseResourceGuard();
    releaseResourceGuard = null;
    const { runtime, state } = await loadExecutionForReplay(
      executionId,
      createMonitoredElectronExecutionRuntime(getWindow),
    );
    return await withReplayTargetRuntimeStartReservation(state, async () => {
      // Split PR lockdown: `retryPipelineExecution` re-executes directly via
      // the executor's internal `executeState`, bypassing the guarded
      // `startPipelineExecutionFromMain` chokepoint entirely, so the
      // worktree-scoped check must be re-applied at this seam.
      if (state.scope === 'worktree' && state.project_id && state.worktree_id) {
        assertNotSplitLocked(
          state.project_id,
          state.worktree_id,
          'retrying a workflow execution',
        );
      }
      const preferences = await readPreferencesFile();
      const cwd = await resolveStoredExecutionCwd(state);
      const baseBranchEnv = await buildReplayBaseBranchEnv(cwd, state);
      const pipelineRuntimeEnv = await resolvePipelineRuntimeEnv(
        state.project_id,
      );
      const authorization = await authorizePipelineReplay(state);
      const handle = await pipelineExecutorControls.retry(executionId, {
        cwd,
        ...authorization,
        agentTerminalMode: await shouldUsePipelineAgentTerminalMode(
          getEffectivePipelinesMode(preferences),
        ),
        env: {
          ...pipelineRuntimeEnv.env,
          ...(await buildPipelinePreferenceEnv(preferences)),
          ...baseBranchEnv,
        },
        repoPath: state.repo_path,
        ...(args.portalCommandId
          ? { portalCommandId: args.portalCommandId }
          : {}),
        secretEnv: Object.keys(secrets.env).length ? secrets.env : undefined,
        runtime,
        onEvent: args.onEvent,
        onStepOutput: args.onStepOutput,
      });
      trackExecutionWithAdvisor(
        handle,
        runtime,
        getWindow,
        undefined,
        executionId,
      );
      ownsExecutionReservation = false;
      return {
        success: true,
        data: handle.getState(),
      };
    });
  } catch (error) {
    releaseResourceGuard?.();
    if (ownsExecutionReservation) {
      releaseExecutionReservation(executionId);
    }
    return { success: false, error: formatPipelineExecutionError(error) };
  }
}

/** Retry a matrix job or chosen variants, as a recovery control. */
export async function retryMatrixJobFromMain(args: {
  request: RetryMatrixJobRequest;
  getWindow: () => BrowserWindow | null;
}): Promise<ExecutionState> {
  const { request } = args;
  validateId(request.executionId, 'executionId');
  validatePipelineRuntimeIdentifier(request.jobId, 'jobId');
  for (const variantJobId of request.variantJobIds ?? []) {
    validatePipelineRuntimeIdentifier(variantJobId, 'variantJobId');
  }
  const stored = await readStoredPipelineExecution(request.executionId);
  const secretBindings = await buildPipelineSecretBindings({
    workspaceId: stored?.project_id,
  });
  const { state } = await controlPipelineThroughLocalWorker(
    {
      operation: 'worker.pipeline.matrixJob.retry',
      params: {
        requestId: randomUUID(),
        executionId: request.executionId,
        jobId: request.jobId,
        mode: request.mode,
        ...(request.variantJobIds?.length
          ? { variantJobIds: request.variantJobIds }
          : {}),
      },
    },
    async (_control, _signal, secrets) => ({
      outcome: 'started',
      state: await retryMatrixJobOnLocalWorker(args, secrets),
    }),
    'client',
    secretBindings,
  );
  return state;
}

async function retryMatrixJobOnLocalWorker(
  args: {
    request: RetryMatrixJobRequest;
    getWindow: () => BrowserWindow | null;
  },
  secrets: RedeemedExecutionSecrets,
): Promise<ExecutionState> {
  const { request, getWindow } = args;
  const retryKey = `${request.executionId}\0${request.jobId}`;
  if (
    activeMatrixRetryJobs.has(retryKey) ||
    hasActiveExecution(request.executionId)
  ) {
    throw new Error(
      encodeMatrixIpcErrorMessage(
        'matrix/retry-in-progress',
        `A retry is already in progress for job "${request.jobId}"`,
      ),
    );
  }
  activeMatrixRetryJobs.add(retryKey);
  let ownsReservation = false;
  let releaseResourceGuard: (() => void) | null = null;
  try {
    const resourceGuard =
      getResourceMonitorService().reservePipelineExecutionStart();
    releaseResourceGuard = (): void => resourceGuard.release();
    reserveExecution(request.executionId);
    ownsReservation = true;
    releaseResourceGuard();
    releaseResourceGuard = null;
    const { runtime, state } = await loadExecutionForReplay(
      request.executionId,
      createMonitoredElectronExecutionRuntime(getWindow),
    );
    return await withReplayTargetRuntimeStartReservation(state, async () => {
      if (state.scope === 'worktree' && state.project_id && state.worktree_id) {
        assertNotSplitLocked(
          state.project_id,
          state.worktree_id,
          'retrying a workflow matrix job',
        );
      }
      prepareMatrixJobRetryState(structuredClone(state), request);
      const preferences = await readPreferencesFile();
      const cwd = await resolveStoredExecutionCwd(state);
      const baseBranchEnv = await buildReplayBaseBranchEnv(cwd, state);
      const pipelineRuntimeEnv = await resolvePipelineRuntimeEnv(
        state.project_id,
      );
      const authorization = await authorizePipelineReplay(state);
      const handle = await pipelineExecutorControls.retryMatrixJob(request, {
        cwd,
        ...authorization,
        agentTerminalMode: await shouldUsePipelineAgentTerminalMode(
          getEffectivePipelinesMode(preferences),
        ),
        env: {
          ...pipelineRuntimeEnv.env,
          ...(await buildPipelinePreferenceEnv(preferences)),
          ...baseBranchEnv,
        },
        repoPath: state.repo_path,
        secretEnv: Object.keys(secrets.env).length ? secrets.env : undefined,
        runtime,
      });
      trackExecutionWithAdvisor(handle, runtime, getWindow, () => {
        activeMatrixRetryJobs.delete(retryKey);
      });
      ownsReservation = false;
      return handle.getState();
    });
  } catch (error) {
    releaseResourceGuard?.();
    activeMatrixRetryJobs.delete(retryKey);
    if (ownsReservation) releaseExecutionReservation(request.executionId);
    throw error;
  }
}

/**
 * Cancel one matrix variant as a recovery control. A paused run the cancel
 * leaves ready to continue is resumed afterwards, as its own control.
 */
export async function cancelMatrixVariantFromMain(args: {
  request: CancelMatrixVariantRequest;
  getWindow: () => BrowserWindow | null;
}): Promise<ExecutionState> {
  const { request, getWindow } = args;
  validateId(request.executionId, 'executionId');
  validatePipelineRuntimeIdentifier(request.jobId, 'jobId');
  validatePipelineRuntimeIdentifier(request.variantJobId, 'variantJobId');
  let storedRun = false;
  const { outcome, state: cancelled } = await controlPipelineThroughLocalWorker(
    {
      operation: 'worker.pipeline.matrixVariant.cancel',
      params: {
        requestId: randomUUID(),
        executionId: request.executionId,
        jobId: request.jobId,
        variantJobId: request.variantJobId,
      },
    },
    async () => {
      const settled = await cancelMatrixVariantOnLocalWorker(args);
      storedRun = settled.stored;
      return settled;
    },
    'client',
    [],
  );
  if (!storedRun || outcome !== 'updated' || cancelled.status !== 'pending')
    return cancelled;

  const runtime = createMonitoredElectronExecutionRuntime(getWindow);
  try {
    const resumed = await resumePipelineExecutionFromMain({
      executionId: request.executionId,
      initiationSource: 'automation',
      getWindow,
    });
    return resumed.state;
  } catch (error) {
    const resumable = structuredClone(cancelled);
    resumable.status = 'paused';
    resumable.completed_at = undefined;
    beginExecutionPause(resumable);
    await saveExecutionState(resumable, runtime.executionsDir);
    emitExecutionEvent(getWindow, {
      executionId: resumable.id,
      type: 'execution.updated',
      state: resumable,
      timestamp: new Date().toISOString(),
    });
    throw error;
  }
}

/**
 * The local worker's side of a variant cancel: a live run cancels it in
 * place; otherwise the stored run records it (`stored`).
 */
async function cancelMatrixVariantOnLocalWorker(args: {
  request: CancelMatrixVariantRequest;
  getWindow: () => BrowserWindow | null;
}): Promise<PipelineControlSettlement & { stored: boolean }> {
  const { request, getWindow } = args;
  const active = getActiveExecutionHandle(request.executionId);
  if (active?.cancelMatrixVariant) {
    try {
      return {
        outcome: 'updated',
        stored: false,
        state: await active.cancelMatrixVariant(
          request.jobId,
          request.variantJobId,
        ),
      };
    } catch (error) {
      if (!(error instanceof MatrixExecutorInactiveError)) throw error;
      const latest = active.getState();
      if (
        ['success', 'failure', 'cancelled', 'skipped'].includes(
          latest.jobs[request.variantJobId]?.status ?? '',
        )
      ) {
        return { outcome: 'updated', stored: false, state: latest };
      }
    }
  }
  const runtime = createMonitoredElectronExecutionRuntime(getWindow);
  if (
    !tryReserveExecution(request.executionId, 'matrix-variant-cancellation')
  ) {
    throw new Error(
      encodeMatrixIpcErrorMessage(
        'matrix/running-variant-unowned',
        `Cannot cancel variant "${request.variantJobId}" while execution "${request.executionId}" is settling`,
      ),
    );
  }
  let cancelled: ExecutionState;
  try {
    const state = await loadExecutionState(
      request.executionId,
      runtime.executionsDir,
    );
    if (!state) throw new Error(`Execution "${request.executionId}" not found`);
    if (
      state.owner_pid !== undefined &&
      state.owner_pid !== process.pid &&
      !(await isKnownOrphanedExecution(state))
    ) {
      throw new Error(
        encodeMatrixIpcErrorMessage(
          'matrix/running-variant-unowned',
          `Cannot cancel variant "${request.variantJobId}" because execution "${request.executionId}" is owned by another process`,
        ),
      );
    }
    const variant = state.jobs[request.variantJobId];
    if (variant?.status === 'running') {
      throw new Error(
        encodeMatrixIpcErrorMessage(
          'matrix/running-variant-unowned',
          `Cannot cancel running variant "${request.variantJobId}" because its worker is not owned by this process`,
        ),
      );
    }
    cancelled = prepareMatrixVariantCancellation(
      structuredClone(state),
      request,
    );
    await saveExecutionState(cancelled, runtime.executionsDir);
    emitExecutionEvent(getWindow, {
      executionId: cancelled.id,
      type: 'execution.updated',
      state: cancelled,
      timestamp: new Date().toISOString(),
    });
  } finally {
    releaseExecutionReservation(
      request.executionId,
      'matrix-variant-cancellation',
    );
  }
  return { outcome: 'updated', stored: true, state: cancelled };
}

/**
 * A top-level global run works in its own scratch folder, ignoring any caller
 * cwd; every other run needs the caller's cwd.
 */
function resolveExecutionStartCwd(
  options: MainProcessExecutePipelineRequestOptions,
  executionsDir: string,
  executionId: string,
): MainProcessExecutePipelineRequestOptions & { cwd: string } {
  if (
    isTopLevelGlobalRun({
      scope: options.scope,
      parentExecutionId: undefined,
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      target: options.target,
    })
  ) {
    if (options.pipelineFilePath !== undefined)
      throw new Error(
        "Project pipelines aren't available in a run with no project",
      );
    // A run with no project resolves no project actions or pipelines, so a
    // caller's project root is dropped along with its cwd.
    const globalOptions = {
      ...options,
      cwd: getGlobalExecutionWorkspaceDir(executionsDir, executionId),
    };
    delete globalOptions.repoPath;
    return globalOptions;
  }
  if (options.cwd === undefined)
    throw new Error('Workflow unavailable (unsupported-target)');
  return { ...options, cwd: options.cwd };
}

/** Who started a run when its trusted caller recorded no initiator. */
function initiatorFromSource(
  source: UsageInitiationSource | undefined,
): PipelineExecutionInitiator {
  switch (source) {
    case 'hook':
      return { kind: 'hook' };
    case 'portal':
      return { kind: 'portal' };
    case 'app_advisor':
      return { kind: 'app_advisor' };
    case 'automation':
      // The automation service always records its own initiator; never
      // invent an automation id here.
      logMainProcessWarn(
        '[pipelines] automation run started without an initiator; recording it as user',
      );
      return { kind: 'user' };
    default:
      return { kind: 'user' };
  }
}

/** Bind caller locators to trusted workspace roots before reading pipeline content. */
async function resolvePipelineDispatchProject(
  options: MainProcessExecutePipelineRequestOptions & { cwd: string },
): Promise<string | undefined> {
  if (
    options.scope === 'global' &&
    !options.projectId &&
    !options.worktreeId &&
    (!options.target || options.target.scope === 'global')
  )
    return undefined;
  try {
    const { readAllSidebarItems } = await import('../lib/sidebar-items');
    const { getCoworkWorkspaceRootDir } = await import('../lib/paths');
    const target = options.target;
    const projectId =
      options.projectId ??
      (target?.scope === 'worktree' ? target.workspace_id : undefined);
    const worktreeId =
      options.worktreeId ??
      (target?.scope === 'worktree' ? target.worktree_id : undefined);
    if (projectId) validateId(projectId, 'projectId');
    if (worktreeId) validateId(worktreeId, 'worktreeId');
    if (
      target?.scope === 'worktree' &&
      (target.workspace_id !== projectId || target.worktree_id !== worktreeId)
    )
      throw new Error('Inconsistent target');
    const cwd = await realpath(options.cwd);
    if (
      target &&
      target.scope !== 'global' &&
      (await realpath(target.path)) !== cwd
    )
      throw new Error('Inconsistent path');
    const repoPath = options.repoPath ? await realpath(options.repoPath) : cwd;
    const projects = new Set<string>();
    for (const item of (await readAllSidebarItems()).items) {
      if (projectId && item.id !== projectId) continue;
      const roots: string[] = [];
      if (worktreeId) {
        if (
          item.type !== 'cowork' &&
          !isWorkEntryWorkspace(item.id) &&
          !item.worktrees.some((entry) => entry.id === worktreeId)
        )
          continue;
        roots.push(resolveWorktreeCwd(item.id, worktreeId));
      } else {
        if (item.type === 'cowork')
          roots.push(getCoworkWorkspaceRootDir(item.id));
        if (item.externalPath) roots.push(item.externalPath);
        if (item.type === 'single-repo') roots.push(item.repoPath);
        if (item.type === 'multi-repo') {
          if (item.sourceRepoPath) roots.push(item.sourceRepoPath);
          roots.push(...item.repos.map((repo) => repo.repoPath));
        }
        if (item.type !== 'cowork')
          roots.push(
            ...item.worktrees.map((entry) =>
              resolveWorktreeCwd(item.id, entry.id),
            ),
          );
      }
      for (const root of roots) {
        const canonicalRoot = await realpath(root).catch(() => undefined);
        if (
          canonicalRoot &&
          isPathInside(canonicalRoot, cwd) &&
          isPathInside(canonicalRoot, repoPath)
        )
          projects.add(item.id);
      }
    }
    if (projects.size !== 1) throw new Error('Unresolved target');
    return Array.from(projects)[0];
  } catch {
    throw new Error('Workflow unavailable (unsupported-target)');
  }
}

async function startPipelineExecutionFromMainInternal(args: {
  pipeline: Pipeline;
  options: MainProcessExecutePipelineRequestOptions;
  getWindow: () => BrowserWindow | null;
  onEvent?: ExecutionOptions['onEvent'];
  onStepOutput?: ExecutionOptions['onStepOutput'];
  executionReservationClaimed?: boolean;
}): Promise<PipelineExecutionStartResult> {
  let releaseResourceGuard: (() => void) | null = null;
  const executionId = args.options.executionId ?? createPipelineExecutionId();
  let releaseStartReservation = false;
  try {
    if (args.executionReservationClaimed) {
      if (!isExecutionReservedBy(executionId, 'pipeline-start')) {
        throw new Error(`Execution "${executionId}" is already running`);
      }
      releaseStartReservation = true;
    } else {
      if (!tryReserveExecution(executionId)) {
        throw new Error(`Execution "${executionId}" is already running`);
      }
      releaseStartReservation = true;
    }

    // Split PR lockdown: refuse a worktree-scoped pipeline start while a split
    // is in progress for that worktree. Non-worktree scopes and executions
    // without a resolved worktree target are unaffected.
    if (
      args.options.scope === 'worktree' &&
      args.options.projectId &&
      args.options.worktreeId
    ) {
      assertNotSplitLocked(
        args.options.projectId,
        args.options.worktreeId,
        'running a workflow',
      );
    }

    const resourceGuard =
      getResourceMonitorService().reservePipelineExecutionStart();
    releaseResourceGuard = (): void => resourceGuard.release();

    const runtime = createMonitoredElectronExecutionRuntime(args.getWindow);
    const options = resolveExecutionStartCwd(
      args.options,
      runtime.executionsDir,
      executionId,
    );
    const {
      pipelineFilePath,
      sharedPipeline,
      automationPipelinePackage,
      requestedOwner,
      ...executionOptions
    } = options;
    const resourceContextSnapshot = pipelineResourceContextEnabled()
      ? await pipelineContextSnapshot()
      : undefined;
    const capturedExecutionContext = backgroundExecutionContextEnabled()
      ? await captureBackgroundExecutionContext()
      : undefined;
    const capturedContext = capturedExecutionContext
      ? parseWorkspaceContext(capturedExecutionContext)
      : null;
    const foregroundSource =
      executionOptions.initiationSource === undefined ||
      executionOptions.initiationSource === 'user' ||
      executionOptions.initiationSource === 'app_advisor' ||
      executionOptions.initiationSource === 'portal';
    const foregroundOrgDispatch =
      capturedContext?.kind === 'organization' && foregroundSource;
    const topLevelGlobal = isTopLevelGlobalRun({
      scope: options.scope,
      parentExecutionId: undefined,
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      target: options.target,
    });
    // A person's global run takes a saved or chosen owner, never the
    // selected organization.
    const personGlobalStart = topLevelGlobal && isPersonStart(options);
    // An automation with no project has no dispatch gate that knows its
    // folder; its final authorization runs here once that folder exists.
    const globalAutomationRun =
      topLevelGlobal &&
      executionOptions.initiationSource === 'automation' &&
      !sharedPipeline &&
      backgroundExecutionContextEnabled();
    const targetProjectId = pipelineResourceContextEnabled()
      ? await resolvePipelineDispatchProject(options)
      : options.projectId;
    let executionResource: ResourceContextInput['resource'] | undefined;
    const storedPipelineId =
      pipelineResourceContextEnabled() &&
      args.options.pipelineId &&
      !sharedPipeline &&
      !pipelineFilePath
        ? args.options.pipelineId
        : undefined;
    const storedCurated =
      (executionOptions.pipelinePreferenceLocator?.type === 'stored' &&
        executionOptions.pipelinePreferenceLocator.source === 'curated') ||
      storedPipelineId?.startsWith('curated:') === true;
    // A global run's definition is authorized against its owner once that is
    // resolved below, never the selected navigation context.
    if (storedPipelineId !== undefined && !topLevelGlobal) {
      await assertStoredPipelineContext(storedPipelineId, targetProjectId);
      if (foregroundOrgDispatch && !storedCurated)
        executionResource = await readStoredPipelineContext(storedPipelineId);
    }
    let pipelineContent = args.pipeline;
    let authorizedPipeline = args.pipeline;
    let pipelineFileDir: string | undefined;
    let pipelinePreferenceLocator =
      executionOptions.pipelinePreferenceLocator ??
      (pipelineFilePath
        ? { type: 'file' as const, value: path.resolve(pipelineFilePath) }
        : undefined);
    let projectPipelineSourcePath: string | undefined;
    let curatedPipelineSource: ExecutionOptions['curatedPipelineSource'];
    let curatedPipelinePackage: ExecutionOptions['pipelinePackage'];
    let sharedPipelineSource: SharedPipelineExecutionSource | undefined;
    let sharedPipelinePackage: ExecutionOptions['pipelinePackage'];

    const curatedId =
      pipelinePreferenceLocator?.type === 'stored' &&
      pipelinePreferenceLocator.source === 'curated'
        ? pipelinePreferenceLocator.value
        : executionOptions.pipelineId.startsWith('curated:')
          ? executionOptions.pipelineId
          : undefined;
    if (curatedId) {
      // A curated run executes the revision core reads and validates, with
      // the package that same read installed, never the caller's copy.
      const admitted = await admitCuratedRunDefinition(curatedId);
      const managed = admitted.managed;
      if (
        pipelinePreferenceLocator?.type === 'stored' &&
        pipelinePreferenceLocator.source === 'curated' &&
        pipelinePreferenceLocator.contentHash !== undefined &&
        `sha256:${pipelinePreferenceLocator.contentHash}` !==
          admitted.definition.checksum
      ) {
        throw new Error(
          'This curated workflow changed after you opened it. Reopen the launch dialog to review its updated inputs and try again.',
        );
      }
      if (
        managed.info.curatedKey &&
        managed.info.curatedContentHash &&
        managed.info.curatedRevision &&
        managed.info.filePath
      ) {
        curatedPipelineSource = {
          key: managed.info.curatedKey,
          contentHash: managed.info.curatedContentHash,
          revision: managed.info.curatedRevision,
          cachedPipelinePath: managed.info.filePath,
        };
      }
      if (
        !getTriggerTypes(admitted.pipeline.on).includes(
          executionOptions.eventName ?? 'dispatch',
        )
      ) {
        throw new Error(
          'This curated workflow no longer supports the selected trigger. Reopen the launch dialog and choose another workflow.',
        );
      }
      pipelineContent = admitted.pipeline;
      curatedPipelinePackage = admitted.pipelinePackage;
      pipelineFileDir = managed.info.filePath
        ? path.dirname(managed.info.filePath)
        : undefined;
      pipelinePreferenceLocator = {
        type: 'stored',
        source: 'curated',
        value: managed.info.id,
        ...(managed.info.curatedContentHash
          ? { contentHash: managed.info.curatedContentHash }
          : {}),
      };
      executionResource = { owner: { type: 'system' } };
    }

    if (!curatedId && sharedPipeline) {
      // A global run's owner is already known here: an agent's binding, or
      // the person's choice, since a shared definition has no saved owner.
      // Its definition is authorized against that owner, not navigation.
      const globalOwner = topLevelGlobal
        ? (executionOptions.executionContext ??
          (personGlobalStart ? requestedOwner : undefined))
        : undefined;
      const sharedExecutionContext =
        executionOptions.initiationSource === 'hook' ||
        executionOptions.initiationSource === 'automation'
          ? executionOptions.executionContext
          : globalOwner;
      const cachedSharedPipeline = await cacheSharedPipelineForExecution({
        serverId: sharedPipeline.serverId,
        remoteId: sharedPipeline.remoteId,
        installPin: sharedPipeline.installPin,
        projectId: targetProjectId,
        runtime,
        executionId,
        ...(sharedExecutionContext !== undefined
          ? { executionContext: sharedExecutionContext }
          : {}),
      });
      pipelineContent = cachedSharedPipeline.pipeline;
      executionResource = { owner: cachedSharedPipeline.owner };
      if (
        (executionOptions.initiationSource === 'hook' ||
          executionOptions.initiationSource === 'automation') &&
        backgroundExecutionContextEnabled()
      ) {
        authorizedPipeline = pipelineContent;
        const authorizations: Array<
          NonNullable<ExecutionOptions['childPipelineAuthorizations']>[number]
        > = [];
        const decision = await authorizeBackgroundExecution(
          executionOptions.executionContext,
          pipelineContextResources(
            authorizedPipeline,
            cachedSharedPipeline.owner,
            {
              cwd: executionOptions.cwd,
              repoPath: executionOptions.repoPath,
              getProjectPipelinesDirCandidates,
              pipelineId: executionOptions.pipelineId,
              pipelinePreferenceLocator: buildSharedPipelinePreferenceLocator(
                sharedPipeline.serverId,
                sharedPipeline.remoteId,
              ),
              pluginCollectionPreferences:
                executionOptions.pluginCollectionPreferences,
              modelAliasPreferences: executionOptions.modelAliasPreferences,
            },
            sharedPipeline.remoteId,
          ),
          // A run with no project authorizes against no project, never an
          // empty project id.
          options.scope === 'global' && !executionOptions.projectId
            ? { scope: 'global' }
            : {
                projectId: executionOptions.projectId ?? '',
                worktreeId: executionOptions.worktreeId,
              },
          authorizations,
        );
        if (!decision.allow)
          throw new Error(
            decision.transient
              ? backgroundExecutionRetryMessage('run')
              : backgroundExecutionDeniedMessage(decision.reason, {
                  ...(decision.subject ? { subject: decision.subject } : {}),
                }),
          );
        executionOptions.childPipelineAuthorizations = authorizations;
      }

      sharedPipelineSource = cachedSharedPipeline.sharedPipelineSource;
      sharedPipelinePackage = cachedSharedPipeline.pipelinePackage;
      pipelinePreferenceLocator = buildSharedPipelinePreferenceLocator(
        sharedPipeline.serverId,
        sharedPipeline.remoteId,
      );
    }

    if (!curatedId && !sharedPipeline && pipelineFilePath) {
      if (pipelineResourceContextEnabled()) {
        const { owner, projectId } = await authorizeProjectPipelineRequest({
          id: options.pipelineId,
          cwd: options.repoPath ?? options.cwd,
          filePath: pipelineFilePath,
        });
        if (projectId !== targetProjectId)
          throw new Error('Workflow unavailable (unsupported-target)');
        executionResource = { owner };
        try {
          await assertPipelineContext({ owner }, targetProjectId);
        } catch (error) {
          // The owner is trusted here; an incompatible execution target is a context mismatch.
          if (
            error instanceof Error &&
            error.message === 'Workflow unavailable (unsupported-target)'
          )
            throw new Error('Workflow unavailable (context-mismatch)');
          throw error;
        }
      }
      const rootCwd = options.repoPath ?? options.cwd;
      const validated = await validateProjectPipelineAccess({
        id: options.pipelineId,
        cwd: rootCwd,
        filePath: pipelineFilePath,
      }).catch((error: unknown): never => {
        if (pipelineResourceContextEnabled())
          throw new Error('Workflow unavailable (unsupported-target)');
        throw error;
      });
      if (!validated.success) {
        if (pipelineResourceContextEnabled())
          throw new Error('Workflow unavailable (unsupported-target)');
        return validated;
      }

      if (pipelineResourceContextEnabled()) {
        try {
          const { projectId, worktreeId } = args.options;
          if (!projectId) throw new Error('Missing target');
          // A project-folder run has no worktree: its cwd, which its directory
          // target must name, has to stay inside the project root authorized
          // above.
          const { target } = args.options;
          const projectFolderRun =
            !worktreeId &&
            args.options.scope === 'directory' &&
            (target === undefined ||
              (target.scope === 'directory' &&
                path.resolve(target.path) === path.resolve(options.cwd)));
          if (!worktreeId && !projectFolderRun)
            throw new Error('Missing target');
          let canonicalCwd = options.cwd;
          if (worktreeId) {
            validateId(worktreeId, 'worktreeId');
            canonicalCwd = resolveWorktreeCwd(projectId, worktreeId);
          }
          if (
            !isPathInside(canonicalCwd, validated.data.rootDir) ||
            !isPathInside(validated.data.rootDir, validated.data.filePath) ||
            (projectFolderRun && !isPathInside(rootCwd, canonicalCwd))
          )
            throw new Error('Outside target');
          const [realCwd, realRoot, realFile, realProjectRoot] =
            await Promise.all([
              realpath(canonicalCwd),
              realpath(validated.data.rootDir),
              realpath(validated.data.filePath),
              realpath(rootCwd),
            ]);
          if (
            !isPathInside(realCwd, realRoot) ||
            !isPathInside(realRoot, realFile) ||
            (projectFolderRun && !isPathInside(realProjectRoot, realCwd))
          )
            throw new Error('Outside target');
        } catch {
          throw new Error('Workflow unavailable (unsupported-target)');
        }
      }

      pipelineContent = await loadProjectPipelineFromDisk(
        validated.data.filePath,
      );
      pipelineFileDir = path.dirname(validated.data.filePath);
      projectPipelineSourcePath = path.resolve(validated.data.filePath);
    }

    const runContextResources = (): ReturnType<
      typeof pipelineContextResources
    > => {
      const resources = pipelineContextResources(
        pipelineContent,
        executionResource?.owner ?? { shareScope: 'private' },
        {
          cwd: executionOptions.cwd,
          repoPath: executionOptions.repoPath,
          getProjectPipelinesDirCandidates,
          pipelineId: executionOptions.pipelineId,
          pipelineFileDir,
          pipelinePreferenceLocator,
          pluginCollectionPreferences:
            executionOptions.pluginCollectionPreferences,
          modelAliasPreferences: executionOptions.modelAliasPreferences,
        },
        sharedPipeline?.remoteId,
      );
      if (executionResource?.provenance && resources[0])
        resources[0].provenance = executionResource.provenance;
      return resources;
    };
    // Every top-level run records its owner. A foreground run with an
    // organization owner, selected or derived, is authorized against it the
    // way a background run is.
    const authorizeForegroundOrganizationRun = async (
      ownerContext: string,
    ): Promise<void> => {
      // Foreground runs may contain a run-pipeline step with its own cwd or
      // directory target. Those children are resolved at execution time; the
      // persisted org context makes every replay reauthorize them afresh.
      const topLevelResources = runContextResources().filter(
        (resource) => resource.childPipeline === undefined,
      );
      const destinationProjectId =
        executionOptions.projectId ?? targetProjectId;
      const decision = await authorizeBackgroundExecution(
        ownerContext,
        topLevelResources,
        destinationProjectId
          ? {
              projectId: destinationProjectId,
              worktreeId: executionOptions.worktreeId,
            }
          : { scope: 'global' },
      );
      if (!decision.allow)
        throw new Error(
          decision.transient
            ? backgroundExecutionRetryMessage('run')
            : backgroundExecutionDeniedMessage(decision.reason, {
                ...(decision.subject ? { subject: decision.subject } : {}),
              }),
        );
      executionOptions.allowUnverifiedForegroundChildren = true;
    };
    // The automation's owner authorizes its definition and run-pipeline
    // children in its own folder, as the dispatch gate does for a project run.
    const authorizeGlobalAutomationRun = async (
      ownerContext: string,
    ): Promise<void> => {
      const authorizations: Array<
        NonNullable<ExecutionOptions['childPipelineAuthorizations']>[number]
      > = [];
      const decision = await authorizeBackgroundExecution(
        ownerContext,
        runContextResources(),
        { scope: 'global' },
        authorizations,
      );
      if (!decision.allow)
        throw new Error(
          decision.transient
            ? backgroundExecutionRetryMessage('run')
            : backgroundExecutionDeniedMessage(decision.reason, {
                ...(decision.subject ? { subject: decision.subject } : {}),
              }),
        );
      executionOptions.childPipelineAuthorizations = authorizations;
    };
    const userPipelineId = curatedId
      ? undefined
      : localUserPipelineIdForRequest({
          pipelineId: executionOptions.pipelineId,
          pipelineFilePath,
          pipelinePreferenceLocator,
          sharedPipeline,
        });
    const ownerResult = await resolveExecutionOwnerContext({
      // A foreground dispatch in a selected organization binds to it; a
      // global run keeps its saved or chosen owner instead.
      explicit:
        executionOptions.executionContext ??
        (foregroundOrgDispatch && !topLevelGlobal
          ? capturedExecutionContext
          : undefined),
      captured: capturedExecutionContext,
      scope: executionOptions.scope,
      parentExecutionId: undefined,
      projectId: executionOptions.projectId ?? targetProjectId,
      worktreeId: executionOptions.worktreeId,
      target: executionOptions.target,
      userPipelineId,
      ...(personGlobalStart ? { person: { requestedOwner } } : {}),
    });
    if ('refusal' in ownerResult)
      throw ownerResult.code !== undefined
        ? new PipelineNowOwnedError()
        : new Error(ownerResult.refusal);
    const ownerContext = parseWorkspaceContext(ownerResult.owner);
    if (!ownerContext)
      throw new Error(backgroundExecutionDeniedMessage('unsupported-target'));
    let admittedDocument: string | undefined;
    // A stored run executes the definition core validates, never the copy
    // its caller sent; an id core doesn't know is an inline definition. Only
    // a source main has itself loaded above opts out, never a caller's
    // preference locator. A global run's definition is read for its owner,
    // any other through the navigation context its start was checked in.
    if (
      !curatedId &&
      !sharedPipeline &&
      !pipelineFilePath &&
      !executionOptions.pipelineId.startsWith('project--') &&
      !isSharedPipelineLocalId(executionOptions.pipelineId)
    ) {
      const admitted = await admitStoredRunDefinition(
        executionOptions.pipelineId,
        topLevelGlobal
          ? { owner: ownerResult.owner }
          : targetProjectId === undefined
            ? {}
            : { projectId: targetProjectId },
      );
      if (admitted) {
        pipelineContent = admitted.pipeline;
        admittedDocument = admitted.definition.document;
      }
    }
    if (storedPipelineId !== undefined && topLevelGlobal) {
      const resource = await readStoredPipelineContext(
        storedPipelineId,
        ownerResult.owner,
      );
      await assertPipelineContext(resource, undefined, ownerResult.owner);
      if (!storedCurated) executionResource = resource;
    }
    if (foregroundSource && ownerContext.kind === 'organization') {
      // The selected context is one the account is in; any other owner is
      // checked before it is trusted.
      if (
        ownerResult.owner !== capturedExecutionContext &&
        !(await accountMayRunIn(ownerContext))
      )
        throw new Error(backgroundExecutionDeniedMessage('access-removed'));
      await authorizeForegroundOrganizationRun(ownerResult.owner);
    }
    if (globalAutomationRun)
      await authorizeGlobalAutomationRun(ownerResult.owner);
    if (ownerResult.bindUserPipelineId !== undefined) {
      // A person's first choice binds a legacy unowned pipeline once the run
      // is authorized. The binding is an ownership decision, so it persists
      // even if the start later fails.
      const bindLocator = {
        type: 'stored',
        source: 'user',
        value: ownerResult.bindUserPipelineId,
      } as const;
      // Another start may have bound it while this one was authorized; the
      // saved owner is never rewritten. A store that became unreadable is
      // never written over.
      if (!isPipelineLocalMetadataReadable())
        throw new Error(backgroundExecutionDeniedMessage('unknown-provenance'));
      const boundMeanwhile = readPipelineLocalMetadata(bindLocator).owner;
      if (boundMeanwhile !== undefined && boundMeanwhile !== ownerResult.owner)
        throw new PipelineNowOwnedError();
      if (boundMeanwhile === undefined)
        recordUserPipelineOwner(
          ownerResult.bindUserPipelineId,
          ownerResult.owner,
        );
      if (readPipelineLocalMetadata(bindLocator).owner !== ownerResult.owner)
        throw new Error(backgroundExecutionDeniedMessage('unknown-provenance'));
    }
    executionOptions.executionContext = ownerResult.owner;
    const initiator =
      executionOptions.initiator ??
      initiatorFromSource(executionOptions.initiationSource);
    executionOptions.initiator = initiator;
    executionOptions.agentOrigin ??=
      (initiator.kind === 'agent' || initiator.kind === 'app_advisor'
        ? initiator.chat
        : undefined) ??
      (userPipelineId === undefined
        ? undefined
        : readPipelineLocalMetadata({
            type: 'stored',
            source: 'user',
            value: userPipelineId,
          }).agentAuthor?.chat);

    // Shared definitions are captured and authorized after fetching above. Project
    // and curated sources can reload here, so refuse any changed definition
    // before it reaches the executor with the old resource authorizations.
    if (
      (executionOptions.initiationSource === 'hook' ||
        executionOptions.initiationSource === 'automation') &&
      backgroundExecutionContextEnabled() &&
      !isDeepStrictEqual(pipelineContent, authorizedPipeline)
    ) {
      throw new Error(backgroundExecutionDeniedMessage('unknown-provenance'));
    }

    const preferences = await readPreferencesFile();
    const baseBranchEnv = await buildPipelineBaseBranchEnv({
      cwd: executionOptions.cwd,
      projectId: executionOptions.projectId,
      worktreeId: executionOptions.worktreeId,
    });
    const pipelineRuntimeEnv = await resolvePipelineRuntimeEnv(
      executionOptions.projectId,
    );
    // An installed package binds the document core admitted, so a store
    // edit after admission never pairs it with another revision.
    const pipelinePackage =
      !curatedId && !sharedPipeline && !pipelineFilePath
        ? await resolveInstalledPipelinePackageForExecution(
            executionOptions.pipelineId,
            admittedDocument,
          )
        : undefined;
    // Assets and the data dir resolve before the first step, so a missing
    // required asset fails the start with a message naming it.
    const assetResolution = await resolvePipelineAssetExecutionOptions({
      pipeline: pipelineContent,
      identity: pipelineAssetIdentity({
        userPipelineId,
        curatedId,
        sharedPipeline,
        projectPipelineSourcePath,
        pipelinePreferenceLocator,
      }),
    });
    if (!assetResolution.ok) throw new Error(assetResolution.message);
    if (resourceContextSnapshot !== undefined)
      await assertPipelineContextSnapshot(resourceContextSnapshot);
    // Core records the run and dispatches its start to the local worker.
    const handle = await startPipelineThroughLocalWorker(pipelineContent, {
      ...executionOptions,
      executionContext: ownerResult.owner,
      ...assetResolution.options,
      pipelinePreferenceLocator,
      pipelineFileDir,
      executionId,
      sharedPipelineSource,
      curatedPipelineSource,
      pipelinePackage:
        automationPipelinePackage ??
        sharedPipelinePackage ??
        curatedPipelinePackage ??
        pipelinePackage,
      agentTerminalMode: await shouldUsePipelineAgentTerminalMode(
        getEffectivePipelinesMode(preferences),
      ),
      beforeStart: (state) => {
        // Create the selected pipeline watcher in the background so dispatching
        // the run (and its modal) is not blocked waiting on watcher setup. The
        // execution state is persisted to disk before `beforeStart`, so the
        // setup can resolve the execution; it runs concurrently with the
        // pipeline and completes well before any non-trivial run finishes.
        void setupAppAdvisorPipelineWatchersForExecution({
          state,
          watcherSetups: executionOptions.appAdvisorPipelineWatchers,
          projectId: executionOptions.projectId,
          worktreeId: executionOptions.worktreeId,
        }).catch(() => undefined);
      },
      env: {
        ...pipelineRuntimeEnv.env,
        ...(await buildPipelinePreferenceEnv(preferences)),
        ...baseBranchEnv,
        ...(executionOptions.env ?? {}),
      },
      secretBindings: await buildPipelineSecretBindings({
        workspaceId: executionOptions.projectId,
      }),
      runtime,
      onEvent: args.onEvent,
      onStepOutput: args.onStepOutput,
    });
    trackExecutionWithAdvisor(
      handle,
      runtime,
      args.getWindow,
      undefined,
      executionId,
    );
    releaseStartReservation = false;
    await applyImplicitPlanApproval({
      options: args.options,
      executionId: handle.getState().id,
    });
    return {
      success: true,
      data: handle.getState(),
    };
  } catch (error) {
    return {
      success: false,
      error: formatPipelineExecutionError(error),
      ...(error instanceof SharedPipelinePinMismatchError
        ? { errorCode: 'shared_pipeline_changed' as const }
        : error instanceof PipelineNowOwnedError
          ? { errorCode: error.code }
          : {}),
    };
  } finally {
    releaseResourceGuard?.();
    if (releaseStartReservation) {
      releaseExecutionReservation(executionId);
    }
  }
}

type RerunPipelineExecutionArgs = {
  executionId: string;
  rerunExecutionId?: string;
  initiationSource?: 'user' | 'automation' | 'portal';
  getWindow: () => BrowserWindow | null;
  onEvent?: ExecutionOptions['onEvent'];
  onStepOutput?: ExecutionOptions['onStepOutput'];
};

/**
 * Start an execution over as a new one, as a recovery control; core
 * records the new execution's run.
 */
export async function rerunPipelineExecutionFromMain(
  args: RerunPipelineExecutionArgs,
): Promise<ReplayResult> {
  const { executionId } = args;
  try {
    validateId(executionId, 'executionId');
    if (args.rerunExecutionId) {
      validateId(args.rerunExecutionId, 'rerunExecutionId');
      if (args.rerunExecutionId === executionId) {
        throw new Error('rerunExecutionId must differ from executionId');
      }
    }
  } catch (error) {
    return { success: false, error: formatPipelineExecutionError(error) };
  }
  const rerunExecutionId = args.rerunExecutionId ?? randomUUID();
  return replayThroughLocalWorker(
    {
      operation: 'worker.pipeline.execution.retry',
      params: {
        requestId: randomUUID(),
        executionId,
        mode: 'from_start',
        newExecutionId: rerunExecutionId,
        ...(args.initiationSource
          ? { initiationSource: args.initiationSource }
          : {}),
      },
    },
    (secrets) => rerunOnLocalWorker({ ...args, rerunExecutionId }, secrets),
  );
}

async function rerunOnLocalWorker(
  args: RerunPipelineExecutionArgs,
  secrets: RedeemedExecutionSecrets,
): Promise<ReplayResult> {
  const { executionId, getWindow } = args;

  if (activeRerunSources.has(executionId)) {
    return {
      success: false,
      error: `Execution "${executionId}" is already being rerun`,
    };
  }

  activeRerunSources.add(executionId);
  let releaseResourceGuard: (() => void) | null = null;
  let rerunExecutionId: string | undefined;
  try {
    const resourceGuard =
      getResourceMonitorService().reservePipelineExecutionStart();
    releaseResourceGuard = (): void => resourceGuard.release();

    const { runtime, state } = await loadExecutionForReplay(
      executionId,
      createMonitoredElectronExecutionRuntime(getWindow),
    );
    return await withReplayTargetRuntimeStartReservation(state, async () => {
      // Split PR lockdown: `rerunPipelineExecution` re-executes directly via
      // the executor's internal `executeState`, bypassing the guarded
      // `startPipelineExecutionFromMain` chokepoint entirely, so the
      // worktree-scoped check must be re-applied at this seam.
      if (state.scope === 'worktree' && state.project_id && state.worktree_id) {
        assertNotSplitLocked(
          state.project_id,
          state.worktree_id,
          'starting over a workflow execution',
        );
      }
      const preferences = await readPreferencesFile();
      const cwd = await resolveStoredExecutionCwd(state);
      const baseBranchEnv = await buildReplayBaseBranchEnv(cwd, state);
      const pipelineRuntimeEnv = await resolvePipelineRuntimeEnv(
        state.project_id,
      );
      const reservedRerunExecutionId = args.rerunExecutionId ?? randomUUID();
      reserveExecution(reservedRerunExecutionId);
      rerunExecutionId = reservedRerunExecutionId;
      const authorization = await authorizePipelineReplay(state);
      const handle = await pipelineExecutorControls.rerun(executionId, {
        cwd,
        ...authorization,
        agentTerminalMode: await shouldUsePipelineAgentTerminalMode(
          getEffectivePipelinesMode(preferences),
        ),
        env: {
          ...pipelineRuntimeEnv.env,
          ...(await buildPipelinePreferenceEnv(preferences)),
          ...baseBranchEnv,
        },
        repoPath: state.repo_path,
        initiationSource: args.initiationSource,
        executionId: rerunExecutionId,
        secretEnv: Object.keys(secrets.env).length ? secrets.env : undefined,
        runtime,
        onEvent: args.onEvent,
        onStepOutput: args.onStepOutput,
      });
      trackExecutionWithAdvisor(
        handle,
        runtime,
        getWindow,
        () => {
          activeRerunSources.delete(executionId);
        },
        rerunExecutionId,
      );
      rerunExecutionId = undefined;
      return {
        success: true,
        data: handle.getState(),
      };
    });
  } catch (error) {
    activeRerunSources.delete(executionId);
    if (rerunExecutionId) {
      releaseExecutionReservation(rerunExecutionId);
    }
    return { success: false, error: formatPipelineExecutionError(error) };
  } finally {
    releaseResourceGuard?.();
  }
}

export function registerExecutionHandlers(
  getWindow: () => BrowserWindow | null,
  getAppAdvisorSurface: () => RendererSurfaceWindow | null = () => null,
): void {
  setPipelineExecutionFanOut(pipelineExecutionFanOut(getWindow));
  registerIpcHandler(
    PIPELINE_CHANNELS.EXECUTE,
    async (
      event: Pick<IpcMainInvokeEvent, 'sender'> | null | undefined,
      pipeline: Pipeline,
      options: ExecutePipelineRequestOptions & PipelineRunLocationRequest,
    ) => {
      // CAN-6187: a run with an execution target starts in the cloud, or is
      // refused; it never falls back to running on this computer.
      if (options.targetId !== undefined) {
        const { startCloudPipelineRun } = await import('./cloud-pipeline-runs');
        return startCloudPipelineRun(options);
      }
      // CAN-5086: only this app's own windows may run workflows in the
      // daemon; the remote-control bridge keeps them in process.
      const context: DaemonPipelineRouteContext = {
        localWindow:
          event !== null &&
          event !== undefined &&
          resolveRemoteBridgeSender(event.sender) === null &&
          // App Advisor's page may be a view its window hosts.
          isOwnRendererSender(event.sender, [
            getWindow(),
            getAppAdvisorSurface(),
          ]),
      };
      const { selectDaemonPipeline } = await import('./daemon-pipeline-route');
      return withDaemonPipelineRoute(selectDaemonPipeline(context), () =>
        startPipelineExecutionFromMain({
          pipeline,
          options: sanitizeRendererExecuteOptions(options),
          getWindow,
        }),
      );
    },
  );

  registerIpcHandler(PIPELINE_CHANNELS.CLOUD_RUNS_AVAILABILITY, async () => {
    const { readPipelineCloudRunsAvailability } =
      await import('./cloud-pipeline-runs');
    return readPipelineCloudRunsAvailability();
  });

  const resumeHandler =
    (
      initiationSource: 'user' | 'automation',
    ): ((
      _event: unknown,
      executionId: string,
      options: ResumePipelineOptions,
    ) => Promise<
      | { success: true; data: ExecutionState }
      | { success: false; error: string }
    >) =>
    async (
      _event: unknown,
      executionId: string,
      options: ResumePipelineOptions,
    ) => {
      try {
        validateId(executionId, 'executionId');
        const result = await resumePipelineExecutionFromMain({
          executionId,
          statusReasonIds: options.statusReasonIds,
          inputAnswers: options.inputAnswers,
          pauseResponses: options.pauseResponses,
          inputs: options.inputs,
          repoPath: options.repoPath,
          cwd: options.cwd,
          env: options.env,
          initiationSource,
          ...(initiationSource === 'automation'
            ? { persistInitiationSource: true }
            : {}),
          getWindow,
        });
        return {
          success: true,
          data: result.state,
        };
      } catch (error) {
        return { success: false, error: formatPipelineExecutionError(error) };
      }
    };
  registerIpcHandler(PIPELINE_CHANNELS.RESUME, resumeHandler('user'));
  registerIpcHandler(
    PIPELINE_CHANNELS.RESUME_AUTOMATION,
    resumeHandler('automation'),
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.RETRY_EXECUTION,
    async (_event, executionId: string) =>
      retryPipelineExecutionFromMain({ executionId, getWindow }),
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.RETRY_MATRIX_JOB,
    async (_event, request: RetryMatrixJobRequest) =>
      retryMatrixJobFromMain({ request, getWindow }),
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.RERUN_EXECUTION,
    async (_event, executionId: string) =>
      rerunPipelineExecutionFromMain({ executionId, getWindow }),
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.CANCEL_EXECUTION,
    async (_event, executionId: string) => {
      try {
        return {
          success: true,
          data: await cancelPipelineExecutionFromMain({
            executionId,
            getWindow,
          }),
        };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.CANCEL_MATRIX_VARIANT,
    async (_event, request: CancelMatrixVariantRequest) =>
      cancelMatrixVariantFromMain({ request, getWindow }),
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.CANCEL_QUEUED_EXECUTION,
    async (_event, queueId: string) => {
      try {
        validateId(queueId, 'queueId');
        const { cancelQueuedHookPipeline, listQueuedHookPipelines } =
          await import('../lib/hook-pipeline');
        const queued = listQueuedHookPipelines().some(
          (entry): boolean => entry.queueId === queueId,
        );
        const cancelled = await cancelQueuedHookPipeline(queueId);
        if (!cancelled && queued)
          throw new Error(
            'This workflow already started; stop the run itself.',
          );
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  registerIpcHandler(PIPELINE_CHANNELS.LIST_QUEUED_EXECUTIONS, async () => {
    try {
      const { listQueuedHookPipelines } = await import('../lib/hook-pipeline');
      return { success: true, data: listQueuedHookPipelines() };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  registerIpcHandler(
    PIPELINE_CHANNELS.GET_EXECUTION,
    async (_event, executionId: string) => {
      try {
        const active = getActiveExecutionHandle(executionId);
        if (active) {
          return {
            success: true,
            data: withPipelineTransientRetryState(active.getState()),
          };
        }

        const state = await loadExecutionState(
          executionId,
          createElectronExecutionRuntime().executionsDir,
        );
        return {
          success: true,
          data: state ? withPipelineTransientRetryState(state) : state,
        };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  // Worktree-scoped reads for hosted controllers (CAN-5985): the Portal
  // pipeline services, addressed by project and worktree IDs, never a host
  // path. Read-only; a missing or foreign run is the service's not-found.
  // Without a worktree, the project's default one, as `portal.pipeline.list`.
  registerIpcHandler(
    PIPELINE_CHANNELS.LIST_FOR_WORKTREE,
    async (
      _event,
      request: { projectId: string; worktreeId?: string },
    ): Promise<{ pipelines: PortalPipelineSummary[] }> => {
      const scope = worktreePipelineScope(request, { optionalWorktree: true });
      const { listPipelines } = await import('../services/pipelines-service');
      return {
        pipelines: await listPipelines({
          projectId: scope.projectId,
          ...(scope.worktreeId === undefined
            ? {}
            : { worktreeId: scope.worktreeId }),
        }),
      };
    },
  );

  // One pipeline's detail for browser controllers (CAN-5985): the read
  // `portal.pipeline.get` runs, addressed by project and optional worktree.
  registerIpcHandler(
    PIPELINE_CHANNELS.GET_FOR_WORKTREE,
    async (
      _event,
      request: { projectId: string; worktreeId?: string; pipelineId: string },
    ): Promise<PortalPipelineGetResult> => {
      const scope = worktreePipelineScope(request, { optionalWorktree: true });
      // The service validates the locator and reports a missing pipeline.
      const { getPipeline } = await import('../services/pipelines-service');
      return getPipeline({
        pipelineId: request.pipelineId,
        projectId: scope.projectId,
        ...(scope.worktreeId === undefined
          ? {}
          : { worktreeId: scope.worktreeId }),
      });
    },
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.LIST_WORKTREE_EXECUTIONS,
    async (
      _event,
      request: WorktreePipelineScope,
    ): Promise<PortalPipelineExecutionListResult> => {
      const scope = worktreePipelineScope(request);
      const { listPipelineExecutions } =
        await import('../services/pipelines-service');
      return listPipelineExecutions(scope);
    },
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.GET_WORKTREE_EXECUTION,
    async (
      _event,
      request: WorktreePipelineScope & { executionId: string },
    ): Promise<PortalPipelineRun | null> => {
      const scope = worktreePipelineScope(request);
      validateId(request.executionId, 'executionId');
      const { getPipelineExecution } =
        await import('../services/pipelines-service');
      return getPipelineExecution({
        ...scope,
        executionId: request.executionId,
      });
    },
  );

  registerIpcHandler(PIPELINE_CHANNELS.LIST_EXECUTIONS, async () => {
    try {
      return {
        success: true,
        data: await listExecutionSummaries(
          createElectronExecutionRuntime().executionsDir,
        ),
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  registerIpcHandler(
    PIPELINE_CHANNELS.RUN_ADVISOR,
    async (_event, executionId: string) => {
      if (typeof executionId !== 'string' || !executionId.trim()) {
        return { success: false, error: 'executionId is required' };
      }
      try {
        validateId(executionId, 'executionId');
        return {
          success: true,
          data: await getPipelineAdvisorService().runForExistingExecution({
            executionId,
            runtime: createElectronExecutionRuntime(),
            getWindow,
          }),
        };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.GET_ADVISOR,
    async (_event, executionId: string) => {
      if (typeof executionId !== 'string' || !executionId.trim()) {
        return { success: false, error: 'executionId is required' };
      }
      try {
        validateId(executionId, 'executionId');
        const runtime = createElectronExecutionRuntime();
        const snapshot = await readPipelineAdvisorSnapshot(
          runtime.executionsDir,
          executionId,
        );
        return {
          success: true,
          data: await hydrateAdvisorSnapshotPipelineStartedAt(
            snapshot,
            executionId,
            runtime.executionsDir,
          ),
        };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.LIST_ADVISORS,
    async (_event, executionIds?: string[]) => {
      if (
        executionIds !== undefined &&
        (!Array.isArray(executionIds) ||
          executionIds.some((id) => typeof id !== 'string' || !id.trim()))
      ) {
        return {
          success: false,
          error: 'executionIds must be an array of non-empty strings',
        };
      }
      try {
        for (const executionId of executionIds ?? []) {
          validateId(executionId, 'executionId');
        }
        const runtime = createElectronExecutionRuntime();
        const snapshots = await listPipelineAdvisorSnapshots(
          runtime.executionsDir,
          executionIds,
        );
        return {
          success: true,
          data: (
            await Promise.all(
              snapshots.map((snapshot) =>
                hydrateAdvisorSnapshotPipelineStartedAt(
                  snapshot,
                  snapshot.executionId,
                  runtime.executionsDir,
                ),
              ),
            )
          ).filter(
            (snapshot): snapshot is PipelineAdvisorSnapshot =>
              snapshot !== null,
          ),
        };
      } catch (error) {
        return { success: false, error: toErrorMessage(error) };
      }
    },
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.SET_EXECUTION_HIDDEN,
    async (_event, executionId: string, hidden: boolean) => {
      if (typeof executionId !== 'string' || !executionId) {
        return { success: false, error: 'executionId is required' };
      }
      if (typeof hidden !== 'boolean') {
        return { success: false, error: 'hidden must be a boolean' };
      }
      try {
        const state = await setExecutionHidden(
          executionId,
          hidden,
          createElectronExecutionRuntime().executionsDir,
        );
        if (!state) {
          return {
            success: false,
            error: `Execution "${executionId}" not found`,
          };
        }
        return { success: true, data: state };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.READ_REPORT_FILE,
    async (_event, executionId: string, kind: 'text' | 'json') => {
      if (!executionId) {
        return {
          success: false,
          error: 'executionId is required',
        };
      }

      if (kind !== 'text' && kind !== 'json') {
        return {
          success: false,
          error: `Invalid report kind "${String(kind)}"`,
        };
      }

      try {
        const runtime = createMonitoredElectronExecutionRuntime();
        const active = getActiveExecutionHandle(executionId);
        const state =
          active?.getState() ??
          (await loadExecutionState(executionId, runtime.executionsDir));

        if (!state) {
          return {
            success: false,
            error: `Execution "${executionId}" not found`,
          };
        }

        const filePath =
          kind === 'text'
            ? state.report_outputs?.report_file
            : state.report_outputs?.report_json_file;
        if (!filePath) {
          return {
            success: false,
            error:
              kind === 'text'
                ? 'This execution does not have a text report'
                : 'This execution does not have a JSON report',
          };
        }

        const resolvedPath = path.resolve(filePath);
        if (!isPathInsideExecutionsDir(runtime.executionsDir, resolvedPath)) {
          return { success: false, error: 'Invalid report file path' };
        }

        return {
          success: true,
          data: {
            content: await readFile(resolvedPath, 'utf8'),
            filePath: resolvedPath,
          },
        };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  registerIpcHandler(
    PIPELINE_CHANNELS.READ_STEP_LOG,
    async (
      _event,
      locator: string | StepLogLocator,
      options?: StepLogReadOptions,
    ) => {
      if (!locator) {
        return {
          success: false,
          error: 'log locator is required',
        };
      }

      const runtime = createMonitoredElectronExecutionRuntime();
      const resolvedPath =
        typeof locator === 'string'
          ? path.resolve(locator)
          : locator.logFilePath
            ? path.resolve(locator.logFilePath)
            : getStepLogFilePath(
                runtime,
                locator.executionId,
                locator.jobId,
                locator.stepId,
                locator.attempt ?? 0,
                locator.iteration ?? 1,
                locator.recovery ?? 0,
                undefined,
              );

      if (!isPathInsideExecutionsDir(runtime.executionsDir, resolvedPath)) {
        return { success: false, error: 'Invalid log file path' };
      }

      try {
        // `lines` stays the default for every existing reader; `text` adds the
        // byte-exact snapshot the log catch-up reconciliation joins against.
        const data = await readStepLogFile(resolvedPath, {
          format: options?.format === 'text' ? 'text' : 'lines',
        });
        return { success: true, data };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );
}
