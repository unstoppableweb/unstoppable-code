import { handlePortalWatcherDelete } from './adapters/watchers-adapter';
import {
  handlePortalLifecycleJournalInspect,
  handlePortalLifecycleJournalQuarantine,
} from './adapters/lifecycle-journal-adapter';
import { handlePortalSharedMultiRepo } from './adapters/shared-multi-repo-adapter';
import { createPortalScriptActionsAdapter } from './adapters/script-actions-adapter';
import { handlePortalPersonalOrganizationProjects } from './adapters/personal-organization-upgrade-adapter';
import { handlePortalInstalledItems } from './adapters/installed-items-adapter';
import {
  handlePortalSidebarItemGroups,
  handlePortalSidebarItemGroupsAssignNamed,
} from './adapters/sidebar-item-groups-adapter';
import { handlePortalOrgProjectsFindRepositoryOwner } from './adapters/org-projects-adapter';
import {
  handlePortalWorkspaceItemsListNotes,
  handlePortalWorkspaceItemsReadNote,
  handlePortalWorkspaceItemsListPrompts,
  handlePortalWorkspaceItemsReadPrompt,
  handlePortalWorkspaceItemsListAttachments,
} from './adapters/workspace-items-adapter';
import {
  handlePortalChatMarkRead,
  handlePortalChatSetUnread,
} from './adapters/chat-read-adapter';
import { handlePortalChatVisualRead } from './adapters/chat-visual-adapter';
import { handlePortalProviderUsageRefresh } from './adapters/provider-usage-adapter';
import { timingSafeEqual } from 'node:crypto';
import { isModelLibraryContext } from '@canopy/protocol/models';
import type { BrowserWindow } from 'electron';
import type {
  PortalAuthValidateCodePayload,
  PortalCommandEnvelope,
  PortalEventEnvelope,
  PortalCommandType,
  PortalStateRequestPayload,
} from '@canopy/desktop-shared/types';
import { PORTAL_SNAPSHOT_SCOPES_SET } from '@canopy/desktop-shared/types';
import {
  PORTAL_EVENT_BATCH_MAX_BYTES,
  type PortalChangedFilesPageResult,
} from '@canopy/protocol/portal';
import {
  handlePortalTerminalClose,
  handlePortalTerminalOpen,
  handlePortalTerminalResize,
  handlePortalTerminalWrite,
} from './adapters/terminal-adapter';
import {
  handlePortalChatAnswerQuestion,
  handlePortalChatCancel,
  handlePortalChatCancelTurn,
  handlePortalChatCloseTab,
  handlePortalChatFork,
  handlePortalChatBranch,
  handlePortalChatShare,
  handlePortalChatCreateTab,
  handlePortalChatDismissQuestion,
  handlePortalChatListPluginCatalog,
  handlePortalChatQueueCancel,
  handlePortalChatQueueEdit,
  handlePortalChatQueueForce,
  handlePortalChatQueueSteer,
  handlePortalChatInputDelivery,
  handlePortalChatQueueSetEditLock,
  handlePortalChatSend,
  handlePortalChatSetFastMode,
  handlePortalChatSetModel,
  handlePortalChatSetPlanMode,
  handlePortalChatSetPluginSelections,
  handlePortalChatSetThinkingLevel,
} from './adapters/chat-adapter';
import {
  handlePortalStandaloneChatCancel,
  handlePortalStandaloneChatArchive,
  handlePortalArchivedWorkEntriesList,
  handlePortalStandaloneChatCreate,
  handlePortalStandaloneChatSend,
  handlePortalStandaloneChatSetModel,
  handlePortalStandaloneChatSetPluginSelections,
} from './adapters/standalone-chat-adapter';
import {
  handlePortalAppAdvisorAnswerQuestion,
  handlePortalAppAdvisorCancel,
  handlePortalAppAdvisorCreateTab,
  handlePortalAppAdvisorDismissQuestion,
  handlePortalAppAdvisorSettingsGet,
  handlePortalAppAdvisorSettingsSave,
  handlePortalAppAdvisorSend,
  handlePortalAppAdvisorSetModel,
} from './adapters/app-advisor-adapter';
import {
  handlePortalSuggestionsGet,
  handlePortalSuggestionsUpdate,
} from './adapters/suggestions-adapter';
import {
  handlePortalOnboardingTipsGet,
  handlePortalOnboardingTipsUpdate,
} from './adapters/onboarding-tips-adapter';
import {
  handlePortalClaudeModsGet,
  handlePortalClaudeModsUpdate,
} from './adapters/claude-mods-adapter';
import {
  handlePortalScriptCancel,
  handlePortalScriptLogRequest,
  handlePortalScriptRun,
  handlePortalScriptSourceInfo,
} from './adapters/scripts-adapter';
import {
  handlePortalHookCancel,
  handlePortalHookPause,
  handlePortalHookRun,
  handlePortalHookSourceInfo,
} from './adapters/hooks-adapter';
import {
  handlePortalPlanCreate,
  handlePortalPlanDelete,
  handlePortalPlanGet,
  handlePortalPlanList,
  handlePortalPlanOpen,
  handlePortalPlanUpdate,
} from './adapters/plans-adapter';
import {
  handlePortalPipelineCancel,
  handlePortalPipelineExecutionGet,
  handlePortalPipelineExecutionList,
  handlePortalPipelineGet,
  handlePortalPipelineShare,
  handlePortalPipelineChatFollowUpPrepare,
  handlePortalPipelineContentRead,
  handlePortalPipelineInstallCurated,
  handlePortalPipelineList,
  handlePortalPipelineLogRequest,
  handlePortalPipelineRerun,
  handlePortalPipelineResume,
  handlePortalPipelineRetry,
  handlePortalPipelineRun,
} from './adapters/pipelines-adapter';
import {
  handlePortalFileDirectory,
  handlePortalFilePreview,
  handlePortalFileRead,
  handlePortalFileResolveLink,
  handlePortalFileRoots,
  handlePortalFileSave,
} from './adapters/files-adapter';
import {
  handlePortalEditorListFileMentions,
  handlePortalEditorListInvocables,
  handlePortalEditorListSlashCommands,
  handlePortalEditorResolveInvocable,
} from './adapters/editor-adapter';
import { handlePortalDiffRead } from './adapters/diff-adapter';
import {
  handlePortalChatAssetRead,
  handlePortalFileAssetRead,
} from './adapters/chat-assets-adapter';
import {
  handlePortalPrAction,
  handlePortalPrCreate,
  handlePortalPrRefresh,
} from './adapters/pr-adapter';
import { handlePortalSummaryRefresh } from './adapters/summary-adapter';
import {
  handlePortalSetSectionOrder,
  handlePortalSetViewMode,
} from './adapters/session-adapter';
import {
  handlePortalWorktreeBranchesList,
  handlePortalWorktreeArchive,
  handlePortalWorktreeCreate,
  handlePortalWorktreeDiscard,
  handlePortalWorktreeDiscardDescribe,
  handlePortalWorktreeReorder,
  handlePortalWorktreeUpdate,
} from './adapters/worktree-adapter';
import {
  handlePortalWorkEntryDelete,
  handlePortalWorkEntryUpdate,
} from './adapters/work-entry-adapter';
import { handlePortalTaskRefsList } from './adapters/task-refs-adapter';
import {
  handlePortalCollectionsGet,
  handlePortalCollectionsList,
  handlePortalMarketplaceAdd,
  handlePortalMarketplaceRefreshAll,
  handlePortalMarketplaceRemove,
  handlePortalMarketplaceUpdate,
  handlePortalMcpGetServer,
  handlePortalMcpTestConnection,
  handlePortalMcpDeleteServer,
  handlePortalMcpListServers,
  handlePortalMcpSetConfigEnabled,
  handlePortalCollectionsSave,
  handlePortalCollectionsApplyUpdate,
  handlePortalPluginsGetPluginDetail,
  handlePortalPluginsInstallBuiltin,
  handlePortalPluginsSharePlugin,
  handlePortalPluginsInstallExternal,
  handlePortalPluginsListMarketplaces,
  handlePortalPluginsReadComponentContent,
  handlePortalSkillsList,
  handlePortalSkillsRead,
  handlePortalSkillsShareSkill,
  handlePortalCollectionsShare,
  handlePortalSharingListOrganizations,
  handlePortalSharingAccount,
  handlePortalSharingExistingShare,
  handlePortalSharingListTeams,
} from './adapters/plugin-catalog-adapter';
import {
  handlePortalWorkspaceClaudeMdGet,
  handlePortalWorkspaceClaudeMdSave,
  handlePortalWorkspaceCreate,
  handlePortalWorkspaceDelete,
  handlePortalWorkspaceDeleteDiscardDescribe,
  handlePortalWorkspaceReorder,
  handlePortalWorkspaceScriptsGet,
  handlePortalWorkspaceScriptsSave,
  handlePortalWorkspaceUpdate,
} from './adapters/workspace-adapter';
import type {
  PortalAdapterContext,
  PortalCommandAdapter,
} from './adapters/types';
import { queryPortalChatSendReceipt } from './adapters/chat-state-query';
import {
  handlePortalChatTranscriptPage,
  handlePortalChatTranscriptBlocksPage,
  handlePortalChatContentRead,
} from './adapters/chat-transcript-reads-adapter';
import { buildPortalSnapshot } from './portal-snapshot-builders';
import { acquirePortalOverviewSnapshot } from './portal-overview-build';
import {
  MAX_CHANGED_FILES_PAGE_SIZE,
  pageChangedFiles,
  sortChangedFiles,
} from './changed-files-paging';
import { listChangedFileSets } from '../services/diff-service';
import { portalEventMaxRoutedByteLength } from './portal-outbox';
import { validateId } from '../lib/validation';
import {
  armWorktreeDiffStatsRefreshTimer,
  createCommandCompletedPayload,
  createCommandFailedPayload,
  createPortalCommandEvent,
  recordPublishedWorktreeDiffStats,
  getPortalModelCatalogRevision,
} from './portal-event-bus';
import { performance } from 'node:perf_hooks';
import { validatePortalCommandProvenance } from './portal-command-provenance';
import {
  elapsedMilliseconds,
  recordPortalSnapshotTiming,
} from './portal-performance-diagnostics';
import { getChatStateCommandPort } from '../ipc/chat-state';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../canopy-runtime/core-chat-command-adapter';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import {
  requestAllWorktreeDiffStatsRefresh,
  requestWorkspaceWorktreeDiffStatsRefresh,
  warmWorktreeDiffStats,
} from '../services/worktree-diff-stats-cache';

