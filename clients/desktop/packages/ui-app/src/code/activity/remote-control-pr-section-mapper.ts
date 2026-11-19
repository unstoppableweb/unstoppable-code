import type {
  RemoteControlPrCreationProgress,
  RemoteControlPrStatus,
  RemoteControlPullRequestCheckDetail,
  RemoteControlPullRequestRepoStatus,
} from '@canopy/protocol/remote-control/shell';
import type { PullRequestCreationPhase } from '@canopy/ui-shared/lib';
import type {
  PullRequestSectionCheckDetail,
  PullRequestSectionCreationProgress,
  PullRequestSectionCreationStep,
  PullRequestSectionPrState,
  PullRequestSectionPrStatus,
  PullRequestSectionRepo,
  PullRequestSectionReviewStatus,
} from './PullRequestSectionBody';

/**
 * Pure mapper from the neutral {@link RemoteControlPrStatus} snapshot onto the props
 * of the shared {@link PullRequestSectionBody} (CAN-1528). The portal feeds
 * the extracted desktop card from cached `pr_status` entities; the desktop
 * wrapper feeds the same card from the githubStore, so every mapping here has
 * a desktop twin whose semantics it must mirror.
 *
 * Lenient by design: cross-pod payloads may come from older builds, so every
 * field is optional on the wire and absent fields degrade to the same
 * rendering the portal had before the CAN-1528 L2 projection widening.
 */
export interface RemoteControlPullRequestSectionModel {
  readonly repos?: readonly PullRequestSectionRepo[];
  readonly isCreating: boolean;
  readonly creationProgress?: PullRequestSectionCreationProgress;
}

/**
 * Common flat PR fields shared by the top-level {@link RemoteControlPrStatus} and
 * the per-repo {@link RemoteControlPullRequestRepoStatus} — the L2 widening keeps
 * the two shapes field-compatible so one mapping covers both.
 */
type RemoteControlPrStatusFields = Pick<
  RemoteControlPullRequestRepoStatus,
  | 'number'
  | 'url'
  | 'state'
  | 'title'
  | 'checkStatus'
  | 'checkDetails'
  | 'reviewStatus'
  | 'labels'
  | 'hasConflicts'
  | 'commentCount'
  | 'mergeReady'
>;

function toSectionPrState(
  value: string | undefined,
): PullRequestSectionPrState {
  return value === 'open' ||
    value === 'merged' ||
    value === 'closed' ||
    value === 'draft'
    ? value
    : // Free-form states from unknown builds still render a card; `open` is
      // the neutral fallback the desktop store also assumes for live PRs.
      'open';
}

function toSectionCheckDetails(
  details: readonly RemoteControlPullRequestCheckDetail[] | undefined,
): PullRequestSectionCheckDetail[] {
  if (!details) return [];
  const mapped: PullRequestSectionCheckDetail[] = [];
  for (const detail of details) {
    const detailsUrl = detail.detailsUrl ?? null;
    switch (detail.status) {
      case 'success':
        mapped.push({ name: detail.name, status: 'passing', detailsUrl });
        break;
      case 'failure':
        mapped.push({ name: detail.name, status: 'failing', detailsUrl });
        break;
      case 'pending':
      case 'neutral':
        mapped.push({ name: detail.name, status: detail.status, detailsUrl });
        break;
    }
  }
  return mapped;
}

/**
 * The shared card's Checks block renders only when per-check rows exist, so a
 * snapshot carrying just the aggregate `checkStatus` would lose its CI signal
 * (which the pre-adoption portal card DID render as a badge). Synthesize one
 * aggregate row for that case; `'none'` (no checks configured) stays empty.
 */
function aggregateFallbackCheckDetails(
  checkStatus: RemoteControlPrStatusFields['checkStatus'],
): PullRequestSectionCheckDetail[] {
  switch (checkStatus) {
    case 'passing':
    case 'failing':
    case 'pending':
    case 'neutral':
      return [{ name: 'CI checks', status: checkStatus, detailsUrl: null }];
    default:
      return [];
  }
}

function toSectionReviewStatus(
  value: string | undefined,
): PullRequestSectionReviewStatus {
  if (value === 'approved' || value === 'pending') return value;
  if (value === 'changes-requested') return 'changes_requested';
  // Both the explicit 'none' (CAN-1528 L2) and older payloads that collapse
  // "no reviewers" into an absent field render the "No reviews" badge.
  return 'none';
}

