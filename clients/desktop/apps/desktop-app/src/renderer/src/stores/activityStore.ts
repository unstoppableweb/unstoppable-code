import { create } from 'zustand';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { unwrapShareOperationResult } from '@/lib/sharing/share-operation-result';
import {
  isWorkflowLaunchReceipt,
  parseWorkflowReceipt,
  extractWorkflowNameFromScript,
} from '@/components/chat/workflow-receipt';
import { useProjectsStore } from './projectsStore';
import {
  registerLoadedChangedFilesRefresh,
  registerWorktreeActivityCleanup,
} from './changedFilesRefreshRuntime';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKTREE_SUMMARY_BATCH_SIZE_LIMIT,
} from '@canopy/desktop-shared/types';
import {
  backgroundProcessKindForTaskType,
  backgroundProcessKindForTool,
  isAsyncAgentLaunchText,
} from '@canopy/desktop-shared/lib/background-work';
import type {
  ActivityChangedFilesResponse,
  ActivityLiveBgTasksChangedEvent,
  ActivityLiveBgTasksChatState,
  ActivityStartOutputPollingRequest,
  ActivityStopOutputPollingRequest,
  AgentAuditEntry,
  BackgroundProcess,
  ChangedFileInfo,
  DetectedPlanEntry,
  DetectedPlanStatus,
  ShareRunRequest,
  ShareRunEligibilityResponse,
  ShareRunResponse,
  ShareTrackedPlanRequest,
  TrackedPlanData,
  TrackedPlanListWithSkippedResult,
  UnshareRunResponse,
  WorktreeSummaryLoadBatchResponse,
  WorktreeSummaryData,
} from '@canopy/desktop-shared/types';
import {
  setLiveBackgroundTaskPushHandler,
  useLiveBackgroundTaskStore,
} from './liveBackgroundTaskStore';
import type { LiveBackgroundTaskChatEntry } from './liveBackgroundTaskStore';
import { isWebCoreTaskProcess } from './chat/web-core/agent-task-processes';

const MAX_OUTPUT_LINES = 200;
const TERMINAL_OUTPUT_STOP_DELAY_MS = 2000;
const BACKGROUND_PROCESS_HISTORY_LIMIT = 200;
const BACKGROUND_PROCESS_TRANSCRIPT_CONCURRENCY = 6;
type ActivityLiveBgTask = ActivityLiveBgTasksChatState['liveTasks'][number];

interface ToolUseMeta {
  chatId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  timestamp: number;
  /**
   * Task id the SDK event stream correlated with this tool use. Recorded even
   * for foreground tasks, because that is the only way a later
   * `task_updated { patch: { is_backgrounded: true } }` — which carries no
   * `tool_use_id` — can find the Bash call that timed out and was moved to
   * the background.
   */
  taskId?: string;
}

/**
 * Summary shown when neither the audit trail nor main's live background-task
 * replica can account for a process the transcript rebuilt as unfinished.
 */
const UNRESOLVED_TASK_SUMMARY = 'Ended before completion was recorded';

interface WorktreeActivityData {
  bgProcesses: BackgroundProcess[];
  toolUses: Record<string, ToolUseMeta>;
}

interface ActivityMutationResult {
  startPolling?: ActivityStartOutputPollingRequest;
  stopPolling?: ActivityStopOutputPollingRequest;
  delayedStopPolling?: ActivityStopOutputPollingRequest;
}

interface ReconstructableBlock {
  type: string;
  toolUseId?: string;
  toolName?: string;
  input?: string;
  output?: string;
  isError?: boolean;
  subtype?: string;
  task_id?: string;
  taskId?: string;
  tool_use_id?: string;
  parent_tool_use_id?: string;
  status?: string;
  description?: string;
  summary?: string;
  output_file?: string;
  patch?: unknown;
  tasks?: unknown;
}

interface ReconstructableMessage {
  timestamp: number;
  blocks: ReconstructableBlock[];
}

interface ReconstructableTab {
  id: string;
  messages: ReconstructableMessage[];
}

interface ImportModalRequest {
  projectId: string;
  worktreeId: string;
  /** Chat whose detected plan files list first and get the import notice. */
  originChatId?: string;
}

/**
 * Target worktree for the split-PR pre-flight modal. All four launch
 * surfaces (worktree-row menu item, PR activity panel primary button, PR
 * status bar button, and the post-failure "Plan new split" button — see
 * `WorktreeItem.tsx`, `PullRequestSection.tsx`, `PrStatusBar.tsx`) call
 * `openSplitPreflight` instead of invoking `planSplitPr` directly, so the
 * modal always gates the workflow start regardless of which surface the user
 * clicked. `SplitPreflightModalHost` (mounted once in `App.tsx`, mirroring
 * `ImportPlanModalHost`) is the single place that renders the modal and
 * starts the workflow, so a future change to what "Start" does (Task A5 swaps
 * `planSplitPr` for the lockdown-aware `startSplitWorkflow`) only touches
 * that one call site. The App Advisor `github.split_pr` dispatch also routes
 * through `openSplitPreflight` (it cannot acquire the split lock itself), so it
 * is NOT an exempt direct-launch site. See the enumerated call-site map on
 * `SplitPreflightModalHost` in `SplitPreflightModal.tsx` for the sole remaining
 * exempt direct re-plan call site.
 */
interface SplitPreflightTarget {
  projectId: string;
  worktreeId: string;
}

interface ActivityState {
  panelExpanded: boolean;
  changedFiles: Record<string, ActivityChangedFilesResponse>;
  bgProcesses: Record<string, BackgroundProcess[]>;
  toolUses: Record<string, Record<string, ToolUseMeta>>;
  worktreeSummaries: Record<string, WorktreeSummaryData>;
  trackedPlans: Record<string, TrackedPlanData[]>;
  /** Stored plan records each worktree's list left out (CAN-6666). */
  trackedPlanSkipped: Record<string, number>;
  /**
   * Worktree keys whose full tracked-plan inventory has loaded
   * (`loadTrackedPlans` / `setTrackedPlans`). `trackedPlans[key]` alone does
   * not mean that: single-plan inserts (`upsertTrackedPlan`,
   * `ensureTrackedPlanLoaded`) create partial lists, so a plan missing from an
   * unflagged list is not evidence of deletion.
   */
  trackedPlanInventoryLoaded: Record<string, true>;
  detectedPlans: Record<string, DetectedPlanEntry[]>;
  summaryGenerating: Record<string, boolean>;
  worktreeSummaryEnabled: boolean;
  importModalRequest: ImportModalRequest | null;
  splitPreflight: SplitPreflightTarget | null;

  openImportModal: (request: ImportModalRequest) => void;
  closeImportModal: () => void;

  openSplitPreflight: (projectId: string, worktreeId: string) => void;
  closeSplitPreflight: () => void;

  setPanelExpanded: (expanded: boolean) => void;
  togglePanelExpanded: () => void;
  setChangedFiles: (
    projectId: string,
    worktreeId: string,
    files: ActivityChangedFilesResponse,
  ) => void;
  /**
   * Replace one chat's background processes in its scope: a cloud chat's,
   * which the web core reports as agent task rows rather than main.
   */
  setChatBackgroundProcesses: (
    projectId: string,
    worktreeId: string,
    chatId: string,
    processes: readonly BackgroundProcess[],
  ) => void;
  setWorktreeSummary: (key: string, data: WorktreeSummaryData) => void;
  setTrackedPlans: (key: string, plans: TrackedPlanData[]) => void;
  upsertTrackedPlan: (plan: TrackedPlanData) => void;
  /**
   * Drop a plan the main process reports as deleted (CAN-1305). Portal-initiated
   * `portal.plan.delete` reaches this renderer only as a `trackedPlansUpdated`
   * event carrying `change: 'remove'`; without it the Plans panel keeps showing
   * a card whose plan no longer exists until the worktree is reselected.
   */
  removeTrackedPlan: (
    projectId: string,
    worktreeId: string,
    planId: string,
  ) => void;
  setDetectedPlans: (
    projectId: string,
    worktreeId: string,
    entries: DetectedPlanEntry[],
  ) => void;
  loadDetectedPlans: (projectId: string, worktreeId: string) => Promise<void>;
  scanDetectedPlans: (
    projectId: string,
    worktreeId: string,
    chatId: string,
    candidatePaths: string[],
  ) => Promise<DetectedPlanEntry[]>;
  updateDetectedPlan: (
    projectId: string,
    worktreeId: string,
    entryId: string,
    patch: {
      status?: DetectedPlanStatus;
      bannerSeen?: boolean;
      importedPlanId?: string;
    },
  ) => Promise<void>;
  setSummaryGenerating: (key: string, generating: boolean) => void;
  setWorktreeSummaryEnabled: (enabled: boolean) => void;
  loadWorktreeSummary: (projectId: string, worktreeId: string) => Promise<void>;
  loadWorktreeSummaries: (
    worktrees: Array<{ projectId: string; worktreeId: string }>,
  ) => Promise<void>;
  loadTrackedPlans: (projectId: string, worktreeId: string) => Promise<void>;
  /**
   * Apply a plan record returned by an authoritative write (for example a
   * review update). A `loadTrackedPlans` response whose request started
   * before this write keeps the store's current record for the plan instead
   * of restoring the older listed one.
   */
  commitTrackedPlanUpdate: (plan: TrackedPlanData) => void;
  /**
   * Record that a plan changed in main without a returned record, so list
   * requests already in flight cannot restore its earlier state.
   */
  noteTrackedPlanWrite: (
    projectId: string,
    worktreeId: string,
    planId: string,
  ) => void;
  /**
   * Resolve one tracked plan, fetching it when it is not in the store yet and
   * inserting it into its worktree's list. Concurrent calls for the same plan
   * share one request. Resolves `null` when the plan does not exist.
   */
  ensureTrackedPlanLoaded: (
    projectId: string,
    worktreeId: string,
    planId: string,
  ) => Promise<TrackedPlanData | null>;
  togglePlanHidden: (plan: TrackedPlanData) => Promise<void>;
  shareTrackedPlan: (
    projectId: string,
    worktreeId: string,
    planId: string,
    options?: {
      shareScope?: ShareTrackedPlanRequest['shareScope'];
      teamId?: string;
      organizationId?: string;
    },
  ) => Promise<TrackedPlanData | null>;
  /**
   * Stop sharing a tracked plan (CAN-5904): main deletes the cloud copy and
   * clears the local `share`. Rejects with the server's message when the
   * delete fails, leaving the share intact.
   */
  unshareTrackedPlan: (
    projectId: string,
    worktreeId: string,
    planId: string,
  ) => Promise<TrackedPlanData | null>;
  /**
   * Explicitly share a finished agent session as a run to Canopy Cloud
   * at private, team, or organization scope. The click is its own consent: it
   * proceeds even when ambient telemetry sync is Off, ingesting the referenced
   * turns/plans on demand first. Resolves with the create result (`externalId`
   * is `null` when the session could not be shared).
   */
  shareRun: (
    projectId: string,
    worktreeId: string,
    chatId: string,
    options: {
      shareScope: NonNullable<ShareRunRequest['shareScope']>;
      teamId?: string;
      organizationId?: string;
    },
  ) => Promise<ShareRunResponse>;
  /**
   * Whether this session still has shareable activity. Probed before the share
   * modal offers an audience, so a chat whose audit entries aged out of the
   * retention window is explained rather than failed.
   */
  checkShareEligibility: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ) => Promise<ShareRunEligibilityResponse>;
  /**
   * Unshare (delete) a previously shared run (CAN-395). Thin client keyed by
   * session identity; the main-process handler recomputes the deterministic
   * idempotency key server-side. Clearing the local "Shared" indicator and
   * toasting are the caller's responsibility (see `ShareSessionControl`).
   */
  unshareRun: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ) => Promise<UnshareRunResponse>;
  importTrackedPlan: (
    projectId: string,
    worktreeId: string,
    filePath?: string,
    repoId?: string,
  ) => Promise<TrackedPlanData | null>;
  refreshWorktreeSummary: (
    projectId: string,
    worktreeId: string,
  ) => Promise<void>;
  handleToolUseBlock: (
    projectId: string,
    worktreeId: string,
    chatId: string,
    toolUseId: string,
    toolName: string,
    input: unknown,
    timestamp?: number,
  ) => void;
  handleToolResultBlock: (
    projectId: string,
    worktreeId: string,
    chatId: string,
    toolUseId: string,
    content: unknown,
    isError: boolean,
    timestamp?: number,
  ) => void;
  handleSdkSystemEvent: (
    projectId: string,
    worktreeId: string,
    chatId: string,
    data: Record<string, unknown>,
    timestamp?: number,
  ) => void;
  appendBgProcessOutput: (event: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    taskId: string;
    outputFile: string;
    lines: string[];
  }) => void;
  reconstructFromMessages: (
    projectId: string,
    worktreeId: string,
    tabs: ReconstructableTab[],
  ) => void;
  /** Apply one absolute live-task update for the chat, settling removed tasks. */
  applyLiveBackgroundTaskPush: (
    previous: LiveBackgroundTaskChatEntry | undefined,
    next: ActivityLiveBgTasksChangedEvent,
  ) => void;
  /**
   * Adds the background launches of one chat whose messages loaded after
   * hydration (it was not open at startup), then settles them through
   * {@link resolveBackgroundProcesses}. Additive: it never drops or rewrites
   * an existing entry, so live work known only from events survives.
   */
  adoptChatMessages: (
    projectId: string,
    worktreeId: string,
    tab: ReconstructableTab,
  ) => void;
  reconcileBackgroundProcessesFromObservability: (
    projectId: string,
    worktreeId: string,
    chatIds: string[],
  ) => Promise<void>;
  /**
   * Settle every background process a transcript rebuilt as unfinished: first
   * the audit-trail reconciliation (which can prove `completed`/`failed` with
   * the provider's own summary), then main's live background-task replica for
   * whatever is left. Fired after {@link reconstructFromMessages}, and safe to
   * call directly.
   */
  resolveBackgroundProcesses: (
    projectId: string,
    worktreeId: string,
    chatIds: string[],
  ) => Promise<void>;
  /**
   * Compare the remaining non-terminal processes against main's live set. A
   * process whose chat has no live session, or whose task id is not in that
   * chat's live set, ended without leaving a notification behind; a process
   * that is still live gets its output polling resumed. Processes with no task
   * id in a live session are left alone — their tool result can still arrive.
   */
  resolveBackgroundProcessLiveness: (
    projectId: string,
    worktreeId: string,
    chatIds: string[],
  ) => Promise<void>;
  cleanupWorktree: (projectId: string, worktreeId: string) => void;
}

const delayedStopTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** In-flight `ensureTrackedPlanLoaded` requests, keyed by worktree + plan. */
const trackedPlanLoadsInFlight = new Map<
  string,
  Promise<TrackedPlanData | null>
>();
const reconciliationInFlight = new Set<string>();
/**
 * Stale-response guard for `loadTrackedPlans`. Each authoritative single-plan
 * write takes the next sequence number; a list response keeps the store's
 * current record for any plan written after its request started. Entries are
 * dropped once no list request for the worktree is in flight.
 */
let trackedPlanWriteSequence = 0;
const trackedPlanWrites = new Map<string, Map<string, number>>();
const trackedPlanListsInFlight = new Map<string, number>();
let trackedPlanListSequence = 0;
const trackedPlanListsApplied = new Map<string, number>();

function recordTrackedPlanWrite(key: string, planId: string): void {
  trackedPlanWriteSequence += 1;
  if (!trackedPlanListsInFlight.get(key)) return;
  const writes = trackedPlanWrites.get(key) ?? new Map<string, number>();
  writes.set(planId, trackedPlanWriteSequence);
  trackedPlanWrites.set(key, writes);
}

function finishTrackedPlanList(key: string): void {
  const remaining = (trackedPlanListsInFlight.get(key) ?? 1) - 1;
  if (remaining > 0) {
    trackedPlanListsInFlight.set(key, remaining);
    return;
  }
  trackedPlanListsInFlight.delete(key);
  trackedPlanWrites.delete(key);
  trackedPlanListsApplied.delete(key);
}

/** Keep current records for plans written after a list request started. */
function protectNewerTrackedPlanWrites(
  key: string,
  listed: TrackedPlanData[],
  current: TrackedPlanData[] | undefined,
  startedAtSequence: number,
): TrackedPlanData[] {
  const writes = trackedPlanWrites.get(key);
  if (!writes) return listed;
  const protectedPlans = listed.flatMap((plan) => {
    const writtenAt = writes.get(plan.id);
    if (writtenAt === undefined || writtenAt <= startedAtSequence) {
      return [plan];
    }
    const newer = current?.find((entry) => entry.id === plan.id);
    return newer ? [newer] : [];
  });
  const listedIds = new Set(listed.map((plan) => plan.id));
  for (const plan of current ?? []) {
    if (
      !listedIds.has(plan.id) &&
      (writes.get(plan.id) ?? 0) > startedAtSequence
    ) {
      protectedPlans.push(plan);
    }
  }
  return protectedPlans;
}
const livenessInFlight = new Set<string>();

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function pollingKey(
  request: Pick<
    ActivityStopOutputPollingRequest,
    'projectId' | 'worktreeId' | 'chatId' | 'taskId'
  >,
): string {
  return `${request.projectId}/${request.worktreeId}/${request.chatId}/${request.taskId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      return {};
    }
  }

  return isRecord(input) ? input : {};
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return (content as unknown[])
      .map((entry) => {
        if (entry && typeof entry === 'object' && 'text' in entry) {
          const text = (entry as { text?: unknown }).text;
          if (typeof text === 'string') {
            return text;
          }
        }
        return JSON.stringify(entry);
      })
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  return '';
}

function parseContentPayload(content: unknown): {
  text: string;
  json: Record<string, unknown> | null;
} {
  if (isRecord(content)) {
    return {
      text: JSON.stringify(content),
      json: content,
    };
  }

  const text = stringifyContent(content);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      return { text, json: parsed };
    }
  } catch {
    // Text payloads from the SDK are often YAML-like rather than JSON.
  }

  return { text, json: null };
}

function getString(
  source: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function cleanExtractedValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^[\s"'`]+|[\s"',`]+$/g, '');
}

function extractWithRegex(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return cleanExtractedValue(match?.[1]);
}

