import type {
  AgentDelegationQueueState,
  AgentDelegationSnapshot,
  DelegationCapabilityKind,
  DelegationCapabilitySkipReason,
  DelegationCapabilitySource,
  DelegationCapabilitySummary,
} from '@canopy/protocol/delegation';

/** Header status for delegated work waiting for a free slot. */
export const DELEGATED_AGENT_QUEUED_LABEL = 'Queued';

/** Header status for a delegation stopped by the user or by policy. */
export const DELEGATED_AGENT_CANCELLED_LABEL = 'Cancelled';

/** Header status for a delegation an agent (or an ancestor's stop) ended. */
export const DELEGATED_AGENT_STOPPED_BY_PARENT_LABEL = 'Stopped by parent';

/** Accessible name and tooltip of the row's Stop control. */
export const DELEGATED_AGENT_STOP_ACCESSIBLE_LABEL = 'Stop delegation';

/** Stop tooltip when tasks this delegation started are still live. */
export const DELEGATED_AGENT_STOP_WITH_DESCENDANTS_LABEL =
  'Stop delegation and the tasks it started';

/** The Stop control while its request is in flight. */
export const DELEGATED_AGENT_STOPPING_LABEL = 'Stopping…';

/** Notice when a single delegation could not be stopped. */
export const DELEGATED_AGENT_STOP_FAILED_LABEL =
  "Couldn't stop the delegation.";

/** Agent activity header action that stops every live delegation. */
export const AGENT_ACTIVITY_STOP_ALL_LABEL = 'Stop all delegates';

/** Confirming action of the inline Stop all confirmation. */
export const AGENT_ACTIVITY_STOP_ALL_CONFIRM_LABEL = 'Stop all';

/** Dismissing action of the inline Stop all confirmation. */
export const AGENT_ACTIVITY_STOP_ALL_CANCEL_LABEL = 'Keep running';

/** Notice when Stop all could not stop the chat's delegations. */
export const AGENT_ACTIVITY_STOP_ALL_FAILED_LABEL =
  "Couldn't stop the delegations.";

/** Action that reads an isolated delegate's changes from its worktree. */
export const DELEGATED_AGENT_SHOW_CHANGES_LABEL = 'Show changes';

/** Action that reads an isolated delegate's changes again. */
export const DELEGATED_AGENT_REFRESH_CHANGES_LABEL = 'Refresh changes';

/** Status while an isolated delegate's changes are read. */
export const DELEGATED_AGENT_LOADING_CHANGES_LABEL = 'Loading changes…';

/** An isolated delegate whose worktree matches its starting commit. */
export const DELEGATED_AGENT_NO_CHANGES_LABEL =
  "No changes in the delegate's worktree";

/** A changed file shown without a diff: protected, not text, or too large. */
export const DELEGATED_AGENT_NO_DIFF_LABEL = 'No diff shown for this file';

/** A changed file whose diff was cut to fit. */
export const DELEGATED_AGENT_DIFF_SHORTENED_LABEL = 'Diff shortened to fit';

/** Notice when an isolated delegate's changes could not be read. */
export const DELEGATED_AGENT_CHANGES_FAILED_LABEL =
  "Couldn't read the delegate's changes.";

/** Retry after the changes could not be read. */
export const DELEGATED_AGENT_CHANGES_RETRY_LABEL = 'Try again';

/** Notice when a listing shows only some changed files. */
export function delegatedAgentChangesShownLabel(count: number): string {
  return `Showing first ${count} ${count === 1 ? 'file' : 'files'}`;
}

/** Inline Stop all question: `Stop 1 delegation?` / `Stop N delegations?`. */ /** Inline Stop all question: `Stop 1 delegation?` / `Stop N delegations?`. */
export function agentActivityStopAllPrompt(count: number): string {
  return `Stop ${count} ${count === 1 ? 'delegation' : 'delegations'}?`;
}

/**
 * Whether an agent, rather than the user, ended this delegation: its parent
 * stopped it, or it was stopped because an ancestor was. A stop the user
 * aimed at this delegation itself keeps `Cancelled`.
 */
export function delegatedAgentStoppedByParent(
  snapshot: Pick<
    AgentDelegationSnapshot,
    'status' | 'stopReason' | 'stoppedBy'
  >,
): boolean {
  if (snapshot.status !== 'cancelled') return false;
  return (
    snapshot.stopReason === 'stopped_by_parent' ||
    snapshot.stopReason === 'ancestor_stopped' ||
    snapshot.stoppedBy?.kind === 'agent'
  );
}

const statusLabels: Readonly<
  Record<AgentDelegationSnapshot['status'], string>
> = {
  pending: DELEGATED_AGENT_QUEUED_LABEL,
  running: '',
  completed: '',
  failed: 'Failed',
  cancelled: DELEGATED_AGENT_CANCELLED_LABEL,
  interrupted: 'Interrupted',
  deadline_exceeded: 'Deadline exceeded',
};

/**
 * Header status for a delegation, or an empty string when the spinner (or
 * nothing, for a successful run) says it all.
 */
export function delegatedAgentStatusLabel(
  snapshot: Pick<
    AgentDelegationSnapshot,
    'status' | 'stopReason' | 'stoppedBy'
  >,
): string {
  if (delegatedAgentStoppedByParent(snapshot))
    return DELEGATED_AGENT_STOPPED_BY_PARENT_LABEL;
  return statusLabels[snapshot.status] ?? '';
}

