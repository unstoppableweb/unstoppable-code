'use client';

import { useEffect, useState, type JSX } from 'react';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_GROUP_CLASS,
  SETTINGS_CARD_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { ErrorBanner, ToggleSwitch } from '@canopy/ui-shared/components';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { canEditOrgEnforcedSettings } from '@canopy/protocol/settings/organization-permissions';
import { SettingsLink, useSettingsClient } from '../host';
import {
  useSettingsErrorCopy,
  useSettingsLoadFailure,
  type SettingsFailure,
} from '../errors';
import { organizationSettingsSubtabHref } from '../navigation/organization-nav-items';
import {
  getOrganizationConfig,
  updateAiGatewayConfig,
} from '../organization/team-api';
import {
  organizationGatewayEditorConfig,
  type AiGatewayEditorConfig,
} from './ai-gateway-adapter';
import {
  AI_GATEWAY_ERROR_SCOPE,
  AI_GATEWAY_KNOWN_ERRORS,
} from './ai-gateway-copy';

/**
 * Policies' one gateway row while AI gateway setup has its own page: whether
 * members may use only the organization's gateway. It can't be turned on
 * until the gateway is offered to members.
 */
export function TeamAiGatewayRequirementSection({
  detail,
}: {
  readonly detail: OrganizationDetail;
}): JSX.Element | null {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(AI_GATEWAY_ERROR_SCOPE);
  const loadFailure = useSettingsLoadFailure(AI_GATEWAY_ERROR_SCOPE);
  const [config, setConfig] = useState<AiGatewayEditorConfig | null>(null);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const canEdit = canEditOrgEnforcedSettings(detail.viewerRole);

  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
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
  }, [client, detail.id, canEdit, loadFailure, attempt]);

  if (!canEdit) return null;

  const save = async (next: boolean): Promise<void> => {
    if (saving || config === null) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateAiGatewayConfig(client, detail.id, {
        ...(config.revision
          ? { expectedModelGatewayRevision: config.revision }
          : {}),
        modelGatewayEnforced: next,
      });
      setConfig(organizationGatewayEditorConfig(saved));
    } catch (err) {
      setError(
        errorCopy.actionFailure(err, {
          action: 'update this policy',
          known: AI_GATEWAY_KNOWN_ERRORS,
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className={SETTINGS_CARD_CLASS}
      data-testid="team-ai-gateway-requirement"
    >
      <ErrorBanner
        errorSource="team-ai-gateway-requirement-section"
        error={error?.copy}
        details={error?.details}
        onRetry={
          config === null
            ? () => {
                setError(null);
                setAttempt((value) => value + 1);
              }
            : undefined
        }
      />
      <div className={SETTINGS_CARD_GROUP_CLASS}>
        <div className={SETTINGS_CARD_ROW_CLASS}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-s font-medium fg-primary">
              Require members to use only the AI gateway
            </span>
            <SettingsLink
              href={organizationSettingsSubtabHref(detail.id, 'ai-gateway')}
              className="w-fit text-xs fg-accent underline"
              data-testid="team-ai-gateway-manage-link"
            >
              Manage AI gateway
            </SettingsLink>
          </div>
          <ToggleSwitch
            label="Require members to use only the AI gateway"
            checked={config?.onlyThisGateway ?? false}
            busy={config === null && error === null}
            disabled={saving || config === null || !config.enabled}
            dataTestId="team-ai-gateway-required-toggle"
            onChange={(next) => void save(next)}
          />
        </div>
      </div>
    </section>
  );
}
