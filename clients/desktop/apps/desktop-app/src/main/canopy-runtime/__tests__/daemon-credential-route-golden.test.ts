import { CanopyClientError, createCanopyClient } from '@canopy/core-client';
import { createInMemoryFramedPair } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS,
  CLOUD_ACCOUNT_TRUSTED_CONNECTION_GRANT,
  CloudAccountCustodyViewSchema,
  CloudAccountEntryJsonSchema,
  CoreClientLeaseAcquireParamsSchema,
  CoreCloudAccountProvisionResultSchema,
  type CanopyCallerDescriptor,
  type CanopyJsonValue,
  type CoreClientLease,
  type CoreCloudAccountProvisionParams,
  type CoreCloudAccountProvisionResult,
  type CoreIntegrationCredentialResult,
  type CanopySchemaOutput,
} from '@canopy/protocol/canopy-core';
import { createRuntimeProfileGraph } from '@canopy/core-runtime';
import { createMemoryVaultRepository } from '@canopy/core-runtime/vault/testing';
import {
  CLOUD_ACCOUNT_VAULT_FAMILY,
  createDaemonCloudAccountServices,
} from '@canopy/core-runtime/node/cloud-account/daemon';
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
import { cloudAccountEndpointAuthority } from '@canopy/protocol/canopy-core';
import {
  createDaemonCredentialRoute,
  daemonCredentialRoute,
  type DaemonCredentialClient,
  type DaemonCredentialSession,
} from '../daemon-credential-route';
import {
  createDaemonCloudAccountRoute,
  followAppCloudAccount,
  type DaemonCloudAccountClient,
  type DaemonCloudAccountRoute,
  type DaemonCloudAccountSession,
} from '../../canopy-cloud/daemon-account-route';
import type { SecretStoragePolicy } from '../../lib/secure-storage-policy';
import {
  beginCanopyCloudSessionProbe,
  isCanopyCloudSessionExpired,
  recordCanopyCloudSessionProbe,
  resetCanopyCloudSessionCredential,
  subscribeCanopyCloudSessionStatus,
} from '../../canopy-cloud/session-status';
import type { CanopyCloudAccountEntry } from '../../lib/canopy-cloud-account-store';
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

