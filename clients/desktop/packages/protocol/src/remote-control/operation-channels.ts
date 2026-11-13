/**
 * Which {@link REMOTE_IPC_CHANNELS} each CanopyClient operation of the portable
 * adapter (`@canopy/ipc-canopy-client`) may use, including data-dependent and
 * capability-gated branches. Keys are the `QueryMap`, `CommandMap` and
 * `DomainEventMap` names from `@canopy/app-core`; the adapter's golden test
 * keeps them equal and checks every observed invoke and listener against the
 * entry for the operation that made it.
 *
 * Controller allowlists derive from this table, never from a few observed
 * calls: {@link deriveRemoteIpcChannels} returns every channel reachable from
 * the selected operations under a capability set. Later phases derive the
 * browser and hosted controller channel lists from it; this module grants no
 * authority by itself.
 *
 * `requires` records the shared UI's capability gate for the whole operation
 * or one branch (an operation the host's capabilities hide is unreachable).
 * `local` marks work answered without the transport: a value the adapter
 * holds (`answer`), a host port (`port`) or an explicit refusal
 * (`unsupported`).
 */
import { REMOTE_IPC_CHANNELS, type RemoteIpcChannel } from './ipc-channels';

const C = REMOTE_IPC_CHANNELS;

/**
 * A capability gate. A string names a boolean capability that must be `true`;
 * the object form names a capability whose value must be one of `oneOf`.
 */
export type RemoteCapabilityRequirement =
  | string
  | { readonly capability: string; readonly oneOf: readonly string[] };

/** Channels used on one data- or capability-dependent path. */
export interface RemoteOperationBranch {
  /** The condition, in words. */
  readonly when: string;
  readonly requires?: readonly RemoteCapabilityRequirement[];
  readonly invoke?: readonly RemoteIpcChannel[];
  readonly listen?: readonly RemoteIpcChannel[];
  readonly local?: 'answer' | 'port' | 'unsupported';
}

/** Every channel one operation may use. */
export interface RemoteOperationChannels {
  /** Gate for the whole operation. */
  readonly requires?: readonly RemoteCapabilityRequirement[];
  /** Invoked on every call that reaches the transport. */
  readonly invoke?: readonly RemoteIpcChannel[];
  /** Listened to for the life of a subscription. */
  readonly listen?: readonly RemoteIpcChannel[];
  readonly branches?: readonly RemoteOperationBranch[];
  readonly local?: 'answer' | 'port' | 'unsupported';
}

type OperationTable = Readonly<Record<string, RemoteOperationChannels>>;

const READ_WRITE_FILES: RemoteCapabilityRequirement = {
  capability: 'fileSystemAccess',
  oneOf: ['read-write'],
};
const WORKSPACE_SETTINGS: RemoteCapabilityRequirement = {
  capability: 'workspaceSettings',
  oneOf: ['full'],
};
const EXECUTE_PIPELINES: RemoteCapabilityRequirement = {
  capability: 'pipelines',
  oneOf: ['execute'],
};
const CATALOG_ROOT: RemoteOperationBranch = {
  when: 'the file root is a catalog root, not a host-local override',
  invoke: [C.fileTreeRoots],
};
/** A standalone chat's Work Entry, read from the computer's session snapshot. */
const STANDALONE_TARGET: readonly RemoteIpcChannel[] = [
  C.desktopSessionSnapshot,
];
/** A concrete model's provider, read from the computer's model registry. */
const MODEL_PROVIDER: RemoteOperationBranch = {
  when: 'a concrete model: its provider comes from the model registry',
  invoke: [C.modelRegistryGet],
};
const CHAT_ATTACHMENTS_UNSUPPORTED: RemoteOperationBranch = {
  when: 'cloud attachments this client did not upload (Portal or cloud storage)',
  local: 'unsupported',
};
/**
 * Attachments this client uploaded to the computer (`upload.put`, a session
 * method behind the `uploadFile` port): sent as the host paths they stand for.
 */
const CHAT_ATTACHMENTS_UPLOADED: RemoteOperationBranch = {
  when: 'attachments this client uploaded: sent as their computer paths',
  requires: ['chatAttachments'],
  local: 'answer',
};
/** The Orchestrator's sentinel workspace on the computer. */
const ORCHESTRATOR_ENTRY: RemoteOperationBranch = {
  when: 'a chat whose Work Entry the caller did not name: found among the Orchestrator Work Entries',
  invoke: [C.workEntriesList, C.chatGetState],
};
/**
 * The Orchestrator's question surface: the computer delivers ask-user
 * questions to the controller's App Advisor surface, which the client
 * declares ready before listening; answers go back on the same surface.
 */
