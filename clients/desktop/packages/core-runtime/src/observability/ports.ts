import type {
  AgentAuditEntry,
  AgentAuditInterfaceToolCall,
  AgentAuditProvider,
  AgentAuditStatus,
  AgentTranscriptInjectedPrompt,
  UsageMetricEvent,
} from '@canopy/protocol/observability';
import type { OpenAiPricingResponseV1 } from '@canopy/protocol/openai-pricing';

/** The instrumentation operations observability reports. */
export type ObservabilityOperationName =
  | 'canopy.chat_turn'
  | 'canopy.agent_task';

export type ObservabilityOperationFailureReason =
  | 'error'
  | 'abandoned'
  | 'other';

export type ObservabilityInstrumentationContext = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface ObservabilityOperationOptions {
  operationKey?: string;
  context?: ObservabilityInstrumentationContext;
}

/**
 * Where observability reports operations and errors. The Electron entry of
 * `@canopy/desktop-instrumentation` implements it for desktop main and the
 * Node entry for headless hosts. Implementations must never throw.
 */
export interface ObservabilityInstrumentationPort {
  startOperation(
    name: ObservabilityOperationName,
    options?: ObservabilityOperationOptions,
  ): void;
  succeedOperation(
    name: ObservabilityOperationName,
    options?: ObservabilityOperationOptions,
  ): void;
  failOperation(
    name: ObservabilityOperationName,
    failureReason: ObservabilityOperationFailureReason,
    options?: ObservabilityOperationOptions,
  ): void;
  captureError(
    error: unknown,
    options?: { context?: ObservabilityInstrumentationContext },
  ): void;
}

/** The subscription account a provider is signed in with. */
export interface ObservabilityProviderAccountIdentity {
  providerAccountKey: string;
  accountEmail: string;
  planType: string | null;
}

export type ObservabilityBillingAccountKind =
  | 'subscription'
  | 'api_key'
  | 'bedrock'
  | 'unknown';

/** The providers whose own sign-in a record can be billed to. */
export type ObservabilityAccountProvider = Extract<
  AgentAuditProvider,
  'claude' | 'codex'
>;

/**
 * The provider account behind a record, read from the host's cached auth
 * state. Reads never probe the provider.
 */
export interface ObservabilityProviderAccountPort {
  peekIdentity(
    provider: ObservabilityAccountProvider,
  ): ObservabilityProviderAccountIdentity | null;
  peekBillingAccountKind(
    provider: ObservabilityAccountProvider,
  ): ObservabilityBillingAccountKind;
  /** Starts a background read so a later peek finds the identity. */
  warmIdentity(provider: ObservabilityAccountProvider, reason: string): void;
}

/** The OpenAI price list the host holds for Codex costing. */
export interface ObservabilityPricingState {
  payload?: OpenAiPricingResponseV1;
  fetchedAt?: string;
  loadedFrom: 'memory' | 'disk' | 'network' | 'none';
  stale: boolean;
}

export interface ObservabilityPricingPort {
  /** The price list now, without waiting for a fetch. */
  current(): ObservabilityPricingState;
  /** Starts loading the price list in the background. */
  prewarm(): void;
}

/**
 * Host services every observability ingest needs, whatever process it runs
 * in. A host adds its own provider-usage sources on top. Store paths are not
 * a port: the host that writes the stores resolves them, so the storage
 * census can trace its single writer.
 */
export interface ObservabilityHostServices {
  readonly instrumentation: ObservabilityInstrumentationPort;
  readonly accounts: ObservabilityProviderAccountPort;
  readonly pricing: ObservabilityPricingPort;
  /** The saved audit retention in days, when one is set. */
  readAuditRetentionDays(): Promise<number | undefined>;
}

/** Token and cost totals a producer reports when it finalizes a task. */
export interface ObservedTaskUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd?: number;
  messageCount?: number;
  assistantMessageCount?: number;
  reasoningOutputTokens?: number;
}

export type ObservedTaskPatch = Partial<
  Pick<
    AgentAuditEntry,
    | 'sdkSessionId'
    | 'model'
    | 'provider'
    | 'modelSource'
    | 'executionHarness'
    | 'chatMode'
    | 'serviceTier'
    | 'aiCreditsRouted'
    | 'modelGatewayRouted'
    | 'attempt'
    | 'rootPipelineExecutionId'
  >
>;

/** One chunk of a pipeline step's output. */
export interface PipelineStepOutputObservation {
  executionId: string;
  jobId: string;
  stepId: string;
  attempt: number;
  iteration?: number;
  data: string;
}

/**
 * What producers write through: they start, update and finalize records by
 * key, and never read observability state. `TPipelineState` is the host's
 * pipeline execution state and `TAppDiagnostic` its app diagnostic record.
 *
 * Audit records are kept open in memory until finalized. Shutdown finalizes
 * every open record as `interrupted`; a crash leaves the last stored line.
 */
export interface ExecutionObservabilityIngest<
  TPipelineState = unknown,
  TAppDiagnostic = unknown,
