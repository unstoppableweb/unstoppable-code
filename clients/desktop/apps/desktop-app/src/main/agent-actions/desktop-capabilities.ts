import {
  BOT_ACTION_TYPES,
  BROWSER_ACTION_TYPES,
  TRANSCRIPT_READ_ACTION_TYPES,
  PROJECT_ACTION_TYPES,
  EXPERIMENT_ACTION_TYPES,
  INSTALLED_ITEM_ACTION_TYPES,
  CAPABILITY_PACKAGE_ACTION_TYPES,
  PIPELINE_EXECUTIONS_ACTION_TYPES,
  PIPELINES_ACTION_TYPES,
  PULL_REQUEST_REVIEW_ACTION_TYPES,
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
import { isBotsExperimentEnabled } from '../bots/visibility';

/**
 * Every action type a desktop chat surface can dispatch. Read lazily: the
 * legacy type list sits in an import cycle with the tool executor.
 */
export function desktopActionTypes(): readonly string[] {
  return [
    // The other environment actions are retired; projects.* replaces them.
    'models.list',
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
    ...PULL_REQUEST_REVIEW_ACTION_TYPES,
    ...DESKTOP_LEGACY_ACTION_TYPES,
  ];
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
  return {
    executionScope,
    actionTypes,
    botsRegistry: isBotsExperimentEnabled(),
    chatCreatePlacements: desktopChatCreatePlacements(executionScope),
    watcherTriggers: SEARCHABLE_WATCHER_TRIGGERS,
    watcherTargetScope: 'any',
    split: { forked: true, branched: executionScope === 'worktree' },
    hiddenInstructions: true,
    limits: true,
  };
}
