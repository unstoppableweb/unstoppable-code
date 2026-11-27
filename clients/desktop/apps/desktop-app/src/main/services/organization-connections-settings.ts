import { CanopyClientError } from '@canopy/core-client';
import { CanopyTransportError } from '@canopy/core-transport';
import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import {
  SettingsOperationError,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import { ORGANIZATION_SETTINGS_OPERATIONS } from '@canopy/protocol/settings/operations-organization';
import type { OrganizationConnectionsCalls } from '../shared-connections/organization-connections-calls';
import type { SettingsOrchestratedOperation } from './account-organization-settings';

// ---------------------------------------------------------------------------
// The organization Settings Connectors page on desktop (CAN-6245).
//
// Its settings table entries name web compatibility routes; desktop main
// answers them through `core.integration.sharedConnection.*` on the web core
// instead, as the signed-in account. A refusal becomes the settings error
// the web route would have answered, so the shared page handles both hosts
// alike.
// ---------------------------------------------------------------------------

const READ = 'organization.settings.connections';
const TOOLS = 'organization.settings.connections.tools';
const USAGE = 'organization.settings.connectionUsage';
const WRITES = {
  'organization.settings.connections.connect':
    'core.integration.sharedConnection.connect',
  'organization.settings.connections.reconnect':
    'core.integration.sharedConnection.reconnect',
  'organization.settings.connections.disconnect':
    'core.integration.sharedConnection.disconnect',
  'organization.settings.connections.remove':
    'core.integration.sharedConnection.remove',
  'organization.settings.connections.projects':
    'core.integration.sharedConnection.projects.update',
} as const;

function payloadOf(error: unknown): CanopyErrorPayload | null {
  if (error instanceof CanopyClientError) return error.payload;
  if (error instanceof CanopyTransportError) return error.payload;
  return null;
}

/**
 * The settings error for a failed call. A write whose refusal does not prove
 * it never applied is `uncertain`, never retried.
 */
export function organizationConnectionsSettingsError(
  error: unknown,
  write: boolean,
): SettingsOperationError {
  const payload = payloadOf(error);
  const fallback = new SettingsOperationError({
    code: write ? 'uncertain' : 'failed',
  });
  if (payload === null) return fallback;
  switch (payload.kind) {
    case 'failed_precondition':
      return new SettingsOperationError({
        code: 'failed',
        status: 409,
        ...(payload.code === undefined ? {} : { serverCode: payload.code }),
      });
    case 'invalid_argument':
      return new SettingsOperationError({ code: 'failed', status: 400 });
    case 'permission_denied':
      return new SettingsOperationError({ code: 'forbidden', status: 403 });
    case 'not_found':
      return new SettingsOperationError({ code: 'not_found', status: 404 });
    case 'unauthenticated':
      return new SettingsOperationError({ code: 'unauthenticated' });
    case 'capability_unavailable':
      return new SettingsOperationError({ code: 'unsupported_server' });
    default:
      return fallback;
  }
}

function isWrite(name: SettingsOperationName): name is keyof typeof WRITES {
  return Object.prototype.hasOwnProperty.call(WRITES, name);
}

/**
 * The web core call that answers a Connectors table entry, or null for any
 * other entry. `getCalls` is lazy so the web core client loads only when the
 * page is opened.
 */
export function organizationConnectionsOrchestration(
  name: SettingsOperationName,
  validatedInput: unknown,
  getCalls: () => Promise<OrganizationConnectionsCalls>,
): SettingsOrchestratedOperation | null {
  if (name === READ) {
    const input =
      ORGANIZATION_SETTINGS_OPERATIONS[READ].input.safeParse(validatedInput);
    if (!input.success) return null;
    return async (): Promise<unknown> => {
      try {
        return await (await getCalls()).list(input.data.organizationId);
      } catch (error) {
        throw organizationConnectionsSettingsError(error, false);
      }
    };
  }
  if (name === TOOLS) {
    const input =
      ORGANIZATION_SETTINGS_OPERATIONS[TOOLS].input.safeParse(validatedInput);
    if (!input.success) return null;
    return async (): Promise<unknown> => {
      try {
        return await (
          await getCalls()
        ).tools(
          input.data.organizationId,
          input.data.connectionId,
          input.data.projectId,
        );
      } catch (error) {
        throw organizationConnectionsSettingsError(error, false);
      }
    };
  }
  if (name === USAGE) {
    const input =
      ORGANIZATION_SETTINGS_OPERATIONS[USAGE].input.safeParse(validatedInput);
    if (!input.success) return null;
    return async (): Promise<unknown> => {
      try {
        return await (await getCalls()).usage(input.data);
      } catch (error) {
        throw organizationConnectionsSettingsError(error, false);
      }
    };
  }
  if (!isWrite(name)) return null;
  const input =
    ORGANIZATION_SETTINGS_OPERATIONS[name].input.safeParse(validatedInput);
  if (!input.success) return null;
  const { idempotencyKey, ...rest } = input.data;
  return async (): Promise<unknown> => {
    try {
      return await (
        await getCalls()
      ).instruction(WRITES[name], {
        ...rest,
        _meta: { idempotencyKey },
      });
    } catch (error) {
      throw organizationConnectionsSettingsError(error, true);
    }
  };
}
