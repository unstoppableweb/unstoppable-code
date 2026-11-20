import { createCanopyClient } from '@canopy/core-client';
import { createInMemoryFramedPair } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS,
  CoreClientLeaseAcquireParamsSchema,
  type CoreClientLease,
  type CoreIntegrationCredentialResult,
  type CanopySchemaOutput,
} from '@canopy/protocol/canopy-core';
import {
  canonicalInitializeResult,
  serveCanonicalCore,
} from '../../../../../../packages/core-client/src/__tests__/fixtures/canonical-core';
import { createElectronDaemonConnectionService } from '../electron-daemon-connection';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';
import type * as LegacyPaths from '../../lib/paths';
import { compiledBuildIdentity } from '@canopy/core-runtime/node/build-identity';
import { join, dirname } from 'node:path';
import canopyBrand from '../../../../../../brands/canopy/brand.json';
import unstoppableBrand from '../../../../../../brands/unstoppable-code/brand.json';
import {
  resolveLegacyPatPaths,
  resolveBuildStoragePaths,
} from '@canopy/core-runtime/node/secure-data-dir';
import { createLegacyPatGenerationReader } from '@canopy/core-runtime/node/vault';
import { createHash } from 'node:crypto';
import {
  createDaemonCredentialRoute,
  daemonCredentialRoute,
  type DaemonCredentialClient,
  type DaemonCredentialSession,
} from '../daemon-credential-route';
import type { SecretStoragePolicy } from '../../lib/secure-storage-policy';
import { saveGitHubPat } from '../../lib/github-pat-save';

jest.mock('node:os', () => ({
  ...jest.requireActual<typeof NodeOs>('node:os'),
  homedir: (): string => root,
}));
jest.mock('../../lib/paths', () => ({
  getGitHubPatFilePath: (): string => join(root, 'github-pat.enc'),
  getLegacyGitHubPatFilePath: (): string => join(root, 'legacy.enc'),
}));
jest.mock('../../lib/secure-storage-policy', () => ({
  getSecureStorageFailure: (): null => null,
  getSecretStoragePolicy: (): Pick<
    SecretStoragePolicy,
    'encrypt' | 'decrypt' | 'assertCanWrite'
  > => ({
    decrypt: (value: Buffer): string => value.toString(),
    encrypt: (value: string): Buffer => {
      if (storageFails) throw new Error('storage unavailable');
      return Buffer.from(`encrypted:${value}`);
    },
    assertCanWrite: (): void => undefined,
  }),
}));

let root: string;
let storageFails = false;
let lifetime: AbortController;
const calls: { name: string; params: unknown }[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'credential-save-'));
  storageFails = false;
  lifetime = new AbortController();
  calls.length = 0;
});
afterEach(async () => {
  lifetime.abort();
  await rm(root, { recursive: true, force: true });
});

function client(
  run: (name: string, params: unknown) => Promise<void>,
): DaemonCredentialClient {
  return {
    signal: lifetime.signal,
    instruction: async (name, params) => {
      calls.push({ name, params });
      await run(name, params);
      return {
        credentialKind: 'github.pat',
        configured: name.endsWith('.set'),
      };
    },
  };
}

it('commits legacy bytes first, sends their exact generation, then clears legacy before vault', async () => {
  await writeFile(join(root, 'legacy.enc'), 'old');
  const observed: unknown[] = [];
  const setObserved = Promise.withResolvers<void>();
  const clearObserved = Promise.withResolvers<void>();
  daemonCredentialRoute.observe({
    signal: lifetime.signal,
    lease: { state: 'active' },
    client: client(async (name, params) => {
      const read = (file: string): Promise<Buffer | null> =>
        readFile(join(root, file)).catch(() => null);
      observed.push({
        name,
        params,
        current: await read('github-pat.enc'),
        legacy: await read('legacy.enc'),
      });
      (name.endsWith('.set') ? setObserved : clearObserved).resolve();
    }),
  });
  await expect(saveGitHubPat('synthetic-pat')).resolves.toBeUndefined();
  await setObserved.promise;
  await expect(saveGitHubPat('')).resolves.toBeUndefined();
  await clearObserved.promise;
  expect(observed).toEqual([
    {
      name: 'core.integration.credential.set',
      params: {
        credentialKind: 'github.pat',
        secret: 'synthetic-pat',
        expectedLegacyGeneration: createHash('sha256')
          .update('encrypted:synthetic-pat')
          .digest('hex'),
      },
      current: Buffer.from('encrypted:synthetic-pat'),
      legacy: null,
    },
    {
      name: 'core.integration.credential.clear',
      params: { credentialKind: 'github.pat' },
      current: null,
      legacy: null,
    },
  ]);
  expect(calls.map(({ name }) => name)).toEqual([
    'core.integration.credential.set',
    'core.integration.credential.clear',
  ]);
});

