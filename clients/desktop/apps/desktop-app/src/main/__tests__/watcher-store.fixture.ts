// CAN-4492: host-only mocks; watcher service, parsers, queues and installers stay real.
import { join } from 'node:path';
import type * as WaitDiagnostics from '../observability/chat-wait-diagnostics';
import type * as FileSystem from 'node:fs/promises';
import type * as DirectorySync from '../lib/fsync-directory';
import type { AppAdvisorWatcherSurfaces } from '../app-advisor/watchers';
import type { ExecutionEvent } from '@canopy/execution-engine/node/pipelines/executor';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
export let mockDirectory = process.env.CAN4492_ROOT ?? '';
export const mockEnqueued = jest.fn<void, [number]>();
export function setDirectory(root: string): void {
  mockDirectory = root;
}
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
      projectType: 'cowork',
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
        projectType: 'cowork',
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
    ): WaitDiagnostics.ChatWaitOperation => {
      const wait = actual.startChatWaitOperation({
        ...options,
        record: (): void => undefined,
      });
      const enterQueue = wait.enterQueue.bind(wait);
      jest.spyOn(wait, 'enterQueue').mockImplementation((...args) => {
        enterQueue(...args);
        mockEnqueued(args[0]);
      });
      return wait;
    },
  };
});
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    hasTranscriptMessage: (): Promise<boolean> =>
      Promise.resolve(process.env.CAN4492_COMMITTED === '1'),
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
jest.mock('../services/chat-service', () => ({}));

const actualFs = jest.requireActual<typeof FileSystem>('node:fs/promises');
export const mockRename = jest.fn(actualFs.rename);
const actualDirectorySync = jest.requireActual<typeof DirectorySync>(
  '../lib/fsync-directory',
);
export const mockDirectorySync = jest.fn(actualDirectorySync.fsyncDirectory);
jest.mock('../lib/fsync-directory', () => ({
  fsyncDirectory: (path: string): Promise<void> => mockDirectorySync(path),
}));
export function resetRename(): void {
  mockRename.mockReset().mockImplementation(actualFs.rename);
  mockDirectorySync
    .mockReset()
    .mockImplementation(actualDirectorySync.fsyncDirectory);
}
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof FileSystem>('node:fs/promises'),
  rename: (...args: Parameters<typeof actualFs.rename>): Promise<void> =>
    mockRename(...args),
}));
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
export const service = getAppAdvisorWatcherService();
export const destination = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'recipient',
};
export const deliver = jest.fn<
  ReturnType<AppAdvisorWatcherSurfaces['deliverWatcherMessage']>,
  Parameters<AppAdvisorWatcherSurfaces['deliverWatcherMessage']>
>();
export function configure(): void {
  deliver.mockReset().mockResolvedValue('submitted');
  mockEnqueued.mockReset();
  service.configure(
    {
      getMainWindow: () => null,
      getAppAdvisorWindow: () => null,
      ensureAppAdvisorWindow: () =>
        Promise.resolve({ open: false, focused: false }),
      sendAppAdvisorWindowCommand: () => undefined,
      sendChatWindowCommand: () => false,
      deliverWatcherMessage: deliver,
    },
    { deferStartupRecovery: true },
  );
}
export function register(
  canonical = false,
  key = 'registration',
):
  | ReturnType<typeof service.setupCanonicalChatWatchers>
  | ReturnType<typeof service.setup> {
  return canonical
    ? service.setupCanonicalChatWatchers({
        destination,
        recipient: { kind: 'root' },
        createdByToolUseId: key,
        watchers: [
          {
            trigger: 'project_new_chat_started',
            target: { projectId: 'project-1', taskId: 'worktree-1' },
          },
        ],
      })
    : service.setup(
        {
          watchers: [
            {
              trigger: 'worktree_pipeline_completion',
              target: {
                kind: 'worktree_pipeline',
                projectId: 'project-1',
                worktreeId: 'worktree-1',
              },
            },
          ],
        },
        destination,
        { toolUseId: key },
      );
}
export async function fire(canonical = false): Promise<void> {
  if (canonical) {
    const now = new Date().toISOString();
    await service.handleCanonicalChatStartedEvent({
      kind: 'started',
      eventId: 'source-event',
      address: {
        projectId: 'project-1',
        taskId: 'worktree-1',
        chatId: 'new-chat',
      },
      sourceInputId: 'input-1',
      occurredAt: now,
      observedAt: now,
      evidence: { sourceOwner: null, resourceIncarnation: 'presenter-test' },
    });
    await service.whenChatDeliveriesSettled();
  } else {
    const event: ExecutionEvent = {
      type: 'execution.completed',
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
        status: 'success',
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
    await service.handlePipelineTerminalEvent(event);
  }
}
