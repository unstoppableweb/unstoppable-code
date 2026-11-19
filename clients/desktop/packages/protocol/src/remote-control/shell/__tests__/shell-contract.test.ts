import { ProjectDeletionDiscardDescriptionSchema } from '../project-deletion-discard-schemas';
import { parseRemoteControlWatcher } from '../index';
import { openCodeAccountSnapshotSchema } from '../opencode-accounts';
import {
  readChatWatcherFired,
  REMOTE_CONTROL_CAPABILITY_APP_ADVISOR,
  REMOTE_CONTROL_CAPABILITY_INVOCABLE_INVENTORY,
  REMOTE_CONTROL_CAPABILITY_PIPELINE_CHAT_FOLLOW_UP,
  REMOTE_CONTROL_CAPABILITY_CLAUDE_MOD_ADMISSION,
  REMOTE_CONTROL_CAPABILITY_CLAUDE_MOD_SURFACE,
  REMOTE_CONTROL_CAPABILITY_PIPELINE_CONTENT,
  REMOTE_CONTROL_PIPELINE_CONTENT_PAGE_MAX_CHARS,
  REMOTE_CONTROL_CAPABILITY_SIDEBAR_ACTIVITY_INVENTORY,
  REMOTE_CONTROL_CAPABILITY_PIPELINE_DISPATCH,
  REMOTE_CONTROL_CAPABILITY_PIPELINE_RUN_CHAT_LINKS,
  REMOTE_CONTROL_CAPABILITY_WORKTREE_RETENTION,
  REMOTE_CONTROL_CAPABILITY_PLUGIN_MUTATIONS,
  REMOTE_CONTROL_CAPABILITY_WORKSPACE_ITEMS,
  REMOTE_CONTROL_CATALOG_CONTENT_MAX_BYTES,
  REMOTE_CONTROL_CATALOG_RESULT_MAX_BYTES,
  REMOTE_CONTROL_COMMAND_TYPES,
  REMOTE_CONTROL_COMMAND_TYPES_SET,
  REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES,
  repositoryNameFromCloneUrl,
  REMOTE_CONTROL_CAPABILITY_COLLECTION_MUTATIONS,
  type RemoteControlCollectionsSaveResult,
  REMOTE_CONTROL_ENTITY_TYPES,
  REMOTE_CONTROL_EVENT_TYPES,
  REMOTE_CONTROL_CAPABILITY_PROVIDER_USAGE,
  REMOTE_CONTROL_CAPABILITY_PROVIDER_USAGE_LIMITS,
  REMOTE_CONTROL_PROVIDER_USAGE_PROVIDERS,
  RemoteControlProviderUsageLimitsGetPayloadSchema,
  isRemoteControlProviderUsageProvider,
  parseInputDeliveryViews,
  parseChatAgentSentInfo,
  parseSteeringCapabilities,
  projectRemoteControlPipelineDispatchInputs,
  REMOTE_CONTROL_TARGET_KEYS,
  type RemoteControlAppAdvisorAnswerQuestionPayload,
  type RemoteControlPipelineChatFollowUpPrepareResult,
  type RemoteControlPipelineContentReadResult,
  type RemoteControlPipelineRun,
  type RemoteControlAppAdvisorCancelPayload,
  type RemoteControlAppAdvisorChatEventPayload,
  type RemoteControlAppAdvisorChatSummary,
  type RemoteControlAppAdvisorDismissQuestionPayload,
  type RemoteControlAppAdvisorProjectAgentAccess,
  type RemoteControlAppAdvisorProjectAgentAccessOwnerOption,
  type RemoteControlAppAdvisorSettings,
  type RemoteControlAppAdvisorSettingsSavePayload,
  type RemoteControlAppAdvisorSendPayload,
  type RemoteControlAppAdvisorSetModelPayload,
  type RemoteControlMcpConnectionMetadata,
  type RemoteControlAskUserQuestion,
  type RemoteControlAskUserQuestionAnswer,
  type RemoteControlAskUserQuestionState,
  type RemoteControlChatAnswerQuestionPayload,
  type RemoteControlChatCreateTabPayload,
  type ChatAgentSentInfo,
  type RemoteControlChatMessage,
  type RemoteControlChatMessageView,
  type RemoteControlQueuedMessage,
  type RemoteControlChatDismissQuestionPayload,
  type RemoteControlChatProviderAvailability,
  type RemoteControlChatTodoProjection,
  type RemoteControlChatSetFastModePayload,
  type RemoteControlChatSetModelPayload,
  type RemoteControlChatSetPlanModePayload,
  type RemoteControlChatSetThinkingLevelPayload,
  type RemoteControlChatSummaryEntity,
  type RemoteControlChatSummaryPluginSelections,
  type RemoteControlCodeViewerSelection,
  type RemoteControlChatListPluginCatalogPayload,
  type RemoteControlChatSetPluginSelectionsPayload,
  type RemoteControlCommandPayloadMap,
  type RemoteControlProviderUsageAccount,
  type RemoteControlProviderUsageEntry,
  type RemoteControlProviderUsageProjection,
  type RemoteControlWorktreeUpdatePayload,
  REMOTE_CONTROL_ADAPTER_FAILURE_CODES,
  REMOTE_CONTROL_WORKTREE_CREATE_REFUSAL_REASONS,
  REMOTE_CONTROL_CAPABILITY_WORKTREE_CREATE_FROM,
  REMOTE_CONTROL_CAPABILITY_WORK_ENTRY_COMMANDS,
  REMOTE_CONTROL_CAPABILITY_SIDEBAR_ITEM_GROUP_NAMES,
  REMOTE_CONTROL_CAPABILITY_TASK_REFS,
  type RemoteControlStandaloneChatCreateResult,
  type RemoteControlTaskRefsListResult,
  type RemoteControlWorktreeCreateResult,
  type RemoteControlChatScheduledMessages,
  type RemoteControlCommandFailedPayload,
  type RemoteControlCommandEnumParityGuards,
  type RemoteControlWorkspaceItemsListNotesResult,
  type RemoteControlWorkspaceItemsReadNoteResult,
  type RemoteControlWorkspaceItemsListPromptsResult,
  type RemoteControlWorkspaceItemsReadPromptResult,
  type RemoteControlWorkspaceItemsListAttachmentsResult,
  type RemoteControlCollectionsGetResult,
  type RemoteControlCollectionsListResult,
  type RemoteControlMcpGetServerResult,
  type RemoteControlMcpListServersResult,
  type RemoteControlPipelineGetPayload,
  type RemoteControlPipelineGetResult,
  type RemoteControlPipelineExecutionListResult,
  type RemoteControlMarketplaceRow,
  type RemoteControlPluginCatalog,
  type RemoteControlPluginDetailResult,
  type RemoteControlPluginsListMarketplacesResult,
  type RemoteControlCatalogMarkdownContent,
  type RemoteControlSkillsListResult,
  type RemoteControlStandaloneChatSendPayload,
  type RemoteControlStandaloneChatSetModelPayload,
  type RemoteControlSessionShellState,
  type RemoteControlStandaloneChatSummary,
  type RemoteControlStandaloneWorkEntryFields,
} from '../index';
import * as remoteControlContract from '../index';
import * as remoteControlPackageEntry from '@canopy/protocol/remote-control/shell';
import {
  parseClaudeModsGetArgs,
  parseClaudeModsState,
  parseClaudeModsUpdate,
  parseClaudeModsUpdateResult,
} from '../../../claude-mods';
import type {
  RemoteControlChangedFiles,
  RemoteControlChangedFilesPageResult,
  RemoteControlChangedFilesPayload,
  RemoteControlStateRequestPayload,
} from '../index';

describe('changed-files paging contract compatibility', () => {
  it('round-trips legacy payloads and state requests without paging metadata', () => {
    const legacyPayload: RemoteControlChangedFilesPayload = {
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      uncommitted: [{ filePath: 'src/a.ts', status: 'modified' }],
      committed: [],
    };
    const legacyProjection: RemoteControlChangedFiles = {
      worktreeLocalId: 'worktree-1',
      uncommitted: legacyPayload.uncommitted,
      committed: [],
    };
    const legacyRequest: RemoteControlStateRequestPayload = {
      scope: 'diff',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
      },
    };

    expect(JSON.parse(JSON.stringify(legacyPayload))).toEqual(legacyPayload);
    expect(JSON.parse(JSON.stringify(legacyProjection))).toEqual(
      legacyProjection,
    );
    expect(JSON.parse(JSON.stringify(legacyRequest))).toEqual(legacyRequest);
  });

  it('round-trips capped payloads and typed changed-files page results', () => {
    const payload: RemoteControlChangedFilesPayload = {
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      uncommitted: [{ filePath: 'src/a.ts', status: 'modified' }],
      committed: [],
      notices: [{ kind: 'truncated' }],
      page: {
        revision: '0123456789abcdef',
        uncommitted: { total: 3, nextCursor: 'cursor-u' },
        committed: { total: 0 },
      },
    };
    const projection: RemoteControlChangedFiles = {
      worktreeLocalId: 'worktree-1',
      uncommitted: payload.uncommitted,
      committed: [],
      page: payload.page,
    };
    const request: RemoteControlStateRequestPayload = {
      scope: 'diff',
      target: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
      },
      changedFilesPage: {
        group: 'uncommitted',
        cursor: 'cursor-u',
        limit: 2000,
      },
    };
    const result: RemoteControlChangedFilesPageResult = {
      changedFilesPage: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
        group: 'uncommitted',
        revision: '0123456789abcdef',
        files: [{ filePath: 'src/b.ts', status: 'modified' }],
        total: 3,
        nextCursor: 'cursor-u-2',
      },
    };
    const errorResult: RemoteControlChangedFilesPageResult = {
      changedFilesPage: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
        group: 'committed',
        cursor: 'cursor-c',
        error: 'stale_cursor',
      },
    };

    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(JSON.parse(JSON.stringify(errorResult))).toEqual(errorResult);
  });
});

describe('Portal terminal failure recovery contract', () => {
  it('carries the capability-gated retry request', () => {
    const command = 'portal.chat.retry_failure';
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(command);
    expect(REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    const request: RemoteControlCommandPayloadMap[typeof command] = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      turnId: 'prompt-1',
      failedMessageId: 'failure-1',
      action: 'retry',
      idempotencyKey: 'retry-1',
    };
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });
});

