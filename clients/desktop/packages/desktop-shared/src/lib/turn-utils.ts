import { isPlanFileWrite } from '@canopy/agent-transcript/lib/plan-tool-input';
import { isHistoricalDelegateWatchToolName } from '@canopy/execution-engine/lib/canopy-injected-tools';
import type { ApprovalSafetyDeniedInfo } from '@canopy/protocol/approvals';
import type { TurnSummaryCounts } from '@canopy/agent-transcript/transcript-storage';

export { isUsageInitiationSource } from '@canopy/protocol/observability';
export type { TurnSummaryCounts } from '@canopy/agent-transcript/transcript-storage';
import type { PersistedUserMessageSource } from '@canopy/agent-transcript/types';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import type { AgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';
import type {
  TurnOutcomeCounts,
  TurnOutcomeStepDetail,
  TurnOutcomeEvidence,
  ToolInterruption,
} from '@canopy/protocol/portal';
import { classifyTurnStepOutcome } from '@canopy/protocol/portal';
import type {
  AgentUsage,
  ChangedFileInfo,
  ChatWatcherFiredInfo,
  CodexAgentState,
  AccountProxySwitchBlock,
  ClaudeModsSkippedBlock,
  CompactionInfoBlock,
  ClaudeTerminalSyncWarningBlock,
  FileReference,
  TurnDiffTreeRef,
} from '../types';
import type { PersistedChatBlock } from '@canopy/agent-transcript/types';
import {
  getCanonicalAppAdvisorToolKey,
  isAppAdvisorLedgerToolKey,
  isAppAdvisorToolName,
} from './app-advisor-tools';
import {
  getCanonicalCanopyToolKey,
  isCanopyImmediateTurnRestartToolName,
  isManagedDelegationAppToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import { getCanonicalPipelineEditorToolKey } from './pipeline-editor-tools';

const LEGACY_TOOL_NAMESPACE = ['cano', 'py'].join('');
const legacyMcpToolName = (name: string): string =>
  `mcp__${LEGACY_TOOL_NAMESPACE}__${name}`;

function isAppAdvisorWatcherToolName(toolName: string): boolean {
  const key = getCanonicalAppAdvisorToolKey(toolName);
  return (
    key === 'search_watchers' ||
    key === 'watch_command' ||
    key === 'schedule_wakeup' ||
    key === 'setup_watchers' ||
    key === 'watch_github_items'
  );
}

// App Advisor's names for the Agent Ledger tools. Every surface records into
// the same Ledger, so these count with the other Ledger calls rather than in
// the App Advisor chip, as the App Advisor watcher tools count as watchers.
function isAppAdvisorLedgerToolName(toolName: string): boolean {
  const key = getCanonicalAppAdvisorToolKey(toolName);
  return key !== null && isAppAdvisorLedgerToolKey(key);
}

// Pipeline-editor tools roll up to a single `pipelineEditor` summary chip, but
// the assistant's `AskUserQuestion` is excluded here so it shares the common
// `askUser` bucket (it folds into the shared ask-user card in the UI).
function isPipelineEditorSummaryToolName(toolName: string): boolean {
  const key = getCanonicalPipelineEditorToolKey(toolName);
  return key !== null && key !== 'ask_user_question';
}

/**
 * Brand-agnostic recognizer for the plan-explore "Plan" tool family. Matches
 * the plan-comment tools (RespondToComment, GetPlanComments) and their
 * code-review counterpart (GetReviewComments, which reuses RespondToComment
 * for replies) across the Claude MCP names (`mcp__<ns>__RespondToComment` or
 * bare `RespondToComment`) and the Codex dynamic-tool names
 * (`<ns>_respond_to_comment`) by suffix so they stay correct across brand
 * namespaces and all bucket into the single `plan` category.
 */
function isPlanToolName(name: string | null | undefined): boolean {
  return (
    typeof name === 'string' &&
    (/RespondToComment$/.test(name) ||
      /GetPlanComments$/.test(name) ||
      /GetReviewComments$/.test(name) ||
      /respond_to_comment$/.test(name) ||
      /get_plan_comments$/.test(name) ||
      /get_review_comments$/.test(name))
  );
}

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
}

export interface StandaloneTurnMessage {
  kind: 'standalone';
  message: TurnMessage;
}

export type TurnGroupOrMessage = TurnGroup | StandaloneTurnMessage;

export function isTurnTimerMessage(message: {
  id: string;
  role: TurnMessage['role'];
  blocks: ReadonlyArray<{ type: string }>;
}): boolean {
  if (message.blocks.length !== 1 || message.blocks[0]?.type !== 'turn_timer') {
    return false;
  }

  return (
    message.role === 'system' ||
    (message.role === 'assistant' && message.id.endsWith(':timer'))
  );
}

export const TASK_MGMT_TOOLS = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TodoWrite',
]);

