import type { JSX, ReactNode } from 'react';
import { badgeClassName, type BadgeTone } from '../lib/badge';

/**
 * Historical ink names for the label. `quaternary`, `tertiary` and
 * `secondary` are quiet markers (Private, Archived, View only, an import's
 * provider) and render the neutral badge; `warning` and `warning-strong` flag
 * a marker the user should act on (Unavailable, an expired sign-in) and
 * render the warning badge.
 */
export type StatusPillTone =
  | 'quaternary'
  | 'tertiary'
  | 'secondary'
  | 'warning'
  | 'warning-strong';

const BADGE_TONE: Record<StatusPillTone, BadgeTone> = {
  quaternary: 'neutral',
  tertiary: 'neutral',
  secondary: 'neutral',
  warning: 'warning',
  'warning-strong': 'warning',
};

export interface StatusPillProps {
  /** The pill label. Kept as a node so a marker can pair an icon with text. */
  children: ReactNode;
  tone?: StatusPillTone;
  /**
   * Placement classes appended after the shared badge geometry and tone. Do
   * not use it to restate the geometry or the ink.
   */
  className?: string;
  'data-testid'?: string;
}

/**
 * A status marker on the shared 18px badge capsule ({@link badgeClassName}).
 * Kept for its callers' tone names; new markers use `Badge` directly.
 *
 * Presentation only: it renders exactly one `<span>` and adds no behavior.
 */
export function StatusPill({
  children,
  tone = 'quaternary',
  className,
  'data-testid': testId,
}: StatusPillProps): JSX.Element {
  const pillClassName = badgeClassName(BADGE_TONE[tone]);
  return (
    <span
      data-testid={testId}
      className={className ? `${pillClassName} ${className}` : pillClassName}
    >
      {children}
    </span>
  );
}