describe('Portal branch picker contract', () => {
  it('negotiates the branch catalogue independently of the existing create payload', () => {
    const command = 'portal.worktree.branches.list';
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(command);
    expect(REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    const query: RemoteControlCommandPayloadMap[typeof command] = {
      workspaceId: 'ws',
    };
    expect(JSON.parse(JSON.stringify(query))).toEqual({ workspaceId: 'ws' });
    for (const baseBranch of [
      'refs/heads/develop',
      'refs/heads/origin/develop',
      'refs/remotes/origin/develop',
    ]) {
      const create: RemoteControlCommandPayloadMap['portal.worktree.create'] = {
        workspaceId: 'ws',
        baseBranch,
      };
      expect(JSON.parse(JSON.stringify(create))).toEqual({
        workspaceId: 'ws',
        baseBranch,
      });
    }
  });
});

describe('repository owner Portal command', () => {
  it('is a non-destructive command with a URL payload', () => {
    const command = 'portal.org_projects.find_repository_owner';
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(command);
    expect(REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    const payload: RemoteControlCommandPayloadMap[typeof command] = {
      remoteUrl: 'git@github.com:acme/catalog.git',
    };
    expect(payload).toEqual({ remoteUrl: 'git@github.com:acme/catalog.git' });
  });
});

describe('portal protocol contract', () => {
  it('preserves explicit local and remote identities through saved JSON payloads', () => {
    for (const branchName of [
      'topic',
      'origin/topic',
      'heads/topic',
      'remotes/origin/topic',
      'refs/heads/topic',
    ]) {
      for (const isRemote of [false, true]) {
        const target = { branchName, isRemote };
        const baseBranch =
          remoteControlContract.encodeWorktreeBaseBranch(target);
        expect(baseBranch).toBe(
          `${isRemote ? 'remote' : 'local'}:${branchName}`,
        );
        const wire: RemoteControlCommandPayloadMap['portal.worktree.create'] = {
          workspaceId: 'ws',
          baseBranch,
          baseBranchEncoding:
            remoteControlContract.REMOTE_CONTROL_WORKTREE_BASE_BRANCH_ENCODING,
        };
        const payload: unknown = JSON.parse(JSON.stringify(wire));
        expect(payload).toMatchObject({ baseBranchEncoding: 'explicit-v2' });
        if (
          typeof payload !== 'object' ||
          payload === null ||
          !('baseBranch' in payload) ||
          typeof payload.baseBranch !== 'string'
        )
          throw new Error('Saved branch identity was lost');
        expect(
          remoteControlContract.decodeWorktreeBaseBranch(payload.baseBranch),
        ).toEqual(target);
      }
    }
  });

  it('keeps legacy saved branch meanings without stripping literal prefixes', () => {
    for (const branchName of [
      'topic',
      'heads/topic',
      'remotes/origin/topic',
      'refs/heads/topic',
    ]) {
      expect(
        remoteControlContract.decodeWorktreeBaseBranch(branchName),
      ).toEqual({
        branchName,
        isRemote: false,
      });
    }
    expect(
      remoteControlContract.decodeWorktreeBaseBranch('origin/topic'),
    ).toEqual({
      branchName: 'topic',
      isRemote: true,
    });
  });

  it('requires the v2 capability rather than guessing v1 encoding support', () => {
    expect(
      remoteControlContract.supportsRemoteControlWorktreeBaseBranch(undefined),
    ).toBe(false);
    expect(
      remoteControlContract.supportsRemoteControlWorktreeBaseBranch({
        worktree_base_branch_catalog_v1: true,
      }),
    ).toBe(false);
    expect(
      remoteControlContract.supportsRemoteControlWorktreeBaseBranch({
        worktree_base_branch_v2: true,
      }),
    ).toBe(true);
  });

  it('refuses malformed or revision branch encodings', () => {
    for (const value of [
      '',
      'local:',
      'remote:',
      'other:topic',
      'local:HEAD',
      'remote:topic~1',
      'local:topic^',
      'local:-topic',
      'local:topic\u0000',
      'local:topic\u007f',
      'local:topic foo',
    ]) {
      expect(remoteControlContract.decodeWorktreeBaseBranch(value)).toBeNull();
    }
  });

  it('keeps project-agent access optional for older Portal clients and pins its full shape', () => {
    const legacySettings = {
      model: 'sonnet',
      thinkingLevel: 'medium',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      instructions: '',
      archiveRetentionDays: null,
      autoArchiveDays: null,
      availableModels: [],
      providerAvailability: {},
      pluginCatalog: {
        collections: [],
        skills: [],
        plugins: [],
        mcpServers: [],
      },
      approvalsUpgradeNoticeDismissed: false,
    } satisfies RemoteControlAppAdvisorSettings;
    const legacySavePayload: RemoteControlAppAdvisorSettingsSavePayload = {
      instructions: 'Keep my existing settings.',
    };

    expect(legacySettings).not.toHaveProperty('projectAgentAccess');
    expect(legacySettings).not.toHaveProperty('projectAgentAccessOwnerOptions');
    expect(legacySavePayload).not.toHaveProperty('projectAgentAccess');

    const projectAgentAccess: RemoteControlAppAdvisorProjectAgentAccess[] = [
      { mode: 'enabled', selectedOwners: [] },
      {
        mode: 'selected-owners',
        selectedOwners: [
          { kind: 'personal' },
          { kind: 'organization', organizationId: 'org-1' },
        ],
      },
      { mode: 'disabled', selectedOwners: [] },
    ];
    const projectAgentAccessOwnerOptions: RemoteControlAppAdvisorProjectAgentAccessOwnerOption[] =
      [
        { owner: { kind: 'personal' }, label: 'Personal' },
        {
          owner: { kind: 'organization', organizationId: 'org-1' },
          label: 'Organization One',
          unavailable: true,
        },
      ];
    const settings: RemoteControlAppAdvisorSettings = {
      ...legacySettings,
      projectAgentAccess: projectAgentAccess[1],
      projectAgentAccessOwnerOptions,
    };
    const savePayload: RemoteControlAppAdvisorSettingsSavePayload = {
      projectAgentAccess: projectAgentAccess[1],
    };

    expect(settings).toMatchObject({
      projectAgentAccess: {
        mode: 'selected-owners',
        selectedOwners: [
          { kind: 'personal' },
          { kind: 'organization', organizationId: 'org-1' },
        ],
      },
      projectAgentAccessOwnerOptions: [
        { owner: { kind: 'personal' }, label: 'Personal' },
        {
          owner: { kind: 'organization', organizationId: 'org-1' },
          label: 'Organization One',
          unavailable: true,
        },
      ],
    });
    expect(savePayload).toEqual({
      projectAgentAccess: projectAgentAccess[1],
    });
  });

  it('exports bounded provider-usage account limits from the Portal package entry', () => {
    expect(
      Reflect.get(
        remoteControlPackageEntry,
        'REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNTS',
      ),
    ).toBe(50);
    expect(
      Reflect.get(
        remoteControlPackageEntry,
        'REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNT_WINDOWS',
      ),
    ).toBe(20);
    expect(
      Reflect.get(
        remoteControlContract,
        'REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNTS',
      ),
    ).toBe(50);
    expect(
      Reflect.get(
        remoteControlContract,
        'REMOTE_CONTROL_PROVIDER_USAGE_MAX_ACCOUNT_WINDOWS',
      ),
    ).toBe(20);
  });

  it('round-trips a typed provider usage entry with account windows', () => {
    const account: RemoteControlProviderUsageAccount = {
      id: 'a1b2',
      label: 'dev@example.com',
      planLabel: 'Claude Pro',
      status: 'active',
      availableAt: '2026-10-20T16:30:00.000Z',
      usageSource: 'live',
      lastUpdatedAt: '2026-10-20T16:00:00.000Z',
      windows: [
        {
          id: 'five-hour-primary',
          label: '5-hour window',
          usedPercent: 32,
          windowDurationMs: 18_000_000,
        },
      ],
    };
    const entry = {
      provider: 'claude',
      authState: 'authenticated',
      windows: [],
      accounts: [account],
    } satisfies RemoteControlProviderUsageEntry;
    const projection: RemoteControlProviderUsageProjection = {
      updatedAt: '2026-10-20T16:05:00.000Z',
      providers: [entry],
    };

    const roundTripped: unknown = JSON.parse(JSON.stringify(projection));

    expect(roundTripped).toEqual(projection);
  });

  it('keeps Auto model selection backward compatible', () => {
    const legacy: RemoteControlChatSetModelPayload = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      model: 'sonnet',
    };
    const auto: RemoteControlChatSetModelPayload = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      selectionMode: 'auto',
    };

    expect(legacy.model).toBe('sonnet');
    expect(auto.selectionMode).toBe('auto');
  });

  it('keeps New Task chat settings optional on create_tab', () => {
    const plus: RemoteControlChatCreateTabPayload = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    const newTask: RemoteControlCommandPayloadMap['portal.chat.create_tab'] = {
      ...plus,
      model: 'gpt-5-codex',
      providerType: 'codex',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    };

    expect(plus).not.toHaveProperty('model');
    expect(newTask).toMatchObject({ model: 'gpt-5-codex' });
  });

  it('validates delivery views and steering capabilities without accepting malformed optional fields', () => {
    const view = {
      id: 'row-1',
      revision: 1,
      state: 'pending',
      text: 'Continue',
      attachmentCount: 0,
      canWithdraw: true,
    };
    expect(parseInputDeliveryViews([view])).toEqual([view]);
    expect(
      parseInputDeliveryViews([{ ...view, editResubmits: 'yes' }]),
    ).toEqual([]);
    expect(
      parseSteeringCapabilities({
        provider: 'claude',
        generation: 'generation-1',
        steer: true,
        withdraw: true,
        interrupt: false,
      }),
    ).toEqual({
      provider: 'claude',
      generation: 'generation-1',
      steer: true,
      withdraw: true,
      interrupt: false,
    });
    expect(
      parseSteeringCapabilities({
        provider: 'claude',
        generation: 'generation-1',
        steer: true,
        withdraw: 'yes',
        interrupt: false,
      }),
    ).toBeUndefined();
  });

  it('parses project and bot agent-sent display metadata with a safe allowlist', () => {
    const projectInfo = {
      sender: {
        kind: 'project',
        projectType: 'cowork',
        projectId: ' project-1 ',
        taskId: 'task-1',
        chatId: 'chat-1',
        owner: { kind: 'organization', organizationId: 'private-owner' },
        hiddenSystemInstruction: 'private project instruction',
      },
      chatTitle: 'Plan tests',
      projectLabel: 'Billing API',
      hiddenContext: 'private outer context',
    };
    const botInfo = {
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'advisor-task',
        chatId: 'advisor-chat',
      },
      chatTitle: 'Review migration',
      projectLabel: 'App Advisor',
    };

    expect(parseChatAgentSentInfo(projectInfo)).toEqual({
      sender: {
        kind: 'project',
        projectType: 'cowork',
        projectId: ' project-1 ',
        taskId: 'task-1',
        chatId: 'chat-1',
      },
      chatTitle: 'Plan tests',
      projectLabel: 'Billing API',
    });
    expect(parseChatAgentSentInfo(botInfo)).toEqual(botInfo);
    expect(JSON.stringify(parseChatAgentSentInfo(projectInfo))).not.toContain(
      'private',
    );
    expect(parseChatAgentSentInfo(projectInfo)).not.toHaveProperty(
      'hiddenContext',
    );
  });

  // REG-3118: a cloud chat's send, captured by the hosted server.
  it('parses a cloud chat sender and refuses one mixed with another kind', () => {
    const cloudInfo = {
      sender: {
        kind: 'cloud_chat',
        projectId: 'workspace-1',
        taskId: 'task-1',
        chatId: 'chat-1',
      },
      chatTitle: 'Billing fix',
      projectLabel: 'Payments',
    };
    expect(parseChatAgentSentInfo(cloudInfo)).toEqual(cloudInfo);
    for (const extra of [{ botId: 'app_advisor' }, { projectType: 'code' }]) {
      expect(
        parseChatAgentSentInfo({
          ...cloudInfo,
          sender: { ...cloudInfo.sender, ...extra },
        }),
      ).toBeUndefined();
    }
    expect(
      parseChatAgentSentInfo({
        ...cloudInfo,
        sender: { ...cloudInfo.sender, chatId: '' },
      }),
    ).toBeUndefined();
  });

  it('adds agent-sent metadata to message, view, and queued display contracts', () => {
    const agentSent: ChatAgentSentInfo = {
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'advisor-task',
        chatId: 'advisor-chat',
      },
      chatTitle: 'Advisor chat',
      projectLabel: 'App Advisor',
    };
    const message: RemoteControlChatMessage = {
      messageId: 'message-1',
      chatId: 'chat-1',
      role: 'user',
      status: 'complete',
      text: 'Please review this.',
      createdAtMs: 1,
      agentSent,
    };
    const messageView: Pick<RemoteControlChatMessageView, 'agentSent'> = {
      agentSent,
    };
    const queuedMessage: Pick<RemoteControlQueuedMessage, 'agentSent'> = {
      agentSent,
    };

    expect(message.agentSent).toEqual(agentSent);
    expect(messageView.agentSent).toEqual(agentSent);
    expect(queuedMessage.agentSent).toEqual(agentSent);
  });

  it('rejects malformed and mixed project/bot agent-sent variants', () => {
    const validProject = {
      sender: {
        kind: 'project',
        projectType: 'code',
        projectId: 'project-1',
        taskId: 'task-1',
        chatId: 'chat-1',
      },
      chatTitle: 'Chat',
      projectLabel: 'Project',
    };
    const validBot = {
      sender: {
        kind: 'bot',
        botId: 'app_advisor',
        taskId: 'task-1',
        chatId: 'chat-1',
      },
      chatTitle: 'Chat',
      projectLabel: 'App Advisor',
    };

    for (const invalid of [
      null,
      [],
      { ...validProject, sender: null },
      { ...validProject, chatTitle: 1 },
      { ...validProject, projectLabel: null },
      {
        ...validProject,
        sender: { ...validProject.sender, projectType: 'personal' },
      },
      {
        ...validProject,
        sender: { ...validProject.sender, projectId: '   ' },
      },
      {
        ...validProject,
        sender: { ...validProject.sender, taskId: '' },
      },
      {
        ...validProject,
        sender: { ...validProject.sender, botId: 'app_advisor' },
      },
      {
        ...validBot,
        sender: { ...validBot.sender, projectId: 'project-1' },
      },
      {
        ...validBot,
        sender: { ...validBot.sender, projectType: 'code' },
      },
      {
        ...validBot,
        sender: { ...validBot.sender, botId: '\n' },
      },
    ]) {
      expect(parseChatAgentSentInfo(invalid)).toBeUndefined();
    }
  });

  it('parses pipeline step and automation agent-sent senders, dropping unknown keys', () => {
    const step = {
      sender: {
        kind: 'pipeline',
        executionId: 'exec-1',
        pipelineId: 'pipeline-1',
        stepId: 'notify',
        automationId: 'automation-1',
        owner: { kind: 'organization', organizationId: 'private-owner' },
      },
      chatTitle: 'Nightly triage',
      projectLabel: '',
      hiddenContext: 'private outer context',
    };
    expect(parseChatAgentSentInfo(step)).toEqual({
      sender: {
        kind: 'pipeline',
        executionId: 'exec-1',
        pipelineId: 'pipeline-1',
        stepId: 'notify',
        automationId: 'automation-1',
      },
      chatTitle: 'Nightly triage',
      projectLabel: '',
    });
    expect(JSON.stringify(parseChatAgentSentInfo(step))).not.toContain(
      'private',
    );

    const stepOnly = {
      kind: 'pipeline',
      executionId: 'exec-1',
      pipelineId: 'pipeline-1',
      stepId: 'notify',
    };
    expect(
      parseChatAgentSentInfo({ ...step, sender: stepOnly })?.sender,
    ).toEqual({
      kind: 'pipeline',
      executionId: 'exec-1',
      pipelineId: 'pipeline-1',
      stepId: 'notify',
    });
    expect(
      parseChatAgentSentInfo({
        ...step,
        sender: { kind: 'pipeline', automationId: 'automation-1' },
      })?.sender,
    ).toEqual({ kind: 'pipeline', automationId: 'automation-1' });
  });

  it('rejects partial, empty, blank and mixed pipeline agent-sent senders', () => {
    const base = { chatTitle: 'Nightly triage', projectLabel: '' };
    const step = {
      kind: 'pipeline',
      executionId: 'exec-1',
      pipelineId: 'pipeline-1',
      stepId: 'notify',
    };
    for (const sender of [
      { kind: 'pipeline' },
      { kind: 'pipeline', executionId: 'exec-1', pipelineId: 'pipeline-1' },
      { kind: 'pipeline', stepId: 'notify', automationId: 'automation-1' },
      { ...step, executionId: '  ' },
      { kind: 'pipeline', automationId: '' },
      { ...step, automationId: '\n' },
      { ...step, projectId: 'project-1' },
      { ...step, projectType: 'code' },
      { ...step, botId: 'app_advisor' },
      { ...step, chatId: 'chat-1' },
      { ...step, taskId: 'task-1' },
    ]) {
      expect(parseChatAgentSentInfo({ ...base, sender })).toBeUndefined();
    }
  });

  it('projects only valid agent-sent metadata onto input-delivery views', () => {
    const view = {
      id: 'row-agent',
      revision: 1,
      state: 'pending',
      text: 'Please review this',
      attachmentCount: 0,
      canWithdraw: true,
    };
    const agentSent = {
      sender: {
        kind: 'project',
        projectType: 'code',
        projectId: 'project-1',
        taskId: 'task-1',
        chatId: 'sender-chat',
      },
      chatTitle: 'Review',
      projectLabel: 'Repository',
    };
    expect(
      parseInputDeliveryViews([
        {
          ...view,
          agentSent: { ...agentSent, hiddenContext: 'must stay private' },
        },
      ]),
    ).toEqual([{ ...view, agentSent }]);
    const malformedView = parseInputDeliveryViews([
      {
        ...view,
        agentSent: {
          ...agentSent,
          sender: { ...agentSent.sender, botId: 'wrong-kind' },
        },
      },
    ])[0];
    expect(malformedView).toEqual(view);
    expect(malformedView).not.toHaveProperty('agentSent');
    const legacyView = parseInputDeliveryViews([view])[0];
    expect(legacyView).toEqual(view);
    expect(legacyView).not.toHaveProperty('agentSent');
  });

  it('projects safe watcher attribution for pending inputs without carrying hidden metadata', () => {
    const watcherFired = {
      kind: 'Multiple watchers fired (2)',
      combinedWatchers: [
        { kind: 'Build', text: 'Build completed' },
        { kind: 'Tests', text: 'Tests passed' },
      ],
    };
    const view = {
      id: 'row-1',
      revision: 1,
      state: 'pending',
      text: 'Events',
      attachmentCount: 0,
      canWithdraw: true,
      watcherFired,
    };
    expect(
      parseInputDeliveryViews([
        {
          ...view,
          watcherFired: {
            ...watcherFired,
            hiddenContext: 'private',
            combinedWatchers: watcherFired.combinedWatchers.map((item) => ({
              ...item,
              providerPayload: 'private',
            })),
          },
        },
      ]),
    ).toEqual([view]);
    for (const invalid of [
      null,
      { kind: 1 },
      { kind: 'Build', combinedWatchers: [null] },
      { kind: 'Build', combinedWatchers: [{ kind: 'Build', text: 1 }] },
    ]) {
      expect(
        parseInputDeliveryViews([{ ...view, watcherFired: invalid }]),
      ).toEqual([{ ...view, watcherFired: undefined }]);
    }
  });

  it('reads chat watcher attribution from the message or its cached prompt_source part', () => {
    const watcherFired = {
      kind: 'Multiple watchers fired (2)',
      combinedWatchers: [
        { kind: 'Build', text: 'Build completed' },
        { kind: 'Tests', text: 'Tests passed' },
      ],
    };
    expect(readChatWatcherFired({ watcherFired })).toEqual(watcherFired);
    expect(
      readChatWatcherFired({
        parts: [
          { kind: 'text', data: { watcherFired: { kind: 'Not provenance' } } },
          {
            kind: 'prompt_source',
            data: {
              source: 'automated',
              watcherFired: { ...watcherFired, hiddenContext: 'private' },
            },
          },
        ],
      }),
    ).toEqual(watcherFired);
    expect(
      readChatWatcherFired({
        parts: [{ kind: 'prompt_source', data: { source: 'automated' } }],
      }),
    ).toBeUndefined();
    for (const invalid of [
      null,
      'Build',
      { kind: 1 },
      { kind: 'Build', combinedWatchers: [{ kind: 'Build', text: 1 }] },
    ]) {
      expect(
        readChatWatcherFired({
          parts: [
            {
              kind: 'prompt_source',
              data: { source: 'automated', watcherFired: invalid },
            },
          ],
        }),
      ).toBeUndefined();
    }
  });

  it('registers pipeline execution controls in the command vocabulary', () => {
    const payloads = {
      'portal.pipeline.execution_list': {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        limit: 10,
      },
      'portal.pipeline.resume': {
        executionId: 'execution-1',
        pauseResponses: [
          {
            checkpointId: 'checkpoint-1',
            jobId: 'review',
            stepId: 'approval',
            answers: { approved: true },
          },
        ],
      },
      'portal.pipeline.retry': { executionId: 'execution-1' },
      'portal.pipeline.rerun': { executionId: 'execution-1' },
    } satisfies Pick<
      RemoteControlCommandPayloadMap,
      | 'portal.pipeline.execution_list'
      | 'portal.pipeline.resume'
      | 'portal.pipeline.retry'
      | 'portal.pipeline.rerun'
    >;
    const result: RemoteControlPipelineExecutionListResult = { runs: [] };

    expect(result.runs).toEqual([]);
    expect(Object.keys(payloads)).toEqual([
      'portal.pipeline.execution_list',
      'portal.pipeline.resume',
      'portal.pipeline.retry',
      'portal.pipeline.rerun',
    ]);
    for (const command of [
      'portal.pipeline.resume',
      'portal.pipeline.retry',
      'portal.pipeline.rerun',
    ] as const) {
      expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(command)).toBe(true);
    }
  });

  it('keeps pipeline detail as one explicit-locator command', () => {
    const payload: RemoteControlPipelineGetPayload = {
      projectId: 'workspace-1',
      pipelineId: 'project--ci.yml',
    };
    const result: RemoteControlPipelineGetResult = {
      definition: {
        name: 'CI',
        triggerSummary: 'Manual',
        scopes: ['worktree'],
        jobs: [],
      },
    };

    expect(payload).toEqual(
      expect.objectContaining({ pipelineId: 'project--ci.yml' }),
    );
    expect(result.definition).not.toHaveProperty('canonicalYaml');
    expect(result.definition).not.toHaveProperty('canonicalYamlTruncated');
    expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has('portal.pipeline.get')).toBe(
      true,
    );
  });

  it('pins workspace-items read payloads, results, and command parity', (): void => {
    const payloads = {
      'portal.workspace_items.list_notes': { projectId: 'workspace-1' },
      'portal.workspace_items.read_note': {
        projectId: 'workspace-1',
        noteId: 'note-1',
      },
      'portal.workspace_items.list_prompts': { projectId: 'workspace-1' },
      'portal.workspace_items.read_prompt': {
        projectId: 'workspace-1',
        promptId: 'prompt-1',
      },
      'portal.workspace_items.list_attachments': {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
      },
    } satisfies Pick<
      RemoteControlCommandPayloadMap,
      | 'portal.workspace_items.list_notes'
      | 'portal.workspace_items.read_note'
      | 'portal.workspace_items.list_prompts'
      | 'portal.workspace_items.read_prompt'
      | 'portal.workspace_items.list_attachments'
    >;
    const parity: RemoteControlCommandEnumParityGuards = [true, true];
    expect(parity).toEqual([true, true]);
    expect(
      REMOTE_CONTROL_COMMAND_TYPES.filter((command): boolean =>
        command.startsWith('portal.workspace_items.'),
      ),
    ).toEqual(Object.keys(payloads));
    expect(payloads['portal.workspace_items.read_note'].noteId).toBe('note-1');
    expect(payloads['portal.workspace_items.read_prompt'].promptId).toBe(
      'prompt-1',
    );
    expect(payloads['portal.workspace_items.list_attachments'].worktreeId).toBe(
      'worktree-1',
    );

    const notes: RemoteControlWorkspaceItemsListNotesResult = {
      ok: true,
      notes: [
        {
          id: 'note-1',
          title: 'Note',
          createdAt: '2026-09-08T00:00:00Z',
          updatedAt: '2026-09-08T00:00:00Z',
          origin: {
            worktreeId: 'worktree-1',
            branchName: 'main',
            worktreeExists: true,
          },
        },
      ],
    };
    const prompts: RemoteControlWorkspaceItemsListPromptsResult = {
      ok: true,
      prompts: [
        {
          id: 'prompt-1',
          title: 'Prompt',
          createdAt: '2026-09-08T00:00:00Z',
          updatedAt: '2026-09-08T00:00:00Z',
        },
      ],
    };
    const attachments: RemoteControlWorkspaceItemsListAttachmentsResult = {
      ok: true,
      attachments: [
        {
          filename: 'brief.pdf',
          sizeBytes: 128,
          createdAt: '2026-09-08T00:00:00Z',
        },
      ],
    };
    for (const meta of notes.notes) {
      const result: RemoteControlWorkspaceItemsReadNoteResult = {
        ok: true,
        meta,
        content: '# Note',
        truncated: false,
      };
      expect(result.content).toBe('# Note');
      expect(result.meta.origin?.worktreeExists).toBe(true);
    }
    for (const meta of prompts.prompts) {
      const result: RemoteControlWorkspaceItemsReadPromptResult = {
        ok: true,
        meta,
        content: 'Explain this',
        truncated: false,
      };
      expect(result.content).toBe('Explain this');
      expect(result.meta.origin).toBeUndefined();
    }
    type ItemKeys =
      | keyof RemoteControlWorkspaceItemsReadNoteResult['meta']
      | keyof RemoteControlWorkspaceItemsReadPromptResult['meta']
      | keyof RemoteControlWorkspaceItemsListAttachmentsResult['attachments'][number];
    const excludesLocalPaths: 'absolutePath' extends ItemKeys ? false : true =
      true;
    expect(excludesLocalPaths).toBe(true);
    expect(JSON.parse(JSON.stringify(attachments))).toEqual(attachments);
    expect(REMOTE_CONTROL_CAPABILITY_WORKSPACE_ITEMS).toBe('workspace_items');
  });

  it('keeps a PDF attachment media type as serializable viewer dispatch metadata', () => {
    const selection: RemoteControlCodeViewerSelection = {
      kind: 'file',
      title: 'brief',
      mediaType: 'application/pdf',
      request: {
        projectId: 'cloud:ws:workspace-1',
        worktreeId: 'cloud:task:chat-1',
        fileRootLocalId: 'chat-attachments-cloud%3Atask%3Achat-1|chat-1',
        relativePath: 'attachment-1/brief',
      },
    };

    expect(JSON.parse(JSON.stringify(selection))).toEqual(selection);
  });

  it('pins closed portal command/event/entity lists', () => {
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain('portal.chat.send');
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain('portal.file.save');
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(
      'portal.editor.list_slash_commands',
    );
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(
      'portal.editor.list_file_mentions',
    );
    // CAN-1233: the portal `+` tab button dispatches this command.
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain('portal.chat.create_tab');
    expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has('portal.chat.create_tab')).toBe(
      true,
    );
    // The portal tab close button dispatches this command.
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain('portal.chat.close_tab');
    expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has('portal.chat.close_tab')).toBe(
      true,
    );
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain('portal.chat.fork');
    // CAN-2829: the web marketplace shares a plugin through the paired
    // desktop, which owns the plugin files and the Cloud credentials.
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(
      'portal.plugins.share_plugin',
    );
    expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has('portal.chat.fork')).toBe(true);
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain('portal.chat.branch');
    expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has('portal.chat.branch')).toBe(
      true,
    );
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain('portal.chat.share');
    expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has('portal.chat.share')).toBe(
      true,
    );
    expect(REMOTE_CONTROL_EVENT_TYPES).toContain('portal.state.snapshot');
    expect(REMOTE_CONTROL_EVENT_TYPES).toContain('portal.file.snapshot');
    expect(REMOTE_CONTROL_ENTITY_TYPES).toContain('standalone_chat');
    expect(REMOTE_CONTROL_ENTITY_TYPES).toContain('pipeline');
    expect(REMOTE_CONTROL_ENTITY_TYPES).toContain('chat_todo');
    expect(REMOTE_CONTROL_ENTITY_TYPES).toContain('mcp_server');
    expect(REMOTE_CONTROL_ENTITY_TYPES).toContain('background_process');
  });

  it('pins the chat TODO projection', () => {
    const projection: RemoteControlChatTodoProjection = {
      localId: 'chat-1',
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      chatId: 'chat-1',
      items: [
        { id: 'todo:1', content: 'Project TODOs', status: 'in_progress' },
      ],
    };

    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
    expect(REMOTE_CONTROL_ENTITY_TYPES).toContain('chat_todo');
  });

  it('exposes the CAN-1217 persistent composer setter commands', () => {
    const setters = [
      'portal.chat.set_model',
      'portal.chat.set_thinking_level',
      'portal.chat.set_plan_mode',
      'portal.chat.set_fast_mode',
    ] as const;
    for (const setter of setters) {
      expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(setter);
      expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(setter)).toBe(true);
    }
  });

  it('lets portal.worktree.update carry a tracked base branch', () => {
    const payload: RemoteControlCommandPayloadMap['portal.worktree.update'] = {
      workspaceId: 'ws',
      worktreeId: 'wt',
      trackedBaseBranch: 'release/1.2',
    };
    // Assign to the explicit interface to prove the map alias matches.
    const explicit: RemoteControlWorktreeUpdatePayload = payload;

    expect(explicit.trackedBaseBranch).toBe('release/1.2');
    expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has('portal.worktree.update')).toBe(
      true,
    );
  });

  it('lets portal.worktree.update clear base branches, per repository too', () => {
    const payload: RemoteControlWorktreeUpdatePayload = {
      workspaceId: 'ws',
      worktreeId: 'wt',
      trackedBaseBranch: null,
      trackedRepoBaseBranches: { api: 'main', web: null },
    };

    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('carries a typed worktree create refusal on the failed payload', () => {
    const failed: RemoteControlCommandFailedPayload = {
      commandId: 'cmd-1',
      sequenceNumber: 4,
      error: {
        code: 'branch_checked_out',
        message: 'The branch is already checked out.',
      },
      refusal: { reason: 'branch_checked_out', existingWorktreeId: 'wt-2' },
      retryable: false,
      generatedAt: '2026-11-04T00:00:00.000Z',
    };
    const legacy: RemoteControlCommandFailedPayload = {
      commandId: 'cmd-2',
      sequenceNumber: 5,
      error: { code: 'execution_failed', message: 'Failed.' },
      generatedAt: '2026-11-04T00:00:00.000Z',
    };

    expect(JSON.parse(JSON.stringify(failed))).toEqual(failed);
    expect(legacy.refusal).toBeUndefined();
    // Every refusal reason is also a closed adapter failure code.
    expect(REMOTE_CONTROL_WORKTREE_CREATE_REFUSAL_REASONS).toHaveLength(13);
    for (const reason of REMOTE_CONTROL_WORKTREE_CREATE_REFUSAL_REASONS) {
      expect(REMOTE_CONTROL_ADAPTER_FAILURE_CODES).toContain(reason);
    }
  });

  it('preserves the typed provider-usage error in a failed response', () => {
    const failed: RemoteControlCommandFailedPayload = {
      commandId: 'cmd-usage-limits',
      sequenceNumber: 6,
      error: {
        code: 'unavailable',
        message: 'Cached provider usage is unavailable.',
      },
      response: {
        code: 'unavailable',
        message: 'Cached provider usage is unavailable.',
        retryable: false,
      },
      retryable: false,
      generatedAt: '2026-11-12T00:00:00.000Z',
    };

    expect(JSON.parse(JSON.stringify(failed))).toEqual(failed);
    expect(failed.response).toEqual({
      code: 'unavailable',
      message: 'Cached provider usage is unavailable.',
      retryable: false,
    });
  });

  it('adds the task commands behind their capabilities', () => {
    expect([
      REMOTE_CONTROL_CAPABILITY_WORKTREE_CREATE_FROM,
      REMOTE_CONTROL_CAPABILITY_WORK_ENTRY_COMMANDS,
      REMOTE_CONTROL_CAPABILITY_SIDEBAR_ITEM_GROUP_NAMES,
      REMOTE_CONTROL_CAPABILITY_TASK_REFS,
    ]).toEqual([
      'worktree_create_from_v1',
      'work_entry_commands_v1',
      'sidebar_item_group_names_v1',
      'task_refs_v1',
    ]);
    const commands = [
      'portal.work_entry.update',
      'portal.work_entry.delete',
      'portal.sidebar.item_groups.assign_named',
      'portal.task_refs.list',
    ] as const;
    for (const command of commands) {
      expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(command)).toBe(true);
    }
    expect(
      REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has('portal.work_entry.delete'),
    ).toBe(true);
    expect(
      REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has('portal.work_entry.update'),
    ).toBe(false);
  });

  it('carries create-from, group name and first chat on task creates', () => {
    const firstChat = {
      chatId: 'chat-1',
      userMessageId: 'msg-1',
      text: 'Start here',
      planMode: true,
    };
    const create: RemoteControlCommandPayloadMap['portal.worktree.create'] = {
      workspaceId: 'ws',
      existingBranch: 'feature/x',
      pullRequest: { number: 42, as: 'base' },
      sidebarItemGroupName: { name: 'Sprint', color: 'categorical-2' },
      firstChat,
    };
    const older: RemoteControlCommandPayloadMap['portal.worktree.create'] = {
      workspaceId: 'ws',
      baseWorktreeId: 'wt-1',
    };
    // Older hosts answer with only the legacy fields; `id` stays the worktree id.
    const legacyResult: RemoteControlWorktreeCreateResult = {
      id: 'wt-2',
      branchName: 'feature/x',
      createdAt: '2026-11-04T00:00:00.000Z',
    };
    const result: RemoteControlWorktreeCreateResult = {
      ...legacyResult,
      setupPhase: 'git-pending',
      chat: { chatId: 'chat-1', userMessageId: 'msg-1', delivery: 'queued' },
      groupError: 'The group limit was reached.',
    };
    const chatErrorResult: RemoteControlWorktreeCreateResult = {
      ...legacyResult,
      chatError:
        'The task was created, but its first chat message could not be sent.',
    };
    const cowork: RemoteControlCommandPayloadMap['portal.standalone_chat.create'] =
      {
        projectLocalId: 'p',
        chatId: 'chat-2',
        workEntryId: 'entry-1',
        firstChat,
      };
    const coworkResult: RemoteControlStandaloneChatCreateResult = {
      ok: true,
      chatId: 'chat-2',
      projectLocalId: 'p',
      projectId: 'p',
      worktreeId: 'entry-1',
      workEntryId: 'entry-1',
      chat: { chatId: 'chat-2', userMessageId: 'msg-1', delivery: 'started' },
    };
    const coworkChatErrorResult: RemoteControlStandaloneChatCreateResult = {
      ok: true,
      chatId: 'chat-2',
      projectLocalId: 'p',
      projectId: 'p',
      worktreeId: 'entry-1',
      workEntryId: 'entry-1',
      chatError:
        'The chat was created, but its first message could not be sent.',
    };

    for (const value of [
      create,
      older,
      legacyResult,
      result,
      chatErrorResult,
      cowork,
      coworkResult,
      coworkChatErrorResult,
    ]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
    expect(older.firstChat).toBeUndefined();
  });

  it('pins the Work Entry, named group and task ref payloads', () => {
    const update: RemoteControlCommandPayloadMap['portal.work_entry.update'] = {
      projectLocalId: 'p',
      entryId: 'entry-1',
      title: null,
    };
    const remove: RemoteControlCommandPayloadMap['portal.work_entry.delete'] = {
      projectLocalId: 'p',
      entryId: 'entry-1',
      archive: true,
    };
    const assign: RemoteControlCommandPayloadMap['portal.sidebar.item_groups.assign_named'] =
      {
        scope: { workspaceLocalId: 'ws' },
        itemId: 'wt-1',
        name: 'Sprint',
      };
    const refs: RemoteControlCommandPayloadMap['portal.task_refs.list'] = {
      workspaceId: 'ws',
      kind: 'pr',
      query: 'fix',
      limit: 50,
      offset: 0,
    };
    const page: RemoteControlTaskRefsListResult = {
      items: [
        {
          kind: 'branch',
          name: 'main',
          local: true,
          remote: true,
          isDefault: true,
          checkedOutWorktreeId: 'wt-1',
        },
        {
          kind: 'pr',
          number: 7,
          title: 'Fix',
          headBranch: 'fix',
          baseBranch: 'main',
          draft: false,
        },
      ],
      nextOffset: 50,
    };

    for (const value of [update, remove, assign, refs, page]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });

  it('carries approval and scheduled-send activity on chat summaries', () => {
    const scheduledMessages: RemoteControlChatScheduledMessages = {
      count: 2,
      nextAt: '2026-11-05T09:00:00.000Z',
    };
    const worktreeChat: RemoteControlChatSummaryEntity = {
      localId: 'chat',
      chatId: 'chat',
      scope: 'worktree',
      title: 'Chat',
      awaitingApproval: true,
      scheduledMessages,
    };
    const cleared: RemoteControlChatSummaryEntity = {
      ...worktreeChat,
      awaitingApproval: false,
      scheduledMessages: { count: 0 },
    };
    const coworkChat: RemoteControlStandaloneChatSummary = {
      projectLocalId: 'p',
      projectId: 'p',
      chatId: 'chat',
      title: 'Chat',
      awaitingApproval: false,
      scheduledMessages,
    };
    const snapshotChat: RemoteControlSessionShellState['standaloneChats'][number] =
      {
        localId: 'chat',
        projectLocalId: 'p',
        title: 'Chat',
        scheduledMessages,
      };
    const older: RemoteControlChatSummaryEntity = {
      localId: 'chat',
      chatId: 'chat',
      scope: 'worktree',
      title: 'Chat',
    };

    for (const value of [worktreeChat, cleared, coworkChat, snapshotChat]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
    expect(cleared.scheduledMessages).toEqual({ count: 0 });
    expect(older.awaitingApproval).toBeUndefined();
    expect(older.scheduledMessages).toBeUndefined();
  });

  it('pins the setter command payload shapes on the payload map', () => {
    const setModel: RemoteControlCommandPayloadMap['portal.chat.set_model'] = {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      model: 'claude-sonnet-5',
    };
    const setThinking: RemoteControlCommandPayloadMap['portal.chat.set_thinking_level'] =
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        thinkingLevel: 'high',
      };
    const setPlan: RemoteControlCommandPayloadMap['portal.chat.set_plan_mode'] =
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        planMode: true,
      };
    const setFast: RemoteControlCommandPayloadMap['portal.chat.set_fast_mode'] =
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        fastMode: true,
      };
    // Assign to the explicit interfaces to prove the map aliases match.
    const model: RemoteControlChatSetModelPayload = setModel;
    const thinking: RemoteControlChatSetThinkingLevelPayload = setThinking;
    const plan: RemoteControlChatSetPlanModePayload = setPlan;
    const fast: RemoteControlChatSetFastModePayload = setFast;
    expect(model.model).toBe('claude-sonnet-5');
    expect(thinking.thinkingLevel).toBe('high');
    expect(plan.planMode).toBe(true);
    expect(fast.fastMode).toBe(true);
  });

  it('exposes the CAN-1219 plugins + standalone-model commands', () => {
    const commands = [
      'portal.chat.set_plugin_selections',
      'portal.chat.list_plugin_catalog',
      'portal.standalone_chat.set_model',
    ] as const;
    for (const command of commands) {
      expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(command);
      expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(command)).toBe(true);
    }
  });

  it('pins the CAN-1219 plugins + standalone-model payload shapes', () => {
    const setPlugins: RemoteControlCommandPayloadMap['portal.chat.set_plugin_selections'] =
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        selections: {
          collectionIds: ['c1'],
          skillRefs: [{ sourceId: 'src', skillName: 'skill' }],
          pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'plugin' }],
          mcpServerRefs: [{ serverId: 'srv', configId: 'cfg' }],
        },
      };
    const listCatalog: RemoteControlCommandPayloadMap['portal.chat.list_plugin_catalog'] =
      {
        projectId: 'ws',
        worktreeId: 'wt',
        providerType: 'claude',
      };
    const setStandaloneModel: RemoteControlCommandPayloadMap['portal.standalone_chat.set_model'] =
      {
        chatId: 'chat',
        model: 'claude-opus-4-8',
      };
    // Assign to the explicit interfaces to prove the map aliases match.
    const plugins: RemoteControlChatSetPluginSelectionsPayload = setPlugins;
    const catalog: RemoteControlChatListPluginCatalogPayload = listCatalog;
    const standaloneModel: RemoteControlStandaloneChatSetModelPayload =
      setStandaloneModel;
    expect(plugins.selections.collectionIds).toEqual(['c1']);
    expect(catalog.providerType).toBe('claude');
    expect(standaloneModel.model).toBe('claude-opus-4-8');
  });

  it('shapes the plugin catalog result and standalone model summary', () => {
    const catalog: RemoteControlPluginCatalog = {
      collections: [
        {
          id: 'c1',
          name: 'Collection',
          description: 'desc',
          skillCount: 1,
          pluginCount: 2,
          mcpServerCount: 0,
        },
      ],
      skills: [
        {
          sourceId: 'src',
          skillName: 'skill',
          name: 'Skill',
          description: 'desc',
          source: 'Built-in',
          builtIn: true,
        },
      ],
      plugins: [
        {
          marketplaceId: 'mkt',
          pluginName: 'plugin',
          name: 'Plugin',
          description: 'desc',
          marketplaceName: 'Marketplace',
          claudeSupported: true,
          codexSupported: false,
        },
      ],
      mcpServers: [
        {
          serverId: 'srv',
          configId: 'cfg',
          serverName: 'Server',
          configName: 'Config',
          description: 'desc',
          transport: 'http',
        },
      ],
    };
    const summary: RemoteControlStandaloneChatSummary = {
      projectLocalId: 'p',
      projectId: 'p',
      chatId: 'chat',
      title: 'Chat',
      model: 'claude-opus-4-8',
      availableModels: [
        {
          id: 'claude-opus-4-8',
          label: 'Opus',
          provider: 'claude',
          kind: 'model',
          available: true,
        },
      ],
      providerAvailability: { claude: true },
    };
    expect(catalog.plugins[0]?.codexSupported).toBe(false);
    expect(summary.availableModels?.[0]?.id).toBe('claude-opus-4-8');
    expect(summary.model).toBe('claude-opus-4-8');
  });

  it('carries additive Work Entry grouping facts on standalone chats and workspaces', (): void => {
    const facts: RemoteControlStandaloneWorkEntryFields = {
      workEntryId: 'entry-1',
      workEntryTitle: 'Research',
      workEntryCreatedAt: '2026-09-01T00:00:00.000Z',
      workEntryLastMessageAt: '2026-09-02T00:00:00.000Z',
      workEntryLastTouchedAt: '2026-09-03T00:00:00.000Z',
      workEntryOrder: 2,
      workEntryPinned: true,
      workEntryStatus: 'done',
    };
    const summary: RemoteControlStandaloneChatSummary = {
      projectLocalId: 'p',
      projectId: 'p',
      chatId: 'chat',
      title: 'Chat',
      ...facts,
    };
    const snapshotChat: RemoteControlSessionShellState['standaloneChats'][number] =
      {
        localId: 'chat',
        projectLocalId: 'p',
        title: 'Chat',
        ...facts,
      };
    const workspace: RemoteControlSessionShellState['workspaces'][number] = {
      localId: 'p',
      name: 'Project',
      type: 'cowork',
      itemSortMode: 'manual',
    };
    // Every fact is optional: an older desktop build's chat still type-checks.
    const legacyChat: RemoteControlSessionShellState['standaloneChats'][number] =
      {
        localId: 'chat',
        projectLocalId: 'p',
        title: 'Chat',
      };
    expect(summary.workEntryOrder).toBe(2);
    expect(snapshotChat.workEntryStatus).toBe('done');
    expect(JSON.parse(JSON.stringify(snapshotChat))).toEqual(snapshotChat);
    expect(workspace.itemSortMode).toBe('manual');
    expect(legacyChat.workEntryPinned).toBeUndefined();
  });

  it('carries additive thinking/fast fields on the standalone send payload', () => {
    const payload: RemoteControlStandaloneChatSendPayload = {
      chatId: 'chat',
      message: 'hi',
      thinkingLevel: 'medium',
      modelConfig: { thinkingLevel: 'medium', fastMode: true },
      inputMode: 'voice',
    };
    expect(payload.modelConfig?.fastMode).toBe(true);
    expect(payload.thinkingLevel).toBe('medium');
    expect(payload.inputMode).toBe('voice');
  });

  it('carries the exact Codex speed beside its legacy boolean projection', () => {
    const payload: RemoteControlStandaloneChatSendPayload = {
      chatId: 'chat',
      message: 'hi',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'ultrafast',
        fastMode: false,
      },
    };
    const summary: RemoteControlChatSummaryEntity = {
      localId: 'chat',
      chatId: 'chat',
      scope: 'worktree',
      title: 'Chat',
      fastMode: false,
      speed: 'ultrafast',
    };
    expect(payload.modelConfig?.speed).toBe('ultrafast');
    expect(payload.modelConfig?.fastMode).toBe(false);
    expect(summary.speed).toBe('ultrafast');
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('projects composer state onto the chat summary entity', () => {
    const pluginSelections: RemoteControlChatSummaryPluginSelections = {
      collectionIds: ['c1'],
      skillCount: 2,
      pluginCount: 1,
      mcpServerCount: 0,
    };
    const providerAvailability: RemoteControlChatProviderAvailability = {
      claude: true,
      codex: false,
      ollama: true,
    };
    const summary: RemoteControlChatSummaryEntity = {
      localId: 'chat',
      chatId: 'chat',
      scope: 'worktree',
      title: 'Chat',
      turnActive: true,
      turnElapsedMs: 550_000,
      planMode: true,
      thinkingLevel: 'xhigh',
      fastMode: false,
      model: 'claude-opus-4-8',
      pluginSelections,
      providerAvailability,
    };
    expect(summary.planMode).toBe(true);
    expect(summary.turnElapsedMs).toBe(550_000);
    expect(summary.thinkingLevel).toBe('xhigh');
    expect(summary.model).toBe('claude-opus-4-8');
    expect(summary.pluginSelections?.skillCount).toBe(2);
    expect(summary.providerAvailability?.claude).toBe(true);
  });

  it('exposes the interactive AskUserQuestion answer/dismiss commands', () => {
    const commands = [
      'portal.chat.answer_question',
      'portal.chat.dismiss_question',
    ] as const;
    for (const command of commands) {
      expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(command);
      expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(command)).toBe(true);
    }
  });

  it('pins the answer/dismiss question payload shapes on the payload map', () => {
    const answer: RemoteControlCommandPayloadMap['portal.chat.answer_question'] =
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        requestId: 'req-1',
        answers: [
          {
            questionId: 'q1',
            question: 'Pick a color',
            selectedOptions: ['Blue'],
            freeformText: 'Actually teal',
          },
        ],
      };
    const dismiss: RemoteControlCommandPayloadMap['portal.chat.dismiss_question'] =
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        requestId: 'req-1',
      };
    // Assign to the explicit interfaces to prove the map aliases match.
    const answerPayload: RemoteControlChatAnswerQuestionPayload = answer;
    const dismissPayload: RemoteControlChatDismissQuestionPayload = dismiss;
    expect(answerPayload.requestId).toBe('req-1');
    expect(answerPayload.answers[0]?.selectedOptions).toEqual(['Blue']);
    expect(answerPayload.answers[0]?.freeformText).toBe('Actually teal');
    expect(dismissPayload.requestId).toBe('req-1');
    // Routing reuses the desktop names via RemoteControlChatSetterTarget.
    expect(dismissPayload.projectId).toBe('ws');
    expect(dismissPayload.worktreeId).toBe('wt');
    expect(dismissPayload.chatId).toBe('chat');
  });

  it('projects awaiting and answered question state on the chat summary entity', () => {
    const question: RemoteControlAskUserQuestion = {
      id: 'q1',
      header: 'Deployment',
      question: 'Which environment?',
      options: ['staging', 'production'],
      multiSelect: false,
      optionDescriptions: ['Safe sandbox', 'Live traffic'],
      allowOther: true,
      secret: false,
    };
    const secretQuestion: RemoteControlAskUserQuestion = {
      question: 'Provide the token',
      options: [],
      secret: true,
    };
    const answers: RemoteControlAskUserQuestionAnswer[] = [
      {
        questionId: 'q1',
        question: 'Which environment?',
        selectedOptions: ['production'],
        freeformText: 'us-east-1',
      },
    ];
    const awaiting: RemoteControlAskUserQuestionState = {
      requestId: 'req-awaiting',
      toolUseId: 'codex-call-1',
      questions: [question, secretQuestion],
      answered: false,
    };
    const answered: RemoteControlAskUserQuestionState = {
      requestId: 'req-answered',
      questions: [question],
      answered: true,
      answers,
    };
    const summary: RemoteControlChatSummaryEntity = {
      localId: 'chat',
      chatId: 'chat',
      scope: 'worktree',
      title: 'Chat',
      pendingQuestions: [awaiting, answered],
    };
    // Full question metadata survives the projection.
    expect(summary.pendingQuestions?.[0]?.questions[0]?.allowOther).toBe(true);
    expect(
      summary.pendingQuestions?.[0]?.questions[0]?.optionDescriptions,
    ).toEqual(['Safe sandbox', 'Live traffic']);
    expect(summary.pendingQuestions?.[0]?.questions[1]?.secret).toBe(true);
    // Awaiting vs answered lifecycle.
    expect(summary.pendingQuestions?.[0]?.answered).toBe(false);
    expect(summary.pendingQuestions?.[0]?.answers).toBeUndefined();
    expect(summary.pendingQuestions?.[0]?.toolUseId).toBe('codex-call-1');
    expect(summary.pendingQuestions?.[1]?.answered).toBe(true);
    expect(
      summary.pendingQuestions?.[1]?.answers?.[0]?.selectedOptions,
    ).toEqual(['production']);
    expect(summary.pendingQuestions?.[1]?.answers?.[0]?.freeformText).toBe(
      'us-east-1',
    );

    // `[]` explicitly clears cached question state; omission is also valid
    // (older producer / partial projection) and preserves prior state.
    const cleared: RemoteControlChatSummaryEntity = {
      localId: 'chat',
      chatId: 'chat',
      scope: 'worktree',
      title: 'Chat',
      pendingQuestions: [],
    };
    expect(cleared.pendingQuestions).toEqual([]);
    const omitted: RemoteControlChatSummaryEntity = {
      localId: 'chat',
      chatId: 'chat',
      scope: 'worktree',
      title: 'Chat',
    };
    expect(omitted.pendingQuestions).toBeUndefined();
  });

  it('pins portal target keys', () => {
    expect(REMOTE_CONTROL_TARGET_KEYS).toContain('workspaceLocalId');
    expect(REMOTE_CONTROL_TARGET_KEYS).toContain('worktreeLocalId');
    expect(REMOTE_CONTROL_TARGET_KEYS).toContain('filePath');
  });

  // CAN-2562 opened an explicit, reviewed App Advisor surface over the
  // Canopy Portal wire protocol: a REMOTE VIEW of the paired desktop's App
  // Advisor session. Only the allow-listed types below may reference App
  // Advisor — any other leakage (e.g. reusing App Advisor sentinel routing
  // inside another family) is still a regression. Growing the allow-list
  // must remain an explicit, reviewed change.
  it('limits App Advisor exposure to reviewed chat and grouping entities', () => {
    const allowedAppAdvisorTypes = new Set<string>([
      'portal.app_advisor.send',
      'portal.app_advisor.cancel',
      'portal.app_advisor.set_model',
      'portal.app_advisor.create_tab',
      'portal.app_advisor.close_tab',
      'portal.app_advisor.answer_question',
      'portal.app_advisor.dismiss_question',
      'portal.app_advisor.settings.get',
      'portal.app_advisor.settings.save',
      'portal.app_advisor.event',
      'app_advisor_chat',
      'app_advisor_item_groups',
    ]);
    const remoteControlSurface = [
      ...REMOTE_CONTROL_COMMAND_TYPES,
      ...REMOTE_CONTROL_EVENT_TYPES,
      ...REMOTE_CONTROL_ENTITY_TYPES,
    ];
    const blockedSubstrings = ['app_advisor', 'app-advisor', 'appAdvisor'];
    for (const entry of remoteControlSurface) {
      if (allowedAppAdvisorTypes.has(entry)) continue;
      for (const needle of blockedSubstrings) {
        expect(entry).not.toContain(needle);
      }
    }
    // Every allow-listed type must actually exist on the wire surface, so
    // stale entries cannot silently widen the allowance.
    for (const allowed of allowedAppAdvisorTypes) {
      expect(remoteControlSurface).toContain(allowed);
    }
  });

  it('exposes the CAN-2562 App Advisor command family', () => {
    const commands = [
      'portal.app_advisor.send',
      'portal.app_advisor.cancel',
      'portal.app_advisor.set_model',
      'portal.app_advisor.create_tab',
      'portal.app_advisor.close_tab',
      'portal.app_advisor.answer_question',
      'portal.app_advisor.dismiss_question',
      'portal.app_advisor.settings.get',
      'portal.app_advisor.settings.save',
    ] as const;
    for (const command of commands) {
      expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(command);
      expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(command)).toBe(true);
      // Relayed chat commands are not destructive operations.
      expect(REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    }
    expect(REMOTE_CONTROL_EVENT_TYPES).toContain('portal.app_advisor.event');
    expect(REMOTE_CONTROL_ENTITY_TYPES).toContain('app_advisor_chat');
    expect(REMOTE_CONTROL_CAPABILITY_APP_ADVISOR).toBe('app_advisor');
    expect(REMOTE_CONTROL_CAPABILITY_WORKTREE_RETENTION).toBe(
      'worktree_retention',
    );
  });

  it('pins the App Advisor payload shapes on the payload map', () => {
    const send: RemoteControlCommandPayloadMap['portal.app_advisor.send'] = {
      chatId: 'advisor-chat',
      text: 'open the pipelines page',
      model: 'claude-sonnet-5',
      modelConfig: { thinkingLevel: 'medium' },
      inputMode: 'typed',
    };
    const cancel: RemoteControlCommandPayloadMap['portal.app_advisor.cancel'] =
      {
        chatId: 'advisor-chat',
      };
    const setModel: RemoteControlCommandPayloadMap['portal.app_advisor.set_model'] =
      {
        chatId: 'advisor-chat',
        model: 'gpt-5.6-sol',
      };
    const answer: RemoteControlCommandPayloadMap['portal.app_advisor.answer_question'] =
      {
        chatId: 'advisor-chat',
        requestId: 'req-1',
        answers: [
          {
            questionId: 'q1',
            question: 'Which worktree?',
            selectedOptions: ['iguana'],
          },
        ],
      };
    const dismiss: RemoteControlCommandPayloadMap['portal.app_advisor.dismiss_question'] =
      {
        chatId: 'advisor-chat',
        requestId: 'req-1',
      };
    // Assign to the explicit interfaces to prove the map aliases match.
    const sendPayload: RemoteControlAppAdvisorSendPayload = send;
    const cancelPayload: RemoteControlAppAdvisorCancelPayload = cancel;
    const setModelPayload: RemoteControlAppAdvisorSetModelPayload = setModel;
    const answerPayload: RemoteControlAppAdvisorAnswerQuestionPayload = answer;
    const dismissPayload: RemoteControlAppAdvisorDismissQuestionPayload =
      dismiss;
    expect(sendPayload.text).toBe('open the pipelines page');
    expect(cancelPayload.chatId).toBe('advisor-chat');
    expect(setModelPayload.model).toBe('gpt-5.6-sol');
    expect(answerPayload.answers[0]?.selectedOptions).toEqual(['iguana']);
    expect(dismissPayload.requestId).toBe('req-1');
    // The family deliberately carries no projectId/worktreeId routing.
    expect('projectId' in send).toBe(false);
    expect('worktreeId' in send).toBe(false);
  });

  it('shapes the App Advisor event payload and chat summary projection', () => {
    const event: RemoteControlAppAdvisorChatEventPayload = {
      chatId: 'advisor-chat',
      message: {
        messageId: 'm1',
        chatId: 'advisor-chat',
        role: 'assistant',
        status: 'streaming',
        text: 'Opening the pipelines page…',
        createdAtMs: 1,
      },
    };
    const summary: RemoteControlAppAdvisorChatSummary = {
      localId: 'advisor-chat',
      chatId: 'advisor-chat',
      title: 'App Advisor',
      pendingQuestions: [
        {
          requestId: 'req-1',
          questions: [{ question: 'Which worktree?', options: ['iguana'] }],
          answered: false,
        },
      ],
    };
    expect(event.message.status).toBe('streaming');
    expect(summary.pendingQuestions?.[0]?.answered).toBe(false);
  });

  it('exposes the portal Plugins-section and workspace-items browse commands', (): void => {
    const commands = [
      'portal.workspace_items.list_notes',
      'portal.workspace_items.read_note',
      'portal.workspace_items.list_prompts',
      'portal.workspace_items.read_prompt',
      'portal.workspace_items.list_attachments',
      'portal.plugins.list_marketplaces',
      'portal.plugins.get_plugin_detail',
      'portal.plugins.read_component_content',
      'portal.skills.list',
      'portal.skills.read',
      'portal.mcp.list_servers',
      'portal.mcp.get_server',
      'portal.collections.list',
      'portal.collections.get',
    ] as const;
    for (const command of commands) {
      expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(command);
      expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(command)).toBe(true);
      // Read-only browsing is never a destructive operation.
      expect(REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    }
  });

  it('announces the strict sidebar Activity inventory behind its own capability', () => {
    expect(REMOTE_CONTROL_CAPABILITY_SIDEBAR_ACTIVITY_INVENTORY).toBe(
      'sidebar_activity_inventory',
    );
  });

  it('announces the invocable inventory commands behind one capability', () => {
    expect(REMOTE_CONTROL_CAPABILITY_INVOCABLE_INVENTORY).toBe(
      'invocable_inventory',
    );
    for (const command of [
      'portal.editor.list_invocables',
      'portal.editor.resolve_invocable',
      'portal.standalone_chat.set_plugin_selections',
    ] as const) {
      expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(command)).toBe(true);
      expect(REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    }
    // Payloads name chats by opaque ids only; the host owns paths, enable
    // refs and insert text.
    const list: RemoteControlCommandPayloadMap['portal.editor.list_invocables'] =
      {
        target: {
          kind: 'standalone',
          projectLocalId: 'cowork-default',
          chatId: 'chat-1',
        },
      };
    const resolve: RemoteControlCommandPayloadMap['portal.editor.resolve_invocable'] =
      {
        target: {
          kind: 'worktree',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-2',
        },
        entryId: 'entry-1',
        providerType: 'codex',
      };
    const select: RemoteControlCommandPayloadMap['portal.standalone_chat.set_plugin_selections'] =
      {
        projectLocalId: 'cowork-default',
        chatId: 'chat-1',
        selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      };
    expect(JSON.parse(JSON.stringify({ list, resolve, select }))).toEqual({
      list,
      resolve,
      select,
    });
  });

  it('keeps the catalog read budgets', () => {
    for (const type of [
      'portal.editor.list_slash_commands',
      'portal.editor.list_file_mentions',
      'portal.chat.list_plugin_catalog',
      'portal.workspace.claude_md.get',
      'portal.workspace.scripts.get',
      'portal.workspace.update',
      'portal.state.request',
    ] as const) {
      expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(type);
    }
    expect(REMOTE_CONTROL_CATALOG_CONTENT_MAX_BYTES).toBe(256 * 1024);
    // The whole-result budget must leave real headroom under the ~1 MiB
    // portal event cap while still fitting a full 256 KB body.
    expect(REMOTE_CONTROL_CATALOG_RESULT_MAX_BYTES).toBe(700 * 1024);
    expect(REMOTE_CONTROL_CATALOG_RESULT_MAX_BYTES).toBeGreaterThan(
      REMOTE_CONTROL_CATALOG_CONTENT_MAX_BYTES,
    );
  });

  it('pins the Plugins-section browse payload shapes on the payload map', () => {
    const listMarketplaces: RemoteControlCommandPayloadMap['portal.plugins.list_marketplaces'] =
      { projectId: 'ws' };
    const getDetail: RemoteControlCommandPayloadMap['portal.plugins.get_plugin_detail'] =
      { projectId: 'ws', marketplaceId: 'mkt', pluginName: 'plugin' };
    const readComponent: RemoteControlCommandPayloadMap['portal.plugins.read_component_content'] =
      {
        projectId: 'ws',
        marketplaceId: 'mkt',
        pluginName: 'plugin',
        componentType: 'skill',
        componentFile: 'skills/review/SKILL.md',
      };
    const listSkills: RemoteControlCommandPayloadMap['portal.skills.list'] = {
      projectId: 'ws',
    };
    const readSkill: RemoteControlCommandPayloadMap['portal.skills.read'] = {
      projectId: 'ws',
      sourceId: 'src',
      skillName: 'review',
    };
    const listServers: RemoteControlCommandPayloadMap['portal.mcp.list_servers'] =
      {
        projectId: 'ws',
      };
    const getServer: RemoteControlCommandPayloadMap['portal.mcp.get_server'] = {
      projectId: 'ws',
      serverId: 'abc-123',
    };
    const listCollections: RemoteControlCommandPayloadMap['portal.collections.list'] =
      { projectId: 'ws' };
    const getCollection: RemoteControlCommandPayloadMap['portal.collections.get'] =
      {
        projectId: 'ws',
        collectionId: 'abc-123',
      };
    expect(listMarketplaces.projectId).toBe('ws');
    expect(getDetail.pluginName).toBe('plugin');
    expect(readComponent.componentFile).toBe('skills/review/SKILL.md');
    expect(listSkills.projectId).toBe('ws');
    expect(readSkill.skillName).toBe('review');
    expect(listServers.projectId).toBe('ws');
    expect(getServer.serverId).toBe('abc-123');
    expect(listCollections.projectId).toBe('ws');
    expect(getCollection.collectionId).toBe('abc-123');
  });

  it('saves a collection through one command behind its own capability', () => {
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain('portal.collections.save');
    expect(
      REMOTE_CONTROL_COMMAND_TYPES_SET.has('portal.collections.save'),
    ).toBe(true);
    expect(REMOTE_CONTROL_CAPABILITY_COLLECTION_MUTATIONS).toBe(
      'collection_mutations_v1',
    );
    const save: RemoteControlCommandPayloadMap['portal.collections.save'] = {
      projectId: 'ws',
      collection: {
        id: 'abc-123',
        name: 'Launch kit',
        description: '',
        skills: [{ sourceId: 'github:acme/skills', skillName: 'review' }],
        plugins: [{ marketplaceId: 'mkt', pluginName: 'linter' }],
        mcpServers: [],
      },
    };
    const result: RemoteControlCollectionsSaveResult = {
      collection: {
        ...save.collection,
        id: 'abc-123',
        createdAt: '2026-10-14T00:00:00.000Z',
        updatedAt: '2026-10-14T00:00:00.000Z',
      },
    };
    expect(save.collection.name).toBe('Launch kit');
    expect(result.collection.id).toBe('abc-123');
  });

  it('exposes the portal Plugins-section mutation command family', () => {
    const commands = [
      'portal.plugins.install_builtin',
      'portal.plugins.install_external',
      'portal.marketplace.add',
      'portal.marketplace.update',
      'portal.marketplace.remove',
      'portal.marketplace.refresh_all',
      'portal.mcp.set_config_enabled',
    ] as const;
    for (const command of commands) {
      expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(command);
      expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(command)).toBe(true);
      // Every mutation is reversible (re-install, re-add, re-enable), so the
      // browser confirmation dialog — not the destructive kill switch — is
      // the guard, matching portal.workspace.delete.
      expect(REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    }
    // There is deliberately NO per-plugin uninstall command: the desktop
    // product models removal as provider-scoped marketplace removal, so the
    // portal does too.
    expect(
      REMOTE_CONTROL_COMMAND_TYPES_SET.has('portal.plugins.uninstall_builtin'),
    ).toBe(false);
  });

  it('announces the plugin-mutations capability under its stable name', () => {
    expect(REMOTE_CONTROL_CAPABILITY_PLUGIN_MUTATIONS).toBe('plugin_mutations');
  });

  it('pins the Plugins-section mutation payload shapes on the payload map', () => {
    const installBuiltin: RemoteControlCommandPayloadMap['portal.plugins.install_builtin'] =
      {
        projectId: 'ws',
        marketplaceId: 'builtin/app',
        pluginName: 'plugin',
        providers: ['claude', 'codex'],
      };
    const installExternal: RemoteControlCommandPayloadMap['portal.plugins.install_external'] =
      { projectId: 'ws', marketplaceId: 'mkt', pluginName: 'plugin' };
    const add: RemoteControlCommandPayloadMap['portal.marketplace.add'] = {
      projectId: 'ws',
      repo: 'acme/marketplace',
    };
    const update: RemoteControlCommandPayloadMap['portal.marketplace.update'] =
      {
        projectId: 'ws',
        marketplaceId: 'mkt',
      };
    const remove: RemoteControlCommandPayloadMap['portal.marketplace.remove'] =
      {
        projectId: 'ws',
        marketplaceId: 'mkt',
        providers: ['codex'],
      };
    const refreshAll: RemoteControlCommandPayloadMap['portal.marketplace.refresh_all'] =
      { projectId: 'ws' };
    const toggle: RemoteControlCommandPayloadMap['portal.mcp.set_config_enabled'] =
      {
        projectId: 'ws',
        serverId: 'abc-123',
        configId: 'cfg-1',
        enabled: false,
      };
    expect(installBuiltin.providers).toEqual(['claude', 'codex']);
    expect(installExternal.pluginName).toBe('plugin');
    expect(add.repo).toBe('acme/marketplace');
    expect(update.marketplaceId).toBe('mkt');
    expect(remove.providers).toEqual(['codex']);
    expect(refreshAll.projectId).toBe('ws');
    expect(toggle.enabled).toBe(false);
  });

  it('shapes the Plugins-section browse results without secrets or paths', () => {
    const marketplace: RemoteControlMarketplaceRow = {
      id: 'mkt',
      name: 'Marketplace',
      description: 'desc',
      sourceType: 'github',
      sourceUrl: 'acme/marketplace',
      pluginCount: 1,
      validProviders: ['claude'],
      providerStatus: {
        claude: {
          provider: 'claude',
          state: 'valid',
          accepted: true,
          pluginCount: 1,
          lastCheckedAt: '2026-08-27T00:00:00.000Z',
        },
        codex: {
          provider: 'codex',
          state: 'invalid',
          accepted: false,
          pluginCount: 0,
          lastCheckedAt: '2026-08-27T00:00:00.000Z',
          error: 'not supported',
        },
      },
      plugins: [
        {
          name: 'plugin',
          description: 'desc',
          version: '1.0.0',
          marketplaceId: 'mkt',
          providerSupport: { claude: 'native', codex: 'none' },
          installed: true,
        },
      ],
    };
    const listResult: RemoteControlPluginsListMarketplacesResult = {
      marketplaces: [marketplace],
      lastRefreshed: '2026-08-27T00:00:00.000Z',
    };
    const detail: RemoteControlPluginDetailResult = {
      marketplaceId: 'mkt',
      marketplaceName: 'Marketplace',
      plugin: marketplace.plugins[0],
      details: {
        skills: [{ name: 's', description: 'd', path: 'skills/s/SKILL.md' }],
        agents: [],
        commands: [],
        hooks: [],
        mcpServers: [],
        lspServers: [],
        hasReadme: true,
      },
      readme: { body: '# Plugin', truncated: false },
    };
    const content: RemoteControlCatalogMarkdownContent = {
      frontmatter: { description: 'd' },
      body: 'content',
      truncated: false,
    };
    const skills: RemoteControlSkillsListResult = {
      skills: [
        {
          name: 'review',
          sourceId: 'src',
          description: 'd',
          source: 'GitHub',
          installedAt: '2026-08-27T00:00:00.000Z',
          updatedAt: '2026-08-27T00:00:00.000Z',
          updateAvailable: false,
          builtIn: false,
          custom: false,
        },
      ],
    };
    const servers: RemoteControlMcpListServersResult = {
      servers: [
        {
          id: 'abc',
          name: 'GitHub',
          description: 'd',
          type: 'http',
          configs: [{ id: 'cfg', name: 'Default', enabled: true }],
          updatedAt: '2026-08-27T00:00:00.000Z',
        },
      ],
    };
    const serverDetail: RemoteControlMcpGetServerResult = {
      server: {
        id: 'abc',
        name: 'GitHub',
        description: 'd',
        type: 'http',
        // Sanitized: scheme + host + port + path only (no userinfo/query/
        // fragment), per the RemoteControlMcpServerDetail contract.
        url: 'https://example.com/mcp',
        argCount: 2,
        headerNames: ['X-Custom'],
        oauth: { hasClientId: true, hasClientSecret: false },
        // Explicit sanitized projection — never the stored object wholesale.
        curated: {
          key: 'github',
          logoUrl: 'https://cdn.example/logo.png',
          authorName: 'Acme',
        },
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
        configs: [
          {
            id: 'cfg',
            name: 'Default',
            description: '',
            enabled: true,
            envVarNames: ['GITHUB_TOKEN'],
            extraArgCount: 3,
            extraHeaderNames: [],
            hasAuthToken: true,
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:00:00.000Z',
          },
        ],
      },
    };
    const collections: RemoteControlCollectionsListResult = {
      collections: [
        {
          id: 'abc',
          name: 'Team pack',
          description: 'd',
          updatedAt: '2026-08-27T00:00:00.000Z',
          skillCount: 1,
          pluginCount: 0,
          mcpServerCount: 0,
        },
      ],
    };
    const collection: RemoteControlCollectionsGetResult = {
      collection: {
        id: 'abc',
        name: 'Team pack',
        description: 'd',
        skills: [{ sourceId: 'src', skillName: 'review' }],
        plugins: [],
        mcpServers: [],
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      },
    };
    expect(listResult.marketplaces[0]?.plugins[0]?.installed).toBe(true);
    expect(detail.readme?.truncated).toBe(false);
    expect(content.truncated).toBe(false);
    expect(skills.skills[0]?.updateAvailable).toBe(false);
    expect(servers.servers[0]?.configs[0]?.enabled).toBe(true);
    // Redaction contract: the detail carries presence flags and NAMES only.
    expect(serverDetail.server.configs[0]?.hasAuthToken).toBe(true);
    expect(serverDetail.server.configs[0]?.envVarNames).toEqual([
      'GITHUB_TOKEN',
    ]);
    expect('authToken' in (serverDetail.server.configs[0] ?? {})).toBe(false);
    expect('envVars' in (serverDetail.server.configs[0] ?? {})).toBe(false);
    // Argument vectors collapse to counts — raw values can carry secrets.
    expect(serverDetail.server.argCount).toBe(2);
    expect(serverDetail.server.configs[0]?.extraArgCount).toBe(3);
    expect('args' in serverDetail.server).toBe(false);
    expect('extraArgs' in (serverDetail.server.configs[0] ?? {})).toBe(false);
    expect(collections.collections[0]?.skillCount).toBe(1);
    expect(collection.collection.skills[0]?.skillName).toBe('review');
  });
});

