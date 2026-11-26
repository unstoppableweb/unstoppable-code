import path from 'node:path';
import {
  AGENT_METHODS,
  PROTOCOL_METHODS,
  client,
  type AgentRequestMethod,
  type AgentRequestParamsByMethod,
  type AgentRequestResponsesByMethod,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type ClientConnection,
  type ClientRequestContext,
  type CloseSessionResponse,
  type ForkSessionResponse,
  type DeleteSessionResponse,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk';
import { redactSecrets } from '@canopy/execution-engine/lib/redaction';
import { acpSupportsAdditionalDirectories } from './capabilities';
import { AcpClientError } from './errors';
import { AcpUpdatePressure, createAcpStream } from './stream';
import type {
  AcpClient,
  AcpClientOptions,
  AcpForkSessionRequest,
  AcpResumeSessionRequest,
} from './types';

interface ActiveTurn {
  controller: AbortController;
  done: Promise<void>;
  cancel?: Promise<void>;
}

/** Numeric JSON-RPC codes carry no provider content and keep failures triageable. */
function rpcCodeOf(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'number'
    ? error.code
    : undefined;
}

const PROVIDER_MESSAGE_MAX_CHARS = 500;

/** Bounds the agent-controlled text before the redaction passes run over it. */
const PROVIDER_MESSAGE_SCAN_CHARS = 4_000;

/**
 * The SDK's bare JSON-RPC wrappers carry no information. A bare "Invalid
 * request" is also how the SDK itself rejects a malformed response.
 */
const JSON_RPC_BOILERPLATE =
  /^(?:Internal error|Invalid request|Parse error)(?::\s*|$)/;

/** Node, Python and Go stack traces start on a line of their own. */
const STACK_TRACE_START =
  /\n\s*(?:at\s|Traceback \(most recent call last\)|goroutine \d+ \[)/;

/**
 * The agent's own explanation of a failed request, such as "Insufficient
 * account funds", bounded for display in a chat. Agents built on the ACP SDK
 * report an uncaught error as "Internal error: <text>" or as "Internal error"
 * with the text in `data.details`. Only JSON-RPC errors qualify, so transport
 * faults never read as the agent's explanation. Stack traces are dropped,
 * secrets are redacted, and the text is capped, because the agent controls it.
 */
function providerMessageOf(error: unknown): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    rpcCodeOf(error) === undefined
  )
    return undefined;
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message.trim().replace(JSON_RPC_BOILERPLATE, '').trim()
      : '';
  const details =
    'data' in error &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'details' in error.data &&
    typeof error.data.details === 'string'
      ? error.data.details
      : '';
  const text = redactSecrets(
    (message || details)
      .slice(0, PROVIDER_MESSAGE_SCAN_CHARS)
      .split(STACK_TRACE_START, 1)[0]
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (!text) return undefined;
  // Count code points so the cut never splits a surrogate pair.
  const characters = Array.from(text);
  return characters.length > PROVIDER_MESSAGE_MAX_CHARS
    ? `${characters
        .slice(0, PROVIDER_MESSAGE_MAX_CHARS - 1)
        .join('')
        .trimEnd()}…`
    : text;
}

/** Core methods go through the typed calls that track sessions and turns. */
const RESERVED_METHODS: ReadonlySet<string> = new Set([
  ...Object.values(AGENT_METHODS),
  ...Object.values(PROTOCOL_METHODS),
]);

/**
 * Deadlines must fit a Node timer. A null prompt deadline is validated
 * separately below and disables the prompt bound in prompt() and bounded().
 */
/** The host's update handler failed; its error stays local (CAN-7117). */
function updateHandlerFailure(error: unknown): AcpClientError {
  return new AcpClientError('handler-failed', 'ACP update handler failed', {
    runtimeCause: error,
  });
}

function invalidDeadline(ms: number): boolean {
  return !Number.isSafeInteger(ms) || ms < 1 || ms > 2_147_483_647;
}

class AcpClientConnection implements AcpClient {
  private readonly connection: ClientConnection;
  private initialization?: InitializeResponse;
  private failure?: AcpClientError;
  private invalidated = false;
  private readonly sessions = new Set<string>();
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly transitioning = new Set<string>();
  private creating?: { updates: SessionNotification[]; bytes: number };
  private readonly maxBytes: number;
  private readonly maxPendingUpdates: number;
  private readonly updatePressure = new AcpUpdatePressure();
  private readonly updateAdmissions = new Set<{
    owner: AcpClientConnection | null;
    sessionId: string;
    release: () => void;
    done: Promise<void>;
    finish: () => void;
  }>();
  private readonly timeout;

  constructor(private readonly options: AcpClientOptions) {
    this.timeout = {
      initializeMs: 5000,
      requestMs: 30_000,
      promptMs: 600_000,
      permissionMs: 300_000,
      cancelMs: 2000,
      turnCancelMs: 30_000,
      ...options.timeouts,
    };
    const maxBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
    this.maxBytes = maxBytes;
    const maxPendingUpdates = options.maxPendingUpdates ?? 64;
    this.maxPendingUpdates = maxPendingUpdates;
    const { promptMs, ...boundedTimeouts } = this.timeout;
    if (
      !Number.isSafeInteger(options.resourceGeneration) ||
      options.resourceGeneration < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isSafeInteger(maxPendingUpdates) ||
      maxPendingUpdates < 1 ||
      (promptMs !== null && invalidDeadline(promptMs)) ||
      Object.values(boundedTimeouts).some((ms) => invalidDeadline(ms))
    ) {
      throw new AcpClientError(
        'invalid-input',
        'Invalid ACP generation, message limit, or timeout',
      );
    }
    this.connection = client({ name: options.clientInfo.name })
      .onRequest('session/request_permission', (context) =>
        this.permission(context),
      )
      .onNotification('session/update', ({ params }): void => {
        const release = this.updatePressure.take();
        if (this.failure) {
          release();
          return;
        }
        if (this.sessions.has(params.sessionId)) {
          const admission = this.deliverUpdate(params);
          if (admission && typeof admission.then === 'function') {
            this.observeUpdateAdmission(admission, release, params.sessionId);
          } else {
            release();
          }
        } else if (this.creating) {
          this.creating.bytes += Buffer.byteLength(JSON.stringify(params));
          if (
            this.creating.updates.length >= this.maxPendingUpdates ||
            this.creating.bytes > this.maxBytes
          ) {
            this.fail(
              new AcpClientError(
                'protocol',
                'Too many ACP updates before session creation',
              ),
            );
          } else {
            this.creating.updates.push(params);
          }
          // The existing creation buffer has its own count and byte limits;
          // release wire credit so session/new's response can arrive.
          release();
        } else {
          release();
        }
      })
      .connect(
        createAcpStream(
          options.transport,
          maxBytes,
          (error) => this.fail(error),
          this.updatePressure,
        ),
      );
    this.connection.signal.addEventListener(
      'abort',
      () => {
        this.fail(new AcpClientError('closed', 'ACP connection closed'));
      },
      { once: true },
    );
  }

  get closed(): Promise<void> {
    return this.connection.closed;
  }

  async initialize(): Promise<void> {
    try {
      const result = await this.request(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: this.options.clientInfo,
          // File/terminal access and elicitation remain host-adapter work.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            ...(this.options.clientCapabilityMeta
              ? { _meta: structuredClone(this.options.clientCapabilityMeta) }
              : {}),
          },
        },
        undefined,
        this.timeout.initializeMs,
      );
      if (result.protocolVersion !== 1) {
        throw new AcpClientError(
          'unsupported',
          'Agent does not support ACP protocol version 1',
        );
      }
      this.initialization = structuredClone(result);
    } catch (error) {
      const failure =
        error instanceof AcpClientError
          ? error
          : new AcpClientError('protocol', 'ACP initialization failed');
      this.fail(failure);
      throw failure;
    }
  }

  getInitialization(): InitializeResponse {
    if (!this.initialization)
      throw new AcpClientError('closed', 'ACP has not initialized');
    return structuredClone(this.initialization);
  }

  supportsAdditionalDirectories(): boolean {
    return acpSupportsAdditionalDirectories(this.initialization);
  }

  async authenticate(
    params: AuthenticateRequest,
    signal?: AbortSignal,
  ): Promise<AuthenticateResponse> {
    this.ready();
    if (
      !this.initialization?.authMethods?.some(
        (method) => method.id === params.methodId,
      )
    ) {
      throw new AcpClientError(
        'unsupported',
        'Agent did not advertise this authentication method',
      );
    }
    return await this.request('authenticate', structuredClone(params), signal);
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.validateSessionParams(params);
    return this.createSession(() =>
      this.request('session/new', structuredClone(params)),
    );
  }

  async forkSession(
    params: AcpForkSessionRequest,
    signal?: AbortSignal,
  ): Promise<ForkSessionResponse> {
    this.requireCapability(
      this.initialization?.agentCapabilities?.sessionCapabilities?.fork != null,
      'fork',
    );
    this.validateSessionParams(params);
    this.requireSession(params.sessionId);
    this.requireStableSession(params.sessionId);
    if (this.turns.has(params.sessionId))
      throw new AcpClientError(
        'busy',
        'Stop the ACP turn before forking its session',
      );
    this.transitioning.add(params.sessionId);
    try {
      return await this.createSession(() =>
        this.request('session/fork', structuredClone(params), signal),
      );
    } finally {
      this.transitioning.delete(params.sessionId);
    }
  }

  private async createSession<T extends { sessionId: string }>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.creating)
      throw new AcpClientError(
        'busy',
        'ACP session creation is already pending',
      );
    const pending = { updates: new Array<SessionNotification>(), bytes: 0 };
    this.creating = pending;
    try {
      const result = await operation();
      if (this.sessions.has(result.sessionId)) {
        const failure = new AcpClientError(
          'protocol',
          'Agent reused an attached session ID',
        );
        this.fail(failure);
        throw failure;
      }
      this.sessions.add(result.sessionId);
      for (const update of pending.updates) {
        if (update.sessionId === result.sessionId) {
          const admission = this.deliverUpdate(update);
          if (admission && typeof admission.then === 'function') {
            this.observeUpdateAdmission(
              admission,
              () => undefined,
              update.sessionId,
            );
          }
        }
      }
      this.ready();
      return result;
    } finally {
      this.creating = undefined;
    }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.requireCapability(
      this.initialization?.agentCapabilities?.loadSession === true,
      'load',
    );
    return this.attach(params, () =>
      this.request('session/load', structuredClone(params)),
    );
  }

  async resumeSession(
    params: AcpResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    this.requireCapability(
      this.initialization?.agentCapabilities?.sessionCapabilities?.resume !=
        null,
      'resume',
    );
    return this.attach(params, () =>
      this.request('session/resume', structuredClone(params)),
    );
  }

  async listSessions(
    params: ListSessionsRequest = {},
    signal?: AbortSignal,
  ): Promise<ListSessionsResponse> {
    this.requireCapability(
      this.initialization?.agentCapabilities?.sessionCapabilities?.list != null,
      'list',
    );
    return await this.request('session/list', structuredClone(params), signal);
  }

  async closeSession(sessionId: string): Promise<CloseSessionResponse> {
    this.requireCapability(
      this.initialization?.agentCapabilities?.sessionCapabilities?.close !=
        null,
      'close',
    );
    this.requireSession(sessionId);
    this.requireStableSession(sessionId);
    this.transitioning.add(sessionId);
    try {
      await this.cancel(sessionId);
      const result = await this.request('session/close', { sessionId });
      this.sessions.delete(sessionId);
      return result;
    } finally {
      this.transitioning.delete(sessionId);
    }
  }

  async deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
    this.requireCapability(
      this.initialization?.agentCapabilities?.sessionCapabilities?.delete !=
        null,
      'delete',
    );
    this.requireSession(sessionId);
    this.requireStableSession(sessionId);
    this.transitioning.add(sessionId);
    try {
      await this.cancel(sessionId);
      const result = await this.request('session/delete', { sessionId });
      this.sessions.delete(sessionId);
      return result;
    } finally {
      this.transitioning.delete(sessionId);
    }
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
    signal?: AbortSignal,
  ): Promise<SetSessionConfigOptionResponse> {
    this.ready();
    if (this.invalidated)
      throw new AcpClientError(
        'stale-generation',
        'ACP resource profile is stale',
      );
    this.requireSession(params.sessionId);
    this.requireStableSession(params.sessionId);
    if (this.turns.has(params.sessionId))
      throw new AcpClientError(
        'busy',
        'Stop the ACP turn before changing configuration',
      );
    this.transitioning.add(params.sessionId);
    try {
      return await this.request(
        'session/set_config_option',
        structuredClone(params),
        signal,
      );
    } finally {
      this.transitioning.delete(params.sessionId);
    }
  }

  async prompt(
    params: PromptRequest,
    resourceGeneration: number,
    signal?: AbortSignal,
  ): Promise<PromptResponse> {
    this.ready();
    this.requireSession(params.sessionId);
    this.requireStableSession(params.sessionId);
    if (
      this.invalidated ||
      resourceGeneration !== this.options.resourceGeneration
    ) {
      throw new AcpClientError(
        'stale-generation',
        'ACP resource profile must be recreated before another turn',
      );
    }
    if (this.turns.has(params.sessionId))
      throw new AcpClientError(
        'busy',
        'ACP session already has an active turn',
      );
    if (signal?.aborted)
      throw new AcpClientError(
        'cancelled',
        'ACP prompt cancelled before sending',
      );
    const capabilities =
      this.initialization?.agentCapabilities?.promptCapabilities;
    for (const content of params.prompt) {
      if (
        (content.type === 'image' && !capabilities?.image) ||
        (content.type === 'audio' && !capabilities?.audio) ||
        (content.type === 'resource' && !capabilities?.embeddedContext)
      ) {
        throw new AcpClientError(
          'unsupported',
          'Agent did not advertise this prompt content type',
        );
      }
    }
    let settle = (): void => {};
    const turn: ActiveTurn = {
      controller: new AbortController(),
      done: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    this.turns.set(params.sessionId, turn);
    const abort = (): void => {
      void this.cancel(params.sessionId).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    // A prompt past its deadline is cancelled through the same session/cancel
    // ladder a user stop uses. The connection closes only if the turn ignores
    // that cancellation for turnCancelMs, so sibling sessions stay usable. A
    // null deadline leaves the turn open until the agent finishes, the host
    // cancels, or the connection drops; cancel() keeps its own wind-down grace.
    const { promptMs, turnCancelMs, cancelMs } = this.timeout;
    let expired = false;
    const deadline =
      promptMs === null
        ? undefined
        : setTimeout(() => {
            expired = true;
            void this.cancel(params.sessionId).catch(() => {});
          }, promptMs);
    try {
      const response = await this.request(
        'session/prompt',
        structuredClone(params),
        undefined,
        promptMs === null
          ? null
          : Math.min(promptMs + turnCancelMs + cancelMs, 2_147_483_647),
      );
      // A turn that still completes normally after the deadline is returned;
      // only a turn the agent reports as cancelled becomes a timeout.
      if (expired && response.stopReason === 'cancelled') {
        throw new AcpClientError(
          'timeout',
          'ACP prompt did not settle within its deadline',
        );
      }
      await this.waitForSessionUpdateAdmissions(params.sessionId, turn);
      return response;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      turn.controller.abort();
      this.turns.delete(params.sessionId);
      settle();
    }
  }

  async cancel(sessionId: string): Promise<void> {
    if (this.failure) return Promise.resolve();
    this.requireSession(sessionId);
    const turn = this.turns.get(sessionId);
    if (!turn) return Promise.resolve();
    if (!turn.cancel) {
      turn.controller.abort();
      turn.cancel = this.bounded(
        (async (): Promise<void> => {
          await this.connection.agent.notify('session/cancel', { sessionId });
          await turn.done;
        })(),
        this.timeout.turnCancelMs,
      );
    }
    return turn.cancel;
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs: number = this.timeout.requestMs,
  ): Promise<unknown> {
    this.ready();
    if (RESERVED_METHODS.has(method) || invalidDeadline(timeoutMs))
      throw new AcpClientError(
        'invalid-input',
        'Invalid ACP extension method or deadline',
      );
    if (this.invalidated)
      throw new AcpClientError(
        'stale-generation',
        'ACP resource profile is stale',
      );
    if (signal?.aborted)
      throw new AcpClientError(
        'cancelled',
        'ACP request cancelled before sending',
      );
    return await this.bounded(
      this.connection.agent.request<unknown>(method, structuredClone(params), {
        cancellationSignal: signal,
      }),
      timeoutMs,
      signal,
      method,
    );
  }

  invalidate(): void {
    this.invalidated = true;
  }

  close(): void {
    this.fail(new AcpClientError('closed', 'ACP client disposed'));
  }

  private ready(): void {
    if (this.failure) throw this.failure;
    if (!this.initialization)
      throw new AcpClientError('closed', 'ACP has not initialized');
  }

  private requireCapability(supported: boolean, operation: string): void {
    this.ready();
    if (!supported)
      throw new AcpClientError(
        'unsupported',
        `Agent did not advertise session ${operation}`,
      );
  }

  private requireSession(sessionId: string): void {
    if (!this.sessions.has(sessionId))
      throw new AcpClientError(
        'invalid-session',
        'ACP session is not attached to this connection',
      );
  }

  private requireStableSession(sessionId: string): void {
    if (this.transitioning.has(sessionId))
      throw new AcpClientError(
        'busy',
        'ACP session is being attached or closed',
      );
  }

  private deliverUpdate(update: SessionNotification): void | Promise<void> {
    if (this.failure) return;
    try {
      return this.options.onUpdate(update, this.options.resourceGeneration);
    } catch (error) {
      this.fail(updateHandlerFailure(error));
    }
  }

  private observeUpdateAdmission(
    admission: Promise<void>,
    release: () => void,
    sessionId: string,
  ): void {
    let finish = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const token: {
      owner: AcpClientConnection | null;
      sessionId: string;
      release: () => void;
      done: Promise<void>;
      finish: () => void;
    } = { owner: this, sessionId, release, done, finish };
    this.updateAdmissions.add(token);
    void admission.then(
      () => token.owner?.settleUpdateAdmission(token, false),
      (error: unknown) =>
        token.owner?.settleUpdateAdmission(token, true, error),
    );
  }

  private settleUpdateAdmission(
    token: {
      owner: AcpClientConnection | null;
      sessionId: string;
      release: () => void;
      done: Promise<void>;
      finish: () => void;
    },
    failed: boolean,
    error?: unknown,
  ): void {
    if (!this.updateAdmissions.delete(token)) return;
    token.owner = null;
    token.release();
    token.finish();
    if (failed) {
      this.fail(updateHandlerFailure(error));
    }
  }

  private async waitForSessionUpdateAdmissions(
    sessionId: string,
    turn: ActiveTurn,
  ): Promise<void> {
    const pending = Array.from(this.updateAdmissions)
      .filter((token) => token.sessionId === sessionId)
      .map((token) => token.done);
    if (pending.length === 0) return;
    if (turn.controller.signal.aborted)
      throw new AcpClientError('cancelled', 'ACP prompt cancelled');
    let abort = (): void => undefined;
    const cancelled = new Promise<void>((_resolve, reject): void => {
      // fail() records its failure before aborting the turn, so a connection
      // failure (handler-failed, closed, ...) is reported as itself. Read it
      // when the abort fires: a user cancel aborts first, and a close() that
      // follows it must not replace the cancellation.
      abort = (): void =>
        reject(
          this.failure ??
            new AcpClientError('cancelled', 'ACP prompt cancelled'),
        );
      turn.controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      await Promise.race([Promise.all(pending), cancelled]);
      if (this.failure) throw this.failure;
    } finally {
      turn.controller.signal.removeEventListener('abort', abort);
    }
  }

  private validateSessionParams(params: NewSessionRequest): void {
    this.ready();
    if (this.invalidated)
      throw new AcpClientError(
        'stale-generation',
        'ACP resource profile is stale',
      );
    if (
      !path.isAbsolute(params.cwd) ||
      params.additionalDirectories?.some(
        (directory) => !path.isAbsolute(directory),
      )
    ) {
      throw new AcpClientError(
        'invalid-input',
        'ACP workspace paths must be absolute',
      );
    }
    const capabilities = this.initialization?.agentCapabilities;
    if (
      params.additionalDirectories?.length &&
      !acpSupportsAdditionalDirectories(this.initialization)
    ) {
      throw new AcpClientError(
        'unsupported',
        'Agent did not advertise additional workspace roots',
      );
    }
    for (const server of params.mcpServers) {
      if (
        'type' in server &&
        ((server.type === 'http' && !capabilities?.mcpCapabilities?.http) ||
          (server.type === 'sse' && !capabilities?.mcpCapabilities?.sse) ||
          server.type === 'acp')
      ) {
        throw new AcpClientError(
          'unsupported',
          'Unsupported ACP MCP transport',
        );
      }
    }
  }

  private async attach<T>(
    params: LoadSessionRequest,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.validateSessionParams(params);
    if (this.sessions.has(params.sessionId))
      throw new AcpClientError('busy', 'ACP session is already attached');
    // Load can replay updates before its response, so establish ownership first.
    this.sessions.add(params.sessionId);
    this.transitioning.add(params.sessionId);
    try {
      return await operation();
    } catch (error) {
      this.sessions.delete(params.sessionId);
      throw error;
    } finally {
      this.transitioning.delete(params.sessionId);
    }
  }

  private async permission(
    context: ClientRequestContext<RequestPermissionRequest>,
  ): Promise<RequestPermissionResponse> {
    const turn = this.turns.get(context.params.sessionId);
    const handler = this.options.onPermission;
    if (
      !turn ||
      !handler ||
      this.failure ||
      turn.controller.signal.aborted ||
      context.signal.aborted
    ) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      context.signal,
      turn.controller.signal,
      this.connection.signal,
    ]);
    const decision = await new Promise<'allow' | 'deny' | 'cancelled'>(
      (resolve) => {
        let settled = false;
        const timer = setTimeout(
          () => controller.abort(),
          this.timeout.permissionMs,
        );
        // Function declarations are hoisted, so neither callback depends on
        // the other's initialization order.
        function cancel(): void {
          finish('cancelled');
        }
        function finish(value: 'allow' | 'deny' | 'cancelled'): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          resolve(signal.aborted ? 'cancelled' : value);
          controller.abort();
        }
        signal.addEventListener('abort', cancel, { once: true });
        void Promise.resolve()
          .then(() =>
            handler({
              requestId: context.requestId,
              resourceGeneration: this.options.resourceGeneration,
              request: context.params,
              signal,
            }),
          )
          .then(finish, () => finish('cancelled'));
      },
    );
    if (
      decision === 'cancelled' ||
      this.failure ||
      context.signal.aborted ||
      turn.controller.signal.aborted
    )
      return { outcome: { outcome: 'cancelled' } };
    const kind = decision === 'allow' ? 'allow_once' : 'reject_once';
    const option = context.params.options.find((entry) => entry.kind === kind);
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  private request<Method extends AgentRequestMethod>(
    method: Method,
    params: AgentRequestParamsByMethod[Method],
    signal?: AbortSignal,
    timeoutMs: number | null = this.timeout.requestMs,
  ): Promise<AgentRequestResponsesByMethod[Method]> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted)
      return Promise.reject(
        new AcpClientError('cancelled', 'ACP request cancelled before sending'),
      );
    return this.bounded(
      this.connection.agent.request(method, params, {
        cancellationSignal: signal,
      }),
      timeoutMs,
      signal,
      method,
    );
  }

  private bounded<T>(
    operation: Promise<T>,
    timeoutMs: number | null,
    signal?: AbortSignal,
    method?: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const expire = (): void => {
        const error = new AcpClientError(
          signal?.aborted ? 'cancelled' : 'timeout',
          'ACP operation did not settle within its deadline',
        );
        reject(error);
        this.fail(error);
      };
      let timer: ReturnType<typeof setTimeout> | undefined =
        timeoutMs === null ? undefined : setTimeout(expire, timeoutMs);
      const cancel = (): void => {
        clearTimeout(timer);
        timer = setTimeout(expire, this.timeout.cancelMs);
      };
      const disconnect = (): void => {
        cleanup();
        reject(
          this.failure ?? new AcpClientError('closed', 'ACP connection closed'),
        );
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.connection.signal.removeEventListener('abort', disconnect);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.connection.signal.addEventListener('abort', disconnect, {
        once: true,
      });
      void operation.then(
        (result) => {
          cleanup();
          if (signal?.aborted)
            reject(new AcpClientError('cancelled', 'ACP request cancelled'));
          else resolve(result);
        },
        (error: unknown) => {
          cleanup();
          reject(
            this.failure ??
              (signal?.aborted
                ? new AcpClientError('cancelled', 'ACP request cancelled')
                : error instanceof AcpClientError
                  ? error
                  : new AcpClientError(
                      'provider',
                      // The reason is agent-authored, so only Copy details
                      // may expose it. Keep the headline in our own copy.
                      "Couldn't finish this reply.",
                      {
                        method,
                        rpcCode: rpcCodeOf(error),
                        providerDetails: providerMessageOf(error),
                      },
                    )),
          );
        },
      );
      if (signal?.aborted) cancel();
      if (this.connection.signal.aborted) disconnect();
    });
  }

  private fail(error: AcpClientError): void {
    if (this.failure) return;
    this.failure = error;
    for (const token of Array.from(this.updateAdmissions)) {
      token.owner = null;
      token.release();
      token.finish();
    }
    this.updateAdmissions.clear();
    this.updatePressure.close();
    this.turns.forEach((turn) => turn.controller.abort());
    this.connection.close(error);
    try {
      this.options.transport.close();
    } catch {
      /* Host cleanup must not expose provider data. */
    }
  }
}

export async function connectAcp(
  options: AcpClientOptions,
): Promise<AcpClient> {
  let connection: AcpClientConnection;
  try {
    connection = new AcpClientConnection({
      clientInfo: structuredClone(options.clientInfo),
      ...(options.clientCapabilityMeta
        ? {
            clientCapabilityMeta: structuredClone(options.clientCapabilityMeta),
          }
        : {}),
      resourceGeneration: options.resourceGeneration,
      maxMessageBytes: options.maxMessageBytes,
      maxPendingUpdates: options.maxPendingUpdates,
      onUpdate: options.onUpdate.bind(options),
      onPermission: options.onPermission?.bind(options),
      timeouts: { ...options.timeouts },
      transport: {
        input: options.transport.input,
        output: options.transport.output,
        close: options.transport.close.bind(options.transport),
      },
    });
  } catch (error) {
    try {
      options.transport.close();
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  }
  await connection.initialize();
  return connection;
}
