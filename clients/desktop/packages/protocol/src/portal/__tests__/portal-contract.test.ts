import { parsePortalWatcher } from '../index';
import { openCodeAccountSnapshotSchema } from '../opencode-accounts';
import {
  readChatWatcherFired,
  PORTAL_CAPABILITY_APP_ADVISOR,
  PORTAL_CAPABILITY_INVOCABLE_INVENTORY,
  PORTAL_CAPABILITY_PIPELINE_CHAT_FOLLOW_UP,
  PORTAL_CAPABILITY_CLAUDE_MOD_ADMISSION,
  PORTAL_CAPABILITY_PIPELINE_CONTENT,
  PORTAL_PIPELINE_CONTENT_PAGE_MAX_CHARS,
  PORTAL_CAPABILITY_SIDEBAR_ACTIVITY_INVENTORY,
  PORTAL_CAPABILITY_PIPELINE_DISPATCH,
  PORTAL_CAPABILITY_PIPELINE_RUN_CHAT_LINKS,
  PORTAL_CAPABILITY_WORKTREE_RETENTION,
  PORTAL_CAPABILITY_PLUGIN_MUTATIONS,
  PORTAL_CAPABILITY_WORKSPACE_ITEMS,
  PORTAL_CATALOG_CONTENT_MAX_BYTES,
  PORTAL_CATALOG_RESULT_MAX_BYTES,
  PORTAL_COMMAND_TYPES,
  PORTAL_COMMAND_TYPES_SET,
  PORTAL_DESTRUCTIVE_COMMAND_TYPES,
  PORTAL_LONG_POLL_MAX_TIMEOUT_MS,
  PORTAL_LONG_RPC_COMMAND_TYPES,
  PORTAL_LONG_RPC_RESULT_TIMEOUT_MS,
  PORTAL_WORKSPACE_CREATE_EXPIRATION_MS,
  portalLongRpcResultWaitMs,
  repositoryNameFromCloneUrl,
  PORTAL_SMALL_RPC_COMMAND_TYPES,
  PORTAL_CAPABILITY_COLLECTION_MUTATIONS,
  type PortalCollectionsSaveResult,
  PORTAL_ENTITY_TYPES,
  PORTAL_EVENT_TYPES,
  PORTAL_FEATURE_SCOPE_ENTITY_TYPES,
  OVERVIEW_SCOPE_ENTITY_TYPES,
  PORTAL_CAPABILITY_PROVIDER_USAGE,
  PORTAL_PROVIDER_USAGE_PROVIDERS,
  isPortalProviderUsageProvider,
  STANDALONE_CHAT_SCOPE_ENTITY_TYPES,
  WORKSPACE_SCOPE_ENTITY_TYPES,
  parseInputDeliveryViews,
  parseChatAgentSentInfo,
  parseSteeringCapabilities,
  projectPortalPipelineDispatchInputs,
  PORTAL_SNAPSHOT_SCOPES,
  PORTAL_TARGET_KEYS,
  WORKTREE_SCOPE_ENTITY_TYPES,
  type PortalAppAdvisorAnswerQuestionPayload,
  type PortalPipelineChatFollowUpPrepareResult,
  type PortalPipelineContentReadResult,
  type PortalPipelineRun,
  type PortalAppAdvisorCancelPayload,
  type PortalAppAdvisorChatEventPayload,
  type PortalAppAdvisorChatSummary,
  type PortalAppAdvisorDismissQuestionPayload,
  type PortalAppAdvisorProjectAgentAccess,
  type PortalAppAdvisorProjectAgentAccessOwnerOption,
  type PortalAppAdvisorSettings,
  type PortalAppAdvisorSettingsSavePayload,
  type PortalAppAdvisorSendPayload,
  type PortalAppAdvisorSetModelPayload,
  type PortalMcpConnectionMetadata,
  type PortalAskUserQuestion,
  type PortalAskUserQuestionAnswer,
  type PortalAskUserQuestionState,
  type PortalChatAnswerQuestionPayload,
  type PortalChatCreateTabPayload,
  type ChatAgentSentInfo,
  type PortalChatMessage,
  type PortalChatMessageView,
  type PortalQueuedMessage,
  type PortalChatDismissQuestionPayload,
  type PortalChatProviderAvailability,
  type PortalChatTodoProjection,
  type PortalChatSetFastModePayload,
  type PortalChatSetModelPayload,
  type PortalChatSetPlanModePayload,
  type PortalChatSetThinkingLevelPayload,
  type PortalChatSummaryEntity,
  type PortalChatSummaryPluginSelections,
  type PortalCodeViewerSelection,
  type PortalChatListPluginCatalogPayload,
  type PortalChatSetPluginSelectionsPayload,
  type PortalCommandPayloadMap,
  type PortalProviderUsageAccount,
  type PortalProviderUsageEntry,
  type PortalProviderUsageProjection,
  type PortalWorktreeUpdatePayload,
  PORTAL_ADAPTER_FAILURE_CODES,
  PORTAL_WORKTREE_CREATE_REFUSAL_REASONS,
  PORTAL_CAPABILITY_WORKTREE_CREATE_FROM,
  PORTAL_CAPABILITY_WORK_ENTRY_COMMANDS,
  PORTAL_CAPABILITY_SIDEBAR_ITEM_GROUP_NAMES,
  PORTAL_CAPABILITY_TASK_REFS,
  type PortalStandaloneChatCreateResult,
  type PortalTaskRefsListResult,
  type PortalWorktreeCreateResult,
  type PortalChatScheduledMessages,
  type PortalCommandFailedPayload,
  type PortalCommandEnumParityGuards,
  type PortalWorkspaceItemsListNotesResult,
  type PortalWorkspaceItemsReadNoteResult,
  type PortalWorkspaceItemsListPromptsResult,
  type PortalWorkspaceItemsReadPromptResult,
  type PortalWorkspaceItemsListAttachmentsResult,
  type PortalCollectionsGetResult,
  type PortalCollectionsListResult,
  type PortalMcpGetServerResult,
  type PortalMcpListServersResult,
  type PortalPipelineGetPayload,
  type PortalPipelineGetResult,
  type PortalPipelineExecutionListResult,
  type PortalMarketplaceRow,
  type PortalPluginCatalog,
  type PortalPluginDetailResult,
  type PortalPluginsListMarketplacesResult,
  type PortalCatalogMarkdownContent,
  type PortalSkillsListResult,
  type PortalStandaloneChatSendPayload,
  type PortalStandaloneChatSetModelPayload,
  type PortalSessionShellState,
  type PortalStandaloneChatSummary,
  type PortalStandaloneWorkEntryFields,
} from '../index';
import * as portalContract from '../index';
import * as portalPackageEntry from '@canopy/protocol/portal';
import {
  parseClaudeModsGetArgs,
  parseClaudeModsState,
  parseClaudeModsUpdate,
  parseClaudeModsUpdateResult,
} from '../../claude-mods';
import type {
  PortalChangedFiles,
  PortalChangedFilesPageResult,
  PortalChangedFilesPayload,
  PortalStateRequestPayload,
} from '../index';

