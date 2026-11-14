import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useShallow } from 'zustand/shallow';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { Button } from '@/components/shared/Button';
import { DialogModal } from '@/components/shared/DialogModal';
import { CopyButton } from '@/components/shared/CopyButton';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useSubscriptionStatus } from '@/hooks/useSubscriptionStatus';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  getRemoteControlApi,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { RemoteControlUpgradeCta } from '@/components/portal/RemoteControlUpgradeCta';
import {
  resolveBillingManageableOrgs,
  resolveManageableLapsedOrg,
} from '@/components/portal/manageable-lapsed-org';
import { RemoteControlGuestCta } from '@/components/portal/RemoteControlGuestCta';
import { RemoteControlMobileAppsCta } from '@/components/portal/RemoteControlMobileAppsCta';
import { RemoteControlPairingQr } from '@/components/portal/RemoteControlPairingQr';
import {
  expiresInLabel,
  SAMPLE_REMAINING_MS,
  useRemainingMs,
} from '@/components/portal/pairing-countdown';
import {
  IncomingPairingRequestActions,
  IncomingPairingRequestBody,
} from '@/components/remote-access/IncomingPairingRequest';
import {
  incomingPairingTitle,
  useIncomingPairingResponse,
} from '@/components/remote-access/incoming-pairing-response';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { toAppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { useQrCodeDataUrl } from '@/hooks/useQrCodeDataUrl';
import type {
  CanopyCloudAccountPublicState,
  CanopyPortalState,
  RemoteControlOpenPairingWindowResult,
  RemoteIncomingPairing,
} from '@canopy/desktop-shared/types';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { lapsedOrgNames as lapsedOrgNamesFrom } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import { organizationBillingPath } from '@canopy/protocol/billing';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { GUEST_WORK_PRESERVED } from '@/lib/guest-cta-copy';
import { brandText } from '@/lib/brand';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { useSettingsLocationLabel } from '@/lib/navigation/settings-destinations';
import {
  ConfirmDialog,
  Disclosure,
  formatPairingCode,
  Inline,
  LoadingSpinner,
  Notice,
  NoticeButton,
  Skeleton,
  Stack,
  TextLinkButton,
} from '@canopy/ui-shared/components';

const CLOUD_NAME = `${brandText.appName} Cloud`;

/**
 * The Remote Control dialog copy (CAN-5985 A1–A6). The A1 body describes the
 * feature in every state before it is on, so it is the dialog's subtitle
 * there.
 */
const OFF_BODY =
  'Control this computer from your phone, a browser, or another computer.';
const OFF_WARNING =
  'A paired device can see and change everything on this computer, including running commands.';
const ENABLE_BUTTON = `Enable ${REMOTE_CONTROL_LABEL}`;
/** The pairing view's subtitle: the QR code and link are the first choice. */
const PAIRING_SUBTITLE =
  "Scan with your phone's camera, or copy the link to open on any device.";
const COPY_LINK_LABEL = 'Copy link';
const PAIRING_ALTERNATIVE = `Or open ${REMOTE_CONTROL_LABEL} in the web or mobile app and choose this computer. You'll confirm a matching code here.`;
const EXPIRED_BODY = 'The QR code and link expired. Paired devices still work.';
const PAIR_DEVICE_BUTTON = 'Pair a device';
/** The expired view's renew button, in Copy link's place. */
const RENEW_CODE_BUTTON = 'Get a new code';
/** The expired view's line in the countdown's place. */
const EXPIRED_LABEL = 'Expired';
const PAIRED_BODY =
  'It can control this computer now. You can remove it anytime in Settings.';
const DONE_BUTTON = 'Done';
const MANAGE_BUTTON = 'Manage';
const OPEN_PAIRING_FAILED = "Couldn't open pairing. Try again.";
const ENABLE_FAILED = `Couldn't turn on ${REMOTE_CONTROL_LABEL}. Try again.`;

/** Where the cloud account lives depends on the Settings rail. */
function noAccountMessage(accountLocation: string): string {
  return `Connect ${CLOUD_NAME} in ${accountLocation} before enabling ${REMOTE_CONTROL_LABEL.toLowerCase()}.`;
}

/**
 * The Portal's own code, kept while Portal stays on during the rollout
 * (CAN-5985): a browser that still connects through Portal pairs with it.
 * It sits behind a disclosure so it never reads as the matching code the
 * app method compares, and the whole block goes when Portal does.
 */
const PORTAL_CODE_TOGGLE = `Code for ${CLOUD_NAME}`;
const PORTAL_CODE_PROMPT = `If ${CLOUD_NAME} asks for a code, enter`;
const COPY_CODE_LABEL = 'Copy code';
/**
 * A live Portal session. Portal state names no connecting device and counts
 * none (one session can serve several), so the copy names neither, and says
 * why the paired count below leaves them out.
 */
const PORTAL_CONNECTED_TITLE = `Connected to ${CLOUD_NAME}.`;
const PORTAL_CONNECTED_BODY =
  "Devices that joined with a code aren't counted as paired devices.";
const PORTAL_RECONNECTING_TITLE = `Reconnecting to ${CLOUD_NAME}.`;
const PORTAL_RECONNECTING_BODY =
  'Sessions stay open while this computer reconnects.';
/**
 * Ends the Portal session on its own, without turning Remote Control off, so
 * a computer that still has a Portal session can be tested over the direct
 * path during the rollout. Stopping records a local disconnect, which the
 * next launch does not resume; turning Remote Control off and on starts
 * Portal again while its flag is on.
 */
const PORTAL_DISCONNECT_BUTTON = 'Disconnect';
const PORTAL_DISCONNECT_TITLE = `Disconnect from ${CLOUD_NAME}?`;
const PORTAL_DISCONNECT_MESSAGE = `Devices using ${CLOUD_NAME} lose access to this computer. Paired devices aren't affected. To reconnect, turn ${REMOTE_CONTROL_LABEL} off and on in Settings.`;
const PORTAL_DISCONNECT_FAILED = `Couldn't disconnect from ${CLOUD_NAME}. Try again.`;

const SIGN_IN_BUTTON = `Sign in to enable ${REMOTE_CONTROL_LABEL}`;
/**
 * Title and supporting line for the sign-in gate a guest opens from the pairing
 * CTA. Deliberately NOT `SIGN_IN_BUTTON`, even though they render the same
 * string today: that constant labels the no-account state's button, and reusing
 * it would let an edit to that button silently retitle this dialog.
 *
 * The description closes on {@link GUEST_WORK_PRESERVED}, the same clause the
 * pairing card ends with, so the dialog continues the sentence the guest just
 * read instead of restarting on a different subject. Shared rather than
 * duplicated because a second hand-maintained copy of that clause is exactly
 * the drift `guest-cta-copy.ts` exists to prevent.
 */
const GUEST_GATE_TITLE = `Sign in to enable ${REMOTE_CONTROL_LABEL}`;
const GUEST_GATE_DESCRIPTION = `An account is what pairs this device with ${REMOTE_CONTROL_LABEL}. ${GUEST_WORK_PRESERVED}`;
/**
 * Confirmation for the same flow. Overridden alongside the title so the guest
 * is not told about a different feature than the one they just signed in for.
 */
const GUEST_GATE_TOAST = `You're all set. Your guest work is synced and ${REMOTE_CONTROL_LABEL} is ready to enable.`;
const OPEN_SETTINGS_BUTTON = 'Open settings';
const VIEW_PORTAL_BUTTON = `Open ${CLOUD_NAME}`;
const ACCOUNT_LOADING_LABEL = `Checking ${CLOUD_NAME} account…`;

interface CanopyPortalModalProps {
  onClose: () => void;
  /**
   * Invoked when the user clicks "Open Settings" — the host opens the
   * settings overlay to the Accounts tab where the Cloud API key
   * is configured.
   */
  onOpenAccountSettings: () => void;
  /**
   * Invoked when the user clicks "Sign in to enable Remote Control" from the
   * no-account state (CAN-936, WS3). The host routes this through the shared
   * cloud connect gate so the user signs in inline and lands back on this modal,
   * which advances to the Enable state on `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT`.
   * The modal stays dumb — no OAuth logic inside it.
   */
  onRequestSignIn: () => void;
}

function devicesPairedLabel(count: number): string {
  if (count === 0) return 'No paired devices yet';
  return `${count} paired ${count === 1 ? 'device' : 'devices'}`;
}

/** The device a pairing completed with, as A4 names it. */
interface PairedDevice {
  readonly name: string;
  readonly kind: DeviceKind;
}

function pairedTitle(device: PairedDevice): string {
  const name =
    device.kind === 'hosted' ? `${brandText.appName} agents` : device.name;
  return `${name} is paired`;
}

/**
 * What the dialog shows, in priority order: account gates first, then a
 * finished pairing, a code request to answer, the opt-in, and the pairing
 * window's own states.
 */
type RemoteControlView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'guest' }
  | { readonly kind: 'upgrade' }
  | { readonly kind: 'paired'; readonly device: PairedDevice }
  | { readonly kind: 'request'; readonly request: RemoteIncomingPairing }
  | { readonly kind: 'off' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'pairing'; readonly remainingMs: number }
  | { readonly kind: 'expired' }
  | { readonly kind: 'pairing-failed' };

