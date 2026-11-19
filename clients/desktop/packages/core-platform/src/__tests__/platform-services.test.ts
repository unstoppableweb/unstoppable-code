// C2a verifies composition; C5 supplies real endpoint contract targets.
import type {
  PlatformEndpointSemantics,
  PlatformEndpointServices,
  PlatformOperatingSystem,
  PlatformPipeEndpointServices,
  PlatformSocketEndpointServices,
} from '@canopy/core-runtime';
import {
  createPlatformServices,
  createFileIndexingMatchPolicy,
  hostPlatformArchitecture,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '../index';

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected composition to fail');
}

function provider(
  semantics: PlatformEndpointSemantics,
): PlatformEndpointServices {
  const failure = new Error('endpoint provider failure');
  if (semantics === 'first-instance-pipe') {
    const pipe: PlatformPipeEndpointServices = {
      semantics,
      address: ({ endpointName }) => ({
        kind: 'named-pipe',
        path: endpointName,
      }),
      bind: () => Promise.reject(failure),
      probe: () => Promise.resolve({ state: 'absent' }),
    };
    return pipe;
  }
  const socket: PlatformSocketEndpointServices = {
    semantics,
    address: ({ endpointName }) => ({
      kind: 'unix-socket',
      path: endpointName,
    }),
    bind: () => Promise.reject(failure),
    probe: () => Promise.resolve({ state: 'absent' }),
    prepare: () => Promise.resolve(),
    verifyIdentity: () => Promise.resolve('changed'),
    unlinkStale: () => Promise.resolve('changed'),
  };
  return socket;
}

const implementations: ReadonlyArray<
  [PlatformOperatingSystem, PlatformEndpointSemantics]
> = [
  ['darwin', 'filesystem-socket'],
  ['win32', 'first-instance-pipe'],
  ['linux', 'filesystem-socket'],
];

describe.each(implementations)(
  'PlatformServices composition: %s',
  (os, semantics) => {
    it('supports the host and preserves the supplied endpoint interface', () => {
      const endpoints = provider(semantics);
      const services = createPlatformServices(os, endpoints);
      expect(services.os).toBe(os);
      expect(services.tier).toBe('primary');
      expect(services.endpoints).toBe(endpoints);
      expect(Object.isFrozen(services)).toBe(true);
      expect(services.secureFiles.permissionModel).toBe(
        os === 'win32' ? 'windows-dacl' : 'posix-mode',
      );
      expect(Object.isFrozen(services.secureFiles)).toBe(true);
      expect(Object.isFrozen(services.paths)).toBe(true);
      expect(Object.isFrozen(services.supervision)).toBe(true);
      expect(Object.isFrozen(services.power)).toBe(true);
      expect(services.power.mechanism).toBe(
        {
          darwin: 'power-assertion',
          win32: 'thread-execution-state',
          linux: 'logind-inhibitor',
        }[os],
      );
      expect(
        services.supervision.childProcessOptions({ lifetime: 'owned' }),
      ).toEqual({
        detached: os !== 'win32',
        windowsHide: os === 'win32',
      });
      expect(
        services.paths.runtimeDirectory({
          dataRoot: os === 'win32' ? 'C:\\data' : '/data',
        }),
      ).toBe(os === 'win32' ? 'C:\\data\\runtime' : '/data/runtime');
    });

    it('rejects incompatible endpoint semantics', () => {
      const opposite =
        semantics === 'filesystem-socket'
          ? 'first-instance-pipe'
          : 'filesystem-socket';
      expect(
        captureError(() => createPlatformServices(os, provider(opposite))),
      ).toMatchObject({ code: 'endpoint_semantics_mismatch' });
    });
  },
);

it.each(['freebsd', 'aix', 'sunos', 'android', ''])(
  'fails closed on unsupported host %j',
  (os) => {
    expect(
      captureError(() =>
        createPlatformServices(os, provider('filesystem-socket')),
      ),
    ).toMatchObject({ code: 'unsupported_platform' });
  },
);

it('preserves endpoint arguments, results, and failures', async () => {
  const failure = new Error('bind refused');
  const address = { kind: 'named-pipe', path: 'endpoint' } as const;
  const probe = jest.fn(() => Promise.resolve({ state: 'absent' } as const));
  const endpoints: PlatformPipeEndpointServices = {
    semantics: 'first-instance-pipe',
    address: () => address,
    bind: () => Promise.reject(failure),
    probe,
  };
  const services = createPlatformServices('win32', endpoints);
  if (services.endpoints.semantics !== 'first-instance-pipe')
    throw new Error('expected pipe');
  const request = { dataRoot: '/data/root', endpointName: 'endpoint' };
  expect(services.endpoints.address(request)).toBe(address);
  await expect(services.endpoints.probe(address)).resolves.toEqual({
    state: 'absent',
  });
  expect(probe).toHaveBeenCalledWith(address);
  await expect(services.endpoints.bind(address)).rejects.toBe(failure);
});

it('passes a host-supplied Trash through and supplies none of its own', async () => {
  const failure = new Error('trash refused');
  const trash = { trashItem: jest.fn(() => Promise.reject(failure)) };
  for (const [os, semantics] of implementations) {
    expect(createPlatformServices(os, provider(semantics))).not.toHaveProperty(
      'trash',
    );
    const services = createPlatformServices(os, provider(semantics), { trash });
    expect(services.trash).toBe(trash);
    await expect(services.trash?.trashItem('/data/a.txt')).rejects.toBe(
      failure,
    );
  }
  expect(trash.trashItem).toHaveBeenCalledWith('/data/a.txt');
});

it('selects the running host once at composition', () => {
  const semantics =
    process.platform === 'win32' ? 'first-instance-pipe' : 'filesystem-socket';
  expect(hostPlatformServices(provider(semantics)).os).toBe(process.platform);
});

it('reports the running host architecture', () => {
  expect(hostPlatformArchitecture()).toBe(process.arch);
});

it('reports the running host and fails closed on an unsupported one', () => {
  expect(hostPlatformOperatingSystem()).toBe(process.platform);
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!original) throw new Error('Missing platform descriptor.');
  Object.defineProperty(process, 'platform', { value: 'freebsd' });
  try {
    let error: unknown;
    try {
      hostPlatformOperatingSystem();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'unsupported_platform' });
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});

it.each([
  ['linux', true],
  ['darwin', false],
  ['win32', false],
] as const)('owns file indexing case policy for %s', (os, caseSensitive) => {
  expect(createFileIndexingMatchPolicy(os)).toEqual({ caseSensitive });
});
