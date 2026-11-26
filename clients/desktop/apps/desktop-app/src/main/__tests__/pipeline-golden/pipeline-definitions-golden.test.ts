// CAN-5061 golden: pipeline definition list, get and validate results and
// error shapes for every source kind (bundled, user, project, shared and
// curated), through desktop IPC and agent actions. Captured
// on unchanged code before CAN-4139 moves definitions to core ownership.
// Real data root, stores, Git checkout and cloud client; only IPC
// registration and `fetch` are replaced (see ./world.ts). Re-record
// deliberately with
// `pnpm test apps/desktop-app/src/main/__tests__/pipeline-golden -u`
// and review the snapshot diff as a behavior change.
import {
  GOLDEN_AGENT_INVALID_PIPELINE_YAML,
  GOLDEN_BUNDLED_PIPELINE_ID,
  GOLDEN_INVALID_PIPELINE_YAML,
  GOLDEN_NO_JOBS_YAML,
  GOLDEN_UNPARSEABLE_YAML,
  GOLDEN_USER_PIPELINE_YAML,
} from '@canopy/execution-engine/node/pipelines/__tests__/golden-fixtures';
import {
  deleteStoredPipeline,
  getStoredPipeline,
  getStoredPipelinePath,
  listStoredPipelines,
  saveStoredPipeline,
} from '@canopy/execution-engine/pipelines/store';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPipelinePackageYaml } from '@canopy/desktop-shared/node';
import { app } from 'electron';
import * as storeModule from '@canopy/execution-engine/pipelines/store';
import * as pipelineInstallContext from '../../pipelines/pipeline-install-context';
import * as resourceLanes from '../../pipelines/resource-lanes';
import { PIPELINE_GRANTS } from '@canopy/protocol/canopy-core';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
import type { ShareOperationResult } from '@canopy/protocol/sharing';
import { computePipelinePackageDigestSync } from '@canopy/execution-engine/node/pipelines/package-contract';
import { getFeatureFlagService } from '../../feature-flags';
import { readPreferencesFile } from '../../lib/preferences-store';
import {
  getTriggerInputDefs,
  setTriggerInputDefs,
  setTriggerTypes,
  type IPCResult,
  type PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import {
  personTakeoverHolds,
  readPipelineLocalMetadata,
  setUserPipelineAgentAuthorIfCurrent,
  setUserPipelineNativeGrant,
  setUserPipelineOwnerAutomation,
} from '../../pipelines/pipeline-local-metadata-store';
import {
  IPC_CHANNELS,
  type InstallAutomationPipelinesResponse,
  type ScheduledActivity,
} from '@canopy/desktop-shared/types';
import {
  scheduledUserPipelineId,
  scheduleRunAgentAuthor,
  schedulePersonTakeover,
  inheritedInstallOwner,
  scheduleInstall,
  targetsAgentHiddenPipeline,
} from '../../automations/workflow-schedules';
import {
  nativeGrantContentHash,
  resolvePipelineNativeGrant,
} from '../../automations/chat-automation-native-grant';
import { getAutomationsService } from '../../automations/service';
import { getStoredPipelineBySource } from '../../pipelines/pipeline-service';
import {
  findCapabilityPackageInstallByOwner,
  upsertCapabilityPackageInstall,
} from '../../pipelines/pipeline-package-install-store';
import {
  getPipelineAssetsDir,
  getPipelinePackageInstallStorePath,
} from '../../lib/paths';
import * as advisorAccess from '../../lib/app-advisor-project-agent-access';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { getTriggerTypes } from '@canopy/execution-engine/types/pipeline';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { AGENT_PIPELINE_NEW_CHAT_PLUGINS_POLICY_ERROR } from '@canopy/desktop-shared/lib/agent-pipeline-policy';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import {
  dispatchAgentAction,
  goldenWorktreeActionRuntime,
  invokeIpc,
  registerGoldenIpcHandler,
  type GoldenIpcHandler,
} from './harness';
import {
  createPipelineGoldenWorld,
  GOLDEN_AUTOMATION_ENTRY_KEY,
  GOLDEN_AUTOMATION_NOTES,
  GOLDEN_AUTOMATION_REVISED_NOTES,
  GOLDEN_AUTOMATION_SHARE_ID,
  GOLDEN_AUTOMATION_WORKER_KEY,
  type GoldenAutomationPackage,
  GOLDEN_CURATED_KEY,
  GOLDEN_CURATED_YAML,
  GOLDEN_PROJECT_PIPELINE_FILE,
  GOLDEN_PROJECT_PIPELINE_ID,
  GOLDEN_PUBLIC_PACKAGE_SHARE_ID,
  GOLDEN_PUBLIC_SHARE_ID,
  GOLDEN_PUBLIC_UPDATED_YAML,
  GOLDEN_SHARED_DISPATCH_REMOTE_ID,
  GOLDEN_SHARED_DISPATCH_YAML,
  GOLDEN_SHARED_REMOTE_ID,
  GOLDEN_SHARED_YAML,
  GOLDEN_TEAM_SHARE_ID,
  GOLDEN_WORKSPACE_ID,
  GOLDEN_WORKTREE_ID,
  type GoldenWorld,
} from './world';

const mockRegisterIpcHandler = (
  channel: string,
  handler: GoldenIpcHandler,
): void => registerGoldenIpcHandler(channel, handler);
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: GoldenIpcHandler): void =>
    mockRegisterIpcHandler(channel, handler),
}));

jest.setTimeout(120_000);

let world: GoldenWorld;

let runtime: DesktopCanopyDispatcher;
let userData: jest.SpiedFunction<typeof app.getPath>;

beforeAll(async () => {
  world = await createPipelineGoldenWorld();
  // Write effects persist state under userData, which the Electron
  // mock otherwise resolves to the checkout.
  userData = jest.spyOn(app, 'getPath').mockReturnValue(world.root);
  // Definition writes reach core through the desktop dispatcher.
  runtime = createDesktopRuntime();
  setDesktopCanopyRuntime(runtime);
  const { registerPipelineHandlers } =
    await import('../../pipelines/pipeline-handlers');
  registerPipelineHandlers();
});

afterAll(async () => {
  setDesktopCanopyRuntime(null);
  await runtime.shutdown();
  userData.mockRestore();
  await world.dispose();
});

/** Run one call and pin its normalized result with the cloud requests it made. */
async function capture(call: () => Promise<unknown>): Promise<unknown> {
  world.cloudRequests.length = 0;
  let result: unknown;
  try {
    result = await call();
  } catch (error) {
    result = {
      thrown: error instanceof Error ? error.message : String(error),
    };
  }
  return world.normalize({
    result,
    cloudRequests: [...world.cloudRequests],
  });
}

async function captureAll(
  calls: Record<string, () => Promise<unknown>>,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  // Sequential: the cloud request log is shared.
  for (const [name, call] of Object.entries(calls))
    results[name] = await capture(call);
  return results;
}

const projectFile = (): string =>
  `${world.worktreePath}/.canopy/pipelines/${GOLDEN_PROJECT_PIPELINE_FILE}`;

describe('desktop IPC', () => {
  it('lists bundled, user and curated definitions and discovers project ones', async () => {
    expect(
      await captureAll({
        list: () => invokeIpc(PIPELINE_CHANNELS.LIST),
        discoverProject: () =>
          invokeIpc(PIPELINE_CHANNELS.DISCOVER_PROJECT, world.worktreePath),
        discoverRelativeCwd: () =>
          invokeIpc(PIPELINE_CHANNELS.DISCOVER_PROJECT, 'relative/path'),
        discoverMissingCwd: () =>
          invokeIpc(
            PIPELINE_CHANNELS.DISCOVER_PROJECT,
            `${world.root}/missing`,
          ),
        curatedList: () => invokeIpc(PIPELINE_CHANNELS.CURATED_LIST, {}),
        sharedList: () => invokeIpc(PIPELINE_CHANNELS.SHARED_LIST, {}),
        sharedListPlanReady: () =>
          invokeIpc(PIPELINE_CHANNELS.SHARED_LIST, {
            triggerType: 'plan_ready',
          }),
      }),
    ).toMatchSnapshot();
  });

  it('gets each source kind and refuses unknown ones', async () => {
    expect(
      await captureAll({
        userById: () => invokeIpc(PIPELINE_CHANNELS.GET, world.userPipelineId),
        userStored: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            source: 'user',
            id: world.userPipelineId,
          }),
        bundledById: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, GOLDEN_BUNDLED_PIPELINE_ID),
        bundledStored: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            source: 'bundled',
            id: GOLDEN_BUNDLED_PIPELINE_ID,
          }),
        bundledAsUser: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            source: 'user',
            id: GOLDEN_BUNDLED_PIPELINE_ID,
          }),
        project: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            id: GOLDEN_PROJECT_PIPELINE_ID,
            cwd: world.worktreePath,
            filePath: projectFile(),
          }),
        projectOutsideCheckout: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            id: GOLDEN_PROJECT_PIPELINE_ID,
            cwd: world.worktreePath,
            filePath: `${world.root}/resources/pipelines/golden-review.yaml`,
          }),
        shared: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            source: 'shared',
            remoteId: GOLDEN_SHARED_REMOTE_ID,
          }),
        sharedMissing: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, {
            source: 'shared',
            remoteId: 'shared-missing',
          }),
        sharedGet: () =>
          invokeIpc(PIPELINE_CHANNELS.SHARED_GET, {
            remoteId: GOLDEN_SHARED_REMOTE_ID,
          }),
        curated: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, `curated:${GOLDEN_CURATED_KEY}`),
        curatedMissing: () =>
          invokeIpc(PIPELINE_CHANNELS.GET, 'curated:missing-curated'),
        curatedGet: () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_GET, GOLDEN_CURATED_KEY),
        curatedGetMissing: () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_GET, 'missing-curated'),
        missing: () => invokeIpc(PIPELINE_CHANNELS.GET, 'missing-pipeline'),
        invalidLookup: () => invokeIpc(PIPELINE_CHANNELS.GET, { nope: true }),
      }),
    ).toMatchSnapshot();
  });

  it('refuses invalid definitions on save without persisting them', async () => {
    const save = (content: unknown): Promise<unknown> =>
      invokeIpc(PIPELINE_CHANNELS.SAVE, {
        name: 'Golden refused',
        description: '',
        icon: '',
        content,
      });
    expect(
      await captureAll({
        unknownDependency: () =>
          save(parsePipelineText(GOLDEN_INVALID_PIPELINE_YAML)),
        noJobs: () => save(parsePipelineText(GOLDEN_NO_JOBS_YAML)),
        notAPipeline: () => save({ name: 'x' }),
        listAfter: () => invokeIpc(PIPELINE_CHANNELS.LIST),
      }),
    ).toMatchSnapshot();
  });
});

describe('agent actions', () => {
  it('lists and gets each source kind and refuses invalid definitions', async () => {
    const runtime = goldenWorktreeActionRuntime(world.worktreePath);
    const directory = goldenWorktreeActionRuntime(world.worktreePath, {
      executionScope: 'directory',
    });
    const get = (pipelineId: string): Promise<unknown> =>
      dispatchAgentAction(
        { type: 'pipeline.get', pipelineId, includeYaml: true },
        runtime,
      );
    expect(
      await captureAll({
        list: () => dispatchAgentAction({ type: 'pipeline.list' }, runtime),
        listDirectory: () =>
          dispatchAgentAction({ type: 'pipeline.list' }, directory),
        listQuery: () =>
          dispatchAgentAction(
            { type: 'pipeline.list', query: 'golden user', limit: 1 },
            runtime,
          ),
        listPlanReady: () =>
          dispatchAgentAction(
            { type: 'pipeline.list', runModes: ['plan_ready'] },
            runtime,
          ),
        getUser: () => get(world.userPipelineId),
        getBundled: () => get(GOLDEN_BUNDLED_PIPELINE_ID),
        getProject: () => get(GOLDEN_PROJECT_PIPELINE_ID),
        getShared: () => get(`shared:canopy-cloud:${GOLDEN_SHARED_REMOTE_ID}`),
        getCurated: () => get(`curated:${GOLDEN_CURATED_KEY}`),
        getMissing: () => get('missing-pipeline'),
        createUnparseable: () =>
          dispatchAgentAction(
            {
              type: 'pipeline.create',
              rawYaml: GOLDEN_UNPARSEABLE_YAML,
            },
            runtime,
          ),
        createShellSteps: () =>
          dispatchAgentAction(
            {
              type: 'pipeline.create',
              rawYaml: GOLDEN_INVALID_PIPELINE_YAML,
            },
            runtime,
          ),
        createInvalid: () =>
          dispatchAgentAction(
            {
              type: 'pipeline.create',
              rawYaml: GOLDEN_AGENT_INVALID_PIPELINE_YAML,
            },
            runtime,
          ),
        createNoJobs: () =>
          dispatchAgentAction(
            { type: 'pipeline.create', rawYaml: GOLDEN_NO_JOBS_YAML },
            runtime,
          ),
        listAfter: () =>
          dispatchAgentAction(
            { type: 'pipeline.list', includeDisabled: true },
            runtime,
          ),
      }),
    ).toMatchSnapshot();
  });
});

// CAN-6065 follow-up: an agent's save of a step that starts a new chat with
// plugins is refused, as its runs would be; a person's save is not.
describe('agent saves of new-chat plugins', () => {
  const newChatYaml = (plugins: string): string =>
    [
      'pipeline:',
      '  name: Golden new chat plugins',
      '  on:',
      '    dispatch:',
      '      inputs:',
      '        project:',
      '          required: false',
      '  jobs:',
      '    send:',
      '      steps:',
      '        - uses: builtin/send-agent-message',
      '          with:',
      '            project_id: ${{ inputs.project }}',
      '            task_id: ${{ inputs.project }}',
      '            text: Hello',
      `            plugins: ${plugins}`,
      '',
    ].join('\n');
  const literalPlugins = newChatYaml(
    `'[{"marketplaceId":"golden","pluginName":"golden"}]'`,
  );
  const refusal = {
    isError: true,
    result: {
      ok: false,
      error: {
        code: 'validation_failed',
        message: AGENT_PIPELINE_NEW_CHAT_PLUGINS_POLICY_ERROR,
      },
    },
  };

  it('refuses literal plugins on agent writes, not on a person’s save', async () => {
    const runtime = goldenWorktreeActionRuntime(world.worktreePath);
    expect(
      await dispatchAgentAction(
        { type: 'pipeline.create', rawYaml: literalPlugins },
        runtime,
      ),
    ).toMatchObject(refusal);
    const saved = (await invokeIpc(PIPELINE_CHANNELS.SAVE, {
      name: 'Golden new chat plugins',
      description: '',
      icon: '',
      content: parsePipelineText(literalPlugins),
    })) as IPCResult<PipelineInfo>;
    expect(saved).toMatchObject({ success: true });
    const id = saved.data?.id ?? '';
    for (const action of [
      { type: 'pipeline.update', pipelineId: id, rawYaml: literalPlugins },
      { type: 'pipeline.duplicate', pipelineId: id },
    ] as const) {
      expect(await dispatchAgentAction(action, runtime)).toMatchObject(refusal);
    }
    // An expression is left to the run; a rename sends no definition.
    for (const action of [
      {
        type: 'pipeline.update',
        pipelineId: id,
        rawYaml: newChatYaml('${{ inputs.project }}'),
      },
      { type: 'pipeline.update', pipelineId: id, name: 'Agent rename' },
    ] as const) {
      expect(await dispatchAgentAction(action, runtime)).toMatchObject({
        isError: false,
      });
    }
    expect(await invokeIpc(PIPELINE_CHANNELS.DELETE, id)).toEqual({
      success: true,
    });
  });
});

