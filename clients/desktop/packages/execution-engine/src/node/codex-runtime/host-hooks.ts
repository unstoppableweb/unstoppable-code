import type { ChildProcess } from 'node:child_process';
import type {
  ResourceGroupId,
  ResourceMetadata,
  ResourceProcessKind,
} from '@canopy/execution-engine/execution-types';
import type { ClientInfo } from './generated/ClientInfo';

export interface CodexRuntimeResourceRegistrationHandle {
  update(metadata: Partial<CodexWorkerResourceRegistration>): void;
  unregister(): void;
}

export interface CodexWorkerResourceRegistration {
  id: string;
  groupId: ResourceGroupId;
  kind: ResourceProcessKind;
  label: string;
  pid?: number;
  startedAt?: string;
  metadata?: ResourceMetadata;
}

interface CodexRuntimeDiagnosticBase {
  version: 1;
  timestamp: string;
  appProcessId: number;
  codexAppServerProcessId?: number;
}

export interface CodexRuntimeStoppedDiagnostic extends CodexRuntimeDiagnosticBase {
  kind: 'resource_codex_app_server_stopped';
  trigger:
    | 'idle-timeout'
    | 'critical-pressure'
    | 'external-auth-change'
    | 'thread-budget'
    | 'final-owner-release'
    | 'runtime-shutdown'
    | 'unresponsive-thread-request'
    | 'writer-handoff';
  stoppedCodexAppServerCount: number;
}

export interface CodexRuntimeSuspendSkippedDiagnostic extends CodexRuntimeDiagnosticBase {
  kind: 'resource_codex_app_server_suspend_skipped';
  trigger: 'critical-pressure';
  skippedReason: 'minimum-process-lifetime' | 'pressure-backoff';
  processUptimeMs?: number;
  retryAfterMs?: number;
}

/**
 * One owner's notification admission stayed pending, or the shared stdout was
 * paused at the retained-frame byte cap, for at least the long-hold threshold
 * (5 seconds by default). Content-free: durations, counts and bytes only;
 * never message content, prompts, paths, or thread identifiers.
 */
export interface CodexRuntimeStdoutHoldDiagnostic extends CodexRuntimeDiagnosticBase {
  kind: 'codex_app_server_stdout_hold';
  holdKind: 'owner-admission' | 'stdout-byte-cap';
  holdOutcome: 'released' | 'detached' | 'failed' | 'discarded';
  holdDurationMs: number;
  /** Peak frames retained during the hold (that owner, or all owners). */
  queuedFrameCount: number;
  /** Peak wire bytes retained during the hold (that owner, or all owners). */
  queuedFrameBytes: number;
  /** Whether a JSON-RPC response was retained during the hold. */
  responseQueued: boolean;
}

/**
 * A `thread/resume` was rejected because the app-server was still closing that
 * thread, and the connection waited to retry it. Written once, when the wait
 * ends. Content-free: an outcome, a duration and counts only; never a thread
 * identifier.
 */
export interface CodexRuntimeThreadCloseWaitDiagnostic extends CodexRuntimeDiagnosticBase {
  kind: 'codex_app_server_thread_close_wait';
  closeWaitOutcome: 'resumed' | 'exhausted' | 'aborted' | 'failed';
  closeWaitDurationMs: number;
  closeWaitRetryCount: number;
  /** Whether a `thread/closed` notification released at least one wait. */
  closedNotificationObserved: boolean;
}

/**
 * The app-server did not answer a JSON-RPC request within its deadline.
 * Content-free: the protocol method name, durations and counts only.
 */
export interface CodexRuntimeRequestTimeoutDiagnostic extends CodexRuntimeDiagnosticBase {
  kind: 'codex_app_server_request_timeout';
  requestMethod: string;
  requestTimeoutMs: number;
  processUptimeMs?: number;
  /** Other owners with an active turn or an in-flight request. */
  busyPeerCount: number;
  /** Requests still pending on the connection after this one timed out. */
  pendingRequestCount: number;
  /** Whether stdout was paused at the retained-frame byte cap. */
  stdoutPaused: boolean;
}

