'use client';

import { TextLink, DialogActionFooter } from '@canopy/ui-shared/components';
import { useCallback, type JSX } from 'react';
import {
  Button,
  DialogModal,
  ThinkingSpinner,
  Tooltip,
} from '@canopy/ui-shared/components';
import { ChatIcon } from '@canopy/ui-shared/icons';

export interface PrMergeWarningDialogProps {
  /** Number of unresolved review threads on the PR being merged; undefined when unknown. */
  readonly unresolvedReviewThreadCount?: number;
  /** GitHub URL of the PR. */
  readonly prUrl: string;
  readonly isSubmitting: boolean;
  /** True while the triage-review-comments chat is being started. */
  readonly isTriaging?: boolean;
  readonly onConfirm: () => void;
  /**
   * Start an agent chat to triage the PR's review comments. A host that
   * cannot shows the action unavailable, with the reason.
   */
  readonly onTriageReviewComments?: () => void;
  /**
   * Open the PR the host's way (desktop honors its link preference). Absent,
   * the link opens in a new tab.
   */
  readonly onOpenPr?: () => void;
  readonly onClose: () => void;
}

const TRIAGE_UNAVAILABLE = "Triaging review comments isn't available here yet.";

/**
 * Confirmation shown when the user clicks Merge on a PR that still has
 * unresolved review comments (REG-3025, shared by desktop and web). Lets them
 * open the PR to resolve them, triage them with an agent, or merge anyway.
 * Rendered in the merge button's warning state.
 */
export function PrMergeWarningDialog({
  unresolvedReviewThreadCount,
  prUrl,
  isSubmitting,
  isTriaging = false,
  onConfirm,
  onTriageReviewComments,
  onOpenPr,
  onClose,
}: PrMergeWarningDialogProps): JSX.Element {
  const handleConfirm = useCallback((): void => {
    if (isSubmitting) return;
    onConfirm();
  }, [isSubmitting, onConfirm]);

  const handleTriage = useCallback((): void => {
    if (isSubmitting || isTriaging) return;
    onTriageReviewComments?.();
  }, [isSubmitting, isTriaging, onTriageReviewComments]);

  const count = unresolvedReviewThreadCount;
  const unresolvedText =
    count === undefined
      ? 'an unknown number of unresolved comments'
      : `${count} unresolved ${count === 1 ? 'comment' : 'comments'}`;
  const reviewPronoun = count === 1 ? 'it' : 'them';

  return (
    <DialogModal
      inset="flush"
      onClose={isSubmitting ? (): void => undefined : onClose}
      title="Unresolved comments"
      maxWidth="md"
      closeOnBackdrop={!isSubmitting}
      dataTestId="pr-merge-warning-modal"
    >
      <div className="flex flex-col gap-3 p-6 text-s fg-primary">
        <p>
          This pull request has{' '}
          <span className="font-semibold">{unresolvedText}</span>. You can
          review {reviewPronoun} before merging, or merge anyway.
        </p>
        {onOpenPr === undefined ? (
          <TextLink
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            size="xs"
            emphasis="medium"
            className="self-start"
          >
            View pull request on GitHub
          </TextLink>
        ) : (
          <span className="self-start text-xs">
            <Button variant="link" onClick={onOpenPr}>
              View pull request on GitHub
            </Button>
          </span>
        )}
        {onTriageReviewComments === undefined ? (
          // Capability-gated: shown unavailable with its reason, not hidden.
          <Tooltip label={TRIAGE_UNAVAILABLE}>
            <Button
              size="compact"
              aria-disabled="true"
              data-testid="pr-merge-warning-triage"
              className="self-start"
            >
              <ChatIcon size="sm" />
              Triage review comments
            </Button>
          </Tooltip>
        ) : (
          <Button
            size="compact"
            onClick={handleTriage}
            disabled={isSubmitting || isTriaging}
            data-testid="pr-merge-warning-triage"
            className="self-start"
          >
            {isTriaging ? (
              <ThinkingSpinner tone="primary" quiet />
            ) : (
              <ChatIcon size="sm" />
            )}
            {isTriaging ? 'Starting…' : 'Triage review comments'}
          </Button>
        )}
      </div>
      <DialogActionFooter center padding="roomy">
        <Button size="compact" onClick={onClose} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          size="compact"
          onClick={handleConfirm}
          disabled={isSubmitting}
          data-testid="pr-merge-warning-confirm"
        >
          {isSubmitting ? 'Merging…' : 'Merge anyway'}
        </Button>
      </DialogActionFooter>
    </DialogModal>
  );
}
