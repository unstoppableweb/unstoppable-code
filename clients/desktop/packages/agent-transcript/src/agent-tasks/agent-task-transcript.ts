/**
 * A cloud chat's subagent cards from its portable transcript (CAN-5976). An
 * authority that serves a subagent's own rows marks each with its spawn
 * call's `parentToolUseId`; this nests those rows into the spawn call's
 * `agent` part and applies the task's state, so every host shows a cloud
 * subagent the same way.
 */
import type { AgentTaskRow } from '@canopy/protocol/cloud-session';
import type {
  RemoteControlChatAgentBlockData,
  RemoteControlChatMessage,
  RemoteControlChatPart,
} from '@canopy/protocol/remote-control/shell';
import { AGENT_TASK_MAX_DEPTH } from '@canopy/protocol/cloud-session';
import { persistedParts } from '../remote-control/persisted-chat-projection';
import type { PersistedChatMessage } from '../types';
import {
  agentTaskCardFields,
  agentTaskCardState,
  agentTaskCardUsage,
} from './agent-task-cards';

/** The Claude tools whose call spawns a subagent card. */
const CLAUDE_SPAWN_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stringField(
  value: Record<string, unknown>,
  name: string,
): string | undefined {
  const read = value[name];
  return typeof read === 'string' ? read : undefined;
}

function parseInput(input: unknown): Record<string, unknown> {
  if (isRecord(input)) return input;
  if (typeof input !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A spawn call as its `tool_use` part carries it. */
interface SpawnCall {
  readonly toolUseId: string;
  readonly input: Record<string, unknown>;
  readonly result?: { readonly output: string; readonly isError: boolean };
}

function spawnCall(part: RemoteControlChatPart): SpawnCall | undefined {
  if (part.kind !== 'tool_use' || !isRecord(part.data)) return undefined;
  const toolUseId = stringField(part.data, 'toolUseId');
  const toolName = stringField(part.data, 'toolName');
  if (!toolUseId || toolName === undefined || !CLAUDE_SPAWN_TOOLS.has(toolName))
    return undefined;
  const { result } = part.data;
  return {
    toolUseId,
    input: parseInput(part.data.input),
    ...(isRecord(result) &&
    typeof result.output === 'string' &&
    typeof result.isError === 'boolean'
      ? { result: { output: result.output, isError: result.isError } }
      : {}),
  };
}

/** One child row's parts, its text included, as a delegated card's rows are. */
function childParts(row: PersistedChatMessage): RemoteControlChatPart[] {
  return persistedParts(row, undefined, {
    partTextMaxChars: Number.POSITIVE_INFINITY,
    includeText: true,
    outputLocators: false,
  });
}

interface Nesting {
  readonly children: ReadonlyMap<string, readonly PersistedChatMessage[]>;
  readonly tasks: ReadonlyMap<string, AgentTaskRow>;
}

function agentPart(
  spawn: SpawnCall,
  task: AgentTaskRow,
  nesting: Nesting,
  depth: number,
): RemoteControlChatPart {
  const subBlocks =
    depth > AGENT_TASK_MAX_DEPTH
      ? []
      : nestParts(
          (nesting.children.get(spawn.toolUseId) ?? []).flatMap(childParts),
          nesting,
          depth + 1,
        );
  const runInBackground = spawn.input.run_in_background === true;
  const state = agentTaskCardState({
    task,
    result: spawn.result,
    runInBackground,
  });
  const usage = agentTaskCardUsage(
    task,
    subBlocks.filter((part) => part.kind === 'tool_use').length,
  );
  const data: RemoteControlChatAgentBlockData = {
    provider: 'claude',
    toolUseId: spawn.toolUseId,
    subagentType: stringField(spawn.input, 'subagent_type') ?? 'Agent',
    description: stringField(spawn.input, 'description') ?? '',
    prompt: stringField(spawn.input, 'prompt') ?? '',
    runInBackground: state.background,
    ...(state.result === undefined ? {} : { result: state.result }),
    ...(state.isRunning ? { isRunning: true } : {}),
    ...(state.isError ? { isError: true } : {}),
    ...(usage === undefined ? {} : { usage }),
    subBlocks,
    ...agentTaskCardFields(task),
  };
  return { kind: 'agent', data };
}

function nestParts(
  parts: readonly RemoteControlChatPart[],
  nesting: Nesting,
  depth: number,
): RemoteControlChatPart[] {
  return parts.map((part) => {
    const spawn = spawnCall(part);
    const task =
      spawn === undefined ? undefined : nesting.tasks.get(spawn.toolUseId);
    return spawn === undefined || task === undefined
      ? part
      : agentPart(spawn, task, nesting, depth);
  });
}

/**
 * Projects a cloud chat's transcript with its subagents nested. `project`
 * is the host's projection of top-level rows; each Claude spawn call of a
 * known subagent task becomes its `agent` card, holding the rows marked with
 * its `parentToolUseId`. A spawn call without a known task stays a tool call,
 * and rows of a parent that is not shown are never shown on their own.
 */
export function projectAgentTaskTranscript(input: {
  readonly messages: readonly PersistedChatMessage[];
  readonly tasks: readonly AgentTaskRow[];
  readonly project: (
    rows: readonly PersistedChatMessage[],
  ) => RemoteControlChatMessage[];
}): RemoteControlChatMessage[] {
  const children = new Map<string, PersistedChatMessage[]>();
  const top: PersistedChatMessage[] = [];
  for (const row of input.messages) {
    const parent = row.parentToolUseId;
    if (parent === undefined) {
      top.push(row);
      continue;
    }
    const rows = children.get(parent) ?? [];
    rows.push(row);
    children.set(parent, rows);
  }
  const tasks = new Map<string, AgentTaskRow>();
  for (const task of input.tasks)
    if (task.kind === 'subagent' && task.spawnToolCallId !== null)
      tasks.set(task.spawnToolCallId, task);
  const projected = input.project(top);
  if (tasks.size === 0) return projected;
  const nesting: Nesting = { children, tasks };
  return projected.map((message) => {
    const parts = message.parts;
    if (parts === undefined) return message;
    const next = nestParts(parts, nesting, 1);
    return next.some((part, index) => part !== parts[index])
      ? { ...message, parts: next }
      : message;
  });
}
