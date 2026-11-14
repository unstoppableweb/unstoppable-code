import { isThinkingLevel } from '../thinking';
import { isDelegationCapabilitySummary } from './capabilities';
import { isAgentDelegationPhase, isAgentDelegationQueueState } from './queues';
import type {
  AgentDelegationSnapshot,
  AgentDelegationSpawnRequest,
  DelegationStoppedBy,
} from './index';

/**
 * Whether a delegate may start its own delegates:
 * - `enabled`: it has the managed delegation tools.
 * - `not_enabled`: its parent did not enable nesting for it.
 * - `depth_limit`: nesting was enabled, but it is already at the user's
 *   maximum delegation depth.
 */
export const DELEGATION_NESTING_STATES = [
  'enabled',
  'not_enabled',
  'depth_limit',
] as const;
export type DelegationNestingState = (typeof DELEGATION_NESTING_STATES)[number];

/** Owned transcript records never masquerade as a provider-native child session. */
export const CANOPY_DELEGATION_EVENT_TYPE = 'canopy_delegation';

export type DelegationMessageAuthor =
  | { readonly kind: 'user' }
  | {
      readonly kind: 'agent';
      readonly depth: number;
      readonly delegationId?: string;
      readonly description?: string;
    };

export type AgentDelegationTranscriptItem = {
  readonly id: string;
  readonly sequence: number;
  readonly occurredAt: number;
  /**
   * Set only on a compatibility projection of a stream row whose content was
   * shortened or omitted; legacy items never carry it.
   */
  readonly truncated?: true;
} & (
  | {
      readonly type: 'text';
      readonly text: string;
      readonly author?: DelegationMessageAuthor;
      readonly delivery?: 'follow_up' | 'steer';
    }
  | { readonly type: 'thinking'; readonly text: string }
  | {
      readonly type: 'tool';
      readonly toolName: string;
      readonly input: string;
      readonly output?: string;
      readonly isError?: boolean;
    }
);

/** A delegate's child transcript kept in its parent chat's delegate log. */
export const DELEGATION_TRANSCRIPT_CHAT_LOG = 'chat-log-v1';
export const DELEGATION_TRANSCRIPT_CHAT_STREAM = 'chat-stream-v2';
export type DelegationTranscriptStore =
  | typeof DELEGATION_TRANSCRIPT_CHAT_LOG
  | typeof DELEGATION_TRANSCRIPT_CHAT_STREAM;

/** A complete cumulative snapshot. Replaying it has no delivery or execution side effects. */
export interface AgentDelegationTranscript {
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly sequence: number;
  readonly parentHarnessId: string;
  readonly parentTurnId: string;
  readonly parentToolCallId: string;
  readonly createdAt: number;
  readonly task: Pick<
    AgentDelegationSpawnRequest,
    'description' | 'prompt' | 'executionMode' | 'fastMode'
  >;
  readonly snapshot: AgentDelegationSnapshot;
  readonly transcript: readonly AgentDelegationTranscriptItem[];
  /** Sidecar patches reduce JSONL volume; live, recovery and terminal events carry full snapshots. */
  readonly transcriptMode?: 'patch';
  /**
   * Where the run's child transcript is persisted. `chat-log-v1`: in the
   * parent chat's delegate log, not as rows of the parent's transcript; the
   * card itself is the only parent row. Absent: legacy child rows.
   */
  readonly transcriptStore?: DelegationTranscriptStore;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function label(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\0\r\n]/.test(value)
  );
}
/** Structural check for a retained `stoppedBy`; it never grants authority. */
export function isDelegationStoppedBy(
  value: unknown,
): value is DelegationStoppedBy {
  if (!record(value)) return false;
  if (value.kind === 'user') return Object.keys(value).length === 1;
  return (
    value.kind === 'agent' &&
    Object.keys(value).every((key) =>
      ['kind', 'depth', 'delegationId', 'description'].includes(key),
    ) &&
    count(value.depth) &&
    value.depth < 10 &&
    (value.delegationId === undefined || label(value.delegationId)) &&
    (value.description === undefined ||
      (typeof value.description === 'string' &&
        value.description.length > 0 &&
        value.description.length <= 200))
  );
}

