'use client';

import { TextLink, ControlButton } from '@canopy/ui-shared/components';
import { Badge, type BadgeTone } from '@canopy/ui-shared/components/Badge';
import {
  SPACE_ROLE_GAP_CLASS,
  type SpaceRole,
} from '@canopy/ui-shared/components/Stack';
import { useMemo, useState, type JSX, type ReactNode } from 'react';
import {
  Stack,
  Notice,
  PrLabelBadge,
  ProgressChecklist,
  PullRequestStateBadge,
  ReviewStatusBadge,
  type ProgressChecklistStep,
  type ReviewStatusBadgeStatus,
  StatusLabel,
} from '@canopy/ui-shared/components';
import {
  PR_ORDERED_PHASES,
  PR_PHASE_LABELS,
  derivePhaseStatus,
  type PullRequestCreationPhase,
} from '@canopy/ui-shared/lib';
import {
  PullRequestCheckStatusMarker,
  type PullRequestSectionCheckStatus,
} from '../pull-requests/PullRequestCheckStatusMarker';
import { ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

// ---------------------------------------------------------------------------
// CAN-1528 — the desktop `PullRequestSection` presentational core, extracted
// VERBATIM (markup + Tailwind classes + data-testids untouched) into a
// props-only component rendered by BOTH surfaces: the desktop wrapper feeds
// it from the githubStore, the portal feeds it from the `RemoteControlPrStatus`
// snapshot. Host-specific concerns arrive as props: merge-readiness is
// precomputed per status (`isMergeReady`, desktop `isPrReadyToMerge`),
// section chrome collapses to the single `framelessChecks` boolean, and any
// host-only UI (the desktop split-PR surfaces) renders through `children`.
//
// The prop types below are neutral structural twins of the desktop
// `RepoPrStatus` / `PrCreationProgress` shapes — this package must not import
// `@canopy/desktop-shared`, and the desktop objects stay assignable.
// ---------------------------------------------------------------------------

export type PullRequestSectionPrState = 'open' | 'merged' | 'closed' | 'draft';

export type { PullRequestSectionCheckStatus } from '../pull-requests/PullRequestCheckStatusMarker';

export type PullRequestSectionReviewStatus =
  | 'approved'
  | 'changes_requested'
  | 'pending'
  | 'none';

export interface PullRequestSectionCheckDetail {
  readonly name: string;
  readonly status: PullRequestSectionCheckStatus;
  readonly detailsUrl: string | null;
}

export interface PullRequestSectionLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
}

export interface PullRequestSectionPrStatus {
  readonly prNumber: number;
  readonly prUrl: string;
  readonly state: PullRequestSectionPrState;
  readonly title: string;
  readonly checkDetails: readonly PullRequestSectionCheckDetail[];
  readonly reviewStatus: PullRequestSectionReviewStatus;
  readonly labels?: readonly PullRequestSectionLabel[];
  readonly hasConflicts: boolean;
  readonly commentCount: number;
  /**
   * Host-computed merge readiness (desktop: `isPrReadyToMerge`, which also
   * weighs GitHub's `mergeable`/`mergeableState`). Drives the approved review
   * badge tone: approved-but-not-ready renders muted instead of success.
   */
  readonly isMergeReady?: boolean;
}

export interface PullRequestSectionRepo {
  readonly repoId: string;
  readonly repoName: string;
  readonly status: PullRequestSectionPrStatus | null;
}

export interface PullRequestSectionCreationStep {
  readonly phase: PullRequestCreationPhase;
  readonly repoName?: string;
  readonly error?: string;
}

export interface PullRequestSectionCreationProgress {
  readonly steps: readonly PullRequestSectionCreationStep[];
  readonly currentPhase: PullRequestCreationPhase;
}

function toReviewBadgeStatus(
  status: PullRequestSectionReviewStatus,
): ReviewStatusBadgeStatus {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'changes_requested':
      return 'changes-requested';
    case 'pending':
      return 'pending';
    case 'none':
      return 'none';
  }
}

function ReviewSummary({
  status,
  isMergeReady,
}: {
  status: PullRequestSectionReviewStatus;
  isMergeReady: boolean;
}): JSX.Element {
  return (
    <ReviewStatusBadge
      status={toReviewBadgeStatus(status)}
      approvedTone={
        status === 'approved' && !isMergeReady ? 'muted' : 'success'
      }
    />
  );
}

