import type { ShareOperationResult } from '@canopy/protocol/sharing';
import type {
  CreateTrackedPlanRequest,
  DeleteTrackedPlanRequest,
  DetectedPlanEntry,
  DetectedPlansScanRequest,
  DetectedPlansScanResponse,
  DetectedPlansListRequest,
  DetectedPlanUpdateRequest,
  DetectedPlansUpdatedEvent,
  GenerateTrackedPlanDiagramsRequest,
  ImportTrackedPlanRequest,
  ImportTrackedPlanResponse,
  RefreshTrackedPlanCommentsRequest,
  TrackedPlanFileVisibilityRequest,
  SaveTrackedPlanCommentsRequest,
  ShareTrackedPlanRequest,
  TrackedPlanData,
  TrackedPlanGetRequest,
  TrackedPlanListRequest,
  UnshareTrackedPlanRequest,
  UpdateTrackedPlanRequest,
  WorktreeSummaryData,
} from '../types';

export const WORKTREE_SUMMARY_BATCH_SIZE_LIMIT = 500;

export type ChangedFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'type-changed'
  | 'untracked'
  | 'unknown';

export interface ChangedFileInfo {
  path: string;
  status: ChangedFileStatus;
  insertions: number;
  deletions: number;
  /** Trusted prior path supplied by the backend for rename/copy records. */
  previousPath?: string;
  /** Renderer-safe repository identity; never a repository filesystem path. */
  repoId?: string;
  /** Renderer-safe display name; never a repository filesystem path. */
  repoName?: string;
  /**
   * Binary content: git reports no line counts for it, so `insertions` and
   * `deletions` are 0 and carry no meaning (REG-3024).
   */
  binary?: boolean;
}

export interface TurnDiffTreeRef {
  startTree: string;
  endTree: string;
  repoId?: string;
  startHeadCommitSha?: string;
}

export interface TurnDiffData {
  files: ChangedFileInfo[];
  totalInsertions: number;
  totalDeletions: number;
  capturedAt: number;
  treeRefs?: TurnDiffTreeRef[];
}

export interface TurnFileDiffRequest {
  projectId: string;
  worktreeId: string;
  filePath: string;
  startTree: string;
  endTree: string;
  repoId?: string;
}

export interface TurnFileDiffResponse {
  oldValue: string;
  newValue: string;
  filePath: string;
  truncated: boolean;
  binary: boolean;
  imagePreview?: FileDiffImagePreview;
}

export interface FileDiffImagePreview {
  oldDataUrl?: string;
  newDataUrl?: string;
}

export type BackgroundProcessStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

export type BackgroundProcessKind = 'agent' | 'bash' | 'task' | 'workflow';

export interface BackgroundProcess {
  id: string;
  chatId: string;
  toolUseId: string;
  taskId?: string;
  /** Output-poller key when the launch receipt and provider task ids differ. */
  outputTaskId?: string;
  toolName: string;
  kind: BackgroundProcessKind;
  description: string;
  /** Safe, bounded label that may be projected to App Advisor. */
  advisorDescription?: string;
  command?: string;
  prompt?: string;
  status: BackgroundProcessStatus;
  startedAt: number;
  updatedAt: number;
  /**
   * When the process last became completed, failed or stopped. Unlike
   * `updatedAt`, output the poller drains after the end never moves it.
   */
  endedAt?: number;
  summary?: string;
  lastDescription?: string;
  outputFile?: string;
  outputLines: string[];
  canStop: boolean;
  /** Workflow run id (`wf_...`) parsed from the Workflow tool receipt. */
  runId?: string;
  /** Absolute `<session>/subagents/workflows/<runId>` dir from the receipt. */
  transcriptDir?: string;
  /** Absolute workflow script path from the receipt. */
  scriptFile?: string;
}

export interface WorkflowPhaseInfo {
  title: string;
  detail?: string;
}

export interface WorkflowAgentProgress {
  index: number;
  label: string;
  phaseIndex: number;
  phaseTitle: string;
  agentId: string;
  agentType: string;
  model?: string;
  /** Free-form SDK state, e.g. 'queued' | 'running' | 'done' | 'error'. */
  state: string;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  /** Epoch ms the agent started, when known. */
  startedAt?: number;
  /** Epoch ms the agent settled (done or failed), when known. */
  settledAt?: number;
  /** Provider error text for a failed agent. */
  error?: string;
}

export interface WorkflowRunState {
  runId: string;
  taskId?: string;
  status: string;
  workflowName?: string;
  summary?: string;
  durationMs?: number;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  phases: WorkflowPhaseInfo[];
  agents: WorkflowAgentProgress[];
  result?: string;
  /** Epoch ms the run started, when known. */
  startedAt?: number;
  /**
   * Live reads only: the latest modification time of the run's journal and
   * agent transcripts, so a host can tell a quiet run from an abandoned one.
   */
  lastActivityAt?: number;
}

