import { isAutomationRunInput } from '../agent-messaging/automation-run-source';
import { retainedTerminalInput } from '../agent-messaging/terminal-input';
import { serializeVisibleReadMessage } from '@canopy/desktop-shared/lib/chat-history-serialization';
import { chatAddressPrompt } from '@canopy/desktop-shared/lib/chat-address-prompt';
import {
  APP_ADVISOR_BOT_ID,
  botIdForProjectId,
  isBotProjectId,
} from '@canopy/protocol/chat-targets';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import {
  type ActiveChatInputProvider,
  type ChatTerminalDisposition,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  resolveCanonicalChatAddress,
  captureChatWatcherEvidence,
  checkWatcherDeliveryIngress,
  WatcherDeliveryHeldError,
  type ChatLifecycleTarget,
} from '../services/active-chat-input';
import { hasTerminalWriteReceipt } from '../services/terminal-service';
import { watcherDeliveryAuthorityGeneration } from '../services/watcher-delivery-authority';
import { isInputLedger } from '@canopy/desktop-shared/chat-input-delivery';
import {
  acceptTerminalPresentationTurn,
  capturePresentationTurn,
  clearPresentationTurn,
  presentationChatKey,
  stageTerminalPresentationTurn,
} from '../canopy-tools/presentation-state';
import {
  terminalPresentationPrompt,
  terminalPresentationTurnId,
  stripTerminalPresentationMarker,
} from '@canopy/desktop-shared/lib/terminal-presentation';
import { browserHandoffs } from '../browser/browser-handoffs';
import { resolveSessionInterfaceTools } from '../agents/interface-tool-binding';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { WORKER_TERMINAL_LOST_SIGNAL } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  ClaudeTerminalLaunchError,
  STANDALONE_CHAT_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  clampThinkingLevelForModel,
  getProviderForModel,
  getModelSource,
  type AgentAuditStatus,
  type ApprovalMode,
  type ChatEvent,
  type ChatInterfaceMode,
  type ChatModel,
  type ChatSendMessageRequest,
  type ChatTabPluginSelections,
  type ClaudeTerminalTranscriptSyncEventData,
  type ClaudeTerminalCleanupReason,
  type ClaudeTerminalCleanupRequest,
  type ClaudeTerminalInterruptRequest,
  type ClaudeTerminalLaunchRequest,
  type ClaudeTerminalLaunchResponse,
  type ClaudeTerminalRuntimeState,
  type ClaudeTerminalSyncTranscriptRequest,
  type ClaudeTerminalSyncTranscriptResponse,
  type DeferredResourceSummary,
  type PersistedChatBlock,
  type PersistedChatMessage,
  type TurnDiffData,
  type TranscriptSyncResult,
} from '@canopy/desktop-shared/types';
import { BRAND } from '@canopy/brand/current';
import {
  captureSessionWorkOwner,
  resolveSessionWorkOwner,
} from '../agents/work-owner';
import {
  clearClaudeModAdmissionSessionRecords,
  replaceClaudeModAdmissionSessionRecords,
  shouldReloadForClaudeModChange,
  spawnWithClaudeModsSkippedEvent,
} from '../agents/claude-mod-admission-session';
import type {
  ClaudeTerminalHookCallbackBody,
  ClaudeTerminalHookEventName,
} from '@canopy/desktop-shared/lib/desktop-integration-transport';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { writeChatTabsFile } from '../lib/chat-tabs';
import { enqueueChatTabMutation } from '../lib/chat-tab-mutation-queue';
import { resolveClaudeCodeSessionTranscriptPath } from '../lib/claude-project-paths';
import { isClaudeTuiChatsEnabled } from '../lib/claude-tui-chats';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from '../lib/resolve-worktree';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import {
  getAppAdvisorHomeDir,
  getClaudeTerminalRuntimeDir,
  getWorktreeDataDir,
} from '../lib/paths';
import { ensureAppAdvisorHomeScaffold } from '../lib/app-advisor-workspace';
import { buildWorktreeInjectedToolPrompt } from '../canopy-tools/prompting';
import {
  mayExposeLedgerTools,
  openLedgerChatTools,
  type LedgerChatTarget,
  type LedgerChatToolsSession,
} from '../canopy-tools/ledger-tools-runtime';
import { isCodeGraphAvailableForWorkspace } from '../lib/code-graph-availability';
import { buildCodeGraphAvailabilityPrompt } from '../lib/code-graph-availability-prompt';
import {
  CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
  buildClaudeCodeGraphPreToolUseContext,
  isClaudeCodeGraphBuildToolName,
  isClaudeCodeGraphPostToolUse,
  isClaudeCodeGraphToolName,
  loadConfiguredClaudeCodeGraphSourceExtensions,
} from '../lib/claude-code-graph-steering';
import {
  beginClaudeCodeGraphToolCall,
  isClaudeCodeGraphOrientationCurrent,
  readClaudeCodeGraphToolAnswer,
  recordClaudeCodeGraphOrientation,
} from '../lib/claude-code-graph-orientation';
import { spawnPlacedManagedTerminal } from '../services/terminal-service';
import {
  TERMINAL_OUTPUT_INTERRUPTION_DETECTION_TAIL_CHARS,
  terminalOutputIndicatesUserInterruptedTurn,
  type WorkerTerminalEvent,
} from '@canopy/core-runtime/node/terminal';
import { workerTerminal } from '../terminal/worker-terminal';
import type {
  TerminalOutputEvent,
  TerminalRunningChangedEvent,
} from '@canopy/desktop-shared/types';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { getDesktopIntegrationServer } from './desktop-integration-server';
import {
  buildClaudeTerminalLaunchConfig,
  CLAUDE_TERMINAL_APPROVAL_PROMPT_TIMEOUT_MS,
} from './claude-terminal-settings';
import { ensureClaudeWorkspaceTrust } from './claude-workspace-trust';
import { isLiveClaudeTerminal } from './claude-terminal-liveness';
import type { AppAdvisorToolRuntime } from '../app-advisor/runtime';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import { APP_ADVISOR_SYSTEM_PROMPT } from '../app-advisor/system-prompt';
import {
  isAllowedClaudeTerminalTranscriptPath,
  syncClaudeTerminalTranscript,
  readTerminalWatcherObservations,
  writeTerminalWatcherObservations,
  terminalWatcherObservationsPath,
  type TerminalObservation,
  type TranscriptSyncResultWithMessages,
  type TranscriptSyncRequest,
} from './claude-terminal-transcript-sync';
import {
  captureTurnEndAndDiff,
  captureTurnStart,
} from '../lib/turn-diff-capture';
import { getCachedClaudeAuthStatusObserved } from '../auth/provider-auth-state';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { scheduleCodeGraphBuild } from '../lib/code-graph-scheduler';
import {
  getPlanFileSyncService,
  planChatTurnKey,
  resolvePlanTurnScope,
  type PlanTurnLease,
} from '../lib/plan-file-sync';
import { getChatStateService } from '../services/chat-state-service';
import {
  approvalDefaultsFromPreferences,
  readApprovalPreferencesForSurface,
  resolveApprovalMode,
  surfaceForChat,
} from '../lib/approval-mode-resolution';
import { readWorkspaceApprovals } from '../lib/approvals-persistence';
import { readWorkspaceApprovalsManifest } from '../lib/workspace-approvals-manifest';
import {
  createApprovalSession,
  type ApprovalOutcome,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  approvalCheckForClaudeTool,
  CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT,
  isClaudePlanModeBookkeepingTool,
} from '../agents/claude-approval-adapter';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { assertUntrustedChatInput } from '../agent-messaging/untrusted-input';
import { waitForWorktreeGitSetup } from '../lib/worktree-git-setup';

type EventSender = (
  channel:
    | typeof IPC_CHANNELS.chatEvent
    | typeof IPC_CHANNELS.claudeTerminalStateChanged
    | typeof IPC_CHANNELS.claudeTerminalSyncCompleted
    | typeof IPC_CHANNELS.claudeTerminalError,
  payload:
    | ChatEvent
    | (ClaudeTerminalRuntimeState & {
        projectId: string;
        worktreeId: string;
        chatId: string;
      })
    | TranscriptSyncResult
    | { chatId: string; message: string },
) => void;

interface RuntimeRecord {
  watcherObservations?: TerminalObservation[];
  watcherObservationsDirty?: boolean;
  watcherRuntimeGeneration?: string;
  watcherPublishTail?: Promise<void>;
  watcherPersistenceTail?: Promise<void>;
  watcherAcceptTail?: Promise<void>;
  presentationTurnId?: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  runtimeDir: string;
  authToken: string;
  state: ClaudeTerminalRuntimeState;
  transcriptPath?: string;
  cwd?: string;
  /** Interface mode of the owning tab at launch time. */
  interfaceMode: ChatInterfaceMode;
  /** Model configured on the owning tab at launch time, for audit entries. */
  model?: ChatModel;
  /** Assistant runtime that owns this terminal. */
  assistantMode: 'default' | 'app-advisor';
  /** Native planning posture, independent of the session's tool approval policy. */
  planMode: boolean;
  /** True while an audit chat-turn entry is open for this terminal. */
  auditTurnOpen: boolean;
  /**
   * Synthetic per-turn message id for the currently open audit turn. Terminal
   * turns have no renderer-minted `userMessageId`, so one is minted here to
   * give turn-level feedback (CAN-1521) a stable correlation key. Cleared
   * whenever the audit turn closes so it is never reused across turns.
   */
  auditUserMessageId?: string;
  /** ID of the scheduler input bound to this terminal turn at prompt submit. */
  automationTurnInputId?: string;
  /** Exact admitted plan input carried by the managed terminal prompt marker. */
  planImplementationUserMessageId?: string;
  suspendedPlanImplementationUserMessageId?: string;
  /** Admitted delivery not yet acknowledged by its matching hook. */
  pendingPlanImplementationUserMessageId?: string;
  /** Unix-ms when the PTY spawned, anchoring first-output latency metrics. */
  spawnedAt?: number;
  /** Token usage accumulated from assistant events during the open turn. */
  turnUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  /** True while a git checkpoint snapshot is open for the active terminal turn. */
  turnDiffCaptureActive: boolean;
  /** True while an explicit user interrupt is settling this running turn. */
  interruptSettling?: boolean;
  /** Blocks late approval hooks until the next user turn starts. */
  approvalTurnCancelled?: boolean;
  resumeHandlerUnsubscribe?: () => void;
  appAdvisorRuntime?: AppAdvisorToolRuntime;
  deferredToolsReloadContinuation?: {
    planImplementationUserMessageId?: string;
    text: string;
    enabledResources: DeferredResourceSummary[];
    /** The interrupted turn's id; the relaunch continues the same turn. */
    turnUserMessageId?: string;
  };
  suppressDeferredToolsReloadContinuation?: boolean;
  approvalSession?: ApprovalSessionHandle;
  /** Approval posture materialized into the running CLI process. */
  approvalMode?: ApprovalMode;
  /** Latest mode selected while launch is still creating the approval session. */
  pendingApprovalMode?: ApprovalMode;
  /** Whether this terminal owns a live code-graph tool surface. */
  codeGraphToolsAdvertised?: boolean;
  /** Snapshot of graph availability at the start of the current user turn. */
  codeGraphAvailableThisTurn?: boolean;
  /** Identifies the current user turn for chat-scoped orientation fallback. */
  codeGraphOrientationTurn: object;
  /** True when graph orientation was blocked during the current user turn. */
  codeGraphOrientationBlockedThisTurn?: boolean;
  /** Lazily loaded custom source extensions for the current user turn. */
  codeGraphCustomSourceExtensionsThisTurn?: readonly string[];
  /**
   * The chat's Ledger tools when this terminal process passed the Ledger
   * exposure gate at launch. Its worktree route carries them, so the binding
   * comes from the route's session key and never from tool arguments. They
   * are disposed wherever that route is released.
   */
  ledgerTools?: LedgerChatToolsSession;
  /**
   * Plan-file turn lease held while a turn runs, so edits to the plan files
   * in the chat's real worktree sync back only after the turn ends.
   */
  planTurnLease?: PlanTurnLease;
  /**
   * The running turn's lease carried across a deferred-tools reload. It keeps
   * the scope active until the relaunched CLI's first turn supersedes it, or
   * the relaunched terminal exits or is cleaned up first.
   */
  inheritedPlanTurnLease?: PlanTurnLease;
  /** A Mod admission change waits for the turn to end, then relaunches. */
  relaunchWhenIdle?: boolean;
}

type InterruptSource =
  | 'renderer-escape'
  | 'terminal-running-changed'
  | 'terminal-output';

export interface ClaudeTerminalLaunchRuntimeOptions {
  appAdvisorRuntime?: AppAdvisorToolRuntime;
  getWindow?: () => BrowserWindow | null;
  pluginSelections?: ChatTabPluginSelections;
  /** Trusted persisted context for an automation or hook-owned launch. */
  executionContext?: string;
  /** The launch came from the Remote Control bridge; its terminal stays in process (CAN-5097). */
  fromRemoteBridge?: boolean;
  /** Preserved only for an in-process deferred-reload continuation. */
  watcherRuntimeGeneration?: string;
  deferredToolsReloadContinuation?: {
    planImplementationUserMessageId?: string;
    text: string;
    enabledResources: DeferredResourceSummary[];
    /** The interrupted turn's id; the relaunch continues the same turn. */
    turnUserMessageId?: string;
  };
}

export interface HookStateUpdate {
  sessionKey: string;
  hookEventName: ClaudeTerminalHookEventName;
  hookPayload: unknown;
}

/**
 * Request emitted when a terminal-mode chat imports its first user message
 * and is eligible for its initial title. The registered scheduler runs the
 * same chat-summary helper used by Canopy-native sends.
 */
export interface ClaudeTerminalChatSummaryRequest {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** Owner bound when the terminal session launched, including omission. */
  workOwner: Promise<WorkOwner | undefined>;
}

export type ClaudeTerminalChatSummaryScheduler = (
  request: ClaudeTerminalChatSummaryRequest,
) => void;

interface ProcessedTranscriptSyncResult {
  result: TranscriptSyncResultWithMessages;
  event?: ClaudeTerminalTranscriptSyncEventData;
}