function isEmptyThinkingBlock(block: TurnBlock): boolean {
  return block.type === 'thinking' && block.text.trim().length === 0;
}

function isLegacyClaudeTerminalResultBoundary(message: TurnMessage): boolean {
  if (message.role !== 'system' || message.blocks.length !== 1) {
    return false;
  }
  const block = message.blocks[0];
  return (
    block.type === 'text' &&
    block.text.trimStart().startsWith('Claude Code result metadata')
  );
}

function toLegacyClaudeTerminalTimerMessage(message: TurnMessage): TurnMessage {
  return {
    ...message,
    blocks: [{ type: 'turn_timer', completedAt: message.timestamp }],
  };
}

/** A wake turn's display-only head row (turn-state phase 40d). */
export function isWakeBoundaryMessage(message: {
  blocks: readonly { type: string }[];
}): boolean {
  return message.blocks[0]?.type === 'wake_boundary';
}

export function groupIntoTurns(messages: TurnMessage[]): TurnGroupOrMessage[] {
  const result: TurnGroupOrMessage[] = [];
  let currentUserMessage: TurnMessage | null = null;
  let currentAssistantMessages: TurnMessage[] = [];

  const flushIncomplete = (reason: 'next_user' | 'end'): void => {
    if (!currentUserMessage) {
      return;
    }

    if (reason === 'next_user' && currentAssistantMessages.length > 0) {
      const completedAt =
        currentAssistantMessages[currentAssistantMessages.length - 1]
          ?.timestamp ?? currentUserMessage.timestamp;
      result.push({
        kind: 'turn-group',
        userMessage: currentUserMessage,
        assistantMessages: currentAssistantMessages,
        timerMessage: {
          id: `${currentUserMessage.id}-implicit-turn-timer`,
          role: 'system',
          timestamp: completedAt,
          blocks: [{ type: 'turn_timer', completedAt }],
        },
        isComplete: true,
      });
      currentUserMessage = null;
      currentAssistantMessages = [];
      return;
    }

    result.push({ kind: 'standalone', message: currentUserMessage });
    for (const assistantMessage of currentAssistantMessages) {
      result.push({ kind: 'standalone', message: assistantMessage });
    }
    currentUserMessage = null;
    currentAssistantMessages = [];
  };

  for (const message of messages) {
    const isTurnTimer = isTurnTimerMessage(message);
    const legacyClaudeTerminalTimerMessage =
      !isTurnTimer && isLegacyClaudeTerminalResultBoundary(message)
        ? toLegacyClaudeTerminalTimerMessage(message)
        : null;
    const turnTimerMessage = isTurnTimer
      ? message
      : legacyClaudeTerminalTimerMessage;

    if (isUserTurnBoundary(message) || isWakeBoundaryMessage(message)) {
      flushIncomplete('next_user');
      currentUserMessage = message;
      currentAssistantMessages = [];
      continue;
    }

    if (turnTimerMessage && currentUserMessage) {
      const timerBlock = turnTimerMessage.blocks[0];
      result.push({
        kind: 'turn-group',
        userMessage: currentUserMessage,
        assistantMessages: currentAssistantMessages,
        timerMessage: turnTimerMessage,
        isComplete:
          timerBlock.type === 'turn_timer' && timerBlock.completedAt !== null,
      });
      currentUserMessage = null;
      currentAssistantMessages = [];
      continue;
    }

    if (isTurnTimer) {
      result.push({ kind: 'standalone', message });
      continue;
    }

    if (legacyClaudeTerminalTimerMessage) {
      continue;
    }

    if (currentUserMessage) {
      currentAssistantMessages.push(message);
    } else {
      result.push({ kind: 'standalone', message });
    }
  }

  flushIncomplete('end');
  return result;
}