const ORCHESTRATOR_QUESTIONS: readonly RemoteIpcChannel[] = [
  C.appAdvisorWindowRendererReady,
];
const ORCHESTRATOR_QUESTION_PUSHES: readonly RemoteIpcChannel[] = [
  C.appAdvisorToolRequest,
  C.appAdvisorToolRequestCancelled,
];

export const REMOTE_QUERY_CHANNELS = {
  'delegation.lifetimeStatus': {
    requires: ['delegationLifetimeStatusReads'],
    invoke: [C.managedDelegationLifetimeStatus],
  },
  'repoRules.scan': {
    requires: ['repoRulesImport'],
    invoke: [C.repoRulesScan],
  },
  'repoRules.status': {
    requires: ['repoRulesImport'],
    invoke: [C.repoRulesStatus],
  },
  'repoRules.preview': {
    requires: ['repoRulesImport'],
    invoke: [C.repoRulesPreview],
  },
  'editorSetup.presence': { invoke: [C.editorSetupPresence] },
  'organization.inviteStatus': {
    requires: ['organizationInvites'],
    invoke: [C.personalOrganizationUpgradeInviteStatus],
  },
  'terminal.list': { requires: ['terminalPty'], invoke: [C.terminalList] },
  'terminal.worktreeState.get': {
    requires: ['terminalPty'],
    invoke: [C.terminalLoadWorktreeState],
  },
  'file.index': { invoke: [C.fileIndexGet] },
  'file.resolveLink': { invoke: [C.fileReferenceResolve] },
  'session.snapshot': { invoke: [C.desktopSessionSnapshot] },
  'file.read': { invoke: [C.fileReadContent], branches: [CATALOG_ROOT] },
  'diff.read': {
    branches: [
      { when: 'a file path is set', invoke: [C.activityFileDiff] },
      { when: 'the combined worktree diff', local: 'unsupported' },
    ],
  },
  'file.roots': { invoke: [C.fileTreeRoots] },
  'file.directory': { invoke: [C.fileTreeDirectory] },
  'chat.history': { invoke: [C.chatGetTranscriptPage] },
  'plan.get': { invoke: [C.trackedPlansGet] },
  'chat.getTabSettings': { local: 'answer' },
  'workspace.claudeMd.get': { invoke: [C.workspaceLoadClaudeMd] },
  'workspace.scripts.get': { invoke: [C.workspaceReadScripts] },
  // The settings Portal's Orchestrator settings get serves.
  'appAdvisor.settings.get': { invoke: [C.appAdvisorSettingsView] },
  // A worktree's panel rows, as Portal's worktree snapshot carries them.
  'worktree.activity': {
    requires: ['worktreeActivityRows'],
    invoke: [C.worktreeActivityEntities],
  },
  // Every Orchestrator Work Entry's tabs, as mobile reads them.
  'appAdvisor.chats': {
    requires: ['appAdvisorChats'],
    invoke: [C.workEntriesList],
    branches: [
      { when: 'each Orchestrator Work Entry', invoke: [C.chatGetState] },
    ],
  },
  'turnFeedback.list': {
    requires: ['turnFeedback'],
    invoke: [C.turnFeedbackList],
  },
  'account.installUpdateEmails.get': {
    requires: ['installUpdateEmails'],
    invoke: [C.settingsLoadInstallUpdateEmailPreference],
  },
  'orgProjects.catalog': {
    branches: [
      { when: 'during a catalog broadcast', local: 'answer' },
      { when: 'refresh is requested', invoke: [C.orgProjectsRefresh] },
      { when: 'a cached read', invoke: [C.orgProjectsList] },
    ],
  },
  'personalOrganization.projects': {
    requires: ['personalProjectConversion'],
    invoke: [C.personalOrganizationUpgradeList],
  },
  'personalOrganization.operationStatus': {
    requires: ['personalProjectConversion'],
    invoke: [C.personalOrganizationUpgradeStatus],
  },
  'workspaceContext.get': { invoke: [C.workspaceContextGet] },
  'referencePreview.linearScope': {
    requires: ['referencePreviews'],
    invoke: [C.referencePreviewLinearScope],
  },
  'referencePreview.linearTeams': {
    requires: ['referencePreviews'],
    invoke: [C.referencePreviewLinearTeams],
  },
  'referencePreview.linearIssue': {
    requires: ['referencePreviews'],
    invoke: [C.referencePreviewLinearIssue],
  },
  'referencePreview.githubScope': {
    requires: ['referencePreviews'],
    invoke: [C.referencePreviewGitHubScope],
  },
  'referencePreview.githubOrigin': {
    requires: ['referencePreviews'],
    invoke: [C.referencePreviewGitHubOrigin],
  },
  'referencePreview.github': {
    requires: ['referencePreviews'],
    invoke: [C.referencePreviewGitHub],
  },
  'scriptActions.list': {
    requires: ['scriptActions'],
    invoke: [C.scriptActionsList],
  },
  'scriptActions.receipt': {
    requires: ['scriptActions'],
    invoke: [C.scriptActionsReceipt],
  },
  'onboardingTips.get': {
    requires: ['onboardingTips'],
    invoke: [C.preferencesLoad],
  },
  'suggestions.get': { requires: ['suggestions'], invoke: [C.preferencesLoad] },
  'claudeMods.get': {
    requires: ['claudeModAdmission'],
    invoke: [C.claudeModsGet],
  },
  'editor.fileMentions': {
    invoke: [C.fileTreeRoots],
    branches: [
      { when: 'a search, not one selected file', invoke: [C.fileIndexGet] },
      {
        when: "rebinding this client's references to another worktree",
        local: 'answer',
      },
    ],
  },
  // Read-only host operations serving what Portal's executor serves.
  'editor.slashCommands': { invoke: [C.editorListSlashCommands] },
  'editor.invocables': { invoke: [C.editorListInvocables] },
  'editor.pluginCatalog': { invoke: [C.pluginCatalogList] },
  // The worktree-scoped pipeline reads Portal's pipeline commands run.
  'pipeline.get': { invoke: [C.pipelinesGetForWorktree] },
  'pipeline.executions': { invoke: [C.pipelinesListWorktreeExecutions] },
  'pipeline.execution': {
    branches: [
      {
        when: "the shell names the run's worktree",
        invoke: [C.pipelinesGetWorktreeExecution],
      },
      { when: 'no worktree target', local: 'unsupported' },
    ],
  },
} as const satisfies OperationTable;