export interface PortalCommandHandlerContext {
  sessionId?: string | null;
  chatDispatcher?: DesktopCanopyDispatcher;
  /** Trusted active paired-session authority; asset-read access is insufficient. */
  canArchiveStandaloneChats?: () => boolean;
  confirmArchivePairing?: () => Promise<boolean>;
  canReadAssets?: () => boolean;
  canMutateResources?: () => boolean;
  canReadTranscripts?: () => boolean;
  pairingCode: string | null;
  getWindow: () => BrowserWindow | null;
  enqueueEvent: (event: PortalEventEnvelope) => void;
  markAuthenticated: () => void;
  recordStateRequestTarget?: (request: PortalStateRequestPayload) => void;
  stop: (
    reason?: 'local_disconnect' | 'replaced' | 'app_shutdown',
  ) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeChangedFilesPage(
  value: unknown,
): PortalStateRequestPayload['changedFilesPage'] {
  if (
    !isRecord(value) ||
    (value.group !== 'uncommitted' && value.group !== 'committed') ||
    typeof value.cursor !== 'string' ||
    value.cursor.length > 512
  ) {
    return undefined;
  }
  const limit = value.limit;
  if (
    limit !== undefined &&
    (typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_CHANGED_FILES_PAGE_SIZE)
  ) {
    return undefined;
  }
  return {
    group: value.group,
    cursor: value.cursor,
    ...(limit === undefined ? {} : { limit }),
  };
}

function hasChangedFilesPageField(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    Object.prototype.hasOwnProperty.call(payload, 'changedFilesPage')
  );
}

