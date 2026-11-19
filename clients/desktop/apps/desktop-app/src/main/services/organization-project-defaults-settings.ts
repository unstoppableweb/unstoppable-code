import { CanopyClientError } from '@canopy/core-client';
import { CanopyTransportError } from '@canopy/core-transport';
import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import {
  SettingsOperationError,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import {
  ORGANIZATION_SETTINGS_OPERATIONS,
  CAPABILITY_SETUP_INVALID_ITEM_CODE,
  CAPABILITY_SETUP_REVISION_CONFLICT_CODE,
} from '@canopy/protocol/settings/operations-organization';
import type { OrganizationDefaultsSettingsCalls } from '../organization-capabilities/web-core-calls';
import type { SettingsOrchestratedOperation } from './account-organization-settings';

// ---------------------------------------------------------------------------
// The organization Settings Project defaults page on desktop (CAN-6237).
//
// Its two settings table entries name a web compatibility route; desktop
// main answers them through `core.catalog.organizationDefaults.get` /
// `.update` on the web core instead, as the signed-in account, the same
// operations and connection the organization layer reads (phase 03). A
// refusal becomes the settings error the web route would have answered, so
// the shared page handles both hosts alike.
// ---------------------------------------------------------------------------

const READ = 'organization.settings.projectDefaults';
const UPDATE = 'organization.settings.projectDefaults.update';

const REVISION_CONFLICT = 'core.catalog.capabilitySetup.revisionConflict';
const INVALID_ITEM = 'core.catalog.capabilitySetup.invalidItem';

function payloadOf(error: unknown): CanopyErrorPayload | null {
  if (error instanceof CanopyClientError) return error.payload;
  if (error instanceof CanopyTransportError) return error.payload;
  return null;
}

/**
 * The settings error for a failed call. A write whose refusal does not prove
 * it never applied (a dropped connection, a timeout, an internal failure) is
 * `uncertain`, never retried.
 */
export function projectDefaultsSettingsError(
  error: unknown,
  write: boolean,
): SettingsOperationError {
  const payload = payloadOf(error);
  const fallback = new SettingsOperationError({
    code: write ? 'uncertain' : 'failed',
  });
  if (payload === null) return fallback;
  switch (payload.kind) {
    case 'conflict':
      return payload.code === REVISION_CONFLICT
        ? new SettingsOperationError({
            code: 'failed',
            status: 409,
            serverCode: CAPABILITY_SETUP_REVISION_CONFLICT_CODE,
          })
        : new SettingsOperationError({ code: 'failed', status: 409 });
    case 'invalid_argument':
      return new SettingsOperationError({
        code: 'failed',
        status: 400,
        ...(payload.code === INVALID_ITEM
          ? { serverCode: CAPABILITY_SETUP_INVALID_ITEM_CODE }
          : {}),
      });
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

/** The organization a validated Project defaults save is for, or null. */
export function projectDefaultsUpdateOrganizationId(
  name: SettingsOperationName,
  validatedInput: unknown,
): string | null {
  if (name !== UPDATE) return null;
  const input =
    ORGANIZATION_SETTINGS_OPERATIONS[UPDATE].input.safeParse(validatedInput);
  return input.success ? input.data.organizationId : null;
}

/**
 * The web core call that answers a Project defaults table entry, or null for
 * any other entry. `getCalls` is lazy so the web core client loads only
 * when the page is opened.
 */
export function projectDefaultsOrchestration(
  name: SettingsOperationName,
  validatedInput: unknown,
  getCalls: () => Promise<OrganizationDefaultsSettingsCalls>,
): SettingsOrchestratedOperation | null {
  if (name === READ) {
    const input =
      ORGANIZATION_SETTINGS_OPERATIONS[READ].input.safeParse(validatedInput);
    if (!input.success) return null;
    return async (): Promise<unknown> => {
      try {
        return await (await getCalls()).read(input.data.organizationId);
      } catch (error) {
        throw projectDefaultsSettingsError(error, false);
      }
    };
  }
  if (name === UPDATE) {
    const input =
      ORGANIZATION_SETTINGS_OPERATIONS[UPDATE].input.safeParse(validatedInput);
    if (!input.success) return null;
    return async (): Promise<unknown> => {
      try {
        return await (await getCalls()).update(input.data);
      } catch (error) {
        throw projectDefaultsSettingsError(error, true);
      }
    };
  }
  return null;
}
