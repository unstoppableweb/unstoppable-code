import {
  settledToolInterruption,
  supersedeToolInterruptions,
} from '../settlement';
import { isUserTurnBoundary } from './turn-boundary';
import { parseAgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';
import { normalizeCommandReadToolBlock } from './command-read-display';
import type {
  AgentUsage,
  CodexAgentCallBlock,
  PersistedChatBlock as ChatBlock,
  PersistedChatMessage as ChatMessage,
} from '../types';
import type {
  DisplayBlock,
  DisplayMessage,
  ToolResult,
} from '../message-display';
import {
  isWorkflowLaunchReceipt,
  parseWorkflowReceipt,
  extractWorkflowNameFromScript,
} from './workflow-receipt';
import { claudeLaunchedAgentId, isPendingTaskOutput } from './claude-agent-id';

function isEmptyThinkingBlock(block: ChatBlock | DisplayBlock): boolean {
  return block.type === 'thinking' && block.text.trim().length === 0;
}

function toUnknown(value: unknown): unknown {
  return value;
}

function parseJsonObject(input: string): object | null {
  try {
    const parsed = toUnknown(JSON.parse(input));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getObjectStringField(
  value: object,
  field: string,
): string | undefined {
  const property = toUnknown(Reflect.get(value, field));
  return typeof property === 'string' ? property : undefined;
}

export function getJsonStringField(
  input: string,
  field: string,
): string | undefined {
  const parsed = parseJsonObject(input);
  return parsed ? getObjectStringField(parsed, field) : undefined;
}

// ---------------------------------------------------------------------------
// Merge tool_result blocks into tool_use blocks
// ---------------------------------------------------------------------------

function parseAgentBlock(
  block: {
    type: 'tool_use';
    toolUseId: string;
    toolName: string;
    input: string;
  },
  result: ToolResult | undefined,
  subBlocks: DisplayBlock[],
  usage?: AgentUsage,
): DisplayBlock {
  const parsed = parseJsonObject(block.input);
  if (!parsed) {
    return { ...block, result };
  }
  return {
    type: 'agent',
    toolUseId: block.toolUseId,
    subagentType: getObjectStringField(parsed, 'subagent_type') ?? 'Agent',
    description: getObjectStringField(parsed, 'description') ?? '',
    prompt: getObjectStringField(parsed, 'prompt') ?? '',
    runInBackground:
      toUnknown(Reflect.get(parsed, 'run_in_background')) === true,
    result,
    subBlocks,
    ...(usage ? { usage } : {}),
  };
}

function parseWorkflowBlock(
  block: {
    type: 'tool_use';
    toolUseId: string;
    toolName: string;
    input: string;
  },
  result: ToolResult | undefined,
): DisplayBlock {
  let workflowName = 'Workflow';
  const parsed = parseJsonObject(block.input);
  if (parsed) {
    const script = getObjectStringField(parsed, 'script');
    if (script) {
      workflowName = extractWorkflowNameFromScript(script) ?? 'Workflow';
    }
  }

  const receipt =
    result && isWorkflowLaunchReceipt(result.output)
      ? parseWorkflowReceipt(result.output)
      : undefined;

  return {
    type: 'workflow',
    toolUseId: block.toolUseId,
    workflowName,
    summary: receipt?.summary ?? '',
    ...(receipt?.runId ? { runId: receipt.runId } : {}),
    ...(receipt?.transcriptDir ? { transcriptDir: receipt.transcriptDir } : {}),
    ...(result ? { result } : {}),
  };
}

function resolveSendMessageRecipient(
  input: string,
  recipientByAgentId: Map<string, string>,
): string | undefined {
  const targetAgentId = getJsonStringField(input, 'to');
  return targetAgentId ? recipientByAgentId.get(targetAgentId) : undefined;
}

function decorateSendMessageBlock(
  block: {
    type: 'tool_use';
    toolUseId: string;
    toolName: string;
    input: string;
  },
  result: ToolResult | undefined,
  recipientByAgentId: Map<string, string>,
): DisplayBlock {
  const resolvedRecipient = resolveSendMessageRecipient(
    block.input,
    recipientByAgentId,
  );
  return {
    ...block,
    result,
    ...(resolvedRecipient ? { resolvedRecipient } : {}),
  };
}

function normalizeCodexAgentDisplayPart(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function codexAgentTaskTitle(block: CodexAgentCallBlock): string {
  for (const threadId of block.receiverThreadIds) {
    const path = block.receiverAgents?.[threadId]?.agentPath;
    const taskName = path?.split('/').filter(Boolean).pop()?.trim();
    if (!taskName) continue;
    return taskName
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  return '';
}

function formatCodexAgentDisplayName(block: CodexAgentCallBlock): string {
  const receivers = block.receiverAgents ?? {};

  for (const threadId of block.receiverThreadIds) {
    const receiver = receivers[threadId];
    const role = normalizeCodexAgentDisplayPart(receiver?.role);
    const nickname = normalizeCodexAgentDisplayPart(receiver?.nickname);
    if (role.length > 0 && nickname.length > 0) {
      return `${nickname} (${role})`;
    }
  }

  for (const threadId of block.receiverThreadIds) {
    const role = normalizeCodexAgentDisplayPart(receivers[threadId]?.role);
    if (role.length > 0) {
      return role;
    }
  }

  for (const threadId of block.receiverThreadIds) {
    const nickname = normalizeCodexAgentDisplayPart(
      receivers[threadId]?.nickname,
    );
    if (nickname.length > 0) {
      return nickname;
    }
  }

  const taskTitle = codexAgentTaskTitle(block);
  if (taskTitle) return taskTitle;

  return block.receiverThreadIds.length > 1
    ? `Codex (${String(block.receiverThreadIds.length)})`
    : 'Codex';
}

/**
 * Convert a persisted `codex_agent_call` block into the renderer's
 * `codex_agent` display block. Display fields (`displayName`, `description`)
 * are derived here so the AgentBlock UX can stay provider-agnostic.
 */
function parseCodexAgentBlock(
  block: CodexAgentCallBlock,
  subBlocks: DisplayBlock[],
  usage?: AgentUsage,
): DisplayBlock {
  const displayName = formatCodexAgentDisplayName(block);
  const taskTitle = codexAgentTaskTitle(block);
  const receiver =
    block.receiverThreadIds.length === 1
      ? block.receiverAgents?.[block.receiverThreadIds[0]]
      : undefined;
  const model = receiver?.model ?? block.model;
  const reasoningEffort = receiver?.reasoningEffort ?? block.reasoningEffort;

  // Prefer the readable task title, with the first non-empty prompt line as
  // a fallback. The full original prompt remains available in the card.
  let description = '';
  const promptLines = block.prompt.split(/\r?\n/);
  for (const line of promptLines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      description = trimmed;
      break;
    }
  }

  return {
    type: 'codex_agent',
    agentBlockId: block.agentBlockId,
    callId: block.callId,
    status: block.status,
    senderThreadId: block.senderThreadId,
    receiverThreadIds: block.receiverThreadIds,
    prompt: block.prompt,
    description:
      taskTitle && taskTitle !== displayName ? taskTitle : description,
    displayName,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    agentsStates: block.agentsStates,
    subBlocks,
    ...(usage ? { usage } : {}),
  };
}

function isTransientCodexSpawnStart(block: CodexAgentCallBlock): boolean {
  return (
    block.status === 'inProgress' &&
    block.receiverThreadIds.length === 0 &&
    Object.keys(block.agentsStates).length === 0
  );
}

function isClaudeAgentTool(toolName: string): boolean {
  return toolName === 'Task' || toolName === 'Agent';
}

function toDisplayToolResult(
  message: ChatMessage,
  block: Extract<ChatBlock, { type: 'tool_result' }>,
): ToolResult {
  const hasArtifactReference =
    block.fullOutputRef !== undefined || block.visualRef !== undefined;
  const interruption = settledToolInterruption(message, block);
  return {
    output: block.output,
    ...(hasArtifactReference
      ? { messageId: message.id, toolUseId: block.toolUseId }
      : {}),
    ...(block.fullOutputRef
      ? {
          fullOutputRef: block.fullOutputRef,
          outputTruncated: true as const,
        }
      : {}),
    ...(block.visualRef ? { visualRef: block.visualRef } : {}),
    isError: block.isError,
    ...(interruption ? { interruption } : {}),
    authFailure: block.authFailure,
    authFailures: block.authFailures,
  };
}

type AgentDisplayBlock = Extract<DisplayBlock, { type: 'agent' }>;

/**
 * Fold every TaskOutput row into the card of the background agent it reads,
 * from any root turn and at any depth. The card keeps the newest finished
 * read in transcript order; a read that returned before the agent finished
 * carries no result. Cards nest, so the tree's traversal order is not
 * transcript order, and a read can name a card the traversal reaches later:
 * it resolves to the latest card for its task id before it, else the first.
 */
function foldTaskOutputReads(
  merged: DisplayMessage[],
  messages: readonly ChatMessage[],
): void {
  const order = new Map<string, number>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && block.toolName === 'TaskOutput')
        order.set(block.toolUseId, order.size);
    }
  }
  const indexAgent = (
    index: Map<string, AgentDisplayBlock>,
    block: AgentDisplayBlock,
    keepFirst: boolean,
  ): void => {
    const taskId = claudeLaunchedAgentId(block.result?.output ?? '');
    for (const id of taskId ? [block.toolUseId, taskId] : [block.toolUseId]) {
      if (!keepFirst || !index.has(id)) index.set(id, block);
    }
  };
  const firstAgentByTaskId = new Map<string, AgentDisplayBlock>();
  const indexAll = (blocks: readonly DisplayBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'agent') indexAgent(firstAgentByTaskId, block, true);
      if ('subBlocks' in block) indexAll(block.subBlocks);
    }
  };
  for (const message of merged) indexAll(message.blocks);
  const agentsByTaskId = new Map<string, AgentDisplayBlock>();
  const newestRead = new Map<
    AgentDisplayBlock,
    { readonly order: number; readonly result: ToolResult }
  >();
  const fold = (blocks: DisplayBlock[]): DisplayBlock[] =>
    blocks.filter((block) => {
      if (block.type === 'agent') {
        indexAgent(agentsByTaskId, block, false);
      } else if (block.type === 'tool_use' && block.toolName === 'TaskOutput') {
        const taskId = getJsonStringField(block.input, 'task_id');
        const agent = taskId
          ? (agentsByTaskId.get(taskId) ?? firstAgentByTaskId.get(taskId))
          : undefined;
        if (agent) {
          const result = block.result;
          const readOrder = order.get(block.toolUseId) ?? -1;
          if (
            result &&
            !isPendingTaskOutput(result.output) &&
            readOrder >= (newestRead.get(agent)?.order ?? -1)
          )
            newestRead.set(agent, { order: readOrder, result });
          return false;
        }
      }
      if ('subBlocks' in block) block.subBlocks = fold(block.subBlocks);
      return true;
    });
  for (const message of merged) message.blocks = fold(message.blocks);
  newestRead.forEach((read, agent) => {
    agent.taskOutputResult = read.result;
  });
}