export interface ClaudeTerminalSessionService {
  getActiveChatInput(
    target: ChatLifecycleTarget,
  ): ReturnType<ActiveChatInputProvider['getActiveChatInput']>;
  resumePendingObservations(target: ChatLifecycleTarget): Promise<void>;
  retainPlanImplementationDelivery(
    target: ChatLifecycleTarget & { userMessageId: string },
  ): void;
  recordPlanImplementationWriteFailure(
    terminalId: string,
    idempotencyKey?: string,
  ): Promise<void> | undefined;
  authorizeAgentInputTerminalWrite(
    terminalId: string,
    idempotencyKey?: string,
  ): Promise<void> | undefined;
  getChatForTerminal(
    terminalId: string,
  ): { projectId: string; worktreeId: string; chatId: string } | undefined;
  launch(
    request: ClaudeTerminalLaunchRequest,
    options?: ClaudeTerminalLaunchRuntimeOptions,
  ): Promise<ClaudeTerminalLaunchResponse>;
  cleanup(request: ClaudeTerminalCleanupRequest): Promise<void>;
  getState(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): ClaudeTerminalRuntimeState | undefined;
  setPlanMode(
    projectId: string,
    worktreeId: string,
    chatId: string,
    enabled: boolean,
  ): Promise<void>;
  /**
   * Tears down a chat's idle live terminal after a settings change made
   * without a window (CAN-5097 D13), as the renderer's
   * restartClaudeTerminalForSettingsChange does; the next send relaunches
   * it with the new arguments. A running, stopping, exited or failed
   * terminal is left alone, so the change applies at its next launch.
   */
  restartForSettingsChange(target: ChatLifecycleTarget): Promise<void>;
  setApprovalMode(
    projectId: string,
    worktreeId: string,
    chatId: string,
    mode: ApprovalMode,
  ): Promise<void>;
  /** Ends auto-mode terminals after a Mod admission change; see the class. */
  relaunchForModAdmissionChange(scope: 'skipped' | 'all'): void;
  updateDeferredToolsContext(
    projectId: string,
    worktreeId: string,
    chatId: string,
    context: {
      pluginSelections: ChatTabPluginSelections;
      deferredToolsAllowed?: boolean;
    },
  ): void;
  interrupt(request: ClaudeTerminalInterruptRequest): Promise<void>;
  syncTranscriptForChat(
    request: ClaudeTerminalSyncTranscriptRequest,
  ): Promise<ClaudeTerminalSyncTranscriptResponse>;
  markHookState(input: HookStateUpdate): Promise<void>;
  runningAutomationTurn(target: ChatLifecycleTarget): boolean;
  /** The id of the terminal turn the chat is running, if any. */
  runningTurnUserMessageId(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string | undefined;
  syncTranscript(
    input: TranscriptSyncRequest,
  ): Promise<TranscriptSyncResultWithMessages>;
  cleanupWorktree(projectId: string, worktreeId: string): Promise<void>;
  shutdown(options?: { recordInterrupted?: boolean }): Promise<void>;
  setEventSender(sender: EventSender): void;
  setChatSummaryScheduler(scheduler: ClaudeTerminalChatSummaryScheduler): void;
}

function runtimeKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}\0${worktreeId}\0${chatId}`;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!isUnknownRecord(value)) {
    return undefined;
  }
  const fieldValue = value[field];
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}

function importedTurnCompletionMessage(
  result: TranscriptSyncResultWithMessages,
): boolean {
  return result.importedMessages.some((message) =>
    message.blocks.some((block) => block.type === 'turn_timer'),
  );
}

function shouldScheduleTrailingTranscriptSync(
  hookEventName: ClaudeTerminalHookEventName,
  result: TranscriptSyncResultWithMessages,
): boolean {
  if (hookEventName === 'StopFailure') {
    return true;
  }
  if (hookEventName !== 'Stop') {
    return false;
  }
  const importedUserMessage = result.importedMessages.some(
    (message) => message.role === 'user',
  );
  const importedAssistantMessage = result.importedMessages.some(
    (message) => message.role === 'assistant',
  );
  if (importedUserMessage && !importedAssistantMessage) {
    return true;
  }
  // Claude appends the `turn_duration` line (the turn timer) only after every
  // Stop hook — including the Canopy callback that drives this very sync —
  // has returned, so the Stop-time sync reliably misses it. Keep syncing
  // briefly until the completed turn timer lands.
  return !importedTurnCompletionMessage(result);
}

const TRANSCRIPT_PATH_HOOK_EVENTS = new Set<ClaudeTerminalHookEventName>([
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'SessionEnd',
  'PostCompact',
]);

const CLEANUP_REASONS_THAT_PERSIST_EXIT_STATE =
  new Set<ClaudeTerminalCleanupReason>([
    'switch-to-native-send',
    'app-shutdown',
    'auto-idle-ttl',
    'settings-change',
    'manual',
  ]);
const WORKTREE_SETUP_FAILED = 'The worktree could not be set up.';
const WORKTREE_SETUP_CANCELLED = 'Setup for this worktree was cancelled.';
const CLAUDE_TERMINAL_HANDOFF_CHAR_LIMIT = 16_000;
const TRAILING_TRANSCRIPT_SYNC_DELAY_MS = 750;
// Post-Stop hooks (the user's own Stop hooks run alongside Canopy's) can
// delay the `turn_duration` transcript line by several seconds; retry the
// trailing sync a few times before giving up on the turn timer.
const MAX_TRAILING_TRANSCRIPT_SYNC_ATTEMPTS = 4;
const INTERRUPT_TRANSCRIPT_SYNC_DELAY_MS =
  process.env.NODE_ENV === 'test' ? 0 : TRAILING_TRANSCRIPT_SYNC_DELAY_MS;
// Auto-mode terminals are hidden between turns, so an idle process is pure
// background cost. After this much idle time the process is reaped; the next
// send relaunches with the prompt as the CLI's initial argument and resumes
// the same Claude session.
const CLAUDE_TERMINAL_AUTO_IDLE_TTL_MS = 10 * 60_000;
const NODE_SIGNAL_NAMES = new Set<string>([
  'SIGABRT',
  'SIGALRM',
  'SIGBUS',
  'SIGCHLD',
  'SIGCONT',
  'SIGFPE',
  'SIGHUP',
  'SIGILL',
  'SIGINT',
  'SIGIO',
  'SIGIOT',
  'SIGKILL',
  'SIGPIPE',
  'SIGPOLL',
  'SIGPROF',
  'SIGPWR',
  'SIGQUIT',
  'SIGSEGV',
  'SIGSTKFLT',
  'SIGSTOP',
  'SIGSYS',
  'SIGTERM',
  'SIGTRAP',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGUNUSED',
  'SIGURG',
  'SIGUSR1',
  'SIGUSR2',
  'SIGVTALRM',
  'SIGWINCH',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGBREAK',
  'SIGLOST',
  'SIGINFO',
]);

function isNodeSignal(value: string): value is NodeJS.Signals {
  return NODE_SIGNAL_NAMES.has(value);
}

function toNodeSignal(value: string | null): NodeJS.Signals | null {
  if (value === null) {
    return null;
  }
  return isNodeSignal(value) ? value : null;
}

export {
  claudeProjectDirCandidates,
  findClaudeCodeSessionTranscriptInProjectsDir,
} from '../lib/claude-project-paths';

export function claudeCodeSessionTranscriptExists(
  sdkSessionId: string,
  cwd: string,
): Promise<boolean> {
  return resolveClaudeCodeSessionTranscriptPath(sdkSessionId, cwd).then(
    Boolean,
  );
}

function blockToHandoffText(block: PersistedChatBlock): string | null {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'thinking':
      return `[thinking]\n${block.text}`;
    case 'file_references':
      return `[file references]\n${block.references
        .map((reference) => reference.displayPath || reference.absolutePath)
        .join('\n')}`;
    case 'tool_use':
      return `[tool use: ${block.toolName}]\n${block.input}`;
    case 'tool_result':
      return `[tool result: ${block.toolName}${
        block.isError ? ' error' : ''
      }]\n${block.output}`;
    case 'compaction_info':
      return `[context compacted]\n${block.summary ?? block.reason ?? ''}`;
    default:
      return null;
  }
}

function messageToHandoffText(message: PersistedChatMessage): string | null {
  const body = message.blocks
    .map(blockToHandoffText)
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n\n')
    .trim();
  if (!body) {
    return null;
  }
  return `${message.role.toUpperCase()}:\n${body}`;
}

function buildClaudeTerminalHandoffPrompt(
  messages: PersistedChatMessage[],
  sdkSessionId: string,
): string | undefined {
  const transcriptText = messages
    .map(messageToHandoffText)
    .filter((part): part is string => Boolean(part))
    .join('\n\n---\n\n')
    .trim();
  if (!transcriptText) {
    return undefined;
  }
  const clippedText =
    transcriptText.length > CLAUDE_TERMINAL_HANDOFF_CHAR_LIMIT
      ? transcriptText.slice(-CLAUDE_TERMINAL_HANDOFF_CHAR_LIMIT)
      : transcriptText;
  return `<${BRAND.tools.namespace}_terminal_session_handoff>
Claude Code could not find a local Claude Code transcript file for ${BRAND.displayName} session ${sdkSessionId}. Continue from the ${BRAND.displayName}-native transcript context below. Do not mention this handoff unless it is directly relevant.

