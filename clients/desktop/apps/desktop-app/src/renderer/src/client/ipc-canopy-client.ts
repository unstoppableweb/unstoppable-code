import {
  McpRemovalCandidatesResultSchema,
  InspectMcpRemovalResultSchema,
  ForceMcpRemovalResultSchema,
  type InspectMcpRemovalRequest,
  type ForceMcpRemovalRequest,
} from '@canopy/protocol/mcp-removal';
import type { WorkflowsPanelClient } from '@canopy/app-core';
import { createOrchestratorSettingsDraftClient } from './orchestrator-settings-client';
import { isVoiceDictationPlatform } from '@canopy/desktop-shared/platform-capabilities';
import type {
  AccountOrganizationSettingsApi,
  CanopyApi,
  FileTreeRoot,
} from '@canopy/desktop-shared/types';
import { getRemoteControlChatToolFamily } from '@canopy/desktop-shared/lib/remote-control-tool-family';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type {
  CanopyCapabilities,
  CanopyClient,
  ReviewApprovalsClient,
} from '@canopy/app-core';
import type {
  CreditsHandoffClient,
  MarketplaceSourcesClient,
} from '@canopy/app-core/client';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type {
  SettingsPaymentHandoffAvailability,
  SettingsPaymentHandoffResult,
} from '@canopy/protocol/settings/payment-handoff';
import { createIpcCanopyClient } from '@canopy/ipc-canopy-client';
import { attachRestoredIpcAppError } from '@canopy/protocol/app-errors/ipc-rejection';
import {
  reportClientAppError,
  resolveClientAppError,
} from '@canopy/desktop-instrumentation/client';
import { createAppError, toAppError } from '@canopy/protocol/app-errors';
import { canopyErrorDiagnostic } from '@canopy/protocol/canopy-core';
import { scopedFileOperationsFor } from '@/lib/files/workspace-file-source';
import type { RemoteIpcTransport } from '@canopy/protocol/remote-control';
import { REMOTE_IPC_CHANNELS } from '@canopy/protocol/remote-control/channels';
import { subscribeToChatEvents } from '@/lib/chatEventFanout';
import { isWebCoreScope } from '@/lib/chat-authority';
import { cloudProjectIsCowork } from '@/cloud-chats/cloud-project-kind';
import { isCoworkChatTarget } from '@/lib/cowork';
import { isLocalOnlyBuild } from '@/lib/local-only-build';
import { resolveIpcAppError } from '@/lib/ipc-app-error';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import {
  cloudTerminalsEnabled,
  webCoreScopeCapabilities,
} from '@/lib/web-core-scope-capabilities';
import {
  loadWebCoreServedOperations,
  webCoreServesChatFork,
  webCoreServesCost,
  webCoreServesDelegationPages,
  webCoreServesDelegationStop,
  webCoreServesSessionBreakdown,
  webCoreServesSubagentPanels,
} from '@/lib/web-core-served-operations';
import { recordTerminalOutputApplied } from '@/lib/renderer-diagnostics/recorder';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { createDesktopFeedbackReportClient } from './feedback-report-client';
import { ipcTranscriptReadClient } from './ipc-transcript-read-client';
import { createIpcMarketplaceSourcesClient } from './ipc-marketplace-sources-client';
import {
  createCanopyCloudAccountIdSource,
  createDesktopSettingsClient,
} from './account-organization-settings-client';
import { registerHostedSettingsCanopyClient } from './hosted-settings-client-registry';

/**
 * Build the desktop capability set for a given platform. Desktop runs the full
 * local-first app, so everything is enabled except voice dictation, which is
 * macOS-only (`canopy-dictate` is not shipped on Windows). The web adapter
 * reports a relay-limited set (CAN-736).
 *
 * `nativeWorktreeOpen` is `true` because the native `OpenDropdown` IDE/Finder
 * behavior genuinely exists on desktop. `panelLayoutControls` is `false`: no
 * desktop panel-layout toggle ships yet (CAN-1485), so reporting `true` would
 * advertise a control that does not exist — a real toggle (P2) flips it on.
 * `ledger` is `true` because desktop reads each scope's Agent Ledger; whether
 * the Ledger is turned on is checked on every read.
 * `marketplaceOwnedAutomationShares` is `true`: desktop Marketplace lists and
 * manages the user's own automation shares ("Shared by me", CAN-3980).
 * `marketplaceOwnedShares` is `true`: every Marketplace tab lists the user's
 * own account shares through `createdBy=me` reads (CAN-4263).
 * `marketplaceSharedCollectionEdit` is `true`: the shared collection editor
 * picks members from the local catalog (CAN-4263).
 * `customSkillEdit` is `true`: a custom skill's Customize row opens the local
 * skill editor (CAN-4844).
 * `automations` and `watchers` are `true`: both run on the desktop, so the
 * Workflows page shows their rows, the Schedule tab and their actions
 * (CAN-3981).
 */
