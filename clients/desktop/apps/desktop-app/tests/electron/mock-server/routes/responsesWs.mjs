// WebSocket transport for the OpenAI Responses API (`responses_websockets`
// beta). Bundled Codex (0.138+) no longer speaks the Chat Completions wire and
// drives the Responses API over a WebSocket: it dials `ws://<base>/responses`,
// sends a `response.create` frame, and consumes streamed `response.*` events.
// The HTTP-only `/v1/responses` route therefore never sees Codex traffic, so
// the Codex-backed helper/pipeline flows (e.g. branch naming) need this socket.
//
// The frames reuse the exact `response.*` event objects the SSE renderer emits
// (`buildResponsesEvents` in ./llm.mjs); only the framing differs. Each event is
// sent as its own top-level JSON text frame, and the terminal
// `response.completed` (carrying the final `output` items + usage) ends the
// turn — verified against the bundled Codex 0.138 client, which surfaces the
// streamed message as an `item.completed` / `agent_message` SDK event.
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  keyFromApiKey,
  keyFromBearer,
  waitForBarrier,
} from '../control-plane.mjs';
import {
  buildResponsesEvents,
  classifyResponsesStepError,
  resolveResponsesReply,
} from './llm.mjs';

const RESPONSES_WS_PATHS = new Set(['/responses', '/v1/responses']);
const RESPONSES_ROUTE = '/v1/responses';
const DEFAULT_BARRIER_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_HISTORY_ENTRIES = 32;

// Native OpenAI sends only new input after previous_response_id. Keep that
// protocol state per socket, not in the global scenario/cursor namespace.
export function createResponsesHistory() {
  const responses = new Map();
  let retainedBytes = 0;
  return {
    expand(body) {
      if (!body.previous_response_id) return body;
      const previous = responses.get(body.previous_response_id);
      if (!previous) {
        const error = new Error('Mock response history is missing or expired.');
        error.code = 'mock_context_missing';
        throw error;
      }
      return {
        ...previous.options,
        ...body,
        input: [...previous.input, ...(body.input ?? [])],
      };
    },
    remember(body, response) {
      const input = [...(body.input ?? []), ...(response.output ?? [])];
      const options = Object.fromEntries(
        ['instructions', 'tools', 'model', 'tool_choice']
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      );
      const bytes = Buffer.byteLength(JSON.stringify({ input, options }));
      if (bytes > MAX_RESPONSE_HISTORY_BYTES) {
        const error = new Error(
          'Mock response history exceeded its byte limit.',
        );
        error.code = 'mock_context_limit';
        throw error;
      }
      if (responses.has(response.id))
        retainedBytes -= responses.get(response.id).bytes;
      responses.delete(response.id);
      while (
        responses.size >= MAX_RESPONSE_HISTORY_ENTRIES ||
        retainedBytes + bytes > MAX_RESPONSE_HISTORY_BYTES
      ) {
        const oldest = responses.keys().next().value;
        retainedBytes -= responses.get(oldest).bytes;
        responses.delete(oldest);
      }
      responses.set(response.id, { input, options, bytes });
      retainedBytes += bytes;
    },
    clear() {
      responses.clear();
      retainedBytes = 0;
    },
  };
}

function isOpen(ws) {
  return ws.readyState === WebSocket.OPEN;
}

function send(ws, payload) {
  if (isOpen(ws)) {
    ws.send(JSON.stringify(payload));
  }
}

function markObservationError(observation, errorClass) {
  if (!observation || typeof observation !== 'object' || !errorClass) {
    return;
  }
  // Observation objects are shared with the control plane. Keep a transport
  // failure from masking the original response if a future observer chooses a
  // read-only projection.
  try {
    observation.errorClass = errorClass;
  } catch {
    // The server response/close remains authoritative if the observer is not
    // writable.
  }
}

function isMockErrorCode(code) {
  return (
    code === 'mock_barrier_timeout' ||
    code === 'mock_scenario_reset' ||
    code === 'mock_unmatched'
  );
}

