// ---------------------------------------------------------------------------
// Portal command SSE transport driver (TS-02 / CAN-762).
//
// Consumes the server→desktop command SSE stream and drives reconnect +
// graceful fallback to HTTP long-poll. Each `poll` frame carries a full
// `PollPortalCommandsResponse` (the same shape the long-poll POST returns), so
// the manager processes both transports through one `applyPollResponse` path.
//
// The driver is transport-only and fully injected (no direct module state), so
// its reconnect/fallback logic and the SSE frame parser are unit-testable in
// isolation without Electron or a live server.
// ---------------------------------------------------------------------------

// At most one bounded chunk of complete frames waits behind a handler.
const SSE_READ_AHEAD_MAX_FRAMES = 64;
const SSE_READ_AHEAD_MAX_BYTES = 8 * 1024 * 1024;

/** A parsed SSE frame (`id:` / `event:` / joined `data:` lines). */
export interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

/**
 * Parse complete SSE frames from an accumulating buffer. Returns the parsed
 * frames plus the unterminated remainder to prepend to the next chunk. Comment
 * lines (`: keepalive`) and blank lines are ignored per the SSE spec, including
 * the single optional leading space after each field colon.
 */
function parseSseFrames(buffer: string): {
  frames: SseFrame[];
  remainder: string;
} | null {
  const frames: SseFrame[] = [];
  // Normalize CRLF → LF so `\r\n\r\n` frame separators are handled uniformly.
  // Our payloads are JSON (raw CR/LF are escaped), so this never corrupts data.
  let rest = buffer.replace(/\r\n/g, '\n');

  for (;;) {
    const separator = rest.indexOf('\n\n');
    if (separator === -1) {
      break;
    }
    const block = rest.slice(0, separator);
    rest = rest.slice(separator + 2);

    let id: string | null = null;
    let event: string | null = null;
    const dataLines: string[] = [];

    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0 || line.startsWith(':')) {
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
      if (field === 'id') {
        id = value;
      } else if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        dataLines.push(value);
      }
    }

    if (dataLines.length > 0 || event !== null || id !== null) {
      if (frames.length === SSE_READ_AHEAD_MAX_FRAMES) return null;
      frames.push({ id, event, data: dataLines.join('\n') });
    }
  }

  return { frames, remainder: rest };
}

/** Outcome of a single poll frame applied by the manager. */
export type PollFrameOutcome = 'ok' | 'stopped';

/**
 * Terminal outcome of the SSE transport:
 * - `stopped`: the portal was torn down (session inactive / aborted) — the
 *   caller must NOT fall back, it should exit.
 * - `fallback`: SSE is unavailable (endpoint 404, or repeated immediate
 *   failures) — the caller should use HTTP long-poll instead.
 */
export type CommandTransportOutcome = 'stopped' | 'fallback';

