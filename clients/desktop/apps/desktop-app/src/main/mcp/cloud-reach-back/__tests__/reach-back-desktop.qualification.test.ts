/**
 * Reach-back on the desktop (CAN-6176 PR 7a): the allow list and call log
 * main keeps per account, and the Q3 approval. Pins that a turned-off server
 * stops serving before anything else, that an account's entries go when it
 * signs out, that the log keeps the last 200 calls with no arguments, and
 * that the prompt is never skipped: not by a saved "always allow" for the
 * same tool, and that it denies with no window or after its timeout. And
 * that a request is served only for an allowed server, with `tools/list`
 * filtered and `tools/call` gated, asked about and logged; that a body this
 * desktop can't read is refused, never forwarded; that a call whose server
 * was turned off while it was asked about doesn't run; that the flag starts
 * and stops serving; that no call is logged after its account signs out;
 * and that a call is forwarded only on the config as it is now, never
 * through a route built before an edit, a disable or a deletion.
 */
import type { ApprovalCheck, ApprovalRule } from '@canopy/desktop-shared/types';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../../../approvals/approval-service';
import { requestApprovalDecision } from '../../../approvals/prompt-bridge';
import type * as PromptBridge from '../../../approvals/prompt-bridge';
import type { SendableBrowserWindow } from '../../../lib/window-send';
import {
  ACTIVITY_LIMIT,
  createReachBackActivityLog,
  type ReachBackActivityEntry,
} from '../activity-log';
import {
  createReachBackAllowList,
  forgetSignedOutAccounts,
  type ReachBackServer,
} from '../allow-list';
import {
  argumentSummary,
  createReachBackApprover,
  type ReachBackApprovalDecision,
  type ReachBackApprover,
} from '../approval';
import { createReachBackServer, type ReachBackForwarder } from '../serve';
import { createReachBackHttpForwarder } from '../http-forwarder';
import { acknowledgedItems } from '../stream-credit';
import { createReachBackController } from '../controller';
import { createReachBackService, type ReachBackSession } from '../service';
import type {
  McpHostRequest,
  McpHostRequestRespondParams,
  McpHostRequestsItem,
} from '@canopy/protocol/canopy-core';
import type { ReachBackAllowList } from '../allow-list';
import type { McpServerFile } from '@canopy/execution-engine/types/mcp-servers';

jest.mock('../../../approvals/prompt-bridge', (): unknown => {
  const actual: typeof PromptBridge = jest.requireActual(
    '../../../approvals/prompt-bridge',
  );
  return {
    ApprovalRequestEndedError: actual.ApprovalRequestEndedError,
    requestApprovalDecision: jest.fn(),
  };
});

/** A saved global "always allow" for the real tool a cloud chat calls. */
const SAVED_ALLOW: ApprovalRule = {
  id: 'always-create-issue',
  behavior: 'allow',
  target: { kind: 'tool', toolName: 'create_issue' },
  createdAt: '2026-11-01T00:00:00.000Z',
  origin: 'prompt',
};

jest.mock('../../../lib/approvals-persistence', (): unknown => ({
  readWorkspaceApprovals: (): Promise<unknown> =>
    Promise.resolve({ version: 1, rules: [] }),
  readWorkspaceApprovalsResult: (): Promise<unknown> =>
    Promise.resolve({ file: { version: 1, rules: [] }, status: 'ok' }),
  addWorkspaceApprovalRule: jest.fn(() => Promise.resolve()),
  getWorkspaceApprovalsFilePath: (): string =>
    '/tmp/canopy-reach-back-approval/.approvals.json',
}));
jest.mock('../../../lib/workspace-approvals-manifest', (): unknown => ({
  readWorkspaceApprovalsManifest: (): Promise<unknown> =>
    Promise.resolve({ rules: [] }),
}));
jest.mock('../../../lib/preferences-store', (): unknown => ({
  readPreferencesFile: (): Promise<unknown> =>
    Promise.resolve({ globalApprovalRules: [SAVED_ALLOW] }),
  readPreferencesFileDetailed: (): Promise<unknown> =>
    Promise.resolve({
      preferences: { globalApprovalRules: [SAVED_ALLOW] },
      authority: 'ok',
    }),
  peekPreferencesLoadError: (): null => null,
  updatePreferencesFile: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../../observability', (): unknown => ({
  getObservabilityService: () => ({
    recordApprovalDecision: jest.fn(),
    recordSessionDiagnostic: jest.fn(),
    pauseChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
  }),
}));
jest.mock('../../../observability/ingest', (): unknown => ({
  getExecutionObservabilityIngest: () => ({
    pauseChatTurn: jest.fn(),
    resumeChatTurn: jest.fn(),
  }),
}));
jest.mock('../../../services/attention-tracker', (): unknown => ({
  getAttentionTracker: () => ({ mark: jest.fn(), clear: jest.fn() }),
}));
jest.mock('../../../lib/main-process-logging', (): unknown => ({
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));

const mockRequestApprovalDecision = jest.mocked(requestApprovalDecision);

/** An in-memory file system for one store file. */
function memoryFile(): {
  readonly read: (path: string) => Promise<string | null>;
  readonly write: (path: string, data: string) => Promise<void>;
  text: () => string | null;
} {
  let stored: string | null = null;
  return {
    read: () => Promise.resolve(stored),
    write: (_path, data) => {
      stored = data;
      return Promise.resolve();
    },
    text: () => stored,
  };
}

const SERVER: ReachBackServer = {
  serverId: 'tracker',
  configId: 'default',
  connectionId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Tracker',
  enabledTools: ['create_issue', 'list_issues'],
  allowWithoutAsking: ['list_issues'],
  allowedAt: '2026-11-10T18:00:00.000Z',
};

const WINDOW: SendableBrowserWindow = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send: jest.fn(),
  } as unknown as SendableBrowserWindow['webContents'],
};

