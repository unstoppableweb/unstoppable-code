import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHubCredentialLeasePort } from '../../git/github-credential-lease';
import type { PlatformKeySlotReadResult } from '../../../platform/secret-protection';
import type {
  VaultFamilyWriter,
  VaultRepository,
} from '../../../vault/contracts';
import {
  createFakeSecretProtection,
  type FakeSecretProtectionFault,
} from '../../../platform/testing/fake-secret-protection';
import { createDaemonVault, type DaemonVault } from '../daemon-vault';
import {
  createGitHubCredentialAuthority,
  type GitHubCredentialAuthority,
  type GitHubCredentialFenceStore,
} from '../github-credential-authority';
import * as readRepository from '../repository/read-repository';
import { createGitHubCredentialFenceStore } from '../github-credential-fence-store';
import {
  createLegacyPatGenerationReader,
  legacyPatCiphertextGeneration,
} from '../legacy-pat-generation';
import { recordingSecureFiles } from '../repository/__tests__/store-fixtures';

const openReadRepository = readRepository.openVaultReadRepository;
const identity = { brandId: 'canopy', build: 'development' };
const bytes = (): Uint8Array => Buffer.from('test-only-pat');
let root: string;
let vault: DaemonVault;
let generation: string | null;
let slots: ReturnType<typeof createFakeSecretProtection>;
let fences: GitHubCredentialFenceStore;
let authority: GitHubCredentialAuthority;
let repository: VaultRepository;
let writer: VaultFamilyWriter;
let fencePath: string;

