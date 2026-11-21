// CAN-4139: core pipeline definition reads on the desktop dispatcher match
// the legacy readers of every source in the CAN-5061 golden world.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  createCanopyDispatcher,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import {
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type PipelineDefinition,
  type PipelineDefinitionListResult,
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
import * as installContext from '../../pipelines/pipeline-install-context';
import * as sidebarItems from '../../lib/sidebar-items';
import * as normalizeModule from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { createCorePipelineDefinitionAdapter } from '../../canopy-runtime/core-pipeline-definition-adapter';
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
