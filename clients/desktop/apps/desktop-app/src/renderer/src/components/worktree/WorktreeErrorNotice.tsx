import { useEffect, useState, type JSX } from 'react';
import {
  NotificationDetailsDialog,
  summarizeCommandFailure,
} from '@canopy/ui-shared';
import { inlineFailureText } from '@/lib/inline-app-error';
import { showsRawErrorDetail } from '@canopy/protocol/app-errors';
import {
  presentRendererAppError,
  rendererAppErrorDisplayPolicy,
} from '@/lib/renderer-app-error';
import { useProjectsStore } from '@/stores/projectsStore';
import { pinToast, unpinToast } from '@/stores/toastStore';

const TOAST_ID = 'worktree-error';

/**
 * The last worktree create, repair, join, archive or delete failure, as an
 * error card in the window's toast stack (mounted once, in the main frame).
 * It stays until it is closed or the next worktree action clears it. A failed
 * git command can print kilobytes of progress, so the card shows only the
 * command's first line and its cause; Show details opens the full output in a
 * scrolling dialog.
 */
export function WorktreeErrorNotice(): JSX.Element | null {
  const worktreeError = useProjectsStore((state) => state.worktreeError);
  const clearWorktreeError = useProjectsStore(
    (state) => state.clearWorktreeError,
  );
  // The dialog keeps its own copy, so it outlives the card it was opened
  // from (Show details closes the card, as any toast action does).
  const [openDetails, setOpenDetails] = useState<string | null>(null);

  const message = inlineFailureText(worktreeError) ?? '';
  const details = worktreeError?.details;
  const { truncated } = summarizeCommandFailure(details ?? message);
  const canShowDetails =
    truncated && showsRawErrorDetail(rendererAppErrorDisplayPolicy);
  const fullText = details ?? message;
  // A structured error keeps its recovery guidance: the title heads the card
  // and the description is its message, as the inline banner showed them.
  const copy =
    worktreeError === null || typeof worktreeError.error === 'string'
      ? null
      : presentRendererAppError(worktreeError.error).copy;
  const title = copy?.description ? copy.title : undefined;
  const cardMessage = copy?.description ?? message;

  useEffect(() => {
    if (worktreeError === null || message === '') {
      unpinToast(TOAST_ID);
      return;
    }
    pinToast({
      id: TOAST_ID,
      type: 'error',
      message: cardMessage,
      testId: 'worktree-error-notice',
      ...(typeof worktreeError.error === 'string'
        ? {}
        : { reference: worktreeError.error }),
      // Command output can name paths and branches.
      meta: {
        ...(title === undefined ? {} : { title }),
        blockMessageFromReplay: true,
        // The raw reason is copied on request, never rendered, unless the
        // display policy lets Show details open it.
        ...(details !== undefined && !canShowDetails
          ? { copyDetails: details }
          : {}),
        ...(canShowDetails
          ? {
              action: {
                label: 'Show details',
                testId: 'worktree-error-details',
                onClick: (): void => setOpenDetails(fullText),
              },
            }
          : {}),
      },
      onDismiss: clearWorktreeError,
    });
  }, [
    worktreeError,
    message,
    title,
    cardMessage,
    details,
    fullText,
    canShowDetails,
    clearWorktreeError,
  ]);

  useEffect(() => (): void => unpinToast(TOAST_ID), []);

  return openDetails === null ? null : (
    <NotificationDetailsDialog
      title="Worktree error"
      titleId="worktree-error-details-title"
      message={openDetails}
      onClose={(): void => setOpenDetails(null)}
      blockFromReplay
      dataTestId="worktree-error-details-dialog"
      trapFocus
    />
  );
}