function isValidChangedFilesPageRequest(
  payload: unknown,
  request: PortalStateRequestPayload,
): boolean {
  if (!hasChangedFilesPageField(payload) && !request.changedFilesPage)
    return true;
  const target = request.target;
  if (
    !request.changedFilesPage ||
    request.scope !== 'diff' ||
    typeof target?.workspaceLocalId !== 'string' ||
    typeof target.worktreeLocalId !== 'string'
  ) {
    return false;
  }
  try {
    validateId(target.workspaceLocalId, 'workspaceId');
    validateId(target.worktreeLocalId, 'worktreeId');
  } catch {
    return false;
  }
  return true;
}

function normalizeValidatePayload(
  payload: unknown,
): PortalAuthValidateCodePayload | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload.code !== 'string' ||
    typeof payload.attemptExternalId !== 'string'
  ) {
    return null;
  }
  return {
    code: payload.code,
    attemptExternalId: payload.attemptExternalId,
  };
}

export function normalizeStateRequestPayload(
  payload: unknown,
  fallbackTarget?: unknown,
): PortalStateRequestPayload {
  const target = isRecord(payload)
    ? isRecord(payload.target)
      ? payload.target
      : isRecord(fallbackTarget)
        ? fallbackTarget
        : undefined
    : isRecord(fallbackTarget)
      ? fallbackTarget
      : undefined;
  if (!isRecord(payload)) {
    return {
      scope: inferStateRequestScope(target),
      ...(target ? { target } : {}),
    };
  }
  const scope =
    typeof payload.scope === 'string'
      ? payload.scope
      : inferStateRequestScope(target);
  const changedFilesPage = normalizeChangedFilesPage(payload.changedFilesPage);
  return {
    scope: isPortalStateScope(scope) ? scope : 'overview',
    ...(payload.includeChatSummaries === true
      ? { includeChatSummaries: true }
      : {}),
    ...(scope === 'chat' && payload.selectedChatOnly === true
      ? { selectedChatOnly: true }
      : {}),
    ...(changedFilesPage ? { changedFilesPage } : {}),
    ...(target ? { target } : {}),
    ...(typeof payload.refresh === 'boolean'
      ? { refresh: payload.refresh }
      : {}),
  };
}

function inferStateRequestScope(
  target?: Record<string, unknown>,
): PortalStateRequestPayload['scope'] {
  if (!target) {
    return 'overview';
  }
  if (typeof target.worktreeLocalId === 'string') {
    return 'worktree';
  }
  if (typeof target.standaloneChatLocalId === 'string') {
    return 'standalone_chat';
  }
  if (typeof target.workspaceLocalId === 'string') {
    return 'workspace';
  }
  return 'overview';
}

function isPortalStateScope(
  value: string,
): value is PortalStateRequestPayload['scope'] {
  // The protocol's frozen scope set is the single source of truth; a local
  // literal list here silently rejected newly added scopes (they were coerced
  // to 'overview').
  return PORTAL_SNAPSHOT_SCOPES_SET.has(value);
}

function refreshDiffStatsAfterSnapshot(
  request: PortalStateRequestPayload,
): void {
  const workspaceId = request.target?.workspaceLocalId;
  const worktreeId = request.target?.worktreeLocalId;
  if (request.scope === 'worktree' && workspaceId && worktreeId) {
    armWorktreeDiffStatsRefreshTimer();
    void warmWorktreeDiffStats(workspaceId, worktreeId);
    return;
  }
  if (request.scope === 'workspace' && workspaceId) {
    armWorktreeDiffStatsRefreshTimer();
    void requestWorkspaceWorktreeDiffStatsRefresh(workspaceId);
    return;
  }
  if (request.scope === 'overview' && !workspaceId && !worktreeId) {
    armWorktreeDiffStatsRefreshTimer();
    void requestAllWorktreeDiffStatsRefresh();
  }
}

async function readChangedFilesPageResult(
  command: PortalCommandEnvelope,
  request: PortalStateRequestPayload,
): Promise<PortalChangedFilesPageResult | undefined> {
  const pageRequest = request.changedFilesPage;
  const workspaceLocalId = request.target?.workspaceLocalId;
  const worktreeLocalId = request.target?.worktreeLocalId;
  if (!pageRequest || !workspaceLocalId || !worktreeLocalId) return undefined;

  const listed = await listChangedFileSets(workspaceLocalId, worktreeLocalId);
  const groups = {
    uncommitted: sortChangedFiles(listed.uncommitted),
    committed: sortChangedFiles(listed.committed),
  };
  return pageChangedFiles(
    groups,
    {
      workspaceLocalId,
      worktreeLocalId,
      group: pageRequest.group,
      cursor: pageRequest.cursor,
      ...(pageRequest.limit === undefined ? {} : { limit: pageRequest.limit }),
    },
    (candidate: PortalChangedFilesPageResult) => {
      const event = createPortalCommandEvent(
        command,
        'portal.command.completed',
        createCommandCompletedPayload(command, candidate),
      );
      return (
        portalEventMaxRoutedByteLength(event) <=
        PORTAL_EVENT_BATCH_MAX_BYTES - 4096
      );
    },
  );
}

