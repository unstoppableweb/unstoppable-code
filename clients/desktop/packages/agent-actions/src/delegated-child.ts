import { agentActionToolResult } from './action-support';
import { CHAT_CONTROL_ACTION_TYPES } from './families/chat-control/actions';
import { PIPELINES_ACTION_TYPES } from './families/pipelines/actions';
import {
  PROJECT_DISCOVERY_TYPES,
  PROJECT_READ_TYPES,
  PROJECT_WRITE_TYPES,
} from './families/projects/actions';
import { PULL_REQUEST_ACTION_TYPES } from './families/pull-request/actions';
import { TRANSCRIPT_READ_ACTION_TYPES } from './families/transcript-read/actions';
import type { AgentActionHostCapabilities } from './surface/capabilities';
import type { AgentActionSurface } from './surface/engine';
import type { AgentActionToolKey } from './tool-keys';
import type { AgentActionToolResult } from './tools/definition';

/**
 * What an agent action does, which decides who may run it (cloud
 * delegation security addendum, section 5):
 *
 * - `read`: reads within the owner's workspace and changes nothing.
 * - `write`: changes the calling chat's own work, such as a pull request
 *   from its branch or its own watchers.
 * - `external`: starts, steers or stops work outside the calling chat (a
 *   new or other chat, task, fork or pipeline run), or arranges to wake the
 *   calling chat later.
 * - `nesting`: starts or controls the calling chat's own delegates.
 * - `steering`: asks the calling delegate's own parent for steering, which
 *   every delegate may do (security addendum, section 5).
 */
export type AgentActionEffect =
  | 'read'
  | 'write'
  | 'external'
  | 'nesting'
  | 'steering';

/**
 * Every action type the cloud agent surface dispatches, by effect. Chat
 * control is `external` for every target: the family already refuses the
 * calling chat itself, and a chat's delegates are controlled through the
 * delegation tools, so any chat it can name here is outside its own tree.
 * An action type missing here has no effect, so delegated children are
 * refused it; the agent-actions conformance suite fails for a host that
 * offers one.
 */
const ACTION_EFFECTS: ReadonlyMap<string, AgentActionEffect> = new Map<
  string,
  AgentActionEffect
>([
  ['workspace.get', 'read'],
  ['worktree.list', 'read'],
  ['chat.list', 'read'],
  ['chat.get', 'read'],
  ['models.list', 'read'],
  ...TRANSCRIPT_READ_ACTION_TYPES.map((type) => [type, 'read'] as const),
  ...PROJECT_DISCOVERY_TYPES.map((type) => [type, 'read'] as const),
  ...PROJECT_READ_TYPES.map((type) => [type, 'read'] as const),
  ['pipeline.execution_list', 'read'],
  ['pipeline.execution_get', 'read'],
  // A settings link and a gateway read change nothing.
  ['settings.open', 'read'],
  ['settings.ai_gateway.get', 'read'],
  ...PULL_REQUEST_ACTION_TYPES.map((type) => [type, 'write'] as const),
  ['chat.create', 'external'],
  ['chat.send_message', 'external'],
  ...PROJECT_WRITE_TYPES.map((type) => [type, 'external'] as const),
  ...CHAT_CONTROL_ACTION_TYPES.map((type) => [type, 'external'] as const),
  ...PIPELINES_ACTION_TYPES.map((type) => [type, 'external'] as const),
  ['pipeline.execution_cancel', 'external'],
  ['pipeline.execution_resume', 'external'],
  // Account configuration is the owner's, outside the chat's own work.
  ['settings.ai_gateway.connect', 'external'],
  ['settings.ai_gateway.update', 'external'],
]);

/**
 * The effect of every agent action tool. `dispatch_action` takes its
 * action's effect. Watchers wake the chat outside its parent's wake budget,
 * so setting one up is `external`, as is a ScheduleWakeup, which arranges
 * another turn of the calling chat; deleting one only touches the chat's own.
 * Searching and reading memory read the owner's memory; saving to it is a
 * write.
 * The Feed tools write only the calling chat's own entries.
 */
const TOOL_EFFECTS: Readonly<
  Record<AgentActionToolKey, AgentActionEffect | 'per_action'>
> = {
  search_actions: 'read',
  dispatch_action: 'per_action',
  search_watchers: 'read',
  setup_watchers: 'external',
  delete_watchers: 'write',
  start_forked_agent: 'external',
  start_branched_agent: 'external',
  get_github_pull_request_status: 'read',
  schedule_wakeup: 'external',
  save_memory: 'write',
  search_memory: 'read',
  read_memory: 'read',
  // The Feed tools act as the calling chat in its own Feed: search reads, and
  // the Ledger lets a chat add entries it authors and change only entries it
  // owns (LD04), so add and update are the chat's own work.
  search_ledger_entries: 'read',
  add_ledger_entry: 'write',
  update_ledger_entry: 'write',
  delegate_task: 'nesting',
  get_delegate_output: 'nesting',
  inspect_delegate: 'nesting',
  list_delegates: 'nesting',
  stop_delegate: 'nesting',
  message_delegate: 'nesting',
  request_steering: 'steering',
};

