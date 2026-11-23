import type { JSX } from 'react';
import {
  ConfirmDialog,
  workEntryRowTestId,
  type WorkEntryRowPinnedSurface,
} from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  getWorkEntryRemovalLabels,
  type WorkEntryRemovalMode,
} from '@canopy/ui-app/sidebar';

export interface WorkEntryRemovalConfirmDialogProps {
  readonly mode: WorkEntryRemovalMode;
  /** The chat's title, named in the question (masked in session replay). */
  readonly entryTitle: string;
  readonly retentionDays: number;
  /** The row's test id; the dialog and its confirm derive theirs from it. */
  readonly rowTestId: string;
  readonly pinnedSurface?: WorkEntryRowPinnedSurface;
  /**
   * The removal is running: the spinner sits inside the action and the
   * dialog cannot be dismissed until it settles.
   */
  readonly busy: boolean;
  /** Why the entry cannot be removed right now; shown and blocks confirm. */
  readonly blockedReason?: string;
  /** Holds the confirm while the host re-checks live work. */
  readonly confirmDisabled?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/**
 * The single Work Entry's Archive or Delete confirm, shared by the sidebar's
 * Chats rows and the App Advisor nav, in the shared confirmation shape.
 */
export function WorkEntryRemovalConfirmDialog({
  mode,
  entryTitle,
  retentionDays,
  rowTestId,
  pinnedSurface,
  busy,
  blockedReason,
  confirmDisabled = false,
  onCancel,
  onConfirm,
}: WorkEntryRemovalConfirmDialogProps): JSX.Element {
  const labels = getWorkEntryRemovalLabels(mode, retentionDays);
  return (
    <ConfirmDialog
      // The chat title is user-authored, so it is masked in replay.
      title={
        <>
          {mode === 'archive' ? 'Archive' : 'Delete'} “
          <span className={POSTHOG_REPLAY_MASK_CLASS}>{entryTitle}</span>”?
        </>
      }
      message={labels.dialogBody}
      confirmLabel={labels.dialogConfirmLabel}
      busyLabel={mode === 'archive' ? 'Archiving…' : 'Deleting…'}
      busy={busy}
      destructive={labels.dialogDestructive}
      confirmDisabled={confirmDisabled || blockedReason !== undefined}
      onConfirm={onConfirm}
      onCancel={onCancel}
      // `blockedReason` is a precondition that disables Confirm, not a failure.
      errorMessage={blockedReason}
      errorRecordingDisabled
      dataTestId={`${rowTestId}-delete-dialog`}
      confirmTestId={workEntryRowTestId(
        rowTestId,
        '-confirm-delete',
        pinnedSurface,
      )}
    />
  );
}
