import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BRAND } from '@canopy/brand/current';
import { mkdir, rm } from 'node:fs/promises';
import {
  IPC_CHANNELS,
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  type AgentAuditEntry,
  type AgentAuditEventType,
  type AgentAuditLinkTarget,
  type ApprovalMode,
  type ChatModel,
  type PersistedChatMessage,
  type ThinkingLevel,
  type WorkerCardData,
  type WorkerExitedEvent,
  type WorkerStartedEvent,
  type WorkerStatus,
  type WorkerUpdatedEvent,
} from '@canopy/desktop-shared/types';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeTerminalHookCallbackBody } from '@canopy/desktop-shared/lib/desktop-integration-transport';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  LEDGER_INJECTED_TOOL_KEYS,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import type { ApprovalRule } from '@canopy/desktop-shared/types';
import type { LedgerToolsRuntime } from '../canopy-tools/ledger-tools-runtime';
import type { HelperUsage } from '@canopy/execution-engine/lib/helper-usage';
import { ensureClaudeWorkspaceTrust } from './claude-workspace-trust';
import {
  buildClaudeTerminalLaunchConfig,
  type ClaudeTerminalPermission,
} from './claude-terminal-settings';
import { getDesktopIntegrationServer } from './desktop-integration-server';
import { resolveClaudeWorkerMemoryToolExposure } from './claude-worker-tool-exposure';
import {
  isAllowedClaudeTerminalTranscriptPath,
  syncClaudeTerminalTranscript,
} from './claude-terminal-transcript-sync';
import {
  accumulateImportedTranscriptUsage,
  emptyClaudeTerminalTurnUsage,
  type ClaudeTerminalTurnUsage,
} from './claude-terminal-usage';
import {
  extractClaudeProposedPlanFromJsonl,
  normalizeClaudeTerminalTranscriptToSdkJsonl,
} from '@canopy/execution-engine/builtin-actions/agent-prompt/logic';
import { validateAgainstSchema } from '../canopy-tools/report-structured-result';
import { getClaudeWorkerRuntimeDir } from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';
import {
  getEffectiveClaudeWorkerConcurrencyLimit,
  isClaudeTuiWorkersEnabled,
} from '../lib/claude-tui-workers';
import { spawnPlacedManagedTerminal } from '../services/terminal-service';
import type { WorkerTerminalEvent } from '@canopy/core-runtime/node/terminal';
import { workerTerminal } from '../terminal/worker-terminal';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { getCachedClaudeAuthStatusObserved } from '../auth/provider-auth-state';
import {
  createApprovalSession,
  type ApprovalOutcome,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  approvalCheckForClaudeTool,
  CLAUDE_PLAN_MODE_READ_ONLY_TOOLS,
} from '../agents/claude-approval-adapter';
import {
  clearClaudeModAdmissionSessionRecords,
  replaceClaudeModAdmissionSessionRecords,
} from '../agents/claude-mod-admission-session';

type EventSender = (
  channel:
    | typeof IPC_CHANNELS.workerStarted
    | typeof IPC_CHANNELS.workerUpdated
    | typeof IPC_CHANNELS.workerExited,
  payload: WorkerStartedEvent | WorkerUpdatedEvent | WorkerExitedEvent,
) => void;

export interface ClaudeWorkerRunRequest<T> {
  kind: string;
  label: string;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  schema?: Record<string, unknown>;
  resultValidationSchema?: Record<string, unknown>;
  onResultRejected?: (payload: unknown) => void;
  isResult?: (value: unknown) => value is T;
  model?: ChatModel;
  thinkingLevel?: ThinkingLevel;
  permission?: ClaudeTerminalPermission;
  /** Explicit Canopy policy for this unattended worker session. */
  approvalMode?: ApprovalMode;
  settingSources?: SettingSource[];
  maxTurns?: number;
  pluginSelections?: ChatTabPluginSelections;
  mcpServers?: Record<string, unknown>;
  claudeEnvOverride?: Record<string, string>;
  /**
   * A pipeline agent's Ledger tools (role `pipeline_agent`), served on the
   * worker's route. Background-helper workers never pass them (E05).
   */
  ledgerTools?: LedgerToolsRuntime;
  /**
   * When set, the worker resumes this existing Claude session (`claude --resume`)
   * instead of starting a fresh one, and no system prompt is appended — the
   * session's original system prompt (incl. the autonomy instruction) is reused.
   * Used by the pipeline `builtin/agent-resume` action.
   */
  resumeSessionId?: string;
  projectId?: string;
  worktreeId?: string;
  chatId?: string;
  pipelineExecutionId?: string;
  stepId?: string;
  auditEventType?: AgentAuditEventType;
  linkTarget?: AgentAuditLinkTarget;
  timeoutMs?: number;
  /**
   * Fails and kills the worker if Claude does not emit SessionStart within
   * this period after its terminal process launches. Zero disables the check.
   */
  startupTimeoutMs?: number;
  /**
   * Fired immediately after the worker is registered, before queued/startup
   * work begins. This gives cancellation callers a stable worker id even when
   * authentication or terminal launch outlives their own deadline.
   */
  onCreated?: (workerId: string) => void;
  onStarted?: (workerId: string) => void;
  /**
   * Fired once if the worker genuinely waits on the concurrency cap (i.e. it
   * stays queued after a pump because no slot was free). A worker that launches
   * immediately never fires this, so callers can distinguish a real wait from a
   * brief enqueue.
   */
  onQueued?: (workerId: string) => void;
}

