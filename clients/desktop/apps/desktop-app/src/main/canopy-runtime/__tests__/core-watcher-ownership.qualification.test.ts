import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppAdvisorWatcher } from '@canopy/desktop-shared/types';
import type * as WaitDiagnostics from '../../observability/chat-wait-diagnostics';

let mockDirectory = '';
jest.mock('../../lib/paths', () => ({
  getAppAdvisorWatchersFilePath: (): string =>
    join(mockDirectory, 'app-advisor-watchers.json'),
  getDataDir: (): string => mockDirectory,
  getWorktreeDataDir: (): string => mockDirectory,
  getWorktreeAttachmentsDir: (): string => mockDirectory,
}));
jest.mock('../../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => false,
}));
jest.mock('../../app-advisor/chat-watcher-access', () => ({
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
jest.mock('../../agents/session-manager', () => ({
  getActiveSessionInfos: (): unknown[] => [],
  getAllActiveSessionInfos: (): unknown[] => [],
}));
jest.mock('../../agents/delegation/child-messages', () => ({
  ChildMessageAdmissionRefusedError: class extends Error {},
}));
jest.mock('../../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (): Promise<unknown> =>
    Promise.resolve({ version: 1, tabs: [], activeTabId: null }),
}));
jest.mock('../../lib/cowork-work-entries', () => ({}));
jest.mock('../../lib/cowork-migration-map', () => ({}));
jest.mock('../../lib/workspace-persistence', () => ({}));
jest.mock('../../pipelines/pipeline-service', () => ({}));
jest.mock('../../lib/github-broker', () => ({
  GitHubBrokerError: class extends Error {},
}));
jest.mock('../../lib/github-broker/workflow-runs', () => ({}));
jest.mock('../../lib/github-broker/workflow-definitions', () => ({}));
jest.mock('../../lib/github-pr-read-model', () => ({}));
const mockObserver = {
  stop: (): void => undefined,
  configure: (): void => undefined,
  rescan: (): Promise<void> => Promise.resolve(),
};
jest.mock('../../lib/github-workflow-run-observer', () => ({
  getGitHubWorkflowRunObserver: (): unknown => mockObserver,
}));
jest.mock('../../lib/github-pull-request-observer', () => ({
  getGitHubPullRequestObserver: (): unknown => mockObserver,
}));
jest.mock('../../lib/app-advisor-project-agent-access', () => ({
  onAppAdvisorProjectAgentAccessChange: (): (() => void) => (): void =>
    undefined,
}));
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    subscribe: (): (() => void) => (): void => undefined,
  }),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: (): unknown => ({
    recordSessionDiagnostic: (): void => undefined,
  }),
}));
jest.mock('../../observability/chat-wait-diagnostics', () => {
  const actual = jest.requireActual<typeof WaitDiagnostics>(
    '../../observability/chat-wait-diagnostics',
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
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    hasTranscriptMessage: (): Promise<boolean> => Promise.resolve(false),
  }),
}));
jest.mock('../../automations/service', () => ({
  getAutomationsService: (): unknown => ({
    list: (): Promise<unknown> =>
      Promise.resolve({ activities: [], recentRuns: [] }),
    listRuns: (): Promise<unknown> =>
      Promise.resolve({ runs: [], nextCursor: null }),
  }),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  isCanopyPortalActive: (): boolean => false,
}));
jest.mock('../../services/chat-service', () => ({}));

import { createCoreWatcherAdapter } from '../core-watcher-adapter';
import type { CanopyHandlerContext } from '@canopy/core-runtime';

const chat = (chatId: string): AppAdvisorWatcher['destination'] => ({
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId,
});
const RECIPIENT = {
  workspaceId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-a',
};

function row(
  id: string,
  destination: AppAdvisorWatcher['destination'],
  createdByToolUseId?: string,
): AppAdvisorWatcher {
  const now = new Date().toISOString();
  return {
    version: 1,
    id,
    trigger: 'worktree_pipeline_completion',
    status: 'active',
    label: id,
    target: {
      kind: 'worktree_pipeline',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      pipelineId: `pipeline-${id}`,
    },
    destination,
    createdAt: now,
    updatedAt: now,
    dedupeKey: `ownership-${id}`,
    ...(createdByToolUseId ? { createdByToolUseId } : {}),
  };
}

