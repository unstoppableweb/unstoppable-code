/**
 * CAN-7082: a saved MCP server's URL and OAuth endpoints a remote-control
 * controller sends back. Drives the real host session over an encrypted
 * session pair into the real registered load and save handlers, on this
 * test's isolated data directory. The controller gets each URL without its
 * credential parts; one it saves back unchanged keeps the stored value, byte
 * for byte, and a changed one is refused while the stored one held a
 * credential. A local window's save is unchanged.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as McpRefRewriteOutcome from '../mcp/server-ref-rewrite-outcome';
import type * as ToolDiscovery from '../mcp/tool-discovery';
import type * as BridgeWindow from '../remote-control/host/bridge-window';

const logged: unknown[][] = [];
jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordAppDiagnostic: (entry: unknown) => void;
  } => ({
    recordAppDiagnostic: (entry: unknown): void => {
      logged.push(['diagnostic', entry]);
    },
  }),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: (...args: unknown[]): void => {
    logged.push(['warn', ...args]);
  },
  logMainProcessError: (...args: unknown[]): void => {
    logged.push(['error', ...args]);
  },
  logMainProcessInfo: (...args: unknown[]): void => {
    logged.push(['info', ...args]);
  },
}));
/** The bridge window a controller's calls reach main from. */
const CONTROLLER_SENDER = 7;
jest.mock('../remote-control/host/bridge-window', () => ({
  ...jest.requireActual<typeof BridgeWindow>(
    '../remote-control/host/bridge-window',
  ),
  resolveRemoteBridgeSender: (sender: { id: number }): string | null =>
    sender.id === CONTROLLER_SENDER ? 'controller-device' : null,
}));
jest.mock('../canopy-runtime/mcp-removal-dispatch', () => ({}));
jest.mock('../canopy-cloud/mcp-connections', () => ({}));
jest.mock('../mcp/account-catalog', () => ({
  accountMcpConnectionsEnabled: (): boolean => false,
  withAccountMcpInventory: (index: unknown): Promise<unknown> =>
    Promise.resolve(index),
  normalizeAccountMcpSelections: (selections: unknown): Promise<unknown> =>
    Promise.resolve(selections),
}));
jest.mock('../mcp/account-routing', () => ({
  readMcpAccountIndexEntry: (): Promise<undefined> =>
    Promise.resolve(undefined),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  subscribeCanopyCloudAccountChanges: jest.fn(),
}));
jest.mock('../mcp/server-ref-rewrite', () => ({}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn().mockResolvedValue({
    mcpHttpAuthDefaultHandler: 'canopy',
    mcpProxyPort: 4321,
  }),
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    setWindowAccessor: jest.fn(),
    setBroadcastHandlers: jest.fn(),
    refreshPreferredPortStatus: jest.fn(),
  })),
}));
jest.mock('../lib/auth-failure-resume', () => ({}));
jest.mock('../mcp/oauth-client', () => ({
  setMcpOAuthSettledListener: jest.fn(),
}));
jest.mock('../mcp/oauth-token-store', () => ({
  setMcpOAuthTokensChangedListener: jest.fn(),
  getMcpOAuthAuthStatusForDefinition: jest.fn().mockResolvedValue({
    status: 'not_connected',
    hasStoredToken: false,
  }),
  getMcpOAuthTokenRevision: jest.fn().mockResolvedValue(0),
  clearMcpOAuthToken: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/window-send', () => ({}));
jest.mock('../plugins/plugin-service', () => ({}));
jest.mock('../plugins/plugin-resolver', () => ({}));
jest.mock('../lib/open-external', () => ({}));
jest.mock('../mcp/provider-connectors', () => ({}));
jest.mock('../services/desktop-inventory-sync-signals', () => ({
  notifyDesktopInventoryChanged: jest.fn(),
}));
jest.mock('../installed-items/installed-item-events', () => ({
  notifyInstalledItemsChanged: jest.fn(),
}));
jest.mock('../mcp/curated-catalog', () => ({}));
jest.mock('../mcp/curated-plugin-binding', () => ({}));
jest.mock('../mcp/remote-image-cache', () => ({
  configureRemoteImageDiskCache: jest.fn(),
  resolveRemoteImageDataUrl: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../mcp/tool-discovery', () => ({
  mergeConfigIntoDefinition: jest.requireActual<typeof ToolDiscovery>(
    '../mcp/tool-discovery',
  ).mergeConfigIntoDefinition,
  mcpToolsSourceFingerprint: jest.fn().mockResolvedValue('fixture'),
  writeMcpToolsCacheEntry: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../mcp/connection-status', () => ({
  getMcpServerHealth: jest.fn(),
  getMcpServerHealthGeneration: (): number => 0,
  recordMcpServerHealth: (): boolean => false,
}));
jest.mock('../agents/session-manager', () => ({}));
jest.mock('../mcp/server-ref-rewrite-outcome', () => ({
  ...jest.requireActual<typeof McpRefRewriteOutcome>(
    '../mcp/server-ref-rewrite-outcome',
  ),
  inMcpRefRewritePhase: <T>(
    _phase: string,
    run: () => Promise<T>,
  ): Promise<T> => run(),
}));
jest.mock('../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => false,
}));
jest.mock('../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: (): boolean => false,
}));
jest.mock('../opencode/feature-flag', () => ({
  isOpenCodeHarnessEnabled: (): boolean => false,
}));
jest.mock('../auth/provider-auth-state', () => ({
  getCachedClaudeAuthStatusObserved: (): Promise<{ authenticated: boolean }> =>
    Promise.resolve({ authenticated: false }),
  getCachedCodexAuthStatusObserved: (): Promise<{ authenticated: boolean }> =>
    Promise.resolve({ authenticated: false }),
}));
jest.mock('../agents/user-supplied-credential', () => ({
  hasUserSuppliedProviderCredential: (): boolean => false,
}));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));

