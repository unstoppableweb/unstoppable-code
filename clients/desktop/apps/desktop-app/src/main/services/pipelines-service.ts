import type { CreateSharedPipelineRequest } from '../pipelines/canopy-server-client';
import { withSharedProjectDiscovery } from '../pipelines/shared-project-discovery';
import {
  isPipelineDefinitionNotFound,
  listDesktopPipelines,
  PIPELINE_DEFINITION_PORTAL_CALLER,
  pipelineSourceFailure,
  readDesktopPipeline,
} from '../canopy-runtime/pipeline-definition-dispatch';
import {
  assertStoredPipelineContext,
  filterPersonalStoredPipelines,
  filterStoredPipelineContexts,
  filterProjectPipelineContexts,
} from '../pipelines/pipeline-install-context';
import { pipelineResourceContextEnabled } from '../pipelines/resource-lanes';
import {
  PERSONAL_WORKSPACE_CONTEXT,
  serializeWorkspaceContext,
} from '@canopy/protocol/workspace-context';
import type { PipelineShareSource } from '@canopy/execution-engine/types/pipeline';
import { isThinkingLevel } from '@canopy/desktop-shared/types';
import {
  codexSpeedFastMode,
  isCodexSpeed,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import type {
  AgentModelConfig,
  PortalEntityEnvelope,
  PortalEventEnvelope,
  PortalPipelineCancelPayload,
  PortalPipelineExecutionListPayload,
  PortalPipelineExecutionListResult,
  PortalPipelineExecutionGetPayload,
  PortalPipelineGetPayload,
  PortalPipelineGetResult,
  PortalPipelineListPayload,
  PortalPipelineLogRequestPayload,
  PortalPipelineRun,
  PortalPipelineRunPayload,
  PortalPipelineRerunPayload,
  PortalPipelineResumePayload,
  PortalPipelineRetryPayload,
  PortalPipelineRunVariant,
  PortalPipelinePauseCheckpoint,
  PortalPipelineSummary,
  PortalPipelineSharePayload,
  PortalShareResult,
} from '@canopy/desktop-shared/types';
import { access, open, readFile, stat } from 'node:fs/promises';
import {
  exceedsSerializedBudget,
  measureSerializedBytes,
} from '../lib/serialized-size-budget';
import {
  hasOnlyLocalPipelineTriggers,
  pipelineSharePath,
  portablePipelineTriggerTypes,
} from '@canopy/protocol/pipelines';
import { sanitizePipelineSummaryForSync } from './sync-safe-pipeline-summary';
import { join, resolve } from 'node:path';
import {
  validateId,
  validatePipelineDefinitionLocator,
} from '../lib/validation';
import { validatePipelineRuntimeIdentifier } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { assertNotSplitLocked } from './split-lock-service';
import { PortalServiceError } from './portal-service-error';
import { buildPipelineFailureDebugPrompt } from '@canopy/desktop-shared/lib/pipelineFailureDebugPrompt';
import { isPathInside } from '../lib/path-safety';
import {
  getDataDir,
  getWorktreeDir,
  getWorkspaceWorktreeRootRepoDir,
} from '../lib/paths';
import { readAllSidebarItems } from '../lib/sidebar-items';
import {
  discoverProjectPipelines,
  discoverProjectPipelinesBounded,
  type DiscoverProjectPipelinesLimits,
  loadProjectPipelineFromDisk,
} from '../pipelines/project-pipeline-discovery';
import {
  getStoredPipeline,
  getStoredPipelinePath,
  listStoredPipelines,
} from '@canopy/execution-engine/pipelines/store';
import {
  isPathInsideExecutionsDir,
  listExecutionSummaries,
  loadExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import {
  cancelPipelineExecutionFromMain,
  startPipelineExecutionFromMain,
} from '../pipelines/pipeline-handlers';
import {
  getSharedPipeline,
  listSharedPipelines,
} from '../pipelines/canopy-server-client';
import { getSharedPackageReadinessFromDetail } from '../pipelines/pipeline-package-service';
import { getSharedPipelineSaveImpact } from '../pipelines/shared-pipeline-save-impact';
import {
  loadCanopyCloudAccountPublicState,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { authorShareRemoteIds } from '@canopy/protocol/sharing';
import {
  preserveOrganizationPublicLink,
  requirePortalShareAccountId,
  toPortalExistingShare,
} from '../lib/resource-share-context';
import type { PortalSharingExistingShare } from '@canopy/protocol/portal';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  buildSharedPipelineId,
  isAddressableSharedPipelineRemoteId,
  isSharedPipelineLocalId,
  parseSharedPipelineLocalId,
} from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import {
  isPipelinePackageRunBlocked,
  PIPELINE_PACKAGE_SETUP_REQUIRED_REMOTE_MESSAGE,
} from '@canopy/desktop-shared/pipelines/package-readiness';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { getStepLogFilePath } from '@canopy/execution-engine/node/pipelines/executor/step-runner';
import type { BrowserWindow } from 'electron';
import type {
  ExecutionState,
  ExecutionEvent,
  JobResult,
  StepOutputEvent,
  StepResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  getTriggerInputDefs,
  getTriggerTypes,
  setTriggerTypes,
  type Pipeline,
  type StepLogLocator,
} from '@canopy/execution-engine/types/pipeline';
import {
  PORTAL_EVENT_BATCH_MAX_BYTES,
  projectPortalPipelineDispatchInputs,
  projectPortalPipelineMetadata,
  worktreeScopedParentLocalId,
  type PortalPipelineChatFollowUpPreparePayload,
  type PortalPipelineContentReadPayload,
  type PortalPipelineContentReadResult,
} from '@canopy/protocol/portal';
import {
  agentTranscriptDocument,
  pipelineContentPage,
  plainLogDocument,
  reportDocument,
  type PipelineContentDocument,
} from './pipeline-content';
import { createFeatureUpsertEvent } from '../portal/portal-feature-events';
import {
  enqueuePortalEvent,
  isPortalEventSinkActive,
} from '../portal/portal-event-bus';
import { setPipelineRunObserverFactory } from '../pipelines/pipeline-run-observers';
import {
  getPipelineRunChatLinks,
  type PipelineRunChatLinksScope,
} from './pipeline-run-chat-links';
import { logMainProcessError } from '../lib/main-process-logging';
import { portalEventMaxRoutedByteLength } from '../portal/portal-outbox';
import { toPipelineDefinitionViewModelWithoutCanonicalYaml } from '@canopy/desktop-shared/pipelines/pipeline-read-detail-adapter';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import {
  canResumeExecution,
  canRetryExecution,
  canRerunExecution,
  hasRerunReplayData,
} from '@canopy/ui-shared/lib/execution-actions';
import {
  listExecutions,
  rerunExecution,
  resumeExecution,
  retryExecution,
  type WorktreeActionRuntime,
} from '../canopy-tools/worktree-actions';

function getPipelineExecutionsDir(): string {
  return join(getDataDir(), 'pipeline-executions');
}
const RUN_TAIL_MAX_BYTES = 8 * 1024;
// Reserve most of the unsplittable event budget for the run skeleton and
// envelope. Live tails use an LRU slice of the remaining eighth.
const STREAM_STEP_TAILS_MAX_BYTES = Math.floor(
  PORTAL_EVENT_BATCH_MAX_BYTES / 8,
);
const STREAM_STEP_TAILS_MAX_ENTRIES = 256;
const STREAM_STEP_TAILS_TRUNCATION_MARKER =
  '[Earlier live step output omitted to fit the transfer limit]\n';
const PORTAL_PAUSE_REQUESTS_MAX_BYTES = 64 * 1024;
const pipelineRunUpdateListeners = new Set<(run: PortalPipelineRun) => void>();
const portalPipelineMutationQueues = new Map<string, Promise<void>>();
const portalPipelineProjectionQueues = new Map<string, Promise<void>>();

function serializeKeyedOperation<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

function serializePortalPipelineMutation<T>(
  executionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return serializeKeyedOperation(
    portalPipelineMutationQueues,
    executionId,
    operation,
  );
}

function projectPortalPipelineRun(
  executionId: string,
  projection: () => Promise<PortalPipelineRun | null>,
  options: {
    portalCommandId?: string;
    onRunUpdate?: (run: PortalPipelineRun) => void;
  } = {},
): Promise<PortalPipelineRun | null> {
  return serializeKeyedOperation(
    portalPipelineProjectionQueues,
    executionId,
    async () => {
      const run = await projection();
      if (run) notifyPipelineRunUpdate(run, options);
      return run;
    },
  );
}

export function subscribePipelineRunUpdates(
  listener: (run: PortalPipelineRun) => void,
): () => void {
  pipelineRunUpdateListeners.add(listener);
  return (): void => {
    pipelineRunUpdateListeners.delete(listener);
  };
}

/**
 * Desktop-attributed chat turns for one run (CAN-3619). Every projected
 * `pipeline_run` carries them, with an explicit empty list when the run has
 * no links so clients clear removed links. On a read failure the field is
 * omitted, which clients treat as "unchanged".
 */
async function pipelineRunChatTurns(
  scope: PipelineRunChatLinksScope,
  executionId: string,
): Promise<Pick<PortalPipelineRun, 'chatTurns'>> {
  try {
    return {
      chatTurns: await getPipelineRunChatLinks().chatTurnsFor(
        scope,
        executionId,
      ),
    };
  } catch (error) {
    logMainProcessError('Pipeline run chat links unavailable', error);
    return {};
  }
}

// Re-project runs whose chat-turn links changed after a durable chat commit,
// even when the execution itself did not change. Runs from another scope or
// that no longer exist are skipped.
getPipelineRunChatLinks().subscribe((scope, executionIds) => {
  if (!isPortalEventSinkActive()) return;
  for (const executionId of executionIds) {
    void projectPortalPipelineRun(executionId, async () => {
      const state = await loadExecutionState(
        executionId,
        getPipelineExecutionsDir(),
      );
      if (
        state?.project_id !== scope.projectId ||
        state.worktree_id !== scope.worktreeId
      ) {
        return null;
      }
      return stateToPortalRun(state);
    }).catch(() => undefined);
  }
});
const STEP_TAIL_MAX_BYTES = 2 * 1024;
const STEP_TAIL_READ_BYTES = STEP_TAIL_MAX_BYTES * 2 + 4;
const STEP_TAIL_READ_CONCURRENCY = 8;
const TERMINAL_PIPELINE_STATUSES = new Set<ExecutionState['status']>([
  'success',
  'failure',
  'cancelled',
]);

interface AsyncLimit {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

function createAsyncLimit(maxConcurrency: number): AsyncLimit {
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < maxConcurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolveWaiting) => {
      waiting.push((): void => {
        active += 1;
        resolveWaiting();
      });
    });
  };

  const release = (): void => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };

  return {
    run: async <T>(operation: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}

const stepTailReadLimit = createAsyncLimit(STEP_TAIL_READ_CONCURRENCY);

interface RequestedPortalStep {
  jobId: string;
  stepId: string;
  attempt: number;
  iteration: number;
  recovery: number;
  outputTail: string;
}

function mapRunStatus(status: string): PortalPipelineRun['status'] {
  return status === 'failure' ? 'failed' : status;
}

function resolveWorkspaceId(request: {
  workspaceLocalId?: string;
  workspaceId?: string;
  projectId?: string;
}): string | undefined {
  return request.workspaceLocalId ?? request.workspaceId ?? request.projectId;
}

async function resolvePipelineDefinitionTarget(
  projectId: string,
  requestedWorktreeId?: string,
): Promise<{
  item: Awaited<ReturnType<typeof readAllSidebarItems>>['items'][number];
  worktreeId: string;
} | null> {
  const { items } = await readAllSidebarItems();
  const item = items.find((candidate) => candidate.id === projectId);
  if (!item) return null;
  const worktrees = 'worktrees' in item ? item.worktrees : [];
  if (requestedWorktreeId !== undefined) {
    // A requested worktree must belong to the workspace: the id is joined
    // into a filesystem path, so an unknown one must never be resolved.
    return worktrees.some((worktree) => worktree.id === requestedWorktreeId)
      ? { item, worktreeId: requestedWorktreeId }
      : null;
  }
  // Default to the top of the manual order. New worktrees lead it and are
  // persisted before their checkout exists, so skip one still being set up.
  const worktreeId = (
    worktrees.find((worktree) => worktree.setupPhase !== 'git-pending') ??
    worktrees[0]
  )?.id;
  return worktreeId ? { item, worktreeId } : null;
}

/**
 * Normalize a Portal run's model config. The exact Codex speed is read with
 * canonical precedence (`speed`, then `fastMode`, then the deprecated
 * top-level boolean) and preserved. Pipelines cannot run Ultra fast, so it is
 * rejected — as are an unknown speed and a boolean contradicting its speed —
 * before any receipt read, registration, or launch.
 */
function normalizePortalModelConfig(
  request: PortalPipelineRunPayload,
): AgentModelConfig | undefined {
  const requested = request.modelConfig;
  const requestedSpeed: unknown = requested?.speed;
  if (requestedSpeed !== undefined) {
    if (!isCodexSpeed(requestedSpeed)) {
      throw new PortalServiceError(
        'invalid_payload',
        'modelConfig.speed must be standard, fast, or ultrafast.',
      );
    }
    if (
      typeof requested?.fastMode === 'boolean' &&
      requested.fastMode !== codexSpeedFastMode(requestedSpeed)
    ) {
      throw new PortalServiceError(
        'invalid_payload',
        'modelConfig.fastMode must match modelConfig.speed.',
      );
    }
  }
  const speed = readCodexSpeedRecord(requested, request.codexFastModeEnabled);
  if (speed === 'ultrafast') {
    throw new PortalServiceError(
      'invalid_payload',
      'Workflows do not support Ultra fast. Choose Regular or Fast.',
    );
  }
  const modelConfig: AgentModelConfig = {};
  if (isThinkingLevel(requested?.thinkingLevel)) {
    modelConfig.thinkingLevel = requested.thinkingLevel;
  }
  if (speed !== undefined) {
    return withCodexSpeed(modelConfig, speed);
  }
  return Object.keys(modelConfig).length > 0 ? modelConfig : undefined;
}

function normalizePortalPipelineEvent(request: PortalPipelineRunPayload): {
  planId?: string;
  eventName?: 'task_ready' | 'plan_ready';
  eventData?: {
    task_ready?: { task_text?: string };
    plan_ready?: { plan_text?: string; planId?: string };
  };
} {
  if (request.eventName === undefined) {
    if (request.eventData !== undefined) {
      throw new PortalServiceError(
        'invalid_payload',
        'eventData requires an eventName.',
      );
    }
    return request.planId === undefined ? {} : { planId: request.planId };
  }
  switch (request.eventName) {
    case 'task_ready': {
      const taskText = request.eventData?.task_ready?.task_text;
      if (typeof taskText !== 'string' || !taskText.trim()) {
        throw new PortalServiceError(
          'invalid_payload',
          'task_ready requires a non-empty task_text.',
        );
      }
      if (request.planId !== undefined) {
        throw new PortalServiceError(
          'invalid_payload',
          'task_ready cannot target a plan.',
        );
      }
      return {
        eventName: 'task_ready',
        eventData: { task_ready: { task_text: taskText } },
      };
    }
    case 'plan_ready': {
      const planText = request.eventData?.plan_ready?.plan_text;
      if (typeof planText !== 'string' || !planText.trim()) {
        throw new PortalServiceError(
          'invalid_payload',
          'plan_ready requires a non-empty plan_text.',
        );
      }
      const planId = request.planId ?? request.eventData?.plan_ready?.planId;
      if (planId !== undefined) {
        validateId(planId, 'planId');
      }
      return {
        ...(planId !== undefined ? { planId } : {}),
        eventName: 'plan_ready',
        eventData: {
          plan_ready: {
            plan_text: planText,
            ...(planId !== undefined ? { planId } : {}),
          },
        },
      };
    }
    default:
      throw new PortalServiceError(
        'invalid_payload',
        'Unsupported pipeline eventName.',
      );
  }
}

async function resolvePipelineCwd(
  projectId: string,
  worktreeId: string,
  requestedCwd?: string,
): Promise<string> {
  const { items } = await readAllSidebarItems();
  const item = items.find((candidate) => candidate.id === projectId);
  const worktreeRoot =
    item?.type === 'single-repo'
      ? getWorktreeDir(projectId, worktreeId)
      : getWorkspaceWorktreeRootRepoDir(projectId, worktreeId);
  if (!requestedCwd) return worktreeRoot;

  const resolvedCwd = resolve(worktreeRoot, requestedCwd);
  if (!isPathInside(worktreeRoot, resolvedCwd)) {
    throw new PortalServiceError(
      'invalid_payload',
      'cwd must be inside the selected worktree.',
    );
  }
  return resolvedCwd;
}

interface PipelineExecutionScope {
  projectId?: string;
  worktreeId?: string;
}

function validatePipelineExecutionScope(scope: PipelineExecutionScope): void {
  try {
    if (scope.projectId) validateId(scope.projectId, 'projectId');
    if (scope.worktreeId) validateId(scope.worktreeId, 'worktreeId');
  } catch (error) {
    throw new PortalServiceError(
      'invalid_target',
      error instanceof Error ? error.message : 'Invalid pipeline target scope.',
    );
  }
}

function assertExecutionMatchesScope(
  state: ExecutionState | null | undefined,
  scope: PipelineExecutionScope,
): asserts state is ExecutionState {
  if (!state) {
    throw new PortalServiceError('not_found', 'Workflow execution not found.');
  }
  if (
    (scope.projectId && state.project_id !== scope.projectId) ||
    (scope.worktreeId && state.worktree_id !== scope.worktreeId)
  ) {
    throw new PortalServiceError('not_found', 'Workflow execution not found.');
  }
}

/** Largest serialized summary the synced pipeline document may carry. */
const STRICT_PIPELINE_SUMMARY_MAX_BYTES = 16 * 1024;

/** Bounds for unattended (inventory sync) discovery across every worktree. */
const STRICT_DISCOVERY_LIMITS: DiscoverProjectPipelinesLimits = {
  maxEntries: 5_000,
  maxFiles: 200,
  maxBytes: 4 * 1024 * 1024,
  maxSerializedBytes: 4 * 1024 * 1024,
};

export interface PipelineListTarget {
  workspaceLocalId: string;
  worktreeLocalId: string;
  cwd: string;
}

async function resolvePortalShareablePipeline(request: {
  projectId: string;
  worktreeId?: string;
  pipelineId: string;
}): Promise<{
  target: { worktreeId: string };
  pipelineInfo: Omit<PipelineInfo, 'filePath' | 'source'> & {
    filePath: string;
    source: Exclude<PipelineInfo['source'], 'shared'>;
  };
}> {
  try {
    validatePipelineDefinitionLocator(request.pipelineId, 'pipelineId');
    validateId(request.projectId, 'projectId');
    if (request.worktreeId !== undefined) {
      validateId(request.worktreeId, 'worktreeId');
    }
  } catch (error) {
    throw new PortalServiceError(
      'invalid_payload',
      error instanceof Error ? error.message : 'Invalid pipeline locator.',
    );
  }
  const target = await resolvePipelineDefinitionTarget(
    request.projectId,
    request.worktreeId,
  );
  if (!target) {
    throw new PortalServiceError('not_found', 'Workflow not found.');
  }
  const cwd = await resolvePipelineCwd(request.projectId, target.worktreeId);
  const pipelineInfo = (await discoverProjectPipelines(cwd)).find(
    (pipeline) => pipeline.id === request.pipelineId,
  );
  const filePath = pipelineInfo?.filePath;
  const source = pipelineInfo?.source;
  if (
    !pipelineInfo ||
    !filePath ||
    source === 'shared' ||
    source === undefined
  ) {
    throw new PortalServiceError('not_found', 'Workflow not found.');
  }
  return {
    target,
    pipelineInfo: { ...pipelineInfo, filePath, source },
  };
}

/** Load a local Pipeline's current Cloud audience for Portal preselection. */
export async function getPortalExistingPipelineShare(request: {
  projectId: string;
  worktreeId?: string;
  pipelineId: string;
}): Promise<PortalSharingExistingShare | null> {
  const { pipelineInfo } = await resolvePortalShareablePipeline(request);
  if (!pipelineInfo.remote) return null;
  await requirePortalShareAccountId(pipelineInfo.remote);
  const { getSharedPipeline: loadSharedPipeline } =
    await import('../pipelines/canopy-server-client');
  try {
    return toPortalExistingShare(
      await loadSharedPipeline(pipelineInfo.remote.remoteId),
      { kind: 'pipeline', itemId: pipelineInfo.remote.remoteId },
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 404
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * The checkout a worktree's project pipelines are discovered from, for a
 * sidebar item the caller has already loaded (the inventory sync iterates
 * every worktree of every item and must not reload the sidebar per
 * worktree).
 */
export function pipelineListTargetFor(
  item: Awaited<ReturnType<typeof readAllSidebarItems>>['items'][number],
  worktreeLocalId: string,
): PipelineListTarget {
  const workspaceLocalId = item.id;
  const cwd =
    item.type === 'single-repo'
      ? getWorktreeDir(workspaceLocalId, worktreeLocalId)
      : getWorkspaceWorktreeRootRepoDir(workspaceLocalId, worktreeLocalId);
  return { workspaceLocalId, worktreeLocalId, cwd };
}

async function resolvePipelineListTarget(
  request: PortalPipelineListPayload,
): Promise<PipelineListTarget | null> {
  const workspaceLocalId = resolveWorkspaceId(request);
  if (!workspaceLocalId) return null;
  const target = await resolvePipelineDefinitionTarget(
    workspaceLocalId,
    request.worktreeId,
  );
  if (!target) return null;
  return pipelineListTargetFor(target.item, target.worktreeId);
}

/**
 * The live list's local definitions, which core lists for the worktree:
 * bundled, user and the checkout's project ones, a project definition
 * shadowing a stored one with its id. A stored row keeps its file path, as
 * {@link listStoredPipelineInfos} does, since it can be shared; one whose
 * file is gone is dropped. A store or checkout that cannot be read is left
 * out rather than failing the snapshot.
 */
async function listPortalPipelineInfos(scope: {
  workspaceId: string;
  worktreeId: string;
}): Promise<PipelineInfo[]> {
  const list = (
    sources: ('bundled' | 'user' | 'project')[],
  ): Promise<PipelineInfo[]> =>
    listDesktopPipelines(
      { sources, scope },
      PIPELINE_DEFINITION_PORTAL_CALLER,
    ).then((listing) => listing.rows);
  // An unreadable store still lists the checkout's own definitions.
  const rows = await list(['bundled', 'user', 'project']).catch(() =>
    list(['project']).catch((): PipelineInfo[] => []),
  );
  const stored: PipelineInfo[] = [];
  for (const info of rows) {
    if (info.source !== 'bundled' && info.source !== 'user') continue;
    const resolved = getStoredPipelinePath(info.id);
    if (resolved.success && resolved.data)
      stored.push({ ...info, filePath: resolved.data });
  }
  return mergePortalPipelineInfos(
    stored,
    rows.filter((info) => info.source === 'project'),
  );
}

/**
 * Bundled presets and the user's own stored pipelines, which live outside any
 * worktree checkout (CAN-3019).
 *
 * `discoverProjectPipelines` only walks the checkout, so before this the portal
 * could see nothing but repo-local pipelines while the desktop modal offered
 * Bundled, Custom, and Project side by side. `filePath` is attached here
 * because {@link summarizePipelines} needs one to read a pipeline's declared
 * `plan_ready` / `task_ready` inputs, and stored index entries carry only a
 * filename. A stored entry whose file cannot be resolved is dropped rather
 * than listed without its inputs.
 *
 * Shared/org pipelines are not here because they are not in the local store at
 * all; they come from Canopy Cloud and are appended separately by
 * {@link listSharedPipelineSummaries} (CAN-3021).
 */
async function listStoredPipelineInfos(options: {
  strict: boolean;
  projectId: string;
  personalOnly?: boolean;
}): Promise<PipelineInfo[]> {
  const stored = listStoredPipelines();
  if (!stored.success || !stored.data) {
    // The unattended sync turns absence into removals, so an unreadable store
    // must propagate there rather than publish an inventory that silently
    // dropped every bundled and user pipeline. The live command answers a
    // user's own request and degrades to the project pipelines instead.
    if (options.strict) {
      throw new Error(
        stored.error ?? 'Could not read the local pipeline store.',
      );
    }
    return [];
  }
  const infos: PipelineInfo[] = [];
  for (const info of stored.data) {
    const resolved = getStoredPipelinePath(info.id);
    // A single unresolvable file is dropped on both paths: it is a real,
    // specific absence (the YAML is gone), not a failure to read the store.
    if (!resolved.success || !resolved.data) continue;
    infos.push({ ...info, filePath: resolved.data });
  }
  return options.personalOnly
    ? filterPersonalStoredPipelines(infos)
    : filterStoredPipelineContexts(infos, options.projectId);
}

/**
 * Every pipeline the portal may list or run for one target: stored first, then
 * project.
 *
 * A project pipeline SHADOWS a stored one with the same id. Both lists are
 * keyed by bare id and a portal run command carries only that id, so listing
 * both would make the run ambiguous; the repo-local definition is the more
 * specific one and wins. {@link runPipeline} resolves the same way.
 */
function mergePortalPipelineInfos(
  storedInfos: PipelineInfo[],
  projectInfos: PipelineInfo[],
): PipelineInfo[] {
  const projectIds = new Set(projectInfos.map((info) => info.id));
  return [
    ...storedInfos.filter((info) => !projectIds.has(info.id)),
    ...projectInfos,
  ];
}

/**
 * Truncation past this cap is silent and intentional: the inventory document
 * is an ambient list, not a searchable browser.
 */
const SHARED_PIPELINE_LIST_LIMIT = 50;
/**
 * One inventory sync pass walks every worktree, and each one would otherwise
 * repeat the identical account-scoped cloud fetch. The memo collapses the pass
 * into a single request; the in-flight promise collapses concurrent worktrees
 * into the same one. Short enough (60s) that a pipeline shared moments ago
 * still shows up on the next pass.
 */
const SHARED_PIPELINE_LIST_TTL_MS = 60_000;

interface SharedPipelineListMemo {
  fetchedAt: number;
  rows: UnstampedSharedPipelineSummary[];
}

/**
 * A shared row before it is stamped with the target it is being listed for.
 * `createdById` and `remoteId` feed the author filter in
 * {@link listSharedPipelineSummaries} and are stripped before stamping.
 */
type UnstampedSharedPipelineSummary = Omit<
  PortalPipelineSummary,
  'workspaceLocalId' | 'worktreeLocalId'
> & {
  createdById?: string;
  /** The raw cloud id `pipelineId` wraps, so the filter never parses it. */
  remoteId: string;
};

let sharedPipelineListMemo: SharedPipelineListMemo | null = null;
let sharedPipelineListInFlight: Promise<
  UnstampedSharedPipelineSummary[]
> | null = null;
/**
 * Set when the last fetch rejected. Without it a failing cloud read repeats
 * once per worktree per sync pass: `listWorktreePipelineInventoryDocuments`
 * walks worktrees sequentially, so the in-flight dedupe settles before the
 * next worktree starts, and `requestCanopyCloudJson` retries idempotent GETs
 * up to three times with backoff. Offline or rate-limited, that turned one
 * pass into dozens of requests and tens of seconds — and the 429 case fed
 * itself. Failures are held for a shorter window than successes so recovery
 * stays quick.
 */
let sharedPipelineListFailedAt: number | null = null;
let personalSharedPipelineListMemo: SharedPipelineListMemo | null = null;
let personalSharedPipelineListInFlight: Promise<
  UnstampedSharedPipelineSummary[]
> | null = null;
let personalSharedPipelineListFailedAt: number | null = null;
let personalSharedPipelineListContextMismatch: Error | null = null;
let personalSharedPipelineListContextMismatchAt: number | null = null;

const SHARED_PIPELINE_LIST_FAILURE_TTL_MS = 10_000;

/**
 * How long the LIVE list waits on the cloud before answering without shared
 * rows. Sized well inside the portal small-RPC window so a stalled cloud costs
 * the shared rows rather than the whole worktree snapshot.
 */
const LIVE_SHARED_PIPELINE_DEADLINE_MS = 1_500;

/**
 * Bumped on every cache clear so a fetch that is already in flight cannot
 * write its result back afterwards.
 *
 * Clearing the memo is not enough on its own: the continuations below run
 * after the account has already changed, and an unconditional write would
 * repopulate the memo with the PREVIOUS account's rows for the full TTL —
 * exactly the leak {@link clearSharedPipelineListCache} exists to prevent,
 * only one step later. The rejection path matters for the same reason: a
 * failure recorded under account A would otherwise suppress account B's first
 * fetch for {@link SHARED_PIPELINE_LIST_FAILURE_TTL_MS}.
 */
let sharedPipelineListGeneration = 0;

/**
 * Drop the cross-worktree memo.
 *
 * Sign-in, sign-out, guest upgrade, and token replacement all flow through the
 * account store. A memo filled under the previous account must not survive one
 * of those writes: these rows are stamped onto every worktree inventory
 * document and uploaded under the *current* session, so a stale hit would
 * publish one account's shared pipeline names and descriptions under another's
 * identity.
 */
export function clearSharedPipelineListCache(): void {
  sharedPipelineListMemo = null;
  sharedPipelineListInFlight = null;
  sharedPipelineListFailedAt = null;
  personalSharedPipelineListMemo = null;
  personalSharedPipelineListInFlight = null;
  personalSharedPipelineListFailedAt = null;
  personalSharedPipelineListContextMismatch = null;
  personalSharedPipelineListContextMismatchAt = null;
  sharedPipelineListGeneration += 1;
}

/** Test seam: drop the cross-worktree memo so a case starts from a cold read. */
export function resetSharedPipelineListCacheForTests(): void {
  clearSharedPipelineListCache();
}

subscribeCanopyCloudAccountChanges((): void => {
  clearSharedPipelineListCache();
});

async function fetchSharedPipelineSummaries(): Promise<
  UnstampedSharedPipelineSummary[]
> {
  const response = await listSharedPipelines({
    limit: SHARED_PIPELINE_LIST_LIMIT,
    triggerType: 'plan_ready',
  });
  return (
    response.data
      // A row whose id the locator validator will later reject is an offer that
      // can never be honored: BOTH hydration (`portal.pipeline.get`) and Run
      // answer `invalid_payload` for it. Dropping it here is consistent with how
      // this list already bounds itself — truncation past the row limit is
      // silent and intentional.
      .filter((row) => isAddressableSharedPipelineRemoteId(row.id))
      .slice(0, SHARED_PIPELINE_LIST_LIMIT)
      .map((row): UnstampedSharedPipelineSummary => {
        return {
          pipelineId: buildSharedPipelineId(CANOPY_CLOUD_SERVER_ID, row.id),
          remoteId: row.id,
          createdById: row.createdBy.id,
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          // Long-standing shape: `source` is the FILENAME, and a shared
          // pipeline has no file.
          source: '',
          origin: 'shared',
          ...(row.triggerTypes
            ? { triggerTypes: portablePipelineTriggerTypes(row.triggerTypes) }
            : {}),
          scopes: row.scopes ?? ['directory'],
        };
      })
  );
}

async function fetchPersonalSharedPipelineSummaries(): Promise<
  UnstampedSharedPipelineSummary[]
> {
  const response = await listSharedPipelines(
    {
      limit: SHARED_PIPELINE_LIST_LIMIT,
      triggerType: 'plan_ready',
    },
    { personalOnly: true },
  );
  return response.data
    .filter((row) => isAddressableSharedPipelineRemoteId(row.id))
    .slice(0, SHARED_PIPELINE_LIST_LIMIT)
    .map((row) => ({
      pipelineId: buildSharedPipelineId(CANOPY_CLOUD_SERVER_ID, row.id),
      remoteId: row.id,
      createdById: row.createdBy.id,
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      source: '',
      origin: 'shared' as const,
      ...(row.triggerTypes
        ? { triggerTypes: portablePipelineTriggerTypes(row.triggerTypes) }
        : {}),
      scopes: row.scopes ?? ['directory'],
    }));
}

async function loadSharedPipelineSummaries(): Promise<
  UnstampedSharedPipelineSummary[]
> {
  if (pipelineResourceContextEnabled()) return fetchSharedPipelineSummaries();
  const now = Date.now();
  if (
    sharedPipelineListMemo &&
    now - sharedPipelineListMemo.fetchedAt < SHARED_PIPELINE_LIST_TTL_MS
  ) {
    return sharedPipelineListMemo.rows;
  }
  // A recent failure is memoized too, so one sync pass makes at most one
  // request whether or not the cloud answered. Callers treat shared rows as
  // fail-soft, so an empty list is the same degradation they already handle.
  if (
    sharedPipelineListFailedAt !== null &&
    now - sharedPipelineListFailedAt < SHARED_PIPELINE_LIST_FAILURE_TTL_MS
  ) {
    return [];
  }
  if (sharedPipelineListInFlight) return sharedPipelineListInFlight;
  // Captured BEFORE the fetch starts. Both continuations refuse to write when
  // the account changed while the request was in flight: the rows they are
  // holding belong to the account that is no longer signed in.
  const generation = sharedPipelineListGeneration;
  const operation = fetchSharedPipelineSummaries().then(
    (rows) => {
      if (generation !== sharedPipelineListGeneration) return [];
      sharedPipelineListMemo = { fetchedAt: Date.now(), rows };
      sharedPipelineListFailedAt = null;
      return rows;
    },
    (error: unknown) => {
      if (generation === sharedPipelineListGeneration) {
        sharedPipelineListFailedAt = Date.now();
      }
      throw error;
    },
  );
  sharedPipelineListInFlight = operation;
  const clearInFlight = (): void => {
    if (sharedPipelineListInFlight === operation) {
      sharedPipelineListInFlight = null;
    }
  };
  void operation.then(clearInFlight, clearInFlight);
  return operation;
}

async function loadPersonalSharedPipelineSummaries(): Promise<
  UnstampedSharedPipelineSummary[]
> {
  const now = Date.now();
  if (
    personalSharedPipelineListContextMismatch &&
    personalSharedPipelineListContextMismatchAt !== null &&
    now - personalSharedPipelineListContextMismatchAt <
      SHARED_PIPELINE_LIST_FAILURE_TTL_MS
  ) {
    throw personalSharedPipelineListContextMismatch;
  }
  personalSharedPipelineListContextMismatch = null;
  personalSharedPipelineListContextMismatchAt = null;
  if (
    personalSharedPipelineListMemo &&
    now - personalSharedPipelineListMemo.fetchedAt < SHARED_PIPELINE_LIST_TTL_MS
  ) {
    return personalSharedPipelineListMemo.rows;
  }
  if (
    personalSharedPipelineListFailedAt !== null &&
    now - personalSharedPipelineListFailedAt <
      SHARED_PIPELINE_LIST_FAILURE_TTL_MS
  ) {
    return [];
  }
  if (personalSharedPipelineListInFlight)
    return personalSharedPipelineListInFlight;
  const generation = sharedPipelineListGeneration;
  const operation = fetchPersonalSharedPipelineSummaries().then(
    (rows) => {
      if (generation !== sharedPipelineListGeneration) return [];
      personalSharedPipelineListMemo = { fetchedAt: Date.now(), rows };
      personalSharedPipelineListFailedAt = null;
      personalSharedPipelineListContextMismatch = null;
      personalSharedPipelineListContextMismatchAt = null;
      return rows;
    },
    (error: unknown) => {
      if (generation === sharedPipelineListGeneration) {
        if (
          error instanceof Error &&
          error.message.includes('context-mismatch')
        ) {
          personalSharedPipelineListContextMismatch = error;
          personalSharedPipelineListContextMismatchAt = Date.now();
          personalSharedPipelineListFailedAt = null;
        } else {
          personalSharedPipelineListFailedAt = Date.now();
        }
      }
      throw error;
    },
  );
  personalSharedPipelineListInFlight = operation;
  const clearInFlight = (): void => {
    if (personalSharedPipelineListInFlight === operation) {
      personalSharedPipelineListInFlight = null;
    }
  };
  void operation.then(clearInFlight, clearInFlight);
  return operation;
}

/**
 * Shared (Canopy Cloud) pipelines the paired desktop can see, projected as
 * portal list rows for one target (CAN-3021).
 *
 * The desktop produces these because it is the side already signed into the
 * cloud: the browser performs no access-scoped read of its own, so there is no
 * browser-vs-desktop account-identity question to answer, and a desktop that
 * predates this simply reports no shared rows.
 *
 * Only `plan_ready` pipelines are fetched — the plan picker is the single
 * surface these rows reach.
 *
 * Rows carry NO trigger inputs. A shared pipeline has no `filePath`, and the
 * cloud list row has no `rawPipeline`, so there is nothing to read them from
 * here; the picker hydrates them on select through {@link getPipeline}. Nor do
 * they carry `shareable` — an already-cloud-hosted pipeline is not re-shared.
 *
 * FAILS SOFT, always. `listPipelinesStrict` is fail-closed because the
 * unattended sync turns absence into cloud removals — but that contract is
 * about the LOCAL inventory it is publishing. A signed-out desktop, an offline
 * one, or a cloud blip must not fail the whole document and wipe every local
 * pipeline from the portal; it just means no shared rows this pass.
 *
 * The viewer's own share that exactly one of `localPipelines` links to is
 * dropped: the author sees one row for what they shared, the local one, which
 * carries `shareRemoteId` and `shareScope` (see {@link summarizePipelines}).
 * Pass only the local rows the list publishes (see
 * {@link publishedLocalPipelines}), so a share never folds into a row the
 * author cannot see. The filter runs after the memo so it always reads current
 * local links.
 */
async function listSharedPipelineSummaries(
  target: PipelineListTarget,
  localPipelines: readonly PipelineInfo[],
  options: { deadlineMs?: number; personalOnly?: boolean } = {},
): Promise<PortalPipelineSummary[]> {
  // The author filter's account read rides the same deadline as the fetch.
  const load = (
    options.personalOnly
      ? loadPersonalSharedPipelineSummaries()
      : loadSharedPipelineSummaries()
  )
    .catch((error: unknown): UnstampedSharedPipelineSummary[] => {
      if (
        options.personalOnly &&
        error instanceof Error &&
        error.message.includes('context-mismatch')
      ) {
        throw error;
      }
      return [];
    })
    .then((rows) => withoutAuthorLinkedShares(rows, localPipelines));
  const visible =
    options.deadlineMs === undefined
      ? await load
      : await raceSharedPipelineDeadline(load, options.deadlineMs);
  return visible.map((unstamped) => {
    const {
      createdById: _createdById,
      remoteId: _remoteId,
      ...row
    } = unstamped;
    void _createdById;
    void _remoteId;
    return {
      ...row,
      workspaceLocalId: target.workspaceLocalId,
      worktreeLocalId: target.worktreeLocalId,
    };
  });
}

/**
 * Drop shares the signed-in account created that one listed local pipeline
 * links to. A signed-out desktop, or an account read that fails, folds
 * nothing; the list never fails for it.
 */
async function withoutAuthorLinkedShares(
  rows: UnstampedSharedPipelineSummary[],
  localPipelines: readonly PipelineInfo[],
): Promise<UnstampedSharedPipelineSummary[]> {
  if (rows.length === 0) return rows;
  let viewerId: string | undefined;
  try {
    const state = await loadCanopyCloudAccountPublicState();
    viewerId =
      state.hasApiKey === true && state.account ? state.account.id : undefined;
  } catch {
    return rows;
  }
  if (!viewerId) return rows;
  const authorIds = authorShareRemoteIds(localPipelines, viewerId);
  if (authorIds.size === 0) return rows;
  return rows.filter(
    (row) => !(row.createdById === viewerId && authorIds.has(row.remoteId)),
  );
}

/**
 * The local pipelines a list publishes as pipeline rows: the summary was
 * produced (and kept, for a budgeted list) and is not folded under its
 * automation.
 */
function publishedLocalPipelines(
  pipelines: readonly PipelineInfo[],
  published: readonly (PortalPipelineSummary | null)[],
): PipelineInfo[] {
  const ids = new Set<string>();
  for (const summary of published) {
    if (summary && !summary.ownedByAutomation) ids.add(summary.pipelineId);
  }
  return pipelines.filter((pipeline) => ids.has(pipeline.id));
}

/**
 * Resolve to no shared rows once `deadlineMs` elapses, leaving the underlying
 * fetch running so it still populates the memo for the next pass.
 *
 * The live list backs the portal worktree snapshot, which answers a small RPC
 * with a single-digit-second budget. `requestCanopyCloudJson` retries
 * idempotent GETs, so a blackholing cloud can hold its own promise for tens of
 * seconds — long enough that the browser loses the ENTIRE worktree view rather
 * than just the shared rows. Failing soft protects correctness but not
 * latency; this bounds it. The background sync (`listPipelinesStrict`) passes
 * no deadline: it is unattended and would rather wait than publish a document
 * missing rows the cloud would have returned.
 */
async function raceSharedPipelineDeadline(
  load: Promise<UnstampedSharedPipelineSummary[]>,
  deadlineMs: number,
): Promise<UnstampedSharedPipelineSummary[]> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<UnstampedSharedPipelineSummary[]>((resolve) => {
    timer = setTimeout((): void => resolve([]), deadlineMs);
    // Never hold the event loop open for a list that already failed soft.
    timer.unref?.();
  });
  try {
    return await Promise.race([load, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The live portal list: lenient, a discovery failure reads as empty. */
export async function listPipelines(
  request: PortalPipelineListPayload = {},
): Promise<PortalPipelineSummary[]> {
  if (request.worktreeId !== undefined) {
    try {
      validateId(request.worktreeId, 'worktreeId');
    } catch (error) {
      throw new PortalServiceError(
        'invalid_payload',
        error instanceof Error ? error.message : 'Invalid worktreeId.',
      );
    }
  }
  const target = await resolvePipelineListTarget(request);
  if (!target) return [];
  const scope = {
    workspaceId: target.workspaceLocalId,
    worktreeId: target.worktreeLocalId,
  };
  // One checkout discovery serves the listing and every row's read.
  let infos: PipelineInfo[] = [];
  const summaries = await withSharedProjectDiscovery(async () => {
    infos = await listPortalPipelineInfos(scope);
    return summarizePipelines(target, infos, {
      loadDefinition: (pipeline) =>
        readDesktopPipeline(
          pipeline.id,
          scope,
          PIPELINE_DEFINITION_PORTAL_CALLER,
        ).then(
          (data) => data.content,
          (): null => null,
        ),
    });
  });
  return [
    ...summaries.filter((summary) => summary !== null),
    // Appended last so a prefix-cut for the result budget drops shared rows
    // before it drops a local pipeline (CAN-3021). Deadline-bounded because
    // this list backs the portal worktree snapshot: see
    // `raceSharedPipelineDeadline`.
    ...(await listSharedPipelineSummaries(
      target,
      publishedLocalPipelines(infos, summaries),
      {
        deadlineMs: LIVE_SHARED_PIPELINE_DEADLINE_MS,
      },
    )),
  ];
}

export interface StrictPipelineList {
  pipelines: PortalPipelineSummary[];
  /** True when a discovery bound skipped files; see the discovery limits. */
  truncated: boolean;
}

/**
 * The cloud inventory sync's list for one already-resolved target (see
 * {@link pipelineListTargetFor}): a discovery failure or a missing or
 * unreadable worktree checkout propagates instead of reading as an empty
 * inventory, because the sync turns absence into removals; discovery is
 * bounded (entries, files, bytes) and contained to the checkout because it
 * runs unattended across every worktree, and reports when a bound cut it.
 */
export async function listPipelinesStrict(
  target: PipelineListTarget,
): Promise<StrictPipelineList> {
  // An absent or unreadable checkout must surface as a failure: discovery
  // itself treats missing pipeline directories as an empty result, which
  // is only legitimate beneath a root that exists.
  await access(target.cwd);
  const discovered = await discoverProjectPipelinesBounded(
    target.cwd,
    STRICT_DISCOVERY_LIMITS,
  );
  // Bundled and user pipelines join the synced inventory too (CAN-3019), so
  // the web reads the same list the live command answers. They are not
  // repository-controlled and so are not subject to the discovery bounds
  // above, but every summary still passes the same redaction and size budget
  // below.
  const merged = mergePortalPipelineInfos(
    await listStoredPipelineInfos({
      strict: true,
      projectId: target.workspaceLocalId,
      personalOnly: true,
    }),
    await filterProjectPipelineContexts(
      discovered.pipelines,
      target.cwd,
      target.workspaceLocalId,
      serializeWorkspaceContext(PERSONAL_WORKSPACE_CONTEXT),
    ),
  );
  // Every summary (trigger inputs included) comes from repository-controlled
  // YAML whose aliases js-yaml keeps as shared references. The definition is
  // bounded before its inputs are projected (the projection copies), and
  // the finished summary is bounded again; both checks stop at the budget
  // instead of expanding the aliases, and a drop is reported as truncation.
  const summaries = await summarizePipelines(target, merged, {
    definitionBudget: {
      remainingBytes: STRICT_DISCOVERY_LIMITS.maxSerializedBytes,
    },
  });
  const pipelines: PortalPipelineSummary[] = [];
  for (const summary of summaries) {
    if (
      summary &&
      !exceedsSerializedBudget(summary, STRICT_PIPELINE_SUMMARY_MAX_BYTES)
    ) {
      // Durable cloud storage, built unattended from repository-controlled
      // YAML: credential-like input defaults, options and descriptions
      // never leave the machine.
      pipelines.push(sanitizePipelineSummaryForSync(summary));
    }
  }
  // Shared/cloud rows join the same document (CAN-3021), appended AFTER every
  // local row: `fitPipelineListResult` prefix-cuts, so the tail is what a byte
  // budget drops first and a shared row can never evict a local pipeline.
  // They are fetched fail-soft, so a signed-out or offline desktop publishes
  // the local inventory unchanged instead of failing the pass.
  const shared = await listSharedPipelineSummaries(
    target,
    publishedLocalPipelines(merged, pipelines),
    { personalOnly: true },
  );
  const localPipelineCount = pipelines.length;
  for (const summary of shared) {
    if (!exceedsSerializedBudget(summary, STRICT_PIPELINE_SUMMARY_MAX_BYTES)) {
      pipelines.push(sanitizePipelineSummaryForSync(summary));
    }
  }
  return {
    pipelines,
    // Scoped to the LOCAL inventory. `truncated` is what the web Plugins page
    // renders as "some of this workspace's pipelines were left out" — and that
    // page does not show shared rows at all, so a dropped shared row (one
    // oversized cloud-authored description is enough) would raise a warning
    // about pipelines the reader cannot see and cannot act on. The shared list
    // is already silently bounded at SHARED_PIPELINE_LIST_LIMIT and fails soft
    // besides, so it has no truncation contract to report here.
    truncated: discovered.truncated || localPipelineCount < summaries.length,
  };
}

/**
 * Whether the desktop can share this pipeline. It needs YAML on disk to
 * publish; a pipeline whose source is already Cloud-hosted is not re-shared.
 */
function canSharePortalPipeline(pipeline: PipelineInfo): boolean {
  return pipeline.source !== 'shared' && Boolean(pipeline.filePath);
}

/**
 * The user pipelines live automations own (CAN-4551), which the Portal folds
 * into their automations. A failed read folds nothing; the list still loads.
 */
async function ownedByAutomations(): Promise<ReadonlySet<string>> {
  try {
    const { automationOwnedPipelineIds } =
      await import('../automations/owned-pipeline');
    return await automationOwnedPipelineIds();
  } catch {
    return new Set();
  }
}

async function summarizePipelines(
  { workspaceLocalId, worktreeLocalId }: PipelineListTarget,
  pipelines: PipelineInfo[],
  options: {
    /**
     * Unattended callers only: one serialized-size budget for every re-read
     * definition of the list, charged for the measuring work whether or not
     * a definition fit; a definition that does not fit what is left is not
     * projected at all and yields `null`.
     */
    definitionBudget?: { remainingBytes: number };
    /** Reads a listed definition; the file on disk by default. */
    loadDefinition?: (pipeline: PipelineInfo) => Promise<Pipeline | null>;
  } = {},
): Promise<(PortalPipelineSummary | null)[]> {
  const load =
    options.loadDefinition ??
    ((pipeline: PipelineInfo): Promise<Pipeline | null> =>
      pipeline.filePath
        ? loadProjectPipelineFromDisk(pipeline.filePath).catch(() => null)
        : Promise.resolve(null));
  const owned = await ownedByAutomations();
  // The Portal never sees `workflow` (CAN-5782): a pipeline that can only
  // start from the Workflows page is left out, and the others report only
  // the triggers web knows.
  return Promise.all(
    pipelines
      .filter(
        (pipeline) => !hasOnlyLocalPipelineTriggers(pipeline.triggerTypes),
      )
      .map(async (pipeline) => {
        const definition =
          pipeline.filePath &&
          (pipeline.triggerTypes?.includes('dispatch') ||
            pipeline.triggerTypes?.includes('task_ready') ||
            pipeline.triggerTypes?.includes('plan_ready'))
            ? await load(pipeline)
            : null;
        if (definition && options.definitionBudget) {
          const budget = options.definitionBudget;
          const measured = measureSerializedBytes(
            definition,
            budget.remainingBytes,
          );
          budget.remainingBytes = Math.max(
            0,
            budget.remainingBytes - measured.bytes,
          );
          if (measured.exceeded) return null;
        }
        const taskReadyInputs = definition
          ? getTriggerInputDefs(definition.on, 'task_ready')
          : undefined;
        const planReadyInputs = definition
          ? getTriggerInputDefs(definition.on, 'plan_ready')
          : undefined;
        return {
          workspaceLocalId,
          worktreeLocalId,
          pipelineId: pipeline.id,
          name: pipeline.name,
          ...(definition
            ? {
                hasRequiredInputs: Object.values(
                  getTriggerInputDefs(definition.on, 'dispatch') ?? {},
                ).some(
                  (input) =>
                    input.required === true && input.default === undefined,
                ),
              }
            : {}),
          description: pipeline.description,
          // Long-standing shape: `source` is the FILENAME. The origin the UI
          // labels and filters by rides `origin` (CAN-3019); `shared` is not
          // projected, so anything else reads as a project pipeline.
          source: pipeline.filename,
          origin:
            pipeline.source === 'bundled' || pipeline.source === 'user'
              ? pipeline.source
              : 'project',
          ...(pipeline.triggerTypes
            ? {
                triggerTypes: portablePipelineTriggerTypes(
                  pipeline.triggerTypes,
                ),
              }
            : {}),
          ...(pipeline.stepCount !== undefined
            ? { stepCount: pipeline.stepCount }
            : {}),
          scopes: pipeline.scopes ?? ['directory'],
          ...(canSharePortalPipeline(pipeline) ? { shareable: true } : {}),
          // The author-side link, so the web can fold the author's own share
          // into this row and label it with its audience.
          ...(pipeline.remote
            ? {
                shareRemoteId: pipeline.remote.remoteId,
                shareScope: pipeline.remote.shareScope,
              }
            : {}),
          ...(pipeline.source === 'user' && owned.has(pipeline.id)
            ? { ownedByAutomation: true }
            : {}),
          // `PipelineInputDef.default` is wider than the browser-safe portal
          // projection (`PortalPipelineInputDefinition` stays scalar and keeps
          // its four input types). Narrow through the protocol's own projector
          // rather than widening the external portal contract.
          ...(taskReadyInputs && Object.keys(taskReadyInputs).length > 0
            ? projectPortalPipelineMetadata({ taskReadyInputs })
            : {}),
          ...(planReadyInputs && Object.keys(planReadyInputs).length > 0
            ? projectPortalPipelineMetadata({ planReadyInputs })
            : {}),
        };
      }),
  );
}

/**
 * A `shared:` locator this desktop can actually resolve, or `null`.
 *
 * Canopy Cloud is the only shared-pipeline server the desktop talks to, so an
 * id naming any other server is treated as "not a shared pipeline" and falls
 * through to the ordinary not-found path rather than being fetched.
 */
function parseCanopyCloudPipelineId(
  pipelineId: string,
): { serverId: string; remoteId: string } | null {
  if (!isSharedPipelineLocalId(pipelineId)) return null;
  const parsed = parseSharedPipelineLocalId(pipelineId);
  if (!parsed || parsed.serverId !== CANOPY_CLOUD_SERVER_ID) return null;
  return parsed;
}

/**
 * Resolves a non-shared pipeline the way `listPipelines` merges: a repo-local
 * pipeline shadows a stored (bundled or user) one sharing its id (CAN-3019).
 * `get` and `run` share it so the form a client loads is always for the
 * pipeline that Run would start (CAN-3174).
 */
async function resolveLocalPipeline(
  cwd: string,
  pipelineId: string,
): Promise<{ pipeline: Pipeline; pipelineInfo: PipelineInfo | undefined }> {
  const pipelineInfo = (await discoverProjectPipelines(cwd)).find(
    (candidate) => candidate.id === pipelineId,
  );
  if (pipelineInfo?.filePath) {
    return {
      pipeline: await loadProjectPipelineFromDisk(pipelineInfo.filePath),
      pipelineInfo,
    };
  }
  await assertStoredPipelineContext(pipelineId);
  const stored = getStoredPipeline(pipelineId);
  if (!stored.success || !stored.data?.content) {
    throw new PortalServiceError('not_found', 'Workflow not found.');
  }
  return { pipeline: stored.data.content, pipelineInfo };
}

export async function getPipeline(
  request: PortalPipelineGetPayload,
): Promise<PortalPipelineGetResult> {
  try {
    validatePipelineDefinitionLocator(request.pipelineId, 'pipelineId');
    validateId(request.projectId, 'projectId');
    if (request.worktreeId !== undefined) {
      validateId(request.worktreeId, 'worktreeId');
    }
  } catch (error) {
    throw new PortalServiceError(
      'invalid_payload',
      error instanceof Error ? error.message : 'Invalid pipeline locator.',
    );
  }
  // A shared/cloud pipeline has no file to discover, so it resolves before the
  // checkout walk. This is also the plan picker's hydrate-on-select path
  // (CAN-3021): the list row carries no trigger inputs, and this is where they
  // come from.
  const sharedRef = parseCanopyCloudPipelineId(request.pipelineId);
  if (sharedRef) {
    const pipeline = await readDesktopPipeline(
      request.pipelineId,
      { workspaceId: request.projectId },
      PIPELINE_DEFINITION_PORTAL_CALLER,
    ).then(
      (data) => data.content,
      (): null => null,
    );
    if (!pipeline) {
      throw new PortalServiceError('not_found', 'Workflow not found.');
    }
    // Same `plan_ready` scoping `runPipeline` enforces. This path exists only
    // to hydrate a plan-picker row, and only `plan_ready` shares are ever
    // listed — so without it a bare `portal.pipeline.get` would read back the
    // full definition of ANY cloud pipeline the desktop's account can see,
    // including ones no surface ever offered.
    if (!getTriggerTypes(pipeline.on).includes('plan_ready')) {
      throw new PortalServiceError('not_found', 'Workflow not found.');
    }
    const planReadyInputs = getTriggerInputDefs(pipeline.on, 'plan_ready');
    return {
      definition: toPipelineDefinitionViewModelWithoutCanonicalYaml(pipeline),
      // `PipelineInputDef.default` is wider than the browser-safe portal
      // projection; narrow through the protocol's own projector rather than
      // widening the external contract.
      ...(planReadyInputs && Object.keys(planReadyInputs).length > 0
        ? projectPortalPipelineMetadata({ planReadyInputs })
        : {}),
    };
  }
  const target = await resolvePipelineDefinitionTarget(
    request.projectId,
    request.worktreeId,
  );
  if (!target) {
    throw new PortalServiceError('not_found', 'Workflow not found.');
  }
  let pipeline: Pipeline;
  try {
    pipeline = (
      await readDesktopPipeline(
        request.pipelineId,
        { workspaceId: request.projectId, worktreeId: target.worktreeId },
        PIPELINE_DEFINITION_PORTAL_CALLER,
      )
    ).content;
  } catch (error) {
    if (isPipelineDefinitionNotFound(error))
      throw new PortalServiceError('not_found', 'Workflow not found.');
    throw pipelineSourceFailure(error);
  }
  // The Portal never sees `workflow` (CAN-5782): a pipeline that starts only
  // from the Workflows page reads as missing, as it is missing from the list,
  // and a mixed one is described by its portable triggers.
  const triggerTypes = getTriggerTypes(pipeline.on);
  if (hasOnlyLocalPipelineTriggers(triggerTypes)) {
    throw new PortalServiceError('not_found', 'Workflow not found.');
  }
  const portalPipeline: Pipeline = {
    ...pipeline,
    on: setTriggerTypes(
      pipeline.on,
      portablePipelineTriggerTypes(triggerTypes),
    ),
  };
  return {
    definition:
      toPipelineDefinitionViewModelWithoutCanonicalYaml(portalPipeline),
    // Dispatch inputs ride `get` rather than every list row so the worktree
    // snapshot never re-reads every pipeline's YAML (CAN-3174).
    ...(getTriggerTypes(pipeline.on).includes('dispatch')
      ? projectPortalPipelineDispatchInputs(
          getTriggerInputDefs(pipeline.on, 'dispatch'),
        )
      : {}),
  };
}

export async function listPipelineRuns(
  request: PortalPipelineListPayload & {
    workspaceLocalId?: string;
    workspaceId?: string;
    worktreeLocalId?: string;
  } = {},
): Promise<PortalPipelineRun[]> {
  const workspaceLocalId = resolveWorkspaceId(request);
  const worktreeLocalId = request.worktreeLocalId ?? request.worktreeId;
  if (!workspaceLocalId || !worktreeLocalId) return [];
  const summaries = await listExecutionSummaries(getPipelineExecutionsDir());
  const selected = summaries
    .filter(
      (summary) =>
        summary.project_id === workspaceLocalId &&
        summary.worktree_id === worktreeLocalId,
    )
    .slice(0, request.limit ?? 20);
  const runs = await Promise.all(
    selected.map(async (summary) => {
      const state = await loadExecutionState(
        summary.id,
        getPipelineExecutionsDir(),
      ).catch(() => null);
      return state
        ? stateToPortalRun(state)
        : {
            localId: summary.id,
            runId: summary.id,
            pipelineId: summary.pipeline_id,
            pipelineName: summary.pipeline_name,
            workspaceLocalId,
            worktreeLocalId,
            status: mapRunStatus(summary.status),
            startedAt: summary.started_at,
            finishedAt: summary.completed_at,
            parentExecutionId: summary.parent_execution_id,
            hidden: summary.hidden,
            ...(await pipelineRunChatTurns(
              { projectId: workspaceLocalId, worktreeId: worktreeLocalId },
              summary.id,
            )),
          };
    }),
  );
  return runs.flatMap((run) => (run ? [run] : []));
}

export async function runPipeline(
  request: PortalPipelineRunPayload,
  options: {
    portalCommandId?: string;
    onRunUpdate?: (run: PortalPipelineRun) => void;
  } = {},
): Promise<{ executionId: string }> {
  try {
    validatePipelineDefinitionLocator(request.pipelineId, 'pipelineId');
  } catch (error) {
    // A readable `invalid_payload` is the downgrade story (CAN-3021): a synced
    // document that still offers a shared row to a desktop which no longer
    // understands `shared:` ids fails here, inline in the picker, instead of
    // degrading to an opaque `execution_failed`.
    throw new PortalServiceError(
      'invalid_payload',
      error instanceof Error ? error.message : 'Invalid pipeline locator.',
    );
  }
  const portalModelConfig = normalizePortalModelConfig(request);
  const portalEvent = normalizePortalPipelineEvent(request);
  if (!request.projectId || !request.worktreeId) {
    throw new PortalServiceError(
      'invalid_payload',
      'projectId and worktreeId are required.',
    );
  }
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  // CAN-6187: a run located elsewhere never runs on this computer.
  if (request.targetId !== undefined) {
    const { portalRunLocationRefusal } =
      await import('../pipelines/cloud-pipeline-runs');
    throw new PortalServiceError(
      'invalid_payload',
      portalRunLocationRefusal(String(request.targetId)),
    );
  }
  if (options.portalCommandId) {
    validateId(options.portalCommandId, 'portalCommandId');
    const receipt = await loadExecutionState(
      options.portalCommandId,
      getPipelineExecutionsDir(),
    );
    if (receipt) {
      assertExecutionMatchesScope(receipt, request);
      if (receipt.pipeline_id !== request.pipelineId) {
        throw new PortalServiceError(
          'not_found',
          'Pipeline execution receipt does not match this command.',
        );
      }
      await projectPortalPipelineRun(
        receipt.id,
        () => stateToPortalRun(receipt),
        options,
      );
      return { executionId: receipt.id };
    }
  }
  assertNotSplitLocked(
    request.projectId,
    request.worktreeId,
    'running a workflow',
  );
  const cwd = await resolvePipelineCwd(
    request.projectId,
    request.worktreeId,
    request.cwd,
  );
  // A shared/cloud pipeline is neither in the checkout nor in the local store,
  // so it resolves entirely ahead of the local lookup (CAN-3021).
  const sharedRef = parseCanopyCloudPipelineId(request.pipelineId);
  let pipelineInfo: PipelineInfo | undefined;
  let pipeline: Pipeline | undefined;
  if (sharedRef) {
    // Fetched once and reused: the trigger-type gate below needs the YAML, and
    // `distributionMode` decides whether local package readiness is even
    // relevant. The executor refetches the cloud YAML and REPLACES this
    // content, so it is never what runs.
    const detail = await getSharedPipeline(sharedRef.remoteId).catch(
      () => null,
    );
    if (!detail) {
      throw new PortalServiceError('not_found', 'Workflow not found.');
    }
    // Readiness is gated here rather than projected onto every list row: a
    // package-backed shared pipeline whose requirements are not installed
    // locally must refuse BEFORE anything starts, but probing all 50 rows on
    // every worktree of every sync pass is not affordable.
    //
    // Only `package` shares can be blocked. `getPackageReadiness` reports
    // `status: 'invalid'` for every non-package share, and `definition_only`
    // is the ordinary share mode — the default whenever packaging is
    // unsupported. Gating on readiness alone would refuse every plain shared
    // pipeline with a message naming setup that does not exist for it
    // (CAN-3021).
    if (detail.distributionMode === 'package') {
      // The detail above is handed straight to readiness. The IPC-shaped
      // `getPackageReadiness` would re-fetch the same `remoteId`, making a
      // package dispatch cost two cloud round trips before the executor's own
      // refetch.
      // Fails CLOSED. `isPipelinePackageRunBlocked(null)` is `false`, which is
      // right for the renderer — there `null` means "still probing" and the
      // modal re-renders when the answer lands. Here there is no second
      // chance: this is the terminal decision, and the whole point of the gate
      // is that an unsatisfied package share refuses BEFORE anything starts.
      // So a readiness probe that THREW is treated as "not known to be ready"
      // rather than inheriting a permissive default written for a different
      // caller.
      const readiness = await getSharedPackageReadinessFromDetail(detail).catch(
        () => null,
      );
      if (readiness === null || isPipelinePackageRunBlocked(readiness)) {
        throw new PortalServiceError(
          'invalid_payload',
          PIPELINE_PACKAGE_SETUP_REQUIRED_REMOTE_MESSAGE,
        );
      }
    }
    pipeline = parsePipelineText(detail.rawPipeline);
  } else {
    // Project first, then the stored bundled/user pipeline (CAN-3019); see
    // `resolveLocalPipeline`. `pipelineFilePath` stays absent for a stored
    // pipeline, matching what the desktop's own plan-ready run passes.
    ({ pipeline, pipelineInfo } = await resolveLocalPipeline(
      cwd,
      request.pipelineId,
    ));
  }
  if (!pipeline) {
    throw new PortalServiceError('not_found', 'Workflow not found.');
  }
  // A Portal start with no event runs as `dispatch`; the Portal never lists a
  // pipeline that can only start from the Workflows page, so refuse one sent
  // anyway. `plan_ready`- and `task_ready`-only pipelines keep starting from
  // the sidebar picker with no event, as before.
  if (
    portalEvent.eventName === undefined &&
    hasOnlyLocalPipelineTriggers(getTriggerTypes(pipeline.on))
  ) {
    throw new PortalServiceError(
      'invalid_payload',
      'This workflow can only start from the Workflows page.',
    );
  }
  if (
    portalEvent.eventName !== undefined &&
    !getTriggerTypes(pipeline.on).includes(portalEvent.eventName)
  ) {
    throw new PortalServiceError(
      'invalid_payload',
      `The selected workflow does not support ${portalEvent.eventName}.`,
    );
  }
  // A shared pipeline must additionally declare `plan_ready`, whether or not
  // an `eventName` was sent. The gate above is skipped entirely when
  // `eventName` is absent, and only `plan_ready` shares are ever listed
  // (`loadSharedPipelineSummaries` filters on it) — so without this a dispatch
  // that simply omits `eventName` could run ANY cloud pipeline the desktop's
  // account can read, including one that never appeared in any picker
  // (CAN-3021).
  if (sharedRef && !getTriggerTypes(pipeline.on).includes('plan_ready')) {
    throw new PortalServiceError(
      'invalid_payload',
      'The selected workflow does not support plan_ready.',
    );
  }
  const portalForwarder = createPortalPipelineForwarder(options);
  // Claim this execution before it starts, so the ambient observers that
  // `pipeline-handlers` attaches defer to the command-correlated forwarder.
  markPortalForwardedExecution(options.portalCommandId);
  const result = await startPipelineExecutionFromMain({
    pipeline,
    getWindow: () => null,
    options: {
      cwd,
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      scope: 'worktree',
      target: {
        scope: 'worktree',
        workspace_id: request.projectId,
        worktree_id: request.worktreeId,
        path: cwd,
        created: false,
      },
      pipelineId: request.pipelineId,
      // Exactly what the desktop's own plan-ready run passes: the shared
      // reference and no file path, so the executor refetches and caches the
      // cloud YAML itself.
      ...(sharedRef
        ? {
            sharedPipeline: {
              serverId: sharedRef.serverId,
              remoteId: sharedRef.remoteId,
            },
          }
        : {}),
      ...(pipelineInfo?.filePath
        ? { pipelineFilePath: pipelineInfo.filePath }
        : {}),
      inputs: request.inputs,
      modelConfig: portalModelConfig,
      planId: portalEvent.planId,
      eventName: portalEvent.eventName,
      eventData: portalEvent.eventData,
      initiationSource: 'portal',
      initiator: { kind: 'portal' },
      executionId: options.portalCommandId,
    },
    onEvent: portalForwarder.onEvent,
    onStepOutput: portalForwarder.onStepOutput,
  });
  if (!result.success) {
    throw new PortalServiceError('execution_failed', result.error);
  }
  await getPipelineExecution({ executionId: result.data.id }, options);
  return { executionId: result.data.id };
}

/**
 * Executions that already carry a command-correlated forwarder, from
 * {@link runPipeline} or {@link portalPipelineActionRuntime}.
 *
 * The ambient observers below are attached to EVERY execution, so without this
 * a browser-dispatched run would be projected twice per event: once with the
 * `commandId` that ties the upsert to its dispatch command, once without. The
 * duplicate is idempotent for the browser's entity cache but doubles the
 * transport cost on a long-poll connection, and each forwarder keeps its own
 * step-output tail buffers.
 *
 * Entries are removed when the execution reaches a terminal status, observed by
 * the ambient observer (which every execution has). An execution killed by an
 * app quit leaks one id until the next launch, which is bounded by the number
 * of concurrently running pipelines.
 */
const portalForwardedExecutionIds = new Set<string>();

function markPortalForwardedExecution(executionId: string | undefined): void {
  if (executionId) portalForwardedExecutionIds.add(executionId);
}

function createPortalPipelineForwarder(options: {
  portalCommandId?: string;
  onRunUpdate?: (run: PortalPipelineRun) => void;
}): {
  onEvent: (event: ExecutionEvent) => void;
  onStepOutput: (event: StepOutputEvent) => void;
} {
  type RetainedOutputTail = {
    jobId: string;
    stepId: string;
    attempt: number;
    iteration: number;
    recovery: number;
    outputTail: string;
  };
  const outputTails = new Map<string, RetainedOutputTail>();
  const outputTailBytesByExecution = new Map<string, number>();
  const outputTailCountByExecution = new Map<string, number>();
  const truncatedOutputExecutions = new Set<string>();
  const terminalExecutions = new Set<string>();
  const outputProjectionLanes = new Map<
    string,
    {
      active: boolean;
      pendingExecutionId?: string;
    }
  >();
  const stepKey = (event: StepOutputEvent): string =>
    [
      event.executionId,
      event.jobId,
      event.stepId,
      String(event.attempt),
      String(event.iteration ?? 1),
      String(event.recovery ?? 0),
    ].join('\0');
  const retainedOutputTailByteLength = (
    key: string,
    output: RetainedOutputTail,
  ): number =>
    measureSerializedBytes([key, output], STREAM_STEP_TAILS_MAX_BYTES).bytes;
  const clearExecutionTails = (executionId: string): void => {
    truncatedOutputExecutions.delete(executionId);
    outputTailBytesByExecution.delete(executionId);
    outputTailCountByExecution.delete(executionId);
    for (const key of Array.from(outputTails.keys())) {
      if (key.startsWith(`${executionId}\0`)) {
        outputTails.delete(key);
      }
    }
  };
  const requestedStepsForExecution = (
    executionId: string,
  ): RequestedPortalStep[] => {
    const requestedSteps = Array.from(outputTails.entries())
      .filter(([key]) => key.startsWith(`${executionId}\0`))
      .map(([, output]) => ({
        jobId: output.jobId,
        stepId: output.stepId,
        attempt: output.attempt,
        iteration: output.iteration,
        recovery: output.recovery,
        outputTail: output.outputTail,
      }));
    if (
      truncatedOutputExecutions.has(executionId) &&
      requestedSteps.length > 0
    ) {
      const oldestRetained = requestedSteps[0];
      const markerBytes = Buffer.byteLength(
        STREAM_STEP_TAILS_TRUNCATION_MARKER,
        'utf8',
      );
      oldestRetained.outputTail = `${STREAM_STEP_TAILS_TRUNCATION_MARKER}${trimUtf8Tail(
        oldestRetained.outputTail,
        STEP_TAIL_MAX_BYTES - markerBytes,
      )}`;
    }
    return requestedSteps;
  };
  const scheduleOutputProjection = (executionId: string): void => {
    if (terminalExecutions.has(executionId)) return;
    const lane = outputProjectionLanes.get(executionId) ?? {
      active: false,
    };
    lane.pendingExecutionId = executionId;
    outputProjectionLanes.set(executionId, lane);
    if (lane.active) return;
    lane.active = true;
    void (async (): Promise<void> => {
      try {
        while (
          lane.pendingExecutionId &&
          !terminalExecutions.has(executionId)
        ) {
          const pendingExecutionId = lane.pendingExecutionId;
          lane.pendingExecutionId = undefined;
          await projectPortalPipelineRun(
            pendingExecutionId,
            async () => {
              const state = await loadExecutionState(
                pendingExecutionId,
                getPipelineExecutionsDir(),
              );
              const requestedSteps =
                requestedStepsForExecution(pendingExecutionId);
              return stateToPortalRun(state, {
                requestedSteps,
                streamProjection: true,
              });
            },
            options,
          ).catch(() => undefined);
        }
      } finally {
        lane.active = false;
        if (!lane.pendingExecutionId || terminalExecutions.has(executionId)) {
          outputProjectionLanes.delete(executionId);
        } else {
          const pendingExecutionId = lane.pendingExecutionId;
          lane.pendingExecutionId = undefined;
          scheduleOutputProjection(pendingExecutionId);
        }
      }
    })();
  };
  return {
    onEvent: (event): void => {
      const lane = outputProjectionLanes.get(event.executionId);
      if (lane) lane.pendingExecutionId = undefined;
      if (TERMINAL_PIPELINE_STATUSES.has(event.state.status)) {
        terminalExecutions.add(event.executionId);
        clearExecutionTails(event.executionId);
      }
      void projectPortalPipelineRun(
        event.executionId,
        () => stateToPortalRun(event.state),
        options,
      ).catch(() => undefined);
    },
    onStepOutput: (event): void => {
      if (terminalExecutions.has(event.executionId)) return;
      const key = stepKey(event);
      const previous = outputTails.get(key);
      const outputTail = trimUtf8Tail(
        `${previous?.outputTail ?? ''}${event.data}`,
        STEP_TAIL_MAX_BYTES,
      );
      let retainedBytes =
        (outputTailBytesByExecution.get(event.executionId) ?? 0) -
        (previous ? retainedOutputTailByteLength(key, previous) : 0);
      let retainedCount =
        (outputTailCountByExecution.get(event.executionId) ?? 0) +
        (previous ? 0 : 1);
      const nextOutputTail: RetainedOutputTail = {
        jobId: event.jobId,
        stepId: event.stepId,
        attempt: event.attempt,
        iteration: event.iteration ?? 1,
        recovery: event.recovery ?? 0,
        outputTail,
      };
      outputTails.delete(key);
      outputTails.set(key, nextOutputTail);
      retainedBytes += retainedOutputTailByteLength(key, nextOutputTail);
      if (retainedBytes > STREAM_STEP_TAILS_MAX_BYTES) {
        truncatedOutputExecutions.add(event.executionId);
      }
      const markerBytes = truncatedOutputExecutions.has(event.executionId)
        ? Buffer.byteLength(STREAM_STEP_TAILS_TRUNCATION_MARKER, 'utf8')
        : 0;
      const retainedLimit = STREAM_STEP_TAILS_MAX_BYTES - markerBytes;
      while (
        retainedBytes > retainedLimit ||
        retainedCount > STREAM_STEP_TAILS_MAX_ENTRIES
      ) {
        const oldest = Array.from(outputTails.entries()).find(([candidate]) =>
          candidate.startsWith(`${event.executionId}\0`),
        );
        if (!oldest) break;
        outputTails.delete(oldest[0]);
        retainedBytes -= retainedOutputTailByteLength(oldest[0], oldest[1]);
        retainedCount -= 1;
        truncatedOutputExecutions.add(event.executionId);
      }
      outputTailBytesByExecution.set(event.executionId, retainedBytes);
      outputTailCountByExecution.set(event.executionId, retainedCount);
      scheduleOutputProjection(event.executionId);
    },
  };
}

/**
 * Give every execution a browser projection, whoever started it.
 *
 * Attached once per execution by `pipeline-handlers`; see
 * `pipelines/pipeline-run-observers.ts` for why this is a registration seam
 * rather than a direct import, and for the defect it closes.
 *
 * Both gates are re-read per event rather than decided once at attach time: a
 * browser that pairs mid-run must start receiving updates without the run
 * restarting, and a browser-dispatched run must stay on its command-correlated
 * forwarder for its whole life.
 */
setPipelineRunObserverFactory(() => {
  const forwarder = createPortalPipelineForwarder({});
  const skip = (executionId: string): boolean =>
    portalForwardedExecutionIds.has(executionId) || !isPortalEventSinkActive();
  return {
    onEvent: (event): void => {
      // Read the skip decision BEFORE draining the set. The ambient observer is
      // the only one guaranteed to see every execution's final event, so it
      // owns the cleanup — but a run that had an explicit forwarder for its
      // whole life must not have its terminal event published twice.
      const skipped = skip(event.executionId);
      if (TERMINAL_PIPELINE_STATUSES.has(event.state.status)) {
        portalForwardedExecutionIds.delete(event.executionId);
      }
      if (skipped) return;
      forwarder.onEvent(event);
    },
    onStepOutput: (event): void => {
      if (skip(event.executionId)) return;
      forwarder.onStepOutput(event);
    },
    prime: (state): void => {
      if (skip(state.id)) return;
      void projectPortalPipelineRun(state.id, () =>
        stateToPortalRun(state),
      ).catch(() => undefined);
    },
  };
});

async function cancelPipelineUnlocked(
  request: PortalPipelineCancelPayload & PipelineExecutionScope,
  options: {
    portalCommandId?: string;
    getWindow?: () => BrowserWindow | null;
  } = {},
): Promise<PortalPipelineRun | null> {
  validateId(request.executionId, 'executionId');
  validatePipelineExecutionScope(request);
  const existingState = await loadExecutionState(
    request.executionId,
    getPipelineExecutionsDir(),
  );
  assertExecutionMatchesScope(existingState, request);
  const state = await cancelPipelineExecutionFromMain({
    executionId: request.executionId,
    getWindow: options.getWindow ?? ((): null => null),
  });
  return projectPortalPipelineRun(
    request.executionId,
    () => stateToPortalRun(state),
    options,
  );
}

export function cancelPipeline(
  request: PortalPipelineCancelPayload & PipelineExecutionScope,
  options: {
    portalCommandId?: string;
    getWindow?: () => BrowserWindow | null;
  } = {},
): Promise<PortalPipelineRun | null> {
  return serializePortalPipelineMutation(request.executionId, () =>
    cancelPipelineUnlocked(request, options),
  );
}

type PipelineControlOptions = {
  portalCommandId?: string;
  onRunUpdate?: (run: PortalPipelineRun) => void;
};

function portalPipelineActionRuntime(
  state: ExecutionState,
  options: PipelineControlOptions,
): WorktreeActionRuntime {
  if (!state.project_id || !state.worktree_id) {
    throw new PortalServiceError(
      'invalid_target',
      'Pipeline execution is missing its workspace target.',
    );
  }
  const forwarder = createPortalPipelineForwarder(options);
  // Resume / retry / rerun re-enter the executor, which re-attaches ambient
  // observers; this forwarder is the correlated one for the continuation.
  markPortalForwardedExecution(state.id);
  return {
    projectId: state.project_id,
    worktreeId: state.worktree_id,
    chatId: options.portalCommandId ?? `portal-pipeline-${state.id}`,
    cwd: state.cwd,
    pipelineInitiationSource: 'portal',
    ...(options.portalCommandId
      ? { portalCommandId: options.portalCommandId }
      : {}),
    getWindow: () => null,
    onPipelineEvent: forwarder.onEvent,
    onPipelineStepOutput: forwarder.onStepOutput,
  };
}

function throwForPipelineActionFailure(response: {
  ok: boolean;
  error?: { code: string; message: string };
}): void {
  if (response.ok) return;
  const code =
    response.error?.code === 'invalid_target' ||
    response.error?.code === 'not_found'
      ? response.error.code
      : 'execution_failed';
  throw new PortalServiceError(
    code,
    response.error?.message ?? 'Workflow execution action failed.',
  );
}

async function loadScopedPipelineExecution(
  request: { executionId: string } & PipelineExecutionScope,
): Promise<ExecutionState> {
  validateId(request.executionId, 'executionId');
  validatePipelineExecutionScope(request);
  if (!request.projectId || !request.worktreeId) {
    throw new PortalServiceError(
      'invalid_target',
      'projectId and worktreeId are required.',
    );
  }
  const state = await loadExecutionState(
    request.executionId,
    getPipelineExecutionsDir(),
  );
  assertExecutionMatchesScope(state, request);
  return state;
}

async function updatedPortalRun(
  executionId: string,
  scope: PipelineExecutionScope,
  options: PipelineControlOptions,
): Promise<PortalPipelineRun> {
  const run = await projectPortalPipelineRun(
    executionId,
    async () => {
      const state = await loadExecutionState(
        executionId,
        getPipelineExecutionsDir(),
      );
      assertExecutionMatchesScope(state, scope);
      return stateToPortalRun(state);
    },
    options,
  );
  if (!run) {
    throw new PortalServiceError('not_found', 'Workflow execution not found.');
  }
  return run;
}

function hasPortalCommandReceipt(
  state: ExecutionState,
  commandId: string | undefined,
): boolean {
  return (
    commandId !== undefined &&
    state.portal_command_ids?.includes(commandId) === true
  );
}

async function projectPortalCommandReceipt(
  state: ExecutionState,
  options: PipelineControlOptions,
): Promise<PortalPipelineRun> {
  const run = await projectPortalPipelineRun(
    state.id,
    () => stateToPortalRun(state),
    options,
  );
  if (!run) {
    throw new PortalServiceError(
      'not_found',
      'Pipeline execution receipt could not be projected.',
    );
  }
  return run;
}

async function resumePipelineUnlocked(
  request: PortalPipelineResumePayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<PortalPipelineRun> {
  if (options.portalCommandId) {
    validateId(options.portalCommandId, 'portalCommandId');
  }
  const state = await loadScopedPipelineExecution(request);
  if (hasPortalCommandReceipt(state, options.portalCommandId)) {
    return projectPortalCommandReceipt(state, options);
  }
  if (!canResumeExecution(state)) {
    throw new PortalServiceError(
      'execution_failed',
      'Only paused root workflow executions can be resumed.',
    );
  }
  const response = await resumeExecution(
    {
      type: 'pipeline.execution_resume',
      executionId: request.executionId,
      ...(request.pauseResponses
        ? { pauseResponses: request.pauseResponses }
        : {}),
    },
    portalPipelineActionRuntime(state, options),
  );
  throwForPipelineActionFailure(response);
  return updatedPortalRun(request.executionId, request, options);
}

export function resumePipeline(
  request: PortalPipelineResumePayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<PortalPipelineRun> {
  return serializePortalPipelineMutation(request.executionId, () =>
    resumePipelineUnlocked(request, options),
  );
}

async function retryPipelineUnlocked(
  request: PortalPipelineRetryPayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<PortalPipelineRun> {
  if (options.portalCommandId) {
    validateId(options.portalCommandId, 'portalCommandId');
  }
  const state = await loadScopedPipelineExecution(request);
  if (hasPortalCommandReceipt(state, options.portalCommandId)) {
    return projectPortalCommandReceipt(state, options);
  }
  if (!canRetryExecution(state)) {
    throw new PortalServiceError(
      'execution_failed',
      'Only failed or cancelled root workflow executions can be retried.',
    );
  }
  const response = await retryExecution(
    {
      type: 'pipeline.execution_retry',
      executionId: request.executionId,
    },
    portalPipelineActionRuntime(state, options),
  );
  throwForPipelineActionFailure(response);
  return updatedPortalRun(request.executionId, request, options);
}

export function retryPipeline(
  request: PortalPipelineRetryPayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<PortalPipelineRun> {
  return serializePortalPipelineMutation(request.executionId, () =>
    retryPipelineUnlocked(request, options),
  );
}

async function rerunPipelineUnlocked(
  request: PortalPipelineRerunPayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<PortalPipelineRun> {
  if (!request.projectId || !request.worktreeId) {
    throw new PortalServiceError(
      'invalid_target',
      'projectId and worktreeId are required.',
    );
  }
  if (options.portalCommandId) {
    validateId(options.portalCommandId, 'portalCommandId');
    validatePipelineExecutionScope(request);
    const receipt = await loadExecutionState(
      options.portalCommandId,
      getPipelineExecutionsDir(),
    );
    if (receipt) {
      assertExecutionMatchesScope(receipt, request);
      if (receipt.rerun_source_id !== request.executionId) {
        throw new PortalServiceError(
          'not_found',
          'Pipeline rerun receipt does not match this command.',
        );
      }
      const run = await projectPortalPipelineRun(
        receipt.id,
        () => stateToPortalRun(receipt),
        options,
      );
      if (!run) {
        throw new PortalServiceError(
          'not_found',
          'Pipeline rerun receipt could not be projected.',
        );
      }
      return run;
    }
  }
  const state = await loadScopedPipelineExecution(request);
  if (!canRerunExecution(state) || !hasRerunReplayData(state)) {
    throw new PortalServiceError(
      'execution_failed',
      'This workflow execution cannot be rerun from its saved inputs.',
    );
  }
  const response = await rerunExecution(
    {
      type: 'pipeline.execution_rerun',
      executionId: request.executionId,
      rerunExecutionId: options.portalCommandId,
    },
    portalPipelineActionRuntime(state, options),
  );
  throwForPipelineActionFailure(response);
  const result = response.result;
  const execution =
    result && typeof result === 'object' && !Array.isArray(result)
      ? result.execution
      : undefined;
  const executionId =
    execution && typeof execution === 'object' && !Array.isArray(execution)
      ? execution.id
      : undefined;
  if (typeof executionId !== 'string') {
    throw new PortalServiceError(
      'execution_failed',
      'Pipeline rerun did not return an execution id.',
    );
  }
  return updatedPortalRun(executionId, request, options);
}

export function rerunPipeline(
  request: PortalPipelineRerunPayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<PortalPipelineRun> {
  return serializePortalPipelineMutation(request.executionId, () =>
    rerunPipelineUnlocked(request, options),
  );
}

export async function listPipelineExecutions(
  request: PortalPipelineExecutionListPayload,
): Promise<PortalPipelineExecutionListResult> {
  validatePipelineExecutionScope(request);
  if (!request.projectId || !request.worktreeId) {
    throw new PortalServiceError(
      'invalid_target',
      'projectId and worktreeId are required.',
    );
  }
  const cwd = await resolvePipelineCwd(request.projectId, request.worktreeId);
  const response = await listExecutions(
    {
      type: 'pipeline.execution_list',
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    },
    {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: 'portal.pipeline.execution_list',
      cwd,
      getWindow: () => null,
    },
  );
  throwForPipelineActionFailure(response);
  const result = response.result;
  const executions =
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    Array.isArray(result.executions)
      ? result.executions
      : [];
  const executionIds = executions.flatMap((execution) => {
    if (
      !execution ||
      typeof execution !== 'object' ||
      Array.isArray(execution) ||
      typeof execution.id !== 'string'
    ) {
      return [];
    }
    return [execution.id];
  });
  const states = await Promise.all(
    executionIds.map((executionId) =>
      loadExecutionState(executionId, getPipelineExecutionsDir()).catch(
        () => null,
      ),
    ),
  );
  const runs = (
    await Promise.all(
      states.map(async (state) => {
        if (!state) return null;
        assertExecutionMatchesScope(state, request);
        return stateToPortalRun(state);
      }),
    )
  ).flatMap((run) => (run ? [run] : []));
  const totalMatches =
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    typeof result.totalMatches === 'number'
      ? result.totalMatches
      : runs.length;
  return {
    runs,
    ...(totalMatches > runs.length ? { truncated: true } : {}),
  };
}

async function getPipelineExecutionUnlocked(
  request: PortalPipelineExecutionGetPayload & PipelineExecutionScope,
  options: { portalCommandId?: string } = {},
): Promise<PortalPipelineRun | null> {
  validateId(request.executionId, 'executionId');
  validatePipelineExecutionScope(request);
  const state = await loadExecutionState(
    request.executionId,
    getPipelineExecutionsDir(),
  );
  assertExecutionMatchesScope(state, request);
  const run = state ? await stateToPortalRun(state) : null;
  if (run) notifyPipelineRunUpdate(run, options);
  return run;
}

export function getPipelineExecution(
  request: PortalPipelineExecutionGetPayload & PipelineExecutionScope,
  options: { portalCommandId?: string } = {},
): Promise<PortalPipelineRun | null> {
  return serializeKeyedOperation(
    portalPipelineProjectionQueues,
    request.executionId,
    () => getPipelineExecutionUnlocked(request, options),
  );
}

async function getPipelineLogUnlocked(
  request: PortalPipelineLogRequestPayload & PipelineExecutionScope,
  options: { portalCommandId?: string } = {},
): Promise<{
  lines: string[];
  run?: PortalPipelineRun;
}> {
  validateId(request.executionId, 'executionId');
  validatePipelineRuntimeIdentifier(request.jobId, 'jobId');
  validatePipelineRuntimeIdentifier(request.stepId, 'stepId');
  validatePipelineExecutionScope(request);
  const state = await loadExecutionState(
    request.executionId,
    getPipelineExecutionsDir(),
  );
  assertExecutionMatchesScope(state, request);
  const physicalJobId = request.jobId;
  const job = physicalJobId ? state?.jobs[physicalJobId] : undefined;
  const definition = physicalJobId
    ? (state?.job_definitions?.[physicalJobId] ??
      state?.pipeline_snapshot.jobs[physicalJobId])
    : undefined;
  const stepOwner = job;
  const step = stepOwner?.steps[request.stepId];
  if (!state || !job || !stepOwner || !step) {
    throw new PortalServiceError('not_found', 'Workflow step not found.');
  }

  const logPath =
    step.log_file ??
    getStepLogFilePath(
      createElectronExecutionRuntime(),
      request.executionId,
      definition?.artifact_locator?.job_id ?? request.jobId,
      request.stepId,
      request.attempt ?? currentAttempt(stepOwner),
      request.iteration ?? currentIteration(stepOwner),
      0,
      definition?.artifact_locator?.matrix_child_id,
    );
  const lines = await readLogLines(logPath, 500);
  const run = await stateToPortalRun(state, {
    requestedStep: {
      jobId: request.jobId,
      stepId: request.stepId,
      attempt: request.attempt ?? currentAttempt(stepOwner),
      iteration: request.iteration ?? currentIteration(stepOwner),
      recovery: currentRecovery(step),
      outputTail: trimUtf8Tail(lines.join('\n'), STEP_TAIL_MAX_BYTES),
    },
  });
  if (run) notifyPipelineRunUpdate(run, options);
  return run ? { lines, run } : { lines };
}

export function getPipelineLog(
  request: PortalPipelineLogRequestPayload & PipelineExecutionScope,
  options: { portalCommandId?: string } = {},
): Promise<{
  lines: string[];
  run?: PortalPipelineRun;
}> {
  return serializeKeyedOperation(
    portalPipelineProjectionQueues,
    request.executionId,
    () => getPipelineLogUnlocked(request, options),
  );
}

/**
 * The saved reference a chat follow-up reviews, with the same precedence as
 * the desktop's follow-up actions (`usePipelineExecutionActions`). Paths stay
 * on the host: clients only learn whether one exists.
 */
function pipelineChatFollowUpReference(
  state: ExecutionState,
  output: PortalPipelineChatFollowUpPreparePayload['output'],
): string | undefined {
  return output === 'plan'
    ? (state.event_data?.plan_ready?.plan_path ??
        state.event_data?.task_ready?.plan_path)
    : (state.report_outputs?.report_file ??
        state.report_outputs?.report_json_file);
}

/**
 * Builds the review prompt for one saved output of a run (CAN-3719). The run
 * is reloaded and must belong to the requested owner, and the owner worktree
 * must still exist, so a client cannot redirect the follow-up elsewhere.
 * Reads no report content and changes nothing.
 */
export async function preparePipelineChatFollowUp(
  request: PortalPipelineChatFollowUpPreparePayload,
): Promise<{ prompt: string }> {
  const state = await loadScopedPipelineExecution(request);
  if (
    !(await resolvePipelineDefinitionTarget(
      request.projectId,
      request.worktreeId,
    ))
  ) {
    throw new PortalServiceError(
      'not_found',
      "This run's worktree is no longer available.",
    );
  }
  const reference = pipelineChatFollowUpReference(state, request.output);
  if (!reference) {
    throw new PortalServiceError(
      'not_found',
      request.output === 'plan'
        ? 'This workflow run does not have a saved plan file.'
        : 'This workflow run does not have a saved report file.',
    );
  }
  return {
    prompt:
      request.output === 'plan'
        ? `Review this plan: ${reference}`
        : `Review this report: ${reference}`,
  };
}

/**
 * The last built content document, so the later pages of one read do not
 * read and parse the files again. Keyed by the source and its files' sizes
 * and change times, which are also the revision a later page must match.
 */
let lastPipelineContent:
  | { key: string; document: PipelineContentDocument }
  | undefined;

/**
 * One page of a step's complete readable output or of the run's saved report
 * (`portal.pipeline.content.read`, CAN-3717), as the desktop shows them. Read
 * on demand; the streamed run projection keeps its bounded step tails. Every
 * file comes from the scoped execution state and stays inside the executions
 * directory.
 */
export async function readPipelineContent(
  request: PortalPipelineContentReadPayload,
): Promise<PortalPipelineContentReadResult> {
  const state = await loadScopedPipelineExecution(request);
  const source = request.source;
  const executionsDir = getPipelineExecutionsDir();
  const confined = (path: string): string => {
    const resolved = resolve(path);
    if (!isPathInsideExecutionsDir(executionsDir, resolved)) {
      throw new PortalServiceError('not_found', 'This content is unavailable.');
    }
    return resolved;
  };
  // Each file read for the document; a missing optional file reads as empty.
  let files: Array<{ path: string; required: boolean }>;
  let build: (contents: string[]) => PipelineContentDocument;
  if (source.kind === 'step_output') {
    validatePipelineRuntimeIdentifier(source.jobId, 'jobId');
    validatePipelineRuntimeIdentifier(source.stepId, 'stepId');
    const job = state.jobs[source.jobId];
    const step = job?.steps[source.stepId];
    if (!job || !step) {
      throw new PortalServiceError('not_found', 'Workflow step not found.');
    }
    const definition =
      state.job_definitions?.[source.jobId] ??
      state.pipeline_snapshot.jobs[source.jobId];
    const log = confined(
      step.log_file ??
        getStepLogFilePath(
          createElectronExecutionRuntime(),
          request.executionId,
          definition?.artifact_locator?.job_id ?? source.jobId,
          source.stepId,
          currentAttempt(job),
          currentIteration(job),
          currentRecovery(step),
          definition?.artifact_locator?.matrix_child_id,
        ),
    );
    // The desktop's rich step view reads an agent step's transcript, and
    // its plain view the log.
    const agent = step.log_format_hint === 'agent';
    const transcriptFile = step.outputs.transcript_file;
    files = [{ path: log, required: false }];
    if (agent && transcriptFile) {
      files.push({ path: confined(transcriptFile), required: false });
    }
    build = ([logText = '', transcript = logText]): PipelineContentDocument =>
      (agent
        ? agentTranscriptDocument(transcript, step.agent_provider)
        : null) ?? plainLogDocument(logText);
  } else if (source.kind === 'report') {
    const textFile = state.report_outputs?.report_file;
    const jsonFile = state.report_outputs?.report_json_file;
    files = [textFile, jsonFile].flatMap((path) =>
      path ? [{ path: confined(path), required: true }] : [],
    );
    build = (contents): PipelineContentDocument => {
      const queue = [...contents];
      const text = textFile ? queue.shift() : undefined;
      const json = jsonFile ? queue.shift() : undefined;
      return reportDocument({
        ...(text === undefined
          ? {}
          : {
              text: {
                content: text,
                markdown: /\.(md|markdown)$/i.test(textFile?.trim() ?? ''),
              },
            }),
        ...(json === undefined ? {} : { json }),
      });
    };
  } else {
    throw new PortalServiceError('invalid_payload', 'Invalid content source.');
  }

  const unavailable = (): PortalServiceError =>
    new PortalServiceError(
      'not_found',
      "This run's report is no longer available.",
    );
  const identities = await Promise.all(
    files.map(async ({ path, required }) => {
      const info = await stat(path).catch(() => undefined);
      if (!info && required) throw unavailable();
      return info ? `${String(info.size)}:${String(info.mtimeMs)}` : '-';
    }),
  );
  const revision = identities.join('/');
  if (request.revision !== undefined && request.revision !== revision) {
    throw new PortalServiceError(
      'execution_failed',
      'The content changed while it was loading. Try again.',
    );
  }
  const key = JSON.stringify([request.executionId, source, revision]);
  let document =
    lastPipelineContent?.key === key ? lastPipelineContent.document : undefined;
  if (!document) {
    const contents = await Promise.all(
      files.map(({ path, required }) =>
        readFile(path, 'utf8').catch(() => {
          if (required) throw unavailable();
          return '';
        }),
      ),
    );
    document = build(contents);
    lastPipelineContent = { key, document };
  }
  const page = pipelineContentPage(document, request.offset ?? 0, revision);
  if (!page) {
    throw new PortalServiceError('invalid_payload', 'Invalid content offset.');
  }
  return page;
}

export async function getPipelineFailureDebugContext(
  executionId: string,
): Promise<{
  prompt: string;
  failedStepCount: number;
  includedReportKinds: Array<'text' | 'json'>;
}> {
  validateId(executionId, 'executionId');
  const runtime = createElectronExecutionRuntime();
  const state = await loadExecutionState(executionId, runtime.executionsDir);
  if (!state) {
    throw new PortalServiceError('not_found', 'Workflow execution not found.');
  }

  return buildPipelineFailureDebugPrompt(state, {
    readReportFile: async (id, kind) => {
      if (id !== executionId) {
        return { success: false, error: 'Invalid execution id' };
      }
      const filePath =
        kind === 'text'
          ? state.report_outputs?.report_file
          : state.report_outputs?.report_json_file;
      if (!filePath) {
        return { success: false, error: `${kind} report was not available` };
      }
      const resolvedPath = resolve(filePath);
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
    },
    readStepLog: async (locator: StepLogLocator) => {
      const physicalJobId = locator.jobId;
      const definition = physicalJobId
        ? state.job_definitions[physicalJobId]
        : undefined;
      const stepResult = physicalJobId ? state.jobs[physicalJobId] : undefined;
      const step = stepResult?.steps[locator.stepId];
      const logPath =
        locator.logFilePath ??
        step?.log_file ??
        getStepLogFilePath(
          runtime,
          locator.executionId,
          definition?.artifact_locator?.job_id ?? locator.jobId,
          locator.stepId,
          locator.attempt ?? currentAttempt(stepResult),
          locator.iteration ?? currentIteration(stepResult),
          locator.recovery ?? 0,
          definition?.artifact_locator?.matrix_child_id,
        );
      const resolvedPath = resolve(logPath);
      if (!isPathInsideExecutionsDir(runtime.executionsDir, resolvedPath)) {
        return { success: false, error: 'Invalid log file path' };
      }
      try {
        const raw = await readFile(resolvedPath, 'utf8');
        const lines = raw.replace(/\r\n/g, '\n').split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        return { success: true, data: { lines } };
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          Reflect.get(error, 'code') === 'ENOENT'
        ) {
          return { success: true, data: { lines: [] } };
        }
        return { success: false, error: String(error) };
      }
    },
  });
}

export async function stateToPortalRun(
  state: Awaited<ReturnType<typeof loadExecutionState>>,
  options: {
    requestedStep?: RequestedPortalStep;
    requestedSteps?: readonly RequestedPortalStep[];
    streamProjection?: boolean;
  } = {},
): Promise<PortalPipelineRun | null> {
  if (!state?.project_id || !state.worktree_id) return null;
  const jobs = await buildPortalPipelineJobs(
    state,
    options.requestedSteps ??
      (options.requestedStep ? [options.requestedStep] : undefined),
    options.streamProjection ?? false,
  );
  const outputTail = trimUtf8Tail(
    jobs
      .flatMap((job) => [
        ...job.steps.map((step) => step.outputTail ?? ''),
        ...(job.variants ?? []).flatMap((variant) =>
          variant.steps.map((step) => step.outputTail ?? ''),
        ),
      ])
      .filter(Boolean)
      .join('\n'),
    RUN_TAIL_MAX_BYTES,
  );
  let remainingPauseRequestBytes = PORTAL_PAUSE_REQUESTS_MAX_BYTES;
  const pendingPauses: PortalPipelinePauseCheckpoint[] = (
    state.pending_pauses ?? []
  ).map((checkpoint) => {
    const identity: PortalPipelinePauseCheckpoint = {
      id: checkpoint.id,
      kind: checkpoint.kind,
      jobId: checkpoint.job_id,
      logicalJobId: checkpoint.logical_job_id,
      stepId: checkpoint.step_id,
    };
    if (!checkpoint.request) return identity;

    const request = {
      ...(checkpoint.request.title ? { title: checkpoint.request.title } : {}),
      ...(checkpoint.request.message
        ? { message: checkpoint.request.message }
        : {}),
      fields: checkpoint.request.fields.map((field) => ({ ...field })),
    };
    const measurement = measureSerializedBytes(
      request,
      remainingPauseRequestBytes,
    );
    if (measurement.exceeded) {
      return { ...identity, requestUnavailableReason: 'too_large' };
    }
    remainingPauseRequestBytes -= measurement.bytes;
    return { ...identity, request };
  });
  return {
    localId: state.id,
    runId: state.id,
    pipelineId: state.pipeline_id,
    pipelineName: state.pipeline_snapshot.name,
    workspaceLocalId: state.project_id,
    worktreeLocalId: state.worktree_id,
    status: mapRunStatus(state.status),
    startedAt: state.started_at,
    finishedAt: state.completed_at,
    parentExecutionId: state.parent_execution_id,
    hidden: state.hidden,
    outputTail,
    statusReasons: (state.status_reasons ?? []).map((reason) => ({
      id: reason.id,
      kind: reason.kind,
      code: reason.code,
      ...(reason.provider ? { provider: reason.provider } : {}),
      ...(reason.resets_at ? { resetsAt: reason.resets_at } : {}),
    })),
    pendingPauses,
    jobs,
    chatFollowUp: {
      planAvailable: Boolean(pipelineChatFollowUpReference(state, 'plan')),
      reportAvailable: Boolean(pipelineChatFollowUpReference(state, 'report')),
    },
    ...(await pipelineRunChatTurns(
      { projectId: state.project_id, worktreeId: state.worktree_id },
      state.id,
    )),
  };
}

function currentAttempt(job: JobResult | undefined): number {
  return Math.max(job?.retry_count ?? 0, job?.retry_history?.length ?? 0);
}

function currentIteration(job: JobResult | undefined): number {
  return Math.max(1, job?.iteration_count ?? 1);
}

function currentRecovery(step: StepResult): number {
  return step.recovery_count ?? 0;
}

function findRequestedPortalStep(
  requestedSteps: readonly RequestedPortalStep[] | undefined,
  jobId: string,
  stepId: string,
  job: JobResult,
  step: StepResult,
): RequestedPortalStep | undefined {
  return requestedSteps?.find(
    (requestedStep) =>
      requestedStep.jobId === jobId &&
      requestedStep.stepId === stepId &&
      requestedStep.attempt === currentAttempt(job) &&
      requestedStep.iteration === currentIteration(job) &&
      requestedStep.recovery === currentRecovery(step),
  );
}

function shouldHydrateMatrixStep(step: StepResult): boolean {
  return (
    step.status === 'running' ||
    step.status === 'paused' ||
    step.status === 'failure'
  );
}

async function buildPortalPipelineJobs(
  state: ExecutionState,
  requestedSteps?: readonly RequestedPortalStep[],
  streamProjection = false,
): Promise<NonNullable<PortalPipelineRun['jobs']>> {
  return Promise.all(
    Object.entries(state.pipeline_snapshot.jobs).map(
      async ([logicalJobId, logicalJob]) => {
        const group = state.job_groups?.[logicalJobId];
        const projectPhysical = async (
          physicalJobId: string,
        ): Promise<PortalPipelineRunVariant> => {
          const definition =
            state.job_definitions?.[physicalJobId] ?? logicalJob;
          const result = state.jobs[physicalJobId];
          const steps = await Promise.all(
            definition.steps.map(async (stepDef) => {
              const step = result?.steps[stepDef.id];
              const requestedStep =
                step !== undefined &&
                result !== undefined &&
                findRequestedPortalStep(
                  requestedSteps,
                  physicalJobId,
                  stepDef.id,
                  result,
                  step,
                );
              const shouldRead =
                !streamProjection &&
                step !== undefined &&
                result !== undefined &&
                (group?.kind !== 'matrix' || shouldHydrateMatrixStep(step));
              let outputTail: string | undefined;
              if (requestedStep) {
                outputTail = requestedStep.outputTail;
              } else if (shouldRead && step && result) {
                outputTail = await readStepOutputTail(
                  state,
                  definition.artifact_locator?.job_id ?? physicalJobId,
                  stepDef.id,
                  result,
                  step,
                  definition.artifact_locator?.matrix_child_id,
                );
              }
              return {
                stepId: stepDef.id,
                name: stepDef.name ?? stepDef.id,
                status: mapRunStatus(step?.status ?? 'pending'),
                attempt: currentAttempt(result),
                iteration: currentIteration(result),
                ...(outputTail ? { outputTail } : {}),
              };
            }),
          );
          return {
            jobId: physicalJobId,
            name: definition.name ?? physicalJobId,
            status: mapRunStatus(result?.status ?? 'pending'),
            matrix: definition.matrix?.values ?? {},
            steps,
          };
        };

        if (group?.kind === 'matrix') {
          const variants = await Promise.all(
            group.variant_job_ids.map(projectPhysical),
          );
          return {
            jobId: logicalJobId,
            name: logicalJob.name ?? logicalJobId,
            status: mapRunStatus(group.status),
            // Always emitted (empty when the job has no dependencies) so a
            // missing field unambiguously means "older desktop" (CAN-2511).
            needs: [...logicalJob.needs],
            steps: [],
            variants,
            expansion: group.expansion,
            ...(group.error ? { expansionError: group.error } : {}),
          };
        }
        const physicalJobId = group?.variant_job_ids[0] ?? logicalJobId;
        const physical = await projectPhysical(physicalJobId);
        return {
          jobId: logicalJobId,
          name: logicalJob.name ?? logicalJobId,
          status: physical.status,
          needs: [...logicalJob.needs],
          steps: physical.steps,
        };
      },
    ),
  );
}

async function readStepOutputTail(
  state: ExecutionState,
  jobId: string,
  stepId: string,
  job: JobResult,
  step: StepResult,
  childId?: string,
): Promise<string | undefined> {
  const runtime = createElectronExecutionRuntime();
  const logPath =
    step.log_file ??
    getStepLogFilePath(
      runtime,
      state.id,
      jobId,
      stepId,
      currentAttempt(job),
      currentIteration(job),
      currentRecovery(step),
      childId,
    );
  const resolvedPath = resolve(logPath);
  if (!isPathInsideExecutionsDir(runtime.executionsDir, resolvedPath))
    return undefined;

  return stepTailReadLimit.run(async (): Promise<string | undefined> => {
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fileHandle = await open(resolvedPath, 'r');
      const stats = await fileHandle.stat();
      if (!stats.isFile() || stats.size <= 0) return undefined;

      const readLength = Math.min(stats.size, STEP_TAIL_READ_BYTES);
      const start = stats.size - readLength;
      const bytes = Buffer.allocUnsafe(readLength);
      let bytesRead = 0;
      while (bytesRead < readLength) {
        const result = await fileHandle.read(
          bytes,
          bytesRead,
          readLength - bytesRead,
          start + bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead === 0) return undefined;
      const raw = bytes.subarray(0, bytesRead).toString('utf8');
      return trimUtf8Tail(raw.replace(/\r\n/g, '\n'), STEP_TAIL_MAX_BYTES);
    } catch {
      return undefined;
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  });
}

async function readLogLines(path: string, maxLines: number): Promise<string[]> {
  return stepTailReadLimit.run(async (): Promise<string[]> => {
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fileHandle = await open(path, 'r');
      const stats = await fileHandle.stat();
      if (!stats.isFile() || stats.size <= 0) return [];

      const readLength = Math.min(stats.size, STEP_TAIL_READ_BYTES);
      const start = stats.size - readLength;
      const bytes = Buffer.allocUnsafe(readLength);
      let bytesRead = 0;
      while (bytesRead < readLength) {
        const result = await fileHandle.read(
          bytes,
          bytesRead,
          readLength - bytesRead,
          start + bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead === 0) return [];

      const raw = trimUtf8Tail(
        bytes.subarray(0, bytesRead).toString('utf8').replace(/\r\n/g, '\n'),
        STEP_TAIL_MAX_BYTES,
      );
      const lines = raw.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines.length > maxLines ? lines.slice(-maxLines) : lines;
    } catch {
      return [];
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  });
}

function trimUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString('utf8');
}

export function pipelineToPortalEntity(
  pipeline: PortalPipelineSummary,
): PortalEntityEnvelope {
  return {
    entityType: 'pipeline',
    localId: `${pipeline.worktreeLocalId}:${pipeline.pipelineId}`,
    parentLocalId: worktreeScopedParentLocalId(
      pipeline.workspaceLocalId,
      pipeline.worktreeLocalId,
    ),
    payload: pipeline,
  };
}

function notifyPipelineRunUpdate(
  run: PortalPipelineRun,
  options: {
    portalCommandId?: string;
    onRunUpdate?: (run: PortalPipelineRun) => void;
  } = {},
): void {
  options.onRunUpdate?.(run);
  pipelineRunUpdateListeners.forEach((listener): void => {
    // A throwing subscriber must not gate the portal feature upsert below or
    // other listeners; this registry is observational only.
    try {
      listener(run);
    } catch {
      // Ignore listener failures.
    }
  });
  const createRunEvent = (payload: PortalPipelineRun): PortalEventEnvelope =>
    createFeatureUpsertEvent({
      type: 'portal.pipeline.event',
      commandId: options.portalCommandId,
      entity: {
        entityType: 'pipeline_run',
        localId: run.localId,
        parentLocalId: worktreeScopedParentLocalId(
          run.workspaceLocalId,
          run.worktreeLocalId,
        ),
        payload,
      },
    });
  let event = createRunEvent(run);
  if (portalEventMaxRoutedByteLength(event) > PORTAL_EVENT_BATCH_MAX_BYTES) {
    const unavailableInput = run.pendingPauses?.find(
      (checkpoint) => checkpoint.kind === 'input',
    );
    // Keep identity, chat-turn links and follow-up availability: clients
    // merge this partial row into the run they already know, and these
    // small facts must survive truncation.
    event = createRunEvent({
      localId: run.localId,
      runId: run.runId,
      pipelineId: run.pipelineId,
      pipelineName: run.pipelineName,
      workspaceLocalId: run.workspaceLocalId,
      worktreeLocalId: run.worktreeLocalId,
      parentExecutionId: run.parentExecutionId,
      ...(run.chatTurns ? { chatTurns: run.chatTurns } : {}),
      ...(run.chatFollowUp ? { chatFollowUp: run.chatFollowUp } : {}),
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      hidden: run.hidden,
      triggerSource: run.triggerSource,
      progress: run.progress,
      ...(unavailableInput
        ? {
            pendingPauses: [
              {
                id: unavailableInput.id,
                kind: unavailableInput.kind,
                jobId: unavailableInput.jobId,
                logicalJobId: unavailableInput.logicalJobId,
                stepId: unavailableInput.stepId,
                requestUnavailableReason: 'too_large',
              },
            ],
          }
        : {}),
      truncated: true,
    });
  }
  if (portalEventMaxRoutedByteLength(event) <= PORTAL_EVENT_BATCH_MAX_BYTES) {
    enqueuePortalEvent(event);
  }
}

/**
 * `portal.pipeline.share`: re-read the pipeline's YAML from disk and create the
 * shared copy under the DESKTOP's Cloud account, then mint the link for the
 * requested scope.
 *
 * Definition-only by contract — see {@link PortalPipelineSharePayload}. A
 * packaged share needs the interactive analyze/select flow the desktop editor
 * drives, so it is never silently substituted here.
 */
export async function sharePortalPipeline(
  request: PortalPipelineSharePayload,
): Promise<PortalShareResult> {
  const { target, pipelineInfo } =
    await resolvePortalShareablePipeline(request);
  const accountId = await requirePortalShareAccountId(pipelineInfo.remote);

  const sourcePipeline: PipelineShareSource =
    pipelineInfo.source === 'project'
      ? {
          kind: 'project',
          projectId: request.projectId,
          worktreeId: target.worktreeId,
          pipelineFilePath: pipelineInfo.filePath,
        }
      : { kind: 'stored', id: pipelineInfo.id, source: pipelineInfo.source };
  const rawPipeline = await readFile(pipelineInfo.filePath, 'utf8');
  // Lazy, like this service's other Cloud imports: the client pulls in the
  // Cloud account/auth chain, and this module sits on the portal's hot read
  // path (pipeline lists are rebuilt on every state refresh). It is a LOCAL
  // module, so the packaged bytecode main build resolves it the same way as
  // the static imports above — the packaged-resolution hazard applies to
  // third-party dynamic imports, not these.
  const {
    createSharedPipeline,
    deleteSharedPipeline,
    getSharedPipeline,
    publishPipelinePublicShare,
    updateSharedPipeline,
  } = await import('../pipelines/canopy-server-client');
  const shareRequest: CreateSharedPipelineRequest = {
    rawPipeline,
    shareScope: request.scope === 'public' ? 'private' : request.scope,
    ...(request.scope === 'team' && request.teamId
      ? { teamId: request.teamId }
      : {}),
    ...(request.scope === 'organization' && request.organizationId
      ? { organizationId: request.organizationId }
      : {}),
  };
  const createRequest = pipelineResourceContextEnabled()
    ? { ...shareRequest, sourcePipeline }
    : shareRequest;
  let created = false;
  let hasAffectedAutomations = false;
  let detail;
  if (pipelineInfo.remote) {
    try {
      hasAffectedAutomations = await getSharedPipelineSaveImpact(
        pipelineInfo.remote.remoteId,
      )
        .then((impact) => impact.automations.length > 0)
        .catch(() => true);
      const current = await getSharedPipeline(pipelineInfo.remote.remoteId);
      detail = await updateSharedPipeline(
        pipelineInfo.remote.remoteId,
        rawPipeline,
        {
          expectedContentHash: current.contentHash,
          preservePackage: true,
          shareScope: shareRequest.shareScope,
          ...(shareRequest.teamId ? { teamId: shareRequest.teamId } : {}),
          ...(shareRequest.organizationId
            ? { organizationId: shareRequest.organizationId }
            : {}),
          ...(request.scope !== 'public' &&
          current.publicShare &&
          !(await preserveOrganizationPublicLink(current.owner))
            ? {
                revokePublicShare: {
                  externalId: current.publicShare.externalId,
                  updatedAt: current.publicShare.updatedAt,
                },
              }
            : {}),
        },
      );
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('status' in error) ||
        error.status !== 404
      ) {
        throw error;
      }
      detail = await createSharedPipeline(createRequest);
      created = true;
    }
  } else {
    detail = await createSharedPipeline(createRequest);
    created = true;
  }

  if (
    sourcePipeline.kind === 'project' ||
    (sourcePipeline.kind === 'stored' && sourcePipeline.source === 'user')
  ) {
    const { writePipelineRemoteMetadata, writeProjectPipelineRemoteMetadata } =
      await import('../pipelines/pipeline-service');
    const remote = {
      accountId,
      remoteId: detail.id,
      contentHash: detail.contentHash,
      shareScope: detail.shareScope ?? shareRequest.shareScope ?? 'private',
      sharedAt: detail.updatedAt,
    };
    const linked =
      sourcePipeline.kind === 'project'
        ? writeProjectPipelineRemoteMetadata(
            sourcePipeline.pipelineFilePath,
            remote,
          )
        : writePipelineRemoteMetadata(sourcePipeline.id, remote);
    if (!linked.success) {
      if (created) await deleteSharedPipeline(detail.id);
      throw new Error(linked.error ?? 'Failed to store workflow share link.');
    }
  }

  if (request.scope === 'public') {
    try {
      const published = await publishPipelinePublicShare(detail.id);
      return {
        sharePath: published.sharePath,
        ...(hasAffectedAutomations
          ? {
              message:
                'People using this workflow in their automations will need to approve your changes before they run again.',
            }
          : {}),
      };
    } catch {
      // The private copy exists; only the link step failed. Never fall back to
      // publishing something the user did not ask for.
      return {
        message: hasAffectedAutomations
          ? 'Workflow shared privately, but the public link could not be created, and people using this workflow in their automations will need to approve your changes before they run again.'
          : 'Workflow shared privately, but the public link could not be created.',
      };
    }
  }
  if (request.scope === 'team' || request.scope === 'organization') {
    return {
      sharePath: pipelineSharePath(detail.id),
      ...(hasAffectedAutomations
        ? {
            message:
              'People using this workflow in their automations will need to approve your changes before they run again.',
          }
        : {}),
    };
  }
  return hasAffectedAutomations
    ? {
        message:
          'People using this workflow in their automations will need to approve your changes before they run again.',
      }
    : {};
}
