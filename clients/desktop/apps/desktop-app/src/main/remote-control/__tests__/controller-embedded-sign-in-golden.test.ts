/**
 * CAN-7030: an embedded account MCP sign-in mints an authenticated portal
 * link for this computer's cloud account and returns it. Drives the real host
 * session over an encrypted session pair, with the bridge answering
 * `mcp-servers:start-account` through the real `startAccountMcpConnection`;
 * only the cloud client, the portal link minting and the external browser are
 * fakes. No controller kind gets a minted link, the external sign-in still
 * works from a controller, and the local window still gets its link.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceKind } from '@canopy/protocol/device-relay';
import { MCP_SERVER_CHANNELS } from '@canopy/desktop-shared/constants/mcp-server-channels';
jest.mock('../../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: () => void } => ({
    recordAppDiagnostic: (): void => undefined,
  }),
}));
jest.mock('../../canopy-cloud/authenticated-portal', () => ({
  mintAuthenticatedPortalUrl: jest.fn(),
  openAuthenticatedPortalPage: jest.fn(),
}));
jest.mock('../../mcp/oauth-client', () => ({ openExternalUrl: jest.fn() }));
jest.mock('../../canopy-cloud/client', () => ({
  ...jest.requireActual<object>('../../canopy-cloud/client'),
  assertCanopyCloudCapability: jest.fn(),
  requestCanopyCloudJson: jest.fn(),
  resolveCanopyCloudCredentialContext: jest.fn(),
}));
import {
  mintAuthenticatedPortalUrl,
  openAuthenticatedPortalPage,
} from '../../canopy-cloud/authenticated-portal';
import {
  requestCanopyCloudJson,
  resolveCanopyCloudCredentialContext,
} from '../../canopy-cloud/client';
import { startAccountMcpConnection } from '../../canopy-cloud/mcp-connections';
import type { HostBridge } from '../host/bridge-window';
import {
  CONTROLLER_EMBEDDED_SIGN_IN_REFUSAL,
  CONTROLLER_REFUSED_CALLS,
} from '../host/controller-invoke-refusals';
import { RemoteHostSession } from '../host/host-session';
import { RemoteUploadStore } from '../host/uploads';
import {
  REMOTE_EVENTS,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
} from '../remote-protocol';
import { RpcPeer } from '../transport/rpc-peer';
import { flushRelay, InMemoryRelayHub } from './in-memory-relay';
import { createTestDevice, openControlSession } from './session-pair';

const VERSION = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  appVersion: '1.4.0',
};
const START = MCP_SERVER_CHANNELS.START_ACCOUNT;
const AUTHORIZATION_URL = 'https://provider.invalid/authorize?client_id=app';
const MINTED_URL = 'https://cloud.invalid/auth/consume?token=minted-secret';
const CREDENTIALS = {
  baseUrl: 'https://cloud.invalid',
  apiKey: 'api-key',
  account: {
    id: 'account-1',
    name: 'Someone',
    email: 'someone@example.invalid',
    role: 'DEVELOPER' as const,
  },
};
const KINDS: readonly DeviceKind[] = ['desktop', 'browser', 'hosted', 'mobile'];

const mint = jest.mocked(mintAuthenticatedPortalUrl);
const openPortal = jest.mocked(openAuthenticatedPortalPage);
const cloudRequest = jest.mocked(requestCanopyCloudJson);

/** The request the IPC handler would pass on, for the fixtures below. */
function startRequest(
  value: unknown,
): Parameters<typeof startAccountMcpConnection>[0] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('serverKey' in value) ||
    typeof value.serverKey !== 'string' ||
    !('configId' in value) ||
    typeof value.configId !== 'string'
  )
    throw new Error('Unexpected start request in this test.');
  return {
    serverKey: value.serverKey,
    configId: value.configId,
    ...('browser' in value && value.browser === 'embedded'
      ? { browser: 'embedded' as const }
      : {}),
  };
}

interface Harness {
  controller: RpcPeer;
  bridgeCalls: string[];
  close: () => void;
}

