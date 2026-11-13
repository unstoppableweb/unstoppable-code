import type { CodexSpawnEnvironmentPolicy } from './profile';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as os from 'node:os';
import type { Transform } from 'node:stream';
import { createJsonLineStream } from './json-lines';
import {
  getBundledCodexBinaryPath,
  getEnhancedEnv,
} from '@canopy/execution-engine/pipelines/config-paths';
import {
  DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES,
  type ResourceMetadata,
} from '@canopy/execution-engine/execution-types';
import { killChildProcessGroup } from '@canopy/execution-engine/node/lib/process-kill';
import { extractApprovalThreadId } from './approval-thread-id';
import type { ClientNotification } from './generated/ClientNotification';
import type { ClientRequest } from './generated/ClientRequest';
import type { JsonValue } from './generated/serde_json/JsonValue';
import type { AccountRateLimitsUpdatedNotification } from './generated/v2/AccountRateLimitsUpdatedNotification';
import type { AccountUpdatedNotification } from './generated/v2/AccountUpdatedNotification';
import type { CurrentTimeReadResponse } from './generated/v2/CurrentTimeReadResponse';
import type { McpServerElicitationRequestResponse } from './generated/v2/McpServerElicitationRequestResponse';
import type { MarketplaceAddResponse } from './generated/v2/MarketplaceAddResponse';
import type { MarketplaceRemoveResponse } from './generated/v2/MarketplaceRemoveResponse';
import type { MarketplaceUpgradeResponse } from './generated/v2/MarketplaceUpgradeResponse';
import type { ListMcpServerStatusResponse } from './generated/v2/ListMcpServerStatusResponse';
import type { PluginInstallResponse } from './generated/v2/PluginInstallResponse';
import type { PluginUninstallResponse } from './generated/v2/PluginUninstallResponse';
import type { PluginInstalledResponse } from './generated/v2/PluginInstalledResponse';
import type { PluginListResponse } from './generated/v2/PluginListResponse';
import type { PluginReadResponse } from './generated/v2/PluginReadResponse';
import type { SkillsListResponse } from './generated/v2/SkillsListResponse';
import type { PluginSkillReadResponse } from './generated/v2/PluginSkillReadResponse';
import type { ThreadForkResponse } from './generated/v2/ThreadForkResponse';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse';
import { observeCanonicalCodexHome } from './canonical-state';
import {
  getCodexRuntimeHostHooks,
  type CodexRuntimeResourceRegistrationHandle,
  type CodexRuntimeSharedRestartDiagnostic,
  type CodexRuntimeStoppedDiagnostic,
  type CodexRuntimeThreadCloseWaitDiagnostic,
} from './host-hooks';
import {
  DEFAULT_LONG_STDOUT_HOLD_THRESHOLD_MS,
  DEFAULT_OWNER_LANE_HIGH_WATER_BYTES,
  DEFAULT_OWNER_LANE_HARD_LIMIT_BYTES,
  DEFAULT_OWNER_LANE_LOW_WATER_BYTES,
  OwnerAdmissionLanes,
  TranscriptAdmissionDiscardedError,
  type CodexIngestionLagChange,
  type CodexIngestionLagSample,
  type CodexIngestionLagSnapshot,
  type OwnerInFlightBudget,
  type StdoutHoldReport,
} from './owner-admission-lanes';
export type {
  CodexIngestionLagChange,
  CodexIngestionLagSample,
  CodexIngestionLagSnapshot,
  CodexIngestionLagSource,
} from './owner-admission-lanes';
export { DEFAULT_INGESTION_LAG_THRESHOLD_MS } from './owner-admission-lanes';
import { RequestDeadline } from './request-deadline';
import { isJsonValue } from './rollout-seed';
import type { CodexMcpToolCallContext } from './thread-handle';
import type { CodexResolvedSpawnProfile } from './profile';
import { CODEX_LIFECYCLE } from '../harness-contract/codex-lifecycle';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

type JsonRpcId = number | string;

const CODEX_PROCESS_RECOVERY_HANDLER_QUIESCENCE_TIMEOUT_MS = 30_000;
const MAX_RETAINED_RESPONSES = 32;
const RETAINED_RESPONSE_TIMEOUT_MS = 10 * 60_000;
export const CODEX_APP_SERVER_MIN_LIFETIME_BEFORE_PRESSURE_SUSPEND_MS = 120_000;
/**
 * Codex keeps each loaded thread, with the MCP subprocesses it started, after
 * unsubscribe, so a pooled worker that never goes idle grows without bound.
 * Recycle it once this many root threads have loaded and nothing is in flight.
 */
export const CODEX_APP_SERVER_THREAD_LOAD_BUDGET = 32;
const CODEX_PRESSURE_SUSPEND_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
/**
 * How long a pool key must go without another pressure suspension before its
 * escalation resets. Without this, `consecutiveSuspensions` only ever resets on
 * a dispatched `turn/start` or on pool removal, so a connection that serves
 * only administrative traffic (marketplace ops, `plugin/list`, discovery) would
 * pin at the 15-minute cap permanently - long after the pressure episode that
 * produced it ended. Set to twice the longest backoff so a decay can only
 * happen once the largest step has fully elapsed unused.
 *
 * The deliberate trade in the other direction: under SUSTAINED critical
 * pressure this withholds suspension of a genuinely idle app-server for up to
 * 15 minutes. That is preferred to the kill/respawn churn the backoff exists to
 * stop, which is what leaked the staging checkouts in the first place.
 */
const CODEX_PRESSURE_SUSPEND_BACKOFF_DECAY_MS =
  2 *
  CODEX_PRESSURE_SUSPEND_BACKOFF_MS[
    CODEX_PRESSURE_SUSPEND_BACKOFF_MS.length - 1
  ];

function abortSignalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Codex app-server operation was cancelled');
}

export type AppServerRequestMethod = ClientRequest['method'];

type GeneratedRequestParams<TMethod extends AppServerRequestMethod> = Extract<
  ClientRequest,
  { method: TMethod }
>['params'];

export type AppServerRequestParams<TMethod extends AppServerRequestMethod> =
  GeneratedRequestParams<TMethod>;

export type AppServerRequestResponse<TMethod extends AppServerRequestMethod> =
  TMethod extends 'plugin/uninstall'
    ? PluginUninstallResponse
    : TMethod extends 'marketplace/add'
      ? MarketplaceAddResponse
      : TMethod extends 'marketplace/upgrade'
        ? MarketplaceUpgradeResponse
        : TMethod extends 'marketplace/remove'
          ? MarketplaceRemoveResponse
          : TMethod extends 'plugin/list'
            ? PluginListResponse
            : TMethod extends 'plugin/read'
              ? PluginReadResponse
              : TMethod extends 'plugin/install'
                ? PluginInstallResponse
                : TMethod extends 'plugin/installed'
                  ? PluginInstalledResponse
                  : TMethod extends 'plugin/skill/read'
                    ? PluginSkillReadResponse
                    : TMethod extends 'skills/list'
                      ? SkillsListResponse
                      : TMethod extends 'mcpServerStatus/list'
                        ? ListMcpServerStatusResponse
                        : TMethod extends 'thread/start'
                          ? ThreadStartResponse
                          : TMethod extends 'thread/resume'
                            ? ThreadResumeResponse
                            : TMethod extends 'thread/fork'
                              ? ThreadForkResponse
                              : unknown;

export interface CodexAppServerConnectionOwner {
  hasActiveTurn(): boolean;
  /**
   * Reports live owner work that is not an active top-level Codex turn.
   * Owners that do not track background work may omit this hook.
   */
  hasLiveBackgroundWork?(): boolean;
  /**
   * Distinguishes work already sent toward the shared worker from a turn that
   * is only preparing to dispatch. Owners without a preparation phase can
   * rely on `hasActiveTurn()`.
   */
  hasDispatchedTurn?(): boolean;
  /** Thread creation, or a thread the owner cannot restore, that a worker restart would orphan. */
  hasInFlightOperation?(): boolean;
  getActiveTurnInterruptTarget(): {
    threadId: string;
    turnId: string | null;
  } | null;
  cancelPendingTurnStart(error: Error): void;
  rejectActiveTurn(
    error: Error,
    expectedRecovery?: Promise<CodexProcessRecoveryResult>,
  ): void;
  markProcessSuspended(): void;
  markProcessFailed(): void;
  cancelPendingServerRequestsForRecovery?(): void;
  /**
   * Reconcile an active turn after the shared stdio worker disappears.
   * Implementations must resume persisted state before deciding whether a
   * mutating request is safe to replay.
   */
  recoverAfterUnexpectedProcessExit?(
    error: CodexRecoverableProcessExitError,
  ): Promise<CodexProcessRecoveryResult>;
  handleConnectionNotification(
    method: string,
    notification: Record<string, unknown>,
    /** Controls arrive now; transcript finalization may await this drain. */
    transcriptDrain?: Promise<void>,
  ): void | Promise<void>;
  /**
   * A notification method the lifecycle table lacks that no owner claims
   * (turn-state phase 43b). Every attached owner hears it, so drift on a
   * shared process is still reported per session.
   */
  handleUnroutedUnknownNotification?(method: string): void;
  /** Receives content-free admission lag transitions without delaying admission. */
  handleIngestionLagChange?(
    change: CodexIngestionLagChange,
  ): void | Promise<void>;
  /** Receives periodic content-free ingestion lag samples without delaying admission. */
  handleIngestionLagSample?(
    sample: CodexIngestionLagSample,
  ): void | Promise<void>;
  handleRequestUserInput(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void>;
  handleDynamicToolCall(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
  ): Promise<void>;
  handleApprovalRequest(
    requestId: JsonRpcId,
    method: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void>;
  handleMcpElicitation(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
    toolCall: CodexMcpToolCallContext,
    approvalKind: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface CodexAppServerProcessCallbacks {
  onProcessStarted?: (pid: number) => void;
  onProcessExit?: (details: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderrTail: string;
    stderrTruncated: boolean;
    pid: number | null;
    uptimeMs: number | null;
    clientCount: number;
    activeTurnCount: number;
    recoveryScheduled: boolean;
  }) => void;
  onProcessError?: (details: { error: string; stderrTail: string }) => void;
  onProcessRecovery?: (details: {
    status: 'succeeded' | 'failed';
    strategy?: CodexProcessRecoveryResult['strategy'];
    error?: string;
  }) => void;
}

export interface CodexProcessRecoveryResult {
  strategy: 'restarted' | 'reconciled' | 'replayed' | 'continued';
}

export class CodexRecoverableProcessExitError extends Error {
  readonly recoverable = true;

  constructor(message: string) {
    super(message);
    this.name = 'CodexRecoverableProcessExitError';
  }
}

export function isCodexRecoverableProcessExitError(
  error: unknown,
): error is CodexRecoverableProcessExitError {
  return error instanceof CodexRecoverableProcessExitError;
}

/**
 * A JSON-RPC error response from the app-server. The message is the server's
 * own, unchanged, so existing message checks keep working; the code and data
 * are retained for callers that can match on them.
 */
export class CodexAppServerJsonRpcError extends Error {
  readonly method: string;
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(
    method: string,
    message: string,
    code: number | undefined,
    data: unknown,
  ) {
    super(message);
    this.name = 'CodexAppServerJsonRpcError';
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

// The app-server's exact wording. It asks for the retry itself; no stable
// JSON-RPC code distinguishes this rejection.
const THREAD_CLOSING_ERROR_PATTERN =
  /\bis closing; retry thread\/resume after the thread is closed\b/;

/**
 * A `thread/resume` rejected because the app-server is still shutting that
 * thread down. Nothing was resumed and no turn was started, so the same
 * request is safe to send again once the close finishes.
 */
export function isCodexThreadClosingError(error: unknown): boolean {
  return (
    error instanceof Error && THREAD_CLOSING_ERROR_PATTERN.test(error.message)
  );
}

const THREAD_WRITER_CONFLICT_ERROR_PATTERN = /\balready has an active writer\b/;

/**
 * A `thread/resume` refused because another app-server process still holds
 * the thread's writer. `thread/unsubscribe` does not release it: the thread
 * stays loaded in that process until Codex unloads it or the process exits.
 */
export function isCodexThreadWriterConflictError(error: unknown): boolean {
  return (
    error instanceof Error &&
    THREAD_WRITER_CONFLICT_ERROR_PATTERN.test(error.message)
  );
}

/** How the pool resolved a writer held by another of its workers. */
export type CodexWriterHandoffOutcome =
  | 'released'
  | 'holder-busy'
  | 'no-local-holder';

interface PendingResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  owner?: CodexAppServerConnectionOwner;
  rejectOnOwnerFailure: boolean;
  /**
   * Set once the response frame is read, before immediate delivery. The
   * deadline is cancelled and routing no longer treats the RPC as pending.
   */
  responseReceived: boolean;
  deadline: RequestDeadline | null;
  timeoutMs: number | undefined;
  softTimeout?: SoftRequestTimeout;
  retainedTimer: ReturnType<typeof setTimeout> | null;
  /** `thread/resume` only: the thread it will subscribe this connection to. */
  resumeThreadId?: string;
}

export type CodexAppServerLateResponse =
  | { kind: 'success'; value: unknown }
  | { kind: 'error'; error: Error };

interface SoftRequestTimeout {
  onLateResponse: (outcome: CodexAppServerLateResponse) => void;
}

interface QuarantinedOwner {
  error: Error;
  threadId: string;
  turnId: string | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  cancelDeadline: (() => void) | null;
}

interface PendingDisposedTurnInterrupt {
  threadId: string;
  turnId: string;
  cancelTerminalDeadline: (() => void) | null;
}

interface PendingPromptRequestFields {
  threadId: string;
  controller: AbortController;
}

type PendingUserInputServerRequest = PendingPromptRequestFields & {
  kind: 'requestUserInput';
};

type PendingApprovalServerRequest = PendingPromptRequestFields & {
  kind: 'approval';
  method: string;
  failClosedResult: Record<string, unknown>;
};

type PendingMcpElicitationServerRequest = PendingPromptRequestFields & {
  kind: 'mcpElicitation';
};

type PendingPromptServerRequest =
  | PendingUserInputServerRequest
  | PendingApprovalServerRequest
  | PendingMcpElicitationServerRequest;

type PendingServerRequest =
  | PendingPromptServerRequest
  | { kind: 'dynamicToolCall' };

const INITIALIZE_REQUEST_TIMEOUT_MS = 30_000;
const INTERRUPT_REQUEST_TIMEOUT_MS = 5_000;
const EXTERNAL_AUTH_TRANSITION_TIMEOUT_MS = 5 * 60_000;
const INTERRUPT_PROCESS_GRACE_MS = 1_000;
const QUARANTINED_INTERRUPT_RETRY_DELAY_MS = 1_000;
const QUARANTINED_INTERRUPT_DEADLINE_MS = 30_000;
const DISPOSED_TURN_TERMINAL_GRACE_MS = 5_000;
/**
 * The longest a terminal or quarantine deadline waits beyond its own length
 * while the frame it awaits may already sit in a stdout backlog. Byte-cap
 * pauses were observed to last minutes under heavy chat-storage load; past
 * this bound, process recovery takes precedence again.
 */
const MAX_BACKLOG_DEADLINE_EXTENSION_MS = 5 * 60_000;
const FORCE_KILL_PROCESS_GROUP_DELAY_MS = 5_000;
const MAX_CAPTURED_STDERR_CHARS = 12 * 1024;
const MAX_REPORTED_STDERR_CHARS = 4 * 1024;
const STARTUP_STATE_DB_RETRY_DELAY_MS = 5_000;
const STARTUP_STATE_DB_MAX_RETRIES = 4;
export const DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS = 2 * 60_000;
export const DEFAULT_CODEX_TURN_START_TIMEOUT_MS = 10 * 60_000;
// Waits between `thread/resume` attempts while the app-server finishes closing
// the thread; the last delay repeats. A `thread/closed` notification ends a
// wait early.
const THREAD_CLOSING_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
const THREAD_CLOSING_RETRY_BUDGET_MS = 30_000;
// Thread requests whose deadline passed, kept so a response that still arrives
// can be cleaned up instead of leaving a thread loaded with no owner.
const MAX_TIMED_OUT_THREAD_REQUESTS = 64;
const LATE_THREAD_CLEANUP_TIMEOUT_MS = 10_000;
const UNRESPONSIVE_PROCESS_RECYCLE_ERROR =
  'Codex app-server was restarted because it stopped responding. Please retry this message.';
const SHARED_INTERRUPT_RETRY_ERROR =
  'Codex app-server was restarted because another turn could not be interrupted cleanly. Please retry this message.';

/**
 * Raised for an owner whose request or turn ended because the shared
 * app-server was terminated to stop a different owner's turn, and which could
 * not be recovered from its persisted thread.
 */
export class CodexSharedRestartPeerError extends Error {
  constructor() {
    super(SHARED_INTERRUPT_RETRY_ERROR);
    this.name = 'CodexSharedRestartPeerError';
  }
}

export function isCodexSharedRestartPeerError(
  error: unknown,
): error is CodexSharedRestartPeerError {
  return error instanceof CodexSharedRestartPeerError;
}

/**
 * Recovery refused to continue or replay a turn because its persisted outcome
 * is unknown. Repeating the request could run it twice, so no layer may retry
 * it automatically.
 */
export class CodexUnsafeRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexUnsafeRecoveryError';
  }
}

/**
 * Whether a failed recovery must not be retried automatically: it refused an
 * unsafe replay, or a `turn/start` it sent went unanswered (that turn may
 * still be running). Follows a bounded, cycle-safe `Error.cause` chain.
 */
function isUnsafeToRetryRecoveryFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth <= 5 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (
      current instanceof CodexUnsafeRecoveryError ||
      (current instanceof CodexAppServerRequestTimeoutError &&
        current.method === 'turn/start')
    ) {
      return true;
    }
    if (!(current instanceof Error)) return false;
    current = Reflect.get(current, 'cause');
    if (current === undefined) return false;
  }
  return false;
}

/**
 * A bystander of a shared restart whose persisted-thread recovery then failed.
 * It keeps the shared-restart marker so the chat can still retry, unless the
 * recovery refused an unsafe replay.
 */
export class CodexSharedRestartRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSharedRestartRecoveryError';
  }
}

function combineErrors(message: string, errors: unknown[]): Error {
  const error = new Error(message);
  Object.defineProperty(error, 'cause', {
    value: errors[0],
    configurable: true,
  });
  Object.defineProperty(error, 'errors', {
    value: errors,
    configurable: true,
  });
  return error;
}

