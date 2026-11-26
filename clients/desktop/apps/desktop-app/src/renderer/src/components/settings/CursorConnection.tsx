import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { registerCursorSettingsAction } from '@/lib/cursor-settings-actions';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useEffect, useRef, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import type { HarnessSetupClient } from '@canopy/app-core';
import { useOptionalCanopyClient } from '@canopy/app-state/CanopyClientProvider';
import {
  CursorConnectionRow,
  useCursorConnection,
} from '@canopy/ui-app/harness-setup';
import type { HarnessCursorAccountIntent } from '@canopy/protocol/remote-control/harness-setup';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { DesktopHarnessSetupHost } from './DesktopHarnessSetupHost';
import { GrokUnifyHint } from './GrokUnifyHint';
import { ProviderCarryoverNote } from './ProviderCarryoverNote';
import { SettingsGroup, SettingsSection } from './SettingsLayout';

interface CursorConnectionProps {
  /**
   * `row`: one provider row inside the caller's group, as on Accounts beside
   * Claude and Codex. `section` (default): its own untitled section and box,
   * as on Experiments.
   */
  readonly placement?: 'row' | 'section';
}

/**
 * The shared Cursor row (`@canopy/ui-app/harness-setup`) with the desktop's
 * own additions: the plan from the account-usage read, App Advisor's
 * `cursor.connection` action, the UI state report, what carries over and the
 * Grok hint.
 */
export function CursorConnection({
  placement = 'section',
}: CursorConnectionProps = {}): JSX.Element | null {
  const client = useOptionalCanopyClient()?.harnessSetup?.cursor;
  if (!client) return null;
  return (
    <DesktopHarnessSetupHost>
      <DesktopCursorConnection client={client} placement={placement} />
    </DesktopHarnessSetupHost>
  );
}

function DesktopCursorConnection({
  client,
  placement,
}: {
  readonly client: HarnessSetupClient['cursor'];
  readonly placement: 'row' | 'section';
}): JSX.Element | null {
  // The subscription comes from the account-usage read the Usage page shares;
  // it is the same source the peer tiles' plan line draws on.
  const usageSummary = useObservabilityStore(
    useShallow((state) =>
      state.usage.providers.find((entry) => entry.provider === 'cursor'),
    ),
  );
  const initializeUsage = useObservabilityStore((state) => state.initialize);
  const refreshUsage = useObservabilityStore(
    (state) => state.refreshProviderUsageDetails,
  );
  const refreshingPlan = useObservabilityStore((state) =>
    state.refreshingProviders.has('cursor'),
  );
  // A new sign-in changes the account and its plan; the usage read is the
  // only thing that knows the plan, and nothing else re-runs it.
  const state = useCursorConnection(client, {
    onAccountChanged: (): void => {
      void refreshUsage('cursor').catch((cause: unknown) => {
        reportClientAppError(cause);
      });
    },
  });
  const { status, account, accountUnavailable, busy, connected, inProgress } =
    state;
  const supported = status?.supported ?? false;
  useEffect(() => {
    if (supported)
      void initializeUsage().catch((cause: unknown) => {
        reportClientAppError(cause);
      });
  }, [supported, initializeUsage]);
  // Only a plan read for the signed-in account is shown: the read must name
  // the same address the CLI reports (when both are known), and a refresh in
  // flight hides the line so a previous account's tier is never attributed to
  // a new sign-in, even briefly or after a failed refresh. An `unsupported`
  // read still describes this account (Cursor provided no usage details, not
  // no plan), so it keeps the tier.
  const plan =
    connected &&
    !inProgress &&
    !refreshingPlan &&
    account &&
    usageSummary?.authState === 'authenticated' &&
    (!usageSummary.errorInfo ||
      usageSummary.errorInfo.kind === 'unsupported') &&
    (!usageSummary.accountEmail ||
      !account.email ||
      usageSummary.accountEmail === account.email)
      ? usageSummary.subscriptionLabel
      : undefined;
  useCurrentUiStateReporter('settings.cursor', {
    loaded: status !== null,
    supported: status?.supported ?? false,
    enabled: status?.enabled ?? false,
    installed: status?.installed ?? false,
    busy,
    phase: status?.phase ?? 'idle',
    // Only the account identity, never credentials; absent until probed.
    ...(connected && account !== undefined
      ? { signedIn: account !== null, account: account?.email ?? '' }
      : {}),
    errorVisible: state.failure !== null,
  });
  const actionHandler = useRef<(operation: string) => boolean>(() => false);
  actionHandler.current = (operation): boolean => {
    if (!status?.supported) return false;
    if (operation === 'cancel') {
      if (!inProgress) return false;
      state.cancel();
      return true;
    }
    if (state.isActive()) return false;
    if (operation === 'connect') {
      if (!connected) void state.connect();
      return true;
    }
    if (operation === 'disconnect') {
      if (status.enabled) void state.disconnect();
      return true;
    }
    if (operation === 'change-account' || operation === 'sign-in') {
      // Refuse rather than guess: the row has not established whether there
      // is a session to sign out.
      if (!connected || accountUnavailable || account === undefined)
        return false;
      // The caller names which one it wants, and a mismatch is refused — a
      // dispatched `sign-in` must never sign the shared credential store out.
      const intent: HarnessCursorAccountIntent =
        operation === 'sign-in' ? 'sign-in' : 'change';
      if ((intent === 'sign-in') !== (account === null)) return false;
      void state.changeAccount(intent);
      return true;
    }
    return false;
  };
  // Register once the first status has loaded; progress ticks must not churn
  // the App Advisor registration.
  const loaded = status !== null;
  useEffect(() => {
    if (!loaded) return;
    return registerCursorSettingsAction('cursor.connection', (operation) =>
      actionHandler.current(operation),
    );
  }, [loaded]);
  const row = (
    <CursorConnectionRow
      state={state}
      {...(plan ? { plan } : {})}
      // Detail under the row, so the row keeps its subtitle short.
      signedInDetail={<ProviderCarryoverNote provider="cursor" enabled />}
      // Grok's plans reach this app through a Cursor sign-in, so its hint
      // shows wherever, and only where, Cursor can be connected.
      footer={<GrokUnifyHint />}
    />
  );
  if (!status?.supported) return null;
  if (placement === 'row') return row;
  return (
    // Untitled: the row itself names Cursor, so a heading would repeat it.
    <SettingsSection>
      <SettingsGroup>{row}</SettingsGroup>
    </SettingsSection>
  );
}