const never = new AbortController().signal;

describe('reach-back allow list (CAN-6176)', () => {
  it('serves a server only while it is allowed, matching all three ids', async () => {
    const file = memoryFile();
    const list = createReachBackAllowList({ filePath: () => 'f', ...file });
    await list.allow('acct-1', SERVER);
    const target = {
      connectionId: SERVER.connectionId,
      serverId: 'tracker',
      configId: 'default',
    };
    await expect(list.find('acct-1', target)).resolves.toEqual(SERVER);
    await expect(
      list.find('acct-1', { ...target, configId: 'other' }),
    ).resolves.toBeNull();
    await expect(
      list.find('acct-1', { ...target, connectionId: 'another-row' }),
    ).resolves.toBeNull();
    // Another account on this computer serves nothing of it.
    await expect(list.find('acct-2', target)).resolves.toBeNull();

    // Turning it off stops serving at once, and the file agrees on reload.
    await expect(list.disallow('acct-1', 'tracker', 'default')).resolves.toBe(
      true,
    );
    await expect(list.find('acct-1', target)).resolves.toBeNull();
    const reloaded = createReachBackAllowList({ filePath: () => 'f', ...file });
    await expect(reloaded.list('acct-1')).resolves.toEqual([]);
  });

  it('drops a signed-out account’s servers and calls, keeping the next account’s', async () => {
    const list = createReachBackAllowList({
      filePath: () => 'f',
      ...memoryFile(),
    });
    const log = createReachBackActivityLog({
      filePath: () => 'g',
      ...memoryFile(),
    });
    await list.allow('acct-1', SERVER);
    await log.record('acct-1', entry(0));
    let notify: (accountId: string | null) => void = () => undefined;
    forgetSignedOutAccounts([list, log], {
      currentAccountId: () => 'acct-1',
      onAccountChange: (listener) => {
        notify = listener;
        return (): void => undefined;
      },
    });
    notify('acct-1');
    await expect(list.list('acct-1')).resolves.toHaveLength(1);
    notify(null);
    await expect(list.list('acct-1')).resolves.toEqual([]);
    await expect(log.list('acct-1')).resolves.toEqual([]);
  });

  it('reads an unreadable file as nothing allowed', async () => {
    const list = createReachBackAllowList({
      filePath: () => 'f',
      read: () => Promise.resolve('{"version":1,"accounts":{"acct-1":[{}]}}'),
      write: () => Promise.resolve(),
    });
    await expect(list.list('acct-1')).resolves.toEqual([]);
  });
});

function entry(index: number): ReachBackActivityEntry {
  return {
    at: new Date(Date.UTC(2026, 10, 10, 18, 0, index)).toISOString(),
    chat: { id: 'chat-1', title: 'Plan the launch' },
    serverId: 'tracker',
    configId: 'default',
    toolName: 'create_issue',
    decision: 'asked_allowed',
    status: 200,
  };
}

describe('reach-back call log (CAN-6176)', () => {
  it('keeps the newest 200 calls per account, with the chat title as it was', async () => {
    const file = memoryFile();
    const log = createReachBackActivityLog({ filePath: () => 'g', ...file });
    for (let i = 0; i < ACTIVITY_LIMIT + 5; i += 1)
      await log.record('acct-1', entry(i));
    await log.record('acct-1', {
      ...entry(999),
      chat: { id: 'chat-2', title: `A\n${'very long title '.repeat(20)}` },
    });
    const entries = await log.list('acct-1');
    expect(entries).toHaveLength(ACTIVITY_LIMIT);
    expect(entries[0].chat?.id).toBe('chat-2');
    expect(entries[0].chat?.title).not.toContain('\n');
    expect(entries[0].chat?.title.length).toBeLessThanOrEqual(120);
    // The newest calls stay; the oldest went.
    expect(entries.at(-1)?.at).toBe(entry(6).at);
    // Nothing but the entry's own fields is written: no arguments, no result.
    const written: unknown = JSON.parse(file.text() ?? '{}');
    expect(
      typeof written === 'object' && written !== null
        ? Object.keys(written)
        : [],
    ).toEqual(['version', 'accounts']);
    expect(Object.keys(entries[0]).sort()).toEqual([
      'at',
      'chat',
      'configId',
      'decision',
      'serverId',
      'status',
      'toolName',
    ]);
  });

  it('keeps no call that ends after its account signed out', async () => {
    let account: string | null = 'acct-1';
    const log = createReachBackActivityLog({
      filePath: () => 'g',
      currentAccountId: () => account,
      ...memoryFile(),
    });
    await log.record('acct-1', entry(0));
    account = null;
    await log.forgetAccount('acct-1');
    // A call cancelled by the sign-out ends now.
    await log.record('acct-1', entry(1));
    await expect(log.list('acct-1')).resolves.toEqual([]);
  });
});