export function createDesktopCapabilities(
  platform: NodeJS.Platform,
  organizationOperations: Pick<
    CanopyCapabilities,
    | 'personalOrganizationUpgrade'
    | 'organizationInvites'
    | 'personalProjectConversion'
  > = {},
  hostedSettings: Pick<CanopyCapabilities, 'accountOrganizationSettings'> = {},
  localOnlyBuild = isLocalOnlyBuild(),
): CanopyCapabilities {
  const capabilities = createNormalDesktopCapabilities(
    platform,
    organizationOperations,
    hostedSettings,
  );
  return localOnlyBuild
    ? { ...capabilities, ...LOCAL_ONLY_DESKTOP_CAPABILITY_OVERRIDES }
    : capabilities;
}

/**
 * What a local-only build (docs/local-only-build.md) turns off: every
 * capability whose feature needs our cloud, plus remote images and agent
 * visual CDN assets. Local features, the person's own provider plans
 * (`subscriptionProviders`), on-demand `providerQuotas`, `githubConnection`
 * and `localExecution` stay on. Marketplace sources stay on: listing,
 * adding and installing from a source are started by the person against
 * GitHub or a host they configured; the automatic default refresh is off in
 * main's automatic-call policy instead.
 */
const LOCAL_ONLY_DESKTOP_CAPABILITY_OVERRIDES = {
  turnFeedback: false,
  cloudCapabilityLinks: false,
  cloudReachBack: false,
  accountOrganizationSettings: false,
  personalOrganizationUpgrade: false,
  organizationInvites: false,
  personalProjectConversion: false,
  installUpdateEmails: false,
  marketplaceOwnedAutomationShares: false,
  marketplaceOwnedShares: false,
  marketplaceSharedCollectionEdit: false,
  // Feed sync is hosted; this device's own Ledger stays on (ledgerLocal).
  ledgerFeed: false,
  remoteImages: false,
  agentVisualRemoteAssets: false,
  // No hosted account to sign in to; the account menu drops Sign in.
  cloudAccount: false,
  // No usage data or activity leaves the computer; Privacy has no controls.
  telemetrySharing: false,
} as const satisfies Partial<CanopyCapabilities>;

