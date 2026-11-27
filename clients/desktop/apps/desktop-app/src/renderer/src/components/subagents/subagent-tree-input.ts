import type {
  ManagedSubagentInput,
  SubagentTreeInput,
  WorkflowRunSubagentInput,
} from '@canopy/agent-transcript';
import type { LoadedSubagentInputs } from '@canopy/agent-transcript/lib/subagent-tree/native-inputs';
import type { ManagedDelegationTreeEntry } from '@canopy/desktop-shared/types';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Maps the managed-tree IPC projection onto the pure transcript tree input. */
export function managedSubagentInputFromTreeEntry(
  entry: ManagedDelegationTreeEntry,
): ManagedSubagentInput {
  return {
    delegationId: entry.snapshot.delegationId,
    runGeneration: entry.runGeneration,
    sequence: entry.sequence,
    snapshot: entry.snapshot,
    description: entry.description,
    prompt: entry.prompt,
    createdAt: entry.createdAt,
    ...(entry.runStartedAt !== undefined
      ? { startedAt: entry.runStartedAt }
      : {}),
    ...(entry.runSettledAt !== undefined
      ? { settledAt: entry.runSettledAt }
      : {}),
  };
}

/** Combines the canonical IPC tree with loaded transcript-only native detail. */
export function buildDesktopSubagentTreeInput(input: {
  readonly root: { readonly id: string; readonly title: string };
  readonly managedEntries: readonly ManagedDelegationTreeEntry[] | null;
  readonly loaded: LoadedSubagentInputs;
  readonly workflowRuns?: readonly WorkflowRunSubagentInput[];
}): SubagentTreeInput {
  return {
    root: input.root,
    managed: [
      ...(input.managedEntries ?? []).map(managedSubagentInputFromTreeEntry),
      ...input.loaded.managed,
    ],
    claudeNative: input.loaded.claudeNative,
    codexNative: input.loaded.codexNative,
    ...(input.workflowRuns && input.workflowRuns.length > 0
      ? { workflowRuns: input.workflowRuns }
      : {}),
    complete: input.managedEntries !== null,
  };
}

function snapshotFingerprint(input: ManagedSubagentInput): readonly unknown[] {
  const snapshot = input.snapshot;
  return [
    input.delegationId,
    input.runGeneration,
    input.sequence,
    input.agentBlockId ?? '',
    input.description,
    input.prompt ?? '',
    snapshot.status,
    snapshot.phase ?? '',
    snapshot.approvalPending === true,
    snapshot.parentDelegationId ?? '',
    snapshot.nativeSessionId ?? '',
    snapshot.stopReason ?? '',
    snapshot.stoppedBy?.kind ?? '',
    snapshot.workspaceDiscarded ?? false,
    snapshot.isolatedWorkspace !== undefined,
    snapshot.isolatedWorkspace?.revision ?? '',
    snapshot.routeSnapshot?.runtimeModelLabel ?? '',
    snapshot.routeSnapshot?.selectedModelLabel ?? '',
    snapshot.routeSnapshot?.runtimeModelId ?? '',
    snapshot.routeSnapshot?.selectedModelId ?? '',
    snapshot.routeSnapshot?.effectiveThinkingLevel ?? '',
    snapshot.routeSnapshot?.requestedThinkingLevel ?? '',
    snapshot.routeSnapshot?.harnessId ?? '',
    snapshot.reportedRoute?.harnessId ?? '',
    snapshot.reportedRoute?.runtimeModelId ?? '',
    snapshot.reportedRoute?.runtimeModelLabel ?? '',
    snapshot.requestedModelId ?? '',
    snapshot.error?.message ?? '',
    input.createdAt ?? 0,
    input.startedAt ?? 0,
    input.settledAt ?? 0,
  ];
}

function stableRows<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
): readonly T[] {
  return [...values].sort((left, right) =>
    compareText(keyFor(left), keyFor(right)),
  );
}

/** Fingerprints only values that affect the tree/inspector, not transcript text. */
export function subagentTreeInputFingerprint(input: SubagentTreeInput): string {
  const managed = stableRows(
    input.managed,
    (entry) =>
      `${entry.delegationId}\u0000${entry.runGeneration}\u0000${entry.sequence}\u0000${entry.agentBlockId ?? ''}`,
  ).map(snapshotFingerprint);
  const claude = stableRows(
    input.claudeNative ?? [],
    (entry) => entry.toolUseId,
  ).map((entry) => [
    entry.toolUseId,
    entry.parentId ?? '',
    entry.subagentType,
    entry.description,
    entry.prompt ?? '',
    entry.state,
    entry.runInBackground,
    entry.modelLabel ?? '',
    entry.startedAt ?? 0,
    entry.settledAt ?? 0,
  ]);
  const codex = stableRows(
    input.codexNative ?? [],
    (entry) => `${entry.agentBlockId}\u0000${entry.callId}`,
  ).map((entry) => [
    entry.agentBlockId,
    entry.callId,
    entry.tool,
    entry.status,
    entry.senderThreadId,
    [...entry.receiverThreadIds].sort(compareText),
    entry.prompt,
    entry.description ?? '',
    entry.model ?? '',
    entry.reasoningEffort ?? '',
    Object.entries(entry.agentsStates)
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, state]) => [id, state.status, state.message ?? '']),
    Object.entries(entry.receiverAgents ?? {})
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, agent]) => [
        id,
        agent.nickname ?? '',
        agent.role ?? '',
        agent.agentPath ?? '',
        agent.model ?? '',
        agent.reasoningEffort ?? '',
      ]),
    Object.entries(entry.receiverTimes ?? {})
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, times]) => [id, times.startedAt ?? 0, times.settledAt ?? 0]),
    entry.occurredAt ?? 0,
  ]);
  const workflowRuns = stableRows(
    input.workflowRuns ?? [],
    (run) => run.runId,
  ).map((run) => [
    run.runId,
    run.name,
    run.status,
    run.startedAt ?? 0,
    run.settledAt ?? 0,
    run.phases.map((phase) => phase.title),
    run.agents.map((agent) => [
      agent.agentId,
      agent.label,
      agent.phaseTitle ?? '',
      agent.state,
      agent.modelLabel ?? '',
      agent.prompt ?? '',
      agent.startedAt ?? 0,
      agent.settledAt ?? 0,
      agent.tokens ?? 0,
      agent.toolCalls ?? 0,
      agent.durationMs ?? 0,
      agent.errorMessage ?? '',
    ]),
  ]);
  return JSON.stringify([
    input.root.id,
    input.root.title,
    input.complete !== false,
    managed,
    claude,
    codex,
    workflowRuns,
  ]);
}
