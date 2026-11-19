/**
 * Browser-safe contracts for pipeline host steps (`runs.using: host`).
 *
 * The shared executor (worker side) parses inputs and raises one typed request
 * through `ExecutionRuntime.pipelineHostActions`; the desktop host (core side)
 * applies policy and does the work. Hosts without the port fail the step with
 * `failure_reason: needs_desktop`; a port that doesn't declare the action
 * fails it with `needs_host` (CAN-6082). Either way, an action with a Node
 * `runs.fallback` runs that instead.
 */
import {
  SIDEBAR_ITEM_GROUP_COLORS,
  type SidebarItemGroupColor,
} from '@canopy/protocol/sidebar';

/** Output key carrying the typed failure reason; `''` when the step succeeded. */
export const PIPELINE_HOST_FAILURE_REASON_OUTPUT = 'failure_reason';

/** Closed set of typed host-step failure codes. Later phases emit the rest. */
export const PIPELINE_HOST_FAILURE_REASONS = [
  'not_found',
  'advisor_access_disabled',
  'owner_context_unavailable',
  'validation_failed',
  'target_not_ready',
  'unsupported_action',
  'authorization_conflict',
  'needs_desktop',
  'needs_host',
  'setup_failed',
  'setup_timed_out',
  'turn_failed',
  'reply_timed_out',
] as const;

export type PipelineHostFailureReason =
  (typeof PIPELINE_HOST_FAILURE_REASONS)[number];

export const PIPELINE_NEEDS_DESKTOP_MESSAGE =
  'This step needs the desktop app.';

/**
 * The `needs_host` message: the step's action and the host that runs the
 * workflow, which names itself (for example "the desktop app").
 */
export function pipelineNeedsHostMessage(
  actionId: PipelineHostActionId,
  hostName: string,
): string {
  return `The ${actionId} step can't run in ${hostName}.`;
}

/** A typed refusal a host adapter (or the CAN-4541 owner check) throws; the adapter turns it into a failure result. */
export class PipelineHostRefusal extends Error {
  constructor(
    readonly failureReason: PipelineHostFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineHostRefusal';
  }
}

const PIPELINE_HOST_ACTION_IDS = [
  'move-to-group',
  'create-worktree',
  'create-project-entry',
  'create-bot-entry',
  'send-agent-message',
  'wait-for-agent-reply',
  'github-publish-review',
] as const;

export type PipelineHostActionId = (typeof PIPELINE_HOST_ACTION_IDS)[number];

/**
 * Every host action. The desktop app, the daemon pipeline host and the routed
 * CLI each answer all of them, as before host ports declared support (CAN-6082).
 */
export const EVERY_PIPELINE_HOST_ACTION: ReadonlySet<PipelineHostActionId> =
  new Set(PIPELINE_HOST_ACTION_IDS);

export function isPipelineHostActionId(
  value: string,
): value is PipelineHostActionId {
  return PIPELINE_HOST_ACTION_IDS.some((id) => id === value);
}

/** `group` is a name, `groupId` an existing `grp-*` id, `remove` clears membership. Exactly one. */
export type MoveToGroupTarget =
  | { kind: 'name'; name: string; color?: SidebarItemGroupColor }
  | { kind: 'id'; groupId: string }
  | { kind: 'remove' };

export type MoveToGroupTask =
  | { kind: 'project'; projectId: string; taskId: string }
  | { kind: 'bot'; botId: string; taskId: string };

export interface MoveToGroupInputs {
  task: MoveToGroupTask;
  target: MoveToGroupTarget;
}

export type MoveToGroupNotGroupedReason =
  | 'removed'
  | 'group_limit_reached'
  | 'item_not_groupable'
  | 'group_not_found';

const MOVE_TO_GROUP_OUTPUTS = [
  'group_id',
  'group_name',
  'group_created',
  'grouped',
  'not_grouped_reason',
] as const;

/** Every output `''` except `grouped: 'false'`; the shape every typed failure carries. */
export function emptyMoveToGroupOutputs(): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const name of MOVE_TO_GROUP_OUTPUTS) {
    outputs[name] = '';
  }
  outputs.grouped = 'false';
  return outputs;
}

export type HostInputParse<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

// Same rule as `validateId` in `node/lib/validation.ts` and the desktop app's
// `lib/validation.ts`; duplicated because this module must stay browser-safe.
export const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// Bot ids are snake_case (`app_advisor`), so they also allow underscores.
export const SAFE_BOT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const GROUP_ID_PREFIX = 'grp-';

/** The trimmed input, or `undefined` when it is missing or blank. */
export function presentInput(
  inputs: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = inputs[name]?.trim();
  return value ? value : undefined;
}

