import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AppAdvisorActionResponse,
  OllamaState,
} from '@canopy/desktop-shared/types';
import type { RemoteControlState } from '@canopy/desktop-shared/types/remote-control';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type * as DesktopRuntimeModule from '../../canopy-runtime/desktop-runtime';
import type { AdvisorCredentialActionHost } from '../advisor-credential-actions';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: jest.fn(),
  routeRendererToolRequest: jest.fn((): null => null),
}));

// DispatchAction records writes in the active runtime's action runs.
let mockRuns: AdvisorActionRuns | null = null;
jest.mock('../../canopy-runtime/desktop-runtime', (): object => ({
  ...jest.requireActual<typeof DesktopRuntimeModule>(
    '../../canopy-runtime/desktop-runtime',
  ),
  getActiveDesktopRuntimeIfAccepting: (): {
    appAdvisorActions: AdvisorActionRuns | null;
  } => ({ appAdvisorActions: mockRuns }),
}));

let mockBoundTools: readonly string[] = [];
jest.mock('../../agents/session-manager', () => ({
  getActiveSessionCapabilityProfile: (): {
    interfaceTools: readonly string[];
  } => ({ interfaceTools: mockBoundTools }),
}));

let mockHost: AdvisorCredentialActionHost;
jest.mock('../advisor-credential-actions-host', () => ({
  mainAdvisorCredentialActionHost: (): AdvisorCredentialActionHost => mockHost,
}));

import {
  InterfaceToolRegistry,
  type InterfaceToolCall,
} from '@canopy/core-runtime/node/client';
import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { interfaceToolDescriptor } from '@canopy/protocol/canopy-core';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  requestAppAdvisorRendererTool,
  routeRendererToolRequest,
} from '../../ipc/app-advisor';
import {
  setInterfaceToolAudienceResolver,
  setSessionInterfaceToolRegistry,
} from '../../agents/interface-tool-binding';
import {
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
} from '../action-router';
import { ADVISOR_CREDENTIAL_ACTION_TYPES } from '../advisor-credential-actions';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';
import { executeAppAdvisorTool } from '../tool-executor';

const SECRET = 'sk-live-0123456789abcdefSECRET';
const LEASE = ['ui.app_advisor.present'] as const;
const routeRequest = jest.mocked(routeRendererToolRequest);
const windowRequest = jest.mocked(requestAppAdvisorRendererTool);

const SURFACE_ACTIONS = [
  { type: 'mcp.account_connect', serverId: 'srv-1' },
  { type: 'mcp.account_reconnect', serverId: 'srv-1' },
  { type: 'mcp.account_disconnect', serverId: 'srv-1' },
  { type: 'mcp.account_promote', serverId: 'srv-1' },
  { type: 'mcp.account_edit', serverId: 'srv-1' },
  { type: 'cursor.connection', operation: 'connect' },
  { type: 'cursor.approval_check', operation: 'run' },
] as const;

const HOST_ACTIONS = [
  { type: 'canopy_cloud.load_account' },
  { type: 'canopy_cloud.validate_api_key', apiKey: SECRET },
  { type: 'canopy_cloud.save_api_key', apiKey: SECRET },
  { type: 'canopy_cloud.clear_api_key' },
  { type: 'canopy_cloud.start_oauth_login' },
  { type: 'canopy_cloud.cancel_oauth_login' },
  { type: 'canopy_cloud.disconnect' },
  { type: 'remote_control.get_state' },
  { type: 'remote_control.set_allow_incoming', enabled: true },
  { type: 'opencode.connection', operation: 'status' },
  { type: 'ollama.install' },
] as const;

const ALL_ACTIONS = [...HOST_ACTIONS, ...SURFACE_ACTIONS];

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;
let calls: Array<[string, unknown]>;
let allowIncoming: boolean;
let remoteRefusal: Error | null;
let ollamaReady: boolean;

