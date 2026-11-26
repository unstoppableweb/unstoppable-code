import type { JSX } from 'react';
import { Dot, type DotTone } from '../primitives/Badge';
import { BADGE_HOVER_CARD_SURFACE } from './ChatPreviewPopover';
import { RichHoverCard } from '../primitives/RichHoverTooltip';
import { Stack } from '../primitives/Stack';
import type { WorktreeTerminalStatus } from './WorktreeRow';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

function terminalStatusDisplayLabel(status: WorktreeTerminalStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'unseen-failure':
      return 'Failed';
    case 'unseen':
      return 'Completed';
  }
}

export interface TerminalPopoverRow {
  terminalId: string;
  label: string;
  /** Status text rendered on the right of the row. */
  statusText: string;
  /** Tailwind text-* class applied to `statusText`. */
  statusClass: string;
  /** The leading dot's tone. */
  dotTone: DotTone;
}

export interface TerminalStatusPopoverProps {
  anchorRect: DOMRect;
  rows: TerminalPopoverRow[];
  status: WorktreeTerminalStatus;
  /** Lets the badge that opened it name it in `aria-describedby`. */
  id?: string;
}

export function TerminalStatusPopover({
  anchorRect,
  rows,
  status,
  id,
}: TerminalStatusPopoverProps): JSX.Element | null {
  const statusLabel = terminalStatusDisplayLabel(status);

  return (
    <RichHoverCard
      anchorRect={anchorRect}
      id={id}
      role="tooltip"
      dataTestId="terminal-status-popover"
      {...BADGE_HOVER_CARD_SURFACE}
      surfaceClassName="min-w-40 max-w-65"
    >
      <Stack gap="tight">
        <div className="text-3xs font-semibold fg-secondary">
          Terminals {statusLabel}
        </div>
        {rows.length === 0 ? (
          <div className="text-xs fg-secondary">No terminal details</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <div
                key={row.terminalId}
                data-testid="terminal-status-popover-row"
                data-terminal-id={row.terminalId}
              >
                <div className="flex items-center gap-1.5 text-xs">
                  <Dot tone={row.dotTone} />
                  {/* The label can be a user-assigned terminal or group name. */}
                  <span
                    className={`truncate fg-primary ${REPLAY_MASK_CLASS}`}
                    title={row.label}
                  >
                    {row.label}
                  </span>
                  <span className={`ml-auto shrink-0 ${row.statusClass}`}>
                    {row.statusText}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Stack>
    </RichHoverCard>
  );
}