/**
 * Strip app-managed MCP server prefixes from a raw server segment.
 *
 * The segment is the chunk between `mcp__` and `__<tool>` in a Claude-style
 * MCP tool name. The app injects servers under three prefixes:
 *
 * - `appdyn-<friendly>--<digest>` — dynamic worktree-scoped MCP servers.
 * - `appproxy-<friendly>--<digest>` — proxied OAuth-backed MCP servers.
 * - `appplugin-<friendly>--<digest>` — plugin-declared MCP servers routed
 *   through the app in both app-managed and provider HTTP-auth modes.
 *
 * All three encode the user-friendly name first, followed by `--` and an
 * opaque digest. For display we want only the friendly name. Server
 * names that do not match any of these prefixes are returned unchanged.
 */
export function normalizeCanopyMcpServerDisplayName(
  serverName: string,
): string {
  const legacyPrefixRoot = ['cano', 'py'].join('');
  const prefixes = [
    'appdyn-',
    'appproxy-',
    'appplugin-',
    // Historical persisted transcript names.
    `${legacyPrefixRoot}dyn-`,
    `${legacyPrefixRoot}proxy-`,
    `${legacyPrefixRoot}plugin-`,
  ];
  for (const prefix of prefixes) {
    if (serverName.startsWith(prefix)) {
      const withoutPrefix = serverName.slice(prefix.length);
      const separatorIndex = withoutPrefix.indexOf('--');
      return separatorIndex > 0
        ? withoutPrefix.slice(0, separatorIndex)
        : withoutPrefix;
    }
  }
  return serverName;
}

export function parseMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) {
    return null;
  }
  if (toolName.startsWith(`mcp__${LEGACY_TOOL_NAMESPACE}__`)) {
    return null;
  }

  const parts = toolName.split('__');
  if (parts.length < 3) {
    return null;
  }

  const rawServer = parts[1];
  const tool = parts.slice(2).join('__');

  return { server: normalizeCanopyMcpServerDisplayName(rawServer), tool };
}