function createNormalDesktopCapabilities(
  platform: NodeJS.Platform,
  organizationOperations: Pick<
    CanopyCapabilities,
    | 'personalOrganizationUpgrade'
    | 'organizationInvites'
    | 'personalProjectConversion'
  >,
  hostedSettings: Pick<CanopyCapabilities, 'accountOrganizationSettings'>,
): CanopyCapabilities {
  return {
    // Reporting eligibility is supplied by the account-aware recovery host.
    // Keep the general client closed while the account is unresolved/guest.
    feedbackReports: false,
    // A local preload cannot prove that an older remote desktop implements repair.
    mcpRemoval:
      typeof window !== 'undefined' &&
      window.api?.remoteControl?.getContext().mode !== 'remote',
    mcpRemovalForce:
      typeof window !== 'undefined' &&
      window.api?.remoteControl?.getContext().mode !== 'remote',
    feedbackDiagnostics: true,
    workspaceRecovery: true,
    sharedMultiRepo: true,
    workEntryAutoDelete: 'manage',
    githubConnection: true,
    localExecution: true,
    // Try it setup may open account OAuth in the in-app pane; the host also
    // requires the in-app browser itself, which a remote window lacks.
    embeddedOAuthBrowser: true,
    inAppBrowserPanel: true,
    repoRulesImport: true,
    scriptActions: true,
    // Tip dismissals live in the desktop preferences (CAN-4904).
    onboardingTips: true,
    claudeModAdmission: true,
    claudeModSurface: true,
    // Device-to-device windows have no suggestions capability negotiation.
    // Their local preload method cannot prove an older controlled host supports it.
    suggestions:
      typeof window === 'undefined' ||
      window.api?.remoteControl?.getContext().mode !== 'remote',
    // Source list/detail and plugin installs run over `window.plugins`; the
    // shared gate still requires the wired `marketplaceSources` member.
    marketplaceSources: true,
    marketplaceSourcePluginInstall: true,
    marketplaceSourceAdd: true,
    cloudCapabilityLinks: true,
    cloudReachBack: true,
    // Payment forms stay in the browser; hosted settings hand off to it.
    inlineCheckout: false,
    // Hosted account and organization settings run through main's settings
    // bridge, so they are on only when the preload exposes it.
    accountOrganizationSettings:
      hostedSettings.accountOrganizationSettings === true,
    terminalPty: true,
    // Main persists names; a cloud scope's durable client keeps them in memory.
    terminalRename: true,
    fileSystemAccess: 'read-write',
    voice: isVoiceDictationPlatform(platform),
    settingsScope: 'full',
    pipelines: 'execute',
    routing: 'in-memory',
    overviewNotifications: true,
    sidebarActivityMode: true,
    // The palette's commands, workflows and transcript search read renderer
    // stores and main's chat-search index.
    searchPalette: { actions: true, workflows: true, content: true },
    chatDrafts: true,
    // Local chats run in the local core, which serves each of these. A cloud
    // chat scope answers them from `webCoreScopeCapabilities` instead.
    chatApprovalMode: true,
    chatThinkingLevel: true,
    chatFastMode: true,
    chatTabFork: true,
    chatRootTabLifecycle: true,
    chatPluginSelections: true,
    chatQueueEdits: true,
    chatResetToPoint: true,
    chatAttachments: true,
    chatFileMentions: true,
    chatInterfaceModes: true,
    chatContextUsage: true,
    chatSessionTransfer: true,
    chatTranscriptSearch: true,
    chatReadState: true,
    chatArchives: true,
    taskSummary: true,
    chatVisuals: true,
    // Main grants sanitized writes only to trusted application documents.
    imageClipboard: true,
    nativeWorktreeOpen: true,
    // Fix, Resolve conflicts and Triage start agent chats from the header.
    worktreePrAgentHelpers: true,
    marketplaceOwnedAutomationShares: true,
    marketplaceOwnedShares: true,
    marketplaceSharedCollectionEdit: true,
    customSkillEdit: true,
    automations: true,
    workflowsPanel: true,
    watchers: true,
    chatWatchers: true,
    workflowManagement: true,
    // Main owns plan proposals, deferred reloads, and split startup. The
    // shared derivation still applies each provider's own limits.
    chatWorkflows: {
      planMode: true,
      planReview: true,
      deferredCapabilities: true,
      independentFork: true,
      // `resumeUsageLimitedChats` resumes an app-closed turn in place.
      interruptedTurnResume: true,
    },
    panelLayoutControls: false,
    itemGrouping: false,
    // `work-entries:delete` archives a Work Entry locked (CAN-5461).
    standaloneChatArchive: true,
    workspaceRemoval: 'delete',
    // `worktree.create` / `worktree.update` run over IPC. Row identity and
    // activity sections keep the shared defaults, so neither is set.
    worktreeCreation: true,
    // `worktree.create` carries `baseWorktreeId` and `forkOpenTabs` (Branch from).
    worktreeBranching: true,
    worktreeBaseBranch: true,
    worktreeMetadata: true,
    turnFeedback: true,
    // Stars the brand's repository with the bundled GitHub CLI's account.
    sourceRepositoryStar: true,
    // Install update emails (CAN-2334) go through the settings IPC pair,
    // which rejects without a signed-in non-guest account.
    installUpdateEmails: true,
    // Subagent viewer: Stop, the isolated worktree summary and changes,
    // messaging a managed delegate, and interrupting a native subagent all
    // run through the local managed-delegation and native-subagent IPC.
    delegationStop: true,
    delegationTranscriptReads: true,
    delegationBlockReads: true,
    delegationLifetimeStatusReads: true,
    delegationLifetimeLimitExtension: true,
    primaryContentReads: true,
    delegationWorktreeDetails: true,
    delegationMessaging: true,
    nativeSubagentInterrupt: true,
    ledger: true,
    ledgerLiveAgentStates: true,
    // The Feed merges this device's Ledger with the mirror, and its own
    // entries change here.
    ledgerFeed: true,
    ledgerLocal: true,
    referencePreviews: true,
    backgroundTaskStop: true,
    lifecycleJournalQuarantine: true,
    // `worktree:discard-describe` / `worktree:discard` (CAN-5334).
    worktreeDiscard: true,
    worktreeRecovery: true,
    worktreeRecoveryResolution: true,
    // Every host with live resolution also lists recovery (CAN-7439).
    worktreeRecoveryReads: true,
    // `workspace:delete-discard-describe` and the supersede field (CAN-5337).
    projectDeletionDiscard: true,
    // Observed cost reads over the `cost:*` IPC.
    costInsights: true,
    // The local cost store keeps every chat's full breakdown.
    sessionBreakdown: true,
    providerQuotas: true,
    // Add project clone jobs over `clone-jobs:*` (CAN-7433).
    cloneJobs: true,
    // Claude/Codex/Cursor/Copilot sign-in and execution run in desktop main,
    // so the provider-choice list can offer them here.
    subscriptionProviders: true,
    // Repeat-task skill suggestions are detected and surfaced by main
    // (CAN-385); the flag and preference still gate what shows.
    skillSuggestions: true,
    // CAN-3706: promotion, invitations, and bringing local Personal projects
    // all run through main; the server authorizes each operation.
    personalOrganizationUpgrade:
      organizationOperations.personalOrganizationUpgrade === true,
    organizationInvites: organizationOperations.organizationInvites === true,
    personalProjectConversion:
      organizationOperations.personalProjectConversion === true,
  };
}

