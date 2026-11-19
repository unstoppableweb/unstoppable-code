import type { RemoteControlChatPart } from '@canopy/protocol/remote-control/shell';
import type { AgentSentInfo } from '@canopy/protocol/remote-control/shell/external-agent-sender';
import type { DisplayBlock, DisplayMessage } from '../../message-display';
import type { PersistedChatMessage } from '../../types';

/** The parent's task or prompt that started a run. */
export interface SubagentChatTaskItem {
  readonly kind: 'task';
  readonly key: string;
  readonly sender: string;
  readonly text: string;
  /** Prompt text the run's authored messages already show. */
  readonly shownTexts?: readonly string[];
}

interface SubagentChatDividerItem {
  readonly kind: 'divider';
  readonly key: string;
  readonly runGeneration: number;
}

interface SubagentChatFollowUpItem {
  readonly kind: 'follow_up';
  readonly key: string;
  readonly sender: string;
  readonly text: string;
}

interface SubagentChatUserItem {
  readonly kind: 'user';
  readonly key: string;
  readonly text: string;
  readonly steering: boolean;
  /** Display attribution when another agent sent this message. */
  readonly agentSent?: AgentSentInfo;
}

interface SubagentChatBlocksItem {
  readonly kind: 'blocks';
  readonly key: string;
  readonly displayMessage: DisplayMessage;
  readonly blocks: readonly DisplayBlock[];
}

interface SubagentChatTruncatedItem {
  readonly kind: 'truncated';
  readonly key: string;
  /** Earlier child parts the producer dropped; 0 when unknown. */
  readonly omittedSubBlocks: number;
}

interface SubagentChatPartItem {
  readonly kind: 'part';
  readonly key: string;
  readonly part: RemoteControlChatPart;
}

/** One row of a transcript built from persisted chat messages (desktop). */
export type SubagentChatTranscriptItem =
  | SubagentChatTaskItem
  | SubagentChatDividerItem
  | SubagentChatFollowUpItem
  | SubagentChatUserItem
  | SubagentChatBlocksItem;

/** One row of a transcript built from Portal chat parts (Portal, cloud). */
export type RemoteControlSubagentChatTranscriptItem =
  | SubagentChatTaskItem
  | SubagentChatDividerItem
  | SubagentChatFollowUpItem
  | SubagentChatUserItem
  | SubagentChatTruncatedItem
  | SubagentChatPartItem;

/** Any transcript row, for helpers shared by both builders. */
export type AnySubagentChatTranscriptItem =
  | SubagentChatTranscriptItem
  | RemoteControlSubagentChatTranscriptItem;

export interface SubagentChatTranscript {
  readonly items: readonly SubagentChatTranscriptItem[];
  /** True when the earliest loaded record proves this run has older content. */
  readonly missingBeginning: boolean;
}

export interface RemoteControlSubagentChatTranscript {
  readonly items: readonly RemoteControlSubagentChatTranscriptItem[];
}

/** Root-chat and paged messages that can supply one managed run. */
export interface SubagentTranscriptRunSource {
  readonly runGeneration: number;
  readonly agentBlockId?: string;
  readonly prompt?: string;
  readonly pagedMessages?: readonly PersistedChatMessage[];
  /** The paged rows are the run's latest rows; drop the root chat's copy. */
  readonly replacesRootRows?: boolean;
}

/**
 * One observed managed-run card in Portal parts. A run observed more than
 * once contributes one entry per observation; the latest wins.
 */
export interface RemoteControlSubagentRunObservation {
  readonly runGeneration: number;
  readonly prompt?: string;
  readonly finalText?: string;
  /** Child parts in transcript order. */
  readonly subBlocks: readonly RemoteControlChatPart[];
  /** True when the producer dropped earlier child parts. */
  readonly subBlocksTruncated: boolean;
  /** How many earlier child parts were dropped; 0 when unknown. */
  readonly omittedSubBlocks: number;
}