export function getToolCategory(
  toolName: string,
): keyof Omit<TurnSummaryCounts, 'messages' | 'thinking' | 'computerUse'> {
  if (isHistoricalDelegateWatchToolName(toolName)) return 'canopy';
  if (isPlanToolName(toolName)) {
    return 'plan';
  }

  if (toolName === 'ClaudeModelChange') {
    return 'claude';
  }

  if (isCanopyImmediateTurnRestartToolName(toolName)) {
    return 'canopy';
  }

  if (isAppAdvisorWatcherToolName(toolName)) {
    return 'watcher';
  }

  // Same bucket as the injected Ledger tools below.
  if (isAppAdvisorLedgerToolName(toolName)) {
    return 'canopy';
  }

  // The Workflow tool (multi-agent launch) gets its own category/chip.
  if (toolName === 'Workflow') {
    return 'workflow';
  }

  // App Advisor tools roll up to a single category regardless of capability
  // so the per-turn summary shows one AppAdvisorIcon-keyed chip rather than
  // a separate chip per app-advisor action.
  if (isAppAdvisorToolName(toolName)) {
    return 'appAdvisor';
  }

  // Pipeline-editor assistant tools roll up to a single category so the
  // per-turn summary shows one PipelineIcon-keyed chip. `AskUserQuestion` is
  // excluded (see helper) so it stays in the shared `askUser` bucket.
  if (isPipelineEditorSummaryToolName(toolName)) {
    return 'pipelineEditor';
  }

  // Canonical Canopy-injected tools first. Claude and Codex raw names map to
  // the same category for the same capability (Section 8 of plan-transport.md).
  const canopyKey = getCanonicalCanopyToolKey(toolName);
  if (canopyKey === 'ask_user_question') {
    return 'askUser';
  }
  if (canopyKey === 'get_script_output') {
    return 'scriptOutput';
  }
  if (
    canopyKey === 'search_actions' ||
    canopyKey === 'dispatch_action' ||
    canopyKey === 'get_git_preferences' ||
    canopyKey === 'get_github_pull_request_status' ||
    canopyKey === 'save_memory' ||
    canopyKey === 'search_memory' ||
    canopyKey === 'read_memory' ||
    canopyKey === 'show_files' ||
    canopyKey === 'show_capabilities' ||
    canopyKey === 'show_visual' ||
    canopyKey === 'preview_visual' ||
    canopyKey === 'get_file_comments' ||
    canopyKey === 'respond_to_file_comment' ||
    canopyKey === 'set_auto_archive' ||
    canopyKey === 'set_work_entry_auto_delete' ||
    canopyKey === 'start_forked_agent' ||
    canopyKey === 'start_branched_agent' ||
    canopyKey === 'set_base_branch' ||
    canopyKey === 'search_deferred_tools' ||
    canopyKey === 'load_deferred_tools' ||
    isManagedDelegationAppToolKey(canopyKey)
  ) {
    return 'canopy';
  }
  // A spawn is agent work; its delegated-agent card counts the same way.
  if (canopyKey === 'delegate_task') {
    return 'agent';
  }
  if (canopyKey === 'read_pipeline_yaml') {
    return 'canopy';
  }
  // Ledger tools (three tools performing CRUD-style operations on structured
  // records) fold into the generic `canopy` bucket, mirroring the local
  // memory tools above rather than the larger watcher/code-graph groups.
  if (
    canopyKey === 'add_ledger_entry' ||
    canopyKey === 'search_ledger_entries' ||
    canopyKey === 'update_ledger_entry'
  ) {
    return 'canopy';
  }
  if (
    canopyKey === 'search_watchers' ||
    canopyKey === 'watch_command' ||
    canopyKey === 'schedule_wakeup' ||
    canopyKey === 'setup_watchers' ||
    canopyKey === 'watch_github_items' ||
    canopyKey === 'delete_watchers'
  ) {
    return 'watcher';
  }
  if (
    canopyKey === 'get_code_graph_context' ||
    canopyKey === 'build_or_update_code_graph' ||
    canopyKey === 'query_code_graph' ||
    canopyKey === 'search_code_graph' ||
    canopyKey === 'explain_code_symbol' ||
    canopyKey === 'get_impact_radius' ||
    canopyKey === 'detect_changed_symbols' ||
    canopyKey === 'compare_change_impact' ||
    canopyKey === 'get_review_context'
  ) {
    return 'graph';
  }

  switch (toolName) {
    case 'Bash':
    // Windows Claude sessions expose `PowerShell` in place of `Bash`.
    case 'PowerShell':
    case 'command':
      return 'bash';
    case 'Read':
      return 'read';
    case 'ReadLines':
      return 'readLines';
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return 'writeEdit';
    case 'Glob':
    case 'ToolSearch':
      return 'search';
    case 'Grep':
      return 'grep';
    case 'WebFetch':
    case 'WebSearch':
    case 'web_search':
      return 'web';
    case 'Skill':
      return 'skills';
    case 'Monitor':
    case legacyMcpToolName('Monitor'):
      return 'monitor';
    // Claude's own scheduler counts with the other scheduling tools.
    case 'ScheduleWakeup':
    case 'CronCreate':
    case 'CronDelete':
    case 'CronList':
      return 'scheduleWakeup';
    // Codex built-in ask-user tool — not a Canopy-injected name but shares
    // the `askUser` analytics bucket so Claude MCP, Codex dynamic, and
    // Codex built-in all aggregate the same way.
    case 'request_user_input':
      return 'askUser';
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'TodoWrite':
      return 'tasks';
    case 'TaskStop':
      return 'taskStop';
    // Agent-to-agent messages roll into the same `agent` bucket as
    // `Task`/`Agent` dispatch. `TaskOutput` can remain a standalone tool row
    // when its parent agent cannot be resolved, so it must also map here
    // instead of falling through to the generic tool chip.
    case 'SendMessage':
    case 'TaskOutput':
      return 'agent';
    case 'ListMcpResourcesTool':
      return 'mcp';
    case 'file_change':
      return 'other';
    default:
      return parseMcpToolName(toolName) ? 'mcp' : 'other';
  }
}

// Re-export shared registry so consumers who only need category mapping can
// reach the display names / provider lookup without importing a second file.

export interface TurnOutcomeStep {
  toolUseId: string;
  outcome: keyof TurnOutcomeCounts;
}

/**
 * Explicit turn ownership wins over commit position. Unscoped legacy receipts
 * belong to the supplied current-turn source; helper receipts are unsupported.
 */
