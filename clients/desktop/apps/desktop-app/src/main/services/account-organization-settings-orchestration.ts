import { UpgradePersonalOrganizationRequestSchema } from '@canopy/protocol/organizations';
import {
  SettingsOperationError,
  settingsErrorCodeForStatus,
  settingsOperation,
  settingsOperationRequest,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import { ACCOUNT_SETTINGS_OPERATIONS } from '@canopy/protocol/settings/operations-account';
import { ORGANIZATION_SETTINGS_OPERATIONS } from '@canopy/protocol/settings/operations-organization';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import type { PersonalOrganizationUpgradeService } from './personal-organization-upgrade';
import type {
  SettingsOrchestratedOperation,
  SettingsOrchestrationResolver,
  SettingsWriteFollowUp,
  SettingsWriteFollowUpResolver,
} from './account-organization-settings';

/**
 * Promotion of the Personal organization runs desktop orchestration after
 * the server call (suppressing the local upgrade prompt, refreshing the
 * account and switching the workspace context), so a settings table entry
 * that names the promotion route goes through the existing
 * {@link PersonalOrganizationUpgradeService} instead of a raw request.
 *
 * Matching is on the request the entry builds from validated input, not on
 * the entry's name, so the route stays bound to the orchestration whatever
 * the table calls it. Membership changes use the separate best-effort
 * follow-up below; project conversion is not a table entry.
 */
const PROMOTION_PATH =
  /^\/api\/(?:v1\/organizations|account\/organizations)\/([^/?#]+)\/upgrade$/;

function promotionOrganizationId(
  name: SettingsOperationName,
  validatedInput: unknown,
): string | null {
  const operation = settingsOperation(name);
  if (operation.kind !== 'write' || operation.transport !== 'backend')
    return null;
  const request = settingsOperationRequest(name, validatedInput);
  if (request.method !== 'POST') return null;
  const match = PROMOTION_PATH.exec(request.path);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

function settingsErrorFromCloud(error: unknown): Error {
  // The upgrade service's identity fence.
  if (error instanceof Error && error.message === 'account-changed')
    return new SettingsOperationError({ code: 'expired' });
  if (!(error instanceof CanopyCloudClientError))
    return error instanceof Error ? error : new Error('Promotion failed');
  if (error.code === 'network-error')
    return new SettingsOperationError({ code: 'uncertain' });
  if (error.code === 'missing-api-key')
    return new SettingsOperationError({ code: 'unauthenticated' });
  if (error.status === undefined)
    return new SettingsOperationError({ code: 'failed' });
  return new SettingsOperationError({
    code: settingsErrorCodeForStatus(error.status, { write: true }),
    status: error.status,
    ...(error.serverCode === undefined ? {} : { serverCode: error.serverCode }),
  });
}

/**
 * Resolver for the settings service. `getService` is lazy so the upgrade
 * service loads only when a promotion is actually requested.
 */
export function createSettingsOrchestratedOperations(
  getService: () => Promise<PersonalOrganizationUpgradeService> = async () =>
    (
      await import('./personal-organization-upgrade-host')
    ).getPersonalOrganizationUpgradeService(),
): SettingsOrchestrationResolver {
  return (name, validatedInput): SettingsOrchestratedOperation | null => {
    const organizationId = promotionOrganizationId(name, validatedInput);
    if (organizationId === null) return null;
    const body = UpgradePersonalOrganizationRequestSchema.safeParse(
      settingsOperationRequest(name, validatedInput).body,
    );
    if (!body.success || body.data.organizationId !== organizationId)
      return null;
    return async (): Promise<unknown> => {
      try {
        const outcome = await (await getService()).promote(body.data);
        return outcome.promotion;
      } catch (error) {
        throw settingsErrorFromCloud(error);
      }
    };
  };
}

/** Effects a settings write's follow-up may run; injectable for tests. */
export interface SettingsWriteFollowUpEffects {
  /** One account refresh, then finish context processing. */
  refresh: SettingsWriteFollowUp;
  /** Like `refresh`, retrying a superseded or offline miss in the background. */
  refreshWithRetry(operationName: SettingsOperationName): Promise<void>;
  /** Delete this device's stored key for a removed gateway. */
  clearRemovedGatewayKey(
    organizationId: string,
    accountId: string,
  ): Promise<unknown>;
}

async function finishWorkspaceContextProcessing(): Promise<void> {
  const { getWorkspaceContextService } =
    await import('../lib/workspace-context-service');
  await getWorkspaceContextService().whenIdle();
}

const DEFAULT_SETTINGS_WRITE_FOLLOW_UP_EFFECTS: SettingsWriteFollowUpEffects = {
  refresh: async (): Promise<void> => {
    const { reprobeAndApplyCanopyCloudEnforcedSettings } =
      await import('../ipc/settings');
    await reprobeAndApplyCanopyCloudEnforcedSettings();
    await finishWorkspaceContextProcessing();
  },
  refreshWithRetry: async (operationName): Promise<void> => {
    const { refreshAccountAfterSettingsWrite } =
      await import('../ipc/settings');
    await refreshAccountAfterSettingsWrite(operationName);
    await finishWorkspaceContextProcessing();
  },
  clearRemovedGatewayKey: async (organizationId, accountId) => {
    const { clearModelGatewayCredentialForRemovedGateway } =
      await import('../ipc/settings');
    return clearModelGatewayCredentialForRemovedGateway(
      organizationId,
      accountId,
    );
  },
};

/**
 * The organization whose gateway a validated write removes (its URL set to
 * null), or null when the write keeps or replaces the gateway.
 */
function removedGatewayOrganizationId(
  name: SettingsOperationName,
  validatedInput: unknown,
): string | null {
  if (name === 'account.settings.ai-gateway.update') {
    const input =
      ACCOUNT_SETTINGS_OPERATIONS[name].input.safeParse(validatedInput);
    return input.success && input.data.baseUrl === null
      ? input.data.expectedOrganizationId
      : null;
  }
  if (name === 'organization.settings.policies.update') {
    const input =
      ORGANIZATION_SETTINGS_OPERATIONS[name].input.safeParse(validatedInput);
    return input.success && input.data.modelGatewayBaseUrl === null
      ? input.data.organizationId
      : null;
  }
  return null;
}

/**
 * Membership writes refresh main's account and finish context processing.
 * Gateway writes retry a missed refresh so the change reaches enforcement
 * without waiting for the periodic re-probe; a write that removes a gateway
 * first deletes this device's key for it, so a reconnect prompted by the
 * refreshed state cannot reuse the key.
 */
export function createSettingsWriteFollowUps(
  effects: SettingsWriteFollowUpEffects = DEFAULT_SETTINGS_WRITE_FOLLOW_UP_EFFECTS,
): SettingsWriteFollowUpResolver {
  return (name, validatedInput, accountId): SettingsWriteFollowUp | null => {
    switch (name) {
      case 'account.settings.ai-gateway.update':
      case 'organization.settings.policies.update': {
        const removedOrganizationId = removedGatewayOrganizationId(
          name,
          validatedInput,
        );
        if (removedOrganizationId === null)
          return () => effects.refreshWithRetry(name);
        return async (): Promise<void> => {
          try {
            await effects.clearRemovedGatewayKey(
              removedOrganizationId,
              accountId,
            );
          } catch (error) {
            logMainProcessWarn(
              '[settings] Removed AI gateway key clear failed',
              {
                operation: name,
                organizationId: removedOrganizationId,
                errorName:
                  error instanceof Error
                    ? error.constructor.name
                    : typeof error,
              },
            );
          }
          await effects.refreshWithRetry(name);
        };
      }
      case 'organization.create':
      case 'organization.delete':
      case 'organization.leave':
        return effects.refresh;
      case 'organization.invitations.respond': {
        const input =
          ORGANIZATION_SETTINGS_OPERATIONS[name].input.safeParse(
            validatedInput,
          );
        return input.success && input.data.action === 'accept'
          ? effects.refresh
          : null;
      }
      default:
        return null;
    }
  };
}
