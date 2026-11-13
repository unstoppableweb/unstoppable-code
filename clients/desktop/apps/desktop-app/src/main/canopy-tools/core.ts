import { executeShowCapabilities } from './show-capabilities';
import { setAutoArchiveThroughCore } from './auto-archive-core-client';
import { randomUUID } from 'node:crypto';
import {
  createWatcherReportThroughCore,
  createWatcherThroughCore,
  watcherRequestJson,
} from './watcher-core-client';
import {
  scheduleWakeupSchema,
  watchCommandSchema,
} from './local-watcher-definitions';
import type {
  McpQuestion,
  McpQuestionAnswer,
  ShowFileRequest,
  ShowFilesRendererResult,
} from '@canopy/desktop-shared/types';
import type { CanopyInjectedToolKey } from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  ASK_USER_TIMEOUT_ERROR,
  ASK_USER_TIMEOUT_MESSAGE,
  isCodeGraphInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  CODE_GRAPH_UNAVAILABLE_MESSAGE,
  isCodeGraphAvailableForWorkspace,
} from '../lib/code-graph-availability';
import { formatAskUserAnswers } from '@canopy/desktop-shared/lib/ask-user-answers';
import {
  setAutoArchiveSchema,
  setWorkEntryAutoDeleteSchema,
  setBaseBranchSchema,
  askUserQuestionSchema,
  buildOrUpdateCodeGraphSchema,
  compareChangeImpactSchema,
  detectChangedSymbolsSchema,
  explainCodeSymbolSchema,
  getCodeGraphContextSchema,
  getGitPreferencesSchema,
  saveMemorySchema,
  searchMemorySchema,
  readMemorySchema,
  getImpactRadiusSchema,
  getFileCommentsSchema,
  getReviewContextSchema,
  getScriptOutputSchema,
  queryCodeGraphSchema,
  readPipelineYamlSchema,
  searchCodeGraphSchema,
  showFilesSchema,
  showVisualSchema,
  previewVisualSchema,
  respondToFileCommentSchema,
  watchGitHubItemsSchema,
} from './definitions';
import { executePreviewVisual } from './preview-visual-runtime';
import { VISUAL_PREVIEW_BUDGETS } from '../browser/visual-preview-types';
import type { DeferredToolsExecutorRuntime } from '../deferred-tools/executor';
import {
  loadDeferredToolsThroughCore,
  searchDeferredToolsThroughCore,
} from './deferred-tools-core-client';
import type {
  PipelineYamlReadRequest,
  PipelineYamlReadResult,
} from './pipeline-yaml-reader';
import {
  AUTO_ARCHIVE_DEFERRED_FOR_BACKGROUND_WORK,
  AUTO_ARCHIVE_DEFERRED_FOR_DELEGATES,
} from '../agents/delegation/activity';
import type { ScriptOutputSnapshot } from '../mcp/script-output';
import type { WorktreeActionRuntime } from './worktree-actions';
import type { BrowserWindow } from 'electron';
import type { SendableBrowserWindow } from '../lib/window-send';
import {
  buildOrUpdateCodeGraph,
  compareChangeImpact,
  detectChangedSymbols,
  explainCodeSymbol,
  getCodeGraphContext,
  getImpactRadius,
  getReviewContext,
  queryCodeGraph,
  searchCodeGraph,
  type CodeGraphToolRuntime,
} from './code-graph-runtime';
import { setCurrentWorktreeBaseBranch } from './set-base-branch-runtime';
import { executeGetGitHubPullRequestStatus } from './github-pull-request-status';
import {
  executeLedgerInjectedTool,
  type LedgerToolsRuntime,
} from './ledger-tools-runtime';
import { classifyGitHubIntegrationAuthFailure } from '@canopy/execution-engine/agent-failures';
import { buildChatSessionKey } from '../agents/session-key';
import { recordPendingInjectedToolAuthFailure } from '../mcp/pending-auth-failures';
import { invalidAgentActionArguments as invalidArguments } from '@canopy/agent-actions';
import { executeDesktopAgentActionTool } from '../agent-actions/desktop-surface';
import { worktreeWatcherDestination } from '../agent-actions/desktop-watcher-port';
import { isChatVisualsEnabled } from '../lib/chat-visuals-feature-flag';
import { executeShowVisual, type ShowVisualHost } from './show-visual-runtime';

export { formatAskUserAnswers };

export interface AskUserQuestionInput {
  questions: McpQuestion[];
}

export interface GetScriptOutputInput {
  scriptId: string;
  repo?: string;
  maxLines?: number;
}

export interface GetGitPreferencesInput {
  type: 'branch-name' | 'pr-generation' | 'commit-message';
}

export interface SaveLocalMemoryInput {
  text: string;
  scope: 'user' | 'workspace';
  /** The provider's call identity; the save's idempotency key derives from it. */
  invocationId?: string;
}

