import {
  isValidSharedAgentModelId,
  parseAgentRouteModelId,
} from '@canopy/protocol/agents';
import type {
  AgentAuditEntry,
  AgentAuditToolCounts,
} from '@canopy/protocol/observability';
import { isRecord, readNumber } from './record-readers';

export function defaultTokens(): AgentAuditEntry['tokens'] {
  return {
    input: 0,
    output: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

export function normalizeOptionalAuditTokens(
  value: unknown,
): AgentAuditEntry['tokens'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    input: readNumber(value, 'input') ?? 0,
    output: readNumber(value, 'output') ?? 0,
    cacheReadInputTokens: readNumber(value, 'cacheReadInputTokens') ?? 0,
    cacheCreationInputTokens:
      readNumber(value, 'cacheCreationInputTokens') ?? 0,
    reasoningOutputTokens: readNumber(value, 'reasoningOutputTokens') ?? 0,
  };
}

export function defaultToolCounts(): AgentAuditToolCounts {
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

/** Tool counters summed into a record's tool-use total. */
export const AGENT_AUDIT_TOOL_COUNT_KEYS: Array<keyof AgentAuditToolCounts> = [
  'thinking',
  'bash',
  'read',
  'readLines',
  'writeEdit',
  'fileEdit',
  'fileAdd',
  'fileDelete',
  'search',
  'grep',
  'web',
  'agent',
  'workflow',
  'tasks',
  'taskStop',
  'skills',
  'monitor',
  'claude',
  'scheduleWakeup',
  'askUser',
  'scriptOutput',
  'graph',
  'appAdvisor',
  'pipelineEditor',
  'mcp',
  'other',
];

/** Project recorded routes without looking up a mutable Agent preference. */
export function observedModelIdentity(value: {
  model?: string;
  requestedModel?: string;
  agentId?: string;
}): { model?: string; agentId?: string } {
  const route = value.model ? parseAgentRouteModelId(value.model) : null;
  const requestedRoute = value.requestedModel
    ? parseAgentRouteModelId(value.requestedModel)
    : null;
  const selectedAgent = requestedRoute?.agentId ?? value.requestedModel;
  const modelAgent = route?.agentId ?? value.model;
  const agentId =
    selectedAgent && isValidSharedAgentModelId(selectedAgent)
      ? selectedAgent
      : modelAgent && isValidSharedAgentModelId(modelAgent)
        ? modelAgent
        : value.agentId && isValidSharedAgentModelId(value.agentId)
          ? value.agentId
          : undefined;
  return {
    model:
      route?.baseModel ??
      (value.model && !isValidSharedAgentModelId(value.model)
        ? value.model
        : requestedRoute?.baseModel),
    ...(agentId ? { agentId } : {}),
  };
}