describe('reach-back approval (CAN-6176 Q3)', () => {
  let approver: ReturnType<typeof createReachBackApprover> | null = null;

  afterEach(() => {
    approver?.dispose();
    approver = null;
    mockRequestApprovalDecision.mockReset();
  });

  const request = {
    requestId: 'req-1',
    chat: { id: 'chat-1', title: 'Plan the launch' },
    serverName: 'Tracker',
    toolName: 'create_issue',
    arguments: { title: 'Ship it', token: `ghp_${'a'.repeat(36)}` },
    signal: never,
  };

  it('asks even when a saved global rule allows the same tool name', async () => {
    // The saved rule would allow the real tool in any session.
    const local = createApprovalSession({
      sessionKey: 'local',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      provider: 'claude',
      workspaceRoot: '/tmp/canopy-reach-back-approval',
      mode: 'ask',
      sessionRules: [],
      getWindow: () => WINDOW,
      trackChatTurn: false,
    });
    const realTool: ApprovalCheck = { kind: 'tool', toolName: 'create_issue' };
    await expect(
      local.check(realTool, {
        title: 'Create an issue',
        details: { kind: 'tool', toolName: 'create_issue' },
      }),
    ).resolves.toMatchObject({ decision: 'allow' });
    expect(mockRequestApprovalDecision).not.toHaveBeenCalled();
    local.dispose();

    mockRequestApprovalDecision.mockResolvedValueOnce({
      kind: 'decision',
      by: 'client',
      decision: { behavior: 'allow', scope: 'once' },
    });
    approver = createReachBackApprover({
      getWindow: () => WINDOW,
      createSession: createApprovalSession,
    });
    await expect(approver.ask(request)).resolves.toBe('asked_allowed');
    expect(mockRequestApprovalDecision).toHaveBeenCalledTimes(1);
    const [{ event }] = mockRequestApprovalDecision.mock.calls[0];
    // Names the chat, the server and the tool, with secrets redacted, and
    // offers no rule to save.
    expect(event.title).toContain('Plan the launch');
    expect(event.title).toContain('create_issue');
    expect(event.description).toContain('Tracker');
    expect(event.details).toMatchObject({ toolName: 'create_issue' });
    const summary =
      event.details.kind === 'tool' ? (event.details.inputSummary ?? '') : '';
    expect(summary).toContain('Ship it');
    expect(summary).not.toContain('a'.repeat(36));
    expect(event.suggestedTarget).toBeUndefined();
  });

  it('shows no part of a secret-named value in the prompt, however it is written', () => {
    const summary = argumentSummary({
      password: 'sample pass phrase',
      apiKey: 'first,second',
      nested: { auth_token: 'one two, three', title: 'visible title' },
      list: [{ client_secret: 'alpha beta' }],
    });
    for (const fragment of [
      'sample',
      'pass phrase',
      'first',
      'second',
      'one two',
      'three',
      'alpha',
      'beta',
    ])
      expect(summary).not.toContain(fragment);
    expect(summary).toContain('visible title');
  });

  it('records a person’s deny', async () => {
    mockRequestApprovalDecision.mockResolvedValueOnce({
      kind: 'decision',
      by: 'client',
      decision: { behavior: 'deny', scope: 'once' },
    });
    approver = createReachBackApprover({
      getWindow: () => WINDOW,
      createSession: createApprovalSession,
    });
    await expect(approver.ask(request)).resolves.toBe('asked_denied');
  });

  it('denies at once when no window can show the prompt', async () => {
    approver = createReachBackApprover({
      getWindow: () => null,
      createSession: createApprovalSession,
    });
    await expect(approver.ask(request)).resolves.toBe('no_window');
    expect(mockRequestApprovalDecision).not.toHaveBeenCalled();
  });

  it('denies when nobody answers in time, and takes the prompt down', async () => {
    let promptSignalAborted = false;
    mockRequestApprovalDecision.mockImplementationOnce(
      () =>
        new Promise(() => {
          // Never answered.
        }),
    );
    approver = createReachBackApprover({
      getWindow: () => WINDOW,
      createSession: (context) => {
        const session = createApprovalSession(context);
        return {
          ...session,
          check: (
            check,
            display,
          ): ReturnType<ApprovalSessionHandle['check']> => {
            display.signal?.addEventListener('abort', () => {
              promptSignalAborted = true;
            });
            return session.check(check, display);
          },
        };
      },
      timeoutMs: 50,
    });
    await expect(approver.ask(request)).resolves.toBe('approval_timeout');
    expect(promptSignalAborted).toBe(true);
  });
});

