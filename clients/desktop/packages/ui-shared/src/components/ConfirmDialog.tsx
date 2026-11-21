'use client';

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  DIALOG_CONFIRM_CHORD,
  DISMISS_CHORD,
  formatChord,
} from '../lib/shortcut-platform';
import { Button } from './Button';
import { CopyDetailsButton } from './CopyDetailsButton';
import { DialogModal } from './DialogModal';
import { LoadingSpinner } from './LoadingSpinner';
import { Stack } from './Stack';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { useNoticeErrorRecording } from './notice-error-recording';

/** The second option of a two-way choice, such as Discard beside Save. */
export interface ConfirmDialogSecondaryAction {
  readonly label: string;
  readonly onSelect: () => void;
  readonly testId?: string;
}

interface ConfirmDialogBaseProps {
  /**
   * A question that names the object (`Delete worktree “owl”?`). A node, so a
   * caller can mask a user-authored name for session replay.
   */
  readonly title: ReactNode;
  /** One sentence about what is lost or what happens next. */
  readonly message: ReactNode;
  /** Repeats the verb and noun from the title (`Delete worktree`), never Yes. */
  readonly confirmLabel: string;
  readonly busyLabel?: string;
  /**
   * The action is running: the spinner sits inside the action, which keeps
   * its width, and the dialog stays open and cannot be dismissed until the
   * caller clears it.
   */
  readonly busy?: boolean;
  /**
   * The failure's raw reason (a server's text). Never rendered: it adds a
   * `Copy details` action under `errorMessage` that copies it for support.
   */
  readonly errorDetails?: string;
  /**
   * Something is lost for good. The action takes the destructive role and
   * the dialog has no default button: focus starts on Cancel, so Enter can't
   * commit by accident. Otherwise the action is the primary default button
   * and focus starts on it, so Enter presses it.
   */
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  /** The action cannot run right now (its reason is in the sentence). */
  readonly confirmDisabled?: boolean;
  /** Overrides the default confirm-button test id for multi-instance isolation. */
  readonly confirmTestId?: string;
  readonly onCancel: () => void;
  readonly dataTestId?: string;
  /** Overrides the default cancel-button test id. */
  readonly cancelTestId?: string;
  /**
   * The other answer of a two-way choice (Discard beside Save changes). It
   * sits beside the action, Cancel moves to the left on its own, and the
   * card widens to fit three buttons.
   */
  readonly secondaryAction?: ConfirmDialogSecondaryAction;
  /**
   * One optional control between the sentence and the buttons, such as the
   * switch that keeps a worktree's local branch.
   */
  readonly children?: ReactNode;
  /**
   * Start focus on Cancel even though the action is not destructive. Use
   * sparingly: a non-destructive confirmation normally lets Enter press its
   * default button.
   */
  readonly focusCancel?: boolean;
  /**
   * Where focus goes on close when confirming destroys the control that
   * opened this dialog (revoking a key, removing a member). Point it at a
   * stable ancestor so keyboard users resume somewhere meaningful.
   */
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
  /**
   * The document of the window the dialog opens in (default: the global
   * document). Pass a popped-out window's document so the dialog opens and
   * listens for Escape there, instead of wrapping it in `createPortal`.
   */
  readonly ownerDocument?: Document;
}

/**
 * Failure text for a confirm handler that rejected. Rendering it keeps the
 * dialog open so the action can be retried, instead of dismissing on a
 * failure the user never saw. Showing it records a sighting when it names the
 * operation with `errorSource` (a static kebab-case name);
 * `errorRecordingDisabled` is for text that is a precondition, not a failure.
 */
export type ConfirmDialogErrorProps =
  // Temporary: un-annotated callers show the text and record nothing. Remove
  // this branch once every caller names `errorSource` or disables recording.
  | {
      errorMessage?: string | null | undefined;
      errorSource?: undefined;
      errorRecordingDisabled?: undefined;
    }
  | {
      errorMessage: string | null | undefined;
      errorSource: string;
      errorRecordingDisabled?: never;
    }
  | {
      errorMessage: string | null | undefined;
      errorSource?: never;
      errorRecordingDisabled: true;
    };

export type ConfirmDialogProps = ConfirmDialogBaseProps &
  ConfirmDialogErrorProps;

