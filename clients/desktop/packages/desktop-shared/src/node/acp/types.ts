import type {
  AuthenticateRequest,
  AuthenticateResponse,
  CloseSessionResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  DeleteSessionResponse,
  Implementation,
  InitializeResponse,
  JsonRpcId,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk';
import type {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from 'node:stream/web';

/** The host owns executable selection, credentials, stderr, and process cleanup. */
export interface AcpTransport {
  input: ReadableStream<Uint8Array> | NodeReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array> | NodeWritableStream<Uint8Array>;
  /** Called exactly once on disposal, failure, or peer disconnect. */
  close(): void;
}

export interface AcpPermissionRequest {
  requestId: JsonRpcId;
  resourceGeneration: number;
  request: RequestPermissionRequest;
  /** Aborted on request/turn cancellation, timeout, completion, or disconnect. */
  signal: AbortSignal;
}

export interface AcpClientOptions {
  transport: AcpTransport;
  clientInfo: Implementation;
  /**
   * Vendor extension flags sent as `clientCapabilities._meta` on
   * `initialize`. The agent negotiates behavior from them for the whole
   * connection (Cursor's parameterized model picker, for example).
   */
  clientCapabilityMeta?: Record<string, unknown>;
  resourceGeneration: number;
  onUpdate(
    update: SessionNotification,
    resourceGeneration: number,
  ): void | Promise<void>;
  /** The host evaluates policy and remembers rules. The wire reply is one-shot. */
  onPermission?: (request: AcpPermissionRequest) => Promise<'allow' | 'deny'>;
  timeouts?: {
    initializeMs?: number;
    requestMs?: number;
    /**
     * Deadline for a whole `session/prompt` turn. `null` removes it: the turn
     * then ends only when the agent finishes, the host cancels, or the
     * connection drops, which interactive chat needs for long agentic work.
     */
    promptMs?: number | null;
    permissionMs?: number;
    /** Grace for an agent to acknowledge an RPC cancellation. */
    cancelMs?: number;
    /**
     * Grace for a cancelled turn to wind down after `session/cancel`. Missing it
     * closes the connection, so keep it long enough for tools to finish.
     */
    turnCancelMs?: number;
  };
  maxMessageBytes?: number;
  /** Updates buffered before `session/new` responds; more closes the connection. */
  maxPendingUpdates?: number;
}

/** Always send the complete MCP selection, including an explicit empty list. */
export type AcpResumeSessionRequest = ResumeSessionRequest &
  Pick<NewSessionRequest, 'mcpServers'>;

export type AcpForkSessionRequest = ForkSessionRequest &
  Pick<NewSessionRequest, 'mcpServers'>;

export interface AcpClient {
  readonly closed: Promise<void>;
  /** Returns a defensive copy, including negotiated extension metadata. */
  getInitialization(): InitializeResponse;
  /** Whether initialization advertised `additionalDirectories` on sessions. */
  supportsAdditionalDirectories(): boolean;
  authenticate(
    params: AuthenticateRequest,
    signal?: AbortSignal,
  ): Promise<AuthenticateResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  forkSession(
    params: AcpForkSessionRequest,
    signal?: AbortSignal,
  ): Promise<ForkSessionResponse>;
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
  resumeSession(
    params: AcpResumeSessionRequest,
  ): Promise<ResumeSessionResponse>;
  listSessions(
    params?: ListSessionsRequest,
    signal?: AbortSignal,
  ): Promise<ListSessionsResponse>;
  closeSession(sessionId: string): Promise<CloseSessionResponse>;
  deleteSession(sessionId: string): Promise<DeleteSessionResponse>;
  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
    signal?: AbortSignal,
  ): Promise<SetSessionConfigOptionResponse>;
  prompt(
    params: PromptRequest,
    resourceGeneration: number,
    signal?: AbortSignal,
  ): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  /**
   * Send an agent-specific request verbatim; agents differ on the `_` prefix.
   * Core ACP methods are rejected, and the unvalidated result is the caller's
   * to check. Like every request, a missed deadline, or a cancellation the
   * agent does not acknowledge in time, fails the whole connection.
   */
  extMethod(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown>;
  /** Reject future work on this profile; existing work can settle normally. */
  invalidate(): void;
  close(): void;
}
