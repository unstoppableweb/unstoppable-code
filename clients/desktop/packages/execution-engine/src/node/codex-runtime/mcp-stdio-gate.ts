import type { Readable, Writable } from 'node:stream';
import type { McpAvailabilityObserver } from './mcp-availability-observer';

export type CodexStdioMcpToolCallGate = (call: {
  toolName: string;
  arguments: unknown;
  signal: AbortSignal;
}) => Promise<boolean>;

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

function approved(
  gate: CodexStdioMcpToolCallGate,
  toolName: string,
  args: unknown,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      signal.removeEventListener('abort', onAbort);
      resolve(value && !signal.aborted);
    };
    const onAbort = (): void => finish(false);
    if (signal.aborted) return finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    // Exceptions and rejected approvals never cross the untrusted transport.
    void Promise.resolve()
      .then(() => gate({ toolName, arguments: args, signal }))
      .then(
        (value) => finish(value === true),
        () => finish(false),
      );
  });
}

/** Only explicit selected routes use this gate; ordinary chat relays stay raw. */
export async function relayGovernedMcpStdio(options: {
  input: Readable;
  upstreamInput: Writable;
  upstreamOutput: Readable;
  output: Writable;
  gate?: CodexStdioMcpToolCallGate;
  observer?: McpAvailabilityObserver;
  signal: AbortSignal;
}): Promise<void> {
  const { input, upstreamInput, upstreamOutput, output, gate, signal } =
    options;
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
      let allowed = !invalid;
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
          (params.arguments !== undefined && !isRecord(params.arguments));
        allowed =
          !invalid &&
          isRecord(params) &&
          typeof params.name === 'string' &&
          // Missing approval must fail closed even for a malformed caller.
          gate !== undefined &&
          (await approved(gate, params.name, params.arguments ?? {}, signal));
      }
      signal.throwIfAborted();
      if (allowed) {
        options.observer?.request(request);
        await writeFrame(upstreamInput, frame, signal);
      } else
        await writeFrame(
          output,
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: invalid ? -32600 : -32000,
              message: invalid
                ? 'Invalid MCP request.'
                : 'The MCP tool call was not approved.',
            },
          }) + '\n',
          signal,
        );
    }
    upstreamInput.end();
  };
  const responses = async (): Promise<void> => {
    for await (const frame of frames(upstreamOutput)) {
      await writeFrame(output, frame, signal);
      if (options.observer) {
        try {
          const message: unknown = JSON.parse(frame.toString('utf8'));
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