/**
 * Merge `tool_result` blocks into their `tool_use` blocks and fold subagent
 * rows into their parent blocks, producing the renderer's display messages.
 *
 * Pass the previous call's output as `previous` to keep object identity
 * stable: every display message and block that is structurally identical to
 * its counterpart in `previous` (same message id, same position) is returned
 * as the previous object, so `React.memo` boundaries keyed on them skip. The
 * returned value is deep-equal to the output without `previous`.
 */
export function mergeToolResults(
  messages: ChatMessage[],
  agentUsage?: Record<string, AgentUsage>,
  previous?: DisplayMessage[],
): DisplayMessage[] {
  // Root tool identities can be reused by a later turn. Background children
  // still belong to their explicit parent after another root turn begins.
  const turns: ChatMessage[][] = [];
  const turnsByParent = new Map<string, ChatMessage[]>();
  let current: ChatMessage[] = [];
  for (const message of messages) {
    const parent = message.parentBlockId ?? message.parentToolUseId;
    if (!parent && isUserTurnBoundary(message) && current.length > 0) {
      current = [];
    }
    const owningTurn = (parent && turnsByParent.get(parent)) || current;
    if (owningTurn.length === 0) turns.push(owningTurn);
    owningTurn.push(message);
    for (const block of message.blocks) {
      if (block.type === 'tool_use') {
        turnsByParent.set(block.toolUseId, owningTurn);
      } else if (
        block.type === 'codex_agent_call' ||
        block.type === 'delegated_agent_call'
      ) {
        turnsByParent.set(block.agentBlockId, owningTurn);
      }
    }
  }
  const merged = turns.flatMap((turn) =>
    mergeToolResultsFresh(supersedeToolInterruptions(turn), agentUsage),
  );
  foldTaskOutputReads(merged, messages);
  const visible = merged.filter((message) => message.blocks.length > 0);
  return previous ? shareDisplayMessages(previous, visible) : visible;
}

