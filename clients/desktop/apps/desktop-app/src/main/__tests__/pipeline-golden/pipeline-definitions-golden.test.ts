// CAN-5061 golden: pipeline definition list, get and validate results and
// error shapes for every source kind (bundled, user, project, shared and
// curated), through desktop IPC, Portal commands and agent actions. Captured
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
import { readFileSync, rmSync } from 'node:fs';
import { app } from 'electron';
import * as storeModule from '@canopy/execution-engine/pipelines/store';
import * as pipelineInstallContext from '../../pipelines/pipeline-install-context';
import * as resourceLanes from '../../pipelines/resource-lanes';
import { PIPELINE_GRANTS } from '@canopy/protocol/canopy-core';
import { readPreferencesFile } from '../../lib/preferences-store';
import {
  getTriggerInputDefs,
  setTriggerInputDefs,
  setTriggerTypes,
  type IPCResult,
  type PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import {
  readPipelineLocalMetadata,
  setUserPipelineAgentAuthor,
  setUserPipelineNativeGrant,
  setUserPipelineOwnerAutomation,
} from '../../pipelines/pipeline-local-metadata-store';
import {
  IPC_CHANNELS,
  type ScheduledActivity,
} from '@canopy/desktop-shared/types';
import {
  scheduledUserPipelineId,
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
import { getPipelinePackageInstallStorePath } from '../../lib/paths';
import * as advisorAccess from '../../lib/app-advisor-project-agent-access';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
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
  runPortalCommand,
  type GoldenIpcHandler,
} from './harness';
import {
  createPipelineGoldenWorld,
  GOLDEN_AUTOMATION_ENTRY_KEY,
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
  // Write effects persist Portal state under userData, which the Electron
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

describe('Portal', () => {
  it('lists and gets each source kind for a routed worktree', async () => {
    const get = (
      pipelineId: string,
      extra: Record<string, unknown> = {},
    ): Promise<unknown> =>
      runPortalCommand('portal.pipeline.get', {
        pipelineId,
        projectId: GOLDEN_WORKSPACE_ID,
        worktreeId: GOLDEN_WORKTREE_ID,
        ...extra,
      });
    expect(
      await captureAll({
        list: () =>
          runPortalCommand('portal.pipeline.list', {
            projectId: GOLDEN_WORKSPACE_ID,
            worktreeId: GOLDEN_WORKTREE_ID,
          }),
        listDefaultWorktree: () =>
          runPortalCommand('portal.pipeline.list', {
            projectId: GOLDEN_WORKSPACE_ID,
          }),
        listWithoutProject: () => runPortalCommand('portal.pipeline.list', {}),
        listUnknownWorktree: () =>
          runPortalCommand('portal.pipeline.list', {
            projectId: GOLDEN_WORKSPACE_ID,
            worktreeId: 'missing-wt',
          }),
        listInvalidWorktree: () =>
          runPortalCommand('portal.pipeline.list', {
            projectId: GOLDEN_WORKSPACE_ID,
            worktreeId: '../escape',
          }),
        getUser: () => get(world.userPipelineId),
        getBundled: () => get(GOLDEN_BUNDLED_PIPELINE_ID),
        getProject: () => get(GOLDEN_PROJECT_PIPELINE_ID),
        getShared: () => get(`shared:canopy-cloud:${GOLDEN_SHARED_REMOTE_ID}`),
        getSharedDispatchOnly: () =>
          get(`shared:canopy-cloud:${GOLDEN_SHARED_DISPATCH_REMOTE_ID}`),
        getCurated: () => get(`curated:${GOLDEN_CURATED_KEY}`),
        getMissing: () => get('missing-pipeline'),
        getWithoutWorktree: () =>
          runPortalCommand('portal.pipeline.get', {
            pipelineId: world.userPipelineId,
            projectId: GOLDEN_WORKSPACE_ID,
          }),
        getInvalidPayload: () =>
          runPortalCommand('portal.pipeline.get', { pipelineId: 7 }),
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
});

// CAN-5368: duplicates, enablement and replay go through core too.
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
      portal: await capturedInstall(
        () =>
          runPortalCommand('portal.pipeline.install_curated', {
            key: GOLDEN_CURATED_KEY,
            expectedContentHash: curatedHash,
          }),
        (value) => {
          const payload = (value as { payload?: { result?: unknown } }).payload;
          const result = payload?.result as { pipelineId?: string } | undefined;
          return result?.pipelineId;
        },
      ),
      portalStale: await capturedInstall(
        () =>
          runPortalCommand('portal.pipeline.install_curated', {
            key: GOLDEN_CURATED_KEY,
            expectedContentHash: '0'.repeat(64),
          }),
        () => undefined,
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

  it('reads and lists a workflow pipeline and keeps it off the Portal', async () => {
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
    // Only this test's rows, with the triggers the Portal reports for them.
    const portalRows = async (): Promise<unknown> => {
      const listed: unknown = await runPortalCommand('portal.pipeline.list', {
        projectId: GOLDEN_WORKSPACE_ID,
        worktreeId: GOLDEN_WORKTREE_ID,
      });
      const pipelines: unknown[] = [];
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(collect);
        else if (typeof value === 'object' && value !== null) {
          if ('pipelineId' in value && 'name' in value) pipelines.push(value);
          else Object.values(value).forEach(collect);
        }
      };
      collect(listed);
      return pipelines.flatMap((row) =>
        typeof row === 'object' &&
        row !== null &&
        'pipelineId' in row &&
        (row.pipelineId === workflowOnlyId || row.pipelineId === mixedId) &&
        'name' in row
          ? [
              {
                name: row.name,
                triggerTypes:
                  'triggerTypes' in row ? row.triggerTypes : undefined,
              },
            ]
          : [],
      );
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
          // Refused before any cloud request: web can't store the trigger.
          // Without resource contexts, so the refusal isn't a context check.
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
          // The share dialog's review blocks a workflow pipeline, and the
          // packaged share refuses it before any upload.
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
              const analysisId =
                'analysisId' in summary &&
                typeof summary.analysisId === 'string'
                  ? summary.analysisId
                  : '';
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
                create: await invokeIpc(
                  PIPELINE_CHANNELS.SHARED_CREATE_PACKAGED,
                  {
                    analysisId,
                    rawPipeline: WORKFLOW_AND_DISPATCH_YAML,
                    shareScope: 'private',
                  },
                ),
              };
            } finally {
              contexts.mockRestore();
            }
          },
          portalList: portalRows,
          // A workflow-only pipeline reads as missing on the Portal; a mixed
          // one is described by its portable triggers.
          portalGetWorkflowOnly: () =>
            runPortalCommand('portal.pipeline.get', {
              pipelineId: workflowOnlyId,
              projectId: GOLDEN_WORKSPACE_ID,
              worktreeId: GOLDEN_WORKTREE_ID,
            }),
          portalGetMixedTriggers: async () => {
            const got: unknown = await runPortalCommand('portal.pipeline.get', {
              pipelineId: mixedId,
              projectId: GOLDEN_WORKSPACE_ID,
              worktreeId: GOLDEN_WORKTREE_ID,
            });
            // Only the trigger summary: the rest is the usual definition view.
            return /"triggerSummary":"([^"]*)"/.exec(JSON.stringify(got))?.[1];
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
      setUserPipelineAgentAuthor(grantedId, author);
      const stored = getStoredPipelineBySource('user', grantedId);
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

  it('counts the workflow pages that call a pipeline through run-pipeline', async () => {
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
      }).toEqual({ saved: true, child: 1, page: null, plain: null });
    } finally {
      for (const id of [childId, pageId, plainId])
        if (id && getStoredPipeline(id).success) deleteStoredPipeline(id);
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
