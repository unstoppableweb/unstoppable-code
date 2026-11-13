import type { CuratedPipelineDetail } from '@canopy/protocol/pipeline-catalog';
import type {
  ImportCuratedPipelineRequest,
  ListCuratedPipelinesRequest,
  ListCuratedPipelinesResult,
} from '@canopy/desktop-shared/types/curated-pipelines';
import { ipcRenderer } from '../ipc-router';
import type {
  CloudPipelineRunStartResult,
  PipelineCloudRunsAvailability,
  PipelineRunLocationRequest,
} from '@canopy/desktop-shared/types/pipeline-cloud-runs';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import type {
  ActionDefinition,
  PipelineAdvisorEvent,
  PipelineAdvisorReport,
  PipelineAdvisorSnapshot,
  PipelineData,
  PipelineExecutionStartResult,
  PipelineInfo,
  PipelineLookupRequest,
  PipelinePackageAnalysisSummary,
  PipelinePackageAnalyzeRequest,
  PipelinePackageCancelAnalysisRequest,
  PipelinePackageCreateSharedRequest,
  PipelinePackageInstallRecordV1,
  PipelinePackageInstallRequest,
  PipelinePackageInstallResult,
  PipelinePackageProgressEvent,
  PipelinePackageReadiness,
  PipelinePackageReadinessRequest,
  PipelineSaveInput,
  CancelMatrixVariantRequest,
  IPCResult,
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
  ResolvePluginCollectionsRequest,
  ResolvePluginCollectionsResponse,
  RetryMatrixJobRequest,
  SaveModelAliasPreferencesRequest,
  SaveModelAliasPreferencesResponse,
  SavePluginCollectionPreferencesRequest,
  SavePluginCollectionPreferencesResponse,
  SharedPipelineDeleteRequest,
  SharedPipelineDetail,
  SharedPipelineGetRequest,
  SharedPipelinePublicShareInfo,
  SharedPipelineSaveImpact,
  SharedPipelineWriteRequest,
} from '@canopy/execution-engine/types/pipeline';
import type {
  ExecutionEvent,
  ExecutePipelineRequestOptions,
  ExecutionOptions,
  ExecutionState,
  ExecutionSummary,
  PipelineQueueEvent,
  QueuedPipelineExecutionEntry,
  StepLogLocator,
  StepLogReadOptions,
  StepLogReadResult,
  StepOutputEvent,
} from '@canopy/execution-engine/node/pipelines/executor/types';

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

