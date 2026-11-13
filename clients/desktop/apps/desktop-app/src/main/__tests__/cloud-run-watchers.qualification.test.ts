// CAN-6391 (plan CP-49): desktop chat watchers on cloud runs. The real
// watcher service fires a cloud run watcher on each new pause without
// consuming it and on a watched end, never on another run's events or on a
// local execution's; the cloud run observer looks only while a watcher is
// live (one setTimeout), skips a pause from before arming, follows later
// runs, and reports a run that can no longer be read.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type {
  AppAdvisorWatcher,
  ChatWindowCommand,
} from '@canopy/desktop-shared/types';
import type { ExecutionEvent } from '@canopy/execution-engine/node/pipelines/executor';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import type { AppAdvisorWatcherSurfaces } from '../app-advisor/watchers';
import type * as WaitDiagnostics from '../observability/chat-wait-diagnostics';
let mockDirectory = '';
jest.mock('../lib/paths', () => ({
  getAppAdvisorWatchersFilePath: (): string =>
    join(mockDirectory, 'app-advisor-watchers.json'),
  getDataDir: (): string => mockDirectory,
  getWorktreeDataDir: (): string => mockDirectory,
  getWorktreeAttachmentsDir: (): string => mockDirectory,
}));
jest.mock('../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => false,
}));
jest.mock('../app-advisor/chat-watcher-access', () => ({
  ChatWatcherAccessError: class extends Error {},
  resolveChatWatcherTarget: (): Promise<unknown> =>
    Promise.resolve({
      kind: 'project',
      projectType: 'code',
      address: { projectId: 'project-1', taskId: 'worktree-1' },
    }),
  resolveLegacyChatWatcher: (): Promise<unknown> =>
    Promise.resolve({
      ok: true,
      entry: {
        trigger: 'project_new_chat_started',
        target: { projectId: 'project-1', taskId: 'worktree-1' },
      },
      target: {
        kind: 'project',
        projectType: 'code',
        address: { projectId: 'project-1', taskId: 'worktree-1' },
      },
    }),
  decideChatWatcherAccess: (): Promise<unknown> =>
    Promise.resolve({
      allowed: true,
      sourceOwner: null,
      resourceIncarnation: 'presenter-test',
    }),
}));
jest.mock('../agents/session-manager', () => ({
  getActiveSessionInfos: (): unknown[] => [],
  getAllActiveSessionInfos: (): unknown[] => [],
}));
jest.mock('../agents/delegation/child-messages', () => ({
  ChildMessageAdmissionRefusedError: class extends Error {},
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (): Promise<unknown> =>
    Promise.resolve({ version: 1, tabs: [], activeTabId: null }),
}));
jest.mock('../lib/cowork-work-entries', () => ({}));
jest.mock('../lib/cowork-migration-map', () => ({}));
jest.mock('../lib/workspace-persistence', () => ({}));
jest.mock('../pipelines/pipeline-service', () => ({}));
jest.mock('../lib/github-broker', () => ({
  GitHubBrokerError: class extends Error {},
}));
jest.mock('../lib/github-broker/workflow-runs', () => ({}));
jest.mock('../lib/github-broker/workflow-definitions', () => ({}));
jest.mock('../lib/github-pr-read-model', () => ({}));
const mockObserver = {
  stop: (): void => undefined,
  configure: (): void => undefined,
  rescan: (): Promise<void> => Promise.resolve(),
};
jest.mock('../lib/github-workflow-run-observer', () => ({
  getGitHubWorkflowRunObserver: (): unknown => mockObserver,
}));
jest.mock('../lib/github-pull-request-observer', () => ({
  getGitHubPullRequestObserver: (): unknown => mockObserver,
}));
jest.mock('../lib/app-advisor-project-agent-access', () => ({
  onAppAdvisorProjectAgentAccessChange: (): (() => void) => (): void =>
    undefined,
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    subscribe: (): (() => void) => (): void => undefined,
  }),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({
    recordSessionDiagnostic: (): void => undefined,
  }),
}));
jest.mock('../observability/chat-wait-diagnostics', () => {
  const actual = jest.requireActual<typeof WaitDiagnostics>(
    '../observability/chat-wait-diagnostics',
  );
  return {
    ...actual,
    startChatWaitOperation: (
      options: Parameters<typeof actual.startChatWaitOperation>[0],
    ): WaitDiagnostics.ChatWaitOperation =>
      actual.startChatWaitOperation({
        ...options,
        record: (): void => undefined,
      }),
  };
});
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    hasTranscriptMessage: (): Promise<boolean> => Promise.resolve(false),
  }),
}));
jest.mock('../automations/service', () => ({
  getAutomationsService: (): unknown => ({
    list: (): Promise<unknown> =>
      Promise.resolve({ activities: [], recentRuns: [] }),
    listRuns: (): Promise<unknown> =>
      Promise.resolve({ runs: [], nextCursor: null }),
  }),
}));
jest.mock('../portal/portal-event-bus', () => ({
  isCanopyPortalActive: (): boolean => false,
}));
let mockRunOwner: { owner: string } | { refusal: string } = {
  owner: 'personal',
};
jest.mock('../pipelines/pipeline-owner-policy', () => ({
  agentPipelineOwnerContext: (): Promise<unknown> =>
    Promise.resolve(mockRunOwner),
}));
import type { CloudRunAccess } from '@canopy/agent-actions';
import type { WorkerPipelineExecutionView } from '@canopy/protocol/canopy-core';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import {
  CLOUD_RUN_WATCHER_POLL_MS,
  CloudRunWatcherObserver,
  cloudRunOwnerResource,
  cloudRunWatcherResource,
  getCloudRunWatcherObserver,
  type AppAdvisorCloudRunEvent,
  type CloudRunWatchSubscription,
} from '../app-advisor/cloud-run-watchers';

