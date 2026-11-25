import type {
  SDKResultMessage,
  SDKSystemMessage,
} from '../agents/claude-sdk-message-types';
import { readClaudeConnectorAvailability } from '@canopy/protocol/remote-control/shell';
import { CHILD_TOOL_LIVENESS_STAMP } from '@canopy/agent-transcript';
import type {
  AiCreditsNoBillingSourceEventData,
  AiCreditsRoutingStatusEventData,
  AiCreditsUsageLimitEventData,
  NoBillingSourceErrorEventData,
  SetAutoArchiveRequestedEventData,
  TransientRetryStateEventData,
} from '@canopy/desktop-shared/types';
import {
  CANOPY_MODEL_ACCESS_FAILURE_FIELD,
  isCanopyAuthFailureEventData,
  type AuthDependencyFailure,
  type CanopyAuthFailureEventData,
  type CodexAccountModelAccessFailure,
} from '@canopy/protocol/auth-recovery';
import { AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG } from '@canopy/protocol/llm-gateway';
import {
  isAgentDelegationTranscript,
  type AgentDelegationSnapshot,
  type AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import {
  CHAT_INPUT_DELIVERY_FAILURES,
  type ChatInputDeliveryEvent,
} from '@canopy/protocol/remote-control/shell/input-delivery';

/*
 * What the storage backstop delivers of a provider event when the agent
 * secret values can't be read back, so nothing can be redacted. Each event
 * kind that settles a turn or a route, or that drives app state, keeps the
 * fields its census allows; every other field is stripped and every other
 * kind is dropped.
 *
 * The censuses are what the consumers read, kept complete two ways:
 * - Each kind with a type is checked against it: a field the type gains is
 *   a type error here until the census keeps or strips it.
 * - The storage backstop golden runs the router's and the projection's
 *   readers over recording events and fails on any field they read that a
 *   census doesn't name.
 * - `check:refused-event-census` fails on any `canopy_*` stamp or event type
 *   in the app's source that CANOPY_STAMPS or CANOPY_EVENT_KINDS doesn't
 *   classify.
 */

/**
 * What a kept field may hold:
 * - `id`: a generated id string (or an array of them), kept as is.
 * - `token`: an enum-like string (`turn.completed`, `error_max_turns`).
 * - `label`: a short single-line name from the app's own configuration
 *   (an MCP server's display name), never conversation text.
 * - `number`, `boolean`: that type only.
 * - `timestamp`: a number, or an ISO 8601 time string.
 * - `numbers`: an object (or array) of numbers, nested, such as usage; a
 *   `null` stays `null`.
 * - `empty`: a string the consumer expects, emptied.
 * - `fixedResult`: a turn's result, kept only when it is one of the app's
 *   own fixed outcomes; otherwise emptied.
 * - `deliverySummary`: a delivery failure's summary, kept only when it is
 *   the fixed summary of a known failure.
 * - `connectorAvailability`: a closed, value-free Claude launch fact.
 * - `errorBody`: an error event's error, a string (emptied) or a record
 *   (its type and code kept, its message emptied).
 * - `{ each: fields }`: an array of records, each with its own allowlist.
 * - an object: a nested record with its own allowlist.
 * Any value of another shape is stripped.
 */
type FieldRule =
  | 'id'
  | 'token'
  | 'label'
  | 'number'
  | 'boolean'
  | 'timestamp'
  | 'numbers'
  | 'empty'
  | 'fixedResult'
  | 'deliverySummary'
  | 'errorBody'
  | 'connectorAvailability'
  | { readonly each: Fields }
  | Fields;

/** A field the census names but strips, with why. */
type Stripped = `stripped: ${string}`;

/** A census entry: what a field keeps, or why it is stripped. */
type Disposition = FieldRule | Stripped;

export interface Fields {
  readonly [key: string]: Disposition;
}

/** Every key of every member of a union. */
type KeysOf<T> = T extends unknown ? keyof T & string : never;

/** A census naming every field of `T` (and any more the app stamps on it). */
type Census<T> = Readonly<Record<KeysOf<T>, Disposition>> & Fields;

const TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+=-]{0,255}$/;
const LABEL = /^[^\n\r]{1,128}$/;
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;

const TEXT: Stripped = 'stripped: conversation or tool text';
const PROVIDER_TEXT: Stripped =
  "stripped: the provider's own text (an error, a path, a description)";