function explicitMockErrorCode(error) {
  if (typeof error === 'string' && isMockErrorCode(error)) {
    return error;
  }
  if (error && typeof error === 'object') {
    if (isMockErrorCode(error.code)) {
      return error.code;
    }
    if (isMockErrorCode(error.kind)) {
      return error.kind;
    }
  }
  return undefined;
}

function sendFailed(ws, error, step, observation) {
  const classified = classifyResponsesStepError(step);
  const code =
    explicitMockErrorCode(error) ??
    explicitMockErrorCode(step?.error) ??
    (typeof error?.code === 'string' ? error.code : undefined) ??
    classified?.code ??
    'server_error';
  const message =
    (typeof error?.message === 'string' && error.message) ||
    classified?.message ||
    'Mock error.';

  markObservationError(observation, code);
  send(ws, {
    type: 'response.failed',
    response: {
      id: `resp_mock_${randomUUID()}`,
      object: 'response',
      status: 'failed',
      error: { code, message },
    },
  });
}

/**
 * Wait for an operation or for the socket to close. The losing promise keeps
 * both fulfillment and rejection handlers, so a barrier reset after the peer
 * disconnects cannot become an unhandled rejection.
 *
 * @param {WebSocket} ws
 * @param {Promise<unknown>} operation
 * @returns {Promise<{ open: false } | { open: true, value: unknown } | { open: true, error: unknown }>}
 */
function waitWhileOpen(ws, operation) {
  if (!isOpen(ws)) {
    return Promise.resolve({ open: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      ws.off('close', onClose);
      resolve(result);
    };
    const onClose = () => finish({ open: false });

    ws.once('close', onClose);
    if (!isOpen(ws)) {
      finish({ open: false });
      return;
    }

    Promise.resolve(operation).then(
      (value) => finish({ open: true, value }),
      (error) => finish({ open: true, error }),
    );
  });
}

/**
 * Delay before the first frame, but do not leave a timer behind when the
 * request's socket closes while delayed.
 *
 * @param {WebSocket} ws
 * @param {number} delayMs
 * @returns {Promise<boolean>} whether the socket remained open through delay
 */
function delayWhileOpen(ws, delayMs) {
  if (!isOpen(ws)) {
    return Promise.resolve(false);
  }
  if (!(Number.isFinite(delayMs) && delayMs > 0)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('close', onClose);
      resolve(open && isOpen(ws));
    };
    const onClose = () => finish(false);

    ws.once('close', onClose);
    timer = setTimeout(() => finish(true), delayMs);
    if (!isOpen(ws)) {
      finish(false);
    }
  });
}

function stepErrorKind(step) {
  const error = step?.error;
  if (error && typeof error === 'object') {
    return error.kind;
  }
  return undefined;
}

function stepDelayMs(step) {
  return typeof step?.delayMs === 'number' &&
    Number.isFinite(step.delayMs) &&
    step.delayMs > 0
    ? step.delayMs
    : 0;
}

function stepBarrierTimeoutMs(step) {
  return typeof step?.barrierTimeoutMs === 'number' &&
    Number.isFinite(step.barrierTimeoutMs) &&
    step.barrierTimeoutMs >= 0
    ? step.barrierTimeoutMs
    : DEFAULT_BARRIER_TIMEOUT_MS;
}

function stepMidstreamAfterFrames(step) {
  const raw =
    step?.error && typeof step.error === 'object'
      ? step.error.afterFrames
      : undefined;
  return Number.isInteger(raw) && raw >= 0 ? raw : 1;
}

function closeForMockFailure(ws, observation, errorClass) {
  markObservationError(observation, errorClass);
  if (isOpen(ws)) {
    ws.close();
  }
}

