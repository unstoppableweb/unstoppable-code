import type { JSX } from 'react';
import { ErrorBanner, Notice } from '@canopy/ui-shared/components';

export function ReviewCommentsNotice({
  error,
  hasUnsavedChanges,
}: {
  error: string | null;
  hasUnsavedChanges: boolean;
}): JSX.Element | null {
  if (!error) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2 px-2 py-2">
      <ErrorBanner
        error={error}
        errorSource="code-review-comments"
        testId="code-review-comments-error"
      />
      {hasUnsavedChanges && (
        <Notice
          intent="attention"
          role="none"
          data-testid="code-review-comments-unsaved"
        >
          {/* The error explains repair; this notice protects unsaved input.
              IPC may fail after replacement, so do not claim the write failed. */}
          Couldn&apos;t confirm your comments were saved. Copy your changes
          before closing this panel.
        </Notice>
      )}
    </div>
  );
}
