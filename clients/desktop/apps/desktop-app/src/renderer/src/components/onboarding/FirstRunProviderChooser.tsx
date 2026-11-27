import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import {
  resolveProviderChoices,
  type AnyProviderSourceFacts,
} from '@canopy/app-state/provider-choice';
import {
  BillingSetupPanel,
  type ProviderChoicePresentation,
} from '@canopy/ui-app/providers';
import type { AiGatewayPresetId } from '@canopy/protocol/model-gateway/presets';
import { PROVIDER_ROW_DESCRIPTIONS } from '@canopy/ui-app/onboarding';
import { aiGatewayPresentation } from '@canopy/ui-app/settings/ai-gateway/AiGatewayEntry';
import { GatewayPresetMarks } from '@canopy/ui-app/settings/ai-gateway/GatewayPresetMarks';
import {
  Button,
  PROVIDER_CHOICE_ACTION_LABELS,
} from '@canopy/ui-shared/components';
import { ClaudeLogo, CodexLogo, OllamaLogo } from '@canopy/ui-shared/icons';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  trackBillingSetupGateClick,
  type BillingSetupGateSurface,
} from '@/lib/billingSetupGateTelemetry';
import {
  signedInProviderLine,
  useDesktopProviderSignIn,
  type DesktopProviderSignIn,
  type DesktopSignInProvider,
} from '@/components/auth/useDesktopProviderSignIn';
import { ProviderCarryoverNote } from '@/components/settings/ProviderCarryoverNote';
import { PROVIDER_CONNECTION_STATE_LABELS } from '@/lib/onboarding/provider-connection-status';
import { FirstRunAccountRowHost } from '@/components/onboarding/FirstRunAccountRowHost';
import {
  ConfiguredAiGatewayRow,
  DesktopAiGatewayDialog,
  useDesktopAiGatewayEntry,
} from '@/components/aiGateway/DesktopAiGatewayEntry';

const SIGN_IN_PROVIDER_NAMES: Readonly<Record<DesktopSignInProvider, string>> =
  {
    claude: 'Claude',
    codex: 'Codex',
  };

/**
 * A Claude or Codex row as first run reads it: not having the provider is a
 * normal choice, so a signed-out row is a grey line saying what connecting
 * gets, never an error.
 */
function signInPresentation(
  source: DesktopSignInProvider,
  signIn: DesktopProviderSignIn,
): ProviderChoicePresentation {
  const { status } = signIn;
  let description: ReactNode;
  if (status === null) {
    description = 'Checking sign-in…';
  } else if (status.authenticated) {
    description = signedInProviderLine(status, signIn.detail);
  } else {
    // Main reports a plain sign-out with a generic "is not authenticated"
    // error, so only a failed check shows the provider's own message. A
    // failed check never shows the description: it is not evidence that the
    // user has no subscription.
    description = (
      <span className="fg-secondary">
        {status.probeFailed === true
          ? status.error || PROVIDER_CONNECTION_STATE_LABELS['not-connected']
          : PROVIDER_ROW_DESCRIPTIONS[source]}
      </span>
    );
  }
  return {
    icon:
      source === 'claude' ? (
        <ClaudeLogo className="h-4 w-4 shrink-0 fg-primary" aria-hidden />
      ) : (
        <CodexLogo className="h-4 w-4 shrink-0 fg-primary" aria-hidden />
      ),
    name: SIGN_IN_PROVIDER_NAMES[source],
    description,
  };
}

const OLLAMA_PRESENTATION: ProviderChoicePresentation = {
  icon: <OllamaLogo className="h-4 w-4 shrink-0 fg-primary" aria-hidden />,
  name: 'Ollama',
  description: (
    <span className="fg-secondary">{PROVIDER_ROW_DESCRIPTIONS.ollama}</span>
  ),
};

