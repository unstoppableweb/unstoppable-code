import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import type { DelegatedAgentCallBlock } from '../../types';

/**
 * Node kinds in a subagent tree: managed delegations, provider-native
 * subagents, Claude Code workflow agents, and the workflow run and phase
 * groups that organise workflow agents.
 */
export const SUBAGENT_KINDS = [
  'managed',
  'claude-native',
  'codex-native',
  'workflow-agent',
  'workflow-run',
  'workflow-phase',
] as const;

/** A managed delegation, provider-native subagent, workflow agent or group. */
export type SubagentKind = (typeof SUBAGENT_KINDS)[number];

/** Group kinds organise agents; they are not subagents themselves. */
export type SubagentGroupKind = 'workflow-run' | 'workflow-phase';

/** Kinds that open as a subagent chat panel. */
export type SubagentChatKind = Exclude<SubagentKind, SubagentGroupKind>;

/** Whether a node kind only groups other nodes. */
export function isSubagentGroupKind(
  kind: SubagentKind,
): kind is SubagentGroupKind {
  return kind === 'workflow-run' || kind === 'workflow-phase';
}

/** Whether a node kind opens as a subagent chat panel. */
export function isSubagentChatKind(
  kind: SubagentKind,
): kind is SubagentChatKind {
  return !isSubagentGroupKind(kind);
}

/** Provider-native subagents: Claude Task agents and Codex spawned agents. */
export type NativeSubagentKind = 'claude-native' | 'codex-native';

/** Whether a node kind is a provider-native subagent. */
export function isNativeSubagentKind(
  kind: SubagentKind,
): kind is NativeSubagentKind {
  return kind === 'claude-native' || kind === 'codex-native';
}

/**
 * Whether a host may offer native Interrupt for this provider-native kind.
 * This is the single rule desktop, the Portal and cloud read.
 *
 * Claude Task agents can be interrupted. Codex subagents cannot yet: the
 * desktop Codex runtime interrupts only the root turn, so main refuses a
 * Codex child (`apps/desktop-app/src/main/ipc/native-subagents.ts`), and
 * cloud Codex has no per-thread interrupt. The Codex app-server bridge
 * (REG-3080, plan T22) lifts this on desktop and cloud together by changing
 * this function.
 */
export function nativeSubagentInterruptSupported(
  kind: NativeSubagentKind,
): boolean {
  return kind === 'claude-native';
}

/** Whether a node counts as a subagent in totals, live counts and stubs. */
export function countsAsSubagent(node: Pick<SubagentNode, 'kind'>): boolean {
  return !isSubagentGroupKind(node.kind);
}

/**
 * Workflow facts on workflow run, phase and agent nodes. Never carries host
 * paths: hosts keep any file locations in their own adapters.
 */
export interface SubagentWorkflowInfo {
  /** The workflow run id, for example `wf_ea5d2b77-e9f`. */
  readonly runId: string;
  /** `meta.name` from the workflow script. */
  readonly runName: string;
  /** One-based position of the run among the root chat's runs. */
  readonly runOrdinal: number;
  readonly runCount: number;
  /** Declared or observed phases in the run; 0 when it has none. */
  readonly phaseCount: number;
  /** Phase and agent nodes: the phase title. */
  readonly phaseTitle?: string;
  /** Phase and agent nodes: zero-based phase position. */
  readonly phaseIndex?: number;
  /** Agent nodes: one-based position among the run's agents. */
  readonly agentPosition?: number;
  /** Agents in the run. */
  readonly agentCount: number;
  /** Agent: its own usage. Run: the sum, when known. */
  readonly tokens?: number;
  readonly toolCalls?: number;
  /** Agent: its own duration. Run: wall-clock time once it has settled. */
  readonly durationMs?: number;
}

const WORKFLOW_RUN_NODE_PREFIX = 'workflow-run:';
const WORKFLOW_PHASE_NODE_PREFIX = 'workflow-phase:';
const WORKFLOW_AGENT_NODE_PREFIX = 'workflow-agent:';

/** Stable tree node id of a workflow run. */
export function workflowRunNodeId(runId: string): string {
  return `${WORKFLOW_RUN_NODE_PREFIX}${runId}`;
}

/**
 * Stable tree node id of a workflow phase, by its title. Titles are unique
 * within a run; positions are not stable, because a live run only shows the
 * phases its agents reached while the final state lists every declared one.
 */
export function workflowPhaseNodeId(runId: string, title: string): string {
  return `${WORKFLOW_PHASE_NODE_PREFIX}${runId}:${encodeURIComponent(title)}`;
}

/** Stable tree node id of a workflow agent. */
export function workflowAgentNodeId(runId: string, agentId: string): string {
  return `${WORKFLOW_AGENT_NODE_PREFIX}${runId}:${agentId}`;
}

