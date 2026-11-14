import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { BRAND } from '@canopy/brand/current';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '../../lib/canopy-injected-tools';
import {
  ADD_LEDGER_ENTRY_DESCRIPTION,
  SEARCH_LEDGER_ENTRIES_DESCRIPTION,
  UPDATE_LEDGER_ENTRY_DESCRIPTION,
  addLedgerEntryJsonSchema,
  searchLedgerEntriesJsonSchema,
  updateLedgerEntryJsonSchema,
} from './definitions';
import type { JsonValue } from '../codex-runtime/generated/serde_json/JsonValue';
import type { LedgerToolKey, LedgerToolsRuntime } from './runtime';

/*
 * A pipeline step's Feed tools as an MCP server on the loopback interface,
 * for a Claude action subprocess on a cloud runner (CAN-6422). It speaks the
 * JSON subset desktop's own route does (initialize, tools/list, tools/call)
 * over HTTP POST, takes only the step's bearer token, and serves exactly the
 * three Feed tools of one attempt, until the attempt closes it.
 */

/** A request body larger than this is refused unread. */
const MAX_BODY_BYTES = 1024 * 1024;

const TOOLS: readonly {
  readonly key: LedgerToolKey;
  readonly description: string;
  readonly inputSchema: unknown;
}[] = [
  {
    key: 'add_ledger_entry',
    description: ADD_LEDGER_ENTRY_DESCRIPTION,
    inputSchema: addLedgerEntryJsonSchema,
  },
  {
    key: 'search_ledger_entries',
    description: SEARCH_LEDGER_ENTRIES_DESCRIPTION,
    inputSchema: searchLedgerEntriesJsonSchema,
  },
  {
    key: 'update_ledger_entry',
    description: UPDATE_LEDGER_ENTRY_DESCRIPTION,
    inputSchema: updateLedgerEntryJsonSchema,
  },
];

/** The MCP server a Claude subprocess is given, and how to end it. */
export interface LedgerToolsMcpRoute {
  /** The `mcpServers` entry: the brand's injected server name to its route. */
  readonly mcpServers: Record<string, JsonValue>;
  /** The route's bearer token, which the step masks in its output. */
  readonly token: string;
  /** The tools a Claude subprocess may call, by their Claude names. */
  readonly allowedTools: readonly string[];
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(request: IncomingMessage, token: Buffer): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length), 'utf8');
  return given.length === token.length && timingSafeEqual(given, token);
}

/**
 * The key a call's Ledger writes dedupe on. The bundled Claude CLI sends the
 * call's tool_use ID as `_meta["claudecode/toolUseId"]` and resends it when
 * it retries the call, as desktop's route relies on. A JSON-RPC ID is no key:
 * every connection counts from 1, and an attempt's route can serve more than
 * one subprocess. Without the tool_use ID the runtime keys the call on its
 * own, which can't dedupe a retry but never replays another call.
 */
function invocationOf(params: Record<string, unknown>): {
  readonly invocationId?: string;
} {
  const meta = params._meta;
  const toolUseId = isRecord(meta) ? meta['claudecode/toolUseId'] : undefined;
  return typeof toolUseId === 'string' && toolUseId.length > 0
    ? { invocationId: `claude:${toolUseId}` }
    : {};
}

/** Whether the step's approval allows a call to the tool. */
export type LedgerToolsRouteAuthorize = (tool: LedgerToolKey) => boolean;

const NOT_ALLOWED = 'This workflow step may not use this tool.';

/** What one HTTP request's messages share. */
interface RouteRequest {
  readonly tools: LedgerToolsRuntime;
  readonly authorize: LedgerToolsRouteAuthorize;
  /** Aborts when the client hangs up. */
  readonly signal: AbortSignal;
  /** The calls in flight on this route, by session and JSON-RPC ID. */
  readonly calls: Map<string, AbortController>;
  /** The client's MCP session, which keys its request IDs. */
  readonly session: string;
}

/** A JSON-RPC ID within its MCP session: IDs repeat across sessions. */
function callKey(session: string, id: unknown): string {
  return JSON.stringify([session, id]);
}

