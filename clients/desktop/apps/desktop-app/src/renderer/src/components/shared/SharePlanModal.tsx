import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CanopyCloudAccountPublicState,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import {
  SHARED_ORGANIZATION_FALLBACK_NAME,
  SHARED_TEAM_FALLBACK_NAME,
  type ShareReopenedNotice,
  type ShareResourceExistingShare,
  type ShareDialogLink,
  type ShareResourceDialogState,
  type ShareResourceOutcome,
  type ShareResourceScope,
  type ShareResourceShareInput,
  type ShareStopSharing,
} from '@canopy/ui-app/sharing';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { resolveSharedPlanUrl } from '@/lib/share-links';
import { DesktopShareResourceDialog } from './share/DesktopShareResourceDialog';

export type PlanShareScope = 'team' | 'organization';

const SHARE_SCOPES: readonly ShareResourceScope[] = ['team', 'organization'];

// Plan-specific copy for the existing-share view (CAN-5904). Re-scoping a
// plan share is not supported yet, so the audience stays locked and the hint
// names the way out.
const AUDIENCE_LOCKED = {
  hint: 'Stop sharing to choose a different audience.',
} as const;
// The reopened view asks who can see the plan rather than naming a scope.
const REOPENED_COPY = { scopeLegend: 'Who can see it' } as const;
const SYNCED_DETAIL = 'Can read and comment · Live';
const SYNC_FAILED_TITLE = "The last update didn't reach the cloud";
const SYNC_FAILED_FALLBACK = 'The last update failed.';
const RETRY_LABEL = 'Try sharing again';
const STOP_LABEL = 'Stop sharing';
const STOP_TITLE = 'Stop sharing this plan?';
const STOP_BUSY_LABEL = 'Stopping…';
const STOP_TOAST = 'Plan is no longer shared.';

export interface SharePlanShareRequest {
  shareScope: PlanShareScope;
  teamId?: string;
  organizationId?: string;
}

interface SharePlanModalProps {
  planId?: string;
  planTitle?: string;
  existingShare?: TrackedPlanData['share'];
  onClose: () => void;
  onShare: (request: SharePlanShareRequest) => Promise<TrackedPlanData | null>;
  onShared?: (plan: TrackedPlanData) => void;
  /** Stops sharing the plan; resolves the plan with its `share` cleared. */
  onUnshare: () => Promise<TrackedPlanData | null>;
  /** Fires after Stop sharing landed, before the dialog closes. */
  onUnshared?: (plan: TrackedPlanData | null) => void;
}

type AccountDirectory = Pick<
  CanopyCloudAccountPublicState,
  'teams' | 'organizations'
>;

interface PlanShareAudienceNames {
  readonly target: { id: string; name: string; secondaryLabel?: string };
  /** `Team · Organization` or `Organization`, for the notice title. */
  readonly title: string;
}

function planShareAudienceNames(
  share: NonNullable<TrackedPlanData['share']>,
  directory: AccountDirectory | null,
): PlanShareAudienceNames | undefined {
  if (share.shareScope === 'team' && share.teamId) {
    const team = directory?.teams?.find((entry) => entry.id === share.teamId);
    const organizationName =
      team?.organization.name ??
      directory?.organizations?.find(
        (entry) => entry.id === share.organizationId,
      )?.name;
    const name = team?.name ?? SHARED_TEAM_FALLBACK_NAME;
    return {
      target: {
        id: share.teamId,
        name,
        ...(organizationName ? { secondaryLabel: organizationName } : {}),
      },
      title: organizationName ? `${name} · ${organizationName}` : name,
    };
  }
  if (share.shareScope === 'organization' && share.organizationId) {
    const name =
      directory?.organizations?.find(
        (entry) => entry.id === share.organizationId,
      )?.name ?? SHARED_ORGANIZATION_FALLBACK_NAME;
    return { target: { id: share.organizationId, name }, title: name };
  }
  return undefined;
}