function parseBackgroundResult(content: unknown): {
  status?: string;
  taskId?: string;
  outputFile?: string;
  description?: string;
  prompt?: string;
  summary?: string;
  runId?: string;
  transcriptDir?: string;
  scriptFile?: string;
} {
  const payload = parseContentPayload(content);

  if (isWorkflowLaunchReceipt(payload.text)) {
    const receipt = parseWorkflowReceipt(payload.text);
    return {
      status: 'running',
      taskId: receipt.taskId,
      summary: receipt.summary,
      runId: receipt.runId,
      transcriptDir: receipt.transcriptDir,
      scriptFile: receipt.scriptFile,
    };
  }

  return {
    status:
      getString(payload.json, 'status') ??
      // Anchored to the start of a line (JSON-ish quoting allowed) on purpose:
      // an unanchored match picked the word "status" out of ordinary prose in
      // a tool result ("the previous run had status: failed") and marked a
      // healthy background process `failed`.
      extractWithRegex(
        payload.text,
        /^[ \t"'`]*status["'`]?\s*[:=]\s*["']?([A-Za-z0-9._-]+)/im,
      ),
    taskId:
      getString(
        payload.json,
        'backgroundTaskId',
        'background_task_id',
        'task_id',
        'taskId',
        'agentId',
      ) ??
      extractWithRegex(
        payload.text,
        /(?:backgroundTaskId|background_task_id|task[_\s-]?id|agentId)\s*[:=]\s*["']?([A-Za-z0-9._-]+)/i,
      ) ??
      extractWithRegex(
        payload.text,
        /background\s+with\s+ID:\s*([A-Za-z0-9_-]+)/i,
      ),
    outputFile:
      getString(payload.json, 'outputFile', 'output_file') ??
      extractWithRegex(
        payload.text,
        /(?:outputFile|output_file)\s*[:=]\s*["']?([^\n"']+)/i,
      ) ??
      extractWithRegex(
        payload.text,
        // The sentence-ending period is optional on BOTH branches: a result
        // truncated right after the path ("… written to: /tmp/x.log.") would
        // otherwise capture the period as part of the filename, and every
        // later read of that path fails.
        /Output is being written to:?\s+(\/.*?)(?:\.?\s+You will|\.?\s*$)/i,
      ),
    description:
      getString(payload.json, 'description') ??
      extractWithRegex(payload.text, /description\s*[:=]\s*["']?([^\n"']+)/i),
    prompt: getString(payload.json, 'prompt'),
    summary:
      getString(payload.json, 'summary') ??
      extractWithRegex(payload.text, /summary\s*[:=]\s*["']?([^\n"']+)/i),
  };
}

function isBackgroundTool(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  // Workflow always launches in the background and returns a Task ID, even
  // though its input has no `run_in_background` flag.
  if (toolName === 'Workflow') return true;
  if (input.run_in_background !== true) return false;
  return (
    toolName === 'Agent' ||
    toolName === 'Task' ||
    toolName === 'Bash' ||
    // Windows Claude sessions expose `PowerShell` in place of `Bash`, with the
    // same `run_in_background` flag.
    toolName === 'PowerShell'
  );
}

function isTerminalProcessStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

function normalizeTaskNotificationStatus(
  status: string | undefined,
): BackgroundProcess['status'] {
  switch (status) {
    case 'failed':
      return 'failed';
    case 'stopped':
    case 'killed':
    case 'cancelled':
    case 'canceled':
      return 'stopped';
    default:
      return 'completed';
  }
}

function createBackgroundProcess(
  meta: ToolUseMeta,
  timestamp: number,
): BackgroundProcess {
  const workflowName =
    meta.toolName === 'Workflow'
      ? extractWorkflowNameFromScript(getString(meta.input, 'script') ?? '')
      : undefined;
  const explicitDescription = getString(meta.input, 'description');
  const description =
    workflowName ??
    explicitDescription ??
    getString(meta.input, 'command') ??
    getString(meta.input, 'prompt') ??
    meta.toolName;

  return {
    id: meta.toolUseId,
    chatId: meta.chatId,
    toolUseId: meta.toolUseId,
    toolName: meta.toolName,
    kind: backgroundProcessKindForTool(meta.toolName),
    description,
    advisorDescription: meta.toolName,
    command: getString(meta.input, 'command'),
    prompt: getString(meta.input, 'prompt'),
    status: 'queued',
    startedAt: timestamp,
    updatedAt: timestamp,
    outputLines: [],
    canStop: true,
  };
}

function findProcessIndex(
  processes: BackgroundProcess[],
  identifiers: { chatId?: string; toolUseId?: string; taskId?: string },
): number {
  return processes.findIndex(
    (process) =>
      (!identifiers.chatId || process.chatId === identifiers.chatId) &&
      ((identifiers.taskId && process.taskId === identifiers.taskId) ||
        (identifiers.taskId && process.outputTaskId === identifiers.taskId) ||
        (identifiers.toolUseId && process.toolUseId === identifiers.toolUseId)),
  );
}

function appendOutputLines(existing: string[], incoming: string[]): string[] {
  if (incoming.length === 0) return existing;
  const next = existing.concat(incoming);
  return next.length > MAX_OUTPUT_LINES
    ? next.slice(next.length - MAX_OUTPUT_LINES)
    : next;
}

function cloneWorktreeActivity(
  state: ActivityState,
  key: string,
): WorktreeActivityData {
  return {
    bgProcesses: [...(state.bgProcesses[key] ?? [])],
    toolUses: { ...(state.toolUses[key] ?? {}) },
  };
}

/**
 * Stamps `endedAt` on the update that makes a process terminal and carries it
 * through later updates. A process that runs again loses it.
 */
function withEndedAt(
  previous: readonly BackgroundProcess[] | undefined,
  next: BackgroundProcess[],
): BackgroundProcess[] {
  return next.map((process) => {
    if (!isTerminalProcessStatus(process.status)) {
      if (process.endedAt === undefined) return process;
      const running = { ...process };
      delete running.endedAt;
      return running;
    }
    const before = previous?.find((item) => item.id === process.id);
    const endedAt =
      before !== undefined && isTerminalProcessStatus(before.status)
        ? (before.endedAt ?? before.updatedAt)
        : (process.endedAt ?? process.updatedAt);
    return process.endedAt === endedAt ? process : { ...process, endedAt };
  });
}

function buildPatch(
  state: ActivityState,
  key: string,
  data: WorktreeActivityData,
): Pick<ActivityState, 'bgProcesses' | 'toolUses'> {
  return {
    bgProcesses: {
      ...state.bgProcesses,
      [key]: withEndedAt(state.bgProcesses[key], data.bgProcesses),
    },
    toolUses: { ...state.toolUses, [key]: data.toolUses },
  };
}

function getRecordString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore malformed transcript lines.
  }
  return null;
}

function parseSystemEventBlock(
  block: ReconstructableBlock,
): Record<string, unknown> | null {
  if (
    block.type !== 'system' &&
    block.type !== 'sdk_event' &&
    block.type !== 'system_event'
  ) {
    return null;
  }

  const event: Record<string, unknown> = { type: 'system' };
  if (block.subtype) event.subtype = block.subtype;
  if (block.task_id ?? block.taskId) {
    event.task_id = block.task_id ?? block.taskId;
  }
  if (block.tool_use_id ?? block.toolUseId) {
    event.tool_use_id = block.tool_use_id ?? block.toolUseId;
  }
  if (block.parent_tool_use_id) {
    event.parent_tool_use_id = block.parent_tool_use_id;
  }
  if (block.status) event.status = block.status;
  if (block.description) event.description = block.description;
  if (block.summary) event.summary = block.summary;
  if (block.output_file) event.output_file = block.output_file;
  if (isRecord(block.patch)) event.patch = block.patch;
  if (Array.isArray(block.tasks)) event.tasks = block.tasks;

  return typeof event.subtype === 'string' ? event : null;
}

function isTerminalTaskUpdateStatus(status: string | undefined): boolean {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'stopped':
    case 'killed':
    case 'cancelled':
    case 'canceled':
      return true;
    default:
      return false;
  }
}

function normalizeTerminalTaskUpdatedEvent(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  if (getRecordString(event, 'subtype') !== 'task_updated') {
    return null;
  }

  const patch = event.patch;
  if (!isRecord(patch)) {
    return null;
  }

  const status = getRecordString(patch, 'status');
  if (!isTerminalTaskUpdateStatus(status)) {
    return null;
  }

  const taskId = getRecordString(event, 'task_id', 'taskId');
  if (!taskId) {
    return null;
  }

  const normalized: Record<string, unknown> = {
    ...event,
    subtype: 'task_notification',
    task_id: taskId,
    status,
  };

  const outputFile =
    getRecordString(patch, 'output_file', 'outputFile') ??
    getRecordString(event, 'output_file', 'outputFile');
  if (outputFile) {
    normalized.output_file = outputFile;
  }

  return normalized;
}

/**
 * A foreground Bash that outlives its timeout is moved to the background, and
 * the SDK reports that move as `task_updated { patch: { is_backgrounded: true
 * } }` rather than a second `task_started`. Normalize it into the backgrounded
 * `task_started` shape so it becomes (or revives) a background-process card.
 */
function normalizeBackgroundedTaskUpdatedEvent(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  if (getRecordString(event, 'subtype') !== 'task_updated') {
    return null;
  }

  const patch = event.patch;
  if (!isRecord(patch) || patch.is_backgrounded !== true) {
    return null;
  }

  const taskId = getRecordString(event, 'task_id', 'taskId');
  if (!taskId) {
    return null;
  }

  const normalized: Record<string, unknown> = {
    ...event,
    subtype: 'task_started',
    task_id: taskId,
    is_backgrounded: true,
  };

  const description = getRecordString(patch, 'description');
  if (description) {
    normalized.description = description;
  }

  return normalized;
}

/** Terminal patches win; a backgrounding patch is the remaining case. */
function normalizeTaskUpdatedEvent(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  return (
    normalizeTerminalTaskUpdatedEvent(event) ??
    normalizeBackgroundedTaskUpdatedEvent(event)
  );
}

/** The tool use a previous task event correlated with `taskId`, if any. */
function findToolUseIdForTaskId(
  toolUses: Record<string, ToolUseMeta>,
  taskId: string,
): string | undefined {
  for (const meta of Object.values(toolUses)) {
    if (meta.taskId === taskId) {
      return meta.toolUseId;
    }
  }
  return undefined;
}

function parseTranscriptTaskEvent(
  line: string,
): Record<string, unknown> | null {
  const parsed = parseJsonRecord(line);
  if (!parsed || parsed.type !== 'system') {
    return null;
  }

  const subtype = getRecordString(parsed, 'subtype');
  if (
    subtype !== 'task_started' &&
    subtype !== 'task_progress' &&
    subtype !== 'task_notification' &&
    subtype !== 'task_updated'
  ) {
    return null;
  }

  return parsed;
}

function parseTranscriptTerminalTaskEvent(
  line: string,
): Record<string, unknown> | null {
  const event = parseTranscriptTaskEvent(line);
  if (event) {
    if (getRecordString(event, 'subtype') === 'task_notification') {
      return event;
    }
    return normalizeTerminalTaskUpdatedEvent(event);
  }

  const parsed = parseJsonRecord(line);
  if (!parsed || parsed.type !== 'user') {
    return null;
  }
  const origin = parsed.origin;
  const message = parsed.message;
  const content = isRecord(message) ? message.content : parsed.content;
  if (typeof content !== 'string') {
    return null;
  }
  const normalizedOrigin = isRecord(origin)
    ? getRecordString(origin, 'kind')
    : undefined;
  if (
    normalizedOrigin !== 'task-notification' &&
    normalizedOrigin !== 'task_notification' &&
    !/^\s*<task[-_]notification>/i.test(content)
  ) {
    return null;
  }

  const taskId = extractWithRegex(
    content,
    /<task[-_]id>\s*([^<]+?)\s*<\/task[-_]id>/i,
  );
  const status = extractWithRegex(
    content,
    /<status>\s*([^<]+?)\s*<\/status>/i,
  )?.toLowerCase();
  if (!taskId || !isTerminalTaskUpdateStatus(status)) {
    return null;
  }

  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
  };
}

function parseBackgroundTasksChanged(
  event: Record<string, unknown>,
): Set<string> | null {
  if (getRecordString(event, 'subtype') !== 'background_tasks_changed') {
    return null;
  }
  if (!Array.isArray(event.tasks)) {
    return null;
  }

  const taskIds = new Set<string>();
  for (const task of event.tasks) {
    if (!isRecord(task)) return null;
    const taskId = getRecordString(task, 'task_id', 'taskId');
    if (!taskId) return null;
    taskIds.add(taskId);
  }
  return taskIds;
}

function parseTranscriptBackgroundTasksChanged(
  line: string,
): Set<string> | null {
  const parsed = parseJsonRecord(line);
  if (!parsed || parsed.type !== 'system') {
    return null;
  }
  return parseBackgroundTasksChanged(parsed);
}

function parseTranscriptNotificationResult(line: string): string | null {
  const parsed = parseJsonRecord(line);
  if (!parsed || parsed.type !== 'result') {
    return null;
  }

  const origin = parsed.origin;
  if (
    !isRecord(origin) ||
    getRecordString(origin, 'kind') !== 'task-notification'
  ) {
    return null;
  }

  return getRecordString(parsed, 'result') ?? null;
}

function isBackgroundBashCompletionText(text: string): boolean {
  return (
    /\bbackground\s+(?:bash|process)\b/i.test(text) &&
    /\b(?:completed|finished|succeeded)\b/i.test(text)
  );
}

function synthesizeBashNotificationEvent(
  line: string,
  chatId: string,
  activeProcesses: BackgroundProcess[],
  unresolvedKeys: Set<string>,
): Record<string, unknown> | null {
  const resultText = parseTranscriptNotificationResult(line);
  if (!resultText || !isBackgroundBashCompletionText(resultText)) {
    return null;
  }

  const candidates = activeProcesses.filter((process) => {
    if (process.chatId !== chatId || process.kind !== 'bash') {
      return false;
    }
    return activeProcessIdentifierKeys(process).some((key) =>
      unresolvedKeys.has(key),
    );
  });

  const explicitCandidate = candidates.find(
    (process) =>
      (process.taskId && resultText.includes(process.taskId)) ||
      (process.toolUseId && resultText.includes(process.toolUseId)),
  );
  const matchedProcess =
    explicitCandidate ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!matchedProcess) {
    return null;
  }

  return completionEventForProcess(matchedProcess);
}

function auditEntryTime(entry: AgentAuditEntry): number {
  const parsed = Date.parse(entry.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function activeProcessIdentifierKeys(process: BackgroundProcess): string[] {
  const keys: string[] = [];
  if (process.taskId) {
    keys.push(`task:${process.taskId}`);
  }
  if (process.toolUseId) {
    keys.push(`tool:${process.toolUseId}`);
  }
  return keys;
}

function completionEventForProcess(
  process: BackgroundProcess,
): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_notification',
    status: 'completed',
    task_id: process.taskId,
    tool_use_id: process.toolUseId,
    summary: 'Background process completed',
    ...(process.outputFile ? { output_file: process.outputFile } : {}),
  };
}

function matchingTerminalEventKeys(
  event: Record<string, unknown>,
  activeKeys: Set<string>,
): string[] {
  const keys: string[] = [];
  const taskId = getRecordString(event, 'task_id', 'taskId');
  if (taskId && activeKeys.has(`task:${taskId}`)) {
    keys.push(`task:${taskId}`);
  }

  // Deliberately not `parent_tool_use_id`: that names the OUTER agent call a
  // nested task ran inside, so matching on it resolved (and terminated) the
  // wrong process. Keep this in step with `applySystemEventToData`, which
  // applies these events.
  const toolUseId = getRecordString(event, 'tool_use_id', 'toolUseId');
  if (toolUseId && activeKeys.has(`tool:${toolUseId}`)) {
    keys.push(`tool:${toolUseId}`);
  }

  return keys;
}

function buildTranscriptRequest(entry: AgentAuditEntry): {
  id: string;
  eventType: AgentAuditEntry['eventType'];
  startedAt: string;
} {
  return {
    id: entry.id,
    eventType: entry.eventType,
    startedAt: entry.startedAt,
  };
}

/**
 * Fold what the live event stream taught us about a process into the version
 * a persisted transcript can rebuild.
 *
 * Persisted chat blocks carry no SDK system events, so reconstruction only
 * ever sees `tool_use` / `tool_result` pairs: terminal status, the task id a
 * notification supplied, the output file, streamed output, and the workflow
 * receipt fields all live in memory alone. Reconstruction used to force every
 * non-terminal process back to `running` and keep only terminal state, which
 * both revived finished work and stranded the poller (its events no longer
 * matched any task id). Identity is carried forward for live processes too,
 * and the status is left to the resolution pass.
 */
function mergePreviousProcessState(
  previous: BackgroundProcess[] | undefined,
  process: BackgroundProcess,
): BackgroundProcess {
  const previousIndex = findProcessIndex(previous ?? [], {
    taskId: process.taskId,
    toolUseId: process.toolUseId,
  });
  const previousProcess =
    previousIndex >= 0 ? previous?.[previousIndex] : undefined;
  if (!previousProcess) {
    return {
      ...process,
      canStop:
        !isTerminalProcessStatus(process.status) && Boolean(process.taskId),
    };
  }

  const merged: BackgroundProcess = {
    ...process,
    taskId: previousProcess.taskId ?? process.taskId,
    outputTaskId: process.outputTaskId ?? previousProcess.outputTaskId,
    advisorDescription:
      process.advisorDescription ?? previousProcess.advisorDescription,
    summary: process.summary ?? previousProcess.summary,
    lastDescription: process.lastDescription ?? previousProcess.lastDescription,
    outputFile: process.outputFile ?? previousProcess.outputFile,
    runId: process.runId ?? previousProcess.runId,
    transcriptDir: process.transcriptDir ?? previousProcess.transcriptDir,
    scriptFile: process.scriptFile ?? previousProcess.scriptFile,
    outputLines:
      process.outputLines.length > 0
        ? process.outputLines
        : previousProcess.outputLines,
    updatedAt: Math.max(previousProcess.updatedAt, process.updatedAt),
  };

  if (isTerminalProcessStatus(previousProcess.status)) {
    return {
      ...merged,
      status: previousProcess.status,
      summary: previousProcess.summary ?? merged.summary,
      canStop: false,
    };
  }

  const status =
    merged.status === 'queued' && previousProcess.status === 'running'
      ? 'running'
      : merged.status;

  return {
    ...merged,
    status,
    canStop: !isTerminalProcessStatus(status) && Boolean(merged.taskId),
  };
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  return recordsEqual(
    left as Record<string, unknown>,
    right as Record<string, unknown>,
  );
}

function recordsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        valuesEqual(left[key], right[key]),
    )
  );
}

// Keep these field-by-field comparisons in sync with the renderer-visible
// fields on their corresponding shared types. Missing a field would suppress
// a real update and leave stale data in the activity panel.
// Mirrors ChangedFileInfo fields shown in activity changed-file lists.
function changedFileInfoEqual(
  left: ChangedFileInfo,
  right: ChangedFileInfo,
): boolean {
  return (
    left.path === right.path &&
    left.status === right.status &&
    left.insertions === right.insertions &&
    left.deletions === right.deletions &&
    left.previousPath === right.previousPath &&
    left.repoId === right.repoId &&
    left.repoName === right.repoName
  );
}

function changedFileListsEqual(
  left: ChangedFileInfo[],
  right: ChangedFileInfo[],
): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => changedFileInfoEqual(file, right[index]))
  );
}

// Mirrors ActivityChangedFilesResponse.
function changedFilesResponseEqual(
  left: ActivityChangedFilesResponse | undefined,
  right: ActivityChangedFilesResponse | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    changedFileListsEqual(left.uncommitted, right.uncommitted) &&
    changedFileListsEqual(left.committed, right.committed)
  );
}

/** True when `next` introduces an uncommitted path not present in `prev`. */
function hasNewUncommittedFile(
  prev: ActivityChangedFilesResponse | undefined,
  next: ActivityChangedFilesResponse,
): boolean {
  const prevPaths = new Set((prev?.uncommitted ?? []).map((f) => f.path));
  return next.uncommitted.some((f) => !prevPaths.has(f.path));
}

// Mirrors WorktreeSummaryData.
function worktreeSummaryDataEqual(
  left: WorktreeSummaryData | undefined,
  right: WorktreeSummaryData | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const leftRepos = left.repos ?? [];
  const rightRepos = right.repos ?? [];
  return (
    left.title === right.title &&
    left.description === right.description &&
    stringArraysEqual(left.highlights, right.highlights) &&
    leftRepos.length === rightRepos.length &&
    leftRepos.every(
      (repo, index) =>
        repo.name === rightRepos[index].name &&
        repo.description === rightRepos[index].description,
    ) &&
    left.generatedAt === right.generatedAt &&
    left.turnCountAtGeneration === right.turnCountAtGeneration &&
    left.lastFullRefreshAt === right.lastFullRefreshAt &&
    left.lastFullRefreshTurnCount === right.lastFullRefreshTurnCount
  );
}

