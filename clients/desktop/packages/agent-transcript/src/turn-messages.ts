import type { ApprovalSafetyDeniedInfo } from '@canopy/protocol/approvals';
import type {
  ChatWatcherFiredInfo,
  ToolInterruption,
  TurnOutcomeCounts,
} from '@canopy/protocol/remote-control/shell';
import type { AgentSentInfo } from '@canopy/protocol/remote-control/shell/external-agent-sender';
import type {
  AccountProxySwitchBlock,
  AgentUsage,
  ClaudeModsSkippedBlock,
  ClaudeTerminalSyncWarningBlock,
  CodexAgentState,
  CompactionInfoBlock,
  FileReference,
  PersistedChatBlock,
  PersistedUserMessageSource,
} from './types';
import type { ChangedFileInfo, TurnDiffTreeRef } from './changed-files';

export interface TurnToolResult {
  output: string;
  isError: boolean;
  interruption?: ToolInterruption;
}

export type TurnBlock =
  | ApprovalSafetyDeniedInfo
  | (Extract<PersistedChatBlock, { type: 'delegated_agent_call' }> & {
      subBlocks: TurnBlock[];
    })
  | Extract<PersistedChatBlock, { type: 'text' }>
  | Extract<PersistedChatBlock, { type: 'mcp_activation' }>
  | { type: 'file_references'; references: FileReference[] }
  | { type: 'image'; path: string; alt: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_use';
      toolUseId: string;
      toolName: string;
      input: string;
      result?: TurnToolResult;
    }
  | {
      type: 'turn_timer';
      /** Canonical execution identity; absent on legacy timers. */
      turnId?: string;
      /** The canonical execution's prompt; absent when it has no prompt. */
      userMessageId?: string;
      /** The canonical execution's recorded end; absent when unknown. */
      outcome?: 'completed' | 'cancelled' | 'failed';
      startedAt?: number;
      pausedAt?: number | null;
      resumedAt?: number | null;
      /** Active prompt identities holding this timer pause. */
      pauseOwnerIds?: string[];
      accumulatedPausedDurationMs?: number;
      completedAt: number | null;
    }
  | { type: 'hook_info'; triggerName: string; timestamp: number }
  | Extract<PersistedChatBlock, { type: 'wake_boundary' }>
  | { type: 'automation_info'; activityName?: string; timestamp: number }
  // Compaction marker (mirrors {@link CompactionInfoBlock} from persisted
  // transcripts). Included so the renderer's `DisplayMessage[]` →
  // `TurnMessage[]` conversion does not have to filter the variant out;
  // it is treated as a system block by turn grouping.
  | CompactionInfoBlock
  | ClaudeTerminalSyncWarningBlock
  // Where the account proxy moved the chat to another account (CAN-4021).
  | AccountProxySwitchBlock
  | ClaudeModsSkippedBlock
  | {
      type: 'rebase_resolution_info';
      kind: 'rebase_conflict' | 'stash_pop_conflict';
      repoName: string;
      branchName: string;
      timestamp: number;
    }
  | {
      type: 'builtin_gh_chat_info';
      kind:
        | 'merge_conflict'
        | 'review_comment_triage'
        | 'ci_check_fix'
        | 'merge_queue';
      repoName?: string;
      branchName?: string;
      timestamp: number;
    }
  | { type: 'pending_setup_info'; timestamp: number }
  | {
      // Approval released by a mode widening rather than a click (CAN-3083).
      // Mirrors the `approval_resolution_info` persisted variant.
      type: 'approval_resolution_info';
      timestamp: number;
      resolvedBy: 'mode-change';
      mode: 'ask' | 'auto' | 'full-access';
      previousMode?: 'ask' | 'auto' | 'full-access';
      titles: string[];
    }
  | {
      type: 'revert_info';
      timestamp: number;
      revertedFromMessageId: string;
      revertedFromTimestamp: number;
      files: ChangedFileInfo[];
      totalInsertions: number;
      totalDeletions: number;
      treeRefs?: TurnDiffTreeRef[];
      attachmentPath?: string;
    }
  | {
      type: 'agent';
      toolUseId: string;
      subagentType: string;
      description: string;
      prompt: string;
      runInBackground: boolean;
      result?: TurnToolResult;
      taskOutputResult?: TurnToolResult;
      subBlocks: TurnBlock[];
      usage?: AgentUsage;
    }
  // Workflow tool display variant. Mirrors the renderer's `workflow`
  // DisplayBlock so the `DisplayMessage[]` → `TurnMessage[]` conversion does
  // not have to filter the variant out.
  | {
      type: 'workflow';
      toolUseId: string;
      workflowName: string;
      summary: string;
      runId?: string;
      transcriptDir?: string;
      result?: TurnToolResult;
    }
  // Codex-native subagent display variant. Mirrors the renderer's
  // `codex_agent` DisplayBlock so turn-summary counting and structural diff
  // (`incremental-turn-groups`) can treat Codex agents the same way as
  // Claude `agent` rows. Counted as one `agent` in `computeTurnSummary` —
  // see Phase F3 §5.
  //
  // The raw `codex_agent_call` shape is intentionally NOT in this union: by
  // the time a TurnMessage is built the block has been folded into this
  // display variant by `mergeToolResults`, so widening the union to the raw
  // shape would silently break the DisplayMessage → TurnMessage conversion.
  | {
      type: 'codex_agent';
      agentBlockId: string;
      callId: string;
      status: string;
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt: string;
      description: string;
      displayName: string;
      model?: string;
      reasoningEffort?: string;
      agentsStates: Record<string, CodexAgentState>;
      subBlocks: TurnBlock[];
      usage?: AgentUsage;
    };

export interface TurnMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: TurnBlock[];
  timestamp: number;
  /**
   * Present on user messages generated by a fired Canopy watcher. Mirrors
   * `DisplayMessage.watcherFired` (the display objects flow into turn groups
   * unchanged) so turn-level logic — e.g. transcript sticky sections, which
   * treat watcher messages as part of the preceding turn rather than as
   * sticky user messages — can key off it without a cast.
   */
  watcherFired?: ChatWatcherFiredInfo;
  /** Display-only attribution for a user message accepted from another agent. */
  agentSent?: AgentSentInfo;
  userMessageSource?: PersistedUserMessageSource;
}

export interface TurnGroup {
  kind: 'turn-group';
  userMessage: TurnMessage;
  assistantMessages: TurnMessage[];
  timerMessage: TurnMessage;
  isComplete: boolean;
  /**
   * Earlier executions' finished timer rows folded into this turn instead of
   * shown as their own rows. Lookups by message id (a fork point, a jump
   * target) still find the turn through them.
   */
  foldedTimerIds?: readonly string[];
}

export interface StandaloneTurnMessage {
  kind: 'standalone';
  message: TurnMessage;
}

export type TurnGroupOrMessage = TurnGroup | StandaloneTurnMessage;

// Re-export shared registry so consumers who only need category mapping can
// reach the display names / provider lookup without importing a second file.

export interface TurnOutcomeStep {
  toolUseId: string;
  outcome: keyof TurnOutcomeCounts;
}
