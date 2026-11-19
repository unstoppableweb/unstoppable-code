import { isAgentDelegationCardData } from '@canopy/protocol/delegation';
import {
  agentTaskSubagentState,
  isAgentTaskStatus,
  isAgentTaskStopReason,
} from './agent-task-status';
import type { ClaudeNativeSubagentInput, CodexNativeCallInput } from './index';

/** Nesting bound for untrusted Portal part trees; deeper parts are ignored. */
const REMOTE_CONTROL_AGENT_PART_MAX_DEPTH = 32;

/** One Portal or cloud chat message as the native-agent reader needs it. */
export interface RemoteControlNativeSubagentSource {
  /** The message's `parts` (`RemoteControlChatPart[]` on the wire), unvalidated. */
  readonly parts: unknown;
  /** The message time in epoch ms, when known. */
  readonly occurredAtMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Status, approval and error from a known agent task's part fields. */
function taskStateFields(
  data: Record<string, unknown>,
): Pick<
  ClaudeNativeSubagentInput,
  'status' | 'approvalPending' | 'errorMessage'
> {
  const status = data['taskStatus'];
  if (!isAgentTaskStatus(status)) return {};
  const stopReason = data['taskStopReason'];
  const startedAt = data['startedAt'];
  const state = agentTaskSubagentState({
    status,
    approvalPending: data['taskApprovalPending'] === true,
    stopReason: isAgentTaskStopReason(stopReason) ? stopReason : null,
    startedAt:
      typeof startedAt === 'number' && Number.isFinite(startedAt)
        ? startedAt
        : null,
    errorMessage: nonEmptyString(data['taskErrorMessage']) ?? null,
  });
  return {
    status: state.status,
    approvalPending: state.approvalPending,
    ...(state.errorMessage !== undefined
      ? { errorMessage: state.errorMessage }
      : {}),
  };
}

/** Start time: an explicit null means not started, absent means unknown. */
function startedAtOf(
  data: Record<string, unknown>,
  fallback: number | undefined,
): number | undefined {
  if (!('startedAt' in data)) return fallback;
  return finiteNumber(data['startedAt']);
}

/** The parent a nested Portal agent part hangs from in the native tree. */
interface RemoteControlAgentParent {
  readonly kind: 'managed' | 'claude-native' | 'codex-native';
  /** Delegation id, Claude tool-use id, or the Codex receiver thread. */
  readonly id: string | null;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) return undefined;
    items.push(item);
  }
  return items;
}

function codexStates(value: unknown): CodexNativeCallInput['agentsStates'] {
  const states: Record<string, { status: string; message?: string | null }> =
    {};
  if (!isRecord(value)) return states;
  for (const [id, state] of Object.entries(value)) {
    if (!isRecord(state)) continue;
    const status = nonEmptyString(state['status']);
    const message = state['message'];
    if (
      status === undefined ||
      (message !== undefined && message !== null && typeof message !== 'string')
    )
      continue;
    states[id] = { status, ...(message === undefined ? {} : { message }) };
  }
  return states;
}

const CODEX_RECEIVER_FIELDS = [
  'nickname',
  'role',
  'agentPath',
  'model',
  'reasoningEffort',
] as const;

function codexReceivers(
  value: unknown,
): CodexNativeCallInput['receiverAgents'] {
  if (!isRecord(value)) return undefined;
  const receivers: Record<
    string,
    { -readonly [K in (typeof CODEX_RECEIVER_FIELDS)[number]]?: string }
  > = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const receiver: {
      -readonly [K in (typeof CODEX_RECEIVER_FIELDS)[number]]?: string;
    } = {};
    for (const field of CODEX_RECEIVER_FIELDS) {
      const text = nonEmptyString(raw[field]);
      if (text !== undefined) receiver[field] = text;
    }
    if (Object.keys(receiver).length > 0) receivers[id] = receiver;
  }
  return Object.keys(receivers).length > 0 ? receivers : undefined;
}

function codexTimes(value: unknown): CodexNativeCallInput['receiverTimes'] {
  if (!isRecord(value)) return undefined;
  const times: Record<string, { startedAt?: number; settledAt?: number }> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const startedAt = finiteNumber(raw['startedAt']);
    const settledAt = finiteNumber(raw['settledAt']);
    if (startedAt === undefined && settledAt === undefined) continue;
    times[id] = {
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(settledAt === undefined ? {} : { settledAt }),
    };
  }
  return Object.keys(times).length > 0 ? times : undefined;
}