/** The run and agent ids inside a workflow agent node id, if it is one. */
export function parseWorkflowAgentNodeId(
  id: string,
): { readonly runId: string; readonly agentId: string } | null {
  if (!id.startsWith(WORKFLOW_AGENT_NODE_PREFIX)) return null;
  const rest = id.slice(WORKFLOW_AGENT_NODE_PREFIX.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return {
    runId: rest.slice(0, separator),
    agentId: rest.slice(separator + 1),
  };
}

/** Lifecycle vocabulary shared by the subagent tree and its consumers. */
export type SubagentStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'approval'
  | 'idle'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'stopped-by-parent';

/** A status selection for tree, list, and count projections. */
export type SubagentStatusFilter = 'all' | 'active' | 'attention';

/** One generation of a managed subagent's run. */
export interface SubagentRun {
  readonly runGeneration: number;
  readonly agentBlockId?: string;
}

/** One managed or native agent in a root chat's delegation tree. */
export interface SubagentNode {
  readonly id: string;
  readonly kind: SubagentKind;
  readonly parentId: string | null;
  readonly depth: number;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly childIds: readonly string[];
  readonly liveDescendantCount: number;
  readonly approvalPending: boolean;
  readonly modelLabel?: string;
  readonly harnessId?: string;
  readonly thinkingLevel?: string;
  readonly subagentType?: string;
  readonly workspace?: 'shared' | 'isolated';
  readonly isolatedRevision?: string;
  readonly workspaceDiscarded?: boolean;
  readonly prompt?: string;
  readonly createdAt?: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
  readonly runs: readonly SubagentRun[];
  readonly snapshot?: AgentDelegationSnapshot;
  readonly errorMessage?: string;
  /** Workflow run, phase and agent nodes only. */
  readonly workflow?: SubagentWorkflowInfo;
}

/** A normalized root chat and its complete or partial subagent forest. */
export interface SubagentTree {
  readonly root: { readonly id: string; readonly title: string };
  readonly nodes: ReadonlyMap<string, SubagentNode>;
  readonly rootChildIds: readonly string[];
  /** False when the host built the tree from a partial transcript. */
  readonly complete: boolean;
}

/** The tree-relevant data normalized from one managed transcript block. */
export interface ManagedSubagentInput {
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly sequence: number;
  readonly agentBlockId?: string;
  readonly snapshot: AgentDelegationSnapshot;
  readonly description: string;
  readonly prompt?: string;
  readonly createdAt?: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
}

/** Converts one persisted managed block without losing its run identity. */
export function managedSubagentInputFromBlock(
  block: DelegatedAgentCallBlock,
): ManagedSubagentInput {
  return {
    delegationId: block.delegationId,
    runGeneration: block.runGeneration,
    sequence: block.sequence,
    agentBlockId: block.agentBlockId,
    snapshot: block,
    description: block.description,
    prompt: block.prompt,
    createdAt: block.createdAt,
  };
}

/** One observed Claude Task agent. */
export interface ClaudeNativeSubagentInput {
  readonly toolUseId: string;
  readonly parentId: string | null;
  readonly subagentType: string;
  readonly description: string;
  readonly prompt?: string;
  readonly state: 'running' | 'completed' | 'failed';
  /** Authoritative task status, when known; overrides `state`. */
  readonly status?: SubagentStatus;
  readonly approvalPending?: boolean;
  readonly errorMessage?: string;
  readonly runInBackground: boolean;
  readonly modelLabel?: string;
  readonly createdAt?: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
}

/** One persisted Codex collaboration-tool observation. */
export interface CodexNativeCallInput {
  readonly agentBlockId: string;
  readonly callId: string;
  readonly tool: string;
  readonly status: string;
  readonly senderThreadId: string;
  readonly receiverThreadIds: readonly string[];
  readonly prompt: string;
  readonly description?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly agentsStates: Readonly<
    Record<
      string,
      { readonly status: string; readonly message?: string | null }
    >
  >;
  readonly receiverAgents?: Readonly<
    Record<
      string,
      {
        readonly nickname?: string;
        readonly role?: string;
        readonly agentPath?: string;
        readonly model?: string;
        readonly reasoningEffort?: string;
      }
    >
  >;
  /** When each receiver thread's own turns ran, when the host knows it. */
  readonly receiverTimes?: Readonly<
    Record<string, { readonly startedAt?: number; readonly settledAt?: number }>
  >;
  readonly occurredAt?: number;
}

/** Lifecycle of one workflow agent as its host observed it. */
export type WorkflowAgentInputState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** One agent of a Claude Code workflow run. */
export interface WorkflowAgentSubagentInput {
  /** Provider agent id; safe characters only (`[A-Za-z0-9_-]`). */
  readonly agentId: string;
  readonly label: string;
  /** Undefined or empty: the agent hangs from the run, not a phase. */
  readonly phaseTitle?: string;
  readonly state: WorkflowAgentInputState;
  readonly modelLabel?: string;
  readonly prompt?: string;
  readonly startedAt?: number;
  readonly settledAt?: number;
  readonly tokens?: number;
  readonly toolCalls?: number;
  readonly durationMs?: number;
  readonly errorMessage?: string;
}

/** One Claude Code workflow run launched by the root chat. */
export interface WorkflowRunSubagentInput {
  readonly runId: string;
  /** `meta.name` from the workflow script. */
  readonly name: string;
  readonly status: 'running' | 'completed' | 'failed' | 'interrupted';
  readonly startedAt?: number;
  readonly settledAt?: number;
  /** Declared phases in script order; may be empty. */
  readonly phases: readonly { readonly title: string }[];
  /** Agents in start order. */
  readonly agents: readonly WorkflowAgentSubagentInput[];
}

/** All subagent sources used to construct one root chat's tree. */
export interface SubagentTreeInput {
  readonly root: { readonly id: string; readonly title: string };
  readonly managed: readonly ManagedSubagentInput[];
  readonly claudeNative?: readonly ClaudeNativeSubagentInput[];
  readonly codexNative?: readonly CodexNativeCallInput[];
  /** The root chat's own Codex thread id, when known. */
  readonly codexRootThreadId?: string;
  /** Claude Code workflow runs the root chat launched. */
  readonly workflowRuns?: readonly WorkflowRunSubagentInput[];
  /** Whether this tree was built from a complete transcript; defaults true. */
  readonly complete?: boolean;
}

/** Whether a status represents work that is still live. */
export function isLiveSubagentStatus(status: SubagentStatus): boolean {
  return (
    status === 'queued' ||
    status === 'starting' ||
    status === 'running' ||
    status === 'approval'
  );
}

/** Whether a node appears in the selected status filter. */
export function matchesSubagentFilter(
  node: SubagentNode,
  filter: SubagentStatusFilter,
): boolean {
  if (isSubagentGroupKind(node.kind)) {
    if (filter === 'all') return true;
    if (filter === 'attention') return false;
    return (
      node.status === 'running' ||
      node.status === 'queued' ||
      node.status === 'starting'
    );
  }
  if (filter === 'active') return isLiveSubagentStatus(node.status);
  if (filter === 'attention')
    return node.status === 'approval' || node.status === 'failed';
  return true;
}

/** Status totals for the whole tree. */
export function countSubagentsByFilter(
  tree: SubagentTree,
): Readonly<Record<SubagentStatusFilter, number>> {
  const counts: Record<SubagentStatusFilter, number> = {
    all: 0,
    active: 0,
    attention: 0,
  };
  for (const node of Array.from(tree.nodes.values())) {
    if (!countsAsSubagent(node)) continue;
    counts.all += 1;
    if (matchesSubagentFilter(node, 'active')) counts.active += 1;
    if (matchesSubagentFilter(node, 'attention')) counts.attention += 1;
  }
  return counts;
}

/**
 * The subagents the Active filter shows, in tree order: every node that
 * counts as a subagent and is still live. Its length is always the tree's
 * `active` count from {@link countSubagentsByFilter}.
 */
export function liveSubagentNodes(tree: SubagentTree): readonly SubagentNode[] {
  return Array.from(tree.nodes.values()).filter(
    (node) => countsAsSubagent(node) && matchesSubagentFilter(node, 'active'),
  );
}

/** Ancestors nearest-first, stopping safely if a partial tree has a broken link. */
export function subagentAncestors(
  tree: SubagentTree,
  id: string,
): readonly SubagentNode[] {
  const result: SubagentNode[] = [];
  const seen = new Set<string>([id]);
  let node = tree.nodes.get(id);
  while (node && node.parentId !== null) {
    const parentId = node.parentId;
    if (seen.has(parentId)) break;
    const parent = tree.nodes.get(parentId);
    if (!parent) break;
    result.push(parent);
    seen.add(parentId);
    node = parent;
  }
  return result;
}

/** Descendants in creation-order pre-order; null selects the whole forest. */
export function subagentDescendants(
  tree: SubagentTree,
  id: string | null,
): readonly SubagentNode[] {
  const result: SubagentNode[] = [];
  const roots =
    id === null ? tree.rootChildIds : (tree.nodes.get(id)?.childIds ?? []);
  const stack = [...roots].reverse();
  const seen = new Set<string>();
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (currentId === undefined || seen.has(currentId)) continue;
    seen.add(currentId);
    const node = tree.nodes.get(currentId);
    if (!node) continue;
    result.push(node);
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      const childId = node.childIds[index];
      if (childId !== undefined) stack.push(childId);
    }
  }
  return result;
}

interface MutableNode {
  readonly id: string;
  readonly kind: SubagentKind;
  readonly candidateParentId: string | null;
  readonly title: string;
  status: SubagentStatus;
  readonly approvalPending: boolean;
  readonly modelLabel?: string;
  readonly harnessId?: string;
  readonly thinkingLevel?: string;
  readonly subagentType?: string;
  readonly workspace?: 'shared' | 'isolated';
  readonly isolatedRevision?: string;
  readonly workspaceDiscarded?: boolean;
  readonly prompt?: string;
  readonly createdAt?: number;
  readonly startedAt?: number;
  readonly settledAt?: number;
  readonly runs: readonly SubagentRun[];
  readonly snapshot?: AgentDelegationSnapshot;
  readonly errorMessage?: string;
  readonly workflow?: SubagentWorkflowInfo;
  readonly creationOrder: number;
  readonly childIds: string[];
  parentId: string | null;
  depth: number;
  liveDescendantCount: number;
  live: boolean;
}

interface CodexStatusEvent {
  readonly agentBlockId: string;
  readonly callId: string;
  readonly status: string;
  readonly message?: string | null;
  readonly occurredAt?: number;
}

interface CodexReceiverAccumulator {
  readonly id: string;
  readonly events: CodexStatusEvent[];
  spawn?: CodexNativeCallInput;
  /** The receiver's own turn times from its latest call that reports them. */
  times?: {
    readonly call: CodexNativeCallInput;
    readonly startedAt?: number;
    readonly settledAt?: number;
  };
}

function textOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOptionalTime(left?: number, right?: number): number {
  const leftTime = left ?? Number.POSITIVE_INFINITY;
  const rightTime = right ?? Number.POSITIVE_INFINITY;
  return leftTime - rightTime;
}