function PhaseList({
  steps,
  currentPhase,
  isCreating,
}: {
  steps: readonly PullRequestSectionCreationStep[];
  currentPhase: PullRequestCreationPhase;
  isCreating: boolean;
}): JSX.Element {
  const errorStep = steps.find((s) => s.phase === 'error' && s.error);
  const rows: ProgressChecklistStep[] = PR_ORDERED_PHASES.map((phase) => ({
    key: phase,
    label: PR_PHASE_LABELS[phase],
    status: derivePhaseStatus({
      phase,
      orderedPhases: PR_ORDERED_PHASES,
      steps,
      currentPhase,
      isActive: isCreating,
    }),
  }));
  return <ProgressChecklist steps={rows} error={errorStep?.error} />;
}

interface RepoGroup {
  repoName: string;
  steps: PullRequestSectionCreationStep[];
  currentPhase: PullRequestCreationPhase;
}

function groupStepsByRepo(steps: readonly PullRequestSectionCreationStep[]): {
  repos: RepoGroup[];
  skipped: string[];
} {
  const skipped: string[] = [];
  const repoMap = new Map<string, PullRequestSectionCreationStep[]>();
  const repoOrder: string[] = [];

  for (const step of steps) {
    if (!step.repoName) continue;
    if (step.phase === 'skipped') {
      skipped.push(step.repoName);
      continue;
    }
    let bucket = repoMap.get(step.repoName);
    if (!bucket) {
      bucket = [];
      repoMap.set(step.repoName, bucket);
      repoOrder.push(step.repoName);
    }
    bucket.push(step);
  }

  const repos: RepoGroup[] = repoOrder.map((name) => {
    const repoSteps = repoMap.get(name) ?? [];
    const last = repoSteps[repoSteps.length - 1];
    return { repoName: name, steps: repoSteps, currentPhase: last.phase };
  });

  return { repos, skipped };
}

/** A pull request creation phase as the shared `Badge`'s tone and label. */
function creationStatusBadge(phase: PullRequestCreationPhase): {
  tone: BadgeTone;
  label: string;
} {
  if (phase === 'error') return { tone: 'danger', label: 'Failed' };
  if (phase === 'done') return { tone: 'success', label: 'Created' };
  return { tone: 'info', label: 'Creating' };
}

function CreationProgressFeed({
  progress,
  isCreating,
}: {
  progress: PullRequestSectionCreationProgress;
  isCreating: boolean;
}): JSX.Element {
  const isMultiRepo = progress.steps.some(
    (s) => s.repoName != null && s.phase !== 'done',
  );

  const { repos, skipped } = useMemo(
    () =>
      isMultiRepo
        ? groupStepsByRepo(progress.steps)
        : { repos: [], skipped: [] },
    [isMultiRepo, progress.steps],
  );

  if (isMultiRepo) {
    const creationStatus = creationStatusBadge(progress.currentPhase);
    return (
      <Stack gap="inline">
        <div className="flex items-center gap-2">
          <Badge tone={creationStatus.tone}>{creationStatus.label}</Badge>
        </div>
        {repos.length > 0 && (
          <Stack gap="item">
            {repos.map((repo) => {
              const repoDone =
                repo.currentPhase === 'done' || repo.currentPhase === 'error';
              return (
                <Stack gap="tight" key={repo.repoName}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium fg-primary/80">
                      {repo.repoName}
                    </span>
                    {repo.currentPhase === 'done' && (
                      <span className="text-3xs fg-success">{'✓'}</span>
                    )}
                    {repo.currentPhase === 'error' && (
                      <span className="text-3xs fg-destructive">{'✗'}</span>
                    )}
                  </div>
                  <div className="pl-2">
                    <PhaseList
                      steps={repo.steps}
                      currentPhase={repo.currentPhase}
                      isCreating={isCreating && !repoDone}
                    />
                  </div>
                </Stack>
              );
            })}
          </Stack>
        )}
        {skipped.length > 0 && (
          <p className="text-2xs fg-secondary">
            Skipped {skipped.length} {skipped.length === 1 ? 'repo' : 'repos'}{' '}
            (no changes): {skipped.join(', ')}
          </p>
        )}
      </Stack>
    );
  }

  // Single-repo progress
  const errorStep = progress.steps.find((s) => s.phase === 'error' && s.error);
  const rows: ProgressChecklistStep[] = PR_ORDERED_PHASES.map((phase) => ({
    key: phase,
    label: PR_PHASE_LABELS[phase],
    status: derivePhaseStatus({
      phase,
      orderedPhases: PR_ORDERED_PHASES,
      steps: progress.steps,
      currentPhase: progress.currentPhase,
      isActive: isCreating,
    }),
  }));
  return (
    <ProgressChecklist
      steps={rows}
      error={errorStep?.error}
      badge={
        progress.currentPhase === 'error'
          ? { label: 'Failed', tone: 'error' }
          : progress.currentPhase === 'done'
            ? { label: 'Created', tone: 'success' }
            : { label: 'Creating', tone: 'progress' }
      }
    />
  );
}