export interface PortalCommandSseDeps {
  /** True once the portal is stopping; the driver exits promptly. */
  isAborted: () => boolean;
  /** Current session id, or null once the session is gone. */
  getSessionId: () => string | null;
  /** The desktop's own persisted command cursor (resume position). */
  getCursor: () => number;
  /** Open the SSE stream for the given cursor. */
  openStream: (input: {
    sessionId: string;
    afterSeq: number;
    signal: AbortSignal;
  }) => Promise<Response>;
  /** Apply one `poll` frame's `PollPortalCommandsResponse` JSON. */
  onPollFrame: (data: string) => Promise<PollFrameOutcome>;
  /**
   * Classify an `error` frame's payload: `terminal` (e.g. auth/not-found —
   * fall back to long-poll immediately, which owns the stop decision) vs
   * `transient` (reconnect).
   */
  classifyErrorFrame: (data: string) => 'terminal' | 'transient';
  /** Flush the outbound event outbox before (re)connecting. */
  flushOutbox: () => Promise<void>;
  onNetworkFailure: (error: unknown) => void;
  isInactiveSessionError: (error: unknown) => boolean;
  /**
   * Route a `409 Portal session is inactive.` response (CAN-2651).
   *
   * This transport flushes the outbox at the top of every reconnect, so after
   * a sleep or a Wi-Fi drop the flush is the first request to land — the same
   * race the long-poll loop has. The server's every-minute sweep flags a
   * session whose heartbeat lapsed past 90s as stale but deliberately
   * revivable, so a 409 here is far more often that recoverable flag than a
   * real teardown. The manager probes with a single heartbeat and answers
   * `'revived'` (retry on the existing backoff, session intact) or
   * `'terminal'` (tear down, as before).
   */
  onInactiveSessionResponse: () => Promise<'revived' | 'terminal'>;
  is404: (error: unknown) => boolean;
  delay: (ms: number) => Promise<void>;
  /** Monotonic clock (ms) used to measure connection duration. */
  now: () => number;
  /**
   * Bounds the openStream connection/header phase; the idle watchdog only
   * covers the reading phase after the stream opens.
   */
  connectTimeoutMs: number;
  /**
   * Arm a one-shot timer that fires `onFire` after `ms`; returns a cancel fn.
   * Used for the idle-read watchdog so a silently half-open socket forces a
   * reconnect instead of freezing on a never-resolving `read()`.
   */
  armTimeout: (ms: number, onFire: () => void) => () => void;
  /** Publish the active AbortController so a portal stop can cancel the fetch. */
  setAbortController: (controller: AbortController | null) => void;
  backoffMs: readonly number[];
  /** Consecutive immediate failures before giving up and falling back. */
  maxImmediateFailures: number;
  /**
   * A connection must last at least this long (ms) with a delivered frame to
   * count as "healthy" and earn an immediate reconnect. Shorter delivered
   * connections back off, preventing a reconnect storm against a server/proxy
   * that flushes one frame then closes every cycle.
   */
  minHealthyConnectionMs: number;
  /**
   * Force a reconnect if no bytes arrive within this window. The server emits a
   * frame at least every ~25s, so this should be a small multiple of that.
   */
  idleTimeoutMs: number;
}

function backoffDelay(
  deps: PortalCommandSseDeps,
  failureStreak: number,
): number {
  const index = Math.min(
    Math.max(failureStreak - 1, 0),
    deps.backoffMs.length - 1,
  );
  return deps.backoffMs[index];
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Reader already closed; nothing to do.
  }
}