function nonEmptyText(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function managedStatus(snapshot: AgentDelegationSnapshot): SubagentStatus {
  switch (snapshot.status) {
    case 'pending':
      return snapshot.phase === 'queued' ? 'queued' : 'starting';
    case 'running':
      return snapshot.approvalPending === true ? 'approval' : 'running';
    case 'completed':
      return 'completed';
    case 'interrupted':
      return 'interrupted';
    case 'failed':
    case 'deadline_exceeded':
      return 'failed';
    case 'cancelled':
      return snapshot.stopReason === 'stopped_by_parent' ||
        snapshot.stopReason === 'ancestor_stopped' ||
        snapshot.stopReason === 'parent_cancelled' ||
        snapshot.stoppedBy?.kind === 'agent'
        ? 'stopped-by-parent'
        : 'cancelled';
  }
}

function codexStatus(status: string): SubagentStatus {
  switch (status) {
    case 'pendingInit':
      return 'starting';
    case 'running':
      return 'running';
    case 'interrupted':
    case 'shutdown':
      return 'interrupted';
    case 'completed':
      return 'completed';
    case 'errored':
    case 'notFound':
      return 'failed';
    default:
      return 'running';
  }
}

function codexCallStatus(status: string): SubagentStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'interrupted';
  return 'running';
}

function modelLabelFromSnapshot(
  snapshot: AgentDelegationSnapshot,
): string | undefined {
  const route = snapshot.routeSnapshot;
  return (
    nonEmptyText(route?.runtimeModelLabel) ??
    nonEmptyText(route?.selectedModelLabel) ??
    nonEmptyText(route?.runtimeModelId) ??
    nonEmptyText(route?.selectedModelId) ??
    (route
      ? undefined
      : nonEmptyText(snapshot.reportedRoute?.runtimeModelLabel)) ??
    nonEmptyText(snapshot.requestedModelLabel) ??
    nonEmptyText(snapshot.requestedModelId)
  );
}

function compareManagedInputs(
  left: ManagedSubagentInput,
  right: ManagedSubagentInput,
): number {
  if (left.runGeneration !== right.runGeneration)
    return left.runGeneration - right.runGeneration;
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return (
    textOrder(left.agentBlockId ?? '', right.agentBlockId ?? '') ||
    textOrder(left.description, right.description)
  );
}

function codexEventOrder(event: CodexStatusEvent): string {
  return `${event.agentBlockId}\u0000${event.callId}\u0000${event.status}\u0000${event.message ?? ''}`;
}

function compareCodexEvents(
  left: CodexStatusEvent,
  right: CodexStatusEvent,
): number {
  return (
    compareOptionalTime(left.occurredAt, right.occurredAt) ||
    textOrder(codexEventOrder(left), codexEventOrder(right))
  );
}

function compareCodexCalls(
  left: CodexNativeCallInput,
  right: CodexNativeCallInput,
): number {
  return (
    compareOptionalTime(left.occurredAt, right.occurredAt) ||
    textOrder(left.agentBlockId, right.agentBlockId) ||
    textOrder(left.callId, right.callId)
  );
}

function codexPathName(agentPath: string | undefined): string | undefined {
  const path = nonEmptyText(agentPath);
  if (!path) return undefined;
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1];
}