export const REMOTE_COMMAND_CHANNELS = {
  'delegation.extendLifetimeLimit': {
    requires: ['delegationLifetimeLimitExtension'],
    invoke: [C.managedDelegationExtendLifetimeLimit],
  },
  'providerUsage.refresh': {
    requires: ['providerQuotas'],
    invoke: [C.observabilityRefreshUsage],
  },
  'repoRules.apply': {
    requires: ['repoRulesImport'],
    invoke: [C.repoRulesApply],
  },
  'sidebar.itemGroups.create': {
    requires: ['itemGrouping'],
    invoke: [C.sidebarItemGroupsCreate],
  },
  'sidebar.itemGroups.update': {
    requires: ['itemGrouping'],
    invoke: [C.sidebarItemGroupsUpdate],
  },
  'sidebar.itemGroups.ungroup': {
    requires: ['itemGrouping'],
    invoke: [C.sidebarItemGroupsUngroup],
  },
  'sidebar.itemGroups.moveItem': {
    requires: ['itemGrouping'],
    invoke: [C.sidebarItemGroupsMoveItem],
  },
  'sidebar.itemGroups.moveGroup': {
    requires: ['itemGrouping'],
    invoke: [C.sidebarItemGroupsMoveGroup],
  },
  'terminal.spawn': { requires: ['terminalPty'], invoke: [C.terminalSpawn] },
  'terminal.attach': { requires: ['terminalPty'], invoke: [C.terminalAttach] },
  'terminal.write': { requires: ['terminalPty'], invoke: [C.terminalWrite] },
  'terminal.resize': { requires: ['terminalPty'], invoke: [C.terminalResize] },
  'terminal.kill': { requires: ['terminalPty'], invoke: [C.terminalKill] },
  'terminal.restore': {
    requires: ['terminalPty'],
    invoke: [C.terminalRestore],
  },
  'terminal.worktreeState.save': {
    requires: ['terminalPty'],
    invoke: [C.terminalSaveWorktreeState],
  },
  'file.create': {
    requires: [READ_WRITE_FILES],
    invoke: [C.fileTreeMutate],
    branches: [CATALOG_ROOT],
  },
  'file.mkdir': {
    requires: [READ_WRITE_FILES],
    invoke: [C.fileTreeMutate],
    branches: [CATALOG_ROOT],
  },
  'file.rename': {
    requires: [READ_WRITE_FILES],
    invoke: [C.fileTreeMutate],
    branches: [CATALOG_ROOT],
  },
  'file.delete': {
    requires: [READ_WRITE_FILES],
    invoke: [C.fileTreeMutate],
    branches: [CATALOG_ROOT],
  },
  'session.end': { local: 'answer' },
  'chat.persistTabSettings': {
    invoke: [C.chatCommand],
    branches: [
      {
        when: 'a standalone chat without a Work Entry id',
        local: 'port',
      },
    ],
  },
  'chat.queue.cancel': { invoke: [C.chatQueueCancel] },
  'chat.queue.edit': { invoke: [C.chatQueueEdit] },
  'chat.queue.force': { invoke: [C.chatQueueForce] },
  'chat.queue.steer': { invoke: [C.chatCommand] },
  'chat.inputDelivery': { invoke: [C.chatCommand] },
  'chat.queue.set_edit_lock': { invoke: [C.chatQueueSetEditLock] },
  'file.save': {
    requires: [READ_WRITE_FILES],
    invoke: [C.fileSaveContent],
    branches: [CATALOG_ROOT],
  },
  'activity.setSectionOrder': { invoke: [C.projectsLoad, C.projectsSave] },
  'activity.stopBackgroundTask': {
    requires: ['backgroundTaskStop'],
    invoke: [C.activityStopBgProcess],
  },
  'workspace.create': {
    requires: [
      { capability: 'workspaceCreation', oneOf: ['remote-clone', 'full'] },
    ],
    invoke: [
      C.repoDefaultCloneDir,
      C.workspaceAddFromRemote,
      C.desktopSessionSnapshotInvalidate,
    ],
  },
  'workspace.update': {
    invoke: [C.workspaceUpdateMetadata, C.desktopSessionSnapshotInvalidate],
  },
  'workspace.delete': {
    requires: [
      { capability: 'workspaceRemoval', oneOf: ['archive', 'delete'] },
    ],
    invoke: [C.projectsLoad, C.desktopSessionSnapshotInvalidate],
    branches: [
      { when: 'a single-repo project', invoke: [C.projectDelete] },
      { when: 'a multi-repo or cowork workspace', invoke: [C.workspaceDelete] },
    ],
  },
  'lifecycleJournal.inspect': {
    requires: ['lifecycleJournalQuarantine'],
    invoke: [C.lifecycleJournalInspect],
  },
  'lifecycleJournal.quarantine': {
    requires: ['lifecycleJournalQuarantine'],
    invoke: [C.lifecycleJournalQuarantine],
  },
  'worktree.discard.describe': {
    requires: ['worktreeDiscard'],
    invoke: [C.worktreeDiscardDescribe],
  },
  'worktree.discard': {
    requires: ['worktreeDiscard'],
    invoke: [C.worktreeDiscard],
  },
  'workspace.delete.discard.describe': {
    requires: ['projectDeletionDiscard'],
    invoke: [C.workspaceDeleteDiscardDescribe],
  },
  'workspace.reorder': {
    requires: ['workspaceReordering'],
    invoke: [C.workspaceReorder, C.desktopSessionSnapshotInvalidate],
  },
  'worktree.create': {
    requires: ['worktreeCreation'],
    invoke: [C.projectsLoad, C.desktopSessionSnapshotInvalidate],
    branches: [
      { when: 'a multi-repo workspace', invoke: [C.workspaceCreateWorktree] },
      { when: 'a single-repo project', invoke: [C.worktreeCreate] },
      {
        when: 'forkOpenTabs from a base worktree',
        requires: ['worktreeBranching'],
        local: 'port',
      },
    ],
  },
  'worktree.update': {
    requires: ['worktreeMetadata'],
    branches: [
      { when: 'a label change', invoke: [C.worktreeSetLabel] },
      { when: 'a hidden change', invoke: [C.worktreeSetHidden] },
      {
        when: 'anything changed',
        invoke: [C.desktopSessionSnapshotInvalidate],
      },
    ],
  },
  'worktree.archive': {
    requires: [{ capability: 'worktreeRemoval', oneOf: ['archive', 'delete'] }],
    invoke: [C.projectsLoad, C.desktopSessionSnapshotInvalidate],
    branches: [
      { when: 'a multi-repo workspace', invoke: [C.workspaceArchiveWorktree] },
      { when: 'a single-repo project', invoke: [C.worktreeArchive] },
    ],
  },
  'worktree.reorder': {
    requires: ['worktreeReordering'],
    invoke: [C.worktreeReorder, C.desktopSessionSnapshotInvalidate],
  },
  'workspace.claudeMd.save': {
    requires: [WORKSPACE_SETTINGS],
    invoke: [C.workspaceSaveClaudeMd, C.desktopSessionSnapshotInvalidate],
  },
  'workspace.scripts.save': {
    requires: [WORKSPACE_SETTINGS],
    invoke: [C.workspaceMergeScripts, C.desktopSessionSnapshotInvalidate],
  },
  // Saved as Portal's Orchestrator settings save applies the patch.
  'appAdvisor.settings.save': { invoke: [C.appAdvisorSettingsPatch] },
  'script.run': { invoke: [C.scriptRun] },
  'script.cancel': { invoke: [C.scriptStop] },
  'hook.run': { invoke: [C.hookRun] },
  'hook.cancel': { invoke: [C.hookStop] },
  'pipeline.run': {
    requires: [EXECUTE_PIPELINES],
    invoke: [
      C.worktreeGetPath,
      C.pipelinesDiscoverProject,
      C.pipelinesGet,
      C.pipelinesExecute,
    ],
  },
  'pipeline.cancel': {
    requires: [EXECUTE_PIPELINES],
    invoke: [C.pipelinesCancelExecution],
  },
  'pr.action': {
    branches: [
      {
        when: 'commit_and_push',
        invoke: [C.worktreeListRepoEntries, C.githubCommitAndPush],
      },
      { when: 'push without repo scoping', invoke: [C.githubPushOnly] },
      { when: 'pull without repo scoping', invoke: [C.githubPull] },
      {
        when: 'any other action (create, update_base_branch, get_actions, create_auto, merge, commit, cancel) or a repo-scoped push or pull',
        local: 'unsupported',
      },
    ],
  },
  'pr.create': { local: 'unsupported' },
  'pr.refresh': { invoke: [C.githubRequestRefresh] },
  'plan.update': { invoke: [C.trackedPlansUpdate] },
  'sourceRepository.star': {
    requires: ['sourceRepositoryStar'],
    invoke: [C.settingsStarSourceRepository],
  },
  'turnFeedback.rate': {
    requires: ['turnFeedback'],
    invoke: [C.turnFeedbackRate],
  },
  'turnFeedback.detail': {
    requires: ['turnFeedback'],
    invoke: [C.turnFeedbackDetail],
  },
  'turnFeedback.clear': {
    requires: ['turnFeedback'],
    invoke: [C.turnFeedbackClear],
  },
  'account.installUpdateEmails.set': {
    requires: ['installUpdateEmails'],
    invoke: [C.settingsSaveInstallUpdateEmailPreference],
  },
  'orgProjects.setPreference': { invoke: [C.orgProjectsSetPreference] },
  'orgProjects.setupStart': { invoke: [C.orgProjectsSetupStart] },
  'orgProjects.setupCancel': { invoke: [C.orgProjectsSetupCancel] },
  'personalOrganization.upgrade': {
    requires: ['personalOrganizationUpgrade'],
    invoke: [C.personalOrganizationUpgradePromote],
  },
  'personalOrganization.convertProjects': {
    requires: ['personalProjectConversion'],
    invoke: [C.personalOrganizationUpgradeConvert],
  },
  'organization.invite': {
    requires: ['organizationInvites'],
    invoke: [C.personalOrganizationUpgradeInvite],
  },
  'workspaceContext.set': { invoke: [C.workspaceContextSet] },
  'scriptActions.rescan': {
    requires: ['scriptActions'],
    invoke: [C.scriptActionsRescan],
  },
  'scriptActions.review': {
    requires: ['scriptActions'],
    invoke: [C.scriptActionsReview],
  },
  'scriptActions.setShortcut': {
    requires: ['scriptActions'],
    invoke: [C.scriptActionsSetShortcut],
  },
  'scriptActions.setPinned': {
    requires: ['scriptActions'],
    invoke: [C.scriptActionsSetPinned],
  },
  'scriptActions.enableShellAliasScan': {
    requires: ['scriptActions'],
    invoke: [C.scriptActionsEnableShellAliasScan],
  },
  'onboardingTips.update': {
    requires: ['onboardingTips'],
    invoke: [C.preferencesUpdateOnboardingTips],
  },
  'suggestions.update': {
    requires: ['suggestions'],
    invoke: [C.preferencesUpdateSuggestions],
  },
  'claudeMods.update': {
    requires: ['claudeModAdmission'],
    invoke: [C.claudeModsUpdate],
  },
  // Worktree chats: the desktop chat command envelope, as the renderer and
  // Portal's executor dispatch them.
  'chat.send': {
    invoke: [C.chatCommand],
    branches: [
      {
        when: 'no chat id: the chat is created before the message',
        invoke: [C.chatCommand],
      },
      CHAT_ATTACHMENTS_UPLOADED,
      CHAT_ATTACHMENTS_UNSUPPORTED,
    ],
  },
  'chat.cancel': {
    branches: [
      { when: 'stopping the current turn', invoke: [C.chatCancel] },
      // No server holds a first message on a direct connection: the computer
      // already has it, so Stop stops that turn and Dismiss has nothing left.
      {
        when: 'withdrawing the first message (Stop): its turn on the computer stops',
        invoke: [C.chatCancel],
      },
      {
        when: 'dismissing a first message that never reached the computer',
        local: 'answer',
      },
    ],
  },
  'chat.cancelTurn': { invoke: [C.chatCancel] },
  'chat.createTab': {
    invoke: [C.chatCommand],
    branches: [
      {
        ...MODEL_PROVIDER,
        when: 'an initial model without its provider: read from the model registry',
      },
    ],
  },
  // The tab's transcript and runtime decide archive or discard, as on Portal.
  'chat.closeTab': {
    invoke: [C.chatGetState],
    branches: [{ when: 'the tab exists and is idle', invoke: [C.chatCommand] }],
  },
  'chat.setModel': {
    invoke: [C.chatCommand],
    branches: [MODEL_PROVIDER],
  },
  'chat.setThinkingLevel': {
    branches: [
      { when: 'a thinking level', invoke: [C.chatCommand] },
      { when: 'the cloud-only default sentinel', local: 'unsupported' },
    ],
  },
  'chat.setPlanMode': { invoke: [C.chatCommand] },
  'chat.setFastMode': { invoke: [C.chatCommand] },
  'chat.setPluginSelections': { invoke: [C.chatCommand] },
  'chat.answerQuestion': { invoke: [C.chatCommand] },
  'chat.dismissQuestion': { invoke: [C.chatCommand] },
  'chat.markRead': {
    invoke: [C.chatCommand],
    branches: [{ when: 'a standalone chat', invoke: STANDALONE_TARGET }],
  },
  'chat.setUnread': {
    invoke: [C.chatCommand],
    branches: [{ when: 'a standalone chat', invoke: STANDALONE_TARGET }],
  },
  // Standalone (Cowork) chats: routed to their Work Entry.
  'standaloneChat.send': {
    invoke: [...STANDALONE_TARGET, C.chatCommand],
    branches: [
      {
        when: 'a chat the computer has not created yet',
        invoke: [C.workEntriesCreate, C.desktopSessionSnapshotInvalidate],
      },
      MODEL_PROVIDER,
      CHAT_ATTACHMENTS_UPLOADED,
      CHAT_ATTACHMENTS_UNSUPPORTED,
    ],
  },
  'standaloneChat.create': {
    requires: ['standaloneChatCreate'],
    invoke: STANDALONE_TARGET,
    branches: [
      {
        when: 'the chat has no Work Entry yet',
        invoke: [
          C.workEntriesCreate,
          C.chatCommand,
          C.desktopSessionSnapshotInvalidate,
        ],
      },
    ],
  },
  'standaloneChat.cancel': { invoke: [...STANDALONE_TARGET, C.chatCancel] },
  'standaloneChat.setModel': {
    invoke: [...STANDALONE_TARGET, C.modelRegistryGet, C.chatCommand],
  },
  'standaloneChat.setPluginSelections': {
    invoke: [...STANDALONE_TARGET, C.chatCommand],
  },
  // The Orchestrator: chats in the computer's Orchestrator Work Entries,
  // sent and stopped as mobile does; questions answered on the controller's
  // App Advisor surface, where the computer delivers them.
  'appAdvisor.send': {
    requires: ['appAdvisorChats'],
    invoke: [C.chatSendMessage],
    branches: [
      ORCHESTRATOR_ENTRY,
      {
        when: 'no Work Entry named or found: one is created',
        invoke: [C.workEntriesCreate],
      },
      { when: 'no chat id: its tab is created first', invoke: [C.chatCommand] },
      MODEL_PROVIDER,
    ],
  },
  'appAdvisor.cancel': {
    requires: ['appAdvisorChats'],
    invoke: [C.workEntriesList, C.chatGetState, C.chatCancel],
  },
  'appAdvisor.setModel': {
    requires: ['appAdvisorChats'],
    invoke: [
      C.workEntriesList,
      C.chatGetState,
      C.modelRegistryGet,
      C.chatCommand,
    ],
  },
  'appAdvisor.createTab': {
    requires: ['appAdvisorChats'],
    invoke: [C.chatCommand],
    branches: [
      {
        when: 'no Work Entry named: one is created',
        invoke: [C.workEntriesCreate],
      },
    ],
  },
  'appAdvisor.answerQuestion': {
    requires: ['appAdvisorChats'],
    invoke: [C.appAdvisorToolResponse],
  },
  'appAdvisor.dismissQuestion': {
    requires: ['appAdvisorChats'],
    invoke: [C.appAdvisorToolResponse],
  },
  // Resolved by the computer without writing; enabling the item for the chat
  // is the plugin-selection patch Portal's executor commits.
  'editor.resolveInvocable': {
    invoke: [C.editorResolveInvocable],
    branches: [
      {
        when: 'the chat does not run the item yet: its selections are committed',
        invoke: [C.chatCommand],
      },
    ],
  },
  'pipeline.resume': {
    requires: [EXECUTE_PIPELINES],
    invoke: [C.pipelinesResume],
  },
  'pipeline.retry': {
    requires: [EXECUTE_PIPELINES],
    invoke: [C.pipelinesRetryExecution],
  },
  'pipeline.rerun': {
    requires: [EXECUTE_PIPELINES],
    invoke: [C.pipelinesRerunExecution],
  },
  'pipeline.requestLog': { invoke: [C.pipelinesReadStepLog] },
  'pipeline.installCurated': { invoke: [C.pipelinesCuratedImport] },
  // The run's log tail; its rows are read again with the worktree's.
  'script.requestLog': { invoke: [C.scriptReadRunLog] },
  // One host operation applies the change to the latest worktree row, for
  // one hook or every hook, as Portal's hook pause does.
  'hook.pause': { invoke: [C.hookChangePause] },
  'hook.resume': { invoke: [C.hookChangePause] },
  'plan.delete': { invoke: [C.trackedPlansDelete] },
  'summary.refresh': { invoke: [C.worktreeSummaryRefresh] },
  'watcher.delete': { invoke: [C.appAdvisorWatcherDelete] },
  // `upload.put` is a session method, not an IPC channel: the host port.
  'chat.attachments.upload': { requires: ['chatAttachments'], local: 'port' },
} as const satisfies OperationTable;