function remoteState(): RemoteControlState {
  return {
    available: true,
    signedIn: true,
    relayStatus: 'connected',
    allowIncoming,
    hosts: [
      {
        deviceId: 'dev-2',
        name: 'Mini',
        platform: 'darwin',
        online: true,
        connection: 'idle',
      },
    ],
    controllers: [],
    incomingPairings: [],
    pairingCode: '123456',
  } as unknown as RemoteControlState;
}

function recordingHost(): AdvisorCredentialActionHost {
  const record = (name: string, value?: unknown): void => {
    calls.push([name, value]);
  };
  return {
    loadCloudAccount: () => {
      record('loadCloudAccount');
      return Promise.resolve({ connected: true, storageAvailable: true });
    },
    validateCloudApiKey: (request) => {
      record('validateCloudApiKey', request);
      return Promise.reject(new Error(`Rejected key ${request.apiKey}`));
    },
    saveCloudApiKey: (request) => {
      record('saveCloudApiKey', request);
      return Promise.resolve({
        status: { authenticated: true, note: `saved ${request.apiKey}` },
        account: { connected: true },
      });
    },
    clearCloudApiKey: () => {
      record('clearCloudApiKey');
      return Promise.resolve({ connected: false });
    },
    startCloudOAuthLogin: () => {
      record('startCloudOAuthLogin');
      return Promise.resolve({ status: { authenticated: true } });
    },
    cancelCloudOAuthLogin: () => {
      record('cancelCloudOAuthLogin');
      return Promise.resolve();
    },
    disconnectCloudAccount: () => {
      record('disconnectCloudAccount');
      return Promise.resolve({ connected: false });
    },
    remoteControl: () => ({
      getState: () => Promise.resolve(remoteState()),
      setAllowIncoming: (allow) => {
        record('setAllowIncoming', allow);
        if (remoteRefusal) return Promise.reject(remoteRefusal);
        allowIncoming = allow;
        return Promise.resolve(remoteState());
      },
    }),
    openCode: (operation, signal) => {
      record('openCode', [operation, signal !== undefined]);
      return Promise.resolve({ connected: true });
    },
    revealOllamaSettings: () => {
      record('revealOllamaSettings');
      return Promise.resolve();
    },
    installOllama: () => {
      record('installOllama');
      return Promise.resolve({
        mode: 'managed',
        status: 'running',
        installation: {
          ready: ollamaReady,
          version: '0.9.0',
          source: 'managed',
          automaticInstallSupported: true,
          path: '/opt/ollama',
        },
        ...(ollamaReady ? {} : { error: 'Download failed.' }),
      } as unknown as OllamaState);
    },
  };
}