function managedMutableNodes(
  inputs: readonly ManagedSubagentInput[],
): MutableNode[] {
  const grouped = new Map<string, ManagedSubagentInput[]>();
  for (const input of inputs) {
    const group = grouped.get(input.delegationId) ?? [];
    group.push(input);
    grouped.set(input.delegationId, group);
  }

  const nodes: MutableNode[] = [];
  const groups = Array.from(grouped.entries()).sort(([left], [right]) =>
    textOrder(left, right),
  );
  for (const [id, group] of groups) {
    const sorted = [...group].sort(compareManagedInputs);
    const latest = sorted[sorted.length - 1];
    if (!latest) continue;
    const latestByGeneration = new Map<number, ManagedSubagentInput>();
    for (const entry of sorted) {
      const prior = latestByGeneration.get(entry.runGeneration);
      if (!prior || compareManagedInputs(entry, prior) > 0)
        latestByGeneration.set(entry.runGeneration, entry);
    }
    const runs: SubagentRun[] = Array.from(latestByGeneration.entries())
      .sort(([left], [right]) => left - right)
      .flatMap(([runGeneration, run]) => [
        {
          runGeneration,
          ...(run.agentBlockId !== undefined
            ? { agentBlockId: run.agentBlockId }
            : {}),
        },
      ]);
    // Observations of one run can differ in what they carry: a transcript
    // block has no run times, so take each from the latest that has it.
    const latestRun = sorted.filter(
      (entry) => entry.runGeneration === latest.runGeneration,
    );
    const runTime = (
      field: 'createdAt' | 'startedAt' | 'settledAt',
    ): number | undefined => {
      for (let index = latestRun.length - 1; index >= 0; index -= 1) {
        const value = latestRun[index]?.[field];
        if (value !== undefined) return value;
      }
      return undefined;
    };
    const createdAt = runTime('createdAt');
    const startedAt = runTime('startedAt');
    const settledAt = runTime('settledAt');
    const snapshot = latest.snapshot;
    const route = snapshot.routeSnapshot;
    const isolated = snapshot.isolatedWorkspace;
    const modelLabel = modelLabelFromSnapshot(snapshot);
    const harnessId = nonEmptyText(
      route?.harnessId ?? snapshot.reportedRoute?.harnessId,
    );
    const thinkingLevel =
      route?.effectiveThinkingLevel ?? route?.requestedThinkingLevel;
    const status = managedStatus(snapshot);
    nodes.push({
      id,
      kind: 'managed',
      candidateParentId: snapshot.parentDelegationId ?? null,
      title: latest.description,
      status,
      approvalPending: status === 'approval',
      ...(modelLabel !== undefined ? { modelLabel } : {}),
      ...(harnessId !== undefined ? { harnessId } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      workspace: isolated ? 'isolated' : 'shared',
      ...(isolated ? { isolatedRevision: isolated.revision } : {}),
      ...(snapshot.workspaceDiscarded !== undefined
        ? { workspaceDiscarded: snapshot.workspaceDiscarded }
        : {}),
      ...(latest.prompt !== undefined ? { prompt: latest.prompt } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(settledAt !== undefined ? { settledAt } : {}),
      runs,
      snapshot,
      ...(snapshot.error?.message !== undefined
        ? { errorMessage: snapshot.error.message }
        : {}),
      creationOrder: createdAt ?? Number.POSITIVE_INFINITY,
      childIds: [],
      parentId: null,
      depth: 0,
      liveDescendantCount: 0,
      live: isLiveSubagentStatus(status),
    });
  }
  return nodes;
}

function claudeMutableNodes(
  inputs: readonly ClaudeNativeSubagentInput[],
): MutableNode[] {
  const latestById = new Map<string, ClaudeNativeSubagentInput>();
  const sorted = [...inputs].sort((left, right) => {
    return (
      textOrder(left.toolUseId, right.toolUseId) ||
      compareOptionalTime(
        left.settledAt ?? left.startedAt,
        right.settledAt ?? right.startedAt,
      ) ||
      textOrder(left.description, right.description)
    );
  });
  for (const input of sorted) latestById.set(input.toolUseId, input);

  const nodes: MutableNode[] = [];
  const entries = Array.from(latestById.entries()).sort(([left], [right]) =>
    textOrder(left, right),
  );
  for (const [id, input] of entries) {
    const status: SubagentStatus = input.status ?? input.state;
    const modelLabel = nonEmptyText(input.modelLabel);
    const errorMessage = nonEmptyText(input.errorMessage);
    nodes.push({
      id,
      kind: 'claude-native',
      candidateParentId: input.parentId,
      title: input.description,
      status,
      approvalPending: status === 'approval' && input.approvalPending === true,
      harnessId: 'claude',
      subagentType: input.subagentType,
      ...(modelLabel !== undefined ? { modelLabel } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.settledAt !== undefined ? { settledAt: input.settledAt } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      runs: [],
      creationOrder:
        input.startedAt ?? input.createdAt ?? Number.POSITIVE_INFINITY,
      childIds: [],
      parentId: null,
      depth: 0,
      liveDescendantCount: 0,
      live: isLiveSubagentStatus(status),
    });
  }
  return nodes;
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** A call's times for one receiver; persisted data is read defensively. */
function codexReceiverTimes(
  call: CodexNativeCallInput,
  receiverId: string,
): CodexReceiverAccumulator['times'] {
  const raw = call.receiverTimes?.[receiverId];
  const startedAt = finiteTime(raw?.startedAt);
  const settledAt = finiteTime(raw?.settledAt);
  if (startedAt === undefined && settledAt === undefined) return undefined;
  return {
    call,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(settledAt === undefined ? {} : { settledAt }),
  };
}

function codexMutableNodes(
  inputs: readonly CodexNativeCallInput[],
  rootThreadId: string | undefined,
): MutableNode[] {
  const receivers = new Map<string, CodexReceiverAccumulator>();
  const noReceiverCalls = new Map<string, CodexNativeCallInput[]>();

  for (const call of inputs) {
    const uniqueReceivers = Array.from(new Set(call.receiverThreadIds));
    if (uniqueReceivers.length === 0) {
      const calls = noReceiverCalls.get(call.agentBlockId) ?? [];
      calls.push(call);
      noReceiverCalls.set(call.agentBlockId, calls);
      continue;
    }
    for (const receiverId of uniqueReceivers) {
      let receiver = receivers.get(receiverId);
      if (!receiver) receiver = { id: receiverId, events: [] };
      const state = call.agentsStates[receiverId];
      if (state) {
        receiver.events.push({
          agentBlockId: call.agentBlockId,
          callId: call.callId,
          status: state.status,
          ...(state.message !== undefined ? { message: state.message } : {}),
          ...(call.occurredAt !== undefined
            ? { occurredAt: call.occurredAt }
            : {}),
        });
      }
      if (
        call.tool === 'spawnAgent' &&
        (!receiver.spawn || compareCodexCalls(call, receiver.spawn) < 0)
      )
        receiver.spawn = call;
      const times = codexReceiverTimes(call, receiverId);
      if (
        times !== undefined &&
        (!receiver.times || compareCodexCalls(call, receiver.times.call) >= 0)
      )
        receiver.times = times;
      receivers.set(receiverId, receiver);
    }
  }

  const nodes: MutableNode[] = [];
  const receiverEntries = Array.from(receivers.entries()).sort(
    ([left], [right]) => textOrder(left, right),
  );
  for (const [id, receiver] of receiverEntries) {
    const spawn = receiver.spawn;
    const sortedEvents = [...receiver.events].sort(compareCodexEvents);
    const latestEvent = sortedEvents[sortedEvents.length - 1];
    const state = spawn?.receiverAgents?.[id];
    const status = latestEvent ? codexStatus(latestEvent.status) : 'starting';
    const description = nonEmptyText(spawn?.description);
    const title =
      description ??
      nonEmptyText(state?.nickname) ??
      codexPathName(state?.agentPath) ??
      'Codex subagent';
    const modelLabel = nonEmptyText(state?.model) ?? nonEmptyText(spawn?.model);
    const thinkingLevel =
      nonEmptyText(state?.reasoningEffort) ??
      nonEmptyText(spawn?.reasoningEffort);
    const sender = spawn?.senderThreadId;
    const message = latestEvent?.message;
    const settledAt = receiver.times?.settledAt ?? latestEvent?.occurredAt;
    nodes.push({
      id,
      kind: 'codex-native',
      candidateParentId:
        sender === undefined || sender === rootThreadId ? null : sender,
      title,
      status,
      approvalPending: false,
      harnessId: 'codex',
      ...(modelLabel !== undefined ? { modelLabel } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(spawn?.prompt !== undefined ? { prompt: spawn.prompt } : {}),
      ...(spawn?.occurredAt !== undefined
        ? { createdAt: spawn.occurredAt, startedAt: spawn.occurredAt }
        : {}),
      ...(receiver.times?.startedAt !== undefined
        ? { startedAt: receiver.times.startedAt }
        : {}),
      ...(settledAt !== undefined &&
      !isLiveSubagentStatus(status) &&
      status !== 'idle'
        ? { settledAt }
        : {}),
      runs: [],
      ...(status === 'failed' && message != null
        ? { errorMessage: message }
        : {}),
      creationOrder: spawn?.occurredAt ?? Number.POSITIVE_INFINITY,
      childIds: [],
      parentId: null,
      depth: 0,
      liveDescendantCount: 0,
      live: isLiveSubagentStatus(status),
    });
  }

  const noReceiverEntries = Array.from(noReceiverCalls.entries()).sort(
    ([left], [right]) => textOrder(left, right),
  );
  for (const [id, calls] of noReceiverEntries) {
    const sortedCalls = [...calls].sort(compareCodexCalls);
    const call = sortedCalls[sortedCalls.length - 1];
    if (!call) continue;
    const status = codexCallStatus(call.status);
    const modelLabel = nonEmptyText(call.model);
    const thinkingLevel = nonEmptyText(call.reasoningEffort);
    const sender = call.senderThreadId;
    nodes.push({
      id,
      kind: 'codex-native',
      candidateParentId: sender === rootThreadId ? null : sender,
      title: nonEmptyText(call.description) ?? 'Codex subagent',
      status,
      approvalPending: false,
      harnessId: 'codex',
      ...(modelLabel !== undefined ? { modelLabel } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      prompt: call.prompt,
      ...(call.occurredAt !== undefined
        ? { createdAt: call.occurredAt, startedAt: call.occurredAt }
        : {}),
      ...(call.occurredAt !== undefined && !isLiveSubagentStatus(status)
        ? { settledAt: call.occurredAt }
        : {}),
      runs: [],
      creationOrder: call.occurredAt ?? Number.POSITIVE_INFINITY,
      childIds: [],
      parentId: null,
      depth: 0,
      liveDescendantCount: 0,
      live: isLiveSubagentStatus(status),
    });
  }
  return nodes;
}

function sumWorkflowMetric(
  agents: readonly WorkflowAgentSubagentInput[],
  field: 'tokens' | 'toolCalls',
): number | undefined {
  let total = 0;
  let hasValue = false;
  for (const agent of agents) {
    const value = agent[field];
    if (value === undefined) continue;
    hasValue = true;
    total += value;
  }
  return hasValue ? total : undefined;
}

function workflowMutableNodes(
  inputs: readonly WorkflowRunSubagentInput[],
): MutableNode[] {
  const orderedRuns = [...inputs].sort(
    (left, right) =>
      compareOptionalTime(left.startedAt, right.startedAt) ||
      textOrder(left.runId, right.runId),
  );
  const runCount = orderedRuns.length;
  const nodes: MutableNode[] = [];

  for (let runIndex = 0; runIndex < orderedRuns.length; runIndex += 1) {
    const run = orderedRuns[runIndex];
    if (!run) continue;
    const runOrdinal = runIndex + 1;
    // Unique, non-empty titles: declared order, or first appearance among
    // agents when the run declares none. Titles key the phase node ids.
    const phaseTitles: string[] = [];
    const phaseIndexByTitle = new Map<string, number>();
    const addPhaseTitle = (candidate: string | undefined): void => {
      const title = nonEmptyText(candidate);
      if (title === undefined || phaseIndexByTitle.has(title)) return;
      phaseIndexByTitle.set(title, phaseTitles.length);
      phaseTitles.push(title);
    };
    if (run.phases.length > 0) {
      for (const phase of run.phases) addPhaseTitle(phase.title);
    } else {
      for (const agent of run.agents) addPhaseTitle(agent.phaseTitle);
    }

    const phaseCount = phaseTitles.length;
    const agentsByPhase: WorkflowAgentSubagentInput[][] = phaseTitles.map(
      () => [],
    );
    const agentPhaseIndices: Array<number | undefined> = [];
    for (const agent of run.agents) {
      const title = nonEmptyText(agent.phaseTitle);
      const phaseIndex =
        title === undefined ? undefined : phaseIndexByTitle.get(title);
      agentPhaseIndices.push(phaseIndex);
      if (phaseIndex !== undefined) agentsByPhase[phaseIndex]?.push(agent);
    }

    const commonWorkflowInfo = {
      runId: run.runId,
      runName: run.name,
      runOrdinal,
      runCount,
      phaseCount,
      agentCount: run.agents.length,
    };
    const tokens = sumWorkflowMetric(run.agents, 'tokens');
    const toolCalls = sumWorkflowMetric(run.agents, 'toolCalls');
    const runId = workflowRunNodeId(run.runId);
    const runStatus: SubagentStatus = run.status;
    // Wall-clock time of a settled run. Agents overlap, so their durations do
    // not add up to it; a live run has none and hosts show elapsed time.
    const durationMs =
      runStatus !== 'running' &&
      run.startedAt !== undefined &&
      run.settledAt !== undefined &&
      run.settledAt >= run.startedAt
        ? run.settledAt - run.startedAt
        : undefined;

    nodes.push({
      id: runId,
      kind: 'workflow-run',
      candidateParentId: null,
      title: run.name,
      status: runStatus,
      approvalPending: false,
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.settledAt !== undefined ? { settledAt: run.settledAt } : {}),
      runs: [],
      workflow: {
        ...commonWorkflowInfo,
        ...(tokens !== undefined ? { tokens } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
      creationOrder: run.startedAt ?? Number.POSITIVE_INFINITY,
      childIds: [],
      parentId: null,
      depth: 0,
      liveDescendantCount: 0,
      live: isLiveSubagentStatus(runStatus),
    });

    for (let phaseIndex = 0; phaseIndex < phaseTitles.length; phaseIndex += 1) {
      const title = phaseTitles[phaseIndex];
      if (title === undefined) continue;
      const phaseAgents = agentsByPhase[phaseIndex] ?? [];
      const normalizedStates = phaseAgents.map((agent) =>
        run.status !== 'running' &&
        (agent.state === 'queued' || agent.state === 'running')
          ? 'interrupted'
          : agent.state,
      );
      let status: SubagentStatus;
      if (run.status === 'running') {
        status =
          phaseAgents.length === 0
            ? 'queued'
            : normalizedStates.some(
                  (agentStatus) =>
                    agentStatus === 'queued' || agentStatus === 'running',
                )
              ? 'running'
              : 'completed';
      } else {
        status = normalizedStates.includes('interrupted')
          ? 'interrupted'
          : 'completed';
      }
      nodes.push({
        id: workflowPhaseNodeId(run.runId, title),
        kind: 'workflow-phase',
        candidateParentId: runId,
        title,
        status,
        approvalPending: false,
        runs: [],
        workflow: {
          ...commonWorkflowInfo,
          phaseTitle: title,
          phaseIndex,
        },
        creationOrder: phaseIndex,
        childIds: [],
        parentId: null,
        depth: 0,
        liveDescendantCount: 0,
        live: isLiveSubagentStatus(status),
      });
    }

    for (let agentIndex = 0; agentIndex < run.agents.length; agentIndex += 1) {
      const agent = run.agents[agentIndex];
      if (!agent) continue;
      const phaseIndex = agentPhaseIndices[agentIndex];
      const phaseTitle = nonEmptyText(agent.phaseTitle);
      const status: SubagentStatus =
        run.status !== 'running' &&
        (agent.state === 'queued' || agent.state === 'running')
          ? 'interrupted'
          : agent.state;
      nodes.push({
        id: workflowAgentNodeId(run.runId, agent.agentId),
        kind: 'workflow-agent',
        candidateParentId:
          phaseIndex === undefined || phaseTitle === undefined
            ? runId
            : workflowPhaseNodeId(run.runId, phaseTitle),
        title: agent.label,
        status,
        approvalPending: false,
        harnessId: 'claude',
        subagentType: 'workflow',
        ...(agent.modelLabel !== undefined
          ? { modelLabel: agent.modelLabel }
          : {}),
        ...(agent.prompt !== undefined ? { prompt: agent.prompt } : {}),
        ...(agent.startedAt !== undefined
          ? { startedAt: agent.startedAt }
          : {}),
        ...(agent.settledAt !== undefined
          ? { settledAt: agent.settledAt }
          : {}),
        runs: [],
        ...(agent.errorMessage !== undefined
          ? { errorMessage: agent.errorMessage }
          : {}),
        workflow: {
          ...commonWorkflowInfo,
          ...(phaseTitle !== undefined ? { phaseTitle } : {}),
          ...(phaseIndex !== undefined ? { phaseIndex } : {}),
          agentPosition: agentIndex + 1,
          ...(agent.tokens !== undefined ? { tokens: agent.tokens } : {}),
          ...(agent.toolCalls !== undefined
            ? { toolCalls: agent.toolCalls }
            : {}),
          ...(agent.durationMs !== undefined
            ? { durationMs: agent.durationMs }
            : {}),
        },
        creationOrder:
          phaseIndex === undefined ? phaseCount + agentIndex : agentIndex,
        childIds: [],
        parentId: null,
        depth: 0,
        liveDescendantCount: 0,
        live: isLiveSubagentStatus(status),
      });
    }
  }
  return nodes;
}

function resolveParentThread(
  senderThreadId: string | null,
  rootId: string,
  codexRootThreadId: string | undefined,
  aliases: ReadonlyMap<string, string>,
): string | null {
  if (
    senderThreadId === null ||
    senderThreadId === rootId ||
    senderThreadId === codexRootThreadId
  )
    return null;
  return aliases.get(senderThreadId) ?? senderThreadId;
}

function nodeCreationOrder(left: MutableNode, right: MutableNode): number {
  return (
    left.creationOrder - right.creationOrder || textOrder(left.id, right.id)
  );
}

/** Reduces managed and provider-native observations into one stable tree. */
export function buildSubagentTree(input: SubagentTreeInput): SubagentTree {
  const managed = managedMutableNodes(input.managed);
  const claude = claudeMutableNodes(input.claudeNative ?? []);
  const codex = codexMutableNodes(
    input.codexNative ?? [],
    input.codexRootThreadId,
  );
  const workflow = workflowMutableNodes(input.workflowRuns ?? []);

  const rawById = new Map<string, MutableNode>();
  for (const node of [...managed, ...claude, ...codex, ...workflow]) {
    if (!rawById.has(node.id)) rawById.set(node.id, node);
  }

  const aliases = new Map<string, string>();
  for (const node of managed) {
    const nativeSessionId = node.snapshot?.nativeSessionId;
    if (nativeSessionId && !aliases.has(nativeSessionId))
      aliases.set(nativeSessionId, node.id);
  }

  for (const node of Array.from(rawById.values())) {
    node.parentId = resolveParentThread(
      node.candidateParentId,
      input.root.id,
      input.codexRootThreadId,
      aliases,
    );
  }

  const creationOrdered = Array.from(rawById.values()).sort(nodeCreationOrder);
  const assignedParents = new Map<string, string | null>();
  for (const node of creationOrdered) {
    const parentId = node.parentId;
    if (parentId === null || !rawById.has(parentId)) {
      node.parentId = null;
      assignedParents.set(node.id, null);
      continue;
    }
    let cursor: string | null = parentId;
    let closesCycle = false;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      if (cursor === node.id) {
        closesCycle = true;
        break;
      }
      seen.add(cursor);
      cursor = assignedParents.get(cursor) ?? null;
    }
    if (closesCycle) node.parentId = null;
    assignedParents.set(node.id, node.parentId);
  }

  for (const node of Array.from(rawById.values())) node.childIds.length = 0;
  const rootNodes: MutableNode[] = [];
  for (const node of creationOrdered) {
    if (node.parentId === null) {
      rootNodes.push(node);
      node.depth = 1;
      continue;
    }
    const parent = rawById.get(node.parentId);
    if (!parent) {
      node.parentId = null;
      node.depth = 1;
      rootNodes.push(node);
    } else {
      parent.childIds.push(node.id);
    }
  }

  const preorder: MutableNode[] = [];
  const depthStack = [...rootNodes].reverse();
  while (depthStack.length > 0) {
    const node = depthStack.pop();
    if (!node) continue;
    preorder.push(node);
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      const childId = node.childIds[index];
      const child = childId === undefined ? undefined : rawById.get(childId);
      if (!child) continue;
      child.depth = node.depth + 1;
      depthStack.push(child);
    }
  }

  for (let index = preorder.length - 1; index >= 0; index -= 1) {
    const node = preorder[index];
    if (!node) continue;
    let liveDescendantCount = 0;
    for (const childId of node.childIds) {
      const child = rawById.get(childId);
      if (child) {
        liveDescendantCount +=
          (child.live && countsAsSubagent(child) ? 1 : 0) +
          child.liveDescendantCount;
      }
    }
    node.liveDescendantCount = liveDescendantCount;
    if (
      !isSubagentGroupKind(node.kind) &&
      (node.status === 'completed' || node.status === 'interrupted') &&
      liveDescendantCount > 0
    ) {
      node.status = 'idle';
    }
  }

  const nodes = new Map<string, SubagentNode>();
  for (const node of preorder) {
    nodes.set(node.id, {
      id: node.id,
      kind: node.kind,
      parentId: node.parentId,
      depth: node.depth,
      title: node.title,
      status: node.status,
      childIds: node.childIds,
      liveDescendantCount: node.liveDescendantCount,
      approvalPending: node.approvalPending,
      ...(node.modelLabel !== undefined ? { modelLabel: node.modelLabel } : {}),
      ...(node.harnessId !== undefined ? { harnessId: node.harnessId } : {}),
      ...(node.thinkingLevel !== undefined
        ? { thinkingLevel: node.thinkingLevel }
        : {}),
      ...(node.subagentType !== undefined
        ? { subagentType: node.subagentType }
        : {}),
      ...(node.workspace !== undefined ? { workspace: node.workspace } : {}),
      ...(node.isolatedRevision !== undefined
        ? { isolatedRevision: node.isolatedRevision }
        : {}),
      ...(node.workspaceDiscarded !== undefined
        ? { workspaceDiscarded: node.workspaceDiscarded }
        : {}),
      ...(node.prompt !== undefined ? { prompt: node.prompt } : {}),
      ...(node.createdAt !== undefined ? { createdAt: node.createdAt } : {}),
      ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
      ...(node.settledAt !== undefined ? { settledAt: node.settledAt } : {}),
      runs: node.runs,
      ...(node.snapshot !== undefined ? { snapshot: node.snapshot } : {}),
      ...(node.errorMessage !== undefined
        ? { errorMessage: node.errorMessage }
        : {}),
      ...(node.workflow !== undefined ? { workflow: node.workflow } : {}),
    });
  }

  return {
    root: input.root,
    nodes,
    rootChildIds: rootNodes.map((node) => node.id),
    complete: input.complete ?? true,
  };
}

/** A matching node retained as a full card in a filtered tree projection. */
export interface ProjectedSubagentMatch {
  readonly kind: 'match';
  readonly node: SubagentNode;
  readonly children: readonly ProjectedSubagentNode[];
}

/** Hidden ancestors retained as one condensed path to matching descendants. */
export interface ProjectedSubagentPath {
  readonly kind: 'path';
  readonly nodes: readonly SubagentNode[];
  readonly children: readonly ProjectedSubagentNode[];
}

/** One full-card or condensed-path entry in the filter-preserving projection. */
export type ProjectedSubagentNode =
  | ProjectedSubagentMatch
  | ProjectedSubagentPath;

/** A filter-preserving tree whose hidden ancestors remain as path entries. */
export interface ProjectedSubagentTree {
  readonly projection: 'paths';
  readonly source: SubagentTree;
  readonly filter: SubagentStatusFilter;
  readonly items: readonly ProjectedSubagentNode[];
}

/** One visible node in a skip-edge projection. */
export interface SubagentSkipEdgeNode {
  readonly node: SubagentNode;
  /** Hidden parents, ordered from the nearest visible ancestor down. */
  readonly via: readonly SubagentNode[];
  readonly children: readonly SubagentSkipEdgeNode[];
}

/** A filtered tree where matching nodes skip hidden parents entirely. */
export interface SubagentSkipEdgeProjection {
  readonly projection: 'skip-edges';
  readonly source: SubagentTree;
  readonly filter: SubagentStatusFilter;
  readonly items: readonly SubagentSkipEdgeNode[];
}

/** Keeps filtered matches and the lineage paths that lead to them. */
export function projectSubagentTree(
  tree: SubagentTree,
  filter: SubagentStatusFilter,
): ProjectedSubagentTree {
  const ordered = subagentDescendants(tree, null);
  const hasMatchBelow = new Map<string, boolean>();
  const entriesBelow = new Map<string, readonly ProjectedSubagentNode[]>();

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const node = ordered[index];
    if (!node) continue;
    let foundMatchBelow = false;
    const children: ProjectedSubagentNode[] = [];
    for (const childId of node.childIds) {
      const child = tree.nodes.get(childId);
      if (!child) continue;
      const childEntries = entriesBelow.get(child.id) ?? [];
      const matches = matchesSubagentFilter(child, filter);
      if (matches) {
        children.push({ kind: 'match', node: child, children: childEntries });
        foundMatchBelow = true;
      } else if (hasMatchBelow.get(child.id) === true) {
        const onlyChild =
          childEntries.length === 1 ? childEntries[0] : undefined;
        children.push(
          onlyChild?.kind === 'path'
            ? {
                kind: 'path',
                nodes: [child, ...onlyChild.nodes],
                children: onlyChild.children,
              }
            : { kind: 'path', nodes: [child], children: childEntries },
        );
        foundMatchBelow = true;
      }
    }
    hasMatchBelow.set(node.id, foundMatchBelow);
    entriesBelow.set(node.id, children);
  }

  const items: ProjectedSubagentNode[] = [];
  for (const childId of tree.rootChildIds) {
    const child = tree.nodes.get(childId);
    if (!child) continue;
    const childEntries = entriesBelow.get(child.id) ?? [];
    if (matchesSubagentFilter(child, filter)) {
      items.push({ kind: 'match', node: child, children: childEntries });
    } else if (hasMatchBelow.get(child.id) === true) {
      const onlyChild = childEntries.length === 1 ? childEntries[0] : undefined;
      items.push(
        onlyChild?.kind === 'path'
          ? {
              kind: 'path',
              nodes: [child, ...onlyChild.nodes],
              children: onlyChild.children,
            }
          : { kind: 'path', nodes: [child], children: childEntries },
      );
    }
  }
  return { projection: 'paths', source: tree, filter, items };
}

interface MutableSkipEdgeNode {
  readonly node: SubagentNode;
  readonly via: readonly SubagentNode[];
  readonly children: MutableSkipEdgeNode[];
}

interface ProjectedEntryTask {
  readonly entry: ProjectedSubagentNode;
  readonly via: readonly SubagentNode[];
  readonly parent?: MutableSkipEdgeNode;
}

/** Removes hidden parents and records them on each newly visible edge. */
export function projectSubagentSkipEdges(
  tree: SubagentTree,
  filter: SubagentStatusFilter,
): SubagentSkipEdgeProjection {
  const projected = projectSubagentTree(tree, filter);
  const items: MutableSkipEdgeNode[] = [];
  const stack: ProjectedEntryTask[] = [];
  for (let index = projected.items.length - 1; index >= 0; index -= 1) {
    const entry = projected.items[index];
    if (entry) stack.push({ entry, via: [] });
  }
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task) continue;
    if (task.entry.kind === 'path') {
      const via = [...task.via, ...task.entry.nodes];
      for (let index = task.entry.children.length - 1; index >= 0; index -= 1) {
        const entry = task.entry.children[index];
        if (entry)
          stack.push({
            entry,
            via,
            ...(task.parent ? { parent: task.parent } : {}),
          });
      }
      continue;
    }
    const node: MutableSkipEdgeNode = {
      node: task.entry.node,
      via: task.via,
      children: [],
    };
    if (task.parent) task.parent.children.push(node);
    else items.push(node);
    for (let index = task.entry.children.length - 1; index >= 0; index -= 1) {
      const entry = task.entry.children[index];
      if (entry) stack.push({ entry, via: [], parent: node });
    }
  }
  return { projection: 'skip-edges', source: tree, filter, items };
}

/** A descendant-count stub shown where a levels window cuts off a branch. */
export interface SubagentWindowStub {
  readonly kind: 'stub';
  readonly parentId: string;
  readonly hiddenCount: number;
  readonly hiddenLiveCount: number;
}

/** One visible subagent card, its skipped ancestry, and displayed children. */
export interface SubagentWindowNode {
  readonly kind: 'node';
  readonly node: SubagentNode;
  readonly via: readonly SubagentNode[];
  readonly children: readonly SubagentWindowItem[];
}

/** A card or a stub in the windowed tree. */
export type SubagentWindowItem = SubagentWindowNode | SubagentWindowStub;

/** A level-limited tree view and the lineage folded above a focused node. */
export interface SubagentTreeWindow {
  readonly items: readonly SubagentWindowItem[];
  /** Present when the requested focus node is in the selected projection. */
  readonly focusedNode?: SubagentNode;
  /** Root-down order; the nearest parent is last. */
  readonly foldedAncestors: readonly SubagentNode[];
}

/** How many levels below the root or focus to draw. */
export type SubagentLevelsSetting = 'auto' | 'all' | number;

/** Auto levels that fit at the requested zoom, honoring the chosen minimum. */
export function autoSubagentLevelCount(options: {
  readonly canvasWidth: number;
  readonly rootWidth: number;
  readonly nodeWidth: number;
  readonly columnGap: number;
  readonly stubWidth: number;
  /** Total horizontal padding reserved by the canvas. */
  readonly padding: number;
  readonly minZoom?: number;
  readonly min?: number;
  readonly max?: number;
}): number {
  const minZoom =
    options.minZoom !== undefined &&
    Number.isFinite(options.minZoom) &&
    options.minZoom > 0
      ? options.minZoom
      : 0.75;
  const min =
    options.min !== undefined && Number.isFinite(options.min)
      ? Math.max(1, Math.floor(options.min))
      : 3;
  const max =
    options.max !== undefined && Number.isFinite(options.max)
      ? Math.max(min, Math.floor(options.max))
      : Number.POSITIVE_INFINITY;
  const rankWidth = options.nodeWidth + options.columnGap;
  if (
    !Number.isFinite(rankWidth) ||
    rankWidth <= 0 ||
    !Number.isFinite(options.canvasWidth) ||
    !Number.isFinite(options.rootWidth) ||
    !Number.isFinite(options.stubWidth) ||
    !Number.isFinite(options.padding) ||
    !Number.isFinite(options.columnGap)
  )
    return min;
  const widthForNodes =
    options.canvasWidth / minZoom -
    options.padding -
    options.rootWidth -
    options.columnGap -
    options.stubWidth;
  const fitting = Math.floor(widthForNodes / rankWidth);
  return Math.min(max, Math.max(min, fitting));
}

interface ViewNode {
  readonly key: string;
  readonly node: SubagentNode;
  readonly via: readonly SubagentNode[];
  readonly children: ViewNode[];
  descendantCount: number;
  liveDescendantCount: number;
}

interface ViewGraph {
  readonly source: SubagentTree;
  readonly roots: readonly ViewNode[];
  readonly nodesById: ReadonlyMap<string, ViewNode>;
}

function fullTreeView(tree: SubagentTree): ViewGraph {
  const nodesById = new Map<string, ViewNode>();
  for (const node of Array.from(tree.nodes.values())) {
    nodesById.set(node.id, {
      key: node.id,
      node,
      via: [],
      children: [],
      descendantCount: 0,
      liveDescendantCount: 0,
    });
  }
  const roots: ViewNode[] = [];
  for (const node of Array.from(tree.nodes.values())) {
    const viewNode = nodesById.get(node.id);
    if (!viewNode) continue;
    if (node.parentId === null) roots.push(viewNode);
    else nodesById.get(node.parentId)?.children.push(viewNode);
  }
  return { source: tree, roots, nodesById };
}

function skipEdgeView(projection: SubagentSkipEdgeProjection): ViewGraph {
  const nodesById = new Map<string, ViewNode>();
  const roots: ViewNode[] = [];
  const stack: Array<{
    readonly entry: SubagentSkipEdgeNode;
    readonly parent?: ViewNode;
  }> = [];
  for (let index = projection.items.length - 1; index >= 0; index -= 1) {
    const entry = projection.items[index];
    if (entry) stack.push({ entry });
  }
  while (stack.length > 0) {
    const task = stack.pop();
    if (!task) continue;
    const viewNode: ViewNode = {
      key: task.entry.node.id,
      node: task.entry.node,
      via: task.entry.via,
      children: [],
      descendantCount: 0,
      liveDescendantCount: 0,
    };
    nodesById.set(viewNode.node.id, viewNode);
    if (task.parent) task.parent.children.push(viewNode);
    else roots.push(viewNode);
    for (let index = task.entry.children.length - 1; index >= 0; index -= 1) {
      const entry = task.entry.children[index];
      if (entry) stack.push({ entry, parent: viewNode });
    }
  }
  return { source: projection.source, roots, nodesById };
}

function projectViewGraph(graph: ViewGraph): void {
  const preorder: ViewNode[] = [];
  const stack = [...graph.roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    preorder.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child) stack.push(child);
    }
  }
  for (let index = preorder.length - 1; index >= 0; index -= 1) {
    const node = preorder[index];
    if (!node) continue;
    let count = 0;
    let liveCount = 0;
    for (const child of node.children) {
      count += (countsAsSubagent(child.node) ? 1 : 0) + child.descendantCount;
      liveCount +=
        (countsAsSubagent(child.node) && isLiveSubagentStatus(child.node.status)
          ? 1
          : 0) + child.liveDescendantCount;
    }
    node.descendantCount = count;
    node.liveDescendantCount = liveCount;
  }
}