it('keeps account MCP catalog metadata optional and serializable', () => {
  const metadata: RemoteControlMcpConnectionMetadata = {
    connectionState: 'connected',
    connectionId: 'connection-id',
    authMode: 'NONE',
    enabledTools: [],
    connectionRequiresAuth: false,
  };
  expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
  const legacy: RemoteControlMcpConnectionMetadata = {};
  expect(legacy.connectionState).toBeUndefined();
});

describe('pipeline run chat links (CAN-3619)', () => {
  it('exports the negotiated capability key', () => {
    expect(Object.values(remoteControlContract)).toContain(
      'pipeline_run_chat_links',
    );
    expect(REMOTE_CONTROL_CAPABILITY_PIPELINE_RUN_CHAT_LINKS).toBe(
      'pipeline_run_chat_links',
    );
  });

  it('round-trips additive chat turn links on a pipeline_run payload', () => {
    const run: RemoteControlPipelineRun = {
      localId: 'exec-1',
      pipelineId: 'pipe-1',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      status: 'running',
      chatTurns: [
        { chatId: 'chat-1', userMessageId: 'user-1', relation: 'launched' },
        { chatId: 'chat-2', userMessageId: 'user-9', relation: 'watching' },
      ],
    };
    expect(JSON.parse(JSON.stringify(run))).toEqual(run);
  });
});

