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
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MCP_PROXY_PORT,
  type ApprovalCheck,
  type ApprovalRule,
} from '@canopy/desktop-shared/types';
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
import {
  createReachBackServer,
  type ReachBackAdmission,
  type ReachBackForwarder,
  type ReachBackUpstreamResponse,
} from '../serve';
import {
  createReachBackHttpForwarder,
  serverConfigRevision,
} from '../http-forwarder';
import { normalizeMcpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import { acknowledgedItems } from '../stream-credit';
import {
  createReachBackReachability,
  REACH_BACK_RETRY_AFTER_MS,
  reachBackFailureCause,
  reachBackFailureKind,
  type ReachBackReachability,
} from '../reachability';
import { servingReport } from '../serving-report';
import { takesServingReports } from '../../../canopy-cloud/reach-back-web-core-session';
import type { McpHostServingServer } from '@canopy/protocol/canopy-core';
import { createReachBackController } from '../controller';
import {
  createReachBackStdioBridge,
  onMcpServerSettingsChange,
  type ReachBackStdioLaunch,
  type ReachBackStdioStartPoint,
  type ReachBackStdioTicket,
} from '../stdio-bridge';
import { notifyDesktopInventoryChanged } from '../../../services/desktop-inventory-sync-signals';
import type { StdioJsonRpcSession } from '@canopy/desktop-shared/node/mcp/stdio-json-rpc-session';
import { createReachBackService, type ReachBackSession } from '../service';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type { CanopyCapabilities } from '@canopy/app-core';
import { createDesktopCapabilities } from '@/client/ipc-canopy-client';
import { webCoreScopeCapabilities } from '@/lib/web-core-scope-capabilities';
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
      signal?: AbortSignal,
    ) => Promise<McpHostRequestRespondParams>;
    readonly asked: (string | null)[];
    readonly forwarded: unknown[];
    readonly settled: () => Promise<readonly ReachBackActivityEntry[]>;
    /** The server's settings revision as the forwarder sees it now. */
    readonly settings: { revision: string };
    /** Set to make every forward fail with this message. */
    readonly unreachable: { cause: string | null };
    readonly reachability: ReachBackReachability;
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
    const asked: (string | null)[] = [];
    const approver: ReachBackApprover = {
      ask: async (request) => {
        asked.push(request.toolName);
        await whileAsking?.(allowList);
        return decision;
      },
      dispose: () => undefined,
    };
    const forwarded: unknown[] = [];
    const unreachable: { cause: string | null } = { cause: null };
    const forwarder: ReachBackForwarder = {
      forward: (_server, request) => {
        if (unreachable.cause !== null)
          return Promise.reject(new Error(unreachable.cause));
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
    const reachability = createReachBackReachability();
    const server = createReachBackServer({
      allowList,
      log,
      approver,
      forwarder,
      reachability,
    });
    const request = (
      bodyBase64: string,
      overrides: Partial<McpHostRequest> = {},
      signal: AbortSignal = never,
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
        signal,
      );
    const settled = async (): Promise<readonly ReachBackActivityEntry[]> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return log.list('acct-1');
    };
    return {
      allowList,
      request,
      asked,
      forwarded,
      settled,
      settings,
      unreachable,
      reachability,
    };
  }

  it('says why an allowed server could not be reached, and clears it once it is', async () => {
    const t = await setup();
    t.unreachable.cause =
      'Port 37645 is in use by another app. Change the MCP proxy port.';
    const failed = await t.request(rpc('tools/list'));
    expect(failed.status).toBe(502);
    expect(decode(failed.bodyBase64)).toEqual({
      error: 'mcp_server_unreachable',
    });
    expect(
      t.reachability.cause('acct-1', SERVER.serverId, SERVER.configId),
    ).toBe('Port 37645 is in use by another app. Change the MCP proxy port.');
    // Another account's view of the same server is untouched.
    expect(
      t.reachability.cause('acct-2', SERVER.serverId, SERVER.configId),
    ).toBeNull();
    t.unreachable.cause = null;
    await expect(t.request(rpc('tools/list'))).resolves.toMatchObject({
      status: 200,
    });
    expect(
      t.reachability.cause('acct-1', SERVER.serverId, SERVER.configId),
    ).toBeNull();
  });

  it('holds no server back for a call withdrawn before it was answered (CAN-6659)', async () => {
    const t = await setup();
    t.unreachable.cause = 'The request was withdrawn.';
    const withdrawn = new AbortController();
    withdrawn.abort();
    await t.request(rpc('tools/list'), {}, withdrawn.signal);
    expect(
      t.reachability.cause('acct-1', SERVER.serverId, SERVER.configId),
    ).toBeNull();
    expect(
      t.reachability.holdingBack(
        'acct-1',
        SERVER.serverId,
        SERVER.configId,
        Date.now(),
      ),
    ).toBeNull();
  });

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

  it('asks before a tool not marked read-only unless that tool itself runs without asking', async () => {
    // SERVER lets list_issues alone run without asking.
    const { request, asked, forwarded } = await setup('asked_denied');
    await request(rpc('tools/call', { name: 'create_issue' }));
    expect(asked).toEqual(['create_issue']);
    expect(forwarded).toEqual([]);
    await request(rpc('tools/call', { name: 'list_issues' }));
    expect(asked).toEqual(['create_issue']);
    expect(forwarded).toHaveLength(1);
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

  function setup(
    options: {
      /** The web core takes reports: what it answers each one. */
      readonly reports?: (
        servers: readonly McpHostServingServer[],
      ) => 'reported' | 'not_owned';
      readonly servingOf?: (
        accountId: string,
      ) => Promise<McpHostServingServer[]>;
      readonly onServingChange?: (listener: () => void) => () => void;
    } = {},
  ): ServiceHarness & { readonly reported: McpHostServingServer[][] } {
    const reported: McpHostServingServer[][] = [];
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
        const reports = options.reports;
        const session: ReturnType<typeof fakeSession> =
          reports === undefined
            ? fakeSession()
            : Object.assign(fakeSession(), {
                report: (servers: readonly McpHostServingServer[]) => {
                  reported.push([...servers]);
                  return Promise.resolve(reports(servers));
                },
              });
        sessions.push(session);
        return Promise.resolve(session);
      },
      ...(options.servingOf === undefined
        ? {}
        : { servingOf: options.servingOf }),
      ...(options.onServingChange === undefined
        ? {}
        : { onServingChange: options.onServingChange }),
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
      reported,
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

  describe('serving reports (CAN-6659)', () => {
    /** The runtime's report, over a real reachability and allow list. */
    function reporting(
      reports: (
        servers: readonly McpHostServingServer[],
      ) => 'reported' | 'not_owned' = (): 'reported' => 'reported',
    ): ServiceHarness & {
      readonly reported: McpHostServingServer[][];
      readonly reachability: ReachBackReachability;
      readonly advance: (ms: number) => void;
    } {
      let now = 1_000_000;
      const reachability = createReachBackReachability(() => now);
      let allowList: ReachBackAllowList | null = null;
      const t = setup({
        reports,
        servingOf: (accountId) => {
          if (allowList === null) throw new Error('no allow list');
          return allowList.list(accountId).then((servers) =>
            servingReport(accountId, servers, {
              reachability,
              unusable: () => Promise.resolve(null),
              now: () => now,
            }),
          );
        },
        onServingChange: (listener) => reachability.onChange(listener),
      });
      allowList = t.allowList;
      return {
        ...t,
        reachability,
        advance: (ms: number): void => {
          now += ms;
        },
      };
    }

    it('reports each allowed server ready once the stream is open', async () => {
      const t = reporting();
      await t.allowList.allow('acct-1', SERVER);
      t.service.start();
      await tick();
      expect(t.reported).toEqual([
        [{ serverId: 'tracker', configId: 'default', state: 'ready' }],
      ]);
      await t.service.stop();
    });

    it('reports a failed server unreachable with only a cause and a fixed message, and ready again once the retry window lapses', async () => {
      const t = reporting();
      await t.allowList.allow('acct-1', SERVER);
      t.service.start();
      await tick();
      const secret = 'https://mcp.example/sse?token=sk-live-7731';
      const failure = Object.assign(new Error(`connect to ${secret} refused`), {
        code: 'ECONNREFUSED',
      });
      // As serve records it: the redacted text for the log and the page.
      t.reachability.failed(
        'acct-1',
        SERVER,
        reachBackFailureCause(failure),
        reachBackFailureKind(failure),
      );
      expect(
        t.reachability.cause('acct-1', SERVER.serverId, SERVER.configId),
      ).toContain('mcp.example');
      await tick();
      expect(t.reported.at(-1)).toEqual([
        {
          serverId: 'tracker',
          configId: 'default',
          state: 'unreachable',
          cause: 'refused',
          message: 'The server refused the connection.',
        },
      ]);
      // Nothing of the error itself leaves this computer.
      expect(JSON.stringify(t.reported)).not.toContain('token');
      expect(JSON.stringify(t.reported)).not.toContain('mcp.example');
      // A server cloud chats aren't offered gets no call to succeed with,
      // so the failure lapses and the next report offers it again.
      t.advance(REACH_BACK_RETRY_AFTER_MS - 1);
      await t.allowList.allow('acct-1', SERVER);
      await tick();
      expect(t.reported.at(-1)?.[0]?.state).toBe('unreachable');
      // The minute's refresh, or any change after the window, says ready.
      t.advance(1);
      await t.allowList.allow('acct-1', SERVER);
      await tick();
      expect(t.reported.at(-1)).toEqual([
        { serverId: 'tracker', configId: 'default', state: 'ready' },
      ]);
      await t.service.stop();
    });

    it('reports at most 256 servers at a time, as the protocol allows', async () => {
      const t = reporting();
      for (let index = 0; index < 300; index += 1)
        await t.allowList.allow('acct-1', {
          ...SERVER,
          serverId: `server-${String(index)}`,
        });
      t.service.start();
      await tick();
      await tick();
      expect(t.reported.map((batch) => batch.length)).toEqual([256, 44]);
      await t.service.stop();
    });

    it('sends a report again server by server when one is no longer this desktop’s', async () => {
      const t = reporting((servers) =>
        servers.some((server) => server.serverId === 'files')
          ? 'not_owned'
          : 'reported',
      );
      await t.allowList.allow('acct-1', SERVER);
      await t.allowList.allow('acct-1', { ...SERVER, serverId: 'files' });
      t.service.start();
      await tick();
      expect(
        t.reported.slice(-3).map((batch) => batch.map((s) => s.serverId)),
      ).toEqual([['tracker', 'files'], ['tracker'], ['files']]);
      await t.service.stop();
    });

    it('reports nothing to a web core that doesn’t take reports, and serves as before', async () => {
      const t = setup({
        servingOf: () => Promise.reject(new Error('never asked')),
      });
      await t.allowList.allow('acct-1', SERVER);
      t.service.start();
      await tick();
      expect(t.reported).toEqual([]);
      expect(t.sessions).toHaveLength(1);
      await t.service.stop();
      // The stream asks for reports only where the web core takes them.
      const manifest = (
        ops: string[],
      ): { has: (kind: 'operations', name: string) => boolean } => ({
        has: (_kind, name): boolean => ops.includes(name),
      });
      expect(
        takesServingReports(
          manifest(['core.integration.mcpHostStatus.report']),
        ),
      ).toBe(true);
      expect(takesServingReports(manifest([]))).toBe(false);
    });

    it('names a failure by its error code, never its message', () => {
      const coded = (code: string, message = 'GET https://x/?token=y'): Error =>
        Object.assign(new Error(message), { code });
      expect(reachBackFailureKind(coded('ECONNREFUSED'))).toBe('refused');
      expect(reachBackFailureKind(coded('ETIMEDOUT'))).toBe('timed_out');
      expect(reachBackFailureKind(coded('ENOENT'))).toBe('start_failed');
      expect(reachBackFailureKind(coded('ENOTFOUND'))).toBe(
        'upstream_unreachable',
      );
      // fetch() wraps the socket error in its cause.
      expect(
        reachBackFailureKind(
          new TypeError('fetch failed', { cause: coded('ECONNREFUSED') }),
        ),
      ).toBe('refused');
      expect(reachBackFailureKind(new Error('ECONNREFUSED in the text'))).toBe(
        'unknown',
      );
    });
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

/** A stdio server process that answers each request with its own id. */
function fakeProcess(): StdioJsonRpcSession & {
  sent: unknown[];
  emit(message: unknown): void;
  exit(): void;
  closed: boolean;
  hold: boolean;
} {
  const listeners: ((message: unknown) => void)[] = [];
  const closers: (() => void)[] = [];
  const process = {
    sent: [] as unknown[],
    closed: false,
    hold: false,
    emit: (message: unknown): void => {
      for (const listener of listeners) listener(message);
    },
    exit: (): void => {
      process.closed = true;
      for (const close of closers) close();
    },
    send: (message: unknown): Promise<void> => {
      process.sent.push(message);
      const record =
        typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>)
          : {};
      if ('method' in record && 'id' in record && !process.hold)
        queueMicrotask(() =>
          process.emit({
            jsonrpc: '2.0',
            id: record.id,
            result: { echoed: record.method },
          }),
        );
      return Promise.resolve();
    },
    onMessage: (listener: (message: unknown) => void): void => {
      listeners.push(listener);
    },
    onClose: (listener: () => void): void => {
      closers.push(listener);
    },
    close: (): Promise<void> => {
      process.exit();
      return Promise.resolve();
    },
  };
  return process;
}

/** A request's ticket, as serve() takes it at entry. */
function admitted(
  bridge: ReturnType<typeof createReachBackStdioBridge>,
  server: { serverId: string; configId: string },
): ReachBackStdioTicket {
  const ticket = bridge.admit(server);
  if (ticket === null) throw new Error('unreadable settings');
  return ticket;
}

describe('stdio servers reached from cloud chats (CAN-6176 PR 7b, D25)', () => {
  const STDIO_SERVER = { ...SERVER, serverId: 'files' };
  const b64 = (value: unknown): Uint8Array =>
    Buffer.from(JSON.stringify(value));
  const parse = (body: Uint8Array): unknown =>
    JSON.parse(Buffer.from(body).toString('utf8'));

  function setup(
    options: {
      idleMs?: number;
      maxSessions?: number;
      command?: boolean;
      whileStarting?: (
        bridge: ReturnType<typeof createReachBackStdioBridge>,
      ) => void;
    } = {},
  ): {
    bridge: ReturnType<typeof createReachBackStdioBridge>;
    processes: ReturnType<typeof fakeProcess>[];
    released: number[];
    /** The server's settings as reach-back reads them on each request. */
    settings: { revision: string | null; command: boolean };
    post: (
      message: unknown,
      sessionId?: string,
      signal?: AbortSignal,
    ) => Promise<ReachBackUpstreamResponse>;
  } {
    const processes: ReturnType<typeof fakeProcess>[] = [];
    const released: number[] = [];
    const settings = {
      revision: 'settings-1' as string | null,
      command: options.command !== false,
    };
    let launches = 0;
    const bridge = createReachBackStdioBridge({
      readSettings: () =>
        settings.revision === null
          ? null
          : {
              startsProcess: settings.command,
              configRevision: settings.revision,
            },
      resolveLaunch: () => {
        if (!settings.command) return Promise.resolve(null);
        const index = launches++;
        const launch: ReachBackStdioLaunch = {
          command: 'launcher',
          args: ['route'],
          release: () => {
            released.push(index);
            return Promise.resolve();
          },
        };
        return Promise.resolve(launch);
      },
      openSession: () => {
        const process = fakeProcess();
        processes.push(process);
        options.whileStarting?.(bridge);
        return Promise.resolve(process);
      },
      ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
      ...(options.maxSessions === undefined
        ? {}
        : { maxSessions: options.maxSessions }),
    });
    const post = async (
      message: unknown,
      sessionId?: string,
      signal: AbortSignal = never,
    ): Promise<ReachBackUpstreamResponse> => {
      const answer = await bridge.forward(STDIO_SERVER, {
        method: 'POST',
        headers: sessionId === undefined ? {} : { 'mcp-session-id': sessionId },
        body: b64(message),
        signal,
        admission: admitted(bridge, STDIO_SERVER),
      });
      if (answer === 'configChanged') throw new Error('configChanged');
      return answer;
    };
    return { bridge, processes, released, settings, post };
  }

  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize' };

  it('starts one process per cloud MCP session and keeps its calls on it', async () => {
    const t = setup();
    const opened = await t.post(initialize);
    expect(opened.status).toBe(200);
    const sessionId = opened.headers['mcp-session-id'];
    expect(sessionId).toEqual(expect.any(String));
    expect(parse(opened.body)).toMatchObject({ id: 1 });
    // A notification is accepted without an answer.
    await expect(
      t.post(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        sessionId,
      ),
    ).resolves.toMatchObject({ status: 202 });
    const called = await t.post(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read' } },
      sessionId,
    );
    expect(parse(called.body)).toMatchObject({
      id: 2,
      result: { echoed: 'tools/call' },
    });
    expect(t.processes).toHaveLength(1);
    // Another session gets its own process.
    await t.post(initialize);
    expect(t.processes).toHaveLength(2);
  });

  it('stops a running process when its command is edited or its server turned off, so nothing runs on old settings', async () => {
    const t = setup();
    const opened = await t.post(initialize);
    const sessionId = opened.headers['mcp-session-id'];
    expect(opened.configRevision).toBe('settings-1');

    // The person edits the command: the old process stops at the next
    // request, which the client answers by initializing again.
    t.settings.revision = 'settings-2';
    await expect(
      t.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId),
    ).resolves.toMatchObject({ status: 404 });
    expect(t.processes[0]?.closed).toBe(true);
    expect(t.released).toEqual([0]);
    const again = await t.post(initialize);
    expect(again).toMatchObject({ status: 200, configRevision: 'settings-2' });
    expect(t.processes).toHaveLength(2);

    // Then turns the server's config off: the process stops and no new one
    // starts.
    t.settings.revision = 'settings-3';
    t.settings.command = false;
    await expect(t.post(initialize)).resolves.toMatchObject({ status: 501 });
    expect(t.processes[1]?.closed).toBe(true);
    expect(t.processes).toHaveLength(2);

    // An unasked read-only call bound to settings that changed never runs.
    t.settings.command = true;
    const fresh = await t.post(initialize);
    t.settings.revision = 'settings-4';
    await expect(
      t.bridge.forward(STDIO_SERVER, {
        method: 'POST',
        headers: { 'mcp-session-id': fresh.headers['mcp-session-id'] ?? '' },
        body: b64({ jsonrpc: '2.0', id: 3, method: 'tools/call' }),
        signal: never,
        expectedConfigRevision: 'settings-3',
        admission: admitted(t.bridge, STDIO_SERVER),
      }),
    ).resolves.toBe('configChanged');
    expect(t.processes[2]?.sent).toEqual([initialize]);
  });

  it('answers 404 for an unknown session, so the client initializes again', async () => {
    const t = setup();
    await expect(
      t.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'missing'),
    ).resolves.toMatchObject({ status: 404 });
    expect(t.processes).toHaveLength(0);
  });

  it('refuses a request from the server, which has no way to the cloud chat', async () => {
    const t = setup();
    await t.post(initialize);
    const [process] = t.processes;
    process.emit({
      jsonrpc: '2.0',
      id: 'srv-1',
      method: 'sampling/createMessage',
    });
    expect(process.sent.at(-1)).toMatchObject({
      id: 'srv-1',
      error: { code: -32601 },
    });
  });

  it('closes a session on DELETE, when idle, when turned off, and evicts the oldest past the cap', async () => {
    const t = setup({ idleMs: 30, maxSessions: 2 });
    const first = (await t.post(initialize)).headers['mcp-session-id'];
    await expect(
      t.bridge.forward(STDIO_SERVER, {
        method: 'DELETE',
        headers: { 'mcp-session-id': first ?? '' },
        body: new Uint8Array(),
        signal: never,
        admission: admitted(t.bridge, STDIO_SERVER),
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(t.processes[0].closed).toBe(true);
    expect(t.released).toEqual([0]);

    // Idle: closed and its launch route released.
    await t.post(initialize);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.processes[1].closed).toBe(true);
    expect(t.released).toEqual([0, 1]);

    // Past the cap, the least recently used goes.
    await t.post(initialize);
    await t.post(initialize);
    await t.post(initialize);
    expect(t.bridge.size()).toBe(2);
    expect(t.processes[2].closed).toBe(true);

    // Turned off: every session of that server closes at once.
    t.bridge.forget(STDIO_SERVER.serverId, STDIO_SERVER.configId);
    expect(t.bridge.size()).toBe(0);
  });

  it('keeps nothing running when its server is turned off while it starts', async () => {
    const t = setup({
      whileStarting: (bridge) =>
        bridge.forget(STDIO_SERVER.serverId, STDIO_SERVER.configId),
    });
    await expect(t.post(initialize)).resolves.toMatchObject({ status: 404 });
    expect(t.processes[0].closed).toBe(true);
    expect(t.released).toEqual([0]);
    expect(t.bridge.size()).toBe(0);
  });

  it('starts again after the bridge closes at the end of a serving run', async () => {
    const t = setup();
    await t.post(initialize);
    // A serving run ending closes the bridge; the next run reuses it.
    t.bridge.close();
    await expect(t.post(initialize)).resolves.toMatchObject({ status: 200 });
    expect(t.bridge.size()).toBe(1);
  });

  it('never sends a call withdrawn before it reaches the process', async () => {
    const t = setup();
    const sessionId = (await t.post(initialize)).headers['mcp-session-id'];
    const withdrawn = new AbortController();
    withdrawn.abort();
    await expect(
      t.post(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'read' },
        },
        sessionId,
        withdrawn.signal,
      ),
    ).rejects.toThrow('withdrawn');
    expect(
      t.processes[0].sent.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'method' in message &&
          message.method === 'tools/call',
      ),
    ).toBe(false);
  });

  it('answers 502 when the process exits mid-call, and 501 for a server that is not a command', async () => {
    const t = setup();
    const sessionId = (await t.post(initialize)).headers['mcp-session-id'];
    const [process] = t.processes;
    process.hold = true;
    const pending = t.post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call' },
      sessionId,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.exit();
    await expect(pending).resolves.toMatchObject({ status: 502 });

    const http = setup({ command: false });
    await expect(http.post(initialize)).resolves.toMatchObject({ status: 501 });
  });
});

