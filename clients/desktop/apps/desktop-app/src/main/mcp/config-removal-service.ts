import {
  ForceMcpRemovalRequestSchema,
  InspectMcpRemovalRequestSchema,
  type ForceMcpRemovalResult,
  type InspectMcpRemovalResult,
} from '@canopy/protocol/mcp-removal';
import type { McpConfigRepository, McpRemovalPlan } from './config-repository';
import {
  McpRemovalEvidenceError,
  McpRemovalPreparationError,
  type McpRemovalReceipt,
} from './config-removal-evidence';
import {
  McpRemovalRefusedError,
  validateMcpRemovalId,
} from './config-removal-policy';

export interface McpConfigRemovalServiceHost {
  repository: McpConfigRepository;
  /** Trusted caller/grant/approval decision for the stronger operation, not a request flag. */
  authorizeForce(serverId: string): Promise<boolean>;
  /** Exact server-scoped cleanup, implemented solely by the existing OAuth owner. */
  clearServerCredentials(serverId: string): Promise<void>;
  clearConfigCredentials(serverId: string, configId: string): Promise<void>;
  /** Persist a pending uninstall's exact receipt pointer before custody, never stage claims. */
  recordRecovery?(serverId: string, recoveryId: string): Promise<void>;
  /** Publish only confirmed removal; must not perform account deletion or prune refs. */
  removed(serverId: string): Promise<void>;
}

export class McpOrdinaryRemovalError extends Error {
  /**
   * The server file is gone: the index update runs only after its unlink
   * resolved, so only that step's failure confirms it (CAN-7362).
   */
  readonly serverUnlinked: boolean;

  constructor(
    readonly phase:
      | 'preflight'
      | 'revalidation'
      | 'tokenClear'
      | 'serverUnlink'
      | 'indexUpdate',
    readonly effects: 'none' | 'unknown',
    readonly code: string,
  ) {
    super(
      effects === 'none'
        ? 'Device MCP removal was refused before cleanup. Inspect removal to choose a repair.'
        : 'Device MCP removal is incomplete. Some cleanup may have applied; inspect removal before retrying.',
    );
    this.name = 'McpOrdinaryRemovalError';
    this.serverUnlinked = phase === 'indexUpdate';
  }
}

export class McpRemovalInspectionError extends Error {
  readonly code = 'inspection_unavailable';
  constructor() {
    super(
      'Device MCP removal inspection is unavailable. No removal was attempted.',
    );
    this.name = 'McpRemovalInspectionError';
  }
}

function result(
  serverId: string,
  status: ForceMcpRemovalResult['status'],
  receipt?: McpRemovalReceipt,
  code?: ForceMcpRemovalResult['code'],
): ForceMcpRemovalResult {
  return {
    serverId,
    status,
    ...(receipt ? { recoveryId: receipt.recoveryId } : {}),
    custody: receipt?.custody ?? false,
    credentials: receipt?.credentials ?? false,
    index: receipt?.index ?? 'pending',
    ...(code ? { code } : {}),
  };
}

/** One authority. Interfaces must project this through the core catalog boundary. */
export class McpConfigRemovalService {
  constructor(private readonly host: McpConfigRemovalServiceHost) {}

  /** Confirms ordinary removal under the same lease used by server writers. */
  confirmAbsent(serverId: string): Promise<boolean> {
    validateMcpRemovalId(serverId);
    const repository = this.host.repository;
    return repository.withServerMutation(
      serverId,
      async () =>
        (await repository.readServerForMutation(serverId)) === undefined,
    );
  }

  /** Strict ordinary removal; no automatic escalation to evidence-preserving force. */
  remove(serverId: string): Promise<void> {
    const repository = this.host.repository;
    return repository.withServerMutation(serverId, async () => {
      let plan: McpRemovalPlan;
      try {
        plan = await repository.prepareRemoval(serverId);
      } catch (error) {
        throw new McpOrdinaryRemovalError(
          'preflight',
          'none',
          error instanceof McpRemovalRefusedError
            ? error.code
            : 'preflight_unavailable',
        );
      }
      await this.removeWithinLease(plan);
    });
  }