export interface FirstRunProviderChooserProps {
  readonly title?: ReactNode;
  readonly intro?: ReactNode;
  /**
   * Offer a local Ollama row (Set up opens Settings › Ollama). `'ready'`
   * when Ollama already has a model this app can select.
   */
  readonly ollama?: 'ready' | 'not-connected';
  /** Sources set up in Settings, under the rows. */
  readonly moreProviders?: ReactNode;
  /** A quiet way elsewhere, under the rows. */
  readonly link?: ReactNode;
  /** Move focus to the list when it mounts (it replaced a focused composer). */
  readonly focusOnMount?: boolean;
  /** The billing setup gate surface this list stands in for, for analytics. */
  readonly gateSurface?: BillingSetupGateSurface;
  readonly dataTestId?: string;
}

/**
 * "Let's get started"'s provider rows on the shared billing setup panel:
 * Claude, Codex, the AI gateway, then the account row. The billing setup
 * gate renders the same rows, adding Ollama and the providers set up in
 * Settings. Claude and Codex sign in through their command-line tools
 * (`useDesktopProviderSignIn`). The gateway is a row whether or not it is set
 * up: before setup it offers Connect and the common gateways' marks, after it
 * shows its name, model count and Change. The configured gateway and the
 * account row (its sign-in and purchase hand-off) are still the desktop's own
 * through `renderRow`.
 */
