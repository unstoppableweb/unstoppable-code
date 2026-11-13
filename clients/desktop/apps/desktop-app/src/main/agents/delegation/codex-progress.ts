import type { AgentDelegationUsage } from '@canopy/protocol/delegation';
import {
  projectCodexRuntimeEvent,
  type CodexRuntimeEvent,
} from '@canopy/execution-engine/node/codex-runtime';

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bounded progress survives a native failure before the final turn result. */
export class CodexDelegationProgress {
  private readonly items = new Map<
    string,
    { text: string; complete: boolean }
  >();
  private joinedText: string | undefined;
  usage?: AgentDelegationUsage;

  get text(): string {
    if (this.joinedText === undefined)
      this.joinedText = Array.from(
        this.items.values(),
        (item) => item.text,
      ).join('\n');
    return this.joinedText;
  }

  get truncated(): boolean {
    return false;
  }

  receive(event: CodexRuntimeEvent): void {
    const projected = projectCodexRuntimeEvent(event);
    const item = record(projected.item);
    if (
      projected.type === 'item.completed' &&
      item?.type === 'agent_message' &&
      typeof item.id === 'string' &&
      typeof item.text === 'string'
    )
      this.update(item.id, item.text, true);
    if (
      typeof event.params.delta === 'string' &&
      typeof event.params.itemId === 'string' &&
      event.method === 'item/agentMessage/delta'
    )
      this.update(event.params.itemId, event.params.delta, false);
    if (projected.type === 'thread.token_usage.updated') {
      const usage = record(projected.usage);
      const finite = (key: string): number | undefined =>
        typeof usage?.[key] === 'number' &&
        Number.isFinite(usage[key]) &&
        usage[key] >= 0
          ? usage[key]
          : undefined;
      this.usage = {
        inputTokens: finite('cumulative_input_tokens'),
        outputTokens: finite('cumulative_output_tokens'),
        cachedInputTokens: finite('cumulative_cached_input_tokens'),
      };
    }
  }

  private update(id: string, text: string, complete: boolean): void {
    if (id.length > 256) return;
    const prior = this.items.get(id);
    if (prior?.complete) return;
    this.items.set(id, {
      text: complete ? text : `${prior?.text ?? ''}${text}`,
      complete,
    });
    this.joinedText = undefined;
  }
}