export function CanopyPortalModal({
  onClose,
  onOpenAccountSettings,
  onRequestSignIn,
}: CanopyPortalModalProps): JSX.Element {
  const portal = useCanopyPortalStore((s) => s.state);
  const accountLocation = useSettingsLocationLabel('account');

  const [cloudAccount, setCloudAccount] =
    useState<CanopyCloudAccountPublicState | null>(null);
  const [cloudLoading, setCloudLoading] = useState(true);

  // Load the configured Canopy Cloud account on mount and after Settings changes.
  useEffect(() => {
    let cancelled = false;
    const reload = (): void => {
      setCloudLoading(true);
      window.api
        .loadCanopyCloudAccount()
        .then((next) => {
          if (cancelled) return;
          setCloudAccount(next);
        })
        .catch(() => {
          if (cancelled) return;
          setCloudAccount(null);
        })
        .finally(() => {
          if (!cancelled) setCloudLoading(false);
        });
    };

    reload();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, reload);
    return (): void => {
      cancelled = true;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, reload);
    };
  }, []);

  const cloudReady = isCanopyCloudConnected(cloudAccount);

  // Remote Control is a paid perk (Pro + Business). The authoritative "can I use
  // Remote Control" signal is the account `portal-v1` capability, minted
  // server-side and fail-open under billing-off — NOT the `remote_control`
  // entitlement bit (the billing-off entitlements mirror never emits it, so a
  // raw entitlement check would wrongly block everyone). When billing is on and
  // a signed-in user's plan does not include Remote Control, surface an upgrade
  // CTA instead of Enable. `subscription.visible` is only ever true under
  // billing-on for a real signed-in account, so billing-off ⇒ no CTA (fail open).
  const subscription = useSubscriptionStatus();
  const hasPortalCapability =
    cloudAccount?.capabilities.includes('portal-v1') ?? false;
  // A device-scoped guest resolves as a real cloud account (has an API key), so
  // `cloudReady` is true and the modal would otherwise offer a dead-end Enable
  // button the server rejects — the guest has no way to sign in and finish
  // pairing. Detect the guest credential and surface a create-account CTA that
  // routes through the shared free-trial gate instead (the same CloudSyncModal
  // the bottom-left "Start free trial" CTA opens). `subscription.visible` is
  // never true for a guest (not signed in), so this is mutually exclusive with
  // the upgrade CTA below.
  const isGuest = isGuestAccount(cloudAccount);
  // Which of the user's orgs have no active plan (CAN-2311). Read straight off
  // the already-loaded account snapshot — no extra IPC — and passed to the CTA
  // as CONTEXT only, never as a cause. The snapshot carries current capabilities
  // and per-org `teamsEntitled`; it does not say which org (if any) was the
  // source of this user's Remote Control coverage, or whether they ever had it.
  // A personal-free-plan user, or a member of a healthy org on a plan without
  // `remote_control`, can belong to a lapsed org and have lost nothing — so the
  // CTA names the lapsed org without asserting that the lapse paused Remote
  // Control. Per-org by construction: a healthy org that still grants the
  // capability keeps it, and that user never reaches this CTA at all.
  const lapsedOrgNames = useMemo(() => {
    const states = cloudAccount?.orgBillingStates ?? [];
    return lapsedOrgNamesFrom(
      states,
      states.map((state) => state.organizationId),
    );
  }, [cloudAccount]);
  // Whether the reader can actually fix the lapse the copy above names, which
  // is what decides the paywall's action (CAN-2590): someone who can buy for the
  // named org is sent to that org's billing page, everyone else is told to ask
  // and keeps their own upgrade route. Matched here rather than inside the CTA
  // because `lapsedOrgNames` carries names only — widening that prop to carry
  // ids just to re-derive this downstream would be the worse trade.
  const billingPresentation = subscription.status?.billingPresentation ?? null;
  // Every org the reader manages is checked for the lapse, and the selected
  // navigation context settles it when more than one has lapsed, so the org
  // the button opens is never a guess (CAN-3465). Both are stable store
  // references.
  const workspaceContext = useWorkspaceContextStore(
    (store) => store.state.context,
  );
  const contextOrganizations = useWorkspaceContextStore(
    (store) => store.state.organizations,
  );
  const administeredLapsedOrg = useMemo(
    () =>
      resolveManageableLapsedOrg(
        cloudAccount?.orgBillingStates,
        resolveBillingManageableOrgs(
          contextOrganizations,
          subscription.billingManageableOrg,
        ),
        workspaceContext.kind === 'organization'
          ? workspaceContext.organizationId
          : null,
      ),
    [
      cloudAccount,
      contextOrganizations,
      subscription.billingManageableOrg,
      workspaceContext,
    ],
  );
  // ...but "administers" is not "can buy for". `billingManageableOrg` is
  // `canEditOrg`, which admits ADMIN as well as OWNER, while every billing CTA
  // on the destination page is OWNER-gated — `subscribe/page.tsx` filters to
  // OWNER for exactly this reason and says so: "routing an ADMIN there is a
  // guaranteed dead end: no upgrade affordance, no explanation, nothing they can
  // do about it."
  //
  // `billingPresentation.action` is the one signal on the wire that separates
  // them, and `view` is emitted precisely for a non-owner ADMIN. So when the
  // presentation describes THIS org and says `view`, the reader is provably
  // someone who cannot buy here: drop them to the everyone-else branch, where
  // they keep the personal upgrade route they had before this feature existed
  // and the copy names the person who can act. Sending them to a read-only page
  // with a purchase label would be the same false promise as naming a tier the
  // page cannot sell, one layer further out.
  //
  // Deliberately narrow: `view` PROVES they cannot buy, so this never guesses.
  // An ADMIN whose presentation describes some other entity is not provable
  // either way and keeps the org destination, which is at worst a page that
  // shows them their org's real billing state.
  const lapsedOrgIsReadOnlyForReader =
    administeredLapsedOrg !== null &&
    billingPresentation !== null &&
    billingPresentation.owner.type === 'organization' &&
    billingPresentation.owner.id === administeredLapsedOrg.id &&
    billingPresentation.action === 'view';
  const manageableLapsedOrg = lapsedOrgIsReadOnlyForReader
    ? null
    : administeredLapsedOrg;
  // The plan an owner/admin is being sent to buy — named ONLY when
  // `billingPresentation` actually describes the lapsed org this copy names.
  //
  // `billingPresentation` is a wallet-wide winner: the server ranks the caller's
  // own subscription/trial against every org they administer and returns the
  // priciest, paired with its exact `owner`. It carries no promise of being the
  // org the paywall is talking about, and the protocol doc is explicit that it
  // is "Display and navigation only; never use this field for capability or
  // authorization" (`packages/protocol/src/billing/index.ts`). Pairing its
  // `plan` with a DIFFERENT entity's id splits those two halves apart and
  // produces a claim that is simply false: a personal-trial user who administers
  // a lapsed org gets `owner: { type: 'user' }` with the personal entry tier, and
  // the panel would then read "This feature requires Pro" over a `Get Pro` button
  // deep-linking to that ORG's billing page — which only sells the entry ORG tier
  // and silently ignores a personal `?plan=` key it cannot fulfil. The reader is
  // promised a plan the destination cannot sell, which is a worse mis-statement
  // than the jargon CAN-2590 set out to remove.
  //
  // So the plan is named only when the presentation's owner IS this org AND its
  // `action` says this reader can actually buy it. Both halves are required, and
  // each rules out a different false statement:
  //
  //   - `owner` mismatch → the plan belongs to some other entity (see above).
  //   - `action !== 'subscribe'` → the plan is not on offer to THIS reader.
  //     The server sets `manage` for an owner whose org already holds a live
  //     paid subscription, and `view` for a non-owner ADMIN, who reaches this
  //     branch (`billingManageableOrg` is OWNER+ADMIN via `canEditOrg`) but
  //     lands on a read-only billing page. Naming a plan for `manage` would tell
  //     an owner to buy the tier they are already paying for; naming one for
  //     `view` would put a purchase label on a page that sells them nothing.
  //
  // This mirrors `useSubscriptionStatus`'s own `billingAction`, which already
  // requires `action === 'subscribe'` before it will name a plan or attach a
  // `?plan=` intent — the two derivations now agree instead of one quietly
  // dropping the guard.
  //
  // Anything short of both conditions falls back to the plan-agnostic copy and
  // the generic button, which is the fallback this ticket's own plan prescribed
  // for a winner that names a tier the reader cannot buy here.
  // `billingPresentation` is also optional on the wire, so null is a real state
  // the CTA renders around, never `Get undefined`.
  //
  // REACHABILITY, stated plainly so the next maintainer does not mistake the
  // E2E mock override for evidence: against today's server the named-plan
  // branch is effectively unreachable, and the plan-agnostic fallback IS the
  // production path. An org must be `billingActive` to become a presentation
  // candidate at all (`entitlements.ts`), `action: 'subscribe'` narrows that to
  // an OWNER on a trialing org, and the org trial plan is the entry org tier,
  // which grants `teams` — so such an org is not lapsed. The capture spec
  // reaches the branch only by overriding `billingPresentation` in the mock.
  //
  // The guard is kept rather than deleted because it is the correct rule, not
  // an optimization: it states the two facts that must hold before this panel
  // may name a tier, and it lights up honestly if the server ever starts
  // offering a lapsed org a plan (e.g. a paid org on a tier that does not grant
  // `teams` — the legacy tiers carry no capabilities at all). Deleting it would
  // leave the next person to re-derive the rule from scratch, which is how the
  // crossed pairing got here in the first place.
  const upgradePlan =
    billingPresentation !== null &&
    billingPresentation.owner.type === 'organization' &&
    manageableLapsedOrg !== null &&
    billingPresentation.owner.id === manageableLapsedOrg.id &&
    billingPresentation.action === 'subscribe'
      ? billingPresentation.plan
      : null;
  // On the owner/admin branch the button deep-links into the lapsed org's own
  // billing page, since that org's plan is exactly what they are being asked to
  // renew. It carries a `?plan=` intent only when `upgradePlan` survived the
  // owner check above, because the org billing page honours the intent only for
  // a plan it can actually sell this org; an unmatched key is inert and would
  // make the button's promise and its destination disagree. Everyone else keeps
  // the hook's resolved billing action, which is that reader's own upgrade path.
  const { openBillingPath, openBillingAction, openUpgradePage } = subscription;
  const openUpgrade = useCallback((): void => {
    // The provably-read-only ADMIN gets an EXPLICIT personal destination, not
    // `openBillingAction()`. That looks like the obvious fallback and is a trap:
    // for this exact presentation shape (`owner.type === 'organization'` with
    // `action: 'view'`) the hook resolves `billingAction.path` back to
    // `organizationBillingPath(owner.id)` — byte-identical to the org page the
    // diversion exists to keep them off. Deferring to it would leave the copy
    // promising "or upgrade your own plan" over a button that lands on a page
    // selling them nothing, which is the CAN-2590 defect one layer out.
    //
    // `/pricing` (via `openUpgradePage`) is the catalog every reader can act on
    // regardless of role, so the promise and the destination agree.
    if (lapsedOrgIsReadOnlyForReader) {
      openUpgradePage();
      return;
    }
    if (manageableLapsedOrg) {
      openBillingPath(
        organizationBillingPath(manageableLapsedOrg.id, {
          ...(upgradePlan ? { plan: upgradePlan.key } : {}),
        }),
      );
      return;
    }
    openBillingAction();
  }, [
    lapsedOrgIsReadOnlyForReader,
    manageableLapsedOrg,
    upgradePlan,
    openBillingPath,
    openBillingAction,
    openUpgradePage,
  ]);

  const {
    rcHydrated,
    allowIncoming,
    pairedCount,
    pendingRequest,
    setAllowIncoming,
    openPairingWindow,
  } = useRemoteControlStore(
    useShallow((store) => ({
      rcHydrated: store.hydrated,
      allowIncoming: store.state.allowIncoming,
      pairedCount: store.state.controllers.length,
      // Requests are answered in this computer's own windows only.
      pendingRequest:
        store.context.mode === 'local' && store.state.allowIncoming
          ? (store.state.incomingPairings[0] ?? null)
          : null,
      setAllowIncoming: store.setAllowIncoming,
      openPairingWindow: store.openPairingWindow,
    })),
  );
  const openSettings = useNavigationStore((store) => store.openSettings);
  // A3/A6: this dialog answers the request itself while it is open.
  const requestAnswer = useIncomingPairingResponse(
    pendingRequest?.pairingId ?? null,
  );

  const [busy, setBusy] = useState<'idle' | 'enabling' | 'opening'>('idle');
  const [actionError, setActionError] = useState<InlineFailure | null>(null);
  // The link lives only in this component: main never returns it again.
  const [pairingLink, setPairingLink] =
    useState<RemoteControlOpenPairingWindowResult | null>(null);
  const [windowEnded, setWindowEnded] = useState(false);
  const [pairingFailed, setPairingFailed] = useState(false);
  const [pairedDevice, setPairedDevice] = useState<PairedDevice | null>(null);
  // Our own replace closes the previous window with `replaced`; that close is
  // not an expiry. Counted, since a reopen can overlap a slow earlier one.
  const openingCount = useRef(0);
  const autoOpened = useRef(false);

  // A guest can't pair: the relay needs a signed-in account.
  const showGuestCta = cloudReady && isGuest;
  // Free app access grants `remote_control` to every signed-in account, so
  // there is no plan to sell. `subscription.visible` is already false then;
  // the explicit check keeps the paywall closed even if a stale account
  // snapshot still lacks `portal-v1` or names a lapsed org.
  const showUpgradeCta =
    cloudReady &&
    !allowIncoming &&
    !hasPortalCapability &&
    !isGuest &&
    !subscription.freeAccess &&
    subscription.visible;
  const accountGated = !cloudReady || showGuestCta || showUpgradeCta;

  // Opening the dialog opens pairing; reopening it replaces the window (and
  // its link) with a new one.
  const openPairing = useCallback(async (): Promise<void> => {
    setActionError(null);
    setPairingFailed(false);
    setWindowEnded(false);
    setPairedDevice(null);
    setBusy('opening');
    openingCount.current += 1;
    try {
      setPairingLink(await openPairingWindow());
    } catch (err) {
      setPairingLink(null);
      setPairingFailed(true);
      const appError = toAppError(resolveClientAppError(err));
      setActionError(
        appError ? inlineFailure(appError, OPEN_PAIRING_FAILED) : null,
      );
    } finally {
      openingCount.current -= 1;
      setBusy('idle');
    }
  }, [openPairingWindow]);

  useEffect(() => {
    if (!allowIncoming) {
      // Turned off here or elsewhere: the window is gone with it.
      autoOpened.current = false;
      setPairingLink(null);
      setWindowEnded(false);
      setPairingFailed(false);
      return;
    }
    if (!rcHydrated || cloudLoading || accountGated || autoOpened.current) {
      return;
    }
    autoOpened.current = true;
    void openPairing();
  }, [allowIncoming, rcHydrated, cloudLoading, accountGated, openPairing]);

  useEffect(() => {
    const api = getRemoteControlApi();
    if (!api) return undefined;
    return api.onPairingEvent((event) => {
      switch (event.type) {
        case 'window-closed':
          if (event.reason === 'replaced' && openingCount.current > 0) return;
          setPairingLink(null);
          // A consumed window ends in `paired`; a disabled one in the off
          // state. Anything else leaves the expired state to reopen from.
          if (
            event.reason === 'expired' ||
            event.reason === 'replaced' ||
            event.reason === 'closed'
          ) {
            setWindowEnded(true);
          }
          return;
        case 'paired':
          setPairedDevice({ name: event.name, kind: event.kind });
          return;
        case 'window-opened':
        case 'request':
        case 'request-ended':
          return;
      }
    });
  }, []);

  const enable = useCallback(async (): Promise<void> => {
    if (!cloudReady) return;
    setActionError(null);
    setBusy('enabling');
    // The opt-in's own effect would open pairing too; this flow does it.
    autoOpened.current = true;
    try {
      await setAllowIncoming(true);
    } catch (err) {
      autoOpened.current = false;
      const appError = toAppError(resolveClientAppError(err));
      setActionError(appError ? inlineFailure(appError, ENABLE_FAILED) : null);
      setBusy('idle');
      return;
    }
    await openPairing();
  }, [cloudReady, setAllowIncoming, openPairing]);

  const manage = useCallback((): void => {
    onClose();
    openSettings('remote-access');
  }, [onClose, openSettings]);

  const remainingMs = useRemainingMs(pairingLink?.expiresAt ?? null);
  const pairingQrSrc = useQrCodeDataUrl(pairingLink?.link ?? null);

  const view = useMemo<RemoteControlView>(() => {
    if (cloudLoading || !rcHydrated) return { kind: 'loading' };
    if (!cloudReady) return { kind: 'signed-out' };
    if (showGuestCta) return { kind: 'guest' };
    if (showUpgradeCta) return { kind: 'upgrade' };
    if (pairedDevice) return { kind: 'paired', device: pairedDevice };
    if (pendingRequest) return { kind: 'request', request: pendingRequest };
    if (!allowIncoming) return { kind: 'off' };
    if (pairingFailed) return { kind: 'pairing-failed' };
    if (busy === 'opening' || busy === 'enabling') return { kind: 'opening' };
    if (pairingLink && remainingMs !== null && remainingMs > 0) {
      return { kind: 'pairing', remainingMs };
    }
    if (pairingLink === null && !windowEnded) return { kind: 'opening' };
    return { kind: 'expired' };
  }, [
    cloudLoading,
    rcHydrated,
    cloudReady,
    showGuestCta,
    showUpgradeCta,
    pairedDevice,
    pendingRequest,
    allowIncoming,
    pairingFailed,
    busy,
    pairingLink,
    remainingMs,
    windowEnded,
  ]);

  // Resolve the Canopy Cloud base URL this build talks to (a localhost origin
  // in dev, staging for internal builds, production for releases), so the
  // View web portal button targets the environment the Portal session is
  // paired with. Stays null when the base URL is not configured — the button
  // is hidden rather than pointing at a dead origin.
  const [cloudBaseUrl, setCloudBaseUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.api
      .getCanopyCloudBaseUrl()
      .then((base) => {
        if (cancelled || !base) return;
        setCloudBaseUrl(base.replace(/\/+$/, ''));
      })
      .catch(() => {
        // Leave null; the View web portal button stays hidden.
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const portalLive =
    portal.status === 'active' || portal.status === 'reconnecting';
  const portalPairingCode =
    portal.status === 'pending_auth' || portal.status === 'active'
      ? portal.pairingCode
      : null;
  // While pairing, deep-link to the code-entry dialog: `/portal` permanently
  // redirects to `/chat`, where the pairing form only opens on an explicit
  // Connect-a-device click — `?pair=1` opens it on arrival (CAN-2357).
  const portalPath =
    portal.status === 'pending_auth' ? '/chat?pair=1' : '/portal';

  const openPortal = useCallback(() => {
    // Hand the user off to the remote-control surface already signed in. The
    // main process exchanges the desktop cloud credential for a one-time
    // code; if that is unavailable (flag off, no token, offline, mint failure,
    // or an older build without the handler) we fall back to the plain,
    // unauthenticated portal URL so the button still works.
    const openUnauthenticated = (): void => {
      if (!cloudBaseUrl) return;
      void window.api.browser.openExternal({
        url: `${cloudBaseUrl}${portalPath}`,
      });
    };
    try {
      void window.api
        .openAuthenticatedPortalPage(portalPath)
        .catch(openUnauthenticated);
    } catch {
      openUnauthenticated();
    }
  }, [cloudBaseUrl, portalPath]);

  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<InlineFailure | null>(
    null,
  );
  const disconnectPortal = useCallback(async (): Promise<void> => {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      // The pushed Portal state then hides the notice.
      await window.api.canopyPortal.stop();
      setConfirmingDisconnect(false);
    } catch (err) {
      const appError = toAppError(resolveClientAppError(err));
      setDisconnectError(
        appError
          ? inlineFailure(appError, PORTAL_DISCONNECT_FAILED)
          : { error: PORTAL_DISCONNECT_FAILED },
      );
    } finally {
      setDisconnecting(false);
    }
  }, []);

  const viewPortalVisible = portalLive && cloudBaseUrl !== null;
  // Expose the inline sign-in affordance (shown in the no-account state) so the
  // App Advisor knows the user can sign in from here (CAN-936, WS3).
  const signInAffordanceVisible = view.kind === 'signed-out';
  useCurrentUiStateReporter('canopyPortal.modal', {
    open: true,
    busy,
    errorVisible: Boolean(actionError),
    signInAffordanceVisible,
    viewPortalVisible,
    upgradeCtaVisible: view.kind === 'upgrade',
    guestCtaVisible: view.kind === 'guest',
    pairingQrVisible: view.kind === 'pairing' && pairingQrSrc !== null,
  });

  const title =
    view.kind === 'request'
      ? incomingPairingTitle(view.request)
      : view.kind === 'paired'
        ? pairedTitle(view.device)
        : REMOTE_CONTROL_LABEL;
  const subtitle =
    view.kind === 'loading' ||
    view.kind === 'signed-out' ||
    view.kind === 'guest' ||
    view.kind === 'upgrade' ||
    view.kind === 'off' ? (
      OFF_BODY
    ) : view.kind === 'opening' || view.kind === 'pairing' ? (
      <PairingSubtitle expired={false} />
    ) : view.kind === 'expired' ? (
      <PairingSubtitle expired />
    ) : undefined;
  const pairingStates =
    view.kind === 'opening' ||
    view.kind === 'pairing' ||
    view.kind === 'expired' ||
    view.kind === 'pairing-failed';

  const pairedSummary = pairingStates ? (
    <span
      className="mr-auto text-xs fg-secondary"
      data-testid="remote-control-paired-summary"
    >
      {devicesPairedLabel(pairedCount)}
      {' · '}
      <TextLinkButton onClick={manage} data-testid="remote-control-manage">
        {MANAGE_BUTTON}
      </TextLinkButton>
    </span>
  ) : null;

  const footer =
    view.kind === 'request' ? (
      <IncomingPairingRequestActions
        busy={requestAnswer.busy}
        onRespond={requestAnswer.respond}
      />
    ) : view.kind === 'paired' ? (
      <Button
        variant="primary"
        size="compact"
        onClick={onClose}
        data-testid="remote-control-paired-done"
      >
        {DONE_BUTTON}
      </Button>
    ) : pairedSummary !== null ||
      view.kind === 'off' ||
      view.kind === 'pairing-failed' ? (
      <>
        {/* Primary actions only: the X and an outside click dismiss. */}
        {pairedSummary}
        {view.kind === 'off' ? (
          <Button
            variant="primary"
            size="compact"
            onClick={() => void enable()}
            disabled={busy !== 'idle'}
            data-testid="canopy-portal-enable"
          >
            {busy === 'enabling' ? 'Enabling…' : ENABLE_BUTTON}
          </Button>
        ) : null}
        {/* An expired link renews from the body, in Copy link's place. */}
        {view.kind === 'pairing-failed' ? (
          <Button
            variant="primary"
            size="compact"
            onClick={() => void openPairing()}
            disabled={busy !== 'idle'}
            data-testid="remote-control-pair-device"
          >
            {PAIR_DEVICE_BUTTON}
          </Button>
        ) : null}
      </>
    ) : undefined;

  return (
    <DialogModal
      onClose={busy === 'enabling' ? (): void => {} : onClose}
      title={title}
      subtitle={subtitle}
      maxWidth="md"
      closeOnBackdrop={busy !== 'enabling'}
      dataTestId="canopy-portal-modal"
      footer={footer}
    >
      {view.kind === 'loading' ? (
        <p className="text-s fg-secondary">{ACCOUNT_LOADING_LABEL}</p>
      ) : null}

      {view.kind === 'signed-out' ? (
        <Stack gap="item" data-testid="canopy-portal-no-account">
          <p className="text-s fg-secondary">
            {noAccountMessage(accountLocation)}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="compact"
              onClick={onRequestSignIn}
              data-testid="canopy-portal-sign-in"
            >
              {SIGN_IN_BUTTON}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              onClick={onOpenAccountSettings}
              data-testid="canopy-portal-open-settings"
            >
              {OPEN_SETTINGS_BUTTON}
            </Button>
          </div>
        </Stack>
      ) : null}

      {view.kind === 'guest' ? (
        <RemoteControlGuestCta
          freeAccess={subscription.freeAccess}
          // Keep the gate on the subject of the button that opened it.
          // `startFreeTrial`'s default title names a specific offer, and a
          // guest who clicked to unlock pairing would otherwise get a dialog
          // headed by an unrelated product — a non sequitur, not an upsell.
          // Same reason `GuestUpgradeNudge` passes its own.
          onCreateAccount={(): void =>
            subscription.startFreeTrial({
              title: GUEST_GATE_TITLE,
              description: GUEST_GATE_DESCRIPTION,
              toastMessage: GUEST_GATE_TOAST,
            })
          }
        />
      ) : null}

      {view.kind === 'upgrade' ? (
        <RemoteControlUpgradeCta
          onUpgrade={openUpgrade}
          lapsedOrgNames={lapsedOrgNames}
          manageableLapsedOrg={manageableLapsedOrg}
          planDisplayName={upgradePlan?.displayName ?? null}
        />
      ) : null}

      {view.kind === 'off' ? (
        <Notice intent="attention" data-testid="remote-control-off-warning">
          {OFF_WARNING}
        </Notice>
      ) : null}

      {view.kind === 'paired' ? (
        <p
          className="text-s text-pretty fg-secondary"
          data-testid="remote-control-paired"
        >
          {PAIRED_BODY}
        </p>
      ) : null}

      {view.kind === 'request' ? (
        <IncomingPairingRequestBody
          request={view.request}
          error={requestAnswer.error}
        />
      ) : null}

      {/* The opening state draws the pairing view's own layout, so the QR
          code and link replace the skeleton in place. */}
      {view.kind === 'opening' ? (
        <Skeleton
          loading
          label="Opening pairing"
          testId="remote-control-pairing-opening"
        >
          <PairingLink state="sample" />
        </Skeleton>
      ) : null}

      {view.kind === 'pairing' && pairingLink ? (
        <div data-testid="remote-control-pairing">
          <PairingLink
            state="live"
            qrSrc={pairingQrSrc}
            link={pairingLink.link}
            remainingMs={view.remainingMs}
          />
        </div>
      ) : null}

      {/* The expired view keeps the pairing layout, so the dialog holds its
          height through expiry and renewal. */}
      {view.kind === 'expired' ? (
        <PairingLink
          state="expired"
          onRenew={() => void openPairing()}
          renewDisabled={busy !== 'idle'}
        />
      ) : null}

      {view.kind !== 'request' && view.kind !== 'paired' ? (
        <PortalCompatibility
          portal={portal}
          pairingCode={portalPairingCode}
          live={portalLive}
          viewPortal={viewPortalVisible ? openPortal : null}
          onDisconnect={() => {
            setDisconnectError(null);
            setConfirmingDisconnect(true);
          }}
        />
      ) : null}

      {confirmingDisconnect ? (
        <ConfirmDialog
          title={PORTAL_DISCONNECT_TITLE}
          message={PORTAL_DISCONNECT_MESSAGE}
          confirmLabel={PORTAL_DISCONNECT_BUTTON}
          busyLabel="Disconnecting…"
          busy={disconnecting}
          errorMessage={
            disconnectError === null
              ? null
              : typeof disconnectError.error === 'string'
                ? disconnectError.error
                : PORTAL_DISCONNECT_FAILED
          }
          {...(disconnectError?.details === undefined
            ? {}
            : { errorDetails: disconnectError.details })}
          destructive
          onConfirm={() => void disconnectPortal()}
          onCancel={() => setConfirmingDisconnect(false)}
          confirmTestId="canopy-portal-disconnect-confirm"
          dataTestId="canopy-portal-disconnect-dialog"
        />
      ) : null}

      <DesktopErrorBanner
        errorSource="canopy-portal-action-error"
        className=""
        error={actionError?.error}
        {...(actionError?.details === undefined
          ? {}
          : { details: actionError.details })}
        testId="canopy-portal-action-error"
      />

      {/* Deliberate download surface for the states before Remote Control is
          on; once it is, the pairing QR code is the one to scan. */}
      {view.kind === 'signed-out' ||
      view.kind === 'guest' ||
      view.kind === 'upgrade' ||
      view.kind === 'off' ? (
        <RemoteControlMobileAppsCta />
      ) : null}
    </DialogModal>
  );
}

/**
 * The pairing states' subtitle. Both strings share one grid cell, so the
 * header is as tall as the taller one: the pairing line wraps where the
 * shorter expired line would not, and the dialog would shrink at expiry and
 * grow back on renewal. The string not showing is invisible and hidden from
 * assistive technology.
 */
function PairingSubtitle({
  expired,
}: {
  readonly expired: boolean;
}): JSX.Element {
  return (
    <span className="grid">
      <span
        aria-hidden={expired ? true : undefined}
        className={`col-start-1 row-start-1 ${expired ? 'invisible' : ''}`}
      >
        {PAIRING_SUBTITLE}
      </span>
      <span
        aria-hidden={expired ? undefined : true}
        className={`col-start-1 row-start-1 ${expired ? '' : 'invisible'}`}
      >
        {EXPIRED_BODY}
      </span>
    </span>
  );
}

type PairingLinkProps =
  | {
      readonly state: 'live';
      readonly qrSrc: string | null;
      readonly link: string;
      readonly remainingMs: number;
    }
  | { readonly state: 'sample' }
  | {
      readonly state: 'expired';
      readonly onRenew: () => void;
      readonly renewDisabled: boolean;
    };

/**
 * The pairing view's body (CAN-5985 A2): the QR code first, the link and its
 * countdown under it, then the app method. Every state draws the same rows,
 * so the dialog keeps its height from opening through expiry and renewal.
 *
 * - `live`: the code, Copy link and the countdown, with their test ids.
 * - `sample`: the opening state's stand-in inside a `Skeleton`, with sample
 *   values and no test ids, so specs never find a stand-in control.
 * - `expired`: a blank tile, the renew button in Copy link's place and
 *   "Expired" in the countdown's.
 */
function PairingLink(props: PairingLinkProps): JSX.Element {
  const live = props.state === 'live';
  return (
    <Stack gap="group">
      <Stack gap="item" align="center">
        {props.state === 'expired' ? (
          <RemoteControlPairingQr qrSrc={null} expired />
        ) : (
          <RemoteControlPairingQr qrSrc={live ? props.qrSrc : null} />
        )}
        {/* The countdown sits on its own row: beside the button, the
            centered pair re-centered whenever "Copy link" became "Copied"
            or the count lost a digit, so both jumped sideways. */}
        <Stack gap="tight" align="center">
          {props.state === 'expired' ? (
            <>
              {/* Deliberate deviation from the Dialog actions rule (a
                  dialog's own actions sit in the footer) for the Remote
                  Control dialog's expired state: renewing acts on the code,
                  as Copy link does, and doesn't complete the dialog, so it
                  takes Copy link's place in the body. */}
              <Button
                variant="secondary"
                size="compact"
                onClick={props.onRenew}
                disabled={props.renewDisabled}
                data-testid="remote-control-pair-device"
              >
                {RENEW_CODE_BUTTON}
              </Button>
              <p
                className="text-s tabular-nums fg-secondary"
                data-testid="remote-control-pairing-expired"
              >
                {EXPIRED_LABEL}
              </p>
            </>
          ) : (
            <>
              <CopyButton
                value={props.state === 'live' ? props.link : ''}
                label={COPY_LINK_LABEL}
                ariaLabel={COPY_LINK_LABEL}
                title={COPY_LINK_LABEL}
                variant="secondary"
                size="compact"
                {...(live ? { dataTestId: 'remote-control-copy-link' } : {})}
              />
              <p
                className="text-s tabular-nums fg-secondary"
                {...(live
                  ? { 'data-testid': 'remote-control-pairing-countdown' }
                  : {})}
              >
                {expiresInLabel(
                  props.state === 'live'
                    ? props.remainingMs
                    : SAMPLE_REMAINING_MS,
                )}
              </p>
            </>
          )}
        </Stack>
      </Stack>
      <p className="text-s text-pretty fg-secondary">{PAIRING_ALTERNATIVE}</p>
    </Stack>
  );
}

/**
 * A browser that connects through Portal during the rollout: its live
 * session, and its code behind a disclosure while Portal waits. Portal
 * follows the Remote Control opt-in, so there is no separate switch.
 */
function PortalCompatibility({
  portal,
  pairingCode,
  live,
  viewPortal,
  onDisconnect,
}: {
  readonly portal: CanopyPortalState;
  readonly pairingCode: string | null;
  readonly live: boolean;
  readonly viewPortal: (() => void) | null;
  readonly onDisconnect: () => void;
}): JSX.Element | null {
  if (pairingCode === null && !live) return null;
  const reconnecting = portal.status === 'reconnecting';
  return (
    <Stack gap="item" data-testid="remote-control-portal">
      {live ? (
        <Notice
          intent={reconnecting ? 'neutral' : 'positive'}
          {...(reconnecting ? { icon: <LoadingSpinner /> } : {})}
          title={
            reconnecting ? PORTAL_RECONNECTING_TITLE : PORTAL_CONNECTED_TITLE
          }
          actions={
            <>
              {viewPortal ? (
                <NoticeButton
                  variant="secondary"
                  onClick={viewPortal}
                  data-testid="canopy-portal-view-web-portal"
                >
                  {VIEW_PORTAL_BUTTON}
                </NoticeButton>
              ) : null}
              <NoticeButton
                variant="secondary"
                onClick={onDisconnect}
                data-testid="canopy-portal-disconnect"
              >
                {PORTAL_DISCONNECT_BUTTON}
              </NoticeButton>
            </>
          }
          data-testid="canopy-portal-status-row"
        >
          {reconnecting ? PORTAL_RECONNECTING_BODY : PORTAL_CONNECTED_BODY}
        </Notice>
      ) : null}
      {pairingCode !== null ? (
        <Disclosure
          label={PORTAL_CODE_TOGGLE}
          dataTestId="canopy-portal-pairing-code-disclosure"
        >
          <Inline gap="inline" wrap data-testid="canopy-portal-pairing-code">
            <span className="text-s fg-secondary">{PORTAL_CODE_PROMPT}</span>
            <span
              className={`${POSTHOG_REPLAY_BLOCK_CLASS} font-mono text-s fg-primary select-all`}
              data-testid="canopy-portal-pairing-code-value"
            >
              {formatPairingCode(pairingCode)}
            </span>
            <CopyButton
              value={pairingCode}
              label={COPY_CODE_LABEL}
              ariaLabel={COPY_CODE_LABEL}
              title={COPY_CODE_LABEL}
              variant="secondary"
              size="compact"
              dataTestId="canopy-portal-copy-code"
            />
          </Inline>
        </Disclosure>
      ) : null}
    </Stack>
  );
}