describe('serving a reach-back request (CAN-6176 D25)', () => {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64');
  const decode = (bodyBase64: string): unknown =>
    JSON.parse(Buffer.from(bodyBase64, 'base64').toString('utf8'));
  const rpc = (method: string, params?: unknown): string =>
    b64({ jsonrpc: '2.0', id: 7, method, ...(params ? { params } : {}) });

  interface ServeHarness {
    readonly allowList: ReachBackAllowList;
    readonly request: (
      bodyBase64: string,
      overrides?: Partial<McpHostRequest>,
    ) => Promise<McpHostRequestRespondParams>;
    readonly asked: string[];
    readonly forwarded: unknown[];
    readonly settled: () => Promise<readonly ReachBackActivityEntry[]>;
    /** The server's settings revision as the forwarder sees it now. */
    readonly settings: { revision: string };
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

  async function setup(
    decision: ReachBackApprovalDecision = 'asked_allowed',
    whileAsking?: (allowList: ReachBackAllowList) => Promise<void>,
    readOnlyTools: readonly string[] = ['list_issues', 'search'],
  ): Promise<ServeHarness> {
    const settings = { revision: 'settings-1' };
    const allowList = createReachBackAllowList({
      filePath: () => 'f',
      ...memoryFile(),
    });
    await allowList.allow('acct-1', SERVER);
    const log = createReachBackActivityLog({
      filePath: () => 'g',
      ...memoryFile(),
    });
    const asked: string[] = [];
    const approver: ReachBackApprover = {
      ask: async (request) => {
        asked.push(request.toolName);
        await whileAsking?.(allowList);
        return decision;
      },
      dispose: () => undefined,
    };
    const forwarded: unknown[] = [];
    const forwarder: ReachBackForwarder = {
      forward: (_server, request) => {
        if (
          request.expectedConfigRevision !== undefined &&
          request.expectedConfigRevision !== settings.revision
        )
          return Promise.resolve('configChanged');
        const message: unknown = JSON.parse(
          Buffer.from(request.body).toString('utf8'),
        );
        forwarded.push(message);
        const method = isRecord(message) ? message.method : undefined;
        const id = isRecord(message) ? message.id : undefined;
        const result =
          method === 'tools/list'
            ? {
                tools: [
                  'create_issue',
                  'list_issues',
                  'search',
                  'delete_repo',
                ].map((name) =>
                  readOnlyTools.includes(name)
                    ? { name, annotations: { readOnlyHint: true } }
                    : { name },
                ),
              }
            : { content: [{ type: 'text', text: 'done' }] };
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json', 'x-other': 'no' },
          body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })),
          configRevision: settings.revision,
        });
      },
    };
    const server = createReachBackServer({
      allowList,
      log,
      approver,
      forwarder,
    });
    const request = (
      bodyBase64: string,
      overrides: Partial<McpHostRequest> = {},
    ): Promise<McpHostRequestRespondParams> =>
      server.serve(
        'acct-1',
        {
          requestId: 'req-1',
          connectionId: SERVER.connectionId,
          serverId: 'tracker',
          configId: 'default',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          bodyBase64,
          deadlineAt: '2026-11-10T19:05:00.000Z',
          chat: { id: 'chat-1', title: 'Plan the launch' },
          ...overrides,
        },
        never,
      );
    const settled = async (): Promise<readonly ReachBackActivityEntry[]> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return log.list('acct-1');
    };
    return { allowList, request, asked, forwarded, settled, settings };
  }

  it('answers 404 for a server not allowed here, forwarding nothing', async () => {
    const { request, forwarded, settled, allowList } = await setup();
    await expect(
      request(rpc('tools/list'), { configId: 'other' }),
    ).resolves.toMatchObject({ status: 404 });
    // Turned off: refused at once.
    await allowList.disallow('acct-1', 'tracker', 'default');
    await expect(request(rpc('tools/list'))).resolves.toMatchObject({
      status: 404,
    });
    expect(forwarded).toEqual([]);
    expect((await settled())[0]).toMatchObject({
      decision: 'server_not_allowed',
      status: 404,
    });
  });

  it('lists only the tools chosen at opt-in, and passes back only MCP headers', async () => {
    const { request } = await setup();
    const answer = await request(rpc('tools/list'));
    expect(answer.status).toBe(200);
    expect(answer.headers).toEqual({ 'content-type': 'application/json' });
    expect(decode(answer.bodyBase64)).toMatchObject({
      result: {
        tools: [
          { name: 'create_issue' },
          { name: 'list_issues', annotations: { readOnlyHint: true } },
        ],
      },
    });
  });

  it('refuses a tool outside the opt-in, unforwarded and logged', async () => {
    const { request, forwarded, asked, settled } = await setup();
    const answer = await request(
      rpc('tools/call', { name: 'delete_repo', arguments: {} }),
    );
    expect(decode(answer.bodyBase64)).toMatchObject({ id: 7 });
    expect(JSON.stringify(decode(answer.bodyBase64))).toContain('not allowed');
    expect(forwarded).toEqual([]);
    expect(asked).toEqual([]);
    expect((await settled())[0]).toMatchObject({
      toolName: 'delete_repo',
      decision: 'tool_not_allowed',
    });
  });

  it('asks before a tool not marked read-only, and runs nothing it was refused', async () => {
    const denied = await setup('asked_denied');
    const answer = await denied.request(
      rpc('tools/call', { name: 'create_issue', arguments: { title: 'x' } }),
    );
    expect(JSON.stringify(decode(answer.bodyBase64))).toContain('declined');
    expect(denied.asked).toEqual(['create_issue']);
    expect(denied.forwarded).toEqual([]);
    const [logged] = await denied.settled();
    expect(logged).toMatchObject({
      decision: 'asked_denied',
      chat: { id: 'chat-1', title: 'Plan the launch' },
    });
    expect(JSON.stringify(logged)).not.toContain('"title":"x"');

    const allowed = await setup('asked_allowed');
    await expect(
      allowed.request(rpc('tools/call', { name: 'create_issue' })),
    ).resolves.toMatchObject({ status: 200 });
    expect(allowed.forwarded).toHaveLength(1);
    expect((await allowed.settled())[0]).toMatchObject({
      decision: 'asked_allowed',
      status: 200,
    });
  });

  it('runs a read-only tool, or one chosen to run without asking, without a prompt', async () => {
    const { request, asked, settled } = await setup('asked_denied');
    await request(rpc('tools/call', { name: 'list_issues' }));
    expect(asked).toEqual([]);
    expect((await settled())[0]).toMatchObject({
      decision: 'allowed_without_asking',
    });
    await request(rpc('tools/list'));
    // `search` is read-only but not chosen at opt-in: still refused.
    await request(rpc('tools/call', { name: 'search' }));
    expect((await settled())[0]).toMatchObject({
      decision: 'tool_not_allowed',
    });
    // Before any list the read-only hints are unknown, so it asks.
    await request(rpc('tools/call', { name: 'create_issue' }));
    expect(asked).toEqual(['create_issue']);
  });

  it('asks again once the server’s settings change, whatever its old listing said', async () => {
    const { request, asked, forwarded, settled, settings } = await setup(
      'asked_denied',
      undefined,
      ['create_issue'],
    );
    const call = rpc('tools/call', { name: 'create_issue' });
    await request(rpc('tools/list'));
    await request(call);
    expect(asked).toEqual([]);
    expect((await settled())[0]).toMatchObject({ decision: 'read_only' });

    // The person points the server somewhere else: the old hint can't carry
    // the call there unasked, and it isn't sent.
    settings.revision = 'settings-2';
    const sentBefore = forwarded.length;
    const refused = decode((await request(call)).bodyBase64) as {
      error?: { message?: string };
    };
    expect(refused.error?.message).toMatch(/settings changed/);
    expect(forwarded).toHaveLength(sentBefore);
    // Until the server lists its tools again, every call asks.
    await request(call);
    expect(asked).toEqual(['create_issue']);
    expect(forwarded).toHaveLength(sentBefore);
    await request(rpc('tools/list'));
    await request(call);
    expect(asked).toEqual(['create_issue']);
    expect((await settled())[0]).toMatchObject({ decision: 'read_only' });
  });

  it('answers a call whose tool name no tool can have, and runs nothing', async () => {
    const { request, forwarded } = await setup();
    for (const name of ['', 'x'.repeat(257)]) {
      const answered = decode(
        (await request(rpc('tools/call', { name }))).bodyBase64,
      ) as { error?: { message?: string } };
      expect(answered.error?.message).toBe(
        'This tool is not allowed in cloud chats on that desktop.',
      );
    }
    expect(forwarded).toEqual([]);
  });

  it('refuses a body it can’t read, so the server never gets a call unchecked', async () => {
    const { request, forwarded, asked } = await setup();
    const call = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'delete_repo' },
    });
    // A BOM: JSON.parse refuses it, a server may not.
    await expect(
      request(Buffer.from(`\uFEFF${call}`).toString('base64')),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      request(Buffer.from('not json').toString('base64')),
    ).resolves.toMatchObject({ status: 400 });
    expect(forwarded).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('runs no call whose server was turned off while it was asked about', async () => {
    const { request, forwarded, settled } = await setup(
      'asked_allowed',
      async (allowList) => {
        await allowList.disallow('acct-1', 'tracker', 'default');
      },
    );
    const answer = await request(rpc('tools/call', { name: 'create_issue' }));
    expect(JSON.stringify(decode(answer.bodyBase64))).toContain('not allowed');
    expect(forwarded).toEqual([]);
    expect((await settled())[0]).toMatchObject({
      toolName: 'create_issue',
      decision: 'tool_not_allowed',
    });
  });

  it('refuses a JSON-RPC batch, which could hide a call', async () => {
    const { request, forwarded } = await setup();
    await expect(
      request(b64([{ jsonrpc: '2.0', id: 1, method: 'tools/call' }])),
    ).resolves.toMatchObject({ status: 400 });
    expect(forwarded).toEqual([]);
  });
});