export function getTurnSafetyDeniedToolUseIds(
  receiptMessages: readonly TurnMessage[],
  turnUserMessageId?: string,
): string[] {
  const blockedIds = new Set<string>();
  for (const message of receiptMessages) {
    for (const block of message.blocks) {
      if (
        block.type === 'approval_safety_denied_info' &&
        block.toolUseId &&
        !block.subagentId &&
        (turnUserMessageId === undefined ||
          block.turnUserMessageId === undefined ||
          block.turnUserMessageId === turnUserMessageId)
      ) {
        blockedIds.add(block.toolUseId);
      }
    }
  }
  return Array.from(blockedIds);
}

/** Compact eligible-step states also let the index apply a later receipt. */
export function getTurnOutcomeStepStates(
  countedMessages: readonly TurnMessage[],
  blockedIds: ReadonlySet<string>,
  evidence?: TurnOutcomeEvidence,
): Map<string, TurnOutcomeStep['outcome'] | undefined> {
  const steps = new Map<string, TurnToolResult | undefined>();
  for (const message of countedMessages) {
    for (const block of message.blocks) {
      if (
        block.type !== 'tool_use' &&
        block.type !== 'workflow' &&
        block.type !== 'agent'
      )
        continue;
      if (
        block.type === 'tool_use' &&
        (block.toolName === 'EnterPlanMode' ||
          block.toolName === 'ExitPlanMode')
      )
        continue;
      const result =
        block.type === 'agent'
          ? (block.taskOutputResult ?? block.result)
          : block.result;
      // Folding already selects the authoritative result. A repeated display
      // representation must not count twice or erase a known result with none.
      steps.set(block.toolUseId, result ?? steps.get(block.toolUseId));
    }
  }

  const outcomes = new Map<string, TurnOutcomeStep['outcome'] | undefined>();
  steps.forEach((result, toolUseId) => {
    outcomes.set(
      toolUseId,
      classifyTurnStepOutcome(result, blockedIds.has(toolUseId), evidence),
    );
  });
  return outcomes;
}

/**
 * Derive outcomes from exactly the messages used by the host's summary. The
 * receipt source includes separate current-turn notices beside the final answer.
 * Order follows logical steps; nested, Codex and delegated outcomes are excluded.
 */
export function getTurnOutcomeSteps(
  countedMessages: readonly TurnMessage[],
  receiptMessages: readonly TurnMessage[] = countedMessages,
  turnUserMessageId?: string,
  deniedToolUseIds: readonly string[] = [],
  evidence?: TurnOutcomeEvidence,
): TurnOutcomeStep[] {
  const states = getTurnOutcomeStepStates(
    countedMessages,
    new Set([
      ...getTurnSafetyDeniedToolUseIds(receiptMessages, turnUserMessageId),
      ...deniedToolUseIds,
    ]),
    evidence,
  );
  const steps: TurnOutcomeStep[] = [];
  states.forEach((outcome, toolUseId): void => {
    if (outcome !== undefined) steps.push({ toolUseId, outcome });
  });
  return steps;
}

/** The display call and authoritative result of one counted step block. */
function getOutcomeStepCall(
  block: Extract<TurnBlock, { type: 'tool_use' | 'agent' | 'workflow' }>,
): Omit<TurnOutcomeStepDetail, 'outcome'> & { result?: TurnToolResult } {
  switch (block.type) {
    case 'tool_use':
      return {
        toolUseId: block.toolUseId,
        toolName: block.toolName,
        input: block.input,
        result: block.result,
      };
    case 'agent':
      return {
        toolUseId: block.toolUseId,
        toolName: 'Agent',
        input: JSON.stringify({
          description: block.description,
          subagent_type: block.subagentType,
          prompt: block.prompt,
        }),
        result: block.taskOutputResult ?? block.result,
      };
    case 'workflow':
      return {
        toolUseId: block.toolUseId,
        toolName: 'Workflow',
        input: JSON.stringify({ name: block.workflowName }),
        result: block.result,
      };
  }
}

/**
 * {@link getTurnOutcomeSteps} joined to each step's display call and raw
 * result output, in the same order, for the outcome tooltip. Only loaded rows
 * carry calls, so a paged turn's summary has counts but no details.
 */