/** The preload's hosted settings bridge, when this window exposes one. */
function resolveSettingsBridge(): AccountOrganizationSettingsApi | null {
  if (typeof window === 'undefined') return null;
  const api: Partial<CanopyApi> | undefined = window.api;
  return api?.accountOrganizationSettings ?? null;
}

/** This computer's platform: the capabilities it reports run here. */
function resolveDesktopPlatform(): NodeJS.Platform {
  if (typeof window === 'undefined') return 'linux';
  return window.localPlatform ?? window.platform ?? 'linux';
}

const localFileRootOverrides = new Map<string, FileTreeRoot>();

/**
 * Register a renderer-owned, read-only file root for a full file viewer that
 * is not part of the live worktree tree (currently archived attachments).
 *
 * The caller owns the lifetime and must invoke the returned cleanup. Writes
 * still go through the main-process worktree containment gate, and archive
 * viewers omit the editor entirely, so these roots are read-only by design.
 */
export function registerLocalFileRootOverride(root: FileTreeRoot): () => void {
  localFileRootOverrides.set(root.repoId, root);
  return (): void => {
    if (localFileRootOverrides.get(root.repoId) === root) {
      localFileRootOverrides.delete(root.repoId);
    }
  };
}

function preloadTransport(): RemoteIpcTransport {
  if (typeof window === 'undefined' || !window.canopyClientTransport) {
    throw new Error('The renderer client transport is not available.');
  }
  return window.canopyClientTransport;
}

/**
 * The renderer side of the preload's `canopyClientTransport`. `chat:event`
 * shares the page's one `window.api.chat.onChatEvent` fan-out, so each event
 * still crosses the context bridge once however many consumers it has.
 */
const desktopTransport: RemoteIpcTransport = {
  invoke: (channel, ...args) =>
    preloadTransport()
      .invoke(channel, ...args)
      .catch((error: unknown) => {
        // The preload already restored the rejection and keeps main's shape in
        // a message-keyed lookup; carry it on the error the portable client
        // and `toAppError` see. The same error is always rethrown.
        attachRestoredIpcAppError(error, () => resolveIpcAppError(error));
        throw error;
      }),
  send: (channel, ...args) => {
    preloadTransport().send(channel, ...args);
  },
  on: (channel, listener) =>
    channel === REMOTE_IPC_CHANNELS.chatEvent
      ? subscribeToChatEvents((event) => listener(event))
      : preloadTransport().on(channel, listener),
};

function createDesktopMarketplaceSources(
  capabilities: CanopyCapabilities,
): MarketplaceSourcesClient | undefined {
  return capabilities.marketplaceSources === true &&
    typeof window !== 'undefined' &&
    window.plugins
    ? createIpcMarketplaceSourcesClient(window.plugins)
    : undefined;
}