/**
 * The shared app-server was terminated to stop one owner's turn. Content-free:
 * the trigger, counts and durations only.
 */
export interface CodexRuntimeSharedRestartDiagnostic extends CodexRuntimeDiagnosticBase {
  kind: 'codex_app_server_shared_restart';
  restartTrigger:
    | 'turn-cancelled'
    | 'session-destroyed'
    | 'turn-start-timeout'
    | 'other';
  /** Other owners whose active turn went to persisted-thread recovery. */
  recoveredPeerCount: number;
  /** Other owners whose active turn or request was failed instead. */
  failedPeerCount: number;
  processUptimeMs?: number;
}

/**
 * A `thread/resume` was refused because another app-server process held the
 * thread's writer, and the pool tried to free it. Content-free: an outcome and
 * a duration only; never a thread identifier.
 */
export interface CodexRuntimeWriterHandoffDiagnostic extends CodexRuntimeDiagnosticBase {
  kind: 'codex_app_server_writer_handoff';
  writerHandoffOutcome: 'released' | 'holder-busy' | 'no-local-holder';
  writerHandoffDurationMs: number;
}

export type CodexRuntimeDiagnostic =
  | CodexRuntimeStoppedDiagnostic
  | CodexRuntimeSuspendSkippedDiagnostic
  | CodexRuntimeStdoutHoldDiagnostic
  | CodexRuntimeThreadCloseWaitDiagnostic
  | CodexRuntimeRequestTimeoutDiagnostic
  | CodexRuntimeSharedRestartDiagnostic
  | CodexRuntimeWriterHandoffDiagnostic;

export interface CodexRuntimeHostHooks {
  clientInfo(): ClientInfo;
  registerProcess(
    metadata: CodexWorkerResourceRegistration,
  ): CodexRuntimeResourceRegistrationHandle;
  registerProcessOwner(process: ChildProcess): void;
  unregisterProcessOwner(process: ChildProcess): void;
  recordDiagnostic(event: CodexRuntimeDiagnostic): void;
  productDisplayName(): string;
  /**
   * The per-owner in-flight budget for notification admission, read at each
   * delivery decision; see `owner-admission-lanes.ts`. Undefined, or a host
   * without the hook: one pending admission per owner.
   */
  ownerAdmissionBudget?(): CodexOwnerAdmissionBudget | undefined;
}

/** What one owner may have delivered to it and not yet admitted. */
export interface CodexOwnerAdmissionBudget {
  /** Wire bytes of the notifications whose admissions are pending. */
  bytes: number;
  /** Notifications whose admissions are pending. */
  frames: number;
}

/**
 * The budget a host applies while its chat storage group-commits: a quarter
 * of a mebibyte, or 64 notifications, of one owner delivered and not yet
 * admitted. A group-commit batch holds at most 256 records or 1 MiB, so one
 * owner fills at most a quarter of a batch, and 32 owners at the budget stay
 * within the 8 MiB cap on retained frames.
 */
export const GROUP_COMMIT_OWNER_ADMISSION_BUDGET: CodexOwnerAdmissionBudget = {
  bytes: 256 * 1024,
  frames: 64,
};

const NOOP_RESOURCE_HANDLE: CodexRuntimeResourceRegistrationHandle = {
  update: () => {},
  unregister: () => {},
};

const DEFAULT_HOOKS: CodexRuntimeHostHooks = {
  clientInfo: () => ({
    name: 'codex-runtime',
    title: 'Codex Runtime',
    version: '0.0.0',
  }),
  registerProcess: () => NOOP_RESOURCE_HANDLE,
  registerProcessOwner: () => {},
  unregisterProcessOwner: () => {},
  recordDiagnostic: () => {},
  productDisplayName: () => 'the application',
};

let hostHooks: CodexRuntimeHostHooks = DEFAULT_HOOKS;

export function configureCodexRuntimeHostHooks(
  hooks: CodexRuntimeHostHooks,
): void {
  hostHooks = hooks;
}

export function getCodexRuntimeHostHooks(): CodexRuntimeHostHooks {
  return hostHooks;
}

export function resetCodexRuntimeHostHooksForTests(): void {
  hostHooks = DEFAULT_HOOKS;
}
