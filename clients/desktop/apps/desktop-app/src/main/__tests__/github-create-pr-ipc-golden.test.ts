import { WORKER_GIT_MERGE_INSTRUCTION_DEFINITIONS } from '@canopy/protocol/canopy-core';
import { createWorkerGitMergeAdapter } from '../canopy-runtime/worker-git-merge-adapter';
// CAN-4070 rule: captured on the unchanged `github:create-pr` handler before
// CAN-4109 sends its two GitHub create steps through core.pullRequest.create.
// GitHub is faked at the broker client, the boundary the create reaches, so
// these keep holding once the steps no longer call `createPrForRepo` directly.
// The composed host flow's Git and content-generation steps are faked as in
// github-create-pr.test.ts. Responses and progress events are JSON text, so
// key order is pinned too.
//
// CAN-4109 harness: the steps reach GitHub through a dispatcher installing the
// real core.pullRequest handlers and desktop host. The workspace records the
// checkout's repository, and the head read and the read after the create
// that the canonical path adds are faked; the assertions are the goldens'.
import { GitHubBrokerError } from '../lib/github-broker/errors';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  CancelGitActionRequest,
  CancelGitActionResponse,
  CreatePrRequest,
  CreatePrResponse,
} from '@canopy/desktop-shared/types/github';

type Handler = (event: unknown, request: unknown) => unknown;

const mockHandlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));

interface MockEnqueueCall {
  priority: unknown;
  options: unknown;
}
const mockEnqueueCalls: MockEnqueueCall[] = [];
const mockOctokit = {
  pulls: {
    create: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
    listReviews: jest.fn(),
  },
  checks: { listForRef: jest.fn() },
  // The canonical create's head read (CAN-4109 harness).
  repos: { getBranch: jest.fn() },
};
const mockEnqueue = jest.fn(
  async (
    fn: (octokit: typeof mockOctokit, headers: undefined) => Promise<unknown>,
    priority?: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    mockEnqueueCalls.push({ priority, options });
    return fn(mockOctokit, undefined);
  },
);
jest.mock('../lib/github-client', () => ({
  ...jest.requireActual<object>('../lib/github-client'),
  getGitHubClient: (): { enqueue: typeof mockEnqueue } => ({
    enqueue: mockEnqueue,
  }),
}));
// No request reaches GitHub: the broker sends nothing (CAN-4109).
jest.mock('../lib/github-broker', () => {
  const actual = jest.requireActual<{ getGitHubBroker: () => object }>(
    '../lib/github-broker',
  );
  return {
    ...actual,
    getGitHubBroker: (): object =>
      new Proxy(actual.getGitHubBroker(), {
        get: (target, property): unknown => {
          if (property === 'execute')
            return (): Promise<never> =>
              Promise.reject(
                new Error('The GitHub broker sends nothing here.'),
              );
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  };
});

const mockRecordCreatedPullRequest = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordCreatedPullRequest: mockRecordCreatedPullRequest,
  })),
}));
jest.mock('../lib/desktop-telemetry', () => ({
  recordGitCommitTelemetry: jest.fn(),
  recordPullRequestOpenedTelemetry: jest.fn(),
  recordPullRequestMergedTelemetry: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/workspace/single-repo'),
}));
jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));
// The workspace records the checkout's repository (CAN-4109 harness); its
// basename is the checkout's, so the flow names the repository as before.
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(() =>
    Promise.resolve({
      version: 1,
      type: 'single-repo',
      repoPath: '/source/single-repo',
      repos: [],
    }),
  ),
}));
// The read after the create (CAN-4109 harness); GitHub is not contacted.
const mockReadGitHubPullRequestProjection = jest.fn();
jest.mock('../lib/github-pr-read-model', () => ({
  ...jest.requireActual<object>('../lib/github-pr-read-model'),
  readGitHubPullRequestProjection: (...args: unknown[]): unknown =>
    mockReadGitHubPullRequestProjection(...args),
}));
// The Portal's create_auto action, as the composition root installs it.
let mockWorktreePrActions:
  | { create: (request: unknown) => Promise<unknown> }
  | undefined;
