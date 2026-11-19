import { z } from 'zod';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createCanopyDispatcher,
  type CanopyDispatcher,
  type PlatformSecureFileServices,
} from '@canopy/core-runtime';
import {
  createCoreMcpRemovalHandlers,
  type CoreMcpRemovalHost,
} from '@canopy/core-runtime/node/catalog';
import {
  CORE_CATALOG_MCP_REMOVAL_QUERY_DEFINITIONS,
  CORE_CATALOG_MCP_REMOVAL_INSTRUCTION_DEFINITIONS,
  MCP_REMOVAL_GRANT,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  StorageOwnershipRow,
  StorageWriterPrincipal,
} from '@canopy/core-runtime/storage';
import type {
  McpServerData,
  McpServerIndexEntry,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  ForceMcpRemovalRequestSchema,
  type ForceMcpRemovalResult,
} from '@canopy/protocol/mcp-removal';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import { normalizePendingInstalledItemUninstalls } from '@canopy/desktop-shared/node/preferences/record-normalizers';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import {
  createInstalledItemStatusService,
  type InstalledItemStatusPort,
} from '../../installed-items/installed-item-status-service';
import { McpConfigRepository } from '../config-repository';
import { createMcpRemovalEvidenceHost } from '../config-removal-disk';
import {
  McpConfigRemovalEvidence,
  type McpRemovalEvidenceHost,
} from '../config-removal-evidence';
import { McpConfigRemovalService } from '../config-removal-service';
import {
  McpRemovalRefusedError,
  prepareMcpRemoval,
} from '../config-removal-policy';
import { McpCuratedTransitionError } from '../config-repository-format';
import {
  assertMcpConfigAdmission,
  assertMcpRemovalEvidenceAdmission,
} from '../config-writer-admission';

jest.mock('@canopy/execution-engine/canopy-paths', () => ({
  getCanopyDataDir: (): string => root,
  getCanopySecureDataDir: (): string => join(root, 'secure'),
}));

jest.mock('../../canopy-runtime/mcp-removal-dispatch', () => ({
  listMcpRemovalCandidatesThroughCore: jest.fn(() =>
    Promise.resolve({ candidates: [], incomplete: false }),
  ),
  inspectMcpRemovalThroughCore: jest.fn(() =>
    Promise.resolve({ target: 'malformed' }),
  ),
  forceMcpRemovalThroughCore: jest.fn(() =>
    Promise.resolve({ status: 'unresolved' }),
  ),
}));

const serverId = 'a1';
const otherId = 'b2';
const configId = 'c1';
const timestamp = '2026-11-16T00:00:00.000Z';
const unreadable = (): Error =>
  Object.assign(new Error('secret /private/path'), { code: 'EACCES' });