const destination = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};
const sendCommand = jest.fn<boolean, [ChatWindowCommand]>();
const deliver = jest.fn<
  ReturnType<AppAdvisorWatcherSurfaces['deliverWatcherMessage']>,
  Parameters<AppAdvisorWatcherSurfaces['deliverWatcherMessage']>
>();
const service = getAppAdvisorWatcherService();

type PipelineTarget = Extract<
  AppAdvisorWatcher['target'],
  { kind: 'worktree_pipeline' }
>;

function cloudWatcher(
  target: Partial<Omit<PipelineTarget, 'kind'>> = {},
): AppAdvisorWatcher {
  const now = new Date(Date.now() - 60_000).toISOString();
  const pipeline: PipelineTarget = {
    kind: 'worktree_pipeline',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    executionId: 'run-1',
    runOn: 'cloud',
    ...target,
  };
  return {
    version: 1,
    id: 'watcher-cloud',
    trigger: 'worktree_pipeline_completion',
    status: 'active',
    label: 'Cloud run',
    target: pipeline,
    destination,
    createdAt: now,
    updatedAt: now,
    dedupeKey: 'cloud-run-qualification',
    createdByToolUseId: 'tool-cloud',
  };
}

async function seed(row: AppAdvisorWatcher): Promise<void> {
  await writeFile(
    join(mockDirectory, 'app-advisor-watchers.json'),
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      watchers: [row],
    }),
  );
}

const storedSchema = z.object({
  watchers: z.array(
    z.object({
      status: z.string(),
      observedPipelinePauses: z.record(z.string(), z.string()).optional(),
      pendingLocalDelivery: z
        .object({ cloudRunOwner: z.string().optional() })
        .optional(),
    }),
  ),
});

async function stored(): Promise<z.infer<typeof storedSchema>['watchers']> {
  return storedSchema.parse(
    JSON.parse(
      await readFile(join(mockDirectory, 'app-advisor-watchers.json'), 'utf8'),
    ),
  ).watchers;
}

function event(
  status: AppAdvisorCloudRunEvent['status'],
  pauseKey?: string,
  executionId = 'run-1',
): AppAdvisorCloudRunEvent {
  return {
    type: status === 'paused' ? 'cloud_run.paused' : 'cloud_run.completed',
    runOn: 'cloud',
    executionId,
    pipelineId: 'p1',
    pipelineName: 'Flow',
    status,
    ...(pauseKey ? { pauseKey, pendingPauseCount: 1 } : {}),
    timestamp: new Date().toISOString(),
  };
}