jest.mock('../services/pr-worktree-actions', () => ({
  registerWorktreePrActions: (actions: {
    create: (request: unknown) => Promise<unknown>;
  }): void => {
    mockWorktreePrActions = actions;
  },
}));
jest.mock('../lib/git', () => ({
  isGitRepo: jest.fn(() => Promise.resolve(false)),
  getCurrentBranch: jest.fn(() => Promise.resolve('feature-branch')),
  getDiffStats: jest.fn(() => Promise.resolve({ insertions: 0, deletions: 0 })),
  getFullDiff: jest.fn(() => Promise.resolve('diff content')),
  getCommitLog: jest.fn(() => Promise.resolve('commit log')),
  fetchOrigin: jest.fn(() => Promise.resolve()),
  getAheadBehindCounts: jest.fn(() => Promise.resolve({ ahead: 0, behind: 0 })),
  getRemoteUrl: jest.fn(() =>
    Promise.resolve('git@github.com:golden-org/single-repo.git'),
  ),
  pushBranch: jest.fn(() => Promise.resolve()),
  hasUncommittedChanges: jest.fn(() => Promise.resolve(false)),
  hasCommitsAhead: jest.fn(() => Promise.resolve(true)),
  readBranchPublication: jest.fn(() => Promise.resolve(false)),
  hasRemoteTrackingBranch: jest.fn(() => Promise.resolve(false)),
  hasUnpulledCommits: jest.fn(() => Promise.resolve(false)),
  hasUnpushedCommits: jest.fn(() => Promise.resolve(false)),
  stageAllChanges: jest.fn(),
  commitWithMessage: jest.fn(),
  getUncommittedDiff: jest.fn(),
  // The pushed head on origin (CAN-4109 harness).
  resolveRefSha: jest.fn(() => Promise.resolve('a'.repeat(40))),
}));
jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(),
  resolveRepoDefaultBranch: jest.fn(() => Promise.resolve('main')),
}));
jest.mock('../lib/github-pr-generator', () => ({
  generatePrContent: jest.fn(),
}));
jest.mock('../lib/commit-message-generator', () => ({
  generateCommitMessage: jest.fn(),
}));
jest.mock('../lib/commit-generation-model-candidates', () => ({
  resolveCommitGenerationModelCandidates: jest.fn(() =>
    Promise.resolve({ model: 'claude-sonnet-4-6', fallbackModels: [] }),
  ),
}));
jest.mock('../lib/github-poller', () => ({
  refreshNow: jest.fn(() => Promise.resolve(null)),
  requestRefresh: jest.fn(),
  startPolling: jest.fn(),
  enqueueFastRefresh: jest.fn(),
  enqueueKnownPrFastRefresh: jest.fn(() => Promise.resolve(false)),
  setForegroundWorktree: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      prGenerationModel: 'claude-sonnet-4-6',
      prInstructions: '',
      prInstructionMode: 'append',
      commitGenerationModel: 'claude-sonnet-4-6',
      commitInstructions: '',
      commitInstructionMode: 'append',
    }),
  ),
}));

import {
  initAgentModels,
  initClaudeModels,
  initModelAliases,
} from '@canopy/desktop-shared/types';
import {
  CORE_PULL_REQUEST_INSTRUCTION_DEFINITIONS,
  CORE_PULL_REQUEST_MERGE_INSTRUCTION_DEFINITIONS,
  CORE_PULL_REQUEST_MERGE_QUEUE_QUERY_DEFINITIONS,
  CORE_PULL_REQUEST_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  canopyPermissionDeniedError,
  createCanopyDispatcher,
} from '@canopy/core-runtime';
import { createCorePullRequestAdapter } from '../canopy-runtime/core-pull-request-adapter';
import { registerGitHubHandlers } from '../ipc/github';
import { recordPullRequestOpenedTelemetry } from '../lib/desktop-telemetry';
import { generatePrContent } from '../lib/github-pr-generator';
import { createPrForRepo } from '../lib/github-pr';
import { resolveEffectiveBaseBranchForRepo } from '../lib/worktree-base-branches';

initAgentModels([]);
initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });

const mockedGeneratePrContent = jest.mocked(generatePrContent);
const mockedResolveEffectiveBaseBranchForRepo = jest.mocked(
  resolveEffectiveBaseBranchForRepo,
);
const mockWindowSend = jest.fn();

// One sender for every call, so a later caller resolver can recognise it.
const IPC_EVENT = { sender: { id: 1 } };
const REQUEST = { projectId: 'project-a', worktreeId: 'wt-1' } as const;
const PR_URL = (number: number): string =>
  `https://github.com/golden-org/single-repo/pull/${number}`;
const NO_TOKEN_MESSAGE =
  'No GitHub token is available. Configure a PAT or sign in with the GitHub CLI.';

