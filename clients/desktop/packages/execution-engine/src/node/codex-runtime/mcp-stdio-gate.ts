import type { Readable, Writable } from 'node:stream';
import type { McpAvailabilityObserver } from './mcp-availability-observer';

/** A refusal whose text the caller may read; `false` uses the generic denial. */
export interface McpToolCallRefusal {
  readonly refusal: string;
}

export type CodexStdioMcpToolCallGate = (call: {
  toolName: string;
  arguments: unknown;
  signal: AbortSignal;
}) => Promise<boolean | McpToolCallRefusal>;

/**
 * Rewrites one `tools/list` result page before the caller receives it. A
 * throw answers that request with an error instead of the upstream list.
 */
export type CodexStdioMcpToolListTransform = (page: {
  cursor?: string;
  result: unknown;
}) => unknown;

const MAX_PENDING_TOOL_LISTS = 64;
/** How long an unanswered list keeps its slot, matching the HTTP proxy. */
const PENDING_TOOL_LIST_TTL_MS = 60_000;

interface PendingToolList {
  readonly cursor?: string;
  readonly expires: number;
}

// Match the HTTP MCP proxy's request bound. JSONL framing also prevents a denied
// response from being inserted halfway through an upstream response.
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

async function* frames(source: Readable): AsyncGenerator<Buffer> {
  let pending: Buffer = Buffer.alloc(0);
  for await (const value of source) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const part = chunk.subarray(offset, end);
      if (pending.length + part.length > MAX_FRAME_BYTES)
        throw new Error('MCP message exceeds the supported size.');
      pending = pending.length ? Buffer.concat([pending, part]) : part;
      offset = end;
      if (newline >= 0) {
        yield pending;
        pending = Buffer.alloc(0);
      }
    }
  }
  if (pending.length) yield Buffer.concat([pending, Buffer.from('\n')]);
}

async function writeFrame(
  target: Writable,
  frame: Buffer | string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('MCP connection closed.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    target.write(frame, (error) => {
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** `true` allows; a string is the refusal text; `false` is the generic denial. */
function approved(
  gate: CodexStdioMcpToolCallGate,
  toolName: string,
  args: unknown,
  signal: AbortSignal,
): Promise<boolean | string> {
  return new Promise((resolve) => {
    const finish = (value: boolean | string): void => {
      signal.removeEventListener('abort', onAbort);
      resolve(signal.aborted ? false : value);
    };
    const onAbort = (): void => finish(false);
    if (signal.aborted) return finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    // Exceptions and rejected approvals never cross the untrusted transport.
    void Promise.resolve()
      .then(() => gate({ toolName, arguments: args, signal }))
      .then(
        (value) =>
          finish(
            value === true
              ? true
              : isRecord(value) && typeof value.refusal === 'string'
                ? value.refusal
                : false,
          ),
        () => finish(false),
      );
  });
}

function requestKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

/**
 * Records a `tools/list` request whose answer the relay must rewrite. Only an
 * answerable list (with an id) can be rewritten before it reaches the caller.
 */
function admitToolList(
  params: unknown,
  id: string | number | null,
  pending: Map<string, PendingToolList>,
): 'admitted' | 'invalid' | 'refused' {
  const cursor = isRecord(params) ? params.cursor : undefined;
  if (id === null || (cursor !== undefined && typeof cursor !== 'string'))
    return 'invalid';
  const key = requestKey(id);
  const now = Date.now();
  for (const [pendingKey, entry] of pending)
    if (entry.expires <= now) pending.delete(pendingKey);
  if (pending.has(key) || pending.size >= MAX_PENDING_TOOL_LISTS)
    return 'refused';
  pending.set(key, {
    ...(typeof cursor === 'string' ? { cursor } : {}),
    expires: now + PENDING_TOOL_LIST_TTL_MS,
  });
  return 'admitted';
}

/** Applies the transform to the response of a pending `tools/list` request. */
async function rewriteToolList(
  frame: Buffer,
  pending: Map<string, PendingToolList>,
  transform: CodexStdioMcpToolListTransform,
): Promise<Buffer | string> {
  let message: unknown;
  try {
    message = JSON.parse(frame.toString('utf8'));
  } catch {
    return frame;
  }
  if (
    !isRecord(message) ||
    'method' in message ||
    (typeof message.id !== 'string' && typeof message.id !== 'number')
  )
    return frame;
  const key = requestKey(message.id);
  const entry = pending.get(key);
  if (entry === undefined) return frame;
  const cursor = entry.cursor;
  pending.delete(key);
  if (!('result' in message)) return frame;
  try {
    const result = await transform({
      ...(cursor === undefined ? {} : { cursor }),
      result: message.result,
    });
    return JSON.stringify({ ...message, result }) + '\n';
  } catch {
    return (
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: 'The MCP tool list could not be prepared for this session.',
        },
      }) + '\n'
    );
  }
}