describe('CAN-6997 Cloud account provisioning of connected daemons', () => {
  const endpoint = {
    baseUrl: 'https://cloud.example.test',
    wellKnownNamespace: 'canopy',
    apiNamespace: 'desktop-app',
  };
  const endpointAuthority = cloudAccountEndpointAuthority(endpoint);
  type View = Awaited<ReturnType<DaemonCloudAccountClient['query']>>;
  const digestOf = (apiKey: string): string =>
    createHash('sha256').update(apiKey).digest('hex');
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: 'desktop',
    authorityId: 'authority-1',
    interfaceKind: 'desktop',
    grants: [
      'core.integration.read',
      'core.integration.write',
      CLOUD_ACCOUNT_TRUSTED_CONNECTION_GRANT,
    ],
  };
  const otherClient: CanopyCallerDescriptor = {
    ...caller,
    clientInstanceId: 'another-client',
  };
  const offline = (): Promise<Response> =>
    Promise.resolve(new Response(null, { status: 503 }));

  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  interface Daemon {
    readonly session: DaemonCloudAccountSession;
    /** Every provision this app's client delivered, as the daemon received it. */
    readonly sent: CoreCloudAccountProvisionParams[];
    delivered(count: number): Promise<void>;
    custody(): Promise<View>;
    held(): Promise<string | null>;
    /**
     * Another client of this daemon replaces or clears its account, fenced by
     * the custody it read earlier (`observed`) or reads now.
     */
    provisionElsewhere(
      entry: { apiKey: string } | null,
      observed?: View,
    ): Promise<CoreCloudAccountProvisionResult>;
    /** The lease recovers under a new id, which the next get() observes. */
    recover(): void;
    /** Holds the daemon's next vault write once it has started. */
    gatePut(): { readonly reached: Promise<void>; release(): void };
  }

  /** The daemon's real account authority and module; its Cloud is offline unless `fetch` answers. */
  async function realDaemon(
    options: {
      reachable?: () => boolean;
      fetch?: typeof fetch;
      /** Whether the daemon's vault can be opened; always, unless given. */
      vault?: () => boolean;
    } = {},
  ): Promise<Daemon> {
    const memory = createMemoryVaultRepository();
    const writer = memory.writer(CLOUD_ACCOUNT_VAULT_FAMILY);
    let putGate: { reached: () => void; released: Promise<void> } | undefined;
    const services = createDaemonCloudAccountServices({
      repository: () =>
        options.vault && !options.vault()
          ? Promise.reject(new Error('vault unavailable'))
          : Promise.resolve(memory.repository),
      writer: () =>
        Promise.resolve({
          family: writer.family,
          put: async (request: Parameters<typeof writer.put>[0]) => {
            const gate = putGate;
            putGate = undefined;
            if (gate) {
              gate.reached();
              await gate.released;
            }
            return writer.put(request);
          },
          delete: (request: Parameters<typeof writer.delete>[0]) =>
            writer.delete(request),
        }),
      cloud: endpoint,
      fetch: options.fetch ?? offline,
    });
    const graph = createRuntimeProfileGraph({
      profile: 'core',
      modules: [services.module],
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
      phaseDeadlineMs: 1000,
      shutdownTimeoutMs: 50,
    });
    await graph.start();
    stops.push(async () => {
      await graph.shutdown('test');
      await services.dispose();
    });
    const custody = async (
      by: CanopyCallerDescriptor,
      signal?: AbortSignal,
    ): Promise<View> =>
      CloudAccountCustodyViewSchema.parse(
        await graph.dispatcher.query(
          'core.integration.cloudAccount.custody.get',
          { endpointAuthority },
          { caller: by, ...(signal && { signal }) },
        ),
      );
    const provision = async (
      params: CoreCloudAccountProvisionParams,
      by: CanopyCallerDescriptor,
      signal?: AbortSignal,
    ): Promise<CoreCloudAccountProvisionResult> =>
      CoreCloudAccountProvisionResultSchema.parse(
        await graph.dispatcher.instruction(
          'core.integration.cloudAccount.provision',
          params,
          { caller: by, ...(signal && { signal }) },
        ),
      );
    const reachable = (): void => {
      if (options.reachable && !options.reachable())
        throw new Error('unreachable');
    };
    const sent: CoreCloudAccountProvisionParams[] = [];
    const waiters: { count: number; resolve: () => void }[] = [];
    const signal = new AbortController().signal;
    let recoveries = 1;
    const lease: { state: string; lease: { leaseId: string } } = {
      state: 'active',
      lease: { leaseId: 'lease-1' },
    };
    const client: DaemonCloudAccountClient = {
      signal,
      query: (_name, _params, requestOptions) => {
        reachable();
        return custody(caller, requestOptions?.signal);
      },
      instruction: (_name, params, requestOptions) => {
        reachable();
        sent.push(params);
        for (const waiter of waiters)
          if (sent.length >= waiter.count) waiter.resolve();
        return provision(params, caller, requestOptions?.signal);
      },
    };
    return {
      session: { signal, client, lease },
      recover: () => {
        recoveries += 1;
        lease.lease = { leaseId: `lease-${recoveries}` };
      },
      gatePut: () => {
        const reached = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        putGate = { reached: reached.resolve, released: released.promise };
        return { reached: reached.promise, release: released.resolve };
      },
      sent,
      delivered: (count) =>
        sent.length >= count
          ? Promise.resolve()
          : new Promise((resolve) => waiters.push({ count, resolve })),
      custody: () => custody(caller),
      held: async () => {
        const read = await services.authority.read();
        return read.kind === 'ok' ? (read.record?.apiKey ?? null) : null;
      },
      provisionElsewhere: async (entry, observed) => {
        const view = observed ?? (await custody(otherClient));
        return provision(
          {
            endpointAuthority,
            entry: entry && wire(entry),
            expectedCredentialDigest: view.credentialDigest,
            expectedCredentialGeneration: view.credentialGeneration ?? 0,
          },
          otherClient,
        );
      },
    };
  }

  /** An entry as another client sends it. */
  function wire(entry: { apiKey: string }): Record<string, CanopyJsonValue> {
    const parsed = CloudAccountEntryJsonSchema.parse(
      JSON.parse(JSON.stringify(entry)),
    );
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Expected an account fixture object.');
    return parsed;
  }

  /** The route's 10 s request deadlines, aborted by the test; others stay real. */
  function controlDeadlines(): {
    readonly deadlines: AbortController[];
    restore(): void;
  } {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadlines: AbortController[] = [];
    const spy = jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms: number): AbortSignal => {
        if (ms !== 10_000) return timeout(ms);
        const deadline = new AbortController();
        deadlines.push(deadline);
        return deadline.signal;
      });
    return { deadlines, restore: () => spy.mockRestore() };
  }

  /** A Cloud whose first probe stalls until `answer`; later probes are offline. */
  function stalledCloud(): {
    readonly fetch: typeof fetch;
    readonly probing: Promise<void>;
    answer(): void;
  } {
    const probing = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    let first = true;
    return {
      fetch: async () => {
        if (first) {
          first = false;
          probing.resolve();
          await answer.promise;
        }
        return offline();
      },
      probing: probing.promise,
      answer: () => answer.resolve(),
    };
  }

  const signedIn = (apiKey: string): { apiKey: string } =>
    Object.assign(
      { apiKey },
      {
        organizationAccessLossState: { version: 1, pending: [] },
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: 'now',
      },
    );

  type AppEntry = { apiKey: string } | null;

  /** The app's store and session status, as provisioning wires them. */
  function appStore(
    route: DaemonCloudAccountRoute,
    get: () => AppEntry,
    set: (entry: AppEntry) => void,
  ): {
    /** The store commits `entry` and publishes it, as on save and on clear. */
    readonly commit: (entry: AppEntry) => void;
    readonly statusChanged: () => void;
    readonly stop: () => void;
  } {
    const commits = new Set<(entry: AppEntry) => void>();
    const statuses = new Set<() => void>();
    const stop = followAppCloudAccount(route, {
      subscribeCommits: (listener) => {
        commits.add(listener);
        return (): void => {
          commits.delete(listener);
        };
      },
      subscribeSessionStatus: (listener) => {
        statuses.add(listener);
        return (): void => {
          statuses.delete(listener);
        };
      },
      peek: get,
    });
    return {
      commit: (entry) => {
        set(entry);
        for (const listener of commits) listener(entry);
      },
      statusChanged: () => {
        for (const listener of statuses) listener();
      },
      stop,
    };
  }

  /**
   * A client whose writes reach the daemon but whose replies never arrive,
   * and whose follow-up reads can stall, so the route's deadlines decide.
   */
  function unansweredWrites(
    daemon: Daemon,
    control: { readonly deadlines: AbortController[] },
  ): {
    readonly session: DaemonCloudAccountSession;
    /** Whether later writes are answered; none is until set. */
    answerWrites(answered: boolean): void;
    /** Resolves once the pending unanswered write has landed. */
    landed(): Promise<void>;
    /** Times out that write and each follow-up read, ending its owner unreconciled. */
    exhaustFollowUps(): Promise<void>;
  } {
    let answered = false;
    let landing = Promise.withResolvers<void>();
    let stalled = 0;
    let reading = Promise.withResolvers<void>();
    const session: DaemonCloudAccountSession = {
      ...daemon.session,
      client: {
        ...daemon.session.client,
        query: (name, params, requestOptions) => {
          if (stalled === 0)
            return daemon.session.client.query(name, params, requestOptions);
          stalled -= 1;
          reading.resolve();
          return new Promise(() => undefined);
        },
        instruction: async (name, params, requestOptions) => {
          if (answered)
            return daemon.session.client.instruction(
              name,
              params,
              requestOptions,
            );
          await daemon.session.client.instruction(name, params);
          landing.resolve();
          return new Promise(() => undefined);
        },
      },
    };
    // The route re-reads twice after a timed-out write.
    const followUps = 2;
    return {
      session,
      answerWrites: (answer) => {
        answered = answer;
      },
      landed: async () => {
        await landing.promise;
        landing = Promise.withResolvers<void>();
      },
      exhaustFollowUps: async () => {
        stalled = followUps;
        control.deadlines.at(-1)?.abort();
        for (let read = 0; read < followUps; read += 1) {
          await reading.promise;
          reading = Promise.withResolvers<void>();
          control.deadlines.at(-1)?.abort();
        }
      },
    };
  }

  it('carries a recorded desktop 401 on first observation and later reconciliation', async () => {
    resetCanopyCloudSessionCredential();
    const current: CanopyCloudAccountEntry = {
      apiKey: 'csk-rejected',
      authMode: 'api_key',
      credentialSource: 'manual',
      capabilities: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    recordCanopyCloudSessionProbe(
      beginCanopyCloudSessionProbe(),
      current,
      'rejected',
    );
    const daemon = await realDaemon();
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(current),
      credentialRejected: (apiKey) =>
        apiKey === current.apiKey && isCanopyCloudSessionExpired(current),
    });
    const stop = followAppCloudAccount(route, {
      subscribeCommits: () => (): void => undefined,
      subscribeSessionStatus: subscribeCanopyCloudSessionStatus,
      peek: () => current,
    });
    try {
      route.observe(daemon.session);
      await route.idle();
      expect(daemon.sent[0]).toMatchObject({ credentialRejected: true });
      expect(await daemon.custody()).toMatchObject({ sessionExpired: true });
      expect(route.provisioned(daemon.session.client)).toBe(false);
      daemon.recover();
      route.observe(daemon.session);
      await route.idle();
      expect(daemon.sent[1]).toMatchObject({ credentialRejected: true });
      recordCanopyCloudSessionProbe(
        beginCanopyCloudSessionProbe(),
        current,
        'accepted',
      );
      await route.idle();
      expect(daemon.sent[2]).not.toHaveProperty('credentialRejected');
    } finally {
      stop();
      resetCanopyCloudSessionCredential();
    }
  });

  it('provisions every connected daemon from the app sign-in, never gating it', async () => {
    let current: { apiKey: string } | null = signedIn('csk-one');
    const route = createDaemonCloudAccountRoute({
      endpointAuthority: () => endpointAuthority,
      selected: true,
      current: () => Promise.resolve(current),
    });
    let reachable = false;
    const first = await realDaemon({ reachable: () => reachable });
    const second = await realDaemon();
    route.observe(first.session);
    route.observe(second.session);
    await route.idle();
    // The unreachable daemon is skipped; the app's sign-in is unaffected.
    expect(await first.held()).toBeNull();
    expect(await second.held()).toBe('csk-one');
    expect(route.provisioned()).toBe(true);
    // Replacement reaches every reachable daemon after the app committed it.
    current = signedIn('csk-two');
    route.changed(current);
    await route.idle();
    expect(await second.held()).toBe('csk-two');
    // The daemon is reachable again: observing its new session reconciles it.
    reachable = true;
    route.observe(first.session);
    await route.idle();
    expect(await first.held()).toBe('csk-two');
    // Sign-out clears every daemon's own record.
    current = null;
    route.changed(null);
    await route.idle();
    expect([await first.held(), await second.held()]).toEqual([null, null]);
    expect(route.provisioned()).toBe(false);
  });

  it('re-reads a daemon another client changed, then provisions the app sign-in once per lease', async () => {
    const daemon = await realDaemon();
    await daemon.provisionElsewhere(signedIn('csk-from-cli'));
    const route = createDaemonCloudAccountRoute({
      endpointAuthority: () => endpointAuthority,
      selected: true,
      current: () => Promise.resolve(signedIn('csk-app')),
    });
    route.observe(daemon.session);
    await route.idle();
    expect(await daemon.held()).toBe('csk-app');
    await daemon.provisionElsewhere(signedIn('csk-from-another-client'));
    // Repeated gets of an observed lease and client reconcile nothing.
    route.observe(daemon.session);
    route.observe(daemon.session);
    await route.idle();
    expect(await daemon.held()).toBe('csk-from-another-client');
    expect(daemon.sent).toHaveLength(1);
    // A recovery is a fresh observation, written against the custody it read.
    daemon.recover();
    route.observe(daemon.session);
    await route.idle();
    expect(await daemon.held()).toBe('csk-app');
    expect(
      daemon.sent.map((params) => params.expectedCredentialGeneration),
    ).toEqual([1, 3]);
  });

  it('sends the generation it observed, so an empty clear supersedes it', async () => {
    const daemon = await realDaemon();
    await daemon.provisionElsewhere(signedIn('csk-other'));
    await daemon.provisionElsewhere(null);
    let first = true;
    const session: DaemonCloudAccountSession = {
      ...daemon.session,
      client: {
        ...daemon.session.client,
        instruction: async (...args) => {
          if (first) {
            first = false;
            // Clearing an already-empty record still advances its generation.
            await expect(
              daemon.provisionElsewhere(null),
            ).resolves.toMatchObject({
              status: 'cleared',
              custody: { credentialGeneration: 3 },
            });
          }
          return daemon.session.client.instruction(...args);
        },
      },
    };
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(signedIn('csk-app')),
    });
    route.observe(session);
    await route.idle();
    expect(daemon.sent).toEqual([
      expect.objectContaining({
        expectedCredentialDigest: null,
        expectedCredentialGeneration: 2,
      }),
    ]);
    expect(await daemon.custody()).toMatchObject({
      credentialDigest: null,
      credentialGeneration: 3,
    });
    expect(route.provisioned()).toBe(false);
    // The other client's sign-out stands across repeated gets.
    route.observe(session);
    route.observe(session);
    await route.idle();
    expect(daemon.sent).toHaveLength(1);
    expect(await daemon.held()).toBeNull();
    // An app sign-in change is a new intent and provisions the app sign-in.
    route.changed(signedIn('csk-app'));
    await route.idle();
    expect(daemon.sent[1]).toMatchObject({ expectedCredentialGeneration: 3 });
    expect(await daemon.held()).toBe('csk-app');
  });

  it('retries same-generation contention with its original fence', async () => {
    const daemon = await realDaemon();
    await daemon.provisionElsewhere(signedIn('csk-other'));
    const tried: CoreCloudAccountProvisionParams[] = [];
    const session: DaemonCloudAccountSession = {
      ...daemon.session,
      client: {
        ...daemon.session.client,
        instruction: async (name, params, requestOptions) => {
          tried.push(params);
          // A concurrent write that left the credential and generation as they were.
          if (tried.length === 1)
            return { status: 'superseded', custody: await daemon.custody() };
          return daemon.session.client.instruction(
            name,
            params,
            requestOptions,
          );
        },
      },
    };
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(signedIn('csk-app')),
    });
    route.observe(session);
    await route.idle();
    const fence = {
      expectedCredentialDigest: digestOf('csk-other'),
      expectedCredentialGeneration: 1,
    };
    expect(tried).toEqual([
      expect.objectContaining(fence),
      expect.objectContaining(fence),
    ]);
    expect(await daemon.held()).toBe('csk-app');
    expect(route.provisioned()).toBe(true);
  });

  const accountOf = (
    apiKey: string,
    id: string,
  ): { apiKey: string; account: Record<string, string> } =>
    Object.assign(
      {
        ...signedIn(apiKey),
        account: {
          id,
          name: 'Synthetic',
          email: `${id}@example.test`,
          role: 'ADMIN',
        },
      },
      // A well-formed handoff, so the app's own record names this account.
      {
        organizationAccessLossState: {
          version: 1,
          accountId: id,
          organizationIds: [],
          pending: [],
        },
      },
    );

  it.each(
    (['timed-out', 'answered'] as const).flatMap((settle) =>
      (
        [
          ['a clear', null, { credentialDigest: null }],
          [
            'a replacement',
            signedIn('csk-other'),
            { credentialDigest: digestOf('csk-other') },
          ],
          [
            'the same key bound to another account',
            accountOf('csk-one', 'account-b'),
            {
              credentialDigest: digestOf('csk-one'),
              entry: { account: { id: 'account-b' } },
            },
          ],
        ] as const
      ).map(
        ([change, other, after]) => [settle, change, other, after] as const,
      ),
    ),
  )(
    'never lets a %s provision write over or confirm %s made meanwhile',
    async (settle, _change, other, after) => {
      const cloud = stalledCloud();
      const daemon = await realDaemon({ fetch: cloud.fetch });
      const control = controlDeadlines();
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: () => Promise.resolve(accountOf('csk-one', 'account-a')),
      });
      try {
        route.observe(daemon.session);
        // Committed at generation 1; the daemon is still verifying the key.
        await cloud.probing;
        expect(await daemon.custody()).toMatchObject({
          credentialDigest: digestOf('csk-one'),
          credentialGeneration: 1,
        });
        // Another client changes the daemon, advancing it to generation 2.
        await daemon.provisionElsewhere(other);
        // Answered: the reply pairs this provision's status with the other
        // client's custody.
        if (settle === 'timed-out') control.deadlines.at(-1)?.abort();
        else cloud.answer();
        await route.idle();
        expect(daemon.sent).toEqual([
          expect.objectContaining({
            expectedCredentialDigest: null,
            expectedCredentialGeneration: 0,
          }),
        ]);
        expect(await daemon.custody()).toMatchObject({
          ...after,
          credentialGeneration: 2,
        });
        expect(route.provisioned()).toBe(false);
        await expect(
          route.admissionIdentity(daemon.session.client),
        ).resolves.toBeUndefined();
      } finally {
        control.restore();
        cloud.answer();
      }
    },
  );

  it('follows up a provision the client RPC deadline rejected before the local timer', async () => {
    const cloud = stalledCloud();
    const daemon = await realDaemon({ fetch: cloud.fetch });
    const session: DaemonCloudAccountSession = {
      ...daemon.session,
      client: {
        ...daemon.session.client,
        instruction: async (name, params, requestOptions) => {
          void daemon.session.client
            .instruction(name, params, requestOptions)
            .catch(() => undefined);
          // The daemon committed and is verifying when the client gives up.
          await cloud.probing;
          throw new CanopyClientError({
            kind: 'deadline_exceeded',
            message: 'The request deadline passed.',
            retry: { kind: 'same_request' },
          });
        },
      },
    };
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(accountOf('csk-one', 'account-a')),
    });
    try {
      route.observe(session);
      await route.idle();
      expect(daemon.sent).toHaveLength(1);
      expect(route.provisioned()).toBe(true);
      await expect(route.admissionIdentity(session.client)).resolves.toBe(
        'account-a',
      );
    } finally {
      cloud.answer();
    }
  });

  it.each(['at registration', 'after another registration settles'] as const)(
    'reconciles an active lease once per observation, its registration replay included (%s)',
    async (replay) => {
      const daemon = await realDaemon();
      const dropped = new AbortController();
      const replacement: DaemonCloudAccountClient = {
        ...daemon.session.client,
        signal: new AbortController().signal,
      };
      let client: DaemonCloudAccountClient = {
        ...daemon.session.client,
        signal: dropped.signal,
      };
      let issue: ((lease: { readonly leaseId: string }) => void) | undefined;
      let immediate = replay === 'at registration';
      const lease = { leaseId: 'lease-1' };
      const session: DaemonCloudAccountSession = {
        signal: daemon.session.signal,
        get client() {
          return client;
        },
        lease: {
          state: 'active',
          lease,
          register: (_key, registered) => {
            issue = registered;
            // The lease replays a registration at once while it is active.
            if (immediate) registered(lease);
            immediate = false;
            return () => undefined;
          },
        },
      };
      let reads = 0;
      let racing = true;
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: async () => {
          reads += 1;
          // A daemon sign-out between duplicate reconciliations.
          if (reads === 2 && racing) await daemon.provisionElsewhere(null);
          return signedIn('csk-one');
        },
      });
      route.observe(session);
      if (replay !== 'at registration') issue?.(lease);
      await route.idle();
      racing = false;
      expect(reads).toBe(1);
      expect(daemon.sent).toHaveLength(1);
      expect(await daemon.held()).toBe('csk-one');
      // The daemon signs out: nothing short of a new observation undoes it.
      await daemon.provisionElsewhere(null);
      issue?.(lease);
      await route.idle();
      expect(await daemon.held()).toBeNull();
      expect(daemon.sent).toHaveLength(1);
      // A new lease is a recovery, so a new observation of the sign-in.
      issue?.({ leaseId: 'lease-2' });
      await route.idle();
      expect(await daemon.held()).toBe('csk-one');
      expect(daemon.sent).toHaveLength(2);
      // A reconnect that retains the lease id is one too.
      await daemon.provisionElsewhere(null);
      client = replacement;
      dropped.abort();
      issue?.({ leaseId: 'lease-2' });
      await route.idle();
      expect(await daemon.held()).toBe('csk-one');
      expect(daemon.sent).toHaveLength(3);
      expect(route.provisioned(replacement)).toBe(true);
    },
  );

  it('leaves an observation queued for a dropped client to the recovery, which reconciles once', async () => {
    const daemon = await realDaemon();
    const dropped = new AbortController();
    let client: DaemonCloudAccountClient = {
      ...daemon.session.client,
      signal: dropped.signal,
    };
    let issue: ((lease: { readonly leaseId: string }) => void) | undefined;
    const lease = { leaseId: 'lease-1' };
    const session: DaemonCloudAccountSession = {
      signal: daemon.session.signal,
      get client() {
        return client;
      },
      lease: {
        state: 'active',
        lease,
        register: (_key, registered) => {
          issue = registered;
          return () => undefined;
        },
      },
    };
    const store = Promise.withResolvers<void>();
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: async () => {
        await store.promise;
        return signedIn('csk-one');
      },
    });
    route.observe(session);
    // The connection drops while the app store is read; the lease recovers
    // on a replacement under the same id and replays its registration.
    client = { ...daemon.session.client, signal: new AbortController().signal };
    dropped.abort();
    issue?.(lease);
    store.resolve();
    await route.idle();
    expect(daemon.sent).toHaveLength(1);
    expect(await daemon.held()).toBe('csk-one');
    expect(route.provisioned(client)).toBe(true);
  });

  it.each(['an observation', 'a sign-in change'] as const)(
    'reconciles on the next get after %s ran while the client refused',
    async (intent) => {
      const daemon = await realDaemon();
      let refusing = false;
      const session: DaemonCloudAccountSession = {
        signal: daemon.session.signal,
        lease: daemon.session.lease,
        get client() {
          if (refusing) throw new Error('recovering');
          return daemon.session.client;
        },
      };
      const store = Promise.withResolvers<void>();
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: async () => {
          await store.promise;
          return signedIn('csk-one');
        },
      });
      if (intent === 'a sign-in change') {
        store.resolve();
        route.observe(session);
        await route.idle();
        await daemon.provisionElsewhere(null);
        route.changed(signedIn('csk-one'));
      } else route.observe(session);
      // The client refuses only while the queued intent runs.
      refusing = true;
      store.resolve();
      await route.idle();
      refusing = false;
      expect(await daemon.held()).toBeNull();
      route.observe(session);
      await route.idle();
      expect(await daemon.held()).toBe('csk-one');
    },
  );

  it('confirms a timed-out provision that landed by reading custody, never writing again', async () => {
    const cloud = stalledCloud();
    const daemon = await realDaemon({ fetch: cloud.fetch });
    const control = controlDeadlines();
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(accountOf('csk-one', 'account-a')),
    });
    try {
      route.observe(daemon.session);
      await cloud.probing;
      const landed = await daemon.custody();
      expect(landed).toMatchObject({
        credentialDigest: digestOf('csk-one'),
        credentialGeneration: 1,
      });
      control.deadlines.at(-1)?.abort();
      await route.idle();
      expect(daemon.sent).toEqual([
        expect.objectContaining({
          expectedCredentialDigest: null,
          expectedCredentialGeneration: 0,
        }),
      ]);
      expect(await daemon.custody()).toEqual(landed);
      expect(route.provisioned()).toBe(true);
      await expect(
        route.admissionIdentity(daemon.session.client),
      ).resolves.toBe('account-a');
    } finally {
      control.restore();
      cloud.answer();
    }
  });

  it('stops a follow-up when the lease replaces its client; the replacement confirms against the original fence, never writing again', async () => {
    const cloud = stalledCloud();
    const daemon = await realDaemon({ fetch: cloud.fetch });
    const control = controlDeadlines();
    let replacementReads = 0;
    const replacement: DaemonCloudAccountClient = {
      ...daemon.session.client,
      signal: new AbortController().signal,
      query: (...args) => {
        replacementReads += 1;
        return daemon.session.client.query(...args);
      },
    };
    let client = daemon.session.client;
    const session: DaemonCloudAccountSession = {
      signal: daemon.session.signal,
      lease: daemon.session.lease,
      get client() {
        return client;
      },
    };
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(signedIn('csk-one')),
    });
    try {
      route.observe(session);
      await cloud.probing;
      await daemon.provisionElsewhere(null);
      client = replacement;
      control.deadlines.at(-1)?.abort();
      await route.idle();
      // The follow-up never runs on the replacement, so writes nothing there.
      expect(replacementReads).toBe(0);
      expect(daemon.sent).toHaveLength(1);
      expect(await daemon.custody()).toMatchObject({
        credentialDigest: null,
        credentialGeneration: 2,
      });
      expect(route.provisioned()).toBe(false);
      // The replacement's get is a recovery: it reads once, under the fence
      // the timed-out write was sent with, so the other client's clear stands.
      route.observe(session);
      route.observe(session);
      await route.idle();
      expect(replacementReads).toBe(1);
      expect(daemon.sent).toHaveLength(1);
      expect(await daemon.held()).toBeNull();
      expect(route.provisioned()).toBe(false);
    } finally {
      control.restore();
      cloud.answer();
    }
  });

  it("keeps a timed-out provision's fence on a same-lease retry, so another client's clear stands", async () => {
    const daemon = await realDaemon();
    const control = controlDeadlines();
    const client = unansweredWrites(daemon, control);
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(signedIn('csk-one')),
    });
    try {
      route.observe(client.session);
      // The write lands; its reply and every follow-up time out.
      await client.landed();
      await client.exhaustFollowUps();
      await route.idle();
      expect(await daemon.held()).toBe('csk-one');
      expect(route.provisioned()).toBe(false);
      await daemon.provisionElsewhere(null);
      // The next get of the same lease and client reconciles under the fence
      // the write was sent with, so it never writes the sign-in back.
      client.answerWrites(true);
      route.observe(client.session);
      await route.idle();
      expect(daemon.sent).toEqual([
        expect.objectContaining({
          expectedCredentialDigest: null,
          expectedCredentialGeneration: 0,
        }),
      ]);
      expect(await daemon.custody()).toMatchObject({
        credentialDigest: null,
        credentialGeneration: 2,
      });
      expect(route.provisioned()).toBe(false);
    } finally {
      control.restore();
    }
  });

  it.each(
    (['same lease', 'recovered lease'] as const).flatMap((retry) =>
      (['before', 'after'] as const).map(
        (landing) => [retry, landing] as const,
      ),
    ),
  )(
    "keeps a timed-out sign-out's fence on a retry at the %s, so another client's sign-in stands (retried %s it lands)",
    async (retry, landing) => {
      const daemon = await realDaemon();
      const control = controlDeadlines();
      const client = unansweredWrites(daemon, control);
      let current: AppEntry = signedIn('csk-one');
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: () => Promise.resolve(current),
      });
      try {
        client.answerWrites(true);
        route.observe(client.session);
        await route.idle();
        expect(await daemon.held()).toBe('csk-one');
        client.answerWrites(false);
        current = null;
        route.changed(null);
        // The clear lands; its reply and every follow-up time out.
        await client.landed();
        await client.exhaustFollowUps();
        await route.idle();
        const cleared = await daemon.custody();
        expect(cleared).toMatchObject({
          credentialDigest: null,
          credentialGeneration: 2,
        });
        // Another client's sign-in is fenced by the cleared custody it read.
        const signIn = (): Promise<CoreCloudAccountProvisionResult> =>
          daemon.provisionElsewhere(signedIn('csk-other'), cleared);
        if (landing === 'after')
          await expect(signIn()).resolves.toMatchObject({
            status: 'provisioned',
          });
        client.answerWrites(true);
        if (retry === 'recovered lease') daemon.recover();
        route.observe(client.session);
        await route.idle();
        if (landing === 'before')
          await expect(signIn()).resolves.toMatchObject({
            status: 'provisioned',
          });
        expect(daemon.sent).toHaveLength(2);
        expect(await daemon.custody()).toMatchObject({
          credentialDigest: digestOf('csk-other'),
          credentialGeneration: 3,
        });
        // Reconciled: later gets leave it in place.
        route.observe(client.session);
        await route.idle();
        expect(daemon.sent).toHaveLength(2);
        expect(await daemon.held()).toBe('csk-other');
      } finally {
        control.restore();
      }
    },
  );

  it('takes a follow-up read as the first observation when the first read timed out', async () => {
    const daemon = await realDaemon();
    const control = controlDeadlines();
    const reading = Promise.withResolvers<void>();
    let reads = 0;
    const session: DaemonCloudAccountSession = {
      ...daemon.session,
      client: {
        ...daemon.session.client,
        query: (name, params, requestOptions) => {
          reads += 1;
          if (reads > 1)
            return daemon.session.client.query(name, params, requestOptions);
          reading.resolve();
          return new Promise(() => undefined);
        },
      },
    };
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(signedIn('csk-one')),
    });
    try {
      route.observe(session);
      await reading.promise;
      // No write was issued, so the follow-up writes against what it reads.
      await daemon.provisionElsewhere(signedIn('csk-other'));
      control.deadlines.at(-1)?.abort();
      await route.idle();
      expect(daemon.sent).toEqual([
        expect.objectContaining({
          expectedCredentialDigest: digestOf('csk-other'),
          expectedCredentialGeneration: 1,
        }),
      ]);
      expect(await daemon.held()).toBe('csk-one');
      expect(route.provisioned()).toBe(true);
    } finally {
      control.restore();
    }
  });

  it.each([false, true])(
    'retries an undelivered timed-out provision only against its own observation (replaced meanwhile: %s)',
    async (replaced) => {
      const daemon = await realDaemon();
      const control = controlDeadlines();
      const issued = Promise.withResolvers<void>();
      const dropped: CoreCloudAccountProvisionParams[] = [];
      const session: DaemonCloudAccountSession = {
        ...daemon.session,
        client: {
          ...daemon.session.client,
          instruction: (name, params, requestOptions) => {
            if (dropped.length > 0)
              return daemon.session.client.instruction(
                name,
                params,
                requestOptions,
              );
            dropped.push(params);
            issued.resolve();
            return new Promise(() => undefined);
          },
        },
      };
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: () => Promise.resolve(signedIn('csk-one')),
      });
      try {
        route.observe(session);
        await issued.promise;
        if (replaced) await daemon.provisionElsewhere(signedIn('csk-other'));
        control.deadlines.at(-1)?.abort();
        await route.idle();
        const original = {
          expectedCredentialDigest: null,
          expectedCredentialGeneration: 0,
        };
        expect(dropped).toEqual([expect.objectContaining(original)]);
        expect(daemon.sent).toEqual(
          replaced ? [] : [expect.objectContaining(original)],
        );
        expect(await daemon.held()).toBe(replaced ? 'csk-other' : 'csk-one');
        expect(route.provisioned()).toBe(!replaced);
        if (!replaced) return;
        // The follow-up reached the daemon: later gets leave the other
        // client's sign-in in place, and a recovery provisions this one.
        route.observe(session);
        await route.idle();
        expect(await daemon.held()).toBe('csk-other');
        daemon.recover();
        route.observe(session);
        await route.idle();
        expect(await daemon.held()).toBe('csk-one');
        expect(route.provisioned()).toBe(true);
      } finally {
        control.restore();
      }
    },
  );

  it.each([null, signedIn('csk-replacement')])(
    'settles an issued provision before reconciling a later intent (%j)',
    async (next) => {
      const daemon = await realDaemon();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let first = true;
      const session: DaemonCloudAccountSession = {
        ...daemon.session,
        client: {
          ...daemon.session.client,
          instruction: async (...args) => {
            if (first) {
              first = false;
              entered.resolve();
              await release.promise;
            }
            return daemon.session.client.instruction(...args);
          },
        },
      };
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: () => Promise.resolve(signedIn('csk-in-flight')),
      });
      route.observe(session);
      await entered.promise;
      route.changed(next);
      // The daemon hasn't committed; local cancellation must not skip its clear.
      await new Promise<void>((resolve) => setImmediate(resolve));
      release.resolve();
      await route.idle();
      expect(await daemon.held()).toBe(next?.apiKey ?? null);
      expect(daemon.sent).toHaveLength(2);
    },
  );

  it('does not let an old initial account read overwrite a replacement event', async () => {
    let resolveRead: (entry: { apiKey: string }) => void = () => undefined;
    let readStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const oldRead = new Promise<{ apiKey: string }>((resolve) => {
      resolveRead = resolve;
    });
    const route = createDaemonCloudAccountRoute({
      endpointAuthority: () => endpointAuthority,
      selected: true,
      current: () => {
        readStarted();
        return oldRead;
      },
    });
    const daemon = await realDaemon();
    route.observe(daemon.session);
    await started;
    route.changed(signedIn('csk-new'));
    resolveRead(signedIn('csk-old'));
    await route.idle();
    expect(await daemon.held()).toBe('csk-new');
    expect(daemon.sent).toHaveLength(1);
    expect(route.provisioned()).toBe(true);
    // The change, not the superseded read, ended that observation.
    route.observe(daemon.session);
    await route.idle();
    expect(daemon.sent).toHaveLength(1);
  });

  it.each([
    'unreachable',
    'refused',
    'unavailable',
    'contended',
    'unreadable store',
  ] as const)(
    'reconciles on the next get after an observation ended unreconciled (%s)',
    async (failure) => {
      const daemon = await realDaemon();
      let failing = true;
      const session: DaemonCloudAccountSession = {
        ...daemon.session,
        client: {
          ...daemon.session.client,
          query: async (name, params, requestOptions) => {
            const view = await daemon.session.client.query(
              name,
              params,
              requestOptions,
            );
            if (failing && failure === 'unreachable')
              throw new Error('unreachable');
            return failing && failure === 'unavailable'
              ? { ...view, state: 'unavailable' }
              : view;
          },
          instruction: async (name, params, requestOptions) => {
            if (failing && failure === 'refused') throw new Error('refused');
            // Same-generation contention on every attempt.
            if (failing && failure === 'contended')
              return { status: 'superseded', custody: await daemon.custody() };
            return daemon.session.client.instruction(
              name,
              params,
              requestOptions,
            );
          },
        },
      };
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: () =>
          failing && failure === 'unreadable store'
            ? Promise.reject(new Error('locked'))
            : Promise.resolve(signedIn('csk-one')),
      });
      route.observe(session);
      await route.idle();
      expect(await daemon.held()).toBeNull();
      failing = false;
      route.observe(session);
      await route.idle();
      expect(await daemon.held()).toBe('csk-one');
      // Reconciled now: another client's sign-out stands across later gets.
      await daemon.provisionElsewhere(null);
      route.observe(session);
      await route.idle();
      expect(await daemon.held()).toBeNull();
      expect(daemon.sent).toHaveLength(1);
    },
  );

  it('reconciles on the next get after a sign-in change missed the daemon', async () => {
    let reachable = true;
    let current = signedIn('csk-one');
    const daemon = await realDaemon({ reachable: () => reachable });
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(current),
    });
    route.observe(daemon.session);
    await route.idle();
    reachable = false;
    current = signedIn('csk-two');
    route.changed(current);
    await route.idle();
    reachable = true;
    expect(await daemon.held()).toBe('csk-one');
    route.observe(daemon.session);
    await route.idle();
    expect(await daemon.held()).toBe('csk-two');
  });

  it('keeps a later observation covered when an earlier intent fails', async () => {
    const daemon = await realDaemon();
    const reading = Promise.withResolvers<void>();
    const unreachable = Promise.withResolvers<never>();
    let reads = 0;
    const session: DaemonCloudAccountSession = {
      ...daemon.session,
      client: {
        ...daemon.session.client,
        query: (name, params, requestOptions) => {
          reads += 1;
          if (reads > 1)
            return daemon.session.client.query(name, params, requestOptions);
          reading.resolve();
          return unreachable.promise;
        },
      },
    };
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(signedIn('csk-one')),
    });
    route.observe(session);
    await reading.promise;
    // A recovery observed while the first intent runs owns the coverage.
    daemon.recover();
    route.observe(session);
    unreachable.reject(new Error('unreachable'));
    await route.idle();
    expect(await daemon.held()).toBe('csk-one');
    await daemon.provisionElsewhere(null);
    route.observe(session);
    await route.idle();
    expect(reads).toBe(2);
    expect(await daemon.held()).toBeNull();
  });

  it('keeps a timed-out observation covered through its follow-ups, then reconciles once they run out', async () => {
    const daemon = await realDaemon();
    const control = controlDeadlines();
    let stalled = 3;
    let reading = Promise.withResolvers<void>();
    let reads = 0;
    const session: DaemonCloudAccountSession = {
      ...daemon.session,
      client: {
        ...daemon.session.client,
        query: (name, params, requestOptions) => {
          reads += 1;
          reading.resolve();
          if (reads > stalled)
            return daemon.session.client.query(name, params, requestOptions);
          return new Promise(() => undefined);
        },
      },
    };
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(signedIn('csk-one')),
    });
    try {
      route.observe(session);
      for (let read = 1; read <= stalled; read += 1) {
        await reading.promise;
        reading = Promise.withResolvers<void>();
        expect(reads).toBe(read);
        // Gets during the original intent and its follow-ups queue nothing.
        route.observe(session);
        control.deadlines.at(-1)?.abort();
      }
      await route.idle();
      expect(reads).toBe(stalled);
      expect(daemon.sent).toHaveLength(0);
      stalled = 0;
      route.observe(session);
      await route.idle();
      expect(reads).toBe(4);
      expect(await daemon.held()).toBe('csk-one');
    } finally {
      control.restore();
    }
  });

  it('reconciles on the next get after a provision reply could not read custody', async () => {
    let vault = true;
    let armed = false;
    const daemon = await realDaemon({
      vault: () => vault,
      // The vault fails after the write commits, before the reply's read.
      fetch: () => {
        if (armed) {
          armed = false;
          vault = false;
        }
        return offline();
      },
    });
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(signedIn('csk-one')),
    });
    armed = true;
    route.observe(daemon.session);
    await route.idle();
    expect(vault).toBe(false);
    expect(daemon.sent).toHaveLength(1);
    expect(route.provisioned(daemon.session.client)).toBe(false);
    vault = true;
    expect(await daemon.held()).toBe('csk-one');
    // Same lease and client: only the cleared coverage lets this get
    // reconcile, and it confirms the landed write against its fence.
    route.observe(daemon.session);
    await route.idle();
    expect(daemon.sent).toHaveLength(1);
    expect(route.provisioned(daemon.session.client)).toBe(true);
  });

  it("leaves another client's sign-out in place across capability saves and rejection changes", async () => {
    let rejected = false;
    let reachable = true;
    let current: { apiKey: string } | null = signedIn('csk-app');
    const daemon = await realDaemon({ reachable: () => reachable });
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(current),
      credentialRejected: (apiKey) => rejected && apiKey === current?.apiKey,
    });
    const { commit, statusChanged, stop } = appStore(
      route,
      () => current,
      (entry) => {
        current = entry;
      },
    );
    try {
      route.observe(daemon.session);
      await route.idle();
      expect(await daemon.held()).toBe('csk-app');
      // A known 401 reaches the daemon that still holds this sign-in.
      rejected = true;
      statusChanged();
      await route.idle();
      expect(daemon.sent[1]).toMatchObject({ credentialRejected: true });
      expect(await daemon.custody()).toMatchObject({ sessionExpired: true });
      // A rejection update that misses the daemon leaves the observation
      // covered: it reconciled no sign-in.
      reachable = false;
      rejected = false;
      statusChanged();
      await route.idle();
      reachable = true;
      await daemon.provisionElsewhere(null);
      route.observe(daemon.session);
      // Neither a capability save nor a rejection change is a sign-in.
      commit(
        Object.assign(signedIn('csk-app'), { capabilities: ['cloud-chat'] }),
      );
      rejected = true;
      statusChanged();
      await route.idle();
      expect(daemon.sent).toHaveLength(2);
      expect(await daemon.held()).toBeNull();
      // A committed replacement is a sign-in change.
      commit(signedIn('csk-next'));
      await route.idle();
      expect(await daemon.held()).toBe('csk-next');
      expect(daemon.sent).toHaveLength(3);
    } finally {
      stop();
    }
  });

  it.each([true, false])(
    'never lets a replaced lease follow up after another client signs out (recovered: %s)',
    async (recovered) => {
      const daemon = await realDaemon();
      const control = controlDeadlines();
      const reading = Promise.withResolvers<void>();
      let reads = 0;
      let forwarded = false;
      const session: DaemonCloudAccountSession = {
        ...daemon.session,
        client: {
          ...daemon.session.client,
          query: (name, params, requestOptions) => {
            reads += 1;
            if (reads > 1)
              return daemon.session.client.query(name, params, requestOptions);
            reading.resolve();
            return new Promise(() => undefined);
          },
          instruction: async (name, params, requestOptions) => {
            const result = await daemon.session.client.instruction(
              name,
              params,
              requestOptions,
            );
            if (forwarded) return result;
            forwarded = true;
            // Another client signs the daemon out before this reply's read.
            await daemon.provisionElsewhere(null);
            return { ...result, custody: await daemon.custody() };
          },
        },
      };
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: () => Promise.resolve(signedIn('csk-one')),
      });
      try {
        route.observe(session);
        await reading.promise;
        if (recovered) daemon.recover();
        route.observe(session);
        control.deadlines.at(-1)?.abort();
        await route.idle();
        // One write, by whichever owns the session, against its own read.
        expect(daemon.sent).toEqual([
          expect.objectContaining({
            expectedCredentialDigest: null,
            expectedCredentialGeneration: 0,
          }),
        ]);
        expect(await daemon.custody()).toMatchObject({
          credentialDigest: null,
          credentialGeneration: 2,
        });
        expect(await daemon.held()).toBeNull();
        expect(route.provisioned()).toBe(false);
      } finally {
        control.restore();
      }
    },
  );

  it('fences an explicit sign-out even on a daemon that never held an account', async () => {
    const daemon = await realDaemon();
    let current: AppEntry = null;
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(current),
    });
    const store = appStore(
      route,
      () => current,
      (entry) => {
        current = entry;
      },
    );
    try {
      route.observe(daemon.session);
      await route.idle();
      // A passive signed-out observation of an inactive daemon writes nothing.
      expect(daemon.sent).toEqual([]);
      // The store publishes its explicit sign-out though it held no account.
      store.commit(null);
      await route.idle();
    } finally {
      store.stop();
    }
    expect(daemon.sent).toEqual([
      expect.objectContaining({
        entry: null,
        expectedCredentialDigest: null,
        expectedCredentialGeneration: 0,
      }),
    ]);
    expect(await daemon.custody()).toMatchObject({
      state: 'active',
      credentialDigest: null,
      credentialGeneration: 1,
    });
    // A provision this app sent before signing out, still in transit.
    await expect(
      daemon.session.client.instruction(
        'core.integration.cloudAccount.provision',
        {
          endpointAuthority,
          entry: wire(signedIn('csk-in-transit')),
          expectedCredentialDigest: null,
          expectedCredentialGeneration: 0,
        },
      ),
    ).resolves.toMatchObject({ status: 'superseded' });
    expect(await daemon.held()).toBeNull();
  });

  it("sends one clear per store sign-out, so a repeated one leaves another client's newer sign-in in place", async () => {
    const daemon = await realDaemon();
    let current: AppEntry = signedIn('csk-one');
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(current),
    });
    const store = appStore(
      route,
      () => current,
      (entry) => {
        current = entry;
      },
    );
    try {
      route.observe(daemon.session);
      await route.idle();
      store.commit(null);
      await route.idle();
      expect(daemon.sent).toHaveLength(2);
      const cleared = await daemon.custody();
      // The store publishes a sign-out again, as a disconnect while signed
      // out does; another client's sign-in is fenced by the cleared custody.
      store.commit(null);
      await route.idle();
      expect(daemon.sent).toHaveLength(2);
      await expect(
        daemon.provisionElsewhere(signedIn('csk-other'), cleared),
      ).resolves.toMatchObject({ status: 'provisioned' });
      expect(await daemon.held()).toBe('csk-other');
    } finally {
      store.stop();
    }
  });

  it('clears on a store sign-out after a sign-in an observation read before its commit arrived', async () => {
    const daemon = await realDaemon();
    let current: AppEntry = signedIn('csk-one');
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(current),
    });
    const store = appStore(
      route,
      () => current,
      (entry) => {
        current = entry;
      },
    );
    try {
      route.observe(daemon.session);
      await route.idle();
      store.commit(null);
      await route.idle();
      expect(await daemon.held()).toBeNull();
      // The store holds the next sign-in before its commit notification, and
      // a recovery reads it first.
      current = signedIn('csk-two');
      daemon.recover();
      route.observe(daemon.session);
      await route.idle();
      expect(await daemon.held()).toBe('csk-two');
      store.commit(current);
      await route.idle();
      expect(daemon.sent).toHaveLength(3);
      store.commit(null);
      await route.idle();
      expect(daemon.sent).toHaveLength(4);
      expect(await daemon.held()).toBeNull();
    } finally {
      store.stop();
    }
  });

  it('sends no second clear on recovery after a settled sign-out, so a newer sign-in commits', async () => {
    let current: { apiKey: string } | null = signedIn('csk-one');
    const daemon = await realDaemon();
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(current),
    });
    route.observe(daemon.session);
    await route.idle();
    current = null;
    route.changed(null);
    await route.idle();
    expect(daemon.sent).toHaveLength(2);
    const cleared = await daemon.custody();
    expect(cleared).toMatchObject({
      state: 'active',
      credentialDigest: null,
      credentialGeneration: 2,
    });
    // Another client's sign-in is fenced by the cleared custody it read; the
    // lease recovers before that sign-in lands.
    daemon.recover();
    route.observe(daemon.session);
    await route.idle();
    expect(daemon.sent).toHaveLength(2);
    await expect(
      daemon.provisionElsewhere(signedIn('csk-other'), cleared),
    ).resolves.toMatchObject({
      status: 'provisioned',
      custody: { credentialGeneration: 3 },
    });
    expect(await daemon.held()).toBe('csk-other');
  });

  it('sends no clear at a new session after an ended one settled the sign-out, so a newer sign-in commits', async () => {
    let current: { apiKey: string } | null = signedIn('csk-one');
    const daemon = await realDaemon();
    const ended = new AbortController();
    const first: DaemonCloudAccountSession = {
      signal: ended.signal,
      client: daemon.session.client,
      lease: { state: 'active', lease: { leaseId: 'lease-1' } },
    };
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(current),
    });
    route.observe(first);
    await route.idle();
    current = null;
    route.changed(null);
    await route.idle();
    expect(daemon.sent).toHaveLength(2);
    const cleared = await daemon.custody();
    expect(cleared).toMatchObject({
      credentialDigest: null,
      credentialGeneration: 2,
    });
    // The settled session ends; another client's sign-in is fenced by the
    // cleared custody it read before this app's next session observes.
    ended.abort();
    route.observe(daemon.session);
    await route.idle();
    expect(daemon.sent).toHaveLength(2);
    await expect(
      daemon.provisionElsewhere(signedIn('csk-other'), cleared),
    ).resolves.toMatchObject({
      status: 'provisioned',
      custody: { credentialGeneration: 3 },
    });
    expect(await daemon.held()).toBe('csk-other');
  });

  it.each([
    'its recovered session',
    'a new session',
    'a new session while the dropped lease still recovers',
  ] as const)(
    'fences a sign-out made while the daemon was unreachable at %s',
    async (recovery) => {
      const daemon = await realDaemon();
      const dropped = new AbortController();
      const sending = Promise.withResolvers<CoreCloudAccountProvisionParams>();
      let client: DaemonCloudAccountClient = {
        ...daemon.session.client,
        signal: dropped.signal,
        // The provision leaves the app; the connection drops before it lands.
        instruction: (_name, params) => {
          sending.resolve(params);
          return new Promise(() => undefined);
        },
      };
      const lease = { state: 'active', lease: { leaseId: 'lease-1' } };
      const session: DaemonCloudAccountSession = {
        signal: daemon.session.signal,
        get client() {
          return client;
        },
        lease,
      };
      let current: { apiKey: string } | null = signedIn('csk-one');
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: () => Promise.resolve(current),
      });
      route.observe(session);
      const inTransit = await sending.promise;
      lease.state = recovery === 'a new session' ? 'failed' : 'reconnecting';
      dropped.abort();
      current = null;
      route.changed(null);
      await route.idle();
      // A dropped lease that has not failed yet leaves its session unended.
      if (recovery !== 'its recovered session') route.observe(daemon.session);
      else {
        client = daemon.session.client;
        lease.state = 'active';
        lease.lease = { leaseId: 'lease-2' };
        route.observe(session);
      }
      await route.idle();
      expect(daemon.sent).toEqual([
        expect.objectContaining({
          entry: null,
          expectedCredentialDigest: null,
          expectedCredentialGeneration: 0,
        }),
      ]);
      await expect(
        daemon.session.client.instruction(
          'core.integration.cloudAccount.provision',
          inTransit,
        ),
      ).resolves.toMatchObject({ status: 'superseded' });
      expect(await daemon.held()).toBeNull();
    },
  );

  it.each(['before', 'after'] as const)(
    'fences a sign-out at the reconnect of a daemon whose ended session left a sign-in in transit, after a daemon first observed %s the sign-out cleared',
    async (timing) => {
      const first = await realDaemon();
      const second = await realDaemon();
      const ended = new AbortController();
      const sending = Promise.withResolvers<CoreCloudAccountProvisionParams>();
      const dropped: DaemonCloudAccountSession = {
        signal: ended.signal,
        client: {
          ...first.session.client,
          // The provision leaves the app; the session ends before its reply.
          instruction: (_name, params) => {
            sending.resolve(params);
            return new Promise(() => undefined);
          },
        },
        lease: { state: 'active', lease: { leaseId: 'lease-1' } },
      };
      let current: { apiKey: string } | null = signedIn('csk-one');
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: () => Promise.resolve(current),
      });
      route.observe(dropped);
      const inTransit = await sending.promise;
      ended.abort();
      // A session to another daemon is first observed after that one ended.
      if (timing === 'before') {
        route.observe(second.session);
        await route.idle();
      }
      current = null;
      route.changed(null);
      await route.idle();
      if (timing === 'after') {
        route.observe(second.session);
        await route.idle();
      }
      // Without a daemon identity, a fresh daemon at the in-transit write's
      // fence is cleared too; that clear does not fence the first daemon.
      expect(second.sent).toEqual(
        timing === 'before'
          ? [
              expect.objectContaining({ expectedCredentialGeneration: 0 }),
              expect.objectContaining({
                entry: null,
                expectedCredentialGeneration: 1,
              }),
            ]
          : [
              expect.objectContaining({
                entry: null,
                expectedCredentialGeneration: 0,
              }),
            ],
      );
      expect(await second.held()).toBeNull();
      route.observe(first.session);
      await route.idle();
      expect(first.sent).toEqual([
        expect.objectContaining({
          entry: null,
          expectedCredentialDigest: null,
          expectedCredentialGeneration: 0,
        }),
      ]);
      await expect(
        first.session.client.instruction(
          'core.integration.cloudAccount.provision',
          inTransit,
        ),
      ).resolves.toMatchObject({ status: 'superseded' });
      expect(await first.held()).toBeNull();
    },
  );

  it('settles a timed-out provision the daemon is still writing before a sign-out clears it', async () => {
    const daemon = await realDaemon();
    const control = controlDeadlines();
    const put = daemon.gatePut();
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(signedIn('csk-one')),
    });
    try {
      route.observe(daemon.session);
      await put.reached;
      control.deadlines.at(-1)?.abort();
      route.changed(null);
      put.release();
      await route.idle();
      expect(daemon.sent).toEqual([
        expect.objectContaining({
          entry: {
            apiKey: 'csk-one',
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: 'now',
          },
          expectedCredentialDigest: null,
          expectedCredentialGeneration: 0,
        }),
        expect.objectContaining({
          entry: null,
          expectedCredentialDigest: digestOf('csk-one'),
          expectedCredentialGeneration: 1,
        }),
      ]);
      expect(await daemon.held()).toBeNull();
    } finally {
      control.restore();
    }
  });

  it('sends no clear to a fresh daemon after a timed-out sign-in its own client read past', async () => {
    const daemon = await realDaemon();
    const fresh = await realDaemon();
    const control = controlDeadlines();
    const put = daemon.gatePut();
    const session: DaemonCloudAccountSession = {
      ...daemon.session,
      client: {
        ...daemon.session.client,
        // The transport gives up at the deadline; the daemon keeps writing.
        instruction: (name, params, requestOptions) => {
          const landing = daemon.session.client.instruction(name, params);
          return new Promise((resolve, reject) => {
            requestOptions?.signal?.addEventListener(
              'abort',
              () => reject(new Error('deadline')),
              { once: true },
            );
            void landing.then(resolve, reject);
          });
        },
      },
    };
    let current: { apiKey: string } | null = signedIn('csk-one');
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(current),
    });
    try {
      route.observe(session);
      await put.reached;
      control.deadlines.at(-1)?.abort();
      current = null;
      route.changed(null);
      put.release();
      await route.idle();
      expect(daemon.sent).toEqual([
        expect.objectContaining({ expectedCredentialGeneration: 0 }),
        expect.objectContaining({
          entry: null,
          expectedCredentialDigest: digestOf('csk-one'),
          expectedCredentialGeneration: 1,
        }),
      ]);
      // The sign-out read the landed sign-in through the same client, so it
      // can no longer land at the fresh daemon's (null, 0).
      route.observe(fresh.session);
      await route.idle();
      expect(fresh.sent).toEqual([]);
    } finally {
      control.restore();
    }
  });

  it('keeps a reconciled observation when a later rejection update cannot read custody', async () => {
    const daemon = await realDaemon();
    let unavailable = false;
    const session: DaemonCloudAccountSession = {
      ...daemon.session,
      client: {
        ...daemon.session.client,
        query: async (name, params, requestOptions) => {
          const view = await daemon.session.client.query(
            name,
            params,
            requestOptions,
          );
          return unavailable ? { ...view, state: 'unavailable' } : view;
        },
      },
    };
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(signedIn('csk-one')),
      credentialRejected: () => false,
    });
    route.observe(session);
    await route.idle();
    expect(route.provisioned(session.client)).toBe(true);
    unavailable = true;
    route.rejectionChanged(signedIn('csk-one'));
    await route.idle();
    expect(daemon.sent).toHaveLength(1);
    expect(route.provisioned(session.client)).toBe(true);
    // Still covered: the same lease and client reconcile nothing again.
    unavailable = false;
    route.observe(session);
    await route.idle();
    expect(daemon.sent).toHaveLength(1);
  });

  it.each(['before', 'after'] as const)(
    'folds a rejection change %s its write was sent into the pending observation',
    async (when) => {
      const daemon = await realDaemon();
      // The owner holds at its custody read (before) or its write (after).
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let rejected = false;
      const session: DaemonCloudAccountSession = {
        ...daemon.session,
        client: {
          ...daemon.session.client,
          query: async (...args) => {
            if (when === 'before' && daemon.sent.length === 0) {
              held.resolve();
              await release.promise;
            }
            return daemon.session.client.query(...args);
          },
          instruction: async (...args) => {
            if (when === 'after') {
              held.resolve();
              await release.promise;
            }
            return daemon.session.client.instruction(...args);
          },
        },
      };
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: () => Promise.resolve(signedIn('csk-one')),
        credentialRejected: () => rejected,
      });
      route.observe(session);
      await held.promise;
      rejected = true;
      route.rejectionChanged(signedIn('csk-one'));
      release.resolve();
      await route.idle();
      // A write sent after the change carries it; an earlier one is amended.
      expect(
        daemon.sent.map((params) => params.credentialRejected ?? false),
      ).toEqual(when === 'before' ? [true] : [false, true]);
      expect(await daemon.custody()).toMatchObject({ sessionExpired: true });
      expect(route.provisioned(session.client)).toBe(false);
    },
  );

  it('re-provisions every daemon when one observation read a sign-in before its commit arrived', async () => {
    let current = signedIn('csk-one');
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(current),
    });
    const first = await realDaemon();
    const second = await realDaemon();
    route.observe(first.session);
    await route.idle();
    // The store holds the next sign-in before its commit notification.
    current = signedIn('csk-two');
    route.observe(second.session);
    await route.idle();
    route.committed(current);
    await route.idle();
    expect([await first.held(), await second.held()]).toEqual([
      'csk-two',
      'csk-two',
    ]);
    expect(route.provisioned(first.session.client)).toBe(true);
  });

  it('re-reads an observation whose store read a newer commit outdated, so a replaced sign-in is never provisioned', async () => {
    let current: AppEntry = signedIn('csk-one');
    let stall:
      | { readonly reached: () => void; readonly released: Promise<void> }
      | undefined;
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: async () => {
        // The read takes the store's entry now and answers later.
        const read = current;
        const gate = stall;
        stall = undefined;
        if (gate) {
          gate.reached();
          await gate.released;
        }
        return read;
      },
    });
    const store = appStore(
      route,
      () => current,
      (entry) => {
        current = entry;
      },
    );
    const first = await realDaemon();
    const second = await realDaemon();
    try {
      route.observe(first.session);
      await route.idle();
      store.commit(current);
      await route.idle();
      expect(first.sent).toHaveLength(1);
      const reached = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      stall = { reached: reached.resolve, released: released.promise };
      route.observe(second.session);
      await reached.promise;
      // The store holds the replacement before its commit notification, and
      // a recovery of the first daemon reads it first.
      current = signedIn('csk-two');
      first.recover();
      route.observe(first.session);
      await first.delivered(2);
      store.commit(current);
      released.resolve();
      await route.idle();
      expect(second.sent.map((params) => params.entry?.apiKey)).toEqual([
        'csk-two',
      ]);
      expect([await first.held(), await second.held()]).toEqual([
        'csk-two',
        'csk-two',
      ]);
      expect(route.provisioned(second.session.client)).toBe(true);
    } finally {
      store.stop();
    }
  });

  it('re-provisions a daemon whose queued change a newer commit replaced, when another observation read it first', async () => {
    let current: AppEntry = signedIn('csk-one');
    const route = createDaemonCloudAccountRoute({
      selected: true,
      endpointAuthority: () => endpointAuthority,
      current: () => Promise.resolve(current),
    });
    const store = appStore(
      route,
      () => current,
      (entry) => {
        current = entry;
      },
    );
    const first = await realDaemon();
    const second = await realDaemon();
    try {
      route.observe(first.session);
      await route.idle();
      // The second daemon's first write holds its queue, so the next
      // change's owner there waits behind it.
      const put = second.gatePut();
      route.observe(second.session);
      await put.reached;
      current = signedIn('csk-two');
      store.commit(current);
      await first.delivered(2);
      // The store holds the next sign-in before its commit notification, and
      // a recovery of the first daemon reads it first.
      current = signedIn('csk-three');
      first.recover();
      route.observe(first.session);
      await first.delivered(3);
      store.commit(current);
      put.release();
      await route.idle();
      expect([await first.held(), await second.held()]).toEqual([
        'csk-three',
        'csk-three',
      ]);
      expect(route.provisioned(second.session.client)).toBe(true);
    } finally {
      store.stop();
    }
  });

  it.each([
    ['clears', null],
    ['replaces', 'csk-two'],
  ] as const)(
    "%s a sign-in an ended session of this app left in transit, when it lands before the app's next write (%s)",
    async (_outcome, next) => {
      const daemon = await realDaemon();
      const ended = new AbortController();
      const sending = Promise.withResolvers<CoreCloudAccountProvisionParams>();
      const dropped: DaemonCloudAccountSession = {
        signal: ended.signal,
        client: {
          ...daemon.session.client,
          // The provision leaves the app; the session ends before its reply.
          instruction: (_name, params) => {
            sending.resolve(params);
            return new Promise(() => undefined);
          },
        },
        lease: { state: 'active', lease: { leaseId: 'lease-1' } },
      };
      let current: AppEntry = signedIn('csk-one');
      const route = createDaemonCloudAccountRoute({
        selected: true,
        endpointAuthority: () => endpointAuthority,
        current: () => Promise.resolve(current),
      });
      route.observe(dropped);
      const inTransit = await sending.promise;
      ended.abort();
      let landed = false;
      const session: DaemonCloudAccountSession = {
        ...daemon.session,
        client: {
          ...daemon.session.client,
          // The ended session's write lands just ahead of this session's first.
          instruction: async (name, params, requestOptions) => {
            if (!landed) {
              landed = true;
              await daemon.session.client.instruction(name, inTransit);
            }
            return daemon.session.client.instruction(
              name,
              params,
              requestOptions,
            );
          },
        },
      };
      current = next === null ? null : signedIn(next);
      route.changed(current);
      route.observe(session);
      await route.idle();
      expect(
        daemon.sent.map((params) => [
          params.entry?.apiKey ?? null,
          params.expectedCredentialDigest,
          params.expectedCredentialGeneration,
        ]),
      ).toEqual([
        ['csk-one', null, 0],
        [next, null, 0],
        // Custody moved past the fence to a sign-in this app replaced.
        [next, digestOf('csk-one'), 1],
      ]);
      expect(await daemon.held()).toBe(next);
      // Reconciled: a later get of the same lease writes nothing.
      route.observe(session);
      await route.idle();
      expect(daemon.sent).toHaveLength(3);
    },
  );

  it('does nothing before selection, or with an unreadable app store', async () => {
    const daemon = await realDaemon();
    const idle = createDaemonCloudAccountRoute({
      endpointAuthority: () => endpointAuthority,
      selected: false,
      current: () => Promise.resolve(signedIn('csk-one')),
    });
    idle.observe(daemon.session);
    idle.changed(signedIn('csk-one'));
    await idle.idle();
    expect(daemon.sent).toHaveLength(0);
    const unreadable = createDaemonCloudAccountRoute({
      endpointAuthority: () => endpointAuthority,
      selected: true,
      current: () => Promise.reject(new Error('locked')),
    });
    unreadable.observe(daemon.session);
    await unreadable.idle();
    // A locked store is not a sign-out: nothing is cleared.
    expect(daemon.sent).toHaveLength(0);
  });
});
