import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type {
  CanopyCloudAccountPublicState,
  DeepLinkResolveShareResponse,
  DeepLinkShareOpenEvent,
  PublicShareSnapshot,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { CollectionConfig } from '@canopy/desktop-shared/types/collections';
import type { PipelinePackageReadiness } from '@canopy/execution-engine/types/pipeline';
import {
  formatPipelinePackageInstalledStatus,
  formatPipelinePackageTransferLabel,
} from '@canopy/ui-shared/lib/pipeline-package-display';
import {
  CUSTOM_SKILL_SOURCE_ID,
  findInstalledSkillByContentHash,
  describeSharedSkillImportNotice,
  importSharedSkill,
  lookupInstalledSharedSkill,
  sharedSkillReceiptsEnforced,
  sharedSkillWriteFailureCode,
  type InstalledSharedSkillTarget,
} from '@/lib/sharedSkillImport';
import { extractIpcErrorMessage } from '@/lib/errors';
import { findInstalledPipelineByContent } from '@/lib/publicShareInstallState';
import { findInstalledAutomationByOrigin } from '@/lib/publicAutomationInstallState';
import { buildSkillStarterPrompt } from '@/lib/publicShareExamplePrompt';
import { stageSkillStarterPrompt } from '@/lib/publicShareTryNowStaging';
import {
  insertSkillInvocation,
  watchShareChatTarget,
  type ShareChatInsertOutcome,
  type ShareChatTarget,
} from './shareChatTarget';
import {
  enablePluginInChat,
  watchPluginChatTarget,
  type PluginChatEnableOutcome,
} from './pluginChatTarget';
import { parseSkillSource } from '@/lib/skillFrontmatter';
import { formatUnresolvedCapabilitiesNotice } from '@/lib/unresolvedCapabilities';
import { tryParseAndValidateYaml } from '@/lib/pipeline-yaml';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  isConnectedNonGuest,
  useCloudConnectGateStore,
} from '@/stores/cloudConnectGateStore';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';
import { readCanopyCloudAccountChangeReason } from '@/lib/canopyCloudAccountChange';
import { useChatStore } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  findInstalledSharedPluginTarget,
  installSharedPluginRefWithOutcome,
} from '@/lib/publicSharePluginInstall';
import {
  shareInstallPluginAlreadyAvailableStatus,
  shareInstallPluginInstalledStatus,
} from '@canopy/ui-app/sharing/share-install-copy';
import { resolveSharedCollectionImport } from '@/lib/sharedCollectionImport';
import { shareLandingErrorCopy } from './shareLandingErrorCopy';

/**
 * Shell-agnostic state machine for the public-share landing surface
 * (CAN-2361 v2): resolve the pinned snapshot → detect installed state → one
 * adaptive primary action (Install → Try now) plus kebab actions
 * (Manage/Uninstall). Deliberately contains no modal (or any other chrome)
 * coupling so the same logic drives today's deep-link modal and, later, a
 * routed unified detail page — swapping the shell must not touch the parser,
 * IPC, resolve endpoints, or this hook. Nothing here auto-submits, and nothing
 * installs without a click (CAN-3710): every install is the review's one
 * primary action, whatever the link's intent.
 *
 * `intent=try` is behavioral (PR2b): when the arrival detection finds THIS
 * pinned version already installed, the landing auto-invokes the same
 * staging `tryNow` performs — a prefilled composer draft for skills, the
 * preselected dispatch modal (or editor fallback) for pipelines — and closes
 * itself via `onAutoNavigate`. Staging only: nothing is ever auto-submitted
 * or auto-run. When the entity is NOT installed, `try` degrades to the
 * normal Install review state, exactly like the default intent.
 */

// Same literal the App Advisor dispatcher broadcasts after skill mutations so
// the Skills tab refreshes (`dispatcher.ts` keeps its own private copy).
const SKILLS_CHANGED_EVENT = 'canopy:skills-changed';

/**
 * Shown when a package share resolves but this build cannot install packages.
 * Deliberately not a YAML-only fallback: installing the definition alone would
 * present an incomplete pipeline as a successful install.
 */
const PACKAGE_UPGRADE_REQUIRED_MESSAGE =
  'This shared workflow includes dependencies that this version cannot install. Update the desktop app to continue.';
const DEFINITION_ONLY_INSTALLED_STATUS =
  'Workflow definition installed without dependencies.';

type ResolveFailure = Extract<
  DeepLinkResolveShareResponse,
  { ok: false }
>['reason'];

/** Failures a different sign-in may recover, so account changes re-resolve. */
function recoversWithAccount(reason: ResolveFailure): boolean {
  return reason === 'sign-in-required' || reason === 'not-a-member';
}

/**
 * Which credential a resolve reads under. A new sign-in, even to the same
 * account, issues a new server key. Manual-key saves instead advance the
 * stored entry's update stamp, so replacing those counts as a change too.
 * `null` when the read is inconclusive and proves nothing about a change.
 */
function accountIdentity(
  account: CanopyCloudAccountPublicState | null,
): string | null {
  if (account !== null && account.read !== undefined && account.read !== 'ok')
    return null;
  if (!isConnectedNonGuest(account)) return 'signed-out';
  return `${account?.account?.id ?? ''}:${account?.serverApiKeyId ?? ''}:${account?.updatedAt ?? ''}`;
}

export type PublicShareLandingPhase =
  | { phase: 'loading' }
  | { phase: 'error'; reason: ResolveFailure }
  | { phase: 'ready'; snapshot: PublicShareSnapshot };

/** What an in-place skill update must prove it is replacing (CAN-5307). */
export interface PublicShareSkillReplacement {
  expectedLocalContentHash: string;
  expectedSourceContentHash: string;
  expectedSourcePackageDigest?: string;
  /** The copy has edits of the user's, or no install-time hash to tell. */
  locallyEdited: boolean;
}

export type PublicShareInstalledTarget =
  | {
      entity: 'skill';
      sourceId: string;
      skillName: string;
      /** A receipted copy whose content or package differs from the share. */
      updateAvailable?: boolean;
      /** Present with `updateAvailable` for a scoped share's copy. */
      replacement?: PublicShareSkillReplacement;
    }
  | {
      entity: 'pipeline';
      pipelineId: string;
      /** Package digest recorded in the local install ledger, when packaged. */
      packageDigest?: string;
      /** True when the share was republished with newer packaged content. */
      updateAvailable?: boolean;
    }
  | {
      entity: 'plugin';
      marketplaceId: string;
      pluginName: string;
      entryId: string;
    }
  | { entity: 'agent'; agentId: string }
  | { entity: 'workspace'; projectId: string }
  | { entity: 'collection'; collectionId: string }
  | {
      entity: 'automation';
      activityId: string;
      /** True when the share was republished with a changed document. */
      updateAvailable?: boolean;
    };

/** What one finished install produced, for the review to land on. */
export interface PublicShareInstallResult {
  target: PublicShareInstalledTarget;
  /** The install's terminal status (a partial success), or empty. */
  status: string;
  /** Something the share carries did not land; the notice warns. */
  partial: boolean;
}

