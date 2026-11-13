import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mockMemberRepoDir = '';
let mockCoworkDir = '';
let mockWorkspaceType: 'single-repo' | 'workspace' = 'workspace';
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<unknown> =>
    Promise.resolve({
      items: [
        {
          id: 'ws',
          type: mockWorkspaceType,
          worktrees: [{ id: 'wt' }],
        },
      ],
    }),
}));
// The member checkout has no workspace record behind it; resource-context
// authorization is covered by the pipeline definition goldens.
jest.mock('../../pipelines/resource-lanes', () => ({
  ...jest.requireActual<object>('../../pipelines/resource-lanes'),
  pipelineResourceContextEnabled: (): boolean => false,
}));
jest.mock('../../lib/resolve-worktree', () => ({
  ...jest.requireActual<object>('../../lib/resolve-worktree'),
  resolveWorktreeCwd: (
    projectId: string,
    _worktreeId: string,
    repoId?: string,
  ): string => {
    if (projectId === 'cowork' && repoId === undefined) return mockCoworkDir;
    if (repoId !== 'member') throw new Error(`Unknown repository ${repoId}`);
    return mockMemberRepoDir;
  },
  resolveRegisteredChatWorktree: (
    projectId: string,
    worktreeId: string,
  ): { projectId: string; worktreeId: string } =>
    projectId === 'plan-explore-chat'
      ? { projectId: 'ws', worktreeId: 'wt' }
      : { projectId, worktreeId },
}));
let mockRuntime: unknown;
jest.mock('../desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): unknown => mockRuntime,
}));
jest.mock('../../lib/workspace-registry', () => ({
  ...jest.requireActual<object>('../../lib/workspace-registry'),
  isCoworkWorkspace: (id: string): boolean => id === 'cowork',
}));

import {
  createCanopyDispatcher,
  type CanopyDispatcher,
} from '@canopy/core-runtime';
import {
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  createCorePipelineDefinitionAdapter,
  desktopPipelineDefinitionHost,
} from '../core-pipeline-definition-adapter';
import {
  PIPELINE_DEFINITION_AGENT_CALLER,
  getPipelineDefinition,
  listPipelineDefinitions,
} from '../pipeline-definition-dispatch';
import { withAgentPlace, type AgentPlace } from '../agent-place';

jest.setTimeout(120_000);

const MEMBER_ID = 'project--member.yaml';
const MEMBER_YAML = [
  'pipeline:',
  "  name: 'Member workflow'",
  "  version: '1.0'",
  '  on:',
  '    dispatch: {}',
  '  jobs:',
  '    build:',
  '      steps:',
  '        - run: echo member',
  '',
].join('\n');

const caller = (
  interfaceKind: CanopyCallerDescriptor['interfaceKind'],
): CanopyCallerDescriptor => ({
  principalId:
    interfaceKind === 'mcp' ? 'desktop-agent-pipeline-yaml' : 'window',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind,
  grants: [PIPELINE_GRANTS.read],
});
const AGENT = caller('mcp');
const WINDOW = caller('desktop');
const memberScope = { workspaceId: 'ws', worktreeId: 'wt', repoId: 'member' };

function dispatcher(
  hidden: ReadonlySet<string> = new Set(),
): CanopyDispatcher<
  typeof PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  Record<never, never>,
  Record<never, never>
> {
  const adapter = createCorePipelineDefinitionAdapter(
    desktopPipelineDefinitionHost,
    (ids) => Promise.resolve(new Set(ids.filter((id) => hidden.has(id)))),
  );
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

const OWNER: AgentPlace = { workspaceId: 'owner-ws', worktreeId: 'owner-wt' };
const ELSEWHERE: AgentPlace = { workspaceId: 'ws', worktreeId: 'wt' };

/** `owned` is visible to agents only from the owning automation's place. */
function placeDispatcher(owned: string): ReturnType<typeof dispatcher> {
  const adapter = createCorePipelineDefinitionAdapter(
    desktopPipelineDefinitionHost,
    (ids, place) =>
      Promise.resolve(
        new Set(
          ids.filter(
            (id) =>
              id === owned &&
              !(
                place?.workspaceId === OWNER.workspaceId &&
                place.worktreeId === OWNER.worktreeId
              ),
          ),
        ),
      ),
  );
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

function workflowRepo(prefix: string, file: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, '.canopy', 'pipelines'), { recursive: true });
  writeFileSync(join(dir, '.canopy', 'pipelines', file), MEMBER_YAML);
  return dir;
}