function mergeToolResultsFresh(
  messages: ChatMessage[],
  agentUsage?: Record<string, AgentUsage>,
): DisplayMessage[] {
  // 1. Separate main-flow messages from subagent messages.
  //
  // Provider-neutral grouping: prefer `parentBlockId` (Codex / new code) and
  // fall back to `parentToolUseId` (Claude / legacy). This keeps Claude's
  // existing `Agent` grouping intact while letting Codex subagent rows nest
  // under their `codex_agent_call` parent.
  const mainMessages: ChatMessage[] = [];
  const subagentMsgsByParent = new Map<string, ChatMessage[]>();

  for (const msg of messages) {
    const parentKey = msg.parentBlockId ?? msg.parentToolUseId;
    if (parentKey) {
      const arr = subagentMsgsByParent.get(parentKey);
      if (arr) {
        arr.push(msg);
      } else {
        subagentMsgsByParent.set(parentKey, [msg]);
      }
    } else {
      mainMessages.push(msg);
    }
  }

  // 2. Collect tool_result blocks from main-flow messages
  const resultMap = new Map<string, ToolResult>();
  for (const msg of mainMessages) {
    for (const block of msg.blocks) {
      if (block.type === 'tool_result' && block.toolUseId) {
        resultMap.set(block.toolUseId, toDisplayToolResult(msg, block));
      }
    }
  }

  // 2b. Build an agentId → friendly recipient-name mapping so a later
  // `SendMessage` `to` id can be rendered as the agent/task it targets. The
  // recipient name prefers the dispatch `description`, falling back to the
  // `subagent_type`.
  const recipientByAgentId = new Map<string, string>();
  for (const msg of mainMessages) {
    for (const block of msg.blocks) {
      if (
        block.type === 'tool_use' &&
        (block.toolName === 'Task' || block.toolName === 'Agent')
      ) {
        let recipientName = '';
        const parsed = parseJsonObject(block.input);
        if (parsed) {
          recipientName = getObjectStringField(parsed, 'description') ?? '';
          recipientName ||= getObjectStringField(parsed, 'subagent_type') ?? '';
        }
        // The Agent tool_use id can itself be a `SendMessage` target.
        if (recipientName) {
          recipientByAgentId.set(block.toolUseId, recipientName);
        }
        const taskResult = resultMap.get(block.toolUseId);
        const agentId = taskResult
          ? claudeLaunchedAgentId(taskResult.output)
          : undefined;
        if (agentId && recipientName) {
          recipientByAgentId.set(agentId, recipientName);
        }
      }
    }
  }

  // 3. For each subagent group, merge their blocks into DisplayBlocks
  const subBlocksByParent = new Map<string, DisplayBlock[]>();
  const visitingParents = new Set<string>();
  const buildSubBlocks = (parentId: string): DisplayBlock[] => {
    const cached = subBlocksByParent.get(parentId);
    if (cached) return cached;
    // Imported/persisted data can contain an invalid parent cycle. Never
    // construct a recursive display tree from one.
    if (visitingParents.has(parentId)) return [];
    visitingParents.add(parentId);
    const subMsgs = subagentMsgsByParent.get(parentId) ?? [];
    // A multi-receiver Codex group holds several threads' rows, and Codex
    // item ids are unique only per thread, so a result pairs with the call of
    // its own thread. Rows without a thread keep the plain id lookup.
    const subResultMap = new Map<string, ToolResult>();
    const threadResultMap = new Map<string, ToolResult>();
    const threadResultKey = (threadId: string, toolUseId: string): string =>
      `${threadId}\u0000${toolUseId}`;
    for (const msg of subMsgs) {
      for (const block of msg.blocks) {
        if (block.type === 'tool_result' && block.toolUseId) {
          const result = toDisplayToolResult(msg, block);
          subResultMap.set(block.toolUseId, result);
          if (msg.codexThreadId)
            threadResultMap.set(
              threadResultKey(msg.codexThreadId, block.toolUseId),
              result,
            );
        }
      }
    }
    const subResultFor = (
      msg: ChatMessage,
      toolUseId: string,
    ): ToolResult | undefined =>
      msg.codexThreadId
        ? threadResultMap.get(threadResultKey(msg.codexThreadId, toolUseId))
        : subResultMap.get(toolUseId);
    const merged: DisplayBlock[] = [];
    for (const msg of subMsgs) {
      for (const block of msg.blocks) {
        if (block.type === 'tool_result') continue;
        if (isEmptyThinkingBlock(block)) continue;
        if (block.type === 'tool_use' && isClaudeAgentTool(block.toolName)) {
          merged.push(
            parseAgentBlock(
              block,
              subResultFor(msg, block.toolUseId),
              buildSubBlocks(block.toolUseId),
              agentUsage?.[block.toolUseId],
            ),
          );
          continue;
        }
        if (block.type === 'delegated_agent_call') {
          merged.push({
            ...block,
            subBlocks: buildSubBlocks(block.agentBlockId),
          });
          continue;
        }
        if (block.type === 'codex_agent_call') {
          if (isTransientCodexSpawnStart(block)) {
            continue;
          }
          merged.push(
            parseCodexAgentBlock(
              block,
              buildSubBlocks(block.agentBlockId),
              agentUsage?.[block.agentBlockId],
            ),
          );
          continue;
        }
        if (block.type === 'tool_use') {
          if (block.toolName === 'SendMessage') {
            merged.push(
              decorateSendMessageBlock(
                block,
                subResultFor(msg, block.toolUseId),
                recipientByAgentId,
              ),
            );
          } else {
            merged.push({
              ...normalizeCommandReadToolBlock(block),
              result: subResultFor(msg, block.toolUseId),
            });
          }
        } else {
          merged.push({
            ...block,
            ...(msg.role === 'system' ? { isSystemMessage: true } : {}),
          });
        }
      }
    }
    visitingParents.delete(parentId);
    subBlocksByParent.set(parentId, merged);
    return merged;
  };
  subagentMsgsByParent.forEach((_messages, parentId) => {
    buildSubBlocks(parentId);
  });

  // 4. Build display messages, attaching sub-blocks to agent blocks
  const managedCalls = new Set(
    mainMessages.flatMap((message) =>
      message.blocks.flatMap((block) =>
        block.type === 'delegated_agent_call' ? [block.parentToolCallId] : [],
      ),
    ),
  );
  const out: DisplayMessage[] = [];
  for (const msg of mainMessages) {
    const displayBlocks: DisplayBlock[] = [];
    for (const block of msg.blocks) {
      if (block.type === 'tool_result') continue;
      if (isEmptyThinkingBlock(block)) continue;
      if (block.type === 'tool_use' && block.toolName === 'EnterPlanMode')
        continue;
      if (block.type === 'tool_use' && managedCalls.has(block.toolUseId))
        continue;
      if (block.type === 'delegated_agent_call') {
        displayBlocks.push({
          ...block,
          subBlocks: subBlocksByParent.get(block.agentBlockId) ?? [],
        });
        continue;
      }
      if (block.type === 'codex_agent_call') {
        if (isTransientCodexSpawnStart(block)) {
          continue;
        }
        // Convert the persisted Codex collab block into the renderer's
        // `codex_agent` display block. SubBlocks come from the
        // provider-neutral grouping above (keyed by `agentBlockId`).
        displayBlocks.push(
          parseCodexAgentBlock(
            block,
            subBlocksByParent.get(block.agentBlockId) ?? [],
            agentUsage?.[block.agentBlockId],
          ),
        );
        continue;
      }
      if (block.type === 'tool_use') {
        if (block.toolName === 'Workflow') {
          displayBlocks.push(
            parseWorkflowBlock(block, resultMap.get(block.toolUseId)),
          );
          continue;
        }

        if (block.toolName === 'Task' || block.toolName === 'Agent') {
          displayBlocks.push(
            parseAgentBlock(
              block,
              resultMap.get(block.toolUseId),
              subBlocksByParent.get(block.toolUseId) ?? [],
              agentUsage?.[block.toolUseId],
            ),
          );
        } else if (block.toolName === 'SendMessage') {
          displayBlocks.push(
            decorateSendMessageBlock(
              block,
              resultMap.get(block.toolUseId),
              recipientByAgentId,
            ),
          );
        } else {
          displayBlocks.push({
            ...normalizeCommandReadToolBlock(block),
            result: resultMap.get(block.toolUseId),
          });
        }
      } else {
        displayBlocks.push(block);
      }
    }
    if (displayBlocks.length > 0) {
      const agentSent =
        msg.role === 'user' && 'agentSent' in msg
          ? (parseAgentSentInfo(msg.agentSent) ?? undefined)
          : undefined;
      out.push({
        id: msg.id,
        role: msg.role,
        blocks: displayBlocks,
        timestamp: msg.timestamp,
        ...(msg.attachmentPaths?.length
          ? { attachmentPaths: msg.attachmentPaths }
          : {}),
        ...(msg.inputMode ? { inputMode: msg.inputMode } : {}),
        ...(msg.autoResume ? { autoResume: msg.autoResume } : {}),
        ...(msg.watcherFired ? { watcherFired: msg.watcherFired } : {}),
        ...(agentSent !== undefined ? { agentSent } : {}),
        ...(msg.userMessageSource
          ? { userMessageSource: msg.userMessageSource }
          : {}),
        ...(msg.cancelled === true ? { cancelled: true } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structural sharing for display messages
// ---------------------------------------------------------------------------

/** Nesting bound for the structural comparison; deeper values never share. */
const MAX_STRUCTURAL_SHARING_DEPTH = 64;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * True when two JSON-shaped values are indistinguishable: equal primitives,
 * arrays of equal elements, or plain objects with the same own keys in the
 * same order and equal values. Any other object compares by identity, so a
 * `true` result means substituting one value for the other cannot change
 * anything a reader observes, including key enumeration and serialization.
 */
function structurallyEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth >= MAX_STRUCTURAL_SHARING_DEPTH) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!structurallyEqual(left[index], right[index], depth + 1)) {
        return false;
      }
    }
    return true;
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index]) return false;
    if (!structurallyEqual(left[key], right[key], depth + 1)) return false;
  }
  return true;
}

