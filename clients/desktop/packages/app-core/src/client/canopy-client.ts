import type {
  WorkEntryAutoDeleteWorkspaceSnapshot,
  WorkEntryAutoDeleteDisarmRequest,
  WorkEntryAutoDeleteResolveBranchRequest,
} from '@canopy/protocol';
import type { FeedbackReportClient } from '@canopy/protocol/feedback-report';
import type { SharedMultiRepoClient } from './shared-multi-repo-client';
import type {
  OnboardingTipsCommandMap,
  OnboardingTipsQueryMap,
} from '@canopy/protocol/onboarding-tips';
import type {
  SuggestionsCommandMap,
  SuggestionsQueryMap,
} from '@canopy/protocol/suggestions';
import type {
  ClaudeModsCommandMap,
  ClaudeModsQueryMap,
} from '@canopy/protocol/claude-mods';
import type {
  RepoRulesScanRequest,
  RepoRulesScanResponse,
  RepoRulesApplyRequest,
  RepoRulesApplyResponse,
  RepoRulesStatus,
  RepoRulesPreviewRequest,
  RepoRulesPreviewResponse,
  EditorSetupPresence,
} from '@canopy/protocol/repo-rules';
import type {
  SidebarItemGroup,
  SidebarItemGroupScope,
  SidebarItemGroupCreateRequest,
  SidebarItemGroupUpdateRequest,
  SidebarItemGroupMoveItemRequest,
  SidebarItemGroupMoveRequest,
} from '@canopy/protocol/sidebar';
import type {
  PortalChatInputDeliveryPayload,
  PortalProviderUsageRefreshPayload,
} from '@canopy/protocol/portal';
import type {
  LifecycleJournalInspection,
  LifecycleJournalQuarantineRequest,
  LifecycleJournalQuarantineResult,
} from '@canopy/protocol/portal/lifecycle-journal';
import type {
  PortalProjectDeletionDiscardDescribePayload,
  ProjectDeletionDiscardDescription,
} from '@canopy/protocol/portal/project-deletion-discard';
import type {
  PortalWorktreeDiscardDescribePayload,
  PortalWorktreeDiscardPayload,
  WorktreeDiscardDescription,
  WorktreeDiscardResult,
} from '@canopy/protocol/portal/worktree-discard';
import type {
  ManagedDelegationExtendLifetimeLimitResult,
  ManagedDelegationLifetimeStatus,
} from '@canopy/protocol/delegation';
import type {
  LoadWorktreeTerminalStateRequest,
  LoadWorktreeTerminalStateResponse,
  SaveWorktreeTerminalStateRequest,
  TerminalAttachRequest,
  TerminalAttachResponse,
  TerminalKillRequest,
  TerminalResizeRequest,
  TerminalRestoreRequest,
  TerminalSession,
  TerminalSpawnRequest,
  TerminalWriteDisposition,
  TerminalWriteRequest,
} from '@canopy/protocol/terminal';
import type {
  OrgProjectCatalogSnapshot,
  OrgProjectPreference,
  OrgProjectSetupProgress,
} from '@canopy/protocol/org-projects';
import type {
  WorkspaceContext,
  WorkspaceContextState,
} from '@canopy/protocol/workspace-context';
import type {
  OrganizationInviteResult,
  OrganizationInviteStatus,
  PersonalOrganizationPromotionOutcome,
  PersonalProject,
  PersonalProjectConversionRequest,
  PersonalProjectOperation,
  SendOrganizationInviteRequest,
  UpgradePersonalOrganizationRequest,
} from '@canopy/protocol/organizations';
import type {
  TurnFeedbackDetailRequest,
  TurnFeedbackListResponse,
  TurnFeedbackRateRequest,
} from '@canopy/protocol/turn-feedback';
import type { InstallUpdateEmailPreference } from '@canopy/protocol/account-notifications';
import type { StarSourceRepositoryResult } from '@canopy/protocol/onboarding';
import type {
  GitHubOriginRepository,
  GitHubPreviewResult,
  GitHubPreviewScope,
  GitHubPreviewTarget,
  GitHubReferenceOrigin,
  LinearIssuePreviewRequest,
  LinearIssuePreviewResult,
  LinearPreviewScope,
  LinearTeamKeysResult,
} from '@canopy/protocol/reference-previews';
import type {
  PortalChatHistoryChunk,
  PortalChatHistoryRequest,
  PortalAppAdvisorChatSummary,
  PortalEntityEnvelope,
  PortalChatCloudAttachmentRef,
  PortalAppAdvisorSettings,
  PortalAppAdvisorSettingsGetPayload,
  PortalAppAdvisorSettingsSavePayload,
  PortalChatThinkingLevel,
  PortalChatQueueEntryPayload,
  PortalChatQueueEditPayload,
  PortalChatQueueSetEditLockPayload,
  PortalDiffPayload,
  PortalDiffReadPayload,
  PortalDirectoryListing,
  PortalFileDirectoryPayload,
  PortalFileLinkResolvePayload,
  PortalFileLinkResolution,
  PortalFilePreview,
  PortalFileReadPayload,
  PortalFileRoot,
  PortalFileRootsPayload,
  PortalFileSavePayload,
  PortalFileIndexPayload,
  PortalFileIndex,
  PortalFileCreatePayload,
  PortalFileMkdirPayload,
  PortalFileRenamePayload,
  PortalFileDeletePayload,
  PortalFileMutationResult,
  PortalHookCancelPayload,
  PortalHookRunPayload,
  PortalPipelineCancelPayload,
  PortalPipelineRunPayload,
  PortalPlanDetail,
  PortalPlanGetPayload,
  PortalPlanUpdatePayload,
  PortalPrActionPayload,
  PortalPrCreatePayload,
  PortalPrRefreshPayload,
  PortalScriptCancelPayload,
  PortalScriptRunPayload,
  PortalSetSectionOrderPayload,
  PortalWorkspaceClaudeMdGetPayload,
  PortalWorkspaceClaudeMdSavePayload,
  PortalWorkspaceCreatePayload,
  PortalWorkspaceDeletePayload,
  PortalWorkspaceReorderPayload,
  PortalWorkspaceScriptsGetPayload,
  PortalWorkspaceScriptsSavePayload,
  PortalWorkspaceUpdatePayload,
  PortalWorktreeArchivePayload,
  PortalWorktreeCreatePayload,
  PortalWorktreeReorderPayload,
  PortalWorktreeUpdatePayload,
} from '@canopy/protocol/portal';
import type {
  ScriptActionsCommandMap,
  ScriptActionsQueryMap,
} from '@canopy/protocol/script-actions';
import type {
  DomainEventMap,
  DomainEventName,
  SubscriptionFilter,
  Unsubscribe,
} from '../events/domain-events';
import type { SessionViewModel } from '../view-model';
import type { CanopyCapabilities } from './capabilities';
import type { BillingClient } from './billing-client';
import type { TranscriptReadClient } from '../transcripts';
import type { ExternalAgentsClient } from './external-agents-client';
import type { MarketplaceSourcesClient } from './marketplace-sources-client';
import type { AccountOrganizationSettingsClient } from '../settings/settings-client';
import type { ShellCommandMap, ShellQueryMap } from './shell-commands';

