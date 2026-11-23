'use client';

import { useEffect, useState, type JSX } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import {
  Button,
  CenteredLoadingSpinner,
  DialogModal,
  ErrorBanner,
  GATEWAY_ROW_DESCRIPTION,
  GATEWAY_ROW_NAME,
  ModelProviderIcon,
  ReadyStatusLine,
} from '@canopy/ui-shared/components';
import { Network } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  matchAiGatewayPreset,
  type AiGatewayPresetId,
} from '@canopy/protocol/model-gateway/presets';
import {
  ProviderSourceRow,
  type ProviderChoicePresentation,
} from '../../providers';
import { SettingsHostProvider, type SettingsUiHost } from '../host';
import { AiGatewaySetup } from './AiGatewaySetup';
import {
  personalGatewayEditorConfig,
  usePersonalAiGatewayAdapter,
  type AiGatewayEditorConfig,
} from './ai-gateway-adapter';

/**
 * A person's own AI gateway as a provider source: the row a configured
 * gateway shows, how a provider list names it, and the setup dialog. Desktop
 * first run, the provider-choice dialog and the web first-visit card render
 * the same pieces; each host supplies the entry and whether its key is ready.
 */

export interface AiGatewaySummary {
  readonly organizationId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly modelCount: number;
}

export interface AiGatewayEntry {
  readonly client: AccountOrganizationSettingsClient;
  readonly organizationId: string;
  /** Keys the setup dialog, so a new account or scope starts it fresh. */
  readonly dialogKey: string;
  /** The configured gateway, or `null` before one is set up. */
  readonly summary: AiGatewaySummary | null;
  /** Records a save from the setup dialog before the account read catches up. */
  readonly onSaved: (config: AiGatewayEditorConfig) => void;
}

/** The gateway's mark: its preset's logo, or a network glyph. */
export function gatewayIcon(baseUrl: string | undefined): JSX.Element {
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
 * logo and name, masked for session replay) and whether its key is ready.
 * The row's status, model line and action come from the shared resolver like
 * every other row.
 */
export function aiGatewayPresentation(
  summary: AiGatewaySummary | null,
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

export interface ConfiguredAiGatewayRowProps {
  readonly summary: AiGatewaySummary;
  /** The host holds a usable key for it; `null` while that is read. */
  readonly keyReady: boolean | null;
  readonly onEdit: () => void;
  /** Test ids start with it, such as `first-run-ai-gateway`. */
  readonly testIdPrefix: string;
}

export function ConfiguredAiGatewayRow({
  summary,
  keyReady,
  onEdit,
  testIdPrefix,
}: ConfiguredAiGatewayRowProps): JSX.Element {
  const one = summary.modelCount === 1;
  const models = `${summary.modelCount} ${one ? 'model' : 'models'}`;
  // Laid out like the provider rows above: how it connects under the name,
  // then the ready check once the host holds the key.
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
          Change
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

export interface AiGatewaySetupDialogProps {
  readonly client: AccountOrganizationSettingsClient;
  readonly organizationId: string;
  /** The settings host, when the dialog isn't already under one. */
  readonly host?: SettingsUiHost;
  /** Opens at this preset's key step, from a preset mark. */
  readonly initialPresetId?: AiGatewayPresetId;
  readonly onClose: () => void;
  readonly onSaved: (config: AiGatewayEditorConfig) => void;
  /** Test ids start with it, such as `first-run-ai-gateway`. */
  readonly testIdPrefix: string;
}

function AiGatewaySetupDialogBody({
  client,
  organizationId,
  initialPresetId,
  onSaved,
  testIdPrefix,
}: Pick<
  AiGatewaySetupDialogProps,
  'client' | 'organizationId' | 'initialPresetId' | 'onSaved'
> & { readonly testIdPrefix: string }): JSX.Element {
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

  return current.status === 'loading' ? (
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
  );
}

/**
 * The shared Connect, models and Save flow in a dialog. Closing drops what
 * was typed and found. A key a successful Connect saved stays saved, but
 * closing never saves or turns on the gateway.
 */
export function AiGatewaySetupDialog({
  host,
  onClose,
  testIdPrefix,
  ...body
}: AiGatewaySetupDialogProps): JSX.Element {
  const content = (
    <AiGatewaySetupDialogBody {...body} testIdPrefix={testIdPrefix} />
  );
  return (
    <DialogModal
      title="AI gateway"
      subtitle="Connect your own gateway to use its models in your chats, billed to your own account."
      maxWidth="md"
      dataTestId={`${testIdPrefix}-dialog`}
      onClose={onClose}
    >
      {host === undefined ? (
        content
      ) : (
        <SettingsHostProvider host={host}>{content}</SettingsHostProvider>
      )}
    </DialogModal>
  );
}
