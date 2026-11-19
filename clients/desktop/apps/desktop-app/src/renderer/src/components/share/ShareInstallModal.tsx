import { flushSync } from 'react-dom';
import { requestAutomationProjectCreation } from '@/stores/automationInstallContinuationStore';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  DeepLinkShareOpenEvent,
  PublicShareSnapshot,
} from '@canopy/desktop-shared/types';
import {
  SHARE_ATTRIBUTION_SEPARATOR,
  SHARE_ATTRIBUTION_SHARER_PREFIX,
  SHARE_INSTALL_TURNING_ON_LABEL,
  shareInstallActionLabel,
  shareInstallDefaultDescription,
  shareInstallEntityNoun,
  shareInstallPlaceholderTitle,
  shareInstallPluginAlreadyAvailableStatus,
  shareInstallPluginAlreadyAvailableStatusParts,
  shareInstallPluginEffectParts,
  shareInstallPluginInstalledStatus,
  shareInstallPluginInstalledStatusParts,
  shareInstallSkillEffectParts,
  shareInstallTypeLabel,
  type ShareAttributionPart,
  type ShareInstallCopyPart,
  type ShareInstallEntity,
} from '@canopy/ui-app/sharing/share-install-copy';
import { useResourceContext } from '@canopy/ui-app/capability';
import { ConfirmDialog } from '@canopy/ui-shared/components/ConfirmDialog';
import { InstalledShareMenu } from '@canopy/ui-shared/components/InstalledShareMenu';
import {
  ShareInstallDialog,
  type ShareInstallDialogPrimary,
} from '@canopy/ui-shared/components/ShareInstallDialog';
import { markdownDescriptionToPlainText } from '@canopy/ui-shared/lib/markdown-plain-text';
import { LoadingRegion } from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  useNavigationStore,
  type PendingShareInstall,
  type ShareInstallOrigin,
} from '@/stores/navigationStore';
import { useAutomationScope } from '@/hooks/useAutomationScope';
import { toInstallWorkspaceOptions } from '@/lib/installWorkspaceOptions';
import { parseSkillSource } from '@/lib/skillFrontmatter';
import {
  InstallSharedAutomationModal,
  type AutomationProjectCreationRequest,
  type InstallAutomationOutcome,
} from '@/components/automations/InstallSharedAutomationModal';
import {
  usePublicShareLanding,
  type PublicShareInstalledTarget,
  type PublicShareLanding,
  type PublicShareLandingOptions,
} from './usePublicShareLanding';
import {
  shareLandingErrorCopy,
  shareLandingRecovery,
} from './shareLandingErrorCopy';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import {
  scopedShareAttribution,
  skillShareInstallScope,
} from './shareInstallProvenance';
import {
  announceInstall,
  openInstallReveal,
  openInstalledResult,
} from './installReveal';
import { installRevealNotice } from './installRevealNotice';
import {
  captureShareChatTarget,
  offerUseInChat,
  isShareChatTargetCurrent,
  notifyUseInChatFailure,
  watchShareChatTarget,
  type ShareChatTarget,
} from './shareChatTarget';
import {
  capturePluginChatTarget,
  isPluginChatTargetCurrent,
  notifyTurnOnInChatFailure,
  offerTurnOnInChat,
  pluginChatTabTitle,
  pluginChatTargetTitle,
  returnToPluginChat,
  watchPluginChatTarget,
} from './pluginChatTarget';
import { renderTurnOnInChatLabel } from './TurnOnInChatLabel';
import { useChatStore } from '@/stores/chatStore';
import { worktreeKey } from '@/stores/chat/utils';
import { SharedContainerLinkLandingModal } from '@/components/shared-containers/SharedContainerLinkLandingModal';

/**
 * The install review for every shared resource (CAN-3710): a share deep link
 * from the web and an in-app Add or Install open the same small dialog. It
 * names the item, says who shared it, describes it in a line or three, and
 * offers exactly one primary action. Nothing installs without that click.
 * A finished install closes the review and lands on the result, except a
 * skill installed over a chat: the user stays in that chat and the notice
 * offers **Use in this chat** (CAN-5219).
 *
 * All landing behavior lives in `usePublicShareLanding`; this shell only
 * renders its phases through the shared `ShareInstallDialog`.
 */

interface ShareInstallModalProps {
  link: DeepLinkShareOpenEvent;
  origin: ShareInstallOrigin;
  skillTarget?: PublicShareLandingOptions['skillTarget'];
  onClose: () => void;
}

/**
 * The item's own description, as plain text. A skill's comes from its
 * SKILL.md frontmatter when the share has none; agents carry none.
 */
