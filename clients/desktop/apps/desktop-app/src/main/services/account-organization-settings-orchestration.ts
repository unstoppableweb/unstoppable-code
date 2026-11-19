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
  OrganizationDefaultsSettingsCalls,
  ProjectSetupSettingsCalls,
} from '../organization-capabilities/web-core-calls';
import {
  projectDefaultsOrchestration,
  projectDefaultsUpdateOrganizationId,
} from './organization-project-defaults-settings';
import {
  projectSetupOrchestration,
  projectSetupUpdateProjectId,
} from './organization-project-setup-settings';
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
 * service loads only when a promotion is actually requested, and
 * `getProjectDefaultsCalls` and `getProjectSetupCalls` so the web core
 * client loads only when the Project defaults page (CAN-6237) or a project
 * setup panel (CAN-6239) is opened.
 */
export function createSettingsOrchestratedOperations(
  getService: () => Promise<PersonalOrganizationUpgradeService> = async () =>
    (
      await import('./personal-organization-upgrade-host')
    ).getPersonalOrganizationUpgradeService(),
  getProjectDefaultsCalls: () => Promise<OrganizationDefaultsSettingsCalls> = async () =>
    (
      await import('../organization-capabilities/web-core-calls')
    ).createWebCoreOrganizationDefaultsSettingsCalls(),
  getProjectSetupCalls: () => Promise<ProjectSetupSettingsCalls> = async () =>
    (
      await import('../organization-capabilities/web-core-calls')
    ).createWebCoreProjectSetupSettingsCalls(),
): SettingsOrchestrationResolver {
  return (name, validatedInput): SettingsOrchestratedOperation | null => {
    const projectDefaults = projectDefaultsOrchestration(
      name,
      validatedInput,
      getProjectDefaultsCalls,
    );
    if (projectDefaults !== null) return projectDefaults;
    const projectSetup = projectSetupOrchestration(
      name,
      validatedInput,
      getProjectSetupCalls,
    );
    if (projectSetup !== null) return projectSetup;
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
  /**
   * Read the organization's shared skills and plugins again on this device
   * after a Project defaults save, so new chats get them without waiting
   * for the minute-old cache to go stale.
   */
  refreshOrganizationCapabilities(organizationId: string): Promise<void>;
  /**
   * Read an organization project's shared set on this device again after
   * its setup was saved here (CAN-6239).
   */
  refreshProjectCapabilities(projectId: string): Promise<void>;
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
  refreshOrganizationCapabilities: async (organizationId) => {
    const { refreshOrganizationCapabilities } =
      await import('../organization-capabilities/service');
    await refreshOrganizationCapabilities(organizationId);
  },
  refreshProjectCapabilities: async (projectId) => {
    const { refreshProjectCapabilities } =
      await import('../organization-capabilities/service');
    await refreshProjectCapabilities(projectId);
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
 * A follow-up that starts `refresh` and returns at once. A failed refresh
 * leaves the minute-old organization cache, which refreshes on its own.
 */
function inBackground(
  operation: SettingsOperationName,
  refresh: () => Promise<void>,
): SettingsWriteFollowUp {
  return (): Promise<void> => {
    void refresh().catch((error: unknown) => {
      logMainProcessWarn(
        '[settings] Organization capabilities refresh failed',
        {
          operation,
          errorName:
            error instanceof Error ? error.constructor.name : typeof error,
        },
      );
    });
    return Promise.resolve();
  };
}

/**
 * Membership writes refresh main's account and finish context processing.
 * Gateway writes retry a missed refresh so the change reaches enforcement
 * without waiting for the periodic re-probe; a write that removes a gateway
 * first deletes this device's key for it, so a reconnect prompted by the
 * refreshed state cannot reuse the key. A Project defaults save starts a
 * refresh of the organization's shared items on this device, and a project
 * setup save one of that project's.
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
      case 'organization.settings.projectDefaults.update': {
        const organizationId = projectDefaultsUpdateOrganizationId(
          name,
          validatedInput,
        );
        if (organizationId === null) return null;
        // Not awaited: installing the new items can take a while, and the
        // save already succeeded.
        return inBackground(name, () =>
          effects.refreshOrganizationCapabilities(organizationId),
        );
      }
      case 'organization.projects.setup.update': {
        const projectId = projectSetupUpdateProjectId(name, validatedInput);
        if (projectId === null) return null;
        // As above: the project's set on this device, read again behind the
        // confirmed save.
        return inBackground(name, () =>
          effects.refreshProjectCapabilities(projectId),
        );
      }
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