export type { StarSourceRepositoryResult };

/**
 * Arguments for the `session.snapshot` query: scope the snapshot to a
 * workspace/worktree, or omit both for the top-level overview shell.
 */
export interface SessionSnapshotArgs {
  /** Request a complete, authorized chat inventory. Default is shell-only. */
  readonly includeChatSummaries?: boolean;
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  /**
   * Read one standalone chat with its latest turn end and questions (the
   * desktop reads them from the chat's tabs file). Hosts that predate it
   * return every standalone chat without them.
   */
  readonly standaloneChatLocalId?: string;
}

/** One composer attachment for `chat.attachments.upload`. */
export interface ChatAttachmentUploadArgs {
  /** The workspace the chat belongs to; routes the upload to its computer. */
  readonly workspaceLocalId: string;
  readonly worktreeLocalId?: string;
  readonly chatId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  /** Lowercase hex SHA-256 of `bytes`, for the composer's duplicate check. */
  readonly contentSha256: string;
}

/** Optional project/worktree scope applied after the host lists live PTYs. */
export interface TerminalListArgs {
  readonly projectId?: string;
  readonly worktreeId?: string;
}

/** Interactive shell spawn arguments exposed through the shared client. */
export type TerminalShellSpawnArgs = Omit<
  TerminalSpawnRequest,
  'managedCommand'
>;

/**
 * Map of query name → `{ args; result }`. Queries are request/response reads
 * (`ipcRenderer.invoke` on desktop, `fetch` on web). Seeded with the session
 * snapshot; feature slices extend this map here.
 */
