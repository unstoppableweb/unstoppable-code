import { classifyCodexDynamicToolResult } from '@canopy/execution-engine/node/codex-runtime/host-tools';
import {
  DELEGATE_OUTPUT_CONTINUATION_NOTICE,
  DELEGATE_OUTPUT_PAGE_MAX_LIMIT,
} from './output-page';
import {
  CLAUDE_DELEGATION_SPAWN_FEED_SCHEMA,
  CLAUDE_DELEGATION_SPAWN_SCHEMA,
  CODEX_DELEGATION_SPAWN_FEED_SCHEMA,
  CODEX_DELEGATION_SPAWN_SCHEMA,
  parseClaudeDelegationSpawn,
  parseCodexDelegationSpawn,
} from '@canopy/protocol/delegation/spawn-projections';
import {
  AGENT_DELEGATION_INPUT_LIMITS,
  DELEGATION_NOT_DESCENDANT_ERROR,
  parseGetDelegateOutputRequest,
  parseManageDelegateWorktreeRequest,
  parseMessageDelegateRequest,
  parseRequestSteeringRequest,
  type AgentDelegationResult,
  type AgentDelegationFeedAssignment,
  type AgentDelegationFeedSummary,
  type AgentDelegationSnapshot,
  type AgentDelegationSpawnRequest,
  type DelegationListFilter,
  type DelegationStopReason,
  type GetDelegateOutputRequest,
  type GetDelegateOutputValue,
  type ManageDelegateWorktreeRequest,
  type MessageDelegateRequest,
  type RequestSteeringRequest,
} from '@canopy/protocol/delegation';

import type { DelegationModelDiscovery } from '@canopy/protocol/delegation/discovery';
import type { DelegationCapabilityChoice } from '@canopy/protocol/delegation';
import {
  hasValidDelegationLineage,
  type DelegationParentContext,
} from './types';

/** List Delegates { includeCapabilities: true } payload. Names only, never paths. */
export interface DelegationCapabilityDiscovery {
  readonly capabilities: readonly DelegationCapabilityChoice[];
  readonly capabilitiesTruncated?: boolean;
}

/** Host-owned Feed readers; shared projections never import Ledger services. */
export interface DelegationFeedHooks {
  readonly readFeedSummary: (
    parent: DelegationParentContext,
    delegationId: string,
  ) => Promise<AgentDelegationFeedSummary | undefined>;
  readonly readFeedAssignment: (
    parent: DelegationParentContext,
    task: AgentDelegationSpawnRequest,
    delegationId: string,
  ) => Promise<AgentDelegationFeedAssignment | undefined>;
}

export interface DelegationTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
}

export interface DelegationProjectionNames {
  readonly spawn: string;
  readonly output: string;
  readonly inspect: string;
  readonly list: string;
  readonly stop: string;
  readonly manageWorktree?: string;
  readonly message?: string;
  readonly requestSteering?: string;
}
export interface DelegationProjectionBroker {
  manageWorktree?(
    parent: DelegationParentContext,
    input: ManageDelegateWorktreeRequest,
  ): Promise<AgentDelegationResult<unknown>>;
  message?(
    parent: DelegationParentContext,
    input: MessageDelegateRequest,
  ): Promise<AgentDelegationResult<unknown>>;
  requestSteering?(
    parent: DelegationParentContext,
    request: RequestSteeringRequest,
  ): Promise<AgentDelegationResult<unknown>>;
  requestStop?(
    parent: DelegationParentContext,
    id: string,
    reason?: DelegationStopReason,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot>>;
  spawn(
    parent: DelegationParentContext,
    task: AgentDelegationSpawnRequest,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot>>;
  getOutput(
    parent: DelegationParentContext,
    request: GetDelegateOutputRequest,
  ): Promise<AgentDelegationResult<GetDelegateOutputValue>>;
  inspect(
    parent: DelegationParentContext,
    id: string,
  ): AgentDelegationSnapshot | undefined;
  list(
    parent: DelegationParentContext,
    filter?: DelegationListFilter,
  ): readonly AgentDelegationSnapshot[];
  stop(
    parent: DelegationParentContext,
    id: string,
    reason?: DelegationStopReason,
  ):
    | AgentDelegationResult<AgentDelegationSnapshot>
    | Promise<AgentDelegationResult<AgentDelegationSnapshot>>;
}

const ID_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['delegationId'],
  properties: {
    delegationId: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['delegationId'],
  properties: {
    delegationId: { type: 'string', minLength: 1, maxLength: 256 },
    resultIndex: { type: 'integer', minimum: 1 },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: 'integer', minimum: 4, maximum: 65_536 },
  },
} as const;
const UNDER_DELEGATION_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
} as const;

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isDelegationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AGENT_DELEGATION_INPUT_LIMITS.idCharacters &&
    value === value.trim() &&
    !/[\0\r\n]/.test(value)
  );
}

