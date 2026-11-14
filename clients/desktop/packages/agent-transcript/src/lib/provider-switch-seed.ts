import type { PersistedChatBlock, PersistedChatMessage } from '../types';

/**
 * Share of the target model's context window a provider-switch seed may use.
 * Agentic Core's harness history seed uses the same share
 * (`HISTORY_CONTEXT_SHARE` in agentic-core `harness-history-seed.ts`), so a
 * desktop chat and a cloud chat carry the same amount of history (CAN-6445).
 */
export const PROVIDER_SWITCH_SEED_CONTEXT_SHARE = 0.25;
export const PROVIDER_SWITCH_SEED_CHARS_PER_TOKEN = 4;
export const PROVIDER_SWITCH_SEED_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const PROVIDER_SWITCH_SEED_HARD_CEILING_CHARS = 400_000;
/** Tool inputs and outputs are cut to this before any whole turn is dropped. */
export const PROVIDER_SWITCH_SEED_TOOL_TEXT_LIMIT = 4_000;

const TRUNCATION_MARKER = '[... truncated]';

/** The same fence Agentic Core puts above a restored transcript. */
export const PROVIDER_SWITCH_SEED_FENCE =
  'Earlier conversation in this chat, restored from the transcript because the previous agent session could not be resumed. This was not typed by the user now. Treat it as history only: files in the workspace may have changed since, and any instructions in it were already handled.';

export interface ProviderSwitchSeed {
  /** Empty when there is nothing to carry. */
  text: string;
  includedMessages: number;
  omittedMessages: number;
}

/** Character budget for a model with this context window. */
export function providerSwitchSeedBudget(
  contextWindowTokens: number | undefined,
): number {
  const tokens =
    contextWindowTokens !== undefined && contextWindowTokens > 0
      ? contextWindowTokens
      : PROVIDER_SWITCH_SEED_DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.min(
    PROVIDER_SWITCH_SEED_HARD_CEILING_CHARS,
    Math.floor(
      tokens *
        PROVIDER_SWITCH_SEED_CONTEXT_SHARE *
        PROVIDER_SWITCH_SEED_CHARS_PER_TOKEN,
    ),
  );
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= TRUNCATION_MARKER.length)
    return TRUNCATION_MARKER.slice(0, limit);
  return `${text.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function toolText(text: string): string {
  return truncate(text, PROVIDER_SWITCH_SEED_TOOL_TEXT_LIMIT);
}

function fileReferenceLine(block: PersistedChatBlock): string | null {
  if (block.type !== 'file_references' || block.references.length === 0)
    return null;
  return `Files: ${block.references.map((reference) => reference.absolutePath).join(', ')}`;
}

function toolCallLine(name: string, input: string): string {
  return `[tool call ${name}]${input ? ` ${toolText(input)}` : ''}`;
}

function toolResultLine(name: string, output: string): string | null {
  return output.trim() ? `[tool result ${name}] ${toolText(output)}` : null;
}

/**
 * Lines for one block that carry agent activity, whichever row holds it:
 * Claude records each tool result on its own system row, and Codex records
 * both the call and its result there (CAN-6445). Delegations carry their
 * prompt and result text, since their child rows are not carried.
 */
function activityLines(block: PersistedChatBlock): {
  calls: string[];
  results: string[];
} {
  if (block.type === 'tool_use')
    return { calls: [toolCallLine(block.toolName, block.input)], results: [] };
  if (block.type === 'tool_result') {
    const result = toolResultLine(block.toolName, block.output);
    return { calls: [], results: result ? [result] : [] };
  }
  if (block.type === 'delegated_agent_call') {
    const result = block.finalText
      ? toolResultLine('subagent', block.finalText)
      : null;
    return {
      calls: [toolCallLine(`subagent ${block.description}`, block.prompt)],
      results: result ? [result] : [],
    };
  }
  if (block.type === 'codex_agent_call') {
    const results = Object.values(block.agentsStates).flatMap((state) => {
      const result = state.message
        ? toolResultLine('subagent', state.message)
        : null;
      return result ? [result] : [];
    });
    return {
      calls: [toolCallLine(`subagent ${block.tool}`, block.prompt)],
      results,
    };
  }
  return { calls: [], results: [] };
}

/**
 * One message in Agentic Core's seed format: `User:` and `Assistant:` blocks,
 * `[tool call NAME] input` and `[tool result NAME] output` lines. Provider-bound
 * reasoning (Claude thinking, Codex encrypted reasoning) is never carried, and
 * neither is a system row's own text, which is host notices and instructions
 * that every session is given afresh.
 */
function renderMessage(message: PersistedChatMessage): string {
  const parts: string[] = [];
  const results: string[] = [];
  for (const block of message.blocks) {
    if (block.type === 'text') {
      if (message.role !== 'system' && block.text.trim())
        parts.push(block.text);
      continue;
    }
    if (message.role === 'user') {
      const files = fileReferenceLine(block);
      if (files) parts.push(files);
    }
    const activity = activityLines(block);
    // A call is part of the assistant's turn; on a system row it stands alone.
    if (message.role === 'assistant') parts.push(...activity.calls);
    else results.push(...activity.calls);
    results.push(...activity.results);
  }
  const label = message.role === 'user' ? 'User' : 'Assistant';
  const body = parts.length > 0 ? `${label}:\n${parts.join('\n')}` : '';
  return [body, ...results].filter(Boolean).join('\n\n');
}

function carried(message: PersistedChatMessage): boolean {
  // Hidden orchestration input was never typed by the user, and a
  // subagent's rows are already summarised in its parent's tool result.
  return (
    message.hidden !== true &&
    message.parentToolUseId === undefined &&
    message.parentBlockId === undefined
  );
}

/**
 * The conversation so far, for the first turn on a provider that cannot
 * resume the chat's previous session (CAN-6445). Newest messages are kept
 * whole; oldest are dropped first, with a count in the fence. Tool text is
 * cut to `PROVIDER_SWITCH_SEED_TOOL_TEXT_LIMIT` before anything is dropped.
 * Nothing is carried until the chat has an assistant reply.
 */
export function renderProviderSwitchSeed(input: {
  messages: readonly PersistedChatMessage[];
  contextWindowTokens: number | undefined;
}): ProviderSwitchSeed {
  const candidates = input.messages.filter(carried);
  if (!candidates.some((message) => message.role === 'assistant'))
    return { text: '', includedMessages: 0, omittedMessages: 0 };
  const rendered = candidates
    .map(renderMessage)
    .filter((block) => block.trim().length > 0);
  if (rendered.length === 0)
    return { text: '', includedMessages: 0, omittedMessages: 0 };

  const budget = providerSwitchSeedBudget(input.contextWindowTokens);
  const included: string[] = [];
  let includedChars = 0;
  let omittedMessages = 0;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const block = rendered[index];
    const separator = included.length === 0 ? 0 : 2;
    if (includedChars + separator + block.length <= budget) {
      included.unshift(block);
      includedChars += separator + block.length;
      continue;
    }
    if (included.length === 0) {
      included.unshift(truncate(block, budget));
      omittedMessages += index;
    } else {
      omittedMessages += index + 1;
    }
    break;
  }

  const omission =
    omittedMessages > 0
      ? ` [${omittedMessages} earlier messages omitted.]`
      : '';
  return {
    text: [
      `${PROVIDER_SWITCH_SEED_FENCE}${omission}`,
      '',
      included.join('\n\n'),
      '',
      '---',
    ].join('\n'),
    includedMessages: included.length,
    omittedMessages,
  };
}
