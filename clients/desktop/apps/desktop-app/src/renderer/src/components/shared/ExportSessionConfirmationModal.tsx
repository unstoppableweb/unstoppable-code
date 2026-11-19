import { DialogActionFooter } from '@canopy/ui-shared/components';
import { type JSX } from 'react';
import { Button } from '@/components/shared/Button';
import { DialogModal } from '@/components/shared/DialogModal';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';

interface ExportSessionConfirmationModalProps {
  ownerDocument?: Document;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ExportSessionConfirmationModal({
  ownerDocument,
  onCancel,
  onConfirm,
}: ExportSessionConfirmationModalProps): JSX.Element {
  useCurrentUiStateReporter('chat.exportSessionConfirmationModal', {
    open: true,
  });

  return (
    <DialogModal
      inset="flush"
      title="Secure session snapshot export"
      ownerDocument={ownerDocument}
      onClose={onCancel}
      maxWidth="md"
      dataTestId="export-session-confirmation-modal"
    >
      <div className="flex flex-col px-6 py-4 text-s fg-secondary gap-3">
        <p>
          Create a private, account-scoped snapshot that can be imported from
          another device signed in to the same {brandText.appName} Cloud
          account.
        </p>
        <p>
          The snapshot contains the full, unredacted transcript, provider
          session data, and working changes. It is a one-time snapshot and does
          not stay synchronized with this session.
        </p>
        <p>
          Anyone with access to this account and a compatible project can import
          the snapshot.
        </p>
      </div>
      <DialogActionFooter>
        <Button variant="secondary" size="lg" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="lg"
          onClick={onConfirm}
          data-testid="export-session-confirm"
        >
          Export session
        </Button>
      </DialogActionFooter>
    </DialogModal>
  );
}