export function isAgentDelegationTranscriptItem(
  value: unknown,
): value is AgentDelegationTranscriptItem {
  if (
    !record(value) ||
    !label(value.id) ||
    !count(value.sequence) ||
    !count(value.occurredAt) ||
    (value.truncated !== undefined && value.truncated !== true)
  )
    return false;
  const text = (v: unknown): v is string => typeof v === 'string';
  if (
    value.author !== undefined &&
    (value.type !== 'text' || !isDelegationStoppedBy(value.author))
  )
    return false;
  if (
    value.delivery !== undefined &&
    (value.type !== 'text' ||
      (value.delivery !== 'follow_up' && value.delivery !== 'steer'))
  )
    return false;
  return value.type === 'text' || value.type === 'thinking'
    ? text(value.text)
    : value.type === 'tool' &&
        label(value.toolName) &&
        text(value.input) &&
        (value.output === undefined || text(value.output)) &&
        (value.isError === undefined || typeof value.isError === 'boolean');
}
export function isAgentDelegationTranscript(
  value: unknown,
): value is AgentDelegationTranscript {
  if (
    !record(value) ||
    !label(value.delegationId) ||
    !count(value.runGeneration) ||
    value.runGeneration < 1 ||
    !count(value.sequence) ||
    !count(value.createdAt) ||
    !label(value.parentHarnessId) ||
    !label(value.parentTurnId) ||
    !label(value.parentToolCallId)
  )
    return false;
  const task = value.task,
    snapshot = value.snapshot;
  if (
    !record(task) ||
    typeof task.description !== 'string' ||
    task.description.length > 200 ||
    typeof task.prompt !== 'string' ||
    task.prompt.length > 32768 ||
    !['foreground', 'background'].includes(String(task.executionMode)) ||
    (task.fastMode !== undefined && typeof task.fastMode !== 'boolean')
  )
    return false;
  if (
    !record(snapshot) ||
    snapshot.delegationId !== value.delegationId ||
    ![
      'pending',
      'running',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'deadline_exceeded',
    ].includes(String(snapshot.status)) ||
    typeof snapshot.outputTruncated !== 'boolean'
  )
    return false;
  if (
    (snapshot.depth !== undefined &&
      (!count(snapshot.depth) || snapshot.depth < 1 || snapshot.depth > 10)) ||
    (snapshot.parentDelegationId !== undefined &&
      !label(snapshot.parentDelegationId)) ||
    (snapshot.parentDescription !== undefined &&
      (typeof snapshot.parentDescription !== 'string' ||
        snapshot.parentDescription.length > 200)) ||
    (snapshot.runGeneration !== undefined &&
      (!count(snapshot.runGeneration) || snapshot.runGeneration < 1)) ||
    (snapshot.resultIndex !== undefined &&
      (!count(snapshot.resultIndex) || snapshot.resultIndex < 1)) ||
    (snapshot.approvalPending !== undefined &&
      typeof snapshot.approvalPending !== 'boolean') ||
    (snapshot.nestedDelegation !== undefined &&
      !DELEGATION_NESTING_STATES.some(
        (state) => state === snapshot.nestedDelegation,
      ))
  )
    return false;
  if (
    (snapshot.capabilities !== undefined &&
      !isDelegationCapabilitySummary(snapshot.capabilities)) ||
    (snapshot.phase !== undefined && !isAgentDelegationPhase(snapshot.phase)) ||
    (snapshot.queue !== undefined &&
      !isAgentDelegationQueueState(snapshot.queue))
  )
    return false;
  if (
    snapshot.permissions !== undefined &&
    (!record(snapshot.permissions) ||
      !Array.isArray(snapshot.permissions.writePaths) ||
      snapshot.permissions.writePaths.length > 64 ||
      !snapshot.permissions.writePaths.every(
        (scope) =>
          typeof scope === 'string' && scope.length > 0 && scope.length < 4096,
      ))
  )
    return false;
  if (
    snapshot.workspaceDiscarded !== undefined &&
    typeof snapshot.workspaceDiscarded !== 'boolean'
  )
    return false;
  if (
    (snapshot.stoppedBy !== undefined &&
      !isDelegationStoppedBy(snapshot.stoppedBy)) ||
    (snapshot.childDelegationIds !== undefined &&
      (!Array.isArray(snapshot.childDelegationIds) ||
        snapshot.childDelegationIds.length > 64 ||
        !snapshot.childDelegationIds.every(label)))
  )
    return false;
  for (const field of ['control', 'stopRequested']) {
    const command = snapshot[field];
    if (
      command !== undefined &&
      (!record(command) ||
        !label(command.operationId) ||
        !['accepted', 'completed', 'failed'].includes(String(command.status)) ||
        (field === 'control' &&
          ![
            'follow_up',
            'resume',
            'steer',
            'interrupt',
            'apply',
            'discard',
          ].includes(String(command.operation))) ||
        (command.error !== undefined &&
          (typeof command.error !== 'string' || command.error.length > 512)))
    )
      return false;
    if (
      field === 'control' &&
      command !== undefined &&
      command.steeringDelivery !== undefined
    ) {
      const delivery = command.steeringDelivery;
      if (
        !record(delivery) ||
        !['accepted', 'rejected', 'unknown'].includes(String(delivery.kind)) ||
        !label(delivery.attemptId) ||
        (delivery.providerTurnId !== undefined &&
          !label(delivery.providerTurnId)) ||
        (delivery.kind !== 'accepted' && typeof delivery.reason !== 'string') ||
        (delivery.fallback !== undefined && delivery.fallback !== 'ordinary')
      )
        return false;
    }
  }
  if (
    snapshot.isolatedWorkspace !== undefined &&
    (!record(snapshot.isolatedWorkspace) ||
      typeof snapshot.isolatedWorkspace.revision !== 'string' ||
      snapshot.isolatedWorkspace.revision.length > 64 ||
      snapshot.isolatedWorkspace.dirtyParentChangesIncluded !== false)
  )
    return false;
  if (
    snapshot.nativeSessionId !== undefined &&
    !label(snapshot.nativeSessionId)
  )
    return false;
  for (const field of ['partialText', 'finalText'])
    if (snapshot[field] !== undefined && typeof snapshot[field] !== 'string')
      return false;
  if (
    snapshot.error !== undefined &&
    (!record(snapshot.error) ||
      !label(snapshot.error.code) ||
      typeof snapshot.error.message !== 'string' ||
      snapshot.error.message.length > 4096 ||
      typeof snapshot.error.retryable !== 'boolean')
  )
    return false;
  if (
    snapshot.usage !== undefined &&
    (!record(snapshot.usage) ||
      Object.values(snapshot.usage).some(
        (number) =>
          typeof number !== 'number' || !Number.isFinite(number) || number < 0,
      ))
  )
    return false;
  if (value.transcriptMode !== undefined && value.transcriptMode !== 'patch')
    return false;
  if (
    value.transcriptStore !== undefined &&
    value.transcriptStore !== DELEGATION_TRANSCRIPT_CHAT_LOG &&
    value.transcriptStore !== DELEGATION_TRANSCRIPT_CHAT_STREAM
  )
    return false;
  const route = snapshot.routeSnapshot;
  if (route === undefined) {
    // A host whose delegates run on a route it doesn't report (cloud chats:
    // Core resolves the model) still shows them running and finished, by
    // the model they asked for.
    if (!label(snapshot.requestedModelId)) return false;
  } else {
    if (
      !record(route) ||
      !label(route.selectedModelId) ||
      !label(route.runtimeModelId) ||
      !label(route.harnessId)
    )
      return false;
    if (
      route.requestedThinkingLevel !== undefined &&
      !isThinkingLevel(route.requestedThinkingLevel)
    )
      return false;
    if (
      route.effectiveThinkingLevel !== undefined &&
      !isThinkingLevel(route.effectiveThinkingLevel)
    )
      return false;
    if (
      route.selectedModelLabel !== undefined &&
      !label(route.selectedModelLabel)
    )
      return false;
    if (
      route.runtimeModelLabel !== undefined &&
      !label(route.runtimeModelLabel)
    )
      return false;
  }
  if (
    !Array.isArray(value.transcript) ||
    !value.transcript.every(isAgentDelegationTranscriptItem)
  )
    return false;
  return (
    new Set(value.transcript.map((item) => item.id)).size ===
    value.transcript.length
  );
}

