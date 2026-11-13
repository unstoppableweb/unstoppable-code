// CAN-4728 migration golden: the production desktop composition, not a second
// dispatcher assembled by the test. Most cases replace the request-use port;
// terminal-refusal cases exercise that port with the GitHub writer replaced.
jest.mock('../../lib/github-pr', () => ({
  ...jest.requireActual<object>('../../lib/github-pr'),
  mergePrForRemote: jest.fn(),
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_PULL_REQUEST_REFRESH_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CorePullRequest,
} from '@canopy/protocol/canopy-core';
import {
  GitHubRequestError,
  mintPullRequestId,
  type GitHubPullRequestRecord,
  type CorePullRequestHost,
  type GitHubRequestHandle,
  type GitHubMergePolicy,
  type GitHubMergeResult,
} from '@canopy/core-runtime/node/github';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

import { desktopGitHubRequestHandle } from '../../github/request-handle';
import { mergePrForRemote } from '../../lib/github-pr';
import { GitHubBrokerError } from '../../lib/github-broker/errors';
import { hostError } from '../github-pull-request-dispatch';

const github = { owner: 'golden-org', repo: 'golden-repo' };
const repository = { workspaceId: 'merge-workspace' };
const pullRequestId = mintPullRequestId({ repository, github, number: 355 });
if (pullRequestId === null) throw new Error('Invalid golden identity');
const head = 'a'.repeat(40);
const at = '2026-11-06T10:00:00.000Z';
const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  authorityId: 'local-desktop',
  clientInstanceId: 'electron-web-contents:1',
  interfaceKind: 'desktop',
  grants: ['core.pullRequest.read', 'core.pullRequest.write'],
};
const params = {
  pullRequestId,
  expectedRevision: Date.parse(at),
  expectedHeadSha: head,
  strategy: 'squash' as const,
};
let record: GitHubPullRequestRecord;
let policy: GitHubMergePolicy;
let runtime: DesktopCanopyDispatcher;
const read = jest.fn<Promise<GitHubPullRequestRecord>, []>();
const merge = jest.fn<Promise<GitHubMergeResult>, []>();
const queue = jest.fn<
  ReturnType<GitHubRequestHandle['getMergeQueue']>,
  Parameters<GitHubRequestHandle['getMergeQueue']>
>();
const resolveRepository = jest.fn<
  ReturnType<CorePullRequestHost['resolveRepository']>,
  Parameters<CorePullRequestHost['resolveRepository']>
>();
const daemonRoute = jest.fn((): never => {
  throw new Error('This family must not contact the daemon');
});
const handle: GitHubRequestHandle = {
  describe: () =>
    Promise.resolve({ tokenSource: 'none', storedCredential: 'absent' }),
  getPullRequest: read,
  listPullRequests: () =>
    Promise.resolve({ pullRequests: [], endCursor: null }),
  listRepositories: () =>
    Promise.resolve({ snapshotId: 'snapshot', repositories: [] }),
  getBranchHead: () => Promise.resolve({ sha: head }),
  createPullRequest: () => Promise.resolve({ number: 355, url: record.url }),
  findOpenPullRequest: () => Promise.resolve(null),
  updatePullRequest: () => Promise.resolve({ number: 355, url: record.url }),
  getMergePolicy: () => Promise.resolve(policy),
  mergePullRequest: merge,
  getMergeQueue: queue,
};
let dir: string;
let previousDataDir: string | undefined;
beforeAll(() => {
  previousDataDir = process.env.CANOPY_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'can-4728-'));
  process.env.CANOPY_DATA_DIR = dir;
});
beforeEach(() => {
  jest.clearAllMocks();
  record = {
    number: 355,
    title: 'Merge fixture',
    body: '',
    url: 'https://github.com/golden-org/golden-repo/pull/355',
    state: 'open',
    draft: false,
    baseBranch: 'develop',
    baseSha: 'b'.repeat(40),
    headBranch: 'feature',
    headSha: head,
    mergeable: 'mergeable',
    reviewDecision: 'approved',
    checks: [],
    reviewThreadCount: 0,
    unresolvedReviewThreadCount: 0,
    commentCount: 0,
    updatedAt: at,
  };
  policy = {
    allowedStrategies: ['merge', 'squash', 'rebase'],
    preferredStrategy: 'merge',
    queueRequired: false,
  };
  read.mockImplementation(() => Promise.resolve(record));
  resolveRepository.mockResolvedValue(github);
  queue.mockResolvedValue({ queue: null });
  merge.mockImplementation(() => {
    record = {
      ...record,
      state: 'merged',
      updatedAt: '2026-11-06T10:01:00.000Z',
    };
    return Promise.resolve({
      outcome: 'merged',
      newlyMerged: true,
      mergeMethod: 'squash',
      mergeCommitSha: 'c'.repeat(40),
    });
  });
  runtime = createDesktopRuntime({
    pullRequestHost: { github: handle, resolveRepository },
    daemonFilesRoute: daemonRoute,
  });
});
afterEach(async () => {
  expect(daemonRoute).not.toHaveBeenCalled();
  await runtime.shutdown();
});
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});
function run(key = 'merge-key'): Promise<CorePullRequest> {
  return runtime.instruction('core.pullRequest.merge', params, {
    caller,
    metadata: { idempotencyKey: key },
  });
}