it('mirrors later saves and clears after the same session replaces its client', async () => {
  const oldLife = new AbortController();
  let current = { ...client(() => Promise.resolve()), signal: oldLife.signal };
  let state = 'active';
  let getterFails = false;
  const session = {
    signal: lifetime.signal,
    lease: {
      get state(): string {
        return state;
      },
    },
    get client(): DaemonCredentialClient {
      if (getterFails) throw new Error('reconnecting');
      return current;
    },
  };
  daemonCredentialRoute.observe(session);
  await saveGitHubPat('before-reconnect');
  expect(calls).toHaveLength(1);
  oldLife.abort();
  state = 'reconnecting';
  getterFails = true;
  await saveGitHubPat('during-reconnect');
  expect(calls).toHaveLength(1);
  const replacement = jest.fn(() => Promise.resolve());
  current = { ...client(replacement), signal: new AbortController().signal };
  state = 'active';
  await saveGitHubPat('getter-unavailable');
  expect(calls).toHaveLength(1);
  getterFails = false;
  await saveGitHubPat('after-reconnect');
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({
    name: 'core.integration.credential.set',
    params: {
      secret: 'after-reconnect',
      expectedLegacyGeneration: createHash('sha256')
        .update('encrypted:after-reconnect')
        .digest('hex'),
    },
  });
  await saveGitHubPat('');
  expect(calls[2]).toEqual({
    name: 'core.integration.credential.clear',
    params: { credentialKind: 'github.pat' },
  });
  lifetime.abort();
  await saveGitHubPat('after-session-close');
  expect(calls).toHaveLength(3);
  expect(replacement).toHaveBeenCalledTimes(2);
});

