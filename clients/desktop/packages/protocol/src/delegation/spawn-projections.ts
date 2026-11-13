import { THINKING_LEVELS } from '../thinking';
import {
  AGENT_DELEGATION_TASK_ID_PATTERN,
  AGENT_DELEGATION_TASK_IDS_MAX,
  AGENT_DELEGATION_INPUT_LIMITS,
  parseAgentDelegationSpawnRequest,
  type AgentDelegationResult,
  type AgentDelegationSpawnRequest,
} from './index';

const grantProperties = {
  allow_nested_delegation: {
    type: 'boolean',
    default: false,
    description:
      'Allow this child to delegate through managed tools, within the user’s maximum depth and shared concurrency limits. Defaults to false. At the depth limit the child still launches, without delegation tools.',
  },
  inherit_capabilities: {
    type: 'boolean',
    default: true,
    description:
      'Defaults to true: the child starts with the caller’s plugins, skills and MCP servers. Set false to start it without them; a configured Agent’s own selections still apply.',
  },
  capabilities: {
    type: 'array',
    maxItems: 64,
    uniqueItems: true,
    items: { type: 'string', pattern: '^deferred:v1:[A-Za-z0-9_-]{43}$' },
    description:
      'Additional plugins, skills or MCP servers for the child: IDs from List Delegates with includeCapabilities: true, or from Search Deferred Tools.',
  },
  allow_capability_discovery: {
    type: 'boolean',
    description:
      'Whether the child may search for and turn on its own plugins, skills and MCP servers. Defaults to the caller’s own permission; true never exceeds what the user allows for this chat.',
  },
  if_busy: {
    type: 'string',
    enum: ['queue', 'reject'],
    default: 'queue',
    description:
      'When the concurrency limit is reached: queue (default) waits for a free slot and starts automatically; reject fails at once with capacity_exceeded. The lifetime limit refuses new tasks with lifetime_limit_reached instead of queueing.',
  },
  fast_mode: {
    type: 'boolean',
    default: false,
    description:
      'Enable priority processing for a Codex child. Unsupported child harnesses reject true. May incur higher usage charges.',
  },
  permissions: {
    type: 'object',
    additionalProperties: false,
    required: ['writePaths'],
    properties: {
      writePaths: {
        type: 'array',
        maxItems: 64,
        uniqueItems: true,
        items: { type: 'string', minLength: 1, maxLength: 4095 },
        description:
          'Explicit relative files or directory scopes the child may edit, still subject to parent approvals. Omitted means read-only.',
      },
    },
  },
  isolation: {
    type: 'string',
    enum: ['shared_worktree', 'worktree'],
    default: 'shared_worktree',
  },
} as const;

const taskIdsProperty = {
  type: 'array',
  minItems: 1,
  maxItems: AGENT_DELEGATION_TASK_IDS_MAX,
  uniqueItems: true,
  items: {
    type: 'string',
    pattern: AGENT_DELEGATION_TASK_ID_PATTERN,
  },
  description:
    'Open Feed task UUIDs this delegate should take over when it is admitted.',
} as const;

// Names and registration belong to each host's injected brand namespace.
// These schemas are inert until an eligible parent surface registers them.
export const CLAUDE_DELEGATION_SPAWN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'description', 'prompt'],
  properties: {
    ...grantProperties,
    model: {
      type: 'string',
      description:
        'A model ID or configured Agent ID from List Delegates with includeModels: true. An Agent carries its model, instructions and selected capabilities.',
      minLength: 1,
      maxLength: AGENT_DELEGATION_INPUT_LIMITS.idCharacters,
    },
    description: {
      type: 'string',
      minLength: 1,
      maxLength: AGENT_DELEGATION_INPUT_LIMITS.descriptionCharacters,
    },
    prompt: {
      type: 'string',
      minLength: 1,
      maxLength: AGENT_DELEGATION_INPUT_LIMITS.promptCharacters,
    },
    thinking_level: { type: 'string', enum: THINKING_LEVELS },
    run_in_background: { type: 'boolean', default: true },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: AGENT_DELEGATION_INPUT_LIMITS.nameCharacters,
    },
  },
} as const;

export const CODEX_DELEGATION_SPAWN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'task_name', 'message'],
  properties: {
    ...grantProperties,
    model: {
      type: 'string',
      description:
        'A model ID or configured Agent ID from List Delegates with includeModels: true. An Agent carries its model, instructions and selected capabilities.',
      minLength: 1,
      maxLength: AGENT_DELEGATION_INPUT_LIMITS.idCharacters,
    },
    task_name: {
      type: 'string',
      minLength: 1,
      maxLength: AGENT_DELEGATION_INPUT_LIMITS.nameCharacters,
    },
    message: {
      type: 'string',
      minLength: 1,
      maxLength: AGENT_DELEGATION_INPUT_LIMITS.promptCharacters,
    },
    reasoning_effort: { type: 'string', enum: THINKING_LEVELS },
    execution_mode: {
      type: 'string',
      enum: ['background', 'foreground'],
      default: 'background',
    },
    context: { type: 'string', enum: ['task_only'] },
  },
} as const;

