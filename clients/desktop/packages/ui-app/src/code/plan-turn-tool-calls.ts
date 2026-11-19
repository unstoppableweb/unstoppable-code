import { useContext, useEffect, useMemo, useState } from 'react';
import {
  readRemoteControlToolOccurrence,
  type RemoteControlChatMessage,
  type RemoteControlChatPart,
} from '@canopy/protocol/remote-control/shell';
import {
  planCopyStateFromResolution,
  readToolCallResult,
  resolvePlanTurn,
  type PlanCopyState,
  type PlanTurnToolCall,
} from '@canopy/ui-shared/components';
import { normalizeChatMessageParts } from './ChatMessageView';
import {
  ToolOutputReaderContext,
  type ToolOutputIdentity,
  type ToolOutputReader,
} from './DeferredToolOutput';

/** Only these calls can propose a plan; others are never parsed. */
const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set(['ExitPlanMode', 'Write']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

function readToolUseId(data: Record<string, unknown>): string | undefined {
  return readString(data, 'toolUseId') ?? readString(data, 'tool_use_id');
}

function outcomeOf(value: unknown): PlanTurnToolCall['outcome'] {
  const result = readToolCallResult(value);
  if (result === null) return undefined;
  return result.kind === 'text' ? 'success' : 'error';
}

interface CollectedCall {
  readonly call: RemoteControlPlanToolCall;
  readonly toolUseId?: string;
  readonly occurrenceId?: string;
}

interface RemoteControlPlanToolCall extends PlanTurnToolCall {
  readonly inputIdentity?: ToolOutputIdentity;
  readonly inputRevision?: number;
}

/** Only a canonical occurrence can authorize reading a historical input. */
function inputIdentity(
  part: RemoteControlChatPart,
): ToolOutputIdentity | undefined {
  const occurrence = readRemoteControlToolOccurrence(part.occurrence);
  if (!occurrence) return undefined;
  const separator = occurrence.id.lastIndexOf('#');
  const messageId = occurrence.id.slice(0, separator);
  const ordinal = occurrence.id.slice(separator + 1);
  if (separator < 1 || !/^(0|[1-9]\d*)$/.test(ordinal)) return undefined;
  const blockOrdinal = Number(ordinal);
  if (!Number.isSafeInteger(blockOrdinal)) return undefined;
  return { kind: 'row', messageId, blockOrdinal, field: 'input' };
}

/** A plan-relevant `tool_use` part, or `null` for any other part. */
function readPlanToolUse(
  data: Record<string, unknown>,
  part: RemoteControlChatPart,
): CollectedCall | null {
  const toolName =
    readString(data, 'toolName') ?? readString(data, 'name') ?? '';
  if (!PLAN_TOOL_NAMES.has(toolName)) return null;
  const toolUseId = readToolUseId(data);
  const outcome = outcomeOf(data['result']);
  const identity = inputIdentity(part);
  const occurrence = readRemoteControlToolOccurrence(part.occurrence);
  return {
    call: {
      toolName,
      input: data['input'],
      ...(identity ? { inputIdentity: identity } : {}),
      ...(occurrence ? { inputRevision: occurrence.revision } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
    },
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(occurrence ? { occurrenceId: occurrence.id } : {}),
  };
}

/** Settle a call from a `tool_result` part that arrived on its own. */
function withLaterResult(
  { call, toolUseId, occurrenceId }: CollectedCall,
  laterResults: ReadonlyMap<string, PlanTurnToolCall['outcome']>,
): RemoteControlPlanToolCall {
  if (call.outcome !== undefined || toolUseId === undefined) return call;
  const outcome = laterResults.get(occurrenceId ?? toolUseId);
  return outcome === undefined ? call : { ...call, outcome };
}

function recordLaterResult(
  data: Record<string, unknown>,
  part: RemoteControlChatPart,
  laterResults: Map<string, PlanTurnToolCall['outcome']>,
): void {
  const toolUseId = readToolUseId(data);
  if (toolUseId !== undefined) {
    const occurrence = readRemoteControlToolOccurrence(part.occurrence);
    laterResults.set(
      occurrence?.id ?? toolUseId,
      outcomeOf(data['result'] ?? data),
    );
  }
}

/** Whether a call was already collected; records it otherwise. */
function isRepeat(collected: CollectedCall, seen: Set<string>): boolean {
  const key = collected.occurrenceId ?? collected.toolUseId;
  if (key === undefined) return false;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

/**
 * A turn's plan-relevant tool calls in the order the agent made them, each
 * once (CAN-5354). A call's result may be folded into it or arrive as a
 * `tool_result` part of a later message in the turn.
 */
function collectRemoteControlPlanToolCalls(
  messages: readonly RemoteControlChatMessage[],
): RemoteControlPlanToolCall[] {
  const calls: CollectedCall[] = [];
  const seen = new Set<string>();
  const laterResults = new Map<string, PlanTurnToolCall['outcome']>();
  const parts = messages.flatMap((message) =>
    normalizeChatMessageParts(message.parts ?? []),
  );
  for (const part of parts) {
    const data = isRecord(part.data) ? part.data : {};
    if (part.kind === 'tool_result') {
      recordLaterResult(data, part, laterResults);
      continue;
    }
    const collected =
      part.kind === 'tool_use' ? readPlanToolUse(data, part) : null;
    if (collected === null || isRepeat(collected, seen)) continue;
    calls.push(collected);
  }
  return calls.map((collected) => withLaterResult(collected, laterResults));
}

function needsFullInput(input: unknown): boolean {
  if (input === undefined || input === null) return true;
  if (typeof input === 'string') return /\[truncated \d+ chars\]/.test(input);
  return isRecord(input) && Object.values(input).some(needsFullInput);
}

/** Read every page of the exact stored input, never a display preview. */
async function readFullInput(
  read: ToolOutputReader,
  identity: ToolOutputIdentity,
  signal: AbortSignal,
): Promise<string> {
  const chunks: string[] = [];
  let offset = 0;
  let length: number | undefined;
  do {
    const page = await read(identity, offset, signal);
    if (signal.aborted) throw new Error('Cancelled');
    length ??= page.byteLength;
    const bytes = new TextEncoder().encode(page.text).length;
    if (
      page.byteLength !== length ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      bytes === 0
    ) {
      throw new Error('Incomplete plan input');
    }
    chunks.push(page.text);
    const next = offset + bytes;
    if (page.nextOffset === undefined) {
      if (next !== length) throw new Error('Incomplete plan input');
      return chunks.join('');
    }
    if (page.nextOffset !== next || next >= length)
      throw new Error('Incomplete plan input');
    offset = next;
  } while (!signal.aborted);
  throw new Error('Cancelled');
}

/**
 * Resolve once per completed turn. When the wire cut a body, recover only its
 * canonical row/block input through the host's existing transcript reader.
 * That immutable occurrence is the proposal's own content, independent of a
 * tracked plan's current revision. Hosts without that read stay unavailable.
 */
export function useRemoteControlTurnPlanCopy(
  messages: readonly RemoteControlChatMessage[],
  complete: boolean,
): PlanCopyState | undefined {
  const read = useContext(ToolOutputReaderContext);
  const calls = useMemo(
    () => collectRemoteControlPlanToolCalls(messages),
    [messages],
  );
  const resolution = useMemo(() => resolvePlanTurn(calls), [calls]);
  const key = JSON.stringify(calls);
  const [loaded, setLoaded] = useState<{
    key: string;
    read: ToolOutputReader;
    state: PlanCopyState | undefined;
  }>();
  const recover =
    complete &&
    resolution.kind !== 'complete' &&
    calls.some(
      (call) => call.inputIdentity !== undefined && needsFullInput(call.input),
    );
  useEffect(() => {
    if (!recover || !read) return;
    const reader = read;
    const controller = new AbortController();
    async function load(): Promise<void> {
      const restored = await Promise.all(
        calls.map(async (call): Promise<PlanTurnToolCall> => {
          if (!call.inputIdentity || !needsFullInput(call.input)) return call;
          try {
            return {
              ...call,
              input: await readFullInput(
                reader,
                call.inputIdentity,
                controller.signal,
              ),
            };
          } catch {
            return call;
          }
        }),
      );
      if (controller.signal.aborted) return;
      const result = resolvePlanTurn(restored);
      setLoaded({
        key,
        read: reader,
        state:
          result.kind === 'none'
            ? undefined
            : planCopyStateFromResolution(result),
      });
    }
    void load();
    return (): void => controller.abort();
    // The serialized key includes every normalized call, input and identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, read, recover]);
  if (!complete) return undefined;
  if (recover && read) {
    if (loaded?.key === key && loaded.read === read) return loaded.state;
    return { status: 'loading' };
  }
  return resolution.kind === 'none'
    ? undefined
    : planCopyStateFromResolution(resolution);
}
