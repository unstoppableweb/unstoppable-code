import type {
  CORE_MANAGED_DELEGATION_INSTRUCTION_DEFINITIONS,
  CORE_MANAGED_DELEGATION_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import type {
  AgentDelegationResult,
  AgentDelegationSpawnRequest,
  GetDelegateOutputRequest,
  MessageDelegateRequest,
  RequestSteeringRequest,
} from '@canopy/protocol/delegation';
import type { z } from 'zod';
import type { AgentActionCall } from '../surface/family';

type Queries = typeof CORE_MANAGED_DELEGATION_QUERY_DEFINITIONS;
type Instructions = typeof CORE_MANAGED_DELEGATION_INSTRUCTION_DEFINITIONS;

/**
 * A delegation as the `core.managedDelegation.*` operations return it: the
 * shared `AgentDelegationSnapshot`, read through the operations' schema.
 */
export type AgentDelegationSnapshotValue = z.output<
  Queries['core.managedDelegation.get']['result']
>;

/** A delegate's settled result page, as `output.read` returns it. */
export type AgentDelegateOutputValue = z.output<
  Queries['core.managedDelegation.output.read']['result']
>;

/** The models a delegate can run on, as `models.list` returns them. */
export type AgentDelegationModelsValue = z.output<
  Queries['core.managedDelegation.models.list']['result']
>;

/** The run a follow-up, steer or interrupt started or reached. */
export type AgentDelegationMessageReceipt = z.output<
  Instructions['core.managedDelegation.message']['result']
>;

/** One page of the calling chat's delegations, at every depth below it. */
export interface AgentDelegationListPage {
  readonly delegations: readonly AgentDelegationSnapshotValue[];
  /** Present when more delegations remain; pass it back as `cursor`. */
  readonly nextCursor?: string;
}

/**
 * A host's managed delegation backend for the delegation tools (DelegateTask
 * and the rest; cloud delegation contract, sections 2.2 and 8). Every call
 * acts for the calling chat: the parent for the controls and reads, the
 * child for `requestSteering`. Writes carry `key`, the tool call's
 * agent-actions idempotency key, so a retried call reaches the same
 * delegation or run. Errors are `AgentDelegationError`s, as on desktop.
 */
export interface AgentManagedDelegationPort<H> {
  spawn(
    call: AgentActionCall<H>,
    request: AgentDelegationSpawnRequest,
    key: string,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshotValue>>;
  output(
    call: AgentActionCall<H>,
    request: GetDelegateOutputRequest,
  ): Promise<AgentDelegationResult<AgentDelegateOutputValue>>;
  inspect(
    call: AgentActionCall<H>,
    delegationId: string,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshotValue>>;
  list(
    call: AgentActionCall<H>,
    filter: { readonly underDelegationId?: string; readonly cursor?: string },
  ): Promise<AgentDelegationResult<AgentDelegationListPage>>;
  /** Advisory: launch rechecks the exact route. */
  models(
    call: AgentActionCall<H>,
  ): Promise<AgentDelegationResult<AgentDelegationModelsValue>>;
  stop(
    call: AgentActionCall<H>,
    delegationId: string,
    key: string,
  ): Promise<AgentDelegationResult<{ readonly accepted: boolean }>>;
  message(
    call: AgentActionCall<H>,
    request: MessageDelegateRequest,
    key: string,
  ): Promise<AgentDelegationResult<AgentDelegationMessageReceipt>>;
  requestSteering(
    call: AgentActionCall<H>,
    request: RequestSteeringRequest,
    key: string,
  ): Promise<AgentDelegationResult<{ readonly requestId: string }>>;
}
