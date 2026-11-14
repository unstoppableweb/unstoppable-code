/**
 * Paging through an MCP server's `tools/list`, shared by every transport the
 * desktop probes (HTTP discovery and the stdio connection test), so both
 * apply the same limits and validation.
 */

export const MCP_DISCOVERY_MAX_TOOLS = 10_000;
export const MCP_DISCOVERY_MAX_TOOL_NAME_BYTES = 1024;
export const MCP_DISCOVERY_MAX_TOOL_PAGES = 100;
export const MCP_DISCOVERY_MAX_TOOLS_DURATION_MS = 60_000;

export class McpToolDiscoveryError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'invalid'
      | 'timeout'
      | 'network'
      | 'auth'
      | 'http'
      | 'rpc'
      | 'tools-http',
    readonly phase: 'initialize' | 'tools',
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'McpToolDiscoveryError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface McpToolsPage {
  /** The JSON-RPC response, or null when the transport returned none. */
  readonly message: Readonly<Record<string, unknown>> | null;
  readonly responseBytes: number;
}

/**
 * Requests one `tools/list` page. `id` is the JSON-RPC request id and
 * `timeoutMs` the time left before the listing's deadline.
 */
export type McpToolsPageRequest = (
  request: { jsonrpc: '2.0'; id: number; method: 'tools/list'; params: object },
  timeoutMs: number,
) => Promise<McpToolsPage>;

/**
 * Lists an initialized MCP server's tool names, following `nextCursor` within
 * the page, tool, name, byte and duration limits.
 */
export async function listMcpToolNames(
  requestPage: McpToolsPageRequest,
  maxResponseBytes: number,
): Promise<string[]> {
  const toolNames: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let requestId = 2;
  let totalResponseBytes = 0;
  let pageCount = 0;
  const toolsDeadline = Date.now() + MCP_DISCOVERY_MAX_TOOLS_DURATION_MS;
  do {
    if (
      pageCount >= MCP_DISCOVERY_MAX_TOOL_PAGES ||
      Date.now() >= toolsDeadline
    ) {
      throw new McpToolDiscoveryError(
        'MCP tools pagination exceeded its request or duration limit',
        'timeout',
        'tools',
      );
    }
    pageCount += 1;
    const page = await requestPage(
      {
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/list',
        params: cursor ? { cursor } : {},
      },
      Math.min(10_000, Math.max(1, toolsDeadline - Date.now())),
    );
    requestId += 1;
    totalResponseBytes += page.responseBytes;
    if (totalResponseBytes > maxResponseBytes) {
      throw new McpToolDiscoveryError(
        `MCP tools responses exceed ${String(maxResponseBytes)} bytes`,
        'invalid',
        'tools',
      );
    }
    const toolsData = page.message ?? {};
    if (toolsData.error) {
      const rpcError = toolsData.error;
      throw new McpToolDiscoveryError(
        isRecord(rpcError) && typeof rpcError.message === 'string'
          ? rpcError.message
          : JSON.stringify(rpcError),
        'rpc',
        'tools',
      );
    }
    if (!('result' in toolsData)) {
      throw new McpToolDiscoveryError(
        'Invalid MCP tools response — missing result or error field',
        'invalid',
        'tools',
      );
    }
    const result = toolsData.result;
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new McpToolDiscoveryError(
        'Invalid MCP tools response — missing tools array',
        'invalid',
        'tools',
      );
    }
    const tools = result.tools;
    if (toolNames.length + tools.length > MCP_DISCOVERY_MAX_TOOLS) {
      throw new McpToolDiscoveryError(
        `MCP tools response exceeds ${String(MCP_DISCOVERY_MAX_TOOLS)} tools`,
        'invalid',
        'tools',
      );
    }
    toolNames.push(
      ...tools.map((tool) => {
        const name =
          isRecord(tool) && typeof tool.name === 'string' ? tool.name : '';
        if (Buffer.byteLength(name) > MCP_DISCOVERY_MAX_TOOL_NAME_BYTES) {
          throw new McpToolDiscoveryError(
            `MCP tool name exceeds ${String(MCP_DISCOVERY_MAX_TOOL_NAME_BYTES)} bytes`,
            'invalid',
            'tools',
          );
        }
        return name;
      }),
    );
    const nextCursor = result.nextCursor;
    if (nextCursor === undefined || nextCursor === null) {
      cursor = undefined;
    } else if (typeof nextCursor !== 'string' || nextCursor.length === 0) {
      throw new McpToolDiscoveryError(
        'Invalid MCP tools response — nextCursor must be a non-empty string',
        'invalid',
        'tools',
      );
    } else if (seenCursors.has(nextCursor)) {
      throw new McpToolDiscoveryError(
        'Invalid MCP tools response — repeated nextCursor',
        'invalid',
        'tools',
      );
    } else {
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } while (cursor);
  return toolNames.filter((name) => name.length > 0);
}