/** Feed-aware variants are selected only for a parent with Feed tools. */
export const CLAUDE_DELEGATION_SPAWN_FEED_SCHEMA = {
  ...CLAUDE_DELEGATION_SPAWN_SCHEMA,
  properties: {
    ...CLAUDE_DELEGATION_SPAWN_SCHEMA.properties,
    taskIds: taskIdsProperty,
  },
} as const;

export const CODEX_DELEGATION_SPAWN_FEED_SCHEMA = {
  ...CODEX_DELEGATION_SPAWN_SCHEMA,
  properties: {
    ...CODEX_DELEGATION_SPAWN_SCHEMA.properties,
    task_ids: taskIdsProperty,
  },
} as const;

export interface DelegationSpawnProjectionOptions {
  /** Whether this parent has the Feed tools and may hand off Feed task IDs. */
  readonly includeFeed?: boolean;
}

function hasOnlyFields(
  input: unknown,
  fields: readonly string[],
): input is Record<string, unknown> {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).every((key) => fields.includes(key))
  );
}

function invalidProjection(): AgentDelegationResult<never> {
  return {
    ok: false,
    error: {
      code: 'invalid_request',
      message: 'Invalid managed delegation input.',
      retryable: false,
    },
  };
}

export function parseClaudeDelegationSpawn(
  input: unknown,
  options: DelegationSpawnProjectionOptions = {},
): AgentDelegationResult<AgentDelegationSpawnRequest> {
  if (
    !hasOnlyFields(input, [
      'model',
      'description',
      'prompt',
      'thinking_level',
      'run_in_background',
      'name',
      'isolation',
      'permissions',
      'fast_mode',
      'allow_nested_delegation',
      'inherit_capabilities',
      'capabilities',
      'allow_capability_discovery',
      'if_busy',
      ...(options.includeFeed ? ['taskIds'] : []),
    ])
  )
    return invalidProjection();
  if (
    input.run_in_background !== undefined &&
    typeof input.run_in_background !== 'boolean'
  )
    return invalidProjection();
  return parseAgentDelegationSpawnRequest({
    modelId: input.model,
    ...(input.allow_nested_delegation !== undefined
      ? { allowNestedDelegation: input.allow_nested_delegation }
      : {}),
    ...(input.inherit_capabilities !== undefined
      ? { inheritCapabilities: input.inherit_capabilities }
      : {}),
    ...(input.capabilities !== undefined
      ? { capabilities: input.capabilities }
      : {}),
    ...(input.allow_capability_discovery !== undefined
      ? { allowCapabilityDiscovery: input.allow_capability_discovery }
      : {}),
    ...(input.if_busy !== undefined ? { ifBusy: input.if_busy } : {}),
    ...(options.includeFeed && input.taskIds !== undefined
      ? { taskIds: input.taskIds }
      : {}),
    ...(input.fast_mode !== undefined ? { fastMode: input.fast_mode } : {}),
    permissions: input.permissions,
    isolation: input.isolation,
    description: input.description,
    prompt: input.prompt,
    ...(input.thinking_level !== undefined
      ? { thinkingLevel: input.thinking_level }
      : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    executionMode:
      input.run_in_background === false ? 'foreground' : 'background',
  });
}

export function parseCodexDelegationSpawn(
  input: unknown,
  options: DelegationSpawnProjectionOptions = {},
): AgentDelegationResult<AgentDelegationSpawnRequest> {
  if (
    !hasOnlyFields(input, [
      'model',
      'task_name',
      'message',
      'reasoning_effort',
      'execution_mode',
      'context',
      'isolation',
      'permissions',
      'fast_mode',
      'allow_nested_delegation',
      'inherit_capabilities',
      'capabilities',
      'allow_capability_discovery',
      'if_busy',
      ...(options.includeFeed ? ['task_ids'] : []),
    ])
  )
    return invalidProjection();
  if (input.context !== undefined && input.context !== 'task_only')
    return {
      ok: false,
      error: {
        code: 'capability_unavailable',
        message:
          'This delegation surface supports only fresh task context in the shared worktree.',
        retryable: false,
      },
    };
  return parseAgentDelegationSpawnRequest({
    modelId: input.model,
    ...(input.allow_nested_delegation !== undefined
      ? { allowNestedDelegation: input.allow_nested_delegation }
      : {}),
    ...(input.inherit_capabilities !== undefined
      ? { inheritCapabilities: input.inherit_capabilities }
      : {}),
    ...(input.capabilities !== undefined
      ? { capabilities: input.capabilities }
      : {}),
    ...(input.allow_capability_discovery !== undefined
      ? { allowCapabilityDiscovery: input.allow_capability_discovery }
      : {}),
    ...(input.if_busy !== undefined ? { ifBusy: input.if_busy } : {}),
    ...(options.includeFeed && input.task_ids !== undefined
      ? { taskIds: input.task_ids }
      : {}),
    ...(input.fast_mode !== undefined ? { fastMode: input.fast_mode } : {}),
    permissions: input.permissions,
    isolation: input.isolation,
    name: input.task_name,
    description: input.task_name,
    prompt: input.message,
    executionMode: input.execution_mode,
    ...(input.reasoning_effort !== undefined
      ? { thinkingLevel: input.reasoning_effort }
      : {}),
  });
}
