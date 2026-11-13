import {
  agentActionToolResult,
  createAgentActionSurface,
  type AgentActionBrand,
  type AgentActionCall,
  type AgentActionHostCapabilities,
  type AgentActionSurface,
  type AgentActionToolKey,
} from '@canopy/agent-actions';
import type {
  CanopyInjectedToolContext,
  CanopyInjectedToolRuntime,
  CanopyInjectedToolTextResult,
} from '../canopy-tools/core';
import { AGENT_ACTION_BRAND } from '../canopy-tools/definitions';
import { desktopCapabilities } from './desktop-capabilities';
import { resolveDesktopTurnKey } from './desktop-environment-port';
import {
  desktopAgentActionFamilies,
  desktopAgentActionPorts,
  type DesktopAgentActionPorts,
} from './desktop-host';
import { DESKTOP_AGENT_ACTOR_KEY } from './desktop-limits-port';
import {
  desktopBotAccessAllowed,
  offersBotActions,
} from './desktop-project-bot-port';
import { desktopWatcherPort } from './desktop-watcher-port';

/** Capabilities of the chat a runtime belongs to. */
export function desktopAgentActionCapabilities(
  runtime: CanopyInjectedToolRuntime,
): AgentActionHostCapabilities {
  const allowedActionTypes = runtime.worktreeActionRuntime?.allowedActionTypes;
  return desktopCapabilities({
    executionScope: runtime.worktreeActionRuntime?.executionScope ?? 'worktree',
    ...(allowedActionTypes ? { allowedActionTypes } : {}),
  });
}

/**
 * The capabilities SearchActions searches for one call: bot actions only
 * while the calling chat's bot access is on. Dispatch keeps them, and the bot
 * service rechecks access and refuses with its own error.
 */
export async function desktopSearchCapabilities(
  runtime: CanopyInjectedToolRuntime,
  call: AgentActionCall<CanopyInjectedToolRuntime>,
): Promise<AgentActionHostCapabilities> {
  const capabilities = desktopAgentActionCapabilities(runtime);
  if (
    !offersBotActions(capabilities.actionTypes) ||
    (await desktopBotAccessAllowed(call))
  )
    return capabilities;
  return {
    ...capabilities,
    actionTypes: capabilities.actionTypes.filter(
      (type) => !offersBotActions([type]),
    ),
  };
}

export function createDesktopAgentActionSurface(
  runtime: CanopyInjectedToolRuntime,
  options: {
    brand?: AgentActionBrand;
    ports?: DesktopAgentActionPorts;
    capabilities?: AgentActionHostCapabilities;
  } = {},
): AgentActionSurface<CanopyInjectedToolRuntime> {
  const capabilities =
    options.capabilities ?? desktopAgentActionCapabilities(runtime);
  const ports = options.ports ?? desktopAgentActionPorts();
  return createAgentActionSurface({
    brand: options.brand ?? AGENT_ACTION_BRAND,
    capabilities,
    families: desktopAgentActionFamilies(capabilities, ports),
    watchers: desktopWatcherPort,
    split: ports.split,
  });
}

const SPLIT_TOOL_KEYS: ReadonlySet<AgentActionToolKey> =
  new Set<AgentActionToolKey>(['start_forked_agent', 'start_branched_agent']);

const LIMITED_ACTION_TYPES: ReadonlySet<string> = new Set([
  'installed_items.set_status',
  'installed_items.uninstall',
  'chat.create',
  'chat.send_message',
  'experiments.set_enabled',
]);

const TURN_UNAVAILABLE_MESSAGE =
  'The running turn could not be identified, so nothing was changed. Retry the same call.';

function isLimitedAction(key: AgentActionToolKey, rawArgs: unknown): boolean {
  if (key !== 'dispatch_action') return false;
  if (typeof rawArgs !== 'object' || rawArgs === null) return false;
  const action = 'action' in rawArgs ? rawArgs.action : undefined;
  return (
    typeof action === 'object' &&
    action !== null &&
    'type' in action &&
    typeof action.type === 'string' &&
    LIMITED_ACTION_TYPES.has(action.type)
  );
}

/** The trusted identity of one desktop tool call. */
export async function desktopAgentActionCall(
  key: AgentActionToolKey,
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
  context?: CanopyInjectedToolContext,
): Promise<AgentActionCall<CanopyInjectedToolRuntime>> {
  const action =
    key === 'dispatch_action' &&
    typeof rawArgs === 'object' &&
    rawArgs !== null &&
    'action' in rawArgs
      ? rawArgs.action
      : null;
  // App Advisor has no action runtime; its chat keys these writes' replays.
  const advisorScopedWrite =
    typeof action === 'object' &&
    action !== null &&
    'type' in action &&
    ((typeof action.type === 'string' &&
      action.type.startsWith('settings.ai_gateway.')) ||
      action.type === 'experiments.set_enabled' ||
      action.type === 'pipeline.run' ||
      (typeof action.type === 'string' &&
        action.type.startsWith('installed_items.')));
  const scoped =
    runtime.worktreeActionRuntime ??
    (advisorScopedWrite ? runtime.worktreeWatcherRuntime : undefined);
  const call: AgentActionCall<CanopyInjectedToolRuntime> = {
    host: runtime,
    toolUseId: context?.toolUseId,
    signal: context?.signal,
    actorKey: DESKTOP_AGENT_ACTOR_KEY,
    ...(scoped
      ? {
          scope: {
            workspaceId: scoped.projectId,
            worktreeId: scoped.worktreeId,
            chatId: scoped.chatId,
          },
        }
      : {}),
  };
  // A run, and a cloud run's cancel or resume (CAN-6354), replay by tool
  // call. A worktree chat's MCP request id restarts with each connection, so
  // the turn, when known, keeps a later turn's call from replaying an earlier
  // one; neither ever requires one.
  const keyedByCall =
    typeof action === 'object' &&
    action !== null &&
    'type' in action &&
    (action.type === 'pipeline.run' ||
      action.type === 'pipeline.execution_cancel' ||
      action.type === 'pipeline.execution_resume');
  if (!keyedByTurn(key, rawArgs) && !keyedByCall) return call;
  const turnKey = await resolveDesktopTurnKey(call);
  return turnKey ? { ...call, turnKey } : call;
}

/** Writes key their replays and limits by the turn; reads need no turn. */
function keyedByTurn(key: AgentActionToolKey, rawArgs: unknown): boolean {
  return isLimitedAction(key, rawArgs) || SPLIT_TOOL_KEYS.has(key);
}

/** Runs one agent action tool for a desktop chat runtime. */
export async function executeDesktopAgentActionTool(
  key: AgentActionToolKey,
  rawArgs: unknown,
  runtime: CanopyInjectedToolRuntime,
  context?: CanopyInjectedToolContext,
): Promise<CanopyInjectedToolTextResult> {
  const call = await desktopAgentActionCall(key, rawArgs, runtime, context);
  if (keyedByTurn(key, rawArgs) && !call.turnKey) {
    return agentActionToolResult({
      requestId: call.toolUseId ?? '',
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: TURN_UNAVAILABLE_MESSAGE,
        retryable: true,
      },
    });
  }
  const capabilities =
    key === 'search_actions'
      ? await desktopSearchCapabilities(runtime, call)
      : undefined;
  return createDesktopAgentActionSurface(
    runtime,
    capabilities ? { capabilities } : {},
  ).execute(key, rawArgs, call);
}
