import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformEndpointServices,
  createPlatformServices,
} from '@canopy/core-platform';
import type {
  PlatformOperatingSystem,
  PlatformPipeEndpointServices,
  PlatformProcessInspection,
  PlatformSocketEndpointServices,
} from '@canopy/core-runtime';
import {
  publishCanopyDaemon,
  type CanopyDaemonPublicationOptions,
} from '@canopy/core-runtime/node';
import {
  createCanopyStartupClaimPort,
  type CanopyStartupProcessInspection,
} from '@canopy/core-transport/node';

const os: PlatformOperatingSystem =
  process.platform === 'win32'
    ? 'win32'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux';
const posix = process.platform === 'win32' ? test.skip : test;
const CRASHED = { pid: 2_000_001, startIdentity: 'crashed-start' };
let dataRoot: string;
let socketPath: string;
// What the successor's claim port observes for the crashed claimant.
let crashed: CanopyStartupProcessInspection;
let descriptorOwner: PlatformProcessInspection;
beforeEach(async () => {
  dataRoot = await realpath(
    await mkdtemp(
      join(process.platform === 'win32' ? tmpdir() : '/tmp', 'c5d-'),
    ),
  );
  await mkdir(join(dataRoot, 'runtime'), { mode: 0o700 });
  crashed = { kind: 'dead' };
  descriptorOwner = { state: 'absent' };
});
afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function host(): CanopyDaemonPublicationOptions {
  const claims = createCanopyStartupClaimPort({
    dataRoot,
    owner: { pid: process.pid, startIdentity: 'test-start' },
    inspectProcess: (pid) =>
      Promise.resolve(
        pid === CRASHED.pid
          ? crashed
          : { kind: 'alive', startIdentity: 'test-start' },
      ),
  });
  const platform = createPlatformServices(
    os,
    createPlatformEndpointServices(os, {
      validateStartupClaim: (claim) => claims.verify(claim),
    }),
  );
  return {
    platform: {
      ...platform,
      supervision: {
        ...platform.supervision,
        inspectProcess: () => Promise.resolve(descriptorOwner),
      },
    },
    claims,
    dataRoot,
    runtimeMode: 'dev',
    pid: process.pid,
    startIdentity: 'test-start',
    buildVersion: 'test',
    protocolRange: { min: 1, max: 1 },
  };
}

function socketHost(): CanopyDaemonPublicationOptions & {
  endpoints: PlatformSocketEndpointServices;
} {
  const options = host();
  const endpoints = options.platform.endpoints;
  if (endpoints.semantics !== 'filesystem-socket')
    throw new Error('Wrong endpoint family');
  return { ...options, endpoints };
}

/** A claimant that bound and then vanished: its claim and socket remain, no descriptor. */
async function crashAfterBind({ marked }: { marked: boolean }): Promise<void> {
  const claimant = createCanopyStartupClaimPort({
    dataRoot,
    owner: CRASHED,
    inspectProcess: () =>
      Promise.resolve({ kind: 'alive', startIdentity: CRASHED.startIdentity }),
  });
  const held = await claimant.tryAcquire();
  if (held.kind !== 'acquired') throw new Error('Claim unavailable');
  if (marked) expect(await claimant.markEndpointBind(held.handle)).toBe(true);
  await abandonSocket();
}

/** Leaves a bound, listener-less socket inode at the path, as a SIGKILLed owner would. */
async function abandonSocket(): Promise<void> {
  socketPath = socketHost().endpoints.address({
    dataRoot,
    endpointName: 'core',
  }).path;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const pinned = join(dataRoot, 'runtime', 'pinned.sock');
  await link(socketPath, pinned);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rename(pinned, socketPath);
}

async function claimRecord(): Promise<unknown> {
  return JSON.parse(
    await readFile(join(dataRoot, 'runtime', 'startup-claim.json'), 'utf8'),
  );
}

