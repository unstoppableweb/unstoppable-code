import { Stack } from '@canopy/ui-shared/components';
/**
 * Fork a shared container into a private local copy (CAN-2552).
 *
 * Two steps in one dialog, deliberately not one:
 *
 * 1. **Destination.** Where the copy lands. A code share needs a git-backed
 *    workspace, a Cowork share needs a Cowork workspace, and neither can be
 *    inferred, so the choice is explicit rather than defaulted-and-explained.
 * 2. **Disclosures.** Three things a recipient cannot discover afterwards and
 *    would reasonably assume the opposite of: the copy never synchronizes
 *    again, revocation cannot recall it, and agent history arrives readable
 *    but not resumable.
 *
 * The disclosures come second on purpose. Reading "this never syncs again"
 * before knowing where it lands is abstract; reading it with a named
 * destination on screen is a decision. Each shows as one short line; the
 * longer explanations and the full list of runnable scripts sit behind
 * Show details.
 *
 * A finished copy opens straight away and the dialog closes (CAN-3710); the
 * copy's own "forked from" notice carries its provenance from there. Opening
 * puts the copy in front: the share viewer closes, the sidebar enters the
 * copy's owning context, and focus moves to the copy (CAN-4782). The success
 * toast names that context when it changed and offers Open copy to return.
 *
 * Compatibility is main's call, not this dialog's. There is no
 * "list compatible workspaces" query, and inventing a renderer-side remote-URL
 * match would be a second, weaker copy of `matchExistingWorkspace()` that
 * could disagree with it. Every workspace of the right kind is offered and a
 * mismatch comes back as main's own message.
 *
 * Ownership is not a choice either (CAN-4781). An organization-access share's
 * copy belongs to that organization and a direct share's copy to Personal;
 * both steps name it, and the payload carries it for main to check against the
 * accepted share. The active context, the context switcher and the flags play
 * no part, so an organization share never falls back to Personal.
 *
 * The copy is of one reviewed revision (CAN-4908). The dialog pins the
 * readable revision it opened on and names it by publication time. A newer
 * revision arriving while it is open is disclosed, and final submission waits
 * until the user takes it with Use updated version; nothing re-pins silently.
 * Make a copy re-reads main's replica state first to catch an update this
 * dialog missed, then freezes the reviewed ID for that request. Main's read
 * guard stays authoritative for any race after that and refuses rather than
 * substituting another revision.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type {
  SharedContainerAccess,
  SharedContainerForkDestination,
  SharedContainerForkResponse,
} from '@canopy/desktop-shared/types';
import type {
  SharedContainerRevisionPackage,
  SharedContainerType,
} from '@canopy/protocol/shared-containers';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { workspaceOwnerMatchesContext } from '@canopy/execution-engine/lib/workspace-owner';
import { formatCapabilityPackageForkDisclosure } from '@canopy/ui-shared/sharing';
import { workspaceContextDisplayLabel } from '@canopy/execution-engine/lib/automation-context-copy';
import { Button } from '@/components/shared/Button';
import { DialogModal } from '@/components/shared/DialogModal';
import { brandText } from '@/lib/brand';
import { openForkedContainer } from '@/lib/shared-containers/open-forked-container';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { workspaceContextLabel } from '@/lib/automationContextScope';
import { formatRevisionTime } from '@/lib/shared-containers/revision-time';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useSharedContainerRecipientActions } from './useSharedContainerRecipientActions';
import {
  readForkRevision,
  type SharedContainerForkRevision,
} from './useSharedContainerForkRevision';
import { RevisionTime } from './RevisionTime';
import {
  ChoiceList,
  ChoiceListRow,
  DialogFormField,
  Disclosure,
  ErrorBanner,
  SettingsSelect,
  Surface,
  TextInput,
} from '@canopy/ui-shared/components';

export interface SharedContainerForkModalProps {
  containerId: string;
  /** Absent for a personal container shared directly. */
  organizationId?: string;
  access: SharedContainerAccess;
  /**
   * The host's current readable revision: the one on screen for the viewer,
   * main's live state for a row menu. The dialog pins its own reviewed copy.
   */
  revision: SharedContainerForkRevision;
  containerType: SharedContainerType;
  title: string;
  /**
   * Publisher display name. Optional because the members-directory lookup that
   * resolves it is lazy and can still be in flight; the request requires a
   * non-empty name, so an unresolved one falls back rather than blocking the
   * fork behind a directory read.
   */
  ownerName?: string;
  onClose: () => void;
}