function createPr(request: CreatePrRequest): Promise<CreatePrResponse> {
  const handler = mockHandlers.get(IPC_CHANNELS.githubCreatePr);
  if (!handler) throw new Error('github:create-pr is not registered');
  return handler(IPC_EVENT, request) as Promise<CreatePrResponse>;
}

function cancelGitAction(
  request: CancelGitActionRequest,
): CancelGitActionResponse {
  const handler = mockHandlers.get(IPC_CHANNELS.githubCancelGitAction);
  if (!handler) throw new Error('github:cancel-git-action is not registered');
  return handler(IPC_EVENT, request) as CancelGitActionResponse;
}

function progressEvents(): string {
  return JSON.stringify(
    mockWindowSend.mock.calls
      .filter(([channel]) => channel === IPC_CHANNELS.githubPrCreationProgress)
      .map(([, event]) => event as unknown),
  );
}

function phase(name: string, extra = ''): string {
  return `{"projectId":"project-a","worktreeId":"wt-1","phase":"${name}"${extra}}`;
}

/** The `pulls.create` requests sent, in order. */
function createRequests(): unknown[] {
  return mockOctokit.pulls.create.mock.calls.map(
    ([params]: unknown[]): unknown => params,
  );
}

/** Broker options of each mutation sent, in order. */
function mutationEnqueues(): MockEnqueueCall[] {
  return mockEnqueueCalls.filter(
    ({ options }) =>
      typeof options === 'object' &&
      options !== null &&
      'operation' in options &&
      options.operation === 'mutation',
  );
}

function githubValidationError(message: string, field?: string): Error {
  return Object.assign(new Error('Validation Failed'), {
    name: 'HttpError',
    status: 422,
    response: {
      data: {
        message: 'Validation Failed',
        errors: [
          field
            ? { resource: 'PullRequest', field, code: 'invalid', message }
            : { resource: 'PullRequest', code: 'custom', message },
        ],
      },
    },
  });
}

function listedPullRequest(number: number): Record<string, unknown> {
  return {
    number,
    html_url: PR_URL(number),
    state: 'open',
    draft: false,
    title: `Existing ${number}`,
    head: { sha: 'a'.repeat(40), ref: 'feature-branch' },
    base: { ref: 'main' },
    updated_at: '2026-10-31T00:00:00Z',
  };
}

const pullRequestAdapter = createCorePullRequestAdapter();
const dispatcher = createCanopyDispatcher({
  profile: 'core+worker',
  definitions: {
    queries: {
      ...CORE_PULL_REQUEST_QUERY_DEFINITIONS,
      ...CORE_PULL_REQUEST_MERGE_QUEUE_QUERY_DEFINITIONS,
    },
    instructions: {
      ...CORE_PULL_REQUEST_INSTRUCTION_DEFINITIONS,
      ...CORE_PULL_REQUEST_MERGE_INSTRUCTION_DEFINITIONS,
      ...WORKER_GIT_MERGE_INSTRUCTION_DEFINITIONS,
    },
    streams: {},
  },
  handlers: {
    queries: pullRequestAdapter.queries,
    instructions: {
      ...pullRequestAdapter.instructions,
      ...createWorkerGitMergeAdapter(),
    },
    streams: {},
  },
});
const DESKTOP_IPC_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};

let resolveIpcCaller = (): CanopyCallerDescriptor => DESKTOP_IPC_CALLER;

/** The projection the read after a create returns. */
function readProjection(ref: {
  owner: string;
  repo: string;
  number: number;
}): unknown {
  return {
    view: {
      ref,
      url: PR_URL(ref.number),
      title: 'Golden title',
      state: 'open',
      isDraft: false,
      headBranch: 'feature-branch',
      baseBranch: 'main',
      headSha: 'a'.repeat(40),
      headRepository: 'golden-org/single-repo',
      mergeable: 'unknown',
      reviewDecision: null,
      checks: {
        state: 'none',
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        failedNames: [],
        available: true,
      },
      mergeQueue: { inQueue: false, position: null },
      fetchedAt: '2026-10-31T00:00:00.000Z',
    },
    detail: {
      title: 'Golden title',
      body: 'Golden body',
      baseSha: null,
      updatedAt: '2026-10-31T00:00:00Z',
      commentCount: 0,
      checks: [],
      checksAfter: null,
      reviewThreadCount: 0,
      unresolvedReviewThreadCount: 0,
      reviewThreadsAfter: null,
    },
  };
}