export interface AgentDelegationCardData extends AgentDelegationSnapshot {
  readonly parentHarnessId: string;
  readonly description: string;
  readonly prompt: string;
  readonly executionMode: 'foreground' | 'background';
  readonly transcriptStore?: DelegationTranscriptStore;
  /**
   * Display only: the child stream revision the card was read at, so a mounted
   * reader can tell that a newer child page exists. Never part of a snapshot
   * or of durable card state.
   */
  readonly streamRevision?: number;
}

/**
 * Read-only presentation validation; it never authorizes a route or native action.
 * It ignores `transcriptStore`: display never reads a child log, so a card from a
 * newer build still renders.
 */
export function isAgentDelegationCardData(
  value: unknown,
): value is AgentDelegationCardData {
  if (!record(value) || !label(value.parentHarnessId)) return false;
  if (value.streamRevision !== undefined && !count(value.streamRevision))
    return false;
  return isAgentDelegationTranscript({
    delegationId: value.delegationId,
    runGeneration: 1,
    sequence: 0,
    parentHarnessId: value.parentHarnessId,
    parentTurnId: 'display',
    parentToolCallId: 'display',
    createdAt: 0,
    task: {
      description: value.description,
      prompt: value.prompt,
      executionMode: value.executionMode,
    },
    snapshot: value,
    transcript: [],
  });
}

/**
 * Read-only presentation validation of a bare snapshot (one a delegation
 * list or tool answer carries), as a card would read it.
 */
export function isAgentDelegationSnapshotValue(
  value: unknown,
): value is AgentDelegationSnapshot {
  return (
    record(value) &&
    isAgentDelegationCardData({
      ...value,
      parentHarnessId: 'snapshot',
      description: '',
      prompt: '',
      executionMode: 'background',
    })
  );
}
