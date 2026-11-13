import { isVoiceDictationPlatform } from '@canopy/desktop-shared/platform-capabilities';
import type {
  AccountOrganizationSettingsApi,
  CanopyApi,
  FileTreeRoot,
} from '@canopy/desktop-shared/types';
import { getPortalChatToolFamily } from '@canopy/desktop-shared/lib/portal-tool-family';
import type { CanopyCapabilities, CanopyClient } from '@canopy/app-core';
import type { MarketplaceSourcesClient } from '@canopy/app-core/client';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import { createIpcCanopyClient } from '@canopy/ipc-canopy-client';
import { scopedFileOperationsFor } from '@/lib/files/workspace-file-source';
import type { RemoteIpcTransport } from '@canopy/protocol/remote-control';
import { REMOTE_IPC_CHANNELS } from '@canopy/protocol/remote-control/channels';
import { subscribeToChatEvents } from '@/lib/chatEventFanout';
import { isWebCoreScope } from '@/lib/chat-authority';
import { isCoworkChatTarget } from '@/lib/cowork';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import {
  cloudTerminalsEnabled,
  webCoreScopeCapabilities,
} from '@/lib/web-core-scope-capabilities';
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
): CanopyCapabilities {
  return {
    // Reporting eligibility is supplied by the account-aware recovery host.
    // Keep the general client closed while the account is unresolved/guest.
    feedbackReports: false,
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
    // Payment forms stay in the browser; hosted settings hand off to it.
    inlineCheckout: false,
    // Hosted account and organization settings run through main's settings
    // bridge, so they are on only when the preload exposes it.
    accountOrganizationSettings:
      hostedSettings.accountOrganizationSettings === true,
    terminalPty: true,
    fileSystemAccess: 'read-write',
    voice: isVoiceDictationPlatform(platform),
    settingsScope: 'full',
    pipelines: 'execute',
    routing: 'in-memory',
    overviewNotifications: true,
    sidebarActivityMode: true,
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
    // `workspace:delete-discard-describe` and the supersede field (CAN-5337).
    projectDeletionDiscard: true,
    // Observed cost reads over the `cost:*` IPC.
    costInsights: true,
    providerQuotas: true,
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
  invoke: (channel, ...args) => preloadTransport().invoke(channel, ...args),
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
 * The desktop's `CanopyClient`: the portable adapter
 * (`@canopy/ipc-canopy-client`) over the preload's channel-limited transport,
 * with the renderer stores and host slices as its ports. Shared feature
 * components consume it through `CanopyClientProvider` and never touch
 * `window.api` directly.
 */
export function createDesktopCanopyClient(
  capabilities: CanopyCapabilities = createDesktopCapabilities(
    resolveDesktopPlatform(),
    {},
    { accountOrganizationSettings: resolveSettingsBridge() !== null },
  ),
): CanopyClient {
  const marketplaceSources = createDesktopMarketplaceSources(capabilities);
  const settings = createHostedSettings(capabilities);
  const client = createIpcCanopyClient(desktopTransport, {
    capabilities,
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
    toolFamilyFor: getPortalChatToolFamily,
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
    // A cloud chat scope answers from the web core's set (CAN-6175 D4). The
    // flags are read at call time; `useScopeCapabilities` re-renders on them.
    capabilitiesFor: (localId: string): CanopyCapabilities =>
      isWebCoreScope(localId)
        ? webCoreScopeCapabilities(client.capabilities, {
            durableTerminals: cloudTerminalsEnabled(
              useFeatureFlagsStore.getState().isEnabled,
            ),
          })
        : client.capabilities,
    // Older hosts have no bridge; blocked remote lists mean no arms.
    listWorkEntryAutoDelete: () =>
      window.api.workEntryAutoDelete?.list() ?? Promise.resolve([]),
    subscribeWorkEntryAutoDelete: (listener) =>
      window.api.workEntryAutoDelete?.onChanged(listener) ?? (() => undefined),
    disarmWorkEntryAutoDelete: (request) =>
      window.api.workEntryAutoDelete.disarm(request),
    resolveWorkEntryAutoDeleteBranch: (request) =>
      window.api.workEntryAutoDelete.resolveBranch(request),
  } satisfies Pick<
    CanopyClient,
    | 'capabilitiesFor'
    | 'listWorkEntryAutoDelete'
    | 'subscribeWorkEntryAutoDelete'
    | 'disarmWorkEntryAutoDelete'
    | 'resolveWorkEntryAutoDeleteBranch'
  >);
}

/** Singleton desktop client injected into the renderer `CanopyClientProvider`. */
export const ipcCanopyClient: CanopyClient = createDesktopCanopyClient();

// Hosted account and organization settings reach the settings client through
// this registration rather than importing this module (CAN-4386).
registerHostedSettingsCanopyClient(ipcCanopyClient);
