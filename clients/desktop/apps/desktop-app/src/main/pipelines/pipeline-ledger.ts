import { randomBytes, randomUUID } from 'node:crypto';
import { BRAND } from '@canopy/brand/current';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import type {
  ApprovalRule,
  ApprovalRuleTarget,
} from '@canopy/execution-engine/types/approvals';
import type { CodexHostToolPolicy } from '@canopy/execution-engine/node/codex-runtime/thread-handle';
import type { DynamicToolSpec } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolSpec';
import type { DynamicToolCallResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/DynamicToolCallResponse';
import type {
  PipelineLedgerAttempt,
  PipelineLedgerAttemptOutcome,
  PipelineLedgerAttemptRequest,
  PipelineLedgerPort,
  PipelineLedgerSubprocessTools,
} from '@canopy/execution-engine/node/pipelines/executor/types';
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
import { buildLedgerCodexDynamicToolSpecs } from '../codex/canopy-dynamic-tools';
import {
  getLedgerPipelineAgentOwners,
  retireLedgerPipelineExecution,
} from '../ledger/pipeline-agent-owners';
import { notifyLedgerSessionEnded } from '../ledger/session-end-sweep-ports';
import {
  getMcpHttpProxyService,
  type CanopyWorktreeSessionRoute,
} from '../mcp/http-proxy-service';

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

/** The Claude names of the Ledger tools on the brand's injected server. */
export function pipelineLedgerClaudeToolNames(): string[] {
  return LEDGER_TOOL_KEYS.map(
    (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName,
  );
}

/**
 * The attempt's Ledger tools as Codex dynamic tools: the specs a new thread
 * starts with and, per turn, the host policy that runs them. Only calls on
 * the step's own thread reach the attempt's binding, and each passes the
 * step's approval session first, as a native chat's injected tools do.
 */
export function pipelineLedgerCodexTools(
  tools: LedgerToolsRuntime,
  approval: Pick<ApprovalSessionHandle, 'check'>,
): {
  readonly specs: DynamicToolSpec[];
  readonly policy: (threadId: string) => CodexHostToolPolicy;
} {
  const specs = buildLedgerCodexDynamicToolSpecs();
  const keyOf = (name: string): LedgerToolKey | undefined =>
    LEDGER_TOOL_KEYS.find(
      (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].codexToolName === name,
    );
  return {
    specs,
    policy: (threadId): CodexHostToolPolicy => ({
      allowedTools: specs.map(({ name }) => ({ namespace: null, tool: name })),
      authorize: async (call, signal): Promise<boolean> => {
        if (
          signal.aborted ||
          call.threadId !== threadId ||
          call.namespace !== null ||
          keyOf(call.tool) === undefined
        ) {
          return false;
        }
        const outcome = await approval.check(
          { kind: 'tool', toolName: call.tool },
          {
            title: `Use ${call.tool}?`,
            details: { kind: 'tool', toolName: call.tool },
            toolUseId: `codex-${call.callId}`,
          },
        );
        return outcome.decision === 'allow' && !signal.aborted;
      },
      execute: async (call, signal): Promise<DynamicToolCallResponse> => {
        const key = keyOf(call.tool);
        if (
          signal.aborted ||
          call.namespace !== null ||
          call.threadId !== threadId ||
          key === undefined
        ) {
          return { success: false, contentItems: [] };
        }
        // Codex repeats the thread, turn and call IDs for one call, so a
        // Ledger key derived from them dedupes its retries.
        const result = await tools.execute(key, call.arguments, {
          invocationId: `codex:${call.threadId}:${call.turnId}:${call.callId}`,
          signal,
        });
        return {
          success: result.isError !== true,
          contentItems: [{ type: 'inputText', text: result.text }],
        };
      },
    }),
  };
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
 * Codex as an exact tool, Claude as a tool on the brand's injected MCP server,
 * as a Claude pipeline worker's calls are checked.
 */
function ledgerToolApprovalTarget(
  provider: 'claude' | 'codex',
  key: LedgerToolKey,
): ApprovalRuleTarget {
  const tool = CANOPY_INJECTED_TOOL_REGISTRY[key];
  return provider === 'codex'
    ? { kind: 'tool', toolName: tool.codexToolName }
    : { kind: 'mcp', server: BRAND.tools.namespace, tool: tool.displayName };
}

/**
 * The approval session of a pipeline step's Ledger calls. Like a Claude
 * pipeline worker's, it is unattended, in the mode the step's preset selects,
 * with session rules allowing exactly the three Ledger tools: a project or
 * global deny rule still applies, and a call that would need a prompt fails
 * closed.
 */
function createPipelineLedgerApprovalSession(
  attemptKey: string,
  request: PipelineLedgerAttemptRequest,
  cwd: string,
  provider: 'claude' | 'codex',
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
    sessionRules: LEDGER_TOOL_KEYS.map(
      (key): ApprovalRule => ({
        id: randomUUID(),
        behavior: 'allow',
        target: ledgerToolApprovalTarget(provider, key),
        createdAt,
        origin: 'settings',
      }),
    ),
    getWindow: () => null,
    trackChatTurn: false,
  });
}

/**
 * The gate of a Claude action subprocess's Ledger route. The subprocess runs
 * outside any chat, so no hook checks its calls: each passes the step's
 * approval session here, and any other tool is refused.
 */
function pipelineLedgerSubprocessGate(
  approval: Pick<ApprovalSessionHandle, 'check'>,
): NonNullable<CanopyWorktreeSessionRoute['authorizeToolCall']> {
  return async (key, _args, context): Promise<boolean> => {
    const ledgerKey = LEDGER_TOOL_KEYS.find((candidate) => candidate === key);
    if (ledgerKey === undefined) return false;
    const tool = CANOPY_INJECTED_TOOL_REGISTRY[ledgerKey].displayName;
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
  const { specs, policy } = pipelineLedgerCodexTools(open.tools, approval);
  return {
    instructions: open.tools.systemPrompt(),
    specs,
    policy,
    dispose: (): void => approval.dispose(),
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
  openAttempts.set(attemptKey, { tools, request });
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
      authorizeToolCall: pipelineLedgerSubprocessGate(approval),
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
        },
      },
      allowedTools: pipelineLedgerClaudeToolNames(),
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