function isSkipEdgeProjection(
  value: SubagentTree | SubagentSkipEdgeProjection,
): value is SubagentSkipEdgeProjection {
  return 'projection' in value && value.projection === 'skip-edges';
}

interface WindowBuildEntry {
  readonly viewNode: ViewNode;
  readonly remaining: number | 'all';
}

/**
 * Levels left for `viewNode` after its own column and any skipped ancestors,
 * which the layout gives one column each. Below one, it no longer fits.
 */
function remainingAfter(
  levels: number | 'all',
  viewNode: ViewNode,
): number | 'all' {
  return levels === 'all' ? 'all' : levels - viewNode.via.length;
}

function windowRoots(
  roots: readonly ViewNode[],
  levels: number | 'all',
  collapsedIds?: ReadonlySet<string>,
  focusId: string | null = null,
): readonly SubagentWindowItem[] {
  const included: WindowBuildEntry[] = [];
  const stack: WindowBuildEntry[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    const root = roots[index];
    if (!root) continue;
    // A root always shows, even when its skipped ancestors fill the window.
    const remaining = remainingAfter(levels, root);
    stack.push({
      viewNode: root,
      remaining: remaining === 'all' ? 'all' : Math.max(1, remaining),
    });
  }
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    included.push(current);
    const collapsed =
      current.viewNode.node.id !== focusId &&
      collapsedIds?.has(current.viewNode.node.id) === true;
    const canExpand =
      !collapsed && (current.remaining === 'all' || current.remaining > 1);
    if (!canExpand) continue;
    const nextRemaining =
      current.remaining === 'all' ? 'all' : current.remaining - 1;
    for (
      let index = current.viewNode.children.length - 1;
      index >= 0;
      index -= 1
    ) {
      const child = current.viewNode.children[index];
      if (!child) continue;
      const remaining = remainingAfter(nextRemaining, child);
      if (remaining !== 'all' && remaining < 1) continue;
      stack.push({ viewNode: child, remaining });
    }
  }

  const built = new Map<string, SubagentWindowNode>();
  for (let index = included.length - 1; index >= 0; index -= 1) {
    const entry = included[index];
    if (!entry) continue;
    const collapsed =
      entry.viewNode.node.id !== focusId &&
      collapsedIds?.has(entry.viewNode.node.id) === true;
    const canExpand =
      !collapsed && (entry.remaining === 'all' || entry.remaining > 1);
    const children: SubagentWindowItem[] = canExpand
      ? expandedWindowChildren(entry.viewNode, built)
      : entry.viewNode.children.length > 0
        ? [
            {
              kind: 'stub',
              parentId: entry.viewNode.node.id,
              hiddenCount: entry.viewNode.descendantCount,
              hiddenLiveCount: entry.viewNode.liveDescendantCount,
            },
          ]
        : [];
    built.set(entry.viewNode.key, {
      kind: 'node',
      node: entry.viewNode.node,
      via: entry.viewNode.via,
      children,
    });
  }
  return roots.flatMap((root) => {
    const item = built.get(root.key);
    return item ? [item] : [];
  });
}