const server = (id = serverId): McpServerData => ({
  definition: {
    id,
    name: 'Test',
    description: '',
    type: 'http',
    url: 'https://example.test/mcp',
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  configs: [
    {
      id: configId,
      name: 'Default',
      description: '',
      enabled: true,
      envVars: {},
      extraArgs: [],
      extraHeaders: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
});
const entry = (id = serverId): McpServerIndexEntry => ({
  id,
  name: 'Test',
  description: '',
  type: 'http',
  updatedAt: timestamp,
  configs: [{ id: configId, name: 'Default', enabled: true }],
});
const json = (value: unknown): string => JSON.stringify(value);

let root: string;
let servers: string;
let evidenceRoot: string;
let indexPath: string;
let host: McpRemovalEvidenceHost;
let repository: McpConfigRepository;
let admitted: jest.Mock<void, []>;
let authorized: jest.Mock<Promise<boolean>, []>;
let credentials: jest.Mock<Promise<void>, [string]>;
let configCredentials: jest.Mock<Promise<void>, [string, string]>;
let published: jest.Mock<Promise<void>, [string]>;
let service: McpConfigRemovalService;
const sourcePath = (id: string): string => join(servers, `server-${id}.json`);

// Real filesystem custody and publication; ACL/flush calls are recorded ports.
// Native platform permission and flush qualification stays with core-platform.
const secureFiles: PlatformSecureFileServices = {
  permissionModel: 'posix-mode',
  permissions: () => Promise.resolve({ state: 'private' }),
  rename: () =>
    Promise.resolve().then(() => {
      throw new Error('link+unlink must not be used');
    }),
  syncDirectory: () => Promise.resolve('flushed'),
};

function compose(
  overrides: Partial<McpRemovalEvidenceHost> = {},
  failRead?: 'server' | 'index',
): void {
  host = {
    ...createMcpRemovalEvidenceHost({
      root: evidenceRoot,
      dataRoot: root,
      serverPath: sourcePath,
      secureFiles,
      assertAdmission: (): void => admitted(),
    }),
    ...overrides,
  };
  repository = new McpConfigRepository(
    { index: (): string => indexPath, server: sourcePath },
    {
      ...fs,
      readFile: (path, encoding): Promise<string> =>
        Promise.resolve().then((): Promise<string> => {
          if (
            (failRead === 'server' && path === sourcePath(serverId)) ||
            (failRead === 'index' && path === indexPath)
          )
            throw unreadable();
          return fs.readFile(path, encoding);
        }),
    },
    host,
  );
  service = new McpConfigRemovalService({
    repository,
    authorizeForce: (): Promise<boolean> => authorized(),
    clearServerCredentials: (id): Promise<void> => credentials(id),
    removed: (id): Promise<void> => published(id),
    clearConfigCredentials: (id, configId): Promise<void> =>
      configCredentials(id, configId),
  });
}

function core(
  host: CoreMcpRemovalHost,
): CanopyDispatcher<
  typeof CORE_CATALOG_MCP_REMOVAL_QUERY_DEFINITIONS,
  typeof CORE_CATALOG_MCP_REMOVAL_INSTRUCTION_DEFINITIONS,
  Record<never, never>
> {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_CATALOG_MCP_REMOVAL_QUERY_DEFINITIONS,
      instructions: CORE_CATALOG_MCP_REMOVAL_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: { ...createCoreMcpRemovalHandlers(host), streams: {} },
  });
}

const repairCaller: CanopyCallerDescriptor = {
  principalId: 'local-user',
  clientInstanceId: 'test',
  authorityId: 'local',
  interfaceKind: 'desktop',
  grants: ['core.catalog.read', MCP_REMOVAL_GRANT],
};

async function seed(): Promise<void> {
  await fs.writeFile(
    sourcePath(serverId),
    json({ version: 1, server: server() }),
  );
  await fs.writeFile(indexPath, json({ version: 1, servers: [entry()] }));
}

async function force(): ReturnType<McpConfigRemovalService['force']> {
  const inspected = await service.inspect({ serverId });
  return service.force({
    serverId,
    mode: 'preserve-evidence',
    inspectedState: inspected.inspectedState,
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'can-4486-'));
  servers = join(root, 'mcp-servers');
  evidenceRoot = join(servers, 'removal-evidence');
  indexPath = join(servers, 'index.json');
  await fs.mkdir(servers);
  admitted = jest.fn<void, []>();
  authorized = jest.fn(() => Promise.resolve(true));
  credentials = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
  published = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
  configCredentials = jest.fn<Promise<void>, [string, string]>(() =>
    Promise.resolve(),
  );
  compose();
  await seed();
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('core catalog device-removal composition', () => {
  function hostPort(): CoreMcpRemovalHost {
    return {
      candidates: () => Promise.resolve({ candidates: [], incomplete: false }),
      inspect: (request) => service.inspect(request),
      force: (request) => service.force(request),
    };
  }

  it('requires a stronger grant than ordinary catalog writes, before any host effects', async () => {
    const port = hostPort();
    const execute = jest.spyOn(port, 'force');
    const dispatcher = core(port);
    const inspected = await dispatcher.query(
      'core.catalog.mcpServer.removal.inspect',
      { serverId },
      { caller: repairCaller },
    );
    await expect(
      dispatcher.instruction(
        'core.catalog.mcpServer.removal.force',
        {
          serverId,
          mode: 'preserve-evidence',
          inspectedState: inspected.inspectedState,
        },
        {
          caller: {
            ...repairCaller,
            grants: ['core.catalog.read', 'core.catalog.write'],
          },
        },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'permission_denied' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
    await expect(fs.stat(sourcePath(serverId))).resolves.toBeDefined();
  });

  it('forwards exact mode and recovery identity and strips only transport metadata', async () => {
    const port = hostPort();
    const execute = jest.spyOn(port, 'force');
    const dispatcher = core(port);
    const inspected = await dispatcher.query(
      'core.catalog.mcpServer.removal.inspect',
      { serverId },
      { caller: repairCaller },
    );
    const request = {
      serverId,
      mode: 'preserve-evidence',
      inspectedState: inspected.inspectedState,
    } as const;
    const outcome = await dispatcher.instruction(
      'core.catalog.mcpServer.removal.force',
      { ...request, _meta: {} },
      { caller: repairCaller },
    );
    expect(outcome).toMatchObject({
      status: 'complete',
      custody: true,
      credentials: true,
      index: 'complete',
    });
    expect(execute).toHaveBeenCalledWith(request, repairCaller);
    expect(outcome.recoveryId).toBeDefined();
    const retry = {
      serverId,
      mode: 'preserve-evidence',
      recoveryId: outcome.recoveryId,
    } as const;
    expect(
      await dispatcher.instruction(
        'core.catalog.mcpServer.removal.force',
        retry,
        { caller: repairCaller },
      ),
    ).toMatchObject({ status: 'complete', recoveryId: outcome.recoveryId });
    expect(execute).toHaveBeenLastCalledWith(retry, repairCaller);
    expect(credentials).toHaveBeenCalledTimes(1);
  });

  it('redacts host errors at the core boundary without parser or path diagnostics', async () => {
    const port = hostPort();
    port.inspect = (): ReturnType<CoreMcpRemovalHost['inspect']> =>
      Promise.resolve().then((): never => {
        throw unreadable();
      });
    const dispatcher = core(port);
    await expect(
      dispatcher.query(
        'core.catalog.mcpServer.removal.inspect',
        { serverId },
        { caller: repairCaller },
      ),
    ).rejects.toThrow(
      'Device MCP removal inspection is unavailable. No removal was attempted.',
    );
  });
});

describe('strict removal preparation and final publication', () => {
  it('the repository deletion entry itself cannot bypass strict preflight', async () => {
    await fs.writeFile(indexPath, '{');
    await expect(repository.remove(serverId)).rejects.toMatchObject({
      code: 'index_malformed',
    });
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
    expect(await fs.readFile(indexPath, 'utf8')).toBe('{');
  });
  it('recognizes only an ENOENT code across filesystem error realms', () => {
    const absent = { error: { code: 'ENOENT' } };
    expect(
      prepareMcpRemoval({
        serverId,
        server: absent,
        index: absent,
        definitionNames: [],
      }),
    ).toMatchObject({ configIds: [], indexText: null });
    for (const error of [
      { code: 'EACCES' },
      { message: 'ENOENT' },
      null,
      'ENOENT',
    ])
      expect(() =>
        prepareMcpRemoval({
          serverId,
          server: { error },
          index: absent,
          definitionNames: [],
        }),
      ).toThrow(McpRemovalRefusedError);
  });
  it('refuses before starting any credential cleanup on a damaged index', async () => {
    await fs.writeFile(indexPath, '{');
    await expect(service.remove(serverId)).rejects.toMatchObject({
      phase: 'preflight',
      effects: 'none',
      code: 'index_malformed',
    });
    expect(configCredentials).not.toHaveBeenCalled();
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
  });

  it('settles every started clear and holds the server lease through rejection', async () => {
    const data = server();
    data.configs.push({ ...data.configs[0], id: 'c2' });
    const row = entry();
    row.configs.push({ id: 'c2', name: 'Second', enabled: true });
    await fs.writeFile(
      sourcePath(serverId),
      json({ version: 1, server: data }),
    );
    await fs.writeFile(indexPath, json({ version: 1, servers: [row] }));
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const clearing = new Promise<void>((resolve) => {
      started = resolve;
    });
    configCredentials.mockImplementation(async (_serverId, id) => {
      if (id === configId) throw unreadable();
      started();
      await pending;
    });
    const removal = service.remove(serverId).then(
      () => 'unexpected success',
      (error: unknown) => error,
    );
    await clearing;
    let leased = false;
    const next = repository.withServerMutation(serverId, () =>
      Promise.resolve().then(() => {
        leased = true;
      }),
    );
    await fs.stat(indexPath);
    expect(leased).toBe(false);
    expect(configCredentials).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
    release();
    expect(await removal).toMatchObject({
      phase: 'tokenClear',
      effects: 'unknown',
    });
    await next;
    expect(leased).toBe(true);
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
  });

  it('reports uncertainty, not no effects, if final validation fails after clears', async () => {
    configCredentials.mockImplementation(() =>
      Promise.resolve(fs.writeFile(indexPath, 'damaged during cleanup')),
    );
    await expect(service.remove(serverId)).rejects.toMatchObject({
      effects: 'unknown',
      code: 'index_malformed',
    });
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
  });

  it.each([
    ['server', '{', 'server_malformed'],
    ['server', json({ version: 22 }), 'server_unsupported'],
    ['index', '{', 'index_malformed'],
    ['index', json({ version: 22 }), 'index_unsupported'],
  ])('refuses %s %s before effects', async (document, text, code) => {
    await fs.writeFile(
      document === 'server' ? sourcePath(serverId) : indexPath,
      text,
    );
    await expect(repository.prepareRemoval(serverId)).rejects.toMatchObject({
      code,
    });
    expect(
      await fs.readFile(
        document === 'server' ? sourcePath(serverId) : indexPath,
        'utf8',
      ),
    ).toBe(text);
    expect(credentials).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
  });

  it('refuses unreadable documents and does not leak parser or filesystem diagnostics', () =>
    Promise.resolve().then(() => {
      for (const failed of ['server', 'index']) {
        try {
          prepareMcpRemoval({
            serverId,
            server:
              failed === 'server'
                ? { error: unreadable() }
                : { text: json({ version: 1, server: server() }) },
            index:
              failed === 'index'
                ? { error: unreadable() }
                : { text: json({ version: 1, servers: [entry()] }) },
            definitionNames: [],
          });
          throw new Error('Expected refusal');
        } catch (error) {
          expect(error).toBeInstanceOf(McpRemovalRefusedError);
          expect(String(error)).not.toMatch(/secret|private/);
        }
      }
      expect(credentials).not.toHaveBeenCalled();
    }));

  it('retains known envelope, routing and unknown retained objects while filtering only one row', async () => {
    const retained = {
      ...entry(otherId),
      accountConnectionId: 'account-binding',
      configs: [{ ...entry().configs[0], extension: { x: 1 } }],
      future: { nested: ['a'] },
    };
    const original = {
      version: 1,
      accountConnectionsAvailable: false,
      accountConnectionsUnavailableReason: 'unavailable',
      future: { x: 1 },
      servers: [entry(), retained],
    };
    await fs.writeFile(indexPath, json(original));
    const plan = await repository.prepareRemoval(serverId);
    await repository.removePrepared(plan);
    expect(JSON.parse(await fs.readFile(indexPath, 'utf8'))).toEqual({
      ...original,
      servers: [retained],
    });
    await expect(fs.stat(sourcePath(serverId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('revalidates before unlink and preserves intervening other-server changes', async () => {
    const plan = await repository.prepareRemoval(serverId);
    await fs.writeFile(
      indexPath,
      json({
        version: 1,
        future: 3,
        servers: [entry(), { ...entry(otherId), future: 8 }],
      }),
    );
    await repository.removePrepared(plan);
    expect(JSON.parse(await fs.readFile(indexPath, 'utf8'))).toEqual({
      version: 1,
      future: 3,
      servers: [{ ...entry(otherId), future: 8 }],
    });
  });

  it('refuses final invalid state without unlinking', async () => {
    const plan = await repository.prepareRemoval(serverId);
    await fs.writeFile(indexPath, 'damaged');
    await expect(repository.removePrepared(plan)).rejects.toBeInstanceOf(
      McpRemovalRefusedError,
    );
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
    expect(await fs.readFile(indexPath, 'utf8')).toBe('damaged');
  });

  it('rejects config-membership mismatch, but not index-owned binding differences', async () => {
    await fs.writeFile(
      indexPath,
      json({
        version: 1,
        servers: [{ ...entry(), accountConnectionId: 'account-id' }],
      }),
    );
    await expect(repository.prepareRemoval(serverId)).resolves.toMatchObject({
      configIds: [configId],
    });
    await fs.writeFile(
      indexPath,
      json({ version: 1, servers: [{ ...entry(), configs: [] }] }),
    );
    await expect(repository.prepareRemoval(serverId)).rejects.toMatchObject({
      code: 'identity_mismatch',
    });
  });

  it('keeps missing-definition retry after unlink succeeded but index publication failed', async () => {
    const plan = await repository.prepareRemoval(serverId);
    await expect(
      repository.removePrepared(plan, (step, run) =>
        step === 'indexUpdate' ? Promise.reject(new Error('disk full')) : run(),
      ),
    ).rejects.toThrow('disk full');
    const retry = await repository.prepareRemoval(serverId);
    expect(retry.configIds).toEqual([configId]);
    await repository.removePrepared(retry);
    expect(
      z
        .object({ servers: z.array(z.unknown()) })
        .parse(JSON.parse(await fs.readFile(indexPath, 'utf8'))).servers,
    ).toEqual([]);
  });

  it('both absent succeeds without creating an index, but any remaining definition refuses', async () => {
    await fs.unlink(indexPath);
    await fs.unlink(sourcePath(serverId));
    await repository.removePrepared(await repository.prepareRemoval(serverId));
    await expect(fs.stat(indexPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(
      sourcePath(otherId),
      'unreadable or malformed is still a definition',
    );
    await expect(repository.prepareRemoval(serverId)).rejects.toMatchObject({
      code: 'index_missing',
    });
  });

  it('refuses replacement identity even if bytes match', async () => {
    const plan = await repository.prepareRemoval(serverId);
    await fs.rename(sourcePath(serverId), `${sourcePath(serverId)}.old`);
    await fs.writeFile(
      sourcePath(serverId),
      json({ version: 1, server: server() }),
    );
    await expect(repository.removePrepared(plan)).rejects.toMatchObject({
      code: 'state_changed',
    });
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
  });

  it('continues its queue after a refusal', async () => {
    await fs.writeFile(indexPath, '{');
    await expect(repository.prepareRemoval(serverId)).rejects.toThrow();
    await seed();
    await expect(repository.prepareRemoval(serverId)).resolves.toMatchObject({
      serverId,
    });
  });

  it('checks admission before all writer boundaries when configured', async () => {
    admitted.mockImplementation(() => {
      throw new Error('unadmitted');
    });
    await expect(repository.prepareRemoval(serverId)).rejects.toThrow(
      'unadmitted',
    );
    await expect(
      repository.save(serverId, () => ({ server: server(), entry: entry() })),
    ).rejects.toThrow('unadmitted');
    await expect(
      repository.backfill(
        () => true,
        () => ({ urlHost: 'example.test' }),
      ),
    ).rejects.toThrow('unadmitted');
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
  });
});

describe('evidence-preserving removal and restart replay', () => {
  it('requires reinspection if the shared-index approval scope changed', async () => {
    const inspected = await service.inspect({ serverId });
    await fs.writeFile(indexPath, '{');
    expect(
      await service.force({
        serverId,
        mode: 'preserve-evidence',
        inspectedState: inspected.inspectedState,
      }),
    ).toMatchObject({ status: 'refused', code: 'state_changed' });
    await expect(fs.stat(evidenceRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(credentials).not.toHaveBeenCalled();
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
  });

  it('never publishes a schema-valid receipt larger than its restart reader accepts', async () => {
    const source = await host.source(serverId);
    if (source.kind !== 'file') throw new Error('Missing fixture');
    const evidence = new McpConfigRemovalEvidence(host);
    const receipt = await evidence.prepare({
      serverId,
      source: source.identity,
      configIds: Array.from(
        { length: 1024 },
        (_, i) => `${'a'.repeat(240)}${i.toString(16)}`,
      ),
    });
    expect(
      z.object({ configIds: z.null() }).parse(receipt).configIds,
    ).toBeNull();
    expect(await evidence.read(serverId, receipt.recoveryId)).toEqual(receipt);
  });
  it('an unreadable shared index remains byte-for-byte unchanged with unresolved custody', async () => {
    const before = await fs.readFile(indexPath);
    compose({}, 'index');
    const inspection = await service.inspect({ serverId });
    expect(inspection.index).toBe('unreadable');
    const outcome = await service.force({
      serverId,
      mode: 'preserve-evidence',
      inspectedState: inspection.inspectedState,
    });
    expect(outcome).toMatchObject({
      status: 'unresolved',
      custody: true,
      index: 'unresolved',
    });
    expect(await fs.readFile(indexPath)).toEqual(before);
    expect(published).not.toHaveBeenCalled();
  });

  it('completes an entirely absent device directory without manufacturing an index', async () => {
    await fs.rm(servers, { recursive: true });
    expect(await force()).toMatchObject({
      status: 'complete',
      index: 'complete',
    });
    await expect(fs.stat(indexPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses owner-scoped cleanup rather than persisting invalid config identities', async () => {
    const data = server();
    const config = data.configs.find((entry) => entry.id === configId);
    if (!config) throw new Error('missing fixture config');
    config.id = 'invalid/config';
    await fs.writeFile(
      sourcePath(serverId),
      json({ version: 1, server: data }),
    );
    const outcome = await force();
    expect(outcome.status).toBe('complete');
    expect(credentials).toHaveBeenCalledWith(serverId);
    const receipt: unknown = JSON.parse(
      await fs.readFile(
        join(evidenceRoot, outcome.recoveryId ?? '', 'receipt.json'),
        'utf8',
      ),
    );
    expect(
      z.object({ configIds: z.null() }).parse(receipt).configIds,
    ).toBeNull();
    expect(json(receipt)).not.toContain('invalid/config');
  });

  it('keeps the server lease but not the disk queue across credential cleanup', async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const clearing = new Promise<void>((resolve) => {
      started = resolve;
    });
    credentials.mockImplementation(async () => {
      started();
      await pending;
    });
    const removal = force();
    await clearing;
    await repository.withServerMutation(otherId, () =>
      repository.save(otherId, () => ({
        server: server(otherId),
        entry: entry(otherId),
      })),
    );
    let sameIdRan = false;
    const sameId = repository.withServerMutation(serverId, () =>
      Promise.resolve().then(() => {
        sameIdRan = true;
      }),
    );
    await fs.stat(indexPath);
    expect(sameIdRan).toBe(false);
    release();
    expect(await removal).toMatchObject({ status: 'complete' });
    await sameId;
    expect(sameIdRan).toBe(true);
    const raw = z
      .object({ servers: z.array(z.unknown()) })
      .parse(JSON.parse(await fs.readFile(indexPath, 'utf8')));
    expect(raw.servers).toEqual([entry(otherId)]);
  });

  (process.platform === 'win32' ? it.skip : it)(
    'quarantines a real unreadable leaf without parsing or chmod repair',
    async () => {
      const original = 'unreadable secret bytes, not JSON';
      await fs.writeFile(sourcePath(serverId), original);
      await fs.chmod(sourcePath(serverId), 0);
      const inspected = await service.inspect({ serverId });
      expect(inspected.target).toBe('unreadable');
      const outcome = await service.force({
        serverId,
        mode: 'preserve-evidence',
        inspectedState: inspected.inspectedState,
      });
      expect(outcome.status).toBe('complete');
      const path = join(evidenceRoot, outcome.recoveryId ?? '', 'evidence');
      expect((await fs.lstat(path)).mode & 0o777).toBe(0);
      await fs.chmod(path, 0o600); // Test cleanup/readback only, never a repair step.
      expect(await fs.readFile(path, 'utf8')).toBe(original);
    },
  );

  it('moves original bytes, clears only the exact device credentials, preserves retained index data', async () => {
    const original = await fs.readFile(sourcePath(serverId));
    const outcome = await force();
    expect(outcome).toMatchObject({
      status: 'complete',
      custody: true,
      credentials: true,
      index: 'complete',
    });
    expect(
      await fs.readFile(
        join(evidenceRoot, outcome.recoveryId ?? '', 'evidence'),
      ),
    ).toEqual(original);
    expect(credentials).toHaveBeenCalledWith(serverId);
    expect(published).toHaveBeenCalledWith(serverId);
  });

  it.each(['{', json({ version: 50 })])(
    'quarantines with unresolved index unchanged (%s)',
    async (index) => {
      await fs.writeFile(indexPath, index);
      const outcome = await force();
      expect(outcome).toMatchObject({
        status: 'unresolved',
        custody: true,
        index: 'unresolved',
      });
      expect(await fs.readFile(indexPath, 'utf8')).toBe(index);
      expect(published).not.toHaveBeenCalled();
      expect(
        await fs.readFile(
          join(evidenceRoot, outcome.recoveryId ?? '', 'evidence'),
          'utf8',
        ),
      ).toContain('example.test');
    },
  );

  it('an absent index completes only without surviving definitions; it never manufactures an index', async () => {
    await fs.unlink(indexPath);
    await fs.writeFile(
      sourcePath(otherId),
      json({ version: 1, server: server(otherId) }),
    );
    const outcome = await force();
    expect(outcome.status).toBe('unresolved');
    await expect(fs.stat(indexPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.unlink(sourcePath(otherId));
    const retry = await service.force({
      serverId,
      mode: 'preserve-evidence',
      recoveryId: outcome.recoveryId,
    });
    expect(retry.status).toBe('complete');
    await expect(fs.stat(indexPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses authorization before creating receipts or moving evidence', async () => {
    authorized.mockResolvedValue(false);
    expect(await force()).toMatchObject({
      status: 'refused',
      code: 'authorization_required',
    });
    await expect(fs.stat(evidenceRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(credentials).not.toHaveBeenCalled();
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
  });

  it('an unavailable approval fails closed', async () => {
    authorized.mockRejectedValue(new Error('approval unavailable'));
    expect(await force()).toMatchObject({
      status: 'refused',
      code: 'authorization_required',
    });
    expect(credentials).not.toHaveBeenCalled();
  });

  it('rejects stale inspection without adopting a same-ID replacement', async () => {
    const inspected = await service.inspect({ serverId });
    await fs.rename(sourcePath(serverId), `${sourcePath(serverId)}.old`);
    await fs.writeFile(
      sourcePath(serverId),
      json({ version: 1, server: server() }),
    );
    expect(
      await service.force({
        serverId,
        mode: 'preserve-evidence',
        inspectedState: inspected.inspectedState,
      }),
    ).toMatchObject({ status: 'refused', code: 'state_changed' });
    expect(credentials).not.toHaveBeenCalled();
  });

  it('bounded, secret-free inspection never exposes raw documents or hashes', async () => {
    await fs.writeFile(sourcePath(serverId), '{secret /private/path');
    const inspected = await service.inspect({ serverId });
    expect(inspected).toMatchObject({
      serverId,
      target: 'malformed',
      scope: 'preserve-evidence',
    });
    expect(json(inspected)).not.toMatch(
      /secret|private|Digest|Identity|configIds/,
    );
    expect(
      ForceMcpRemovalRequestSchema.safeParse({
        serverId: 'account:123',
        mode: 'preserve-evidence',
        inspectedState: inspected.inspectedState,
      }).success,
    ).toBe(false);
    expect(
      ForceMcpRemovalRequestSchema.safeParse({
        serverId,
        mode: 'preserve-evidence',
        inspectedState: inspected.inspectedState,
        recoveryId: inspected.inspectedState,
      }).success,
    ).toBe(false);
    expect(
      ForceMcpRemovalRequestSchema.safeParse({
        serverId,
        mode: 'preserve-evidence',
        path: '/private/path',
        inspectedState: inspected.inspectedState,
      }).success,
    ).toBe(false);
  });

  it('rename failure never falls back to unlink or credential cleanup', async () => {
    compose({
      moveToEvidence: () =>
        Promise.resolve().then(() => {
          throw unreadable();
        }),
    });
    expect(await force()).toMatchObject({
      status: 'unknown',
      code: 'custody_failed',
    });
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
    expect(credentials).not.toHaveBeenCalled();
  });

  it('recovers a crash between rename and receipt advancement without losing evidence', async () => {
    const flush = jest.fn(() =>
      Promise.resolve().then(() => {
        throw new Error('crash after rename');
      }),
    );
    compose({ flushCustody: flush });
    const first = await force();
    expect(first).toMatchObject({ status: 'unknown', custody: false });
    expect(credentials).not.toHaveBeenCalled();
    await expect(fs.stat(sourcePath(serverId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    compose(); // A new repository has no in-memory inspected-state tokens.
    const inspection = await service.inspect({ serverId });
    expect(inspection.recoveries).toEqual([
      expect.objectContaining({ recoveryId: first.recoveryId, custody: false }),
    ]);
    const retry = await service.force({
      serverId,
      mode: 'preserve-evidence',
      recoveryId: first.recoveryId,
    });
    expect(retry).toMatchObject({
      status: 'complete',
      recoveryId: first.recoveryId,
    });
  });

  it('custody receipt flush failure is uncertain, with evidence and retry id retained', async () => {
    const actual = host;
    compose({
      writeReceipt: async (receipt, exclusive) => {
        await actual.writeReceipt(receipt, exclusive);
        if (!exclusive) throw new Error('installed, unconfirmed');
      },
    });
    const first = await force();
    expect(first.status).toBe('unknown');
    expect(credentials).not.toHaveBeenCalled();
    expect(
      await fs.readFile(
        join(evidenceRoot, first.recoveryId ?? '', 'evidence'),
        'utf8',
      ),
    ).toContain('example.test');
    compose();
    expect(
      await service.force({
        serverId,
        mode: 'preserve-evidence',
        recoveryId: first.recoveryId,
      }),
    ).toMatchObject({ status: 'complete' });
  });

  it('credentials failure retains custody and can retry after restart', async () => {
    credentials.mockRejectedValueOnce(unreadable());
    const first = await force();
    expect(first.recoveryId).toEqual(expect.any(String));
    expect(first).toMatchObject({
      status: 'unknown',
      custody: true,
      credentials: false,
      code: 'credentials_failed',
    });
    compose();
    expect(
      await service.force({
        serverId,
        mode: 'preserve-evidence',
        recoveryId: first.recoveryId,
      }),
    ).toMatchObject({ status: 'complete' });
  });

  it('a replacement created after custody prevents replay and later reconciliation', async () => {
    credentials.mockRejectedValueOnce(unreadable());
    const first = await force();
    await seed();
    const replacement = await fs.readFile(sourcePath(serverId));
    compose();
    expect(
      await service.force({
        serverId,
        mode: 'preserve-evidence',
        recoveryId: first.recoveryId,
      }),
    ).not.toMatchObject({ status: 'complete' });
    expect(await fs.readFile(sourcePath(serverId))).toEqual(replacement);
    expect(credentials).toHaveBeenCalledTimes(1);
  });

  it('evidence collisions are preserved and never overwritten', async () => {
    const inspected = await service.inspect({ serverId });
    const receipt = await repository.prepareForcedRemoval(
      serverId,
      inspected.inspectedState,
    );
    await fs.writeFile(
      join(evidenceRoot, receipt.recoveryId, 'evidence'),
      'other evidence',
    );
    await expect(
      repository.takeRemovalCustody(serverId, receipt.recoveryId),
    ).rejects.toMatchObject({ code: 'evidence_conflict' });
    expect(
      await fs.readFile(
        join(evidenceRoot, receipt.recoveryId, 'evidence'),
        'utf8',
      ),
    ).toBe('other evidence');
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
  });

  it('receipt prepare failure never moves the target and returns a recovery id', async () => {
    compose({
      writeReceipt: () =>
        Promise.resolve().then(() => {
          throw new Error('disk full');
        }),
    });
    const first = await force();
    expect(first.recoveryId).toEqual(expect.any(String));
    expect(first).toMatchObject({
      status: 'unknown',
      custody: false,
    });
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
    compose();
    expect((await service.inspect({ serverId })).recoveries).toEqual([]);
  });

  it('does not reuse an inspected-state token after an unconfirmed prepare', async () => {
    const actual = host;
    compose({
      writeReceipt: async (receipt, exclusive) => {
        await actual.writeReceipt(receipt, exclusive);
        throw new Error('flush outcome unknown');
      },
    });
    const inspected = await service.inspect({ serverId });
    const request = {
      serverId,
      mode: 'preserve-evidence',
      inspectedState: inspected.inspectedState,
    };
    const first = await service.force(request);
    expect(first.status).toBe('unknown');
    expect(await service.force(request)).toMatchObject({
      status: 'refused',
      code: 'state_changed',
    });
    expect((await fs.readdir(evidenceRoot)).length).toBe(1);
  });

  it('a damaged receipt is refused without raw diagnostic exposure', async () => {
    const inspected = await service.inspect({ serverId });
    const receipt = await repository.prepareForcedRemoval(
      serverId,
      inspected.inspectedState,
    );
    await fs.writeFile(
      join(evidenceRoot, receipt.recoveryId, 'receipt.json'),
      '{"secret":"token"',
    );
    await expect(
      new McpConfigRemovalEvidence(host).read(serverId, receipt.recoveryId),
    ).rejects.toMatchObject({
      code: 'receipt_unusable',
    });
    await expect(
      new McpConfigRemovalEvidence(host).read(serverId, receipt.recoveryId),
    ).rejects.not.toThrow('token');
  });

  it('index publication survives notification failures without replaying removal', async () => {
    published.mockRejectedValue(new Error('refresh failed'));
    expect(await force()).toMatchObject({ status: 'complete' });
  });

  it('unexpected leaves cannot be forced', async () => {
    await fs.unlink(sourcePath(serverId));
    await fs.mkdir(sourcePath(serverId));
    const inspection = await service.inspect({ serverId });
    expect(inspection).toMatchObject({
      target: 'unexpected',
      scope: 'unavailable',
    });
    expect(
      await service.force({
        serverId,
        mode: 'preserve-evidence',
        inspectedState: inspection.inspectedState,
      }),
    ).toMatchObject({ status: 'refused' });
    expect(credentials).not.toHaveBeenCalled();
  });

  it('caps restart scanning rather than pretending a truncated inventory is complete', async () => {
    compose({
      listOperations: () =>
        Promise.resolve(
          Array.from(
            { length: 129 },
            () => '00000000-0000-4000-8000-000000000000',
          ),
        ),
    });
    await expect(repository.inspectRemoval(serverId)).rejects.toMatchObject({
      code: 'receipt_limit',
    });
    await expect(service.inspect({ serverId })).rejects.toMatchObject({
      code: 'inspection_unavailable',
    });
  });
});

describe('durable uninstall pointer and reconciliation fencing', () => {
  it.each(['prepared', 'custody', 'complete'] as const)(
    'does not bind a %s receipt to a recreated same-ID uninstall',
    async (stage) => {
      const inspected = await service.inspect({ serverId });
      const receipt = await repository.prepareForcedRemoval(
        serverId,
        inspected.inspectedState,
      );
      if (stage === 'complete') {
        expect(
          await service.force({
            serverId,
            mode: 'preserve-evidence',
            recoveryId: receipt.recoveryId,
          }),
        ).toMatchObject({ status: 'complete' });
        credentials.mockClear();
        published.mockClear();
      } else if (stage === 'custody')
        await repository.takeRemovalCustody(serverId, receipt.recoveryId);
      else await fs.rename(sourcePath(serverId), join(root, 'original-server'));
      await seed();
      const replacement = await fs.readFile(sourcePath(serverId));
      const beforeIndex = await fs.readFile(indexPath);
      let recoveryPointer: string | undefined;
      const recorded = jest.fn((_id: string, recoveryId: string) =>
        Promise.resolve().then(() => {
          if (recoveryPointer && recoveryPointer !== recoveryId)
            throw new Error('Recovery identity changed');
          recoveryPointer = recoveryId;
        }),
      );
      service = new McpConfigRemovalService({
        repository,
        authorizeForce: (): Promise<boolean> => Promise.resolve(true),
        clearServerCredentials: credentials,
        clearConfigCredentials: configCredentials,
        removed: published,
        recordRecovery: recorded,
      });
      const stale = await service.force({
        serverId,
        mode: 'preserve-evidence',
        recoveryId: receipt.recoveryId,
      });
      expect(stale).toMatchObject({ code: 'state_changed' });
      expect(recorded).not.toHaveBeenCalled();
      expect(recoveryPointer).toBeUndefined();
      expect(credentials).not.toHaveBeenCalled();
      expect(published).not.toHaveBeenCalled();
      expect(await fs.readFile(sourcePath(serverId))).toEqual(replacement);
      expect(await fs.readFile(indexPath)).toEqual(beforeIndex);
      const fresh = await force();
      if (stage === 'complete') {
        expect(fresh.status).toBe('complete');
        expect(fresh.recoveryId).not.toBe(receipt.recoveryId);
        expect(recoveryPointer).toBe(fresh.recoveryId);
      } else {
        expect(fresh).toMatchObject({
          status: 'refused',
          code: 'previous_removal_pending',
        });
        expect(recorded).not.toHaveBeenCalled();
        expect(credentials).not.toHaveBeenCalled();
        expect(published).not.toHaveBeenCalled();
        expect(await fs.readFile(sourcePath(serverId))).toEqual(replacement);
        expect(await fs.readFile(indexPath)).toEqual(beforeIndex);
      }
    },
  );

  it('persists the exact receipt pointer before custody or credentials', async () => {
    const recorded = jest.fn(async (id: string, recoveryId: string) => {
      expect(id).toBe(serverId);
      expect(
        (await repository.readRemovalReceipt(id, recoveryId)).custody,
      ).toBe(false);
      expect(await fs.readFile(sourcePath(id), 'utf8')).toContain(
        'example.test',
      );
      expect(credentials).not.toHaveBeenCalled();
    });
    service = new McpConfigRemovalService({
      repository,
      authorizeForce: (): Promise<boolean> => Promise.resolve(true),
      clearServerCredentials: credentials,
      clearConfigCredentials: configCredentials,
      removed: published,
      recordRecovery: recorded,
    });
    const result = await force();
    expect(result.status).toBe('complete');
    expect(recorded).toHaveBeenCalledWith(serverId, result.recoveryId);
  });

  it('a failed pointer write leaves source, index and credentials untouched with a discoverable receipt', async () => {
    const before = await fs.readFile(indexPath);
    service = new McpConfigRemovalService({
      repository,
      authorizeForce: (): Promise<boolean> => Promise.resolve(true),
      clearServerCredentials: credentials,
      clearConfigCredentials: configCredentials,
      removed: published,
      recordRecovery: (): Promise<void> =>
        Promise.resolve().then((): never => {
          throw unreadable();
        }),
    });
    expect(await force()).toMatchObject({ status: 'unknown', custody: false });
    expect(await fs.readFile(sourcePath(serverId), 'utf8')).toContain(
      'example.test',
    );
    expect(await fs.readFile(indexPath)).toEqual(before);
    expect(credentials).not.toHaveBeenCalled();
    expect((await service.inspect({ serverId })).recoveries).toHaveLength(1);
  });

  it('fences same-ID recreation before uninstall reference pruning', async () => {
    const result = await force();
    if (!result.recoveryId) throw new Error('Expected durable receipt');
    const prune = jest.fn(() => Promise.resolve(undefined));
    await fs.writeFile(
      sourcePath(serverId),
      json({ version: 1, server: server() }),
    );
    await expect(
      repository.reconcileRemoved(serverId, result.recoveryId, prune),
    ).rejects.toBeDefined();
    expect(prune).not.toHaveBeenCalled();
  });

  it('holds the server lease but not the disk queue while pruning saved references', async () => {
    const result = await force();
    if (!result.recoveryId) throw new Error('Expected durable receipt');
    let replacementStarted = false;
    let replacement: Promise<void> | undefined;
    await repository.reconcileRemoved(serverId, result.recoveryId, async () => {
      replacement = repository.withServerMutation(serverId, () =>
        Promise.resolve().then(() => {
          replacementStarted = true;
        }),
      );
      // A short unrelated read can still enter the disk queue.
      await repository.readServerForMutation(otherId);
      expect(replacementStarted).toBe(false);
    });
    await replacement;
    expect(replacementStarted).toBe(true);
  });
});

describe('current-owner admission policy (not an ownership transfer)', () => {
  const rows = (): StorageOwnershipRow[] => [
    {
      id: 'mcp_server_configs',
      transitionOwner: 'legacy',
      currentWriters: ['electron_main'],
      schemaVersion: 1,
      backupPolicy: 'none',
      admittedWriters: [
        'main/mcp/config-repository',
        'main/mcp/config-removal-disk',
      ],
    },
    {
      id: 'mcp_servers_index',
      transitionOwner: 'legacy',
      currentWriters: ['electron_main'],
      schemaVersion: 1,
      backupPolicy: 'none',
      admittedWriters: ['main/mcp/config-repository'],
    },
    {
      id: 'mcp_removal_evidence',
      transitionOwner: 'legacy',
      currentWriters: ['electron_main'],
      schemaVersion: 1,
      backupPolicy: 'none',
      admittedWriters: ['main/mcp/config-removal-disk'],
    },
  ];
  it('admits only the existing main principal and actual physical writer modules', () => {
    expect(() => assertMcpConfigAdmission(rows())).not.toThrow();
    expect(() => assertMcpRemovalEvidenceAdmission(rows())).not.toThrow();
    for (const principal of [
      'daemon',
      'desktop_cli',
      'renderer',
    ] satisfies StorageWriterPrincipal[])
      expect(() => assertMcpConfigAdmission(rows(), principal)).toThrow();
  });
  it.each(['daemon', 'offline'] as const)(
    'refuses %s ownership before effects',
    (owner) => {
      expect(() =>
        assertMcpConfigAdmission(
          rows().map((row) => ({ ...row, transitionOwner: owner })),
        ),
      ).toThrow();
      expect(() =>
        assertMcpRemovalEvidenceAdmission(
          rows().map((row) => ({ ...row, transitionOwner: owner })),
        ),
      ).toThrow();
    },
  );
  it('refuses unknown rows and unadmitted modules', () => {
    expect(() => assertMcpConfigAdmission([])).toThrow();
    expect(() =>
      assertMcpRemovalEvidenceAdmission(
        rows().filter((row) => row.id !== 'mcp_removal_evidence'),
      ),
    ).toThrow();
    expect(() =>
      assertMcpConfigAdmission(
        rows().map((row) => ({ ...row, admittedWriters: ['another-module'] })),
      ),
    ).toThrow();
  });
});

describe('mcp-servers:save-server accepted curated identity policy', () => {
  async function currentCurated(key: string, extra = true): Promise<void> {
    const data = server();
    await fs.writeFile(
      sourcePath(serverId),
      json({
        version: 1,
        server: {
          ...data,
          definition: {
            ...data.definition,
            curated: {
              key,
              ...(extra ? { extension: { important: true } } : {}),
            },
          },
        },
      }),
    );
  }
  const save = (key?: string): Promise<unknown> =>
    repository.save(serverId, () => ({
      entry: entry(),
      server: {
        ...server(),
        definition: {
          ...server().definition,
          ...(key === undefined ? {} : { curated: { key } }),
        },
      },
    }));

  it('preserves unknown fields for padded, normalized-equivalent keys', async () => {
    await currentCurated(' catalog ');
    await save('catalog');
    const stored = z
      .object({
        server: z.object({ definition: z.object({ curated: z.unknown() }) }),
      })
      .parse(JSON.parse(await fs.readFile(sourcePath(serverId), 'utf8')));
    expect(stored.server.definition.curated).toEqual({
      key: 'catalog',
      extension: { important: true },
    });
  });

  it.each(['replacement', undefined])(
    'refuses lossy changed/removed keys %s before either file write',
    async (key) => {
      await currentCurated('catalog');
      const before = await fs.readFile(sourcePath(serverId));
      const index = await fs.readFile(indexPath);
      await expect(save(key)).rejects.toBeInstanceOf(McpCuratedTransitionError);
      expect(await fs.readFile(sourcePath(serverId))).toEqual(before);
      expect(await fs.readFile(indexPath)).toEqual(index);
    },
  );

  it('permits replacement without unknown curated fields', async () => {
    await currentCurated('catalog', false);
    await expect(save('replacement')).resolves.toBeDefined();
  });
});

describe('device uninstall recovery and preference compatibility', () => {
  const recoveryId = '00000000-0000-4000-8000-000000000001';
  const target = { kind: 'mcp-server', serverId } as const;
  const refs = [{ kind: 'mcp-config', serverId, configId }] as const;
  const legacy = { target, refs: [...refs] };
  const recovering = {
    ...legacy,
    mcpRemoval: { version: 1, recoveryId },
  } as const;

  it('retains old intents and the new opaque receipt pointer after restart normalization', () => {
    expect(
      normalizePendingInstalledItemUninstalls(
        JSON.parse(json([legacy, recovering])),
      ),
    ).toEqual([legacy, recovering]);
    const normalized = normalizePendingInstalledItemUninstalls([recovering]);
    expect(
      normalizePendingInstalledItemUninstalls(JSON.parse(json(normalized))),
    ).toEqual([recovering]);
  });

  it('refuses future recovery versions, foreign scopes and unrelated saved refs', () => {
    expect(
      normalizePendingInstalledItemUninstalls([
        { ...recovering, mcpRemoval: { version: 2, recoveryId } },
        { ...recovering, target: { kind: 'account-mcp', connectionId: 'a1' } },
        {
          ...recovering,
          target: { kind: 'mcp-server', serverId: 'account:a1' },
        },
        {
          ...recovering,
          refs: [{ kind: 'mcp-config', serverId: otherId, configId }],
        },
        {
          ...recovering,
          refs: [{ kind: 'skill', sourceId: 'a1', skillName: 'test' }],
        },
        {
          ...recovering,
          mcpRemoval: { version: 1, recoveryId, path: '/private/path' },
        },
      ]),
    ).toEqual([]);
  });

  function setup(
    intent: NonNullable<
      PreferencesData['pendingInstalledItemUninstalls']
    >[number] = legacy,
  ): {
    port: InstalledItemStatusPort;
    preferences: () => PreferencesData;
    events: string[];
  } {
    let preferences: PreferencesData = {
      ...DEFAULT_PREFERENCES,
      pendingInstalledItemUninstalls: [intent],
    };
    const events: string[] = [];
    const unexpected = (): Promise<never> =>
      Promise.resolve().then((): never => {
        throw new Error('Unrelated operation');
      });
    const port: InstalledItemStatusPort = {
      readPreferences: () => Promise.resolve(preferences),
      updatePreferences: async (update) => {
        preferences = { ...preferences, ...(await update(preferences)) };
        return preferences;
      },
      list: jest.fn(() =>
        Promise.resolve().then(() => {
          events.push('inventory');
          throw new Error('Plugin catalog unavailable');
        }),
      ),
      canonical: unexpected,
      serialize: <T>(operation: () => Promise<T>): Promise<T> =>
        Promise.resolve(operation()),
      setClaudeEnabled: unexpected,
      parkCodex: unexpected,
      restoreCodex: unexpected,
      setMcpEnabled: unexpected,
      remove: jest.fn(unexpected),
      removeDeviceServer: jest.fn(() =>
        Promise.resolve().then(() => {
          events.push('remove');
        }),
      ),
      reconcileDeviceRemoval: <T>(
        _serverId: string,
        _recovery: unknown,
        run: () => Promise<T>,
      ): Promise<T> => Promise.resolve(run()),
      prune: jest.fn(() =>
        Promise.resolve().then(() => {
          events.push('prune');
        }),
      ),
      publish: () => Promise.resolve(undefined),
    };
    return { port, preferences: () => preferences, events };
  }

  it('resumes an exact saved legacy device uninstall before unrelated inventory dependencies', async () => {
    const { port, preferences, events } = setup();
    const outcome = await createInstalledItemStatusService(port).uninstall({
      target,
    });
    expect(events.slice(0, 2)).toEqual(['remove', 'prune']);
    expect(outcome.removed).toEqual([target]);
    expect(outcome.errors).toContainEqual(
      expect.objectContaining({ code: 'state_unavailable' }),
    );
    expect(preferences().pendingInstalledItemUninstalls).toEqual([]);
    expect(port.remove).not.toHaveBeenCalled();
    expect(port.prune).toHaveBeenCalledWith(refs);
  });

  it.each(['unresolved', 'pending', 'unknown', 'refused'] as const)(
    'retains recovery identity and refs after %s repair, with no ordinary/account fallback',
    async (status) => {
      const { port, preferences } = setup(recovering);
      port.resumeDeviceRemoval = jest.fn(
        (): Promise<ForceMcpRemovalResult> =>
          Promise.resolve({
            serverId,
            recoveryId,
            status,
            custody: true,
            credentials: true,
            index: 'unresolved',
          }),
      );
      const outcome = await createInstalledItemStatusService(port).uninstall({
        target,
      });
      expect(outcome.removed).toEqual([]);
      expect(outcome.errors).toContainEqual(
        expect.objectContaining({ code: 'uninstall_incomplete' }),
      );
      expect(preferences().pendingInstalledItemUninstalls).toEqual([
        recovering,
      ]);
      expect(port.prune).not.toHaveBeenCalled();
      expect(port.removeDeviceServer).not.toHaveBeenCalled();
      expect(port.remove).not.toHaveBeenCalled();
      expect(port.resumeDeviceRemoval).toHaveBeenCalledWith(
        serverId,
        recovering.mcpRemoval,
      );
    },
  );

  it('fails closed if the receipt-bound repair port is unavailable', async () => {
    const { port, preferences } = setup(recovering);
    const outcome = await createInstalledItemStatusService(port).uninstall({
      target,
    });
    expect(outcome.removed).toEqual([]);
    expect(preferences().pendingInstalledItemUninstalls).toEqual([recovering]);
    expect(port.removeDeviceServer).not.toHaveBeenCalled();
    expect(port.prune).not.toHaveBeenCalled();
  });

  it('prunes only after the exact saved recovery confirms every required artifact stage', async () => {
    const { port, preferences, events } = setup(recovering);
    port.resumeDeviceRemoval = jest.fn(
      (): Promise<ForceMcpRemovalResult> =>
        Promise.resolve().then((): ForceMcpRemovalResult => {
          events.push('repair');
          return {
            serverId,
            recoveryId,
            status: 'complete',
            custody: true,
            credentials: true,
            index: 'complete',
          };
        }),
    );
    const outcome = await createInstalledItemStatusService(port).uninstall({
      target,
    });
    expect(events.slice(0, 2)).toEqual(['repair', 'prune']);
    expect(outcome.removed).toEqual([target]);
    expect(preferences().pendingInstalledItemUninstalls).toEqual([]);
    expect(port.removeDeviceServer).not.toHaveBeenCalled();
  });

  it('does not treat unavailable inventory as empty when no saved device intent exists', async () => {
    const { port } = setup();
    port.readPreferences = (): Promise<PreferencesData> =>
      Promise.resolve({
        ...DEFAULT_PREFERENCES,
        pendingInstalledItemUninstalls: [],
      });
    await expect(
      createInstalledItemStatusService(port).uninstall({ target }),
    ).rejects.toThrow('Plugin catalog unavailable');
    expect(port.removeDeviceServer).not.toHaveBeenCalled();
    expect(port.prune).not.toHaveBeenCalled();
  });

  it('finishes an exact receipt-bound saved uninstall despite broken inventory', async () => {
    const { port, preferences, events } = setup(recovering);
    port.resumeDeviceRemoval = jest.fn(
      (): Promise<ForceMcpRemovalResult> =>
        Promise.resolve({
          serverId,
          recoveryId,
          status: 'complete',
          custody: true,
          credentials: true,
          index: 'complete',
        }),
    );
    const result = await createInstalledItemStatusService(
      port,
    ).finishDeviceMcpRemoval(serverId, recoveryId);
    expect(result.removed).toEqual([target]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'state_unavailable' }),
    );
    expect(events.indexOf('prune')).toBeLessThan(events.indexOf('inventory'));
    expect(preferences().pendingInstalledItemUninstalls).toEqual([]);
    expect(port.remove).not.toHaveBeenCalled();
    expect(port.removeDeviceServer).not.toHaveBeenCalled();
  });

  it('refuses stale or missing saved receipt identity before inventory or reference effects', async () => {
    for (const pending of [[recovering], []]) {
      const { port, events } = setup(recovering);
      port.readPreferences = (): Promise<PreferencesData> =>
        Promise.resolve({
          ...DEFAULT_PREFERENCES,
          pendingInstalledItemUninstalls: pending,
        });
      await expect(
        createInstalledItemStatusService(port).finishDeviceMcpRemoval(
          serverId,
          '00000000-0000-4000-8000-000000000002',
        ),
      ).rejects.toThrow('Saved device MCP uninstall identity changed.');
      expect(events).toEqual([]);
      expect(port.prune).not.toHaveBeenCalled();
      expect(port.remove).not.toHaveBeenCalled();
      expect(port.removeDeviceServer).not.toHaveBeenCalled();
    }
  });
});

describe('inventory-independent removal candidate discovery', () => {
  it('discovers unreadable definitions without using or repairing the shared index', async () => {
    await fs.writeFile(sourcePath(otherId), '{damaged');
    await fs.writeFile(indexPath, '{damaged');
    const before = await fs.readFile(indexPath);
    expect(await repository.removalCandidates()).toEqual({
      serverIds: [serverId, otherId],
      incomplete: false,
    });
    expect(await fs.readFile(indexPath)).toEqual(before);
    expect(credentials).not.toHaveBeenCalled();
  });
  it('finds disappeared targets through their bounded durable recovery receipts', async () => {
    const inspection = await service.inspect({ serverId });
    expect(
      (
        await service.force({
          serverId,
          mode: 'preserve-evidence',
          inspectedState: inspection.inspectedState,
        })
      ).status,
    ).toBe('complete');
    expect(await repository.removalCandidates()).toEqual({
      serverIds: [serverId],
      incomplete: false,
    });
  });
});
