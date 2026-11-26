// CAN-4139: core pipeline definition reads on the desktop dispatcher match
// the legacy readers of every source in the CAN-5061 golden world.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  createCanopyDispatcher,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import {
  PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type PipelineDefinition,
  type PipelineDefinitionDuplicateResult,
  type PipelineDefinitionListResult,
  type PipelineDefinitionUpsertParams,
} from '@canopy/protocol/canopy-core';
import {
  GOLDEN_BUNDLED_PIPELINE_ID,
  GOLDEN_INVALID_PIPELINE_YAML,
} from '@canopy/execution-engine/node/pipelines/__tests__/golden-fixtures';
import {
  deleteStoredPipeline,
  getStoredPipelineText,
  listStoredPipelines,
  pipelineDefinitionStore,
  updateStoredPipeline,
} from '@canopy/execution-engine/pipelines/store';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import * as atomicFile from '@canopy/execution-engine/node/lib/atomic-file';
import {
  getUserPipelineIndexPath,
  getUserPipelinesDir,
} from '@canopy/execution-engine/pipelines/config-paths';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import {
  sharedPipelineReadError,
  sharedPipelineRows,
} from '../../pipelines/core-pipeline-definition-sources';
import {
  getPipelineLocalMetadataFilePath,
  getProjectPipelineShareLinksFilePath,
  getWorktreeDir,
} from '../../lib/paths';
import { writeProjectPipelineRemoteMetadata } from '../../pipelines/pipeline-service';
import * as resourceLanes from '../../pipelines/resource-lanes';
import * as packageService from '../../pipelines/pipeline-package-service';
import * as installContext from '../../pipelines/pipeline-install-context';
import * as sidebarItems from '../../lib/sidebar-items';
import * as normalizeModule from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { createCorePipelineDefinitionAdapter } from '../../canopy-runtime/core-pipeline-definition-adapter';
import { desktopPipelineDefinitionHost } from '../../canopy-runtime/core-pipeline-definition-adapter';
import { createPipelineDefinitionReplayStore } from '../../pipelines/pipeline-definition-replay-store';
import {
  listPipelinePackageInstalls,
  removePipelinePackageInstall,
  upsertPipelinePackageInstall,
} from '../../pipelines/pipeline-package-install-store';
import { getPipelinePackageInstallStorePath } from '../../lib/paths';
import { hashPipelinePackageYaml } from '@canopy/desktop-shared/node';
import {
  createPipelineGoldenWorld,
  GOLDEN_CURATED_KEY,
  GOLDEN_PROJECT_PIPELINE_ID,
  GOLDEN_SHARED_REMOTE_ID,
  GOLDEN_SHARED_YAML,
  GOLDEN_CURATED_YAML,
  GOLDEN_WORKSPACE_ID,
  GOLDEN_WORKTREE_ID,
  type GoldenWorld,
} from './world';

jest.setTimeout(120_000);

let world: GoldenWorld;

beforeAll(async () => {
  world = await createPipelineGoldenWorld();
});

afterAll(async () => {
  await world.dispose();
});

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'golden',
  authorityId: 'local-desktop',
  interfaceKind: 'test',
  grants: [PIPELINE_GRANTS.read],
};
const scope = {
  workspaceId: GOLDEN_WORKSPACE_ID,
  worktreeId: GOLDEN_WORKTREE_ID,
};

function dispatcher(): CanopyDispatcher<
  typeof PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  Record<never, never>,
  Record<never, never>
> {
  const adapter = createCorePipelineDefinitionAdapter();
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: PIPELINE_DEFINITION_QUERY_DEFINITIONS,
      instructions: {},
      streams: {},
    },
    handlers: { queries: adapter.queries, instructions: {}, streams: {} },
  });
}

