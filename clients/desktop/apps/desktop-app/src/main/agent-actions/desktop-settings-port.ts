import {
  desktopAiGatewayEnabled,
  executeDesktopAiGateway,
} from './desktop-ai-gateway';
import type {
  AgentActionCall,
  AgentSettingsOpenResult,
  AgentSettingsPort,
} from '@canopy/agent-actions';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { SettingsRoute } from '@canopy/protocol/settings';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import { isHostedSettingsEnabled } from '../services/hosted-settings-feature-flag';
import {
  sendToWindowDetailed,
  type SendableBrowserWindow,
} from '../lib/window-send';

/**
 * What the port knows about the signed-in account. `organizationIds` is null
 * when the cached account carries no membership list, so organization routes
 * fail closed instead of trusting an absent list. It includes the personal
 * organization, which `/account` lists apart from the teams.
 */
export type DesktopSettingsAccount =
  | { status: 'signed_in'; organizationIds: readonly string[] | null }
  | { status: 'signed_out' }
  | { status: 'unavailable' };

export interface DesktopSettingsPortDeps {
  readAccount(): Promise<DesktopSettingsAccount>;
  /** The main window of the calling chat, or null when it has none. */
  getWindow(
    call: AgentActionCall<CanopyInjectedToolRuntime>,
  ): SendableBrowserWindow | null;
  /** The `canopy-desktop-hosted-settings` rollout flag. */
  hostedSettingsEnabled(): boolean;
}

/**
 * The account and memberships the main process already holds: the cached
 * cloud account (no network call). Unreadable secure storage is
 * `unavailable`; no account, a guest account, or an account without an id is
 * `signed_out`.
 */
export async function readDesktopSettingsAccount(): Promise<DesktopSettingsAccount> {
  const read = await readCanopyCloudAccountWithStatus();
  if (read.status !== 'ok') return { status: 'unavailable' };
  const entry = read.entry;
  // A partially written or legacy record can lack an id; treat it as signed
  // out, as the workspace context service does.
  const rawId: unknown = entry?.account?.id;
  const accountId = typeof rawId === 'string' ? rawId.trim() : '';
  if (entry === null || isGuestAccount(entry) || accountId === '')
    return { status: 'signed_out' };
  if (!entry.organizations)
    return { status: 'signed_in', organizationIds: null };
  const organizationIds = entry.organizations.map(
    (organization) => organization.id,
  );
  if (entry.personalOrganizationId)
    organizationIds.push(entry.personalOrganizationId);
  return { status: 'signed_in', organizationIds };
}

/**
 * `settings.open` on desktop: verify the account and, for an organization
 * route, that the organization is one of the account's current memberships,
 * then ask the calling chat's main window to open the route. Nothing opens
 * while the hosted settings rollout flag is off, when membership cannot be
 * determined, or when the window is gone.
 */
export function createDesktopSettingsPort(
  deps: DesktopSettingsPortDeps,
): AgentSettingsPort<CanopyInjectedToolRuntime> {
  return {
    open: async (
      route: SettingsRoute,
      call: AgentActionCall<CanopyInjectedToolRuntime>,
    ): Promise<AgentSettingsOpenResult> => {
      if (!deps.hostedSettingsEnabled())
        return { status: 'rejected', reason: 'unavailable' };
      let account: DesktopSettingsAccount;
      try {
        account = await deps.readAccount();
      } catch {
        account = { status: 'unavailable' };
      }
      if (account.status === 'signed_out')
        return { status: 'rejected', reason: 'signed_out' };
      if (account.status === 'unavailable')
        return { status: 'rejected', reason: 'unavailable' };
      if (route.scope === 'organization') {
        if (account.organizationIds === null)
          return { status: 'rejected', reason: 'unavailable' };
        if (!account.organizationIds.includes(route.organizationId))
          return { status: 'rejected', reason: 'organization_not_member' };
      }
      const delivery = sendToWindowDetailed(
        deps.getWindow(call),
        IPC_CHANNELS.accountOrganizationSettingsOpen,
        route,
      );
      return delivery.delivered
        ? { status: 'opened' }
        : { status: 'rejected', reason: 'unavailable' };
    },
  };
}

export const desktopSettingsPort: AgentSettingsPort<CanopyInjectedToolRuntime> =
  {
    ...createDesktopSettingsPort({
      readAccount: readDesktopSettingsAccount,
      hostedSettingsEnabled: isHostedSettingsEnabled,
      getWindow: (call) =>
        call.host.worktreeActionRuntime?.getWindow() ??
        call.host.settingsWindow?.() ??
        null,
    }),
    aiGatewayEnabled: desktopAiGatewayEnabled,
    aiGateway: executeDesktopAiGateway,
  };
