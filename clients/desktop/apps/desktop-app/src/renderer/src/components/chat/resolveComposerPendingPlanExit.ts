import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type { ChatTab, PendingPlanExit } from '@/stores/chatStore';

const PROVIDER_TYPES: ReadonlySet<string> = new Set<AgentProviderType>([
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
  'copilot',
  'antigravity',
]);

/** A restored proposal keeps the harness that produced it; anything else reads as Claude. */
function restoredPlanSource(value: unknown): AgentProviderType {
  return typeof value === 'string' && PROVIDER_TYPES.has(value)
    ? (value as AgentProviderType)
    : 'claude';
}

/** Resolve live or restored approval state for this composer's own scope. */
export function resolveComposerPendingPlanExit(
  tab:
    | Pick<ChatTab, 'id' | 'pendingPlanExit' | 'pendingPlanExitRequestId'>
    | null
    | undefined,
  scope:
    | { readonly projectId: string; readonly worktreeId: string }
    | null
    | undefined,
  pendingPlanExits: Readonly<Record<string, PendingPlanExit>>,
): PendingPlanExit | null {
  if (!tab || !scope) return null;
  const live = Object.values(pendingPlanExits).find(
    (exit) =>
      exit.chatId === tab.id &&
      exit.projectId === scope.projectId &&
      exit.worktreeId === scope.worktreeId,
  );
  if (live) return live;
  if (!tab.pendingPlanExit) return null;
  return {
    requestId: tab.pendingPlanExitRequestId ?? '',
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: tab.id,
    source: restoredPlanSource(tab.pendingPlanExit.source),
    toolInput: tab.pendingPlanExit,
  };
}