export function PullRequestRepoDetail({
  status,
  hideGitHubLink,
  framelessChecks,
  reviewNotice,
}: {
  status: PullRequestSectionPrStatus | null;
  hideGitHubLink?: boolean;
  /** Host content directly under the Reviews status (the approval notice). */
  reviewNotice?: ReactNode;
  /**
   * `true` under the desktop frameless (single-section panel) chrome: the
   * checks list renders in plain flow instead of the capped scroll area.
   */
  framelessChecks?: boolean;
}): JSX.Element {
  const s = status;
  const sortedChecks = useMemo<PullRequestSectionCheckDetail[]>(() => {
    if (!s) {
      return [];
    }
    const priority: Record<PullRequestSectionCheckStatus, number> = {
      pending: 0,
      failing: 1,
      passing: 2,
      neutral: 3,
      none: 4,
    };
    return s.checkDetails
      .map((check, index) => ({ check, index }))
      .sort((a, b) => {
        const diff = priority[a.check.status] - priority[b.check.status];
        return diff !== 0 ? diff : a.index - b.index;
      })
      .map(({ check }) => check);
  }, [s]);
  if (!s) {
    return <></>;
  }

  return (
    <Stack gap="item">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-s font-medium fg-primary">
            PR #{s.prNumber}
          </span>
          <PullRequestStateBadge state={s.state} dataTestId="pr-status-badge" />
        </div>
        {/* Portal snapshots can carry a numbered PR without a URL (lenient
            wire contract); an empty href would self-navigate, so the link
            renders only when a URL exists. */}
        {!hideGitHubLink && s.prUrl !== '' && (
          <TextLink
            href={s.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="quiet"
            size="xs"
          >
            GitHub &rarr;
          </TextLink>
        )}
      </div>

      <p className="text-xs fg-secondary">{s.title}</p>

      {/* Checks */}
      {s.checkDetails.length > 0 && (
        <Stack gap="tight">
          <p className="text-3xs font-semibold fg-secondary">
            Checks (
            {
              s.checkDetails.filter(
                (c: PullRequestSectionCheckDetail) => c.status === 'passing',
              ).length
            }
            /{s.checkDetails.length} passing)
          </p>
          <div
            className={
              framelessChecks
                ? 'grid grid-cols-1 content-start gap-1 pr-1'
                : 'max-h-70 grid grid-cols-1 content-start gap-1 overflow-y-auto pr-1'
            }
          >
            {sortedChecks.map((check: PullRequestSectionCheckDetail, index) => (
              <div
                key={`${check.name}::${index}`}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <PullRequestCheckStatusMarker status={check.status} />
                  <span className="truncate fg-primary/80">{check.name}</span>
                </span>
                {check.detailsUrl && (
                  <TextLink
                    href={check.detailsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="quiet"
                    className="shrink-0"
                  >
                    view &rarr;
                  </TextLink>
                )}
              </div>
            ))}
          </div>
        </Stack>
      )}

      {/* Reviews */}
      <Stack gap="tight">
        <p className="text-3xs font-semibold fg-secondary">Reviews</p>
        <ReviewSummary
          status={s.reviewStatus}
          isMergeReady={s.isMergeReady === true}
        />
      </Stack>
      {reviewNotice}

      {/* Labels */}
      {s.labels && s.labels.length > 0 && (
        <Stack gap="tight" data-testid="pr-labels-section">
          <p className="text-3xs font-semibold fg-secondary">Labels</p>
          <div className="flex flex-wrap gap-1">
            {s.labels.map((label) => (
              <PrLabelBadge
                key={label.name}
                name={label.name}
                color={label.color}
                description={label.description}
                dataTestId="pr-label"
              />
            ))}
          </div>
        </Stack>
      )}

      {/* Conflicts */}
      {s.hasConflicts && (
        <Notice intent="attention" title="Merge conflict">
          Resolve it on the branch before this pull request can merge.
        </Notice>
      )}

      {/* Comments */}
      {s.commentCount > 0 && (
        <p className="text-xs fg-secondary">
          {s.commentCount} {s.commentCount === 1 ? 'comment' : 'comments'}
        </p>
      )}
    </Stack>
  );
}

export interface PullRequestSectionBodyProps {
  /**
   * Per-repo PR statuses, or `undefined` when the host has no PR snapshot at
   * all (the desktop store miss). A single-entry array renders the flat card;
   * more entries render the collapsible per-repo grouping.
   */
  readonly repos?: readonly PullRequestSectionRepo[];
  readonly isCreating?: boolean;
  readonly creationProgress?: PullRequestSectionCreationProgress;
  /** See {@link PullRequestRepoDetail}'s `framelessChecks`. */
  readonly framelessChecks?: boolean;
  /**
   * Host-only content rendered after the PR body (the desktop split-PR
   * surfaces). Absent on hosts without those capabilities.
   */
  readonly children?: ReactNode;
  /** Opt-in extension spacing, including its initial inset when no PR body is visible. */
  readonly extensionGap?: SpaceRole;
  /**
   * Content under one repository's Reviews status (the review approval
   * "Link GitHub" notice). The body stays display-only: the host decides.
   */
  readonly renderReviewNotice?: (repo: PullRequestSectionRepo) => ReactNode;
}

const EXTENSION_INITIAL_INSET_CLASS: Readonly<Record<SpaceRole, string>> = {
  tight: 'pt-1',
  inline: 'pt-2',
  item: 'pt-3',
  group: 'pt-4',
  block: 'pt-5',
  section: 'pt-6',
  page: 'pt-8',
  hero: 'pt-10',
};

export function PullRequestSectionBody({
  repos,
  isCreating = false,
  creationProgress,
  framelessChecks,
  children,
  extensionGap,
  renderReviewNotice,
}: PullRequestSectionBodyProps): JSX.Element {
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());

  const isMultiRepo = repos ? repos.length > 1 : false;
  const hasAnyPr = repos ? repos.some((r) => r.status !== null) : false;

  const creationDone = creationProgress?.currentPhase === 'done';
  const creationError = creationProgress?.currentPhase === 'error';
  const showHybridMultiRepo =
    isMultiRepo &&
    hasAnyPr &&
    creationProgress != null &&
    (isCreating || creationError);
  // Show progress during active creation or on error; once done, prefer the PR card if available
  const showProgress =
    (isCreating || creationProgress) &&
    !showHybridMultiRepo &&
    !(creationDone && repos && repos.some((r) => r.status !== null));
  const showPrDetails = repos && !isCreating && !showHybridMultiRepo;

  const creationRepoGroups = useMemo(() => {
    if (!creationProgress) return { repos: [], skipped: [] };
    return groupStepsByRepo(creationProgress.steps);
  }, [creationProgress]);

  function toggleRepo(repoId: string): void {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  }

  const content = (
    <>
      {showProgress && creationProgress ? (
        <CreationProgressFeed
          progress={creationProgress}
          isCreating={isCreating}
        />
      ) : showHybridMultiRepo && creationProgress && repos ? (
        <Stack gap="inline">
          {repos.map((repo) => {
            const creationGroup = creationRepoGroups.repos.find(
              (g) => g.repoName === repo.repoName,
            );

            if (creationGroup) {
              const repoDone =
                creationGroup.currentPhase === 'done' ||
                creationGroup.currentPhase === 'error';
              const creationStatus = creationStatusBadge(
                creationGroup.currentPhase,
              );
              return (
                <Stack gap="tight" key={repo.repoId}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium fg-primary/80">
                      {repo.repoName}
                    </span>
                    {creationGroup.currentPhase === 'done' && (
                      <span className="text-3xs fg-success">{'✓'}</span>
                    )}
                    {creationGroup.currentPhase === 'error' && (
                      <span className="text-3xs fg-destructive">{'✗'}</span>
                    )}
                    <Badge tone={creationStatus.tone}>
                      {creationStatus.label}
                    </Badge>
                  </div>
                  <div className="pl-2">
                    <PhaseList
                      steps={creationGroup.steps}
                      currentPhase={creationGroup.currentPhase}
                      isCreating={isCreating && !repoDone}
                    />
                  </div>
                </Stack>
              );
            }

            return (
              <Stack gap="inline" key={repo.repoId}>
                <div className="flex items-center gap-1">
                  <ControlButton
                    onClick={() => toggleRepo(repo.repoId)}
                    presentation="repository-disclosure"
                  >
                    <AppCatalogChevronRightMediumIcon
                      size="sm"
                      className={`flex-shrink-0 transition-transform ${expandedRepos.has(repo.repoId) ? 'rotate-90' : ''}`}
                    />
                    <span className="truncate">{repo.repoName}</span>
                    {repo.status && (
                      <PullRequestStateBadge
                        state={repo.status.state}
                        dataTestId="pr-status-badge"
                      />
                    )}
                  </ControlButton>
                  {repo.status && repo.status.prUrl !== '' && (
                    <TextLink
                      href={repo.status.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="quiet"
                      size="xs"
                      className="shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      GitHub &rarr;
                    </TextLink>
                  )}
                </div>
                {expandedRepos.has(repo.repoId) && (
                  <div className="pl-4">
                    <PullRequestRepoDetail
                      status={repo.status}
                      hideGitHubLink
                      framelessChecks={framelessChecks}
                      reviewNotice={renderReviewNotice?.(repo)}
                    />
                  </div>
                )}
              </Stack>
            );
          })}
          {creationRepoGroups.skipped.length > 0 && (
            <p className="text-2xs fg-secondary">
              Skipped {creationRepoGroups.skipped.length}{' '}
              {creationRepoGroups.skipped.length === 1 ? 'repo' : 'repos'} (no
              changes): {creationRepoGroups.skipped.join(', ')}
            </p>
          )}
          {creationProgress.steps
            .flatMap((s): string[] =>
              s.phase === 'error' && s.error && !s.repoName ? [s.error] : [],
            )
            .map((error, i) => (
              <div key={`error-${i}`} className="pt-1 max-h-32 overflow-auto">
                <p className="whitespace-pre-wrap break-words">
                  <StatusLabel size="2xs">{error}</StatusLabel>
                </p>
              </div>
            ))}
        </Stack>
      ) : showPrDetails && !hasAnyPr ? null : showPrDetails && isMultiRepo ? (
        <Stack gap="inline">
          {repos.map((repo) => (
            <Stack gap="inline" key={repo.repoId}>
              <div className="flex items-center gap-1">
                <ControlButton
                  onClick={() => toggleRepo(repo.repoId)}
                  presentation="repository-disclosure"
                >
                  <AppCatalogChevronRightMediumIcon
                    size="sm"
                    className={`flex-shrink-0 transition-transform ${expandedRepos.has(repo.repoId) ? 'rotate-90' : ''}`}
                  />
                  <span className="truncate">{repo.repoName}</span>
                  {repo.status && (
                    <PullRequestStateBadge
                      state={repo.status.state}
                      dataTestId="pr-status-badge"
                    />
                  )}
                </ControlButton>
                {repo.status && repo.status.prUrl !== '' && (
                  <TextLink
                    href={repo.status.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="quiet"
                    size="xs"
                    className="shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    GitHub &rarr;
                  </TextLink>
                )}
              </div>
              {expandedRepos.has(repo.repoId) && (
                <div className="pl-4">
                  <PullRequestRepoDetail
                    status={repo.status}
                    hideGitHubLink
                    framelessChecks={framelessChecks}
                    reviewNotice={renderReviewNotice?.(repo)}
                  />
                </div>
              )}
            </Stack>
          ))}
        </Stack>
      ) : showPrDetails ? (
        <PullRequestRepoDetail
          status={repos[0]?.status ?? null}
          framelessChecks={framelessChecks}
          reviewNotice={
            repos[0] === undefined ? undefined : renderReviewNotice?.(repos[0])
          }
        />
      ) : null}
      {children}
    </>
  );
  const hasBody = Boolean(
    (showProgress && creationProgress) ||
    (showHybridMultiRepo && creationProgress && repos) ||
    (showPrDetails && hasAnyPr),
  );
  return extensionGap === undefined ? (
    content
  ) : (
    <Stack gap={extensionGap} className="empty:hidden">
      {hasBody ? (
        content
      ) : (
        <div
          className={`flex flex-col ${SPACE_ROLE_GAP_CLASS[extensionGap]} ${EXTENSION_INITIAL_INSET_CLASS[extensionGap]} empty:hidden`}
        >
          {children}
        </div>
      )}
    </Stack>
  );
}