/** A stream the test feeds item by item. */
function fakeSession(): ReachBackSession & {
  push(item: McpHostRequestsItem): void;
  answers: unknown[];
  closed: boolean;
} {
  const queue: McpHostRequestsItem[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const answers: unknown[] = [];
  return {
    answers,
    get closed() {
      return closed;
    },
    push(item) {
      queue.push(item);
      wake?.();
    },
    items: {
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      },
    },
    respond(answer) {
      answers.push(answer);
      return Promise.resolve();
    },
    close() {
      closed = true;
      wake?.();
      return Promise.resolve();
    },
  };
}

describe('the reach-back service on core.integration.mcpHostRequests (CAN-6176 D22, D25)', () => {
  const REQUEST = {
    requestId: 'req-1',
    connectionId: SERVER.connectionId,
    serverId: 'tracker',
    configId: 'default',
    method: 'POST' as const,
    headers: {},
    bodyBase64: '',
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    chat: { id: 'chat-1', title: 'Plan the launch' },
  };
  const tick = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 5));

  interface ServiceHarness {
    readonly allowList: ReachBackAllowList;
    readonly service: ReturnType<typeof createReachBackService>;
    readonly sessions: ReturnType<typeof fakeSession>[];
    readonly served: { requestId: string; signal: AbortSignal }[];
    readonly closedRoutes: string[];
    readonly release: () => void;
    readonly signOut: () => void;
    /** The account store changed: `to` signs in another account. */
    readonly refresh: (to?: string) => void;
    readonly setFlag: (on: boolean) => void;
  }

  function setup(): ServiceHarness {
    const allowList = createReachBackAllowList({
      filePath: () => 'f',
      ...memoryFile(),
    });
    let account: string | null = 'acct-1';
    let accountListener: () => void = () => undefined;
    const sessions: ReturnType<typeof fakeSession>[] = [];
    const served: { requestId: string; signal: AbortSignal }[] = [];
    const closedRoutes: string[] = [];
    let release: () => void = () => undefined;
    let flag = true;
    let flagListener: () => void = () => undefined;
    const service = createReachBackService({
      isEnabled: () => flag,
      onEnabledChange: (listener) => {
        flagListener = listener;
        return (): void => undefined;
      },
      currentAccountId: () => account,
      onAccountChange: (listener) => {
        accountListener = listener;
        return (): void => undefined;
      },
      allowList,
      open: () => {
        const session = fakeSession();
        sessions.push(session);
        return Promise.resolve(session);
      },
      serve: (_accountId, request, signal) => {
        served.push({ requestId: request.requestId, signal });
        return new Promise((resolve) => {
          release = (): void =>
            resolve({
              requestId: request.requestId,
              status: 200,
              headers: {},
              bodyBase64: '',
            });
        });
      },
      closeRoutes: (accountId) => closedRoutes.push(accountId),
      sleep: () => tick(),
    });
    return {
      allowList,
      service,
      sessions,
      served,
      closedRoutes,
      release: (): void => release(),
      signOut: (): void => {
        account = null;
        accountListener();
      },
      refresh: (to?: string): void => {
        if (to !== undefined) account = to;
        accountListener();
      },
      setFlag: (on): void => {
        flag = on;
        flagListener();
      },
    };
  }

  it('holds no stream until a server is allowed, and lets go when none is', async () => {
    const t = setup();
    t.service.start();
    await tick();
    expect(t.sessions).toHaveLength(0);
    await t.allowList.allow('acct-1', SERVER);
    await tick();
    expect(t.sessions).toHaveLength(1);
    // Another server doesn't reconnect: that would lose requests in flight.
    await t.allowList.allow('acct-1', { ...SERVER, serverId: 'files' });
    await tick();
    expect(t.sessions).toHaveLength(1);
    await t.allowList.disallow('acct-1', 'files', 'default');
    await t.allowList.disallow('acct-1', 'tracker', 'default');
    await tick();
    expect(t.sessions[0].closed).toBe(true);
    expect(t.closedRoutes).toEqual(['acct-1']);
    await t.service.stop();
  });

  it('answers a request with core.integration.mcpHostRequest.respond, and drops one the web core withdraws', async () => {
    const t = setup();
    await t.allowList.allow('acct-1', SERVER);
    t.service.start();
    await tick();
    const [session] = t.sessions;
    session.push(REQUEST);
    await tick();
    t.release();
    await tick();
    expect(session.answers).toEqual([
      expect.objectContaining({ requestId: 'req-1', status: 200 }),
    ]);

    session.push({ ...REQUEST, requestId: 'req-2' });
    await tick();
    session.push({
      requestId: 'req-2',
      withdrawn: true,
      reason: 'caller_gone',
    });
    await tick();
    expect(t.served[1].signal.aborted).toBe(true);
    t.release();
    await tick();
    // A withdrawn request is never answered.
    expect(session.answers).toHaveLength(1);
    await t.service.stop();
  });

  it('starts when the flag turns on, and stops when it turns off', async () => {
    const t = setup();
    await t.allowList.allow('acct-1', SERVER);
    t.setFlag(false);
    t.service.start();
    await tick();
    expect(t.sessions).toHaveLength(0);
    // After a sign-in the flag reads off until it loads.
    t.setFlag(true);
    await tick();
    expect(t.sessions).toHaveLength(1);
    t.setFlag(false);
    await tick();
    expect(t.sessions[0].closed).toBe(true);
    await t.service.stop();
  });

  it('keeps the stream and a call in flight through a refresh of the same account', async () => {
    const t = setup();
    await t.allowList.allow('acct-1', SERVER);
    t.service.start();
    await tick();
    t.sessions[0]?.push(REQUEST);
    await tick();
    expect(t.served).toHaveLength(1);
    // Its teams, billing or profile changed; it's still the same account.
    t.refresh();
    await tick();
    expect(t.served[0]?.signal.aborted).toBe(false);
    expect(t.sessions[0]?.closed).toBe(false);
    expect(t.sessions).toHaveLength(1);
    // Another account signing in does restart it.
    await t.allowList.allow('acct-2', SERVER);
    t.refresh('acct-2');
    await tick();
    expect(t.sessions[0]?.closed).toBe(true);
    t.release();
    await t.service.stop();
  });

  it('stops serving when the account signs out', async () => {
    const t = setup();
    await t.allowList.allow('acct-1', SERVER);
    t.service.start();
    await tick();
    t.signOut();
    await tick();
    expect(t.sessions[0].closed).toBe(true);
    expect(t.closedRoutes).toEqual(['acct-1']);
    await t.service.stop();
  });
});

