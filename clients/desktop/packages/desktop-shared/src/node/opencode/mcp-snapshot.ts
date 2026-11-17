import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ListToolsResultSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { OpenCodeSchemaValidator } from './schema-validation';
import type { McpServer } from '@agentclientprotocol/sdk';
import {
  canonicalOpenCodeCapability,
  openCodeCapabilityDigest,
  type OpenCodeCapabilitySnapshot,
} from './capability-snapshot';
import { createOpenCodeDiscoveryFetch } from './discovery-fetch';
import {
  openCodeMcpNativeKey,
  resolveOpenCodeMcpSnapshotTool,
} from './mcp-tool-identity';

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/** Only host-brokered stdio routes may be inspected; the broker owns the process tree. */
export async function readOpenCodeMcpSnapshot(
  servers: readonly McpServer[],
  identities: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  brokerStdio: (
    server: Extract<McpServer, { command: string }>,
  ) => Promise<Extract<McpServer, { command: string }>>,
  /** The harness named in errors; Antigravity reuses this discovery. */
  label: 'OpenCode' | 'Antigravity' = 'OpenCode',
): Promise<OpenCodeCapabilitySnapshot['mcp']> {
  const snapshots: {
    name: string;
    identity: unknown;
    tools: readonly Tool[];
  }[] = [];
  if (servers.length > 64)
    throw new Error(`${label} has too many MCP servers selected.`);
  const responseLimit = new AbortController();
  const tableDeadline = AbortSignal.any([
    signal,
    responseLimit.signal,
    AbortSignal.timeout(60_000),
  ]);
  const discoveryFetch = createOpenCodeDiscoveryFetch(tableDeadline, (error) =>
    responseLimit.abort(error),
  );
  let catalogBytes = 2;
  for (const server of [...servers].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const deadline = AbortSignal.any([
      tableDeadline,
      AbortSignal.timeout(15_000),
    ]);
    deadline.throwIfAborted();
    const client = new Client({
      name: 'opencode-capability-snapshot',
      version: '1',
    });
    let transport: Transport | undefined;
    const close = (): void => {
      void client.close().catch(() => undefined);
    };
    deadline.addEventListener('abort', close, { once: true });
    try {
      if ('command' in server) {
        const route = await brokerStdio(server);
        deadline.throwIfAborted();
        transport = new StdioClientTransport({
          command: route.command,
          args: route.args,
          env: Object.fromEntries(
            route.env.map((entry) => [entry.name, entry.value]),
          ),
          stderr: 'ignore',
        });
      } else if (server.type === 'http' || server.type === 'sse') {
        const requestInit = {
          headers: Object.fromEntries(
            server.headers.map((entry) => [entry.name, entry.value]),
          ),
        };
        transport =
          server.type === 'sse'
            ? new SSEClientTransport(new URL(server.url), {
                requestInit,
                fetch: discoveryFetch,
              })
            : new StreamableHTTPClientTransport(new URL(server.url), {
                requestInit,
                fetch: discoveryFetch,
              });
      }
      if (!transport) throw new Error(`${label} MCP transport is unavailable.`);
      deadline.throwIfAborted();
      // The SDK does not pass connect's signal to transport.start(). In
      // particular, closing silent SSE never settles its endpoint handshake.
      let abortHandshake: (() => void) | undefined;
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          abortHandshake = (): void => {
            const reason: unknown = deadline.reason;
            reject(
              reason instanceof Error
                ? reason
                : new Error('MCP discovery handshake aborted.'),
            );
          };
          deadline.addEventListener('abort', abortHandshake, { once: true });
          if (deadline.aborted) abortHandshake();
        });
        await Promise.race([
          client.connect(transport, { signal: deadline, timeout: 15_000 }),
          aborted,
        ]);
        deadline.throwIfAborted();
      } finally {
        if (abortHandshake)
          deadline.removeEventListener('abort', abortHandshake);
      }
      const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        // This client only discovers metadata; it never calls tools. listTools()
        // also compiles output schemas synchronously for later calls. Keep the
        // SDK's result validation without entering that untrusted compiler path.
        const page = await client.request(
          { method: 'tools/list', params: cursor ? { cursor } : {} },
          ListToolsResultSchema,
          { signal: deadline, timeout: 15_000 },
        );
        deadline.throwIfAborted();
        if (tools.length + page.tools.length > 5000)
          throw new Error(`${label} MCP tool catalog exceeds the size limit.`);
        for (const tool of page.tools) {
          catalogBytes +=
            Buffer.byteLength(canonicalOpenCodeCapability(tool)) + 1;
          if (catalogBytes > MAX_CATALOG_BYTES)
            throw new Error(
              `${label} MCP tool catalog exceeds the size limit.`,
            );
        }
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && (cursors.has(cursor) || cursors.size >= 100))
          throw new Error(`${label} MCP tool catalog pagination is invalid.`);
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const names = new Set<string>();
      for (const tool of tools) {
        if (names.has(tool.name))
          throw new Error(`${label} MCP tool names are ambiguous.`);
        names.add(tool.name);
      }
      tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      snapshots.push({
        name: server.name,
        identity: identities[server.name] ?? {
          name: server.name,
          transport: 'command' in server ? 'stdio' : server.type,
        },
        tools,
      });
      // Also include host identities and catalog structure in the final bound.
      openCodeCapabilityDigest(snapshots);
    } catch {
      signal.throwIfAborted();
      throw new Error(
        `${label} could not check the tools for ${server.name}. Reconnect the server and try again.`,
      );
    } finally {
      deadline.removeEventListener('abort', close);
      await client.close();
      await transport?.close();
    }
  }
  return snapshots;
}

/** An unlisted tool or a call outside the captured input contract is denied. */
export async function openCodeMcpCallMatchesSnapshot(
  snapshot: OpenCodeCapabilitySnapshot['mcp'],
  server: string,
  name: string,
  input: unknown,
  validation: { validate: OpenCodeSchemaValidator; signal: AbortSignal },
): Promise<boolean> {
  const match = resolveOpenCodeMcpSnapshotTool(
    snapshot,
    openCodeMcpNativeKey(server, name),
  );
  // The host/proxy must use the original catalog identity, not an unlisted alias.
  return (
    !!match &&
    match.server === server &&
    match.tool.name === name &&
    (await validation.validate(
      match.tool.inputSchema,
      input,
      validation.signal,
    ))
  );
}