export interface ActivityReadWorkflowRunRequest {
  transcriptDir: string;
  runId: string;
}

export interface ActivityReadWorkflowAgentTranscriptRequest {
  transcriptDir: string;
  agentId: string;
}

export interface ActivityReadWorkflowAgentTranscriptResponse {
  lines: string[];
  /** True when earlier transcript lines were left out of `lines`. */
  truncated?: boolean;
  /**
   * The agent's first task message, read from the start of its transcript and
   * capped at 64 KiB, so it is available even when `lines` is a tail.
   */
  initialPrompt?: string;
}

export interface ActivityChangedFilesResponse {
  uncommitted: ChangedFileInfo[];
  committed: ChangedFileInfo[];
}

export interface ActivityRevertFileRequest {
  projectId: string;
  worktreeId: string;
  filePath: string;
  status: ChangedFileStatus;
  previousPath?: string;
  repoId?: string;
}

export interface ActivityChangedFilesRequest {
  projectId: string;
  worktreeId: string;
}

export interface ActivityStopBgProcessRequest {
  projectId: string;
  worktreeId: string;
  chatId: string;
  taskId: string;
}

export type ActivityStopBgProcessOutcome =
  | 'stopped'
  | 'already-finished'
  | 'session-ended';

export interface ActivityStartOutputPollingRequest {
  projectId: string;
  worktreeId: string;
  chatId: string;
  taskId: string;
  outputFile: string;
}

export interface ActivityStopOutputPollingRequest {
  projectId: string;
  worktreeId: string;
  chatId: string;
  taskId: string;
}

export interface ActivityBgProcessOutputEvent {
  projectId: string;
  worktreeId: string;
  chatId: string;
  taskId: string;
  outputFile: string;
  lines: string[];
}

export interface ActivityLiveBgTasksRequest {
  projectId: string;
  worktreeId: string;
}

/**
 * Main-process view of one chat's live background tasks. `sessionActive` is
 * whether a provider session currently exists for the chat; `liveTasks` is
 * the SDK `background_tasks_changed` level set (REPLACE semantics) merged with
 * the `task_started`/`task_notification` edge stream for that session's
 * current CLI process. Absent chats have no live session.
 */
export interface ActivityLiveBgTask {
  taskId: string;
  toolUseId?: string;
  description?: string;
  taskType?: string;
  workflowName?: string;
  spawnDepth?: number;
  isBackgrounded?: boolean;
  status?: 'pending' | 'running' | 'paused';
  phase?: string;
  summary?: string;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
  /** False when Canopy cannot stop the task through its provider (Codex). */
  stoppable?: false;
}

export interface ActivityLiveBgTasksChatState {
  sessionActive: boolean;
  liveTasks: ActivityLiveBgTask[];
}

export interface ActivityLiveBgTasksResponse {
  chats: Record<string, ActivityLiveBgTasksChatState>;
}

/**
 * Pushed by main whenever one chat's live task set changes. Absolute state:
 * it replaces whatever the renderer knew for the chat, so replaying it is
 * safe. `sessionActive: false` (with no tasks) means the chat has no live
 * provider session.
 */
