import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  Button,
  CenteredLoadingSpinner,
  DialogModal,
  ErrorBanner,
  ModelProviderIcon,
  ProviderRowLabel,
  ProviderStatusDot,
  ReadyStatusLine,
  SettingsRowsRow,
} from '@canopy/ui-shared/components';
import { Network } from '@canopy/ui-shared/icons/AppIcons';
import { SettingsHostProvider } from '@canopy/ui-app/settings/host';
import { AiGatewaySetup } from '@canopy/ui-app/settings/ai-gateway/AiGatewaySetup';
import {
  personalGatewayEditorConfig,
  usePersonalAiGatewayAdapter,
  type AiGatewayEditorConfig,
} from '@canopy/ui-app/settings/ai-gateway/ai-gateway-adapter';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { gatewayHostname } from '@canopy/protocol/model-gateway/discovery';
import {
  matchAiGatewayPreset,
  type AiGatewayPresetId,
} from '@canopy/protocol/model-gateway/presets';
import { GatewayPresetMarks } from '@canopy/ui-app/settings/ai-gateway/GatewayPresetMarks';
import { normalizeModelGatewayBaseUrl } from '@canopy/protocol/canopy-server';
import { SettingsGroup } from '@/components/settings/SettingsLayout';
import { useDesktopStandaloneSettingsHost } from '@/components/settings/hosted/DesktopSettingsHost';
import { useHostedSettingsClient } from '@/components/settings/hosted/hosted-settings-availability';
import { useCanopyCloudAccountState } from '@/hooks/useCanopyCloudAccountState';
import { usePersonalModelGateway } from '@/hooks/useOrgModelGateway';
import { useLocalModelGateway } from '@/hooks/useLocalModelGateway';
import { createDeviceAiGatewaySettingsClient } from '@/client/device-ai-gateway-settings-client';
import { isConnectedNonGuest } from '@/stores/cloudConnectGateStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

interface GatewaySummary {
  readonly organizationId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly modelCount: number;
}

/**
 * First run's provider rows plus its quiet way to use an AI gateway. Nothing
 * extra shows until the account is read. Signed in, the gateway is the
 * account's Personal gateway; a signed-in account that names no Personal
 * organization yet gets the plain rows, so a key is never saved under a
 * guess. Signed out or a guest, it is this device's gateway, kept only on
 * this computer. Before a gateway is set up, a link and the preset marks sit
 * below the box; then a row in the box shows its name, model count, and
 * whether this computer has its key.
 */
export function FirstRunProviderGroup({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
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
  const [open, setOpen] = useState<{
    readonly presetId?: AiGatewayPresetId;
  } | null>(null);

  useEffect(() => {
    setSaved(null);
    setOpen(null);
  }, [organizationId, accountId]);

  if (!enabled || account === null || !scope) {
    return <SettingsGroup>{children}</SettingsGroup>;
  }

  const summary: GatewaySummary | null =
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

  return (
    <>
      <SettingsGroup>
        {children}
        {summary ? (
          <ConfiguredGatewayRow summary={summary} onEdit={() => setOpen({})} />
        ) : null}
      </SettingsGroup>
      {summary ? null : (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost-accent"
            size="compact"
            data-testid="first-run-ai-gateway-link"
            onClick={() => setOpen({})}
          >
            Use an AI gateway
          </Button>
          <GatewayPresetMarks
            onPick={(presetId) => setOpen({ presetId })}
            onMore={() => setOpen({})}
          />
        </div>
      )}
      {open ? (
        <FirstRunAiGatewayDialog
          key={`${accountId ?? 'device'}/${scope.organizationId}`}
          client={scope.client}
          organizationId={scope.organizationId}
          {...(open.presetId ? { initialPresetId: open.presetId } : {})}
          onClose={() => setOpen(null)}
          onSaved={(config) => {
            setSaved(config);
            setOpen(null);
          }}
        />
      ) : null}
    </>
  );
}

function ConfiguredGatewayRow({
  summary,
  onEdit,
}: {
  readonly summary: GatewaySummary;
  readonly onEdit: () => void;
}): JSX.Element {
  // Green only when this computer holds the key for this endpoint.
  const [keyReady, setKeyReady] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadModelGatewayCredential(summary.organizationId, summary.baseUrl)
      .then(
        (state) => {
          if (cancelled) return;
          setKeyReady(
            state.storageAvailable &&
              !state.secureStorageFailure &&
              state.apiKey.length > 0 &&
              !state.lastError &&
              normalizeModelGatewayBaseUrl(state.baseUrlAtSave) ===
                normalizeModelGatewayBaseUrl(summary.baseUrl),
          );
        },
        () => {
          if (!cancelled) setKeyReady(false);
        },
      );
    return (): void => {
      cancelled = true;
    };
  }, [summary.organizationId, summary.baseUrl]);

  const one = summary.modelCount === 1;
  const models = `${summary.modelCount} ${one ? 'model' : 'models'}`;
  const preset = matchAiGatewayPreset(summary.baseUrl);
  // Laid out like the provider rows above: how it connects under the name,
  // then the ready check once this computer holds the key.
  return (
    <SettingsRowsRow
      dataTestId="first-run-ai-gateway"
      label={
        <ProviderRowLabel
          icon={
            preset ? (
              <ModelProviderIcon
                provider={preset.id}
                size="sm"
                aria-hidden
                className="fg-primary"
              />
            ) : (
              <Network size="sm" aria-hidden className="fg-primary" />
            )
          }
          name={<span className={REPLAY_MASK_CLASS}>{summary.name}</span>}
          status={
            keyReady === null ? undefined : (
              <ProviderStatusDot
                tone={keyReady ? 'connected' : 'pending'}
                label={keyReady ? 'Ready' : 'Add your API key'}
                data-testid="first-run-ai-gateway-status"
              />
            )
          }
        />
      }
      description={
        keyReady === false
          ? 'Add your API key to use this gateway.'
          : 'Connected with an API key'
      }
      control={
        <Button
          size="compact"
          data-testid="first-run-ai-gateway-edit"
          onClick={onEdit}
        >
          Edit
        </Button>
      }
    >
      <span
        className="block text-xs fg-secondary"
        data-testid="first-run-ai-gateway-models"
      >
        {keyReady ? (
          <ReadyStatusLine>{`${models} ${one ? 'is' : 'are'} ready in your chats.`}</ReadyStatusLine>
        ) : (
          models
        )}
      </span>
    </SettingsRowsRow>
  );
}

interface FirstRunAiGatewayDialogProps {
  readonly client: AccountOrganizationSettingsClient;
  readonly organizationId: string;
  /** Opens at this preset's key step, from a preset mark. */
  readonly initialPresetId?: AiGatewayPresetId;
  readonly onClose: () => void;
  readonly onSaved: (config: AiGatewayEditorConfig) => void;
}

/**
 * The shared Connect, models and Save flow in a dialog. Closing drops what
 * was typed and found. A key a successful Connect saved stays saved, but
 * closing never saves or turns on the gateway.
 */
function FirstRunAiGatewayDialog({
  client,
  organizationId,
  initialPresetId,
  onClose,
  onSaved,
}: FirstRunAiGatewayDialogProps): JSX.Element {
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
      dataTestId="first-run-ai-gateway-dialog"
      onClose={onClose}
    >
      <SettingsHostProvider host={host}>
        {current.status === 'loading' ? (
          <CenteredLoadingSpinner />
        ) : current.status === 'failed' ? (
          <ErrorBanner
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
