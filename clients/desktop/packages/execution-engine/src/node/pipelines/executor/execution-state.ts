import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import {
  damagedCopyPath,
  pruneDamagedCopies,
} from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  ensurePrivateLockDirectory,
  withOwnerLockFile,
} from '@canopy/execution-engine/node/lib/owner-lock-file';
import { pipelineOwnerFence } from '@canopy/execution-engine/node/pipelines/executor/owner-fence';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createPendingStep,
  isStepTerminal,
  snapshotRetryAttempt,
} from './retry-utils';
import { normalizeAgentModelConfig } from '@canopy/execution-engine/execution-types';
import type { AgentProviderType } from '@canopy/agent-transcript';
import { isModelHarness } from '@canopy/execution-engine/model-harnesses';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import { redactSecrets } from '@canopy/execution-engine/lib/redaction';
import { relativeInsideByNameOrRealpath } from '@canopy/execution-engine/node/lib/path-safety';
import { validateId } from '@canopy/execution-engine/node/lib/validation';
import { syncDirectory, writeFileAtomically } from '../../lib/atomic-file';
import { isStorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import type {
  AgentRecoveryCheckpoint,
  ExecutionRerunContext,
  SharedPipelineExecutionSource,
  ExecutionState,
  ExecutionSummary,
  IterationSnapshot,
  JobResult,
  NormalizedJob,
  PipelineStatusReason,
  PipelineStatusReasonCode,
  PipelineStatusReasonKind,
  ReportOutputs,
  RetryAttempt,
  StepResult,
} from './types';
import type {
  CancelMatrixVariantRequest,
  CuratedPipelineExecutionSource,
  JobGroupResult,
  MaterializedJob,
  PipelineAgentChatAddress,
  PipelineExecutionInitiator,
  PipelineJsonValue,
  PipelinePauseCheckpoint,
  PipelineModelAliasPreference,
  RetryMatrixJobRequest,
} from '@canopy/execution-engine/types/pipeline';
import { isPipelineJsonValue } from '@canopy/execution-engine/pipelines/json-values';
import { encodeMatrixIpcErrorMessage } from '@canopy/execution-engine/types/pipeline';
import {
  refreshAllJobGroups,
  rematerializeJobDefinitions,
} from '@canopy/execution-engine/node/pipelines/executor/job-scheduler';

import {
  endExecutionPause,
  resetExecutionPauseClock,
} from '@canopy/execution-engine/node/pipelines/executor/execution-pause-clock';

export const CURRENT_EXECUTION_STATE_VERSION = 10;
export type ExecutionStateWriteRefusal =
  | 'owned_by_other_process'
  | 'owner_fenced'
  | 'newer_version'
  | 'unreadable'
  | 'damaged_copy_failed';

const EXECUTION_STATE_REFUSAL_MESSAGES: Record<
  ExecutionStateWriteRefusal,
  string
> = {
  owned_by_other_process:
    'Another process is running this workflow run, so it was not changed.',
  owner_fenced:
    "This runner's lease on the workflow run ended, so it was not changed.",
  newer_version:
    'This workflow run was saved by a newer version. Update to change it.',
  unreadable:
    "This workflow run's saved state could not be read, so it was not changed.",
  damaged_copy_failed:
    "This workflow run's saved state is damaged and could not be set aside, so it was not changed.",
};

export class ExecutionStateWriteRefusedError extends Error {
  public readonly code = 'EXECUTION_STATE_WRITE_REFUSED' as const;
  public constructor(
    public readonly executionId: string,
    public readonly reason: ExecutionStateWriteRefusal,
  ) {
    super(EXECUTION_STATE_REFUSAL_MESSAGES[reason]);
    this.name = 'ExecutionStateWriteRefusedError';
  }
}

export function isExecutionStateWriteRefusal(
  error: unknown,
  reason?: ExecutionStateWriteRefusal,
): error is ExecutionStateWriteRefusedError {
  return (
    error instanceof ExecutionStateWriteRefusedError &&
    (reason === undefined || error.reason === reason)
  );
}

export const EXECUTION_STATE_LOCK_TIMEOUT_MESSAGE =
  'Timed out waiting for another process to finish saving this workflow run.';
const EXECUTION_LOCK_DIRECTORY = '.locks';
const EXECUTION_LOCK_MAX_WAIT_MS = 30_000;
const INSTALLED_STATE_CACHE_LIMIT = 512;

type InstalledExecutionState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'damaged' }
  | { readonly kind: 'newer' }
  | {
      readonly kind: 'ok';
      readonly status: ExecutionState['status'];
      readonly ownerPid?: number;
      readonly ownerStartIdentity?: string;
      readonly ownerLeaseEpoch?: number;
    };

interface CachedInstall {
  readonly signature: string;
  readonly state: Extract<InstalledExecutionState, { kind: 'ok' }>;
}
const installedStateCache = new Map<string, CachedInstall>();
const pendingExecutionWrites = new Map<string, Promise<unknown>>();

function getExecutionLockPath(
  executionId: string,
  executionsDir: string,
): string {
  validateId(executionId, 'executionId');
  return path.join(
    path.resolve(executionsDir),
    EXECUTION_LOCK_DIRECTORY,
    `${executionId}.lock`,
  );
}

async function withExecutionWriteLock<T>(
  executionId: string,
  executionsDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = getExecutionLockPath(executionId, executionsDir);
  const run = async (): Promise<T> => {
    await fs.mkdir(executionsDir, { recursive: true });
    await ensurePrivateLockDirectory(path.dirname(lockPath));
    return withOwnerLockFile(lockPath, operation, {
      maxWaitMs: EXECUTION_LOCK_MAX_WAIT_MS,
      timeoutMessage: EXECUTION_STATE_LOCK_TIMEOUT_MESSAGE,
    });
  };
  const previous = pendingExecutionWrites.get(lockPath) ?? Promise.resolve();
  const pending = previous.then(run, run);
  pendingExecutionWrites.set(lockPath, pending);
  try {
    return await pending;
  } finally {
    if (pendingExecutionWrites.get(lockPath) === pending)
      pendingExecutionWrites.delete(lockPath);
  }
}

function rememberInstalledState(
  statePath: string,
  signature: string | null,
  state: ExecutionState,
): void {
  const key = path.resolve(statePath);
  installedStateCache.delete(key);
  if (signature === null) return;
  installedStateCache.set(key, {
    signature,
    state: {
      kind: 'ok',
      status: state.status,
      ownerPid: state.owner_pid,
      ownerStartIdentity: state.owner_start_identity,
      ownerLeaseEpoch: state.owner_lease_epoch,
    },
  });
  if (installedStateCache.size > INSTALLED_STATE_CACHE_LIMIT) {
    const oldest = installedStateCache.keys().next().value;
    if (oldest !== undefined) installedStateCache.delete(oldest);
  }
}

function forgetInstalledState(statePath: string): void {
  installedStateCache.delete(path.resolve(statePath));
}

async function readInstalledExecutionState(
  executionId: string,
  executionsDir: string,
): Promise<InstalledExecutionState> {
  let raw: string;
  try {
    raw = await fs.readFile(
      getExecutionStatePath(executionId, executionsDir),
      'utf8',
    );
  } catch (error) {
    return {
      kind: fileErrorCode(error) === 'ENOENT' ? 'absent' : 'unreadable',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'damaged' };
  }
  if (!isRecord(parsed)) return { kind: 'damaged' };
  if (
    typeof parsed.version === 'number' &&
    Number.isInteger(parsed.version) &&
    parsed.version > CURRENT_EXECUTION_STATE_VERSION
  )
    return { kind: 'newer' };
  try {
    const state = parseExecutionStateDocument(
      parsed,
      executionId,
      executionsDir,
    );
    return {
      kind: 'ok',
      status: state.status,
      ownerPid: state.owner_pid,
      ownerStartIdentity: state.owner_start_identity,
      ownerLeaseEpoch: state.owner_lease_epoch,
    };
  } catch {
    return { kind: 'damaged' };
  }
}

/**
 * Refuses a write the installed owner fence does not admit (CAN-6198): a
 * live run another owner holds, or any write once this process's lease is
 * gone. `installed` is null when no readable state is stored.
 */
async function refuseForeignExecutionOwner(
  executionId: string,
  installed: Extract<InstalledExecutionState, { kind: 'ok' }> | null,
): Promise<void> {
  const refusal = await pipelineOwnerFence().refuseWrite(
    installed && {
      status: installed.status,
      owner_pid: installed.ownerPid,
      owner_start_identity: installed.ownerStartIdentity,
      owner_lease_epoch: installed.ownerLeaseEpoch,
    },
  );
  if (refusal !== null)
    throw new ExecutionStateWriteRefusedError(executionId, refusal);
}

async function admitExecutionWrite(
  executionId: string,
  executionsDir: string,
): Promise<void> {
  const statePath = getExecutionStatePath(executionId, executionsDir);
  const signature = await readStateFileSignature(statePath);
  const cached = installedStateCache.get(path.resolve(statePath));
  const installed =
    signature !== null && cached?.signature === signature
      ? cached.state
      : await readInstalledExecutionState(executionId, executionsDir);
  switch (installed.kind) {
    case 'absent':
      return refuseForeignExecutionOwner(executionId, null);
    case 'unreadable':
      throw new ExecutionStateWriteRefusedError(executionId, 'unreadable');
    case 'newer':
      throw new ExecutionStateWriteRefusedError(executionId, 'newer_version');
    case 'damaged':
      await refuseForeignExecutionOwner(executionId, null);
      try {
        await fs.copyFile(
          statePath,
          damagedCopyPath(statePath),
          fsConstants.COPYFILE_EXCL,
        );
      } catch {
        throw new ExecutionStateWriteRefusedError(
          executionId,
          'damaged_copy_failed',
        );
      }
      await pruneDamagedCopies(statePath);
      return;
    case 'ok':
      await refuseForeignExecutionOwner(executionId, installed);
  }
}

export async function deleteExecutionState(
  executionId: string,
  executionsDir: string,
): Promise<void> {
  await withExecutionWriteLock(executionId, executionsDir, async () => {
    const installed = await readInstalledExecutionState(
      executionId,
      executionsDir,
    );
    if (installed.kind === 'unreadable' || installed.kind === 'damaged')
      throw new ExecutionStateWriteRefusedError(executionId, 'unreadable');
    if (installed.kind === 'newer')
      throw new ExecutionStateWriteRefusedError(executionId, 'newer_version');
    await refuseForeignExecutionOwner(
      executionId,
      installed.kind === 'ok' ? installed : null,
    );
    const statePath = getExecutionStatePath(executionId, executionsDir);
    for (const filePath of [
      statePath,
      getExecutionCancellationPath(executionId, executionsDir),
    ]) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (fileErrorCode(error) !== 'ENOENT') throw error;
      }
    }
    await pruneDamagedCopies(statePath, 0);
    forgetInstalledState(statePath);
  });
}

export type RestoredExecutionStateInstall = 'installed' | 'already_present';

export async function installRestoredExecutionState(
  executionId: string,
  executionsDir: string,
  document: Readonly<Record<string, unknown>>,
  options?: {
    /**
     * Runs under the execution's write lock before the state is installed,
     * only when it will be: a handoff restores the execution's directory
     * here (CAN-6198), so no concurrent restore or writer sees one without
     * the other.
     */
    readonly prepare?: () => Promise<void>;
    /** Undoes `prepare` under the same lock when the install fails. */
    readonly rollback?: (error: unknown) => Promise<void>;
  },
): Promise<RestoredExecutionStateInstall> {
  validateId(executionId, 'executionId');
  if (document.id !== executionId) {
    throw new Error(
      `Archived execution state identity mismatch: expected "${executionId}"`,
    );
  }
  return withExecutionWriteLock<RestoredExecutionStateInstall>(
    executionId,
    executionsDir,
    async () => {
      const installed = await readInstalledExecutionState(
        executionId,
        executionsDir,
      );
      const statePath = getExecutionStatePath(executionId, executionsDir);
      switch (installed.kind) {
        case 'ok':
        case 'newer': {
          const handle = await fs.open(statePath, 'r+');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          await syncDirectory(executionsDir);
          return 'already_present';
        }
        case 'unreadable':
          throw new ExecutionStateWriteRefusedError(executionId, 'unreadable');
        case 'damaged':
          // A runner whose lease ended restores nothing (CAN-6198).
          await refuseForeignExecutionOwner(executionId, null);
          try {
            await fs.copyFile(
              statePath,
              damagedCopyPath(statePath),
              fsConstants.COPYFILE_EXCL,
            );
          } catch {
            throw new ExecutionStateWriteRefusedError(
              executionId,
              'damaged_copy_failed',
            );
          }
          await pruneDamagedCopies(statePath);
          break;
        case 'absent':
          await refuseForeignExecutionOwner(executionId, null);
          break;
      }
      try {
        if (options?.prepare) {
          await options.prepare();
          // The lease may have ended while the directory was copied.
          await refuseForeignExecutionOwner(executionId, null);
        }
        await writeFileAtomically(
          statePath,
          JSON.stringify(document, null, 2),
          {
            encoding: 'utf8',
            durable: true,
            beforeInstall: () => refuseForeignExecutionOwner(executionId, null),
            ...(installed.kind === 'absent' ? { overwrite: false } : {}),
          },
        );
      } catch (error) {
        // Still under the lock, so no other restore sees a half-undone copy.
        await options?.rollback?.(error);
        throw error;
      }
      forgetInstalledState(statePath);
      return 'installed';
    },
  );
}

/**
 * State files can each be megabytes. Parsing a few at a time keeps a cold
 * listing from holding dozens of parsed documents in the main-process heap at
 * once; the parse itself is synchronous, so more readers would not finish
 * sooner.
 */