/** Classify the exact JSON envelope used by the Codex delegation adapter. */
function codexOutputFits(
  result: AgentDelegationResult<GetDelegateOutputValue>,
): boolean {
  return (
    classifyCodexDynamicToolResult({
      success: result.ok,
      contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
    }).kind === 'ok'
  );
}

/** C4: preserve the first reply unless a pinned page can actually be delivered. */
async function fitCodexDelegateOutput(
  broker: DelegationProjectionBroker,
  parent: DelegationParentContext,
  request: GetDelegateOutputRequest,
  original: AgentDelegationResult<GetDelegateOutputValue>,
  feed?: AgentDelegationFeedSummary,
): Promise<AgentDelegationResult<GetDelegateOutputValue>> {
  if (codexOutputFits(original)) return original;
  if (!original.ok || original.value.result === null) return original;
  const pageRead =
    request.offset !== undefined || request.limit !== undefined
      ? original
      : await broker.getOutput(parent, {
          delegationId: request.delegationId,
          resultIndex: original.value.result.resultIndex,
          offset: 0,
          limit: DELEGATE_OUTPUT_PAGE_MAX_LIMIT,
        });
  const page = withFeedSummary(pageRead, feed);
  if (!page.ok) return page;
  if (codexOutputFits(page)) return page;
  const result = page.value.result;
  const answer = result?.answer;
  if (!result || !answer || answer.text.length === 0) return original;

  // Prefixes are counted in Unicode characters, never split surrogate pairs.
  const characters = Array.from(answer.text);
  let low = 1;
  let high = characters.length - 1;
  let best: AgentDelegationResult<GetDelegateOutputValue> | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const text = characters.slice(0, count).join('');
    const candidate: AgentDelegationResult<GetDelegateOutputValue> = {
      ok: true,
      value: {
        ...page.value,
        result: {
          ...result,
          answer: {
            ...answer,
            text,
            nextOffset:
              answer.offset + Buffer.byteLength(text, answer.encoding),
            notice: DELEGATE_OUTPUT_CONTINUATION_NOTICE,
          },
        },
      },
    };
    if (codexOutputFits(candidate)) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return best ?? original;
}

function withFeedSummary(
  result: AgentDelegationResult<GetDelegateOutputValue>,
  feed: AgentDelegationFeedSummary | undefined,
): AgentDelegationResult<GetDelegateOutputValue> {
  return result.ok && feed !== undefined
    ? { ok: true, value: { ...result.value, feed } }
    : result;
}

function reportFeedError(
  onError: ((error: unknown) => void) | undefined,
  message: string,
): void {
  try {
    onError?.(new Error(message));
  } catch {
    // Optional diagnostics must not turn a best-effort Feed read into failure.
  }
}