function unsafeIdMessage(actionName: string, input: string): string {
  return `${actionName} "${input}" must be lowercase alphanumeric with hyphens`;
}

function parseColor(value: string): SidebarItemGroupColor | undefined {
  return SIDEBAR_ITEM_GROUP_COLORS.find((color) => color === value);
}

const COLOR_NEEDS_NAME_MESSAGE =
  'move-to-group "color" applies only when "group" names a group';

/** A project or bot task address, shared by host steps that take one. */
export function parseHostTaskAddress(
  inputs: Record<string, string | undefined>,
  actionName: string,
): HostInputParse<MoveToGroupTask> {
  const projectId = presentInput(inputs, 'project_id');
  const botId = presentInput(inputs, 'bot_id');
  const taskId = presentInput(inputs, 'task_id');
  if ((projectId === undefined) === (botId === undefined)) {
    return {
      ok: false,
      message: `${actionName} requires exactly one of "project_id" or "bot_id"`,
    };
  }
  if (taskId === undefined) {
    return { ok: false, message: `${actionName} requires "task_id"` };
  }
  if (!SAFE_ID_RE.test(taskId)) {
    return { ok: false, message: unsafeIdMessage(actionName, 'task_id') };
  }
  if (projectId !== undefined) {
    return SAFE_ID_RE.test(projectId)
      ? { ok: true, value: { kind: 'project', projectId, taskId } }
      : { ok: false, message: unsafeIdMessage(actionName, 'project_id') };
  }
  const bot = botId ?? '';
  return SAFE_BOT_ID_RE.test(bot)
    ? { ok: true, value: { kind: 'bot', botId: bot, taskId } }
    : {
        ok: false,
        message: `${actionName} "bot_id" must be lowercase alphanumeric with hyphens or underscores`,
      };
}

function parseMoveToGroupTask(
  inputs: Record<string, string | undefined>,
): HostInputParse<MoveToGroupTask> {
  return parseHostTaskAddress(inputs, 'move-to-group');
}

function parseGroupIdTarget(
  groupId: string,
  color: string | undefined,
): HostInputParse<MoveToGroupTarget> {
  if (
    !groupId.startsWith(GROUP_ID_PREFIX) ||
    !SAFE_ID_RE.test(groupId.slice(GROUP_ID_PREFIX.length))
  ) {
    return {
      ok: false,
      message:
        'move-to-group "group_id" must be an existing group id (grp-...)',
    };
  }
  return color === undefined
    ? { ok: true, value: { kind: 'id', groupId } }
    : { ok: false, message: COLOR_NEEDS_NAME_MESSAGE };
}

function parseGroupNameTarget(
  name: string,
  color: string | undefined,
): HostInputParse<MoveToGroupTarget> {
  if (name.toLowerCase() === 'none') {
    return color === undefined
      ? { ok: true, value: { kind: 'remove' } }
      : { ok: false, message: COLOR_NEEDS_NAME_MESSAGE };
  }
  if (color === undefined) {
    return { ok: true, value: { kind: 'name', name } };
  }
  const parsedColor = parseColor(color);
  return parsedColor === undefined
    ? {
        ok: false,
        message: `move-to-group "color" must be one of: ${SIDEBAR_ITEM_GROUP_COLORS.join(', ')}`,
      }
    : { ok: true, value: { kind: 'name', name, color: parsedColor } };
}

export function parseMoveToGroupInputs(
  inputs: Record<string, string | undefined>,
): HostInputParse<MoveToGroupInputs> {
  const task = parseMoveToGroupTask(inputs);
  if (!task.ok) {
    return task;
  }
  const group = presentInput(inputs, 'group');
  const groupId = presentInput(inputs, 'group_id');
  const color = presentInput(inputs, 'color');
  if ((group === undefined) === (groupId === undefined)) {
    return {
      ok: false,
      message: 'move-to-group requires exactly one of "group" or "group_id"',
    };
  }
  const target =
    groupId !== undefined
      ? parseGroupIdTarget(groupId, color)
      : parseGroupNameTarget(group ?? '', color);
  return target.ok
    ? { ok: true, value: { task: task.value, target: target.value } }
    : target;
}

export interface PipelineHostIdempotencyParts {
  executionId: string;
  jobId: string;
  childId?: string;
  stepId: string;
  attempt: number;
  iteration: number;
}

/** `pipeline-host:<execution>:<job>:<child or ''>:<step>:<attempt>:<iteration>`. */
export function buildPipelineHostIdempotencyKey(
  parts: PipelineHostIdempotencyParts,
): string {
  return [
    'pipeline-host',
    parts.executionId,
    parts.jobId,
    parts.childId ?? '',
    parts.stepId,
    String(parts.attempt),
    String(parts.iteration),
  ].join(':');
}
