// Producer-shaped events and states for the observability goldens. Each
// builder mirrors what a real producer sends to the ingest boundary.
import type {
  AgentAuditEntry,
  AgentAuditEventType,
  AgentAuditToolCounts,
  AgentProviderType,
  PlanUsageEvent,
} from '@canopy/desktop-shared/types';
import type {
  ExecutionEvent,
  ExecutionState,
  JobResult,
  NormalizedJob,
  NormalizedStep,
  StepResult,
} from '@canopy/execution-engine/node/pipelines/executor';
import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
  AgentDelegationUsage,
  PersistedAgentRouteSnapshot,
} from '@canopy/protocol/delegation';
import {
  GOLDEN_CODEX_MODEL,
  type GoldenChatTurnStart,
  type GoldenScenarioContext,
} from './harness';

export const PROJECT = 'golden-project';
export const WORKTREE = 'golden-worktree';
export const CLAUDE_MODEL = 'claude-sonnet-4-6';
export const COPILOT_MODEL = 'copilot:gpt-5';

export function chatStart(
  chatId: string,
  provider: AgentProviderType,
  overrides: Partial<GoldenChatTurnStart> = {},
): GoldenChatTurnStart {
  return {
    projectId: PROJECT,
    worktreeId: WORKTREE,
    chatId,
    provider,
    originalUserText: `Prompt for ${chatId}`,
    submittedText: `Prompt for ${chatId}`,
    planMode: false,
    isStandalone: false,
    model: provider === 'codex' ? GOLDEN_CODEX_MODEL : CLAUDE_MODEL,
    initiationSource: 'user',
    workspaceLabel: 'Golden workspace',
    repoId: 'golden-repo',
    repoLabel: 'Golden repo',
    ...overrides,
  };
}

export function chatKey(chatId: string): string {
  return `chat:${PROJECT}/${WORKTREE}/${chatId}`;
}

/** Sends one chat event to the chat in the golden worktree. */
export function chatEvent(
  context: GoldenScenarioContext,
  chatId: string,
  data: unknown,
): void {
  context.ingest.observeChatEvent(PROJECT, WORKTREE, chatId, data);
}

export function claudeInit(sessionId: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: CLAUDE_MODEL,
  };
}

export function claudeAssistant(
  content: readonly Record<string, unknown>[],
  usage: Record<string, number> = {
    input_tokens: 40,
    cache_read_input_tokens: 2_000,
    cache_creation_input_tokens: 300,
    output_tokens: 20,
  },
): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { model: CLAUDE_MODEL, content, usage },
  };
}

export function claudeToolResult(toolUseId: string): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
  };
}

export interface ClaudeResultOptions {
  sessionId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The SDK's running total for the session after this result. */
  runningCostUsd: number;
  /** The session's running per-model totals after this result. */
  runningModelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUSD: number;
    }
  >;
  durationMs?: number;
  contextWindow?: number;
}

export function claudeResult(
  options: ClaudeResultOptions,
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done',
    session_id: options.sessionId,
    total_cost_usd: options.runningCostUsd,
    ...(options.durationMs === undefined
      ? {}
      : { duration_ms: options.durationMs }),
    usage: {
      input_tokens: options.input,
      output_tokens: options.output,
      cache_read_input_tokens: options.cacheRead,
      cache_creation_input_tokens: options.cacheWrite,
      ...(options.contextWindow === undefined
        ? {}
        : { context_window: options.contextWindow }),
    },
    modelUsage: options.runningModelUsage ?? {
      [CLAUDE_MODEL]: {
        inputTokens: options.input,
        outputTokens: options.output,
        cacheReadInputTokens: options.cacheRead,
        cacheCreationInputTokens: options.cacheWrite,
        costUSD: options.runningCostUsd,
      },
    },
  };
}

export function codexChatEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  return { type: 'codex', event };
}

export interface CodexTurnOptions {
  threadId: string;
  turnId: string;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  /** The thread's running totals before this turn. */
  previous?: { input: number; cachedInput: number; output: number };
}

