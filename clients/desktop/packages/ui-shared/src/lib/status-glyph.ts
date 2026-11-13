import { OPERATIONAL_STATUS_COLORS } from './operational-status-colors';

/**
 * The status glyph vocabulary: one glyph and one ink per state, the same on
 * every surface. Domains (workflow runs, script runs, subagents) map their
 * raw states onto these through an adapter instead of choosing their own
 * dot, character or icon.
 *
 * Running draws the shared spinner in a neutral ink, the one the sidebar
 * shows for background work, and Cancelled draws its own stop glyph so a
 * cancelled run never reads as finished or failed. The other inks keep the
 * run-state roles (DESIGN.md, Color system): failed is destructive, done is
 * success, merged is special, ready (unread) is info, needs-you is warning
 * and paused is the secondary neutral. No state takes the accent.
 */
export type StatusGlyphState =
  | 'needs-you'
  | 'running'
  | 'queued'
  | 'ready'
  | 'done'
  | 'merged'
  | 'failed'
  | 'paused'
  | 'cancelled';

export const STATUS_GLYPH_STATES = [
  'needs-you',
  'running',
  'queued',
  'ready',
  'done',
  'merged',
  'failed',
  'paused',
  'cancelled',
] as const satisfies readonly StatusGlyphState[];

/** What a state draws. Every icon is a vendored AppIcons glyph. */
export type StatusGlyphShape =
  | 'spinner'
  | 'dot'
  | 'circle-help'
  | 'circle-dashed'
  | 'circle-check'
  | 'git-merge'
  | 'circle-x'
  | 'circle-pause'
  | 'circle-stop';

export interface StatusGlyphSpec {
  readonly shape: StatusGlyphShape;
  /**
   * Ink class for the glyph. Running is empty: the spinner carries its own
   * neutral ink.
   */
  readonly ink: string;
  /** The state's name, for a tooltip or a reader when no label is shown. */
  readonly label: string;
}

export const STATUS_GLYPHS: Readonly<
  Record<StatusGlyphState, StatusGlyphSpec>
> = {
  'needs-you': { shape: 'circle-help', ink: 'fg-warning', label: 'Needs you' },
  running: { shape: 'spinner', ink: '', label: 'Running' },
  queued: { shape: 'circle-dashed', ink: 'fg-tertiary', label: 'Queued' },
  ready: {
    shape: 'dot',
    ink: OPERATIONAL_STATUS_COLORS.unread.foreground,
    label: 'Ready to review',
  },
  done: {
    shape: 'circle-check',
    ink: OPERATIONAL_STATUS_COLORS.success.foreground,
    label: 'Done',
  },
  merged: {
    shape: 'git-merge',
    ink: OPERATIONAL_STATUS_COLORS.merged.foreground,
    label: 'Merged',
  },
  failed: {
    shape: 'circle-x',
    ink: OPERATIONAL_STATUS_COLORS.failed.foreground,
    label: 'Failed',
  },
  paused: {
    shape: 'circle-pause',
    ink: OPERATIONAL_STATUS_COLORS.paused.foreground,
    label: 'Paused',
  },
  cancelled: { shape: 'circle-stop', ink: 'fg-tertiary', label: 'Cancelled' },
};

/**
 * A run status string (script, hook and pipeline runs and their jobs and
 * steps, in either spelling)
 * → its glyph state. Unknown statuses return `null` so a host draws no glyph
 * rather than a guessed one.
 */
export function runStatusGlyphState(
  status: string | undefined,
): StatusGlyphState | null {
  switch (status) {
    case 'pending':
    case 'queued':
    // Held for memory until it starts (CAN-6325).
    case 'waiting_for_capacity':
      return 'queued';
    case 'running':
    case 'restarting':
    // Still running until the stop lands.
    case 'stopping':
      return 'running';
    case 'paused':
      return 'paused';
    case 'success':
    case 'succeeded':
    case 'completed':
      return 'done';
    case 'failure':
    case 'failed':
    case 'timed_out':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    // A skipped job or run never ran; it ends without an outcome, like a
    // cancelled one.
    case 'skipped':
      return 'cancelled';
    default:
      return null;
  }
}
