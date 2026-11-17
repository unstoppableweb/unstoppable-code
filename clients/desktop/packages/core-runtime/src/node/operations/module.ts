import {
  OPERATION_GRANTS,
  OPERATION_INSTRUCTION_DEFINITIONS,
  OPERATION_QUERY_DEFINITIONS,
  OPERATION_STREAM_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  defineRuntimeModule,
  type RuntimeModule,
} from '../../kernel/runtime-profile-graph';
import { createCoreOperationHandlers } from './handlers';
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
];

/**
 * `core.operation.*` over `service` as a graph module (CAN-5092). The
 * service opens its ledger on the first call and closes it when the graph
 * closes its resources.
 */
export function createCoreOperationModule(
  service: OperationService,
): RuntimeModule {
  const handlers = createCoreOperationHandlers(service);
  return defineRuntimeModule({
    name: 'core.operation',
    plane: 'core',
    services: [
      {
        name: 'core.operation.ledger',
        plane: 'core',
        stop: { 7: () => service.close() },
      },
    ],
    definitions: {
      queries: OPERATION_QUERY_DEFINITIONS,
      instructions: OPERATION_INSTRUCTION_DEFINITIONS,
      streams: OPERATION_STREAM_DEFINITIONS,
    },
    handlers,
  });
}
