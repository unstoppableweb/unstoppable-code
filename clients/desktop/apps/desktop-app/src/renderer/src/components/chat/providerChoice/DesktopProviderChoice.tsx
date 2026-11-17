import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  resolveProviderChoices,
  type CreditsBalanceState,
  type ProviderChoices,
  type ProviderSourceId,
} from '@canopy/app-state/provider-choice';
import type {
  CreditsCheckFeedbackKind,
  CreditsPromptCondition,
  CreditsPromptOwner,
  CreditsPromptViewer,
} from '@canopy/app-state/billing/credits';
import type { CreditsNoticeProviderChoice } from '@canopy/ui-app/credits';
import {
  ProviderChoiceActionButton,
  SwitchProviderDialog,
  type ProviderChoiceActionContext,
  type ProviderChoicePresentations,
  type ProviderChoiceRowError,
} from '@canopy/ui-app/providers';
import {
  CREDITS_ROW_DESCRIPTION,
  CREDITS_ROW_EMPTY_DESCRIPTION,
  ModelProviderIcon,
  PROVIDER_ROW_DESCRIPTIONS,
  providerSwitchFailedMessage,
} from '@canopy/ui-shared/components';
import { BrandLogo } from '@/components/BrandLogo';
import {
  desktopGatewayPresentation,
  DesktopAiGatewayDialog,
  useDesktopAiGatewayEntry,
} from '@/components/aiGateway/DesktopAiGatewayEntry';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import { brandText } from '@/lib/brand';
import {
  trackCreditsRecoveryClick,
  type CreditsRecoverySurface,
} from '@/lib/creditsRecoveryTelemetry';
import {
  isDesktopSubscriptionSource,
  type DesktopChoiceModel,
  type DesktopChoiceRow,
  type DesktopProviderChoiceContext,
  type DesktopSubscriptionSource,
} from './providerChoiceFacts';

/** The credits purchase facts a notice adds from its own coverage read. */
export interface DesktopCreditsChoiceFacts {
  readonly balance: CreditsBalanceState;
  readonly viewer: CreditsPromptViewer;
  readonly owner: CreditsPromptOwner;
  readonly pending: boolean;
  readonly pendingFeedback?: CreditsCheckFeedbackKind | null;
  readonly billingEnabled?: boolean;
}

const SOURCE_NAMES: Readonly<Record<ProviderSourceId, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  gateway: 'AI gateway',
  credits: brandText.appName,
};

/** A source's name in sentences: the configured gateway's own name. */
function sourceName(source: ProviderSourceId, gatewayName?: string): string {
  return source === 'gateway' && gatewayName
    ? gatewayName
    : SOURCE_NAMES[source];
}

function sourceIcon(source: ProviderSourceId): ReactNode {
  // Credits are the brand's own, so their row carries the brand mark, as the
  // first-run account row does.
  if (source === 'credits') return <BrandLogo size={16} aria-hidden />;
  if (source === 'gateway') return undefined;
  return <ModelProviderIcon provider={source} size={16} aria-hidden="true" />;
}

/** The desktop's names and marks for every source. */
export const DESKTOP_PROVIDER_PRESENTATION: ProviderChoicePresentations = {
  claude: {
    name: SOURCE_NAMES.claude,
    icon: sourceIcon('claude'),
    description: PROVIDER_ROW_DESCRIPTIONS.claude,
  },
  codex: {
    name: SOURCE_NAMES.codex,
    icon: sourceIcon('codex'),
    description: PROVIDER_ROW_DESCRIPTIONS.codex,
  },
  credits: {
    name: SOURCE_NAMES.credits,
    icon: sourceIcon('credits'),
    description: CREDITS_ROW_DESCRIPTION,
  },
};