// CAN-4139: every caller's writes reach core, which owns user revisions.
describe('core definition writes', () => {
  it("refuses an editor save over another writer's edit, then deletes with its effects", async () => {
    const runtime = goldenWorktreeActionRuntime(world.worktreePath);
    const content = parsePipelineText(GOLDEN_USER_PIPELINE_YAML);
    const save = (input: Record<string, unknown>): Promise<unknown> =>
      invokeIpc(PIPELINE_CHANNELS.SAVE, {
        name: 'Golden conflict',
        description: '',
        icon: '',
        content,
        ...input,
      });
    // Raw bytes the parsed content doesn't match are refused, as before.
    expect(
      await save({
        rawContent: GOLDEN_USER_PIPELINE_YAML.replace('Golden', 'Other'),
      }),
    ).toEqual({
      success: false,
      error: 'Raw pipeline document does not match parsed pipeline content.',
    });
    const created = (await save({})) as IPCResult<PipelineInfo>;
    const id = created.data?.id ?? '';
    expect(created.data).toMatchObject({ source: 'user', revision: 1 });
    expect(
      readPipelineLocalMetadata({ type: 'stored', source: 'user', value: id })
        .owner,
    ).toBe('personal');
    expect(
      await dispatchAgentAction(
        { type: 'pipeline.update', pipelineId: id, name: 'Agent edit' },
        runtime,
      ),
    ).toMatchObject({ isError: false });
    expect(
      await save({ id, expectedRevision: 1, name: 'Editor edit' }),
    ).toEqual({
      success: false,
      error: `Workflow changed since it was loaded: ${id}`,
    });
    expect(getStoredPipeline(id).data?.info).toMatchObject({
      name: 'Agent edit',
      revision: 2,
    });
    expect(
      await save({ id, expectedRevision: 2, name: 'Editor edit' }),
    ).toMatchObject({ success: true, data: { revision: 3 } });
    expect(await invokeIpc(PIPELINE_CHANNELS.DELETE, id)).toEqual({
      success: true,
    });
    expect(
      readPipelineLocalMetadata({ type: 'stored', source: 'user', value: id }),
    ).toEqual({});
    expect(await invokeIpc(PIPELINE_CHANNELS.DELETE, id)).toEqual({
      success: false,
      error: `Workflow not found: ${id}`,
    });
  });

  // CAN-5239: a stored user pipeline is dated by its first save on this host.
  it('dates a user definition by its first save, keeps that date on edits and lists it on its row only', async () => {
    const input = {
      name: 'Golden dated',
      description: '',
      icon: '',
      content: parsePipelineText(GOLDEN_USER_PIPELINE_YAML),
    };
    const before = Date.now();
    const created = (await invokeIpc(
      PIPELINE_CHANNELS.SAVE,
      input,
    )) as IPCResult<PipelineInfo>;
    const id = created.data?.id ?? '';
    const firstSaved = Date.parse(created.data?.createdAt ?? '');
    expect(firstSaved).toBeGreaterThanOrEqual(before);
    expect(firstSaved).toBeLessThanOrEqual(Date.now());
    // Stand in for a copy installed long ago, so a kept date is told apart
    // from the time of a later save.
    const installedAt = '2020-01-02T03:04:05.000Z';
    const indexPath = join(world.dataDir, 'pipelines', 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      pipelines: { id: string }[];
    };
    writeFileSync(
      indexPath,
      JSON.stringify(
        {
          ...index,
          pipelines: index.pipelines.map((entry) =>
            entry.id === id ? { ...entry, createdAt: installedAt } : entry,
          ),
        },
        null,
        2,
      ),
    );
    // An edit keeps the stored date; the one its caller sends is never read.
    expect(
      await invokeIpc(PIPELINE_CHANNELS.SAVE, {
        ...input,
        id,
        expectedRevision: 1,
        name: 'Golden dated edit',
        createdAt: '1999-01-01T00:00:00.000Z',
      }),
    ).toMatchObject({
      success: true,
      data: { revision: 2, createdAt: installedAt },
    });
    expect(getStoredPipeline(id).data?.info.createdAt).toBe(installedAt);
    // The Remote Control rows carry the date for stored user pipelines only.
    const { listPipelines } = await import('../../services/pipelines-service');
    const rows = await listPipelines({
      projectId: GOLDEN_WORKSPACE_ID,
      worktreeId: GOLDEN_WORKTREE_ID,
    });
    expect(rows.find((row) => row.pipelineId === id)).toMatchObject({
      origin: 'user',
      installedAt,
    });
    const others = rows.filter((row) => row.origin !== 'user');
    expect(others.map((row) => row.origin)).toEqual(
      expect.arrayContaining(['bundled', 'project']),
    );
    expect(others.filter((row) => row.installedAt !== undefined)).toEqual([]);
    // A removal ends the copy: the same id installed again is dated anew.
    expect(await invokeIpc(PIPELINE_CHANNELS.DELETE, id)).toEqual({
      success: true,
    });
    const reinstalled = saveStoredPipeline(input, { id });
    expect(
      Date.parse(reinstalled.data?.createdAt ?? ''),
    ).toBeGreaterThanOrEqual(before);
    expect(deleteStoredPipeline(id)).toEqual({ success: true });
  });
});

// CAN-5368: duplicates, enablement and replay go through core too.
// CAN-5782: a timed fire of a workflow-only definition needs a person's
// approval of its exact content. A person's save stamps it, an agent's
// write clears it, and Approve for schedules stamps the saved content only
// at the revision and digest the page shows.
describe('person approval for schedules', () => {
  it("stamps a person's save, clears on an agent's write and approves only the shown content", async () => {
    const runtime = goldenWorktreeActionRuntime(world.worktreePath);
    const metadata = (
      id: string,
    ): ReturnType<typeof readPipelineLocalMetadata> =>
      readPipelineLocalMetadata({ type: 'stored', source: 'user', value: id });
    const storedDigest = (id: string): string => {
      const stored = getStoredPipelineBySource('user', id);
      return nativeGrantContentHash(stored.data?.content);
    };
    const saved = (await invokeIpc(PIPELINE_CHANNELS.SAVE, {
      name: 'Golden approval',
      description: '',
      icon: '',
      content: parsePipelineText(GOLDEN_USER_PIPELINE_YAML),
    })) as IPCResult<PipelineInfo>;
    const id = saved.data?.id ?? '';
    expect(metadata(id).personApprovedDigest).toEqual({
      contentHash: storedDigest(id),
      revision: 1,
    });
    expect(
      await dispatchAgentAction(
        { type: 'pipeline.update', pipelineId: id, name: 'Agent approval' },
        runtime,
      ),
    ).toMatchObject({ isError: false });
    expect(metadata(id).agentAuthor).toBeDefined();
    expect(metadata(id).personApprovedDigest).toBeUndefined();
    const approve = (
      revision: number,
      contentDigest: string,
    ): Promise<unknown> =>
      invokeIpc(PIPELINE_CHANNELS.APPROVE_FOR_SCHEDULES, {
        pipelineId: id,
        revision,
        contentDigest,
        packageDigest: null,
      });
    expect(await approve(1, storedDigest(id))).toMatchObject({
      success: false,
      refusal: 'stale_revision',
    });
    expect(
      await approve(
        2,
        nativeGrantContentHash(parsePipelineText(GOLDEN_NO_JOBS_YAML)),
      ),
    ).toMatchObject({ success: false, refusal: 'content_mismatch' });
    expect(metadata(id).personApprovedDigest).toBeUndefined();
    expect(await approve(2, storedDigest(id))).toEqual({
      success: true,
      data: { contentHash: storedDigest(id), revision: 2 },
    });
    expect(metadata(id).personApprovedDigest).toEqual({
      contentHash: storedDigest(id),
      revision: 2,
    });
    // The person took the agent's content over, so it now counts as theirs.
    expect(metadata(id).agentAuthor).toBeUndefined();
    expect(await invokeIpc(PIPELINE_CHANNELS.DELETE, id)).toEqual({
      success: true,
    });
  });
});

describe('core definition copies, enablement and replay', () => {
  it('copies a bundled definition under an id core assigns, as a user definition', async () => {
    const before = new Set(
      (listStoredPipelines().data ?? []).map((info) => info.id),
    );
    const copied = (await invokeIpc(
      PIPELINE_CHANNELS.DUPLICATE,
      GOLDEN_BUNDLED_PIPELINE_ID,
    )) as IPCResult<PipelineInfo>;
    expect(copied).toMatchObject({
      success: true,
      data: { source: 'user', readonly: false, revision: 1 },
    });
    const id = copied.data?.id ?? '';
    expect(before.has(id)).toBe(false);
    const stored = getStoredPipeline(id).data;
    expect(stored?.info.name).toBe(`${stored?.content.name ?? ''}`);
    expect(stored?.info.name).toMatch(/ \(Copy\)$/);
    expect(stored?.content.readonly).toBeUndefined();
    expect(
      readPipelineLocalMetadata({ type: 'stored', source: 'user', value: id })
        .owner,
    ).toBe('personal');
    expect(await invokeIpc(PIPELINE_CHANNELS.DELETE, id)).toEqual({
      success: true,
    });
  });

  it("never copies an organization's project workflow out as Personal", async () => {
    const contexts = jest
      .spyOn(resourceLanes, 'pipelineResourceContextEnabled')
      .mockReturnValue(true);
    const owner = jest
      .spyOn(pipelineInstallContext, 'readProjectPipelineOwner')
      .mockResolvedValue({
        type: 'organization',
        id: 'org-golden',
        name: null,
      });
    const before = listStoredPipelines().data?.length;
    try {
      await expect(
        runtime.instruction(
          'core.pipeline.definition.duplicate',
          {
            sourceDefinitionId: GOLDEN_PROJECT_PIPELINE_ID,
            scope: {
              workspaceId: GOLDEN_WORKSPACE_ID,
              worktreeId: GOLDEN_WORKTREE_ID,
            },
            _meta: { idempotencyKey: 'golden-org-copy' },
          },
          {
            caller: {
              principalId: 'local-desktop-user',
              clientInstanceId: 'golden-org-copy',
              authorityId: 'local-desktop',
              interfaceKind: 'test',
              grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.write],
            },
            metadata: { idempotencyKey: 'golden-org-copy' },
          },
        ),
      ).rejects.toMatchObject({
        payload: { code: 'core.pipeline.contextMismatch' },
      });
      expect(listStoredPipelines().data?.length).toBe(before);
    } finally {
      owner.mockRestore();
      contexts.mockRestore();
    }
  });

  it('enables and disables read-only definitions through core', async () => {
    const runtime = goldenWorktreeActionRuntime(world.worktreePath);
    for (const pipelineId of [
      GOLDEN_BUNDLED_PIPELINE_ID,
      `curated:${GOLDEN_CURATED_KEY}`,
    ]) {
      expect(
        await dispatchAgentAction(
          { type: 'pipeline.set_enabled', pipelineId, enabled: false },
          runtime,
        ),
      ).toMatchObject({ isError: false });
      expect((await readPreferencesFile()).disabledPipelineIds).toContain(
        pipelineId,
      );
      await dispatchAgentAction(
        { type: 'pipeline.set_enabled', pipelineId, enabled: true },
        runtime,
      );
      expect((await readPreferencesFile()).disabledPipelineIds).not.toContain(
        pipelineId,
      );
    }
  });

  it('reads a bundled definition a user one shadows by its explicit source', async () => {
    const bundled = getStoredPipeline(GOLDEN_BUNDLED_PIPELINE_ID).data;
    expect(bundled?.info.source).toBe('bundled');
    const shadow = saveStoredPipeline(
      {
        name: 'Golden shadow',
        description: '',
        icon: '',
        content: parsePipelineText(GOLDEN_USER_PIPELINE_YAML),
      },
      { id: GOLDEN_BUNDLED_PIPELINE_ID },
    );
    expect(shadow).toMatchObject({
      success: true,
      data: { id: GOLDEN_BUNDLED_PIPELINE_ID },
    });
    try {
      expect(
        await invokeIpc(PIPELINE_CHANNELS.GET, {
          source: 'bundled',
          id: GOLDEN_BUNDLED_PIPELINE_ID,
        }),
      ).toMatchObject({
        success: true,
        data: { info: { source: 'bundled', name: bundled?.info.name } },
      });
      // An unreadable shadow never blocks the bundled read.
      const shadowFile = getStoredPipelinePath(GOLDEN_BUNDLED_PIPELINE_ID).data;
      if (shadowFile) rmSync(shadowFile);
      expect(
        await invokeIpc(PIPELINE_CHANNELS.GET, {
          source: 'bundled',
          id: GOLDEN_BUNDLED_PIPELINE_ID,
        }),
      ).toMatchObject({ success: true, data: { info: { source: 'bundled' } } });
    } finally {
      deleteStoredPipeline(GOLDEN_BUNDLED_PIPELINE_ID);
    }
  });

  it('answers a get with the revision of the document it read', async () => {
    const read = getStoredPipeline(world.userPipelineId).data;
    // A save landing between core's read and the row's index lookup.
    const index = jest
      .spyOn(storeModule, 'getStoredPipelineIndexEntry')
      .mockImplementation((id, source) => {
        index.mockRestore();
        const entry = storeModule.getStoredPipelineIndexEntry(id, source);
        return entry ? { ...entry, revision: (entry.revision ?? 0) + 1 } : null;
      });
    try {
      expect(
        await invokeIpc(PIPELINE_CHANNELS.GET, world.userPipelineId),
      ).toMatchObject({
        success: true,
        data: { info: { revision: read?.info.revision } },
      });
    } finally {
      index.mockRestore();
    }
  });

  it('replays a committed write for its key after a restart', async () => {
    const caller = {
      principalId: 'local-desktop-user',
      clientInstanceId: 'golden-replay',
      authorityId: 'local-desktop',
      interfaceKind: 'test' as const,
      grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.write],
    };
    const params = {
      definitionId: null,
      expectedRevision: null,
      scope: {},
      source: 'user' as const,
      name: 'Golden replay',
      format: 'yaml' as const,
      document: GOLDEN_USER_PIPELINE_YAML,
      _meta: { idempotencyKey: 'golden-replay-key' },
    };
    const upsert = (
      dispatcher: DesktopCanopyDispatcher,
    ): ReturnType<DesktopCanopyDispatcher['instruction']> =>
      dispatcher.instruction('core.pipeline.definition.upsert', params, {
        caller,
        metadata: { idempotencyKey: 'golden-replay-key' },
      });
    const first = await upsert(runtime);
    const count = listStoredPipelines().data?.length;
    const restarted = createDesktopRuntime();
    try {
      expect(await upsert(restarted)).toEqual(first);
      expect(listStoredPipelines().data?.length).toBe(count);
    } finally {
      await restarted.shutdown();
    }
  });
});