function createHostedSettings(
  capabilities: CanopyCapabilities,
): AccountOrganizationSettingsClient | undefined {
  const settingsBridge = resolveSettingsBridge();
  if (capabilities.accountOrganizationSettings !== true || !settingsBridge) {
    return undefined;
  }
  const accountIds = createCanopyCloudAccountIdSource(() =>
    window.api.loadCanopyCloudAccount(),
  );
  return createDesktopSettingsClient(settingsBridge, accountIds.get, {
    onUnauthenticated: accountIds.invalidate,
  });
}

/**
 * Review approval readiness and the "Link GitHub" handoff (CAN-7162).
 * Readiness reads through the hosted settings client. Desktop can't run the
 * GitHub sign-in in place, so `startLink` opens Settings > Integrations in
 * the browser (the card's "Link GitHub" links there) and resolves `handoff`;
 * no callback ever lands here, so `resumeLink` resolves `none`.
 */
function createDesktopReviewApprovals(
  settings: AccountOrganizationSettingsClient,
): ReviewApprovalsClient {
  return {
    readiness: (input) =>
      settings.read('account.github.reviewApprovals.readiness', input),
    startLink: async () => {
      const [base, cloudAccount, hosted, routes] = await Promise.all([
        window.api.getCanopyCloudBaseUrl(),
        window.api.loadCanopyCloudAccount(),
        import('@/components/settings/hosted/desktop-settings-host-context'),
        import('@canopy/protocol/settings/route-paths'),
      ]);
      const webOrigin = base ? base.replace(/\/+$/, '') : '';
      if (webOrigin === '') throw new Error('No configured web origin');
      const path = routes.settingsRouteToPath({
        scope: 'account',
        page: 'integrations',
      });
      const opened = await hosted.openHostedSettingsExternalUrl(
        `${webOrigin}${path}`,
        {
          account: hosted.hostedSettingsAccountFrom(cloudAccount),
          webOrigin,
          location: null,
        },
      );
      if (!opened) throw new Error('Could not open the browser');
      return 'handoff';
    },
    resumeLink: () => Promise.resolve('none'),
    // One client for the app's life: a sign-in or sign-out changes whose
    // readiness the cached answers are.
    subscribeAccountChange: (listener) => {
      window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, listener);
      return (): void => {
        window.removeEventListener(
          CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
          listener,
        );
      };
    },
  };
}

/**
 * AI Credits purchases hand off to the owner's web billing page over the
 * preload's existing `account-organization-settings:payment-handoff` and
 * `…:payment-handoff-availability` channels; main mints the signed-in link
 * and opens the browser. A window without the settings bridge reports the
 * hand-off unavailable. A caller's `accountId` is sent as-is, so main
 * refuses a hand-off for an account that is no longer signed in; without
 * one, the current account's id is read the way the hosted settings client
 * reads it.
 */
function createDesktopCreditsHandoff(): CreditsHandoffClient {
  let accountIds: ReturnType<typeof createCanopyCloudAccountIdSource> | null =
    null;
  const currentAccountId = (): Promise<string | null> => {
    accountIds ??= createCanopyCloudAccountIdSource(() =>
      window.api.loadCanopyCloudAccount(),
    );
    return accountIds.get();
  };
  return {
    open: async (request): Promise<SettingsPaymentHandoffResult> => {
      const settingsBridge = resolveSettingsBridge();
      if (settingsBridge === null) return { ok: false, reason: 'unavailable' };
      const accountId = request.accountId ?? (await currentAccountId());
      if (accountId === null) return { ok: false, reason: 'unavailable' };
      try {
        return await settingsBridge.paymentHandoff({
          accountId,
          owner: request.owner,
          intent: request.intent,
        });
      } catch (error) {
        // A transport rejection may follow a launch: report it, never retry.
        reportClientAppError(error);
        return { ok: false, reason: 'failed' };
      }
    },
    availability: async (
      request = {},
    ): Promise<SettingsPaymentHandoffAvailability> => {
      const settingsBridge = resolveSettingsBridge();
      if (settingsBridge === null) return { available: false };
      const accountId = request.accountId ?? (await currentAccountId());
      if (accountId === null) return { available: false };
      try {
        return await settingsBridge.paymentHandoffAvailability({ accountId });
      } catch (error) {
        reportClientAppError(error);
        return { available: false };
      }
    },
  };
}

