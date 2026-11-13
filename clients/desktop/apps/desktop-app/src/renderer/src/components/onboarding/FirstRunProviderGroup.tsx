import { useEffect, useState, type JSX, type ReactNode } from 'react';
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
import { matchAiGatewayPreset } from '@canopy/protocol/model-gateway/presets';
import { normalizeModelGatewayBaseUrl } from '@canopy/protocol/canopy-server';
import { SettingsGroup } from '@/components/settings/SettingsLayout';
import { useDesktopStandaloneSettingsHost } from '@/components/settings/hosted/DesktopSettingsHost';
import { useHostedSettingsClient } from '@/components/settings/hosted/hosted-settings-availability';
import { useCanopyCloudAccountState } from '@/hooks/useCanopyCloudAccountState';
import { usePersonalModelGateway } from '@/hooks/useOrgModelGateway';
import { announceCanopyCloudAccountChanged } from '@/lib/canopyCloudAccountChange';
import {
  isConnectedNonGuest,
  useCloudConnectGateStore,
} from '@/stores/cloudConnectGateStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

interface GatewaySummary {
  readonly organizationId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly modelCount: number;
}

/**
 * First run's provider rows plus its quiet way to use your own AI gateway.
 * Nothing extra shows until the account is read. Guests and signed-out users
 * get a sign-in prompt below the box: it opens the shared cloud connect gate,
 * then opens the gateway dialog once the signed-in account names its Personal
 * organization. A signed-in account without one gets the plain rows, so a key
 * is never saved under a guess. Otherwise a link below the box before a
 * gateway is set up, then a row in the box with its name, model count, and
 * whether this computer has its key.
 *
 * The open-after-sign-in intent is used once. It lapses quietly when the
 * gateway flag is off for the signed-in account, and it waits through a failed
 * read after sign-in until the next successful one.
 */
export function FirstRunProviderGroup({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const client = useHostedSettingsClient();
  const enabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyAiGatewaySettingsEnabled.key),
  );
  const { account } = useCanopyCloudAccountState();
  const accountId = account?.account?.id;
  const organizationId = account?.personalOrganizationId;
  const signedIn = isConnectedNonGuest(account);
  const projected = usePersonalModelGateway();
  const [saved, setSaved] = useState<AiGatewayEditorConfig | null>(null);
  const [open, setOpen] = useState(false);
  // Open the dialog once sign-in from the prompt below lands. Not reset with
  // the account: it waits for exactly that change.
  const [pendingOpen, setPendingOpen] = useState(false);

  useEffect(() => {
    setSaved(null);
    setOpen(false);
  }, [organizationId, accountId]);

  // Runs in the same effect phase as the reset above, after it, so this
  // `setOpen(true)` wins over its `setOpen(false)`. Keep it below.
  useEffect(() => {
    if (!pendingOpen || !signedIn) return;
    if (organizationId && client && enabled) setOpen(true);
    setPendingOpen(false);
  }, [pendingOpen, signedIn, organizationId, client, enabled]);

  if (!client || !enabled || account === null) {
    return <SettingsGroup>{children}</SettingsGroup>;
  }

  if (!signedIn) {
    const signIn = (): void => {
      useCloudConnectGateStore.getState().requestConnect(
        {
          title: 'Sign in to use your own AI gateway',
          subtitle: null,
          description:
            'Your AI gateway is saved to your account. Its key stays on this computer.',
          toastMessage: "You're signed in. Finish setting up your AI gateway.",
        },
        () => {
          setPendingOpen(true);
          announceCanopyCloudAccountChanged('same-account-refresh');
        },
      );
    };
    return (
      <>
        <SettingsGroup>{children}</SettingsGroup>
        <div>
          <Button
            variant="ghost-accent"
            size="compact"
            data-testid="first-run-ai-gateway-sign-in"
            onClick={signIn}
          >
            Sign in to use your own AI gateway
          </Button>
        </div>
      </>
    );
  }

  if (!organizationId) {
    return <SettingsGroup>{children}</SettingsGroup>;
  }

  const summary: GatewaySummary | null =
    saved?.baseUrl && saved.models.length > 0
      ? {
          organizationId,
          name: saved.displayName || gatewayHostname(saved.baseUrl),
          baseUrl: saved.baseUrl,
          modelCount: saved.models.length,
        }
      : projected && projected.organizationId === organizationId
        ? {
            organizationId,
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
          <ConfiguredGatewayRow
            summary={summary}
            onEdit={() => setOpen(true)}
          />
        ) : null}
      </SettingsGroup>
      {summary ? null : (
        <div>
          <Button
            variant="ghost-accent"
            size="compact"
            data-testid="first-run-ai-gateway-link"
            onClick={() => setOpen(true)}
          >
            Use your own AI gateway
          </Button>
        </div>
      )}
      {open ? (
        <FirstRunAiGatewayDialog
          key={`${accountId}/${organizationId}`}
          client={client}
          organizationId={organizationId}
          onClose={() => setOpen(false)}
          onSaved={(config) => {
            setSaved(config);
            setOpen(false);
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
            onSaved={onSaved}
          />
        )}
      </SettingsHostProvider>
    </DialogModal>
  );
}