import type { McpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
import { registerIpcHandler } from '../ipc/register';
import { registerMcpServerHandlers } from '../ipc/mcp-servers';
import { getMcpServerFilePath } from '../lib/paths';
import { CONTROLLER_SERVER_URL_CHANGED } from '../mcp/server-secret-view';
import { controllerCredentialFreeUrl } from '../remote-control/host/controller-remote-urls';
import type { HostBridge } from '../remote-control/host/bridge-window';
import { RemoteHostSession } from '../remote-control/host/host-session';
import { RemoteUploadStore } from '../remote-control/host/uploads';
import {
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
} from '../remote-control/remote-protocol';
import { RpcPeer, RpcPublicError } from '../remote-control/transport/rpc-peer';
import {
  flushRelay,
  InMemoryRelayHub,
} from '../remote-control/__tests__/in-memory-relay';
import {
  createTestDevice,
  openControlSession,
} from '../remote-control/__tests__/session-pair';

const VERSION = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  appVersion: '1.4.0',
};
const SERVER_ID = 'c7082a';
const STORED = {
  url: 'https://svc:pa55word@mcp.example.invalid:8443/mcp?ref=main&token=t0k3n',
  authorizationUrl: 'https://auth.example.invalid/authorize?access_token=t0k3n',
  tokenUrl: 'https://tok3nuser:pa55word@auth.example.invalid/token',
};
const SECRETS = /pa55word|t0k3n|tok3nuser|h3ader/;
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