function shareDisplayBlock(
  previous: DisplayBlock,
  next: DisplayBlock,
): DisplayBlock {
  if (structurallyEqual(previous, next)) return previous;
  // A changed agent block still shares its unchanged sub-blocks, so a late
  // subagent row re-renders only the nested blocks that changed.
  if (next.type === 'agent' && previous.type === 'agent') {
    const subBlocks = shareDisplayBlocks(previous.subBlocks, next.subBlocks);
    return subBlocks === next.subBlocks ? next : { ...next, subBlocks };
  }
  if (next.type === 'codex_agent' && previous.type === 'codex_agent') {
    const subBlocks = shareDisplayBlocks(previous.subBlocks, next.subBlocks);
    return subBlocks === next.subBlocks ? next : { ...next, subBlocks };
  }
  if (
    next.type === 'delegated_agent_call' &&
    previous.type === 'delegated_agent_call'
  ) {
    const subBlocks = shareDisplayBlocks(previous.subBlocks, next.subBlocks);
    return subBlocks === next.subBlocks ? next : { ...next, subBlocks };
  }
  return next;
}

/**
 * Positional structural sharing for one block list. Returns `previous` when
 * every block is unchanged, `next` when nothing could be shared, and
 * otherwise a new list mixing shared and new blocks.
 */
