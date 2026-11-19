import {
  MCP_REMOVAL_GRANT,
  type CORE_CATALOG_MCP_REMOVAL_QUERY_DEFINITIONS,
  type CORE_CATALOG_MCP_REMOVAL_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  McpRemovalCandidatesResult,
  ForceMcpRemovalRequest,
  ForceMcpRemovalResult,
  InspectMcpRemovalRequest,
  InspectMcpRemovalResult,
} from '@canopy/protocol/mcp-removal';
import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherHandlerMap,
  CanopyDispatcherInstructionHandlerMap,
} from '../../runtime/types';

export interface CoreMcpRemovalHost {
  candidates(): Promise<McpRemovalCandidatesResult>;
  inspect(request: InspectMcpRemovalRequest): Promise<InspectMcpRemovalResult>;
  force(
    request: ForceMcpRemovalRequest,
    caller: CanopyCallerDescriptor,
  ): Promise<ForceMcpRemovalResult>;
}

/** No policy or storage duplicate: the host retains one repository and OAuth owner. */
export function createCoreMcpRemovalHandlers(host: CoreMcpRemovalHost): {
  queries: CanopyDispatcherHandlerMap<
    typeof CORE_CATALOG_MCP_REMOVAL_QUERY_DEFINITIONS
  >;
  instructions: CanopyDispatcherInstructionHandlerMap<
    typeof CORE_CATALOG_MCP_REMOVAL_INSTRUCTION_DEFINITIONS
  >;
} {
  return {
    queries: {
      'core.catalog.mcpServer.removal.candidates': () => host.candidates(),
      'core.catalog.mcpServer.removal.inspect': async (request) => {
        try {
          return await host.inspect({ serverId: request.serverId });
        } catch {
          throw new CanopyOperationError({
            kind: 'unavailable',
            code: 'core.catalog.mcpServer.inspectionUnavailable',
            message:
              'Device MCP removal inspection is unavailable. No removal was attempted.',
            retry: { kind: 'same_request' },
          });
        }
      },
    },
    instructions: {
      'core.catalog.mcpServer.removal.force': async (request, context) => {
        // Also guard direct handler use; request fields can never confer this grant.
        if (!context.caller.grants.includes(MCP_REMOVAL_GRANT))
          throw new CanopyOperationError({
            kind: 'permission_denied',
            message: 'Device MCP forced removal requires authorization.',
            retry: { kind: 'never' },
          });
        try {
          return await host.force(
            {
              serverId: request.serverId,
              mode: request.mode,
              ...(request.finishUninstall ? { finishUninstall: true } : {}),
              ...(request.inspectedState
                ? { inspectedState: request.inspectedState }
                : { recoveryId: request.recoveryId }),
            },
            context.caller,
          );
        } catch {
          throw new CanopyOperationError({
            kind: 'unavailable',
            message:
              'Device MCP removal could not be confirmed. Inspect removal before retrying.',
            retry: { kind: 'never' },
          });
        }
      },
    },
  };
}
