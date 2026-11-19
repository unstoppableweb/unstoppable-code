import { useCallback, type JSX, type ReactNode } from 'react';
import type { AppError } from '@canopy/protocol/app-errors';
import { PullRequestActionError } from '@canopy/ui-app/pull-requests';
import { DesktopReportThisAction } from '@/components/shared/DesktopReportThisAction';
import { brandText } from '@/lib/brand';
import { rendererAppErrorDisplayPolicy } from '@/lib/renderer-app-error';
import { useGitHubStore, worktreeKey } from '@/stores/githubStore';

function renderReportAction(error: AppError): ReactNode {
  return <DesktopReportThisAction error={error} appName={brandText.appName} />;
}

/**
 * The worktree's latest failed git or pull request action, under its top bar.
 * The failure belongs to the worktree it started in, so it is still here
 * after navigating away and back. Running the action again replaces the
 * failure, so the banner needs no busy state of its own.
 */
export function WorktreeGitActionError({
  projectId,
  worktreeId,
}: {
  projectId: string;
  worktreeId: string;
}): JSX.Element | null {
  const key = worktreeKey(projectId, worktreeId);
  const failure = useGitHubStore((state) => state.gitActionFailures[key]);
  // A failure can show while its attempt is still finishing; retrying then
  // would race it, so the retry waits until the worktree is idle.
  const busy = useGitHubStore(
    (state) =>
      state.committingAndPushing.has(key) ||
      state.creatingPr.has(key) ||
      state.mergingPr.has(key) ||
      state.mergingLocalBranches.has(key),
  );
  const dismiss = useGitHubStore((state) => state.dismissGitActionFailure);
  const seq = failure?.seq;
  const onDismiss = useCallback((): void => {
    if (seq !== undefined) dismiss(projectId, worktreeId, seq);
  }, [dismiss, projectId, worktreeId, seq]);
  if (!failure) return null;
  return (
    <PullRequestActionError
      key={failure.seq}
      error={failure.error}
      {...(failure.details === undefined ? {} : { details: failure.details })}
      {...(failure.errorRecordingDisabled
        ? { errorRecordingDisabled: true }
        : {})}
      onDismiss={onDismiss}
      {...(failure.retry && !busy
        ? { onRetry: failure.retry, onStartOver: failure.retry }
        : {})}
      displayPolicy={rendererAppErrorDisplayPolicy}
      renderReportAction={renderReportAction}
    />
  );
}