// CAN-5076: curated imports and share installs, captured on unchanged code
// before they move behind core definition ownership.
describe('installs from the curated catalog and shares', () => {
  const curatedHash = createHash('sha256')
    .update(GOLDEN_CURATED_YAML)
    .digest('hex');

  /** What an install left behind for one local id. */
  async function installedState(id: string): Promise<unknown> {
    const { flushSharedItemSubscriptions, readSharedItemSubscriptionLedger } =
      await import('../../canopy-cloud/shared-item-subscriptions');
    const { listPackageInstalls } =
      await import('../../pipelines/pipeline-package-service');
    await flushSharedItemSubscriptions();
    const stored = getStoredPipeline(id).data;
    return {
      info: stored?.info,
      text: readFileSync(getStoredPipelinePath(id).data ?? '', 'utf8'),
      owner: readPipelineLocalMetadata({
        type: 'stored',
        source: 'user',
        value: id,
      }).owner,
      context: await pipelineInstallContext
        .readStoredPipelineContext(id)
        .catch((error: unknown) => ({ thrown: String(error) })),
      subscriptions: (await readSharedItemSubscriptionLedger()).installs.filter(
        (install) => install.localIds.includes(id),
      ),
      packageInstalls: (await listPackageInstalls()).filter(
        (install) => install.localPipelineId === id,
      ),
    };
  }

  async function capturedInstall(
    install: () => Promise<unknown>,
    idOf: (result: unknown) => string | undefined,
    keep = false,
  ): Promise<unknown> {
    const before = new Set(
      (listStoredPipelines().data ?? []).map((info) => info.id),
    );
    let installedId: string | undefined;
    const result = await capture(async () => {
      const value = await install();
      installedId = idOf(value);
      return value;
    });
    const added = (listStoredPipelines().data ?? [])
      .map((info) => info.id)
      .filter((id) => !before.has(id));
    const state =
      installedId === undefined
        ? undefined
        : world.normalize(await installedState(installedId));
    if (!keep) for (const id of added) deleteStoredPipeline(id);
    return { result, added: added.length, state };
  }

  const ipcId = (value: unknown): string | undefined => {
    const result = value as IPCResult<PipelineInfo>;
    return result.success ? result.data?.id : undefined;
  };

  const packageShareId = (value: unknown): string | undefined => {
    const result = value as IPCResult<{ localPipelineId: string }>;
    return result.success ? result.data?.localPipelineId : undefined;
  };

  it('imports a curated revision as a user definition and refuses a stale one', async () => {
    expect({
      ipc: await capturedInstall(
        () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_IMPORT, {
            key: GOLDEN_CURATED_KEY,
            expectedContentHash: curatedHash,
          }),
        ipcId,
      ),
      ipcStale: await capturedInstall(
        () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_IMPORT, {
            key: GOLDEN_CURATED_KEY,
            expectedContentHash: '0'.repeat(64),
          }),
        ipcId,
      ),
      ipcMissing: await capturedInstall(
        () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_IMPORT, {
            key: 'missing-curated',
            expectedContentHash: curatedHash,
          }),
        ipcId,
      ),
      ipcInvalid: await capturedInstall(
        () =>
          invokeIpc(PIPELINE_CHANNELS.CURATED_IMPORT, {
            key: GOLDEN_CURATED_KEY,
          }),
        ipcId,
      ),
    }).toMatchSnapshot();
  });

  it('installs a share through pipelines:save with its provenance and refuses a missing one', async () => {
    const contexts = jest
      .spyOn(resourceLanes, 'pipelineResourceContextEnabled')
      .mockReturnValue(true);
    // The fields the share landing page sends: the reviewed snapshot's own.
    const save = (
      sourceRemoteId: string,
      yaml: string,
      id?: string,
    ): Promise<unknown> => {
      const content = parsePipelineText(yaml);
      return invokeIpc(PIPELINE_CHANNELS.SAVE, {
        ...(id === undefined ? {} : { id }),
        sourceRemoteId,
        name: content.name,
        description: content.description ?? '',
        icon: content.icon ?? '',
        content,
      });
    };
    try {
      const reinstallTarget = await world.saveUserPipeline(
        GOLDEN_USER_PIPELINE_YAML,
        'reinstall-target',
      );
      expect({
        install: await capturedInstall(
          () => save(GOLDEN_SHARED_REMOTE_ID, GOLDEN_SHARED_YAML),
          ipcId,
        ),
        missing: await capturedInstall(
          () => save('shared-missing', GOLDEN_SHARED_YAML),
          ipcId,
        ),
        reinstall: await capturedInstall(
          () =>
            save(
              GOLDEN_SHARED_DISPATCH_REMOTE_ID,
              GOLDEN_SHARED_DISPATCH_YAML,
              reinstallTarget,
            ),
          ipcId,
        ),
        reinstallUnknown: await capturedInstall(
          () =>
            save(
              GOLDEN_SHARED_REMOTE_ID,
              GOLDEN_SHARED_YAML,
              'missing-pipeline',
            ),
          ipcId,
        ),
      }).toMatchSnapshot();
      deleteStoredPipeline(reinstallTarget);
    } finally {
      contexts.mockRestore();
    }
  });

  it('installs public package shares through pipelines:install-package-share, and shares without resource contexts through pipelines:save', async () => {
    const installShare = (request: unknown): Promise<unknown> =>
      invokeIpc(PIPELINE_CHANNELS.INSTALL_PACKAGE_SHARE, request);
    const installedIds: string[] = [];
    const kept = async (install: () => Promise<unknown>): Promise<unknown> => {
      const captured = await capturedInstall(
        async () => {
          const result = await install();
          const id = packageShareId(result);
          if (id !== undefined && !installedIds.includes(id))
            installedIds.push(id);
          return result;
        },
        packageShareId,
        true,
      );
      return captured;
    };
    // The fields the share landing page sends: the reviewed snapshot's own.
    const saveShare = (sourceRemoteId: string): Promise<unknown> => {
      const content = parsePipelineText(GOLDEN_SHARED_YAML);
      return invokeIpc(PIPELINE_CHANNELS.SAVE, {
        sourceRemoteId,
        name: content.name,
        description: content.description ?? '',
        icon: content.icon ?? '',
        content,
      });
    };
    const firstPin = world.publicSharePin(GOLDEN_PUBLIC_SHARE_ID);
    const definitionOnly = {
      install: await kept(() => installShare(firstPin)),
      reinstall: await kept(() => installShare(firstPin)),
      stale: await kept(() =>
        installShare({
          ...firstPin,
          expectedPipelineContentHash: '0'.repeat(64),
        }),
      ),
      missing: await kept(() =>
        installShare({ ...firstPin, externalId: 'public-missing' }),
      ),
      update: await (async (): Promise<unknown> => {
        world.publishPublicShare(
          GOLDEN_PUBLIC_SHARE_ID,
          GOLDEN_PUBLIC_UPDATED_YAML,
        );
        return kept(() =>
          installShare(world.publicSharePin(GOLDEN_PUBLIC_SHARE_ID)),
        );
      })(),
    };
    const packagePin = world.publicSharePin(GOLDEN_PUBLIC_PACKAGE_SHARE_ID);
    const packaged = {
      install: await kept(() => installShare(packagePin)),
      reinstall: await kept(() => installShare(packagePin)),
      changedDigest: await kept(() =>
        installShare({
          ...packagePin,
          expectedPackageDigest: `pp:v1:${'A'.repeat(43)}`,
        }),
      ),
    };
    // A team share resolves through the scoped detail; this account has no
    // organization context to receipt it in, so the install is refused and
    // rolled back.
    const scopedRefused = await kept(() =>
      installShare({ ...firstPin, externalId: GOLDEN_TEAM_SHARE_ID }),
    );
    for (const id of installedIds.splice(0)) deleteStoredPipeline(id);
    const contexts = jest
      .spyOn(resourceLanes, 'pipelineResourceContextEnabled')
      .mockReturnValue(false);
    let withoutContexts: unknown;
    try {
      withoutContexts = {
        publicInstall: await kept(() =>
          installShare(world.publicSharePin(GOLDEN_PUBLIC_SHARE_ID)),
        ),
        packageInstall: await kept(() => installShare(packagePin)),
        save: await capturedInstall(
          () => saveShare(GOLDEN_SHARED_REMOTE_ID),
          ipcId,
        ),
        saveMissing: await capturedInstall(
          () => saveShare('shared-missing'),
          ipcId,
        ),
      };
    } finally {
      contexts.mockRestore();
      for (const id of installedIds.splice(0)) deleteStoredPipeline(id);
    }
    expect({
      definitionOnly,
      packaged,
      scopedRefused,
      withoutContexts,
    }).toMatchSnapshot();
  });

  it("installs an automation package's pipelines and files through Stage A, and keeps, updates or refuses them", async () => {
    const { installAutomationPipelines } =
      await import('../../pipelines/automation-pipeline-install');
    const { readPipelineAssetsManifest } =
      await import('../../pipelines/pipeline-asset-install');
    const { v1, v2, tampered } = world.automationPackages;
    const stageA = (
      automationPackage: GoldenAutomationPackage,
      existing?: Record<string, { id: string; hash: string }>,
    ): ReturnType<typeof installAutomationPipelines> =>
      installAutomationPipelines({
        remoteId: GOLDEN_AUTOMATION_SHARE_ID,
        packageRef: { version: 1, digest: automationPackage.digest },
        source: 'public',
        stage: 'pipelines',
        ...(existing
          ? {
              existingPipelines: Object.entries(existing).map(
                ([key, { id, hash }]) => ({
                  key,
                  localPipelineId: id,
                  expectedContentHash: hash,
                }),
              ),
            }
          : {}),
      });
    const ids: Record<string, string> = {};
    // Each call's result and cloud requests, then what every installed
    // pipeline holds after it, files included.
    const step = async (
      call: () => ReturnType<typeof installAutomationPipelines>,
    ): Promise<unknown> => {
      let response: Awaited<ReturnType<typeof call>> | undefined;
      const result = await capture(async () => {
        response = await call();
        return response;
      });
      for (const pipeline of response?.pipelines ?? []) {
        if (ids[pipeline.key] === undefined) {
          ids[pipeline.key] = pipeline.localPipelineId;
          world.replacements.push({
            value: pipeline.localPipelineId,
            token: `<${pipeline.key}>`,
          });
        }
      }
      const state: Record<string, unknown> = {};
      for (const [key, id] of Object.entries(ids))
        state[key] = {
          ...((await installedState(id)) as Record<string, unknown>),
          assets: await readPipelineAssetsManifest(id),
        };
      return { result, state: world.normalize(state) };
    };
    const installed = (
      automationPackage: GoldenAutomationPackage,
    ): Record<string, { id: string; hash: string }> => ({
      [GOLDEN_AUTOMATION_ENTRY_KEY]: {
        id: ids[GOLDEN_AUTOMATION_ENTRY_KEY] ?? '',
        hash:
          automationPackage.contentHashes[GOLDEN_AUTOMATION_ENTRY_KEY] ?? '',
      },
      [GOLDEN_AUTOMATION_WORKER_KEY]: {
        id: ids[GOLDEN_AUTOMATION_WORKER_KEY] ?? '',
        hash:
          automationPackage.contentHashes[GOLDEN_AUTOMATION_WORKER_KEY] ?? '',
      },
    });
    const before = (listStoredPipelines().data ?? []).length;
    const results = {
      install: await step(() => stageA(v1)),
      retry: await step(() => stageA(v1)),
      keep: await step(() => stageA(v1, installed(v1))),
      update: await step(() => stageA(v2, installed(v1))),
      editedRefused: await (async (): Promise<unknown> => {
        const entryId = ids[GOLDEN_AUTOMATION_ENTRY_KEY] ?? '';
        const edited = parsePipelineText(GOLDEN_USER_PIPELINE_YAML);
        saveStoredPipeline({
          id: entryId,
          name: edited.name,
          description: '',
          icon: '',
          content: edited,
        });
        return step(() => stageA(v1, installed(v2)));
      })(),
      tampered: await step(() => stageA(tampered)),
      missing: await step(() =>
        stageA({ digest: `pp:v1:${'A'.repeat(43)}`, contentHashes: {} }),
      ),
    };
    const added = (listStoredPipelines().data ?? []).length - before;
    for (const id of Object.values(ids)) deleteStoredPipeline(id);
    expect({ ...results, added }).toMatchSnapshot();
  });

  /** Stage A of a golden package, over the recorded pipelines when given. */
  async function automationStageA(
    automationPackage: GoldenAutomationPackage,
    existing?: {
      entry: string;
      worker: string;
      from: GoldenAutomationPackage;
    },
  ): Promise<InstallAutomationPipelinesResponse> {
    const { installAutomationPipelines } =
      await import('../../pipelines/automation-pipeline-install');
    return installAutomationPipelines({
      remoteId: GOLDEN_AUTOMATION_SHARE_ID,
      packageRef: { version: 1, digest: automationPackage.digest },
      source: 'public',
      stage: 'pipelines',
      ...(existing
        ? {
            existingPipelines: [
              {
                key: GOLDEN_AUTOMATION_ENTRY_KEY,
                localPipelineId: existing.entry,
                expectedContentHash:
                  existing.from.contentHashes[GOLDEN_AUTOMATION_ENTRY_KEY] ??
                  '',
              },
              {
                key: GOLDEN_AUTOMATION_WORKER_KEY,
                localPipelineId: existing.worker,
                expectedContentHash:
                  existing.from.contentHashes[GOLDEN_AUTOMATION_WORKER_KEY] ??
                  '',
              },
            ],
          }
        : {}),
    });
  }

  /** The local ids a Stage A install reported, by golden pipeline key. */
  const installedIds = (
    response: InstallAutomationPipelinesResponse,
  ): { entry: string; worker: string } => ({
    entry:
      response.pipelines.find(
        (pipeline) => pipeline.key === GOLDEN_AUTOMATION_ENTRY_KEY,
      )?.localPipelineId ?? '',
    worker:
      response.pipelines.find(
        (pipeline) => pipeline.key === GOLDEN_AUTOMATION_WORKER_KEY,
      )?.localPipelineId ?? '',
  });

  it('CAN-7336 a run that starts while an automation installs never sees the new workflow without its complete files', async () => {
    const { pipelineAssetEnvironment } =
      await import('../../pipelines/pipeline-asset-install');
    const { v1, v3 } = world.automationPackages;
    const stageA = automationStageA;
    const sha256 = (text: string): string =>
      createHash('sha256').update(text).digest('hex');
    // What a run that starts now loads: the stored entry workflow, and the
    // supporting file it reads from its asset folder.
    const runStart = (
      id: string,
      revisions: Record<string, GoldenAutomationPackage>,
    ): { workflow: string; notes: string } => {
      const text = storeModule.getStoredPipelineText(id);
      const hash =
        text.success && text.data !== undefined
          ? hashPipelinePackageYaml(text.data)
          : undefined;
      const workflow =
        hash === undefined
          ? 'absent'
          : (Object.entries(revisions).find(
              ([, revision]) =>
                revision.contentHashes[GOLDEN_AUTOMATION_ENTRY_KEY] === hash,
            )?.[0] ?? 'unknown');
      let notes = 'absent';
      try {
        const bytes = readFileSync(
          join(getPipelineAssetsDir(id), 'specialists', 'notes.md'),
          'utf8',
        );
        notes =
          sha256(bytes) === sha256(GOLDEN_AUTOMATION_NOTES)
            ? 'v1'
            : sha256(bytes) === sha256(GOLDEN_AUTOMATION_REVISED_NOTES)
              ? 'v3'
              : 'unknown';
      } catch {
        // Not written yet.
      }
      return { workflow, notes };
    };
    // Stage A installs each pipeline through core.pipeline.definition.import,
    // whose packaged remote writes the files and the document. A run starts
    // beside every file the install moves into place, through the gate every
    // run start passes first (CAN-7359): while the install is live it waits,
    // and it loads the workflow only once the gate lets it.
    const intents = await import('../../pipelines/pipeline-install-intents');
    const realMove = pipelineAssetEnvironment.moveAssetFile;
    const observed: Array<{ at: string; pending: boolean }> = [];
    const gated: Array<
      Promise<{ at: string; outcome: string; workflow: string; notes: string }>
    > = [];
    const gatedStart = async (at: string, id: string): Promise<void> => {
      let settled = false;
      gated.push(
        intents.whenPipelineDefinitionRecovered(id).then((outcome) => {
          settled = true;
          return { at, outcome, ...runStart(id, { v1, v3 }) };
        }),
      );
      for (let turn = 0; turn < 50 && !settled; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      observed.push({ at, pending: !settled });
    };
    const move = jest
      .spyOn(pipelineAssetEnvironment, 'moveAssetFile')
      .mockImplementation(async (id, from, to) => {
        await gatedStart('before move', id);
        await realMove(id, from, to);
        await gatedStart('after move', id);
      });
    const created: string[] = [];
    try {
      const { entry, worker } = installedIds(await stageA(v1));
      created.push(entry, worker);
      const createdStarts = observed.splice(0);
      const createdRuns = await Promise.all(gated.splice(0));
      const installedRun = runStart(entry, { v1, v3 });

      await stageA(v3, { entry, worker, from: v1 });
      const updateStarts = observed.splice(0);
      const updateRuns = await Promise.all(gated.splice(0));
      const updatedRun = runStart(entry, { v1, v3 });

      expect({
        // A start during the install waits for it, so no run sees the
        // workflow with only some of its files: not the new document
        // without its file, nor the old document with the new file.
        createdStarts,
        createdRuns,
        installedRun,
        updateMixed: updateRuns.filter(
          (run) => (run.workflow === 'v3') !== (run.notes === 'v3'),
        ),
        updateStarts,
        updateRuns,
        updatedRun,
      }).toEqual({
        createdStarts: [
          { at: 'before move', pending: true },
          { at: 'after move', pending: true },
        ],
        createdRuns: [
          { at: 'before move', outcome: 'ready', workflow: 'v1', notes: 'v1' },
          { at: 'after move', outcome: 'ready', workflow: 'v1', notes: 'v1' },
        ],
        installedRun: { workflow: 'v1', notes: 'v1' },
        updateMixed: [],
        updateStarts: [
          { at: 'before move', pending: true },
          { at: 'after move', pending: true },
        ],
        updateRuns: [
          { at: 'before move', outcome: 'ready', workflow: 'v3', notes: 'v3' },
          { at: 'after move', outcome: 'ready', workflow: 'v3', notes: 'v3' },
        ],
        updatedRun: { workflow: 'v3', notes: 'v3' },
      });
    } finally {
      move.mockRestore();
      for (const id of created) if (id) deleteStoredPipeline(id);
    }
  });

  it('CAN-7336 a kept workflow edited after Stage A planned is refused before any of its files change', async () => {
    const { readPipelineAssetsManifest } =
      await import('../../pipelines/pipeline-asset-install');
    const { v1, v4 } = world.automationPackages;
    const { entry, worker } = installedIds(await automationStageA(v1));
    const notesPath = join(
      getPipelineAssetsDir(entry),
      'specialists',
      'notes.md',
    );
    const before = {
      notes: readFileSync(notesPath, 'utf8'),
      assets: await readPipelineAssetsManifest(entry),
    };
    // v4 keeps both pipelines' YAML, so Stage A only links them, and replaces
    // the entry's file. The person edits the entry once Stage A has planned,
    // as core.pipeline.definition.import starts installing it.
    const edited = parsePipelineText(GOLDEN_USER_PIPELINE_YAML);
    let editedOnce = false;
    setDesktopCanopyRuntime(
      new Proxy(runtime, {
        get: (target, property, receiver): unknown => {
          const value: unknown = Reflect.get(target, property, receiver);
          if (property !== 'instruction' || typeof value !== 'function')
            return value;
          return (
            name: unknown,
            params: unknown,
            ...rest: unknown[]
          ): unknown => {
            if (
              !editedOnce &&
              name === 'core.pipeline.definition.import' &&
              typeof params === 'object' &&
              params !== null &&
              'definitionId' in params &&
              params.definitionId === entry
            ) {
              editedOnce = true;
              saveStoredPipeline({
                id: entry,
                name: edited.name,
                description: '',
                icon: '',
                content: edited,
              });
            }
            const result: unknown = Reflect.apply(value, target, [
              name,
              params,
              ...rest,
            ]);
            return result;
          };
        },
      }),
    );
    try {
      const refused = await automationStageA(v4, {
        entry,
        worker,
        from: v1,
      }).then(
        () => 'installed',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
      expect({
        editedOnce,
        refusedAsEdited: refused.includes(
          'could not be saved exactly as shared',
        ),
        notes: readFileSync(notesPath, 'utf8'),
        assets: await readPipelineAssetsManifest(entry),
      }).toEqual({
        editedOnce: true,
        refusedAsEdited: true,
        notes: before.notes,
        assets: before.assets,
      });
    } finally {
      setDesktopCanopyRuntime(runtime);
      for (const id of [entry, worker]) if (id) deleteStoredPipeline(id);
    }
  });

  it('CAN-7364 a kept workflow edited between the check and the file writes is refused with its files put back and no new state', async () => {
    const { pipelineAssetEnvironment, readPipelineAssetsManifest } =
      await import('../../pipelines/pipeline-asset-install');
    const { isPipelineDefinitionClaimed, pipelineDefinitionRecoveryRefusal } =
      await import('../../pipelines/pipeline-install-intents');
    const { v1, v4 } = world.automationPackages;
    const { entry, worker } = installedIds(await automationStageA(v1));
    const notesPath = join(
      getPipelineAssetsDir(entry),
      'specialists',
      'notes.md',
    );
    const before = {
      notes: readFileSync(notesPath, 'utf8'),
      assets: await readPipelineAssetsManifest(entry),
    };
    // v4 keeps both pipelines' YAML, so Stage A only links them and replaces
    // the entry's file. The person edits the entry after the install checked
    // it, as the install writes its first file.
    const edited = parsePipelineText(GOLDEN_USER_PIPELINE_YAML);
    let editedText: string | undefined;
    const realWrite = pipelineAssetEnvironment.writeAssetFile;
    const write = jest
      .spyOn(pipelineAssetEnvironment, 'writeAssetFile')
      .mockImplementation(async (id, relativePath, bytes, mode) => {
        if (id === entry && editedText === undefined) {
          saveStoredPipeline({
            id: entry,
            name: edited.name,
            description: '',
            icon: '',
            content: edited,
          });
          editedText = storeModule.getStoredPipelineText(entry).data;
        }
        await realWrite(id, relativePath, bytes, mode);
      });
    try {
      const refused = await automationStageA(v4, {
        entry,
        worker,
        from: v1,
      }).then(
        () => 'installed',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
      expect({
        edited: editedText !== undefined,
        refusedAsEdited: refused.includes(
          'could not be saved exactly as shared. Try installing again.',
        ),
        documentIsTheEdit:
          storeModule.getStoredPipelineText(entry).data === editedText,
        notes: readFileSync(notesPath, 'utf8'),
        assets: await readPipelineAssetsManifest(entry),
        claimed: isPipelineDefinitionClaimed(entry),
        refusal: await pipelineDefinitionRecoveryRefusal(entry),
      }).toEqual({
        edited: true,
        refusedAsEdited: true,
        documentIsTheEdit: true,
        notes: before.notes,
        assets: before.assets,
        claimed: false,
        refusal: null,
      });
    } finally {
      write.mockRestore();
      for (const id of [entry, worker]) if (id) deleteStoredPipeline(id);
    }
  });
});

describe('workflow trigger (CAN-5782)', () => {
  const WORKFLOW_ONLY_YAML = [
    'pipeline:',
    '  name: Golden workflow only',
    '  on:',
    '    workflow:',
    '      inputs:',
    '        topic:',
    '          type: string',
    '          default: news',
    '  jobs:',
    '    run:',
    '      steps:',
    '        - run: echo workflow',
    '',
  ].join('\n');
  const WORKFLOW_AND_DISPATCH_YAML = [
    'pipeline:',
    '  name: Golden workflow and dispatch',
    '  on:',
    '    dispatch: {}',
    '    workflow: {}',
    '  jobs:',
    '    run:',
    '      steps:',
    '        - run: echo both',
    '',
  ].join('\n');

  it('reads and lists a workflow pipeline', async () => {
    const save = (yaml: string): Promise<unknown> => {
      const content = parsePipelineText(yaml);
      return invokeIpc(PIPELINE_CHANNELS.SAVE, {
        name: content.name,
        description: '',
        icon: '',
        content,
      });
    };
    const ids: string[] = [];
    const saved = async (yaml: string): Promise<string> => {
      const result = await save(yaml);
      const id =
        typeof result === 'object' &&
        result !== null &&
        'data' in result &&
        typeof result.data === 'object' &&
        result.data !== null &&
        'id' in result.data &&
        typeof result.data.id === 'string'
          ? result.data.id
          : '';
      ids.push(id);
      return id;
    };
    const workflowOnlyId = await saved(WORKFLOW_ONLY_YAML);
    const mixedId = await saved(WORKFLOW_AND_DISPATCH_YAML);
    const rows = async (): Promise<unknown> => {
      const listed = await invokeIpc(PIPELINE_CHANNELS.LIST);
      const data =
        typeof listed === 'object' &&
        listed !== null &&
        'data' in listed &&
        Array.isArray(listed.data)
          ? listed.data
          : [];
      return data
        .filter(
          (row: PipelineInfo) =>
            row.id === workflowOnlyId || row.id === mixedId,
        )
        .map((row: PipelineInfo) => ({
          name: row.name,
          triggerTypes: row.triggerTypes,
        }));
    };
    // Warm the curated catalog cache, so the captured list makes the same
    // cloud requests whether this test runs alone or after the others.
    await invokeIpc(PIPELINE_CHANNELS.LIST);
    const content = parsePipelineText(WORKFLOW_ONLY_YAML);
    const withDispatch = setTriggerTypes(content.on, ['workflow', 'dispatch']);
    try {
      expect(
        await captureAll({
          list: rows,
          get: () => invokeIpc(PIPELINE_CHANNELS.GET, workflowOnlyId),
          // Shared like any other pipeline (CAN-5782 writer, phase 02): the
          // request is sent (the golden cloud answers writes with a 404).
          // Without resource contexts, so no context check is involved.
          shareCreate: async () => {
            const contexts = jest
              .spyOn(resourceLanes, 'pipelineResourceContextEnabled')
              .mockReturnValue(false);
            try {
              return await invokeIpc(PIPELINE_CHANNELS.SHARED_CREATE, {
                rawPipeline: WORKFLOW_AND_DISPATCH_YAML,
                shareScope: 'private',
              });
            } finally {
              contexts.mockRestore();
            }
          },
          // The share dialog's review no longer blocks a workflow pipeline:
          // it is ready to package, with no blocker.
          packagedShare: async () => {
            const contexts = jest
              .spyOn(resourceLanes, 'pipelineResourceContextEnabled')
              .mockReturnValue(false);
            try {
              const analysis = await invokeIpc(
                PIPELINE_CHANNELS.ANALYZE_PACKAGE,
                { rawPipeline: WORKFLOW_AND_DISPATCH_YAML },
              );
              const summary =
                typeof analysis === 'object' &&
                analysis !== null &&
                'data' in analysis &&
                typeof analysis.data === 'object' &&
                analysis.data !== null
                  ? analysis.data
                  : {};
              return {
                state: 'state' in summary ? summary.state : undefined,
                blockers:
                  'blockers' in summary && Array.isArray(summary.blockers)
                    ? summary.blockers.map((blocker: unknown) =>
                        typeof blocker === 'object' &&
                        blocker !== null &&
                        'code' in blocker
                          ? blocker.code
                          : blocker,
                      )
                    : [],
              };
            } finally {
              contexts.mockRestore();
            }
          },
          // The trigger setters keep the `workflow:` block and its inputs.
          setTriggerTypes: () => Promise.resolve(withDispatch),
          backToWorkflowOnly: () =>
            Promise.resolve(setTriggerTypes(withDispatch, ['workflow'])),
          setWorkflowInputs: () =>
            Promise.resolve(
              getTriggerInputDefs(
                setTriggerInputDefs(content.on, 'workflow', {
                  topic: { type: 'string', default: 'sports' },
                }),
                'workflow',
              ),
            ),
        }),
      ).toMatchSnapshot();
    } finally {
      for (const id of ids) if (id) deleteStoredPipeline(id);
    }
  });
});

describe('workflow schedules (CAN-5782)', () => {
  const SCHEDULED_YAML = [
    'pipeline:',
    '  name: Golden workflow page',
    '  scope: global',
    '  on:',
    '    dispatch:',
    '      inputs:',
    '        topic:',
    '          type: string',
    '  jobs:',
    '    run:',
    '      steps:',
    '        - run: echo scheduled',
    '',
  ].join('\n');
  const savedId = async (): Promise<string> => {
    const content = parsePipelineText(SCHEDULED_YAML);
    const result = await invokeIpc(PIPELINE_CHANNELS.SAVE, {
      name: content.name,
      description: '',
      icon: '',
      content,
    });
    return typeof result === 'object' &&
      result !== null &&
      'data' in result &&
      typeof result.data === 'object' &&
      result.data !== null &&
      'id' in result.data &&
      typeof result.data.id === 'string'
      ? result.data.id
      : '';
  };
  const schedule = (
    pipelineId: string,
    inputs: Record<string, string>,
  ): Record<string, unknown> => ({
    name: 'Golden schedule',
    schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
    action: {
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineId,
      pipelineSource: 'user',
      pipelineName: 'Golden workflow page',
      inputs,
    },
    // Off: the schedule never runs here, and turning it on is not under test.
    enabled: false,
    executionContext: 'personal',
  });
  const createdId = (response: unknown): string =>
    typeof response === 'object' &&
    response !== null &&
    'activity' in response &&
    typeof response.activity === 'object' &&
    response.activity !== null &&
    'id' in response.activity &&
    typeof response.activity.id === 'string'
      ? response.activity.id
      : '';
  const workflowPage = async (pipelineId: string): Promise<unknown> => {
    const listed = (await invokeIpc(PIPELINE_CHANNELS.LIST)) as IPCResult<
      PipelineInfo[]
    >;
    const rows = listed.success ? (listed.data ?? []) : [];
    return rows.find((row) => row.id === pipelineId)?.workflowPage ?? null;
  };

  beforeAll(async () => {
    const { registerAutomationsHandlers } =
      await import('../../ipc/automations');
    registerAutomationsHandlers({
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      // No schedule runs here, so nothing opens a window.
      openAppAdvisorWindow: () =>
        Promise.reject(new Error('No window in this golden.')),
      ensureAppAdvisorWindow: () =>
        Promise.reject(new Error('No window in this golden.')),
      sendAppAdvisorWindowCommand: () => undefined,
    });
  });

  it('keeps a pipeline its other schedules run and hides every Orchestrator schedule', async () => {
    const pipelineId = await savedId();
    const orchestratorId = await savedId();
    try {
      // A converted chat automation owns its pipeline (CAN-4551).
      const owner = createdId(
        await invokeIpc(
          IPC_CHANNELS.automationsCreate,
          schedule(pipelineId, { topic: 'first' }),
        ),
      );
      setUserPipelineOwnerAutomation(pipelineId, owner);
      const second = createdId(
        await invokeIpc(
          IPC_CHANNELS.automationsCreate,
          schedule(pipelineId, { topic: 'second' }),
        ),
      );
      const orchestratorOwner = createdId(
        await invokeIpc(
          IPC_CHANNELS.automationsCreate,
          schedule(orchestratorId, { bot_id: 'app_advisor', prompt: 'Hi' }),
        ),
      );
      setUserPipelineOwnerAutomation(orchestratorId, orchestratorOwner);
      // CAN-6065: an Orchestrator workflow takes a second schedule too.
      const orchestratorSecond = createdId(
        await invokeIpc(
          IPC_CHANNELS.automationsCreate,
          schedule(orchestratorId, { bot_id: 'app_advisor', prompt: 'Hi' }),
        ),
      );
      const orchestratorHidden = (): boolean =>
        readPipelineLocalMetadata({
          type: 'stored',
          source: 'user',
          value: orchestratorId,
        }).agentHidden === true;
      const secondRecord = async (): Promise<ScheduledActivity | null> => {
        const listed = (await invokeIpc(IPC_CHANNELS.automationsList)) as {
          activities?: ScheduledActivity[];
        };
        return (
          (listed.activities ?? []).find(
            (activity) => activity.id === orchestratorSecond,
          ) ?? null
        );
      };
      // Hidden from agents through the pipeline, not one owner record.
      const secondHidden = async (): Promise<boolean> => {
        const record = await secondRecord();
        return record !== null && targetsAgentHiddenPipeline(record);
      };
      // An agent denied the Orchestrator can't add a schedule to it by id.
      const deniedAgentSchedule = async (): Promise<unknown> => {
        const denied = jest
          .spyOn(advisorAccess, 'decideAppAdvisorAccessForCaller')
          .mockResolvedValue({
            allowed: false,
            reason: 'advisor_access_disabled',
          });
        try {
          const scheduled = schedule(orchestratorId, {
            bot_id: 'app_advisor',
            prompt: 'Hi',
          });
          const response = await dispatchAgentAction(
            {
              type: 'automation.create',
              input: {
                name: scheduled.name,
                schedule: scheduled.schedule,
                action: scheduled.action,
                enabled: false,
              },
            },
            goldenWorktreeActionRuntime(world.worktreePath),
          );
          return world.normalize(response);
        } finally {
          denied.mockRestore();
        }
      };
      expect({
        created: [owner, second, orchestratorOwner, orchestratorSecond].every(
          Boolean,
        ),
        sharedPage: await workflowPage(pipelineId),
        orchestratorPage: await workflowPage(orchestratorId),
        orchestratorHidden: orchestratorHidden(),
        orchestratorSecondHidden: await secondHidden(),
        deniedAgentSchedule: await deniedAgentSchedule(),
        schedulesAfterAgent: (
          (
            (await invokeIpc(IPC_CHANNELS.automationsList)) as {
              activities?: ScheduledActivity[];
            }
          ).activities ?? []
        ).filter(
          (activity) => scheduledUserPipelineId(activity) === orchestratorId,
        ).length,
        // Deleting the owner keeps the pipeline its other schedule runs.
        ownerDeleted: (
          (await invokeIpc(IPC_CHANNELS.automationsDelete, {
            id: owner,
          })) as { ok?: unknown }
        ).ok,
        keptAfterOwner: getStoredPipeline(pipelineId).success,
        markerAfterOwner:
          readPipelineLocalMetadata({
            type: 'stored',
            source: 'user',
            value: pipelineId,
          }).ownerAutomationId ?? null,
        // Remove on the last schedule may keep the workflow with its values.
        lastDeleted: (
          (await invokeIpc(IPC_CHANNELS.automationsDelete, {
            id: second,
            keepPipeline: true,
          })) as { ok?: unknown }
        ).ok,
        keptAfterLast: getStoredPipeline(pipelineId).success,
        emptyPage: await workflowPage(pipelineId),
        // Deleting the Orchestrator owner keeps every schedule left hidden.
        orchestratorOwnerDeleted: (
          (await invokeIpc(IPC_CHANNELS.automationsDelete, {
            id: orchestratorOwner,
          })) as { ok?: unknown }
        ).ok,
        orchestratorKeptAfterOwner: getStoredPipeline(orchestratorId).success,
        orchestratorHiddenAfterOwner: orchestratorHidden(),
        orchestratorSecondHiddenAfterOwner: await secondHidden(),
        // Delete on the workflow takes the pipeline along.
        orchestratorDeleted: (
          (await invokeIpc(IPC_CHANNELS.automationsDelete, {
            id: orchestratorSecond,
            workflow: true,
          })) as { ok?: unknown }
        ).ok,
        orchestratorKept: getStoredPipeline(orchestratorId).success,
      }).toEqual({
        created: true,
        sharedPage: {},
        orchestratorPage: {},
        orchestratorHidden: true,
        orchestratorSecondHidden: true,
        deniedAgentSchedule: {
          isError: true,
          result: {
            requestId: '',
            ok: false,
            error: {
              code: 'not_found',
              message: 'Pipeline <uuid> was not found.',
              retryable: false,
            },
          },
        },
        schedulesAfterAgent: 2,
        ownerDeleted: true,
        keptAfterOwner: true,
        markerAfterOwner: null,
        lastDeleted: true,
        keptAfterLast: true,
        emptyPage: {
          lastScheduleValues: {
            inputs: { topic: 'second' },
            target: { kind: 'global' },
          },
        },
        orchestratorOwnerDeleted: true,
        orchestratorKeptAfterOwner: true,
        orchestratorHiddenAfterOwner: true,
        orchestratorSecondHiddenAfterOwner: true,
        orchestratorDeleted: true,
        orchestratorKept: false,
      });
    } finally {
      for (const id of [pipelineId, orchestratorId])
        if (id && getStoredPipeline(id).success) deleteStoredPipeline(id);
    }
  });

  it('lets an agent-created and an installed workflow take more schedules, run each as the first, and keep them on Remove', async () => {
    const grantedId = await savedId();
    const installedId = await savedId();
    const author = {
      chat: {
        projectId: 'golden-agent-project',
        worktreeId: 'golden-agent-worktree',
        chatId: 'golden-agent-chat',
      },
      recordedAt: '2026-11-09T00:00:00.000Z',
    };
    const metadata = (
      pipelineId: string,
    ): ReturnType<typeof readPipelineLocalMetadata> =>
      readPipelineLocalMetadata({
        type: 'stored',
        source: 'user',
        value: pipelineId,
      });
    const listedSchedules = async (
      pipelineId: string,
    ): Promise<ScheduledActivity[]> =>
      (
        (
          (await invokeIpc(IPC_CHANNELS.automationsList)) as {
            activities?: ScheduledActivity[];
          }
        ).activities ?? []
      ).filter((activity) => scheduledUserPipelineId(activity) === pipelineId);
    // The grant a top-level run of the stored definition, started by
    // `automationId`, would get; only the executed snapshot is stood in.
    const granted = async (automationId: string): Promise<boolean> =>
      (await resolvePipelineNativeGrant(
        {
          executionId: 'golden-granted-run',
          pipelineId: grantedId,
          agentOrigin: author.chat,
          initiator: {
            kind: 'automation',
            automationId,
            automationName: 'Golden schedule',
          },
        },
        {
          execution: () =>
            Promise.resolve({ pipelineId: grantedId, snapshot: 'stored' }),
          normalize: () => 'stored',
        },
      )) !== undefined;
    const agentCreate = async (pipelineId: string): Promise<unknown> => {
      const scheduled = schedule(pipelineId, { topic: 'agent' });
      return world.normalize(
        await dispatchAgentAction(
          {
            type: 'automation.create',
            input: {
              name: scheduled.name,
              schedule: scheduled.schedule,
              action: scheduled.action,
              enabled: false,
            },
          },
          goldenWorktreeActionRuntime(world.worktreePath),
        ),
      );
    };
    const deleted = async (
      id: string,
      keepPipeline?: true,
    ): Promise<unknown> => {
      const response = (await invokeIpc(IPC_CHANNELS.automationsDelete, {
        id,
        ...(keepPipeline ? { keepPipeline } : {}),
      })) as { ok?: unknown; error?: unknown };
      return response.ok === true ? true : response.error;
    };
    const agentRefused = {
      isError: true,
      result: {
        requestId: '',
        ok: false,
        error: {
          code: 'validation_failed',
          message:
            "Agents can't add schedules to a workflow someone installed or another agent created.",
          retryable: false,
        },
      },
    };
    const digest = `pp:v1:${'a'.repeat(43)}`;
    const installOf = async (automationId: string): Promise<unknown> =>
      (
        await findCapabilityPackageInstallByOwner(
          getPipelinePackageInstallStorePath(),
          { kind: 'automation', localAutomationId: automationId },
        )
      )?.packageDigest ?? null;
    try {
      // An agent's converted automation: its grant is bound to the
      // pipeline's revision and content as stored.
      const agentOwner = await getAutomationsService().create(
        {
          name: 'Golden schedule',
          schedule: {
            kind: 'cron',
            expression: '0 9 * * 1-5',
            timezone: 'local',
          },
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'global' },
            pipelineId: grantedId,
            pipelineSource: 'user',
            pipelineName: 'Golden workflow page',
            inputs: { topic: 'first' },
          },
          enabled: false,
          executionContext: 'personal',
        },
        { agentAuthor: author },
      );
      const grantedOwner = agentOwner.ok ? (agentOwner.activity?.id ?? '') : '';
      setUserPipelineOwnerAutomation(grantedId, grantedOwner);
      const stored = getStoredPipelineBySource('user', grantedId);
      const revision = stored.data?.info.revision;
      if (revision === undefined)
        throw new Error('Expected a saved workflow revision');
      expect(
        setUserPipelineAgentAuthorIfCurrent(grantedId, author, { revision }),
      ).toBe('written');
      setUserPipelineNativeGrant(grantedId, {
        automationId: grantedOwner,
        pipelineRevision: stored.data?.info.revision ?? 0,
        contentHash: nativeGrantContentHash(stored.data?.content),
        model: 'golden-model',
      });
      const grantedSecond = createdId(
        await invokeIpc(
          IPC_CHANNELS.automationsCreate,
          schedule(grantedId, { topic: 'second' }),
        ),
      );

      // An installed automation's converted workflow, with its package.
      const installedOwner = createdId(
        await invokeIpc(IPC_CHANNELS.automationsCreate, {
          ...schedule(installedId, { topic: 'first' }),
          installedFrom: {
            remoteId: 'golden-installed-workflow',
            contentHash: 'c'.repeat(64),
            installedAt: '2026-11-09T00:00:00.000Z',
            sourceKind: 'curated',
            capabilityPackage: { version: 1, digest },
          },
        }),
      );
      setUserPipelineOwnerAutomation(installedId, installedOwner);
      await upsertCapabilityPackageInstall(
        getPipelinePackageInstallStorePath(),
        {
          owner: { kind: 'automation', localAutomationId: installedOwner },
          pipelineContentHash: 'b'.repeat(64),
          packageDigest: digest,
          installedAt: '2026-11-09T00:00:00.000Z',
        },
      );
      // An action with no `pipelineSource` runs the stored pipeline too.
      const unsourced = schedule(installedId, { topic: 'second' });
      const installedSecond = createdId(
        await invokeIpc(IPC_CHANNELS.automationsCreate, {
          ...unsourced,
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'global' },
            pipelineId: installedId,
            pipelineName: 'Golden workflow page',
            inputs: { topic: 'second' },
          },
        }),
      );
      const secondInstall = async (): Promise<unknown> => {
        const all = await getAutomationsService().allActivities();
        const second = all.find((activity) => activity.id === installedSecond);
        const install =
          second === undefined ? undefined : scheduleInstall(all, second);
        // Whose install a background run of it is also authorized as.
        const authorizedAs =
          second === undefined
            ? undefined
            : inheritedInstallOwner(all, second)?.id;
        return install === undefined
          ? null
          : {
              holder:
                install.holder.id === installedOwner
                  ? 'owner'
                  : install.holder.id === installedSecond
                    ? 'second'
                    : 'other',
              digest: install.required.digest,
              authorizedAsOwner: authorizedAs === installedOwner,
            };
      };

      expect({
        created: [
          grantedOwner,
          grantedSecond,
          installedOwner,
          installedSecond,
        ].every(Boolean),
        grantedPage: await workflowPage(grantedId),
        installedPage: await workflowPage(installedId),
        // Every schedule runs with the grant and the install.
        grantedOwnerRun: await granted(grantedOwner),
        grantedSecondRun: await granted(grantedSecond),
        installedSecondRunsWith: await secondInstall(),
        // Another agent takes neither.
        otherAgentOnGranted: await agentCreate(grantedId),
        otherAgentOnInstalled: await agentCreate(installedId),
        grantedSchedulesAfterAgent: (await listedSchedules(grantedId)).length,
        installedSchedulesAfterAgent: (await listedSchedules(installedId))
          .length,
        // Removing the first schedule drops neither.
        grantedOwnerDeleted: await deleted(grantedOwner),
        grantedSecondRunAfterOwner: await granted(grantedSecond),
        installedOwnerDeleted: await deleted(installedOwner),
        installedOwnerAfter:
          metadata(installedId).ownerAutomationId === installedSecond
            ? 'second'
            : (metadata(installedId).ownerAutomationId ?? null),
        installedSecondInstalledFrom:
          (await listedSchedules(installedId))[0]?.installedFrom?.remoteId ??
          null,
        // It names its source, so its own removal can hand the install on.
        installedSecondSource: await (async (): Promise<unknown> => {
          const second = (await getAutomationsService().allActivities()).find(
            (activity) => activity.id === installedSecond,
          );
          return second?.action.type === 'worktree_pipeline'
            ? (second.action.pipelineSource ?? null)
            : null;
        })(),
        installedSecondPackage: await installOf(installedSecond),
        installedOwnerPackage: await installOf(installedOwner),
        installedSecondRunsWithAfterOwner: await secondInstall(),
        // The last schedule's Remove keeps a granted workflow, and refuses to
        // keep an installed one, whose page deletes it instead.
        grantedLastDeleted: await deleted(grantedSecond, true),
        grantedKept: getStoredPipeline(grantedId).success,
        grantedEmptyPage: await workflowPage(grantedId),
        installedLastKept: await deleted(installedSecond, true),
        // What the page's Delete sends instead: the workflow, with its last
        // schedule and that schedule's install.
        installedWorkflowDeleted: (
          (await invokeIpc(IPC_CHANNELS.automationsDelete, {
            id: installedSecond,
            workflow: true,
          })) as { ok?: unknown }
        ).ok,
        installedSchedulesAfterDelete: (
          await getAutomationsService().allActivities()
        ).filter((activity) => activity.id === installedSecond).length,
        installedPackageAfterDelete: await installOf(installedSecond),
        installedPipelineAfterDelete: getStoredPipeline(installedId).success,
      }).toEqual({
        created: true,
        grantedPage: { agentGranted: true },
        installedPage: {},
        grantedOwnerRun: true,
        grantedSecondRun: true,
        installedSecondRunsWith: {
          holder: 'owner',
          digest,
          authorizedAsOwner: true,
        },
        otherAgentOnGranted: agentRefused,
        otherAgentOnInstalled: agentRefused,
        grantedSchedulesAfterAgent: 2,
        installedSchedulesAfterAgent: 2,
        grantedOwnerDeleted: true,
        grantedSecondRunAfterOwner: true,
        installedOwnerDeleted: true,
        installedOwnerAfter: 'second',
        installedSecondSource: 'user',
        installedSecondInstalledFrom: 'golden-installed-workflow',
        installedSecondPackage: digest,
        installedOwnerPackage: null,
        installedSecondRunsWithAfterOwner: {
          holder: 'second',
          digest,
          authorizedAsOwner: false,
        },
        grantedLastDeleted: true,
        grantedKept: true,
        grantedEmptyPage: {
          agentGranted: true,
          lastScheduleValues: {
            inputs: { topic: 'second' },
            target: { kind: 'global' },
          },
        },
        installedLastKept:
          "This workflow can't stay without its schedule. Delete the workflow instead.",
        installedWorkflowDeleted: true,
        installedSchedulesAfterDelete: 0,
        installedPackageAfterDelete: null,
        installedPipelineAfterDelete: false,
      });
    } finally {
      for (const id of [grantedId, installedId])
        if (id && getStoredPipeline(id).success) deleteStoredPipeline(id);
    }
  });

  // CAN-7228: a run takes its agent origin from the schedule's author, so a
  // person's editor save of the workflow after the agent's write makes its
  // runs the person's (they may then choose plugins for a new chat), and an
  // agent's later write makes them the agent's again.
  it("runs an agent's schedule as the person's after they save its workflow, until an agent writes again", async () => {
    const pipelineId = await savedId();
    const author = {
      chat: {
        projectId: 'golden-agent-project',
        worktreeId: 'golden-agent-worktree',
        chatId: 'golden-agent-chat',
      },
      recordedAt: '2026-11-09T00:00:00.000Z',
    };
    let scheduleId = '';
    const runsAs = async (): Promise<string> => {
      const activity = (await getAutomationsService().allActivities()).find(
        (candidate) => candidate.id === scheduleId,
      );
      if (activity === undefined) return 'missing';
      return scheduleRunAgentAuthor(activity) === undefined
        ? 'person'
        : 'agent';
    };
    const personSave = async (): Promise<boolean> => {
      const stored = getStoredPipelineBySource('user', pipelineId);
      const saved = (await invokeIpc(PIPELINE_CHANNELS.SAVE, {
        id: pipelineId,
        name: 'Golden workflow page',
        description: '',
        icon: '',
        content: stored.data?.content,
      })) as IPCResult<PipelineInfo>;
      return saved.success;
    };
    try {
      // An agent wrote the workflow and its schedule.
      const savedRevision = getStoredPipelineBySource('user', pipelineId).data
        ?.info.revision;
      if (savedRevision === undefined)
        throw new Error('Expected a saved workflow revision');
      expect(
        setUserPipelineAgentAuthorIfCurrent(pipelineId, author, {
          revision: savedRevision,
        }),
      ).toBe('written');
      const created = await getAutomationsService().create(
        {
          name: 'Golden schedule',
          schedule: {
            kind: 'cron',
            expression: '0 9 * * 1-5',
            timezone: 'local',
          },
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'global' },
            pipelineId,
            pipelineSource: 'user',
            pipelineName: 'Golden workflow page',
            inputs: { topic: 'agent' },
          },
          enabled: false,
          executionContext: 'personal',
        },
        { agentAuthor: author },
      );
      scheduleId = created.ok ? (created.activity?.id ?? '') : '';
      const agentWrote = await runsAs();
      const saved = await personSave();
      const afterSave = await runsAs();
      expect(
        await dispatchAgentAction(
          { type: 'pipeline.update', pipelineId, name: 'Agent edit' },
          goldenWorktreeActionRuntime(world.worktreePath),
        ),
      ).toMatchObject({ isError: false });
      const afterAgentEdit = await runsAs();
      const savedAgain = await personSave();
      const afterSecondSave = await runsAs();
      // An agent's schedule edit that waited behind the save, with the time
      // it was asked for before it, takes the runs back when it commits.
      const scheduleEdit = await getAutomationsService().update(
        { id: scheduleId, name: 'Golden agent edit' },
        undefined,
        undefined,
        { agentAuthor: author },
      );
      const afterScheduleEdit = await runsAs();
      // The Pipeline Editor assistant saving its draft is an agent's write,
      // never a person's takeover.
      await personSave();
      // A run that read this takeover before the assistant's save starts as
      // the agent's: the takeover no longer holds once its definition is
      // resolved.
      const scheduled = (await getAutomationsService().allActivities()).find(
        (activity) => activity.id === scheduleId,
      );
      const takeover =
        scheduled === undefined ? undefined : schedulePersonTakeover(scheduled);
      const storedHash = (): string =>
        nativeGrantContentHash(
          getStoredPipelineBySource('user', pipelineId).data?.content,
        );
      const takeoverHeld =
        takeover !== undefined &&
        personTakeoverHolds(
          takeover.pipelineId,
          takeover.personAuthoredAt,
          storedHash(),
        );
      // It holds only for the content the person saved: another write's
      // content fails it, whenever its writer clears the stamp.
      const otherContentHeld =
        takeover !== undefined &&
        personTakeoverHolds(
          takeover.pipelineId,
          takeover.personAuthoredAt,
          nativeGrantContentHash(parsePipelineText(GOLDEN_NO_JOBS_YAML)),
        );
      const { savePipelineEditorSnapshot } =
        await import('../../pipeline-editor/editor-save');
      // An assistant draft refused as stale writes nothing and takes
      // nothing back.
      const staleAssistantSave = await savePipelineEditorSnapshot({
        id: 'golden-stale-assistant-draft',
        target: { persistedId: pipelineId, source: 'user', revision: 1 },
        pipeline: parsePipelineText(SCHEDULED_YAML),
      });
      const takeoverHeldAfterStale =
        takeover !== undefined &&
        personTakeoverHolds(
          takeover.pipelineId,
          takeover.personAuthoredAt,
          storedHash(),
        );
      const stored = getStoredPipelineBySource('user', pipelineId);
      const assistantSave = await savePipelineEditorSnapshot({
        id: 'golden-assistant-draft',
        target: {
          persistedId: pipelineId,
          source: 'user',
          revision: stored.data?.info.revision ?? 0,
        },
        pipeline: parsePipelineText(SCHEDULED_YAML),
      });
      const afterAssistantSave = await runsAs();
      // An editor save App Advisor's pipeline.save pressed is the agent's;
      // the person's own next save takes the runs over.
      const { noteAgentRequestedEditorSave } =
        await import('../../pipelines/agent-editor-save');
      noteAgentRequestedEditorSave();
      await personSave();
      const afterAdvisorSave = await runsAs();
      await personSave();
      const afterPersonSaveAgain = await runsAs();
      const takeoverHeldAfterAssistant =
        takeover !== undefined &&
        personTakeoverHolds(
          takeover.pipelineId,
          takeover.personAuthoredAt,
          storedHash(),
        );
      expect({
        agentWrote,
        saved,
        afterSave,
        afterAgentEdit,
        savedAgain,
        afterSecondSave,
        scheduleEdited: scheduleEdit.ok,
        afterScheduleEdit,
        assistantSaved: assistantSave.ok,
        afterAssistantSave,
        takeoverHeld,
        otherContentHeld,
        staleAssistantSaved: staleAssistantSave.ok,
        takeoverHeldAfterStale,
        takeoverHeldAfterAssistant,
        afterAdvisorSave,
        afterPersonSaveAgain,
        // The schedule keeps its agent author: only its runs change.
        scheduleAuthor: (await getAutomationsService().allActivities()).find(
          (activity) => activity.id === scheduleId,
        )?.agentAuthor,
      }).toEqual({
        agentWrote: 'agent',
        saved: true,
        afterSave: 'person',
        afterAgentEdit: 'agent',
        savedAgain: true,
        afterSecondSave: 'person',
        scheduleEdited: true,
        afterScheduleEdit: 'agent',
        assistantSaved: true,
        afterAssistantSave: 'agent',
        takeoverHeld: true,
        otherContentHeld: false,
        staleAssistantSaved: false,
        takeoverHeldAfterStale: true,
        takeoverHeldAfterAssistant: false,
        afterAdvisorSave: 'agent',
        afterPersonSaveAgain: 'person',
        scheduleAuthor: author,
      });
    } finally {
      if (scheduleId)
        await invokeIpc(IPC_CHANNELS.automationsDelete, { id: scheduleId });
      if (getStoredPipeline(pipelineId).success)
        deleteStoredPipeline(pipelineId);
    }
  });

  it('deletes a whole workflow page in one request from any of its schedules', async () => {
    const pipelineId = await savedId();
    try {
      const owner = createdId(
        await invokeIpc(
          IPC_CHANNELS.automationsCreate,
          schedule(pipelineId, { topic: 'first' }),
        ),
      );
      setUserPipelineOwnerAutomation(pipelineId, owner);
      const second = createdId(
        await invokeIpc(
          IPC_CHANNELS.automationsCreate,
          schedule(pipelineId, { topic: 'second' }),
        ),
      );
      const deleted = (await invokeIpc(IPC_CHANNELS.automationsDelete, {
        id: second,
        workflow: true,
      })) as { ok?: unknown };
      const listed = (await invokeIpc(IPC_CHANNELS.automationsList)) as {
        activities?: readonly { id: string }[];
      };
      expect({
        created: [owner, second].every(Boolean),
        deleted: deleted.ok,
        schedulesLeft: (listed.activities ?? []).filter(
          (activity) => activity.id === owner || activity.id === second,
        ).length,
        pipelineKept: getStoredPipeline(pipelineId).success,
      }).toEqual({
        created: true,
        deleted: true,
        schedulesLeft: 0,
        pipelineKept: false,
      });
    } finally {
      if (pipelineId && getStoredPipeline(pipelineId).success)
        deleteStoredPipeline(pipelineId);
    }
  });

  it('folds an installed workflow into its automation: one row on install, update and restart, deleted with it (CAN-7285)', async () => {
    const pipelineId = await savedId();
    const sharedId = await savedId();
    const ownerOf = (id: string): string | null =>
      readPipelineLocalMetadata({ type: 'stored', source: 'user', value: id })
        .ownerAutomationId ?? null;
    // The install modal saves the bundled pipeline, then creates the
    // automation that records it.
    const install = (
      id: string,
      contentHash: string,
    ): Record<string, unknown> => ({
      ...schedule(id, { topic: 'installed' }),
      installedFrom: {
        remoteId: 'golden-installed-share',
        contentHash,
        sourceKind: 'curated',
        installedAt: '2026-11-18T00:00:00.000Z',
        bundledPipelineLocalId: id,
        bundledPipelineContentHash: 'b'.repeat(64),
      },
    });
    try {
      const installed = createdId(
        await invokeIpc(
          IPC_CHANNELS.automationsCreate,
          install(pipelineId, 'c'.repeat(64)),
        ),
      );
      const ownedOnInstall = ownerOf(pipelineId) === installed;
      const pageOnInstall = await workflowPage(pipelineId);
      // Applying the share's next revision keeps the one row.
      const updated = (await invokeIpc(IPC_CHANNELS.automationsUpdate, {
        id: installed,
        ...install(pipelineId, 'd'.repeat(64)),
      })) as { ok?: unknown };
      const ownedAfterUpdate = ownerOf(pipelineId) === installed;
      // A copy installed before the marker was recorded folds on restart,
      // in the mutation queue ahead of the next write.
      setUserPipelineOwnerAutomation(pipelineId, null);
      const service = getAutomationsService();
      await service.start();
      service.stop();
      // A pipeline another record already runs stays its own workflow.
      const other = createdId(
        await invokeIpc(
          IPC_CHANNELS.automationsCreate,
          schedule(sharedId, { topic: 'first' }),
        ),
      );
      const ownedAfterRestart = ownerOf(pipelineId) === installed;
      const sharedInstall = createdId(
        await invokeIpc(
          IPC_CHANNELS.automationsCreate,
          install(sharedId, 'e'.repeat(64)),
        ),
      );
      const sharedOwner = ownerOf(sharedId);
      const removed = (await invokeIpc(IPC_CHANNELS.automationsDelete, {
        id: installed,
      })) as { ok?: unknown };
      for (const id of [other, sharedInstall])
        await invokeIpc(IPC_CHANNELS.automationsDelete, { id });
      expect({
        created: [installed, other, sharedInstall].every(Boolean),
        ownedOnInstall,
        pageOnInstall: pageOnInstall !== null,
        updated: updated.ok,
        ownedAfterUpdate,
        ownedAfterRestart,
        sharedOwner,
        removed: removed.ok,
        pipelineKept: getStoredPipeline(pipelineId).success,
      }).toEqual({
        created: true,
        ownedOnInstall: true,
        pageOnInstall: true,
        updated: true,
        ownedAfterUpdate: true,
        ownedAfterRestart: true,
        sharedOwner: null,
        removed: true,
        pipelineKept: false,
      });
    } finally {
      for (const id of [pipelineId, sharedId])
        if (id && getStoredPipeline(id).success) deleteStoredPipeline(id);
    }
  });

  // One page for every user workflow (Hassan Ali, 2026-11-24): a converted
  // caller and one made as a workflow both count.
  it('counts every user workflow that calls a pipeline through run-pipeline', async () => {
    const saveYaml = async (yaml: string): Promise<string> => {
      const content = parsePipelineText(yaml);
      const result = await invokeIpc(PIPELINE_CHANNELS.SAVE, {
        name: content.name,
        description: '',
        icon: '',
        content,
      });
      return typeof result === 'object' &&
        result !== null &&
        'data' in result &&
        typeof result.data === 'object' &&
        result.data !== null &&
        'id' in result.data &&
        typeof result.data.id === 'string'
        ? result.data.id
        : '';
    };
    const callerYaml = (name: string, childId: string): string =>
      [
        'pipeline:',
        `  name: ${name}`,
        '  scope: global',
        '  on: dispatch',
        '  env:',
        `    CHILD: ${childId}`,
        '  jobs:',
        '    run:',
        '      steps:',
        '        - uses: builtin/run-pipeline',
        '          with:',
        '            pipeline: ${{ env.CHILD }}',
        '',
      ].join('\n');
    const childId = await savedId();
    const pageId = await saveYaml(callerYaml('Golden caller page', childId));
    const plainId = await saveYaml(callerYaml('Golden plain caller', childId));
    try {
      const owner = createdId(
        await invokeIpc(
          IPC_CHANNELS.automationsCreate,
          schedule(pageId, { topic: 'first' }),
        ),
      );
      setUserPipelineOwnerAutomation(pageId, owner);
      const listed = (await invokeIpc(PIPELINE_CHANNELS.LIST)) as IPCResult<
        PipelineInfo[]
      >;
      const rows = listed.success ? (listed.data ?? []) : [];
      const callers = (id: string): number | null =>
        rows.find((row) => row.id === id)?.workflowCallers ?? null;
      expect({
        saved: [childId, pageId, plainId, owner].every(Boolean),
        child: callers(childId),
        page: callers(pageId),
        plain: callers(plainId),
      }).toEqual({ saved: true, child: 2, page: null, plain: null });
    } finally {
      for (const id of [childId, pageId, plainId])
        if (id && getStoredPipeline(id).success) deleteStoredPipeline(id);
    }
  });

  it('checks a schedule that names no source, as the scheduler runs it (CAN-5782 phase 05)', async () => {
    const yaml = (on: string[]): string =>
      [
        'pipeline:',
        '  name: Golden sourceless',
        '  scope: global',
        '  on:',
        ...on,
        '  jobs:',
        '    run:',
        '      steps:',
        '        - run: echo scheduled',
        '',
      ].join('\n');
    const first = parsePipelineText(
      yaml([
        '    dispatch:',
        '      inputs:',
        '        topic:',
        '          type: string',
      ]),
    );
    const saved = (await invokeIpc(PIPELINE_CHANNELS.SAVE, {
      name: first.name,
      description: '',
      icon: '',
      content: first,
    })) as IPCResult<PipelineInfo>;
    const id = saved.data?.id ?? '';
    let scheduleId = '';
    try {
      const created = await invokeIpc(IPC_CHANNELS.automationsCreate, {
        ...schedule(id, { topic: 'news' }),
        enabled: true,
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'global' },
          pipelineId: id,
          pipelineName: 'Golden sourceless',
          inputs: { topic: 'news' },
        },
      });
      scheduleId = createdId(created);
      expect(scheduleId).not.toBe('');
      const next = parsePipelineText(yaml(['    workflow: {}']));
      const stored = getStoredPipelineBySource('user', id);
      expect(
        await invokeIpc(PIPELINE_CHANNELS.SAVE, {
          id,
          expectedRevision: stored.data?.info.revision ?? 0,
          name: next.name,
          description: '',
          icon: '',
          content: next,
        }),
      ).toMatchObject({ success: false, scheduleRefusal: 'blocked' });
    } finally {
      if (scheduleId)
        await invokeIpc(IPC_CHANNELS.automationsDelete, { id: scheduleId });
      if (id && getStoredPipelineBySource('user', id).success)
        deleteStoredPipeline(id);
    }
  });

  it('refuses a save that would break or stop its enabled schedules (CAN-5782 phase 05)', async () => {
    const yamlWith = (on: string[]): string =>
      [
        'pipeline:',
        '  name: Golden save guard',
        '  scope: global',
        '  on:',
        ...on,
        '  jobs:',
        '    run:',
        '      steps:',
        '        - run: echo scheduled',
        '',
      ].join('\n');
    const BOTH = yamlWith([
      '    dispatch:',
      '      inputs:',
      '        topic:',
      '          type: string',
      '    workflow: {}',
    ]);
    const content = parsePipelineText(BOTH);
    const saved = (await invokeIpc(PIPELINE_CHANNELS.SAVE, {
      name: content.name,
      description: '',
      icon: '',
      content,
    })) as IPCResult<PipelineInfo>;
    const id = saved.data?.id ?? '';
    const created: string[] = [];
    const resave = (
      yaml: string,
      extra: Record<string, unknown> = {},
    ): Promise<
      IPCResult<PipelineInfo> & {
        scheduleRefusal?: string;
        stoppingScheduleIds?: string[];
      }
    > => {
      const next = parsePipelineText(yaml);
      const stored = getStoredPipelineBySource('user', id);
      return invokeIpc(PIPELINE_CHANNELS.SAVE, {
        id,
        expectedRevision: stored.data?.info.revision ?? 0,
        name: next.name,
        description: '',
        icon: '',
        content: next,
        ...extra,
      }) as Promise<IPCResult<PipelineInfo> & { scheduleRefusal?: string }>;
    };
    try {
      const person = await invokeIpc(IPC_CHANNELS.automationsCreate, {
        ...schedule(id, { topic: 'news' }),
        enabled: true,
      });
      created.push(createdId(person));
      expect(createdId(person)).not.toBe('');
      // Dropping Manual leaves its saved input undeclared under Workflow.
      const dropped = await resave(yamlWith(['    workflow: {}']));
      expect(dropped).toMatchObject({
        success: false,
        scheduleRefusal: 'blocked',
      });
      expect(dropped.error).toContain('“Golden schedule”');
      // With the schedule's edited inputs, which the page writes right after
      // the pipeline, the same trigger change saves.
      expect(
        await resave(yamlWith(['    workflow: {}']), {
          pendingScheduleInputs: { [createdId(person)]: {} },
        }),
      ).toMatchObject({ success: true });
      expect(await resave(BOTH)).toMatchObject({ success: true });
      // Leaving neither Manual nor Workflow is refused too.
      expect(await resave(yamlWith(['    plan_ready: {}']))).toMatchObject({
        success: false,
        scheduleRefusal: 'blocked',
      });
      // The stored definition is unchanged, and an unrelated edit saves.
      expect(
        getTriggerTypes(getStoredPipelineBySource('user', id).data?.content.on),
      ).toEqual(['dispatch', 'workflow']);
      expect(await resave(BOTH)).toMatchObject({ success: true });
      // An agent's enabled schedule would stop without Manual: the person
      // is asked first, and their confirmation saves.
      const agent = await getAutomationsService().create(
        {
          name: 'Golden agent schedule',
          schedule: {
            kind: 'cron',
            expression: '0 9 * * 1-5',
            timezone: 'local',
          },
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'global' },
            pipelineId: id,
            pipelineSource: 'user',
            pipelineName: 'Golden save guard',
            inputs: { topic: 'news' },
          },
          enabled: true,
          executionContext: 'personal',
        },
        {
          agentAuthor: {
            chat: {
              projectId: 'golden-agent-project',
              worktreeId: 'golden-agent-worktree',
              chatId: 'golden-agent-chat',
            },
            recordedAt: '2026-11-09T00:00:00.000Z',
          },
        },
      );
      created.push(createdId(agent));
      expect(createdId(agent)).not.toBe('');
      // The agent's schedule stops without Manual, so its input, which only
      // Manual declares, isn't checked against Workflow: the person is
      // asked, not blocked.
      expect(
        await resave(yamlWith(['    workflow: {}']), {
          pendingScheduleInputs: { [createdId(person)]: {} },
        }),
      ).toMatchObject({
        success: false,
        scheduleRefusal: 'needs_confirmation',
        stoppingScheduleIds: [createdId(agent)],
      });
      const WORKFLOW_ONLY = yamlWith([
        '    workflow:',
        '      inputs:',
        '        topic:',
        '          type: string',
      ]);
      expect(await resave(WORKFLOW_ONLY)).toMatchObject({
        success: false,
        scheduleRefusal: 'needs_confirmation',
        stoppingScheduleIds: [createdId(agent)],
      });
      // A confirmation that names other schedules than would stop asks again.
      expect(
        await resave(WORKFLOW_ONLY, { confirmAgentSchedulesStop: ['other'] }),
      ).toMatchObject({
        success: false,
        scheduleRefusal: 'needs_confirmation',
      });
      expect(
        await resave(WORKFLOW_ONLY, {
          confirmAgentSchedulesStop: [createdId(agent)],
        }),
      ).toMatchObject({ success: true });
    } finally {
      for (const activity of created)
        if (activity)
          await invokeIpc(IPC_CHANNELS.automationsDelete, { id: activity });
      if (id && getStoredPipelineBySource('user', id).success)
        deleteStoredPipeline(id);
    }
  });

  it('schedules a workflow-only pipeline a person approved, and keeps agents on dispatch (CAN-5782)', async () => {
    const workflowYaml = (on: string[]): string =>
      [
        'pipeline:',
        '  name: Golden workflow only',
        '  scope: global',
        '  on:',
        ...on,
        '  jobs:',
        '    run:',
        '      steps:',
        '        - run: echo scheduled',
        '',
      ].join('\n');
    const WORKFLOW_ONLY = workflowYaml([
      '    workflow:',
      '      inputs:',
      '        topic:',
      '          type: string',
      '          required: true',
    ]);
    const PLAN_ONLY = workflowYaml(['    plan_ready: {}']);
    const save = async (yaml: string): Promise<string> => {
      const content = parsePipelineText(yaml);
      const result = (await invokeIpc(PIPELINE_CHANNELS.SAVE, {
        name: content.name,
        description: '',
        icon: '',
        content,
      })) as IPCResult<PipelineInfo>;
      return result.data?.id ?? '';
    };
    const author = {
      chat: {
        projectId: 'golden-agent-project',
        worktreeId: 'golden-agent-worktree',
        chatId: 'golden-agent-chat',
      },
      recordedAt: '2026-11-09T00:00:00.000Z',
    };
    const errorOf = (response: unknown): unknown =>
      typeof response === 'object' && response !== null && 'error' in response
        ? response.error
        : null;
    const workflowId = await save(WORKFLOW_ONLY);
    const planId = await save(PLAN_ONLY);
    const created: string[] = [];
    try {
      // A person saved it: their schedule saves.
      const person = await invokeIpc(
        IPC_CHANNELS.automationsCreate,
        schedule(workflowId, { topic: 'news' }),
      );
      created.push(createdId(person));
      expect(createdId(person)).not.toBe('');
      // An input its Workflow trigger doesn't declare is refused up front.
      expect(
        errorOf(
          await invokeIpc(
            IPC_CHANNELS.automationsCreate,
            schedule(workflowId, { other: 'x' }),
          ),
        ),
      ).toBe(
        "This schedule's input \"other\" isn't one the workflow's Workflow trigger declares. Remove it, or add it to the trigger.",
      );
      // So is one the executor would refuse: a required input left out.
      expect(
        errorOf(
          await invokeIpc(
            IPC_CHANNELS.automationsCreate,
            schedule(workflowId, {}),
          ),
        ),
      ).toContain('Workflow input "topic" is required');
      // An agent's update that keeps the target, a cron change only, would
      // make the agent its author, so it is refused too.
      expect(
        await dispatchAgentAction(
          {
            type: 'automation.update',
            id: createdId(person),
            patch: {
              schedule: {
                kind: 'cron',
                expression: '0 10 * * 1-5',
                timezone: 'local',
              },
            },
          },
          goldenWorktreeActionRuntime(world.worktreePath),
        ),
      ).toMatchObject({
        result: {
          ok: false,
          error: { message: 'Workflow does not support dispatch triggers.' },
        },
      });
      // An agent's Run now of it is refused, and the agent is told so.
      expect(
        await dispatchAgentAction(
          { type: 'automation.run_now', id: createdId(person) },
          goldenWorktreeActionRuntime(world.worktreePath),
        ),
      ).toMatchObject({ result: { ok: false } });
      // The same holds for a schedule whose action names no source: its
      // stored target is resolved as the scheduler resolves it.
      const unsourced = await invokeIpc(IPC_CHANNELS.automationsCreate, {
        ...schedule(workflowId, { topic: 'news' }),
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'global' },
          pipelineId: workflowId,
          pipelineName: 'Golden workflow only',
          inputs: { topic: 'news' },
        },
      });
      created.push(createdId(unsourced));
      expect(createdId(unsourced)).not.toBe('');
      expect(
        await dispatchAgentAction(
          {
            type: 'automation.update',
            id: createdId(unsourced),
            patch: {
              schedule: {
                kind: 'cron',
                expression: '0 11 * * 1-5',
                timezone: 'local',
              },
            },
          },
          goldenWorktreeActionRuntime(world.worktreePath),
        ),
      ).toMatchObject({
        result: {
          ok: false,
          error: { message: 'Workflow does not support dispatch triggers.' },
        },
      });
      // An agent's schedule runs only as dispatch.
      const agent = await getAutomationsService().create(
        {
          name: 'Golden schedule',
          schedule: {
            kind: 'cron',
            expression: '0 9 * * 1-5',
            timezone: 'local',
          },
          action: {
            type: 'worktree_pipeline',
            target: { kind: 'global' },
            pipelineId: workflowId,
            pipelineSource: 'user',
            pipelineName: 'Golden workflow only',
            inputs: { topic: 'news' },
          },
          enabled: false,
          executionContext: 'personal',
        },
        { agentAuthor: author },
      );
      expect(errorOf(agent)).toBe(
        'Workflow does not support dispatch triggers.',
      );
      // After an agent's edit, a person's schedule waits for a person: it
      // saves paused, and turning it on is refused.
      const editedRevision = getStoredPipelineBySource('user', workflowId).data
        ?.info.revision;
      if (editedRevision === undefined) throw new Error('Workflow missing');
      expect(
        setUserPipelineAgentAuthorIfCurrent(workflowId, author, {
          revision: editedRevision,
        }),
      ).toBe('written');
      const paused = await invokeIpc(
        IPC_CHANNELS.automationsCreate,
        schedule(workflowId, { topic: 'news' }),
      );
      created.push(createdId(paused));
      expect(createdId(paused)).not.toBe('');
      expect(
        errorOf(
          await invokeIpc(IPC_CHANNELS.automationsUpdate, {
            id: createdId(paused),
            enabled: true,
          }),
        ),
      ).toBe(
        "This workflow's only trigger is Workflow, and its current version wasn't saved by a person. Save or approve it on its page before it runs on a schedule.",
      );
      // A pipeline with neither trigger is still refused.
      expect(
        errorOf(
          await invokeIpc(IPC_CHANNELS.automationsCreate, schedule(planId, {})),
        ),
      ).toBe('Workflow does not support dispatch triggers.');
    } finally {
      for (const id of created)
        if (id) await invokeIpc(IPC_CHANNELS.automationsDelete, { id });
      for (const id of [workflowId, planId])
        if (id && getStoredPipeline(id).success) deleteStoredPipeline(id);
    }
  });
});

