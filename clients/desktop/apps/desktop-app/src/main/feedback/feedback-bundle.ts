import {
  FeedbackBundleBuilder,
  MAX_FILE_BYTES,
  normalizeZipPath,
  isPathWithinRoot,
  safeLstat,
} from './feedback-archive';
export { MAX_FILE_BYTES } from './feedback-archive';
import { FeedbackReportErrorSchema } from '@canopy/protocol/feedback-report';
import {
  createReadStream,
  type Dirent,
  type ReadStream,
  type Stats,
} from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import {
  cpus,
  homedir,
  hostname,
  release,
  totalmem,
  type,
  version,
} from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { app } from 'electron';
import { BRAND } from '@canopy/brand/current';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  createForeignCrashDumpFilter,
  hasWin32ShortNameComponent,
  readMinidumpExecutablePath,
  type CrashDumpClassification,
} from '@canopy/desktop-instrumentation/electron/main';
import {
  COWORK_HOME_WORKTREE_ID,
  FEEDBACK_AREAS,
  MODEL_HARNESS_OVERRIDES_VERSION,
  STANDALONE_CHAT_PROJECT_ID,
  getModelHarnessAssignmentSnapshot,
  type FeedbackArea,
  type FeedbackPrepareRequest,
  type FeedbackPrepareResponse,
  type FeedbackWorkspaceSelection,
} from '@canopy/desktop-shared/types';
import type {
  AgentAuditEntry,
  AgentAuditEventType,
} from '@canopy/execution-engine/types/observability';
import {
  AGENT_AUDIT_EVENT_TYPES,
  parseAgentAuditEventType,
} from '@canopy/execution-engine/types/observability';
import {
  getAgentObservabilityAuditDir,
  getAgentObservabilityDiagnosticsDir,
  getAgentObservabilitySnapshotPath,
  getAgentObservabilityTranscriptFilePath,
  getBundlesIndexFilePath,
  // Legacy `standalone-chat/{project}` path helpers. Kept only for bundling
  // the legacy `projects.json`/`project.json` files — those have no
  // new-layout equivalent (settings now live on the workspace's
  // `CoworkSidebarItem`); post-migration these simply add nothing to the
  // bundle. Live chat data (tabs/history) is bundled from the migrated
  // workspace layout below.
  getChatProjectProjectFilePath,
  getChatProjectsFilePath,
  getDataDir,
  getHookInvocationsDir,
  getMcpServersIndexFilePath,
  getPipelinePluginPreferencesFilePath,
  getPreferencesFilePath,
  getWorkspaceChatHistoryConversationFilePath,
  getWorkspaceChatHistoryMetaFilePath,
  getWorkspaceChatHistoryRootDir,
  getWorkspaceChatHistorySummaryFilePath,
  getWorkspaceChatTabsFilePath,
  getWorkspaceTrackedPlansFilePath,
  getWorktreeSummaryFilePath,
  getWorkspaceScriptRunDir,
  w5RecordReadPaths,
} from '../lib/paths';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { listWorkEntryIds } from '../lib/cowork-work-entries';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { validateId } from '../lib/validation';
import { flushMainProcessLogging } from '../lib/main-process-logging';
import type { MainLogFlushResult } from '../lib/async-main-log-sink';
import { listCrashDumpFiles } from '../observability/crash-dump-sweep';

const MAX_OUTPUT_FILENAME_ATTEMPTS = 100;
const FEEDBACK_VERSION = 1;
const MAIN_LOG_FEEDBACK_FLUSH_TIMEOUT_MS = 1000;
const CRASH_DUMPS_ZIP_DIR = 'system-logs/crash-dumps';
const CRASH_DUMP_FEEDBACK_MAX_COUNT = 5;
const CRASH_DUMP_FEEDBACK_MAX_FILE_BYTES = 16 * 1024 * 1024;
const CRASH_DUMP_FEEDBACK_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
// Filter reasons for a readable dump the node rule keeps. A bundle also
// requires the executable to sit inside the app root (`locationVerdict`), so
// only this app's own processes ship; the filter keeps dumps it cannot read,
// qualify or place, and a bundle leaves the machine, so those stay out of it.
// `short_name` is left out: the filter cannot compare a Windows 8.3 path with
// the app root and reports every such path as in place, so `includeCrashDumps`
// also rejects any executable at an 8.3 path.
const CRASH_DUMP_BUNDLE_KEEP_REASONS: ReadonlySet<
  CrashDumpClassification['reason']
> = new Set(['not_node', 'app_bundle', 'inside_app_root']);
/**
 * Which audit event types contribute a transcript sidecar to a worktree-scoped
 * feedback bundle, and which to a chat-scoped one.
 *
 * These are exhaustive `Record`s rather than `Set` literals on purpose: a new
 * `AgentAuditEventType` is a compile error here, forcing an explicit
 * include/exclude decision. As `Set`s they were silently incomplete — a new
 * event type seeded a transcript that no bundle ever collected, which is how
 * `chat_handoff_summary` transcripts were initially dropped.
 */
const TRANSCRIPT_WORKTREE_EVENT_INCLUSION: Record<
  AgentAuditEventType,
  boolean
> = {
  worktree_chat: true,
  chat_summary: true,
  chat_handoff_summary: true,
  archive_summary: true,
  standalone_chat: false,
  app_advisor: false,
  pipeline_editor: false,
  pipeline_agent_turn: false,
  pipeline_advisor: false,
  pr_generation: false,
  pr_split_planning: false,
  commit_message_generation: false,
  branch_naming: false,
  cron_generation: false,
  automation_if_command_generation: false,
  worktree_summary: false,
  worktree_plan_chat: false,
  worktree_plan_diagram: false,
  code_review_annotations: false,
  code_review_diagram: false,
  local_memory_consolidation: false,
  local_memory_chat_profile: false,
  skill_suggestion_scan: false,
  managed_delegation: false,
};

const TRANSCRIPT_CHAT_EVENT_INCLUSION: Record<AgentAuditEventType, boolean> = {
  standalone_chat: true,
  app_advisor: true,
  archive_summary: true,
  chat_summary: true,
  chat_handoff_summary: true,
  worktree_chat: false,
  pipeline_editor: false,
  pipeline_agent_turn: false,
  pipeline_advisor: false,
  pr_generation: false,
  pr_split_planning: false,
  commit_message_generation: false,
  branch_naming: false,
  cron_generation: false,
  automation_if_command_generation: false,
  worktree_summary: false,
  worktree_plan_chat: false,
  worktree_plan_diagram: false,
  code_review_annotations: false,
  code_review_diagram: false,
  local_memory_consolidation: false,
  local_memory_chat_profile: false,
  skill_suggestion_scan: false,
  managed_delegation: false,
};

function includedTranscriptEvents(
  inclusion: Record<AgentAuditEventType, boolean>,
): ReadonlySet<AgentAuditEventType> {
  return new Set<AgentAuditEventType>(
    AGENT_AUDIT_EVENT_TYPES.filter((eventType) => inclusion[eventType]),
  );
}

const TRANSCRIPT_WORKTREE_EVENTS: ReadonlySet<AgentAuditEventType> =
  includedTranscriptEvents(TRANSCRIPT_WORKTREE_EVENT_INCLUSION);
const TRANSCRIPT_CHAT_EVENTS: ReadonlySet<AgentAuditEventType> =
  includedTranscriptEvents(TRANSCRIPT_CHAT_EVENT_INCLUSION);

interface FeedbackCrashDumpsSummary {
  included: number;
  sidecarPath: string;
  /** Minidumps capture process memory, which can hold tokens or file contents. */
  mayContainMemoryContents: true;
}

interface CollectedFeedbackFiles {
  crashDumps: FeedbackCrashDumpsSummary | undefined;
}

interface NormalizedFeedbackRequest {
  description: string;
  area: FeedbackArea;
  workspaceSelections: FeedbackWorkspaceSelection[];
  chatProjectIds: string[];
  includeChatDetails: boolean;
  includePipelineExecutions: boolean;
}

interface ReservedFeedbackOutput {
  filename: string;
  outputPath: string;
  fileHandle: FileHandle;
}

