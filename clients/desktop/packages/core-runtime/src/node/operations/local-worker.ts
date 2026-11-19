import { createHash, randomUUID } from 'node:crypto';

import {
  CanopyJsonValueSchema,
  DELEGATION_SECRETS_MAX,
  DelegationSecretFingerprintSchema,
  IN_PROCESS_LEASE_TERMS,
  IN_PROCESS_WORKER_TARGET,
  WorkerAgentHelperRunResultSchema,
  WorkerAgentSignInRunResultSchema,
  WorkerAgentSubagentRunResultSchema,
  WorkerAgentTurnRunResultSchema,
  safeParseCanopySchema,
  type CanopyErrorKind,
  type CanopyErrorPayload,
  type CanopyJsonValue,
  type DelegationLeaseRecord,
  type DelegationRecord,
  type DelegationResolution,
  type DelegationSecretFingerprint,
  type OperationRecord,
  type OperationTerminalStatus,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';

import {
  CanopyOperationError,
  canopyCapabilityUnavailableError,
  canopyInternalError,
  canopyInvalidArgumentError,
} from '../../runtime/errors';
import type { LocalWorkerTransport } from '../../runtime/local-worker-transport';
import type { WorkerExecutorReceipt } from '../../runtime/worker-executor-receipts';
import { OperationLedgerRefusedError } from './ledger/errors';
import type { OperationAcceptResult, OperationLedger } from './ledger/ledger';
import type { OperationService } from './service';

/** Completed worker results that report cancellation settle the child cancelled. */
const CANCELLED_RESULT_SCHEMAS: Readonly<
  Record<
    string,
    {
      safeParse(value: unknown): {
        success: boolean;
        data?: { status: string };
      };
    }
  >
> = {
  'worker.agent.helper.run': WorkerAgentHelperRunResultSchema,
  'worker.agent.turn.run': WorkerAgentTurnRunResultSchema,
  'worker.agent.subagent.run': WorkerAgentSubagentRunResultSchema,
  'worker.agent.signIn.run': WorkerAgentSignInRunResultSchema,
};

function reportsCancelled(operation: string, value: unknown): boolean {
  if (
    !Object.prototype.hasOwnProperty.call(CANCELLED_RESULT_SCHEMAS, operation)
  )
    return false;
  const result = CANCELLED_RESULT_SCHEMAS[operation]?.safeParse(value);
  return result?.success === true && result.data?.status === 'cancelled';
}

function keepsCancelledResult(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(CANCELLED_RESULT_SCHEMAS, kind);
}

export interface LocalWorkerDispatchRequest {
  /** The accepted operation this work belongs to; it must be unfinished. */
  parentOperationId: string;
  /** A worker instruction the transport carries. */
  operation: string;
  params: unknown;
  /**
   * The dispatch's identity within its parent. A retry with the same key
   * and parameters returns the recorded child instead of sending the work
   * again; other parameters are refused.
   */
  idempotencyKey: string;
  /** Secrets the work receives, by fingerprint only; never their values. */
  secrets?: readonly DelegationSecretFingerprint[];
}

export interface LocalWorkerDispatchResult {
  /** The child operation; unfinished only when the worker is unreachable. */
  operation: OperationRecord;
  delegation: DelegationRecord;
  /** The worker's result for completed work: live, or the recorded outcome. */
  result: unknown;
  /** True when a retry returned work an earlier call dispatched. */
  replayed: boolean;
}

/** Error kinds the binding or dispatcher raises without the worker's answer. */
const UNKNOWN_REPLY_KINDS: ReadonlySet<CanopyErrorKind> =
  new Set<CanopyErrorKind>(['unavailable', 'deadline_exceeded', 'cancelled']);

const OUTCOME_UNKNOWN: CanopyErrorPayload = {
  kind: 'unavailable',
  code: 'core.delegation.outcomeUnknown',
  message:
    'The local worker did not answer, and this operation takes no idempotency key, so its outcome is unknown. It was not sent again.',
  retry: { kind: 'never' },
};

const NOT_STARTED: CanopyErrorPayload = {
  kind: 'unavailable',
  code: 'core.delegation.notStarted',
  message:
    'The local worker never received this work. Another attempt needs a new idempotency key.',
  retry: { kind: 'never' },
};

function digest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(stableStringify(value) ?? 'null')
    .digest('hex')}`;
}

function errorPayload(error: unknown): CanopyErrorPayload {
  return error instanceof CanopyOperationError
    ? error.payload
    : canopyInternalError().payload;
}

/**
 * Core-side execution on the builtin local worker (`in_process_worker`,
 * CAN-4132). Every dispatched worker instruction becomes a child operation
 * of its parent in the operation ledger, recorded together with its dispatch
 * and resolved placement before anything is sent:
 *
 * - The record names the target, this run's degenerate delegation lease, the
 *   activation digest and secret fingerprints, never parameters or secrets.
 * - A reply the core never received (deadline, cancel, transport loss) is
 *   resolved by asking the worker for its executor receipt under the
 *   dispatch's key; the work is never sent again.
 * - Cancelling the child, or a parent whose cancellation cascades to it,
 *   aborts that one in-flight request on the worker.
 *
 * The transport decides only how the work crosses: the daemon's bundled
 * binding and Electron main's direct call write identical records.
 */
export class LocalWorkerExecution {
  /** In-flight dispatches by delegation id, registered before admission. */
  private readonly inFlight = new Map<string, AbortController>();
  /** Dispatches running in this process, which a retry with their key joins. */
  private readonly running = new Map<
    string,
    Promise<LocalWorkerDispatchResult>
  >();
  private placed: {
    ledger: OperationLedger;
    lease: DelegationLeaseRecord;
  } | null = null;

  constructor(
    private readonly options: {
      operations: OperationService;
      transport: LocalWorkerTransport;
    },
  ) {
    const kinds = Object.keys(options.transport.instructions);
    // Children of the bundled worker stop with the process that runs them,
    // so a restart finds them lost (`execution-targets.yaml`).
    if (kinds.length > 0)
      options.operations.registerDomain({
        domain: 'core.delegation',
        kinds,
        restartClass: 'lost',
        cancel: (operation) => this.cancel(operation),
      });
  }

  /** The worker instructions this execution dispatches. */
  get operations(): readonly string[] {
    return Object.keys(this.options.transport.instructions);
  }

  /**
   * Record and run one worker instruction for a parent operation. Resolves
   * once the child is settled, or unreachable; worker failures are recorded
   * on the child, not thrown. Throws only when the dispatch is refused
   * before anything is recorded or sent.
   */
  async dispatch(
    request: LocalWorkerDispatchRequest,
  ): Promise<LocalWorkerDispatchResult> {
    const { instructions } = this.options.transport;
    const definition = Object.prototype.hasOwnProperty.call(
      instructions,
      request.operation,
    )
      ? instructions[request.operation]
      : undefined;
    if (!definition)
      throw canopyCapabilityUnavailableError(
        'The local worker does not run this operation.',
      );
    const parsed = safeParseCanopySchema(definition.params, request.params);
    if (!parsed.success)
      throw canopyInvalidArgumentError('Invalid operation parameters.');
    const secrets = request.secrets ?? [];
    if (
      secrets.length > DELEGATION_SECRETS_MAX ||
      !secrets.every(
        (secret) => DelegationSecretFingerprintSchema.safeParse(secret).success,
      )
    )
      throw canopyInvalidArgumentError(
        'Execution secrets are recorded by fingerprint only.',
      );
    const lease = await this.placement();
    const parent = await this.options.operations.get(request.parentOperationId);
    if (!parent)
      throw new OperationLedgerRefusedError(
        'unknown-parent',
        'The parent operation does not exist.',
        { parentOperationId: request.parentOperationId },
      );
    const delegationId = randomUUID();
    const keyed = definition.idempotency === 'keyed';
    const controller = new AbortController();
    this.inFlight.set(delegationId, controller);
    try {
      const admitted = await this.options.operations.write((ledger) => {
        const accepted = ledger.acceptDispatch(
          {
            kind: request.operation,
            status: 'queued',
            receipt: {
              // Keys are scoped to their parent, so families need not
              // coordinate them.
              caller: `core.delegation:${parent.operationId}`,
              idempotencyKey: request.idempotencyKey,
              fingerprint: digest({
                params: parsed.data,
                secrets,
              }),
            },
            origin: { kind: 'delegation', sourceId: parent.operationId },
            owner: parent.owner,
            scope: { ...parent.scope, targetId: lease.targetId },
            parentOperationId: parent.operationId,
            authorityId: parent.authorityId,
            runtimeDelegationId: delegationId,
          },
          {
            delegationId,
            targetId: lease.targetId,
            leaseId: lease.leaseId,
            operation: {
              name: request.operation,
              version: definition.version,
              idempotency: definition.idempotency,
            },
            idempotencyKey: request.idempotencyKey,
            executorKey: keyed ? delegationId : null,
            activation: {
              delivery: 'inline-parameters',
              digest: digest({
                operation: request.operation,
                version: definition.version,
                params: parsed.data,
              }),
            },
            secrets: [...secrets],
          },
        );
        return {
          value: accepted,
          events:
            accepted.result.status === 'accepted'
              ? [accepted.result.event]
              : [],
        };
      });
      if (admitted.result.status !== 'accepted') {
        this.inFlight.delete(delegationId);
        return await this.replay(admitted.result, admitted.delegation);
      }
      const running = this.run(admitted.delegation, request.params, controller);
      this.running.set(delegationId, running);
      return await running;
    } finally {
      this.inFlight.delete(delegationId);
      this.running.delete(delegationId);
    }
  }

  async getDelegation(delegationId: string): Promise<DelegationRecord | null> {
    await this.placement();
    return this.options.operations.getDelegation(delegationId);
  }

  /** A parent's dispatches, oldest first. */
  async listDelegations(
    parentOperationId: string,
  ): Promise<DelegationRecord[]> {
    await this.placement();
    return this.options.operations.listDelegations(parentOperationId);
  }

  /** This run's degenerate lease on the builtin target. */
  async lease(): Promise<DelegationLeaseRecord> {
    return this.placement();
  }

  /**
   * The builtin target row and this run's lease, once per ledger. Taking the
   * lease settles dispatches an earlier run left unsettled.
   */
  private placement(): Promise<DelegationLeaseRecord> {
    return this.options.operations.write((ledger) => {
      if (this.placed?.ledger !== ledger) {
        ledger.registerTarget(IN_PROCESS_WORKER_TARGET);
        this.placed = {
          ledger,
          lease: ledger.acquireLease(
            IN_PROCESS_WORKER_TARGET.targetId,
            IN_PROCESS_LEASE_TERMS,
          ),
        };
      }
      return { value: this.placed.lease, events: [] };
    });
  }

  private async run(
    prepared: DelegationRecord,
    params: unknown,
    controller: AbortController,
  ): Promise<LocalWorkerDispatchResult> {
    const { transport } = this.options;
    const name = prepared.operation.name;
    // Cancelled while it was being recorded: it never reaches the worker.
    if (controller.signal.aborted)
      return this.settle(prepared.delegationId, {
        status: 'cancelled',
        resolution: 'not-started',
      });
    const delegation = await this.options.operations.write((ledger) => {
      const change = ledger.markDispatched(prepared.delegationId);
      return { value: change.delegation, events: [change.change.event] };
    });
    let value: unknown;
    try {
      value = await transport.instruction(name, params, {
        metadata:
          delegation.executorKey === null
            ? {}
            : { idempotencyKey: delegation.executorKey },
        signal: controller.signal,
      });
    } catch (error) {
      const payload = errorPayload(error);
      if (!controller.signal.aborted && !UNKNOWN_REPLY_KINDS.has(payload.kind))
        return this.settleReplied(delegation, {
          status: 'failed',
          error: payload,
          resolution: 'reply',
        });
      return this.resolveUnknown(delegation, controller.signal.aborted);
    }
    return this.settleReplied(
      delegation,
      { status: 'completed', ...this.outcome(value), resolution: 'reply' },
      value,
    );
  }

  /**
   * `unknown_outcome`: ask the worker how the work ended by the dispatch's
   * key, and record that. Nothing is sent again.
   */
  private async resolveUnknown(
    delegation: DelegationRecord,
    cancelRequested: boolean,
  ): Promise<LocalWorkerDispatchResult> {
    const { executorKey } = delegation;
    if (executorKey === null)
      return this.settle(delegation.delegationId, {
        status: 'failed',
        error: OUTCOME_UNKNOWN,
        resolution: 'unqueryable',
      });
    await this.options.operations.write((ledger) => ({
      value: ledger.markDelegation(delegation.delegationId, 'reconciling'),
      events: [],
    }));
    let receipt: WorkerExecutorReceipt | null;
    try {
      receipt = await this.options.transport.receipt(
        delegation.operation.name,
        executorKey,
      );
    } catch {
      // The child may still be running; a restart reconciles it as lost.
      const unreachable = await this.options.operations.write((ledger) => ({
        value: ledger.markDelegation(delegation.delegationId, 'unreachable'),
        events: [],
      }));
      const operation = await this.options.operations.get(
        delegation.childOperationId,
      );
      if (!operation)
        throw new OperationLedgerRefusedError(
          'not-found',
          'This operation does not exist.',
          { operationId: delegation.childOperationId },
        );
      return {
        operation,
        delegation: unreachable,
        result: undefined,
        replayed: false,
      };
    }
    if (receipt === null)
      return this.settleReplied(delegation, {
        ...(cancelRequested
          ? { status: 'cancelled' }
          : { status: 'failed', error: NOT_STARTED }),
        resolution: 'not-started',
      });
    if (receipt.state === 'completed')
      return this.settleReplied(
        delegation,
        {
          status: 'completed',
          ...this.outcome(receipt.result),
          resolution: 'executor-receipt',
        },
        receipt.result,
      );
    if (receipt.state === 'failed')
      return this.settleReplied(delegation, {
        ...(cancelRequested && receipt.error.kind === 'cancelled'
          ? { status: 'cancelled' }
          : { status: 'failed', error: receipt.error }),
        resolution: 'executor-receipt',
      });
    // A receipt is only answered once settled; a running one is malformed.
    return this.settleReplied(delegation, {
      status: 'failed',
      error: OUTCOME_UNKNOWN,
      resolution: 'unqueryable',
    });
  }

  private outcome(value: unknown): { outcome?: CanopyJsonValue } {
    // Results the ledger cannot hold are returned to the caller only.
    const parsed = CanopyJsonValueSchema.safeParse(value);
    return parsed.success ? { outcome: parsed.data } : {};
  }

  /** Settle, then let the worker forget its receipt. */
  private async settleReplied(
    delegation: DelegationRecord,
    settlement: Settlement,
    value?: unknown,
  ): Promise<LocalWorkerDispatchResult> {
    if (
      settlement.status === 'completed' &&
      reportsCancelled(delegation.operation.name, value)
    )
      settlement = { ...settlement, status: 'cancelled' };
    const settled = await this.settle(
      delegation.delegationId,
      settlement,
      value,
    );
    if (delegation.executorKey !== null)
      this.options.transport.releaseReceipt(
        delegation.operation.name,
        delegation.executorKey,
      );
    return settled;
  }

  private async settle(
    delegationId: string,
    settlement: Settlement,
    value?: unknown,
  ): Promise<LocalWorkerDispatchResult> {
    const settled = await this.options.operations.write((ledger) => {
      const change = ledger.settleDispatch(delegationId, settlement);
      return { value: change, events: [change.change.event] };
    });
    const { operation } = settled.change;
    const { delegation } = settled;
    return {
      operation,
      delegation,
      result:
        operation.status === 'completed' ||
        (keepsCancelledResult(operation.kind) &&
          operation.status === 'cancelled')
          ? value
          : undefined,
      replayed: false,
    };
  }

  private async replay(
    result: Exclude<OperationAcceptResult, { status: 'accepted' }>,
    delegation: DelegationRecord,
  ): Promise<LocalWorkerDispatchResult> {
    // Unfinished work is only ever running in this process: a restart
    // reconciles its children as lost. Join that dispatch, which settles
    // even when the worker becomes unreachable.
    const running =
      result.status === 'in-progress'
        ? this.running.get(delegation.delegationId)
        : undefined;
    if (running) return { ...(await running), replayed: true };
    const { operation } = result;
    return {
      operation,
      delegation,
      result:
        operation.status === 'completed' ||
        (keepsCancelledResult(operation.kind) &&
          operation.status === 'cancelled')
          ? operation.outcome
          : undefined,
      replayed: true,
    };
  }

  /**
   * The domain's cancellation: abort the one in-flight request, which the
   * transport carries to the worker handler running it. Work not in flight
   * here cannot be running on the in-process worker.
   */
  private async cancel(
    operation: OperationRecord,
  ): Promise<'cancelled' | 'requested'> {
    const delegationId = operation.runtimeDelegationId;
    const controller =
      delegationId === null ? undefined : this.inFlight.get(delegationId);
    if (controller) {
      controller.abort();
      return 'requested';
    }
    if (delegationId !== null) {
      const delegation = await this.getDelegation(delegationId);
      if (delegation && delegation.settledAt === null)
        await this.settle(delegationId, {
          status: 'cancelled',
          resolution:
            delegation.state === 'prepared' ? 'not-started' : 'unqueryable',
        });
    }
    return 'cancelled';
  }
}

interface Settlement {
  status: OperationTerminalStatus;
  outcome?: CanopyJsonValue;
  error?: CanopyErrorPayload;
  resolution: DelegationResolution;
}