/** One provider turn as the Codex runtime streams it. */
export function codexTurnEvents(
  options: CodexTurnOptions,
): Record<string, unknown>[] {
  const { threadId, turnId } = options;
  const previous = options.previous ?? { input: 0, cachedInput: 0, output: 0 };
  return [
    { type: 'thread.started', thread_id: threadId },
    { type: 'turn.started', thread_id: threadId, turn_id: turnId },
    {
      type: 'item.started',
      thread_id: threadId,
      turn_id: turnId,
      item: {
        id: `${turnId}-cmd`,
        type: 'command_execution',
        command: 'pnpm test',
      },
    },
    {
      type: 'item.completed',
      thread_id: threadId,
      turn_id: turnId,
      item: {
        id: `${turnId}-cmd`,
        type: 'command_execution',
        command: 'pnpm test',
        aggregated_output: 'ok',
        exit_code: 0,
      },
    },
    {
      type: 'item.started',
      thread_id: threadId,
      turn_id: turnId,
      item: {
        id: `${turnId}-files`,
        type: 'file_change',
        changes: [
          { kind: 'update', path: 'src/a.ts' },
          { kind: 'add', path: 'src/b.ts' },
        ],
      },
    },
    {
      type: 'item.completed',
      thread_id: threadId,
      turn_id: turnId,
      item: { id: `${turnId}-reasoning`, type: 'reasoning', text: 'Planning' },
    },
    {
      type: 'item.completed',
      thread_id: threadId,
      turn_id: turnId,
      item: { id: `${turnId}-message`, type: 'agent_message', text: 'Done' },
    },
    {
      type: 'thread.token_usage.updated',
      thread_id: threadId,
      turn_id: turnId,
      usage: {
        input_tokens: options.input,
        cached_input_tokens: options.cachedInput,
        output_tokens: options.output,
        reasoning_output_tokens: options.reasoning,
        cumulative_input_tokens: previous.input + options.input,
        cumulative_cached_input_tokens:
          previous.cachedInput + options.cachedInput,
        cumulative_output_tokens: previous.output + options.output,
        cumulative_reasoning_output_tokens: options.reasoning,
        context_tokens: options.input + options.output,
        context_window: 400_000,
      },
    },
    {
      type: 'turn.completed',
      thread_id: threadId,
      turn_id: turnId,
      usage: {
        input_tokens: options.input,
        cached_input_tokens: options.cachedInput,
        output_tokens: options.output,
        reasoning_output_tokens: options.reasoning,
      },
    },
  ];
}

