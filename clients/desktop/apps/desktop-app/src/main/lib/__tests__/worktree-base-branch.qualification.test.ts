import type {
  McpQuestion,
  McpQuestionAnswer,
  SidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type * as BaseBranchModule from '../worktree-base-branch';

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
}));

const mockUpdateWorktree = jest.fn(
  (request: { workspaceId: string; worktreeId: string }) =>
    Promise.resolve({
      worktree: { id: request.worktreeId, trackedBaseBranch: 'develop' },
      changed: true,
    }),
);
let mockRemoteUrl = (): Promise<string | null> =>
  Promise.resolve('https://github.com/acme/repo.git');
let mockCurrentBranch: () => Promise<string> = () => Promise.resolve('feature');
jest.mock('../git', (): object => ({
  ...jest.requireActual<object>('../git'),
  getCurrentBranch: (): Promise<string> => mockCurrentBranch(),
  getRemoteUrlStrict: (): Promise<string | null> => mockRemoteUrl(),
}));
jest.mock('../resolve-worktree', (): object => ({
  ...jest.requireActual<object>('../resolve-worktree'),
  resolveWorktreeCwd: (): string => '/repo',
}));
jest.mock('../worktree-update', (): object => ({
  ...jest.requireActual<object>('../worktree-update'),
  updateWorktree: (request: { workspaceId: string; worktreeId: string }) =>
    mockUpdateWorktree(request),
}));
let mockStoredRows: Array<Record<string, unknown>> | null = null;
const mockSendToAllWindows = jest.fn();
jest.mock('../window-send', (): object => ({
  ...jest.requireActual<object>('../window-send'),
  sendToAllWindows: (...args: unknown[]): void => {
    mockSendToAllWindows(...args);
  },
}));
jest.mock('../../services/worktree-diff-stats-cache', (): object => ({
  ...jest.requireActual<object>('../../services/worktree-diff-stats-cache'),
  invalidateWorktreeDiffStats: jest.fn(),
  refreshWorktreeDiffStats: jest.fn(() => Promise.resolve()),
}));

let mockPorts: BaseBranchModule.WorktreeBaseBranchPorts | null = null;
const mockPortsCallers: CanopyCallerDescriptor[] = [];
jest.mock('../worktree-base-branch', (): object => {
  const actual = jest.requireActual<typeof BaseBranchModule>(
    '../worktree-base-branch',
  );
  return {
    ...actual,
    mainWorktreeBaseBranchPorts: (
      dispatcher: Parameters<typeof actual.mainWorktreeBaseBranchPorts>[0],
      caller: CanopyCallerDescriptor,
    ): BaseBranchModule.WorktreeBaseBranchPorts => {
      mockPortsCallers.push(caller);
      return (
        mockPorts ?? actual.mainWorktreeBaseBranchPorts(dispatcher, caller)
      );
    },
  };
});

import { beginExclusiveGitAction } from '../../services/git-action-exclusion';
import {
  finishGitActionCancellationScope,
  resetGitActionCancellationsForTests,
} from '../../ipc/git-action-cancellation';
import {
  acquireSplitLock,
  releaseSplitLock,
} from '../../services/split-lock-service';
import { useFakeSplitLockKeys } from '../../__tests__/split-lock-key-fixture';
import {
  agentCoreOperations,
  AgentToolOperationRefusedError,
} from '../../canopy-tools/agent-core-operations';
import { executeCanopyInjectedTool } from '../../canopy-tools/core';
import {
  clearLiveApprovalMode,
  setLiveApprovalMode,
} from '../../approvals/live-approval-modes';
import { AskUserDismissedError } from '../ask-user-outcomes';
import { setWorktreeBaseBranchForAgent } from '../../canopy-tools/set-base-branch-runtime';
import { dispatchActionSchema } from '../../app-advisor/definitions';
import {
  WORKTREE_BASE_BRANCH_TEXTS,
  type WorktreeBaseBranchPorts,
} from '../worktree-base-branch';

const { mainWorktreeBaseBranchPorts: realPorts } = jest.requireActual<
  typeof BaseBranchModule
>('../worktree-base-branch');

