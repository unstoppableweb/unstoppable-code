import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectCanopyClient } from '@canopy/core-client/node';
import {
  createCanopyDispatcher,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import { pipelineDefinitionReplaysPath } from '@canopy/core-runtime/node/pipeline';
import { resetResolvedCanopyDataDirCache } from '@canopy/execution-engine/canopy-paths';
import {
  GOLDEN_BUNDLED_PIPELINE_ID,
  GOLDEN_INVALID_PIPELINE_YAML,
} from '@canopy/execution-engine/node/pipelines/__tests__/golden-fixtures';
import * as store from '@canopy/execution-engine/pipelines/store';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import {
  PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type PipelineDefinitionDeleteParams,
} from '@canopy/protocol/canopy-core';
import type { Pipeline } from '@canopy/execution-engine/types/pipeline';
import {
  startCanopyDaemon,
  type RunningCanopyDaemon,
} from '../../../../../core-daemon/src/daemon';
import {
  DEFINITIONS_DAEMON_OWNED,
  storeDefinitionSources,
} from '../../../../../core-daemon/src/__tests__/pipeline-definition-fixtures';
import {
  createPipelineGoldenWorld,
  GOLDEN_WORKSPACE_ID,
  GOLDEN_WORKTREE_ID,
  type GoldenWorld,
} from '../../__tests__/pipeline-golden/world';
import { getPipelineDefinitionReplaysFilePath } from '../../lib/paths';
import {
  readPipelineLocalMetadata,
  recordUserPipelineOwner,
} from '../../pipelines/pipeline-local-metadata-store';
import * as resourceLanes from '../../pipelines/resource-lanes';
import { createCorePipelineDefinitionAdapter } from '../core-pipeline-definition-adapter';
import { createDaemonPipelineDefinitionRoute } from '../daemon-pipeline-definition-route';
import {
  ELECTRON_DAEMON_DEFINITIONS,
  type ElectronDaemonClient,
} from '../electron-daemon-host';

/*
 * CAN-5092 S1b: the unselected Electron route to the daemon's workflow
 * definitions. Against a production daemon it refuses locally and falls
 * back to nothing. Against a daemon switched on by the trusted seam, over
 * the same seeded store and replay receipts, it answers as Electron main's
 * own adapter does for the bundled and user definitions with resource
 * contexts off. What the daemon does not serve yet is pinned as a gap.
 */

jest.setTimeout(120_000);

const posix = process.platform === 'win32' ? describe.skip : describe;
const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'definition-route',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.write],
};

let world: GoldenWorld;
let seed: string;
let daemon: RunningCanopyDaemon | undefined;
let client: ElectronDaemonClient | undefined;
let contexts: jest.SpyInstance;

const SEEDED_RECEIPT = {
  operation: 'core.pipeline.definition.delete',
  key: 'a'.repeat(64),
  fingerprint: 'b'.repeat(64),
  receipt: { kind: 'result', result: { definitionId: 'gone', revision: 1 } },
};

beforeAll(async () => {
  world = await createPipelineGoldenWorld();
  chmodSync(world.dataDir, 0o700);
  writeFileSync(
    pipelineDefinitionReplaysPath(world.dataDir),
    `${JSON.stringify({ version: 1, entries: [SEEDED_RECEIPT], expired: [] })}\n`,
  );
  seed = join(world.root, 'seed');
  cpSync(join(world.dataDir, 'pipelines'), join(seed, 'pipelines'), {
    recursive: true,
  });
  cpSync(
    pipelineDefinitionReplaysPath(world.dataDir),
    join(seed, 'replays.json'),
  );
});
afterAll(async () => {
  await world.dispose();
});
beforeEach(() => {
  contexts = jest
    .spyOn(resourceLanes, 'pipelineResourceContextEnabled')
    .mockReturnValue(false);
});
afterEach(async () => {
  contexts.mockRestore();
  await client?.close();
  client = undefined;
  await daemon?.stop('test');
  daemon = undefined;
});