interface PipelineExecutionSnapshot {
  id: string;
  pipelineId: string;
  pipelineName: string;
  status: string;
  startedAt: string;
  sourcePath: string;
  stateFilename: string;
  executionDirName: string;
  completedAt?: string;
  eventName?: string;
  projectId?: string;
  worktreeId?: string;
  planId?: string;
  planModified?: boolean;
  hasPlan?: boolean;
  hasReport?: boolean;
  rerunSourceId?: string;
  parentExecutionId?: string;
  parentStepId?: string;
  parentAttempt?: number;
  parentIteration?: number;
  hidden?: boolean;
  triggerSource?: unknown;
}

interface PipelineExecutionSummarySnapshot {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  status: string;
  started_at: string;
  completed_at?: string;
  event_name?: string;
  project_id?: string;
  worktree_id?: string;
  plan_id?: string;
  plan_modified?: boolean;
  has_plan?: boolean;
  has_report?: boolean;
  rerun_source_id?: string;
  parent_execution_id?: string;
  parent_step_id?: string;
  parent_attempt?: number;
  parent_iteration?: number;
  hidden?: boolean;
  trigger_source?: unknown;
}

/**
 * Where the produced diagnostics zip should be written.
 * - `downloads`: the user's Downloads directory (the offline export path).
 * - `temp`: the OS temp directory, used by the feedback-submit flow which reads
 *   the bytes for upload and then deletes the file.
 */
export type FeedbackBundleDestination = 'downloads' | 'temp';

export interface PrepareFeedbackBundleOptions {
  /** Snapshots keep editable answers outside their immutable archive. */
  allowEmptyDescription?: boolean;
  bounded?: boolean;
  destination?: FeedbackBundleDestination;
  /** Defaults to true. Snapshot preparation or legacy submit turns it off
   * when dumps would push the bundle past its size limit. */
  includeCrashDumps?: boolean;
}

export async function prepareFeedbackBundle(
  request: FeedbackPrepareRequest,
  options?: PrepareFeedbackBundleOptions,
): Promise<FeedbackPrepareResponse> {
  const destination: FeedbackBundleDestination =
    options?.destination ?? 'downloads';
  const description = request.description.trim();
  if (!options?.allowEmptyDescription && description.length === 0)
    throw new Error('Feedback description is required');
  const normalized: NormalizedFeedbackRequest = {
    description,
    ...normalizeScope(request),
  };
  const reportError =
    request.error === undefined
      ? undefined
      : FeedbackReportErrorSchema.parse(request.error);
  const preparedAtDate = new Date();
  const preparedAt = preparedAtDate.toISOString();
  const builder = new FeedbackBundleBuilder(options?.bounded);
  let reservedOutput: ReservedFeedbackOutput | null = null;

  try {
    const collected = await collectFeedbackFiles(
      builder,
      normalized,
      options?.includeCrashDumps ?? true,
    );
    const harnessSnapshot = getModelHarnessAssignmentSnapshot();
    builder.addManifest({
      ...(reportError ? { error: reportError } : {}),
      version: FEEDBACK_VERSION,
      preparedAt,
      description: normalized.description,
      area: normalized.area,
      workspaceSelections: normalized.workspaceSelections,
      chatProjectIds: normalized.chatProjectIds,
      includeChatDetails: normalized.includeChatDetails,
      includePipelineExecutions: normalized.includePipelineExecutions,
      ...(collected.crashDumps === undefined
        ? {}
        : { crashDumps: collected.crashDumps }),
      app: {
        version: app.getVersion(),
        runtimeMode: app.isPackaged ? 'prod' : 'dev',
        platform: hostPlatformOperatingSystem(),
        arch: process.arch,
        electron: process.versions.electron,
        node: process.versions.node,
      },
      machine: {
        hostname: hostname(),
        osType: type(),
        osRelease: release(),
        osVersion: version(),
        totalMemoryBytes: totalmem(),
        cpuCount: cpus().length,
      },
      modelHarnessAssignments: {
        persistenceSchemaVersion: MODEL_HARNESS_OVERRIDES_VERSION,
        revision: harnessSnapshot.revision,
        assignments: Object.fromEntries(
          harnessSnapshot.assignments.map((assignment) => [
            assignment.modelId,
            {
              source: assignment.source,
              harness: assignment.harness,
              defaultHarness: assignment.defaultHarness,
              configurable: assignment.configurable,
              overridden: assignment.overridden,
            },
          ]),
        ),
      },
    });
    reservedOutput = await reserveFeedbackOutput(preparedAtDate, destination);
    try {
      await builder.writeTo(reservedOutput.fileHandle, options?.bounded);
    } finally {
      await closeFileHandle(reservedOutput.fileHandle);
    }
    const outputStat = await stat(reservedOutput.outputPath);
    return {
      filename: reservedOutput.filename,
      absolutePath: reservedOutput.outputPath,
      createdAt: preparedAt,
      sizeBytes: outputStat.size,
    };
  } catch (error) {
    if (reservedOutput !== null) {
      await closeReservedOutput(reservedOutput).catch(() => undefined);
      releaseTemporaryFeedbackBundle(reservedOutput.outputPath);
    }
    throw error;
  }
}

// Host-specific paths outside workspace roots have no portable identity or
// daemon port yet (Phase 6). Keep this effect on the existing preparation
// boundary; the inventory records this capability exception separately.
const activeTemporaryOutputs = new Set<string>();
const STALE_FEEDBACK_AGE_MS = 60 * 60 * 1000;
const feedbackFilenamePattern = new RegExp(
  `^${BRAND.internalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-feedback-\\d{8}T\\d{9}Z(?:-[1-9]\\d?)?\\.zip$`,
);

export function releaseTemporaryFeedbackBundle(outputPath: string): void {
  activeTemporaryOutputs.delete(outputPath);
}

export async function cleanupStaleTemporaryFeedbackBundles(): Promise<void> {
  try {
    const directory = app.getPath('temp');
    const downloads = app.getPath('downloads');
    const downloadsRoot = await realpath(downloads).catch(() =>
      resolve(downloads),
    );
    if (isPathWithinRoot(await realpath(directory), downloadsRoot)) return;
    const cutoff = Date.now() - STALE_FEEDBACK_AGE_MS;
    for (const name of await readdir(directory)) {
      if (!feedbackFilenamePattern.test(name)) continue;
      const path = join(directory, name);
      try {
        const metadata = await lstat(path);
        // Recheck ownership after metadata I/O. Ownership lasts through upload,
        // not merely until ZIP writing finishes. This is process-local only.
        if (
          metadata.isFile() &&
          metadata.mtimeMs < cutoff &&
          !activeTemporaryOutputs.has(path)
        ) {
          // eslint-disable-next-line admitted-writers/no-unadmitted-write -- removes a stale temporary feedback zip; remove when the bundle stops naming preferences.
          await rm(path, { force: true });
        }
      } catch {
        // Stale cleanup must never affect report creation.
      }
    }
  } catch {
    // Missing/unreadable temporary directories are best-effort too.
  }
}