function watcherMessages(): ChatWindowCommand[] {
  return sendCommand.mock.calls
    .map(([command]) => command)
    .filter((command) => command.type === 'send_watcher_message');
}

beforeEach(async () => {
  mockDirectory = await mkdtemp(join(tmpdir(), 'cloud-run-watchers-'));
  sendCommand.mockReset().mockImplementation((command) => {
    if (command.type === 'send_watcher_message')
      queueMicrotask(() =>
        service.acknowledgeWatcherMessageDelivery(
          command.watcherId,
          command.deliveryId,
          { ok: true },
        ),
      );
    return true;
  });
  deliver.mockReset().mockResolvedValue('terminal_presenter');
  service.configure(
    {
      getMainWindow: (): null => null,
      getAppAdvisorWindow: (): null => null,
      ensureAppAdvisorWindow: (): Promise<{
        open: boolean;
        focused: boolean;
      }> => Promise.resolve({ open: false, focused: false }),
      sendAppAdvisorWindowCommand: (): void => undefined,
      sendChatWindowCommand: sendCommand,
      deliverWatcherMessage: deliver,
    },
    { deferStartupRecovery: true },
  );
});

afterEach(async () => {
  service.shutdown();
  await service.drain();
  await rm(mockDirectory, { recursive: true, force: true });
});

it('reports a cloud pause once without consuming the watcher, then its end', async () => {
  await seed(cloudWatcher());
  expect(await service.listCloudRunWatchSubscriptions()).toEqual([
    expect.objectContaining({
      watcherId: 'watcher-cloud',
      executionId: 'run-1',
      projectId: 'project-1',
      reportedPauses: {},
    }),
  ]);
  await service.handleCloudRunEvent('watcher-cloud', event('paused', 'k1'));
  await service.drain();
  expect((await stored())[0]).toMatchObject({
    status: 'active',
    observedPipelinePauses: { 'run-1': 'k1' },
  });
  expect(watcherMessages()).toHaveLength(1);
  const notice = JSON.stringify(watcherMessages()[0]);
  expect(notice).toContain('cloud_run.paused');
  expect(notice).not.toContain('pauseKey');

  await service.handleCloudRunEvent('watcher-cloud', event('paused', 'k1'));
  await service.handleCloudRunEvent(
    'watcher-cloud',
    event('success', undefined, 'run-2'),
  );
  await service.drain();
  expect(watcherMessages()).toHaveLength(1);

  await service.handleCloudRunEvent('watcher-cloud', event('success'));
  await service.drain();
  expect((await stored())[0]?.status).toBe('fired');
  expect(watcherMessages()).toHaveLength(2);
  expect(await service.listCloudRunWatchSubscriptions()).toEqual([]);
});

it('never fires a cloud watcher on a local execution, nor a local one on a cloud run', async () => {
  await seed(
    cloudWatcher({ executionId: undefined, pipelineId: 'pipeline-1' }),
  );
  const completedAt = new Date().toISOString();
  await service.handlePipelineTerminalEvent({
    type: 'execution.completed',
    executionId: 'exec-1',
    timestamp: completedAt,
    state: {
      version: 4,
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: normalizePipeline({
        name: 'Pipeline',
        on: 'dispatch',
        jobs: {},
      }),
      status: 'success',
      jobs: {},
      job_definitions: {},
      job_groups: {},
      pending_pauses: [],
      status_reasons: [],
      started_at: completedAt,
      cwd: mockDirectory,
      env: {},
      inputs: {},
      project_id: 'project-1',
      worktree_id: 'worktree-1',
    },
  } satisfies ExecutionEvent);
  await service.drain();
  expect((await stored())[0]?.status).toBe('active');

  await seed(cloudWatcher({ runOn: undefined }));
  await service.handleCloudRunEvent('watcher-cloud', event('success'));
  await service.drain();
  expect((await stored())[0]?.status).toBe('active');
  expect(await service.listCloudRunWatchSubscriptions()).toEqual([]);
});