/** The seeded store and receipts, before any host wrote. */
function reseed(): void {
  rmSync(join(world.dataDir, 'pipelines'), { recursive: true, force: true });
  cpSync(join(seed, 'pipelines'), join(world.dataDir, 'pipelines'), {
    recursive: true,
  });
  cpSync(
    join(seed, 'replays.json'),
    pipelineDefinitionReplaysPath(world.dataDir),
  );
  resetResolvedCanopyDataDirCache();
}

async function startDaemon(switchedOn: boolean): Promise<ElectronDaemonClient> {
  daemon = await startCanopyDaemon({
    dataRoot: world.dataDir,
    runtimeMode: 'dev',
    buildVersion: 'test',
    brandId: 'canopy',
    secureDataRoot: join(world.root, 'daemon-secure'),
    coworkManagedDirName: '.canopy',
    environment: process.env,
    ...(switchedOn && {
      pipelineDefinitions: {
        ownership: DEFINITIONS_DAEMON_OWNED,
        sources: storeDefinitionSources,
      },
    }),
  });
  const { descriptor } = daemon;
  client = await connectCanopyClient({
    endpoint: {
      kind: 'socket',
      path: descriptor.endpoint.path,
      auth: {
        secret: await readFile(descriptor.tokenRef, 'utf8'),
        dataRootHash: createHash('sha256').update(world.dataDir).digest('hex'),
      },
    },
    clientName: 'definition-route',
    clientVersion: '0',
    definitions: ELECTRON_DAEMON_DEFINITIONS,
  });
  await client.instruction('core.client.lease.acquire', {
    clientInstanceId: 'definition-route',
    interfaceKind: 'desktop',
    label: 'Definition route',
    interactive: false,
    foreground: false,
    renewalIntervalMs: 1000,
    _meta: { idempotencyKey: 'definition-route-lease' },
  });
  return client;
}

function electron(): CanopyDispatcher<
  typeof PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  typeof PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  Record<never, never>
> {
  const adapter = createCorePipelineDefinitionAdapter();
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: PIPELINE_DEFINITION_QUERY_DEFINITIONS,
      instructions: PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: adapter.queries,
      instructions: adapter.instructions,
      streams: {},
    },
  });
}

const userPipeline = (name: string): Pipeline => ({
  ...parsePipelineText(
    readFileSync(
      join(seed, 'pipelines', `${world.userPipelineId}.yaml`),
      'utf8',
    ),
  ),
  name,
});

/** Ids and times a fresh write mints differ by host; everything else must not. */
function normalize(value: unknown, minted: readonly string[] = []): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, field: unknown) =>
      (key === 'createdAt' || key === 'updatedAt') && typeof field === 'string'
        ? '<time>'
        : typeof field === 'string' && minted.includes(field)
          ? '<minted>'
          : field,
    ),
  );
}

function receipts(): unknown[] {
  const parsed: unknown = JSON.parse(
    readFileSync(pipelineDefinitionReplaysPath(world.dataDir), 'utf8'),
  );
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'entries' in parsed &&
    Array.isArray(parsed.entries)
  )
    return parsed.entries;
  throw new Error('The replay receipts are unreadable.');
}

interface Case {
  readonly name: string;
  readonly run: (
    host: 'electron' | 'daemon',
  ) => Promise<{ result: unknown; minted?: readonly string[] }>;
  readonly writes?: boolean;
}