/** Built children in order, plus one stub for those that no longer fit. */
function expandedWindowChildren(
  viewNode: ViewNode,
  built: ReadonlyMap<string, SubagentWindowNode>,
): SubagentWindowItem[] {
  const items: SubagentWindowItem[] = [];
  let hasHiddenChildren = false;
  let hiddenCount = 0;
  let hiddenLiveCount = 0;
  for (const child of viewNode.children) {
    const builtChild = built.get(child.key);
    if (builtChild) {
      items.push(builtChild);
      continue;
    }
    hasHiddenChildren = true;
    hiddenCount +=
      (countsAsSubagent(child.node) ? 1 : 0) + child.descendantCount;
    hiddenLiveCount +=
      (countsAsSubagent(child.node) && isLiveSubagentStatus(child.node.status)
        ? 1
        : 0) + child.liveDescendantCount;
  }
  if (hasHiddenChildren) {
    items.push({
      kind: 'stub',
      parentId: viewNode.node.id,
      hiddenCount,
      hiddenLiveCount,
    });
  }
  return items;
}

/** Builds the visible levels and optional focus ancestry for a tree view. */
export function windowSubagentTree(
  treeOrProjection: SubagentTree | SubagentSkipEdgeProjection,
  options: {
    readonly focusId?: string | null;
    readonly levels: number | 'all';
    /**
     * Folded nodes. A collapsed node other than the focused node keeps no
     * children in the window; one stub stands for them, counting only
     * descendants that count as subagents.
     */
    readonly collapsedIds?: ReadonlySet<string>;
  },
): SubagentTreeWindow {
  const graph = isSkipEdgeProjection(treeOrProjection)
    ? skipEdgeView(treeOrProjection)
    : fullTreeView(treeOrProjection);
  projectViewGraph(graph);

  const focusId = options.focusId ?? null;
  if (focusId === null) {
    const levels =
      options.levels === 'all'
        ? 'all'
        : Number.isFinite(options.levels)
          ? Math.max(1, Math.floor(options.levels))
          : 1;
    return {
      items: windowRoots(graph.roots, levels, options.collapsedIds),
      foldedAncestors: [],
    };
  }

  const focus = graph.nodesById.get(focusId);
  if (!focus) return { items: [], foldedAncestors: [] };
  const levels =
    options.levels === 'all'
      ? 'all'
      : Number.isFinite(options.levels)
        ? Math.max(1, Math.floor(options.levels))
        : 1;
  const foldedAncestors = [
    ...subagentAncestors(graph.source, focusId),
  ].reverse();
  // The ancestry card shows every ancestor of the focused task, so its
  // skipped ancestors do not also use up the Levels window.
  return {
    items: windowRoots(
      [{ ...focus, via: [] }],
      levels,
      options.collapsedIds,
      focusId,
    ),
    focusedNode: focus.node,
    foldedAncestors,
  };
}