posix(
  'a departed claimant that marked its bind leaves a socket the next start recovers',
  async () => {
    await crashAfterBind({ marked: true });
    const before = await lstat(socketPath, { bigint: true });
    // Pins the crashed inode so the successor's socket cannot reuse its number.
    await link(socketPath, join(dataRoot, 'crashed.sock'));
    const options = socketHost();
    const successor = await publishCanopyDaemon(options);
    try {
      expect(successor.descriptor.endpoint.path).toBe(socketPath);
      expect(successor.descriptor.socketIdentity?.inode).not.toBe(
        String(before.ino),
      );
      expect(
        JSON.parse(
          await readFile(join(dataRoot, 'runtime', 'core.json'), 'utf8'),
        ),
      ).toEqual(successor.descriptor);
    } finally {
      await successor.close();
    }
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
  },
);

posix(
  'a changed start identity proves the claimant departed, like an absent pid',
  async () => {
    await crashAfterBind({ marked: true });
    crashed = { kind: 'alive', startIdentity: 'reused-pid' };
    const successor = await publishCanopyDaemon(socketHost());
    await successor.close();
  },
);

posix(
  'a socket with no descriptor and no claim held still fails closed',
  async () => {
    await abandonSocket();
    const before = await lstat(socketPath);
    await expect(publishCanopyDaemon(socketHost())).rejects.toThrow(
      'Stale owner unproven; offline repair required.',
    );
    expect((await lstat(socketPath)).ino).toBe(before.ino);
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual(['core.sock']);
  },
);

posix(
  'a departed claim without a bind marker never vouches for a lingering socket',
  async () => {
    await crashAfterBind({ marked: false });
    const before = await lstat(socketPath);
    await expect(publishCanopyDaemon(socketHost())).rejects.toThrow(
      'Stale owner unproven; offline repair required.',
    );
    expect((await lstat(socketPath)).ino).toBe(before.ino);
  },
);

posix(
  'a departed claim without a bind marker leaves a foreign descriptor fail-closed',
  async () => {
    await crashAfterBind({ marked: false });
    await writeFile(
      join(dataRoot, 'runtime', 'core.json'),
      JSON.stringify({
        version: 1,
        pid: 2_000_002,
        startIdentity: 'older',
        endpoint: { kind: 'socket', path: socketPath },
        protocolRange: { min: 1, max: 1 },
        buildVersion: 'test',
        tokenRef: join(dataRoot, 'runtime', 'old.token'),
        socketIdentity: { device: '1', inode: '1' },
      }),
      { mode: 0o600 },
    );
    const before = await lstat(socketPath);
    await expect(publishCanopyDaemon(socketHost())).rejects.toThrow(
      'Foreign endpoint; offline repair required.',
    );
    expect((await lstat(socketPath)).ino).toBe(before.ino);
  },
);

posix.each<CanopyStartupProcessInspection>([
  { kind: 'unknown' },
  { kind: 'alive', startIdentity: CRASHED.startIdentity },
])(
  'a claim whose holder is live or unprovable is never recovered: %j',
  async (state) => {
    await crashAfterBind({ marked: true });
    crashed = state;
    const record = await claimRecord();
    const before = await lstat(socketPath);
    await expect(publishCanopyDaemon(socketHost())).rejects.toThrow(
      'Startup claim unavailable.',
    );
    expect((await lstat(socketPath)).ino).toBe(before.ino);
    expect(await claimRecord()).toEqual(record);
  },
);

posix(
  'a recovered claim still requires owner proof for a published descriptor',
  async () => {
    await crashAfterBind({ marked: true });
    const identity = await lstat(socketPath, { bigint: true });
    await writeFile(
      join(dataRoot, 'runtime', 'core.json'),
      JSON.stringify({
        version: 1,
        pid: 2_000_003,
        startIdentity: 'published',
        endpoint: { kind: 'socket', path: socketPath },
        protocolRange: { min: 1, max: 1 },
        buildVersion: 'test',
        tokenRef: join(dataRoot, 'runtime', 'old.token'),
        socketIdentity: {
          device: String(identity.dev),
          inode: String(identity.ino),
        },
      }),
      { mode: 0o600 },
    );
    descriptorOwner = { state: 'running', startIdentity: 'published' };
    await expect(publishCanopyDaemon(socketHost())).rejects.toThrow(
      'Stale owner unproven; offline repair required.',
    );
    expect((await lstat(socketPath, { bigint: true })).ino).toBe(identity.ino);
  },
);

