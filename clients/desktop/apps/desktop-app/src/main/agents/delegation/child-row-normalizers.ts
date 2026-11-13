import {
  DelegationChildRowBuilder,
  codexNeutralItemBlocks,
  parseClaudeAssistantBlocks,
  parseClaudeToolResults,
  projectDelegationAssistantPatch,
  type DelegationLogicalItem,
} from '@canopy/agent-transcript';
import type {
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/agent-transcript';
import { projectCodexThreadItem } from '@canopy/execution-engine/node/codex-runtime';
import { createHash } from 'node:crypto';
import {
  DELEGATION_REGISTRY_MAX_ID_LENGTH,
  type DelegationTranscriptChange,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import type {
  CommandSpool,
  DelegationCommandSpools,
} from './command-output-spools';

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function appendText(value: unknown, delta: string): string {
  return (typeof value === 'string' ? value : '') + delta;
}

/** App-server notifications that extend an item already started. */
const CODEX_DELTA_METHODS: ReadonlySet<string> = new Set([
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
]);

function isProse(block: PersistedChatBlock): boolean {
  return block.type === 'text' || block.type === 'thinking';
}

interface ClaudeBlockState {
  readonly messageId: string;
  readonly index: number;
  readonly segment: string;
  readonly timestamp: number;
  block: Record<string, unknown>;
  stopped: boolean;
}

interface ClaudeToolState {
  readonly id: string;
  readonly nativeId: string;
  readonly segment: string;
  readonly timestamp: number;
  blocks: PersistedChatBlock[];
  final: boolean;
}

export interface DelegationChildNormalizerOptions {
  readonly now?: () => number;
  /** Spools for Codex command output; stream-backed runs only. */
  readonly spools?: DelegationCommandSpools;
  /** Latch required storage failures at their origin, before cleanup. */
  readonly onStorageFailure?: (error: unknown) => void;
  readonly onDiagnostic?: (diagnostic: {
    kind: 'closed-segment-events';
    segment: string;
    count: number;
  }) => void;
}

/** The end of one Codex turn, settled before the run continues. */
export interface DelegationCodexTurnSettlement {
  readonly threadId: string;
  /** Absent when the turn never reported an id; the thread's current turn is used. */
  readonly turnId?: string;
  readonly kind: 'completed' | 'interrupted' | 'failed';
}

interface CodexSegment {
  readonly threadId: string;
  readonly turnId: string;
  terminalItems: Record<string, unknown>[];
  closed: boolean;
  drops: number;
}

interface CommandOutput {
  seed?: string;
  spool?: CommandSpool;
}

interface ItemCorrelation {
  readonly id: string;
  readonly rowId: string;
  readonly segment: string;
  final: boolean;
  finalRevision?: number;
  readonly claudeBlockKeys: Set<string>;
}

/**
 * Ownership/state table (all payloads are owned by this normalizer instance):
 * - items: active -> final-in-flight -> removed on matching final acknowledgement.
 * - builder: observed/published payload -> evicted final tombstone on that ack.
 * - Claude blocks/tools and Codex native metadata: retained until matching ack.
 * - Codex command output: seed until transfer, then spool only; the exact joined
 *   output belongs to the final row until ack. No output is retained in native
 *   command metadata, nor in a fulfilled shared finish promise.
 * - correlations/native indexes: payload-free {row id, segment, final} tombstones
 *   survive acknowledgement; reject duplicates/late events BEFORE native mutation.
 * - patchMessages: retained until finish; O(message bytes) memory and O(message
 *   blocks) work per patch is a deliberate phase-10a limitation.
 * All remaining state is disposed with this run's normalizer. Codex runtime item
 * retention until turn end is outside this ownership boundary.
 */
/** Converts native runner events into canonical child-row admissions. */
export class DelegationChildNormalizer {
  private readonly builder: DelegationChildRowBuilder;
  private readonly items = new Map<string, DelegationLogicalItem>();
  private readonly timestamps = new Map<string, number>();
  private readonly correlations = new Map<string, ItemCorrelation>();
  private readonly rowItems = new Map<string, ItemCorrelation>();
  private readonly claudeBlockIndex = new Map<string, ItemCorrelation>();
  private readonly claudeToolIndex = new Map<string, ItemCorrelation>();
  private readonly now: () => number;
  private lastTakeAll = Number.NEGATIVE_INFINITY;
  private readonly claudeBlocks = new Map<string, ClaudeBlockState>();
  private readonly claudeTools = new Map<string, ClaudeToolState>();
  private readonly claudeMessageBlocks = new Map<string, Set<string>>();
  private readonly claudeStartedMessages = new Set<string>();
  private claudeCurrentMessageId: string | undefined;
  private readonly patchMessages = new Map<string, PersistedChatMessage>();
  private readonly codexItems = new Map<string, Record<string, unknown>>();
  private readonly codexThreads = new Map<string, string>();
  private readonly codexItemKeys = new Map<string, string>();
  private readonly codexSegments = new Map<string, CodexSegment>();
  private readonly commandOutputs = new Map<string, CommandOutput>();
  private unidentifiedTurn = 0;
  // A single awaited lane also serializes operations for every individual item.
  private codexLane: Promise<void> = Promise.resolve();
  private finishPromise?: Promise<readonly DelegationTranscriptChange[]>;
  private closePromise?: Promise<void>;
  private storageFailure?: { error: unknown };
  private finished = false;

  constructor(
    private readonly agentBlockId: string,
    private readonly options: DelegationChildNormalizerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.builder = new DelegationChildRowBuilder(agentBlockId);
  }

  /** Consume one Claude SDK event. */
  claude(value: unknown): Promise<readonly DelegationTranscriptChange[]> {
    return Promise.resolve(this.finishPromise ? [] : this.claudeEvent(value));
  }

  /** Consume one Codex app-server event. */
  codex(event: {
    method: string;
    params: Record<string, unknown>;
  }): Promise<readonly DelegationTranscriptChange[]> {
    // Late provider events after the run closed this normalizer are inert.
    if (this.closePromise) return Promise.resolve([]);
    return this.enqueue(() => this.codexEvent(event));
  }

  /** Consume Cursor, Copilot, or OpenCode provider-neutral patch events. */
  patch(value: unknown): Promise<readonly DelegationTranscriptChange[]> {
    return Promise.resolve(this.finishPromise ? [] : this.patchEvent(value));
  }

  /** Finalize every unfinished logical item before the runner settles. */
  finish(): Promise<readonly DelegationTranscriptChange[]> {
    if (this.finishPromise) return this.finishPromise;
    if (this.finished) return Promise.resolve([]);
    const pending = this.enqueue(async () => {
      const changes: DelegationTranscriptChange[] = [];
      for (const segment of Array.from(this.codexSegments.values())) {
        await this.settleCodexTurn(segment, false);
      }
      changes.push(...this.finishItems());
      return changes;
    });
    this.finishPromise = pending;
    // Retain only while in flight, not the fulfilled promise's final bodies.
    void pending.then(
      () => {
        this.finishPromise = undefined;
      },
      () => {
        this.finishPromise = undefined;
      },
    );
    return pending;
  }

  /** Close one Codex turn's open items before the run continues. */
  settleTurn(
    settlement: DelegationCodexTurnSettlement,
  ): Promise<readonly DelegationTranscriptChange[]> {
    if (this.closePromise) return Promise.resolve([]);
    return this.enqueue(() => this.settleCodexTurn(settlement));
  }

  /** Drain operations, then close the owner even after an ingestion failure. */
  close(): Promise<void> {
    this.closePromise ??= this.codexLane.then(async () => {
      try {
        await this.options.spools?.close();
      } finally {
        for (const [segment, state] of Array.from(this.codexSegments)) {
          if (state.drops > 0)
            this.options.onDiagnostic?.({
              kind: 'closed-segment-events',
              segment,
              count: state.drops,
            });
        }
        this.commandOutputs.clear();
      }
    });
    return this.closePromise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closePromise)
      return Promise.reject(new Error('Normalizer is closed'));
    const pending = this.codexLane.then(() => {
      if (this.storageFailure) throw this.storageFailure.error;
      return operation();
    });
    this.codexLane = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async storage<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.storageFailure ??= { error };
      this.options.onStorageFailure?.(error);
      throw error;
    }
  }

  /** Record that these changes were durably admitted. */
  acknowledge(changes: readonly DelegationTranscriptChange[]): void {
    for (const { row } of changes) {
      if (!row.final) continue;
      const correlation = this.rowItems.get(row.id);
      if (!correlation?.final || correlation.finalRevision !== row.itemRevision)
        continue;
      this.builder.evict(row.id, row.itemRevision);
      this.items.delete(correlation.id);
      this.timestamps.delete(correlation.id);
      this.claudeTools.delete(correlation.id);
      correlation.claudeBlockKeys.forEach((key) => {
        const state = this.claudeBlocks.get(key);
        if (state) {
          const keys = this.claudeMessageBlocks.get(state.messageId);
          keys?.delete(key);
          if (keys?.size === 0)
            this.claudeMessageBlocks.delete(state.messageId);
        }
        this.claudeBlocks.delete(key);
        this.timestamps.delete(key);
      });
      correlation.claudeBlockKeys.clear();
      const nativeKey = this.codexItemKeys.get(correlation.id);
      if (nativeKey) {
        this.codexItems.delete(nativeKey);
        this.commandOutputs.delete(nativeKey);
      }
      this.codexItemKeys.delete(correlation.id);
    }
  }

  private timestamp(id: string, source?: unknown): number {
    const previous = this.timestamps.get(id);
    if (previous !== undefined) return previous;
    const value = finiteTimestamp(source) ?? this.now();
    this.timestamps.set(id, value);
    return value;
  }

  /**
   * One native item's identity in its segment. Its row id adds the card's
   * block id, and the transcript registry admits ids up to its limit, so a
   * longer identity (Copilot's nested message and tool ids) is hashed, stably.
   */
  private scopedId(segment: string, nativeId: string): string {
    const id = `${segment}::${nativeId}`;
    return this.agentBlockId.length + 1 + id.length <=
      DELEGATION_REGISTRY_MAX_ID_LENGTH
      ? id
      : `sha256:${createHash('sha256').update(id).digest('hex')}`;
  }

  private publish(): readonly DelegationTranscriptChange[] {
    const now = this.now();
    const all = now - this.lastTakeAll >= 250;
    const rows = this.builder.take(all ? 'all' : 'final');
    // Empty lifecycle events must not consume the first observation's window.
    if (all && this.correlations.size > 0) this.lastTakeAll = now;
    return this.changesFromRows(rows);
  }

  private changesFromRows(
    rows: ReturnType<DelegationChildRowBuilder['take']>,
  ): readonly DelegationTranscriptChange[] {
    return rows.map((row) => {
      const correlation = this.rowItems.get(row.id);
      if (correlation && row.final)
        correlation.finalRevision = row.itemRevision;
      return { row };
    });
  }

  private upsert(item: DelegationLogicalItem): ItemCorrelation | undefined {
    if (this.finished) return undefined;
    const prior = this.correlations.get(item.id);
    if (prior?.final || !this.builder.observe(item)) return undefined;
    this.items.set(item.id, item);
    const correlation: ItemCorrelation = prior ?? {
      id: item.id,
      rowId: `${this.agentBlockId}:${item.id}`,
      segment: item.segment,
      final: false,
      claudeBlockKeys: new Set(),
    };
    correlation.final = item.final;
    this.correlations.set(item.id, correlation);
    this.rowItems.set(correlation.rowId, correlation);
    return correlation;
  }

  private claudeEvent(value: unknown): readonly DelegationTranscriptChange[] {
    if (this.finished) return [];
    const outer = record(value);
    if (!outer) return [];
    const event = outer.type === 'stream_event' ? record(outer.event) : outer;
    if (!event) return [];
    const message = record(event.message);
    const messageId = string(message?.id) ?? this.claudeCurrentMessageId;

    const startedMessageId = string(message?.id);
    if (event.type === 'message_start' && startedMessageId) {
      if (this.claudeStartedMessages.has(startedMessageId))
        return this.publish();
      this.claudeStartedMessages.add(startedMessageId);
      this.claudeCurrentMessageId = startedMessageId;
      if (!this.claudeMessageBlocks.has(startedMessageId))
        this.claudeMessageBlocks.set(startedMessageId, new Set());
    }

    if (event.type === 'content_block_start' && messageId) {
      const block = record(event.content_block);
      const index = finiteTimestamp(event.index) ?? 0;
      if (block) {
        const key = `${messageId}:${index}`;
        if (this.claudeBlockIndex.has(key) || this.claudeBlocks.has(key))
          return this.publish();
        const segment = `claude:${messageId}`;
        const nativeId = block.type === 'tool_use' ? string(block.id) : key;
        if (
          nativeId &&
          this.correlations.get(this.scopedId(segment, nativeId))?.final
        )
          return this.publish();
        if (
          block.type === 'tool_use' &&
          nativeId &&
          this.claudeToolIndex.get(nativeId)?.final
        )
          return this.publish();
        const state: ClaudeBlockState = {
          messageId,
          index,
          segment,
          timestamp: this.timestamp(key, event.timestamp),
          block: { ...block },
          stopped: false,
        };
        this.claudeBlocks.set(key, state);
        const keys =
          this.claudeMessageBlocks.get(messageId) ?? new Set<string>();
        keys.add(key);
        this.claudeMessageBlocks.set(messageId, keys);
        this.updateClaudeBlock(state);
      }
    }

    if (event.type === 'content_block_delta' && messageId) {
      const index = finiteTimestamp(event.index) ?? 0;
      const state = this.claudeBlocks.get(`${messageId}:${index}`);
      const delta = record(event.delta);
      if (
        state &&
        delta &&
        !this.claudeBlockIndex.get(`${messageId}:${index}`)?.final
      ) {
        if (delta.type === 'text_delta')
          state.block = {
            ...state.block,
            text: appendText(state.block.text, string(delta.text) ?? ''),
          };
        else if (delta.type === 'thinking_delta')
          state.block = {
            ...state.block,
            thinking: appendText(
              state.block.thinking,
              string(delta.thinking) ?? '',
            ),
          };
        else if (delta.type === 'input_json_delta') {
          const partial = appendText(
            state.block.__canopyPartialJson,
            string(delta.partial_json) ?? '',
          );
          state.block = {
            ...state.block,
            __canopyPartialJson: partial,
            input: partial,
          };
        }
        this.updateClaudeBlock(state);
      }
    }

    if (event.type === 'content_block_stop' && messageId) {
      const index = finiteTimestamp(event.index) ?? 0;
      const state = this.claudeBlocks.get(`${messageId}:${index}`);
      if (
        state &&
        !state.stopped &&
        !this.claudeBlockIndex.get(`${state.messageId}:${state.index}`)
          ?.final &&
        state.block.type !== 'tool_use'
      ) {
        state.stopped = true;
        this.updateClaudeBlock(state);
      }
    }

    if (event.type === 'message_stop' && messageId) {
      (this.claudeMessageBlocks.get(messageId) ?? new Set()).forEach((key) => {
        const state = this.claudeBlocks.get(key);
        if (
          state &&
          !state.stopped &&
          !this.claudeBlockIndex.get(`${state.messageId}:${state.index}`)
            ?.final &&
          state.block.type !== 'tool_use'
        ) {
          state.stopped = true;
          this.updateClaudeBlock(state);
        }
      });
      if (this.claudeCurrentMessageId === messageId)
        this.claudeCurrentMessageId = undefined;
    }

    if (
      event.type === 'assistant' &&
      messageId &&
      Array.isArray(message?.content)
    ) {
      const segment = `claude:${messageId}`;
      message.content.forEach((sourceBlock, index) => {
        const block = parseClaudeAssistantBlocks([sourceBlock])[0];
        if (!block) return;
        if (block.type === 'tool_use') {
          this.updateClaudeTool(block, segment, event.timestamp);
        } else if (isProse(block)) {
          const id = this.scopedId(segment, `${messageId}:${index}`);
          if (this.correlations.get(id)?.final) return;
          this.upsert({
            id,
            role: 'assistant',
            blocks: [block],
            final: true,
            segment,
            timestamp: this.timestamp(id, event.timestamp),
          });
        }
      });
    }

    if (event.type === 'user' && Array.isArray(message?.content)) {
      for (const block of parseClaudeToolResults(message.content)) {
        if (block.type !== 'tool_result') continue;
        const toolId = block.toolUseId;
        const correlation = this.claudeToolIndex.get(toolId);
        if (correlation?.final) continue;
        const state = correlation
          ? this.claudeTools.get(correlation.id)
          : undefined;
        if (state) {
          if (state.final) continue;
          const useBlock = state.blocks.find(
            (candidate) => candidate.type === 'tool_use',
          );
          state.blocks = useBlock ? [useBlock, block] : [block];
          state.final = true;
          this.publishClaudeTool(state);
        } else {
          const segment = `claude:${messageId ?? 'unpaired'}`;
          const id = this.scopedId(segment, toolId);
          const tool: ClaudeToolState = {
            id,
            nativeId: toolId,
            segment,
            timestamp: this.timestamp(id, event.timestamp),
            blocks: [block],
            final: true,
          };
          this.claudeTools.set(id, tool);
          this.publishClaudeTool(tool);
        }
      }
    }

    return this.publish();
  }

  private updateClaudeBlock(state: ClaudeBlockState): void {
    const parsed = parseClaudeAssistantBlocks([state.block]);
    const block = parsed[0];
    if (!block) return;
    if (block.type === 'tool_use') {
      this.updateClaudeTool(block, state.segment, state.timestamp);
      const correlation = this.claudeToolIndex.get(block.toolUseId);
      if (correlation) this.linkClaudeBlock(state, correlation);
      return;
    }
    if (!isProse(block)) return;
    const nativeId = `${state.messageId}:${state.index}`;
    const id = this.scopedId(state.segment, nativeId);
    const correlation = this.upsert({
      id,
      role: 'assistant',
      blocks: [block],
      final: state.stopped,
      segment: state.segment,
      timestamp: this.timestamp(id, state.timestamp),
    });
    if (correlation) this.linkClaudeBlock(state, correlation);
  }

  private linkClaudeBlock(
    state: ClaudeBlockState,
    correlation: ItemCorrelation,
  ): void {
    const key = `${state.messageId}:${state.index}`;
    correlation.claudeBlockKeys.add(key);
    this.claudeBlockIndex.set(key, correlation);
  }

  private updateClaudeTool(
    block: Extract<PersistedChatBlock, { type: 'tool_use' }>,
    segment: string,
    timestamp?: unknown,
  ): void {
    const id = this.scopedId(segment, block.toolUseId);
    if (
      this.correlations.get(id)?.final ||
      this.claudeToolIndex.get(block.toolUseId)?.final
    )
      return;
    const state = this.claudeTools.get(id) ?? {
      id,
      nativeId: block.toolUseId,
      segment,
      timestamp: this.timestamp(id, timestamp),
      blocks: [],
      final: false,
    };
    if (state.final) return;
    state.blocks = [block];
    this.claudeTools.set(id, state);
    this.publishClaudeTool(state);
  }

  private publishClaudeTool(state: ClaudeToolState): void {
    const correlation = this.upsert({
      id: state.id,
      role: 'assistant',
      blocks: state.blocks,
      final: state.final,
      segment: state.segment,
      timestamp: state.timestamp,
    });
    if (correlation) this.claudeToolIndex.set(state.nativeId, correlation);
  }

  private async codexEvent(
    event: {
      method: string;
      params: Record<string, unknown>;
    },
    publishChanges = true,
  ): Promise<readonly DelegationTranscriptChange[]> {
    if (this.finished) return [];
    const { method, params } = event;
    const threadId = string(params.threadId) ?? 'codex-thread';
    const turn = record(params.turn);
    const explicitTurnId = string(params.turnId) ?? string(turn?.id);
    const turnId =
      explicitTurnId ??
      (method === 'turn/started'
        ? undefined
        : this.codexThreads.get(threadId)) ??
      `unidentified-${++this.unidentifiedTurn}`;
    const segment = `codex:${threadId}:${turnId}`;
    let segmentState = this.codexSegments.get(segment);
    const incoming = record(params.item);
    const nativeItemId = string(incoming?.id) ?? string(params.itemId);
    if (segmentState?.closed) {
      // Thread-level events (status, usage) legitimately follow a turn's end.
      if (nativeItemId) segmentState.drops += 1;
      return [];
    }
    if (!segmentState) {
      segmentState = {
        threadId,
        turnId,
        closed: false,
        drops: 0,
        terminalItems: [],
      };
      this.codexSegments.set(segment, segmentState);
      this.codexThreads.set(threadId, turnId);
    } else if (method === 'turn/started')
      this.codexThreads.set(threadId, turnId);
    if (method === 'turn/completed') {
      segmentState.terminalItems = Array.isArray(turn?.items)
        ? turn.items.flatMap((value) => {
            const item = record(value);
            return item ? [item] : [];
          })
        : [];
      return [];
    }
    const publish = (): readonly DelegationTranscriptChange[] =>
      publishChanges ? this.publish() : [];
    if (!nativeItemId) return publish();
    const itemKey = `${threadId}:${turnId}:${nativeItemId}`;
    if (this.correlations.get(this.scopedId(segment, nativeItemId))?.final)
      return publish();
    const prior = this.codexItems.get(itemKey);
    if (CODEX_DELTA_METHODS.has(method)) {
      const delta = string(params.delta);
      if (!prior || !delta) return publish();
      if (method === 'item/agentMessage/delta')
        this.codexItems.set(itemKey, {
          ...prior,
          text: appendText(prior.text, delta),
        });
      else if (
        method === 'item/reasoning/summaryTextDelta' ||
        method === 'item/reasoning/textDelta'
      ) {
        const field =
          method === 'item/reasoning/textDelta' ? 'content' : 'summary';
        const current = Array.isArray(prior[field])
          ? prior[field].filter(
              (value): value is string => typeof value === 'string',
            )
          : [];
        const slot =
          method === 'item/reasoning/textDelta'
            ? params.contentIndex
            : params.summaryIndex;
        const index =
          typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0
            ? slot
            : Math.max(current.length - 1, 0);
        while (current.length <= index) current.push('');
        current[index] = appendText(current[index], delta);
        this.codexItems.set(itemKey, { ...prior, [field]: current });
      } else if (prior.type === 'commandExecution') {
        await this.appendCommandOutput(itemKey, delta);
      }
    } else if (
      incoming &&
      (method === 'item/started' ||
        method === 'item/updated' ||
        method === 'item/completed')
    ) {
      if (incoming.type === 'commandExecution') {
        const output = this.commandOutputs.get(itemKey) ?? {};
        this.commandOutputs.set(itemKey, output);
        if (typeof incoming.aggregatedOutput === 'string') {
          if (output.spool) {
            const spool = output.spool;
            await this.storage(() => spool.discard());
            output.spool = undefined;
          }
          output.seed = incoming.aggregatedOutput;
        }
        // Native metadata must never retain the seed or accumulated deltas.
        const { aggregatedOutput: ignored, ...metadata } = incoming;
        void ignored;
        this.codexItems.set(itemKey, metadata);
      } else this.codexItems.set(itemKey, incoming);
    } else return publish();

    const nativeItem = this.codexItems.get(itemKey);
    if (nativeItem) {
      const final = method === 'item/completed';
      const materialized =
        final && nativeItem.type === 'commandExecution'
          ? {
              ...nativeItem,
              aggregatedOutput: await this.finalCommandOutput(itemKey),
            }
          : nativeItem;
      this.projectCodexItem(
        materialized,
        itemKey,
        segment,
        final,
        params.timestamp,
      );
    }
    return publish();
  }

  private async appendCommandOutput(key: string, delta: string): Promise<void> {
    const output = this.commandOutputs.get(key) ?? {};
    this.commandOutputs.set(key, output);
    const owner = this.options.spools;
    if (!owner) {
      output.seed = appendText(output.seed, delta);
      return;
    }
    if (!output.spool) {
      output.spool = await this.storage(() => owner.acquire(key));
      if (output.seed) {
        const spool = output.spool;
        const seed = output.seed;
        await this.storage(() => spool.append(seed));
      }
      output.seed = undefined;
    }
    const spool = output.spool;
    await this.storage(() => spool.append(delta));
  }

  private async finalCommandOutput(key: string): Promise<string> {
    const output = this.commandOutputs.get(key);
    if (!output) return '';
    let text = output.seed ?? '';
    if (output.spool) {
      const spool = output.spool;
      text = await this.storage(() => spool.read());
      await this.storage(() => spool.discard());
    }
    // The exact materialized output now belongs only to the final row.
    this.commandOutputs.delete(key);
    return text;
  }

  private projectCodexItem(
    native: Record<string, unknown>,
    key: string,
    segment: string,
    final: boolean,
    timestamp?: unknown,
  ): void {
    const projected = projectCodexThreadItem(native);
    const nativeId = string(projected?.id);
    if (!projected || !nativeId) return;
    const neutral = codexNeutralItemBlocks(
      projected,
      final ? 'item.completed' : 'item.updated',
    );
    if (!neutral) return;
    const id = this.scopedId(segment, nativeId);
    this.codexItemKeys.set(id, key);
    this.upsert({
      id,
      role: neutral.role,
      blocks: neutral.blocks,
      final,
      segment,
      timestamp: this.items.get(id)?.timestamp ?? this.timestamp(id, timestamp),
    });
  }

  private async settleCodexTurn(
    settlement: Pick<DelegationCodexTurnSettlement, 'threadId' | 'turnId'>,
    publishChanges = true,
  ): Promise<readonly DelegationTranscriptChange[]> {
    const turnId =
      settlement.turnId ?? this.codexThreads.get(settlement.threadId);
    if (!turnId) return [];
    const segment = `codex:${settlement.threadId}:${turnId}`;
    const state = this.codexSegments.get(segment);
    if (!state || state.closed) return [];
    for (const item of state.terminalItems) {
      await this.codexEvent(
        {
          method: 'item/completed',
          params: {
            threadId: state.threadId,
            turnId: state.turnId,
            item:
              item.status === 'inProgress'
                ? { ...item, status: 'failed' }
                : item,
          },
        },
        false,
      );
    }
    state.terminalItems = [];
    for (const [id, item] of Array.from(this.items)) {
      if (item.segment !== segment || item.final) continue;
      const key = this.codexItemKeys.get(id);
      const native = key ? this.codexItems.get(key) : undefined;
      if (native && key) {
        const output =
          native.type === 'commandExecution'
            ? { aggregatedOutput: await this.finalCommandOutput(key) }
            : {};
        this.projectCodexItem(
          {
            ...native,
            ...output,
            ...(native.status === 'inProgress' ? { status: 'failed' } : {}),
          },
          key,
          segment,
          true,
        );
      } else this.upsert({ ...item, final: true });
    }
    state.closed = true;
    return publishChanges
      ? this.changesFromRows(this.builder.take('final'))
      : [];
  }

  private patchEvent(value: unknown): readonly DelegationTranscriptChange[] {
    if (this.finished) return [];
    const event = record(value);
    if (!event) return [];
    const messageId = string(event.messageId);
    if (!messageId) return [];
    const provider = string(event.provider) ?? 'assistant';
    const segment = `${provider}:${messageId}`;
    const messageKey = this.scopedId(segment, messageId);
    const previous = this.patchMessages.get(messageKey);
    const projected = projectDelegationAssistantPatch(previous, event, segment);
    if (!projected) return [];
    this.patchMessages.set(messageKey, projected.message);
    for (const item of projected.items)
      this.upsert({ ...item, id: this.scopedId(segment, item.id) });
    return this.publish();
  }

  /** Project an unfinished Codex item's buffered state as its interrupted end. */
  private interruptedCodexItem(
    id: string,
  ): Pick<DelegationLogicalItem, 'role' | 'blocks'> | undefined {
    const key = this.codexItemKeys.get(id);
    const native = key ? this.codexItems.get(key) : undefined;
    if (!native) return undefined;
    // A command still running when the stream ended did not succeed.
    const projected = projectCodexThreadItem(
      native.status === 'inProgress' ? { ...native, status: 'failed' } : native,
    );
    return projected
      ? codexNeutralItemBlocks(projected, 'item.completed')
      : undefined;
  }

  private finishItems(): readonly DelegationTranscriptChange[] {
    if (this.finished) return [];
    this.finished = true;
    this.items.forEach((item, id) => {
      if (!item.final) {
        const final = {
          ...item,
          ...this.interruptedCodexItem(id),
          final: true,
        };
        this.items.set(id, final);
        this.builder.observe(final);
        const correlation = this.correlations.get(id);
        if (correlation) correlation.final = true;
      }
    });
    this.patchMessages.clear();
    return this.changesFromRows(this.builder.take('all'));
  }
}