const EXECUTION_SUMMARY_READ_CONCURRENCY = 8;
/** Executions directories whose summaries stay cached (most recent first). */
const EXECUTION_SUMMARY_CACHE_DIRECTORY_LIMIT = 16;

/**
 * Version 7 was the short-lived PR 2047 persistence shape. Keep its nested
 * foreach fields private to the migration boundary so they cannot leak back
 * into the current pipeline or execution contracts.
 */
interface LegacyV7ChildResult extends JobResult {
  id: string;
  index: number;
  key?: string;
  item: PipelineJsonValue;
  name: string;
  resolved_max_iterations?: number;
}

interface LegacyV7JobResult extends JobResult {
  children?: LegacyV7ChildResult[];
  resolved_max_parallel?: number;
}

interface LegacyV7NormalizedJob extends NormalizedJob {
  foreach?: PipelineJsonValue[] | Record<string, PipelineJsonValue>;
  foreach_expression?: string;
  max_parallel?: number;
  max_parallel_expression?: string;
}

type LegacyV7StatusReason = Omit<PipelineStatusReason, 'source'> & {
  source: PipelineStatusReason['source'] & { matrix_child_id?: string };
};

type LegacyV7PendingInput = NonNullable<ExecutionState['pending_input']> & {
  matrix_child_id?: string;
  matrix_index?: number;
  matrix_key?: string;
};

type LegacyV7ExecutionState = Omit<
  ExecutionState,
  'pipeline_snapshot' | 'jobs' | 'status_reasons' | 'pending_input'
> & {
  pipeline_snapshot: Omit<ExecutionState['pipeline_snapshot'], 'jobs'> & {
    jobs: Record<string, LegacyV7NormalizedJob>;
  };
  jobs: Record<string, LegacyV7JobResult>;
  status_reasons: LegacyV7StatusReason[];
  pending_input?: LegacyV7PendingInput;
};

function asLegacyV7State(state: ExecutionState): LegacyV7ExecutionState {
  return state;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * A pause that stopped work at a checkpoint rather than on a provider error:
 * shutdown, sign-in, a lost remote owner (CAN-6102) or a host rollover
 * (CAN-6199). Resume picks each up the same way.
 */
function isCheckpointPauseReason(kind: PipelineStatusReasonKind): boolean {
  return (
    kind === 'app_shutdown' ||
    kind === 'provider_sign_in' ||
    kind === 'owner_lost' ||
    kind === 'host_rollover'
  );
}

function isPipelineStatusReasonKind(
  value: unknown,
): value is PipelineStatusReasonKind {
  switch (value) {
    case 'provider_sign_in':
    case 'app_shutdown':
    case 'owner_lost':
    case 'host_rollover':
    case 'input_required':
    case 'action_paused':
    case 'provider_authentication_required':
    case 'provider_usage_limit':
    case 'provider_temporarily_unavailable':
      return true;
    default:
      return false;
  }
}

function isAgentProviderType(value: unknown): value is AgentProviderType {
  switch (value) {
    case 'claude':
    case 'codex':
    case 'ollama':
    case 'cursor':
    case 'opencode':
    case 'copilot':
      return true;
    default:
      return false;
  }
}

function isPipelineStatusReasonCode(
  value: unknown,
): value is PipelineStatusReasonCode {
  switch (value) {
    case 'provider_sign_in':
    case 'app_shutdown':
    case 'owner_lost':
    case 'host_rollover':
    case 'input_requested':
    case 'action_requested_pause':
    case 'authentication_failed':
    case 'unauthorized':
    case 'oauth_organization_forbidden':
    case 'http_401':
    case 'rate_limit':
    case 'usage_limit_exceeded':
    case 'credits_depleted':
    case 'http_429':
    case 'model_capacity':
    case 'server_overloaded':
    case 'internal_server_error':
    case 'http_5xx':
    case 'connection_failed':
    case 'stream_disconnected':
    case 'provider_timeout':
      return true;
    default:
      return false;
  }
}

export interface ResumePoint {
  jobId: string;
  childId?: string;
  stepId?: string;
  stepIndex: number;
}

/**
 * Where the store keeps one execution (CAN-6198): its state file, its
 * cancellation marker and its directory of logs, outputs and host-step
 * journals. A handoff between runner incarnations carries all three.
 */
export function executionStoreEntries(
  executionId: string,
  executionsDir: string,
): { state: string; cancellation: string; directory: string } {
  return {
    state: getExecutionStatePath(executionId, executionsDir),
    cancellation: getExecutionCancellationPath(executionId, executionsDir),
    directory: path.join(path.resolve(executionsDir), executionId),
  };
}

function getExecutionStatePath(
  executionId: string,
  executionsDir: string,
): string {
  return getExecutionArtifactPath(executionId, executionsDir, '.json');
}

function getExecutionCancellationPath(
  executionId: string,
  executionsDir: string,
): string {
  return getExecutionArtifactPath(executionId, executionsDir, '.cancel');
}

function getExecutionArtifactPath(
  executionId: string,
  executionsDir: string,
  extension: '.json' | '.cancel',
): string {
  validateId(executionId, 'executionId');
  const resolvedExecutionsDir = path.resolve(executionsDir);
  const artifactPath = path.resolve(
    resolvedExecutionsDir,
    `${executionId}${extension}`,
  );
  if (path.dirname(artifactPath) !== resolvedExecutionsDir) {
    throw new Error(`Invalid executionId: path escapes executions directory`);
  }
  return artifactPath;
}

function isJobTerminal(job: Pick<JobResult, 'status'> | undefined): boolean {
  return Boolean(
    job && ['success', 'failure', 'cancelled', 'skipped'].includes(job.status),
  );
}

function currentRetryAttempt(job: JobResult): number {
  return Math.max(job.retry_count ?? 0, job.retry_history?.length ?? 0);
}

function hasHardFailure(job: JobResult): boolean {
  return Object.values(job.steps).some(
    (step) => step.outcome === 'failure' && step.conclusion === 'failure',
  );
}

function resetJobForNextAttempt(
  job: JobResult,
  state: ExecutionState,
  jobId: string,
  nextAttempt: number,
): void {
  job.status = 'pending';
  job.conclusion = undefined;
  job.outcome = undefined;
  job.completed_at = undefined;
  job.outputs = {};
  job.retry_count = nextAttempt;
  job.report_outputs = undefined;
  job.iteration_count = 1;
  job.iteration_history = undefined;
  job.steps = Object.fromEntries(
    (
      state.job_definitions[jobId] ?? state.pipeline_snapshot.jobs[jobId]
    ).steps.map((step) => [step.id, createPendingStep()]),
  );
}

function cloneExecutionState(state: ExecutionState): ExecutionState {
  return structuredClone(state);
}

function deterministicReasonId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
    13,
    16,
  )}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function sanitizeDiagnosticMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = redactSecrets(
    value.replace(ANSI_PATTERN, '').trim(),
  ).slice(0, 2000);
  return normalized || undefined;
}

function compareStatusReasons(
  left: PipelineStatusReason,
  right: PipelineStatusReason,
): number {
  return (
    left.detected_at.localeCompare(right.detected_at) ||
    left.source.job_id.localeCompare(right.source.job_id) ||
    left.source.step_id.localeCompare(right.source.step_id) ||
    left.id.localeCompare(right.id)
  );
}

function normalizeStatusReason(
  value: unknown,
): PipelineStatusReason | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isPipelineStatusReasonKind(value.kind) ||
    !isPipelineStatusReasonCode(value.code) ||
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    !isIsoDate(value.detected_at) ||
    !isRecord(value.source) ||
    typeof value.source.job_id !== 'string' ||
    !value.source.job_id ||
    typeof value.source.step_id !== 'string' ||
    !value.source.step_id ||
    typeof value.source.attempt !== 'number' ||
    !Number.isInteger(value.source.attempt) ||
    value.source.attempt < 0 ||
    typeof value.source.iteration !== 'number' ||
    !Number.isInteger(value.source.iteration) ||
    value.source.iteration < 1
  ) {
    return undefined;
  }
  const provider = isAgentProviderType(value.provider)
    ? value.provider
    : undefined;
  const harness = isModelHarness(value.agent_harness)
    ? value.agent_harness
    : undefined;
  const accountScope =
    value.account_scope === 'native' ||
    value.account_scope === 'ai_credits' ||
    value.account_scope === 'local'
      ? value.account_scope
      : undefined;
  const result: LegacyV7StatusReason = {
    id: value.id,
    kind: value.kind,
    code: value.code,
    ...(provider ? { provider } : {}),
    ...(harness ? { agent_harness: harness } : {}),
    ...(typeof value.authentication_attempt_id === 'string' &&
    value.authentication_attempt_id
      ? { authentication_attempt_id: value.authentication_attempt_id }
      : {}),
    ...(accountScope ? { account_scope: accountScope } : {}),
    ...(typeof value.account_proxy_connection_id === 'string' &&
    value.account_proxy_connection_id
      ? { account_proxy_connection_id: value.account_proxy_connection_id }
      : {}),
    ...(value.auto_resume_suppressed === true
      ? { auto_resume_suppressed: true }
      : {}),
    ...(typeof value.model === 'string' && value.model.trim()
      ? { model: value.model.trim() }
      : {}),
    detected_at: new Date(value.detected_at).toISOString(),
    ...(isIsoDate(value.resets_at)
      ? { resets_at: new Date(value.resets_at).toISOString() }
      : {}),
    ...(sanitizeDiagnosticMessage(value.diagnostic_message)
      ? {
          diagnostic_message: sanitizeDiagnosticMessage(
            value.diagnostic_message,
          ),
        }
      : {}),
    source: {
      job_id: value.source.job_id,
      step_id: value.source.step_id,
      attempt: value.source.attempt,
      iteration: value.source.iteration,
      ...(typeof value.source.child_execution_id === 'string' &&
      value.source.child_execution_id
        ? { child_execution_id: value.source.child_execution_id }
        : {}),
      ...(typeof value.source.child_reason_id === 'string' &&
      UUID_PATTERN.test(value.source.child_reason_id)
        ? { child_reason_id: value.source.child_reason_id }
        : {}),
      ...(typeof value.source.matrix_child_id === 'string' &&
      value.source.matrix_child_id
        ? { matrix_child_id: value.source.matrix_child_id }
        : {}),
    },
  };
  return result;
}

function latestPauseSource(state: ExecutionState): {
  jobId: string;
  stepId: string;
  attempt: number;
  iteration: number;
  matrixChildId?: string;
} {
  const legacyState = asLegacyV7State(state);
  if (legacyState.pending_input) {
    const job = legacyState.jobs[legacyState.pending_input.job_id];
    const child = legacyState.pending_input.matrix_child_id
      ? job?.children?.find(
          (candidate) =>
            candidate.id === legacyState.pending_input?.matrix_child_id,
        )
      : undefined;
    return {
      jobId: legacyState.pending_input.job_id,
      stepId: legacyState.pending_input.step_id,
      attempt: child?.retry_count ?? job?.retry_count ?? 0,
      iteration: Math.max(
        1,
        child?.iteration_count ?? job?.iteration_count ?? 1,
      ),
      ...(child ? { matrixChildId: child.id } : {}),
    };
  }
  for (const [jobId, normalizedJob] of Object.entries(
    legacyState.pipeline_snapshot.jobs,
  )) {
    const job = legacyState.jobs[jobId];
    if (job?.status !== 'paused') continue;
    if (job.children !== undefined) {
      for (const child of job.children) {
        if (child.status !== 'paused') continue;
        const step =
          [...normalizedJob.steps].reverse().find((candidate) => {
            const result = child.steps[candidate.id];
            return Boolean(
              result?.input_request ||
              result?.status === 'paused' ||
              result?.started_at ||
              result?.completed_at,
            );
          }) ?? normalizedJob.steps[0];
        return {
          jobId,
          stepId: step?.id ?? 'pause',
          attempt: child.retry_count ?? 0,
          iteration: Math.max(1, child.iteration_count ?? 1),
          matrixChildId: child.id,
        };
      }
    }
    const step =
      [...normalizedJob.steps].reverse().find((candidate) => {
        const result = job.steps[candidate.id];
        return Boolean(
          result?.input_request ||
          result?.status === 'paused' ||
          result?.started_at ||
          result?.completed_at,
        );
      }) ?? normalizedJob.steps[0];
    return {
      jobId,
      stepId: step?.id ?? 'pause',
      attempt: job.retry_count ?? 0,
      iteration: Math.max(1, job.iteration_count ?? 1),
    };
  }
  return { jobId: 'pipeline', stepId: 'pause', attempt: 0, iteration: 1 };
}

function fallbackPauseReason(state: ExecutionState): PipelineStatusReason {
  const source = latestPauseSource(state);
  const inputRequired = Boolean(state.pending_input);
  const result: LegacyV7StatusReason = {
    id: deterministicReasonId(
      `${state.id}:${inputRequired ? 'input' : 'action'}:${source.jobId}:${source.matrixChildId ?? ''}:${source.stepId}`,
    ),
    kind: inputRequired ? 'input_required' : 'action_paused',
    code: inputRequired ? 'input_requested' : 'action_requested_pause',
    detected_at: state.started_at,
    source: {
      job_id: source.jobId,
      step_id: source.stepId,
      attempt: source.attempt,
      iteration: source.iteration,
      ...(source.matrixChildId
        ? { matrix_child_id: source.matrixChildId }
        : {}),
    },
  };
  return result;
}