async function reserveFeedbackOutput(
  preparedAtDate: Date,
  destination: FeedbackBundleDestination,
): Promise<ReservedFeedbackOutput> {
  const outputDir =
    destination === 'temp' ? app.getPath('temp') : app.getPath('downloads');
  await mkdir(outputDir, { recursive: true });
  const timestamp = formatFeedbackTimestamp(preparedAtDate);

  for (let attempt = 0; attempt < MAX_OUTPUT_FILENAME_ATTEMPTS; attempt += 1) {
    const filename = formatFeedbackFilename(timestamp, attempt);
    const outputPath = join(outputDir, filename);
    try {
      // eslint-disable-next-line admitted-writers/no-unadmitted-write -- reserves a new feedback zip; remove when the bundle stops naming preferences.
      const fileHandle = await open(outputPath, 'wx', 0o600);
      if (destination === 'temp') activeTemporaryOutputs.add(outputPath);
      return { filename, outputPath, fileHandle };
    } catch (error) {
      if (getErrorCode(error) === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }

  throw new Error('Could not reserve a feedback bundle filename');
}

function formatFeedbackFilename(timestamp: string, attempt: number): string {
  const prefix = `${BRAND.internalName}-feedback`;
  if (attempt === 0) {
    return `${prefix}-${timestamp}.zip`;
  }
  return `${prefix}-${timestamp}-${attempt}.zip`;
}

async function closeReservedOutput(
  reservedOutput: ReservedFeedbackOutput,
): Promise<void> {
  await closeFileHandle(reservedOutput.fileHandle);
  // eslint-disable-next-line admitted-writers/no-unadmitted-write -- removes the reserved feedback zip; remove when the bundle stops naming preferences.
  await rm(reservedOutput.outputPath, { force: true });
}

async function closeFileHandle(fileHandle: FileHandle): Promise<void> {
  try {
    await fileHandle.close();
  } catch {
    // The handle may already be closed after a stream failure.
  }
}

function normalizeScope(
  request: Omit<FeedbackPrepareRequest, 'description'>,
): Omit<NormalizedFeedbackRequest, 'description'> {
  if (!FEEDBACK_AREAS.includes(request.area)) {
    throw new Error(`Invalid feedback area: ${request.area}`);
  }

  const workspaceSelections = request.workspaceSelections ?? [];
  const chatProjectIds = request.chatProjectIds ?? [];

  for (const selection of workspaceSelections) {
    validateId(selection.workspaceId, 'workspaceId');
    for (const worktreeId of selection.worktreeIds) {
      validateId(worktreeId, 'worktreeId');
    }
  }
  for (const chatProjectId of chatProjectIds) {
    validateId(chatProjectId, 'chatProjectId');
  }

  const scopedWorkspaceSelections =
    request.area === 'worktrees' ? workspaceSelections : [];
  const scopedChatProjectIds = request.area === 'chat' ? chatProjectIds : [];
  const scopedIncludeChatDetails =
    (request.area === 'worktrees' || request.area === 'chat') &&
    (request.includeChatDetails ?? false);
  const scopedIncludePipelineExecutions =
    request.area === 'worktrees' &&
    (request.includePipelineExecutions ?? false);

  return {
    area: request.area,
    workspaceSelections: scopedWorkspaceSelections,
    chatProjectIds: scopedChatProjectIds,
    includeChatDetails: scopedIncludeChatDetails,
    includePipelineExecutions: scopedIncludePipelineExecutions,
  };
}

async function collectFeedbackFiles(
  builder: FeedbackBundleBuilder,
  request: NormalizedFeedbackRequest,
  includeDumps: boolean,
): Promise<CollectedFeedbackFiles> {
  await includeCoreDiagnostics(builder);
  await includeAppLogs(builder);
  const crashDumps = includeDumps
    ? await includeCrashDumps(builder)
    : undefined;
  if (!includeDumps) builder.recordSkipped(CRASH_DUMPS_ZIP_DIR, 'too-large');
  if (request.area === 'pipelines') {
    await includePipelineDiagnostics(builder);
  }
  if (request.area === 'plugins') {
    await includePluginDiagnostics(builder);
  }
  await includeWorkspaceDiagnostics(
    builder,
    request.workspaceSelections,
    request.includeChatDetails,
  );
  await includeChatProjectMetadata(builder, request.chatProjectIds);

  if (request.area === 'worktrees') {
    await includeWorktreePipelineDiagnostics(
      builder,
      request.workspaceSelections,
      request.includePipelineExecutions,
    );
  }

  if (request.area === 'worktrees' && request.includeChatDetails) {
    await includeWorktreeChatDetails(builder, request.workspaceSelections);
  }
  if (request.area === 'chat' && request.includeChatDetails) {
    await includeStandaloneChatDetails(builder, request.chatProjectIds);
  }
  return { crashDumps };
}

async function includeCoreDiagnostics(
  builder: FeedbackBundleBuilder,
): Promise<void> {
  const dataDir = getDataDir();
  await builder.addDirectoryIfSafe(
    getAgentObservabilityDiagnosticsDir(),
    dataRelativeZipPath(getAgentObservabilityDiagnosticsDir()),
    { sourceRoot: dataDir },
  );
  await builder.addDirectoryIfSafe(
    getAgentObservabilityAuditDir(),
    dataRelativeZipPath(getAgentObservabilityAuditDir()),
    { sourceRoot: dataDir },
  );
  await builder.addFileIfSafe(
    getAgentObservabilitySnapshotPath(),
    dataRelativeZipPath(getAgentObservabilitySnapshotPath()),
    { sourceRoot: dataDir },
  );
  await builder.addFileIfSafe(
    getPreferencesFilePath(),
    dataRelativeZipPath(getPreferencesFilePath()),
    { sourceRoot: dataDir },
  );
  await builder.addFileIfSafe(
    w5RecordReadPaths.index(),
    dataRelativeZipPath(w5RecordReadPaths.index()),
    { sourceRoot: dataDir },
  );
}

type FeedbackMainLogFence =
  | { status: 'settled'; result: MainLogFlushResult }
  | { status: 'timed_out' }
  | { status: 'failed' };

/** Finite admission fence only: feedback must never close the running logger. */
async function awaitFeedbackMainLogFence(): Promise<FeedbackMainLogFence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FeedbackMainLogFence>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: 'timed_out' }),
      MAIN_LOG_FEEDBACK_FLUSH_TIMEOUT_MS,
    );
  });
  try {
    const fence = flushMainProcessLogging().then(
      (result): FeedbackMainLogFence => ({ status: 'settled', result }),
      (): FeedbackMainLogFence => ({ status: 'failed' }),
    );
    return await Promise.race([fence, timeout]);
  } catch {
    // Do not expose arbitrary logger errors or silently qualify an incomplete tail.
    return { status: 'failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function includeAppLogs(builder: FeedbackBundleBuilder): Promise<void> {
  const platform = hostPlatformOperatingSystem();
  if (platform !== 'darwin' && platform !== 'linux') {
    return;
  }
  if (platform === 'darwin') {
    await includeMacDiagnosticReports(builder);
  }

  const uiLogDirName = `${BRAND.internalName}-ui`;
  // Startup registers the actual logger directory, including E2E isolation.
  const appUiLog = join(app.getPath('logs'), 'main.log');
  const zipPath = posix.join('system-logs', uiLogDirName, 'main.log');
  const fence = await awaitFeedbackMainLogFence();
  // Archived alongside the log and listed in feedback.json includedFiles.
  // Settled means pre-call attempts finished, not lossless/fsync/atomic capture.
  builder.addGeneratedJson(
    posix.join('system-logs', uiLogDirName, 'main-log-flush.json'),
    {
      version: 1,
      logPath: zipPath,
      timeoutMs: MAIN_LOG_FEEDBACK_FLUSH_TIMEOUT_MS,
      scope: 'pre-collection-admission',
      ...fence,
    },
  );
  // Keep useful existing bytes even if the finite fence did not settle.
  // The sidecar records that the pending tail was not qualified.
  await builder.addFileIfSafe(appUiLog, zipPath, {
    sourceRoot: dirname(appUiLog),
  });
}

async function includeMacDiagnosticReports(
  builder: FeedbackBundleBuilder,
): Promise<void> {
  const diagnosticReportsDir = join(
    getFeedbackHomeDir(),
    'Library',
    'Logs',
    'DiagnosticReports',
  );
  let diagnosticEntries: Dirent<string>[];
  try {
    diagnosticEntries = await readdir(diagnosticReportsDir, {
      withFileTypes: true,
    });
  } catch {
    diagnosticEntries = [];
  }
  await Promise.all(
    diagnosticEntries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }
      if (!isCanopyDiagnosticReport(entry.name)) {
        return;
      }
      const sourcePath = join(diagnosticReportsDir, entry.name);
      let reportContents: string;
      try {
        reportContents = await readFile(sourcePath, 'utf8');
      } catch {
        return;
      }
      if (!isCanopyDiagnosticReport(entry.name, reportContents)) {
        return;
      }
      await builder.addFileIfSafe(
        sourcePath,
        posix.join('system-logs', 'DiagnosticReports', entry.name),
        { sourceRoot: diagnosticReportsDir },
      );
    }),
  );
}