it('merges the exact head with an explicitly allowed nonpreferred strategy', async () => {
  await expect(run()).resolves.toEqual(
    expect.objectContaining({ state: 'merged', headSha: head }),
  );
  expect(merge).toHaveBeenCalledWith(
    { ...github, number: 355 },
    { expectedHeadSha: head, strategy: 'squash' },
    policy,
  );
  expect(resolveRepository).toHaveBeenCalledWith(repository, 'write');
});
it("merges without a strategy by the repository's preferred one", async () => {
  policy = { ...policy, preferredStrategy: 'rebase' };
  await expect(
    runtime.instruction(
      'core.pullRequest.merge',
      {
        pullRequestId,
        expectedRevision: params.expectedRevision,
        expectedHeadSha: head,
      },
      { caller, metadata: { idempotencyKey: 'preferred-key' } },
    ),
  ).resolves.toMatchObject({ state: 'merged' });
  expect(merge).toHaveBeenCalledWith(
    { ...github, number: 355 },
    { expectedHeadSha: head, strategy: 'rebase' },
    policy,
  );
});
it.each([
  [{ headSha: 'd'.repeat(40) }, 'core.pullRequest.merge.headMismatch'],
  [
    { updatedAt: '2026-11-06T09:59:00.000Z' },
    'core.pullRequest.merge.revisionConflict',
  ],
  [{ state: 'closed' }, 'core.pullRequest.merge.notMergeable'],
  [{ draft: true }, 'core.pullRequest.merge.notMergeable'],
  [{ mergeable: 'conflicting' }, 'core.pullRequest.merge.notMergeable'],
  [
    { reviewDecision: 'changes_requested' },
    'core.pullRequest.merge.notMergeable',
  ],
] satisfies [Partial<GitHubPullRequestRecord>, string][])(
  'refuses preconditions %j before mutation',
  async (patch, code) => {
    record = { ...record, ...patch };
    await expect(run()).rejects.toMatchObject({ payload: { code } });
    expect(merge).not.toHaveBeenCalled();
  },
);
it('honours pinned base and head branches: merges when they match, refuses and merges nothing when not', async () => {
  const pinned = (pins: object, key: string): Promise<CorePullRequest> =>
    runtime.instruction(
      'core.pullRequest.merge',
      { ...params, ...pins },
      { caller, metadata: { idempotencyKey: key } },
    );
  for (const [pins, key] of [
    [{ expectedBaseBranch: 'main' }, 'base-key'],
    [{ expectedHeadBranch: 'other' }, 'head-key'],
  ] as const) {
    await expect(pinned(pins, key)).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.pullRequest.merge.headMismatch',
      },
    });
    expect(merge).not.toHaveBeenCalled();
  }
  await expect(
    pinned(
      { expectedBaseBranch: 'develop', expectedHeadBranch: 'feature' },
      'pinned-key',
    ),
  ).resolves.toMatchObject({ state: 'merged' });
  expect(merge).toHaveBeenCalledTimes(1);
});
it('refuses a queue-required base without enqueueing (legacy enqueue is CAN-5886)', async () => {
  policy = { ...policy, queueRequired: true };
  await expect(run()).rejects.toMatchObject({
    payload: { code: 'core.pullRequest.merge.mergeQueueRequired' },
  });
  expect(merge).not.toHaveBeenCalled();
});
it('refuses changed origins and read-only scopes before GitHub use', async () => {
  resolveRepository.mockResolvedValueOnce({
    owner: 'another',
    repo: 'repository',
  });
  await expect(run()).rejects.toMatchObject({
    payload: { code: 'core.pullRequest.repositoryUnavailable' },
  });
  resolveRepository.mockResolvedValueOnce(null);
  await expect(run('other-key')).rejects.toMatchObject({
    payload: { code: 'core.pullRequest.repositoryUnavailable' },
  });
  expect(read).not.toHaveBeenCalled();
  expect(merge).not.toHaveBeenCalled();
});
it('checks both grants before handler entry', async () => {
  const ungranted = { ...caller, grants: [] };
  await expect(
    runtime.instruction('core.pullRequest.merge', params, {
      caller: ungranted,
      metadata: { idempotencyKey: 'denied' },
    }),
  ).rejects.toBeInstanceOf(CanopyOperationError);
  await expect(
    runtime.query(
      'core.pullRequest.mergeQueue.get',
      { repository: 'golden-org/golden-repo', baseBranch: 'develop' },
      { caller: ungranted },
    ),
  ).rejects.toBeInstanceOf(CanopyOperationError);
  expect(resolveRepository).not.toHaveBeenCalled();
  expect(queue).not.toHaveBeenCalled();
});
it('deduplicates concurrent writes and same-key replay, refusing another payload', async () => {
  await Promise.all([run(), run()]);
  await run();
  expect(merge).toHaveBeenCalledTimes(1);
  await expect(
    runtime.instruction(
      'core.pullRequest.merge',
      { ...params, strategy: 'rebase' },
      { caller, metadata: { idempotencyKey: 'merge-key' } },
    ),
  ).rejects.toMatchObject({
    payload: { code: 'core.pullRequest.idempotencyKeyReused' },
  });
});
it('retains a successful write when its projection fails and never merges again', async () => {
  read
    .mockImplementationOnce(() => Promise.resolve(record))
    .mockRejectedValueOnce(new GitHubRequestError('unavailable', 'offline'));
  await expect(run()).rejects.toMatchObject({
    payload: { code: 'core.pullRequest.projectionUnavailable' },
  });
  await expect(run()).resolves.toMatchObject({ state: 'merged' });
  expect(merge).toHaveBeenCalledTimes(1);
});
it('answers an already merged exact head without a second write', async () => {
  record = {
    ...record,
    state: 'merged',
    updatedAt: '2026-11-06T10:01:00.000Z',
  };
  await expect(run()).resolves.toMatchObject({ state: 'merged' });
  expect(merge).not.toHaveBeenCalled();
});
it('keeps a head race at the writer typed and redacted', async () => {
  merge.mockRejectedValueOnce(
    new GitHubRequestError('head_mismatch', 'The pull request head changed.'),
  );
  await expect(run()).rejects.toMatchObject({
    payload: { kind: 'conflict', code: 'core.pullRequest.merge.headMismatch' },
  });
  expect(merge).toHaveBeenCalledTimes(1);
});
it('serves the RC-14 read in process and never turns an unreadable state into an empty queue', async () => {
  const request = {
    repository: 'golden-org/golden-repo',
    baseBranch: 'develop',
  };
  await expect(
    runtime.query('core.pullRequest.mergeQueue.get', request, { caller }),
  ).resolves.toEqual({ queue: null });
  queue.mockRejectedValueOnce(new GitHubRequestError('not_found', 'hidden'));
  await expect(
    runtime.query('core.pullRequest.mergeQueue.get', request, { caller }),
  ).rejects.toMatchObject({
    payload: { kind: 'not_found', code: 'core.pullRequest.notFound' },
  });
});

