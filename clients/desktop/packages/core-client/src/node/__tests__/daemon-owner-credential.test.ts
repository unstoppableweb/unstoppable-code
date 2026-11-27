import crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { createCanopyOwnerProofVerifier } from '@canopy/core-runtime/node';
import {
  createCanopyDaemonHostLaunch,
  createDaemonOwnerCredential,
  type CanopyDaemonHostLaunchOptions,
  type CanopyDaemonMigrationLaunch,
  type CanopyOwnedDaemonChildren,
} from '../index';

const DATA_ROOT_HASH = 'b'.repeat(64);
const signal = new AbortController().signal;

describe('daemon owner credential (CAN-5771)', () => {
  let root = '';
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'daemon-owner-')));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('rotates a fresh secret per spawn and proves only with the current one', () => {
    const credential = createDaemonOwnerCredential();
    const first = credential.rotate();
    const second = credential.rotate();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first === second).toBe(false);
    const proof = credential.prove('connection-1', DATA_ROOT_HASH);
    const current = createCanopyOwnerProofVerifier({
      secret: Buffer.from(second, 'hex'),
      dataRootHash: DATA_ROOT_HASH,
    });
    const previous = createCanopyOwnerProofVerifier({
      secret: Buffer.from(first, 'hex'),
      dataRootHash: DATA_ROOT_HASH,
    });
    expect(current.verify('connection-1', proof)).toBe(true);
    expect(previous.verify('connection-1', proof)).toBe(false);
  });

  it('never serializes', () => {
    const credential = createDaemonOwnerCredential();
    credential.rotate();
    expect(() => JSON.stringify(credential)).toThrow(
      'A daemon owner credential is not serializable.',
    );
    expect(inspect(credential)).toBe('[DaemonOwnerCredential]');
  });

  it('hands the secret to a spawn on stdin, never argv or env', async () => {
    const child = {
      pid: 4321,
      exited: new Promise<{ code: number | null; signal: string | null }>(
        () => undefined,
      ),
      commit: jest.fn(),
      terminate: jest.fn(() => Promise.resolve()),
    };
    const spawn = jest.fn<
      ReturnType<CanopyOwnedDaemonChildren['spawn']>,
      Parameters<CanopyOwnedDaemonChildren['spawn']>
    >(() => Promise.resolve(child));
    const host = (
      overrides: Partial<CanopyDaemonHostLaunchOptions>,
    ): ReturnType<typeof createCanopyDaemonHostLaunch> =>
      createCanopyDaemonHostLaunch({
        dataRoot: root,
        runtimeMode: 'dev',
        executable: process.execPath,
        platform: 'darwin',
        supervision: {
          childEnvironment: () => ({ PATH: '/usr/bin' }),
          inspectProcess: () => Promise.resolve({ state: 'absent' }),
        },
        ownedChildren: { spawn },
        environmentSource: { PATH: '/usr/bin' },
        prepareRuntime: async () => {
          await fs.mkdir(join(root, 'runtime'), {
            recursive: true,
            mode: 0o700,
          });
        },
        expectedEndpoint: {
          kind: 'socket',
          path: join(root, 'runtime', 'core.sock'),
        },
        verifyPrivateFile: () => Promise.resolve(),
        ...overrides,
      });

    const credential = createDaemonOwnerCredential();
    const rotate = jest.spyOn(credential, 'rotate');
    const launch = host({ ownerCredential: credential });
    const daemon = await launch.ports.supervisor.spawnDaemon({
      executable: process.execPath,
      args: [],
      signal,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [request] = spawn.mock.calls[0];
    expect(request.environment.CANOPY_DAEMON_CLAIM_HANDOFF).toBe(
      'stdin-owner-v1',
    );
    const handoff: unknown = JSON.parse(request.stdin ?? '');
    const anySecret: unknown = expect.stringMatching(/^[0-9a-f]{64}$/);
    expect(handoff).toEqual({ claim: null, owner: { secret: anySecret } });
    const rotated: unknown = rotate.mock.results[0]?.value;
    const secret = String(rotated);
    // Booleans only, so a failure never prints the secret.
    expect(JSON.stringify(handoff).includes(secret)).toBe(true);
    expect(request.args.some((arg) => arg.includes(secret))).toBe(false);
    expect(
      Object.values(request.environment).some((value) =>
        value.includes(secret),
      ),
    ).toBe(false);
    expect(credential.spawnedPid()).toBe(4321);
    await launch.ports.supervisor.terminateDaemon(daemon, signal);

    const migrationCredential = createDaemonOwnerCredential();
    const migrationRotate = jest.spyOn(migrationCredential, 'rotate');
    const migrationSpawn = jest.fn<
      ReturnType<CanopyDaemonMigrationLaunch['spawn']>,
      Parameters<CanopyDaemonMigrationLaunch['spawn']>
    >(() => Promise.resolve(child));
    const migrationLaunch = host({
      ownerCredential: migrationCredential,
      migration: { spawn: migrationSpawn },
    });
    const migrated = await migrationLaunch.ports.supervisor.spawnDaemon({
      executable: process.execPath,
      args: ['--migration-channel'],
      signal,
    });
    const [migrationRequest] = migrationSpawn.mock.calls[0] ?? [];
    expect(migrationRequest?.environment.CANOPY_DAEMON_CLAIM_HANDOFF).toBe(
      'stdin-migration-v1',
    );
    expect(migrationRotate).not.toHaveBeenCalled();
    await migrationLaunch.ports.supervisor.terminateDaemon(migrated, signal);
  });
});