export const REMOTE_EVENT_CHANNELS = {
  'terminal.output': { requires: ['terminalPty'], listen: [C.terminalOutput] },
  'terminal.exit': { requires: ['terminalPty'], listen: [C.terminalExit] },
  'terminal.running-changed': {
    requires: ['terminalPty'],
    listen: [C.terminalRunningChanged],
  },
  'connection.status': { local: 'port' },
  'session.snapshot-stale': { listen: [C.desktopSessionSnapshotStale] },
  'chat.message': { listen: [C.chatEvent] },
  'workspace-context.changed': { listen: [C.workspaceContextChanged] },
  'org-projects.changed': { listen: [C.orgProjectsChanged] },
  'org-projects.setup-progress': { listen: [C.orgProjectsSetupProgress] },
  'delegation.lifetimeChanged': {
    requires: ['delegationLifetimeStatusReads'],
    listen: [C.managedDelegationLifetimeChanged],
  },
  'scriptActions.changed': {
    requires: ['scriptActions'],
    listen: [C.scriptActionsChanged],
  },
  // On the App Advisor surface: declared ready (so waiting questions are
  // delivered again), questions and their withdrawals listened to, and any
  // other renderer request refused at once, as mobile does.
  'appAdvisor.changed': {
    requires: ['appAdvisorChats'],
    invoke: [...ORCHESTRATOR_QUESTIONS, C.appAdvisorToolResponse],
    listen: ORCHESTRATOR_QUESTION_PUSHES,
  },
  // The pushes the desktop's own panels refresh on; the client re-reads.
  'worktree.activityChanged': {
    requires: ['worktreeActivityRows'],
    listen: [
      C.pipelinesExecutionEvent,
      C.trackedPlansUpdated,
      C.hookStarted,
      C.hookComplete,
      C.scriptStarted,
      C.scriptComplete,
      C.worktreeSummaryUpdated,
      C.worktreeSummaryGenerating,
    ],
  },
} as const satisfies OperationTable;