describe('pipeline chat follow-up (CAN-3719)', () => {
  it('pins the capability key and the prepare command', () => {
    expect(REMOTE_CONTROL_CAPABILITY_PIPELINE_CHAT_FOLLOW_UP).toBe(
      'pipeline_chat_follow_up',
    );
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(
      'portal.pipeline.chat_follow_up.prepare',
    );
  });

  it('round-trips path-free availability and the prepare shapes', () => {
    const run: RemoteControlPipelineRun = {
      localId: 'exec-1',
      pipelineId: 'pipe-1',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      status: 'failed',
      chatFollowUp: { planAvailable: false, reportAvailable: true },
    };
    const payload: RemoteControlCommandPayloadMap['portal.pipeline.chat_follow_up.prepare'] =
      {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        executionId: 'exec-1',
        output: 'report',
      };
    const result: RemoteControlPipelineChatFollowUpPrepareResult = {
      ...payload,
      prompt: 'Review this report: /exec/report.md',
      chatId: 'chat-1',
    };
    for (const value of [run, payload, result]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });
});

describe('pipeline content reads (CAN-3717)', () => {
  it('pins the capability key and the read command', () => {
    expect(REMOTE_CONTROL_CAPABILITY_PIPELINE_CONTENT).toBe('pipeline_content');
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(
      'portal.pipeline.content.read',
    );
  });

  it('keeps a fully escaped page under the result cap', () => {
    expect(REMOTE_CONTROL_PIPELINE_CONTENT_PAGE_MAX_CHARS * 6).toBeLessThan(
      REMOTE_CONTROL_CATALOG_RESULT_MAX_BYTES,
    );
  });

  it('round-trips path-free read shapes', () => {
    const payload: RemoteControlCommandPayloadMap['portal.pipeline.content.read'] =
      {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        executionId: 'exec-1',
        source: { kind: 'step_output', jobId: 'build', stepId: 'agent' },
        offset: 10,
        revision: 'r1',
      };
    const result: RemoteControlPipelineContentReadResult = {
      format: 'markdown',
      content: '## Done',
      offset: 10,
      nextOffset: 17,
      length: 17,
      revision: 'r1',
    };
    for (const value of [payload, result]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });
});

describe('Claude Mod surface relay', () => {
  it('pins the capability key, the command and the event type', () => {
    expect(REMOTE_CONTROL_CAPABILITY_CLAUDE_MOD_SURFACE).toBe(
      'claude_mod_surface_v1',
    );
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(
      'portal.claude_mods.surface_command',
    );
    expect(
      REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has(
        'portal.claude_mods.surface_command',
      ),
    ).toBe(false);
    expect(REMOTE_CONTROL_EVENT_TYPES).toContain('portal.claude_mods.surface');
  });
});

describe('Claude Mod admission controls', () => {
  const digest = `sha256:${'a'.repeat(64)}`;

  it('pins the capability key and both commands', () => {
    expect(REMOTE_CONTROL_CAPABILITY_CLAUDE_MOD_ADMISSION).toBe(
      'claude_mod_admission_v1',
    );
    for (const command of [
      'portal.claude_mods.get',
      'portal.claude_mods.update',
    ] as const) {
      expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(command);
      expect(REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    }
  });

  it('parses get and update payloads and refuses malformed ones', () => {
    const get: RemoteControlCommandPayloadMap['portal.claude_mods.get'] = {
      pluginId: 'review@builtin/app',
    };
    expect(parseClaudeModsGetArgs(get)).toEqual(get);
    expect(parseClaudeModsGetArgs({})).toEqual({});
    expect(parseClaudeModsGetArgs({ pluginId: '../x@y' })).toBeNull();

    const allow: RemoteControlCommandPayloadMap['portal.claude_mods.update'] = {
      action: 'allow',
      pluginId: 'review@market',
      contentDigest: digest,
    };
    expect(parseClaudeModsUpdate(allow)).toEqual(allow);
    expect(
      parseClaudeModsUpdate({
        action: 'set-mods-disabled',
        modsDisabled: true,
      }),
    ).toEqual({ action: 'set-mods-disabled', modsDisabled: true });
    for (const malformed of [
      { action: 'allow', pluginId: 'review@market' },
      { action: 'allow', pluginId: 'review@market', contentDigest: 'sha1:x' },
      { action: 'disallow', pluginId: 'review' },
      { action: 'set-mods-disabled', modsDisabled: 'yes' },
      { action: 'forget', pluginId: 'review@market' },
    ]) {
      expect(parseClaudeModsUpdate(malformed)).toBeNull();
    }
  });

  it('round-trips state and typed update results', () => {
    const state = {
      enabled: true,
      modsDisabled: false,
      authorityUnreadable: false,
      plugin: {
        pluginId: 'review@market',
        status: 'changed',
        contentDigest: digest,
      },
    } as const;
    const wire: unknown = JSON.parse(JSON.stringify({ ok: true, state }));
    expect(parseClaudeModsUpdateResult(wire)).toEqual({ ok: true, state });
    expect(
      parseClaudeModsUpdateResult({ ok: false, code: 'digest-changed' }),
    ).toEqual({ ok: false, code: 'digest-changed' });
    expect(parseClaudeModsUpdateResult({ ok: false, code: 'nope' })).toBeNull();
    expect(
      parseClaudeModsState({
        ...state,
        plugin: { pluginId: 'x', status: 'allowed' },
      }),
    ).toBeNull();
  });
});

describe('pipeline dispatch inputs (CAN-3174)', () => {
  it('pins the capability key', () => {
    expect(REMOTE_CONTROL_CAPABILITY_PIPELINE_DISPATCH).toBe(
      'pipeline_dispatch',
    );
  });

  it('projects the four browser-safe input types', () => {
    expect(
      projectRemoteControlPipelineDispatchInputs({
        target: { type: 'choice', required: true, options: ['a', 'b'] },
        count: { type: 'number', min: 1, max: 5, default: 2 },
        dry_run: { type: 'boolean', default: false },
        note: { description: 'Free text' },
      }),
    ).toEqual({
      dispatchInputs: {
        target: { type: 'choice', required: true, options: ['a', 'b'] },
        count: { type: 'number', min: 1, max: 5, default: 2 },
        dry_run: { type: 'boolean', default: false },
        note: { description: 'Free text' },
      },
    });
  });

  it('drops optional json inputs without flagging the pipeline', () => {
    expect(
      projectRemoteControlPipelineDispatchInputs({
        payload: { type: 'json' },
        name: { type: 'string' },
      }),
    ).toEqual({ dispatchInputs: { name: { type: 'string' } } });
  });

  it('drops a required json input that has a default without flagging', () => {
    expect(
      projectRemoteControlPipelineDispatchInputs({
        payload: { type: 'json', required: true, default: { a: 1 } },
      }),
    ).toEqual({});
  });

  it('flags a required json input with no default as unsupported', () => {
    expect(
      projectRemoteControlPipelineDispatchInputs({
        payload: { type: 'json', required: true },
        name: { type: 'string' },
      }),
    ).toEqual({
      dispatchInputs: { name: { type: 'string' } },
      dispatchUnsupportedReason: 'json_input',
    });
  });

  it('returns nothing for absent or empty inputs', () => {
    expect(projectRemoteControlPipelineDispatchInputs(undefined)).toEqual({});
    expect(projectRemoteControlPipelineDispatchInputs({})).toEqual({});
  });
});

describe('provider usage projection (CAN-3635)', () => {
  it('registers the provider_usage entity type', () => {
    expect(REMOTE_CONTROL_ENTITY_TYPES).toContain('provider_usage');
  });

  it('accepts Claude, Codex and Copilot as refreshable providers', () => {
    expect(REMOTE_CONTROL_CAPABILITY_PROVIDER_USAGE).toBe('provider_usage');
    expect([...REMOTE_CONTROL_PROVIDER_USAGE_PROVIDERS]).toEqual([
      'claude',
      'codex',
      'copilot',
    ]);
    expect(isRemoteControlProviderUsageProvider('copilot')).toBe(true);
    expect(isRemoteControlProviderUsageProvider('claude')).toBe(true);
    expect(isRemoteControlProviderUsageProvider('codex')).toBe(true);
    for (const value of ['cursor', 'Codex', '', undefined, null, 1, {}]) {
      expect(isRemoteControlProviderUsageProvider(value)).toBe(false);
    }
  });

  it('registers the provider refresh as a non-destructive command', () => {
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(
      'portal.provider_usage.refresh',
    );
    expect(
      REMOTE_CONTROL_COMMAND_TYPES_SET.has('portal.provider_usage.refresh'),
    ).toBe(true);
    expect([...REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES]).not.toContain(
      'portal.provider_usage.refresh',
    );
  });

  it('registers passive provider limits as a strict empty command', () => {
    const command = 'portal.provider_usage.limits.get';
    expect(REMOTE_CONTROL_CAPABILITY_PROVIDER_USAGE_LIMITS).toBe(
      'provider_usage_limits_v1',
    );
    expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(command);
    expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(command)).toBe(true);
    expect([...REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES]).not.toContain(
      command,
    );
    expect(
      RemoteControlProviderUsageLimitsGetPayloadSchema.safeParse({}).success,
    ).toBe(true);
    for (const payload of [undefined, null, [], { targetId: 'foreign' }]) {
      expect(
        RemoteControlProviderUsageLimitsGetPayloadSchema.safeParse(payload)
          .success,
      ).toBe(false);
    }
  });
});

describe('workspace clone naming contract', () => {
  it.each([
    ['https://github.com/cursor/plugins/tree/main/pstack', 'plugins'],
    [' https://github.com/org/repo.git ', 'repo'],
    ['https://user:secret@host/org/repo.git/?token=secret#fragment', 'repo'],
    ['https://host/org/repo.git///', 'repo'],
    ['ssh://git@host/org/repo.git', 'repo'],
    ['git@host:org/repo.git', 'repo'],
    ['git@host:repo.git', 'repo'],
    ['git@host:org/repo.git\\', 'repo'],
    ['/Users/me/source-repo', 'source-repo'],
    ['C:\\source\\repo.git\\', 'repo'],
    ['org/repo.git', 'repo'],
    ['bare-repo', 'bare-repo'],
    ['', 'repository'],
    ['   ', 'repository'],
    ['https://', 'repository'],
    ['https://user:secret@host/', 'repository'],
    ['/.git///', 'repository'],
  ])('derives %s as %s while preserving supported bare inputs', (url, name) => {
    expect(repositoryNameFromCloneUrl(url)).toBe(name);
  });
});

it('registers the additive worktree branch catalog command', () => {
  expect(REMOTE_CONTROL_COMMAND_TYPES).toContain(
    'portal.worktree.branches.list',
  );
});

describe('standalone Work Entry archive contract', () => {
  it('lists archived Work Entries through a non-destructive command', () => {
    const command = 'portal.workspace.archived_work_entries.list';
    expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(command)).toBe(true);
    expect(REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
  });

  it('registers archive as a destructive command', () => {
    const command = 'portal.standalone_chat.archive';
    expect(REMOTE_CONTROL_COMMAND_TYPES_SET.has(command)).toBe(true);
    expect([...REMOTE_CONTROL_DESTRUCTIVE_COMMAND_TYPES]).toContain(command);
  });
});

// CAN-4847: updates have their own admission and long-running command contract.
it('registers collection update behind its own capability', () => {
  expect(
    REMOTE_CONTROL_COMMAND_TYPES_SET.has('portal.collections.apply_update'),
  ).toBe(true);
  expect(
    Reflect.get(
      remoteControlContract,
      'REMOTE_CONTROL_CAPABILITY_COLLECTION_UPDATES',
    ),
  ).toBe('collection_updates_v1');
});

// app-advisor:watchers-changed observations feed the same paired watcher entity.
describe('Watcher projection wire compatibility', () => {
  const entity = {
    id: 'watcher',
    projectId: 'project',
    worktreeId: 'branch',
    chatId: 'chat',
    trigger: 'worktree_pipeline_completion',
    targetKind: 'worktree_pipeline',
    status: 'active',
    createdAt: '2026-10-27T12:00:00.000Z',
    display: {
      title: 'Build',
      subtitle: 'Workflow completion',
      watching: 'Tests',
      watchingSubtitle: 'Project / branch',
      status: 'Active',
      details: [],
    },
  };

  it('preserves observed PR diff counts and rejects invalid counts', () => {
    const pullRequest = {
      repository: 'acme/api',
      number: 218,
      title: 'Unify the work drawer',
      url: 'https://github.com/acme/api/pull/218',
      baseRefName: 'develop',
      state: 'open',
      queue: null,
      observedAt: '2026-11-04T12:00:00Z',
      additions: 128,
      deletions: 42,
    };
    const parse = (
      value: typeof pullRequest,
    ): ReturnType<typeof parseRemoteControlWatcher> =>
      parseRemoteControlWatcher({
        ...entity,
        githubPullRequestProgress: { pullRequests: [value] },
      });
    expect(
      parse(pullRequest)?.githubPullRequestProgress?.pullRequests[0],
    ).toEqual(pullRequest);
    for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parse({ ...pullRequest, additions: count })).toBeNull();
      expect(parse({ ...pullRequest, deletions: count })).toBeNull();
    }
  });
});

