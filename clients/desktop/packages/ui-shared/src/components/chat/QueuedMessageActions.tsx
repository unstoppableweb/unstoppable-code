import { memo, type JSX, type ReactNode } from 'react';
import type {
  ChatTurnPhase,
  QueuedMessageRetryBlockedReason,
  SettingsHeldChange,
} from '@canopy/protocol/remote-control/shell';
import { PlayCircleIcon, RetryIcon, SteerIcon } from '../../icons';
import { StopIcon, TrashIcon } from '../../icons/AppIcons';
import { Tooltip } from '../../primitives/Tooltip';
import { Button } from '../../primitives/Button';
import { MessageEditBadge, type MessageEditHandler } from './MessageEditEntry';
import { QueuedMessageSettingsHeldWarning } from './QueuedMessageSettingsHeldWarning';

export const QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP =
  'This message changes agent capabilities. Interrupt the active turn to send it immediately, or wait for the turn to finish.';
export const QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP_TITLE =
  'Steering unavailable';

/** Why a held row's Retry or Send now is disabled, by host-reported reason. */
export const QUEUED_MESSAGE_RETRY_BLOCKED_TOOLTIPS: Readonly<
  Record<
    QueuedMessageRetryBlockedReason,
    { readonly title: string; readonly description: string }
  >
> = {
  insufficient_credits: {
    title: 'Switch provider to send this',
    description:
      'Your queued message is saved. Try again sends it once a provider can run it.',
  },
};

/**
 * Where the strip renders inside a queued-message bubble:
 * - `corner`: the hover Edit and Clear badges over the bubble surface.
 * - `footer`: the Steer, Interrupt, Retry and Run now pills under the bubble.
 */
export type QueuedMessageActionsPlacement = 'corner' | 'footer';

/**
 * Visual treatment of the corner badges and footer row.
 * - `popover`: text Edit button on a popover chip; the footer does not wrap.
 * - `badge`: icon Edit button on the shared bubble action badge; the footer
 *   wraps on narrow panels.
 */
export type QueuedMessageActionsVariant = 'popover' | 'badge';

export interface QueuedMessageActionsProps {
  readonly placement: QueuedMessageActionsPlacement;
  readonly variant?: QueuedMessageActionsVariant;
  readonly onEdit?: MessageEditHandler;
  readonly onCancel?: () => void;
  /**
   * The chat's turn phase, reported by the host on each queued row. Steer and
   * Interrupt act on a running foreground turn, so they render only in
   * `foreground`. In `idle` or `background` a send goes at once, so neither is
   * offered. `undefined` comes from an older host that reports no phase and
   * keeps the pre-phase behavior (both may render).
   */
  readonly turnPhase?: ChatTurnPhase;
  /** Moves the message into the running turn. Phase-gated. */
  readonly onSteer?: () => void;
  /**
   * Host-authoritative steer eligibility for this row. Defaults to true for
   * hosts that already withhold `onSteer` from ineligible rows. Does not
   * affect the disabled capability-change Steer.
   */
  readonly canSteer?: boolean;
  /** Stops the running turn so the message sends now. Phase-gated. */
  readonly onInterrupt?: () => void;
  /**
   * Re-sends a message whose delivery failed or is uncertain. Renders in any
   * phase, subject to the same head-row locks as Interrupt.
   */
  readonly onRetry?: () => void;
  /**
   * Starts a message that is waiting on something other than a running turn
   * (for example a hook concurrency slot). Renders in any phase, subject to
   * the same head-row locks as Interrupt.
   */
  readonly onRunNow?: () => void;
  /**
   * The host holds this row until something outside the queue changes (for
   * example the account has no AI credits). Retry renders disabled with the
   * reason's explanation, even without `onRetry`; Steer, Interrupt and Run now
   * are withheld. The head-row locks still hide Retry.
   */
  readonly retryBlockedReason?: QueuedMessageRetryBlockedReason;
  /**
   * The chat supports steering. Together with
   * `steerBlockedByCapabilityChange`, shows a disabled Steer that explains why
   * the message cannot be steered.
   */
  readonly steeringSupported?: boolean;
  readonly steerBlockedByCapabilityChange?: boolean;
  /**
   * Settings that wait for live background work (empty when the host did not
   * say which). When present, a warning before Steer and Interrupt names them
   * and says what each action does to this message now.
   */
  readonly settingsHeld?: readonly SettingsHeldChange[];
  /** Hides Edit and Steer. Also hides Interrupt unless `forceLocked` is set. */
  readonly editLocked?: boolean;
  /** Hides Interrupt, Retry and Run now. Defaults to `editLocked`. */
  readonly forceLocked?: boolean;
  /**
   * The message is being sent: hides Edit, Interrupt, Retry and Run now, and
   * disables Clear.
   */
  readonly pending?: boolean;
  /** Another queued message is being edited: hides every action but Clear. */
  readonly anyEditing?: boolean;
  readonly interruptDisabled?: boolean;
  /** Accessible name for the Edit button. */
  readonly editLabel?: string;
  /** Accessible name for the Clear button. */
  readonly cancelLabel?: string;
  /** Host-owned corner controls rendered before Edit (for example Copy). */
  readonly cornerLeading?: ReactNode;
}

/**
 * The queued-message action strip shared by every queued-message bubble.
 * Hosts decide which callbacks a row gets; the strip owns the controls'
 * markup, ordering and visibility rules.
 */
