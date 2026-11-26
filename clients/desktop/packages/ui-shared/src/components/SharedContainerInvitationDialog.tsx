import type { JSX, RefObject } from 'react';
import { DialogModal } from '../primitives/DialogModal';
import { Surface } from '../primitives/Surface';
import { SharedContainerAcceptSummary } from './SharedContainerAcceptSummary';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { Button } from '../primitives/Button';

export const SHARED_CONTAINER_INVITATION_ACCEPT_FAILED =
  "Couldn't accept this share. Try again.";

const TEST_ID = 'shared-container-invitation-dialog';

export interface SharedContainerInvitationDialogProps {
  title: string;
  /** Absent while the owner's name has not resolved. */
  ownerName?: string;
  /** The owner's organization, named for a share from outside the recipient's. */
  organizationName?: string;
  kind: 'code' | 'cowork';
  accepting: boolean;
  removing: boolean;
  /** The last accept failed; the dialog stays open and says so. */
  acceptFailed: boolean;
  onAccept: () => void;
  onRemove: () => void;
  onCancel: () => void;
  /** Where focus goes on close once the invitation's row is gone. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * The decision on a pending share. Opening a share downloads the publisher's
 * files onto this computer, so the invitation row opens this dialog instead
 * of the share: it says what is offered and by whom, then accepts or removes.
 */
export function SharedContainerInvitationDialog({
  title,
  ownerName,
  organizationName,
  kind,
  accepting,
  removing,
  acceptFailed,
  onAccept,
  onRemove,
  onCancel,
  restoreFocusRef,
}: SharedContainerInvitationDialogProps): JSX.Element {
  const busy = accepting || removing;
  // The owner is a person: replay records a box for the name only.
  const subtitle =
    ownerName !== undefined ? (
      <>
        Shared by <span className={REPLAY_BLOCK_CLASS}>{ownerName}</span>
        {organizationName ? ` · ${organizationName}` : null}
      </>
    ) : undefined;
  return (
    <DialogModal
      inset="flush"
      title={<span className={REPLAY_MASK_CLASS}>{title}</span>}
      {...(subtitle ? { subtitle } : {})}
      maxWidth="md"
      trapFocus
      {...(restoreFocusRef ? { restoreFocusRef } : {})}
      onClose={busy ? (): void => {} : onCancel}
      closeOnBackdrop={!busy}
      closeButtonDisabled={busy}
      dataTestId={TEST_ID}
    >
      <div className="flex flex-col gap-4 px-6 py-4">
        <p className="text-s fg-primary" data-testid={`${TEST_ID}-kind`}>
          {kind === 'code' ? 'Code project' : 'Cowork project'}
        </p>
        <SharedContainerAcceptSummary
          testIdPrefix={TEST_ID}
          error={
            acceptFailed ? SHARED_CONTAINER_INVITATION_ACCEPT_FAILED : null
          }
        />
      </div>
      <Surface
        variant="section"
        boundary="top"
        padding="dialog-footer"
        gap="inline"
        direction="row"
        className="items-center"
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          loading={removing}
          loadingLabel="Removing…"
          disabled={accepting}
          data-testid={`${TEST_ID}-remove`}
        >
          Remove share
        </Button>
        <span className="ml-auto flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={onAccept}
            loading={accepting}
            loadingLabel="Opening…"
            disabled={removing}
            data-testid={`${TEST_ID}-accept`}
          >
            Accept and open
          </Button>
        </span>
      </Surface>
    </DialogModal>
  );
}