async function consumeStream(
  response: Response,
  deps: PortalCommandSseDeps,
  controller: AbortController,
  markDelivered: () => void,
): Promise<'stopped' | 'ended' | 'fallback'> {
  const body = response.body;
  if (!body) {
    return 'ended';
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Idle-read watchdog: if no FRAME arrives within idleTimeoutMs, abort the
  // fetch so the pending `read()` settles and the driver reconnects, instead of
  // freezing forever on a silently half-open socket. Re-armed only on parsed
  // frames, not raw bytes: the server emits `: keepalive` comments every 10s
  // (CAN-2358), and letting those re-arm the watchdog would leave a wedged
  // poll loop (bytes flowing, no `poll` frames) undetected until the 5-minute
  // poll-progress failsafe instead of ~60s.
  let cancelWatchdog: () => void = () => undefined;
  const armWatchdog = (): void => {
    cancelWatchdog = deps.armTimeout(deps.idleTimeoutMs, () => {
      controller.abort();
    });
  };
  const resetWatchdog = (): void => {
    cancelWatchdog();
    armWatchdog();
  };

  armWatchdog();
  try {
    while (!deps.isAborted()) {
      const { value, done } = await reader.read();
      // Bound the partial frame as well as a read containing multiple frames.
      // HTTP polling resumes from the last applied cursor if either cap is hit.
      if (
        value &&
        value.byteLength + Buffer.byteLength(buffer) > SSE_READ_AHEAD_MAX_BYTES
      )
        return 'fallback';
      buffer += decoder.decode(value, { stream: !done });
      const parsed = parseSseFrames(buffer);
      if (!parsed) return 'fallback';
      buffer = parsed.remainder;
      if (parsed.frames.length > 0) resetWatchdog();
      for (const frame of parsed.frames) {
        if (deps.isAborted()) return 'stopped';
        if (frame.event === 'poll') {
          const outcome = await deps.onPollFrame(frame.data);
          markDelivered();
          if (outcome === 'stopped') return 'stopped';
        } else if (frame.event === 'error') {
          return deps.classifyErrorFrame(frame.data) === 'terminal'
            ? 'fallback'
            : 'ended';
        }
      }
      if (done) return 'ended';
    }
    return 'stopped';
  } finally {
    cancelWatchdog();
    await cancelReader(reader);
    try {
      reader.releaseLock();
    } catch {
      // Lock already released after cancel; ignore.
    }
  }
}

/**
 * Run the SSE command transport until the portal stops or SSE proves
 * unavailable. Reconnects with backoff on transient drops; a connection that
 * delivered at least one frame resets the failure streak so a healthy stream
 * that simply rotated (e.g. a proxy idle-close) reconnects immediately.
 */
export async function runPortalCommandSseTransport(
  deps: PortalCommandSseDeps,
): Promise<CommandTransportOutcome> {
  let failureStreak = 0;

  while (!deps.isAborted()) {
    const sessionId = deps.getSessionId();
    if (!sessionId) {
      return 'stopped';
    }

    const controller = new AbortController();
    deps.setAbortController(controller);

    let response: Response;
    let cancelConnectWatchdog: () => void = () => undefined;
    try {
      await deps.flushOutbox();
      if (deps.isAborted()) {
        deps.setAbortController(null);
        return 'stopped';
      }
      cancelConnectWatchdog = deps.armTimeout(deps.connectTimeoutMs, () => {
        controller.abort();
      });
      response = await deps.openStream({
        sessionId,
        afterSeq: deps.getCursor(),
        signal: controller.signal,
      });
    } catch (error) {
      cancelConnectWatchdog();
      deps.setAbortController(null);
      if (deps.isAborted()) {
        return 'stopped';
      }
      if (deps.is404(error)) {
        // Endpoint not found → server does not support the SSE channel yet.
        return 'fallback';
      }
      if (deps.isInactiveSessionError(error)) {
        if ((await deps.onInactiveSessionResponse()) === 'terminal') {
          return 'stopped';
        }
        // Revived server-side (CAN-2651): reconnect on the existing backoff
        // instead of ending the session. The probe's own heartbeat already
        // reported the transport's health, so this is not a network failure.
        failureStreak += 1;
        if (failureStreak >= deps.maxImmediateFailures) {
          return 'fallback';
        }
        await deps.delay(backoffDelay(deps, failureStreak));
        continue;
      }
      deps.onNetworkFailure(error);
      failureStreak += 1;
      if (failureStreak >= deps.maxImmediateFailures) {
        return 'fallback';
      }
      await deps.delay(backoffDelay(deps, failureStreak));
      continue;
    }
    cancelConnectWatchdog();

    let delivered = false;
    let streamFailed = false;
    const startedAt = deps.now();
    try {
      const result = await consumeStream(response, deps, controller, () => {
        delivered = true;
      });
      deps.setAbortController(null);
      if (result === 'stopped') {
        return 'stopped';
      }
      if (result === 'fallback') {
        return 'fallback';
      }
    } catch (error) {
      deps.setAbortController(null);
      if (deps.isAborted()) {
        return 'stopped';
      }
      if (deps.isInactiveSessionError(error)) {
        if ((await deps.onInactiveSessionResponse()) === 'terminal') {
          return 'stopped';
        }
        // Revived (CAN-2651): fall through to the normal reconnect decision.
        // Marked as a failed stream so it backs off rather than reconnecting
        // instantly, but NOT reported as a network failure — the probe's
        // heartbeat already marked the connection healthy.
        streamFailed = true;
      } else {
        streamFailed = true;
        deps.onNetworkFailure(error);
      }
    }

    if (deps.isAborted()) {
      return 'stopped';
    }
    // A connection that delivered a frame AND lasted long enough is healthy:
    // reconnect immediately (handles proxy idle-rotation without exhausting the
    // failure budget). A delivered-but-short-lived connection is NOT trusted —
    // it backs off to avoid a reconnect storm.
    if (
      !streamFailed &&
      delivered &&
      deps.now() - startedAt >= deps.minHealthyConnectionMs
    ) {
      failureStreak = 0;
      continue;
    }
    failureStreak += 1;
    if (failureStreak >= deps.maxImmediateFailures) {
      return 'fallback';
    }
    await deps.delay(backoffDelay(deps, failureStreak));
  }

  return 'stopped';
}