describe('allowing a server in cloud chats (CAN-6176 D26)', () => {
  it('turns off locally first, even when the cloud removal fails', async () => {
    const allowList = createReachBackAllowList({
      filePath: () => 'f',
      ...memoryFile(),
    });
    const order: string[] = [];
    const controller = createReachBackController({
      allowList,
      currentAccountId: () => 'acct-1',
      recordDesktopConnection: (input) => {
        order.push(`record:${input.serverId}`);
        return Promise.resolve({ connectionId: SERVER.connectionId });
      },
      removeConnection: async () => {
        order.push(`remove:${String((await allowList.list('acct-1')).length)}`);
        throw new Error('offline');
      },
      onServerOff: (serverId) => order.push(`off:${serverId}`),
    });
    const allowed = await controller.allow({
      serverId: 'tracker',
      configId: 'default',
      displayName: 'Tracker',
      enabledTools: ['create_issue'],
      // Not an allowed tool, so it can't run without asking either.
      allowWithoutAsking: ['create_issue', 'delete_repo'],
    });
    expect(allowed.allowWithoutAsking).toEqual(['create_issue']);
    await expect(allowList.list('acct-1')).resolves.toHaveLength(1);

    await expect(controller.disallow('tracker', 'default')).resolves.toBe(
      false,
    );
    // Removed here before the cloud was asked, and gone despite its failure.
    expect(order).toEqual(['record:tracker', 'off:tracker', 'remove:0']);
    await expect(allowList.list('acct-1')).resolves.toEqual([]);
  });

  it('serves nothing when the account changed during opt-in', async () => {
    const allowList = createReachBackAllowList({
      filePath: () => 'f',
      ...memoryFile(),
    });
    let account = 'acct-1';
    const removed: string[] = [];
    const controller = createReachBackController({
      allowList,
      currentAccountId: () => account,
      recordDesktopConnection: () => {
        account = 'acct-2';
        return Promise.resolve({ connectionId: SERVER.connectionId });
      },
      removeConnection: (id) => {
        removed.push(id);
        return Promise.resolve();
      },
    });
    await expect(
      controller.allow({
        serverId: 'tracker',
        configId: 'default',
        displayName: 'Tracker',
        enabledTools: null,
        allowWithoutAsking: [],
      }),
    ).rejects.toThrow('Sign in');
    expect(removed).toEqual([SERVER.connectionId]);
    await expect(allowList.list('acct-1')).resolves.toEqual([]);
    await expect(allowList.list('acct-2')).resolves.toEqual([]);
  });
});