it.each(['close', 'owner-abort', 'dispose'])(
  'mirrors through a real lease reconnect without another get, until %s',
  async (teardown) => {
    const instructions = {
      ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
      ...CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS,
    };
    const servers: CanopyFramedConnection[] = [];
    const mirrored: { connection: number; name: string; params: unknown }[] =
      [];
    const reconnect = Promise.withResolvers<void>();
    const reconnectGate = Promise.withResolvers<void>();
    let attachGate = Promise.resolve();
    const attach = jest.fn(async () => {
      await attachGate;
      const { client: connection, server } = await createInMemoryFramedPair();
      const index = servers.push(server);
      const handlers = {
        'core.client.lease.acquire': (
          params: Record<string, unknown>,
        ): CoreClientLease => {
          const { clientInstanceId, previousLeaseId } =
            CoreClientLeaseAcquireParamsSchema.parse(params);
          return {
            leaseId: previousLeaseId ?? `lease-${index}`,
            clientInstanceId,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            renewAfterMs: 15_000,
            revision: index - 1,
          };
        },
        'core.client.lease.release': (): CanopySchemaOutput<
          (typeof instructions)['core.client.lease.release']['result']
        > => ({
          released: true,
          releasedRegistrationCount: 0,
          failedRequestIds: [],
        }),
        ...Object.fromEntries(
          Object.keys(CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS).map((name) => [
            name,
            (
              params: Record<string, unknown>,
            ): CoreIntegrationCredentialResult => {
              mirrored.push({ connection: index, name, params });
              return {
                credentialKind: 'github.pat',
                configured: name.endsWith('.set'),
              };
            },
          ]),
        ),
      };
      serveCanonicalCore(server, handlers, {
        initialize: canonicalInitializeResult({
          capabilities: {
            operations: Object.keys(handlers),
            events: [],
            streams: [],
          },
        }),
      });
      return createCanopyClient({
        connection,
        clientName: 'credential-golden',
        clientVersion: '1.0.0',
        definitions: { queries: {}, instructions, streams: {} },
      });
    });
    const onSession = jest.fn((session: DaemonCredentialSession): void =>
      daemonCredentialRoute.observe(session),
    );
    const connections = createElectronDaemonConnectionService({
      enabled: true,
      authorityId: 'authority-1',
      attach,
      onSession,
    });
    const attempts: Promise<void>[] = [];
    const writeThrough = daemonCredentialRoute.writeThrough.bind(
      daemonCredentialRoute,
    );
    const mirror = jest
      .spyOn(daemonCredentialRoute, 'writeThrough')
      .mockImplementation((...args) => {
        const attempt = writeThrough(...args);
        attempts.push(attempt);
        return attempt;
      });
    const save = async (token: string): Promise<void> => {
      await saveGitHubPat(token);
      await Promise.all(attempts.splice(0));
    };
    try {
      const session = await connections.get(
        {
          principalId: 'local-desktop-user',
          clientInstanceId: 'credential-golden',
          authorityId: 'authority-1',
          interfaceKind: 'desktop',
          grants: ['core.integration.write'],
        },
        lifetime.signal,
      );
      const initial = session.client;
      const initialLeaseId = session.lease.lease?.leaseId;
      expect(initialLeaseId).toBe('lease-1');
      await save('before-reconnect');
      expect(mirrored).toHaveLength(1);
      attachGate = reconnectGate.promise;
      const dropped = new Promise<void>((resolve) =>
        initial.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      servers[0].close();
      await dropped;
      expect(initial.signal.aborted).toBe(true);
      expect(session.signal.aborted).toBe(false);
      expect(session.lease.state).toBe('reconnecting');
      session.lease.register('credential-golden', () => reconnect.resolve());
      await save('during-reconnect');
      expect(mirrored).toHaveLength(1);
      reconnectGate.resolve();
      await reconnect.promise;
      expect(session.lease.state).toBe('active');
      expect(session.lease.lease?.leaseId).toBe(initialLeaseId);
      expect(session.client).not.toBe(initial);
      expect(onSession).toHaveBeenCalledTimes(1);
      await save('after-reconnect');
      expect(mirrored[1]).toMatchObject({
        connection: 2,
        name: 'core.integration.credential.set',
        params: {
          secret: 'after-reconnect',
          expectedLegacyGeneration: createHash('sha256')
            .update('encrypted:after-reconnect')
            .digest('hex'),
        },
      });
      await save('');
      expect(mirrored[2]).toEqual({
        connection: 2,
        name: 'core.integration.credential.clear',
        params: { credentialKind: 'github.pat' },
      });
      expect(mirrored).toHaveLength(3);
      if (teardown === 'owner-abort') {
        lifetime.abort();
        expect(session.signal.aborted).toBe(true);
      }
      if (teardown === 'dispose') await connections.dispose();
      await session.close();
      expect(session.signal.aborted).toBe(true);
      await save('after-close');
      await save('');
      expect(mirrored).toHaveLength(3);
      expect(attach).toHaveBeenCalledTimes(2);
    } finally {
      reconnectGate.resolve();
      await connections.dispose();
      mirror.mockRestore();
    }
  },
);

it('skips a throwing client getter without blocking a different active session', async () => {
  const route = createDaemonCredentialRoute();
  const getter = jest.fn((): DaemonCredentialClient => {
    throw new Error('client being replaced');
  });
  route.observe({
    signal: lifetime.signal,
    lease: { state: 'active' },
    get client() {
      return getter();
    },
  });
  route.observe({
    signal: lifetime.signal,
    lease: { state: 'active' },
    client: client(() => Promise.resolve()),
  });
  await route.writeThrough('saved', 'a'.repeat(64));
  await route.writeThrough('');
  expect(getter).toHaveBeenCalledTimes(2);
  expect(calls.map(({ name }) => name)).toEqual([
    'core.integration.credential.set',
    'core.integration.credential.clear',
  ]);
});

it('saves and clears offline without ever acquiring a connection', async () => {
  await expect(saveGitHubPat('offline-pat')).resolves.toBeUndefined();
  expect(await readFile(join(root, 'github-pat.enc'), 'utf8')).toBe(
    'encrypted:offline-pat',
  );
  await expect(saveGitHubPat('')).resolves.toBeUndefined();
  await expect(saveGitHubPat('')).resolves.toBeUndefined();
  expect(calls).toEqual([]);
});

it('never fails a successful legacy save or clear when the daemon refuses or disconnects', async () => {
  daemonCredentialRoute.observe({
    signal: lifetime.signal,
    lease: { state: 'active' },
    client: client(() => Promise.reject(new Error('synthetic daemon refusal'))),
  });
  await expect(saveGitHubPat('kept-pat')).resolves.toBeUndefined();
  expect(await readFile(join(root, 'github-pat.enc'), 'utf8')).toBe(
    'encrypted:kept-pat',
  );
  await expect(saveGitHubPat('')).resolves.toBeUndefined();
  expect(calls).toHaveLength(2);
});

it('does not contact the daemon if the legacy write fails', async () => {
  daemonCredentialRoute.observe({
    signal: lifetime.signal,
    lease: { state: 'active' },
    client: client(() => Promise.resolve()),
  });
  storageFails = true;
  await expect(saveGitHubPat('not-saved')).rejects.toThrow(
    'storage unavailable',
  );
  expect(calls).toEqual([]);
});

it('skips released, reconnecting and aborted sessions and never sends an unfenced set', async () => {
  const route = createDaemonCredentialRoute();
  for (const state of ['released', 'reconnecting', 'failed'])
    route.observe({
      signal: lifetime.signal,
      lease: { state },
      client: client(() => Promise.resolve()),
    });
  await route.writeThrough('unfenced');
  await route.writeThrough('');
  expect(calls).toEqual([]);
  route.observe({
    signal: lifetime.signal,
    lease: { state: 'active' },
    client: client(() => Promise.resolve()),
  });
  await route.writeThrough('unfenced');
  expect(calls).toEqual([]);
  lifetime.abort();
  await route.writeThrough('');
  expect(calls).toEqual([]);
});

it.each(['synthetic-pat', ''])(
  'does not wait for a stalled daemon when saving %j',
  async (token) => {
    const contacted = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    daemonCredentialRoute.observe({
      signal: lifetime.signal,
      lease: { state: 'active' },
      client: client(async () => {
        contacted.resolve();
        await reply.promise;
      }),
    });
    const otherCaller = jest.fn(() => Promise.resolve());
    daemonCredentialRoute.observe({
      signal: lifetime.signal,
      lease: { state: 'active' },
      client: client(otherCaller),
    });
    let saved = false;
    const save = saveGitHubPat(token).then(() => {
      saved = true;
    });
    try {
      await contacted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(saved).toBe(true);
      expect(otherCaller).not.toHaveBeenCalled();
      if (token)
        expect(await readFile(join(root, 'github-pat.enc'), 'utf8')).toBe(
          'encrypted:synthetic-pat',
        );
      else
        await expect(
          readFile(join(root, 'github-pat.enc')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      reply.resolve();
      await save;
    }
  },
);

it('does not replay a failed write onto a replacement session; later saves use that session', async () => {
  const route = createDaemonCredentialRoute();
  const oldLife = new AbortController();
  const contacted = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  route.observe({
    signal: lifetime.signal,
    lease: { state: 'active' },
    client: {
      ...client(async () => {
        contacted.resolve();
        await reply.promise;
        throw new Error('disconnected');
      }),
      signal: oldLife.signal,
    },
  });
  const first = route.writeThrough('old-secret', 'a'.repeat(64));
  await contacted.promise;
  oldLife.abort();
  route.observe({
    signal: lifetime.signal,
    lease: { state: 'active' },
    client: client(() => Promise.resolve()),
  });
  reply.resolve();
  await first;
  expect(calls).toHaveLength(1);
  await route.writeThrough('new-secret', 'b'.repeat(64));
  expect(calls).toHaveLength(2);
  expect(calls[1].params).toMatchObject({
    secret: 'new-secret',
    expectedLegacyGeneration: 'b'.repeat(64),
  });
});

it('bounds a mirror attempt and ignores cancellation without retrying', async () => {
  const route = createDaemonCredentialRoute();
  const deadline = new AbortController();
  const timeout = jest
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValueOnce(deadline.signal);
  const contacted = Promise.withResolvers<void>();
  let requestSignal: AbortSignal | undefined;
  route.observe({
    signal: lifetime.signal,
    lease: { state: 'active' },
    client: {
      signal: lifetime.signal,
      instruction: (_name, _params, options) => {
        requestSignal = options?.signal;
        contacted.resolve();
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener(
            'abort',
            () => reject(new Error('timed out')),
            { once: true },
          );
        });
      },
    },
  });
  try {
    const pending = route.writeThrough('synthetic', 'a'.repeat(64));
    await contacted.promise;
    expect(requestSignal).toBe(deadline.signal);
    expect(timeout).toHaveBeenCalledWith(2000);
    deadline.abort();
    await expect(pending).resolves.toBeUndefined();
  } finally {
    deadline.abort();
    timeout.mockRestore();
  }
});

// Each case walks two test-build modes and five override environments, with a
// filesystem round trip for every legacy path. That is about 500-900 ms on an
// idle machine and several times that on a loaded CI runner (merge queue run
// 44598339355, Tests 2/2, maxWorkers=6: the stable case exceeded Jest's 5 s
// default and the file took 17 s). Keep an explicit budget sized for that load.
const LEGACY_PATH_CASE_TIMEOUT_MS = 30_000;

// A timed-out case keeps running, and Jest starts the next case immediately.
// The callback installs and restores build-identity globals, env, and mocks,
// and it runs only after the previous callback has restored them, so an
// overrun cannot change the next case's identity. The isolated registry stays
// inside that same callback so two registries never nest.
let isolationTail: Promise<void> = Promise.resolve();
async function isolated(run: () => Promise<void>): Promise<void> {
  const previous = isolationTail;
  let release = (): void => undefined;
  isolationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    await jest.isolateModulesAsync(run);
  } finally {
    release();
  }
}

