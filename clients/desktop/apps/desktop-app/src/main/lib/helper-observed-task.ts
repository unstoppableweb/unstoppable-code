import {
  getExecutionHarnessForModel,
  getModelSource,
  requireProviderForModel,
  type AgentAuditEntry,
  type AgentAuditEventType,
  type AgentAuditLinkTarget,
  type AgentModelConfig,
  type AgentAuditToolCounts,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { codexServiceTierForModelConfig } from '@canopy/execution-engine/lib/codex-model-config';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import type { RunWithOptionalHelperPluginsOptions } from './helper-plugin-resolution';

export interface HelperAuditContext {
  projectId: string;
  worktreeId: string;
  planId?: string;
  repoId?: string;
  repoLabel?: string;
}

export interface ObservedHelperTaskOptions {
  taskKey: string;
  eventType: AgentAuditEventType;
  label: string;
  model: string;
  modelConfig?: AgentModelConfig;
  auditContext?: HelperAuditContext;
  chatId?: string;
  linkTarget?: AgentAuditLinkTarget;
  /**
   * Set when the caller already knows this helper routed through AI Credits at
   * start time. Helpers that resolve routing inside their query should instead
   * call {@link markObservedHelperTaskAiCreditsRouted} once resolved.
   */
  aiCreditsRouted?: boolean;
}

export interface HelperPluginRunOptions {
  helperName: string;
  model: string;
  pluginSelections?: ChatTabPluginSelections;
  auditContext?: HelperAuditContext;
}

export interface ObservedHelperUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  totalCostUsd?: number;
  messageCount?: number;
  assistantMessageCount?: number;
}

function emptyToolCounts(): AgentAuditToolCounts {
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

export function startObservedHelperTask(
  options: ObservedHelperTaskOptions,
): void {
  const auditContext = options.auditContext;
  const provider = requireProviderForModel(options.model);
  const executionHarness = getExecutionHarnessForModel(options.model);
  const entry: AgentAuditEntry = {
    id: options.taskKey,
    eventType: options.eventType,
    status: 'running',
    provider,
    modelSource: getModelSource(options.model),
    ...(executionHarness ? { executionHarness } : {}),
    label: options.label,
    startedAt: new Date().toISOString(),
    attempt: 1,
    model: options.model,
    serviceTier:
      executionHarness === 'codex'
        ? codexServiceTierForModelConfig(options.modelConfig)
        : undefined,
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
    projectId: auditContext?.projectId,
    worktreeId: auditContext?.worktreeId,
    repoId: auditContext?.repoId,
    repoLabel: auditContext?.repoLabel,
    chatId: options.chatId,
    linkTarget:
      options.linkTarget ??
      (auditContext
        ? {
            page: 'main',
            kind: 'worktree-chat',
            projectId: auditContext.projectId,
            worktreeId: auditContext.worktreeId,
            planId: auditContext.planId,
          }
        : undefined),
  };

  if (options.aiCreditsRouted) {
    entry.aiCreditsRouted = true;
  }

  getExecutionObservabilityIngest().startObservedTask(options.taskKey, entry);
}

/**
 * Mark an already-started observed helper task as having routed through AI
 * Credits. Used by helpers that resolve routing inside their query (after the
 * observed task is started) so the Audit Trail entry reflects the real path.
 */
export function markObservedHelperTaskAiCreditsRouted(
  taskKey: string,
  aiCreditsRouted: boolean,
  accountProxyRouted = false,
): void {
  // The account proxy served it: no native account is credited (CAN-4030).
  if (accountProxyRouted) {
    getExecutionObservabilityIngest().markObservedTaskAccountProxyRouted(
      taskKey,
    );
  }
  // `aiCreditsRouted` is documented as absent on natively-authenticated runs,
  // so only persist the field when routing actually happened. Writing an
  // explicit `false` would diverge from the pre-resolution entry (where the
  // field is absent) and contradict the AgentAuditEntry contract.
  if (!aiCreditsRouted) {
    return;
  }
  getExecutionObservabilityIngest().updateObservedTask(taskKey, {
    aiCreditsRouted: true,
  });
}

export function buildHelperPluginRunOptions(
  options: HelperPluginRunOptions,
): RunWithOptionalHelperPluginsOptions {
  const auditContext = options.auditContext;
  return {
    helperName: options.helperName,
    model: options.model,
    ...(options.pluginSelections
      ? { selections: options.pluginSelections }
      : {}),
    ...(auditContext
      ? {
          projectId: auditContext.projectId,
          worktreeId: auditContext.worktreeId,
        }
      : {}),
  };
}

export function finalizeObservedHelperTask(
  taskKey: string,
  status: 'success' | 'failure' | 'cancelled',
  error?: string,
  usage?: ObservedHelperUsage,
): void {
  getExecutionObservabilityIngest().finalizeObservedTask(
    taskKey,
    status,
    error,
    usage,
  );
}