function setup(): {
  route(
    input: unknown,
    call?: Partial<AppAdvisorActionCall>,
  ): Promise<AppAdvisorActionResponse>;
  /** The DispatchAction tool itself, with the main window's lease bound. */
  dispatch(
    input: unknown,
    toolUseId: string,
  ): ReturnType<typeof executeAppAdvisorTool>;
} {
  const runtime = createAppAdvisorToolRuntime(
    {
      getMainWindow: jest.fn(() => null),
      getAppAdvisorWindow: jest.fn(() => null),
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    },
    {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
  );
  return {
    route: async (input, call) => {
      const routed = await routeAppAdvisorAction(
        dispatchActionSchema.parse({ action: input }).action,
        runtime,
        { toolUseId: 'toolu_1', ...call },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
    dispatch: (input, toolUseId) =>
      executeAppAdvisorTool('dispatch_action', { action: input }, runtime, {
        toolUseId,
        interfaceTools: LEASE,
      }),
  };
}

function bound(
  toolUseId: string,
  tools: readonly string[] = LEASE,
): Partial<AppAdvisorActionCall> {
  return {
    toolUseId,
    context: { interfaceTools: tools } as AppAdvisorActionCall['context'],
  };
}

function okReply(call: InterfaceToolCall): object {
  return { requestId: call.callId, ok: true };
}

/** A window lease serving ui.app_advisor.present; `audience` marks a connected computer's window (CAN-5823). */
function openPresentLease(
  registry: InterfaceToolRegistry,
  leaseId: string,
  reply: (call: InterfaceToolCall) => object,
  audience?: string,
): InterfaceToolCall[] {
  const delivered: InterfaceToolCall[] = [];
  registry.openLease(
    {
      leaseId,
      surface: 'main',
      interfaceKind: 'desktop',
      ...(audience === undefined ? {} : { audience }),
    },
    {
      deliver: (call) => {
        delivered.push(call);
        setImmediate(() => registry.reply(leaseId, call.callId, reply(call)));
        return true;
      },
      cancel: () => undefined,
    },
  );
  registry.register(leaseId, {
    tools: [interfaceToolDescriptor('ui.app_advisor.present')],
    _meta: { idempotencyKey: `${leaseId}-tools` },
  });
  return delivered;
}

/** This computer's main window lease, answering each surface request with `reply`. */
function mainLease(
  reply: (call: InterfaceToolCall) => object,
): InterfaceToolCall[] {
  const registry = new InterfaceToolRegistry();
  const delivered = openPresentLease(registry, 'main-1', reply);
  setSessionInterfaceToolRegistry(registry);
  return delivered;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-6008-credentials-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  mockRuns = runs;
  calls = [];
  allowIncoming = false;
  remoteRefusal = null;
  ollamaReady = true;
  mockBoundTools = [];
  mockHost = recordingHost();
  routeRequest.mockReset();
  routeRequest.mockReturnValue(null);
  windowRequest.mockReset();
  mainLease(okReply);
});
afterEach(() => {
  setInterfaceToolAudienceResolver(null);
  setSessionInterfaceToolRegistry(null);
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor credential and remote-access actions in main (CAN-6008)', () => {
  it('the eighteen actions are core, require the interface, and keep their grants', () => {
    const types = ALL_ACTIONS.map((action) => action.type);
    expect(new Set(types).size).toBe(18);
    for (const type of types) {
      const disposition = appAdvisorActionDisposition(type);
      expect(disposition).toMatchObject({
        kind: 'core',
        requiresInterface: true,
      });
      if (disposition?.kind !== 'core') continue;
      const reads = [
        'canopy_cloud.load_account',
        'canopy_cloud.validate_api_key',
        'remote_control.get_state',
      ];
      expect(disposition.access).toBe(reads.includes(type) ? 'read' : 'write');
      if (disposition.access === 'write')
        expect(disposition.grants).toEqual([
          type.startsWith('remote_control.')
            ? 'core.remoteAccess.write'
            : 'core.integration.write',
        ]);
    }
    expect([...ADVISOR_CREDENTIAL_ACTION_TYPES].sort()).toEqual(
      HOST_ACTIONS.map((action) => action.type).sort(),
    );
  });

  it('every action refuses a headless turn and a session without the main window lease, before any effect', async () => {
    const h = setup();
    for (const [index, action] of ALL_ACTIONS.entries()) {
      for (const call of [
        { toolUseId: `headless-${index}` },
        bound(`other-lease-${index}`, ['ui.app_advisor.show_files']),
      ])
        expect({
          type: action.type,
          response: await h.route(action, call),
        }).toMatchObject({
          type: action.type,
          response: {
            ok: false,
            error: { code: 'surface_unavailable', retryable: true },
          },
        });
    }
    expect(calls).toEqual([]);
    expect(windowRequest).not.toHaveBeenCalled();
  });

  it('remote_control.set_allow_incoming refuses a headless turn and changes nothing', async () => {
    const h = setup();
    await expect(
      h.route(
        { type: 'remote_control.set_allow_incoming', enabled: true },
        { toolUseId: 'r' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(calls).toEqual([]);
    expect(allowIncoming).toBe(false);
  });

  it("a chat a connected computer drives is refused, even though that computer's window holds its own ui.app_advisor.present lease (CAN-5823)", async () => {
    const registry = new InterfaceToolRegistry();
    openPresentLease(registry, 'main-1', okReply);
    const remote = openPresentLease(
      registry,
      'remote-bridge-1',
      okReply,
      'device-2',
    );
    setSessionInterfaceToolRegistry(registry);
    setInterfaceToolAudienceResolver(() => 'device-2');
    // The session binds the tool from the driving computer's window.
    expect(registry.availableFor('device-2')).toContain(
      'ui.app_advisor.present',
    );
    const h = setup();
    for (const [index, action] of ALL_ACTIONS.entries())
      await expect(
        h.route(action, bound(`driven-${index}`)),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable' },
      });
    expect(calls).toEqual([]);
    expect(remote).toEqual([]);
    expect(windowRequest).not.toHaveBeenCalled();
  });

  it("a local chat is refused when only another computer's window lease serves the tool, whatever the session claims", async () => {
    const registry = new InterfaceToolRegistry();
    const remote = openPresentLease(
      registry,
      'remote-bridge-1',
      okReply,
      'device-2',
    );
    setSessionInterfaceToolRegistry(registry);
    const h = setup();
    for (const [index, action] of ALL_ACTIONS.entries())
      await expect(
        h.route(action, bound(`remote-only-${index}`)),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'surface_unavailable' },
      });
    expect(calls).toEqual([]);
    expect(remote).toEqual([]);
  });

  it("with the lease bound, runs on main's owners with the renderer's shapes", async () => {
    const h = setup();
    await expect(
      h.route({ type: 'canopy_cloud.load_account' }, bound('a')),
    ).resolves.toMatchObject({
      ok: true,
      result: { connected: true },
    });
    await expect(
      h.route(
        { type: 'remote_control.set_allow_incoming', enabled: true },
        bound('b'),
      ),
    ).resolves.toEqual({
      requestId: 'b',
      ok: true,
      result: { allowIncoming: true },
    });
    await expect(
      h.route({ type: 'remote_control.get_state' }, bound('c')),
    ).resolves.toEqual({
      requestId: 'c',
      ok: true,
      result: {
        signedIn: true,
        relayStatus: 'connected',
        allowIncoming: true,
        hosts: [
          {
            deviceId: 'dev-2',
            name: 'Mini',
            platform: 'darwin',
            online: true,
            connection: 'idle',
          },
        ],
        controllers: [],
        pendingPairingRequests: 0,
      },
    });
    await expect(
      h.route(
        { type: 'remote_control.set_allow_incoming', enabled: true },
        bound('d'),
      ),
    ).resolves.toEqual({
      requestId: 'd',
      ok: true,
      result: { allowIncoming: true },
    });
    await expect(
      h.route(
        { type: 'opencode.connection', operation: 'connect' },
        {
          toolUseId: 'e',
          context: {
            interfaceTools: LEASE,
            signal: new AbortController().signal,
          },
        },
      ),
    ).resolves.toEqual({
      requestId: 'e',
      ok: true,
      result: { value: { connected: true } },
    });
    await expect(
      h.route({ type: 'ollama.install' }, bound('f')),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        mode: 'managed',
        installation: { ready: true, version: '0.9.0' },
      },
    });
    expect(calls).toEqual([
      ['loadCloudAccount', undefined],
      ['setAllowIncoming', true],
      ['setAllowIncoming', true],
      ['openCode', ['connect', true]],
      ['revealOllamaSettings', undefined],
      ['installOllama', undefined],
    ]);
    expect(windowRequest).not.toHaveBeenCalled();
  });

  it("remote_control.set_allow_incoming turns Allow incoming off, a Remote Control refusal is the action's error, and a failed Ollama install is refused with its error", async () => {
    allowIncoming = true;
    ollamaReady = false;
    const h = setup();
    await expect(
      h.route(
        { type: 'remote_control.set_allow_incoming', enabled: false },
        bound('s'),
      ),
    ).resolves.toEqual({
      requestId: 's',
      ok: true,
      result: { allowIncoming: false },
    });
    remoteRefusal = new Error('Sign in before allowing incoming control.');
    await expect(
      h.route(
        { type: 'remote_control.set_allow_incoming', enabled: true },
        bound('p'),
      ),
    ).resolves.toEqual({
      requestId: 'p',
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Sign in before allowing incoming control.',
      },
    });
    expect(allowIncoming).toBe(false);
    await expect(
      h.route({ type: 'ollama.install' }, bound('o')),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'Download failed.' },
    });
    expect(calls.slice(0, 2)).toEqual([
      ['setAllowIncoming', false],
      ['setAllowIncoming', true],
    ]);
  });

  it('no API key appears in any result, error, log line or ledger record', async () => {
    const written: string[] = [];
    const capture = (chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    };
    const spies = [
      jest.spyOn(process.stdout, 'write').mockImplementation(capture),
      jest.spyOn(process.stderr, 'write').mockImplementation(capture),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
        jest.spyOn(console, method).mockImplementation((...args) => {
          written.push(args.map(String).join(' '));
        }),
      ),
    ];
    const h = setup();
    let responses: string;
    try {
      const saved = await h.route(
        { type: 'canopy_cloud.save_api_key', apiKey: SECRET },
        bound('save'),
      );
      const validated = await h.route(
        { type: 'canopy_cloud.validate_api_key', apiKey: SECRET },
        bound('validate'),
      );
      const replayed = await h.route(
        { type: 'canopy_cloud.save_api_key', apiKey: SECRET },
        bound('save'),
      );
      expect(saved).toMatchObject({
        ok: true,
        result: { status: { note: 'saved [redacted]' } },
      });
      expect(validated).toMatchObject({
        ok: false,
        error: { code: 'execution_failed', message: 'Rejected key [redacted]' },
      });
      expect(replayed).toEqual(saved);
      responses = JSON.stringify([saved, validated, replayed]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    // The owners received the key; nothing said back, logged or recorded has it.
    expect(calls).toContainEqual(['saveCloudApiKey', { apiKey: SECRET }]);
    expect(responses).not.toContain(SECRET);
    expect(written.filter((line) => line.includes(SECRET))).toEqual([]);
    operations.close();
    for (const file of readdirSync(root))
      expect({
        file,
        hasKey: readFileSync(join(root, file)).includes(SECRET),
      }).toEqual({ file, hasKey: false });
    operations = new OperationService({
      openLedger: (): OperationLedger =>
        OperationLedger.open(join(root, 'ledger.sqlite')),
    });
  });

  it('a padded key is sent trimmed, and neither form is said back when an owner echoes the trimmed key', async () => {
    const padded = `  ${SECRET}\n`;
    const h = setup();
    const saved = await h.route(
      { type: 'canopy_cloud.save_api_key', apiKey: padded },
      bound('padded-save'),
    );
    const validated = await h.route(
      { type: 'canopy_cloud.validate_api_key', apiKey: padded },
      bound('padded-validate'),
    );
    expect(calls).toContainEqual(['saveCloudApiKey', { apiKey: SECRET }]);
    expect(calls).toContainEqual(['validateCloudApiKey', { apiKey: SECRET }]);
    expect(saved).toMatchObject({
      ok: true,
      result: { status: { note: 'saved [redacted]' } },
    });
    expect(validated).toMatchObject({
      ok: false,
      error: { message: 'Rejected key [redacted]' },
    });
    expect(JSON.stringify([saved, validated])).not.toContain(SECRET);
  });

  it("a Settings surface request carries the advisor's expected UI revision, so the window can refuse a stale one", async () => {
    const delivered = mainLease((call) =>
      (call.input as { expectedUiRevision?: number }).expectedUiRevision === 1
        ? {
            requestId: call.callId,
            ok: false,
            error: { code: 'stale_ui_state', message: 'The UI changed.' },
          }
        : { requestId: call.callId, ok: true },
    );
    const h = setup();
    await expect(
      h.route(
        { type: 'mcp.account_disconnect', serverId: 'srv-1' },
        { ...bound('stale'), expectedUiRevision: 1 },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale_ui_state' },
    });
    expect(
      delivered.map(
        (call) =>
          (call.input as { expectedUiRevision?: number }).expectedUiRevision,
      ),
    ).toEqual([1]);
  });

  it('a retried tool call acts once', async () => {
    const h = setup();
    for (const action of [
      { type: 'canopy_cloud.save_api_key', apiKey: SECRET },
      { type: 'canopy_cloud.start_oauth_login' },
      { type: 'remote_control.set_allow_incoming', enabled: true },
      { type: 'ollama.install' },
    ]) {
      const first = await h.route(action, bound(`retry-${action.type}`));
      const second = await h.route(action, bound(`retry-${action.type}`));
      expect(second).toEqual(first);
    }
    expect(
      calls
        .map(([name]) => name)
        .filter((name) => name !== 'revealOllamaSettings'),
    ).toEqual([
      'saveCloudApiKey',
      'startCloudOAuthLogin',
      'setAllowIncoming',
      'installOllama',
    ]);
  });

  it('the removed canopy_portal names are refused before the router and change nothing (CAN-7345)', async () => {
    const removed: readonly string[] = [
      'canopy_portal.open',
      'canopy_portal.close',
      'canopy_portal.open_account_settings',
      'canopy_portal.start',
      'canopy_portal.stop',
    ];
    const h = setup();
    for (const [index, type] of removed.entries()) {
      expect({
        type,
        parsed: dispatchActionSchema.safeParse({ action: { type } }).success,
        disposition: appAdvisorActionDisposition(type),
      }).toEqual({ type, parsed: false, disposition: undefined });
      const result = await h.dispatch({ type }, `removed-${index}`);
      expect({ type, isError: result.isError }).toEqual({
        type,
        isError: true,
      });
      expect(
        result.text.startsWith('Invalid arguments for DispatchAction.'),
      ).toBe(true);
    }
    expect(calls).toEqual([]);
    expect(allowIncoming).toBe(false);
    expect(windowRequest).not.toHaveBeenCalled();
    // Control: the same helper reaches the router for a current name.
    const allowed = await h.dispatch(
      { type: 'remote_control.set_allow_incoming', enabled: true },
      'removed-control',
    );
    expect(allowed.isError).not.toBe(true);
    expect(JSON.parse(allowed.text)).toMatchObject({
      requestId: 'removed-control',
      ok: true,
      result: { allowIncoming: true },
    });
    expect(calls.map(([name]) => name)).toEqual(['setAllowIncoming']);
  });

  it("Settings surface actions go to the main window's lease once per tool call, never a remote route, and answer the surface's acceptance or refusal", async () => {
    routeRequest.mockReturnValue(
      {} as ReturnType<typeof routeRendererToolRequest>,
    );
    mockBoundTools = [...LEASE];
    const delivered = mainLease((call) =>
      (call.input as { action: { type: string } }).action.type ===
      'cursor.approval_check'
        ? {
            requestId: call.callId,
            ok: false,
            error: {
              code: 'invalid_target',
              message: 'Open Settings to run the check.',
            },
          }
        : { requestId: call.callId, ok: true },
    );
    const h = setup();
    for (const action of SURFACE_ACTIONS) {
      const first = await h.route(action, bound(`surface-${action.type}`));
      const second = await h.route(action, bound(`surface-${action.type}`));
      expect(second).toEqual(first);
      expect({ type: action.type, first }).toEqual({
        type: action.type,
        first:
          action.type === 'cursor.approval_check'
            ? {
                requestId: `surface-${action.type}`,
                ok: false,
                error: {
                  code: 'invalid_target',
                  message: 'Open Settings to run the check.',
                },
              }
            : { requestId: `surface-${action.type}`, ok: true },
      });
    }
    expect(
      delivered.map((call) => ({
        toolName: call.toolName,
        action: (call.input as { action: unknown }).action,
      })),
    ).toEqual(
      SURFACE_ACTIONS.map((action) => ({
        toolName: 'ui.app_advisor.present',
        action,
      })),
    );
    expect(windowRequest).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