export interface PublicShareLanding {
  state: PublicShareLandingPhase;
  snapshot: PublicShareSnapshot | null;
  /** True while the arrival installed-state detection is running. */
  detecting: boolean;
  /**
   * Why the installed copy could not be verified, or `''`. While set, the
   * review offers neither Install nor Update, only `refresh`.
   */
  verificationError: string;
  /**
   * The review is stale (a conflicting edit, a changed share): only a
   * `refresh` may continue. Never retried with new hashes automatically.
   */
  needsRefresh: boolean;
  /** Re-reads the share and its installed state, as a fresh review. */
  refresh: () => void;
  installed: PublicShareInstalledTarget | null;
  installing: boolean;
  installError: string;
  uninstalling: boolean;
  /**
   * Progress label while a packaged install transfers dependencies
   * (`Installing 2 of 5 dependencies…`), otherwise empty.
   */
  installProgress: string;
  /** Terminal status after an install, e.g. `Installed with 5 dependencies.` */
  installStatus: string;
  /** Machine-specific setup state for a packaged public Agent. */
  agentReadiness: PipelinePackageReadiness | null;
  agentReadinessLoading: boolean;
  /**
   * True while a team or organization agent's snapshot is read for the
   * review; Install waits for it, since it installs exactly that snapshot.
   */
  agentReviewLoading: boolean;
  /** Machine-specific setup state for a packaged public Blueprint. */
  workspaceReadiness: PipelinePackageReadiness | null;
  workspaceReadinessLoading: boolean;
  /**
   * Explicit install: local skill import / local pipeline save. Idempotent.
   * Resolves the installed target, or null when nothing was installed (a
   * failure, or an automation install opening its review).
   */
  install: () => Promise<PublicShareInstallResult | null>;
  /**
   * Explicit "Try now": stages an example task, ready for the user to
   * submit — skills prefill a chat composer (new tab in the active worktree,
   * or the Home composer when none is selected); pipelines open the saved
   * pipeline's editor, whose Run affordance is one click away (dispatch-modal
   * prefill lands in the follow-up PR). Never auto-submits.
   */
  tryNow: (onNavigate?: () => void) => void;
  /**
   * **Use in this chat** (CAN-5219): appends an installed skill's invocation
   * to the captured chat's composer, keeping its draft, and never sends.
   * `installed` must still be this landing's installed copy and no install
   * may be running. Reports the TRY_NOW handoff leg only once the composer
   * accepted the text. Stays callable after the landing closes, so the
   * installation notice can offer it.
   */
  insertInChat: (
    installed: PublicShareInstalledTarget,
    target: ShareChatTarget,
  ) => Promise<ShareChatInsertOutcome>;
  /**
   * **Turn on in “<chat>”** (CAN-5219): turns an installed plugin on in the
   * chat the install started from, keeping the chat's other plugins. Enables
   * the detected installed ref, which may come from another marketplace than
   * the share. Same guards as `insertInChat`, and never runs alongside it.
   * Repeatable: a plugin already on stays on. Stays callable after the
   * landing closes, so the installation notice can offer it.
   */
  turnOnInChat: (
    installed: PublicShareInstalledTarget,
    target: ShareChatTarget,
  ) => Promise<PluginChatEnableOutcome>;
  /** Opens the installed entity's management surface (viewer/editor). */
  manage: (onNavigate?: () => void) => void;
  /** Removes the local installed copy; resolves whether it was removed. */
  uninstall: () => Promise<boolean>;
  /**
   * Set when an automation install is under review. Installing an automation
   * is a rebind — the recipient picks a workspace, a branch, and confirms the
   * capability package — so it opens the wizard instead of writing anything.
   */
  installReview: {
    entity: 'automation';
    externalId: string;
    staleActivity?: ScheduledActivity;
  } | null;
  /**
   * True while an automation link is on its way into the install review:
   * the snapshot resolved and either detection is still running or the
   * review is about to open. The shell shows a loading state instead of the
   * landing so the preview never flashes before the review.
   */
  openingInstallReview: boolean;
  /** Dismiss the review without installing. */
  closeInstallReview: () => void;
  /** Record a completed wizard install and report the INSTALLED leg. */
  completeInstallReview: (activityId: string) => void;
  /**
   * Resolves the same link again after a failure (CAN-5222). A no-op while a
   * resolve is running, so repeated clicks never overlap.
   */
  retryResolve: () => void;
  /**
   * Recovers `sign-in-required`: opens the sign-in gate when signed out, or
   * account settings when a connected credential was refused. The landing
   * re-resolves once the account changes; cancelling leaves it as it was.
   */
  signIn: () => void;
  /**
   * Recovers `not-a-member`: opens account settings, where the reader can sign
   * out and sign in with another account. Nothing is signed out for them.
   */
  switchAccount: () => void;
}

const SKILL_COPY_MISSING_MESSAGE =
  'Your installed copy of this skill is missing. Restore it, then try again.';
const SKILL_COPY_UNVERIFIED_MESSAGE =
  'Your installed copy of this skill could not be checked. Try again.';

/** Detection that must block Install rather than fall back to it. */
class InstalledStateUnverifiedError extends Error {}

async function detectInstalled(
  snapshot: PublicShareSnapshot,
  audience?: DeepLinkShareOpenEvent['audience'],
  skillTarget?: InstalledSharedSkillTarget,
): Promise<PublicShareInstalledTarget | null> {
  if (
    skillTarget &&
    (snapshot.entity !== 'skill' ||
      snapshot.scopedShare !== true ||
      !sharedSkillReceiptsEnforced())
  )
    throw new InstalledStateUnverifiedError(SKILL_COPY_UNVERIFIED_MESSAGE);
  if (snapshot.entity === 'automation') {
    const { activities } = await window.api.automations.list();
    const scoped = audience === 'TEAM' || audience === 'ORGANIZATION';
    const sourceKind =
      snapshot.sourceKind === 'curated'
        ? 'curated'
        : scoped
          ? 'shared'
          : 'public';
    const found = findInstalledAutomationByOrigin(
      activities,
      {
        sourceKind,
        remoteId: snapshot.externalId,
      },
      snapshot.contentHash,
    );
    return found
      ? {
          entity: 'automation',
          activityId: found.activityId,
          updateAvailable: found.updateAvailable,
        }
      : null;
  }
  if (snapshot.entity === 'skill' && snapshot.scopedShare === true) {
    // CAN-5307: a team or organization skill's receipt establishes the
    // install; its hashes only decide whether an update is available.
    if (sharedSkillReceiptsEnforced()) {
      const lookup = {
        id: snapshot.sourceRemoteId ?? snapshot.externalId,
        rawSkill: snapshot.rawSkill,
        contentHash: snapshot.contentHash,
        ...(snapshot.distributionMode !== undefined
          ? { distributionMode: snapshot.distributionMode }
          : {}),
        ...(snapshot.package !== undefined
          ? { package: snapshot.package }
          : {}),
      };
      const found = skillTarget
        ? await lookupInstalledSharedSkill(lookup, skillTarget)
        : await lookupInstalledSharedSkill(lookup);
      if (found.status === 'absent') return null;
      if (found.status === 'missing-copy')
        throw new InstalledStateUnverifiedError(SKILL_COPY_MISSING_MESSAGE);
      if (found.status === 'unverified')
        throw new InstalledStateUnverifiedError(SKILL_COPY_UNVERIFIED_MESSAGE);
      return {
        entity: 'skill',
        sourceId: found.sourceId,
        skillName: found.skillName,
        ...(found.updateAvailable
          ? {
              updateAvailable: true,
              replacement: {
                expectedLocalContentHash: found.localContentHash,
                expectedSourceContentHash: found.sourceContentHash,
                // Main reads omission as "no package", whatever the mode says.
                ...(snapshot.package !== undefined
                  ? { expectedSourcePackageDigest: snapshot.package.digest }
                  : {}),
                locallyEdited: found.locallyEdited,
              },
            }
          : {}),
      };
    }
  }
  if (snapshot.entity === 'skill') {
    const found = await findInstalledSkillByContentHash(snapshot.contentHash);
    // Publisher folders need their supporting package, not just an identical
    // SKILL.md left by an interrupted download. The native catalog joins the
    // completed package ledger to this context's visible local inventory.
    if (
      found &&
      snapshot.publisher &&
      snapshot.distributionMode === 'package'
    ) {
      const catalog = await window.skills.listMarketplace();
      if (
        !catalog.some(
          (skill) =>
            skill.externalId === snapshot.externalId &&
            skill.installedSkillName === found.skillName &&
            skill.installedPackageDigest === snapshot.package?.digest,
        )
      )
        return null;
    }
    return found
      ? {
          entity: 'skill',
          sourceId: found.sourceId,
          skillName: found.skillName,
        }
      : null;
  }
  if (snapshot.entity === 'plugin') {
    return findInstalledSharedPluginTarget(snapshot.ref);
  }
  if (snapshot.entity === 'workspace') {
    const projects = await window.api.chatProject.list();
    const found = projects.projects.find(
      (project) =>
        project.installedFromTemplateExternalId === snapshot.externalId &&
        project.installedFromTemplateContentHash !== undefined,
    );
    return found ? { entity: 'workspace', projectId: found.id } : null;
  }
  if (snapshot.entity === 'agent') {
    if (snapshot.sourceRemoteId) {
      const { agents } = await window.agents.list();
      const found = agents.find(
        (agent) =>
          agent.importedFromRemoteId === snapshot.sourceRemoteId &&
          agent.remoteId === snapshot.sourceRemoteId &&
          agent.remoteContentHash === snapshot.contentHash &&
          agent.importedContentHash !== undefined &&
          agent.contentHash === agent.importedContentHash,
      );
      return found ? { entity: 'agent', agentId: found.id } : null;
    }
    const found = await window.agents.detectPublic({
      agent: snapshot.agent,
      externalId: snapshot.externalId,
      contentHash: snapshot.contentHash,
      ...(snapshot.package ? { package: snapshot.package } : {}),
    });
    return found ? { entity: 'agent', agentId: found.id } : null;
  }
  if (snapshot.entity === 'collection') {
    const index = await window.collections.loadIndex();
    for (const row of index) {
      const collection = await window.collections.loadCollection(row.id);
      const source = collection?.sharedSource;
      // A Public install pins the snapshot it verified, so a republished share
      // offers Install again. Scoped imports carry no hash and match by id.
      if (
        collection &&
        source?.remoteId === snapshot.externalId &&
        (source.contentHash === undefined ||
          source.contentHash === snapshot.contentHash)
      ) {
        return { entity: 'collection', collectionId: collection.id };
      }
    }
    return null;
  }
  // Package shares are identified by share + YAML hash + package digest
  // together, so a republished package reads as "update available" rather
  // than as already installed.
  const found = await findInstalledPipelineByContent(
    snapshot.rawPipeline,
    snapshot.distributionMode === 'package'
      ? snapshot.package?.digest
      : undefined,
    snapshot.externalId,
    snapshot.contentHash,
  );
  if (!found) return null;
  return {
    entity: 'pipeline',
    pipelineId: found.pipelineId,
    ...(found.installedPackageDigest
      ? { packageDigest: found.installedPackageDigest }
      : {}),
    ...(found.updateAvailable !== undefined
      ? { updateAvailable: found.updateAvailable }
      : {}),
  };
}

