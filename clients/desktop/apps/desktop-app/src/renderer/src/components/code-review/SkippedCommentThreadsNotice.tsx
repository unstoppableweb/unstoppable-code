import type { JSX } from 'react';
import { Notice } from '@canopy/ui-shared/components';

/**
 * Review comment threads stored for this worktree that couldn't be read, so
 * the diff doesn't show them (CAN-6667). They stay on disk as they were.
 * Generated annotations the review left out, because they couldn't be read
 * or name a path outside the repository, are counted the same way (CAN-4167).
 */
export function SkippedCommentThreadsNotice({
  count,
  annotationCount,
}: {
  readonly count: number | undefined;
  readonly annotationCount?: number | undefined;
}): JSX.Element | null {
  const threads = count !== undefined && count > 0 ? count : 0;
  const annotations =
    annotationCount !== undefined && annotationCount > 0 ? annotationCount : 0;
  if (threads === 0 && annotations === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2 px-4 pt-3">
      {threads > 0 ? (
        <Notice intent="attention" data-testid="code-review-skipped-threads">
          {threads === 1
            ? "1 comment thread couldn't be read, so it isn't shown."
            : `${String(threads)} comment threads couldn't be read, so they aren't shown.`}
        </Notice>
      ) : null}
      {annotations > 0 ? (
        <Notice
          intent="attention"
          data-testid="code-review-skipped-annotations"
        >
          {annotations === 1
            ? "1 annotation was left out because it couldn't be read or points outside this repository."
            : `${String(annotations)} annotations were left out because they couldn't be read or point outside this repository.`}
        </Notice>
      ) : null}
    </div>
  );
}