type DestinationKind = 'new' | 'existing';

const OPEN_COPY_LABEL = 'Open copy';

function partialCopyNote(response: SharedContainerForkResponse): string {
  return response.warnings.length > 0
    ? ` ${brandText.appName} could not bring everything across.`
    : '';
}

/**
 * Toast for a copy that exists but could not be put in front. The sidebar may
 * not show it yet (it can be in another context, or missing from the refreshed
 * list), so the toast offers a retry instead of pointing there.
 */
function addOpenFailedToast(
  message: string,
  response: SharedContainerForkResponse,
): void {
  useGitHubStore.getState().addToast(message, 'error', undefined, {
    projectId: response.projectId,
    worktreeId: response.worktreeId,
    action: {
      label: OPEN_COPY_LABEL,
      onClick: (): void => reopenCopy(response),
    },
    forceInApp: true,
    suppressOsNotification: true,
  });
}

/**
 * Open copy on a toast. Lives outside the dialog so it still works after the
 * dialog unmounts. It reveals the existing copy again and never forks, and a
 * success adds no toast: the copy coming to the front is the feedback.
 */
function reopenCopy(response: SharedContainerForkResponse): void {
  void openForkedContainer(response).catch(() => {
    addOpenFailedToast("The copy couldn't be opened.", response);
  });
}

/** Put a just-made copy in front and report the outcome on one toast. */
async function revealNewCopy(
  response: SharedContainerForkResponse,
): Promise<void> {
  try {
    const { switchedTo } = await openForkedContainer(response);
    const destination =
      switchedTo === null
        ? ''
        : ` in ${workspaceContextDisplayLabel(
            switchedTo,
            useWorkspaceContextStore.getState().state.organizations,
          )}`;
    useGitHubStore
      .getState()
      .addToast(
        `Copy made${destination}.${partialCopyNote(response)}`,
        response.warnings.length > 0 ? 'warning' : 'success',
        undefined,
        {
          projectId: response.projectId,
          worktreeId: response.worktreeId,
          action: {
            label: OPEN_COPY_LABEL,
            onClick: (): void => reopenCopy(response),
          },
          forceInApp: true,
          suppressOsNotification: true,
        },
      );
  } catch {
    addOpenFailedToast(
      `Copy made, but it couldn't be opened.${partialCopyNote(response)}`,
      response,
    );
  }
}
type Step = 'destination' | 'confirm';

interface ReviewedRevision {
  revisionId: string;
  revisionCreatedAt: string;
  capabilityPackage?: SharedContainerRevisionPackage;
}

function revisionBasis(revision: SharedContainerForkRevision): string {
  return revision.status === 'available'
    ? `${revision.revisionId}\u0000${revision.revisionCreatedAt}`
    : revision.status;
}

export function SharedContainerForkModal(
  props: SharedContainerForkModalProps,
): JSX.Element {
  return (
    <SharedContainerForkReview
      key={`${props.containerId}\u0000${props.organizationId ?? ''}\u0000${props.access}`}
      {...props}
    />
  );
}