export interface ActivityLiveBgTasksChangedEvent extends ActivityLiveBgTasksChatState {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export interface ActivityReadFullOutputRequest {
  outputFile: string;
}

export interface ActivityReadFullOutputResponse {
  lines: string[];
  truncated: boolean;
}

export interface WorktreeSummaryLoadRequest {
  projectId: string;
  worktreeId: string;
}

export interface WorktreeSummaryLoadBatchRequest {
  worktrees: WorktreeSummaryLoadRequest[];
}

export type WorktreeSummaryLoadBatchResponse = Record<
  string,
  WorktreeSummaryData | null
>;

export interface WorktreeSummaryRefreshRequest {
  projectId: string;
  worktreeId: string;
}

export interface WorktreeSummaryUpdatedEvent {
  projectId: string;
  worktreeId: string;
  summary: WorktreeSummaryData;
}

export interface WorktreeSummaryGeneratingEvent {
  projectId: string;
  worktreeId: string;
  generating: boolean;
}

export type TrackedPlansUpdatedEvent =
  | {
      projectId: string;
      worktreeId: string;
      plan: TrackedPlanData;
      /** Absent on legacy senders and treated as an upsert. */
      change?: 'upsert';
    }
  | {
      projectId: string;
      worktreeId: string;
      /** Removal stays addressable when the deleted plan cannot be read. */
      planId: string;
      plan?: TrackedPlanData;
      change: 'remove';
    };

export type FileDiffSource = 'uncommitted' | 'committed' | 'combined';

export interface ActivityFileDiffRequest {
  projectId: string;
  worktreeId: string;
  filePath: string;
  source: FileDiffSource;
  repoId?: string;
}

export interface ActivityFileDiffResponse {
  oldValue: string;
  newValue: string;
  filePath: string;
  source: FileDiffSource;
  truncated: boolean;
  binary: boolean;
  imagePreview?: FileDiffImagePreview;
}

export interface ActivityPanelApi {
  getChangedFiles(
    request: ActivityChangedFilesRequest,
  ): Promise<ActivityChangedFilesResponse>;
  revertFile(request: ActivityRevertFileRequest): Promise<void>;
  loadWorktreeSummary(
    request: WorktreeSummaryLoadRequest,
  ): Promise<WorktreeSummaryData | null>;
  loadWorktreeSummaries(
    request: WorktreeSummaryLoadBatchRequest,
  ): Promise<WorktreeSummaryLoadBatchResponse>;
  refreshWorktreeSummary(request: WorktreeSummaryRefreshRequest): Promise<void>;
  stopBgProcess(
    request: ActivityStopBgProcessRequest,
  ): Promise<ActivityStopBgProcessOutcome>;
  startOutputPolling(request: ActivityStartOutputPollingRequest): Promise<void>;
  stopOutputPolling(request: ActivityStopOutputPollingRequest): Promise<void>;
  readFullOutput(
    request: ActivityReadFullOutputRequest,
  ): Promise<ActivityReadFullOutputResponse>;
  listLiveBgTasks(
    request: ActivityLiveBgTasksRequest,
  ): Promise<ActivityLiveBgTasksResponse>;
  onLiveBgTasksChanged(
    cb: (event: ActivityLiveBgTasksChangedEvent) => void,
  ): () => void;
  readWorkflowRun(
    request: ActivityReadWorkflowRunRequest,
  ): Promise<WorkflowRunState | null>;
  readWorkflowAgentTranscript(
    request: ActivityReadWorkflowAgentTranscriptRequest,
  ): Promise<ActivityReadWorkflowAgentTranscriptResponse>;
  getFileDiff(
    request: ActivityFileDiffRequest,
  ): Promise<ActivityFileDiffResponse>;
  getTurnFileDiff(request: TurnFileDiffRequest): Promise<TurnFileDiffResponse>;
  plans: {
    list(request: TrackedPlanListRequest): Promise<TrackedPlanData[]>;
    get(request: TrackedPlanGetRequest): Promise<TrackedPlanData | null>;
    create(request: CreateTrackedPlanRequest): Promise<TrackedPlanData>;
    update(request: UpdateTrackedPlanRequest): Promise<TrackedPlanData | null>;
    delete(request: DeleteTrackedPlanRequest): Promise<void>;
    saveComments(
      request: SaveTrackedPlanCommentsRequest,
    ): Promise<TrackedPlanData | null>;
    generateDiagrams(
      request: GenerateTrackedPlanDiagramsRequest,
    ): Promise<void>;
    share(
      request: ShareTrackedPlanRequest,
    ): Promise<ShareOperationResult<TrackedPlanData | null>>;
    /** Stop sharing a plan (CAN-5904); the answered plan has no `share`. */
    unshare(
      request: UnshareTrackedPlanRequest,
    ): Promise<ShareOperationResult<TrackedPlanData | null>>;
    import(
      request: ImportTrackedPlanRequest,
    ): Promise<ImportTrackedPlanResponse>;
    refreshComments(
      request: RefreshTrackedPlanCommentsRequest,
    ): Promise<TrackedPlanData | null>;
    setFileVisibility(request: TrackedPlanFileVisibilityRequest): Promise<void>;
  };
  onBgProcessOutput(
    cb: (event: ActivityBgProcessOutputEvent) => void,
  ): () => void;
  onWorktreeSummaryUpdated(
    cb: (event: WorktreeSummaryUpdatedEvent) => void,
  ): () => void;
  onWorktreeSummaryGenerating(
    cb: (event: WorktreeSummaryGeneratingEvent) => void,
  ): () => void;
  onTrackedPlansUpdated(
    cb: (event: TrackedPlansUpdatedEvent) => void,
  ): () => void;
  detectedPlans: {
    scan(request: DetectedPlansScanRequest): Promise<DetectedPlansScanResponse>;
    list(request: DetectedPlansListRequest): Promise<DetectedPlanEntry[]>;
    update(request: DetectedPlanUpdateRequest): Promise<DetectedPlanEntry[]>;
  };
  onDetectedPlansUpdated(
    callback: (event: DetectedPlansUpdatedEvent) => void,
  ): () => void;
}
