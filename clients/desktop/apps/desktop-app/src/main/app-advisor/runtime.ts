import {
  isTranscriptReadActionType,
  dispatchAdvisorTranscriptRead,
} from './transcript-read-actions';
import type { AppAdvisorDispatchAction } from './definitions';
import { z, ZodError } from 'zod';
import {
  projectMessageControlActionSchema,
  chatSendActionSchema,
  type ChatSendAction,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import {
  dispatchAgentChatSend,
  isAgentChatSendError,
} from '../agent-messaging/send-orchestration';
import { resolveWorkEntryForChat } from '../lib/cowork-work-entries';
import { resolveAuthorizedChat } from '../project-discovery/chat-target';
import { DiscoveryError } from '../project-discovery/errors';
import { pageActiveWatchers } from '@canopy/desktop-shared/lib/app-advisor-watchers';
import {
  isCanonicalChatWatcherTrigger,
  type CanonicalChatWatcherProjection,
  type CanonicalChatWatcherSetupInput,
  type CanonicalChatWatcherSetupResult,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  agentArtifactsForActionResult,
  withAgentArtifacts,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import { isDelegationReadAction } from './delegation-read-actions';
import { isAdvisorDelegationControlAction } from './advisor-delegation-control';
import { isAdvisorPipelineAction } from './advisor-pipeline-actions';
import { isAdvisorCatalogAction } from './advisor-catalog-actions';
import { isAdvisorSharingAction } from './advisor-sharing-actions';
import { isAdvisorAutomationSharingAction } from './advisor-automation-sharing-actions';
import { isAdvisorCollectionSharingAction } from './advisor-collection-sharing-actions';
import { isAdvisorFileTreeAction } from './advisor-file-tree-actions';
import { isAdvisorMemoryAction } from './advisor-memory-actions';
import { isAdvisorRecordsAction } from './advisor-records-actions';
import { isAdvisorSettingsAction } from './advisor-settings-actions';
import { isAdvisorCredentialAction } from './advisor-credential-actions';
import type { AppAdvisorCodeGraphAction } from '@canopy/desktop-shared/types/app-advisor-code-graph';
import type { CanopyInjectedToolKey } from '@canopy/execution-engine/lib/canopy-injected-tools';
import type { AppAdvisorBrowserAction } from '@canopy/desktop-shared/types';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '../lib/paths';
import type { BrowserWindow } from 'electron';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AgentProviderType,
  type ApprovalMode,
  type ApprovalRule,
  type AppAdvisorAction,
  type AppAdvisorActionResponse,
  type AppAdvisorInlineWatcherSetup,
  type AppAdvisorJson,
  type AppAdvisorRendererToolRequest,
  type AppAdvisorUiStateEnvelope,
  type AppAdvisorWatcherTarget,
  type AppAdvisorWatcherDestination,
  type AppAdvisorWindowOpenRequest,
  type AppAdvisorWindowState,
  type ChatTabPluginSelections,
  type McpQuestion,
  type McpQuestionAnswer,
  type OrgRepositoryOwnerLookup,
  type OrgRepositoryOwnerRequest,
  type SearchAppAdvisorWatchersInput,
  type SearchAppAdvisorWatchersResult,
  type SetupAppAdvisorWatchersInput,
  type SetupAppAdvisorWatchersResult,
  type WatchGitHubItemsInput,
  type WatchGitHubItemsResult,
  type ShowFileRequest,
  type ShowFilesRendererResult,
  type ShowFilesWorkspaceTarget,
} from '@canopy/desktop-shared/types';

import { BRAND } from '@canopy/brand/current';
import {
  type CanopyInjectedToolRuntime,
  type GetScriptOutputInput,
  type ReadPipelineYamlInput,
} from '../canopy-tools/core';
import {
  loadWorktreePipelineYaml,
  loadWorktreeScriptOutput,
  getFileCommentsInSession,
  respondToFileCommentInSession,
} from '../canopy-tools/session-runtime';

function isAppAdvisorBrowserAction(
  action: AppAdvisorAction,
): action is AppAdvisorBrowserAction {
  return action.type.startsWith('browser.');
}
import type { ScriptOutputSnapshot } from '../mcp/script-output';
import type { PipelineYamlReadResult } from '../canopy-tools/pipeline-yaml-reader';
import {
  getCachedAppAdvisorUiStateForChat,
  requestAppAdvisorRendererTool,
  takeAppAdvisorAnswerProvenance,
  requestCurrentAppAdvisorUiStateThroughLease,
} from '../ipc/app-advisor';
import { AskUserDismissedError } from '../lib/ask-user-outcomes';
import { isRecord } from '../lib/type-guards';
import {
  dispatchAdvisorWorktreeAction,
  isAdvisorWorktreeAction,
} from './advisor-worktree-actions';
import {
  dispatchAdvisorWorkspaceAction,
  isAdvisorWorkspaceAction,
} from './advisor-workspace-actions';
import {
  dispatchAdvisorChatRead,
  isAdvisorChatReadAction,
} from './advisor-chat-reads';
import {
  dispatchAdvisorChatSetting,
  isAdvisorChatSettingAction,
} from './advisor-chat-settings';
import { withAppAdvisorListUiEnvelope } from './list-ui-envelope';
import { getChatStateService } from '../services/chat-state-service';
import { getPipelineFailureDebugContext } from '../services/pipelines-service';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { getAppAdvisorWatcherService } from './watchers';
import { resolveGitHubRepositoryCandidates } from '../lib/github-repository-context';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import {
  mainWindowOnlyToolSurfaces,
  requestShowFilesThroughInterfaceTool,
} from '../canopy-tools/show-files-runtime';
import {
  boundAppAdvisorInterfaceTools,
  presentAppAdvisorAction,
} from './presentation-tools';
import { getAppAdvisorHomeDir } from '../lib/paths';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import { APP_ADVISOR_ACTION_TEXTS } from './action-router';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { createApprovalSession } from '../approvals/approval-service';
import {
  dispatchAdvisorChatAction,
  isAdvisorChatAction,
} from './advisor-chat-actions';

const CODE_GRAPH_ACTION_TO_TOOL = {
  'code-graph.get_context': 'get_code_graph_context',
  'code-graph.build': 'build_or_update_code_graph',
  'code-graph.query': 'query_code_graph',
  'code-graph.search': 'search_code_graph',
  'code-graph.explain': 'explain_code_symbol',
  'code-graph.impact': 'get_impact_radius',
  'code-graph.detect_changes': 'detect_changed_symbols',
  'code-graph.compare_changes': 'compare_change_impact',
  'code-graph.review': 'get_review_context',
} satisfies Record<AppAdvisorCodeGraphAction['type'], CanopyInjectedToolKey>;

function isAppAdvisorCodeGraphAction(
  action: AppAdvisorAction,
): action is AppAdvisorCodeGraphAction {
  return Object.prototype.hasOwnProperty.call(
    CODE_GRAPH_ACTION_TO_TOOL,
    action.type,
  );
}

export interface AppAdvisorScriptOutputInput extends GetScriptOutputInput {
  projectId?: string;
  worktreeId?: string;
}

export interface AppAdvisorPipelineYamlInput extends ReadPipelineYamlInput {
  projectId?: string;
  worktreeId?: string;
}

export interface AppAdvisorToolRuntime extends CanopyInjectedToolRuntime {
  watcherDestination: AppAdvisorWatcherDestination;
  startForkedAgent?(
    followUpInstruction: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  requestUiState(): Promise<AppAdvisorUiStateEnvelope>;
  /**
   * CAN-4131: the GetCurrentUiState tool's own read, through the interface
   * lease. `bound` says whether the calling session or route bound the tool.
   */
  /** The window accessors this runtime was created with (CAN-4133). */
  readonly appAdvisorSurfaces: AppAdvisorToolRuntimeSurfaces;
  /**
   * CAN-4133: records the interface tools this runtime's session or route
   * bound, as each tool call reports them; SDK sessions and Claude terminal
   * routes both carry them in the call context.
   */
  rememberInterfaceTools(tools: readonly InterfaceToolName[]): void;
  /** The recorded bound tools, else the SDK session's. */
  boundInterfaceTools(): Promise<readonly InterfaceToolName[]>;
  requestUiStateForTool(options: {
    bound: boolean;
    signal?: AbortSignal;
  }): Promise<AppAdvisorUiStateEnvelope>;
  dispatchRendererAction(
    action: AppAdvisorDispatchAction,
    expectedUiRevision?: number,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<AppAdvisorActionResponse>;
  getPipelineDebugContext(executionId: string): Promise<{
    prompt: string;
    failedStepCount: number;
    includedReportKinds: string[];
  }>;
  loadScriptOutput(
    request: AppAdvisorScriptOutputInput,
  ): Promise<ScriptOutputSnapshot>;
  loadPipelineYaml(
    request: AppAdvisorPipelineYamlInput,
  ): Promise<PipelineYamlReadResult>;
  showFiles(
    files: ShowFileRequest[],
    workspace?: ShowFilesWorkspaceTarget,
  ): Promise<ShowFilesRendererResult>;
  getScopedFileComments(request: {
    threadId?: string;
    workspace?: ShowFilesWorkspaceTarget;
  }): Promise<{ ok: boolean; text: string; error?: string }>;
  respondToScopedFileComment(request: {
    threadId: string;
    body: string;
    resolve: boolean;
    workspace?: ShowFilesWorkspaceTarget;
  }): Promise<{
    ok: boolean;
    resolved: boolean;
    error?: string;
    store?: 'file' | 'review' | 'plan';
  }>;
  searchWatchers(input: SearchAppAdvisorWatchersInput): Promise<
    | { ok: false; error: string }
    | (Omit<SearchAppAdvisorWatchersResult, 'activeWatchers'> & {
        activeWatchers: Array<
          | SearchAppAdvisorWatchersResult['activeWatchers'][number]
          | CanonicalChatWatcherProjection
        >;
      })
  >;
  setupCanonicalChatWatchers?(
    input: Pick<CanonicalChatWatcherSetupInput, 'watchers'>,
    context?: { toolUseId?: string },
  ): Promise<CanonicalChatWatcherSetupResult>;
  setupWatchers(
    input: SetupAppAdvisorWatchersInput,
    context?: { toolUseId?: string },
  ): Promise<SetupAppAdvisorWatchersResult>;
  watchGitHubItems(
    input: WatchGitHubItemsInput,
    context?: { toolUseId?: string },
  ): Promise<WatchGitHubItemsResult>;
  scheduleWakeup?(
    input: { delaySeconds: number; followUpInstruction?: string },
    context?: { toolUseId?: string },
  ): Promise<unknown>;
  watchCommand?(
    input: {
      command: string;
      intervalSeconds: number;
      maxAttempts: number;
      followUpInstruction?: string;
    },
    context?: { toolUseId?: string; signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface AppAdvisorToolRuntimeSurfaces {
  getMainWindow: () => BrowserWindow | null;
  getAppAdvisorWindow: () => BrowserWindow | null;
  openAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
  ensureAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
}

function unavailableScriptOutput(message: string): ScriptOutputSnapshot {
  return {
    found: false,
    lines: [],
    error: `surface_unavailable: ${message}`,
  };
}

function unavailablePipelineYaml(message: string): PipelineYamlReadResult {
  return {
    ok: false,
    error: `surface_unavailable: ${message}`,
  };
}

function resolveSnapshotWorktree(
  state: AppAdvisorUiStateEnvelope,
): { projectId: string; worktreeId: string } | null {
  const selected = state.snapshot.selectedWorktree;
  if (!selected?.projectId || !selected.worktreeId) {
    return null;
  }
  return { projectId: selected.projectId, worktreeId: selected.worktreeId };
}

function isAppAdvisorSentinel(projectId: string, worktreeId: string): boolean {
  void worktreeId;
  return projectId === APP_ADVISOR_PROJECT_ID;
}

async function resolveWorktreeToolTarget(
  projectId: string | undefined,
  worktreeId: string | undefined,
  runtime: Pick<AppAdvisorToolRuntime, 'requestUiState'>,
  chatId: string,
): Promise<
  | {
      projectId: string;
      worktreeId: string;
    }
  | { error: string }
> {
  let target: {
    projectId: string;
    worktreeId: string;
  } | null = null;

  if (projectId || worktreeId) {
    if (!projectId || !worktreeId) {
      return { error: 'projectId and worktreeId must be supplied together.' };
    }
    target = { projectId, worktreeId };
  } else {
    const state = getCachedAppAdvisorUiStateForChat(chatId);
    target = state ? resolveSnapshotWorktree(state) : null;
    if (!target) {
      target = resolveSnapshotWorktree(await runtime.requestUiState());
    }
  }

  if (!target) {
    return {
      error: `No ${BRAND.displayName} worktree is currently selected; ask the user to open one or pass projectId/worktreeId explicitly.`,
    };
  }

  if (isAppAdvisorSentinel(target.projectId, target.worktreeId)) {
    return {
      error: `App Advisor sentinel ids do not identify a real ${BRAND.displayName} worktree.`,
    };
  }

  return target;
}

function getInlineWatchers(
  action: AppAdvisorAction,
): AppAdvisorInlineWatcherSetup[] | null {
  if (
    action.type === 'automation.create' ||
    action.type === 'automation.run_now'
  ) {
    return action.watchers?.length ? action.watchers : null;
  }
  return null;
}

function stripInlineWatchers(action: AppAdvisorAction): AppAdvisorAction {
  if (
    action.type === 'automation.create' ||
    action.type === 'automation.run_now'
  ) {
    const rest = { ...action };
    delete rest.watchers;
    return rest;
  }
  return action;
}

function buildInlineWatcherTarget(
  action: AppAdvisorAction,
  result: unknown,
): AppAdvisorWatcherTarget | null {
  switch (action.type) {
    case 'worktree-chat.send_message':
      return {
        kind: 'worktree_chat',
        projectId: action.projectId,
        worktreeId: action.worktreeId,
        chatId: action.chatId,
      };
    case 'standalone-chat.send_message':
      return {
        kind: 'standalone_chat',
        projectId: action.projectId,
        chatId: action.chatId,
      };
    case 'automation.create': {
      const automationId = readCreatedAutomationId(result);
      return automationId ? { kind: 'automation', automationId } : null;
    }
    case 'automation.run_now':
      return { kind: 'automation', automationId: action.id };
    default:
      return null;
  }
}

function readCreatedAutomationId(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const activity = result.activity;
  return isRecord(activity) &&
    typeof activity.id === 'string' &&
    activity.id.length > 0
    ? activity.id
    : null;
}

function triggerForInlineWatcherTarget(
  target: AppAdvisorWatcherTarget,
): SetupAppAdvisorWatchersInput['watchers'][number]['trigger'] {
  switch (target.kind) {
    case 'worktree_chat':
      return 'worktree_chat_completion';
    case 'standalone_chat':
      return 'standalone_chat_completion';
    case 'worktree_chat_scope':
      return 'worktree_new_chat_started';
    case 'standalone_chat_project':
      return 'standalone_new_chat_started';
    case 'worktree_pipeline':
      return 'worktree_pipeline_completion';
    case 'worktree_hook':
      return 'worktree_hook_triggered';
    case 'automation':
      return 'automation_run';
    case 'github_workflow_runs':
    case 'github_pull_requests':
    case 'scheduled_wakeup':
    case 'command_watch':
      throw new Error('This watcher type cannot be created inline.');
  }
}

export function createAppAdvisorToolRuntime(
  surfaces: AppAdvisorToolRuntimeSurfaces,
  destination: AppAdvisorWatcherDestination,
  context?: {
    providerType?: AgentProviderType;
    approvalMode?: ApprovalMode;
    sessionApprovalRules?: ApprovalRule[];
    pluginSelections?: ChatTabPluginSelections;
    deferredToolsAllowed?: boolean;
    /**
     * False for managed Claude terminal chats: an active terminal turn is not
     * in the canonical transcript yet, so a fork would start from stale
     * context. Such runtimes neither advertise nor run StartForkedAgent.
     */
    canFork?: boolean;
  },
): AppAdvisorToolRuntime {
  let rememberedInterfaceTools: readonly InterfaceToolName[] | undefined;
  const boundInterfaceTools = async (): Promise<readonly InterfaceToolName[]> =>
    rememberedInterfaceTools ??
    (await boundAppAdvisorInterfaceTools(destination));
  const runtime: AppAdvisorToolRuntime = {
    watcherDestination: destination,
    worktreeWatcherRuntime: destination,
    // Hosted settings live in the main window, even when the Advisor runs in
    // its own window.
    settingsWindow: () => surfaces.getMainWindow(),
    appAdvisorPipelineWindow: surfaces.getMainWindow,
    autoArchiveChat: {
      projectId: destination.projectId,
      worktreeId: destination.worktreeId,
      chatId: destination.chatId,
    },
    ...(context?.canFork === false
      ? {}
      : {
          startForkedAgent: async (
            followUpInstruction: string,
            signal?: AbortSignal,
          ): Promise<unknown> => {
            if (
              destination.projectId !== APP_ADVISOR_PROJECT_ID ||
              destination.worktreeId === APP_ADVISOR_WORKTREE_ID
            ) {
              throw new Error(
                'Starting an Orchestrator fork requires a Work Entry chat.',
              );
            }
            // Deferred: the split-agent runtime pulls in worktree creation and
            // provider session code that ordinary Advisor turns never need.
            const { startSplitAgent } =
              await import('../canopy-tools/start-split-agent-runtime');
            return startSplitAgent(
              'start_forked_agent',
              { followUpInstruction },
              {
                projectId: destination.projectId,
                worktreeId: destination.worktreeId,
                chatId: destination.chatId,
                cwd: getAppAdvisorHomeDir(),
                executionScope: 'directory',
                getWindow: surfaces.getMainWindow,
                appAdvisorSurfaces: surfaces,
                ...(signal ? { signal } : {}),
              },
            );
          },
        }),
    deferredToolsRuntime: {
      scope: destination,
      providerType: context?.providerType,
      interfaceMode: 'canopy',
      assistantMode: 'app-advisor',
      pluginSelections: context?.pluginSelections,
      allowed: context?.deferredToolsAllowed !== false,
    },

    requestUserAnswers: async (
      questions: McpQuestion[],
      options?: { toolUseId?: string; signal?: AbortSignal },
    ) => {
      const answers: McpQuestionAnswer[] = [];
      for (const question of questions) {
        const requestId = randomUUID();
        // CAN-5827: the wait pauses the canonical turn, the one source of the
        // turn's duration. A question whose pause cannot be committed is not
        // asked, as a worktree question whose pending entry fails.
        const pause = {
          projectId: destination.projectId,
          worktreeId: destination.worktreeId,
          chatId: destination.chatId,
          ownerKind: 'question',
          ownerId: requestId,
        } as const;
        let response: Awaited<ReturnType<typeof requestAppAdvisorRendererTool>>;
        // The reducer sees the pause open even when its commit fails, so the
        // close runs whenever the open was attempted.
        try {
          try {
            await getChatStateService().commitTurnPause({
              ...pause,
              type: 'PauseOpened',
            });
          } catch {
            throw new Error('ask_user_persistence_failed');
          }
          // As for worktree chats, the audit keeps its own tally for the
          // shared fallback when the canonical record is late or unmatched.
          const ingest = getExecutionObservabilityIngest();
          ingest.pauseChatTurn(
            destination.projectId,
            destination.worktreeId,
            destination.chatId,
          );
          try {
            response = await requestAppAdvisorRendererTool(
              {
                kind: 'ask_user_question',
                requestId,
                question,
                // Chat attribution so the pending-request registry can surface
                // this question on the owning chat's portal summary (CAN-2565).
                chatId: destination.chatId,
              },
              surfaces,
              options?.signal ? { signal: options.signal } : undefined,
            );
          } finally {
            ingest.resumeChatTurn(
              destination.projectId,
              destination.worktreeId,
              destination.chatId,
            );
          }
        } finally {
          await getChatStateService()
            .commitTurnPause({ ...pause, type: 'PauseClosed' })
            .catch((error: unknown) => {
              // The reducer ends an open pause with its turn.
              logMainProcessWarn(
                '[app-advisor] question pause could not be closed',
                error,
              );
            });
        }
        const answeredBy = takeAppAdvisorAnswerProvenance(requestId);
        if (!response.ok || !response.answer) {
          if (response.error?.code === 'timeout') {
            throw new Error('ask_user_timeout');
          }
          // A window that could not show the question is not a dismissal.
          if (response.error?.code === 'surface_unavailable')
            throw new Error(response.error.message);
          throw new AskUserDismissedError(
            response.error?.message ?? 'User dismissed',
          );
        }
        answers.push({
          questionId: response.answer.questionId,
          question: response.answer.question,
          selectedOptions: response.answer.selectedOptions,
          freeformText: response.answer.freeformText,
          answeredBy,
        });
      }
      return answers;
    },

    appAdvisorSurfaces: surfaces,
    rememberInterfaceTools: (tools) => {
      rememberedInterfaceTools = tools;
    },
    boundInterfaceTools,
    requestUiState: async () =>
      runtime.requestUiStateForTool({
        bound: (await boundInterfaceTools()).includes(
          'ui.get_current_ui_state',
        ),
      }),
    requestUiStateForTool: ({ bound, signal }) =>
      requestCurrentAppAdvisorUiStateThroughLease({
        scope: {
          workspaceId: destination.projectId,
          worktreeId: destination.worktreeId,
          chatId: destination.chatId,
        },
        originChatTabId: destination.chatId,
        bound,
        ...(signal ? { signal } : {}),
      }),

    showFiles: (files, workspace) => {
      const target = workspace ?? {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: destination.worktreeId,
      };
      return requestShowFilesThroughInterfaceTool(
        target.projectId === APP_ADVISOR_PROJECT_ID
          ? 'ui.app_advisor.show_files'
          : 'ui.show_files',
        {
          files,
          target,
          origin: {
            projectId: APP_ADVISOR_PROJECT_ID,
            worktreeId: destination.worktreeId,
            chatTabId: destination.chatId,
          },
          ...(target.projectId === APP_ADVISOR_PROJECT_ID
            ? { cwd: getAppAdvisorHomeDir() }
            : {}),
        },
      );
    },

    getScopedFileComments: ({ threadId, workspace }) => {
      const target = workspace ?? {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: destination.worktreeId,
      };
      return getFileCommentsInSession({
        ...target,
        ...(threadId !== undefined ? { threadId } : {}),
      });
    },

    respondToScopedFileComment: async ({
      threadId,
      body,
      resolve,
      workspace,
    }) => {
      const target = workspace ?? {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: destination.worktreeId,
      };
      return respondToFileCommentInSession({
        ...target,
        threadId,
        body,
        resolve,
        getWindow: () => surfaces.getMainWindow(),
      });
    },

    dispatchRendererAction: async (
      action: AppAdvisorDispatchAction,
      expectedUiRevision?: number,
      requestId = randomUUID(),
      signal?: AbortSignal,
    ): Promise<AppAdvisorActionResponse> => {
      if (isTranscriptReadActionType(action)) {
        return dispatchAdvisorTranscriptRead(
          action,
          runtime,
          requestId,
          signal,
        );
      }
      if (isAppAdvisorCodeGraphAction(action)) {
        // Reuse the worktree tools' live feature gate, target guards, input
        // validation and worker-backed graph access. Never use Advisor's home.
        const { type, projectId, worktreeId, ...args } = action;
        const { executeCanopyInjectedTool } =
          await import('../canopy-tools/core');
        const result = await executeCanopyInjectedTool(
          CODE_GRAPH_ACTION_TO_TOOL[type],
          args,
          {
            ...runtime,
            codeGraphRuntime: { projectId, worktreeId },
          },
        );
        return result.isError
          ? {
              requestId,
              ok: false,
              error: { code: 'execution_failed', message: result.text },
            }
          : { requestId, ok: true, result: { text: result.text } };
      }
      if (isAppAdvisorBrowserAction(action)) {
        const browserAction = action;
        if (!!browserAction.projectId !== !!browserAction.worktreeId)
          return {
            requestId,
            ok: false,
            error: {
              code: 'invalid_target',
              message: 'Supply both browser task identifiers.',
            },
          };
        const projectId = browserAction.projectId ?? destination.projectId;
        const worktreeId = browserAction.worktreeId ?? destination.worktreeId;
        // Captured task identity is authoritative even if the sidebar focus moves.
        // Defer the broad worktree-action dispatcher until a browser action is
        // actually requested; non-browser App Advisor turns do not need it.
        const { dispatchScopedBrowserAction } =
          await import('../canopy-tools/worktree-actions');
        const result = await dispatchScopedBrowserAction(
          { action: browserAction },
          {
            projectId,
            worktreeId,
            presentationOrigin: {
              projectId: destination.projectId,
              worktreeId: destination.worktreeId,
              chatTabId: destination.chatId,
            },
            chatId: destination.chatId,
            // The browser may be another task's; approvals go to this chat.
            approvalChat: {
              projectId: destination.projectId,
              worktreeId: destination.worktreeId,
              chatId: destination.chatId,
            },
            cwd: getAppAdvisorHomeDir(),
            executionScope: 'directory',
            getWindow:
              projectId === APP_ADVISOR_PROJECT_ID
                ? surfaces.getAppAdvisorWindow
                : surfaces.getMainWindow,
          },
          signal,
        );
        return { ...result, requestId };
      }
      if (isDelegationReadAction(action)) {
        const { dispatchDelegationReadAction } =
          await import('./delegation-read-actions');
        return { ...(await dispatchDelegationReadAction(action)), requestId };
      }
      if (isAdvisorDelegationControlAction(action)) {
        // CAN-6000: a delegate's live run is stopped by core.operation.cancel
        // on its core.agent.subagent.run, never by an id from the action.
        const [
          { dispatchAdvisorDelegationControl },
          { mainAdvisorDelegationControlHost },
        ] = await Promise.all([
          import('./advisor-delegation-control'),
          import('./advisor-delegation-control-host'),
        ]);
        return {
          ...(await dispatchAdvisorDelegationControl(
            action,
            mainAdvisorDelegationControlHost({ chatId: destination.chatId }),
          )),
          requestId,
        };
      }
      if (isAdvisorAutomationSharingAction(action)) {
        // CAN-6003 part B: automation sharing on the window's owners, with
        // its readiness checks.
        const [
          { dispatchAdvisorAutomationSharingAction },
          { mainAdvisorAutomationSharingHost },
        ] = await Promise.all([
          import('./advisor-automation-sharing-actions'),
          import('./advisor-automation-sharing-actions-host'),
        ]);
        return {
          ...(await dispatchAdvisorAutomationSharingAction(
            action,
            mainAdvisorAutomationSharingHost(),
          )),
          requestId,
        };
      }
      if (isAdvisorCollectionSharingAction(action)) {
        // CAN-6003 part B: collection sharing on the window's owners; a
        // person confirms every import, which installs skills and plugins.
        const [
          { dispatchAdvisorCollectionSharingAction },
          { mainAdvisorCollectionSharingHost },
        ] = await Promise.all([
          import('./advisor-collection-sharing-actions'),
          import('./advisor-collection-sharing-actions-host'),
        ]);
        return {
          ...(await dispatchAdvisorCollectionSharingAction(
            action,
            mainAdvisorCollectionSharingHost({
              chatId: destination.chatId,
              requestUserAnswers: (questions) =>
                runtime.requestUserAnswers(
                  questions,
                  signal ? { signal } : undefined,
                ),
            }),
          )),
          requestId,
        };
      }
      if (isAdvisorSharingAction(action)) {
        // CAN-6003: sharing on the window's hosted owners; a public agent
        // link only after a person confirms.
        const [
          { dispatchAdvisorSharingAction },
          { mainAdvisorSharingActionHost },
          { mainAdvisorChatReadHost },
        ] = await Promise.all([
          import('./advisor-sharing-actions'),
          import('./advisor-sharing-actions-host'),
          import('./advisor-chat-read-host'),
        ]);
        const reads = mainAdvisorChatReadHost({
          chatId: destination.chatId,
          readUiState: async () => {
            const envelope = await runtime.requestUiState();
            return envelope.revision === 0 ? null : envelope.snapshot;
          },
        });
        return {
          ...(await dispatchAdvisorSharingAction(
            action,
            mainAdvisorSharingActionHost({
              chatId: destination.chatId,
              idempotencyKey: `app-advisor-action:${destination.chatId}:${requestId}:sharing`,
              getWindow: surfaces.getMainWindow,
              readTabs: (projectId, worktreeId) =>
                reads.readTabs(projectId, worktreeId),
              requestUserAnswers: (questions) =>
                runtime.requestUserAnswers(
                  questions,
                  signal ? { signal } : undefined,
                ),
            }),
          )),
          requestId,
        };
      }
      if (isAdvisorCredentialAction(action)) {
        // CAN-6008: the router let these through only with the main window's
        // lease bound; they run on the owners the Settings handlers call.
        const [
          { dispatchAdvisorCredentialAction },
          { mainAdvisorCredentialActionHost },
        ] = await Promise.all([
          import('./advisor-credential-actions'),
          import('./advisor-credential-actions-host'),
        ]);
        return {
          ...(await dispatchAdvisorCredentialAction(
            action,
            mainAdvisorCredentialActionHost({
              getMainWindow: surfaces.getMainWindow,
              revealOllamaSettings: async () => {
                await presentAppAdvisorAction({
                  action: {
                    type: 'navigation.open_settings',
                    section: 'ollama',
                  },
                  requestId: `${requestId}:reveal`,
                  destination,
                  boundTools: await boundInterfaceTools(),
                });
              },
            }),
            signal,
          )),
          requestId,
        };
      }
      if (isAdvisorFileTreeAction(action)) {
        // CAN-6006: the explorer's mutation owners as the advisor chat, with
        // only worker.filesystem.write; a delete always goes to the Trash.
        const [
          { dispatchAdvisorFileTreeAction },
          { mainAdvisorFileTreeActionHost },
        ] = await Promise.all([
          import('./advisor-file-tree-actions'),
          import('./advisor-file-tree-actions-host'),
        ]);
        return {
          ...(await dispatchAdvisorFileTreeAction(
            action,
            mainAdvisorFileTreeActionHost({ chatId: destination.chatId }),
          )),
          requestId,
        };
      }
      if (isAdvisorMemoryAction(action)) {
        // CAN-6005: the core.memory maintenance operations as the advisor
        // chat; a rebuild, restore or import only after a person confirms.
        const [
          { dispatchAdvisorMemoryAction },
          { mainAdvisorMemoryActionHost },
        ] = await Promise.all([
          import('./advisor-memory-actions'),
          import('./advisor-memory-actions-host'),
        ]);
        return {
          ...(await dispatchAdvisorMemoryAction(
            action,
            mainAdvisorMemoryActionHost({
              chatId: destination.chatId,
              callKey: `${destination.chatId}:${requestId}`,
              requestUserAnswers: (questions) =>
                runtime.requestUserAnswers(
                  questions,
                  signal ? { signal } : undefined,
                ),
            }),
          )),
          requestId,
        };
      }
      if (isAdvisorRecordsAction(action)) {
        // CAN-6007: the Feed as the advisor chat, every watcher read-only,
        // and the archive through core.archive.*; another chat's watcher and
        // an archive unlock only after a person confirms.
        const [
          { dispatchAdvisorRecordsAction },
          { mainAdvisorRecordsActionHost },
        ] = await Promise.all([
          import('./advisor-records-actions'),
          import('./advisor-records-actions-host'),
        ]);
        return {
          ...(await dispatchAdvisorRecordsAction(
            action,
            mainAdvisorRecordsActionHost({
              destination,
              callKey: `${destination.chatId}:${requestId}`,
              requestUserAnswers: (questions) =>
                runtime.requestUserAnswers(
                  questions,
                  signal ? { signal } : undefined,
                ),
            }),
          )),
          requestId,
        };
      }
      if (isAdvisorSettingsAction(action)) {
        // CAN-6004: settings through core.config.*, as the advisor chat; a
        // person confirms before delegation widens, the proxy's routing
        // changes, or recording stops or archived chats are deleted sooner.
        const [
          { dispatchAdvisorSettingsAction },
          { mainAdvisorSettingsActionHost },
        ] = await Promise.all([
          import('./advisor-settings-actions'),
          import('./advisor-settings-actions-host'),
        ]);
        return {
          ...(await dispatchAdvisorSettingsAction(
            action,
            mainAdvisorSettingsActionHost({
              chatId: destination.chatId,
              callKey: `${destination.chatId}:${requestId}`,
              requestUserAnswers: (questions) =>
                runtime.requestUserAnswers(
                  questions,
                  signal ? { signal } : undefined,
                ),
            }),
          )),
          requestId,
        };
      }
      if (isAdvisorCatalogAction(action)) {
        // CAN-6002: agents and collections on the window's owners;
        // marketplace writes through core.catalog.source.*.
        const [
          { dispatchAdvisorCatalogAction },
          { mainAdvisorCatalogActionHost },
        ] = await Promise.all([
          import('./advisor-catalog-actions'),
          import('./advisor-catalog-actions-host'),
        ]);
        return {
          ...(await dispatchAdvisorCatalogAction(
            action,
            mainAdvisorCatalogActionHost({
              chatId: destination.chatId,
              idempotencyKey: `app-advisor-action:${destination.chatId}:${requestId}:catalog`,
              getWindow: surfaces.getMainWindow,
              requestUserAnswers: (questions) =>
                runtime.requestUserAnswers(
                  questions,
                  signal ? { signal } : undefined,
                ),
            }),
          )),
          requestId,
        };
      }
      if (isAdvisorPipelineAction(action)) {
        // CAN-6001: each reads only the execution main resolves; a send names
        // only the report or plan path main read for it.
        const [
          { dispatchAdvisorPipelineAction },
          { mainAdvisorPipelineActionHost },
          { mainAdvisorChatReadHost },
        ] = await Promise.all([
          import('./advisor-pipeline-actions'),
          import('./advisor-pipeline-actions-host'),
          import('./advisor-chat-read-host'),
        ]);
        const reads = mainAdvisorChatReadHost({
          chatId: destination.chatId,
          readUiState: async () => {
            const envelope = await runtime.requestUiState();
            return envelope.revision === 0 ? null : envelope.snapshot;
          },
        });
        const host = mainAdvisorPipelineActionHost({
          getWindow: surfaces.getMainWindow,
          readTabs: (projectId, worktreeId) =>
            reads.readTabs(projectId, worktreeId),
          sendToChat: async (target, text) => {
            const authorized = await resolveAuthorizedChat(
              {
                projectId: target.projectId,
                taskId: target.worktreeId,
                chatId: target.chatId,
              },
              { kind: 'app_advisor', chatId: destination.chatId },
            );
            if (!authorized.row.capabilities.canSend)
              throw new Error('This chat cannot receive messages.');
            await dispatchAgentChatSend(
              chatSendActionSchema.parse({
                type: 'projects.send_message',
                ...authorized.address,
                text,
              }),
              {
                caller: { kind: 'app_advisor', source: destination },
                watcherDestination: destination,
                toolUseId: requestId,
                surfaces,
              },
            );
          },
          revealChat: async (target) => {
            await presentAppAdvisorAction({
              action: {
                type: 'worktree-chat.open_tab',
                projectId: target.projectId,
                worktreeId: target.worktreeId,
                chatId: target.chatId,
              },
              requestId: `${requestId}:reveal`,
              destination,
              boundTools: await boundInterfaceTools(),
              ...(signal ? { signal } : {}),
            });
          },
          createAdvisorChat: async ({ title, text }) => {
            const created = await dispatchAdvisorChatAction(
              { type: 'advisor-chat.create_entry', title, text },
              destination,
              surfaces,
              requestId,
            );
            if (
              !created.ok ||
              !isRecord(created.result) ||
              typeof created.result.chatId !== 'string' ||
              typeof created.result.workEntryId !== 'string'
            )
              throw new Error(
                created.error?.message ?? "Couldn't create the debug chat.",
              );
            return {
              workEntryId: created.result.workEntryId,
              chatId: created.result.chatId,
            };
          },
        });
        return {
          ...(await dispatchAdvisorPipelineAction(action, host)),
          requestId,
        };
      }
      if (
        action.type === 'bots.list' ||
        action.type === 'bots.list_tasks' ||
        action.type === 'bots.list_task_chats' ||
        action.type === 'bots.get_last_user_message' ||
        action.type === 'bots.get_last_agent_response' ||
        action.type === 'bots.read_history'
      ) {
        const { dispatchBotAction } = await import('../project-discovery/bots');
        const result = await dispatchBotAction(action, {
          kind: 'app_advisor',
          chatId: destination.chatId,
        });
        if (
          result.ok &&
          (action.type === 'bots.list' ||
            action.type === 'bots.list_tasks' ||
            action.type === 'bots.list_task_chats')
        ) {
          return {
            ...withAppAdvisorListUiEnvelope(
              action.type,
              result,
              getCachedAppAdvisorUiStateForChat(destination.chatId) ??
                undefined,
            ),
            requestId,
          };
        }
        return { ...result, requestId };
      }
      if (
        action.type === 'projects.get_last_user_message' ||
        action.type === 'projects.get_last_agent_response' ||
        action.type === 'projects.read_history'
      ) {
        const { dispatchProjectReadAction } =
          await import('../project-discovery/reads');
        const result = await dispatchProjectReadAction(action, {
          kind: 'app_advisor',
          chatId: destination.chatId,
        });
        return { ...result, requestId };
      }
      if (
        action.type === 'projects.list' ||
        action.type === 'projects.list_tasks' ||
        action.type === 'projects.list_task_chats'
      ) {
        const { dispatchProjectDiscoveryAction } =
          await import('../project-discovery');
        const result = await dispatchProjectDiscoveryAction(action, {
          kind: 'app_advisor',
          chatId: destination.chatId,
        });
        return {
          ...(result.ok
            ? withAppAdvisorListUiEnvelope(
                action.type,
                result,
                getCachedAppAdvisorUiStateForChat(destination.chatId) ??
                  undefined,
              )
            : result),
          requestId,
        };
      }
      if (
        action.type === 'projects.steer_queued_message' ||
        action.type === 'projects.schedule_message' ||
        action.type === 'worktree-chat.steer_queued_message' ||
        action.type === 'worktree-chat.schedule_message'
      ) {
        const legacy =
          action.type === 'worktree-chat.steer_queued_message' ||
          action.type === 'worktree-chat.schedule_message';
        try {
          let control: z.output<typeof projectMessageControlActionSchema>;
          if (legacy) {
            const target = await resolveAuthorizedChat(
              {
                projectId: action.projectId,
                taskId: action.worktreeId,
                chatId: action.chatId,
              },
              { kind: 'app_advisor', chatId: destination.chatId },
            );
            if (action.type === 'worktree-chat.steer_queued_message') {
              control = projectMessageControlActionSchema.parse({
                type: 'projects.steer_queued_message',
                ...target.address,
                queuedMessageId: action.queuedMessageId,
              });
            } else {
              const date = new Date(action.runAt);
              control = projectMessageControlActionSchema.parse({
                type: 'projects.schedule_message',
                ...target.address,
                text: action.text,
                runAt: Number.isFinite(date.getTime())
                  ? date.toISOString()
                  : action.runAt,
                ...(action.timezone !== undefined
                  ? { timezone: action.timezone }
                  : {}),
                ...(action.name?.trim() ? { name: action.name.trim() } : {}),
                ...(action.inputMode !== undefined
                  ? { inputMode: action.inputMode }
                  : {}),
                attachments: {
                  ...(action.fileReferences
                    ? {
                        fileReferences: action.fileReferences.map(
                          (reference: unknown) =>
                            z
                              .object({
                                displayPath: z.string(),
                                absolutePath: z.string(),
                                repoName: z.string().optional(),
                              })
                              .parse(reference),
                        ),
                      }
                    : {}),
                  ...(action.attachmentPaths
                    ? { attachmentPaths: action.attachmentPaths }
                    : {}),
                  ...(action.attachmentPromptContexts
                    ? {
                        attachmentPromptContexts:
                          action.attachmentPromptContexts,
                      }
                    : {}),
                },
              });
            }
          } else {
            control = projectMessageControlActionSchema.parse(action);
          }
          const context = {
            caller: { kind: 'app_advisor', source: destination },
          } as const;
          if (control.type === 'projects.steer_queued_message') {
            const { dispatchAgentChatSteer } =
              await import('../agent-messaging/steer-orchestration');
            const receipt = await dispatchAgentChatSteer(control, context);
            return {
              requestId,
              ok: true,
              result: legacy
                ? {
                    projectId: receipt.address.projectId,
                    worktreeId: receipt.address.taskId,
                    chatId: receipt.address.chatId,
                    queuedMessageId: receipt.queuedMessageId,
                  }
                : { ...receipt },
            };
          }
          const { dispatchAgentChatSchedule } =
            await import('../agent-messaging/schedule-orchestration');
          const { receipt, activity } = await dispatchAgentChatSchedule(
            control,
            context,
          );
          return {
            requestId,
            ok: true,
            result: legacy
              ? {
                  activity: z
                    .json()
                    .parse(JSON.parse(JSON.stringify(activity))),
                }
              : { ...receipt },
          };
        } catch (cause) {
          if (isAgentChatSendError(cause)) {
            if (
              action.type === 'worktree-chat.steer_queued_message' &&
              (cause.code === 'missing_capability' ||
                cause.code === 'target_not_ready')
            )
              return {
                requestId,
                ok: false,
                error: {
                  code: 'execution_failed',
                  message:
                    'The queued message could not be steered. It remains in the queue.',
                },
              };
            return {
              requestId,
              ok: false,
              error: {
                code:
                  cause.code === 'owner_boundary'
                    ? 'not_found'
                    : cause.code === 'target_not_ready'
                      ? 'invalid_target'
                      : cause.code,
                message:
                  cause.code === 'owner_boundary'
                    ? 'Chat was not found.'
                    : cause.message,
              },
            };
          }
          if (cause instanceof DiscoveryError)
            return {
              requestId,
              ok: false,
              error: { code: cause.code, message: cause.message },
            };
          return {
            requestId,
            ok: false,
            error: {
              code:
                cause instanceof ZodError
                  ? 'validation_failed'
                  : 'execution_failed',
              message: cause instanceof Error ? cause.message : String(cause),
            },
          };
        }
      }
      if (
        action.type === 'projects.send_message' ||
        action.type === 'bots.send_message' ||
        action.type === 'worktree-chat.send_message' ||
        action.type === 'standalone-chat.send_message'
      ) {
        try {
          const legacy =
            action.type === 'worktree-chat.send_message' ||
            action.type === 'standalone-chat.send_message';
          let sendAction: ChatSendAction;
          let legacySettings: AppAdvisorJson | undefined;
          if (legacy) {
            const owner =
              action.type === 'standalone-chat.send_message'
                ? await resolveWorkEntryForChat(action.projectId, action.chatId)
                : { entryId: action.worktreeId };
            if (!owner.entryId)
              return {
                requestId,
                ok: false,
                error: { code: 'not_found', message: 'Chat was not found.' },
              };
            const target = await resolveAuthorizedChat(
              {
                projectId: action.projectId,
                taskId: owner.entryId,
                chatId: action.chatId,
              },
              { kind: 'app_advisor', chatId: destination.chatId },
            );
            if (!target.row.capabilities.canSend)
              return {
                requestId,
                ok: false,
                error: {
                  code: 'invalid_target',
                  message: 'This chat cannot receive messages.',
                },
              };
            sendAction = chatSendActionSchema.parse({
              type: 'projects.send_message',
              ...target.address,
              text: action.text,
              ...(action.type === 'worktree-chat.send_message' &&
              action.queueForSetup !== undefined
                ? { queueForSetup: action.queueForSetup }
                : {}),
              ...(action.watchers
                ? {
                    watchers: action.watchers.map(
                      ({ label, followUpInstruction, allowDuplicate }) => ({
                        ...(label !== undefined ? { label } : {}),
                        ...(followUpInstruction !== undefined
                          ? { followUpInstruction }
                          : {}),
                        ...(allowDuplicate !== undefined
                          ? { allowDuplicate }
                          : {}),
                      }),
                    ),
                  }
                : {}),
            });
            const navigation: AppAdvisorAction =
              action.type === 'worktree-chat.send_message'
                ? {
                    type: 'worktree-chat.open_tab',
                    projectId: target.address.projectId,
                    worktreeId: target.address.taskId,
                    chatId: target.address.chatId,
                  }
                : {
                    type: 'standalone-chat.switch_chat',
                    projectId: target.address.projectId,
                    chatId: target.address.chatId,
                  };
            const response = await presentAppAdvisorAction({
              action: navigation,
              requestId,
              destination,
              boundTools: await boundInterfaceTools(),
              ...(signal ? { signal } : {}),
            });
            if (!response.ok) return { ...response, requestId };
            if (
              action.type === 'standalone-chat.send_message' &&
              isRecord(response.result)
            )
              legacySettings = response.result.settings;
            if (
              action.type === 'standalone-chat.send_message' &&
              !isRecord(legacySettings)
            )
              return {
                requestId,
                ok: false,
                error: {
                  code: 'execution_failed',
                  message:
                    'The selected chat settings could not be read; no message was sent.',
                },
              };
          } else {
            sendAction = chatSendActionSchema.parse(action);
          }
          const receipt = await dispatchAgentChatSend(sendAction, {
            caller: { kind: 'app_advisor', source: destination },
            watcherDestination: destination,
            toolUseId: requestId,
            surfaces,
          });
          if (!legacy) return { requestId, ok: true, result: { ...receipt } };
          // Legacy callers keep their old result plus inline watcher feedback.
          const inlineWatcherSetup: AppAdvisorJson | undefined = action.watchers
            ?.length
            ? {
                ok: true,
                watcherReceipts: receipt.watcherReceipts.map((entry) => ({
                  ...entry,
                })),
              }
            : undefined;
          const legacyResult = {
            ...(isRecord(legacySettings) ? legacySettings : {}),
            ...(inlineWatcherSetup ? { inlineWatcherSetup } : {}),
          };
          return Object.keys(legacyResult).length > 0
            ? { requestId, ok: true, result: legacyResult }
            : { requestId, ok: true };
        } catch (cause) {
          if (isAgentChatSendError(cause))
            return {
              requestId,
              ok: false,
              error: {
                code:
                  cause.code === 'owner_boundary'
                    ? 'not_found'
                    : cause.code === 'target_not_ready'
                      ? 'invalid_target'
                      : cause.code,
                message:
                  cause.code === 'owner_boundary'
                    ? 'Chat was not found.'
                    : cause.message,
              },
            };
          if (cause instanceof DiscoveryError)
            return {
              requestId,
              ok: false,
              error: { code: cause.code, message: cause.message },
            };
          return {
            requestId,
            ok: false,
            error: {
              code:
                cause instanceof ZodError
                  ? 'validation_failed'
                  : 'execution_failed',
              message: cause instanceof Error ? cause.message : String(cause),
            },
          };
        }
      }
      if (
        action.type === 'projects.create_task' ||
        action.type === 'projects.create_task_chat' ||
        action.type === 'bots.create_task' ||
        action.type === 'bots.create_task_chat'
      ) {
        try {
          const { dispatchAgentChatCreation } =
            await import('../agent-messaging/creation-orchestration');
          const receipt = await dispatchAgentChatCreation(action, {
            caller: { kind: 'app_advisor', source: destination },
            watcherDestination: destination,
            toolUseId: requestId,
            surfaces,
          });
          return { requestId, ok: true, result: { ...receipt } };
        } catch (cause) {
          if (isAgentChatSendError(cause))
            return {
              requestId,
              ok: false,
              error: {
                code:
                  cause.code === 'owner_boundary'
                    ? 'not_found'
                    : cause.code === 'target_not_ready'
                      ? 'invalid_target'
                      : cause.code,
                message:
                  cause.code === 'owner_boundary'
                    ? 'Chat was not found.'
                    : cause.message,
              },
            };
          return {
            requestId,
            ok: false,
            error: {
              code:
                cause instanceof ZodError
                  ? 'validation_failed'
                  : 'execution_failed',
              message: cause instanceof Error ? cause.message : String(cause),
            },
          };
        }
      }
      if (
        action.type === 'standalone-chat.create_chat' ||
        (action.type === 'worktree-chat.open_tab' && !action.chatId)
      ) {
        const { dispatchLegacyChatCreation } =
          await import('./creation-adapters');
        return dispatchLegacyChatCreation(action, {
          destination,
          surfaces,
          boundTools: await boundInterfaceTools(),
          requestId,
          ...(expectedUiRevision !== undefined ? { expectedUiRevision } : {}),
          ...(signal ? { signal } : {}),
        });
      }
      if (isAdvisorChatAction(action)) {
        const result = await dispatchAdvisorChatAction(
          action,
          destination,
          surfaces,
          requestId,
        );
        return { ...result, requestId };
      }
      if (
        action.type === 'worktree.list_scripts' ||
        action.type === 'worktree.run_script'
      ) {
        // Script runs are main-process work: dispatch them with the requested
        // worktree through the same handler worktree chats use, rather than
        // through the renderer. The handler rejects Cowork and assistant
        // sentinel targets. Deferred like the browser dispatcher above.
        const { projectId, worktreeId, ...scriptAction } = action;
        const { dispatchWorktreeAction } =
          await import('../canopy-tools/worktree-actions');
        const result = await dispatchWorktreeAction(
          { action: scriptAction },
          {
            projectId,
            worktreeId,
            chatId: destination.chatId,
            // Script actions resolve paths from the target ids; cwd is unused.
            cwd: getAppAdvisorHomeDir(),
            executionScope: 'worktree',
            // The Scripts section that shows the run lives in the main window.
            getWindow: surfaces.getMainWindow,
            ...(signal ? { signal } : {}),
          },
        );
        return { ...result, requestId };
      }
      if (isAdvisorChatSettingAction(action)) {
        // CAN-5999 part 2: model, thinking, plan and speed changes through
        // core.chat.update. A change its guard sends to the window is
        // applied there through the main window's lease, never headless.
        const { mainAdvisorChatSettingsHost } =
          await import('./advisor-chat-settings-host');
        return dispatchAdvisorChatSetting(
          action,
          mainAdvisorChatSettingsHost({
            chatId: destination.chatId,
            readUiState: async () => {
              const envelope = await runtime.requestUiState();
              return envelope.revision === 0 ? null : envelope.snapshot;
            },
            getMainWindow: surfaces.getMainWindow,
            hasPresentationLease: async () =>
              (await boundInterfaceTools()).includes('ui.app_advisor.present'),
            presentInMainWindow: async (settingAction) =>
              presentAppAdvisorAction({
                action: settingAction,
                requestId: `${requestId}:present`,
                destination,
                boundTools: await boundInterfaceTools(),
                guarded: true,
                ...(signal ? { signal } : {}),
              }),
          }),
          {
            requestId,
            idempotencyKey: `app-advisor-action:${destination.chatId}:${requestId}:settings`,
          },
        );
      }
      if (isAdvisorChatReadAction(action)) {
        // CAN-5999: chat history, tab, plugin, Cowork project and workspace
        // item reads in main. A target the action leaves out comes from the
        // main window's UI state through its lease, never a cached one.
        const { mainAdvisorChatReadHost } =
          await import('./advisor-chat-read-host');
        return dispatchAdvisorChatRead(
          action,
          mainAdvisorChatReadHost({
            chatId: destination.chatId,
            readUiState: async () => {
              const envelope = await runtime.requestUiState();
              // Revision 0 is the fallback state: no window answered.
              return envelope.revision === 0 ? null : envelope.snapshot;
            },
          }),
          requestId,
        );
      }
      if (isAdvisorWorkspaceAction(action)) {
        // CAN-5998: project, organization project, sidebar group and
        // tracked-plan reads and the sidebar group writes, from main's own
        // owners on the action's target.
        const { mainAdvisorWorkspaceActionHost } =
          await import('./advisor-workspace-action-host');
        return dispatchAdvisorWorkspaceAction(
          action,
          mainAdvisorWorkspaceActionHost({ chatId: destination.chatId }),
          requestId,
        );
      }
      if (isAdvisorWorktreeAction(action)) {
        // CAN-5997: worktree settings, creation and fix-chat starts in main
        // on the action's target; selecting the worktree is a best-effort
        // presentation through the main window's lease.
        const { mainAdvisorWorktreeActionHost } =
          await import('./advisor-worktree-action-host');
        const host = mainAdvisorWorktreeActionHost({
          getMainWindow: surfaces.getMainWindow,
          selectWorktree: async (projectId, worktreeId) => {
            try {
              await presentAppAdvisorAction({
                action: { type: 'worktree.select', projectId, worktreeId },
                requestId: `${requestId}:select`,
                destination,
                boundTools: await boundInterfaceTools(),
                ...(signal ? { signal } : {}),
              });
            } catch {
              // Selecting is presentation; the action's result never depends on it.
            }
          },
        });
        return dispatchAdvisorWorktreeAction(action, host, {
          requestId,
          keyFor: (step) =>
            `app-advisor-action:${destination.chatId}:${requestId}:${step}`,
        });
      }
      if (action.type === 'worktree.set_base_branch') {
        // CAN-6024: the main base-branch flow worktree chats' SetBaseBranch
        // uses, on the requested worktree; an open PR's choice is asked in
        // this chat.
        const { setWorktreeBaseBranchForAgent } =
          await import('../canopy-tools/set-base-branch-runtime');
        return setWorktreeBaseBranchForAgent({
          target: {
            projectId: action.projectId,
            worktreeId: action.worktreeId,
          },
          chatId: destination.chatId,
          baseBranch: action.baseBranch,
          ...(action.repoId ? { repoId: action.repoId } : {}),
          requestUserAnswers: (questions) =>
            runtime.requestUserAnswers(
              questions,
              signal ? { signal } : undefined,
            ),
          toolUseId: requestId,
          ...(signal ? { signal } : {}),
        });
      }
      if (
        action.type === 'hook.pause' ||
        action.type === 'hook.resume' ||
        action.type === 'tracked-plan.import'
      ) {
        // CAN-5829: the main handlers worktree chats use, on the requested
        // worktree, instead of the renderer. Deferred like the dispatchers
        // above.
        const { projectId, worktreeId, ...worktreeAction } = action;
        const [{ isCoworkWorkspace }, { dispatchWorktreeAction }] =
          await Promise.all([
            import('../lib/workspace-registry'),
            import('../canopy-tools/worktree-actions'),
          ]);
        if (
          action.type !== 'tracked-plan.import' &&
          isCoworkWorkspace(projectId)
        )
          return {
            requestId,
            ok: false,
            error: {
              code: 'unsupported_action',
              message: `Project ${projectId} is a cowork project and has no git worktrees.`,
            },
          };
        try {
          const result = await dispatchWorktreeAction(
            { action: worktreeAction },
            {
              projectId,
              worktreeId,
              chatId: destination.chatId,
              cwd: getAppAdvisorHomeDir(),
              executionScope: 'worktree',
              planInitiationSource: 'app_advisor',
              getWindow: surfaces.getMainWindow,
              ...(signal ? { signal } : {}),
            },
          );
          return { ...result, requestId };
        } catch (cause) {
          return {
            requestId,
            ok: false,
            error: {
              code: 'execution_failed',
              message: cause instanceof Error ? cause.message : String(cause),
            },
          };
        }
      }
      if (action.type === 'workspace.find_repository_owner') {
        // The Add project dialog's create-time nudge, read-only, answered in
        // main (CAN-3592). The lookup itself answers `none` for no match,
        // ambiguity, a missing flag or capability, any error and its time
        // box; the try/catch only keeps a lookup bug (reject or throw) from
        // reaching the model as a tool error. Deferred like the dispatchers
        // above. The abort signal is unused: the lookup has its own time box.
        const request: OrgRepositoryOwnerRequest =
          action.path !== undefined
            ? { path: action.path }
            : { remoteUrl: action.remoteUrl };
        let result: OrgRepositoryOwnerLookup = { kind: 'none' };
        try {
          const { getOrgRepositoryOwnerLookup } =
            await import('../lib/org-repository-owner');
          result = await getOrgRepositoryOwnerLookup().find(request);
        } catch (error) {
          // Fail open; the model sees `none`, never the failure.
          logMainProcessWarn(
            '[app-advisor] Repository owner lookup failed',
            error,
          );
        }
        // Copy the protocol DTO into a plain JSON object for the tool result.
        return { requestId, ok: true, result: { ...result } };
      }
      const inlineWatchers = getInlineWatchers(action);
      let rendererAction = inlineWatchers
        ? stripInlineWatchers(action)
        : action;
      const createWithInlineWatchers =
        action.type === 'automation.create' && inlineWatchers?.length
          ? action
          : null;
      const requestedCreateEnabled =
        createWithInlineWatchers?.input.enabled !== false;
      if (createWithInlineWatchers) {
        rendererAction = {
          type: 'automation.create',
          input: { ...createWithInlineWatchers.input, enabled: false },
        };
      }
      // automation.run_now completes the dispatched run before the action
      // returns, so its inline watchers must be armed BEFORE the dispatch —
      // and the two must stay atomic: if arming fails, do not run the
      // automation unwatched. Watchers match the automation's next run, not
      // this specific run: a scheduled run completing inside the
      // arm→dispatch window can consume the watcher first (see
      // handleAutomationRunEvent).
      let preArmedRunNow: Extract<
        SetupAppAdvisorWatchersResult,
        { ok: true }
      > | null = null;
      if (inlineWatchers && action.type === 'automation.run_now') {
        const setup = await runtime.setupWatchers(
          {
            watchers: inlineWatchers.map((watcher) => ({
              trigger: 'automation_run',
              target: { kind: 'automation', automationId: action.id },
              ...(watcher.label ? { label: watcher.label } : {}),
              ...(watcher.followUpInstruction
                ? { followUpInstruction: watcher.followUpInstruction }
                : {}),
              ...(watcher.allowDuplicate !== undefined
                ? { allowDuplicate: watcher.allowDuplicate }
                : {}),
            })),
          },
          { toolUseId: requestId },
        );
        if (!setup.ok) {
          return {
            requestId,
            ok: false,
            error: {
              code: 'execution_failed',
              message: `Inline watcher setup failed, so the automation was not run: ${setup.error}`,
            },
          };
        }
        preArmedRunNow = setup;
      }
      const rendererRequest: AppAdvisorRendererToolRequest = {
        kind: 'dispatch_action',
        requestId,
        action: rendererAction,
        originWorktreeId: destination.worktreeId,
        originProjectId: destination.projectId,
        expectedUiRevision,
        originChatTabId: destination.chatId,
      };
      const actionSurfaces = mainWindowOnlyToolSurfaces(surfaces.getMainWindow);
      const dispatchAutomation = async (
        resourceAction: AppAdvisorAction,
      ): Promise<AppAdvisorActionResponse> => {
        const { dispatchAgentResourceAction, isAgentResourceAction } =
          await import('../canopy-tools/resource-actions');
        if (!isAgentResourceAction(resourceAction)) {
          if (appAdvisorActionDisposition(resourceAction.type)?.kind === 'core')
            return {
              requestId,
              ok: false,
              error: {
                code: 'unsupported_action',
                message: APP_ADVISOR_ACTION_TEXTS.coreReachedRenderer(
                  resourceAction.type,
                ),
              },
            };
          return requestAppAdvisorRendererTool(
            { ...rendererRequest, action: resourceAction },
            actionSurfaces,
            signal ? { signal } : undefined,
          );
        }
        return dispatchAgentResourceAction(resourceAction, {
          projectId: destination.projectId,
          worktreeId: destination.worktreeId,
          chatId: destination.chatId,
          cwd: getAppAdvisorHomeDir(),
          executionScope: 'directory',
          getWindow: surfaces.getMainWindow,
        });
      };
      if (
        !action.type.startsWith('automation.') &&
        appAdvisorActionDisposition(action.type)?.kind === 'core' &&
        !(action.type === 'worktree-chat.open_tab' && action.chatId)
      )
        return {
          requestId,
          ok: false,
          error: {
            code: 'unsupported_action',
            message: APP_ADVISOR_ACTION_TEXTS.coreReachedRenderer(action.type),
          },
        };
      const rawResponse = action.type.startsWith('automation.')
        ? await dispatchAutomation(rendererAction)
        : signal
          ? await requestAppAdvisorRendererTool(
              rendererRequest,
              actionSurfaces,
              { signal },
            )
          : await requestAppAdvisorRendererTool(
              rendererRequest,
              actionSurfaces,
            );
      const actionReceipts = rawResponse.ok
        ? agentArtifactsForActionResult(action, rawResponse.result)
        : [];
      const response =
        actionReceipts.length > 0 &&
        rawResponse.ok &&
        rawResponse.result &&
        typeof rawResponse.result === 'object' &&
        !Array.isArray(rawResponse.result)
          ? withAgentArtifacts(
              { ...rawResponse, ok: true as const, result: rawResponse.result },
              actionReceipts,
            )
          : rawResponse;
      const actionResponse = {
        requestId,
        ok: response.ok,
        result:
          action.type === 'sharing.open_dialog' && response.ok
            ? {
                message:
                  'Share dialog requested; the user confirms in the app.',
              }
            : response.result,
        error: response.error,
        uiState: response.uiState,
      };
      if (preArmedRunNow) {
        if (!response.ok) {
          // The run never dispatched; remove the pre-armed watchers so they
          // do not linger waiting on a future unrelated run. Best-effort —
          // a lingering automation watcher is inert until the automation
          // actually runs.
          const createdIds = preArmedRunNow.results.flatMap((entry) =>
            entry.status === 'created' ? [entry.watcher.id] : [],
          );
          if (createdIds.length > 0) {
            await getAppAdvisorWatcherService()
              .deleteAgentWatchers({ watcherIds: createdIds }, destination)
              .catch(() => undefined);
          }
          return actionResponse;
        }
        const inlineWatcherSetup: AppAdvisorJson = {
          ok: true,
          results: preArmedRunNow.results.map((entry) => ({
            status: entry.status,
            watcher: {
              id: entry.watcher.id,
              trigger: entry.watcher.trigger,
              status: entry.watcher.status,
              label: entry.watcher.label,
              targetKind: entry.watcher.target.kind,
            },
          })),
        };
        return {
          ...actionResponse,
          result: {
            ...(isRecord(actionResponse.result) ? actionResponse.result : {}),
            inlineWatcherSetup,
          } satisfies Record<string, AppAdvisorJson>,
        };
      }
      if (response.ok && inlineWatchers && inlineWatchers.length > 0) {
        const target = buildInlineWatcherTarget(action, response.result);
        const setup = target
          ? await runtime.setupWatchers(
              {
                watchers: inlineWatchers.map((watcher) => ({
                  trigger: triggerForInlineWatcherTarget(target),
                  target,
                  ...(watcher.label ? { label: watcher.label } : {}),
                  ...(watcher.followUpInstruction
                    ? { followUpInstruction: watcher.followUpInstruction }
                    : {}),
                  ...(watcher.allowDuplicate !== undefined
                    ? { allowDuplicate: watcher.allowDuplicate }
                    : {}),
                })),
              },
              { toolUseId: requestId },
            )
          : {
              ok: false as const,
              error: `The action completed, but ${BRAND.displayName} could not determine which target to watch.`,
            };
        let result = actionResponse.result;
        if (
          action.type === 'automation.create' &&
          target?.kind === 'automation' &&
          setup.ok &&
          requestedCreateEnabled
        ) {
          const enableResponse = await dispatchAutomation({
            type: 'automation.update',
            id: target.automationId,
            patch: { enabled: true },
          });
          if (!enableResponse.ok) {
            return {
              requestId,
              ok: false,
              result: actionResponse.result,
              error:
                enableResponse.error ??
                ({
                  code: 'execution_failed',
                  message:
                    'Automation watcher was armed, but the automation could not be enabled.',
                } as const),
            };
          }
          result = enableResponse.result;
        }
        return {
          ...actionResponse,
          result: {
            ...(isRecord(result) ? result : {}),
            inlineWatcherSetup: setup as unknown as AppAdvisorJson,
          } satisfies Record<string, AppAdvisorJson>,
        };
      }
      return actionResponse;
    },

    async authorizeInstalledItemUninstall(request, toolContext) {
      const approval = createApprovalSession({
        sessionKey: `app-advisor-uninstall-${randomUUID()}`,
        projectId: destination.projectId,
        worktreeId: destination.worktreeId,
        chatId: destination.chatId,
        provider: context?.providerType ?? 'claude',
        workspaceRoot: getDataDir(),
        mode: context?.approvalMode ?? 'ask',
        sessionRules: context?.sessionApprovalRules ?? [],
        getWindow: () =>
          surfaces.getAppAdvisorWindow() ?? surfaces.getMainWindow(),
      });
      const cancel = (): void => approval.dispose();
      toolContext?.signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (toolContext?.signal?.aborted) return false;
        const outcome = await approval.check(
          { kind: 'tool', toolName: 'installed_items.uninstall' },
          {
            title: 'Uninstall installed item',
            description:
              request.target.kind === 'account-mcp'
                ? 'Remove this connection and its sign-in from the account.'
                : request.target.kind === 'mcp-server'
                  ? 'Remove this device server, every configuration and their sign-ins.'
                  : 'Remove this installed item and its saved selections.',
            details: {
              kind: 'tool',
              toolName: 'installed_items.uninstall',
              inputSummary: JSON.stringify(request.target),
            },
            toolUseId: toolContext?.toolUseId,
          },
        );
        return outcome.decision === 'allow' && !toolContext?.signal?.aborted;
      } finally {
        toolContext?.signal?.removeEventListener('abort', cancel);
        approval.dispose();
      }
    },
    getPipelineDebugContext: (executionId: string) =>
      getPipelineFailureDebugContext(executionId),

    searchWatchers: async (input: SearchAppAdvisorWatchersInput) => {
      const service = getAppAdvisorWatcherService();
      const result = await service.search(input, destination);
      if (input.includeActive === false)
        return {
          catalog: result.catalog,
          activeWatchers: [],
          activeReturned: 0,
          activeTotalMatches: 0,
        };
      const projected = await service.projectCanonicalChatWatchers({
        destination,
        recipient: { kind: 'root' },
      });
      // C projects both spellings with current access. Never publish the raw
      // chat rows (including target-derived labels) alongside that projection.
      const page = pageActiveWatchers(
        [
          ...result.activeWatchers.filter(
            (watcher) =>
              !isCanonicalChatWatcherTrigger(watcher.trigger) &&
              watcher.trigger !== 'worktree_chat_completion' &&
              watcher.trigger !== 'standalone_chat_completion' &&
              watcher.trigger !== 'worktree_new_chat_started' &&
              watcher.trigger !== 'standalone_new_chat_started',
          ),
          ...projected,
        ],
        input,
      );
      if (!page.ok) return page;
      return {
        catalog: result.catalog,
        activeWatchers: page.activeWatchers,
        activeReturned: page.activeReturned,
        activeTotalMatches: page.activeTotalMatches,
        ...(page.activeNextCursor
          ? { activeNextCursor: page.activeNextCursor }
          : {}),
      };
    },
    scheduleWakeup: (input, context) =>
      getAppAdvisorWatcherService().createLocalWatcher(
        {
          kind: 'scheduled_wakeup',
          delaySeconds: input.delaySeconds,
          scheduledFor: '',
        },
        destination,
        context?.toolUseId ?? randomUUID(),
        input.followUpInstruction,
      ),
    watchCommand: async (input, toolContext) => {
      const target = await resolveWorktreeToolTarget(
        undefined,
        undefined,
        runtime,
        destination.chatId,
      );
      if ('error' in target) throw new Error(target.error);
      const cwd = resolveWorktreeCwd(target.projectId, target.worktreeId);
      const executionScope =
        await getAppAdvisorWatcherService().captureLocalExecutionScope({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
        });
      const approval = createApprovalSession({
        sessionKey: `app-advisor-watch-command-${randomUUID()}`,
        projectId: destination.projectId,
        policyProjectId: target.projectId,
        worktreeId: destination.worktreeId,
        chatId: destination.chatId,
        provider: context?.providerType ?? 'claude',
        workspaceRoot: cwd,
        mode: context?.approvalMode ?? 'ask',
        sessionRules: context?.sessionApprovalRules ?? [],
        getWindow: () =>
          surfaces.getAppAdvisorWindow() ?? surfaces.getMainWindow(),
      });
      const onAbort = (): void => approval.invalidatePending?.();
      toolContext?.signal?.throwIfAborted();
      toolContext?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const outcome = await approval.check(
          { kind: 'command', command: input.command, cwd },
          {
            title: 'Watch this command?',
            description: `In ${cwd}; up to ${input.maxAttempts} attempts, ${input.intervalSeconds} seconds between attempts, 60-second timeout each.`,
            details: { kind: 'command', command: input.command },
            toolUseId: toolContext?.toolUseId,
          },
        );
        toolContext?.signal?.throwIfAborted();
        if (outcome.decision !== 'allow')
          throw new Error('WatchCommand registration was denied.');
      } finally {
        toolContext?.signal?.removeEventListener('abort', onAbort);
        approval.dispose();
      }
      return getAppAdvisorWatcherService().createLocalWatcher(
        {
          kind: 'command_watch',
          command: input.command,
          intervalSeconds: input.intervalSeconds,
          maxAttempts: input.maxAttempts,
          cwd,
        },
        destination,
        toolContext?.toolUseId ?? randomUUID(),
        input.followUpInstruction,
        executionScope,
      );
    },

    setupCanonicalChatWatchers: (input, context) =>
      getAppAdvisorWatcherService().setupCanonicalChatWatchers({
        watchers: input.watchers,
        destination,
        recipient: { kind: 'root' },
        ...(context?.toolUseId
          ? { createdByToolUseId: context.toolUseId }
          : {}),
      }),

    setupWatchers: (
      input: SetupAppAdvisorWatchersInput,
      context?: { toolUseId?: string },
    ) => getAppAdvisorWatcherService().setup(input, destination, context),

    watchGitHubItems: async (
      input: WatchGitHubItemsInput,
      context?: { toolUseId?: string },
    ) => {
      const cached = getCachedAppAdvisorUiStateForChat(destination.chatId);
      const selected =
        (cached ? resolveSnapshotWorktree(cached) : null) ??
        resolveSnapshotWorktree(await runtime.requestUiState());
      const repositoryCandidates =
        selected &&
        !isAppAdvisorSentinel(selected.projectId, selected.worktreeId)
          ? await resolveGitHubRepositoryCandidates(selected)
          : [];
      return getAppAdvisorWatcherService().watchGitHubItems(
        input,
        destination,
        { ...context, repositoryCandidates },
      );
    },

    loadPipelineYaml: async ({
      projectId,
      worktreeId,
      ...request
    }: AppAdvisorPipelineYamlInput) => {
      const target = await resolveWorktreeToolTarget(
        projectId,
        worktreeId,
        runtime,
        destination.chatId,
      );
      if ('error' in target) {
        return unavailablePipelineYaml(target.error);
      }
      return loadWorktreePipelineYaml({
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        ...request,
      });
    },

    loadScriptOutput: async ({
      projectId,
      worktreeId,
      scriptId,
      repo,
      maxLines,
    }: AppAdvisorScriptOutputInput) => {
      const target = await resolveWorktreeToolTarget(
        projectId,
        worktreeId,
        runtime,
        destination.chatId,
      );
      if ('error' in target) {
        return unavailableScriptOutput(target.error);
      }

      return loadWorktreeScriptOutput({
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        scriptId,
        repo,
        maxLines,
      });
    },
  };

  return runtime;
}
