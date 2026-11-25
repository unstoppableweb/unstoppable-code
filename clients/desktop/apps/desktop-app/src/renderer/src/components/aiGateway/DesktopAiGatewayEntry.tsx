import { useEffect, useMemo, useState, type JSX } from 'react';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { AiGatewayEditorConfig } from '@canopy/ui-app/settings/ai-gateway/ai-gateway-adapter';
import {
  AiGatewaySetupDialog,
  ConfiguredAiGatewayRow as SharedConfiguredAiGatewayRow,
  type AiGatewayEntry,
  type AiGatewaySetupDialogProps,
  type AiGatewaySummary,
} from '@canopy/ui-app/settings/ai-gateway/AiGatewayEntry';
import { gatewayHostname } from '@canopy/protocol/model-gateway/discovery';
import { normalizeModelGatewayBaseUrl } from '@canopy/protocol/canopy-server';
import { useDesktopStandaloneSettingsHost } from '@/components/settings/hosted/DesktopSettingsHost';
import { useHostedSettingsClient } from '@/components/settings/hosted/hosted-settings-availability';
import { useCanopyCloudAccountState } from '@/hooks/useCanopyCloudAccountState';
import { usePersonalModelGateway } from '@/hooks/useOrgModelGateway';
import { useLocalModelGateway } from '@/hooks/useLocalModelGateway';
import { createDeviceAiGatewaySettingsClient } from '@/client/device-ai-gateway-settings-client';
import { isConnectedNonGuest } from '@/stores/cloudConnectGateStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

/**
 * The desktop's personal AI gateway entry and its adapters over the shared
 * row and setup dialog
 * (`@canopy/ui-app/settings/ai-gateway/AiGatewayEntry`).
 * First run and the provider-choice dialog both render it, so the two offer
 * the same setup.
 *
 * Signed in, the gateway is the account's Personal gateway; a signed-in
 * account that names no Personal organization yet gets nothing, so a key is
 * never saved under a guess. Signed out or a guest, it is this device's
 * gateway, kept only on this computer.
 */

export type DesktopAiGatewaySummary = AiGatewaySummary;
export type DesktopAiGatewayEntry = AiGatewayEntry;

/**
 * The gateway entry this account can use, or `null` while the account is
 * unread, without a scope, or with AI gateway settings turned off and no
 * gateway already configured.
 */
export function useDesktopAiGatewayEntry(): DesktopAiGatewayEntry | null {
  const hostedClient = useHostedSettingsClient();
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.key),
  );
  const { account } = useCanopyCloudAccountState();
  const accountId = account?.account?.id;
  const signedIn = isConnectedNonGuest(account);
  const device = useLocalModelGateway();
  const deviceClient = useMemo(createDeviceAiGatewaySettingsClient, []);
  const scope = signedIn
    ? hostedClient && account?.personalOrganizationId
      ? {
          client: hostedClient,
          organizationId: account.personalOrganizationId,
        }
      : null
    : device
      ? { client: deviceClient, organizationId: device.organizationId }
      : null;
  const organizationId = scope?.organizationId;
  const projected = usePersonalModelGateway();
  const [saved, setSaved] = useState<AiGatewayEditorConfig | null>(null);

  useEffect(() => {
    setSaved(null);
  }, [organizationId, accountId]);

  // The flag gates first setup; a gateway that is already routing (the
  // account's projected one, or this device's) stays reachable without it.
  const configured = signedIn
    ? projected !== null && projected.organizationId === scope?.organizationId
    : Boolean(device?.gateway?.baseUrl);
  if ((!enabled && !configured) || account === null || !scope) return null;

  const summary: DesktopAiGatewaySummary | null =
    saved?.baseUrl && saved.models.length > 0
      ? {
          organizationId: scope.organizationId,
          name: saved.displayName || gatewayHostname(saved.baseUrl),
          baseUrl: saved.baseUrl,
          modelCount: saved.models.length,
        }
      : projected && projected.organizationId === scope.organizationId
        ? {
            organizationId: scope.organizationId,
            name: projected.organizationName,
            baseUrl: projected.baseUrl,
            modelCount: projected.modelIds.length,
          }
        : null;
  return {
    client: scope.client,
    organizationId: scope.organizationId,
    dialogKey: `${accountId ?? 'device'}/${scope.organizationId}`,
    summary,
    onSaved: setSaved,
  };
}

/**
 * Whether this computer holds the key for the gateway's endpoint: `null`
 * while it is read, then `true` only for a stored, error-free key saved for
 * this base URL.
 */
export function useGatewayKeyReady(
  summary: DesktopAiGatewaySummary | null,
): boolean | null {
  const [keyReady, setKeyReady] = useState<boolean | null>(null);
  const organizationId = summary?.organizationId;
  const baseUrl = summary?.baseUrl;
  useEffect(() => {
    setKeyReady(null);
    if (organizationId === undefined || baseUrl === undefined) return;
    let cancelled = false;
    void window.api.loadModelGatewayCredential(organizationId, baseUrl).then(
      (state) => {
        if (cancelled) return;
        setKeyReady(
          state.storageAvailable &&
            !state.secureStorageFailure &&
            state.apiKey.length > 0 &&
            !state.lastError &&
            normalizeModelGatewayBaseUrl(state.baseUrlAtSave) ===
              normalizeModelGatewayBaseUrl(baseUrl),
        );
      },
      () => {
        if (!cancelled) setKeyReady(false);
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [organizationId, baseUrl]);
  return keyReady;
}

/** The shared configured-gateway row, with this computer's key check. */
export function ConfiguredAiGatewayRow({
  summary,
  onEdit,
  testIdPrefix,
}: {
  readonly summary: DesktopAiGatewaySummary;
  readonly onEdit: () => void;
  readonly testIdPrefix: string;
}): JSX.Element {
  const keyReady = useGatewayKeyReady(summary);
  return (
    <SharedConfiguredAiGatewayRow
      summary={summary}
      keyReady={keyReady}
      onEdit={onEdit}
      testIdPrefix={testIdPrefix}
    />
  );
}

export type DesktopAiGatewayDialogProps = Omit<
  AiGatewaySetupDialogProps,
  'host'
>;

/** The shared setup dialog under the desktop's standalone settings host. */
export function DesktopAiGatewayDialog(
  props: DesktopAiGatewayDialogProps,
): JSX.Element {
  const host = useDesktopStandaloneSettingsHost(props.client);
  return <AiGatewaySetupDialog {...props} host={host} />;
}