/**
 * MCP `arguments` is an optional object. A route that rewrites tool lists
 * (Antigravity) also reads `null` as no arguments, as its HTTP proxy route
 * does; other harnesses keep refusing it. The frame is forwarded as sent.
 */
function validArguments(value: unknown, listTransform: boolean): boolean {
  return (
    value === undefined || isRecord(value) || (listTransform && value === null)
  );
}

/** Only explicit selected routes use this gate; ordinary chat relays stay raw. */
export async function relayGovernedMcpStdio(options: {
  input: Readable;
  upstreamInput: Writable;
  upstreamOutput: Readable;
  output: Writable;
  gate?: CodexStdioMcpToolCallGate;
  toolListTransform?: CodexStdioMcpToolListTransform;
  observer?: McpAvailabilityObserver;
  signal: AbortSignal;
}): Promise<void> {
  const { input, upstreamInput, upstreamOutput, output, gate, signal } =
    options;
  const transform = options.toolListTransform;
  const pendingToolLists = new Map<string, PendingToolList>();
  const requests = async (): Promise<void> => {
    for await (const frame of frames(input)) {
      signal.throwIfAborted();
      if (!frame.toString('utf8').trim()) continue;
      let request: unknown;
      try {
        request = JSON.parse(frame.toString('utf8'));
      } catch {
        request = null;
      }
      let invalid = !isRecord(request) || request.jsonrpc !== '2.0';
      let allowed: boolean | string = !invalid;
      const id =
        isRecord(request) &&
        (typeof request.id === 'string' ||
          (typeof request.id === 'number' && Number.isFinite(request.id)))
          ? request.id
          : null;
      if (isRecord(request) && request.method === 'tools/call') {
        const params = request.params;
        invalid ||=
          id === null ||
          !isRecord(params) ||
          typeof params.name !== 'string' ||
          !params.name.trim() ||
          !validArguments(params.arguments, transform !== undefined);
        allowed =
          !invalid &&
          isRecord(params) &&
          typeof params.name === 'string' &&
          // Missing approval must fail closed even for a malformed caller.
          gate !== undefined &&
          (await approved(gate, params.name, params.arguments ?? {}, signal));
      } else if (
        transform &&
        !invalid &&
        isRecord(request) &&
        request.method === 'tools/list'
      ) {
        const decided = admitToolList(request.params, id, pendingToolLists);
        invalid = decided === 'invalid';
        allowed = decided === 'admitted';
      }
      signal.throwIfAborted();
      if (allowed === true) {
        options.observer?.request(request);
        await writeFrame(upstreamInput, frame, signal);
      } else
        await writeFrame(
          output,
          JSON.stringify(
            // A gate's refusal text is a tool result the model reads, the same
            // shape the HTTP proxy answers; other denials stay protocol errors.
            typeof allowed === 'string'
              ? {
                  jsonrpc: '2.0',
                  id,
                  result: {
                    content: [{ type: 'text', text: allowed }],
                    isError: true,
                  },
                }
              : {
                  jsonrpc: '2.0',
                  id,
                  error: {
                    code: invalid ? -32600 : -32000,
                    message: invalid
                      ? 'Invalid MCP request.'
                      : isRecord(request) && request.method === 'tools/list'
                        ? 'The MCP tool list request was not accepted.'
                        : 'The MCP tool call was not approved.',
                  },
                },
          ) + '\n',
          signal,
        );
    }
    upstreamInput.end();
  };
  const responses = async (): Promise<void> => {
    for await (const upstreamFrame of frames(upstreamOutput)) {
      const frame =
        transform && pendingToolLists.size > 0
          ? await rewriteToolList(upstreamFrame, pendingToolLists, transform)
          : upstreamFrame;
      await writeFrame(output, frame, signal);
      if (options.observer) {
        try {
          const message: unknown = JSON.parse(
            typeof frame === 'string' ? frame : frame.toString('utf8'),
          );
          options.observer.response(message);
        } catch {
          /* Invalid traffic cannot establish readiness. */
        }
      }
    }
    output.end();
  };
  const closeObserver = (): void => options.observer?.close();
  // The request stream can remain open after the server disconnects or the
  // owner cancels. Readiness must not wait for both relay loops to settle.
  upstreamOutput.once('end', closeObserver);
  upstreamOutput.once('close', closeObserver);
  upstreamOutput.once('error', closeObserver);
  signal.addEventListener('abort', closeObserver, { once: true });
  if (signal.aborted) closeObserver();
  try {
    await Promise.all([requests(), responses()]);
  } finally {
    upstreamOutput.removeListener('end', closeObserver);
    upstreamOutput.removeListener('close', closeObserver);
    upstreamOutput.removeListener('error', closeObserver);
    signal.removeEventListener('abort', closeObserver);
    closeObserver();
  }
}
