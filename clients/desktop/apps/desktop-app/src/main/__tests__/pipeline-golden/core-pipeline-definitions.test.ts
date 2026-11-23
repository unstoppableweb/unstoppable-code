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
} from '@canopy/execution-engine/pipelines/store';
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

  // The copy installs the package's bytes, then records the package install:
  // a crash between the two leaves the copy without its record.
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

  // The copy saves core's own document first and puts the package's bytes in
  // place after it: a crash between the two leaves core's document.
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
});