function constantTimeCodeEquals(
  left: string | null,
  right: string | null,
): boolean {
  if (!left || !right || left.length !== 6 || right.length !== 6) {
    return false;
  }

  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

const FEATURE_ADAPTERS: Partial<
  Record<PortalCommandType, PortalCommandAdapter<unknown>>
> = {
  'portal.watcher.delete': handlePortalWatcherDelete,
  'portal.lifecycle_journal.inspect': handlePortalLifecycleJournalInspect,
  'portal.lifecycle_journal.quarantine': handlePortalLifecycleJournalQuarantine,
  'portal.script_actions.list': createPortalScriptActionsAdapter('list'),
  'portal.script_actions.rescan': createPortalScriptActionsAdapter('rescan'),
  'portal.script_actions.review': createPortalScriptActionsAdapter('review'),
  'portal.script_actions.set_shortcut':
    createPortalScriptActionsAdapter('setShortcut'),
  'portal.script_actions.set_pinned':
    createPortalScriptActionsAdapter('setPinned'),
  'portal.script_actions.enable_shell_alias_scan':
    createPortalScriptActionsAdapter('enableShellAliasScan'),
  'portal.script_actions.receipt': createPortalScriptActionsAdapter('receipt'),
  'portal.terminal.open':
    handlePortalTerminalOpen as PortalCommandAdapter<unknown>,
  'portal.terminal.write':
    handlePortalTerminalWrite as PortalCommandAdapter<unknown>,
  'portal.terminal.resize':
    handlePortalTerminalResize as PortalCommandAdapter<unknown>,
  'portal.terminal.close':
    handlePortalTerminalClose as PortalCommandAdapter<unknown>,
  'portal.sidebar.item_groups.list': handlePortalSidebarItemGroups,
  'portal.sidebar.item_groups.create': handlePortalSidebarItemGroups,
  'portal.sidebar.item_groups.update': handlePortalSidebarItemGroups,
  'portal.sidebar.item_groups.ungroup': handlePortalSidebarItemGroups,
  'portal.sidebar.item_groups.move_item': handlePortalSidebarItemGroups,
  'portal.sidebar.item_groups.move_group': handlePortalSidebarItemGroups,
  'portal.sidebar.item_groups.assign_named':
    handlePortalSidebarItemGroupsAssignNamed,
  'portal.chat.send': handlePortalChatSend as PortalCommandAdapter<unknown>,
  'portal.chat.mark_read': handlePortalChatMarkRead,
  'portal.chat.set_unread': handlePortalChatSetUnread,
  'portal.chat.visual.read': handlePortalChatVisualRead,
  'portal.chat.cancel': handlePortalChatCancel as PortalCommandAdapter<unknown>,
  'portal.chat.cancel_turn': handlePortalChatCancelTurn,
  'portal.chat.queue.cancel':
    handlePortalChatQueueCancel as PortalCommandAdapter<unknown>,
  'portal.chat.queue.edit':
    handlePortalChatQueueEdit as PortalCommandAdapter<unknown>,
  'portal.chat.queue.force':
    handlePortalChatQueueForce as PortalCommandAdapter<unknown>,
  'portal.chat.queue.steer': handlePortalChatQueueSteer,
  'portal.chat.input_delivery': handlePortalChatInputDelivery,
  'portal.chat.queue.set_edit_lock':
    handlePortalChatQueueSetEditLock as PortalCommandAdapter<unknown>,
  'portal.chat.set_model':
    handlePortalChatSetModel as PortalCommandAdapter<unknown>,
  'portal.chat.set_thinking_level':
    handlePortalChatSetThinkingLevel as PortalCommandAdapter<unknown>,
  'portal.chat.set_plan_mode':
    handlePortalChatSetPlanMode as PortalCommandAdapter<unknown>,
  'portal.chat.set_fast_mode':
    handlePortalChatSetFastMode as PortalCommandAdapter<unknown>,
  'portal.chat.set_plugin_selections':
    handlePortalChatSetPluginSelections as PortalCommandAdapter<unknown>,
  'portal.chat.list_plugin_catalog':
    handlePortalChatListPluginCatalog as PortalCommandAdapter<unknown>,
  'portal.chat.create_tab':
    handlePortalChatCreateTab as PortalCommandAdapter<unknown>,
  'portal.chat.close_tab':
    handlePortalChatCloseTab as PortalCommandAdapter<unknown>,
  // No cast: these two handlers are typed at the unknown boundary already.
  'portal.chat.fork': handlePortalChatFork,
  'portal.chat.branch': handlePortalChatBranch,
  'portal.chat.share': handlePortalChatShare,
  'portal.chat.answer_question':
    handlePortalChatAnswerQuestion as PortalCommandAdapter<unknown>,
  'portal.chat.dismiss_question':
    handlePortalChatDismissQuestion as PortalCommandAdapter<unknown>,
  // `portal.app_advisor.close_tab` is intentionally UNREGISTERED (falls
  // through to unsupported_command): main has no renderer surface to evict a
  // tab from the App Advisor window's store, so a host-side close would be
  // resurrected by the renderer's next whole-file tab save.
  'portal.app_advisor.send':
    handlePortalAppAdvisorSend as PortalCommandAdapter<unknown>,
  'portal.app_advisor.cancel':
    handlePortalAppAdvisorCancel as PortalCommandAdapter<unknown>,
  'portal.app_advisor.set_model': handlePortalAppAdvisorSetModel,
  'portal.app_advisor.create_tab':
    handlePortalAppAdvisorCreateTab as PortalCommandAdapter<unknown>,
  'portal.app_advisor.answer_question':
    handlePortalAppAdvisorAnswerQuestion as PortalCommandAdapter<unknown>,
  'portal.app_advisor.dismiss_question':
    handlePortalAppAdvisorDismissQuestion as PortalCommandAdapter<unknown>,
  'portal.app_advisor.settings.get':
    handlePortalAppAdvisorSettingsGet as PortalCommandAdapter<unknown>,
  'portal.app_advisor.settings.save':
    handlePortalAppAdvisorSettingsSave as PortalCommandAdapter<unknown>,
  'portal.suggestions.get': handlePortalSuggestionsGet,
  'portal.suggestions.update': handlePortalSuggestionsUpdate,
  'portal.onboarding_tips.get': handlePortalOnboardingTipsGet,
  'portal.onboarding_tips.update': handlePortalOnboardingTipsUpdate,
  'portal.claude_mods.get': handlePortalClaudeModsGet,
  'portal.claude_mods.update': handlePortalClaudeModsUpdate,
  // The census handler span below stays as on develop until the Portal
  // standalone chat slice moves it (CAN-3745); TypeScript 7 no longer needs
  // its cast.
  /* oxlint-disable typescript/no-unnecessary-type-assertion */
  'portal.standalone_chat.send':
    handlePortalStandaloneChatSend as PortalCommandAdapter<unknown>,
  /* oxlint-enable typescript/no-unnecessary-type-assertion */
  'portal.standalone_chat.archive': handlePortalStandaloneChatArchive,
  'portal.workspace.archived_work_entries.list':
    handlePortalArchivedWorkEntriesList,
  'portal.standalone_chat.create': handlePortalStandaloneChatCreate,
  'portal.standalone_chat.cancel':
    handlePortalStandaloneChatCancel as PortalCommandAdapter<unknown>,
  'portal.standalone_chat.set_model':
    handlePortalStandaloneChatSetModel as PortalCommandAdapter<unknown>,
  'portal.standalone_chat.set_plugin_selections':
    handlePortalStandaloneChatSetPluginSelections,
  'portal.script.run': handlePortalScriptRun as PortalCommandAdapter<unknown>,
  'portal.script.cancel':
    handlePortalScriptCancel as PortalCommandAdapter<unknown>,
  'portal.script.source_info':
    handlePortalScriptSourceInfo as PortalCommandAdapter<unknown>,
  'portal.script.log_request':
    handlePortalScriptLogRequest as PortalCommandAdapter<unknown>,
  'portal.hook.run': handlePortalHookRun as PortalCommandAdapter<unknown>,
  'portal.hook.cancel': handlePortalHookCancel as PortalCommandAdapter<unknown>,
  'portal.hook.pause': handlePortalHookPause as PortalCommandAdapter<unknown>,
  'portal.hook.resume': handlePortalHookPause as PortalCommandAdapter<unknown>,
  'portal.hook.source_info':
    handlePortalHookSourceInfo as PortalCommandAdapter<unknown>,
  'portal.plan.list': handlePortalPlanList as PortalCommandAdapter<unknown>,
  'portal.plan.get': handlePortalPlanGet as PortalCommandAdapter<unknown>,
  'portal.plan.create': handlePortalPlanCreate as PortalCommandAdapter<unknown>,
  'portal.plan.update': handlePortalPlanUpdate as PortalCommandAdapter<unknown>,
  'portal.plan.delete': handlePortalPlanDelete as PortalCommandAdapter<unknown>,
  'portal.plan.open': handlePortalPlanOpen as PortalCommandAdapter<unknown>,
  'portal.workspace_items.list_notes':
    handlePortalWorkspaceItemsListNotes as PortalCommandAdapter<unknown>,
  'portal.workspace_items.read_note':
    handlePortalWorkspaceItemsReadNote as PortalCommandAdapter<unknown>,
  'portal.workspace_items.list_prompts':
    handlePortalWorkspaceItemsListPrompts as PortalCommandAdapter<unknown>,
  'portal.workspace_items.read_prompt':
    handlePortalWorkspaceItemsReadPrompt as PortalCommandAdapter<unknown>,
  'portal.workspace_items.list_attachments':
    handlePortalWorkspaceItemsListAttachments as PortalCommandAdapter<unknown>,
  'portal.pipeline.list':
    handlePortalPipelineList as PortalCommandAdapter<unknown>,
  'portal.pipeline.get': handlePortalPipelineGet,
  'portal.pipeline.share': handlePortalPipelineShare,
  'portal.pipeline.install_curated': handlePortalPipelineInstallCurated,
  'portal.pipeline.run':
    handlePortalPipelineRun as PortalCommandAdapter<unknown>,
  'portal.pipeline.cancel':
    handlePortalPipelineCancel as PortalCommandAdapter<unknown>,
  'portal.pipeline.execution.get':
    handlePortalPipelineExecutionGet as PortalCommandAdapter<unknown>,
  'portal.pipeline.execution_list':
    handlePortalPipelineExecutionList as PortalCommandAdapter<unknown>,
  'portal.pipeline.resume':
    handlePortalPipelineResume as PortalCommandAdapter<unknown>,
  'portal.pipeline.retry':
    handlePortalPipelineRetry as PortalCommandAdapter<unknown>,
  'portal.pipeline.rerun':
    handlePortalPipelineRerun as PortalCommandAdapter<unknown>,
  'portal.pipeline.log_request':
    handlePortalPipelineLogRequest as PortalCommandAdapter<unknown>,
  'portal.pipeline.chat_follow_up.prepare':
    handlePortalPipelineChatFollowUpPrepare,
  'portal.pipeline.content.read': handlePortalPipelineContentRead,
  'portal.diff.read': handlePortalDiffRead as PortalCommandAdapter<unknown>,
  'portal.pr.action': handlePortalPrAction as PortalCommandAdapter<unknown>,
  'portal.pr.refresh': handlePortalPrRefresh as PortalCommandAdapter<unknown>,
  'portal.summary.refresh':
    handlePortalSummaryRefresh as PortalCommandAdapter<unknown>,
  'portal.pr.create': handlePortalPrCreate as PortalCommandAdapter<unknown>,
  'portal.file.roots': handlePortalFileRoots as PortalCommandAdapter<unknown>,
  'portal.file.resolve_link':
    handlePortalFileResolveLink as PortalCommandAdapter<unknown>,
  'portal.file.directory':
    handlePortalFileDirectory as PortalCommandAdapter<unknown>,
  'portal.file.preview':
    handlePortalFilePreview as PortalCommandAdapter<unknown>,
  'portal.file.read': handlePortalFileRead as PortalCommandAdapter<unknown>,
  'portal.chat.asset.read': handlePortalChatAssetRead,
  'portal.chat.transcript.page': handlePortalChatTranscriptPage,
  'portal.chat.transcript.blocks.page': handlePortalChatTranscriptBlocksPage,
  'portal.chat.content.read': handlePortalChatContentRead,
  'portal.file.asset.read': handlePortalFileAssetRead,
  'portal.file.save': handlePortalFileSave as PortalCommandAdapter<unknown>,
  'portal.editor.list_slash_commands':
    handlePortalEditorListSlashCommands as PortalCommandAdapter<unknown>,
  'portal.editor.list_file_mentions':
    handlePortalEditorListFileMentions as PortalCommandAdapter<unknown>,
  'portal.editor.list_invocables': handlePortalEditorListInvocables,
  'portal.editor.resolve_invocable': handlePortalEditorResolveInvocable,
  'portal.session.set_view_mode':
    handlePortalSetViewMode as PortalCommandAdapter<unknown>,
  'portal.workspace.set_section_order':
    handlePortalSetSectionOrder as PortalCommandAdapter<unknown>,
  'portal.workspace.reorder': handlePortalWorkspaceReorder,
  'portal.org_projects.shared_multi_repo': handlePortalSharedMultiRepo,
  'portal.org_projects.find_repository_owner':
    handlePortalOrgProjectsFindRepositoryOwner,
  'portal.personal_organization.projects.list':
    handlePortalPersonalOrganizationProjects,
  'portal.personal_organization.projects.convert':
    handlePortalPersonalOrganizationProjects,
  'portal.personal_organization.projects.status':
    handlePortalPersonalOrganizationProjects,
  'portal.worktree.branches.list': handlePortalWorktreeBranchesList,
  'portal.worktree.create':
    handlePortalWorktreeCreate as PortalCommandAdapter<unknown>,
  'portal.worktree.archive':
    handlePortalWorktreeArchive as PortalCommandAdapter<unknown>,
  'portal.worktree.discard.describe': handlePortalWorktreeDiscardDescribe,
  'portal.worktree.discard': handlePortalWorktreeDiscard,
  'portal.worktree.update': handlePortalWorktreeUpdate,
  'portal.work_entry.update': handlePortalWorkEntryUpdate,
  'portal.work_entry.delete': handlePortalWorkEntryDelete,
  'portal.task_refs.list': handlePortalTaskRefsList,
  'portal.worktree.reorder': handlePortalWorktreeReorder,
  'portal.workspace.create':
    handlePortalWorkspaceCreate as PortalCommandAdapter<unknown>,
  'portal.workspace.delete':
    handlePortalWorkspaceDelete as PortalCommandAdapter<unknown>,
  'portal.workspace.delete.discard.describe':
    handlePortalWorkspaceDeleteDiscardDescribe,
  'portal.workspace.update':
    handlePortalWorkspaceUpdate as PortalCommandAdapter<unknown>,
  'portal.workspace.claude_md.get':
    handlePortalWorkspaceClaudeMdGet as PortalCommandAdapter<unknown>,
  'portal.workspace.claude_md.save':
    handlePortalWorkspaceClaudeMdSave as PortalCommandAdapter<unknown>,
  'portal.workspace.scripts.get':
    handlePortalWorkspaceScriptsGet as PortalCommandAdapter<unknown>,
  'portal.workspace.scripts.save':
    handlePortalWorkspaceScriptsSave as PortalCommandAdapter<unknown>,
  'portal.plugins.list_marketplaces':
    handlePortalPluginsListMarketplaces as PortalCommandAdapter<unknown>,
  'portal.plugins.get_plugin_detail':
    handlePortalPluginsGetPluginDetail as PortalCommandAdapter<unknown>,
  'portal.plugins.read_component_content':
    handlePortalPluginsReadComponentContent as PortalCommandAdapter<unknown>,
  'portal.plugins.share_plugin': handlePortalPluginsSharePlugin,
  'portal.plugins.install_builtin':
    handlePortalPluginsInstallBuiltin as PortalCommandAdapter<unknown>,
  'portal.plugins.install_external':
    handlePortalPluginsInstallExternal as PortalCommandAdapter<unknown>,
  'portal.marketplace.add':
    handlePortalMarketplaceAdd as PortalCommandAdapter<unknown>,
  'portal.marketplace.update':
    handlePortalMarketplaceUpdate as PortalCommandAdapter<unknown>,
  'portal.marketplace.remove':
    handlePortalMarketplaceRemove as PortalCommandAdapter<unknown>,
  'portal.marketplace.refresh_all':
    handlePortalMarketplaceRefreshAll as PortalCommandAdapter<unknown>,
  'portal.mcp.set_config_enabled':
    handlePortalMcpSetConfigEnabled as PortalCommandAdapter<unknown>,
  'portal.installed_items.list_status': handlePortalInstalledItems,
  'portal.installed_items.set_status': handlePortalInstalledItems,
  'portal.installed_items.uninstall': handlePortalInstalledItems,
  'portal.skills.list': handlePortalSkillsList as PortalCommandAdapter<unknown>,
  'portal.skills.read': handlePortalSkillsRead as PortalCommandAdapter<unknown>,
  'portal.skills.share_skill': handlePortalSkillsShareSkill,
  'portal.collections.share': handlePortalCollectionsShare,
  'portal.sharing.account': handlePortalSharingAccount,
  'portal.sharing.existing_share': handlePortalSharingExistingShare,
  'portal.sharing.list_teams': handlePortalSharingListTeams,
  'portal.sharing.list_organizations': handlePortalSharingListOrganizations,
  'portal.mcp.list_servers':
    handlePortalMcpListServers as PortalCommandAdapter<unknown>,
  'portal.mcp.test_connection': handlePortalMcpTestConnection,
  'portal.mcp.delete_server': handlePortalMcpDeleteServer,
  'portal.mcp.get_server':
    handlePortalMcpGetServer as PortalCommandAdapter<unknown>,
  'portal.collections.list':
    handlePortalCollectionsList as PortalCommandAdapter<unknown>,
  'portal.collections.get':
    handlePortalCollectionsGet as PortalCommandAdapter<unknown>,
  'portal.collections.save': handlePortalCollectionsSave,
  'portal.collections.apply_update': handlePortalCollectionsApplyUpdate,
  'portal.provider_usage.refresh': handlePortalProviderUsageRefresh,
};

export function setPortalFeatureAdapterForTest(
  type: PortalCommandType,
  adapter: PortalCommandAdapter<unknown> | null,
): () => void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'setPortalFeatureAdapterForTest is only available in tests.',
    );
  }
  const previous = FEATURE_ADAPTERS[type];
  if (adapter) {
    FEATURE_ADAPTERS[type] = adapter;
  } else {
    delete FEATURE_ADAPTERS[type];
  }
  return (): void => {
    if (previous) {
      FEATURE_ADAPTERS[type] = previous;
    } else {
      delete FEATURE_ADAPTERS[type];
    }
  };
}