async function harness(kind: DeviceKind): Promise<Harness> {
  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, 'Laptop');
  const studio = createTestDevice(hub, 'Studio');
  await flushRelay();
  const { initiator, responder } = await openControlSession(laptop, studio);
  const bridgeCalls: string[] = [];
  const bridge: HostBridge = {
    getChatInterest: (): undefined => undefined,
    window: null,
    invoke: (channel: string, args: unknown[]): Promise<unknown> => {
      bridgeCalls.push(channel);
      return channel === START
        ? startAccountMcpConnection(startRequest(args[0]))
        : Promise.resolve(null);
    },
    post: (channel: string): void => {
      bridgeCalls.push(channel);
    },
    onPush: (): (() => void) => (): void => undefined,
    onClosed: (): (() => void) => (): void => undefined,
    destroy: (): void => undefined,
  };
  const session = new RemoteHostSession({
    session: responder,
    kind,
    attributedDeviceId: responder.peerDeviceId,
    createBridge: (): Promise<HostBridge> => Promise.resolve(bridge),
    mainWindowPushes: {
      subscribe: (): (() => void) => (): void => undefined,
    },
    uploads: new RemoteUploadStore(
      join(tmpdir(), 'controller-sign-in-uploads'),
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
    bridgeCalls,
    close: (): void => {
      controller.close('closed');
      session.rpc.close('closed');
    },
  };
}

function invoke(controller: RpcPeer, args: unknown[]): Promise<unknown> {
  return controller.request(REMOTE_METHODS.invoke, { channel: START, args });
}

let current: Harness | undefined;

beforeEach(() => {
  jest
    .mocked(resolveCanopyCloudCredentialContext)
    .mockResolvedValue(CREDENTIALS);
  cloudRequest.mockResolvedValue({
    authorizationUrl: AUTHORIZATION_URL,
    signInPath: '/api/mcp-connections/authorize?state=abc',
  });
  mint.mockResolvedValue(MINTED_URL);
  openPortal.mockResolvedValue(true);
});

afterEach(() => {
  current?.close();
  current = undefined;
  jest.clearAllMocks();
});

describe('embedded account sign-in from a controller (CAN-7030)', () => {
  it.each(KINDS)(
    'refuses an embedded start from a %s controller before anything is minted',
    async (kind) => {
      current = await harness(kind);
      const outcome = invoke(current.controller, [
        { serverKey: 'linear', configId: 'config-1', browser: 'embedded' },
      ]);
      await expect(outcome).rejects.toMatchObject(
        kind === 'desktop'
          ? {
              code: 'remote_controller_refused',
              message: CONTROLLER_EMBEDDED_SIGN_IN_REFUSAL,
            }
          : {},
      );
      expect(current.bridgeCalls).toEqual([]);
      expect(cloudRequest).not.toHaveBeenCalled();
      expect(mint).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['no request', []],
    ['a string', ['embedded']],
    ['an array', [[{ browser: 'embedded' }]]],
    ['null', [null]],
    ['another browser value', [{ configId: 'c', browser: 'EMBEDDED' }]],
    ['a null browser', [{ configId: 'c', browser: null }]],
  ])('refuses a controller start with %s', async (_label, args) => {
    current = await harness('desktop');
    await expect(invoke(current.controller, args)).rejects.toMatchObject({
      code: 'remote_controller_refused',
    });
    expect(current.bridgeCalls).toEqual([]);
    expect(mint).not.toHaveBeenCalled();
  });

  it('drops an embedded start a controller sends instead of invoking', async () => {
    current = await harness('desktop');
    current.controller.notify(REMOTE_EVENTS.ipcSend, {
      channel: START,
      args: [{ serverKey: 'linear', configId: 'c', browser: 'embedded' }],
    });
    for (let index = 0; index < 5; index += 1) await flushRelay();
    expect(current.bridgeCalls).toEqual([]);
    expect(mint).not.toHaveBeenCalled();
  });

  it('lets a controller start the external sign-in, which carries no minted link', async () => {
    current = await harness('desktop');
    const result = await invoke(current.controller, [
      { serverKey: 'linear', configId: 'config-1' },
    ]);
    expect(result).toEqual({ authorizationUrl: AUTHORIZATION_URL });
    expect(current.bridgeCalls).toEqual([START]);
    expect(mint).not.toHaveBeenCalled();
    // The host opens the sign-in in its own browser.
    expect(openPortal).toHaveBeenCalledTimes(1);
  });

  it('still mints the embedded link for the local window', async () => {
    const result = await startAccountMcpConnection({
      serverKey: 'linear',
      configId: 'config-1',
      browser: 'embedded',
    });
    expect(result).toEqual({
      authorizationUrl: AUTHORIZATION_URL,
      embeddedUrl: MINTED_URL,
    });
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('records exactly the refused calls in remote-url-fields.json', () => {
    const recorded: unknown = JSON.parse(
      readFileSync(join(__dirname, '..', 'remote-url-fields.json'), 'utf8'),
    );
    const refused =
      typeof recorded === 'object' && recorded !== null && 'refused' in recorded
        ? recorded.refused
        : undefined;
    const byChannel = new Map<string, string[]>();
    const groups: unknown[] = Array.isArray(refused) ? refused : [];
    for (const group of groups) {
      if (
        typeof group !== 'object' ||
        group === null ||
        !('field' in group) ||
        typeof group.field !== 'string' ||
        !('channels' in group) ||
        !Array.isArray(group.channels)
      )
        throw new Error('Malformed refused entry.');
      const field = group.field;
      const channels: unknown[] = group.channels;
      for (const channel of channels)
        if (typeof channel === 'string')
          byChannel.set(channel, [...(byChannel.get(channel) ?? []), field]);
    }
    expect(
      Object.fromEntries(
        [...byChannel].map(([channel, fields]): [string, string[]] => [
          channel,
          fields.sort(),
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(CONTROLLER_REFUSED_CALLS).map(
          ([channel, { fields }]): [string, string[]] => [
            channel,
            [...fields].sort(),
          ],
        ),
      ),
    );
  });
});