it('ignores a terminal status the watcher does not watch', async () => {
  await seed(cloudWatcher({ terminalStatuses: ['success'] }));
  await service.handleCloudRunEvent('watcher-cloud', event('failure'));
  await service.drain();
  expect((await stored())[0]?.status).toBe('active');
});

it('authorizes a cloud run as its project owner, and an unknown owner as unknown', async () => {
  const target = { projectId: 'project-1', worktreeId: 'worktree-1' };
  mockRunOwner = { owner: 'personal' };
  expect(await cloudRunWatcherResource(target)).toEqual({
    owner: { shareScope: 'private' },
  });
  mockRunOwner = { owner: 'org:11111111-1111-4111-8111-111111111111' };
  expect(await cloudRunWatcherResource(target)).toEqual({
    owner: {
      type: 'organization',
      id: '11111111-1111-4111-8111-111111111111',
      name: null,
    },
  });
  mockRunOwner = { refusal: 'unknown' };
  expect(await cloudRunWatcherResource(target)).toEqual({ owner: undefined });
  mockRunOwner = { owner: 'personal' };
});

it('authorizes a queued notice as the owner its run was recorded with', async () => {
  await seed(cloudWatcher());
  sendCommand.mockReturnValue(false);
  await service.handleCloudRunEvent('watcher-cloud', {
    ...event('paused', 'k1'),
    owner: 'org:11111111-1111-4111-8111-111111111111',
  });
  await service.drain();
  expect((await stored())[0]?.pendingLocalDelivery?.cloudRunOwner).toBe(
    'org:11111111-1111-4111-8111-111111111111',
  );
  // Whoever owns the project when the notice is retried.
  mockRunOwner = { owner: 'personal' };
  expect(
    cloudRunOwnerResource('org:11111111-1111-4111-8111-111111111111'),
  ).toEqual({
    owner: {
      type: 'organization',
      id: '11111111-1111-4111-8111-111111111111',
      name: null,
    },
  });
  expect(cloudRunOwnerResource('not-an-owner')).toEqual({ owner: undefined });
});

it('looks at cloud runs again once a held pause delivery is presented', async () => {
  await seed(cloudWatcher());
  sendCommand.mockReturnValue(false);
  await service.handleCloudRunEvent('watcher-cloud', event('paused', 'k1'));
  await service.drain();
  expect((await stored())[0]?.status).toBe('firing');
  // Held, not dropped: the observer keeps the runs it tracks.
  expect(await service.listCloudRunWatchSubscriptions()).toEqual([
    expect.objectContaining({ watcherId: 'watcher-cloud', held: true }),
  ]);
  const rescan = jest.spyOn(getCloudRunWatcherObserver(), 'rescan');
  sendCommand.mockImplementation((command) => {
    if (command.type === 'send_watcher_message')
      queueMicrotask(() =>
        service.acknowledgeWatcherMessageDelivery(
          command.watcherId,
          command.deliveryId,
          { ok: true },
        ),
      );
    return true;
  });
  await service.resumePresenterHeldDeliveries();
  await service.drain();
  expect((await stored())[0]?.status).toBe('active');
  expect(rescan).toHaveBeenCalled();
  expect(await service.listCloudRunWatchSubscriptions()).toEqual([
    expect.not.objectContaining({ held: true }),
  ]);
  rescan.mockRestore();
});