describe('the settings revision a start is checked against (CAN-6176 PR 7b)', () => {
  it('changes with the server file’s contents even when its modified time and size do not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reach-back-revision-'));
    try {
      const file = join(dir, 'files.json');
      const at = new Date('2026-11-11T12:00:00.000Z');
      const write = (command: string): void => {
        writeFileSync(
          file,
          JSON.stringify({
            version: 1,
            server: {
              definition: {
                id: 'files',
                name: 'Files',
                description: '',
                type: 'command',
                command,
                createdAt: at.toISOString(),
                updatedAt: at.toISOString(),
              },
              configs: [
                {
                  id: 'default',
                  name: 'Default',
                  description: '',
                  enabled: true,
                  envVars: {},
                  extraArgs: [],
                  extraHeaders: {},
                  createdAt: at.toISOString(),
                  updatedAt: at.toISOString(),
                },
              ],
            },
          }),
        );
        // Two writes within one timestamp: the file looks unchanged by time.
        utimesSync(file, at, at);
      };
      const revision = (): string => {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return serverConfigRevision(
          normalizeMcpServerFile(parsed, 'files'),
          'default',
        );
      };
      write('/usr/local/bin/aaaa');
      const before = { stat: statSync(file), revision: revision() };
      write('/usr/local/bin/bbbb');
      const after = { stat: statSync(file), revision: revision() };
      expect(after.stat.mtimeMs).toBe(before.stat.mtimeMs);
      expect(after.stat.size).toBe(before.stat.size);
      expect(after.revision).not.toBe(before.revision);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a stdio start stopped at any await (CAN-6176 PR 7b)', () => {
  const STDIO_SERVER = { ...SERVER, serverId: 'files' };
  const initialize = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  );
  const POINTS: readonly ReachBackStdioStartPoint[] = [
    'admitted',
    'launch-resolved',
    'spawned',
    'answered',
  ];
  type Stop = 'turned off' | 'settings changed' | 'bridge closed';
  const STOPS: readonly Stop[] = [
    'turned off',
    'settings changed',
    'bridge closed',
  ];

  function startable(options: {
    at?: ReachBackStdioStartPoint;
    stop?: (bridge: ReturnType<typeof createReachBackStdioBridge>) => void;
    holdAnswer?: boolean;
    failSend?: boolean;
  }): {
    bridge: ReturnType<typeof createReachBackStdioBridge>;
    processes: ReturnType<typeof fakeProcess>[];
    released: number[];
    /** Launch routes resolved. */
    routes: () => number;
    settings: { revision: string };
  } {
    const processes: ReturnType<typeof fakeProcess>[] = [];
    const released: number[] = [];
    const settings = { revision: 'settings-1' };
    let launches = 0;
    const bridge = createReachBackStdioBridge({
      readSettings: () => ({
        startsProcess: true,
        configRevision: settings.revision,
      }),
      resolveLaunch: () => {
        const index = launches++;
        return Promise.resolve({
          command: 'launcher',
          args: [],
          release: () => {
            released.push(index);
            return Promise.resolve();
          },
        });
      },
      openSession: () => {
        const process = fakeProcess();
        if (options.holdAnswer === true) process.hold = true;
        if (options.failSend === true)
          process.send = (): Promise<void> =>
            Promise.reject(new Error('not a JSON-RPC message'));
        processes.push(process);
        return Promise.resolve(process);
      },
      startPoint: (point) => {
        if (point === options.at) options.stop?.(bridge);
        return Promise.resolve();
      },
    });
    return { bridge, processes, released, routes: () => launches, settings };
  }

  const stopWith =
    (stop: Stop, settings: () => { revision: string }) =>
    (bridge: ReturnType<typeof createReachBackStdioBridge>): void => {
      if (stop === 'turned off')
        bridge.forget(STDIO_SERVER.serverId, STDIO_SERVER.configId);
      else if (stop === 'bridge closed') bridge.close();
      else settings().revision = 'settings-2';
    };

  for (const at of POINTS)
    for (const stop of STOPS)
      it(`leaves nothing running when the server is ${stop} at the ${at} await`, async () => {
        let current: { revision: string } = { revision: '' };
        const t = startable({ at, stop: stopWith(stop, () => current) });
        current = t.settings;
        const answer = await t.bridge.forward(STDIO_SERVER, {
          method: 'POST',
          headers: {},
          body: initialize,
          signal: never,
          admission: admitted(t.bridge, STDIO_SERVER),
        });
        if (stop === 'settings changed') expect(answer).toBe('configChanged');
        else expect(answer).toMatchObject({ status: 404 });
        expect(t.processes.every((process) => process.closed)).toBe(true);
        // Every launch route resolved was released.
        expect(t.released).toHaveLength(t.routes());
        expect(t.bridge.size()).toBe(0);
      });

  it('starts nothing for a ticket taken before the server was turned off, whatever ran in between', async () => {
    const t = startable({});
    // serve() admits the request, then awaits the allow list and the
    // person's approval; the server is turned off meanwhile.
    const ticket = admitted(t.bridge, STDIO_SERVER);
    t.bridge.forget(STDIO_SERVER.serverId, STDIO_SERVER.configId);
    const answer = await t.bridge.forward(STDIO_SERVER, {
      method: 'POST',
      headers: {},
      body: initialize,
      signal: never,
      admission: ticket,
    });
    expect(answer).toMatchObject({ status: 404 });
    expect(t.processes).toHaveLength(0);
    expect(t.bridge.size()).toBe(0);
  });

  it('leaves nothing running when the first call of a start is withdrawn or refused', async () => {
    const held = startable({ holdAnswer: true });
    const withdrawn = new AbortController();
    const pending = held.bridge
      .forward(STDIO_SERVER, {
        method: 'POST',
        headers: {},
        body: initialize,
        signal: withdrawn.signal,
        admission: admitted(held.bridge, STDIO_SERVER),
      })
      .catch((error: unknown) => error);
    await new Promise((resolve) => setImmediate(resolve));
    withdrawn.abort();
    await pending;
    expect(held.processes[0]?.closed).toBe(true);
    expect(held.bridge.size()).toBe(0);

    const refused = startable({ failSend: true });
    await refused.bridge
      .forward(STDIO_SERVER, {
        method: 'POST',
        headers: {},
        body: initialize,
        signal: never,
        admission: admitted(refused.bridge, STDIO_SERVER),
      })
      .catch((error: unknown) => error);
    expect(refused.processes[0]?.closed).toBe(true);
    expect(refused.bridge.size()).toBe(0);
  });

  it('closes a process that finishes opening after its server was turned off', async () => {
    let open: (process: ReturnType<typeof fakeProcess>) => void = () =>
      undefined;
    const late = fakeProcess();
    const bridge = createReachBackStdioBridge({
      readSettings: () => ({
        startsProcess: true,
        configRevision: 'settings-1',
      }),
      resolveLaunch: () =>
        Promise.resolve({
          command: 'launcher',
          args: [],
          release: () => Promise.resolve(),
        }),
      openSession: () =>
        new Promise((resolve) => {
          open = resolve;
        }),
    });
    const pending = bridge.forward(STDIO_SERVER, {
      method: 'POST',
      headers: {},
      body: initialize,
      signal: never,
      admission: admitted(bridge, STDIO_SERVER),
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Registered while it opens, so turning the server off reaches it.
    expect(bridge.size()).toBe(1);
    bridge.forget(STDIO_SERVER.serverId, STDIO_SERVER.configId);
    expect(bridge.size()).toBe(0);
    open(late);
    await expect(pending).resolves.toMatchObject({ status: 404 });
    expect(late.closed).toBe(true);
  });
});

describe('ending a stdio server’s sessions when its settings are saved or deleted (CAN-6176 PR 7b)', () => {
  const STDIO_SERVER = { ...SERVER, serverId: 'files' };
  const OTHER = { ...SERVER, serverId: 'notes' };
  const initialize = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  );

  function running(): {
    bridge: ReturnType<typeof createReachBackStdioBridge>;
    processes: ReturnType<typeof fakeProcess>[];
    released: () => number;
    /** Each server's settings revision; absent once deleted. */
    revisions: Map<string, string>;
    start: (server: { serverId: string; configId: string }) => Promise<void>;
  } {
    const processes: ReturnType<typeof fakeProcess>[] = [];
    let released = 0;
    const revisions = new Map([
      [STDIO_SERVER.serverId, 'settings-1'],
      [OTHER.serverId, 'settings-1'],
    ]);
    const bridge = createReachBackStdioBridge({
      readSettings: (target) => {
        const revision = revisions.get(target.serverId);
        return revision === undefined
          ? null
          : { startsProcess: true, configRevision: revision };
      },
      resolveLaunch: () =>
        Promise.resolve({
          command: 'launcher',
          args: [],
          release: () => {
            released += 1;
            return Promise.resolve();
          },
        }),
      openSession: () => {
        const process = fakeProcess();
        processes.push(process);
        return Promise.resolve(process);
      },
      onSettingsChange: onMcpServerSettingsChange,
    });
    const start = async (server: {
      serverId: string;
      configId: string;
    }): Promise<void> => {
      const answer = await bridge.forward(
        { ...SERVER, ...server },
        {
          method: 'POST',
          headers: {},
          body: initialize,
          signal: never,
          admission: admitted(bridge, server),
        },
      );
      expect(answer).toMatchObject({ status: 200 });
    };
    return {
      bridge,
      processes,
      released: () => released,
      revisions,
      start,
    };
  }

  it('ends the server’s process as soon as new settings are saved, before any further request', async () => {
    const t = running();
    await t.start(STDIO_SERVER);
    await t.start(OTHER);
    expect(t.processes.map((process) => process.closed)).toEqual([
      false,
      false,
    ]);
    // The MCP server page saves a new command for `files`.
    t.revisions.set(STDIO_SERVER.serverId, 'settings-2');
    notifyDesktopInventoryChanged(['mcp_servers']);
    expect(t.processes[0]?.closed).toBe(true);
    expect(t.released()).toBe(1);
    // `notes` kept its settings, so its process runs on.
    expect(t.processes[1]?.closed).toBe(false);
    expect(t.bridge.size()).toBe(1);
    t.bridge.dispose();
  });

  it('ends the server’s process as soon as the server is deleted', async () => {
    const t = running();
    await t.start(STDIO_SERVER);
    t.revisions.delete(STDIO_SERVER.serverId);
    notifyDesktopInventoryChanged(['mcp_servers']);
    expect(t.processes[0]?.closed).toBe(true);
    expect(t.bridge.size()).toBe(0);
    t.bridge.dispose();
  });

  it('leaves a session on the current settings running when a request admitted before the save arrives late', async () => {
    const t = running();
    // A request is admitted on the old settings, then waits on the prompt.
    const stale = admitted(t.bridge, STDIO_SERVER);
    t.revisions.set(STDIO_SERVER.serverId, 'settings-2');
    notifyDesktopInventoryChanged(['mcp_servers']);
    // Meanwhile another chat starts the server on the new settings.
    await t.start(STDIO_SERVER);
    const answer = await t.bridge.forward(
      { ...SERVER, ...STDIO_SERVER },
      {
        method: 'POST',
        headers: {},
        body: initialize,
        signal: never,
        admission: stale,
      },
    );
    expect(answer).toBe('configChanged');
    expect(t.processes).toHaveLength(1);
    expect(t.processes[0]?.closed).toBe(false);
    expect(t.bridge.size()).toBe(1);
    t.bridge.dispose();
  });

  it('leaves the process running for a save that keeps its settings, or a change to something else', async () => {
    const t = running();
    await t.start(STDIO_SERVER);
    notifyDesktopInventoryChanged(['mcp_servers']);
    t.revisions.set(STDIO_SERVER.serverId, 'settings-2');
    notifyDesktopInventoryChanged(['collections']);
    expect(t.processes[0]?.closed).toBe(false);
    expect(t.bridge.size()).toBe(1);
    t.bridge.dispose();
  });
});