export interface QueryMap
  extends
    ScriptActionsQueryMap,
    OnboardingTipsQueryMap,
    SuggestionsQueryMap,
    ClaudeModsQueryMap,
    ShellQueryMap {
  /** Read the authoritative managed-delegation allowance for one worktree. */
  'delegation.lifetimeStatus': {
    args: { readonly projectId: string; readonly worktreeId: string };
    result: ManagedDelegationLifetimeStatus;
  };
  'repoRules.scan': {
    args: RepoRulesScanRequest;
    result: RepoRulesScanResponse;
  };
  'repoRules.status': {
    args: { workspaceId: string };
    result: RepoRulesStatus;
  };
  'repoRules.preview': {
    args: RepoRulesPreviewRequest;
    result: RepoRulesPreviewResponse;
  };
  'editorSetup.presence': {
    args: RepoRulesScanRequest;
    result: EditorSetupPresence;
  };
  'organization.inviteStatus': {
    args: { readonly organizationId: string; readonly email: string };
    result: OrganizationInviteStatus;
  };
  'terminal.list': { args: TerminalListArgs; result: TerminalSession[] };
  'terminal.worktreeState.get': {
    args: LoadWorktreeTerminalStateRequest;
    result: LoadWorktreeTerminalStateResponse;
  };
  'file.index': { args: PortalFileIndexPayload; result: PortalFileIndex };
  'file.resolveLink': {
    args: PortalFileLinkResolvePayload;
    result: PortalFileLinkResolution | null;
  };
  'session.snapshot': { args: SessionSnapshotArgs; result: SessionViewModel };
  /** Read a file's contents (canonical `PortalFilePreview` service response). */
  'file.read': { args: PortalFileReadPayload; result: PortalFilePreview };
  /** Read a file (or combined) diff for a worktree. */
  'diff.read': { args: PortalDiffReadPayload; result: PortalDiffPayload };
  /** List a worktree's file roots (repos / attachment roots) for the file tree. */
  'file.roots': { args: PortalFileRootsPayload; result: PortalFileRoot[] };
  /** List one directory's entries under a file root, for lazy tree expansion. */
  'file.directory': {
    args: PortalFileDirectoryPayload;
    result: PortalDirectoryListing;
  };
  /**
   * Lazily fetch one turn-aligned chunk of a chat's historical (synced)
   * transcript prefix for scrollback (hybrid data model, CAN-761). The live
   * tail arrives via the `chat.message` subscription, not this query. Contract
   * defined in TS-01; adapters wire the concrete mapping in TS-05.
   */
  'chat.history': {
    args: PortalChatHistoryRequest;
    result: PortalChatHistoryChunk;
  };
  /** Read one tracked plan's detail (Plans section, markdown viewer). */
  'plan.get': { args: PortalPlanGetPayload; result: PortalPlanDetail };
  /**
   * Read a chat's persisted composer settings so the host can seed the shared
   * store on chat open (the counterpart of `chat.persistTabSettings`). `null`
   * when nothing has been persisted for the chat yet.
   */
  'chat.getTabSettings': {
    args: { readonly chatId: string };
    result: ChatTabSettings | null;
  };
  'workspace.claudeMd.get': {
    args: PortalWorkspaceClaudeMdGetPayload;
    result: string | null;
  };
  'workspace.scripts.get': {
    args: PortalWorkspaceScriptsGetPayload;
    result: Readonly<Record<string, string>> | null;
  };
  'appAdvisor.settings.get': {
    args: PortalAppAdvisorSettingsGetPayload;
    result: PortalAppAdvisorSettings | null;
  };
  /**
   * The paired computer's Orchestrator chats, one row per tab in Work Entry
   * order, with each chat's open questions (CAN-5985). Served by clients
   * whose capabilities report `appAdvisorChats`; the Portal session carries
   * the same rows in its shell state instead.
   */
  'appAdvisor.chats': {
    args: Record<string, never>;
    result: { readonly chats: readonly PortalAppAdvisorChatSummary[] };
  };
  /**
   * One worktree's plan, script, hook, pipeline and summary rows on the
   * paired computer: the entity envelopes Portal's worktree snapshot carries
   * for those panels (CAN-5985). Served by clients whose capabilities report
   * `worktreeActivityRows`; the Portal session carries the same rows in its
   * shell state instead.
   */
  'worktree.activity': {
    args: { readonly projectId: string; readonly worktreeId: string };
    result: { readonly entities: readonly PortalEntityEnvelope[] };
  };
  /**
   * Turn-level thumbs up/down ratings for one chat (CAN-1521), keyed by the
   * renderer's per-turn `localMessageId`. Never carries the comment.
   */
  'turnFeedback.list': {
    args: { readonly clientChatId: string };
    result: TurnFeedbackListResponse;
  };
  /**
   * The account's "Updates to things I've installed" email preference
   * (CAN-2334). Rejects when the host has no real value (signed out, guest,
   * offline, malformed response) so callers show a locked state and never
   * persist a default. Gated by `CanopyCapabilities.installUpdateEmails`.
   */
  'account.installUpdateEmails.get': {
    args: Record<string, never>;
    result: InstallUpdateEmailPreference;
  };
  /**
   * Organization projects (CAN-2944). The catalog for one workspace context
   * as the host caches it; `refresh` bypasses the host cache, and
   * `repositories` (with `refresh`) first asks the server to re-read the
   * organization's repositories from GitHub (CAN-3489). Hosts that have not
   * wired the catalog keep the `orgProjects` capability unset and reject.
   */
  'orgProjects.catalog': {
    args: {
      readonly context: WorkspaceContext;
      readonly refresh?: boolean;
      readonly repositories?: boolean;
    };
    result: OrgProjectCatalogSnapshot;
  };
  /**
   * Personal projects this host can bring into a team (CAN-3706). Gated by
   * `personalProjectConversion`; desktop reads its own workspaces, web asks
   * the paired desktop.
   */
  'personalOrganization.projects': {
    args: Record<string, never>;
    result: { readonly projects: readonly PersonalProject[] };
  };
  /** Durable status of one bring-along operation, or `null` when unknown. */
  'personalOrganization.operationStatus': {
    args: { readonly operationId: string };
    result: PersonalProjectOperation | null;
  };
  /** The host-owned workspace context (Personal or one organization). */
  'workspaceContext.get': {
    args: Record<string, never>;
    result: WorkspaceContextState;
  };
  /** Gated by `referencePreviews`. Local identity only; never a provider call. */
  'referencePreview.linearScope': {
    args: Record<string, never>;
    result: LinearPreviewScope;
  };
  /** Gated by `referencePreviews`. Complete accessible team-key catalog. */
  'referencePreview.linearTeams': {
    args: Record<string, never>;
    result: LinearTeamKeysResult;
  };
  /** Gated by `referencePreviews`. One exact issue; never a search. */
  'referencePreview.linearIssue': {
    args: LinearIssuePreviewRequest;
    result: LinearIssuePreviewResult;
  };
  /** Gated by `referencePreviews`. Local identity only; never a provider call. */
  'referencePreview.githubScope': {
    args: Record<string, never>;
    result: GitHubPreviewScope;
  };
  /** Gated by `referencePreviews`. The origin's single repository, from local remotes. */
  'referencePreview.githubOrigin': {
    args: GitHubReferenceOrigin;
    result: GitHubOriginRepository;
  };
  /** Gated by `referencePreviews`. One exact repository or item; never a search. */
  'referencePreview.github': {
    args: GitHubPreviewTarget;
    result: GitHubPreviewResult;
  };
}

