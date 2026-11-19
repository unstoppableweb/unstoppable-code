import { createSetupWithdrawal, SETUP_WITHDRAWN } from './setup-withdrawal';
import {
  readCopilotToolSnapshot,
  type CopilotMcpServerReadiness,
  type CopilotToolMetadataRpc,
} from './tool-snapshot';
import type { CopilotCapabilitySnapshot } from './capability-snapshot';
import type {
  CopilotSession,
  GitHubTokenProvider,
  SessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';
import type { OwnedCopilotRuntime } from './runtime';
import {
  createCopilotSessionConfig,
  type CopilotSessionPolicy,
} from './session-policy';
import { CopilotEventProjection } from './events';
import { CopilotToolAuthorization } from './tool-authorization';
import { handleCopilotTurnCleanupError } from './turn-cleanup';
import { CopilotRecipientFailure, copilotSdkErrorType } from './failure';

type TurnSession = Pick<CopilotSession, 'sessionId' | 'send' | 'abort'> & {
  rpc?: CopilotToolMetadataRpc;
};
/** Minimal SDK boundary consumed by a turn; the full owned runtime satisfies it. */
interface TurnRuntime extends Pick<OwnedCopilotRuntime, 'exited' | 'close'> {
  tokenProviderForSession?(sessionId?: string): GitHubTokenProvider;
  /** Sees the turn's failure before the runtime is closed for it. */
  failed?(error: Error): void;
  client: {
    createSession(
      ...args: Parameters<OwnedCopilotRuntime['client']['createSession']>
    ): Promise<TurnSession>;
    resumeSession(
      ...args: Parameters<OwnedCopilotRuntime['client']['resumeSession']>
    ): Promise<TurnSession>;
  };
}

export interface CopilotTurnOptions extends CopilotSessionPolicy {
  runtime: TurnRuntime;
  /** Local P5 host retains successful results admission until its final delivery. */
  deferSuccessfulClose?: boolean;
  turnId: string;
  sessionId?: string;
  prompt: string;
  /** Host-owned history handoff after create/resume chooses the actual conversation. */
  preparePrompt?(sessionId: string): Promise<string>;
  /** The SDK accepted the prompt, even if the later model turn fails. */
  onPromptAccepted?(sessionId: string): void | Promise<void>;
  timeoutMs?: number;
  secretValues?: readonly string[];
  emit(event: Record<string, unknown>): void | Promise<void>;
  onSession(sessionId: string): void | Promise<void>;
  /**
   * Verify native capabilities before publishing session identity or
   * sending. `servers` lists every selected MCP server with its status, so
   * the host can report the ones that sat out of the snapshot.
   */
  onToolsReady?(
    snapshot: CopilotCapabilitySnapshot,
    servers: readonly CopilotMcpServerReadiness[],
  ): void | Promise<void>;
  onMcpToolsReady?: Parameters<typeof readCopilotToolSnapshot>[3];
  /** Interactive-only recovery, before sending anything to a missing conversation. */
  onSessionUnavailable?(): void | Promise<void>;
  beforePrompt?(): Promise<void>;
}

/** A consumer's turn; the recipient supplies the runtime and session identity. */
export type CopilotTurnRequest = Omit<
  CopilotTurnOptions,
  'runtime' | 'gitHubTokenProvider' | 'deferSuccessfulClose'
>;

export interface CopilotTurnResult {
  /** The SDK conversation id: an opaque handle for a later resume. */
  sessionId: string;
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

/** One owned runtime per turn, one SDK conversation retained across turns. */
export async function runCopilotTurn(
  options: CopilotTurnOptions,
): Promise<CopilotTurnResult> {
  const projection = new CopilotEventProjection(
    options.turnId,
    options.workingDirectory,
    options.secretValues,
  );
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const authorization = new CopilotToolAuthorization(options.workingDirectory);
  let rejectFailure: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  // An observer may fail during setup, before the turn race is installed.
  void failed.catch(() => undefined);
  let idle!: () => void;
  const completed = new Promise<void>((resolve) => {
    idle = resolve;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let receiving = false;
  let failure: Error | undefined;
  let turnFailed = false;
  const admissions = new Set<Promise<void>>();
  let deliveryTail = Promise.resolve();
  const usageIds = new Set<string>();
  const fail = (error: unknown): void => {
    failure ??=
      error instanceof Error || error instanceof DOMException
        ? error
        : new Error('Copilot event delivery failed.');
    options.runtime.failed?.(failure);
    rejectFailure(failure);
    void options.runtime.close().catch(() => undefined);
  };
  const deliver = (event: Record<string, unknown>): Promise<void> => {
    if (admissions.size >= 1024)
      throw new CopilotRecipientFailure(
        'Copilot output could not be saved fast enough.',
        'limit',
      );
    const delivered = deliveryTail.then(() => options.emit(event));
    admissions.add(delivered);
    deliveryTail = delivered
      .catch(fail)
      .finally(() => admissions.delete(delivered));
    return delivered;
  };
  const onEvent: NonNullable<SessionConfig['onEvent']> = (
    event: SessionEvent,
  ): void => {
    // Resume can replay historical events before returning. Only this send's
    // live events belong in the current canonical turn transcript.
    if (!receiving || failure || options.signal.aborted) return;
    try {
      authorization.observe(event);
      options.onEvent?.(event);
      if (
        event.type === 'session.idle' &&
        !event.agentId &&
        event.data.mode !== 'autopilot'
      ) {
        if (event.data.aborted) {
          fail(new DOMException('Copilot turn cancelled.', 'AbortError'));
          return;
        }
        idle();
      }
      if (event.type === 'session.error' && !event.agentId) {
        fail(
          new CopilotRecipientFailure(
            event.data.message,
            'provider_error',
            copilotSdkErrorType(event.data.errorType),
          ),
        );
        return;
      }
      if (
        event.type === 'assistant.usage' &&
        !event.agentId &&
        !usageIds.has(event.id)
      ) {
        usageIds.add(event.id);
        const bounded = (value: number | undefined): number =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0
            ? value
            : 0;
        // The pinned CLI normalizes all providers to inclusive input tokens.
        // Canonical transcripts use disjoint uncached/read/write buckets.
        const read = bounded(event.data.cacheReadTokens);
        const written = bounded(event.data.cacheWriteTokens);
        usage.input_tokens += Math.max(
          0,
          bounded(event.data.inputTokens) - read - written,
        );
        usage.output_tokens += bounded(event.data.outputTokens);
        usage.cache_read_input_tokens += read;
        usage.cache_creation_input_tokens += written;
      }
      const projected = projection.accept(event);
      if (!projected) return;
      // The SDK's observer cannot backpressure the socket. Bound undelivered
      // admissions as well as cumulative response bytes; close on overload.
      void deliver(projected);
    } catch (error) {
      fail(error);
    }
  };
  try {
    options.signal.throwIfAborted();
    let config = createCopilotSessionConfig({
      ...options,
      gitHubTokenProvider:
        options.runtime.tokenProviderForSession?.(options.sessionId) ??
        options.gitHubTokenProvider,
      onEvent,
      authorize: (input) =>
        authorization.authorize(input, options.signal, (request) =>
          options.authorize(request),
        ),
    });
    let session: TurnSession;
    if (options.sessionId) {
      try {
        session = await options.runtime.client.resumeSession(
          options.sessionId,
          config,
        );
      } catch (error) {
        options.signal.throwIfAborted();
        if (
          !options.onSessionUnavailable ||
          !(error instanceof Error) ||
          ![
            'Missing conversation',
            'Session not found',
            `Session not found: ${options.sessionId}`,
            // Native CLI 1.0.89 wraps a missing session in this JSON-RPC error.
            `Request session.resume failed with message: Failed to load session events: Session not found: ${options.sessionId}`,
          ].includes(error.message)
        )
          throw error;
        await options.onSessionUnavailable();
        options.signal.throwIfAborted();
        config = {
          ...config,
          gitHubTokenProvider:
            options.runtime.tokenProviderForSession?.() ??
            options.gitHubTokenProvider,
        };
        session = await options.runtime.client.createSession(config);
      }
    } else session = await options.runtime.client.createSession(config);
    options.signal.throwIfAborted();
    if (options.onToolsReady || options.onMcpToolsReady) {
      const rpc = session.rpc;
      if (!rpc) throw new Error('Copilot cannot verify native tool metadata.');
      const verification = new AbortController();
      const readiness = createSetupWithdrawal(
        AbortSignal.any([options.signal, verification.signal]),
        Math.min(options.timeoutMs ?? 30_000, 30_000),
      );
      try {
        const verified = await Promise.race([
          readiness.race(
            (async (): Promise<void> => {
              const ready = await readCopilotToolSnapshot(
                rpc,
                Object.keys(options.mcpServers ?? {}),
                readiness.signal,
                options.onMcpToolsReady,
              );
              readiness.signal.throwIfAborted();
              await options.onToolsReady?.(ready.snapshot, ready.servers);
              readiness.signal.throwIfAborted();
            })(),
          ),
          options.runtime.exited.then(() => {
            throw new Error(
              'Copilot runtime stopped during tool metadata verification.',
            );
          }),
        ]);
        if (verified === SETUP_WITHDRAWN) {
          options.signal.throwIfAborted();
          throw new Error('Copilot tool metadata verification timed out.');
        }
      } finally {
        verification.abort();
        readiness.release();
      }
    }
    await options.onSession(session.sessionId);
    const promptSessionId = session.sessionId;
    let prompt = options.prompt;
    if (options.preparePrompt) {
      const preparation = createSetupWithdrawal(
        options.signal,
        Math.min(options.timeoutMs ?? 30_000, 30_000),
      );
      try {
        const prepared = await Promise.race([
          preparation.race(options.preparePrompt(session.sessionId)),
          options.runtime.exited.then(() => {
            throw new Error(
              'Copilot runtime stopped during prompt preparation.',
            );
          }),
        ]);
        if (prepared === SETUP_WITHDRAWN) {
          options.signal.throwIfAborted();
          throw new Error('Copilot prompt preparation timed out.');
        }
        prompt = prepared;
      } finally {
        preparation.release();
      }
    }
    await options.beforePrompt?.();
    options.signal.throwIfAborted();
    receiving = true;
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        void Promise.resolve()
          .then(() => session.abort())
          .catch(() => undefined);
        reject(
          options.signal.reason instanceof Error
            ? options.signal.reason
            : new DOMException('Copilot turn cancelled.', 'AbortError'),
        );
      };
      options.signal.addEventListener('abort', abort, { once: true });
      removeAbortListener = (): void =>
        options.signal.removeEventListener('abort', abort);
      if (options.signal.aborted) abort();
    });
    await Promise.race([
      failed,
      cancelled,
      session.send({ prompt }).then(async () => {
        if (options.onPromptAccepted) {
          const acceptance = createSetupWithdrawal(
            options.signal,
            Math.min(options.timeoutMs ?? 30_000, 30_000),
          );
          try {
            const accepted = await acceptance.race(
              Promise.resolve(options.onPromptAccepted(promptSessionId)),
            );
            if (accepted === SETUP_WITHDRAWN) {
              options.signal.throwIfAborted();
              throw new Error('Copilot prompt acknowledgement timed out.');
            }
          } finally {
            acceptance.release();
          }
        }
        return completed;
      }),
      new Promise<never>((_resolve, reject) => {
        if (options.timeoutMs === undefined) return;
        timeout = setTimeout(
          () => reject(new Error('Copilot turn timed out.')),
          options.timeoutMs,
        );
      }),
      options.runtime.exited.then(() => {
        options.signal.throwIfAborted();
        throw new Error('Copilot runtime stopped before the turn finished.');
      }),
    ]);
    for (const event of projection.drain()) await deliver(event);
    await Promise.all(Array.from(admissions));
    if (failure) throw failure;
    options.signal.throwIfAborted();
    return { sessionId: session.sessionId, text: projection.text, usage };
  } catch (error) {
    turnFailed = true;
    if (!failure && error instanceof Error) options.runtime.failed?.(error);
    options.signal.throwIfAborted();
    throw failure ?? error;
  } finally {
    receiving = false;
    removeAbortListener?.();
    if (timeout) clearTimeout(timeout);
    let cleanupError: unknown;
    try {
      if (turnFailed || !options.deferSuccessfulClose)
        await options.runtime.close();
    } catch (error) {
      cleanupError = error;
    }
    try {
      for (const event of projection.drain()) await deliver(event);
    } catch (error) {
      cleanupError ??= error;
    } finally {
      await Promise.allSettled(Array.from(admissions));
    }
    if (cleanupError) handleCopilotTurnCleanupError(cleanupError, turnFailed);
  }
}
