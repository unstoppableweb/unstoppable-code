import { WorkerPipelineSurvivalAssessmentSchema } from '@canopy/protocol/canopy-core';
import { withSharedProjectDiscovery } from '../pipelines/shared-project-discovery';
import { windowAgentInterfacePort } from '../agents/agent-interface-port';
import {
  isPipelineDefinitionNotFound,
  listDesktopPipelines,
  PIPELINE_DEFINITION_REMOTE_CONTROL_CALLER,
  pipelineSourceFailure,
  readDesktopPipeline,
  readDesktopPipelineSnapshot,
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
import { isThinkingLevel } from '@canopy/desktop-shared/types';
import {
  codexSpeedFastMode,
  isCodexSpeed,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import type {
  AgentModelConfig,
  RemoteControlEntityEnvelope,
  RemoteControlPipelineCancelPayload,
  RemoteControlPipelineExecutionListPayload,
  RemoteControlPipelineExecutionListResult,
  RemoteControlPipelineExecutionGetPayload,
  RemoteControlPipelineGetPayload,
  RemoteControlPipelineGetResult,
  RemoteControlPipelineListPayload,
  RemoteControlPipelineLogRequestPayload,
  RemoteControlPipelineRun,
  RemoteControlPipelineRunPayload,
  RemoteControlPipelineRerunPayload,
  RemoteControlPipelineResumePayload,
  RemoteControlPipelineRetryPayload,
  RemoteControlPipelineRunVariant,
  RemoteControlPipelinePauseCheckpoint,
  RemoteControlPipelineSummary,
} from '@canopy/desktop-shared/types';
import { access, open, readFile, stat } from 'node:fs/promises';
import {
  exceedsSerializedBudget,
  measureSerializedBytes,
} from '../lib/serialized-size-budget';
import {
  hasOnlyLocalPipelineTriggers,
  portablePipelineTriggerTypes,
} from '@canopy/protocol/pipelines';
import { normalizeInstalledAt } from '@canopy/protocol/installed-items';
import { sanitizePipelineSummaryForSync } from './sync-safe-pipeline-summary';
import { pipelineDocumentRevision } from '../pipelines/pipeline-file-revision';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { getDefaultShellTypeForCurrentProcess } from '@canopy/execution-engine/node/pipelines/default-shell';
import { join, resolve } from 'node:path';
import {
  validateId,
  validatePipelineDefinitionLocator,
} from '../lib/validation';
import { validatePipelineRuntimeIdentifier } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  executionOwnerKind,
  stepBillingRoute,
} from '@canopy/execution-engine/pipelines/step-billing-route';
import { assertNotSplitLocked } from './split-lock-service';
import { RemoteControlServiceError } from './remote-control-service-error';
import { buildPipelineFailureDebugPrompt } from '@canopy/desktop-shared/lib/pipelineFailureDebugPrompt';
import { isPathInside } from '../lib/path-safety';
import {
  getDataDir,
  getWorktreeDir,
  getWorkspaceWorktreeRootRepoDir,
} from '../lib/paths';
import { readAllSidebarItems } from '../lib/sidebar-items';
import {
  UNATTENDED_PROJECT_DISCOVERY_LIMITS,
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
import {
  loadCanopyCloudAccountPublicState,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { authorShareRemoteIds } from '@canopy/protocol/sharing';
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
  REMOTE_CONTROL_EVENT_BATCH_MAX_BYTES,
  projectRemoteControlPipelineDispatchInputs,
  projectRemoteControlPipelineMetadata,
  worktreeScopedParentLocalId,
  type RemoteControlPipelineChatFollowUpPreparePayload,
  type RemoteControlPipelineContentReadPayload,
  type RemoteControlPipelineContentReadResult,
} from '@canopy/protocol/remote-control/shell';
import {
  agentTranscriptDocument,
  pipelineContentPage,
  plainLogDocument,
  reportDocument,
  type PipelineContentDocument,
} from './pipeline-content';
import {
  getPipelineRunChatLinks,
  type PipelineRunChatLinksScope,
} from './pipeline-run-chat-links';
import { logMainProcessError } from '../lib/main-process-logging';
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
  REMOTE_CONTROL_EVENT_BATCH_MAX_BYTES / 8,
);
const STREAM_STEP_TAILS_MAX_ENTRIES = 256;
const STREAM_STEP_TAILS_TRUNCATION_MARKER =
  '[Earlier live step output omitted to fit the transfer limit]\n';
const REMOTE_CONTROL_PAUSE_REQUESTS_MAX_BYTES = 64 * 1024;
const pipelineRunUpdateListeners = new Set<
  (run: RemoteControlPipelineRun) => void
>();
const remoteControlPipelineMutationQueues = new Map<string, Promise<void>>();
const remoteControlPipelineProjectionQueues = new Map<string, Promise<void>>();

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

function serializeRemoteControlPipelineMutation<T>(
  executionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return serializeKeyedOperation(
    remoteControlPipelineMutationQueues,
    executionId,
    operation,
  );
}

function projectRemoteControlPipelineRun(
  executionId: string,
  projection: () => Promise<RemoteControlPipelineRun | null>,
  options: {
    portalCommandId?: string;
    onRunUpdate?: (run: RemoteControlPipelineRun) => void;
  } = {},
): Promise<RemoteControlPipelineRun | null> {
  return serializeKeyedOperation(
    remoteControlPipelineProjectionQueues,
    executionId,
    async () => {
      const run = await projection();
      if (run) notifyPipelineRunUpdate(run, options);
      return run;
    },
  );
}

export function subscribePipelineRunUpdates(
  listener: (run: RemoteControlPipelineRun) => void,
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
): Promise<Pick<RemoteControlPipelineRun, 'chatTurns'>> {
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

interface RequestedRemoteControlStep {
  jobId: string;
  stepId: string;
  attempt: number;
  iteration: number;
  recovery: number;
  outputTail: string;
}

function mapRunStatus(status: string): RemoteControlPipelineRun['status'] {
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
function normalizeRemoteControlModelConfig(
  request: RemoteControlPipelineRunPayload,
): AgentModelConfig | undefined {
  const requested = request.modelConfig;
  const requestedSpeed: unknown = requested?.speed;
  if (requestedSpeed !== undefined) {
    if (!isCodexSpeed(requestedSpeed)) {
      throw new RemoteControlServiceError(
        'invalid_payload',
        'modelConfig.speed must be standard, fast, or ultrafast.',
      );
    }
    if (
      typeof requested?.fastMode === 'boolean' &&
      requested.fastMode !== codexSpeedFastMode(requestedSpeed)
    ) {
      throw new RemoteControlServiceError(
        'invalid_payload',
        'modelConfig.fastMode must match modelConfig.speed.',
      );
    }
  }
  const speed = readCodexSpeedRecord(requested, request.codexFastModeEnabled);
  if (speed === 'ultrafast') {
    throw new RemoteControlServiceError(
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

function normalizeRemoteControlPipelineEvent(
  request: RemoteControlPipelineRunPayload,
): {
  planId?: string;
  eventName?: 'task_ready' | 'plan_ready';
  eventData?: {
    task_ready?: { task_text?: string };
    plan_ready?: { plan_text?: string; planId?: string };
  };
} {
  if (request.eventName === undefined) {
    if (request.eventData !== undefined) {
      throw new RemoteControlServiceError(
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
        throw new RemoteControlServiceError(
          'invalid_payload',
          'task_ready requires a non-empty task_text.',
        );
      }
      if (request.planId !== undefined) {
        throw new RemoteControlServiceError(
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
        throw new RemoteControlServiceError(
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
      throw new RemoteControlServiceError(
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
    throw new RemoteControlServiceError(
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
    throw new RemoteControlServiceError(
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
    throw new RemoteControlServiceError(
      'not_found',
      'Workflow execution not found.',
    );
  }
  if (
    (scope.projectId && state.project_id !== scope.projectId) ||
    (scope.worktreeId && state.worktree_id !== scope.worktreeId)
  ) {
    throw new RemoteControlServiceError(
      'not_found',
      'Workflow execution not found.',
    );
  }
}

/** Largest serialized summary the synced pipeline document may carry. */
const STRICT_PIPELINE_SUMMARY_MAX_BYTES = 16 * 1024;

/** Bounds for unattended (inventory sync) discovery across every worktree. */
const STRICT_DISCOVERY_LIMITS: DiscoverProjectPipelinesLimits =
  UNATTENDED_PROJECT_DISCOVERY_LIMITS;

export interface PipelineListTarget {
  workspaceLocalId: string;
  worktreeLocalId: string;
  cwd: string;
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
  request: RemoteControlPipelineListPayload,
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
async function listRemoteControlPipelineInfos(scope: {
  workspaceId: string;
  worktreeId: string;
}): Promise<PipelineInfo[]> {
  const list = (
    sources: ('bundled' | 'user' | 'project')[],
  ): Promise<PipelineInfo[]> =>
    listDesktopPipelines(
      { sources, scope },
      PIPELINE_DEFINITION_REMOTE_CONTROL_CALLER,
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
  return mergeRemoteControlPipelineInfos(
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
function mergeRemoteControlPipelineInfos(
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
  RemoteControlPipelineSummary,
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
): Promise<RemoteControlPipelineSummary[]> {
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
  published: readonly (RemoteControlPipelineSummary | null)[],
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
  request: RemoteControlPipelineListPayload = {},
): Promise<RemoteControlPipelineSummary[]> {
  if (request.worktreeId !== undefined) {
    try {
      validateId(request.worktreeId, 'worktreeId');
    } catch (error) {
      throw new RemoteControlServiceError(
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
    infos = await listRemoteControlPipelineInfos(scope);
    return summarizePipelines(target, infos, {
      loadDefinition: (pipeline) =>
        readDesktopPipelineSnapshot(
          pipeline.id,
          scope,
          PIPELINE_DEFINITION_REMOTE_CONTROL_CALLER,
        ).then(
          (read) => ({ pipeline: read.data.content, document: read.document }),
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
  pipelines: RemoteControlPipelineSummary[];
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
  const merged = mergeRemoteControlPipelineInfos(
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
  const pipelines: RemoteControlPipelineSummary[] = [];
  for (const summary of summaries) {
    if (
      summary &&
      // CAN-5239: the optional install date never decides whether a row
      // fits, so dating a pipeline cannot remove it from the inventory.
      !exceedsSerializedBudget(
        withoutInstalledAt(summary),
        STRICT_PIPELINE_SUMMARY_MAX_BYTES,
      )
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

function withoutInstalledAt(
  summary: RemoteControlPipelineSummary,
): RemoteControlPipelineSummary {
  const undated = { ...summary };
  delete undated.installedAt;
  return undated;
}

/**
 * Whether the desktop can share this pipeline. It needs YAML on disk to
 * publish; a pipeline whose source is already Cloud-hosted is not re-shared.
 */
function canShareRemoteControlPipeline(pipeline: PipelineInfo): boolean {
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

const sameSet = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean =>
  JSON.stringify([...(a ?? [])].sort()) ===
  JSON.stringify([...(b ?? [])].sort());

/** Reread definitions larger than this publish no revision (CAN-7513). */
const REVISION_DEFINITION_MAX_SERIALIZED_BYTES = 1024 * 1024;

/**
 * Whether a reread definition still has the name, triggers and scopes its
 * discovery record shows (CAN-7513). One that doesn't, is too large to
 * normalize, or fails to normalize publishes no revision, so Send reviews
 * it; none of these fail the listing.
 */
function rereadMatchesDiscovery(
  definition: Pipeline,
  pipeline: PipelineInfo,
): boolean {
  if (definition.name !== pipeline.name) return false;
  if (!sameSet(getTriggerTypes(definition.on), pipeline.triggerTypes))
    return false;
  if (
    measureSerializedBytes(definition, REVISION_DEFINITION_MAX_SERIALIZED_BYTES)
      .exceeded
  )
    return false;
  try {
    return sameSet(
      normalizePipeline(definition, {
        defaultShell: getDefaultShellTypeForCurrentProcess(),
      }).scope ?? ['directory'],
      pipeline.scopes ?? ['directory'],
    );
  } catch {
    return false;
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
    /**
     * Reads a listed definition; the file on disk by default. A read that
     * returns the document it authorized lets the row publish that
     * document's revision (CAN-7513); the default read publishes none.
     */
    loadDefinition?: (
      pipeline: PipelineInfo,
    ) => Promise<{ pipeline: Pipeline; document?: string } | null>;
  } = {},
): Promise<(RemoteControlPipelineSummary | null)[]> {
  const load: (
    pipeline: PipelineInfo,
  ) => Promise<{ pipeline: Pipeline; document?: string } | null> =
    options.loadDefinition ??
    ((pipeline: PipelineInfo): Promise<{ pipeline: Pipeline } | null> =>
      pipeline.filePath
        ? loadProjectPipelineFromDisk(pipeline.filePath).then(
            (loaded) => ({ pipeline: loaded }),
            (): null => null,
          )
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
        const loaded =
          pipeline.filePath &&
          (pipeline.triggerTypes?.includes('dispatch') ||
            pipeline.triggerTypes?.includes('task_ready') ||
            pipeline.triggerTypes?.includes('plan_ready'))
            ? await load(pipeline)
            : null;
        const definition = loaded?.pipeline ?? null;
        // The row's inputs and its revision come from the one document core
        // authorized and parsed (CAN-7513). Its name, triggers and scopes
        // come from discovery's earlier read; a document that disagrees with
        // them was edited in between, so the row publishes no revision and
        // Send reviews it.
        const revision =
          loaded?.document !== undefined &&
          rereadMatchesDiscovery(loaded.pipeline, pipeline)
            ? pipelineDocumentRevision(loaded.document)
            : undefined;
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
        // CAN-5239: only a stored user pipeline is an installed copy, dated
        // by its store entry's first save. An unknown or invalid date is
        // left out; bundled, checkout and shared rows are never dated.
        const installedAt =
          pipeline.source === 'user'
            ? normalizeInstalledAt(pipeline.createdAt)
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
          ...(canShareRemoteControlPipeline(pipeline)
            ? { shareable: true }
            : {}),
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
          ...(installedAt === undefined ? {} : { installedAt }),
          // `PipelineInputDef.default` is wider than the browser-safe portal
          // projection (`RemoteControlPipelineInputDefinition` stays scalar and keeps
          // its four input types). Narrow through the protocol's own projector
          // rather than widening the external portal contract.
          ...(taskReadyInputs && Object.keys(taskReadyInputs).length > 0
            ? projectRemoteControlPipelineMetadata({ taskReadyInputs })
            : {}),
          ...(planReadyInputs && Object.keys(planReadyInputs).length > 0
            ? projectRemoteControlPipelineMetadata({ planReadyInputs })
            : {}),
          // Lets the web check that a workflow chosen earlier still runs the
          // same steps before it starts it (CAN-7513).
          ...(revision ? { revision } : {}),
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
    throw new RemoteControlServiceError('not_found', 'Workflow not found.');
  }
  return { pipeline: stored.data.content, pipelineInfo };
}

export async function getPipeline(
  request: RemoteControlPipelineGetPayload,
): Promise<RemoteControlPipelineGetResult> {
  try {
    validatePipelineDefinitionLocator(request.pipelineId, 'pipelineId');
    validateId(request.projectId, 'projectId');
    if (request.worktreeId !== undefined) {
      validateId(request.worktreeId, 'worktreeId');
    }
  } catch (error) {
    throw new RemoteControlServiceError(
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
      PIPELINE_DEFINITION_REMOTE_CONTROL_CALLER,
    ).then(
      (data) => data.content,
      (): null => null,
    );
    if (!pipeline) {
      throw new RemoteControlServiceError('not_found', 'Workflow not found.');
    }
    // Same `plan_ready` scoping `runPipeline` enforces. This path exists only
    // to hydrate a plan-picker row, and only `plan_ready` shares are ever
    // listed — so without it a bare `portal.pipeline.get` would read back the
    // full definition of ANY cloud pipeline the desktop's account can see,
    // including ones no surface ever offered.
    if (!getTriggerTypes(pipeline.on).includes('plan_ready')) {
      throw new RemoteControlServiceError('not_found', 'Workflow not found.');
    }
    const planReadyInputs = getTriggerInputDefs(pipeline.on, 'plan_ready');
    return {
      definition: toPipelineDefinitionViewModelWithoutCanonicalYaml(pipeline),
      // `PipelineInputDef.default` is wider than the browser-safe portal
      // projection; narrow through the protocol's own projector rather than
      // widening the external contract.
      ...(planReadyInputs && Object.keys(planReadyInputs).length > 0
        ? projectRemoteControlPipelineMetadata({ planReadyInputs })
        : {}),
    };
  }
  const target = await resolvePipelineDefinitionTarget(
    request.projectId,
    request.worktreeId,
  );
  if (!target) {
    throw new RemoteControlServiceError('not_found', 'Workflow not found.');
  }
  let pipeline: Pipeline;
  try {
    pipeline = (
      await readDesktopPipeline(
        request.pipelineId,
        { workspaceId: request.projectId, worktreeId: target.worktreeId },
        PIPELINE_DEFINITION_REMOTE_CONTROL_CALLER,
      )
    ).content;
  } catch (error) {
    if (isPipelineDefinitionNotFound(error))
      throw new RemoteControlServiceError('not_found', 'Workflow not found.');
    throw pipelineSourceFailure(error);
  }
  // The Portal never sees `workflow` (CAN-5782): a pipeline that starts only
  // from the Workflows page reads as missing, as it is missing from the list,
  // and a mixed one is described by its portable triggers.
  const triggerTypes = getTriggerTypes(pipeline.on);
  if (hasOnlyLocalPipelineTriggers(triggerTypes)) {
    throw new RemoteControlServiceError('not_found', 'Workflow not found.');
  }
  const remoteControlPipeline: Pipeline = {
    ...pipeline,
    on: setTriggerTypes(
      pipeline.on,
      portablePipelineTriggerTypes(triggerTypes),
    ),
  };
  return {
    definition: toPipelineDefinitionViewModelWithoutCanonicalYaml(
      remoteControlPipeline,
    ),
    // Dispatch inputs ride `get` rather than every list row so the worktree
    // snapshot never re-reads every pipeline's YAML (CAN-3174).
    ...(getTriggerTypes(pipeline.on).includes('dispatch')
      ? projectRemoteControlPipelineDispatchInputs(
          getTriggerInputDefs(pipeline.on, 'dispatch'),
        )
      : {}),
  };
}

export async function listPipelineRuns(
  request: RemoteControlPipelineListPayload & {
    workspaceLocalId?: string;
    workspaceId?: string;
    worktreeLocalId?: string;
  } = {},
): Promise<RemoteControlPipelineRun[]> {
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
        ? stateToRemoteControlRun(state)
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
  request: RemoteControlPipelineRunPayload,
  options: {
    portalCommandId?: string;
    onRunUpdate?: (run: RemoteControlPipelineRun) => void;
  } = {},
): Promise<{ executionId: string }> {
  try {
    validatePipelineDefinitionLocator(request.pipelineId, 'pipelineId');
  } catch (error) {
    // A readable `invalid_payload` is the downgrade story (CAN-3021): a synced
    // document that still offers a shared row to a desktop which no longer
    // understands `shared:` ids fails here, inline in the picker, instead of
    // degrading to an opaque `execution_failed`.
    throw new RemoteControlServiceError(
      'invalid_payload',
      error instanceof Error ? error.message : 'Invalid pipeline locator.',
    );
  }
  const remoteControlModelConfig = normalizeRemoteControlModelConfig(request);
  const remoteControlEvent = normalizeRemoteControlPipelineEvent(request);
  if (!request.projectId || !request.worktreeId) {
    throw new RemoteControlServiceError(
      'invalid_payload',
      'projectId and worktreeId are required.',
    );
  }
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  if (request.definitionWorktreeId !== undefined) {
    validateId(request.definitionWorktreeId, 'definitionWorktreeId');
  }
  // CAN-6187: a run located elsewhere never runs on this computer.
  if (request.targetId !== undefined) {
    const { remoteControlRunLocationRefusal } =
      await import('../pipelines/cloud-pipeline-runs');
    throw new RemoteControlServiceError(
      'invalid_payload',
      remoteControlRunLocationRefusal(String(request.targetId)),
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
        throw new RemoteControlServiceError(
          'not_found',
          'Pipeline execution receipt does not match this command.',
        );
      }
      await projectRemoteControlPipelineRun(
        receipt.id,
        () => stateToRemoteControlRun(receipt),
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
      throw new RemoteControlServiceError('not_found', 'Workflow not found.');
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
        throw new RemoteControlServiceError(
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
    // A run chosen against another worktree's copy finds the workflow
    // there; the start reads and checks that copy (CAN-7513).
    const definitionCwd =
      request.definitionWorktreeId === undefined
        ? cwd
        : await resolvePipelineCwd(
            request.projectId,
            request.definitionWorktreeId,
          );
    ({ pipeline, pipelineInfo } = await resolveLocalPipeline(
      definitionCwd,
      request.pipelineId,
    ));
  }
  if (!pipeline) {
    throw new RemoteControlServiceError('not_found', 'Workflow not found.');
  }
  // A Portal start with no event runs as `dispatch`; the Portal never lists a
  // pipeline that can only start from the Workflows page, so refuse one sent
  // anyway. `plan_ready`- and `task_ready`-only pipelines keep starting from
  // the sidebar picker with no event, as before.
  if (
    remoteControlEvent.eventName === undefined &&
    hasOnlyLocalPipelineTriggers(getTriggerTypes(pipeline.on))
  ) {
    throw new RemoteControlServiceError(
      'invalid_payload',
      'This workflow can only start from the Workflows page.',
    );
  }
  if (
    remoteControlEvent.eventName !== undefined &&
    !getTriggerTypes(pipeline.on).includes(remoteControlEvent.eventName)
  ) {
    throw new RemoteControlServiceError(
      'invalid_payload',
      `The selected workflow does not support ${remoteControlEvent.eventName}.`,
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
    throw new RemoteControlServiceError(
      'invalid_payload',
      'The selected workflow does not support plan_ready.',
    );
  }
  const remoteControlForwarder = createRemoteControlPipelineForwarder(options);
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
      // Checked by the start against the bytes it reads and runs (CAN-7513).
      ...(request.expectedRevision !== undefined
        ? { expectedRevision: request.expectedRevision }
        : {}),
      ...(request.definitionWorktreeId !== undefined
        ? { definitionWorktreeId: request.definitionWorktreeId }
        : {}),
      modelConfig: remoteControlModelConfig,
      planId: remoteControlEvent.planId,
      eventName: remoteControlEvent.eventName,
      eventData: remoteControlEvent.eventData,
      initiationSource: 'portal',
      initiator: { kind: 'portal' },
      executionId: options.portalCommandId,
    },
    onEvent: remoteControlForwarder.onEvent,
    onStepOutput: remoteControlForwarder.onStepOutput,
  });
  if (!result.success) {
    throw new RemoteControlServiceError('execution_failed', result.error);
  }
  await getPipelineExecution({ executionId: result.data.id }, options);
  return { executionId: result.data.id };
}

function createRemoteControlPipelineForwarder(options: {
  portalCommandId?: string;
  onRunUpdate?: (run: RemoteControlPipelineRun) => void;
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
  ): RequestedRemoteControlStep[] => {
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
          await projectRemoteControlPipelineRun(
            pendingExecutionId,
            async () => {
              const state = await loadExecutionState(
                pendingExecutionId,
                getPipelineExecutionsDir(),
              );
              const requestedSteps =
                requestedStepsForExecution(pendingExecutionId);
              return stateToRemoteControlRun(state, {
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
      void projectRemoteControlPipelineRun(
        event.executionId,
        () => stateToRemoteControlRun(event.state),
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

async function cancelPipelineUnlocked(
  request: RemoteControlPipelineCancelPayload & PipelineExecutionScope,
  options: {
    portalCommandId?: string;
    getWindow?: () => BrowserWindow | null;
  } = {},
): Promise<RemoteControlPipelineRun | null> {
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
  return projectRemoteControlPipelineRun(
    request.executionId,
    () => stateToRemoteControlRun(state),
    options,
  );
}

export function cancelPipeline(
  request: RemoteControlPipelineCancelPayload & PipelineExecutionScope,
  options: {
    portalCommandId?: string;
    getWindow?: () => BrowserWindow | null;
  } = {},
): Promise<RemoteControlPipelineRun | null> {
  return serializeRemoteControlPipelineMutation(request.executionId, () =>
    cancelPipelineUnlocked(request, options),
  );
}

type PipelineControlOptions = {
  portalCommandId?: string;
  onRunUpdate?: (run: RemoteControlPipelineRun) => void;
};

function remoteControlPipelineActionRuntime(
  state: ExecutionState,
  options: PipelineControlOptions,
): WorktreeActionRuntime {
  if (!state.project_id || !state.worktree_id) {
    throw new RemoteControlServiceError(
      'invalid_target',
      'Pipeline execution is missing its workspace target.',
    );
  }
  const forwarder = createRemoteControlPipelineForwarder(options);
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
    interfacePort: windowAgentInterfacePort(() => null),
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
  throw new RemoteControlServiceError(
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
    throw new RemoteControlServiceError(
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

async function updatedRemoteControlRun(
  executionId: string,
  scope: PipelineExecutionScope,
  options: PipelineControlOptions,
): Promise<RemoteControlPipelineRun> {
  const run = await projectRemoteControlPipelineRun(
    executionId,
    async () => {
      const state = await loadExecutionState(
        executionId,
        getPipelineExecutionsDir(),
      );
      assertExecutionMatchesScope(state, scope);
      return stateToRemoteControlRun(state);
    },
    options,
  );
  if (!run) {
    throw new RemoteControlServiceError(
      'not_found',
      'Workflow execution not found.',
    );
  }
  return run;
}

function hasRemoteControlCommandReceipt(
  state: ExecutionState,
  commandId: string | undefined,
): boolean {
  return (
    commandId !== undefined &&
    state.portal_command_ids?.includes(commandId) === true
  );
}

async function projectRemoteControlCommandReceipt(
  state: ExecutionState,
  options: PipelineControlOptions,
): Promise<RemoteControlPipelineRun> {
  const run = await projectRemoteControlPipelineRun(
    state.id,
    () => stateToRemoteControlRun(state),
    options,
  );
  if (!run) {
    throw new RemoteControlServiceError(
      'not_found',
      'Pipeline execution receipt could not be projected.',
    );
  }
  return run;
}

async function resumePipelineUnlocked(
  request: RemoteControlPipelineResumePayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<RemoteControlPipelineRun> {
  if (options.portalCommandId) {
    validateId(options.portalCommandId, 'portalCommandId');
  }
  const state = await loadScopedPipelineExecution(request);
  if (hasRemoteControlCommandReceipt(state, options.portalCommandId)) {
    return projectRemoteControlCommandReceipt(state, options);
  }
  if (!canResumeExecution(state)) {
    throw new RemoteControlServiceError(
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
    remoteControlPipelineActionRuntime(state, options),
  );
  throwForPipelineActionFailure(response);
  return updatedRemoteControlRun(request.executionId, request, options);
}

export function resumePipeline(
  request: RemoteControlPipelineResumePayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<RemoteControlPipelineRun> {
  return serializeRemoteControlPipelineMutation(request.executionId, () =>
    resumePipelineUnlocked(request, options),
  );
}

async function retryPipelineUnlocked(
  request: RemoteControlPipelineRetryPayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<RemoteControlPipelineRun> {
  if (options.portalCommandId) {
    validateId(options.portalCommandId, 'portalCommandId');
  }
  const state = await loadScopedPipelineExecution(request);
  if (hasRemoteControlCommandReceipt(state, options.portalCommandId)) {
    return projectRemoteControlCommandReceipt(state, options);
  }
  if (!canRetryExecution(state)) {
    throw new RemoteControlServiceError(
      'execution_failed',
      'Only failed or cancelled root workflow executions can be retried.',
    );
  }
  const response = await retryExecution(
    {
      type: 'pipeline.execution_retry',
      executionId: request.executionId,
    },
    remoteControlPipelineActionRuntime(state, options),
  );
  throwForPipelineActionFailure(response);
  return updatedRemoteControlRun(request.executionId, request, options);
}

export function retryPipeline(
  request: RemoteControlPipelineRetryPayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<RemoteControlPipelineRun> {
  return serializeRemoteControlPipelineMutation(request.executionId, () =>
    retryPipelineUnlocked(request, options),
  );
}

async function rerunPipelineUnlocked(
  request: RemoteControlPipelineRerunPayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<RemoteControlPipelineRun> {
  if (!request.projectId || !request.worktreeId) {
    throw new RemoteControlServiceError(
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
        throw new RemoteControlServiceError(
          'not_found',
          'Pipeline rerun receipt does not match this command.',
        );
      }
      const run = await projectRemoteControlPipelineRun(
        receipt.id,
        () => stateToRemoteControlRun(receipt),
        options,
      );
      if (!run) {
        throw new RemoteControlServiceError(
          'not_found',
          'Pipeline rerun receipt could not be projected.',
        );
      }
      return run;
    }
  }
  const state = await loadScopedPipelineExecution(request);
  if (!canRerunExecution(state) || !hasRerunReplayData(state)) {
    throw new RemoteControlServiceError(
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
    remoteControlPipelineActionRuntime(state, options),
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
    throw new RemoteControlServiceError(
      'execution_failed',
      'Pipeline rerun did not return an execution id.',
    );
  }
  return updatedRemoteControlRun(executionId, request, options);
}

export function rerunPipeline(
  request: RemoteControlPipelineRerunPayload & PipelineExecutionScope,
  options: PipelineControlOptions = {},
): Promise<RemoteControlPipelineRun> {
  return serializeRemoteControlPipelineMutation(request.executionId, () =>
    rerunPipelineUnlocked(request, options),
  );
}

export async function listPipelineExecutions(
  request: RemoteControlPipelineExecutionListPayload,
): Promise<RemoteControlPipelineExecutionListResult> {
  validatePipelineExecutionScope(request);
  if (!request.projectId || !request.worktreeId) {
    throw new RemoteControlServiceError(
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
      interfacePort: windowAgentInterfacePort(() => null),
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
        return stateToRemoteControlRun(state);
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
  request: RemoteControlPipelineExecutionGetPayload & PipelineExecutionScope,
  options: { portalCommandId?: string } = {},
): Promise<RemoteControlPipelineRun | null> {
  validateId(request.executionId, 'executionId');
  validatePipelineExecutionScope(request);
  const state = await loadExecutionState(
    request.executionId,
    getPipelineExecutionsDir(),
  );
  assertExecutionMatchesScope(state, request);
  const run = state ? await stateToRemoteControlRun(state) : null;
  if (run) notifyPipelineRunUpdate(run, options);
  return run;
}

export function getPipelineExecution(
  request: RemoteControlPipelineExecutionGetPayload & PipelineExecutionScope,
  options: { portalCommandId?: string } = {},
): Promise<RemoteControlPipelineRun | null> {
  return serializeKeyedOperation(
    remoteControlPipelineProjectionQueues,
    request.executionId,
    () => getPipelineExecutionUnlocked(request, options),
  );
}

async function getPipelineLogUnlocked(
  request: RemoteControlPipelineLogRequestPayload & PipelineExecutionScope,
  options: { portalCommandId?: string } = {},
): Promise<{
  lines: string[];
  run?: RemoteControlPipelineRun;
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
    throw new RemoteControlServiceError(
      'not_found',
      'Workflow step not found.',
    );
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
  const run = await stateToRemoteControlRun(state, {
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
  request: RemoteControlPipelineLogRequestPayload & PipelineExecutionScope,
  options: { portalCommandId?: string } = {},
): Promise<{
  lines: string[];
  run?: RemoteControlPipelineRun;
}> {
  return serializeKeyedOperation(
    remoteControlPipelineProjectionQueues,
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
  output: RemoteControlPipelineChatFollowUpPreparePayload['output'],
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
  request: RemoteControlPipelineChatFollowUpPreparePayload,
): Promise<{ prompt: string }> {
  const state = await loadScopedPipelineExecution(request);
  if (
    !(await resolvePipelineDefinitionTarget(
      request.projectId,
      request.worktreeId,
    ))
  ) {
    throw new RemoteControlServiceError(
      'not_found',
      "This run's worktree is no longer available.",
    );
  }
  const reference = pipelineChatFollowUpReference(state, request.output);
  if (!reference) {
    throw new RemoteControlServiceError(
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
  request: RemoteControlPipelineContentReadPayload,
): Promise<RemoteControlPipelineContentReadResult> {
  const state = await loadScopedPipelineExecution(request);
  const source = request.source;
  const executionsDir = getPipelineExecutionsDir();
  const confined = (path: string): string => {
    const resolved = resolve(path);
    if (!isPathInsideExecutionsDir(executionsDir, resolved)) {
      throw new RemoteControlServiceError(
        'not_found',
        'This content is unavailable.',
      );
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
      throw new RemoteControlServiceError(
        'not_found',
        'Workflow step not found.',
      );
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
    throw new RemoteControlServiceError(
      'invalid_payload',
      'Invalid content source.',
    );
  }

  const unavailable = (): RemoteControlServiceError =>
    new RemoteControlServiceError(
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
    throw new RemoteControlServiceError(
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
    throw new RemoteControlServiceError(
      'invalid_payload',
      'Invalid content offset.',
    );
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
    throw new RemoteControlServiceError(
      'not_found',
      'Workflow execution not found.',
    );
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

export async function stateToRemoteControlRun(
  state: Awaited<ReturnType<typeof loadExecutionState>>,
  options: {
    requestedStep?: RequestedRemoteControlStep;
    requestedSteps?: readonly RequestedRemoteControlStep[];
    streamProjection?: boolean;
  } = {},
): Promise<RemoteControlPipelineRun | null> {
  if (!state?.project_id || !state.worktree_id) return null;
  const jobs = await buildRemoteControlPipelineJobs(
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
  let remainingPauseRequestBytes = REMOTE_CONTROL_PAUSE_REQUESTS_MAX_BYTES;
  const pendingPauses: RemoteControlPipelinePauseCheckpoint[] = (
    state.pending_pauses ?? []
  ).map((checkpoint) => {
    const identity: RemoteControlPipelinePauseCheckpoint = {
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
    survival: WorkerPipelineSurvivalAssessmentSchema.safeParse(
      state.survival_assessment,
    ).data,
    pausedAt: state.paused_at,
    ownerKind: executionOwnerKind(state.execution_context),
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

function findRequestedRemoteControlStep(
  requestedSteps: readonly RequestedRemoteControlStep[] | undefined,
  jobId: string,
  stepId: string,
  job: JobResult,
  step: StepResult,
): RequestedRemoteControlStep | undefined {
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

async function buildRemoteControlPipelineJobs(
  state: ExecutionState,
  requestedSteps?: readonly RequestedRemoteControlStep[],
  streamProjection = false,
): Promise<NonNullable<RemoteControlPipelineRun['jobs']>> {
  return Promise.all(
    Object.entries(state.pipeline_snapshot.jobs).map(
      async ([logicalJobId, logicalJob]) => {
        const group = state.job_groups?.[logicalJobId];
        const projectPhysical = async (
          physicalJobId: string,
        ): Promise<RemoteControlPipelineRunVariant> => {
          const definition =
            state.job_definitions?.[physicalJobId] ?? logicalJob;
          const result = state.jobs[physicalJobId];
          const steps = await Promise.all(
            definition.steps.map(async (stepDef) => {
              const step = result?.steps[stepDef.id];
              const requestedStep =
                step !== undefined &&
                result !== undefined &&
                findRequestedRemoteControlStep(
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
              const billingRoute = stepBillingRoute(step?.outputs);
              return {
                stepId: stepDef.id,
                name: stepDef.name ?? stepDef.id,
                status: mapRunStatus(step?.status ?? 'pending'),
                attempt: currentAttempt(result),
                iteration: currentIteration(result),
                ...(outputTail ? { outputTail } : {}),
                ...(billingRoute ? { billingRoute } : {}),
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

export function pipelineToRemoteControlEntity(
  pipeline: RemoteControlPipelineSummary,
): RemoteControlEntityEnvelope {
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
  run: RemoteControlPipelineRun,
  options: {
    portalCommandId?: string;
    onRunUpdate?: (run: RemoteControlPipelineRun) => void;
  } = {},
): void {
  options.onRunUpdate?.(run);
  pipelineRunUpdateListeners.forEach((listener): void => {
    // A throwing subscriber must not gate other listeners; this registry is
    // observational only.
    try {
      listener(run);
    } catch {
      // Ignore listener failures.
    }
  });
}