beforeAll(() => {
  const window = {
    isDestroyed: (): boolean => false,
    webContents: {
      send: mockWindowSend,
      isDestroyed: (): boolean => false,
      isCrashed: (): boolean => false,
      mainFrame: { isDestroyed: (): boolean => false, detached: false },
    },
  };
  registerGitHubHandlers(() => window as never, {
    dispatcher,
    resolveCaller: () => resolveIpcCaller(),
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockEnqueueCalls.length = 0;
  resolveIpcCaller = (): CanopyCallerDescriptor => DESKTOP_IPC_CALLER;
  mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
    branch: 'main',
    existsLocally: true,
    existsInRemote: true,
  });
  mockedGeneratePrContent.mockResolvedValue({
    title: 'Golden title',
    body: 'Golden body',
  });
  // No pull request exists for the branch until one is created.
  mockOctokit.pulls.list.mockResolvedValue({ data: [] });
  mockOctokit.pulls.create.mockImplementation(() =>
    Promise.resolve({ data: { number: 7, html_url: PR_URL(7) } }),
  );
  const notFaked = (): Promise<never> => Promise.reject(new Error('not faked'));
  mockOctokit.pulls.get.mockImplementation(notFaked);
  mockOctokit.pulls.listReviews.mockImplementation(notFaked);
  mockOctokit.checks.listForRef.mockImplementation(notFaked);
  mockOctokit.repos.getBranch.mockResolvedValue({
    data: { name: 'feature-branch', commit: { sha: 'a'.repeat(40) } },
  });
  mockReadGitHubPullRequestProjection.mockImplementation(
    (ref: { owner: string; repo: string; number: number }) =>
      Promise.resolve(readProjection(ref)),
  );
});

