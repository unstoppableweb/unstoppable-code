import {
  MCP_HOST_RESPONSE_MAX_BODY_BYTES,
  type McpHostRequest,
  type McpHostRequestRespondParams,
} from '@canopy/protocol/canopy-core';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import type { ReachBackActivityLog, ReachBackDecision } from './activity-log';
import type { ReachBackAllowList, ReachBackServer } from './allow-list';
import type { ReachBackApprover } from './approval';

/**
 * Serves one reach-back request (CAN-6176 PR 7a, D25): a cloud chat's MCP
 * request for a server this account allowed on this computer.
 *
 * Only an allowed server and config, matching the request's cloud
 * connection, is served; anything else is answered 404. `tools/list` is
 * filtered to the tools chosen at opt-in and `tools/call` refused outside
 * them, on top of the cloud proxy's own gate. A call to a tool the server
 * doesn't mark read-only, and that wasn't chosen to run without asking, is
 * asked about on this computer first (Q3). Every call is recorded in the
 * call log, without its arguments or result.
 */

/** A response from the server, already a single JSON answer (D24). */
export interface ReachBackUpstreamResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** A digest of the server settings the request went through, when known. */
  readonly configRevision?: string;
}

export interface ReachBackForwarder {
  forward(
    server: ReachBackServer,
    request: {
      readonly method: 'POST' | 'DELETE';
      readonly headers: McpHostRequest['headers'];
      readonly body: Uint8Array;
      readonly signal: AbortSignal;
      /**
       * Forward only through these settings: when the server's settings
       * changed since, nothing is sent and the answer is `configChanged`.
       */
      readonly expectedConfigRevision?: string;
    },
  ): Promise<ReachBackUpstreamResponse | 'configChanged'>;
}

export interface ReachBackServeDeps {
  readonly allowList: ReachBackAllowList;
  readonly log: ReachBackActivityLog;
  readonly approver: ReachBackApprover;
  readonly forwarder: ReachBackForwarder;
  readonly now?: () => Date;
}

type Answer = Omit<McpHostRequestRespondParams, 'requestId'>;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function json(status: number, value: unknown): Answer {
  return {
    status,
    headers: JSON_HEADERS,
    bodyBase64: Buffer.from(JSON.stringify(value)).toString('base64'),
  };
}