function normalizeStatusReasons(
  state: ExecutionState,
  options: { allowEmptyPaused?: boolean } = {},
): void {
  const reasons = Array.isArray(state.status_reasons)
    ? state.status_reasons
        .map(normalizeStatusReason)
        .filter((reason): reason is PipelineStatusReason => Boolean(reason))
    : [];
  const unique = new Map(reasons.map((reason) => [reason.id, reason]));
  state.status_reasons = Array.from(unique.values()).sort(compareStatusReasons);
  if (
    state.status === 'paused' &&
    state.status_reasons.length === 0 &&
    options.allowEmptyPaused !== true
  ) {
    state.status_reasons = [fallbackPauseReason(state)];
  }
  if (state.status !== 'paused' && state.version < 6) {
    state.status_reasons = [];
  }
}

function normalizeRecoveryCheckpoint(
  value: unknown,
  executionOutputDir: string,
): AgentRecoveryCheckpoint | undefined {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    typeof value.reason_id !== 'string' ||
    !UUID_PATTERN.test(value.reason_id) ||
    (value.action !== 'agent-prompt' && value.action !== 'agent-resume') ||
    (value.provider !== 'claude' &&
      value.provider !== 'codex' &&
      value.provider !== 'copilot' &&
      value.provider !== 'opencode' &&
      value.provider !== 'ollama') ||
    typeof value.had_agent_activity !== 'boolean' ||
    (value.strategy !== 'continue_session' &&
      value.strategy !== 'restart_step') ||
    typeof value.recovery_count !== 'number' ||
    !Number.isInteger(value.recovery_count) ||
    value.recovery_count < 0 ||
    !isIsoDate(value.paused_at) ||
    typeof value.failure_message !== 'string'
  ) {
    return undefined;
  }
  if (
    value.version === 2 &&
    value.harness !== 'claude' &&
    value.harness !== 'copilot' &&
    value.harness !== 'opencode' &&
    value.harness !== 'codex'
  ) {
    return undefined;
  }
  if (
    value.had_agent_activity &&
    (typeof value.session_id !== 'string' || !value.session_id)
  ) {
    return undefined;
  }
  if (
    (value.had_agent_activity && value.strategy !== 'continue_session') ||
    (!value.had_agent_activity && value.strategy !== 'restart_step')
  ) {
    return undefined;
  }
  let transcriptFile: string | undefined;
  if (typeof value.transcript_file === 'string' && value.transcript_file) {
    const resolved = path.resolve(value.transcript_file);
    if (isInsideExecutionOutput(resolved, executionOutputDir)) {
      transcriptFile = resolved;
    }
  }
  return {
    version: 2,
    reason_id: value.reason_id,
    ...(typeof value.account_proxy_connection_id === 'string' &&
    value.account_proxy_connection_id
      ? { account_proxy_connection_id: value.account_proxy_connection_id }
      : {}),
    action: value.action,
    provider: value.provider,
    harness:
      value.harness === 'claude' ||
      value.harness === 'codex' ||
      value.harness === 'copilot' ||
      value.harness === 'opencode'
        ? value.harness
        : value.provider === 'codex' ||
            value.provider === 'copilot' ||
            value.provider === 'opencode'
          ? value.provider
          : 'claude',
    ...(typeof value.step_id === 'string' && value.step_id
      ? { step_id: value.step_id }
      : {}),
    ...(typeof value.session_id === 'string' && value.session_id
      ? { session_id: value.session_id }
      : {}),
    had_agent_activity: value.had_agent_activity,
    strategy: value.strategy,
    recovery_count: value.recovery_count,
    paused_at: new Date(value.paused_at).toISOString(),
    ...(transcriptFile ? { transcript_file: transcriptFile } : {}),
    failure_message:
      sanitizeDiagnosticMessage(value.failure_message) ??
      'Agent provider request failed',
  };
}

function normalizeRecoveryCheckpoints(
  state: ExecutionState,
  executionsDir: string,
): void {
  const outputDir = path.resolve(executionsDir, state.id);
  for (const job of Object.values(asLegacyV7State(state).jobs)) {
    const results: JobResult[] =
      job.children !== undefined ? job.children : [job];
    for (const result of results) {
      for (const step of Object.values(result.steps)) {
        step.agent_recovery = normalizeRecoveryCheckpoint(
          step.agent_recovery,
          outputDir,
        );
        if (!step.agent_recovery) delete step.agent_recovery;
        if (
          typeof step.recovery_count !== 'number' ||
          !Number.isInteger(step.recovery_count) ||
          step.recovery_count < 0
        ) {
          step.recovery_count = step.agent_recovery?.recovery_count;
        }
      }
    }
  }
}

function normalizeExecutionModelAliasPreference(
  raw: unknown,
): PipelineModelAliasPreference | undefined {
  if (!isRecord(raw) || typeof raw.mode !== 'string') {
    return undefined;
  }
  if (raw.mode === 'reset') {
    return { mode: 'reset' };
  }
  if (raw.mode === 'agent') {
    const agentId = typeof raw.agent_id === 'string' ? raw.agent_id.trim() : '';
    return agentId.startsWith('agent_model_')
      ? { mode: 'agent', agent_id: agentId }
      : undefined;
  }
  if (raw.mode === 'inline') {
    const base = typeof raw.base === 'string' ? raw.base.trim() : '';
    if (!base) {
      return undefined;
    }
    if (
      raw.instructions !== undefined &&
      typeof raw.instructions !== 'string'
    ) {
      return undefined;
    }
    const pluginCollectionId =
      raw.plugin_collection_id === undefined
        ? undefined
        : typeof raw.plugin_collection_id === 'string'
          ? raw.plugin_collection_id.trim()
          : '';
    if (raw.plugin_collection_id !== undefined && !pluginCollectionId) {
      return undefined;
    }
    return {
      mode: 'inline',
      base,
      ...(raw.instructions !== undefined
        ? { instructions: raw.instructions }
        : {}),
      ...(pluginCollectionId
        ? { plugin_collection_id: pluginCollectionId }
        : {}),
    };
  }
  return undefined;
}

