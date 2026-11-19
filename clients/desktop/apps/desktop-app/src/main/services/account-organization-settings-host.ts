import {
  acquireSettingsBridgeSession,
  peekSettingsBridgeSession,
  settingsBridgeCredentials,
  type SettingsBridgeSession,
} from '../canopy-cloud/settings-session';
import {
  executeSettingsOperation,
  openSettingsFeedStream,
} from '../canopy-cloud/settings-client';
import {
  isPaymentHandoffAvailable,
  openStrictAuthenticatedCloudPage,
} from '../canopy-cloud/authenticated-cloud-page';
import {
  getCanopyCloudCredentials,
  peekCanopyCloudAccountId,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import {
  createAccountOrganizationSettingsService,
  type AccountOrganizationSettingsService,
} from './account-organization-settings';
import {
  createSettingsOrchestratedOperations,
  createSettingsWriteFollowUps,
} from './account-organization-settings-orchestration';
import { createInvitationSettingsWriteObserver } from './invitation-settings-telemetry';

let service: AccountOrganizationSettingsService | undefined;

async function currentAccountId(): Promise<string | null> {
  try {
    return (await getCanopyCloudCredentials()).account?.id ?? null;
  } catch {
    return null;
  }
}

/** The process-wide hosted settings service, created on first use. */
export function getAccountOrganizationSettingsService(): AccountOrganizationSettingsService {
  service ??= createAccountOrganizationSettingsService<SettingsBridgeSession>({
    acquireSession: acquireSettingsBridgeSession,
    execute: async (session, name, input, options) => {
      if (
        name.startsWith('account.settings.ai-gateway.') ||
        name === 'organization.settings.ai-gateway.connect'
      ) {
        const gateway = await import('./ai-gateway-settings');
        gateway.requireAiGatewaySettings();
        if (name.endsWith('.connect'))
          return gateway.connectDesktopGateway(
            session,
            name,
            input,
            options?.signal,
          );
      }
      return executeSettingsOperation(session, name, input, options);
    },
    openFeedStream: openSettingsFeedStream,
    credentials: settingsBridgeCredentials,
    currentAccountId,
    currentSession: peekSettingsBridgeSession,
    signedInAccountId: peekCanopyCloudAccountId,
    subscribeAccountChanges: (listener) =>
      subscribeCanopyCloudAccountChanges((entry) =>
        listener(entry?.account?.id ?? null),
      ),
    openStrictCloudPage: openStrictAuthenticatedCloudPage,
    paymentHandoffAvailable: isPaymentHandoffAvailable,
    resolveOrchestrated: createSettingsOrchestratedOperations(),
    resolveWriteFollowUp: createSettingsWriteFollowUps(),
    observeWrite: createInvitationSettingsWriteObserver(),
  });
  return service;
}

/** Close every window subscription; the bridge lifecycle owns the sessions. */
export function disposeAccountOrganizationSettingsService(): void {
  service?.dispose();
  service = undefined;
}
