import type { ReactNode } from 'react';
import { RECENT_STEP_COUNT } from '@canopy/protocol/chat-detail';
import {
  classifyTurnStepOutcome,
  type RemoteControlChatMessage,
  type RemoteControlChatPart,
  type TurnOutcomeEvidence,
} from '@canopy/protocol/remote-control/shell';
import {
  describeCleanRun,
  getToolDisplayFamily,
  groupCleanSteps,
  isAskUserQuestionToolName,
  liveToolCallActivity,
  NO_TOOL_APPROVAL_WAIT,
  readToolCallResult,
  toolCallResultFrom,
  stepKindIcon,
  stepKindOfToolCall,
  type ChatToolStepLive,
  type CleanRunStep,
  type CleanUnitRole,
  type ToolApprovalWait,
} from '@canopy/ui-shared/components';
import { AgentIcon } from '@canopy/ui-shared/icons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { normalizeChatMessageParts } from './ChatMessageView';

/**
 * The clean chat look on the web transcript: every step between two
 * replies is one line, as on desktop (`groupCleanSteps`). A message that
 * carries both steps and its reply text splits into a steps piece and a text
 * piece, so the steps can join the run before the reply.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(part: RemoteControlChatPart): string {
  const data = isRecord(part.data) ? part.data : {};
  return typeof data.text === 'string' ? data.text : '';
}

function readToolName(data: Record<string, unknown>): string {
  return typeof data.toolName === 'string'
    ? data.toolName
    : typeof data.name === 'string'
      ? data.name
      : 'tool';
}

function readInput(data: Record<string, unknown>): string {
  const raw = data.input;
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return '';
  try {
    return JSON.stringify(raw);
  } catch {
    return '';
  }
}

/** What one (normalized) part is to the clean look's grouping. */
function partRole(part: RemoteControlChatPart): CleanUnitRole {
  const data = isRecord(part.data) ? part.data : {};
  switch (part.kind) {
    case 'thinking':
      return readText(part).trim() === '' ? 'silent' : 'step';
    case 'agent':
      return 'step';
    case 'tool_use': {
      const toolName = readToolName(data);
      if (toolName === 'EnterPlanMode') return 'silent';
      if (toolName === 'ExitPlanMode') return 'break';
      // A question shows its form, then its answers, where the person reads
      // the turn.
      if (isAskUserQuestionToolName(toolName)) return 'break';
      return 'step';
    }
    case 'tool_result':
      return isRecord(data.visual) ? 'break' : 'silent';
    case 'text':
      return readText(part).trim() === '' ? 'silent' : 'break';
    case 'turn_timer':
    case 'mcp_activation':
      return 'silent';
    default:
      return 'break';
  }
}

interface CleanUnit {
  readonly message: RemoteControlChatMessage;
  readonly key: string;
  readonly role: CleanUnitRole;
}

const unitCache = new WeakMap<RemoteControlChatMessage, readonly CleanUnit[]>();

function unitsOf(message: RemoteControlChatMessage): readonly CleanUnit[] {
  const cached = unitCache.get(message);
  if (cached) return cached;
  let units: CleanUnit[];
  if (message.role !== 'assistant') {
    units = [{ message, key: message.messageId, role: 'break' }];
  } else {
    const parts = normalizeChatMessageParts(message.parts ?? []);
    const roles = parts.map(partRole);
    const hasText = message.text.trim() !== '';
    if (roles.includes('break')) {
      units = [{ message, key: message.messageId, role: 'break' }];
    } else {
      const stepRole: CleanUnitRole = roles.includes('step')
        ? 'step'
        : 'silent';
      if (!hasText) {
        units = [{ message, key: message.messageId, role: stepRole }];
      } else if (parts.length === 0) {
        units = [{ message, key: message.messageId, role: 'break' }];
      } else {
        // Steps first, then the reply, the order the message draws them in.
        const terminal =
          message.status === 'failed' || message.status === 'cancelled';
        units = [
          {
            message: {
              ...message,
              text: '',
              ...(terminal ? { status: 'complete' as const } : {}),
            },
            key: message.messageId,
            role: stepRole,
          },
          {
            message: { ...message, parts: [] },
            key: `${message.messageId}#text`,
            role: 'break',
          },
        ];
      }
    }
  }
  unitCache.set(message, units);
  return units;
}

export type CleanTurnSegment =
  | {
      readonly kind: 'message';
      readonly key: string;
      readonly message: RemoteControlChatMessage;
    }
  | {
      readonly kind: 'steps';
      readonly key: string;
      readonly messages: readonly {
        key: string;
        message: RemoteControlChatMessage;
      }[];
    };

export function segmentCleanTurn(
  messages: readonly RemoteControlChatMessage[],
): CleanTurnSegment[] {
  return groupCleanSteps(
    messages.flatMap(unitsOf),
    (unit) => unit.role,
    (unit) => unit.key,
  ).map((segment) =>
    segment.kind === 'item'
      ? {
          kind: 'message',
          key: segment.item.key,
          message: segment.item.message,
        }
      : {
          kind: 'steps',
          key: segment.key,
          messages: segment.items.map(({ key, message }) => ({
            key,
            message,
          })),
        },
  );
}

export function stepParts(
  segment: Extract<CleanTurnSegment, { kind: 'steps' }>,
): RemoteControlChatPart[] {
  return segment.messages.flatMap(({ message }) =>
    normalizeChatMessageParts(message.parts ?? []).filter(
      (part) => partRole(part) === 'step',
    ),
  );
}