function normalizeExecutionModelAliasPreferences(
  raw: unknown,
): Record<string, PipelineModelAliasPreference> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized: Record<string, PipelineModelAliasPreference> = {};
  for (const [aliasId, preference] of Object.entries(raw)) {
    const trimmedAliasId = aliasId.trim();
    if (!trimmedAliasId) {
      continue;
    }
    const normalizedPreference =
      normalizeExecutionModelAliasPreference(preference);
    if (normalizedPreference) {
      normalized[trimmedAliasId] = normalizedPreference;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function modelConfigEnv(state: ExecutionState): Record<string, string> {
  const resolved = normalizeAgentModelConfig(state.model_config) ?? {
    fastMode: false,
  };
  return {
    [brandEnvName('MODEL_CONFIG')]: JSON.stringify(resolved),
    [brandEnvName('FAST_MODE_ENABLED')]: String(resolved.fastMode === true),
  };
}

function cloneIterationSnapshots(
  snapshots: IterationSnapshot[] | undefined,
): IterationSnapshot[] | undefined {
  if (!snapshots) {
    return undefined;
  }

  return snapshots.map((snapshot) => ({
    ...snapshot,
    iteration: snapshot.iteration + 1,
  }));
}

function cloneRetryAttempts(
  attempts: RetryAttempt[] | undefined,
): RetryAttempt[] | undefined {
  if (!attempts) {
    return undefined;
  }

  return attempts.map((attempt) => ({
    ...attempt,
    iteration_history: cloneIterationSnapshots(attempt.iteration_history),
  }));
}

function jobHasStarted(job: JobResult): boolean {
  if (job.started_at) {
    return true;
  }

  if (
    job.status === 'running' ||
    job.status === 'restarting' ||
    job.status === 'paused' ||
    job.status === 'success' ||
    job.status === 'failure' ||
    job.status === 'cancelled'
  ) {
    return true;
  }

  return Object.values(job.steps).some(
    (step) => step.started_at !== undefined || step.completed_at !== undefined,
  );
}

function migrateExecutionStateV1ToV2(state: ExecutionState): ExecutionState {
  const migrated = state;
  migrated.version = 2;

  if (migrated.parent_iteration !== undefined) {
    migrated.parent_iteration += 1;
  }

  for (const job of Object.values(migrated.jobs)) {
    if (
      jobHasStarted(job) &&
      job.iteration_count !== undefined &&
      job.iteration_count >= 0
    ) {
      job.iteration_count += 1;
    }

    job.iteration_history = cloneIterationSnapshots(job.iteration_history);
    job.retry_history = cloneRetryAttempts(job.retry_history);
  }

  return migrated;
}

function migrateExecutionStateV3ToV4(state: ExecutionState): ExecutionState {
  const migrated = state;
  migrated.version = 4;
  migrated.shared_pipeline_source = undefined;
  return migrated;
}

function migrateExecutionStateV4ToV5(state: ExecutionState): ExecutionState {
  const migrated = state;
  migrated.version = 5;
  const normalized = normalizeAgentModelConfig(migrated.model_config);
  if (normalized) {
    migrated.model_config = normalized;
  } else if (typeof migrated.codex_fast_mode_enabled === 'boolean') {
    migrated.model_config = { fastMode: migrated.codex_fast_mode_enabled };
  } else {
    migrated.model_config = undefined;
  }
  migrated.codex_fast_mode_enabled = undefined;
  migrated.env = { ...migrated.env, ...modelConfigEnv(migrated) };
  return migrated;
}

function migrateExecutionStateV5ToV6(state: ExecutionState): ExecutionState {
  const migrated = state;
  migrated.version = 6;
  migrated.status_reasons = [];
  normalizeStatusReasons(migrated);
  return migrated;
}

function migrateExecutionStateV6ToV7(state: ExecutionState): ExecutionState {
  const migrated = state;
  normalizeStatusReasons(migrated);
  migrated.version = 7;
  return migrated;
}

function toMaterializedDefinition(
  logicalJobId: string,
  physicalJobId: string,
  job: LegacyV7NormalizedJob,
): MaterializedJob {
  const definition = { ...job };
  delete definition.strategy;
  delete definition.foreach;
  delete definition.foreach_expression;
  delete definition.max_parallel;
  delete definition.max_parallel_expression;
  return {
    ...definition,
    physical_job_id: physicalJobId,
    logical_job_id: logicalJobId,
  };
}

function migrateExecutionStateV7ToV8(state: ExecutionState): ExecutionState {
  const legacy = asLegacyV7State(state);
  const jobs: Record<string, JobResult> = {};
  const jobDefinitions: Record<string, MaterializedJob> = {};
  const jobGroups: Record<string, JobGroupResult> = {};
  const logicalJobs: Record<string, NormalizedJob> = {};
  const legacyChildIds = new Map<string, string>();

  for (const [logicalJobId, logicalJob] of Object.entries(
    legacy.pipeline_snapshot.jobs,
  )) {
    const currentLogicalJob = { ...logicalJob };
    delete currentLogicalJob.foreach;
    delete currentLogicalJob.foreach_expression;
    delete currentLogicalJob.max_parallel;
    delete currentLogicalJob.max_parallel_expression;
    logicalJobs[logicalJobId] = currentLogicalJob;
    const legacyResult = legacy.jobs[logicalJobId];
    const wasForeach =
      logicalJob.foreach !== undefined ||
      logicalJob.foreach_expression !== undefined ||
      legacyResult?.children !== undefined;
    if (!wasForeach) {
      if (legacyResult) {
        jobDefinitions[logicalJobId] = toMaterializedDefinition(
          logicalJobId,
          logicalJobId,
          logicalJob,
        );
        jobs[logicalJobId] = legacyResult;
      }
      jobGroups[logicalJobId] = {
        job_id: logicalJobId,
        kind: 'single',
        expansion: 'expanded',
        variant_job_ids: legacyResult ? [logicalJobId] : [],
        status: legacyResult?.status ?? 'failure',
        conclusion: legacyResult?.conclusion,
        outcome: legacyResult?.outcome,
        started_at: legacyResult?.started_at,
        completed_at: legacyResult?.completed_at,
      };
      continue;
    }

    if (!legacyResult?.children) {
      jobGroups[logicalJobId] = {
        job_id: logicalJobId,
        kind: 'matrix',
        expansion: 'failure',
        variant_job_ids: [],
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        error:
          'Legacy foreach expansion was not materialized before migration. Convert the source workflow to strategy.matrix and start a new execution.',
        completed_at: legacyResult?.completed_at,
        legacy_foreach_v7: true,
      };
      continue;
    }

    const variantJobIds: string[] = [];
    for (
      let position = 0;
      position < legacyResult.children.length;
      position += 1
    ) {
      const child = legacyResult.children[position];
      const physicalJobId = `__matrix__${logicalJobId}__${String(position)}`;
      const baseDefinition = toMaterializedDefinition(
        logicalJobId,
        physicalJobId,
        logicalJob,
      );
      const values = {
        item: structuredClone(child.item),
        index: child.index,
        ...(child.key !== undefined ? { key: child.key } : {}),
      };
      jobDefinitions[physicalJobId] = {
        ...baseDefinition,
        name: child.name,
        ...(child.resolved_max_iterations === undefined
          ? {}
          : { max_iterations: child.resolved_max_iterations }),
        matrix: {
          index: position,
          total: legacyResult.children.length,
          values,
        },
        artifact_locator: {
          job_id: logicalJobId,
          matrix_child_id: child.id,
        },
      };
      const childResult: JobResult = structuredClone(child);
      for (const legacyField of [
        'id',
        'index',
        'key',
        'item',
        'name',
        'resolved_max_iterations',
      ]) {
        Reflect.deleteProperty(childResult, legacyField);
      }
      jobs[physicalJobId] = childResult;
      variantJobIds.push(physicalJobId);
      legacyChildIds.set(`${logicalJobId}\0${child.id}`, physicalJobId);
    }
    jobGroups[logicalJobId] = {
      job_id: logicalJobId,
      kind: 'matrix',
      expansion: 'expanded',
      variant_job_ids: variantJobIds,
      status: legacyResult.status,
      conclusion: legacyResult.conclusion,
      outcome: legacyResult.outcome,
      started_at: legacyResult.started_at,
      completed_at: legacyResult.completed_at,
      resolved_max_parallel: legacyResult.resolved_max_parallel,
      fail_fast: false,
      legacy_foreach_v7: true,
    };
  }

  const rewrittenReasons = legacy.status_reasons.map((reason) => {
    const childId = reason.source.matrix_child_id;
    if (!childId) return reason;
    const physicalJobId = legacyChildIds.get(
      `${reason.source.job_id}\0${childId}`,
    );
    if (!physicalJobId) return reason;
    const source = structuredClone(reason.source);
    delete source.matrix_child_id;
    return { ...reason, source: { ...source, job_id: physicalJobId } };
  });

  const pendingPauses: PipelinePauseCheckpoint[] = [];
  for (const [physicalJobId, job] of Object.entries(jobs)) {
    if (job.status !== 'paused') continue;
    const definition = jobDefinitions[physicalJobId];
    const pausedEntry = Object.entries(job.steps).find(
      ([, step]) =>
        step.input_request || step.pause_requested || step.status === 'paused',
    );
    const fallbackStepId = definition.steps.find(
      (step) => !isStepTerminal(job.steps[step.id]),
    )?.id;
    const stepId = pausedEntry?.[0] ?? fallbackStepId;
    if (!stepId) continue;
    const step = job.steps[stepId];
    step.pause_requested = true;
    const reason = rewrittenReasons.find(
      (candidate) =>
        candidate.source.job_id === physicalJobId &&
        candidate.source.step_id === stepId &&
        (candidate.kind === 'input_required' ||
          candidate.kind === 'action_paused'),
    );
    pendingPauses.push({
      id:
        reason?.id ??
        deterministicReasonId(`${legacy.id}:pause:${physicalJobId}:${stepId}`),
      kind: step.input_request ? 'input' : 'action',
      job_id: physicalJobId,
      logical_job_id: definition.logical_job_id,
      step_id: stepId,
      attempt: reason?.source.attempt ?? job.retry_count ?? 0,
      iteration: reason?.source.iteration ?? job.iteration_count ?? 1,
      detected_at: reason?.detected_at ?? legacy.started_at,
      ...(step.input_request ? { request: step.input_request } : {}),
    });
  }

  const migrated: ExecutionState = {
    ...legacy,
    version: 8,
    pipeline_snapshot: {
      ...legacy.pipeline_snapshot,
      jobs: logicalJobs,
    },
    jobs,
    job_definitions: jobDefinitions,
    job_groups: jobGroups,
    pending_pauses: pendingPauses,
    status_reasons: rewrittenReasons,
    pending_input:
      pendingPauses.length === 1 && pendingPauses[0].request
        ? {
            job_id: pendingPauses[0].job_id,
            step_id: pendingPauses[0].step_id,
            request: pendingPauses[0].request,
          }
        : undefined,
  };
  return migrated;
}

function migrateExecutionStateV8ToV9(state: ExecutionState): ExecutionState {
  state.version = 9;
  return state;
}

function migrateExecutionStateV9ToV10(state: ExecutionState): ExecutionState {
  state.version = 10;
  state.pipeline_package_snapshot = undefined;
  return state;
}

function migrateExecutionStateToCurrent(state: ExecutionState): ExecutionState {
  // loadExecutionState owns this freshly parsed object, so migrations can safely
  // mutate it instead of cloning the full execution once per version boundary.
  const v2State =
    state.version === 1 ? migrateExecutionStateV1ToV2(state) : state;
  const v3State =
    v2State.version === 2
      ? ((): ExecutionState => {
          const migrated = v2State;
          migrated.version = 3;
          migrated.pipeline_preference_locator = undefined;
          migrated.plugin_collection_preferences = undefined;
          migrated.resolved_plugin_collections = undefined;
          return migrated;
        })()
      : v2State;
  const v4State =
    v3State.version === 3 ? migrateExecutionStateV3ToV4(v3State) : v3State;
  const v5State =
    v4State.version === 4 ? migrateExecutionStateV4ToV5(v4State) : v4State;
  const v6State =
    v5State.version === 5 ? migrateExecutionStateV5ToV6(v5State) : v5State;
  const v7State =
    v6State.version === 6 ? migrateExecutionStateV6ToV7(v6State) : v6State;
  const v8State =
    v7State.version === 7 ? migrateExecutionStateV7ToV8(v7State) : v7State;
  const v9State =
    v8State.version === 8 ? migrateExecutionStateV8ToV9(v8State) : v8State;
  const v10State =
    v9State.version === 9 ? migrateExecutionStateV9ToV10(v9State) : v9State;

  if (v10State.version === CURRENT_EXECUTION_STATE_VERSION) {
    const migrated = v10State;
    const normalized = normalizeAgentModelConfig(migrated.model_config);
    migrated.model_config = normalized;
    migrated.model_alias_preferences = normalizeExecutionModelAliasPreferences(
      migrated.model_alias_preferences,
    );
    migrated.codex_fast_mode_enabled = undefined;
    migrated.env = { ...migrated.env, ...modelConfigEnv(migrated) };
    normalizeStatusReasons(migrated, { allowEmptyPaused: true });
    return migrated;
  }

  return v10State;
}

function recoverInterruptedFailureAttempt(
  state: ExecutionState,
  jobId: string,
  job: JobResult,
): boolean {
  const normalizedJob =
    state.job_definitions[jobId] ?? state.pipeline_snapshot.jobs[jobId];
  const isInterruptedHardFailure =
    job.status === 'running' && hasHardFailure(job);
  const isPersistedFailure = job.status === 'failure';

  if (!isInterruptedHardFailure && !isPersistedFailure) {
    return false;
  }

  const attempt = currentRetryAttempt(job);
  const maxRetries = normalizedJob.max_retries ?? 0;
  if (attempt < maxRetries) {
    const retryHistory = [...(job.retry_history ?? [])];
    if (retryHistory[retryHistory.length - 1]?.attempt !== attempt) {
      retryHistory.push(snapshotRetryAttempt(job, attempt));
    }

    job.retry_history = retryHistory;
    resetJobForNextAttempt(job, state, jobId, attempt + 1);
    return true;
  }

  if (normalizedJob.continue_on_error) {
    job.status = 'failure';
    job.conclusion = 'success';
    job.outcome = 'failure';
    job.completed_at ??= new Date().toISOString();
    return false;
  }

  job.status = 'failure';
  job.conclusion = 'failure';
  job.outcome = 'failure';
  job.completed_at ??= new Date().toISOString();
  return false;
}

function toSummary(state: ExecutionState): ExecutionSummary {
  const planModified =
    state.plan_hash_before !== undefined &&
    state.plan_hash_after !== undefined &&
    state.plan_hash_before !== state.plan_hash_after;
  return {
    id: state.id,
    pipeline_id: state.pipeline_id,
    pipeline_name: state.pipeline_snapshot.name,
    status: state.status,
    status_reasons: state.status_reasons.map((reason) => {
      const safeReason = structuredClone(reason);
      delete safeReason.diagnostic_message;
      return safeReason;
    }),
    started_at: state.started_at,
    completed_at: state.completed_at,
    paused_at: state.paused_at,
    paused_ms: state.paused_ms,
    cwd: state.cwd,
    event_name: state.event_name,
    project_id: state.project_id,
    worktree_id: state.worktree_id,
    planId: state.planId,
    plan_modified: planModified || undefined,
    has_plan: state.plan_hash_after !== undefined ? true : undefined,
    has_report:
      Boolean(
        state.report_outputs?.report_file ||
        state.report_outputs?.report_json_file,
      ) || undefined,
    rerun_source_id: state.rerun_source_id,
    parent_execution_id: state.parent_execution_id,
    parent_step_id: state.parent_step_id,
    parent_attempt: state.parent_attempt,
    parent_iteration: state.parent_iteration,
    hidden: state.hidden,
    trigger_source: state.trigger_source,
    execution_context: state.execution_context,
    initiator: summaryInitiator(state.initiator),
  };
}

/** The initiator without its host-only gate output and presentation. */
function summaryInitiator(
  initiator: PipelineExecutionInitiator | undefined,
): PipelineExecutionInitiator | undefined {
  if (initiator?.kind !== 'automation') return initiator;
  const { ifCommandOutput, background, ...rest } = initiator;
  void ifCommandOutput;
  void background;
  return rest;
}

function prepareExecutionStateForInstall(
  state: ExecutionState,
  executionsDir: string,
): ExecutionState {
  const currentState =
    state.version === CURRENT_EXECUTION_STATE_VERSION
      ? state
      : migrateExecutionStateToCurrent(structuredClone(state));
  const normalizedModelConfig = normalizeAgentModelConfig(
    currentState.model_config,
  );
  const persistedState: ExecutionState = {
    ...currentState,
    version: CURRENT_EXECUTION_STATE_VERSION,
    model_config: normalizedModelConfig,
    codex_fast_mode_enabled: undefined,
  };
  normalizeStatusReasons(persistedState, { allowEmptyPaused: true });
  persistedState.env = {
    ...persistedState.env,
    ...modelConfigEnv(persistedState),
  };
  validateCurrentExecutionState(persistedState, executionsDir);
  return persistedState;
}

export interface SaveExecutionStateOptions {
  /**
   * Omitted: sync the snapshot and flush its folder, reporting a failed flush
   * after the install instead of rejecting. `true`: reject that failure with
   * `StorageOutcomeUnknownError`. `false`: no sync.
   */
  readonly durable?: boolean;
  readonly cancellation?: 'clear_before' | 'clear_after';
}

interface InstallOptions extends SaveExecutionStateOptions {
  readonly expectedRevision?: string;
}

async function unlinkExecutionCancellation(
  executionId: string,
  executionsDir: string,
): Promise<void> {
  try {
    await fs.unlink(getExecutionCancellationPath(executionId, executionsDir));
  } catch (error) {
    if (fileErrorCode(error) !== 'ENOENT') throw error;
  }
}

async function installUnderLock(
  persistedState: ExecutionState,
  executionsDir: string,
  options?: InstallOptions,
): Promise<boolean> {
  const targetPath = getExecutionStatePath(persistedState.id, executionsDir);
  if (
    options?.expectedRevision !== undefined &&
    (await readStateFileSignature(targetPath)) !== options.expectedRevision
  ) {
    return false;
  }
  await admitExecutionWrite(persistedState.id, executionsDir);
  if (options?.cancellation === 'clear_before') {
    await unlinkExecutionCancellation(persistedState.id, executionsDir);
  }
  try {
    try {
      await writeFileAtomically(
        targetPath,
        JSON.stringify(persistedState, null, 2),
        {
          encoding: 'utf8',
          durable: options?.durable ?? true,
          // The lease may have ended while the file was written (CAN-6198).
          beforeInstall: () =>
            refuseForeignExecutionOwner(persistedState.id, null),
        },
      );
    } catch (error) {
      if (
        options?.durable !== undefined ||
        !isStorageOutcomeUnknownError(error)
      )
        throw error;
      process.stderr.write(
        `[pipelines] ${targetPath} installed, but its folder flush failed: ${String(error)}\n`,
      );
    }
    rememberInstalledState(
      targetPath,
      await readStateFileSignature(targetPath),
      persistedState,
    );
    if (options?.cancellation === 'clear_after') {
      await unlinkExecutionCancellation(persistedState.id, executionsDir);
    }
  } catch (error) {
    forgetInstalledState(targetPath);
    throw error;
  }
  return true;
}

export async function saveExecutionState(
  state: ExecutionState,
  executionsDir: string,
  options?: SaveExecutionStateOptions,
): Promise<void> {
  await saveExecutionStateIfUnchanged(state, executionsDir, undefined, options);
}

/**
 * {@link saveExecutionState}, installing only while the file still has
 * `expectedRevision` from {@link loadExecutionStateRevision}. Resolves false,
 * having written nothing, when another install came first.
 */
export async function saveExecutionStateIfUnchanged(
  state: ExecutionState,
  executionsDir: string,
  expectedRevision: string | undefined,
  options?: SaveExecutionStateOptions,
): Promise<boolean> {
  await fs.mkdir(executionsDir, { recursive: true });
  getExecutionStatePath(state.id, executionsDir);
  const persistedState = prepareExecutionStateForInstall(state, executionsDir);
  return withExecutionWriteLock(state.id, executionsDir, () =>
    installUnderLock(persistedState, executionsDir, {
      ...options,
      expectedRevision,
    }),
  );
}

/**
 * `filePath` relative to the executions directory, or null outside it. The
 * daemon's pipeline host records paths through the canonical data root, while
 * Electron main reads the same store through the root it was given, which can
 * be a symlink (CAN-5958): a path passes lexically as named, or by realpath.
 */
export function relativeToExecutionsDir(
  executionsDir: string,
  filePath: string,
): string | null {
  return relativeInsideByNameOrRealpath(executionsDir, filePath);
}

export function isPathInsideExecutionsDir(
  executionsDir: string,
  filePath: string,
): boolean {
  return relativeToExecutionsDir(executionsDir, filePath) !== null;
}

function isInsideExecutionOutput(
  resolved: string,
  executionOutputDir: string,
): boolean {
  return relativeInsideByNameOrRealpath(executionOutputDir, resolved) !== null;
}

function assertPathInsideExecution(
  filePath: string | undefined,
  executionOutputDir: string,
  label: string,
): void {
  if (!filePath) return;
  if (!isInsideExecutionOutput(path.resolve(filePath), executionOutputDir)) {
    throw new Error(`${label} escapes the execution output directory`);
  }
}

function validateResultLogPaths(
  child: JobResult,
  executionOutputDir: string,
  label: string,
): void {
  const validateSteps = (
    steps: Record<string, StepResult>,
    label: string,
  ): void => {
    for (const [stepId, step] of Object.entries(steps)) {
      assertPathInsideExecution(
        step.log_file,
        executionOutputDir,
        `${label} step "${stepId}" log_file`,
      );
      (step.agent_recovery_history ?? []).forEach((recovery, recoveryIndex) => {
        assertPathInsideExecution(
          recovery.log_file,
          executionOutputDir,
          `${label} step "${stepId}" recovery ${recoveryIndex} log_file`,
        );
      });
    }
  };
  validateSteps(child.steps, label);
  (child.retry_history ?? []).forEach((attempt, attemptIndex) => {
    validateSteps(attempt.steps, `${label} retry ${attemptIndex}`);
  });
  (child.iteration_history ?? []).forEach((iteration, iterationIndex) => {
    validateSteps(iteration.steps, `${label} iteration ${iterationIndex}`);
  });
}

function validateForeachState(
  state: LegacyV7ExecutionState,
  executionsDir: string,
): void {
  const outputDir = path.resolve(executionsDir, state.id);
  for (const [jobId, job] of Object.entries(state.jobs)) {
    if (job.children === undefined) continue;
    const ids = new Set<string>();
    const indices = new Set<number>();
    for (let position = 0; position < job.children.length; position += 1) {
      const child = job.children[position];
      if (
        !child ||
        typeof child.id !== 'string' ||
        !/^child-[0-9a-z]{6,}$/.test(child.id)
      ) {
        throw new Error(`Job "${jobId}" has an invalid foreach child id`);
      }
      if (ids.has(child.id)) {
        throw new Error(
          `Job "${jobId}" has duplicate foreach child id "${child.id}"`,
        );
      }
      ids.add(child.id);
      if (!Number.isSafeInteger(child.index) || child.index < 0) {
        throw new Error(
          `Job "${jobId}" child "${child.id}" has an invalid index`,
        );
      }
      const expectedId = `child-${child.index.toString(36).padStart(6, '0')}`;
      if (child.id !== expectedId || child.index !== position) {
        throw new Error(
          `Job "${jobId}" child "${child.id}" has inconsistent foreach identity`,
        );
      }
      if (indices.has(child.index)) {
        throw new Error(
          `Job "${jobId}" has duplicate foreach child index ${String(child.index)}`,
        );
      }
      indices.add(child.index);
      if (!isPipelineJsonValue(child.item)) {
        throw new Error(
          `Job "${jobId}" child "${child.id}" has a non-JSON-safe item`,
        );
      }
      if (Reflect.has(child, 'children')) {
        throw new Error(
          `Job "${jobId}" child "${child.id}" contains unsupported nested foreach children`,
        );
      }
      validateResultLogPaths(child, outputDir, `Foreach child "${child.id}"`);
    }
  }

  for (const reason of state.status_reasons) {
    const parent = state.jobs[reason.source.job_id];
    if (!parent) continue;
    if (reason.source.matrix_child_id) {
      if (
        !parent.children?.some(
          (child) => child.id === reason.source.matrix_child_id,
        )
      ) {
        throw new Error(
          `Status reason "${reason.id}" references missing foreach child "${reason.source.matrix_child_id}"`,
        );
      }
    } else if (parent.children !== undefined) {
      throw new Error(
        `Status reason "${reason.id}" does not identify a foreach child`,
      );
    }
  }

  if (state.pending_input) {
    const parent = state.jobs[state.pending_input.job_id];
    if (state.pending_input.matrix_child_id) {
      const child = parent?.children?.find(
        (candidate) => candidate.id === state.pending_input?.matrix_child_id,
      );
      if (!child) {
        throw new Error(
          `Pending input references missing foreach child "${state.pending_input.matrix_child_id}"`,
        );
      }
      if (
        state.pending_input.matrix_index !== undefined &&
        state.pending_input.matrix_index !== child.index
      ) {
        throw new Error('Pending input foreach child index does not match');
      }
      if (
        state.pending_input.matrix_key !== undefined &&
        state.pending_input.matrix_key !== child.key
      ) {
        throw new Error('Pending input foreach child key does not match');
      }
    } else if (parent?.children !== undefined) {
      throw new Error('Pending input does not identify a foreach child');
    }
  }
}

/** Structural checks for the physical/logical shape introduced in version 8. */
function validateCurrentExecutionState(
  state: ExecutionState,
  executionsDir: string,
): void {
  // Callers validate after migration, so every supported version reaches here.
  if (state.version !== CURRENT_EXECUTION_STATE_VERSION) {
    throw new Error(
      `Execution state version ${String(state.version)} was not migrated before validation`,
    );
  }
  for (const key of ['jobs', 'job_definitions', 'job_groups'] as const) {
    if (!isRecord(state[key])) {
      throw new Error(`Execution state has no ${key} record`);
    }
  }
  if (!Array.isArray(state.pending_pauses)) {
    throw new Error('Execution state has no pending_pauses list');
  }
  const definitionIds = Object.keys(state.job_definitions).sort();
  const resultIds = Object.keys(state.jobs).sort();
  if (definitionIds.join('\0') !== resultIds.join('\0')) {
    throw new Error('Execution job definitions and results are inconsistent');
  }
  const members = new Set<string>();
  for (const [logicalJobId, group] of Object.entries(state.job_groups)) {
    if (!state.pipeline_snapshot.jobs[logicalJobId]) {
      throw new Error(`Job group "${logicalJobId}" has no logical definition`);
    }
    if (!Array.isArray(group.variant_job_ids)) {
      throw new Error(
        `Job group "${logicalJobId}" has no variant_job_ids list`,
      );
    }
    for (let index = 0; index < group.variant_job_ids.length; index += 1) {
      const physicalJobId = group.variant_job_ids[index];
      if (members.has(physicalJobId)) {
        throw new Error(
          `Physical job "${physicalJobId}" belongs to multiple groups`,
        );
      }
      members.add(physicalJobId);
      const definition = state.job_definitions[physicalJobId];
      if (!definition || definition.logical_job_id !== logicalJobId) {
        throw new Error(
          `Physical job "${physicalJobId}" has inconsistent logical identity`,
        );
      }
      if (group.kind === 'matrix') {
        if (definition.matrix?.index !== index) {
          throw new Error(
            `Physical job "${physicalJobId}" has inconsistent matrix index`,
          );
        }
        if (!isPipelineJsonValue(definition.matrix.values)) {
          throw new Error(
            `Physical job "${physicalJobId}" has non-JSON-safe matrix values`,
          );
        }
      }
    }
  }
  if (members.size !== definitionIds.length) {
    const orphan = definitionIds.find((id) => !members.has(id));
    throw new Error(`Physical job "${orphan ?? 'unknown'}" has no job group`);
  }
  const outputDir = path.resolve(executionsDir, state.id);
  for (const [physicalJobId, result] of Object.entries(state.jobs)) {
    validateResultLogPaths(result, outputDir, `Job "${physicalJobId}"`);
  }
  const pauseLocators = new Set<string>();
  for (const checkpoint of state.pending_pauses) {
    const locator = `${checkpoint.job_id}\0${checkpoint.step_id}`;
    if (pauseLocators.has(locator)) {
      throw new Error(
        `Job "${checkpoint.job_id}" has multiple active pause checkpoints`,
      );
    }
    pauseLocators.add(locator);
    const definition = state.job_definitions[checkpoint.job_id];
    const result = state.jobs[checkpoint.job_id];
    if (
      !definition ||
      definition.logical_job_id !== checkpoint.logical_job_id ||
      result?.status !== 'paused' ||
      !result.steps[checkpoint.step_id]?.pause_requested
    ) {
      throw new Error(`Pause checkpoint "${checkpoint.id}" is stale`);
    }
  }
}

export async function loadExecutionState(
  executionId: string,
  executionsDir: string,
): Promise<ExecutionState | null> {
  try {
    const raw = await fs.readFile(
      getExecutionStatePath(executionId, executionsDir),
      'utf8',
    );
    const parsed: unknown = JSON.parse(raw);
    return parseExecutionStateDocument(parsed, executionId, executionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * The state with the revision of the file it was read from, for
 * {@link saveExecutionStateIfUnchanged}. Every install replaces the file, so a
 * later install changes the revision.
 */
export async function loadExecutionStateRevision(
  executionId: string,
  executionsDir: string,
): Promise<{ state: ExecutionState; revision: string } | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      getExecutionStatePath(executionId, executionsDir),
      'r',
    );
  } catch (error) {
    if (fileErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
  // One handle pins one file: installs replace the file by rename, so these
  // bytes and this revision belong together, and a later install changes the
  // revision at the path.
  try {
    const stats = await handle.stat({ bigint: true });
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
    return {
      state: parseExecutionStateDocument(parsed, executionId, executionsDir),
      revision: `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`,
    };
  } finally {
    await handle.close();
  }
}

function parseExecutionStateDocument(
  document: unknown,
  executionId: string,
  executionsDir: string,
): ExecutionState {
  const parsed = document as Partial<ExecutionState> & {
    version?: unknown;
  };
  if (
    parsed.version !== 1 &&
    parsed.version !== 2 &&
    parsed.version !== 3 &&
    parsed.version !== 4 &&
    parsed.version !== 5 &&
    parsed.version !== 6 &&
    parsed.version !== 7 &&
    parsed.version !== 8 &&
    parsed.version !== 9 &&
    parsed.version !== 10
  ) {
    throw new Error(
      `Unsupported execution state version: ${String(parsed.version)}`,
    );
  }
  if (parsed.id !== executionId) {
    throw new Error(
      `Execution state identity mismatch: expected "${executionId}"`,
    );
  }
  if (
    parsed.shutdown_checkpoint &&
    (!UUID_PATTERN.test(parsed.shutdown_checkpoint.id) ||
      !isIsoDate(parsed.shutdown_checkpoint.detected_at))
  )
    delete parsed.shutdown_checkpoint;
  if (
    parsed.child_pipeline_authorizations !== undefined &&
    (!Array.isArray(parsed.child_pipeline_authorizations) ||
      !parsed.child_pipeline_authorizations.every(
        (entry: unknown): boolean =>
          isRecord(entry) &&
          typeof entry.request === 'string' &&
          typeof entry.identity === 'string' &&
          typeof entry.contentHash === 'string',
      ))
  ) {
    throw new Error('Invalid persisted child pipeline authorizations');
  }
  parsed.inputs_persisted = parsed.inputs !== undefined;
  parsed.inputs = parsed.inputs ?? {};
  parsed.rerun_context = normalizeRerunContext(parsed.rerun_context);
  parsed.shared_pipeline_source = normalizeSharedPipelineSource(
    parsed.shared_pipeline_source,
  );
  parsed.curated_pipeline_source = normalizeCuratedPipelineSource(
    parsed.curated_pipeline_source,
  );
  parsed.initiation_source = normalizeUsageInitiationSource(
    parsed.initiation_source,
  );
  parsed.initiator = normalizeExecutionInitiator(parsed.initiator);
  parsed.agent_origin = normalizeAgentChatAddress(parsed.agent_origin);
  const typedState = parsed as ExecutionState;
  if (typedState.version === 7) {
    validateForeachState(asLegacyV7State(typedState), executionsDir);
  }
  const migrated = migrateExecutionStateToCurrent(typedState);
  normalizeRecoveryCheckpoints(migrated, executionsDir);
  validateCurrentExecutionState(migrated, executionsDir);
  return migrated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeUsageInitiationSource(
  value: unknown,
): ExecutionState['initiation_source'] {
  switch (value) {
    case 'user':
    case 'hook':
    case 'automation':
    case 'app_advisor':
    case 'portal':
    case 'unknown':
      return value;
    default:
      return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function normalizeAgentChatAddress(
  value: unknown,
): PipelineAgentChatAddress | undefined {
  if (!isRecord(value)) return undefined;
  const projectId = nonEmptyString(value.projectId);
  const worktreeId = nonEmptyString(value.worktreeId);
  const chatId = nonEmptyString(value.chatId);
  return projectId && worktreeId && chatId
    ? { projectId, worktreeId, chatId }
    : undefined;
}

/** Drop a persisted initiator that does not match a known shape. */
export function normalizeExecutionInitiator(
  value: unknown,
): PipelineExecutionInitiator | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case 'user':
    case 'hook':
    case 'portal':
      return { kind: value.kind };
    case 'automation': {
      const automationId = nonEmptyString(value.automationId);
      if (!automationId) return undefined;
      const automationName = nonEmptyString(value.automationName);
      return {
        kind: 'automation',
        automationId,
        ...(automationName ? { automationName } : {}),
        ...(typeof value.ifCommandOutput === 'string'
          ? { ifCommandOutput: value.ifCommandOutput }
          : {}),
        ...(value.background === true ? { background: true } : {}),
      };
    }
    case 'app_advisor': {
      const chat = normalizeAgentChatAddress(value.chat);
      return chat ? { kind: 'app_advisor', chat } : { kind: 'app_advisor' };
    }
    case 'agent': {
      const chat = normalizeAgentChatAddress(value.chat);
      return chat ? { kind: 'agent', chat } : undefined;
    }
    default:
      return undefined;
  }
}

function normalizeRerunContext(
  rerunContext: unknown,
): ExecutionRerunContext | undefined {
  if (!isRecord(rerunContext)) {
    return undefined;
  }

  const eventData = rerunContext.event_data;
  if (!isRecord(eventData)) {
    return undefined;
  }

  const planReady = eventData.plan_ready;
  if (isRecord(planReady)) {
    const planText = planReady.plan_text;
    if (typeof planText === 'string') {
      return {
        event_data: {
          plan_ready: {
            plan_text: planText,
          },
        },
      };
    }
  }

  const taskReady = eventData.task_ready;
  if (isRecord(taskReady)) {
    const taskText = taskReady.task_text;
    if (typeof taskText === 'string') {
      return {
        event_data: {
          task_ready: {
            task_text: taskText,
          },
        },
      };
    }
  }

  return undefined;
}

export function normalizeCuratedPipelineSource(
  value: unknown,
): CuratedPipelineExecutionSource | undefined {
  if (
    !isRecord(value) ||
    typeof value.key !== 'string' ||
    typeof value.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.contentHash) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.cachedPipelinePath !== 'string' ||
    !path.isAbsolute(value.cachedPipelinePath)
  )
    return undefined;
  return {
    key: value.key,
    contentHash: value.contentHash,
    revision: value.revision,
    cachedPipelinePath: value.cachedPipelinePath,
  };
}

export function normalizeSharedPipelineSource(
  value: unknown,
): SharedPipelineExecutionSource | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    value.type !== 'shared' ||
    typeof value.serverId !== 'string' ||
    typeof value.serverName !== 'string' ||
    typeof value.remoteId !== 'string' ||
    typeof value.cachedPipelinePath !== 'string' ||
    typeof value.fetchedAt !== 'string'
  ) {
    return undefined;
  }

  return {
    type: 'shared',
    serverId: value.serverId,
    serverName: value.serverName,
    remoteId: value.remoteId,
    cachedPipelinePath: value.cachedPipelinePath,
    fetchedAt: value.fetchedAt,
  };
}

export async function setExecutionHidden(
  executionId: string,
  hidden: boolean,
  executionsDir: string,
): Promise<ExecutionState | null> {
  return withExecutionWriteLock(executionId, executionsDir, async () => {
    const state = await loadExecutionState(executionId, executionsDir);
    if (!state) {
      return null;
    }

    const next: ExecutionState = hidden
      ? { ...state, hidden: true }
      : ((): ExecutionState => {
          const copy = { ...state };
          delete copy.hidden;
          return copy;
        })();

    await installUnderLock(
      prepareExecutionStateForInstall(next, executionsDir),
      executionsDir,
    );
    return next;
  });
}

export async function requestExecutionCancellation(
  executionId: string,
  executionsDir: string,
): Promise<void> {
  // Any process may ask a run to stop, except a runner whose lease ended
  // (CAN-6198): the marker travels with the run's handoff.
  await refuseForeignExecutionOwner(executionId, null);
  await fs.mkdir(executionsDir, { recursive: true });
  await writeFileAtomically(
    getExecutionCancellationPath(executionId, executionsDir),
    'cancel',
    {
      encoding: 'utf8',
      durable: true,
      beforeInstall: () => refuseForeignExecutionOwner(executionId, null),
    },
  );
}

export async function clearExecutionCancellation(
  executionId: string,
  executionsDir: string,
): Promise<void> {
  await withExecutionWriteLock(executionId, executionsDir, async () => {
    await admitExecutionWrite(executionId, executionsDir);
    await unlinkExecutionCancellation(executionId, executionsDir);
  });
}

export async function isExecutionCancellationRequested(
  executionId: string,
  executionsDir: string,
): Promise<boolean> {
  try {
    await fs.access(getExecutionCancellationPath(executionId, executionsDir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export interface ExecutionSummaryWithState {
  summary: ExecutionSummary;
  state: ExecutionState;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await mapper(item);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      async (): Promise<void> => worker(),
    ),
  );
  return results;
}

interface CachedExecutionSummary {
  signature: string;
  summary: ExecutionSummary;
}

/**
 * Summaries derived from each state file, keyed by executions directory and
 * file name. A summary depends only on its file's contents, and every save
 * replaces the file through a rename, so an unchanged inode, size, and
 * modification and change times mean an unchanged summary. Listings stat
 * every file but parse only new or rewritten ones, and retain nothing larger
 * than the summaries. Callers receive copies, never the cached objects.
 */
const executionSummaryCache = new Map<
  string,
  Map<string, CachedExecutionSummary>
>();
/** Parses shared by overlapping listings of the same file version. */
const pendingExecutionSummaries = new Map<
  string,
  Promise<CachedExecutionSummary | null>
>();

function fileErrorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

async function readStateFileSignature(
  filePath: string,
): Promise<string | null> {
  try {
    const stats = await fs.stat(filePath, { bigint: true });
    return `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  } catch (error) {
    if (fileErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function summaryCacheFor(
  executionsDir: string,
): Map<string, CachedExecutionSummary> {
  const existing = executionSummaryCache.get(executionsDir);
  // Re-inserting keeps the most recently listed directories last, so the
  // bound below evicts the directory listed longest ago.
  executionSummaryCache.delete(executionsDir);
  const cache = existing ?? new Map<string, CachedExecutionSummary>();
  executionSummaryCache.set(executionsDir, cache);
  for (const directory of Array.from(executionSummaryCache.keys())) {
    if (executionSummaryCache.size <= EXECUTION_SUMMARY_CACHE_DIRECTORY_LIMIT)
      break;
    executionSummaryCache.delete(directory);
  }
  return cache;
}

function loadExecutionSummaryOnce(
  executionsDir: string,
  fileName: string,
  signature: string,
): Promise<CachedExecutionSummary | null> {
  const key = `${executionsDir}\0${fileName}\0${signature}`;
  const pending = pendingExecutionSummaries.get(key);
  if (pending) return pending;
  const load = (async (): Promise<CachedExecutionSummary | null> => {
    const state = await loadExecutionState(
      fileName.slice(0, -'.json'.length),
      executionsDir,
    );
    return state ? { signature, summary: toSummary(state) } : null;
  })().finally(() => {
    pendingExecutionSummaries.delete(key);
  });
  pendingExecutionSummaries.set(key, load);
  return load;
}

/**
 * Newest first, ties broken by id, with each parent's direct-child count.
 * `child_count` is assigned on the objects the caller receives.
 */
function orderExecutionSummaries<T>(
  entries: T[],
  summaryOf: (entry: T) => ExecutionSummary,
): T[] {
  const ordered = entries.sort((left, right) => {
    const startedDiff =
      new Date(summaryOf(right).started_at).getTime() -
      new Date(summaryOf(left).started_at).getTime();
    if (startedDiff !== 0) {
      return startedDiff;
    }
    return summaryOf(right).id.localeCompare(summaryOf(left).id);
  });

  const childCounts = new Map<string, number>();
  for (const entry of ordered) {
    const parentId = summaryOf(entry).parent_execution_id;
    if (parentId) {
      childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
    }
  }
  for (const entry of ordered) {
    const summary = summaryOf(entry);
    const count = childCounts.get(summary.id);
    if (count !== undefined) {
      summary.child_count = count;
    }
  }
  return ordered;
}

async function listCachedExecutionSummaries(
  executionsDir: string,
  unreadableFiles?: string[],
): Promise<ExecutionSummary[]> {
  let fileNames: string[];
  try {
    fileNames = (await fs.readdir(executionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch (error) {
    if (fileErrorCode(error) === 'ENOENT') {
      executionSummaryCache.delete(executionsDir);
      return [];
    }
    throw error;
  }

  const cache = summaryCacheFor(executionsDir);
  const present = new Set(fileNames);
  for (const fileName of Array.from(cache.keys())) {
    if (!present.has(fileName)) cache.delete(fileName);
  }

  const loaded = await mapWithConcurrency(
    fileNames,
    EXECUTION_SUMMARY_READ_CONCURRENCY,
    async (fileName): Promise<ExecutionSummary | null> => {
      try {
        const signature = await readStateFileSignature(
          path.join(executionsDir, fileName),
        );
        const cached = cache.get(fileName);
        if (signature !== null && cached?.signature === signature) {
          return cached.summary;
        }
        const entry =
          signature === null
            ? null
            : await loadExecutionSummaryOnce(
                executionsDir,
                fileName,
                signature,
              );
        // `null` means the file disappeared mid-listing (ENOENT): there is
        // nothing left to relocate or delete, so it is not reported as
        // unreadable.
        if (!entry) {
          cache.delete(fileName);
          return null;
        }
        cache.set(fileName, entry);
        return entry.summary;
      } catch {
        cache.delete(fileName);
        unreadableFiles?.push(fileName);
        return null;
      }
    },
  );

  return orderExecutionSummaries(
    loaded
      .filter((summary): summary is ExecutionSummary => summary !== null)
      .map((summary) => structuredClone(summary)),
    (summary) => summary,
  );
}

export async function listExecutionSummaries(
  executionsDir: string,
): Promise<ExecutionSummary[]> {
  return listCachedExecutionSummaries(executionsDir);
}

export interface ExecutionSummariesForArchival {
  summaries: ExecutionSummary[];
  /**
   * State files that exist but could not be loaded (corrupt JSON, unsupported
   * version, ids that fail validation, …). They cannot be attributed to any
   * worktree, so archival cleanup never deletes them — skipping them loses
   * nothing, but callers surface them as warnings instead of failing the
   * whole archive (a single foreign file in the shared executions directory
   * must not brick every worktree deletion).
   */
  unreadableFiles: string[];
}

export async function listExecutionSummariesForArchival(
  executionsDir: string,
): Promise<ExecutionSummariesForArchival> {
  const unreadableFiles: string[] = [];
  const summaries = await listCachedExecutionSummaries(
    executionsDir,
    unreadableFiles,
  );
  return { summaries, unreadableFiles };
}

/**
 * Like {@link listExecutionSummaries}, but keeps the parsed `ExecutionState`
 * alongside each summary so callers that need both (e.g. the archived
 * containers' Pipelines tab feeding `DagProgressBar` per row) parse each
 * state file exactly once instead of re-reading per execution.
 */
export async function listExecutionSummariesWithStates(
  executionsDir: string,
): Promise<ExecutionSummaryWithState[]> {
  try {
    const entries = await fs.readdir(executionsDir, { withFileTypes: true });
    const loaded = await mapWithConcurrency(
      entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')),
      EXECUTION_SUMMARY_READ_CONCURRENCY,
      async (entry): Promise<ExecutionSummaryWithState | null> => {
        try {
          const state = await loadExecutionState(
            entry.name.slice(0, -'.json'.length),
            executionsDir,
          );
          // `null` means the file disappeared mid-listing (ENOENT).
          return state ? { summary: toSummary(state), state } : null;
        } catch {
          return null;
        }
      },
    );

    return orderExecutionSummaries(
      loaded.filter(
        (entry): entry is ExecutionSummaryWithState => entry !== null,
      ),
      (entry) => entry.summary,
    );
  } catch (error) {
    if (fileErrorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function resetRunningStep(step: StepResult): StepResult {
  if (step.status !== 'running') {
    return { ...step };
  }

  return {
    status: 'pending',
    outputs: {},
    dynamic_env: {},
    agent_recovery: step.agent_recovery,
    agent_recovery_history: step.agent_recovery_history,
    recovery_count: step.recovery_count,
    // The checkpoint's Ledger agent session resumes with it.
    ...(step.agent_recovery && step.ledger_agent_session_id
      ? { ledger_agent_session_id: step.ledger_agent_session_id }
      : {}),
  };
}

function buildDownstreamJobs(state: ExecutionState): Map<string, string[]> {
  const downstream = new Map<string, string[]>();

  for (const [jobId, job] of Object.entries(state.pipeline_snapshot.jobs)) {
    for (const dependencyId of job.needs) {
      const jobs = downstream.get(dependencyId) ?? [];
      jobs.push(jobId);
      downstream.set(dependencyId, jobs);
    }
  }

  return downstream;
}

function collectRetryCone(
  state: ExecutionState,
  seedJobIds: string[],
): Set<string> {
  const downstreamJobs = buildDownstreamJobs(state);
  const queue = [...seedJobIds];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);
    for (const downstreamId of downstreamJobs.get(current) ?? []) {
      if (!visited.has(downstreamId)) {
        queue.push(downstreamId);
      }
    }
  }

  return visited;
}

function resetJobMetadata(job: JobResult): void {
  job.status = 'pending';
  job.started_at = undefined;
  job.completed_at = undefined;
  job.conclusion = undefined;
  job.outcome = undefined;
  job.outputs = {};
  job.report_outputs = undefined;
  job.iteration_count = 0;
  job.iteration_history = undefined;
}

function clearRetryMetadata(job: JobResult): void {
  job.retry_count = 0;
  job.retry_history = [];
}

function mergeReportOutputs(
  current: ReportOutputs | undefined,
  next: ReportOutputs | undefined,
): ReportOutputs | undefined {
  if (!next) {
    return current;
  }

  return {
    ...current,
    ...next,
  };
}

function collectPreservedReportOutputs(
  state: ExecutionState,
  jobId: string,
  job: JobResult,
  boundaryIndex: number,
): ReportOutputs | undefined {
  let preservedReportOutputs: ReportOutputs | undefined;
  const steps = (
    state.job_definitions[jobId] ?? state.pipeline_snapshot.jobs[jobId]
  ).steps;

  for (let index = 0; index < boundaryIndex; index += 1) {
    const stepId = steps[index].id;
    preservedReportOutputs = mergeReportOutputs(
      preservedReportOutputs,
      job.steps[stepId]?.report_outputs,
    );
  }

  return preservedReportOutputs;
}

function resetEntireJobForRetry(
  state: ExecutionState,
  jobId: string,
  job: JobResult,
): void {
  resetJobMetadata(job);
  job.steps = Object.fromEntries(
    (
      state.job_definitions[jobId] ?? state.pipeline_snapshot.jobs[jobId]
    ).steps.map((step) => [step.id, createPendingStep()]),
  );
}

function findRetryBoundaryIndex(
  state: ExecutionState,
  jobId: string,
  job: JobResult,
): number {
  return (
    state.job_definitions[jobId] ?? state.pipeline_snapshot.jobs[jobId]
  ).steps.findIndex((step) => {
    const stepResult = job.steps[step.id];
    return (
      stepResult?.status === 'failure' ||
      stepResult?.status === 'cancelled' ||
      stepResult?.outcome === 'failure' ||
      stepResult?.conclusion === 'cancelled'
    );
  });
}

function resetJobForRetry(
  state: ExecutionState,
  jobId: string,
  job: JobResult,
): void {
  const boundaryIndex = findRetryBoundaryIndex(state, jobId, job);
  if (boundaryIndex < 0) {
    clearRetryMetadata(job);
    resetEntireJobForRetry(state, jobId, job);
    return;
  }

  if (boundaryIndex === 0) {
    clearRetryMetadata(job);
  }

  const preservedReportOutputs = collectPreservedReportOutputs(
    state,
    jobId,
    job,
    boundaryIndex,
  );
  const existingJobReportOutputs = job.report_outputs;
  resetJobMetadata(job);
  job.report_outputs = preservedReportOutputs ?? existingJobReportOutputs;
  const steps = (
    state.job_definitions[jobId] ?? state.pipeline_snapshot.jobs[jobId]
  ).steps;
  for (let index = boundaryIndex; index < steps.length; index += 1) {
    job.steps[steps[index].id] = createPendingStep();
  }
}

function isExecutionTerminal(state: ExecutionState): boolean {
  return ['success', 'failure', 'cancelled'].includes(state.status);
}

export function executionHasBlockers(state: ExecutionState): boolean {
  if (state.pending_pauses.length > 0 || state.status_reasons.length > 0) {
    return true;
  }
  return Object.values(state.jobs).some((job) => job.status === 'paused');
}

export function executionHasNonTerminalWork(state: ExecutionState): boolean {
  return Object.values(state.jobs).some((job) => !isJobTerminal(job));
}

export function clearPhysicalJobBlockers(
  state: ExecutionState,
  physicalJobId: string,
): void {
  state.pending_pauses = state.pending_pauses.filter(
    (checkpoint) => checkpoint.job_id !== physicalJobId,
  );
  state.status_reasons = state.status_reasons.filter(
    (reason) => reason.source.job_id !== physicalJobId,
  );
  for (const step of Object.values(state.jobs[physicalJobId]?.steps ?? {})) {
    delete step.input_request;
    delete step.pause_requested;
    delete step.agent_recovery;
    delete step.pause_reason;
    delete step.pause_reasons;
    delete step.selected_child_reason_ids;
  }
}

function resetPhysicalJobForMatrixRetry(
  state: ExecutionState,
  physicalJobId: string,
  incrementAttempt = true,
): void {
  const job = state.jobs[physicalJobId];
  if (!job) return;
  clearPhysicalJobBlockers(state, physicalJobId);
  if (!incrementAttempt) {
    clearRetryMetadata(job);
    resetEntireJobForRetry(state, physicalJobId, job);
    return;
  }
  const attempt = currentRetryAttempt(job);
  const retryHistory = [...(job.retry_history ?? [])];
  if (retryHistory[retryHistory.length - 1]?.attempt !== attempt) {
    retryHistory.push(snapshotRetryAttempt(job, attempt));
  }
  resetJobMetadata(job);
  job.retry_history = retryHistory;
  job.retry_count =
    Math.max(attempt, ...retryHistory.map((entry) => entry.attempt)) + 1;
  job.iteration_count = 1;
  job.steps = Object.fromEntries(
    (
      state.job_definitions[physicalJobId] ??
      state.pipeline_snapshot.jobs[physicalJobId]
    ).steps.map((step) => [step.id, createPendingStep()]),
  );
}

function downstreamLogicalJobs(
  state: ExecutionState,
  rootLogicalJobId: string,
): Set<string> {
  const result = new Set<string>();
  const queue = [rootLogicalJobId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const [candidateId, candidate] of Object.entries(
      state.pipeline_snapshot.jobs,
    )) {
      if (!candidate.needs.includes(current) || result.has(candidateId)) {
        continue;
      }
      result.add(candidateId);
      queue.push(candidateId);
    }
  }
  return result;
}

export function prepareMatrixJobRetryState(
  state: ExecutionState,
  request: RetryMatrixJobRequest,
): ExecutionState {
  const group = state.job_groups[request.jobId];
  if (!group || group.kind !== 'matrix') {
    throw new Error(
      encodeMatrixIpcErrorMessage(
        'matrix/not-a-matrix-job',
        `Job "${request.jobId}" is not a matrix job`,
      ),
    );
  }
  if (!isExecutionTerminal(state)) {
    throw new Error(
      encodeMatrixIpcErrorMessage(
        'matrix/execution-not-terminal',
        `Cannot retry job "${request.jobId}": execution "${request.executionId}" is not terminal`,
      ),
    );
  }
  if (!isJobTerminal({ status: group.status })) {
    throw new Error(
      encodeMatrixIpcErrorMessage(
        'matrix/group-not-terminal',
        `Cannot retry job "${request.jobId}": the group is not terminal`,
      ),
    );
  }
  const retryState = cloneExecutionState(state);
  retryState.job_definitions = rematerializeJobDefinitions(
    retryState,
    retryState.pipeline_snapshot,
  );
  const retryGroup = retryState.job_groups[request.jobId];

  if (request.mode === 'expansion') {
    if (retryGroup.expansion !== 'failure') {
      throw new Error(
        encodeMatrixIpcErrorMessage(
          'matrix/variant-not-retryable',
          `Job "${request.jobId}" does not have a failed expansion`,
        ),
      );
    }
    if (!retryState.pipeline_snapshot.jobs[request.jobId]?.strategy?.dynamic) {
      throw new Error(
        encodeMatrixIpcErrorMessage(
          'matrix/variant-not-retryable',
          `Job "${request.jobId}" does not have a dynamic matrix expansion to retry`,
        ),
      );
    }
    retryGroup.expansion = 'pending';
    retryGroup.status = 'pending';
    retryGroup.outcome = undefined;
    retryGroup.conclusion = undefined;
    retryGroup.error = undefined;
    retryGroup.completed_at = undefined;
  } else {
    let selectedIds: string[];
    if (request.mode === 'all') {
      selectedIds = retryGroup.variant_job_ids;
    } else if (request.mode === 'failed') {
      selectedIds = retryGroup.variant_job_ids.filter((physicalJobId) => {
        const result = retryState.jobs[physicalJobId];
        return result.status === 'failure' || result.status === 'cancelled';
      });
    } else {
      if (!request.variantJobIds?.length) {
        throw new Error(
          encodeMatrixIpcErrorMessage(
            'matrix/empty-variant-selection',
            'Retry mode "variants" requires at least one variant id',
          ),
        );
      }
      selectedIds = Array.from(new Set(request.variantJobIds));
      for (const physicalJobId of selectedIds) {
        if (!retryGroup.variant_job_ids.includes(physicalJobId)) {
          throw new Error(
            encodeMatrixIpcErrorMessage(
              'matrix/unknown-variant',
              `Job "${request.jobId}" has no variant "${physicalJobId}"`,
            ),
          );
        }
        const result = retryState.jobs[physicalJobId];
        if (result.status !== 'failure' && result.status !== 'cancelled') {
          throw new Error(
            encodeMatrixIpcErrorMessage(
              'matrix/variant-not-retryable',
              `Variant "${physicalJobId}" is not failed or cancelled`,
            ),
          );
        }
      }
    }
    if (selectedIds.length === 0) {
      throw new Error(
        encodeMatrixIpcErrorMessage(
          'matrix/empty-variant-selection',
          `Job "${request.jobId}" has no variants eligible for retry mode "${request.mode}"`,
        ),
      );
    }
    for (const physicalJobId of selectedIds) {
      resetPhysicalJobForMatrixRetry(retryState, physicalJobId);
    }
    retryGroup.status = 'pending';
    retryGroup.outcome = undefined;
    retryGroup.conclusion = undefined;
    retryGroup.completed_at = undefined;
  }

  for (const downstreamId of Array.from(
    downstreamLogicalJobs(retryState, request.jobId),
  )) {
    const downstreamGroup = retryState.job_groups[downstreamId];
    const logicalDefinition = retryState.pipeline_snapshot.jobs[downstreamId];
    if (logicalDefinition.strategy?.dynamic) {
      for (const physicalJobId of downstreamGroup.variant_job_ids) {
        delete retryState.jobs[physicalJobId];
        delete retryState.job_definitions[physicalJobId];
        clearPhysicalJobBlockers(retryState, physicalJobId);
      }
      downstreamGroup.variant_job_ids = [];
      downstreamGroup.expansion = 'pending';
      downstreamGroup.status = 'pending';
      downstreamGroup.outcome = undefined;
      downstreamGroup.conclusion = undefined;
      downstreamGroup.error = undefined;
      continue;
    }
    for (const physicalJobId of downstreamGroup.variant_job_ids) {
      resetPhysicalJobForMatrixRetry(retryState, physicalJobId, false);
    }
    downstreamGroup.status = 'pending';
    downstreamGroup.outcome = undefined;
    downstreamGroup.conclusion = undefined;
    downstreamGroup.completed_at = undefined;
  }
  retryState.status = 'pending';
  retryState.started_at = new Date().toISOString();
  retryState.completed_at = undefined;
  resetExecutionPauseClock(retryState);
  retryState.error = undefined;
  retryState.report_outputs = undefined;
  retryState.pending_input = undefined;
  retryState.pending_pauses = [];
  retryState.status_reasons = [];
  delete retryState.shutdown_checkpoint;
  return retryState;
}

export function prepareMatrixVariantCancellation(
  state: ExecutionState,
  request: CancelMatrixVariantRequest,
  options: { preserveExecutionStatus?: boolean } = {},
): ExecutionState {
  const group = state.job_groups[request.jobId];
  if (!group || group.kind !== 'matrix') {
    throw new Error(
      encodeMatrixIpcErrorMessage(
        'matrix/not-a-matrix-job',
        `Job "${request.jobId}" is not a matrix job`,
      ),
    );
  }
  if (!group.variant_job_ids.includes(request.variantJobId)) {
    throw new Error(
      encodeMatrixIpcErrorMessage(
        'matrix/unknown-variant',
        `Job "${request.jobId}" has no variant "${request.variantJobId}"`,
      ),
    );
  }
  const variant = state.jobs[request.variantJobId];
  if (isJobTerminal(variant)) return state;
  if (isExecutionTerminal(state)) {
    throw new Error(
      encodeMatrixIpcErrorMessage(
        'matrix/execution-terminal',
        `Cannot cancel variant "${request.variantJobId}": execution "${request.executionId}" is terminal`,
      ),
    );
  }
  clearPhysicalJobBlockers(state, request.variantJobId);
  const completedAt = new Date().toISOString();
  for (const step of Object.values(variant.steps)) {
    if (isStepTerminal(step)) continue;
    step.status = 'cancelled';
    step.outcome = 'cancelled';
    step.conclusion = 'cancelled';
    step.completed_at = completedAt;
  }
  variant.status = 'cancelled';
  variant.outcome = 'cancelled';
  variant.conclusion = 'cancelled';
  variant.completed_at = completedAt;
  refreshAllJobGroups(state);
  state.status = options.preserveExecutionStatus
    ? 'running'
    : executionHasBlockers(state)
      ? 'paused'
      : executionHasNonTerminalWork(state)
        ? 'pending'
        : Object.values(state.job_groups).some(
              (candidate) => candidate.conclusion === 'failure',
            )
          ? 'failure'
          : 'cancelled';
  state.completed_at = isExecutionTerminal(state)
    ? new Date().toISOString()
    : undefined;
  return state;
}

function shouldResetEntireInterruptedJobForRetry(
  state: ExecutionState,
  jobId: string,
  job: JobResult,
): boolean {
  const maxIterations =
    (state.job_definitions[jobId] ?? state.pipeline_snapshot.jobs[jobId])
      ?.max_iterations ?? 1;
  return (
    maxIterations > 1 ||
    (job.iteration_count ?? 0) > 1 ||
    (job.iteration_history?.length ?? 0) > 0
  );
}

function isInterruptedRetryJob(job: JobResult): boolean {
  // A continue-on-error job can fail while its dependency-gating conclusion is
  // success. Retry the work outcome in addition to conclusion-based failures.
  return (
    job.status === 'failure' ||
    job.conclusion === 'failure' ||
    job.conclusion === 'cancelled' ||
    job.status === 'cancelled'
  );
}

export function logicalJobIdForPhysicalJob(
  state: Pick<ExecutionState, 'job_definitions'>,
  physicalJobId: string,
): string {
  return (
    state.job_definitions?.[physicalJobId]?.logical_job_id ?? physicalJobId
  );
}

function collectRetrySeedLogicalJobIds(state: ExecutionState): string[] {
  const failedExpansionJobIds = Object.entries(state.job_groups)
    .filter(([, group]) => group.expansion === 'failure')
    .map(([logicalJobId]) => logicalJobId);
  const interruptedLogicalJobIds = Object.entries(state.jobs)
    .filter(([, job]) => isInterruptedRetryJob(job))
    .map(([jobId]) => logicalJobIdForPhysicalJob(state, jobId));
  const retryableLogicalJobIds = new Set([
    ...failedExpansionJobIds,
    ...interruptedLogicalJobIds,
  ]);

  if (retryableLogicalJobIds.size > 0) {
    return Array.from(retryableLogicalJobIds);
  }

  return Array.from(
    new Set(
      Object.entries(state.jobs)
        .filter(([, job]) => !isJobTerminal(job))
        .map(([jobId]) => logicalJobIdForPhysicalJob(state, jobId)),
    ),
  );
}

export function prepareRetryState(state: ExecutionState): ExecutionState {
  if (state.parent_execution_id) {
    throw new Error('Only root executions can be retried');
  }

  if (state.status !== 'failure' && state.status !== 'cancelled') {
    throw new Error(
      `Execution "${state.id}" cannot be retried because it is ${state.status}`,
    );
  }

  const interruptedJobIds = Object.entries(state.jobs)
    .filter(([, job]) => isInterruptedRetryJob(job))
    .map(([jobId]) => jobId);
  const retrySeedLogicalJobIds = collectRetrySeedLogicalJobIds(state);

  if (retrySeedLogicalJobIds.length === 0) {
    throw new Error(
      `Execution "${state.id}" cannot be retried because it has no failed, cancelled, or incomplete jobs`,
    );
  }

  const retryState: ExecutionState = structuredClone(state);
  retryState.job_definitions = rematerializeJobDefinitions(
    retryState,
    retryState.pipeline_snapshot,
  );
  const retryLogicalJobIds = collectRetryCone(
    retryState,
    retrySeedLogicalJobIds,
  );
  const retryPhysicalJobIds = new Set<string>();
  for (const logicalJobId of Array.from(retryLogicalJobIds)) {
    const group = retryState.job_groups[logicalJobId];
    if (!group) {
      retryPhysicalJobIds.add(logicalJobId);
      continue;
    }
    if (group.kind === 'matrix' && group.expansion !== 'expanded') {
      group.expansion = 'pending';
      group.variant_job_ids = [];
      group.status = 'pending';
      group.outcome = undefined;
      group.conclusion = undefined;
      group.error = undefined;
      group.started_at = undefined;
      group.completed_at = undefined;
      group.resolved_max_parallel = undefined;
    }
    for (const physicalJobId of group.variant_job_ids) {
      retryPhysicalJobIds.add(physicalJobId);
    }
  }
  const interruptedJobIdSet = new Set(interruptedJobIds);

  for (const jobId of Array.from(retryPhysicalJobIds)) {
    const job = retryState.jobs[jobId];
    if (!job) {
      continue;
    }

    if (interruptedJobIdSet.has(jobId)) {
      if (shouldResetEntireInterruptedJobForRetry(retryState, jobId, job)) {
        resetEntireJobForRetry(retryState, jobId, job);
      } else {
        resetJobForRetry(retryState, jobId, job);
      }
      continue;
    }

    clearRetryMetadata(job);
    resetEntireJobForRetry(retryState, jobId, job);
  }

  refreshAllJobGroups(retryState);

  retryState.status = 'pending';
  retryState.started_at = new Date().toISOString();
  retryState.completed_at = undefined;
  resetExecutionPauseClock(retryState);
  retryState.error = undefined;
  retryState.report_outputs = undefined;
  retryState.plan_hash_before = undefined;
  retryState.plan_hash_after = undefined;

  return retryState;
}

function recoverJobResult(
  state: ExecutionState,
  jobId: string,
  job: JobResult,
): boolean {
  const normalizedJob =
    state.job_definitions[jobId] ?? state.pipeline_snapshot.jobs[jobId];
  let incomplete = false;
  let recoveredRunningStep = false;
  for (const step of normalizedJob.steps) {
    const currentStep = job.steps[step.id];
    if (!currentStep) {
      job.steps[step.id] = createPendingStep();
      incomplete = true;
      continue;
    }
    if (currentStep.status === 'running') {
      job.steps[step.id] = resetRunningStep(currentStep);
      recoveredRunningStep = true;
      incomplete = true;
      continue;
    }
    // A step held for memory never started; it waits to start again.
    if (currentStep.status === 'waiting_for_capacity') {
      job.steps[step.id] = { ...currentStep, status: 'pending' };
      recoveredRunningStep = true;
      incomplete = true;
      continue;
    }
    if (!isStepTerminal(currentStep)) incomplete = true;
  }

  if (job.status === 'paused') {
    const pendingInputMatchesJob = state.pending_input?.job_id === jobId;
    const pendingPauseMatchesJob = state.pending_pauses.some(
      (checkpoint) => checkpoint.job_id === jobId,
    );
    const hasStepInputRequest = Object.values(job.steps).some(
      (step) => step.input_request !== undefined,
    );
    if (
      state.status_reasons.length === 0 &&
      !pendingInputMatchesJob &&
      !pendingPauseMatchesJob &&
      !hasStepInputRequest
    ) {
      job.status = 'queued';
      job.completed_at = undefined;
      job.conclusion = undefined;
      job.outcome = undefined;
    }
    return true;
  }
  if (job.status === 'restarting') {
    job.status = 'queued';
    job.completed_at = undefined;
    job.conclusion = undefined;
    job.outcome = undefined;
    job.outputs = {};
    job.report_outputs = undefined;
    for (const stepId of Object.keys(job.steps)) {
      job.steps[stepId] = createPendingStep();
    }
    return true;
  }
  if (recoverInterruptedFailureAttempt(state, jobId, job)) return true;
  if (
    job.status === 'running' ||
    job.status === 'waiting_for_capacity' ||
    recoveredRunningStep
  ) {
    job.status = 'queued';
    job.completed_at = undefined;
    job.conclusion = undefined;
    if (job.outcome === 'cancelled') job.outcome = undefined;
    return true;
  }
  return incomplete || !isJobTerminal(job);
}

export function recoverInterruptedState(state: ExecutionState): ExecutionState {
  const recovered = cloneExecutionState(state);
  recovered.inputs = recovered.inputs ?? {};
  let hasIncompleteWork = false;

  for (const jobId of Object.keys(recovered.job_definitions)) {
    const job = recovered.jobs[jobId];
    if (!job) {
      hasIncompleteWork = true;
      continue;
    }
    if (recoverJobResult(recovered, jobId, job)) {
      hasIncompleteWork = true;
    }
  }
  refreshAllJobGroups(recovered);

  if (hasIncompleteWork) {
    recovered.status = 'pending';
    recovered.completed_at = undefined;
  }

  return recovered;
}

function applyExecutionResumeSelection(
  prepared: ExecutionState,
  executionId: string,
  selection: {
    statusReasonIds?: readonly string[];
    inputAnswers?: Record<string, string | number | boolean>;
    selectDefaultStatusReasons?: boolean;
  },
): void {
  const checkpointId = prepared.shutdown_checkpoint?.id;
  const resumeExecutionCheckpoint = Boolean(
    checkpointId &&
    (!selection.statusReasonIds ||
      selection.statusReasonIds.includes(checkpointId)),
  );
  const explicitIds = resumeExecutionCheckpoint
    ? selection.statusReasonIds?.filter((id) => id !== checkpointId)
    : selection.statusReasonIds;
  if (explicitIds && explicitIds.length === 0 && !resumeExecutionCheckpoint) {
    throw new Error(
      'statusReasonIds must be omitted or contain at least one ID',
    );
  }
  if (explicitIds) {
    const unique = new Set(explicitIds);
    if (unique.size !== explicitIds.length) {
      throw new Error('statusReasonIds must not contain duplicate IDs');
    }
    if (explicitIds.some((id) => !UUID_PATTERN.test(id))) {
      throw new Error('statusReasonIds contains a malformed reason ID');
    }
    const activeIds = new Set(
      prepared.status_reasons.map((reason) => reason.id),
    );
    const unknown = explicitIds.find((id) => !activeIds.has(id));
    if (unknown) {
      throw new Error(
        `Status reason "${unknown}" is stale or does not belong to execution "${executionId}"`,
      );
    }
  }

  const selectedIds = new Set(
    explicitIds ??
      (selection.selectDefaultStatusReasons === false
        ? []
        : prepared.status_reasons
            .filter((reason) => reason.kind !== 'input_required')
            .map((reason) => reason.id)),
  );
  if (selection.inputAnswers && prepared.pending_input) {
    for (const reason of prepared.status_reasons) {
      if (
        reason.kind === 'input_required' &&
        reason.source.job_id === prepared.pending_input.job_id &&
        reason.source.step_id === prepared.pending_input.step_id
      ) {
        selectedIds.add(reason.id);
      }
    }
  }

  const startedAt = new Date().toISOString();
  for (const reason of prepared.status_reasons) {
    if (!selectedIds.has(reason.id)) continue;
    const job = prepared.jobs[reason.source.job_id];
    const step = job?.steps[reason.source.step_id];
    if (!job || !step) {
      throw new Error(
        `Status reason "${reason.id}" no longer has a valid step checkpoint`,
      );
    }
    if (
      isCheckpointPauseReason(reason.kind) &&
      step.status === 'paused' &&
      step.log_format_hint === 'agent' &&
      !step.agent_recovery &&
      !reason.source.child_execution_id
    ) {
      throw new Error(
        'The interrupted agent has no saved recovery checkpoint. Resume the provider session manually before retrying this step.',
      );
    }
    if (
      (isCheckpointPauseReason(reason.kind) &&
        step.status === 'paused' &&
        (step.agent_recovery || reason.source.child_execution_id)) ||
      reason.kind === 'provider_authentication_required' ||
      reason.kind === 'provider_usage_limit' ||
      reason.kind === 'provider_temporarily_unavailable'
    ) {
      if (reason.source.child_execution_id && reason.source.child_reason_id) {
        step.child_execution_id = reason.source.child_execution_id;
        step.selected_child_reason_ids = Array.from(
          new Set([
            ...(step.selected_child_reason_ids ?? []),
            reason.source.child_reason_id,
          ]),
        );
        job.status = 'queued';
        job.completed_at = undefined;
        job.conclusion = undefined;
        job.outcome = undefined;
        continue;
      }
      const checkpoint = step.agent_recovery;
      if (!checkpoint || checkpoint.reason_id !== reason.id) {
        throw new Error(
          `Status reason "${reason.id}" no longer has an agent recovery checkpoint`,
        );
      }
      const recoveryNumber =
        (step.recovery_count ?? checkpoint.recovery_count) + 1;
      step.recovery_count = recoveryNumber;
      checkpoint.recovery_count = recoveryNumber;
      step.agent_recovery_history = [
        ...(step.agent_recovery_history ?? []),
        {
          reason: structuredClone(reason),
          strategy: checkpoint.strategy,
          recovery_number: recoveryNumber,
          started_at: startedAt,
          status: 'running',
        },
      ];
    }
    job.status = 'queued';
    job.completed_at = undefined;
    job.conclusion = undefined;
    job.outcome = undefined;
  }
  // Every selected reason requeued its job; a job that is no longer paused has
  // no pause checkpoint (see syncPendingPauseForJob).
  const requeuedJobIds = new Set(
    prepared.status_reasons
      .filter((reason) => selectedIds.has(reason.id))
      .map((reason) => reason.source.job_id),
  );
  prepared.pending_pauses = prepared.pending_pauses.filter(
    (checkpoint) => !requeuedJobIds.has(checkpoint.job_id),
  );
  prepared.status_reasons = prepared.status_reasons.filter(
    (reason) => !selectedIds.has(reason.id),
  );
  if (resumeExecutionCheckpoint) delete prepared.shutdown_checkpoint;
}

export function prepareExecutionResume(
  state: ExecutionState,
  selection: {
    statusReasonIds?: readonly string[];
    inputAnswers?: Record<string, string | number | boolean>;
    selectDefaultStatusReasons?: boolean;
  },
): ExecutionState {
  const prepared = recoverInterruptedState(state);
  applyExecutionResumeSelection(prepared, state.id, selection);
  prepared.status = 'pending';
  prepared.completed_at = undefined;
  // Bank the pause the moment the user resumes, so the wait is excluded even
  // if the run never reaches `running` again.
  endExecutionPause(prepared);
  return prepared;
}

/**
 * Prepares paused jobs for recovery without resetting sibling jobs that are
 * still running in the same live execution. The caller merges the selected
 * jobs and remaining reasons into its in-memory execution state.
 */
export function prepareActiveExecutionResume(
  state: ExecutionState,
  selection: { statusReasonIds: readonly string[] },
): ExecutionState {
  if (state.status !== 'running') {
    throw new Error(
      `Execution "${state.id}" cannot resume paused steps while it is ${state.status}`,
    );
  }

  const selectedIds = new Set(selection.statusReasonIds);
  for (const id of Array.from(selectedIds)) {
    if (!state.status_reasons.some((reason) => reason.id === id)) {
      throw new Error(
        `Status reason "${id}" is stale or does not belong to execution "${state.id}"`,
      );
    }
  }
  for (const reason of state.status_reasons) {
    if (!selectedIds.has(reason.id)) continue;
    if (reason.kind === 'input_required') {
      throw new Error(
        `Status reason "${reason.id}" requires input and cannot be resumed while the execution is running`,
      );
    }
    if (state.jobs[reason.source.job_id]?.status !== 'paused') {
      throw new Error(
        `Status reason "${reason.id}" does not belong to a paused job`,
      );
    }
  }

  const prepared = cloneExecutionState(state);
  applyExecutionResumeSelection(prepared, state.id, selection);
  prepared.status = 'running';
  prepared.completed_at = undefined;
  return prepared;
}

export function findResumePoint(state: ExecutionState): ResumePoint | null {
  for (const [jobId, normalizedJob] of Object.entries(state.job_definitions)) {
    const job = state.jobs[jobId];
    if (!job || isJobTerminal(job)) {
      continue;
    }

    for (
      let stepIndex = 0;
      stepIndex < normalizedJob.steps.length;
      stepIndex += 1
    ) {
      const step = normalizedJob.steps[stepIndex];
      const stepResult = job.steps[step.id];
      if (!isStepTerminal(stepResult)) {
        return {
          jobId,
          stepId: step.id,
          stepIndex,
        };
      }
    }

    return {
      jobId,
      stepIndex: normalizedJob.steps.length,
    };
  }

  return null;
}