export interface DesktopProviderChoice {
  readonly choices: ProviderChoices<DesktopChoiceModel>;
  readonly open: boolean;
  readonly openDialog: () => void;
  readonly closeDialog: () => void;
  /**
   * The credits row is starting a purchase: the list closes once its
   * hand-off is pending.
   */
  readonly notePurchaseStart: () => void;
  readonly choose: (row: DesktopChoiceRow) => void;
  readonly busy: boolean;
  /**
   * Why the last choice didn't move the chat, shown on that row. Cleared
   * when the dialog closes, a new attempt starts or the condition changes.
   */
  readonly rowError: ProviderChoiceRowError | null;
  /** Why the notice is open, for the dialog's title and subtitle. */
  readonly condition: CreditsPromptCondition;
  /** The credits balance, for the credits row's description. */
  readonly creditsBalance: CreditsBalanceState;
  /** The notice's button, for `CreditsNotice`'s `providerChoice`. */
  readonly notice: (testId: string) => CreditsNoticeProviderChoice;
  readonly restoreFocusRef: RefObject<HTMLElement | null>;
  readonly surface: CreditsRecoverySurface;
  readonly context: DesktopProviderChoiceContext;
}

/**
 * One notice's provider choice: the resolved rows, the dialog's open state
 * and the single handler both the dialog's `use` rows and the notice's
 * "Continue with X" run. Returns `null` without a context, so a notice
 * outside the composer keeps its earlier behavior.
 */
