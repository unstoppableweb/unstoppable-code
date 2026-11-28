import { createServer, type AddressInfo } from 'node:net';
import type { BrowserWindow } from 'electron';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import type * as IntegrationHttp from '../integration-http';

jest.mock('../../canopy-tools/core', () => ({
  executeCanopyInjectedTool: jest.fn(),
}));
jest.mock('../../canopy-tools/show-files-runtime', () => ({
  requestShowFiles: (): never => {
    throw new Error('window touched');
  },
  mainWindowOnlyToolSurfaces: (): never => {
    throw new Error('window touched');
  },
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: (): never => {
    throw new Error('window touched');
  },
}));
// Pass-through, so a test can hold a request while its body is read.
jest.mock('../integration-http', () => {
  const actual = jest.requireActual<typeof IntegrationHttp>(
    '../integration-http',
  );
  return { ...actual, readRequestBody: jest.fn(actual.readRequestBody) };
});
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (): string => '/worktree',
}));
jest.mock('../../canopy-tools/session-runtime', () => ({
  ...jest.requireActual<object>('../../canopy-tools/session-runtime'),
  requestAnswersFromRenderer: (): never => {
    throw new Error('window touched');
  },
  respondToFileCommentInSession: jest.fn(),
}));

import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  type CanopyInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import { executeCanopyInjectedTool } from '../../canopy-tools/core';
import { respondToFileCommentInSession } from '../../canopy-tools/session-runtime';
import { ledgerUnavailableResult } from '../../canopy-tools/ledger-tools-runtime';
import { CODE_GRAPH_UNAVAILABLE_MESSAGE } from '../../lib/code-graph-availability';
import {
  CanopyToolRouter,
  type CanopyWorktreeSessionRoute,
} from '../canopy-tool-router';
import { toMcpToolResult } from '../canopy-route-tools';
import type { InterfaceToolRequests } from '../interface-tool-requests';
import { McpHttpProxyService } from '../http-proxy-service';
import { readRequestBody } from '../integration-http';
import { canopyRouteFixtures } from './helpers/canopy-route-fixtures';

const sentinelWindow = { sentinel: true } as unknown as BrowserWindow;

function fakeInterface(): InterfaceToolRequests & {
  calls: { method: string; request: unknown }[];
} {
  const calls: { method: string; request: unknown }[] = [];
  return {
    calls,
    requestUserAnswers: (request) => {
      calls.push({ method: 'requestUserAnswers', request });
      return Promise.resolve([]);
    },
    showFiles: (request) => {
      calls.push({ method: 'showFiles', request });
      return Promise.resolve({ ok: true }) as unknown as ReturnType<
        InterfaceToolRequests['showFiles']
      >;
    },
    legacyWindow: () => {
      calls.push({ method: 'legacyWindow', request: null });
      return sentinelWindow;
    },
  };
}

function fixture(
  name: string,
  overrides: Partial<CanopyWorktreeSessionRoute> = {},
): CanopyWorktreeSessionRoute {
  const route = canopyRouteFixtures().find(
    (candidate) => candidate.sessionKey === `k-${name}`,
  );
  if (!route) throw new Error(`no fixture ${name}`);
  return { ...route, ...overrides };
}

const displayName = (key: CanopyInjectedToolKey): string =>
  CANOPY_INJECTED_TOOL_REGISTRY[key].displayName;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === 'object' && address ? address.port : 0;
}