export interface PipelinesAPI {
  listCurated(
    request?: ListCuratedPipelinesRequest,
  ): Promise<IPCResult<ListCuratedPipelinesResult>>;
  getCurated(key: string): Promise<IPCResult<CuratedPipelineDetail>>;
  importCurated(
    request: ImportCuratedPipelineRequest,
  ): Promise<IPCResult<PipelineInfo>>;
  list(): Promise<IPCResult<PipelineInfo[]>>;
  discoverProject(cwd: string): Promise<IPCResult<PipelineInfo[]>>;
  get(request: PipelineLookupRequest): Promise<IPCResult<PipelineData>>;
  save(input: PipelineSaveInput): Promise<IPCResult<PipelineInfo>>;
  delete(id: string): Promise<IPCResult>;
  duplicate(request: PipelineLookupRequest): Promise<IPCResult<PipelineInfo>>;
  resolveAction(
    usesRef: string,
    repoPath?: string,
  ): Promise<IPCResult<ActionDefinition | null>>;
  listActions(): Promise<IPCResult<string[]>>;
  /**
   * A run with a `targetId` (CAN-6187): main starts it in the cloud through
   * the web core, or answers why not. It never runs on this computer.
   */
  execute(
    pipeline: PipelineData['content'],
    options: ExecutePipelineRequestOptions &
      PipelineRunLocationRequest & { targetId: string },
  ): Promise<CloudPipelineRunStartResult>;
  // Last, so `Parameters<typeof execute>` reads the local run's options.
  execute(
    pipeline: PipelineData['content'],
    options: ExecutePipelineRequestOptions & { targetId?: undefined },
  ): Promise<PipelineExecutionStartResult>;
  /** Whether the Run dialog may offer "Run on: Cloud" (CAN-6085 axis). */
  cloudRunsAvailability(): Promise<PipelineCloudRunsAvailability>;
  resume(
    executionId: string,
    options: ResumePipelineOptions,
  ): Promise<IPCResult<ExecutionState>>;
  resumeAutomation(
    executionId: string,
    options: ResumePipelineOptions,
  ): Promise<IPCResult<ExecutionState>>;
  retryExecution(executionId: string): Promise<IPCResult<ExecutionState>>;
  rerunExecution(executionId: string): Promise<IPCResult<ExecutionState>>;
  cancelExecution(executionId: string): Promise<IPCResult<ExecutionState>>;
  retryMatrixJob(request: RetryMatrixJobRequest): Promise<ExecutionState>;
  cancelMatrixVariant(
    request: CancelMatrixVariantRequest,
  ): Promise<ExecutionState>;
  /**
   * Cancel a pipeline execution that is currently queued (deferred by a
   * concurrency constraint). The backend removes the queue entry and emits
   * a `cancelled` `PipelineQueueEvent`. The result resolves once the queue
   * entry has been removed.
   */
  cancelQueuedExecution(queueId: string): Promise<IPCResult>;
  getExecution(executionId: string): Promise<IPCResult<ExecutionState | null>>;
  listExecutions(): Promise<IPCResult<ExecutionSummary[]>>;
  listQueuedExecutions(): Promise<IPCResult<QueuedPipelineExecutionEntry[]>>;
  setExecutionHidden(
    executionId: string,
    hidden: boolean,
  ): Promise<IPCResult<ExecutionState>>;
  /**
   * Reads one step log. `lines` is the default; `{ format: 'text' }` returns
   * the raw content with its byte length and, while this process owns the
   * file's positioned writer, its content generation, for byte-exact joins
   * with `StepOutputEvent.logPosition`.
   */
  readStepLog(
    locator: StepLogLocator,
    options?: StepLogReadOptions,
  ): Promise<IPCResult<StepLogReadResult>>;
  readReportFile(
    executionId: string,
    kind: 'text' | 'json',
  ): Promise<IPCResult<{ content: string; filePath: string }>>;
  /**
   * Resolve the plugin-collection preview for a pipeline. Returns both the
   * preview items (one per default) and the effective preferences the main
   * process used to compute them (see `ResolvePluginCollectionsResponse`).
   */
  resolvePluginCollections(
    request: ResolvePluginCollectionsRequest,
  ): Promise<IPCResult<ResolvePluginCollectionsResponse>>;
  /**
   * Summarize the capability refs (skills/plugins from `plugin_collections`)
   * declared by every locally readable pipeline, resolved against the
   * installed catalog. Powers the related-item sections on detail pages
   * (CAN-2382). Shared Cloud pipelines are excluded.
   */
  listCapabilityRefs(
    request?: ListPipelineCapabilityRefsRequest,
  ): Promise<IPCResult<ListPipelineCapabilityRefsResponse>>;
  /**
   * Save plugin-collection preferences for a pipeline. Returns
   * `{ ok: false, reason: 'missing-locator' }` when invoked against an
   * inline pipeline so the caller can disable its Save button instead of
   * silently failing.
   */
  savePluginCollectionPreferences(
    request: SavePluginCollectionPreferencesRequest,
  ): Promise<IPCResult<SavePluginCollectionPreferencesResponse>>;
  /**
   * Load saved per-pipeline model-alias preferences for a pipeline. The
   * returned preferences never contain `reset` markers (the backend store
   * normalizer strips them on save).
   */
  loadModelAliasPreferences(
    request: LoadModelAliasPreferencesRequest,
  ): Promise<IPCResult<LoadModelAliasPreferencesResponse>>;
  /**
   * Save model-alias preferences for a pipeline. Returns
   * `{ ok: false, reason: 'missing-locator' }` when invoked against an inline
   * pipeline so the caller can disable "save as defaults" instead of silently
   * failing. The request may carry `reset` markers, which the backend store
   * normalizer strips on write.
   */
  saveModelAliasPreferences(
    request: SaveModelAliasPreferencesRequest,
  ): Promise<IPCResult<SaveModelAliasPreferencesResponse>>;
  /**
   * List pipelines hosted on the configured Canopy Cloud backend. Mirrors
   * `GET /api/v1/desktop-app/pipelines` with cursor-based pagination. The local
   * IPC request does not carry a `serverId`; the main process resolves the
   * Cloud base URL from the build-time constant.
   */
  listShared(
    request: ListSharedPipelinesRequest,
  ): Promise<IPCResult<ListSharedPipelinesResponse>>;
  /**
   * Fetch a single shared pipeline (with raw source) from the configured
   * Canopy Cloud backend. Mirrors `GET /api/v1/desktop-app/pipelines/[pipelineId]`.
   */
  getShared(
    request: SharedPipelineGetRequest,
  ): Promise<IPCResult<SharedPipelineDetail>>;
  /**
   * Create a shared pipeline on the configured Canopy Cloud backend. Mirrors
   * `POST /api/v1/desktop-app/pipelines`.
   */
  createShared(
    request: SharedPipelineWriteRequest,
  ): Promise<IPCResult<SharedPipelineDetail>>;
  /**
   * Run a local dependency analysis for the pipeline document the publisher is
   * about to share. Returns the reviewable closure (resources, step bindings,
   * recipient environment requirements) plus any blockers that prevent a
   * content-complete `package` share. Private dependency bytes stay in the
   * main process; only metadata crosses this boundary.
   */
  analyzePackage(
    request: PipelinePackageAnalyzeRequest,
  ): Promise<IPCResult<PipelinePackageAnalysisSummary>>;
  /** Cancel an in-flight package analysis (modal close / re-analysis). */
  cancelPackageAnalysis(
    request: PipelinePackageCancelAnalysisRequest,
  ): Promise<IPCResult>;
  /**
   * Create a `package` shared pipeline: uploads the reviewed dependency
   * closure and commits it before the pipeline row is created. Never falls
   * back to a definition-only share on upload failure.
   */
  createSharedPackaged(
    request: PipelinePackageCreateSharedRequest,
  ): Promise<IPCResult<SharedPipelineDetail>>;
  /**
   * Subscribe to packaging progress (`Preparing files…`, `Uploading files…`,
   * `Finishing upload…`, `Retrying upload…`, `Publishing pipeline…`).
   */
  onPackageProgress(
    callback: (event: PipelinePackageProgressEvent) => void,
  ): () => void;
  /**
   * Local readiness of a pipeline's packaged content: which recipient
   * environment requirements are available, missing, or unknown. Unknown is
   * never reported as available.
   */
  getPackageReadiness(
    request: PipelinePackageReadinessRequest,
  ): Promise<IPCResult<PipelinePackageReadiness>>;
  /**
   * The local package-install ledger. Used by the deep-link landing to tell
   * "installed" from "update available" for a package share.
   */
  listPackageInstalls(): Promise<IPCResult<PipelinePackageInstallRecordV1[]>>;
  /**
   * Install a reviewed public package share: download, verify against the
   * pinned digest, then save the pipeline and its package together. All or
   * nothing — a failed download never leaves a YAML-only pipeline behind.
   */
  installPackageShare(
    request: PipelinePackageInstallRequest,
  ): Promise<IPCResult<PipelinePackageInstallResult>>;
  /**
   * Local automations a save of this shared pipeline would send back to
   * review. Desktop-only signal used to confirm a publisher's save.
   */
  getSharedUpdateImpact(
    remoteId: string,
  ): Promise<IPCResult<SharedPipelineSaveImpact>>;
  /**
   * Update an existing shared pipeline. Mirrors
   * `PUT /api/v1/desktop-app/pipelines/[pipelineId]`.
   */
  updateShared(
    request: SharedPipelineWriteRequest & { remoteId: string },
  ): Promise<IPCResult<SharedPipelineDetail>>;
  /**
   * Delete a shared pipeline. Mirrors
   * `DELETE /api/v1/desktop-app/pipelines/[pipelineId]`.
   */
  deleteShared(request: SharedPipelineDeleteRequest): Promise<IPCResult>;
  publishPublicShare(
    remoteId: string,
  ): Promise<IPCResult<SharedPipelinePublicShareInfo>>;
  revokePublicShare(remoteId: string): Promise<IPCResult>;
  /**
   * List the organizations the current API user belongs to on the configured
   * Canopy Cloud backend. Mirrors `GET /api/v1/desktop-app/organizations`.
   */
  listSharedOrganizations(
    request: ListSharedOrganizationsRequest,
  ): Promise<IPCResult<ListSharedOrganizationsResponse>>;
  /**
   * List the teams the current API user is an effective member of on the
   * configured Canopy Cloud backend. Mirrors `GET /api/v1/desktop-app/teams`.
   * Each team row carries its parent organization.
   */
  listSharedTeams(
    request: ListSharedTeamsRequest,
  ): Promise<IPCResult<ListSharedTeamsResponse>>;
  onExecutionEvent(callback: (event: ExecutionEvent) => void): () => void;
  onStepOutput(callback: (event: StepOutputEvent) => void): () => void;
  /**
   * Subscribe to pipeline queue lifecycle events. The renderer mirrors
   * these into `pipelineRunsStore` so queued cards appear when an entry
   * is enqueued, transition to running on `started`, and disappear when
   * cancelled or failed.
   */
  onQueueEvent(callback: (event: PipelineQueueEvent) => void): () => void;
  /**
   * Fetch the latest Pipeline Advisor snapshot for a single execution. Returns
   * `null` when no snapshot has been persisted yet. The input must be a
   * non-empty string; invalid input resolves to an IPC error result.
   */
  getAdvisorSnapshot(
    executionId: string,
  ): Promise<IPCResult<PipelineAdvisorSnapshot | null>>;
  /**
   * Start a Pipeline Advisor run for a persisted execution that does not already
   * have advisor data. The main process returns the persisted snapshot in its
   * initial/running state and pushes later updates through `onAdvisorEvent`.
   */
  runAdvisor(executionId: string): Promise<IPCResult<PipelineAdvisorSnapshot>>;
  /**
   * List the Pipeline Advisor snapshots for the given executions. Pass
   * `undefined` (or omit) to list every snapshot under the executions
   * directory. When `executionIds` is provided, every element must be a
   * non-empty string or the call resolves to an IPC error result.
   */
  listAdvisorSnapshots(
    executionIds?: string[],
  ): Promise<IPCResult<PipelineAdvisorSnapshot[]>>;
  /**
   * Subscribe to Pipeline Advisor snapshot mutations (state change, new
   * report, error). The preload layer validates each event against the
   * version 1 shape and silently drops malformed payloads — downstream
   * consumers may assume `event.snapshot.version === 1`.
   */
  onAdvisorEvent(callback: (event: PipelineAdvisorEvent) => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const PACKAGE_PROGRESS_STAGES: readonly string[] = [
  'Preparing package…',
  'Uploading dependencies…',
  'Publishing pipeline…',
  'Preparing files…',
  'Uploading files…',
  'Finishing upload…',
  'Retrying upload…',
];

/**
 * Main is the single producer on the package-progress channel, but the
 * preload still shape-checks so renderer consumers may treat `stage` as the
 * documented literal union without a cast.
 */
function isPipelinePackageProgressEvent(
  value: unknown,
): value is PipelinePackageProgressEvent {
  if (!isRecord(value)) return false;
  if (typeof value.stage !== 'string') return false;
  if (!PACKAGE_PROGRESS_STAGES.includes(value.stage)) return false;
  if (value.completed !== undefined && typeof value.completed !== 'number')
    return false;
  if (value.total !== undefined && typeof value.total !== 'number')
    return false;
  return true;
}

function isQueuedPipelineExecutionEntry(
  value: unknown,
): value is QueuedPipelineExecutionEntry {
  if (!isRecord(value)) {
    return false;
  }

  const triggerSource = value.trigger_source;
  return (
    typeof value.queueId === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.pipelineId === 'string' &&
    typeof value.pipelineName === 'string' &&
    value.reason === 'pipeline-concurrency' &&
    typeof value.reasonLabel === 'string' &&
    typeof value.enqueuedAt === 'string' &&
    (triggerSource === undefined || isRecord(triggerSource))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isExecutionStatus(value: unknown): value is ExecutionState['status'] {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'paused' ||
    value === 'success' ||
    value === 'failure' ||
    value === 'cancelled'
  );
}

function isPipelineAdvisorTurnKind(
  value: unknown,
): value is PipelineAdvisorReport['kind'] {
  return value === 'initial' || value === 'periodic' || value === 'final';
}

function isPipelineAdvisorHealthStatus(
  value: unknown,
): value is PipelineAdvisorReport['health']['status'] {
  return (
    value === 'healthy' ||
    value === 'watch' ||
    value === 'degraded' ||
    value === 'blocked' ||
    value === 'complete' ||
    value === 'unknown'
  );
}

function isPipelineAdvisorSeverity(
  value: unknown,
): value is PipelineAdvisorReport['inefficiencies'][number]['severity'] {
  return value === 'info' || value === 'warning' || value === 'critical';
}

function isPipelineAdvisorEta(
  value: unknown,
): value is PipelineAdvisorReport['eta'] {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.status !== 'available' &&
    value.status !== 'unknown' &&
    value.status !== 'complete'
  ) {
    return false;
  }

  if (
    value.confidence !== 'low' &&
    value.confidence !== 'medium' &&
    value.confidence !== 'high'
  ) {
    return false;
  }

  return (
    typeof value.rationale === 'string' &&
    isOptionalString(value.expectedCompletionAt) &&
    (value.remainingSeconds === undefined ||
      isFiniteNumber(value.remainingSeconds))
  );
}

function isPipelineAdvisorInefficiency(
  value: unknown,
): value is PipelineAdvisorReport['inefficiencies'][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isPipelineAdvisorSeverity(value.severity) &&
    typeof value.title === 'string' &&
    typeof value.evidence === 'string' &&
    isOptionalString(value.recommendation) &&
    isOptionalString(value.relatedJobId) &&
    isOptionalString(value.relatedStepId)
  );
}

function isPipelineAdvisorReport(
  value: unknown,
): value is PipelineAdvisorReport {
  if (!isRecord(value) || !isRecord(value.health)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.reportId === 'string' &&
    value.reportId.length > 0 &&
    typeof value.executionId === 'string' &&
    value.executionId.length > 0 &&
    isPipelineAdvisorTurnKind(value.kind) &&
    typeof value.generatedAt === 'string' &&
    isExecutionStatus(value.pipelineStatus) &&
    isPipelineAdvisorHealthStatus(value.health.status) &&
    isFiniteNumber(value.health.score) &&
    typeof value.health.summary === 'string' &&
    isStringArray(value.health.evidence) &&
    isStringArray(value.health.blockers) &&
    isPipelineAdvisorEta(value.eta) &&
    Array.isArray(value.inefficiencies) &&
    value.inefficiencies.every(isPipelineAdvisorInefficiency) &&
    typeof value.summary === 'string' &&
    isStringArray(value.recommendations)
  );
}

function isPipelineAdvisorLastError(
  value: unknown,
): value is NonNullable<PipelineAdvisorSnapshot['lastError']> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.message === 'string' &&
    typeof value.at === 'string' &&
    typeof value.retryable === 'boolean' &&
    isFiniteNumber(value.consecutiveFailures)
  );
}

