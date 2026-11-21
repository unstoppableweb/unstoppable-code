/**
 * CAN-5771: Electron main's daemon owner session connects as owner only to
 * the daemon this app spawned, declares only the lease, runtime reads, the
 * host request channel and the split-lock fence publish (CAN-4730 E2-G), and
 * never spawns a daemon.
 */
const mockIsSpawnedDaemon = jest.fn<Promise<boolean>, [AbortSignal]>();
const mockOwnerConnect = jest.fn<Promise<unknown>, [unknown]>();
const mockHost = {
  authorityId: 'authority-1',
  launch: {
    dataRootHash: 'a'.repeat(64),
    ports: { descriptor: {}, supervisor: {} },
  },
  owner: {
    isSpawnedDaemon: (signal: AbortSignal): Promise<boolean> =>
      mockIsSpawnedDaemon(signal),
    hasSpawned: (): boolean => true,
    connect: (options: unknown): Promise<unknown> => mockOwnerConnect(options),
  },
};
jest.mock('../electron-daemon-access', () => ({
  getElectronDaemonHost: (): Promise<unknown> => Promise.resolve(mockHost),
  peekElectronDaemonHost: (): unknown => mockHost,
}));
const mockAttachOrStart = jest.fn();
const mockProbe = jest.fn(
  async (options: {
    connect: (endpoint: unknown, setup: unknown) => Promise<unknown>;
  }): Promise<unknown> => ({
    kind: 'live',
    descriptor: {},
    value: await options.connect(
      { kind: 'socket', path: '/run/core.sock', auth: {} },
      { timeoutMs: 1_000, signal: new AbortController().signal },
    ),
  }),
);
jest.mock('@canopy/core-client/node', () => ({
  ...jest.requireActual<object>('@canopy/core-client/node'),
  attachOrStartCanopyDaemon: (...args: unknown[]): unknown =>
    mockAttachOrStart(...args),
  probeCanopyDaemon: (options: {
    connect: (endpoint: unknown, setup: unknown) => Promise<unknown>;
  }): Promise<unknown> => mockProbe(options),
}));
// The service's lease is covered by its own tests; this one plays it, so the
// owner's attach runs as the service would run it.
const mockServiceOptions: Record<string, unknown>[] = [];
const mockCallers: unknown[] = [];
jest.mock('../electron-daemon-connection', () => ({
  ...jest.requireActual<object>('../electron-daemon-connection'),
  createElectronDaemonConnectionService: (options: {
    attach: (signal: AbortSignal) => Promise<unknown>;
  }): unknown => {
    mockServiceOptions.push(options);
    return {
      get: async (caller: unknown): Promise<unknown> => {
        mockCallers.push(caller);
        return { client: await options.attach(new AbortController().signal) };
      },
      dispose: (): Promise<void> => Promise.resolve(),
    };
  },
}));

import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  MUTATION_FENCE_GRANTS,
  WORKER_PIPELINE_GRANTS,
} from '@canopy/protocol/canopy-core';
import {
  DAEMON_PIPELINE_OWNER_CLIENT_INSTANCE_ID,
  disposeDaemonPipelineOwner,
  ELECTRON_DAEMON_OWNER_DEFINITIONS,
  getDaemonPipelineOwnerClient,
  isDaemonOwnerUnavailable,
  isDaemonPipelineOwnerPossible,
} from '../electron-daemon-owner';

const ownerClient = { close: (): Promise<void> => Promise.resolve() };

beforeEach(() => {
  mockIsSpawnedDaemon.mockReset();
  mockOwnerConnect.mockReset().mockResolvedValue(ownerClient);
  mockAttachOrStart.mockReset();
  mockProbe.mockClear();
});

afterAll(async () => {
  await disposeDaemonPipelineOwner();
});

describe('Electron daemon owner session (CAN-5771)', () => {
  it('connects as owner only to the daemon this app spawned', async () => {
    mockIsSpawnedDaemon.mockResolvedValue(false);
    const refused = await getDaemonPipelineOwnerClient().catch(
      (error: unknown) => error,
    );
    expect(isDaemonOwnerUnavailable(refused)).toBe(true);
    expect(mockOwnerConnect).not.toHaveBeenCalled();

    mockIsSpawnedDaemon.mockResolvedValue(true);
    await expect(getDaemonPipelineOwnerClient()).resolves.toBe(ownerClient);
    expect(mockOwnerConnect).toHaveBeenCalledTimes(1);
    expect(mockOwnerConnect.mock.calls[0]?.[0]).toMatchObject({
      endpoint: { kind: 'socket', path: '/run/core.sock' },
      definitions: ELECTRON_DAEMON_OWNER_DEFINITIONS,
    });
    expect(isDaemonPipelineOwnerPossible()).toBe(true);
    // The owner caller holds the host and fence publish grants only, under
    // its own lease (D10, CAN-4730 E2-G).
    expect(mockCallers.at(-1)).toEqual({
      principalId: 'electron-main',
      clientInstanceId: DAEMON_PIPELINE_OWNER_CLIENT_INSTANCE_ID,
      authorityId: 'authority-1',
      interfaceKind: 'desktop',
      grants: [WORKER_PIPELINE_GRANTS.host, MUTATION_FENCE_GRANTS.publish],
    });
    expect(mockServiceOptions[0]).toMatchObject({
      lease: {
        label: 'Workflow host steps',
        interactive: false,
        foreground: false,
      },
    });
    expect(mockServiceOptions[0]).not.toHaveProperty('onSession');
    expect(mockServiceOptions[0]).not.toHaveProperty('onReachability');
  });

  it('the owner session declares only the lease, runtime reads, the host request channel, the fence publish and the write activity stream', () => {
    expect(
      Object.keys(ELECTRON_DAEMON_OWNER_DEFINITIONS.instructions).sort(),
    ).toEqual(
      [
        ...Object.keys(CORE_TRANSPORT_INSTRUCTION_DEFINITIONS),
        'core.mutationFence.publish',
        'worker.pipeline.hostRequest.respond',
      ].sort(),
    );
    expect(Object.keys(ELECTRON_DAEMON_OWNER_DEFINITIONS.streams)).toEqual([
      'worker.pipeline.hostRequests',
      'core.mutationFence.activity',
    ]);
  });

  it('the owner session never spawns a daemon', async () => {
    mockIsSpawnedDaemon.mockResolvedValue(true);
    await getDaemonPipelineOwnerClient();
    expect(mockProbe).toHaveBeenCalled();
    expect(mockAttachOrStart).not.toHaveBeenCalled();
  });
});
