import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { isCursorHarnessReleased } from '@/lib/cursor-settings';
import { isCopilotHarnessReleased } from '@/lib/copilot-settings';
import { isOpenCodeHarnessReleased } from '@/lib/opencode-settings';
import { CopilotConnection } from './CopilotConnection';
import { OpenCodeConnection } from './OpenCodeConnection';
import { CursorConnection } from './CursorConnection';
import { AccountProxyProviderRow } from './account-proxy/AccountProxyProviderRow';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { CursorApprovalCheck } from './CursorApprovalCheck';
import { type JSX, type ReactNode, useMemo } from 'react';
import { ProviderAuthPanel } from '@/components/auth/ProviderAuthPanel';
import { CanopyCloudAccountSection } from './CanopyCloudAccountSection';
import { ModelGatewayCredentialSection } from './ModelGatewayCredentialSection';
import {
  orderGatewaysForContext,
  useOrgModelGateways,
  usePersonalModelGateway,
} from '@/hooks/useOrgModelGateway';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { LinearKeyRow } from './LinearKeyRow';
import { useHostedSettingsAvailable } from './hosted/hosted-settings-availability';
import { SettingsGroup, SettingsPage, SettingsSection } from './SettingsLayout';

interface AccountSectionProps {
  label: string;
  children: ReactNode;
}

/** A group of account rows under a heading, e.g. "LLM provider". */
function AccountSection({ label, children }: AccountSectionProps): JSX.Element {
  return (
    <SettingsSection
      title={
        <span
          data-testid={`account-section-header-${label.toLowerCase().replace(/\s+/g, '-')}`}
        >
          {label}
        </span>
      }
    >
      {children}
    </SettingsSection>
  );
}

/**
 * The "LLM provider" section: org gateways, Claude, Codex, Copilot, OpenCode,
 * Cursor, proxy.
 */
function LlmProviderSection({
  cursorReleased,
}: {
  cursorReleased: boolean;
}): JSX.Element {
  const copilotReleased = useFeatureFlagsStore(isCopilotHarnessReleased);
  const opencodeReleased = useFeatureFlagsStore(isOpenCodeHarnessReleased);
  const accountProxyFlagEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopAccountProxy.key),
  );
  // Org gateways are delivered by the cloud account read, and the key blocks
  // sit with the providers: the policy arrives and the field to satisfy it is
  // right there.
  // One block per org, the selected context's org first.
  const orgGateways = useOrgModelGateways();
  const personalGateway = usePersonalModelGateway();
  const scopingContext = useSidebarScopingContext();
  const selectedOrganizationId =
    scopingContext?.kind === 'organization'
      ? scopingContext.organizationId
      : undefined;
  const orderedOrgGateways = useMemo(
    () => orderGatewaysForContext(orgGateways ?? [], selectedOrganizationId),
    [orgGateways, selectedOrganizationId],
  );

  return (
    <AccountSection label="LLM provider">
      <SettingsGroup>
        {/* Your own AI gateway leads: it is the gateway you set up. */}
        {personalGateway ? (
          <ModelGatewayCredentialSection
            key={personalGateway.organizationId}
            gateway={personalGateway}
          />
        ) : null}
        {/* Each org gateway is a provider row. Show the selected org first. */}
        {orderedOrgGateways.map((gateway) => (
          <ModelGatewayCredentialSection
            key={gateway.organizationId}
            gateway={gateway}
          />
        ))}
        <ProviderAuthPanel provider="claude" layout="row" />
        <ProviderAuthPanel provider="codex" layout="row" />
        {/* Released Copilot and OpenCode are provider rows too (and render
            nothing while unsupported on this computer). */}
        {copilotReleased && <CopilotConnection placement="row" />}
        {opencodeReleased && <OpenCodeConnection placement="row" />}
        {/* Cursor is a provider row beside Claude and Codex (and renders
            nothing while unsupported). */}
        {cursorReleased && <CursorConnection placement="row" />}
        {/* The account proxy (CAN-4019): nothing until opted in. */}
        {accountProxyFlagEnabled && <AccountProxyProviderRow />}
      </SettingsGroup>
    </AccountSection>
  );
}

/**
 * The Accounts tab. With hosted account settings available it is "Providers":
 * the LLM providers only. Signed-in accounts use the hosted Account, Billing
 * and Integrations pages.
 */
export function AccountTab(): JSX.Element {
  const cursorReleased = useFeatureFlagsStore(isCursorHarnessReleased);
  const hostedSettingsAvailable = useHostedSettingsAvailable();

  if (hostedSettingsAvailable) {
    return (
      <SettingsPage title="Providers" dataTestId="settings-tab-account">
        <LlmProviderSection cursorReleased={cursorReleased} />
        {cursorReleased && <CursorApprovalCheck collapsible />}
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="Accounts" dataTestId="settings-tab-account">
      <SettingsSection>
        <SettingsGroup>
          <CanopyCloudAccountSection />
        </SettingsGroup>
      </SettingsSection>

      <LlmProviderSection cursorReleased={cursorReleased} />

      {/* Its own page section (and nothing while unavailable), right after
          the providers. */}
      {cursorReleased && <CursorApprovalCheck collapsible />}

      <AccountSection label="Version control">
        <SettingsGroup>
          <ProviderAuthPanel provider="github" layout="row" />
        </SettingsGroup>
      </AccountSection>

      <AccountSection label="Project management">
        <SettingsGroup>
          <LinearKeyRow />
        </SettingsGroup>
      </AccountSection>
    </SettingsPage>
  );
}