function planReopenedNotice(
  share: NonNullable<TrackedPlanData['share']>,
  audienceTitle: string,
): ShareReopenedNotice {
  if (share.syncStatus === 'error') {
    const revision = share.lastSyncedRemoteRevisionNumber;
    return {
      tone: 'attention',
      title: SYNC_FAILED_TITLE,
      details: [
        share.lastSyncError ?? SYNC_FAILED_FALLBACK,
        ...(revision !== undefined
          ? [`Teammates see revision ${String(revision)}.`]
          : []),
      ],
    };
  }
  return {
    tone: 'positive',
    title: `Shared with ${audienceTitle}`,
    details: [SYNCED_DETAIL],
  };
}

/** Tracked-plan upsert binding around the common share dialog. */
export function SharePlanModal({
  planId,
  planTitle,
  existingShare: liveShare,
  onClose,
  onShare,
  onShared,
  onUnshare,
  onUnshared,
}: SharePlanModalProps): JSX.Element {
  // Holds the share while this dialog's Stop sharing lands, so the cleared
  // share does not flash the first-share form before the dialog closes.
  const [heldShare, setHeldShare] = useState<TrackedPlanData['share']>();
  const planShare = liveShare ?? heldShare;
  const pendingPlan = useRef<TrackedPlanData | null>(null);
  const [existingLink, setExistingLink] = useState<ShareDialogLink | null>(
    null,
  );
  const [directory, setDirectory] = useState<AccountDirectory | null>(null);
  const [dialogState, setDialogState] = useState<ShareResourceDialogState>({
    audience:
      planShare?.shareScope === 'team' ||
      planShare?.shareScope === 'organization'
        ? planShare.shareScope
        : null,
    ...(planShare?.shareScope === 'team' && planShare.teamId
      ? { teamId: planShare.teamId }
      : {}),
    ...(planShare?.shareScope === 'organization' && planShare.organizationId
      ? { organizationId: planShare.organizationId }
      : {}),
    available: false,
    busy: false,
    status: 'idle',
    copied: false,
  });
  useEffect(() => {
    let cancelled = false;
    setExistingLink(null);
    const remoteId = planShare?.remoteId;
    if (!remoteId || planShare?.shareScope === 'private') {
      return (): void => {
        cancelled = true;
      };
    }
    void resolveSharedPlanUrl(remoteId).then((url) => {
      if (!cancelled && url) setExistingLink({ url, kind: 'scoped' });
    });
    return (): void => {
      cancelled = true;
    };
  }, [planShare?.remoteId, planShare?.shareScope]);
  // The cached account names the share's team and organization without a
  // network read; the dialog falls back to generic names until it loads.
  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadCanopyCloudAccount()
      .then((account) => {
        if (!cancelled) {
          setDirectory({
            teams: account.teams ?? [],
            organizations: account.organizations ?? [],
          });
        }
      })
      .catch((error: unknown) => {
        // The generic audience names stay in place.
        reportClientAppError(error);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Another window (or the Activity card) stopped sharing while this dialog
  // showed the share: close rather than render the access view without one.
  const openedOnShare = useRef(planShare !== undefined);
  const stoppingHere = useRef(false);
  useEffect(() => {
    if (
      openedOnShare.current &&
      planShare === undefined &&
      !stoppingHere.current
    ) {
      onClose();
    }
  }, [onClose, planShare]);

  const audienceNames = useMemo(
    () =>
      planShare && planShare.shareScope !== 'private'
        ? planShareAudienceNames(planShare, directory)
        : undefined,
    [directory, planShare],
  );
  const existingShare = useMemo((): ShareResourceExistingShare | undefined => {
    if (!planShare || planShare.shareScope === 'private') return undefined;
    return {
      audience: planShare.shareScope,
      ...(audienceNames ? { target: audienceNames.target } : {}),
      ...(existingLink ? { link: existingLink } : {}),
    };
  }, [audienceNames, existingLink, planShare]);

  const share = useCallback(
    async (input: ShareResourceShareInput): Promise<ShareResourceOutcome> => {
      const plan = await onShare({
        shareScope: input.scope as PlanShareScope,
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.organizationId
          ? { organizationId: input.organizationId }
          : {}),
      });
      if (!plan) throw new Error('The plan could not be shared.');
      pendingPlan.current = plan;
      // The dialog's success notice carries the link; best-effort, so the
      // notice still shows without one when the cloud base URL is unavailable.
      const remoteId = plan.share?.remoteId;
      const shareUrl = remoteId ? await resolveSharedPlanUrl(remoteId) : null;
      return shareUrl ? { shareUrl } : {};
    },
    [onShare],
  );

  const handleCompleted = useCallback((): void => {
    if (!pendingPlan.current) return;
    const plan = pendingPlan.current;
    onShared?.(plan);
    pendingPlan.current = null;
  }, [onShared]);

  // A share stored without its team or organization id has no account name
  // to look up; it still names a generic audience so it can be stopped.
  const fallbackAudienceName =
    planShare?.shareScope === 'team'
      ? SHARED_TEAM_FALLBACK_NAME
      : SHARED_ORGANIZATION_FALLBACK_NAME;
  const stopSharing = useMemo((): ShareStopSharing | undefined => {
    if (!existingShare) return undefined;
    const audienceName = audienceNames?.target.name ?? fallbackAudienceName;
    return {
      label: STOP_LABEL,
      confirm: {
        title: STOP_TITLE,
        body: `${audienceName} will lose access, and comments on the shared copy will be deleted. Sharing again creates a new link.`,
        busyLabel: STOP_BUSY_LABEL,
      },
      onStop: async (): Promise<void> => {
        stoppingHere.current = true;
        setHeldShare(planShare);
        try {
          const plan = await onUnshare();
          onUnshared?.(plan);
        } catch (error) {
          stoppingHere.current = false;
          setHeldShare(undefined);
          throw error;
        }
      },
      toast: STOP_TOAST,
    };
  }, [
    audienceNames,
    existingShare,
    fallbackAudienceName,
    onUnshare,
    onUnshared,
    planShare,
  ]);

  // A share whose last push failed retries the same audience: the push is
  // the only thing that changes. A share stored without its team or
  // organization id can't name that audience, so it offers only Stop sharing.
  const retry = useMemo(() => {
    if (
      !planShare ||
      planShare.syncStatus !== 'error' ||
      (planShare.shareScope !== 'team' &&
        planShare.shareScope !== 'organization') ||
      (planShare.shareScope === 'team'
        ? !planShare.teamId
        : !planShare.organizationId)
    ) {
      return undefined;
    }
    const request: SharePlanShareRequest = {
      shareScope: planShare.shareScope,
      ...(planShare.teamId ? { teamId: planShare.teamId } : {}),
      ...(planShare.organizationId
        ? { organizationId: planShare.organizationId }
        : {}),
    };
    return {
      label: RETRY_LABEL,
      onRetry: async (): Promise<void> => {
        const plan = await onShare(request);
        if (!plan) throw new Error('The plan could not be shared.');
        onShared?.(plan);
      },
    };
  }, [onShare, onShared, planShare]);

  useCurrentUiStateReporter('plans.shareModal', {
    open: true,
    ...(planId ? { planId } : {}),
    ...(planTitle ? { planTitle } : {}),
    ...(dialogState.audience ? { scope: dialogState.audience } : {}),
    busy: dialogState.busy,
    ...(dialogState.teamId ? { teamId: dialogState.teamId } : {}),
    ...(dialogState.organizationId
      ? { organizationId: dialogState.organizationId }
      : {}),
  });

  return (
    <DesktopShareResourceDialog
      resourceNoun="plan"
      testIdPrefix="share-plan"
      requiredCapability="plans-crud-v1"
      scopes={SHARE_SCOPES}
      subtitle={planTitle}
      {...(existingShare
        ? {
            existingShare,
            copy: REOPENED_COPY,
            audienceLocked: AUDIENCE_LOCKED,
            ...(planShare
              ? {
                  reopenedNotice: planReopenedNotice(
                    planShare,
                    audienceNames?.title ?? fallbackAudienceName,
                  ),
                }
              : {}),
          }
        : {})}
      {...(stopSharing ? { stopSharing } : {})}
      {...(retry ? { retry } : {})}
      share={share}
      onClose={onClose}
      onCompleted={handleCompleted}
      onStateChange={setDialogState}
    />
  );
}
