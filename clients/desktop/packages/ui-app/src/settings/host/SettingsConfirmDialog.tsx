'use client';

import type { JSX, ReactNode, RefObject } from 'react';
import {
  ConfirmDialog,
  type ConfirmDialogErrorProps,
} from '@canopy/ui-shared/components/ConfirmDialog';

interface SettingsConfirmDialogBaseProps {
  readonly title: ReactNode;
  /** Body explaining the consequence of the action. */
  readonly message: ReactNode;
  readonly confirmLabel: string;
  /** Shown on the confirm button while the action runs. */
  readonly busyLabel?: string;
  readonly busy?: boolean;
  /** Destructive (red) confirm styling for irreversible actions. */
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly dataTestId?: string;
  /** Overrides the default confirm-button test id. */
  readonly confirmTestId?: string;
  /** The failure's raw reason: copied by `Copy details`, never shown. */
  readonly errorDetails?: string;
  /**
   * Where focus goes on close when confirming destroys the control that
   * opened this dialog. See `ConfirmDialog.restoreFocusRef`.
   */
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * `errorMessage` is the failed action, shown above the buttons while the
 * dialog stays open.
 */
export type SettingsConfirmDialogProps = SettingsConfirmDialogBaseProps &
  ConfirmDialogErrorProps;

/**
 * The confirmation modal for consequential account and organization actions
 * (leave, remove, revoke, delete). Focus is contained; a destructive one
 * starts on Cancel, so a reflexive Enter backs out instead of committing.
 */
export function SettingsConfirmDialog({
  title,
  message,
  confirmLabel,
  busyLabel,
  busy = false,
  destructive = false,
  onConfirm,
  onCancel,
  dataTestId,
  confirmTestId,
  errorDetails,
  restoreFocusRef,
  ...errorProps
}: SettingsConfirmDialogProps): JSX.Element {
  return (
    <ConfirmDialog
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      busyLabel={busyLabel}
      busy={busy}
      destructive={destructive}
      onConfirm={onConfirm}
      onCancel={onCancel}
      dataTestId={dataTestId}
      confirmTestId={confirmTestId}
      cancelTestId="confirm-dialog-cancel"
      {...errorProps}
      errorDetails={errorDetails}
      restoreFocusRef={restoreFocusRef}
    />
  );
}
