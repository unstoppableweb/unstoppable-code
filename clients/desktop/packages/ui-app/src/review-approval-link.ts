// Dedicated entry for the review approval "Link GitHub" notice and its hooks
// (CAN-7162), so host activity surfaces don't import the package barrel.
export {
  ReviewApprovalLinkNotice,
  PullRequestReviewApprovalNotice,
  ReviewApprovalLaunchNotice,
  gitHubRepositoryOfPullRequestUrl,
  gitHubRepositoryOfRemoteUrl,
  gitHubRepositoryOfReviewUrl,
  isReviewApprovalLinkState,
  reviewApprovalReadinessInput,
  reviewApprovalRunOwnerOf,
  type ReviewApprovalLinkNoticeProps,
  type ReviewApprovalLinkState,
  type PullRequestReviewApprovalNoticeProps,
  type ReviewApprovalLaunchNoticeProps,
} from './code/activity/ReviewApprovalLinkNotice';
export {
  REVIEW_APPROVAL_LINK_FAILED_COPY,
  invalidateReviewApprovalReadiness,
  useReviewApprovalLink,
  useReviewApprovalReadiness,
  useReviewApprovalReadinessList,
  type ReviewApprovalLink,
} from './code/activity/review-approval-readiness';
