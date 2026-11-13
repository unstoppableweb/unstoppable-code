import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useScopeCapabilities } from '@/hooks/useScopeCapabilities';
import {
  useSuggestionCornerOffer,
  type SuggestionCornerModel,
} from '@canopy/ui-app/suggestions';
import { PluginsIcon, SkillIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  shareTargetKey,
  type PendingSkillShareNudge,
  type SkillShareTarget as ShareTarget,
  type SkillShareNudgeResolution,
} from '@canopy/desktop-shared/lib/skill-share-nudge';
import { useChatShareData } from '@/hooks/useChatShareData';
import {
  resolveShareTarget,
  shareAudienceForTarget,
} from '@/lib/invocableShareTarget';
import {
  requestShare,
  reportSkillShareNudgeResolution,
  forgetAcknowledgedNudgeResolutions,
  subscribeShareCompleted,
  useShareHostAvailable,
  useShareRequestStore,
} from '@/stores/shareRequestStore';

/** Copy for the usage nudge; the Notice gallery quotes the same strings. */
export const SKILL_SHARE_NUDGE_COPY = {
  title: (name: string): string => `You use ${name} often`,
  skillMessage: 'Share it so others can use it too.',
  pluginMessage: 'Share the plugin so others can use its skills too.',
  action: 'Share',
  notNow: 'Not now',
} as const;

type Evaluation =
  /** Data, authentication or audience is not known yet: wait, keep pending. */
  | { status: 'unknown' }
  /** Confirmed missing or unshareable. */
  | { status: 'ineligible' }
  /** Confirmed already shared somewhere. */
  | { status: 'shared' }
  | { status: 'eligible'; displayName: string };

interface SkillShareNudgeBannerProps {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** Hidden while a turn streams; a hidden banner is never reported shown. */
  streaming: boolean;
  /** Whether this composer is actually on screen (not a background mount). */
  isComposerVisible: () => boolean;
}

/**
 * Suggests sharing a skill or plugin the user keeps reaching for (CAN-3611).
 *
 * Main owns the count and the once-ever state; this producer only decides
 * whether the chat's pending target can honestly be suggested right now, and
 * offers it to the shared suggestion corner (CAN-4343) while its composer is
 * on screen. It reports `shown` only once the corner really displays it, so a
 * hidden, streaming, background, host-less or refused offer never spends the
 * one suggestion. Unknown data keeps the target pending and is retried when
 * the cache changes.
 */
