import type { JSX } from 'react';
import { Notice } from '@canopy/ui-shared/components';

/**
 * Review comment threads stored for this worktree that couldn't be read, so
 * the diff doesn't show them (CAN-6667). They stay on disk as they were.
 */
export function SkippedCommentThreadsNotice({
  count,
}: {
  readonly count: number | undefined;
}): JSX.Element | null {
  if (count === undefined || count <= 0) return null;
  return (
    <div className="shrink-0 px-4 pt-3">
      <Notice intent="attention" data-testid="code-review-skipped-threads">
        {count === 1
          ? "1 comment thread couldn't be read, so it isn't shown."
          : `${String(count)} comment threads couldn't be read, so they aren't shown.`}
      </Notice>
    </div>
  );
}