export function useDesktopProviderChoice({
  context,
  condition,
  credits,
  surface = 'chat_banner',
}: {
  readonly context: DesktopProviderChoiceContext | undefined;
  readonly condition: CreditsPromptCondition;
  readonly credits: DesktopCreditsChoiceFacts;
  readonly surface?: CreditsRecoverySurface;
}): DesktopProviderChoice | null {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<ProviderChoiceRowError | null>(null);
  // A failure belongs to the condition it happened under; it never carries
  // into another.
  const [errorCondition, setErrorCondition] = useState(condition);
  if (errorCondition !== condition) {
    setErrorCondition(condition);
    setRowError(null);
  }
  const busyRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // A purchase started from this list's credits row closes it once its
  // hand-off is pending; the notice's Check again then takes over. Nothing
  // else closes it: not a list reopened mid-purchase, and not a hand-off
  // started elsewhere on the same wallet.
  const purchaseStartedRef = useRef(false);
  useEffect(() => {
    if (credits.pending && purchaseStartedRef.current) {
      purchaseStartedRef.current = false;
      setOpen(false);
    }
  }, [credits.pending]);
  const choices = useMemo(
    () =>
      context === undefined
        ? null
        : resolveProviderChoices<DesktopChoiceModel>({
            current: context.current,
            condition,
            target: {
              kind: 'continue-chat',
              ...(context.currentModel !== undefined
                ? { model: context.currentModel }
                : {}),
            },
            sources: [
              ...context.accountSources,
              {
                source: 'credits',
                balance: credits.balance,
                runsTargetModel: context.credits.runsTargetModel,
                ...(context.credits.defaultModel !== undefined
                  ? { defaultModel: context.credits.defaultModel }
                  : {}),
                // A blocked move never hides a purchase.
                ...(credits.balance === 'spendable' &&
                context.credits.useBlockedReason !== undefined
                  ? { blockedReason: context.credits.useBlockedReason }
                  : {}),
                billingEnabled: credits.billingEnabled ?? true,
                viewer: credits.viewer,
                owner: credits.owner,
                purchaseMode: 'handoff',
                pending: credits.pending,
                pendingFeedback: credits.pendingFeedback ?? null,
              },
            ],
          }),
    [
      condition,
      context,
      credits.balance,
      credits.billingEnabled,
      credits.owner,
      credits.pending,
      credits.pendingFeedback,
      credits.viewer,
    ],
  );
  const latest = useRef(choices);
  latest.current = choices;

  const choose = useCallback(
    (row: DesktopChoiceRow): void => {
      if (context === undefined || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      // A choice from the notice's Continue never opened the list, so keep
      // where focus is now for the list a failure reopens.
      if (!open) {
        const active = document.activeElement;
        restoreFocusRef.current = active instanceof HTMLElement ? active : null;
      }
      // Close first: the switch dialog may open next, and two modals never
      // stack.
      setOpen(false);
      setRowError(null);
      trackCreditsRecoveryClick({
        surface,
        action: 'provider_use',
        provider: row.source,
      });
      // A choice that didn't move the chat reopens the list and says so.
      const failed = (): void => {
        setRowError({
          source: row.source,
          message: providerSwitchFailedMessage(
            row.source,
            sourceName(row.source, context.gatewayName),
          ),
        });
        setOpen(true);
      };
      // Started inside the chain, so even a synchronous throw ends `busy`.
      void Promise.resolve()
        .then(() => context.onUse(row))
        .then((moved) => {
          if (!moved) failed();
        }, failed)
        .finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
    },
    [context, open, surface],
  );
  const openDialog = useCallback((): void => {
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
    trackCreditsRecoveryClick({ surface, action: 'provider_switch_open' });
    setRowError(null);
    // A purchase that never started (a cancelled gate, a failed open) must
    // not let a later hand-off close this new list.
    purchaseStartedRef.current = false;
    setOpen(true);
  }, [surface]);
  const closeDialog = useCallback((): void => {
    setOpen(false);
    setRowError(null);
  }, []);
  const notePurchaseStart = useCallback((): void => {
    purchaseStartedRef.current = true;
  }, []);

  if (context === undefined || choices === null) return null;
  return {
    choices,
    open,
    openDialog,
    closeDialog,
    notePurchaseStart,
    choose,
    busy,
    rowError,
    condition,
    creditsBalance: credits.balance,
    restoreFocusRef,
    surface,
    context,
    notice: (testId: string): CreditsNoticeProviderChoice => ({
      primary: choices.primary,
      providerName:
        choices.primary.kind === 'continue-with'
          ? sourceName(choices.primary.source, context.gatewayName)
          : '',
      onContinue: (): void => {
        // Re-resolve at click time: a turn or a sign-in can change the
        // facts after render. Anything but a usable row opens the list.
        const now = latest.current;
        const source =
          now?.primary.kind === 'continue-with' ? now.primary.source : null;
        const row = now?.rows.find((r) => r.source === source);
        if (row !== undefined && row.action === 'use') choose(row);
        else openDialog();
      },
      onSwitchProvider: openDialog,
      busy,
      testId,
    }),
  };
}

/**
 * The desktop's Switch provider dialog. Subscription rows connect through the
 * same sign-in modal as first run, and the AI gateway row's Set up opens the
 * same gateway setup as first run (`useDesktopAiGatewayEntry`); credits rows render the notice's own
 * purchase control (`renderCreditsAction`), so a purchase started here is
 * the notice's hand-off and its Check again takes over once the dialog
 * closes.
 */
export function DesktopProviderChoiceDialog({
  choice,
  renderCreditsAction,
}: {
  readonly choice: DesktopProviderChoice | null;
  /** The credits row's buy, sign-in or Check again control. */
  readonly renderCreditsAction: (row: DesktopChoiceRow) => ReactNode;
}): JSX.Element | null {
  const [loginProvider, setLoginProvider] =
    useState<DesktopSubscriptionSource | null>(null);
  // AI gateway setup, as first run offers it. The list closes before the
  // setup dialog opens, so two modals never stack, and reopens after a save
  // so the configured gateway shows.
  const gateway = useDesktopAiGatewayEntry();
  const [gatewaySetupOpen, setGatewaySetupOpen] = useState(false);
  if (choice === null) {
    // The notice went away: setup it opened must not reappear on its own
    // when a notice shows again.
    if (gatewaySetupOpen) setGatewaySetupOpen(false);
    return null;
  }
  const openGatewaySetup = (): void => {
    trackCreditsRecoveryClick({
      surface: choice.surface,
      action: 'provider_sign_in',
      provider: 'gateway',
    });
    choice.closeDialog();
    setGatewaySetupOpen(true);
  };
  // The gateway row's name, mark and description follow its setup: the
  // option before setup, then the configured gateway and whether this
  // computer can use it. The current gateway may be unlisted (the header
  // explains it), so `current` counts too.
  const gatewayRowReady = [
    ...choice.choices.rows,
    ...(choice.choices.current !== null ? [choice.choices.current] : []),
  ].some((row) => row.source === 'gateway' && row.connection.kind === 'ready');
  const presentation: ProviderChoicePresentations = {
    ...DESKTOP_PROVIDER_PRESENTATION,
    credits: {
      ...DESKTOP_PROVIDER_PRESENTATION.credits,
      name: SOURCE_NAMES.credits,
      // A known empty balance replaces the description; an unknown one
      // keeps it.
      description:
        choice.creditsBalance === 'empty'
          ? CREDITS_ROW_EMPTY_DESCRIPTION
          : CREDITS_ROW_DESCRIPTION,
    },
    gateway: desktopGatewayPresentation(
      gateway?.summary ?? null,
      gatewayRowReady,
    ),
  };
  const renderAction = (
    row: DesktopChoiceRow,
    { recommended }: ProviderChoiceActionContext,
  ): ReactNode => {
    switch (row.action) {
      case 'use':
        return (
          <ProviderChoiceActionButton
            source={row.source}
            action="use"
            recommended={recommended}
            busy={choice.busy}
            onClick={(): void => choice.choose(row)}
          />
        );
      case 'connect':
        return isDesktopSubscriptionSource(row.source) ? (
          <ProviderChoiceActionButton
            source={row.source}
            action="connect"
            isCurrent={row.isCurrent}
            onClick={(): void => {
              if (!isDesktopSubscriptionSource(row.source)) return;
              trackCreditsRecoveryClick({
                surface: choice.surface,
                action: 'provider_sign_in',
                provider: row.source,
              });
              choice.closeDialog();
              setLoginProvider(row.source);
            }}
          />
        ) : null;
      case 'buy':
      case 'sign-in-to-buy':
      case 'check-again':
        return renderCreditsAction(row);
      case 'set-up':
        return row.source === 'gateway' && gateway !== null ? (
          <ProviderChoiceActionButton
            source="gateway"
            action="set-up"
            isCurrent={row.isCurrent}
            onClick={openGatewaySetup}
          />
        ) : null;
      case 'ask-admin':
      case 'none':
        return null;
    }
  };
  return (
    <>
      <SwitchProviderDialog
        open={choice.open}
        onClose={choice.closeDialog}
        choices={choice.choices}
        target={{
          kind: 'continue-chat',
          ...(choice.context.currentModel !== undefined
            ? { model: choice.context.currentModel }
            : {}),
        }}
        condition={choice.condition}
        presentation={presentation}
        renderAction={renderAction}
        formatResetsAt={choice.context.formatResetsAt}
        restoreFocusRef={choice.restoreFocusRef}
        rowError={choice.rowError}
      />
      {gateway !== null && gatewaySetupOpen && (
        <DesktopAiGatewayDialog
          key={gateway.dialogKey}
          client={gateway.client}
          organizationId={gateway.organizationId}
          // Cancel returns to the list setup was opened from.
          onClose={() => {
            setGatewaySetupOpen(false);
            choice.openDialog();
          }}
          onSaved={(config) => {
            gateway.onSaved(config);
            setGatewaySetupOpen(false);
            choice.openDialog();
          }}
          testIdPrefix="provider-choice-gateway"
        />
      )}
      {/* After a successful sign-in the row becomes `use`; it does not act
          on its own. */}
      {loginProvider !== null && (
        <AuthLoginModal
          provider={loginProvider}
          onClose={(): void => setLoginProvider(null)}
        />
      )}
    </>
  );
}
