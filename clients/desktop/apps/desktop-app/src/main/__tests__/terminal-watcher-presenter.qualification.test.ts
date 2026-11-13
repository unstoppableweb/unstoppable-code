import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
jest.mock('../services/chat-service', () => ({}));

import { getAppAdvisorWatcherService } from '../app-advisor/watchers';

const destination = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'terminal-chat',
};
const sendCommand = jest.fn<boolean, [ChatWindowCommand]>();
const deliver = jest.fn<
  ReturnType<AppAdvisorWatcherSurfaces['deliverWatcherMessage']>,
  Parameters<AppAdvisorWatcherSurfaces['deliverWatcherMessage']>
>();
const service = getAppAdvisorWatcherService();
const storedWatcherSchema = z.object({
  id: z.string(),
  status: z.string(),
  deliveryError: z.string().optional(),
  pendingLocalDelivery: z.object({ deliveryId: z.string() }).optional(),
  runtimeState: z
    .object({
      kind: z.string(),
      pendingDelivery: z
        .object({ attempts: z.number(), nextAttemptAt: z.string() })
        .optional(),
    })
    .optional(),
});
type StoredWatcher = z.infer<typeof storedWatcherSchema>;

function watcher(): AppAdvisorWatcher {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: 'watcher-presenter',
    trigger: 'worktree_pipeline_completion',
    status: 'active',
    label: 'Pipeline completion',
    target: {
      kind: 'worktree_pipeline',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      executionId: 'exec-1',
    },
    destination,
    createdAt: now,
    updatedAt: now,
    dedupeKey: 'presenter-qualification',
    createdByToolUseId: 'tool-presenter',
  };
}

async function stored(): Promise<StoredWatcher[]> {
  const parsed = z
    .object({ watchers: z.array(storedWatcherSchema) })
    .parse(
      JSON.parse(
        await readFile(
          join(mockDirectory, 'app-advisor-watchers.json'),
          'utf8',
        ),
      ),
    );
  return parsed.watchers;
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

function pipelineEvent(status: 'paused' | 'success'): ExecutionEvent {
  return {
    type: status === 'paused' ? 'execution.paused' : 'execution.completed',
    executionId: 'exec-1',
    timestamp: new Date().toISOString(),
    state: {
      version: 4,
      id: 'exec-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: normalizePipeline({
        name: 'Pipeline',
        on: 'dispatch',
        jobs: {},
      }),
      status,
      jobs: {},
      job_definitions: {},
      job_groups: {},
      pending_pauses: [],
      status_reasons: [],
      started_at: new Date().toISOString(),
      cwd: mockDirectory,
      env: {},
      inputs: {},
      project_id: 'project-1',
      worktree_id: 'worktree-1',
    },
  };
}

async function holdPipeline(
  event = pipelineEvent('success'),
): Promise<StoredWatcher> {
  await seed(watcher());
  await service.handlePipelineTerminalEvent(event);
  const [row] = await stored();
  if (!row) throw new Error('No stored watcher.');
  expect(row.status).toBe('firing');
  expect(row.pendingLocalDelivery?.deliveryId).toEqual(expect.any(String));
  expect(row.deliveryError).toBeUndefined();
  return row;
}

beforeEach(async () => {
  mockDirectory = await mkdtemp(join(tmpdir(), 'terminal-presenter-'));
  sendCommand.mockReset().mockReturnValue(false);
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
  jest.useRealTimers();
  await rm(mockDirectory, { recursive: true, force: true });
});

it('holds a terminal chat delivery until a window can present it', async () => {
  const row = await holdPipeline();
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
  expect(sendCommand.mock.calls.at(-1)?.[0]).toMatchObject({
    type: 'send_watcher_message',
    deliveryId: row.pendingLocalDelivery?.deliveryId,
  });
  expect(await service.list(destination)).toEqual([]);
  expect(await service.listCompleted()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: row.id, status: 'fired' }),
    ]),
  );
});