export function SkillShareNudgeBanner({
  projectId,
  worktreeId,
  chatId,
  streaming,
  isComposerVisible,
}: SkillShareNudgeBannerProps): JSX.Element | null {
  const originKey = JSON.stringify([projectId, worktreeId, chatId]);
  const [snapshot, setSnapshot] = useState<{
    originKey: string;
    pending: PendingSkillShareNudge | null;
  } | null>(null);
  const pending = snapshot?.originKey === originKey ? snapshot.pending : null;
  const resolutionIntent = useShareRequestStore((state) =>
    pending
      ? state.nudgeResolutions[pending.id]?.request.resolution
      : undefined,
  );
  const hostAvailable = useShareHostAvailable();
  const data = useChatShareData(pending !== null, pending?.id);

  // Read the chat's pending target, and re-read whenever main says it moved.
  // Nudges are for skills the local runtime made.
  const { localExecution } = useScopeCapabilities({ projectId });
  useEffect(() => {
    if (localExecution !== true) return undefined;
    let cancelled = false;
    let sequence = 0;
    const origin = { projectId, worktreeId, chatId };
    const load = (): void => {
      const currentSequence = ++sequence;
      window.skillShareNudge
        .getPending(origin)
        .then((result) => {
          if (cancelled || currentSequence !== sequence) return;
          if (result.success)
            forgetAcknowledgedNudgeResolutions(origin, result.data?.id ?? null);
          setSnapshot({
            originKey,
            pending: result.success ? (result.data ?? null) : null,
          });
        })
        .catch(() => {
          if (!cancelled && currentSequence === sequence)
            setSnapshot({ originKey, pending: null });
        });
    };
    setSnapshot(null);
    load();
    const unsubscribe = window.skillShareNudge.onChanged((changed) => {
      if (
        changed.projectId === projectId &&
        changed.worktreeId === worktreeId &&
        changed.chatId === chatId
      )
        load();
    });
    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, [chatId, localExecution, originKey, projectId, worktreeId]);

  const evaluation = useMemo((): Evaluation | null => {
    if (!pending) return null;
    const resolution = resolveShareTarget(
      pending.target,
      data.skillsSettled ? data.installedSkills : null,
      data.marketplacesSettled ? data.marketplaces : null,
    );
    if (resolution.status === 'unknown') return { status: 'unknown' };
    if (resolution.status === 'ineligible') return { status: 'ineligible' };
    const audience = shareAudienceForTarget(pending.target, data);
    if (audience.status === 'unknown') return { status: 'unknown' };
    if (audience.status === 'shared') return { status: 'shared' };
    return {
      status: 'eligible',
      displayName: resolution.resolved.displayName,
    };
  }, [data, pending]);

  /**
   * Persists a resolution for exactly the pending target it was decided for.
   * Each (pending id, resolution) is sent once; a failed write is retried
   * later without touching what is on screen.
   */
  const report = useCallback(
    (
      current: PendingSkillShareNudge,
      target: ShareTarget,
      resolution: SkillShareNudgeResolution,
    ): void => {
      reportSkillShareNudgeResolution({
        projectId,
        worktreeId,
        chatId,
        pendingId: current.id,
        target,
        resolution,
      });
    },
    [projectId, worktreeId, chatId],
  );

  const status = evaluation?.status ?? null;
  const locallySettled =
    resolutionIntent !== undefined && resolutionIntent !== 'shown';
  const visible =
    status === 'eligible' && hostAvailable && !streaming && !locallySettled;

  // Confirmed outcomes that need no banner. A target that was never shown is
  // ineligible; one already on screen that turns out shared (from any entry
  // point) is recorded as shared.
  useEffect(() => {
    if (!pending || locallySettled) return;
    if (status === 'shared') {
      report(
        pending,
        pending.target,
        pending.state === 'shown' ? 'shared' : 'ineligible',
      );
    } else if (status === 'ineligible') {
      report(
        pending,
        pending.target,
        pending.state === 'shown' ? 'dismissed' : 'ineligible',
      );
    }
  }, [locallySettled, pending, report, status]);

  // Offer only while this composer is on screen. A composer mounted behind
  // another page becomes visible without any of this producer's inputs
  // changing, so the check runs after every render.
  const [composerShown, setComposerShown] = useState(false);
  useEffect(() => {
    const shown = visible && isComposerVisible();
    if (shown !== composerShown) setComposerShown(shown);
  });

  // Only a completed share counts, whichever entry point it came from.
  // Closing or cancelling the dialog leaves the banner in place.
  useEffect(() => {
    if (!pending) return;
    const key = shareTargetKey(pending.target);
    return subscribeShareCompleted((request) => {
      if (
        request.target.kind === 'pipeline' ||
        shareTargetKey(request.target) !== key
      )
        return;
      report(pending, pending.target, 'shared');
    });
  }, [pending, report]);

  if (
    !pending ||
    !visible ||
    !composerShown ||
    evaluation?.status !== 'eligible'
  )
    return null;
  return (
    <SkillShareNudgeOffer
      // A new pending target is a new offer: callbacks never act on another.
      key={pending.id}
      pending={pending}
      displayName={evaluation.displayName}
      origin={{ projectId, worktreeId, chatId }}
      report={report}
    />
  );
}

interface SkillShareNudgeOfferProps {
  pending: PendingSkillShareNudge;
  displayName: string;
  origin: { projectId: string; worktreeId: string; chatId: string };
  report: (
    current: PendingSkillShareNudge,
    target: ShareTarget,
    resolution: SkillShareNudgeResolution,
  ) => void;
}

/** One pending target's corner card. */
function SkillShareNudgeOffer({
  pending,
  displayName,
  origin,
  report,
}: SkillShareNudgeOfferProps): null {
  const { projectId, worktreeId, chatId } = origin;
  const model = useMemo((): SuggestionCornerModel => {
    const isPlugin = pending.target.kind === 'plugin';
    const dismiss = (): void => {
      report(pending, pending.target, 'dismissed');
    };
    return {
      suggestionId: 'skill-share',
      // Data reloads and streaming can hide this target briefly after it
      // showed; it comes back without spending a new cap window.
      itemKey: pending.id,
      presentable: true,
      card: {
        testId: 'skill-share-nudge-banner',
        attributes: { 'data-share-kind': pending.target.kind },
        icon: isPlugin ? (
          <PluginsIcon size={16} aria-hidden="true" />
        ) : (
          <SkillIcon size={16} aria-hidden="true" />
        ),
        title: SKILL_SHARE_NUDGE_COPY.title(displayName),
        body: isPlugin
          ? SKILL_SHARE_NUDGE_COPY.pluginMessage
          : SKILL_SHARE_NUDGE_COPY.skillMessage,
        primaryAction: {
          label: SKILL_SHARE_NUDGE_COPY.action,
          testId: 'skill-share-nudge-banner-share',
          onClick: (event) => {
            // The dialog opens in the document that shows the card.
            requestShare(pending.target, {
              source: 'usage_nudge',
              ownerDocument: event.currentTarget.ownerDocument,
              origin: {
                projectId,
                worktreeId,
                chatId,
                pendingId: pending.id,
              },
            });
          },
        },
        secondaryAction: {
          label: SKILL_SHARE_NUDGE_COPY.notNow,
          testId: 'skill-share-nudge-banner-dismiss',
          onClick: dismiss,
        },
      },
      // Not now settles this target; Don't show again also retires sharing
      // suggestions for good through the shared dismissal.
      permanentDismiss: {
        testId: 'skill-share-nudge-banner-dismiss-forever',
        onDismissed: dismiss,
      },
      onShown: () => {
        if (pending.state === 'pending') {
          report(pending, pending.target, 'shown');
        }
      },
    };
  }, [pending, displayName, projectId, worktreeId, chatId, report]);
  useSuggestionCornerOffer('skill-share', model);
  return null;
}