function SharedContainerForkReview({
  containerId,
  organizationId,
  access,
  revision,
  containerType,
  title,
  ownerName: rawOwnerName,
  onClose,
}: SharedContainerForkModalProps): JSX.Element {
  const ownerName = rawOwnerName?.trim() || 'a teammate';
  const ownerKnown = ownerName === rawOwnerName?.trim();
  // A real owner name is a person's identity: replay records a box for it.
  // The generic fallback stays recorded.
  const ownerLabel = ownerKnown ? (
    <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{ownerName}</span>
  ) : (
    ownerName
  );
  const ownerSentenceLabel = ownerKnown ? ownerLabel : 'A teammate';
  const isCowork = containerType === 'COWORK_WORK_ENTRY';
  const projects = useProjectsStore((state) => state.projects);
  const organizations = useWorkspaceContextStore(
    (state) => state.state.organizations,
  );
  const actions = useSharedContainerRecipientActions(
    containerId,
    organizationId,
  );

  // `null` is an organization share whose organization is unknown: an
  // explicit unavailable state, never a Personal default.
  const owningContext = useMemo((): WorkspaceContext | null => {
    if (access === 'direct') return { kind: 'personal' };
    return organizationId ? { kind: 'organization', organizationId } : null;
  }, [access, organizationId]);
  const contextName =
    owningContext === null
      ? null
      : workspaceContextLabel(owningContext, organizations, 'the organization');

  // Only workspaces the context owns. Main rejects a linked Personal checkout
  // as an organization destination, so offering one would only fail later.
  const candidates = useMemo(
    () =>
      owningContext === null
        ? []
        : projects.filter(
            (item) =>
              (isCowork ? item.type === 'cowork' : item.type !== 'cowork') &&
              workspaceOwnerMatchesContext(item.owner, owningContext),
          ),
    [isCowork, owningContext, projects],
  );

  const [step, setStep] = useState<Step>('destination');
  const [kind, setKind] = useState<DestinationKind>('new');
  const [workspaceId, setWorkspaceId] = useState('');
  const [parentDirectory, setParentDirectory] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  // The revision under review, pinned once and replaced only by the user.
  const [reviewed, setReviewed] = useState<ReviewedRevision | null>(() =>
    revision.status === 'available'
      ? {
          revisionId: revision.revisionId,
          revisionCreatedAt: revision.revisionCreatedAt,
          capabilityPackage: revision.capabilityPackage,
        }
      : null,
  );
  // Main's answer to a pre-submit re-read. It stands only until the host's
  // own value next changes, which is newer by definition.
  const [checked, setChecked] = useState<{
    basis: string;
    revision: SharedContainerForkRevision;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const active = useRef(true);
  const basis = revisionBasis(revision);
  const hostGeneration = useRef(0);
  useEffect(() => {
    hostGeneration.current += 1;
  }, [basis]);
  useEffect(() => {
    active.current = true;
    return (): void => {
      active.current = false;
    };
  }, []);
  const latest =
    checked !== null && checked.basis === basis ? checked.revision : revision;

  // Capture the first readable revision, and retain metadata corrections for
  // that same identity. Only the user can adopt a different revision ID.
  const refreshedSelection =
    latest.status === 'available' &&
    (reviewed === null ||
      (latest.revisionId === reviewed.revisionId &&
        latest.revisionCreatedAt !== reviewed.revisionCreatedAt))
      ? latest
      : null;
  useEffect(() => {
    if (refreshedSelection === null) return;
    setReviewed({
      revisionId: refreshedSelection.revisionId,
      revisionCreatedAt: refreshedSelection.revisionCreatedAt,
      capabilityPackage: refreshedSelection.capabilityPackage,
    });
  }, [refreshedSelection]);

  const updated =
    reviewed !== null &&
    latest.status === 'available' &&
    latest.revisionId !== reviewed.revisionId
      ? latest
      : null;
  const unavailable = latest.status === 'unavailable';
  // The same ID with a new time is a metadata refresh, not a newer version.
  const reviewedTime = formatRevisionTime(
    reviewed !== null &&
      latest.status === 'available' &&
      latest.revisionId === reviewed.revisionId
      ? latest.revisionCreatedAt
      : reviewed?.revisionCreatedAt,
  );
  const updatedTime = formatRevisionTime(updated?.revisionCreatedAt);
  const busy = submitting || actions.forking;
  const capabilityDisclosure = reviewed?.capabilityPackage
    ? formatCapabilityPackageForkDisclosure(reviewed.capabilityPackage)
    : null;

  // A copy's focus request waits for this dialog to go, so its dismissal
  // cannot leave focus on the old Make a copy control.
  useEffect(() => useNavigationStore.getState().holdForkedContainerFocus(), []);

  useEffect(() => {
    // The clone directory is only meaningful when main has to promote the
    // replica's checkouts, which is the new-workspace code path alone.
    if (isCowork || kind !== 'new' || parentDirectory) return;
    let canceled = false;
    void window.api
      .getDefaultCloneDirectory()
      .then((directory) => {
        if (!canceled) setParentDirectory(directory);
      })
      .catch(() => {
        // Leaving the field blank is safe: main falls back to the same default
        // when `parentDirectory` is omitted.
      });
    return (): void => {
      canceled = true;
    };
  }, [isCowork, kind, parentDirectory]);

  // A chosen workspace that left the candidates (deleted, or no longer owned
  // by this context) is no longer a choice, on either step.
  const selectedWorkspace = candidates.find((item) => item.id === workspaceId);
  const destination: SharedContainerForkDestination | null =
    owningContext === null
      ? null
      : kind === 'existing'
        ? selectedWorkspace
          ? { kind: 'existing-workspace', workspaceId: selectedWorkspace.id }
          : null
        : {
            kind: 'new-workspace',
            owner: owningContext,
            ...(isCowork || !parentDirectory.trim()
              ? {}
              : { parentDirectory: parentDirectory.trim() }),
          };

  const canContinue = destination !== null;

  useEffect(() => {
    if (step === 'confirm' && !canContinue && !actions.forking) {
      setStep('destination');
    }
  }, [actions.forking, canContinue, step]);

  const handleBrowse = async (): Promise<void> => {
    const selection = await window.api.browseForCloneDirectory();
    if (!selection.canceled && selection.directoryPath) {
      setParentDirectory(selection.directoryPath);
    }
  };

  /** Re-reads main's state; true when `revisionId` is still the readable one. */
  const recheckRevision = async (revisionId: string): Promise<boolean> => {
    const requestBasis = basis;
    const generation = hostGeneration.current;
    const current = await readForkRevision(containerId);
    // A host event or a different dialog invalidates this pending read.
    // In particular, an older answer must not authorize a stale submission.
    if (!active.current || generation !== hostGeneration.current) return false;
    setChecked({ basis: requestBasis, revision: current });
    return current.status === 'available' && current.revisionId === revisionId;
  };

  const handleFork = (): void => {
    if (
      destination === null ||
      reviewed === null ||
      busy ||
      submittingRef.current ||
      latest.status !== 'available' ||
      updated !== null
    )
      return;
    submittingRef.current = true;
    // Frozen for this request: later updates only affect the next review.
    const request = {
      revisionId: reviewed.revisionId,
      ...(reviewed.capabilityPackage
        ? { expectedPackageDigest: reviewed.capabilityPackage.digest }
        : {}),
      sourceOwnerDisplayName: ownerName,
      destination,
    };
    setError(null);
    setSubmitting(true);
    void recheckRevision(request.revisionId)
      .then(async (current) => {
        // A missed update or a lost replica is now on screen; the user
        // reviews it before anything is submitted.
        if (!current) return;
        const outcome = await actions.fork(request);
        if (!active.current) return;
        if (outcome.status === 'in-flight') return;
        if (outcome.status === 'failed') {
          setError(outcome.message);
          if (outcome.code === 'source-unavailable') {
            // About the source, not the destination: stay put and surface
            // whatever replaced it for review. Never retried automatically.
            await recheckRevision(request.revisionId);
            return;
          }
          // Back to the destination step: the remaining refusals are about
          // the destination, so leaving the user on the disclosures would
          // hide the only control that fixes it.
          setStep('destination');
          return;
        }
        openCopy(outcome.response);
      })
      .finally(() => {
        submittingRef.current = false;
        if (active.current) setSubmitting(false);
      });
  };

  const handleUseUpdated = (): void => {
    if (updated === null) return;
    setReviewed({
      revisionId: updated.revisionId,
      revisionCreatedAt: updated.revisionCreatedAt,
      capabilityPackage: updated.capabilityPackage,
    });
    setError(null);
    // Back to the confirmation so the new version is what gets reviewed.
    if (canContinue) setStep('confirm');
  };

  const openCopy = (response: SharedContainerForkResponse): void => {
    void revealNewCopy(response)
      // The fork succeeded and the copy exists, so pinning the dialog open
      // would misrepresent the outcome; the toast's Open copy is the retry.
      .finally(() => onClose());
  };

  return (
    <DialogModal
      onClose={busy ? (): void => {} : onClose}
      title="Make a copy of this share"
      maxWidth="md"
      headerBorder={false}
      closeOnBackdrop={!busy}
      dataTestId="shared-container-fork-modal"
    >
      <div className="flex flex-col gap-4">
        {/* Polite live region: announced on either step, focus stays put. */}
        <div role="status" aria-live="polite">
          {updated !== null && (
            <Surface
              variant="outline"
              size="small"
              data-testid="shared-container-fork-revision-update"
            >
              <div className="flex flex-col items-start gap-2 px-3 py-2">
                <p className="text-s fg-primary">
                  {ownerSentenceLabel} published a newer version
                  {updatedTime !== null && (
                    <>
                      {' '}
                      at <RevisionTime label={updatedTime} />
                    </>
                  )}{' '}
                  while this was open. Review it before making your copy.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  data-testid="shared-container-fork-revision-accept"
                  onClick={handleUseUpdated}
                >
                  Use updated version
                </Button>
              </div>
            </Surface>
          )}
          {unavailable && (
            <ErrorBanner
              errorSource="shared-container-fork-revision-unavailable"
              className=""
              testId="shared-container-fork-revision-unavailable"
              error="This share can't be copied right now. Open it again, then make your copy."
            />
          )}
        </div>

        {step === 'destination' && (
          <div
            className="flex flex-col gap-3"
            data-testid="shared-container-fork-destination"
          >
            <p className="text-s fg-secondary">
              Make your own copy of{' '}
              <span className="font-medium fg-primary">{title}</span> that you
              can edit and run.
            </p>

            {owningContext === null && (
              <ErrorBanner
                errorSource="shared-container-fork-context-unavailable"
                className=""
                testId="shared-container-fork-context-unavailable"
                error="This share's organization couldn't be identified, so a copy can't be made right now."
              />
            )}

            <ChoiceList kind="radio" aria-label="Destination">
              <ChoiceListRow
                kind="radio"
                data-testid="shared-container-fork-destination-new"
                selected={kind === 'new'}
                onClick={(): void => setKind('new')}
              >
                <span className="block">
                  {isCowork ? 'New Cowork project' : 'New workspace'}
                </span>
                <span className="block text-xs fg-quaternary">
                  {isCowork
                    ? 'Creates a project just for this copy.'
                    : 'Copies the repositories to this computer and sets up a workspace around them.'}
                </span>
              </ChoiceListRow>
              <ChoiceListRow
                kind="radio"
                data-testid="shared-container-fork-destination-existing"
                selected={kind === 'existing'}
                disabled={candidates.length === 0}
                onClick={(): void => setKind('existing')}
              >
                <span className="block">
                  {isCowork
                    ? 'An existing Cowork project'
                    : 'An existing workspace'}
                </span>
                <span className="block text-xs fg-quaternary">
                  {candidates.length === 0 ? (
                    owningContext === null ? (
                      'Unavailable until the organization is known.'
                    ) : isCowork ? (
                      <>No Cowork projects in {contextName}.</>
                    ) : (
                      <>No compatible workspaces in {contextName}.</>
                    )
                  ) : isCowork ? (
                    'Adds the copy as a new entry in a project you already have.'
                  ) : (
                    'Only works in a workspace that already has the same repositories.'
                  )}
                </span>
              </ChoiceListRow>
            </ChoiceList>

            {kind === 'new' && owningContext !== null && (
              <p
                className="pl-6 text-xs fg-quaternary"
                data-testid="shared-container-fork-destination-context"
              >
                Belongs to{' '}
                <span className="font-medium fg-primary">{contextName}</span>
              </p>
            )}

            {kind === 'new' && !isCowork && (
              <div className="flex flex-col gap-1 pl-6">
                <span
                  id="shared-container-fork-location-label"
                  className="text-xs fg-quaternary"
                >
                  Save the code in
                </span>
                <div className="flex items-center gap-2">
                  <TextInput
                    type="text"
                    density="compact"
                    aria-labelledby="shared-container-fork-location-label"
                    data-testid="shared-container-fork-location"
                    value={parentDirectory}
                    onChange={(event): void =>
                      setParentDirectory(event.currentTarget.value)
                    }
                    className="min-w-0 flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="shared-container-fork-browse"
                    onClick={(): void => void handleBrowse()}
                  >
                    Browse
                  </Button>
                </div>
              </div>
            )}

            {kind === 'existing' && candidates.length > 0 && (
              <div className="pl-6">
                <DialogFormField
                  htmlFor="shared-container-fork-workspace"
                  label={
                    <span data-testid="shared-container-fork-workspace-context">
                      Projects in {contextName}
                    </span>
                  }
                >
                  <SettingsSelect
                    id="shared-container-fork-workspace"
                    data-testid="shared-container-fork-workspace"
                    value={selectedWorkspace ? workspaceId : null}
                    onValueChange={setWorkspaceId}
                    placeholder="Choose a project"
                    replayPrivacy={{ maskClassName: POSTHOG_REPLAY_MASK_CLASS }}
                    options={candidates.map((item) => ({
                      value: item.id,
                      label: item.name,
                    }))}
                  />
                </DialogFormField>
              </div>
            )}
          </div>
        )}

        {step === 'confirm' && (
          <div
            className="flex flex-col gap-3"
            data-testid="shared-container-fork-disclosures"
          >
            <p
              className="text-s fg-secondary"
              data-testid="shared-container-fork-revision"
              data-revision-id={reviewed?.revisionId}
            >
              {reviewed === null ? (
                'Checking which version this copies…'
              ) : (
                <>
                  Copies {ownerLabel}&rsquo;s latest available version (
                  {reviewedTime === null ? (
                    'update time unavailable'
                  ) : (
                    <>
                      updated <RevisionTime label={reviewedTime} />
                    </>
                  )}
                  ).
                </>
              )}
            </p>
            <p
              className="text-s fg-secondary"
              data-testid="shared-container-fork-disclosures-destination"
            >
              {selectedWorkspace && kind === 'existing' ? (
                <>
                  Your copy will be added to{' '}
                  <span
                    className={`font-medium fg-primary ${POSTHOG_REPLAY_MASK_CLASS}`}
                  >
                    {selectedWorkspace.name}
                  </span>{' '}
                  in{' '}
                  <span className="font-medium fg-primary">{contextName}</span>.
                </>
              ) : (
                <>
                  Your copy will be made in{' '}
                  <span className="font-medium fg-primary">{contextName}</span>.
                </>
              )}
            </p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-s fg-secondary">
              <li>
                Your copy is independent, and {ownerLabel} can&apos;t take it
                back.
              </li>
              <li>Chats come over as read-only history.</li>
              {capabilityDisclosure !== null && (
                <li data-testid="shared-container-fork-capabilities">
                  {capabilityDisclosure.summary}
                </li>
              )}
            </ul>
            <Disclosure
              label={showDetails ? 'Hide details' : 'Show details'}
              open={showDetails}
              onOpenChange={setShowDetails}
              dataTestId="shared-container-fork-details-disclosure"
              toggleTestId="shared-container-fork-details-toggle"
            >
              <ul
                className="flex list-disc flex-col gap-1 pl-5 text-xs fg-secondary"
                data-testid="shared-container-fork-details"
              >
                <li>Changes don&apos;t sync between your copy and theirs.</li>
                <li>
                  Losing access to the share later doesn&apos;t remove your
                  copy. The key for this version stays with you.
                </li>
                <li>You can read past chats but can&apos;t continue them.</li>
                {capabilityDisclosure?.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
                {capabilityDisclosure !== null &&
                  capabilityDisclosure.scripts.length > 0 && (
                    <li data-testid="shared-container-fork-scripts">
                      <Stack gap="tight">
                        Scripts that can run on this computer:
                        <ul className="flex flex-col gap-0.5">
                          {capabilityDisclosure.scripts.map((script) => (
                            <li
                              key={script}
                              className="break-all font-mono fg-primary"
                            >
                              {script}
                            </li>
                          ))}
                        </ul>
                      </Stack>
                    </li>
                  )}
              </ul>
            </Disclosure>
          </div>
        )}

        {/* Main's refusals can name the share's owner. */}
        <ErrorBanner
          errorSource="shared-container-fork-error"
          className=""
          error={error}
          testId="shared-container-fork-error"
          blockMessageFromReplay
        />

        <div className="flex justify-end gap-2">
          {step === 'destination' && (
            <Button
              variant="primary"
              size="lg"
              disabled={!canContinue}
              data-testid="shared-container-fork-continue"
              onClick={(): void => {
                setError(null);
                setStep('confirm');
              }}
            >
              Continue
            </Button>
          )}
          {step === 'confirm' && (
            <>
              <Button
                variant="outline"
                size="lg"
                disabled={busy}
                onClick={(): void => setStep('destination')}
              >
                Back
              </Button>
              <Button
                variant="primary"
                size="lg"
                disabled={
                  busy ||
                  destination === null ||
                  reviewed === null ||
                  updated !== null ||
                  latest.status !== 'available'
                }
                data-testid="shared-container-fork-confirm"
                onClick={handleFork}
              >
                {busy ? 'Copying…' : 'Make a copy'}
              </Button>
            </>
          )}
        </div>
      </div>
    </DialogModal>
  );
}