function storedFile(urls: typeof STORED): McpServerFile {
  return {
    version: 1,
    server: {
      definition: {
        id: SERVER_ID,
        name: 'Fixture',
        description: '',
        type: 'http',
        url: urls.url,
        headers: { Authorization: 'Bearer h3ader' },
        oauth: {
          clientId: 'client',
          authorizationUrl: urls.authorizationUrl,
          tokenUrl: urls.tokenUrl,
        },
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      configs: [],
    },
  };
}

async function writeStored(file: McpServerFile): Promise<void> {
  const filename = getMcpServerFilePath(SERVER_ID);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(file));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value[key]` when `value` is an object holding an object there. */
function record(value: unknown, key: string): Record<string, unknown> {
  const found = isRecord(value) ? value[key] : undefined;
  if (!isRecord(found)) throw new Error(`no ${key}`);
  return found;
}

async function readStored(): Promise<Record<string, unknown>> {
  const file: unknown = JSON.parse(
    await readFile(getMcpServerFilePath(SERVER_ID), 'utf8'),
  );
  return record(record(file, 'server'), 'definition');
}

function handler(channel: string): (...args: unknown[]) => unknown {
  const registered = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([name]) => name === channel)?.[1];
  if (!registered) throw new Error(`Missing ${channel} handler`);
  return (...args: unknown[]): unknown =>
    Reflect.apply(registered, undefined, args);
}

interface Harness {
  controller: RpcPeer;
  close: () => void;
}

/** A controller whose calls reach the real handlers from its bridge window. */
async function harness(): Promise<Harness> {
  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, 'Laptop');
  const studio = createTestDevice(hub, 'Studio');
  await flushRelay();
  const { initiator, responder } = await openControlSession(laptop, studio);
  const bridge: HostBridge = {
    getChatInterest: (): undefined => undefined,
    window: null,
    // As the bridge window relays a handler's failure: its message, as text
    // the controller reads.
    invoke: async (channel: string, args: unknown[]): Promise<unknown> => {
      try {
        return await handler(channel)(
          { sender: { id: CONTROLLER_SENDER } },
          ...args,
        );
      } catch (error) {
        throw new RpcPublicError(
          error instanceof Error ? error.message : 'Remote call failed.',
        );
      }
    },
    post: (): void => undefined,
    onPush: (): (() => void) => (): void => undefined,
    onClosed: (): (() => void) => (): void => undefined,
    destroy: (): void => undefined,
  };
  const session = new RemoteHostSession({
    session: responder,
    kind: 'desktop',
    attributedDeviceId: responder.peerDeviceId,
    createBridge: (): Promise<HostBridge> => Promise.resolve(bridge),
    mainWindowPushes: { subscribe: (): (() => void) => (): void => undefined },
    uploads: new RemoteUploadStore(
      join(tmpdir(), 'mcp-controller-url-uploads'),
    ),
    readFile: (): Promise<never> =>
      Promise.reject(new Error('no reads in this test')),
    disposition: (): 'tunnel' => 'tunnel',
    isAuthorized: (): boolean => true,
    version: VERSION,
    hello: (): { name: string; platform: 'darwin' } => ({
      name: 'Studio',
      platform: 'darwin',
    }),
    onClose: (): void => undefined,
  });
  const controller = new RpcPeer(initiator, {
    onRequest: (): Promise<never> =>
      Promise.reject(new Error('unexpected request')),
    onEvent: (): void => undefined,
  });
  await controller.request(REMOTE_METHODS.hello, { version: VERSION });
  await session.start();
  return {
    controller,
    close: (): void => {
      controller.close('closed');
      session.rpc.close('closed');
    },
  };
}

beforeAll(() => {
  registerMcpServerHandlers(() => null);
});

describe("a saved MCP server's URLs a paired controller sends back (CAN-7082)", () => {
  let current: Harness | null = null;
  let spies: jest.SpyInstance[] = [];
  beforeEach(async () => {
    logged.length = 0;
    spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      jest.spyOn(console, name).mockImplementation(() => undefined),
    );
    await writeStored(storedFile(STORED));
    current = await harness();
  });
  afterEach(() => {
    current?.close();
    current = null;
    for (const spy of spies) spy.mockRestore();
  });

  const invoke = (channel: string, args: unknown[]): Promise<unknown> => {
    if (!current) throw new Error('no harness');
    return current.controller.request(REMOTE_METHODS.invoke, { channel, args });
  };

  /** The server as the controller loads it, with `change` applied to its definition. */
  async function loaded(
    change: (definition: Record<string, unknown>) => Record<string, unknown> = (
      definition,
    ) => definition,
  ): Promise<unknown> {
    const view = await invoke(MCP_SERVER_CHANNELS.LOAD_SERVER, [SERVER_ID]);
    expect(JSON.stringify(view)).not.toMatch(SECRETS);
    const server = record(view, 'server');
    return { ...server, definition: change(record(server, 'definition')) };
  }

  function everythingLogged(): string {
    const calls: unknown[] = spies.map((spy): unknown => spy.mock.calls);
    return JSON.stringify([...logged, ...calls]);
  }

  it('keeps every stored URL byte for byte when the controller saves the server back unchanged', async () => {
    const view = await loaded();
    expect(record(view, 'definition')).toMatchObject({
      url: 'https://mcp.example.invalid:8443/mcp?ref=main',
      oauth: {
        authorizationUrl: 'https://auth.example.invalid/authorize',
        tokenUrl: 'https://auth.example.invalid/token',
      },
    });
    const saved = await invoke(MCP_SERVER_CHANNELS.SAVE_SERVER, [view]);
    expect(JSON.stringify(saved)).not.toMatch(SECRETS);
    expect(await readStored()).toMatchObject({
      url: STORED.url,
      headers: { Authorization: 'Bearer h3ader' },
      oauth: {
        authorizationUrl: STORED.authorizationUrl,
        tokenUrl: STORED.tokenUrl,
      },
    });
  });

  it('refuses a changed URL or endpoint, leaving the stored server as it was, with no credential in the error or logs', async () => {
    const changes: ReadonlyArray<readonly [string, string]> = [
      ...[
        'https://other.example.invalid:8443/mcp?ref=main',
        'https://MCP.example.invalid:8443/mcp?ref=main',
        'https://mcp.example.invalid/mcp?ref=main',
        'https://mcp.example.invalid:443/mcp?ref=main',
        'http://mcp.example.invalid:8443/mcp?ref=main',
        'https://mcp.example.invalid:8443/mcp/?ref=main',
        'https://mcp.example.invalid:8443/other?ref=main',
        'https://mcp.example.invalid:8443/mcp?ref=dev',
      ].map((url): readonly [string, string] => ['url', url]),
      ['authorizationUrl', 'https://other.example.invalid/authorize'],
      ['tokenUrl', 'https://auth.example.invalid/token2'],
    ];
    /** Every piece of a URL an error could quote: whole, host, path, query values. */
    const pieces = (url: string): string[] => {
      const parsed = new URL(url);
      return [
        url,
        parsed.host,
        parsed.pathname,
        ...[...parsed.searchParams.values()],
      ].filter((piece) => piece.length > 1);
    };
    const storedPieces = Object.values(STORED).flatMap(pieces);
    for (const [field, sent] of changes) {
      const error = await invoke(MCP_SERVER_CHANNELS.SAVE_SERVER, [
        await loaded((definition) =>
          field === 'url'
            ? { ...definition, url: sent }
            : {
                ...definition,
                oauth: { ...record(definition, 'oauth'), [field]: sent },
              },
        ),
      ]).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : '';
      expect(message).toBe(CONTROLLER_SERVER_URL_CHANGED);
      for (const text of [message, String(error), JSON.stringify(error)]) {
        expect(text).not.toMatch(SECRETS);
        for (const piece of [...pieces(sent), ...storedPieces])
          expect(text).not.toContain(piece);
      }
      expect(await readStored()).toEqual(storedFile(STORED).server.definition);
    }
    expect(everythingLogged()).not.toMatch(SECRETS);
  });

  it('stores a URL whose credential the controller typed exactly as sent', async () => {
    const url = 'https://other.example.invalid/mcp?token=n3w';
    // A new destination takes its header secret re-entered too (CAN-4411).
    await invoke(MCP_SERVER_CHANNELS.SAVE_SERVER, [
      await loaded((definition) => ({
        ...definition,
        url,
        headers: { Authorization: 'Bearer n3w' },
      })),
    ]);
    const stored = await readStored();
    expect(stored.url).toBe(url);
    expect(JSON.stringify(stored.url)).not.toMatch(SECRETS);
  });

  it('keeps a stored endpoint the controller got as empty and its form left out', async () => {
    // A name:port authority with an @ after it fails closed to '' for
    // controllers, but stays a valid endpoint on this computer.
    const failClosed = {
      ...STORED,
      authorizationUrl: 'https://auth.example.invalid:8443/authorize@v2',
      tokenUrl: 'https://auth.example.invalid:8443/token@v2',
    };
    expect(controllerCredentialFreeUrl(failClosed.authorizationUrl)).toBe('');
    expect(controllerCredentialFreeUrl(failClosed.tokenUrl)).toBe('');
    // No saved header, whose own destination check would refuse the save.
    const file = storedFile(failClosed);
    await writeStored({
      ...file,
      server: {
        ...file.server,
        // The JSON written drops the key.
        definition: { ...file.server.definition, headers: undefined },
      },
    });
    await invoke(MCP_SERVER_CHANNELS.SAVE_SERVER, [
      await loaded((definition) => {
        const oauth = record(definition, 'oauth');
        expect(oauth).toMatchObject({ authorizationUrl: '', tokenUrl: '' });
        return {
          ...definition,
          description: 'An unrelated edit',
          oauth: Object.fromEntries(
            Object.entries(oauth).filter(
              ([key]) => key !== 'authorizationUrl' && key !== 'tokenUrl',
            ),
          ),
        };
      }),
    ]);
    const stored = await readStored();
    expect(stored.description).toBe('An unrelated edit');
    expect(stored.oauth).toEqual(
      storedFile(failClosed).server.definition.oauth,
    );
  });

  it('stores plain edits to a URL that held no credential as sent', async () => {
    await writeStored(
      storedFile({
        ...STORED,
        url: 'https://mcp.example.invalid/mcp',
      }),
    );
    await invoke(MCP_SERVER_CHANNELS.SAVE_SERVER, [
      await loaded((definition) => ({
        ...definition,
        url: 'https://moved.example.invalid/mcp',
        headers: { Authorization: 'Bearer n3w' },
      })),
    ]);
    expect((await readStored()).url).toBe('https://moved.example.invalid/mcp');
  });

  it("leaves a local window's load and save unchanged, including removing a credential", async () => {
    const load = handler(MCP_SERVER_CHANNELS.LOAD_SERVER);
    const save = handler(MCP_SERVER_CHANNELS.SAVE_SERVER);
    const local = { sender: { id: 1 } };
    const view = await load(local, SERVER_ID);
    const server = record(view, 'server');
    expect(record(server, 'definition')).toMatchObject({
      url: STORED.url,
      oauth: {
        authorizationUrl: STORED.authorizationUrl,
        tokenUrl: STORED.tokenUrl,
      },
    });
    await save(local, server);
    expect(await readStored()).toMatchObject({
      url: STORED.url,
      oauth: {
        authorizationUrl: STORED.authorizationUrl,
        tokenUrl: STORED.tokenUrl,
      },
    });
    await save(local, {
      ...server,
      definition: {
        ...record(server, 'definition'),
        url: 'https://mcp.example.invalid:8443/mcp',
      },
    });
    expect((await readStored()).url).toBe(
      'https://mcp.example.invalid:8443/mcp',
    );
  });
});