/** A JSON-RPC error for `id`, answered as the call's result (HTTP 200). */
function rpcError(id: unknown, message: string): Answer {
  return json(200, {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: -32001, message },
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseBody(bodyBase64: string): unknown {
  if (bodyBase64 === '') return undefined;
  try {
    return JSON.parse(Buffer.from(bodyBase64, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The tools each server last listed as read-only (`readOnlyHint: true`), and
 * the settings revision that listing went through. A hint holds only for the
 * settings it came from: after an edit, the server's own next listing says.
 */
type ReadOnlyTools = Map<
  string,
  { readonly revision: string; readonly tools: ReadonlySet<string> }
>;

/** As the call log keeps a tool's name. */
const MAX_TOOL_NAME_LENGTH = 256;

const serverKey = (server: ReachBackServer): string =>
  JSON.stringify([server.serverId, server.configId]);

const REFUSALS: Partial<Record<ReachBackDecision, string>> = {
  tool_not_allowed: 'This tool is not allowed in cloud chats on that desktop.',
  asked_denied: 'The person at the desktop declined this tool call.',
  approval_timeout:
    'Nobody at the desktop answered in time, so the tool call was refused.',
  no_window:
    'The desktop could not ask about this tool call, so it was refused.',
};

export function createReachBackServer(deps: ReachBackServeDeps): {
  serve(
    accountId: string,
    request: McpHostRequest,
    signal: AbortSignal,
  ): Promise<McpHostRequestRespondParams>;
} {
  const now = deps.now ?? ((): Date => new Date());
  const readOnly: ReadOnlyTools = new Map();

  const record = (
    accountId: string,
    request: { serverId: string; configId: string },
    chat: { id: string; title: string } | null,
    toolName: string | null,
    decision: ReachBackDecision,
    status: number | null,
  ): void => {
    void deps.log
      .record(accountId, {
        at: now().toISOString(),
        chat,
        serverId: request.serverId,
        configId: request.configId,
        toolName,
        decision,
        status,
      })
      .catch((error: unknown) =>
        logMainProcessWarn(
          '[cloud-reach-back] Could not record a call.',
          error,
        ),
      );
  };

  const forward = async (
    server: ReachBackServer,
    request: McpHostRequest,
    signal: AbortSignal,
    expectedConfigRevision?: string,
  ): Promise<
    | {
        answer: Answer;
        body: Uint8Array | null;
        configRevision?: string;
      }
    | 'configChanged'
  > => {
    let response: ReachBackUpstreamResponse | 'configChanged';
    try {
      response = await deps.forwarder.forward(server, {
        method: request.method === 'DELETE' ? 'DELETE' : 'POST',
        headers: request.headers,
        body: Buffer.from(request.bodyBase64, 'base64'),
        signal,
        ...(expectedConfigRevision === undefined
          ? {}
          : { expectedConfigRevision }),
      });
    } catch {
      return {
        answer: json(502, { error: 'mcp_server_unreachable' }),
        body: null,
      };
    }
    if (response === 'configChanged') return response;
    if (response.body.byteLength > MCP_HOST_RESPONSE_MAX_BODY_BYTES)
      return {
        answer: json(502, { error: 'mcp_response_too_large' }),
        body: null,
      };
    const status =
      response.status >= 200 && response.status <= 599 ? response.status : 502;
    const headers: Answer['headers'] = {};
    for (const name of [
      'content-type',
      'mcp-session-id',
      'mcp-protocol-version',
    ] as const) {
      const value = response.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    return {
      answer: {
        status,
        headers,
        bodyBase64: Buffer.from(response.body).toString('base64'),
      },
      body: response.body,
      ...(response.configRevision === undefined
        ? {}
        : { configRevision: response.configRevision }),
    };
  };
  /** A forward made without an expected revision always answers. */
  const forwardAnyway = async (
    server: ReachBackServer,
    request: McpHostRequest,
    signal: AbortSignal,
  ): Promise<{
    answer: Answer;
    body: Uint8Array | null;
    configRevision?: string;
  }> => {
    const forwarded = await forward(server, request, signal);
    return forwarded === 'configChanged'
      ? { answer: json(409, { error: 'mcp_config_changed' }), body: null }
      : forwarded;
  };

  /** `tools/list` keeps the chosen tools, and remembers the read-only ones. */
  const filterToolList = (
    server: ReachBackServer,
    answer: Answer,
    body: Uint8Array,
    configRevision: string | undefined,
  ): Answer => {
    let message: unknown;
    try {
      message = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
      // Not a JSON answer: nothing is listed rather than everything.
      return json(502, { error: 'mcp_response_unreadable' });
    }
    if (!isRecord(message) || !isRecord(message.result)) return answer;
    const tools = Array.isArray(message.result.tools)
      ? message.result.tools
      : [];
    const allowed = server.enabledTools ? new Set(server.enabledTools) : null;
    const kept = tools.filter(
      (tool): tool is Record<string, unknown> =>
        isRecord(tool) &&
        typeof tool.name === 'string' &&
        (allowed === null || allowed.has(tool.name)),
    );
    // Hints from settings this desktop can't name never skip a prompt.
    if (configRevision === undefined) readOnly.delete(serverKey(server));
    else
      readOnly.set(serverKey(server), {
        revision: configRevision,
        tools: new Set(
          kept
            .filter(
              (tool) =>
                isRecord(tool.annotations) &&
                tool.annotations.readOnlyHint === true,
            )
            .map((tool) => String(tool.name)),
        ),
      });
    return json(answer.status, {
      ...message,
      result: { ...message.result, tools: kept },
    });
  };

  return {
    async serve(accountId, request, signal) {
      const { chat } = request;
      const answer = (value: Answer): McpHostRequestRespondParams => ({
        requestId: request.requestId,
        ...value,
      });
      const server = await deps.allowList.find(accountId, request);
      if (server === null) {
        logMainProcessWarn(
          '[cloud-reach-back] Refused a request for a server not allowed here.',
        );
        record(accountId, request, chat, null, 'server_not_allowed', 404);
        return answer(json(404, { error: 'mcp_server_not_allowed' }));
      }
      if (request.method === 'GET')
        return answer(json(405, { error: 'method_not_allowed' }));
      if (request.method === 'DELETE')
        return answer((await forwardAnyway(server, request, signal)).answer);

      const message = parseBody(request.bodyBase64);
      // One JSON-RPC message per request; a batch could hide a call.
      if (Array.isArray(message))
        return answer(json(400, { error: 'mcp_batch_not_supported' }));
      // Fail closed: only a single JSON-RPC message this desktop can read is
      // served, and the server gets exactly the message checked here, so a
      // body read differently upstream (a BOM, another charset, a duplicate
      // key) can't slip past the tool check.
      if (!isRecord(message) || typeof message.method !== 'string')
        return answer(json(400, { error: 'mcp_request_unreadable' }));
      const { method } = message;
      const checked: McpHostRequest = {
        ...request,
        headers: { ...request.headers, 'content-type': 'application/json' },
        bodyBase64: Buffer.from(JSON.stringify(message)).toString('base64'),
      };

      if (method === 'tools/list') {
        const {
          answer: forwarded,
          body,
          configRevision,
        } = await forwardAnyway(server, checked, signal);
        return answer(
          body === null || forwarded.status !== 200
            ? forwarded
            : filterToolList(server, forwarded, body, configRevision),
        );
      }
      if (method !== 'tools/call')
        return answer((await forwardAnyway(server, checked, signal)).answer);

      const { id } = message;
      const params = isRecord(message.params) ? message.params : {};
      // A name no tool can have is refused like a tool not chosen.
      const toolName =
        typeof params.name === 'string' &&
        params.name.length > 0 &&
        params.name.length <= MAX_TOOL_NAME_LENGTH
          ? params.name
          : null;
      if (
        toolName === null ||
        (server.enabledTools !== null &&
          !server.enabledTools.includes(toolName))
      ) {
        record(accountId, request, chat, toolName, 'tool_not_allowed', 200);
        return answer(rpcError(id, REFUSALS.tool_not_allowed ?? ''));
      }
      const hinted = readOnly.get(serverKey(server));
      const decision: ReachBackDecision = server.allowWithoutAsking.includes(
        toolName,
      )
        ? 'allowed_without_asking'
        : hinted?.tools.has(toolName) === true
          ? 'read_only'
          : await deps.approver.ask({
              requestId: request.requestId,
              chat,
              serverName: server.displayName,
              toolName,
              arguments: params.arguments,
              signal,
            });
      const refusal = REFUSALS[decision];
      if (refusal !== undefined) {
        record(accountId, request, chat, toolName, decision, 200);
        return answer(rpcError(id, refusal));
      }
      if (signal.aborted) {
        // Withdrawn while asking: it never runs.
        record(accountId, request, chat, toolName, decision, null);
        return answer(rpcError(id, 'The request was withdrawn.'));
      }
      // Turned off while asking: it runs only under a permission still held.
      const current = await deps.allowList.find(accountId, request);
      if (
        current === null ||
        (current.enabledTools !== null &&
          !current.enabledTools.includes(toolName))
      ) {
        record(accountId, request, chat, toolName, 'tool_not_allowed', 200);
        return answer(rpcError(id, REFUSALS.tool_not_allowed ?? ''));
      }
      // A read-only call runs unasked only through the settings that said
      // so; after an edit it isn't sent, and the next listing decides.
      const forwarded = await forward(
        current,
        checked,
        signal,
        decision === 'read_only' ? hinted?.revision : undefined,
      );
      if (forwarded === 'configChanged') {
        readOnly.delete(serverKey(server));
        record(accountId, request, chat, toolName, 'tool_not_allowed', 200);
        return answer(
          rpcError(
            id,
            "This server's settings changed on that desktop, so the call was not run. Try again.",
          ),
        );
      }
      record(
        accountId,
        request,
        chat,
        toolName,
        decision,
        forwarded.answer.status,
      );
      return answer(forwarded.answer);
    },
  };
}