function shareInstallDescription(
  snapshot: PublicShareSnapshot,
): string | undefined {
  switch (snapshot.entity) {
    case 'agent':
      return undefined;
    case 'skill': {
      if (snapshot.description) {
        return markdownDescriptionToPlainText(snapshot.description);
      }
      const listed = parseSkillSource(snapshot.rawSkill).frontmatter
        ?.description;
      return typeof listed === 'string'
        ? markdownDescriptionToPlainText(listed)
        : undefined;
    }
    case 'automation':
      return markdownDescriptionToPlainText(snapshot.automation.description);
    case 'workspace':
      return markdownDescriptionToPlainText(snapshot.template.description);
    case 'collection':
      return markdownDescriptionToPlainText(snapshot.collection.description);
    default:
      return markdownDescriptionToPlainText(snapshot.description);
  }
}

function snapshotName(
  snapshot: PublicShareSnapshot | null,
): string | undefined {
  if (!snapshot) return undefined;
  // Agents and workspace templates carry their display fields on a nested
  // portable document rather than on the snapshot itself.
  switch (snapshot.entity) {
    case 'automation':
      return snapshot.automation.name;
    case 'agent':
      return snapshot.agent.name;
    case 'workspace':
      return snapshot.template.name;
    case 'collection':
      return snapshot.collection.name;
    default:
      return snapshot.name;
  }
}

function installedStatus(
  installed: PublicShareInstalledTarget,
  installStatus: string,
  marketplaceOrigin: string | null,
): JSX.Element | string {
  // A plugin's status names its marketplace, which can be a personal GitHub
  // login: render the known lines from parts so replay boxes the origin.
  if (installed.entity === 'plugin' && marketplaceOrigin !== null) {
    // Every Install click reports its own status, so an empty one means the
    // review found the plugin already installed when it opened (CAN-5017).
    if (installStatus === '') {
      return renderCopyParts(
        shareInstallPluginAlreadyAvailableStatusParts(marketplaceOrigin, {
          installAttempted: false,
        }),
      );
    }
    if (
      installStatus === shareInstallPluginInstalledStatus(marketplaceOrigin)
    ) {
      return renderCopyParts(
        shareInstallPluginInstalledStatusParts(marketplaceOrigin),
      );
    }
    const nothingInstalled = { installAttempted: true };
    if (
      installStatus ===
      shareInstallPluginAlreadyAvailableStatus(
        marketplaceOrigin,
        nothingInstalled,
      )
    ) {
      return renderCopyParts(
        shareInstallPluginAlreadyAvailableStatusParts(
          marketplaceOrigin,
          nothingInstalled,
        ),
      );
    }
  }
  if (installStatus !== '') return installStatus;
  if (installed.entity === 'workspace') return 'Added to your projects.';
  if (
    (installed.entity === 'automation' || installed.entity === 'pipeline') &&
    installed.updateAvailable === true
  ) {
    return 'Installed. An update is available.';
  }
  if (installed.entity === 'skill') {
    return (
      <>
        Installed as “
        <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
          {installed.skillName}
        </span>
        ”.{installed.updateAvailable === true && ' An update is available.'}
      </>
    );
  }
  return 'Installed.';
}

/** An entity whose installed copy offers Uninstall from the ⋯ menu. */
function offersUninstall(installed: PublicShareInstalledTarget): boolean {
  // Plugin removal is owned by the Plugins page (a marketplace can carry
  // several plugins); a project is user data once it exists; a collection is
  // managed on its own detail page.
  return (
    installed.entity !== 'plugin' &&
    installed.entity !== 'workspace' &&
    installed.entity !== 'collection'
  );
}