${clippedText}
</${BRAND.tools.namespace}_terminal_session_handoff>`;
}

function joinSystemPromptSegments(
  segments: Array<string | undefined>,
): string | undefined {
  const text = segments
    .filter((segment): segment is string => Boolean(segment?.trim()))
    .join('\n\n');
  return text || undefined;
}

function isAppAdvisorTerminalRequest(
  request: ClaudeTerminalLaunchRequest,
): boolean {
  return (
    request.assistantMode === 'app-advisor' || isBotProjectId(request.projectId)
  );
}

// App Advisor is a global assistant: it operates the app through tools and
// actions, not through its process cwd. The managed terminal always runs from
// the dedicated App Advisor home directory, never the worktree selected in
// the main window — pointing it at a worktree leaked that checkout's
// files/CLAUDE.md/git context into every global session. The directory is
// created on demand since no workspace machinery owns it.
async function resolveAppAdvisorTerminalCwd(): Promise<{
  cwd: string;
  trustCwds: string[];
}> {
  await ensureAppAdvisorHomeScaffold();
  const cwd = getAppAdvisorHomeDir();
  return { cwd, trustCwds: [cwd] };
}

function emptyTurnUsage(): RuntimeRecord['turnUsage'] {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

function shouldCaptureTerminalTurnDiff(record: RuntimeRecord): boolean {
  return (
    !isCoworkWorkspace(record.projectId) &&
    !isBotProjectId(record.projectId) &&
    record.assistantMode !== 'app-advisor'
  );
}

function shouldCloseTerminalTurnDiff(
  hookEventName: ClaudeTerminalHookEventName,
): boolean {
  return (
    hookEventName === 'Stop' ||
    hookEventName === 'StopFailure' ||
    hookEventName === 'SessionEnd'
  );
}

function readNumberField(value: unknown, field: string): number | undefined {
  if (!isUnknownRecord(value)) {
    return undefined;
  }
  const fieldValue = value[field];
  return typeof fieldValue === 'number' ? fieldValue : undefined;
}

/**
 * Accumulate token usage from a raw Claude transcript assistant event.
 * Output and cache-creation tokens add up across API calls; input and
 * cache-read tokens reflect the final context, so the latest value wins.
 */
function accumulateTurnUsage(
  usage: RuntimeRecord['turnUsage'],
  event: unknown,
): void {
  if (!isUnknownRecord(event) || event.type !== 'assistant') {
    return;
  }
  const message = event.message;
  const messageUsage = isUnknownRecord(message) ? message.usage : undefined;
  if (!isUnknownRecord(messageUsage)) {
    return;
  }
  usage.outputTokens += readNumberField(messageUsage, 'output_tokens') ?? 0;
  usage.cacheCreationInputTokens +=
    readNumberField(messageUsage, 'cache_creation_input_tokens') ?? 0;
  const inputTokens = readNumberField(messageUsage, 'input_tokens');
  if (inputTokens !== undefined) {
    usage.inputTokens = inputTokens;
  }
  const cacheRead = readNumberField(messageUsage, 'cache_read_input_tokens');
  if (cacheRead !== undefined) {
    usage.cacheReadInputTokens = cacheRead;
  }
}

function nextTurnState(
  eventName: ClaudeTerminalHookEventName,
  previous: ClaudeTerminalRuntimeState['turnState'],
): ClaudeTerminalRuntimeState['turnState'] {
  switch (eventName) {
    case 'SessionStart':
      return 'idle';
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'running';
    case 'SubagentStart':
    case 'SubagentStop':
      return previous;
    case 'Stop':
      return 'idle';
    case 'StopFailure':
      return 'idle';
    case 'SessionEnd':
      return 'exited';
    case 'Notification':
    case 'PostCompact':
      return previous;
  }
}

export class DefaultClaudeTerminalSessionService implements ClaudeTerminalSessionService {
  private shutdownStarted = false;
  private records = new Map<string, RuntimeRecord>();
  private hookTails = new Map<string, Promise<void>>();
  private recoveringWatchers = new Set<string>();
  private watcherRecoveryStopped = false;
  private recordsByTerminalId = new Map<string, RuntimeRecord>();
  private pendingPlanModes = new Map<string, boolean>();
  private pendingApprovalModes = new Map<string, ApprovalMode>();
  private inflightLaunches = new Map<
    string,
    Promise<ClaudeTerminalLaunchResponse>
  >();
  private inflightTranscriptSyncs = new Map<
    string,
    Promise<ProcessedTranscriptSyncResult>
  >();
  private trailingSyncTimers = new Map<string, NodeJS.Timeout>();
  private idleTtlTimers = new Map<string, NodeJS.Timeout>();
  /** Terminal ids spawned by this service that have not produced output yet. */
  private pendingFirstOutputTerminalIds = new Set<string>();
  private terminalOutputDetectionTails = new Map<string, string>();
  private eventSender: EventSender = () => {};
  private chatSummaryScheduler: ClaudeTerminalChatSummaryScheduler = () => {};

  public constructor() {
    if (typeof workerTerminal.addEventListener === 'function') {
      workerTerminal.addEventListener((event) => {
        this.handleTerminalEvent(event);
      });
    }
  }

  public setEventSender(sender: EventSender): void {
    this.eventSender = sender;
  }

  public setChatSummaryScheduler(
    scheduler: ClaudeTerminalChatSummaryScheduler,
  ): void {
    this.chatSummaryScheduler = scheduler;
  }

  /** Called only after main verifies the canonical admitted implementation. */
  public retainPlanImplementationDelivery(
    target: ChatLifecycleTarget & { userMessageId: string },
  ): void {
    const record = this.records.get(
      runtimeKey(target.projectId, target.worktreeId, target.chatId),
    );
    if (record && isLiveClaudeTerminal(record.state)) {
      record.pendingPlanImplementationUserMessageId = target.userMessageId;
    }
  }

  /** A refused transport write cannot leave its admitted input active. */
  public recordPlanImplementationWriteFailure(
    terminalId: string,
    idempotencyKey?: string,
  ): Promise<void> | undefined {
    const record = this.recordsByTerminalId.get(terminalId);
    const userMessageId = record?.pendingPlanImplementationUserMessageId;
    if (!record || !userMessageId || !idempotencyKey) return;
    const suffix = idempotencyKey.slice(userMessageId.length);
    if (
      !idempotencyKey.startsWith(userMessageId) ||
      !['-clear-0', '-clear-1', '-clear-2', '-paste', '-submit'].includes(
        suffix,
      )
    )
      return;
    return getChatStateService()
      .recordTerminalPlanImplementation(
        {
          projectId: record.projectId,
          worktreeId: record.worktreeId,
          chatId: record.chatId,
          userMessageId,
        },
        'failed',
      )
      .then(() => {
        if (record.pendingPlanImplementationUserMessageId === userMessageId)
          delete record.pendingPlanImplementationUserMessageId;
      });
  }

  /** Core policy for delayed managed-terminal input; ordinary writes keep their synchronous path. */
  public authorizeAgentInputTerminalWrite(
    terminalId: string,
    idempotencyKey?: string,
  ): Promise<void> | undefined {
    if (
      typeof idempotencyKey !== 'string' ||
      hasTerminalWriteReceipt(terminalId, idempotencyKey)
    )
      return;
    const target = this.getChatForTerminal(terminalId);
    if (!target) return;
    if (idempotencyKey.endsWith('-paste'))
      return this.authorizeRetainedPaste(
        target,
        idempotencyKey.slice(0, -'-paste'.length),
      );
    // The delayed Enter rechecks the retained input: a cancel between the
    // paste and the submit must not send the withdrawn text.
    if (idempotencyKey.endsWith('-submit'))
      return getChatStateService().authorizeRetainedTerminalAgentInputWrite(
        target,
        idempotencyKey.slice(0, -'-submit'.length),
      );
    return;
  }

  private async authorizeRetainedPaste(
    target: ChatLifecycleTarget,
    inputId: string,
  ): Promise<void> {
    // Access can change during the awaited checks; re-run them so the paste
    // never relies on a stale decision. The caller writes in this continuation.
    let watcherDeliveryId: string | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const authority = watcherDeliveryAuthorityGeneration();
      watcherDeliveryId = await this.checkRetainedPaste(target, inputId);
      if (watcherDeliveryAuthorityGeneration() !== authority) continue;
      if (watcherDeliveryId) {
        // Terminal pastes never reach the chat queue, which releases queued
        // deliveries. A refused write still releases through delivery failure.
        // Detached: no await may separate the ingress decision from the paste.
        void getAppAdvisorWatcherService()
          .releaseChatDeliveryAuthority(watcherDeliveryId)
          .catch((error: unknown) => {
            logMainProcessWarn(
              '[claude-terminal] Watcher delivery release failed:',
              error,
            );
          });
      }
      return;
    }
    if (watcherDeliveryId)
      throw new WatcherDeliveryHeldError('runtime_unavailable');
    throw new Error('Chat access changed while this input was authorized.');
  }

  /** Returns the watcher delivery ID to release when the paste may proceed. */
  private async checkRetainedPaste(
    target: ChatLifecycleTarget,
    inputId: string,
  ): Promise<string | undefined> {
    const tabs = await readChatTabsFile(target.projectId, target.worktreeId);
    const tab = tabs.tabs.find((candidate) => candidate.id === target.chatId);
    const row =
      tab && isInputLedger(tab.inputDelivery)
        ? tab.inputDelivery.rows.find((candidate) => candidate.id === inputId)
        : undefined;
    await getChatStateService().authorizeRetainedTerminalAgentInputWrite(
      target,
      inputId,
    );
    const watcherDeliveryId =
      row?.payload.watcherDeliveryId ??
      (inputId.startsWith('watcher-')
        ? inputId.slice('watcher-'.length)
        : undefined);
    if (watcherDeliveryId) {
      const access = await checkWatcherDeliveryIngress({
        ...row?.payload,
        ...target,
        watcherDeliveryId,
        watcherFired: row?.payload.watcherFired || true,
      });
      if (!access.allowed) throw new WatcherDeliveryHeldError(access.reason);
    }
    return watcherDeliveryId;
  }

  public getActiveChatInput(
    target: ChatLifecycleTarget,
  ): Promise<
    Awaited<ReturnType<ActiveChatInputProvider['getActiveChatInput']>>
  > {
    const record = this.records.get(
      runtimeKey(target.projectId, target.worktreeId, target.chatId),
    );
    if (!record) return Promise.resolve({ state: 'unknown' });
    const active = record.watcherObservations
      ?.slice()
      .reverse()
      .find((item) => !item.terminalAt);
    if (record.state.turnState === 'running')
      return Promise.resolve(
        active?.sourceInputId
          ? { state: 'active', inputId: active.sourceInputId }
          : { state: 'unknown' },
      );
    if (active)
      return Promise.resolve(
        active.sourceInputId
          ? { state: 'pending', inputId: active.sourceInputId }
          : { state: 'unknown' },
      );
    return Promise.resolve(
      record.state.turnState === 'idle'
        ? { state: 'idle' }
        : { state: 'unknown' },
    );
  }

  public async resumePendingObservations(
    target: ChatLifecycleTarget,
  ): Promise<void> {
    const key = runtimeKey(target.projectId, target.worktreeId, target.chatId);
    // Watcher matching may enrich through getState, which re-enters recovery.
    // Never await our own publish/import promise on that recursive read.
    if (this.recoveringWatchers.has(key)) return;
    this.recoveringWatchers.add(key);
    try {
      const record = this.records.get(
        runtimeKey(target.projectId, target.worktreeId, target.chatId),
      );
      if (record) {
        await this.syncTranscriptForChat(target);
        return;
      }
      const tabs = await readChatTabsFile(target.projectId, target.worktreeId);
      const tab = tabs.tabs.find((candidate) => candidate.id === target.chatId);
      const observations = await readTerminalWatcherObservations(
        getClaudeTerminalRuntimeDir(
          target.projectId,
          target.worktreeId,
          target.chatId,
        ),
      );
      if (!tab || observations.length === 0) return;
      const recovered: RuntimeRecord = {
        ...target,
        runtimeDir: getClaudeTerminalRuntimeDir(
          target.projectId,
          target.worktreeId,
          target.chatId,
        ),
        authToken: '',
        // No live record means this is recovery, never the old CLI generation.
        watcherRuntimeGeneration: randomUUID(),
        state: tab.claudeTerminal ?? { turnState: 'exited' },
        interfaceMode: tab.interfaceMode ?? 'claude-code',
        assistantMode: isBotProjectId(target.projectId)
          ? 'app-advisor'
          : 'default',
        planMode: false,
        auditTurnOpen: false,
        turnUsage: emptyTurnUsage(),
        turnDiffCaptureActive: false,
        codeGraphOrientationTurn: {},
        watcherObservations: observations,
      };
      this.reconcileAbandonedWatcherObservations(recovered);
      if (
        observations.some(
          (item) => !item.terminalDelivered && !item.transcriptPath,
        ) &&
        tab.sdkSessionId
      ) {
        const cwd = isBotProjectId(target.projectId)
          ? getAppAdvisorHomeDir()
          : resolveWorktreeCwd(target.projectId, target.worktreeId);
        const transcriptPath = await resolveClaudeCodeSessionTranscriptPath(
          tab.sdkSessionId,
          cwd,
        );
        if (transcriptPath) {
          for (const observation of observations) {
            if (!observation.terminalDelivered && !observation.transcriptPath)
              observation.transcriptPath = transcriptPath;
          }
          recovered.watcherObservationsDirty = true;
        }
      }
      let synced = false;
      for (const transcriptPath of Array.from(
        new Set(
          observations
            .filter((item) => !item.terminalDelivered)
            .map((item) => item.transcriptPath),
        ),
      )) {
        if (!transcriptPath) continue;
        synced = true;
        await this.syncTranscriptForRecord(recovered, {
          ...target,
          sessionKey: tab.claudeTerminal?.sessionKey ?? '',
          sdkSessionId: tab.sdkSessionId ?? '',
          transcriptPath,
          runtimeDir: recovered.runtimeDir,
          hookEventName: 'Notification',
          hookPayload: { source: 'watcher-recovery' },
        });
      }
      if (!synced) await this.publishWatcherObservations(recovered);
    } finally {
      this.recoveringWatchers.delete(key);
    }
  }

  public getChatForTerminal(
    terminalId: string,
  ): { projectId: string; worktreeId: string; chatId: string } | undefined {
    const record = this.recordsByTerminalId.get(terminalId);
    return record
      ? {
          projectId: record.projectId,
          worktreeId: record.worktreeId,
          chatId: record.chatId,
        }
      : undefined;
  }

  public runningAutomationTurn(target: ChatLifecycleTarget): boolean {
    return (
      this.records.get(
        runtimeKey(target.projectId, target.worktreeId, target.chatId),
      )?.automationTurnInputId !== undefined
    );
  }

  /**
   * The id of the terminal turn the chat is running: minted when the turn
   * opens and cleared when it closes, and kept across a deferred-tools
   * relaunch, which continues the same turn.
   */
  public runningTurnUserMessageId(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string | undefined {
    const record = this.records.get(runtimeKey(projectId, worktreeId, chatId));
    return record?.auditTurnOpen ? record.auditUserMessageId : undefined;
  }

  public getState(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): ClaudeTerminalRuntimeState | undefined {
    return this.records.get(runtimeKey(projectId, worktreeId, chatId))?.state;
  }

  public async restartForSettingsChange(
    target: ChatLifecycleTarget,
  ): Promise<void> {
    const record = this.records.get(
      runtimeKey(target.projectId, target.worktreeId, target.chatId),
    );
    if (!record?.state.terminalId) return;
    const { turnState } = record.state;
    if (
      turnState === 'running' ||
      turnState === 'cleaning_up' ||
      turnState === 'exited' ||
      turnState === 'error'
    )
      return;
    await this.cleanupRecord(record, 'settings-change');
  }

  public async setPlanMode(
    projectId: string,
    worktreeId: string,
    chatId: string,
    enabled: boolean,
  ): Promise<void> {
    const key = runtimeKey(projectId, worktreeId, chatId);
    const record = this.records.get(key);
    if (!record) {
      this.pendingPlanModes.set(key, enabled);
      return;
    }
    const changed = enabled !== record.planMode;
    record.planMode = enabled;
    if (changed) {
      this.pendingPlanModes.set(key, enabled);
      await this.cleanupRecord(record, 'settings-change');
    }
  }

  public async setApprovalMode(
    projectId: string,
    worktreeId: string,
    chatId: string,
    mode: ApprovalMode,
  ): Promise<void> {
    const key = runtimeKey(projectId, worktreeId, chatId);
    const record = this.records.get(key);
    if (!record) {
      this.pendingApprovalModes.set(key, mode);
      return;
    }
    const leavingFullAccess =
      record.approvalMode === 'full-access' && mode !== 'full-access';
    const changed = record.approvalMode !== mode;
    record.approvalMode = mode;
    if (changed) {
      // The renderer persists the tab separately. Retain the accepted runtime
      // transition so a deferred-tools relaunch cannot reconstruct a stale,
      // more-permissive mode before that persistence finishes.
      this.pendingApprovalModes.set(key, mode);
    }
    if (leavingFullAccess) {
      await this.cleanupRecord(record, 'settings-change');
      return;
    }
    if (record.approvalSession) {
      record.approvalSession.setMode(mode);
      return;
    }
    record.pendingApprovalMode = mode;
  }

  public updateDeferredToolsContext(
    projectId: string,
    worktreeId: string,
    chatId: string,
    context: {
      pluginSelections: ChatTabPluginSelections;
      deferredToolsAllowed?: boolean;
    },
  ): void {
    const runtime = this.records.get(runtimeKey(projectId, worktreeId, chatId))
      ?.appAdvisorRuntime?.deferredToolsRuntime;
    if (!runtime) {
      return;
    }
    runtime.pluginSelections = context.pluginSelections;
    if (typeof context.deferredToolsAllowed === 'boolean') {
      runtime.allowed = context.deferredToolsAllowed;
    }
  }

  public setDeferredToolsReloadContinuationSuppressedForTests(
    projectId: string,
    worktreeId: string,
    chatId: string,
    suppressed: boolean,
  ): void {
    const record = this.records.get(runtimeKey(projectId, worktreeId, chatId));
    if (record) {
      record.suppressDeferredToolsReloadContinuation = suppressed;
    }
  }

  public async launch(
    request: ClaudeTerminalLaunchRequest,
    options: ClaudeTerminalLaunchRuntimeOptions = {},
  ): Promise<ClaudeTerminalLaunchResponse> {
    // Preserve canonical history on renderer snapshots. The snapshot is not
    // trusted, but it is only an input when no main-owned tab exists; the
    // fallback path checks it immediately before persisting it.
    const requestFields = { ...request };
    delete requestFields.tabSnapshot;
    assertUntrustedChatInput(requestFields);
    if (this.shutdownStarted)
      throw new Error(
        'Application is stopping. Resume this chat after restart.',
      );
    const key = runtimeKey(
      request.projectId,
      request.worktreeId,
      request.chatId,
    );
    const pending = this.inflightLaunches.get(key);
    if (pending) {
      return pending;
    }
    const launchPromise = this.launchInternal(request, key, options)
      .catch(async (error: unknown) => {
        const userMessageId = terminalPresentationTurnId(request.initialPrompt);
        if (userMessageId) {
          await getChatStateService().recordTerminalPlanImplementation(
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
              userMessageId,
            },
            'failed',
          );
        }
        throw error;
      })
      .finally(() => {
        this.inflightLaunches.delete(key);
      });
    this.inflightLaunches.set(key, launchPromise);
    return launchPromise;
  }

  private async launchInternal(
    request: ClaudeTerminalLaunchRequest,
    key: string,
    options: ClaudeTerminalLaunchRuntimeOptions,
  ): Promise<ClaudeTerminalLaunchResponse> {
    if (!isClaudeTuiChatsEnabled()) {
      throw new ClaudeTerminalLaunchError(
        'unsupported_provider',
        'Claude Code terminal chat mode is disabled.',
      );
    }
    const existing = this.records.get(key);
    if (existing && isLiveClaudeTerminal(existing.state)) {
      return {
        terminalId: existing.state.terminalId,
        sessionKey: existing.state.sessionKey ?? '',
        sdkSessionId: existing.state.sdkSessionId ?? '',
        state: existing.state,
        initialPromptSubmitted: false,
      };
    }

    // A worktree still getting its Git checkout has no cwd to launch in.
    // Wait without claiming the setup, so the chat send that follows still
    // sees a failed or cancelled outcome.
    const gitSetup = waitForWorktreeGitSetup(
      request.projectId,
      request.worktreeId,
    );
    const gitSetupOutcome = gitSetup ? await gitSetup : 'ready';
    if (gitSetupOutcome !== 'ready') {
      throw new Error(
        gitSetupOutcome === 'cancelled'
          ? WORKTREE_SETUP_CANCELLED
          : WORKTREE_SETUP_FAILED,
      );
    }

    const initialPromptId = terminalPresentationTurnId(request.initialPrompt);
    let initialPlanImplementationId: string | undefined;
    const tab = await enqueueChatTabMutation(
      request.projectId,
      request.worktreeId,
      async () => {
        let currentTabsFile = await readChatTabsFile(
          request.projectId,
          request.worktreeId,
          { chatIds: [request.chatId] },
        );
        let currentTab = currentTabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        // Only main's existing admitted link can bind this pending delivery;
        // a renderer fallback snapshot is not admission evidence.
        const link = currentTab?.trackedPlanImplementation;
        if (link && !link.outcome && link.userMessageId === initialPromptId) {
          initialPlanImplementationId = initialPromptId;
        }
        if (!currentTab && request.tabSnapshot?.id === request.chatId) {
          assertUntrustedChatInput(request.tabSnapshot);
          currentTab = request.tabSnapshot;
          currentTabsFile = {
            version: currentTabsFile.version,
            tabs: [...currentTabsFile.tabs, request.tabSnapshot],
            activeTabId: request.chatId,
          };
          await writeChatTabsFile(
            request.projectId,
            request.worktreeId,
            currentTabsFile,
          );
        }
        return currentTab;
      },
    );
    if (!tab) {
      throw new ClaudeTerminalLaunchError(
        'chat_not_found',
        'Claude Code terminal chat not found.',
      );
    }
    // core.chat.update commits thinking to modelConfig; the renderer keeps both.
    const tabThinkingLevel =
      tab.modelConfig?.thinkingLevel ?? tab.thinkingLevel;
    if (
      request.initialPromptIdempotencyKey &&
      isInputLedger(tab.inputDelivery) &&
      tab.inputDelivery.rows.some(
        (row) =>
          row.id === request.initialPromptIdempotencyKey &&
          row.attempts.some(
            (attempt) => attempt.generation === 'managed-terminal',
          ),
      )
    ) {
      await this.authorizeRetainedPaste(
        {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: request.chatId,
        },
        request.initialPromptIdempotencyKey,
      );
    }
    if (existing) {
      await this.cleanupRecord(existing, 'manual');
    }
    captureSessionWorkOwner({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: request.chatId,
      ...(options.executionContext !== undefined
        ? { executionContext: options.executionContext }
        : {}),
    });
    const provider =
      tab.providerType ??
      (tab.model ? getProviderForModel(tab.model) : 'claude');
    const source =
      (tab.model ? getModelSource(tab.model) : undefined) ??
      (provider === 'codex'
        ? 'codex-managed'
        : provider === 'ollama'
          ? 'ollama'
          : 'claude-managed');
    if (source !== 'claude-managed') {
      throw new ClaudeTerminalLaunchError(
        'unsupported_provider',
        'Claude Code terminal mode is only available for Claude chats.',
      );
    }
    const pluginSelections = options.pluginSelections ?? tab.pluginSelections;
    const deferredToolsAllowed = tab.deferredToolsAllowed !== false;
    if (options.appAdvisorRuntime?.deferredToolsRuntime) {
      options.appAdvisorRuntime.deferredToolsRuntime.providerType = provider;
      options.appAdvisorRuntime.deferredToolsRuntime.pluginSelections =
        pluginSelections;
      options.appAdvisorRuntime.deferredToolsRuntime.allowed =
        deferredToolsAllowed;
    }
    const authStatus = await getCachedClaudeAuthStatusObserved(
      'claude-terminal-launch',
      { forceRefresh: true },
    );
    if (!authStatus.authenticated) {
      const message =
        authStatus.error === 'Claude CLI is not installed.'
          ? authStatus.error
          : 'Claude is not authenticated. Sign in from Settings before using terminal mode.';
      throw new ClaudeTerminalLaunchError('claude_not_authenticated', message);
    }

    // Interactive Claude Code supports only whole-session `--resume`; it
    // cannot honor the point-in-time anchor required by a truncated fork.
    // Move such a fork to a new terminal session and seed it from the kept
    // transcript instead of exposing the discarded source-session tail.
    const requiresPointInTimeForkHandoff =
      tab.forkedFrom?.resumePointRequired === true &&
      tab.claudeForkSessionOnNextSend === true;
    const existingSdkSessionId = requiresPointInTimeForkHandoff
      ? undefined
      : tab.sdkSessionId;
    const sdkSessionId = existingSdkSessionId ?? randomUUID();
    const persistForkHandoffAfterSpawn =
      !existingSdkSessionId && requiresPointInTimeForkHandoff;
    if (!existingSdkSessionId && !persistForkHandoffAfterSpawn) {
      await this.persistTabState(
        request.projectId,
        request.worktreeId,
        request.chatId,
        {
          sdkSessionId,
        },
      );
    }

    const appAdvisorMode = isAppAdvisorTerminalRequest(request);
    const botId =
      botIdForProjectId(request.projectId) ??
      (request.assistantMode === 'app-advisor' ? APP_ADVISOR_BOT_ID : null);
    // Preserve the tab's auto mode instead of forcing `'claude-code'` —
    // the renderer derives the rendered surface from this value.
    const interfaceMode: ChatInterfaceMode =
      request.interfaceMode === 'auto' ? 'auto' : 'claude-code';
    const sessionKey = randomUUID();
    const authToken = randomBytes(32).toString('base64url');
    const runtimeDir = getClaudeTerminalRuntimeDir(
      request.projectId,
      request.worktreeId,
      request.chatId,
    );
    const state: ClaudeTerminalRuntimeState = {
      turnState: 'starting',
      sessionKey,
      sdkSessionId,
      startedAt: Date.now(),
    };
    const pendingPlanMode = this.pendingPlanModes.get(key);
    const pendingApprovalMode = this.pendingApprovalModes.get(key);
    const initialAutomationInput =
      initialPromptId && initialPromptId === request.initialPromptIdempotencyKey
        ? retainedTerminalInput(tab, initialPromptId)
        : undefined;
    const record: RuntimeRecord = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: request.chatId,
      runtimeDir,
      authToken,
      watcherRuntimeGeneration: options.watcherRuntimeGeneration ?? sessionKey,
      state,
      interfaceMode,
      model: tab.model,
      assistantMode: appAdvisorMode ? 'app-advisor' : 'default',
      planMode: pendingPlanMode ?? tab.planMode === true,
      auditTurnOpen: false,
      ...(initialAutomationInput && isAutomationRunInput(initialAutomationInput)
        ? { automationTurnInputId: initialPromptId }
        : {}),
      ...(initialPlanImplementationId
        ? {
            pendingPlanImplementationUserMessageId: initialPlanImplementationId,
          }
        : {}),
      ...(options.deferredToolsReloadContinuation
        ?.planImplementationUserMessageId
        ? {
            planImplementationUserMessageId:
              options.deferredToolsReloadContinuation
                .planImplementationUserMessageId,
          }
        : {}),
      codeGraphOrientationTurn: {},
      turnUsage: emptyTurnUsage(),
      turnDiffCaptureActive: false,
      ...(pendingApprovalMode !== undefined ? { pendingApprovalMode } : {}),
      ...(options.appAdvisorRuntime
        ? { appAdvisorRuntime: options.appAdvisorRuntime }
        : {}),
      ...(options.deferredToolsReloadContinuation
        ? {
            deferredToolsReloadContinuation:
              options.deferredToolsReloadContinuation,
            suppressDeferredToolsReloadContinuation: true,
          }
        : {}),
    };
    try {
      record.watcherObservations = await readTerminalWatcherObservations(
        record.runtimeDir,
      );
      this.reconcileAbandonedWatcherObservations(record);
      await this.flushDirtyWatcherObservations(record);
    } catch (error) {
      // A watcher store failure is no watcher, never a failed launch. Leave
      // the sidecar untouched; acceptance rereads it and skips on failure.
      record.watcherObservations = undefined;
      record.watcherObservationsDirty = false;
      logMainProcessWarn(
        '[claude-terminal] Watcher observations unavailable at launch:',
        error,
      );
    }
    this.records.set(key, record);
    this.pendingPlanModes.delete(key);
    this.pendingApprovalModes.delete(key);
    record.resumeHandlerUnsubscribe =
      deferredToolsReloadCoordinator.registerResumeHandler(
        {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: request.chatId,
        },
        async (reloadRequest) => {
          reloadRequest.signal.throwIfAborted();
          const current = this.records.get(key);
          // The relaunched CLI continues the running turn, so its plan-file
          // lease stays live across the reload: detach it before cleanup and
          // carry it to the relaunched record, or release it when the
          // relaunch does not happen.
          const reloadPlanTurnLease = current
            ? this.takePlanTurnLease(current)
            : undefined;
          const reloadTurnUserMessageId = current?.auditUserMessageId;
          const reloadPlanImplementationUserMessageId =
            current?.planImplementationUserMessageId;
          const presentationOrigin = {
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            chatTabId: request.chatId,
          };
          const presentationTurn = capturePresentationTurn(presentationOrigin);
          const presentationKey = presentationChatKey(presentationOrigin);
          const continuationText = presentationTurn
            ? terminalPresentationPrompt(
                reloadRequest.continuationText,
                presentationTurn.turnId,
              )
            : reloadRequest.continuationText;
          try {
            if (current) {
              await this.cleanupRecord(current, 'deferred-tools-reload');
            }
            reloadRequest.signal.throwIfAborted();
            if (presentationTurn?.source) {
              stageTerminalPresentationTurn(
                presentationKey,
                presentationTurn.turnId,
                presentationTurn.source,
              );
            }
            await this.launch(
              {
                projectId: request.projectId,
                worktreeId: request.worktreeId,
                chatId: request.chatId,
                assistantMode: request.assistantMode,
                initialPrompt: continuationText,
                selectedRepoId: request.selectedRepoId,
                interfaceMode: reloadRequest.interfaceMode ?? interfaceMode,
                cols: request.cols,
                rows: request.rows,
              },
              {
                ...(record.appAdvisorRuntime
                  ? { appAdvisorRuntime: record.appAdvisorRuntime }
                  : {}),
                ...(options.getWindow ? { getWindow: options.getWindow } : {}),
                ...(options.fromRemoteBridge ? { fromRemoteBridge: true } : {}),
                watcherRuntimeGeneration:
                  current?.watcherRuntimeGeneration ??
                  record.watcherRuntimeGeneration,
                deferredToolsReloadContinuation: {
                  ...(reloadPlanImplementationUserMessageId
                    ? {
                        planImplementationUserMessageId:
                          reloadPlanImplementationUserMessageId,
                      }
                    : {}),
                  text: reloadRequest.continuationText,
                  enabledResources: reloadRequest.enabledResources,
                  ...(reloadTurnUserMessageId
                    ? { turnUserMessageId: reloadTurnUserMessageId }
                    : {}),
                },
                ...(reloadRequest.pluginSelections
                  ? { pluginSelections: reloadRequest.pluginSelections }
                  : {}),
              },
            );
          } catch (error) {
            reloadPlanTurnLease?.end();
            if (current)
              await this.settlePlanImplementation(
                current,
                reloadRequest.signal.aborted ? 'cancelled' : 'failed',
              );
            throw error;
          }
          if (reloadPlanTurnLease) {
            const relaunched = this.records.get(key);
            if (
              relaunched &&
              relaunched !== current &&
              !relaunched.planTurnLease
            ) {
              relaunched.inheritedPlanTurnLease = reloadPlanTurnLease;
            } else {
              // A no-op when the relaunched turn already superseded it.
              reloadPlanTurnLease.end();
            }
          }
          if (reloadRequest.signal.aborted) {
            const interrupted = this.records.get(key);
            if (interrupted)
              await this.settlePlanImplementation(interrupted, 'cancelled');
            await this.cleanup({
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
              reason: 'deferred-tools-reload',
            });
            reloadRequest.signal.throwIfAborted();
          }
        },
      );
    const unsubscribeResume = record.resumeHandlerUnsubscribe;
    const unsubscribeReloadOutcome = deferredToolsReloadCoordinator.subscribe(
      (event) => {
        if (
          event.lifecycle.kind !== 'outcome' ||
          event.scope.projectId !== record.projectId ||
          event.scope.worktreeId !== record.worktreeId ||
          event.scope.chatId !== record.chatId ||
          this.records.get(key) !== record
        )
          return;
        const userMessageId = record.suspendedPlanImplementationUserMessageId;
        if (
          !userMessageId ||
          (record.planImplementationUserMessageId !== userMessageId &&
            record.pendingPlanImplementationUserMessageId !== userMessageId)
        )
          return;
        // A later unrelated Stop must not complete this abandoned attempt,
        // including while its durable failure settlement is still pending.
        delete record.planImplementationUserMessageId;
        delete record.suspendedPlanImplementationUserMessageId;
        record.pendingPlanImplementationUserMessageId = userMessageId;
        void this.settlePlanImplementation(
          record,
          event.lifecycle.outcome === 'cancelled' ? 'cancelled' : 'failed',
        ).catch((error: unknown) => {
          this.recordDiagnostic(record, 'terminal_transcript_sync_failure', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
    );
    record.resumeHandlerUnsubscribe = (): void => {
      unsubscribeResume();
      unsubscribeReloadOutcome();
    };
    try {
      await this.persistTabState(
        request.projectId,
        request.worktreeId,
        request.chatId,
        {
          claudeTerminal: state,
          interfaceMode,
          ...(persistForkHandoffAfterSpawn ? {} : { sdkSessionId }),
        },
      );
    } catch (error) {
      record.resumeHandlerUnsubscribe?.();
      this.records.delete(key);
      this.recordDiagnostic(record, 'claude_terminal_process_error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.emitState(record);

    const server = getDesktopIntegrationServer();
    let routeRegistered = false;
    let terminalId: string;
    try {
      const appAdvisorLaunchContext = appAdvisorMode
        ? await resolveAppAdvisorTerminalCwd()
        : undefined;
      const cwd =
        appAdvisorLaunchContext?.cwd ??
        resolveWorktreeCwd(
          request.projectId,
          request.worktreeId,
          request.selectedRepoId,
        );
      record.cwd = cwd;
      const approvalTarget = resolveWorktreeTargetIds(
        request.projectId,
        request.worktreeId,
      );
      const approvalSurface = approvalTarget
        ? surfaceForChat(approvalTarget.projectId)
        : undefined;
      const [approvalPreferences, workspaceApprovals, manifestApprovals] =
        await Promise.all([
          approvalSurface
            ? readApprovalPreferencesForSurface(approvalSurface).catch(() => ({
                preferences: null,
                defaults: approvalDefaultsFromPreferences(null),
              }))
            : Promise.resolve({
                preferences: null,
                defaults: approvalDefaultsFromPreferences(null),
              }),
          approvalTarget
            ? readWorkspaceApprovals(approvalTarget.projectId).catch(() => null)
            : Promise.resolve(null),
          approvalTarget
            ? readWorkspaceApprovalsManifest(approvalTarget.projectId).catch(
                () => null,
              )
            : Promise.resolve(null),
        ]);
      const approvalMode = approvalTarget
        ? resolveApprovalMode({
            tabMode: tab.approvalMode,
            workspaceDefault: workspaceApprovals?.defaultMode,
            canopyJsonDefault: manifestApprovals?.defaultMode,
            surface: surfaceForChat(approvalTarget.projectId),
            defaults: approvalPreferences.defaults,
          })
        : 'ask';
      const effectiveApprovalMode = approvalTarget
        ? (record.pendingApprovalMode ?? approvalMode)
        : 'ask';
      const preferences = approvalPreferences.preferences;
      record.approvalMode = effectiveApprovalMode;
      record.approvalSession = createApprovalSession({
        sessionKey,
        getTurnUserMessageId: () => record.auditUserMessageId,
        // Policy reads use the resolved target above, while renderer events
        // retain the owning sentinel identity subscribed by the approval dock.
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        provider: 'claude',
        workspaceRoot: cwd,
        mode: effectiveApprovalMode,
        sessionRules: tab.sessionApprovalRules ?? [],
        getWindow: options.getWindow ?? ((): BrowserWindow | null => null),
        promptTimeoutMs: CLAUDE_TERMINAL_APPROVAL_PROMPT_TIMEOUT_MS,
      });
      record.pendingApprovalMode = undefined;
      const codeGraphToolsAdvertised =
        !appAdvisorMode &&
        approvalTarget !== null &&
        isCodeGraphAvailableForWorkspace(approvalTarget.projectId);
      record.codeGraphToolsAdvertised = codeGraphToolsAdvertised;
      record.codeGraphAvailableThisTurn = Boolean(
        buildCodeGraphAvailabilityPrompt(
          request.projectId,
          request.worktreeId,
          {
            liveAvailable: codeGraphToolsAdvertised,
            toolsAdvertised: codeGraphToolsAdvertised,
          },
        ),
      );
      record.codeGraphOrientationTurn = {};
      record.codeGraphOrientationBlockedThisTurn = false;
      record.codeGraphCustomSourceExtensionsThisTurn = undefined;
      // The Ledger exposure gate runs once per terminal process: the CLI
      // lists its MCP tools when it starts, and each call re-checks the flag
      // and the "Agents add to the Feed" setting. App Advisor terminals carry
      // the App Advisor tool registry instead of this surface.
      const ledgerTarget: LedgerChatTarget = {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        ...(request.assistantMode
          ? { assistantMode: request.assistantMode }
          : {}),
      };
      // The effort the CLI runs at (see buildClaudeTerminalLaunchConfig).
      const ledgerThinkingEffort = clampThinkingLevelForModel(
        tabThinkingLevel ?? 'high',
        tab.model,
        'claude',
      );
      record.ledgerTools =
        !appAdvisorMode && mayExposeLedgerTools(ledgerTarget)
          ? ((await openLedgerChatTools({
              target: ledgerTarget,
              harness: 'claude',
              readSettings: () => ({
                model: record.model ?? null,
                thinkingEffort: ledgerThinkingEffort,
                planMode: record.planMode,
              }),
              ...(request.selectedRepoId
                ? { selectedRepoId: request.selectedRepoId }
                : {}),
            })) ?? undefined)
          : undefined;
      await server.ensureStarted(preferences?.mcpProxyPort);
      await server.registerCanopyWorktreeSessionRoute({
        sessionKey,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        assistantMode: appAdvisorMode ? 'app-advisor' : 'default',
        interfaceTools: resolveSessionInterfaceTools({
          assistantMode: appAdvisorMode ? 'app-advisor' : 'default',
          chatId: request.chatId,
        }),
        cwd,
        sdkSessionId,
        providerType: 'claude',
        pluginSelections,
        deferredToolsAllowed,
        authToken,
        createdAt: Date.now(),
        hookHandler: (body): Promise<unknown> =>
          this.handleHookCallback(sessionKey, body),
        codeGraphToolsAdvertised,
        ...(record.ledgerTools ? { ledgerTools: record.ledgerTools } : {}),
        autoArchiveAvailable: true,
        ...(appAdvisorMode && options.appAdvisorRuntime
          ? { appAdvisorRuntime: options.appAdvisorRuntime }
          : {}),
      });
      routeRegistered = true;

      const trustCwds =
        appAdvisorLaunchContext?.trustCwds ??
        Array.from(
          new Set([
            resolveWorktreeCwd(request.projectId, request.worktreeId),
            cwd,
          ]),
        );
      for (const trustCwd of trustCwds) {
        try {
          await ensureClaudeWorkspaceTrust(trustCwd);
        } catch (error) {
          this.recordDiagnostic(
            record,
            'claude_terminal_workspace_trust_error',
            {
              cwd: trustCwd,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
      const canResumeExistingSession =
        Boolean(existingSdkSessionId) &&
        (await claudeCodeSessionTranscriptExists(sdkSessionId, cwd));
      const tabMessages = Array.isArray(tab.messages) ? tab.messages : [];
      const terminalHandoffPrompt =
        !canResumeExistingSession &&
        (requiresPointInTimeForkHandoff || !request.initialPrompt)
          ? buildClaudeTerminalHandoffPrompt(tabMessages, sdkSessionId)
          : undefined;
      const buildLaunchConfig = (
        approvalModeForLaunch: ApprovalMode,
      ): ReturnType<typeof buildClaudeTerminalLaunchConfig> =>
        buildClaudeTerminalLaunchConfig({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: request.chatId,
          cwd,
          runtimeDir,
          sessionKey,
          authToken,
          sdkSessionId,
          resumeExistingSession: canResumeExistingSession,
          planMode: record.planMode,
          approvalMode: approvalModeForLaunch,
          model: tab.model,
          thinkingLevel: tabThinkingLevel,
          systemPromptAppend: joinSystemPromptSegments([
            appAdvisorMode
              ? APP_ADVISOR_SYSTEM_PROMPT
              : buildWorktreeInjectedToolPrompt(
                  'claude',
                  codeGraphToolsAdvertised,
                  false,
                  false,
                ),
            chatAddressPrompt(
              botId
                ? {
                    botId,
                    taskId: request.worktreeId,
                    chatId: request.chatId,
                  }
                : {
                    projectId: resolveCoworkWorkspaceId(request.projectId),
                    taskId: request.worktreeId,
                    chatId: request.chatId,
                  },
            ),
            // Only while this process's route carries the Ledger tools.
            record.ledgerTools?.systemPrompt(),
            buildCodeGraphAvailabilityPrompt(
              request.projectId,
              request.worktreeId,
              {
                liveAvailable: codeGraphToolsAdvertised,
                toolsAdvertised: codeGraphToolsAdvertised,
              },
            ),
            terminalHandoffPrompt,
          ]),
          initialPrompt: request.initialPrompt,
          pluginSelections,
          rtkEnabled: preferences?.rtkEnabled !== false,
          preventClaudeNativeCaffeinate:
            preferences?.preventClaudeNativeCaffeinate !== false,
          canopyMcpServerName: appAdvisorMode ? 'canopy_app_advisor' : 'canopy',
        }).then((config) => {
          replaceClaudeModAdmissionSessionRecords(
            sessionKey,
            config.claudeModAdmission?.skippedMods ?? [],
          );
          return config;
        });
      let launchApprovalMode = effectiveApprovalMode;
      let config = await buildLaunchConfig(launchApprovalMode);

      // Settings generation performs async filesystem/plugin work. If the user
      // changes the mode while it is in flight, never spawn with the earlier
      // privilege snapshot. Rebuild once for an in-place change; a second
      // change or teardown aborts the launch and lets the next launch start
      // from authoritative state.
      if (this.records.get(key) !== record) {
        throw new Error(
          'Terminal launch was superseded by an approval change.',
        );
      }
      if (record.approvalMode !== launchApprovalMode) {
        launchApprovalMode = record.approvalMode;
        config = await buildLaunchConfig(launchApprovalMode);
        if (
          this.records.get(key) !== record ||
          record.approvalMode !== launchApprovalMode
        ) {
          throw new Error(
            'Terminal launch was superseded by an approval change.',
          );
        }
      }

      if (request.initialPromptIdempotencyKey) {
        await this.authorizeRetainedPaste(
          record,
          request.initialPromptIdempotencyKey,
        );
      }
      const placedTerminal = await spawnPlacedManagedTerminal(
        {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          selectedRepoId: appAdvisorMode ? undefined : request.selectedRepoId,
          cwd,
          cols: request.cols,
          rows: request.rows,
          managedCommand: {
            executable: config.executable,
            args: config.args,
            env: config.env,
            pathPrepend: config.pathPrepend,
            title: 'Claude Code',
            kind: 'claude-code',
            chatId: request.chatId,
            sessionKey,
          },
        },
        { fromRemoteBridge: options.fromRemoteBridge === true },
      );
      // The terminal starts asynchronously in the daemon; a cleanup or a
      // newer launch in the meantime owns the chat now (CAN-5097).
      if (
        this.records.get(key) !== record ||
        record.state.turnState === 'cleaning_up' ||
        record.state.turnState === 'exited'
      ) {
        workerTerminal.kill(placedTerminal.id, {
          signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
        });
        throw new Error(
          'Terminal launch was superseded while its terminal started.',
        );
      }
      // Emit only once the terminal has started and still owns the chat.
      const terminal = spawnWithClaudeModsSkippedEvent(
        sessionKey,
        () => placedTerminal,
        (data): void => {
          void getChatStateService()
            .ingestProviderEvent({
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
              mutationId: data.sourceEventId,
              data,
              source: 'terminal',
            })
            .then((applied): void => {
              if (!applied) return;
              getExecutionObservabilityIngest().observeChatEvent(
                request.projectId,
                request.worktreeId,
                request.chatId,
                data,
              );
              this.eventSender(IPC_CHANNELS.chatEvent, {
                projectId: request.projectId,
                worktreeId: request.worktreeId,
                chatId: request.chatId,
                data,
              });
            })
            .catch((): void => {
              logMainProcessWarn(
                '[claude-terminal] Failed to emit skipped Claude Mods notice',
              );
            });
        },
      );
      terminalId = terminal.id;
    } catch (error) {
      if (routeRegistered) {
        server.unregisterCanopyWorktreeSessionRoute(sessionKey);
        server.unregisterMcpProxyRoutesForSession(sessionKey);
      }
      clearClaudeModAdmissionSessionRecords(sessionKey);
      record.ledgerTools?.dispose();
      record.ledgerTools = undefined;
      record.approvalSession?.dispose();
      record.approvalSession = undefined;
      record.state = {
        ...record.state,
        turnState: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      };
      await rm(record.runtimeDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await this.persistTabState(
        request.projectId,
        request.worktreeId,
        request.chatId,
        {
          claudeTerminal: record.state,
        },
      );
      this.emitState(record);
      this.recordDiagnostic(record, 'claude_terminal_process_error', {
        error: record.state.lastError,
      });
      throw error;
    }
    record.spawnedAt = Date.now();
    this.pendingFirstOutputTerminalIds.add(terminalId);
    this.recordsByTerminalId.set(terminalId, record);
    record.state = {
      ...record.state,
      terminalId,
      // A daemon-placed CLI can report hooks before its create resolves (CAN-5097).
      ...(record.state.turnState === 'starting'
        ? { turnState: 'idle' as const, lastHookAt: Date.now() }
        : {}),
    };
    this.reconcilePlacedTerminalEvents(record, terminalId);
    try {
      await this.persistTabState(
        request.projectId,
        request.worktreeId,
        request.chatId,
        {
          claudeTerminal: record.state,
          ...(persistForkHandoffAfterSpawn
            ? {
                sdkSessionId,
                claudeForkSessionOnNextSend: undefined,
                forkedFrom: {
                  ...tab.forkedFrom,
                  resumePointRequired: undefined,
                  modelContext: 'fresh',
                },
              }
            : {}),
        },
      );
    } catch (error) {
      await this.cleanupRecord(record, 'chat-closed').catch(() => undefined);
      throw error;
    }
    this.emitState(record);
    if (request.initialPrompt && !options.deferredToolsReloadContinuation) {
      if (
        initialPromptId &&
        initialAutomationInput?.nativeAutomationRunInputId === initialPromptId
      ) {
        await getChatStateService()
          .observeNativeAutomationTerminalInput(
            record,
            initialPromptId,
            'picked-up',
          )
          .catch((error: unknown) => {
            logMainProcessWarn(
              '[claude-terminal] Failed to record scheduled initial prompt pickup:',
              error,
            );
          });
      }
      await this.acceptWatcherInput(
        record,
        request.initialPromptIdempotencyKey,
      );
    }
    if (
      record.watcherObservations?.some(
        (item) => item.terminalAt && !item.terminalDelivered,
      )
    ) {
      await this.syncTranscriptForChat(record).catch(() => undefined);
    }
    this.scheduleIdleTtl(record);
    return {
      terminalId,
      sessionKey,
      sdkSessionId,
      state: record.state,
      initialPromptSubmitted: Boolean(request.initialPrompt),
    };
  }

  public async cleanup(request: ClaudeTerminalCleanupRequest): Promise<void> {
    const key = runtimeKey(
      request.projectId,
      request.worktreeId,
      request.chatId,
    );
    const pending = this.inflightLaunches.get(key);
    if (pending) {
      await pending.catch(() => undefined);
    }
    const record = this.records.get(key);
    if (!record) {
      if (
        request.reason === 'chat-closed' ||
        request.reason === 'provider-switch'
      ) {
        await rm(
          getClaudeTerminalRuntimeDir(
            request.projectId,
            request.worktreeId,
            request.chatId,
          ),
          { recursive: true, force: true },
        );
      }
      return;
    }
    await this.cleanupRecord(record, request.reason);
  }

  public async interrupt(
    request: ClaudeTerminalInterruptRequest,
  ): Promise<void> {
    const record = this.records.get(
      runtimeKey(request.projectId, request.worktreeId, request.chatId),
    );
    if (!record || record.state.turnState !== 'running') {
      return;
    }
    await this.settleUserInterruptedTurn(record, 'renderer-escape');
  }

  public async syncTranscriptForChat(
    request: ClaudeTerminalSyncTranscriptRequest,
  ): Promise<ClaudeTerminalSyncTranscriptResponse> {
    const record = this.records.get(
      runtimeKey(request.projectId, request.worktreeId, request.chatId),
    );
    if (!record) {
      return {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        importedEventCount: 0,
        errors: ['Claude Code terminal session is not running.'],
      };
    }
    if (!record.transcriptPath && record.state.sdkSessionId && record.cwd) {
      record.transcriptPath = await resolveClaudeCodeSessionTranscriptPath(
        record.state.sdkSessionId,
        record.cwd,
      );
    }
    const { result, event } = await this.syncTranscriptForRecord(record, {
      projectId: record.projectId,
      worktreeId: record.worktreeId,
      chatId: record.chatId,
      sessionKey: record.state.sessionKey ?? '',
      sdkSessionId: record.state.sdkSessionId ?? '',
      transcriptPath: record.transcriptPath,
      hookEventName: 'Notification',
      hookPayload: { source: 'renderer-pre-fork' },
      runtimeDir: record.runtimeDir,
    });
    this.recordDiagnostic(record, 'terminal_transcript_sync_end', {
      transcriptPath: result.transcriptPath,
      importedEventCount: result.importedEventCount,
      compactionAppended: result.compactionAppended,
      eventType: 'renderer-pre-fork',
      error: result.errors?.join('\n'),
    });
    const publicResult: ClaudeTerminalSyncTranscriptResponse = {
      projectId: result.projectId,
      worktreeId: result.worktreeId,
      chatId: result.chatId,
      importedEventCount: result.importedEventCount,
      transcriptPath: result.transcriptPath,
      replayedFromStart: result.replayedFromStart,
      compactionAppended: result.compactionAppended,
      settingsSync: result.settingsSync,
      turnDiffs: result.turnDiffs,
      errors: result.errors,
    };
    return {
      ...publicResult,
      ...(event ? { event } : {}),
    };
  }

  private async cleanupRecord(
    record: RuntimeRecord,
    reason: ClaudeTerminalCleanupReason,
  ): Promise<void> {
    const key = runtimeKey(record.projectId, record.worktreeId, record.chatId);
    const trailingSyncTimer = this.trailingSyncTimers.get(key);
    if (trailingSyncTimer) {
      clearTimeout(trailingSyncTimer);
      this.trailingSyncTimers.delete(key);
    }
    this.clearIdleTtl(key);
    record.resumeHandlerUnsubscribe?.();
    record.resumeHandlerUnsubscribe = undefined;
    record.approvalSession?.dispose();
    record.approvalSession = undefined;
    if (record.state.terminalId) {
      this.pendingFirstOutputTerminalIds.delete(record.state.terminalId);
      this.terminalOutputDetectionTails.delete(record.state.terminalId);
      this.recordsByTerminalId.delete(record.state.terminalId);
    }
    let settlementFailure: { error: unknown } | undefined;
    if (reason !== 'deferred-tools-reload') {
      try {
        const receivedHooks = record.state.sessionKey
          ? this.hookTails.get(record.state.sessionKey)
          : undefined;
        await receivedHooks?.catch(() => undefined);
        await this.settlePlanImplementation(record, 'cancelled');
      } catch (error: unknown) {
        settlementFailure = { error };
        this.recordDiagnostic(record, 'terminal_transcript_sync_failure', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.closeAuditTurn(
        record,
        'cancelled',
        `Claude Code terminal cleaned up (${reason}).`,
      );
    }
    // A deferred-tools reload detaches the running turn's lease before this
    // cleanup, so whatever lease the record still holds ends with it.
    this.endPlanTurn(record);
    record.state = { ...record.state, turnState: 'cleaning_up' };
    this.emitState(record);
    if (record.state.terminalId) {
      workerTerminal.kill(record.state.terminalId, {
        signal: TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
      });
    }
    if (record.state.sessionKey) {
      const server = getDesktopIntegrationServer();
      server.unregisterCanopyWorktreeSessionRoute(record.state.sessionKey);
      server.unregisterMcpProxyRoutesForSession(record.state.sessionKey);
      clearClaudeModAdmissionSessionRecords(record.state.sessionKey);
    }
    // The Ledger binding lives exactly as long as the route that carried it.
    record.ledgerTools?.dispose();
    record.ledgerTools = undefined;
    await this.removeRuntimeArtifacts(record, reason);
    record.state = { ...record.state, turnState: 'exited' };
    if (CLEANUP_REASONS_THAT_PERSIST_EXIT_STATE.has(reason)) {
      await this.persistTabState(
        record.projectId,
        record.worktreeId,
        record.chatId,
        {
          claudeTerminal: record.state,
        },
      );
    }
    this.records.delete(key);
    this.emitState(record);
    if (settlementFailure) throw settlementFailure.error;
  }

  public async cleanupWorktree(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    const records = Array.from(this.records.values()).filter(
      (record) =>
        record.projectId === projectId && record.worktreeId === worktreeId,
    );
    await Promise.all(
      records.map((record) =>
        this.cleanup({
          projectId: record.projectId,
          worktreeId: record.worktreeId,
          chatId: record.chatId,
          reason: 'worktree-deletion',
        }),
      ),
    );
    await rm(
      path.join(getWorktreeDataDir(projectId, worktreeId), 'claude-terminal'),
      {
        recursive: true,
        force: true,
      },
    );
  }

  public markHookState(input: HookStateUpdate): Promise<void> {
    const occurredAt = Date.now();
    const terminalHook =
      input.hookEventName === 'Stop' ||
      input.hookEventName === 'StopFailure' ||
      input.hookEventName === 'SessionEnd';
    const record = Array.from(this.records.values()).find(
      (candidate) => candidate.state.sessionKey === input.sessionKey,
    );
    const suppressPlanTerminal =
      terminalHook &&
      record !== undefined &&
      deferredToolsReloadCoordinator.shouldSuppressProviderTerminal(record);
    if (suppressPlanTerminal) {
      record.suspendedPlanImplementationUserMessageId =
        record.planImplementationUserMessageId ??
        record.pendingPlanImplementationUserMessageId;
    }
    const previous = this.hookTails.get(input.sessionKey) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(async () => {
        // Keep the received plan hooks ordered even if exit removes this record
        // before their asynchronous transcript work can run.
        if (record && input.hookEventName === 'UserPromptSubmit') {
          const submittedTurnId = terminalPresentationTurnId(
            getStringField(input.hookPayload, 'prompt'),
          );
          if (submittedTurnId) {
            const target = {
              projectId: record.projectId,
              worktreeId: record.worktreeId,
              chatId: record.chatId,
              userMessageId: submittedTurnId,
            };
            if (
              await getChatStateService().recordTerminalPlanImplementation(
                target,
                'started',
              )
            ) {
              record.planImplementationUserMessageId = submittedTurnId;
              if (
                record.pendingPlanImplementationUserMessageId ===
                submittedTurnId
              )
                delete record.pendingPlanImplementationUserMessageId;
            }
          }
        }
        try {
          await this.markHookStateOrdered(input, occurredAt);
        } finally {
          if (record && terminalHook && !suppressPlanTerminal) {
            await this.settlePlanImplementation(
              record,
              record.interruptSettling || input.hookEventName === 'SessionEnd'
                ? 'cancelled'
                : input.hookEventName === 'StopFailure'
                  ? 'failed'
                  : 'completed',
            );
          }
        }
      });
    this.hookTails.set(input.sessionKey, pending);
    void pending
      .finally(() => {
        if (this.hookTails.get(input.sessionKey) === pending)
          this.hookTails.delete(input.sessionKey);
      })
      .catch(() => undefined);
    return pending;
  }

  private async markHookStateOrdered(
    input: HookStateUpdate,
    occurredAt: number,
  ): Promise<void> {
    const record = Array.from(this.records.values()).find(
      (candidate) => candidate.state.sessionKey === input.sessionKey,
    );
    if (!record) return;
    if (input.hookEventName === 'UserPromptSubmit') {
      const origin = {
        projectId: record.projectId,
        worktreeId: record.worktreeId,
        chatTabId: record.chatId,
      };
      const handoffsAtSend = browserHandoffs.captureOrigin(origin);
      const submittedTurnId = terminalPresentationTurnId(
        getStringField(input.hookPayload, 'prompt'),
      );
      delete record.automationTurnInputId;
      let retainedInput: ChatSendMessageRequest | undefined;
      if (submittedTurnId) {
        // The marker only correlates the provider's hook to a main-retained
        // input. Its text and presentation source confer no authority.
        const tabs = await readChatTabsFile(
          record.projectId,
          record.worktreeId,
          { chatIds: [record.chatId] },
        );
        if (
          this.records.get(
            runtimeKey(record.projectId, record.worktreeId, record.chatId),
          ) !== record
        )
          return;
        const tab = tabs.tabs.find(
          (candidate) => candidate.id === record.chatId,
        );
        retainedInput = tab
          ? retainedTerminalInput(tab, submittedTurnId)
          : undefined;
        if (retainedInput && isAutomationRunInput(retainedInput)) {
          record.automationTurnInputId = submittedTurnId;
          if (retainedInput.nativeAutomationRunInputId === submittedTurnId) {
            await getChatStateService()
              .observeNativeAutomationTerminalInput(
                record,
                submittedTurnId,
                'picked-up',
              )
              .catch((error: unknown) => {
                logMainProcessWarn(
                  '[claude-terminal] Failed to record scheduled prompt pickup:',
                  error,
                );
              });
          }
        }
      }
      const turn = acceptTerminalPresentationTurn(
        presentationChatKey(origin),
        submittedTurnId ?? randomUUID(),
        submittedTurnId && !retainedInput?.agentSenderProvenance
          ? 'automation'
          : 'user',
      );
      record.presentationTurnId = turn.turnId;

      if (
        !record.deferredToolsReloadContinuation &&
        (turn.source === 'user' || turn.source === 'portal')
      ) {
        for (const id of handoffsAtSend) browserHandoffs.release(id);
      }
      record.approvalTurnCancelled = false;
      record.codeGraphAvailableThisTurn = Boolean(
        buildCodeGraphAvailabilityPrompt(record.projectId, record.worktreeId, {
          liveAvailable: record.codeGraphToolsAdvertised === true,
          toolsAdvertised: record.codeGraphToolsAdvertised === true,
        }),
      );
      record.codeGraphOrientationTurn = {};
      record.codeGraphOrientationBlockedThisTurn = false;
      record.codeGraphCustomSourceExtensionsThisTurn = undefined;
    }
    const transcriptPath = TRANSCRIPT_PATH_HOOK_EVENTS.has(input.hookEventName)
      ? getStringField(input.hookPayload, 'transcript_path')
      : undefined;
    if (transcriptPath) {
      if (
        isAllowedClaudeTerminalTranscriptPath(transcriptPath, record.runtimeDir)
      ) {
        record.transcriptPath = path.resolve(transcriptPath);
      } else {
        this.recordDiagnostic(record, 'terminal_transcript_sync_failure', {
          transcriptPath,
          eventType: input.hookEventName,
          error:
            'Rejected Claude terminal transcript path outside allowed roots.',
        });
      }
    }
    if (
      input.hookEventName === 'UserPromptSubmit' &&
      !record.deferredToolsReloadContinuation
    ) {
      await this.acceptWatcherInput(record, undefined, occurredAt);
    }
    if (['Stop', 'StopFailure', 'SessionEnd'].includes(input.hookEventName)) {
      await this.observeWatcherTerminal(
        record,
        input.hookEventName === 'StopFailure' ? 'error' : 'completed',
        input.hookEventName === 'Stop',
        occurredAt,
      );
    }
    if (input.hookEventName === 'UserPromptSubmit' && record.transcriptPath)
      this.scheduleTrailingTranscriptSync(record, input);
    const previousTurnState = record.state.turnState;
    const deferStopIdle = input.hookEventName === 'Stop';
    const next = deferStopIdle
      ? previousTurnState
      : nextTurnState(input.hookEventName, record.state.turnState);
    const hookAt = occurredAt;
    record.state = {
      ...record.state,
      turnState: next,
      lastHookAt: hookAt,
      // Any hook callback proves the CLI process is initialized far enough
      // to accept TUI input; `turnState: 'idle'` alone only means the
      // process spawned.
      readyForInput: true,
      ...(next === 'running' && previousTurnState !== 'running'
        ? { startedAt: hookAt }
        : {}),
    };
    this.emitState(record);
    if (previousTurnState !== next) {
      if (next === 'running') {
        this.recordDiagnostic(record, 'terminal_turn_active', {
          turnActive: true,
          eventType: input.hookEventName,
        });
      } else if (next === 'idle') {
        this.recordDiagnostic(record, 'terminal_turn_idle', {
          turnActive: false,
          eventType: input.hookEventName,
        });
      }
    }
    if (next === 'running' && previousTurnState !== 'running') {
      this.beginPlanTurn(record);
      if (record.state.terminalId) {
        this.terminalOutputDetectionTails.delete(record.state.terminalId);
      }
      if (record.deferredToolsReloadContinuation) {
        record.auditTurnOpen = true;
        record.auditUserMessageId =
          record.deferredToolsReloadContinuation.turnUserMessageId ??
          `msg-terminal-${randomUUID()}`;
        record.turnUsage = emptyTurnUsage();
        getExecutionObservabilityIngest().recordInjectedPromptForOpenChatTurn(
          record.projectId,
          record.worktreeId,
          record.chatId,
          {
            kind: 'system_prompt_append',
            provider: 'claude',
            applicationCondition: 'deferred_tools_reload_continuation',
            text: record.deferredToolsReloadContinuation.text,
            deferredToolsReload: {
              enabledResources:
                record.deferredToolsReloadContinuation.enabledResources,
            },
          },
        );
        record.deferredToolsReloadContinuation = undefined;
      } else {
        const prompt = getStringField(input.hookPayload, 'prompt');
        this.openAuditTurn(
          record,
          prompt === undefined
            ? undefined
            : stripTerminalPresentationMarker(prompt),
        );
      }
      await this.openTurnDiffCapture(record);
    }
    if (
      input.hookEventName === 'Stop' ||
      input.hookEventName === 'StopFailure' ||
      input.hookEventName === 'SessionEnd' ||
      input.hookEventName === 'PostCompact' ||
      input.hookEventName === 'SubagentStop'
    ) {
      try {
        const turnDiff = shouldCloseTerminalTurnDiff(input.hookEventName)
          ? await this.closeTurnDiffCapture(record)
          : undefined;
        const result = await this.syncTranscriptForHook(
          record,
          input,
          turnDiff,
          input.hookEventName === 'StopFailure' ||
            input.hookEventName === 'SessionEnd'
            ? {
                id: `terminal-hook:${record.state.sessionKey}:${record.state.startedAt}`,
                startedAt: record.state.startedAt,
                completedAt: hookAt,
              }
            : undefined,
        );
        const idlePatch: Partial<ClaudeTerminalRuntimeState> = deferStopIdle
          ? { turnState: 'idle' }
          : {};
        record.state = {
          ...record.state,
          ...idlePatch,
          lastSyncAt: Date.now(),
        };
        this.emitState(record);
        if (deferStopIdle && previousTurnState !== 'idle') {
          this.recordDiagnostic(record, 'terminal_turn_idle', {
            turnActive: false,
            eventType: input.hookEventName,
          });
        }
        if (
          shouldScheduleTrailingTranscriptSync(input.hookEventName, result) ||
          record.watcherObservations?.some(
            (item) => item.terminalAt && !item.terminalDelivered,
          )
        ) {
          this.scheduleTrailingTranscriptSync(record, input);
        }
      } catch (error) {
        if (shouldCloseTerminalTurnDiff(input.hookEventName)) {
          await this.closeTurnDiffCapture(record).catch(() => undefined);
        }
        this.scheduleTrailingTranscriptSync(record, input);
        this.recordDiagnostic(record, 'terminal_transcript_sync_failure', {
          transcriptPath: record.transcriptPath,
          eventType: input.hookEventName,
          error: error instanceof Error ? error.message : String(error),
        });
        if (deferStopIdle) {
          record.state = {
            ...record.state,
            turnState: 'idle',
            lastSyncAt: Date.now(),
          };
          this.emitState(record);
          if (previousTurnState !== 'idle') {
            this.recordDiagnostic(record, 'terminal_turn_idle', {
              turnActive: false,
              eventType: input.hookEventName,
            });
          }
        }
      }
      this.finalizeAuditTurnForHook(record, input.hookEventName);
    }
    // The turn left `running` (Stop once its transcript synced, StopFailure,
    // SessionEnd): its plan-file edits may now sync back.
    if (
      previousTurnState === 'running' &&
      record.state.turnState !== 'running'
    ) {
      this.endPlanTurn(record);
    }
    this.syncIdleTtl(record);
    await this.persistTabState(
      record.projectId,
      record.worktreeId,
      record.chatId,
      {
        claudeTerminal: record.state,
      },
    );
  }

  private persistWatcherObservations(record: RuntimeRecord): Promise<void> {
    // Hooks and trailing import may overlap. Serialize snapshots so an older
    // write can never replace evidence accepted while that write was syncing.
    const pending = (record.watcherPersistenceTail ?? Promise.resolve())
      .catch(() => undefined)
      .then(() =>
        writeTerminalWatcherObservations(
          record.runtimeDir,
          record.watcherObservations ?? [],
        ),
      );
    record.watcherPersistenceTail = pending;
    return pending;
  }

  private reconcileAbandonedWatcherObservations(record: RuntimeRecord): void {
    record.watcherRuntimeGeneration ??= record.state.sessionKey ?? randomUUID();
    for (const observation of record.watcherObservations ?? []) {
      if (observation.runtimeGeneration === record.watcherRuntimeGeneration)
        continue;
      if (observation.terminalAt) {
        // The prior process can no longer write the duration record a Stop
        // was waiting for, so publish with what was imported.
        if (
          !observation.terminalDelivered &&
          observation.waitForDuration !== false
        ) {
          observation.waitForDuration = false;
          record.watcherObservationsDirty = true;
        }
        continue;
      }
      // A new CLI launch cannot acknowledge a prior process's accepted turn.
      // Legacy observations have no generation and are abandoned too.
      observation.terminalAt = new Date().toISOString();
      observation.disposition = 'interrupted';
      observation.waitForDuration = false;
      record.watcherObservationsDirty = true;
    }
  }

  private async flushDirtyWatcherObservations(
    record: RuntimeRecord,
  ): Promise<void> {
    if (!record.watcherObservationsDirty) return;
    record.watcherObservationsDirty = false;
    try {
      await this.persistWatcherObservations(record);
    } catch (error) {
      record.watcherObservationsDirty = true;
      throw error;
    }
  }

  private acceptWatcherInput(
    record: RuntimeRecord,
    retainedId?: string,
    acceptedAt = Date.now(),
  ): Promise<void> {
    // Launch and the first UserPromptSubmit can overlap. Serialize so the
    // second sees the first's open observation instead of appending another.
    const pending = (record.watcherAcceptTail ?? Promise.resolve())
      .catch(() => undefined)
      .then(() =>
        this.acceptWatcherInputOrdered(record, retainedId, acceptedAt),
      );
    record.watcherAcceptTail = pending;
    // A watcher store or delivery failure means no watcher. It never fails
    // the terminal launch or hook that accepted the input.
    return pending.catch((error: unknown) => {
      logMainProcessWarn(
        '[claude-terminal] Watcher input acceptance failed:',
        error,
      );
    });
  }

  private async acceptWatcherInputOrdered(
    record: RuntimeRecord,
    retainedId: string | undefined,
    acceptedAt: number,
  ): Promise<void> {
    // These registry-backed scopes borrow a checkout but are not discoverable
    // projects and cannot have chat watchers. Do not alias them to the owner.
    if (
      record.projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
      record.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID
    )
      return;
    const tabs = await readChatTabsFile(record.projectId, record.worktreeId, {
      chatIds: [record.chatId],
      fullTranscript: true,
    });
    const tab = tabs.tabs.find((candidate) => candidate.id === record.chatId);
    record.watcherObservations ??= await readTerminalWatcherObservations(
      record.runtimeDir,
    );
    this.reconcileAbandonedWatcherObservations(record);
    await this.flushDirtyWatcherObservations(record);
    const roots = (tab?.messages ?? []).filter(
      (message) => message.role === 'user' && !message.parentToolUseId,
    );
    const retainedRow =
      tab && isInputLedger(tab.inputDelivery)
        ? tab.inputDelivery.rows.find((row) => row.id === retainedId)
        : undefined;
    const retainedAttempt = retainedRow?.attempts.find(
      (attempt) => attempt.id === retainedRow.currentAttemptId,
    );
    const retained =
      roots.find((message) => message.id === retainedId)?.id ??
      retainedAttempt?.rootUserMessageId ??
      retainedRow?.payload.userMessageId ??
      retainedId;
    const retainedAcceptedAt = (): string =>
      new Date(
        roots.find((message) => message.id === retained)?.timestamp ??
          retainedRow?.createdAt ??
          Date.now(),
      ).toISOString();
    const startsChat = (): boolean =>
      !tab?.newChatStartedWatcherFiredAt &&
      !record.watcherObservations?.some((item) => item.startsChat) &&
      (tab?.newChatStartedWatcherPending === true ||
        roots.length === 0 ||
        (roots.length === 1 && roots[0]?.id === retained));
    // The first UserPromptSubmit acknowledges the launch input, not a new turn.
    const open = record.watcherObservations.find((item) => !item.terminalAt);
    if (open) {
      // That hook can be accepted before launch acceptance. Bind the launch's
      // retained input to its still-unpublished observation.
      if (retained && !open.sourceInputId) {
        open.sourceInputId = retained;
        open.sourceInputAcceptedAt = retainedAcceptedAt();
        open.startsChat = open.startsChat || startsChat();
        await this.persistWatcherObservations(record);
        await this.publishWatcherObservations(record);
      }
      return;
    }
    const address = await resolveCanonicalChatAddress(record).catch(
      (error: unknown) => {
        logMainProcessWarn(
          '[claude-terminal] Watcher scope resolution unavailable:',
          error,
        );
        return null;
      },
    );
    if (!address) {
      logMainProcessWarn('[claude-terminal] No watcher scope resolved.', {
        projectId: record.projectId,
        worktreeId: record.worktreeId,
        chatId: record.chatId,
      });
      return;
    }
    const evidence = await captureChatWatcherEvidence(address).catch(
      (error: unknown) => {
        logMainProcessWarn(
          '[claude-terminal] Watcher evidence resolution unavailable:',
          error,
        );
        return null;
      },
    );
    if (!evidence) return;
    const observation: TerminalObservation = {
      id: randomUUID(),
      address,
      evidence,
      acceptedAt: new Date(acceptedAt).toISOString(),
      runtimeGeneration: record.watcherRuntimeGeneration,
      ...(roots.length ? { previousRootId: roots[roots.length - 1].id } : {}),
      ...(retained
        ? {
            sourceInputId: retained,
            sourceInputAcceptedAt: retainedAcceptedAt(),
          }
        : {}),
      ...(record.transcriptPath
        ? { transcriptPath: record.transcriptPath }
        : {}),
      startsChat: startsChat(),
    };
    record.watcherObservations.push(observation);
    await this.persistWatcherObservations(record);
    await this.publishWatcherObservations(record);
  }

  private async observeWatcherTerminal(
    record: RuntimeRecord,
    disposition: ChatTerminalDisposition,
    waitForDuration = false,
    occurredAt = Date.now(),
  ): Promise<void> {
    if (deferredToolsReloadCoordinator.shouldSuppressProviderTerminal(record))
      return;
    const observation = record.watcherObservations
      ?.slice()
      .reverse()
      .find((item) => !item.terminalAt);
    if (!observation) return;
    observation.terminalAt = new Date(occurredAt).toISOString();
    observation.disposition = disposition;
    observation.waitForDuration = waitForDuration;
    observation.transcriptPath = record.transcriptPath;
    await this.persistWatcherObservations(record).catch((error: unknown) => {
      // The next flush retries; a watcher store failure never fails the hook.
      record.watcherObservationsDirty = true;
      logMainProcessWarn(
        '[claude-terminal] Watcher terminal persistence failed:',
        error,
      );
    });
  }

  private publishWatcherObservations(
    record: RuntimeRecord,
    result?: TranscriptSyncResultWithMessages,
  ): Promise<void> {
    const pending = (record.watcherPublishTail ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.publishWatcherObservationsOrdered(record, result));
    record.watcherPublishTail = pending;
    return pending;
  }

  private async publishWatcherObservationsOrdered(
    record: RuntimeRecord,
    result?: TranscriptSyncResultWithMessages,
  ): Promise<void> {
    const key = runtimeKey(record.projectId, record.worktreeId, record.chatId);
    const wasRecovering = this.recoveringWatchers.has(key);
    this.recoveringWatchers.add(key);
    try {
      await this.deliverWatcherObservations(record, result);
    } finally {
      if (!wasRecovering) this.recoveringWatchers.delete(key);
    }
  }

  private async deliverWatcherObservations(
    record: RuntimeRecord,
    result?: TranscriptSyncResultWithMessages,
  ): Promise<void> {
    const observations = record.watcherObservations ?? [];
    const messages =
      result?.lifecycleMessages ?? result?.importedMessages ?? [];
    const assigned = new Set(
      observations.flatMap((item) =>
        item.sourceInputId ? [item.sourceInputId] : [],
      ),
    );
    try {
      for (const observation of observations) {
        if (!observation.transcriptPath && result?.transcriptPath) {
          observation.transcriptPath = result.transcriptPath;
          record.watcherObservationsDirty = true;
        }
        if (!observation.sourceInputId) {
          // Canonical lifecycle messages contain the full ordered root history.
          // One stable last-root marker excludes that history without copying it.
          const boundaryIndex = observation.previousRootId
            ? messages.findIndex(
                (message) => message.id === observation.previousRootId,
              )
            : -1;
          if (observation.previousRootId && boundaryIndex < 0) continue;
          const root = messages.find(
            (message, index) =>
              message.role === 'user' &&
              !message.parentToolUseId &&
              !(observation.previousRootIds ?? []).includes(message.id) &&
              index > boundaryIndex &&
              (!observation.terminalAt ||
                message.timestamp <= Date.parse(observation.terminalAt)) &&
              !assigned.has(message.id),
          );
          if (root) {
            observation.sourceInputId = root.id;
            observation.sourceInputAcceptedAt = new Date(
              root.timestamp,
            ).toISOString();
            assigned.add(root.id);
            record.watcherObservationsDirty = true;
          }
        }
        const sourceInputId = observation.sourceInputId;
        if (!sourceInputId) continue;
        // Acceptance evidence and a deterministic root boundary are already durable.
        // Stable event IDs make a crash before the batched delivery checkpoint replay-safe.
        const common = {
          address: observation.address,
          evidence: observation.evidence,
          sourceInputId,
          observedAt: new Date().toISOString(),
        };
        if (observation.startsChat && !observation.startedDelivered) {
          await getAppAdvisorWatcherService().handleCanonicalChatStartedEvent({
            ...common,
            kind: 'started',
            eventId: `${observation.id}:started`,
            occurredAt: observation.acceptedAt,
          });
          observation.startedDelivered = true;
          record.watcherObservationsDirty = true;
          await this.persistTabState(
            record.projectId,
            record.worktreeId,
            record.chatId,
            {
              newChatStartedWatcherPending: undefined,
              newChatStartedWatcherFiredAt: observation.acceptedAt,
            },
          );
        }
        if (
          !observation.terminalAt ||
          observation.terminalDelivered ||
          !result ||
          result.errors?.length ||
          result.transcriptReadComplete === false
        )
          continue;
        const rootIndex = messages.findIndex(
          (message) => message.id === sourceInputId,
        );
        if (rootIndex < 0) continue;
        const nextRoot = messages.findIndex(
          (message, index) =>
            index > rootIndex &&
            message.role === 'user' &&
            !message.parentToolUseId,
        );
        const turn = messages.slice(
          rootIndex + 1,
          nextRoot < 0 ? undefined : nextRoot,
        );
        const timer = turn.some((message) =>
          message.blocks.some(
            (block) =>
              block.type === 'turn_timer' &&
              typeof block.completedAt === 'number',
          ),
        );
        // Stop precedes Claude's duration write; SessionEnd, failure and explicit
        // interrupt are independently terminal once their root imports successfully.
        if (!timer && observation.waitForDuration !== false) continue;
        const visibleOutput = turn.some(
          (message) =>
            serializeVisibleReadMessage(message)?.role === 'assistant',
        );
        const disposition =
          observation.disposition === 'completed' && !visibleOutput
            ? 'no_output'
            : (observation.disposition ?? 'completed');
        await getAppAdvisorWatcherService().handleCanonicalChatTerminalEvent({
          ...common,
          kind: 'terminal',
          eventId: `${observation.id}:terminal`,
          occurredAt: observation.terminalAt,
          sourceInputAcceptedAt:
            observation.sourceInputAcceptedAt ?? observation.acceptedAt,
          disposition,
        });
        observation.terminalDelivered = true;
        record.watcherObservationsDirty = true;
      }
    } finally {
      const pending = observations.filter(
        (item) =>
          !item.terminalDelivered ||
          (item.startsChat && !item.startedDelivered),
      );
      if (pending.length !== observations.length) {
        // Keep the same array identity: recovery also holds a reference to it.
        observations.splice(0, observations.length, ...pending);
        record.watcherObservationsDirty = true;
      }
      await this.flushDirtyWatcherObservations(record);
    }
  }

  /**
   * Open an audit-trail chat-turn entry for a terminal-driven turn. Mirrors
   * the Canopy-native `startChatTurn` wiring with `chatMode: 'terminal'` so
   * the Audit Trail records every executed turn regardless of surface.
   */
  private openAuditTurn(
    record: RuntimeRecord,
    promptText: string | undefined,
  ): void {
    if (record.auditTurnOpen) {
      return;
    }
    record.auditTurnOpen = true;
    record.turnUsage = emptyTurnUsage();
    record.auditUserMessageId = `msg-terminal-${randomUUID()}`;
    getExecutionObservabilityIngest().startChatTurn({
      projectId: record.projectId,
      worktreeId: record.worktreeId,
      chatId: record.chatId,
      provider: 'claude',
      modelSource: 'claude-managed',
      executionHarness: 'claude',
      sdkSessionId: record.state.sdkSessionId,
      originalUserText: promptText ?? '',
      submittedText: promptText ?? '',
      planMode: false,
      isStandalone: record.projectId === STANDALONE_CHAT_PROJECT_ID,
      assistantMode: record.assistantMode,
      initiationSource: 'user',
      chatMode: 'terminal',
      model: record.model,
      userMessageId: record.auditUserMessageId,
    });
  }

  private async openTurnDiffCapture(record: RuntimeRecord): Promise<void> {
    if (
      record.turnDiffCaptureActive ||
      !record.state.sessionKey ||
      !shouldCaptureTerminalTurnDiff(record)
    ) {
      return;
    }
    record.turnDiffCaptureActive = true;
    try {
      await captureTurnStart(
        record.state.sessionKey,
        record.projectId,
        record.worktreeId,
      );
    } catch (error) {
      record.turnDiffCaptureActive = false;
      this.recordDiagnostic(record, 'terminal_turn_diff_capture_open_failure', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async closeTurnDiffCapture(
    record: RuntimeRecord,
  ): Promise<TurnDiffData | undefined> {
    if (!record.turnDiffCaptureActive || !record.state.sessionKey) {
      return undefined;
    }
    record.turnDiffCaptureActive = false;
    const turnDiff =
      (await captureTurnEndAndDiff(record.state.sessionKey)) ?? undefined;
    if (turnDiff !== undefined && turnDiff.files.length > 0) {
      const target = resolveWorktreeTargetIds(
        record.projectId,
        record.worktreeId,
      );
      if (target) {
        scheduleCodeGraphBuild({
          ...target,
          reason: 'refresh',
          source: 'turn-diff',
        });
      }
    }
    return turnDiff;
  }

  /**
   * Begin the plan-file turn lease for a turn that just started running, in
   * the real worktree scope whose plan files it exposes (a plan-explore
   * sentinel resolves to its registered target). Idempotent while the
   * record's lease is live; supersedes a lease carried across a
   * deferred-tools reload.
   */
  private beginPlanTurn(record: RuntimeRecord): void {
    if (record.planTurnLease) {
      return;
    }
    const inherited = record.inheritedPlanTurnLease;
    record.inheritedPlanTurnLease = undefined;
    const scope = resolvePlanTurnScope(record.projectId, record.worktreeId);
    if (scope) {
      record.planTurnLease = getPlanFileSyncService().beginTurn(
        planChatTurnKey(record.projectId, record.worktreeId, record.chatId),
        scope,
      );
    }
    // A no-op once the same-key turn above superseded it.
    inherited?.end();
  }

  /** End the record's plan-file turn leases, if any. Idempotent. */
  private endPlanTurn(record: RuntimeRecord): void {
    delete record.automationTurnInputId;
    if (record.presentationTurnId) {
      clearPresentationTurn(
        presentationChatKey({
          projectId: record.projectId,
          worktreeId: record.worktreeId,
          chatTabId: record.chatId,
        }),
        record.presentationTurnId,
      );
      record.presentationTurnId = undefined;
    }
    const leases = [record.planTurnLease, record.inheritedPlanTurnLease];
    record.planTurnLease = undefined;
    record.inheritedPlanTurnLease = undefined;
    for (const lease of leases) {
      lease?.end();
    }
  }

  /** Detach the record's live plan-file turn lease without ending it. */
  private takePlanTurnLease(record: RuntimeRecord): PlanTurnLease | undefined {
    const lease = record.planTurnLease ?? record.inheritedPlanTurnLease;
    record.planTurnLease = undefined;
    record.inheritedPlanTurnLease = undefined;
    return lease;
  }

  private async settlePlanImplementation(
    record: RuntimeRecord,
    outcome: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    const userMessageId =
      record.planImplementationUserMessageId ??
      (outcome === 'completed'
        ? undefined
        : record.pendingPlanImplementationUserMessageId);
    if (!userMessageId) return;
    await getChatStateService().recordTerminalPlanImplementation(
      {
        projectId: record.projectId,
        worktreeId: record.worktreeId,
        chatId: record.chatId,
        userMessageId,
      },
      outcome,
    );
    if (record.planImplementationUserMessageId === userMessageId)
      delete record.planImplementationUserMessageId;
    if (record.pendingPlanImplementationUserMessageId === userMessageId)
      delete record.pendingPlanImplementationUserMessageId;
  }

  private closeAuditTurn(
    record: RuntimeRecord,
    status: AgentAuditStatus,
    error?: string,
  ): void {
    if (!record.auditTurnOpen) {
      return;
    }
    record.auditTurnOpen = false;
    record.auditUserMessageId = undefined;
    const observability = getExecutionObservabilityIngest();
    // Synthesize the turn-final result event Canopy-native Claude turns get
    // from the SDK stream so token totals land on the audit entry.
    observability.observeChatEvent(
      record.projectId,
      record.worktreeId,
      record.chatId,
      {
        type: 'result',
        usage: {
          input_tokens: record.turnUsage.inputTokens,
          output_tokens: record.turnUsage.outputTokens,
          cache_read_input_tokens: record.turnUsage.cacheReadInputTokens,
          cache_creation_input_tokens:
            record.turnUsage.cacheCreationInputTokens,
        },
      },
    );
    observability.completeChatTurn(
      record.projectId,
      record.worktreeId,
      record.chatId,
      status,
      error,
    );
    record.turnUsage = emptyTurnUsage();
  }

  private finalizeAuditTurnForHook(
    record: RuntimeRecord,
    hookEventName: ClaudeTerminalHookEventName,
  ): void {
    if (hookEventName === 'Stop') {
      this.closeAuditTurn(record, 'success');
    } else if (hookEventName === 'StopFailure') {
      this.closeAuditTurn(record, 'failure', 'Claude Code turn failed.');
    } else if (hookEventName === 'SessionEnd') {
      this.closeAuditTurn(record, 'interrupted', 'Claude Code session ended.');
    }
  }

  /**
   * Reap idle auto-mode terminals: the surface is hidden between turns, so
   * an idle process is invisible background cost. Visible `'claude-code'`
   * terminals are never reaped.
   */
  private scheduleIdleTtl(record: RuntimeRecord): void {
    if (record.interfaceMode !== 'auto') {
      return;
    }
    if (record.state.turnState !== 'idle') {
      return;
    }
    const key = runtimeKey(record.projectId, record.worktreeId, record.chatId);
    this.clearIdleTtl(key);
    // A pending Mod admission relaunch reaps at once instead of after the TTL.
    const relaunch = record.relaunchWhenIdle === true;
    const timer = setTimeout(
      () => {
        this.idleTtlTimers.delete(key);
        const current = this.records.get(key);
        if (!current || current.state.turnState !== 'idle') {
          return;
        }
        void this.cleanupRecord(
          current,
          relaunch ? 'settings-change' : 'auto-idle-ttl',
        ).catch(() => undefined);
      },
      relaunch ? 0 : CLAUDE_TERMINAL_AUTO_IDLE_TTL_MS,
    );
    if (process.env.NODE_ENV !== 'test') {
      timer.unref?.();
    }
    this.idleTtlTimers.set(key, timer);
  }

  private clearIdleTtl(key: string): void {
    const timer = this.idleTtlTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.idleTtlTimers.delete(key);
    }
  }

  /**
   * After a Mod admission change, end auto-mode terminals so the next send
   * relaunches and decides admission again. A busy one ends when its turn
   * does. A terminal the person types into keeps running until it next
   * launches. `skipped` reaches only launches that skipped a Mod.
   */
  public relaunchForModAdmissionChange(scope: 'skipped' | 'all'): void {
    for (const record of Array.from(this.records.values())) {
      if (record.interfaceMode !== 'auto') continue;
      // A record that never launched has no skipped Mods. One still deciding
      // admission is flagged too: the reap waits until it is idle.
      const { sessionKey } = record.state;
      if (
        scope === 'skipped' &&
        (sessionKey === undefined ||
          !shouldReloadForClaudeModChange(sessionKey, 'skipped'))
      ) {
        continue;
      }
      record.relaunchWhenIdle = true;
      this.syncIdleTtl(record);
    }
  }

  private syncIdleTtl(record: RuntimeRecord): void {
    if (record.state.turnState === 'idle') {
      this.scheduleIdleTtl(record);
    } else {
      this.clearIdleTtl(
        runtimeKey(record.projectId, record.worktreeId, record.chatId),
      );
    }
  }

  public async syncTranscript(
    input: TranscriptSyncRequest,
  ): Promise<TranscriptSyncResultWithMessages> {
    return syncClaudeTerminalTranscript(input);
  }

  private async syncTranscriptForHook(
    record: RuntimeRecord,
    input: HookStateUpdate,
    turnDiff?: TurnDiffData,
    fallbackTurnTimer?: TranscriptSyncRequest['fallbackTurnTimer'],
  ): Promise<TranscriptSyncResultWithMessages> {
    this.recordDiagnostic(record, 'terminal_transcript_sync_start', {
      transcriptPath: record.transcriptPath,
      eventType: input.hookEventName,
    });
    const { result } = await this.syncTranscriptForRecord(record, {
      projectId: record.projectId,
      worktreeId: record.worktreeId,
      chatId: record.chatId,
      sessionKey: input.sessionKey,
      sdkSessionId: record.state.sdkSessionId ?? '',
      transcriptPath: record.transcriptPath,
      hookEventName: input.hookEventName,
      hookPayload: input.hookPayload,
      ...(record.suppressDeferredToolsReloadContinuation
        ? { suppressDeferredToolsReloadContinuation: true }
        : {}),
      ...(turnDiff ? { turnDiff } : {}),
      ...(fallbackTurnTimer ? { fallbackTurnTimer } : {}),
    });
    this.recordDiagnostic(record, 'terminal_transcript_sync_end', {
      transcriptPath: result.transcriptPath,
      importedEventCount: result.importedEventCount,
      compactionAppended: result.compactionAppended,
      eventType: input.hookEventName,
      error: result.errors?.join('\n'),
    });
    if (result.errors && result.errors.length > 0) {
      this.recordDiagnostic(record, 'terminal_transcript_sync_failure', {
        transcriptPath: result.transcriptPath,
        importedEventCount: result.importedEventCount,
        compactionAppended: result.compactionAppended,
        eventType: input.hookEventName,
        error: result.errors.join('\n'),
      });
    }
    if (result.compactionAppended) {
      this.recordDiagnostic(record, 'terminal_compaction_appended', {
        transcriptPath: result.transcriptPath,
        importedEventCount: result.importedEventCount,
        compactionAppended: true,
        eventType: input.hookEventName,
      });
    }
    return result;
  }

  private async syncTranscriptForRecord(
    record: RuntimeRecord,
    input: TranscriptSyncRequest,
  ): Promise<ProcessedTranscriptSyncResult> {
    const key = runtimeKey(record.projectId, record.worktreeId, record.chatId);
    const existing = this.inflightTranscriptSyncs.get(key);
    if (existing) {
      return existing;
    }
    const wasRecovering = this.recoveringWatchers.has(key);
    this.recoveringWatchers.add(key);
    const pending = this.syncTranscript(input)
      .then(async (result) => {
        const event = await this.processTranscriptSyncResult(record, result);
        return {
          result,
          ...(event ? { event } : {}),
        };
      })
      .finally(() => {
        if (this.inflightTranscriptSyncs.get(key) === pending) {
          this.inflightTranscriptSyncs.delete(key);
        }
        if (!wasRecovering) this.recoveringWatchers.delete(key);
      });
    this.inflightTranscriptSyncs.set(key, pending);
    return pending;
  }

  private async processTranscriptSyncResult(
    record: RuntimeRecord,
    result: TranscriptSyncResultWithMessages,
  ): Promise<ClaudeTerminalTranscriptSyncEventData | undefined> {
    this.feedAuditTranscriptEvents(record, result);
    const event = await this.emitTranscriptSyncResult(record, result);
    this.maybeScheduleChatSummary(record, result);
    await this.publishWatcherObservations(record, result);
    return event;
  }

  /**
   * Forward newly-imported raw transcript events into the open audit-trail
   * entry so terminal turns get the same transcript sidecars, message
   * counts, and tool counts as Canopy-native turns.
   *
   * Replays re-read the transcript from byte 0, so a lost cursor could feed
   * the session's entire history into the open turn. Instead of skipping
   * replays outright (which would finalize the turn with zero usage), feed
   * only the events whose ids match the genuinely-new imported messages —
   * mid-turn usage still accrues while the flood risk stays contained.
   */
  private feedAuditTranscriptEvents(
    record: RuntimeRecord,
    result: TranscriptSyncResultWithMessages,
  ): void {
    if (!record.auditTurnOpen) {
      return;
    }
    const observability = getExecutionObservabilityIngest();
    let importedEvents: unknown[] = Array.isArray(result.importedEvents)
      ? result.importedEvents
      : [];
    if (result.replayedFromStart === true) {
      const newMessageIds = new Set(
        result.importedMessages.map((message) => message.id),
      );
      importedEvents = importedEvents.filter((event) => {
        const eventId =
          getStringField(event, 'uuid') ??
          getStringField(event, 'id') ??
          getStringField(event, 'message_id');
        return eventId !== undefined && newMessageIds.has(eventId);
      });
    }
    for (const event of importedEvents) {
      accumulateTurnUsage(record.turnUsage, event);
      observability.observeChatEvent(
        record.projectId,
        record.worktreeId,
        record.chatId,
        event,
      );
    }
  }

  /**
   * Terminal turns bypass the Canopy-native send path that schedules the
   * chat-summary helper, so generated tab descriptions never populate for
   * terminal/auto chats without this hook. Canonical naming eligibility and
   * the shared scheduler coalesce attempts; failed writes remain retryable.
   */
  private maybeScheduleChatSummary(
    record: RuntimeRecord,
    result: TranscriptSyncResultWithMessages,
  ): void {
    if (
      !result.importedMessages.some(
        (message) => message.role === 'user' && message.hidden !== true,
      )
    )
      return;
    void getChatStateService()
      .getInitialChatTitlePrompt(
        { projectId: record.projectId, worktreeId: record.worktreeId },
        record.chatId,
      )
      .then((prompt) => {
        if (prompt === null) return;
        this.chatSummaryScheduler({
          projectId: record.projectId,
          worktreeId: record.worktreeId,
          chatId: record.chatId,
          workOwner: resolveSessionWorkOwner(record),
        });
      })
      .catch((error: unknown) => {
        // A failed eligibility read only skips this attempt; a later
        // transcript sync or send retries naming.
        // eslint-disable-next-line no-console
        console.warn('[chat-summary] Terminal naming check failed', error);
      });
  }

  private async emitTranscriptSyncResult(
    record: RuntimeRecord,
    result: TranscriptSyncResultWithMessages,
  ): Promise<ClaudeTerminalTranscriptSyncEventData | undefined> {
    // Raw provider transcript events stay in the main-process audit path; do
    // not include them (or the private imported message list) in the renderer
    // completion event.
    const {
      importedMessages,
      importedEvents: _importedEvents,
      lifecycleMessages: _lifecycleMessages,
      transcriptReadComplete: _transcriptReadComplete,
      ...publicResult
    } = result;
    void _importedEvents;
    void _lifecycleMessages;
    void _transcriptReadComplete;
    let eventData: ClaudeTerminalTranscriptSyncEventData | undefined;
    if (
      importedMessages.length > 0 ||
      result.settingsSync !== undefined ||
      result.turnDiffs !== undefined
    ) {
      eventData = {
        type: 'claude_terminal_transcript_sync',
        messages: importedMessages,
        importedEventCount: result.importedEventCount,
        ...(result.transcriptPath
          ? { transcriptPath: result.transcriptPath }
          : {}),
        ...(typeof result.replayedFromStart === 'boolean'
          ? { replayedFromStart: result.replayedFromStart }
          : {}),
        ...(typeof result.compactionAppended === 'boolean'
          ? { compactionAppended: result.compactionAppended }
          : {}),
        ...(result.settingsSync ? { settingsSync: result.settingsSync } : {}),
        ...(result.turnDiffs ? { turnDiffs: result.turnDiffs } : {}),
        ...(result.errors ? { errors: result.errors } : {}),
      };
      await getChatStateService().ingestProviderEvent({
        projectId: record.projectId,
        worktreeId: record.worktreeId,
        chatId: record.chatId,
        data: eventData,
        source: 'terminal',
      });
      this.eventSender(IPC_CHANNELS.chatEvent, {
        projectId: record.projectId,
        worktreeId: record.worktreeId,
        chatId: record.chatId,
        data: eventData,
      });
    }
    this.eventSender(IPC_CHANNELS.claudeTerminalSyncCompleted, publicResult);
    return eventData;
  }

  private scheduleTrailingTranscriptSync(
    record: RuntimeRecord,
    input: HookStateUpdate,
    attempt = 1,
  ): void {
    if (this.watcherRecoveryStopped) return;
    const key = runtimeKey(record.projectId, record.worktreeId, record.chatId);
    const existingTimer = this.trailingSyncTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      this.trailingSyncTimers.delete(key);
      const current = this.records.get(key);
      if (!current && record.state.turnState === 'exited') {
        void this.resumePendingObservations(record)
          .then(() => readTerminalWatcherObservations(record.runtimeDir))
          .then((observations) => {
            if (
              attempt < MAX_TRAILING_TRANSCRIPT_SYNC_ATTEMPTS &&
              observations.some(
                (item) => item.terminalAt && !item.terminalDelivered,
              )
            )
              this.scheduleTrailingTranscriptSync(record, input, attempt + 1);
          })
          .catch((error: unknown) => {
            this.recordDiagnostic(record, 'terminal_transcript_sync_failure', {
              error: error instanceof Error ? error.message : String(error),
            });
            if (attempt < MAX_TRAILING_TRANSCRIPT_SYNC_ATTEMPTS)
              this.scheduleTrailingTranscriptSync(record, input, attempt + 1);
          });
        return;
      }
      if (!current || current.state.sessionKey !== input.sessionKey) return;
      void this.syncTranscriptForHook(current, input)
        .then(async (result) => {
          current.state = {
            ...current.state,
            lastSyncAt: Date.now(),
          };
          this.emitState(current);
          await this.persistTabState(
            current.projectId,
            current.worktreeId,
            current.chatId,
            { claudeTerminal: current.state },
          );
          // The turn timer may still be missing when slow Stop hooks delay
          // the `turn_duration` line — keep retrying within the cap.
          if (
            attempt < MAX_TRAILING_TRANSCRIPT_SYNC_ATTEMPTS &&
            (!importedTurnCompletionMessage(result) ||
              current.watcherObservations?.some(
                (item) => item.terminalAt && !item.terminalDelivered,
              ))
          ) {
            this.scheduleTrailingTranscriptSync(current, input, attempt + 1);
          }
        })
        .catch((error: unknown) => {
          if (attempt < MAX_TRAILING_TRANSCRIPT_SYNC_ATTEMPTS)
            this.scheduleTrailingTranscriptSync(current, input, attempt + 1);
          this.recordDiagnostic(current, 'terminal_transcript_sync_failure', {
            transcriptPath: current.transcriptPath,
            eventType: input.hookEventName,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, TRAILING_TRANSCRIPT_SYNC_DELAY_MS);
    if (process.env.NODE_ENV !== 'test') {
      timer.unref?.();
    }
    this.trailingSyncTimers.set(key, timer);
  }

  public async shutdown(
    options: { recordInterrupted?: boolean } = {},
  ): Promise<void> {
    this.watcherRecoveryStopped = true;
    for (const timer of Array.from(this.trailingSyncTimers.values()))
      clearTimeout(timer);
    this.trailingSyncTimers.clear();
    const failures: unknown[] = [];
    if (options.recordInterrupted) {
      this.shutdownStarted = true;
      await Promise.allSettled(this.inflightLaunches.values());
      const records = Array.from(this.records.values());
      const interrupted = records.filter((record) =>
        ['running', 'starting'].includes(record.state.turnState),
      );
      // Keep these lazy to avoid pulling registry and target-resolution
      // modules into the terminal session service's initialization cycle.
      const { recordInterruptedChats } =
        await import('../lib/usage-limited-chats-registry');
      const { isRealWorkspaceTarget } = await import('../lib/chat-targets');
      try {
        await recordInterruptedChats(
          interrupted
            .map((record) => ({
              projectId: record.projectId,
              worktreeId: record.worktreeId,
              chatId: record.chatId,
              provider: 'claude' as const,
              detectedAt: Date.now(),
              resumeReason: 'app_shutdown' as const,
              workspaceName: '',
              chatTitle: '',
            }))
            .filter(isRealWorkspaceTarget),
        );
      } catch (error) {
        failures.push(error);
      }
      const interruptedStops = await Promise.allSettled(
        interrupted.map(async (record) => {
          if (record.state.turnState === 'running' && record.state.terminalId) {
            // Escape uses Claude Code's own turn interruption. Keep hook and output
            // routes alive until it acknowledges the stop and finishes syncing.
            workerTerminal.write(record.state.terminalId, '\u001b');
            const deadline = Date.now() + 10_000;
            while (
              record.state.turnState === 'running' ||
              record.interruptSettling
            ) {
              if (Date.now() >= deadline)
                throw new Error(
                  'Claude terminal did not acknowledge shutdown interruption',
                );
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
          const key = runtimeKey(
            record.projectId,
            record.worktreeId,
            record.chatId,
          );
          await this.inflightTranscriptSyncs.get(key);
          const result = await this.syncTranscriptForChat(record);
          if (result.errors?.length) throw new Error(result.errors.join('\n'));
        }),
      );
      for (const result of interruptedStops) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    }
    const cleanupResults = await Promise.allSettled(
      Array.from(this.records.values()).map((record) =>
        this.cleanup({
          projectId: record.projectId,
          worktreeId: record.worktreeId,
          chatId: record.chatId,
          reason: 'app-shutdown',
        }),
      ),
    );
    for (const result of cleanupResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new Error(
        `Claude terminal shutdown failed: ${failures.map((failure) => String(failure)).join('; ')}`,
      );
    }
  }

  async handleHookCallback(
    sessionKey: string,
    body: ClaudeTerminalHookCallbackBody,
  ): Promise<unknown> {
    const record = Array.from(this.records.values()).find(
      (candidate) => candidate.state.sessionKey === sessionKey,
    );
    if (
      body.hookEventName === 'PreToolUse' &&
      record &&
      (record.interruptSettling || record.approvalTurnCancelled)
    ) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'The owning turn was cancelled.',
        },
      };
    }
    // A submitted prompt starts a turn: it carries a bounded hint when Ledger
    // entries assigned to this chat changed since it last looked. Computed
    // alongside the hook state work so both fit inside the hook's timeout.
    const ledgerHint =
      body.hookEventName === 'UserPromptSubmit' && record?.ledgerTools
        ? record.ledgerTools.assignmentHint()
        : undefined;
    await this.markHookState({
      sessionKey,
      hookEventName: body.hookEventName,
      hookPayload: body.hookPayload,
    });
    if (ledgerHint) {
      const hint = await ledgerHint;
      return hint
        ? {
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: hint,
            },
          }
        : undefined;
    }
    if (body.hookEventName === 'SubagentStart') {
      return record?.codeGraphAvailableThisTurn
        ? {
            hookSpecificOutput: {
              hookEventName: 'SubagentStart',
              additionalContext: CLAUDE_CODE_GRAPH_STEERING_CONTEXT,
            },
          }
        : undefined;
    }
    if (
      isClaudeCodeGraphPostToolUse(
        body.hookEventName,
        isUnknownRecord(body.hookPayload)
          ? getStringField(body.hookPayload, 'tool_name')
          : undefined,
      )
    ) {
      const answer = readClaudeCodeGraphToolAnswer(
        isUnknownRecord(body.hookPayload)
          ? body.hookPayload.tool_response
          : undefined,
      );
      if (record && !answer.failed) {
        record.codeGraphOrientationBlockedThisTurn = false;
        const toolName = getStringField(body.hookPayload, 'tool_name');
        await recordClaudeCodeGraphOrientation(
          {
            projectId: record.projectId,
            worktreeId: record.worktreeId,
            chatId: record.chatId,
            cwd: record.cwd ?? '',
            turn: record.codeGraphOrientationTurn,
          },
          {
            toolUseId: getStringField(body.hookPayload, 'tool_use_id'),
            rebuildsGraph:
              toolName !== undefined &&
              isClaudeCodeGraphBuildToolName(toolName),
            answeredBuildAt: answer.lastBuildAt,
          },
        );
      }
      return undefined;
    }
    if (body.hookEventName !== 'PreToolUse') {
      return undefined;
    }
    if (!isUnknownRecord(body.hookPayload)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Malformed approval hook payload.',
        },
      };
    }
    const toolName = getStringField(body.hookPayload, 'tool_name');
    const toolInput = body.hookPayload.tool_input;
    if (!toolName || !isUnknownRecord(toolInput)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Invalid tool name or input.',
        },
      };
    }
    if (!record) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Approval session is unavailable.',
        },
      };
    }
    if (
      record.assistantMode === 'app-advisor' &&
      toolName === APP_ADVISOR_TOOL_REGISTRY.watch_command.claudeToolName
    ) {
      // The App Advisor runtime resolves the selected worktree and owns the
      // sole command approval. The terminal cwd is intentionally unrelated.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }
    if (!record.approvalSession) {
      if (isClaudeCodeGraphToolName(toolName)) {
        record.codeGraphOrientationBlockedThisTurn = true;
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Approval session is unavailable.',
        },
      };
    }
    if (
      (toolName === 'Read' ||
        toolName === 'Grep' ||
        toolName === 'Glob' ||
        toolName === 'Bash') &&
      record.codeGraphAvailableThisTurn === true &&
      record.codeGraphCustomSourceExtensionsThisTurn === undefined
    ) {
      record.codeGraphCustomSourceExtensionsThisTurn =
        await loadConfiguredClaudeCodeGraphSourceExtensions({
          projectId: record.projectId,
          worktreeId: record.worktreeId,
        });
    }
    const graphScope = {
      projectId: record.projectId,
      worktreeId: record.worktreeId,
      chatId: record.chatId,
      cwd: record.cwd ?? '',
      turn: record.codeGraphOrientationTurn,
    };
    const graphCallId = getStringField(body.hookPayload, 'tool_use_id');
    // Also before a first build, which must orient later turns.
    if (graphCallId !== undefined && isClaudeCodeGraphToolName(toolName)) {
      await beginClaudeCodeGraphToolCall(graphScope, graphCallId, toolName);
    }
    const steeringContext = buildClaudeCodeGraphPreToolUseContext({
      toolName,
      toolInput,
      cwd: record.cwd ?? '',
      graphAvailable: record.codeGraphAvailableThisTurn === true,
      customSourceExtensions: record.codeGraphCustomSourceExtensionsThisTurn,
    });
    const additionalContext =
      steeringContext &&
      !(await isClaudeCodeGraphOrientationCurrent(graphScope))
        ? steeringContext
        : undefined;
    const advisoryContext =
      additionalContext && record.codeGraphOrientationBlockedThisTurn === true
        ? additionalContext
        : undefined;
    if (additionalContext && !advisoryContext) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: additionalContext,
          additionalContext,
        },
      };
    }
    // Plan mode's explicit bookkeeping exception, as in native Claude chats:
    // Ledger calls follow the ordinary approval policy, never a Plan mode
    // denial, and an allowed call carries a reminder that it grants no edits
    // or execution.
    const bookkeepingContext =
      record.planMode && isClaudePlanModeBookkeepingTool(toolName)
        ? CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT
        : undefined;
    if (record.approvalMode === 'full-access') {
      const fullAccessContext = advisoryContext ?? bookkeepingContext;
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          ...(fullAccessContext
            ? { additionalContext: fullAccessContext }
            : {}),
        },
      };
    }
    const approval = approvalCheckForClaudeTool(
      toolName,
      toolInput,
      record.cwd,
    );
    if (approval.failClosedReason) {
      if (isClaudeCodeGraphToolName(toolName)) {
        record.codeGraphOrientationBlockedThisTurn = true;
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: approval.failClosedReason,
        },
      };
    }
    let outcome: ApprovalOutcome = { decision: 'allow' };
    for (const requirement of [
      approval,
      ...(approval.additionalRequirements ?? []),
    ]) {
      outcome = await record.approvalSession.check(requirement.check, {
        title: `Claude Code wants to use ${requirement.titleTool ?? toolName}`,
        details: requirement.details,
        suggestedTarget: requirement.suggestedTarget,
        toolUseId: getStringField(body.hookPayload, 'tool_use_id'),
      });
      if (outcome.decision !== 'allow') {
        break;
      }
    }
    if (outcome.decision !== 'allow') {
      outcome = {
        decision: 'deny',
        message: outcome.message ?? 'Approval check failed; denied by default.',
        ...(outcome.stopTurn ? { stopTurn: true } : {}),
      };
    }
    if (outcome.decision === 'deny' && isClaudeCodeGraphToolName(toolName)) {
      record.codeGraphOrientationBlockedThisTurn = true;
    }
    const modelContext =
      advisoryContext ??
      (outcome.decision === 'allow' ? bookkeepingContext : undefined);
    return {
      ...(outcome.stopTurn
        ? {
            continue: false,
            stopReason: outcome.message ?? 'Tool use denied and turn stopped.',
          }
        : {}),
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: outcome.decision,
        ...(outcome.message
          ? { permissionDecisionReason: outcome.message }
          : {}),
        ...(modelContext ? { additionalContext: modelContext } : {}),
      },
    };
  }

  private handleTerminalEvent(event: WorkerTerminalEvent): void {
    if (event.type === 'output') {
      this.handleFirstTerminalOutput(event.payload);
      this.handleTerminalOutputForInterruptedTurn(event.payload);
      return;
    }
    if (event.type === 'runningChanged') {
      this.handleTerminalRunningChanged(event.payload);
      return;
    }
    if (event.type !== 'exit') return;
    const payload = event.payload;
    this.pendingFirstOutputTerminalIds.delete(payload.terminalId);
    this.terminalOutputDetectionTails.delete(payload.terminalId);
    const record = this.recordsByTerminalId.get(payload.terminalId);
    if (!record) return;
    if (
      record.planImplementationUserMessageId ||
      record.pendingPlanImplementationUserMessageId ||
      record.watcherObservations?.some((item) => !item.terminalAt)
    ) {
      const receivedHooks = record.state.sessionKey
        ? this.hookTails.get(record.state.sessionKey)
        : undefined;
      void (receivedHooks ?? Promise.resolve())
        .catch(() => undefined)
        .then(() =>
          this.settlePlanImplementation(
            record,
            payload.exitCode === 0 ? 'cancelled' : 'failed',
          ),
        )
        .then(() => this.settleExitedWatcherTurn(record, payload.exitCode))
        .catch((error: unknown) => {
          this.recordDiagnostic(record, 'terminal_transcript_sync_failure', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .then(() => {
          if (
            record.watcherObservations?.some(
              (item) => item.terminalAt && !item.terminalDelivered,
            )
          )
            this.scheduleTrailingTranscriptSync(record, {
              sessionKey: record.state.sessionKey ?? '',
              hookEventName: 'SessionEnd',
              hookPayload: { source: 'exit-recovery' },
            });
        });
    }
    this.recordsByTerminalId.delete(payload.terminalId);
    this.closeAuditTurn(
      record,
      'interrupted',
      'Claude Code terminal process exited mid-turn.',
    );
    this.endPlanTurn(record);
    record.state = { ...record.state, turnState: 'exited' };
    this.recordDiagnostic(record, 'claude_terminal_process_exit', {
      turnActive: false,
      exitCode: payload.exitCode,
      signal: toNodeSignal(payload.signal),
    });
    if (record.state.sessionKey) {
      const server = getDesktopIntegrationServer();
      server.unregisterCanopyWorktreeSessionRoute(record.state.sessionKey);
      server.unregisterMcpProxyRoutesForSession(record.state.sessionKey);
    }
    record.ledgerTools?.dispose();
    record.ledgerTools = undefined;
    record.approvalSession?.dispose();
    record.approvalSession = undefined;
    const key = runtimeKey(record.projectId, record.worktreeId, record.chatId);
    this.clearIdleTtl(key);
    void this.removeRuntimeArtifacts(record, 'manual').catch((error) => {
      this.recordDiagnostic(record, 'claude_terminal_process_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    void this.persistTabState(
      record.projectId,
      record.worktreeId,
      record.chatId,
      {
        claudeTerminal: record.state,
      },
    ).catch((error) => {
      this.recordDiagnostic(record, 'claude_terminal_process_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.records.delete(key);
    this.emitState(record);
  }

  private async settleExitedWatcherTurn(
    record: RuntimeRecord,
    exitCode: number | null,
  ): Promise<void> {
    await this.observeWatcherTerminal(
      record,
      exitCode === 0 ? 'interrupted' : 'error',
    );
    if (!record.transcriptPath && record.state.sdkSessionId && record.cwd) {
      record.transcriptPath = await resolveClaudeCodeSessionTranscriptPath(
        record.state.sdkSessionId,
        record.cwd,
      );
    }
    await this.syncTranscriptForHook(
      record,
      {
        sessionKey: record.state.sessionKey ?? '',
        hookEventName: 'SessionEnd',
        hookPayload: { exitCode },
      },
      undefined,
      {
        id: `terminal-exit:${record.state.sessionKey}:${record.state.startedAt}`,
        startedAt: record.state.startedAt,
        completedAt: Date.now(),
      },
    );
  }

  /**
   * Stamp `firstOutputAt` when a freshly spawned CLI produces its first PTY
   * output. The renderer keeps a "starting" overlay over the terminal pane
   * until this lands, and the recorded spawn→output latency makes slow cold
   * starts attributable from session diagnostics.
   */
  /** A daemon terminal can report output or its exit before its launch resumes (CAN-5097 D16). */
  private reconcilePlacedTerminalEvents(
    record: RuntimeRecord,
    terminalId: string,
  ): void {
    if (!workerTerminal.get(terminalId)) {
      this.handleTerminalEvent({
        type: 'exit',
        payload: {
          projectId: record.projectId,
          worktreeId: record.worktreeId,
          terminalId,
          kind: 'claude-code',
          exitCode: null,
          signal: WORKER_TERMINAL_LOST_SIGNAL,
        },
      });
      return;
    }
    if (workerTerminal.replayText(terminalId))
      this.noteFirstTerminalOutput(terminalId);
  }

  private handleFirstTerminalOutput(payload: TerminalOutputEvent): void {
    this.noteFirstTerminalOutput(payload.terminalId);
  }

  private noteFirstTerminalOutput(terminalId: string): void {
    if (!this.pendingFirstOutputTerminalIds.has(terminalId)) {
      return;
    }
    this.pendingFirstOutputTerminalIds.delete(terminalId);
    const record = this.recordsByTerminalId.get(terminalId);
    if (!record || record.state.firstOutputAt !== undefined) {
      return;
    }
    const now = Date.now();
    record.state = { ...record.state, firstOutputAt: now };
    this.emitState(record);
    this.recordDiagnostic(record, 'claude_terminal_first_output', {
      ...(record.spawnedAt !== undefined
        ? { elapsedMs: now - record.spawnedAt }
        : {}),
    });
    void this.persistTabState(
      record.projectId,
      record.worktreeId,
      record.chatId,
      {
        claudeTerminal: record.state,
      },
    ).catch(() => undefined);
  }

  private handleTerminalRunningChanged(
    payload: TerminalRunningChangedEvent,
  ): void {
    if (payload.running || payload.interruptedByUser !== true) {
      return;
    }
    const record = this.recordsByTerminalId.get(payload.terminalId);
    if (!record || record.state.turnState !== 'running') {
      return;
    }
    void this.settleUserInterruptedTurn(
      record,
      'terminal-running-changed',
    ).catch((error: unknown) => {
      this.recordDiagnostic(record, 'claude_terminal_process_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private handleTerminalOutputForInterruptedTurn(
    payload: TerminalOutputEvent,
  ): void {
    const record = this.recordsByTerminalId.get(payload.terminalId);
    if (!record || record.state.turnState !== 'running') {
      return;
    }
    const chunk = Buffer.from(payload.data).toString('utf8');
    const previousTail =
      this.terminalOutputDetectionTails.get(payload.terminalId) ?? '';
    const nextTail = `${previousTail}${chunk}`.slice(
      -TERMINAL_OUTPUT_INTERRUPTION_DETECTION_TAIL_CHARS,
    );
    this.terminalOutputDetectionTails.set(payload.terminalId, nextTail);
    if (!terminalOutputIndicatesUserInterruptedTurn(nextTail)) {
      return;
    }
    void this.settleUserInterruptedTurn(record, 'terminal-output').catch(
      (error: unknown) => {
        this.recordDiagnostic(record, 'claude_terminal_process_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  private async settleUserInterruptedTurn(
    record: RuntimeRecord,
    source: InterruptSource,
  ): Promise<void> {
    if (record.state.turnState !== 'running' || record.interruptSettling) {
      return;
    }
    record.interruptSettling = true;
    record.approvalTurnCancelled = true;
    record.approvalSession?.invalidatePending?.();
    try {
      const interruptedAt = Date.now();
      await this.settlePlanImplementation(record, 'cancelled');
      await this.observeWatcherTerminal(
        record,
        'interrupted',
        false,
        interruptedAt,
      );
      let turnDiff: TurnDiffData | undefined;
      try {
        turnDiff = await this.closeTurnDiffCapture(record);
      } catch (error) {
        this.recordDiagnostic(record, 'claude_terminal_process_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (record.state.turnState !== 'running') {
        return;
      }
      if (INTERRUPT_TRANSCRIPT_SYNC_DELAY_MS > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, INTERRUPT_TRANSCRIPT_SYNC_DELAY_MS),
        );
      }
      if (!record.transcriptPath && record.state.sdkSessionId && record.cwd) {
        record.transcriptPath = await resolveClaudeCodeSessionTranscriptPath(
          record.state.sdkSessionId,
          record.cwd,
        );
      }
      const syncInput: HookStateUpdate = {
        sessionKey: record.state.sessionKey ?? '',
        hookEventName: 'SessionEnd',
        hookPayload: { source },
      };
      const fallbackTurnTimerKey =
        typeof record.state.startedAt === 'number'
          ? record.state.startedAt
          : interruptedAt;
      const fallbackTurnTimer = {
        id: `claude-terminal-interrupted-turn:${record.state.sessionKey ?? record.chatId}:${fallbackTurnTimerKey}`,
        ...(typeof record.state.startedAt === 'number'
          ? { startedAt: record.state.startedAt }
          : {}),
        completedAt: interruptedAt,
      };
      try {
        const result = await this.syncTranscriptForHook(
          record,
          syncInput,
          turnDiff,
          fallbackTurnTimer,
        );
        if (!importedTurnCompletionMessage(result)) {
          this.scheduleTrailingTranscriptSync(record, syncInput);
        }
      } catch (error) {
        this.recordDiagnostic(record, 'terminal_transcript_sync_failure', {
          transcriptPath: record.transcriptPath,
          eventType: source,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.closeAuditTurn(
        record,
        'interrupted',
        'Claude Code turn interrupted by user.',
      );
      if (record.state.terminalId) {
        this.terminalOutputDetectionTails.delete(record.state.terminalId);
      }
      record.state = {
        ...record.state,
        turnState: 'idle',
        lastHookAt: Date.now(),
      };
      this.endPlanTurn(record);
      this.emitState(record);
      this.recordDiagnostic(record, 'terminal_turn_idle', {
        turnActive: false,
        eventType: source,
      });
      this.syncIdleTtl(record);
      await this.persistTabState(
        record.projectId,
        record.worktreeId,
        record.chatId,
        {
          claudeTerminal: record.state,
        },
      );
    } finally {
      record.interruptSettling = false;
    }
  }

  private emitState(record: RuntimeRecord): void {
    // The runtime-state shape itself does not embed routing ids, but the
    // IPC event router needs projectId/worktreeId to fan App Advisor events
    // out to the advisor window — without them, state changes (turn state,
    // readyForInput, firstOutputAt) only ever reach the main window and the
    // advisor surface goes stale.
    this.eventSender(IPC_CHANNELS.claudeTerminalStateChanged, {
      ...record.state,
      projectId: record.projectId,
      worktreeId: record.worktreeId,
      chatId: record.chatId,
    });
  }

  private async persistTabState(
    projectId: string,
    worktreeId: string,
    chatId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await enqueueChatTabMutation(projectId, worktreeId, async () => {
      const tabsFile = await readChatTabsFile(projectId, worktreeId);
      await writeChatTabsFile(projectId, worktreeId, {
        ...tabsFile,
        tabs: tabsFile.tabs.map((tab) =>
          tab.id === chatId ? { ...tab, ...patch } : tab,
        ),
      });
    });
  }

  private async removeRuntimeArtifacts(
    record: RuntimeRecord,
    reason: ClaudeTerminalCleanupReason,
  ): Promise<void> {
    if (reason === 'chat-closed' || reason === 'worktree-deletion') {
      await rm(terminalWatcherObservationsPath(record.runtimeDir), {
        force: true,
      });
      await rm(record.runtimeDir, { recursive: true, force: true });
      return;
    }
    await rm(path.join(record.runtimeDir, `${BRAND.internalName}-mcp.json`), {
      force: true,
    });
  }

  private recordDiagnostic(
    record: RuntimeRecord,
    kind:
      | 'terminal_transcript_sync_start'
      | 'terminal_transcript_sync_end'
      | 'terminal_transcript_sync_failure'
      | 'terminal_turn_active'
      | 'terminal_turn_idle'
      | 'terminal_turn_diff_capture_open_failure'
      | 'terminal_compaction_appended'
      | 'claude_terminal_first_output'
      | 'claude_terminal_process_exit'
      | 'claude_terminal_process_error'
      | 'claude_terminal_workspace_trust_error',
    extra: {
      cwd?: string;
      turnActive?: boolean;
      eventType?: string;
      importedEventCount?: number;
      transcriptPath?: string;
      compactionAppended?: boolean;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      error?: string;
      elapsedMs?: number;
    } = {},
  ): void {
    getExecutionObservabilityIngest().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind,
      sessionKey: `${record.projectId}/${record.worktreeId}/${record.chatId}`,
      projectId: record.projectId,
      worktreeId: record.worktreeId,
      chatId: record.chatId,
      providerType: 'claude',
      terminal: true,
      turnActive: extra.turnActive ?? record.state.turnState === 'running',
      lastActivityAt: Date.now(),
      ...(extra.eventType ? { eventType: extra.eventType } : {}),
      ...(typeof extra.importedEventCount === 'number'
        ? { importedEventCount: extra.importedEventCount }
        : {}),
      ...(extra.transcriptPath ? { transcriptPath: extra.transcriptPath } : {}),
      ...(extra.cwd ? { cwd: extra.cwd } : {}),
      ...(typeof extra.compactionAppended === 'boolean'
        ? { compactionAppended: extra.compactionAppended }
        : {}),
      ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
      ...(extra.signal !== undefined ? { signal: extra.signal } : {}),
      ...(extra.error ? { error: extra.error } : {}),
      ...(extra.elapsedMs !== undefined ? { elapsedMs: extra.elapsedMs } : {}),
    });
  }
}

let service: ClaudeTerminalSessionService | null = null;

export function getClaudeTerminalSessionService(): ClaudeTerminalSessionService {
  if (!service) {
    service = new DefaultClaudeTerminalSessionService();
  }
  return service;
}