export interface SearchLocalMemoryInput {
  query: string;
}

export interface ReadLocalMemoryInput {
  scope: 'user' | 'workspace';
  file: string;
}

export type ReadPipelineYamlInput = Omit<
  PipelineYamlReadRequest,
  'projectId' | 'worktreeId'
>;

export interface CanopyInjectedToolRuntime {
  authorizeInstalledItemUninstall?: (
    request: UninstallInstalledItemRequest,
    context?: CanopyInjectedToolContext,
  ) => Promise<boolean>;
  authorizeWatchCommand?: (input: {
    command: string;
    intervalSeconds: number;
    maxAttempts: number;
  }) => Promise<boolean>;
  requestUserAnswers(
    questions: McpQuestion[],
    options?: { toolUseId?: string; signal?: AbortSignal },
  ): Promise<McpQuestionAnswer[]>;
  loadScriptOutput(
    request: GetScriptOutputInput,
  ): Promise<ScriptOutputSnapshot>;
  loadGitPreferences?: (request: GetGitPreferencesInput) => Promise<string>;
  saveLocalMemory?: (request: SaveLocalMemoryInput) => Promise<string>;
  searchLocalMemory?: (request: SearchLocalMemoryInput) => Promise<string>;
  readLocalMemory?: (request: ReadLocalMemoryInput) => Promise<string>;
  loadPipelineYaml?: (
    request: ReadPipelineYamlInput,
  ) => Promise<PipelineYamlReadResult>;
  showFiles?: (files: ShowFileRequest[]) => Promise<ShowFilesRendererResult>;
  showVisual?: ShowVisualHost;
  getFileComments?: (request: { threadId?: string }) => Promise<{
    ok: boolean;
    text: string;
    error?: string;
  }>;
  respondToFileComment?: (request: {
    threadId: string;
    body: string;
    resolve: boolean;
  }) => Promise<{
    ok: boolean;
    resolved: boolean;
    error?: string;
    /** Which store the resolved thread lives in, when the reply succeeds. */
    store?: 'file' | 'review' | 'plan';
  }>;
  worktreeActionRuntime?: WorktreeActionRuntime;
  /**
   * The main window that opens hosted account and organization settings for
   * a chat without a `worktreeActionRuntime` (App Advisor). Worktree chats use
   * their action runtime's window instead.
   */
  settingsWindow?: () => SendableBrowserWindow | null;
  /**
   * App Advisor only: the window its pipeline runs report to. Worktree chats
   * use their action runtime's window instead.
   */
  appAdvisorPipelineWindow?: () => BrowserWindow | null;
  /**
   * App Advisor only, for one `pipeline.run` in a task: the task main
   * validated before dispatch. The Advisor chat stays the run's initiator.
   */
  appAdvisorPipelineTarget?: { projectId: string; worktreeId: string };
  worktreeWatcherRuntime?: {
    projectId: string;
    worktreeId: string;
    /** The chat that scopes the watcher; for a delegate, its root chat. */
    chatId: string;
    /**
     * Managed delegate recipient. Its watchers notify this delegate through a
     * host message instead of the chat, and only it can list or delete them.
     */
    delegationId?: string;
    /** Display-only name and depth of the `delegationId` delegate. */
    delegationDescription?: string;
    delegationDepth?: number;
    /** Command-watch working directory when it differs from the action cwd. */
    cwd?: string;
  };
  /**
   * Present only for real worktree chats (not cowork, not the App Advisor /
   * pipeline editor assistant sentinels) — mirrors the `worktreeActionRuntime`
   * gating. Backs the six code-graph tools' delegation to
   * `code-graph-runtime.ts`.
   */
  codeGraphRuntime?: CodeGraphToolRuntime;
  /**
   * Present only when the session passed the Ledger exposure gate at start
   * (`canopy-ledger-enabled`, "Agents add to the Feed" and a resolvable
   * scope). Backs AddLedgerEntry, SearchLedgerEntries and UpdateLedgerEntry,
   * which re-check the flag and setting on every call.
   */
  ledgerRuntime?: LedgerToolsRuntime;
  /** The session's own chat, whose marker SetAutoArchive sets through `core.chat.update` (CAN-6014). */
  autoArchiveChat?: { projectId: string; worktreeId: string; chatId: string };
  deferredToolsRuntime?: DeferredToolsExecutorRuntime;
  /**
   * Bespoke code-review comment-reply hook. Present only for code-review
   * sessions so the `RespondToComment` tool can post an agent reply to a
   * review comment thread and optionally resolve it. Intentionally NOT part
   * of the canonical injected-tool registry or `executeCanopyInjectedTool`
   * switch.
   */
  respondToReviewComment?: (request: {
    threadId: string;
    body: string;
    resolve: boolean;
  }) => Promise<{
    ok: boolean;
    resolved: boolean;
    error?: string;
  }>;
  /**
   * Bespoke code-review comment-read hook. Present only for code-review
   * sessions so the `GetReviewComments` tool can read comment thread history.
   * Returns a pre-formatted text summary. Intentionally NOT part of the
   * canonical injected-tool registry or `executeCanopyInjectedTool` switch.
   */
  getReviewCommentThread?: (request: { threadId?: string }) => Promise<{
    ok: boolean;
    text: string;
    error?: string;
  }>;
}

