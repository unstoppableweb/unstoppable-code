import type { JSX } from 'react';
import type { SubagentStatus } from '@canopy/agent-transcript';
import { OPERATIONAL_STATUS_COLORS } from '../../../../lib/operational-status-colors';
import type { StatusGlyphState } from '../../../../lib/status-glyph';
import {
  StatusGlyph,
  type StatusGlyphSize,
} from '../../../../primitives/StatusGlyph';

const STATUS_INK: Readonly<Record<SubagentStatus, string>> = {
  // Running reads in the neutral ink of its spinner, never the info blue.
  running: 'fg-secondary',
  starting: 'fg-secondary',
  queued: OPERATIONAL_STATUS_COLORS.paused.foreground,
  approval: 'fg-warning',
  idle: 'fg-tertiary',
  completed: OPERATIONAL_STATUS_COLORS.success.foreground,
  interrupted: 'fg-tertiary',
  failed: OPERATIONAL_STATUS_COLORS.failed.foreground,
  cancelled: 'fg-tertiary',
  'stopped-by-parent': 'fg-tertiary',
};

/** The text color class for a status, paired with its label. */
export function subagentStatusInk(status: SubagentStatus): string {
  return STATUS_INK[status];
}

const GLYPH_STATE: Readonly<Record<SubagentStatus, StatusGlyphState>> = {
  running: 'running',
  starting: 'running',
  queued: 'queued',
  approval: 'needs-you',
  // An idle teammate is parked until it is messaged again.
  idle: 'paused',
  completed: 'done',
  failed: 'failed',
  // Every way a subagent stops before finishing reads as Cancelled.
  interrupted: 'cancelled',
  cancelled: 'cancelled',
  'stopped-by-parent': 'cancelled',
};

/** A subagent status → the shared status glyph state. */
export function subagentStatusGlyphState(
  status: SubagentStatus,
): StatusGlyphState {
  return GLYPH_STATE[status];
}

function glyphSize(size: number): StatusGlyphSize {
  if (size <= 12) return 12;
  return size <= 16 ? 14 : 20;
}

export interface SubagentStatusGlyphProps {
  readonly status: SubagentStatus;
  /**
   * Glyph size in pixels, drawn at the status glyph box it falls in: 12
   * and below are the dense 12px box, up to 16 the compact 14px tier, and
   * larger the regular 20px tier. Defaults to 12.
   */
  readonly size?: number;
  /**
   * The running spinner's box, when it must match a smaller spinner beside
   * it (the sidebar row's 10px grid). Defaults to `size`.
   */
  readonly spinnerSize?: number;
}

/**
 * The shared status glyph for a subagent, always paired with the status
 * label where space allows. The spinner is reserved for work that is
 * actually running.
 */
export function SubagentStatusGlyph({
  status,
  size = 12,
  spinnerSize = size,
}: SubagentStatusGlyphProps): JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      data-status={status}
    >
      <StatusGlyph
        state={GLYPH_STATE[status]}
        size={glyphSize(size)}
        spinnerSize={spinnerSize}
      />
    </span>
  );
}
