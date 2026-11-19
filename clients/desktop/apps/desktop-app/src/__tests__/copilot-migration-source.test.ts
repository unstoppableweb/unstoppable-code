import type * as NodeFiles from 'node:fs/promises';
import type * as RotationAttempt from '../main/copilot/rotation-attempt';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as AtomicFile from '../main/lib/atomic-file';
import {
  beginCopilotMigrationBarrier,
  clearCopilotGrant,
  commitCopilotGrant,
  copilotGrantAuthority,
  deleteCopilotGrant,
  readCopilotCredential,
  resumeCopilotGrant,
  type CopilotMigrationBarrier,
  type CopilotMigrationQuiescence,
} from '../main/copilot/grant-authority';
import type {
  CopilotGrant,
  CopilotMigrationSource,
} from '../main/copilot/credential-store';
import { observeCopilotLegacyCiphertext } from '@canopy/core-runtime/node/vault';

let mockFile: string;
const mockDecrypt = jest.fn((raw: Buffer): string => {
  const text = raw.toString('utf8');
  if (!text.startsWith('synthetic:')) throw new Error('unreadable');
  return text.slice('synthetic:'.length);
});
jest.mock('../main/lib/paths', () => ({
  getCopilotCredentialFilePath: (): string => mockFile,
  getCopilotRotationAttemptPath: (): string =>
    join(root, 'copilot-rotation-attempt.json'),
}));
jest.mock('../main/copilot/rotation-attempt', () => ({
  writeCopilotRotationAttempt: (): Promise<void> => Promise.resolve(),
  removeCopilotRotationAttempt: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../main/lib/secure-storage-policy', () => ({
  getSecretStoragePolicy: (): object => ({
    decrypt: mockDecrypt,
    encrypt: (value: string): Buffer => Buffer.from(`synthetic:${value}`),
    assertCanWrite: (): void => undefined,
    isWriteAvailable: (): boolean => true,
  }),
  getSecureStorageFailure: (): undefined => undefined,
}));
const grant: CopilotGrant = {
  clientId: 'client',
  host: 'github.com',
  login: 'pilot',
  id: '1',
  accessToken: 'synthetic-access',
  refreshToken: 'synthetic-refresh',
  accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
  refreshTokenExpiresAt: '2099-02-01T00:00:00.000Z',
};
let root: string;
let barrier: CopilotMigrationBarrier | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'copilot-source-'));
  mockFile = join(root, 'copilot-account.enc');
  mockDecrypt.mockClear();
});
afterEach(async () => {
  jest.restoreAllMocks();
  barrier?.release();
  barrier = undefined;
  await clearCopilotGrant();
  await rm(root, { recursive: true, force: true });
});
async function proof(): Promise<CopilotMigrationQuiescence> {
  barrier = beginCopilotMigrationBarrier();
  const result = await barrier.quiesce(new AbortController().signal);
  if (result.kind !== 'quiescent') throw new Error('No affirmative quiescence');
  return result.proof;
}
function encoded(value: unknown): Buffer {
  return Buffer.from(`synthetic:${JSON.stringify(value)}`);
}
it.each(['absent', 'present', 'unreadable', 'stale'] as const)(
  'P8 diagnostic %s is observational and cannot change source capture or admit legacy demand',
  async (kind) => {
    const diagnostic = jest.requireActual<typeof RotationAttempt>(
      '../main/copilot/rotation-attempt',
    );
    const path = join(root, 'copilot-rotation-attempt.json');
    const bytes = encoded({ version: 1, ...grant });
    await writeFile(mockFile, bytes);
    if (kind === 'present' || kind === 'stale')
      await diagnostic.writeCopilotRotationAttempt({
        attemptId: kind,
        bootId: 'departed-boot',
        accountEpoch: {
          host: grant.host,
          id: kind === 'stale' ? 'foreign-account' : grant.id,
          entryId: 'not-an-authoritative-entry',
        },
        fromDigest: 'diagnostic-only-digest',
      });
    else if (kind === 'unreadable') await writeFile(path, 'not json');
    const previous = kind === 'absent' ? null : await readFile(path);
    expect(await diagnostic.probeCopilotRotationAttempt()).toBe(
      kind === 'stale' ? 'present' : kind,
    );
    const frozen = await proof();
    expect(() => readCopilotCredential()).toThrow();
    await frozen.withSource(async (source): Promise<void> => {
      expect(await source.capture()).toMatchObject({
        kind: 'present',
        grant: { refreshToken: grant.refreshToken },
      });
    });
    expect(await readFile(mockFile)).toEqual(bytes);
    if (previous) expect(await readFile(path)).toEqual(previous);
    else await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
it('P8 late diagnostic completion cannot remove a newer attempt or mutate the stored grant', async () => {
  const diagnostic = jest.requireActual<typeof RotationAttempt>(
    '../main/copilot/rotation-attempt',
  );
  const path = join(root, 'copilot-rotation-attempt.json');
  const bytes = encoded({ version: 1, ...grant });
  await writeFile(mockFile, bytes);
  const original = {
    attemptId: 'old-attempt',
    bootId: 'boot',
    accountEpoch: { host: grant.host, id: grant.id, entryId: 'old-entry' },
    fromDigest: 'diagnostic-only-digest',
  };
  await diagnostic.writeCopilotRotationAttempt(original);
  const newer = { ...original, attemptId: 'new-attempt' };
  await diagnostic.writeCopilotRotationAttempt(newer);
  const retained = await readFile(path);
  await diagnostic.removeCopilotRotationAttempt(original.attemptId);
  expect(await readFile(path)).toEqual(retained);
  expect(retained.toString()).not.toContain(grant.refreshToken);
  expect(retained.toString()).not.toContain(grant.accessToken);
  await diagnostic.removeCopilotRotationAttempt(newer.attemptId);
  expect(await diagnostic.probeCopilotRotationAttempt()).toBe('absent');
  expect(await readFile(mockFile)).toEqual(bytes);
});
it.each([false, true])(
  'captures %s revisioned source without adoption, ID minting or ciphertext rewrite, and core observes those same bytes',
  async (revisioned) => {
    const bytes = encoded({
      version: 1,
      ...grant,
      ...(revisioned ? { entryId: 'a'.repeat(32), revision: 4 } : {}),
      ignored: 'not custody',
    });
    await writeFile(mockFile, bytes);
    const frozen = await proof();
    // A new authority must not be manufactured to obtain an epoch via binding().
    expect(mockDecrypt).not.toHaveBeenCalled();
    await frozen.withSource(async (source): Promise<void> => {
      const captured = await source.capture();
      expect(captured).toEqual({
        kind: 'present',
        generation: createHash('sha256').update(bytes).digest('hex'),
        grant: { version: 1, ...grant },
      });
      expect(await observeCopilotLegacyCiphertext(source.ciphertext)).toEqual({
        kind: 'present',
        generation: createHash('sha256').update(bytes).digest('hex'),
      });
      expect(
        await source.compare(createHash('sha256').update(bytes).digest('hex')),
      ).toBe('same');
      expect(await source.compare('not-this-generation')).toBe('changed');
    });
    expect(await readFile(mockFile)).toEqual(bytes);
    expect(mockDecrypt).toHaveBeenCalledTimes(1);
  },
);
it.each([
  ['absent', undefined],
  ['malformed', encoded({ version: 1 })],
  ['malformed', Buffer.from('synthetic:not-json')],
  ['unreadable', Buffer.from('not-readable')],
  ['malformed', encoded({ version: 1, ...grant, revision: 1 })],
  ['malformed', encoded({ version: 1, ...grant, id: 'not-numeric' })],
  ['malformed', Buffer.alloc(0)],
  ['malformed', Buffer.alloc(1048577)],
] as const)(
  'distinguishes source %s without changing the source',
  async (kind, bytes) => {
    if (bytes) await writeFile(mockFile, bytes);
    const frozen = await proof();
    await frozen.withSource(async (source): Promise<void> => {
      expect(await source.capture()).toEqual({ kind });
    });
    if (bytes) expect(await readFile(mockFile)).toEqual(bytes);
  },
);
it('rejects a symlink and expires source capabilities and gate generations on release', async () => {
  const neighbor = join(root, 'neighbor');
  await writeFile(neighbor, encoded({ version: 1, ...grant }));
  await symlink(neighbor, mockFile);
  const frozen = await proof();
  let escaped: CopilotMigrationSource | undefined;
  await frozen.withSource(async (source): Promise<void> => {
    escaped = source;
    expect(await source.capture()).toEqual({ kind: 'malformed' });
  });
  expect(await escaped?.capture()).toEqual({ kind: 'outcome_unknown' });
  barrier?.release();
  barrier = undefined;
  expect(frozen.current()).toBe(false);
  await expect(frozen.withSource(() => Promise.resolve())).rejects.toThrow();
  expect(await readFile(neighbor)).toEqual(encoded({ version: 1, ...grant }));
});
it('fences cached broker presentation, binding, new factories, resume, setup writes and clears while its queue is held', async () => {
  await commitCopilotGrant(grant);
  const authority = copilotGrantAuthority(grant, {
    refresh: (): Promise<never> =>
      Promise.reject(new Error('unexpected refresh')),
    onCleared: (): void => undefined,
  });
  expect(await authority.token(new AbortController().signal)).toBe(
    grant.accessToken,
  );
  const frozen = await proof();
  await expect(authority.token(new AbortController().signal)).rejects.toThrow();
  await expect(
    authority.access(new AbortController().signal),
  ).rejects.toThrow();
  await expect(
    authority.tokenProvider({ host: 'github.com', reason: 'initial' }),
  ).rejects.toThrow();
  await expect(authority.binding()).rejects.toThrow();
  expect(() => authority.resume()).not.toThrow(); // It cannot reopen a fenced broker.
  expect(() => resumeCopilotGrant()).toThrow();
  expect(() => readCopilotCredential()).toThrow();
  expect(() =>
    copilotGrantAuthority(grant, {
      refresh: (): Promise<never> => Promise.reject(new Error('unexpected')),
      onCleared: (): void => undefined,
    }),
  ).toThrow();
  await expect(commitCopilotGrant(grant)).rejects.toThrow();
  expect(() => deleteCopilotGrant({ entryId: 'a'.repeat(32) })).toThrow();
  expect(() => clearCopilotGrant()).toThrow();
  await frozen.withSource(async (source): Promise<void> => {
    const captured = await source.capture();
    expect(captured.kind).toBe('present');
    // No queue recursion or adopting binding: the protected callback can await its read.
    expect(frozen.current()).toBe(true);
    expect(() => barrier?.release()).toThrow();
  });
});
it.each([false, true])(
  'drains an owned refresh/save before acquiring source; unsaved successor %s blocks importing its predecessor',
  async (unsaved) => {
    await commitCopilotGrant({
      ...grant,
      accessTokenExpiresAt: '2000-01-01T00:00:00.000Z',
    });
    let start: () => void = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let finish: (
      value: Pick<
        CopilotGrant,
        | 'accessToken'
        | 'refreshToken'
        | 'accessTokenExpiresAt'
        | 'refreshTokenExpiresAt'
      >,
    ) => void = (): void => undefined;
    const refresh = new Promise<
      Pick<
        CopilotGrant,
        | 'accessToken'
        | 'refreshToken'
        | 'accessTokenExpiresAt'
        | 'refreshTokenExpiresAt'
      >
    >((resolve) => {
      finish = resolve;
    });
    const authority = copilotGrantAuthority(grant, {
      refresh: () => {
        start();
        return refresh;
      },
      onCleared: (): void => undefined,
    });
    const demand = authority
      .token(new AbortController().signal)
      .catch(() => undefined);
    await started;
    if (unsaved)
      jest
        .spyOn(AtomicFile, 'writeFileAtomically')
        .mockRejectedValue(new Error('save unavailable'));
    barrier = beginCopilotMigrationBarrier();
    let settled = false;
    const quiescent = barrier
      .quiesce(new AbortController().signal)
      .then((result) => {
        settled = true;
        return result;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish({
      accessToken: 'successor-access',
      refreshToken: 'successor-refresh',
      accessTokenExpiresAt: grant.accessTokenExpiresAt,
      refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
    });
    expect(await demand).toBeUndefined();
    const result = await quiescent;
    expect(result.kind).toBe(unsaved ? 'blocked' : 'quiescent');
    if (result.kind === 'quiescent')
      await result.proof.withSource(async (source): Promise<void> => {
        const captured = await source.capture();
        expect(captured.kind === 'present' && captured.grant.refreshToken).toBe(
          'successor-refresh',
        );
      });
    if (unsaved)
      expect((await readFile(mockFile)).toString()).not.toContain(
        'successor-refresh',
      );
  },
);
it('aborted drain is not affirmative evidence and never decrypts the predecessor', async () => {
  await writeFile(mockFile, encoded({ version: 1, ...grant }));
  barrier = beginCopilotMigrationBarrier();
  const abort = new AbortController();
  abort.abort();
  expect(await barrier.quiesce(abort.signal)).toEqual({ kind: 'blocked' });
  expect(mockDecrypt).not.toHaveBeenCalled();
});

it('waits for an already-owned setup save before acquiring the source queue', async () => {
  let release = (): void => undefined;
  let start = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const install = AtomicFile.writeFileAtomically;
  jest
    .spyOn(AtomicFile, 'writeFileAtomically')
    .mockImplementationOnce(async (path, bytes, options): Promise<void> => {
      start();
      await held;
      await install(path, bytes, options);
    });
  const save = commitCopilotGrant(grant);
  await started;
  barrier = beginCopilotMigrationBarrier();
  let settled = false;
  const drain = barrier.quiesce(new AbortController().signal).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await save;
  const result = await drain;
  if (result.kind !== 'quiescent') throw new Error('Save did not drain');
  await result.proof.withSource(async (source): Promise<void> => {
    expect((await source.capture()).kind).toBe('present');
  });
});
it('a source disappearing between stat and open is outcome-unknown, not an absent slot', async () => {
  await writeFile(mockFile, encoded({ version: 1, ...grant }));
  const frozen = await proof();
  const files = jest.requireActual<typeof NodeFiles>('node:fs/promises');
  const open = files.open;
  jest
    .spyOn(files, 'open')
    .mockImplementationOnce(async (path, flags, mode) => {
      await rm(mockFile);
      return open(path, flags, mode);
    });
  await frozen.withSource(async (source): Promise<void> => {
    expect(await source.capture()).toEqual({ kind: 'outcome_unknown' });
  });
});

it.each([false, true])(
  'blocks migration after a retired authority drops an owned rotation, including before gate creation (%s)',
  async (settledBeforeGate) => {
    await commitCopilotGrant({
      ...grant,
      accessTokenExpiresAt: '2000-01-01T00:00:00.000Z',
    });
    let start = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let finish: (
      value: Pick<
        CopilotGrant,
        | 'accessToken'
        | 'refreshToken'
        | 'accessTokenExpiresAt'
        | 'refreshTokenExpiresAt'
      >,
    ) => void = (): void => undefined;
    const refreshed = new Promise<
      Pick<
        CopilotGrant,
        | 'accessToken'
        | 'refreshToken'
        | 'accessTokenExpiresAt'
        | 'refreshTokenExpiresAt'
      >
    >((resolve) => {
      finish = resolve;
    });
    const authority = copilotGrantAuthority(grant, {
      refresh: () => {
        start();
        return refreshed;
      },
      onCleared: (): void => undefined,
    });
    const demand = authority
      .token(new AbortController().signal)
      .catch(() => undefined);
    await started;
    copilotGrantAuthority(
      { ...grant, login: 'other' },
      {
        refresh: (): Promise<never> => Promise.reject(new Error('unexpected')),
        onCleared: (): void => undefined,
      },
    );
    if (!settledBeforeGate) barrier = beginCopilotMigrationBarrier();
    finish({
      accessToken: 'rotated',
      refreshToken: 'rotated',
      accessTokenExpiresAt: grant.accessTokenExpiresAt,
      refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
    });
    await demand;
    barrier ??= beginCopilotMigrationBarrier();
    expect(await barrier.quiesce(new AbortController().signal)).toEqual({
      kind: 'blocked',
    });
    barrier.release();
    barrier = undefined;
    await commitCopilotGrant({
      ...grant,
      refreshToken: 'acknowledged-replacement',
    });
    const frozen = await proof();
    await frozen.withSource(async (source): Promise<void> => {
      const captured = await source.capture();
      expect(captured.kind === 'present' && captured.grant.refreshToken).toBe(
        'acknowledged-replacement',
      );
    });
  },
);
it('rejects affirmative proof when an owned setup save fails after installing bytes but before sync', async () => {
  let start = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const install = AtomicFile.writeFileAtomically;
  jest
    .spyOn(AtomicFile, 'writeFileAtomically')
    .mockImplementationOnce(async (path, bytes, options): Promise<void> => {
      start();
      await held;
      await install(path, bytes, options);
      throw new Error('lost sync');
    });
  const save = commitCopilotGrant(grant).catch(() => undefined);
  await started;
  barrier = beginCopilotMigrationBarrier();
  const drain = barrier.quiesce(new AbortController().signal);
  release();
  await save;
  expect(await drain).toEqual({ kind: 'blocked' });
});
it('rejects mutation of the named inode after the descriptor check', async () => {
  await writeFile(mockFile, encoded({ version: 1, ...grant }));
  const frozen = await proof();
  const files = jest.requireActual<typeof NodeFiles>('node:fs/promises');
  const lstat = files.lstat;
  let checks = 0;
  jest.spyOn(files, 'lstat').mockImplementation(async (path) => {
    if (++checks === 2)
      await writeFile(
        mockFile,
        encoded({ version: 1, ...grant, login: 'replacement' }),
      );
    return lstat(path);
  });
  await frozen.withSource(async (source): Promise<void> => {
    expect(await source.capture()).toEqual({ kind: 'outcome_unknown' });
  });
});