/** A composer target for the selected subagent, one of its ancestors, or root. */
export interface SubagentRecipient {
  readonly id: string;
  readonly kind: 'self' | 'ancestor' | 'root';
  readonly title: string;
  readonly levelsUp: number;
  readonly status?: SubagentStatus;
  readonly canMessage: boolean;
}

/** Composer recipients ordered from the selected subagent up to the root. */
export function subagentRecipients(
  tree: SubagentTree,
  id: string,
): readonly SubagentRecipient[] {
  const node = tree.nodes.get(id);
  if (!node) return [];
  const rootRecipient: SubagentRecipient = {
    id: tree.root.id,
    kind: 'root',
    title: tree.root.title,
    levelsUp: subagentAncestors(tree, id).length + 1,
    canMessage: true,
  };
  if (node.kind === 'workflow-agent') return [rootRecipient];
  if (node.kind !== 'managed') {
    const ancestors = subagentAncestors(tree, id);
    let messageableAncestor: SubagentNode | undefined;
    let levelsUp = 0;
    for (let index = 0; index < ancestors.length; index += 1) {
      const ancestor = ancestors[index];
      if (ancestor?.kind === 'managed') {
        messageableAncestor = ancestor;
        levelsUp = index + 1;
        break;
      }
    }
    return [
      {
        id: node.id,
        kind: 'self',
        title: node.title,
        levelsUp: 0,
        status: node.status,
        canMessage: false,
      },
      messageableAncestor
        ? {
            id: messageableAncestor.id,
            kind: 'ancestor',
            title: messageableAncestor.title,
            levelsUp,
            status: messageableAncestor.status,
            canMessage: true,
          }
        : rootRecipient,
    ];
  }

  const recipients: SubagentRecipient[] = [
    {
      id: node.id,
      kind: 'self',
      title: node.title,
      levelsUp: 0,
      status: node.status,
      canMessage: true,
    },
  ];
  const ancestors = subagentAncestors(tree, id);
  for (let index = 0; index < ancestors.length; index += 1) {
    const ancestor = ancestors[index];
    if (!ancestor) continue;
    recipients.push({
      id: ancestor.id,
      kind: 'ancestor',
      title: ancestor.title,
      levelsUp: index + 1,
      status: ancestor.status,
      canMessage: ancestor.kind === 'managed',
    });
  }
  recipients.push(rootRecipient);
  return recipients;
}