describe('core pipeline definitions on the desktop', () => {
  it('lists every source in core order, matching the legacy readers', async () => {
    const result = await dispatcher().query(
      'core.pipeline.definition.list',
      { scope },
      { caller },
    );
    const stored = listStoredPipelines().data ?? [];
    expect(result.unavailableSources).toEqual([]);
    expect(
      result.items.map((item) => [item.source, item.definitionId]),
    ).toEqual([
      ...stored
        .filter((info) => info.source === 'bundled')
        .map((info) => ['bundled', info.id]),
      ...stored
        .filter((info) => info.source === 'user')
        .map((info) => ['user', info.id]),
      ['project', GOLDEN_PROJECT_PIPELINE_ID],
      ['curated', `curated:${GOLDEN_CURATED_KEY}`],
      ...result.items
        .filter((item) => item.source === 'shared')
        .map((item) => ['shared', item.definitionId]),
    ]);
    expect(
      result.items.some(
        (item) =>
          item.definitionId ===
          `shared:canopy-cloud:${GOLDEN_SHARED_REMOTE_ID}`,
      ),
    ).toBe(true);
  });

  it('reads each source document as its legacy reader does', async () => {
    const get = async (definitionId: string): Promise<PipelineDefinition> =>
      (
        await dispatcher().query(
          'core.pipeline.definition.get',
          { definitionId, scope },
          { caller },
        )
      ).definition;
    const user = await get(world.userPipelineId);
    expect(user.source).toBe('user');
    expect(user.document).toBe(
      getStoredPipelineText(world.userPipelineId).data,
    );
    const bundled = await get(GOLDEN_BUNDLED_PIPELINE_ID);
    expect(bundled).toMatchObject({ source: 'bundled', readonly: true });
    expect(bundled.document).toBe(
      getStoredPipelineText(GOLDEN_BUNDLED_PIPELINE_ID).data,
    );
    const project = await get(GOLDEN_PROJECT_PIPELINE_ID);
    expect(project.source).toBe('project');
    expect(project.document).toBe(
      readFileSync(
        `${world.worktreePath}/.canopy/pipelines/golden-project.yaml`,
        'utf8',
      ),
    );
    const curated = await get(`curated:${GOLDEN_CURATED_KEY}`);
    expect(curated).toMatchObject({ source: 'curated', readonly: true });
    expect(curated.normalized).toMatchObject({
      name: parsePipelineText(GOLDEN_CURATED_YAML).name,
    });
    expect(
      (await get(`shared:canopy-cloud:${GOLDEN_SHARED_REMOTE_ID}`)).document,
    ).toBe(GOLDEN_SHARED_YAML);
  });

  it('refuses a missing definition and a project id without a worktree', async () => {
    await expect(
      dispatcher().query(
        'core.pipeline.definition.get',
        { definitionId: 'missing-pipeline' },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: {
        code: 'core.pipeline.definitionNotFound',
        message: 'Workflow not found: missing-pipeline',
      },
    });
    await expect(
      dispatcher().query(
        'core.pipeline.definition.get',
        { definitionId: GOLDEN_PROJECT_PIPELINE_ID },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.scopeInvalid' },
    });
  });

  it('answers a missing curated or shared workflow as not found with its message', async () => {
    await expect(
      dispatcher().query(
        'core.pipeline.definition.get',
        { definitionId: 'curated:missing-curated' },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.pipeline.definitionNotFound',
        message:
          'This curated workflow is no longer available. Refresh the workflow list.',
      },
    });
    await expect(
      dispatcher().query(
        'core.pipeline.definition.get',
        { definitionId: 'shared:canopy-cloud:shared-missing' },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.pipeline.definitionNotFound',
        message: 'HTTP 404: Not found',
      },
    });
  });

  it('lists and reads only shares a definition id can address', async () => {
    expect(
      sharedPipelineRows([
        { id: GOLDEN_SHARED_REMOTE_ID },
        { id: 'bad:id' },
        { id: 'has/slash' },
        { id: 'x'.repeat(129) },
      ]).map((row) => row.id),
    ).toEqual([GOLDEN_SHARED_REMOTE_ID]);
    await expect(
      dispatcher().query(
        'core.pipeline.definition.get',
        { definitionId: `shared:canopy-cloud:${'x'.repeat(129)}` },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.definitionNotFound' },
    });
  });

  it('keeps a resource-context refusal of a share typed', () => {
    const refusal = new Error('Workflow unavailable (context-mismatch)');
    expect(sharedPipelineReadError(refusal)).toMatchObject({
      code: 'core.pipeline.contextMismatch',
      message: refusal.message,
    });
    const outage = new Error('socket hang up');
    expect(sharedPipelineReadError(outage)).toBe(outage);
  });

  it('reads curated bytes that match the listed content hash', async () => {
    const result = await dispatcher().query(
      'core.pipeline.definition.list',
      { sources: ['curated'] },
      { caller },
    );
    const listed = result.items[0].checksum;
    expect(listed).toMatch(/^sha256:[a-f0-9]{64}$/);
    const { definition } = await dispatcher().query(
      'core.pipeline.definition.get',
      { definitionId: result.items[0].definitionId },
      { caller },
    );
    expect(definition.document).toBe(GOLDEN_CURATED_YAML);
    expect(definition.checksum).toBe(listed);
    expect(
      `sha256:${createHash('sha256').update(definition.document).digest('hex')}`,
    ).toBe(listed);
  });

  it('fails closed on user definitions while saved owners are unreadable, and only then', async () => {
    const metadata = getPipelineLocalMetadataFilePath();
    const saved = existsSync(metadata) ? readFileSync(metadata) : undefined;
    writeFileSync(metadata, '{ not json');
    try {
      await expect(
        dispatcher().query(
          'core.pipeline.definition.get',
          { definitionId: world.userPipelineId },
          { caller },
        ),
      ).rejects.toMatchObject({
        payload: { code: 'core.pipeline.contextMismatch' },
      });
      // A listing leaves out the user definitions it cannot attribute
      // (CAN-5368) rather than failing the bundled ones with them.
      expect(
        (
          await dispatcher().query(
            'core.pipeline.definition.list',
            { sources: ['user'] },
            { caller },
          )
        ).items,
      ).toEqual([]);
      // Without organization contexts the saved owner is never read.
      const contexts = jest
        .spyOn(resourceLanes, 'pipelineResourceContextEnabled')
        .mockReturnValue(false);
      try {
        const listed = await dispatcher().query(
          'core.pipeline.definition.list',
          { sources: ['user'] },
          { caller },
        );
        expect(listed.items.map((item) => item.definitionId)).toContain(
          world.userPipelineId,
        );
        expect(listed.items.every((item) => item.owner === null)).toBe(true);
      } finally {
        contexts.mockRestore();
      }
      expect(
        (
          await dispatcher().query(
            'core.pipeline.definition.get',
            { definitionId: GOLDEN_BUNDLED_PIPELINE_ID },
            { caller },
          )
        ).definition.owner,
      ).toBeNull();
      const bundledOnly = await dispatcher().query(
        'core.pipeline.definition.list',
        { sources: ['bundled'] },
        { caller },
      );
      expect(bundledOnly.items.map((item) => item.definitionId)).toContain(
        GOLDEN_BUNDLED_PIPELINE_ID,
      );
    } finally {
      if (saved) writeFileSync(metadata, saved);
      else rmSync(metadata);
    }
  });

  it('never lists or reads a project definition linked from outside the checkout', async () => {
    const outside = join(world.root, 'outside-pipelines');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, 'escaped.yaml'),
      readFileSync(
        `${world.worktreePath}/.canopy/pipelines/golden-project.yaml`,
        'utf8',
      ).replace(/name: .*/, 'name: Escaped'),
    );
    const link = `${world.worktreePath}/.canopy/pipelines/escaped.yaml`;
    symlinkSync(join(outside, 'escaped.yaml'), link);
    try {
      const listed = await dispatcher().query(
        'core.pipeline.definition.list',
        { scope, sources: ['project'] },
        { caller },
      );
      expect(listed.items.map((item) => item.definitionId)).toEqual([
        GOLDEN_PROJECT_PIPELINE_ID,
      ]);
      await expect(
        dispatcher().query(
          'core.pipeline.definition.get',
          { definitionId: 'project--escaped.yaml', scope },
          { caller },
        ),
      ).rejects.toMatchObject({
        payload: { code: 'core.pipeline.definitionNotFound' },
      });
    } finally {
      rmSync(link);
    }
  });

  it('lists project definitions within the unattended bounds when asked, and names a checkout that exceeds them unavailable (CAN-965)', async () => {
    const list = (
      projectDiscovery?: 'bounded',
    ): Promise<PipelineDefinitionListResult> =>
      dispatcher().query(
        'core.pipeline.definition.list',
        {
          scope,
          sources: ['project'],
          limit: 500,
          ...(projectDiscovery ? { projectDiscovery } : {}),
        },
        { caller },
      );
    // A bounded listing never projects the sidebar, whose reads may persist
    // cleanup or prepare checkouts: it resolves the checkout from the
    // project's own records.
    // Nor does it normalize documents, whose static matrices would expand:
    // a listing validates only the declared scopes.
    const sidebarRead = jest.spyOn(sidebarItems, 'readAllSidebarItems');
    const normalize = jest.spyOn(normalizeModule, 'normalizePipeline');
    const bounded = await list('bounded');
    expect(sidebarRead).not.toHaveBeenCalled();
    expect(normalize).not.toHaveBeenCalled();
    sidebarRead.mockRestore();
    normalize.mockRestore();
    expect(bounded.unavailableSources).toEqual([]);
    expect(bounded.items.map((item) => item.definitionId)).toEqual([
      GOLDEN_PROJECT_PIPELINE_ID,
    ]);

    // The owner can change while the checkout is read: rows are returned
    // only if it can still see the project afterwards.
    const changed = jest
      .spyOn(installContext, 'projectPipelinesVisible')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    try {
      expect((await list('bounded')).items).toEqual([]);
    } finally {
      changed.mockRestore();
    }

    // More files than an unattended scan reads: the bounded listing names
    // the source unavailable instead of listing part of it, and the
    // ordinary listing still reads every file.
    const pipelinesDir = `${world.worktreePath}/.canopy/pipelines`;
    const extra = Array.from(
      { length: 200 },
      (_, index) =>
        `${pipelinesDir}/bulk-${String(index).padStart(3, '0')}.yaml`,
    );
    const template = readFileSync(
      `${pipelinesDir}/golden-project.yaml`,
      'utf8',
    );
    for (const file of extra) writeFileSync(file, template);
    try {
      const cut = await list('bounded');
      expect(cut.unavailableSources).toEqual(['project']);
      expect(cut.items).toEqual([]);

      // An owner that loses the project mid-scan is never told it was cut.
      const lost = jest
        .spyOn(installContext, 'projectPipelinesVisible')
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      try {
        const hidden = await list('bounded');
        expect(hidden.unavailableSources).toEqual([]);
        expect(hidden.items).toEqual([]);
      } finally {
        lost.mockRestore();
      }
      const full = await list();
      expect(full.unavailableSources).toEqual([]);
      expect(full.items).toHaveLength(extra.length + 1);

      // A project the selected owner can't see lists nothing and is not
      // read, so a bounded listing never discloses that it is over a bound.
      const hidden = jest
        .spyOn(installContext, 'projectPipelinesVisible')
        .mockResolvedValue(false);
      try {
        const invisible = await list('bounded');
        expect(invisible.unavailableSources).toEqual([]);
        expect(invisible.items).toEqual([]);
      } finally {
        hidden.mockRestore();
      }
    } finally {
      for (const file of extra) rmSync(file);
    }
  });

  it('never reads a bounded checkout that is a link out of its project (CAN-965)', async () => {
    // A link at a worktree's path (one a worktree join leaves behind, say)
    // may point at another workspace's checkout: a bounded listing refuses
    // it rather than list that checkout's pipelines.
    const linked = getWorktreeDir(GOLDEN_WORKSPACE_ID, 'linked-worktree');
    symlinkSync(world.worktreePath, linked);
    try {
      const listed = await dispatcher().query(
        'core.pipeline.definition.list',
        {
          scope: {
            workspaceId: GOLDEN_WORKSPACE_ID,
            worktreeId: 'linked-worktree',
          },
          sources: ['project'],
          projectDiscovery: 'bounded',
        },
        { caller },
      );
      expect(listed.items).toEqual([]);
      expect(listed.unavailableSources).toEqual(['project']);
    } finally {
      rmSync(linked);
    }
  });

  it('writes nothing for a bounded listing, not even a share-link move a symlink would cause (CAN-965)', async () => {
    const pipelinesDir = `${world.worktreePath}/.canopy/pipelines`;
    const published = `${pipelinesDir}/golden-project.yaml`;
    const linksFile = getProjectPipelineShareLinksFilePath();
    const savedLinks = existsSync(linksFile)
      ? readFileSync(linksFile)
      : undefined;
    expect(
      writeProjectPipelineRemoteMetadata(published, {
        remoteId: 'remote-can-965',
        contentHash: 'hash-can-965',
        shareScope: 'team',
        sharedAt: '2026-11-19T12:00:00.000Z',
      }),
    ).toEqual({ success: true });
    // Same file identity under a name discovery visits first: reconciliation
    // would read it as a rename and move the published binding to it.
    const alias = `${pipelinesDir}/alias.yaml`;
    symlinkSync(published, alias);
    const before = readFileSync(linksFile, 'utf8');
    try {
      const listed = await dispatcher().query(
        'core.pipeline.definition.list',
        { scope, sources: ['project'], projectDiscovery: 'bounded' },
        { caller },
      );
      expect(listed.unavailableSources).toEqual([]);
      expect(readFileSync(linksFile, 'utf8')).toBe(before);
    } finally {
      rmSync(alias);
      if (savedLinks) writeFileSync(linksFile, savedLinks);
      else rmSync(linksFile);
    }
  });

  it('validates without saving anything', async () => {
    const before = listStoredPipelines().data?.length;
    expect(
      await dispatcher().query(
        'core.pipeline.definition.validate',
        {
          scope,
          targetId: 'in_process_worker',
          format: 'yaml',
          document: GOLDEN_INVALID_PIPELINE_YAML,
        },
        { caller },
      ),
    ).toMatchObject({
      valid: false,
      diagnostics: [{ code: 'core.pipeline.definitionInvalid' }],
    });
    expect(listStoredPipelines().data?.length).toBe(before);
  });

  it('summarizes a workflow pipeline with its workflow trigger (CAN-5782)', async () => {
    const id = await world.saveUserPipeline(
      [
        'pipeline:',
        '  name: Golden core workflow',
        '  on:',
        '    workflow:',
        '      inputs:',
        '        topic: { type: string }',
        '  jobs:',
        '    run:',
        '      steps:',
        '        - run: echo workflow',
        '',
      ].join('\n'),
      'pipeline:core-workflow',
    );
    try {
      const result = await dispatcher().query(
        'core.pipeline.definition.list',
        { scope },
        { caller },
      );
      expect(
        result.items.find((item) => item.definitionId === id)?.triggerTypes,
      ).toEqual(['workflow']);
    } finally {
      deleteStoredPipeline(id);
    }
  });
});