describe('Canopy tool router (CAN-4125)', () => {
  const execute = jest.mocked(executeCanopyInjectedTool);

  beforeEach(() => {
    execute.mockReset();
    jest.mocked(respondToFileCommentInSession).mockReset();
  });

  it('presentation calls go through the interface port and nothing else touches a window', async () => {
    const port = fakeInterface();
    const router = new CanopyToolRouter({ interfaceRequests: port });
    execute.mockImplementation(
      async (key, _args, runtime: CanopyInjectedToolRuntime) => {
        if (key === 'ask_user_question')
          await runtime.requestUserAnswers?.([], {});
        if (key === 'show_files') await runtime.showFiles?.([]);
        if (key === 'respond_to_file_comment')
          await runtime.respondToFileComment?.({
            threadId: 't',
            body: 'b',
            resolve: false,
          });
        return { text: 'ok' };
      },
    );
    let seenWindow: unknown;
    jest.mocked(respondToFileCommentInSession).mockImplementation((request) => {
      seenWindow = request.getWindow?.();
      return Promise.resolve({ ok: true, text: '' }) as unknown as ReturnType<
        typeof respondToFileCommentInSession
      >;
    });

    const route = fixture('native-sdk-full');
    const answer1 = await router.callTool(route, {
      id: 1,
      params: { name: displayName('ask_user_question'), arguments: {} },
      uiServer: true,
    });
    const ask = port.calls.filter((c) => c.method === 'requestUserAnswers');
    expect(ask).toHaveLength(1);
    expect(ask[0]?.request).toMatchObject({
      sessionKey: route.sessionKey,
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      questions: [],
    });
    expect(ask[0]?.request).not.toHaveProperty('getWindow');
    expect(answer1.result).toEqual(toMcpToolResult({ text: 'ok' }));

    const answer2 = await router.callTool(route, {
      id: 2,
      params: { name: displayName('show_files'), arguments: {} },
      uiServer: false,
    });
    const show = port.calls.filter((c) => c.method === 'showFiles');
    expect(show).toHaveLength(1);
    expect(show[0]?.request).toEqual({
      files: [],
      target: { projectId: 'p', worktreeId: 'w' },
      origin: { projectId: 'p', worktreeId: 'w', chatTabId: 'c' },
      cwd: '/worktree',
    });
    expect(answer2.result).toEqual(toMcpToolResult({ text: 'ok' }));

    const answer3 = await router.callTool(route, {
      id: 3,
      params: { name: displayName('respond_to_file_comment'), arguments: {} },
      uiServer: false,
    });
    expect(answer3.result).toEqual(toMcpToolResult({ text: 'ok' }));
    expect(seenWindow).toBe(sentinelWindow);
  });

  it('a denied or unexposed tool runs nothing', async () => {
    const router = new CanopyToolRouter({ interfaceRequests: fakeInterface() });
    const call = (
      route: CanopyWorktreeSessionRoute,
      name: string,
    ): Promise<Record<string, unknown>> =>
      router.callTool(route, {
        id: 9,
        params: { name, arguments: {} },
        uiServer: false,
      });

    const denied = await call(
      fixture('native-sdk-full', {
        authorizeToolCall: () => Promise.resolve(false),
      }),
      displayName('get_script_output'),
    );
    expect(denied.result).toEqual(
      toMcpToolResult({
        text: `${displayName('get_script_output')} was denied.`,
        isError: true,
      }),
    );

    expect(
      await call(fixture('cursor-acp-full'), displayName('query_code_graph')),
    ).toMatchObject({ error: { code: -32602 } });
    expect(
      await call(fixture('worker-none'), displayName('save_memory')),
    ).toMatchObject({ error: { code: -32602 } });
    // Only a pipeline agent route whose host set the field has the action
    // tools (CAN-7742).
    for (const name of ['worker-rw-ledger', 'worker-ro-pipeline-agent'])
      for (const key of ['search_actions', 'dispatch_action'] as const)
        expect(await call(fixture(name), displayName(key))).toMatchObject({
          error: { code: -32602 },
        });
    expect(
      (await call(fixture('native-sdk-bare'), displayName('add_ledger_entry')))
        .result,
    ).toEqual(toMcpToolResult(ledgerUnavailableResult('no_ledger_scope')));
    expect(
      (await call(fixture('native-sdk-bare'), displayName('query_code_graph')))
        .result,
    ).toEqual(
      toMcpToolResult({ text: CODE_GRAPH_UNAVAILABLE_MESSAGE, isError: true }),
    );
    expect(
      (
        await call(
          fixture('delegate-exclusive'),
          displayName('get_script_output'),
        )
      ).result,
    ).toEqual(
      toMcpToolResult({
        text: 'This tool is not available to this delegated task.',
        isError: true,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('the session server answers only initialize, tools/list and tools/call', async () => {
    const service = new McpHttpProxyService();
    await service.ensureStarted(await freePort());
    try {
      const route = fixture('native-sdk-full');
      await service.registerCanopyWorktreeSessionRoute(route);
      const post = (
        url: string,
        body: unknown,
        token = route.authToken,
      ): Promise<Response> =>
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        });
      const url = service.getCanopyWorktreeMcpUrl(route.sessionKey);

      const unknown = await post(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/list',
      });
      expect(await unknown.json()).toMatchObject({
        error: { code: -32601, message: 'Method not found' },
      });
      expect(
        (await post(url, { jsonrpc: '2.0', method: 'tools/list' })).status,
      ).toBe(204);
      expect(
        (await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'x'))
          .status,
      ).toBe(401);
      const missing = await post(service.getCanopyWorktreeMcpUrl('k-missing'), {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: -32004 } });
    } finally {
      await service.shutdown();
    }
  }, 60_000);

  it('SaveMemory carries the provider invocation id, so a replay keys the same save (CAN-5993)', async () => {
    const router = new CanopyToolRouter({ interfaceRequests: fakeInterface() });
    execute.mockResolvedValue({ text: 'ok' });
    const route = fixture('native-sdk-full');
    for (const id of [1, 2])
      await router.callTool(route, {
        id,
        params: {
          name: displayName('save_memory'),
          arguments: { text: 'x', scope: 'user' },
          _meta: { 'claudecode/toolUseId': 'toolu_9' },
        },
        uiServer: false,
      });
    expect(
      execute.mock.calls.map(([key, , , context]) => [
        key,
        context?.invocationId,
      ]),
    ).toEqual([
      ['save_memory', 'claude:toolu_9'],
      ['save_memory', 'claude:toolu_9'],
    ]);
  });

  it.each([['native-sdk-full'], ['advisor-claude']])(
    'SetAutoArchive carries the provider invocation id on %s, so a retry keys the same write (CAN-6014)',
    async (routeName) => {
      const router = new CanopyToolRouter({
        interfaceRequests: fakeInterface(),
      });
      execute.mockResolvedValue({ text: 'ok' });
      const route = fixture(
        routeName,
        routeName === 'advisor-claude'
          ? {
              appAdvisorRuntime: {
                rememberInterfaceTools: (): void => undefined,
              } as unknown as CanopyWorktreeSessionRoute['appAdvisorRuntime'],
            }
          : {},
      );
      for (const id of [1, 2])
        await router.callTool(route, {
          id,
          params: {
            name: displayName('set_auto_archive'),
            arguments: { enabled: true },
            _meta: { 'claudecode/toolUseId': 'toolu_7' },
          },
          uiServer: false,
        });
      expect(
        execute.mock.calls.map(([key, , , context]) => [
          key,
          context?.invocationId,
        ]),
      ).toEqual([
        ['set_auto_archive', 'claude:toolu_7'],
        ['set_auto_archive', 'claude:toolu_7'],
      ]);
    },
  );

  it.each([
    [{ type: 'pipeline.run', pipelineId: 'p' }],
    [{ type: 'hook.pause', all: true }],
    [{ type: 'hook.resume', hookKey: 'h' }],
    [{ type: 'worktree.run_script', scriptId: 'test' }],
    [{ type: 'pipeline.execution_cancel', executionId: 'e' }],
    [{ type: 'pipeline.execution_resume', executionId: 'e' }],
    [{ type: 'pull_request.review.publish', pullRequest: 'o/r#1' }],
  ])(
    'a worktree chat keys %o by the provider tool_use id, never the per-connection request id (CAN-5830)',
    async (action) => {
      const router = new CanopyToolRouter({
        interfaceRequests: fakeInterface(),
      });
      execute.mockResolvedValue({ text: 'ok' });
      const route = fixture('native-sdk-full');
      const call = (
        id: number,
        meta?: Record<string, string>,
      ): ReturnType<CanopyToolRouter['callTool']> =>
        router.callTool(route, {
          id,
          params: {
            name: displayName('dispatch_action'),
            arguments: { action },
            ...(meta ? { _meta: meta } : {}),
          },
          uiServer: false,
        });
      // A reconnect in the same turn restarts request ids: request 1 again
      // is a new call when the provider's tool_use id differs.
      await call(1, { 'claudecode/toolUseId': 'toolu_a' });
      await call(1, { 'claudecode/toolUseId': 'toolu_b' });
      // A retry after session recovery resends the tool_use id under a new
      // request id, so it keys the same call.
      await call(5, { 'claudecode/toolUseId': 'toolu_a' });
      // Without a tool_use id the registration's own id stands in.
      await call(1);
      const ids = execute.mock.calls.map(
        ([, , , context]) => context?.toolUseId,
      );
      expect(ids.slice(0, 3)).toEqual(['toolu_a', 'toolu_b', 'toolu_a']);
      expect(ids[3]).toMatch(/^[0-9a-f-]+:1$/);
    },
  );

  const postMcp = (
    service: McpHttpProxyService,
    route: CanopyWorktreeSessionRoute,
    body: unknown,
    ui = false,
  ): Promise<Response> =>
    fetch(
      ui
        ? service.getCanopyWorktreeUiMcpUrl(route.sessionKey)
        : service.getCanopyWorktreeMcpUrl(route.sessionKey),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${route.authToken}`,
        },
        body: JSON.stringify(body),
      },
    );
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize' };

  // Initialize, then a keyed write with no provider tool_use id (CAN-4169).
  const keyedWriteSession = async (
    service: McpHttpProxyService,
    route: CanopyWorktreeSessionRoute,
    { ui = false, callId = 2 } = {},
  ): Promise<Response> => {
    const initialized = await postMcp(service, route, initialize, ui);
    await postMcp(service, route, {
      jsonrpc: '2.0',
      id: callId,
      method: 'tools/call',
      params: {
        name: displayName('dispatch_action'),
        arguments: { action: { type: 'pipeline.run', pipelineId: 'p' } },
      },
    }).then((response) => response.text());
    return initialized;
  };
  const keyedToolUseIds = (): (string | undefined)[] =>
    execute.mock.calls.map(([, , , context]) => context?.toolUseId);

  it('a re-initialized session restarts its request ids under a new key, so a repeated write is not replayed (CAN-4169)', async () => {
    execute.mockResolvedValue({ text: 'ok' });
    const service = new McpHttpProxyService();
    await service.ensureStarted(await freePort());
    try {
      const route = fixture('native-sdk-full');
      await service.registerCanopyWorktreeSessionRoute(route);
      await keyedWriteSession(service, route);
      await keyedWriteSession(service, route);
      const ids = keyedToolUseIds();
      expect(ids).toHaveLength(2);
      expect(ids[0]).toMatch(/^[0-9a-f-]+:2$/);
      expect(ids[1]).toMatch(/^[0-9a-f-]+:2$/);
      expect(ids[1]).not.toBe(ids[0]);
    } finally {
      await service.shutdown();
    }
  }, 60_000);

  it('the UI server initializing on the shared route keeps the main server key (CAN-4169)', async () => {
    execute.mockResolvedValue({ text: 'ok' });
    const service = new McpHttpProxyService();
    await service.ensureStarted(await freePort());
    try {
      const route = fixture('native-sdk-full');
      await service.registerCanopyWorktreeSessionRoute(route);
      await keyedWriteSession(service, route);
      const uiInitialized = await keyedWriteSession(service, route, {
        ui: true,
        callId: 3,
      });
      expect(uiInitialized.status).toBe(200);
      expect(await uiInitialized.text()).toMatch(
        /"serverInfo":\{"name":"[^"]+_ui"/,
      );
      const ids = keyedToolUseIds();
      expect(ids).toHaveLength(2);
      expect(ids[0]).toMatch(/^[0-9a-f-]+:2$/);
      expect(ids[1]).toBe(String(ids[0]).replace(/:2$/, ':3'));
    } finally {
      await service.shutdown();
    }
  }, 60_000);

  it('a call whose body is still arriving when the session re-initializes keeps the nonce it arrived with (CAN-4169)', async () => {
    execute.mockResolvedValue({ text: 'ok' });
    const { readRequestBody: read } = jest.requireActual<
      typeof IntegrationHttp
    >('../integration-http');
    let reading = (): void => {};
    const bodyReading = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let arrive = (): void => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const service = new McpHttpProxyService();
    await service.ensureStarted(await freePort());
    try {
      const route = fixture('native-sdk-full');
      await service.registerCanopyWorktreeSessionRoute(route);
      await keyedWriteSession(service, route);
      // Hold the next request, the call, while its body is read.
      jest.mocked(readRequestBody).mockImplementationOnce(async (req) => {
        reading();
        await arrived;
        return read(req);
      });
      const call = postMcp(service, route, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: displayName('dispatch_action'),
          arguments: { action: { type: 'pipeline.run', pipelineId: 'p' } },
        },
      }).then((response) => response.text());
      await bodyReading;
      expect((await postMcp(service, route, initialize)).status).toBe(200);
      arrive();
      await call;
      const ids = keyedToolUseIds();
      expect(ids).toHaveLength(2);
      expect(ids[0]).toMatch(/^[0-9a-f-]+:2$/);
      expect(ids[1]).toBe(String(ids[0]).replace(/:2$/, ':3'));
    } finally {
      await service.shutdown();
    }
  }, 60_000);

  it('a watcher call retried after a re-initialize keeps its Claude tool_use id, so it dedupes (CAN-4169)', async () => {
    execute.mockResolvedValue({ text: 'ok' });
    const service = new McpHttpProxyService();
    await service.ensureStarted(await freePort());
    try {
      const route = fixture('native-sdk-full');
      await service.registerCanopyWorktreeSessionRoute(route);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await postMcp(service, route, initialize).then((r) => r.text());
        await postMcp(service, route, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: displayName('watch_command'),
            arguments: { command: 'true', intervalSeconds: 5, maxAttempts: 1 },
            _meta: { 'claudecode/toolUseId': 'toolu_watch' },
          },
        }).then((r) => r.text());
      }
      expect(keyedToolUseIds()).toEqual(['toolu_watch', 'toolu_watch']);
    } finally {
      await service.shutdown();
    }
  }, 60_000);

  it.each([
    [
      'App Advisor',
      'advisor-claude',
      'StartForkedAgent',
      { followUpInstruction: 'go' },
    ],
    ['Pipeline Editor', 'pipeline-editor', 'CreatePipeline', {}],
  ] as const)(
    'on a %s route, a call still running when the session re-initializes delivers its result under the id it was dispatched with (CAN-4169)',
    async (_kind, name, tool, args) => {
      const delivered: string[] = [];
      const dispatched: (string | undefined)[] = [];
      let release = (): void => {};
      let onStart = (): void => {};
      const hold = (): Promise<unknown> =>
        new Promise((resolve) => {
          release = (): void => resolve({ ok: true });
          onStart();
        });
      // Resolves when the call reaches the held tool; fails with its answer if
      // the call is answered first (an unknown tool or runtime error).
      const reachesTool = (call: Promise<string>): Promise<void> =>
        Promise.race([
          new Promise<void>((resolve) => {
            onStart = resolve;
          }),
          call.then((text) => {
            throw new Error(`answered before running: ${text}`);
          }),
        ]);
      const route = fixture(name, {
        appAdvisorRuntime: {
          rememberInterfaceTools: (): void => undefined,
          startForkedAgent: hold,
        } as unknown as CanopyWorktreeSessionRoute['appAdvisorRuntime'],
        pipelineEditorRuntime: {
          dispatchEditorAction: (
            _action: unknown,
            toolUseId?: string,
          ): Promise<unknown> => {
            dispatched.push(toolUseId);
            return hold();
          },
        } as unknown as CanopyWorktreeSessionRoute['pipelineEditorRuntime'],
        nativeToolResultDelivery: ({ toolUseId }) => {
          delivered.push(toolUseId);
        },
      });
      const service = new McpHttpProxyService();
      await service.ensureStarted(await freePort());
      const call = (id: number): Promise<string> =>
        postMcp(service, route, {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }).then((response) => response.text());
      try {
        await service.registerCanopyWorktreeSessionRoute(route);
        await postMcp(service, route, initialize).then((r) => r.text());
        const first = call(2);
        await reachesTool(first);
        release();
        await first;
        const second = call(3);
        await reachesTool(second);
        // The session re-initializes while the second call is still running.
        expect((await postMcp(service, route, initialize)).status).toBe(200);
        release();
        await second;
        expect(delivered).toHaveLength(2);
        expect(delivered[0]).toMatch(/^[0-9a-f-]+:2$/);
        expect(delivered[1]).toBe(String(delivered[0]).replace(/:2$/, ':3'));
        // Only the editor hands its dispatch id to the runtime.
        expect(dispatched).toEqual(name === 'pipeline-editor' ? delivered : []);
      } finally {
        await service.shutdown();
      }
    },
    60_000,
  );

  it.each([['worker-rw-pipeline-agent'], ['ledger-subprocess-pipeline-agent']])(
    'a pipeline agent route %s runs the action tools restricted to posting a review, for its execution (CAN-7742)',
    async (name) => {
      const router = new CanopyToolRouter({
        interfaceRequests: fakeInterface(),
      });
      execute.mockResolvedValue({ text: 'ok' });
      const route = fixture(name);
      for (const [key, args] of [
        ['search_actions', {}],
        // Any other type still reaches the runtime, whose allowed types
        // make the engine refuse it.
        [
          'dispatch_action',
          { action: { type: 'pipeline.run', pipelineId: 'p' } },
        ],
        [
          'dispatch_action',
          {
            action: { type: 'pull_request.review.publish' },
            executionId: 'forged',
          },
        ],
      ] as const)
        await router.callTool(route, {
          id: 3,
          params: { name: displayName(key), arguments: args },
          uiServer: false,
        });
      expect(execute).toHaveBeenCalledTimes(3);
      for (const [, , runtime] of execute.mock.calls) {
        expect(runtime.worktreeActionRuntime).toMatchObject({
          projectId: 'p',
          worktreeId: 'w',
          // Never the route's own chat: the calls run under no real chat.
          chatId: 'pipeline:e',
          allowedActionTypes: ['pull_request.review.publish'],
          pipelineExecutionId: 'e',
        });
        expect(runtime.worktreeActionRuntime?.getWindow()).toBeNull();
        expect(runtime.worktreeWatcherRuntime).toBeUndefined();
      }
    },
  );

  it('tool-use ids keep their per-route forms', () => {
    const router = new CanopyToolRouter({ interfaceRequests: fakeInterface() });
    const worktree = fixture('native-sdk-full');
    expect(router.routeToolUseId(worktree, 7, undefined)).toBe('7');

    const advisor = fixture('advisor-claude');
    expect(
      router.routeToolUseId(advisor, 7, { 'claudecode/toolUseId': 'toolu_1' }),
    ).toBe('toolu_1');
    const first = router.routeToolUseId(advisor, 7, undefined);
    expect(first).toMatch(/^[0-9a-f-]+:7$/);
    expect(router.routeToolUseId(advisor, 8, undefined)).toBe(
      `${first.split(':')[0] ?? ''}:8`,
    );
    const other = fixture('advisor-cursor');
    expect(router.routeToolUseId(other, 7, undefined)).not.toBe(first);
  });
});