/**
 * What a run did, counted, and how many of its steps failed, were blocked
 * or were interrupted, each at most once. A call without a result counts as
 * interrupted only with `evidence` that its turn settled with every result
 * loaded, the same rule the turn's outcome counts use.
 */
export function describeCleanTurnSteps(
  segment: Extract<CleanTurnSegment, { kind: 'steps' }>,
  evidence?: TurnOutcomeEvidence,
): {
  label: string;
  failed: number;
  blocked: number;
  interrupted: number;
  icon: ReactNode;
} {
  const steps: CleanRunStep[] = stepParts(segment).map((part) => {
    const data = isRecord(part.data) ? part.data : {};
    if (part.kind === 'thinking') return { kind: 'thinking' };
    if (part.kind === 'agent') {
      const result = toolCallResultFrom({
        output: typeof data.result === 'string' ? data.result : '',
        isError: data.isError === true,
      });
      // Native agents own their lifecycle; Codex agents have no paired result.
      // Parent-turn completeness cannot establish their interruption.
      return { kind: 'agent', blocked: result.kind === 'blocked' };
    }
    const toolName = readToolName(data);
    const input = readInput(data);
    const family = getToolDisplayFamily(toolName, input, part.toolFamily);
    const result = readToolCallResult(data.result);
    const resultKind = result?.kind;
    return {
      kind: stepKindOfToolCall({ toolName, family, input }),
      pending: result === null,
      failed: resultKind === 'error',
      blocked: resultKind === 'blocked',
      interrupted:
        resultKind === 'interrupted' ||
        (result === null &&
          classifyTurnStepOutcome(undefined, false, evidence) ===
            'interrupted'),
    };
  });
  const { label, failed, blocked, interrupted, kind } = describeCleanRun(steps);
  return {
    label,
    failed,
    blocked,
    interrupted,
    icon: kind ? stepKindIcon(kind) : undefined,
  };
}

const THINKING = { label: 'Thinking', icon: null, showWhenUngrouped: true };

/**
 * What the running turn does now, from the last step of its live run. A call
 * the turn's `approvalWait` holds says it waits instead of shimmering.
 */
export function cleanLiveActivity(
  segment: Extract<CleanTurnSegment, { kind: 'steps' }> | undefined,
  workingLabel?: string | null,
  approvalWait: ToolApprovalWait = NO_TOOL_APPROVAL_WAIT,
): ChatToolStepLive {
  const thinking = workingLabel
    ? { label: workingLabel, icon: null, showWhenUngrouped: true }
    : THINKING;
  if (!segment) return thinking;
  const parts = stepParts(segment);
  const last = parts[parts.length - 1];
  if (!last) return thinking;
  const data = isRecord(last.data) ? last.data : {};
  if (last.kind === 'tool_use' && readToolCallResult(data.result) === null) {
    const toolUseId =
      typeof data.toolUseId === 'string' ? data.toolUseId : undefined;
    return liveToolCallActivity(
      {
        toolName: readToolName(data),
        input: readInput(data),
        ...(toolUseId !== undefined ? { toolUseId } : {}),
      },
      approvalWait,
    );
  }
  if (last.kind === 'agent' && data.result === undefined) {
    return {
      label:
        typeof data.description === 'string' && data.description !== '' ? (
          <span className={REPLAY_BLOCK_CLASS}>{data.description}</span>
        ) : (
          'Running a helper agent'
        ),
      icon: <AgentIcon />,
    };
  }
  return last.kind === 'thinking'
    ? { ...thinking, showWhenUngrouped: false }
    : thinking;
}

type CleanStepsSegment = Extract<CleanTurnSegment, { kind: 'steps' }>;

/**
 * Chat detail `recent`: the newest `size` steps of the run a turn is still
 * adding to (`shown`), and the steps before them (`hidden`), which the run's
 * closed line counts so the shown steps are not said twice. A message that
 * straddles the cut is split there. `hidden` is undefined when the window
 * holds every step.
 */
export function recentStepWindow(
  segment: CleanStepsSegment,
  size: number = RECENT_STEP_COUNT,
): {
  readonly hidden: CleanStepsSegment | undefined;
  readonly shown: CleanStepsSegment['messages'];
} {
  let remaining = size;
  for (let index = segment.messages.length - 1; index >= 0; index -= 1) {
    const { key, message } = segment.messages[index];
    const parts = normalizeChatMessageParts(message.parts ?? []);
    for (let at = parts.length - 1; at >= 0; at -= 1) {
      if (partRole(parts[at]) !== 'step') continue;
      remaining -= 1;
      if (remaining > 0) continue;
      const before = segment.messages.slice(0, index);
      const after = segment.messages.slice(index + 1);
      const shown =
        at === 0
          ? [{ key, message }, ...after]
          : [
              { key, message: { ...message, parts: parts.slice(at) } },
              ...after,
            ];
      const hidden =
        at === 0
          ? before
          : [
              ...before,
              {
                key: `${key}#before`,
                message: { ...message, parts: parts.slice(0, at) },
              },
            ];
      return {
        hidden: hidden.some(({ message: held }) =>
          normalizeChatMessageParts(held.parts ?? []).some(
            (part) => partRole(part) === 'step',
          ),
        )
          ? { ...segment, messages: hidden }
          : undefined,
        shown,
      };
    }
  }
  return { hidden: undefined, shown: segment.messages };
}