describe('forwarding a reach-back call on current settings (CAN-6176 D25)', () => {
  function forwarding(): {
    forwarder: ReturnType<typeof createReachBackHttpForwarder>;
    hold: Promise<void> | undefined;
    port: number;
    config: { url: string; enabled: boolean; authToken: string } | null;
    registered: string[];
    unregistered: string[];
    sentTo: string[];
  } {
    const state = {
      /** An upstream answer waits for this, when set. */
      hold: undefined as Promise<void> | undefined,
      /** The integration server's port. */
      port: 4100,
      config: {
        url: 'https://mcp.tracker.example/mcp',
        enabled: true,
        authToken: 'token-1',
      } as { url: string; enabled: boolean; authToken: string } | null,
      registered: [] as string[],
      unregistered: [] as string[],
      sentTo: [] as string[],
    };
    const forwarder = createReachBackHttpForwarder({
      accountId: () => 'acct-1',
      readServer: (serverId) => {
        const config = state.config;
        if (config === null) return Promise.reject(new Error('ENOENT'));
        return Promise.resolve({
          server: {
            definition: { id: serverId, type: 'http', url: config.url },
            configs: [
              {
                id: 'default',
                enabled: config.enabled,
                authToken: config.authToken,
              },
            ],
          },
        } as unknown as McpServerFile);
      },
      service: {
        unregisterRoute: (routeId: string) => state.unregistered.push(routeId),
        unregisterRoutesForSession: () => undefined,
        getProxyUrl: (routeId: string) =>
          `http://127.0.0.1:${String(state.port)}/${routeId}`,
      } as unknown as Parameters<
        typeof createReachBackHttpForwarder
      >[0]['service'],
      port: () => 4100,
      registerRoute: ({ serverFile, configId }) => {
        const config = serverFile.server.configs.find(
          (candidate) => candidate.id === configId,
        );
        if (!config?.enabled) return Promise.resolve(null);
        const routeId = `route-${String(state.registered.length + 1)}`;
        state.registered.push(routeId);
        return Promise.resolve({
          routeId,
          url: `http://127.0.0.1:4100/${routeId}`,
        });
      },
      fetch: async (url) => {
        state.sentTo.push(url instanceof Request ? url.url : url.toString());
        await state.hold;
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    return Object.assign(state, { forwarder });
  }
  const call = {
    method: 'POST' as const,
    headers: {},
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1 })),
    signal: new AbortController().signal,
  };

  it('keeps one route while the config is unchanged, and replaces it after an edit', async () => {
    const state = forwarding();
    await state.forwarder.forward(SERVER, call);
    await state.forwarder.forward(SERVER, call);
    expect(state.registered).toEqual(['route-1']);
    if (state.config) state.config.url = 'https://mcp.elsewhere.example/mcp';
    await state.forwarder.forward(SERVER, call);
    if (state.config) state.config.authToken = 'token-2';
    await state.forwarder.forward(SERVER, call);
    expect(state.registered).toEqual(['route-1', 'route-2', 'route-3']);
    expect(state.unregistered).toEqual(['route-1', 'route-2']);
    expect(state.sentTo.slice(-2)).toEqual([
      'http://127.0.0.1:4100/route-2',
      'http://127.0.0.1:4100/route-3',
    ]);
  });

  it('follows the integration server to a new port with the same route', async () => {
    const state = forwarding();
    await state.forwarder.forward(SERVER, call);
    state.port = 4200;
    await state.forwarder.forward(SERVER, call);
    expect(state.registered).toEqual(['route-1']);
    expect(state.sentTo).toEqual([
      'http://127.0.0.1:4100/route-1',
      'http://127.0.0.1:4200/route-1',
    ]);
  });

  it('lets a call in flight finish on the old route when the server is turned off, and starts nothing new', async () => {
    const state = forwarding();
    let finish: () => void = () => undefined;
    // Hold the first upstream answer until the server has been turned off.
    state.hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const inFlight = state.forwarder.forward(SERVER, call);
    while (state.sentTo.length === 0)
      await new Promise((resolve) => setImmediate(resolve));
    if (state.config) state.config.enabled = false;
    await expect(state.forwarder.forward(SERVER, call)).resolves.toMatchObject({
      status: 501,
    });
    finish();
    await expect(inFlight).resolves.toMatchObject({ status: 200 });
    expect(state.sentTo).toEqual(['http://127.0.0.1:4100/route-1']);
    expect(state.unregistered).toEqual(['route-1']);
  });

  it('forwards nothing once the config is turned off or deleted, dropping its route', async () => {
    const disabled = forwarding();
    await disabled.forwarder.forward(SERVER, call);
    if (disabled.config) disabled.config.enabled = false;
    await expect(
      disabled.forwarder.forward(SERVER, call),
    ).resolves.toMatchObject({ status: 501 });
    expect(disabled.unregistered).toEqual(['route-1']);
    expect(disabled.sentTo).toHaveLength(1);

    const deleted = forwarding();
    await deleted.forwarder.forward(SERVER, call);
    deleted.config = null;
    await expect(deleted.forwarder.forward(SERVER, call)).rejects.toThrow();
    expect(deleted.unregistered).toEqual(['route-1']);
    expect(deleted.sentTo).toHaveLength(1);
  });
});