/** Row label for the delegated task's effective capabilities. */
export const DELEGATED_AGENT_CAPABILITIES_LABEL = 'Capabilities';

/** Accessible names for the capabilities disclosure. */
export const DELEGATED_AGENT_CAPABILITIES_SHOW_LABEL = 'Show capabilities';
export const DELEGATED_AGENT_CAPABILITIES_HIDE_LABEL = 'Hide capabilities';

/** Heading for capabilities that could not be given to the delegated task. */
export const DELEGATED_AGENT_CAPABILITIES_SKIPPED_LABEL = 'Skipped';

/** Display order of capability sources; matches the protocol order. */
export const DELEGATED_AGENT_CAPABILITY_SOURCE_ORDER: readonly DelegationCapabilitySource[] =
  ['agent', 'inherited', 'explicit', 'loaded'];

const sourceLabels: Readonly<Record<DelegationCapabilitySource, string>> = {
  agent: 'Agent',
  inherited: 'Inherited',
  explicit: 'Assigned',
  loaded: 'Loaded',
};

const kindLabels: Readonly<Record<DelegationCapabilityKind, string>> = {
  skill: 'skill',
  plugin: 'plugin',
  mcp: 'MCP server',
};

const skipReasonLabels: Readonly<
  Record<DelegationCapabilitySkipReason, string>
> = {
  missing_selection: 'Not installed or turned off',
  unsupported_capability: "Can't run in a delegated task",
  unsupported_hooks: "Uses hooks, which delegated tasks can't run",
  unsupported_lsp: "Uses a language server, which delegated tasks can't run",
  unsupported_skill_execution: 'Runs commands outside approvals',
  unavailable_asset: 'Too large to share with a delegated task',
};

/** Fallback when a newer host records a reason this build does not know. */
export const DELEGATED_AGENT_CAPABILITY_UNKNOWN_SKIP_REASON = 'Not available';

/** Label for a capability source group, e.g. `explicit` → `Assigned`. */
export function delegatedAgentCapabilitySourceLabel(
  source: DelegationCapabilitySource,
): string {
  return sourceLabels[source] ?? source;
}

/** Lower-case kind shown after a capability name, e.g. `MCP server`. */
export function delegatedAgentCapabilityKindLabel(
  kind: DelegationCapabilityKind,
): string {
  return kindLabels[kind] ?? kind;
}

/** Short plain-language reason a capability was skipped. */
export function delegatedAgentCapabilitySkipReasonLabel(
  reason: DelegationCapabilitySkipReason,
): string {
  return (
    skipReasonLabels[reason] ?? DELEGATED_AGENT_CAPABILITY_UNKNOWN_SKIP_REASON
  );
}

/** `and N more` for entries dropped to keep the summary bounded. */
export function delegatedAgentOmittedLabel(count: number): string {
  return `and ${count} more`;
}

/** `N skipped`, counting listed and omitted skipped entries. */
export function delegatedAgentSkippedCountLabel(count: number): string {
  return `${count} skipped`;
}

/** Whether a capability summary has anything worth showing. */
export function hasDelegatedAgentCapabilityEntries(
  summary: DelegationCapabilitySummary | undefined,
): summary is DelegationCapabilitySummary {
  if (!summary) return false;
  return (
    summary.items.length > 0 ||
    summary.skipped.length > 0 ||
    (summary.omittedItems ?? 0) > 0 ||
    (summary.omittedSkipped ?? 0) > 0
  );
}

/**
 * Collapsed summary, e.g. `Inherited 4 · Assigned 1 · Loaded 1 · 2 skipped`.
 * Zero counts are omitted; omitted skipped entries count toward `skipped`.
 */
export function delegatedAgentCapabilityCountsLabel(
  summary: DelegationCapabilitySummary,
): string {
  const parts: string[] = [];
  for (const source of DELEGATED_AGENT_CAPABILITY_SOURCE_ORDER) {
    const count = summary.items.filter((item) => item.source === source).length;
    if (count > 0)
      parts.push(`${delegatedAgentCapabilitySourceLabel(source)} ${count}`);
  }
  const omittedItems = summary.omittedItems ?? 0;
  if (omittedItems > 0) parts.push(`${omittedItems} more`);
  const skipped = summary.skipped.length + (summary.omittedSkipped ?? 0);
  if (skipped > 0) parts.push(delegatedAgentSkippedCountLabel(skipped));
  return parts.join(' · ');
}

/**
 * Optional detail under `Queued`: `App limit reached`, `Waiting for a slot`,
 * `Up next`, or `N task(s) ahead`. Undefined when the snapshot carries no
 * live fields.
 */
export function delegatedAgentQueueDetail(
  queue: AgentDelegationQueueState | undefined,
): string | undefined {
  if (!queue) return undefined;
  if (queue.waitingFor === 'app') return 'App limit reached';
  // A cloud delegate whose machine has no free turn slot yet: it starts when
  // one frees up, so no position is shown.
  if (queue.waitingFor === 'slot') return 'Waiting for a slot';
  const position = queue.position;
  if (position === undefined || !Number.isSafeInteger(position) || position < 1)
    return undefined;
  if (position === 1) return 'Up next';
  const ahead = position - 1;
  return `${ahead} ${ahead === 1 ? 'task' : 'tasks'} ahead`;
}