// Mirrors TrackedPlanRevisionData fields shown by the plans panel.
function trackedPlanRevisionsEqual(
  left: TrackedPlanData['revisions'],
  right: TrackedPlanData['revisions'],
): boolean {
  return (
    left.length === right.length &&
    left.every((revision, index) => {
      const other = right[index];
      return (
        revision.revisionNumber === other.revisionNumber &&
        revision.content === other.content &&
        revision.source === other.source &&
        revision.reviewStatus === other.reviewStatus &&
        revision.createdAt === other.createdAt &&
        revision.approvedAt === other.approvedAt &&
        revision.dismissedAt === other.dismissedAt
      );
    })
  );
}

// Mirrors TrackedPlanData fields shown by the plans panel.
function trackedPlanDataEqual(
  left: TrackedPlanData,
  right: TrackedPlanData,
): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.worktreeId === right.worktreeId &&
    left.title === right.title &&
    left.content === right.content &&
    left.source === right.source &&
    left.reviewStatus === right.reviewStatus &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.latestRevisionNumber === right.latestRevisionNumber &&
    left.approvedAt === right.approvedAt &&
    left.dismissedAt === right.dismissedAt &&
    left.hidden === right.hidden &&
    left.lastEditSource === right.lastEditSource &&
    stringArraysEqual(left.linkedExecutionIds, right.linkedExecutionIds) &&
    trackedPlanRevisionsEqual(left.revisions, right.revisions) &&
    valuesEqual(left.diagrams, right.diagrams) &&
    valuesEqual(left.commentThreads, right.commentThreads) &&
    // Share/sync metadata changes (e.g. `syncStatus` advancing to `synced`)
    // arrive as background `trackedPlansUpdated` events that do not touch
    // `content`/`updatedAt`. Comparing `share` here keeps `upsertTrackedPlan`
    // from short-circuiting those updates, so the Share button can advance
    // through its `Syncing`/`Shared`/`Retry share` labels.
    valuesEqual(left.share, right.share)
  );
}

function trackedPlanListsEqual(
  left: TrackedPlanData[] | undefined,
  right: TrackedPlanData[] | undefined,
): boolean {
  const leftPlans = left ?? [];
  const rightPlans = right ?? [];
  return (
    leftPlans.length === rightPlans.length &&
    leftPlans.every((plan, index) =>
      trackedPlanDataEqual(plan, rightPlans[index]),
    )
  );
}

// Mirrors BackgroundProcess fields shown by the background-process panel.
function backgroundProcessEqual(
  left: BackgroundProcess,
  right: BackgroundProcess,
): boolean {
  return (
    left.id === right.id &&
    left.chatId === right.chatId &&
    left.toolUseId === right.toolUseId &&
    left.taskId === right.taskId &&
    left.toolName === right.toolName &&
    left.kind === right.kind &&
    left.description === right.description &&
    left.command === right.command &&
    left.prompt === right.prompt &&
    left.status === right.status &&
    left.startedAt === right.startedAt &&
    left.updatedAt === right.updatedAt &&
    left.endedAt === right.endedAt &&
    left.summary === right.summary &&
    left.lastDescription === right.lastDescription &&
    left.outputFile === right.outputFile &&
    stringArraysEqual(left.outputLines, right.outputLines) &&
    left.canStop === right.canStop
  );
}

function backgroundProcessListsEqual(
  left: BackgroundProcess[] | undefined,
  right: BackgroundProcess[] | undefined,
): boolean {
  const leftProcesses = left ?? [];
  const rightProcesses = right ?? [];
  return (
    leftProcesses.length === rightProcesses.length &&
    leftProcesses.every((process, index) =>
      backgroundProcessEqual(process, rightProcesses[index]),
    )
  );
}

// Mirrors ToolUseMeta fields reconstructed for the activity tool-use map.
function toolUseMetaEqual(left: ToolUseMeta, right: ToolUseMeta): boolean {
  return (
    left.chatId === right.chatId &&
    left.toolUseId === right.toolUseId &&
    left.toolName === right.toolName &&
    recordsEqual(left.input, right.input) &&
    left.timestamp === right.timestamp &&
    left.taskId === right.taskId
  );
}

function toolUseMapsEqual(
  left: Record<string, ToolUseMeta> | undefined,
  right: Record<string, ToolUseMeta> | undefined,
): boolean {
  const leftMap = left ?? {};
  const rightMap = right ?? {};
  const leftKeys = Object.keys(leftMap);
  const rightKeys = Object.keys(rightMap);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        rightMap[key] !== undefined &&
        toolUseMetaEqual(leftMap[key], rightMap[key]),
    )
  );
}

function applyToolUseToData(
  data: WorktreeActivityData,
  chatId: string,
  toolUseId: string,
  toolName: string,
  input: unknown,
  timestamp: number,
): void {
  const parsedInput = parseToolInput(input);
  const meta: ToolUseMeta = {
    chatId,
    toolUseId,
    toolName,
    input: parsedInput,
    timestamp,
  };

  data.toolUses[toolUseId] = meta;

  if (isBackgroundTool(toolName, parsedInput)) {
    const processIndex = findProcessIndex(data.bgProcesses, { toolUseId });
    const nextProcess =
      processIndex >= 0
        ? {
            ...data.bgProcesses[processIndex],
            updatedAt: timestamp,
          }
        : createBackgroundProcess(meta, timestamp);

    if (processIndex >= 0) {
      data.bgProcesses[processIndex] = nextProcess;
    } else {
      data.bgProcesses.push(nextProcess);
    }
  }
}

/**
 * A card first seen from an ID-only live task holds its task id as a
 * placeholder tool-use id. Agent activity and turn attribution look cards up
 * by tool-use id, so adopt the real one (and the tool use's own metadata, when
 * known) once the provider names it. The card `id` stays stable.
 */
function adoptToolUseIdentity(
  data: WorktreeActivityData,
  processIndex: number,
  toolUseId: string,
): void {
  const process = data.bgProcesses[processIndex];
  const hasPlaceholderToolUseId =
    process.toolUseId === process.taskId ||
    process.toolUseId === process.outputTaskId;
  if (!hasPlaceholderToolUseId) return;

  const meta = data.toolUses[toolUseId];
  const fromToolUse = meta
    ? createBackgroundProcess(meta, meta.timestamp)
    : undefined;
  data.bgProcesses[processIndex] = {
    ...process,
    toolUseId,
    ...(fromToolUse
      ? {
          toolName: fromToolUse.toolName,
          kind: fromToolUse.kind,
          description: fromToolUse.description,
          advisorDescription: fromToolUse.advisorDescription,
          command: fromToolUse.command,
          prompt: fromToolUse.prompt,
          startedAt: Math.min(process.startedAt, fromToolUse.startedAt),
        }
      : {}),
  };
}

/**
 * Collapse an ID-only live-task card into the tool-use card once the provider
 * supplies both halves of its identity.
 */
function mergeDuplicateBackgroundProcessesForIdentity(
  data: WorktreeActivityData,
  chatId: string,
  taskId: string | undefined,
  toolUseId: string | undefined,
): void {
  if (!taskId || !toolUseId) return;

  const taskProcessIndex = data.bgProcesses.findIndex(
    (process) => process.chatId === chatId && process.taskId === taskId,
  );
  const toolUseProcessIndex = data.bgProcesses.findIndex(
    (process) => process.chatId === chatId && process.toolUseId === toolUseId,
  );
  if (taskProcessIndex >= 0 && toolUseProcessIndex < 0) {
    adoptToolUseIdentity(data, taskProcessIndex, toolUseId);
    return;
  }
  if (
    taskProcessIndex < 0 ||
    toolUseProcessIndex < 0 ||
    taskProcessIndex === toolUseProcessIndex
  ) {
    return;
  }

  const taskProcess = data.bgProcesses[taskProcessIndex];
  const toolUseProcess = data.bgProcesses[toolUseProcessIndex];
  const terminalProcess = isTerminalProcessStatus(toolUseProcess.status)
    ? toolUseProcess
    : isTerminalProcessStatus(taskProcess.status)
      ? taskProcess
      : undefined;
  const taskIdChanged =
    toolUseProcess.taskId !== undefined &&
    toolUseProcess.taskId !== taskProcess.taskId;
  const merged: BackgroundProcess = {
    ...toolUseProcess,
    taskId: taskProcess.taskId ?? toolUseProcess.taskId,
    outputTaskId:
      toolUseProcess.outputTaskId ??
      (taskIdChanged ? toolUseProcess.taskId : undefined) ??
      taskProcess.outputTaskId,
    outputFile: toolUseProcess.outputFile ?? taskProcess.outputFile,
    runId: toolUseProcess.runId ?? taskProcess.runId,
    transcriptDir: toolUseProcess.transcriptDir ?? taskProcess.transcriptDir,
    scriptFile: toolUseProcess.scriptFile ?? taskProcess.scriptFile,
    summary: terminalProcess
      ? terminalProcess.summary
      : (toolUseProcess.summary ?? taskProcess.summary),
    lastDescription:
      toolUseProcess.lastDescription ?? taskProcess.lastDescription,
    outputLines:
      toolUseProcess.outputLines.length > 0
        ? toolUseProcess.outputLines
        : taskProcess.outputLines,
    updatedAt: Math.max(toolUseProcess.updatedAt, taskProcess.updatedAt),
    ...(terminalProcess
      ? { status: terminalProcess.status, canStop: false }
      : {}),
  };

  data.bgProcesses[toolUseProcessIndex] = merged;
  data.bgProcesses.splice(taskProcessIndex, 1);
}

function applyLiveTasksToChat(
  data: WorktreeActivityData,
  projectId: string,
  worktreeId: string,
  chatId: string,
  liveTasks: readonly ActivityLiveBgTask[],
  timestamp: number,
  mutations: ActivityMutationResult[],
  /** The chat's previous live set, when the caller knows what changed. */
  previousTaskIds?: ReadonlySet<string>,
): void {
  for (const task of liveTasks) {
    mergeDuplicateBackgroundProcessesForIdentity(
      data,
      chatId,
      task.taskId,
      task.toolUseId,
    );

    const existingIndex = findProcessIndex(data.bgProcesses, {
      chatId,
      taskId: task.taskId,
      toolUseId: task.toolUseId,
    });
    if (existingIndex >= 0) {
      const existing = data.bgProcesses[existingIndex];
      // A task back in the live set after leaving it runs again, as a resumed
      // Codex child does under its thread's task id. A task still listed
      // keeps the ending a notification gave it.
      const rejoined =
        previousTaskIds !== undefined && !previousTaskIds.has(task.taskId);
      if (!isTerminalProcessStatus(existing.status) || rejoined) {
        const taskIdChanged = existing.taskId !== task.taskId;
        const nextOutputTaskId =
          existing.outputTaskId ??
          (taskIdChanged ? existing.taskId : undefined);
        // The launch description only replaces the card's when the card is
        // re-pointed at this task; `phase` is main's latest progress text,
        // `description` the launch text, so only `phase` may advance
        // `lastDescription`.
        const nextDescription = taskIdChanged
          ? (task.description ?? existing.description)
          : existing.description;
        const nextLastDescription = task.phase ?? existing.lastDescription;
        const canStop = task.stoppable !== false;
        const changed =
          taskIdChanged ||
          nextOutputTaskId !== existing.outputTaskId ||
          nextDescription !== existing.description ||
          nextLastDescription !== existing.lastDescription ||
          existing.status !== 'running' ||
          existing.canStop !== canStop;

        if (changed) {
          const adopted: BackgroundProcess = {
            ...existing,
            taskId: task.taskId,
            outputTaskId: nextOutputTaskId,
            description: nextDescription,
            lastDescription: nextLastDescription,
            status: 'running',
            canStop,
            updatedAt: timestamp,
          };
          data.bgProcesses[existingIndex] = adopted;
          // Only on adoption: an unchanged live card already has its poller,
          // and every push would otherwise re-request it.
          if (adopted.outputFile) {
            mutations.push({
              startPolling: {
                projectId,
                worktreeId,
                chatId,
                taskId: adopted.outputTaskId ?? task.taskId,
                outputFile: adopted.outputFile,
              },
            });
          }
        }
      }
      continue;
    }

    const knownMeta = task.toolUseId
      ? data.toolUses[task.toolUseId]
      : undefined;
    let restored: BackgroundProcess;
    if (knownMeta) {
      restored = createBackgroundProcess(knownMeta, knownMeta.timestamp);
    } else {
      const meta: ToolUseMeta = {
        chatId,
        toolUseId: task.toolUseId ?? task.taskId,
        toolName: 'Task',
        input: {},
        timestamp,
      };
      restored = {
        ...createBackgroundProcess(meta, timestamp),
        kind: backgroundProcessKindForTaskType(task.taskType) ?? 'task',
        description: task.description ?? task.workflowName ?? 'Background task',
      };
    }

    data.bgProcesses.push({
      ...restored,
      taskId: task.taskId,
      lastDescription: task.phase ?? task.description,
      status: 'running',
      canStop: task.stoppable !== false,
    });
  }
}