/**
 * Optional `CanopyClient` members the adapter serves over the transport.
 * Port-owned members (settings, feedback, marketplace sources, transcript
 * reads, `openExternalUrl`) use no adapter channel.
 */
export const REMOTE_MEMBER_CHANNELS = {
  sharedMultiRepo: {
    requires: ['sharedMultiRepo'],
    invoke: [
      C.orgProjectsSharedMultiRepoPrepare,
      C.orgProjectsSharedMultiRepoCreate,
      C.orgProjectsSharedMultiRepoGetCreation,
      C.orgProjectsSharedMultiRepoListCreations,
      C.orgProjectsRefresh,
      C.orgProjectsSetupCancel,
    ],
  },
} as const satisfies OperationTable;

export type RemoteQueryOperation = keyof typeof REMOTE_QUERY_CHANNELS;
export type RemoteCommandOperation = keyof typeof REMOTE_COMMAND_CHANNELS;
export type RemoteEventOperation = keyof typeof REMOTE_EVENT_CHANNELS;
export type RemoteMemberOperation = keyof typeof REMOTE_MEMBER_CHANNELS;

/** A capability set as the shared UI reads it (`CanopyCapabilities`). */
export type RemoteCapabilityValues = Readonly<Record<string, unknown>>;

/** True when `capabilities` meets every requirement. */
export function meetsRemoteCapabilityRequirements(
  requirements: readonly RemoteCapabilityRequirement[] | undefined,
  capabilities: RemoteCapabilityValues,
): boolean {
  return (requirements ?? []).every((requirement) => {
    if (typeof requirement === 'string') {
      return capabilities[requirement] === true;
    }
    const value = capabilities[requirement.capability];
    return typeof value === 'string' && requirement.oneOf.includes(value);
  });
}

