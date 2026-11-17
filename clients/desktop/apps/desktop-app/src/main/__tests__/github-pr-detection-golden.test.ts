// CAN-4176 golden: PR-state trigger detection as desktop serves it today,
// captured before the snapshot substrate moves into core. It drives the real
// snapshot-diff store under <worktreeDataDir>/github-pr/ on the isolated
// test data root, including the CAN-4145 staged advance; only the usage
// metric sink is replaced. A change here is a behaviour change: re-record
// deliberately with `pnpm test <this file> -u` and review the snapshot diff.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  GitHubCheckSnapshot,
  GitHubIssueCommentSnapshot,
  GitHubReviewCommentSnapshot,
  GitHubReviewSnapshot,
  PersistedPrSnapshotFileV1,
} from '@canopy/desktop-shared/types/github';
import type { HookTriggerName } from '@canopy/desktop-shared/hooks';
import {
  advancePrTrackingState,
  getProjectRepoStorageKey,
  prAdvanceSubject,
  readCurrentPrTrackingSnapshot,
  settlePrTrackingState,
  type PrAdvanceCommit,
} from '../lib/github-pr-hook-state';
import { getGitHubPrStateDir } from '../lib/paths';

const usageEvents: unknown[] = [];
jest.mock('../observability/ingest', () => ({
  getExecutionObservabilityIngest: (): object => ({
    recordUsageMetricEvent: (event: { name?: string; kind?: string }): void => {
      usageEvents.push(event.name ?? event.kind ?? 'usage');
    },
  }),
}));

const PROJECT = 'golden-github';
let worktreeCounter = 0;
let worktree = 'golden-wt-0';
const repo = getProjectRepoStorageKey();

beforeEach(() => {
  worktreeCounter += 1;
  worktree = `golden-wt-${String(worktreeCounter)}`;
  usageEvents.length = 0;
});

const T0 = '2026-11-16T10:00:00.000Z';
function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

function comment(id: number, minutes: number): GitHubIssueCommentSnapshot {
  return {
    id,
    nodeId: null,
    htmlUrl: null,
    apiUrl: null,
    author: null,
    authorAssociation: null,
    body: `comment ${String(id)}`,
    createdAt: at(minutes),
    updatedAt: at(minutes),
  };
}

function review(id: number, minutes: number): GitHubReviewSnapshot {
  return {
    id,
    nodeId: null,
    htmlUrl: null,
    apiUrl: null,
    author: null,
    state: 'COMMENTED',
    body: 'review',
    commitId: 'head-1',
    submittedAt: at(minutes),
  };
}

function reviewComment(
  id: number,
  reviewId: number,
  minutes: number,
): GitHubReviewCommentSnapshot {
  return {
    id,
    nodeId: null,
    htmlUrl: null,
    apiUrl: null,
    pullRequestReviewId: reviewId,
    inReplyToId: null,
    author: null,
    authorAssociation: null,
    body: 'inline',
    path: 'src/file.ts',
    commitId: 'head-1',
    originalCommitId: 'head-1',
    diffHunk: null,
    line: 1,
    originalLine: 1,
    startLine: null,
    originalStartLine: null,
    side: 'RIGHT',
    startSide: null,
    createdAt: at(minutes),
    updatedAt: at(minutes),
  };
}

function check(
  id: number,
  status: GitHubCheckSnapshot['status'],
  conclusion: string | null,
): GitHubCheckSnapshot {
  return {
    id,
    name: `check-${String(id)}`,
    appSlug: null,
    appName: null,
    status,
    rawStatus: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
    detailsUrl: null,
    startedAt: T0,
    completedAt: conclusion === null ? null : T0,
  };
}

interface SnapshotOptions {
  minutes?: number;
  prId?: number;
  state?: PersistedPrSnapshotFileV1['pr']['state'];
  labels?: string[];
  comments?: GitHubIssueCommentSnapshot[];
  reviews?: GitHubReviewSnapshot[];
  reviewComments?: GitHubReviewCommentSnapshot[];
  checks?: GitHubCheckSnapshot[];
  headSha?: string;
  complete?: boolean;
  credentialScope?: string;
  conflicts?: boolean;
}