interface CrashDumpCandidate {
  filePath: string;
  name: string;
  stats: Stats;
}

/**
 * Includes the newest local crash dumps on every platform. Crash dumps have no
 * gate of their own, like the app log and the macOS DiagnosticReports beside
 * them: the whole bundle is built only when the user explicitly exports
 * diagnostics, or submits feedback with diagnostics included. Minidumps can
 * hold process memory, so the sidecar and the manifest both say so. Only
 * readable dumps whose executable is inside the app root are included, even
 * before the startup sweep has run. Foreign, unreadable or otherwise unplaced
 * dumps stay out, unlike the sweep, which keeps them. Where the foreign-dump
 * filter does not apply, no dumps are included.
 */
async function includeCrashDumps(
  builder: FeedbackBundleBuilder,
): Promise<FeedbackCrashDumpsSummary | undefined> {
  const hostOs = hostOperatingSystem();
  if (!hostOs) return undefined;
  const crashDumps = app.getPath('crashDumps');
  const classifications: CrashDumpClassification[] = [];
  // The executable path the filter read from each dump.
  const executablePaths = new Map<string, string>();
  const classify = createForeignCrashDumpFilter({
    getCrashDumpsDir: () => crashDumps,
    getExePath: () => app.getPath('exe'),
    platform: hostOs,
    readExecutablePath: async (filePath) => {
      const result = await readMinidumpExecutablePath(filePath);
      if (result.status === 'ok') {
        executablePaths.set(filePath, result.executablePath);
      }
      return result;
    },
    onClassified: (classification) => {
      classifications.push(classification);
    },
  });
  const listing = await listCrashDumpFiles(crashDumps);
  const candidates: CrashDumpCandidate[] = [];
  for (const filePath of listing.filePaths) {
    const result = await safeLstat(filePath);
    if (result.status !== 'ok' || !result.stats.isFile()) continue;
    candidates.push({
      filePath,
      name: relative(crashDumps, filePath).split(sep).join(posix.sep),
      stats: result.stats,
    });
  }
  candidates.sort(
    (left, right) =>
      right.stats.mtimeMs - left.stats.mtimeMs ||
      left.name.localeCompare(right.name),
  );

  const included: { name: string; size_bytes: number; modified_at: string }[] =
    [];
  const skipped: { name: string; reason: 'too-large' | 'total-limit' }[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (included.length >= CRASH_DUMP_FEEDBACK_MAX_COUNT) break;
    // The filter calls `onClassified` exactly once per call, including when
    // classification throws; a missing entry still fails closed below.
    classifications.length = 0;
    await classify(candidate.filePath);
    const classification = classifications.pop();
    if (
      classification === undefined ||
      classification.locationVerdict !== 'process' ||
      !CRASH_DUMP_BUNDLE_KEEP_REASONS.has(classification.reason) ||
      (hostOs === 'win32' &&
        hasWin32ShortNameComponent(
          executablePaths.get(candidate.filePath) ?? '',
        ))
    ) {
      continue;
    }
    const size = candidate.stats.size;
    if (size > CRASH_DUMP_FEEDBACK_MAX_FILE_BYTES) {
      skipped.push({ name: candidate.name, reason: 'too-large' });
      continue;
    }
    if (totalBytes + size > CRASH_DUMP_FEEDBACK_MAX_TOTAL_BYTES) {
      skipped.push({ name: candidate.name, reason: 'total-limit' });
      continue;
    }
    const zipPath = posix.join(CRASH_DUMPS_ZIP_DIR, candidate.name);
    await builder.addFileIfSafe(candidate.filePath, zipPath, {
      sourceRoot: crashDumps,
    });
    if (!builder.isIncluded(zipPath)) continue;
    included.push({
      name: candidate.name,
      size_bytes: size,
      modified_at: candidate.stats.mtime.toISOString(),
    });
    totalBytes += size;
  }
  if (included.length === 0) return undefined;

  const sidecarPath = posix.join(CRASH_DUMPS_ZIP_DIR, 'crash-dumps.json');
  builder.addGeneratedJson(sidecarPath, {
    version: 1,
    may_contain_memory_contents: true,
    max_count: CRASH_DUMP_FEEDBACK_MAX_COUNT,
    max_file_bytes: CRASH_DUMP_FEEDBACK_MAX_FILE_BYTES,
    max_total_bytes: CRASH_DUMP_FEEDBACK_MAX_TOTAL_BYTES,
    total_bytes: totalBytes,
    dumps: included,
    skipped,
  });
  return {
    included: included.length,
    sidecarPath,
    mayContainMemoryContents: true,
  };
}

function getFeedbackHomeDir(): string {
  return process.env.NODE_ENV === 'test'
    ? (process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST ?? homedir())
    : homedir();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * macOS names a crash report after the PROCESS name, as
 * `<process>-<YYYY-MM-DD>-<HHMMSS>...ips`. Two process families matter, and
 * they are named from the packaged desktop product name:
 *
 * - Main process: `Contents/MacOS/<displayName>[ (Flavor)]`.
 * - Helper processes use
 *   `<displayName>[ (Flavor)] Helper (<Type>)` — e.g.
 *   `Unstoppable Code (Internal) Helper (Renderer)`.
 *
 * Two ways to get this wrong, both of which have been hit:
 *
 * 1. Matching unanchored sweeps other vendors in. These files are uploaded in
 *    a user feedback bundle, so over-matching is a privacy leak.
 * 2. Omitting the flavor segment drops every helper report from internal and
 *    RC builds — the dogfood channels.
 *
 * So: the date separator is always required and the optional ` (Flavor)`
 * segment is allowed on the stable package name.
 */
function buildDiagnosticReportPattern(displayName: string): RegExp {
  const flavor = '(?: \\([^)]*\\))?';
  if (displayName.length === 0) {
    return /(?!)/;
  }
  return new RegExp(
    `^${escapeRegExp(displayName)}${flavor}(?: Helper${flavor})?-`,
  );
}

function hasActiveBrandBundleId(reportContents: string): boolean {
  const header = reportContents.split(/\r?\n/, 1)[0];
  try {
    const parsed: unknown = JSON.parse(header);
    if (!isRecord(parsed)) {
      return false;
    }
    const bundleId =
      typeof parsed.bundleID === 'string' ? parsed.bundleID.trim() : '';
    const brandedBundleId = escapeRegExp(BRAND.appId);
    return new RegExp(
      `^${brandedBundleId}(?:\\.(?:dev|rc))?(?:\\.helper(?:\\.(?:EH|GPU|NP|Plugin|Renderer))?)?$`,
    ).test(bundleId);
  } catch {
    return false;
  }
}

export function isCanopyDiagnosticReport(
  filename: string,
  reportContents?: string,
): boolean {
  if (!filename.endsWith('.ips')) {
    return false;
  }
  const matchesProcessName = buildDiagnosticReportPattern(
    BRAND.displayName,
  ).test(filename);
  if (!matchesProcessName || reportContents === undefined) {
    return matchesProcessName;
  }
  // Filenames are only a candidate filter: generic product names can collide
  // with another Electron app's helper family. The first JSON line in a macOS
  // .ips report carries bundleID, which provides the ownership boundary before
  // the file is added to an uploaded feedback archive.
  return hasActiveBrandBundleId(reportContents);
}

async function includePipelineDiagnostics(
  builder: FeedbackBundleBuilder,
): Promise<void> {
  const dataDir = getDataDir();
  const executionsDir = getPipelineExecutionsDir();
  let entries: Dirent<string>[];
  try {
    entries = await readdir(executionsDir, { withFileTypes: true });
  } catch {
    await builder.addDirectoryIfSafe(executionsDir, 'pipeline-executions', {
      sourceRoot: dataDir,
    });
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = join(executionsDir, entry.name);
      if (entry.isFile() && entry.name === 'index.json') {
        await builder.addFileIfSafe(
          sourcePath,
          posix.join('pipeline-executions', entry.name),
          { sourceRoot: dataDir },
        );
        return;
      }
      if (entry.isFile() && entry.name.endsWith('.json')) {
        await addSanitizedPipelineExecutionState(
          builder,
          sourcePath,
          posix.join('pipeline-executions', entry.name),
        );
        return;
      }
      if (entry.isDirectory()) {
        await builder.addDirectoryIfSafe(
          sourcePath,
          posix.join('pipeline-executions', entry.name),
          { sourceRoot: dataDir },
        );
      }
    }),
  );
}