function mainPorts(): WorktreeBaseBranchPorts {
  return realPorts(
    agentCoreOperations('baseBranch', {
      query: jest.fn(),
      instruction: jest.fn(),
    }),
    {
      principalId: 'p',
      authorityId: 'a',
      interfaceKind: 'mcp',
      grants: [],
    } as unknown as CanopyCallerDescriptor,
    (_projectId, worktreeId) =>
      Promise.resolve(
        (
          mockStoredRows ?? [
            { id: 'wt', trackedRepoBaseBranches: { 'repo-a': 'develop' } },
          ]
        ).find((row) => row.id === worktreeId) as WorktreeData | undefined,
      ),
  );
}

/** Main's real lock read: the Git action lock or the Split lock. */
function mainGitOperationActive(
  projectId: string,
  worktreeId: string,
): boolean {
  return mainPorts().gitOperationActive(projectId, worktreeId);
}

const ITEM = {
  id: 'proj',
  type: 'single-repo',
  name: 'Project',
  repoPath: '/repo',
  worktrees: [{ id: 'wt', branchName: 'feature' }],
} as unknown as SidebarItem;

function openPr(prNumber = 42, baseRefName = 'main'): WorktreePrStatus {
  return {
    repos: [
      {
        repoId: 'proj',
        repoName: 'repo',
        status: { prNumber, state: 'open', baseRefName },
      },
    ],
    lastCheckedAt: '2026-11-08T00:00:00.000Z',
  } as unknown as WorktreePrStatus;
}

interface Recorded {
  ports: WorktreeBaseBranchPorts;
  writes: Array<
    Parameters<WorktreeBaseBranchPorts['writeTrackedBaseBranch']>[0]
  >;
  prUpdates: Array<
    Parameters<WorktreeBaseBranchPorts['updatePullRequestBase']>[0]
  >;
}