function applyTaskStopResult(
  data: WorktreeActivityData,
  projectId: string,
  worktreeId: string,
  chatId: string,
  content: unknown,
  timestamp: number,
): ActivityMutationResult {
  const payload = parseContentPayload(content);
  const taskId =
    getString(payload.json, 'task_id', 'taskId') ??
    extractWithRegex(
      payload.text,
      /task[_\s-]?id\s*[:=]\s*["']?([A-Za-z0-9._-]+)/i,
    );
  if (!taskId) return {};

  const processIndex = findProcessIndex(data.bgProcesses, { taskId });
  if (processIndex < 0) return {};

  const existing = data.bgProcesses[processIndex];
  if (isTerminalProcessStatus(existing.status)) return {};

  data.bgProcesses[processIndex] = {
    ...existing,
    status: 'stopped',
    updatedAt: timestamp,
    canStop: false,
  };

  const outputTaskId = existing.outputTaskId ?? existing.taskId;
  if (outputTaskId) {
    return {
      stopPolling: { projectId, worktreeId, chatId, taskId: outputTaskId },
    };
  }

  return {};
}

function applyToolResultToData(
  data: WorktreeActivityData,
  projectId: string,
  worktreeId: string,
  chatId: string,
  toolUseId: string,
  content: unknown,
  isError: boolean,
  timestamp: number,
): ActivityMutationResult {
  const meta = data.toolUses[toolUseId];
  if (!meta) return {};

  if (meta.toolName === 'TaskStop') {
    return applyTaskStopResult(
      data,
      projectId,
      worktreeId,
      chatId,
      content,
      timestamp,
    );
  }

  // A tool use that did not ask for the background still owns a background
  // process once a task was moved there: a Bash call that outlives its
  // timeout is backgrounded mid-flight, and its result is the only place the
  // output file it now writes to is named. Such a result is matched by its
  // own tool-use id alone, so a task id parsed out of unrelated output cannot
  // reach another process.
  const launchedInBackground = isBackgroundTool(meta.toolName, meta.input);
  const ownedProcessIndex = findProcessIndex(data.bgProcesses, { toolUseId });
  if (
    !launchedInBackground &&
    ownedProcessIndex < 0 &&
    meta.toolName !== 'Agent' &&
    meta.toolName !== 'Task'
  ) {
    return {};
  }

  const resultText = parseContentPayload(content).text;
  const asyncAgentLaunch =
    !isError &&
    (meta.toolName === 'Agent' || meta.toolName === 'Task') &&
    isAsyncAgentLaunchText(resultText);
  const resultLaunchedInBackground = launchedInBackground || asyncAgentLaunch;
  if (!resultLaunchedInBackground && ownedProcessIndex < 0) {
    return {};
  }

  const parsedResult = parseBackgroundResult(content);
  if (resultLaunchedInBackground) {
    mergeDuplicateBackgroundProcessesForIdentity(
      data,
      chatId,
      parsedResult.taskId,
      toolUseId,
    );
  }
  const processIndex = resultLaunchedInBackground
    ? findProcessIndex(data.bgProcesses, {
        taskId: parsedResult.taskId,
        toolUseId,
      })
    : ownedProcessIndex;
  const existing =
    processIndex >= 0
      ? data.bgProcesses[processIndex]
      : createBackgroundProcess(meta, timestamp);
  const existingIsTerminal = isTerminalProcessStatus(existing.status);
  const resultFailed =
    isError || parsedResult.status?.toLowerCase() === 'failed';
  const status = existingIsTerminal
    ? resultFailed
      ? 'failed'
      : existing.status
    : resultFailed
      ? 'failed'
      : parsedResult.taskId || parsedResult.status === 'async_launched'
        ? 'running'
        : existing.status;
  const nextTaskId = existingIsTerminal
    ? (existing.taskId ?? parsedResult.taskId)
    : (parsedResult.taskId ?? existing.taskId);

  const nextProcess: BackgroundProcess = {
    ...existing,
    taskId: nextTaskId,
    outputTaskId:
      parsedResult.outputFile && parsedResult.taskId
        ? parsedResult.taskId
        : existing.outputTaskId,
    status,
    updatedAt: timestamp,
    description: parsedResult.description ?? existing.description,
    prompt: parsedResult.prompt ?? existing.prompt,
    summary: existingIsTerminal
      ? existing.summary
      : (parsedResult.summary ?? existing.summary),
    outputFile: parsedResult.outputFile ?? existing.outputFile,
    runId: parsedResult.runId ?? existing.runId,
    transcriptDir: parsedResult.transcriptDir ?? existing.transcriptDir,
    scriptFile: parsedResult.scriptFile ?? existing.scriptFile,
    canStop: !isTerminalProcessStatus(status) && Boolean(nextTaskId),
  };

  if (processIndex >= 0) {
    data.bgProcesses[processIndex] = nextProcess;
  } else {
    data.bgProcesses.push(nextProcess);
  }

  if (
    nextProcess.status === 'running' &&
    nextProcess.taskId &&
    nextProcess.outputFile
  ) {
    return {
      startPolling: {
        projectId,
        worktreeId,
        chatId,
        taskId: nextProcess.outputTaskId ?? nextProcess.taskId,
        outputFile: nextProcess.outputFile,
      },
    };
  }

  return {};
}

/**
 * Apply one SDK task event to the background-process list.
 *
 * Background-only by construction. The SDK emits `task_started` /
 * `task_progress` for FOREGROUND tasks as well (`is_backgrounded: false`), and
 * those tasks are deliberately absent from the `background_tasks_changed`
 * level set — so turning them into cards produced rows that the next level
 * set immediately "completed" while the real work was still running, and rows
 * that nothing ever resolved when a notification was missed. A card is
 * therefore created here only when the event says the task is backgrounded;
 * otherwise the event may only update a process that a `run_in_background`
 * (or `Workflow`) tool use already created. `ambient` tasks are not activity
 * at all and are dropped outright.
 */
function applySystemEventToData(
  data: WorktreeActivityData,
  projectId: string,
  worktreeId: string,
  chatId: string,
  event: Record<string, unknown>,
  timestamp: number,
): ActivityMutationResult {
  const subtype = typeof event.subtype === 'string' ? event.subtype : '';
  if (
    subtype !== 'task_started' &&
    subtype !== 'task_progress' &&
    subtype !== 'task_notification' &&
    subtype !== 'task_updated'
  ) {
    return {};
  }

  if (event.ambient === true) {
    return {};
  }

  const effectiveEvent =
    subtype === 'task_updated' ? normalizeTaskUpdatedEvent(event) : event;
  if (!effectiveEvent) {
    return {};
  }

  const effectiveSubtype =
    typeof effectiveEvent.subtype === 'string' ? effectiveEvent.subtype : '';
  const taskId = getString(effectiveEvent, 'task_id');
  // Deliberately NOT `parent_tool_use_id`: a nested subagent's events carry
  // the OUTER agent's tool-use id there, so matching on it let an inner
  // task's id and terminal status overwrite the outer background process.
  const toolUseId =
    getString(effectiveEvent, 'tool_use_id') ??
    (taskId ? findToolUseIdForTaskId(data.toolUses, taskId) : undefined);

  mergeDuplicateBackgroundProcessesForIdentity(data, chatId, taskId, toolUseId);

  if (taskId && toolUseId) {
    const correlated = data.toolUses[toolUseId];
    if (correlated && correlated.taskId !== taskId) {
      data.toolUses[toolUseId] = { ...correlated, taskId };
    }
  }

  const processIndex = findProcessIndex(data.bgProcesses, {
    taskId,
    toolUseId,
  });
  const isBackgrounded = effectiveEvent.is_backgrounded === true;
  if (
    processIndex < 0 &&
    (effectiveSubtype !== 'task_started' || !isBackgrounded)
  ) {
    return {};
  }

  const meta = (toolUseId ? data.toolUses[toolUseId] : undefined) ?? {
    chatId,
    toolUseId: toolUseId ?? taskId ?? `${chatId}-${timestamp}`,
    toolName: 'Task',
    input: {},
    timestamp,
  };
  const existing =
    processIndex >= 0
      ? data.bgProcesses[processIndex]
      : createBackgroundProcess(meta, timestamp);
  const outputFile = getString(effectiveEvent, 'output_file');

  let nextStatus = existing.status;
  if (
    effectiveSubtype === 'task_started' ||
    effectiveSubtype === 'task_progress'
  ) {
    // Only an explicit background (re-)registration revives a finished card —
    // a resumed subagent is re-registered in the background. A late
    // foreground progress edge must not unwedge a terminal row.
    if (!isTerminalProcessStatus(existing.status) || isBackgrounded) {
      nextStatus = 'running';
    }
  }
  if (effectiveSubtype === 'task_notification') {
    nextStatus = normalizeTaskNotificationStatus(
      getString(effectiveEvent, 'status') ?? 'completed',
    );
  }

  const nextTaskId = taskId ?? existing.taskId;
  const outputTaskId =
    existing.outputTaskId ??
    (existing.outputFile && existing.taskId !== nextTaskId
      ? existing.taskId
      : undefined);

  const nextProcess: BackgroundProcess = {
    ...existing,
    chatId,
    taskId: nextTaskId,
    outputTaskId,
    status: nextStatus,
    updatedAt: timestamp,
    lastDescription:
      getString(effectiveEvent, 'description') ?? existing.lastDescription,
    summary: getString(effectiveEvent, 'summary') ?? existing.summary,
    outputFile: outputFile ?? existing.outputFile,
    canStop: !isTerminalProcessStatus(nextStatus) && Boolean(nextTaskId),
  };

  if (processIndex >= 0) {
    data.bgProcesses[processIndex] = nextProcess;
  } else {
    data.bgProcesses.push(nextProcess);
  }

  if (
    nextProcess.status === 'running' &&
    nextProcess.taskId &&
    nextProcess.outputFile
  ) {
    const pollingTaskId = nextProcess.outputTaskId ?? nextProcess.taskId;
    // Routine progress should not retry a refused start for the same output.
    if (
      effectiveSubtype === 'task_progress' &&
      existing.status === 'running' &&
      existing.outputFile === nextProcess.outputFile &&
      (existing.outputTaskId ?? existing.taskId) === pollingTaskId
    ) {
      return {};
    }
    return {
      startPolling: {
        projectId,
        worktreeId,
        chatId,
        taskId: pollingTaskId,
        outputFile: nextProcess.outputFile,
      },
    };
  }

  if (isTerminalProcessStatus(nextProcess.status) && nextProcess.taskId) {
    const stopPolling = {
      projectId,
      worktreeId,
      chatId,
      taskId: nextProcess.outputTaskId ?? nextProcess.taskId,
    };

    if (nextProcess.outputFile) {
      return {
        startPolling: {
          ...stopPolling,
          outputFile: nextProcess.outputFile,
        },
        delayedStopPolling: stopPolling,
      };
    }

    return { stopPolling };
  }

  return {};
}

function applyBackgroundTasksChangedToData(
  data: WorktreeActivityData,
  projectId: string,
  worktreeId: string,
  chatId: string,
  event: Record<string, unknown>,
  timestamp: number,
): ActivityMutationResult[] | null {
  const activeTaskIds = parseBackgroundTasksChanged(event);
  if (!activeTaskIds) {
    return null;
  }

  const completedProcesses = data.bgProcesses.filter(
    (process) =>
      process.chatId === chatId &&
      process.taskId !== undefined &&
      !isTerminalProcessStatus(process.status) &&
      !activeTaskIds.has(process.taskId),
  );

  return completedProcesses.map((process) =>
    applySystemEventToData(
      data,
      projectId,
      worktreeId,
      chatId,
      completionEventForProcess(process),
      timestamp,
    ),
  );
}

function applySdkSystemEventToData(
  data: WorktreeActivityData,
  projectId: string,
  worktreeId: string,
  chatId: string,
  event: Record<string, unknown>,
  timestamp: number,
): ActivityMutationResult[] {
  return (
    applyBackgroundTasksChangedToData(
      data,
      projectId,
      worktreeId,
      chatId,
      event,
      timestamp,
    ) ?? [
      applySystemEventToData(
        data,
        projectId,
        worktreeId,
        chatId,
        event,
        timestamp,
      ),
    ]
  );
}

function runMutationSideEffects(result: ActivityMutationResult): void {
  if (result.startPolling) {
    // A task running again outlives the stop its earlier ending scheduled.
    const key = pollingKey(result.startPolling);
    clearTimeout(delayedStopTimers.get(key));
    delayedStopTimers.delete(key);
    void window.api.activity
      .startOutputPolling(result.startPolling)
      .catch(() => {
        // Polling is best-effort and should not break the panel.
      });
  }

  if (result.stopPolling) {
    const key = pollingKey(result.stopPolling);
    const existing = delayedStopTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      delayedStopTimers.delete(key);
    }
    void window.api.activity.stopOutputPolling(result.stopPolling).catch(() => {
      // Best-effort cleanup.
    });
  }

  if (result.delayedStopPolling) {
    const delayedStopPolling = result.delayedStopPolling;
    const key = pollingKey(delayedStopPolling);
    const existing = delayedStopTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    delayedStopTimers.set(
      key,
      setTimeout(() => {
        delayedStopTimers.delete(key);
        void window.api.activity
          .stopOutputPolling(delayedStopPolling)
          .catch(() => {
            // Best-effort cleanup.
          });
      }, TERMINAL_OUTPUT_STOP_DELAY_MS),
    );
  }
}

