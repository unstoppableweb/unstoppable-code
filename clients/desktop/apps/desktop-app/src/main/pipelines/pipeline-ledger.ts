import { randomBytes, randomUUID } from 'node:crypto';
import type { WorkerPipelineOwnerLedgerOperation } from '@canopy/protocol/canopy-core';
import { BRAND } from '@canopy/brand/current';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  CANOPY_MCP_TOOL_TIMEOUT_MS,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import type {
  ApprovalRule,
  ApprovalCheck,
} from '@canopy/execution-engine/types/approvals';
import type { CodexHostToolPolicy } from '@canopy/execution-engine/node/codex-runtime/thread-handle';
import type { DynamicToolSpec } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolSpec';
import type {
  PipelineLedgerAttempt,
  PipelineLedgerAttemptOutcome,
  PipelineLedgerAttemptRequest,
  PipelineLedgerPort,
  PipelineLedgerSubprocessTools,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { ledgerCodexToolPolicy } from '@canopy/execution-engine/node/ledger-tools/codex';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  DESKTOP_LEDGER_TOOLS_HOST,
  openLedgerPipelineAgentTools,
  type LedgerToolKey,
  type LedgerToolsHost,
  type LedgerToolsRuntime,
} from '../canopy-tools/ledger-tools-runtime';
import {
  findDesktopGlobalLedgerScope,
  resolveDesktopGlobalLedgerScope,
} from '../ledger/core-ledger-adapter';
import {
  getLedgerPipelineAgentOwners,
  retireLedgerPipelineExecution,
} from '../ledger/pipeline-agent-owners';
import { notifyLedgerSessionEnded } from '../ledger/session-end-sweep-ports';
import {
  getMcpHttpProxyService,
  type CanopyWorktreeSessionRoute,
} from '../mcp/http-proxy-service';
import {
  executeCanopyInjectedTool,
  type CanopyInjectedToolRuntime,
  type CanopyInjectedToolTextResult,
} from '../canopy-tools/core';
import {
  PIPELINE_AGENT_ACTION_TOOL_KEYS,
  isPipelineAgentActionToolKey,
  pipelineAgentActionApprovalRules,
  pipelineAgentActionApprovalTarget,
  pipelineAgentActionChatId,
  pipelineAgentActionClaudeToolNames,
  pipelineAgentActionRuntime,
  pipelineAgentActionToolDefinitions,
  type PipelineAgentActionProvider,
  type PipelineAgentActionToolDefinition,
  type PipelineAgentActionToolKey,
} from '../canopy-tools/pipeline-agent-actions';
import { pipelineAgentActionCodexPolicy } from './pipeline-agent-action-codex-tools';

/*
 * The desktop host of the Agent Ledger for pipeline agents (phase 08). The
 * shared executor asks it to open an agent attempt's tools; it runs the
 * Ledger exposure gate, mints the attempt's agent session unless the attempt
 * resumes a checkpoint, registers the attempt's caller binding (role
 * `pipeline_agent`, the agent session as actor) and serves the tools on
 * whichever route the step's agent runs on: a per-attempt HTTP MCP route for
 * a Claude action subprocess, the worker route of a Claude terminal worker,
 * or dynamic tools on a Codex thread. The subprocess only ever receives a
 * route URL and token. Everything ends when the attempt settles or pauses; a
 * paused attempt with a resumable checkpoint stays an owner candidate until
 * a resume consumes that checkpoint, or its execution or one that started it
 * is cancelled.
 */

const LEDGER_TOOL_KEYS: readonly LedgerToolKey[] = [
  'add_ledger_entry',
  'search_ledger_entries',
  'update_ledger_entry',
];