describe('changed-files paging contract compatibility', () => {
  it('round-trips legacy payloads and state requests without paging metadata', () => {
    const legacyPayload: PortalChangedFilesPayload = {
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      uncommitted: [{ filePath: 'src/a.ts', status: 'modified' }],
      committed: [],
    };
    const legacyProjection: PortalChangedFiles = {
      worktreeLocalId: 'worktree-1',
      uncommitted: legacyPayload.uncommitted,
      committed: [],
    };
    const legacyRequest: PortalStateRequestPayload = {
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
    const payload: PortalChangedFilesPayload = {
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
    const projection: PortalChangedFiles = {
      worktreeLocalId: 'worktree-1',
      uncommitted: payload.uncommitted,
      committed: [],
      page: payload.page,
    };
    const request: PortalStateRequestPayload = {
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
    const result: PortalChangedFilesPageResult = {
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
    const errorResult: PortalChangedFilesPageResult = {
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

describe('Portal branch picker contract', () => {
  it('negotiates the branch catalogue independently of the existing create payload', () => {
    const command = 'portal.worktree.branches.list';
    expect(PORTAL_COMMAND_TYPES).toContain(command);
    expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(command)).toBe(true);
    expect(PORTAL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    const query: PortalCommandPayloadMap[typeof command] = {
      workspaceId: 'ws',
    };
    expect(JSON.parse(JSON.stringify(query))).toEqual({ workspaceId: 'ws' });
    for (const baseBranch of [
      'refs/heads/develop',
      'refs/heads/origin/develop',
      'refs/remotes/origin/develop',
    ]) {
      const create: PortalCommandPayloadMap['portal.worktree.create'] = {
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
  it('is a read-only small RPC with a URL payload', () => {
    const command = 'portal.org_projects.find_repository_owner';
    expect(PORTAL_COMMAND_TYPES).toContain(command);
    expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(command)).toBe(true);
    expect(PORTAL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    expect(PORTAL_LONG_RPC_COMMAND_TYPES.has(command)).toBe(false);
    const payload: PortalCommandPayloadMap[typeof command] = {
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
        const baseBranch = portalContract.encodeWorktreeBaseBranch(target);
        expect(baseBranch).toBe(
          `${isRemote ? 'remote' : 'local'}:${branchName}`,
        );
        const wire: PortalCommandPayloadMap['portal.worktree.create'] = {
          workspaceId: 'ws',
          baseBranch,
          baseBranchEncoding:
            portalContract.PORTAL_WORKTREE_BASE_BRANCH_ENCODING,
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
          portalContract.decodeWorktreeBaseBranch(payload.baseBranch),
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
      expect(portalContract.decodeWorktreeBaseBranch(branchName)).toEqual({
        branchName,
        isRemote: false,
      });
    }
    expect(portalContract.decodeWorktreeBaseBranch('origin/topic')).toEqual({
      branchName: 'topic',
      isRemote: true,
    });
  });

  it('requires the v2 capability rather than guessing v1 encoding support', () => {
    expect(portalContract.supportsPortalWorktreeBaseBranch(undefined)).toBe(
      false,
    );
    expect(
      portalContract.supportsPortalWorktreeBaseBranch({
        worktree_base_branch_catalog_v1: true,
      }),
    ).toBe(false);
    expect(
      portalContract.supportsPortalWorktreeBaseBranch({
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
      expect(portalContract.decodeWorktreeBaseBranch(value)).toBeNull();
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
    } satisfies PortalAppAdvisorSettings;
    const legacySavePayload: PortalAppAdvisorSettingsSavePayload = {
      instructions: 'Keep my existing settings.',
    };

    expect(legacySettings).not.toHaveProperty('projectAgentAccess');
    expect(legacySettings).not.toHaveProperty('projectAgentAccessOwnerOptions');
    expect(legacySavePayload).not.toHaveProperty('projectAgentAccess');

    const projectAgentAccess: PortalAppAdvisorProjectAgentAccess[] = [
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
    const projectAgentAccessOwnerOptions: PortalAppAdvisorProjectAgentAccessOwnerOption[] =
      [
        { owner: { kind: 'personal' }, label: 'Personal' },
        {
          owner: { kind: 'organization', organizationId: 'org-1' },
          label: 'Organization One',
          unavailable: true,
        },
      ];
    const settings: PortalAppAdvisorSettings = {
      ...legacySettings,
      projectAgentAccess: projectAgentAccess[1],
      projectAgentAccessOwnerOptions,
    };
    const savePayload: PortalAppAdvisorSettingsSavePayload = {
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
      Reflect.get(portalPackageEntry, 'PORTAL_PROVIDER_USAGE_MAX_ACCOUNTS'),
    ).toBe(50);
    expect(
      Reflect.get(
        portalPackageEntry,
        'PORTAL_PROVIDER_USAGE_MAX_ACCOUNT_WINDOWS',
      ),
    ).toBe(20);
    expect(
      Reflect.get(portalContract, 'PORTAL_PROVIDER_USAGE_MAX_ACCOUNTS'),
    ).toBe(50);
    expect(
      Reflect.get(portalContract, 'PORTAL_PROVIDER_USAGE_MAX_ACCOUNT_WINDOWS'),
    ).toBe(20);
  });

  it('round-trips a typed provider usage entry with account windows', () => {
    const account: PortalProviderUsageAccount = {
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
    } satisfies PortalProviderUsageEntry;
    const projection: PortalProviderUsageProjection = {
      updatedAt: '2026-10-20T16:05:00.000Z',
      providers: [entry],
    };

    const roundTripped: unknown = JSON.parse(JSON.stringify(projection));

    expect(roundTripped).toEqual(projection);
  });

  it('keeps Auto model selection backward compatible', () => {
    const legacy: PortalChatSetModelPayload = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      model: 'sonnet',
    };
    const auto: PortalChatSetModelPayload = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      selectionMode: 'auto',
    };

    expect(legacy.model).toBe('sonnet');
    expect(auto.selectionMode).toBe('auto');
  });

  it('keeps New Task chat settings optional on create_tab', () => {
    const plus: PortalChatCreateTabPayload = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    };
    const newTask: PortalCommandPayloadMap['portal.chat.create_tab'] = {
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
    const message: PortalChatMessage = {
      messageId: 'message-1',
      chatId: 'chat-1',
      role: 'user',
      status: 'complete',
      text: 'Please review this.',
      createdAtMs: 1,
      agentSent,
    };
    const messageView: Pick<PortalChatMessageView, 'agentSent'> = { agentSent };
    const queuedMessage: Pick<PortalQueuedMessage, 'agentSent'> = { agentSent };

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

  it('registers pipeline execution controls with the intended RPC classification', () => {
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
      PortalCommandPayloadMap,
      | 'portal.pipeline.execution_list'
      | 'portal.pipeline.resume'
      | 'portal.pipeline.retry'
      | 'portal.pipeline.rerun'
    >;
    const result: PortalPipelineExecutionListResult = { runs: [] };

    expect(result.runs).toEqual([]);
    expect(Object.keys(payloads)).toEqual([
      'portal.pipeline.execution_list',
      'portal.pipeline.resume',
      'portal.pipeline.retry',
      'portal.pipeline.rerun',
    ]);
    expect(
      PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.pipeline.execution_list'),
    ).toBe(true);
    // The three control commands reconcile through portal.pipeline.event,
    // exactly like run and cancel, so they remain fire-and-forget.
    for (const command of [
      'portal.pipeline.resume',
      'portal.pipeline.retry',
      'portal.pipeline.rerun',
    ] as const) {
      expect(PORTAL_COMMAND_TYPES_SET.has(command)).toBe(true);
      expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(command)).toBe(false);
      expect(PORTAL_LONG_RPC_COMMAND_TYPES.has(command)).toBe(false);
    }
  });

  it('keeps pipeline detail as one explicit-locator small RPC', () => {
    const payload: PortalPipelineGetPayload = {
      projectId: 'workspace-1',
      pipelineId: 'project--ci.yml',
    };
    const result: PortalPipelineGetResult = {
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
    expect(PORTAL_COMMAND_TYPES_SET.has('portal.pipeline.get')).toBe(true);
    expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.pipeline.get')).toBe(
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
      PortalCommandPayloadMap,
      | 'portal.workspace_items.list_notes'
      | 'portal.workspace_items.read_note'
      | 'portal.workspace_items.list_prompts'
      | 'portal.workspace_items.read_prompt'
      | 'portal.workspace_items.list_attachments'
    >;
    const parity: PortalCommandEnumParityGuards = [true, true];
    expect(parity).toEqual([true, true]);
    expect(
      PORTAL_COMMAND_TYPES.filter((command): boolean =>
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

    const notes: PortalWorkspaceItemsListNotesResult = {
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
    const prompts: PortalWorkspaceItemsListPromptsResult = {
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
    const attachments: PortalWorkspaceItemsListAttachmentsResult = {
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
      const result: PortalWorkspaceItemsReadNoteResult = {
        ok: true,
        meta,
        content: '# Note',
        truncated: false,
      };
      expect(result.content).toBe('# Note');
      expect(result.meta.origin?.worktreeExists).toBe(true);
    }
    for (const meta of prompts.prompts) {
      const result: PortalWorkspaceItemsReadPromptResult = {
        ok: true,
        meta,
        content: 'Explain this',
        truncated: false,
      };
      expect(result.content).toBe('Explain this');
      expect(result.meta.origin).toBeUndefined();
    }
    type ItemKeys =
      | keyof PortalWorkspaceItemsReadNoteResult['meta']
      | keyof PortalWorkspaceItemsReadPromptResult['meta']
      | keyof PortalWorkspaceItemsListAttachmentsResult['attachments'][number];
    const excludesLocalPaths: 'absolutePath' extends ItemKeys ? false : true =
      true;
    expect(excludesLocalPaths).toBe(true);
    expect(JSON.parse(JSON.stringify(attachments))).toEqual(attachments);
    expect(PORTAL_CAPABILITY_WORKSPACE_ITEMS).toBe('workspace_items');
  });

  it('keeps a PDF attachment media type as serializable viewer dispatch metadata', () => {
    const selection: PortalCodeViewerSelection = {
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
    expect(PORTAL_COMMAND_TYPES).toContain('portal.chat.send');
    expect(PORTAL_COMMAND_TYPES).toContain('portal.file.save');
    expect(PORTAL_COMMAND_TYPES).toContain('portal.editor.list_slash_commands');
    expect(PORTAL_COMMAND_TYPES).toContain('portal.editor.list_file_mentions');
    // CAN-1233: the portal `+` tab button dispatches this command.
    expect(PORTAL_COMMAND_TYPES).toContain('portal.chat.create_tab');
    expect(PORTAL_COMMAND_TYPES_SET.has('portal.chat.create_tab')).toBe(true);
    // The portal tab close button dispatches this command.
    expect(PORTAL_COMMAND_TYPES).toContain('portal.chat.close_tab');
    expect(PORTAL_COMMAND_TYPES_SET.has('portal.chat.close_tab')).toBe(true);
    expect(PORTAL_COMMAND_TYPES).toContain('portal.chat.fork');
    // CAN-2829: the web marketplace shares a plugin through the paired
    // desktop, which owns the plugin files and the Cloud credentials.
    expect(PORTAL_COMMAND_TYPES).toContain('portal.plugins.share_plugin');
    expect(
      PORTAL_LONG_RPC_COMMAND_TYPES.has('portal.plugins.share_plugin'),
    ).toBe(true);
    expect(PORTAL_COMMAND_TYPES_SET.has('portal.chat.fork')).toBe(true);
    expect(PORTAL_COMMAND_TYPES).toContain('portal.chat.branch');
    expect(PORTAL_COMMAND_TYPES_SET.has('portal.chat.branch')).toBe(true);
    expect(PORTAL_COMMAND_TYPES).toContain('portal.chat.share');
    expect(PORTAL_COMMAND_TYPES_SET.has('portal.chat.share')).toBe(true);
    expect(PORTAL_EVENT_TYPES).toContain('portal.state.snapshot');
    expect(PORTAL_EVENT_TYPES).toContain('portal.file.snapshot');
    expect(PORTAL_ENTITY_TYPES).toContain('standalone_chat');
    expect(PORTAL_ENTITY_TYPES).toContain('pipeline');
    expect(PORTAL_ENTITY_TYPES).toContain('chat_todo');
    expect(PORTAL_ENTITY_TYPES).toContain('mcp_server');
    expect(PORTAL_ENTITY_TYPES).toContain('background_process');
  });

  it('pins the chat TODO projection and replacement scopes', () => {
    const projection: PortalChatTodoProjection = {
      localId: 'chat-1',
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      chatId: 'chat-1',
      items: [
        { id: 'todo:1', content: 'Project TODOs', status: 'in_progress' },
      ],
    };

    void projection;
    // localId = chatId is enforced end-to-end by the stacked desktop PR's
    // apps/desktop-app/src/main/portal/__tests__/portal-snapshot-builders.test.ts.
    expect(WORKTREE_SCOPE_ENTITY_TYPES).toContain('chat_todo');
    expect(WORKTREE_SCOPE_ENTITY_TYPES).toContain('mcp_server');
    expect(WORKTREE_SCOPE_ENTITY_TYPES).toContain('background_process');
    expect(PORTAL_FEATURE_SCOPE_ENTITY_TYPES.chat).toEqual([
      'chat_summary',
      'chat_todo',
      'watcher',
    ]);
  });

  it('exposes the CAN-1217 persistent composer setter commands', () => {
    const setters = [
      'portal.chat.set_model',
      'portal.chat.set_thinking_level',
      'portal.chat.set_plan_mode',
      'portal.chat.set_fast_mode',
    ] as const;
    for (const setter of setters) {
      expect(PORTAL_COMMAND_TYPES).toContain(setter);
      expect(PORTAL_COMMAND_TYPES_SET.has(setter)).toBe(true);
    }
  });

  it('lets portal.worktree.update carry a tracked base branch', () => {
    const payload: PortalCommandPayloadMap['portal.worktree.update'] = {
      workspaceId: 'ws',
      worktreeId: 'wt',
      trackedBaseBranch: 'release/1.2',
    };
    // Assign to the explicit interface to prove the map alias matches.
    const explicit: PortalWorktreeUpdatePayload = payload;

    expect(explicit.trackedBaseBranch).toBe('release/1.2');
    expect(PORTAL_COMMAND_TYPES_SET.has('portal.worktree.update')).toBe(true);
  });

  it('lets portal.worktree.update clear base branches, per repository too', () => {
    const payload: PortalWorktreeUpdatePayload = {
      workspaceId: 'ws',
      worktreeId: 'wt',
      trackedBaseBranch: null,
      trackedRepoBaseBranches: { api: 'main', web: null },
    };

    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('carries a typed worktree create refusal on the failed payload', () => {
    const failed: PortalCommandFailedPayload = {
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
    const legacy: PortalCommandFailedPayload = {
      commandId: 'cmd-2',
      sequenceNumber: 5,
      error: { code: 'execution_failed', message: 'Failed.' },
      generatedAt: '2026-11-04T00:00:00.000Z',
    };

    expect(JSON.parse(JSON.stringify(failed))).toEqual(failed);
    expect(legacy.refusal).toBeUndefined();
    // Every refusal reason is also a closed adapter failure code.
    expect(PORTAL_WORKTREE_CREATE_REFUSAL_REASONS).toHaveLength(13);
    for (const reason of PORTAL_WORKTREE_CREATE_REFUSAL_REASONS) {
      expect(PORTAL_ADAPTER_FAILURE_CODES).toContain(reason);
    }
  });

  it('adds the task commands behind their capabilities', () => {
    expect([
      PORTAL_CAPABILITY_WORKTREE_CREATE_FROM,
      PORTAL_CAPABILITY_WORK_ENTRY_COMMANDS,
      PORTAL_CAPABILITY_SIDEBAR_ITEM_GROUP_NAMES,
      PORTAL_CAPABILITY_TASK_REFS,
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
      expect(PORTAL_COMMAND_TYPES_SET.has(command)).toBe(true);
      expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(command)).toBe(true);
    }
    expect(
      PORTAL_DESTRUCTIVE_COMMAND_TYPES.has('portal.work_entry.delete'),
    ).toBe(true);
    expect(
      PORTAL_DESTRUCTIVE_COMMAND_TYPES.has('portal.work_entry.update'),
    ).toBe(false);
  });

  it('carries create-from, group name and first chat on task creates', () => {
    const firstChat = {
      chatId: 'chat-1',
      userMessageId: 'msg-1',
      text: 'Start here',
      planMode: true,
    };
    const create: PortalCommandPayloadMap['portal.worktree.create'] = {
      workspaceId: 'ws',
      existingBranch: 'feature/x',
      pullRequest: { number: 42, as: 'base' },
      sidebarItemGroupName: { name: 'Sprint', color: 'categorical-2' },
      firstChat,
    };
    const older: PortalCommandPayloadMap['portal.worktree.create'] = {
      workspaceId: 'ws',
      baseWorktreeId: 'wt-1',
    };
    // Older hosts answer with only the legacy fields; `id` stays the worktree id.
    const legacyResult: PortalWorktreeCreateResult = {
      id: 'wt-2',
      branchName: 'feature/x',
      createdAt: '2026-11-04T00:00:00.000Z',
    };
    const result: PortalWorktreeCreateResult = {
      ...legacyResult,
      setupPhase: 'git-pending',
      chat: { chatId: 'chat-1', userMessageId: 'msg-1', delivery: 'queued' },
      groupError: 'The group limit was reached.',
    };
    const chatErrorResult: PortalWorktreeCreateResult = {
      ...legacyResult,
      chatError:
        'The task was created, but its first chat message could not be sent.',
    };
    const cowork: PortalCommandPayloadMap['portal.standalone_chat.create'] = {
      projectLocalId: 'p',
      chatId: 'chat-2',
      workEntryId: 'entry-1',
      firstChat,
    };
    const coworkResult: PortalStandaloneChatCreateResult = {
      ok: true,
      chatId: 'chat-2',
      projectLocalId: 'p',
      projectId: 'p',
      worktreeId: 'entry-1',
      workEntryId: 'entry-1',
      chat: { chatId: 'chat-2', userMessageId: 'msg-1', delivery: 'started' },
    };
    const coworkChatErrorResult: PortalStandaloneChatCreateResult = {
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
    const update: PortalCommandPayloadMap['portal.work_entry.update'] = {
      projectLocalId: 'p',
      entryId: 'entry-1',
      title: null,
    };
    const remove: PortalCommandPayloadMap['portal.work_entry.delete'] = {
      projectLocalId: 'p',
      entryId: 'entry-1',
      archive: true,
    };
    const assign: PortalCommandPayloadMap['portal.sidebar.item_groups.assign_named'] =
      {
        scope: { workspaceLocalId: 'ws' },
        itemId: 'wt-1',
        name: 'Sprint',
      };
    const refs: PortalCommandPayloadMap['portal.task_refs.list'] = {
      workspaceId: 'ws',
      kind: 'pr',
      query: 'fix',
      limit: 50,
      offset: 0,
    };
    const page: PortalTaskRefsListResult = {
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
    const scheduledMessages: PortalChatScheduledMessages = {
      count: 2,
      nextAt: '2026-11-05T09:00:00.000Z',
    };
    const worktreeChat: PortalChatSummaryEntity = {
      localId: 'chat',
      chatId: 'chat',
      scope: 'worktree',
      title: 'Chat',
      awaitingApproval: true,
      scheduledMessages,
    };
    const cleared: PortalChatSummaryEntity = {
      ...worktreeChat,
      awaitingApproval: false,
      scheduledMessages: { count: 0 },
    };
    const coworkChat: PortalStandaloneChatSummary = {
      projectLocalId: 'p',
      projectId: 'p',
      chatId: 'chat',
      title: 'Chat',
      awaitingApproval: false,
      scheduledMessages,
    };
    const snapshotChat: PortalSessionShellState['standaloneChats'][number] = {
      localId: 'chat',
      projectLocalId: 'p',
      title: 'Chat',
      scheduledMessages,
    };
    const older: PortalChatSummaryEntity = {
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
    const setModel: PortalCommandPayloadMap['portal.chat.set_model'] = {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      model: 'claude-sonnet-5',
    };
    const setThinking: PortalCommandPayloadMap['portal.chat.set_thinking_level'] =
      {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        thinkingLevel: 'high',
      };
    const setPlan: PortalCommandPayloadMap['portal.chat.set_plan_mode'] = {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      planMode: true,
    };
    const setFast: PortalCommandPayloadMap['portal.chat.set_fast_mode'] = {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      fastMode: true,
    };
    // Assign to the explicit interfaces to prove the map aliases match.
    const model: PortalChatSetModelPayload = setModel;
    const thinking: PortalChatSetThinkingLevelPayload = setThinking;
    const plan: PortalChatSetPlanModePayload = setPlan;
    const fast: PortalChatSetFastModePayload = setFast;
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
      expect(PORTAL_COMMAND_TYPES).toContain(command);
      expect(PORTAL_COMMAND_TYPES_SET.has(command)).toBe(true);
    }
  });

  it('pins the CAN-1219 plugins + standalone-model payload shapes', () => {
    const setPlugins: PortalCommandPayloadMap['portal.chat.set_plugin_selections'] =
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
    const listCatalog: PortalCommandPayloadMap['portal.chat.list_plugin_catalog'] =
      {
        projectId: 'ws',
        worktreeId: 'wt',
        providerType: 'claude',
      };
    const setStandaloneModel: PortalCommandPayloadMap['portal.standalone_chat.set_model'] =
      {
        chatId: 'chat',
        model: 'claude-opus-4-8',
      };
    // Assign to the explicit interfaces to prove the map aliases match.
    const plugins: PortalChatSetPluginSelectionsPayload = setPlugins;
    const catalog: PortalChatListPluginCatalogPayload = listCatalog;
    const standaloneModel: PortalStandaloneChatSetModelPayload =
      setStandaloneModel;
    expect(plugins.selections.collectionIds).toEqual(['c1']);
    expect(catalog.providerType).toBe('claude');
    expect(standaloneModel.model).toBe('claude-opus-4-8');
  });

  it('shapes the plugin catalog result and standalone model summary', () => {
    const catalog: PortalPluginCatalog = {
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
    const summary: PortalStandaloneChatSummary = {
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
    const facts: PortalStandaloneWorkEntryFields = {
      workEntryId: 'entry-1',
      workEntryTitle: 'Research',
      workEntryCreatedAt: '2026-09-01T00:00:00.000Z',
      workEntryLastMessageAt: '2026-09-02T00:00:00.000Z',
      workEntryLastTouchedAt: '2026-09-03T00:00:00.000Z',
      workEntryOrder: 2,
      workEntryPinned: true,
      workEntryStatus: 'done',
    };
    const summary: PortalStandaloneChatSummary = {
      projectLocalId: 'p',
      projectId: 'p',
      chatId: 'chat',
      title: 'Chat',
      ...facts,
    };
    const snapshotChat: PortalSessionShellState['standaloneChats'][number] = {
      localId: 'chat',
      projectLocalId: 'p',
      title: 'Chat',
      ...facts,
    };
    const workspace: PortalSessionShellState['workspaces'][number] = {
      localId: 'p',
      name: 'Project',
      type: 'cowork',
      itemSortMode: 'manual',
    };
    // Every fact is optional: an older desktop build's chat still type-checks.
    const legacyChat: PortalSessionShellState['standaloneChats'][number] = {
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
    const payload: PortalStandaloneChatSendPayload = {
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
    const payload: PortalStandaloneChatSendPayload = {
      chatId: 'chat',
      message: 'hi',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'ultrafast',
        fastMode: false,
      },
    };
    const summary: PortalChatSummaryEntity = {
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
    const pluginSelections: PortalChatSummaryPluginSelections = {
      collectionIds: ['c1'],
      skillCount: 2,
      pluginCount: 1,
      mcpServerCount: 0,
    };
    const providerAvailability: PortalChatProviderAvailability = {
      claude: true,
      codex: false,
      ollama: true,
    };
    const summary: PortalChatSummaryEntity = {
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
      expect(PORTAL_COMMAND_TYPES).toContain(command);
      expect(PORTAL_COMMAND_TYPES_SET.has(command)).toBe(true);
    }
  });

  it('pins the answer/dismiss question payload shapes on the payload map', () => {
    const answer: PortalCommandPayloadMap['portal.chat.answer_question'] = {
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
    const dismiss: PortalCommandPayloadMap['portal.chat.dismiss_question'] = {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      requestId: 'req-1',
    };
    // Assign to the explicit interfaces to prove the map aliases match.
    const answerPayload: PortalChatAnswerQuestionPayload = answer;
    const dismissPayload: PortalChatDismissQuestionPayload = dismiss;
    expect(answerPayload.requestId).toBe('req-1');
    expect(answerPayload.answers[0]?.selectedOptions).toEqual(['Blue']);
    expect(answerPayload.answers[0]?.freeformText).toBe('Actually teal');
    expect(dismissPayload.requestId).toBe('req-1');
    // Routing reuses the desktop names via PortalChatSetterTarget.
    expect(dismissPayload.projectId).toBe('ws');
    expect(dismissPayload.worktreeId).toBe('wt');
    expect(dismissPayload.chatId).toBe('chat');
  });

  it('projects awaiting and answered question state on the chat summary entity', () => {
    const question: PortalAskUserQuestion = {
      id: 'q1',
      header: 'Deployment',
      question: 'Which environment?',
      options: ['staging', 'production'],
      multiSelect: false,
      optionDescriptions: ['Safe sandbox', 'Live traffic'],
      allowOther: true,
      secret: false,
    };
    const secretQuestion: PortalAskUserQuestion = {
      question: 'Provide the token',
      options: [],
      secret: true,
    };
    const answers: PortalAskUserQuestionAnswer[] = [
      {
        questionId: 'q1',
        question: 'Which environment?',
        selectedOptions: ['production'],
        freeformText: 'us-east-1',
      },
    ];
    const awaiting: PortalAskUserQuestionState = {
      requestId: 'req-awaiting',
      toolUseId: 'codex-call-1',
      questions: [question, secretQuestion],
      answered: false,
    };
    const answered: PortalAskUserQuestionState = {
      requestId: 'req-answered',
      questions: [question],
      answered: true,
      answers,
    };
    const summary: PortalChatSummaryEntity = {
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
    const cleared: PortalChatSummaryEntity = {
      localId: 'chat',
      chatId: 'chat',
      scope: 'worktree',
      title: 'Chat',
      pendingQuestions: [],
    };
    expect(cleared.pendingQuestions).toEqual([]);
    const omitted: PortalChatSummaryEntity = {
      localId: 'chat',
      chatId: 'chat',
      scope: 'worktree',
      title: 'Chat',
    };
    expect(omitted.pendingQuestions).toBeUndefined();
  });

  it('pins portal target keys', () => {
    expect(PORTAL_TARGET_KEYS).toContain('workspaceLocalId');
    expect(PORTAL_TARGET_KEYS).toContain('worktreeLocalId');
    expect(PORTAL_TARGET_KEYS).toContain('filePath');
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
    const portalSurface = [
      ...PORTAL_COMMAND_TYPES,
      ...PORTAL_EVENT_TYPES,
      ...PORTAL_ENTITY_TYPES,
    ];
    const blockedSubstrings = ['app_advisor', 'app-advisor', 'appAdvisor'];
    for (const entry of portalSurface) {
      if (allowedAppAdvisorTypes.has(entry)) continue;
      for (const needle of blockedSubstrings) {
        expect(entry).not.toContain(needle);
      }
    }
    // Every allow-listed type must actually exist on the wire surface, so
    // stale entries cannot silently widen the allowance.
    for (const allowed of allowedAppAdvisorTypes) {
      expect(portalSurface).toContain(allowed);
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
      expect(PORTAL_COMMAND_TYPES).toContain(command);
      expect(PORTAL_COMMAND_TYPES_SET.has(command)).toBe(true);
      // Relayed chat commands are not flag-gated destructive operations.
      expect(PORTAL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    }
    expect(PORTAL_EVENT_TYPES).toContain('portal.app_advisor.event');
    expect(PORTAL_ENTITY_TYPES).toContain('app_advisor_chat');
    expect(PORTAL_SNAPSHOT_SCOPES).toContain('app_advisor');
    expect(PORTAL_FEATURE_SCOPE_ENTITY_TYPES.app_advisor).toEqual([
      'app_advisor_chat',
      'app_advisor_item_groups',
      'watcher',
    ]);
    expect(PORTAL_CAPABILITY_APP_ADVISOR).toBe('app_advisor');
    expect(PORTAL_CAPABILITY_WORKTREE_RETENTION).toBe('worktree_retention');
  });

  it('pins the App Advisor payload shapes on the payload map', () => {
    const send: PortalCommandPayloadMap['portal.app_advisor.send'] = {
      chatId: 'advisor-chat',
      text: 'open the pipelines page',
      model: 'claude-sonnet-5',
      modelConfig: { thinkingLevel: 'medium' },
      inputMode: 'typed',
    };
    const cancel: PortalCommandPayloadMap['portal.app_advisor.cancel'] = {
      chatId: 'advisor-chat',
    };
    const setModel: PortalCommandPayloadMap['portal.app_advisor.set_model'] = {
      chatId: 'advisor-chat',
      model: 'gpt-5.6-sol',
    };
    const answer: PortalCommandPayloadMap['portal.app_advisor.answer_question'] =
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
    const dismiss: PortalCommandPayloadMap['portal.app_advisor.dismiss_question'] =
      {
        chatId: 'advisor-chat',
        requestId: 'req-1',
      };
    // Assign to the explicit interfaces to prove the map aliases match.
    const sendPayload: PortalAppAdvisorSendPayload = send;
    const cancelPayload: PortalAppAdvisorCancelPayload = cancel;
    const setModelPayload: PortalAppAdvisorSetModelPayload = setModel;
    const answerPayload: PortalAppAdvisorAnswerQuestionPayload = answer;
    const dismissPayload: PortalAppAdvisorDismissQuestionPayload = dismiss;
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
    const event: PortalAppAdvisorChatEventPayload = {
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
    const summary: PortalAppAdvisorChatSummary = {
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
      expect(PORTAL_COMMAND_TYPES).toContain(command);
      expect(PORTAL_COMMAND_TYPES_SET.has(command)).toBe(true);
      // Read-only browsing is never a flag-gated destructive operation.
      expect(PORTAL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
      expect(PORTAL_LONG_RPC_COMMAND_TYPES.has(command)).toBe(false);
      // Every browse command answers synchronously on the submit response.
      expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(command)).toBe(true);
    }
  });

  it('announces the strict sidebar Activity inventory behind its own capability', () => {
    expect(PORTAL_CAPABILITY_SIDEBAR_ACTIVITY_INVENTORY).toBe(
      'sidebar_activity_inventory',
    );
  });

  it('announces the invocable inventory commands behind one capability', () => {
    expect(PORTAL_CAPABILITY_INVOCABLE_INVENTORY).toBe('invocable_inventory');
    for (const command of [
      'portal.editor.list_invocables',
      'portal.editor.resolve_invocable',
      'portal.standalone_chat.set_plugin_selections',
    ] as const) {
      expect(PORTAL_COMMAND_TYPES_SET.has(command)).toBe(true);
      expect(PORTAL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    }
    // The cached list answers on the submit response. Resolving may prepare
    // a Codex plugin before it commits, so it waits on the long tier.
    expect(
      PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.editor.list_invocables'),
    ).toBe(true);
    expect(
      PORTAL_LONG_RPC_COMMAND_TYPES.has('portal.editor.resolve_invocable'),
    ).toBe(true);

    // Payloads name chats by opaque ids only; the host owns paths, enable
    // refs and insert text.
    const list: PortalCommandPayloadMap['portal.editor.list_invocables'] = {
      target: {
        kind: 'standalone',
        projectLocalId: 'cowork-default',
        chatId: 'chat-1',
      },
    };
    const resolve: PortalCommandPayloadMap['portal.editor.resolve_invocable'] =
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
    const select: PortalCommandPayloadMap['portal.standalone_chat.set_plugin_selections'] =
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

  it('keeps the small-RPC set inside the closed command enum', () => {
    for (const type of PORTAL_SMALL_RPC_COMMAND_TYPES) {
      expect(PORTAL_COMMAND_TYPES).toContain(type);
    }
    // The pre-existing small-RPC commands remain members after the refactor
    // of the browser commands route onto this shared set.
    for (const type of [
      'portal.editor.list_slash_commands',
      'portal.editor.list_file_mentions',
      'portal.chat.list_plugin_catalog',
      'portal.workspace.claude_md.get',
      'portal.workspace.scripts.get',
      'portal.workspace.update',
      'portal.state.request',
    ] as const) {
      expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(type)).toBe(true);
    }
    // Long-running creates keep their dedicated wait path.
    expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.workspace.create')).toBe(
      false,
    );
    expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.worktree.create')).toBe(
      false,
    );
    expect(PORTAL_CATALOG_CONTENT_MAX_BYTES).toBe(256 * 1024);
    // The whole-result budget must leave real headroom under the ~1 MiB
    // portal event cap while still fitting a full 256 KB body.
    expect(PORTAL_CATALOG_RESULT_MAX_BYTES).toBe(700 * 1024);
    expect(PORTAL_CATALOG_RESULT_MAX_BYTES).toBeGreaterThan(
      PORTAL_CATALOG_CONTENT_MAX_BYTES,
    );
  });

  it('pins the Plugins-section browse payload shapes on the payload map', () => {
    const listMarketplaces: PortalCommandPayloadMap['portal.plugins.list_marketplaces'] =
      { projectId: 'ws' };
    const getDetail: PortalCommandPayloadMap['portal.plugins.get_plugin_detail'] =
      { projectId: 'ws', marketplaceId: 'mkt', pluginName: 'plugin' };
    const readComponent: PortalCommandPayloadMap['portal.plugins.read_component_content'] =
      {
        projectId: 'ws',
        marketplaceId: 'mkt',
        pluginName: 'plugin',
        componentType: 'skill',
        componentFile: 'skills/review/SKILL.md',
      };
    const listSkills: PortalCommandPayloadMap['portal.skills.list'] = {
      projectId: 'ws',
    };
    const readSkill: PortalCommandPayloadMap['portal.skills.read'] = {
      projectId: 'ws',
      sourceId: 'src',
      skillName: 'review',
    };
    const listServers: PortalCommandPayloadMap['portal.mcp.list_servers'] = {
      projectId: 'ws',
    };
    const getServer: PortalCommandPayloadMap['portal.mcp.get_server'] = {
      projectId: 'ws',
      serverId: 'abc-123',
    };
    const listCollections: PortalCommandPayloadMap['portal.collections.list'] =
      { projectId: 'ws' };
    const getCollection: PortalCommandPayloadMap['portal.collections.get'] = {
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

  it('saves a collection through one small-RPC command behind its own capability', () => {
    expect(PORTAL_COMMAND_TYPES).toContain('portal.collections.save');
    expect(PORTAL_COMMAND_TYPES_SET.has('portal.collections.save')).toBe(true);
    expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.collections.save')).toBe(
      true,
    );
    expect(PORTAL_LONG_RPC_COMMAND_TYPES.has('portal.collections.save')).toBe(
      false,
    );
    expect(PORTAL_CAPABILITY_COLLECTION_MUTATIONS).toBe(
      'collection_mutations_v1',
    );
    const save: PortalCommandPayloadMap['portal.collections.save'] = {
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
    const result: PortalCollectionsSaveResult = {
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
      expect(PORTAL_COMMAND_TYPES).toContain(command);
      expect(PORTAL_COMMAND_TYPES_SET.has(command)).toBe(true);
      // Every mutation is reversible (re-install, re-add, re-enable), so the
      // browser confirmation dialog — not the destructive kill switch — is
      // the guard, matching portal.workspace.delete.
      expect(PORTAL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    }
    // There is deliberately NO per-plugin uninstall command: the desktop
    // product models removal as provider-scoped marketplace removal, so the
    // portal does too.
    expect(
      PORTAL_COMMAND_TYPES_SET.has('portal.plugins.uninstall_builtin'),
    ).toBe(false);
  });

  it('keeps the long-RPC set in lockstep with the wait tiers', () => {
    // Every long-RPC member is a real command and never small-RPC (the two
    // wait tiers are mutually exclusive branches in the commands route).
    PORTAL_LONG_RPC_COMMAND_TYPES.forEach((type) => {
      expect(PORTAL_COMMAND_TYPES).toContain(type);
      expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(type)).toBe(false);
    });
    // The pre-existing creates joined this shared set when the route's
    // hardcoded branch was generalized.
    for (const type of [
      'portal.workspace.create',
      'portal.worktree.create',
      'portal.plugins.install_builtin',
      'portal.plugins.install_external',
      'portal.marketplace.add',
      'portal.marketplace.update',
      'portal.marketplace.remove',
    ] as const) {
      expect(PORTAL_LONG_RPC_COMMAND_TYPES.has(type)).toBe(true);
    }
    // refresh_all is FIRE-AND-FORGET: minutes-long fan-out, so neither wait
    // tier may hold the submit response open for it.
    expect(
      PORTAL_LONG_RPC_COMMAND_TYPES.has('portal.marketplace.refresh_all'),
    ).toBe(false);
    expect(
      PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.marketplace.refresh_all'),
    ).toBe(false);
    // The MCP toggle is a fast local fs write → small-RPC.
    expect(
      PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.mcp.set_config_enabled'),
    ).toBe(true);
    // The long-RPC wait window generalizes the workspace-create constant and
    // stays inside the proven long-poll infra ceiling and under the 60s
    // command TTL (a longer wait could observe EXPIRED mid-flight).
    expect(PORTAL_LONG_RPC_RESULT_TIMEOUT_MS).toBe(
      PORTAL_LONG_POLL_MAX_TIMEOUT_MS,
    );
  });

  it('announces the plugin-mutations capability under its stable name', () => {
    expect(PORTAL_CAPABILITY_PLUGIN_MUTATIONS).toBe('plugin_mutations');
  });

  it('pins the Plugins-section mutation payload shapes on the payload map', () => {
    const installBuiltin: PortalCommandPayloadMap['portal.plugins.install_builtin'] =
      {
        projectId: 'ws',
        marketplaceId: 'builtin/app',
        pluginName: 'plugin',
        providers: ['claude', 'codex'],
      };
    const installExternal: PortalCommandPayloadMap['portal.plugins.install_external'] =
      { projectId: 'ws', marketplaceId: 'mkt', pluginName: 'plugin' };
    const add: PortalCommandPayloadMap['portal.marketplace.add'] = {
      projectId: 'ws',
      repo: 'acme/marketplace',
    };
    const update: PortalCommandPayloadMap['portal.marketplace.update'] = {
      projectId: 'ws',
      marketplaceId: 'mkt',
    };
    const remove: PortalCommandPayloadMap['portal.marketplace.remove'] = {
      projectId: 'ws',
      marketplaceId: 'mkt',
      providers: ['codex'],
    };
    const refreshAll: PortalCommandPayloadMap['portal.marketplace.refresh_all'] =
      { projectId: 'ws' };
    const toggle: PortalCommandPayloadMap['portal.mcp.set_config_enabled'] = {
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
    const marketplace: PortalMarketplaceRow = {
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
    const listResult: PortalPluginsListMarketplacesResult = {
      marketplaces: [marketplace],
      lastRefreshed: '2026-08-27T00:00:00.000Z',
    };
    const detail: PortalPluginDetailResult = {
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
    const content: PortalCatalogMarkdownContent = {
      frontmatter: { description: 'd' },
      body: 'content',
      truncated: false,
    };
    const skills: PortalSkillsListResult = {
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
    const servers: PortalMcpListServersResult = {
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
    const serverDetail: PortalMcpGetServerResult = {
      server: {
        id: 'abc',
        name: 'GitHub',
        description: 'd',
        type: 'http',
        // Sanitized: scheme + host + port + path only (no userinfo/query/
        // fragment), per the PortalMcpServerDetail contract.
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
    const collections: PortalCollectionsListResult = {
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
    const collection: PortalCollectionsGetResult = {
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
  const metadata: PortalMcpConnectionMetadata = {
    connectionState: 'connected',
    connectionId: 'connection-id',
    authMode: 'NONE',
    enabledTools: [],
    connectionRequiresAuth: false,
  };
  expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
  const legacy: PortalMcpConnectionMetadata = {};
  expect(legacy.connectionState).toBeUndefined();
});

describe('pipeline run chat links (CAN-3619)', () => {
  it('exports the negotiated capability key', () => {
    expect(Object.values(portalContract)).toContain('pipeline_run_chat_links');
    expect(PORTAL_CAPABILITY_PIPELINE_RUN_CHAT_LINKS).toBe(
      'pipeline_run_chat_links',
    );
  });

  it('round-trips additive chat turn links on a pipeline_run payload', () => {
    const run: PortalPipelineRun = {
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
  it('pins the capability key and the small-RPC prepare command', () => {
    expect(PORTAL_CAPABILITY_PIPELINE_CHAT_FOLLOW_UP).toBe(
      'pipeline_chat_follow_up',
    );
    expect(PORTAL_COMMAND_TYPES).toContain(
      'portal.pipeline.chat_follow_up.prepare',
    );
    expect(
      PORTAL_SMALL_RPC_COMMAND_TYPES.has(
        'portal.pipeline.chat_follow_up.prepare',
      ),
    ).toBe(true);
  });

  it('round-trips path-free availability and the prepare shapes', () => {
    const run: PortalPipelineRun = {
      localId: 'exec-1',
      pipelineId: 'pipe-1',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      status: 'failed',
      chatFollowUp: { planAvailable: false, reportAvailable: true },
    };
    const payload: PortalCommandPayloadMap['portal.pipeline.chat_follow_up.prepare'] =
      {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        executionId: 'exec-1',
        output: 'report',
      };
    const result: PortalPipelineChatFollowUpPrepareResult = {
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
  it('pins the capability key and the small-RPC read command', () => {
    expect(PORTAL_CAPABILITY_PIPELINE_CONTENT).toBe('pipeline_content');
    expect(PORTAL_COMMAND_TYPES).toContain('portal.pipeline.content.read');
    expect(
      PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.pipeline.content.read'),
    ).toBe(true);
  });

  it('keeps a fully escaped page under the result cap', () => {
    expect(PORTAL_PIPELINE_CONTENT_PAGE_MAX_CHARS * 6).toBeLessThan(
      PORTAL_CATALOG_RESULT_MAX_BYTES,
    );
  });

  it('round-trips path-free read shapes', () => {
    const payload: PortalCommandPayloadMap['portal.pipeline.content.read'] = {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      executionId: 'exec-1',
      source: { kind: 'step_output', jobId: 'build', stepId: 'agent' },
      offset: 10,
      revision: 'r1',
    };
    const result: PortalPipelineContentReadResult = {
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

describe('Claude Mod admission controls', () => {
  const digest = `sha256:${'a'.repeat(64)}`;

  it('pins the capability key and both small-RPC commands', () => {
    expect(PORTAL_CAPABILITY_CLAUDE_MOD_ADMISSION).toBe(
      'claude_mod_admission_v1',
    );
    for (const command of [
      'portal.claude_mods.get',
      'portal.claude_mods.update',
    ] as const) {
      expect(PORTAL_COMMAND_TYPES).toContain(command);
      expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(command)).toBe(true);
      expect(PORTAL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
    }
  });

  it('parses get and update payloads and refuses malformed ones', () => {
    const get: PortalCommandPayloadMap['portal.claude_mods.get'] = {
      pluginId: 'review@builtin/app',
    };
    expect(parseClaudeModsGetArgs(get)).toEqual(get);
    expect(parseClaudeModsGetArgs({})).toEqual({});
    expect(parseClaudeModsGetArgs({ pluginId: '../x@y' })).toBeNull();

    const allow: PortalCommandPayloadMap['portal.claude_mods.update'] = {
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
    expect(PORTAL_CAPABILITY_PIPELINE_DISPATCH).toBe('pipeline_dispatch');
  });

  it('projects the four browser-safe input types', () => {
    expect(
      projectPortalPipelineDispatchInputs({
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
      projectPortalPipelineDispatchInputs({
        payload: { type: 'json' },
        name: { type: 'string' },
      }),
    ).toEqual({ dispatchInputs: { name: { type: 'string' } } });
  });

  it('drops a required json input that has a default without flagging', () => {
    expect(
      projectPortalPipelineDispatchInputs({
        payload: { type: 'json', required: true, default: { a: 1 } },
      }),
    ).toEqual({});
  });

  it('flags a required json input with no default as unsupported', () => {
    expect(
      projectPortalPipelineDispatchInputs({
        payload: { type: 'json', required: true },
        name: { type: 'string' },
      }),
    ).toEqual({
      dispatchInputs: { name: { type: 'string' } },
      dispatchUnsupportedReason: 'json_input',
    });
  });

  it('returns nothing for absent or empty inputs', () => {
    expect(projectPortalPipelineDispatchInputs(undefined)).toEqual({});
    expect(projectPortalPipelineDispatchInputs({})).toEqual({});
  });
});

describe('provider usage projection (CAN-3635)', () => {
  it('registers the provider_usage singleton only in the overview replacement set', () => {
    expect(PORTAL_ENTITY_TYPES).toContain('provider_usage');
    expect([...OVERVIEW_SCOPE_ENTITY_TYPES]).toContain('provider_usage');
    const otherReplacementSets: ReadonlyArray<readonly string[]> = [
      WORKSPACE_SCOPE_ENTITY_TYPES,
      WORKTREE_SCOPE_ENTITY_TYPES,
      STANDALONE_CHAT_SCOPE_ENTITY_TYPES,
      ...Object.values(PORTAL_FEATURE_SCOPE_ENTITY_TYPES),
    ];
    for (const replacementSet of otherReplacementSets) {
      expect(replacementSet).not.toContain('provider_usage');
    }
  });

  it('accepts Claude, Codex and Copilot as refreshable providers', () => {
    expect(PORTAL_CAPABILITY_PROVIDER_USAGE).toBe('provider_usage');
    expect([...PORTAL_PROVIDER_USAGE_PROVIDERS]).toEqual([
      'claude',
      'codex',
      'copilot',
    ]);
    expect(isPortalProviderUsageProvider('copilot')).toBe(true);
    expect(isPortalProviderUsageProvider('claude')).toBe(true);
    expect(isPortalProviderUsageProvider('codex')).toBe(true);
    for (const value of ['cursor', 'Codex', '', undefined, null, 1, {}]) {
      expect(isPortalProviderUsageProvider(value)).toBe(false);
    }
  });

  it('registers the provider refresh as an acknowledged small RPC', () => {
    expect(PORTAL_COMMAND_TYPES).toContain('portal.provider_usage.refresh');
    expect(PORTAL_COMMAND_TYPES_SET.has('portal.provider_usage.refresh')).toBe(
      true,
    );
    expect([...PORTAL_SMALL_RPC_COMMAND_TYPES]).toContain(
      'portal.provider_usage.refresh',
    );
    expect([...PORTAL_LONG_RPC_COMMAND_TYPES]).not.toContain(
      'portal.provider_usage.refresh',
    );
    expect([...PORTAL_DESTRUCTIVE_COMMAND_TYPES]).not.toContain(
      'portal.provider_usage.refresh',
    );
  });
});

describe('workspace clone handoff contracts', () => {
  it('shortens only workspace-create result waits and defines a thirty-minute execution deadline', () => {
    PORTAL_LONG_RPC_COMMAND_TYPES.forEach((type) => {
      expect(portalLongRpcResultWaitMs(type)).toBe(
        type === 'portal.workspace.create'
          ? 1_000
          : PORTAL_LONG_RPC_RESULT_TIMEOUT_MS,
      );
    });
    expect(PORTAL_WORKSPACE_CREATE_EXPIRATION_MS).toBe(30 * 60_000);
  });

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

it('registers the additive worktree branch catalog as a small RPC', () => {
  expect(PORTAL_COMMAND_TYPES).toContain('portal.worktree.branches.list');
  expect(
    PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.worktree.branches.list'),
  ).toBe(true);
});

describe('standalone Work Entry archive contract', () => {
  it('returns the archived Work Entry list through the read-only small RPC tier', () => {
    const command = 'portal.workspace.archived_work_entries.list';
    expect(PORTAL_COMMAND_TYPES_SET.has(command)).toBe(true);
    expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has(command)).toBe(true);
    expect(PORTAL_LONG_RPC_COMMAND_TYPES.has(command)).toBe(false);
    expect(PORTAL_DESTRUCTIVE_COMMAND_TYPES.has(command)).toBe(false);
  });

  it('registers archive as a gated command whose ID returns at acceptance', () => {
    const command = 'portal.standalone_chat.archive';
    expect(PORTAL_COMMAND_TYPES_SET.has(command)).toBe(true);
    expect([...PORTAL_DESTRUCTIVE_COMMAND_TYPES]).toContain(command);
    // Neither wait tier holds the submit open: the browser follows the
    // command's delivery and completion events instead.
    expect([...PORTAL_LONG_RPC_COMMAND_TYPES]).not.toContain(command);
    expect([...PORTAL_SMALL_RPC_COMMAND_TYPES]).not.toContain(command);
  });
});

// CAN-4847: updates have their own admission and long-running command contract.
it('registers collection update as an operation-specific long RPC', () => {
  expect(PORTAL_COMMAND_TYPES_SET.has('portal.collections.apply_update')).toBe(
    true,
  );
  expect([...PORTAL_LONG_RPC_COMMAND_TYPES]).toContain(
    'portal.collections.apply_update',
  );
  expect([...PORTAL_SMALL_RPC_COMMAND_TYPES]).not.toContain(
    'portal.collections.apply_update',
  );
  expect(
    Reflect.get(portalContract, 'PORTAL_CAPABILITY_COLLECTION_UPDATES'),
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
    ): ReturnType<typeof parsePortalWatcher> =>
      parsePortalWatcher({
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
