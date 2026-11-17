import type { IncomingMessage, ServerResponse } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { isRecord } from './integration-http';

/**
 * Bound for one buffered JSON answer, or for one SSE event; an event stream as
 * a whole is not capped, only each event in it. Matches the OpenCode discovery
 * catalog bound. The stdio relay frames messages at 2 MiB.
 */
const MAX_TOOL_LIST_BYTES = 8 * 1024 * 1024;
/** Unanswered list requests one route may hold, and how long each may wait. */
const MAX_PENDING_TOOL_LISTS = 64;
const PENDING_TOOL_LIST_TTL_MS = 60_000;

type Rewrite = (page: { cursor?: string; result: unknown }) => unknown;

/**
 * Rewrites one `tools/list` result page for the session that owns a gated
 * route. A throw answers that request with an error instead of the list.
 */
export type McpProxiedToolListTransform = (page: {
  proxyUrl: string;
  cursor?: string;
  result: unknown;
}) => unknown;

export interface ToolListRequest {
  readonly id: string | number;
  readonly cursor?: string;
}

function requestKey(session: string, id: string | number): string {
  return `${session}\0${typeof id}:${String(id)}`;
}

/**
 * The `tools/list` requests one gated route has forwarded and not yet seen
 * answered. A server may answer a POST with 202 and deliver the response on
 * the session's GET stream; whichever stream carries a pending id's response
 * has it rewritten. Entries are keyed by the client's MCP session and request
 * id, bounded in number and age, and die with the route.
 */
export class PendingToolLists {
  private readonly entries = new Map<
    string,
    { request: ToolListRequest; expires: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  add(
    session: string,
    request: ToolListRequest,
  ): 'added' | 'duplicate' | 'full' {
    this.expire();
    const key = requestKey(session, request.id);
    if (this.entries.has(key)) return 'duplicate';
    if (this.entries.size >= MAX_PENDING_TOOL_LISTS) return 'full';
    this.entries.set(key, {
      request,
      expires: this.now() + PENDING_TOOL_LIST_TTL_MS,
    });
    return 'added';
  }

  /**
   * Removes and returns the session's pending request a response id answers.
   * Expired entries are evicted only when a new request is admitted, so a late
   * answer is rewritten until then, and relayed raw (unrecorded) after.
   */
  take(session: string, id: string | number): ToolListRequest | undefined {
    const key = requestKey(session, id);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry?.request;
  }

  drop(session: string, id: string | number): void {
    this.entries.delete(requestKey(session, id));
  }

  /**
   * False when no response on this route can need rewriting. Deliberately
   * keeps expired entries: they may still be answered late.
   */
  hasPending(): boolean {
    return this.entries.size > 0;
  }

  private expire(): void {
    const now = this.now();
    for (const [key, entry] of this.entries)
      if (entry.expires <= now) this.entries.delete(key);
  }
}

/**
 * Reads the buffered POST body of a gated route. `refuse` answers a batch or
 * an unanswerable list, which the route could not rewrite.
 */
export function toolListRequest(
  body: string,
): ToolListRequest | 'refuse' | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const isList = (value: unknown): value is Record<string, unknown> =>
    isRecord(value) && value.method === 'tools/list';
  if (Array.isArray(parsed)) return parsed.some(isList) ? 'refuse' : undefined;
  if (!isList(parsed)) return undefined;
  const id = parsed.id;
  const cursor = isRecord(parsed.params) ? parsed.params.cursor : undefined;
  if (
    (typeof id !== 'string' && typeof id !== 'number') ||
    (cursor !== undefined && typeof cursor !== 'string')
  )
    return 'refuse';
  return typeof cursor === 'string' ? { id, cursor } : { id };
}

/** One MCP session's view of a route's pending lists. */
export interface SessionToolLists {
  readonly lists: PendingToolLists;
  readonly session: string;
}

async function rewriteMessage(
  message: unknown,
  pending: SessionToolLists,
  rewrite: Rewrite,
): Promise<unknown> {
  if (
    !isRecord(message) ||
    'method' in message ||
    (typeof message.id !== 'string' && typeof message.id !== 'number')
  )
    return message;
  const request = pending.lists.take(pending.session, message.id);
  // An error answer still settles the request; only a result is rewritten.
  if (request === undefined || !('result' in message)) return message;
  try {
    const result = await rewrite({
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      result: message.result,
    });
    return { ...message, result };
  } catch {
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32603,
        message: 'The MCP tool list could not be prepared for this session.',
      },
    };
  }
}