/** Closed set of supported query names. */
export type QueryName = keyof QueryMap;

/**
 * Per-chat composer settings the shared store persists. Neutral by design — the
 * desktop adapter folds these into its `ChatTabsFile` JSON and the web adapter
 * into session-scoped browser storage; `@canopy/app-state` must not depend on
 * either persistence shape.
 */
export interface ChatTabSettings {
  /** Whether the tab is in plan mode. */
  readonly planMode: boolean;
  /** Whether a produced plan requires explicit approval before implementation. */
  readonly proposalMode: 'optional' | 'required';
  /** Composer thinking level (the wire union; `low` is hidden in the UI). */
  readonly thinkingLevel: PortalChatThinkingLevel;
  /** Opaque provider tool-input carried across restart for a pending plan exit. */
  readonly pendingPlanExit?: Readonly<Record<string, unknown>>;
}

/**
 * Arguments for `chat.persistTabSettings`: the chat to persist plus the routing
 * context the host needs to address the right slice. The store captures the
 * scope/ids from `chat.message` events; they are optional so a settings change
 * made before any message can still persist.
 */
export interface PersistChatTabSettingsArgs {
  readonly chatId: string;
  readonly scope?: 'worktree' | 'standalone' | 'app_advisor';
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  readonly settings: ChatTabSettings;
}

export type WorkspaceCreateResult =
  | {
      readonly status: 'completed';
      readonly workspaceId: string;
      /** Desktop add operation whose script scan receipt can be polled. */
      readonly scriptActionsOperationId?: string;
    }
  | { readonly status: 'pending'; readonly commandId?: string };

export type WorktreeCreateResult =
  | {
      readonly status: 'completed';
      readonly worktreeId: string;
      readonly branchName?: string;
    }
  | { readonly status: 'pending' };

/**
 * Map of command name → `{ args; result }`. Commands are imperative mutations
 * (send message, stop turn, persist tabs, end session). Seeded with session
 * end; feature slices extend this map here.
 */