/**
 * A pipeline snapshot is packaged when the server explicitly says so. Missing
 * `distributionMode` is legacy definition-only data — never a package whose
 * fields were dropped, because a server that knows the share is packaged
 * answers `426` to an incapable client instead of omitting them.
 */
function isPackageSnapshot(snapshot: PublicShareSnapshot): snapshot is Extract<
  PublicShareSnapshot,
  { entity: 'pipeline' }
> & {
  distributionMode: 'package';
} {
  return (
    snapshot.entity === 'pipeline' && snapshot.distributionMode === 'package'
  );
}

export interface PublicShareLandingOptions {
  /** Local UI destination only; never sent to the share resolver. */
  skillTarget?: InstalledSharedSkillTarget;
  /**
   * Report the web handoff funnel (INSTALLED, TRY_NOW). Only a link that came
   * from the web belongs in that funnel; in-app installs and the Marketplace
   * skill page leave it off.
   */
  reportHandoffEvents?: boolean;
  /**
   * Shell-close callback for the behavioral `intent=try` auto-stage: invoked
   * after the auto `tryNow` dispatches its navigation, so the hosting shell
   * (today's modal) can dismiss itself. Omitting it disables auto-try — the
   * landing then presents the normal adaptive state for `try` links.
   */
  onAutoNavigate?: () => void;
}