/** Rewrites one SSE event when its data is the list's response. */
async function rewriteEvent(
  lines: readonly string[],
  pending: SessionToolLists,
  rewrite: Rewrite,
): Promise<string> {
  const original = `${lines.join('\n')}\n\n`;
  // An idle stream (nothing pending) is relayed without parsing.
  if (!pending.lists.hasPending()) return original;
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5));
  if (data.length === 0) return original;
  let message: unknown;
  try {
    message = JSON.parse(data.join('\n'));
  } catch {
    return original;
  }
  // A JSON-RPC batch carries several messages in one event.
  const rewritten = Array.isArray(message)
    ? await Promise.all(
        message.map((item) => rewriteMessage(item, pending, rewrite)),
      )
    : await rewriteMessage(message, pending, rewrite);
  if (
    rewritten === message ||
    (Array.isArray(message) &&
      Array.isArray(rewritten) &&
      rewritten.every((item, index) => item === message[index]))
  )
    return original;
  const kept = lines.filter((line) => !line.startsWith('data:'));
  return `${[...kept, `data: ${JSON.stringify(rewritten)}`].join('\n')}\n\n`;
}

/**
 * Relays an upstream answer on a gated route with a session list transform,
 * rewriting the response to any pending `tools/list` request in a JSON body or
 * an SSE stream. `own` is the list request this POST carried, if any; a GET
 * stream has none. Only complete events are written, so an aborted or
 * oversized stream never relays part of a list.
 */
export async function relayToolList(
  upstream: IncomingMessage,
  res: ServerResponse,
  headers: Record<string, string | string[]>,
  lists: SessionToolLists,
  rewrite: Rewrite,
  own?: ToolListRequest,
): Promise<void> {
  const status = upstream.statusCode ?? 502;
  const encoding = String(upstream.headers['content-encoding'] ?? 'identity');
  // The proxy never asks for compression; an encoded list cannot be rewritten.
  if (status >= 200 && status < 300 && encoding !== 'identity') {
    upstream.destroy();
    if (own) answerUnusable(res, own, 'The MCP tool list was compressed.');
    else res.destroy();
    return;
  }
  const contentType = String(upstream.headers['content-type'] ?? '');
  const stream = contentType.includes('text/event-stream');
  // A POST's own answer is buffered whatever its JSON content type; a GET that
  // is not an event stream carries no responses.
  if (status < 200 || status >= 300 || (!stream && !own)) {
    res.writeHead(status, upstream.statusMessage, headers);
    upstream.pipe(res);
    return;
  }
  // The rewritten body has its own length and framing. `content-length` is
  // never on the safe response-header list, so it cannot go stale here.
  const rewrittenHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name !== 'transfer-encoding'),
  );
  const head = (): void => {
    res.writeHead(status, upstream.statusMessage, rewrittenHeaders);
  };
  const relayed = stream
    ? await relayEventStream(upstream, res, head, lists, rewrite)
    : await relayJson(upstream, res, head, lists, rewrite);
  if (relayed === 'too-large')
    answerFailed(upstream, res, own, 'The MCP tool list is too large.');
  else if (relayed === 'closed-early')
    answerFailed(
      upstream,
      res,
      own,
      'The MCP server closed the tool list early.',
    );
}

/** Answers the request's own list with an error when nothing was relayed yet. */
function answerFailed(
  upstream: IncomingMessage,
  res: ServerResponse,
  own: ToolListRequest | undefined,
  message: string,
): void {
  upstream.destroy();
  if (res.headersSent || res.destroyed || !own) {
    res.destroy();
    return;
  }
  answerUnusable(res, own, message);
}

function answerUnusable(
  res: ServerResponse,
  own: ToolListRequest,
  message: string,
): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: own.id,
      error: { code: -32603, message },
    }),
  );
}

