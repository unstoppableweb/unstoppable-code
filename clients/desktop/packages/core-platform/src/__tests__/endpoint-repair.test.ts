import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
  rename,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import type {
  PlatformProcessInspection,
  PlatformSocketProbeResult,
} from '@canopy/core-runtime';
import {
  repairCanopyDaemonEndpoint,
  type CanopyEndpointRepairOptions,
  type EndpointRepairClaimPort,
} from '@canopy/core-runtime/node';
import { createCanopyStartupClaimPort } from '@canopy/core-transport/node';
import { createPlatformServices, createPlatformEndpointServices } from '..';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return { ...actual, rename: jest.fn(actual.rename) };
});

const posix = process.platform === 'win32' ? describe.skip : describe;
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const instant = new Date('2026-11-07T12:00:00Z');
const folder = 'endpoint-repair-20261107T120000Z';

posix('daemon repair-endpoint offline maintenance contract', () => {
  let root: string;
  let runtime: string;
  let socket: string;
  let descriptorPath: string;
  let tokenPath: string;
  let options: CanopyEndpointRepairOptions;
  let descriptor: object;
  let claims: ReturnType<typeof createCanopyStartupClaimPort>;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'er-')));
    runtime = join(root, 'runtime');
    await mkdir(runtime, { mode: 0o700 });
    socket = join(runtime, 'core.sock');
    descriptorPath = join(runtime, 'core.json');
    tokenPath = join(runtime, 'old.token');
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('net').createServer().listen(process.argv[1],()=>process.stdout.write('ready'))",
        socket,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      if (!child.stdout) throw new Error('Missing fixture stdout');
      await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(() => {
          throw new Error('Fixture exited');
        }),
      ]);
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    descriptor = {
      version: 1,
      pid: 4242,
      startIdentity: 'departed-owner',
      endpoint: { kind: 'socket', path: socket },
      protocolRange: { min: 1, max: 1 },
      buildVersion: 'test',
      tokenRef: tokenPath,
      // The CAN-5957 case: same socket inode, filesystem device ID changed.
      socketIdentity: {
        device: '999999',
        inode: String((await lstat(socket, { bigint: true })).ino),
      },
    };
    await writeFile(descriptorPath, JSON.stringify(descriptor), {
      mode: 0o600,
    });
    await writeFile(tokenPath, 'private-fixture-token', { mode: 0o600 });
    claims = createCanopyStartupClaimPort({
      dataRoot: root,
      owner: { pid: process.pid, startIdentity: 'self' },
      inspectProcess: (pid) =>
        Promise.resolve(
          pid === process.pid
            ? { kind: 'alive', startIdentity: 'self' }
            : { kind: 'dead' },
        ),
    });
    const platform = createPlatformServices(
      os,
      createPlatformEndpointServices(os),
    );
    options = {
      os,
      dataRoot: root,
      claims: (): Promise<EndpointRepairClaimPort> => Promise.resolve(claims),
      now: (): Date => instant,
      platform: {
        ...platform,
        supervision: {
          ...platform.supervision,
          inspectProcess: ({ pid }): Promise<PlatformProcessInspection> =>
            Promise.resolve(
              pid === process.pid
                ? { state: 'running', startIdentity: 'self' }
                : { state: 'absent' },
            ),
        },
      },
    };
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  const repair = (): ReturnType<typeof repairCanopyDaemonEndpoint> =>
    repairCanopyDaemonEndpoint(options);
  const released = async (): Promise<void> => {
    await expect(
      lstat(join(runtime, 'startup-claim.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  };
  const intact = async (): Promise<void> => {
    expect((await lstat(socket)).isSocket()).toBe(true);
    expect(await readFile(descriptorPath, 'utf8')).toBe(
      JSON.stringify(descriptor),
    );
  };

  it.each(['absent', 'reused'] as const)(
    'preserves a device-remapped socket after %s owner proof and releases the claim',
    async (owner) => {
      if (owner === 'reused')
        options = {
          ...options,
          platform: {
            ...options.platform,
            supervision: {
              ...options.platform.supervision,
              inspectProcess: (): Promise<PlatformProcessInspection> =>
                Promise.resolve({
                  state: 'running',
                  startIdentity: 'self',
                }),
            },
          },
        };
      expect(await repair()).toEqual({
        kind: 'repaired',
        message: `Moved the earlier run's connection files to ${folder}.`,
      });
      const backup = join(runtime, folder);
      expect((await lstat(backup)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(backup, 'core.sock'))).isSocket()).toBe(true);
      expect(await readFile(join(backup, 'core.json'), 'utf8')).toBe(
        JSON.stringify(descriptor),
      );
      expect(await readFile(join(backup, 'core.token'), 'utf8')).toBe(
        'private-fixture-token',
      );
      await released();
      expect(await repair()).toEqual({
        kind: 'noop',
        message: 'Nothing to repair.',
      });
      await released();
    },
  );
  it.each(['successor', 'unrecorded'] as const)(
    'refuses to move a refused %s socket the descriptor did not record',
    async (kind) => {
      descriptor =
        kind === 'successor'
          ? { ...descriptor, socketIdentity: { device: '1', inode: '1' } }
          : { ...descriptor, socketIdentity: undefined };
      await writeFile(descriptorPath, JSON.stringify(descriptor));
      // A live successor with a full backlog probes as refused (CAN-3935).
      const successor = createServer();
      await unlink(socket);
      await new Promise<void>((resolve) => successor.listen(socket, resolve));
      try {
        const endpoints = options.platform.endpoints;
        if (endpoints.semantics !== 'filesystem-socket')
          throw new Error('wrong family');
        const live = await lstat(socket, { bigint: true });
        options = {
          ...options,
          platform: {
            ...options.platform,
            endpoints: {
              ...endpoints,
              probe: (): Promise<PlatformSocketProbeResult> =>
                Promise.resolve({
                  state: 'refused',
                  identity: { device: live.dev, inode: live.ino },
                }),
            },
          },
        };
        expect(await repair()).toEqual({
          kind: 'refused',
          message:
            'Repair refused: the endpoint does not belong to the earlier run.',
        });
        await intact();
        await released();
        expect(
          (await readdir(runtime)).filter((name) =>
            name.startsWith('endpoint-repair-'),
          ),
        ).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => successor.close(() => resolve()));
      }
    },
  );
  it.each(['live', 'ambiguous'] as const)(
    'refuses a %s endpoint',
    async (state) => {
      const endpoints = options.platform.endpoints;
      if (endpoints.semantics !== 'filesystem-socket')
        throw new Error('wrong family');
      options = {
        ...options,
        platform: {
          ...options.platform,
          endpoints: {
            ...endpoints,
            probe: (): Promise<PlatformSocketProbeResult> =>
              Promise.resolve(
                state === 'live'
                  ? { state: 'live' }
                  : { state: 'ambiguous', reason: 'private path' },
              ),
          },
        },
      };
      expect((await repair()).kind).toBe('refused');
      await intact();
      await released();
    },
  );
  it.each(['held', 'ambiguous'] as const)(
    'refuses a %s startup claim',
    async (kind) => {
      const release = jest.spyOn(claims, 'release');
      options = {
        ...options,
        claims: (): Promise<EndpointRepairClaimPort> =>
          Promise.resolve({
            ...claims,
            tryAcquire: () => Promise.resolve({ kind }),
          }),
      };
      expect((await repair()).kind).toBe('refused');
      await intact();
      expect(release).not.toHaveBeenCalled();
    },
  );
  it('preserves recovered endpoint-bind lineage for the next start', async () => {
    const release = jest.fn(() => Promise.resolve('not_owner' as const));
    options = {
      ...options,
      claims: (): Promise<EndpointRepairClaimPort> =>
        Promise.resolve({
          ...claims,
          tryAcquire: () =>
            Promise.resolve({
              kind: 'acquired',
              handle: {},
              recovered: { endpointBound: true },
            }),
          release,
        }),
    };
    const result = await repair();
    expect(result.kind).toBe('refused');
    expect(result.message).toContain('next daemon start');
    expect(release).toHaveBeenCalledWith({}, { preserveEndpointBind: true });
    await intact();
  });
  it.each([
    'missing',
    'oversized',
    'malformed',
    'insecure',
    'symlink',
    'wrong-kind',
    'wrong-path',
  ] as const)('refuses a %s descriptor', async (kind) => {
    if (kind === 'missing') await unlink(descriptorPath);
    if (kind === 'oversized')
      await writeFile(descriptorPath, ' '.repeat(65537));
    if (kind === 'malformed') await writeFile(descriptorPath, '{');
    if (kind === 'insecure') await chmod(descriptorPath, 0o644);
    if (kind === 'symlink') {
      await unlink(descriptorPath);
      await symlink(tokenPath, descriptorPath);
    }
    if (kind === 'wrong-kind')
      await writeFile(
        descriptorPath,
        JSON.stringify({
          ...descriptor,
          endpoint: { kind: 'pipe', path: socket },
        }),
      );
    if (kind === 'wrong-path')
      await writeFile(
        descriptorPath,
        JSON.stringify({
          ...descriptor,
          endpoint: { kind: 'socket', path: tokenPath },
        }),
      );
    expect((await repair()).kind).toBe('refused');
    expect((await lstat(socket)).isSocket()).toBe(true);
    await released();
    expect(
      (await readdir(runtime)).filter((name) =>
        name.startsWith('endpoint-repair-'),
      ),
    ).toEqual([]);
  });
  it.each(['same', 'unverifiable', 'self-unverifiable'] as const)(
    'refuses %s process evidence',
    async (kind) => {
      options = {
        ...options,
        platform: {
          ...options.platform,
          supervision: {
            ...options.platform.supervision,
            inspectProcess: ({ pid }): Promise<PlatformProcessInspection> =>
              Promise.resolve(
                pid === process.pid && kind !== 'self-unverifiable'
                  ? { state: 'running', startIdentity: 'self' }
                  : kind === 'same'
                    ? { state: 'running', startIdentity: 'departed-owner' }
                    : { state: 'unverifiable', reason: 'private fixture' },
              ),
          },
        },
      };
      expect((await repair()).kind).toBe('refused');
      await intact();
      await released();
    },
  );
  it.each(['absent', 'external', 'symlink', 'alias', 'claim'] as const)(
    'leaves an ineligible %s token alone',
    async (kind) => {
      if (kind === 'absent') await unlink(tokenPath);
      if (kind === 'external') {
        tokenPath = join(root, 'external.token');
        await writeFile(tokenPath, 'outside', { mode: 0o600 });
        descriptor = { ...descriptor, tokenRef: tokenPath };
        await writeFile(descriptorPath, JSON.stringify(descriptor));
      }
      if (kind === 'symlink') {
        await unlink(tokenPath);
        await symlink(descriptorPath, tokenPath);
      }
      if (kind === 'alias') {
        await unlink(tokenPath);
        await link(join(runtime, 'core.sock'), tokenPath);
      }
      if (kind === 'claim') {
        // This file is created by repair's acquisition. Moving it as a token
        // would release serialization before repair and cleanup have finished.
        tokenPath = join(runtime, 'startup-claim.json');
        descriptor = { ...descriptor, tokenRef: tokenPath };
        await writeFile(descriptorPath, JSON.stringify(descriptor));
      }
      expect((await repair()).kind).toBe('repaired');
      await expect(
        lstat(join(runtime, folder, 'core.token')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      if (kind !== 'absent' && kind !== 'claim')
        expect(await lstat(tokenPath)).toBeDefined();
      await released();
    },
  );
  it('refuses timestamp collisions without overwriting', async () => {
    await mkdir(join(runtime, folder));
    expect((await repair()).kind).toBe('refused');
    await intact();
    await released();
  });
  it.each(['socket', 'descriptor', 'token'] as const)(
    'refuses %s replacement before mutation',
    async (kind) => {
      const identity = claims.identity.bind(claims);
      let checks = 0;
      jest.spyOn(claims, 'identity').mockImplementation(async (handle) => {
        if (++checks === 2) {
          const target =
            kind === 'socket'
              ? socket
              : kind === 'descriptor'
                ? descriptorPath
                : tokenPath;
          await rename(target, `${target}.original`);
          await writeFile(target, 'replacement', { mode: 0o600 });
        }
        return identity(handle);
      });
      expect((await repair()).kind).toBe('refused');
      expect(
        await readFile(
          kind === 'socket'
            ? socket
            : kind === 'descriptor'
              ? descriptorPath
              : tokenPath,
          'utf8',
        ),
      ).toBe('replacement');
      await released();
    },
  );
  it.each(['descriptor', 'token', 'backup-sync', 'runtime-sync'] as const)(
    'reports partial %s failure and keeps socket-first state',
    async (phase) => {
      const secure = options.platform.secureFiles;
      const move = (
        request: Parameters<typeof secure.rename>[0],
      ): ReturnType<typeof secure.rename> => secure.rename(request);
      const sync = (path: string): ReturnType<typeof secure.syncDirectory> =>
        secure.syncDirectory(path);
      options = {
        ...options,
        platform: {
          ...options.platform,
          secureFiles: {
            ...secure,
            rename: (request): ReturnType<typeof secure.rename> =>
              Promise.resolve().then(() => {
                if (
                  (phase === 'descriptor' && request.from === descriptorPath) ||
                  (phase === 'token' && request.from === tokenPath)
                )
                  throw new Error('private token path');
                return move(request);
              }),
            syncDirectory: (path): ReturnType<typeof secure.syncDirectory> =>
              Promise.resolve().then(() => {
                if (
                  (phase === 'backup-sync' && path.endsWith(folder)) ||
                  (phase === 'runtime-sync' && path === runtime)
                )
                  throw new Error('private path');
                return sync(path);
              }),
          },
        },
      };
      expect(await repair()).toEqual({
        kind: 'incomplete',
        message: `Repair incomplete. Preserved files remain in ${folder}; inspect this folder before trying again.`,
      });
      expect((await lstat(join(runtime, folder, 'core.sock'))).isSocket()).toBe(
        true,
      );
      await expect(lstat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
      if (phase === 'descriptor')
        expect(await readFile(descriptorPath, 'utf8')).toBe(
          JSON.stringify(descriptor),
        );
      await released();
      expect((await repair()).kind).toBe('noop');
    },
  );
  it('retains the private backup and releases the claim if socket rename fails', async () => {
    jest.mocked(rename).mockRejectedValueOnce(new Error('/private/socket'));
    expect((await repair()).kind).toBe('incomplete');
    await intact();
    await released();
    expect(await readdir(join(runtime, folder))).toEqual([]);
  });
  it.each(['socket', 'descriptor', 'token'] as const)(
    'refuses %s disappearance before mutation',
    async (kind) => {
      const identity = claims.identity.bind(claims);
      let checks = 0;
      jest.spyOn(claims, 'identity').mockImplementation(async (handle) => {
        if (++checks === 2)
          await unlink(
            kind === 'socket'
              ? socket
              : kind === 'descriptor'
                ? descriptorPath
                : tokenPath,
          );
        return identity(handle);
      });
      expect((await repair()).kind).toBe('refused');
      await released();
      expect(await readdir(join(runtime, folder))).toEqual([]);
    },
  );
  it('detects token replacement at its move boundary after socket and descriptor preservation', async () => {
    const secure = options.platform.secureFiles;
    const move = (
      request: Parameters<typeof secure.rename>[0],
    ): ReturnType<typeof secure.rename> => secure.rename(request);
    options = {
      ...options,
      platform: {
        ...options.platform,
        secureFiles: {
          ...secure,
          rename: async (request): ReturnType<typeof secure.rename> => {
            const result = await move(request);
            if (request.from === descriptorPath) {
              await rename(tokenPath, `${tokenPath}.original`);
              await writeFile(tokenPath, 'replacement', { mode: 0o600 });
            }
            return result;
          },
        },
      },
    };
    expect((await repair()).kind).toBe('incomplete');
    expect(await readFile(tokenPath, 'utf8')).toBe('replacement');
    expect((await lstat(join(runtime, folder, 'core.sock'))).isSocket()).toBe(
      true,
    );
    expect(await readFile(join(runtime, folder, 'core.json'), 'utf8')).toBe(
      JSON.stringify(descriptor),
    );
    await released();
  });
  it('keeps refusal primary and sanitizes release failures', async () => {
    const onCleanupFailure = jest.fn();
    options = {
      ...options,
      onCleanupFailure,
      claims: (): Promise<EndpointRepairClaimPort> =>
        Promise.resolve({
          ...claims,
          release: () =>
            Promise.resolve().then(() => {
              throw new Error('/private/secret');
            }),
        }),
    };
    await unlink(descriptorPath);
    const result = await repair();
    expect(result.kind).toBe('incomplete');
    expect(result.message).not.toMatch(/private|secret/);
    expect(onCleanupFailure).toHaveBeenCalledWith(
      'Endpoint repair startup claim release failed.',
    );
  });
  it('serializes cooperating starters throughout repair', async () => {
    const secure = options.platform.secureFiles;
    const renameFile = (
      request: Parameters<typeof secure.rename>[0],
    ): ReturnType<typeof secure.rename> => secure.rename(request);
    const contender = createCanopyStartupClaimPort({
      dataRoot: root,
      owner: { pid: 4343, startIdentity: 'other' },
      inspectProcess: () =>
        Promise.resolve({ kind: 'alive', startIdentity: 'self' }),
    });
    options = {
      ...options,
      platform: {
        ...options.platform,
        secureFiles: {
          ...secure,
          rename: async (request): ReturnType<typeof secure.rename> => {
            expect(
              (await contender.tryAcquire(undefined, { recoverDeparted: true }))
                .kind,
            ).toBe('held');
            return renameFile(request);
          },
        },
      },
    };
    expect((await repair()).kind).toBe('repaired');
    await released();
  });
});

it('Windows repair never touches runtime files or claims', async () => {
  // The host is intentionally unusable: Windows must return before accessing it.
  const platform = createPlatformServices(
    'win32',
    createPlatformEndpointServices('win32'),
  );
  const claims = jest.fn(
    (): Promise<never> =>
      Promise.resolve().then(() => {
        throw new Error('must not acquire');
      }),
  );
  expect(
    await repairCanopyDaemonEndpoint({
      os: 'win32',
      dataRoot: '/does-not-exist',
      platform,
      claims,
    }),
  ).toEqual({ kind: 'noop', message: 'Nothing to repair on this platform.' });
  expect(claims).not.toHaveBeenCalled();
});
