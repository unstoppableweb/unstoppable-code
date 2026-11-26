import { randomUUID } from 'node:crypto';

import {
  OperationService,
  RemoteOperationService,
  createCoreOperationHandlers,
  createRemoteCoreOperationHandlers,
  type CoreOperationHandlers,
  type OperationLedger,
  type OperationLedgerTransport,
  type OperationServicePort,
} from '@canopy/core-runtime/node/operations';
import {
  logMainProcessInfo,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import { getOperationLedgerPath } from '../lib/paths';

/*
 * Registers `core.operation.*` on the desktop dispatcher (CAN-4130). The
 * operation service in `@canopy/core-runtime/node/operations` owns the
 * durable operation ledger; this adapter is its only owner in Electron main
 * and resolves the ledger with main's canonical path helper. The ledger and
 * `node:sqlite` load on the first operation call or domain admission, never
 * at startup. Domains (pipelines, scripts, hooks) register with `service`
 * as they adopt operation records.
 */

export interface CoreOperationAdapter extends CoreOperationHandlers {
  readonly service: OperationServicePort;
  close(): void;
}

export function createCoreOperationAdapter(
  options: { ledgerPath?: () => string } = {},
): Omit<CoreOperationAdapter, 'service'> & {
  readonly service: OperationService;
} {
  const ledgerPath = options.ledgerPath ?? getOperationLedgerPath;
  const service = new OperationService({
    openLedger: async (): Promise<OperationLedger> => {
      const { OperationLedger } =
        await import('@canopy/core-runtime/node/operations/ledger');
      return OperationLedger.open(ledgerPath(), {
        onIdentityRetention: (result): void => {
          if (result.status === 'pruned')
            logMainProcessInfo(
              `[operations] deleted ${result.operations} settled helper-run operation rows past retention`,
            );
          else if (result.status === 'indexed')
            logMainProcessInfo(
              `[operations] built the identity retention index in ${result.durationMs} ms`,
            );
          else
            logMainProcessWarn(
              '[operations] identity retention batch failed; rows kept',
              result.error,
            );
        },
      });
    },
    onError: (error, context): void => {
      logMainProcessWarn(`[operations] ${context} failed`, error);
    },
  });
  const handlers = createCoreOperationHandlers(service);
  return {
    queries: {
      'core.operation.get': handlers.queries['core.operation.get'],
      'core.operation.list': handlers.queries['core.operation.list'],
    },
    instructions: {
      'core.operation.cancel': handlers.instructions['core.operation.cancel'],
    },
    streams: {
      'core.operation.events': handlers.streams['core.operation.events'],
    },
    service,
    close: (): void => {
      service.close();
    },
  };
}

/**
 * This process's run as the ledger owner, minted by its first adapter rather
 * than at module load: its owner sessions resume it, so a reconnect or a
 * daemon restart leaves the work running here as it is.
 */
let processOwnerRun: string | undefined;

/**
 * The adapter over a ledger the daemon holds (CAN-6986 L3): the service
 * makes each call over Electron main's daemon owner connection, never a
 * leased peer connection, and the domains' cancellation and recovery stay in
 * this process. Unselected: only a test seam builds it until the
 * `operation_ledger` ownership row names the daemon (CAN-6986 L5).
 */
export function createDaemonCoreOperationAdapter(options: {
  /** The owner connection's client; read at each call. */
  readonly ownerClient: () => Promise<OperationLedgerTransport>;
}): CoreOperationAdapter & { readonly service: RemoteOperationService } {
  processOwnerRun ??= randomUUID();
  const service = new RemoteOperationService({
    transport: options.ownerClient,
    ownerRun: processOwnerRun,
    onError: (error, context): void => {
      logMainProcessWarn(`[operations] ${context} failed`, error);
    },
  });
  const handlers = createRemoteCoreOperationHandlers(service);
  return {
    ...handlers,
    service,
    close: (): void => {
      service.close();
    },
  };
}