export interface CanopyInjectedToolTextResult {
  text: string;
  isError?: boolean;
  imageDataUrl?: string;
}

export interface CanopyInjectedToolContext {
  toolUseId?: string;
  codexCallId?: string;
  signal?: AbortSignal;
  imageBudgetBytes?: number;
  /**
   * The exact provider invocation identity (a Claude tool_use ID or a Codex
   * thread/turn/call ID), stable across retries and replays of one call.
   * Ledger commands derive their idempotency key from it.
   */
  invocationId?: string;
}

export async function executeCanopyInjectedTool(
  canonicalKey: CanopyInjectedToolKey,
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
  context?: CanopyInjectedToolContext,
): Promise<CanopyInjectedToolTextResult> {
  // Feature gate (shared defense-in-depth): both providers dispatch through
  // here, so this single check makes an OFF flip effective immediately even for
  // an already-running Codex session whose code-graph specs were baked in while
  // the flag was on.
  if (
    isCodeGraphInjectedToolKey(canonicalKey) &&
    runtime.codeGraphRuntime !== undefined &&
    !isCodeGraphAvailableForWorkspace(runtime.codeGraphRuntime.projectId)
  ) {
    return {
      text: CODE_GRAPH_UNAVAILABLE_MESSAGE,
      isError: true,
    };
  }
  switch (canonicalKey) {
    case 'delegate_task':
    case 'get_delegate_output':
    case 'inspect_delegate':
    case 'list_delegates':
    case 'stop_delegate':
    case 'manage_delegate_worktree':
    case 'message_delegate':
    case 'request_steering':
      // These require the provider's authenticated native call binding. The
      // committed managed parent intercepts them before this generic runtime.
      return {
        isError: true,
        text: JSON.stringify({
          ok: false,
          error: {
            code: 'capability_unavailable',
            message: 'Managed delegation is unavailable in this session.',
            retryable: false,
          },
        }),
      };
    case 'ask_user_question':
      return executeAskUserQuestion(rawArgs, runtime, context);
    case 'get_script_output':
      return executeGetScriptOutput(rawArgs, runtime);
    case 'get_git_preferences':
      return executeGetGitPreferences(rawArgs, runtime);
    case 'save_memory':
      return executeSaveMemory(rawArgs, runtime, context);
    case 'search_memory':
      return executeSearchMemory(rawArgs, runtime);
    case 'read_memory':
      return executeReadMemory(rawArgs, runtime);
    case 'read_pipeline_yaml':
      return executeReadPipelineYaml(rawArgs, runtime);
    case 'show_capabilities':
      return executeShowCapabilities(rawArgs, runtime.worktreeActionRuntime);
    case 'show_files':
      return executeShowFiles(rawArgs, runtime);
    case 'show_visual': {
      if (!runtime.showVisual)
        return {
          text: "ShowVisual isn't available in this chat.",
          isError: true,
        };
      if (!isChatVisualsEnabled())
        return { text: 'Visuals are turned off.', isError: true };
      const parsed = showVisualSchema.safeParse(rawArgs);
      if (!parsed.success)
        return {
          text: 'Check the HTML, title, and height for ShowVisual.',
          isError: true,
        };
      return executeShowVisual(parsed.data, {
        ...runtime.showVisual,
        ...(context?.codexCallId ? { codexCallId: context.codexCallId } : {}),
      });
    }
    case 'preview_visual': {
      if (!runtime.showVisual)
        return {
          text: "PreviewVisual isn't available in this chat.",
          isError: true,
        };
      if (!isChatVisualsEnabled())
        return { text: 'Visuals are turned off.', isError: true };
      const parsed = previewVisualSchema.safeParse(rawArgs);
      if (!parsed.success)
        return {
          text: 'Check the HTML, width, and appearance for PreviewVisual.',
          isError: true,
        };
      return executePreviewVisual(parsed.data, runtime.showVisual, {
        imageBudgetBytes:
          context?.imageBudgetBytes ?? VISUAL_PREVIEW_BUDGETS.acpImageBytes,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
    }
    case 'get_file_comments':
      return executeGetFileComments(rawArgs, runtime);
    case 'respond_to_file_comment':
      return executeRespondToFileComment(rawArgs, runtime);
    case 'search_actions':
    case 'dispatch_action':
    case 'search_watchers':
    case 'setup_watchers':
    case 'delete_watchers':
    case 'start_forked_agent':
    case 'start_branched_agent':
      return executeDesktopAgentActionTool(
        canonicalKey,
        rawArgs,
        runtime,
        context,
      );
    case 'watch_github_items':
      return executeWatchGitHubItems(rawArgs, runtime, context);
    case 'get_github_pull_request_status':
      return executeGetGitHubPullRequestStatus(
        rawArgs,
        context?.signal ? { signal: context.signal } : {},
      );
    case 'watch_command':
    case 'schedule_wakeup':
      return executeLocalWatcher(canonicalKey, rawArgs, runtime, context);
    case 'set_auto_archive':
      return executeSetAutoArchive(rawArgs, runtime, context);
    case 'set_work_entry_auto_delete':
      return executeSetWorkEntryAutoDelete(rawArgs, runtime);
    case 'set_base_branch':
      return executeSetBaseBranch(rawArgs, runtime, context);
    case 'get_code_graph_context':
      return executeGetCodeGraphContext(rawArgs, runtime);
    case 'build_or_update_code_graph':
      return executeBuildOrUpdateCodeGraph(rawArgs, runtime);
    case 'query_code_graph':
      return executeQueryCodeGraph(rawArgs, runtime);
    case 'search_code_graph':
      return executeSearchCodeGraph(rawArgs, runtime);
    case 'explain_code_symbol':
      return executeExplainCodeSymbol(rawArgs, runtime);
    case 'get_impact_radius':
      return executeGetImpactRadius(rawArgs, runtime);
    case 'detect_changed_symbols':
      return executeDetectChangedSymbols(rawArgs, runtime);
    case 'compare_change_impact':
      return executeCompareChangeImpact(rawArgs, runtime);
    case 'get_review_context':
      return executeGetReviewContext(rawArgs, runtime);
    case 'search_deferred_tools':
      if (!runtime.deferredToolsRuntime) {
        return {
          text: 'Deferred tool search is unavailable in this chat.',
          isError: true,
        };
      }
      return searchDeferredToolsThroughCore(
        rawArgs,
        runtime.deferredToolsRuntime,
        context?.signal ? { signal: context.signal } : {},
      );
    case 'load_deferred_tools':
      if (!runtime.deferredToolsRuntime) {
        return {
          text: 'Deferred tool loading is unavailable in this chat.',
          isError: true,
        };
      }
      return loadDeferredToolsThroughCore(
        rawArgs,
        runtime.deferredToolsRuntime,
        {
          ...(context?.toolUseId ? { toolUseId: context.toolUseId } : {}),
          ...(context?.invocationId
            ? { invocationId: context.invocationId }
            : {}),
          ...(context?.signal ? { signal: context.signal } : {}),
        },
      );
    case 'add_ledger_entry':
    case 'search_ledger_entries':
    case 'update_ledger_entry':
      return executeLedgerInjectedTool(
        canonicalKey,
        rawArgs,
        runtime.ledgerRuntime,
        {
          ...(context?.invocationId !== undefined
            ? { invocationId: context.invocationId }
            : {}),
          ...(context?.signal ? { signal: context.signal } : {}),
        },
      );
  }
}

async function executeAskUserQuestion(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
  context?: CanopyInjectedToolContext,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = askUserQuestionSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('AskUserQuestion');
  }

  const questions: McpQuestion[] = parsed.data.questions.map((question) => ({
    question: question.question,
    options: question.options,
    multiSelect: question.multiSelect,
    ...(question.control ? { control: question.control } : {}),
    ...(question.required !== undefined ? { required: question.required } : {}),
    ...(question.placeholder !== undefined
      ? { placeholder: question.placeholder }
      : {}),
  }));

  try {
    const answers = await runtime.requestUserAnswers(
      questions,
      context?.toolUseId || context?.signal
        ? {
            ...(context.toolUseId ? { toolUseId: context.toolUseId } : {}),
            ...(context.signal ? { signal: context.signal } : {}),
          }
        : undefined,
    );
    return { text: formatAskUserAnswers(answers) };
  } catch (error) {
    if (error instanceof Error && error.message === 'Window not available') {
      return {
        text: 'Window not available',
        isError: true,
      };
    }
    if (error instanceof Error && error.message === ASK_USER_TIMEOUT_ERROR) {
      return {
        text: ASK_USER_TIMEOUT_MESSAGE,
        isError: true,
      };
    }
    return {
      text: 'User dismissed the question.',
      isError: true,
    };
  }
}

async function executeGetScriptOutput(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = getScriptOutputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('GetScriptOutput');
  }

  const request: GetScriptOutputInput = {
    scriptId: parsed.data.scriptId,
    repo: parsed.data.repo,
    maxLines: parsed.data.maxLines ?? 200,
  };

  try {
    if (request.scriptId.startsWith('watcher:')) {
      const destination = worktreeWatcherDestination(runtime);
      if (!destination)
        return {
          text: 'Watcher output requires this chat’s durable scope.',
          isError: true,
        };
      // Defer the output reader because ordinary script-output calls do not
      // need the local watcher persistence and filesystem module graph.
      const { readWatcherOutputPreview } =
        await import('../app-advisor/local-watcher-output');
      return {
        text: await readWatcherOutputPreview(
          destination,
          request.scriptId,
          request.maxLines ?? 200,
        ),
      };
    }
    const snapshot = await runtime.loadScriptOutput(request);
    if (!snapshot.found || snapshot.error) {
      return {
        text:
          snapshot.error ??
          `No persisted output found for script "${parsed.data.scriptId}".`,
        isError: true,
      };
    }

    const header = `[${snapshot.label ?? snapshot.scriptKey ?? 'Script Output'} - ${snapshot.humanStatus ?? 'unknown'}]`;
    const outputText = [
      header,
      `Script ID: ${snapshot.scriptKey ?? parsed.data.scriptId}`,
      `Invocation: ${snapshot.invocation ?? 'unknown'}`,
      '---',
      snapshot.lines.length > 0
        ? snapshot.lines.join('\n')
        : 'No output available yet.',
    ].join('\n');

    return { text: outputText };
  } catch (error) {
    return {
      text: `Failed to load script output: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function executeGetGitPreferences(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = getGitPreferencesSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('GetGitPreferences');
  }
  if (!runtime.loadGitPreferences) {
    return {
      text: 'GetGitPreferences is only available for worktree chats.',
      isError: true,
    };
  }

  try {
    return {
      text: await runtime.loadGitPreferences({ type: parsed.data.type }),
    };
  } catch (error) {
    return {
      text: `Failed to load Git preferences: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function executeSaveMemory(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
  context?: CanopyInjectedToolContext,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = saveMemorySchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('SaveMemory');
  }
  if (!runtime.saveLocalMemory) {
    return {
      text: 'SaveMemory is unavailable in this chat.',
      isError: true,
    };
  }

  try {
    return {
      text: await runtime.saveLocalMemory({
        ...parsed.data,
        ...(context?.invocationId !== undefined
          ? { invocationId: context.invocationId }
          : {}),
      }),
    };
  } catch (error) {
    return {
      text: `Failed to save local memory: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function executeSearchMemory(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = searchMemorySchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('SearchMemory');
  }
  if (!runtime.searchLocalMemory) {
    return {
      text: 'SearchMemory is unavailable in this chat.',
      isError: true,
    };
  }

  try {
    return {
      text: await runtime.searchLocalMemory(parsed.data),
    };
  } catch (error) {
    return {
      text: `Failed to search local memory: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function executeReadMemory(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = readMemorySchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('ReadMemory');
  }
  if (!runtime.readLocalMemory) {
    return {
      text: 'ReadMemory is unavailable in this chat.',
      isError: true,
    };
  }

  try {
    return {
      text: await runtime.readLocalMemory(parsed.data),
    };
  } catch (error) {
    return {
      text: `Failed to read local memory: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function executeReadPipelineYaml(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = readPipelineYamlSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('ReadPipelineYaml');
  }
  if (!runtime.loadPipelineYaml) {
    return {
      text: 'ReadPipelineYaml is only available for worktree chats.',
      isError: true,
    };
  }
  const result = await runtime.loadPipelineYaml(parsed.data);
  return {
    text: result.text ?? result.error ?? 'Failed to read pipeline YAML.',
    isError: result.ok !== true,
  };
}

async function executeShowFiles(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = showFilesSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('ShowFiles', [
      'files must contain between 1 and 10 file requests.',
    ]);
  }
  if (!runtime.showFiles) {
    return {
      text: 'ShowFiles is unavailable in this chat.',
      isError: true,
    };
  }
  try {
    const result = await runtime.showFiles(parsed.data.files);
    return {
      text: JSON.stringify(result, null, 2),
      isError: result.opened === 0 && result.presentation !== 'deferred',
    };
  } catch (error) {
    return {
      text: `Failed to show files: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function executeGetFileComments(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = getFileCommentsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('GetFileComments');
  }
  if (!runtime.getFileComments) {
    return {
      text: 'GetFileComments is unavailable in this chat.',
      isError: true,
    };
  }
  const result = await runtime.getFileComments(
    parsed.data.threadId !== undefined
      ? { threadId: parsed.data.threadId }
      : {},
  );
  return {
    text: result.ok
      ? result.text
      : `Failed to read file comments: ${result.error ?? 'unknown error'}`,
    isError: !result.ok,
  };
}

async function executeRespondToFileComment(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = respondToFileCommentSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('RespondToFileComment');
  }
  if (!runtime.respondToFileComment) {
    return {
      text: 'RespondToFileComment is unavailable in this chat.',
      isError: true,
    };
  }
  const result = await runtime.respondToFileComment({
    threadId: parsed.data.threadId,
    body: parsed.data.body,
    resolve: parsed.data.resolve ?? false,
  });
  const threadKind =
    result.store === 'plan' ? 'plan comment thread' : 'file thread';
  return {
    text: result.ok
      ? `Reply posted to ${threadKind} ${parsed.data.threadId}${result.resolved ? ' and the thread was resolved' : ''}.`
      : `Reply failed: ${result.error ?? 'unknown error'}`,
    isError: !result.ok,
  };
}

async function executeLocalWatcher(
  key: 'watch_command' | 'schedule_wakeup',
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
  context?: CanopyInjectedToolContext,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = (
    key === 'watch_command' ? watchCommandSchema : scheduleWakeupSchema
  ).safeParse(rawArgs);
  if (!parsed.success)
    return invalidArguments(
      key,
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  const destination = worktreeWatcherDestination(runtime);
  if (!destination)
    return {
      text: 'This tool requires a durable chat destination.',
      isError: true,
    };
  const input = parsed.data;
  const cwd =
    runtime.worktreeWatcherRuntime?.cwd ?? runtime.worktreeActionRuntime?.cwd;
  if ('command' in input && !cwd)
    return {
      text: 'WatchCommand requires a captured working directory.',
      isError: true,
    };
  try {
    if (
      'command' in input &&
      runtime.authorizeWatchCommand &&
      !(await runtime.authorizeWatchCommand(input))
    )
      return { text: 'WatchCommand registration was denied.', isError: true };
    return await createWatcherThroughCore(
      destination,
      'command' in input
        ? {
            kind: 'command',
            command: input.command,
            intervalSeconds: input.intervalSeconds,
            maxAttempts: input.maxAttempts,
            // The host resolves the directory from the recipient (CAN-6031).
            ...(runtime.worktreeActionRuntime?.repoId
              ? { repoId: runtime.worktreeActionRuntime.repoId }
              : {}),
            ...(input.followUpInstruction !== undefined
              ? { followUpInstruction: input.followUpInstruction }
              : {}),
          }
        : {
            kind: 'wakeup',
            delaySeconds: input.delaySeconds,
            ...(input.followUpInstruction !== undefined
              ? { followUpInstruction: input.followUpInstruction }
              : {}),
          },
      {
        toolUseId: context?.toolUseId ?? randomUUID(),
        ...(context?.invocationId
          ? { invocationId: context.invocationId }
          : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
      },
    );
  } catch (error) {
    return {
      text: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}

/**
 * Publish a GitHub authentication failure raised by a Canopy-injected tool so
 * the turn renders the reconnect card instead of an opaque tool error
 * (CAN-1814 PR 4).
 *
 * Declines anything the classifier does not recognize as an authentication
 * failure, so a rate limit, an outage, a 404, or a mid-request credential swap
 * stays a plain tool error. That matters twice over: a spurious card accuses a
 * working integration, and PR 6 stops the turn on any RECOVERABLE failure, so
 * a false positive would also kill the run.
 *
 * Routed through the pending registry rather than emitted directly, because a
 * tool executor runs BEFORE its own `tool_result` block exists and the
 * `toolUseId` it is handed on the Claude path is the MCP transport's JSON-RPC
 * id, not the transcript's `tool_use` id (`http-proxy-service.ts`). The owner
 * key is the chat session key `worktree-chat-turn.ts` claims under.
 *
 * Best-effort and non-throwing: failing to attach a recovery card must never
 * turn a reported tool error into a crashed tool call.
 */
function publishGitHubIntegrationAuthFailure(
  watcherRuntime: { projectId: string; worktreeId: string; chatId: string },
  code: string,
  message: string,
): void {
  const failure = classifyGitHubIntegrationAuthFailure({
    code,
    diagnostic: message,
  });
  if (!failure) return;
  recordPendingInjectedToolAuthFailure(
    buildChatSessionKey(
      watcherRuntime.projectId,
      watcherRuntime.worktreeId,
      watcherRuntime.chatId,
    ),
    'watch_github_items',
    failure,
  );
}

async function executeWatchGitHubItems(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
  context?: CanopyInjectedToolContext,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = watchGitHubItemsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('WatchGitHubItems', [
      ...parsed.error.issues.slice(0, 3).map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'input';
        return `${path}: ${issue.message}`;
      }),
      'For every completed job use {"notifyOn":{"jobs":{"conclusions":"any"}}}.',
    ]);
  }
  const destination = worktreeWatcherDestination(runtime);
  if (!destination) {
    return {
      text: 'WatchGitHubItems is only available for worktree chats.',
      isError: true,
    };
  }
  const watcherRuntime = runtime.worktreeWatcherRuntime;
  if (!watcherRuntime) {
    return {
      text: 'WatchGitHubItems is only available for worktree chats.',
      isError: true,
    };
  }
  const repoId = runtime.worktreeActionRuntime?.repoId;
  const report = await createWatcherReportThroughCore(
    destination,
    {
      kind: 'github',
      input: watcherRequestJson(parsed.data),
      ...(repoId ? { repoId } : {}),
    },
    {
      ...(context?.toolUseId ? { toolUseId: context.toolUseId } : {}),
      ...(context?.invocationId ? { invocationId: context.invocationId } : {}),
      ...(context?.signal ? { signal: context.signal } : {}),
    },
  );
  // A delegate's failure is reported in its own tool result. Publishing it
  // under the root chat's session key would fail the root chat's turn.
  if (report.failure && !watcherRuntime.delegationId) {
    publishGitHubIntegrationAuthFailure(
      watcherRuntime,
      report.failure.code,
      report.failure.message,
    );
  }
  return {
    text: report.report,
    isError: !report.accepted,
  };
}

async function executeSetAutoArchive(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
  context?: CanopyInjectedToolContext,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = setAutoArchiveSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('SetChatAutoArchive');
  }
  const chat = runtime.autoArchiveChat;
  if (!chat) {
    return {
      text: 'SetChatAutoArchive is only available for chats.',
      isError: true,
    };
  }

  await setAutoArchiveThroughCore(chat, parsed.data.enabled, {
    ...(context?.invocationId ? { invocationId: context.invocationId } : {}),
  });
  // The flag stays set; the archive waits until close-blocking work finishes.
  if (parsed.data.enabled) {
    const { chatCloseBlockReason } = await import('../agents/background-work');
    const reason = chatCloseBlockReason(
      chat.projectId,
      chat.worktreeId,
      chat.chatId,
    );
    if (reason === 'delegates')
      return { text: AUTO_ARCHIVE_DEFERRED_FOR_DELEGATES };
    if (reason === 'background')
      return { text: AUTO_ARCHIVE_DEFERRED_FOR_BACKGROUND_WORK };
  }
  return {
    text: parsed.data.enabled
      ? 'Auto-archive is enabled for this chat when the current agent turn completes.'
      : 'Auto-archive is disabled for this chat; it will stay open when the current agent turn completes.',
  };
}

async function executeSetWorkEntryAutoDelete(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = setWorkEntryAutoDeleteSchema.safeParse(rawArgs);
  if (!parsed.success) return invalidArguments('SetWorkEntryAutoDelete');
  const chat = runtime.worktreeWatcherRuntime;
  if (!chat) {
    return {
      text: 'SetWorkEntryAutoDelete is only available for chats in a worktree or work entry.',
      isError: true,
    };
  }
  if (chat.delegationId !== undefined) {
    return {
      text: 'SetWorkEntryAutoDelete is only available to the chat that owns this work entry, not to delegates.',
      isError: true,
    };
  }
  const { setWorkEntryAutoDeleteFromAgent } =
    await import('../lib/work-entry-auto-delete');
  const result = await setWorkEntryAutoDeleteFromAgent({
    workspaceId: chat.projectId,
    targetId: chat.worktreeId,
    chatId: chat.chatId,
    ...parsed.data,
  });
  return { text: result.message, isError: !result.ok };
}

async function executeSetBaseBranch(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
  context?: CanopyInjectedToolContext,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = setBaseBranchSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('SetBaseBranch');
  }
  const worktreeRuntime = runtime.worktreeActionRuntime;
  if (
    !worktreeRuntime ||
    (worktreeRuntime.executionScope ?? 'worktree') !== 'worktree'
  ) {
    return {
      text: 'SetBaseBranch is only available for worktree chats.',
      isError: true,
    };
  }

  const response = await setCurrentWorktreeBaseBranch(
    parsed.data,
    worktreeRuntime,
    (questions) =>
      runtime.requestUserAnswers(
        questions,
        context?.toolUseId || context?.signal
          ? {
              ...(context.toolUseId ? { toolUseId: context.toolUseId } : {}),
              ...(context.signal ? { signal: context.signal } : {}),
            }
          : undefined,
      ),
    context,
  );
  return {
    text: JSON.stringify(
      {
        ok: response.ok,
        result: response.result,
        error: response.error,
      },
      null,
      2,
    ),
    isError: response.ok !== true,
  };
}

async function executeGetCodeGraphContext(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = getCodeGraphContextSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('GetCodeGraphContext');
  }
  if (!runtime.codeGraphRuntime) {
    return {
      text: 'GetCodeGraphContext is only available for worktree chats.',
      isError: true,
    };
  }

  const result = await getCodeGraphContext(runtime.codeGraphRuntime);
  // Every code-graph tool below flags isError only on a true 'error' status.
  // A 'status: unavailable' result (no graph yet, or a non-worktree target) is
  // deliberately NOT an error: it is an actionable envelope carrying
  // suggestedNextTools (e.g. BuildOrUpdateCodeGraph). This intentionally
  // diverges from GetScriptOutput's precedent, where a not-found script is
  // reported as isError.
  return {
    text: JSON.stringify(result, null, 2),
    isError: result.status === 'error',
  };
}

async function executeBuildOrUpdateCodeGraph(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = buildOrUpdateCodeGraphSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('BuildOrUpdateCodeGraph');
  }
  if (!runtime.codeGraphRuntime) {
    return {
      text: 'BuildOrUpdateCodeGraph is only available for worktree chats.',
      isError: true,
    };
  }

  const result = await buildOrUpdateCodeGraph(runtime.codeGraphRuntime);
  if (
    result.status === 'unavailable' &&
    result.summary === CODE_GRAPH_UNAVAILABLE_MESSAGE
  ) {
    return { text: CODE_GRAPH_UNAVAILABLE_MESSAGE, isError: true };
  }
  return {
    text: JSON.stringify(result, null, 2),
    isError: result.status === 'error',
  };
}

async function executeQueryCodeGraph(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = queryCodeGraphSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('QueryCodeGraph');
  }
  if (!runtime.codeGraphRuntime) {
    return {
      text: 'QueryCodeGraph is only available for worktree chats.',
      isError: true,
    };
  }

  const result = await queryCodeGraph(runtime.codeGraphRuntime, parsed.data);
  return {
    text: JSON.stringify(result, null, 2),
    isError: result.status === 'error',
  };
}

async function executeSearchCodeGraph(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = searchCodeGraphSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('SearchCodeGraph');
  }
  if (!runtime.codeGraphRuntime) {
    return {
      text: 'SearchCodeGraph is only available for worktree chats.',
      isError: true,
    };
  }

  const result = await searchCodeGraph(runtime.codeGraphRuntime, parsed.data);
  return {
    text: JSON.stringify(result, null, 2),
    isError: result.status === 'error',
  };
}