/** One native background task of a chat, addressed by its provider task id. */
export interface BackgroundTaskStopRequest {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly taskId: string;
}

/**
 * `stopped`: the provider accepted the stop, and the task ends with its own
 * notification. `already-finished` / `session-ended`: it had already ended,
 * and the host reports that end itself.
 */
export type BackgroundTaskStopOutcome =
  | 'stopped'
  | 'already-finished'
  | 'session-ended';

export interface CommandMap
  extends
    ScriptActionsCommandMap,
    OnboardingTipsCommandMap,
    SuggestionsCommandMap,
    ClaudeModsCommandMap,
    ShellCommandMap {
  /** User-authorized extension of one worktree's managed-delegation allowance. */
  'delegation.extendLifetimeLimit': {
    args: { readonly projectId: string; readonly worktreeId: string };
    result: ManagedDelegationExtendLifetimeLimitResult;
  };
  /** Refresh the current provider account on the explicitly selected host. */
  'providerUsage.refresh': {
    args: PortalProviderUsageRefreshPayload & {
      readonly workspaceLocalId?: string;
    };
    result: void;
  };
  'repoRules.apply': {
    args: RepoRulesApplyRequest;
    result: RepoRulesApplyResponse;
  };
  /** Inert until the selected host explicitly enables itemGrouping. */
  'sidebar.itemGroups.create': {
    args: SidebarItemGroupCreateRequest;
    result: SidebarItemGroup;
  };
  'sidebar.itemGroups.update': {
    args: SidebarItemGroupUpdateRequest;
    result: void;
  };
  'sidebar.itemGroups.ungroup': {
    args: { scope: SidebarItemGroupScope; groupId: string };
    result: void;
  };
  'sidebar.itemGroups.moveItem': {
    args: SidebarItemGroupMoveItemRequest;
    result: void;
  };
  'sidebar.itemGroups.moveGroup': {
    args: SidebarItemGroupMoveRequest;
    result: void;
  };
  'terminal.spawn': {
    args: TerminalShellSpawnArgs;
    result: TerminalSession;
  };
  'terminal.attach': {
    args: TerminalAttachRequest;
    result: TerminalAttachResponse;
  };
  'terminal.write': {
    args: TerminalWriteRequest;
    result: TerminalWriteDisposition;
  };
  'terminal.resize': { args: TerminalResizeRequest; result: void };
  'terminal.kill': { args: TerminalKillRequest; result: void };
  'terminal.restore': {
    args: TerminalRestoreRequest;
    result: TerminalSession;
  };
  'terminal.worktreeState.save': {
    args: SaveWorktreeTerminalStateRequest;
    result: void;
  };
  /** Gated on capabilities.fileSystemAccess === 'read-write' by the caller, like file.save. */
  'file.create': {
    args: PortalFileCreatePayload;
    result: PortalFileMutationResult;
  };
  /** Gated on capabilities.fileSystemAccess === 'read-write' by the caller, like file.save. */
  'file.mkdir': {
    args: PortalFileMkdirPayload;
    result: PortalFileMutationResult;
  };
  /** Gated on capabilities.fileSystemAccess === 'read-write' by the caller, like file.save. */
  'file.rename': {
    args: PortalFileRenamePayload;
    result: PortalFileMutationResult;
  };
  /** Gated on capabilities.fileSystemAccess === 'read-write' by the caller, like file.save. */
  'file.delete': {
    args: PortalFileDeletePayload;
    result: PortalFileMutationResult;
  };

  'session.end': { args: Record<string, never>; result: void };
  'chat.persistTabSettings': {
    args: PersistChatTabSettingsArgs;
    result: void;
  };
  'chat.queue.cancel': { args: PortalChatQueueEntryPayload; result: void };
  'chat.queue.edit': { args: PortalChatQueueEditPayload; result: void };
  'chat.queue.force': { args: PortalChatQueueEntryPayload; result: void };
  'chat.queue.steer': { args: PortalChatQueueEntryPayload; result: void };
  'chat.inputDelivery': {
    args: PortalChatInputDeliveryPayload;
    result: void;
  };
  'chat.queue.set_edit_lock': {
    args: PortalChatQueueSetEditLockPayload;
    result: void;
  };
  /**
   * Write a file's contents. Gated on `capabilities.fileSystemAccess ===
   * 'read-write'` by the caller; returns the re-read `PortalFilePreview` so the
   * store can refresh its version/mtime conflict cookie.
   * Rejects with `FileSaveConflictError` when the supplied version is stale.
   * Other permission, missing-file and execution failures remain distinct.
   */
  'file.save': { args: PortalFileSavePayload; result: PortalFilePreview };
  /** Persist a workspace's activity-section order. */
  'activity.setSectionOrder': {
    args: PortalSetSectionOrderPayload;
    result: void;
  };
  /** Stop one native background task; gated by `backgroundTaskStop`. */
  'activity.stopBackgroundTask': {
    args: BackgroundTaskStopRequest;
    result: BackgroundTaskStopOutcome;
  };
  'workspace.create': {
    args: PortalWorkspaceCreatePayload;
    result: WorkspaceCreateResult;
  };
  'workspace.update': {
    args: PortalWorkspaceUpdatePayload;
    result: void;
  };
  'workspace.delete': {
    args: PortalWorkspaceDeletePayload;
    result: void;
  };
  /**
   * CAN-5335: the unreadable destructive lifecycle journal entries that make
   * deletion and archive refuse for every project. Gated by
   * `lifecycleJournalQuarantine`; a command because it writes the birth-order
   * probes that prove each entry's identity.
   */
  'lifecycleJournal.inspect': {
    args: Record<string, never>;
    result: LifecycleJournalInspection;
  };
  /** CAN-5335: user-only move of one confirmed entry to quarantine. */
  'lifecycleJournal.quarantine': {
    args: LifecycleJournalQuarantineRequest;
    result: LifecycleJournalQuarantineResult;
  };
  /**
   * CAN-5336: what a permanent discard of a worktree whose removal can't
   * finish would delete. Read-only; gated by `worktreeDiscard`.
   */
  'worktree.discard.describe': {
    args: PortalWorktreeDiscardDescribePayload;
    result: WorktreeDiscardDescription;
  };
  /** CAN-5336: user-only and permanent; binds to a description's token. */
  'worktree.discard': {
    args: PortalWorktreeDiscardPayload;
    result: WorktreeDiscardResult;
  };
  /**
   * CAN-5337: what keeps a project's deletion from finishing that a person
   * can discard, item by item through `worktree.discard`. Read-only; gated
   * by `projectDeletionDiscard`.
   */
  'workspace.delete.discard.describe': {
    args: PortalProjectDeletionDiscardDescribePayload;
    result: ProjectDeletionDiscardDescription;
  };
  'workspace.reorder': {
    args: PortalWorkspaceReorderPayload;
    result: void;
  };
  'worktree.create': {
    args: PortalWorktreeCreatePayload;
    result: WorktreeCreateResult;
  };
  'worktree.update': {
    args: PortalWorktreeUpdatePayload;
    result: void;
  };
  'worktree.archive': {
    args: PortalWorktreeArchivePayload;
    result: void;
  };
  'worktree.reorder': {
    args: PortalWorktreeReorderPayload;
    result: void;
  };
  'workspace.claudeMd.save': {
    args: PortalWorkspaceClaudeMdSavePayload;
    result: void;
  };
  'workspace.scripts.save': {
    args: PortalWorkspaceScriptsSavePayload;
    result: void;
  };
  'appAdvisor.settings.save': {
    args: PortalAppAdvisorSettingsSavePayload;
    result: void;
  };
  /**
   * Store one composer attachment on the paired computer before the send
   * that carries it (CAN-5985). The reference goes in the send's
   * `cloudAttachments`; only the client that minted it can send it. Served by
   * clients whose capabilities report `chatAttachments` without their own
   * attachment route (a directly controlled computer); Portal and cloud
   * composers keep their storage routes.
   */
  'chat.attachments.upload': {
    args: ChatAttachmentUploadArgs;
    result: PortalChatCloudAttachmentRef;
  };
  /**
   * Activity actions (Scripts / Hooks sections). Fire-and-forget mutations: the
   * run/cancel is queued and the resulting run status streams back via the
   * activity snapshot. Gated on `capabilities.localExecution` / `pipelines` by
   * the caller (the web relay queues them for the paired desktop to execute).
   */
  'script.run': { args: PortalScriptRunPayload; result: void };
  'script.cancel': { args: PortalScriptCancelPayload; result: void };
  'hook.run': { args: PortalHookRunPayload; result: void };
  'hook.cancel': { args: PortalHookCancelPayload; result: void };
  /**
   * Pipeline + PR actions (Pipelines / Pull Request sections). Fire-and-forget:
   * queued and the resulting run / PR state streams back via the activity
   * snapshot. `pr.action` is the discriminated git-action union
   * (commit_and_push / push / pull / update_base_branch / create).
   */
  'pipeline.run': { args: PortalPipelineRunPayload; result: void };
  'pipeline.cancel': { args: PortalPipelineCancelPayload; result: void };
  'pr.action': { args: PortalPrActionPayload; result: void };
  'pr.create': { args: PortalPrCreatePayload; result: void };
  'pr.refresh': { args: PortalPrRefreshPayload; result: void };
  /**
   * Update a tracked plan (Plans section: review status, content edits,
   * approve/dismiss). Fire-and-forget; the updated plan streams back via the
   * activity snapshot.
   */
  'plan.update': { args: PortalPlanUpdatePayload; result: void };
  /**
   * Stars the brand's source repository in app with the GitHub CLI's
   * account. Takes no args: the host resolves the repository. Gated by
   * `CanopyCapabilities.sourceRepositoryStar`; any `{ starred: false }`
   * result, or a rejection, falls back to opening the repository URL.
   */
  'sourceRepository.star': {
    args: Record<string, never>;
    result: StarSourceRepositoryResult;
  };
  /**
   * Turn-level thumbs up/down (CAN-1521). `rate` records the rating in one
   * click; `detail` amends that existing row with the thumbs-down reason and
   * optional comment, so skipping the dialog can never undo the rating.
   *
   * Gated by `CanopyCapabilities.turnFeedback` — a host that has not wired
   * these renders no control rather than throwing on dispatch.
   */
  'turnFeedback.rate': {
    /**
     * `clientChatId` is **required here even though `TurnFeedbackRateRequest`
     * leaves it optional**: it is optional on the wire (an older client may
     * omit it) but every host that implements this command needs it. The
     * desktop host rejects a rating without one — the `nextMsgId()` collision
     * guard depends on it — so an optional field here would let a shared caller
     * silently record nothing.
     */
    args: TurnFeedbackRateRequest & { readonly clientChatId: string };
    result: { readonly feedbackId?: string };
  };
  'turnFeedback.detail': {
    args: TurnFeedbackDetailRequest & {
      /** Correlation key of the rated turn; always known by the caller. */
      readonly clientUserMessageId: string;
      /**
       * Row id from the `turnFeedback.rate` result, when the caller has it.
       * Absent when the rating was queued offline and has no server row yet —
       * the host resolves it from `clientUserMessageId` in that case.
       */
      readonly feedbackId?: string;
    };
    result: void;
  };
  /**
   * Retracts a rating: the shared control passes `null` when the user clicks
   * the already-selected thumb. This is a distinct command rather than a
   * `rate` with a null rating because retraction has to reach the server —
   * `turnFeedback.list` rehydrates on chat open, so a clear that stayed local
   * would come back on the next fetch.
   */
  'turnFeedback.clear': {
    args: {
      readonly clientUserMessageId: string;
      /** Absent when the rating never reached the server. */
      readonly feedbackId?: string;
    };
    result: void;
  };
  /**
   * Save the "Updates to things I've installed" email preference (CAN-2334).
   * Resolves with the value the server stored, which callers render instead
   * of the requested value. Gated by `CanopyCapabilities.installUpdateEmails`.
   */
  'account.installUpdateEmails.set': {
    args: { readonly enabled: boolean };
    result: InstallUpdateEmailPreference;
  };
  /** Per-user catalog preference for one project (CAN-2944). */
  'orgProjects.setPreference': {
    args: {
      readonly projectId: string;
      readonly preference: OrgProjectPreference;
    };
    result: void;
  };
  /**
   * Claim and materialize a project on this device. Resolves with the first
   * progress report; later reports arrive on `org-projects.setup-progress`.
   */
  'orgProjects.setupStart': {
    args: {
      readonly projectId: string;
      /** Omitted for repository-less (Cowork) projects, which clone nothing. */
      readonly destinationRoot?: string;
    };
    result: OrgProjectSetupProgress;
  };
  'orgProjects.setupCancel': {
    args: { readonly projectId: string };
    result: void;
  };
  /**
   * Promote the Personal organization into a team in place (CAN-3706). Keep
   * `operationId` across retries so a lost response never promotes twice.
   * Gated by `personalOrganizationUpgrade`.
   */
  'personalOrganization.upgrade': {
    args: UpgradePersonalOrganizationRequest;
    result: PersonalOrganizationPromotionOutcome;
  };
  /**
   * Bring explicitly selected Personal projects into the team. Resolves with
   * the durable operation; `pending` outcomes are reconciled through
   * `personalOrganization.operationStatus`, never by resubmitting.
   */
  'personalOrganization.convertProjects': {
    args: PersonalProjectConversionRequest;
    result: PersonalProjectOperation;
  };
  /** Invite someone into an organization. Gated by `organizationInvites`. */
  'organization.invite': {
    args: {
      readonly organizationId: string;
      readonly invite: SendOrganizationInviteRequest;
    };
    result: OrganizationInviteResult;
  };
  /**
   * Switch the host's workspace context. `expectedRevision` is the revision
   * the caller last saw; the host rejects a stale switch so two windows cannot
   * silently overwrite each other, and the resolved state is authoritative.
   */
  'workspaceContext.set': {
    args: {
      readonly context: WorkspaceContext;
      readonly expectedRevision: number;
    };
    result: WorkspaceContextState;
  };
}