const context = (key?: string): CanopyHandlerContext => ({
  requestId: 'r',
  caller: {
    principalId: 'desktop-agent-watchers',
    clientInstanceId: 'desktop-main',
    authorityId: 'local',
    interfaceKind: 'mcp',
    grants: ['core.initiatedWork.read', 'core.initiatedWork.write'],
  },
  metadata: key ? { idempotencyKey: key } : {},
  signal: new AbortController().signal,
});

async function storedIds(): Promise<string[]> {
  const file = JSON.parse(
    await readFile(join(mockDirectory, 'app-advisor-watchers.json'), 'utf8'),
  ) as { watchers: { id: string; status: string }[] };
  return file.watchers
    .filter((watcher) => watcher.status === 'active')
    .map((watcher) => watcher.id)
    .sort();
}

beforeEach(async () => {
  mockDirectory = await mkdtemp(join(tmpdir(), 'core-watcher-ownership-'));
  await writeFile(
    join(mockDirectory, 'app-advisor-watchers.json'),
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      watchers: [
        row('own', chat('chat-a'), 'toolu_a'),
        row('other-chat', chat('chat-b'), 'toolu_b'),
        row('user-made', chat('chat-a')),
      ],
    }),
  );
});
afterEach(async () => {
  await rm(mockDirectory, { recursive: true, force: true });
});

describe('agent watcher ownership through core.initiatedWork.watcher (CAN-5994)', () => {
  it('lists and deletes only the calling chat’s own agent watchers', async () => {
    const adapter = createCoreWatcherAdapter();
    const list = adapter.queries?.['core.initiatedWork.watcher.list'];
    const remove = adapter.instructions?.['core.initiatedWork.watcher.delete'];
    if (!list || !remove) throw new Error('watcher operations are not served');

    const listed = await list(
      { recipient: RECIPIENT, search: { includeActive: true } },
      context(),
    );
    expect(listed.accepted).toBe(true);
    const active = (
      JSON.parse(listed.report) as { activeWatchers: { id: string }[] }
    ).activeWatchers.map((watcher) => watcher.id);
    expect(active).not.toContain('other-chat');
    expect(active).toContain('own');

    const deleted = await remove(
      {
        recipient: RECIPIENT,
        watcherIds: ['own', 'other-chat', 'user-made'],
        _meta: { idempotencyKey: 'delete-1' },
      },
      context('delete-1'),
    );
    expect(JSON.parse(deleted.report)).toMatchObject({
      results: [
        { watcherId: 'own', status: 'deleted' },
        { watcherId: 'other-chat', status: 'not_found' },
        { watcherId: 'user-made', status: 'not_found' },
      ],
    });
    expect(await storedIds()).toEqual(['other-chat', 'user-made']);
  });

  it('a create retried with the same key makes one watcher', async () => {
    const adapter = createCoreWatcherAdapter();
    const create = adapter.instructions?.['core.initiatedWork.watcher.create'];
    if (!create) throw new Error('watcher operations are not served');
    const params = {
      recipient: RECIPIENT,
      request: {
        kind: 'setup' as const,
        input: { watchers: [{ target: { pipelineId: 'pipeline-new' } }] },
      },
      createdBy: 'toolu_new',
      _meta: { idempotencyKey: 'create-1' },
    };
    const first = await create(params, context('create-1'));
    const replay = await create(params, context('create-1'));
    expect(first.accepted).toBe(true);
    expect(replay).toEqual(first);
    const retry = await create(
      { ...params, _meta: { idempotencyKey: 'create-2' } },
      context('create-2'),
    );
    expect(retry.accepted).toBe(true);
    const ids = await storedIds();
    expect(
      ids.filter((id) => !['own', 'other-chat', 'user-made'].includes(id)),
    ).toHaveLength(1);
  });
});