function createAdapterContext(
  context: PortalCommandHandlerContext,
  origin?: PortalAdapterContext['origin'],
): PortalAdapterContext {
  const chatStatePort = getChatStateCommandPort() ?? undefined;
  const chatDispatcher = context.chatDispatcher;
  const adapter: PortalAdapterContext = {
    sessionId: context.sessionId,
    ...(origin ? { origin } : {}),
    canArchiveStandaloneChats: context.canArchiveStandaloneChats,
    ...(context.confirmArchivePairing
      ? { confirmArchivePairing: context.confirmArchivePairing }
      : {}),
    canReadAssets: context.canReadAssets,
    canMutateResources: context.canMutateResources,
    canReadTranscripts: context.canReadTranscripts,
    chatStatePort,
    ...(chatStatePort && chatDispatcher
      ? {
          dispatchChatCommand: (request, executionOptions) =>
            dispatchTrustedChatCommand(request, {
              ...createChatCommandDispatchOptions(
                chatStatePort,
                chatDispatcher,
                {
                  principalId: 'local-desktop-user',
                  clientInstanceId: 'portal-command',
                  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
                  interfaceKind: 'desktop',
                  grants: ['core.chat.write'],
                },
              ),
              executionOptions,
            }),
        }
      : {}),
    getWindow: context.getWindow,
    enqueueEvent: context.enqueueEvent,
    complete: (command, result): void => {
      context.enqueueEvent(
        createPortalCommandEvent(
          command,
          'portal.command.completed',
          createCommandCompletedPayload(command, result),
        ),
      );
    },
    fail: (command, code, message, retryable = false, details): void => {
      context.enqueueEvent(
        createPortalCommandEvent(
          command,
          'portal.command.failed',
          createCommandFailedPayload(
            command,
            code,
            message,
            retryable,
            details,
          ),
        ),
      );
    },
  };
  if (chatDispatcher) {
    adapter.queryChatSendReceipt = (
      request,
    ): ReturnType<typeof queryPortalChatSendReceipt> =>
      queryPortalChatSendReceipt(adapter, request);
  }
  return adapter;
}