describe('desktop peer proof (CAN-7201)', () => {
  const verifierFor = (
    secretHex: string,
    dataRootHash = DATA_ROOT_HASH,
  ): ReturnType<typeof createCanopyOwnerProofVerifier> =>
    createCanopyOwnerProofVerifier({
      secret: Buffer.from(secretHex, 'hex'),
      dataRootHash,
    });

  it('keeps peer proofs and owner proofs apart', () => {
    const credential = createDaemonOwnerCredential();
    const secret = credential.rotate();
    const verifier = verifierFor(secret);
    const peer = credential.provePeer('connection-1', DATA_ROOT_HASH);
    const owner = credential.prove('connection-1', DATA_ROOT_HASH);
    expect(peer === owner).toBe(false);
    expect(verifier.verifyPeer('connection-1', peer)).toBe(true);
    expect(verifier.verify('connection-1', peer)).toBe(false);
    expect(verifier.verifyPeer('connection-1', owner)).toBe(false);
  });

  it('binds a peer proof to its connection and data root', () => {
    const credential = createDaemonOwnerCredential();
    const secret = credential.rotate();
    const peer = credential.provePeer('connection-1', DATA_ROOT_HASH);
    expect(verifierFor(secret).verifyPeer('connection-2', peer)).toBe(false);
    expect(
      verifierFor(secret, 'c'.repeat(64)).verifyPeer('connection-1', peer),
    ).toBe(false);
    expect(verifierFor(secret).verifyPeer('', peer)).toBe(false);
  });

  it('refuses near misses through a timing-safe comparison', () => {
    const credential = createDaemonOwnerCredential();
    const verifier = verifierFor(credential.rotate());
    const peer = credential.provePeer('connection-1', DATA_ROOT_HASH);
    const flipped = `${peer.slice(0, -1)}${peer.endsWith('A') ? 'B' : 'A'}`;
    for (const proof of [flipped, peer.slice(1), `${peer}A`, '', 'x'])
      expect(verifier.verifyPeer('connection-1', proof)).toBe(false);
    const compare = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      expect(verifier.verifyPeer('connection-1', flipped)).toBe(false);
      expect(verifier.verifyPeer('connection-1', peer)).toBe(true);
      expect(compare).toHaveBeenCalledTimes(2);
    } finally {
      compare.mockRestore();
    }
  });

  it('never puts the secret in a proof, and a disposed verifier refuses', () => {
    const credential = createDaemonOwnerCredential();
    const secret = credential.rotate();
    const peer = credential.provePeer('connection-1', DATA_ROOT_HASH);
    const encoded = Buffer.from(secret, 'hex').toString('base64url');
    // Booleans only, so a failure never prints the secret.
    expect(peer.includes(secret) || peer.includes(encoded)).toBe(false);
    expect(peer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const verifier = verifierFor(secret);
    expect(() => JSON.stringify(verifier)).toThrow(
      'An owner proof verifier is not serializable.',
    );
    verifier.dispose();
    expect(verifier.verifyPeer('connection-1', peer)).toBe(false);
  });

  it('throws before any secret exists', () => {
    expect(() =>
      createDaemonOwnerCredential().provePeer('connection-1', DATA_ROOT_HASH),
    ).toThrow('No daemon owner secret was created.');
  });
});

describe('desktop peer proof wiring (CAN-7201)', () => {
  it('offers a peer proof only once this launch recorded a spawn', () => {
    const credential = createDaemonOwnerCredential();
    expect(credential.peerProof(DATA_ROOT_HASH)).toBeUndefined();
    const secret = credential.rotate();
    // Rotated for a spawn that has not happened, or attached: none.
    expect(credential.peerProof(DATA_ROOT_HASH)).toBeUndefined();
    credential.recordSpawn({ pid: 4321 });
    const prove = credential.peerProof(DATA_ROOT_HASH);
    if (!prove) throw new Error('Expected a peer proof after a spawn.');
    const proof = prove('connection-1');
    const verifier = createCanopyOwnerProofVerifier({
      secret: Buffer.from(secret, 'hex'),
      dataRootHash: DATA_ROOT_HASH,
    });
    expect(verifier.verifyPeer('connection-1', proof)).toBe(true);
    expect(verifier.verify('connection-1', proof)).toBe(false);
    credential.rotate();
    expect(credential.peerProof(DATA_ROOT_HASH)).toBeUndefined();
  });
});
