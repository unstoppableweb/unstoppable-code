import type { JSX } from 'react';
import type { LedgerStatus } from '@canopy/protocol/canopy-core';
import {
  CheckIcon,
  FailedIcon,
  InfoIcon,
  PauseIcon,
  RaisedHandIcon,
  type AppIcon,
} from '../../icons/AppIcons';
import { LEDGER_STATUS_LABELS } from '../../lib/ledger-display';
import { ledgerStatusPillClassName } from '../../primitives/control-button-shared';
export { ledgerStatusPillClassName } from '../../primitives/control-button-shared';
import { StatusGlyph } from '../../primitives/StatusGlyph';

/**
 * The shared status-badge geometry and the tint a status takes, for the pill
 * and for the control that changes a status in its place.
 */

const STATUS_ICONS: Readonly<
  Record<Exclude<LedgerStatus, 'TODO' | 'IN_PROGRESS'>, AppIcon>
> = {
  COMPLETED: CheckIcon,
  FAILED: FailedIcon,
  BLOCKED: PauseIcon,
  NEEDS_REVIEW: RaisedHandIcon,
  INFO: InfoIcon,
};

export interface LedgerStatusGlyphProps {
  readonly status: LedgerStatus;
}

/**
 * One shape per status, so color is never the only signal: a queued ring for
 * To do, a shared spinner for In progress, then a check, a cross, a pause,
 * a raised hand and the info mark. It takes the surrounding ink. Decorative:
 * the status is always named beside it.
 */
export function LedgerStatusGlyph({
  status,
}: LedgerStatusGlyphProps): JSX.Element {
  if (status === 'TODO' || status === 'IN_PROGRESS') {
    return (
      <span
        data-testid="ledger-status-glyph"
        data-status={status}
        className="inline-flex"
      >
        <StatusGlyph
          state={status === 'TODO' ? 'queued' : 'running'}
          size={12}
        />
      </span>
    );
  }
  const Icon = STATUS_ICONS[status];
  return (
    <Icon
      size="sm"
      aria-hidden="true"
      data-testid="ledger-status-glyph"
      data-status={status}
      className="shrink-0"
    />
  );
}

export interface LedgerStatusPillProps {
  readonly status: LedgerStatus;
  readonly 'data-testid'?: string;
}

/**
 * An entry's status on its row: its glyph and name in a tinted pill.
 *
 * `DESIGN.md` keeps routine values out of badges and pills unless the
 * treatment communicates a specific state that materially improves scanning
 * (Layout). A Ledger entry's status is that state: it is what a person scans
 * the column for, so rows give it the app's status-badge shape and tint.
 */
export function LedgerStatusPill({
  status,
  'data-testid': testId,
}: LedgerStatusPillProps): JSX.Element {
  return (
    <span
      data-testid={testId}
      data-status={status}
      className={ledgerStatusPillClassName(status)}
    >
      <LedgerStatusGlyph status={status} />
      {LEDGER_STATUS_LABELS[status]}
    </span>
  );
}