/** Answers one JSON-RPC message; null for a notification. */
async function answer(
  route: RouteRequest,
  message: unknown,
): Promise<Record<string, unknown> | null> {
  if (!isRecord(message)) return rpcError(null, -32600, 'Invalid request');
  const { method } = message;
  if (!('id' in message)) {
    // A cancelled request aborts its call, which withdraws its owner request.
    if (method === 'notifications/cancelled' && isRecord(message.params))
      route.calls
        .get(callKey(route.session, message.params.requestId))
        ?.abort();
    return null;
  }
  const { id } = message;
  if (method === 'initialize')
    return rpcResult(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: BRAND.tools.namespace, version: '1.0.0' },
    });
  if (method === 'tools/list')
    return rpcResult(id, {
      tools: TOOLS.map(({ key, description, inputSchema }) => ({
        name: CANOPY_INJECTED_TOOL_REGISTRY[key].displayName,
        description,
        inputSchema,
      })),
    });
  if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
  const params = isRecord(message.params) ? message.params : {};
  const tool = TOOLS.find(
    ({ key }) => CANOPY_INJECTED_TOOL_REGISTRY[key].displayName === params.name,
  );
  if (tool === undefined) return rpcError(id, -32602, 'Unknown tool');
  // The subprocess runs outside any chat, so no hook checks its calls: each
  // passes the step's approval here, and a denial is the tool's error.
  if (!route.authorize(tool.key))
    return rpcResult(id, {
      content: [{ type: 'text', text: NOT_ALLOWED }],
      isError: true,
    });
  const key = callKey(route.session, id);
  const call = new AbortController();
  route.calls.set(key, call);
  let result: Awaited<ReturnType<LedgerToolsRuntime['execute']>>;
  try {
    result = await route.tools.execute(
      tool.key,
      isRecord(params.arguments) ? params.arguments : {},
      {
        ...invocationOf(params),
        signal: AbortSignal.any([route.signal, call.signal]),
      },
    );
  } finally {
    if (route.calls.get(key) === call) route.calls.delete(key);
  }
  return rpcResult(id, {
    content: [{ type: 'text', text: result.text }],
    ...(result.isError === true ? { isError: true } : {}),
  });
}

/**
 * Starts the Feed tools' MCP route for one attempt on a random loopback
 * port, behind a random bearer token.
 */
export async function startLedgerToolsMcpRoute(
  tools: LedgerToolsRuntime,
  authorize: LedgerToolsRouteAuthorize,
): Promise<LedgerToolsMcpRoute> {
  const token = randomBytes(32).toString('base64url');
  const tokenBytes = Buffer.from(token, 'utf8');
  const path = `/mcp/${randomBytes(16).toString('hex')}`;
  const calls = new Map<string, AbortController>();
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.url !== path || !authorized(request, tokenBytes)) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    let body: unknown;
    try {
      body = await readBody(request);
    } catch {
      response.writeHead(400).end();
      return;
    }
    // A client that hangs up cancels its calls, which withdraws their owner
    // requests.
    const cancelled = new AbortController();
    response.once('close', () => {
      if (!response.writableFinished) cancelled.abort();
    });
    // Initialize opens an MCP session; the client names it on every later
    // request, so its cancellations reach only its own calls.
    const named = request.headers['mcp-session-id'];
    const session =
      typeof named === 'string' && named.length > 0
        ? named
        : randomBytes(16).toString('hex');
    if (named === undefined) response.setHeader('Mcp-Session-Id', session);
    const route: RouteRequest = {
      tools,
      authorize,
      signal: cancelled.signal,
      calls,
      session,
    };
    const reply = (item: unknown): Promise<Record<string, unknown> | null> =>
      answer(route, item);
    const replies = Array.isArray(body)
      ? (await Promise.all(body.map(reply))).filter((item) => item !== null)
      : await reply(body);
    if (replies === null || (Array.isArray(replies) && replies.length === 0)) {
      response.writeHead(202).end();
      return;
    }
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(replies));
  };
  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('The Feed tools route has no port.');
  }
  return {
    mcpServers: {
      [BRAND.tools.namespace]: {
        type: 'http',
        url: `http://127.0.0.1:${String(address.port)}${path}`,
        headers: { Authorization: `Bearer ${token}` },
        alwaysLoad: true,
      },
    },
    token,
    allowedTools: TOOLS.map(
      ({ key }) => CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName,
    ),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
