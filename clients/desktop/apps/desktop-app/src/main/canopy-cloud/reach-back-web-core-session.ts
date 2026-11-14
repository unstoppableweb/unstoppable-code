import { randomUUID } from 'node:crypto';
import {
  CanopyClientError,
  createCanopyClient,
  createCanopyClientLease,
} from '@canopy/core-client';
import {
  CORE_INTEGRATION_MCP_HOST_INSTRUCTION_DEFINITIONS,
  CORE_INTEGRATION_MCP_HOST_STREAM_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  composeCanopyInstructionRegistries,
  type McpHostRequestsItem,
} from '@canopy/protocol/canopy-core';
import {
  connectWebCore,
  type WebCoreBindingOptions,
} from './web-core-connection';
import type { ReachBackSession } from '../mcp/cloud-reach-back/service';
import { acknowledgedItems } from '../mcp/cloud-reach-back/stream-credit';

/**
 * Whether the web core takes `core.integration.mcpHostStatus.report`, so
 * this desktop may open its stream with `servingReports` (CAN-6659).
 */
export function takesServingReports(manifest: {
  has(kind: 'operations', name: string): boolean;
}): boolean {
  return manifest.has('operations', 'core.integration.mcpHostStatus.report');
}

/** As the renderer relay renews its leases. */
const LEASE_RENEWAL_MS = 30_000;

const DEFINITIONS = {
  queries: {},
  instructions: composeCanopyInstructionRegistries(
    CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    CORE_INTEGRATION_MCP_HOST_INSTRUCTION_DEFINITIONS,
  ),
  streams: CORE_INTEGRATION_MCP_HOST_STREAM_DEFINITIONS,
};

/**
 * Opens main's own web core connection for reach-back (CAN-6176 PR 7a,
 * D22): with the signed-in account's desktop key, a lease held for the
 * connection's life, and `core.integration.mcpHostRequests` open. The lease
 * and the open stream are what the cloud reads as this desktop being online.
 * A dropped connection ends the session; the service opens another.
 */
export function createReachBackSessionOpener(
  binding: WebCoreBindingOptions,
  clientVersion: string,
): (signal: AbortSignal) => Promise<ReachBackSession> {
  return async (signal) => {
    const client = await createCanopyClient({
      connection: await connectWebCore(binding, signal),
      clientName: 'canopy-desktop-cloud-reach-back',
      clientVersion,
      definitions: DEFINITIONS,
      signal,
    });
    const lease = createCanopyClientLease({
      client,
      attach: () =>
        Promise.reject(
          new CanopyClientError({
            kind: 'unavailable',
            message: 'The reach-back connection closed.',
            retry: { kind: 'never' },
          }),
        ),
      identity: {
        clientInstanceId: randomUUID(),
        interfaceKind: 'http',
        label: 'Desktop MCP servers for cloud chats',
      },
      renewalIntervalMs: LEASE_RENEWAL_MS,
      presence: () => ({ interactive: false, foreground: false }),
    });
    const close = async (): Promise<void> => {
      await lease.release('normal_shutdown').catch(() => undefined);
      await client.close().catch(() => undefined);
    };
    try {
      await lease.acquire();
      // Held to its reports only where the web core takes them (CAN-6659);
      // an older one keeps offering this desktop's servers while it's online.
      const reports = takesServingReports(client.manifest);
      const stream = await client.openStream(
        'core.integration.mcpHostRequests',
        reports ? { servingReports: true } : {},
      );
      return {
        items: acknowledgedItems<McpHostRequestsItem>(stream, (params) =>
          client.instruction('core.events.ack', params),
        ),
        respond: async (answer) => {
          await client.instruction(
            'core.integration.mcpHostRequest.respond',
            answer,
          );
        },
        ...(reports
          ? {
              report: async (servers) => {
                try {
                  await client.instruction(
                    'core.integration.mcpHostStatus.report',
                    { servers: [...servers] },
                  );
                  return 'reported';
                } catch (error) {
                  if (
                    error instanceof CanopyClientError &&
                    error.payload.code ===
                      'core.integration.mcpHostConnectionNotOwned'
                  )
                    return 'not_owned';
                  throw error;
                }
              },
            }
          : {}),
        close: async () => {
          stream.close();
          await close();
        },
      };
    } catch (error) {
      await close();
      throw error;
    }
  };
}