export interface ClaudeWorkerRunResult<T> {
  workerId: string;
  sessionId: string;
  /** True only after Claude emitted SessionStart for this launch. */
  sessionStarted: boolean;
  result: T | string | null;
  finalText: string;
  usage: HelperUsage;
  transcript: PersistedChatMessage[];
  transcriptJsonl: string;
  proposedPlan?: string;
  status: WorkerStatus;
  error?: string;
  invalidOutput?: boolean;
}

/** A session rule allowing one tool on the worker's injected server. */
function allowWorkerMcpTool(tool: string): ApprovalRule {
  return {
    id: randomUUID(),
    behavior: 'allow',
    target: { kind: 'mcp', server: BRAND.tools.namespace, tool },
    createdAt: new Date().toISOString(),
    origin: 'settings',
  };
}

/**
 * Adds the Ledger tools to a preset's allowed tools, when the preset lists
 * any, for a worker that serves them.
 */
function withLedgerToolsAllowed(
  permission: ClaudeTerminalPermission | undefined,
  ledgerTools: boolean,
): ClaudeTerminalPermission | undefined {
  if (!ledgerTools || permission?.allowedTools === undefined) return permission;
  return {
    ...permission,
    allowedTools: [
      ...permission.allowedTools,
      ...LEDGER_INJECTED_TOOL_KEYS.map(
        (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName,
      ),
    ],
  };
}

function getClaudeWorkerAuthRequiredMessage(error: string | null): string {
  return error === 'Claude CLI is not installed.'
    ? error
    : 'Claude is not authenticated. Sign in from Settings before using Claude Workers.';
}

interface RuntimeRecord {
  workerId: string;
  request: ClaudeWorkerRunRequest<unknown>;
  card: WorkerCardData;
  runtimeDir: string;
  sessionKey: string;
  authToken: string;
  sdkSessionId: string;
  terminalId?: string;
  schema?: Record<string, unknown>;
  isResult?: (value: unknown) => boolean;
  /** True when launching via `claude --resume` against an existing session. */
  resume: boolean;
  reportedResult?: unknown;
  outputValidationRejected?: boolean;
  stopSeen: boolean;
  settled: boolean;
  cancelled: boolean;
  turnUsage: ClaudeTerminalTurnUsage;
  transcriptPath?: string;
  transcript: PersistedChatMessage[];
  transcriptEvents: unknown[];
  transcriptSyncTail?: Promise<void>;
  settlementPromise?: Promise<void>;
  resolve: (value: ClaudeWorkerRunResult<unknown>) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  startupTimeout?: NodeJS.Timeout;
  sessionStarted: boolean;
  taskKey?: string;
  retryAuthRefreshInFlight: boolean;
  retrying: boolean;
  runningSlot: boolean;
  queuedNotified: boolean;
  launchGeneration: number;
  approvalSession?: ApprovalSessionHandle;
}

const DEFAULT_PROJECT_ID = 'workers';
const DEFAULT_WORKTREE_ID = 'workers';
const WORKER_COLS = 120;
const WORKER_ROWS = 36;
const SETTLED_CARD_TTL_MS = 1500;
/**
 * Backstop timeout for a worker that neither emits a terminal hook (Stop /
 * StopFailure) nor exits its PTY. Without this a hung `claude` CLI would hold a
 * concurrency slot forever and never settle its awaiting promise; with both
 * background and pipeline modes defaulting to `terminal`, a handful of hangs
 * would deadlock all Claude background work. Callers may override via
 * `request.timeoutMs`; `0` disables the backstop.
 */
const DEFAULT_WORKER_TIMEOUT_MS = 600_000;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const candidate = value[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function usageFromTurnUsage(usage: ClaudeTerminalTurnUsage): HelperUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    messageCount: 1,
    assistantMessageCount: 1,
  };
}

function finalAssistantText(messages: PersistedChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type === 'text') {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n\n').trim();
}

function replayMessageFingerprint(message: PersistedChatMessage): string {
  // Import timestamps are assigned when an event is normalized, so a replay
  // can produce a different timestamp for the same source message. Keep its
  // ID and all content in the comparison: a revised body with the same ID is
  // a meaningful update to the worker's projected message.
  const serialized = JSON.stringify({
    ...message,
    timestamp: undefined,
    blocks: message.blocks.map((block) =>
      block.type === 'compaction_info'
        ? { ...block, timestamp: undefined }
        : block,
    ),
  });
  return createHash('sha256').update(serialized).digest('hex');
}

function replayEventFingerprint(event: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(event) ?? 'undefined')
    .digest('hex');
}

function buildDefaultLinkTarget(
  projectId: string,
  worktreeId: string,
  chatId: string,
): AgentAuditLinkTarget {
  return {
    page: 'main',
    kind: 'worktree-chat',
    projectId,
    worktreeId,
    chatId,
  };
}

/**
 * Appended to every fresh worker session's system prompt so the agent runs the
 * task to completion without expecting a human in the loop (the worker PTY has
 * no stdin). On resume this is not re-applied — it is already part of the
 * session's system prompt from when the session started.
 */
const WORKER_AUTONOMY_INSTRUCTION =
  'Handle each user request autonomously and to completion without any additional input.';

