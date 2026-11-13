import {
  BOT_ACTION_TYPES,
  BROWSER_ACTION_TYPES,
  ENVIRONMENT_ACTION_TYPES,
  TRANSCRIPT_READ_ACTION_TYPES,
  PROJECT_ACTION_TYPES,
  EXPERIMENT_ACTION_TYPES,
  INSTALLED_ITEM_ACTION_TYPES,
  CAPABILITY_PACKAGE_ACTION_TYPES,
  PIPELINE_EXECUTIONS_ACTION_TYPES,
  PIPELINES_ACTION_TYPES,
  SEARCHABLE_WATCHER_TRIGGERS,
  SETTINGS_ACTION_TYPES,
  type AgentActionExecutionScope,
  type AgentActionHostCapabilities,
  type AgentChatCreatePlacement,
} from '@canopy/agent-actions';
import {
  DESKTOP_COWORK_CHAT_PLACEMENTS,
  DESKTOP_WORKTREE_CHAT_PLACEMENTS,
} from '../canopy-tools/definitions';
import { DESKTOP_LEGACY_ACTION_TYPES } from '../canopy-tools/worktree-actions';

/**
 * Every action type a desktop chat surface can dispatch. Read lazily: the
 * legacy type list sits in an import cycle with the tool executor.
 */
export function desktopActionTypes(): readonly string[] {
  return [
    ...ENVIRONMENT_ACTION_TYPES,
    ...TRANSCRIPT_READ_ACTION_TYPES,
    ...PROJECT_ACTION_TYPES,
    ...BOT_ACTION_TYPES,
    ...EXPERIMENT_ACTION_TYPES,
    ...INSTALLED_ITEM_ACTION_TYPES,
    ...SETTINGS_ACTION_TYPES,
    ...CAPABILITY_PACKAGE_ACTION_TYPES,
    ...PIPELINES_ACTION_TYPES,
    ...PIPELINE_EXECUTIONS_ACTION_TYPES,
    ...BROWSER_ACTION_TYPES,
    ...DESKTOP_LEGACY_ACTION_TYPES,
  ];
}

/**
 * The environment actions that alias canonical project actions, each with
 * the project action that replaces it. Desktop search lists an alias only for
 * an exact lookup while its replacement is offered; dispatch still accepts
 * it. `chat.create` is not one: its new-worktree placement, model and
 * thinking level have no canonical equivalent.
 */
export const DESKTOP_ENVIRONMENT_ALIASES: Readonly<Record<string, string>> = {
  'workspace.get': 'projects.list',
  'worktree.list': 'projects.list_tasks',
  'chat.list': 'projects.list_task_chats',
  'chat.get': 'projects.get_last_agent_response',
  'chat.send_message': 'projects.send_message',
};

function searchHiddenAliases(actionTypes: readonly string[]): string[] {
  return Object.entries(DESKTOP_ENVIRONMENT_ALIASES)
    .filter(
      ([alias, canonical]) =>
        actionTypes.includes(alias) && actionTypes.includes(canonical),
    )
    .map(([alias]) => alias);
}

/**
 * Where a desktop chat may start another chat. Cowork chats have no
 * worktrees, so they start chats beside themselves only.
 */
export function desktopChatCreatePlacements(
  executionScope: AgentActionExecutionScope,
): readonly AgentChatCreatePlacement[] {
  return executionScope === 'worktree'
    ? DESKTOP_WORKTREE_CHAT_PLACEMENTS
    : DESKTOP_COWORK_CHAT_PLACEMENTS;
}

/**
 * Capabilities of a desktop chat. Directory-scoped (Cowork) chats cannot
 * branch or start chats in new worktrees; a restricted runtime dispatches
 * only its allowed action types.
 */
export function desktopCapabilities(options: {
  executionScope: AgentActionExecutionScope;
  allowedActionTypes?: readonly string[];
}): AgentActionHostCapabilities {
  const { executionScope } = options;
  const actionTypes = options.allowedActionTypes ?? desktopActionTypes();
  const searchHiddenActionTypes = searchHiddenAliases(actionTypes);
  return {
    executionScope,
    actionTypes,
    ...(searchHiddenActionTypes.length > 0 ? { searchHiddenActionTypes } : {}),
    chatCreatePlacements: desktopChatCreatePlacements(executionScope),
    watcherTriggers: SEARCHABLE_WATCHER_TRIGGERS,
    watcherTargetScope: 'any',
    split: { forked: true, branched: executionScope === 'worktree' },
    hiddenInstructions: true,
    limits: true,
  };
}