posix('daemon pipeline definition route (CAN-5092 S1b)', () => {
  it('opens nothing when constructed and refuses without a session', async () => {
    const session = jest.fn((): ElectronDaemonClient | null => null);
    const route = createDaemonPipelineDefinitionRoute({ client: session });
    expect(session).not.toHaveBeenCalled();
    await expect(route.list({})).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'core.pipeline.targetUnavailable',
        message: 'No daemon session is open.',
      },
    });
  });

  it("refuses locally on a production daemon and never uses Electron main's store", async () => {
    reseed();
    const before = store.listStoredPipelines();
    const route = createDaemonPipelineDefinitionRoute({
      client: () => client ?? null,
    });
    await startDaemon(false);
    const refusal = { payload: { kind: 'capability_unavailable' } };
    await expect(route.list({})).rejects.toMatchObject(refusal);
    await expect(
      route.get({ definitionId: world.userPipelineId }),
    ).rejects.toMatchObject(refusal);
    await expect(
      route.delete(
        {
          definitionId: world.userPipelineId,
          expectedRevision: null,
          _meta: { idempotencyKey: 'production' },
        },
        { metadata: { idempotencyKey: 'production' } },
      ),
    ).rejects.toMatchObject(refusal);
    expect(store.listStoredPipelines()).toEqual(before);
    expect(receipts()).toEqual([SEEDED_RECEIPT]);
  });

  it("answers as Electron main's adapter for the bundled and user definitions", async () => {
    const route = createDaemonPipelineDefinitionRoute({
      client: () => client ?? null,
    });
    const cases: Case[] = [
      {
        name: 'list',
        run: async (host) => ({
          result:
            host === 'daemon'
              ? await route.list({ sources: ['bundled', 'user'] })
              : await electron().query(
                  'core.pipeline.definition.list',
                  { sources: ['bundled', 'user'] },
                  { caller: CALLER },
                ),
        }),
      },
      ...[GOLDEN_BUNDLED_PIPELINE_ID, 'user'].map(
        (which): Case => ({
          name: `get ${which}`,
          run: async (host) => {
            const definitionId =
              which === 'user' ? world.userPipelineId : which;
            return {
              result:
                host === 'daemon'
                  ? await route.get({ definitionId })
                  : await electron().query(
                      'core.pipeline.definition.get',
                      { definitionId },
                      { caller: CALLER },
                    ),
            };
          },
        }),
      ),
      ...[
        userPipeline('Valid'),
        parsePipelineText(GOLDEN_INVALID_PIPELINE_YAML),
      ].map(
        (pipeline, index): Case => ({
          name: `validate ${index === 0 ? 'valid' : 'invalid'}`,
          run: async (host) => {
            const params = {
              scope: {},
              targetId: null,
              format: 'yaml' as const,
              document: { pipeline },
            };
            return {
              result:
                host === 'daemon'
                  ? await route.validate(params)
                  : await electron().query(
                      'core.pipeline.definition.validate',
                      params,
                      { caller: CALLER },
                    ),
            };
          },
        }),
      ),
      {
        name: 'upsert new',
        writes: true,
        run: async (host) => {
          const params = {
            definitionId: null,
            expectedRevision: null,
            scope: {},
            source: 'user' as const,
            name: 'Created',
            description: 'Created by a host',
            icon: '',
            format: 'yaml' as const,
            document: { pipeline: userPipeline('Created') },
            _meta: { idempotencyKey: 'create' },
          };
          const result =
            host === 'daemon'
              ? await route.upsert(params, {
                  metadata: { idempotencyKey: 'create' },
                })
              : await electron().instruction(
                  'core.pipeline.definition.upsert',
                  params,
                  { caller: CALLER, metadata: { idempotencyKey: 'create' } },
                );
          return { result, minted: [result.definition.definitionId] };
        },
      },
      {
        name: 'upsert existing',
        writes: true,
        run: async (host) => {
          const params = {
            definitionId: world.userPipelineId,
            expectedRevision: null,
            scope: {},
            source: 'user' as const,
            name: 'Edited',
            description: '',
            icon: '',
            format: 'yaml' as const,
            document: { pipeline: userPipeline('Edited') },
            _meta: { idempotencyKey: 'edit' },
          };
          return {
            result:
              host === 'daemon'
                ? await route.upsert(params, {
                    metadata: { idempotencyKey: 'edit' },
                  })
                : await electron().instruction(
                    'core.pipeline.definition.upsert',
                    params,
                    { caller: CALLER, metadata: { idempotencyKey: 'edit' } },
                  ),
          };
        },
      },
      {
        name: 'delete',
        writes: true,
        run: async (host) => {
          const params = {
            definitionId: world.userPipelineId,
            expectedRevision: null,
            _meta: { idempotencyKey: 'delete' },
          };
          return {
            result:
              host === 'daemon'
                ? await route.delete(params, {
                    metadata: { idempotencyKey: 'delete' },
                  })
                : await electron().instruction(
                    'core.pipeline.definition.delete',
                    params,
                    { caller: CALLER, metadata: { idempotencyKey: 'delete' } },
                  ),
          };
        },
      },
      ...[GOLDEN_BUNDLED_PIPELINE_ID, 'user'].map(
        (which): Case => ({
          name: `duplicate ${which}`,
          writes: true,
          run: async (host) => {
            const definitionId =
              which === 'user' ? world.userPipelineId : which;
            const params = {
              sourceDefinitionId: definitionId,
              scope: {},
              name: 'Copied',
              _meta: { idempotencyKey: `copy-${which}` },
            };
            const result =
              host === 'daemon'
                ? await route.duplicate(params, {
                    metadata: { idempotencyKey: `copy-${which}` },
                  })
                : await electron().instruction(
                    'core.pipeline.definition.duplicate',
                    params,
                    {
                      caller: CALLER,
                      metadata: { idempotencyKey: `copy-${which}` },
                    },
                  );
            return { result, minted: [result.definition.definitionId] };
          },
        }),
      ),
    ];
    const outcomes: Record<string, unknown[]> = {};
    for (const host of ['electron', 'daemon'] as const) {
      for (const test of cases) {
        reseed();
        if (host === 'daemon') await startDaemon(true);
        const { result, minted } = await test.run(host);
        (outcomes[test.name] ??= []).push(normalize(result, minted));
        if (test.writes) {
          // Each host keeps the receipts it found and adds its own.
          const kept = receipts();
          expect(kept).toHaveLength(2);
          expect(kept).toContainEqual(SEEDED_RECEIPT);
        }
        await client?.close();
        client = undefined;
        await daemon?.stop('test');
        daemon = undefined;
      }
    }
    for (const test of cases) {
      expect(outcomes[test.name]).toHaveLength(2);
      const [fromElectron, fromDaemon] = outcomes[test.name] ?? [];
      expect(fromElectron).toBeTruthy();
      expect({ [test.name]: fromDaemon }).toEqual({
        [test.name]: fromElectron,
      });
    }
  });

  it('pins what the daemon does not serve yet', async () => {
    reseed();
    const scope = {
      workspaceId: GOLDEN_WORKSPACE_ID,
      worktreeId: GOLDEN_WORKTREE_ID,
    };
    const fromElectron = await electron().query(
      'core.pipeline.definition.list',
      { scope },
      { caller: CALLER },
    );
    const route = createDaemonPipelineDefinitionRoute({
      client: () => client ?? null,
    });
    await startDaemon(true);
    const fromDaemon = await route.list({});
    // Project, curated and shared sources stay with Electron main.
    expect(new Set(fromElectron.items.map((item) => item.source))).toEqual(
      new Set(['bundled', 'user', 'project', 'curated', 'shared']),
    );
    expect(new Set(fromDaemon.items.map((item) => item.source))).toEqual(
      new Set(['bundled', 'user']),
    );
    // Enablement stays with Electron main's preferences.
    await expect(
      route.setEnabled(
        {
          definitionId: world.userPipelineId,
          enabled: false,
          _meta: { idempotencyKey: 'disable' },
        },
        { metadata: { idempotencyKey: 'disable' } },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.sourceUnavailable' },
    });
    // Delete effects stay with Electron main: the daemon's delete leaves the
    // definition's local metadata, which Electron main's removes with it.
    const locator = {
      type: 'stored' as const,
      source: 'user' as const,
      value: world.userPipelineId,
    };
    const deleteParams = (key: string): PipelineDefinitionDeleteParams => ({
      definitionId: world.userPipelineId,
      expectedRevision: null,
      _meta: { idempotencyKey: key },
    });
    recordUserPipelineOwner(world.userPipelineId, 'gap-owner');
    await route.delete(deleteParams('gap-daemon'), {
      metadata: { idempotencyKey: 'gap-daemon' },
    });
    expect(readPipelineLocalMetadata(locator)).toMatchObject({
      owner: 'gap-owner',
    });
    reseed();
    await electron().instruction(
      'core.pipeline.definition.delete',
      deleteParams('gap-electron'),
      { caller: CALLER, metadata: { idempotencyKey: 'gap-electron' } },
    );
    expect(readPipelineLocalMetadata(locator)).toEqual({});
    // Electron's path helper names the receipts file the daemon's does.
    expect(getPipelineDefinitionReplaysFilePath()).toBe(
      pipelineDefinitionReplaysPath(world.dataDir),
    );
  });
});
