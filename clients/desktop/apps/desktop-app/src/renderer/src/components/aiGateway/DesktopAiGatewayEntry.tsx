import { useEffect, useMemo, useState, type JSX } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  Button,
  CenteredLoadingSpinner,
  DialogModal,
  ErrorBanner,
  ModelProviderIcon,
  GATEWAY_ROW_DESCRIPTION,
  GATEWAY_ROW_NAME,
  ReadyStatusLine,
} from '@canopy/ui-shared/components';
import { Network } from '@canopy/ui-shared/icons/AppIcons';
import { SettingsHostProvider } from '@canopy/ui-app/settings/host';
import { AiGatewaySetup } from '@canopy/ui-app/settings/ai-gateway/AiGatewaySetup';
import {
  personalGatewayEditorConfig,
  usePersonalAiGatewayAdapter,
  type AiGatewayEditorConfig,
} from '@canopy/ui-app/settings/ai-gateway/ai-gateway-adapter';
import {
  ProviderSourceRow,
  type ProviderChoicePresentation,
} from '@canopy/ui-app/providers';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { gatewayHostname } from '@canopy/protocol/model-gateway/discovery';
import {
  matchAiGatewayPreset,
  type AiGatewayPresetId,
} from '@canopy/protocol/model-gateway/presets';
import { GatewayPresetMarks } from '@canopy/ui-app/settings/ai-gateway/GatewayPresetMarks';
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
 * The desktop's personal AI gateway entry: the "Use an AI gateway" link with
 * the preset marks, the row a configured gateway shows, and the setup dialog.
 * First run and the provider-choice dialog both render it, so the two offer
 * the same setup.
 *
 * Signed in, the gateway is the account's Personal gateway; a signed-in
 * account that names no Personal organization yet gets nothing, so a key is
 * never saved under a guess. Signed out or a guest, it is this device's
 * gateway, kept only on this computer.
 */

export interface DesktopAiGatewaySummary {
  readonly organizationId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly modelCount: number;
}

export interface DesktopAiGatewayEntry {
  readonly client: AccountOrganizationSettingsClient;
  readonly organizationId: string;
  /** Keys the setup dialog, so a new account or scope starts it fresh. */
  readonly dialogKey: string;
  /** The configured gateway, or `null` before one is set up. */
  readonly summary: DesktopAiGatewaySummary | null;
  /** Records a save from the setup dialog before the account read catches up. */
  readonly onSaved: (config: AiGatewayEditorConfig) => void;
}

/**
 * The gateway entry this account can use, or `null` while the account is
 * unread, without a scope, or with AI gateway settings turned off.
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

  if (!enabled || account === null || !scope) return null;

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

/** "Use an AI gateway" and the preset marks, before a gateway is set up. */
export function AiGatewaySetupLink({
  onOpen,
  testId,
}: {
  /** Opens setup, at a preset's key step when one is picked. */
  readonly onOpen: (presetId?: AiGatewayPresetId) => void;
  readonly testId: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost-accent"
        size="compact"
        data-testid={testId}
        onClick={() => onOpen()}
      >
        Use an AI gateway
      </Button>
      <GatewayPresetMarks
        onPick={(presetId) => onOpen(presetId)}
        onMore={() => onOpen()}
      />
    </div>
  );
}

/**
 * Whether this computer holds the key for the gateway's endpoint: `null`
 * while it is read, then `true` only for a stored, error-free key saved for
 * this base URL.
 */