/** The fixed results the app's own sessions end a turn with. */
const FIXED_RESULTS: ReadonlySet<string> = new Set([
  'Turn cancelled',
  'Session aborted',
  'Session ended',
]);

const DELIVERY_SUMMARIES: ReadonlySet<string> = new Set(
  Object.values(CHAT_INPUT_DELIVERY_FAILURES).map(({ summary }) => summary),
);

/**
 * What any kept event may carry: its routing ids, and the fields every
 * consumer probes on any event (its provider, error flag, completion time
 * and result, which a kind without one simply lacks).
 */
const ROUTING = {
  uuid: 'id',
  session_id: 'id',
  parent_tool_use_id: 'id',
  provider: 'token',
  is_error: 'boolean',
  result: 'fixedResult',
  completed_at: 'timestamp',
  completedAt: 'timestamp',
  timestamp: 'timestamp',
} as const satisfies Fields;

/**
 * Every `canopy_*` field the app stamps on a provider event, on whatever
 * kind carries it: app metadata, kept to its shape, or stripped when it
 * holds text.
 */
const CANOPY_STAMPS = {
  canopy_turn_user_message_id: 'id',
  canopy_execution_turn_id: 'id',
  canopy_wake_turn_id: 'id',
  canopy_resumes_user_message_id: 'id',
  canopy_async_question_id: 'id',
  canopy_consumed_pending_system_instruction_ids: 'id',
  canopy_turn_resumes: 'id',
  canopy_display_error_code: 'token',
  canopy_user_message_source: 'token',
  canopy_fork_model_context: 'token',
  canopy_claude_connector_availability: 'connectorAvailability',
  canopy_stop_cause: 'token',
  canopy_proxy: 'token',
  // A task-notification result while a foreground turn runs ends nothing.
  canopy_session_continues: 'boolean',
  canopy_plan_handoff: 'boolean',
  canopy_replay: 'boolean',
  canopy_turn_revival: 'boolean',
  canopy_turn_abandoned: 'boolean',
  canopy_turn_unaccepted: 'boolean',
  canopy_resumes_interrupted_turn: 'boolean',
  canopy_synthetic: 'boolean',
  canopy_hidden: 'boolean',
  // The AI Credits proxy found no billing source behind this failure.
  [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: 'boolean',
  [CHILD_TOOL_LIVENESS_STAMP]: {
    kind: 'token',
    liveParentToolUseIds: 'id',
    hasUncorrelatedLiveTask: 'boolean',
  },
  canopy_session_recovery: {
    kind: 'token',
    provider: 'token',
    sessionId: 'id',
  },
  [CANOPY_MODEL_ACCESS_FAILURE_FIELD]: {
    kind: 'token',
    model: 'label',
    modelLabel: 'label',
    fallbackModel: 'label',
    fallbackModelLabel: 'label',
  } satisfies Census<CodexAccountModelAccessFailure>,
  canopy_provider_error_details: PROVIDER_TEXT,
  // Delivery adds it after the commit; the history read still shows the visual.
  canopy_tool_visuals: "stripped: a visual reference carries the agent's title",
  canopy_persisted_messages: 'stripped: the chat messages themselves',
} as const satisfies Fields;

const STAMPED = { ...ROUTING, ...CANOPY_STAMPS } as const satisfies Fields;

const INPUT_DELIVERY = {
  ...STAMPED,
  type: 'token',
  provider: 'token',
  generation: 'id',
  attemptId: 'id',
  phase: 'token',
  providerTurnId: 'id',
  itemId: 'id',
  startsTurn: 'boolean',
  userMessageId: 'id',
  turnRootAccepted: 'boolean',
  failure: { class: 'token', code: 'token', summary: 'deliverySummary' },
} as const satisfies Census<ChatInputDeliveryEvent>;

/**
 * A turn's result: Claude's, and the result other providers' sessions emit
 * in its shape.
 */
const RESULT = {
  ...STAMPED,
  type: 'token',
  subtype: 'token',
  is_error: 'boolean',
  duration_ms: 'number',
  duration_api_ms: 'number',
  ttft_ms: 'number',
  ttft_stream_ms: 'number',
  time_to_request_ms: 'number',
  time_to_request_from_spawn_ms: 'number',
  time_origin_ms: 'number',
  request_sent_wall_ms: 'number',
  first_content_frame_ms: 'number',
  first_stream_post_ms: 'number',
  first_stream_post_ack_ms: 'number',
  first_stream_post_wall_ms: 'number',
  first_stream_post_queue_wait_ms: 'number',
  first_stream_post_queued_behind: 'token',
  first_text_post_ms: 'number',
  first_text_post_wall_ms: 'number',
  first_text_post_queue_wait_ms: 'number',
  first_text_post_queued_behind: 'token',
  warm_spare_claimed: 'boolean',
  api_error_status: 'number',
  num_turns: 'number',
  total_cost_usd: 'number',
  stop_reason: 'token',
  terminal_reason: 'token',
  result: 'fixedResult',
  codexErrorInfo: 'token',
  usage: 'numbers',
  modelUsage: 'numbers',
  queued_turn_count: 'number',
  result_index: 'number',
  user_message_uuid: 'id',
  user_message_uuids: 'id',
  fast_mode_state: 'token',
  fast_mode_disabled_reason: 'token',
  startup_failure_reason: 'token',
  credential_expires_at: 'token',
  resume_reason: 'token',
  origin: PROVIDER_TEXT,
  errors: PROVIDER_TEXT,
  invalid_config_file: PROVIDER_TEXT,
  permission_denials: 'stripped: the denied tool calls and their input',
  structured_output: TEXT,
  local_command: 'stripped: a command line',
  deferred_tool_use: TEXT,
} as const satisfies Census<SDKResultMessage>;

/** An error event: a provider failure, and the app's own refusals. */
const ERROR = {
  ...STAMPED,
  type: 'token',
  subtype: 'token',
  error: 'errorBody',
  error_code: 'token',
  message: 'empty',
} as const satisfies Census<NoBillingSourceErrorEventData>;

/**
 * A session's start (Claude's, and the one Codex emits for its thread): the
 * session id tells the root's completion from a child's.
 */
const SYSTEM_INIT = {
  ...STAMPED,
  type: 'token',
  subtype: 'token',
  model: 'token',
  permissionMode: 'token',
  apiKeySource: 'token',
  claude_code_version: 'token',
  output_style: 'token',
  fast_mode_state: 'token',
  fast_mode_disabled_reason: 'token',
  effort: 'token',
  view_mode: 'token',
  capabilities: 'token',
  cwd: 'stripped: a local path',
  agents: 'stripped: configured names, not needed to settle',
  betas: 'stripped: not needed to settle',
  tools: 'stripped: not needed to settle',
  mcp_servers: 'stripped: not needed to settle',
  slash_commands: 'stripped: not needed to settle',
  terminal_slash_commands: 'stripped: not needed to settle',
  skills: 'stripped: not needed to settle',
  plugins: 'stripped: local paths',
  plugin_errors: PROVIDER_TEXT,
  memory_paths: 'stripped: local paths',
  analytics_disabled: 'stripped: not needed to settle',
} as const satisfies Census<SDKSystemMessage>;

const CODEX_ERROR = {
  message: 'empty',
  codexErrorInfo: 'token',
  resetsAt: 'number',
  willRetry: 'boolean',
  additionalDetails: PROVIDER_TEXT,
} as const satisfies Fields;

/** A Codex event that starts or ends a thread or turn. */
const CODEX_LIFECYCLE_EVENT = {
  ...CODEX_ERROR,
  completed_at: 'timestamp',
  completedAt: 'timestamp',
  timestamp: 'timestamp',
  [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: 'boolean',
  source: 'token',
  model: 'token',
  reasoning_effort: 'token',
  agent_role: 'token',
  agent_nickname: 'label',
  type: 'token',
  thread_id: 'id',
  parent_thread_id: 'id',
  turn_id: 'id',
  threadId: 'id',
  status: 'token',
  turn: { id: 'id', status: 'token', error: CODEX_ERROR },
  usage: 'numbers',
  error: CODEX_ERROR,
  message: 'empty',
  item: TEXT,
} as const satisfies Fields;

const CODEX_LIFECYCLE = {
  ...STAMPED,
  type: 'token',
  thread_id: 'id',
  turn_id: 'id',
  event: CODEX_LIFECYCLE_EVENT,
} as const satisfies Fields;

/** Codex events that start or end a thread or turn. */
const CODEX_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'error',
]);