/** Closed set of supported command names. */
export type CommandName = keyof CommandMap;

/**
 * The single data-access surface shared feature code depends on. Desktop
 * implements it over `window.api`/IPC; web implements it over the portal
 * REST + long-poll layer. Adapters dispatch each call through an exhaustive
 * typed handler registry (`{ [K in Name]: (args) => ... }`) keyed by the
 * discriminated maps, which keeps the generic method bodies sound without any
 * `as` casts so the public contract stays honest.
 */
export interface CanopyClient {
  readonly feedback?: FeedbackReportClient;
  /** Open a web URL outside the app through the host's browser. */
  openExternalUrl?(url: string): void;
  readonly sharedMultiRepo?: SharedMultiRepoClient;
  /** Optional until the host wires source management and advertises its capability. */
  readonly marketplaceSources?: MarketplaceSourcesClient;
  /** Absent on hosts without inline checkout; all operations stay host-bound. */
  readonly billing?: BillingClient;
  /**
   * Child stream pages and stored field bodies. Present only where the host
   * reads them, together with the `delegationTranscriptReads` capability.
   */
  readonly transcripts?: TranscriptReadClient;
  /**
   * The External agents (MCP) pages' operations. Absent on hosts that do not
   * offer those pages; shared UI renders nothing for them when absent.
   */
  readonly externalAgents?: ExternalAgentsClient;
  /**
   * Hosted account and organization settings. Present only when the host
   * reports `capabilities.accountOrganizationSettings`.
   */
  readonly settings?: AccountOrganizationSettingsClient;
  /** Fixed capability set describing what this host can do. */
  readonly capabilities: CanopyCapabilities;