/**
 * Applies one chat's persisted messages to `data`: its tool uses, SDK system
 * events and tool results, in order. Shared by the worktree rebuild and the
 * one-chat adoption.
 */
function applyTabMessagesToData(
  data: WorktreeActivityData,
  projectId: string,
  worktreeId: string,
  tab: ReconstructableTab,
): void {
  for (const message of tab.messages) {
    for (const block of message.blocks) {
      if (
        block.type === 'tool_use' &&
        block.toolUseId &&
        block.toolName &&
        typeof block.input === 'string'
      ) {
        applyToolUseToData(
          data,
          tab.id,
          block.toolUseId,
          block.toolName,
          block.input,
          message.timestamp,
        );
      }

      const systemEvent = parseSystemEventBlock(block);
      if (systemEvent) {
        applySdkSystemEventToData(
          data,
          projectId,
          worktreeId,
          tab.id,
          systemEvent,
          message.timestamp,
        );
      }

      if (block.type === 'tool_result' && block.toolUseId) {
        applyToolResultToData(
          data,
          projectId,
          worktreeId,
          tab.id,
          block.toolUseId,
          block.output ?? '',
          block.isError === true,
          message.timestamp,
        );
      }
    }
  }
}

/**
 * A worktree's tracked plans and how many stored records were left out
 * (CAN-6666). A host on an older release refuses the newer read, so the
 * plain list stands in, with no count.
 */