beforeAll(() => {
  mockCoworkDir = workflowRepo('pipeline-cowork-', 'cowork.yaml');
  mockMemberRepoDir = mkdtempSync(join(tmpdir(), 'pipeline-member-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: mockMemberRepoDir });
  mkdirSync(join(mockMemberRepoDir, '.canopy', 'pipelines'), {
    recursive: true,
  });
  writeFileSync(
    join(mockMemberRepoDir, '.canopy', 'pipelines', 'member.yaml'),
    MEMBER_YAML,
  );
});
afterAll(() => {
  rmSync(mockCoworkDir, { recursive: true, force: true });
  rmSync(mockMemberRepoDir, { recursive: true, force: true });
});
beforeEach(() => {
  mockWorkspaceType = 'workspace';
});

describe('core.pipeline.definition.get for ReadPipelineYaml (CAN-5991)', () => {
  it('reads a project workflow from a multi-repo workspace’s member repository', async () => {
    const { definition } = await dispatcher().query(
      'core.pipeline.definition.get',
      { definitionId: MEMBER_ID, scope: memberScope },
      { caller: AGENT },
    );
    expect(definition).toMatchObject({
      definitionId: MEMBER_ID,
      source: 'project',
      name: 'Member workflow',
      document: MEMBER_YAML,
    });
  });

  it('refuses a member repository in a single-repository project', async () => {
    mockWorkspaceType = 'single-repo';
    await expect(
      dispatcher().query(
        'core.pipeline.definition.get',
        { definitionId: MEMBER_ID, scope: memberScope },
        { caller: AGENT },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.scopeInvalid' },
    });
  });

  it('answers an owned-hidden workflow as not found to an agent caller, and still serves the window', async () => {
    const hidden = new Set([MEMBER_ID]);
    await expect(
      dispatcher(hidden).query(
        'core.pipeline.definition.get',
        { definitionId: MEMBER_ID, scope: memberScope },
        { caller: AGENT },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.pipeline.definitionNotFound',
        message: `Workflow not found: ${MEMBER_ID}`,
      },
    });
    const listed = await dispatcher(hidden).query(
      'core.pipeline.definition.list',
      { scope: memberScope, sources: ['project'] },
      { caller: AGENT },
    );
    expect(listed.items.map((item) => item.definitionId)).not.toContain(
      MEMBER_ID,
    );

    const { definition } = await dispatcher(hidden).query(
      'core.pipeline.definition.get',
      { definitionId: MEMBER_ID, scope: memberScope },
      { caller: WINDOW },
    );
    expect(definition.definitionId).toBe(MEMBER_ID);
    const windowList = await dispatcher(hidden).query(
      'core.pipeline.definition.list',
      { scope: memberScope, sources: ['project'] },
      { caller: WINDOW },
    );
    expect(windowList.items.map((item) => item.definitionId)).toContain(
      MEMBER_ID,
    );
  });

  it('reads a Cowork project’s workflow from its root, as the agent tools did', async () => {
    const { definition } = await dispatcher().query(
      'core.pipeline.definition.get',
      {
        definitionId: 'project--cowork.yaml',
        scope: { workspaceId: 'cowork', worktreeId: 'cowork-chat' },
      },
      { caller: AGENT },
    );
    expect(definition).toMatchObject({
      definitionId: 'project--cowork.yaml',
      source: 'project',
    });
  });

  it('reads a project workflow from a registered chat scope through the worktree it borrows', async () => {
    const { definition } = await dispatcher().query(
      'core.pipeline.definition.get',
      {
        definitionId: MEMBER_ID,
        scope: {
          workspaceId: 'plan-explore-chat',
          worktreeId: 'plan-1',
          repoId: 'member',
        },
      },
      { caller: AGENT },
    );
    expect(definition.definitionId).toBe(MEMBER_ID);
  });

  it('checks the owned-workflow rule against main’s host-local place, never the read’s scope (CAN-6032)', async () => {
    const OWNED = 'bundled-refine-plan';
    const runtime = placeDispatcher(OWNED);
    const refusal = {
      payload: { code: 'core.pipeline.definitionNotFound' },
    };
    const get = (
      who: CanopyCallerDescriptor,
      scope: { workspaceId?: string; worktreeId?: string } = {},
    ): Promise<unknown> =>
      runtime.query(
        'core.pipeline.definition.get',
        { definitionId: OWNED, scope },
        { caller: who },
      );
    // A caller naming the owner's place in its own scope gains nothing.
    await expect(
      get(AGENT, {
        workspaceId: OWNER.workspaceId,
        worktreeId: OWNER.worktreeId,
      }),
    ).rejects.toMatchObject(refusal);
    await expect(get(AGENT)).rejects.toMatchObject(refusal);
    // Main's place reaches the rule only through its in-process mark.
    await expect(
      withAgentPlace(AGENT, OWNER, () => get(AGENT)),
    ).resolves.toMatchObject({ definition: { definitionId: OWNED } });
    await expect(
      withAgentPlace(AGENT, ELSEWHERE, () => get(AGENT)),
    ).rejects.toMatchObject(refusal);
    // The mark covers one dispatch for its own caller only.
    await withAgentPlace(PIPELINE_DEFINITION_AGENT_CALLER, OWNER, async () => {
      await expect(get(AGENT)).rejects.toMatchObject(refusal);
      await expect(
        get(PIPELINE_DEFINITION_AGENT_CALLER),
      ).resolves.toMatchObject({ definition: { definitionId: OWNED } });
      await expect(get(PIPELINE_DEFINITION_AGENT_CALLER)).rejects.toMatchObject(
        refusal,
      );
    });
    // Main's shared caller no longer reads owned workflows without a place.
    mockRuntime = runtime;
    await expect(
      getPipelineDefinition(OWNED, {}, PIPELINE_DEFINITION_AGENT_CALLER),
    ).rejects.toMatchObject(refusal);
  });

  // Each former self-filtering caller sends the same scope as before, so its
  // source rows are unchanged; the rule now hides from its place what the
  // caller hid itself before (CAN-6032).
  it.each([
    [
      'worktree pipeline actions (listing and reads, no scope)',
      { sources: ['bundled' as const] },
      {},
    ],
    [
      'resource actions in a worktree or Cowork chat (workspace scope)',
      { sources: ['bundled' as const], scope: { workspaceId: 'ws' } },
      { workspaceId: 'ws' },
    ],
    [
      'App Advisor resource actions (empty scope)',
      { sources: ['bundled' as const], scope: {} },
      {},
    ],
  ])(
    'returns the rows %s saw before, from its own place',
    async (_caller, listParams, readScope) => {
      const OWNED = 'bundled-refine-plan';
      const runtime = placeDispatcher(OWNED);
      mockRuntime = runtime;
      const unfiltered = await runtime.query(
        'core.pipeline.definition.list',
        { ...listParams },
        { caller: WINDOW },
      );
      for (const place of [OWNER, ELSEWHERE]) {
        const before = unfiltered.items
          .map((item) => item.definitionId)
          .filter((id) => !(id === OWNED && place !== OWNER));
        const after = await listPipelineDefinitions(
          listParams,
          PIPELINE_DEFINITION_AGENT_CALLER,
          place,
        );
        expect(after.items.map((item) => item.definitionId)).toEqual(before);
        const read = getPipelineDefinition(
          OWNED,
          readScope,
          PIPELINE_DEFINITION_AGENT_CALLER,
          place,
        );
        if (place === OWNER)
          await expect(read).resolves.toMatchObject({ definitionId: OWNED });
        else
          await expect(read).rejects.toMatchObject({
            payload: { code: 'core.pipeline.definitionNotFound' },
          });
      }
    },
  );
});