it('reconciles pipeline completion after replaying a presenter-held pause', async () => {
  const row = await holdPipeline(pipelineEvent('paused'));
  const completed = pipelineEvent('success');
  completed.state.completed_at = new Date(Date.now() + 1_000).toISOString();
  await mkdir(join(mockDirectory, 'pipeline-executions'));
  await writeFile(
    join(mockDirectory, 'pipeline-executions', 'exec-1.json'),
    JSON.stringify(completed.state),
  );
  await service.handlePipelineTerminalEvent(completed);
  const calls = sendCommand.mock.calls.length;
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
  const commands = sendCommand.mock.calls
    .slice(calls)
    .map(([command]) => command);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({
    type: 'send_watcher_message',
    deliveryId: row.pendingLocalDelivery?.deliveryId,
  });
  const terminal = commands[1];
  if (terminal?.type !== 'send_watcher_message')
    throw new Error('No terminal delivery.');
  expect(terminal.deliveryId).not.toBe(row.pendingLocalDelivery?.deliveryId);
  expect((await stored())[0]?.status).toBe('fired');
});

it('releases chat authority when a held delivery resumes and the renderer refuses it', async () => {
  const row = watcher();
  row.trigger = 'worktree_new_chat_started';
  row.target = {
    kind: 'worktree_chat_scope',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
  };
  await seed(row);
  const now = new Date().toISOString();
  await service.handleCanonicalChatStartedEvent({
    kind: 'started',
    eventId: 'presenter-started',
    address: {
      projectId: 'project-1',
      taskId: 'worktree-1',
      chatId: 'source-chat',
    },
    sourceInputId: 'input-1',
    occurredAt: now,
    observedAt: now,
    evidence: { sourceOwner: null, resourceIncarnation: 'presenter-test' },
  });
  await service.whenChatDeliveriesSettled();
  const [held] = await stored();
  expect(held?.status).toBe('firing');
  expect(held?.pendingLocalDelivery?.deliveryId).toEqual(expect.any(String));
  sendCommand.mockImplementation((command) => {
    if (command.type === 'send_watcher_message')
      queueMicrotask(() =>
        service.acknowledgeWatcherMessageDelivery(
          command.watcherId,
          command.deliveryId,
          { ok: false, error: 'Renderer refused the delivery.' },
        ),
      );
    return true;
  });
  await service.resumePresenterHeldDeliveries();
  expect(sendCommand.mock.calls.at(-1)?.[0]).toMatchObject({
    type: 'send_watcher_message',
    deliveryId: held?.pendingLocalDelivery?.deliveryId,
  });
  expect((await stored())[0]?.status).toBe('delivery_failed');
  const sidecar = z
    .object({
      watchers: z.array(
        z.object({ kind: z.string(), released: z.boolean().optional() }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          join(mockDirectory, 'app-advisor-watchers-canonical.json'),
          'utf8',
        ),
      ),
    );
  expect(sidecar.watchers).toEqual([
    expect.objectContaining({
      kind: 'chat_delivery_authority',
      released: true,
    }),
  ]);
});

it.each(['user', 'agent'] as const)(
  'drops a held delivery when its watcher is deleted by the %s',
  async (actor) => {
    const row = await holdPipeline();
    if (actor === 'user')
      expect(await service.deleteWatcher(row.id)).toBe(true);
    else
      expect(
        await service.deleteAgentWatchers(
          { watcherIds: [row.id] },
          destination,
        ),
      ).toMatchObject({
        ok: true,
        results: [{ watcherId: row.id, status: 'deleted' }],
      });
    const calls = sendCommand.mock.calls.length;
    await service.resumePresenterHeldDeliveries();
    await service.resumePresenterHeldDeliveries();
    expect(sendCommand).toHaveBeenCalledTimes(calls);
    expect(await stored()).toEqual([]);
  },
);

it('deletes a presenter-held watcher when its deletion notice has no window', async () => {
  const row = await holdPipeline();
  await expect(
    service.deleteWatcher(row.id, { notifySubscriber: true }),
  ).resolves.toBe(true);
  const calls = sendCommand.mock.calls.length;
  await service.resumePresenterHeldDeliveries();
  expect(sendCommand).toHaveBeenCalledTimes(calls);
  expect(await stored()).toEqual([]);
});

it('makes a racing held retry and retry-after-delete no-ops and releases authority', async () => {
  const row = await holdPipeline();
  const deliveryId = row.pendingLocalDelivery?.deliveryId;
  await writeFile(
    join(mockDirectory, 'app-advisor-watchers-canonical.json'),
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      watchers: [
        {
          kind: 'chat_delivery_authority',
          watcher: {
            ...watcher(),
            status: 'fired',
            chatDeliveryId: deliveryId,
          },
        },
      ],
    }),
  );
  const calls = sendCommand.mock.calls.length;
  const deletion = service.deleteWatcher(row.id);
  const racingRetry = service.resumePresenterHeldDeliveries();
  expect(await deletion).toBe(true);
  await racingRetry;
  await service.resumePresenterHeldDeliveries();
  expect(sendCommand).toHaveBeenCalledTimes(calls);
  expect(await stored()).toEqual([]);
  const sidecar = z
    .object({
      watchers: z.array(
        z.object({ kind: z.string(), released: z.boolean().optional() }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(
          join(mockDirectory, 'app-advisor-watchers-canonical.json'),
          'utf8',
        ),
      ),
    );
  expect(sidecar.watchers).toEqual([
    expect.objectContaining({
      kind: 'chat_delivery_authority',
      released: true,
    }),
  ]);
});

it('keeps user and agent deletion busy while a resumed attempt is in flight', async () => {
  const row = await holdPipeline();
  let sent: ((command: ChatWindowCommand) => void) | undefined;
  const commandSent = new Promise<ChatWindowCommand>((resolve) => {
    sent = resolve;
  });
  sendCommand.mockImplementation((command) => {
    sent?.(command);
    return true;
  });
  const resuming = service.resumePresenterHeldDeliveries();
  const command = await commandSent;
  expect(await service.deleteWatcher(row.id)).toBe(false);
  expect(
    await service.deleteAgentWatchers({ watcherIds: [row.id] }, destination),
  ).toMatchObject({ results: [{ status: 'busy' }] });
  if (command.type !== 'send_watcher_message')
    throw new Error('Wrong command.');
  service.acknowledgeWatcherMessageDelivery(row.id, command.deliveryId, {
    ok: true,
  });
  await resuming;
});

it("keeps a GitHub delivery's retry budget while no window can present it", async () => {
  const now = new Date('2026-11-05T00:00:00.000Z');
  jest.useFakeTimers({
    now,
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setImmediate',
      'nextTick',
      'queueMicrotask',
      'performance',
    ],
  });
  const row = watcher();
  row.trigger = 'github_pull_requests_changed';
  row.target = {
    kind: 'github_pull_requests',
    items: [{ kind: 'pull_request', repository: 'owner/repo', number: 1 }],
    display: {
      repositories: ['owner/repo'],
      sample: [{ repository: 'owner/repo', number: 1 }],
    },
  };
  row.runtimeState = {
    kind: 'github_pull_requests',
    items: [
      {
        key: 'owner/repo#1',
        settledAt: now.toISOString(),
        settledAs: 'merged',
        last: {
          state: 'merged',
          url: 'https://github.com/owner/repo/pull/1',
          baseRefName: 'develop',
          headSha: 'abc',
          mergedAt: now.toISOString(),
          mergeCommitSha: 'def',
          closedAt: now.toISOString(),
          queue: null,
          observedAt: now.toISOString(),
        },
      },
    ],
    queuedEvents: [
      {
        kind: 'pull_request_merged',
        repository: 'owner/repo',
        number: 1,
        url: 'https://github.com/owner/repo/pull/1',
        baseBranch: 'develop',
        headSha: 'abc',
        mergedAt: now.toISOString(),
        mergeCommitSha: 'def',
      },
    ],
  };
  await seed(row);
  await service.applyGitHubPullRequestObservation({ observations: [] });
  let saved: StoredWatcher | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    [saved] = await stored();
    if (
      saved?.runtimeState?.kind === 'github_pull_requests' &&
      saved.runtimeState.pendingDelivery?.nextAttemptAt !== now.toISOString()
    )
      break;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(saved?.status).toBe('firing');
  expect(saved?.runtimeState).toMatchObject({
    kind: 'github_pull_requests',
    pendingDelivery: {
      attempts: 0,
      nextAttemptAt: new Date(now.getTime() + 60_000).toISOString(),
    },
  });
});