async function readTrackedPlans(request: {
  projectId: string;
  worktreeId: string;
}): Promise<TrackedPlanListWithSkippedResult> {
  const plans = window.api.activity.plans;
  if (typeof plans.listWithSkipped !== 'function')
    return { plans: await plans.list(request) };
  try {
    return await plans.listWithSkipped(request);
  } catch (error) {
    reportClientAppError(error);
    return { plans: await plans.list(request) };
  }
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  panelExpanded: false,
  changedFiles: {},
  bgProcesses: {},
  toolUses: {},
  worktreeSummaries: {},
  trackedPlans: {},
  trackedPlanSkipped: {},
  trackedPlanInventoryLoaded: {},
  detectedPlans: {},
  summaryGenerating: {},
  worktreeSummaryEnabled: true,
  importModalRequest: null,
  splitPreflight: null,

  openImportModal: (request): void => {
    set({ importModalRequest: request });
  },

  closeImportModal: (): void => {
    set({ importModalRequest: null });
  },

  openSplitPreflight: (projectId, worktreeId): void => {
    set({ splitPreflight: { projectId, worktreeId } });
  },

  closeSplitPreflight: (): void => {
    set({ splitPreflight: null });
  },

  setPanelExpanded: (panelExpanded): void => {
    set({ panelExpanded });
  },

  togglePanelExpanded: (): void => {
    set((state) => ({ panelExpanded: !state.panelExpanded }));
  },

  setChatBackgroundProcesses: (
    projectId,
    worktreeId,
    chatId,
    processes,
  ): void => {
    const key = worktreeKey(projectId, worktreeId);
    set((state) => {
      const current = state.bgProcesses[key] ?? [];
      const others = current.filter((process) => process.chatId !== chatId);
      if (others.length === current.length && processes.length === 0)
        return state;
      return {
        bgProcesses: { ...state.bgProcesses, [key]: [...others, ...processes] },
      };
    });
  },
  setChangedFiles: (projectId, worktreeId, files): void => {
    const key = worktreeKey(projectId, worktreeId);
    const prev = get().changedFiles[key];
    if (changedFilesResponseEqual(prev, files)) {
      return;
    }
    if (hasNewUncommittedFile(prev, files)) {
      // Local-only diff-stats refresh; never writes changedFiles, so this
      // cannot re-enter setChangedFiles (no feedback loop).
      useProjectsStore
        .getState()
        .fastRefreshWorktreeDiffStats(projectId, worktreeId);
    }
    set((state) => ({
      changedFiles: { ...state.changedFiles, [key]: files },
    }));
  },

  setWorktreeSummary: (key, data): void => {
    set((state) =>
      worktreeSummaryDataEqual(state.worktreeSummaries[key], data)
        ? state
        : { worktreeSummaries: { ...state.worktreeSummaries, [key]: data } },
    );
  },

  setTrackedPlans: (key, plans): void => {
    set((state) => {
      const listChanged = !trackedPlanListsEqual(
        state.trackedPlans[key],
        plans,
      );
      const flagChanged = state.trackedPlanInventoryLoaded[key] !== true;
      if (!listChanged && !flagChanged) {
        return state;
      }
      return {
        ...(listChanged
          ? { trackedPlans: { ...state.trackedPlans, [key]: plans } }
          : {}),
        ...(flagChanged
          ? {
              trackedPlanInventoryLoaded: {
                ...state.trackedPlanInventoryLoaded,
                [key]: true,
              },
            }
          : {}),
      };
    });
  },

  setDetectedPlans: (projectId, worktreeId, entries): void => {
    const key = worktreeKey(projectId, worktreeId);
    set((state) => ({
      detectedPlans: { ...state.detectedPlans, [key]: entries },
    }));
  },

  loadDetectedPlans: async (projectId, worktreeId): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    const entries = await window.api.activity.detectedPlans.list({
      projectId,
      worktreeId,
    });
    set((state) => ({
      detectedPlans: { ...state.detectedPlans, [key]: entries },
    }));
  },

  scanDetectedPlans: async (
    projectId,
    worktreeId,
    chatId,
    candidatePaths,
  ): Promise<DetectedPlanEntry[]> => {
    const key = worktreeKey(projectId, worktreeId);
    const response = await window.api.activity.detectedPlans.scan({
      projectId,
      worktreeId,
      chatId,
      candidatePaths,
    });
    set((state) => ({
      detectedPlans: { ...state.detectedPlans, [key]: response.entries },
    }));
    return response.newlyDetected;
  },

  updateDetectedPlan: async (
    projectId,
    worktreeId,
    entryId,
    patch,
  ): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    const entries = await window.api.activity.detectedPlans.update({
      projectId,
      worktreeId,
      entryId,
      ...patch,
    });
    set((state) => ({
      detectedPlans: { ...state.detectedPlans, [key]: entries },
    }));
  },

  upsertTrackedPlan: (plan): void => {
    const key = worktreeKey(plan.projectId, plan.worktreeId);
    recordTrackedPlanWrite(key, plan.id);
    set((state) => {
      const current = state.trackedPlans[key] ?? [];
      const existingIndex = current.findIndex((entry) => entry.id === plan.id);
      const nextPlans =
        existingIndex >= 0
          ? current.map((entry) => (entry.id === plan.id ? plan : entry))
          : [plan, ...current];
      nextPlans.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );

      if (trackedPlanListsEqual(current, nextPlans)) {
        return state;
      }

      return {
        trackedPlans: { ...state.trackedPlans, [key]: nextPlans },
      };
    });
  },

  removeTrackedPlan: (projectId, worktreeId, planId): void => {
    const key = worktreeKey(projectId, worktreeId);
    recordTrackedPlanWrite(key, planId);
    set((state) => {
      const current = state.trackedPlans[key];
      const nextPlans = current?.filter((entry) => entry.id !== planId);
      const trackedPlansChanged =
        current !== undefined &&
        nextPlans !== undefined &&
        nextPlans.length !== current.length;

      if (!trackedPlansChanged || !nextPlans) {
        return state;
      }

      return {
        trackedPlans: { ...state.trackedPlans, [key]: nextPlans },
      };
    });
  },

  setSummaryGenerating: (key, generating): void => {
    set((state) =>
      state.summaryGenerating[key] === generating
        ? state
        : {
            summaryGenerating: {
              ...state.summaryGenerating,
              [key]: generating,
            },
          },
    );
  },

  setWorktreeSummaryEnabled: (enabled): void => {
    set((state) =>
      state.worktreeSummaryEnabled === enabled
        ? state
        : { worktreeSummaryEnabled: enabled },
    );
  },

  loadWorktreeSummary: async (projectId, worktreeId): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    const summary = await window.api.activity.loadWorktreeSummary({
      projectId,
      worktreeId,
    });

    set((state) => {
      if (
        worktreeSummaryDataEqual(
          state.worktreeSummaries[key],
          summary ?? undefined,
        )
      ) {
        return state;
      }
      const worktreeSummaries = { ...state.worktreeSummaries };
      if (summary) {
        worktreeSummaries[key] = summary;
      } else {
        delete worktreeSummaries[key];
      }

      return { worktreeSummaries };
    });
  },

  loadWorktreeSummaries: async (worktrees): Promise<void> => {
    if (worktrees.length === 0) {
      return;
    }
    const batches = Array.from(
      {
        length: Math.ceil(worktrees.length / WORKTREE_SUMMARY_BATCH_SIZE_LIMIT),
      },
      (_, index) =>
        worktrees.slice(
          index * WORKTREE_SUMMARY_BATCH_SIZE_LIMIT,
          (index + 1) * WORKTREE_SUMMARY_BATCH_SIZE_LIMIT,
        ),
    );
    const summaries: WorktreeSummaryLoadBatchResponse = {};
    for (const batch of batches) {
      const response = await window.api.activity.loadWorktreeSummaries({
        worktrees: batch,
      });
      Object.assign(summaries, response);
    }

    set((state) => {
      const liveKeys = new Set(
        useProjectsStore
          .getState()
          .projects.flatMap((project) =>
            project.type === 'cowork'
              ? []
              : project.worktrees.map((worktree) =>
                  worktreeKey(project.id, worktree.id),
                ),
          ),
      );
      let changed = false;
      const worktreeSummaries = { ...state.worktreeSummaries };

      for (const worktree of worktrees) {
        const key = worktreeKey(worktree.projectId, worktree.worktreeId);
        if (!liveKeys.has(key)) {
          continue;
        }
        const summary = summaries[key] ?? undefined;
        if (worktreeSummaryDataEqual(worktreeSummaries[key], summary)) {
          continue;
        }
        changed = true;
        if (summary) {
          worktreeSummaries[key] = summary;
        } else {
          delete worktreeSummaries[key];
        }
      }

      return changed ? { worktreeSummaries } : state;
    });
  },

  loadTrackedPlans: async (projectId, worktreeId): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    const startedAtSequence = trackedPlanWriteSequence;
    const requestSequence = ++trackedPlanListSequence;
    trackedPlanListsInFlight.set(
      key,
      (trackedPlanListsInFlight.get(key) ?? 0) + 1,
    );
    let listed: TrackedPlanData[];
    let skipped: number;
    try {
      const read = await readTrackedPlans({ projectId, worktreeId });
      listed = read.plans;
      skipped = read.skipped ?? 0;
    } catch (error) {
      finishTrackedPlanList(key);
      throw error;
    }
    if (requestSequence < (trackedPlanListsApplied.get(key) ?? 0)) {
      finishTrackedPlanList(key);
      return;
    }
    trackedPlanListsApplied.set(key, requestSequence);
    set((state) => {
      const plans = protectNewerTrackedPlanWrites(
        key,
        listed,
        state.trackedPlans[key],
        startedAtSequence,
      );
      const trackedPlansChanged = !trackedPlanListsEqual(
        state.trackedPlans[key],
        plans,
      );
      const inventoryFlagChanged =
        state.trackedPlanInventoryLoaded[key] !== true;
      const skippedChanged = (state.trackedPlanSkipped[key] ?? 0) !== skipped;
      if (!trackedPlansChanged && !inventoryFlagChanged && !skippedChanged) {
        return state;
      }

      return {
        ...(trackedPlansChanged
          ? { trackedPlans: { ...state.trackedPlans, [key]: plans } }
          : {}),
        ...(skippedChanged
          ? {
              trackedPlanSkipped: {
                ...state.trackedPlanSkipped,
                [key]: skipped,
              },
            }
          : {}),
        ...(inventoryFlagChanged
          ? {
              trackedPlanInventoryLoaded: {
                ...state.trackedPlanInventoryLoaded,
                [key]: true,
              },
            }
          : {}),
      };
    });
    finishTrackedPlanList(key);
  },

  commitTrackedPlanUpdate: (plan): void => {
    get().upsertTrackedPlan(plan);
  },

  noteTrackedPlanWrite: (projectId, worktreeId, planId): void => {
    recordTrackedPlanWrite(worktreeKey(projectId, worktreeId), planId);
  },

  ensureTrackedPlanLoaded: (
    projectId,
    worktreeId,
    planId,
  ): Promise<TrackedPlanData | null> => {
    const key = worktreeKey(projectId, worktreeId);
    const existing = get().trackedPlans[key]?.find(
      (plan) => plan.id === planId,
    );
    if (existing) {
      return Promise.resolve(existing);
    }
    const loadKey = JSON.stringify([projectId, worktreeId, planId]);
    const inFlight = trackedPlanLoadsInFlight.get(loadKey);
    if (inFlight) {
      return inFlight;
    }
    const load = (async (): Promise<TrackedPlanData | null> => {
      try {
        const plan = await window.api.activity.plans.get({
          projectId,
          worktreeId,
          planId,
        });
        if (!plan) {
          return null;
        }
        set((state) => {
          const currentPlans = state.trackedPlans[key] ?? [];
          if (currentPlans.some((entry) => entry.id === plan.id)) {
            return state;
          }
          return {
            trackedPlans: {
              ...state.trackedPlans,
              [key]: [plan, ...currentPlans],
            },
          };
        });
        // A list load or live update that landed while this request was in
        // flight is newer than the fetched copy.
        return (
          get().trackedPlans[key]?.find((entry) => entry.id === planId) ?? plan
        );
      } finally {
        trackedPlanLoadsInFlight.delete(loadKey);
      }
    })();
    trackedPlanLoadsInFlight.set(loadKey, load);
    return load;
  },

  togglePlanHidden: async (plan): Promise<void> => {
    const result = await window.api.activity.plans.update({
      projectId: plan.projectId,
      worktreeId: plan.worktreeId,
      planId: plan.id,
      hidden: !plan.hidden,
    });
    if (result) {
      const key = worktreeKey(plan.projectId, plan.worktreeId);
      set((state) => {
        const current = state.trackedPlans[key] ?? [];
        return {
          trackedPlans: {
            ...state.trackedPlans,
            [key]: current.map((p) => (p.id === plan.id ? result : p)),
          },
        };
      });
    }
  },

  shareTrackedPlan: async (
    projectId,
    worktreeId,
    planId,
    options,
  ): Promise<TrackedPlanData | null> => {
    // Thin client: the main-process handler shares to Canopy Cloud, persists
    // the returned `share` metadata on the local plan, and hands it back. We
    // upsert it so the card/Explore button reflects the new sync state
    // immediately, ahead of any background `trackedPlansUpdated` events.
    const request: ShareTrackedPlanRequest = {
      projectId,
      worktreeId,
      planId,
      ...(options?.shareScope ? { shareScope: options.shareScope } : {}),
      ...(options?.teamId ? { teamId: options.teamId } : {}),
      ...(options?.organizationId
        ? { organizationId: options.organizationId }
        : {}),
    };
    const plan = unwrapShareOperationResult(
      await window.api.activity.plans.share(request),
    );
    if (plan) {
      get().upsertTrackedPlan(plan);
    }
    return plan;
  },

  unshareTrackedPlan: async (
    projectId,
    worktreeId,
    planId,
  ): Promise<TrackedPlanData | null> => {
    // Thin client: main deletes the cloud copy and answers the local plan with
    // `share` cleared. Upsert it so the header and card read "Share" at once.
    const plan = unwrapShareOperationResult(
      await window.api.activity.plans.unshare({
        projectId,
        worktreeId,
        planId,
      }),
    );
    if (plan) {
      get().upsertTrackedPlan(plan);
    }
    return plan;
  },

  shareRun: async (
    projectId,
    worktreeId,
    chatId,
    options,
  ): Promise<ShareRunResponse> => {
    // Thin client: the main-process handler ingests the referenced session rows
    // on demand (bypassing the ambient telemetry gate), then creates the team
    // private, team, or organization `SharedRun` grant and returns its
    // `externalId`.
    return unwrapShareOperationResult(
      await window.api.runs.share({
        projectId,
        worktreeId,
        chatId,
        shareScope: options.shareScope,
        ...(options.teamId ? { teamId: options.teamId } : {}),
        ...(options?.organizationId
          ? { organizationId: options.organizationId }
          : {}),
      }),
    );
  },

  checkShareEligibility: async (
    projectId,
    worktreeId,
    chatId,
  ): Promise<ShareRunEligibilityResponse> => {
    return window.api.runs.checkShareEligibility({
      projectId,
      worktreeId,
      chatId,
    });
  },

  unshareRun: async (
    projectId,
    worktreeId,
    chatId,
  ): Promise<UnshareRunResponse> => {
    // Thin client: the main-process handler recomputes the deterministic
    // idempotency key from the session identity and hard-deletes the grant.
    return window.api.runs.unshare({ projectId, worktreeId, chatId });
  },

  importTrackedPlan: async (
    projectId,
    worktreeId,
    filePath,
    repoId,
  ): Promise<TrackedPlanData | null> => {
    const response = await window.api.activity.plans.import({
      projectId,
      worktreeId,
      ...(filePath ? { filePath } : {}),
      ...(repoId ? { repoId } : {}),
    });
    const plan = response.plan;
    if (plan) {
      get().upsertTrackedPlan(plan);
      await get().loadTrackedPlans(projectId, worktreeId);
    }
    return plan;
  },

  refreshWorktreeSummary: async (projectId, worktreeId): Promise<void> => {
    await window.api.activity.refreshWorktreeSummary({
      projectId,
      worktreeId,
    });
  },

  handleToolUseBlock: (
    projectId,
    worktreeId,
    chatId,
    toolUseId,
    toolName,
    input,
    timestamp = Date.now(),
  ): void => {
    const key = worktreeKey(projectId, worktreeId);
    set((state) => {
      const data = cloneWorktreeActivity(state, key);
      applyToolUseToData(data, chatId, toolUseId, toolName, input, timestamp);
      return buildPatch(state, key, data);
    });
  },

  handleToolResultBlock: (
    projectId,
    worktreeId,
    chatId,
    toolUseId,
    content,
    isError,
    timestamp = Date.now(),
  ): void => {
    const key = worktreeKey(projectId, worktreeId);
    let mutation: ActivityMutationResult = {};

    set((state) => {
      const data = cloneWorktreeActivity(state, key);
      mutation = applyToolResultToData(
        data,
        projectId,
        worktreeId,
        chatId,
        toolUseId,
        content,
        isError,
        timestamp,
      );
      return buildPatch(state, key, data);
    });

    runMutationSideEffects(mutation);
  },

  handleSdkSystemEvent: (
    projectId,
    worktreeId,
    chatId,
    data,
    timestamp = Date.now(),
  ): void => {
    const key = worktreeKey(projectId, worktreeId);
    let mutations: ActivityMutationResult[] = [];

    set((state) => {
      const activity = cloneWorktreeActivity(state, key);
      mutations = applySdkSystemEventToData(
        activity,
        projectId,
        worktreeId,
        chatId,
        data,
        timestamp,
      );
      return buildPatch(state, key, activity);
    });

    for (const mutation of mutations) {
      runMutationSideEffects(mutation);
    }
  },

  applyLiveBackgroundTaskPush: (previous, next): void => {
    const key = worktreeKey(next.projectId, next.worktreeId);
    const mutations: ActivityMutationResult[] = [];
    const timestamp = Date.now();

    set((state) => {
      const data = cloneWorktreeActivity(state, key);
      if (next.sessionActive) {
        applyLiveTasksToChat(
          data,
          next.projectId,
          next.worktreeId,
          next.chatId,
          next.liveTasks,
          timestamp,
          mutations,
          // Without a previous push, a listed task can't be told from one
          // that rejoined, so its card keeps any ending it already has.
          previous &&
            new Set(
              previous.sessionActive
                ? previous.liveTasks.map((task) => task.taskId)
                : [],
            ),
        );
      }

      const nextTaskIds = new Set(next.liveTasks.map((task) => task.taskId));
      for (const task of previous?.liveTasks ?? []) {
        if (next.sessionActive && nextTaskIds.has(task.taskId)) continue;

        const taskProcessIndex = data.bgProcesses.findIndex(
          (process) =>
            process.chatId === next.chatId &&
            (process.taskId === task.taskId ||
              process.outputTaskId === task.taskId),
        );
        const toolUseProcessIndex = task.toolUseId
          ? data.bgProcesses.findIndex(
              (process) =>
                process.chatId === next.chatId &&
                process.toolUseId === task.toolUseId,
            )
          : -1;
        const processIndex =
          taskProcessIndex >= 0 ? taskProcessIndex : toolUseProcessIndex;
        if (processIndex < 0) continue;

        const process = data.bgProcesses[processIndex];
        if (isTerminalProcessStatus(process.status)) continue;
        const stillLive =
          next.sessionActive &&
          next.liveTasks.some(
            (liveTask) =>
              liveTask.taskId === process.taskId ||
              (task.toolUseId !== undefined &&
                liveTask.toolUseId === task.toolUseId),
          );
        if (stillLive) continue;

        if (next.sessionActive) {
          mutations.push(
            applySystemEventToData(
              data,
              next.projectId,
              next.worktreeId,
              next.chatId,
              completionEventForProcess(process),
              timestamp,
            ),
          );
          continue;
        }

        if (process.taskId) {
          mutations.push({
            stopPolling: {
              projectId: next.projectId,
              worktreeId: next.worktreeId,
              chatId: next.chatId,
              taskId: process.outputTaskId ?? process.taskId,
            },
          });
        }
        data.bgProcesses[processIndex] = {
          ...process,
          status: 'stopped',
          summary: process.summary ?? UNRESOLVED_TASK_SUMMARY,
          updatedAt: timestamp,
          canStop: false,
        };
      }

      if (
        backgroundProcessListsEqual(state.bgProcesses[key], data.bgProcesses) &&
        toolUseMapsEqual(state.toolUses[key], data.toolUses)
      ) {
        return state;
      }
      return buildPatch(state, key, data);
    });

    for (const mutation of mutations) {
      runMutationSideEffects(mutation);
    }
  },

  appendBgProcessOutput: (event): void => {
    if (event.lines.length === 0) {
      return;
    }
    const key = worktreeKey(event.projectId, event.worktreeId);
    set((state) => {
      const processes = [...(state.bgProcesses[key] ?? [])];
      let processIndex = findProcessIndex(processes, {
        taskId: event.taskId,
      });
      if (processIndex < 0) {
        processIndex = processes.findIndex(
          (process) =>
            process.outputFile !== undefined &&
            process.outputFile === event.outputFile,
        );
      }
      // Poller output for a process this renderer cannot place is dropped.
      // Minting a synthetic `Task <id>` card here duplicated the real card
      // whose task id reconstruction had thrown away, leaving two rows for
      // one task — one of them permanently `running`.
      if (processIndex < 0) {
        return state;
      }

      const existing = processes[processIndex];
      processes[processIndex] = {
        ...existing,
        taskId: existing.taskId ?? event.taskId,
        outputFile: existing.outputFile ?? event.outputFile,
        outputLines: appendOutputLines(existing.outputLines, event.lines),
        updatedAt: Date.now(),
      };

      return {
        bgProcesses: { ...state.bgProcesses, [key]: processes },
      };
    });
  },

  reconstructFromMessages: (projectId, worktreeId, tabs): void => {
    const key = worktreeKey(projectId, worktreeId);
    const nextData: WorktreeActivityData = {
      bgProcesses: [],
      toolUses: {},
    };
    const previousProcesses = get().bgProcesses[key];
    const previousToolUses = get().toolUses[key];

    for (const tab of tabs) {
      applyTabMessagesToData(nextData, projectId, worktreeId, tab);
    }

    // A task id the event stream correlated with a tool use is learned state
    // too: without it a later backgrounding patch (which carries no
    // `tool_use_id`) could not find the call it belongs to.
    for (const [toolUseId, meta] of Object.entries(nextData.toolUses)) {
      const previousTaskId = previousToolUses?.[toolUseId]?.taskId;
      if (previousTaskId && meta.taskId === undefined) {
        nextData.toolUses[toolUseId] = { ...meta, taskId: previousTaskId };
      }
    }

    // A cloud chat's agent tasks come from the web core, not its transcript
    // (CAN-6452): the rebuild keeps each one, with its id and no local Stop,
    // in place of any launch it rebuilt for the same task.
    const published = (previousProcesses ?? []).filter(isWebCoreTaskProcess);
    const rebuilt = nextData.bgProcesses
      .map((process) => mergePreviousProcessState(previousProcesses, process))
      .filter(
        (process) =>
          findProcessIndex(published, {
            chatId: process.chatId,
            taskId: process.taskId,
            toolUseId: process.toolUseId,
          }) < 0,
      );
    nextData.bgProcesses = withEndedAt(previousProcesses, [
      ...rebuilt,
      ...published,
    ]);

    set((state) => {
      if (
        backgroundProcessListsEqual(
          state.bgProcesses[key],
          nextData.bgProcesses,
        ) &&
        toolUseMapsEqual(state.toolUses[key], nextData.toolUses)
      ) {
        return state;
      }
      return {
        bgProcesses: { ...state.bgProcesses, [key]: nextData.bgProcesses },
        toolUses: { ...state.toolUses, [key]: nextData.toolUses },
      };
    });

    const activeChatIds = Array.from(
      new Set(
        nextData.bgProcesses
          .filter((process) => !isTerminalProcessStatus(process.status))
          .map((process) => process.chatId),
      ),
    );
    if (activeChatIds.length > 0) {
      // Output polling is started by the resolution pass, for the processes
      // that survive it: restarting a poller for every rebuilt "running" row
      // left main polling files for tasks that had already finished.
      void get().resolveBackgroundProcesses(
        projectId,
        worktreeId,
        activeChatIds,
      );
    } else {
      void get().resolveBackgroundProcessLiveness(projectId, worktreeId, []);
    }
  },

  adoptChatMessages: (projectId, worktreeId, tab): void => {
    const key = worktreeKey(projectId, worktreeId);
    const rebuilt: WorktreeActivityData = { bgProcesses: [], toolUses: {} };
    applyTabMessagesToData(rebuilt, projectId, worktreeId, tab);
    const previousProcesses = get().bgProcesses[key] ?? [];
    const previousToolUses = get().toolUses[key] ?? {};
    // A launch already known, by its tool use or (from a task event that
    // carried no tool-use id) by its task, keeps its live entry.
    const added = rebuilt.bgProcesses.filter(
      (process) =>
        findProcessIndex(previousProcesses, {
          chatId: process.chatId,
          toolUseId: process.toolUseId,
          taskId: process.taskId,
        }) < 0,
    );
    const addedToolUses = Object.fromEntries(
      Object.entries(rebuilt.toolUses).filter(
        ([toolUseId]) => previousToolUses[toolUseId] === undefined,
      ),
    );
    if (added.length === 0 && Object.keys(addedToolUses).length === 0) return;
    set((state) => ({
      bgProcesses: {
        ...state.bgProcesses,
        [key]: [...(state.bgProcesses[key] ?? []), ...added],
      },
      toolUses: {
        ...state.toolUses,
        [key]: { ...state.toolUses[key], ...addedToolUses },
      },
    }));
    if (added.some((process) => !isTerminalProcessStatus(process.status))) {
      void get().resolveBackgroundProcesses(projectId, worktreeId, [tab.id]);
    }
  },

  resolveBackgroundProcesses: async (
    projectId,
    worktreeId,
    chatIds,
  ): Promise<void> => {
    await get().reconcileBackgroundProcessesFromObservability(
      projectId,
      worktreeId,
      chatIds,
    );
    await get().resolveBackgroundProcessLiveness(
      projectId,
      worktreeId,
      chatIds,
    );
  },

  resolveBackgroundProcessLiveness: async (
    projectId,
    worktreeId,
    chatIds,
  ): Promise<void> => {
    const key = worktreeKey(projectId, worktreeId);
    const scopedChatIds = new Set(chatIds);
    const livenessKey = `${key}:${Array.from(scopedChatIds).sort().join(',')}`;
    if (livenessInFlight.has(livenessKey)) {
      return;
    }
    livenessInFlight.add(livenessKey);

    try {
      // Absent on hosts whose preload predates the live-task bridge; fall
      // back to the previous behavior of resuming polling for live rows.
      const live = await useLiveBackgroundTaskStore
        .getState()
        .refreshWorktree(projectId, worktreeId);

      const mutations: ActivityMutationResult[] = [];
      const resolvedAt = Date.now();
      set((state) => {
        const data = cloneWorktreeActivity(state, key);
        if (live !== null) {
          for (const [chatId, chatState] of Object.entries(live.chats)) {
            if (!chatState.sessionActive) continue;
            applyLiveTasksToChat(
              data,
              projectId,
              worktreeId,
              chatId,
              chatState.liveTasks,
              resolvedAt,
              mutations,
            );
          }
        }
        data.bgProcesses = data.bgProcesses.map(
          (process): BackgroundProcess => {
            if (
              !scopedChatIds.has(process.chatId) ||
              isTerminalProcessStatus(process.status)
            ) {
              return process;
            }

            const chatState = live?.chats[process.chatId];
            const sessionActive =
              live === null || chatState?.sessionActive === true;
            const stillLive =
              sessionActive &&
              (live === null ||
                process.taskId === undefined ||
                (chatState?.liveTasks.some(
                  (task) => task.taskId === process.taskId,
                ) ??
                  false));

            if (stillLive) {
              if (process.taskId && process.outputFile) {
                mutations.push({
                  startPolling: {
                    projectId,
                    worktreeId,
                    chatId: process.chatId,
                    taskId: process.outputTaskId ?? process.taskId,
                    outputFile: process.outputFile,
                  },
                });
              }
              return process;
            }

            if (process.taskId) {
              mutations.push({
                stopPolling: {
                  projectId,
                  worktreeId,
                  chatId: process.chatId,
                  taskId: process.outputTaskId ?? process.taskId,
                },
              });
            }
            return {
              ...process,
              status: 'stopped',
              summary: process.summary ?? UNRESOLVED_TASK_SUMMARY,
              updatedAt: resolvedAt,
              canStop: false,
            };
          },
        );
        return buildPatch(state, key, data);
      });

      for (const mutation of mutations) {
        runMutationSideEffects(mutation);
      }
    } catch {
      // Best-effort repair; the live event stream stays the primary path.
    } finally {
      livenessInFlight.delete(livenessKey);
    }
  },

  reconcileBackgroundProcessesFromObservability: async (
    projectId,
    worktreeId,
    chatIds,
  ): Promise<void> => {
    if (
      typeof window === 'undefined' ||
      !window.api?.observability?.loadHistory ||
      !window.api.observability.loadTranscript
    ) {
      return;
    }

    const key = worktreeKey(projectId, worktreeId);
    const activeChatIds = new Set(chatIds);
    const activeProcesses = (get().bgProcesses[key] ?? []).filter(
      (process) =>
        activeChatIds.has(process.chatId) &&
        !isTerminalProcessStatus(process.status),
    );
    const activeProcessKeys = new Set(
      activeProcesses.flatMap(activeProcessIdentifierKeys),
    );
    if (activeProcessKeys.size === 0) {
      return;
    }

    const reconciliationKey = `${key}:${Array.from(activeChatIds)
      .sort()
      .join(',')}`;
    if (reconciliationInFlight.has(reconciliationKey)) {
      return;
    }
    reconciliationInFlight.add(reconciliationKey);

    try {
      const response = await window.api.observability.loadHistory({
        projectId,
        worktreeId,
        eventType: 'worktree_chat',
        limit: BACKGROUND_PROCESS_HISTORY_LIMIT,
      });
      const entries = response.entries
        .filter(
          (entry) =>
            entry.hasTranscript &&
            entry.eventType === 'worktree_chat' &&
            typeof entry.chatId === 'string' &&
            activeChatIds.has(entry.chatId),
        )
        .sort((left, right) => auditEntryTime(right) - auditEntryTime(left));

      const observedEvents: Array<{
        chatId: string;
        event: Record<string, unknown>;
        timestamp: number;
      }> = [];
      const unresolvedProcessKeys = new Set(activeProcessKeys);

      for (
        let start = 0;
        start < entries.length && unresolvedProcessKeys.size > 0;
        start += BACKGROUND_PROCESS_TRANSCRIPT_CONCURRENCY
      ) {
        if (unresolvedProcessKeys.size === 0) {
          break;
        }

        const batch = entries.slice(
          start,
          start + BACKGROUND_PROCESS_TRANSCRIPT_CONCURRENCY,
        );
        const transcripts = await Promise.all(
          batch.map(async (entry) => ({
            entry,
            transcript: await window.api.observability.loadTranscript(
              buildTranscriptRequest(entry),
            ),
          })),
        );

        for (const { entry, transcript } of transcripts) {
          if (unresolvedProcessKeys.size === 0) {
            break;
          }

          const chatId = entry.chatId;
          if (typeof chatId !== 'string' || transcript.type !== 'success') {
            continue;
          }

          const timestamp = auditEntryTime(entry);
          const observedActiveTaskIds = new Set<string>();
          for (const line of transcript.lines) {
            const taskEvent = parseTranscriptTaskEvent(line);
            if (
              taskEvent &&
              getRecordString(taskEvent, 'subtype') === 'task_started'
            ) {
              const startedTaskId = getRecordString(
                taskEvent,
                'task_id',
                'taskId',
              );
              if (startedTaskId) observedActiveTaskIds.add(startedTaskId);
            }

            const snapshotTaskIds = parseTranscriptBackgroundTasksChanged(line);
            if (snapshotTaskIds) {
              for (const process of activeProcesses) {
                if (
                  process.chatId !== chatId ||
                  !process.taskId ||
                  !observedActiveTaskIds.has(process.taskId) ||
                  snapshotTaskIds.has(process.taskId)
                ) {
                  continue;
                }
                const snapshotEvent = completionEventForProcess(process);
                const matchedKeys = matchingTerminalEventKeys(
                  snapshotEvent,
                  unresolvedProcessKeys,
                );
                if (matchedKeys.length === 0) {
                  continue;
                }
                observedEvents.push({
                  chatId,
                  event: snapshotEvent,
                  timestamp,
                });
                for (const matchedKey of matchedKeys) {
                  unresolvedProcessKeys.delete(matchedKey);
                }
              }
              for (const taskId of Array.from(snapshotTaskIds)) {
                observedActiveTaskIds.add(taskId);
              }
            }

            const event =
              parseTranscriptTerminalTaskEvent(line) ??
              synthesizeBashNotificationEvent(
                line,
                chatId,
                activeProcesses,
                unresolvedProcessKeys,
              );
            if (!event) {
              continue;
            }
            const matchedKeys = matchingTerminalEventKeys(
              event,
              unresolvedProcessKeys,
            );
            if (matchedKeys.length === 0) {
              continue;
            }

            observedEvents.push({
              chatId,
              event,
              timestamp,
            });
            for (const matchedKey of matchedKeys) {
              unresolvedProcessKeys.delete(matchedKey);
            }
          }
        }
      }

      if (observedEvents.length === 0) {
        return;
      }

      const mutations: ActivityMutationResult[] = [];
      observedEvents.sort((left, right) => left.timestamp - right.timestamp);
      set((state) => {
        const data = cloneWorktreeActivity(state, key);
        for (const observed of observedEvents) {
          const mutation = applySystemEventToData(
            data,
            projectId,
            worktreeId,
            observed.chatId,
            observed.event,
            observed.timestamp,
          );
          mutations.push(mutation);
        }
        return buildPatch(state, key, data);
      });

      for (const mutation of mutations) {
        runMutationSideEffects(mutation);
      }
    } catch {
      // Best-effort repair. Live SDK events remain the primary update path.
    } finally {
      reconciliationInFlight.delete(reconciliationKey);
    }
  },

  cleanupWorktree: (projectId, worktreeId): void => {
    const key = worktreeKey(projectId, worktreeId);
    const processes = get().bgProcesses[key] ?? [];

    // Clear any pending delayed-stop timers for this worktree
    const prefix = `${projectId}/${worktreeId}/`;
    for (const [timerKey, timerId] of Array.from(delayedStopTimers.entries())) {
      if (timerKey.startsWith(prefix)) {
        clearTimeout(timerId);
        delayedStopTimers.delete(timerKey);
      }
    }

    set((state) => {
      const changedFiles = { ...state.changedFiles };
      const bgProcesses = { ...state.bgProcesses };
      const toolUses = { ...state.toolUses };
      const worktreeSummaries = { ...state.worktreeSummaries };
      const trackedPlans = { ...state.trackedPlans };
      const trackedPlanInventoryLoaded = {
        ...state.trackedPlanInventoryLoaded,
      };
      const detectedPlans = { ...state.detectedPlans };
      const summaryGenerating = { ...state.summaryGenerating };

      delete changedFiles[key];
      delete bgProcesses[key];
      delete toolUses[key];
      delete worktreeSummaries[key];
      delete trackedPlans[key];
      delete trackedPlanInventoryLoaded[key];
      delete detectedPlans[key];
      delete summaryGenerating[key];

      return {
        changedFiles,
        bgProcesses,
        toolUses,
        worktreeSummaries,
        trackedPlans,
        trackedPlanInventoryLoaded,
        detectedPlans,
        summaryGenerating,
      };
    });

    for (const process of processes) {
      const outputTaskId = process.outputTaskId ?? process.taskId;
      if (!outputTaskId) continue;
      void window.api.activity
        .stopOutputPolling({
          projectId,
          worktreeId,
          chatId: process.chatId,
          taskId: outputTaskId,
        })
        .catch(() => {
          // Best-effort cleanup.
        });
    }
  },
}));