const CONTRACT_MISMATCH_SOURCE = 'ipc_client.contract_mismatch';

/**
 * A host reply that broke its channel's contract, recorded apart from a
 * transport failure (CAN-7116). Only the fixed source, the class and V8 `at`
 * frames leave, never the message.
 */
function reportContractMismatch(error: Error): void {
  const { name, frames } = canopyErrorDiagnostic(error);
  reportClientAppError(
    createAppError('app.unexpected', {
      source: CONTRACT_MISMATCH_SOURCE,
      detail: { name, message: CONTRACT_MISMATCH_SOURCE },
    }),
    { frames },
  );
}

/**
 * The desktop's `CanopyClient`: the portable adapter
 * (`@canopy/ipc-canopy-client`) over the preload's channel-limited transport,
 * with the renderer stores and host slices as its ports. Shared feature
 * components consume it through `CanopyClientProvider` and never touch
 * `window.api` directly.
 */
/** Load the panel's existing renderer data paths only when a feed mounts. */
function createLazyWorkflowsPanelClient(): WorkflowsPanelClient {
  let adapter: Promise<WorkflowsPanelClient> | undefined;
  let loaded: WorkflowsPanelClient | undefined;
  const load = (): Promise<WorkflowsPanelClient> =>
    (adapter ??= import('./workflows-panel-client').then((module) => {
      loaded = module.createDesktopWorkflowsPanelClient();
      return loaded;
    }));
  return {
    subscribe: (scope, listener): (() => void) => {
      if (loaded !== undefined) return loaded.subscribe(scope, listener);
      let disposed = false;
      let release: (() => void) | undefined;
      void load().then((client) => {
        if (!disposed) release = client.subscribe(scope, listener);
      });
      return (): void => {
        disposed = true;
        release?.();
      };
    },
    dispatch: (scope, intent): void => {
      loaded?.dispatch(scope, intent);
    },
  };
}

