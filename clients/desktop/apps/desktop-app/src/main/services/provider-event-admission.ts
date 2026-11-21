/**
 * What canonical admission of one provider event proved about its tool
 * blocks, returned after the event's commit is durable. Internal to main:
 * the Portal projection turns it into a part's occurrence and output locator,
 * and nothing here (no body or host path) is serialized. A committed visual's
 * reference alone also rides the event's `chat:event` delivery, as the history
 * read already serves it.
 */
import type { PersistedVisualReference } from '@canopy/agent-transcript/types';
import {
  CANOPY_TOOL_VISUALS_FIELD,
  type RuntimeToolVisual,
} from '@canopy/agent-transcript/remote-control/runtime-chat-projection';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import type {
  ChatPickupVerdict,
  ProviderEventIngestOutcome,
} from './chat-state-service';

/** Tool mappings one admission may carry; the excess stays preview-only. */
export const PROVIDER_EVENT_ADMISSION_MAX_TOOLS = 64;
/** Serialized size bound of one admission's mappings. */
export const PROVIDER_EVENT_ADMISSION_MAX_BYTES = 65_536;
/** Occurrences one dispatched turn retains to stamp later frames. */
export const PRIMARY_TOOL_CORRELATION_MAX_ENTRIES = 256;
/** Serialized size bound of one turn's retained occurrences. */
export const PRIMARY_TOOL_CORRELATION_MAX_BYTES = 262_144;

/** A canonical block: its row and absolute logical block ordinal. */
export interface CanonicalBlockAddress {
  readonly rowId: string;
  readonly blockOrdinal: number;
}

export interface ToolOccurrenceAdmission {
  /**
   * The provider event's own position for the tool block (Claude content
   * index, Codex normalized item and role), so the live projection of the
   * same event can find it. Never a provider tool id alone.
   */
  readonly sourceToken: string;
  /** `remoteControlToolOccurrenceId` of the call, or of an unpaired result. */
  readonly occurrenceId: string;
  readonly call?: CanonicalBlockAddress;
  /** Present only for a terminal result. */
  readonly result?: CanonicalBlockAddress & {
    /** Stored apart, or longer than the Portal preview before shortening. */
    readonly needsRead: boolean;
    /** The visual this commit promoted for the result, as stored. */
    readonly visual?: PersistedVisualReference;
  };
}

/**
 * Add to each admitted result the visual reference its committed row stores.
 * The commit record publishes each upserted row as stored, after visual
 * promotion; a row stored apart (`blocksRef`) is skipped, and its visual shows
 * once the history read returns it.
 */
export function withCommittedToolVisuals(
  tools: readonly ToolOccurrenceAdmission[],
  chatId: string,
  mutations: readonly ChatCoreMutation[],
): ToolOccurrenceAdmission[] {
  return tools.map((tool) => {
    const result = tool.result;
    if (!result) return tool;
    const row = mutations.find(
      (mutation) =>
        mutation.type === 'message.upserted' &&
        mutation.chatId === chatId &&
        mutation.message.id === result.rowId,
    );
    if (row?.type !== 'message.upserted' || row.message.blocksRef) return tool;
    const block = row.message.blocks[result.blockOrdinal];
    return block?.type === 'tool_result' && block.visualRef
      ? { ...tool, result: { ...result, visual: block.visualRef } }
      : tool;
  });
}

/**
 * The event as delivered on `chat:event`: the provider's data with the visuals
 * its commit stored, keyed by each result's source token. Any value the
 * provider data carried under the field is dropped, so only main names one.
 */
export function withDeliveredToolVisuals(
  data: unknown,
  result: ProviderEventIngestResult,
): unknown {
  if (!isEventRecord(data)) return data;
  const visuals: RuntimeToolVisual[] = [];
  if (result.outcome === 'applied')
    for (const tool of result.admission?.tools ?? [])
      if (tool.result?.visual)
        visuals.push({
          sourceToken: tool.sourceToken,
          messageId: tool.result.rowId,
          visual: tool.result.visual,
        });
  if (visuals.length === 0 && !(CANOPY_TOOL_VISUALS_FIELD in data)) return data;
  const rest = Object.fromEntries(
    Object.entries(data).filter(([key]) => key !== CANOPY_TOOL_VISUALS_FIELD),
  );
  return visuals.length > 0
    ? { ...rest, [CANOPY_TOOL_VISUALS_FIELD]: visuals }
    : rest;
}

function isEventRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ProviderEventAdmission {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly mutationId: string;
  readonly turnUserMessageId?: string;
  /** The returned commit revision, never the reducer's provisional one. */
  readonly revision: number;
  /** At most {@link PROVIDER_EVENT_ADMISSION_MAX_TOOLS}, in event order. */
  readonly tools: readonly ToolOccurrenceAdmission[];
}

/** `pickup` answers a starting input pickup; `admission` an applied event. */
export type ProviderEventIngestResult =
  | {
      readonly outcome: 'applied';
      readonly admission?: ProviderEventAdmission;
      readonly pickup?: ChatPickupVerdict;
    }
  | {
      readonly outcome: Exclude<ProviderEventIngestOutcome, 'applied'>;
      readonly pickup?: ChatPickupVerdict;
    };

/**
 * Read a before-event hook's answer. Legacy hooks resolve `false` to hide a
 * duplicate or stale event and `true` or nothing to deliver it.
 */
export function normalizeProviderEventIngestResult(
  value: boolean | void | ProviderEventIngestResult,
): ProviderEventIngestResult {
  if (value === false) return { outcome: 'not-applied' };
  if (value === true || value === undefined) return { outcome: 'applied' };
  return value;
}

/** Whether the event is live: applied or activity-only, as today. */
export function isProviderEventDeliverable(
  result: ProviderEventIngestResult,
): boolean {
  return result.outcome !== 'not-applied';
}