/**
 * One Codex card's tree input, read like desktop's `codex_agent_call`
 * collector reads the persisted block. The card's display description is
 * never a tree title. A Codex card inside a Claude or managed parent takes
 * that parent as its sender, as desktop does.
 */
function codexInputOf(
  data: Record<string, unknown>,
  parent: RemoteControlAgentParent | null,
  time: number | undefined,
): CodexNativeCallInput | undefined {
  const agentBlockId = nonEmptyString(data['agentBlockId']);
  const callId = nonEmptyString(data['callId']);
  const tool = nonEmptyString(data['tool']);
  const status = nonEmptyString(data['status']);
  const receiverThreadIds = stringList(data['receiverThreadIds']);
  if (
    agentBlockId === undefined ||
    callId === undefined ||
    tool === undefined ||
    status === undefined ||
    receiverThreadIds === undefined
  )
    return undefined;
  const agentsStates = codexStates(data['agentsStates']);
  if (
    status === 'inProgress' &&
    receiverThreadIds.length === 0 &&
    Object.keys(agentsStates).length === 0
  )
    return undefined;
  const model = nonEmptyString(data['model']);
  const reasoningEffort = nonEmptyString(data['reasoningEffort']);
  const receiverAgents = codexReceivers(data['receiverAgents']);
  const receiverTimes = codexTimes(data['receiverTimes']);
  const senderThreadId =
    parent !== null && parent.kind !== 'codex-native' && parent.id !== null
      ? parent.id
      : stringOr(data['senderThreadId'], '');
  return {
    agentBlockId,
    callId,
    tool,
    status,
    senderThreadId,
    receiverThreadIds,
    prompt: stringOr(data['prompt'], ''),
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    agentsStates,
    ...(receiverAgents !== undefined ? { receiverAgents } : {}),
    ...(receiverTimes !== undefined ? { receiverTimes } : {}),
    ...(time !== undefined ? { occurredAt: time } : {}),
  };
}

/**
 * A multi-receiver card as one receiver's own card: its child parts are the
 * ones the host attributed to that receiver.
 */
function codexReceiverPart(
  part: Record<string, unknown>,
  data: Record<string, unknown>,
  thread: string,
): Record<string, unknown> | undefined {
  const byReceiver = data['receiverSubBlocks'];
  if (!isRecord(byReceiver)) return undefined;
  const subBlocks = byReceiver[thread];
  if (!Array.isArray(subBlocks)) return undefined;
  return {
    ...part,
    data: {
      ...Object.fromEntries(
        Object.entries(data).filter(([key]) => key !== 'receiverSubBlocks'),
      ),
      receiverThreadIds: [thread],
      subBlocks,
    },
  };
}

/**
 * Native tree inputs from Portal `agent` parts at any nesting depth: Claude
 * parts (the shape of desktop's `agent` display block) and Codex parts (the
 * shape of its `codex_agent` block plus the raw collab metadata). Shared by
 * the web Portal and cloud chats so both build the same `SubagentTreeInput`
 * as desktop.
 */
