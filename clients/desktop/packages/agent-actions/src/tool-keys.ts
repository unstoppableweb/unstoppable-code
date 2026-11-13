import { buildInjectedToolNamesForBrand } from '@canopy/protocol/brand';
import type { AgentActionBrand } from './brand';

/**
 * Injected-tool canonical keys of the agent action tools. They are a subset
 * of the desktop injected-tool registry keys and carry the same display
 * names, so every host advertises the same tool names.
 */
export const AGENT_ACTION_TOOL_KEYS = [
  'search_actions',
  'dispatch_action',
  'search_watchers',
  'setup_watchers',
  'delete_watchers',
  'start_forked_agent',
  'start_branched_agent',
] as const;

export type AgentActionToolKey = (typeof AGENT_ACTION_TOOL_KEYS)[number];

/** The tools a cloud chat exposes; a branched agent needs a local worktree. */
export const CLOUD_AGENT_ACTION_TOOL_KEYS = [
  'search_actions',
  'dispatch_action',
  'search_watchers',
  'setup_watchers',
  'delete_watchers',
  'start_forked_agent',
] as const satisfies readonly AgentActionToolKey[];

export const AGENT_ACTION_TOOL_DISPLAY_NAMES = {
  search_actions: 'SearchActions',
  dispatch_action: 'DispatchAction',
  search_watchers: 'SearchWatchers',
  setup_watchers: 'SetupWatchers',
  delete_watchers: 'DeleteWatchers',
  start_forked_agent: 'StartForkedAgent',
  start_branched_agent: 'StartBranchedAgent',
} as const satisfies Record<AgentActionToolKey, string>;

/** The Codex dynamic-tool name of an agent action tool for a brand. */
export function agentActionCodexToolName(
  brand: AgentActionBrand,
  key: AgentActionToolKey,
): string {
  const codex = buildInjectedToolNamesForBrand({
    tools: { namespace: brand.toolNamespace },
  }).codex;
  switch (key) {
    case 'search_actions':
      return codex.searchActions;
    case 'dispatch_action':
      return codex.dispatchAction;
    case 'search_watchers':
      return codex.searchWatchers;
    case 'setup_watchers':
      return codex.setupWatchers;
    case 'delete_watchers':
      return codex.deleteWatchers;
    case 'start_forked_agent':
      return codex.startForkedAgent;
    case 'start_branched_agent':
      return codex.startBranchedAgent;
  }
}