function fakePorts(overrides: Partial<WorktreeBaseBranchPorts> = {}): Recorded {
  const writes: Recorded['writes'] = [];
  const prUpdates: Recorded['prUpdates'] = [];
  const ports: WorktreeBaseBranchPorts = {
    readItems: () => Promise.resolve([ITEM]),
    listBranches: () =>
      Promise.resolve({
        branches: [
          {
            name: 'develop',
            hasLocalRef: true,
            hasRemoteRef: true,
          } as unknown as Awaited<
            ReturnType<WorktreeBaseBranchPorts['listBranches']>
          >['branches'][number],
        ],
        defaultBranch: 'main',
      }),
    readPrStatus: () => Promise.resolve(null),
    gitOperationActive: () => false,
    writeTrackedBaseBranch: (request) => {
      writes.push(request);
      return Promise.resolve({
        id: request.worktreeId,
        ...(request.repoId
          ? {
              trackedRepoBaseBranches: { [request.repoId]: request.baseBranch },
            }
          : { trackedBaseBranch: request.baseBranch }),
      } as unknown as WorktreeData);
    },
    updatePullRequestBase: (request) => {
      prUpdates.push(request);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { ports, writes, prUpdates };
}

function answering(
  option: string | Error,
  answeredBy: McpQuestionAnswer['answeredBy'] | null = 'person',
): jest.Mock<Promise<McpQuestionAnswer[]>, [McpQuestion[]]> {
  return jest.fn((questions: McpQuestion[]) =>
    option instanceof Error
      ? Promise.reject(option)
      : Promise.resolve([
          {
            question: questions[0]?.question ?? '',
            selectedOptions: [option],
            ...(answeredBy ? { answeredBy } : {}),
          },
        ]),
  );
}

function change(
  recorded: Recorded,
  requestUserAnswers: (
    questions: McpQuestion[],
  ) => Promise<McpQuestionAnswer[]>,
  toolUseId = 'toolu_1',
  repoId?: string,
): ReturnType<typeof setWorktreeBaseBranchForAgent> {
  return setWorktreeBaseBranchForAgent({
    target: { projectId: 'proj', worktreeId: 'wt' },
    chatId: 'chat-1',
    baseBranch: 'develop',
    ...(repoId ? { repoId } : {}),
    requestUserAnswers,
    toolUseId,
    ports: recorded.ports,
  });
}

const MULTI_ITEM = {
  id: 'proj',
  type: 'multi-repo',
  name: 'Project',
  repos: [{ id: 'repo-a' }, { id: 'repo-b' }],
  worktrees: [{ id: 'wt', branchName: 'feature' }],
} as unknown as SidebarItem;

const MULTI_PRS = {
  repos: [
    {
      repoId: 'repo-a',
      repoName: 'alpha',
      status: { prNumber: 11, state: 'open', baseRefName: 'main' },
    },
    {
      repoId: 'repo-b',
      repoName: 'beta',
      status: { prNumber: 22, state: 'open', baseRefName: 'main' },
    },
  ],
  lastCheckedAt: '2026-11-08T00:00:00.000Z',
} as unknown as WorktreePrStatus;

useFakeSplitLockKeys();
beforeEach(() => {
  mockRequestRendererTool.mockClear();
  mockUpdateWorktree.mockClear();
  mockSendToAllWindows.mockClear();
  mockStoredRows = null;
  mockCurrentBranch = (): Promise<string> => Promise.resolve('feature');
  mockRemoteUrl = (): Promise<string | null> =>
    Promise.resolve('https://github.com/acme/repo.git');
  mockPorts = null;
  mockPortsCallers.length = 0;
  resetGitActionCancellationsForTests();
  clearLiveApprovalMode('proj', 'wt', 'chat-1');
});

describe('SetBaseBranch in main (CAN-6024)', () => {
  it('with no pull request the base branch is written once through the keyed writer and the PR is not touched', async () => {
    const recorded = fakePorts();
    const ask = answering(WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest);

    const response = await change(recorded, ask);

    expect(response).toEqual({
      requestId: 'toolu_1',
      ok: true,
      result: {
        projectId: 'proj',
        worktreeId: 'wt',
        baseBranch: 'develop',
        pullRequestUpdated: false,
      },
    });
    expect(recorded.writes).toEqual([
      {
        projectId: 'proj',
        worktreeId: 'wt',
        baseBranch: 'develop',
        previousBaseBranch: null,
        idempotencyKey: 'agent-chat-action:chat-1:toolu_1:base-branch',
      },
    ]);
    expect(recorded.prUpdates).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });

  it('a local-only choice writes the base and leaves the pull request', async () => {
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve(openPr()),
    });
    const ask = answering(WORKTREE_BASE_BRANCH_TEXTS.localOnly);

    const response = await change(recorded, ask);

    expect(response).toMatchObject({
      ok: true,
      result: { baseBranch: 'develop', pullRequestUpdated: false },
    });
    expect(ask.mock.calls[0]?.[0]).toEqual([
      {
        question:
          "repo has open PR #42. Change its PR base branch to develop too, or only this worktree's base?",
        options: ['Update PR base', 'Change worktree only'],
        multiSelect: false,
        allowOther: false,
      },
    ]);
    expect(recorded.writes).toHaveLength(1);
    expect(recorded.prUpdates).toEqual([]);
  });

  it('an update-PR choice writes the base and updates the pull request once', async () => {
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve(openPr()),
    });

    const response = await change(
      recorded,
      answering(WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest),
    );

    expect(response).toMatchObject({
      ok: true,
      result: { baseBranch: 'develop', pullRequestUpdated: true },
    });
    expect(recorded.writes).toHaveLength(1);
    expect(recorded.prUpdates).toEqual([
      {
        projectId: 'proj',
        worktreeId: 'wt',
        prNumber: 42,
        baseBranch: 'develop',
      },
    ]);
  });

  it('with an open pull request and nobody to ask the change is refused before any write', async () => {
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve(openPr()),
    });

    const response = await change(
      recorded,
      answering(new Error('ask_user_no_client')),
    );

    expect(response).toEqual({
      requestId: 'toolu_1',
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: WORKTREE_BASE_BRANCH_TEXTS.needsConfirmation,
        retryable: true,
      },
    });
    expect(recorded.writes).toEqual([]);
    expect(recorded.prUpdates).toEqual([]);
  });

  it('with Full access the pull request base is updated without asking (CAN-7222)', async () => {
    setLiveApprovalMode('proj', 'wt', 'chat-1', 'full-access');
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve(openPr()),
    });
    const ask = answering(new Error('ask_user_no_client'));

    const response = await change(recorded, ask);

    expect(response).toMatchObject({
      ok: true,
      result: { baseBranch: 'develop', pullRequestUpdated: true },
    });
    expect(ask).not.toHaveBeenCalled();
    expect(recorded.writes).toHaveLength(1);
    expect(recorded.prUpdates).toEqual([
      {
        projectId: 'proj',
        worktreeId: 'wt',
        prNumber: 42,
        baseBranch: 'develop',
      },
    ]);
  });

  it('a pull request already on the new base is never asked about (CAN-7222)', async () => {
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve(openPr(42, 'develop')),
    });
    const ask = answering(new Error('ask_user_no_client'));

    const response = await change(recorded, ask);

    expect(response).toMatchObject({
      ok: true,
      result: { baseBranch: 'develop', pullRequestUpdated: false },
    });
    expect(ask).not.toHaveBeenCalled();
    expect(recorded.writes).toHaveLength(1);
    expect(recorded.prUpdates).toEqual([]);
  });

  it('a dismissed question cancels without a write', async () => {
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve(openPr()),
    });

    const response = await change(
      recorded,
      answering(new Error('ask_user_cancelled')),
    );

    expect(response).toMatchObject({
      ok: false,
      error: { message: WORKTREE_BASE_BRANCH_TEXTS.cancelled },
    });
    expect(recorded.writes).toEqual([]);
  });

  it('an update-PR change is refused when the pull request changed while asking', async () => {
    let reads = 0;
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve(openPr(reads++ === 0 ? 42 : 43)),
    });

    const response = await change(
      recorded,
      answering(WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest),
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'stale_ui_state' },
    });
    expect(recorded.writes).toEqual([]);
  });

  describe.each([
    ['a commit runs', 'commit'],
    ['a push runs', 'push'],
    ['PR creation runs', 'create-pr'],
    ['a merge runs', 'merge'],
  ])('an update-PR change is refused while %s', (_label, operation) => {
    it('refuses before any write', async () => {
      // Every desktop Git mutation (commit, push, PR creation, merge) holds
      // the worktree's Git-action lock through runCancellableGitAction.
      const target = {
        projectId: 'proj',
        worktreeId: 'wt',
        operationId: `op-${operation}`,
      };
      const scope = beginExclusiveGitAction(target);
      try {
        const recorded = fakePorts({
          readPrStatus: () => Promise.resolve(openPr()),
          gitOperationActive: mainGitOperationActive,
        });

        const response = await change(
          recorded,
          answering(WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest),
        );

        expect(response).toMatchObject({
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: WORKTREE_BASE_BRANCH_TEXTS.activeGitOperation,
          },
        });
        expect(recorded.writes).toEqual([]);
        expect(recorded.prUpdates).toEqual([]);
      } finally {
        finishGitActionCancellationScope(target, scope);
      }
    });
  });

  it('an update-PR change is refused while a split runs', async () => {
    await acquireSplitLock('proj', 'wt');
    try {
      const recorded = fakePorts({
        readPrStatus: () => Promise.resolve(openPr()),
        gitOperationActive: mainGitOperationActive,
      });

      const response = await change(
        recorded,
        answering(WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest),
      );

      expect(response).toMatchObject({
        ok: false,
        error: { message: WORKTREE_BASE_BRANCH_TEXTS.activeGitOperation },
      });
      expect(recorded.writes).toEqual([]);
    } finally {
      releaseSplitLock('proj', 'wt');
    }
  });

  it('the write port writes through the keyed core.worktree.update writer and announces the row', async () => {
    const ports = mainPorts();

    await ports.writeTrackedBaseBranch({
      projectId: 'proj',
      worktreeId: 'wt',
      repoId: 'repo-a',
      baseBranch: 'develop',
      previousBaseBranch: 'main',
      idempotencyKey: 'agent-chat-action:chat-1:toolu_1:base-branch',
    });

    expect(mockUpdateWorktree).toHaveBeenCalledWith({
      workspaceId: 'proj',
      worktreeId: 'wt',
      patch: { trackedRepoBaseBranches: { 'repo-a': 'develop' } },
      idempotencyKey: 'agent-chat-action:chat-1:toolu_1:base-branch',
    });
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'workspace:worktrees-updated',
      {
        workspaceId: 'proj',
        worktree: {
          id: 'wt',
          trackedRepoBaseBranches: { 'repo-a': 'develop' },
        },
      },
    );
    // The renderer reconciles shown bases, diff stats and Changed Files.
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'github:dependent-base-branches-updated',
      {
        updates: [
          {
            projectId: 'proj',
            worktreeId: 'wt',
            repoId: 'repo-a',
            previousBaseBranch: 'main',
            nextBaseBranch: 'develop',
          },
        ],
      },
    );
  });

  it("a failed branch read is a failed PR lookup, never 'no PR'", async () => {
    mockCurrentBranch = (): Promise<string> =>
      Promise.reject(new Error('git timed out'));

    await expect(
      mainPorts().readPrStatus({ projectId: 'proj', worktreeId: 'wt' }),
    ).resolves.toBe('unavailable');
  });

  it("a failed remote lookup is a failed PR lookup, never 'no PR'", async () => {
    mockRemoteUrl = (): Promise<string | null> =>
      Promise.reject(new Error('git remote failed'));

    await expect(
      mainPorts().readPrStatus({ projectId: 'proj', worktreeId: 'wt' }),
    ).resolves.toBe('unavailable');
  });

  it('a checkout without an origin has no pull request to ask about', async () => {
    mockRemoteUrl = (): Promise<string | null> => Promise.resolve(null);

    await expect(
      mainPorts().readPrStatus({ projectId: 'proj', worktreeId: 'wt' }),
    ).resolves.toBeNull();
  });

  it('a retried update-PR request never moves the pull request back once the base moved on', async () => {
    // Request A (develop) ran, then B (release); A's retry replays A's
    // write, which leaves the stored base at release.
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve(openPr()),
      writeTrackedBaseBranch: () =>
        Promise.resolve({
          id: 'wt',
          trackedBaseBranch: 'release',
        } as unknown as WorktreeData),
    });

    const response = await change(
      recorded,
      answering(WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest),
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'stale_ui_state',
        message: WORKTREE_BASE_BRANCH_TEXTS.baseMovedOn,
      },
    });
    expect(recorded.prUpdates).toEqual([]);
  });

  it('a detached checkout has no pull request to ask about', async () => {
    mockCurrentBranch = (): Promise<string> => Promise.resolve('');

    await expect(
      mainPorts().readPrStatus({ projectId: 'proj', worktreeId: 'wt' }),
    ).resolves.toBeNull();
  });

  it('a same-key retry announces the stored row and never an older base', async () => {
    // The first write's replayed row says develop; the worktree moved on to
    // release since, so nothing may take the renderer back to develop.
    mockStoredRows = [
      { id: 'wt', trackedRepoBaseBranches: { 'repo-a': 'release' } },
    ];
    const ports = mainPorts();

    await ports.writeTrackedBaseBranch({
      projectId: 'proj',
      worktreeId: 'wt',
      repoId: 'repo-a',
      baseBranch: 'develop',
      previousBaseBranch: 'release',
      idempotencyKey: 'agent-chat-action:chat-1:toolu_1:base-branch',
    });

    expect(mockSendToAllWindows.mock.calls).toEqual([
      [
        'workspace:worktrees-updated',
        {
          workspaceId: 'proj',
          worktree: {
            id: 'wt',
            trackedRepoBaseBranches: { 'repo-a': 'release' },
          },
        },
      ],
    ]);
  });

  it('the write carries the previous tracked base for the renderer', async () => {
    const recorded = fakePorts({
      readItems: () =>
        Promise.resolve([
          {
            ...ITEM,
            worktrees: [
              { id: 'wt', branchName: 'feature', trackedBaseBranch: 'main' },
            ],
          } as unknown as SidebarItem,
        ]),
    });

    await change(recorded, answering(WORKTREE_BASE_BRANCH_TEXTS.localOnly));

    expect(recorded.writes[0]?.previousBaseBranch).toBe('main');
  });

  it('a dismissed App Advisor question cancels without a write and is not retryable', async () => {
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve(openPr()),
    });

    const response = await change(
      recorded,
      answering(
        new AskUserDismissedError(
          'Orchestrator question was dismissed without an answer.',
        ),
      ),
    );

    expect(response).toEqual({
      requestId: 'toolu_1',
      ok: false,
      error: {
        code: 'execution_failed',
        message: WORKTREE_BASE_BRANCH_TEXTS.cancelled,
        retryable: false,
      },
    });
    expect(recorded.writes).toEqual([]);
  });

  it('a failed PR lookup is refused before any write, never treated as no PR', async () => {
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve('unavailable'),
    });
    const ask = answering(WORKTREE_BASE_BRANCH_TEXTS.localOnly);

    const response = await change(recorded, ask);

    expect(response).toEqual({
      requestId: 'toolu_1',
      ok: false,
      error: {
        code: 'execution_failed',
        message: WORKTREE_BASE_BRANCH_TEXTS.pullRequestUnknown,
        retryable: true,
      },
    });
    expect(ask).not.toHaveBeenCalled();
    expect(recorded.writes).toEqual([]);
  });

  it('a failed PR lookup for a base only on this machine changes it locally, as no PR question applies', async () => {
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve('unavailable'),
      listBranches: () =>
        Promise.resolve({
          branches: [
            {
              name: 'develop',
              hasLocalRef: true,
              hasRemoteRef: false,
            } as unknown as Awaited<
              ReturnType<WorktreeBaseBranchPorts['listBranches']>
            >['branches'][number],
          ],
          defaultBranch: 'main',
        }),
    });

    const response = await change(
      recorded,
      answering(WORKTREE_BASE_BRANCH_TEXTS.localOnly),
    );

    expect(response).toMatchObject({
      ok: true,
      result: { pullRequestUpdated: false },
    });
    expect(recorded.writes).toHaveLength(1);
  });

  it.each([
    ['an agent', 'agent'],
    ['an unknown source', null],
  ] as const)(
    'an update-PR answer from %s never updates the pull request and writes nothing',
    async (_label, answeredBy) => {
      const recorded = fakePorts({
        readPrStatus: () => Promise.resolve(openPr()),
      });

      const response = await change(
        recorded,
        answering(WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest, answeredBy),
      );

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'surface_unavailable',
          message: WORKTREE_BASE_BRANCH_TEXTS.needsConfirmation,
        },
      });
      expect(recorded.writes).toEqual([]);
      expect(recorded.prUpdates).toEqual([]);
    },
  );

  it('the PR update is bound to the pull request asked about, for the requested repository', async () => {
    const recorded = fakePorts({
      readItems: () => Promise.resolve([MULTI_ITEM]),
      readPrStatus: () => Promise.resolve(MULTI_PRS),
    });
    const ask = answering(WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest);

    const response = await change(recorded, ask, 'toolu_1', 'repo-b');

    expect(response).toMatchObject({
      ok: true,
      result: { repoId: 'repo-b', pullRequestUpdated: true },
    });
    expect(ask.mock.calls[0]?.[0][0]?.question).toBe(
      "beta has open PR #22. Change its PR base branch to develop too, or only this worktree's base?",
    );
    expect(recorded.prUpdates).toEqual([
      {
        projectId: 'proj',
        worktreeId: 'wt',
        repoId: 'repo-b',
        prNumber: 22,
        baseBranch: 'develop',
      },
    ]);
  });

  it('an agent-supplied PR number is refused before anything runs', async () => {
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve(openPr()),
    });
    mockPorts = recorded.ports;

    const result = await executeCanopyInjectedTool(
      'set_base_branch',
      { baseBranch: 'develop', prNumber: 99 },
      {
        requestUserAnswers: answering(
          WORKTREE_BASE_BRANCH_TEXTS.updatePullRequest,
        ),
        worktreeActionRuntime: {
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat-1',
          cwd: '/repo',
          executionScope: 'worktree',
          getWindow: (): null => null,
        },
      } as unknown as Parameters<typeof executeCanopyInjectedTool>[2],
      { toolUseId: 'toolu_6' },
    );

    expect(result.isError).toBe(true);
    expect(recorded.writes).toEqual([]);
    expect(recorded.prUpdates).toEqual([]);
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'worktree.set_base_branch',
          projectId: 'proj',
          worktreeId: 'wt',
          baseBranch: 'develop',
          prNumber: 99,
        },
      }).success,
    ).toBe(false);
  });

  it('a repeated tool call reuses the key', async () => {
    const recorded = fakePorts();
    const ask = answering(WORKTREE_BASE_BRANCH_TEXTS.localOnly);

    await change(recorded, ask, 'toolu_9');
    await change(recorded, ask, 'toolu_9');

    expect(recorded.writes.map((write) => write.idempotencyKey)).toEqual([
      'agent-chat-action:chat-1:toolu_9:base-branch',
      'agent-chat-action:chat-1:toolu_9:base-branch',
    ]);
  });

  it('the baseBranch row admits only its three operations, each with its one grant', async () => {
    const query = jest.fn(
      (
        _name: string,
        _params: unknown,
        options: { caller: CanopyCallerDescriptor },
      ) => Promise.resolve(options.caller.grants),
    );
    const instruction = jest.fn(
      (
        _name: string,
        _params: unknown,
        options: { caller: CanopyCallerDescriptor },
      ) => Promise.resolve(options.caller.grants),
    );
    const dispatcher = agentCoreOperations('baseBranch', {
      query,
      instruction,
    } as unknown as Parameters<typeof agentCoreOperations>[1]);
    const caller = (grants: string[]): { caller: CanopyCallerDescriptor } => ({
      caller: {
        principalId: 'local-desktop-user',
        authorityId: 'a',
        interfaceKind: 'mcp',
        grants,
      } as unknown as CanopyCallerDescriptor,
    });

    await expect(
      dispatcher.query(
        'worker.git.branch.list' as never,
        {} as never,
        caller(['worker.git.read', 'worker.git.write']) as never,
      ),
    ).resolves.toEqual(['worker.git.read']);
    await expect(
      dispatcher.query(
        'core.pullRequest.get' as never,
        {} as never,
        caller(['core.pullRequest.read']) as never,
      ),
    ).resolves.toEqual(['core.pullRequest.read']);
    await expect(
      dispatcher.instruction(
        'core.pullRequest.update' as never,
        {} as never,
        caller(['core.pullRequest.write']) as never,
      ),
    ).resolves.toEqual(['core.pullRequest.write']);
    await expect(
      dispatcher.instruction(
        'core.worktree.update' as never,
        {} as never,
        caller(['core.worktree.write']) as never,
      ),
    ).rejects.toBeInstanceOf(AgentToolOperationRefusedError);
    await expect(
      dispatcher.instruction(
        'worker.git.checkout' as never,
        {} as never,
        caller(['worker.git.write']) as never,
      ),
    ).rejects.toBeInstanceOf(AgentToolOperationRefusedError);
    expect(query).toHaveBeenCalledTimes(2);
    expect(instruction).toHaveBeenCalledTimes(1);
  });

  it("SetBaseBranch's question carries the tool call's id and abort signal", async () => {
    const recorded = fakePorts({
      readPrStatus: () => Promise.resolve(openPr()),
    });
    mockPorts = recorded.ports;
    const ask = jest.fn<
      Promise<McpQuestionAnswer[]>,
      [McpQuestion[], unknown?]
    >((questions) =>
      Promise.resolve([
        {
          question: questions[0]?.question ?? '',
          selectedOptions: [WORKTREE_BASE_BRANCH_TEXTS.localOnly],
          answeredBy: 'person' as const,
        },
      ]),
    );
    const signal = new AbortController().signal;

    await executeCanopyInjectedTool(
      'set_base_branch',
      { baseBranch: 'develop' },
      {
        requestUserAnswers: ask,
        worktreeActionRuntime: {
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat-1',
          cwd: '/repo',
          executionScope: 'worktree',
          getWindow: (): null => null,
        },
      } as unknown as Parameters<typeof executeCanopyInjectedTool>[2],
      { toolUseId: 'toolu_8', signal },
    );

    expect(ask.mock.calls[0]?.[1]).toEqual({ toolUseId: 'toolu_8', signal });
  });

  it('SetBaseBranch runs in main for the chat worktree and never reaches the renderer', async () => {
    const recorded = fakePorts();
    mockPorts = recorded.ports;

    const result = await executeCanopyInjectedTool(
      'set_base_branch',
      { baseBranch: 'develop', repoId: undefined },
      {
        requestUserAnswers: answering(WORKTREE_BASE_BRANCH_TEXTS.localOnly),
        worktreeActionRuntime: {
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat-1',
          cwd: '/repo',
          executionScope: 'worktree',
          getWindow: (): null => null,
        },
      } as unknown as Parameters<typeof executeCanopyInjectedTool>[2],
      { toolUseId: 'toolu_5' },
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      result: { projectId: 'proj', worktreeId: 'wt', baseBranch: 'develop' },
    });
    expect(recorded.writes).toEqual([
      expect.objectContaining({
        idempotencyKey: 'agent-chat-action:chat-1:toolu_5:base-branch',
      }),
    ]);
    expect(mockPortsCallers).toEqual([
      expect.objectContaining({
        principalId: 'local-desktop-user',
        clientInstanceId: 'agent-action:chat-1',
        interfaceKind: 'mcp',
        grants: [],
      }),
    ]);
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });
});
