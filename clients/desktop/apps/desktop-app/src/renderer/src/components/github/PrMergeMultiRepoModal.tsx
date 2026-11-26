import { DialogActionFooter } from '@canopy/ui-shared/components';
import { Badge } from '@canopy/ui-shared/primitives/Badge';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
} from 'react';
import type { MergePrVerifiedRepo } from '@canopy/desktop-shared/types/github';
import { Button } from '@canopy/ui-shared';
import { DialogModal } from '@/components/shared/DialogModal';
import { ThinkingSpinner } from '@/components/shared/loading/spinners/ThinkingSpinner';
import {
  Stack,
  Checkbox,
  Surface,
  TextLink,
} from '@canopy/ui-shared/components';

interface PrMergeMultiRepoModalProps {
  /** Freshly verified per-repo PR state for every repo with an open PR. */
  repos: MergePrVerifiedRepo[];
  /** True while GitHub is refreshing the per-repo merge state. */
  isChecking: boolean;
  /** True when the fresh GitHub check could not be completed. */
  checkFailed: boolean;
  isSubmitting: boolean;
  /** Confirm with the repo ids the user chose to merge. */
  onConfirm: (repoIds: string[]) => void;
  onRetry: () => void;
  onClose: () => void;
}

function blockedReasonLabel(
  reason: MergePrVerifiedRepo['blockedReason'],
): string {
  if (reason === 'has_conflicts') return 'Has conflicts';
  if (reason === 'base_changed') return 'Base branch changed';
  if (reason === 'in_merge_queue') return 'In merge queue';
  return 'Not mergeable';
}

/**
 * Per-repo merge picker shown when a multi-repo worktree has more than one open
 * PR. Each mergeable repo can be toggled; non-mergeable repos are shown but not
 * selectable. Unresolved-comment counts are surfaced inline so the confirm acts
 * as the unresolved-comment acknowledgement for the selected repos.
 */