describe('acknowledging reach-back requests as they arrive (CAN-6176 D22)', () => {
  const CREDIT = 8;

  /**
   * A web core subscription as the real one runs it: at most eight frames
   * unacknowledged, and nothing more until an ack for this subscription
   * comes. One that stalls ends after a short wait, so a test sees it.
   */
  function subscription(
    subscriptionId: string,
    total: number,
  ): {
    stream: Parameters<typeof acknowledgedItems<number>>[0];
    ack: (params: {
      subscriptionId: string;
      cursor: { daemonEpoch: string; sequence: number };
    }) => Promise<void>;
    acked: () => number;
  } {
    let delivered = 0;
    let acked = 0;
    let wake: () => void = () => undefined;
    async function* frames(): AsyncGenerator<{
      kind: 'item';
      cursor: { daemonEpoch: string; sequence: number };
      item: number;
    }> {
      while (delivered < total) {
        while (delivered - acked >= CREDIT) {
          const stalled = await new Promise<boolean>((resolve) => {
            wake = (): void => resolve(false);
            setTimeout(() => resolve(true), 50);
          });
          if (stalled) return;
        }
        delivered += 1;
        yield {
          kind: 'item',
          cursor: { daemonEpoch: 'epoch-1', sequence: delivered },
          item: delivered,
        };
      }
    }
    return {
      stream: {
        openResult: { subscriptionId, acceptedCursor: null },
        frames: frames(),
      },
      ack: (params) => {
        // An ack for another subscription releases nothing here.
        if (params.subscriptionId === subscriptionId) {
          acked = Math.max(acked, params.cursor.sequence);
          wake();
        }
        return Promise.resolve();
      },
      acked: () => acked,
    };
  }

  async function drain(items: AsyncIterable<number>): Promise<number[]> {
    const seen: number[] = [];
    for await (const item of items) seen.push(item);
    return seen;
  }

  it('keeps delivering past the web core’s eight unacknowledged requests', async () => {
    const first = subscription('sub-1', 20);
    const seen = await drain(acknowledgedItems(first.stream, first.ack));
    expect(seen).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(first.acked()).toBe(20);

    // Without acks the same stream stops at eight, as the review found.
    const unacked = subscription('sub-1', 20);
    const stalled: number[] = [];
    for await (const frame of unacked.stream.frames)
      if (frame.kind === 'item') stalled.push(frame.item);
    expect(stalled).toHaveLength(CREDIT);
  });

  it('acknowledges a reconnect’s frames on its own subscription', async () => {
    const before = subscription('sub-1', 5);
    expect(
      await drain(acknowledgedItems(before.stream, before.ack)),
    ).toHaveLength(5);
    // The connection dropped; the service opens a new subscription, whose
    // credit only its own acks release.
    const after = subscription('sub-2', 12);
    const acks: string[] = [];
    const seen = await drain(
      acknowledgedItems(after.stream, (params) => {
        acks.push(params.subscriptionId);
        return after.ack(params);
      }),
    );
    expect(seen).toHaveLength(12);
    expect(new Set(acks)).toEqual(new Set(['sub-2']));
    expect(after.acked()).toBe(12);
  });
});