/**
 * All creation phases the shared checklist understands. Steps from future
 * builds with unknown phases are dropped instead of feeding the checklist
 * labels it cannot resolve.
 */
const KNOWN_CREATION_PHASES: ReadonlySet<string> = new Set<string>([
  'gathering_changes',
  'summarizing',
  'pushing',
  'creating_pr',
  'skipped',
  'done',
  'error',
]);

function isKnownCreationPhase(
  value: string,
): value is PullRequestCreationPhase {
  return KNOWN_CREATION_PHASES.has(value);
}

/**
 * Map the legacy 4-value `creationPhase` onto the desktop creation-phase
 * vocabulary so pre-widening payloads still light up the checklist. Typed as
 * a partial string record so a rogue value from an unknown build degrades to
 * `undefined` (no progress) instead of an unresolvable checklist phase.
 */
const LEGACY_CREATION_PHASE_MAP: Partial<
  Record<string, PullRequestCreationPhase>
> = {
  gathering: 'gathering_changes',
  summarizing: 'summarizing',
  pushing: 'pushing',
  creating: 'creating_pr',
};

function toSectionCreationProgress(
  progress: RemoteControlPrCreationProgress,
): PullRequestSectionCreationProgress | undefined {
  if (!isKnownCreationPhase(progress.currentPhase)) return undefined;
  const steps: PullRequestSectionCreationStep[] = [];
  for (const step of progress.steps) {
    if (!isKnownCreationPhase(step.phase)) continue;
    steps.push({
      phase: step.phase,
      ...(step.repoName !== undefined ? { repoName: step.repoName } : {}),
      ...(step.error !== undefined ? { error: step.error } : {}),
    });
  }
  return { steps, currentPhase: progress.currentPhase };
}

function toSectionStatus(
  fields: RemoteControlPrStatusFields,
): PullRequestSectionPrStatus | null {
  if (fields.number === undefined || fields.number === null) {
    return null;
  }
  const checkDetails = toSectionCheckDetails(fields.checkDetails);
  return {
    prNumber: fields.number,
    // Absent URL stays '' — the shared body hides its GitHub links for the
    // empty string instead of rendering a self-navigating anchor.
    prUrl: fields.url ?? '',
    state: toSectionPrState(fields.state),
    title: fields.title ?? '',
    checkDetails:
      checkDetails.length > 0
        ? checkDetails
        : aggregateFallbackCheckDetails(fields.checkStatus),
    reviewStatus: toSectionReviewStatus(fields.reviewStatus),
    labels: fields.labels,
    hasConflicts: fields.hasConflicts === true,
    commentCount: fields.commentCount ?? 0,
    // Desktop-computed via the shared `isPrReadyToMerge`; absent on older
    // payloads, which renders the conservative muted approved tone.
    isMergeReady: fields.mergeReady === true,
  };
}

export function remoteControlPrStatusToSectionModel(
  prStatus: RemoteControlPrStatus | undefined,
): RemoteControlPullRequestSectionModel {
  if (!prStatus) {
    return { isCreating: false };
  }

  // Prefer the per-repo array (CAN-1528 L2) — all repos, enabling the
  // multi-repo grouped rows — and fall back to the flat primary-repo fields
  // older emitters populate.
  const repos: PullRequestSectionRepo[] | undefined =
    prStatus.repos !== undefined && prStatus.repos.length > 0
      ? prStatus.repos.map((repo) => ({
          repoId: repo.repoId,
          repoName: repo.repoName,
          status: repo.status ? toSectionStatus(repo.status) : null,
        }))
      : ((): PullRequestSectionRepo[] | undefined => {
          const status = toSectionStatus(prStatus);
          return status !== null
            ? [{ repoId: 'primary', repoName: '', status }]
            : undefined;
        })();

  const legacyPhase =
    prStatus.creationPhase != null
      ? LEGACY_CREATION_PHASE_MAP[prStatus.creationPhase]
      : undefined;
  const creationProgress: PullRequestSectionCreationProgress | undefined =
    prStatus.creationProgress === null
      ? undefined
      : prStatus.creationProgress !== undefined
        ? toSectionCreationProgress(prStatus.creationProgress)
        : legacyPhase !== undefined
          ? { steps: [], currentPhase: legacyPhase }
          : undefined;

  const isCreating =
    creationProgress !== undefined &&
    creationProgress.currentPhase !== 'done' &&
    creationProgress.currentPhase !== 'error';

  return {
    repos,
    isCreating,
    creationProgress,
  };
}
