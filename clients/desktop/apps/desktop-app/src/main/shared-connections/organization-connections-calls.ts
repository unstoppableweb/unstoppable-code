import { app } from 'electron';
import {
  CanopyClientError,
  createCanopyClient,
  type CanopyClient,
} from '@canopy/core-client';
import {
  CORE_INTEGRATION_ORGANIZATION_CONNECTION_INSTRUCTION_DEFINITIONS,
  CORE_INTEGRATION_SHARED_CONNECTION_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  composeCanopyInstructionRegistries,
  composeCanopyQueryRegistries,
  type SharedConnectionUsageListParams,
} from '@canopy/protocol/canopy-core';
import { connectWebCore } from '../canopy-cloud/web-core-connection';
import { desktopWebCoreBindingOptions } from '../ipc/cloud-chats';

// ---------------------------------------------------------------------------
// The organization Settings Connectors page's calls on desktop (CAN-6245):
// `core.integration.sharedConnection.{list,tools,usage.list,connect,reconnect,
// disconnect,remove}` on the web core as the signed-in account. Refusals stay the web
// core's `CanopyClientError`, so the settings page tells lost access from a
// server it cannot reach; an absent operation answers capability_unavailable.
// ---------------------------------------------------------------------------

const CALL_TIMEOUT_MS = 30_000;

const DEFINITIONS = {
  queries: composeCanopyQueryRegistries(
    CORE_TRANSPORT_QUERY_DEFINITIONS,
    CORE_INTEGRATION_SHARED_CONNECTION_QUERY_DEFINITIONS,
  ),
  instructions: composeCanopyInstructionRegistries(
    CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    CORE_INTEGRATION_ORGANIZATION_CONNECTION_INSTRUCTION_DEFINITIONS,
  ),
  streams: {},
};

type Client = CanopyClient<
  (typeof DEFINITIONS)['queries'],
  (typeof DEFINITIONS)['instructions']
>;

type InstructionName =
  keyof typeof CORE_INTEGRATION_ORGANIZATION_CONNECTION_INSTRUCTION_DEFINITIONS;

export interface OrganizationConnectionsCalls {
  list(organizationId: string): Promise<unknown>;
  /** Every tool a connection's server offers, for a project's tool limit. */
  tools(
    organizationId: string,
    connectionId: string,
    projectId?: string,
  ): Promise<unknown>;
  /** The uses of the organization's connections, filtered, one page. */
  usage(params: SharedConnectionUsageListParams): Promise<unknown>;
  instruction(name: InstructionName, params: unknown): Promise<unknown>;
}

async function withClient<T>(
  method: string,
  call: (client: Client) => Promise<T>,
): Promise<T> {
  // Not behind the cloud chats flag: the web core gates these calls itself.
  const binding = {
    ...desktopWebCoreBindingOptions(),
    isEnabled: (): boolean => true,
  };
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const client: Client = await createCanopyClient({
    connection: await connectWebCore(binding, signal),
    clientName: 'canopy-desktop-organization-connections',
    clientVersion: app.getVersion(),
    definitions: DEFINITIONS,
    signal,
  });
  try {
    if (!client.manifest.has('operations', method))
      throw new CanopyClientError({
        kind: 'capability_unavailable',
        message: `The web core does not serve ${method}.`,
        retry: { kind: 'never' },
      });
    return await call(client);
  } finally {
    await client.close();
  }
}

export function createWebCoreOrganizationConnectionsCalls(): OrganizationConnectionsCalls {
  return {
    list: (organizationId) =>
      withClient('core.integration.sharedConnection.list', (client) =>
        client.query('core.integration.sharedConnection.list', {
          organizationId,
        }),
      ),
    usage: (params) =>
      withClient('core.integration.sharedConnection.usage.list', (client) =>
        client.query('core.integration.sharedConnection.usage.list', params),
      ),
    tools: (organizationId, connectionId, projectId) =>
      withClient('core.integration.sharedConnection.tools', (client) =>
        client.query('core.integration.sharedConnection.tools', {
          organizationId,
          connectionId,
          ...(projectId === undefined ? {} : { projectId }),
        }),
      ),
    instruction: (name, params) =>
      withClient(name, (client) =>
        CORE_INTEGRATION_ORGANIZATION_CONNECTION_INSTRUCTION_DEFINITIONS[
          name
        ].params.safeParse(params).success
          ? client.instruction(
              name,
              CORE_INTEGRATION_ORGANIZATION_CONNECTION_INSTRUCTION_DEFINITIONS[
                name
              ].params.parse(params),
            )
          : Promise.reject(
              new CanopyClientError({
                kind: 'invalid_argument',
                message: `Invalid ${name} request.`,
                retry: { kind: 'never' },
              }),
            ),
      ),
  };
}