function useGatewayKeyReady(
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

/** The gateway's mark: its preset's logo, or a network glyph. */
function gatewayIcon(baseUrl: string | undefined): JSX.Element {
  const preset = baseUrl === undefined ? null : matchAiGatewayPreset(baseUrl);
  return preset ? (
    <ModelProviderIcon
      provider={preset.id}
      size="sm"
      aria-hidden
      className="fg-primary"
    />
  ) : (
    <Network size="sm" aria-hidden className="fg-primary" />
  );
}

/**
 * How the provider-choice list names and marks the AI gateway row. Before
 * setup it is the option itself; then the configured gateway (its preset's
 * logo and name, masked for session replay) and whether this computer can
 * use it now. The row's status, model line and action come from the shared
 * resolver like every other row.
 */
export function desktopGatewayPresentation(
  summary: DesktopAiGatewaySummary | null,
  ready: boolean,
): ProviderChoicePresentation {
  if (summary === null) {
    return {
      icon: gatewayIcon(undefined),
      name: GATEWAY_ROW_NAME,
      description: GATEWAY_ROW_DESCRIPTION,
    };
  }
  return {
    icon: gatewayIcon(summary.baseUrl),
    name: <span className={REPLAY_MASK_CLASS}>{summary.name}</span>,
    description: ready
      ? 'Connected with an API key'
      : 'Add your API key to use this gateway.',
  };
}

export function ConfiguredAiGatewayRow({
  summary,
  onEdit,
  testIdPrefix,
}: {
  readonly summary: DesktopAiGatewaySummary;
  readonly onEdit: () => void;
  /** Test ids start with it, such as `first-run-ai-gateway`. */
  readonly testIdPrefix: string;
}): JSX.Element {
  const keyReady = useGatewayKeyReady(summary);

  const one = summary.modelCount === 1;
  const models = `${summary.modelCount} ${one ? 'model' : 'models'}`;
  // Laid out like the provider rows above: how it connects under the name,
  // then the ready check once this computer holds the key.
  return (
    <ProviderSourceRow
      dataTestId={testIdPrefix}
      icon={gatewayIcon(summary.baseUrl)}
      name={<span className={REPLAY_MASK_CLASS}>{summary.name}</span>}
      {...(keyReady === null
        ? {}
        : {
            status: keyReady ? 'connected' : 'pending',
            statusLabel: keyReady ? 'Ready' : 'Add your API key',
            statusTestId: `${testIdPrefix}-status`,
          })}
      description={
        keyReady === false
          ? 'Add your API key to use this gateway.'
          : 'Connected with an API key'
      }
      control={
        <Button
          size="compact"
          data-testid={`${testIdPrefix}-edit`}
          onClick={onEdit}
        >
          Edit
        </Button>
      }
    >
      <span
        className="block text-xs fg-secondary"
        data-testid={`${testIdPrefix}-models`}
      >
        {keyReady ? (
          <ReadyStatusLine>{`${models} ${one ? 'is' : 'are'} ready in your chats.`}</ReadyStatusLine>
        ) : (
          models
        )}
      </span>
    </ProviderSourceRow>
  );
}

export interface DesktopAiGatewayDialogProps {
  readonly client: AccountOrganizationSettingsClient;
  readonly organizationId: string;
  /** Opens at this preset's key step, from a preset mark. */
  readonly initialPresetId?: AiGatewayPresetId;
  readonly onClose: () => void;
  readonly onSaved: (config: AiGatewayEditorConfig) => void;
  /** Test ids start with it, such as `first-run-ai-gateway`. */
  readonly testIdPrefix: string;
}

/**
 * The shared Connect, models and Save flow in a dialog. Closing drops what
 * was typed and found. A key a successful Connect saved stays saved, but
 * closing never saves or turns on the gateway.
 */
export function DesktopAiGatewayDialog({
  client,
  organizationId,
  initialPresetId,
  onClose,
  onSaved,
  testIdPrefix,
}: DesktopAiGatewayDialogProps): JSX.Element {
  const host = useDesktopStandaloneSettingsHost(client);
  const adapter = usePersonalAiGatewayAdapter(client, organizationId);
  const [current, setCurrent] = useState<
    | { readonly status: 'loading' }
    | { readonly status: 'failed' }
    | {
        readonly status: 'ready';
        readonly config: AiGatewayEditorConfig | null;
      }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // The stored gateway, so a save carries its revision and keeps its models.
  useEffect(() => {
    let cancelled = false;
    setCurrent({ status: 'loading' });
    void client.read('account.settings.ai-gateway.read', {}).then(
      ({ gateway }) => {
        if (cancelled) return;
        // A promotion since the account read: reload rather than save here.
        if (gateway && gateway.organizationId !== organizationId) {
          setCurrent({ status: 'failed' });
          return;
        }
        setCurrent({
          status: 'ready',
          config: personalGatewayEditorConfig(gateway),
        });
      },
      () => {
        if (!cancelled) setCurrent({ status: 'failed' });
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [client, organizationId, attempt]);

  return (
    <DialogModal
      title="AI gateway"
      subtitle="Connect your own gateway to use its models in your chats, billed to your own account."
      maxWidth="md"
      dataTestId={`${testIdPrefix}-dialog`}
      onClose={onClose}
    >
      <SettingsHostProvider host={host}>
        {current.status === 'loading' ? (
          <CenteredLoadingSpinner />
        ) : current.status === 'failed' ? (
          <ErrorBanner
            errorSource={`${testIdPrefix}-dialog`}
            error="Couldn't load your AI gateway. Try again."
            onRetry={() => setAttempt((value) => value + 1)}
          />
        ) : (
          <AiGatewaySetup
            adapter={adapter}
            current={current.config}
            enableOnSave
            layout="dialog"
            {...(initialPresetId ? { initialPresetId } : {})}
            onSaved={onSaved}
          />
        )}
      </SettingsHostProvider>
    </DialogModal>
  );
}
