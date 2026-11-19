import type { SessionEvent } from '@github/copilot-sdk';
import type { PersistedChatBlock } from '@canopy/agent-transcript/types';
import { redactSerializedJsonLine } from '@canopy/protocol/value-redaction';
import {
  redactCopilotTextParts,
  redactCopilotToolValue,
} from './text-redaction';
import { copilotNativeOperations, isCopilotRecord } from './tool-input';
import { CopilotRecipientFailure } from './failure';

/** Vendor events become the canonical patch format; raw SDK logs are not persisted. */
export class CopilotEventProjection {
  private readonly seen = new Set<string>();
  private readonly blocks = new Map<
    string,
    { text: string; revision: number; timestamp: number }
  >();
  private readonly tools = new Map<string, string>();
  private readonly toolPatches = new Map<
    string,
    { index: number; block: PersistedChatBlock }[]
  >();
  private readonly contentOrder: (
    | { kind: 'text'; id: string }
    | {
        kind: 'tool';
        block: Extract<PersistedChatBlock, { type: 'tool_result' }>;
      }
  )[] = [];
  private bytes = 0;
  private revision = 0;
  private readonly answers = new Map<string, string>();
  private readonly textKinds = new Map<string, 'text' | 'thinking'>();
  private drained = false;

  get text(): string {
    return redactCopilotTextParts(
      Array.from(this.answers.values()),
      this.secretValues,
    ).join('');
  }

  constructor(
    private readonly turnId: string,
    private readonly cwd: string,
    private readonly secretValues: readonly string[] = [],
  ) {}

  /** Secret-bearing unattended runs release complete text only, including on failure. */
  drain(): Record<string, unknown>[] {
    if (!this.secretValues.length || this.drained) return [];
    this.drained = true;
    const text = new Map<string, string>();
    const output = new Map<
      Extract<PersistedChatBlock, { type: 'tool_result' }>,
      string
    >();
    const slots: typeof this.contentOrder = [];
    for (const id of Array.from(this.blocks.keys())) {
      if (this.textKinds.has(id)) slots.push({ kind: 'text', id });
      else
        for (const patch of this.toolPatches.get(id) ?? []) {
          if (patch.block.type === 'tool_result')
            slots.push({ kind: 'tool', block: patch.block });
        }
    }
    const mask = (parts: typeof this.contentOrder): void => {
      const masked = redactCopilotTextParts(
        parts.map((part) =>
          part.kind === 'text'
            ? (text.get(part.id) ?? this.blocks.get(part.id)?.text ?? '')
            : (output.get(part.block) ?? part.block.output),
        ),
        this.secretValues,
      );
      parts.forEach((part, index) => {
        if (part.kind === 'text') text.set(part.id, masked[index]);
        else output.set(part.block, masked[index]);
      });
    };
    // Transcript slots and tool completions can have different orders. Mask
    // both, including boundaries between assistant text and tool output.
    mask(slots);
    mask(this.contentOrder);
    for (const [id, value] of Array.from(text))
      if (this.answers.has(id)) this.answers.set(id, value);
    return Array.from(this.blocks, ([id, entry]) =>
      this.patch(
        id,
        entry.timestamp,
        text.has(id)
          ? [
              {
                index: 0,
                block: {
                  type: this.textKinds.get(id) ?? 'text',
                  text: text.get(id) ?? '',
                },
              },
            ]
          : (this.toolPatches.get(id) ?? []).map((patch) =>
              patch.block.type === 'tool_result'
                ? {
                    ...patch,
                    block: {
                      ...patch.block,
                      output: output.get(patch.block) ?? '',
                    },
                  }
                : patch,
            ),
      ),
    );
  }