export interface RemoteOperationChannelUse {
  readonly invoke: ReadonlySet<RemoteIpcChannel>;
  readonly listen: ReadonlySet<RemoteIpcChannel>;
}

/**
 * Channels one entry can reach. Without `capabilities`, every branch counts
 * (the adapter's full reach); with them, gated operations and branches the
 * capabilities hide contribute nothing.
 */
export function remoteOperationChannelUse(
  entry: RemoteOperationChannels,
  capabilities?: RemoteCapabilityValues,
): RemoteOperationChannelUse {
  const invoke = new Set<RemoteIpcChannel>();
  const listen = new Set<RemoteIpcChannel>();
  const reachable = (
    requirements: readonly RemoteCapabilityRequirement[] | undefined,
  ): boolean =>
    capabilities === undefined ||
    meetsRemoteCapabilityRequirements(requirements, capabilities);
  if (!reachable(entry.requires)) return { invoke, listen };
  const add = (
    branch: Pick<RemoteOperationChannels, 'invoke' | 'listen'>,
  ): void => {
    branch.invoke?.forEach((channel) => invoke.add(channel));
    branch.listen?.forEach((channel) => listen.add(channel));
  };
  add(entry);
  entry.branches?.forEach((branch) => {
    if (reachable(branch.requires)) add(branch);
  });
  return { invoke, listen };
}

