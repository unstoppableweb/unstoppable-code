import type {
  BillingLane,
  MergeQueueAgentHandling,
  NavigationMode,
  WorkspaceLayoutMode,
} from './types';

export function isNavigationMode(value: unknown): value is NavigationMode {
  return value === 'code' || value === 'work';
}

export function isWorkspaceLayoutMode(
  value: unknown,
): value is WorkspaceLayoutMode {
  return value === 'minimal' || value === 'advanced';
}

export const BILLING_LANES = [
  'claude-native',
  'codex-native',
  'ai-credits',
  'ollama',
] as const satisfies readonly BillingLane[];

export function isBillingLane(value: unknown): value is BillingLane {
  return BILLING_LANES.some((lane) => lane === value);
}

export const MERGE_QUEUE_AGENT_HANDLING_VALUES: readonly MergeQueueAgentHandling[] =
  ['always', 'when_hook_absent', 'never'];

export const DEFAULT_MERGE_QUEUE_AGENT_HANDLING: MergeQueueAgentHandling =
  'when_hook_absent';

export function isMergeQueueAgentHandling(
  value: unknown,
): value is MergeQueueAgentHandling {
  return MERGE_QUEUE_AGENT_HANDLING_VALUES.some((mode) => mode === value);
}

/** Null selects the upstream default; zero does not disable multi-agent. */
export function normalizeCodexMaxConcurrentSubagents(
  value: unknown,
): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
