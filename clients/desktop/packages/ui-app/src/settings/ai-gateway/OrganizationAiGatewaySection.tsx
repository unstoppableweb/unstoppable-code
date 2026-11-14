'use client';

import { useEffect, useState, type JSX } from 'react';
import {
  DelayedLoadingPlaceholder,
  ErrorBanner,
  Skeleton,
} from '@canopy/ui-shared/components';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { useSettingsClient } from '../host';
import { useSettingsLoadFailure, type SettingsFailure } from '../errors';
import { getOrganizationConfig } from '../organization/team-api';
import { AiGatewayEditor } from './AiGatewayEditor';
import {
  organizationGatewayEditorConfig,
  useOrganizationAiGatewayAdapter,
  type AiGatewayEditorConfig,
} from './ai-gateway-adapter';
import { AI_GATEWAY_ERROR_SCOPE } from './ai-gateway-copy';

/**
 * Settings → AI gateway for an organization's owners and admins: the gateway
 * the organization offers its members. Whether members must use only it is
 * a member policy, so that switch stays in Policies.
 */
export function OrganizationAiGatewaySection({
  detail,
}: {
  readonly detail: OrganizationDetail;
}): JSX.Element {
  const client = useSettingsClient();
  const loadFailure = useSettingsLoadFailure(AI_GATEWAY_ERROR_SCOPE);
  const adapter = useOrganizationAiGatewayAdapter(
    client,
    detail.id,
    detail.name,
  );
  const [config, setConfig] = useState<AiGatewayEditorConfig | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    void getOrganizationConfig(client, detail.id).then(
      (loaded) => {
        if (!cancelled) setConfig(organizationGatewayEditorConfig(loaded));
      },
      (err: unknown) => {
        if (!cancelled) setError(loadFailure(err));
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [client, detail.id, loadFailure, attempt]);

  if (error)
    return (
      <ErrorBanner
        errorSource="organization-ai-gateway-section"
        error={error.copy}
        details={error.details}
        onRetry={() => {
          setError(null);
          setAttempt((value) => value + 1);
        }}
      />
    );
  if (config === null)
    return (
      <DelayedLoadingPlaceholder>
        <Skeleton
          loading
          label="Loading AI gateway"
          testId="settings-skeleton-form"
          className="w-full"
        >
          <div className="h-40" />
        </Skeleton>
      </DelayedLoadingPlaceholder>
    );
  return (
    <div data-testid="organization-ai-gateway-section">
      <AiGatewayEditor key={detail.id} adapter={adapter} initial={config} />
    </div>
  );
}