async function includeWorktreePipelineDiagnostics(
  builder: FeedbackBundleBuilder,
  selections: FeedbackWorkspaceSelection[],
  includeFullExecutions: boolean,
): Promise<void> {
  const selectedWorktrees = buildSelectedWorktreeMap(selections);
  if (selectedWorktrees.size === 0) {
    return;
  }

  const snapshots = await readPipelineExecutionSnapshots();
  const selectedExecutions = selectPipelineExecutionsForWorktrees(
    snapshots,
    selectedWorktrees,
  );

  builder.addGeneratedJson('pipeline-executions/summary.json', {
    version: 1,
    generatedAt: new Date().toISOString(),
    executionCount: selectedExecutions.length,
    executions: selectedExecutions.map(toPipelineExecutionSummarySnapshot),
  });

  if (!includeFullExecutions) {
    return;
  }

  const dataDir = getDataDir();
  const executionsDir = getPipelineExecutionsDir();
  await Promise.all(
    selectedExecutions.map(async (execution) => {
      await addSanitizedPipelineExecutionState(
        builder,
        execution.sourcePath,
        posix.join('pipeline-executions', execution.stateFilename),
      );
      await builder.addDirectoryIfSafe(
        join(executionsDir, execution.executionDirName),
        posix.join('pipeline-executions', execution.executionDirName),
        { sourceRoot: dataDir },
      );
    }),
  );
}

function buildSelectedWorktreeMap(
  selections: FeedbackWorkspaceSelection[],
): Map<string, Set<string>> {
  const selectedWorktrees = new Map<string, Set<string>>();
  for (const selection of selections) {
    if (selection.worktreeIds.length === 0) {
      continue;
    }
    selectedWorktrees.set(
      selection.workspaceId,
      new Set(selection.worktreeIds),
    );
  }
  return selectedWorktrees;
}

async function readPipelineExecutionSnapshots(): Promise<
  PipelineExecutionSnapshot[]
> {
  const executionsDir = getPipelineExecutionsDir();
  let entries: Dirent<string>[];
  try {
    entries = await readdir(executionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const snapshots = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.json') &&
          entry.name !== 'index.json',
      )
      .map(async (entry) => {
        const sourcePath = join(executionsDir, entry.name);
        return readPipelineExecutionSnapshot(
          sourcePath,
          entry.name,
          entry.name.slice(0, -'.json'.length),
        );
      }),
  );

  return snapshots
    .filter(
      (snapshot): snapshot is PipelineExecutionSnapshot => snapshot !== null,
    )
    .sort((left, right) => {
      const startedDiff =
        new Date(right.startedAt).getTime() -
        new Date(left.startedAt).getTime();
      if (startedDiff !== 0) {
        return startedDiff;
      }
      return right.id.localeCompare(left.id);
    });
}

async function readPipelineExecutionSnapshot(
  sourcePath: string,
  stateFilename: string,
  executionDirName: string,
): Promise<PipelineExecutionSnapshot | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sourcePath, 'utf8'));
  } catch {
    return null;
  }
  return parsePipelineExecutionSnapshot(
    parsed,
    sourcePath,
    stateFilename,
    executionDirName,
  );
}

function parsePipelineExecutionSnapshot(
  value: unknown,
  sourcePath: string,
  stateFilename: string,
  executionDirName: string,
): PipelineExecutionSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readStringField(value, 'id');
  const pipelineId = readStringField(value, 'pipeline_id');
  const status = readStringField(value, 'status');
  const startedAt = readStringField(value, 'started_at');
  if (
    id === undefined ||
    pipelineId === undefined ||
    status === undefined ||
    startedAt === undefined
  ) {
    return null;
  }

  const pipelineSnapshot = readRecordField(value, 'pipeline_snapshot');
  const pipelineName =
    pipelineSnapshot !== undefined
      ? readStringField(pipelineSnapshot, 'name')
      : undefined;
  const planHashBefore = readStringField(value, 'plan_hash_before');
  const planHashAfter = readStringField(value, 'plan_hash_after');
  const reportOutputs = readRecordField(value, 'report_outputs');

  return {
    id,
    pipelineId,
    pipelineName: pipelineName ?? pipelineId,
    status,
    startedAt,
    sourcePath,
    stateFilename,
    executionDirName,
    completedAt: readStringField(value, 'completed_at'),
    eventName: readStringField(value, 'event_name'),
    projectId: readStringField(value, 'project_id'),
    worktreeId: readStringField(value, 'worktree_id'),
    planId:
      readStringField(value, 'planId') ?? readStringField(value, 'plan_id'),
    planModified:
      planHashBefore !== undefined && planHashAfter !== undefined
        ? planHashBefore !== planHashAfter
        : undefined,
    hasPlan: planHashAfter !== undefined ? true : undefined,
    hasReport: reportOutputsHasReport(reportOutputs) ? true : undefined,
    rerunSourceId: readStringField(value, 'rerun_source_id'),
    parentExecutionId: readStringField(value, 'parent_execution_id'),
    parentStepId: readStringField(value, 'parent_step_id'),
    parentAttempt: readNumberField(value, 'parent_attempt'),
    parentIteration: readNumberField(value, 'parent_iteration'),
    hidden: readBooleanField(value, 'hidden'),
    triggerSource: sanitizeTriggerSource(value.trigger_source),
  };
}

function selectPipelineExecutionsForWorktrees(
  snapshots: PipelineExecutionSnapshot[],
  selectedWorktrees: Map<string, Set<string>>,
): PipelineExecutionSnapshot[] {
  const selectedIds = new Set<string>();
  const childrenByParentId = new Map<string, PipelineExecutionSnapshot[]>();

  for (const snapshot of snapshots) {
    if (snapshot.parentExecutionId !== undefined) {
      const existing = childrenByParentId.get(snapshot.parentExecutionId) ?? [];
      existing.push(snapshot);
      childrenByParentId.set(snapshot.parentExecutionId, existing);
    }
    if (matchesSelectedWorktree(snapshot, selectedWorktrees)) {
      selectedIds.add(snapshot.id);
    }
  }

  const queue = Array.from(selectedIds);
  for (let index = 0; index < queue.length; index += 1) {
    const executionId = queue[index];
    if (executionId === undefined) {
      continue;
    }
    for (const child of childrenByParentId.get(executionId) ?? []) {
      if (selectedIds.has(child.id)) {
        continue;
      }
      selectedIds.add(child.id);
      queue.push(child.id);
    }
  }

  return snapshots.filter((snapshot) => selectedIds.has(snapshot.id));
}

function matchesSelectedWorktree(
  snapshot: PipelineExecutionSnapshot,
  selectedWorktrees: Map<string, Set<string>>,
): boolean {
  if (snapshot.projectId === undefined || snapshot.worktreeId === undefined) {
    return false;
  }
  return (
    selectedWorktrees.get(snapshot.projectId)?.has(snapshot.worktreeId) === true
  );
}

function toPipelineExecutionSummarySnapshot(
  snapshot: PipelineExecutionSnapshot,
): PipelineExecutionSummarySnapshot {
  return {
    id: snapshot.id,
    pipeline_id: snapshot.pipelineId,
    pipeline_name: snapshot.pipelineName,
    status: snapshot.status,
    started_at: snapshot.startedAt,
    completed_at: snapshot.completedAt,
    event_name: snapshot.eventName,
    project_id: snapshot.projectId,
    worktree_id: snapshot.worktreeId,
    plan_id: snapshot.planId,
    plan_modified: snapshot.planModified,
    has_plan: snapshot.hasPlan,
    has_report: snapshot.hasReport,
    rerun_source_id: snapshot.rerunSourceId,
    parent_execution_id: snapshot.parentExecutionId,
    parent_step_id: snapshot.parentStepId,
    parent_attempt: snapshot.parentAttempt,
    parent_iteration: snapshot.parentIteration,
    hidden: snapshot.hidden,
    trigger_source: snapshot.triggerSource,
  };
}