/**
 * The subset of {@link PortalCommandHandlerContext} the state-request
 * execution actually touches. The async snapshot lane (CAN-2360) builds this
 * context off the serial loop — without a `recordStateRequestTarget`, because
 * the session manager already records the target at hand-off time so outbox
 * foreground prioritization does not wait for the build.
 */
export interface PortalStateRequestExecutionContext {
  isCurrent?: () => boolean;
  enqueueEvent: (event: PortalEventEnvelope) => void;
  recordStateRequestTarget?: (request: PortalStateRequestPayload) => void;
  /** `performance.now()` mark taken when the command arrived. */
  receivedAtPerf?: number;
}

/**
 * Execute a `portal.state.request`: build the snapshot and queue the
 * snapshot -> follow-ups -> completed event sequence. Extracted from the
 * command switch so the async snapshot lane can run it off the serial poll
 * loop; the flag-off switch path delegates here unchanged. `request` lets the
 * lane reuse the payload the manager already normalized at hand-off.
 */
export async function executePortalStateRequest(
  command: PortalCommandEnvelope,
  context: PortalStateRequestExecutionContext,
  request?: PortalStateRequestPayload,
): Promise<void> {
  let invalidPageRequest = false;
  try {
    const resolvedRequest =
      request ?? normalizeStateRequestPayload(command.payload, command.target);
    if (!isValidChangedFilesPageRequest(command.payload, resolvedRequest)) {
      invalidPageRequest = true;
      throw new Error('Invalid changed-files page request');
    }
    context.recordStateRequestTarget?.(resolvedRequest);
    if (context.isCurrent?.() === false) return;
    let completion: unknown;
    if (resolvedRequest.changedFilesPage) {
      // A page answers in the command completion; it publishes no snapshot.
      completion = await readChangedFilesPageResult(command, resolvedRequest);
    } else {
      const buildStartedAt = performance.now();
      recordPortalSnapshotTiming({
        commandId: command.id,
        stage: 'snapshot_build_started',
        scope: resolvedRequest.scope,
        workspaceLocalId: resolvedRequest.target?.workspaceLocalId,
        worktreeLocalId: resolvedRequest.target?.worktreeLocalId,
        chatLocalId:
          resolvedRequest.target?.chatLocalId ??
          resolvedRequest.target?.standaloneChatLocalId,
      });
      const catalogRevision = getPortalModelCatalogRevision();
      const builtSnapshot =
        resolvedRequest.scope === 'overview' &&
        resolvedRequest.includeChatSummaries !== true &&
        Object.keys(resolvedRequest.target ?? {}).length === 0
          ? await acquirePortalOverviewSnapshot(
              context.receivedAtPerf ?? buildStartedAt,
              command.id,
            )
          : await buildPortalSnapshot(resolvedRequest, {
              commandId: command.id,
            });
      if (context.isCurrent?.() === false) return;
      recordPortalSnapshotTiming({
        commandId: command.id,
        stage: 'snapshot_build_completed',
        scope: resolvedRequest.scope,
        workspaceLocalId: resolvedRequest.target?.workspaceLocalId,
        worktreeLocalId: resolvedRequest.target?.worktreeLocalId,
        chatLocalId:
          resolvedRequest.target?.chatLocalId ??
          resolvedRequest.target?.standaloneChatLocalId,
        elapsedMs: elapsedMilliseconds(buildStartedAt),
        entityCount: builtSnapshot.snapshot.entities.length,
      });
      context.enqueueEvent(
        createPortalCommandEvent(
          command,
          'portal.state.snapshot',
          builtSnapshot.snapshot,
        ),
      );
      recordPublishedWorktreeDiffStats(builtSnapshot.snapshot, catalogRevision);
      // Cache population starts only after the frozen snapshot is queued, so
      // a fast fill delta cannot be overwritten by that older snapshot.
      refreshDiffStatsAfterSnapshot(resolvedRequest);
      for (const event of builtSnapshot.followUpEvents) {
        context.enqueueEvent(event);
      }
      // Couple eligibility to this command, rather than a cache another
      // composer or snapshot lane can replace before the browser reads it.
      const contextual = builtSnapshot.snapshot.entities.find((entity) => {
        if (!isRecord(entity.payload)) return false;
        const access = entity.payload.modelLibraryContext;
        return isModelLibraryContext(access) && access.requestId === command.id;
      });
      const modelLibrary =
        contextual && isRecord(contextual.payload)
          ? {
              modelLibraryContext: contextual.payload.modelLibraryContext,
              availableModels: contextual.payload.availableModels,
            }
          : undefined;
      completion = modelLibrary ? { modelLibrary } : undefined;
    }
    context.enqueueEvent(
      createPortalCommandEvent(
        command,
        'portal.command.completed',
        createCommandCompletedPayload(command, completion),
      ),
    );
  } catch {
    context.enqueueEvent(
      createPortalCommandEvent(
        command,
        'portal.command.failed',
        invalidPageRequest
          ? createCommandFailedPayload(
              command,
              'invalid_payload',
              'Portal changed-files page requests require a valid diff target and page cursor.',
              false,
            )
          : createCommandFailedPayload(
              command,
              'execution_failed',
              'Unable to prepare the requested state. Reconnect and try again.',
              false,
            ),
      ),
    );
  }
}