describe('github:create-pr goldens (CAN-4109)', () => {
  it('creates the pull request with one GitHub mutation and records it', async () => {
    await expect(
      createPr({ ...REQUEST, operationId: 'operation-golden' }).then((r) =>
        JSON.stringify(r),
      ),
    ).resolves.toBe(
      `{"repos":[{"repoId":"__single_repo__","repoName":"single-repo","prNumber":7,"prUrl":"${PR_URL(7)}"}],"skippedRepos":[],"localOnlyCommittedRepos":[]}`,
    );
    expect(createRequests()).toEqual([
      {
        owner: 'golden-org',
        repo: 'single-repo',
        title: 'Golden title',
        body: 'Golden body',
        head: 'feature-branch',
        base: 'main',
        draft: false,
      },
    ]);
    expect(mutationEnqueues()).toEqual([
      {
        priority: 'high',
        options: { operation: 'mutation', idempotency: 'unsafe' },
      },
    ]);
    expect(progressEvents()).toBe(
      `[${[
        phase('gathering_changes'),
        phase('summarizing'),
        phase('pushing'),
        phase('creating_pr'),
        phase('done'),
        phase('done', ',"refreshing":true'),
      ].join(',')}]`,
    );
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledTimes(1);
    expect(mockRecordCreatedPullRequest).toHaveBeenCalledTimes(1);
    expect(mockRecordCreatedPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 7, prUrl: PR_URL(7) }),
    );
  });

  it('adopts the open pull request GitHub reports for the branch, without recording a creation', async () => {
    mockOctokit.pulls.create.mockRejectedValue(
      githubValidationError(
        'A pull request already exists for golden-org:feature-branch.',
      ),
    );
    // The branch's pull request appears once the create has been attempted.
    mockOctokit.pulls.list.mockImplementation(() =>
      Promise.resolve({
        data:
          mockOctokit.pulls.create.mock.calls.length > 0
            ? [listedPullRequest(12)]
            : [],
      }),
    );

    await expect(
      createPr(REQUEST).then((r) => JSON.stringify(r)),
    ).resolves.toBe(
      `{"repos":[{"repoId":"__single_repo__","repoName":"single-repo","prNumber":12,"prUrl":"${PR_URL(12)}"}],"skippedRepos":[],"localOnlyCommittedRepos":[]}`,
    );
    expect(createRequests()).toHaveLength(1);
    expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
    expect(mockRecordCreatedPullRequest).not.toHaveBeenCalled();
  });

  it('retries against the default branch when GitHub rejects the effective base', async () => {
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'develop',
      existsLocally: true,
      existsInRemote: true,
    });
    mockedGeneratePrContent
      .mockResolvedValueOnce({ title: 'Against develop', body: 'Develop' })
      .mockResolvedValueOnce({ title: 'Against main', body: 'Main' });
    mockOctokit.pulls.create
      .mockRejectedValueOnce(
        githubValidationError('base branch does not exist', 'base'),
      )
      .mockResolvedValueOnce({ data: { number: 8, html_url: PR_URL(8) } });

    await expect(
      createPr(REQUEST).then((r) => JSON.stringify(r)),
    ).resolves.toBe(
      `{"repos":[{"repoId":"__single_repo__","repoName":"single-repo","prNumber":8,"prUrl":"${PR_URL(8)}"}],"skippedRepos":[],"localOnlyCommittedRepos":[]}`,
    );
    expect(createRequests()).toEqual([
      expect.objectContaining({ base: 'develop', title: 'Against develop' }),
      expect.objectContaining({ base: 'main', title: 'Against main' }),
    ]);
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledTimes(1);
  });

  it('reports a broker authentication failure from the create as a failed repository', async () => {
    mockOctokit.pulls.create.mockRejectedValue(
      new GitHubBrokerError('not_authenticated', NO_TOKEN_MESSAGE),
    );

    await expect(
      createPr(REQUEST).then((r) => JSON.stringify(r)),
    ).resolves.toBe(
      `{"repos":[],"failedRepos":[{"repoId":"__single_repo__","repoName":"single-repo","status":"failed","error":"${NO_TOKEN_MESSAGE}","failureCode":"github_not_authenticated","commitPrepared":true,"pushCompleted":true}],"skippedRepos":[],"localOnlyCommittedRepos":[]}`,
    );
    expect(createRequests()).toHaveLength(1);
    expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
    expect(mockRecordCreatedPullRequest).not.toHaveBeenCalled();
  });

  it('rethrows any other GitHub rejection of a single-repository create unchanged', async () => {
    mockOctokit.pulls.create.mockRejectedValue(
      githubValidationError('No commits between main and feature-branch'),
    );

    const outcome = await createPr(REQUEST).then(
      () => null,
      (error: unknown) =>
        error instanceof Error
          ? { name: error.name, message: error.message }
          : error,
    );
    expect(outcome).toEqual({
      name: 'HttpError',
      message: 'Validation Failed',
    });
    expect(createRequests()).toHaveLength(1);
    expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
  });

  it('lets a sent create settle and records it before honoring a cancel', async () => {
    let settleCreate: (() => void) | undefined;
    let markSent: (() => void) | undefined;
    const sent = new Promise<void>((resolve) => {
      markSent = resolve;
    });
    mockOctokit.pulls.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleCreate = (): void =>
            resolve({ data: { number: 10, html_url: PR_URL(10) } });
          markSent?.();
        }),
    );

    const operation = createPr({
      ...REQUEST,
      operationId: 'operation-golden-cancel',
    });
    await sent;
    expect(
      JSON.stringify(
        cancelGitAction({ ...REQUEST, operationId: 'operation-golden-cancel' }),
      ),
    ).toBe('{"accepted":true,"reason":"cancel_requested"}');
    expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
    settleCreate?.();

    await expect(operation.then((r) => JSON.stringify(r))).resolves.toBe(
      '{"repos":[],"skippedRepos":[],"localOnlyCommittedRepos":[],"cancelled":true}',
    );
    expect(createRequests()).toHaveLength(1);
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledTimes(1);
    expect(mockRecordCreatedPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 10, prUrl: PR_URL(10) }),
    );
    expect(progressEvents()).toBe(
      `[${[
        phase('gathering_changes'),
        phase('summarizing'),
        phase('pushing'),
        phase('creating_pr'),
      ].join(',')}]`,
    );
  });
});