export function createDesktopCanopyClient(
  capabilities: CanopyCapabilities = createDesktopCapabilities(
    resolveDesktopPlatform(),
    {},
    { accountOrganizationSettings: resolveSettingsBridge() !== null },
  ),
): CanopyClient {
  const marketplaceSources = createDesktopMarketplaceSources(capabilities);
  const settings = createHostedSettings(capabilities);
  const reviewApprovals =
    settings === undefined ? undefined : createDesktopReviewApprovals(settings);
  const client = createIpcCanopyClient(desktopTransport, {
    capabilities:
      reviewApprovals === undefined
        ? capabilities
        : { ...capabilities, reviewApprovalReadiness: true },
    openExternalUrl: (url) => {
      void window.api.browser.openExternal({ url });
    },
    workspaceContext: () => useWorkspaceContextStore.getState().state.context,
    standaloneChatActiveWork: () => {
      const state = useStandaloneChatStore.getState();
      return {
        chatProjectId: state.activeChatProjectId,
        workEntryId: state.activeWorkEntryId,
      };
    },
    isCoworkChatTarget,
    forkWorktreeState: async (request) => {
      const { forkOpenWorktreeState } =
        await import('@/lib/worktree-state-fork');
      await forkOpenWorktreeState(request);
    },
    resolveLocalFileRoot: (rootId) => localFileRootOverrides.get(rootId),
    scopedFiles: scopedFileOperationsFor,
    logError: (message, details) => {
      reportRendererConsoleError(message, details);
    },
    onContractMismatch: reportContractMismatch,
    toolFamilyFor: getRemoteControlChatToolFamily,
    // The preload decodes `chat:event` outputs once for the page and owns
    // the host-local output reset.
    chatEventsDecoded: true,
    observeTerminalOutput: (event, deliver) => {
      const startedAt = performance.now();
      deliver();
      // Each subscriber has its own listener; this counts the delivery once.
      recordTerminalOutputApplied(event.terminalId, event.seq, startedAt);
    },
    transcripts: ipcTranscriptReadClient,
    feedback: createDesktopFeedbackReportClient(),
    ...(marketplaceSources ? { marketplaceSources } : {}),
    ...(settings ? { settings } : {}),
  });
  return Object.assign(client, {
    ...(reviewApprovals ? { reviewApprovals } : {}),
    ...(capabilities.mcpRemoval === true
      ? {
          mcpRemoval: {
            candidates: async () =>
              McpRemovalCandidatesResultSchema.parse(
                await window.mcpServers.removalCandidates(),
              ),
            inspect: async (request: InspectMcpRemovalRequest) =>
              InspectMcpRemovalResultSchema.parse(
                await window.mcpServers.inspectRemoval(request),
              ),
            force: async (request: ForceMcpRemovalRequest) =>
              ForceMcpRemovalResultSchema.parse(
                await window.mcpServers.forceRemoval(request),
              ),
          },
        }
      : {}),
    workflowsPanel: createLazyWorkflowsPanelClient(),
    orchestratorSettingsDraft: createOrchestratorSettingsDraftClient(),
    // Payment forms stay in the browser: purchases hand off to it.
    creditsHandoff: createDesktopCreditsHandoff(),
    autoDeleteAttentionReceipts: {
      hasShown: (incidentId: string): boolean => {
        try {
          return (
            localStorage.getItem(
              `auto-delete-attention:desktop:${incidentId}`,
            ) === 'shown'
          );
        } catch (error) {
          reportClientAppError(error);
          return false;
        }
      },
      markShown: (incidentId: string): void => {
        try {
          localStorage.setItem(
            `auto-delete-attention:desktop:${incidentId}`,
            'shown',
          );
        } catch (error) {
          // Session deduplication and the standing review remain available.
          reportClientAppError(error);
        }
      },
    },
    // A cloud chat scope answers from the web core's set (CAN-6175 D4). The
    // flags are read at call time; `useScopeCapabilities` re-renders on them.
    capabilitiesFor: (localId: string): CanopyCapabilities =>
      isWebCoreScope(localId)
        ? cloudScopeCapabilities(client.capabilities, localId)
        : client.capabilities,
    // Older hosts have no bridge; blocked remote lists mean no arms.
    listWorkEntryAutoDelete: () =>
      window.api.workEntryAutoDelete?.list() ?? Promise.resolve([]),
    subscribeWorkEntryAutoDelete: (listener) =>
      window.api.workEntryAutoDelete?.onChanged(listener) ?? (() => undefined),
    disarmWorkEntryAutoDelete: (request) =>
      window.api.workEntryAutoDelete.disarm(request),
    resolveWorkEntryAutoDeleteBranch: async (request) => {
      try {
        await window.api.workEntryAutoDelete.resolveBranch(request);
      } catch (error) {
        // Main records a rejected IPC call. Carry its record so the shared
        // store links to it instead of recording the same failure again.
        throw Object.assign(new Error('Could not save the branch choice.'), {
          appError: toAppError(resolveClientAppError(error)),
        });
      }
    },
  } satisfies Pick<
    CanopyClient,
    | 'workflowsPanel'
    | 'creditsHandoff'
    | 'orchestratorSettingsDraft'
    | 'autoDeleteAttentionReceipts'
    | 'capabilitiesFor'
    | 'listWorkEntryAutoDelete'
    | 'subscribeWorkEntryAutoDelete'
    | 'disarmWorkEntryAutoDelete'
    | 'resolveWorkEntryAutoDeleteBranch'
  >);
}

/**
 * A cloud scope's set (CAN-6175 D4). The flags, the web core's manifest and
 * the project's kind are read at call time; `useScopeCapabilities`
 * re-renders on each.
 */
function cloudScopeCapabilities(
  host: CanopyCapabilities,
  projectId: string,
): CanopyCapabilities {
  loadWebCoreServedOperations();
  return webCoreScopeCapabilities(host, {
    durableTerminals: cloudTerminalsEnabled(
      useFeatureFlagsStore.getState().isEnabled,
    ),
    costInsights: webCoreServesCost(),
    sessionBreakdown: webCoreServesSessionBreakdown(),
    taskFork: webCoreServesChatFork() && cloudProjectIsCowork(projectId),
    delegationTranscriptReads: webCoreServesDelegationPages(),
    delegationStop: webCoreServesDelegationStop(),
    cloudSubagentPanels: webCoreServesSubagentPanels(),
  });
}

/** Singleton desktop client injected into the renderer `CanopyClientProvider`. */
export const ipcCanopyClient: CanopyClient = createDesktopCanopyClient();

// Hosted account and organization settings reach the settings client through
// this registration rather than importing this module (CAN-4386).
registerHostedSettingsCanopyClient(ipcCanopyClient);