export async function handlePortalCommand(
  command: PortalCommandEnvelope,
  context: PortalCommandHandlerContext,
): Promise<void> {
  const provenance = validatePortalCommandProvenance(command);
  if (!provenance.ok) {
    context.enqueueEvent(
      createPortalCommandEvent(
        command,
        'portal.command.failed',
        createCommandFailedPayload(
          command,
          'invalid_payload',
          'Portal command contains invalid sender provenance.',
          false,
        ),
      ),
    );
    return;
  }
  const origin = provenance.origin;
  switch (command.type) {
    case 'portal.auth.validate_code': {
      const payload = normalizeValidatePayload(command.payload);
      const approved = constantTimeCodeEquals(
        context.pairingCode,
        payload?.code ?? null,
      );

      context.enqueueEvent(
        createPortalCommandEvent(command, 'portal.auth.result', {
          approved,
          attemptExternalId: payload?.attemptExternalId ?? '',
          ...(approved ? {} : { reason: 'code_mismatch' }),
        }),
      );

      if (approved) {
        context.markAuthenticated();
      }
      context.enqueueEvent(
        createPortalCommandEvent(
          command,
          'portal.command.completed',
          createCommandCompletedPayload(command, { approved }),
        ),
      );
      return;
    }
    case 'portal.session.end': {
      const payload = isRecord(command.payload) ? command.payload : {};
      const reason =
        payload.reason === 'replaced' ? 'replaced' : 'local_disconnect';
      context.enqueueEvent(
        createPortalCommandEvent(command, 'portal.session.ended', {
          reason,
        }),
      );
      context.enqueueEvent(
        createPortalCommandEvent(
          command,
          'portal.command.completed',
          createCommandCompletedPayload(command, { reason }),
        ),
      );
      await context.stop(reason);
      return;
    }
    case 'portal.state.request': {
      await executePortalStateRequest(command, context);
      return;
    }
    default: {
      const adapter = FEATURE_ADAPTERS[command.type];
      if (adapter) {
        const adapterContext = createAdapterContext(
          context,
          origin ?? undefined,
        );
        try {
          await adapter(command, adapterContext);
        } catch (error) {
          adapterContext.fail(
            command,
            'execution_failed',
            command.type === 'portal.workspace.create'
              ? 'Could not confirm the clone result on the desktop. Check Projects before trying again.'
              : error instanceof Error
                ? error.message
                : String(error),
            false,
          );
        }
        return;
      }
      context.enqueueEvent(
        createPortalCommandEvent(
          command,
          'portal.command.failed',
          createCommandFailedPayload(
            command,
            'unsupported_command',
            `Unsupported portal command: ${command.type}`,
          ),
        ),
      );
    }
  }
}
