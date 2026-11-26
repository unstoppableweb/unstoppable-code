import type { MaterializedCapabilityOverlay } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type { ManagedDelegationMode } from '@canopy/protocol/delegation/discovery';
import type { ManagedDelegationSurface } from '@canopy/protocol/delegation';
import type { InterfaceToolName } from '@canopy/protocol/canopy-core';
import type { AgentInterfacePort } from './agent-interface-port';
import type {
  ChatInputAdmission,
  ChatInputWithdrawal,
  ChatSteeringCapabilities,
} from '@canopy/protocol/remote-control/shell';
import type {
  AgentProviderType,
  AgentModelConfig,
  AiCreditsRoutingState,
  ApprovalMode,
  ApprovalRule,
  AssistantMode,
  ChatModel,
  ChatSessionSettingApplication,
  ChatSessionTurnSettings,
  ThinkingLevel,
  ModelHarness,
  ChatTabPluginSelections,
  ClaudeForkToolResult,
  CodexSpeed,
} from '@canopy/desktop-shared/types';

export type AgentSessionTurnSettings = ChatSessionTurnSettings;
import type { CodexContextWindowSetting } from '@canopy/execution-engine/lib/codex-context-window';
import type { AppAdvisorToolRuntime } from '../app-advisor/runtime';
import type { PipelineEditorToolRuntime } from '../pipeline-editor/runtime';
import type { PipelinePackageCapabilityOverlay } from '@canopy/execution-engine/types/pipeline';

export interface AgentSessionOptions {
  cwd: string;
  /** Host composition identifies the eligible parent surface. */
  managedDelegationSurface?: ManagedDelegationSurface;
  managedDelegationMode?: ManagedDelegationMode;
  managedDelegationMaxConcurrent?: number;
  managedDelegationMaxDepth?: number;
  managedDelegationLifetimeLimit?: number;
  selectedRepoId?: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  /**
   * Trusted background-run binding (`personal` / `org:<uuid>`). Interactive
   * sessions omit it and capture the live navigation context at creation.
   */
  executionContext?: string;
  planMode?: boolean;
  approvalMode?: ApprovalMode;
  sessionApprovalRules?: ApprovalRule[];
  codexProposalMode?: 'optional' | 'required';
  thinkingLevel?: ThinkingLevel;
  model?: ChatModel;
  selectedModel?: ChatModel;
  sdkSessionId?: string;
  codexReconstructionSeedId?: string;
  /** Fork the resumed Claude session instead of continuing it in place. */
  claudeForkSession?: boolean;
  /**
   * Chain uuid the forked resume must stop at (SDK `resumeSessionAt`). Only
   * applied together with `sdkSessionId` + `claudeForkSession`.
   */
  claudeForkResumeAt?: string;
  /** Start fresh and tag the init event so fork provenance discloses it. */
  claudeForkStartsFresh?: boolean;
  /**
   * Answers for tool calls left open at `claudeForkResumeAt`, sent as
   * `tool_result` blocks ahead of the fork's first prompt text.
   */
  claudeForkToolResults?: ClaudeForkToolResult[];
  pluginSelections?: ChatTabPluginSelections;
  packageOverlay?: PipelinePackageCapabilityOverlay;
  /**
   * `unattended` for a turn an automation sent (CAN-6232): a connector with
   * several accounts loads only the exact or the only account, never the
   * person's default. Omitted for a chat a person runs. Part of the session's
   * capability signature, so the two never share a live session.
   */
  accountResolution?: 'unattended';
  /**
   * An unattended turn's allowed writes on its project's shared connections
   * (CAN-6252), tool names by connection id; absent allows none. Part of the
   * session's capability signature.
   */
  sharedConnectionWrites?: Readonly<Record<string, readonly string[]>>;
  /** Host-private snapshot of this turn's successfully materialized home content. */
  inheritedCapabilityOverlay?: MaterializedCapabilityOverlay;
  /**
   * Opts this session into the global default-plugin overlay: plugin
   * resolution unions `PreferencesData.globalPluginSelections` (minus
   * workspace/chat tombstones read from persisted state) into the session's
   * selections. Set by worktree/cowork chat surfaces; helper surfaces
   * (App Advisor, pipeline editor, one-shot helpers) leave it unset so their
   * explicit selections stay authoritative.
   */
  applyGlobalPluginDefaults?: boolean;
  deferredToolsAllowed?: boolean;
  systemPromptAppend?: string;
  /**
   * Opaque Global Instructions plus opted-in repository instructions, captured
   * only for a new provider session. Excluded from logical-session matching so
   * preference and repository edits do not replace a running conversation.
   */
  globalInstructionsBlock?: string;
  /**
   * Opaque inline instruction text and rule index captured at session creation.
   * Resumes reuse this value; files read through index entries or @file
   * references remain live rather than becoming historical file snapshots.
   */
  globalInstructionsSnapshot?: string;
  providerType?: AgentProviderType;
  executionHarness?: ModelHarness;
  codexAppServerIdleTimeoutMinutes?: number;
  codexMultiAgentEnabled?: boolean;
  codexMaxConcurrentSubagents?: number | null;
  modelConfig?: AgentModelConfig;
  /** @deprecated Use modelConfig.speed. Legacy alias read after modelConfig. */
  codexFastModeEnabled?: boolean;
  rtkEnabled?: boolean;
  assistantMode?: AssistantMode;
  toolProfileHash?: string;
  /** Code Graph tool advertisement captured for this logical chat session. */
  codeGraphToolsAdvertised?: boolean;
  /**
   * Interface tools bound when the session was created (CAN-4131). Set by the
   * session manager, never by callers; absent means none.
   */
  interfaceTools?: readonly InterfaceToolName[];
  appAdvisorRuntime?: AppAdvisorToolRuntime;
  pipelineEditorRuntime?: PipelineEditorToolRuntime;
  /**
   * Per-session AI Credits fallback routing decision (CAN-838). When
   * `active`, the provider session injects gateway proxy env at spawn and
   * routes through the caller's AI Credits instead of native provider auth.
   */
  aiCreditsRouting?: AiCreditsRoutingState;
  /**
   * Per-chat billing-framework override forcing the user's native
   * Claude/Codex subscription for this session, even when a global AI Credits
   * routing mode (`on` / `on-quota`) is active. Consulted by the AI Credits
   * routing resolver — it beats the global mode but not an active
   * `aiCreditsRouting`, and only applies when the user is natively
   * authenticated for the provider.
   */
  subscriptionBillingOverride?: boolean;
  /**
   * Whether the account proxy takes this session (CAN-4020), decided once by
   * the session manager when it creates the session so the registry and the
   * session agree on how it is billed. `'off'` keeps the session off the
   * proxy; absent lets the session decide for itself.
   */
  accountProxyRouting?: 'proxy' | 'off';
  /** Trusted quota continuation: refuse any other billing connection. */
  requiredAccountProxyConnectionId?: string;
}

