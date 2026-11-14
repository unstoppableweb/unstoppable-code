/**
 * The reach-back opt-in, off switch and call log over IPC (CAN-6176 PR 7c):
 * cloud-reach-back:list, cloud-reach-back:activity, cloud-reach-back:allow
 * and cloud-reach-back:disallow answer only the app's own main window, and
 * refuse any other sender before anything runs. An allow is validated,
 * granted only to the account the person agreed under, and refused while
 * cloud chats are off or signed out; turning a server off works
 * with the flag off too, since it only ever stops serving.
 */
import {
  IPC_CHANNELS,
  type CloudReachBackResult,
} from '@canopy/desktop-shared/types';
import type { RendererRelayEvent } from '../../canopy-runtime/renderer-relay/relay';
import { ReachBackSignedOutError } from '../../mcp/cloud-reach-back/controller';
import type { CloudReachBack } from '../../mcp/cloud-reach-back/runtime';

const mockHandlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => Promise<unknown>
>();
const mockState = { enabled: true, accountId: 'acct-1' as string | null };

jest.mock('../register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../cloud-chats', () => ({
  cloudChatsEnabled: (): boolean => mockState.enabled,
  signedInAccountId: (): Promise<string | null> =>
    Promise.resolve(mockState.accountId),
}));
jest.mock('../../mcp/cloud-reach-back/start', () => ({
  getCloudReachBack: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import { registerCloudReachBackHandlers } from '../cloud-reach-back';

const MAIN = { sender: 'main' } as unknown as RendererRelayEvent;
const ADVISOR = { sender: 'advisor' } as unknown as RendererRelayEvent;

const SERVER = {
  serverId: 'tracker',
  configId: 'default',
  displayName: 'Tracker',
  enabledTools: ['create_issue'],
  allowWithoutAsking: [],
  allowedAt: '2026-11-10T19:00:00.000Z',
};

function fakeReachBack(): {
  readonly reachBack: CloudReachBack;
  readonly allowed: unknown[];
  readonly disallowed: [string, string][];
  signedOut: boolean;
} {
  const allowed: unknown[] = [];
  const disallowed: [string, string][] = [];
  const state = { signedOut: false };
  const reachBack = {
    allowList: { list: () => Promise.resolve([SERVER]) },
    reachability: {
      cause: (accountId: string, serverId: string, configId: string) =>
        accountId === 'acct-1' &&
        serverId === 'tracker' &&
        configId === 'default'
          ? 'MCP proxy port 37645 is already in use. Choose another port.'
          : null,
    },
    log: {
      list: () =>
        Promise.resolve([
          {
            at: '2026-11-10T19:01:00.000Z',
            chat: { id: 'chat-1', title: 'Plan the launch' },
            serverId: 'tracker',
            configId: 'default',
            toolName: 'create_issue',
            decision: 'asked_allowed',
            status: 200,
          },
        ]),
    },
    controller: {
      allow: (input: unknown, expectedAccountId: unknown): Promise<void> => {
        if (state.signedOut)
          return Promise.reject(new ReachBackSignedOutError());
        allowed.push({ input, expectedAccountId });
        return Promise.resolve();
      },
      disallow: (serverId: string, configId: string): Promise<boolean> => {
        disallowed.push([serverId, configId]);
        return Promise.resolve(true);
      },
    },
  } as unknown as CloudReachBack;
  return {
    reachBack,
    allowed,
    disallowed,
    get signedOut() {
      return state.signedOut;
    },
    set signedOut(value: boolean) {
      state.signedOut = value;
    },
  };
}

function invoke(
  channel: string,
  event: RendererRelayEvent,
  ...args: unknown[]
): Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} is not registered.`);
  // As `registerIpcHandler` does, a thrown refusal rejects the invoke.
  return Promise.resolve().then(() => handler(event, ...args));
}

describe('cloud reach-back IPC (CAN-6176 PR 7c)', () => {
  let fake: ReturnType<typeof fakeReachBack>;
  let served = 0;

  beforeEach(() => {
    mockHandlers.clear();
    mockState.enabled = true;
    mockState.accountId = 'acct-1';
    fake = fakeReachBack();
    served = 0;
    registerCloudReachBackHandlers(
      (event) =>
        ({
          surface: event === MAIN ? 'main' : 'app-advisor',
        }) as ReturnType<Parameters<typeof registerCloudReachBackHandlers>[0]>,
      () => {
        served += 1;
        return Promise.resolve(fake.reachBack);
      },
    );
  });

  it('answers only the main window, refusing any other sender before anything runs', async () => {
    for (const channel of [
      IPC_CHANNELS.cloudReachBackList,
      IPC_CHANNELS.cloudReachBackActivity,
      IPC_CHANNELS.cloudReachBackAllow,
      IPC_CHANNELS.cloudReachBackDisallow,
    ])
      await expect(
        invoke(channel, ADVISOR, 'tracker', 'default'),
      ).rejects.toThrow('Untrusted');
    expect(served).toBe(0);
    expect(fake.disallowed).toEqual([]);

    // Each server says why its last cloud chat call couldn't reach it.
    await expect(
      invoke(IPC_CHANNELS.cloudReachBackList, MAIN),
    ).resolves.toEqual([
      {
        ...SERVER,
        unreachable:
          'MCP proxy port 37645 is already in use. Choose another port.',
      },
    ]);
    await expect(
      invoke(IPC_CHANNELS.cloudReachBackActivity, MAIN),
    ).resolves.toEqual([
      expect.objectContaining({ toolName: 'create_issue', status: 200 }),
    ]);
  });

  it('validates an allow, ties it to the account it was agreed for, and refuses it while cloud chats are off or signed out', async () => {
    const request = {
      expectedAccountId: 'acct-1',
      serverId: 'tracker',
      configId: 'default',
      displayName: 'Tracker',
      enabledTools: ['create_issue'],
      allowWithoutAsking: [],
    };
    await expect(
      invoke(IPC_CHANNELS.cloudReachBackAllow, MAIN, {
        ...request,
        serverId: '../etc',
      }),
    ).resolves.toEqual({ ok: false, reason: 'rejected' });
    await expect(
      invoke(IPC_CHANNELS.cloudReachBackAllow, MAIN, {
        ...request,
        extra: true,
      }),
    ).resolves.toEqual({ ok: false, reason: 'rejected' });
    expect(fake.allowed).toEqual([]);

    await expect(
      invoke(IPC_CHANNELS.cloudReachBackAllow, MAIN, request),
    ).resolves.toEqual({ ok: true });
    const { expectedAccountId, ...optIn } = request;
    // The controller checks the account again across its cloud call.
    expect(fake.allowed).toEqual([{ input: optIn, expectedAccountId }]);

    // Agreed while another account was signed in: never granted to this one.
    await expect(
      invoke(IPC_CHANNELS.cloudReachBackAllow, MAIN, {
        ...request,
        expectedAccountId: 'acct-2',
      }),
    ).resolves.toEqual({ ok: false, reason: 'signed_out' });
    expect(fake.allowed).toHaveLength(1);

    fake.signedOut = true;
    await expect(
      invoke(IPC_CHANNELS.cloudReachBackAllow, MAIN, request),
    ).resolves.toEqual({ ok: false, reason: 'signed_out' });

    mockState.enabled = false;
    await expect(
      invoke(IPC_CHANNELS.cloudReachBackAllow, MAIN, request),
    ).resolves.toEqual({ ok: false, reason: 'disabled' });
    await expect(
      invoke(IPC_CHANNELS.cloudReachBackList, MAIN),
    ).resolves.toEqual([]);
    expect(fake.allowed).toHaveLength(1);
  });

  it('turns a server off with the flag off too, and refuses invalid ids', async () => {
    mockState.enabled = false;
    await expect(
      invoke(IPC_CHANNELS.cloudReachBackDisallow, MAIN, 'tracker', 'default'),
    ).resolves.toEqual<CloudReachBackResult>({ ok: true, cloudRemoved: true });
    await expect(
      invoke(IPC_CHANNELS.cloudReachBackDisallow, MAIN, 'tracker', 'a b'),
    ).resolves.toEqual({ ok: false, reason: 'rejected' });
    expect(fake.disallowed).toEqual([['tracker', 'default']]);
  });
});