function isPipelineAdvisorSnapshot(
  value: unknown,
): value is PipelineAdvisorSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  if (value.version !== 1) {
    return false;
  }

  if (
    typeof value.executionId !== 'string' ||
    value.executionId.length === 0 ||
    typeof value.executionDataDir !== 'string' ||
    typeof value.stateFilePath !== 'string' ||
    (value.provider !== 'claude' && value.provider !== 'codex') ||
    typeof value.model !== 'string' ||
    typeof value.thinkingLevel !== 'string' ||
    !isFiniteNumber(value.turnCount) ||
    !isFiniteNumber(value.backoffIndex) ||
    typeof value.lastUpdatedAt !== 'string'
  ) {
    return false;
  }

  const status = value.status;
  if (
    status !== 'starting' &&
    status !== 'running' &&
    status !== 'waiting' &&
    status !== 'failed' &&
    status !== 'completed' &&
    status !== 'cancelled'
  ) {
    return false;
  }

  if (
    value.sdkSessionId !== undefined &&
    typeof value.sdkSessionId !== 'string'
  ) {
    return false;
  }

  if (
    value.pipelineStartedAt !== undefined &&
    typeof value.pipelineStartedAt !== 'string'
  ) {
    return false;
  }

  if (
    value.nextUpdateAt !== undefined &&
    typeof value.nextUpdateAt !== 'string'
  ) {
    return false;
  }

  if (
    value.finalizedCompletedAt !== undefined &&
    typeof value.finalizedCompletedAt !== 'string'
  ) {
    return false;
  }

  if (
    !Array.isArray(value.reports) ||
    !value.reports.every(isPipelineAdvisorReport)
  ) {
    return false;
  }

  if (
    value.latestReport !== undefined &&
    !isPipelineAdvisorReport(value.latestReport)
  ) {
    return false;
  }

  if (
    value.lastError !== undefined &&
    !isPipelineAdvisorLastError(value.lastError)
  ) {
    return false;
  }

  return true;
}

