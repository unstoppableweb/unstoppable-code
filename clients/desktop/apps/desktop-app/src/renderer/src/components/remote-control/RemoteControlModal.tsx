import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useShallow } from 'zustand/shallow';
import { Button } from '@/components/shared/Button';
import { DialogModal } from '@/components/shared/DialogModal';
import { CopyButton } from '@/components/shared/CopyButton';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useSubscriptionStatus } from '@/hooks/useSubscriptionStatus';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  getRemoteControlApi,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';
import { RemoteControlGuestCta } from '@/components/remote-control/RemoteControlGuestCta';
import { RemoteControlMobileAppsCta } from '@/components/remote-control/RemoteControlMobileAppsCta';
import { RemoteControlPairingQr } from '@/components/remote-control/RemoteControlPairingQr';
import {
  expiresInLabel,
  SAMPLE_REMAINING_MS,
  useRemainingMs,
} from '@/components/remote-control/pairing-countdown';
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
  RemoteControlOpenPairingWindowResult,
  RemoteIncomingPairing,
} from '@canopy/desktop-shared/types';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { GUEST_WORK_PRESERVED } from '@/lib/guest-cta-copy';
import { brandText } from '@/lib/brand';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { useSettingsLocationLabel } from '@/lib/navigation/settings-destinations';
import { Notice, Skeleton, Stack } from '@canopy/ui-shared/components';

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
const ACCOUNT_LOADING_LABEL = `Checking ${CLOUD_NAME} account…`;

interface RemoteControlModalProps {
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
  | { readonly kind: 'paired'; readonly device: PairedDevice }
  | { readonly kind: 'request'; readonly request: RemoteIncomingPairing }
  | { readonly kind: 'off' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'pairing'; readonly remainingMs: number }
  | { readonly kind: 'expired' }
  | { readonly kind: 'pairing-failed' };

export function RemoteControlModal({
  onClose,
  onOpenAccountSettings,
  onRequestSignIn,
}: RemoteControlModalProps): JSX.Element {
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

  // A device-scoped guest resolves as a real cloud account (has an API key), so
  // `cloudReady` is true and the modal would otherwise offer a dead-end Enable
  // button the server rejects — the guest has no way to sign in and finish
  // pairing. Detect the guest credential and surface a sign-in CTA that routes
  // through the shared cloud-connect gate instead.
  const subscription = useSubscriptionStatus();
  const isGuest = isGuestAccount(cloudAccount);

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
  const accountGated = !cloudReady || showGuestCta;

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
    pairedDevice,
    pendingRequest,
    allowIncoming,
    pairingFailed,
    busy,
    pairingLink,
    remainingMs,
    windowEnded,
  ]);

  // Expose the inline sign-in affordance (shown in the no-account state) so the
  // App Advisor knows the user can sign in from here (CAN-936, WS3).
  const signInAffordanceVisible = view.kind === 'signed-out';
  useCurrentUiStateReporter('canopyPortal.modal', {
    open: true,
    busy,
    errorVisible: Boolean(actionError),
    signInAffordanceVisible,
    // compat: the App Advisor state key stays; there is no upgrade state.
    upgradeCtaVisible: false,
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
      <Button
        onClick={manage}
        data-testid="remote-control-manage"
        variant="link"
        data-settings-control="link"
      >
        {MANAGE_BUTTON}
      </Button>
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
            data-testid="remote-control-enable"
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
      dataTestId="remote-control-modal"
      footer={footer}
    >
      {view.kind === 'loading' ? (
        <p className="text-s fg-secondary">{ACCOUNT_LOADING_LABEL}</p>
      ) : null}

      {view.kind === 'signed-out' ? (
        <Stack gap="item" data-testid="remote-control-no-account">
          <p className="text-s fg-secondary">
            {noAccountMessage(accountLocation)}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="compact"
              onClick={onRequestSignIn}
              data-testid="remote-control-sign-in"
            >
              {SIGN_IN_BUTTON}
            </Button>
            <Button
              variant="secondary"
              size="compact"
              onClick={onOpenAccountSettings}
              data-testid="remote-control-open-settings"
            >
              {OPEN_SETTINGS_BUTTON}
            </Button>
          </div>
        </Stack>
      ) : null}

      {view.kind === 'guest' ? (
        <RemoteControlGuestCta
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

      <DesktopErrorBanner
        errorSource="remote-control-action-error"
        className=""
        error={actionError?.error}
        {...(actionError?.details === undefined
          ? {}
          : { details: actionError.details })}
        testId="remote-control-action-error"
      />

      {/* Deliberate download surface for the states before Remote Control is
          on; once it is, the pairing QR code is the one to scan. */}
      {view.kind === 'signed-out' ||
      view.kind === 'guest' ||
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