function reportOutputsHasReport(
  reportOutputs: Record<string, unknown> | undefined,
): boolean {
  if (reportOutputs === undefined) {
    return false;
  }
  return (
    readStringField(reportOutputs, 'report_file') !== undefined ||
    readStringField(reportOutputs, 'report_json_file') !== undefined
  );
}

async function includePluginDiagnostics(
  builder: FeedbackBundleBuilder,
): Promise<void> {
  const dataDir = getDataDir();
  await builder.addFileIfSafe(
    getBundlesIndexFilePath(),
    dataRelativeZipPath(getBundlesIndexFilePath()),
    { sourceRoot: dataDir },
  );
  await builder.addFileIfSafe(
    getMcpServersIndexFilePath(),
    dataRelativeZipPath(getMcpServersIndexFilePath()),
    { sourceRoot: dataDir },
  );
  await builder.addFileIfSafe(
    getPipelinePluginPreferencesFilePath(),
    dataRelativeZipPath(getPipelinePluginPreferencesFilePath()),
    { sourceRoot: dataDir },
  );
}

async function includeWorkspaceDiagnostics(
  builder: FeedbackBundleBuilder,
  selections: FeedbackWorkspaceSelection[],
  includeChatDetails: boolean,
): Promise<void> {
  const dataDir = getDataDir();
  await Promise.all(
    selections.map(async (selection) => {
      await builder.addFileIfSafe(
        w5RecordReadPaths.manifest(selection.workspaceId),
        dataRelativeZipPath(w5RecordReadPaths.manifest(selection.workspaceId)),
        { sourceRoot: dataDir },
      );
      await addWorkspaceWorktreesDiagnostics(
        builder,
        w5RecordReadPaths.worktrees(selection.workspaceId),
        dataRelativeZipPath(w5RecordReadPaths.worktrees(selection.workspaceId)),
        includeChatDetails,
      );
      await Promise.all(
        selection.worktreeIds.map(async (worktreeId) => {
          await builder.addDirectoryIfSafe(
            getWorkspaceScriptRunDir(selection.workspaceId, worktreeId),
            dataRelativeZipPath(
              getWorkspaceScriptRunDir(selection.workspaceId, worktreeId),
            ),
            { sourceRoot: dataDir },
          );
          await builder.addDirectoryIfSafe(
            getHookInvocationsDir(selection.workspaceId, worktreeId),
            dataRelativeZipPath(
              getHookInvocationsDir(selection.workspaceId, worktreeId),
            ),
            { sourceRoot: dataDir },
          );
        }),
      );
    }),
  );
}

async function addWorkspaceWorktreesDiagnostics(
  builder: FeedbackBundleBuilder,
  sourcePath: string,
  zipPath: string,
  includeChatDetails: boolean,
): Promise<void> {
  if (includeChatDetails) {
    await builder.addFileIfSafe(sourcePath, zipPath, {
      sourceRoot: getDataDir(),
      allowChatContent: true,
    });
    return;
  }

  const normalizedZipPath = normalizeZipPath(zipPath);
  if (
    normalizedZipPath === null ||
    !isPathWithinRoot(sourcePath, getDataDir())
  ) {
    builder.recordSkipped(zipPath, 'out-of-root');
    return;
  }
  const fileStatResult = await safeLstat(sourcePath);
  if (fileStatResult.status !== 'ok') {
    builder.recordSkipped(normalizedZipPath, fileStatResult.status);
    return;
  }
  if (fileStatResult.stats.isSymbolicLink()) {
    builder.recordSkipped(normalizedZipPath, 'symlink');
    return;
  }
  if (!fileStatResult.stats.isFile()) {
    return;
  }
  if (fileStatResult.stats.size > MAX_FILE_BYTES) {
    builder.recordSkipped(normalizedZipPath, 'too-large');
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sourcePath, 'utf8'));
  } catch {
    builder.recordSkipped(normalizedZipPath, 'inaccessible');
    return;
  }
  const sanitized = sanitizeWorktreesChatBadgeContent(parsed);
  if (sanitized === null) {
    builder.recordSkipped(normalizedZipPath, 'inaccessible');
    return;
  }
  builder.addGeneratedJson(normalizedZipPath, sanitized);
}

function sanitizeWorktreesChatBadgeContent(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.worktrees)) {
    return null;
  }
  const worktrees: unknown[] = value.worktrees;
  return {
    version: readNumberField(value, 'version') ?? 1,
    worktrees: worktrees.flatMap((worktree) => {
      if (!isRecord(worktree)) {
        return [];
      }
      if (!('chatBadges' in worktree)) {
        return [worktree];
      }
      const chatBadges = readRecordField(worktree, 'chatBadges');
      const safeWorktree = Object.fromEntries(
        Object.entries(worktree).filter(([key]) => key !== 'chatBadges'),
      );
      if (chatBadges === undefined) {
        return [safeWorktree];
      }
      return [
        {
          ...safeWorktree,
          chatBadges: {
            version: readNumberField(chatBadges, 'version') ?? 1,
            unreadChats: sanitizeChatBadgeRefs(chatBadges.unreadChats),
            approvalChats: sanitizeChatBadgeRefs(chatBadges.approvalChats),
            needsHydration:
              readBooleanField(chatBadges, 'needsHydration') ?? false,
            updatedAt: readStringField(chatBadges, 'updatedAt') ?? '',
          },
        },
      ];
    }),
  };
}

function sanitizeChatBadgeRefs(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: unknown[] = value;
  return refs.flatMap((ref) => {
    if (!isRecord(ref)) return [];
    const chatId = readStringField(ref, 'chatId');
    if (chatId === undefined) return [];
    const providerType = readStringField(ref, 'providerType');
    // A read-state marker, not conversation content.
    const markedUnread = readBooleanField(ref, 'markedUnread');
    return [
      {
        chatId,
        ...(providerType ? { providerType } : {}),
        ...(markedUnread === true ? { markedUnread } : {}),
      },
    ];
  });
}

async function includeChatProjectMetadata(
  builder: FeedbackBundleBuilder,
  chatProjectIds: string[],
): Promise<void> {
  if (chatProjectIds.length === 0) {
    return;
  }
  const dataDir = getDataDir();
  await builder.addFileIfSafe(
    getChatProjectsFilePath(),
    dataRelativeZipPath(getChatProjectsFilePath()),
    { sourceRoot: dataDir },
  );
  await Promise.all(
    chatProjectIds.map(async (chatProjectId) => {
      await builder.addFileIfSafe(
        getChatProjectProjectFilePath(chatProjectId),
        dataRelativeZipPath(getChatProjectProjectFilePath(chatProjectId)),
        { sourceRoot: dataDir },
      );
    }),
  );
}

/** Preserve raw canonical evidence, including interrupted transactions. */
async function includeCanonicalChatDetails(
  builder: FeedbackBundleBuilder,
  root: string,
  scopeId: string,
): Promise<void> {
  validateId(scopeId, 'chat storage scope');
  const dataDir = getDataDir();
  const manifest = join(root, 'chat-storage-manifests', `${scopeId}.json`);
  const directory = join(root, 'chat-storage-v2', scopeId);
  const options = {
    sourceRoot: dataDir,
    allowChatContent: true,
    excludedZipPathPrefixes: [
      dataRelativeZipPath(join(directory, 'visual-staging')),
    ],
  };
  await builder.addFileIfSafe(manifest, dataRelativeZipPath(manifest), options);
  await builder.addDirectoryIfSafe(
    directory,
    dataRelativeZipPath(directory),
    options,
  );
}

