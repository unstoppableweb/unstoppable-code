import { parseLedgerGlobalOwner } from '@canopy/protocol/canopy-core';
import { getModelSource } from '@canopy/execution-engine/model-catalog';
import type { AgentProviderType } from '@canopy/agent-transcript';
import type { ModelHarness } from '@canopy/execution-engine/types/model-harnesses';
import type {
  AgentRecoveryCheckpoint,
  PipelineStatusReason,
  StepResult,
} from '@canopy/execution-engine/types/pipeline';
import {
  parsePermissionPreset,
  type PermissionPreset,
} from '../../../builtin-actions/agent-prompt/logic';
import type {
  PipelineLedgerAttempt,
  PipelineLedgerAttemptOutcome,
  PipelineLedgerAttemptRequest,
  PipelineLedgerPort,
  PipelineLedgerTarget,
} from './types';

/*
 * The Agent Ledger for desktop-run pipeline agents (phase 08). The executor
 * decides which step attempts are agents that may keep the Ledger and how
 * each relates to earlier runs; the host behind
 * `ExecutionRuntime.pipelineLedger` mints their sessions, decides whether the
 * Ledger is exposed and serves the tools. Nothing here opens the Ledger:
 * without a port (the CLI, tests) every step runs exactly as before.
 */

/**
 * The agent steps whose agents keep the Ledger. `router`, `condenser` and
 * `quality-gate` behave like helpers (E05) and never get the tools.
 */
export const PIPELINE_LEDGER_AGENT_ACTIONS: ReadonlySet<string> = new Set([
  'builtin/agent-prompt',
  'builtin/agent-resume',
  'builtin/agent-loop',
  'builtin/parallel-agents',
  'builtin/plan-with-review',
]);

/** The helper-like agent steps, excluded by purpose. */
const PIPELINE_LEDGER_HELPER_ACTIONS: ReadonlySet<string> = new Set([
  'builtin/router',
  'builtin/condenser',
  'builtin/quality-gate',
]);

const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** What the step runner knows about an agent step when it starts. */
export interface PipelineLedgerStepFacts {
  readonly uses: string | undefined;
  /** The harness the step resolved (a recovery checkpoint's wins). */
  readonly harness: ModelHarness | undefined;
  readonly provider: AgentProviderType | undefined;
  /** The step's resolved `model` input, when it has one. */
  readonly model: string | undefined;
  readonly permissionPresetInput: string | undefined;
  /** Whether the runtime has a host Ledger port; the CLI has none. */
  readonly hostRoute: boolean;
  /**
   * The Ledger the execution records to; undefined when its persisted owner
   * cannot be parsed (see {@link resolvePipelineLedgerTarget}).
   */
  readonly target: PipelineLedgerTarget | undefined;
}

/**
 * Why a step's agent gets no Ledger tools (LD07, recorded in the census):
 * - `not_an_agent_step`: not one of the five agent actions.
 * - `helper_step`: `router`, `condenser` or `quality-gate`, helpers by purpose.
 * - `no_tool_support`: an Ollama route.
 * - `cursor_harness`: a Cursor or Copilot step; there is no Ledger route for
 *   either in v1.
 * - `plan_permission`: a Claude step under `plan`, where Claude runs no tools.
 * - `invalid_preset`: a preset the step itself will reject.
 * - `no_host_route`: the runtime has no Ledger port (CLI-run pipelines).
 * - `malformed_owner`: the execution has no worktree and its persisted owner
 *   cannot be parsed, so no global Ledger can be chosen for it.
 */
export type PipelineLedgerExclusionReason =
  | 'not_an_agent_step'
  | 'helper_step'
  | 'no_tool_support'
  | 'cursor_harness'
  | 'plan_permission'
  | 'invalid_preset'
  | 'no_host_route'
  | 'malformed_owner';

/** Whether a step's agent gets the Ledger tools, and on which harness. */
export type PipelineLedgerAgentResolution =
  | {
      readonly kind: 'agent';
      readonly harness: 'claude' | 'codex' | 'opencode';
      readonly permissionPreset: PermissionPreset;
    }
  | {
      readonly kind: 'excluded';
      readonly reason: PipelineLedgerExclusionReason;
    };

function excluded(
  reason: PipelineLedgerExclusionReason,
): PipelineLedgerAgentResolution {
  return { kind: 'excluded', reason };
}

/**
 * The agent that gets the Ledger tools, or the typed reason it gets none. The
 * host still decides whether the Ledger is exposed at all.
 */
export function resolvePipelineLedgerAgent(
  facts: PipelineLedgerStepFacts,
): PipelineLedgerAgentResolution {
  if (
    facts.uses !== undefined &&
    PIPELINE_LEDGER_HELPER_ACTIONS.has(facts.uses)
  )
    return excluded('helper_step');
  if (
    facts.uses === undefined ||
    !PIPELINE_LEDGER_AGENT_ACTIONS.has(facts.uses)
  )
    return excluded('not_an_agent_step');
  if (!facts.hostRoute) return excluded('no_host_route');
  if (facts.target === undefined) return excluded('malformed_owner');
  if (
    facts.provider === 'ollama' ||
    (facts.model !== undefined && getModelSource(facts.model) === 'ollama')
  ) {
    return excluded('no_tool_support');
  }
  let permissionPreset: PermissionPreset;
  try {
    permissionPreset = parsePermissionPreset(facts.permissionPresetInput);
  } catch {
    return excluded('invalid_preset');
  }
  const harness = facts.harness ?? 'claude';
  // Codex and OpenCode run tools under every preset, `plan` included.
  if (harness === 'codex' || harness === 'opencode')
    return { kind: 'agent', harness, permissionPreset };
  if (harness !== 'claude') return excluded('cursor_harness');
  if (permissionPreset === 'plan') return excluded('plan_permission');
  return { kind: 'agent', harness, permissionPreset };
}