async function awaitAllTerminations(
  terminations: readonly Promise<void>[],
  message: string,
): Promise<void> {
  const results = await Promise.allSettled(terminations);
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      const reason: unknown = result.reason;
      errors.push(reason);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw combineErrors(message, errors);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readJsonRpcId(
  record: Record<string, unknown>,
  key: string,
): JsonRpcId | undefined {
  const value = record[key];
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : undefined;
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function isFallbackMcpApprovalRequest(
  request: Record<string, unknown>,
): boolean {
  const params = readRecord(request, 'params');
  if (!params) {
    return false;
  }
  return readArray(params, 'questions').some(
    (question) =>
      isRecord(question) &&
      readString(question, 'id')?.startsWith('mcp_tool_call_approval_') ===
        true,
  );
}

function failClosedFallbackMcpApprovalResult(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const params = readRecord(request, 'params');
  const questionIds = params
    ? readArray(params, 'questions')
        .filter(isRecord)
        .map((question) => readString(question, 'id'))
        .filter(
          (id): id is string =>
            id?.startsWith('mcp_tool_call_approval_') === true,
        )
    : [];
  return {
    answers: Object.fromEntries(
      questionIds.map((id) => [id, { answers: ['__codex_mcp_decline__'] }]),
    ),
  };
}

/**
 * Deny-shaped response for each approval-family method, used when no owner
 * session can be resolved (or the owner is cancelling) so an approval
 * request never resolves to an allow by default.
 */
function failClosedApprovalResult(method: string): Record<string, unknown> {
  switch (method) {
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { decision: 'denied' };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    default:
      return { decision: 'decline' };
  }
}

function normalizeJsonValue(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(normalizeJsonValue).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, nested]) =>
        `${JSON.stringify(key)}:${normalizeJsonValue(nested ?? null)}`,
    )
    .join(',')}}`;
}

function appendCapturedStderr(current: string, chunk: string): string {
  if (chunk.length >= MAX_CAPTURED_STDERR_CHARS) {
    return chunk.slice(chunk.length - MAX_CAPTURED_STDERR_CHARS);
  }

  const remainingCurrentChars = MAX_CAPTURED_STDERR_CHARS - chunk.length;
  const currentTail =
    current.length <= remainingCurrentChars
      ? current
      : current.slice(current.length - remainingCurrentChars);

  return `${currentTail}${chunk}`;
}

function reportedStderrTail(stderr: string): {
  text: string;
  truncated: boolean;
} {
  const trimmed = stderr.trimEnd();
  if (trimmed.length <= MAX_REPORTED_STDERR_CHARS) {
    return { text: trimmed, truncated: false };
  }
  return {
    text: trimmed.slice(trimmed.length - MAX_REPORTED_STDERR_CHARS),
    truncated: true,
  };
}

function resolveCodexAppServerSpawnCwd(): string {
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}

function buildProcessFailureMessage(
  stderrTail: string,
  reason: string,
  code?: number | null,
  signal?: NodeJS.Signals | null,
): string {
  const details: string[] = [];
  if (typeof code === 'number') {
    details.push(`exit code ${String(code)}`);
  }
  if (signal) {
    details.push(`signal ${signal}`);
  }

  const header =
    details.length > 0 ? `${reason} (${details.join(', ')})` : reason;
  const stderr = reportedStderrTail(stderrTail);
  if (stderr.text.length === 0) {
    return header;
  }
  const truncationNote = stderr.truncated
    ? ' (older process output omitted)'
    : '';
  return `${header}\nrecent stderr${truncationNote}:\n${stderr.text}`;
}

/** The app-server did not answer a request within its deadline. */
export class CodexAppServerRequestTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(
      `Codex app-server did not respond to ${method} within ${String(
        timeoutMs / 1000,
      )}s`,
    );
    this.name = 'CodexAppServerRequestTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export function isCodexAppServerRequestTimeoutError(
  error: unknown,
): error is CodexAppServerRequestTimeoutError {
  return error instanceof CodexAppServerRequestTimeoutError;
}

function defaultRequestTimeoutMs(
  method: AppServerRequestMethod,
): number | undefined {
  if (method === 'initialize') {
    // Initialization has a dedicated timeout that also terminates the wedged
    // worker. A generic request timeout would win the race without killing it.
    return undefined;
  }
  if (method === 'turn/start') {
    return DEFAULT_CODEX_TURN_START_TIMEOUT_MS;
  }
  if (
    method === 'thread/start' ||
    method === 'thread/resume' ||
    method === 'thread/fork' ||
    method === 'thread/inject_items'
  ) {
    return DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS;
  }
  return DEFAULT_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS;
}

/** Retry only the two known transient Codex state DB startup failures. */
function isRetryableStateDbStartupFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    (normalized.includes('state db backfill') &&
      normalized.includes('timed out waiting')) ||
    normalized.includes('failed to initialize sqlite state runtime')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function waitForProcessExit(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('exit', finish);
      proc.off('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    proc.once('exit', finish);
    proc.once('close', finish);
  });
}

function parseParentThreadIdFromThreadStarted(
  params: Record<string, unknown>,
): string | null {
  const thread = readRecord(params, 'thread');
  if (!thread) {
    return null;
  }
  const sourceValue = thread.source;
  if (!isRecord(sourceValue)) {
    return null;
  }
  const subAgent =
    readRecord(sourceValue, 'subAgent') ?? readRecord(sourceValue, 'subagent');
  if (!subAgent) {
    return null;
  }

  const directParent =
    readString(subAgent, 'parentThreadId') ??
    readString(subAgent, 'parent_thread_id');
  if (directParent) {
    return directParent;
  }

  const threadSpawn =
    readRecord(subAgent, 'thread_spawn') ?? readRecord(subAgent, 'threadSpawn');
  return threadSpawn
    ? (readString(threadSpawn, 'parent_thread_id') ??
        readString(threadSpawn, 'parentThreadId') ??
        null)
    : null;
}

export function buildCodexAppServerPoolKey(opts: {
  profileKey: string;
}): string {
  return `profile:${opts.profileKey}`;
}

export interface CodexAppServerPoolResourceSnapshot {
  poolKey: string;
  poolKeyLabel: string;
  pooled: boolean;
  pid: number | undefined;
  initialized: boolean;
  clientCount: number;
  activeTurnCount: number;
  lastActivityAt: string | undefined;
}

interface CodexAppServerConnectionOptions {
  allowOwnerlessStartup?: boolean;
  includeCanopySecrets?: boolean;
  environmentPolicy?: CodexSpawnEnvironmentPolicy;
  externalAuthTransitionBarrier?: () => Promise<unknown> | null;
  /** Per-owner soft cap: begin snapshot coalescing (tests override). */
  stdoutQueueHighWaterBytes?: number;
  /** Per-owner low water: stop coalescing/resume a hard-limit hold. */
  stdoutQueueLowWaterBytes?: number;
  /** Last-resort per-owner shared-pipe OOM guard, after coalescing. */
  stdoutOwnerHardLimitBytes?: number;
  /** Duration at which an admission hold or stdout pause is reported. */
  longStdoutHoldThresholdMs?: number;
  /**
   * Supplied by the pool: frees a thread's writer held by another of its
   * workers, by stopping that worker when it has no live work.
   */
  releaseThreadWriterElsewhere?: (
    threadId: string,
  ) => Promise<CodexWriterHandoffOutcome>;
}

interface PendingExternalAuthTransition {
  promise: Promise<boolean>;
  resolve: (suspended: boolean) => void;
  reject: (error: Error) => void;
  activeOwners: Set<CodexAppServerConnectionOwner>;
  timeout: ReturnType<typeof setTimeout>;
  terminationStarted: boolean;
}

function poolKeyLabel(poolKey: string): string {
  if (poolKey === 'default') {
    return 'Default pool';
  }
  if (poolKey.startsWith('env:')) {
    return `Env pool ${poolKey.slice(4, 12)}`;
  }
  if (poolKey.startsWith('profile:')) {
    return `Profile ${poolKey.slice(8, 16)}`;
  }
  return 'Dedicated pool';
}

function poolResourceLabel(poolKey: string): string {
  if (poolKey === 'default') {
    return 'Codex app-server';
  }
  if (poolKey.startsWith('env:')) {
    return `Codex app-server (env pool ${poolKey.slice(4, 12)})`;
  }
  if (poolKey.startsWith('profile:')) {
    return `Codex app-server (profile ${poolKey.slice(8, 16)})`;
  }
  return 'Codex app-server (dedicated)';
}

function sharedRestartTrigger(
  ownerError: Error,
): CodexRuntimeSharedRestartDiagnostic['restartTrigger'] {
  switch (ownerError.message) {
    case 'turn_cancelled':
      return 'turn-cancelled';
    case 'session_destroyed':
      return 'session-destroyed';
    case 'turn_start_timeout':
      return 'turn-start-timeout';
    default:
      return 'other';
  }
}

function isThreadMutationMethod(method: string): boolean {
  return (
    method === 'thread/start' ||
    method === 'thread/resume' ||
    method === 'thread/fork'
  );
}

export class CodexAppServerConnection {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdout: Transform | null = null;
  /**
   * Per-owner notification admission over the shared stdout: one owner's
   * pending admission holds only that owner's later frames. See
   * `owner-admission-lanes.ts` and docs/codex-app-server.md.
   */
  private readonly ownerLanes: OwnerAdmissionLanes<CodexAppServerConnectionOwner>;
  private nextId = 1;
  private initialized = false;
  /**
   * The user agent the current process reported to `initialize`. Each
   * initialize replaces it; no notification arrives between an exit and the
   * next initialize.
   */
  private userAgent: string | undefined;
  private initializePromise: Promise<void> | null = null;
  private recoveryQuiescencePromise: Promise<void> | null = null;
  private closing = false;
  private stderrTail = '';
  private processStartedAt: number | null = null;
  private dispatchedTurnCount = 0;
  private pendingProcessFailureError: Error | null = null;
  private finalReleasePromise: Promise<void> | null = null;
  private pendingSharedRestartOwner: CodexAppServerConnectionOwner | null =
    null;
  private pendingSharedRestartOwnerError: Error | null = null;
  private readonly quarantinedOwners = new Map<
    CodexAppServerConnectionOwner,
    QuarantinedOwner
  >();
  private readonly pendingDisposedTurnInterrupts = new Map<
    CodexAppServerConnectionOwner,
    PendingDisposedTurnInterrupt
  >();
  private pendingResponses = new Map<JsonRpcId, PendingResponse>();
  private readonly retainedResponses = new Map<JsonRpcId, PendingResponse>();
  private readonly clients = new Set<CodexAppServerConnectionOwner>();
  private readonly processCallbacks = new Map<
    CodexAppServerConnectionOwner,
    CodexAppServerProcessCallbacks
  >();
  private readonly rootThreadOwners = new Map<
    string,
    CodexAppServerConnectionOwner
  >();
  private readonly threadOwners = new Map<
    string,
    CodexAppServerConnectionOwner
  >();
  private readonly pendingMcpStartupNotifications = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  private readonly disposedThreadTombstones = new Set<string>();
  private readonly loadedRootThreadIds = new Set<string>();
  private threadBudgetRecycleScheduled = false;
  /** `thread/resume` retries waiting for the app-server to close a thread. */
  private readonly threadClosedWaiters = new Map<string, Set<() => void>>();
  /**
   * Threads this worker unsubscribed and no owner has resumed since. Codex
   * keeps them loaded, writer included, until it unloads them or the worker
   * exits.
   */
  private readonly idleRetainedThreads = new Set<string>();
  // Configuration belongs to the worker, independently of its current owner.
  private readonly loadedThreadProviderRoutes = new Map<string, string>();
  private readonly closedProviderRouteThreads = new Set<string>();
  /** Thread request ids that timed out on the current worker, by method. */
  private readonly timedOutThreadRequests = new Map<JsonRpcId, string>();
  private unroutedWarningWindowStartedAt = 0;
  private suppressedUnroutedWarningCount = 0;
  private readonly pendingServerRequestsByOwner = new Map<
    CodexAppServerConnectionOwner,
    Map<JsonRpcId, PendingServerRequest>
  >();
  private readonly pendingServerRequestHandlersByOwner = new Map<
    CodexAppServerConnectionOwner,
    Set<Promise<void>>
  >();
  private readonly mcpToolCalls = new Map<string, CodexMcpToolCallContext>();
  private readonly itemOwners = new Map<
    string,
    CodexAppServerConnectionOwner | null
  >();
  private readonly accountUpdatedListeners = new Map<
    CodexAppServerConnectionOwner,
    Set<(notification: AccountUpdatedNotification) => void>
  >();
  private readonly rateLimitsUpdatedListeners = new Map<
    CodexAppServerConnectionOwner,
    Set<(notification: AccountRateLimitsUpdatedNotification) => void>
  >();
  private resourceHandle: CodexRuntimeResourceRegistrationHandle | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMinutes = DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES;
  private lastActivityAt: string | undefined;
  private readonly processTerminations = new Map<
    ChildProcessWithoutNullStreams,
    Promise<void>
  >();
  private externalAuthTransition: PendingExternalAuthTransition | null = null;

  constructor(
    private readonly poolKey: string,
    private readonly extraEnv?: Record<string, string>,
    private readonly configArgs?: string[],
    private readonly options: CodexAppServerConnectionOptions = {},
  ) {
    this.ownerLanes = new OwnerAdmissionLanes<CodexAppServerConnectionOwner>(
      {
        isLiveOwner: (owner): boolean => this.clients.has(owner),
        pauseSource: (): void => {
          this.stdout?.pause();
        },
        resumeSource: (): void => {
          this.stdout?.resume();
        },
        onSourcePauseChange: (paused): void => {
          this.setRequestDeadlinesSuspended(paused);
        },
        onAdmissionFailure: (error): void => {
          // Lanes are discarded whenever the worker changes, so a live lane
          // always belongs to the current process.
          const proc = this.process;
          this.failAll(error);
          if (proc) this.terminateProcess(proc, 'SIGTERM');
        },
        onDeliveryFailure: (error): void => {
          this.failAll(error);
        },
        reportLongHold: (report): void => {
          this.recordStdoutHold(report);
        },
        warnLongHold: (message): void => {
          // eslint-disable-next-line no-console
          console.warn('[codex-app-server]', message);
        },
        onIngestionLagChange: (owner, change): void => {
          queueMicrotask(() => {
            try {
              const report = owner.handleIngestionLagChange?.(change);
              if (report) void report.catch(() => undefined);
            } catch {
              // Lag reporting is observational and must not interrupt admission.
            }
          });
        },
        onIngestionLagSample: (owner, sample): void => {
          queueMicrotask(() => {
            try {
              const report = owner.handleIngestionLagSample?.(sample);
              if (report) void report.catch(() => undefined);
            } catch {
              // Lag samples are observational and must not interrupt admission.
            }
          });
        },
      },
      {
        highWaterBytes:
          options.stdoutQueueHighWaterBytes ??
          DEFAULT_OWNER_LANE_HIGH_WATER_BYTES,
        lowWaterBytes:
          options.stdoutQueueLowWaterBytes ??
          DEFAULT_OWNER_LANE_LOW_WATER_BYTES,
        perOwnerRetention: {
          hardLimitBytes:
            options.stdoutOwnerHardLimitBytes ??
            DEFAULT_OWNER_LANE_HARD_LIMIT_BYTES,
        },
        longHoldThresholdMs:
          options.longStdoutHoldThresholdMs ??
          DEFAULT_LONG_STDOUT_HOLD_THRESHOLD_MS,
        // The host decides, per delivery, whether an owner may have several
        // admissions pending (the desktop app: while it group-commits).
        ownerInFlight: (): OwnerInFlightBudget | undefined =>
          getCodexRuntimeHostHooks().ownerAdmissionBudget?.(),
      },
    );
  }

  registerOwner(
    owner: CodexAppServerConnectionOwner,
    processCallbacks: CodexAppServerProcessCallbacks,
  ): void {
    this.clients.add(owner);
    this.processCallbacks.set(owner, processCallbacks);
    this.markActivity();
    this.updateResourceRegistration();
    this.tryCompleteExternalAuthTransition();
  }

  ingestionLag(
    owner: CodexAppServerConnectionOwner,
  ): CodexIngestionLagSnapshot | undefined {
    return this.ownerLanes.ingestionLag(owner);
  }

  harnessUserAgent(): string | undefined {
    return this.userAgent;
  }

  clientCount(): number {
    return this.clients.size;
  }

  activeTurnCount(): number {
    return Array.from(this.clients).filter((client) => client.hasActiveTurn())
      .length;
  }

  notifyOwnerTurnSettled(owner: CodexAppServerConnectionOwner): void {
    if (!this.clients.has(owner)) {
      return;
    }
    this.tryCompleteExternalAuthTransition();
  }

  livePid(): number | undefined {
    return this.process?.pid;
  }

  getResourceSnapshot(): CodexAppServerPoolResourceSnapshot {
    return {
      poolKey: this.poolKey,
      poolKeyLabel: poolKeyLabel(this.poolKey),
      pooled: true,
      pid: this.livePid(),
      initialized: this.initialized,
      clientCount: this.clientCount(),
      activeTurnCount: this.activeTurnCount(),
      lastActivityAt: this.lastActivityAt,
    };
  }

  updateIdleTimeoutMinutes(minutes: number): void {
    this.idleTimeoutMinutes = minutes;
    this.scheduleIdleTimer();
  }

  isOnlyOwner(owner: CodexAppServerConnectionOwner): boolean {
    return this.clients.size === 1 && this.clients.has(owner);
  }

  canEvictOwner(owner: CodexAppServerConnectionOwner): boolean {
    return (
      this.isOnlyOwner(owner) &&
      !owner.hasActiveTurn() &&
      !owner.hasLiveBackgroundWork?.() &&
      this.initializePromise === null &&
      this.pendingResponses.size === 0 &&
      !this.pendingSharedRestartOwner &&
      !this.hasPendingServerRequests()
    );
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  recordLoadedThreadProviderRoute(threadId: string, identity: string): void {
    if (
      !this.initialized ||
      !this.process ||
      this.closing ||
      this.closedProviderRouteThreads.has(threadId)
    )
      return;
    this.loadedThreadProviderRoutes.set(threadId, identity);
  }

  loadedThreadProviderRoute(threadId: string): string | undefined {
    return this.loadedThreadProviderRoutes.get(threadId);
  }

  registerRootThread(
    threadId: string,
    owner: CodexAppServerConnectionOwner,
  ): void {
    this.disposedThreadTombstones.delete(threadId);
    this.loadedRootThreadIds.add(threadId);
    this.idleRetainedThreads.delete(threadId);
    this.rootThreadOwners.set(threadId, owner);
    this.threadOwners.set(threadId, owner);
    this.flushPendingMcpStartupNotifications(threadId, owner);
  }

  registerSubagentThread(
    threadId: string,
    owner: CodexAppServerConnectionOwner,
  ): void {
    this.disposedThreadTombstones.delete(threadId);
    this.threadOwners.set(threadId, owner);
    this.flushPendingMcpStartupNotifications(threadId, owner);
  }

  unregisterOwner(owner: CodexAppServerConnectionOwner): void {
    this.clients.delete(owner);
    this.processCallbacks.delete(owner);
    this.accountUpdatedListeners.delete(owner);
    this.rateLimitsUpdatedListeners.delete(owner);
    this.pendingServerRequestsByOwner.delete(owner);
    // Handler promises outlive owner routing when a tab/session is released
    // while host-side work is still settling. Keep them tracked until their
    // finally blocks remove them so process recovery cannot overlap those
    // side effects with a replacement worker.

    if (
      this.quarantinedOwners.has(owner) ||
      this.pendingDisposedTurnInterrupts.has(owner)
    ) {
      // Preserve routing while the disposal interrupt is pending or until a
      // quarantined turn is terminal. Disposing the UI owner must not make a
      // potentially still-running turn invisible.
      this.markActivity();
      this.updateResourceRegistration();
      this.tryCompleteExternalAuthTransition();
      this.ownerLanes.retire(owner);
      return;
    }

    for (const [threadId, mappedOwner] of Array.from(
      this.threadOwners.entries(),
    )) {
      if (mappedOwner === owner) {
        this.disposedThreadTombstones.add(threadId);
        this.threadOwners.delete(threadId);
      }
    }
    for (const [threadId, mappedOwner] of Array.from(
      this.rootThreadOwners.entries(),
    )) {
      if (mappedOwner === owner) {
        this.disposedThreadTombstones.add(threadId);
        this.rootThreadOwners.delete(threadId);
      }
    }
    for (const [itemId, mappedOwner] of Array.from(this.itemOwners.entries())) {
      if (mappedOwner === owner) {
        this.itemOwners.set(itemId, null);
        this.mcpToolCalls.delete(itemId);
      }
    }
    this.markActivity();
    this.updateResourceRegistration();
    this.tryCompleteExternalAuthTransition();
    this.ownerLanes.retire(owner);
    this.scheduleThreadBudgetRecycle();
  }

  unregisterThread(
    threadId: string,
    owner: CodexAppServerConnectionOwner,
  ): void {
    if (this.threadOwners.get(threadId) === owner) {
      this.disposedThreadTombstones.add(threadId);
      this.threadOwners.delete(threadId);
    }
    if (this.rootThreadOwners.get(threadId) === owner) {
      this.disposedThreadTombstones.add(threadId);
      this.rootThreadOwners.delete(threadId);
    }
    this.scheduleThreadBudgetRecycle();
  }

  private scheduleThreadBudgetRecycle(): void {
    if (
      this.threadBudgetRecycleScheduled ||
      this.loadedRootThreadIds.size < CODEX_APP_SERVER_THREAD_LOAD_BUDGET
    ) {
      return;
    }
    this.threadBudgetRecycleScheduled = true;
    // Owner release runs inside disposal paths; suspend afterwards so other
    // owners are not notified re-entrantly.
    setImmediate(() => {
      this.threadBudgetRecycleScheduled = false;
      const proc = this.process;
      if (
        !proc ||
        this.clients.size === 0 ||
        this.loadedRootThreadIds.size < CODEX_APP_SERVER_THREAD_LOAD_BUDGET ||
        this.hasWorkInFlight() ||
        Array.from(this.clients).some(
          (client) => client.hasInFlightOperation?.() === true,
        )
      ) {
        return;
      }
      this.suspendProcess(proc, 'thread-budget');
    }).unref();
  }

  private hasWorkInFlight(): boolean {
    return (
      Array.from(this.clients).some(
        (client) =>
          client.hasActiveTurn() || client.hasLiveBackgroundWork?.() === true,
      ) ||
      this.pendingResponses.size > 0 ||
      this.pendingSharedRestartOwner !== null ||
      this.hasPendingServerRequests()
    );
  }

  unsubscribeThreadBestEffort(threadId: string): void {
    if (!this.initialized) {
      return;
    }

    const proc = this.process;
    const request = this.request('thread/unsubscribe', { threadId });
    void request
      .then((response): void => {
        this.disposedThreadTombstones.delete(threadId);
        if (
          isRecord(response) &&
          response.status === 'unsubscribed' &&
          this.process === proc &&
          !this.threadOwners.has(threadId)
        ) {
          this.idleRetainedThreads.add(threadId);
        }
      })
      .catch(() => {});
  }

  /**
   * Stops this worker if it still holds `threadId` idle and has no live work,
   * so another worker can take the thread's writer. Resolves once the process
   * has exited.
   */
  async releaseIdleThreadWriter(
    threadId: string,
  ): Promise<Exclude<CodexWriterHandoffOutcome, 'no-local-holder'> | null> {
    const proc = this.process;
    if (!proc || !this.idleRetainedThreads.has(threadId)) return null;
    if (
      this.closing ||
      this.pendingSharedRestartOwner ||
      this.quarantinedOwners.size > 0 ||
      this.pendingDisposedTurnInterrupts.size > 0 ||
      this.pendingResponses.size > 0 ||
      this.hasPendingServerRequests() ||
      Array.from(this.clients).some(
        (client) =>
          client.hasActiveTurn() || client.hasLiveBackgroundWork?.() === true,
      )
    ) {
      return 'holder-busy';
    }
    this.suspendProcess(proc, 'writer-handoff');
    await (this.processTerminations.get(proc) ?? Promise.resolve()).catch(
      () => undefined,
    );
    return 'released';
  }

  resolveOwnerForThread(
    threadId: string | undefined,
  ): CodexAppServerConnectionOwner | null {
    if (typeof threadId !== 'string') {
      return null;
    }
    return this.threadOwners.get(threadId) ?? null;
  }

  onAccountUpdated(
    owner: CodexAppServerConnectionOwner,
    listener: (notification: AccountUpdatedNotification) => void,
  ): () => void {
    const listeners = this.accountUpdatedListeners.get(owner) ?? new Set();
    listeners.add(listener);
    this.accountUpdatedListeners.set(owner, listeners);
    return (): void => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.accountUpdatedListeners.delete(owner);
      }
    };
  }

  onRateLimitsUpdated(
    owner: CodexAppServerConnectionOwner,
    listener: (notification: AccountRateLimitsUpdatedNotification) => void,
  ): () => void {
    const listeners = this.rateLimitsUpdatedListeners.get(owner) ?? new Set();
    listeners.add(listener);
    this.rateLimitsUpdatedListeners.set(owner, listeners);
    return (): void => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.rateLimitsUpdatedListeners.delete(owner);
      }
    };
  }

  async ensureInitialized(
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.getExternalAuthTransitionBarrier()) {
      await this.waitForExternalAuthTransition(options.signal);
    }
    const recoveryQuiescencePromise = this.recoveryQuiescencePromise;
    if (recoveryQuiescencePromise) {
      const signal = options.signal;
      if (!signal) {
        await recoveryQuiescencePromise;
      } else {
        if (signal.aborted) {
          throw abortSignalError(signal);
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort);
            reject(abortSignalError(signal));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          void recoveryQuiescencePromise.then(
            () => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            },
            (error: unknown) => {
              signal.removeEventListener('abort', onAbort);
              reject(
                error instanceof Error
                  ? error
                  : new Error(
                      `Codex app-server recovery barrier failed: ${String(error)}`,
                    ),
              );
            },
          );
        });
      }
    }
    if (this.initialized) return;
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    const initializePromise = this.initialize();
    this.initializePromise = initializePromise;
    try {
      await initializePromise;
    } finally {
      if (this.initializePromise === initializePromise) {
        this.initializePromise = null;
      }
    }
  }

  request(
    method: 'marketplace/add',
    params: AppServerRequestParams<'marketplace/add'>,
    opts?: { owner?: CodexAppServerConnectionOwner },
  ): Promise<MarketplaceAddResponse>;
  request(
    method: 'marketplace/upgrade',
    params: AppServerRequestParams<'marketplace/upgrade'>,
    opts?: { owner?: CodexAppServerConnectionOwner },
  ): Promise<MarketplaceUpgradeResponse>;
  request(
    method: 'marketplace/remove',
    params: AppServerRequestParams<'marketplace/remove'>,
    opts?: { owner?: CodexAppServerConnectionOwner },
  ): Promise<MarketplaceRemoveResponse>;
  request(
    method: 'plugin/list',
    params: AppServerRequestParams<'plugin/list'>,
    opts?: { owner?: CodexAppServerConnectionOwner },
  ): Promise<PluginListResponse>;
  request(
    method: 'plugin/read',
    params: AppServerRequestParams<'plugin/read'>,
    opts?: { owner?: CodexAppServerConnectionOwner },
  ): Promise<PluginReadResponse>;
  request(
    method: 'plugin/install',
    params: AppServerRequestParams<'plugin/install'>,
    opts?: { owner?: CodexAppServerConnectionOwner },
  ): Promise<PluginInstallResponse>;
  request(
    method: 'plugin/uninstall',
    params: AppServerRequestParams<'plugin/uninstall'>,
    opts?: { owner?: CodexAppServerConnectionOwner },
  ): Promise<PluginUninstallResponse>;
  request(
    method: 'plugin/installed',
    params: AppServerRequestParams<'plugin/installed'>,
    opts?: { owner?: CodexAppServerConnectionOwner },
  ): Promise<PluginInstalledResponse>;
  request(
    method: 'skills/list',
    params: AppServerRequestParams<'skills/list'>,
    opts?: { owner?: CodexAppServerConnectionOwner },
  ): Promise<SkillsListResponse>;
  request(
    method: 'plugin/skill/read',
    params: AppServerRequestParams<'plugin/skill/read'>,
    opts?: { owner?: CodexAppServerConnectionOwner },
  ): Promise<PluginSkillReadResponse>;
  request<TMethod extends AppServerRequestMethod>(
    method: TMethod,
    params: AppServerRequestParams<TMethod>,
    opts?: {
      owner?: CodexAppServerConnectionOwner;
      timeoutMs?: number;
      rejectOnOwnerFailure?: boolean;
      signal?: AbortSignal;
      softTimeout?: SoftRequestTimeout;
    },
  ): Promise<AppServerRequestResponse<TMethod>>;
  async request<TMethod extends AppServerRequestMethod>(
    method: TMethod,
    params: AppServerRequestParams<TMethod>,
    opts: {
      owner?: CodexAppServerConnectionOwner;
      timeoutMs?: number;
      rejectOnOwnerFailure?: boolean;
      signal?: AbortSignal;
      softTimeout?: SoftRequestTimeout;
    } = {},
  ): Promise<unknown> {
    if (method !== 'thread/resume') {
      return this.requestOnce(method, params, opts);
    }
    return this.resumeAfterThreadClose(
      isRecord(params) ? readString(params, 'threadId') : undefined,
      opts,
      () => this.requestOnce(method, params, opts),
    );
  }

  /**
   * Sends `thread/resume`, retrying while the app-server reports that it is
   * still closing the thread. That rejection precedes any `turn/start`, so the
   * request is repeated unchanged: after a `thread/closed` notification for
   * the thread, or a short backoff, within a bounded budget.
   */
  private async resumeAfterThreadClose(
    threadId: string | undefined,
    opts: { owner?: CodexAppServerConnectionOwner; signal?: AbortSignal },
    send: () => Promise<unknown>,
  ): Promise<unknown> {
    let firstRejectedAt: number | null = null;
    let retryCount = 0;
    let closedNotificationObserved = false;
    const record = (
      closeWaitOutcome: CodexRuntimeThreadCloseWaitDiagnostic['closeWaitOutcome'],
    ): void => {
      if (firstRejectedAt === null) return;
      const pid = this.process?.pid;
      getCodexRuntimeHostHooks().recordDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'codex_app_server_thread_close_wait',
        closeWaitOutcome,
        closeWaitDurationMs: Math.max(0, Date.now() - firstRejectedAt),
        closeWaitRetryCount: retryCount,
        closedNotificationObserved,
        appProcessId: process.pid,
        ...(typeof pid === 'number' ? { codexAppServerProcessId: pid } : {}),
      });
    };

    let writerHandoffAttempted = false;
    while (true) {
      let rejection: unknown;
      try {
        const response = await send();
        record('resumed');
        return response;
      } catch (error) {
        if (
          threadId &&
          !writerHandoffAttempted &&
          isCodexThreadWriterConflictError(error) &&
          this.options.releaseThreadWriterElsewhere &&
          this.canRetryForOwner(opts.owner) &&
          !opts.signal?.aborted
        ) {
          // Another of this pool's workers may still hold the thread after
          // unsubscribing it. Stopping that worker, when it is idle, is the
          // only thing that frees the writer short of Codex's own unload.
          writerHandoffAttempted = true;
          if (
            (await this.handOffThreadWriter(threadId)) === 'released' &&
            this.canRetryForOwner(opts.owner) &&
            !opts.signal?.aborted
          ) {
            continue;
          }
        }
        if (!threadId || !isCodexThreadClosingError(error)) {
          record(opts.signal?.aborted ? 'aborted' : 'failed');
          throw error;
        }
        rejection = error;
      }

      firstRejectedAt ??= Date.now();
      const remainingMs =
        THREAD_CLOSING_RETRY_BUDGET_MS - (Date.now() - firstRejectedAt);
      if (remainingMs <= 0 || !this.canRetryForOwner(opts.owner)) {
        record('exhausted');
        throw rejection;
      }
      const delayMs = Math.min(
        THREAD_CLOSING_RETRY_DELAYS_MS[
          Math.min(retryCount, THREAD_CLOSING_RETRY_DELAYS_MS.length - 1)
        ] ?? remainingMs,
        remainingMs,
      );
      retryCount += 1;
      try {
        if (
          (await this.waitForThreadClosed(threadId, delayMs, opts.signal)) ===
          'closed'
        ) {
          closedNotificationObserved = true;
        }
      } catch (error) {
        record('aborted');
        throw error;
      }
      if (!this.canRetryForOwner(opts.owner)) {
        record('exhausted');
        throw rejection;
      }
    }
  }

  private async handOffThreadWriter(
    threadId: string,
  ): Promise<CodexWriterHandoffOutcome> {
    const startedAt = Date.now();
    let outcome: CodexWriterHandoffOutcome = 'no-local-holder';
    try {
      outcome =
        (await this.options.releaseThreadWriterElsewhere?.(threadId)) ??
        'no-local-holder';
    } finally {
      const pid = this.process?.pid;
      getCodexRuntimeHostHooks().recordDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'codex_app_server_writer_handoff',
        writerHandoffOutcome: outcome,
        writerHandoffDurationMs: Math.max(0, Date.now() - startedAt),
        appProcessId: process.pid,
        ...(typeof pid === 'number' ? { codexAppServerProcessId: pid } : {}),
      });
    }
    return outcome;
  }

  /** A released owner, or a closing connection, must not send again. */
  private canRetryForOwner(
    owner: CodexAppServerConnectionOwner | undefined,
  ): boolean {
    return !this.closing && (owner === undefined || this.clients.has(owner));
  }

  /**
   * Resolves when the app-server reports the thread closed or the delay
   * elapses, whichever is first; rejects if the caller aborts.
   */
  private waitForThreadClosed(
    threadId: string,
    delayMs: number,
    signal: AbortSignal | undefined,
  ): Promise<'closed' | 'elapsed'> {
    if (signal?.aborted) {
      return Promise.reject(abortSignalError(signal));
    }
    return new Promise((resolve, reject) => {
      const waiters =
        this.threadClosedWaiters.get(threadId) ?? new Set<() => void>();
      this.threadClosedWaiters.set(threadId, waiters);
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        waiters.delete(onClosed);
        if (
          waiters.size === 0 &&
          this.threadClosedWaiters.get(threadId) === waiters
        ) {
          this.threadClosedWaiters.delete(threadId);
        }
      };
      const onClosed = (): void => {
        cleanup();
        resolve('closed');
      };
      const onAbort = (): void => {
        cleanup();
        reject(
          signal
            ? abortSignalError(signal)
            : new Error('Codex app-server operation was cancelled'),
        );
      };
      const timer = setTimeout((): void => {
        cleanup();
        resolve('elapsed');
      }, delayMs);
      timer.unref?.();
      waiters.add(onClosed);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async requestOnce<TMethod extends AppServerRequestMethod>(
    method: TMethod,
    params: AppServerRequestParams<TMethod>,
    opts: {
      owner?: CodexAppServerConnectionOwner;
      timeoutMs?: number;
      rejectOnOwnerFailure?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    if (opts.signal?.aborted) {
      throw abortSignalError(opts.signal);
    }
    const isCleanup =
      method === 'turn/interrupt' || method === 'thread/unsubscribe';
    const canDrain = (): boolean =>
      method === 'initialize' ||
      isCleanup ||
      (opts.owner !== undefined &&
        this.externalAuthTransition?.activeOwners.has(opts.owner) === true);
    // Cleanup for a retired process must not resurrect it or wait behind the
    // sign-in that is waiting for this very owner to finish disposing.
    if (
      isCleanup &&
      this.getExternalAuthTransitionBarrier() &&
      !this.initialized
    )
      return {};
    while (true) {
      if (!canDrain() && this.getExternalAuthTransitionBarrier()) {
        await this.waitForExternalAuthTransition(opts.signal);
      }
      if (method !== 'initialize' && !this.initialized) {
        await this.ensureInitialized({ signal: opts.signal });
      }
      // Admission may have changed while initialization or recovery awaited.
      // Recheck at the actual send boundary, without another async gap.
      if (canDrain() || !this.getExternalAuthTransitionBarrier()) break;
    }
    if (opts.signal?.aborted) {
      throw abortSignalError(opts.signal);
    }
    return this.sendRequest(method, params, opts);
  }

  rejectAllPendingRequests(error: Error): void {
    for (const pending of Array.from(this.pendingResponses.values())) {
      pending.reject(error);
    }
    this.pendingResponses.clear();
    this.settleAllRetainedResponses(error);
  }

  private sendRequest<TMethod extends AppServerRequestMethod>(
    method: TMethod,
    params: AppServerRequestParams<TMethod>,
    opts: {
      owner?: CodexAppServerConnectionOwner;
      timeoutMs?: number;
      rejectOnOwnerFailure?: boolean;
      softTimeout?: SoftRequestTimeout;
    },
  ): Promise<unknown> {
    this.markActivity();
    this.updateResourceRegistration();
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = opts.timeoutMs ?? defaultRequestTimeoutMs(method);
    return new Promise((resolve, reject) => {
      const pending: PendingResponse = {
        resolve: (value: unknown): void => {
          pending.deadline?.cancel();
          resolve(value);
        },
        reject: (error: Error): void => {
          pending.deadline?.cancel();
          reject(error);
        },
        method,
        owner: opts.owner,
        rejectOnOwnerFailure: opts.rejectOnOwnerFailure !== false,
        responseReceived: false,
        deadline: null,
        timeoutMs,
        softTimeout: opts.softTimeout,
        retainedTimer: null,
      };
      if (method === 'thread/resume' && isRecord(params)) {
        const resumeThreadId = readString(params, 'threadId');
        if (resumeThreadId) pending.resumeThreadId = resumeThreadId;
      }
      this.pendingResponses.set(id, pending);
      try {
        this.send({ id, method, params });
        if (method === 'turn/start') {
          this.dispatchedTurnCount += 1;
        }
        if (
          timeoutMs !== undefined &&
          this.pendingResponses.get(id) === pending
        ) {
          // The deadline measures app-server responsiveness: it is cancelled
          // as soon as the response frame is read, independent of transcript
          // admission, and suspended during a last-resort hard-limit pause.
          const deadline = new RequestDeadline(timeoutMs, (): void => {
            if (this.pendingResponses.get(id) !== pending) {
              return;
            }
            if (isThreadMutationMethod(method)) {
              this.rememberTimedOutThreadRequest(id, method);
            }
            this.retainTimedOutResponse(
              id,
              pending,
              new CodexAppServerRequestTimeoutError(method, timeoutMs),
            );
            this.recordRequestTimeout(method, timeoutMs, opts.owner);
          });
          pending.deadline = deadline;
          deadline.start(this.ownerLanes.isSourcePaused());
        }
      } catch (error) {
        this.pendingResponses.delete(id);
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  private retainTimedOutResponse(
    id: JsonRpcId,
    pending: PendingResponse,
    error: CodexAppServerRequestTimeoutError,
  ): void {
    if (this.pendingResponses.get(id) !== pending) return;
    this.pendingResponses.delete(id);
    pending.reject(error);
    if (!pending.softTimeout) return;

    while (this.retainedResponses.size >= MAX_RETAINED_RESPONSES) {
      const oldest = this.retainedResponses.entries().next().value;
      if (!oldest) break;
      const [oldestId, oldestPending] = oldest;
      this.settleRetainedResponse(oldestId, oldestPending, {
        kind: 'error',
        error: new CodexAppServerRequestTimeoutError(
          oldestPending.method,
          oldestPending.timeoutMs ?? 0,
        ),
      });
    }

    this.retainedResponses.set(id, pending);
    const timer = setTimeout(() => {
      this.settleRetainedResponse(id, pending, {
        kind: 'error',
        error: new CodexAppServerRequestTimeoutError(
          pending.method,
          pending.timeoutMs ?? 0,
        ),
      });
    }, RETAINED_RESPONSE_TIMEOUT_MS);
    pending.retainedTimer = timer;
    timer.unref?.();
  }

  private settleRetainedResponse(
    id: JsonRpcId,
    pending: PendingResponse,
    outcome: CodexAppServerLateResponse,
  ): void {
    if (this.retainedResponses.get(id) !== pending) return;
    this.retainedResponses.delete(id);
    if (pending.retainedTimer !== null) {
      clearTimeout(pending.retainedTimer);
      pending.retainedTimer = null;
    }
    try {
      pending.softTimeout?.onLateResponse(outcome);
    } catch {
      // A consumer callback must not break response routing for other owners.
    }
  }

  private settleAllRetainedResponses(error: Error): void {
    for (const [id, pending] of Array.from(this.retainedResponses.entries())) {
      this.settleRetainedResponse(id, pending, { kind: 'error', error });
    }
  }

  private setRequestDeadlinesSuspended(suspended: boolean): void {
    for (const pending of Array.from(this.pendingResponses.values())) {
      if (suspended) {
        pending.deadline?.suspend();
      } else {
        pending.deadline?.resume();
      }
    }
  }

  private rememberTimedOutThreadRequest(id: JsonRpcId, method: string): void {
    this.timedOutThreadRequests.set(id, method);
    if (this.timedOutThreadRequests.size > MAX_TIMED_OUT_THREAD_REQUESTS) {
      const oldest = this.timedOutThreadRequests.keys().next().value;
      if (oldest !== undefined) this.timedOutThreadRequests.delete(oldest);
    }
  }

  private recordRequestTimeout(
    method: string,
    timeoutMs: number,
    owner: CodexAppServerConnectionOwner | undefined,
  ): void {
    const pid = this.process?.pid;
    const processUptimeMs = this.getProcessUptimeMs();
    getCodexRuntimeHostHooks().recordDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'codex_app_server_request_timeout',
      requestMethod: method,
      requestTimeoutMs: timeoutMs,
      ...(processUptimeMs !== null ? { processUptimeMs } : {}),
      busyPeerCount: this.busyPeers(owner).length,
      pendingRequestCount: this.pendingResponses.size,
      stdoutPaused: this.ownerLanes.isSourcePaused(),
      appProcessId: process.pid,
      ...(typeof pid === 'number' ? { codexAppServerProcessId: pid } : {}),
    });
  }

  /**
   * A thread request answered after its caller gave up. A thread created by a
   * late `thread/start` or `thread/fork` was never returned to anyone, so it
   * is deleted. A late `thread/resume` leaves this connection subscribed to a
   * thread no owner routes, so it is unsubscribed unless an owner has resumed
   * the thread since.
   */
  private reapLateThreadResponse(
    responseId: JsonRpcId,
    response: Record<string, unknown>,
  ): void {
    const method = this.timedOutThreadRequests.get(responseId);
    if (method === undefined) return;
    this.timedOutThreadRequests.delete(responseId);
    if (readRecord(response, 'error')) return;
    const result = readRecord(response, 'result');
    const thread = result ? readRecord(result, 'thread') : null;
    const threadId = thread ? readString(thread, 'id') : undefined;
    if (!threadId || this.threadOwners.has(threadId)) return;
    // A newer resume of the same thread will claim this subscription;
    // unsubscribing now would drop that resume's notifications.
    if (
      Array.from(this.pendingResponses.values()).some(
        (pending) => pending.resumeThreadId === threadId,
      )
    ) {
      return;
    }

    // Its notifications must not fall through to the sole-owner fallback.
    this.disposedThreadTombstones.add(threadId);
    if (method === 'thread/resume') {
      this.unsubscribeThreadBestEffort(threadId);
      return;
    }
    void this.request(
      'thread/delete',
      { threadId },
      { timeoutMs: LATE_THREAD_CLEANUP_TIMEOUT_MS },
    ).catch((): void => {
      this.unsubscribeThreadBestEffort(threadId);
    });
  }

  /**
   * Replaces a worker that stopped answering `owner`'s thread request, but
   * only when no other owner has live work on it: a turn, an in-flight
   * request, or a pending server request. Returns whether the worker was
   * stopped; the next request starts a fresh one.
   */
  recycleUnresponsiveProcess(owner: CodexAppServerConnectionOwner): boolean {
    const proc = this.process;
    if (
      !proc ||
      this.closing ||
      this.pendingSharedRestartOwner ||
      this.quarantinedOwners.size > 0 ||
      this.pendingDisposedTurnInterrupts.size > 0 ||
      this.hasPendingServerRequests() ||
      this.busyPeers(owner).length > 0
    ) {
      return false;
    }
    const recycleError = new Error(UNRESPONSIVE_PROCESS_RECYCLE_ERROR);
    for (const pending of Array.from(this.pendingResponses.values())) {
      pending.reject(recycleError);
    }
    this.pendingResponses.clear();
    this.suspendProcess(proc, 'unresponsive-thread-request');
    return true;
  }

  /**
   * Calls `onExpire` once `ms` pass without the frame `owner` awaits from the
   * app-server. While stdout is paused at the retained-frame cap, or frames
   * already read for `owner` wait in its lane, that frame may be among them:
   * the deadline is extended, by at most
   * {@link MAX_BACKLOG_DEADLINE_EXTENSION_MS} in total. Returns a cancel.
   */
  scheduleBacklogAwareDeadline(
    owner: CodexAppServerConnectionOwner,
    ms: number,
    onExpire: () => void,
  ): () => void {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (delay: number): void => {
      timer = setTimeout(check, delay);
      timer.unref?.();
    };
    const check = (): void => {
      timer = null;
      const extendedMs = Date.now() - startedAt - ms;
      if (
        (this.ownerLanes.isSourcePaused() ||
          this.ownerLanes.hasQueuedFrames(owner)) &&
        extendedMs < MAX_BACKLOG_DEADLINE_EXTENSION_MS
      ) {
        arm(Math.min(ms, MAX_BACKLOG_DEADLINE_EXTENSION_MS - extendedMs));
        return;
      }
      onExpire();
    };
    arm(ms);
    return (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
  }

  private recordStdoutHold(report: StdoutHoldReport): void {
    const pid = this.process?.pid;
    getCodexRuntimeHostHooks().recordDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'codex_app_server_stdout_hold',
      ...report,
      appProcessId: process.pid,
      ...(typeof pid === 'number' ? { codexAppServerProcessId: pid } : {}),
    });
  }

  private async initialize(): Promise<void> {
    let retryCount = 0;
    while (true) {
      if (!this.shouldContinueStartupRetryLoop()) {
        throw new Error('Codex app-server startup cancelled');
      }
      try {
        await this.waitForPendingProcessTerminations();
        if (this.getExternalAuthTransitionBarrier())
          await this.waitForExternalAuthTransition();
        if (!this.shouldContinueStartupRetryLoop())
          throw new Error('Codex app-server startup cancelled');
        this.startProcess();
        await this.requestInitializeWithTimeout();
        const notification: ClientNotification = { method: 'initialized' };
        this.send(notification);
        this.initialized = true;
        this.markActivity();
        this.updateResourceRegistration();
        return;
      } catch (error) {
        if (
          !this.shouldRetryStateDbStartupFailure(error, retryCount) ||
          !this.shouldContinueStartupRetryLoop()
        ) {
          throw error;
        }
        retryCount += 1;
        await delay(STARTUP_STATE_DB_RETRY_DELAY_MS);
        if (!this.shouldContinueStartupRetryLoop()) {
          throw error;
        }
      }
    }
  }

  /**
   * The `initialize` handshake is the one request that can hang indefinitely
   * when the app-server process comes up but wedges before serving JSON-RPC —
   * typically because the shared Codex state DB is locked by an orphaned
   * app-server from a previous app run or is mid-recovery. Without a bound,
   * the first Codex chat turn after such a restart spins forever with no
   * error and no process-exit diagnostic. Bound it, kill the wedged process,
   * and surface a retryable failure instead.
   */
  private async requestInitializeWithTimeout(): Promise<void> {
    const proc = this.process;
    const initializeRequest = this.request('initialize', {
      clientInfo: getCodexRuntimeHostHooks().clientInfo(),
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    // The exit handler rejects the pending request after the timeout kill;
    // the race below has already settled by then, so swallow that rejection.
    void initializeRequest.catch(() => {});

    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = this.buildProcessFailureError(
          `Codex app-server did not respond to initialize within ${String(
            INITIALIZE_REQUEST_TIMEOUT_MS / 1000,
          )}s (its state database may be locked or recovering). The process was terminated; please retry.`,
        );
        if (proc && this.process === proc) {
          this.terminateProcess(proc, 'SIGTERM');
        }
        reject(error);
      }, INITIALIZE_REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });

    try {
      const response = await Promise.race([initializeRequest, timeout]);
      this.userAgent = isRecord(response)
        ? readString(response, 'userAgent')
        : undefined;
      if (this.poolKey.startsWith('profile:')) {
        try {
          const codexHome = isRecord(response)
            ? readString(response, 'codexHome')
            : undefined;
          if (!codexHome)
            throw new Error('Codex initialize reply omitted codexHome');
          observeCanonicalCodexHome(codexHome);
        } catch (error) {
          if (proc && this.process === proc) {
            this.terminateProcess(proc, 'SIGTERM');
          }
          throw error;
        }
      }
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  send(payload: Record<string, unknown>): void {
    if (!this.process) {
      throw new Error('Codex app-server is not running');
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  completePendingServerRequest(
    owner: CodexAppServerConnectionOwner,
    requestId: JsonRpcId,
  ): boolean {
    const requests = this.pendingServerRequestsByOwner.get(owner);
    if (!requests) {
      return false;
    }
    const deleted = requests.delete(requestId);
    if (requests.size === 0) {
      this.pendingServerRequestsByOwner.delete(owner);
    }
    this.markActivity();
    this.updateResourceRegistration();
    return deleted;
  }

  flushPendingServerRequestsForOwner(
    owner: CodexAppServerConnectionOwner,
    shouldSendReplies: boolean,
  ): void {
    const requests = this.pendingServerRequestsByOwner.get(owner);
    if (!requests) {
      return;
    }

    if (shouldSendReplies) {
      for (const [requestId, pending] of Array.from(requests.entries())) {
        try {
          if (pending.kind === 'requestUserInput') {
            this.send({
              id: requestId,
              error: {
                code: -32000,
                message: `${getCodexRuntimeHostHooks().productDisplayName()} session destroyed before request_user_input could be answered`,
              },
            });
          } else if (pending.kind === 'approval') {
            this.send({
              id: requestId,
              result: pending.failClosedResult,
            });
          } else if (pending.kind === 'dynamicToolCall') {
            this.send({
              id: requestId,
              result: {
                contentItems: [
                  {
                    type: 'inputText',
                    text: `${getCodexRuntimeHostHooks().productDisplayName()} session destroyed before dynamic tool call could complete`,
                  },
                ],
                success: false,
              },
            });
          } else {
            const result: McpServerElicitationRequestResponse = {
              action: 'decline',
              content: null,
              _meta: null,
            };
            this.send({ id: requestId, result });
          }
        } catch {
          // Best effort: local tracking still must be cleared below.
        }
      }
    }

    this.pendingServerRequestsByOwner.delete(owner);
  }

  rejectPendingRequestsForOwner(
    owner: CodexAppServerConnectionOwner,
    error: Error,
  ): void {
    for (const [id, pending] of Array.from(this.pendingResponses.entries())) {
      if (pending.owner === owner && pending.rejectOnOwnerFailure) {
        pending.reject(error);
        this.pendingResponses.delete(id);
      }
    }
    for (const [id, pending] of Array.from(this.retainedResponses.entries())) {
      if (pending.owner === owner && pending.rejectOnOwnerFailure) {
        this.settleRetainedResponse(id, pending, { kind: 'error', error });
      }
    }
  }

  suspendIdleProcessIfIdle(
    trigger: 'idle-timeout' | 'critical-pressure' = 'idle-timeout',
  ): boolean {
    const proc = this.process;
    if (!proc) {
      return false;
    }
    if (this.hasWorkInFlight()) {
      return false;
    }
    const processUptimeMs = this.getProcessUptimeMs();
    if (
      trigger === 'critical-pressure' &&
      processUptimeMs !== null &&
      processUptimeMs < CODEX_APP_SERVER_MIN_LIFETIME_BEFORE_PRESSURE_SUSPEND_MS
    ) {
      this.recordPressureSuspendSkipped('minimum-process-lifetime', {
        processUptimeMs,
        retryAfterMs:
          CODEX_APP_SERVER_MIN_LIFETIME_BEFORE_PRESSURE_SUSPEND_MS -
          processUptimeMs,
      });
      return false;
    }

    this.suspendProcess(proc, trigger);
    return true;
  }

  getDispatchedTurnCount(): number {
    return this.dispatchedTurnCount;
  }

  /**
   * Returns whether a diagnostic was actually recorded. Callers that dedupe
   * (the pressure backoff stamps `reportedBackoffStep`) must only mark a step
   * reported when this returns `true` - on the tick right after a suspension
   * `this.process` is normally `null`, so stamping unconditionally would burn
   * the step on a record that was never written and hide the skip if an
   * app-server respawns later in the same backoff window.
   */
  recordPressureSuspendSkipped(
    skippedReason: 'minimum-process-lifetime' | 'pressure-backoff',
    details: { processUptimeMs?: number; retryAfterMs?: number } = {},
  ): boolean {
    const proc = this.process;
    if (!proc) {
      return false;
    }
    getCodexRuntimeHostHooks().recordDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'resource_codex_app_server_suspend_skipped',
      trigger: 'critical-pressure',
      skippedReason,
      appProcessId: process.pid,
      ...(typeof proc.pid === 'number'
        ? { codexAppServerProcessId: proc.pid }
        : {}),
      ...details,
    });
    return true;
  }

  private getProcessUptimeMs(): number | null {
    return this.processStartedAt === null
      ? null
      : Math.max(0, Date.now() - this.processStartedAt);
  }

  /**
   * Drop process-local provider state after an external `codex login` flow.
   * Unlike memory-pressure suspension, stale administrative reads are
   * deliberately rejected so they cannot keep the old account alive or race a
   * fresh account probe. Active turns owned outside the interactive session
   * manager (for example a pipeline worker) may finish, but the connection is
   * marked stale immediately and cannot accept another request before it is
   * retired.
   */
  suspendProcessForExternalAuthChange(): Promise<boolean> {
    if (this.externalAuthTransition) {
      return this.externalAuthTransition.promise;
    }

    let resolveTransition: ((suspended: boolean) => void) | undefined;
    let rejectTransition: ((error: Error) => void) | undefined;
    const promise = new Promise<boolean>((resolve, reject) => {
      resolveTransition = resolve;
      rejectTransition = reject;
    });
    if (!resolveTransition || !rejectTransition) {
      throw new Error('Failed to create Codex external auth transition');
    }
    this.externalAuthTransition = {
      promise,
      resolve: resolveTransition,
      reject: rejectTransition,
      activeOwners: new Set(
        Array.from(this.clients).filter((client) =>
          this.ownerHasDispatchedTurn(client),
        ),
      ),
      timeout: setTimeout(
        () => this.expireExternalAuthTransition(),
        EXTERNAL_AUTH_TRANSITION_TIMEOUT_MS,
      ),
      terminationStarted: false,
    };
    this.externalAuthTransition.timeout.unref?.();
    this.tryCompleteExternalAuthTransition();
    return promise;
  }

  private tryCompleteExternalAuthTransition(): void {
    const transition = this.externalAuthTransition;
    if (!transition || transition.terminationStarted) {
      return;
    }
    for (const owner of Array.from(transition.activeOwners)) {
      if (!this.clients.has(owner) || !this.ownerHasDispatchedTurn(owner)) {
        transition.activeOwners.delete(owner);
      }
    }
    const proc = this.process;
    if (!proc) {
      this.clearExternalAuthTransition(transition);
      transition.resolve(false);
      return;
    }
    if (transition.activeOwners.size > 0) {
      return;
    }

    transition.terminationStarted = true;
    clearTimeout(transition.timeout);
    const error = new Error(
      'Codex authentication credentials refreshed while an administrative request was in progress; retry the request.',
    );
    this.rejectAllPendingRequests(error);
    this.pendingServerRequestsByOwner.clear();
    this.suspendProcess(proc, 'external-auth-change');
    void this.beginProcessTermination(proc).then(
      () => {
        this.clearExternalAuthTransition(transition);
        transition.resolve(true);
      },
      (terminationError: unknown) => {
        this.clearExternalAuthTransition(transition);
        transition.reject(
          terminationError instanceof Error
            ? terminationError
            : new Error(String(terminationError)),
        );
      },
    );
  }

  private ownerHasDispatchedTurn(
    owner: CodexAppServerConnectionOwner,
  ): boolean {
    return owner.hasDispatchedTurn?.() ?? owner.hasActiveTurn();
  }

  private expireExternalAuthTransition(): void {
    const transition = this.externalAuthTransition;
    if (!transition || transition.terminationStarted) {
      return;
    }
    transition.terminationStarted = true;
    clearTimeout(transition.timeout);
    const error = new Error(
      'Timed out waiting for active Codex turns to finish before refreshing authentication credentials; retry the request.',
    );
    this.rejectAllPendingRequests(error);
    this.pendingServerRequestsByOwner.clear();
    for (const client of Array.from(this.clients)) {
      client.rejectActiveTurn(error);
      client.markProcessFailed();
    }
    const proc = this.process;
    if (!proc) {
      this.clearExternalAuthTransition(transition);
      transition.reject(error);
      return;
    }
    this.suspendProcess(proc, 'external-auth-change');
    void this.beginProcessTermination(proc).then(
      () => {
        this.clearExternalAuthTransition(transition);
        transition.reject(error);
      },
      (terminationError: unknown) => {
        this.clearExternalAuthTransition(transition);
        const combinedError = new Error(
          `${error.message} Stale Codex app-server termination also failed.`,
        );
        Object.defineProperty(combinedError, 'cause', {
          value: terminationError,
          configurable: true,
          writable: true,
          enumerable: false,
        });
        transition.reject(combinedError);
      },
    );
  }

  private clearExternalAuthTransition(
    transition: PendingExternalAuthTransition,
  ): void {
    clearTimeout(transition.timeout);
    if (this.externalAuthTransition === transition) {
      this.externalAuthTransition = null;
    }
  }

  private async waitForExternalAuthTransition(
    signal?: AbortSignal,
  ): Promise<void> {
    while (true) {
      const barrier = this.getExternalAuthTransitionBarrier();
      if (!barrier) {
        return;
      }
      if (!signal) {
        await barrier;
      } else {
        if (signal.aborted) {
          throw abortSignalError(signal);
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort);
            reject(abortSignalError(signal));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          void barrier.then(
            () => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            },
            (error: unknown) => {
              signal.removeEventListener('abort', onAbort);
              reject(
                error instanceof Error
                  ? error
                  : new Error(
                      `Codex external auth transition failed: ${String(error)}`,
                    ),
              );
            },
          );
        });
      }
      const nextBarrier = this.getExternalAuthTransitionBarrier();
      if (!nextBarrier || nextBarrier === barrier) {
        return;
      }
    }
  }

  private getExternalAuthTransitionBarrier(): Promise<unknown> | null {
    return (
      this.options.externalAuthTransitionBarrier?.() ??
      this.externalAuthTransition?.promise ??
      null
    );
  }

  private suspendProcess(
    proc: ChildProcessWithoutNullStreams,
    trigger:
      | 'idle-timeout'
      | 'critical-pressure'
      | 'external-auth-change'
      | 'unresponsive-thread-request'
      | 'writer-handoff'
      | 'thread-budget',
  ): void {
    this.clearIdleTimer();
    this.settleAllRetainedResponses(
      new CodexRecoverableProcessExitError(
        this.buildProcessFailureError(
          'Codex app-server exited',
          proc.exitCode,
          proc.signalCode,
        ).message,
      ),
    );
    this.timedOutThreadRequests.clear();
    this.idleRetainedThreads.clear();
    // Frames retained for held owners belong to the worker being suspended;
    // like the unread pipe bytes they replace, they are dropped with it.
    this.ownerLanes.discardAll();
    this.loadedThreadProviderRoutes.clear();
    this.closedProviderRouteThreads.clear();
    this.process = null;
    this.stdout?.destroy();
    this.stdout = null;
    this.initialized = false;
    this.initializePromise = null;
    this.stderrTail = '';
    this.pendingProcessFailureError = null;
    this.pendingSharedRestartOwner = null;
    this.pendingSharedRestartOwnerError = null;
    this.updateResourceRegistration();
    for (const client of Array.from(this.clients)) {
      client.markProcessSuspended();
    }
    this.terminateProcess(proc, 'SIGTERM');
    this.recordProcessStopped(proc, trigger);
  }

  private recordProcessStopped(
    proc: ChildProcessWithoutNullStreams,
    trigger: CodexRuntimeStoppedDiagnostic['trigger'],
  ): void {
    getCodexRuntimeHostHooks().recordDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'resource_codex_app_server_stopped',
      trigger,
      appProcessId: process.pid,
      ...(typeof proc.pid === 'number'
        ? { codexAppServerProcessId: proc.pid }
        : {}),
      stoppedCodexAppServerCount: 1,
    });
  }

  disposeOwnerActiveTurn(
    owner: CodexAppServerConnectionOwner,
    target: { threadId: string; turnId: string },
  ): void {
    const ownerError = new Error('session_destroyed');
    const pending: PendingDisposedTurnInterrupt = {
      ...target,
      cancelTerminalDeadline: null,
    };
    this.pendingDisposedTurnInterrupts.set(owner, pending);

    const request = this.request(
      'turn/interrupt',
      {
        threadId: target.threadId,
        turnId: target.turnId,
      },
      {
        owner,
        timeoutMs: INTERRUPT_REQUEST_TIMEOUT_MS,
        rejectOnOwnerFailure: false,
      },
    );

    void request
      .then((): void => {
        if (this.pendingDisposedTurnInterrupts.get(owner) !== pending) {
          return;
        }
        // Codex acknowledges turn/interrupt before emitting turn/completed.
        // Retain routing until that terminal notification arrives so it cannot
        // fall through to a surviving pooled owner. Bound the retained state in
        // case the server never emits the terminal event.
        pending.cancelTerminalDeadline = this.scheduleBacklogAwareDeadline(
          owner,
          DISPOSED_TURN_TERMINAL_GRACE_MS,
          (): void => {
            this.completePendingDisposedTurn(owner, pending);
          },
        );
      })
      .catch((): void => {
        if (this.pendingDisposedTurnInterrupts.get(owner) === pending) {
          this.pendingDisposedTurnInterrupts.delete(owner);
        }
        // The shared process is the only enforceable execution boundary. Once
        // a bounded interrupt fails, stop it immediately even if a peer is
        // active so the disposed dangerFullAccess turn cannot keep running.
        this.triggerSharedRestart(owner, ownerError, target, true);
      });
  }

  private completePendingDisposedTurn(
    owner: CodexAppServerConnectionOwner,
    pending: PendingDisposedTurnInterrupt,
  ): void {
    if (this.pendingDisposedTurnInterrupts.get(owner) !== pending) {
      return;
    }
    pending.cancelTerminalDeadline?.();
    this.pendingDisposedTurnInterrupts.delete(owner);
    if (this.quarantinedOwners.has(owner)) {
      // Quarantine still needs the thread route to observe the matching
      // terminal notification. Its own completion path performs cleanup.
      this.markActivity();
      this.updateResourceRegistration();
      return;
    }
    this.clearOwnerRouting(owner);
    this.unsubscribeThreadBestEffort(pending.threadId);
    this.markActivity();
    this.updateResourceRegistration();
    this.tryCompleteExternalAuthTransition();
  }

  async interruptTurn(
    owner: CodexAppServerConnectionOwner,
    target: { threadId: string; turnId: string },
  ): Promise<void> {
    const attemptTimeoutMs = INTERRUPT_REQUEST_TIMEOUT_MS / 2;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.request(
          'turn/interrupt',
          {
            threadId: target.threadId,
            turnId: target.turnId,
          },
          { owner, timeoutMs: attemptTimeoutMs },
        );
        return;
      } catch {
        // Retry once before falling back to owner-scoped or shared recovery.
      }
    }
    // A pooled process cannot revoke just one owner's native execution. After
    // both bounded turn/interrupt attempts fail, terminate the shared process
    // immediately rather than leaving a dangerFullAccess turn quarantined.
    this.triggerSharedRestart(owner, new Error('turn_cancelled'), target, true);
  }

  triggerSharedRestart(
    owner: CodexAppServerConnectionOwner,
    ownerError: Error,
    recoveryTarget?: { threadId: string; turnId: string | null },
    force = false,
  ): void {
    owner.cancelPendingTurnStart(ownerError);
    if (this.pendingSharedRestartOwner) {
      return;
    }

    if (!force && this.hasBusyPeer(owner)) {
      // A pooled app-server is shared infrastructure. Restarting it to recover
      // one owner's failed interrupt must never terminate another owner's live
      // turn or in-flight request. Fail and reset only the requesting owner;
      // its normal session lifecycle can dispose or recreate that client while
      // peers continue using the existing process.
      this.flushPendingServerRequestsForOwner(owner, true);
      const existingQuarantine = this.quarantinedOwners.get(owner);
      if (existingQuarantine) {
        if (!existingQuarantine.turnId && recoveryTarget?.turnId) {
          existingQuarantine.threadId = recoveryTarget.threadId;
          existingQuarantine.turnId = recoveryTarget.turnId;
        }
        this.scheduleQuarantinedTurnRecovery(owner, existingQuarantine);
        this.markActivity();
        this.updateResourceRegistration();
        return;
      }

      const target = recoveryTarget ?? owner.getActiveTurnInterruptTarget();
      if (target) {
        // The process cannot be killed without disrupting the busy peer. Keep
        // this turn quarantined and routed until Codex reports it terminal.
        // A turn/start response can still be pending here, so preserve the
        // owner's request until its turn ID is available for interruption.
        const quarantine = {
          error: ownerError,
          threadId: target.threadId,
          turnId: target.turnId,
          retryTimer: null,
          cancelDeadline: null,
        };
        this.quarantinedOwners.set(owner, quarantine);
        this.scheduleQuarantinedTurnDeadline(owner, quarantine);
        this.scheduleQuarantinedTurnRecovery(owner, quarantine);
      } else {
        this.rejectPendingRequestsForOwner(owner, ownerError);
        owner.rejectActiveTurn(ownerError);
        owner.markProcessFailed();
        this.clearOwnerRouting(owner);
      }
      this.markActivity();
      this.updateResourceRegistration();
      return;
    }

    if (recoveryTarget) {
      this.clearOwnerRouting(owner);
    }

    this.pendingSharedRestartOwner = owner;
    this.pendingSharedRestartOwnerError = ownerError;
    const proc = this.process;
    if (!proc) {
      this.failAllForSharedRestart(owner, ownerError);
      return;
    }

    this.terminateProcess(proc, 'SIGTERM');

    setTimeout(() => {
      if (this.pendingSharedRestartOwner !== owner) {
        return;
      }

      if (this.process === proc) {
        this.failAllForSharedRestart(owner, ownerError);
      }

      try {
        if (this.isProcessAlive(proc)) {
          this.terminateProcess(proc, 'SIGKILL');
        }
      } catch {
        // Best effort after the connection state has already been torn down.
      }
    }, INTERRUPT_PROCESS_GRACE_MS);
  }

  private hasBusyPeer(owner: CodexAppServerConnectionOwner): boolean {
    return this.busyPeers(owner).length > 0;
  }

  /**
   * Other owners with live work on this worker: an active turn, an in-flight
   * request, or a pending server request. An owner whose own turn is being
   * cancelled is not protected.
   */
  private busyPeers(
    owner: CodexAppServerConnectionOwner | undefined,
  ): CodexAppServerConnectionOwner[] {
    const busy = new Set<CodexAppServerConnectionOwner>();
    const protect = (
      candidate: CodexAppServerConnectionOwner | undefined,
    ): void => {
      if (
        candidate !== undefined &&
        candidate !== owner &&
        !this.isOwnerCancelling(candidate)
      ) {
        busy.add(candidate);
      }
    };
    for (const client of Array.from(this.clients)) {
      if (client.hasActiveTurn() || client.hasLiveBackgroundWork?.() === true) {
        protect(client);
      }
    }
    for (const pending of Array.from(this.pendingResponses.values())) {
      protect(pending.owner);
    }
    for (const [client, requests] of Array.from(
      this.pendingServerRequestsByOwner.entries(),
    )) {
      if (requests.size > 0) protect(client);
    }
    return Array.from(busy);
  }

  private scheduleQuarantinedTurnRecovery(
    owner: CodexAppServerConnectionOwner,
    quarantine: QuarantinedOwner,
  ): void {
    if (
      this.quarantinedOwners.get(owner) !== quarantine ||
      quarantine.retryTimer !== null
    ) {
      return;
    }

    quarantine.retryTimer = setTimeout((): void => {
      quarantine.retryTimer = null;
      void this.recoverQuarantinedTurn(owner, quarantine);
    }, QUARANTINED_INTERRUPT_RETRY_DELAY_MS);
    quarantine.retryTimer.unref?.();
  }

  private scheduleQuarantinedTurnDeadline(
    owner: CodexAppServerConnectionOwner,
    quarantine: QuarantinedOwner,
  ): void {
    if (
      this.quarantinedOwners.get(owner) !== quarantine ||
      quarantine.cancelDeadline !== null
    ) {
      return;
    }

    // The interrupt acknowledgement or terminal frame may wait in a stdout
    // backlog. A paused stdout also stalls the quarantined turn's own output,
    // so waiting for it (boundedly) does not leave the turn running freely.
    quarantine.cancelDeadline = this.scheduleBacklogAwareDeadline(
      owner,
      QUARANTINED_INTERRUPT_DEADLINE_MS,
      (): void => {
        quarantine.cancelDeadline = null;
        if (this.quarantinedOwners.get(owner) !== quarantine) {
          return;
        }
        if (quarantine.retryTimer !== null) {
          clearTimeout(quarantine.retryTimer);
          quarantine.retryTimer = null;
        }
        this.quarantinedOwners.delete(owner);
        // A failed interrupt must not leave a dangerFullAccess turn running
        // indefinitely. Once the deadline expires, process-level recovery
        // takes precedence over preserving a busy peer on the shared
        // app-server.
        this.triggerSharedRestart(owner, quarantine.error, undefined, true);
      },
    );
  }

  private async recoverQuarantinedTurn(
    owner: CodexAppServerConnectionOwner,
    quarantine: QuarantinedOwner,
  ): Promise<void> {
    if (this.quarantinedOwners.get(owner) !== quarantine) {
      return;
    }

    if (!this.hasBusyPeer(owner)) {
      this.triggerSharedRestart(owner, quarantine.error);
      return;
    }

    if (!quarantine.turnId) {
      const target = owner.getActiveTurnInterruptTarget();
      if (target?.turnId) {
        quarantine.threadId = target.threadId;
        quarantine.turnId = target.turnId;
      } else {
        this.scheduleQuarantinedTurnRecovery(owner, quarantine);
        return;
      }
    }

    try {
      await this.request(
        'turn/interrupt',
        {
          threadId: quarantine.threadId,
          turnId: quarantine.turnId,
        },
        { owner, timeoutMs: INTERRUPT_REQUEST_TIMEOUT_MS / 2 },
      );
    } catch {
      // Keep retrying while a peer prevents process-level recovery.
    }

    this.scheduleQuarantinedTurnRecovery(owner, quarantine);
  }

  private isOwnerCancelling(owner: CodexAppServerConnectionOwner): boolean {
    return (
      this.quarantinedOwners.has(owner) ||
      this.pendingDisposedTurnInterrupts.has(owner)
    );
  }

  private clearQuarantinedOwners(): void {
    for (const quarantine of Array.from(this.quarantinedOwners.values())) {
      if (quarantine.retryTimer !== null) {
        clearTimeout(quarantine.retryTimer);
      }
      quarantine.cancelDeadline?.();
    }
    this.quarantinedOwners.clear();
  }

  private clearPendingDisposedTurnInterrupts(): void {
    for (const pending of Array.from(
      this.pendingDisposedTurnInterrupts.values(),
    )) {
      pending.cancelTerminalDeadline?.();
    }
    this.pendingDisposedTurnInterrupts.clear();
  }

  private clearOwnerRouting(owner: CodexAppServerConnectionOwner): void {
    for (const [threadId, mappedOwner] of Array.from(
      this.threadOwners.entries(),
    )) {
      if (mappedOwner === owner) {
        this.disposedThreadTombstones.add(threadId);
        this.threadOwners.delete(threadId);
      }
    }
    for (const [threadId, mappedOwner] of Array.from(
      this.rootThreadOwners.entries(),
    )) {
      if (mappedOwner === owner) {
        this.disposedThreadTombstones.add(threadId);
        this.rootThreadOwners.delete(threadId);
      }
    }
    for (const [itemId, mappedOwner] of Array.from(this.itemOwners.entries())) {
      if (mappedOwner === owner) {
        this.itemOwners.set(itemId, null);
        this.mcpToolCalls.delete(itemId);
      }
    }
  }

  terminateForFinalRelease(
    trigger: 'final-owner-release' | 'runtime-shutdown' = 'final-owner-release',
  ): Promise<void> {
    if (this.finalReleasePromise) {
      return this.finalReleasePromise;
    }
    this.closing = true;
    const releaseError = new Error(
      'Codex app-server connection closed after its final owner was released',
    );
    this.rejectAllPendingRequests(releaseError);
    for (const client of Array.from(this.clients)) {
      client.rejectActiveTurn(releaseError);
    }
    this.pendingServerRequestsByOwner.clear();
    const proc = this.process;
    this.loadedThreadProviderRoutes.clear();
    this.closedProviderRouteThreads.clear();
    this.process = null;
    this.clearIdleTimer();
    this.unregisterResource();
    this.detachStdoutAdmission();
    this.stdout?.destroy();
    this.stdout = null;
    this.initialized = false;
    this.initializePromise = null;
    this.pendingSharedRestartOwner = null;
    this.pendingSharedRestartOwnerError = null;
    this.clearQuarantinedOwners();
    this.clearPendingDisposedTurnInterrupts();
    const externalAuthTransition = this.externalAuthTransition;
    const adoptsExternalAuthTransition =
      externalAuthTransition !== null &&
      !externalAuthTransition.terminationStarted;
    if (externalAuthTransition && adoptsExternalAuthTransition) {
      externalAuthTransition.terminationStarted = true;
      clearTimeout(externalAuthTransition.timeout);
    }
    const terminations = Array.from(this.processTerminations.values());
    if (proc) {
      this.recordProcessStopped(proc, trigger);
      terminations.push(this.beginProcessTermination(proc));
    }
    this.finalReleasePromise = awaitAllTerminations(
      terminations,
      'Codex app-server connection cleanup encountered multiple failures',
    );
    if (externalAuthTransition && adoptsExternalAuthTransition) {
      void this.finalReleasePromise.then(
        () => {
          this.clearExternalAuthTransition(externalAuthTransition);
          externalAuthTransition.resolve(false);
        },
        (error: unknown) => {
          this.clearExternalAuthTransition(externalAuthTransition);
          externalAuthTransition.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
    }
    return this.finalReleasePromise;
  }

  private markActivity(): void {
    this.lastActivityAt = new Date().toISOString();
    this.scheduleIdleTimer();
  }

  private buildResourceMetadata(): ResourceMetadata {
    return {
      type: 'codex-pool',
      codexPool: {
        poolKeyLabel: poolKeyLabel(this.poolKey),
        pooled: true,
        clientCount: this.clientCount(),
        activeTurnCount: this.activeTurnCount(),
        initialized: this.initialized,
      },
    };
  }

  private updateResourceRegistration(): void {
    this.resourceHandle?.update({
      pid: this.livePid(),
      metadata: this.buildResourceMetadata(),
    });
  }

  private unregisterResource(): void {
    this.resourceHandle?.unregister();
    this.resourceHandle = null;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.process) {
      return;
    }
    const timeoutMs = Math.max(1, this.idleTimeoutMinutes) * 60_000;
    this.idleTimer = setTimeout((): void => {
      if (!this.suspendIdleProcessIfIdle()) {
        this.idleTimer = setTimeout((): void => {
          this.scheduleIdleTimer();
        }, 60_000);
        this.idleTimer.unref();
      }
    }, timeoutMs);
    this.idleTimer.unref();
  }

  private startProcess(): void {
    if (this.process) return;
    this.ownerLanes.discardAll();
    this.closing = false;
    this.pendingSharedRestartOwner = null;
    this.pendingSharedRestartOwnerError = null;
    this.pendingProcessFailureError = null;
    this.stderrTail = '';
    this.processStartedAt = Date.now();

    const proc = spawn(
      getBundledCodexBinaryPath(),
      [
        'app-server',
        // Canopy lists plugins itself; skip the startup catalog prefetch.
        '-c',
        'features.plugin_discovery_prefetch=false',
        ...(this.configArgs ?? []),
      ],
      {
        cwd: resolveCodexAppServerSpawnCwd(),
        env:
          this.options.environmentPolicy === 'restricted'
            ? { ...this.extraEnv }
            : {
                ...getEnhancedEnv({
                  environment: false,
                  ...(this.options.includeCanopySecrets === false
                    ? { includeCanopySecrets: false }
                    : {}),
                }),
                ...this.extraEnv,
              },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: hostOperatingSystem() !== 'win32',
        windowsHide: true,
      },
    );
    this.process = proc;
    this.loadedRootThreadIds.clear();
    getCodexRuntimeHostHooks().registerProcessOwner(proc);
    if (typeof proc.pid === 'number') {
      for (const callbacks of Array.from(this.processCallbacks.values())) {
        callbacks.onProcessStarted?.(proc.pid);
      }
      if (this.resourceHandle) {
        this.resourceHandle.update({
          pid: proc.pid,
          startedAt: new Date().toISOString(),
          metadata: this.buildResourceMetadata(),
        });
      } else {
        this.resourceHandle = getCodexRuntimeHostHooks().registerProcess({
          id: `codex-app-server-pool:${this.poolKey}`,
          groupId: 'codex',
          kind: 'codex-app-server-pool',
          label: poolResourceLabel(this.poolKey),
          pid: proc.pid,
          startedAt: new Date().toISOString(),
          metadata: this.buildResourceMetadata(),
        });
      }
    }
    this.markActivity();
    this.updateResourceRegistration();
    this.scheduleIdleTimer();

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: unknown) => {
      const rawText = String(chunk);
      this.stderrTail = appendCapturedStderr(this.stderrTail, rawText);
      const text = rawText.trim();
      if (!text) return;
      // eslint-disable-next-line no-console
      console.warn('[codex-app-server]', text);
    });
    const handleProcessError = (error: Error, transport = 'process'): void => {
      getCodexRuntimeHostHooks().unregisterProcessOwner(proc);
      if (this.process !== proc) {
        return;
      }
      this.unregisterResource();
      const code: unknown = Reflect.get(error, 'code');
      const message =
        transport === 'stdin'
          ? `Codex app-server stdin failed${typeof code === 'string' ? ` (${code})` : ''}: ${error.message}`
          : error.message;
      for (const callbacks of Array.from(this.processCallbacks.values())) {
        callbacks.onProcessError?.({
          error: message,
          stderrTail: this.stderrTail.trimEnd(),
        });
      }
      if (this.pendingSharedRestartOwner) {
        this.failAllForSharedRestart(
          this.pendingSharedRestartOwner,
          this.pendingSharedRestartOwnerError ?? new Error('turn_cancelled'),
        );
        this.terminateProcess(proc, 'SIGTERM');
        return;
      }
      const processFailureError = this.buildProcessFailureError(message);
      if (error instanceof Error) {
        Object.defineProperty(processFailureError, 'cause', {
          value: error,
          configurable: true,
          writable: true,
          enumerable: false,
        });
      }
      this.failAll(processFailureError);
      this.terminateProcess(proc, 'SIGTERM');
    };
    proc.on('error', (error) => handleProcessError(error));
    // ChildProcess 'error' does not cover Writable errors. Retain this
    // listener on old pipes as well: late errors must not escape after restart.
    proc.stdin.on('error', (error) => handleProcessError(error, 'stdin'));
    proc.on('exit', (code, signal) => {
      getCodexRuntimeHostHooks().unregisterProcessOwner(proc);
      if (this.process !== proc) {
        return;
      }
      this.unregisterResource();
      if (this.closing) return;
      if (this.pendingSharedRestartOwner) {
        this.notifyProcessExit(
          proc,
          code,
          signal,
          this.hasRecoverableSharedRestartPeer(this.pendingSharedRestartOwner),
        );
        const processExitError = this.buildProcessFailureError(
          'Codex app-server exited',
          code,
          signal,
        );
        this.settleAllRetainedResponses(
          new CodexRecoverableProcessExitError(processExitError.message),
        );
        this.failAllForSharedRestart(
          this.pendingSharedRestartOwner,
          this.pendingSharedRestartOwnerError ?? new Error('turn_cancelled'),
        );
        return;
      }
      if (
        !this.initialized &&
        this.initializePromise &&
        isRetryableStateDbStartupFailure(this.stderrTail)
      ) {
        this.notifyProcessExit(proc, code, signal, false);
        this.resetAfterRetryableStartupExit(code, signal);
        return;
      }
      const outputStreamClosed = this.pendingProcessFailureError !== null;
      const processFailureError =
        this.pendingProcessFailureError ??
        this.buildProcessFailureError('Codex app-server exited', code, signal);
      this.pendingProcessFailureError = null;
      const recoveryScheduled = this.shouldRecoverUnexpectedExit(
        code,
        signal,
        outputStreamClosed,
      );
      this.notifyProcessExit(proc, code, signal, recoveryScheduled);
      if (recoveryScheduled) {
        this.recoverAfterUnexpectedExit(processFailureError);
        return;
      }
      this.settleAllRetainedResponses(
        new CodexRecoverableProcessExitError(processFailureError.message),
      );
      this.failAll(processFailureError);
    });
    proc.stdout.on('close', () => {
      if (this.process !== proc || this.closing) {
        return;
      }
      if (this.pendingSharedRestartOwner) {
        this.failAllForSharedRestart(
          this.pendingSharedRestartOwner,
          this.pendingSharedRestartOwnerError ?? new Error('turn_cancelled'),
        );
        return;
      }
      const processFailureError = this.buildProcessFailureError(
        'Codex app-server output stream closed',
      );
      this.pendingProcessFailureError = processFailureError;
      this.terminateProcess(proc, 'SIGTERM');
    });

    const stdout = createJsonLineStream(proc.stdout);
    this.stdout = stdout;
    stdout.on('error', (error) => {
      handleProcessError(error, 'stdout');
    });
    stdout.on('data', (line: string) => {
      if (this.process !== proc || this.stdout !== stdout) return;
      if (!line.trim()) return;
      try {
        this.handleLine(line);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Reads and routes one frame in pipe order. Connection-level routing state
   * (thread and item owners, request bookkeeping) is updated here, before any
   * later frame is read. Delivery to an owner goes through that owner's
   * admission lane, so one owner's pending admission never delays another.
   */
  private handleLine(line: string): void {
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(line);
    } catch {
      return;
    }

    if (!isRecord(parsedValue)) {
      return;
    }

    const parsed = parsedValue;
    const id = readJsonRpcId(parsed, 'id');
    const method = readString(parsed, 'method');

    if (typeof id !== 'undefined' && !method) {
      this.handleResponse(parsed);
      return;
    }

    if (typeof id !== 'undefined' && typeof method === 'string') {
      this.routeServerRequest(id, method, parsed);
      return;
    }

    if (typeof method === 'string') {
      this.handleNotification(method, parsed, line);
    }
  }

  private routeServerRequest(
    requestId: JsonRpcId,
    method: string,
    request: Record<string, unknown>,
  ): void {
    // Server requests can await user approval or tool work, including RPCs
    // whose responses arrive on this same shared stream. Track their failures
    // independently; never hold an owner lane on that callback.
    const handle = (): void => {
      void this.handleServerRequest(requestId, method, request).catch(
        (error: unknown) =>
          this.failAll(
            error instanceof Error ? error : new Error(String(error)),
          ),
      );
    };
    handle();
  }

  private handleResponse(response: Record<string, unknown>): void {
    const responseId = readJsonRpcId(response, 'id');
    if (typeof responseId === 'undefined') {
      return;
    }

    const pending = this.pendingResponses.get(responseId);
    if (!pending) {
      const retained = this.retainedResponses.get(responseId);
      if (!retained) {
        this.reapLateThreadResponse(responseId, response);
        return;
      }
      const error = readRecord(response, 'error');
      const owner = retained.owner;
      if (owner && !error && isThreadMutationMethod(retained.method)) {
        const result = readRecord(response, 'result');
        const thread = result ? readRecord(result, 'thread') : undefined;
        const threadId = thread ? readString(thread, 'id') : undefined;
        if (threadId) this.registerRootThread(threadId, owner);
      }
      retained.responseReceived = true;
      this.settleRetainedResponse(
        responseId,
        retained,
        error
          ? {
              kind: 'error',
              error: new Error(
                readString(error, 'message') ?? 'JSON-RPC error',
              ),
            }
          : { kind: 'success', value: response.result },
      );
      this.clearOrphanedMcpStartupNotifications();
      return;
    }
    if (pending.responseReceived) return;
    // The app-server has answered. Admission to the owner is Canopy-side work
    // and must not count against the request's responsiveness deadline.
    pending.responseReceived = true;
    pending.deadline?.cancel();

    if (
      !readRecord(response, 'error') &&
      (pending.method === 'thread/start' || pending.method === 'thread/resume')
    ) {
      const result = readRecord(response, 'result');
      const thread = result ? readRecord(result, 'thread') : undefined;
      const threadId = thread ? readString(thread, 'id') : undefined;
      if (threadId) this.closedProviderRouteThreads.delete(threadId);
    }
    const owner = pending.owner;
    if (
      owner &&
      !readRecord(response, 'error') &&
      isThreadMutationMethod(pending.method)
    ) {
      const result = readRecord(response, 'result');
      const thread = result ? readRecord(result, 'thread') : undefined;
      const threadId = thread ? readString(thread, 'id') : undefined;
      if (threadId) {
        // Thread-scoped notifications can be emitted in the same stdout batch
        // as the mutating response. Route them as soon as the response is
        // read, before resolving the promise; the durable thread handle replaces this
        // provisional owner.
        this.registerRootThread(threadId, owner);
      }
    }
    this.deliverResponse(responseId, pending, response);
    this.clearOrphanedMcpStartupNotifications();
  }

  private deliverResponse(
    responseId: JsonRpcId,
    pending: PendingResponse,
    response: Record<string, unknown>,
  ): void {
    // Thread registration callbacks may have cancelled or rejected this RPC.
    if (this.pendingResponses.get(responseId) !== pending) return;
    this.pendingResponses.delete(responseId);

    const error = readRecord(response, 'error');
    if (error) {
      const code = error.code;
      pending.reject(
        new CodexAppServerJsonRpcError(
          pending.method,
          readString(error, 'message') ?? 'JSON-RPC error',
          typeof code === 'number' ? code : undefined,
          error.data,
        ),
      );
      this.clearOrphanedMcpStartupNotifications();
      return;
    }
    pending.resolve(response.result);
    this.clearOrphanedMcpStartupNotifications();
  }

  private async handleServerRequest(
    requestId: JsonRpcId,
    method: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    switch (method) {
      case 'item/tool/requestUserInput': {
        await this.routeRequestUserInput(requestId, request);
        return;
      }
      case 'item/tool/call': {
        await this.routeDynamicToolCall(requestId, request);
        return;
      }
      case 'mcpServer/elicitation/request': {
        await this.routeMcpElicitation(requestId, request);
        return;
      }
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval':
      case 'applyPatchApproval':
      case 'execCommandApproval': {
        await this.routeApprovalRequest(requestId, method, request);
        return;
      }
      case 'currentTime/read': {
        const result: CurrentTimeReadResponse = {
          currentTimeAt: Math.floor(Date.now() / 1000),
        };
        this.send({ id: requestId, result });
        return;
      }
      default:
        this.send({
          id: requestId,
          error: {
            code: -32601,
            message: `Unsupported server request: ${method}`,
          },
        });
    }
  }

  private async routeRequestUserInput(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
  ): Promise<void> {
    const params = readRecord(request, 'params');
    const threadId = params ? readString(params, 'threadId') : undefined;
    const itemId = params ? readString(params, 'itemId') : undefined;
    const owner = this.resolveOwnerForThread(threadId);
    if (!owner || typeof threadId !== 'string') {
      this.trackItemOwner(itemId, null);
      this.send({
        id: requestId,
        error: {
          code: -32000,
          message: `No ${getCodexRuntimeHostHooks().productDisplayName()} session is registered for request_user_input thread ${threadId ?? ''}.`,
        },
      });
      return;
    }

    if (this.isOwnerCancelling(owner)) {
      this.trackItemOwner(itemId, null);
      this.send({
        id: requestId,
        error: {
          code: -32000,
          message: `${getCodexRuntimeHostHooks().productDisplayName()} session is cancelling and cannot answer request_user_input`,
        },
      });
      return;
    }

    this.trackItemOwner(itemId, owner);
    if (isFallbackMcpApprovalRequest(request)) {
      const pending: PendingApprovalServerRequest = {
        kind: 'approval',
        method: 'item/tool/requestUserInput',
        failClosedResult: failClosedFallbackMcpApprovalResult(request),
        threadId,
        controller: new AbortController(),
      };
      this.trackPendingServerRequest(owner, requestId, pending);
      // The fallback approval looks up its MCP item, like a file change.
      await this.trackPendingServerRequestHandler(
        owner,
        this.afterOwnerTranscript(owner, requestId, pending, () =>
          owner.handleApprovalRequest(
            requestId,
            'item/tool/requestUserInput',
            request,
            pending.controller.signal,
          ),
        ),
      );
      return;
    }
    const pending: PendingUserInputServerRequest = {
      kind: 'requestUserInput',
      threadId,
      controller: new AbortController(),
    };
    this.trackPendingServerRequest(owner, requestId, pending);
    await this.trackPendingServerRequestHandler(
      owner,
      owner.handleRequestUserInput(
        requestId,
        request,
        pending.controller.signal,
      ),
    );
  }

  /**
   * Routes an approval-shaped server request (`item/commandExecution/
   * requestApproval`, `item/fileChange/requestApproval`,
   * `item/permissions/requestApproval`, legacy `execCommandApproval` /
   * `applyPatchApproval`, and `mcpServer/elicitation/request`) to the owning
   * session's approval handle. Unlike `routeRequestUserInput`, a missing or
   * cancelling owner does not error-reply with `-32000` — it fails closed
   * with the method's deny-shaped response so an approval request can never
   * silently hang or resolve to an allow.
   */
  private async routeApprovalRequest(
    requestId: JsonRpcId,
    method: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    const params = readRecord(request, 'params');
    // Legacy `execCommandApproval` / `applyPatchApproval` params carry the
    // thread under `conversationId` rather than `threadId`; `extractApproval
    // ThreadId` falls back to it so legacy routing actually reaches an owner
    // instead of always failing closed for those two methods.
    const threadId = extractApprovalThreadId(params);
    const owner = this.resolveOwnerForThread(threadId);
    if (
      !owner ||
      typeof threadId !== 'string' ||
      this.isOwnerCancelling(owner)
    ) {
      this.send({ id: requestId, result: failClosedApprovalResult(method) });
      return;
    }

    const pending: PendingApprovalServerRequest = {
      kind: 'approval',
      method,
      failClosedResult: failClosedApprovalResult(method),
      threadId,
      controller: new AbortController(),
    };
    this.trackPendingServerRequest(owner, requestId, pending);
    // A file-change approval names its item, whose changed paths arrive on
    // that item's frames.
    await this.trackPendingServerRequestHandler(
      owner,
      method === 'item/fileChange/requestApproval'
        ? this.afterOwnerTranscript(owner, requestId, pending, () =>
            owner.handleApprovalRequest(
              requestId,
              method,
              request,
              pending.controller.signal,
            ),
          )
        : owner.handleApprovalRequest(
            requestId,
            method,
            request,
            pending.controller.signal,
          ),
    );
  }

  /**
   * Runs `decide` once the transcript read before this request is admitted.
   * For approvals that look up their item, whose frames may still be waiting
   * for admission when the request is read. If the worker goes away first,
   * the worker-loss path answers or drops the request.
   */
  private afterOwnerTranscript(
    owner: CodexAppServerConnectionOwner,
    requestId: JsonRpcId,
    pending: PendingPromptServerRequest,
    decide: () => Promise<void>,
  ): Promise<void> {
    const transcript = this.ownerLanes.whenDrained(owner);
    if (!transcript) {
      return this.isPendingServerRequest(owner, requestId, pending)
        ? decide()
        : Promise.resolve();
    }
    return transcript.then(
      () =>
        this.clients.has(owner) &&
        this.isPendingServerRequest(owner, requestId, pending)
          ? decide()
          : undefined,
      () => undefined,
    );
  }

  private async routeDynamicToolCall(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
  ): Promise<void> {
    const params = readRecord(request, 'params');
    const threadId = params ? readString(params, 'threadId') : undefined;
    const callId = params ? readString(params, 'callId') : undefined;
    const owner = this.resolveOwnerForThread(threadId);
    if (!owner) {
      this.trackItemOwner(callId, null);
      this.send({
        id: requestId,
        result: {
          contentItems: [
            {
              type: 'inputText',
              text: `No ${getCodexRuntimeHostHooks().productDisplayName()} session is registered for dynamic tool call thread ${threadId ?? ''}.`,
            },
          ],
          success: false,
        },
      });
      return;
    }

    if (this.isOwnerCancelling(owner)) {
      this.trackItemOwner(callId, null);
      this.send({
        id: requestId,
        result: {
          contentItems: [
            {
              type: 'inputText',
              text: `${getCodexRuntimeHostHooks().productDisplayName()} session is cancelling and cannot run dynamic tools`,
            },
          ],
          success: false,
        },
      });
      return;
    }

    this.trackItemOwner(callId, owner);
    this.trackPendingServerRequest(owner, requestId, {
      kind: 'dynamicToolCall',
    });
    await this.trackPendingServerRequestHandler(
      owner,
      owner.handleDynamicToolCall(requestId, request),
    );
  }

  private async routeMcpElicitation(
    requestId: JsonRpcId,
    request: Record<string, unknown>,
  ): Promise<void> {
    const params = readRecord(request, 'params');
    const metadata = params ? readRecord(params, '_meta') : null;
    const threadId = params ? readString(params, 'threadId') : undefined;
    const turnId = params ? readString(params, 'turnId') : undefined;
    const serverName = params ? readString(params, 'serverName') : undefined;
    const approvalKind = metadata
      ? readString(metadata, 'codex_approval_kind')
      : undefined;
    const callId = metadata
      ? readString(metadata, 'codex_mcp_tool_call_id')
      : undefined;
    const suppliedCallId =
      metadata !== null &&
      Object.prototype.hasOwnProperty.call(metadata, 'codex_mcp_tool_call_id');
    const toolName = metadata ? readString(metadata, 'tool_name') : undefined;
    const suppliedToolName =
      metadata !== null &&
      Object.prototype.hasOwnProperty.call(metadata, 'tool_name');
    const suppliedArguments =
      metadata !== null &&
      Object.prototype.hasOwnProperty.call(metadata, 'tool_params');
    const argumentsValue = metadata?.tool_params;
    const normalizedArguments = isJsonValue(argumentsValue)
      ? normalizeJsonValue(argumentsValue)
      : undefined;
    const owner = this.resolveOwnerForThread(threadId);

    if (approvalKind !== 'mcp_tool_call') {
      // A genuine MCP elicitation from the tool itself, not a
      // Canopy-synthesized tool-call approval prompt. Forward it to the
      // owner's approval dispatcher — same owner-resolution / pending-
      // tracking / fail-closed-decline-when-no-owner pattern
      // `routeApprovalRequest` uses, and deliberately no timeout race, since
      // approval prompts (including the ask-user bridge this can trigger)
      // never time out by default. The owner's `handleMcpElicitationRequest`
      // bridges `form` mode to the ask-user UI and declines `url` /
      // `openai/form` modes.
      if (
        !owner ||
        typeof threadId !== 'string' ||
        this.isOwnerCancelling(owner)
      ) {
        const result: McpServerElicitationRequestResponse = {
          action: 'decline',
          content: null,
          _meta: null,
        };
        this.send({ id: requestId, result });
        return;
      }
      const pending: PendingMcpElicitationServerRequest = {
        kind: 'mcpElicitation',
        threadId,
        controller: new AbortController(),
      };
      this.trackPendingServerRequest(owner, requestId, pending);
      await this.trackPendingServerRequestHandler(
        owner,
        owner.handleApprovalRequest(
          requestId,
          'mcpServer/elicitation/request',
          request,
          pending.controller.signal,
        ),
      );
      return;
    }

    // Current Codex builds omit the call ID and tool name from synthesized
    // approvals. Bind that form only to one still-active item in the exact
    // thread, turn, server and arguments; never guess across concurrent calls.
    const candidates =
      !suppliedCallId && threadId && turnId && normalizedArguments !== undefined
        ? Array.from(this.mcpToolCalls.values()).filter(
            (call) =>
              call.threadId === threadId &&
              call.turnId === turnId &&
              call.serverName === serverName &&
              call.normalizedArguments === normalizedArguments &&
              (!toolName || call.toolName === toolName) &&
              this.itemOwners.get(call.id) === owner,
          )
        : [];
    const toolCall = suppliedCallId
      ? callId
        ? this.mcpToolCalls.get(callId)
        : undefined
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (
      !owner ||
      this.isOwnerCancelling(owner) ||
      typeof threadId !== 'string' ||
      !serverName ||
      (suppliedToolName && !toolName) ||
      !toolCall ||
      this.itemOwners.get(toolCall.id) !== owner ||
      toolCall.threadId !== threadId ||
      (turnId !== undefined && toolCall.turnId !== turnId) ||
      toolCall.serverName !== serverName ||
      (toolName !== undefined && toolCall.toolName !== toolName) ||
      (suppliedArguments &&
        (normalizedArguments === undefined ||
          toolCall.normalizedArguments !== normalizedArguments))
    ) {
      const result: McpServerElicitationRequestResponse = {
        action: 'decline',
        content: null,
        _meta: null,
      };
      this.send({ id: requestId, result });
      return;
    }

    const pending: PendingMcpElicitationServerRequest = {
      kind: 'mcpElicitation',
      threadId,
      controller: new AbortController(),
    };
    this.trackPendingServerRequest(owner, requestId, pending);
    // Interactive approval prompts are user-paced. Owner/session disposal
    // remains responsible for declining and closing them; a fixed connection
    // timeout would detach a still-visible prompt from its provider request.
    await this.trackPendingServerRequestHandler(
      owner,
      owner.handleMcpElicitation(
        requestId,
        request,
        toolCall,
        approvalKind,
        pending.controller.signal,
      ),
    );
  }

  private trackItemOwner(
    itemId: string | undefined,
    owner: CodexAppServerConnectionOwner | null,
  ): void {
    if (!itemId) {
      return;
    }
    this.itemOwners.set(itemId, owner);
  }

  private trackPendingServerRequest(
    owner: CodexAppServerConnectionOwner,
    requestId: JsonRpcId,
    pending: PendingServerRequest,
  ): void {
    const requests =
      this.pendingServerRequestsByOwner.get(owner) ??
      new Map<JsonRpcId, PendingServerRequest>();
    requests.set(requestId, pending);
    this.pendingServerRequestsByOwner.set(owner, requests);
    this.markActivity();
    this.updateResourceRegistration();
  }

  private isPendingServerRequest(
    owner: CodexAppServerConnectionOwner,
    requestId: JsonRpcId,
    pending: PendingServerRequest,
  ): boolean {
    return (
      this.pendingServerRequestsByOwner.get(owner)?.get(requestId) === pending
    );
  }

  private cancelResolvedPromptRequest(params: Record<string, unknown>): void {
    const threadId = readString(params, 'threadId');
    const requestId = readJsonRpcId(params, 'requestId');
    if (typeof threadId !== 'string' || typeof requestId === 'undefined') {
      return;
    }

    const owner = this.resolveOwnerForThread(threadId);
    if (!owner) return;
    const requests = this.pendingServerRequestsByOwner.get(owner);
    const pending = requests?.get(requestId);
    if (
      !requests ||
      !pending ||
      !('controller' in pending) ||
      pending.threadId !== threadId
    ) {
      return;
    }

    if (!requests.delete(requestId)) return;
    if (requests.size === 0) {
      this.pendingServerRequestsByOwner.delete(owner);
    }
    pending.controller.abort();
    this.markActivity();
    this.updateResourceRegistration();
  }

  private async trackPendingServerRequestHandler(
    owner: CodexAppServerConnectionOwner,
    handler: Promise<void>,
  ): Promise<void> {
    const handlers =
      this.pendingServerRequestHandlersByOwner.get(owner) ??
      new Set<Promise<void>>();
    handlers.add(handler);
    this.pendingServerRequestHandlersByOwner.set(owner, handlers);
    try {
      await handler;
    } finally {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.pendingServerRequestHandlersByOwner.delete(owner);
      }
    }
  }

  private waitForPendingServerRequestHandlers(): {
    settlement: Promise<void>;
    withinRecoveryDeadline: Promise<boolean>;
  } {
    const handlers = Array.from(
      this.pendingServerRequestHandlersByOwner.values(),
    ).flatMap((ownerHandlers) => Array.from(ownerHandlers));
    const settlement = Promise.allSettled(handlers).then(() => undefined);
    if (handlers.length === 0) {
      return {
        settlement,
        withinRecoveryDeadline: Promise.resolve(true),
      };
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const withinRecoveryDeadline = Promise.race([
      settlement.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          CODEX_PROCESS_RECOVERY_HANDLER_QUIESCENCE_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    });
    return { settlement, withinRecoveryDeadline };
  }

  private reportUnroutedUnknownNotification(method: string): void {
    if (
      Object.prototype.hasOwnProperty.call(
        CODEX_LIFECYCLE.notificationMethods,
        method,
      )
    )
      return;
    for (const client of Array.from(this.clients)) {
      try {
        client.handleUnroutedUnknownNotification?.(method);
      } catch {
        // Diagnostics must never change notification routing.
      }
    }
  }

  private handleNotification(
    method: string,
    notification: Record<string, unknown>,
    line: string,
  ): void {
    const params = readRecord(notification, 'params');
    if (!params) {
      this.reportUnroutedUnknownNotification(method);
      return;
    }

    if (method === 'serverRequest/resolved') {
      // Apply prompt cancellation before this control frame reaches its owner.
      this.cancelResolvedPromptRequest(params);
    }

    if (
      method === 'account/updated' ||
      method === 'account/rateLimits/updated'
    ) {
      this.markActivity();
      this.updateResourceRegistration();
      this.fanOutAccountNotification(method, notification);
      return;
    }

    if (method === 'thread/closed') {
      const closedThreadId = readString(params, 'threadId');
      if (closedThreadId) {
        this.loadedThreadProviderRoutes.delete(closedThreadId);
        // Only root setup can commit a provider identity. Keep close guards
        // bounded by those roots rather than retaining every child close.
        if (this.loadedRootThreadIds.has(closedThreadId)) {
          this.closedProviderRouteThreads.add(closedThreadId);
        }
        this.idleRetainedThreads.delete(closedThreadId);
        for (const wake of Array.from(
          this.threadClosedWaiters.get(closedThreadId) ?? [],
        )) {
          wake();
        }
        // A closed thread that no owner routes (the usual case: its owner was
        // released first) must not fall through to the sole-owner fallback.
        if (!this.resolveOwnerForThread(closedThreadId)) return;
      }
    }

    const itemId = this.extractNotificationItemId(params);
    const isTerminalItemNotification = this.isTerminalItemNotification(method);
    const owner = this.resolveNotificationOwner(method, params);
    if (!owner) {
      if (
        this.bufferPendingMcpStartupNotification(method, params, notification)
      ) {
        return;
      }
      this.reportUnroutedUnknownNotification(method);
      const threadId = this.extractNotificationThreadId(method, params);
      if (threadId && !this.disposedThreadTombstones.has(threadId)) {
        this.emitUnroutedNotificationWarning(threadId);
      }
      if (isTerminalItemNotification && itemId) {
        this.itemOwners.delete(itemId);
        this.mcpToolCalls.delete(itemId);
      }
      return;
    }

    if (
      method === 'thread/started' &&
      parseParentThreadIdFromThreadStarted(params)
    ) {
      const thread = readRecord(params, 'thread');
      const startedThreadId = thread ? readString(thread, 'id') : undefined;
      if (startedThreadId) {
        this.registerSubagentThread(startedThreadId, owner);
      }
    }

    if (method === 'item/started' || method === 'item/completed') {
      const item = readRecord(params, 'item');
      if (
        item &&
        readString(item, 'type') === 'subAgentActivity' &&
        readString(item, 'kind') === 'started'
      ) {
        const subagentThreadId = readString(item, 'agentThreadId');
        if (subagentThreadId) {
          this.registerSubagentThread(subagentThreadId, owner);
        }
      }
    }

    this.trackMcpToolCall(method, params);
    if (isTerminalItemNotification && itemId) {
      this.itemOwners.delete(itemId);
      this.mcpToolCalls.delete(itemId);
    } else {
      this.trackItemOwner(itemId, owner);
    }
    // Protocol control must never wait on transcript persistence. Observe a
    // returned routing receipt independently rather than holding this lane.
    if (!this.isTranscriptNotification(method)) {
      const admission = this.deliverNotification(
        owner,
        method,
        params,
        notification,
        method === 'turn/completed' || method === 'error'
          ? this.ownerLanes.whenDrained(owner)
          : undefined,
      );
      this.observeControlAdmission(owner, admission);
      return;
    }
    this.ownerLanes.dispatch(owner, {
      kind: 'notification',
      producedAtMs: this.extractNotificationProducedAtMs(method, params),
      // `turn/diff/updated` resends the turn's whole aggregated diff on every
      // file change: it is the protocol's repeated full snapshot. Over the
      // owner's soft cap only the newest diff of each turn is kept. Deltas,
      // items and output are never coalesced.
      coalesceKey:
        method === 'turn/diff/updated'
          ? JSON.stringify([
              this.extractNotificationThreadId(method, params),
              readString(params, 'turnId'),
            ])
          : undefined,
      // Streamed item notifications are the volume of a turn and carry no
      // turn or thread boundary: under a host budget they may be delivered
      // while the owner's earlier admissions are pending.
      overlap: method.startsWith('item/'),
      measureBytes: (): number => Buffer.byteLength(line, 'utf8'),
      deliver: (): void | Promise<void> =>
        this.deliverNotification(owner, method, params, notification),
    });
  }

  private extractNotificationProducedAtMs(
    method: string,
    params: Record<string, unknown>,
  ): number | undefined {
    const timestampField =
      method === 'item/started'
        ? 'startedAtMs'
        : method === 'item/completed'
          ? 'completedAtMs'
          : undefined;
    if (!timestampField) return undefined;
    const timestamp = params[timestampField];
    return typeof timestamp === 'number' &&
      Number.isFinite(timestamp) &&
      timestamp > 0
      ? timestamp
      : undefined;
  }

  private isTranscriptNotification(method: string): boolean {
    return (
      method.startsWith('item/') ||
      method === 'thread/tokenUsage/updated' ||
      method === 'turn/plan/updated' ||
      method === 'turn/diff/updated'
    );
  }

  private observeControlAdmission(
    owner: CodexAppServerConnectionOwner,
    admission: void | Promise<void>,
  ): void {
    const proc = this.process;
    if (admission)
      void admission.catch((error: unknown) => {
        // A drain the connection discarded with its worker is not a new
        // failure: the restart or recovery that discarded it settles turns.
        if (error instanceof TranscriptAdmissionDiscardedError) return;
        if (this.process === proc && this.clients.has(owner))
          this.failAll(
            error instanceof Error ? error : new Error(String(error)),
          );
      });
  }

  /**
   * Delivers one routed notification to its owner, in that owner's pipe
   * order. A returned promise is the owner's admission for the frame.
   */
  private deliverNotification(
    owner: CodexAppServerConnectionOwner,
    method: string,
    params: Record<string, unknown>,
    notification: Record<string, unknown>,
    transcriptDrain?: Promise<void>,
  ): void | Promise<void> {
    const quarantine = this.quarantinedOwners.get(owner);
    const pendingDisposal = this.pendingDisposedTurnInterrupts.get(owner);
    if (
      pendingDisposal &&
      this.isQuarantinedTurnTerminal(method, params, pendingDisposal)
    ) {
      this.completePendingDisposedTurn(owner, pendingDisposal);
      if (!quarantine) {
        return;
      }
    }
    if (quarantine) {
      if (method === 'thread/started') {
        const thread = readRecord(params, 'thread');
        const startedThreadId = thread ? readString(thread, 'id') : undefined;
        if (startedThreadId) {
          this.registerSubagentThread(startedThreadId, owner);
        }
      }
      if (
        !quarantine.turnId &&
        (method === 'turn/started' || method === 'turn/completed') &&
        readString(params, 'threadId') === quarantine.threadId
      ) {
        const turn = readRecord(params, 'turn');
        quarantine.turnId = turn ? (readString(turn, 'id') ?? null) : null;
      }
      if (this.isQuarantinedTurnTerminal(method, params, quarantine)) {
        if (quarantine.retryTimer !== null) {
          clearTimeout(quarantine.retryTimer);
        }
        quarantine.cancelDeadline?.();
        this.quarantinedOwners.delete(owner);
        owner.rejectActiveTurn(quarantine.error);
        owner.markProcessFailed();
        this.clearOwnerRouting(owner);
        this.unsubscribeThreadBestEffort(quarantine.threadId);
      }
      this.markActivity();
      this.updateResourceRegistration();
      this.tryCompleteExternalAuthTransition();
      return;
    }
    // Owners that do not finalize transcript content may ignore the drain;
    // the lanes observe its rejection, so an owner never has to.
    const admission = owner.handleConnectionNotification(
      method,
      notification,
      transcriptDrain,
    );
    this.markActivity();
    this.updateResourceRegistration();
    this.tryCompleteExternalAuthTransition();
    if (this.externalAuthTransition) {
      // RuntimeThreadHandle may clear activeTurn in a promise continuation
      // scheduled by any terminal or failure notification. Recheck after that
      // continuation so an auth cutover cannot remain parked.
      queueMicrotask(() => this.tryCompleteExternalAuthTransition());
    }
    return admission && typeof admission.then === 'function'
      ? admission
      : undefined;
  }

  private bufferPendingMcpStartupNotification(
    method: string,
    params: Record<string, unknown>,
    notification: Record<string, unknown>,
  ): boolean {
    if (
      method !== 'mcpServer/startupStatus/updated' ||
      !this.hasPendingThreadMutation()
    ) {
      return false;
    }
    const threadId = this.extractNotificationThreadId(method, params);
    const serverName = readString(params, 'name');
    if (!threadId || !serverName) {
      return false;
    }
    const notifications =
      this.pendingMcpStartupNotifications.get(threadId) ??
      new Map<string, Record<string, unknown>>();
    notifications.set(serverName, notification);
    this.pendingMcpStartupNotifications.set(threadId, notifications);
    return true;
  }

  private flushPendingMcpStartupNotifications(
    threadId: string,
    owner: CodexAppServerConnectionOwner,
  ): void {
    const notifications = this.pendingMcpStartupNotifications.get(threadId);
    if (!notifications) {
      return;
    }
    this.pendingMcpStartupNotifications.delete(threadId);
    for (const notification of Array.from(notifications.values())) {
      // Startup status is control, not transcript admission. Preserve the
      // attempt-scoped failure observer without retaining this frame.
      const admission = owner.handleConnectionNotification(
        'mcpServer/startupStatus/updated',
        notification,
      );
      if (admission)
        void admission.catch(() => {
          process.emitWarning(
            `Codex MCP startup notification admission failed for thread ${threadId}`,
            { type: 'CanopyCodexNotificationWarning' },
          );
        });
    }
    this.markActivity();
    this.updateResourceRegistration();
  }

  private hasPendingThreadMutation(): boolean {
    return Array.from(this.pendingResponses.values()).some(
      (pending) =>
        !pending.responseReceived && isThreadMutationMethod(pending.method),
    );
  }

  private clearOrphanedMcpStartupNotifications(): void {
    if (!this.hasPendingThreadMutation()) {
      this.pendingMcpStartupNotifications.clear();
    }
  }

  private emitUnroutedNotificationWarning(threadId: string): void {
    const now = Date.now();
    const warningWindowMs = 30_000;
    if (
      this.unroutedWarningWindowStartedAt > 0 &&
      now - this.unroutedWarningWindowStartedAt < warningWindowMs
    ) {
      this.suppressedUnroutedWarningCount += 1;
      return;
    }
    const suppressed = this.suppressedUnroutedWarningCount;
    this.unroutedWarningWindowStartedAt = now;
    this.suppressedUnroutedWarningCount = 0;
    const summary =
      suppressed > 0
        ? `; suppressed ${String(suppressed)} additional unrouted notifications during the previous 30 seconds`
        : '';
    process.emitWarning(
      `Codex app-server emitted an unrouted notification for thread ${threadId}${summary}`,
      { type: 'CanopyCodexRoutingWarning' },
    );
  }

  private fanOutAccountNotification(
    method: string,
    notification: Record<string, unknown>,
  ): void {
    for (const owner of Array.from(this.clients)) {
      this.observeControlAdmission(
        owner,
        owner.handleConnectionNotification(method, notification),
      );
    }
  }

  private resolveNotificationOwner(
    method: string,
    params: Record<string, unknown>,
  ): CodexAppServerConnectionOwner | null {
    const threadId = this.extractNotificationThreadId(method, params);
    if (threadId && this.disposedThreadTombstones.has(threadId)) {
      return null;
    }
    const directOwner = this.resolveOwnerForThread(threadId);
    if (directOwner) {
      return directOwner;
    }

    if (method === 'mcpServer/startupStatus/updated') {
      const pendingThreadOwner = this.resolveSolePendingThreadOwner();
      if (pendingThreadOwner) {
        return pendingThreadOwner;
      }
    }

    const itemId = this.extractNotificationItemId(params);
    if (itemId && this.itemOwners.has(itemId)) {
      const itemOwner = this.itemOwners.get(itemId) ?? null;
      return itemOwner && this.clients.has(itemOwner) ? itemOwner : null;
    }

    if (method !== 'thread/started') {
      return this.resolveSoleOwnerFallback();
    }

    const parentThreadId = parseParentThreadIdFromThreadStarted(params);
    if (parentThreadId) {
      return (
        this.resolveOwnerForThread(parentThreadId) ??
        this.resolveSoleOwnerFallback()
      );
    }

    return (
      this.resolveSolePendingThreadOwner() ?? this.resolveSoleOwnerFallback()
    );
  }

  private resolveSoleOwnerFallback(): CodexAppServerConnectionOwner | null {
    if (this.clients.size !== 1) {
      return null;
    }
    return Array.from(this.clients)[0] ?? null;
  }

  private resolveSolePendingThreadOwner(): CodexAppServerConnectionOwner | null {
    const owners = new Set<CodexAppServerConnectionOwner>();
    for (const pending of Array.from(this.pendingResponses.values())) {
      if (
        pending.owner &&
        !pending.responseReceived &&
        this.clients.has(pending.owner) &&
        isThreadMutationMethod(pending.method)
      ) {
        owners.add(pending.owner);
      }
    }
    return owners.size === 1 ? (Array.from(owners)[0] ?? null) : null;
  }

  private extractNotificationThreadId(
    method: string,
    params: Record<string, unknown>,
  ): string | undefined {
    const directThreadId = readString(params, 'threadId');
    if (directThreadId) {
      return directThreadId;
    }
    if (method !== 'thread/started') {
      return undefined;
    }
    const thread = readRecord(params, 'thread');
    return thread ? readString(thread, 'id') : undefined;
  }

  private extractNotificationItemId(
    params: Record<string, unknown>,
  ): string | undefined {
    const directItemId = readString(params, 'itemId');
    if (directItemId) {
      return directItemId;
    }
    const item = readRecord(params, 'item');
    return item ? readString(item, 'id') : undefined;
  }

  private isTerminalItemNotification(method: string): boolean {
    return method === 'item/completed';
  }

  private trackMcpToolCall(
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method !== 'item/started') {
      return;
    }
    const item = readRecord(params, 'item');
    if (!item || readString(item, 'type') !== 'mcpToolCall') {
      return;
    }
    const id = readString(item, 'id');
    const threadId = readString(params, 'threadId');
    const turnId = readString(params, 'turnId');
    const serverName = readString(item, 'server');
    const toolName = readString(item, 'tool');
    const argumentsValue = item.arguments;
    if (
      !id ||
      !threadId ||
      !serverName ||
      !toolName ||
      !isJsonValue(argumentsValue)
    ) {
      return;
    }
    this.mcpToolCalls.set(id, {
      id,
      threadId,
      ...(turnId ? { turnId } : {}),
      serverName,
      toolName,
      arguments: argumentsValue,
      normalizedArguments: normalizeJsonValue(argumentsValue),
    });
  }

  private isQuarantinedTurnTerminal(
    method: string,
    params: Record<string, unknown>,
    quarantine: Pick<QuarantinedOwner, 'threadId' | 'turnId'>,
  ): boolean {
    if (method !== 'turn/completed' || !quarantine.turnId) {
      return false;
    }
    const turn = readRecord(params, 'turn');
    return (
      readString(params, 'threadId') === quarantine.threadId &&
      turn !== null &&
      readString(turn, 'id') === quarantine.turnId
    );
  }

  private hasPendingServerRequests(): boolean {
    for (const requests of Array.from(
      this.pendingServerRequestsByOwner.values(),
    )) {
      if (requests.size > 0) {
        return true;
      }
    }
    return false;
  }

  private notifyProcessExit(
    proc: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
    recoveryScheduled: boolean,
  ): void {
    const stderr = reportedStderrTail(this.stderrTail);
    const uptimeMs =
      this.processStartedAt === null
        ? null
        : Math.max(0, Date.now() - this.processStartedAt);
    const details = {
      code,
      signal,
      stderrTail: stderr.text,
      stderrTruncated: stderr.truncated,
      pid: typeof proc.pid === 'number' ? proc.pid : null,
      uptimeMs,
      clientCount: this.clientCount(),
      activeTurnCount: this.activeTurnCount(),
      recoveryScheduled,
    };
    for (const callbacks of Array.from(this.processCallbacks.values())) {
      callbacks.onProcessExit?.(details);
    }
  }

  private shouldRecoverUnexpectedExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    outputStreamClosed: boolean,
  ): boolean {
    const cleanExit = code === 0 && signal === null;
    const terminatedAfterOutputClosed =
      outputStreamClosed && (signal === 'SIGTERM' || signal === 'SIGKILL');
    return (
      this.initialized &&
      !this.closing &&
      this.activeTurnCount() > 0 &&
      (cleanExit || terminatedAfterOutputClosed)
    );
  }

  private buildRecoverableExitError(
    processFailureError: Error,
  ): CodexRecoverableProcessExitError {
    const recoverableError = new CodexRecoverableProcessExitError(
      `${processFailureError.message}\nThe app is reconnecting to the persisted Codex thread in the background.`,
    );
    Object.defineProperty(recoverableError, 'cause', {
      value: processFailureError,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    return recoverableError;
  }

  private recoverAfterUnexpectedExit(processFailureError: Error): void {
    const recoverableError =
      this.buildRecoverableExitError(processFailureError);

    this.settleAllRetainedResponses(recoverableError);

    for (const pending of Array.from(this.pendingResponses.values())) {
      pending.reject(recoverableError);
    }
    this.pendingResponses.clear();

    const activeOwners = Array.from(this.clients).filter((client) =>
      client.hasActiveTurn(),
    );
    for (const client of Array.from(this.clients)) {
      client.markProcessFailed();
    }
    this.beginOwnerRecovery(
      activeOwners,
      processFailureError,
      recoverableError,
    );
  }

  /**
   * Resets the connection for a dead worker and resumes each given owner's
   * persisted thread once in-flight host-side handlers have settled.
   */
  private beginOwnerRecovery(
    activeOwners: readonly CodexAppServerConnectionOwner[],
    processFailureError: Error,
    recoverableError: CodexRecoverableProcessExitError,
  ): void {
    for (const owner of activeOwners) {
      owner.cancelPendingServerRequestsForRecovery?.();
    }
    const recoveryQuiescence = this.waitForPendingServerRequestHandlers();
    this.recoveryQuiescencePromise = recoveryQuiescence.settlement;
    void recoveryQuiescence.settlement.then(() => {
      if (this.recoveryQuiescencePromise === recoveryQuiescence.settlement) {
        this.recoveryQuiescencePromise = null;
      }
    });
    this.resetAfterProcessFailure();

    void this.recoverOwnersAfterUnexpectedExit(
      activeOwners,
      processFailureError,
      recoverableError,
      recoveryQuiescence.withinRecoveryDeadline,
    );
  }

  private async recoverOwnersAfterUnexpectedExit(
    activeOwners: readonly CodexAppServerConnectionOwner[],
    processFailureError: Error,
    recoverableError: CodexRecoverableProcessExitError,
    recoveryQuiescencePromise: Promise<boolean>,
  ): Promise<void> {
    const handlersSettled = await recoveryQuiescencePromise;
    if (!handlersSettled) {
      const recoveryError = new Error(
        `Codex app-server background recovery failed: host-side tool handlers did not settle within ${CODEX_PROCESS_RECOVERY_HANDLER_QUIESCENCE_TIMEOUT_MS}ms`,
      );
      Object.defineProperty(recoveryError, 'cause', {
        value: processFailureError,
        configurable: true,
        writable: true,
        enumerable: false,
      });
      for (const owner of activeOwners) {
        owner.cancelPendingTurnStart(recoveryError);
        owner.rejectActiveTurn(recoveryError);
        this.processCallbacks.get(owner)?.onProcessRecovery?.({
          status: 'failed',
          error: recoveryError.message,
        });
      }
      return;
    }

    for (const owner of activeOwners) {
      const recovery =
        owner.recoverAfterUnexpectedProcessExit?.(recoverableError);
      if (!recovery) {
        owner.rejectActiveTurn(processFailureError);
        continue;
      }
      void recovery
        .then((result) => {
          this.processCallbacks.get(owner)?.onProcessRecovery?.({
            status: 'succeeded',
            strategy: result.strategy,
          });
        })
        .catch((error: unknown) => {
          const message = `Codex app-server background recovery failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          const recoveryError =
            isCodexSharedRestartPeerError(processFailureError) &&
            !isUnsafeToRetryRecoveryFailure(error)
              ? new CodexSharedRestartRecoveryError(message)
              : new Error(message);
          Object.defineProperty(recoveryError, 'cause', {
            value: error,
            configurable: true,
            writable: true,
            enumerable: false,
          });
          owner.rejectActiveTurn(recoveryError, recovery);
          this.processCallbacks.get(owner)?.onProcessRecovery?.({
            status: 'failed',
            error: recoveryError.message,
          });
        });
    }
  }

  private failAll(error: Error): void {
    this.rejectAllPendingRequests(error);
    for (const client of Array.from(this.clients)) {
      client.rejectActiveTurn(error);
      client.markProcessFailed();
    }
    this.resetAfterProcessFailure();
  }

  /**
   * Whether a shared restart on behalf of `restartOwner` can hand `candidate`
   * to persisted-thread recovery. An owner whose own turn is being cancelled
   * (quarantined, or disposed with its interrupt pending) must never be
   * continued.
   */
  private canRecoverAfterSharedRestart(
    restartOwner: CodexAppServerConnectionOwner,
    candidate: CodexAppServerConnectionOwner | undefined,
  ): candidate is CodexAppServerConnectionOwner {
    return (
      candidate !== undefined &&
      candidate !== restartOwner &&
      this.clients.has(candidate) &&
      !this.isOwnerCancelling(candidate) &&
      candidate.recoverAfterUnexpectedProcessExit !== undefined
    );
  }

  private hasRecoverableSharedRestartPeer(
    restartOwner: CodexAppServerConnectionOwner,
  ): boolean {
    return Array.from(this.clients).some(
      (client) =>
        this.canRecoverAfterSharedRestart(restartOwner, client) &&
        client.hasActiveTurn(),
    );
  }

  /**
   * Tears down the worker that was terminated to stop `owner`'s turn. `owner`
   * receives its own error. Other owners are bystanders: an active turn goes
   * through the same persisted-thread recovery as an unexpected exit (which
   * reconciles, continues, or replays only after confirming nothing was
   * persisted), and only an owner that cannot recover is failed.
   */
  private failAllForSharedRestart(
    owner: CodexAppServerConnectionOwner,
    ownerError: Error,
  ): void {
    const peerError = new CodexSharedRestartPeerError();
    const recoverableError = this.buildRecoverableExitError(peerError);
    // Captured before the reset below clears quarantine state.
    const cancellationErrors = new Map<CodexAppServerConnectionOwner, Error>();
    for (const [quarantined, quarantine] of Array.from(
      this.quarantinedOwners.entries(),
    )) {
      cancellationErrors.set(quarantined, quarantine.error);
    }
    const failureFor = (
      candidate: CodexAppServerConnectionOwner | undefined,
    ): Error =>
      candidate === owner
        ? ownerError
        : ((candidate ? cancellationErrors.get(candidate) : undefined) ??
          peerError);

    for (const pending of Array.from(this.pendingResponses.values())) {
      pending.reject(
        this.canRecoverAfterSharedRestart(owner, pending.owner)
          ? recoverableError
          : failureFor(pending.owner),
      );
    }
    this.pendingResponses.clear();
    for (const [id, pending] of Array.from(this.retainedResponses.entries())) {
      this.settleRetainedResponse(id, pending, {
        kind: 'error',
        error: this.canRecoverAfterSharedRestart(owner, pending.owner)
          ? recoverableError
          : failureFor(pending.owner),
      });
    }

    const recoveringOwners: CodexAppServerConnectionOwner[] = [];
    let failedPeerCount = 0;
    for (const client of Array.from(this.clients)) {
      const hadActiveTurn = client.hasActiveTurn();
      if (hadActiveTurn && this.canRecoverAfterSharedRestart(owner, client)) {
        recoveringOwners.push(client);
      } else {
        if (
          hadActiveTurn &&
          client !== owner &&
          !cancellationErrors.has(client)
        ) {
          failedPeerCount += 1;
        }
        client.rejectActiveTurn(failureFor(client));
      }
      client.markProcessFailed();
    }

    const pid = this.process?.pid;
    const processUptimeMs = this.getProcessUptimeMs();
    getCodexRuntimeHostHooks().recordDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'codex_app_server_shared_restart',
      restartTrigger: sharedRestartTrigger(ownerError),
      recoveredPeerCount: recoveringOwners.length,
      failedPeerCount,
      ...(processUptimeMs !== null ? { processUptimeMs } : {}),
      appProcessId: process.pid,
      ...(typeof pid === 'number' ? { codexAppServerProcessId: pid } : {}),
    });

    if (recoveringOwners.length === 0) {
      this.resetAfterProcessFailure();
      return;
    }
    this.beginOwnerRecovery(recoveringOwners, peerError, recoverableError);
  }

  private resetAfterProcessFailure(): void {
    this.detachStdoutAdmission();
    this.stdout = null;
    this.initialized = false;
    this.initializePromise = null;
    this.pendingProcessFailureError = null;
    this.pendingSharedRestartOwner = null;
    this.pendingSharedRestartOwnerError = null;
    this.clearQuarantinedOwners();
    this.clearPendingDisposedTurnInterrupts();
    this.pendingServerRequestsByOwner.clear();
    this.itemOwners.clear();
    this.mcpToolCalls.clear();
    this.pendingMcpStartupNotifications.clear();
    this.timedOutThreadRequests.clear();
    this.idleRetainedThreads.clear();
    this.loadedThreadProviderRoutes.clear();
    this.closedProviderRouteThreads.clear();
    this.process = null;
    this.processStartedAt = null;
    this.unregisterResource();
    this.tryCompleteExternalAuthTransition();
  }

  private shouldRetryStateDbStartupFailure(
    error: unknown,
    retryCount: number,
  ): boolean {
    if (retryCount >= STARTUP_STATE_DB_MAX_RETRIES) {
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    return isRetryableStateDbStartupFailure(message);
  }

  private shouldContinueStartupRetryLoop(): boolean {
    return (
      !this.closing &&
      (this.clients.size > 0 || this.options.allowOwnerlessStartup === true)
    );
  }

  private resetAfterRetryableStartupExit(
    code?: number | null,
    signal?: NodeJS.Signals | null,
  ): void {
    this.detachStdoutAdmission();
    const processExitError = this.buildProcessFailureError(
      'Codex app-server exited',
      code,
      signal,
    );
    this.settleAllRetainedResponses(
      new CodexRecoverableProcessExitError(processExitError.message),
    );
    for (const pending of Array.from(this.pendingResponses.values())) {
      pending.reject(processExitError);
    }
    this.pendingResponses.clear();
    this.stdout = null;
    this.initialized = false;
    this.pendingProcessFailureError = null;
    this.pendingSharedRestartOwner = null;
    this.pendingSharedRestartOwnerError = null;
    this.pendingServerRequestsByOwner.clear();
    this.itemOwners.clear();
    this.mcpToolCalls.clear();
    this.loadedThreadProviderRoutes.clear();
    this.closedProviderRouteThreads.clear();
    this.process = null;
    this.processStartedAt = null;
    this.unregisterResource();
  }

  private isProcessAlive(proc: ChildProcessWithoutNullStreams): boolean {
    return proc.exitCode === null && proc.signalCode === null;
  }

  private detachStdoutAdmission(): void {
    if (this.ownerLanes.discardAll()) {
      // Frames retained for held owners are dropped because this worker is
      // going away. As with the former whole-pipe hold, read nothing further
      // from it, so no later frame overtakes a dropped one.
      this.stdout?.pause();
    }
  }

  private terminateProcess(
    proc: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    this.detachStdoutAdmission();
    if (signal !== 'SIGKILL') {
      void this.beginProcessTermination(proc).catch(() => {});
      return;
    }
    try {
      if (this.isProcessAlive(proc)) {
        killChildProcessGroup(proc, signal);
      }
    } catch {
      // Best effort process termination.
    }
  }

  private beginProcessTermination(
    proc: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    const existing = this.processTerminations.get(proc);
    if (existing) {
      return existing;
    }
    const tracked = this.terminateProcessAndWait(proc).then(() => {
      this.processTerminations.delete(proc);
    });
    this.processTerminations.set(proc, tracked);
    void tracked.catch(() => {});
    return tracked;
  }

  private async waitForPendingProcessTerminations(): Promise<void> {
    await awaitAllTerminations(
      Array.from(this.processTerminations.values()),
      'Codex app-server process cleanup encountered multiple failures',
    );
  }

  private async terminateProcessAndWait(
    proc: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (!this.isProcessAlive(proc)) {
      return;
    }
    try {
      killChildProcessGroup(proc, 'SIGTERM');
    } catch {
      // Continue to the bounded wait and force-kill attempt.
    }
    await waitForProcessExit(proc, FORCE_KILL_PROCESS_GROUP_DELAY_MS);
    if (!this.isProcessAlive(proc)) {
      return;
    }
    try {
      killChildProcessGroup(proc, 'SIGKILL');
    } catch {
      // The liveness check below produces the terminal shutdown error.
    }
    await waitForProcessExit(proc, INTERRUPT_PROCESS_GRACE_MS);
    if (this.isProcessAlive(proc)) {
      throw new Error(
        `Codex app-server process ${String(proc.pid ?? 'unknown')} did not terminate`,
      );
    }
  }

  private buildProcessFailureError(
    reason: string,
    code?: number | null,
    signal?: NodeJS.Signals | null,
  ): Error {
    return new Error(
      buildProcessFailureMessage(this.stderrTail, reason, code, signal),
    );
  }
}

export function createCodexAuthenticationConnection(
  profile: CodexResolvedSpawnProfile,
  owner: CodexAppServerConnectionOwner,
): CodexAppServerConnection {
  const connection = new CodexAppServerConnection(
    `profile:${profile.id}:authentication`,
    profile.environment,
    profile.configArgs,
    { includeCanopySecrets: profile.includeCanopySecrets },
  );
  connection.registerOwner(owner, {});
  return connection;
}

export interface CodexAppServerPoolAcquireOptions {
  profileKey: string;
  extraEnv?: Record<string, string>;
  /** Extra `-c key=value` app-server config overrides (e.g. gateway provider). */
  configArgs?: string[];
  includeCanopySecrets?: boolean;
  environmentPolicy?: CodexSpawnEnvironmentPolicy;
  owner: CodexAppServerConnectionOwner;
  processCallbacks: CodexAppServerProcessCallbacks;
}

export interface CodexAuthenticationLease {
  /** All pre-existing workers and detached process terminations have settled. */
  ready: Promise<void>;
  /** Reopens admission once `ready` settles, whether it resolved or rejected. */
  close(): Promise<void>;
}

export class CodexAppServerPool {
  private authenticationGate: Promise<void> | null = null;
  private releaseAuthenticationGate: (() => void) | null = null;

  /** Reserve synchronously, before a host pauses work or awaits persistence. */
  beginAuthentication(): CodexAuthenticationLease {
    if (this.authenticationGate)
      throw new Error('Codex sign-in is already active.');
    this.authenticationGate = new Promise<void>((resolve) => {
      this.releaseAuthenticationGate = resolve;
    });
    const gate = this.authenticationGate;
    const ready = Promise.all([
      this.suspendConnectionsForExternalAuthChange(),
      ...Array.from(this.pendingTerminations),
    ]).then(() => undefined);
    void ready.catch(() => undefined);
    return {
      ready,
      close: async (): Promise<void> => {
        // `ready` already reports a failed cutover, and that rejection is
        // permanent. Rethrowing it here would make the lease impossible to
        // close, so only wait for the cutover to settle.
        await ready.catch(() => undefined);
        if (this.authenticationGate === gate) {
          this.authenticationGate = null;
          this.releaseAuthenticationGate?.();
          this.releaseAuthenticationGate = null;
        }
      },
    };
  }

  private readonly connections = new Map<string, CodexAppServerConnection>();
  private readonly pendingTerminations = new Set<Promise<void>>();
  private idleTimeoutMinutes = DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES;
  private externalAuthTransition: Promise<number> | null = null;
  private readonly pressureSuspensionState = new Map<
    string,
    {
      consecutiveSuspensions: number;
      lastSuspendedAt: number;
      dispatchedTurnCount: number;
      /**
       * Escalation step whose skip has already been reported. The monitor ticks
       * every 60s, so recording on every skip would emit ~1400 diagnostics/day
       * per pool key during a sustained pressure episode - substituting one
       * high-volume record for the stop-event volume this backoff exists to
       * reduce. Reporting once per escalation step keeps "why didn't this
       * suspend?" answerable at a fraction of the volume.
       */
      reportedBackoffStep?: number;
    }
  >();

  acquire(opts: CodexAppServerPoolAcquireOptions): CodexAppServerConnection {
    const key = buildCodexAppServerPoolKey({
      profileKey: opts.profileKey,
    });
    let connection = this.connections.get(key);
    if (!connection) {
      connection = new CodexAppServerConnection(
        key,
        opts.extraEnv,
        opts.configArgs,
        {
          includeCanopySecrets: opts.includeCanopySecrets,
          environmentPolicy: opts.environmentPolicy,
          externalAuthTransitionBarrier: (): Promise<unknown> | null =>
            this.externalAuthTransition ?? this.authenticationGate,
          releaseThreadWriterElsewhere: (
            threadId,
          ): Promise<CodexWriterHandoffOutcome> =>
            this.releaseThreadWriterHeldElsewhere(threadId, created),
        },
      );
      const created = connection;
      // Connections created after a preference change (or after startup
      // seeding) must inherit the configured idle timeout — the broadcast in
      // `updateIdleTimeoutMinutes` only reaches connections alive at that
      // moment.
      connection.updateIdleTimeoutMinutes(this.idleTimeoutMinutes);
      this.connections.set(key, connection);
    }
    connection.registerOwner(opts.owner, opts.processCallbacks);
    return connection;
  }

  /**
   * Frees `threadId`'s writer when another of this pool's workers still holds
   * it idle, by stopping that worker. A holder with live work is left alone.
   */
  private async releaseThreadWriterHeldElsewhere(
    threadId: string,
    requester: CodexAppServerConnection,
  ): Promise<CodexWriterHandoffOutcome> {
    let holderBusy = false;
    for (const connection of Array.from(this.connections.values())) {
      if (connection === requester) continue;
      const outcome = await connection.releaseIdleThreadWriter(threadId);
      if (outcome === 'released') return 'released';
      if (outcome === 'holder-busy') holderBusy = true;
    }
    return holderBusy ? 'holder-busy' : 'no-local-holder';
  }

  release(
    connection: CodexAppServerConnection,
    owner: CodexAppServerConnectionOwner,
  ): void {
    connection.unregisterOwner(owner);
    if (connection.clientCount() > 0) {
      return;
    }

    this.trackTermination(connection.terminateForFinalRelease());
    for (const [key, value] of Array.from(this.connections.entries())) {
      if (value === connection) {
        this.connections.delete(key);
        this.pressureSuspensionState.delete(key);
      }
    }
  }

  async shutdown(): Promise<void> {
    const connections = Array.from(this.connections.values());
    this.connections.clear();
    this.pressureSuspensionState.clear();
    await awaitAllTerminations(
      [
        ...Array.from(this.pendingTerminations),
        ...connections.map((connection) =>
          connection.terminateForFinalRelease('runtime-shutdown'),
        ),
      ],
      'Codex app-server pool shutdown encountered multiple failures',
    );
  }

  private trackTermination(termination: Promise<void>): void {
    const tracked = termination.then(() => {
      this.pendingTerminations.delete(tracked);
    });
    this.pendingTerminations.add(tracked);
    void tracked.catch(() => {});
  }

  getResourceSnapshots(): CodexAppServerPoolResourceSnapshot[] {
    return Array.from(this.connections.values()).map((connection) =>
      connection.getResourceSnapshot(),
    );
  }

  suspendIdleConnectionsForMemoryPressure(): number {
    let suspended = 0;
    const now = Date.now();
    for (const [key, connection] of Array.from(this.connections.entries())) {
      let pressureState = this.pressureSuspensionState.get(key);
      const dispatchedTurnCount = connection.getDispatchedTurnCount();
      if (
        pressureState &&
        dispatchedTurnCount !== pressureState.dispatchedTurnCount
      ) {
        this.pressureSuspensionState.delete(key);
        pressureState = undefined;
      }
      if (
        pressureState &&
        now - pressureState.lastSuspendedAt >=
          CODEX_PRESSURE_SUSPEND_BACKOFF_DECAY_MS
      ) {
        // The pressure episode has passed. Start the next one from the
        // shortest backoff instead of inheriting a stale escalation.
        this.pressureSuspensionState.delete(key);
        pressureState = undefined;
      }
      if (pressureState) {
        const backoffMs =
          CODEX_PRESSURE_SUSPEND_BACKOFF_MS[
            Math.min(
              pressureState.consecutiveSuspensions - 1,
              CODEX_PRESSURE_SUSPEND_BACKOFF_MS.length - 1,
            )
          ] ?? CODEX_PRESSURE_SUSPEND_BACKOFF_MS[0];
        const elapsedMs = now - pressureState.lastSuspendedAt;
        if (elapsedMs < backoffMs) {
          if (
            pressureState.reportedBackoffStep !== backoffMs &&
            connection.recordPressureSuspendSkipped('pressure-backoff', {
              retryAfterMs: backoffMs - elapsedMs,
            })
          ) {
            this.pressureSuspensionState.set(key, {
              ...pressureState,
              reportedBackoffStep: backoffMs,
            });
          }
          continue;
        }
      }
      if (connection.suspendIdleProcessIfIdle('critical-pressure')) {
        suspended += 1;
        this.pressureSuspensionState.set(key, {
          consecutiveSuspensions:
            (pressureState?.consecutiveSuspensions ?? 0) + 1,
          lastSuspendedAt: now,
          dispatchedTurnCount,
        });
      }
    }
    return suspended;
  }

  suspendConnectionsForExternalAuthChange(): Promise<number> {
    if (this.externalAuthTransition) {
      return this.externalAuthTransition;
    }
    const suspensions = Array.from(this.connections.values()).map(
      (connection) => connection.suspendProcessForExternalAuthChange(),
    );
    const transition = Promise.all(suspensions).then(
      (results) => results.filter(Boolean).length,
    );
    this.externalAuthTransition = transition;
    void transition
      .finally(() => {
        if (this.externalAuthTransition === transition) {
          this.externalAuthTransition = null;
        }
      })
      .catch(() => {});
    return transition;
  }

  updateIdleTimeoutMinutes(minutes: number): void {
    this.idleTimeoutMinutes = minutes;
    for (const connection of Array.from(this.connections.values())) {
      connection.updateIdleTimeoutMinutes(minutes);
    }
  }
}