const AUTH_DEPENDENCY_FAILURE = {
  dependencyClass: 'token',
  dependencyId: 'id',
  displayName: 'label',
  failureClass: 'token',
  recovery: {
    kind: 'token',
    provider: 'token',
    serverId: 'id',
    configId: 'id',
    target: {
      page: 'token',
      serverId: 'id',
      integration: 'token',
      provider: 'token',
    },
  },
  detail: PROVIDER_TEXT,
} as const satisfies Census<AuthDependencyFailure>;

const AUTH_FAILURE = {
  ...STAMPED,
  type: 'token',
  toolUseId: 'id',
  failure: AUTH_DEPENDENCY_FAILURE,
  failures: { each: AUTH_DEPENDENCY_FAILURE },
} as const satisfies Census<CanopyAuthFailureEventData>;

const USAGE_LIMIT = {
  ...STAMPED,
  type: 'token',
  provider: 'token',
  resetsAt: 'number',
} as const satisfies Census<AiCreditsUsageLimitEventData>;

const NO_BILLING_SOURCE = {
  ...STAMPED,
  type: 'token',
  provider: 'token',
} as const satisfies Census<AiCreditsNoBillingSourceEventData>;

const CREDITS_ROUTING = {
  ...STAMPED,
  type: 'token',
  active: 'boolean',
  accountProxyRouted: 'boolean',
  provider: 'token',
} as const satisfies Census<AiCreditsRoutingStatusEventData>;

