import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';

jest.mock('../../lib/chat-visuals-feature-flag', () => ({
  chatVisualsEligible: ({ providerType }: { providerType?: string }): boolean =>
    providerType === 'claude',
}));

import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import { McpHttpProxyService } from '../http-proxy-service';
import { listCanopyRouteTools } from '../canopy-route-tools';
import { canopyRouteFixtures } from './helpers/canopy-route-fixtures';

type ListedTools = Record<string, { main: unknown; ui: unknown }>;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  return value;
}

/** Each listed tool as its name and the SHA-256 of its canonical name, description and schema. */
function digests(tools: unknown): unknown {
  return Array.isArray(tools)
    ? tools.map((tool: unknown) => [
        typeof tool === 'object' && tool !== null && 'name' in tool
          ? tool.name
          : null,
        createHash('sha256')
          .update(JSON.stringify(sortKeys(tool)))
          .digest('hex'),
      ])
    : tools;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === 'object' && address ? address.port : 0;
}

async function listOverHttp(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'result' in body
    ? (body.result as { tools: unknown }).tools
    : body;
}

describe('Canopy route tools (CAN-4125)', () => {
  const golden: unknown = JSON.parse(
    readFileSync(
      join(__dirname, '__golden__', 'canopy-route-tools.golden.json'),
      'utf8',
    ),
  );
  let listed: ListedTools;

  beforeAll(async () => {
    const service = new McpHttpProxyService();
    await service.ensureStarted(await freePort());
    listed = {};
    try {
      for (const route of canopyRouteFixtures()) {
        await service.registerCanopyWorktreeSessionRoute(route);
        listed[route.sessionKey.slice(2)] = {
          main: await listOverHttp(
            service.getCanopyWorktreeMcpUrl(route.sessionKey),
            route.authToken,
          ),
          ui: await listOverHttp(
            service.getCanopyWorktreeUiMcpUrl(route.sessionKey),
            route.authToken,
          ),
        };
      }
    } finally {
      await service.shutdown();
    }
  }, 120_000);

  it('every session route lists exactly the golden tools', () => {
    expect(
      Object.fromEntries(
        Object.keys(listed)
          .sort()
          .map((name) => [
            name,
            {
              main: digests(listed[name]?.main),
              ui: digests(listed[name]?.ui),
            },
          ]),
      ),
    ).toEqual(golden);
  });

  it('leaves room for selected MCP servers in Antigravity chats', () => {
    for (const route of canopyRouteFixtures().filter(
      (r) => r.providerType === 'antigravity',
    )) {
      const tools = [
        ...listCanopyRouteTools(route, false),
        ...listCanopyRouteTools(route, true),
      ];
      // agy can drop a large tool even when the combined catalog fits.
      // Both limits are regression budgets for our side of the wire.
      expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThan(32 * 1024);
      expect(
        tools
          .filter((t) => Buffer.byteLength(JSON.stringify(t)) >= 1280)
          .map((t) => t.name),
      ).toEqual([]);
      expect(
        tools.find((t) => t.name === 'DispatchAction')?.inputSchema,
      ).toMatchObject({
        properties: { action: { additionalProperties: true } },
      });
      expect(
        tools.find((t) => t.name === 'SetupWatchers')?.inputSchema,
      ).toMatchObject({
        properties: {
          watchers: {
            items: {
              properties: {
                target: {
                  additionalProperties: true,
                  properties: {
                    runOn: { type: 'string', enum: ['local', 'cloud'] },
                  },
                },
              },
            },
          },
        },
      });
    }
  });

  // set_work_entry_auto_delete removes the caller's whole work entry, so a
  // managed delegate never lists it even though its listing falls back to the
  // terminal set; root chats in worktrees, Cowork and Orchestrator do.
  it('only root chat routes list SetWorkEntryAutoDelete', () => {
    const name =
      CANOPY_INJECTED_TOOL_REGISTRY.set_work_entry_auto_delete.displayName;
    const lists = (route: string): boolean =>
      JSON.stringify(listed[route]?.main).includes(`"name":"${name}"`);
    expect(lists('managed-delegate-full')).toBe(false);
    expect(lists('managed-delegate-bare')).toBe(false);
    expect(lists('delegate-exclusive')).toBe(false);
    expect(lists('native-sdk-full')).toBe(true);
    expect(lists('native-sdk-standalone-full')).toBe(true);
    expect(lists('advisor-claude')).toBe(true);
  });

  it("the listing function is the session server's listing", () => {
    for (const route of canopyRouteFixtures()) {
      const http = listed[route.sessionKey.slice(2)];
      expect({
        main: listCanopyRouteTools(route, false),
        ui: listCanopyRouteTools(route, true),
      }).toEqual(http);
    }
  });
});