export function jsonl(events: readonly unknown[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('');
}

export function emptyToolCounts(): AgentAuditToolCounts {
  return {
    thinking: 0,
    bash: 0,
    read: 0,
    readLines: 0,
    writeEdit: 0,
    plan: 0,
    fileEdit: 0,
    fileAdd: 0,
    fileDelete: 0,
    search: 0,
    grep: 0,
    web: 0,
    agent: 0,
    workflow: 0,
    tasks: 0,
    taskStop: 0,
    skills: 0,
    monitor: 0,
    claude: 0,
    scheduleWakeup: 0,
    askUser: 0,
    scriptOutput: 0,
    watcher: 0,
    canopy: 0,
    graph: 0,
    appAdvisor: 0,
    pipelineEditor: 0,
    mcp: 0,
    other: 0,
  };
}

/** A helper's observed-task entry, as `startObservedHelperTask` builds it. */
export function helperEntry(options: {
  taskKey: string;
  eventType: AgentAuditEventType;
  provider: AgentProviderType;
  model: string;
  label: string;
  startedAt: string;
  chatId?: string;
  aiCreditsRouted?: boolean;
}): AgentAuditEntry {
  return {
    id: options.taskKey,
    eventType: options.eventType,
    status: 'running',
    provider: options.provider,
    label: options.label,
    startedAt: options.startedAt,
    attempt: 1,
    model: options.model,
    tokens: {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    messageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    subAgentCount: 0,
    hasTranscript: false,
    toolCounts: emptyToolCounts(),
    projectId: PROJECT,
    worktreeId: WORKTREE,
    ...(options.chatId === undefined ? {} : { chatId: options.chatId }),
    ...(options.aiCreditsRouted === true ? { aiCreditsRouted: true } : {}),
    linkTarget: {
      page: 'main',
      kind: 'worktree-chat',
      projectId: PROJECT,
      worktreeId: WORKTREE,
    },
  };
}

export function planEvent(
  type: PlanUsageEvent['type'],
  id: string,
  chatId: string,
  timestamp: string,
): PlanUsageEvent {
  return {
    version: 1,
    id,
    type,
    timestamp,
    workspaceId: PROJECT,
    worktreeId: WORKTREE,
    chatId,
    planId: 'golden-plan',
    planVersion: 1,
    planTextBytes: 120,
    planLineCount: 6,
    initiationSource: 'user',
  };
}

export interface AgentStepOptions {
  provider?: AgentProviderType;
  harness?: StepResult['agent_harness'];
  model?: string;
  startedAt: string;
  status?: StepResult['status'];
  completedAt?: string;
  outputs?: Record<string, string>;
  error?: string;
}

export function agentStep(options: AgentStepOptions): StepResult {
  return {
    status: options.status ?? 'running',
    outputs: options.outputs ?? {},
    dynamic_env: {},
    started_at: options.startedAt,
    ...(options.completedAt === undefined
      ? {}
      : { completed_at: options.completedAt }),
    ...(options.error === undefined ? {} : { error: options.error }),
    log_format_hint: 'agent',
    ...(options.provider === undefined
      ? {}
      : { agent_provider: options.provider }),
    ...(options.harness === undefined
      ? {}
      : { agent_harness: options.harness }),
    ...(options.model === undefined ? {} : { agent_model: options.model }),
  };
}

export function shellStep(
  status: StepResult['status'],
  startedAt: string,
): StepResult {
  return { status, outputs: {}, dynamic_env: {}, started_at: startedAt };
}

function stepDefinition(id: string, agent: boolean): NormalizedStep {
  return {
    id,
    ...(agent ? { uses: 'builtin/agent-prompt' } : { run: 'echo done' }),
    shell: 'bash',
    continue_on_error: false,
    timeout_minutes: 10,
    skip_on_missing_action: false,
  };
}

function jobDefinition(steps: NormalizedStep[]): NormalizedJob {
  return {
    name: 'Job',
    needs: [],
    timeout_minutes: 10,
    max_retries: 0,
    continue_on_error: false,
    steps,
  };
}

export interface PipelineStateOptions {
  id: string;
  parentExecutionId?: string;
  status: ExecutionState['status'];
  startedAt: string;
  completedAt?: string;
  pausedMs?: number;
  jobs: Record<string, JobResult>;
}

/** A persisted execution state; step ids ending in `shell` are not agents. */
export function pipelineState(options: PipelineStateOptions): ExecutionState {
  const definitions = Object.fromEntries(
    Object.entries(options.jobs).map(([jobId, job]) => [
      jobId,
      jobDefinition(
        Object.keys(job.steps).map((stepId) =>
          stepDefinition(stepId, !stepId.endsWith('shell')),
        ),
      ),
    ]),
  );
  return {
    version: 9,
    id: options.id,
    pipeline_id: 'golden-pipeline',
    pipeline_snapshot: {
      name: 'Golden pipeline',
      scope: ['worktree'],
      jobs: definitions,
    },
    status: options.status,
    jobs: options.jobs,
    job_definitions: Object.fromEntries(
      Object.entries(definitions).map(([jobId, job]) => [
        jobId,
        { ...job, physical_job_id: jobId, logical_job_id: jobId },
      ]),
    ),
    job_groups: {},
    started_at: options.startedAt,
    ...(options.completedAt === undefined
      ? {}
      : { completed_at: options.completedAt }),
    ...(options.pausedMs === undefined ? {} : { paused_ms: options.pausedMs }),
    cwd: '/golden/repo',
    env: {},
    inputs: {},
    project_id: PROJECT,
    worktree_id: WORKTREE,
    ...(options.parentExecutionId === undefined
      ? {}
      : { parent_execution_id: options.parentExecutionId }),
    initiation_source: 'user',
    pending_pauses: [],
    status_reasons: [],
  };
}

export function job(
  status: JobResult['status'],
  steps: Record<string, StepResult>,
): JobResult {
  return { status, outputs: {}, steps };
}

export function runEvent(
  type: 'execution.started' | 'execution.completed' | 'execution.failed',
  state: ExecutionState,
  timestamp: string,
): ExecutionEvent {
  return { executionId: state.id, type, state, timestamp };
}

const DELEGATION_ROUTE: PersistedAgentRouteSnapshot = {
  selectedModelId: 'codex-route',
  selectedModelLabel: 'Configured delegate',
  runtimeModelLabel: 'Codex model',
  runtimeModelId: GOLDEN_CODEX_MODEL,
  harnessId: 'codex',
  runtimeKind: 'codex-app-server',
  runnerRegistrationId: 'local-delegation-codex-v1',
  runtimeVersion: '1',
  adapterVersion: '1',
  modelSource: 'codex-managed',
  providerType: 'codex',
  assignmentRevision: 'revision-1',
  billingAuthority: 'ai-credits',
  aiCreditsRouted: true,
  capabilities: [],
  supportedThinkingLevels: ['low', 'medium', 'high'],
  capabilitySnapshotHash: 'capability-hash',
  capabilityGeneration: 1,
  policyRevision: 'policy-1',
};

/** One managed delegation run as the chat's `canopy_delegation` event carries it. */
export function delegationEvent(options: {
  delegationId: string;
  parentTurnId: string;
  status: AgentDelegationSnapshot['status'];
  sequence: number;
  createdAt: number;
  usage?: AgentDelegationUsage;
  itemTimes: readonly number[];
}): Record<string, unknown> {
  const delegation: AgentDelegationTranscript = {
    delegationId: options.delegationId,
    runGeneration: 1,
    sequence: options.sequence,
    parentHarnessId: 'claude',
    parentTurnId: options.parentTurnId,
    parentToolCallId: 'tool-call-1',
    createdAt: options.createdAt,
    task: {
      description: 'Review package ownership',
      prompt: 'private task prompt',
      executionMode: 'foreground',
    },
    snapshot: {
      delegationId: options.delegationId,
      status: options.status,
      outputTruncated: false,
      routeSnapshot: DELEGATION_ROUTE,
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    },
    transcript: options.itemTimes.map((occurredAt, index) => ({
      id: `item-${String(index)}`,
      sequence: index,
      occurredAt,
      type: 'text',
      text: 'private delegate text',
    })),
  };
  return { type: 'canopy_delegation', delegation };
}

/** A trace header the account proxy stamps on each response. */
export function proxyResponse(
  sessionId: string,
  authIndex: string,
  requestId: string,
): {
  sessionId: string;
  connectionId: string;
  authIndex: string;
  requestId: string;
  label: string;
  provider: string;
} {
  return {
    sessionId,
    connectionId: 'golden-proxy',
    authIndex,
    requestId,
    label: `Account ${authIndex.slice(0, 4)}`,
    provider: 'claude',
  };
}