  /** Retirement prepares before rewriting refs and calls this without re-locking. */
  async removeWithinLease(plan: McpRemovalPlan): Promise<void> {
    const { serverId } = plan;
    const cleared = await Promise.allSettled(
      plan.configIds.map((configId) =>
        Promise.resolve().then(() =>
          this.host.clearConfigCredentials(serverId, configId),
        ),
      ),
    );
    if (cleared.some((entry) => entry.status === 'rejected'))
      throw new McpOrdinaryRemovalError(
        'tokenClear',
        'unknown',
        'credentials_failed',
      );
    try {
      await this.host.repository.removePrepared(plan, async (phase, run) => {
        try {
          return await run();
        } catch {
          throw new McpOrdinaryRemovalError(
            phase,
            'unknown',
            'publication_failed',
          );
        }
      });
    } catch (error) {
      if (error instanceof McpOrdinaryRemovalError) throw error;
      throw new McpOrdinaryRemovalError(
        'revalidation',
        'unknown',
        error instanceof McpRemovalRefusedError
          ? error.code
          : 'revalidation_failed',
      );
    }
    await this.host.removed(serverId).catch((): void => undefined);
  }

  inspect(raw: unknown): Promise<InspectMcpRemovalResult> {
    const { serverId } = InspectMcpRemovalRequestSchema.parse(raw);
    return this.host.repository
      .withServerMutation(serverId, () =>
        this.host.repository.inspectRemoval(serverId),
      )
      .catch(() => {
        throw new McpRemovalInspectionError();
      });
  }

  force(raw: unknown): Promise<ForceMcpRemovalResult> {
    const request = ForceMcpRemovalRequestSchema.parse(raw);
    const { serverId } = request;
    const repository = this.host.repository;
    return repository.withServerMutation(serverId, async () => {
      // No disk-queue turn is held across authorization or OAuth cleanup.
      let authorized = false;
      try {
        authorized = await this.host.authorizeForce(serverId);
      } catch {
        /* fail closed */
      }
      if (!authorized)
        return result(serverId, 'refused', undefined, 'authorization_required');
      let receipt: McpRemovalReceipt | undefined;
      let custodyAttempted = false;
      try {
        if (request.inspectedState !== undefined) {
          receipt = await repository.prepareForcedRemoval(
            serverId,
            request.inspectedState,
          );
        }
        const id = receipt?.recoveryId ?? request.recoveryId;
        if (id === undefined)
          return result(serverId, 'refused', undefined, 'state_changed');
        receipt = await repository.validateRemovalCustody(serverId, id);
        await this.host.recordRecovery?.(serverId, id);
        custodyAttempted = true;
        receipt = await repository.takeRemovalCustody(serverId, id);
      } catch (error) {
        if (error instanceof McpRemovalPreparationError)
          return {
            ...result(serverId, 'unknown', receipt, 'custody_failed'),
            recoveryId: error.recoveryId,
          };
        const refused =
          error instanceof McpRemovalRefusedError ||
          error instanceof McpRemovalEvidenceError;
        const code =
          error instanceof McpRemovalRefusedError &&
          error.code === 'previous_removal_pending'
            ? 'previous_removal_pending'
            : refused
              ? 'state_changed'
              : 'custody_failed';
        return {
          ...result(
            serverId,
            refused && !receipt && !custodyAttempted ? 'refused' : 'unknown',
            receipt,
            code,
          ),
          ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        };
      }
      try {
        if (!receipt.credentials) {
          await repository.readRemovalRecovery(serverId, receipt.recoveryId);
          await this.host.clearServerCredentials(serverId);
          receipt = await repository.confirmRemovalCredentials(
            serverId,
            receipt.recoveryId,
          );
        }
      } catch {
        return result(serverId, 'unknown', receipt, 'credentials_failed');
      }
      try {
        receipt = await repository.reconcileRemovalIndex(
          serverId,
          receipt.recoveryId,
        );
      } catch {
        return result(serverId, 'unknown', receipt, 'index_failed');
      }
      if (receipt.index !== 'complete')
        return result(serverId, 'unresolved', receipt, 'index_unresolved');
      // Refresh failure cannot turn a confirmed removal into a replayable failure.
      await this.host.removed(serverId).catch((): void => undefined);
      return result(serverId, 'complete', receipt);
    });
  }
}
