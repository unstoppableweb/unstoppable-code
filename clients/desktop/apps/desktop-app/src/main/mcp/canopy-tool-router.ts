import { isWatchDelegatesCompatibilityName } from '@canopy/desktop-shared/node/delegation/watch-delegates-tombstone';
import { randomUUID } from 'node:crypto';
import { createShowVisualHost } from '../canopy-tools/show-visual-host';
import { BRAND } from '@canopy/brand/current';
import type { ClaudeTerminalHookCallbackBody } from '@canopy/desktop-shared/lib/desktop-integration-transport';
import {
  ASK_USER_TIMEOUT_MS,
  CANOPY_INJECTED_TOOL_REGISTRY,
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  isCodeGraphInjectedToolKey,
  isInvocationKeyedInjectedToolKey,
  isLedgerInjectedToolKey,
  type CanopyInjectedToolKey,
  type CanopyInjectedToolSurface,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  isAppAdvisorLedgerToolKey,
  type AppAdvisorToolKey,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import type { PipelineEditorToolKey } from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import {
  type ChatModel,
  type ChatTabPluginSelections,
  type AgentProviderType,
  type McpQuestionAnswer,
} from '@canopy/desktop-shared/types';
import {
  isClaudeWorkerToolExposed,
  type ClaudeWorkerMemoryToolExposure,
} from '../integration/claude-worker-tool-exposure';
import {
  isRecord,
  jsonRpcError,
  jsonRpcInternalError,
} from './integration-http';
import {
  executeCanopyInjectedTool,
  type CanopyInjectedToolContext,
  type CanopyInjectedToolRuntime,
  type CanopyInjectedToolTextResult,
} from '../canopy-tools/core';
import { CODE_GRAPH_UNAVAILABLE_MESSAGE } from '../lib/code-graph-availability';
import {
  getReviewCommentsSchema,
  respondToCommentSchema,
} from '../canopy-tools/definitions';
import { chatVisualsEligible } from '../lib/chat-visuals-feature-flag';
import { VISUAL_PREVIEW_BUDGETS } from '../browser/visual-preview-types';
import {
  ledgerUnavailableResult,
  type LedgerToolsRuntime,
} from '../canopy-tools/ledger-tools-runtime';
import {
  loadWorktreePipelineYaml,
  loadWorktreeScriptOutput,
  loadGitPreferences,
  saveLocalMemory,
  searchLocalMemory,
  readLocalMemory,
  getFileCommentsInSession,
  respondToFileCommentInSession,
} from '../canopy-tools/session-runtime';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import type { AppAdvisorToolRuntime } from '../app-advisor/runtime';
import {
  executeAppAdvisorTool,
  type AppAdvisorToolContext,
} from '../app-advisor/tool-executor';
import type { PipelineEditorToolRuntime } from '../pipeline-editor/runtime';
import { executePipelineEditorTool } from '../pipeline-editor/tool-executor';
import {
  getCanopyRouteTools,
  type CanopyRouteTool,
  getClaudeCanopyToolKey,
  getClaudeCanopyToolSurface,
  getClaudeTerminalAppAdvisorToolKey,
  getClaudeTerminalPipelineEditorToolKey,
  getClaudeToolUseId,
  GET_REVIEW_COMMENTS_TOOL_NAME,
  REPORT_STRUCTURED_RESULT_TOOL_NAME,
  RESPOND_TO_COMMENT_TOOL_NAME,
  toMcpToolResult,
} from './canopy-route-tools';
import type { InterfaceToolRequests } from './interface-tool-requests';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import { hasInterfaceTool } from '../agents/interface-tool-binding';

export interface CanopyMcpRequestContext {
  onAskUserRequestCreated?: (requestId: string) => void;
  signal?: AbortSignal;
}

export type ClaudeTerminalHookHandler = (
  body: ClaudeTerminalHookCallbackBody,
) => unknown;

export interface CanopyWorktreeSessionRoute {
  /** Owning native turn lifetime. Host-only and never restored from disk. */
  turnSignal?: AbortSignal;
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  assistantMode?: 'default' | 'app-advisor' | 'pipeline-editor';
  toolSurface?: CanopyInjectedToolSurface;
  cwd?: string;
  repoId?: string;
  sdkSessionId: string;
  authToken: string;
  createdAt: number;
  hookHandler: ClaudeTerminalHookHandler;
  /** Immutable Code Graph advertisement decision captured at route creation. */
  codeGraphToolsAdvertised?: boolean;
  /** Interface tools bound at route creation (CAN-4131). Absent means none. Never restored from a persisted route. */
  interfaceTools?: readonly InterfaceToolName[];
  /**
   * Host-only Ledger tool runtime, present only when the session passed the
   * Ledger exposure gate when it started. Without it the route neither
   * advertises nor runs AddLedgerEntry, SearchLedgerEntries or
   * UpdateLedgerEntry. Never restored from a persisted route.
   */
  ledgerTools?: LedgerToolsRuntime;
  appAdvisorRuntime?: AppAdvisorToolRuntime;
  pipelineEditorRuntime?: PipelineEditorToolRuntime;
  model?: ChatModel;
  providerType?: AgentProviderType;
  pluginSelections?: ChatTabPluginSelections;
  deferredToolsAllowed?: boolean;
  onAwaitingUser?: () => void;
  /** Host-only receipt preparation before writing a native provider's tool result.
   * The host must acknowledge the coordinator from its native completion event. */
  nativeToolResultDelivery?: (receipt: {
    requestId: string;
    toolUseId: string;
    result: unknown;
  }) => void;
  /** Host-only native call binding. Never restored from a persisted MCP route. */
  managedDelegation?: {
    /** Child routes expose only these host-owned tools. */
    exclusive?: boolean;
    tools: readonly {
      name: string;
      description: string;
      inputSchema: JsonValue;
    }[];
    invoke: (
      name: string,
      input: unknown,
      context?: { requestId?: string },
    ) => Promise<CanopyInjectedToolTextResult>;
  };
  /** The route's chat may use SetAutoArchive, which writes through `core.chat.update` (CAN-6014). */
  autoArchiveAvailable?: true;
  /**
   * Execution-time policy gate consulted before any injected tool on this
   * route runs. Claude and managed-terminal calls are gated before they reach
   * this seam; a Cursor route supplies its own gate because the ACP permission
   * request is advisory and a CLI may skip it. Returning `false` answers the
   * call with a denial error and runs nothing.
   */
  authorizeToolCall?: (
    key: CanopyInjectedToolKey | AppAdvisorToolKey | PipelineEditorToolKey,
    args: Record<string, unknown>,
    context?: { requestId?: string },
  ) => Promise<boolean>;
  /** Advertise the bespoke code-review tools only in code-review sessions. */
  isCodeReview?: boolean;
  respondToReviewComment?: CanopyInjectedToolRuntime['respondToReviewComment'];
  getReviewCommentThread?: CanopyInjectedToolRuntime['getReviewCommentThread'];
  reportStructuredResultSchema?: Record<string, unknown>;
  onReportStructuredResult?: (payload: unknown) => {
    ok: boolean;
    error?: string;
  };
  /**
   * Memory-tool exposure for `claude-worker` routes, derived from the worker's
   * launch permission via `resolveClaudeWorkerMemoryToolExposure` and captured
   * immutably at route creation. Fail-closed: when absent, a `claude-worker`
   * route advertises and dispatches no memory tools.
   */
  workerMemoryToolExposure?: ClaudeWorkerMemoryToolExposure;
}

export interface CanopyToolRouterOptions {
  readonly interfaceRequests: InterfaceToolRequests;
}

/**
 * The Canopy tools each agent session reaches through its session MCP server
 * (CAN-4125): session routes, listing and tool calls. Presentation goes
 * through the interface port only; core state goes through canonical
 * operations where a tool family has them (agent-core-operations.ts, PR4).
 */
export class CanopyToolRouter {
  private readonly options: CanopyToolRouterOptions;
  private worktreeSessionRoutes = new Map<string, CanopyWorktreeSessionRoute>();
  private localWatcherRegistrationIds = new WeakMap<
    CanopyWorktreeSessionRoute,
    string
  >();

  private localWatcherToolCallId(
    route: CanopyWorktreeSessionRoute,
    id: string | number,
  ): string {
    let registrationId = this.localWatcherRegistrationIds.get(route);
    if (!registrationId) {
      registrationId = randomUUID();
      this.localWatcherRegistrationIds.set(route, registrationId);
    }
    return `${registrationId}:${String(id)}`;
  }

  /**
   * The provider invocation behind a Ledger tool call. The bundled Claude CLI
   * (native chats and the managed terminal) sends the call's tool_use ID as
   * `_meta["claudecode/toolUseId"]`, and it resends the same ID when it
   * retries the call after MCP session recovery, so a key derived from it
   * dedupes retries. Without it the route falls back to its per-registration
   * nonce plus the JSON-RPC request ID: unique per call on this route, but a
   * transport-level retry gets a new ID and cannot dedupe. The pinned Cursor
   * CLI calls tools with only a name and arguments (its ACP tool call ID never
   * reaches the MCP request), so Cursor routes always take the fallback; each
   * Cursor turn registers a new route, so its IDs never repeat across turns.
   */
  private ledgerInvocationContext(
    route: CanopyWorktreeSessionRoute,
    id: unknown,
    meta: unknown,
  ): Pick<CanopyInjectedToolContext, 'invocationId'> {
    const toolUseId = getClaudeToolUseId(meta);
    if (toolUseId) {
      return { invocationId: `claude:${toolUseId}` };
    }
    return typeof id === 'string' || typeof id === 'number'
      ? { invocationId: `mcp:${this.localWatcherToolCallId(route, id)}` }
      : {};
  }

  /**
   * The tool-use ID an App Advisor or Pipeline Editor call hands its runtime,
   * which becomes the renderer request ID its response is cached under. The
   * Claude CLI's `_meta` tool_use ID keeps a retry after MCP session recovery
   * on the same cached response. Never the bare JSON-RPC ID: every connection
   * counts from 1, so it would replay another chat's response (CAN-3976).
   */
  private assistantToolUseId(
    route: CanopyWorktreeSessionRoute,
    id: string | number,
    meta: unknown,
  ): string {
    return getClaudeToolUseId(meta) ?? this.localWatcherToolCallId(route, id);
  }

  /**
   * The tool-use ID a tools/call hands its runtime. A `LoadDeferredTools`
   * reload is registered under it, so result delivery must mark the same ID
   * or the reload never starts. Worktree chats keep the JSON-RPC ID; their
   * reload scope is already per chat. Public for the transport's native
   * result delivery.
   */
  routeToolUseId(
    route: CanopyWorktreeSessionRoute,
    id: string | number,
    meta: unknown,
  ): string {
    return route.assistantMode === 'app-advisor' ||
      route.assistantMode === 'pipeline-editor'
      ? this.assistantToolUseId(route, id, meta)
      : String(id);
  }

  constructor(options: CanopyToolRouterOptions) {
    this.options = options;
  }

  register(route: CanopyWorktreeSessionRoute): void {
    this.worktreeSessionRoutes.set(route.sessionKey, route);
  }

  unregister(sessionKey: string): void {
    this.worktreeSessionRoutes.delete(sessionKey);
  }

  route(sessionKey: string): CanopyWorktreeSessionRoute | undefined {
    return this.worktreeSessionRoutes.get(sessionKey);
  }

  get size(): number {
    return this.worktreeSessionRoutes.size;
  }

  clear(): void {
    this.worktreeSessionRoutes.clear();
  }

  updateDeferredToolsAllowed(sessionKey: string, allowed: boolean): boolean {
    const route = this.worktreeSessionRoutes.get(sessionKey);
    if (!route) return false;
    route.deferredToolsAllowed = allowed;
    if (route.appAdvisorRuntime?.deferredToolsRuntime) {
      route.appAdvisorRuntime.deferredToolsRuntime.allowed = allowed;
    }
    return true;
  }

  updatePluginSelections(
    sessionKey: string,
    pluginSelections: ChatTabPluginSelections,
  ): boolean {
    const route = this.worktreeSessionRoutes.get(sessionKey);
    if (!route) return false;
    route.pluginSelections = pluginSelections;
    if (route.appAdvisorRuntime?.deferredToolsRuntime) {
      route.appAdvisorRuntime.deferredToolsRuntime.pluginSelections =
        pluginSelections;
    }
    return true;
  }

  /** Throws the same error as before for an unknown key. */
  capabilityDefinitions(sessionKey: string): {
    main: readonly CanopyRouteTool[];
    ui: readonly CanopyRouteTool[];
  } {
    const route = this.worktreeSessionRoutes.get(sessionKey);
    if (!route) throw new Error('The MCP session route is unavailable.');
    return {
      main: getCanopyRouteTools(route, false),
      ui: getCanopyRouteTools(route, true),
    };
  }

  /** Answers one `tools/call`: the branch body moved from handleCanopyMcpJsonRpc. */
  async callTool(
    route: CanopyWorktreeSessionRoute,
    call: {
      id: unknown;
      params: Record<string, unknown>;
      uiServer: boolean;
      requestContext?: CanopyMcpRequestContext;
    },
  ): Promise<Record<string, unknown>> {
    const { id, params, uiServer, requestContext } = call;
    const effectiveSurface: CanopyInjectedToolSurface = uiServer
      ? 'native-sdk-ui'
      : getClaudeCanopyToolSurface(route);
    if (
      !uiServer &&
      typeof params.name === 'string' &&
      route.managedDelegation &&
      (route.managedDelegation.tools.some(
        (tool) => tool.name === params.name,
      ) ||
        (!route.managedDelegation.exclusive &&
          isWatchDelegatesCompatibilityName(params.name, 'claude')))
    ) {
      const result = await route.managedDelegation.invoke(
        params.name,
        params.arguments,
        {
          ...(typeof id === 'string' || typeof id === 'number'
            ? { requestId: String(id) }
            : {}),
        },
      );
      return { jsonrpc: '2.0', id, result: toMcpToolResult(result) };
    }
    if (route.managedDelegation?.exclusive)
      return {
        jsonrpc: '2.0',
        id,
        result: toMcpToolResult({
          text: 'This tool is not available to this delegated task.',
          isError: true,
        }),
      };
    if (
      params.name === REPORT_STRUCTURED_RESULT_TOOL_NAME &&
      route.onReportStructuredResult
    ) {
      const result = route.onReportStructuredResult(params.arguments ?? {});
      return {
        jsonrpc: '2.0',
        id,
        result: toMcpToolResult({
          text: result.ok
            ? 'Structured result recorded. Stop now.'
            : `The ReportStructuredResult arguments did not match the required schema: ${result.error ?? 'validation failed'}. Fix the arguments and call ReportStructuredResult again before stopping.`,
          isError: !result.ok,
        }),
      };
    }
    if (route.assistantMode === 'app-advisor') {
      const canonicalKey = getClaudeTerminalAppAdvisorToolKey(params.name);
      if (!canonicalKey) {
        return jsonRpcError(id, -32602, 'Unknown Orchestrator MCP tool');
      }
      const allowedOnSurface = uiServer
        ? canonicalKey === 'ask_user_question'
        : canonicalKey !== 'ask_user_question';
      if (!allowedOnSurface) {
        return jsonRpcError(id, -32602, 'Unknown Orchestrator MCP tool');
      }
      if (!route.appAdvisorRuntime) {
        return jsonRpcError(id, -32603, 'Orchestrator runtime unavailable');
      }
      // Ledger calls run only on this session's own Ledger tools, bound to
      // the Work Entry it started in. A session without them refuses the
      // call before any approval prompt, as worktree routes do.
      const isLedgerCall = isAppAdvisorLedgerToolKey(canonicalKey);
      if (isLedgerCall && route.ledgerTools === undefined) {
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult(ledgerUnavailableResult('no_ledger_scope')),
        };
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      try {
        // Claude and Codex are gated before they reach this seam; a Cursor
        // route installs its own gate because the ACP permission request is
        // advisory. Same denial shape as the worktree branch. The gate runs
        // inside the try so a gate that throws (a disposed approval session)
        // still answers the request instead of leaving the CLI waiting.
        if (
          route.authorizeToolCall &&
          !(await route.authorizeToolCall(
            canonicalKey,
            args,
            typeof id === 'string' || typeof id === 'number'
              ? { requestId: String(id) }
              : undefined,
          ))
        ) {
          return {
            jsonrpc: '2.0',
            id,
            result: toMcpToolResult({
              text: `${APP_ADVISOR_TOOL_REGISTRY[canonicalKey].displayName} was denied.`,
              isError: true,
            }),
          };
        }
        const action = isRecord(args.action) ? args.action : undefined;
        const isBaseBranchDispatch =
          canonicalKey === 'dispatch_action' &&
          action?.type === 'worktree.set_base_branch';
        const toolContext: AppAdvisorToolContext = {
          ...(!isBaseBranchDispatch &&
          (typeof id === 'string' || typeof id === 'number')
            ? {
                toolUseId:
                  canonicalKey === 'schedule_wakeup' ||
                  canonicalKey === 'watch_command'
                    ? this.localWatcherToolCallId(route, id)
                    : this.routeToolUseId(route, id, params._meta),
              }
            : {}),
          ...(requestContext?.signal ? { signal: requestContext.signal } : {}),
          ...(route.interfaceTools
            ? { interfaceTools: route.interfaceTools }
            : {}),
          ...(isLedgerCall && route.ledgerTools
            ? {
                ...this.ledgerInvocationContext(route, id, params._meta),
                ledgerRuntime: route.ledgerTools,
              }
            : {}),
          // SetAutoArchive keys its write by the provider invocation too.
          ...(canonicalKey === 'set_auto_archive'
            ? this.ledgerInvocationContext(route, id, params._meta)
            : {}),
        };
        const result = await executeAppAdvisorTool(
          canonicalKey,
          args,
          route.appAdvisorRuntime,
          Object.keys(toolContext).length > 0 ? toolContext : undefined,
        );
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult(result),
        };
      } catch (error) {
        return jsonRpcInternalError(id, error);
      }
    }
    if (route.assistantMode === 'pipeline-editor') {
      const canonicalKey = getClaudeTerminalPipelineEditorToolKey(params.name);
      if (!canonicalKey) {
        return jsonRpcError(id, -32602, 'Unknown Pipeline Editor MCP tool');
      }
      const allowedOnSurface = uiServer
        ? canonicalKey === 'ask_user_question'
        : canonicalKey !== 'ask_user_question';
      if (!allowedOnSurface) {
        return jsonRpcError(id, -32602, 'Unknown Pipeline Editor MCP tool');
      }
      if (!route.pipelineEditorRuntime) {
        return jsonRpcError(id, -32603, 'Pipeline Editor runtime unavailable');
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (
        (route.providerType === 'cursor' && !route.authorizeToolCall) ||
        (route.authorizeToolCall &&
          !(await route.authorizeToolCall(
            canonicalKey,
            args,
            typeof id === 'string' || typeof id === 'number'
              ? { requestId: String(id) }
              : undefined,
          )))
      )
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult({
            text: 'This Pipeline Assistant tool was denied.',
            isError: true,
          }),
        };
      try {
        const result = await executePipelineEditorTool(
          canonicalKey,
          args,
          route.pipelineEditorRuntime,
          {
            ...(typeof id === 'string' || typeof id === 'number'
              ? { toolUseId: this.routeToolUseId(route, id, params._meta) }
              : {}),
            ...(requestContext?.signal
              ? { signal: requestContext.signal }
              : {}),
          },
        );
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult(result),
        };
      } catch (error) {
        return jsonRpcInternalError(id, error);
      }
    }
    if (
      params.name === RESPOND_TO_COMMENT_TOOL_NAME &&
      route.isCodeReview &&
      route.respondToReviewComment
    ) {
      const respondFn = route.respondToReviewComment;
      const parsed = respondToCommentSchema.safeParse(params.arguments);
      if (!parsed.success) {
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult({
            text: 'Invalid RespondToComment arguments.',
            isError: true,
          }),
        };
      }
      try {
        const result = await respondFn({
          threadId: parsed.data.threadId,
          body: parsed.data.body,
          resolve: parsed.data.resolve ?? false,
        });
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult({
            text: result.ok
              ? `Reply posted to thread ${parsed.data.threadId}${result.resolved ? ' and the thread was resolved' : ''}.`
              : `Reply failed: ${result.error ?? 'unknown error'}`,
            isError: !result.ok,
          }),
        };
      } catch (error) {
        return jsonRpcInternalError(id, error);
      }
    }
    if (
      params.name === GET_REVIEW_COMMENTS_TOOL_NAME &&
      route.isCodeReview &&
      route.getReviewCommentThread
    ) {
      const getCommentsFn = route.getReviewCommentThread;
      const parsed = getReviewCommentsSchema.safeParse(params.arguments);
      if (!parsed.success) {
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult({
            text: 'Invalid GetReviewComments arguments.',
            isError: true,
          }),
        };
      }
      try {
        const result = await getCommentsFn(
          parsed.data.threadId !== undefined
            ? { threadId: parsed.data.threadId }
            : {},
        );
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult({
            text: result.ok
              ? result.text
              : `Failed to read comments: ${result.error ?? 'unknown error'}`,
            isError: !result.ok,
          }),
        };
      } catch (error) {
        return jsonRpcInternalError(id, error);
      }
    }
    const canonicalKey = getClaudeCanopyToolKey(params.name, effectiveSurface);
    if (!canonicalKey) {
      return jsonRpcError(id, -32602, `Unknown ${BRAND.displayName} MCP tool`);
    }
    if (
      (canonicalKey === 'show_visual' || canonicalKey === 'preview_visual') &&
      !chatVisualsEligible({
        providerType: route.providerType,
        surface: effectiveSurface,
        assistantMode: route.assistantMode,
        key: canonicalKey,
      })
    ) {
      return {
        jsonrpc: '2.0',
        id,
        result: toMcpToolResult({
          text: `${canonicalKey === 'preview_visual' ? 'PreviewVisual' : 'ShowVisual'} isn't available in this chat.`,
          isError: true,
        }),
      };
    }
    if (
      getClaudeCanopyToolSurface(route) === 'claude-worker' &&
      !isClaudeWorkerToolExposed(
        canonicalKey,
        route.workerMemoryToolExposure ?? 'none',
        route.ledgerTools !== undefined,
      )
    ) {
      // Workers run with bypassPermissions, so an unadvertised tool must
      // also be refused at dispatch or a prompted worker could still call it.
      return jsonRpcError(id, -32602, `Unknown ${BRAND.displayName} MCP tool`);
    }
    if (
      route.codeGraphToolsAdvertised === false &&
      isCodeGraphInjectedToolKey(canonicalKey)
    ) {
      return {
        jsonrpc: '2.0',
        id,
        result: toMcpToolResult({
          text: CODE_GRAPH_UNAVAILABLE_MESSAGE,
          isError: true,
        }),
      };
    }
    if (
      route.ledgerTools === undefined &&
      isLedgerInjectedToolKey(canonicalKey)
    ) {
      return {
        jsonrpc: '2.0',
        id,
        result: toMcpToolResult(ledgerUnavailableResult('no_ledger_scope')),
      };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      if (
        route.authorizeToolCall &&
        !(await route.authorizeToolCall(
          canonicalKey,
          args,
          typeof id === 'string' || typeof id === 'number'
            ? { requestId: String(id) }
            : undefined,
        ))
      )
        return {
          jsonrpc: '2.0',
          id,
          result: toMcpToolResult({
            text: `${CANOPY_INJECTED_TOOL_REGISTRY[canonicalKey].displayName} was denied.`,
            isError: true,
          }),
        };
      // The MCP JSON-RPC request id is transport-local and is not the
      // Claude transcript's tool_use id. Projecting it would make the
      // browser try to correlate (for example) `"2"` with
      // `toolu_...`, preventing the question-text match (which only
      // id-less records may use) from finding the question. Codex supplies its
      // real `codex-*` call id through the native dynamic-tool path rather
      // than this Claude HTTP proxy. SetBaseBranch also suppresses the
      // transport id because its renderer request id has process-wide
      // deduplication scope.
      // A pipeline run replays by tool call. The bare request id restarts
      // per connection, so it takes Claude's tool_use id, which a retry
      // resends, or this registration's id, as App Advisor's calls do.
      const pipelineRun =
        canonicalKey === 'dispatch_action' &&
        isRecord(args.action) &&
        args.action.type === 'pipeline.run';
      const toolCallOptions: CanopyInjectedToolContext = {
        ...(canonicalKey !== 'ask_user_question' &&
        canonicalKey !== 'set_base_branch' &&
        (typeof id === 'string' || typeof id === 'number')
          ? {
              toolUseId: pipelineRun
                ? this.assistantToolUseId(route, id, params._meta)
                : canonicalKey === 'schedule_wakeup' ||
                    canonicalKey === 'watch_command'
                  ? this.localWatcherToolCallId(route, id)
                  : this.routeToolUseId(route, id, params._meta),
            }
          : {}),
        ...(requestContext?.signal ? { signal: requestContext.signal } : {}),
        ...(canonicalKey === 'preview_visual'
          ? {
              imageBudgetBytes:
                route.providerType === 'cursor' ||
                route.providerType === 'opencode'
                  ? VISUAL_PREVIEW_BUDGETS.acpImageBytes
                  : VISUAL_PREVIEW_BUDGETS.claudeImageBytes,
            }
          : {}),
        ...(isInvocationKeyedInjectedToolKey(canonicalKey)
          ? this.ledgerInvocationContext(route, id, params._meta)
          : {}),
      };
      const result = await executeCanopyInjectedTool(
        canonicalKey,
        args,
        this.createToolRuntime(
          route,
          canonicalKey,
          effectiveSurface,
          requestContext,
        ),
        Object.keys(toolCallOptions).length > 0 ? toolCallOptions : undefined,
      );
      return {
        jsonrpc: '2.0',
        id,
        result: toMcpToolResult(result),
      };
    } catch (error) {
      return jsonRpcInternalError(id, error);
    }
  }

  private createToolRuntime(
    route: CanopyWorktreeSessionRoute,
    canonicalKey: CanopyInjectedToolKey,
    surface: CanopyInjectedToolSurface,
    requestContext?: CanopyMcpRequestContext,
  ): CanopyInjectedToolRuntime {
    const askUserAllowed =
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[surface].includes(
        'ask_user_question',
      );
    return {
      ...(route.cwd &&
      chatVisualsEligible({
        providerType: route.providerType,
        surface,
        assistantMode: route.assistantMode,
      })
        ? {
            showVisual: createShowVisualHost({
              projectId: route.projectId,
              worktreeId: route.worktreeId,
              chatId: route.chatId,
              cwd: route.cwd,
            }),
          }
        : {}),
      // Native Claude and managed-terminal calls are already command-gated by
      // approvalCheckForClaudeTool before they reach this MCP execution seam;
      // a route that needs a second gate (Cursor) installs `authorizeToolCall`,
      // which the dispatcher consults before this runtime is used.
      deferredToolsRuntime: {
        scope: {
          projectId: route.projectId,
          worktreeId: route.worktreeId,
          chatId: route.chatId,
        },
        providerType: route.providerType ?? 'claude',
        interfaceMode:
          surface === 'claude-code-terminal' ? 'claude-code' : 'canopy',
        assistantMode: route.assistantMode,
        pluginSelections: route.pluginSelections,
        allowed: route.deferredToolsAllowed !== false,
      },
      requestUserAnswers: (
        questions,
        options,
      ): Promise<McpQuestionAnswer[]> => {
        if (!askUserAllowed) {
          return Promise.reject(
            new Error(
              'AskUserQuestion is not available in Claude Code terminal mode.',
            ),
          );
        }
        return this.options.interfaceRequests.requestUserAnswers({
          sessionKey: route.sessionKey,
          projectId: route.projectId,
          worktreeId: route.worktreeId,
          chatId: route.chatId,
          questions,
          ...(options?.toolUseId ? { toolUseId: options.toolUseId } : {}),
          providerType: 'claude',
          askUserTimeoutMs: ASK_USER_TIMEOUT_MS,
          ...(route.model ? { model: route.model } : {}),
          ...(route.onAwaitingUser
            ? { onAwaitingUser: route.onAwaitingUser }
            : {}),
          ...(requestContext?.onAskUserRequestCreated
            ? { onRequestCreated: requestContext.onAskUserRequestCreated }
            : {}),
        });
      },
      loadScriptOutput: (request) =>
        loadWorktreeScriptOutput({
          projectId: route.projectId,
          worktreeId: route.worktreeId,
          scriptId: request.scriptId,
          repo: request.repo,
          maxLines: request.maxLines,
        }),
      loadGitPreferences,
      saveLocalMemory: (request) =>
        saveLocalMemory({
          projectId: route.projectId,
          worktreeId: route.worktreeId,
          chatId: route.chatId,
          sessionId: route.sdkSessionId,
          provider: route.providerType ?? 'claude',
          ...request,
        }),
      searchLocalMemory: (request) =>
        searchLocalMemory({
          projectId: route.projectId,
          worktreeId: route.worktreeId,
          ...request,
        }),
      readLocalMemory: (request) =>
        readLocalMemory({
          projectId: route.projectId,
          worktreeId: route.worktreeId,
          ...request,
        }),
      loadPipelineYaml: (request) =>
        loadWorktreePipelineYaml({
          projectId: route.projectId,
          worktreeId: route.worktreeId,
          ...request,
        }),
      ...(hasInterfaceTool(route.interfaceTools, 'ui.show_files')
        ? {
            showFiles: (files) =>
              this.options.interfaceRequests.showFiles(
                {
                  files,
                  target: {
                    projectId: route.projectId,
                    worktreeId: route.worktreeId,
                  },
                  origin: {
                    projectId: route.projectId,
                    worktreeId: route.worktreeId,
                    chatTabId: route.chatId,
                  },
                  cwd:
                    route.cwd ??
                    resolveWorktreeCwd(route.projectId, route.worktreeId),
                },
                requestContext?.signal
                  ? { signal: requestContext.signal }
                  : undefined,
              ),
          }
        : {}),
      getFileComments: ({ threadId }) =>
        getFileCommentsInSession({
          projectId: route.projectId,
          worktreeId: route.worktreeId,
          ...(threadId !== undefined ? { threadId } : {}),
        }),
      respondToFileComment: ({ threadId, body, resolve }) =>
        respondToFileCommentInSession({
          projectId: route.projectId,
          worktreeId: route.worktreeId,
          threadId,
          body,
          resolve,
          getWindow: () => this.options.interfaceRequests.legacyWindow(),
        }),
      ...(canonicalKey === 'dispatch_action' ||
      canonicalKey === 'search_actions' ||
      canonicalKey === 'watch_github_items' ||
      canonicalKey === 'watch_command' ||
      canonicalKey === 'set_base_branch' ||
      canonicalKey === 'start_forked_agent' ||
      canonicalKey === 'start_branched_agent'
        ? {
            worktreeActionRuntime: {
              ...(route.turnSignal && requestContext?.signal
                ? { signal: requestContext.signal }
                : {}),
              projectId: route.projectId,
              worktreeId: route.worktreeId,
              chatId: route.chatId,
              cwd:
                route.cwd ??
                resolveWorktreeCwd(route.projectId, route.worktreeId),
              ...(route.repoId ? { repoId: route.repoId } : {}),
              // Cowork chats run directory-scoped: pipeline listing/dispatch
              // targets the workspace folder and worktree-only actions
              // (tracked-plan/hook) are filtered/rejected.
              ...(isCoworkWorkspace(route.projectId)
                ? { executionScope: 'directory' as const }
                : {}),
              getWindow: () => this.options.interfaceRequests.legacyWindow(),
            },
          }
        : {}),
      ...(canonicalKey === 'search_watchers' ||
      canonicalKey === 'get_script_output' ||
      canonicalKey === 'watch_command' ||
      canonicalKey === 'schedule_wakeup' ||
      canonicalKey === 'setup_watchers' ||
      canonicalKey === 'delete_watchers' ||
      canonicalKey === 'watch_github_items' ||
      // dispatch_action needs the watcher destination too: pipeline.run and
      // automation.create/run_now accept inline `watchers` arrays that arm
      // watchers for the calling chat.
      canonicalKey === 'dispatch_action' ||
      // set_auto_archive reads the chat identity to say when the archive waits
      // for the chat's live delegates.
      canonicalKey === 'set_auto_archive' ||
      canonicalKey === 'set_work_entry_auto_delete'
        ? {
            worktreeWatcherRuntime: {
              projectId: route.projectId,
              worktreeId: route.worktreeId,
              chatId: route.chatId,
            },
          }
        : {}),
      ...(isCodeGraphInjectedToolKey(canonicalKey)
        ? {
            codeGraphRuntime: {
              projectId: route.projectId,
              worktreeId: route.worktreeId,
            },
          }
        : {}),
      ...(route.ledgerTools && isLedgerInjectedToolKey(canonicalKey)
        ? { ledgerRuntime: route.ledgerTools }
        : {}),
      ...(route.autoArchiveAvailable
        ? {
            autoArchiveChat: {
              projectId: route.projectId,
              worktreeId: route.worktreeId,
              chatId: route.chatId,
            },
          }
        : {}),
    };
  }
}
