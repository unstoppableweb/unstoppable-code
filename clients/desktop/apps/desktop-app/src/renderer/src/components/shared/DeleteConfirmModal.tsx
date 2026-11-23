import { type JSX, type ReactNode } from 'react';
import {
  ConfirmDialog,
  type ConfirmDialogErrorProps,
} from '@canopy/ui-shared/components';

interface DeleteConfirmModalBaseProps {
  title: string;
  /** Body shown above the action buttons. Strings render in muted-foreground. */
  message: ReactNode;
  confirmLabel?: string;
  /** Label shown while the confirm callback is pending. */
  pendingLabel?: string;
  pending?: boolean;
  /**
   * Visual tone of the confirm button. Defaults to `destructive` (red) for the
   * common delete/remove case; use `primary` for non-destructive confirmations
   * (e.g. sign out) so the danger affordance isn't misleading.
   */
  confirmTone?: 'destructive' | 'primary';
  /** Stable test ID placed on the dialog card element. */
  dataTestId?: string;
  /** Stable test ID placed on the confirmation button. */
  confirmTestId?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

type DeleteConfirmModalProps = DeleteConfirmModalBaseProps &
  ConfirmDialogErrorProps;

/**
 * Desktop's delete/remove confirmation props, rendered by the shared
 * `ConfirmDialog` so desktop and web draw one confirmation.
 */
export function DeleteConfirmModal({
  title,
  message,
  confirmLabel = 'Delete',
  pendingLabel = 'Deleting…',
  pending = false,
  confirmTone = 'destructive',
  dataTestId,
  confirmTestId,
  onConfirm,
  onCancel,
  ...errorProps
}: DeleteConfirmModalProps): JSX.Element {
  return (
    <ConfirmDialog
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      busyLabel={pendingLabel}
      busy={pending}
      {...errorProps}
      destructive={confirmTone === 'destructive'}
      dataTestId={dataTestId}
      confirmTestId={confirmTestId}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