const TRANSIENT_RETRY = {
  ...STAMPED,
  type: 'token',
  provider: 'token',
  active: 'boolean',
  attempt: 'number',
  maxAttempts: 'number',
  nextRetryAt: 'number',
  exhausted: 'boolean',
} as const satisfies Census<TransientRetryStateEventData>;

const AUTO_ARCHIVE = {
  ...STAMPED,
  type: 'token',
  enabled: 'boolean',
} as const satisfies Census<SetAutoArchiveRequestedEventData>;

const CHILD_TOOLS_ENDED = {
  ...STAMPED,
  type: 'token',
  parent_tool_use_ids: 'id',
} as const satisfies Fields;

const PROVIDER_USAGE = {
  ...STAMPED,
  type: 'token',
  provider: 'token',
  usage: 'numbers',
} as const satisfies Fields;

/**
 * Every `canopy_*` event type in the app: the census a kept kind keeps, or
 * why the kind is dropped. A delegation snapshot has its own projection.
 */
const CANOPY_EVENT_KINDS = {
  canopy_input_delivery: INPUT_DELIVERY,
  canopy_auth_failure: AUTH_FAILURE,
  canopy_usage_limit_reached: USAGE_LIMIT,
  canopy_ai_credits_no_billing_source: NO_BILLING_SOURCE,
  canopy_ai_credits_routing: CREDITS_ROUTING,
  canopy_claude_connector_availability: {
    ...STAMPED,
    type: 'token',
    availability: 'connectorAvailability',
  },
  canopy_transient_retry_state: TRANSIENT_RETRY,
  canopy_set_auto_archive_requested: AUTO_ARCHIVE,
  canopy_child_tools_ended: CHILD_TOOLS_ENDED,
  canopy_turn_usage: PROVIDER_USAGE,
  canopy_cursor_usage: PROVIDER_USAGE,
  canopy_opencode_usage: PROVIDER_USAGE,
  canopy_delegation: 'stripped: kept by its own projection, refusedDelegation',
  canopy_user_prompt: "stripped: the person's prompt",
  canopy_user_prompt_accepted: "stripped: carries the person's prompt",
  canopy_injected_prompt: 'stripped: an injected prompt',
  canopy_assistant_patch: "stripped: the assistant's text",
  canopy_compaction: "stripped: the compacted conversation's summary",
  canopy_helper_diagnostic: PROVIDER_TEXT,
  canopy_prompt_suggestion: 'stripped: a suggested prompt',
  canopy_transcript_truncated: 'stripped: written by the transcript store',
  canopy_context_snapshot: 'stripped: observability capture, not delivered',
  canopy_openai_pricing: 'stripped: observability capture, not delivered',
  canopy_ingestion_lag: 'stripped: a diagnostic, not needed to settle',
  canopy_org_memory_used: 'stripped: names the memories an agent read',
  canopy_account_proxy_switch: 'stripped: a notice, not needed to settle',
  canopy_claude_mods_skipped: 'stripped: names local modifications',
} as const satisfies Fields;

const CANOPY_KINDS: ReadonlyMap<string, Disposition> = new Map(
  Object.entries(CANOPY_EVENT_KINDS),
);