// CAN-7497: a create or copy whose receipt was lost after its write
// committed, then resent with the same key, finds its own definition
// instead of writing a second one, and never answers with another caller's.
describe('a resent create after a lost replay receipt (CAN-7497)', () => {
  const writer: CanopyCallerDescriptor = {
    ...caller,
    clientInstanceId: 'golden-writer',
    grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.write],
  };
  const other: CanopyCallerDescriptor = {
    ...writer,
    clientInstanceId: 'golden-other-writer',
  };
  // Each call builds a fresh ledger, as a restart does, over one receipts
  // file; `loseReceipts` makes every save fail after the write commits.
  function writes({ loseReceipts = false } = {}): CanopyDispatcher<
    typeof PIPELINE_DEFINITION_QUERY_DEFINITIONS,
    typeof PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
    Record<never, never>
  > {
    const receipts = createPipelineDefinitionReplayStore();
    const adapter = createCorePipelineDefinitionAdapter({
      ...desktopPipelineDefinitionHost,
      replays: {
        load: () => receipts.load(),
        save: (ledger) =>
          loseReceipts
            ? Promise.reject(new Error('receipt lost'))
            : receipts.save(ledger),
      },
    });
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
  const userIds = (): string[] =>
    (listStoredPipelines().data ?? [])
      .filter((info) => info.source === 'user')
      .map((info) => info.id);
  const create = (
    name: string,
    idempotencyKey: string,
  ): PipelineDefinitionUpsertParams => ({
    definitionId: null,
    expectedRevision: null,
    scope: {},
    source: 'user' as const,
    name,
    description: '',
    icon: '',
    format: 'yaml' as const,
    document: {
      pipeline: {
        name,
        on: { dispatch: {} },
        jobs: { build: { steps: [{ id: 'echo', run: 'echo hi' }] } },
      },
    },
    _meta: { idempotencyKey },
  });
  const created: string[] = [];
  afterEach(() => {
    for (const id of created.splice(0)) deleteStoredPipeline(id);
  });

  it('answers a resent create with its own definition, writing no second one', async () => {
    const before = userIds();
    const first = await writes({ loseReceipts: true }).instruction(
      'core.pipeline.definition.upsert',
      create('Golden resent create', 'resent-create'),
      { caller: writer, metadata: { idempotencyKey: 'resent-create' } },
    );
    created.push(first.definition.definitionId);
    const resent = await writes().instruction(
      'core.pipeline.definition.upsert',
      create('Golden resent create', 'resent-create'),
      { caller: writer, metadata: { idempotencyKey: 'resent-create' } },
    );
    created.push(resent.definition.definitionId);
    expect(resent.definition.definitionId).toBe(first.definition.definitionId);
    expect(resent.definition.revision).toBe(first.definition.revision);
    expect(userIds()).toHaveLength(before.length + 1);
  });

  it('answers a resent copy with its own copy, writing no second one', async () => {
    const before = userIds();
    const params = {
      sourceDefinitionId: GOLDEN_BUNDLED_PIPELINE_ID,
      scope: {},
      _meta: { idempotencyKey: 'resent-copy' },
    };
    const first = await writes({ loseReceipts: true }).instruction(
      'core.pipeline.definition.duplicate',
      params,
      { caller: writer, metadata: { idempotencyKey: 'resent-copy' } },
    );
    created.push(first.definition.definitionId);
    const resent = await writes().instruction(
      'core.pipeline.definition.duplicate',
      params,
      { caller: writer, metadata: { idempotencyKey: 'resent-copy' } },
    );
    created.push(resent.definition.definitionId);
    expect(resent).toEqual(first);
    expect(userIds()).toHaveLength(before.length + 1);
  });

  it("never answers another caller's same key with the first caller's definition", async () => {
    const first = await writes({ loseReceipts: true }).instruction(
      'core.pipeline.definition.upsert',
      create('Golden first caller', 'shared-key'),
      { caller: writer, metadata: { idempotencyKey: 'shared-key' } },
    );
    created.push(first.definition.definitionId);
    const second = await writes().instruction(
      'core.pipeline.definition.upsert',
      create('Golden first caller', 'shared-key'),
      { caller: other, metadata: { idempotencyKey: 'shared-key' } },
    );
    created.push(second.definition.definitionId);
    expect(second.definition.definitionId).not.toBe(
      first.definition.definitionId,
    );
  });

  it('refuses the same key with another payload as a conflict', async () => {
    const before = userIds();
    const first = await writes({ loseReceipts: true }).instruction(
      'core.pipeline.definition.upsert',
      create('Golden first payload', 'reused-key'),
      { caller: writer, metadata: { idempotencyKey: 'reused-key' } },
    );
    created.push(first.definition.definitionId);
    await expect(
      writes().instruction(
        'core.pipeline.definition.upsert',
        create('Golden other payload', 'reused-key'),
        { caller: writer, metadata: { idempotencyKey: 'reused-key' } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
    expect(userIds()).toHaveLength(before.length + 1);
  });

  it('answers a resent create with the enabled state the definition has now', async () => {
    const params = {
      ...create('Golden enabled create', 'enabled-create'),
      enabled: true,
    };
    const first = await writes({ loseReceipts: true }).instruction(
      'core.pipeline.definition.upsert',
      params,
      { caller: writer, metadata: { idempotencyKey: 'enabled-create' } },
    );
    const { definitionId } = first.definition;
    created.push(definitionId);
    await writes().instruction(
      'core.pipeline.definition.setEnabled',
      {
        definitionId,
        enabled: false,
        _meta: { idempotencyKey: 'disable-after-create' },
      },
      { caller: writer, metadata: { idempotencyKey: 'disable-after-create' } },
    );
    const resent = await writes().instruction(
      'core.pipeline.definition.upsert',
      params,
      { caller: writer, metadata: { idempotencyKey: 'enabled-create' } },
    );
    expect(resent.definition.definitionId).toBe(definitionId);
    expect(resent.definition.revision).toBe(first.definition.revision);
    const read = await writes().query(
      'core.pipeline.definition.get',
      { definitionId, scope: {} },
      { caller: writer },
    );
    expect(read.definition.enabled).toBe(false);
  });

  // A kill between the document install and the index install leaves the
  // created document with no index entry.
  function dropIndexEntry(definitionId: string): void {
    const indexPath = getUserPipelineIndexPath();
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      pipelines: { id: string }[];
    };
    writeFileSync(
      indexPath,
      JSON.stringify({
        ...index,
        pipelines: index.pipelines.filter((entry) => entry.id !== definitionId),
      }),
    );
  }

  it('answers a resent create whose document was saved without its index entry', async () => {
    const before = userIds();
    const first = await writes({ loseReceipts: true }).instruction(
      'core.pipeline.definition.upsert',
      create('Golden unindexed create', 'unindexed-create'),
      { caller: writer, metadata: { idempotencyKey: 'unindexed-create' } },
    );
    const { definitionId } = first.definition;
    created.push(definitionId);
    const documentPath = join(getUserPipelinesDir(), `${definitionId}.yaml`);
    const bytes = readFileSync(documentPath);
    const { ino } = statSync(documentPath);
    dropIndexEntry(definitionId);
    expect(userIds()).toEqual(before);
    const resent = await writes().instruction(
      'core.pipeline.definition.upsert',
      create('Golden unindexed create', 'unindexed-create'),
      { caller: writer, metadata: { idempotencyKey: 'unindexed-create' } },
    );
    expect(resent.definition.definitionId).toBe(definitionId);
    expect(userIds()).toEqual([...before, definitionId]);
    // Adopted, not rewritten: the same file, byte for byte.
    expect(statSync(documentPath).ino).toBe(ino);
    expect(readFileSync(documentPath)).toEqual(bytes);
  });

  it('refuses a resent create whose unindexed document holds other bytes, leaving it as it is', async () => {
    const before = userIds();
    const first = await writes({ loseReceipts: true }).instruction(
      'core.pipeline.definition.upsert',
      create('Golden unindexed other bytes', 'unindexed-other'),
      { caller: writer, metadata: { idempotencyKey: 'unindexed-other' } },
    );
    const { definitionId } = first.definition;
    created.push(definitionId);
    const documentPath = join(getUserPipelinesDir(), `${definitionId}.yaml`);
    const other = Buffer.concat([
      readFileSync(documentPath),
      Buffer.from('# edited\n'),
    ]);
    writeFileSync(documentPath, other);
    dropIndexEntry(definitionId);
    await expect(
      writes().instruction(
        'core.pipeline.definition.upsert',
        create('Golden unindexed other bytes', 'unindexed-other'),
        { caller: writer, metadata: { idempotencyKey: 'unindexed-other' } },
      ),
    ).rejects.toThrow('Pipeline create identity already exists or is invalid');
    expect(userIds()).toEqual(before);
    expect(readFileSync(documentPath)).toEqual(other);
    rmSync(documentPath);
    created.splice(created.indexOf(definitionId), 1);
  });

  // A stored source's package install replaces the copy's document with the
  // package's own bytes, so the copy is not the document core serialized.
  it('answers a resent copy of a package-installed workflow with its own copy, writing no second one', async () => {
    const sourceId = await world.saveUserPipeline(
      [
        'pipeline:',
        '  name: Golden packaged source',
        '  on: { dispatch: {} }',
        '  jobs:',
        '    run:',
        '      steps:',
        '        - run: echo packaged',
        '',
      ].join('\n'),
      'pipeline:packaged-source',
    );
    created.push(sourceId);
    const sourceText = getStoredPipelineText(sourceId).data ?? '';
    const installs = getPipelinePackageInstallStorePath();
    await upsertPipelinePackageInstall(installs, {
      localPipelineId: sourceId,
      originExternalId: 'golden-packaged-remote',
      pipelineContentHash: hashPipelinePackageYaml(sourceText),
      distributionMode: 'package',
      packageDigest: `pp:v1:${'a'.repeat(43)}`,
      installedAt: new Date().toISOString(),
    });
    try {
      const before = userIds();
      const params = {
        sourceDefinitionId: sourceId,
        scope: {},
        _meta: { idempotencyKey: 'resent-packaged-copy' },
      };
      const first = await writes({ loseReceipts: true }).instruction(
        'core.pipeline.definition.duplicate',
        params,
        {
          caller: writer,
          metadata: { idempotencyKey: 'resent-packaged-copy' },
        },
      );
      created.push(first.definition.definitionId);
      expect(getStoredPipelineText(first.definition.definitionId).data).toBe(
        sourceText,
      );
      const resent = await writes().instruction(
        'core.pipeline.definition.duplicate',
        params,
        {
          caller: writer,
          metadata: { idempotencyKey: 'resent-packaged-copy' },
        },
      );
      expect(resent).toEqual(first);
      expect(userIds()).toHaveLength(before.length + 1);
    } finally {
      for (const id of [sourceId, ...created])
        await removePipelinePackageInstall(installs, id);
    }
  });

  // An older build put a copy's package bytes in place, then recorded its
  // install: a crash between the two left the copy without its record.
  it('finishes a resent copy of a package-installed workflow whose install record was never saved', async () => {
    const sourceId = await world.saveUserPipeline(
      [
        'pipeline:',
        '  name: Golden packaged source without record',
        '  on: { dispatch: {} }',
        '  jobs:',
        '    run:',
        '      steps:',
        '        - run: echo packaged',
        '',
      ].join('\n'),
      'pipeline:packaged-source-no-record',
    );
    created.push(sourceId);
    const sourceText = getStoredPipelineText(sourceId).data ?? '';
    const installs = getPipelinePackageInstallStorePath();
    await upsertPipelinePackageInstall(installs, {
      localPipelineId: sourceId,
      originExternalId: 'golden-packaged-remote',
      pipelineContentHash: hashPipelinePackageYaml(sourceText),
      distributionMode: 'package',
      packageDigest: `pp:v1:${'a'.repeat(43)}`,
      installedAt: new Date().toISOString(),
    });
    try {
      const before = userIds();
      const params = {
        sourceDefinitionId: sourceId,
        scope: {},
        _meta: { idempotencyKey: 'resent-packaged-copy-no-record' },
      };
      const first = await writes({ loseReceipts: true }).instruction(
        'core.pipeline.definition.duplicate',
        params,
        {
          caller: writer,
          metadata: { idempotencyKey: 'resent-packaged-copy-no-record' },
        },
      );
      const copyId = first.definition.definitionId;
      created.push(copyId);
      await removePipelinePackageInstall(installs, copyId);
      const resent = await writes().instruction(
        'core.pipeline.definition.duplicate',
        params,
        {
          caller: writer,
          metadata: { idempotencyKey: 'resent-packaged-copy-no-record' },
        },
      );
      expect(resent).toEqual(first);
      expect(userIds()).toHaveLength(before.length + 1);
      expect(getStoredPipelineText(copyId).data).toBe(sourceText);
      expect(
        (await listPipelinePackageInstalls(installs)).find(
          (install) => install.localPipelineId === copyId,
        ),
      ).toMatchObject({
        pipelineContentHash: hashPipelinePackageYaml(sourceText),
      });
    } finally {
      for (const id of [sourceId, ...created])
        await removePipelinePackageInstall(installs, id);
    }
  });

  // A package-installed user source, recorded as installed.
  async function packagedSource(
    name: string,
    token: string,
  ): Promise<{ sourceId: string; sourceText: string }> {
    const sourceId = await world.saveUserPipeline(
      [
        'pipeline:',
        `  name: ${name}`,
        '  on: { dispatch: {} }',
        '  jobs:',
        '    run:',
        '      steps:',
        '        - run: echo packaged',
        '',
      ].join('\n'),
      token,
    );
    created.push(sourceId);
    const sourceText = getStoredPipelineText(sourceId).data ?? '';
    await upsertPipelinePackageInstall(getPipelinePackageInstallStorePath(), {
      localPipelineId: sourceId,
      originExternalId: 'golden-packaged-remote',
      pipelineContentHash: hashPipelinePackageYaml(sourceText),
      distributionMode: 'package',
      packageDigest: `pp:v1:${'a'.repeat(43)}`,
      installedAt: new Date().toISOString(),
    });
    return { sourceId, sourceText };
  }

  it('leaves a complete resent copy of a package-installed workflow and its install record as they are', async () => {
    const installs = getPipelinePackageInstallStorePath();
    const { sourceId } = await packagedSource(
      'Golden packaged source complete',
      'pipeline:packaged-source-complete',
    );
    try {
      const params = {
        sourceDefinitionId: sourceId,
        scope: {},
        _meta: { idempotencyKey: 'resent-packaged-copy-complete' },
      };
      const metadata = { idempotencyKey: 'resent-packaged-copy-complete' };
      const first = await writes({ loseReceipts: true }).instruction(
        'core.pipeline.definition.duplicate',
        params,
        { caller: writer, metadata },
      );
      const copyId = first.definition.definitionId;
      created.push(copyId);
      const record = (): Promise<string> =>
        listPipelinePackageInstalls(installs).then((all) =>
          JSON.stringify(all.find((one) => one.localPipelineId === copyId)),
        );
      const recordBefore = await record();
      const documentPath = join(getUserPipelinesDir(), `${copyId}.yaml`);
      const { ino } = statSync(documentPath);
      const resent = await writes().instruction(
        'core.pipeline.definition.duplicate',
        params,
        { caller: writer, metadata },
      );
      expect(resent).toEqual(first);
      expect(await record()).toBe(recordBefore);
      expect(statSync(documentPath).ino).toBe(ino);
    } finally {
      for (const id of [sourceId, ...created])
        await removePipelinePackageInstall(installs, id);
    }
  });

  it('refuses a resent copy it cannot finish with a retryable error', async () => {
    const installs = getPipelinePackageInstallStorePath();
    const { sourceId } = await packagedSource(
      'Golden packaged source stale',
      'pipeline:packaged-source-stale',
    );
    try {
      const params = {
        sourceDefinitionId: sourceId,
        scope: {},
        _meta: { idempotencyKey: 'resent-packaged-copy-stale' },
      };
      const metadata = { idempotencyKey: 'resent-packaged-copy-stale' };
      const first = await writes({ loseReceipts: true }).instruction(
        'core.pipeline.definition.duplicate',
        params,
        { caller: writer, metadata },
      );
      const copyId = first.definition.definitionId;
      created.push(copyId);
      await removePipelinePackageInstall(installs, copyId);
      // The source's record no longer matches its bytes, so the copy's
      // install cannot be carried over.
      await upsertPipelinePackageInstall(installs, {
        localPipelineId: sourceId,
        originExternalId: 'golden-packaged-remote',
        pipelineContentHash: hashPipelinePackageYaml('pipeline: {}\n'),
        distributionMode: 'package',
        packageDigest: `pp:v1:${'a'.repeat(43)}`,
        installedAt: new Date().toISOString(),
      });
      await expect(
        writes().instruction('core.pipeline.definition.duplicate', params, {
          caller: writer,
          metadata,
        }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'unavailable',
          retry: { kind: 'same_idempotency_key' },
        },
      });
      expect(
        (await listPipelinePackageInstalls(installs)).some(
          (install) => install.localPipelineId === copyId,
        ),
      ).toBe(false);
    } finally {
      for (const id of [sourceId, ...created])
        await removePipelinePackageInstall(installs, id);
    }
  });

  // An older build saved core's own document first and put the package's
  // bytes in place after it: a crash between the two left core's document.
  it('finishes a resent copy of a package-installed workflow whose package bytes were never written', async () => {
    const installs = getPipelinePackageInstallStorePath();
    const sourceId = await world.saveUserPipeline(
      [
        'pipeline:',
        '  name: Golden packaged source before bytes',
        '  on: { dispatch: {} }',
        '  jobs:',
        '    run:',
        '      steps:',
        '        - run: echo packaged',
        '',
      ].join('\n'),
      'pipeline:packaged-source-before-bytes',
    );
    created.push(sourceId);
    const sourceText = getStoredPipelineText(sourceId).data ?? '';
    try {
      const before = userIds();
      const params = {
        sourceDefinitionId: sourceId,
        scope: {},
        _meta: { idempotencyKey: 'resent-packaged-copy-before-bytes' },
      };
      const metadata = { idempotencyKey: 'resent-packaged-copy-before-bytes' };
      // Copied before the source's package install is recorded, the copy
      // holds core's serialized document, as the crash leaves it.
      const first = await writes({ loseReceipts: true }).instruction(
        'core.pipeline.definition.duplicate',
        params,
        { caller: writer, metadata },
      );
      const copyId = first.definition.definitionId;
      created.push(copyId);
      expect(getStoredPipelineText(copyId).data).not.toBe(sourceText);
      await upsertPipelinePackageInstall(installs, {
        localPipelineId: sourceId,
        originExternalId: 'golden-packaged-remote',
        pipelineContentHash: hashPipelinePackageYaml(sourceText),
        distributionMode: 'package',
        packageDigest: `pp:v1:${'a'.repeat(43)}`,
        installedAt: new Date().toISOString(),
      });
      const resent = await writes().instruction(
        'core.pipeline.definition.duplicate',
        params,
        { caller: writer, metadata },
      );
      expect(resent.definition.definitionId).toBe(copyId);
      expect(userIds()).toHaveLength(before.length + 1);
      expect(getStoredPipelineText(copyId).data).toBe(sourceText);
      expect(resent.definition.document).toBe(sourceText);
      expect(
        (await listPipelinePackageInstalls(installs)).find(
          (install) => install.localPipelineId === copyId,
        ),
      ).toMatchObject({
        pipelineContentHash: hashPipelinePackageYaml(sourceText),
      });
    } finally {
      for (const id of [sourceId, ...created])
        await removePipelinePackageInstall(installs, id);
    }
  });

  it('refuses a resent copy of a package-installed workflow whose stored document is neither text the copy writes', async () => {
    const installs = getPipelinePackageInstallStorePath();
    const { sourceId, sourceText } = await packagedSource(
      'Golden packaged source other bytes',
      'pipeline:packaged-source-other-bytes',
    );
    try {
      const params = {
        sourceDefinitionId: sourceId,
        scope: {},
        _meta: { idempotencyKey: 'resent-packaged-copy-other-bytes' },
      };
      const metadata = { idempotencyKey: 'resent-packaged-copy-other-bytes' };
      const first = await writes({ loseReceipts: true }).instruction(
        'core.pipeline.definition.duplicate',
        params,
        { caller: writer, metadata },
      );
      const copyId = first.definition.definitionId;
      created.push(copyId);
      await removePipelinePackageInstall(installs, copyId);
      const documentPath = join(getUserPipelinesDir(), `${copyId}.yaml`);
      const other = `${sourceText}# edited\n`;
      writeFileSync(documentPath, other);
      await expect(
        writes().instruction('core.pipeline.definition.duplicate', params, {
          caller: writer,
          metadata,
        }),
      ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
      expect(readFileSync(documentPath, 'utf8')).toBe(other);
      expect(
        (await listPipelinePackageInstalls(installs)).some(
          (install) => install.localPipelineId === copyId,
        ),
      ).toBe(false);
    } finally {
      for (const id of [sourceId, ...created])
        await removePipelinePackageInstall(installs, id);
    }
  });

  // Finishing a resent copy and an edit of that copy take the same lock, so
  // the edit is never written over by the recovered bytes.
  it('keeps an edit made while a resent copy is being finished', async () => {
    const installs = getPipelinePackageInstallStorePath();
    const { sourceId } = await packagedSource(
      'Golden packaged source edited during recovery',
      'pipeline:packaged-source-edited',
    );
    const within = <T>(promise: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${label} did not settle`)),
            15_000,
          ),
        ),
      ]);
    const original = packageService.copyPackageInstall;
    let entered: () => void = () => undefined;
    const recovering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const params = {
      sourceDefinitionId: sourceId,
      scope: {},
      _meta: { idempotencyKey: 'resent-packaged-copy-edited' },
    };
    const metadata = { idempotencyKey: 'resent-packaged-copy-edited' };
    try {
      const first = await writes({ loseReceipts: true }).instruction(
        'core.pipeline.definition.duplicate',
        params,
        { caller: writer, metadata },
      );
      const copyId = first.definition.definitionId;
      created.push(copyId);
      await removePipelinePackageInstall(installs, copyId);
      const paused = jest
        .spyOn(packageService, 'copyPackageInstall')
        .mockImplementation(async (from, to) => {
          entered();
          await released;
          return original(from, to);
        });
      try {
        const resent = writes().instruction(
          'core.pipeline.definition.duplicate',
          params,
          { caller: writer, metadata },
        );
        await within(recovering, 'recovery');
        const editText = [
          'pipeline:',
          '  name: Golden edited during recovery',
          '  on:',
          '    dispatch: {}',
          '  jobs:',
          '    run:',
          '      steps:',
          '        - run: echo edited',
          '',
        ].join('\n');
        const edit = writes().instruction(
          'core.pipeline.definition.upsert',
          {
            definitionId: copyId,
            expectedRevision: first.definition.revision,
            scope: {},
            source: 'user' as const,
            name: 'Golden edited during recovery',
            description: '',
            icon: '',
            format: 'yaml' as const,
            document: editText,
            _meta: { idempotencyKey: 'edit-during-recovery' },
          },
          {
            caller: writer,
            metadata: { idempotencyKey: 'edit-during-recovery' },
          },
        );
        release();
        await within(resent, 'the resent copy');
        const edited = await within(edit, 'the edit');
        const read = await writes().query(
          'core.pipeline.definition.get',
          { definitionId: copyId, scope: {} },
          { caller: writer },
        );
        expect(getStoredPipelineText(copyId).data).toBe(editText);
        expect(read.definition.revision).toBe(edited.definition.revision);
        expect(read.definition.name).toBe('Golden edited during recovery');
      } finally {
        release();
        paused.mockRestore();
      }
    } finally {
      for (const id of [sourceId, ...created])
        await removePipelinePackageInstall(installs, id);
    }
  });

  // CAN-7590: a package-installed copy is recorded before it commits, and
  // commits the package's own bytes in one durable store write under the
  // cross-process writer lock, so nothing writes the copy after its commit.
  describe('a package-installed copy commits in one step (CAN-7590)', () => {
    const lockPath = (): string =>
      join(getCanopyDataDir(), 'locks', 'pipeline-definitions', 'writer.lock');
    const recordsOf = async (
      id: string,
    ): ReturnType<typeof listPipelinePackageInstalls> =>
      (
        await listPipelinePackageInstalls(getPipelinePackageInstallStorePath())
      ).filter((install) => install.localPipelineId === id);
    const copyOf = (
      sourceId: string,
      idempotencyKey: string,
      { loseReceipts = false } = {},
    ): Promise<PipelineDefinitionDuplicateResult> =>
      writes({ loseReceipts }).instruction(
        'core.pipeline.definition.duplicate',
        { sourceDefinitionId: sourceId, scope: {}, _meta: { idempotencyKey } },
        { caller: writer, metadata: { idempotencyKey } },
      );
    /** Every durable write of a user document, and whether the lock was held. */
    function documentWrites(): {
      file: string;
      data: string;
      locked: boolean;
    }[] {
      const real = atomicFile.writeFileAtomicallySync;
      const seen: { file: string; data: string; locked: boolean }[] = [];
      jest
        .spyOn(atomicFile, 'writeFileAtomicallySync')
        .mockImplementation((file, data, options) => {
          seen.push({
            file: String(file),
            data: String(data),
            locked: existsSync(lockPath()),
          });
          return real(file, data, options);
        });
      return seen;
    }
    // A copy an older build left at core's document with no install record.
    async function oldOrderCopy(
      name: string,
      idempotencyKey: string,
    ): Promise<{
      sourceId: string;
      sourceText: string;
      copyId: string;
      revision: number;
    }> {
      const sourceId = await world.saveUserPipeline(
        [
          'pipeline:',
          `  name: ${name}`,
          '  on: { dispatch: {} }',
          '  jobs:',
          '    run:',
          '      steps:',
          '        - run: echo packaged',
          '',
        ].join('\n'),
        `pipeline:${name.toLowerCase().replaceAll(' ', '-')}`,
      );
      created.push(sourceId);
      const first = await copyOf(sourceId, idempotencyKey, {
        loseReceipts: true,
      });
      const copyId = first.definition.definitionId;
      created.push(copyId);
      const sourceText = getStoredPipelineText(sourceId).data ?? '';
      await upsertPipelinePackageInstall(getPipelinePackageInstallStorePath(), {
        localPipelineId: sourceId,
        originExternalId: 'golden-packaged-remote',
        pipelineContentHash: hashPipelinePackageYaml(sourceText),
        distributionMode: 'package',
        packageDigest: `pp:v1:${'a'.repeat(43)}`,
        installedAt: new Date().toISOString(),
      });
      expect(getStoredPipelineText(copyId).data).not.toBe(sourceText);
      return {
        sourceId,
        sourceText,
        copyId,
        revision: first.definition.revision,
      };
    }
    afterEach(async () => {
      jest.restoreAllMocks();
      for (const id of created)
        await removePipelinePackageInstall(
          getPipelinePackageInstallStorePath(),
          id,
        );
    });

    it('records the copy before it commits, then commits the package bytes once, durably and under the writer lock', async () => {
      const { sourceId, sourceText } = await packagedSource(
        'Golden packaged source single step',
        'pipeline:packaged-source-single-step',
      );
      const before = userIds();
      const original = packageService.copyPackageInstall;
      let entered: () => void = () => undefined;
      const recording = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest
        .spyOn(packageService, 'copyPackageInstall')
        .mockImplementationOnce(async (from, to) => {
          entered();
          await released;
          return original(from, to);
        });
      const seen = documentWrites();
      const pending = copyOf(sourceId, 'single-step-copy');
      await recording;
      // Paused while its record is written, there is no copy for a crash to
      // leave behind, or for another process to edit.
      expect(userIds()).toEqual(before);
      release();
      const copied = await pending;
      const copyId = copied.definition.definitionId;
      created.push(copyId);
      expect(
        seen
          .filter((write) => write.file.endsWith(`/${copyId}.yaml`))
          .map(({ data, locked }) => ({ data, locked })),
      ).toEqual([{ data: sourceText, locked: true }]);
      expect(getStoredPipelineText(copyId).data).toBe(sourceText);
      expect(copied.definition.document).toBe(sourceText);
      expect(await recordsOf(copyId)).toEqual([
        expect.objectContaining({
          pipelineContentHash: hashPipelinePackageYaml(sourceText),
        }),
      ]);
    });

    it('completes a copy abandoned after its install record and before its commit when resent with the same key', async () => {
      const { sourceId, sourceText } = await packagedSource(
        'Golden packaged source abandoned',
        'pipeline:packaged-source-abandoned',
      );
      const before = userIds();
      const installs = getPipelinePackageInstallStorePath();
      let atCommit: { id: string; installs: string } | undefined;
      const commit = jest
        .spyOn(pipelineDefinitionStore, 'writeStoredPipeline')
        .mockImplementationOnce((_input, options) => {
          atCommit = {
            id: options?.createId ?? '',
            installs: readFileSync(installs, 'utf8'),
          };
          throw new Error('the process ended before the commit');
        });
      await expect(
        copyOf(sourceId, 'abandoned-copy', { loseReceipts: true }),
      ).rejects.toBeDefined();
      // The crash landed once, on the copy's own commit,
      expect(commit).toHaveBeenCalledTimes(1);
      const copyId = atCommit?.id ?? '';
      expect(copyId).toMatch(/\S/);
      expect(copyId).not.toBe(sourceId);
      expect(commit.mock.calls[0]?.[1]?.createId).toBe(copyId);
      // after its install record,
      expect(atCommit?.installs).toMatch(
        new RegExp(`"localPipelineId"\\s*:\\s*"${copyId}"`),
      );
      created.push(copyId);
      // A crash runs no rollback: the install store is left as the commit
      // found it, holding the copy's record.
      writeFileSync(installs, atCommit?.installs ?? '');
      expect(userIds()).toEqual(before);
      // and before it: the copy has no document yet.
      expect(getStoredPipelineText(copyId).data).toBeUndefined();
      expect(await recordsOf(copyId)).toHaveLength(1);
      const resent = await copyOf(sourceId, 'abandoned-copy');
      expect(resent.definition.definitionId).toBe(copyId);
      expect(getStoredPipelineText(copyId).data).toBe(sourceText);
      expect(await recordsOf(copyId)).toHaveLength(1);
      expect(userIds()).toHaveLength(before.length + 1);
    });

    it('finishes a copy an older build left without its package bytes by rewriting it through the store, then recording it', async () => {
      const { sourceId, sourceText, copyId, revision } = await oldOrderCopy(
        'Golden packaged source old order',
        'old-order-copy',
      );
      const seen = documentWrites();
      const resent = await copyOf(sourceId, 'old-order-copy');
      expect(resent.definition.definitionId).toBe(copyId);
      expect(
        seen
          .filter((write) => write.file.endsWith(`/${copyId}.yaml`))
          .map(({ data, locked }) => ({ data, locked })),
      ).toEqual([{ data: sourceText, locked: true }]);
      expect(resent.definition.revision).toBeGreaterThan(revision);
      expect(getStoredPipelineText(copyId).data).toBe(sourceText);
      expect(await recordsOf(copyId)).toHaveLength(1);
    });

    it('refuses to finish such a copy when another process edits it during the repair, keeping the edit', async () => {
      const { sourceId, copyId } = await oldOrderCopy(
        'Golden packaged source edited elsewhere',
        'old-order-copy-edited',
      );
      const real = pipelineDefinitionStore.writeStoredPipeline;
      let editText: string | undefined;
      // Another process commits an edit after the repair read the copy and
      // before its write, as the CLI can under the same lock.
      const repair = jest
        .spyOn(pipelineDefinitionStore, 'writeStoredPipeline')
        .mockImplementationOnce((input, options) => {
          const edited = updateStoredPipeline(copyId, {
            name: 'Golden edited elsewhere',
            description: '',
            icon: '',
            content: {
              name: 'Golden edited elsewhere',
              on: { dispatch: {} },
              jobs: { run: { steps: [{ id: 'echo', run: 'echo elsewhere' }] } },
            },
          });
          expect(edited.success).toBe(true);
          editText = getStoredPipelineText(copyId).data;
          return real(input, options);
        });
      await expect(
        copyOf(sourceId, 'old-order-copy-edited'),
      ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
      // The edit landed once, on the repair's own write of the copy.
      expect(repair).toHaveBeenCalledTimes(1);
      expect(repair.mock.calls[0]?.[0]?.id).toBe(copyId);
      expect(repair.mock.calls[0]?.[1]?.requireExisting).toBe(true);
      expect(editText).toBeDefined();
      expect(getStoredPipelineText(copyId).data).toBe(editText);
      // The record written before the repair doesn't pin the edit, so
      // execution drops it.
      expect(await pins(copyId)).not.toBe('pins');
    });

    /** Whether the copy's record, if any, pins the bytes it holds. */
    async function pins(
      copyId: string,
    ): Promise<'no record' | 'pins' | 'mismatch'> {
      const [record] = await recordsOf(copyId);
      if (!record) return 'no record';
      return record.pipelineContentHash ===
        hashPipelinePackageYaml(getStoredPipelineText(copyId).data ?? '')
        ? 'pins'
        : 'mismatch';
    }
    /** The package moves on: new source bytes, and a record pinning them. */
    async function updateSourcePackage(
      sourceId: string,
      run: string,
    ): Promise<string> {
      const edited = updateStoredPipeline(sourceId, {
        name: 'Golden updated source',
        description: '',
        icon: '',
        content: {
          name: 'Golden updated source',
          on: { dispatch: {} },
          jobs: { run: { steps: [{ id: 'echo', run }] } },
        },
      });
      expect(edited.success).toBe(true);
      const sourceText = getStoredPipelineText(sourceId).data ?? '';
      await upsertPipelinePackageInstall(getPipelinePackageInstallStorePath(), {
        localPipelineId: sourceId,
        originExternalId: 'golden-packaged-remote',
        pipelineContentHash: hashPipelinePackageYaml(sourceText),
        distributionMode: 'package',
        packageDigest: `pp:v1:${'a'.repeat(43)}`,
        installedAt: new Date().toISOString(),
      });
      return sourceText;
    }
    const outcomeOf = (request: Promise<unknown>): Promise<unknown> =>
      request.then(
        (result) => result,
        (error: unknown) => error,
      );
    const RETRYABLE = {
      payload: { kind: 'unavailable', retry: { kind: 'same_idempotency_key' } },
    };

    // The repair records the copy first, then writes the bytes that record
    // pins, so a package update anywhere in it never leaves a copy whose
    // record and bytes disagree once it answers.
    it('finishes consistently when the package updates while the copy is recorded', async () => {
      const { sourceId, copyId } = await oldOrderCopy(
        'Golden packaged source updated while recorded',
        'old-order-copy-updated',
      );
      const original = packageService.copyPackageInstall;
      let updated = '';
      jest
        .spyOn(packageService, 'copyPackageInstall')
        .mockImplementationOnce(async (from, to) => {
          updated = await updateSourcePackage(sourceId, 'echo updated');
          return original(from, to);
        });
      await expect(
        copyOf(sourceId, 'old-order-copy-updated'),
      ).resolves.toMatchObject({ definition: { definitionId: copyId } });
      expect(getStoredPipelineText(copyId).data).toBe(updated);
      expect(await pins(copyId)).toBe('pins');
      await expect(
        copyOf(sourceId, 'old-order-copy-updated'),
      ).resolves.toMatchObject({ definition: { definitionId: copyId } });
      expect(await pins(copyId)).toBe('pins');
    });

    it('repairs a copy a crash left recorded but holding core’s document', async () => {
      const { sourceId, copyId } = await oldOrderCopy(
        'Golden packaged source crashed while repaired',
        'old-order-copy-crashed',
      );
      const sourceText = getStoredPipelineText(sourceId).data ?? '';
      // The record is written and the process ends before the bytes.
      await packageService.copyPackageInstall(sourceId, copyId);
      expect(await pins(copyId)).toBe('mismatch');
      await expect(
        copyOf(sourceId, 'old-order-copy-crashed'),
      ).resolves.toMatchObject({ definition: { definitionId: copyId } });
      expect(getStoredPipelineText(copyId).data).toBe(sourceText);
      expect(await pins(copyId)).toBe('pins');
    });

    it('refuses a repair whose write fails after the record, and the next resend repairs it', async () => {
      const { sourceId, copyId } = await oldOrderCopy(
        'Golden packaged source failed while repaired',
        'old-order-copy-failed',
      );
      const sourceText = getStoredPipelineText(sourceId).data ?? '';
      const repair = jest
        .spyOn(pipelineDefinitionStore, 'writeStoredPipeline')
        .mockImplementationOnce(() => {
          throw new Error('The disk is full.');
        });
      await expect(
        copyOf(sourceId, 'old-order-copy-failed'),
      ).rejects.toBeDefined();
      // The failure landed once, on the repair's own write of the copy.
      expect(repair).toHaveBeenCalledTimes(1);
      expect(repair.mock.calls[0]?.[0]?.id).toBe(copyId);
      expect(repair.mock.calls[0]?.[1]?.requireExisting).toBe(true);
      expect(await pins(copyId)).toBe('mismatch');
      jest.restoreAllMocks();
      await expect(
        copyOf(sourceId, 'old-order-copy-failed'),
      ).resolves.toMatchObject({ definition: { definitionId: copyId } });
      expect(getStoredPipelineText(copyId).data).toBe(sourceText);
      expect(await pins(copyId)).toBe('pins');
    });

    it('takes back the record when the package moves after the copy is recorded, leaving a plain copy', async () => {
      const { sourceId, copyId } = await oldOrderCopy(
        'Golden packaged source moving',
        'old-order-copy-moving',
      );
      const serialized = getStoredPipelineText(copyId).data;
      const original = packageService.copyPackageInstall;
      // The package moves after the copy is recorded, before its bytes.
      jest
        .spyOn(packageService, 'copyPackageInstall')
        .mockImplementationOnce(async (from, to) => {
          await original(from, to);
          await updateSourcePackage(sourceId, 'echo second');
        });
      await expect(
        outcomeOf(copyOf(sourceId, 'old-order-copy-moving')),
      ).resolves.toMatchObject(RETRYABLE);
      expect(getStoredPipelineText(copyId).data).toBe(serialized);
      expect(await pins(copyId)).toBe('no record');
      jest.restoreAllMocks();
      // The source has changed since the copy, so a resend is refused as a
      // conflict, as before this change; the copy stays a plain copy.
      await updateSourcePackage(sourceId, 'echo third');
      await expect(
        copyOf(sourceId, 'old-order-copy-moving'),
      ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
      expect(getStoredPipelineText(copyId).data).toBe(serialized);
      expect(await pins(copyId)).toBe('no record');
    });

    it('still refuses when taking back the record fails, leaving a record execution drops', async () => {
      const { sourceId, copyId } = await oldOrderCopy(
        'Golden packaged source moving undo fails',
        'old-order-copy-undo-fails',
      );
      const serialized = getStoredPipelineText(copyId).data;
      const original = packageService.copyPackageInstall;
      jest
        .spyOn(packageService, 'copyPackageInstall')
        .mockImplementationOnce(async (from, to) => {
          await original(from, to);
          await updateSourcePackage(sourceId, 'echo moved');
        });
      jest
        .spyOn(packageService, 'removePackageInstall')
        .mockRejectedValueOnce(new Error('The install store is unavailable.'));
      await expect(
        outcomeOf(copyOf(sourceId, 'old-order-copy-undo-fails')),
      ).resolves.toMatchObject(RETRYABLE);
      // The record no longer pins the copy, so execution drops it.
      expect(getStoredPipelineText(copyId).data).toBe(serialized);
      expect(await pins(copyId)).toBe('mismatch');
    });

    // Execution removes an install record that doesn't match its document,
    // and can run while a copy is recorded but its bytes aren't in place: a
    // copy or repair whose record is gone once its bytes land is refused for
    // a retry, never answered.
    const racingRun = async (copyId: string): Promise<void> => {
      await packageService
        .resolveInstalledPipelinePackageForExecution(copyId)
        .catch(() => undefined);
    };
    /** Removes the copy's record once its package bytes are in place. */
    function removeRecordOnceBytesLand(copyId: string, bytes: string): void {
      const original = packageService.listPackageInstalls;
      let removed = false;
      jest
        .spyOn(packageService, 'listPackageInstalls')
        .mockImplementation(async () => {
          if (!removed && getStoredPipelineText(copyId).data === bytes) {
            removed = true;
            await packageService.removePackageInstall(copyId);
          }
          return original();
        });
    }

    it('refuses a repair whose record a run removes before its bytes, and the next resend finishes it', async () => {
      const { sourceId, sourceText, copyId } = await oldOrderCopy(
        'Golden packaged source run before bytes',
        'old-order-copy-run-before-bytes',
      );
      const original = packageService.copyPackageInstall;
      jest
        .spyOn(packageService, 'copyPackageInstall')
        .mockImplementationOnce(async (from, to) => {
          await original(from, to);
          await racingRun(to);
        });
      await expect(
        outcomeOf(copyOf(sourceId, 'old-order-copy-run-before-bytes')),
      ).resolves.toMatchObject(RETRYABLE);
      expect(await pins(copyId)).toBe('no record');
      jest.restoreAllMocks();
      await expect(
        copyOf(sourceId, 'old-order-copy-run-before-bytes'),
      ).resolves.toMatchObject({ definition: { definitionId: copyId } });
      expect(getStoredPipelineText(copyId).data).toBe(sourceText);
      expect(await pins(copyId)).toBe('pins');
    });

    it('refuses a repair whose record is removed as its bytes land, and the next resend records it without another write', async () => {
      const { sourceId, sourceText, copyId } = await oldOrderCopy(
        'Golden packaged source removed as bytes land',
        'old-order-copy-removed-as-bytes-land',
      );
      removeRecordOnceBytesLand(copyId, sourceText);
      await expect(
        outcomeOf(copyOf(sourceId, 'old-order-copy-removed-as-bytes-land')),
      ).resolves.toMatchObject(RETRYABLE);
      expect(getStoredPipelineText(copyId).data).toBe(sourceText);
      expect(await pins(copyId)).toBe('no record');
      jest.restoreAllMocks();
      const seen = documentWrites();
      await expect(
        copyOf(sourceId, 'old-order-copy-removed-as-bytes-land'),
      ).resolves.toMatchObject({ definition: { definitionId: copyId } });
      expect(
        seen.filter((write) => write.file.endsWith(`/${copyId}.yaml`)),
      ).toEqual([]);
      expect(await pins(copyId)).toBe('pins');
    });

    it('ends consistent after runs race two resends, with the last one writing nothing', async () => {
      const { sourceId, sourceText, copyId } = await oldOrderCopy(
        'Golden packaged source raced twice',
        'old-order-copy-raced-twice',
      );
      const original = packageService.copyPackageInstall;
      jest
        .spyOn(packageService, 'copyPackageInstall')
        .mockImplementationOnce(async (from, to) => {
          await original(from, to);
          await racingRun(to);
        });
      await expect(
        outcomeOf(copyOf(sourceId, 'old-order-copy-raced-twice')),
      ).resolves.toMatchObject(RETRYABLE);
      jest.restoreAllMocks();
      removeRecordOnceBytesLand(copyId, sourceText);
      await expect(
        outcomeOf(copyOf(sourceId, 'old-order-copy-raced-twice')),
      ).resolves.toMatchObject(RETRYABLE);
      jest.restoreAllMocks();
      const seen = documentWrites();
      await expect(
        copyOf(sourceId, 'old-order-copy-raced-twice'),
      ).resolves.toMatchObject({ definition: { definitionId: copyId } });
      expect(
        seen.filter((write) => write.file.endsWith(`/${copyId}.yaml`)),
      ).toEqual([]);
      expect(getStoredPipelineText(copyId).data).toBe(sourceText);
      expect(await pins(copyId)).toBe('pins');
    });

    it('rolls a copy back when a run removes its record before the commit, and a run during the rollback undoes none of it', async () => {
      const { sourceId, sourceText } = await packagedSource(
        'Golden packaged source run before commit',
        'pipeline:packaged-source-run-before-commit',
      );
      const before = userIds();
      const copyInstall = packageService.copyPackageInstall;
      const removeInstall = packageService.removePackageInstall;
      let copyId = '';
      jest
        .spyOn(packageService, 'copyPackageInstall')
        .mockImplementationOnce(async (from, to) => {
          copyId = to;
          await copyInstall(from, to);
          await racingRun(to);
        });
      jest
        .spyOn(packageService, 'removePackageInstall')
        .mockImplementationOnce(async (id) => {
          await Promise.all([racingRun(id), removeInstall(id)]);
        });
      await expect(
        outcomeOf(copyOf(sourceId, 'normal-copy-run-before-commit')),
      ).resolves.toMatchObject(RETRYABLE);
      expect(userIds()).toEqual(before);
      expect(await recordsOf(copyId)).toEqual([]);
      jest.restoreAllMocks();
      const copied = await copyOf(sourceId, 'normal-copy-run-before-commit');
      expect(copied.definition.definitionId).toBe(copyId);
      created.push(copyId);
      expect(getStoredPipelineText(copyId).data).toBe(sourceText);
      expect(await pins(copyId)).toBe('pins');
    });

    // After a copy completes, a resend is answered from its receipt. Once
    // that receipt is gone, a copy of a package revision that has since
    // moved on is refused as a conflict, as a normal copy is in that case.
    it('answers a resend after a finished repair from its receipt, and refuses one whose receipt is gone, as a normal copy is', async () => {
      const kept = await oldOrderCopy(
        'Golden packaged source repaired with receipt',
        'old-order-copy-receipt',
      );
      await copyOf(kept.sourceId, 'old-order-copy-receipt');
      const keptText = getStoredPipelineText(kept.copyId).data;
      await updateSourcePackage(kept.sourceId, 'echo moved');
      await expect(
        copyOf(kept.sourceId, 'old-order-copy-receipt'),
      ).resolves.toMatchObject({ definition: { definitionId: kept.copyId } });
      expect(getStoredPipelineText(kept.copyId).data).toBe(keptText);
      expect(await pins(kept.copyId)).toBe('pins');

      const lost = await oldOrderCopy(
        'Golden packaged source repaired without receipt',
        'old-order-copy-no-receipt',
      );
      await copyOf(lost.sourceId, 'old-order-copy-no-receipt', {
        loseReceipts: true,
      });
      const normal = await packagedSource(
        'Golden packaged source copied normally',
        'pipeline:packaged-source-copied-normally',
      );
      const copied = await copyOf(normal.sourceId, 'normal-copy-no-receipt', {
        loseReceipts: true,
      });
      created.push(copied.definition.definitionId);
      for (const [sourceId, key, copyId] of [
        [lost.sourceId, 'old-order-copy-no-receipt', lost.copyId],
        [
          normal.sourceId,
          'normal-copy-no-receipt',
          copied.definition.definitionId,
        ],
      ] as const) {
        const before = getStoredPipelineText(copyId).data;
        await updateSourcePackage(sourceId, 'echo moved');
        await expect(copyOf(sourceId, key)).rejects.toMatchObject({
          payload: { kind: 'conflict' },
        });
        expect(getStoredPipelineText(copyId).data).toBe(before);
        expect(await pins(copyId)).toBe('pins');
      }
    });
  });
});