async function includeWorktreeChatDetails(
  builder: FeedbackBundleBuilder,
  selections: FeedbackWorkspaceSelection[],
): Promise<void> {
  const dataDir = getDataDir();
  const selectedWorktrees = new Map<string, Set<string>>();
  await Promise.all(
    selections.map(async (selection) => {
      if (selection.worktreeIds.length === 0) {
        return;
      }
      selectedWorktrees.set(
        selection.workspaceId,
        new Set(selection.worktreeIds),
      );
      await Promise.all(
        selection.worktreeIds.map(async (worktreeId) => {
          await includeCanonicalChatDetails(
            builder,
            dirname(
              dirname(
                getWorkspaceChatTabsFilePath(selection.workspaceId, worktreeId),
              ),
            ),
            worktreeId,
          );
          await builder.addFileIfSafe(
            getWorkspaceChatTabsFilePath(selection.workspaceId, worktreeId),
            dataRelativeZipPath(
              getWorkspaceChatTabsFilePath(selection.workspaceId, worktreeId),
            ),
            { sourceRoot: dataDir, allowChatContent: true },
          );
          await builder.addFileIfSafe(
            getWorktreeSummaryFilePath(selection.workspaceId, worktreeId),
            dataRelativeZipPath(
              getWorktreeSummaryFilePath(selection.workspaceId, worktreeId),
            ),
            { sourceRoot: dataDir },
          );
          await builder.addFileIfSafe(
            getWorkspaceTrackedPlansFilePath(selection.workspaceId, worktreeId),
            dataRelativeZipPath(
              getWorkspaceTrackedPlansFilePath(
                selection.workspaceId,
                worktreeId,
              ),
            ),
            { sourceRoot: dataDir },
          );
        }),
      );
    }),
  );

  await includeMatchingTranscripts(builder, (entry) => {
    if (entry.projectId === undefined || entry.worktreeId === undefined) {
      return false;
    }
    const scopedWorktrees = selectedWorktrees.get(entry.projectId);
    return (
      scopedWorktrees !== undefined &&
      scopedWorktrees.has(entry.worktreeId) &&
      TRANSCRIPT_WORKTREE_EVENTS.has(entry.eventType)
    );
  });
}

async function addSanitizedPipelineExecutionState(
  builder: FeedbackBundleBuilder,
  sourcePath: string,
  zipPath: string,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sourcePath, 'utf8'));
  } catch {
    builder.recordSkipped(zipPath, 'inaccessible');
    return;
  }
  if (!isRecord(parsed)) {
    builder.recordSkipped(zipPath, 'inaccessible');
    return;
  }
  builder.addGeneratedJson(zipPath, sanitizePipelineExecutionState(parsed));
}

function sanitizePipelineExecutionState(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const pipelineSnapshot = readRecordField(value, 'pipeline_snapshot');
  const pipelineName =
    pipelineSnapshot !== undefined
      ? readStringField(pipelineSnapshot, 'name')
      : undefined;
  const sanitized: Record<string, unknown> = {};

  setRecordValue(sanitized, 'version', readNumberField(value, 'version'));
  setRecordValue(sanitized, 'id', readStringField(value, 'id'));
  setRecordValue(
    sanitized,
    'pipeline_id',
    readStringField(value, 'pipeline_id'),
  );
  setRecordValue(sanitized, 'pipeline_name', pipelineName);
  setRecordValue(sanitized, 'status', readStringField(value, 'status'));
  setRecordValue(sanitized, 'started_at', readStringField(value, 'started_at'));
  setRecordValue(
    sanitized,
    'completed_at',
    readStringField(value, 'completed_at'),
  );
  setRecordValue(sanitized, 'event_name', readStringField(value, 'event_name'));
  setRecordValue(sanitized, 'project_id', readStringField(value, 'project_id'));
  setRecordValue(
    sanitized,
    'worktree_id',
    readStringField(value, 'worktree_id'),
  );
  setRecordValue(
    sanitized,
    'plan_id',
    readStringField(value, 'planId') ?? readStringField(value, 'plan_id'),
  );
  setRecordValue(sanitized, 'error', readStringField(value, 'error'));
  setRecordValue(
    sanitized,
    'rerun_source_id',
    readStringField(value, 'rerun_source_id'),
  );
  setRecordValue(
    sanitized,
    'parent_execution_id',
    readStringField(value, 'parent_execution_id'),
  );
  setRecordValue(
    sanitized,
    'parent_step_id',
    readStringField(value, 'parent_step_id'),
  );
  setRecordValue(
    sanitized,
    'parent_attempt',
    readNumberField(value, 'parent_attempt'),
  );
  setRecordValue(
    sanitized,
    'parent_iteration',
    readNumberField(value, 'parent_iteration'),
  );
  setRecordValue(sanitized, 'hidden', readBooleanField(value, 'hidden'));
  setRecordValue(
    sanitized,
    'trigger_source',
    sanitizeTriggerSource(value.trigger_source),
  );
  setRecordValue(sanitized, 'jobs', sanitizePipelineJobs(value.jobs));

  return sanitized;
}

function sanitizeTriggerSource(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  setRecordValue(sanitized, 'type', readStringField(value, 'type'));
  setRecordValue(sanitized, 'name', readStringField(value, 'name'));
  setRecordValue(sanitized, 'event_name', readStringField(value, 'event_name'));
  return sanitized;
}

function sanitizePipelineJobs(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const jobs: Record<string, unknown> = {};
  for (const [jobId, job] of Object.entries(value)) {
    if (isRecord(job)) {
      jobs[jobId] = sanitizePipelineJob(job);
    }
  }
  return jobs;
}

function sanitizePipelineJob(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  setRecordValue(sanitized, 'status', readStringField(value, 'status'));
  setRecordValue(sanitized, 'conclusion', readStringField(value, 'conclusion'));
  setRecordValue(sanitized, 'outcome', readStringField(value, 'outcome'));
  setRecordValue(sanitized, 'started_at', readStringField(value, 'started_at'));
  setRecordValue(
    sanitized,
    'completed_at',
    readStringField(value, 'completed_at'),
  );
  setRecordValue(
    sanitized,
    'retry_count',
    readNumberField(value, 'retry_count'),
  );
  setRecordValue(
    sanitized,
    'iteration_count',
    readNumberField(value, 'iteration_count'),
  );
  setRecordValue(
    sanitized,
    'report_outputs',
    sanitizeReportOutputs(value.report_outputs),
  );
  setRecordValue(sanitized, 'steps', sanitizePipelineSteps(value.steps));
  setRecordValue(
    sanitized,
    'retry_history',
    sanitizePipelineAttempts(value.retry_history),
  );
  setRecordValue(
    sanitized,
    'iteration_history',
    sanitizePipelineAttempts(value.iteration_history),
  );
  return sanitized;
}

function sanitizePipelineSteps(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const steps: Record<string, unknown> = {};
  for (const [stepId, step] of Object.entries(value)) {
    if (isRecord(step)) {
      steps[stepId] = sanitizePipelineStep(step);
    }
  }
  return steps;
}

function sanitizePipelineStep(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  setRecordValue(sanitized, 'status', readStringField(value, 'status'));
  setRecordValue(sanitized, 'conclusion', readStringField(value, 'conclusion'));
  setRecordValue(sanitized, 'outcome', readStringField(value, 'outcome'));
  setRecordValue(sanitized, 'started_at', readStringField(value, 'started_at'));
  setRecordValue(
    sanitized,
    'completed_at',
    readStringField(value, 'completed_at'),
  );
  setRecordValue(sanitized, 'exit_code', readNumberField(value, 'exit_code'));
  setRecordValue(sanitized, 'error', readStringField(value, 'error'));
  setRecordValue(
    sanitized,
    'log_file',
    sanitizePipelinePath(readStringField(value, 'log_file')),
  );
  setRecordValue(
    sanitized,
    'log_format_hint',
    readStringField(value, 'log_format_hint'),
  );
  setRecordValue(
    sanitized,
    'agent_provider',
    readStringField(value, 'agent_provider'),
  );
  setRecordValue(
    sanitized,
    'agent_model',
    readStringField(value, 'agent_model'),
  );
  setRecordValue(
    sanitized,
    'report_outputs',
    sanitizeReportOutputs(value.report_outputs),
  );
  return sanitized;
}

function sanitizePipelineAttempts(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const attempts: unknown[] = [];
  for (const attempt of value) {
    if (isRecord(attempt)) {
      attempts.push(sanitizePipelineAttempt(attempt));
    }
  }
  return attempts;
}