describe('packaged installs shared as their workflow (CAN-6455)', () => {
  const REMOTE_ID = 'public-golden-chat-package';
  const PUBLIC_PREFIX = `/api/v1/public-shares/automations/${REMOTE_ID}/package`;
  const UPLOADS = '/api/v1/pipeline-packages/uploads';
  const hex = (text: string): string =>
    createHash('sha256').update(text, 'utf8').digest('hex');
  const blobs = new Map<string, Uint8Array>();
  const blob = (text: string): { sha256: string; size: number } => {
    const bytes = new TextEncoder().encode(text);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    blobs.set(sha256, bytes);
    return { sha256, size: bytes.byteLength };
  };
  const skill = blob(
    '---\nname: triage\ndescription: Triage issues\n---\nTriage the issues.\n',
  );
  // A chat automation's package: one skill its native prompt binds.
  const installed: PipelinePackageManifestV1 = {
    version: 1,
    pipelineContentHash: 'a'.repeat(64),
    resources: [
      {
        id: 'skill-triage',
        kind: 'standalone_skill',
        displayName: 'triage',
        sourceLabel: 'Custom',
        sourceVisibility: 'private',
        invocationKeys: ['triage'],
        dependencyResourceIds: [],
        trees: [
          {
            provider: 'claude',
            runtimeKind: 'standalone_skill',
            rootName: 'triage',
            entries: [{ path: 'SKILL.md', ...skill, mode: 'read' }],
          },
        ],
      },
    ],
    bindings: [
      { jobId: 'automation', stepId: 'action', resourceIds: ['skill-triage'] },
    ],
    environmentRequirements: [],
    totalFiles: 1,
    totalBytes: skill.size,
  };
  const installedDigest = computePipelinePackageDigestSync(installed);
  /** What the golden cloud was asked to publish, in order. */
  const prepared: PipelinePackageManifestV1[] = [];
  const uploadedBlobs: Array<{ sha256: string; bytes: Uint8Array }> = [];
  let restoreFetch: (() => void) | undefined;

  beforeAll(async () => {
    const { registerAutomationsHandlers } =
      await import('../../ipc/automations');
    registerAutomationsHandlers({
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      openAppAdvisorWindow: () =>
        Promise.reject(new Error('No window in this golden.')),
      ensureAppAdvisorWindow: () =>
        Promise.reject(new Error('No window in this golden.')),
      sendAppAdvisorWindowCommand: () => undefined,
    });
    // The golden cloud also serves this public share's package and accepts
    // package uploads, which no other case here reaches.
    const goldenFetch = global.fetch;
    const reply = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    global.fetch = async (input, init): Promise<Response> => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.pathname;
      if (method === 'GET' && path === PUBLIC_PREFIX)
        return url.searchParams.get('expectedPackageDigest') === installedDigest
          ? reply(200, { digest: installedDigest, manifest: installed })
          : reply(404, { error: 'Not found' });
      if (method === 'GET' && path.startsWith(`${PUBLIC_PREFIX}/blobs/`)) {
        const bytes = blobs.get(path.slice(PUBLIC_PREFIX.length + 7));
        return bytes
          ? new Response(Buffer.from(bytes), { status: 200 })
          : reply(404, { error: 'Not found' });
      }
      if (method === 'POST' && path === UPLOADS) {
        const body = JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}',
        ) as {
          manifest: PipelinePackageManifestV1;
        };
        prepared.push(body.manifest);
        // The cloud holds none of the files yet.
        return reply(200, {
          uploadId: `golden-upload-${prepared.length}`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          missingBlobs: [
            ...new Set(
              body.manifest.resources.flatMap((resource) =>
                resource.trees.flatMap((tree) =>
                  tree.entries.map((entry) => entry.sha256),
                ),
              ),
            ),
          ],
        });
      }
      const blobPut =
        /^\/api\/v1\/pipeline-packages\/uploads\/[^/]+\/blobs\/([^/]+)$/.exec(
          path,
        );
      if (method === 'PUT' && blobPut) {
        const body = init?.body;
        uploadedBlobs.push({
          sha256: decodeURIComponent(blobPut[1] ?? ''),
          bytes: new Uint8Array(body instanceof Uint8Array ? body : []),
        });
        return new Response(null, { status: 204 });
      }
      const commit =
        /^\/api\/v1\/pipeline-packages\/uploads\/([^/]+)\/commit$/.exec(path);
      if (method === 'POST' && commit) {
        const manifest = prepared[prepared.length - 1];
        // The cloud computes the digest from what it was given.
        return manifest
          ? reply(200, {
              uploadId: decodeURIComponent(commit[1] ?? ''),
              digest: computePipelinePackageDigestSync(manifest),
              package: {},
            })
          : reply(409, { error: 'Nothing prepared' });
      }
      return goldenFetch(input, init);
    };
    restoreFetch = (): void => {
      global.fetch = goldenFetch;
    };
  });

  afterAll(() => restoreFetch?.());

  it('shares a packaged install as its workflow through automations:capability-package:commit only with the flag on (CAN-6455)', async () => {
    const flags = getFeatureFlagService();
    const isEnabled = flags.isEnabled.bind(flags);
    let workflowForm = false;
    const flag = jest
      .spyOn(flags, 'isEnabled')
      .mockImplementation((key) =>
        key ===
        CLIENT_FEATURE_FLAGS.canopyDesktopSharedAutomationsWorkflowForm.key
          ? workflowForm
          : isEnabled(key),
      );
    const packageRef = { version: 1 as const, digest: installedDigest };
    let automationId = '';
    let workflowId = '';
    try {
      // Installing a shared chat automation with a package, as the install
      // dialog does: create it (it converts to a workflow it owns,
      // CAN-5479), then install its package pinned to the chat it shows.
      const created = (await invokeIpc(IPC_CHANNELS.automationsCreate, {
        name: 'Golden packaged chat',
        schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'local' },
        action: {
          type: 'worktree_prompt',
          workspaceId: GOLDEN_WORKSPACE_ID,
          prompt: 'Run /triage on new issues',
        },
        enabled: false,
        installedFrom: {
          remoteId: REMOTE_ID,
          contentHash: 'c'.repeat(64),
          installedAt: '2026-11-13T00:00:00.000Z',
          sourceKind: 'public',
          capabilityPackage: packageRef,
        },
      })) as { ok: boolean; error?: string; activity?: ScheduledActivity };
      expect(created.error).toBeUndefined();
      const shown = created.activity;
      automationId = shown?.id ?? '';
      expect(shown?.action.type).toBe('worktree_prompt');
      const chatHash = hex(
        JSON.stringify({ name: shown?.name, action: shown?.action }),
      );
      await invokeIpc(IPC_CHANNELS.automationsCapabilityPackageInstall, {
        remoteId: REMOTE_ID,
        localAutomationId: automationId,
        packageRef,
        localContentHash: chatHash,
        source: 'public',
        publicShare: true,
      });
      const saved = (await getAutomationsService().allActivities()).find(
        (activity) => activity.id === automationId,
      );
      expect(saved?.action.type).toBe('worktree_pipeline');
      workflowId =
        (saved === undefined ? undefined : scheduledUserPipelineId(saved)) ??
        '';
      const workflow = readFileSync(
        getStoredPipelinePath(workflowId).data ?? '',
        'utf8',
      );

      const commit = async (
        request: Record<string, unknown>,
      ): Promise<{
        result: ShareOperationResult<unknown>;
        uploads: number;
      }> => {
        prepared.length = 0;
        uploadedBlobs.length = 0;
        const result = (await invokeIpc(
          IPC_CHANNELS.automationsCapabilityPackageCommit,
          {
            localAutomationId: automationId,
            packageRef,
            expectedPackageContentHash: chatHash,
            ...request,
          },
        )) as ShareOperationResult<unknown>;
        return { result, uploads: prepared.length };
      };

      // Flag off: no workflow share, and nothing reaches the cloud.
      const off = await commit({ reboundWorkflow: workflow });
      expect(off).toMatchObject({ result: { ok: false }, uploads: 0 });

      workflowForm = true;
      // Flag on: the installed files, bound to the workflow's send step and
      // keyed to its YAML, published as a new package.
      const on = await commit({ reboundWorkflow: workflow });
      expect(on.result.ok).toBe(true);
      expect(prepared).toHaveLength(1);
      const rebound = prepared[0];
      expect(rebound?.bindings).toEqual([
        { jobId: 'chat', stepId: 'send', resourceIds: ['skill-triage'] },
      ]);
      expect(rebound?.resources).toEqual(installed.resources);
      expect(rebound?.pipelineContentHash).toBe(hex(workflow));
      // Its files came from the install's cache, byte for byte.
      expect(uploadedBlobs).toEqual([
        { sha256: skill.sha256, bytes: blobs.get(skill.sha256) },
      ]);
      const reboundDigest = on.result.ok
        ? (on.result.value as { capabilityPackage: { digest: string } })
            .capabilityPackage.digest
        : '';
      expect(reboundDigest).toBe(
        rebound ? computePipelinePackageDigestSync(rebound) : '',
      );
      expect(reboundDigest).not.toBe(installedDigest);

      // A workflow one character off the stored one is refused.
      const edited = await commit({ reboundWorkflow: `${workflow} ` });
      expect(edited).toMatchObject({ result: { ok: false }, uploads: 0 });

      // Without a workflow, the install's own package is shared unchanged.
      const chat = await commit({});
      expect(chat.result).toMatchObject({
        ok: true,
        value: { capabilityPackage: packageRef },
      });
      expect(prepared).toEqual([installed]);
    } finally {
      flag.mockRestore();
      if (automationId)
        await invokeIpc(IPC_CHANNELS.automationsDelete, { id: automationId });
      if (workflowId) deleteStoredPipeline(workflowId);
    }
  });
});