posix.each([
  {
    failure: 'an ambiguous probe',
    message: 'Endpoint identity is ambiguous.',
    endpoints: (
      endpoints: PlatformSocketEndpointServices,
    ): PlatformSocketEndpointServices => ({
      ...endpoints,
      probe: () => Promise.resolve({ state: 'ambiguous', reason: 'lstat' }),
    }),
  },
  {
    failure: 'a changed identity at unlink',
    message: 'Stale endpoint changed.',
    endpoints: (
      endpoints: PlatformSocketEndpointServices,
    ): PlatformSocketEndpointServices => ({
      ...endpoints,
      unlinkStale: () => Promise.resolve('changed'),
    }),
  },
])('recovery fails closed on $failure', async ({ endpoints, message }) => {
  await crashAfterBind({ marked: true });
  const before = await lstat(socketPath);
  const options = socketHost();
  await expect(
    publishCanopyDaemon({
      ...options,
      platform: {
        ...options.platform,
        endpoints: endpoints(options.endpoints),
      },
    }),
  ).rejects.toThrow(message);
  expect((await lstat(socketPath)).ino).toBe(before.ino);
});

test('Windows never recovers a departed claim; the pipe leaves no file behind', async () => {
  const claimant = createCanopyStartupClaimPort({
    dataRoot,
    owner: CRASHED,
    inspectProcess: () =>
      Promise.resolve({ kind: 'alive', startIdentity: CRASHED.startIdentity }),
  });
  const held = await claimant.tryAcquire();
  if (held.kind !== 'acquired') throw new Error('Claim unavailable');
  expect(await claimant.markEndpointBind(held.handle)).toBe(true);
  const options = host();
  const endpoints: PlatformPipeEndpointServices = {
    semantics: 'first-instance-pipe',
    address: () => ({ kind: 'named-pipe', path: '\\\\.\\pipe\\c5d-test' }),
    probe: () => Promise.resolve({ state: 'absent' }),
    bind: () => Promise.reject(new Error('Unexpected bind')),
  };
  const tryAcquire = jest.spyOn(options.claims, 'tryAcquire');
  await expect(
    publishCanopyDaemon({
      ...options,
      platform: {
        ...options.platform,
        endpoints,
        secureFiles: {
          ...options.platform.secureFiles,
          permissionModel: 'windows-dacl',
          permissions: () => Promise.resolve({ state: 'private' }),
        },
      },
    }),
  ).rejects.toThrow('Startup claim unavailable.');
  expect(tryAcquire).toHaveBeenCalledWith(undefined, {
    recoverDeparted: false,
  });
});

posix(
  'publication recovers an abandoned device-remapped socket and closes normally',
  async () => {
    await abandonSocket();
    const identity = await lstat(socketPath, { bigint: true });
    await writeFile(
      join(dataRoot, 'runtime', 'core.json'),
      JSON.stringify({
        version: 1,
        pid: 2000002,
        startIdentity: 'before-boot',
        endpoint: { kind: 'socket', path: socketPath },
        protocolRange: { min: 1, max: 1 },
        buildVersion: 'test',
        tokenRef: join(dataRoot, 'runtime', 'old.token'),
        socketIdentity: { device: '999999999999', inode: String(identity.ino) },
      }),
      { mode: 0o600 },
    );
    const base = socketHost();
    const successor = await publishCanopyDaemon({
      ...base,
      platform: {
        ...base.platform,
        supervision: {
          ...base.platform.supervision,
          bootRelation: () => Promise.resolve('before_boot'),
        },
      },
    });
    await successor.close();
    expect(await readdir(join(dataRoot, 'runtime'))).toEqual([]);
  },
);