/**
 * The one confirmation shape shared by desktop and web: a compact 380px card
 * (400px with three buttons), a question naming the object, one sentence,
 * then Cancel and the action as capsules. No header rule and no close button:
 * Cancel and Escape close it, except while the action is busy. Focus is
 * contained while open and returns to the control that opened it.
 *
 * The keys sit inside their buttons: Cancel carries `esc`, and the default
 * action carries `↵` because focus starts on it. A destructive dialog has no
 * default, so its action carries no key.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busyLabel,
  busy = false,
  errorMessage,
  errorSource,
  errorRecordingDisabled,
  errorDetails,
  destructive = false,
  onConfirm,
  confirmDisabled = false,
  onCancel,
  dataTestId,
  confirmTestId = 'confirm-dialog-confirm',
  cancelTestId = 'confirm-dialog-cancel',
  secondaryAction,
  children,
  focusCancel = false,
  restoreFocusRef,
  ownerDocument,
}: ConfirmDialogProps): JSX.Element {
  const messageId = useId();
  const errorRef = useNoticeErrorRecording({
    enabled:
      !!errorMessage && !errorRecordingDisabled && errorSource !== undefined,
    chokePoint: 'notice',
    identifier: errorSource,
    textKey: errorMessage ?? '',
    displayErrorCode: undefined,
  });
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const restingWidth = useRef<number | null>(null);
  const [busyMinWidth, setBusyMinWidth] = useState<number | null>(null);

  // Keep the action's width while it spins: measure it at rest, then hold
  // that width as a minimum while busy so the footer does not jump.
  useLayoutEffect(() => {
    if (!busy) {
      restingWidth.current = confirmRef.current?.offsetWidth ?? null;
      setBusyMinWidth(null);
      return;
    }
    setBusyMinWidth(restingWidth.current);
  }, [busy, confirmLabel]);

  // A disabled default cannot take focus, so Cancel does.
  const startOnCancel = destructive || focusCancel || confirmDisabled;
  const confirmIsDefault = !startOnCancel && !busy;
  return (
    <DialogModal
      variant={secondaryAction ? 'confirm-wide' : 'confirm'}
      onClose={busy ? (): void => undefined : onCancel}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      title={title}
      ariaDescribedBy={messageId}
      dataTestId={dataTestId}
      trapFocus
      initialFocusRef={startOnCancel ? cancelRef : confirmRef}
      restoreFocusRef={restoreFocusRef}
      ownerDocument={ownerDocument}
    >
      <div className="flex flex-col gap-4.5 pt-1">
        <Stack gap="item">
          <div id={messageId} className="text-s text-pretty fg-secondary">
            {message}
          </div>
          {children ? <div>{children}</div> : null}
          {errorMessage && (
            <Stack gap="inline">
              <div
                ref={errorRef}
                role="alert"
                data-testid="confirm-dialog-error"
                className={`text-s text-pretty fg-destructive ${REPLAY_BLOCK_CLASS}`}
              >
                {errorMessage}
              </div>
              {errorDetails ? (
                <div>
                  <CopyDetailsButton details={errorDetails} />
                </div>
              ) : null}
            </Stack>
          )}
        </Stack>
        {/* Wraps instead of clipping when a long action label and a
            secondary action outgrow the card (CAN-5336). */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            ref={cancelRef}
            variant="secondary"
            size="compact"
            onClick={onCancel}
            disabled={busy}
            className={secondaryAction ? 'mr-auto' : undefined}
            shortcut={formatChord(DISMISS_CHORD)}
            data-testid={cancelTestId}
          >
            Cancel
          </Button>
          {secondaryAction ? (
            <Button
              variant="secondary"
              size="compact"
              onClick={secondaryAction.onSelect}
              disabled={busy}
              data-testid={secondaryAction.testId}
            >
              {secondaryAction.label}
            </Button>
          ) : null}
          <Button
            ref={confirmRef}
            variant={destructive ? 'destructive' : 'primary'}
            size="compact"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
            // The spinner is `decorative` (aria-hidden), and a caller that
            // passes no `busyLabel` leaves the label unchanged — so without
            // this a screen-reader user would get no signal that work started
            // beyond the button going disabled.
            aria-busy={busy}
            shortcut={
              confirmIsDefault ? formatChord(DIALOG_CONFIRM_CHORD) : undefined
            }
            style={
              busy && busyMinWidth !== null
                ? { minWidth: busyMinWidth }
                : undefined
            }
            data-testid={confirmTestId}
          >
            {/* CAN-2349 decision 5: every async step reports progress with a
                spinner, never a bare label swap. The spinner renders INSIDE the
                button that started the work, leading the label, so the
                affordance the user pressed is the thing that reports progress. */}
            {busy && (
              <LoadingSpinner
                className="shrink-0"
                dataTestId="confirm-dialog-spinner"
                decorative
              />
            )}
            {busy && busyLabel ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