/** Collision-free names are selected by the host's injected brand namespace. */
export function createDelegationProjection(
  harness: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode',
  namespace: string,
  broker: DelegationProjectionBroker,
  options: {
    developmentProbe?: boolean;
    names?: DelegationProjectionNames;
    discoverModels?: (
      parent: DelegationParentContext,
      signal?: AbortSignal,
    ) => Promise<DelegationModelDiscovery>;
    discoverCapabilities?: (
      parent: DelegationParentContext,
      signal?: AbortSignal,
    ) => Promise<DelegationCapabilityDiscovery>;
    enableDelegationTools?: boolean;
    requestSteering?: (
      parent: DelegationParentContext,
      request: RequestSteeringRequest,
    ) => Promise<AgentDelegationResult<unknown>>;
    /** Enable optional Feed task hand-off and result summaries for this parent. */
    includeFeed?: boolean;
    readFeedSummary?: DelegationFeedHooks['readFeedSummary'];
    readFeedAssignment?: DelegationFeedHooks['readFeedAssignment'];
    onError?: (error: unknown) => void;
  } = {},
): {
  readonly tools: readonly DelegationTool[];
  invoke(
    parent: DelegationParentContext,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AgentDelegationResult<unknown>>;
} {
  // Brand namespaces are lower-kebab (`unstoppable-code`); hyphens are valid
  // in both Claude MCP and Codex dynamic tool names.
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(namespace))
    throw new Error('Invalid delegation tool namespace');
  const names = options.names ?? {
    spawn: `${namespace}_${harness !== 'codex' ? 'delegate_task' : 'spawn_delegate'}`,
    output: `${namespace}_get_delegate_output`,
    inspect: `${namespace}_inspect_delegate`,
    list: `${namespace}_list_delegates`,
    stop: `${namespace}_stop_delegate`,
    manageWorktree: `${namespace}_manage_delegate_worktree`,
    message: `${namespace}_message_delegate`,
    requestSteering: `${namespace}_request_steering`,
  };
  const delegationToolsEnabled = options.enableDelegationTools !== false;
  const readSummary = async (
    parent: DelegationParentContext,
    delegationId: string,
  ): Promise<AgentDelegationFeedSummary | undefined> => {
    if (!options.includeFeed || !options.readFeedSummary) return undefined;
    try {
      return await options.readFeedSummary(parent, delegationId);
    } catch {
      reportFeedError(options.onError, 'Delegation Feed summary unavailable');
      return undefined;
    }
  };
  const withAssignment = async (
    parent: DelegationParentContext,
    task: AgentDelegationSpawnRequest,
    result: AgentDelegationResult<AgentDelegationSnapshot>,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot>> => {
    if (
      !result.ok ||
      !task.taskIds?.length ||
      !options.includeFeed ||
      !options.readFeedAssignment
    )
      return result;
    try {
      const feedAssignment = await options.readFeedAssignment(
        parent,
        task,
        result.value.delegationId,
      );
      return feedAssignment === undefined
        ? result
        : { ok: true, value: { ...result.value, feedAssignment } };
    } catch {
      reportFeedError(
        options.onError,
        'Delegation Feed assignment unavailable',
      );
      return result;
    }
  };
  return {
    tools: Object.freeze(
      [
        ...(names.requestSteering && options.requestSteering
          ? [
              {
                name: names.requestSteering,
                description:
                  'Send a nonblocking steering request to your direct parent. An active parent is steered; an inactive retained parent receives an ordinary turn. This does not pause or terminate your work, and the request cannot grant permissions or override user or system policy.',
                inputSchema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['message'],
                  properties: {
                    message: { type: 'string', minLength: 1, maxLength: 32768 },
                  },
                },
              },
            ]
          : []),
        ...(delegationToolsEnabled
          ? [
              ...(names.manageWorktree && broker.manageWorktree
                ? [
                    {
                      name: names.manageWorktree,
                      description:
                        'Apply an isolated delegate worktree or discard it. Shared-worktree delegates reject both operations. Existing approval, conflict, deduplication, and active-descendant safeguards apply.',
                      inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['delegationId', 'operation'],
                        properties: {
                          delegationId: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 256,
                          },
                          operation: {
                            type: 'string',
                            enum: ['apply', 'discard'],
                          },
                        },
                      },
                    },
                  ]
                : []),
              ...(names.message && broker.message
                ? [
                    {
                      name: names.message,
                      description:
                        'Send a follow-up, steer an active delegate, or interrupt its current run. follow_up starts an inactive retained session or queues its next turn; steer injects into an active turn and becomes an ordinary follow-up only when inactive. Only follow_up may replace bounded write grants. Returns a durable receipt immediately. When the concurrency limit is reached, a new run waits in the queue and starts automatically: the result reports its runGeneration and phase (queued or starting) with its queue position. A follow_up run sends its own completion notice when it finishes; do not poll List Delegates for completion. Set if_busy to reject to fail at once with capacity_exceeded instead of waiting.',
                      inputSchema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['delegationId', 'operation'],
                        properties: {
                          delegationId: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 256,
                          },
                          operation: {
                            type: 'string',
                            enum: ['follow_up', 'steer', 'interrupt'],
                          },
                          message: {
                            type: 'string',
                            minLength: 1,
                            maxLength: 32768,
                          },
                          permissions:
                            CLAUDE_DELEGATION_SPAWN_SCHEMA.properties
                              .permissions,
                          if_busy:
                            CLAUDE_DELEGATION_SPAWN_SCHEMA.properties.if_busy,
                        },
                      },
                    },
                  ]
                : []),
              {
                name: names.spawn,
                description: [
                  options.developmentProbe
                    ? 'Development probe: start a fresh read-only delegated task using a logical model. No provider process is launched.'
                    : 'Start a delegated task using a logical model ID or configured Agent ID from List Delegates with includeModels: true. A configured Agent carries its model, system instructions and selected plugins, skills and MCP servers. Children start with your plugins, skills and MCP servers by default; set inherit_capabilities: false to start one without them (a configured Agent keeps its own). To give a child more, pass capabilities IDs from List Delegates with includeCapabilities: true. Grant writes explicitly with permissions.writePaths (relative files/directories, or a dot for the workspace); omitted grants allow read/search only. Parent approval settings always apply to commands and MCP tools too. isolation defaults to shared_worktree; choose worktree only when isolation is wanted. Supply a self-contained prompt with paths, scope and expected output. Every call returns a durable ID promptly. When the concurrency limit is reached, the task waits in a queue (phase queued, with its position) and starts automatically; set if_busy to reject to fail at once with capacity_exceeded instead. The lifetime limit refuses new tasks with lifetime_limit_reached instead of queueing. When a run finishes, its parent receives an automatic completion notice naming the delegate and status; use Get Delegate Output with the resultIndex from the notice to read the result. Reads share the live working tree and can observe parent edits; returned revision and dirty state describe launch-time observation, not an immutable snapshot.',
                  ...(options.includeFeed
                    ? [
                        `Before delegating, add the delegate’s tasks and subtasks under their operation in Feed and pass their task UUIDs as ${harness === 'codex' ? 'task_ids' : 'taskIds'}; the delegate receives those tasks when admitted. After a delegate settles, read its Feed summary and resolve anything it left open.`,
                      ]
                    : []),
                ].join(' '),
                inputSchema:
                  harness !== 'codex'
                    ? options.includeFeed
                      ? CLAUDE_DELEGATION_SPAWN_FEED_SCHEMA
                      : CLAUDE_DELEGATION_SPAWN_SCHEMA
                    : options.includeFeed
                      ? CODEX_DELEGATION_SPAWN_FEED_SCHEMA
                      : CODEX_DELEGATION_SPAWN_SCHEMA,
              },
              {
                name: names.output,
                description:
                  'Read a settled delegate result explicitly. Omit resultIndex for the latest settled result, or provide the one-based resultIndex from a completion notice for that exact historical result. Reads never resume execution or consume output. Use offset and limit for byte ranges, pin continuations with resultIndex, and continue from the returned nextOffset.',
                inputSchema: OUTPUT_SCHEMA,
              },
              {
                name: names.inspect,
                description:
                  'Read one retained delegation you started, directly or through your delegates, without consuming terminal delivery. childDelegationIds lists the delegations it started itself (the 64 most recent).',
                inputSchema: ID_SCHEMA,
              },
              {
                name: names.list,
                description: [
                  options.discoverModels
                    ? 'List owned children. Set includeModels to true before choosing a child target: returns current logical model and configured Agent IDs, supported thinking levels, recommended available model, auth state and disabled reasons. Pass the selected ID as model when spawning. Discovery is advisory; launch rechecks the exact route and selected capabilities.'
                    : 'List the children owned by this parent session.',
                  ...(options.discoverCapabilities
                    ? [
                        'Set includeCapabilities to true to list plugins, skills and MCP servers you can assign to a child with capabilities: returns each ID, whether the child already inherits it, whether it is assignable, and why not.',
                      ]
                    : []),
                  'The list includes every delegation below you, at any depth. Set underDelegationId to list only the delegations below one of them (or below yourself).',
                ].join(' '),
                inputSchema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    ...(options.discoverModels
                      ? { includeModels: { type: 'boolean' } }
                      : {}),
                    ...(options.discoverCapabilities
                      ? { includeCapabilities: { type: 'boolean' } }
                      : {}),
                    underDelegationId: UNDER_DELEGATION_SCHEMA,
                  },
                },
              },
              {
                name: names.stop,
                description:
                  'Request cancellation and return promptly. An accepted request is not proof of native shutdown; inspect retained status if needed.',
                inputSchema: ID_SCHEMA,
              },
            ]
          : []),
      ].map((tool) => Object.freeze(tool)),
    ),
    async invoke(
      parent,
      name,
      input,
      signal,
    ): Promise<AgentDelegationResult<unknown>> {
      const invalid: AgentDelegationResult<never> = {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Invalid delegation tool request.',
          retryable: false,
        },
      };
      if (signal?.aborted || !hasValidDelegationLineage(parent))
        return {
          ok: false,
          error: {
            code: 'parent_unavailable',
            message: 'This parent cannot invoke delegation tools.',
            retryable: false,
          },
        };
      if (/(?:^|__)WaitDelegates$|(?:^|_)wait_delegates$/.test(name))
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message:
              'Wait Delegates is no longer available. Completion notices arrive automatically. Use Get Delegate Output with the notice resultIndex to read the result.',
            retryable: false,
          },
        };
      if (/(?:^|__)ManageDelegate$|(?:^|_)manage_delegate$/.test(name))
        return {
          ok: false,
          error: {
            code: 'invalid_request',
            message:
              'Manage Delegate is no longer available. Use Message Delegate for follow-up, steering, or interruption, and Manage Delegate Worktree for apply or discard.',
            retryable: false,
          },
        };
      if (name === names.requestSteering && options.requestSteering) {
        const parsed = parseRequestSteeringRequest(input);
        return parsed.ok
          ? options.requestSteering(parent, parsed.value)
          : parsed;
      }
      if (!delegationToolsEnabled) return invalid;
      if (name === names.manageWorktree && broker.manageWorktree) {
        const parsed = parseManageDelegateWorktreeRequest(input);
        return parsed.ok ? broker.manageWorktree(parent, parsed.value) : parsed;
      }
      if (name === names.message && broker.message) {
        const parsed = parseMessageDelegateRequest(input);
        return parsed.ok ? broker.message(parent, parsed.value) : parsed;
      }
      if (name === names.spawn) {
        const parsed =
          harness !== 'codex'
            ? parseClaudeDelegationSpawn(input, {
                includeFeed: options.includeFeed === true,
              })
            : parseCodexDelegationSpawn(input, {
                includeFeed: options.includeFeed === true,
              });
        return parsed.ok
          ? withAssignment(
              parent,
              parsed.value,
              await broker.spawn(parent, parsed.value),
            )
          : parsed;
      }
      if (name === names.output) {
        const parsed = parseGetDelegateOutputRequest(input);
        if (!parsed.ok) return parsed;
        const result = await broker.getOutput(parent, parsed.value);
        const firstPage =
          parsed.value.offset === undefined || parsed.value.offset === 0;
        const feed =
          result.ok && firstPage
            ? await readSummary(parent, parsed.value.delegationId)
            : undefined;
        const enriched = withFeedSummary(result, feed);
        return harness === 'codex'
          ? fitCodexDelegateOutput(broker, parent, parsed.value, enriched, feed)
          : enriched;
      }
      if (name === names.list) {
        if (!record(input)) return invalid;
        const keys = Object.keys(input);
        if (keys.length === 0) return { ok: true, value: broker.list(parent) };
        if (
          keys.some(
            (key) =>
              key !== 'includeModels' &&
              key !== 'includeCapabilities' &&
              key !== 'underDelegationId',
          ) ||
          (input.includeModels !== undefined &&
            (typeof input.includeModels !== 'boolean' ||
              !options.discoverModels)) ||
          (input.includeCapabilities !== undefined &&
            (typeof input.includeCapabilities !== 'boolean' ||
              !options.discoverCapabilities)) ||
          (input.underDelegationId !== undefined &&
            !isDelegationId(input.underDelegationId))
        )
          return invalid;
        const underDelegationId = isDelegationId(input.underDelegationId)
          ? input.underDelegationId
          : undefined;
        // Walking one branch never widens access: the branch root must be the
        // caller itself or one of its descendants.
        if (
          underDelegationId !== undefined &&
          underDelegationId !== parent.parentDelegationId &&
          !broker.inspect(parent, underDelegationId)
        )
          return { ok: false, error: { ...DELEGATION_NOT_DESCENDANT_ERROR } };
        const delegations = (): readonly AgentDelegationSnapshot[] =>
          underDelegationId === undefined
            ? broker.list(parent)
            : broker.list(parent, { underDelegationId });
        const includeModels = input.includeModels === true;
        const includeCapabilities = input.includeCapabilities === true;
        if (!includeModels && !includeCapabilities)
          return { ok: true, value: delegations() };
        return {
          ok: true,
          value: {
            delegations: delegations(),
            ...(includeModels && options.discoverModels
              ? await options.discoverModels(parent, signal)
              : {}),
            ...(includeCapabilities && options.discoverCapabilities
              ? await options.discoverCapabilities(parent, signal)
              : {}),
          },
        };
      }
      if (
        (name !== names.inspect && name !== names.stop) ||
        !record(input) ||
        Object.keys(input).length !== 1 ||
        typeof input.delegationId !== 'string' ||
        input.delegationId.length > 256
      )
        return invalid;
      // An agent stopping a delegation is recorded as a parent stop, never as
      // the user cancelling it.
      if (name === names.stop)
        return broker.requestStop
          ? broker.requestStop(parent, input.delegationId, 'stopped_by_parent')
          : broker.stop(parent, input.delegationId, 'stopped_by_parent');
      const snapshot = broker.inspect(parent, input.delegationId);
      if (!snapshot)
        return { ok: false, error: { ...DELEGATION_NOT_DESCENDANT_ERROR } };
      const feed = await readSummary(parent, input.delegationId);
      return {
        ok: true,
        value: feed === undefined ? snapshot : { ...snapshot, feed },
      };
    },
  };
}