> {
  startObservedTask(key: string, entry: AgentAuditEntry): void;
  updateObservedTask(key: string, patch: ObservedTaskPatch): void;
  finalizeObservedTask(
    key: string,
    status: AgentAuditStatus,
    error?: string,
    usage?: ObservedTaskUsage,
  ): void;
  /** Finalizes every open record whose key starts with `prefix`. */
  interruptMatchingEntries(prefix: string): void;
  syncPipelineExecutionState(state: TPipelineState): void;
  observePipelineOutput(event: PipelineStepOutputObservation): void;
  recordUsageMetricEvent(event: UsageMetricEvent): void;
  /** App diagnostics, such as process exits and wake locks; never audit. */
  recordAppDiagnostic(record: TAppDiagnostic): void;
}

/**
 * Desktop-bound parameter types of the agent producer contract. A host binds
 * the parameters whose shapes it owns; a worker outside Electron main binds
 * its own (CAN-5096).
 */
export interface AgentObservabilityHostTypes {
  /** What `startChatTurn` takes. */
  turnStart: unknown;
  /** What `observeSteeringInput` takes. */
  steeringInput: unknown;
  /** What `seedTranscript` takes. */
  transcriptSeed: unknown;
  /** What `recordCreatedPullRequest` takes. */
  createdPullRequest: unknown;
  /** What `recordSessionDiagnostic` takes. */
  sessionDiagnostic: unknown;
}

/** The canonical turn reducer's record of an ended chat turn (CAN-5096). */
export interface CanonicalChatTurnDuration {
  /** The canonical turn id. */
  turnId: string;
  /** The user message the turn's start bound, when it bound one. */
  userMessageId?: string;
  /** Active time: wall or provider-reported time net of `pausedMs`. */
  durationMs: number;
  /** The union of the turn's approval and question pauses. */
  pausedMs: number;
}

/**
 * What chat turns, managed subagents, helper calls and their transcripts
 * write through (CAN-5096). Like `ExecutionObservabilityIngest`, producers
 * start, update and finalize records by key and never read observability
 * state. A chat turn's key is `chat:${projectId}/${worktreeId}/${chatId}`.
 */
export interface AgentObservabilityIngest<
  T extends AgentObservabilityHostTypes = AgentObservabilityHostTypes,
> {
  startChatTurn(options: T['turnStart']): void;
  observeChatEvent(
    projectId: string,
    worktreeId: string,
    chatId: string,
    data: unknown,
  ): void;
  completeChatTurn(
    projectId: string,
    worktreeId: string,
    chatId: string,
    status: AgentAuditStatus,
    error?: string,
    options?: { setupFailure?: boolean },
  ): void;
  pauseChatTurn(projectId: string, worktreeId: string, chatId: string): void;
  resumeChatTurn(projectId: string, worktreeId: string, chatId: string): void;
  /**
   * The canonical duration of a chat turn that just ended. Applies to the
   * open entry of that turn only; ignored once the entry has finalized.
   */
  recordCanonicalTurnDuration(
    projectId: string,
    worktreeId: string,
    chatId: string,
    turn: CanonicalChatTurnDuration,
  ): void;
  /**
   * An interface lease received one agent tool call (CAN-5828): binds the
   * call to the chat's open entry, the only entry its settlement can reach.
   */
  noteInterfaceToolCallDelivered(
    projectId: string,
    worktreeId: string,
    chatId: string,
    callId: string,
  ): void;
  /**
   * Which interface lease answered one agent tool call (CAN-5828). Applies
   * only to the entry that was open when the call was delivered, while it
   * is still open.
   */
  recordInterfaceToolCall(
    projectId: string,
    worktreeId: string,
    chatId: string,
    call: AgentAuditInterfaceToolCall,
  ): void;
  recordInjectedPromptForOpenChatTurn(
    projectId: string,
    worktreeId: string,
    chatId: string,
    prompt: AgentTranscriptInjectedPrompt,
  ): void;
  observeSteeringInput(options: T['steeringInput']): void;
  /** `sessionKey` is `${projectId}/${worktreeId}/${chatId}`. */
  setChatTurnServedModel(sessionKey: string, model: string): void;
  setChatTurnAccountProxyRouted(sessionKey: string, routed: boolean): void;
  beginClaudeQuery(
    queryId: string,
    startedFrom?: { sessionId: string; fork: boolean },
  ): void;
  endClaudeQuery(queryId: string): void;
  seedTranscript(key: string, seed: T['transcriptSeed']): void;
  appendTranscriptRecord(key: string, payload: unknown): void;
  /** One provider stream event of an observed helper task. */
  observeClaudeEvent(
    key: string,
    data: Record<string, unknown>,
    provider: 'claude' | 'ollama' | 'copilot' | 'opencode' | 'antigravity',
  ): void;
  appendFinalizedChatTranscriptRecord(
    projectId: string,
    worktreeId: string,
    chatId: string,
    payload: unknown,
  ): Promise<void>;
  markObservedTaskAccountProxyRouted(key: string): void;
  recordCreatedPullRequest(options: T['createdPullRequest']): void;
  /** Session diagnostics; never audit. */
  recordSessionDiagnostic(record: T['sessionDiagnostic']): void;
}