// Added with CAN-4109, after the goldens above: how the flow's create steps
// reach core.pullRequest.create. The responses stay the goldens' own.
describe('github:create-pr through core.pullRequest.create', () => {
  const STATE_CHANGED = {
    name: 'Error',
    message: 'PR state changed. Refresh and try again.',
  };
  let instruction: jest.SpyInstance;

  beforeEach(() => {
    instruction = jest.spyOn(dispatcher, 'instruction');
  });

  afterEach(() => {
    instruction.mockRestore();
  });

  async function rejection(
    request: CreatePrRequest,
  ): Promise<{ name: string; message: string }> {
    try {
      await createPr(request);
    } catch (error: unknown) {
      if (error instanceof Error)
        return { name: error.name, message: error.message };
      throw error;
    }
    throw new Error('github:create-pr resolved');
  }

  it('sends each create step with the pushed head, a fresh key and only core.pullRequest.write', async () => {
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'develop',
      existsLocally: true,
      existsInRemote: true,
    });
    mockOctokit.pulls.create
      .mockRejectedValueOnce(
        githubValidationError('base branch does not exist', 'base'),
      )
      .mockResolvedValueOnce({ data: { number: 8, html_url: PR_URL(8) } });

    await createPr(REQUEST);

    const minted: unknown = expect.stringMatching(/^ghrepo1\./);
    const anyKey: unknown = expect.any(String);
    const step = {
      integrationId: 'github',
      repositoryId: minted,
      title: 'Golden title',
      body: 'Golden body',
      headBranch: 'feature-branch',
      expectedHeadSha: 'a'.repeat(40),
      draft: false,
    };
    const writer = {
      caller: { ...DESKTOP_IPC_CALLER, grants: ['core.pullRequest.write'] },
      metadata: { idempotencyKey: anyKey },
    };
    expect(instruction.mock.calls).toEqual([
      ['core.pullRequest.create', { ...step, baseBranch: 'develop' }, writer],
      ['core.pullRequest.create', { ...step, baseBranch: 'main' }, writer],
    ]);
    const keys = instruction.mock.calls.map(
      ([, , options]: [
        unknown,
        unknown,
        { metadata: { idempotencyKey: string } },
      ]) => options.metadata.idempotencyKey,
    );
    expect(new Set(keys).size).toBe(2);
    // The head read precedes each create; the second create still lands.
    expect(mockOctokit.repos.getBranch).toHaveBeenCalledWith({
      owner: 'golden-org',
      repo: 'single-repo',
      branch: 'feature-branch',
    });
    expect(createRequests()).toHaveLength(2);
    expect(mockReadGitHubPullRequestProjection).toHaveBeenCalledWith(
      { owner: 'golden-org', repo: 'single-repo', number: 8 },
      expect.objectContaining({ refresh: true }),
    );
  });

  it('refuses a create without a title as capability_unavailable: this core writes none', async () => {
    await expect(
      dispatcher.instruction(
        'core.pullRequest.create',
        {
          integrationId: 'github',
          repositoryId: 'ghrepo1.untitled',
          baseBranch: 'main',
          headBranch: 'feature-branch',
          expectedHeadSha: 'a'.repeat(40),
          draft: false,
        },
        {
          caller: { ...DESKTOP_IPC_CALLER, grants: ['core.pullRequest.write'] },
          metadata: { idempotencyKey: 'untitled' },
        },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(mockOctokit.repos.getBranch).not.toHaveBeenCalled();
    expect(createRequests()).toEqual([]);
  });

  it('refuses an untracked sender before the flow commits, pushes or calls GitHub', async () => {
    resolveIpcCaller = (): never => {
      throw canopyPermissionDeniedError('Untrusted desktop IPC sender.');
    };
    const { pushBranch, commitWithMessage } = jest.requireMock<{
      pushBranch: jest.Mock;
      commitWithMessage: jest.Mock;
    }>('../lib/git');

    // ipcMain.handle answers a synchronous throw as a rejection.
    await expect(
      Promise.resolve().then(() => createPr(REQUEST)),
    ).rejects.toMatchObject({
      payload: { kind: 'permission_denied' },
    });
    expect(commitWithMessage).not.toHaveBeenCalled();
    expect(pushBranch).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(progressEvents()).toBe('[]');
  });

  it('refuses a head that moved on GitHub as a state change, creating nothing', async () => {
    mockOctokit.repos.getBranch.mockResolvedValue({
      data: { name: 'feature-branch', commit: { sha: 'b'.repeat(40) } },
    });

    await expect(rejection(REQUEST)).resolves.toEqual(STATE_CHANGED);
    expect(createRequests()).toEqual([]);
    expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
  });

  it('refuses a head GitHub does not have as a state change, creating nothing', async () => {
    mockOctokit.repos.getBranch.mockRejectedValue(
      Object.assign(new Error('Branch not found'), {
        name: 'HttpError',
        status: 404,
      }),
    );

    await expect(rejection(REQUEST)).resolves.toEqual(STATE_CHANGED);
    expect(createRequests()).toEqual([]);
  });

  it("rethrows GitHub's 404 for a repository it hides, not a state change", async () => {
    mockOctokit.repos.getBranch.mockRejectedValue(
      Object.assign(new Error('Not Found'), { name: 'HttpError', status: 404 }),
    );

    await expect(rejection(REQUEST)).resolves.toEqual({
      name: 'HttpError',
      message: 'Not Found',
    });
    expect(createRequests()).toEqual([]);
  });

  it('refuses origin drift before the repository-unavailable direct create fallback', async () => {
    const { getRemoteUrl } = jest.requireMock<{
      getRemoteUrl: jest.Mock<Promise<string | null>, [string]>;
    }>('../lib/git');
    let sourceReads = 0;
    getRemoteUrl.mockImplementation((path: string) => {
      if (path === '/source/single-repo' && ++sourceReads === 2)
        return Promise.resolve(null);
      return Promise.resolve(
        sourceReads >= 2
          ? 'git@github.com:another/repository.git'
          : 'git@github.com:golden-org/single-repo.git',
      );
    });
    try {
      await expect(rejection(REQUEST)).resolves.toEqual(STATE_CHANGED);
      expect(createRequests()).toEqual([]);
    } finally {
      getRemoteUrl.mockImplementation(() =>
        Promise.resolve('git@github.com:golden-org/single-repo.git'),
      );
    }
  });

  it('returns and records the created pull request when the read after it fails', async () => {
    mockReadGitHubPullRequestProjection.mockRejectedValue(
      new GitHubBrokerError('network', 'socket hang up'),
    );

    await expect(
      createPr(REQUEST).then((r) => JSON.stringify(r)),
    ).resolves.toBe(
      `{"repos":[{"repoId":"__single_repo__","repoName":"single-repo","prNumber":7,"prUrl":"${PR_URL(7)}"}],"skippedRepos":[],"localOnlyCommittedRepos":[]}`,
    );
    expect(createRequests()).toHaveLength(1);
    expect(recordPullRequestOpenedTelemetry).toHaveBeenCalledTimes(1);
  });

  it.each([
    'git@github.com:another/repository.git',
    null,
    'https://gitlab.com/golden-org/single-repo.git',
  ])(
    'refuses duplicate reconciliation origin drift (%s) without further GitHub use',
    async (origin) => {
      const { getRemoteUrl, resolveRefSha } = jest.requireMock<{
        getRemoteUrl: jest.Mock<Promise<string | null>, [string]>;
        resolveRefSha: jest.Mock<Promise<string>, [string, string]>;
      }>('../lib/git');
      resolveRefSha.mockRejectedValueOnce(new Error('unknown revision'));
      let callsAtDuplicate = 0;
      mockOctokit.pulls.create.mockImplementationOnce(() => {
        getRemoteUrl.mockResolvedValue(origin);
        callsAtDuplicate = mockEnqueue.mock.calls.length;
        return Promise.reject(
          githubValidationError(
            'A pull request already exists for golden-org:feature-branch.',
          ),
        );
      });
      mockOctokit.pulls.list.mockImplementation(() =>
        Promise.resolve({
          data: createRequests().length > 0 ? [listedPullRequest(12)] : [],
        }),
      );
      try {
        await expect(rejection(REQUEST)).resolves.toEqual(STATE_CHANGED);
        expect(createRequests()).toHaveLength(1);
        expect(mockEnqueue).toHaveBeenCalledTimes(callsAtDuplicate);
        expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
        expect(mockRecordCreatedPullRequest).not.toHaveBeenCalled();
      } finally {
        getRemoteUrl.mockImplementation(() =>
          Promise.resolve('git@github.com:golden-org/single-repo.git'),
        );
      }
    },
  );

  it.each([false, true])(
    'keeps duplicate adoption byte for byte through the direct IPC create step (drift during reconciliation: %s)',
    async (moved) => {
      const { getRemoteUrl, resolveRefSha } = jest.requireMock<{
        getRemoteUrl: jest.Mock<Promise<string | null>, [string]>;
        resolveRefSha: jest.Mock<Promise<string>, [string, string]>;
      }>('../lib/git');
      resolveRefSha.mockRejectedValueOnce(new Error('unknown revision'));
      mockOctokit.pulls.create.mockRejectedValueOnce(
        githubValidationError(
          'A pull request already exists for golden-org:feature-branch.',
        ),
      );
      mockOctokit.pulls.list.mockImplementation(() => {
        const reconciling = createRequests().length > 0;
        if (reconciling && moved)
          getRemoteUrl.mockResolvedValue(
            'git@github.com:another/repository.git',
          );
        return Promise.resolve({
          data: reconciling ? [listedPullRequest(12)] : [],
        });
      });
      try {
        await expect(
          createPr(REQUEST).then((r) => JSON.stringify(r)),
        ).resolves.toBe(
          `{"repos":[{"repoId":"__single_repo__","repoName":"single-repo","prNumber":12,"prUrl":"${PR_URL(12)}"}],"skippedRepos":[],"localOnlyCommittedRepos":[]}`,
        );
        expect(createRequests()).toHaveLength(1);
        // Every reconciliation read stays on the attempted create's repository.
        for (const read of [
          mockOctokit.pulls.list,
          mockOctokit.pulls.get,
          mockOctokit.pulls.listReviews,
          mockOctokit.checks.listForRef,
        ])
          for (const [params] of read.mock.calls)
            expect(params).toEqual(
              expect.objectContaining({
                owner: 'golden-org',
                repo: 'single-repo',
              }),
            );
        expect(recordPullRequestOpenedTelemetry).not.toHaveBeenCalled();
        expect(mockRecordCreatedPullRequest).not.toHaveBeenCalled();
      } finally {
        getRemoteUrl.mockImplementation(() =>
          Promise.resolve('git@github.com:golden-org/single-repo.git'),
        );
      }
    },
  );

  it.each([false, true])(
    'only adopts a duplicate on the verified repository (origin moved: %s)',
    async (moved) => {
      const { getRemoteUrl } = jest.requireMock<{
        getRemoteUrl: jest.Mock<Promise<string | null>, [string]>;
      }>('../lib/git');
      mockOctokit.pulls.create.mockImplementationOnce(() => {
        if (moved)
          getRemoteUrl.mockResolvedValue(
            'git@github.com:another/repository.git',
          );
        return Promise.reject(
          githubValidationError(
            'A pull request already exists for golden-org:feature-branch.',
          ),
        );
      });
      mockOctokit.pulls.list.mockResolvedValue({
        data: [listedPullRequest(12)],
      });
      try {
        const result = createPrForRepo(
          '/workspace/single-repo',
          'feature-branch',
          'title',
          'body',
          'main',
          false,
          { owner: 'golden-org', repo: 'single-repo' },
        );
        if (moved) {
          await expect(result).rejects.toThrow(
            'PR state changed. Refresh and try again.',
          );
        } else {
          await expect(result).resolves.toEqual({
            prNumber: 12,
            prUrl: PR_URL(12),
            created: false,
          });
        }
        expect(createRequests()).toHaveLength(1);
        expect(createRequests()[0]).toEqual(
          expect.objectContaining({
            owner: 'golden-org',
            repo: 'single-repo',
          }),
        );
      } finally {
        getRemoteUrl.mockImplementation(() =>
          Promise.resolve('git@github.com:golden-org/single-repo.git'),
        );
      }
    },
  );

  it('keeps the direct create for a checkout whose origin is not the recorded one', async () => {
    const { getRemoteUrl } = jest.requireMock<{
      getRemoteUrl: jest.Mock<Promise<string | null>, [string]>;
    }>('../lib/git');
    getRemoteUrl.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/source/single-repo'
          ? 'git@github.com:golden-org/elsewhere.git'
          : 'git@github.com:golden-org/single-repo.git',
      ),
    );
    try {
      await createPr(REQUEST);
    } finally {
      getRemoteUrl.mockImplementation(() =>
        Promise.resolve('git@github.com:golden-org/single-repo.git'),
      );
    }

    expect(instruction).not.toHaveBeenCalled();
    expect(mockOctokit.repos.getBranch).not.toHaveBeenCalled();
    expect(createRequests()).toEqual([
      expect.objectContaining({ owner: 'golden-org', repo: 'single-repo' }),
    ]);
  });

  it('keeps the direct create when origin has no remote-tracking head', async () => {
    const { resolveRefSha } = jest.requireMock<{
      resolveRefSha: jest.Mock<Promise<string>, [string, string]>;
    }>('../lib/git');
    resolveRefSha.mockRejectedValueOnce(new Error('unknown revision'));

    await createPr(REQUEST);

    expect(resolveRefSha).toHaveBeenCalledWith(
      '/workspace/single-repo',
      'refs/remotes/origin/feature-branch^{commit}',
    );
    expect(instruction).not.toHaveBeenCalled();
    expect(createRequests()).toHaveLength(1);
  });

  it("keeps the direct create for the Portal's create_auto action", async () => {
    if (!mockWorktreePrActions) throw new Error('PR actions not registered');

    await mockWorktreePrActions.create(REQUEST);

    expect(instruction).not.toHaveBeenCalled();
    expect(mockOctokit.repos.getBranch).not.toHaveBeenCalled();
    expect(createRequests()).toHaveLength(1);
  });
});