export interface AgentSessionSendOptions {
  /** Explicit selection plus the canonical host-owned attachment directory. */
  attachments?: { baseDir: string; paths: readonly string[] };
  /** Explicit user-authored sends only; continuations/automation default to false. */
  countsTowardSkillUsage?: boolean;
  userMessageId?: string;
  /** Host execution identity, independent of a reused visible prompt anchor. */
  lifecycleExecutionId?: string;
}

/**
 * A root chat's steering submission: an admission, or `pending` when the
 * provider has not confirmed it within the delivery deadline while the
 * session is still alive; a later acknowledgement, pickup, refusal or the
 * session's end settles it. Main-only: delegation and protocol consumers never
 * see `pending`.
 */
export type ChatInputSubmitResult =
  | ChatInputAdmission
  | {
      kind: 'pending';
      attemptId: string;
      /** Resolves once with the provider's final answer to a soft-timed-out submit. */
      settlement?: Promise<ChatInputAdmission>;
    };

export interface SteeringTarget {
  sessionId: string;
  turnId?: string;
}

export interface TypedSteeringHandoff {
  expectedTurnId: string;
  /** Synchronous check of the queue head and the captured settings revision. */
  canHandoff(): boolean;
}

export interface AgentSession {
  sendMessage(text: string, options?: AgentSessionSendOptions): void;
  getSteeringCapabilities?(): ChatSteeringCapabilities;
  /** Window selection on the live Codex thread, when a steerable turn is known. */
  getAppliedCodexContextWindow?(): CodexContextWindowSetting | undefined;
  getAppliedCodexThinkingLevel?(turnId: string): ThinkingLevel | undefined;
  getSteeringWorkingDirectory?(): string;
  /**
   * Where a steer submitted now would land: the provider session (Claude SDK
   * session id, Codex thread id) and, for Codex, the active root turn.
   */
  getSteeringTarget?(): SteeringTarget | undefined;
  /** With `target`, a provider whose live turn no longer matches refuses locally. */
  submitSteeringInput?(
    text: string,
    attemptId: string,
    userMessageId: string,
    target?: SteeringTarget,
    handoff?: TypedSteeringHandoff,
  ): Promise<ChatInputSubmitResult>;
  withdrawSteeringInput?(attemptId: string): Promise<ChatInputWithdrawal>;
  /** Settles the old result before returning; preserves the reusable query. */
  interruptWithPendingSweep?(): Promise<void>;
  hasPendingSteeringInput?(): boolean;
  /**
   * Whether the session has been torn down: destroyed, or — for providers
   * whose cancellation permanently ends the underlying provider stream —
   * canceled. `sendMessage` on a disposed session still enqueues into the
   * in-memory queue, but nothing will ever drain that queue to the provider,
   * so callers that need delivery honesty (e.g. the org-memory delivered
   * ack) must consult this after enqueueing. Absent means the implementation
   * cannot report liveness and callers should assume the session is live.
   */
  isDisposed?(): boolean;
  /**
   * Return the provider-owned persisted session/thread id once one exists.
   * This is intentionally a read-only handoff for lifecycle transitions; it
   * is not part of process or pool identity.
   */
  getProviderSessionId?(): string | undefined;
  /** True when this live session owns a proxy route for the exact MCP config. */
  usesMcpServerConfig?(
    serverId: string,
    configId: string,
  ): { displayName: string } | undefined;
  /** Queue app-server MCP refresh for this session's worker/profile. */
  reloadMcpServers?(): Promise<void>;
  /** Apply current-turn guidance when an enabled delegation policy changes. */
  setManagedDelegationMode?(mode: ManagedDelegationMode | undefined): void;
  /** Steer the currently active Codex root turn, if one is steerable. */
  steerActiveTurn?(
    text: string,
    clientUserMessageId?: string,
  ): Promise<boolean>;
  cancel(): Promise<void>;
  destroy(): Promise<void>;
  setPlanMode(enabled: boolean): Promise<void>;
  setApprovalMode(mode: ApprovalMode): Promise<void>;
  /**
   * The approval mode the session has applied, recorded by the session
   * manager: the wider one while a switch is pending or after one fails.
   * Undefined when unknown.
   */
  getAppliedApprovalMode?(): ApprovalMode | undefined;
  /**
   * The session approval rules the session evaluates, recorded by the session
   * manager: the live list its approvals read, including grants made in the
   * session and narrowing at a turn start. Undefined when unknown.
   */
  getAppliedApprovalRules?(): readonly ApprovalRule[] | undefined;
  /**
   * Apply the exact requested Codex speed to the next turn. Callers go through
   * `applyAgentSessionCodexSpeed`, which prefers this setter; the boolean
   * setters below are a Regular/Fast-only fallback and Ultra fast is rejected
   * when this setter is absent.
   */
  setSpeed?(speed: CodexSpeed): Promise<void>;
  /** @deprecated Use setSpeed. Regular/Fast-only compatibility adapter. */
  setFastMode?(enabled: boolean): Promise<void>;
  /** @deprecated Use setSpeed. */
  setCodexFastMode?(enabled: boolean): Promise<void>;
  /**
   * Apply a chat's resolved Codex context window before its next turn. A
   * change reloads the thread, since Codex reads the window only at load.
   */
  setContextWindow?(
    setting: CodexContextWindowSetting | undefined,
  ): Promise<void>;
  setCodexProposalMode?(mode: 'optional' | 'required'): Promise<void>;
  setCodexAppServerIdleTimeoutMinutes?(minutes: number): Promise<void>;
  setRtkEnabled?(enabled: boolean): Promise<void>;
  /**
   * When `setModel` and `setThinkingLevel` take effect. `next_turn` means a
   * setter only records the value for the next turn to apply; a running turn
   * keeps what it started with (`getAppliedTurnSettings`). Absent when the
   * session does not declare it.
   */
  readonly settingApplication?: ChatSessionSettingApplication;
  /**
   * The model and thinking level the running turn applied, after clamping
   * the effort to the model's levels, or the last turn's while idle.
   * Undefined before the first turn and while a turn is still preparing. A
   * provider that cannot acknowledge them fails that turn rather than
   * running with others.
   */
  getAppliedTurnSettings?(): AgentSessionTurnSettings | undefined;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  setModel(model: ChatModel): Promise<void>;
}

export interface AgentProvider {
  createSession(
    opts: AgentSessionOptions,
    onEvent: (data: unknown) => void | Promise<void>,
    interfacePort: AgentInterfacePort,
  ): AgentSession;
}
