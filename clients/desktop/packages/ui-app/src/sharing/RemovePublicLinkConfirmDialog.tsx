import type { JSX, RefObject } from 'react';
import { Button, DialogModal, ErrorBanner } from '@canopy/ui-shared/components';
import {
  removePublicLinkMessage,
  type RemovePublicLinkRemainingAudience,
} from '@canopy/ui-shared/lib/remove-public-link';

/**
 * Confirmation before an owner unpublishes a public share. Removing the link
 * changes who can use it, so the consequence is spelled out before anything
 * happens: who loses access, and who keeps it.
 */

const TITLE = 'Remove public link?';
const CANCEL_LABEL = 'Cancel';
const CONFIRM_LABEL = 'Remove link';
const CONFIRM_BUSY_LABEL = 'Removing…';

interface RemovePublicLinkConfirmDialogProps {
  onCancel: () => void;
  onConfirm: () => void;
  /** True while the removal is in flight. */
  busy?: boolean;
  /** Test-id prefix of the owning share dialog. */
  testIdPrefix: string;
  /** Document that owns the modal portal/focus trap. */
  ownerDocument?: Document;
  /**
   * The team or organization that keeps access once the link goes, named in
   * the body. Absent when removing the link leaves the resource private-only,
   * which also takes it out of shared lists.
   */
  remainingAudience?: RemovePublicLinkRemainingAudience;
  /** A failed removal, shown in the body; the dialog stays open to retry. */
  errorMessage?: string | null;
  /**
   * Traps focus while open and returns it on close. Off for callers whose
   * own dialog already holds the focus trap.
   */
  trapFocus?: boolean;
  /** Where focus returns on close when the trigger is gone. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

export function RemovePublicLinkConfirmDialog({
  onCancel,
  onConfirm,
  busy = false,
  testIdPrefix,
  ownerDocument,
  remainingAudience,
  errorMessage,
  trapFocus = false,
  restoreFocusRef,
}: RemovePublicLinkConfirmDialogProps): JSX.Element {
  const p = testIdPrefix;
  return (
    <DialogModal
      inset="flush"
      onClose={busy ? (): void => {} : onCancel}
      title={TITLE}
      maxWidth="sm"
      closeOnBackdrop={!busy}
      dataTestId={`${p}-remove-public-link-confirm`}
      ownerDocument={ownerDocument}
      trapFocus={trapFocus}
      restoreFocusRef={restoreFocusRef}
    >
      <div className="flex flex-col px-6 py-4 gap-3">
        <p className="text-s fg-secondary">
          {removePublicLinkMessage(remainingAudience)}
        </p>
        <ErrorBanner
          errorSource="remove-public-link-confirm-dialog"
          className=""
          error={errorMessage}
          testId={`${p}-remove-public-link-error`}
        />
      </div>
      <div className="flex justify-end gap-2 border-t px-6 py-3">
        <Button
          type="button"
          variant="secondary"
          size="compact"
          onClick={onCancel}
          disabled={busy}
          data-testid={`${p}-remove-public-link-cancel`}
        >
          {CANCEL_LABEL}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="compact"
          onClick={onConfirm}
          disabled={busy}
          data-testid={`${p}-remove-public-link-confirm-action`}
        >
          {busy ? CONFIRM_BUSY_LABEL : CONFIRM_LABEL}
        </Button>
      </div>
    </DialogModal>
  );
}