/** Install-review copy with each identifying name boxed in replay. */
function renderCopyParts(parts: readonly ShareInstallCopyPart[]): JSX.Element {
  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'name' ? (
          <span key={index} className={POSTHOG_REPLAY_BLOCK_CLASS}>
            {part.text}
          </span>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * A skill or plugin's attribution parts, in order. The sharer is a person:
 * replay records a box for the name only, keeping `Shared by` around it.
 */
function renderShareAttribution(
  parts: readonly ShareAttributionPart[],
): JSX.Element | undefined {
  if (parts.length === 0) return undefined;
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={part.kind}>
          {index > 0 && SHARE_ATTRIBUTION_SEPARATOR}
          {part.kind === 'sharer' ? (
            <>
              {SHARE_ATTRIBUTION_SHARER_PREFIX}
              <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{part.name}</span>
            </>
          ) : part.kind === 'owner' ? (
            <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{part.name}</span>
          ) : (
            <>
              {part.label}
              {part.name && (
                <>
                  :{' '}
                  <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                    {part.name}
                  </span>
                </>
              )}
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Every field of the two links matches: a repeat of the same request (a
 * second Install click on the web), not a new one.
 */
function isSameShareLink(
  a: DeepLinkShareOpenEvent,
  b: DeepLinkShareOpenEvent,
): boolean {
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  return keys.every((key) => Reflect.get(a, key) === Reflect.get(b, key));
}

/**
 * Where the user is: the page, the selected worktree, and its active tab. A
 * skill landing that opened outside a chat reveals the installed skill only
 * if this has not changed, so a finished install never pulls the user away
 * from work they moved on to.
 */
function navigationContextKey(): string {
  const navigation = useNavigationStore.getState();
  const { selectedWorktree, worktreeChats } = useChatStore.getState();
  const worktree =
    selectedWorktree === null
      ? ''
      : `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`;
  return JSON.stringify([
    navigation.activePage,
    navigation.settingsOpen,
    navigation.remoteControlDialogOpen,
    worktree,
    worktreeChats[worktree]?.activeTabId ?? '',
  ]);
}

interface ShareChatTargets {
  /** The chat whose composer was on screen; skills are used there. */
  skill: { target: ShareChatTarget | null; current: boolean };
  /** The selected worktree's chat, from the chat page or Customize. */
  plugin: { target: ShareChatTarget | null; current: boolean; title: string };
  /** The review opened on the chat page, not over Customize. */
  openedOverChat: boolean;
  isUnchanged: () => boolean;
}

/**
 * The chats this landing opened over, captured once, and whether each still
 * qualifies. Once the user moves away an offer is gone for good: it is never
 * retargeted to the chat they moved to. Plugins (CAN-5219) are installed from
 * Customize, so their chat is the selected worktree's active chat there too.
 */
function useShareChatTarget(): ShareChatTargets {
  const [opened] = useState(() => ({
    target: captureShareChatTarget(),
    pluginTarget: capturePluginChatTarget(),
    navigationKey: navigationContextKey(),
    overChat: useNavigationStore.getState().activePage === 'main',
  }));
  const unchanged = useRef(true);
  const mounted = useRef(true);
  const [current, setCurrent] = useState(opened.target !== null);
  const [pluginCurrent, setPluginCurrent] = useState(
    opened.pluginTarget !== null,
  );
  useEffect(() => {
    mounted.current = true;
    const invalidate = (): void => {
      unchanged.current = false;
      setCurrent(false);
    };
    const check = (): void => {
      if (navigationContextKey() !== opened.navigationKey) invalidate();
    };
    const stopTarget =
      opened.target === null
        ? (): void => undefined
        : watchShareChatTarget(opened.target, invalidate);
    const stopPluginTarget =
      opened.pluginTarget === null
        ? (): void => undefined
        : watchPluginChatTarget(opened.pluginTarget, (): void => {
            setPluginCurrent(false);
          });
    const stopChat = useChatStore.subscribe(check);
    const stopNavigation = useNavigationStore.subscribe(check);
    check();
    if (
      opened.pluginTarget !== null &&
      !isPluginChatTargetCurrent(opened.pluginTarget)
    ) {
      setPluginCurrent(false);
    }
    return (): void => {
      mounted.current = false;
      stopTarget();
      stopPluginTarget();
      stopChat();
      stopNavigation();
    };
  }, [opened]);
  // Live, so a rename or a late summary updates the label while it shows.
  const pluginTitle = useChatStore((state): string => {
    const target = opened.pluginTarget;
    if (target === null) return '';
    return pluginChatTabTitle(
      state.worktreeChats[worktreeKey(target)]?.tabs.find(
        (tab) => tab.id === target.tabId,
      ),
    );
  });
  const isUnchanged = useCallback(
    (): boolean => mounted.current && unchanged.current,
    [],
  );
  return {
    skill: { target: opened.target, current },
    plugin: {
      target: opened.pluginTarget,
      current: pluginCurrent,
      title: pluginTitle,
    },
    openedOverChat: opened.overChat,
    isUnchanged,
  };
}

/** Entities whose `intent=try` stages something after the install. */
/**
 * Sign in and Switch account open the connect gate or Settings, which this
 * dialog would otherwise cover (CAN-5222). The dialog steps aside while that
 * surface is open and returns when it closes, cancelled or not; the landing
 * stays mounted throughout, so the share is never lost.
 */
function useStepAsideForAccount(): {
  steppedAside: boolean;
  stepAside: () => void;
} {
  const [requested, setRequested] = useState(false);
  const settingsOpen = useNavigationStore((s) => s.settingsOpen);
  const gateOpen = useCloudConnectGateStore((s) => s.pending !== null);
  const surfaceOpen = settingsOpen || gateOpen;
  // The surface opens a moment after the click (the gate reads the account
  // first), so the dialog returns only once it has opened and closed again.
  const seenOpenRef = useRef(false);
  useEffect(() => {
    if (!requested) return;
    if (surfaceOpen) {
      seenOpenRef.current = true;
      return;
    }
    if (seenOpenRef.current) {
      seenOpenRef.current = false;
      setRequested(false);
    }
  }, [requested, surfaceOpen]);
  const stepAside = useCallback((): void => {
    seenOpenRef.current = false;
    setRequested(true);
  }, []);
  return { steppedAside: requested && surfaceOpen, stepAside };
}

function hasTryNow(entity: DeepLinkShareOpenEvent['entity']): boolean {
  return (
    entity !== 'agent' &&
    entity !== 'workspace' &&
    entity !== 'collection' &&
    entity !== 'shared-container'
  );
}

export function ShareInstallModal({
  link,
  origin,
  skillTarget,
  onClose,
}: ShareInstallModalProps): JSX.Element | null {
  const landing = usePublicShareLanding(link, {
    onAutoNavigate: onClose,
    reportHandoffEvents: origin === 'deep-link',
    ...(skillTarget ? { skillTarget } : {}),
  });
  const { snapshot, installReview } = landing;
  const { personalOrganizationId } = useResourceContext();
  // Offer the same in-context projects as the Automations page (CAN-3448).
  const { projectsInContext } = useAutomationScope();
  const installWorkspaces = useMemo(
    () => toInstallWorkspaceOptions(projectsInContext),
    [projectsInContext],
  );

  // CAN-3651: a finished automation install or update leaves this flow for
  // the exact local copy on Workflows → Library. The wizard calls `onDone`
  // and then `onClose`; once completion is handled, that trailing close (and
  // any repeated callback) is a no-op, so the preview is never restored and
  // the handoff is reported once. A callback from a landing that was closed
  // or replaced by a newer link must not redirect the user or close that
  // link.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);
  const completedLinkRef = useRef<DeepLinkShareOpenEvent | null>(null);
  const currentReviewRef = useRef(installReview);
  currentReviewRef.current = installReview;
  const isCurrentLanding = useCallback(
    (): boolean =>
      mountedRef.current &&
      completedLinkRef.current !== link &&
      useNavigationStore.getState().pendingShareInstall?.link === link &&
      installReview !== null &&
      currentReviewRef.current === installReview,
    [link, installReview],
  );
  const { closeInstallReview, completeInstallReview } = landing;
  // An automation link opens straight into the review, so dismissing the
  // review dismisses the whole flow rather than revealing the landing.
  const handleInstallReviewClose = useCallback((): void => {
    if (!isCurrentLanding()) return;
    // Invalidate synchronously; a late result in the same React batch must
    // not complete an abandoned review or affect a newly opened one.
    currentReviewRef.current = null;
    closeInstallReview();
    onClose();
  }, [closeInstallReview, isCurrentLanding, onClose]);
  // `onDone` arrives while the wizard is still writing. Settle the write
  // before closing: a link held during it opens in place of this review
  // instead of being closed with it. A repeat of this same link is already
  // served, so the review still closes.
  const settleAndClose = useCallback((): void => {
    const navigation = useNavigationStore.getState();
    const held = navigation.heldShareInstall;
    navigation.setShareInstallBusy(false);
    if (held === undefined) onClose();
    else if (isSameShareLink(held.link, link))
      useNavigationStore.getState().consumeShareInstall();
  }, [link, onClose]);
  const handleInstallReviewDone = useCallback(
    (activityId?: string, outcome?: InstallAutomationOutcome): void => {
      if (!isCurrentLanding()) return;
      if (!activityId) {
        currentReviewRef.current = null;
        closeInstallReview();
        settleAndClose();
        return;
      }
      completedLinkRef.current = link;
      currentReviewRef.current = null;
      completeInstallReview(activityId);
      useNavigationStore.getState().openAutomationReveal({
        activityId,
        outcome:
          outcome ??
          (installReview?.staleActivity !== undefined
            ? 'updated'
            : 'installed'),
      });
      settleAndClose();
    },
    [
      closeInstallReview,
      completeInstallReview,
      installReview?.staleActivity,
      isCurrentLanding,
      link,
      settleAndClose,
    ],
  );
  // CAN-3980: creating a project closes this landing before the continued
  // install finishes, so the landing's own completion guard above would drop
  // it. The continuation carries a landing-independent completion instead: a
  // finished install records the handoff and reveals the copy exactly once.
  // A cancelled or failed install never calls it, and a completion without a
  // copy reveals nothing.
  const handleCreateProject = useCallback(
    (request: AutomationProjectCreationRequest): void => {
      onClose();
      const fallbackOutcome: InstallAutomationOutcome =
        request.staleActivities !== undefined &&
        request.staleActivities.length > 0
          ? 'updated'
          : 'installed';
      let completed = false;
      requestAutomationProjectCreation({
        ...request,
        // Deliberately replaces `request.onDone`: that is the landing's own
        // completion, which its closed-landing guard would reject. Anything a
        // completion must do on this path belongs here.
        onDone: (activityId, outcome): void => {
          if (completed || !activityId) return;
          completed = true;
          completeInstallReview(activityId);
          useNavigationStore.getState().openAutomationReveal({
            activityId,
            outcome: outcome ?? fallbackOutcome,
          });
        },
      });
    },
    [completeInstallReview, onClose],
  );

  const chat = useShareChatTarget();
  const [turningOn, setTurningOn] = useState(false);
  const { steppedAside, stepAside } = useStepAsideForAccount();
  const handleInstall = useInstallAndLand(link, landing, onClose, chat);
  // CAN-5307: replacing a copy with the user's edits (or with no install-time
  // hash to rule them out) asks first. The answer belongs to the reviewed
  // copy: a refreshed or replaced target needs a new confirmation.
  const [confirmingReplace, setConfirmingReplace] =
    useState<PublicShareInstalledTarget | null>(null);
  const reviewedInstalled = landing.installed;
  useEffect(() => {
    setConfirmingReplace(null);
  }, [reviewedInstalled]);
  // An uninstall from the ⋯ menu is a write too: a newer request waits for
  // it the same way it waits for an install.
  const { uninstall } = landing;
  const handleUninstall = useCallback(async (): Promise<boolean> => {
    const navigation = useNavigationStore.getState();
    if (navigation.shareInstallBusy) return false;
    navigation.setShareInstallBusy(true);
    try {
      return await uninstall();
    } finally {
      useNavigationStore.getState().setShareInstallBusy(false);
    }
  }, [uninstall]);
  // The wizard writes on its own, so it marks the review busy itself: a newer
  // link is held until the write settles (see `openShareInstall`).
  const handleSubmittingChange = useCallback((submitting: boolean): void => {
    useNavigationStore.getState().setShareInstallBusy(submitting);
  }, []);

  // The author is a person: replay records a box for the name only. Skills
  // and scoped plugins name who shared them, their owner and audience
  // (CAN-5017); a public plugin keeps its author.
  const publisher =
    snapshot?.entity === 'skill' ||
    (snapshot?.entity === 'plugin' && snapshot.sharedBy !== undefined) ? (
      renderShareAttribution(
        scopedShareAttribution(snapshot, personalOrganizationId),
      )
    ) : snapshot?.authorUsername ? (
      <>
        Shared by{' '}
        <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
          {snapshot.authorUsername}
        </span>
      </>
    ) : undefined;

  // Swap, not nest: two `DialogModal`s would stack two scrims, two focus
  // traps, and two Escape handlers over each other.
  if (installReview !== null && snapshot?.entity === 'automation') {
    return (
      <InstallSharedAutomationModal
        onCreateProject={handleCreateProject}
        detail={{
          id: snapshot.externalId,
          contentHash: snapshot.contentHash,
          automation: snapshot.automation,
        }}
        source={
          snapshot.sourceKind === 'curated'
            ? 'curated'
            : link.audience === 'TEAM' || link.audience === 'ORGANIZATION'
              ? 'shared'
              : 'public'
        }
        {...(installReview.staleActivity
          ? { staleActivities: [installReview.staleActivity] }
          : {})}
        workspaces={installWorkspaces}
        {...(publisher !== undefined ? { subtitle: publisher } : {})}
        onSubmittingChange={handleSubmittingChange}
        onClose={handleInstallReviewClose}
        onDone={handleInstallReviewDone}
      />
    );
  }

  // `shared-container` never reaches this shell (the host routes it to its
  // own landing), so every entity here installs.
  const entity: ShareInstallEntity =
    link.entity === 'shared-container' ? 'workspace' : link.entity;
  const noun = shareInstallEntityNoun(entity);
  const placeholder = shareInstallPlaceholderTitle(entity);
  const title = snapshotName(snapshot) ?? placeholder;
  const typeLabel = shareInstallTypeLabel(entity);
  const {
    state,
    installed,
    installing,
    uninstalling,
    installError,
    installProgress,
    installStatus,
    detecting,
    agentReadinessLoading,
    agentReviewLoading,
  } = landing;

  const description =
    snapshot !== null
      ? (shareInstallDescription(snapshot) ??
        shareInstallDefaultDescription(entity))
      : undefined;

  // What installing does, from the same scope facts the install reads. An
  // installed copy, or one whose receipt could not be verified, has nothing
  // left to add. A plugin names the marketplace it installs from; without
  // one, or for a skill-typed ref that installs no marketplace, there is
  // nothing to say.
  const effectParts =
    state.phase !== 'ready' ||
    installed !== null ||
    landing.verificationError !== ''
      ? null
      : snapshot?.entity === 'skill'
        ? shareInstallSkillEffectParts(
            skillShareInstallScope(snapshot, personalOrganizationId),
          )
        : snapshot?.entity === 'plugin' &&
            snapshot.ref.type !== 'skill' &&
            snapshot.marketplaceOrigin !== ''
          ? shareInstallPluginEffectParts(snapshot.marketplaceOrigin)
          : null;
  const effect =
    effectParts !== null ? renderCopyParts(effectParts) : undefined;

  let primary: ShareInstallDialogPrimary | undefined;
  let blocker: string | undefined;
  let status: JSX.Element | undefined;
  let menu: JSX.Element | undefined;
  let replaceConfirm: JSX.Element | undefined;

  if (state.phase === 'error') {
    blocker = shareLandingErrorCopy(state.reason, entity);
    const recovery = shareLandingRecovery(state.reason, landing, {
      onOpenAccountSurface: stepAside,
    });
    if (recovery !== undefined) {
      primary = {
        label: recovery.label,
        testId: recovery.testId,
        onClick: recovery.onClick,
      };
    }
  } else if (state.phase === 'ready' && snapshot !== null) {
    const opensReview = landing.openingInstallReview;
    const updateAvailable =
      installed !== null &&
      (installed.entity === 'pipeline' ||
        installed.entity === 'automation' ||
        installed.entity === 'skill') &&
      installed.updateAvailable === true;
    const confirmsReplace =
      installed?.entity === 'skill' &&
      installed.replacement?.locallyEdited === true;
    if (landing.verificationError !== '' || landing.needsRefresh) {
      // Neither Install nor Update can be trusted until the review is read
      // again: one could duplicate the copy, the other overwrite unseen work.
      primary = {
        label: 'Try again',
        testId: 'deep-link-share-retry',
        disabled: detecting || installing || uninstalling,
        onClick: landing.refresh,
      };
    } else if (installed === null || updateAvailable) {
      primary = {
        label: shareInstallActionLabel(
          entity,
          updateAvailable ? 'update' : 'install',
        ),
        busyLabel: shareInstallActionLabel(
          entity,
          updateAvailable ? 'updating' : 'installing',
        ),
        testId: updateAvailable
          ? 'deep-link-share-update'
          : 'deep-link-share-install',
        busy: installing,
        disabled:
          detecting ||
          agentReadinessLoading ||
          agentReviewLoading ||
          opensReview,
        onClick: (): void => {
          if (confirmsReplace) {
            setConfirmingReplace(installed);
            return;
          }
          void handleInstall(updateAvailable ? 'updated' : 'installed');
        },
      };
    } else if (
      installed.entity === 'plugin' &&
      chat.plugin.target !== null &&
      chat.plugin.current
    ) {
      // CAN-5219: from a chat, or from Customize with a chat selected, an
      // installed plugin is turned on in that chat, which the user returns
      // to. Manage in the ⋯ menu still opens it.
      const chatTarget = chat.plugin.target;
      primary = {
        label: renderTurnOnInChatLabel(chat.plugin.title),
        busyLabel: SHARE_INSTALL_TURNING_ON_LABEL,
        busy: turningOn,
        testId: 'deep-link-share-turn-on-in-chat',
        disabled: uninstalling || turningOn,
        onClick: (): void => {
          setTurningOn(true);
          void landing
            .turnOnInChat(installed, chatTarget)
            .then(async (outcome): Promise<void> => {
              if (outcome !== 'enabled') {
                setTurningOn(false);
                notifyTurnOnInChatFailure(outcome);
                return;
              }
              // Commit dismissal and its focus-trap cleanup before moving
              // focus to the chat's composer. A link that arrived meanwhile
              // keeps the user where its review opened.
              flushSync(onClose);
              if (
                useNavigationStore.getState().pendingShareInstall === undefined
              ) {
                await returnToPluginChat(chatTarget);
              }
            });
        },
      };
    } else if (
      installed.entity === 'skill' &&
      chat.skill.target !== null &&
      chat.skill.current
    ) {
      // Over a chat, an installed skill is put to use there; Manage in the
      // ⋯ menu still opens it.
      const chatTarget = chat.skill.target;
      primary = {
        label: shareInstallActionLabel(entity, 'use-in-chat'),
        testId: 'deep-link-share-use-in-chat',
        disabled: uninstalling,
        onClick: (): void => {
          void landing
            .insertInChat(installed, chatTarget)
            .then((outcome): void => {
              if (outcome !== 'inserted') {
                notifyUseInChatFailure(outcome);
                return;
              }
              // Commit dismissal and its focus-trap cleanup before restoring
              // composer focus. No timer assumes when React will unmount.
              flushSync(onClose);
              if (
                useNavigationStore.getState().pendingShareInstall ===
                  undefined &&
                isShareChatTargetCurrent(chatTarget)
              ) {
                document.dispatchEvent(
                  new CustomEvent('canopy:focus-chat-input'),
                );
              }
            });
        },
      };
    } else {
      primary = {
        label: shareInstallActionLabel(entity, 'open'),
        testId: 'deep-link-share-open',
        disabled: uninstalling,
        onClick: (): void => {
          onClose();
          openInstalledResult(installed);
        },
      };
    }
    if (installed !== null) {
      status = (
        <span data-testid="deep-link-share-installed-status">
          {installedStatus(
            installed,
            installStatus,
            snapshot?.entity === 'plugin' && snapshot.marketplaceOrigin !== ''
              ? snapshot.marketplaceOrigin
              : null,
          )}
        </span>
      );
      menu = (
        <InstalledShareMenu
          busy={installing || uninstalling}
          placement="above"
          uninstallTitle={`Uninstall this ${noun}?`}
          testIds={{
            kebab: 'deep-link-share-kebab',
            menu: 'deep-link-share-menu',
            manage: 'deep-link-share-manage',
            uninstall: 'deep-link-share-uninstall',
            uninstallConfirm: 'deep-link-share-uninstall-confirm',
            uninstallDialog: 'deep-link-share-uninstall-dialog',
          }}
          onManage={(): void => {
            landing.manage(onClose);
          }}
          {...(offersUninstall(installed)
            ? { onUninstall: handleUninstall }
            : {})}
        />
      );
    }
    if (
      installed?.entity === 'skill' &&
      confirmingReplace === installed &&
      !installing
    ) {
      replaceConfirm = (
        <ConfirmDialog
          title="Replace your edits?"
          message={
            <>
              Updating replaces the instructions in “
              <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                {installed.skillName}
              </span>
              ” with the shared version, including any changes you made.
            </>
          }
          confirmLabel="Update"
          destructive
          dataTestId="deep-link-share-replace-dialog"
          confirmTestId="deep-link-share-replace-confirm"
          cancelTestId="deep-link-share-replace-cancel"
          onCancel={(): void => {
            setConfirmingReplace(null);
          }}
          onConfirm={(): void => {
            setConfirmingReplace(null);
            void handleInstall('updated');
          }}
        />
      );
    }
    if (installing && installProgress !== '') blocker = installProgress;
    if (landing.verificationError !== '') blocker = landing.verificationError;
    if (installError !== '') blocker = installError;
  }

  if (steppedAside) return null;

  return (
    <>
      <ShareInstallDialog
        title={title}
        typeLabel={typeLabel}
        publisher={publisher}
        description={description}
        effect={effect}
        loading={
          state.phase === 'loading' ||
          (state.phase === 'ready' && landing.openingInstallReview) ? (
            <LoadingRegion
              layout="intrinsic"
              slowNote={`Still loading ${placeholder.toLowerCase()}…`}
            />
          ) : undefined
        }
        blocker={blocker}
        status={status}
        statusTestId="share-install-status"
        primary={primary}
        menu={menu}
        // An uninstall from the ⋯ menu is a write too; it is not abandoned.
        busy={installing || uninstalling}
        onClose={onClose}
        titleId="deep-link-share-landing-title"
        dataTestId="deep-link-share-landing"
      />
      {replaceConfirm}
    </>
  );
}

/**
 * The review's one write: install, then close and land on the result. While
 * it writes, a newer request is held (see `openShareInstall`); a failure keeps
 * the review open on its error so the same primary retries.
 */
function useInstallAndLand(
  link: DeepLinkShareOpenEvent,
  landing: PublicShareLanding,
  onClose: () => void,
  chat: ShareChatTargets,
): (outcome: 'installed' | 'updated') => Promise<void> {
  const { install, insertInChat, turnOnInChat } = landing;
  const {
    skill: { target: chatTarget },
    plugin: { target: pluginTarget },
    openedOverChat,
    isUnchanged,
  } = chat;
  return useCallback(
    async (outcome: 'installed' | 'updated'): Promise<void> => {
      // A try link from the web already chose Try: the landing stages it as
      // soon as the install is known and closes the review through
      // `onAutoNavigate`, instead of revealing the result. The review stays
      // mounted until then, or the landing's staging effect never runs.
      const stagesTry = link.intent === 'try' && hasTryNow(link.entity);
      const navigation = useNavigationStore.getState();
      // One write at a time: a second click before the busy render must not
      // settle the first write's hold.
      if (navigation.shareInstallBusy) return;
      navigation.setShareInstallBusy(true);
      let result: Awaited<ReturnType<typeof install>> = null;
      let opensHeld = false;
      let contextUnchanged = false;
      const request = navigation.pendingShareInstall;
      try {
        result = await install();
      } finally {
        // Settling applies a request that arrived during the write. A repeat
        // of this same link is already served, so the review still closes.
        const held = useNavigationStore.getState().heldShareInstall;
        contextUnchanged = isUnchanged();
        useNavigationStore.getState().setShareInstallBusy(false);
        opensHeld =
          useNavigationStore.getState().pendingShareInstall !== request &&
          (held === undefined || !isSameShareLink(held.link, link));
        if (result !== null && !opensHeld && !stagesTry) {
          if (held !== undefined && isSameShareLink(held.link, link)) {
            useNavigationStore.getState().consumeShareInstall();
          } else onClose();
        }
      }
      if (result === null || stagesTry) return;
      const installedTarget = result.target;
      if (
        opensHeld ||
        (installedTarget.entity === 'skill' && !contextUnchanged)
      ) {
        announceInstall({
          target: installedTarget,
          outcome,
          status: result.status,
          partial: result.partial,
        });
        return;
      }
      // CAN-5219: a skill stays where the user is. Over the chat the landing
      // opened on, the notice offers it there; if the user moved on, or a
      // newer link took over, it only says what happened. A partial install
      // keeps its reveal, where the warning and recovery live.
      if (
        installedTarget.entity === 'skill' &&
        !result.partial &&
        chatTarget !== null
      ) {
        const message = installRevealNotice('skill', outcome, result.status);
        if (
          useNavigationStore.getState().pendingShareInstall === undefined &&
          isShareChatTargetCurrent(chatTarget)
        ) {
          offerUseInChat({
            message,
            target: chatTarget,
            stage: () => insertInChat(installedTarget, chatTarget),
          });
          return;
        }
        announceInstall({
          target: installedTarget,
          outcome,
          status: result.status,
          partial: result.partial,
        });
        return;
      }
      // CAN-5219: a plugin installed with a chat selected is offered there.
      // From Customize the installed detail still opens, since Try it lives
      // there; over the chat page the user stays put, as for skills.
      if (
        installedTarget.entity === 'plugin' &&
        !result.partial &&
        pluginTarget !== null
      ) {
        if (
          useNavigationStore.getState().pendingShareInstall === undefined &&
          isPluginChatTargetCurrent(pluginTarget)
        ) {
          if (!openedOverChat) openInstalledResult(installedTarget);
          offerTurnOnInChat({
            message: installRevealNotice('plugin', outcome, result.status),
            target: pluginTarget,
            title: pluginChatTargetTitle(pluginTarget),
            stage: () => turnOnInChat(installedTarget, pluginTarget),
          });
          return;
        }
        if (openedOverChat) {
          // The user moved on mid-install: say what happened, don't yank them.
          announceInstall({
            target: installedTarget,
            outcome,
            status: result.status,
            partial: result.partial,
          });
          return;
        }
      }
      openInstallReveal({
        target: result.target,
        outcome,
        status: result.status,
        partial: result.partial,
      });
    },
    [
      install,
      insertInChat,
      turnOnInChat,
      link,
      onClose,
      chatTarget,
      pluginTarget,
      openedOverChat,
      isUnchanged,
    ],
  );
}

const shareLandingKeys = new WeakMap<PendingShareInstall, number>();
let nextShareLandingKey = 0;
function shareLandingInstanceKey(request: PendingShareInstall): number {
  const existing = shareLandingKeys.get(request);
  if (existing !== undefined) return existing;
  nextShareLandingKey += 1;
  shareLandingKeys.set(request, nextShareLandingKey);
  return nextShareLandingKey;
}

/**
 * Self-gating App-level host (same pattern as `AddWorkspaceModalHost`):
 * renders the install review while a request is parked in the navigation
 * store and consumes it on close.
 */
export function ShareInstallModalHost(): JSX.Element | null {
  const pending: PendingShareInstall | undefined = useNavigationStore(
    (s) => s.pendingShareInstall,
  );
  const handleClose = useCallback((): void => {
    const navigation = useNavigationStore.getState();
    if (navigation.pendingShareInstall === pending)
      navigation.consumeShareInstall();
  }, [pending]);
  if (!pending) return null;
  const { link, origin } = pending;
  // A shared container's link is a capability, not a public share: it has its
  // own landing (summary, claim, the read-only viewer) and never goes through
  // the public-share resolve path. The key is deliberately not the token.
  if (link.entity === 'shared-container') {
    return (
      <SharedContainerLinkLandingModal
        token={link.externalId}
        onClose={handleClose}
      />
    );
  }
  return (
    <ShareInstallModal
      // The same share under another audience resolves differently, so it
      // re-resolves rather than reusing this review.
      key={shareLandingInstanceKey(pending)}
      link={link}
      origin={origin}
      {...(pending.skillTarget ? { skillTarget: pending.skillTarget } : {})}
      onClose={handleClose}
    />
  );
}