describe('starting a stdio server for a cloud chat (CAN-6176 PR 7b)', () => {
  const STDIO = {
    ...SERVER,
    serverId: 'files',
    enabledTools: ['read'],
    allowWithoutAsking: [],
  };

  async function setup(
    decision: ReachBackApprovalDecision,
    allowWithoutAsking: string[] = [],
    options: {
      /** What serve() is admitted on; the bridge's own ticket by default. */
      admission?: ReachBackAdmission | null;
      /** The revision the bridge reads. */
      revision?: string;
    } = {},
  ): Promise<{
    serve: (
      body: unknown,
      sessionId?: string,
    ) => ReturnType<ReturnType<typeof createReachBackServer>['serve']>;
    processes: ReturnType<typeof fakeProcess>[];
    asked: (string | null)[];
  }> {
    const allowList = createReachBackAllowList({
      filePath: () => 'f',
      ...memoryFile(),
    });
    await allowList.allow('acct-1', { ...STDIO, allowWithoutAsking });
    const processes: ReturnType<typeof fakeProcess>[] = [];
    const bridge = createReachBackStdioBridge({
      readSettings: () => ({
        startsProcess: true,
        configRevision: options.revision ?? 'settings-1',
      }),
      resolveLaunch: () =>
        Promise.resolve({
          command: 'launcher',
          args: [],
          release: () => Promise.resolve(),
        }),
      openSession: () => {
        const process = fakeProcess();
        processes.push(process);
        return Promise.resolve(process);
      },
    });
    const asked: (string | null)[] = [];
    const issued = new WeakMap<ReachBackAdmission, ReachBackStdioTicket>();
    const server = createReachBackServer({
      allowList,
      log: createReachBackActivityLog({ filePath: () => 'g', ...memoryFile() }),
      approver: {
        ask: (request) => {
          asked.push(request.toolName);
          return Promise.resolve(decision);
        },
        dispose: () => undefined,
      },
      forwarder: {
        admit: (target) => {
          if (options.admission !== undefined) return options.admission;
          const ticket = bridge.admit(target);
          if (ticket !== null) issued.set(ticket, ticket);
          return ticket;
        },
        // As the runtime does: a ticket it didn't issue is admitted afresh.
        forward: (target, request) =>
          bridge.forward(target, {
            ...request,
            admission:
              (request.admission === undefined
                ? undefined
                : issued.get(request.admission)) ?? admitted(bridge, target),
          }),
      },
    });
    return {
      processes,
      asked,
      serve: (body, sessionId) =>
        server.serve(
          'acct-1',
          {
            requestId: 'req-1',
            connectionId: STDIO.connectionId,
            serverId: STDIO.serverId,
            configId: STDIO.configId,
            method: 'POST',
            headers:
              sessionId === undefined ? {} : { 'mcp-session-id': sessionId },
            bodyBase64: Buffer.from(JSON.stringify(body)).toString('base64'),
            deadlineAt: new Date(Date.now() + 60_000).toISOString(),
            chat: { id: 'chat-1', title: 'Plan the launch' },
          },
          never,
        ),
    };
  }

  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize' };

  it('asks before a start even when every tool runs without asking', async () => {
    // Run without asking covers a chosen tool's calls, never the start of
    // the server's process.
    const t = await setup('asked_denied', ['read']);
    await t.serve(initialize);
    expect(t.asked).toEqual([null]);
    expect(t.processes).toHaveLength(0);
  });

  it.each(['asked_denied', 'approval_timeout', 'no_window'] as const)(
    'starts no process for an allowed server when the start is %s',
    async (decision) => {
      const t = await setup(decision);
      const answer = await t.serve(initialize);
      expect(t.asked).toEqual([null]);
      expect(t.processes).toHaveLength(0);
      const refusal: unknown = JSON.parse(
        Buffer.from(answer.bodyBase64, 'base64').toString('utf8'),
      );
      expect(refusal).toMatchObject({ id: 1 });
      expect(JSON.stringify(refusal)).toContain('"error"');
    },
  );

  it('never starts a process unasked when the server became a command server after the check', async () => {
    // The check reads an HTTP server; by the launch it's a command server.
    const t = await setup('asked_allowed', [], {
      admission: { startsProcess: false, configRevision: 'http-1' },
      revision: 'command-1',
    });
    const answer = await t.serve(initialize);
    expect(t.asked).toEqual([]);
    expect(t.processes).toHaveLength(0);
    expect(Buffer.from(answer.bodyBase64, 'base64').toString('utf8')).toContain(
      'settings changed',
    );
  });

  it('answers an initialize whose server file can no longer be read', async () => {
    const t = await setup('asked_allowed', [], { admission: null });
    const answer = await t.serve(initialize);
    expect(answer.status).toBe(502);
    expect(t.processes).toHaveLength(0);
  });

  it('starts one process once the start is approved, and gates its tools as an HTTP server’s', async () => {
    const t = await setup('asked_allowed');
    const opened = await t.serve(initialize);
    expect(t.processes).toHaveLength(1);
    const sessionId = opened.headers['mcp-session-id'];
    // A tool outside the opt-in is refused before it reaches the process.
    await t.serve(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'rm' } },
      sessionId,
    );
    expect(t.processes[0].sent).not.toContainEqual(
      expect.objectContaining({ method: 'tools/call' }),
    );
    // An allowed one is asked about, then runs on that process.
    await t.serve(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read' } },
      sessionId,
    );
    expect(t.asked).toEqual([null, 'read']);
    expect(t.processes[0].sent).toContainEqual(
      expect.objectContaining({ id: 3, method: 'tools/call' }),
    );
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
    answer: (() => Response) | undefined;
  } {
    const state = {
      /** An upstream answer waits for this, when set. */
      hold: undefined as Promise<void> | undefined,
      /** What the integration server answers, when set. */
      answer: undefined as (() => Response) | undefined,
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
      runningPort: () => 4100,
      preferredPort: () => Promise.resolve(4100),
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
        if (state.answer !== undefined) return state.answer();
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

  it('starts the integration server on the Proxy port setting, not the default one another app holds', async () => {
    const started: number[] = [];
    const forwarder = createReachBackHttpForwarder({
      accountId: () => 'acct-1',
      readServer: (serverId) =>
        Promise.resolve({
          server: {
            definition: {
              id: serverId,
              type: 'http',
              url: 'https://mcp.tracker.example/mcp',
            },
            configs: [{ id: 'default', enabled: true }],
          },
        } as unknown as McpServerFile),
      service: {
        unregisterRoute: () => undefined,
        unregisterRoutesForSession: () => undefined,
        getProxyUrl: (routeId: string) =>
          `http://127.0.0.1:${String(started.at(-1))}/${routeId}`,
      } as unknown as Parameters<
        typeof createReachBackHttpForwarder
      >[0]['service'],
      // Stopped, and the person moved it off the default port.
      runningPort: () => null,
      preferredPort: () => Promise.resolve(38645),
      // As registerDeviceHttpMcpRoute does: start the server on the port given.
      registerRoute: ({ port }) => {
        if (port === DEFAULT_MCP_PROXY_PORT)
          return Promise.reject(
            new Error('Port 37645 is in use by another app.'),
          );
        started.push(port);
        return Promise.resolve({
          routeId: 'route-1',
          url: `http://127.0.0.1:${String(port)}/route-1`,
        });
      },
      fetch: (url) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                url: url instanceof Request ? url.url : url.toString(),
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
    });
    const answer = await forwarder.forward(SERVER, call);
    expect(answer).toMatchObject({ status: 200 });
    expect(started).toEqual([38645]);
  });

  it('fails the call when the integration server couldn’t reach the server, but passes on a server’s own 502 (CAN-6659)', async () => {
    const t = forwarding();
    // The integration server's own answer to a refused upstream socket.
    t.answer = (): Response =>
      new Response(
        JSON.stringify({
          error: 'MCP proxy upstream request failed',
          message: 'connect ECONNREFUSED 127.0.0.1:7777',
        }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      );
    const failed = await t.forwarder.forward(SERVER, call).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(reachBackFailureKind(failed)).toBe('refused');
    // A 502 the server itself sent is its answer, not a reach failure.
    t.answer = (): Response =>
      new Response(JSON.stringify({ error: 'bad gateway upstream of it' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    await expect(t.forwarder.forward(SERVER, call)).resolves.toMatchObject({
      status: 502,
    });
  });

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

describe('only a desktop lets cloud chats reach its MCP servers (CAN-6176)', () => {
  const REACH_BACK_CHANNELS = [
    'cloudReachBackList',
    'cloudReachBackActivity',
    'cloudReachBackAllow',
    'cloudReachBackDisallow',
  ] as const;

  it('turns reach-back on for the desktop window and the cloud chats it shows', () => {
    const desktop = createDesktopCapabilities('darwin');
    expect(desktop.cloudReachBack).toBe(true);
    expect(webCoreScopeCapabilities(desktop).cloudReachBack).toBe(true);
    expect(
      webCoreScopeCapabilities(desktop, { durableTerminals: true })
        .cloudReachBack,
    ).toBe(true);
  });

  it('lets no remote controller call its channels', () => {
    // The web's own capabilities are pinned off in the web reach-back golden.
    for (const channel of REACH_BACK_CHANNELS)
      expect(IPC_REMOTE_DISPOSITIONS[channel]).toBe('blocked');
  });

  it('fails closed: a window without the capability gives its cloud chats none', () => {
    const { cloudReachBack: omitted, ...missing } =
      createDesktopCapabilities('darwin');
    expect(omitted).toBe(true);
    const off: CanopyCapabilities = { ...missing, cloudReachBack: false };
    expect(webCoreScopeCapabilities(missing).cloudReachBack).toBeUndefined();
    expect(webCoreScopeCapabilities(off).cloudReachBack).toBeUndefined();
  });
});
