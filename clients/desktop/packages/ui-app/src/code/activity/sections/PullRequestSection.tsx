'use client';

import type { JSX } from 'react';
import type { RemoteControlPrStatus } from '@canopy/protocol/remote-control/shell';
import { PullRequestSectionBody } from '../PullRequestSectionBody';
import { remoteControlPrStatusToSectionModel } from '../remote-control-pr-section-mapper';
import { PullRequestReviewApprovalNotice } from '../ReviewApprovalLinkNotice';

/**
 * Portal Pull Requests card: renders the extracted desktop presentational
 * core ({@link PullRequestSectionBody}, CAN-1528) fed from the neutral
 * {@link RemoteControlPrStatus} snapshot via the pure section mapper. The desktop
 * rail overrides this section with its own store-backed wrapper, so this
 * component is the portal-only mount point.
 */
export interface PullRequestSectionProps {
  readonly prStatus: RemoteControlPrStatus | undefined;
  /**
   * The review approval "Link GitHub" notice under Reviews (CAN-7162): the
   * worktree's run owner and the product name. Absent: no notice.
   */
  readonly reviewApproval?: {
    readonly runOwner: string;
    readonly brandName: string;
  };
}

export function PullRequestSection({
  prStatus,
  reviewApproval,
}: PullRequestSectionProps): JSX.Element {
  const model = remoteControlPrStatusToSectionModel(prStatus);
  const hasPr = model.repos?.some((repo) => repo.status !== null) ?? false;
  // The latest refresh failed: say so, never "No pull request".
  const refreshError = prStatus?.refreshError;

  if (!hasPr && !model.isCreating && model.creationProgress === undefined) {
    return refreshError === undefined ? (
      <p className="text-xs fg-secondary" data-testid="activity-pr-empty">
        No pull request.
      </p>
    ) : (
      <p className="text-xs fg-warning" data-testid="activity-pr-error">
        {refreshError}
      </p>
    );
  }

  return (
    <div data-testid="activity-pr">
      {/* The error concerns the whole card (every row is from the last
          read), so it stands above them rather than replacing one chip:
          a recorded DESIGN.md deviation (REG-3025 design notes). */}
      {refreshError !== undefined && (
        <p className="pb-2 text-xs fg-warning" data-testid="activity-pr-error">
          {refreshError} Showing the last status read.
        </p>
      )}
      <PullRequestSectionBody
        repos={model.repos}
        isCreating={model.isCreating}
        creationProgress={model.creationProgress}
        {...(reviewApproval === undefined
          ? {}
          : {
              renderReviewNotice: (repo) =>
                repo.status === null ? null : (
                  <PullRequestReviewApprovalNotice
                    runOwner={reviewApproval.runOwner}
                    prUrl={repo.status.prUrl}
                    prState={repo.status.state}
                    brandName={reviewApproval.brandName}
                  />
                ),
            })}
      />
    </div>
  );
}