/**
 * The delegation transcript fields a refused snapshot keeps: identity and
 * route. Its task loses its text and its snapshot is kept to
 * DELEGATION_SNAPSHOT; its transcript is emptied.
 */
type Kept = 'kept' | Stripped;

export const DELEGATION_TRANSCRIPT = {
  delegationId: 'kept',
  runGeneration: 'kept',
  sequence: 'kept',
  parentHarnessId: 'kept',
  parentTurnId: 'kept',
  parentToolCallId: 'kept',
  createdAt: 'kept',
  transcriptMode: 'kept',
  transcriptStore: 'kept',
  task: 'kept',
  snapshot: 'kept',
  transcript: "stripped: the delegate's conversation",
} as const satisfies Readonly<Record<keyof AgentDelegationTranscript, Kept>>;

/**
 * The delegation snapshot fields a refused snapshot keeps: identity, status,
 * route and counts, never the delegate's text.
 */
export const DELEGATION_SNAPSHOT = {
  delegationId: 'kept',
  status: 'kept',
  outputTruncated: 'kept',
  depth: 'kept',
  nestedDelegation: 'kept',
  parentDelegationId: 'kept',
  permissions: 'kept',
  workspaceDiscarded: 'kept',
  runGeneration: 'kept',
  resultIndex: 'kept',
  routeSnapshot: 'kept',
  reportedRoute: 'kept',
  requestedModelId: 'kept',
  requestedModelLabel: 'kept',
  control: 'kept',
  isolatedWorkspace: 'kept',
  stopRequested: 'kept',
  stoppedBy: 'kept',
  cancelledByUser: 'kept',
  approvalPending: 'kept',
  workspaceObservation: 'kept',
  nativeSessionId: 'kept',
  error: 'kept',
  usage: 'kept',
  capabilities: 'kept',
  phase: 'kept',
  queue: 'kept',
  childDelegationIds: 'kept',
  feed: "stripped: the delegate's Feed titles",
  feedAssignment: "stripped: the delegate's Feed titles",
  parentDescription: "stripped: the parent's task description",
  partialText: "stripped: the delegate's output",
  finalText: "stripped: the delegate's output",
  stopReason: "stripped: the delegate's own words on stopping",
} as const satisfies Readonly<Record<keyof AgentDelegationSnapshot, Kept>>;

/** The fields of a delegation's control command a refused snapshot keeps. */
const DELEGATION_CONTROL_KEYS: ReadonlySet<string> = new Set([
  'operationId',
  'operation',
  'status',
  'steeringDelivery',
]);

const DELEGATION_EVENT = {
  ...STAMPED,
  type: 'token',
} as const satisfies Fields;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStripped(rule: Disposition): rule is Stripped {
  return typeof rule === 'string' && rule.startsWith('stripped: ');
}

function onlyNumbers(value: unknown, depth: number): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === null && depth === 0) return null;
  if (depth > 8) return undefined;
  if (Array.isArray(value))
    return value
      .map((item) => onlyNumbers(item, depth + 1))
      .filter((item) => item !== undefined);
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!TOKEN.test(key) && !ID.test(key)) continue;
    const kept = onlyNumbers(item, depth + 1);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

/** `value` under `rule`, or `undefined` when it is stripped. */
function project(value: unknown, rule: Disposition): unknown {
  if (isStripped(rule)) return undefined;
  switch (rule) {
    case 'id':
      if (typeof value === 'string') return ID.test(value) ? value : undefined;
      if (Array.isArray(value))
        return value.filter(
          (item): item is string => typeof item === 'string' && ID.test(item),
        );
      return undefined;
    case 'token':
      return typeof value === 'string' && TOKEN.test(value) ? value : undefined;
    case 'label':
      return typeof value === 'string' && LABEL.test(value) ? value : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'timestamp':
      if (typeof value === 'number') return project(value, 'number');
      return typeof value === 'string' && ISO_TIME.test(value)
        ? value
        : undefined;
    case 'numbers':
      return onlyNumbers(value, 0);
    case 'empty':
      return typeof value === 'string' ? '' : undefined;
    case 'fixedResult':
      if (typeof value !== 'string') return undefined;
      return FIXED_RESULTS.has(value) ? value : '';
    case 'deliverySummary':
      return typeof value === 'string' && DELIVERY_SUMMARIES.has(value)
        ? value
        : undefined;
    case 'connectorAvailability':
      return readClaudeConnectorAvailability(value);
    case 'errorBody':
      if (typeof value === 'string') return '';
      return projectFields(value, {
        type: 'token',
        code: 'token',
        message: 'empty',
      });
    default:
      if ('each' in rule && isRecord(rule.each)) {
        const each: Fields = rule.each;
        return Array.isArray(value)
          ? value
              .map((item) => projectFields(item, each))
              .filter((item) => item !== undefined)
          : undefined;
      }
      return projectFields(value, rule);
  }
}