export const QueuedMessageActions = memo(function QueuedMessageActions({
  placement,
  variant = 'popover',
  onEdit,
  onCancel,
  turnPhase,
  onSteer,
  canSteer = true,
  onInterrupt,
  onRetry,
  onRunNow,
  retryBlockedReason,
  steeringSupported = false,
  steerBlockedByCapabilityChange = false,
  settingsHeld,
  editLocked = false,
  forceLocked,
  pending = false,
  anyEditing = false,
  interruptDisabled = false,
  editLabel,
  cancelLabel = 'Clear queued message',
  cornerLeading,
}: QueuedMessageActionsProps): JSX.Element | null {
  if (placement === 'corner') {
    if (cornerLeading == null && !onEdit && !onCancel) return null;
    const showEdit = Boolean(onEdit) && !editLocked && !pending && !anyEditing;
    const isBadge = variant === 'badge';
    return (
      // On touch each 28px Button's hit area reaches 8px past its sides, so
      // `pointer-coarse:gap-4` (16px) lets neighbouring 44px targets meet
      // without overlapping; a fine pointer keeps the 4px gap.
      <div className="absolute -right-2 -top-2 z-10 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:gap-4 pointer-coarse:opacity-100">
        {cornerLeading}
        {showEdit && onEdit && isBadge ? (
          <MessageEditBadge
            testId="queued-message-edit"
            label={editLabel ?? 'Edit queued message'}
            onEdit={onEdit}
          />
        ) : showEdit && onEdit ? (
          <Button
            variant="secondary"
            size="compact"
            data-testid="queued-message-edit"
            onClick={() => void onEdit()}
            aria-label={editLabel}
          >
            Edit
          </Button>
        ) : null}
        {onCancel ? (
          <Button
            variant="secondary"
            size="compact"
            iconOnly
            data-testid="queued-message-cancel"
            disabled={pending}
            onClick={onCancel}
            aria-label={cancelLabel}
          >
            <TrashIcon size="sm" />
          </Button>
        ) : null}
      </div>
    );
  }

  // Steer and Interrupt act on a running foreground turn. A host that reports
  // no phase predates phase reporting and keeps its earlier behavior.
  const turnActionsAllowed =
    turnPhase === undefined || turnPhase === 'foreground';
  // A held row offers only its disabled Retry: every other path would send it.
  const retryBlock =
    retryBlockedReason === undefined
      ? undefined
      : QUEUED_MESSAGE_RETRY_BLOCKED_TOOLTIPS[retryBlockedReason];
  const sendAllowed = retryBlock === undefined;
  const showDisabledSteer = steeringSupported && steerBlockedByCapabilityChange;
  const steerOffered =
    sendAllowed &&
    turnActionsAllowed &&
    ((Boolean(onSteer) && canSteer) || showDisabledSteer) &&
    !editLocked;
  const showSteer = steerOffered && !anyEditing;
  const forceAvailable =
    !(forceLocked ?? editLocked) && !pending && !anyEditing;
  const showInterrupt =
    sendAllowed && turnActionsAllowed && Boolean(onInterrupt) && forceAvailable;
  const showRetry = (!sendAllowed || Boolean(onRetry)) && forceAvailable;
  const showRunNow = sendAllowed && Boolean(onRunNow) && forceAvailable;
  // While another message is being edited, a row that offers Steer keeps its
  // spacing so the queue does not shift as Steer hides.
  if (!steerOffered && !showInterrupt && !showRetry && !showRunNow) {
    return null;
  }
  return (
    <div
      className={
        variant === 'badge'
          ? 'flex flex-wrap justify-end gap-2 pt-1'
          : 'flex justify-end gap-2 pt-1 pointer-coarse:gap-4'
      }
    >
      {settingsHeld && (showSteer || showInterrupt) ? (
        <QueuedMessageSettingsHeldWarning
          changes={settingsHeld}
          steer={showSteer && !showDisabledSteer}
          interrupt={showInterrupt}
        />
      ) : null}
      {showSteer ? (
        <Tooltip
          label={QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP_TITLE}
          description={QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP}
          disabled={!showDisabledSteer}
        >
          <Button
            variant="secondary"
            size="compact"
            onClick={onSteer}
            aria-disabled={showDisabledSteer || undefined}
            aria-description={
              showDisabledSteer
                ? QUEUED_MESSAGE_CAPABILITY_CHANGE_TOOLTIP
                : undefined
            }
            data-testid="queued-message-steer"
          >
            <SteerIcon
              data-testid="queued-message-steer-icon"
              className="-my-1"
            />
            Steer
          </Button>
        </Tooltip>
      ) : null}
      {showInterrupt ? (
        <Button
          variant="secondary"
          size="compact"
          data-testid="queued-message-interrupt"
          onClick={onInterrupt}
          disabled={interruptDisabled}
        >
          <StopIcon
            data-testid="queued-message-interrupt-icon"
            size="sm"
            className="-my-1"
          />
          Interrupt
        </Button>
      ) : null}
      {showRetry ? (
        <Tooltip
          label={retryBlock?.title ?? ''}
          description={retryBlock?.description ?? ''}
          disabled={retryBlock === undefined}
        >
          {/* `aria-disabled` rather than `disabled`, so the held action stays in
              the tab order and its explanation is reachable from the keyboard. */}
          <Button
            variant="secondary"
            size="compact"
            data-testid="queued-message-retry"
            onClick={retryBlock ? undefined : onRetry}
            aria-disabled={retryBlock ? true : undefined}
            aria-description={retryBlock?.description}
          >
            <RetryIcon
              data-testid="queued-message-retry-icon"
              size="sm"
              className="-my-1"
            />
            Try again
          </Button>
        </Tooltip>
      ) : null}
      {showRunNow ? (
        <Button
          variant="secondary"
          size="compact"
          data-testid="queued-message-run-now"
          onClick={onRunNow}
        >
          <PlayCircleIcon
            data-testid="queued-message-run-now-icon"
            size="sm"
            className="-my-1"
          />
          Run now
        </Button>
      ) : null}
    </div>
  );
});
