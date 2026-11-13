import type { BotAction } from '../families/bots/actions';
import type {
  ProjectAction,
  ProjectWriteAction,
} from '../families/projects/actions';
import type { AgentActionLimitsPort } from '../limits';
import type { AgentActionReceiptStore } from '../receipts';
import type { AgentActionResponse } from '../response';
import type { AgentActionCall } from '../surface/family';

/**
 * The host behind the explicit-target project and bot actions. It resolves
 * the trusted caller from the call, authorizes every target against the
 * caller's saved owner, and rechecks bot access on every call.
 */
export interface AgentProjectBotPort<H> {
  dispatch(
    action: ProjectAction | BotAction,
    call: AgentActionCall<H>,
  ): Promise<Omit<AgentActionResponse<string>, 'requestId'>>;
}

/** One attempt of a project write, as the family keyed and reserved it. */
export interface AgentProjectWriteAttempt {
  /**
   * The write's idempotency key. Ids the host derives from it name the same
   * chat and turn on every attempt, so a retry reaches what an earlier one
   * did instead of doing it again.
   */
  idempotencyKey: string;
  /**
   * An earlier attempt of the key ended with an unknown outcome, so its
   * write may have happened (`AgentWriteAttempt.uncertain`).
   */
  uncertain: boolean;
  /** The calling chat's spawn depth, as the reservation counted it. */
  callerDepth: number;
}

/**
 * The receipts and limits a host keeps for its project writes. With them,
 * the projects family runs each write through `runIdempotentWrite`: a retry
 * of the same tool call replays the recorded receipt, a reuse of its key for
 * another request is `idempotency_conflict`, and each write takes a limits
 * reservation (sends as `chat.send_message`, creations as `chat.create`,
 * which also checks depth). The family then calls `write`, not the port's
 * `dispatch`, for the project write types. A refusal throws an
 * `AgentPortError`: it is answered, not recorded, so a retry writes again.
 * A response `write` returns is recorded, refusal or not.
 */
export interface AgentProjectWrites<H> {
  receipts: AgentActionReceiptStore<H>;
  limits: AgentActionLimitsPort | null;
  /** The calling chat's spawn depth, which creations are limited by. */
  callerDepth(call: AgentActionCall<H>): Promise<number>;
  write(
    action: ProjectWriteAction,
    call: AgentActionCall<H>,
    attempt: AgentProjectWriteAttempt,
  ): Promise<Omit<AgentActionResponse<string>, 'requestId'>>;
}

/** A project's saved owner: Personal, or one organization by external ID. */
export type AgentProjectOwner =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string };

/** The agent chat that started a run. */
export interface AgentPipelineOriginChat {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * A pipeline step acting through the explicit-target project actions. A host
 * builds it from its run's trusted fields, never from step inputs, and binds
 * a project port to it; the port ignores the call's own scope.
 */
export interface PipelineTrustedCaller {
  executionId: string;
  pipelineId?: string;
  stepId: string;
  /** The run's recorded owner (`execution_context`). */
  owner: AgentProjectOwner;
  /** The agent whose rules apply to an agent-originated run (`agent_origin`). */
  agentOrigin?: AgentPipelineOriginChat;
}