function projectFields(
  value: unknown,
  fields: Fields,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const kept = project(value[key], rule);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

/** The census for an event's kind, when the kind is kept. */
export function refusedCensus(data: unknown): Fields | undefined {
  if (!isRecord(data) || typeof data.type !== 'string') return undefined;
  if (data.type === 'result') return RESULT;
  if (data.type === 'error') return ERROR;
  if (data.type === 'system' && data.subtype === 'init') return SYSTEM_INIT;
  if (
    data.type === 'codex' &&
    isRecord(data.event) &&
    typeof data.event.type === 'string' &&
    CODEX_LIFECYCLE_EVENTS.has(data.event.type)
  )
    return CODEX_LIFECYCLE;
  if (data.type === 'canopy_delegation') return DELEGATION_EVENT;
  const kind = CANOPY_KINDS.get(data.type);
  return kind !== undefined && !isStripped(kind) && isRecord(kind)
    ? kind
    : undefined;
}

/**
 * For an event whose agent secret values can't be read: the event kept to
 * its kind's census when the kind is kept (a turn's result, an error, a
 * session's start, a Codex turn or thread event, a delegation snapshot, and
 * the app's own metadata events), else `undefined`, and the event is dropped.
 */
export function refusedProjection(data: unknown): unknown {
  if (!isRecord(data)) return undefined;
  if (data.type === 'canopy_delegation') return refusedDelegation(data);
  const census = refusedCensus(data);
  if (!census) return undefined;
  const projected = projectFields(data, census);
  // An app event its consumers can't read is dropped, not half-kept.
  if (
    data.type === 'canopy_auth_failure' &&
    !isCanopyAuthFailureEventData(projected)
  )
    return undefined;
  return projected;
}

function keptKeys(
  value: Record<string, unknown>,
  census: Readonly<Record<string, Kept>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        Object.prototype.hasOwnProperty.call(census, key) &&
        census[key] === 'kept',
    ),
  );
}

/**
 * A delegation snapshot with its task and transcript emptied and its
 * snapshot kept to known metadata fields, so its card still settles; one
 * that isn't a valid transcript is dropped.
 */
function refusedDelegation(data: Record<string, unknown>): unknown {
  const delegation = data.delegation;
  if (!isAgentDelegationTranscript(delegation)) return undefined;
  const snapshot = keptKeys({ ...delegation.snapshot }, DELEGATION_SNAPSHOT);
  if (isRecord(snapshot.error))
    snapshot.error = { ...snapshot.error, message: '' };
  // Who stopped it, without the stopping agent's description.
  if (isRecord(snapshot.stoppedBy))
    snapshot.stoppedBy = Object.fromEntries(
      Object.entries(snapshot.stoppedBy).filter(
        ([key]) => key !== 'description',
      ),
    );
  for (const field of ['control', 'stopRequested'] as const) {
    const command = snapshot[field];
    if (!isRecord(command)) continue;
    // Only the command's identity and outcome: its error and an apply
    // failure's diffs are the delegate's or the files' text.
    const kept = Object.fromEntries(
      Object.entries(command).filter(([key]) =>
        DELEGATION_CONTROL_KEYS.has(key),
      ),
    );
    const delivery = kept.steeringDelivery;
    snapshot[field] =
      isRecord(delivery) && typeof delivery.reason === 'string'
        ? { ...kept, steeringDelivery: { ...delivery, reason: '' } }
        : kept;
  }
  const projected = {
    ...projectFields(data, DELEGATION_EVENT),
    type: 'canopy_delegation',
    delegation: {
      ...keptKeys({ ...delegation }, DELEGATION_TRANSCRIPT),
      task: { ...delegation.task, description: '', prompt: '' },
      snapshot,
      transcript: [],
    },
  };
  return isAgentDelegationTranscript(projected.delegation)
    ? projected
    : undefined;
}
