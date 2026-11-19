import { type JSX, useCallback, useRef, useState } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { brandText } from '@/lib/brand';
import { BrandLogo } from '@/components/BrandLogo';
import { DialogModal } from '@/components/shared/DialogModal';
import {
  CloudAuthPanel,
  GUEST_CLOUD_AUTH_BENEFITS,
} from '@/components/auth/CloudAuthPanel';
import type { CanopyCloudConnectSuccess } from '@/components/auth/useCanopyCloudAuth';
import {
  didGuestMergeFail,
  GUEST_MERGE_FAILURE_MESSAGE,
} from '@/components/auth/guestMergeFailure';
import { isConnectedNonGuest } from '@/stores/cloudConnectGateStore';
import { useGitHubStore } from '@/stores/githubStore';

interface CloudSyncModalProps {
  onClose: () => void;
  /**
   * Modal heading. Defaults to the branded cloud name (e.g. "Canopy Cloud").
   */
  title?: string;
  /**
   * Modal subheading. Defaults to the connect-benefits copy; pass `null` to
   * render no subheading at all, for callers whose benefit rows already say
   * everything a subheading would.
   */
  subtitle?: string | null;
  /**
   * Optional short lead line above the benefit rows, used to explain why a
   * user is being asked to sign in before a specific action.
   */
  description?: string;
  /**
   * Body of the success toast fired when the user connects. There is no
   * success *screen*: growing the modal to show a confirmation next to a
   * still-live "Disconnect" button contradicted itself, so success closes.
   */
  toastMessage?: string;
  /** Use guest-specific reassurance only for a confirmed guest entry point. */
  guestBenefits?: boolean;
}

const DEFAULT_TITLE = `${brandText.appName} Cloud`;
const DEFAULT_SUBTITLE = `Connect your account to access team features, ${REMOTE_CONTROL_LABEL}, and sync across devices.`;
const DEFAULT_TOAST_MESSAGE = "You're connected.";
const SUCCESS_TOAST_TITLE = 'Sign in successful';

/**
 * The single sign-in gate behind every contextual connect prompt (guest pill,
 * share flows, AI Credits, Remote Control, model recovery, session transfer).
 *
 * It is a conversion surface, not a settings pane: one pitch, one primary
 * action, and the API key demoted to a link that swaps the panel. Connecting
 * closes the modal and fires a persistent toast rather than rendering an
 * in-modal success state — the caller that opened the gate resumes its own
 * action on close, so a "Continue" button was asking the user to confirm
 * something that had already happened.
 */
export function CloudSyncModal({
  onClose,
  title = DEFAULT_TITLE,
  subtitle = DEFAULT_SUBTITLE,
  description,
  toastMessage,
  guestBenefits = false,
}: CloudSyncModalProps): JSX.Element {
  const oauthCtaRef = useRef<HTMLButtonElement | null>(null);
  const connectHandledRef = useRef(false);
  const [authPending, setAuthPending] = useState(false);

  const handleConnectSuccess = useCallback(
    (result: CanopyCloudConnectSuccess): void => {
      // A guest credential is technically "connected"; the gate's callers all
      // need a real account, so nothing is announced or closed for a guest.
      if (!isConnectedNonGuest(result.account)) return;
      connectHandledRef.current = true;
      const mergeFailed = didGuestMergeFail(result, guestBenefits);
      const baseMessage = toastMessage ?? DEFAULT_TOAST_MESSAGE;
      const message = mergeFailed
        ? GUEST_MERGE_FAILURE_MESSAGE
        : result.replacedManualKey
          ? `${baseMessage} Stored API key was replaced by OAuth sign-in.`
          : baseMessage;
      useGitHubStore
        .getState()
        .addToast(message, mergeFailed ? 'warning' : 'success', undefined, {
          category: 'Account',
          title: mergeFailed ? 'Guest work not synced' : SUCCESS_TOAST_TITLE,
          // The modal closes with no success screen, so both outcomes are
          // transactional and have no other surviving confirmation surface.
          persistent: true,
          forceInApp: true,
        });
      onClose();
    },
    [guestBenefits, onClose, toastMessage],
  );

  const handleReadyToContinue = useCallback((): void => {
    // A user-initiated connection is already closed by the success callback.
    // This path recovers only the race where a later account read discovers
    // that another surface connected after the gate's first read.
    if (!connectHandledRef.current) onClose();
  }, [onClose]);

  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <BrandLogo size={18} className="shrink-0" aria-hidden />
          {title}
        </span>
      }
      subtitle={subtitle ?? undefined}
      // `md` matches RemoteControlModal, the surface this most often launches
      // from, so Remote Control → sign-in does not resize the dialog under the
      // user. The old `2xl` was a two-column settings width on a one-decision
      // surface.
      maxWidth="md"
      headerBorder={false}
      // The panel's body opens with the lead line that supports this title, so
      // the header hands it 8px rather than the default 16px.
      headerSpacing="tight"
      trapFocus
      initialFocusRef={oauthCtaRef}
      closeOnBackdrop={!authPending}
      closeOnEscape={!authPending}
      showCloseButton={!authPending}
      dataTestId="cloud-sync-modal"
    >
      <CloudAuthPanel
        layout="modal"
        // The dialog subheading and the panel's lead are the same role: one
        // supporting line under the title. Render the generic lead only when
        // the host left that slot empty (the guest gate), or the two stack into
        // a doubled paragraph now that the lead sits tight under the title. A
        // per-surface `description` always wins.
        lead={description ?? (subtitle === null ? undefined : null)}
        benefits={guestBenefits ? GUEST_CLOUD_AUTH_BENEFITS : undefined}
        allowApiKeyFallback={!guestBenefits}
        oauthCtaRef={oauthCtaRef}
        onAuthPendingChange={setAuthPending}
        onConnectSuccess={handleConnectSuccess}
        onReadyToContinue={handleReadyToContinue}
      />
    </DialogModal>
  );
}
