import type { JSX } from 'react';
import type {
  SubagentWorktreeFile,
  SubagentWorktreeSummaryState,
} from '../types';
import { Button } from '../../../Button';
import { FileChangeMetadata } from '../../../FileChangeMetadata';
import { ErrorBanner } from '../../../StatusBlocks';
import { GitCommitIcon } from '../../../../icons/AppIcons';
import {
  SUBAGENT_SHOW_CHANGES_LABEL,
  SUBAGENT_WORKTREE_APPLIED,
  SUBAGENT_WORKTREE_CHECKOUT,
  SUBAGENT_WORKTREE_CHANGES,
  SUBAGENT_WORKTREE_FAILED_LABEL,
  SUBAGENT_WORKTREE_HISTORY,
  SUBAGENT_WORKTREE_LOADING_LABEL,
  SUBAGENT_WORKTREE_NO_UNCOMMITTED_NOTE,
  SUBAGENT_WORKTREE_STARTED_FROM,
  SUBAGENTS_RETRY_LABEL,
  SUBAGENT_WORKTREE_UNAVAILABLE_LABEL,
  subagentApplyStateLabel,
  subagentCheckoutLabel,
  subagentFailureWithReason,
  subagentFilesCountLabel,
  subagentHistoryLabel,
  subagentStartingBranchLabel,
  subagentTopFilesShownLabel,
} from '../subagent-copy';
import { SubagentChangesLabel } from '../common/SubagentChangesLabel';
import { Fact, FactList } from '../../../FactList';

export interface SubagentWorktreeDetailsProps {
  readonly state: SubagentWorktreeSummaryState;
  readonly onShowChanges?: () => void;
}

function FileRow({
  file,
}: {
  readonly file: SubagentWorktreeFile;
}): JSX.Element {
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs">
      <span
        className="min-w-0 flex-1 truncate font-mono fg-secondary"
        title={file.path}
      >
        {file.path}
      </span>
      <FileChangeMetadata
        status={file.status}
        insertions={file.additions}
        deletions={file.deletions > 0 ? file.deletions : undefined}
      />
    </li>
  );
}

/** Display one isolated delegate's worktree state and summary. */
export function SubagentWorktreeDetails({
  state,
  onShowChanges,
}: SubagentWorktreeDetailsProps): JSX.Element {
  if (state.status === 'loading') {
    return (
      <p className="text-xs fg-secondary" role="status">
        {SUBAGENT_WORKTREE_LOADING_LABEL}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <ErrorBanner
        errorSource="subagent-worktree-details"
        className=""
        error={subagentFailureWithReason(
          SUBAGENT_WORKTREE_FAILED_LABEL,
          state.error,
        )}
        onRetry={state.onRetry}
        retryLabel={SUBAGENTS_RETRY_LABEL}
      />
    );
  }
  if (state.status === 'unavailable') {
    return (
      <p className="text-xs fg-secondary">
        {state.reason ?? SUBAGENT_WORKTREE_UNAVAILABLE_LABEL}
      </p>
    );
  }

  const summary = state.summary;
  const files = summary.topFiles.slice(0, 4);
  const startingRevision = summary.startingRevision.slice(0, 7);
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <FactList>
        <Fact label={SUBAGENT_WORKTREE_CHECKOUT}>
          {subagentCheckoutLabel(summary.checkout)}
        </Fact>
        <Fact label={SUBAGENT_WORKTREE_STARTED_FROM}>
          <span
            className="flex min-w-0 items-center gap-1.5"
            title={summary.startingSubject}
          >
            <GitCommitIcon size={12} aria-hidden />
            <span className="font-mono">{startingRevision}</span>
            {summary.startingBranch ? (
              <span className="truncate fg-tertiary">
                {subagentStartingBranchLabel(summary.startingBranch)}
              </span>
            ) : null}
          </span>
        </Fact>
        <Fact label={SUBAGENT_WORKTREE_CHANGES}>
          <span className="flex flex-wrap items-center gap-x-1.5">
            <SubagentChangesLabel
              additions={summary.additions}
              deletions={summary.deletions}
            />
            <span className="fg-tertiary">
              {subagentFilesCountLabel(summary.filesChanged)}
            </span>
          </span>
        </Fact>
        <Fact label={SUBAGENT_WORKTREE_HISTORY}>
          {subagentHistoryLabel(summary.commitsAhead, summary.untrackedFiles)}
        </Fact>
        <Fact label={SUBAGENT_WORKTREE_APPLIED}>
          {subagentApplyStateLabel(summary.applyState)}
        </Fact>
      </FactList>
      {files.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-0.5">
          {files.map((file) => (
            <FileRow key={file.path} file={file} />
          ))}
        </ul>
      ) : null}
      {summary.truncated ? (
        <p className="text-2xs fg-tertiary">
          {subagentTopFilesShownLabel(files.length)}
        </p>
      ) : null}
      <p className="text-2xs fg-tertiary">
        {SUBAGENT_WORKTREE_NO_UNCOMMITTED_NOTE}
      </p>
      {onShowChanges ? (
        <div>
          <Button size="compact" variant="secondary" onClick={onShowChanges}>
            {SUBAGENT_SHOW_CHANGES_LABEL}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