describe.each([canopyBrand, unstoppableBrand])(
  'legacy path equivalence for $id',
  (brand) => {
    it.each(['stable', 'rc', 'internal', 'dev'] as const)(
      'matches Electron auth lookup for %s with and without overrides',
      async (flavor) => {
        await isolated(async () => {
          const defines = {
            __CANOPY_RELEASE_FLAVOR__: flavor,
            __CANOPY_BUILD_IDENTITY__: { brandId: brand.id, build: flavor },
            __CANOPY_TEST_DATA_OVERRIDES__: false,
            __CANOPY_COMPILED_RUNTIME__: true,
          };
          const originals = new Map(
            Object.keys(defines).map((key) => [
              key,
              Object.getOwnPropertyDescriptor(globalThis, key),
            ]),
          );
          for (const [key, value] of Object.entries(defines))
            Object.defineProperty(globalThis, key, {
              value,
              configurable: true,
            });
          const environment = jest.replaceProperty(process, 'env', {
            ...process.env,
            NODE_ENV: flavor === 'dev' ? 'development' : 'production',
            CANOPY_TEST_DATA_OVERRIDES: '1',
            CANOPY_E2E_BUILD: '1',
            CANOPY_ENV: undefined,
            CANOPY_DATA_DIR: undefined,
            CANOPY_SECURE_DATA_DIR: undefined,
          });
          jest.doMock('@canopy/brand/current', () => ({ BRAND: brand }));
          try {
            // Build identity is fixed for this brand/flavor. Keep one isolated
            // auth graph, but reset path caches for every environment case.
            jest.dontMock('../../lib/paths');
            const paths =
              jest.requireActual<typeof LegacyPaths>('../../lib/paths');
            const { readStoredPatWithStatus } =
              await import('../../lib/github-auth');
            const { getCanopyBuildIdentity, resetResolvedCanopyDataDirCache } =
              await import('@canopy/execution-engine/canopy-paths');
            for (const testBuild of [false, true]) {
              Object.defineProperty(
                globalThis,
                '__CANOPY_TEST_DATA_OVERRIDES__',
                {
                  value: testBuild,
                  configurable: true,
                },
              );
              for (const overrides of [
                {},
                { CANOPY_DATA_DIR: '  ', CANOPY_SECURE_DATA_DIR: '  ' },
                { CANOPY_DATA_DIR: join(root, 'override-data') },
                { CANOPY_SECURE_DATA_DIR: join(root, 'override-secure') },
                {
                  CANOPY_DATA_DIR: join(root, 'both-data'),
                  CANOPY_SECURE_DATA_DIR: join(root, 'both-secure'),
                },
              ]) {
                process.env.CANOPY_DATA_DIR = overrides.CANOPY_DATA_DIR;
                process.env.CANOPY_SECURE_DATA_DIR =
                  overrides.CANOPY_SECURE_DATA_DIR;
                resetResolvedCanopyDataDirCache();
                const identity = compiledBuildIdentity(brand.id);
                const { dataRoot } = resolveBuildStoragePaths({
                  home: root,
                  brand,
                  identity,
                });
                const daemonOptions = {
                  dataRoot,
                  environment: process.env,
                };
                const daemonPaths = resolveLegacyPatPaths(daemonOptions);
                const hostPaths = [
                  paths.getGitHubPatFilePath(),
                  paths.getLegacyGitHubPatFilePath(),
                ].filter((path): path is string => path !== null);
                expect(daemonPaths).toEqual(hostPaths);
                const dataOverride = overrides.CANOPY_DATA_DIR?.trim();
                const secureOverride = overrides.CANOPY_SECURE_DATA_DIR?.trim();
                if (dataOverride || secureOverride) {
                  expect(
                    paths.getInternalLegacySharedGitHubPatFilePath(),
                  ).toBeNull();
                  expect(daemonPaths).toHaveLength(2);
                  expect(daemonPaths[0]).toBe(
                    join(
                      secureOverride ??
                        join(dataOverride ?? dataRoot, 'secure-storage'),
                      'github-pat.enc',
                    ),
                  );
                }
                expect(
                  paths.getInternalLegacySharedGitHubPatFilePath(),
                ).toBeNull();
                const retainedPaths = [canopyBrand, unstoppableBrand].flatMap(
                  (retainedBrand) =>
                    Object.values(retainedBrand.storage.secureDataDirNames).map(
                      (directory) => join(root, directory, 'github-pat.enc'),
                    ),
                );
                for (const retained of retainedPaths) {
                  await mkdir(dirname(retained), { recursive: true });
                  await writeFile(retained, 'explicit-recovery-only');
                  expect(daemonPaths).not.toContain(retained);
                }
                expect(identity).toEqual({ brandId: brand.id, build: flavor });
                expect(getCanopyBuildIdentity()).toEqual(identity);
                const generation = createLegacyPatGenerationReader({
                  identity,
                  paths: daemonPaths,
                });
                for (const [index, path] of daemonPaths.entries()) {
                  await mkdir(dirname(path), { recursive: true });
                  await writeFile(path, `ciphertext-${index}`);
                }
                // Removing each winner proves effective precedence, not only equal path arrays.
                for (const [index, path] of daemonPaths.entries()) {
                  expect(await generation(identity)).toBe(
                    createHash('sha256')
                      .update(`ciphertext-${index}`)
                      .digest('hex'),
                  );
                  const stored = await readStoredPatWithStatus();
                  if (stored.status === 'error') throw stored.error;
                  expect(stored).toMatchObject({
                    status: 'ok',
                    value: `ciphertext-${index}`,
                  });
                  await rm(path, { force: true });
                  await rm(daemonPaths[0], { force: true });
                }
                expect(await generation(identity)).toBeNull();
                expect(await readStoredPatWithStatus()).toMatchObject({
                  status: 'ok',
                  value: null,
                });
                const { saveGitHubPat: save } =
                  await import('../../lib/github-pat-save');
                await writeFile(daemonPaths[1], 'root-contained-legacy');
                await save('new-synthetic-pat');
                expect(await readFile(daemonPaths[0], 'utf8')).toBe(
                  'encrypted:new-synthetic-pat',
                );
                await expect(readFile(daemonPaths[1])).rejects.toMatchObject({
                  code: 'ENOENT',
                });
                expect(await generation(identity)).toBe(
                  createHash('sha256')
                    .update('encrypted:new-synthetic-pat')
                    .digest('hex'),
                );
                await save('');
                expect(await generation(identity)).toBeNull();
                await expect(readFile(daemonPaths[0])).rejects.toMatchObject({
                  code: 'ENOENT',
                });
                for (const retained of retainedPaths)
                  expect(await readFile(retained, 'utf8')).toBe(
                    'explicit-recovery-only',
                  );
              }
            }
          } finally {
            environment.restore();
            for (const [key, original] of originals) {
              if (original) Object.defineProperty(globalThis, key, original);
              else Reflect.deleteProperty(globalThis, key);
            }
            jest.dontMock('@canopy/brand/current');
          }
        });
      },
      LEGACY_PATH_CASE_TIMEOUT_MS,
    );
  },
);
