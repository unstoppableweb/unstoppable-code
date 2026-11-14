import type {
  AutoResumeMetadata,
  ToolInterruption,
} from '@canopy/protocol/portal';
import type {
  AgentUsage,
  ChatWatcherFiredInfo,
  CodexAgentState,
  DelegatedAgentCallBlock,
  PersistedChatBlock,
  PersistedUserMessageSource,
  PersistedToolOutputReference,
  PersistedVisualReference,
} from './types';
import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import type { AgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';

export type ToolResult = {
  output: string;
  /** Persisted block identity used to authorize reads of referenced artifacts. */
  messageId?: string;
  toolUseId?: string;
  fullOutputRef?: PersistedToolOutputReference;
  visualRef?: PersistedVisualReference;
  outputTruncated?: true;
  isError: boolean;
  interruption?: ToolInterruption;
  /**
   * Structured authentication failure this errored result explains
   * (CAN-1814). Threaded from the persisted `tool_result` block's
   * `authFailure` field by `message-transforms.ts`. Structured data wins over
   * the legacy `isMcpConnectionError` regex fallback when present — see
   * `ToolCallBlock.tsx`.
   */
  authFailure?: AuthDependencyFailure;
  /**
   * Every dependency this turn is blocked on, when more than one was claimed
   * (CAN-1814 PR 2). Threaded from the persisted block's `authFailures` field
   * alongside `authFailure`; read both through `readAuthDependencyFailures`.
   */
  authFailures?: AuthDependencyFailure[];
};

interface DisplayBlockProvenance {
  /** Original host-generated provenance retained after nested-message folding. */
  isSystemMessage?: boolean;
}

export type DisplayBlock = (
  | Exclude<
      PersistedChatBlock,
      | { type: 'tool_use' }
      | { type: 'tool_result' }
      | { type: 'codex_agent_call' }
      | { type: 'delegated_agent_call' }
    >
  | (DelegatedAgentCallBlock & { subBlocks: DisplayBlock[] })
  | {
      type: 'tool_use';
      toolUseId: string;
      toolName: string;
      input: string;
      result?: ToolResult;
      // For `SendMessage`: the recipient agent id (`to`) resolved to a friendly
      // agent/task name from a prior `Task`/`Agent` dispatch in this transcript.
      // Absent when the recipient can't be resolved (renderer falls back to the
      // raw id).
      resolvedRecipient?: string;
    }
  | {
      type: 'agent';
      toolUseId: string;
      subagentType: string;
      description: string;
      prompt: string;
      runInBackground: boolean;
      result?: ToolResult;
      taskOutputResult?: ToolResult;
      subBlocks: DisplayBlock[];
      usage?: AgentUsage;
    }
  | {
      type: 'workflow';
      toolUseId: string;
      workflowName: string;
      summary: string;
      runId?: string;
      transcriptDir?: string;
      result?: ToolResult;
    }
  // Codex-native subagent display block. The persisted `codex_agent_call`
  // is folded into this richer shape by `message-transforms` so the renderer
  // can reuse the existing `AgentBlock` UX without committing to Claude's
  // tool-use lifecycle (no paired tool_result, no taskOutput follow-up).
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
      subBlocks: DisplayBlock[];
      usage?: AgentUsage;
    }
) &
  DisplayBlockProvenance;

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: DisplayBlock[];
  timestamp: number;
  attachmentPaths?: string[];
  inputMode?: 'typed' | 'voice';
  /** Present when a fired Canopy watcher generated this user message. */
  watcherFired?: ChatWatcherFiredInfo;
  /**
   * Validated display attribution for a message another agent submitted: a
   * Canopy chat or an external MCP agent.
   */
  agentSent?: AgentSentInfo;
  userMessageSource?: PersistedUserMessageSource;
  autoResume?: AutoResumeMetadata;
  /** A prompt whose turn was cancelled before it ran, such as one deleted from a cloud chat's queue (CAN-6689). */
  cancelled?: true;
}