function snapshot(options: SnapshotOptions = {}): PersistedPrSnapshotFileV1 {
  const complete = options.complete ?? true;
  const headSha = options.headSha ?? 'head-1';
  return {
    version: 1,
    provider: 'github',
    capturedAt: at(options.minutes ?? 0),
    credentialScope: options.credentialScope ?? 'scope-a',
    includesComments: complete,
    includesReviews: complete,
    includesReviewComments: complete,
    repository: { owner: 'acme', name: 'app', fullName: 'acme/app' },
    branch: {
      currentName: 'feature',
      headRefName: 'feature',
      baseRefName: 'develop',
      headSha,
      baseSha: 'base-1',
    },
    pr: {
      id: options.prId ?? 101,
      number: options.prId ?? 101,
      nodeId: null,
      htmlUrl: `https://github.com/acme/app/pull/${String(options.prId ?? 101)}`,
      apiUrl: null,
      state: options.state ?? 'open',
      isDraft: options.state === 'draft',
      title: 'Feature',
      body: '',
      author: null,
      createdAt: T0,
      updatedAt: at(options.minutes ?? 0),
      mergedAt: options.state === 'merged' ? at(options.minutes ?? 0) : null,
      closedAt:
        options.state === 'merged' || options.state === 'closed'
          ? at(options.minutes ?? 0)
          : null,
      mergeCommitSha: null,
      mergedBy: null,
      isCrossRepository: false,
      labels: (options.labels ?? []).map((name, index) => ({
        id: index + 1,
        nodeId: null,
        name,
        color: '000000',
        description: null,
      })),
      assignees: [],
      requestedReviewers: [],
    },
    issueComments: options.comments ?? [],
    reviews: options.reviews ?? [],
    reviewComments: options.reviewComments ?? [],
    ...(options.checks ? { checks: { headSha, items: options.checks } } : {}),
    ...(options.conflicts === undefined
      ? {}
      : {
          mergeConflicts: {
            hasConflicts: options.conflicts,
            mergeable: !options.conflicts,
            mergeableState: options.conflicts ? 'dirty' : 'clean',
          },
        }),
  };
}

async function advance(
  current: PersistedPrSnapshotFileV1 | null,
  extra: {
    branchName?: string;
    commit?: PrAdvanceCommit;
    committedHead?: PrAdvanceCommit['committedHead'];
  } = {},
): Promise<HookTriggerName[]> {
  const result = await advancePrTrackingState({
    projectId: PROJECT,
    worktreeId: worktree,
    repoStorageKey: repo,
    branchName: extra.branchName ?? 'feature',
    currentSnapshot: current,
    credentialScope: current?.credentialScope ?? 'scope-a',
    worktreeCreatedAt: '2026-11-01T00:00:00.000Z',
    ...(extra.commit ? { commit: extra.commit } : {}),
    ...(extra.committedHead ? { committedHead: extra.committedHead } : {}),
  });
  return result.triggers;
}

async function sequence(
  steps: [string, PersistedPrSnapshotFileV1 | null, string?][],
): Promise<Record<string, HookTriggerName[]>> {
  const out: Record<string, HookTriggerName[]> = {};
  for (const [label, current, branchName] of steps) {
    out[label] = await advance(
      current,
      branchName === undefined ? {} : { branchName },
    );
  }
  return out;
}

