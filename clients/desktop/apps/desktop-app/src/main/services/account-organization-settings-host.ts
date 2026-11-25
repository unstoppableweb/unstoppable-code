import {
  settingsPageDataInputSchema,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
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

function isAiGatewaySettingsPageRead(
  name: SettingsOperationName,
  input: unknown,
): boolean {
  if (name !== 'settings.pageData') return false;
  const parsed = settingsPageDataInputSchema.safeParse(input);
  if (!parsed.success) return false;
  const { route } = parsed.data;
  return route.scope === 'account'
    ? route.page === 'ai-gateway'
    : route.scope === 'organization' && route.subtab === 'ai-gateway';
}

/**
 * The web can change a gateway with no push to this desktop, so opening its
 * settings re-reads the account. Detached: the page's own data comes from the
 * server and must not wait on this refresh.
 */
function refreshAccountInBackground(): void {
  void import('../ipc/settings')
    .then(({ reprobeAndApplyCanopyCloudEnforcedSettings }) =>
      reprobeAndApplyCanopyCloudEnforcedSettings(),
    )
    .catch(() => undefined);
}

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
      if (isAiGatewaySettingsPageRead(name, input))
        refreshAccountInBackground();
      // Gateway settings are gated by the web, which keeps a saved gateway
      // reachable with the flag off; connect asks it before probing.
      if (
        name === 'account.settings.ai-gateway.connect' ||
        name === 'organization.settings.ai-gateway.connect'
      ) {
        const gateway = await import('./ai-gateway-settings');
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