export function getTurnOutcomeStepDetails(
  countedMessages: readonly TurnMessage[],
  receiptMessages: readonly TurnMessage[] = countedMessages,
  turnUserMessageId?: string,
  deniedToolUseIds: readonly string[] = [],
  evidence?: TurnOutcomeEvidence,
): TurnOutcomeStepDetail[] {
  const steps = getTurnOutcomeSteps(
    countedMessages,
    receiptMessages,
    turnUserMessageId,
    deniedToolUseIds,
    evidence,
  );
  if (steps.length === 0) return [];
  const outcomeById = new Map(
    steps.map((step) => [step.toolUseId, step.outcome]),
  );
  const calls = new Map<string, ReturnType<typeof getOutcomeStepCall>>();
  for (const message of countedMessages) {
    for (const block of message.blocks) {
      if (
        (block.type !== 'tool_use' &&
          block.type !== 'workflow' &&
          block.type !== 'agent') ||
        !outcomeById.has(block.toolUseId)
      )
        continue;
      const call = getOutcomeStepCall(block);
      // Same rule as the outcome states: a repeated representation without a
      // result keeps the known one.
      const previous = calls.get(block.toolUseId);
      calls.set(block.toolUseId, {
        ...(previous ?? call),
        result: call.result ?? previous?.result,
      });
    }
  }
  return steps.flatMap((step) => {
    const call = calls.get(step.toolUseId);
    if (!call) return [];
    const detail: TurnOutcomeStepDetail = {
      toolUseId: step.toolUseId,
      outcome: step.outcome,
      toolName: call.toolName,
      input: call.input,
    };
    if (call.result !== undefined) detail.output = call.result.output;
    if (call.result?.interruption !== undefined)
      detail.interruption = call.result.interruption;
    return [detail];
  });
}

export function computeTurnOutcomes(
  countedMessages: readonly TurnMessage[],
  receiptMessages: readonly TurnMessage[] = countedMessages,
  turnUserMessageId?: string,
  deniedToolUseIds: readonly string[] = [],
  evidence?: TurnOutcomeEvidence,
): TurnOutcomeCounts {
  const counts: TurnOutcomeCounts = { blocked: 0, failed: 0, interrupted: 0 };
  for (const step of getTurnOutcomeSteps(
    countedMessages,
    receiptMessages,
    turnUserMessageId,
    deniedToolUseIds,
    evidence,
  )) {
    counts[step.outcome] += 1;
  }
  return counts;
}

export function computeTurnSummary(
  assistantMessages: TurnMessage[],
): TurnSummaryCounts {
  const counts: TurnSummaryCounts = {
    messages: 0,
    thinking: 0,
    bash: 0,
    read: 0,
    readLines: 0,
    writeEdit: 0,
    plan: 0,
    fileEdit: 0,
    fileAdd: 0,
    fileDelete: 0,
    search: 0,
    grep: 0,
    web: 0,
    agent: 0,
    workflow: 0,
    tasks: 0,
    taskStop: 0,
    skills: 0,
    monitor: 0,
    claude: 0,
    scheduleWakeup: 0,
    askUser: 0,
    scriptOutput: 0,
    watcher: 0,
    canopy: 0,
    graph: 0,
    appAdvisor: 0,
    pipelineEditor: 0,
    computerUse: 0,
    mcp: 0,
    other: 0,
  };

  const countFileChangeBlock = (input: string): void => {
    const lines = input
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
    for (const line of lines) {
      const match = line.match(/^(\w+):\s*.+$/);
      if (!match) {
        continue;
      }

      const kind = match[1].toLowerCase();
      if (kind === 'delete') {
        counts.fileDelete += 1;
      } else if (kind === 'add' || kind === 'create') {
        counts.fileAdd += 1;
      } else {
        counts.fileEdit += 1;
      }
    }

    if (lines.length === 0) {
      counts.fileEdit += 1;
    }
  };

  const countBlocks = (blocks: TurnBlock[]): void => {
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          counts.messages += 1;
          break;
        case 'thinking':
          if (!isEmptyThinkingBlock(block)) {
            counts.thinking += 1;
          }
          break;
        case 'tool_use':
          if (
            block.toolName === 'EnterPlanMode' ||
            block.toolName === 'ExitPlanMode'
          ) {
            break;
          }
          // Plan artifacts are not project edits. Result status is handled
          // separately by the outcome projection, including failed writes.
          if (isPlanFileWrite(block.toolName, block.input)) break;
          if (block.toolName === 'file_change') {
            countFileChangeBlock(block.input);
            break;
          }
          if (
            block.toolName === 'mcp__cua_repl__js' ||
            block.toolName === 'mcp__cua_repl__js_reset'
          ) {
            counts.computerUse += 1;
            break;
          }
          counts[getToolCategory(block.toolName)] += 1;
          break;
        case 'agent':
          counts.agent += 1;
          break;
        // Codex `codex_agent` rows aggregate the same way as Claude `agent`
        // rows so the per-turn UI count stays provider-neutral. Internal
        // `subBlocks` are not double-counted — that mirrors existing Claude
        // `agent` behavior (Phase F3 §5).
        case 'delegated_agent_call':
        case 'codex_agent':
          counts.agent += 1;
          break;
        // A Workflow row is a multi-agent launch and gets its own distinct
        // per-turn count/chip rather than folding into the agent count.
        case 'workflow':
          counts.workflow += 1;
          break;
        default:
          break;
      }
    }
  };

  for (const message of assistantMessages) {
    countBlocks(message.blocks);
  }

  return counts;
}