function buildReportToolInstruction(schema: Record<string, unknown>): string {
  return [
    'Complete this background worker task by calling the ReportStructuredResult MCP tool exactly once with arguments matching this JSON Schema. If the tool reports a schema error, fix the arguments and call it again. After the tool succeeds, stop.',
    '',
    'JSON Schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

function buildWorkerSystemPrompt(
  systemPrompt: string,
  schema: Record<string, unknown> | undefined,
): string {
  const lines = [systemPrompt, '', WORKER_AUTONOMY_INSTRUCTION];
  if (!schema) {
    lines.push(
      '',
      'Complete this background worker task by providing the final answer as plain text, then stop.',
    );
  } else {
    lines.push('', buildReportToolInstruction(schema));
  }
  return lines.join('\n');
}

/**
 * Resume reuses the original session's system prompt (which already carries
 * {@link WORKER_AUTONOMY_INSTRUCTION}), so we never re-append a system prompt on
 * resume. We only restate the structured-output contract for this turn — in the
 * user prompt, not the system prompt — when the resume step requests a schema.
 */
function buildWorkerResumePrompt(
  prompt: string,
  schema: Record<string, unknown> | undefined,
): string {
  if (!schema) {
    return prompt;
  }
  return [prompt, '', buildReportToolInstruction(schema)].join('\n');
}

function buildWorkerSessionKey(workerId: string): string {
  return `worker-${workerId}-${randomUUID()}`;
}

export class DefaultClaudeWorkerSessionService {
  private records = new Map<string, RuntimeRecord>();
  private terminalIndex = new Map<string, string>();
  private queue: RuntimeRecord[] = [];
  private runningCount = 0;
  private eventSender: EventSender = () => {};

  public constructor() {
    if (typeof workerTerminal.addEventListener === 'function') {
      workerTerminal.addEventListener((event) => {
        this.handleTerminalEvent(event);
      });
    }
  }

  public setEventSender(sender: EventSender): void {
    this.eventSender = sender;
  }

  public listWorkers(): WorkerCardData[] {
    return Array.from(this.records.values()).map((record) => record.card);
  }

  public async cancel(workerId: string): Promise<void> {
    const record = this.records.get(workerId);
    if (!record) return;
    if (record.settlementPromise) {
      await record.settlementPromise;
      return;
    }
    if (record.settled) return;
    record.cancelled = true;
    record.launchGeneration += 1;
    if (record.terminalId) {
      workerTerminal.kill(record.terminalId, {
        signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
      });
    }
    await this.settle(record, 'cancelled', null);
  }

  public async retry(workerId: string): Promise<void> {
    const record = this.records.get(workerId);
    if (
      !record ||
      record.settled ||
      record.retrying ||
      record.retryAuthRefreshInFlight
    )
      return;
    record.retryAuthRefreshInFlight = true;
    try {
      const authStatus = await getCachedClaudeAuthStatusObserved(
        'claude-worker-retry',
        { forceRefresh: true },
      );
      if (!authStatus.authenticated) {
        throw new Error(getClaudeWorkerAuthRequiredMessage(authStatus.error));
      }
    } finally {
      record.retryAuthRefreshInFlight = false;
    }
    if (record.settled || record.cancelled || record.retrying) return;
    record.retrying = true;
    record.launchGeneration += 1;
    // A previous launch may still be writing its cursor. Let that admitted
    // sync finish before replacing the runtime directory or resetting the
    // transcript; the generation check discards its late result.
    await record.transcriptSyncTail;
    if (record.settled || record.cancelled) {
      record.retrying = false;
      await record.settlementPromise;
      return;
    }
    this.queue = this.queue.filter(
      (queued) => queued.workerId !== record.workerId,
    );
    if (record.runningSlot) {
      record.runningSlot = false;
      this.runningCount = Math.max(0, this.runningCount - 1);
    }
    if (record.timeout) {
      clearTimeout(record.timeout);
      record.timeout = undefined;
    }
    if (record.startupTimeout) {
      clearTimeout(record.startupTimeout);
      record.startupTimeout = undefined;
    }
    if (record.terminalId) {
      this.terminalIndex.delete(record.terminalId);
      workerTerminal.kill(record.terminalId, {
        signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
      });
      record.terminalId = undefined;
    }
    getDesktopIntegrationServer().unregisterCanopyWorktreeSessionRoute(
      record.sessionKey,
    );
    getDesktopIntegrationServer().unregisterMcpProxyRoutesForSession(
      record.sessionKey,
    );
    clearClaudeModAdmissionSessionRecords(record.sessionKey);
    record.approvalSession?.dispose();
    record.approvalSession = undefined;
    await rm(record.runtimeDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    if (record.settled || record.cancelled) {
      record.retrying = false;
      await record.settlementPromise;
      return;
    }
    record.cancelled = false;
    record.stopSeen = false;
    record.reportedResult = undefined;
    record.outputValidationRejected = false;
    record.turnUsage = emptyClaudeTerminalTurnUsage();
    record.transcriptPath = undefined;
    record.transcript = [];
    record.transcriptEvents = [];
    record.sessionKey = buildWorkerSessionKey(workerId);
    record.authToken = randomBytes(32).toString('hex');
    // Resume workers must keep resuming the same prior session on retry; only a
    // fresh-session worker gets a brand-new session id.
    if (!record.resume) {
      record.sdkSessionId = randomUUID();
    }
    record.queuedNotified = false;
    record.sessionStarted = false;
    // Keep the card in the Active section as `starting` and retain the previous
    // terminalId so the card stays in place (showing the prior frame) until the
    // relaunch swaps in the new session — no remove/re-add flicker. pumpQueue
    // only promotes it to `queued` if it actually has to wait for a slot.
    this.updateCard(record, {
      status: 'starting',
      startedAt: Date.now(),
    });
    this.queue.push(record);
    await this.pumpQueue();
  }

  public async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.records.keys()).map((workerId) => this.cancel(workerId)),
    );
  }

  public async runWorker<T>(
    request: ClaudeWorkerRunRequest<T>,
  ): Promise<ClaudeWorkerRunResult<T>> {
    if (!isClaudeTuiWorkersEnabled()) {
      throw new Error('Claude terminal worker mode is disabled.');
    }
    const authStatus = await getCachedClaudeAuthStatusObserved(
      'claude-worker-run',
      {
        forceRefresh: true,
      },
    );
    if (!authStatus.authenticated) {
      throw new Error(getClaudeWorkerAuthRequiredMessage(authStatus.error));
    }
    const workerId = randomUUID();
    const projectId = request.projectId ?? DEFAULT_PROJECT_ID;
    const worktreeId = request.worktreeId ?? DEFAULT_WORKTREE_ID;
    const chatId = request.chatId ?? workerId;
    const runtimeDir = getClaudeWorkerRuntimeDir(
      projectId,
      worktreeId,
      workerId,
    );
    const card: WorkerCardData = {
      workerId,
      kind: request.kind,
      label: request.label,
      // Start in `starting` (Active section). pumpQueue promotes a worker to
      // `queued` only if it genuinely waits on the cap, so a worker that gets an
      // immediate slot never bounces through the Queued section.
      status: 'starting',
      terminalId: '',
      startedAt: Date.now(),
      projectId,
      worktreeId,
      chatId,
      pipelineExecutionId: request.pipelineExecutionId,
      stepId: request.stepId,
      linkTarget:
        request.linkTarget ??
        buildDefaultLinkTarget(projectId, worktreeId, chatId),
    };
    const promise = new Promise<ClaudeWorkerRunResult<unknown>>(
      (resolve, reject) => {
        const record: RuntimeRecord = {
          workerId,
          request,
          card,
          runtimeDir,
          sessionKey: buildWorkerSessionKey(workerId),
          authToken: randomBytes(32).toString('hex'),
          // For resume, the session id IS the prior session to continue, so all
          // transcript/result logic keys off the resumed session.
          sdkSessionId: request.resumeSessionId ?? randomUUID(),
          schema: request.schema,
          isResult: request.isResult,
          resume: request.resumeSessionId !== undefined,
          stopSeen: false,
          settled: false,
          cancelled: false,
          turnUsage: emptyClaudeTerminalTurnUsage(),
          transcript: [],
          transcriptEvents: [],
          resolve,
          reject,
          retryAuthRefreshInFlight: false,
          retrying: false,
          runningSlot: false,
          queuedNotified: false,
          sessionStarted: false,
          launchGeneration: 0,
        };
        this.records.set(workerId, record);
        this.queue.push(record);
        this.emitStarted(record);
        request.onCreated?.(workerId);
        void this.pumpQueue();
      },
    );
    return promise as Promise<ClaudeWorkerRunResult<T>>;
  }

  private async pumpQueue(): Promise<void> {
    if (await this.failQueuedWorkersIfDisabled()) return;
    const preferences = await readPreferencesFile().catch(() => null);
    if (await this.failQueuedWorkersIfDisabled()) return;
    const limit = getEffectiveClaudeWorkerConcurrencyLimit(preferences);
    while (this.runningCount < limit && this.queue.length > 0) {
      const record = this.queue.shift();
      if (!record || record.settled) continue;
      this.runningCount += 1;
      record.runningSlot = true;
      const launchGeneration = (record.launchGeneration += 1);
      void this.launch(record, launchGeneration);
    }
    // Anything still queued genuinely waited on the cap — promote it to the
    // `queued` state (moves it to the Queued section) and notify once so callers
    // (e.g. pipeline steps) can surface a "queued" state instead of appearing to
    // run. Workers that got an immediate slot above never reach here, so they
    // stay in the Active section as `starting`/`running` without flicker.
    for (const record of this.queue) {
      if (record.settled || record.queuedNotified) continue;
      record.queuedNotified = true;
      if (record.card.status !== 'queued') {
        this.updateCard(record, { status: 'queued' });
      }
      record.request.onQueued?.(record.workerId);
    }
  }

  private async failQueuedWorkersIfDisabled(): Promise<boolean> {
    if (isClaudeTuiWorkersEnabled()) return false;
    const queuedRecords = this.queue.splice(0);
    await Promise.all(
      queuedRecords.map((record) =>
        this.settle(
          record,
          'failure',
          new Error('Claude terminal worker mode is disabled.'),
        ),
      ),
    );
    return true;
  }

  private isCurrentLaunch(
    record: RuntimeRecord,
    launchGeneration: number,
  ): boolean {
    return (
      !record.settled &&
      !record.cancelled &&
      !record.retrying &&
      record.launchGeneration === launchGeneration
    );
  }

  private async launch(
    record: RuntimeRecord,
    launchGeneration: number,
  ): Promise<void> {
    const sessionKey = record.sessionKey;
    const authToken = record.authToken;
    const sdkSessionId = record.sdkSessionId;
    let routeRegistered = false;
    try {
      await mkdir(record.runtimeDir, { recursive: true });
      if (
        record.settled ||
        record.cancelled ||
        record.launchGeneration !== launchGeneration
      ) {
        return;
      }
      record.retrying = false;
      await ensureClaudeWorkspaceTrust(record.request.cwd);
      if (!this.isCurrentLaunch(record, launchGeneration)) return;
      this.updateCard(record, { status: 'starting' });
      const server = getDesktopIntegrationServer();
      await server.registerCanopyWorktreeSessionRoute({
        sessionKey,
        projectId: record.card.projectId ?? DEFAULT_PROJECT_ID,
        worktreeId: record.card.worktreeId ?? DEFAULT_WORKTREE_ID,
        chatId: record.card.chatId ?? record.workerId,
        toolSurface: 'claude-worker',
        // Workers run with bypassPermissions; restricted tool exposure is what
        // keeps non-mutating permission presets non-mutating, so the memory
        // tools are gated by the same launch permission as the built-ins.
        workerMemoryToolExposure: resolveClaudeWorkerMemoryToolExposure(
          record.request.permission,
        ),
        cwd: record.request.cwd,
        sdkSessionId,
        authToken,
        createdAt: Date.now(),
        model: record.request.model,
        ...(record.request.ledgerTools
          ? { ledgerTools: record.request.ledgerTools }
          : {}),
        reportStructuredResultSchema: record.schema,
        onReportStructuredResult: (payload) => {
          if (!record.schema) {
            return { ok: false, error: 'No structured result is expected.' };
          }
          const schemaResult = validateAgainstSchema(
            record.isResult
              ? (record.request.resultValidationSchema ?? record.schema)
              : record.schema,
            payload,
          );
          if (!schemaResult.ok) {
            record.outputValidationRejected = true;
            record.request.onResultRejected?.(payload);
            return schemaResult;
          }
          if (record.isResult && !record.isResult(payload)) {
            record.outputValidationRejected = true;
            record.request.onResultRejected?.(payload);
            return { ok: false, error: 'payload failed result type guard' };
          }
          record.outputValidationRejected = false;
          record.reportedResult = payload;
          return { ok: true };
        },
        hookHandler: (body) => this.handleHook(record, body, launchGeneration),
      });
      routeRegistered = true;
      if (!this.isCurrentLaunch(record, launchGeneration)) {
        server.unregisterCanopyWorktreeSessionRoute(sessionKey);
        server.unregisterMcpProxyRoutesForSession(sessionKey);
        return;
      }
      const preferences = await readPreferencesFile().catch(() => null);
      record.approvalSession = createApprovalSession({
        sessionKey,
        projectId: record.card.projectId ?? DEFAULT_PROJECT_ID,
        worktreeId: record.card.worktreeId ?? DEFAULT_WORKTREE_ID,
        chatId: record.card.chatId ?? record.workerId,
        provider: 'claude',
        workspaceRoot: record.request.cwd,
        mode: record.request.approvalMode ?? 'ask',
        sessionRules: [
          ...(record.schema
            ? [allowWorkerMcpTool('ReportStructuredResult')]
            : []),
          // A pipeline agent's Ledger calls are the host's own bookkeeping,
          // so an unattended worker allows them rather than failing closed.
          ...(record.request.ledgerTools
            ? LEDGER_INJECTED_TOOL_KEYS.map((key) =>
                allowWorkerMcpTool(
                  CANOPY_INJECTED_TOOL_REGISTRY[key].displayName,
                ),
              )
            : []),
        ],
        // Workers are unattended. Pipeline permission presets select their
        // explicit mode; an unexpected prompt therefore fails closed.
        getWindow: () => null,
      });
      const config = await buildClaudeTerminalLaunchConfig({
        projectId: record.card.projectId ?? DEFAULT_PROJECT_ID,
        worktreeId: record.card.worktreeId ?? DEFAULT_WORKTREE_ID,
        chatId: record.card.chatId ?? record.workerId,
        cwd: record.request.cwd,
        runtimeDir: record.runtimeDir,
        sessionKey,
        authToken,
        sdkSessionId,
        resumeExistingSession: record.resume,
        // Resume reuses the session's original system prompt; only fresh
        // sessions get the worker system prompt (with the autonomy instruction).
        systemPromptAppend: record.resume
          ? undefined
          : buildWorkerSystemPrompt(record.request.systemPrompt, record.schema),
        initialPrompt: record.resume
          ? buildWorkerResumePrompt(record.request.prompt, record.schema)
          : record.request.prompt,
        model: record.request.model,
        thinkingLevel: record.request.thinkingLevel,
        permission: withLedgerToolsAllowed(
          record.request.permission,
          record.request.ledgerTools !== undefined,
        ),
        settingSources: record.request.settingSources,
        maxTurns: record.request.maxTurns,
        pluginSelections: record.request.pluginSelections,
        mcpServers: record.request.mcpServers,
        claudeEnvOverride: record.request.claudeEnvOverride,
        approvalHookEnabled: true,
        rtkEnabled: false,
        preventClaudeNativeCaffeinate:
          preferences?.preventClaudeNativeCaffeinate !== false,
      });
      replaceClaudeModAdmissionSessionRecords(
        sessionKey,
        config.claudeModAdmission?.skippedMods ?? [],
      );
      if (!this.isCurrentLaunch(record, launchGeneration)) {
        clearClaudeModAdmissionSessionRecords(sessionKey);
        server.unregisterCanopyWorktreeSessionRoute(sessionKey);
        server.unregisterMcpProxyRoutesForSession(sessionKey);
        return;
      }
      const terminal = await spawnPlacedManagedTerminal({
        projectId: record.card.projectId ?? DEFAULT_PROJECT_ID,
        worktreeId: record.card.worktreeId ?? DEFAULT_WORKTREE_ID,
        cwd: record.request.cwd,
        cols: WORKER_COLS,
        rows: WORKER_ROWS,
        managedCommand: {
          executable: config.executable,
          args: config.args,
          env: config.env,
          pathPrepend: config.pathPrepend,
          title: record.request.label,
          kind: 'claude-worker',
          chatId: record.card.chatId,
          sessionKey,
        },
      });
      // Cancelled or relaunched while the daemon started the terminal (CAN-5097).
      if (!this.isCurrentLaunch(record, launchGeneration)) {
        workerTerminal.kill(terminal.id, {
          signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
        });
        server.unregisterCanopyWorktreeSessionRoute(sessionKey);
        server.unregisterMcpProxyRoutesForSession(sessionKey);
        return;
      }
      record.terminalId = terminal.id;
      this.terminalIndex.set(terminal.id, record.workerId);
      if (!workerTerminal.get(terminal.id)) {
        await this.settle(
          record,
          'failure',
          new Error('The Claude worker terminal ended before it started.'),
        );
        return;
      }
      this.updateCard(record, {
        terminalId: terminal.id,
        status: 'running',
      });
      record.request.onStarted?.(record.workerId);
      this.startAudit(record);
      const startupTimeoutMs = record.request.startupTimeoutMs ?? 0;
      if (startupTimeoutMs > 0 && !record.sessionStarted) {
        record.startupTimeout = setTimeout(() => {
          const operation = record.resume ? 'resume' : 'start';
          void this.settle(
            record,
            'failure',
            new Error(
              `Agent session did not ${operation} within ${String(startupTimeoutMs)} ms.`,
            ),
          );
        }, startupTimeoutMs);
      }
      const timeoutMs = record.request.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
      if (timeoutMs > 0) {
        record.timeout = setTimeout(() => {
          void this.settle(record, 'failure', new Error('Worker timed out.'));
        }, timeoutMs);
      }
    } catch (error) {
      if (!this.isCurrentLaunch(record, launchGeneration)) {
        if (routeRegistered) {
          getDesktopIntegrationServer().unregisterCanopyWorktreeSessionRoute(
            sessionKey,
          );
          getDesktopIntegrationServer().unregisterMcpProxyRoutesForSession(
            sessionKey,
          );
        }
        return;
      }
      await this.settle(
        record,
        'failure',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private async handleHook(
    record: RuntimeRecord,
    body: ClaudeTerminalHookCallbackBody,
    launchGeneration: number,
  ): Promise<unknown> {
    if (record.settled || record.launchGeneration !== launchGeneration) {
      return undefined;
    }
    const eventName = body.hookEventName;
    const payload = body.hookPayload;
    const synced = await this.withTranscriptSync(
      record,
      launchGeneration,
      async () => {
        if (eventName === 'SessionStart') {
          record.sessionStarted = true;
          if (record.startupTimeout) {
            clearTimeout(record.startupTimeout);
            record.startupTimeout = undefined;
          }
        }
        if (typeof payload === 'object' && payload !== null) {
          const transcriptPath =
            'transcript_path' in payload &&
            typeof payload.transcript_path === 'string'
              ? payload.transcript_path
              : undefined;
          if (
            transcriptPath &&
            isAllowedClaudeTerminalTranscriptPath(
              transcriptPath,
              record.runtimeDir,
            )
          ) {
            record.transcriptPath = transcriptPath;
          }
        }
        const syncResult = await syncClaudeTerminalTranscript({
          projectId: record.card.projectId ?? DEFAULT_PROJECT_ID,
          worktreeId: record.card.worktreeId ?? DEFAULT_WORKTREE_ID,
          chatId: record.card.chatId ?? record.workerId,
          sessionKey: record.sessionKey,
          sdkSessionId: record.sdkSessionId,
          transcriptPath: record.transcriptPath,
          hookEventName: eventName,
          hookPayload: payload,
          persistChatState: false,
          runtimeDir: record.runtimeDir,
        });
        // Retry replaces this worker's record. A completed old sync may have
        // written its old cursor, but must never populate the new attempt.
        if (record.launchGeneration !== launchGeneration && !record.settled) {
          return;
        }
        let importedMessages = syncResult.importedMessages;
        let importedEvents = syncResult.importedEvents;
        let replayReplacements: Map<number, PersistedChatMessage> | undefined;
        if (syncResult.replayedFromStart === true) {
          // The on-disk cursor retains only its most recent 500 event IDs. A
          // replacement or truncation can replay an older event outside that
          // window, while this worker still owns its complete in-memory record.
          // Build replay sets only on that uncommon path, not on every hook.
          let hashedCount = 0;
          let lastYieldAt = performance.now();
          const yieldAfterBoundedHashWork = (): Promise<void> | null => {
            hashedCount += 1;
            if (
              hashedCount % 256 !== 0 &&
              performance.now() - lastYieldAt < 8
            ) {
              return null;
            }
            return new Promise<void>((resolve) => setImmediate(resolve)).then(
              () => {
                lastYieldAt = performance.now();
              },
            );
          };
          const messagesById = new Map<
            string,
            { index: number; fingerprint: string }
          >();
          for (let index = 0; index < record.transcript.length; index += 1) {
            const message = record.transcript[index];
            if (message) {
              messagesById.set(message.id, {
                index,
                fingerprint: replayMessageFingerprint(message),
              });
            }
            const pause = yieldAfterBoundedHashWork();
            if (pause) await pause;
            if (
              record.launchGeneration !== launchGeneration &&
              !record.settled
            ) {
              return;
            }
          }
          const uniqueMessages: PersistedChatMessage[] = [];
          const replacements = new Map<number, PersistedChatMessage>();
          for (let index = 0; index < importedMessages.length; index += 1) {
            const message = importedMessages[index];
            if (!message) continue;
            const fingerprint = replayMessageFingerprint(message);
            const existing = messagesById.get(message.id);
            if (!existing) {
              messagesById.set(message.id, {
                index: record.transcript.length + uniqueMessages.length,
                fingerprint,
              });
              uniqueMessages.push(message);
            } else if (existing.fingerprint !== fingerprint) {
              messagesById.set(message.id, {
                index: existing.index,
                fingerprint,
              });
              if (existing.index < record.transcript.length) {
                replacements.set(existing.index, message);
              } else {
                uniqueMessages[existing.index - record.transcript.length] =
                  message;
              }
            }
            const pause = yieldAfterBoundedHashWork();
            if (pause) await pause;
            if (
              record.launchGeneration !== launchGeneration &&
              !record.settled
            ) {
              return;
            }
          }
          importedMessages = uniqueMessages;
          replayReplacements = replacements;
          const existingEvents = new Set<string>();
          for (
            let index = 0;
            index < record.transcriptEvents.length;
            index += 1
          ) {
            existingEvents.add(
              replayEventFingerprint(record.transcriptEvents[index]),
            );
            const pause = yieldAfterBoundedHashWork();
            if (pause) await pause;
            if (
              record.launchGeneration !== launchGeneration &&
              !record.settled
            ) {
              return;
            }
          }
          const uniqueEvents: unknown[] = [];
          for (let index = 0; index < importedEvents.length; index += 1) {
            const event = importedEvents[index];
            const fingerprint = replayEventFingerprint(event);
            if (!existingEvents.has(fingerprint)) {
              existingEvents.add(fingerprint);
              uniqueEvents.push(event);
            }
            const pause = yieldAfterBoundedHashWork();
            if (pause) await pause;
            if (
              record.launchGeneration !== launchGeneration &&
              !record.settled
            ) {
              return;
            }
          }
          importedEvents = uniqueEvents;
        }
        if (record.launchGeneration !== launchGeneration && !record.settled) {
          return;
        }
        if (replayReplacements) {
          for (const [index, message] of Array.from(replayReplacements)) {
            record.transcript[index] = message;
          }
        }
        record.transcript.push(...importedMessages);
        record.transcriptEvents.push(...importedEvents);
        accumulateImportedTranscriptUsage(record.turnUsage, {
          importedEvents,
          importedMessageIds: importedMessages.map((message) => message.id),
          // Duplicates were removed against the complete worker record above.
          // Event-only tool/result and usage records must remain eligible.
          replayedFromStart: false,
        });
      },
    );
    if (
      !synced ||
      record.settled ||
      record.launchGeneration !== launchGeneration
    ) {
      return undefined;
    }
    if (eventName === 'PreToolUse') {
      if (!record.approvalSession || !isUnknownRecord(payload)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Approval session is unavailable.',
          },
        };
      }
      const toolName = getStringField(payload, 'tool_name');
      const toolInput = payload.tool_input;
      if (!toolName || !isUnknownRecord(toolInput)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Invalid tool name or input.',
          },
        };
      }
      if (
        record.request.permission?.permissionMode === 'plan' &&
        !CLAUDE_PLAN_MODE_READ_ONLY_TOOLS.has(toolName)
      ) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Plan mode permits read-only tools only.',
          },
        };
      }
      if (record.request.approvalMode === 'full-access') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        };
      }
      const approval = approvalCheckForClaudeTool(
        toolName,
        toolInput,
        record.request.cwd,
      );
      if (approval.failClosedReason) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: approval.failClosedReason,
          },
        };
      }
      let outcome: ApprovalOutcome = { decision: 'allow' };
      for (const requirement of [
        approval,
        ...(approval.additionalRequirements ?? []),
      ]) {
        outcome = await record.approvalSession.check(requirement.check, {
          title: `Claude Code wants to use ${requirement.titleTool ?? toolName}`,
          details: requirement.details,
          suggestedTarget: requirement.suggestedTarget,
          toolUseId: getStringField(payload, 'tool_use_id'),
        });
        if (outcome.decision !== 'allow') break;
      }
      if (outcome.decision !== 'allow') {
        outcome = {
          decision: 'deny',
          message:
            outcome.message ?? 'Approval check failed; denied by default.',
          ...(outcome.stopTurn ? { stopTurn: true } : {}),
        };
      }
      return {
        ...(outcome.stopTurn
          ? {
              continue: false,
              stopReason:
                outcome.message ?? 'Tool use denied and turn stopped.',
            }
          : {}),
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: outcome.decision,
          ...(outcome.message
            ? { permissionDecisionReason: outcome.message }
            : {}),
        },
      };
    }
    if (eventName === 'Stop') {
      record.stopSeen = true;
      await this.settle(
        record,
        record.schema && record.reportedResult === undefined
          ? 'failure'
          : 'success',
        null,
      );
    } else if (eventName === 'StopFailure') {
      await this.settle(
        record,
        'failure',
        new Error('Claude worker stop failed.'),
      );
    }
    return undefined;
  }

  private async withTranscriptSync(
    record: RuntimeRecord,
    launchGeneration: number,
    sync: () => Promise<void>,
  ): Promise<boolean> {
    const previous = record.transcriptSyncTail ?? Promise.resolve();
    const operation = previous.then(async (): Promise<boolean> => {
      // Hooks admitted before cancellation remain in this queue and finish
      // before settlement projects the worker result. Retry instead replaces
      // the launch without settling, so old queued hooks must be discarded.
      if (record.launchGeneration !== launchGeneration && !record.settled) {
        return false;
      }
      await sync();
      return true;
    });
    const tail = operation.then(
      (): void => undefined,
      (): void => undefined,
    );
    record.transcriptSyncTail = tail;
    try {
      return await operation;
    } finally {
      if (record.transcriptSyncTail === tail) {
        record.transcriptSyncTail = undefined;
      }
    }
  }

  private handleTerminalEvent(event: WorkerTerminalEvent): void {
    if (event.type !== 'exit') return;
    const payload = event.payload;
    const workerId = this.terminalIndex.get(payload.terminalId);
    if (!workerId) return;
    const record = this.records.get(workerId);
    if (!record || record.settled) return;
    void this.settle(
      record,
      'interrupted',
      new Error('Claude worker exited before completion.'),
    );
  }

  private startAudit(record: RuntimeRecord): void {
    if (!record.request.auditEventType) return;
    const startedAt = new Date(record.card.startedAt).toISOString();
    const entry: AgentAuditEntry = {
      id: `${record.workerId}:${record.card.startedAt}`,
      eventType: record.request.auditEventType,
      status: 'running',
      provider: 'claude',
      label: record.request.label,
      startedAt,
      model: record.request.model,
      tokens: {
        input: 0,
        output: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      messageCount: 0,
      assistantMessageCount: 0,
      toolUseCount: 0,
      subAgentCount: 0,
      hasTranscript: false,
      toolCounts: {
        thinking: 0,
        bash: 0,
        read: 0,
        readLines: 0,
        writeEdit: 0,
        plan: 0,
        fileEdit: 0,
        fileAdd: 0,
        fileDelete: 0,
        search: 0,
        grep: 0,
        web: 0,
        agent: 0,
        workflow: 0,
        tasks: 0,
        taskStop: 0,
        skills: 0,
        monitor: 0,
        claude: 0,
        scheduleWakeup: 0,
        askUser: 0,
        scriptOutput: 0,
        watcher: 0,
        canopy: 0,
        graph: 0,
        appAdvisor: 0,
        pipelineEditor: 0,
        mcp: 0,
        other: 0,
      },
      projectId: record.card.projectId,
      worktreeId: record.card.worktreeId,
      chatId: record.card.chatId,
      chatMode: 'terminal',
      linkTarget: record.card.linkTarget,
    };
    record.taskKey = `worker:${record.workerId}`;
    getExecutionObservabilityIngest().startObservedTask(record.taskKey, entry);
  }

  private settle(
    record: RuntimeRecord,
    status: WorkerStatus,
    error: Error | null,
  ): Promise<void> {
    if (record.settlementPromise) return record.settlementPromise;
    if (record.settled) return Promise.resolve();
    record.settled = true;
    // Publish the in-flight settlement before its cleanup can trigger another
    // cancellation or shutdown. Those callers must join the same drain.
    record.settlementPromise = Promise.resolve().then(() =>
      this.finishSettlement(record, status, error),
    );
    return record.settlementPromise;
  }

  private async finishSettlement(
    record: RuntimeRecord,
    status: WorkerStatus,
    error: Error | null,
  ): Promise<void> {
    if (record.timeout) {
      clearTimeout(record.timeout);
    }
    if (record.startupTimeout) {
      clearTimeout(record.startupTimeout);
    }
    if (record.runningSlot) {
      record.runningSlot = false;
      this.runningCount = Math.max(0, this.runningCount - 1);
      void this.pumpQueue();
    }
    if (record.terminalId) {
      this.terminalIndex.delete(record.terminalId);
      workerTerminal.kill(record.terminalId, {
        signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
      });
    }
    getDesktopIntegrationServer().unregisterCanopyWorktreeSessionRoute(
      record.sessionKey,
    );
    getDesktopIntegrationServer().unregisterMcpProxyRoutesForSession(
      record.sessionKey,
    );
    clearClaudeModAdmissionSessionRecords(record.sessionKey);
    record.approvalSession?.dispose();
    record.approvalSession = undefined;
    // Hooks admitted before settlement may still be reading/writing the
    // transcript cursor. Drain only that short segment; approval waits are
    // outside it, and Stop invokes settle after releasing it.
    await record.transcriptSyncTail;
    const usage = usageFromTurnUsage(record.turnUsage);
    const text = finalAssistantText(record.transcript);
    const jsonl = normalizeClaudeTerminalTranscriptToSdkJsonl(
      record.transcriptEvents,
      usage,
      text,
    );
    if (record.taskKey) {
      getExecutionObservabilityIngest().finalizeObservedTask(
        record.taskKey,
        status === 'success'
          ? 'success'
          : status === 'cancelled'
            ? 'cancelled'
            : 'failure',
        error?.message,
        usage,
      );
    }
    await rm(record.runtimeDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    this.updateCard(record, { status });
    this.emitExited(record, status);
    const removalTimer = setTimeout(() => {
      this.records.delete(record.workerId);
    }, SETTLED_CARD_TTL_MS);
    removalTimer.unref?.();
    record.resolve({
      workerId: record.workerId,
      sessionId: record.sdkSessionId,
      sessionStarted: record.sessionStarted,
      result:
        record.schema !== undefined ? (record.reportedResult ?? null) : text,
      finalText: text,
      usage,
      transcript: record.transcript,
      transcriptJsonl: jsonl,
      proposedPlan: extractClaudeProposedPlanFromJsonl(jsonl),
      status,
      ...(error ? { error: error.message } : {}),
      ...(record.stopSeen &&
      status === 'failure' &&
      error === null &&
      record.reportedResult === undefined &&
      record.outputValidationRejected
        ? { invalidOutput: true }
        : {}),
    });
  }

  private updateCard(
    record: RuntimeRecord,
    patch: Partial<WorkerCardData>,
  ): void {
    record.card = { ...record.card, ...patch };
    this.eventSender(IPC_CHANNELS.workerUpdated, {
      workerId: record.workerId,
      patch,
    });
  }

  private emitStarted(record: RuntimeRecord): void {
    this.eventSender(IPC_CHANNELS.workerStarted, { worker: record.card });
  }

  private emitExited(record: RuntimeRecord, status: WorkerStatus): void {
    this.eventSender(IPC_CHANNELS.workerExited, {
      workerId: record.workerId,
      status,
    });
  }
}

let service: DefaultClaudeWorkerSessionService | null = null;

export function getClaudeWorkerSessionService(): DefaultClaudeWorkerSessionService {
  service ??= new DefaultClaudeWorkerSessionService();
  return service;
}