export function collectRemoteControlNativeSubagentInputs(
  messages: readonly RemoteControlNativeSubagentSource[],
): {
  readonly claudeNative: readonly ClaudeNativeSubagentInput[];
  /** The latest observed `agent` part of each Claude agent, by tool-use id. */
  readonly claudeNativeParts: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
  readonly codexNative: readonly CodexNativeCallInput[];
  /**
   * The latest Codex card of each receiver thread: a single-receiver card,
   * or a multi-receiver card narrowed to that receiver's own child parts.
   */
  readonly codexNativeParts: ReadonlyMap<
    string,
    Readonly<Record<string, unknown>>
  >;
  /** The session's root Codex thread, when the parts agree on one. */
  readonly codexRootThreadId?: string;
} {
  const claudeNative: ClaudeNativeSubagentInput[] = [];
  const claudeNativeParts = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  const codexNative: CodexNativeCallInput[] = [];
  const codexNativeParts = new Map<string, Readonly<Record<string, unknown>>>();
  const explicitRoots = new Set<string>();
  const rootSenders = new Set<string>();
  let malformedRoot = false;
  const visit = (
    parts: unknown,
    parent: RemoteControlAgentParent | null,
    time: number | undefined,
    depth: number,
  ): void => {
    if (!Array.isArray(parts) || depth > REMOTE_CONTROL_AGENT_PART_MAX_DEPTH)
      return;
    const parentId = parent?.id ?? null;
    for (const part of parts) {
      if (!isRecord(part) || part['kind'] !== 'agent') continue;
      const data = part['data'];
      if (!isRecord(data)) continue;
      const partTime = finiteNumber(data['occurredAt']) ?? time;
      const delegation = data['delegation'];
      if (delegation !== undefined) {
        visit(
          data['subBlocks'],
          isAgentDelegationCardData(delegation)
            ? { kind: 'managed', id: delegation.delegationId }
            : parent,
          partTime,
          depth + 1,
        );
        continue;
      }
      if (data['provider'] === 'codex') {
        // A cloud card carries its spawn's task creation time; desktop times
        // a Codex node from its spawn block, not the message around it.
        const input = codexInputOf(
          data,
          parent,
          finiteNumber(data['createdAt']) ?? partTime,
        );
        if (input === undefined) continue;
        codexNative.push(input);
        const root = data['codexRootThreadId'];
        if (root !== undefined) {
          const rootId = nonEmptyString(root);
          if (rootId === undefined) malformedRoot = true;
          else explicitRoots.add(rootId);
        }
        if (parent === null && input.senderThreadId.length > 0)
          rootSenders.add(input.senderThreadId);
        const single =
          input.receiverThreadIds.length === 1
            ? input.receiverThreadIds[0]
            : undefined;
        if (single !== undefined) codexNativeParts.set(single, part);
        else
          for (const thread of input.receiverThreadIds) {
            const receiverPart = codexReceiverPart(part, data, thread);
            if (receiverPart !== undefined)
              codexNativeParts.set(thread, receiverPart);
          }
        // Children of a multi-receiver card belong to the receiver the host
        // attributed them to; without that, their parentage stays
        // unresolved rather than taking receiver 0.
        const byReceiver = data['receiverSubBlocks'];
        if (single === undefined && isRecord(byReceiver))
          for (const thread of input.receiverThreadIds)
            visit(
              byReceiver[thread],
              { kind: 'codex-native', id: thread },
              partTime,
              depth + 1,
            );
        else
          visit(
            data['subBlocks'],
            { kind: 'codex-native', id: single ?? null },
            partTime,
            depth + 1,
          );
        continue;
      }
      if (data['provider'] !== undefined && data['provider'] !== 'claude')
        continue;
      const toolUseId = nonEmptyString(data['toolUseId']);
      if (toolUseId === undefined) {
        visit(data['subBlocks'], parent, partTime, depth + 1);
        continue;
      }
      const startedAt = startedAtOf(data, partTime);
      const createdAt = finiteNumber(data['createdAt']);
      const settledAt = finiteNumber(data['completedAt']);
      const modelLabel = nonEmptyString(data['modelLabel']);
      claudeNative.push({
        toolUseId,
        parentId,
        subagentType: stringOr(data['subagentType'], 'Agent'),
        description: stringOr(data['description'], ''),
        prompt: stringOr(data['prompt'], ''),
        state:
          data['isRunning'] === true
            ? 'running'
            : data['isError'] === true
              ? 'failed'
              : 'completed',
        ...taskStateFields(data),
        runInBackground: data['runInBackground'] === true,
        ...(modelLabel !== undefined ? { modelLabel } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(settledAt !== undefined ? { settledAt } : {}),
      });
      claudeNativeParts.set(toolUseId, part);
      visit(
        data['subBlocks'],
        { kind: 'claude-native', id: toolUseId },
        partTime,
        depth + 1,
      );
    }
  };
  for (const message of messages) {
    visit(message.parts, null, message.occurredAtMs, 0);
  }
  // Conflicting roots are malformed session evidence: no root is chosen.
  const roots = explicitRoots.size > 0 ? explicitRoots : rootSenders;
  const codexRootThreadId =
    !malformedRoot && roots.size === 1
      ? roots.values().next().value
      : undefined;
  return {
    claudeNative,
    claudeNativeParts,
    codexNative,
    codexNativeParts,
    ...(codexRootThreadId !== undefined ? { codexRootThreadId } : {}),
  };
}