/**
 * A host notice that stays beside the final answer when a turn collapses: a
 * system text message, an account proxy switch, or skipped Claude Mods.
 */
function isSystemTextMessage(message: TurnMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.some(
      (block) =>
        block.type === 'text' ||
        block.type === 'account_proxy_switch' ||
        block.type === 'claude_mods_skipped',
    )
  );
}

export function splitFinalMessages(messages: TurnMessage[]): {
  intermediateMessages: TurnMessage[];
  finalMessages: TurnMessage[];
  trailingToolMessages: TurnMessage[];
} {
  if (messages.length === 0) {
    return {
      intermediateMessages: [],
      finalMessages: [],
      trailingToolMessages: [],
    };
  }

  const hasNotices = messages.some(isSystemTextMessage);

  let lastAnchorIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (hasNotices && isSystemTextMessage(message)) continue;
    const hasText = message.blocks.some((block) => block.type === 'text');
    const hasImage = message.blocks.some((block) => block.type === 'image');
    const hasExitPlanMode = message.blocks.some(
      (block) => block.type === 'tool_use' && block.toolName === 'ExitPlanMode',
    );
    if (hasText || hasImage || hasExitPlanMode) {
      lastAnchorIndex = index;
      break;
    }
  }

  if (lastAnchorIndex < 0) {
    if (!hasNotices)
      return {
        intermediateMessages: messages.slice(),
        finalMessages: [],
        trailingToolMessages: [],
      };
    return {
      intermediateMessages: messages.filter(
        (message) => !isSystemTextMessage(message),
      ),
      finalMessages: messages.filter(isSystemTextMessage),
      trailingToolMessages: [],
    };
  }

  let splitIndex = lastAnchorIndex;
  for (let index = splitIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (hasNotices && isSystemTextMessage(message)) continue;
    const hasText = message.blocks.some((block) => block.type === 'text');
    const hasImage = message.blocks.some((block) => block.type === 'image');
    const hasExitPlanMode = message.blocks.some(
      (block) => block.type === 'tool_use' && block.toolName === 'ExitPlanMode',
    );
    const isTaskManagementMessage =
      !hasText &&
      !hasImage &&
      !hasExitPlanMode &&
      message.blocks.length > 0 &&
      message.blocks.every(
        (block) =>
          (block.type === 'tool_use' && TASK_MGMT_TOOLS.has(block.toolName)) ||
          block.type === 'turn_timer',
      );
    if (hasText || hasImage || hasExitPlanMode || isTaskManagementMessage) {
      splitIndex = index;
      continue;
    }
    break;
  }

  // Keep the existing allocation path for ordinary turns. Notice promotion
  // is uncommon and should not filter every array on each transcript render.
  if (!hasNotices)
    return {
      intermediateMessages: splitIndex > 0 ? messages.slice(0, splitIndex) : [],
      finalMessages: messages.slice(splitIndex, lastAnchorIndex + 1),
      trailingToolMessages: messages.slice(lastAnchorIndex + 1),
    };

  // Host notices and error guidance remain visible when activity collapses.
  // Preserve their transcript order without promoting assistant commentary.
  return {
    intermediateMessages: messages
      .slice(0, splitIndex)
      .filter((message) => !isSystemTextMessage(message)),
    finalMessages: messages.filter(
      (message, index) =>
        isSystemTextMessage(message) ||
        (index >= splitIndex && index <= lastAnchorIndex),
    ),
    trailingToolMessages: messages
      .slice(lastAnchorIndex + 1)
      .filter((message) => !isSystemTextMessage(message)),
  };
}