/** A title, kind, and id attached to a message as a subagent reference. */
export interface SubagentReference {
  readonly kind: SubagentKind;
  readonly id: string;
  readonly title: string;
}

function isSubagentKind(value: string): value is SubagentKind {
  return SUBAGENT_KINDS.some((kind) => kind === value);
}

function validReferenceId(id: string): boolean {
  const length = Array.from(id).length;
  return length >= 1 && length <= 256 && !/[\s\]]/.test(id);
}

function sanitizedReferenceTitle(title: string): string {
  const oneLine = title
    .replace(/\s+/g, ' ')
    .replace(/[\[\]]/g, '')
    .trim();
  return Array.from(oneLine).slice(0, 200).join('');
}

/** One safe, human-readable line ending in the subagent reference token. */
export function formatSubagentReference(reference: SubagentReference): string {
  if (!isSubagentKind(reference.kind) || !validReferenceId(reference.id))
    throw new TypeError('Invalid subagent reference.');
  const title = sanitizedReferenceTitle(reference.title) || 'Subagent';
  return `About ${title} [canopy-subagent:${reference.kind}:${reference.id}]`;
}

/** Adds a leading subagent-reference line to a message body. */
export function withSubagentReference(
  reference: SubagentReference,
  body: string,
): string {
  return `${formatSubagentReference(reference)}\n\n${body}`;
}

/** Parses one leading reference line and its blank-line-separated body. */
export function parseSubagentReference(
  text: string,
): { readonly reference: SubagentReference; readonly body: string } | null {
  const separator = text.indexOf('\n\n');
  if (separator < 0) return null;
  const line = text.slice(0, separator);
  const match =
    /^About ([^\[\]\r\n]*) \[canopy-subagent:([^:\]]+):([^\s\]]{1,512})\]$/.exec(
      line,
    );
  const kind = match?.[2];
  const id = match?.[3];
  if (
    !match ||
    kind === undefined ||
    id === undefined ||
    !isSubagentKind(kind) ||
    !validReferenceId(id)
  )
    return null;
  return {
    reference: {
      kind,
      id,
      title: match[1] ?? '',
    },
    body: text.slice(separator + 2),
  };
}
