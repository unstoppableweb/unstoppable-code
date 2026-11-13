import { useState, type JSX } from 'react';
import { Network } from '@canopy/ui-shared/icons/AppIcons';
import { ProviderStatusDot } from '@canopy/ui-shared/components';
import type { OrgModelGateway } from '@/hooks/useOrgModelGateway';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { DesktopAiGatewayConnectionKey } from './hosted/DesktopAiGatewayConnectionKey';
import { SettingsRow } from './SettingsLayout';

/** A member's own connection key, using the same presentation as gateway settings. */
export function ModelGatewayCredentialSection({
  gateway,
}: {
  readonly gateway: OrgModelGateway;
}): JSX.Element {
  const [ready, setReady] = useState(false);
  const title = /\bgateway$/i.test(gateway.organizationName.trim())
    ? gateway.organizationName
    : `${gateway.organizationName} gateway`;
  return (
    <div
      data-testid="settings-model-gateway-credential"
      data-organization-id={gateway.organizationId}
    >
      <SettingsRow
        label={
          <span className="inline-flex items-center gap-2">
            <Network size="sm" aria-hidden className="shrink-0 fg-primary" />
            <span className={REPLAY_MASK_CLASS}>{title}</span>
            <ProviderStatusDot
              tone={ready ? 'connected' : 'pending'}
              label={ready ? 'Connected' : 'Add your API key'}
              data-testid="model-gateway-key-status"
            />
          </span>
        }
        description={`${gateway.modelIds.length} ${gateway.modelIds.length === 1 ? 'model' : 'models'}`}
        control={
          <DesktopAiGatewayConnectionKey
            organizationId={gateway.organizationId}
            baseUrl={gateway.baseUrl}
            revision={0}
            label="API key"
            onReadinessChange={setReady}
          />
        }
      />
    </div>
  );
}
