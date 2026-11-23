import { useEffect, useEffectEvent, useState, type JSX } from 'react';
import { ConfirmDialog } from '@canopy/ui-shared/components';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';

interface ResetToPointDialogProps {
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export function ResetToPointDialog({
  onConfirm,
  onCancel,
}: ResetToPointDialogProps): JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Main already recorded that failure's IPC call, so the dialog does not
  // record it again. Reset with `error`.
  const [errorRecorded, setErrorRecorded] = useState(false);

  const handleConfirm = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setErrorRecorded(false);
    try {
      await onConfirm();
    } catch (err: unknown) {
      setErrorRecorded(
        toAppError(resolveClientAppError(err))?.recordedBy !== undefined,
      );
      setError(err instanceof Error ? err.message : 'Failed to revert turn');
      setSubmitting(false);
    }
  };

  const handleCancel = (): void => {
    if (submitting) {
      return;
    }
    onCancel();
  };

  // Effect Events may only be called from Effects, so the buttons take the
  // plain handlers and only the keydown listener goes through this.
  const handleKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void handleConfirm();
    }
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      handleKeyDown(event);
    };
    window.addEventListener('keydown', handler);
    return (): void => {
      window.removeEventListener('keydown', handler);
    };
    // Escape belongs to the dialog. handleKeyDown is useEffectEvent-stable;
    // React's exhaustive-deps rule does not require it in deps, and listing it
    // would falsely imply the effect should re-register on changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ConfirmDialog
      title="Revert this turn?"
      message="Code changes from this turn onward are rolled back. Chat history is kept."
      confirmLabel="Revert turn"
      busyLabel="Reverting…"
      busy={submitting}
      errorMessage={error}
      {...(errorRecorded
        ? { errorRecordingDisabled: true as const }
        : { errorSource: 'chat-reset-to-point' })}
      destructive
      onConfirm={(): void => {
        void handleConfirm();
      }}
      onCancel={handleCancel}
      dataTestId="reset-to-point-dialog"
      confirmTestId="reset-to-point-confirm-btn"
    />
  );
}
