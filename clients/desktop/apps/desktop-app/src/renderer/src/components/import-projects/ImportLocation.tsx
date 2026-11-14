import type { JSX, ReactNode } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { shortLocation } from './importProjectsCopy';

/**
 * A row's folder, home-relative on one line, in mono like any path. A long
 * path gives way in the middle: the parent folders truncate and the folder's
 * own name stays whole. The full path is in the native title, the one tooltip
 * truncated plain text keeps. An optional suffix (the first-run page's age)
 * follows the path.
 */
export function ImportLocation({
  rootPath,
  suffix,
  className,
  dataTestId,
}: {
  rootPath: string;
  suffix?: ReactNode;
  /** Placement and text colour only; the location owns its layout. */
  className?: string;
  dataTestId?: string;
}): JSX.Element {
  const shown = shortLocation(rootPath);
  const split = Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\')) + 1;
  const base = 'flex min-w-0 items-baseline gap-1.5 whitespace-nowrap';
  return (
    <span
      className={className ? `${base} ${className}` : base}
      data-testid={dataTestId}
    >
      {/* A path names the account folder, so replay blocks it. */}
      <span
        className={`flex min-w-0 font-mono ${POSTHOG_REPLAY_BLOCK_CLASS}`}
        title={rootPath}
      >
        <span className="min-w-0 truncate">{shown.slice(0, split)}</span>
        <span className="min-w-0 max-w-full shrink-0 truncate">
          {shown.slice(split)}
        </span>
      </span>
      {suffix}
    </span>
  );
}