export const PrMergeMultiRepoModal = memo(function PrMergeMultiRepoModal({
  repos,
  isChecking,
  checkFailed,
  isSubmitting,
  onConfirm,
  onRetry,
  onClose,
}: PrMergeMultiRepoModalProps): JSX.Element {
  const selectableRepoIds = useMemo(
    () =>
      repos
        .filter((repo) => repo.mergeable && repo.repoId !== undefined)
        .map((repo) => repo.repoId ?? ''),
    [repos],
  );

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(selectableRepoIds),
  );

  useEffect((): void => {
    if (!isChecking && !checkFailed) {
      setSelected(new Set(selectableRepoIds));
    }
  }, [checkFailed, isChecking, selectableRepoIds]);

  const toggle = useCallback((repoId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  }, []);

  // Per the merge queue setting, a merge queue PR either opens a chat or is
  // added to the queue directly.
  const mergeQueueNote = useMemo((): string | null => {
    const queueRepos = repos.filter((repo) => repo.usesMergeQueue === true);
    const chatCount = queueRepos.filter(
      (repo) => repo.startsAgentChat === true,
    ).length;
    if (queueRepos.length === 0) return null;
    if (chatCount === queueRepos.length) {
      return 'Pull requests on a merge queue open a chat that merges through the queue.';
    }
    if (chatCount === 0) {
      return 'Pull requests on a merge queue are added to the queue.';
    }
    return 'Pull requests on a merge queue are added to the queue. Those with no merge queue hook open a chat that oversees the merge.';
  }, [repos]);

  const handleConfirm = useCallback((): void => {
    if (isSubmitting || selected.size === 0) return;
    onConfirm(Array.from(selected));
  }, [isSubmitting, selected, onConfirm]);

  return (
    <DialogModal
      inset="flush"
      onClose={isSubmitting ? (): void => undefined : onClose}
      title="Merge pull requests"
      maxWidth="lg"
      closeOnBackdrop={!isSubmitting}
      dataTestId="pr-merge-multi-repo-modal"
    >
      <div className="flex flex-col gap-2 p-6 text-s fg-primary">
        {isChecking ? (
          <div
            className="flex min-h-28 flex-col items-center justify-center gap-3 text-center"
            data-testid="pr-merge-multi-repo-checking"
          >
            <ThinkingSpinner tone="accent" sizePx={20} />
            <Stack gap="tight">
              <p className="font-medium">Checking pull requests…</p>
              <p className="text-xs fg-secondary">
                Refreshing mergeability and review threads from GitHub.
              </p>
            </Stack>
          </div>
        ) : checkFailed ? (
          <div
            className="flex min-h-28 flex-col items-center justify-center gap-1 text-center"
            data-testid="pr-merge-multi-repo-check-failed"
          >
            <p className="font-medium">Couldn’t check pull requests</p>
            <p className="text-xs fg-secondary">
              GitHub didn’t return fresh merge details. Try the check again.
            </p>
          </div>
        ) : (
          <>
            <p className="fg-secondary">
              Select the pull requests to merge. Only mergeable PRs can be
              selected.
            </p>
            {mergeQueueNote !== null && (
              <p
                className="text-xs fg-secondary"
                data-testid="pr-merge-multi-repo-queue-note"
              >
                {mergeQueueNote}
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {repos.map((repo) => {
                const repoId = repo.repoId;
                const isSelectable = repo.mergeable && repoId !== undefined;
                const isChecked = repoId !== undefined && selected.has(repoId);
                const unresolved = repo.unresolvedReviewThreadCount;
                const unresolvedLabel =
                  unresolved === undefined
                    ? 'Unknown unresolved'
                    : `${unresolved} unresolved`;
                return (
                  <Surface
                    as="li"
                    variant="group"
                    size="small"
                    padding="compact"
                    key={repoId ?? repo.repoName}
                  >
                    <div className="flex items-center gap-3">
                      <Checkbox
                        checked={isChecked}
                        disabled={!isSelectable || isSubmitting}
                        onChange={(): void => {
                          if (repoId !== undefined) toggle(repoId);
                        }}
                        aria-label={`Select ${repo.repoName} pull request #${repo.prNumber} for merge`}
                        data-testid={`pr-merge-multi-repo-checkbox-${repo.repoName}`}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate font-semibold">
                          {repo.repoName}
                        </span>
                        <span className="self-start">
                          <TextLink
                            href={repo.prUrl}
                            size="xs"
                            target="_blank"
                            rel="noopener noreferrer"
                          >{`#${repo.prNumber}`}</TextLink>
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {unresolved !== 0 && (
                          <Badge tone="warning">{unresolvedLabel}</Badge>
                        )}
                        {repo.mergeable ? (
                          <>
                            {repo.usesMergeQueue === true && (
                              <Badge
                                data-testid={`pr-merge-multi-repo-queue-hint-${repo.repoName}`}
                              >
                                Uses a merge queue
                              </Badge>
                            )}
                            <Badge tone="success">Ready</Badge>
                          </>
                        ) : (
                          <Badge>
                            {blockedReasonLabel(repo.blockedReason)}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </Surface>
                );
              })}
            </ul>
          </>
        )}
      </div>
      <DialogActionFooter center padding="roomy">
        <Button
          variant="secondary"
          size="compact"
          onClick={onClose}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        {checkFailed ? (
          <Button
            variant="primary"
            size="compact"
            onClick={onRetry}
            data-testid="pr-merge-multi-repo-retry"
          >
            Try again
          </Button>
        ) : (
          <Button
            variant="primary"
            size="compact"
            onClick={handleConfirm}
            disabled={isChecking || isSubmitting || selected.size === 0}
            data-testid="pr-merge-multi-repo-confirm"
          >
            {isChecking
              ? 'Checking…'
              : isSubmitting
                ? 'Merging…'
                : `Merge ${selected.size} ${selected.size === 1 ? 'PR' : 'PRs'}`}
          </Button>
        )}
      </DialogActionFooter>
    </DialogModal>
  );
});