function isPipelineAdvisorEvent(value: unknown): value is PipelineAdvisorEvent {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.executionId !== 'string' ||
    value.executionId.length === 0 ||
    typeof value.timestamp !== 'string'
  ) {
    return false;
  }

  return isPipelineAdvisorSnapshot(value.snapshot);
}

function isPipelineQueueEvent(value: unknown): value is PipelineQueueEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'queued') {
    return isQueuedPipelineExecutionEntry(value.entry);
  }

  if (value.type === 'started' || value.type === 'cancelled') {
    return typeof value.queueId === 'string';
  }

  if (value.type === 'failed') {
    return (
      typeof value.queueId === 'string' &&
      isQueuedPipelineExecutionEntry(value.entry) &&
      typeof value.error === 'string'
    );
  }

  return false;
}

export function createPipelinesAPI(): PipelinesAPI {
  let executionListInFlight: Promise<IPCResult<ExecutionSummary[]>> | null =
    null;
  const listExecutions = (): Promise<IPCResult<ExecutionSummary[]>> => {
    if (executionListInFlight) {
      return executionListInFlight;
    }

    const request: Promise<IPCResult<ExecutionSummary[]>> = ipcRenderer
      .invoke(PIPELINE_CHANNELS.LIST_EXECUTIONS)
      .then(
        (
          result: IPCResult<ExecutionSummary[]>,
        ): IPCResult<ExecutionSummary[]> => result,
      );
    executionListInFlight = request;
    const clear = (): void => {
      if (executionListInFlight === request) {
        executionListInFlight = null;
      }
    };
    void request.then(clear, clear);
    return request;
  };

  return {
    list: () => ipcRenderer.invoke(PIPELINE_CHANNELS.LIST),
    listCurated: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.CURATED_LIST, request),
    getCurated: (key) => ipcRenderer.invoke(PIPELINE_CHANNELS.CURATED_GET, key),
    importCurated: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.CURATED_IMPORT, request),
    discoverProject: (cwd) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.DISCOVER_PROJECT, cwd),
    get: (request) => ipcRenderer.invoke(PIPELINE_CHANNELS.GET, request),
    save: (input) => ipcRenderer.invoke(PIPELINE_CHANNELS.SAVE, input),
    delete: (id) => ipcRenderer.invoke(PIPELINE_CHANNELS.DELETE, id),
    duplicate: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.DUPLICATE, request),
    resolveAction: (usesRef, repoPath) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.RESOLVE_ACTION, usesRef, repoPath),
    listActions: () => ipcRenderer.invoke(PIPELINE_CHANNELS.LIST_ACTIONS),
    execute: (
      pipeline: PipelineData['content'],
      options: ExecutePipelineRequestOptions & PipelineRunLocationRequest,
    ) => ipcRenderer.invoke(PIPELINE_CHANNELS.EXECUTE, pipeline, options),
    cloudRunsAvailability: () =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.CLOUD_RUNS_AVAILABILITY),
    resume: (executionId, options) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.RESUME, executionId, options),
    resumeAutomation: (executionId, options) =>
      ipcRenderer.invoke(
        PIPELINE_CHANNELS.RESUME_AUTOMATION,
        executionId,
        options,
      ),
    retryExecution: (executionId) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.RETRY_EXECUTION, executionId),
    rerunExecution: (executionId) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.RERUN_EXECUTION, executionId),
    cancelExecution: (executionId) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.CANCEL_EXECUTION, executionId),
    retryMatrixJob: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.RETRY_MATRIX_JOB, request),
    cancelMatrixVariant: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.CANCEL_MATRIX_VARIANT, request),
    cancelQueuedExecution: (queueId) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.CANCEL_QUEUED_EXECUTION, queueId),
    getExecution: (executionId) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.GET_EXECUTION, executionId),
    listExecutions,
    listQueuedExecutions: () =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.LIST_QUEUED_EXECUTIONS),
    setExecutionHidden: (executionId, hidden) =>
      ipcRenderer.invoke(
        PIPELINE_CHANNELS.SET_EXECUTION_HIDDEN,
        executionId,
        hidden,
      ),
    readStepLog: (locator, options) =>
      options === undefined
        ? ipcRenderer.invoke(PIPELINE_CHANNELS.READ_STEP_LOG, locator)
        : ipcRenderer.invoke(PIPELINE_CHANNELS.READ_STEP_LOG, locator, options),
    readReportFile: (executionId, kind) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.READ_REPORT_FILE, executionId, kind),
    resolvePluginCollections: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.RESOLVE_PLUGIN_COLLECTIONS, request),
    listCapabilityRefs: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.LIST_CAPABILITY_REFS, request),
    savePluginCollectionPreferences: (request) =>
      ipcRenderer.invoke(
        PIPELINE_CHANNELS.SAVE_PLUGIN_COLLECTION_PREFERENCES,
        request,
      ),
    loadModelAliasPreferences: (request) =>
      ipcRenderer.invoke(
        PIPELINE_CHANNELS.LOAD_MODEL_ALIAS_PREFERENCES,
        request,
      ),
    saveModelAliasPreferences: (request) =>
      ipcRenderer.invoke(
        PIPELINE_CHANNELS.SAVE_MODEL_ALIAS_PREFERENCES,
        request,
      ),
    listShared: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.SHARED_LIST, request),
    getShared: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.SHARED_GET, request),
    createShared: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.SHARED_CREATE, request),
    analyzePackage: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.ANALYZE_PACKAGE, request),
    cancelPackageAnalysis: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.CANCEL_PACKAGE_ANALYSIS, request),
    createSharedPackaged: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.SHARED_CREATE_PACKAGED, request),
    onPackageProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isPipelinePackageProgressEvent(data)) callback(data);
      };
      ipcRenderer.on(PIPELINE_CHANNELS.PACKAGE_PROGRESS, handler);
      return () => {
        ipcRenderer.removeListener(PIPELINE_CHANNELS.PACKAGE_PROGRESS, handler);
      };
    },
    getPackageReadiness: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.PACKAGE_READINESS, request),
    listPackageInstalls: () =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.PACKAGE_INSTALLS_LIST),
    installPackageShare: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.INSTALL_PACKAGE_SHARE, request),
    getSharedUpdateImpact: (remoteId) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.SHARED_UPDATE_IMPACT, remoteId),
    updateShared: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.SHARED_UPDATE, request),
    deleteShared: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.SHARED_DELETE, request),
    publishPublicShare: (remoteId) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.SHARED_PUBLIC_PUBLISH, remoteId),
    revokePublicShare: (remoteId) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.SHARED_PUBLIC_REVOKE, remoteId),
    listSharedOrganizations: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.SHARED_ORGANIZATIONS_LIST, request),
    listSharedTeams: (request) =>
      ipcRenderer.invoke(PIPELINE_CHANNELS.SHARED_TEAMS_LIST, request),
    onExecutionEvent: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as ExecutionEvent);
      ipcRenderer.on(PIPELINE_CHANNELS.EXECUTION_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(PIPELINE_CHANNELS.EXECUTION_EVENT, handler);
      };
    },
    onStepOutput: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as StepOutputEvent);
      ipcRenderer.on(PIPELINE_CHANNELS.STEP_OUTPUT_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(
          PIPELINE_CHANNELS.STEP_OUTPUT_EVENT,
          handler,
        );
      };
    },
    onQueueEvent: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isPipelineQueueEvent(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(PIPELINE_CHANNELS.PIPELINE_QUEUE_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(
          PIPELINE_CHANNELS.PIPELINE_QUEUE_EVENT,
          handler,
        );
      };
    },
    getAdvisorSnapshot: (
      executionId,
    ): Promise<IPCResult<PipelineAdvisorSnapshot | null>> => {
      if (typeof executionId !== 'string' || executionId.length === 0) {
        return Promise.resolve({
          success: false,
          error: 'getAdvisorSnapshot requires a non-empty executionId string',
        });
      }
      return ipcRenderer.invoke(PIPELINE_CHANNELS.GET_ADVISOR, executionId);
    },
    runAdvisor: (executionId): Promise<IPCResult<PipelineAdvisorSnapshot>> => {
      if (typeof executionId !== 'string' || executionId.length === 0) {
        return Promise.resolve({
          success: false,
          error: 'runAdvisor requires a non-empty executionId string',
        });
      }
      return ipcRenderer.invoke(PIPELINE_CHANNELS.RUN_ADVISOR, executionId);
    },
    listAdvisorSnapshots: (
      executionIds,
    ): Promise<IPCResult<PipelineAdvisorSnapshot[]>> => {
      if (executionIds !== undefined && !isStringArray(executionIds)) {
        return Promise.resolve({
          success: false,
          error:
            'listAdvisorSnapshots executionIds must be an array of non-empty strings or undefined',
        });
      }
      return ipcRenderer.invoke(PIPELINE_CHANNELS.LIST_ADVISORS, executionIds);
    },
    onAdvisorEvent: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isPipelineAdvisorEvent(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(PIPELINE_CHANNELS.ADVISOR_EVENT, handler);
      return () => {
        ipcRenderer.removeListener(PIPELINE_CHANNELS.ADVISOR_EVENT, handler);
      };
    },
  };
}
