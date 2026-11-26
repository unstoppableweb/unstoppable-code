import {
  CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS,
  CORE_OPERATION_LEDGER_QUERY_DEFINITIONS,
  CORE_OPERATION_LEDGER_STREAM_DEFINITIONS,
  OPERATION_GRANTS,
  OPERATION_INSTRUCTION_DEFINITIONS,
  OPERATION_QUERY_DEFINITIONS,
  OPERATION_STREAM_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  defineRuntimeModule,
  type RuntimeModule,
} from '../../kernel/runtime-profile-graph';
import type { RuntimeHealthCheck } from '../../kernel/service-container';
import { createCoreOperationHandlers } from './handlers';
import { createCoreOperationLedgerHandlers } from './ledger-handlers';
import type { OperationService } from './service';

/** What a peer needs for `core.operation.*` where a host serves it. */
export const CORE_OPERATION_CALLER_GRANTS = [
  OPERATION_GRANTS.read,
  OPERATION_GRANTS.cancel,
] as const;

export const CORE_OPERATION_OPERATIONS: readonly string[] = [
  ...Object.keys(OPERATION_QUERY_DEFINITIONS),
  ...Object.keys(OPERATION_INSTRUCTION_DEFINITIONS),
  ...Object.keys(OPERATION_STREAM_DEFINITIONS),
  // The ledger owner's internal operations (CAN-6986 L3), bound to its lease.
  ...Object.keys(CORE_OPERATION_LEDGER_QUERY_DEFINITIONS),
  ...Object.keys(CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS),
  ...Object.keys(CORE_OPERATION_LEDGER_STREAM_DEFINITIONS),
];

/**
 * `core.operation.*` over `service` as a graph module (CAN-5092). The
 * service opens its ledger on the first call and closes it when the graph
 * closes its resources. `health` reports the ledger's failures no caller
 * could see, as the daemon records them from the service's `onError`.
 */
export function createCoreOperationModule(
  service: OperationService,
  options: { readonly health?: () => RuntimeHealthCheck } = {},
): RuntimeModule {
  const handlers = createCoreOperationHandlers(service);
  const ledger = createCoreOperationLedgerHandlers(service);
  return defineRuntimeModule({
    name: 'core.operation',
    plane: 'core',
    services: [
      {
        name: 'core.operation.ledger',
        plane: 'core',
        stop: { 7: () => service.close() },
        ...(options.health && { health: options.health }),
      },
    ],
    definitions: {
      queries: {
        ...OPERATION_QUERY_DEFINITIONS,
        ...CORE_OPERATION_LEDGER_QUERY_DEFINITIONS,
      },
      instructions: {
        ...OPERATION_INSTRUCTION_DEFINITIONS,
        ...CORE_OPERATION_LEDGER_INSTRUCTION_DEFINITIONS,
      },
      streams: {
        ...OPERATION_STREAM_DEFINITIONS,
        ...CORE_OPERATION_LEDGER_STREAM_DEFINITIONS,
      },
    },
    handlers: {
      queries: { ...handlers.queries, ...ledger.queries },
      instructions: { ...handlers.instructions, ...ledger.instructions },
      streams: { ...handlers.streams, ...ledger.streams },
    },
  });
}