/**
 * Operation names to include. Without a selection every operation counts;
 * with one, a kind it omits contributes nothing.
 */
export interface RemoteOperationSelection {
  readonly queries?: readonly RemoteQueryOperation[];
  readonly commands?: readonly RemoteCommandOperation[];
  readonly events?: readonly RemoteEventOperation[];
  readonly members?: readonly RemoteMemberOperation[];
}

function selectedEntries<Table extends OperationTable>(
  table: Table,
  names: readonly (keyof Table & string)[] | undefined,
  all: boolean,
): RemoteOperationChannels[] {
  return (names ?? (all ? Object.keys(table) : [])).flatMap((name) => {
    const entry = table[name];
    return entry ? [entry] : [];
  });
}

/**
 * The sorted channels reachable from the selected operations under
 * `capabilities`: the basis for a controller allowlist. A channel appears
 * once, whether it is invoked, listened to, or both.
 */
export function deriveRemoteIpcChannels(
  options: {
    readonly operations?: RemoteOperationSelection;
    readonly capabilities?: RemoteCapabilityValues;
  } = {},
): RemoteIpcChannel[] {
  const all = options.operations === undefined;
  const operations = options.operations ?? {};
  const entries = [
    ...selectedEntries(REMOTE_QUERY_CHANNELS, operations.queries, all),
    ...selectedEntries(REMOTE_COMMAND_CHANNELS, operations.commands, all),
    ...selectedEntries(REMOTE_EVENT_CHANNELS, operations.events, all),
    ...selectedEntries(REMOTE_MEMBER_CHANNELS, operations.members, all),
  ];
  const channels = new Set<RemoteIpcChannel>();
  for (const entry of entries) {
    const use = remoteOperationChannelUse(entry, options.capabilities);
    use.invoke.forEach((channel) => channels.add(channel));
    use.listen.forEach((channel) => channels.add(channel));
  }
  return Array.from(channels).sort();
}
