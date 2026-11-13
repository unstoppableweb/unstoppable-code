import { Dot } from '@canopy/ui-shared/components/Badge';
import { SidebarTrialBadge } from '@canopy/ui-shared/components/SidebarTrialBadge';
import {
  AccountMenuComputersItem,
  SidebarMachinePicker,
} from '@/components/remote-access/SidebarMachinePicker';
import { useAiCreditsUsage } from '@/hooks/useAiCreditsUsage';
import { usePersonalModelLibraryAccess } from '@/hooks/useModelLibraryAccess';
import { useCanopyCloudAccountState } from '@/hooks/useCanopyCloudAccountState';
import { isGuestAccount } from '@/hooks/useIsGuestCredential';
import { useSubscriptionStatus } from '@/hooks/useSubscriptionStatus';
import { useTelemetrySyncPausedReason } from '@/hooks/useTelemetrySyncPausedReason';
import { brandText } from '@/lib/brand';
import { GUEST_SIGN_IN_CTA_LABEL } from '@/lib/guest-cta-copy';
import { openAuthenticatedCloudPageReported } from '@/lib/openAuthenticatedCloudPage';
import { useAccountProxyStatus } from '@/stores/accountProxyStore';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useGitHubStore } from '@/stores/githubStore';
import type { NavigationPage } from '@/stores/navigationStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  computeAiCreditsAlertLevel,
  computeUsageAlertLevel,
  maxUsageAlertLevel,
} from '@canopy/desktop-shared/lib/usage-alert';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { accountBillingPath } from '@canopy/protocol/billing';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  SidebarAccountFooter,
  SidebarAccountMenuHeader,
  SidebarRemoteControlSubtitle,
  sidebarRemoteControlSubtitleLabel,
  type SidebarAccountAttention,
  type SidebarAccountIdentityTone,
} from '@canopy/ui-app';
import { AccountMenuExternalAgentsItem } from '@canopy/ui-app/external-agents/AccountMenuExternalAgentsItem';
import {
  ActionMenuRowStyle,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
  DropdownMenuStatusRow,
  RailIconButton,
  RichHoverTooltip,
  SidebarAiCreditsMenuItem,
} from '@canopy/ui-shared';
import {
  ArrowUp,
  DataUsageIcon,
  LoginIcon,
  LogoutIcon,
  PortalIcon,
  RaisedHandIcon,
  SettingsIcon,
  SyncIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { FeedbackModal } from '../feedback/FeedbackModal';
import { DeleteConfirmModal } from '../shared/DeleteConfirmModal';
import { resolveCanopyPortalAccountStatus } from './canopy-portal-account-status';
import { CloneProgressPrompt } from './CloneProgressPrompt';
import { CloudAccountRecoveryPrompt } from './CloudAccountRecoveryPrompt';
import { ResumeQueuePrompt } from './ResumeQueuePrompt';
import { UpdatePrompt } from './UpdatePrompt';

/**
 * The `Sync paused` row's explanation (CAN-3512). Activity
 * sharing has queued items whose oldest is past the pause monitor's six-hour
 * stall threshold (`TELEMETRY_SYNC_STALL_THRESHOLD_MS` in
 * `main/services/telemetry-sync-pause.ts`) with no upload in that window. The
 * queue stays on disk and the next successful upload clears the pause.
 */
function syncPausedExplanation(): string {
  return `Activity you share hasn't reached ${brandText.appName} in over 6 hours. It's saved on this device and will upload automatically. If this continues, check your internet connection or open Settings → Privacy.`;
}

export interface SidebarAccountMenuProps {
  activePage: NavigationPage;
  onNavigate: (page: NavigationPage) => void;
  onSettingsClick: () => void;
  settingsOpen: boolean;
  /**
   * The `canopy-portal-enabled` flag. Gates the row's Portal status line; the
   * Remote Control menu item follows device Remote Control instead.
   */
  canopyPortalEnabled: boolean;
  /** Opens the Remote Control dialog (the host's `canopy_portal.open` dispatch). */
  onCanopyPortalClick: () => void;
  /**
   * Lowest-priority footer banner slot (the DEV banner), rendered after the
   * account recovery, onboarding, and update banners and immediately above the
   * account divider. Rendered here rather than in AppSidebar so banner priority
   * (account recovery > onboarding > update > slot) remains explicit.
   */
  footerBanner?: ReactNode;
}

/**
 * The personal account menu at the bottom of the sidebar (CAN-4055/4056): the
 * signed-in person whatever context is selected, with their plan or AI Credits
 * wallet, Usage, Remote Control, the Computers row, and Sign out.
 * Organization actions live on the top context switcher
 * (`DesktopSidebarContextSwitcher`). The row's second line is the Remote
 * Control status while it is on (CAN-3659); otherwise the row shows only the
 * name, and the email is in the menu header.
 */
export function SidebarAccountMenu({
  activePage,
  onNavigate,
  onSettingsClick,
  settingsOpen,
  canopyPortalEnabled,
  onCanopyPortalClick,
  footerBanner,
}: SidebarAccountMenuProps): JSX.Element {
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  // Synchronous re-entrancy guard for sign-in. A `useState` flag is not enough:
  // two rapid clicks in the same render frame share the same closure (the state
  // update hasn't re-rendered yet), so both would fire OAuth. A ref updates
  // synchronously and blocks the second click.
  const signingInRef = useRef(false);
  // Anchor the account menu to the complete row so its placement includes the
  // adjacent Settings action instead of only the account toggle.
  // The shared row owns the menu's open state; it hands back a closer that
  // desktop's own flows (sign-in completion, feedback, sign-out) call.
  const closeMenuRef = useRef<() => void>(() => {});
  const closeMenu = (): void => closeMenuRef.current();
  const subscription = useSubscriptionStatus();
  const syncPausedReason = useTelemetrySyncPausedReason();
  const addToast = useGitHubStore((state) => state.addToast);
  // Early or free access only changes ink: the name and the Usage row keep
  // their own color and the dots carry the usage status.

  const syncPausedDescriptionId = useId();
  const usage = useObservabilityStore((state) => state.usage);
  const cursorEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  );
  const externalAgentsMenuEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopExternalAgentsMenu.key),
  );
  const accountProxy = useAccountProxyStatus();
  const { state: aiCreditsState, routingMode: aiCreditsRoutingMode } =
    useAiCreditsUsage();
  const providerUsageAlertLevel = useMemo(
    () =>
      computeUsageAlertLevel(
        cursorEnabled
          ? usage
          : {
              ...usage,
              providers: usage.providers.filter(
                (provider) => provider.provider !== 'cursor',
              ),
            },
        { status: accountProxy, aiCreditsRoutingMode },
      ),
    [usage, cursorEnabled, accountProxy, aiCreditsRoutingMode],
  );
  const aiCreditsAlertLevel = useMemo(
    () =>
      computeAiCreditsAlertLevel(
        aiCreditsState,
        aiCreditsRoutingMode,
        usage,
        accountProxy,
      ),
    [aiCreditsState, aiCreditsRoutingMode, usage, accountProxy],
  );
  const usageAlertLevel = useMemo(
    () => maxUsageAlertLevel(providerUsageAlertLevel, aiCreditsAlertLevel),
    [providerUsageAlertLevel, aiCreditsAlertLevel],
  );

  useEffect(() => {
    if (settingsOpen) {
      closeMenu();
    }
  }, [settingsOpen]);

  // Read after the subscription and usage hooks, where the account effect
  // always ran, so each account-changed event keeps its read order.
  const { account, readError: accountReadError } = useCanopyCloudAccountState();
  const accountInfo = account?.account;
  // The signed-out row names the action, not the absence (docs/ux-writing.md).
  const accountDisplayName = accountInfo?.name?.trim() ?? '';
  // Treat either guest signal as guest (shared `isGuestAccount` applies the
  // defensive `credentialSource === 'guest' || authMode === 'guest'` OR):
  // legacy/normalized entries can carry `authMode: 'guest'` without
  // `credentialSource: 'guest'`, and misclassifying a guest here would expose a
  // destructive sign-out for a device-scoped token.
  const isGuest = isGuestAccount(account);
  // A guest holds a device token but is not a known signed-in user. Surface
  // "Sign in" so they can upgrade via OAuth (which merges their guest data into
  // the real account), and never expose sign-out/disconnect — destroying a
  // device-scoped guest token cannot be undone in the same state.
  const canSignOut = accountInfo != null && !isGuest;
  // CAN-3512: a quiet status row, not an alert, so a paused sync is visible
  // without opening Settings › Privacy, with its explanation on hover.
  // Signed-out and guest rows have no account to sync.
  const showSyncPaused = syncPausedReason !== null && canSignOut;
  // Early access leaves the name in its own ink: the avatar's dot and the
  // Usage row's dot carry the usage status.
  const accountIdentityTone: SidebarAccountIdentityTone = 'inherit';

  // The avatar dot is for usage only; other-context updates ride on the
  // context switcher at the top of the sidebar.
  const accountAttention: SidebarAccountAttention | null =
    usageAlertLevel === 'normal'
      ? null
      : {
          dotTone: usageAlertLevel === 'critical' ? 'danger' : 'attention',
          label:
            usageAlertLevel === 'critical'
              ? 'usage requires attention'
              : 'usage is nearing its limit',
        };
  // The row's second line (CAN-3659). The status follows the worker state for
  // any signed-in account, guests included, since it is the truth about the
  // connection. Signed out, the trigger is named "Sign in", so a status there
  // would never be announced.
  // App.tsx hydrates the store; this only reads it. Resolving inside the
  // selector re-renders on a status change, not on every heartbeat.
  const portalAccountStatus = useCanopyPortalStore((state) =>
    resolveCanopyPortalAccountStatus(state.state, canopyPortalEnabled),
  );
  // A direct controller (browser, phone, computer, or an agents session) that
  // is connected to this computer right now reads as active too (CAN-5985).
  // Reconnecting and disconnected stay Portal's: direct devices come and go
  // on their own, so a dropped one is not a state to report here.
  const directControlActive = useRemoteControlStore(
    (store) =>
      store.context.mode === 'local' &&
      store.state.controllers.some(
        (controller) =>
          controller.connected || controller.hostedSessions.length > 0,
      ),
  );
  const remoteControlStatus =
    accountInfo != null
      ? directControlActive
        ? 'active'
        : portalAccountStatus
      : null;
  // The Remote Control item follows device Remote Control, not Portal
  // (CAN-5985). Signed-out and guest accounts see it too: the dialog shows
  // its sign-in, guest and upgrade states.
  const remoteControlAvailable = useRemoteControlStore(
    (store) => store.state.available,
  );
  const trialDaysLeft = subscription.status?.trialEndsAt
    ? Math.max(
        0,
        Math.ceil(
          (Date.parse(subscription.status.trialEndsAt) - Date.now()) /
            86_400_000,
        ),
      )
    : null;

  // Always the person's own wallet (CAN-4056), whatever context is selected:
  // an organization's pool is on the context switcher, for its OWNER. Unknown
  // stays unknown: a failed or still-loading read has no balance to show, and
  // a zero here would claim an empty wallet the server never reported. A
  // still-known balance from a failed same-account refresh is kept.
  const aiCreditsBalance = aiCreditsState?.balance?.credits ?? null;
  // The row's label follows the same personal wallet's access, read only
  // while the row can show.
  const aiCreditsLibraryAccess = usePersonalModelLibraryAccess(
    subscription.aiCreditsVisible && canSignOut,
  );

  const handleItemClick = (action: () => void): void => {
    action();
    closeMenu();
  };

  const openFeedback = (): void => {
    closeMenu();
    setFeedbackModalOpen(true);
  };

  // Sign in mirrors CanopyCloudAccountSection's OAuth flow as a thin call:
  // kick off login, then broadcast the account-changed event so this menu (and
  // every other subscriber) reloads. `startCanopyCloudOAuthLogin()` resolves
  // with `{ status, account }` and can return `status.authenticated !== true`
  // (cancelled/failed) WITHOUT throwing, so we must only announce success and
  // close the menu when the sign-in actually authenticated — otherwise a
  // cancelled login would falsely report success. The `signingInRef` guard
  // prevents a second in-flight OAuth attempt from a rapid double-click.
  const handleSignIn = (): void => {
    if (signingInRef.current) return;
    signingInRef.current = true;
    setSigningIn(true);
    void window.api
      .startCanopyCloudOAuthLogin()
      .then((result) => {
        const authenticated =
          result.status.authenticated &&
          result.status.account != null &&
          result.status.missingCapabilities.length === 0;
        if (authenticated) {
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          closeMenu();
        } else {
          addToast('Unable to complete sign-in.', 'error');
        }
      })
      .catch(() => {
        // Keep the row available for retry, but do not make an IPC/configuration
        // failure look like an inert button.
        addToast(
          'Unable to start sign-in. Check Cloud configuration.',
          'error',
        );
      })
      .finally(() => {
        signingInRef.current = false;
        setSigningIn(false);
      });
  };

  const handleSignOutClick = (): void => {
    closeMenu();
    setSignOutError(null);
    setSignOutConfirmOpen(true);
  };

  const handleConfirmSignOut = (): void => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    void window.api
      .disconnectCanopyCloudAccount()
      .then(() => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        setSignOutConfirmOpen(false);
      })
      .catch(() => {
        // Surface the failure inline and keep the confirm modal open so the
        // user knows sign-out did not complete and can retry, mirroring
        // CanopyCloudAccountSection's disconnect error handling.
        setSignOutError('Unable to sign out. Please try again.');
      })
      .finally(() => {
        setSigningOut(false);
      });
  };

  const showGuestTrialAction = !canSignOut && subscription.guestCtaVisible;
  const handleSignInOutClick = canSignOut
    ? handleSignOutClick
    : showGuestTrialAction
      ? (): void => handleItemClick(subscription.startFreeTrial)
      : handleSignIn;
  const signInOutLabel = canSignOut
    ? 'Sign out'
    : showGuestTrialAction
      ? GUEST_SIGN_IN_CTA_LABEL
      : 'Sign in';

  return (
    <>
      <SidebarAccountFooter
        // Which computer a remote window shows (CAN-4268): pinned above the
        // account row only in a window for a paired computer. This computer's
        // windows reach their computers from the account menu instead.
        contextRow={<SidebarMachinePicker menuInstantInteractions />}
        // Banner stack in priority order (recovery > checklist > resume queue
        // > clones > update > slot): an unreadable credential blocks agent
        // work outright, so it outranks an available update or a credits CTA.
        footerBanner={
          <>
            <CloudAccountRecoveryPrompt visible={accountReadError} />

            <ResumeQueuePrompt />
            <CloneProgressPrompt />
            <UpdatePrompt />
            {footerBanner}
          </>
        }
        // Always the signed-in person, whatever context is selected: the
        // organization is named by the switcher at the top of the sidebar.
        identity={{
          name: accountDisplayName,
          email: accountInfo?.email,
          image: accountInfo?.image ?? null,
          signedIn: accountInfo != null,
          signingIn,
        }}
        identityTone={accountIdentityTone}
        subtitle={
          remoteControlStatus ? (
            <SidebarRemoteControlSubtitle status={remoteControlStatus} />
          ) : undefined
        }
        subtitleLabel={
          remoteControlStatus
            ? sidebarRemoteControlSubtitleLabel(remoteControlStatus)
            : undefined
        }
        attention={accountAttention}
        rowAttributes={{ 'data-onboarding-anchor': 'sidebar-account-row' }}
        menuWidth="compact"
        menuInstantInteractions
        railActions={
          <>
            <RailIconButton
              icon={RaisedHandIcon}
              tone="secondary"
              size="row"
              hoverSurface
              onClick={openFeedback}
              aria-label="Send feedback"
              aria-haspopup="dialog"
              aria-expanded={feedbackModalOpen}
              title="Send feedback"
              data-testid="sidebar-account-action-feedback"
            />
            <RailIconButton
              icon={SettingsIcon}
              tone="secondary"
              size="row"
              hoverSurface
              onClick={() => {
                closeMenu();
                onSettingsClick();
              }}
              aria-label="Settings"
              aria-pressed={settingsOpen}
              title="Settings"
              data-testid="sidebar-account-action-settings"
              data-onboarding-anchor="sidebar-settings"
            />
          </>
        }
        menu={(close) => {
          closeMenuRef.current = close;
          // Who is signed in, named with their email: the menu is theirs in
          // every context. Signed-out and guest menus have no one to name.
          const header =
            canSignOut &&
            accountInfo &&
            ((accountInfo.name ?? '').trim() !== '' ||
              accountInfo.email.trim() !== '') ? (
              <SidebarAccountMenuHeader
                name={accountInfo.name ?? ''}
                email={accountInfo.email}
                image={accountInfo.image ?? null}
              />
            ) : null;
          const subscriptionRows = subscription.visible &&
            subscription.status && (
              <>
                <DropdownMenuLabel data-testid="sidebar-account-menu-subscription-header">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate">
                      {subscription.status.label}
                    </span>
                    {subscription.status.kind === 'trial' && (
                      <SidebarTrialBadge />
                    )}
                  </span>
                  {subscription.status.kind === 'trial' &&
                    trialDaysLeft !== null && (
                      <span
                        data-testid="sidebar-subscription-trial-countdown"
                        className="mt-0.5 block text-2xs font-normal fg-tertiary"
                      >
                        {trialDaysLeft} {trialDaysLeft === 1 ? 'day' : 'days'}{' '}
                        left
                      </span>
                    )}
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() =>
                    handleItemClick(subscription.openBillingAction)
                  }
                  data-testid="sidebar-account-menu-item-billing"
                >
                  <DropdownMenuItemIcon>
                    <ArrowUp size="xl" aria-hidden="true" />
                  </DropdownMenuItemIcon>
                  {subscription.billingAction?.label ?? 'Upgrade'}
                </DropdownMenuItem>
              </>
            );
          const aiCreditsRow = subscription.aiCreditsVisible && canSignOut && (
            <SidebarAiCreditsMenuItem
              balanceCredits={aiCreditsBalance}
              libraryAccess={aiCreditsLibraryAccess}
              onSelect={() =>
                handleItemClick(() =>
                  subscription.openBillingPath(accountBillingPath()),
                )
              }
            />
          );
          // One divider closes the identity and billing block, so a menu
          // without either never opens on a separator.
          const topSection =
            header || subscriptionRows || aiCreditsRow ? (
              <>
                {header}
                {subscriptionRows}
                {aiCreditsRow}
                <DropdownMenuDivider />
              </>
            ) : null;
          // Sign out (or Sign in) closes the menu in its own last group: the
          // Computers row, when present, ends with its own divider.
          const signInOutRow = (
            <DropdownMenuItem
              onClick={handleSignInOutClick}
              data-testid="sidebar-account-menu-item-sign-in-out"
            >
              <DropdownMenuItemIcon>
                {canSignOut ? (
                  <LogoutIcon size={16} aria-hidden="true" />
                ) : (
                  <LoginIcon
                    size={16}
                    aria-hidden="true"
                    data-testid={
                      showGuestTrialAction
                        ? 'sidebar-account-menu-login-icon'
                        : undefined
                    }
                  />
                )}
              </DropdownMenuItemIcon>
              {/* The guest variant of this label is the longest string any row in
                this menu renders. A bare text node would wrap and overflow the
                fixed 32px row, so it truncates like the sidebar pill instead. */}
              <span className="min-w-0 flex-1 truncate">{signInOutLabel}</span>
            </DropdownMenuItem>
          );
          // The quiet rows every action menu shares (the worktree menu's).
          return (
            <ActionMenuRowStyle>
              {topSection}
              <DropdownMenuItem
                onClick={() => handleItemClick(() => onNavigate('usage'))}
                data-testid="sidebar-account-menu-item-usage"
                data-onboarding-anchor="sidebar-usage"
                selected={activePage === 'usage'}
                // Early access keeps the row's own ink; the dot on the right
                // carries the status.
                alert={undefined}
              >
                <DropdownMenuItemIcon>
                  <DataUsageIcon aria-hidden="true" />
                </DropdownMenuItemIcon>
                Usage
                {usageAlertLevel !== 'normal' && (
                  <span
                    aria-hidden="true"
                    data-testid="sidebar-account-usage-alert-frame"
                    className="pointer-events-none ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center"
                  >
                    <Dot
                      tone={
                        usageAlertLevel === 'critical' ? 'danger' : 'attention'
                      }
                      data-testid="sidebar-account-usage-alert-dot"
                    />
                  </span>
                )}
              </DropdownMenuItem>
              {remoteControlAvailable && (
                <DropdownMenuItem
                  onClick={() => handleItemClick(onCanopyPortalClick)}
                  data-testid="sidebar-account-menu-item-remote-control"
                >
                  <DropdownMenuItemIcon>
                    <PortalIcon size="xl" aria-hidden="true" />
                  </DropdownMenuItemIcon>
                  {REMOTE_CONTROL_LABEL}
                </DropdownMenuItem>
              )}
              {canSignOut && externalAgentsMenuEnabled && (
                <AccountMenuExternalAgentsItem
                  onOpenPath={(path) =>
                    handleItemClick(() => {
                      void openAuthenticatedCloudPageReported(path);
                    })
                  }
                />
              )}

              {showSyncPaused && (
                <>
                  {/* A status, not an action: it reads like the rows around
                      it and explains itself on hover, and to assistive tech
                      through the description below. */}
                  <RichHoverTooltip
                    content={
                      <span className="text-xs">{syncPausedExplanation()}</span>
                    }
                    triggerWrapperClassName="w-full"
                    surfaceClassName="w-max max-w-72"
                    preferRightPlacement
                  >
                    <DropdownMenuStatusRow
                      data-testid="sidebar-account-menu-sync-paused"
                      aria-describedby={syncPausedDescriptionId}
                    >
                      <DropdownMenuItemIcon>
                        <SyncIcon
                          aria-hidden="true"
                          data-testid="sidebar-account-menu-sync-icon"
                        />
                      </DropdownMenuItemIcon>
                      <span
                        data-testid="sidebar-account-menu-sync-label"
                        className="min-w-0 flex-1 truncate"
                      >
                        Sync paused
                      </span>
                      <span
                        aria-hidden="true"
                        className="pointer-events-none ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center"
                      >
                        <Dot
                          tone="filter"
                          data-testid="sidebar-account-sync-paused-dot"
                        />
                      </span>
                    </DropdownMenuStatusRow>
                  </RichHoverTooltip>
                  <span id={syncPausedDescriptionId} className="sr-only">
                    {syncPausedExplanation()}
                  </span>
                </>
              )}
              <DropdownMenuDivider />
              <AccountMenuComputersItem onClose={close} />
              {signInOutRow}
            </ActionMenuRowStyle>
          );
        }}
      />
      {feedbackModalOpen && (
        <FeedbackModal onClose={() => setFeedbackModalOpen(false)} />
      )}
      {signOutConfirmOpen && (
        <DeleteConfirmModal
          title="Sign out"
          message="You'll be signed out on this device. Your account and data stay intact and you can sign back in anytime."
          confirmLabel="Sign out"
          pendingLabel="Signing out…"
          pending={signingOut}
          error={signOutError}
          confirmTone="primary"
          onConfirm={handleConfirmSignOut}
          onCancel={() => {
            if (!signingOut) {
              setSignOutError(null);
              setSignOutConfirmOpen(false);
            }
          }}
        />
      )}
    </>
  );
}
