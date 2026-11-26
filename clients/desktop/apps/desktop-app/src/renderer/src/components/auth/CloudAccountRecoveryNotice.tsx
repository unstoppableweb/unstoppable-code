import { type JSX, useState } from 'react';
import {
  ConfirmDialog,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';

/**
 * Shared between the blocking sign-in wall / connect modal (`CloudAuthPanel`)
 * and Settings → Account (`CanopyCloudAccountSection`). Both surfaces reach the
 * same state — a credential this build wrote and can no longer decrypt — and
 * both must offer exactly one reset implementation, so the copy, the
 * confirmation, and the busy handling live here rather than being restated per
 * host.
 *
 * This is a permanent surface, deliberately not gated behind any migration
 * marker: an OS keychain reset, a profile/machine migration, or genuine on-disk
 * corruption can make the current build's own credential unreadable at any
 * time, long after the shared-secure-storage cause is gone.
 *
 * The reset action stays `secondary`: it removes downloaded data and signs the
 * user out, and its `destructive` weight belongs to the confirmation dialog,
 * not to an accent-colored button inside the notice.
 */
export interface CloudAccountRecoveryNoticeProps {
  /** A reset is in flight; blocks both the opener and the confirm action. */
  resetting: boolean;
  /**
   * Failure text from the last attempt. Rendered inside the confirmation so a
   * rejected reset keeps the dialog open next to the control that retries it.
   */
  errorMessage?: string | null;
  /**
   * Runs the reset. Resolves `false` when it failed, which keeps the
   * confirmation open; `true` dismisses it.
   */
  onReset: () => Promise<boolean>;
  className?: string;
}

export function CloudAccountRecoveryNotice({
  resetting,
  errorMessage,
  onReset,
  className,
}: CloudAccountRecoveryNoticeProps): JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleConfirm = (): void => {
    if (resetting) return;
    void onReset().then((ok) => {
      if (ok) setConfirmOpen(false);
    });
  };

  return (
    <>
      <Notice
        intent="attention"
        // `text-left` guards against the sign-in wall's centered column.
        className={`text-left ${className ?? ''}`}
        data-testid="cloud-account-recovery-notice"
        title="Saved sign-in can't be read"
        actions={
          <NoticeButton
            variant="secondary"
            disabled={resetting}
            busy={resetting}
            busyLabel="Resetting…"
            onClick={(): void => setConfirmOpen(true)}
            data-testid="cloud-account-recovery-reset"
          >
            Reset saved sign-in
          </NoticeButton>
        }
      >
        {/* The consequences of a reset live in the confirmation dialog,
            which repeats them word for word; the notice carries only the
            state and its likely cause. */}
        Another copy of the app may have changed it. Reset it to sign in again.
      </Notice>
      {confirmOpen && (
        <ConfirmDialog
          title="Reset saved sign-in?"
          message="Resetting keeps a local backup, removes downloaded shared-cloud data from this device, and you'll sign in again. Your cloud account isn't deleted."
          confirmLabel="Reset saved sign-in"
          busyLabel="Resetting…"
          busy={resetting}
          errorMessage={errorMessage}
          // The shared auth state also holds failures of other sign-in
          // actions, and `onReset` records its own failure.
          errorRecordingDisabled
          destructive
          onConfirm={handleConfirm}
          onCancel={(): void => setConfirmOpen(false)}
          dataTestId="cloud-account-recovery-confirm"
          confirmTestId="cloud-account-recovery-confirm-button"
        />
      )}
    </>
  );
}