async function executeExplainCodeSymbol(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = explainCodeSymbolSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('ExplainCodeSymbol');
  }
  if (!runtime.codeGraphRuntime) {
    return {
      text: 'ExplainCodeSymbol is only available for worktree chats.',
      isError: true,
    };
  }

  const result = await explainCodeSymbol(runtime.codeGraphRuntime, parsed.data);
  return {
    text: JSON.stringify(result, null, 2),
    isError: result.status === 'error',
  };
}

async function executeGetImpactRadius(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = getImpactRadiusSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('GetImpactRadius');
  }
  if (!runtime.codeGraphRuntime) {
    return {
      text: 'GetImpactRadius is only available for worktree chats.',
      isError: true,
    };
  }

  const result = await getImpactRadius(runtime.codeGraphRuntime, parsed.data);
  return {
    text: JSON.stringify(result, null, 2),
    isError: result.status === 'error',
  };
}

async function executeDetectChangedSymbols(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = detectChangedSymbolsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('DetectChangedSymbols');
  }
  if (!runtime.codeGraphRuntime) {
    return {
      text: 'DetectChangedSymbols is only available for worktree chats.',
      isError: true,
    };
  }

  const result = await detectChangedSymbols(
    runtime.codeGraphRuntime,
    parsed.data,
  );
  return {
    text: JSON.stringify(result, null, 2),
    isError: result.status === 'error',
  };
}

async function executeCompareChangeImpact(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = compareChangeImpactSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('CompareChangeImpact');
  }
  if (!runtime.codeGraphRuntime) {
    return {
      text: 'CompareChangeImpact is only available for worktree chats.',
      isError: true,
    };
  }

  const result = await compareChangeImpact(
    runtime.codeGraphRuntime,
    parsed.data,
  );
  return {
    text: JSON.stringify(result, null, 2),
    isError: result.status === 'error',
  };
}

async function executeGetReviewContext(
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
): Promise<CanopyInjectedToolTextResult> {
  const parsed = getReviewContextSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return invalidArguments('GetReviewContext');
  }
  if (!runtime.codeGraphRuntime) {
    return {
      text: 'GetReviewContext is only available for worktree chats.',
      isError: true,
    };
  }

  const result = await getReviewContext(runtime.codeGraphRuntime, parsed.data);
  return {
    text: JSON.stringify(result, null, 2),
    isError: result.status === 'error',
  };
}
import type { UninstallInstalledItemRequest } from '@canopy/protocol/installed-items';
