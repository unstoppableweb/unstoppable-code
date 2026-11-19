import {
  parseChatAgentSentInfo,
  type ChatAgentSentInfo,
  type RemoteControlChatPart,
} from '@canopy/protocol/remote-control/shell';
import type { SubagentNode, SubagentTree } from '../subagent-tree';
import { placeRunPrompt, subagentParentTitle } from './shared';
import type {
  RemoteControlSubagentChatTranscript,
  RemoteControlSubagentChatTranscriptItem,
  RemoteControlSubagentRunObservation,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function partText(part: RemoteControlChatPart): string | undefined {
  if (part.kind !== 'text' || !isRecord(part.data)) return undefined;
  const text = part.data['text'];
  return typeof text === 'string' ? text : undefined;
}

/**
 * Rebuild the public agent-sender attribution from its compact, string-safe
 * wire fields (see `agentSentWireFields`). Malformed or mixed sender-kind
 * fields yield no attribution.
 */
function partAgentSent(
  part: RemoteControlChatPart,
): ChatAgentSentInfo | undefined {
  if (!isRecord(part.data)) return undefined;
  const data = part.data;
  const senderKind = data['agentSentSenderKind'];
  if (senderKind === 'project') {
    return parseChatAgentSentInfo({
      sender: {
        kind: 'project',
        projectType: data['agentSentProjectType'],
        projectId: data['agentSentProjectId'],
        taskId: data['agentSentTaskId'],
        chatId: data['agentSentChatId'],
        ...('agentSentBotId' in data ? { botId: data['agentSentBotId'] } : {}),
      },
      chatTitle: data['agentSentChatTitle'],
      projectLabel: data['agentSentProjectLabel'],
    });
  }
  if (senderKind === 'cloud_chat') {
    return parseChatAgentSentInfo({
      sender: {
        kind: 'cloud_chat',
        projectId: data['agentSentProjectId'],
        taskId: data['agentSentTaskId'],
        chatId: data['agentSentChatId'],
        ...('agentSentBotId' in data ? { botId: data['agentSentBotId'] } : {}),
        ...('agentSentProjectType' in data
          ? { projectType: data['agentSentProjectType'] }
          : {}),
      },
      chatTitle: data['agentSentChatTitle'],
      projectLabel: data['agentSentProjectLabel'],
    });
  }
  if (senderKind === 'bot') {
    return parseChatAgentSentInfo({
      sender: {
        kind: 'bot',
        botId: data['agentSentBotId'],
        taskId: data['agentSentTaskId'],
        chatId: data['agentSentChatId'],
        ...('agentSentProjectType' in data
          ? { projectType: data['agentSentProjectType'] }
          : {}),
        ...('agentSentProjectId' in data
          ? { projectId: data['agentSentProjectId'] }
          : {}),
      },
      chatTitle: data['agentSentChatTitle'],
      projectLabel: data['agentSentProjectLabel'],
    });
  }
  if (senderKind === 'pipeline') {
    // Every present key is copied so the parser refuses mixed variants.
    const sender: Record<string, unknown> = { kind: 'pipeline' };
    for (const [wireKey, key] of PIPELINE_WIRE_KEYS) {
      if (wireKey in data) sender[key] = data[wireKey];
    }
    return parseChatAgentSentInfo({
      sender,
      chatTitle: data['agentSentChatTitle'],
      projectLabel: data['agentSentProjectLabel'],
    });
  }
  return undefined;
}

const PIPELINE_WIRE_KEYS = [
  ['agentSentExecutionId', 'executionId'],
  ['agentSentPipelineId', 'pipelineId'],
  ['agentSentStepId', 'stepId'],
  ['agentSentAutomationId', 'automationId'],
  ['agentSentProjectType', 'projectType'],
  ['agentSentProjectId', 'projectId'],
  ['agentSentBotId', 'botId'],
  ['agentSentTaskId', 'taskId'],
  ['agentSentChatId', 'chatId'],
] as const;

/** Who wrote an authored child message, from its flat wire fields. */
function partAuthor(
  part: RemoteControlChatPart,
):
  | { readonly kind: 'user'; readonly steering: boolean }
  | { readonly kind: 'agent'; readonly description?: string }
  | undefined {
  if (!isRecord(part.data)) return undefined;
  const kind = part.data['delegationAuthorKind'];
  if (kind === 'user') {
    return {
      kind,
      steering: part.data['delegationDelivery'] === 'steer',
    };
  }
  if (kind === 'agent') {
    const description = part.data['delegationAuthorDescription'];
    return typeof description === 'string' && description.length > 0
      ? { kind, description }
      : { kind };
  }
  return undefined;
}

/**
 * A subagent's transcript from Portal chat parts: the latest observation of
 * each run, in run order, each led by its prompt (placed after the authored
 * follow-up that started it), its truncation notice, its child parts, and its
 * final answer when no child part already shows it. A node with no observed
 * run shows its prompt. Hosts pass a native Claude agent's part, or a
 * single-receiver Codex agent's part, as its only run.
 */
export function buildRemoteControlSubagentChatTranscript(input: {
  readonly tree: SubagentTree;
  readonly node: SubagentNode;
  readonly runs: readonly RemoteControlSubagentRunObservation[];
}): RemoteControlSubagentChatTranscript {
  const { tree, node } = input;
  const parentTitle = subagentParentTitle(tree, node);
  const latestByRun = new Map<number, RemoteControlSubagentRunObservation>();
  for (const run of input.runs) latestByRun.set(run.runGeneration, run);
  const runs = Array.from(latestByRun.values()).sort(
    (left, right) => left.runGeneration - right.runGeneration,
  );
  if (runs.length === 0) {
    const prompt = node.prompt ?? '';
    return {
      items:
        prompt.length > 0
          ? [
              {
                kind: 'task',
                key: `task-${node.id}`,
                sender: parentTitle,
                text: prompt,
              },
            ]
          : [],
    };
  }

  const items: RemoteControlSubagentChatTranscriptItem[] = [];
  runs.forEach((run, runIndex) => {
    const prefix = `run-${run.runGeneration}`;
    if (runIndex > 0) {
      items.push({
        kind: 'divider',
        key: `${prefix}-divider`,
        runGeneration: run.runGeneration,
      });
    }
    const body: RemoteControlSubagentChatTranscriptItem[] = [];
    if (run.subBlocksTruncated) {
      body.push({
        kind: 'truncated',
        key: `${prefix}-truncated`,
        omittedSubBlocks: run.omittedSubBlocks,
      });
    }
    run.subBlocks.forEach((part, partIndex) => {
      const key = `${prefix}-${part.kind}-${partIndex}`;
      const author = partAuthor(part);
      const text = partText(part);
      if (author?.kind === 'user' && text !== undefined) {
        const agentSent = partAgentSent(part);
        body.push({
          kind: 'user',
          key,
          text,
          steering: author.steering,
          ...(agentSent !== undefined ? { agentSent } : {}),
        });
      } else if (author?.kind === 'agent' && text !== undefined) {
        body.push({
          kind: 'follow_up',
          key,
          sender: author.description ?? parentTitle,
          text,
        });
      } else {
        body.push({ kind: 'part', key, part });
      }
    });
    items.push(
      ...placeRunPrompt({
        key: `${prefix}-task`,
        prompt: run.prompt ?? '',
        sender: parentTitle,
        items: body,
      }),
    );
    const finalText = run.finalText;
    if (
      finalText !== undefined &&
      !run.subBlocks.some((part) => partText(part)?.trim() === finalText.trim())
    ) {
      items.push({
        kind: 'part',
        key: `${prefix}-final-text`,
        part: { kind: 'text', data: { text: finalText } },
      });
    }
  });
  return { items };
}