registerWorktreeActivityCleanup((projectId, worktreeId) => {
  useActivityStore.getState().cleanupWorktree(projectId, worktreeId);
});

registerLoadedChangedFilesRefresh(async (projectId, worktreeId, options) => {
  const key = worktreeKey(projectId, worktreeId);
  const listed = (): boolean => {
    if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) return true;
    const state = useProjectsStore.getState();
    const project = state.projects.find((item) => item.id === projectId);
    return (
      !!project &&
      project.type !== 'cowork' &&
      project.worktrees.some((row) => row.id === worktreeId) &&
      !state.archivingWorktrees.has(key)
    );
  };
  if (!listed()) return undefined;
  if (
    options.onlyIfLoaded &&
    useActivityStore.getState().changedFiles[key] === undefined
  ) {
    return undefined;
  }

  try {
    const changedFiles = await window.api.activity.getChangedFiles({
      projectId,
      worktreeId,
    });
    if (!listed()) return undefined;
    useActivityStore
      .getState()
      .setChangedFiles(projectId, worktreeId, changedFiles);
    return changedFiles;
  } catch {
    // Best-effort: the next activity refresh can retry without blocking the
    // branch/base mutation that already succeeded.
    return undefined;
  }
});

setLiveBackgroundTaskPushHandler((previous, next) => {
  useActivityStore.getState().applyLiveBackgroundTaskPush(previous, next);
});
