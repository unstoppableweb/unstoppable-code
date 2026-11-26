import { ControlButton } from '@canopy/ui-shared/components';
import { ScheduledSendCapsule } from '@canopy/ui-shared/components/chat';
import type { JSX } from 'react';
import {
  CloseMediumIcon,
  ScheduleIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { HoverCard } from '@canopy/ui-shared/components';
import {
  formatScheduledSendCompactLabel,
  formatScheduledSendFullLabel,
  formatScheduledSendLabel,
} from '@/lib/scheduledSendLabel';

export interface ScheduledSendChipProps {
  /** When the draft is due (ISO). */
  readonly runAt: string;
  /** Why the last attempt to schedule it failed, if it did. */
  readonly error: string | null;
  /** The chat's harness can schedule; otherwise the chip only clears. */
  readonly editable: boolean;
  /**
   * A narrow box: the time alone today or tomorrow, else the day, and a
   * failure as the glyph alone. The tooltip keeps the full moment.
   */
  readonly compact?: boolean;
  readonly onEdit: () => void;
  readonly onClear: () => void;
  /** For tests and galleries; defaults to the current time. */
  readonly now?: Date;
}

/**
 * The scheduled send beside +, in the Plan chip's shape: the time it goes
 * out (click to change it) and a clear. A failed attempt turns the chip red
 * and names the problem, with the reason in its tooltip, so the box never
 * grows a line for it.
 */
export function ScheduledSendControl({
  runAt,
  error,
  editable,
  compact = false,
  onEdit,
  onClear,
  now,
}: ScheduledSendChipProps): JSX.Element {
  const date = new Date(runAt);
  const tooltip =
    error ??
    (editable
      ? `Sends ${formatScheduledSendFullLabel(date)}. Click to change.`
      : 'Clear this schedule to send with Cursor');
  return (
    <ScheduledSendCapsule failed={error !== null}>
      <HoverCard
        surfaceClassName="w-max max-w-72"
        surfacePadding="relaxed"
        content={<span className="text-xs fg-primary">{tooltip}</span>}
      >
        <ControlButton
          type="button"
          onClick={onEdit}
          disabled={!editable}
          data-testid="chat-input-scheduled-send-pill"
          aria-label={
            error === null
              ? `Scheduled send, ${formatScheduledSendFullLabel(date)}`
              : `Scheduled send failed: ${error}`
          }
          presentation="scheduled-send-edit"
        >
          <ScheduleIcon size="sm" className="shrink-0" />
          {error !== null
            ? compact
              ? null
              : "Couldn't schedule"
            : compact
              ? formatScheduledSendCompactLabel(date, now)
              : formatScheduledSendLabel(date, now)}
        </ControlButton>
      </HoverCard>
      <ControlButton
        type="button"
        onClick={onClear}
        aria-label="Clear scheduled send"
        data-testid="chat-input-scheduled-send-clear"
        presentation="scheduled-send-clear"
      >
        <CloseMediumIcon size="sm" aria-hidden />
      </ControlButton>
    </ScheduledSendCapsule>
  );
}