  /** Optional agent-armed removal metadata; absent on unsupported hosts. */
  listWorkEntryAutoDelete?(): Promise<WorkEntryAutoDeleteWorkspaceSnapshot[]>;
  subscribeWorkEntryAutoDelete?(
    listener: (snapshot: WorkEntryAutoDeleteWorkspaceSnapshot) => void,
  ): Unsubscribe;
  /**
   * User controls are gated by workEntryAutoDelete === 'manage'. Resolves
   * false when no arm was left to remove (a removal already finished).
   */
  disarmWorkEntryAutoDelete?(
    request: WorkEntryAutoDeleteDisarmRequest,
  ): Promise<boolean>;
  resolveWorkEntryAutoDeleteBranch?(
    request: WorkEntryAutoDeleteResolveBranchRequest,
  ): Promise<void>;

  /**
   * Notify synchronously after the host holding tip dismissals is replaced or
   * detached. Stable hosts omit this. Consumers invalidate pending replies
   * and reload through this client; no transport identity crosses the boundary.
   */
  subscribeOnboardingTipsSourceChange?(listener: () => void): Unsubscribe;
  /** Invalidates pending suggestions operations when the paired source changes. */
  subscribeSuggestionsSourceChange?(listener: () => void): Unsubscribe;

  /**
   * Capabilities for one workspace or worktree, addressed by any local id. A
   * client whose capabilities are uniform omits this; composite clients route
   * the id to the child that owns it.
   */
  capabilitiesFor?(localId: string): CanopyCapabilities;

  /** Notify the host whenever a chat becomes active, independently of settings reads. */
  activateChat?(chatId: string): void;

  /** Request/response read. */
  query<K extends QueryName>(
    name: K,
    args: QueryMap[K]['args'],
  ): Promise<QueryMap[K]['result']>;

  /** Imperative mutation. */
  command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']>;

  /**
   * Subscribe to a normalized domain event. The adapter owns the underlying
   * transport (IPC push vs long-poll cursor/backoff/reconnect); the handler
   * only ever sees mapped {@link DomainEventMap} payloads.
   */
  subscribe<K extends DomainEventName>(
    name: K,
    handler: (event: DomainEventMap[K]) => void,
    filter?: SubscriptionFilter,
  ): Unsubscribe;
}

/**
 * A refused organization operation (CAN-3706) carrying the server's typed
 * code, so shared UI can explain it without parsing transport errors. Hosts
 * reconstruct it from the validated IPC refusal envelope.
 */
export class OrganizationOperationFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OrganizationOperationFailure';
  }
}
