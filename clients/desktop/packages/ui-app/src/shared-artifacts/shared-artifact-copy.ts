import type {
  SharedArtifactKind,
  SharedArtifactReportReason,
} from '@canopy/protocol/shared-artifacts';

/**
 * Every shared artifact string (CAN-8017). The UI noun is "artifact"
 * (docs/shared-artifacts.md). Error copy never repeats server text.
 */
export const SHARED_ARTIFACT_COPY = {
  noun: 'artifact',
  // States
  loading: 'Loading artifact…',
  unavailableTitle: 'Artifacts aren’t available here',
  unavailableBody: 'This app can’t open shared artifacts yet.',
  unsharedTitle: 'You stopped sharing this artifact',
  unsharedBody: 'The artifact and its link are deleted for everyone.',
  signInTitle: 'Sign in to view this artifact',
  // The page can't tell a team artifact from a missing one, so the sentence
  // covers both without saying which.
  signInBody:
    'This artifact may be shared with a team or organization. Sign in with an account that has access.',
  signInAction: 'Sign in',
  noAccessTitle: 'You don’t have access to this artifact',
  // One combined state: "not allowed" and "doesn't exist" are
  // indistinguishable by design, and the owner is never named.
  noAccessBody:
    'It may have been removed, or the link may be mistyped. Ask the person who shared it for access.',
  loadFailed: 'Couldn’t load this artifact. Try again.',
  takenDownTitle: 'This artifact was taken down',
  takenDownBody: (reason: string): string =>
    `It was removed for ${reason}. Only you can see this notice.`,
  pausedNotice:
    'Public link paused. Public sharing is turned off, so only your audience can open this artifact.',
  // Content
  contentFailed: 'Couldn’t show this artifact. Try again.',
  contentTooLarge: 'This artifact is too large to show here.',
  contentMismatch:
    'This artifact changed while it was loading. Try again to see the latest version.',
  contentTooLargeForFrame: 'This artifact is too large to show in the preview.',
  imageBlocked: (alt: string): string =>
    alt.trim() === '' ? 'Image not loaded' : `Image not loaded: ${alt}`,
  // Chrome
  ownerLine: (name: string): string => `Shared by ${name}`,
  updatedLine: (when: string): string => `Last updated ${when}`,
  automationLine: (label: string): string =>
    `Updated automatically by ${label}`,
  userGeneratedBanner:
    'This artifact was created by a user and isn’t reviewed. Don’t enter passwords or personal information in it.',
  viewCounts: (total: number, unique: number): string =>
    `${total} ${total === 1 ? 'view' : 'views'} · ${unique} ${unique === 1 ? 'person' : 'people'}`,
  shareAction: 'Share artifact',
  reportAction: 'Report artifact',
  enterFullScreen: 'Open full screen',
  exitFullScreen: 'Exit full screen',
  // Report
  reportTitle: 'Report artifact',
  reportReasonLabel: 'Reason',
  reportDetailLabel: 'Details (optional)',
  reportSubmit: 'Report artifact',
  reportSubmitting: 'Reporting artifact…',
  reportSent: 'Thanks. Your report was sent.',
  reportFailed: 'Couldn’t send your report. Try again.',
  reportDone: 'Done',
  reportDetailTooLong: (max: number): string =>
    `Use ${max} characters or fewer.`,
  // Share
  stopSharingLabel: 'Stop sharing artifact',
  stopSharingTitle: 'Stop sharing this artifact?',
  stopSharingBody:
    'This deletes the artifact and its link for everyone, including anyone with the public link. You can’t undo this.',
  stopSharingBusy: 'Stopping…',
  stopSharingToast: 'Artifact deleted.',
  stopSharingFailed: 'Couldn’t stop sharing this artifact. Try again.',
  audienceLockedHint: 'You can’t change who this artifact is shared with.',
  shareFailed: 'Couldn’t share this artifact. Try again.',
  quotaExceeded:
    'There isn’t enough artifact storage left for this audience. Delete an artifact and try again.',
  takenDownFailure: 'This artifact was taken down, so it can’t be shared.',
  // Public link
  publicLinkLabel: 'Public link',
  publicLinkDescription: 'Anyone with the link can view this artifact.',
  // Personal accounts hit this too, so it names no organization.
  publicLinkNotAllowed: 'Public links are turned off for this artifact.',
  publicLinkFailed: 'Couldn’t change the public link. Try again.',
  publicSharingDisabled:
    'Public links were turned off while you were here. Only your audience can open this artifact.',
  makePublicTitle: 'Make this artifact public?',
  makePublicBody:
    'Anyone with the link can view it without signing in. Check that it doesn’t contain private data, such as keys, customer details or internal notes.',
  makePublicConfirm: 'Make artifact public',
  makePublicBusy: 'Making public…',
  republishTitle: 'Update this public artifact?',
  republishBody:
    'Anyone with the public link will see the new version right away. Check that it doesn’t contain private data.',
  republishConfirm: 'Update public artifact',
  republishBusy: 'Updating…',
  // Lists
  listMine: 'Created by me',
  listSharedWithMe: 'Shared with me',
  listLabel: 'Artifacts',
  listEmptyMine: 'You haven’t shared any artifacts yet.',
  listEmptySharedWithMe: 'No artifacts are shared with you yet.',
  listEmptyOrganizationPublic: 'This organization has no public artifacts.',
  listFailed: 'Couldn’t load artifacts. Try again.',
  listLoadMore: 'Load more artifacts',
  listLoadMoreFailed: 'Couldn’t load more artifacts. Try again.',
  badgePublic: 'Public',
  badgePaused: 'Public link paused',
  // Organization setting
  allowPublicTitle: 'Allow public artifacts',
  allowPublicDescription:
    'Members can share artifacts with anyone who has the link. Turning this off pauses existing public links.',
} as const;

export const SHARED_ARTIFACT_KIND_LABELS: Readonly<
  Record<SharedArtifactKind, string>
> = {
  html: 'HTML',
  markdown: 'Markdown',
  image: 'Image',
  pdf: 'PDF',
};

export const SHARED_ARTIFACT_AUDIENCE_LABELS = {
  private: 'Only me',
  team: 'Team',
  organization: 'Organization',
} as const;

export const SHARED_ARTIFACT_REPORT_REASON_LABELS: Readonly<
  Record<SharedArtifactReportReason, string>
> = {
  malware_or_phishing: 'Malware or phishing',
  illegal_content: 'Illegal content',
  harassment: 'Harassment',
  private_information: 'Private information',
  spam: 'Spam',
  other: 'Something else',
};

/** The takedown reason as it reads inside a sentence. */
export const SHARED_ARTIFACT_TAKEDOWN_REASON_PHRASES: Readonly<
  Record<SharedArtifactReportReason, string>
> = {
  malware_or_phishing: 'malware or phishing',
  illegal_content: 'illegal content',
  harassment: 'harassment',
  private_information: 'exposing private information',
  spam: 'spam',
  other: 'a policy violation',
};