function stateFiles(): string[] {
  const dir = getGitHubPrStateDir(PROJECT, worktree, repo);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function storedCapturedAt(file: 'current.json' | 'previous.json'): unknown {
  const path = join(getGitHubPrStateDir(PROJECT, worktree, repo), file);
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return typeof parsed === 'object' && parsed !== null && 'capturedAt' in parsed
    ? parsed.capturedAt
    : 'no-capturedAt';
}

describe('trigger detection', () => {
  it('never fires on the first observation of a tracked branch', async () => {
    const triggers = await sequence([
      [
        'first observation of an open PR with comments, reviews and checks',
        snapshot({
          comments: [comment(1, 0)],
          reviews: [review(11, 0)],
          checks: [check(1, 'failing', 'failure')],
          labels: ['bug'],
        }),
      ],
    ]);
    expect({ triggers, files: stateFiles(), usageEvents }).toMatchSnapshot();
  });

  it('fires pr:create when a PR appears on an already tracked branch', async () => {
    const triggers = await sequence([
      ['no PR yet', null],
      ['PR opened', snapshot({ checks: [check(1, 'pending', null)] })],
      [
        'same PR, nothing new',
        snapshot({ minutes: 1, checks: [check(1, 'pending', null)] }),
      ],
      ['replaced by another PR', snapshot({ minutes: 2, prId: 202 })],
    ]);
    expect(triggers).toMatchSnapshot();
  });

  it('fires comment, review, inline review and label triggers on new activity', async () => {
    const triggers = await sequence([
      ['baseline', snapshot()],
      ['new comment', snapshot({ minutes: 1, comments: [comment(1, 1)] })],
      [
        'new review without inline comments',
        snapshot({
          minutes: 2,
          comments: [comment(1, 1)],
          reviews: [review(11, 2)],
        }),
      ],
      [
        'new review with inline comments',
        snapshot({
          minutes: 3,
          comments: [comment(1, 1)],
          reviews: [review(11, 2), review(12, 3)],
          reviewComments: [reviewComment(21, 12, 3)],
        }),
      ],
      [
        'label added',
        snapshot({
          minutes: 4,
          comments: [comment(1, 1)],
          reviews: [review(11, 2), review(12, 3)],
          reviewComments: [reviewComment(21, 12, 3)],
          labels: ['ready'],
        }),
      ],
    ]);
    expect(triggers).toMatchSnapshot();
  });

  it('fires check triggers once per finished check set', async () => {
    const triggers = await sequence([
      [
        'baseline, checks pending',
        snapshot({
          checks: [check(1, 'pending', null), check(2, 'pending', null)],
        }),
      ],
      [
        'one passes, one fails',
        snapshot({
          minutes: 1,
          checks: [
            check(1, 'passing', 'success'),
            check(2, 'failing', 'failure'),
          ],
        }),
      ],
      [
        'same results again',
        snapshot({
          minutes: 2,
          checks: [
            check(1, 'passing', 'success'),
            check(2, 'failing', 'failure'),
          ],
        }),
      ],
      [
        'new head, all pass',
        snapshot({
          minutes: 3,
          headSha: 'head-2',
          checks: [
            check(3, 'passing', 'success'),
            check(4, 'passing', 'success'),
          ],
        }),
      ],
    ]);
    expect(triggers).toMatchSnapshot();
  });

  it('fires merge-conflict, merged and closed transitions', async () => {
    const merged = await sequence([
      ['baseline, mergeable', snapshot({ conflicts: false })],
      ['conflicts appear', snapshot({ minutes: 1, conflicts: true })],
      ['merged', snapshot({ minutes: 2, conflicts: false, state: 'merged' })],
    ]);
    const mergedUsage = [...usageEvents];
    worktreeCounter += 1;
    worktree = `golden-wt-${String(worktreeCounter)}`;
    const closed = await sequence([
      ['baseline', snapshot()],
      ['closed', snapshot({ minutes: 1, state: 'closed' })],
      ['reopened as draft', snapshot({ minutes: 2, state: 'draft' })],
    ]);
    expect({ merged, mergedUsage, closed }).toMatchSnapshot();
  });
});

describe('suppression', () => {
  it('suppresses comment and review triggers across an incomplete read', async () => {
    const triggers = await sequence([
      ['complete baseline', snapshot({ comments: [comment(1, 0)] })],
      [
        'incomplete read with a new comment',
        snapshot({
          minutes: 1,
          complete: false,
          comments: [comment(1, 0), comment(2, 1)],
        }),
      ],
      [
        'complete again with the same comments and a review',
        snapshot({
          minutes: 2,
          comments: [comment(1, 0), comment(2, 1)],
          reviews: [review(11, 2)],
        }),
      ],
      [
        'complete with a genuinely new comment',
        snapshot({
          minutes: 3,
          comments: [comment(1, 0), comment(2, 1), comment(3, 3)],
          reviews: [review(11, 2)],
        }),
      ],
    ]);
    expect(triggers).toMatchSnapshot();
  });

  it('resets the baseline on a credential scope change and on a branch change', async () => {
    const triggers = await sequence([
      ['baseline under scope A', snapshot({ comments: [comment(1, 0)] })],
      [
        'scope B sees more comments and a review',
        snapshot({
          minutes: 1,
          credentialScope: 'scope-b',
          comments: [comment(1, 0), comment(2, 1)],
          reviews: [review(11, 1)],
        }),
      ],
      [
        'branch renamed',
        snapshot({
          minutes: 2,
          credentialScope: 'scope-b',
          comments: [comment(1, 0), comment(2, 1), comment(3, 2)],
        }),
        'renamed',
      ],
      [
        'new comment after the branch change',
        snapshot({
          minutes: 3,
          credentialScope: 'scope-b',
          comments: [
            comment(1, 0),
            comment(2, 1),
            comment(3, 2),
            comment(4, 3),
          ],
        }),
        'renamed',
      ],
    ]);
    expect(triggers).toMatchSnapshot();
  });
});

describe('staged advance (CAN-4145)', () => {
  const subject = (): string =>
    prAdvanceSubject({
      projectId: PROJECT,
      worktreeId: worktree,
      repoStorageKey: repo,
    });

  it('advances only after the ledger accepts, and fires again when it does not', async () => {
    await advance(snapshot());
    const accepted: unknown[] = [];
    let heads = new Map<string, string>();
    const failing: PrAdvanceCommit = {
      committedHead: (key) => Promise.resolve(heads.get(key) ?? null),
      accept: () => Promise.reject(new Error('ledger unavailable')),
    };
    const withComment = snapshot({ minutes: 1, comments: [comment(1, 1)] });
    const failed = await advance(withComment, { commit: failing }).then(
      (triggers) => ({ triggers }),
      (error: unknown) => ({
        rejected: error instanceof Error ? error.message : String(error),
      }),
    );
    const afterFailure = {
      files: stateFiles(),
      current: storedCapturedAt('current.json'),
    };
    const working: PrAdvanceCommit = {
      committedHead: (key) => Promise.resolve(heads.get(key) ?? null),
      accept: (advanceRecord) => {
        accepted.push({
          subjectMatches: advanceRecord.subject === subject(),
          triggers: advanceRecord.triggers,
          capturedAt: advanceRecord.currentSnapshot?.capturedAt ?? null,
        });
        heads = new Map([[advanceRecord.subject, advanceRecord.head]]);
        return Promise.resolve();
      },
    };
    const retried = await advance(withComment, { commit: working });
    expect({
      failed,
      afterFailure,
      retried,
      accepted,
      afterAccept: {
        files: stateFiles(),
        current: storedCapturedAt('current.json'),
        previous: storedCapturedAt('previous.json'),
      },
    }).toMatchSnapshot();
  });

  it('settles an advance on accept failure in the same call by the ledger head', async () => {
    await advance(snapshot());
    let committed: string | null = null;
    const committedThenFailed: PrAdvanceCommit = {
      committedHead: () => Promise.resolve(committed),
      accept: (record) => {
        committed = record.head;
        return Promise.reject(new Error('reply lost after the ledger commit'));
      },
    };
    const outcome = await advance(
      snapshot({ minutes: 1, comments: [comment(1, 1)] }),
      { commit: committedThenFailed },
    ).then(
      (triggers) => ({ triggers }),
      (error: unknown) => ({
        rejected: error instanceof Error ? error.message : String(error),
      }),
    );
    expect({
      outcome,
      files: stateFiles(),
      current: storedCapturedAt('current.json'),
      replay: await advance(
        snapshot({ minutes: 1, comments: [comment(1, 1)] }),
      ),
    }).toMatchSnapshot();
  });

  it('promotes or discards a staged advance left by a crash, by the committed head', async () => {
    const dir = (): string => getGitHubPrStateDir(PROJECT, worktree, repo);
    const crashCopy = join(
      tmpdir(),
      `pr-golden-crash-${String(worktreeCounter)}`,
    );
    async function crashDuringAccept(
      current: PersistedPrSnapshotFileV1,
    ): Promise<{ head: string; staged: string[] }> {
      let head = '';
      const crash: PrAdvanceCommit = {
        committedHead: () => Promise.resolve(null),
        accept: (record) => {
          head = record.head;
          rmSync(crashCopy, { recursive: true, force: true });
          cpSync(dir(), crashCopy, { recursive: true });
          return Promise.reject(new Error('process died'));
        },
      };
      await advance(current, { commit: crash }).catch(() => undefined);
      rmSync(dir(), { recursive: true, force: true });
      cpSync(crashCopy, dir(), { recursive: true });
      return { head, staged: stateFiles() };
    }

    await advance(snapshot());
    const first = await crashDuringAccept(
      snapshot({ minutes: 1, comments: [comment(1, 1)] }),
    );
    await settlePrTrackingState(
      { projectId: PROJECT, worktreeId: worktree, repoStorageKey: repo },
      () => Promise.resolve(first.head),
    );
    const promoted = {
      files: stateFiles(),
      current: storedCapturedAt('current.json'),
      previous: storedCapturedAt('previous.json'),
    };

    const second = await crashDuringAccept(
      snapshot({ minutes: 2, comments: [comment(1, 1), comment(2, 2)] }),
    );
    await settlePrTrackingState(
      { projectId: PROJECT, worktreeId: worktree, repoStorageKey: repo },
      () => Promise.resolve(first.head),
    );
    const discarded = {
      files: stateFiles(),
      current: storedCapturedAt('current.json'),
      read:
        (
          await readCurrentPrTrackingSnapshot({
            projectId: PROJECT,
            worktreeId: worktree,
            repoStorageKey: repo,
          })
        ).snapshot?.capturedAt ?? null,
      nextFires: await advance(
        snapshot({ minutes: 3, comments: [comment(1, 1), comment(2, 2)] }),
      ),
    };
    rmSync(crashCopy, { recursive: true, force: true });
    expect({
      stagedAtFirstCrash: first.staged,
      promoted,
      stagedAtSecondCrash: second.staged,
      discarded,
    }).toMatchSnapshot();
  });
});