it('revalidates the writable origin on a same-key replay without another mutation', async () => {
  await run();
  resolveRepository.mockResolvedValueOnce(null);
  await expect(run()).rejects.toMatchObject({
    payload: { code: 'core.pullRequest.repositoryUnavailable' },
  });
  expect(merge).toHaveBeenCalledTimes(1);
});
it('does not acknowledge an open post-write projection as a merged result', async () => {
  const stale = record;
  read.mockResolvedValueOnce(stale).mockResolvedValueOnce(stale);
  await expect(run()).rejects.toMatchObject({
    payload: { code: 'core.pullRequest.projectionUnavailable' },
  });
  await expect(run()).resolves.toMatchObject({ state: 'merged' });
  expect(merge).toHaveBeenCalledTimes(1);
});
it('refuses a disabled explicit strategy without silently substituting the preference', async () => {
  policy = { ...policy, allowedStrategies: ['merge'] };
  await expect(run()).rejects.toMatchObject({
    payload: { kind: 'capability_unavailable' },
  });
  expect(merge).not.toHaveBeenCalled();
});
it('refuses malformed queue references before the request-use port', async () => {
  await expect(
    runtime.query(
      'core.pullRequest.mergeQueue.get',
      { repository: 'golden-org/golden-repo/extra', baseBranch: 'develop' },
      { caller },
    ),
  ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  expect(queue).not.toHaveBeenCalled();
});

it('rechecks the writable origin after the preflight yields', async () => {
  read.mockImplementationOnce(() => {
    resolveRepository.mockResolvedValue({ owner: 'moved', repo: 'elsewhere' });
    return Promise.resolve(record);
  });
  await expect(run()).rejects.toMatchObject({
    payload: { code: 'core.pullRequest.repositoryUnavailable' },
  });
  expect(merge).not.toHaveBeenCalled();
});
it('keeps a queue-policy race at the writer typed without retrying or enqueueing', async () => {
  merge.mockRejectedValueOnce(
    new GitHubRequestError('merge_queue_required', 'queue now required'),
  );
  await expect(run()).rejects.toMatchObject({
    payload: {
      kind: 'failed_precondition',
      code: 'core.pullRequest.merge.mergeQueueRequired',
    },
  });
  expect(merge).toHaveBeenCalledTimes(1);
});
it('consumes the writer verification without a redundant projection read and refreshes on replay', async () => {
  const verified = { ...record, state: 'merged' as const };
  merge.mockImplementationOnce(() => {
    record = verified;
    return Promise.resolve({
      outcome: 'merged',
      newlyMerged: true,
      mergeMethod: 'squash',
      mergeCommitSha: 'c'.repeat(40),
      projection: verified,
    });
  });
  await expect(run()).resolves.toMatchObject({ state: 'merged' });
  expect(read).toHaveBeenCalledTimes(1);
  await expect(run()).resolves.toMatchObject({ state: 'merged' });
  expect(read).toHaveBeenCalledTimes(2);
  expect(merge).toHaveBeenCalledTimes(1);
});
it('retains a receipt when only legacy verification succeeds, then retries only the projection', async () => {
  merge.mockImplementationOnce(() => {
    record = { ...record, state: 'merged' };
    return Promise.resolve({
      outcome: 'merged',
      newlyMerged: true,
      mergeMethod: 'squash',
      mergeCommitSha: 'c'.repeat(40),
      projection: null,
    });
  });
  await expect(run()).rejects.toMatchObject({
    payload: {
      kind: 'unavailable',
      code: 'core.pullRequest.projectionUnavailable',
      retry: { kind: 'same_idempotency_key' },
    },
  });
  expect(read).toHaveBeenCalledTimes(1);
  await expect(run()).resolves.toMatchObject({ state: 'merged' });
  expect(merge).toHaveBeenCalledTimes(1);
});
it('does not replay a receipt after its origin changes to another GitHub repository', async () => {
  await run();
  resolveRepository.mockResolvedValue({ owner: 'another', repo: 'repository' });
  await expect(run()).rejects.toMatchObject({
    payload: { code: 'core.pullRequest.repositoryUnavailable' },
  });
  expect(merge).toHaveBeenCalledTimes(1);
});

it('refuses the web-core-only refresh as capability_unavailable, reading nothing', async () => {
  const refresh =
    CORE_PULL_REQUEST_REFRESH_INSTRUCTION_DEFINITIONS[
      'core.pullRequest.refresh'
    ];
  const request = refresh.params.parse({
    scope: { workspaceId: 'merge-workspace', worktreeId: 'merge-worktree' },
  });
  await expect(
    // Not in the desktop registry, so its typed names do not include it.
    runtime.instruction('core.pullRequest.refresh' as never, request as never, {
      caller,
    }),
  ).rejects.toMatchObject({
    payload: { kind: 'capability_unavailable', retry: { kind: 'never' } },
  });
  expect(read).not.toHaveBeenCalled();
  expect(resolveRepository).not.toHaveBeenCalled();
});

describe('terminal writer refusals through the desktop request-use port', () => {
  beforeEach(async () => {
    await runtime.shutdown();
    runtime = createDesktopRuntime({
      pullRequestHost: {
        github: {
          ...handle,
          mergePullRequest: (ref, input, policy) =>
            desktopGitHubRequestHandle.mergePullRequest(ref, input, policy),
        },
        resolveRepository,
      },
      daemonFilesRoute: daemonRoute,
    });
  });

  it.each([
    Object.assign(new Error('Pull request is not mergeable'), { status: 405 }),
    Object.assign(new Error('Base branch was modified'), { status: 409 }),
    Object.assign(new Error('Merge conflicts'), { status: 409 }),
    new Error('Pull request is not in a mergeable state'),
    new Error('Review and try the merge again'),
    new Error('Merge commit cannot be cleanly created'),
    Object.assign(new Error('GitHub refused the merge'), {
      response: { status: 409, data: {} },
    }),
    Object.assign(new Error('GitHub refused the merge'), {
      response: { data: { message: 'Pull request is not mergeable' } },
    }),
    Object.assign(new Error('GitHub refused the merge'), {
      response: { data: { errors: [{ message: 'Merge conflicts' }] } },
    }),
  ])(
    'keeps a terminal refusal typed with its original runtime cause: %s',
    async (rejection) => {
      jest.mocked(mergePrForRemote).mockRejectedValueOnce(rejection);
      const failure = run();
      await expect(failure).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.pullRequest.merge.notMergeable',
          retry: { kind: 'after_refresh', resource: 'pull-request' },
        },
        runtimeCause: rejection,
      });
      await expect(failure.catch(hostError)).resolves.toBe(rejection);
      expect(mergePrForRemote).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    new Error('Unexpected writer failure'),
    Object.assign(new Error('Validation failed'), { status: 422 }),
    Object.assign(new Error('Server error'), { status: 500 }),
    new Error('GitHub did not merge the pull request.'),
    null,
    '',
    undefined,
  ])('does not reclassify unrelated failures: %s', async (rejection) => {
    jest.mocked(mergePrForRemote).mockRejectedValueOnce(rejection);
    await expect(run()).rejects.toMatchObject({
      payload: { kind: 'internal', retry: { kind: 'never' } },
      runtimeCause: rejection,
    });
  });

  it('keeps unrelated broker failures on their existing same-key retry mapping', async () => {
    const rejection = new GitHubBrokerError('network', 'Connection lost');
    jest.mocked(mergePrForRemote).mockRejectedValueOnce(rejection);
    await expect(run()).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        retry: { kind: 'same_idempotency_key' },
      },
      runtimeCause: rejection,
    });
  });

  it('keeps a moved head distinct from a terminal mergeability refusal', async () => {
    const rejection = new Error(
      'Cannot retry the pull request merge because the PR head commit changed.',
    );
    jest.mocked(mergePrForRemote).mockRejectedValueOnce(rejection);
    await expect(run()).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.pullRequest.merge.headMismatch',
        retry: { kind: 'after_refresh', resource: 'pull-request' },
      },
      runtimeCause: rejection,
    });
  });

  it('keeps a queue-required race distinct from a mergeability refusal', async () => {
    const rejection = Object.assign(new Error('Merge queue is required'), {
      status: 405,
    });
    jest
      .mocked(mergePrForRemote)
      .mockRejectedValueOnce(
        new GitHubRequestError(
          'merge_queue_required',
          'The base branch requires a merge queue.',
          { cause: rejection },
        ),
      );
    await expect(run()).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.pullRequest.merge.mergeQueueRequired',
        retry: { kind: 'after_refresh', resource: 'pull-request' },
      },
      runtimeCause: rejection,
    });
  });
});