function shareDisplayBlocks(
  previous: DisplayBlock[],
  next: DisplayBlock[],
): DisplayBlock[] {
  if (previous === next) return previous;
  let allPrevious = previous.length === next.length;
  let anyShared = false;
  const shared = next.map((block, index): DisplayBlock => {
    const candidate = previous[index];
    const resolved =
      candidate !== undefined && candidate.type === block.type
        ? shareDisplayBlock(candidate, block)
        : block;
    if (resolved !== candidate) allPrevious = false;
    if (resolved !== block) anyShared = true;
    return resolved;
  });
  if (allPrevious) return previous;
  return anyShared ? shared : next;
}

function shareDisplayMessage(
  previous: DisplayMessage,
  next: DisplayMessage,
): DisplayMessage {
  if (previous === next) return previous;
  const blocks = shareDisplayBlocks(previous.blocks, next.blocks);
  if (blocks === previous.blocks) {
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    const restEqual =
      previousKeys.length === nextKeys.length &&
      previousKeys.every(
        (key, index) =>
          key === nextKeys[index] &&
          (key === 'blocks' ||
            structurallyEqual(
              Reflect.get(previous, key),
              Reflect.get(next, key),
            )),
      );
    if (restEqual) return previous;
  }
  return blocks === next.blocks ? next : { ...next, blocks };
}

/**
 * Structural sharing across two `mergeToolResults` outputs: each message of
 * `next` whose id appears in `previous` keeps the previous message and block
 * objects wherever they are structurally identical. The result is deep-equal
 * to `next`; only object identity differs.
 */
export function shareDisplayMessages(
  previous: DisplayMessage[],
  next: DisplayMessage[],
): DisplayMessage[] {
  if (previous === next || previous.length === 0) return next;
  const previousById = new Map<string, DisplayMessage>();
  for (const message of previous) previousById.set(message.id, message);
  return next.map((message): DisplayMessage => {
    const candidate = previousById.get(message.id);
    return candidate ? shareDisplayMessage(candidate, message) : message;
  });
}