  accept(event: SessionEvent): Record<string, unknown> | undefined {
    if (this.seen.has(event.id)) return undefined;
    if (this.seen.size >= 16_384)
      throw new Error('Copilot response exceeded the local event limit.');
    this.seen.add(event.id);
    this.bytes += Buffer.byteLength(JSON.stringify(event));
    if (this.bytes > 8 * 1024 * 1024)
      throw new CopilotRecipientFailure(
        'Copilot response exceeded the local chat limit.',
        'limit',
      );
    // Native subagents are excluded. Never flatten an unexpected child's output
    // into the root answer or imply that it ran under a managed child grant.
    if (event.agentId) return undefined;
    const timestamp = Date.parse(event.timestamp);
    switch (event.type) {
      case 'assistant.message_delta':
        return this.updateText(
          `message:${event.data.messageId}`,
          'text',
          event.data.deltaContent,
          true,
          timestamp,
        );
      case 'assistant.message':
        return this.updateText(
          `message:${event.data.messageId}`,
          'text',
          event.data.content,
          false,
          timestamp,
        );
      case 'assistant.reasoning_delta':
        return this.updateText(
          `reasoning:${event.data.reasoningId}`,
          'thinking',
          event.data.deltaContent,
          true,
          timestamp,
        );
      case 'assistant.reasoning':
        return this.updateText(
          `reasoning:${event.data.reasoningId}`,
          'thinking',
          event.data.content,
          false,
          timestamp,
        );
      case 'tool.execution_start': {
        const data = event.data;
        const server = data.mcpConfigServerName ?? data.mcpServerName;
        const toolName =
          server && data.mcpToolName
            ? `mcp__${server}__${data.mcpToolName}`
            : data.toolName === 'ask_user'
              ? 'AskUserQuestion'
              : data.toolName;
        const args = isCopilotRecord(data.arguments)
          ? data.arguments
          : undefined;
        const input =
          data.toolName === 'ask_user' && typeof args?.question === 'string'
            ? {
                questions: [
                  {
                    question: args.question,
                    options: Array.isArray(args.choices)
                      ? args.choices.filter(
                          (choice): choice is string =>
                            typeof choice === 'string',
                        )
                      : [],
                    allowOther: args.allowFreeform !== false,
                  },
                ],
              }
            : (data.arguments ?? {});
        this.tools.set(data.toolCallId, toolName);
        const operation = copilotNativeOperations(
          data.toolName,
          data.arguments,
          this.cwd,
        )?.[0];
        const tool: PersistedChatBlock = {
          type: 'tool_use',
          toolUseId: `${this.turnId}:${data.toolCallId}`,
          toolName,
          input: JSON.stringify(
            redactCopilotToolValue(input, this.secretValues),
          ),
          ...(operation
            ? {
                display: {
                  toolName: operation.tool,
                  input: JSON.stringify(
                    redactCopilotToolValue(operation.input, this.secretValues),
                  ),
                },
              }
            : {}),
        };
        return this.toolPatch(`tool:${data.toolCallId}`, timestamp, [
          { index: 0, block: tool },
        ]);
      }
      case 'tool.execution_complete': {
        const data = event.data;
        const started = this.tools.has(data.toolCallId);
        return this.toolPatch(`tool:${data.toolCallId}`, timestamp, [
          {
            index: started ? 1 : 0,
            block: {
              type: 'tool_result',
              toolUseId: `${this.turnId}:${data.toolCallId}`,
              toolName: this.tools.get(data.toolCallId) ?? 'Copilot tool',
              output: redactCopilotTextParts(
                [
                  data.result?.detailedContent ??
                    data.result?.content ??
                    data.error?.message ??
                    '',
                ],
                this.secretValues,
              )[0],
              isError: !data.success,
            },
          },
        ]);
      }
      default:
        return undefined;
    }
  }

  private toolPatch(
    id: string,
    timestamp: number,
    patches: { index: number; block: PersistedChatBlock }[],
  ): Record<string, unknown> | undefined {
    const event = this.patch(id, timestamp, patches);
    if (!this.secretValues.length) return event;
    for (const { block } of patches)
      if (block.type === 'tool_result')
        this.contentOrder.push({ kind: 'tool', block });
    this.toolPatches.set(id, [...(this.toolPatches.get(id) ?? []), ...patches]);
    return undefined;
  }

  private updateText(
    id: string,
    type: 'text' | 'thinking',
    text: string,
    append: boolean,
    timestamp: number,
  ): Record<string, unknown> | undefined {
    if (!this.textKinds.has(id)) this.contentOrder.push({ kind: 'text', id });
    this.textKinds.set(id, type);
    const prior = this.blocks.get(id);
    const previous = prior?.text ?? '';
    const content = append ? previous + text : text;
    if (type === 'text') this.answers.set(id, content);
    const event = this.patch(id, timestamp, [
      append && prior
        ? { index: 0, appendText: text }
        : { index: 0, block: { type, text: content } },
    ]);
    const entry = this.blocks.get(id);
    if (entry) entry.text = content;
    return this.secretValues.length ? undefined : event;
  }

  private patch(
    id: string,
    timestamp: number,
    patches: Array<
      | { index: number; block: PersistedChatBlock }
      | { index: number; appendText: string }
    >,
  ): Record<string, unknown> {
    const prior = this.blocks.get(id);
    const entry = prior ?? {
      text: '',
      revision: 0,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    };
    entry.revision = ++this.revision;
    this.blocks.set(id, entry);
    const event = {
      type: 'canopy_assistant_patch',
      provider: 'copilot',
      messageId: `${this.turnId}:${id}`,
      timestamp: entry.timestamp,
      revision: entry.revision,
      patches,
    };
    if (!this.secretValues.length) return event;
    const redacted: unknown = JSON.parse(
      redactSerializedJsonLine(JSON.stringify(event), this.secretValues),
    );
    if (!isCopilotRecord(redacted))
      throw new Error('Copilot transcript redaction failed.');
    return redacted;
  }
}
