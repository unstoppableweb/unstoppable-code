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
  'get_github_pull_request_status',
  'schedule_wakeup',
  'save_memory',
  'search_memory',
  'read_memory',
  'add_ledger_entry',
  'search_ledger_entries',
  'update_ledger_entry',
  'delegate_task',
  'get_delegate_output',
  'inspect_delegate',
  'list_delegates',
  'stop_delegate',
  'message_delegate',
  'request_steering',
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
  'get_github_pull_request_status',
  'schedule_wakeup',
  'save_memory',
  'search_memory',
  'read_memory',
  'add_ledger_entry',
  'search_ledger_entries',
  'update_ledger_entry',
  'delegate_task',
  'get_delegate_output',
  'inspect_delegate',
  'list_delegates',
  'stop_delegate',
  'message_delegate',
  'request_steering',
] as const satisfies readonly AgentActionToolKey[];

export const AGENT_ACTION_TOOL_DISPLAY_NAMES = {
  search_actions: 'SearchActions',
  dispatch_action: 'DispatchAction',
  search_watchers: 'SearchWatchers',
  setup_watchers: 'SetupWatchers',
  delete_watchers: 'DeleteWatchers',
  start_forked_agent: 'StartForkedAgent',
  start_branched_agent: 'StartBranchedAgent',
  get_github_pull_request_status: 'GetGitHubPullRequestStatus',
  schedule_wakeup: 'ScheduleWakeup',
  save_memory: 'SaveMemory',
  search_memory: 'SearchMemory',
  read_memory: 'ReadMemory',
  add_ledger_entry: 'AddFeedEntry',
  search_ledger_entries: 'SearchFeedEntries',
  update_ledger_entry: 'UpdateFeedEntry',
  delegate_task: 'DelegateTask',
  get_delegate_output: 'GetDelegateOutput',
  inspect_delegate: 'InspectDelegate',
  list_delegates: 'ListDelegates',
  stop_delegate: 'StopDelegate',
  message_delegate: 'MessageDelegate',
  request_steering: 'RequestSteering',
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
    case 'get_github_pull_request_status':
      return codex.getGithubPullRequestStatus;
    case 'schedule_wakeup':
      return codex.scheduleWakeup;
    case 'save_memory':
      return codex.saveMemory;
    case 'search_memory':
      return codex.searchMemory;
    case 'read_memory':
      return codex.readMemory;
    case 'add_ledger_entry':
      return codex.addLedgerEntry;
    case 'search_ledger_entries':
      return codex.searchLedgerEntries;
    case 'update_ledger_entry':
      return codex.updateLedgerEntry;
    case 'delegate_task':
      return codex.delegateTask;
    case 'get_delegate_output':
      return codex.getDelegateOutput;
    case 'inspect_delegate':
      return codex.inspectDelegate;
    case 'list_delegates':
      return codex.listDelegates;
    case 'stop_delegate':
      return codex.stopDelegate;
    case 'message_delegate':
      return codex.messageDelegate;
    case 'request_steering':
      return codex.requestSteering;
  }
}