describe('OpenCode account usage wire compatibility', () => {
  const account = {
    label: 'Fixture',
    method: 'key',
    selected: true,
    needsSignIn: false,
  };
  const snapshot = (usage?: unknown): unknown => ({
    status: 'ready',
    updatedAt: '2026-11-07T12:00:00.000Z',
    providers: [
      {
        id: 'opencode-go',
        name: 'Go',
        accounts: [{ ...account, ...(usage === undefined ? {} : { usage }) }],
      },
    ],
  });
  const ready = {
    status: 'ready',
    plan: 'OpenCode Go',
    checkedAt: '2026-11-07T12:00:00.000Z',
    windows: ['rolling', 'weekly', 'monthly'].map((id) => ({
      id,
      percent: 25,
      resetsAt: '2026-11-08T12:00:00.000Z',
    })),
  };
  it('accepts older metadata and preserves only bounded usage facts', () => {
    expect(
      openCodeAccountSnapshotSchema.parse(snapshot()).providers[0].accounts[0],
    ).toEqual(account);
    const parsed = openCodeAccountSnapshotSchema.parse(
      snapshot({
        ...ready,
        token: 'must-not-project',
        user: { secret: 'must-not-project' },
      }),
    );
    expect(parsed.providers[0].accounts[0].usage).toEqual(ready);
    expect(JSON.stringify(parsed)).not.toContain('must-not-project');
  });
  it('rejects incomplete ready usage and strips stale values from failure', () => {
    expect(
      openCodeAccountSnapshotSchema.safeParse(snapshot({ status: 'ready' }))
        .success,
    ).toBe(false);
    expect(
      openCodeAccountSnapshotSchema.safeParse(
        snapshot({
          ...ready,
          windows: [ready.windows[0], ready.windows[0], ready.windows[0]],
        }),
      ).success,
    ).toBe(false);
    const result = openCodeAccountSnapshotSchema.parse(
      snapshot({ ...ready, status: 'unavailable' }),
    );
    expect(result.providers[0].accounts[0].usage).toEqual({
      status: 'unavailable',
    });
  });
});