/** The effect of an action type, or undefined when it is unclassified. */
export function agentActionEffect(type: string): AgentActionEffect | undefined {
  return ACTION_EFFECTS.get(type);
}

/**
 * The effect of one tool call, or undefined when it can't be classified: a
 * DispatchAction call with no action type, or an unclassified one.
 */
export function agentActionCallEffect(
  key: AgentActionToolKey,
  args: unknown,
): AgentActionEffect | undefined {
  const effect = TOOL_EFFECTS[key];
  if (effect !== 'per_action') return effect;
  const action =
    typeof args === 'object' && args !== null && 'action' in args
      ? args.action
      : undefined;
  const type =
    typeof action === 'object' && action !== null && 'type' in action
      ? action.type
      : undefined;
  return typeof type === 'string' ? agentActionEffect(type) : undefined;
}

/**
 * What a managed delegation child was granted, from its Core delegation
 * record. `read_only` is the only grant production accepts; `full` is
 * staging-only (security addendum, section 4.1).
 */
export interface DelegatedChildGrant {
  readonly writeGrant: 'read_only' | 'full';
  readonly nestedAllowed: boolean;
}

/**
 * The grant a child gets when its delegation record can't be read: the
 * narrowest one, so a failed read never widens a child's surface.
 */
export const NARROWEST_DELEGATED_CHILD_GRANT: DelegatedChildGrant =
  Object.freeze({ writeGrant: 'read_only', nestedAllowed: false });

/**
 * Whether a delegated child with this grant may run an action with this
 * effect. Reads and steering requests are open to every child; writes to
 * full-write children; delegation tools only with nesting; anything that
 * reaches outside the tree, and anything unclassified, to none.
 */
export function delegatedChildAllows(
  effect: AgentActionEffect | undefined,
  grant: DelegatedChildGrant,
): boolean {
  switch (effect) {
    case 'read':
    case 'steering':
      return true;
    case 'write':
      return grant.writeGrant === 'full';
    case 'nesting':
      return grant.nestedAllowed;
    case 'external':
    case undefined:
      return false;
  }
}

const DELEGATE_REFUSAL_MESSAGE =
  'This action isn’t available to delegates. Nothing was read or changed. Report what you need in your result.';

function policyBlocked(toolUseId: string | undefined): AgentActionToolResult {
  return agentActionToolResult({
    requestId: toolUseId ?? '',
    ok: false,
    error: {
      code: 'policy_blocked',
      message: DELEGATE_REFUSAL_MESSAGE,
      retryable: false,
    },
  });
}

/**
 * The host capabilities a delegated child's surface is built with: only the
 * action types its grant allows, and no forks. SearchActions and the
 * DispatchAction schema then list only what the child may run.
 */
export function delegatedChildCapabilities(
  capabilities: AgentActionHostCapabilities,
  grant: DelegatedChildGrant,
): AgentActionHostCapabilities {
  return {
    ...capabilities,
    actionTypes: capabilities.actionTypes.filter((type) =>
      delegatedChildAllows(agentActionEffect(type), grant),
    ),
    searchHiddenActionTypes: (
      capabilities.searchHiddenActionTypes ?? []
    ).filter((type) => delegatedChildAllows(agentActionEffect(type), grant)),
    split: { forked: false, branched: false },
  };
}

/**
 * A delegated child's agent surface over one built with
 * {@link delegatedChildCapabilities}: tools the child may never run are not
 * listed, and every call the grant doesn't allow is refused with
 * `policy_blocked` before the surface parses it, so nothing is read or
 * written.
 */
export function restrictAgentActionSurfaceForDelegatedChild<H>(
  surface: AgentActionSurface<H>,
  grant: DelegatedChildGrant,
): AgentActionSurface<H> {
  return {
    toolDefinitions: () =>
      surface.toolDefinitions().filter((definition) => {
        const effect = TOOL_EFFECTS[definition.key];
        return effect === 'per_action' || delegatedChildAllows(effect, grant);
      }),
    execute: (key, rawArgs, call) =>
      delegatedChildAllows(agentActionCallEffect(key, rawArgs), grant)
        ? surface.execute(key, rawArgs, call)
        : Promise.resolve(policyBlocked(call.toolUseId)),
  };
}