describe('observer', () => {
  const armedAt = '2026-11-11T12:00:00.000Z';

  function view(
    executionId: string,
    status: WorkerPipelineExecutionView['execution']['status'],
    startedAt: string,
    pausedAt: string | null = null,
    worktreeId = 'worktree-1',
  ): WorkerPipelineExecutionView {
    return {
      execution: {
        executionId,
        pipelineId: 'p1',
        name: 'Flow',
        status,
        runScope: 'global',
        definitionSource: 'curated',
        owner: 'personal',
        workspaceId: null,
        worktreeId: null,
        parentExecutionId: null,
        startedAt,
        completedAt: null,
        pendingPauseCount: pausedAt === null ? 0 : 1,
        error: null,
      },
      detail: {
        revision: 'a'.repeat(64),
        definition: { contentHash: null, revision: null, packageDigest: null },
        initiation: {
          source: 'app_advisor',
          initiator: {
            kind: 'agent',
            chat: { projectId: 'project-1', worktreeId, chatId: 'chat-1' },
          },
          hook: null,
          event: null,
          rerunSourceId: null,
          parentStep: null,
        },
        rerun: {
          inputsPersisted: false,
          planReadyText: false,
          taskReadyText: false,
        },
        hidden: false,
        pausedAt,
        pausedMs: 0,
        plan: null,
        artifacts: [],
        jobs: [],
        pendingPauses:
          pausedAt === null
            ? []
            : [
                {
                  id: `pause-${executionId}-${pausedAt}`,
                  kind: 'action',
                  jobId: 'job',
                  logicalJobId: 'job',
                  stepId: 'step',
                  attempt: 0,
                  iteration: 1,
                  detectedAt: pausedAt,
                },
              ],
        statusReasons: [],
      },
    };
  }

  class NotFound extends Error {}

  function harness(
    runs: Map<string, WorkerPipelineExecutionView>,
    subscriptions: CloudRunWatchSubscription[],
  ): {
    observer: CloudRunWatcherObserver;
    applied: Array<[string, AppAdvisorCloudRunEvent]>;
  } {
    const applied: Array<[string, AppAdvisorCloudRunEvent]> = [];
    const answer = (
      method: string,
      params: Record<string, unknown>,
    ): unknown => {
      if (method === 'worker.pipeline.execution.get') {
        const run =
          typeof params.executionId === 'string'
            ? runs.get(params.executionId)
            : undefined;
        if (run === undefined) throw new NotFound('not found');
        return run;
      }
      const all = [...runs.values()].sort((left, right) =>
        right.execution.startedAt.localeCompare(left.execution.startedAt),
      );
      const start = Number(params.cursor ?? '0');
      const end = start + Number(params.limit ?? 100);
      return {
        executions: all.slice(start, end),
        nextCursor: end < all.length ? String(end) : null,
      };
    };
    const access: CloudRunAccess = {
      call: (method, params, result) =>
        Promise.resolve().then(() => result.parse(answer(method, params))),
      payloadOf: (error) =>
        error instanceof NotFound
          ? {
              kind: 'not_found',
              message: error.message,
              retry: { kind: 'never' },
            }
          : null,
      reaches: () => true,
      notFoundMessage: (executionId) => `No run ${executionId}.`,
    };
    const observer = new CloudRunWatcherObserver({
      available: (): Promise<boolean> => Promise.resolve(true),
      access: (): Promise<CloudRunAccess> => Promise.resolve(access),
    });
    observer.configure({
      listSubscriptions: () => Promise.resolve(subscriptions),
      applyEvent: (watcherId, fired) => {
        applied.push([watcherId, fired]);
        return Promise.resolve();
      },
    });
    return { observer, applied };
  }

  function subscription(
    watcherId: string,
    fields: Partial<CloudRunWatchSubscription> = {},
  ): CloudRunWatchSubscription {
    return {
      watcherId,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      terminalStatuses: [],
      armedAt,
      reportedPauses: {},
      ...fields,
    };
  }

  it('arms its one setTimeout only while a cloud run watcher is live', async () => {
    const timers = jest.spyOn(global, 'setTimeout');
    const live: CloudRunWatchSubscription[] = [];
    const { observer } = harness(new Map(), live);
    const armed = (): number =>
      timers.mock.calls.filter(
        ([, delay]) => delay === CLOUD_RUN_WATCHER_POLL_MS,
      ).length;
    await observer.rescan();
    expect(armed()).toBe(0);
    live.push(subscription('w', { executionId: 'r' }));
    await observer.rescan();
    await observer.rescan();
    expect(armed()).toBe(1);
    observer.stop();
    timers.mockRestore();
  });

  it('skips a pause from before arming, reports a later one, and a gone run as unavailable', async () => {
    const runs = new Map([
      [
        'r1',
        view(
          'r1',
          'paused',
          '2026-11-11T11:00:00.000Z',
          '2026-11-11T11:30:00.000Z',
        ),
      ],
    ]);
    const { observer, applied } = harness(runs, [
      subscription('w1', { executionId: 'r1' }),
      subscription('w2', { executionId: 'gone' }),
    ]);
    await observer.poll();
    expect(applied.map(([id, fired]) => [id, fired.status])).toEqual([
      ['w2', 'unavailable'],
    ]);
    runs.set(
      'r1',
      view(
        'r1',
        'paused',
        '2026-11-11T11:00:00.000Z',
        '2026-11-11T12:30:00.000Z',
      ),
    );
    await observer.poll();
    const paused = applied.find(([id]) => id === 'w1')?.[1];
    expect(paused).toMatchObject({
      type: 'cloud_run.paused',
      status: 'paused',
      pendingPauseCount: 1,
      owner: 'personal',
    });
    expect(typeof paused?.pauseKey).toBe('string');
    observer.stop();
  });

  it('follows later runs and stops reading a watched run that ended unwatched', async () => {
    const runs = new Map([
      ['old', view('old', 'success', '2026-11-11T11:00:00.000Z')],
      ['new', view('new', 'failure', '2026-11-11T12:10:00.000Z')],
      // Another task's chat started this one, so the later-runs watcher
      // passes it over (CAN-6391).
      [
        'elsewhere',
        view(
          'elsewhere',
          'success',
          '2026-11-11T12:05:00.000Z',
          null,
          'worktree-2',
        ),
      ],
    ]);
    const { observer, applied } = harness(runs, [
      subscription('later', {
        pipelineId: 'p1',
        terminalStatuses: ['success'],
      }),
      subscription('one', {
        executionId: 'new',
        terminalStatuses: ['success'],
      }),
    ]);
    await observer.poll();
    expect(applied).toEqual([]);
    runs.set('newer', view('newer', 'success', '2026-11-11T12:20:00.000Z'));
    await observer.poll();
    expect(
      applied.map(([id, fired]) => [id, fired.executionId, fired.status]),
    ).toEqual([['later', 'newer', 'success']]);
    observer.stop();
  });

  it('keeps reading a live later run that newer runs push past the listed pages', async () => {
    const runs = new Map([
      ['mine', view('mine', 'running', '2026-11-11T12:01:00.000Z')],
    ]);
    const { observer, applied } = harness(runs, [
      subscription('later', { terminalStatuses: ['success'] }),
    ]);
    await observer.poll();
    expect(applied).toEqual([]);
    for (let index = 0; index < 250; index += 1) {
      const startedAt = new Date(
        Date.parse('2026-11-11T12:02:00.000Z') + index * 1000,
      ).toISOString();
      runs.set(
        `other-${String(index)}`,
        view(`other-${String(index)}`, 'running', startedAt),
      );
    }
    runs.set('mine', view('mine', 'success', '2026-11-11T12:01:00.000Z'));
    await observer.poll();
    expect(
      applied.map(([id, fired]) => [id, fired.executionId, fired.status]),
    ).toEqual([['later', 'mine', 'success']]);
    observer.stop();
  });

  it('keeps the tracked runs of a held watcher and reads them once it is live again', async () => {
    const runs = new Map([
      ['mine', view('mine', 'running', '2026-11-11T12:01:00.000Z')],
    ]);
    const live: CloudRunWatchSubscription[] = [
      subscription('later', { terminalStatuses: ['success'] }),
    ];
    const { observer, applied } = harness(runs, live);
    await observer.poll();
    live[0] = {
      ...subscription('later', { terminalStatuses: ['success'] }),
      held: true,
    };
    for (let index = 0; index < 250; index += 1) {
      const startedAt = new Date(
        Date.parse('2026-11-11T12:02:00.000Z') + index * 1000,
      ).toISOString();
      runs.set(
        `other-${String(index)}`,
        view(`other-${String(index)}`, 'running', startedAt),
      );
    }
    runs.set('mine', view('mine', 'success', '2026-11-11T12:01:00.000Z'));
    await observer.poll();
    expect(applied).toEqual([]);
    live[0] = subscription('later', { terminalStatuses: ['success'] });
    await observer.poll();
    expect(
      applied.map(([id, fired]) => [id, fired.executionId, fired.status]),
    ).toEqual([['later', 'mine', 'success']]);
    observer.stop();
  });
});