export function FirstRunProviderChooser({
  title,
  intro,
  ollama,
  moreProviders,
  link,
  focusOnMount,
  gateSurface,
  dataTestId,
}: FirstRunProviderChooserProps = {}): JSX.Element {
  const openSettings = useNavigationStore((state) => state.openSettings);
  const claude = useDesktopProviderSignIn('claude');
  const codex = useDesktopProviderSignIn('codex');
  const signIns: Readonly<
    Record<DesktopSignInProvider, DesktopProviderSignIn>
  > = {
    claude,
    codex,
  };
  const gateway = useDesktopAiGatewayEntry();
  const [open, setOpen] = useState<{
    readonly presetId?: AiGatewayPresetId;
  } | null>(null);
  const dialogKey = gateway?.dialogKey;

  useEffect(() => {
    setOpen(null);
  }, [dialogKey]);

  const summary = gateway?.summary ?? null;
  const choices = useMemo(() => {
    const sources: AnyProviderSourceFacts[] = [
      {
        source: 'claude',
        connection: claude.connection,
        connectable: true,
        runsTargetModel: false,
      },
      {
        source: 'codex',
        connection: codex.connection,
        connectable: true,
        runsTargetModel: false,
      },
      ...(gateway !== null
        ? [
            {
              source: 'gateway' as const,
              connection:
                summary === null
                  ? { kind: 'not-connected' as const }
                  : { kind: 'ready' as const },
              connectable: true,
              runsTargetModel: false,
            },
          ]
        : []),
      // The billing setup gate's local Ollama row: Set up opens Settings ›
      // Ollama until a selectable model is installed.
      ...(ollama !== undefined
        ? [
            {
              source: 'ollama' as const,
              connection:
                ollama === 'ready'
                  ? { kind: 'ready' as const }
                  : { kind: 'not-connected' as const },
              connectable: true,
              runsTargetModel: false,
            },
          ]
        : []),
      {
        // The account row reads its own balance; the chooser only places it.
        source: 'credits',
        balance: 'unknown',
        runsTargetModel: false,
        billingEnabled: true,
        viewer: 'signed-in',
        owner: { kind: 'personal' },
        purchaseMode: 'handoff',
        pending: false,
      },
    ];
    return resolveProviderChoices({
      current: null,
      condition: 'no_billing_source',
      target: { kind: 'set-up' },
      sources,
    });
  }, [claude.connection, codex.connection, gateway, summary, ollama]);

  const trackClick = (
    action: 'connect' | 'buy' | 'set_up' | 'settings_open',
    source: 'claude' | 'codex' | 'gateway' | 'ollama' | 'credits',
  ): void => {
    if (gateSurface === undefined) return;
    trackBillingSetupGateClick({ surface: gateSurface, action, source });
  };

  return (
    <>
      <BillingSetupPanel
        choices={choices}
        {...(title !== undefined ? { title } : {})}
        {...(intro !== undefined ? { intro } : {})}
        {...(moreProviders !== undefined ? { moreProviders } : {})}
        {...(link !== undefined ? { link } : {})}
        {...(focusOnMount !== undefined ? { focusOnMount } : {})}
        {...(dataTestId !== undefined ? { dataTestId } : {})}
        presentation={{
          claude: signInPresentation('claude', claude),
          codex: signInPresentation('codex', codex),
          gateway: aiGatewayPresentation(null, false),
          ollama: OLLAMA_PRESENTATION,
        }}
        renderAction={(row) => {
          switch (row.source) {
            case 'claude':
            case 'codex': {
              const source = row.source;
              const { status, openSignIn } = signIns[source];
              return (
                <Button
                  onClick={() => {
                    trackClick('connect', source);
                    openSignIn();
                  }}
                  disabled={status === null}
                  data-testid={`auth-panel-${row.source}-connect`}
                  size="compact"
                >
                  {/* Connect while the read runs too, like the account row
                      beside it. */}
                  {status?.authenticated === true
                    ? 'Change account'
                    : 'Connect'}
                </Button>
              );
            }
            case 'gateway':
              return row.action === 'set-up' ? (
                <Button
                  size="compact"
                  data-testid="first-run-ai-gateway-connect"
                  onClick={() => {
                    trackClick('set_up', 'gateway');
                    setOpen({});
                  }}
                >
                  {PROVIDER_CHOICE_ACTION_LABELS['set-up']}
                </Button>
              ) : null;
            case 'ollama':
              return row.action === 'set-up' ? (
                <Button
                  size="compact"
                  data-testid="billing-setup-ollama-set-up"
                  onClick={() => {
                    trackClick('set_up', 'ollama');
                    openSettings('ollama');
                  }}
                >
                  {PROVIDER_CHOICE_ACTION_LABELS['set-up']}
                </Button>
              ) : null;
            default:
              return null;
          }
        }}
        rowChildren={(row) => {
          switch (row.source) {
            case 'claude':
            case 'codex': {
              const { status, refreshKey, signInModal } = signIns[row.source];
              // What carries over from the provider's own setup is detail
              // under the row, so the row keeps one subtitle line.
              return (
                <>
                  <ProviderCarryoverNote
                    provider={row.source}
                    enabled={status?.authenticated === true}
                    refreshKey={refreshKey}
                  />
                  {signInModal}
                </>
              );
            }
            case 'gateway':
              // Before setup the gateway row names the common gateways by
              // their marks; picking one opens setup at its key step.
              return summary === null ? (
                <GatewayPresetMarks
                  onPick={(presetId) => {
                    trackClick('set_up', 'gateway');
                    setOpen({ presetId });
                  }}
                  onMore={() => {
                    trackClick('set_up', 'gateway');
                    setOpen({});
                  }}
                />
              ) : null;
            default:
              return null;
          }
        }}
        // The configured gateway and the account row are the desktop's own;
        // see the PR's renderRow list.
        renderRow={(row) => {
          switch (row.source) {
            case 'gateway':
              return summary === null ? undefined : (
                <ConfiguredAiGatewayRow
                  summary={summary}
                  onEdit={() => setOpen({})}
                  testIdPrefix="first-run-ai-gateway"
                />
              );
            case 'credits':
              return (
                <FirstRunAccountRowHost
                  {...(gateSurface !== undefined
                    ? {
                        onAction: (action: 'connect' | 'buy'): void =>
                          trackClick(action, 'credits'),
                      }
                    : {})}
                />
              );
            default:
              return undefined;
          }
        }}
      />
      {gateway !== null && open !== null ? (
        <DesktopAiGatewayDialog
          key={gateway.dialogKey}
          client={gateway.client}
          organizationId={gateway.organizationId}
          {...(open.presetId ? { initialPresetId: open.presetId } : {})}
          onClose={() => setOpen(null)}
          onSaved={(config) => {
            gateway.onSaved(config);
            setOpen(null);
          }}
          testIdPrefix="first-run-ai-gateway"
        />
      ) : null}
    </>
  );
}