async function handleResponseCreate(ws, body, key, history) {
  let step;
  let observation;

  try {
    body = history.expand(body);
    if (body.generate === false) {
      // A connection prewarm is not an inference or a scripted-step attempt.
      const events = buildResponsesEvents({}, {}, body.model);
      history.remember(body, events.at(-1).data.response);
      for (const entry of events) send(ws, entry.data);
      return;
    }
    const resolved = resolveResponsesReply(body, {
      key,
      transport: 'ws',
      route: RESPONSES_ROUTE,
    });
    ({ step, observation } = resolved);

    if (typeof step?.waitFor === 'string') {
      const barrierKey = resolved.scenarioKey ?? key;
      const barrier = Promise.resolve().then(() =>
        waitForBarrier(barrierKey, step.waitFor, stepBarrierTimeoutMs(step)),
      );
      const result = await waitWhileOpen(ws, barrier);
      if (!result.open) return;
      if ('error' in result) {
        if (!(await delayWhileOpen(ws, stepDelayMs(step)))) {
          return;
        }
        throw result.error;
      }
    }

    if (!(await delayWhileOpen(ws, stepDelayMs(step)))) {
      return;
    }

    const errorKind = stepErrorKind(step);
    if (errorKind === 'disconnect') {
      closeForMockFailure(ws, observation, 'mock_disconnect');
      return;
    }

    const isMidstream = errorKind === 'midstream';
    if (isMidstream && stepMidstreamAfterFrames(step) === 0) {
      closeForMockFailure(ws, observation, 'mock_midstream');
      return;
    }

    const error = isMidstream ? null : classifyResponsesStepError(step);
    if (error) {
      sendFailed(ws, error, step, observation);
      return;
    }

    const events = buildResponsesEvents(step, resolved.usage, resolved.model);
    const pacedCount = events.filter((entry) => entry.paced).length;
    const totalMs =
      typeof step.streamMs === 'number' && step.streamMs > 0
        ? step.streamMs
        : 0;
    const perChunkMs = totalMs > 0 && pacedCount > 0 ? totalMs / pacedCount : 0;
    const afterFrames = isMidstream ? stepMidstreamAfterFrames(step) : -1;
    let sentFrames = 0;

    // Stream the `response.*` events as top-level frames, exactly as the SSE
    // transport emits them. The terminal `response.completed` (last entry)
    // carries the final `output` items + usage and signals end-of-turn for
    // this `response.create`.
    for (const entry of events) {
      if (!isOpen(ws)) return;
      if (entry.event === 'response.completed')
        history.remember(body, entry.data.response);
      send(ws, entry.data);
      sentFrames += 1;

      if (isMidstream && sentFrames >= afterFrames) {
        closeForMockFailure(ws, observation, 'mock_midstream');
        return;
      }

      if (entry.paced && perChunkMs > 0) {
        if (!(await delayWhileOpen(ws, perChunkMs))) return;
      }
    }
  } catch (error) {
    // `response.create` messages are intentionally independent, so one failed
    // barrier or render must not reject a detached message-handler promise.
    sendFailed(ws, error, step, observation);
  }
}

export function attachResponsesWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      pathname = request.url ?? '/';
    }
    if (!RESPONSES_WS_PATHS.has(pathname)) {
      // Not ours — let any other upgrade handler (or the default) deal with it.
      return;
    }

    const key =
      keyFromBearer(request) ?? keyFromApiKey(request, { header: 'x-api-key' });

    wss.handleUpgrade(request, socket, head, (ws) => {
      const history = createResponsesHistory();
      ws.once('close', () => history.clear());
      ws.on('message', (data) => {
        let body;
        try {
          body = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (body?.type !== 'response.create') {
          return;
        }

        // Every response.create gets its own promise/cursor and error handler;
        // overlapping requests on one socket remain independent.
        void handleResponseCreate(ws, body, key, history).catch((error) => {
          // The handler's internal catch is defensive, but keep the detached
          // promise boundary rejection-safe if that catch ever fails itself.
          sendFailed(ws, error);
        });
      });
      ws.on('error', () => {
        // Swallow — a dropped Codex prewarm/turn socket is not a mock failure.
      });
    });
  });

  return wss;
}