function sanitizePipelineAttempt(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  setRecordValue(sanitized, 'attempt', readNumberField(value, 'attempt'));
  setRecordValue(sanitized, 'iteration', readNumberField(value, 'iteration'));
  setRecordValue(sanitized, 'status', readStringField(value, 'status'));
  setRecordValue(sanitized, 'conclusion', readStringField(value, 'conclusion'));
  setRecordValue(sanitized, 'outcome', readStringField(value, 'outcome'));
  setRecordValue(sanitized, 'started_at', readStringField(value, 'started_at'));
  setRecordValue(
    sanitized,
    'completed_at',
    readStringField(value, 'completed_at'),
  );
  setRecordValue(sanitized, 'steps', sanitizePipelineSteps(value.steps));
  return sanitized;
}

function sanitizeReportOutputs(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  setRecordValue(
    sanitized,
    'report_file',
    sanitizePipelinePath(readStringField(value, 'report_file')),
  );
  setRecordValue(
    sanitized,
    'report_json_file',
    sanitizePipelinePath(readStringField(value, 'report_json_file')),
  );
  return sanitized;
}

function sanitizePipelinePath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isPathWithinRoot(value, getPipelineExecutionsDir())) {
    return dataRelativeZipPath(value);
  }

  const normalizedZipPath = normalizeZipPath(toZipPath(value));
  if (
    normalizedZipPath !== null &&
    (normalizedZipPath === 'pipeline-executions' ||
      normalizedZipPath.startsWith('pipeline-executions/'))
  ) {
    return normalizedZipPath;
  }

  return posix.basename(value.split('\\').join('/'));
}

async function includeStandaloneChatDetails(
  builder: FeedbackBundleBuilder,
  chatProjectIds: string[],
): Promise<void> {
  const dataDir = getDataDir();
  await Promise.all(
    chatProjectIds.map(async (chatProjectId) => {
      const workspaceId = resolveCoworkWorkspaceId(chatProjectId);
      // One tab file per work entry, plus the legacy pre-entry home.json.
      const tabWorktreeIds = [
        ...(await listWorkEntryIds(workspaceId)),
        COWORK_HOME_WORKTREE_ID,
      ];
      for (const worktreeId of tabWorktreeIds) {
        const chatTabsFilePath = getWorkspaceChatTabsFilePath(
          workspaceId,
          worktreeId,
        );
        await includeCanonicalChatDetails(
          builder,
          dirname(dirname(chatTabsFilePath)),
          worktreeId,
        );
        await builder.addFileIfSafe(
          chatTabsFilePath,
          dataRelativeZipPath(chatTabsFilePath),
          { sourceRoot: dataDir, allowChatContent: true },
        );
      }
      await includeStandaloneChatHistory(builder, chatProjectId);
    }),
  );

  const selectedProjectIds = new Set(chatProjectIds);
  await includeMatchingTranscripts(builder, (entry) => {
    if (!TRANSCRIPT_CHAT_EVENTS.has(entry.eventType)) {
      return false;
    }
    // Pre-migration transcripts are wire-shaped as
    // (projectId=sentinel, worktreeId=conceptual chat-project id). New
    // cowork turns are wire-shaped as
    // (projectId=cowork workspace id, worktreeId=workEntryId — 'home' before
    // Work Entries), so the conceptual id to match against
    // `selectedProjectIds` lives in `projectId` instead.
    if (
      entry.projectId === STANDALONE_CHAT_PROJECT_ID &&
      entry.worktreeId !== undefined &&
      selectedProjectIds.has(entry.worktreeId)
    ) {
      return true;
    }
    return (
      entry.projectId !== undefined &&
      isCoworkWorkspace(entry.projectId) &&
      selectedProjectIds.has(entry.projectId)
    );
  });
}

async function includeStandaloneChatHistory(
  builder: FeedbackBundleBuilder,
  chatProjectId: string,
): Promise<void> {
  const dataDir = getDataDir();
  const workspaceId = resolveCoworkWorkspaceId(chatProjectId);
  const historyDir = getWorkspaceChatHistoryRootDir(workspaceId);
  let entries: Dirent<string>[];
  try {
    entries = await readdir(historyDir, { withFileTypes: true });
  } catch {
    await builder.addDirectoryIfSafe(
      historyDir,
      dataRelativeZipPath(historyDir),
      {
        sourceRoot: dataDir,
      },
    );
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) {
        return;
      }
      try {
        validateId(entry.name, 'chatId');
      } catch {
        builder.recordSkipped(
          posix.join(dataRelativeZipPath(historyDir), entry.name),
          'inaccessible',
        );
        return;
      }
      const metaFilePath = getWorkspaceChatHistoryMetaFilePath(
        workspaceId,
        entry.name,
      );
      await builder.addFileIfSafe(
        metaFilePath,
        dataRelativeZipPath(metaFilePath),
        { sourceRoot: dataDir },
      );
      const summaryFilePath = getWorkspaceChatHistorySummaryFilePath(
        workspaceId,
        entry.name,
      );
      await builder.addFileIfSafe(
        summaryFilePath,
        dataRelativeZipPath(summaryFilePath),
        { sourceRoot: dataDir },
      );
      const conversationFilePath = getWorkspaceChatHistoryConversationFilePath(
        workspaceId,
        entry.name,
      );
      await includeCanonicalChatDetails(
        builder,
        dirname(conversationFilePath),
        entry.name,
      );
      await builder.addFileIfSafe(
        conversationFilePath,
        dataRelativeZipPath(conversationFilePath),
        { sourceRoot: dataDir, allowChatContent: true },
      );
    }),
  );
}

async function includeMatchingTranscripts(
  builder: FeedbackBundleBuilder,
  matches: (entry: AgentAuditEntry) => boolean,
): Promise<void> {
  const auditDir = getAgentObservabilityAuditDir();
  let entries: Dirent<string>[];
  try {
    entries = await readdir(auditDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    const auditPath = join(auditDir, entry.name);
    let source: ReadStream;
    try {
      source = createReadStream(auditPath, { encoding: 'utf8' });
    } catch {
      continue;
    }
    // Observe open/read failures before constructing readline. Closing the
    // interface unblocks iteration even when a source fails during addFile.
    const sourceDone = finished(source).catch(() => undefined);
    const lines = createInterface({ input: source, crlfDelay: Infinity });
    source.on('error', () => lines.close());
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        const auditEntry = parseAuditEntry(line);
        if (
          auditEntry === null ||
          !auditEntry.hasTranscript ||
          !matches(auditEntry)
        ) {
          continue;
        }
        try {
          const transcriptPath = getAgentObservabilityTranscriptFilePath({
            id: auditEntry.id,
            eventType: auditEntry.eventType,
            startedAt: auditEntry.startedAt,
          });
          await builder.addFileIfSafe(
            transcriptPath,
            dataRelativeZipPath(transcriptPath),
            { sourceRoot: getDataDir(), allowTranscript: true },
          );
        } catch {
          continue;
        }
      }
    } catch {
      // Unreadable audit logs do not prevent collecting other diagnostics.
    } finally {
      lines.close();
      source.destroy();
      await sourceDone;
    }
  }
}

function parseAuditEntry(line: string): AgentAuditEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isAuditEntry(parsed)) {
    return null;
  }
  return parsed;
}

function isAuditEntry(value: unknown): value is AgentAuditEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (
    !('id' in value) ||
    !('eventType' in value) ||
    !('startedAt' in value) ||
    !('hasTranscript' in value)
  ) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.eventType === 'string' &&
    parseAgentAuditEventType(value.eventType) !== null &&
    typeof value.startedAt === 'string' &&
    typeof value.hasTranscript === 'boolean'
  );
}

function getPipelineExecutionsDir(): string {
  return join(getDataDir(), 'pipeline-executions');
}

function dataRelativeZipPath(sourcePath: string): string {
  return toZipPath(relative(getDataDir(), sourcePath));
}

function toZipPath(pathValue: string): string {
  return pathValue.split(sep).join(posix.sep);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function readBooleanField(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function setRecordValue(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) {
    record[key] = value;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  if (!('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function formatFeedbackTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '');
}