describe('project deletion recovery confirmation wire contract', () => {
  const legacy = {
    version: 1,
    workspaceId: 'project',
    status: 'discardable',
    items: [],
  };
  const pending = {
    operationId: '00000000-0000-4000-8000-000000006479',
    confirmation: 'a'.repeat(64),
  };

  it('retains exact pending recovery confirmations without projecting host paths', () => {
    expect(
      ProjectDeletionDiscardDescriptionSchema.parse({
        ...legacy,
        pendingRecovery: [{ ...pending, path: '/host-only/recovery' }],
        path: '/host-only/project',
      }),
    ).toEqual({ ...legacy, pendingRecovery: [pending] });
  });

  it('keeps older descriptions readable without inventing a pending confirmation', () => {
    expect(ProjectDeletionDiscardDescriptionSchema.parse(legacy)).toEqual(
      legacy,
    );
  });

  it.each([
    null,
    [{ ...pending, operationId: '/host-only/recovery' }],
    [{ ...pending, confirmation: 'not-a-reviewed-digest' }],
    [{ operationId: pending.operationId }],
    Array.from({ length: 501 }, () => pending),
  ])(
    'refuses invalid pending evidence instead of dropping its confirmation',
    (pendingRecovery) => {
      expect(
        ProjectDeletionDiscardDescriptionSchema.safeParse({
          ...legacy,
          pendingRecovery,
        }).success,
      ).toBe(false);
    },
  );
});