export function usePublicShareLanding(
  link: DeepLinkShareOpenEvent,
  options?: PublicShareLandingOptions,
): PublicShareLanding {
  const contextGeneration = useWorkspaceContextStore(
    (store) => store.appliedGeneration,
  );
  const reviewGenerationRef = useRef(0);
  const [state, setState] = useState<PublicShareLandingPhase>({
    phase: 'loading',
  });
  const [detecting, setDetecting] = useState(false);
  const [verificationError, setVerificationError] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  const [installed, setInstalledState] =
    useState<PublicShareInstalledTarget | null>(null);
  const installedRef = useRef<PublicShareInstalledTarget | null>(null);
  const setInstalled = useCallback(
    (target: PublicShareInstalledTarget | null): void => {
      installedRef.current = target;
      setInstalledState(target);
    },
    [],
  );
  const [installing, setInstalling] = useState(false);
  const installInFlightRef = useRef(false);
  const refresh = useCallback((): void => {
    if (installInFlightRef.current) return;
    setRefreshCount((count) => count + 1);
  }, []);
  const insertInFlightRef = useRef(false);
  const consumedInsertRef = useRef<PublicShareInstalledTarget | null>(null);
  const [installError, setInstallError] = useState('');
  const [uninstalling, setUninstalling] = useState(false);
  const uninstallInFlightRef = useRef(false);
  const [installProgress, setInstallProgress] = useState('');
  const [installStatus, setInstallStatus] = useState('');
  const [agentReadiness, setAgentReadiness] =
    useState<PipelinePackageReadiness | null>(null);
  const [agentReadinessLoading, setAgentReadinessLoading] = useState(false);
  const [agentReviewLoading, setAgentReviewLoading] = useState(false);
  // A team or organization agent's Cloud snapshot, read when the review
  // opens: Install imports exactly what was shown, so a share edited while
  // the review was open is never installed unseen.
  const reviewedSharedAgentRef = useRef<{
    agentId: string;
    reviewed: Promise<
      Awaited<ReturnType<typeof window.agents.inspectImport>>['agent']
    >;
  } | null>(null);
  const [workspaceReadiness, setWorkspaceReadiness] =
    useState<PipelinePackageReadiness | null>(null);
  const [workspaceReadinessLoading, setWorkspaceReadinessLoading] =
    useState(false);
  const [installReview, setInstallReview] = useState<{
    entity: 'automation';
    externalId: string;
    staleActivity?: ScheduledActivity;
  } | null>(null);
  // CAN-5222: a retry or an account change starts a new attempt for the same
  // link. Only one runs at a time; a newer attempt discards the older result.
  const [resolveAttempt, setResolveAttempt] = useState(0);
  const resolvingRef = useRef(true);
  // Set once an attempt fails in a way another sign-in may fix, and kept until
  // one succeeds or reaches a failure account changes cannot recover.
  const [watchingAccount, setWatchingAccount] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);
  const reportHandoffEvents = options?.reportHandoffEvents === true;
  const reportHandoff = useCallback(
    (
      event: Parameters<typeof window.api.deepLinkReportHandoffEvent>[0],
    ): void => {
      if (!reportHandoffEvents) return;
      try {
        void window.api
          .deepLinkReportHandoffEvent(event)
          .catch(() => undefined);
      } catch {
        // Reporting never changes the outcome of installation or staging.
      }
    },
    [reportHandoffEvents],
  );

  const resolveRequest = useMemo(
    () => ({
      entity: link.entity,
      externalId: link.externalId,
      ...(link.automationSource !== undefined
        ? { automationSource: link.automationSource }
        : {}),
      ...(link.audience !== undefined ? { audience: link.audience } : {}),
      // Forward the pin the recipient reviewed on the web page verbatim so
      // the server can answer 409 rather than hand back different content.
      ...(link.packageVersion !== undefined
        ? { packageVersion: link.packageVersion }
        : {}),
      ...(link.expectedPipelineContentHash !== undefined
        ? { expectedPipelineContentHash: link.expectedPipelineContentHash }
        : {}),
      ...(link.expectedDistributionMode !== undefined
        ? { expectedDistributionMode: link.expectedDistributionMode }
        : {}),
      ...(link.expectedPackageDigest !== undefined
        ? { expectedPackageDigest: link.expectedPackageDigest }
        : {}),
      ...(link.expectedCollectionContentHash !== undefined
        ? {
            expectedCollectionContentHash: link.expectedCollectionContentHash,
          }
        : {}),
      ...(link.expectedWorkspaceTemplateContentHash !== undefined
        ? {
            expectedWorkspaceTemplateContentHash:
              link.expectedWorkspaceTemplateContentHash,
          }
        : {}),
      ...(link.expectedAutomationContentHash !== undefined
        ? {
            expectedAutomationContentHash: link.expectedAutomationContentHash,
          }
        : {}),
    }),
    [
      link.audience,
      link.automationSource,
      link.entity,
      link.externalId,
      link.packageVersion,
      link.expectedCollectionContentHash,
      link.expectedPipelineContentHash,
      link.expectedDistributionMode,
      link.expectedPackageDigest,
      link.expectedWorkspaceTemplateContentHash,
      link.expectedAutomationContentHash,
    ],
  );
  // Each link owns its recovery lifetime, including saved gate callbacks and
  // asynchronous account reads. A newer event supersedes older account reads.
  const skillTargetSourceId = options?.skillTarget?.sourceId;
  const skillTargetName = options?.skillTarget?.skillName;
  const recovery = useMemo(
    (): {
      request: typeof resolveRequest;
      skillTarget: InstalledSharedSkillTarget | undefined;
      active: boolean;
      watching: boolean;
      identity: string | null;
      read: number;
      revision: number;
    } => ({
      request: resolveRequest,
      skillTarget:
        skillTargetSourceId !== undefined && skillTargetName !== undefined
          ? { sourceId: skillTargetSourceId, skillName: skillTargetName }
          : undefined,
      active: true,
      watching: false,
      identity: null,
      read: 0,
      revision: 0,
    }),
    [resolveRequest, skillTargetSourceId, skillTargetName],
  );
  useEffect(() => {
    recovery.active = true;
    setWatchingAccount(false);
    return (): void => {
      recovery.active = false;
    };
  }, [recovery]);

  useEffect(() => {
    const recheck = (): void => {
      if (installInFlightRef.current || uninstallInFlightRef.current) return;
      setRefreshCount((count) => count + 1);
    };
    window.addEventListener(SKILLS_CHANGED_EVENT, recheck);
    return (): void =>
      window.removeEventListener(SKILLS_CHANGED_EVENT, recheck);
  }, []);

  useEffect(() => {
    reviewGenerationRef.current += 1;
    let cancelled = false;
    const revision = recovery.revision;
    const isCurrent = (): boolean =>
      !cancelled && recovery.active && revision === recovery.revision;
    resolvingRef.current = true;
    setState({ phase: 'loading' });
    setInstalled(null);
    // This resolve owns detection now; an older one may have stopped mid-way.
    setDetecting(false);
    setVerificationError('');
    setNeedsRefresh(false);
    setInstallError('');
    setInstallProgress('');
    setInstallStatus('');
    setAgentReadiness(null);
    setAgentReadinessLoading(false);
    reviewedSharedAgentRef.current = null;
    setAgentReviewLoading(false);
    setWorkspaceReadiness(null);
    setWorkspaceReadinessLoading(false);
    void window.api
      .deepLinkResolveShare(recovery.request)
      .then(async (result): Promise<void> => {
        if (!isCurrent()) return;
        resolvingRef.current = false;
        if (!result.ok) {
          setState({ phase: 'error', reason: result.reason });
          recovery.watching = recoversWithAccount(result.reason);
          setWatchingAccount(recovery.watching);
          return;
        }
        recovery.watching = false;
        setWatchingAccount(false);
        setState({ phase: 'ready', snapshot: result.snapshot });
        if (
          result.snapshot.entity === 'agent' &&
          result.snapshot.sourceRemoteId
        ) {
          const agentId = result.snapshot.sourceRemoteId;
          const reviewed = window.agents
            .inspectImport(agentId)
            .then((review) => review.agent);
          reviewedSharedAgentRef.current = { agentId, reviewed };
          setAgentReviewLoading(true);
          // Install awaits it; a failed read surfaces there, not here.
          void reviewed
            .catch(() => undefined)
            .finally(() => {
              if (isCurrent()) setAgentReviewLoading(false);
            });
        }
        if (
          result.snapshot.entity === 'agent' &&
          result.snapshot.distributionMode === 'package' &&
          result.snapshot.package
        ) {
          const agentSnapshot = result.snapshot;
          const agentPackage = agentSnapshot.package;
          if (!agentPackage) return;
          setAgentReadinessLoading(true);
          void window.agents
            .inspectPublic({
              agent: agentSnapshot.agent,
              externalId: agentSnapshot.externalId,
              contentHash: agentSnapshot.contentHash,
              package: agentPackage,
            })
            .then((readiness) => {
              if (isCurrent()) setAgentReadiness(readiness);
            })
            .catch(() => {
              if (!isCurrent()) return;
              setAgentReadiness({
                status: 'ready',
                distributionMode: 'package',
                requirements: agentPackage.environmentRequirements.map(
                  (requirement) => ({
                    ...requirement,
                    status: 'unknown' as const,
                    detail: 'Availability could not be verified automatically.',
                  }),
                ),
                includedResources: agentPackage.resources.map(
                  ({ id, displayName, kind, executableFiles }) => ({
                    id,
                    displayName,
                    kind,
                    ...(executableFiles ? { executableFiles } : {}),
                  }),
                ),
              });
            })
            .finally(() => {
              if (isCurrent()) setAgentReadinessLoading(false);
            });
        }
        if (result.snapshot.entity === 'workspace') {
          const packages = [
            ...(result.snapshot.package ? [result.snapshot.package] : []),
            ...(result.snapshot.skillPackages ?? []).map(
              (entry) => entry.package,
            ),
          ];
          if (packages.length > 0) {
            setWorkspaceReadinessLoading(true);
            void window.api.chatProject
              .inspectTemplateCapabilityPackages({ packages })
              .then((readiness) => {
                if (isCurrent()) setWorkspaceReadiness(readiness);
              })
              .catch(() => {
                if (!isCurrent()) return;
                setWorkspaceReadiness({
                  status: 'ready',
                  distributionMode: 'package',
                  requirements: packages
                    .flatMap((item) => item.environmentRequirements)
                    .map((requirement) => ({
                      ...requirement,
                      status: 'unknown' as const,
                      detail:
                        'Availability could not be verified automatically.',
                    })),
                });
              })
              .finally(() => {
                if (isCurrent()) setWorkspaceReadinessLoading(false);
              });
          }
        }
        // Arrival installed-state detection: flips the primary action to
        // "Try now" when this exact pinned content is already installed. A
        // context switch meanwhile detects again and owns the answer.
        const detection = reviewGenerationRef.current;
        const isCurrentDetection = (): boolean =>
          isCurrent() && detection === reviewGenerationRef.current;
        setDetecting(true);
        try {
          const found = await detectInstalled(
            result.snapshot,
            recovery.request.audience,
            recovery.skillTarget,
          );
          if (isCurrentDetection()) setInstalled(found);
        } catch (error) {
          // A receipted copy that cannot be verified must block installation
          // so that recovery cannot create a duplicate installed skill.
          if (
            isCurrentDetection() &&
            error instanceof InstalledStateUnverifiedError
          )
            setVerificationError(error.message);
        } finally {
          if (isCurrentDetection()) setDetecting(false);
        }
      })
      .catch((): void => {
        if (isCurrent()) {
          resolvingRef.current = false;
          recovery.watching = false;
          setWatchingAccount(false);
          setState({ phase: 'error', reason: 'cloud-unreachable' });
        }
      });
    return (): void => {
      cancelled = true;
      reviewGenerationRef.current += 1;
    };
  }, [refreshCount, resolveAttempt, recovery, setInstalled]);

  const snapshot = state.phase === 'ready' ? state.snapshot : null;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // A context switch made elsewhere keeps the reviewed share open, and main
  // refuses an install the new context does not allow (CAN-2962). Only the
  // installed state depends on the context, so only it is read again
  // (CAN-5307). A running install or uninstall keeps its own result, since
  // main checked it against the context it ran in, and the read waits until
  // it settles. The agent review and package readiness stay as reviewed:
  // main checks the context again when the install runs. A share still
  // resolving, or one that failed, has no review to keep, so it resolves
  // again in the new context.
  const detectedContextRef = useRef(contextGeneration);
  const contextDetectPendingRef = useRef(false);
  const contextDetectDeferredRef = useRef(false);
  useEffect(() => {
    if (detectedContextRef.current !== contextGeneration) {
      detectedContextRef.current = contextGeneration;
      contextDetectPendingRef.current = true;
    }
    if (!contextDetectPendingRef.current) return;
    if (installInFlightRef.current || uninstallInFlightRef.current) {
      contextDetectDeferredRef.current = true;
      return;
    }
    contextDetectPendingRef.current = false;
    // A deferred read keeps what the settled operation reported.
    const deferred = contextDetectDeferredRef.current;
    contextDetectDeferredRef.current = false;
    reviewGenerationRef.current += 1;
    const reviewed = snapshotRef.current;
    if (reviewed === null) {
      resolvingRef.current = true;
      setResolveAttempt((attempt) => attempt + 1);
      return;
    }
    // Fenced by the review generation, not by this effect's lifetime: an
    // install or uninstall settling re-runs the effect without replacing
    // this read.
    const generation = reviewGenerationRef.current;
    const isCurrent = (): boolean =>
      recovery.active && generation === reviewGenerationRef.current;
    setVerificationError('');
    if (!deferred) setInstallError('');
    setDetecting(true);
    void detectInstalled(
      reviewed,
      recovery.request.audience,
      recovery.skillTarget,
    )
      .then((found): void => {
        if (isCurrent()) setInstalled(found);
      })
      .catch((error: unknown): void => {
        if (isCurrent() && error instanceof InstalledStateUnverifiedError)
          setVerificationError(error.message);
      })
      .finally((): void => {
        if (isCurrent()) setDetecting(false);
      });
  }, [contextGeneration, installing, uninstalling, recovery, setInstalled]);

  const retryResolve = useCallback((): void => {
    if (!mountedRef.current || resolvingRef.current) return;
    resolvingRef.current = true;
    setResolveAttempt((attempt) => attempt + 1);
  }, []);

  // Sign-in completion and the account-changed event both report the same
  // change, so a resolve restarts only when the credential actually differs
  // from the one the latest attempt used. A change during a running resolve
  // restarts it, discarding the result read under the old account.
  const reresolveIfAccountChanged = useCallback(
    (event?: Event): void => {
      if (!recovery.active || !recovery.watching) return;
      if (
        event &&
        readCanopyCloudAccountChangeReason(event) === 'same-account-refresh'
      )
        return;
      const read = ++recovery.read;
      void window.api
        .loadCanopyCloudAccount()
        .then((account) => accountIdentity(account))
        .catch((): null => null)
        .then((identity): void => {
          if (
            !recovery.active ||
            !recovery.watching ||
            read !== recovery.read ||
            identity === null
          )
            return;
          if (identity === recovery.identity) return;
          recovery.identity = identity;
          recovery.revision += 1;
          resolvingRef.current = true;
          setResolveAttempt((attempt) => attempt + 1);
        });
    },
    [recovery],
  );

  useEffect(() => {
    if (!watchingAccount || !recovery.watching) return undefined;
    let active = true;
    const read = ++recovery.read;
    void window.api
      .loadCanopyCloudAccount()
      .then((account): void => {
        const identity = accountIdentity(account);
        if (
          active &&
          recovery.active &&
          read === recovery.read &&
          identity !== null &&
          recovery.identity === null
        )
          recovery.identity = identity;
      })
      .catch(() => undefined);
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      reresolveIfAccountChanged,
    );
    return (): void => {
      active = false;
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        reresolveIfAccountChanged,
      );
    };
  }, [watchingAccount, recovery, reresolveIfAccountChanged]);

  const landingEntity =
    link.entity === 'shared-container' ? 'workspace' : link.entity;
  const signIn = useCallback((): void => {
    void window.api
      .loadCanopyCloudAccount()
      .catch((): null => null)
      .then((account): void => {
        if (!mountedRef.current || !recovery.active) return;
        // The connect gate resumes at once for a connected account, so a
        // refused credential needs account settings to sign in again.
        if (isConnectedNonGuest(account)) {
          openCloudAccountSettings();
          return;
        }
        useCloudConnectGateStore.getState().requestConnect(
          {
            subtitle: shareLandingErrorCopy('sign-in-required', landingEntity),
          },
          reresolveIfAccountChanged,
        );
      });
  }, [landingEntity, recovery, reresolveIfAccountChanged]);

  const switchAccount = useCallback((): void => {
    if (recovery.active) openCloudAccountSettings();
  }, [recovery]);

  // Packaged installs stream per-dependency transfer progress; the label is
  // cleared the moment the operation settles.
  useEffect(() => {
    const subscribe = window.pipelines.onPackageProgress?.bind(
      window.pipelines,
    );
    if (!subscribe) return undefined;
    return subscribe((event) => {
      if (event.completed === undefined || event.total === undefined) return;
      setInstallProgress(
        formatPipelinePackageTransferLabel(event.completed, event.total),
      );
    });
  }, []);

  const install =
    useCallback(async (): Promise<PublicShareInstallResult | null> => {
      if (!snapshot || detecting || installInFlightRef.current) return null;
      const reviewGeneration = reviewGenerationRef.current;
      if (verificationError !== '' || needsRefresh) return null;
      if (snapshot.entity === 'automation') {
        // A rebind, not a write: the wizard owns workspace selection, branch
        // confirmation, and the capability-package review. INSTALLED is
        // reported from `completeInstallReview`, once something actually
        // exists locally.
        setInstallError('');
        const installedAutomation = installedRef.current;
        let staleActivity: ScheduledActivity | undefined;
        if (
          installedAutomation?.entity === 'automation' &&
          installedAutomation.updateAvailable === true
        ) {
          let activities: ScheduledActivity[];
          try {
            ({ activities } = await window.api.automations.list());
          } catch (error) {
            setInstallError(
              error instanceof Error
                ? error.message
                : 'Failed to install this share.',
            );
            return null;
          }
          staleActivity = activities.find(
            (activity) => activity.id === installedAutomation.activityId,
          );
        }
        setInstallReview({
          entity: 'automation',
          externalId: snapshot.externalId,
          ...(staleActivity ? { staleActivity } : {}),
        });
        return null;
      }
      installInFlightRef.current = true;
      setInstalling(true);
      // The target this install produced; every success path records it here,
      // and the review lands on it.
      let landed: PublicShareInstalledTarget | null = null;
      let landedStatus = '';
      let landedPartial = false;
      const succeed = (target: PublicShareInstalledTarget): void => {
        landed = target;
        setInstalled(target);
      };
      const reportStatus = (status: string, partial = false): void => {
        landedStatus = status;
        landedPartial = partial;
        setInstallStatus(status);
      };
      setInstallError('');
      const reconcileFailedPackageValidation = async (): Promise<void> => {
        // Exact-package validation can detach a stale ledger record before a
        // later download fails. Preserve a republished share's older target only
        // when main-process readiness has validated its exact YAML bytes/cache
        // and the same provenance record still exists.
        const current = installedRef.current;
        let validated: PublicShareInstalledTarget | null = null;
        if (
          current?.entity === 'pipeline' &&
          current.updateAvailable === true &&
          current.packageDigest
        ) {
          try {
            const readiness = await window.pipelines.getPackageReadiness({
              pipeline: current.pipelineId,
            });
            const installs = await window.pipelines.listPackageInstalls();
            const record = installs.data?.find(
              (candidate) =>
                candidate.localPipelineId === current.pipelineId &&
                candidate.originExternalId === link.externalId &&
                candidate.packageDigest === current.packageDigest,
            );
            if (
              readiness.success &&
              readiness.data?.distributionMode === 'package' &&
              readiness.data.status !== 'invalid' &&
              installs.success &&
              record
            ) {
              validated = current;
            }
          } catch {
            // Failed validation is not evidence that stale actions are safe.
          }
        }
        setInstalled(validated);
        setInstallStatus('');
      };
      try {
        if (snapshot.entity === 'plugin') {
          const { target, outcome } = await installSharedPluginRefWithOutcome(
            snapshot.ref,
          );
          succeed(target);
          // Say whether Install ran or found the plugin already in place
          // (CAN-5017); without a marketplace to name, keep `Installed.`. A
          // skill-typed ref installs a skill, which keeps its own status. The
          // modal matches these exact strings to replay-block the origin.
          if (target.entity === 'plugin' && snapshot.marketplaceOrigin !== '') {
            reportStatus(
              outcome === 'installed'
                ? shareInstallPluginInstalledStatus(snapshot.marketplaceOrigin)
                : shareInstallPluginAlreadyAvailableStatus(
                    snapshot.marketplaceOrigin,
                    { installAttempted: true },
                  ),
            );
          }
          reportHandoff({
            entity: 'plugin',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else if (snapshot.entity === 'collection') {
          const refreshed = await window.api.deepLinkResolveShare({
            entity: 'collection',
            externalId: snapshot.externalId,
            ...(link.audience ? { audience: link.audience } : {}),
            expectedCollectionContentHash: snapshot.contentHash,
            expectedDistributionMode: snapshot.package
              ? 'package'
              : 'definition_only',
            ...(snapshot.package
              ? { expectedPackageDigest: snapshot.package.digest }
              : {}),
          });
          if (!refreshed.ok || refreshed.snapshot.entity !== 'collection') {
            throw new Error(
              'The shared collection changed or is no longer available. Open the link again.',
            );
          }
          const verified = refreshed.snapshot;
          const fromPublicShare =
            link.audience !== 'TEAM' && link.audience !== 'ORGANIZATION';
          const source = {
            remoteId: snapshot.externalId,
            fetchedAt: new Date().toISOString(),
            ...(fromPublicShare
              ? { fromPublicShare, contentHash: verified.contentHash }
              : {}),
          };
          let saved: CollectionConfig;
          let unavailable = 0;
          // Packaged resources that failed and environment requirements left
          // unmet count as unavailable, as the Collections tab's import did.
          let packageUnavailable = 0;
          if (verified.package) {
            const installedPackage =
              await window.collections.installCapabilityPackage({
                collectionId: snapshot.externalId,
                createCollection: {
                  name: verified.collection.name,
                  description: verified.collection.description,
                  sharedSource: source,
                },
                packageRef: {
                  version: verified.package.version,
                  digest: verified.package.digest,
                },
                fromPublicShare,
              });
            saved = installedPackage.collection;
            packageUnavailable =
              installedPackage.uninstalledResourceLabels.length +
              installedPackage.unmetRequirements.length;
          } else {
            // Commit the authorized definition before any independent member writes.
            saved = await window.collections.saveCollection({
              name: verified.collection.name,
              description: verified.collection.description,
              skills: [],
              plugins: [],
              mcpServers: [],
              sharedSource: source,
            });
          }
          // The collection is committed. Members retain the existing best-effort
          // semantics; a linking failure does not undo an installed collection.
          try {
            const resolved = await resolveSharedCollectionImport({
              collection: verified.collection,
              // A Public collection pins its custom skills in its own snapshot,
              // so main verifies each one against that snapshot.
              customSkills: verified.customSkills.map((skill) => ({
                ...skill,
                fromPublicShare,
                ...(fromPublicShare
                  ? {
                      publicCollection: {
                        externalId: verified.externalId,
                        contentHash: verified.contentHash,
                      },
                    }
                  : {}),
              })),
            });
            const skills = new Map(
              saved.skills.map((skill) => [
                `${skill.sourceId}/${skill.skillName}`,
                skill,
              ]),
            );
            for (const skill of resolved.skills)
              skills.set(`${skill.sourceId}/${skill.skillName}`, skill);
            saved = await window.collections.saveCollection({
              ...saved,
              skills: Array.from(skills.values()),
              plugins: resolved.plugins,
            });
            unavailable = packageUnavailable + resolved.failures.length;
          } catch {
            unavailable =
              packageUnavailable +
              Math.max(1, verified.collection.items.length);
          }
          succeed({ entity: 'collection', collectionId: saved.id });
          reportStatus(
            unavailable === 0
              ? 'Collection installed.'
              : `Collection installed with ${unavailable} item${unavailable === 1 ? '' : 's'} unavailable.`,
            unavailable > 0,
          );
          reportHandoff({
            entity: 'collection',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else if (snapshot.entity === 'workspace') {
          const created = await window.api.chatProject.createFromTemplate({
            seed: 'shared',
            sourceTemplate: {
              externalId: snapshot.externalId,
              contentHash: snapshot.contentHash,
              ...(snapshot.package ? { package: snapshot.package } : {}),
              ...(snapshot.skillPackages
                ? { skillPackages: snapshot.skillPackages }
                : {}),
            },
          });
          await Promise.all([
            useStandaloneChatStore.getState().loadChatProjects(),
            useProjectsStore.getState().loadProjects({ silent: true }),
          ]);
          succeed({
            entity: 'workspace',
            projectId: created.project.id,
          });
          // Refs the resolver could not map (an unavailable marketplace, a
          // curated capability this install does not carry) are reported, never
          // fatal — the workspace still lands with everything that did resolve.
          reportStatus(
            created.unresolvedRefs.length > 0
              ? formatUnresolvedCapabilitiesNotice(
                  created.unresolvedRefs.length,
                )
              : '',
            created.unresolvedRefs.length > 0,
          );
          reportHandoff({
            entity: 'workspace',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else if (snapshot.entity === 'agent') {
          let imported: Awaited<ReturnType<typeof window.agents.importPublic>>;
          if (snapshot.sourceRemoteId) {
            // A team or organization agent installs the exact Cloud snapshot
            // read when the review opened, so a share edited in between is
            // refused rather than installed unseen. A failed read is retried
            // here, since a retry is a fresh review of the share.
            const agentId = snapshot.sourceRemoteId;
            const pending = reviewedSharedAgentRef.current;
            reviewedSharedAgentRef.current = null;
            const reviewedAgent =
              pending !== null && pending.agentId === agentId
                ? await pending.reviewed.catch(
                    async () =>
                      (await window.agents.inspectImport(agentId)).agent,
                  )
                : (await window.agents.inspectImport(agentId)).agent;
            const response = await window.agents.importShared({
              agentId,
              installMissing: true,
              reviewedAgent,
            });
            imported = response.agent;
            if (response.idChanged) {
              reportStatus(
                `Agent installed as ${response.finalId} because ${response.requestedId} already exists locally.`,
                true,
              );
            }
          } else {
            imported = await window.agents.importPublic({
              agent: snapshot.agent,
              externalId: snapshot.externalId,
              contentHash: snapshot.contentHash,
              ...(snapshot.package ? { package: snapshot.package } : {}),
              installMissing: true,
            });
          }
          succeed({ entity: 'agent', agentId: imported.id });
          reportHandoff({
            entity: 'agent',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else if (snapshot.entity === 'skill') {
          const current = installedRef.current;
          const replacement =
            current?.entity === 'skill' && current.updateAvailable === true
              ? current.replacement
              : undefined;
          if (
            current?.entity === 'skill' &&
            current.updateAvailable === true &&
            replacement === undefined
          ) {
            // Never continue as Install over a stale copy: that duplicates it.
            setNeedsRefresh(true);
            setInstallError(SKILL_COPY_UNVERIFIED_MESSAGE);
            return null;
          }
          const outcome = replacement ? 'updated' : 'installed';
          const imported = await importSharedSkill({
            ...(snapshot.sourceRemoteId
              ? { sourceRemoteId: snapshot.sourceRemoteId }
              : {}),
            name: snapshot.name,
            rawSkill: snapshot.rawSkill,
            contentHash: snapshot.contentHash,
            // A public share's package hangs off the SHARE, so the install
            // reads it through the public endpoints keyed by the share's
            // external id. A team or organization skill resolved through the
            // scoped fallback has no public share: its package hangs off the
            // skill (whose id is this same external id), and the public
            // endpoints 404 for it.
            id: link.externalId,
            fromPublicShare: snapshot.scopedShare !== true,
            ...(snapshot.distributionMode !== undefined
              ? { distributionMode: snapshot.distributionMode }
              : {}),
            ...(snapshot.package !== undefined
              ? { package: snapshot.package }
              : {}),
            ...(current?.entity === 'skill' && replacement
              ? {
                  replaceInstalled: {
                    skillName: current.skillName,
                    expectedLocalContentHash:
                      replacement.expectedLocalContentHash,
                    expectedSourceContentHash:
                      replacement.expectedSourceContentHash,
                    ...(replacement.expectedSourcePackageDigest !== undefined
                      ? {
                          expectedSourcePackageDigest:
                            replacement.expectedSourcePackageDigest,
                        }
                      : {}),
                  },
                }
              : {}),
          });
          // The write is durable, but its result belongs only to the review
          // that initiated it. Events still notify other installed surfaces.
          if (reviewGeneration !== reviewGenerationRef.current) {
            window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
            return null;
          }
          if (snapshot.publisher && imported.packageInstallError) {
            setInstalled(null);
            reportStatus('');
            setInstallError(
              describeSharedSkillImportNotice(imported) ??
                imported.packageInstallError,
            );
            window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
            return null;
          }
          // Reload actual receipt/package state. A failed check does not undo
          // durable bytes, nor prove the package/subscription is current.
          let landedSkill: PublicShareInstalledTarget = {
            entity: 'skill',
            sourceId: CUSTOM_SKILL_SOURCE_ID,
            skillName: imported.skillName,
          };
          let verificationFailed = false;
          if (snapshot.scopedShare === true && sharedSkillReceiptsEnforced()) {
            try {
              const reloaded = await detectInstalled(
                snapshot,
                link.audience,
                recovery.skillTarget,
              );
              if (reviewGeneration !== reviewGenerationRef.current) return null;
              if (
                reloaded?.entity !== 'skill' ||
                reloaded.skillName !== imported.skillName
              )
                throw new InstalledStateUnverifiedError(
                  SKILL_COPY_UNVERIFIED_MESSAGE,
                );
              landedSkill = reloaded;
            } catch {
              if (reviewGeneration !== reviewGenerationRef.current) return null;
              verificationFailed = true;
              landedSkill = { ...landedSkill, updateAvailable: true };
              setVerificationError(SKILL_COPY_UNVERIFIED_MESSAGE);
              setNeedsRefresh(true);
            }
          }
          succeed(landedSkill);
          reportStatus(
            verificationFailed
              ? `Skill ${outcome}. The installed copy could not be checked. Try again.`
              : (describeSharedSkillImportNotice(imported, outcome) ?? ''),
            verificationFailed ||
              imported.subscriptionWarning !== undefined ||
              imported.packageInstallError !== undefined ||
              imported.packageInstall?.supportingFilesComplete === false ||
              (imported.packageInstall?.uninstalledResourceLabels.length ?? 0) >
                0,
          );
          window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
          reportHandoff({
            entity: 'skill',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else if (isPackageSnapshot(snapshot)) {
          // Package installs are all-or-nothing and run entirely in the main
          // process: download + verify every blob against the pinned digest
          // BEFORE any local write. A build without the package installer must
          // say so rather than quietly saving the YAML alone.
          const installPackageShare =
            window.pipelines.installPackageShare?.bind(window.pipelines);
          if (!installPackageShare || !snapshot.package) {
            await reconcileFailedPackageValidation();
            setInstallError(PACKAGE_UPGRADE_REQUIRED_MESSAGE);
            return null;
          }
          const result = await installPackageShare({
            externalId: snapshot.externalId,
            expectedPipelineContentHash: snapshot.contentHash,
            expectedDistributionMode: 'package',
            expectedPackageDigest: snapshot.package.digest,
          });
          if (
            !result.success ||
            !result.data ||
            result.data.distributionMode !== 'package'
          ) {
            await reconcileFailedPackageValidation();
            setInstallError(
              result.error ?? 'Failed to install this shared workflow.',
            );
            return null;
          }
          succeed({
            entity: 'pipeline',
            pipelineId: result.data.localPipelineId,
            packageDigest: result.data.packageDigest,
            updateAvailable: false,
          });
          reportStatus(
            formatPipelinePackageInstalledStatus(result.data.resourceCount),
          );
          reportHandoff({
            entity: 'pipeline',
            externalId: link.externalId,
            eventType: 'INSTALLED',
            audience: link.audience,
          });
        } else {
          const installDefinitionOnlyShare =
            window.pipelines.installPackageShare?.bind(window.pipelines);
          if (installDefinitionOnlyShare) {
            const result = await installDefinitionOnlyShare({
              externalId: snapshot.externalId,
              expectedPipelineContentHash: snapshot.contentHash,
              expectedDistributionMode: 'definition_only',
            });
            if (
              !result.success ||
              !result.data ||
              result.data.distributionMode !== 'definition_only'
            ) {
              setInstallError(
                result.error ?? 'Failed to install this shared workflow.',
              );
              return null;
            }
            succeed({
              entity: 'pipeline',
              pipelineId: result.data.localPipelineId,
            });
            reportStatus(DEFINITION_ONLY_INSTALLED_STATUS);
            reportHandoff({
              entity: 'pipeline',
              externalId: link.externalId,
              eventType: 'INSTALLED',
              audience: link.audience,
            });
          } else {
            const parsed = tryParseAndValidateYaml(snapshot.rawPipeline);
            if (!parsed.success) {
              setInstallError(
                `This workflow could not be parsed: ${parsed.error}`,
              );
              return null;
            }
            const result = await window.pipelines.save({
              ...(snapshot.sourceRemoteId
                ? { sourceRemoteId: snapshot.sourceRemoteId }
                : {}),
              name: parsed.pipeline.name,
              description: parsed.pipeline.description ?? snapshot.description,
              icon: parsed.pipeline.icon ?? '',
              content: parsed.pipeline,
            });
            if (!result.success || !result.data) {
              setInstallError(result.error ?? 'Failed to save the workflow.');
              return null;
            }
            succeed({ entity: 'pipeline', pipelineId: result.data.id });
            reportStatus(DEFINITION_ONLY_INSTALLED_STATUS);
            reportHandoff({
              entity: 'pipeline',
              externalId: link.externalId,
              eventType: 'INSTALLED',
              audience: link.audience,
            });
          }
        }
      } catch (error) {
        if (reviewGeneration !== reviewGenerationRef.current) return null;
        if (isPackageSnapshot(snapshot)) {
          await reconcileFailedPackageValidation();
        }
        const skillFailure =
          snapshot.entity === 'skill'
            ? sharedSkillWriteFailureCode(error)
            : null;
        if (skillFailure !== null) {
          // A conflict means what was reviewed is no longer what would be
          // written. The review is refreshed, not retried with new hashes.
          setNeedsRefresh(true);
          setInstallError(extractIpcErrorMessage(error));
        } else {
          setInstallError(
            error instanceof Error
              ? error.message
              : 'Failed to install this share.',
          );
        }
      } finally {
        installInFlightRef.current = false;
        setInstalling(false);
        setInstallProgress('');
      }
      if (landed === null) return null;
      return { target: landed, status: landedStatus, partial: landedPartial };
    }, [
      snapshot,
      detecting,
      verificationError,
      needsRefresh,
      link.externalId,
      link.audience,
      setInstalled,
      reportHandoff,
      recovery,
    ]);

  // CAN-3651: an automation link opens straight into the install review,
  // whatever its intent. The review is the inspectable preview (schedule,
  // bindings, packages, and file paths) and its single explicit click
  // installs and enables the copy, so the landing would only add a click.
  // A copy that is already installed and current stays on the landing.
  const [autoReview, setAutoReview] = useState<'idle' | 'opening' | 'settled'>(
    'idle',
  );
  useEffect(() => {
    setAutoReview('idle');
  }, [link.entity, link.externalId]);
  const automationReviewable =
    snapshot?.entity === 'automation' && state.phase === 'ready';
  const autoReviewEligible =
    automationReviewable &&
    !detecting &&
    (installed === null ||
      (installed.entity === 'automation' &&
        installed.updateAvailable === true));
  useEffect(() => {
    if (!autoReviewEligible || autoReview !== 'idle') return;
    setAutoReview('opening');
    install()
      .catch((error: unknown) => {
        setInstallError(
          error instanceof Error
            ? error.message
            : 'Failed to open the install review.',
        );
      })
      .finally(() => {
        setAutoReview('settled');
      });
  }, [autoReviewEligible, autoReview, install]);
  const openingInstallReview =
    installReview === null &&
    automationReviewable &&
    (detecting || (autoReviewEligible && autoReview !== 'settled'));

  const tryNow = useCallback(
    (onNavigate?: () => void): void => {
      if (
        !snapshot ||
        !installed ||
        installInFlightRef.current ||
        installedRef.current !== installed
      ) {
        return;
      }
      reportHandoff({
        entity: snapshot.entity,
        externalId: link.externalId,
        eventType: 'TRY_NOW',
        audience: link.audience,
      });
      if (installed.entity === 'automation') {
        // An automation has no prompt to stage, so `try` degrades to opening
        // the installed copy in its editor.
        useNavigationStore
          .getState()
          .openAutomationEdit({ activityId: installed.activityId });
      } else if (installed.entity === 'plugin') {
        useNavigationStore.getState().openPluginsNavigation({
          kind: 'entry-detail',
          entryId: installed.entryId,
        });
      } else if (installed.entity === 'agent') {
        // An agent has no prompt to stage, so `try` opens its editor.
        useNavigationStore
          .getState()
          .openAgentReveal({ agentId: installed.agentId, mode: 'edit' });
      } else if (installed.entity === 'workspace') {
        // A workspace has no example task to stage, so `try` degrades to
        // opening the workspace the install just created.
        void useStandaloneChatStore
          .getState()
          .switchChatProject(installed.projectId);
        useNavigationStore.getState().navigate('chat');
      } else if (installed.entity === 'collection') {
        useNavigationStore.getState().navigate('plugins');
      } else if (installed.entity === 'skill') {
        if (snapshot.entity !== 'skill') return;
        // Stage a prefilled NEW chat tab in the active worktree (or the Home
        // composer when none is selected) — draft only, the user sends.
        stageSkillStarterPrompt(
          buildSkillStarterPrompt({
            name: snapshot.name,
            description: snapshot.description ?? '',
            frontmatter: parseSkillSource(snapshot.rawSkill).frontmatter,
          }),
        );
      } else {
        // Pipelines: with a worktree selected, stage the dispatch modal with
        // this pipeline preselected (Run stays an explicit click inside the
        // modal). Without a worktree there is no dispatch context, so fall
        // back to the saved pipeline's editor and its Run affordance.
        const worktree = useChatStore.getState().selectedWorktree;
        if (worktree) {
          useNavigationStore.getState().openPipelineDispatch({
            pipelineId: installed.pipelineId,
            projectId: worktree.projectId,
            worktreeId: worktree.worktreeId,
          });
        } else {
          useNavigationStore
            .getState()
            .openPipelineEdit({ pipelineId: installed.pipelineId });
        }
      }
      onNavigate?.();
    },
    [snapshot, installed, link.externalId, link.audience, reportHandoff],
  );

  const insertInChat = useCallback(
    async (
      target: PublicShareInstalledTarget,
      chat: ShareChatTarget,
    ): Promise<ShareChatInsertOutcome> => {
      if (
        target.entity !== 'skill' ||
        snapshot?.entity !== 'skill' ||
        installInFlightRef.current ||
        insertInFlightRef.current ||
        consumedInsertRef.current === target ||
        installedRef.current !== target
      )
        return 'stale';
      insertInFlightRef.current = true;
      let current = true;
      const pending = useNavigationStore.getState().pendingShareInstall;
      const stop = watchShareChatTarget(chat, (): void => {
        current = false;
      });
      const stopReview = useNavigationStore.subscribe((state): void => {
        if (state.pendingShareInstall !== pending) current = false;
      });
      try {
        // The offer outlives the review: its cached target alone cannot prove
        // the installed folder/package still exists or has the reviewed content.
        const found = await detectInstalled(
          snapshot,
          link.audience,
          recovery.skillTarget,
        );
        if (
          !current ||
          installedRef.current !== target ||
          useNavigationStore.getState().pendingShareInstall !== pending ||
          found?.entity !== 'skill' ||
          found.sourceId !== target.sourceId ||
          found.skillName !== target.skillName
        )
          return 'stale';
        const outcome = insertSkillInvocation(chat, target.skillName);
        if (outcome === 'inserted') {
          consumedInsertRef.current = target;
          reportHandoff({
            entity: 'skill',
            externalId: link.externalId,
            eventType: 'TRY_NOW',
            audience: link.audience,
          });
        }
        return outcome;
      } catch {
        return 'stale';
      } finally {
        stop();
        stopReview();
        insertInFlightRef.current = false;
      }
    },
    [snapshot, link.externalId, link.audience, reportHandoff, recovery],
  );

  const turnOnInChat = useCallback(
    async (
      target: PublicShareInstalledTarget,
      chat: ShareChatTarget,
    ): Promise<PluginChatEnableOutcome> => {
      // A plugin share whose ref is a skill installs as a skill and keeps
      // the skill path.
      if (
        target.entity !== 'plugin' ||
        snapshot?.entity !== 'plugin' ||
        installInFlightRef.current ||
        insertInFlightRef.current ||
        installedRef.current !== target
      )
        return 'stale';
      insertInFlightRef.current = true;
      let current = true;
      const pending = useNavigationStore.getState().pendingShareInstall;
      const stop = watchPluginChatTarget(chat, (): void => {
        current = false;
      });
      const stopReview = useNavigationStore.subscribe((state): void => {
        if (state.pendingShareInstall !== pending) current = false;
      });
      try {
        // The offer outlives the review: re-detect that the plugin is still
        // installed under the same ref before turning it on.
        const found = await detectInstalled(
          snapshot,
          link.audience,
          recovery.skillTarget,
        );
        if (
          !current ||
          installedRef.current !== target ||
          useNavigationStore.getState().pendingShareInstall !== pending
        )
          return 'stale';
        // The chat is still open but the plugin is no longer installed under
        // this ref, so "no longer open" would be wrong.
        if (
          found?.entity !== 'plugin' ||
          found.marketplaceId !== target.marketplaceId ||
          found.pluginName !== target.pluginName
        )
          return 'failed';
        const outcome = await enablePluginInChat(chat, target);
        if (outcome === 'enabled') {
          reportHandoff({
            entity: 'plugin',
            externalId: link.externalId,
            eventType: 'TRY_NOW',
            audience: link.audience,
          });
        }
        return outcome;
      } catch (error) {
        reportClientAppError(error);
        return 'failed';
      } finally {
        stop();
        stopReview();
        insertInFlightRef.current = false;
      }
    },
    [snapshot, link.externalId, link.audience, reportHandoff, recovery],
  );

  // Behavioral `intent=try` (PR2b): once `installed` is known — from the
  // arrival detection, or right after an explicit Install on a try-intent
  // arrival (deliberate: the link promised "lands ready to stage", so the
  // staging continues after the one required click) — auto-invoke the same
  // staging `tryNow` performs and dismiss the shell. At most once per link
  // arrival; requires a shell-provided onAutoNavigate; a not-installed
  // arrival stays on the normal Install review state. Staging only — nothing
  // auto-submits.
  const autoTriedRef = useRef(false);
  useEffect(() => {
    autoTriedRef.current = false;
  }, [link.entity, link.externalId]);
  const onAutoNavigate = options?.onAutoNavigate;
  useEffect(() => {
    if (
      link.intent !== 'try' ||
      link.entity === 'agent' ||
      link.entity === 'workspace' ||
      link.entity === 'collection' ||
      !onAutoNavigate ||
      autoTriedRef.current ||
      state.phase !== 'ready' ||
      detecting ||
      !installed
    ) {
      return;
    }
    autoTriedRef.current = true;
    tryNow(onAutoNavigate);
  }, [
    link.entity,
    link.intent,
    onAutoNavigate,
    state.phase,
    detecting,
    installed,
    tryNow,
  ]);

  const manage = useCallback(
    (onNavigate?: () => void): void => {
      if (
        !installed ||
        installInFlightRef.current ||
        installedRef.current !== installed
      ) {
        return;
      }
      const navigation = useNavigationStore.getState();
      if (installed.entity === 'automation') {
        navigation.openAutomationEdit({ activityId: installed.activityId });
      } else if (installed.entity === 'agent') {
        navigation.openAgentReveal({
          agentId: installed.agentId,
          mode: 'highlight',
        });
      } else if (installed.entity === 'workspace') {
        void useStandaloneChatStore
          .getState()
          .switchChatProject(installed.projectId);
        navigation.navigate('chat');
      } else if (installed.entity === 'collection') {
        navigation.navigate('plugins');
      } else if (installed.entity === 'skill') {
        navigation.openSkillViewer({
          kind: 'installed',
          sourceId: installed.sourceId,
          skillName: installed.skillName,
        });
      } else if (installed.entity === 'pipeline') {
        navigation.openPipelineEdit({ pipelineId: installed.pipelineId });
      } else if (installed.entity === 'plugin') {
        navigation.openPluginsNavigation({
          kind: 'entry-detail',
          entryId: installed.entryId,
        });
      }
      onNavigate?.();
    },
    [installed],
  );

  const uninstall = useCallback(async (): Promise<boolean> => {
    if (
      !installed ||
      uninstalling ||
      uninstallInFlightRef.current ||
      installInFlightRef.current ||
      installedRef.current !== installed
    ) {
      return false;
    }
    // Marketplace plugin removal is intentionally owned by the Plugins page:
    // removing a marketplace can affect multiple plugins. The landing offers
    // Manage instead of an unsafe one-click uninstall for plugin targets.
    if (installed.entity === 'plugin') return false;
    // A workspace is user data once it exists — chats, notes, and attachments
    // can already live in it — so removal stays in the sidebar's own delete
    // flow rather than behind a one-click Uninstall on a share landing.
    if (installed.entity === 'workspace') return false;
    const reviewGeneration = reviewGenerationRef.current;
    uninstallInFlightRef.current = true;
    setUninstalling(true);
    setInstallError('');
    try {
      if (installed.entity === 'skill') {
        const result = await window.skills.removeSkill(
          installed.sourceId,
          installed.skillName,
        );
        if (!result.success) {
          setInstallError(result.error ?? 'Failed to uninstall the skill.');
          return false;
        }
        window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
      } else if (installed.entity === 'automation') {
        // Explicit branch: without it the `else` below falls through to
        // `window.pipelines.delete` with an activity id.
        const result = await window.api.automations.delete({
          id: installed.activityId,
        });
        if (!result.ok) {
          setInstallError(result.error || 'Failed to remove the automation.');
          return false;
        }
      } else if (installed.entity === 'agent') {
        if (snapshot?.entity !== 'agent') return false;
        if (snapshot.sourceRemoteId) {
          await window.agents.delete({
            id: installed.agentId,
            importedShare: {
              remoteId: snapshot.sourceRemoteId,
              contentHash: snapshot.contentHash,
            },
          });
        } else {
          await window.agents.uninstallPublic({
            agentId: installed.agentId,
            externalId: snapshot.externalId,
            contentHash: snapshot.contentHash,
          });
        }
      } else if (installed.entity === 'collection') {
        await window.collections.deleteCollection(installed.collectionId);
      } else {
        const result = await window.pipelines.delete(installed.pipelineId);
        if (!result.success) {
          setInstallError(result.error ?? 'Failed to uninstall the workflow.');
          return false;
        }
      }
      if (reviewGeneration !== reviewGenerationRef.current) return false;
      if (
        snapshot?.entity === 'skill' &&
        snapshot.scopedShare === true &&
        sharedSkillReceiptsEnforced()
      ) {
        // Deliberately removing the requested copy returns this review to
        // its source overview. An unexpected disappearance never clears it.
        if (
          installed.entity === 'skill' &&
          recovery.skillTarget?.sourceId === installed.sourceId &&
          recovery.skillTarget.skillName === installed.skillName
        )
          recovery.skillTarget = undefined;
        const remaining = await detectInstalled(
          snapshot,
          link.audience,
          recovery.skillTarget,
        );
        if (reviewGeneration !== reviewGenerationRef.current) return false;
        setInstalled(remaining);
      } else {
        setInstalled(null);
      }
      return true;
    } catch (error) {
      if (reviewGeneration !== reviewGenerationRef.current) return false;
      if (error instanceof InstalledStateUnverifiedError)
        setVerificationError(error.message);
      setInstallError(
        error instanceof Error
          ? error.message
          : 'Failed to uninstall this share.',
      );
      return false;
    } finally {
      uninstallInFlightRef.current = false;
      setUninstalling(false);
    }
  }, [
    installed,
    uninstalling,
    setInstalled,
    snapshot,
    link.audience,
    recovery,
  ]);

  const closeInstallReview = useCallback((): void => {
    setInstallReview(null);
  }, []);

  const completeInstallReview = useCallback(
    (activityId: string): void => {
      setInstallReview(null);
      setInstalled({ entity: 'automation', activityId });
      if (link.automationSource === undefined) {
        reportHandoff({
          entity: 'automation',
          externalId: link.externalId,
          eventType: 'INSTALLED',
          audience: link.audience,
        });
      }
    },
    [
      link.audience,
      link.automationSource,
      link.externalId,
      setInstalled,
      reportHandoff,
    ],
  );

  return {
    state,
    snapshot,
    detecting,
    verificationError,
    needsRefresh,
    refresh,
    installed,
    installing,
    installError,
    uninstalling,
    installProgress,
    installStatus,
    agentReadiness,
    agentReadinessLoading,
    agentReviewLoading,
    workspaceReadiness,
    workspaceReadinessLoading,
    install,
    tryNow,
    insertInChat,
    turnOnInChat,
    manage,
    uninstall,
    installReview,
    openingInstallReview,
    closeInstallReview,
    completeInstallReview,
    retryResolve,
    signIn,
    switchAccount,
  };
}