describe("Electron main's owners (CAN-6003 part B)", () => {
  beforeAll(async () => {
    const { registerAutomationsHandlers } =
      await import('../../ipc/automations');
    registerAutomationsHandlers({
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      openAppAdvisorWindow: () =>
        Promise.reject(new Error('No window in this golden.')),
      ensureAppAdvisorWindow: () =>
        Promise.reject(new Error('No window in this golden.')),
      sendAppAdvisorWindowCommand: () => undefined,
    });
    (await import('../../ipc/open-in')).registerOpenInHandlers();
    (await import('../../ipc/workspaces')).registerWorkspaceHandlers(
      () => null,
      {
        dispatcher: runtime,
        resolveCaller: () => {
          throw new Error('No dispatcher read in these handlers.');
        },
      },
    );
  });

  it("answers App Advisor's workflow and automation reads exactly as the window's handlers", async () => {
    const pipelines = await import('../../pipelines/pipeline-handlers');
    const automations = await import('../../ipc/automations');
    const openIn = await import('../../ipc/open-in');
    const workspaces = await import('../../ipc/workspaces');
    const cases: Array<[string, unknown[], () => Promise<unknown>]> = [
      [PIPELINE_CHANNELS.LIST, [], () => pipelines.listPipelinesForCaller()],
      [
        PIPELINE_CHANNELS.GET,
        [world.userPipelineId],
        () => pipelines.getPipelineForCaller(world.userPipelineId),
      ],
      [
        PIPELINE_CHANNELS.GET,
        [{ source: 'bundled', id: GOLDEN_BUNDLED_PIPELINE_ID }],
        () =>
          pipelines.getPipelineForCaller({
            source: 'bundled',
            id: GOLDEN_BUNDLED_PIPELINE_ID,
          }),
      ],
      [
        PIPELINE_CHANNELS.GET,
        [
          {
            id: GOLDEN_PROJECT_PIPELINE_ID,
            cwd: world.worktreePath,
            filePath: projectFile(),
          },
        ],
        () =>
          pipelines.getPipelineForCaller({
            id: GOLDEN_PROJECT_PIPELINE_ID,
            cwd: world.worktreePath,
            filePath: projectFile(),
          }),
      ],
      [
        PIPELINE_CHANNELS.GET,
        ['missing-pipeline'],
        () => pipelines.getPipelineForCaller('missing-pipeline'),
      ],
      [
        PIPELINE_CHANNELS.SHARED_GET,
        [{ remoteId: GOLDEN_SHARED_REMOTE_ID }],
        () =>
          pipelines.getSharedPipelineForCaller({
            remoteId: GOLDEN_SHARED_REMOTE_ID,
          }),
      ],
      [
        PIPELINE_CHANNELS.DISCOVER_PROJECT,
        [world.worktreePath],
        () => pipelines.discoverProjectPipelinesForCaller(world.worktreePath),
      ],
      [
        PIPELINE_CHANNELS.DISCOVER_PROJECT,
        ['relative/path'],
        () => pipelines.discoverProjectPipelinesForCaller('relative/path'),
      ],
      [
        IPC_CHANNELS.worktreeGetPath,
        [{ projectId: GOLDEN_WORKSPACE_ID, worktreeId: GOLDEN_WORKTREE_ID }],
        () =>
          Promise.resolve(
            openIn.getWorktreePathForCaller({
              projectId: GOLDEN_WORKSPACE_ID,
              worktreeId: GOLDEN_WORKTREE_ID,
            }),
          ),
      ],
      [
        IPC_CHANNELS.workspaceReadSettingsData,
        [{ workspaceId: GOLDEN_WORKSPACE_ID }],
        () =>
          workspaces.readWorkspaceSettingsDataForCaller({
            workspaceId: GOLDEN_WORKSPACE_ID,
          }),
      ],
      [
        IPC_CHANNELS.automationsList,
        [{ scope: 'selected-context' }],
        () =>
          automations.listAutomationsForCaller({ scope: 'selected-context' }),
      ],
      [
        IPC_CHANNELS.automationsSharedList,
        [{}],
        () => automations.listSharedAutomationsForCaller({}),
      ],
      [
        IPC_CHANNELS.automationsSharedGet,
        [GOLDEN_AUTOMATION_SHARE_ID],
        () =>
          automations.getSharedAutomationForCaller(GOLDEN_AUTOMATION_SHARE_ID),
      ],
      [
        IPC_CHANNELS.automationsSharedPipelinePinResolve,
        [{ remoteId: GOLDEN_SHARED_REMOTE_ID }],
        () =>
          automations.resolveSharedPipelinePinForCaller({
            remoteId: GOLDEN_SHARED_REMOTE_ID,
          }),
      ],
    ];
    // The first list starts the once-only curated catalog sync; settle it so
    // both calls see the same catalog.
    await invokeIpc(PIPELINE_CHANNELS.LIST);
    for (const [channel, args, owner] of cases) {
      const fromWindow = await capture(() => invokeIpc(channel, ...args));
      expect([channel, await capture(owner)]).toEqual([channel, fromWindow]);
    }
  });
});