/** What the host runners use of an open attempt's Ledger tools. */
export interface PipelineLedgerAttemptTools extends LedgerToolsRuntime {
  /** The Ledger block for a new thread's or session's instructions. */
  systemPrompt(): string;
  operatePipeline(
    operation: WorkerPipelineOwnerLedgerOperation,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/**
 * The desktop tools host, plus the binding of a run owner's global (workflow)
 * Ledger: the signed-in account's, minted on first use. A recheck only looks
 * it up: after an account switch it finds another account's Ledger, or none,
 * so the open attempt's calls fail closed instead of writing there.
 */
const PIPELINE_LEDGER_TOOLS_HOST: LedgerToolsHost = {
  ...DESKTOP_LEDGER_TOOLS_HOST,
  containerCreatedAt: async (container): Promise<string | null> =>
    container.kind === 'global'
      ? (await resolveDesktopGlobalLedgerScope(container.owner))
          .containerCreatedAt
      : DESKTOP_LEDGER_TOOLS_HOST.containerCreatedAt(container),
  findContainerCreatedAt: async (container): Promise<string | null> =>
    container.kind === 'global'
      ? ((await findDesktopGlobalLedgerScope(container.owner))
          ?.containerCreatedAt ?? null)
      : DESKTOP_LEDGER_TOOLS_HOST.containerCreatedAt(container),
};

/**
 * Where an attempt's approval session and route are keyed: its execution's
 * workspace and worktree, so a directory run keeps its project's deny rules.
 * A projectless run uses the executor's synthetic pipeline route.
 */
function attemptRouteScope(request: PipelineLedgerAttemptRequest): {
  readonly projectId: string;
  readonly worktreeId: string;
} {
  return {
    projectId: request.projectId ?? 'pipeline',
    worktreeId: request.worktreeId ?? request.executionId,
  };
}

/** An open attempt's tools and the request that opened them. */
interface OpenAttempt {
  readonly tools: PipelineLedgerAttemptTools;
  readonly request: PipelineLedgerAttemptRequest;
  /** Routes opened for the attempt's agent, released when it closes. */
  readonly routes: Set<() => void>;
  readonly operationApprovals: Map<string, ApprovalSessionHandle>;
}

/** The step providers whose Ledger calls the host gates itself. */
type PipelineLedgerProvider = 'claude' | 'codex' | 'opencode';

/**
 * Whether an attempt's agent may post a code review as the GitHub App
 * (CAN-7742): a `dangerous_all` Claude or Codex step in a real project. A
 * projectless run's synthetic scope would resolve its owner by a flag, so it
 * never gets the tools; review skills then post another way.
 */
export function attemptAllowsAgentActions(
  request: PipelineLedgerAttemptRequest,
  provider: PipelineLedgerProvider,
): provider is PipelineAgentActionProvider {
  return (
    request.permissionPreset === 'dangerous_all' &&
    (provider === 'claude' || provider === 'codex') &&
    request.projectId !== undefined
  );
}

/** An attempt's agent action tools, served by whichever route the step uses. */
export interface PipelineAgentActionTools {
  readonly provider: PipelineAgentActionProvider;
  readonly definitions: readonly PipelineAgentActionToolDefinition[];
  /** Whether the step's approval session allows this call. Fails closed. */
  authorize(
    key: PipelineAgentActionToolKey,
    toolUseId: string,
  ): Promise<boolean>;
  /**
   * Runs one call with the attempt's own execution, project, worktree and
   * cwd; any scope in the arguments is ignored. Only the two keys run.
   */
  execute(
    key: string,
    args: unknown,
    context: { readonly toolUseId: string; readonly signal?: AbortSignal },
  ): Promise<CanopyInjectedToolTextResult>;
}

/** No user attends a workflow step, and its tools read no script output. */
const unattendedAgentActionHost: Pick<
  CanopyInjectedToolRuntime,
  'requestUserAnswers' | 'loadScriptOutput'
> = {
  requestUserAnswers: () =>
    Promise.reject(new Error('No user attends this workflow step.')),
  loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
};

/**
 * The one main-side seam of a pipeline agent's action tools: the Claude
 * subprocess route, a Codex step's tools and the daemon's owner request all
 * run calls through it. Null unless the attempt passes
 * `attemptAllowsAgentActions` for this provider.
 */
function openPipelineAgentActions(
  open: OpenAttempt,
  cwd: string,
  provider: PipelineLedgerProvider,
  approval: Pick<ApprovalSessionHandle, 'check'>,
): PipelineAgentActionTools | null {
  const { request } = open;
  if (
    !attemptAllowsAgentActions(request, provider) ||
    request.projectId === undefined
  )
    return null;
  const projectId = request.projectId;
  const { worktreeId } = attemptRouteScope(request);
  return {
    provider,
    definitions: pipelineAgentActionToolDefinitions(provider),
    authorize: async (key, toolUseId): Promise<boolean> => {
      const target = pipelineAgentActionApprovalTarget(provider, key);
      const outcome = await approval.check(target, {
        title: `Use ${CANOPY_INJECTED_TOOL_REGISTRY[key].displayName}?`,
        details: target,
        toolUseId,
      });
      return outcome.decision === 'allow';
    },
    execute: async (key, args, context) => {
      if (!isPipelineAgentActionToolKey(key))
        return {
          text: 'This workflow step may only post a code review as the GitHub App.',
          isError: true,
        };
      return executeCanopyInjectedTool(
        key,
        args,
        {
          ...unattendedAgentActionHost,
          worktreeActionRuntime: pipelineAgentActionRuntime({
            projectId,
            worktreeId,
            chatId: pipelineAgentActionChatId(request.executionId),
            cwd,
            executionId: request.executionId,
            ...(context.signal ? { signal: context.signal } : {}),
          }),
        },
        {
          toolUseId: context.toolUseId,
          ...(context.signal ? { signal: context.signal } : {}),
        },
      );
    },
  };
}

/**
 * An open attempt's agent action tools for its own harness, under the
 * attempt's operation approval session for `cwd`, for the daemon's owner
 * request. Null when the attempt is not open or does not pass the gate.
 */
export function openPipelineAgentActionsForAttempt(
  attemptKey: string,
  cwd: string,
): PipelineAgentActionTools | null {
  const open = openAttempts.get(attemptKey);
  if (open === undefined) return null;
  if (!attemptAllowsAgentActions(open.request, open.request.harness))
    return null;
  let approval = open.operationApprovals.get(cwd);
  if (approval === undefined) {
    approval = createPipelineLedgerApprovalSession(
      attemptKey,
      open.request,
      cwd,
      open.request.harness,
    );
    open.operationApprovals.set(cwd, approval);
  }
  return openPipelineAgentActions(open, cwd, open.request.harness, approval);
}

/** Whether a Ledger attempt is still open. */
export function isPipelineLedgerAttemptOpen(attemptKey: string): boolean {
  return openAttempts.has(attemptKey);
}

const openAttempts = new Map<string, OpenAttempt>();

/** The agent's name in the Ledger: its step, pipeline and retry. */
function pipelineAgentDisplayName(
  request: PipelineLedgerAttemptRequest,
): string {
  const name = request.pipelineName?.trim()
    ? `${request.stepName} · ${request.pipelineName.trim()}`
    : request.stepName;
  return request.attempt > 1 ? `${name} (attempt ${request.attempt})` : name;
}

/** The Ledger tools of an open attempt, for the host runners. */
export function getPipelineLedgerAttemptTools(
  attemptKey: string | undefined,
): PipelineLedgerAttemptTools | undefined {
  return attemptKey === undefined
    ? undefined
    : openAttempts.get(attemptKey)?.tools;
}

/** Dispatches with the attempt's original scope, actor, masking and approval rules. */
export async function operatePipelineLedgerAttempt(
  attemptKey: string,
  cwd: string,
  operation: WorkerPipelineOwnerLedgerOperation,
  params: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const open = openAttempts.get(attemptKey);
  if (open === undefined) throw new Error('This Ledger attempt is not open.');
  const key =
    operation === 'core.ledger.entry.add'
      ? 'add_ledger_entry'
      : operation === 'core.ledger.entry.update'
        ? 'update_ledger_entry'
        : 'search_ledger_entries';
  let approval = open.operationApprovals.get(cwd);
  if (approval === undefined) {
    approval = createPipelineLedgerApprovalSession(
      attemptKey,
      open.request,
      cwd,
      open.request.harness,
    );
    open.operationApprovals.set(cwd, approval);
  }
  const target = ledgerToolApprovalTarget(open.request.harness, key);
  const outcome = await approval.check(target, {
    title: `Use ${CANOPY_INJECTED_TOOL_REGISTRY[key].displayName}?`,
    details: target,
    toolUseId: `pipeline-ledger-operation-${randomUUID()}`,
  });
  if (
    outcome.decision !== 'allow' ||
    signal.aborted ||
    openAttempts.get(attemptKey) !== open
  )
    throw new Error('This workflow step may not use this tool.');
  return open.tools.operatePipeline(operation, params, signal);
}

/** The Claude names of the Ledger tools on the brand's injected server. */
export function pipelineLedgerClaudeToolNames(): string[] {
  return LEDGER_TOOL_KEYS.map(
    (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName,
  );
}

/**
 * The attempt's Ledger tools as Codex dynamic tools, each call passing the
 * step's approval session first (`ledgerCodexToolPolicy`).
 */
export function pipelineLedgerCodexTools(
  tools: LedgerToolsRuntime,
  approval: Pick<ApprovalSessionHandle, 'check'>,
): ReturnType<typeof ledgerCodexToolPolicy> {
  return ledgerCodexToolPolicy(tools, async (call): Promise<boolean> => {
    const outcome = await approval.check(
      { kind: 'tool', toolName: call.tool },
      {
        title: `Use ${call.tool}?`,
        details: { kind: 'tool', toolName: call.tool },
        toolUseId: `codex-${call.callId}`,
      },
    );
    return outcome.decision === 'allow';
  });
}

/** A Codex step's Ledger tools, under the step's approval session. */
export interface PipelineLedgerCodexTools {
  /** The Ledger block for a new thread's instructions. */
  readonly instructions: string;
  readonly specs: DynamicToolSpec[];
  readonly policy: (threadId: string) => CodexHostToolPolicy;
  /** Ends the step's approval session. */
  dispose(): void;
}

/**
 * How a pipeline step's provider names a Ledger tool to the approval policy:
 * Codex as an exact tool, Claude and OpenCode as a tool on the brand's
 * injected MCP server, as a Claude pipeline worker's calls are checked.
 */
function ledgerToolApprovalTarget(
  provider: PipelineLedgerProvider,
  key: LedgerToolKey,
): Extract<ApprovalCheck, { kind: 'tool' | 'mcp' }> {
  const tool = CANOPY_INJECTED_TOOL_REGISTRY[key];
  return provider === 'codex'
    ? { kind: 'tool', toolName: tool.codexToolName }
    : { kind: 'mcp', server: BRAND.tools.namespace, tool: tool.displayName };
}

/**
 * The approval session of a pipeline step's Ledger calls. Like a Claude
 * pipeline worker's, it is unattended, in the mode the step's preset selects,
 * with session rules allowing exactly the three Ledger tools, plus
 * SearchActions and DispatchAction when the step may post a review as the
 * GitHub App: a project or global deny rule still applies, and a call that
 * would need a prompt fails closed.
 */
function createPipelineLedgerApprovalSession(
  attemptKey: string,
  request: PipelineLedgerAttemptRequest,
  cwd: string,
  provider: PipelineLedgerProvider,
): ApprovalSessionHandle {
  const createdAt = new Date().toISOString();
  const route = attemptRouteScope(request);
  return createApprovalSession({
    sessionKey: `pipeline-ledger-${provider}-${attemptKey}`,
    projectId: route.projectId,
    worktreeId: route.worktreeId,
    chatId: `pipeline:${request.executionId}`,
    provider,
    workspaceRoot: cwd,
    mode: request.permissionPreset === 'dangerous_all' ? 'full-access' : 'auto',
    sessionRules: [
      ...LEDGER_TOOL_KEYS.map(
        (key): ApprovalRule => ({
          id: randomUUID(),
          behavior: 'allow',
          target: ledgerToolApprovalTarget(provider, key),
          createdAt,
          origin: 'settings',
        }),
      ),
      ...(attemptAllowsAgentActions(request, provider)
        ? pipelineAgentActionApprovalRules(provider)
        : []),
    ],
    getWindow: () => null,
    trackChatTurn: false,
  });
}

/**
 * The gate of a Claude action subprocess's or OpenCode step's Ledger route.
 * The agent runs outside any chat, so no hook checks its calls: each passes
 * the step's approval session here, and any tool outside `allowedKeys` is
 * refused. Only a Claude route that passed `attemptAllowsAgentActions`
 * passes the two agent action keys.
 */
function pipelineLedgerSubprocessGate(
  approval: Pick<ApprovalSessionHandle, 'check'>,
  allowedKeys: readonly (LedgerToolKey | PipelineAgentActionToolKey)[],
): NonNullable<CanopyWorktreeSessionRoute['authorizeToolCall']> {
  return async (key, _args, context): Promise<boolean> => {
    const allowedKey = allowedKeys.find((candidate) => candidate === key);
    if (allowedKey === undefined) return false;
    const tool = CANOPY_INJECTED_TOOL_REGISTRY[allowedKey].displayName;
    const target = {
      kind: 'mcp',
      server: BRAND.tools.namespace,
      tool,
    } as const;
    const outcome = await approval.check(target, {
      title: `Use ${tool}?`,
      details: target,
      toolUseId: `pipeline-ledger-${context?.requestId ?? randomUUID()}`,
    });
    return outcome.decision === 'allow';
  };
}

/**
 * The Ledger tools of a Codex step's open attempt, with an approval session
 * for its calls that lasts until `dispose`. Undefined without an attempt.
 */
export function openPipelineLedgerCodexTools(
  attemptKey: string | undefined,
  cwd: string,
): PipelineLedgerCodexTools | undefined {
  const open =
    attemptKey === undefined ? undefined : openAttempts.get(attemptKey);
  if (attemptKey === undefined || open === undefined) return undefined;
  const approval = createPipelineLedgerApprovalSession(
    attemptKey,
    open.request,
    cwd,
    'codex',
  );
  const ledger = pipelineLedgerCodexTools(open.tools, approval);
  // A `dangerous_all` step in a real project may also post a review as the
  // GitHub App. Codex takes one policy per turn, so the two merge.
  const actions = openPipelineAgentActions(open, cwd, 'codex', approval);
  const merged =
    actions === null
      ? ledger
      : pipelineAgentActionCodexPolicy(ledger, actions, () =>
          openAttempts.has(attemptKey),
        );
  return {
    instructions: open.tools.systemPrompt(),
    specs: merged.specs,
    policy: merged.policy,
    dispose: (): void => approval.dispose(),
  };
}

/** An OpenCode step's Ledger tools: the attempt's route on the app's server. */
export interface PipelineLedgerOpenCodeTools {
  /** The Ledger block for the session's instructions. */
  readonly instructions: string;
  /** The app server the step adds to its MCP servers. */
  readonly server: {
    readonly name: string;
    readonly url: string;
    readonly authToken: string;
  };
  /** Unregisters the route and ends its approval session. */
  dispose(): void;
}

/**
 * The Ledger tools of an OpenCode step's open attempt: a per-run route on the
 * app's MCP server that lists exactly the three tools and gates each call
 * with the step's unattended approval session, as a Claude action
 * subprocess's route does. Undefined without an attempt. The route ends with
 * `dispose` or when the attempt closes, whichever comes first.
 */
export async function openPipelineLedgerOpenCodeTools(
  attemptKey: string | undefined,
  cwd: string,
): Promise<PipelineLedgerOpenCodeTools | undefined> {
  const open =
    attemptKey === undefined ? undefined : openAttempts.get(attemptKey);
  if (attemptKey === undefined || open === undefined) return undefined;
  const { request } = open;
  const proxy = getMcpHttpProxyService();
  const sessionKey = `pipeline-ledger-opencode-${attemptKey}-${randomUUID()}`;
  const authToken = randomBytes(32).toString('base64url');
  const approval = createPipelineLedgerApprovalSession(
    attemptKey,
    request,
    cwd,
    'opencode',
  );
  const route = attemptRouteScope(request);
  let live = true;
  const dispose = (): void => {
    if (!live) return;
    live = false;
    open.routes.delete(dispose);
    proxy.unregisterCanopyWorktreeSessionRoute(sessionKey);
    approval.dispose();
  };
  try {
    await proxy.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: route.projectId,
      worktreeId: route.worktreeId,
      chatId: `pipeline:${request.executionId}`,
      // The worker surface lists the Ledger tools for a route whose session
      // passed the gate, and nothing else.
      toolSurface: 'claude-worker',
      providerType: 'opencode',
      sdkSessionId: sessionKey,
      authToken,
      createdAt: Date.now(),
      hookHandler: () => undefined,
      ledgerTools: open.tools,
      // OpenCode steps never get the agent action tools.
      authorizeToolCall: pipelineLedgerSubprocessGate(
        approval,
        LEDGER_TOOL_KEYS,
      ),
    });
  } catch (error) {
    approval.dispose();
    throw error;
  }
  // The attempt may have closed while the route registered.
  if (!openAttempts.has(attemptKey)) {
    dispose();
    return undefined;
  }
  open.routes.add(dispose);
  return {
    instructions: open.tools.systemPrompt(),
    server: {
      name: BRAND.tools.namespace,
      url: proxy.getCanopyWorktreeMcpUrl(sessionKey),
      authToken,
    },
    dispose,
  };
}

/**
 * Opens one agent attempt's Ledger tools when the gate passes: the flag, the
 * "Agents add to the Feed" setting and a Ledger scope, the execution's
 * worktree or its owner's global Ledger.
 */
async function openAttempt(
  request: PipelineLedgerAttemptRequest,
): Promise<PipelineLedgerAttempt | null> {
  let live = true;
  // The host owns agent identity: a resumed checkpoint keeps the session
  // minted for its run, and every other run is a new agent.
  const agentSessionId = request.resumedAgentSessionId ?? randomUUID();
  const displayName = pipelineAgentDisplayName(request);
  const { target } = request;
  const route = attemptRouteScope(request);
  const tools = await openLedgerPipelineAgentTools({
    target: {
      ...(target.kind === 'task'
        ? { projectId: target.projectId, worktreeId: target.worktreeId }
        : route),
      chatId: `pipeline:${request.executionId}`,
    },
    ...(target.kind === 'global' ? { globalOwner: target.owner } : {}),
    host: PIPELINE_LEDGER_TOOLS_HOST,
    harness: request.harness,
    readSettings: () => ({
      model: request.model ?? null,
      thinkingEffort: request.thinkingEffort ?? null,
      planMode: request.permissionPreset === 'plan',
      mode: request.permissionPreset,
    }),
    pipelineAgent: {
      executionId: request.executionId,
      physicalJobId: request.physicalJobId,
      logicalJobId: request.logicalJobId,
      stepId: request.stepId,
      attempt: request.attempt,
      iteration: request.iteration,
      agentSessionId,
      ...(request.predecessorAgentSessionId === undefined
        ? {}
        : { predecessorAgentSessionId: request.predecessorAgentSessionId }),
      ...(request.checkpointId === undefined
        ? {}
        : { checkpointId: request.checkpointId }),
      displayName,
      ...(request.secretValues === undefined
        ? {}
        : { secretValues: request.secretValues }),
      isLive: () => live,
    },
  });
  if (tools === null) return null;
  const owners = getLedgerPipelineAgentOwners();
  // A running agent is not an assignable owner.
  owners.noteRunning(agentSessionId);
  const attemptKey = randomUUID();
  const open: OpenAttempt = {
    tools,
    request,
    routes: new Set(),
    operationApprovals: new Map(),
  };
  openAttempts.set(attemptKey, open);
  let routeKey: string | undefined;
  let routeApproval: ApprovalSessionHandle | undefined;
  let subprocessTools: Promise<PipelineLedgerSubprocessTools> | undefined;

  const registerSubprocessRoute = async (
    cwd: string,
  ): Promise<PipelineLedgerSubprocessTools> => {
    const proxy = getMcpHttpProxyService();
    const sessionKey = `pipeline-ledger-${attemptKey}`;
    const authToken = randomBytes(32).toString('base64url');
    const approval = createPipelineLedgerApprovalSession(
      attemptKey,
      request,
      cwd,
      'claude',
    );
    routeApproval = approval;
    const agentActions = attemptAllowsAgentActions(request, 'claude');
    await proxy.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: route.projectId,
      worktreeId: route.worktreeId,
      chatId: `pipeline:${request.executionId}`,
      // The worker surface lists the Ledger tools only for a route whose
      // session passed the gate, and nothing else: no memory tools (their
      // exposure is absent) and no structured-result tool.
      toolSurface: 'claude-worker',
      sdkSessionId: agentSessionId,
      authToken,
      createdAt: Date.now(),
      hookHandler: () => undefined,
      ledgerTools: tools,
      // A `dangerous_all` step in a real project may also post a review as
      // the GitHub App, attributed to its execution, in its own folder.
      ...(agentActions
        ? {
            pipelineAgentActions: { executionId: request.executionId },
            cwd,
          }
        : {}),
      authorizeToolCall: pipelineLedgerSubprocessGate(approval, [
        ...LEDGER_TOOL_KEYS,
        ...(agentActions ? PIPELINE_AGENT_ACTION_TOOL_KEYS : []),
      ]),
    });
    if (!live) {
      proxy.unregisterCanopyWorktreeSessionRoute(sessionKey);
      throw new Error('The pipeline agent attempt has ended.');
    }
    routeKey = sessionKey;
    return {
      mcpServers: {
        [BRAND.tools.namespace]: {
          type: 'http',
          url: proxy.getCanopyWorktreeMcpUrl(sessionKey),
          headers: { Authorization: `Bearer ${authToken}` },
          alwaysLoad: true,
          // A review the GitHub App posts can take its publish deadline.
          ...(agentActions ? { timeout: CANOPY_MCP_TOOL_TIMEOUT_MS } : {}),
        },
      },
      allowedTools: [
        ...pipelineLedgerClaudeToolNames(),
        ...(agentActions ? pipelineAgentActionClaudeToolNames() : []),
      ],
      secretValues: [authToken],
    };
  };

  return {
    attemptKey,
    agentSessionId,
    instructions: tools.systemPrompt(),
    openSubprocessTools: (
      cwd: string,
    ): Promise<PipelineLedgerSubprocessTools> => {
      if (!live) {
        return Promise.reject(
          new Error('The pipeline agent attempt has ended.'),
        );
      }
      subprocessTools ??= registerSubprocessRoute(cwd);
      return subprocessTools;
    },
    close: (outcome: PipelineLedgerAttemptOutcome): void => {
      if (!live) return;
      live = false;
      openAttempts.delete(attemptKey);
      tools.dispose();
      if (routeKey !== undefined) {
        getMcpHttpProxyService().unregisterCanopyWorktreeSessionRoute(routeKey);
      }
      routeApproval?.dispose();
      for (const approval of open.operationApprovals.values())
        approval.dispose();
      open.operationApprovals.clear();
      for (const release of Array.from(open.routes)) release();
      if (outcome.kind === 'paused') {
        owners.notePaused({
          agentSessionId,
          displayName,
          executionId: request.executionId,
          jobId: request.physicalJobId,
          stepId: request.stepId,
          attempt: request.attempt,
          container: tools.scope.container,
          containerCreatedAt: tools.scope.containerCreatedAt,
          checkpointId: outcome.checkpointId,
          pausedAt: outcome.pausedAt,
        });
      } else if (
        request.projectId !== undefined &&
        request.worktreeId !== undefined
      ) {
        // A global (workflow) run has no task to hand its entries back in;
        // only a task's steps are swept.
        // The executor's close port is synchronous. A quit before this
        // asynchronous intent write lands can lose the handback; this is the
        // accepted step-end-to-intent window. The sweep follows durability.
        try {
          void notifyLedgerSessionEnded({
            target: {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
            },
            actor: { kind: 'pipeline_agent', originKey: agentSessionId },
            recipient: { kind: 'user' },
            reason: 'pipeline_step_finished',
            transitionKey: `pipeline:${request.executionId}:${request.physicalJobId}:${request.stepId}:${request.attempt}`,
            transitionAt: new Date().toISOString(),
          }).catch((): void => undefined);
        } catch {
          // Ledger bookkeeping must not affect the finished attempt.
        }
      }
    },
  };
}

/** The desktop's pipeline Ledger port for `ExecutionRuntime.pipelineLedger`. */
export function createDesktopPipelineLedgerPort(): PipelineLedgerPort {
  return {
    openAttempt,
    // A saved resume retires the agents paused on its checkpoints, after any
    // owner commit already checking one of them.
    noteResuming: (executionId, checkpointIds) =>
      retireLedgerPipelineExecution(executionId, checkpointIds),
  };
}