/** Where an execution runs and who owns it, as the step runner knows it. */
export interface PipelineLedgerTargetInput {
  readonly projectId: string | undefined;
  readonly worktreeId: string | undefined;
  /** The execution's persisted `execution_context`, absent for legacy runs. */
  readonly executionContext: string | undefined;
}

/**
 * The Ledger an execution's agents record to. An execution with a worktree
 * records to that task; any other run (global or directory) records to its
 * persisted owner's global Ledger, Personal when the run predates ownership.
 * Undefined when that owner is malformed, which fails closed. Each execution,
 * a targeted child included, resolves its own target, so a parent's never
 * overrides it.
 */
export function resolvePipelineLedgerTarget(
  input: PipelineLedgerTargetInput,
): PipelineLedgerTarget | undefined {
  if (input.projectId && input.worktreeId) {
    return {
      kind: 'task',
      projectId: input.projectId,
      worktreeId: input.worktreeId,
    };
  }
  const owner = parseLedgerGlobalOwner(input.executionContext);
  return owner.ok ? { kind: 'global', owner: owner.owner } : undefined;
}

/** The identity inputs the job runner hands a step. */
export interface PipelineLedgerIdentityInput {
  /** The session of the step's last run, when it resumes a checkpoint. */
  readonly resumedAgentSessionId: string | undefined;
  /** The checkpoint being resumed, if any. */
  readonly checkpoint: AgentRecoveryCheckpoint | undefined;
  /** The session of the attempt a retry replaces. */
  readonly predecessorAgentSessionId: string | undefined;
}

/**
 * Who the attempt's agent is, for the host that mints its session. Resuming a
 * recovery checkpoint keeps the session that run recorded; any other run (a
 * first run, a retry, a new iteration) gets a new session from the host,
 * linked to the attempt a retry replaces.
 */
export function pipelineLedgerAttemptIdentity(
  identity: PipelineLedgerIdentityInput,
): Pick<
  PipelineLedgerAttemptRequest,
  'resumedAgentSessionId' | 'predecessorAgentSessionId' | 'checkpointId'
> {
  const checkpointId = identity.checkpoint?.reason_id;
  const resumed = identity.resumedAgentSessionId;
  if (
    checkpointId !== undefined &&
    resumed !== undefined &&
    UUID_TEXT.test(resumed)
  ) {
    return { resumedAgentSessionId: resumed, checkpointId };
  }
  const predecessor = identity.predecessorAgentSessionId;
  return {
    ...(checkpointId === undefined ? {} : { checkpointId }),
    ...(predecessor !== undefined && UUID_TEXT.test(predecessor)
      ? { predecessorAgentSessionId: predecessor }
      : {}),
  };
}

/** The agent session a step result recorded, when it is well formed. */
export function recordedLedgerAgentSession(
  step: Pick<StepResult, 'ledger_agent_session_id'> | undefined,
): string | undefined {
  const id = step?.ledger_agent_session_id;
  return id !== undefined && UUID_TEXT.test(id) ? id : undefined;
}

/**
 * How an attempt's run ended for its Ledger tools: paused on a recovery
 * checkpoint the same session resumes, or settled.
 */
export function pipelineLedgerAttemptOutcome(
  result: StepResult | undefined,
): PipelineLedgerAttemptOutcome {
  const checkpoint = result?.agent_recovery;
  return result?.status === 'paused' && checkpoint !== undefined
    ? {
        kind: 'paused',
        checkpointId: checkpoint.reason_id,
        pausedAt: checkpoint.paused_at,
      }
    : { kind: 'settled' };
}

/** Opens an attempt, treating a host failure as "not exposed". */
export async function openPipelineLedgerAttempt(
  port: PipelineLedgerPort | undefined,
  request: PipelineLedgerAttemptRequest,
): Promise<PipelineLedgerAttempt | null> {
  if (port === undefined) return null;
  try {
    return await port.openAttempt(request);
  } catch {
    return null;
  }
}

/** The status reasons a resume consumed: those it removed from the state. */
export function consumedStatusReasonIds(
  before: readonly Pick<PipelineStatusReason, 'id'>[],
  after: readonly Pick<PipelineStatusReason, 'id'>[],
): string[] {
  const remaining = new Set(after.map((reason) => reason.id));
  return before.map((reason) => reason.id).filter((id) => !remaining.has(id));
}

/**
 * Tells the host an execution's resume is saved, before its resumed jobs run,
 * so the agents paused on the consumed checkpoints stop being assignable
 * owners. A host failure never blocks the resume.
 */
export async function notePipelineLedgerResuming(
  port: PipelineLedgerPort | undefined,
  executionId: string,
  checkpointIds: readonly string[],
): Promise<void> {
  if (port === undefined || checkpointIds.length === 0) return;
  try {
    await port.noteResuming(executionId, checkpointIds);
  } catch {
    // The paused-agent record is advisory; the resume goes ahead.
  }
}

/** Appends the Ledger block to an agent's system instructions. */
export function appendPipelineLedgerInstructions(
  systemPrompt: string | undefined,
  attempt: Pick<PipelineLedgerAttempt, 'instructions'> | null | undefined,
): string | undefined {
  if (!attempt?.instructions) return systemPrompt;
  return systemPrompt?.trim()
    ? `${systemPrompt}\n\n${attempt.instructions}`
    : attempt.instructions;
}
