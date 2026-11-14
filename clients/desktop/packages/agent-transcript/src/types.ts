import type {
  AutoResumeMetadata,
  ToolInterruption,
} from '@canopy/protocol/portal';
export type {
  AutoResumeMetadata,
  AutoResumeReason,
  ToolInterruption,
  ToolInterruptionReason,
} from '@canopy/protocol/portal';
import type { ApprovalSafetyDeniedInfo } from '@canopy/protocol/approvals';
import type { OpenCodeReportedUsage } from '@canopy/protocol/portal';
import type { ReportedTurnUsage } from '@canopy/protocol/portal';
import type { AgentArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import type {
  AgentDelegationSnapshot,
  DelegationMessageAuthor,
} from '@canopy/protocol/delegation';
import type { PersistedToolOutputReference } from '@canopy/protocol/canopy-core/core';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import type { AgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';
import type { ClaudeAiCreditsFallbackErrorCode } from '@canopy/protocol/llm-gateway';
import type { CursorReportedUsage } from './lib/cursor-usage';
/**
 * Serializable transcript/chat data types shared by the desktop app and the
 * hosted web portal. Extracted from `@canopy/desktop-shared/types` so the
 * agent-transcript parser and its display transforms live in a browser-safe,
 * protocol-only package. `@canopy/desktop-shared` re-exports every type here so
 * there is exactly one source of truth and desktop importers need no edits.
 *
 * This module must stay pure: no Node/Electron/React/Prisma/Next imports and no
 * imports from `@canopy/desktop-shared`.
 */

import type {
  AuthDependencyFailure,
  CodexAccountModelAccessFailure,
} from '@canopy/protocol/auth-recovery';
import type { ChatWatcherFiredInfo } from '@canopy/protocol/portal';
export type {
  ChatAgentSentInfo,
  ChatWatcherFiredInfo,
} from '@canopy/protocol/portal';

/** Model identifier string (canonical model IDs, aliases, and Ollama IDs). */
export type ChatModel = string;

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

export type AgentProviderType =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'opencode'
  | 'copilot'
  | 'antigravity';

export type ChatInterfaceMode = 'canopy' | 'claude-code' | 'auto';

// ---------------------------------------------------------------------------
// File references / attachments
// ---------------------------------------------------------------------------

export interface FileReference {
  displayPath: string;
  absolutePath: string;
  repoName?: string;
  /** Opaque host-defined mention kind used by composer send-time handling. */
  kind?: string;
  /** Start offset of the pill in the accompanying serialized text. */
  textStart?: number;
}

/**
 * All attachment prompt kinds. Every filter that routes `promptKind`-bearing
 * attachment metadata or prompt contexts must use
 * {@link isChatAttachmentPromptKind} instead of hardcoded string comparisons so
 * adding a new kind flows through send, requeue/restore, and validation paths.
 */
export const CHAT_ATTACHMENT_PROMPT_KINDS = [
  'in-app-browser-resource',
  'linear-ticket',
] as const;

export type ChatAttachmentPromptKind =
  (typeof CHAT_ATTACHMENT_PROMPT_KINDS)[number];

export function isChatAttachmentPromptKind(
  value: unknown,
): value is ChatAttachmentPromptKind {
  return CHAT_ATTACHMENT_PROMPT_KINDS.some((kind) => kind === value);
}

export interface ChatAttachmentPromptContext {
  attachmentPath: string;
  promptKind: ChatAttachmentPromptKind;
}

// ---------------------------------------------------------------------------
// Diff / changed-file metadata (used by the revert_info block)
// ---------------------------------------------------------------------------

export type ChangedFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'type-changed'
  | 'untracked'
  | 'unknown';

export interface ChangedFileInfo {
  path: string;
  status: ChangedFileStatus;
  insertions: number;
  deletions: number;
  previousPath?: string;
  repoId?: string;
  repoName?: string;
}

export interface TurnDiffTreeRef {
  startTree: string;
  endTree: string;
  repoId?: string;
  startHeadCommitSha?: string;
}

// ---------------------------------------------------------------------------
// Todo items
// ---------------------------------------------------------------------------

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface ChatTabUsage {
  /** Per-turn snapshot; null means this turn has no valid report. */
  reportedTurnUsage?: ReportedTurnUsage | null;
  /** OpenCode's latest reported turn and context; never account spend. */
  opencodeReportedUsage?: OpenCodeReportedUsage;
  /** Cursor's latest response report; never interpreted as cumulative totals. */
  cursorReportedUsage?: CursorReportedUsage;
  /** Current context window fill — input_tokens + cache_read + cache_creation from the latest assistant message */
  contextTokens: number;
  /** Max context window size from the SDK's modelUsage */
  contextWindow: number;
  /** Max output tokens from the SDK's modelUsage */
  maxOutputTokens: number;
  /** Cumulative session cost in USD */
  totalCostUsd: number;
  /** Cumulative input tokens */
  inputTokens: number;
  /** Cumulative output tokens */
  outputTokens: number;
  /** Cumulative cache read input tokens */
  cacheReadInputTokens: number;
  /** Cumulative cache creation input tokens */
  cacheCreationInputTokens: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Total API duration in milliseconds */
  durationApiMs: number;
  /** Number of turns completed */
  numTurns: number;
  /** Model name string from the last assistant message */
  model: string;
}

/** Per-agent usage tracked from sub-agent events. */
export interface AgentUsage {
  /** Latest context fill (input + cache_read + cache_creation from most recent event) */
  contextTokens: number;
  /** Context window size for the agent's model (default 200k) */
  contextWindow: number;
  /** Accumulated output tokens across all API calls */
  outputTokens: number;
  /** Accumulated cache read input tokens */
  cacheReadInputTokens: number;
  /** Accumulated cache creation input tokens */
  cacheCreationInputTokens: number;
  /** Number of API calls (assistant events) */
  apiCalls: number;
  /** Number of tool calls made by this agent */
  toolUses: number;
  /** Duration in milliseconds (from task_notification if available) */
  durationMs: number;
  /** Model name from the latest assistant event */
  model: string;
}

export interface LlmProviderUsageLimitBannerState {
  provider: 'claude' | 'codex';
  message: string;
  /** Event timestamp (ms since epoch) when the usage limit was detected. */
  detectedAt: number;
  /** Provider request id, when available. */
  requestId?: string;
  /**
   * Stable de-dupe key. Prefers the assistant event's request id; otherwise a
   * stable string derived from `detectedAt` + message. A later rate-limit event
   * with a different `dismissKey` re-shows the banner.
   */
  dismissKey: string;
  /**
   * Provider-reported reset time (ms since epoch) for the exhausted quota
   * window, when available (currently populated for Codex from
   * `RateLimitWindow.resetsAt`). Used to render "until your quota recharges"
   * copy and to schedule auto-revert of session-scoped AI Credits routing.
   */
  resetsAt?: number;
}

/** Persisted per-tab metadata for a marked AI Credits billing-source failure. */
export interface AiCreditsNoBillingSourceState {
  provider: 'claude' | 'codex';
  /** Event timestamp (ms since epoch) when the hosted 402 was detected. */
  detectedAt: number;
}

// ---------------------------------------------------------------------------
// Codex-native collab blocks
// ---------------------------------------------------------------------------

/**
 * Last-known status snapshot for a single agent referenced by a Codex
 * `collabAgentToolCall`. Mirrors the generated `CollabAgentState` shape but
 * widens the status field to a plain string so transport-layer normalization
 * does not break if the protocol adds new variants.
 */
export interface CodexAgentState {
  /**
   * `CollabAgentStatus` (e.g. `'pendingInit' | 'running' | 'completed' |
   * 'errored'`). Kept as `string` so consumers do not have to redeploy when the
   * Codex protocol adds a new status enum value.
   */
  status: string;
  message?: string | null;
}

/** Persisted identity and configuration for a Codex child thread. */
export interface CodexAgentReceiver {
  nickname?: string;
  role?: string;
  /** Canonical task path, retained independently of the provider nickname. */
  agentPath?: string;
  /** Latest known thread configuration, not per-turn usage attribution. */
  model?: string;
  reasoningEffort?: string;
}

/** When a Codex child thread's own turns ran, in epoch ms. */
export interface CodexAgentReceiverTimes {
  /** Its first turn's start. */
  startedAt?: number;
  /** Its latest turn's end; absent while a turn runs. */
  settledAt?: number;
}

/**
 * Codex-native persisted block representing a multi-agent collab tool call
 * (`spawnAgent`, `sendInput`, `resumeAgent`, `wait`, `closeAgent`). This is the
 * raw/persisted counterpart to the renderer's `codex_agent` display block. We
 * intentionally do NOT synthesize Claude `tool_use` blocks for these calls —
 * the contract preserves Codex protocol metadata so subagent grouping is
 * driven by `senderThreadId` / `receiverThreadIds[]` rather than tool-name
 * heuristics.
 */
export interface DelegatedAgentCallBlock extends AgentDelegationSnapshot {
  type: 'delegated_agent_call';
  agentBlockId: string;
  runGeneration: number;
  sequence: number;
  parentHarnessId: string;
  parentTurnId: string;
  parentToolCallId: string;
  createdAt: number;
  selectedModelId: string;
  runtimeModelId: string;
  targetHarnessId: string;
  requestedThinkingLevel?: ThinkingLevel;
  effectiveThinkingLevel?: ThinkingLevel;
  description: string;
  prompt: string;
  executionMode: 'foreground' | 'background';
  /**
   * `chat-log-v1`: the child transcript lives in the parent chat's delegate
   * log, and this card is the run's only row in the parent transcript.
   */
  transcriptStore?: 'chat-log-v1' | 'chat-stream-v2';
  /** Descriptor-backed read/display hint only; never durable card state. */
  streamRevision?: number;
  /** Format 4 only: complete bodies when `partialText`/`finalText` are previews. */
  partialTextRef?: PersistedToolOutputReference;
  finalTextRef?: PersistedToolOutputReference;
}

export interface CodexAgentCallBlock {
  type: 'codex_agent_call';
  /**
   * Stable display block id for the Codex agent group. Use the canonical
   * `` `codex-agent-${callId}` `` form so consumers can derive it without a
   * lookup table.
   */
  agentBlockId: string;
  /** Originating spawn/activity item id, or `subagent-${threadId}` for thread metadata. */
  callId: string;
  /** `CollabAgentTool` discriminator (`spawnAgent`, `sendInput`, ...). */
  tool: string;
  /** `CollabAgentToolCallStatus` (`inProgress`, `completed`, `failed`). */
  status: string;
  /** Thread id of the agent issuing the collab request. */
  senderThreadId: string;
  /** Thread ids of the receiving subagents (always an array, possibly empty). */
  receiverThreadIds: string[];
  /** Prompt text for the call. The protocol's `prompt` may be `null`; persist
   * as `''` so downstream block fields stay typed as `string`. */
  prompt: string;
  /** Model requested for the spawned agent, when applicable. */
  model?: string;
  /** Reasoning effort requested for the spawned agent, when applicable. */
  reasoningEffort?: string;
  /** Last known status for each receiver agent keyed by thread id. */
  agentsStates: Record<string, CodexAgentState>;
  /**
   * Best-effort identity and configuration for each receiver agent, populated
   * from subagent activity and forwarded `thread.started` events. Treat as advisory: the
   * generated `collabAgentToolCall` item does not include this metadata, so
   * consumers must fall back to a stable label (e.g. `"Codex"`) when missing.
   */
  receiverAgents?: Record<string, CodexAgentReceiver>;
  /** Each receiver thread's own turn times, recorded as its turns run. */
  receiverTimes?: Record<string, CodexAgentReceiverTimes>;
}

/**
 * Marker block emitted into the transcript when the provider compacts the
 * conversation context (native Codex or Claude compaction, manual `/compact`,
 * or a managed-terminal `PostCompact` hook). Persisted as part of the
 * transcript so the chat UI can render a provider-specific compaction banner
 * and link out to the optional raw transcript snapshot.
 */
export interface CompactionInfoBlock {
  type: 'compaction_info';
  /** Unix-ms when the compaction completed. */
  timestamp: number;
  /** Which provider produced this compaction event. */
  provider: AgentProviderType;
  /** Which UX surface owned the chat at the time of the compaction. */
  interfaceMode: ChatInterfaceMode;
  /**
   * The provider session ID associated with the compaction, when known.
   * For Claude Code terminal mode this is the `sdkSessionId`.
   */
  sessionId?: string;
  /** Optional short reason (e.g. `'auto'`, `'manual'`, `'token-pressure'`). */
  reason?: string;
  /** Optional summary text produced by the provider. */
  summary?: string;
  /**
   * Absolute path to the raw provider transcript file captured at the
   * moment of compaction, when the backend was able to persist one.
   */
  transcriptPath?: string;
  /**
   * Optional identifier of the originating hook event so the renderer can
   * deduplicate repeated compaction notifications.
   */
  sourceEventId?: string;
}

/**
 * Marker block appended to a forked Claude Code terminal chat when the
 * best-effort pre-fork transcript sync failed. The fork still opens, but the
 * transcript snapshot may not include the newest terminal output.
 */
export interface ClaudeTerminalSyncWarningBlock {
  type: 'claude_terminal_sync_warning';
  /** Unix-ms when the warning was created. */
  timestamp: number;
  /** Short renderer-safe description of the sync failure. */
  message?: string;
}

/** Main's session event when the account proxy moved a chat to another account. */
export const CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE =
  'canopy_account_proxy_switch';

/**
 * A quiet line where the account proxy moved the chat to another account
 * (CAN-4021): the account that reached a limit or failed, and the account
 * that took over. Labels are often emails, so renderers block them from
 * session replay.
 */
export interface AccountProxySwitchBlock {
  type: 'account_proxy_switch';
  /** Unix-ms when the first response from the new account arrived. */
  timestamp: number;
  /** The account that now serves the chat. */
  account: string;
  /** The account that served it before, when known. */
  previousAccount?: string;
  /** The previous account was at a usage limit when the chat moved. */
  previousAtLimit?: boolean;
  /** `claude`, `codex`, and so on, when known. */
  provider?: string;
  /** Identifies the switch so a replayed event is not shown twice. */
  sourceEventId?: string;
}

/** Main's session event when a Claude launch skipped one or more Mods. */
export const CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE =
  'canopy_claude_mods_skipped';

/** Why a launch skipped a plugin's Mod (Claude Mods safety phase 04). */
export type ClaudeModSkippedReason =
  | 'not-admitted'
  | 'digest-changed'
  | 'kill-switch'
  | 'authority-unreadable'
  | 'inspection-failed'
  | 'projection-failed';

export interface ClaudeModsSkippedEntry {
  /** The Claude plugin id, `<plugin>@<marketplace>`. */
  pluginId: string;
  reason: ClaudeModSkippedReason;
}

/**
 * A line where a Claude launch skipped plugins' Mods while Mod admission was
 * on: the plugins and why. Path-free; shared chats leave it out.
 */
export interface ClaudeModsSkippedBlock {
  type: 'claude_mods_skipped';
  /** Unix-ms when the launch started. */
  timestamp: number;
  mods: ClaudeModsSkippedEntry[];
  /** Identifies the launch so a replayed event is not shown twice. */
  sourceEventId?: string;
}

export type PersistedChatBlock =
  | {
      type: 'mcp_activation';
      /** Preserve versioned storage bytes; interpret with readMcpActivationRecord. */
      record: unknown;
    }
  | {
      type: 'text';
      text: string;
      /**
       * Format 4 only: the complete body when `text` is its bounded preview.
       * Published once, when the item is final; absent means `text` is whole.
       */
      textRef?: PersistedToolOutputReference;
      /** Correlated additional input; folded steering does not start a turn. */
      steering?: { startsTurn: boolean; rootUserMessageId?: string };
      /** Structured Codex async input request. `text` is its display fallback. */
      asyncQuestion?: {
        requestId: string;
        questions: Array<{ title: string; options: string[] | null }>;
      };
      /** User-authored async answer, rendered once at its submission position. */
      asyncQuestionAnswer?: {
        requestId: string;
        /** Set only when the normal dispatch path actually starts a new turn. */
        startsTurn: boolean;
        answers: Array<{
          question: string;
          selectedOptions: string[];
          freeformText?: string;
        }>;
      };
      /** Render literally without interpreting provider-controlled Markdown. */
      verbatim?: boolean;
      /**
       * Structured authentication failure this text reports (CAN-1814).
       * Optional and additive: absent on every block persisted before the
       * feature shipped, and on all normal text. Never carries credentials.
       *
       * Retained alongside {@link authFailures} rather than replaced by it:
       * transcripts persisted before the multi-blocker checklist carry only
       * this field. Read both through `readAuthDependencyFailures`.
       */
      authFailure?: AuthDependencyFailure;
      /**
       * Every dependency blocked in this turn, deduplicated by `dependencyId`
       * with `authFailure` first (CAN-1814 PR 2). One block carries the whole
       * set because the checklist is one card with a row per dependency.
       */
      authFailures?: AuthDependencyFailure[];
      /** Trusted launch-route context; text retains the original diagnostic. */
      errorCode?: ClaudeAiCreditsFallbackErrorCode;
      /** Redacted ACP explanation, available through Copy details only. */
      providerErrorDetails?: string;
      /**
       * The provider refused this turn because the signed-in account cannot
       * use its model (CAN-4716). Stamped from the trusted terminal event;
       * text retains the original diagnostic.
       */
      modelAccessFailure?: CodexAccountModelAccessFailure;
    }
  | { type: 'file_references'; references: FileReference[] }
  | {
      /** Local image emitted as provider-generated output. */
      type: 'image';
      /** Absolute on-host path. The renderer resolves it through desktop IPC. */
      path: string;
      /** Bounded inline raster tool output; path is empty for this variant. */
      dataUrl?: string;
      alt: string;
    }
  | {
      type: 'thinking';
      text: string;
      /** See the `text` variant. */
      textRef?: PersistedToolOutputReference;
    }
  | {
      type: 'tool_use';
      toolUseId: string;
      /** Provider-accurate values retained for transcript/audit replay. */
      toolName: string;
      input: string;
      /** Format 4 only: the complete `input` when it holds a bounded preview. */
      inputRef?: PersistedToolOutputReference;
      /** Optional display projection; never used for tool execution or approval. */
      display?: { toolName: string; input: string };
    }
  | {
      type: 'tool_result';
      interruption?: ToolInterruption;
      toolUseId: string;
      toolName: string;
      output: string;
      isError: boolean;
      /** Canonical safe metadata retained before lossless output externalization. */
      agentArtifacts?: AgentArtifactReceiptV1[];
      outputTruncated?: true;
      fullOutputRef?: PersistedToolOutputReference;
      /** Optional persisted visual artifact attached to this tool result. */
      visualRef?: PersistedVisualReference;
      /** See the `text` variant. Set when this errored result is an auth failure. */
      authFailure?: AuthDependencyFailure;
      /** See the `text` variant. */
      authFailures?: AuthDependencyFailure[];
    }
  | {
      type: 'turn_timer';
      /** Canonical execution identity; absent on legacy transcript timers. */
      turnId?: string;
      /** The canonical execution's anchor; absent when it has no prompt. */
      userMessageId?: string;
      /**
       * What started an autonomous turn: the finished task's ids, or empty
       * when the provider doesn't name it; `event` when the task reported an
       * event and keeps running. `toolsLoaded` marks the continuation after
       * a tools load, which keeps its cause though it shares the prompt's
       * anchor. Absent on every other turn.
       */
      spawnedBy?: {
        taskId?: string;
        toolUseId?: string;
        event?: true;
        scheduled?: true;
        toolsLoaded?: true;
      };
      startedAt?: number;
      pausedAt?: number | null;
      resumedAt?: number | null;
      /** Active prompt identities holding this timer pause. */
      pauseOwnerIds?: string[];
      accumulatedPausedDurationMs?: number;
      completedAt: number | null;
      /** Canonical exact-execution result; absent means unknown, including legacy timers. */
      outcome?: 'completed' | 'cancelled' | 'failed';
    }
  | {
      /**
       * Display only: the head of an autonomous (wake) turn, which
       * `reorderMessagesForDisplay` builds from the wake's timer. Never
       * persisted.
       */
      type: 'wake_boundary';
      turnId: string;
      /** The finished task, from the tool call that started it. */
      taskLabel?: string;
      /** The prompt whose turn started the task, when it's in the transcript. */
      spawningUserMessageId?: string;
      /** The tool call that started the task, when it's in the transcript. */
      spawningToolUseId?: string;
      /** The task reported an event and keeps running, rather than finishing. */
      taskEvent?: true;
      /** A scheduled prompt (a cron job) fired; `taskLabel` is its prompt. */
      scheduled?: true;
      /** The agent continued after Canopy restarted it to load tools. */
      toolsLoaded?: true;
    }
  | { type: 'hook_info'; triggerName: string; timestamp: number }
  | { type: 'automation_info'; activityName?: string; timestamp: number }
  | CompactionInfoBlock
  | ClaudeTerminalSyncWarningBlock
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
      /**
       * Marker block for a chat created from the PR status bar that runs a
       * bundled `builtin-gh` workflow skill — resolving merge conflicts
       * ("Resolve, Commit & Push") or triaging review comments ("Triage review
       * comments"). Rendered as a muted info banner like `hook_info`.
       */
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
      /**
       * Marker block recording that a pending tool-approval prompt was
       * released without the user clicking it, because they widened the
       * chat's approval mode while the card was on screen (CAN-3083).
       *
       * An auto-approval is a privileged action, so it is recorded in the
       * transcript rather than only in observability. One block covers the
       * whole batch a single mode change resolved; `titles` carries each
       * released card's own summary line.
       *
       * The mode union is inlined as a string union (rather than imported
       * from `@canopy/desktop-shared`) because this package may depend only
       * on `@canopy/protocol` — the same rule sibling blocks follow.
       */
      type: 'approval_resolution_info';
      timestamp: number;
      /** Only source today. Named so a future automatic release is distinct. */
      resolvedBy: 'mode-change';
      /** Mode the requests were re-evaluated under. */
      mode: 'ask' | 'auto' | 'full-access';
      previousMode?: 'ask' | 'auto' | 'full-access';
      /** Approval-card titles this one resolution released. */
      titles: string[];
    }
  | ApprovalSafetyDeniedInfo
  | {
      /**
       * Marker block emitted into the transcript when the user reverts the
       * code changes from a prior turn. The chat history itself is left
       * intact — this block sits at the revert point as a system message
       * (analogous to `hook_info`) and carries the diff of the rolled-back
       * files plus a pointer back to the user message whose turn was
       * reverted, so the UI can render a clickable diff banner.
       */
      type: 'revert_info';
      timestamp: number;
      /** ID of the user message whose turn was rolled back. */
      revertedFromMessageId: string;
      /**
       * Timestamp of the reverted user message. Used to render
       * "rolled back to <time>" text without needing a lookup.
       */
      revertedFromTimestamp: number;
      /** Files changed between the snapshot and the pre-revert state. */
      files: ChangedFileInfo[];
      totalInsertions: number;
      totalDeletions: number;
      /** Per-repo tree refs the popover uses to render file diffs. */
      treeRefs?: TurnDiffTreeRef[];
      /**
       * Path of the synthetic markdown summary written to the worktree's
       * attachments dir. The next user message picks it up via
       * `attachmentPaths` so the model can read what was reverted.
       */
      attachmentPath?: string;
    }
  | CodexAgentCallBlock
  | DelegatedAgentCallBlock;

export type { PersistedToolOutputReference };

export interface PersistedVisualReference {
  version: 1;
  /** `vis_` followed by a lowercase canonical UUID. */
  visualId: string;
  /** Content-addressed artifact id, `sha256-v1-<digest>`. */
  artifactId: string;
  byteLength: number;
  sha256: string;
  mediaType: 'text/html';
  title: string;
  /** Agent's maximum frame height, clamped 80..2000. */
  maxHeight: number;
  /** Optional [width, height] pairs measured by the preview renderer. */
  heights?: ReadonlyArray<readonly [number, number]>;
}

export type PersistedUserMessageSource =
  | 'human'
  | 'auto_resume'
  | 'agent'
  | 'hook'
  | 'watcher'
  | 'deferred_tools_reload'
  | 'immediate_turn_restart';

export interface PersistedChatMessage {
  /** Host-only orchestration input retained for replay, never displayed. */
  hidden?: boolean;
  /**
   * A prompt whose turn its core cancelled before it replied, such as a
   * queued message deleted from the queue: it reads Cancelled, as the web's
   * transcript shows it (CAN-6689).
   */
  cancelled?: true;
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: PersistedChatBlock[];
  timestamp: number;
  userMessageSource?: PersistedUserMessageSource;
  autoResume?: AutoResumeMetadata;
  /**
   * Public sender attribution for a user message another agent sent: a Canopy
   * chat, or an external MCP agent set only from a validated Portal command
   * origin. Hidden sender instructions remain in the accepted input, never in
   * the transcript.
   */
  agentSent?: AgentSentInfo;
  /**
   * Claude-only grouping link: the `tool_use` id of the parent agent call
   * whose output this message belongs to. Preserved for backward compatibility
   * with existing Claude transcripts.
   */
  parentToolUseId?: string;
  /**
   * Provider-neutral grouping link. For Codex subagent messages this is the
   * `agentBlockId` of the owning `codex_agent_call` block (i.e.
   * `` `codex-agent-${callId}` ``). New code should prefer this field over
   * `parentToolUseId`; both may be present for compatibility.
   */
  parentBlockId?: string;
  /** First-observed order within an owned delegation, independent of root turn order. */
  delegationSequence?: number;
  delegationAuthor?: DelegationMessageAuthor;
  delegationDelivery?: 'follow_up' | 'steer';
  /**
   * Stream-backed child rows only: the native provider segment (turn or
   * message) that produced the item. Part of the row's identity digest.
   */
  delegationSegment?: string;
  /**
   * Codex thread id that produced this message. Forwarded from the Codex
   * protocol's `threadId` field so the renderer can group subagent output by
   * receiver thread without relying on tool-name heuristics.
   */
  codexThreadId?: string;
  /**
   * Codex turn id that produced this message. Used together with
   * `codexThreadId` to attribute deferred completions and streaming deltas to
   * the originating subagent turn.
   */
  codexTurnId?: string;
  /** Absolute paths of files attached to this message. */
  attachmentPaths?: string[];
  /** Prompt treatment metadata for attached files keyed by attachment path. */
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  /** How the user authored this message. Persisted so the transcript badge survives reloads. */
  inputMode?: 'typed' | 'voice';
  /**
   * Present when this user message was generated by a fired Canopy watcher.
   * Drives the info-tinted bubble and the "<kind> watcher has fired" title
   * line in the transcript.
   */
  watcherFired?: ChatWatcherFiredInfo;
  /**
   * Claude Code session chain uuid of the top-level SDK event that produced
   * this message (`SDKAssistantMessage.uuid`, or the `SDKUserMessage.uuid` of
   * a `tool_result` carrier). Stamped only for main-chain frames — a
   * sidechain/subagent frame's uuid is not a valid fork point on the parent
   * chain, so those are deliberately left unstamped.
   *
   * This is what lets a fork taken at an earlier turn resume the source
   * session at a point in time (`resumeSessionAt` with `resume` +
   * `forkSession`) instead of starting the model with no context. Absent on
   * transcripts written before the field existed and on every non-Claude
   * provider; callers must treat it as optional.
   */
  claudeUuid?: string;
  /**
   * Format 4 only: the row's block list lives in block pages and `blocks` is
   * empty. Present only on a final row whose references-only form still
   * exceeds the 16 MiB row guard.
   */
  blocksRef?: TranscriptBlocksReference;
  /**
   * Child page reads only, never stored: the row's blocks exceed the page's
   * byte budget, so `blocks` is empty and its `blockCount` logical blocks are
   * read by block page.
   */
  blocksOmitted?: { blockCount: number };
}

/** A paged row's root block manifest and its logical block count. */
export interface TranscriptBlocksReference {
  version: 1;
  manifest: PersistedToolOutputReference;
  blockCount: number;
}

/** Host-only orchestration messages never cross display or publication seams. */
export function isVisiblePersistedChatMessage(
  message: PersistedChatMessage,
): boolean {
  return message.hidden !== true;
}