async function rewriteJsonBody(
  text: string,
  lists: SessionToolLists,
  rewrite: Rewrite,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // Not JSON-RPC: relay as received.
  }
  const rewritten = Array.isArray(parsed)
    ? await Promise.all(
        parsed.map((item) => rewriteMessage(item, lists, rewrite)),
      )
    : await rewriteMessage(parsed, lists, rewrite);
  return JSON.stringify(rewritten);
}

async function relayJson(
  upstream: IncomingMessage,
  res: ServerResponse,
  head: () => void,
  lists: SessionToolLists,
  rewrite: Rewrite,
): Promise<'done' | 'too-large' | 'closed-early'> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of upstream) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > MAX_TOOL_LIST_BYTES) return 'too-large';
      chunks.push(buffer);
    }
  } catch {
    // An aborted upstream response rejects the iteration.
    return 'closed-early';
  }
  // A truncated body is never parsed or advertised.
  if (!upstream.complete) return 'closed-early';
  if (res.destroyed) return 'done';
  const body = await rewriteJsonBody(
    Buffer.concat(chunks).toString('utf8'),
    lists,
    rewrite,
  );
  if (res.destroyed) return 'done';
  head();
  res.end(body);
  return 'done';
}

/** Resolves once the response accepts more data. */
function write(res: ServerResponse, chunk: string): Promise<void> {
  if (res.write(chunk) || res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/**
 * Splits SSE text into lines (`\r\n`, `\r` or `\n`) and lines into events; a
 * blank line ends an event. A chunk ending in `\r` has ended its line; a `\n`
 * that starts the next chunk belongs to the same terminator.
 */
class EventAssembler {
  /** The current line's text so far, kept in chunks and joined once. */
  private partial: string[] = [];
  private partialBytes = 0;
  private skipLineFeed = false;
  private lines: string[] = [];
  private bytes = 0;

  constructor(
    private readonly res: ServerResponse,
    private readonly lists: SessionToolLists,
    private readonly rewrite: Rewrite,
  ) {}

  /** Feeds decoded text; false once the event being assembled is too large. */
  async push(text: string, final = false): Promise<boolean> {
    let next = text;
    if (next && this.skipLineFeed) {
      this.skipLineFeed = false;
      if (next.startsWith('\n')) next = next.slice(1);
    }
    if (next.endsWith('\r')) this.skipLineFeed = true;
    // Only the new text is scanned; a long line costs linear work overall.
    const parts = next.split(/\r\n|\r|\n/);
    const last = parts.pop() ?? '';
    for (const [index, part] of parts.entries())
      await this.line(index === 0 ? this.takePartial() + part : part);
    if (last) {
      this.partial.push(last);
      this.partialBytes += Buffer.byteLength(last);
    }
    // At end of stream an unterminated line or event is discarded (SSE).
    if (final) {
      this.takePartial();
      this.lines = [];
      this.bytes = 0;
    }
    return this.bytes + this.partialBytes <= MAX_TOOL_LIST_BYTES;
  }

  private takePartial(): string {
    const text = this.partial.join('');
    this.partial = [];
    this.partialBytes = 0;
    return text;
  }

  private async line(line: string): Promise<void> {
    if (line !== '') {
      this.lines.push(line);
      this.bytes += Buffer.byteLength(line) + 1;
      return;
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    const lines = this.lines;
    this.lines = [];
    this.bytes = 0;
    if (lines.length > 0)
      await write(
        this.res,
        await rewriteEvent(lines, this.lists, this.rewrite),
      );
  }
}

async function relayEventStream(
  upstream: IncomingMessage,
  res: ServerResponse,
  head: () => void,
  lists: SessionToolLists,
  rewrite: Rewrite,
): Promise<'done' | 'too-large'> {
  head();
  // A client that leaves releases the upstream stream at once, even when idle.
  res.once('close', () => {
    if (!upstream.complete) upstream.destroy();
  });
  // Multi-byte characters may span chunks.
  const decoder = new StringDecoder('utf8');
  const events = new EventAssembler(res, lists, rewrite);
  for await (const chunk of upstream) {
    if (res.destroyed) {
      upstream.destroy();
      return 'done';
    }
    const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    if (!(await events.push(text))) return 'too-large';
  }
  // An early close rejects the read; the check guards a body that ends short.
  if (!upstream.complete)
    throw new Error('The MCP server closed the response early.');
  await events.push(decoder.end(), true);
  res.end();
  return 'done';
}