function create(fenceStore = fences): GitHubCredentialAuthority {
  return createGitHubCredentialAuthority({
    identity,
    repository: () => Promise.resolve(repository),
    probeKeyIfDue: () => vault.probeKeyIfDue(),
    writer: () => Promise.resolve(writer),
    fences: fenceStore,
    legacyGeneration: () => Promise.resolve(generation),
  });
}
async function seed(): Promise<void> {
  expect(
    await authority.set({
      source: identity,
      legacyGeneration: 'one',
      material: bytes(),
    }),
  ).toEqual({ kind: 'committed' });
}
async function reopen(
  options: Pick<
    readRepository.VaultReadRepositoryOptions,
    'clock' | 'probeTimeoutMs'
  >,
): Promise<void> {
  await vault.dispose();
  jest
    .spyOn(readRepository, 'openVaultReadRepository')
    .mockImplementation((input) =>
      openReadRepository({ ...input, ...options }),
    );
  vault = createDaemonVault({
    secureDataRoot: root,
    platform: { os: 'darwin', secureFiles: recordingSecureFiles() },
    slots: slots.port,
  });
  repository = await vault.repository();
  writer = await vault.writer('github-pat');
  authority = create();
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gh-authority-'));
  slots = createFakeSecretProtection({ backend: 'macos_keychain' });
  const secureFiles = {
    ...recordingSecureFiles(),
    rename: async (request: {
      from: string;
      to: string;
    }): Promise<{ kind: 'renamed'; sourceState: 'removed' }> => {
      await rename(request.from, request.to);
      return { kind: 'renamed', sourceState: 'removed' };
    },
  };
  vault = createDaemonVault({
    secureDataRoot: root,
    platform: { os: 'darwin', secureFiles },
    slots: slots.port,
  });
  repository = await vault.repository();
  writer = await vault.writer('github-pat');
  fences = createGitHubCredentialFenceStore({
    secureDataRoot: root,
    secureFiles,
  });
  fencePath = join(root, 'github-pat-fence.json');
  generation = 'one';
  authority = create();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await vault.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('CAN-5788 generation-fenced daemon GitHub custody', () => {
  it.each(['rotation', 'absent legacy'] as const)(
    'qualifies real ciphertext %s across restart, stale deletion and replacement',
    async (change) => {
      const legacyPath = join(root, 'github-pat.enc');
      const ciphertext = Buffer.from('encrypted-legacy-generation-one');
      await writeFile(legacyPath, ciphertext);
      const legacyGeneration = createLegacyPatGenerationReader({
        identity,
        paths: [legacyPath],
      });
      const compose = (): GitHubCredentialAuthority =>
        createGitHubCredentialAuthority({
          identity,
          repository: () => Promise.resolve(repository),
          probeKeyIfDue: () => vault.probeKeyIfDue(),
          writer: () => Promise.resolve(writer),
          fences,
          legacyGeneration,
        });
      const firstGeneration = legacyPatCiphertextGeneration(ciphertext);
      expect(
        await compose().set({
          source: identity,
          legacyGeneration: firstGeneration,
          material: bytes(),
        }),
      ).toEqual({ kind: 'committed' });
      const oldFence = await readFile(fencePath, 'utf8');
      const oldEntry = (await vault.list())[0];
      if (!oldEntry) throw new Error('Missing initial entry');
      const read = await compose().resolve('git-fetch');
      if (read.kind !== 'available') throw new Error('Missing initial PAT');
      try {
        if (change === 'rotation')
          await writeFile(legacyPath, 'encrypted-legacy-generation-two');
        else await unlink(legacyPath);
        const spawn = jest.fn();
        expect(await read.admit(spawn)).toEqual({
          kind: 'refused',
          reason: 'stale',
        });
        expect(spawn).not.toHaveBeenCalled();
        expect(await repository.get(oldEntry.ref)).toMatchObject({
          kind: 'not_found',
          reason: 'deleted',
        });
        expect(await readFile(fencePath, 'utf8')).toBe(oldFence);
        await reopen({});
        const owner = compose();
        expect(await owner.resolve('git-push')).toEqual({
          kind: 'absent',
          reason: 'absent',
        });
        expect(
          await owner.set({
            source: identity,
            legacyGeneration: firstGeneration,
            material: bytes(),
          }),
        ).toEqual({ kind: 'absent', reason: 'stale' });
        expect(await vault.list()).toEqual([]);
        expect(await readFile(fencePath, 'utf8')).toBe(oldFence);
        if (change === 'absent legacy')
          await writeFile(legacyPath, 'encrypted-legacy-generation-two');
        const nextGeneration = await legacyGeneration(identity);
        if (!nextGeneration) throw new Error('Missing replacement generation');
        expect(
          await owner.set({
            source: identity,
            legacyGeneration: nextGeneration,
            material: Buffer.from('replacement-test-only-pat'),
          }),
        ).toEqual({ kind: 'committed' });
        const nextFence = await fences.read();
        expect(nextFence?.legacyGeneration).toBe(nextGeneration);
        expect(nextFence?.pin.ref.entryId).not.toBe(oldEntry.ref.entryId);
        const replacement = await compose().resolve('git-push');
        if (replacement.kind !== 'available')
          throw new Error('Missing replacement PAT');
        expect(replacement.material).toEqual(
          Buffer.from('replacement-test-only-pat'),
        );
        replacement.material.fill(0);
        // A retained pre-delete sidecar cannot authorize a newly created entry.
        await writeFile(fencePath, oldFence);
        expect(await compose().resolve('git-fetch')).toEqual({
          kind: 'absent',
          reason: 'stale',
        });
        expect(await vault.list()).toEqual([]);
        expect(await readFile(legacyPath, 'utf8')).toBe(
          'encrypted-legacy-generation-two',
        );
      } finally {
        read.material.fill(0);
      }
    },
  );

  it.each(['rotation', 'absent legacy'] as const)(
    'deletes a real %s stale copy after a locked-key reopen without probing the key',
    async (change) => {
      const legacyPath = join(root, 'github-pat.enc');
      const ciphertext = Buffer.from('encrypted-legacy-generation-one');
      await writeFile(legacyPath, ciphertext);
      const legacyGeneration = createLegacyPatGenerationReader({
        identity,
        paths: [legacyPath],
      });
      const compose = (): GitHubCredentialAuthority =>
        createGitHubCredentialAuthority({
          identity,
          repository: () => Promise.resolve(repository),
          probeKeyIfDue: () => vault.probeKeyIfDue(),
          writer: () => Promise.resolve(writer),
          fences,
          legacyGeneration,
        });
      expect(
        await compose().set({
          source: identity,
          legacyGeneration: legacyPatCiphertextGeneration(ciphertext),
          material: bytes(),
        }),
      ).toEqual({ kind: 'committed' });
      const before = await readFile(fencePath, 'utf8');
      const entry = (await vault.list())[0];
      if (!entry) throw new Error('Missing initial entry');
      if (change === 'rotation')
        await writeFile(legacyPath, 'encrypted-legacy-generation-two');
      else await unlink(legacyPath);
      slots.inject({ kind: 'locked' });
      await reopen({});
      expect(repository.status().protection.state).not.toBe('available');
      const reads = jest.spyOn(slots.port, 'readKeySlot');
      const probes = jest.spyOn(vault, 'probeKeyIfDue');
      expect(await compose().resolve('git-fetch')).toEqual({
        kind: 'absent',
        reason: 'stale',
      });
      expect(reads).not.toHaveBeenCalled();
      expect(probes).not.toHaveBeenCalled();
      expect(await repository.get(entry.ref)).toMatchObject({
        kind: 'not_found',
        reason: 'deleted',
      });
      expect(await readFile(fencePath, 'utf8')).toBe(before);
      await reopen({});
      expect(await vault.list()).toEqual([]);
      expect(await compose().resolve('git-fetch')).toEqual({
        kind: 'absent',
        reason: 'absent',
      });
      if (change === 'rotation')
        expect(await readFile(legacyPath, 'utf8')).toBe(
          'encrypted-legacy-generation-two',
        );
      else
        await expect(readFile(legacyPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
    },
  );

  it('rotates the same entry revision and refuses an outstanding old admission without deleting the replacement', async () => {
    await seed();
    const firstFence = await fences.read();
    if (!firstFence) throw new Error('Missing initial fence');
    const read = await authority.resolve('git-fetch');
    if (read.kind !== 'available') throw new Error('Missing initial PAT');
    try {
      generation = 'two';
      expect(
        await authority.set({
          source: identity,
          legacyGeneration: generation,
          material: Buffer.from('rotated-test-only-pat'),
        }),
      ).toEqual({ kind: 'committed' });
      const nextFence = await fences.read();
      expect(nextFence?.pin.ref).toEqual(firstFence.pin.ref);
      expect(nextFence?.pin.revision).toBe(firstFence.pin.revision + 1);
      const spawn = jest.fn();
      expect(await read.admit(spawn)).toEqual({
        kind: 'refused',
        reason: 'stale',
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(await vault.list()).toHaveLength(1);
      const replacement = await create().resolve('git-fetch');
      if (replacement.kind !== 'available')
        throw new Error('Missing rotated PAT');
      expect(replacement.material).toEqual(
        Buffer.from('rotated-test-only-pat'),
      );
      replacement.material.fill(0);
    } finally {
      read.material.fill(0);
    }
  });

  it('accepts the generation length boundary without persisting secret material', async () => {
    await seed();
    const fence = await fences.read();
    if (!fence) throw new Error('Missing fence');
    const boundary = { ...fence, legacyGeneration: 'x'.repeat(4096) };
    await fences.write(boundary);
    expect(await fences.read()).toEqual(boundary);
    expect(await readFile(fencePath, 'utf8')).not.toContain('test-only-pat');
  });

  it('excludes a competing vault connection before it can obtain a family writer', async () => {
    await seed();
    const before = await readFile(fencePath, 'utf8');
    const competing = createDaemonVault({
      secureDataRoot: root,
      platform: { os: 'darwin', secureFiles: recordingSecureFiles() },
      slots: slots.port,
    });
    try {
      await expect(competing.writer('github-pat')).rejects.toThrow();
      expect(await readFile(fencePath, 'utf8')).toBe(before);
      expect(await vault.list()).toHaveLength(1);
      await expect(vault.writer('github-pat')).rejects.toThrow();
      await expect(vault.writer('copilot-account')).rejects.toThrow();
      // The same contender succeeds once the owner releases its SQLite lock.
      await vault.dispose();
      await expect(competing.writer('github-pat')).resolves.toMatchObject({
        family: 'github-pat',
      });
      const contenderRepository = await competing.repository();
      const entry = (await competing.list())[0];
      if (!entry) throw new Error('Missing retained entry');
      const read = await contenderRepository.get(entry.ref);
      if (read.kind !== 'available') throw new Error('Missing retained PAT');
      try {
        expect(read.material).toEqual(bytes());
        expect(await readFile(fencePath, 'utf8')).toBe(before);
      } finally {
        read.material.fill(0);
      }
    } finally {
      await competing.dispose();
    }
  });

  it.each([
    'older',
    'newer',
    'oversized',
    'empty generation',
    'long generation',
  ])(
    'preserves a rejected %s sidecar while deleting only the stale vault copy',
    async (shape) => {
      await seed();
      const fence = await fences.read();
      if (!fence) throw new Error('Missing fence');
      const raw = JSON.stringify({
        version: shape === 'older' ? 0 : shape === 'newer' ? 2 : 1,
        ...fence,
        legacyGeneration:
          shape === 'empty generation'
            ? ''
            : shape === 'long generation'
              ? 'x'.repeat(4097)
              : fence.legacyGeneration,
        ...(shape === 'oversized' ? { padding: 'x'.repeat(16_384) } : {}),
      });
      await writeFile(fencePath, raw);
      expect(await fences.read()).toBeNull();
      expect(await readFile(fencePath, 'utf8')).toBe(raw);
      expect(await create().resolve('git-fetch')).toEqual({
        kind: 'absent',
        reason: 'stale',
      });
      expect(await vault.list()).toEqual([]);
      expect(await readFile(fencePath, 'utf8')).toBe(raw);
    },
  );

  it.each(['rename', 'directory sync'] as const)(
    'refuses a %s publication failure and cleans its temporary',
    async (failure) => {
      await seed();
      const before = await readFile(fencePath, 'utf8');
      const failingStore = createGitHubCredentialFenceStore({
        secureDataRoot: root,
        secureFiles: {
          ...recordingSecureFiles(),
          rename: async (request) => {
            if (failure === 'rename') throw new Error('rename failed');
            await rename(request.from, request.to);
            return { kind: 'renamed', sourceState: 'removed' };
          },
          syncDirectory: () => Promise.reject(new Error('flush failed')),
        },
      });
      const owner = create(failingStore);
      expect(
        await owner.set({
          source: identity,
          legacyGeneration: 'one',
          material: bytes(),
        }),
      ).toEqual({ kind: 'blocked', reason: 'unconfirmed' });
      expect(
        (await readdir(root)).filter((name) =>
          name.startsWith('.github-pat-fence-'),
        ),
      ).toEqual([]);
      if (failure === 'rename')
        expect(await readFile(fencePath, 'utf8')).toBe(before);
      else expect(await readFile(fencePath, 'utf8')).not.toBe(before);
      // An installed but unflushed fence remains unconfirmed in this authority.
      expect(await owner.resolve('git-push')).toEqual(
        failure === 'rename'
          ? { kind: 'absent', reason: 'stale' }
          : { kind: 'blocked', reason: 'unconfirmed' },
      );
      if (failure === 'directory sync') {
        const fresh = await create().resolve('git-fetch');
        if (fresh.kind !== 'available')
          throw new Error(
            'Expected matching installed fence after local uncertainty',
          );
        fresh.material.fill(0);
      }
    },
  );

  describe.each<{
    fault: FakeSecretProtectionFault;
    reason: string;
  }>([
    { fault: { kind: 'locked' }, reason: 'locked' },
    { fault: { kind: 'denied' }, reason: 'denied' },
    {
      fault: { kind: 'unavailable', reason: 'backend_failed' },
      reason: 'unavailable',
    },
  ])('key recovery from $reason', ({ fault, reason }) => {
    it.each([
      { operation: 'set', existing: false },
      { operation: 'importIfAbsent', existing: false },
      { operation: 'set', existing: true },
    ] as const)(
      'throttles blocked $operation (existing: $existing) and recovers without restart',
      async ({ operation, existing }) => {
        if (existing) await seed();
        slots.inject(fault);
        let now = Date.now();
        await reopen({ clock: () => new Date(now) });
        const reads = jest.spyOn(slots.port, 'readKeySlot');
        const input = {
          source: identity,
          legacyGeneration: 'one',
          material: bytes(),
        };
        if (existing) {
          expect(await authority.importIfAbsent(input)).toEqual({
            kind: 'unchanged',
          });
          expect(reads).not.toHaveBeenCalled();
        }
        expect(await authority[operation](input)).toEqual({
          kind: 'blocked',
          reason,
        });
        expect(reads).not.toHaveBeenCalled();
        now += 2000;
        expect(await authority[operation](input)).toEqual({
          kind: 'blocked',
          reason,
        });
        expect(reads).toHaveBeenCalledTimes(1);
        expect(
          await Promise.all(
            Array.from({ length: 4 }, () => authority[operation](input)),
          ),
        ).toEqual(
          Array.from({ length: 4 }, () => ({ kind: 'blocked', reason })),
        );
        expect(reads).toHaveBeenCalledTimes(1);
        slots.clearFaults();
        if (!existing)
          expect(await authority.resolve('git-push')).toEqual({
            kind: 'absent',
            reason: 'absent',
          });
        now += 1999;
        expect(await authority[operation](input)).toEqual({
          kind: 'blocked',
          reason,
        });
        expect(reads).toHaveBeenCalledTimes(1);
        now += 1;
        expect(await authority[operation](input)).toEqual({
          kind: 'committed',
        });
        expect(reads).toHaveBeenCalledTimes(2);
        for (const [, options] of reads.mock.calls)
          expect(options.interaction).toBe('never');
        reads.mockClear();
        expect(await authority[operation](input)).toEqual({
          kind: operation === 'importIfAbsent' ? 'unchanged' : 'committed',
        });
        expect(reads).not.toHaveBeenCalled();
        const read = await authority.resolve('git-fetch');
        expect(read.kind).toBe('available');
        if (read.kind === 'available') {
          expect(read.material).toEqual(bytes());
          read.material.fill(0);
        }
        expect(slots.prompts).toBe(0);
      },
    );
  });

  it.each(['dispose', 'timeout'] as const)(
    'fails closed and zeroes a late key when a write probe ends by %s',
    async (ending) => {
      slots.inject({ kind: 'locked' });
      let now = Date.now();
      await reopen({ clock: () => new Date(now), probeTimeoutMs: 20 });
      slots.clearFaults();
      now += 2000;
      let release: (result: PlatformKeySlotReadResult) => void = () => {
        throw new Error('Probe not started');
      };
      const pending = new Promise<PlatformKeySlotReadResult>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let lateKey: Uint8Array | undefined;
      let signal: AbortSignal | undefined;
      const reads = jest
        .spyOn(slots.port, 'readKeySlot')
        .mockImplementationOnce((slot, options) => {
          const stored = slots.peek(slot.name);
          if (!(stored instanceof Uint8Array))
            throw new Error('Missing test key');
          lateKey = stored;
          signal = options.signal;
          expect(options.interaction).toBe('never');
          entered();
          return pending;
        });
      const input = {
        source: identity,
        legacyGeneration: 'one',
        material: bytes(),
      };
      const writing = authority.set(input);
      await started;
      if (ending === 'dispose') await vault.dispose();
      expect(await writing).toEqual({ kind: 'blocked', reason: 'unavailable' });
      expect(signal?.aborted).toBe(true);
      expect(await repository.list()).toEqual([]);
      if (!lateKey) throw new Error('Probe did not capture key');
      if (ending === 'timeout') {
        // A timed-out backend still owns its slot until its call settles.
        now += 2000;
        expect(await authority.set(input)).toEqual({
          kind: 'blocked',
          reason: 'unavailable',
        });
        expect(reads).toHaveBeenCalledTimes(1);
      }
      release({ kind: 'present', material: lateKey });
      await pending;
      expect(lateKey.every((byte) => byte === 0)).toBe(true);
      if (ending === 'dispose') {
        await expect(vault.probeKeyIfDue()).rejects.toThrow();
        expect(await authority.importIfAbsent(input)).toEqual({
          kind: 'blocked',
          reason: 'unavailable',
        });
        expect(reads).toHaveBeenCalledTimes(1);
      } else {
        now += 2000;
        expect(await authority.set(input)).toEqual({ kind: 'committed' });
        expect(reads).toHaveBeenCalledTimes(2);
      }
      expect(slots.prompts).toBe(0);
    },
  );

  it('reports absent, and serves both purposes through the durable singleton', async () => {
    expect(await authority.resolve('git-push')).toEqual({
      kind: 'absent',
      reason: 'absent',
    });
    await seed();
    for (const purpose of ['git-push', 'git-fetch'] as const) {
      const read = await authority.resolve(purpose);
      expect(read.kind).toBe('available');
      if (read.kind !== 'available') throw new Error('Expected credential');
      expect(read.material).toEqual(bytes());
      expect(await read.admit(() => undefined)).toEqual({
        kind: 'admitted',
        value: undefined,
      });
      read.material.fill(0);
    }
    const text = await readFile(fencePath, 'utf8');
    expect(text).not.toContain('test-only-pat');
    expect((await stat(fencePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(text)).toMatchObject({
      version: 1,
      source: identity,
      legacyGeneration: 'one',
    });
    // A fresh authority reloads the persisted fence rather than remembering it.
    const read = await create().resolve('git-fetch');
    expect(read.kind).toBe('available');
    if (read.kind === 'available') read.material.fill(0);
  });

  it.each(['stable', 'rc', 'internal', 'development'])(
    'preserves the copy across artifact updates within release build %s',
    async (build) => {
      const compose = (artifact: string): GitHubCredentialAuthority => {
        const updatedIdentity = { brandId: 'canopy', build, buildId: artifact };
        return createGitHubCredentialAuthority({
          identity: updatedIdentity,
          repository: () => Promise.resolve(repository),
          probeKeyIfDue: () => vault.probeKeyIfDue(),
          writer: () => Promise.resolve(writer),
          fences,
          legacyGeneration: () => Promise.resolve('one'),
        });
      };
      expect(
        await compose('artifact-one').set({
          source: { brandId: 'canopy', build },
          legacyGeneration: 'one',
          material: bytes(),
        }),
      ).toEqual({ kind: 'committed' });
      const read = await compose('artifact-two').resolve('git-fetch');
      expect(read.kind).toBe('available');
      if (read.kind === 'available') read.material.fill(0);
      expect(await fences.read()).toMatchObject({
        source: { brandId: 'canopy', build },
      });
      expect(await readFile(fencePath, 'utf8')).not.toContain('artifact-');
    },
  );

  it('fails closed for the old per-artifact fence shape', async () => {
    await seed();
    const fence = await fences.read();
    await writeFile(
      fencePath,
      JSON.stringify({
        version: 1,
        ...fence,
        source: { brandId: identity.brandId, buildId: 'artifact-one' },
      }),
    );
    expect(await fences.read()).toBeNull();
    expect(await authority.resolve('git-push')).toEqual({
      kind: 'absent',
      reason: 'stale',
    });
    expect(await vault.list()).toEqual([]);
  });

  it.each(['rotate', 'delete'] as const)(
    'deletes stale ciphertext without the key after legacy %s',
    async (change) => {
      await seed();
      const entry = (await vault.list())[0];
      if (!entry) throw new Error('Missing entry');
      // Dropping the held key simulates a locked backend on next open.
      await vault.dispose();
      slots.inject({ kind: 'locked' });
      const secureFiles = recordingSecureFiles();
      vault = createDaemonVault({
        secureDataRoot: root,
        platform: { os: 'darwin', secureFiles },
        slots: slots.port,
      });
      repository = await vault.repository();
      writer = await vault.writer('github-pat');
      generation = change === 'rotate' ? 'two' : null;
      authority = create();
      const reads = jest.spyOn(slots.port, 'readKeySlot');
      expect(await authority.resolve('git-push')).toEqual({
        kind: 'absent',
        reason: 'stale',
      });
      expect(await vault.list()).toEqual([]);
      expect(await repository.get(entry.ref)).toMatchObject({
        kind: 'not_found',
        reason: 'deleted',
      });
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it.each(['unreadable', 'malformed'] as const)(
    'keeps the credential with a %s fence and recovers',
    async (fault) => {
      await seed();
      const original = await readFile(fencePath, 'utf8');
      const entries = await vault.list();
      if (fault === 'unreadable')
        authority = create({
          ...fences,
          read: () => Promise.reject(new Error('IO private path token')),
        });
      else await writeFile(fencePath, '{');
      const retained = await readFile(fencePath, 'utf8');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await authority.resolve('git-fetch')).toEqual({
          kind: 'blocked',
          reason: 'unavailable',
          fenceReadFailure:
            fault === 'unreadable' ? 'read_failed' : 'parse_failed',
        });
        expect(await vault.list()).toEqual(entries);
        expect(await readFile(fencePath, 'utf8')).toBe(retained);
      }
      await writeFile(fencePath, original);
      authority = create();
      const recovered = await authority.resolve('git-fetch');
      expect(recovered.kind).toBe('available');
      if (recovered.kind === 'available') recovered.material.fill(0);
    },
  );

  it.each(['missing', 'brand', 'build', 'revision'] as const)(
    'deletes with a %s fence',
    async (fault) => {
      await seed();
      if (fault === 'missing') await unlink(fencePath);
      else {
        const fence = await fences.read();
        if (!fence) throw new Error('Missing fence');
        await fences.write({
          ...fence,
          source: {
            brandId: fault === 'brand' ? 'other' : identity.brandId,
            build: fault === 'build' ? 'other' : identity.build,
          },
          pin: {
            ...fence.pin,
            revision:
              fault === 'revision'
                ? fence.pin.revision + 1
                : fence.pin.revision,
          },
        });
      }
      expect(await authority.resolve('git-fetch')).toEqual({
        kind: 'absent',
        reason: 'stale',
      });
      expect(await vault.list()).toEqual([]);
    },
  );

  it.each([
    { ...identity, build: '' },
    { ...identity, build: '   ' },
    { ...identity, brandId: '' },
    { ...identity, brandId: '   ' },
  ])(
    'rejects foreign imports and unbound identity %j without writing',
    async (unboundIdentity) => {
      expect(
        await authority.set({
          source: { ...identity, build: 'foreign' },
          legacyGeneration: 'one',
          material: bytes(),
        }),
      ).toEqual({ kind: 'blocked', reason: 'denied' });
      const unbound = createGitHubCredentialAuthority({
        identity: unboundIdentity,
        repository: () => Promise.resolve(repository),
        probeKeyIfDue: () => vault.probeKeyIfDue(),
        writer: () => Promise.resolve(writer),
        fences,
        legacyGeneration: () => Promise.resolve('one'),
      });
      expect(await unbound.resolve('git-push')).toEqual({
        kind: 'blocked',
        reason: 'denied',
      });
      expect(await vault.list()).toEqual([]);
    },
  );

  it('serializes racing imports and replaces, while snapshotting and not retaining caller bytes', async () => {
    const material = bytes();
    const first = authority.importIfAbsent({
      source: identity,
      legacyGeneration: 'one',
      material,
    });
    material.fill(0);
    const rest = Array.from({ length: 12 }, () =>
      authority.importIfAbsent({
        source: identity,
        legacyGeneration: 'one',
        material: bytes(),
      }),
    );
    expect(await first).toEqual({ kind: 'committed' });
    const firstRead = await authority.resolve('git-push');
    if (firstRead.kind !== 'available')
      throw new Error('Missing imported credential');
    expect(firstRead.material).toEqual(bytes());
    firstRead.material.fill(0);
    expect(await Promise.all(rest)).toEqual(
      rest.map(() => ({ kind: 'unchanged' })),
    );
    await Promise.all(
      Array.from({ length: 8 }, () =>
        authority.set({
          source: identity,
          legacyGeneration: 'one',
          material: bytes(),
        }),
      ),
    );
    expect(await vault.list()).toHaveLength(1);
    const read = await authority.resolve('git-fetch');
    if (read.kind !== 'available') throw new Error('Missing credential');
    expect(read.material).toEqual(bytes());
    await authority.clear();
    expect(await read.admit(() => undefined)).toEqual({
      kind: 'refused',
      reason: 'absent',
    });
    read.material.fill(0);
    expect(await authority.clear()).toEqual({ kind: 'committed' });
  });

  it('retains a single writer capability per family at trusted composition', async () => {
    await expect(vault.writer('github-pat')).rejects.toThrow();
    await expect(vault.writer('copilot-account')).rejects.toThrow();
    await vault.dispose();
    vault = createDaemonVault({
      secureDataRoot: root,
      platform: { os: 'darwin', secureFiles: recordingSecureFiles() },
      slots: slots.port,
    });
    const competing = await Promise.allSettled(
      Array.from({ length: 8 }, () => vault.writer('github-pat')),
    );
    expect(
      competing.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      competing.filter((result) => result.status === 'rejected'),
    ).toHaveLength(7);
  });

  it('retries writer creation after a synchronous failure without issuing twice', async () => {
    await vault.dispose();
    const open = readRepository.openVaultReadRepository;
    let attempted = false;
    jest
      .spyOn(readRepository, 'openVaultReadRepository')
      .mockImplementation(async (options) => {
        const opened = await open(options);
        if (opened.kind === 'opened') {
          jest.spyOn(opened.vault, 'writer').mockImplementationOnce(() => {
            attempted = true;
            throw new Error('writer creation failed');
          });
        }
        return opened;
      });
    vault = createDaemonVault({
      secureDataRoot: root,
      platform: { os: 'darwin', secureFiles: recordingSecureFiles() },
      slots: slots.port,
    });
    await expect(vault.writer('github-pat')).rejects.toThrow(
      'writer creation failed',
    );
    expect(attempted).toBe(true);
    const competing = await Promise.allSettled(
      Array.from({ length: 8 }, () => vault.writer('github-pat')),
    );
    expect(
      competing.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      competing.filter((result) => result.status === 'rejected'),
    ).toHaveLength(7);
  });

  it('closes the put/fence crash gap and refuses uncertain fences', async () => {
    const broken = create({
      ...fences,
      write: () => Promise.reject(new Error('crash before fence commit')),
    });
    expect(
      await broken.set({
        source: identity,
        legacyGeneration: 'one',
        material: bytes(),
      }),
    ).toEqual({ kind: 'blocked', reason: 'unconfirmed' });
    expect(await create().resolve('git-push')).toEqual({
      kind: 'absent',
      reason: 'stale',
    });
    expect(await vault.list()).toEqual([]);
    await seed();
    // A replacement's old fence cannot admit its new revision either.
    expect(
      await broken.set({
        source: identity,
        legacyGeneration: 'one',
        material: bytes(),
      }),
    ).toEqual({ kind: 'blocked', reason: 'unconfirmed' });
    expect(await create().resolve('git-push')).toEqual({
      kind: 'absent',
      reason: 'stale',
    });
  });

  it('reports unavailable generation IO without returning or deleting a valid token', async () => {
    await seed();
    const offline = createGitHubCredentialAuthority({
      identity,
      repository: () => Promise.resolve(repository),
      probeKeyIfDue: () => vault.probeKeyIfDue(),
      writer: () => Promise.resolve(writer),
      fences,
      legacyGeneration: () => Promise.reject(new Error('offline')),
    });
    expect(await offline.resolve('git-fetch')).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    });
    expect(await vault.list()).toHaveLength(1);
  });

  it.each(['read-error', 'identity-mismatch'])(
    'fails closed on a real generation reader %s, without preventing clear',
    async (fault) => {
      await seed();
      const unavailable = createGitHubCredentialAuthority({
        identity,
        repository: () => Promise.resolve(repository),
        probeKeyIfDue: () => vault.probeKeyIfDue(),
        writer: () => Promise.resolve(writer),
        fences,
        legacyGeneration: createLegacyPatGenerationReader({
          identity:
            fault === 'identity-mismatch'
              ? { ...identity, build: 'stable' }
              : identity,
          paths: [root], // A directory is an unreadable ciphertext source on every host.
        }),
      });
      await expect(unavailable.resolve('git-push')).resolves.toEqual({
        kind: 'blocked',
        reason: 'unavailable',
      });
      await expect(
        unavailable.set({
          source: identity,
          legacyGeneration: 'one',
          material: bytes(),
        }),
      ).resolves.toEqual({ kind: 'blocked', reason: 'unavailable' });
      expect(await vault.list()).toHaveLength(1);
      await expect(unavailable.clear()).resolves.toEqual({ kind: 'committed' });
      expect(await vault.list()).toHaveLength(0);
    },
  );

  it.each([
    'locked',
    'denied',
    'unavailable',
    'key_missing',
    'unconfirmed',
  ] as const)('preserves the typed %s read reason', async (reason) => {
    await seed();
    const refused: VaultRepository = {
      ...repository,
      get: () =>
        Promise.resolve(
          reason === 'unconfirmed'
            ? { kind: 'unconfirmed', state: 'unconfirmed' }
            : { kind: 'blocked', reason },
        ),
    };
    const owner = createGitHubCredentialAuthority({
      identity,
      repository: () => Promise.resolve(refused),
      probeKeyIfDue: () => vault.probeKeyIfDue(),
      writer: () => Promise.resolve(writer),
      fences,
      legacyGeneration: () => Promise.resolve(generation),
    });
    expect(await owner.resolve('git-push')).toEqual({
      kind: 'blocked',
      reason,
    });
  });

  it('refuses a duplicate family instead of picking a credential', async () => {
    await seed();
    await writer.put({
      entryId: null,
      expectedRevision: null,
      family: 'github-pat',
      label: 'GitHub',
      material: bytes(),
      expiresAt: null,
      idempotencyKey: 'second',
    });
    expect(await authority.resolve('git-push')).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
  });

  it('rechecks a legacy rotation at lease delivery and zeroes the refused value', async () => {
    await seed();
    let copied: Uint8Array | undefined;
    const leases = createGitHubCredentialLeasePort({
      source: {
        resolve: async (purpose) => {
          const read = await authority.resolve(purpose);
          if (read.kind === 'available') copied = read.material;
          return read;
        },
      },
    });
    const request = {
      purpose: 'git-fetch',
      audience: { operation: 'worker.git.fetch', key: 'fetch-one' },
      expiresAt: performance.now() + 1000,
    } as const;
    const result = await leases.mint(request);
    if (result.kind !== 'minted') throw new Error('Expected lease');
    generation = 'two';
    const spawn = jest.fn();
    expect(await result.lease.deliver(request, spawn)).toEqual({
      kind: 'refused',
      reason: 'stale',
    });
    expect(copied?.every((byte) => byte === 0)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(await vault.list()).toEqual([]);
  });

  it('revokes and zeroes outstanding leases synchronously on vault disposal', async () => {
    await seed();
    let copied: Uint8Array | undefined;
    const leases = createGitHubCredentialLeasePort({
      signal: vault.signal,
      source: {
        resolve: async (purpose) => {
          const read = await authority.resolve(purpose);
          if (read.kind === 'available') copied = read.material;
          return read;
        },
      },
    });
    const request = {
      purpose: 'git-push',
      audience: { operation: 'worker.git.push', key: 'disposed' },
      expiresAt: performance.now() + 1000,
    } as const;
    const result = await leases.mint(request);
    if (result.kind !== 'minted') throw new Error('Expected lease');
    const disposal = vault.dispose();
    expect(copied?.every((byte) => byte === 0)).toBe(true);
    const spawn = jest.fn();
    expect(await result.lease.deliver(request, spawn)).toEqual({
      kind: 'refused',
      reason: 'revoked',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(await leases.mint(request)).toEqual({
      kind: 'refused',
      reason: 'revoked',
    });
    await disposal;
  });

  it('keeps a queued clear outside the final admission-to-spawn critical section', async () => {
    await seed();
    let arm = false;
    let deleting = false;
    let cleared: Promise<unknown> | undefined;
    const guardedRepository: VaultRepository = {
      ...repository,
      admit: (pin) => {
        if (arm) {
          arm = false;
          cleared = owner.clear();
        }
        return repository.admit(pin);
      },
    };
    const owner = createGitHubCredentialAuthority({
      identity,
      repository: () => Promise.resolve(guardedRepository),
      probeKeyIfDue: () => vault.probeKeyIfDue(),
      writer: () =>
        Promise.resolve({
          ...writer,
          delete: (request) => {
            deleting = true;
            return writer.delete(request);
          },
        }),
      fences,
      legacyGeneration: () => Promise.resolve(generation),
    });
    const read = await owner.resolve('git-push');
    if (read.kind !== 'available') throw new Error('Missing credential');
    arm = true;
    const outcome = await read.admit(() => {
      expect(deleting).toBe(false);
      return 'spawned';
    });
    expect(outcome).toEqual({ kind: 'admitted', value: 'spawned' });
    await cleared;
    expect(deleting).toBe(true);
    read.material.fill(0);
  });

  it('never confirms a stale deletion with an uncertain durability outcome', async () => {
    await seed();
    generation = null;
    const owner = createGitHubCredentialAuthority({
      identity,
      repository: () => Promise.resolve(repository),
      probeKeyIfDue: () => vault.probeKeyIfDue(),
      writer: () =>
        Promise.resolve({
          ...writer,
          delete: (request) =>
            Promise.resolve({
              kind: 'outcome_unknown',
              ref: request.ref,
            }),
        }),
      fences,
      legacyGeneration: () => Promise.resolve(generation),
    });
    expect(await owner.resolve('git-push')).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
    });
  });
});
