/** CAN-4730 E2-G: Electron main fences each split lock on the daemon it owns, bounded, in order, and resends them on every new owner lease. */
import type {
  CoreMutationFencePublishParams,
  CoreMutationFencePublishResult,
  CoreMutationFenceWrite,
} from '@canopy/protocol/canopy-core';
import { useFakeSplitLockKeys } from '../../__tests__/split-lock-key-fixture';
import {
  acquireSplitLock,
  getSplitLockedWorktrees,
  isSplitLocked,
  releaseSplitLock,
  SplitLockError,
} from '../../services/split-lock-service';
import {
  connectSplitLockFences,
  createSplitLockFencePublisher,
  installSplitLockFencePublisher,
  MUTATION_FENCE_ACK_TIMEOUT_MS,
  type FenceActivityFrame,
  type FenceOwnerClient,
  type FenceOwnerSession,
  type SplitLockFencePublisherOptions,
} from '../daemon-split-lock-fences';
import {
  resetWorkspaceTargetExclusionsForTests,
  withWorkspaceTargetArchiveDrain,
  withWorkspaceTargetAutoArchiveLease,
  WorkspaceTargetAutoArchiveExcludedError,
} from '../../lib/workspace-target-exclusion';

const mockOwnerSession = jest.fn();
let mockOwnerLifetime = new AbortController();
let mockOwnerUnavailable = false;
const mockTouch = jest.fn<Promise<void>, unknown[]>(() => Promise.resolve());
jest.mock('../../lib/workspace-activity', () => ({
  touchWorkspaceTarget: (...args: unknown[]): Promise<void> =>
    mockTouch(...args),
}));
jest.mock('../electron-daemon-owner', () => ({
  daemonOwnerLifetime: (): AbortSignal => mockOwnerLifetime.signal,
  getDaemonOwnerSession: (): unknown => mockOwnerSession(),
  isDaemonOwnerUnavailable: (): boolean => mockOwnerUnavailable,
  isDaemonPipelineOwnerPossible: (): boolean => true,
}));

type Answer = 'ack' | 'hang' | 'fail';

interface FakeOwner {
  readonly sent: CoreMutationFencePublishParams[];
  /** The schema revision each publish in `sent` asked for. */
  readonly revisions: Array<number | undefined>;
  readonly session: FenceOwnerSession;
  /**
   * How the owner answers; failNext refuses that many publishes first, and
   * busyNext refuses that many as busy. `writes` rides on each Auto Delete ack.
   * olderDaemon answers as a daemon that predates revision 2, refusing the
   * unknown `revision` param.
   */
  readonly state: {
    answer: Answer;
    failNext: number;
    busyNext: number;
    writes: CoreMutationFenceWrite[];
    olderDaemon: boolean;
  };
  /** Each activity stream opened, in order, and whether it was closed. */
  readonly streams: Array<{
    readonly onFrame: (frame: FenceActivityFrame) => void;
    closed: boolean;
  }>;
  /** Delivers a frame on the stream opened last. */
  frame(frame: FenceActivityFrame): void;
  /** Acknowledges every publish left hanging, in order. */
  ackHanging(): void;
  /** The owner lease was replaced: every registration issues again. */
  newLease(): Promise<void>;
  /** The session ends, as when its daemon stops or restarts. */
  end(): void;
}

function fakeOwner(): FakeOwner {
  const sent: CoreMutationFencePublishParams[] = [];
  const revisions: Array<number | undefined> = [];
  const state: FakeOwner['state'] = {
    answer: 'ack',
    failNext: 0,
    busyNext: 0,
    writes: [],
    olderDaemon: false,
  };
  const streams: FakeOwner['streams'] = [];
  const hanging: Array<() => void> = [];
  const registrations: Array<
    (lease: unknown, client: FenceOwnerClient) => void | Promise<void>
  > = [];
  const client: FenceOwnerClient = {
    instruction: (_name, params) => {
      const { revision, ...body } = params;
      sent.push(body);
      revisions.push(revision);
      const result: CoreMutationFencePublishResult =
        state.writes.length > 0 &&
        params.fenced.some((fenced) => fenced.hold === 'autoDelete')
          ? { acknowledged: true, epoch: params.epoch, writes: state.writes }
          : { acknowledged: true, epoch: params.epoch };
      if (state.olderDaemon && 'revision' in params)
        return Promise.reject(
          Object.assign(new Error('Unknown property: revision.'), {
            payload: { kind: 'invalid_argument' },
          }),
        );
      if (state.busyNext > 0) {
        state.busyNext -= 1;
        return Promise.reject(
          Object.assign(new Error('A file change is still running.'), {
            payload: { code: 'core.mutationFence.busy' },
          }),
        );
      }
      if (state.failNext > 0) {
        state.failNext -= 1;
        return Promise.reject(new Error('The daemon refused the publish.'));
      }
      if (state.answer === 'fail')
        return Promise.reject(new Error('The owner session dropped.'));
      if (state.answer === 'hang')
        return new Promise((resolve) => {
          hanging.push(() => resolve(result));
        });
      return Promise.resolve(result);
    },
    openStream: (_name, _params, { onFrame }) => {
      const stream = { onFrame, closed: false };
      streams.push(stream);
      return Promise.resolve({
        close: () => {
          stream.closed = true;
        },
      });
    },
  };
  const lifetime = new AbortController();
  const issueQuietly = (
    issue: (lease: unknown, client: FenceOwnerClient) => void | Promise<void>,
  ): Promise<void> => Promise.resolve(issue({}, client)).catch(() => undefined);
  return {
    sent,
    revisions,
    state,
    streams,
    frame: (frame) => streams.at(-1)?.onFrame(frame),
    ackHanging: () => {
      for (const ack of hanging.splice(0)) ack();
    },
    newLease: async () => {
      for (const issue of registrations) await issueQuietly(issue);
    },
    end: () => lifetime.abort(),
    session: {
      signal: lifetime.signal,
      client,
      lease: {
        register: (_key, issue) => {
          registrations.push(issue);
          void issueQuietly(issue);
          return () => undefined;
        },
      },
    },
  };
}

const target = (worktreeId: string): object => ({
  workspaceId: 'project-1',
  worktreeId,
  hold: 'splitLock',
});

let owner: FakeOwner;
let disconnect: () => void = () => undefined;
let releaseFailures: unknown[];

function connect(
  overrides: Partial<SplitLockFencePublisherOptions> = {},
): void {
  const publisher = createSplitLockFencePublisher({
    ownerPossible: () => true,
    ownerSession: () => Promise.resolve(owner.session),
    isOwnerUnavailable: () => false,
    locks: getSplitLockedWorktrees,
    ackTimeoutMs: 50,
    onReleaseFailed: (error) => releaseFailures.push(error),
    ...overrides,
  });
  disconnect = connectSplitLockFences(publisher);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

useFakeSplitLockKeys();
beforeEach(() => {
  owner = fakeOwner();
  releaseFailures = [];
});
afterEach(() => {
  for (const held of getSplitLockedWorktrees())
    releaseSplitLock(held.workspaceId, held.worktreeId);
  disconnect();
});

it('bounds the ack at two seconds', () => {
  expect(MUTATION_FENCE_ACK_TIMEOUT_MS).toBe(2_000);
});

it('arms one setTimeout per new lock for the ack bound and clears it once the ack arrives', async () => {
  connect({ ackTimeoutMs: MUTATION_FENCE_ACK_TIMEOUT_MS });
  const armed = jest.spyOn(global, 'setTimeout');
  const cleared = jest.spyOn(global, 'clearTimeout');
  await acquireSplitLock('project-1', 'wt-1');
  const bounds = armed.mock.calls.filter(
    ([, ms]) => ms === MUTATION_FENCE_ACK_TIMEOUT_MS,
  );
  expect(bounds).toHaveLength(1);
  const timer = armed.mock.results[armed.mock.calls.indexOf(bounds[0])]
    ?.value as unknown;
  expect(cleared).toHaveBeenCalledWith(timer);
  armed.mockRestore();
  cleared.mockRestore();
});

it('snapshots on the first owner session, fences each lock before acquire resolves and releases it, with rising epochs', async () => {
  connect();
  owner.state.answer = 'hang';
  let acquired = false;
  const acquiring = acquireSplitLock('project-1', 'wt-1').then(() => {
    acquired = true;
  });
  await settle();
  // Locked here already, but the start waits for the daemon's fence.
  expect(isSplitLocked('project-1', 'wt-1')).toBe(true);
  expect(acquired).toBe(false);
  owner.ackHanging();
  await settle();
  owner.ackHanging();
  await acquiring;
  owner.state.answer = 'ack';
  releaseSplitLock('project-1', 'wt-1');
  await settle();
  expect(owner.sent).toEqual([
    { kind: 'snapshot', epoch: 1, fenced: [target('wt-1')] },
    { kind: 'change', epoch: 2, fenced: [target('wt-1')], released: [] },
    { kind: 'change', epoch: 3, fenced: [], released: [target('wt-1')] },
  ]);
});

const UNCONFIRMED =
  "Couldn't confirm this worktree is locked, so a Split PR can't start. Try again.";

it('fails the acquire with a SplitLockError and releases the lock when the ack does not come in time, clearing the late fence', async () => {
  connect();
  await acquireSplitLock('project-1', 'other');
  owner.state.answer = 'hang';
  const late = acquireSplitLock('project-1', 'wt-1');
  await expect(late).rejects.toBeInstanceOf(SplitLockError);
  await expect(late).rejects.toHaveProperty('message', UNCONFIRMED);
  expect(isSplitLocked('project-1', 'wt-1')).toBe(false);
  // The late fence lands, then the release queued behind it.
  owner.state.answer = 'ack';
  owner.ackHanging();
  await settle();
  const last = owner.sent.slice(-2);
  expect(last).toEqual([
    {
      kind: 'change',
      epoch: last[0]?.epoch,
      fenced: [target('wt-1')],
      released: [],
    },
    {
      kind: 'change',
      epoch: (last[0]?.epoch ?? 0) + 1,
      fenced: [],
      released: [target('wt-1')],
    },
  ]);
});

it('fails the acquire when the owner session refuses the fence', async () => {
  connect();
  await settle();
  owner.state.answer = 'fail';
  const refused = acquireSplitLock('project-1', 'wt-1');
  await expect(refused).rejects.toBeInstanceOf(SplitLockError);
  await expect(refused).rejects.toHaveProperty('message', UNCONFIRMED);
  expect(getSplitLockedWorktrees()).toEqual([]);
});

it('follows a refused fence with one snapshot of the locks held, so the daemon is not left waiting', async () => {
  connect();
  await acquireSplitLock('project-1', 'wt-0');
  owner.sent.length = 0;
  owner.state.failNext = 1;
  await expect(acquireSplitLock('project-1', 'wt-1')).rejects.toBeInstanceOf(
    SplitLockError,
  );
  await settle();
  expect(owner.sent.map((params) => params.kind)).toEqual([
    'change',
    'snapshot',
    'change',
  ]);
  const snapshot = owner.sent[1];
  expect(snapshot?.fenced).toContainEqual(target('wt-0'));
  expect(owner.sent[2]).toEqual({
    kind: 'change',
    epoch: (snapshot?.epoch ?? 0) + 1,
    fenced: [],
    released: [target('wt-1')],
  });
});

it('resends a snapshot of the locks held on every new owner lease', async () => {
  connect();
  await acquireSplitLock('project-1', 'wt-1');
  await acquireSplitLock('project-1', 'wt-2');
  releaseSplitLock('project-1', 'wt-1');
  await settle();
  owner.sent.length = 0;
  await owner.newLease();
  await settle();
  expect(owner.sent).toEqual([
    { kind: 'snapshot', epoch: 5, fenced: [target('wt-2')] },
  ]);
});

it('keeps the lock released locally when the release cannot be delivered; the next lease snapshot clears it', async () => {
  connect();
  await acquireSplitLock('project-1', 'wt-1');
  owner.state.answer = 'fail';
  releaseSplitLock('project-1', 'wt-1');
  await settle();
  expect(isSplitLocked('project-1', 'wt-1')).toBe(false);
  expect(releaseFailures).toHaveLength(1);
  owner.state.answer = 'ack';
  owner.sent.length = 0;
  await owner.newLease();
  await settle();
  // e3 the undelivered release, e4 the snapshot after it (also undelivered).
  expect(owner.sent).toEqual([{ kind: 'snapshot', epoch: 5, fenced: [] }]);
});

it('publishes nothing and locks as before when this app did not spawn the daemon or is not its owner', async () => {
  for (const overrides of [
    { ownerPossible: (): boolean => false },
    {
      ownerSession: (): Promise<FenceOwnerSession> =>
        Promise.reject(new Error('not the owner')),
      isOwnerUnavailable: (): boolean => true,
    },
  ]) {
    connect(overrides);
    owner.state.answer = 'hang';
    await acquireSplitLock('project-1', 'wt-1');
    releaseSplitLock('project-1', 'wt-1');
    await settle();
    expect(owner.sent).toEqual([]);
    disconnect();
  }
});

/** Waits for `done`, failing once `boundMs` passes. */
async function within(boundMs: number, done: () => boolean): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (!done()) {
    if (Date.now() > deadline)
      throw new Error(`Not done within ${boundMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it('snapshots with no lock activity at startup, and again on the session that replaces it after a daemon restart', async () => {
  const first = fakeOwner();
  const second = fakeOwner();
  const sessions = [first.session, second.session];
  const publisher = createSplitLockFencePublisher({
    ownerPossible: () => true,
    ownerSession: () => Promise.resolve(sessions[0]),
    isOwnerUnavailable: () => false,
    locks: getSplitLockedWorktrees,
    retryInitialMs: 5,
    retryMaxMs: 20,
  });
  const stop = new AbortController();
  const running = publisher.keepObserved(stop.signal);
  try {
    await within(1_000, () => first.sent.length > 0);
    expect(first.sent).toEqual([{ kind: 'snapshot', epoch: 1, fenced: [] }]);
    // The daemon restarted: its owner session ended and a new one replaces it.
    sessions.shift();
    first.end();
    await within(1_000, () => second.sent.length > 0);
    expect(second.sent).toEqual([{ kind: 'snapshot', epoch: 2, fenced: [] }]);
  } finally {
    stop.abort();
    await running;
  }
});

it('retries with bounded backoff while no owner session can be had, then snapshots with no lock activity', async () => {
  let reachable = false;
  const publisher = createSplitLockFencePublisher({
    ownerPossible: () => true,
    ownerSession: () =>
      reachable
        ? Promise.resolve(owner.session)
        : Promise.reject(new Error('The daemon is restarting.')),
    isOwnerUnavailable: () => false,
    locks: getSplitLockedWorktrees,
    retryInitialMs: 5,
    retryMaxMs: 20,
  });
  const stop = new AbortController();
  const running = publisher.keepObserved(stop.signal);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(owner.sent).toEqual([]);
    reachable = true;
    await within(1_000, () => owner.sent.length > 0);
    expect(owner.sent).toEqual([{ kind: 'snapshot', epoch: 1, fenced: [] }]);
  } finally {
    stop.abort();
    await running;
  }
});

it('snapshots on a replacement session even when the session it replaces never ends', async () => {
  const first = fakeOwner();
  const second = fakeOwner();
  let current = first.session;
  const publisher = createSplitLockFencePublisher({
    ownerPossible: () => true,
    ownerSession: () => Promise.resolve(current),
    isOwnerUnavailable: () => false,
    locks: getSplitLockedWorktrees,
    retryInitialMs: 5,
    retryMaxMs: 20,
    recheckMs: 10,
  });
  const stop = new AbortController();
  const running = publisher.keepObserved(stop.signal);
  try {
    await within(1_000, () => first.sent.length > 0);
    // The first session's lease gave up: its session stays open, and the
    // next request gets a new one.
    current = second.session;
    await within(1_000, () => second.sent.length > 0);
    expect(second.sent).toEqual([{ kind: 'snapshot', epoch: 2, fenced: [] }]);
    expect(first.sent).toHaveLength(1);
  } finally {
    stop.abort();
    await running;
  }
});

describe('keeping the owner session observed, on fake timers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const unreachable = (calls: number[]): SplitLockFencePublisherOptions => ({
    ownerPossible: () => true,
    ownerSession: () => {
      calls.push(Date.now());
      return Promise.reject(new Error('The daemon is restarting.'));
    },
    isOwnerUnavailable: () => false,
    locks: getSplitLockedWorktrees,
  });

  it('backs off 1 s doubling to a 30 s cap on repeated failures, never closer than 1 s', async () => {
    const calls: number[] = [];
    const stop = new AbortController();
    const running = createSplitLockFencePublisher(
      unreachable(calls),
    ).keepObserved(stop.signal);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    const gaps = calls.slice(1).map((at, i) => at - (calls[i] ?? 0));
    expect(gaps.slice(0, 6)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
    ]);
    expect(gaps.slice(6).every((gap) => gap === 30_000)).toBe(true);
    // No tight loop: 6 attempts up to 31 s, then one per 30 s.
    expect(calls.length).toBeLessThanOrEqual(26);
    stop.abort();
    await running;
  });

  it('quits during the backoff with no timer left and no further owner session request', async () => {
    const calls: number[] = [];
    const stop = new AbortController();
    const running = createSplitLockFencePublisher(
      unreachable(calls),
    ).keepObserved(stop.signal);
    // Midway through the third wait.
    await jest.advanceTimersByTimeAsync(3_000 + 2_000);
    const made = calls.length;
    stop.abort();
    await running;
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(made);
  });

  it('quits while an owner session request is out with no timer left once it answers', async () => {
    let answer: (session: FenceOwnerSession) => void = () => undefined;
    let requests = 0;
    const stop = new AbortController();
    const running = createSplitLockFencePublisher({
      ownerPossible: () => true,
      ownerSession: () => {
        requests += 1;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      isOwnerUnavailable: () => false,
      locks: getSplitLockedWorktrees,
    }).keepObserved(stop.signal);
    await jest.advanceTimersByTimeAsync(0);
    stop.abort();
    answer(owner.session);
    await running;
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(requests).toBe(1);
  });

  it('leaves no timer from a session once its owner session changes', async () => {
    const first = fakeOwner();
    const second = fakeOwner();
    let current = first.session;
    const stop = new AbortController();
    const running = createSplitLockFencePublisher({
      ownerPossible: () => true,
      ownerSession: () => Promise.resolve(current),
      isOwnerUnavailable: () => false,
      locks: getSplitLockedWorktrees,
    }).keepObserved(stop.signal);
    await jest.advanceTimersByTimeAsync(0);
    expect(first.sent).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);
    current = second.session;
    first.end();
    await jest.advanceTimersByTimeAsync(0);
    expect(second.sent).toHaveLength(1);
    // Only the new session's look-again timer is pending.
    expect(jest.getTimerCount()).toBe(1);
    stop.abort();
    await running;
    expect(jest.getTimerCount()).toBe(0);
  });
});

const ARCHIVE_UNPAUSED =
  "Couldn't archive this worktree because file changes couldn't be paused. Try again.";

const held = (worktreeId: string, hold: string): object => ({
  workspaceId: 'project-1',
  worktreeId,
  hold,
});

const bodies = (): object[] =>
  owner.sent.map((params) =>
    Object.fromEntries(
      Object.entries(params).filter(([key]) => key !== 'epoch'),
    ),
  );

/** A recorded stand-in for the archive or deletion that holds the worktree. */
const recording = (ran: string[], label: string) => (): Promise<void> => {
  ran.push(label);
  return Promise.resolve();
};

describe('archive and Auto Delete holds (CAN-4730 E2 2a)', () => {
  afterEach(() => {
    resetWorkspaceTargetExclusionsForTests();
  });

  it('fences an archive before it runs, snapshotting it on the first owner session, and releases the hold after', async () => {
    connect();
    await settle();
    owner.sent.length = 0;
    owner.state.answer = 'hang';
    const ran: string[] = [];
    const archiving = withWorkspaceTargetArchiveDrain(
      'project-1',
      'wt-1',
      recording(ran, 'archive'),
    );
    await settle();
    expect(ran).toEqual([]);
    owner.state.answer = 'ack';
    owner.ackHanging();
    await archiving;
    await settle();
    expect(ran).toEqual(['archive']);
    expect(bodies()).toEqual([
      { kind: 'snapshot', fenced: [held('wt-1', 'archive')] },
      { kind: 'change', fenced: [held('wt-1', 'archive')], released: [] },
      { kind: 'change', fenced: [], released: [held('wt-1', 'archive')] },
    ]);
  });

  it('fails an archive whose hold the daemon refuses or does not confirm in time, running nothing and clearing the late fence', async () => {
    connect();
    await settle();
    owner.state.answer = 'fail';
    const ran: string[] = [];
    await expect(
      withWorkspaceTargetArchiveDrain(
        'project-1',
        'wt-1',
        recording(ran, 'refused'),
      ),
    ).rejects.toHaveProperty('message', ARCHIVE_UNPAUSED);
    owner.state.answer = 'hang';
    owner.sent.length = 0;
    await expect(
      withWorkspaceTargetArchiveDrain(
        'project-1',
        'wt-2',
        recording(ran, 'late'),
      ),
    ).rejects.toHaveProperty('message', ARCHIVE_UNPAUSED);
    expect(ran).toEqual([]);
    // The late fence lands, then the release queued behind it.
    owner.state.answer = 'ack';
    owner.ackHanging();
    await settle();
    expect(bodies().slice(-2)).toEqual([
      { kind: 'change', fenced: [held('wt-2', 'archive')], released: [] },
      { kind: 'change', fenced: [], released: [held('wt-2', 'archive')] },
    ]);
  });

  it('skips an Auto Delete whose hold the daemon refuses, releasing its lease for a later try', async () => {
    connect();
    await settle();
    owner.state.answer = 'fail';
    const ran: string[] = [];
    await expect(
      withWorkspaceTargetAutoArchiveLease(
        'project-1',
        'wt-1',
        recording(ran, 'refused'),
      ),
    ).rejects.toBeInstanceOf(WorkspaceTargetAutoArchiveExcludedError);
    expect(ran).toEqual([]);
    owner.state.answer = 'ack';
    await settle();
    owner.sent.length = 0;
    await withWorkspaceTargetAutoArchiveLease(
      'project-1',
      'wt-1',
      recording(ran, 'deleted'),
    );
    await settle();
    expect(ran).toEqual(['deleted']);
    expect(bodies()).toEqual([
      { kind: 'change', fenced: [held('wt-1', 'autoDelete')], released: [] },
      { kind: 'change', fenced: [], released: [held('wt-1', 'autoDelete')] },
    ]);
  });

  it('carries the holds in progress in each new lease snapshot, beside the split locks', async () => {
    connect();
    await acquireSplitLock('project-1', 'wt-split');
    let finish: () => void = () => undefined;
    const archiving = withWorkspaceTargetArchiveDrain(
      'project-1',
      'wt-archived',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await settle();
    owner.sent.length = 0;
    await owner.newLease();
    expect(bodies()).toEqual([
      {
        kind: 'snapshot',
        fenced: [target('wt-split'), held('wt-archived', 'archive')],
      },
    ]);
    finish();
    await archiving;
  });

  it('archives and deletes as before, publishing nothing, when this app is not the daemon owner', async () => {
    connect({ ownerPossible: () => false });
    const ran: string[] = [];
    await withWorkspaceTargetArchiveDrain(
      'project-1',
      'wt-1',
      recording(ran, 'archive'),
    );
    await withWorkspaceTargetAutoArchiveLease(
      'project-1',
      'wt-2',
      recording(ran, 'deleted'),
    );
    expect(ran).toEqual(['archive', 'deleted']);
    expect(owner.sent).toEqual([]);
  });
});

describe('daemon write activity (CAN-4730 E2 2b)', () => {
  let touched: CoreMutationFenceWrite[];
  const write = (worktreeId: string, at: number): CoreMutationFenceWrite => ({
    workspaceId: 'project-1',
    worktreeId,
    at,
  });
  /** A connected publisher already observing the owner's session. */
  /** How recording a reported write as activity goes; resolves by default. */
  let record: () => Promise<void> = () => Promise.resolve();
  const listening = (): void => {
    touched = [];
    const publisher = createSplitLockFencePublisher({
      ownerPossible: () => true,
      ownerSession: () => Promise.resolve(owner.session),
      isOwnerUnavailable: () => false,
      locks: getSplitLockedWorktrees,
      ackTimeoutMs: 50,
      onActivity: (reported) => {
        touched.push(reported);
        return record();
      },
      now: () => 5_000,
    });
    publisher.observe(owner.session);
    disconnect = connectSplitLockFences(publisher);
  };
  afterEach(() => {
    record = (): Promise<void> => Promise.resolve();
    resetWorkspaceTargetExclusionsForTests();
  });

  it("opens the activity stream on the owner's lease and counts each reported write on its worktree, never later than this app's clock", async () => {
    listening();
    await settle();
    expect(owner.streams).toHaveLength(1);
    owner.frame({ kind: 'item', item: write('wt-1', 4_000) });
    owner.frame({ kind: 'item', item: write('wt-2', 9_000_000_000_000) });
    expect(touched).toEqual([write('wt-1', 4_000), write('wt-2', 5_000)]);
    // The same lease keeps its stream; one that ended opens again.
    await owner.newLease();
    expect(owner.streams).toHaveLength(1);
    owner.frame({ kind: 'end' });
    expect(owner.streams[0].closed).toBe(true);
    await owner.newLease();
    expect(owner.streams).toHaveLength(2);
  });

  it('skips an Auto Delete whose ack names a write not counted yet, counting it, so nothing is deleted, and deletes on the next try', async () => {
    listening();
    await settle();
    owner.state.writes = [write('wt-1', 4_500)];
    owner.sent.length = 0;
    const ran: string[] = [];
    await expect(
      withWorkspaceTargetAutoArchiveLease(
        'project-1',
        'wt-1',
        recording(ran, 'deleted'),
      ),
    ).rejects.toBeInstanceOf(WorkspaceTargetAutoArchiveExcludedError);
    await settle();
    expect(ran).toEqual([]);
    expect(touched).toEqual([write('wt-1', 4_500)]);
    expect(bodies()).toEqual([
      { kind: 'change', fenced: [held('wt-1', 'autoDelete')], released: [] },
      { kind: 'change', fenced: [], released: [held('wt-1', 'autoDelete')] },
    ]);
    // Counted now: the next sweep's deletion goes ahead.
    await withWorkspaceTargetAutoArchiveLease(
      'project-1',
      'wt-1',
      recording(ran, 'deleted'),
    );
    expect(ran).toEqual(['deleted']);
    // A write already reported on the stream holds nothing back.
    owner.frame({ kind: 'item', item: write('wt-2', 4_800) });
    owner.state.writes = [write('wt-2', 4_800)];
    await withWorkspaceTargetAutoArchiveLease(
      'project-1',
      'wt-2',
      recording(ran, 'deleted wt-2'),
    );
    expect(ran).toEqual(['deleted', 'deleted wt-2']);
  });

  it("never holds Auto Delete back for good on a write time ahead of this app's clock", async () => {
    listening();
    await settle();
    const ahead = 9_000_000_000_000;
    owner.state.writes = [write('wt-1', ahead)];
    const ran: string[] = [];
    await expect(
      withWorkspaceTargetAutoArchiveLease(
        'project-1',
        'wt-1',
        recording(ran, 'deleted'),
      ),
    ).rejects.toBeInstanceOf(WorkspaceTargetAutoArchiveExcludedError);
    expect(touched).toEqual([write('wt-1', 5_000)]);
    await withWorkspaceTargetAutoArchiveLease(
      'project-1',
      'wt-1',
      recording(ran, 'deleted'),
    );
    expect(ran).toEqual(['deleted']);
  });

  it('skips an Auto Delete the daemon refuses as busy, sending no snapshot after it, and releases its lease', async () => {
    listening();
    await settle();
    owner.sent.length = 0;
    owner.state.busyNext = 1;
    const ran: string[] = [];
    await expect(
      withWorkspaceTargetAutoArchiveLease(
        'project-1',
        'wt-1',
        recording(ran, 'deleted'),
      ),
    ).rejects.toBeInstanceOf(WorkspaceTargetAutoArchiveExcludedError);
    await settle();
    expect(ran).toEqual([]);
    expect(bodies()).toEqual([
      { kind: 'change', fenced: [held('wt-1', 'autoDelete')], released: [] },
      { kind: 'change', fenced: [], released: [held('wt-1', 'autoDelete')] },
    ]);
  });

  it('publishes at schema revision 2 every time, so a daemon that predates it refuses the publish and nothing is deleted', async () => {
    listening();
    await acquireSplitLock('project-1', 'wt-split');
    releaseSplitLock('project-1', 'wt-split');
    const ran: string[] = [];
    await withWorkspaceTargetAutoArchiveLease(
      'project-1',
      'wt-1',
      recording(ran, 'deleted'),
    );
    await settle();
    expect(ran).toEqual(['deleted']);
    expect(owner.sent.length).toBeGreaterThanOrEqual(5);
    expect(owner.revisions).toEqual(owner.sent.map(() => 2));
    owner.state.olderDaemon = true;
    await expect(
      withWorkspaceTargetAutoArchiveLease(
        'project-1',
        'wt-2',
        recording(ran, 'deleted wt-2'),
      ),
    ).rejects.toBeInstanceOf(WorkspaceTargetAutoArchiveExcludedError);
    expect(ran).toEqual(['deleted']);
  });

  it("holds Auto Delete back while a reported write's activity fails to record, and deletes only once it is recorded", async () => {
    record = (): Promise<void> =>
      Promise.reject(new Error('The activity write failed.'));
    listening();
    await settle();
    owner.frame({ kind: 'item', item: write('wt-1', 4_500) });
    await settle();
    owner.state.writes = [write('wt-1', 4_500)];
    const ran: string[] = [];
    const attempt = (): Promise<void> =>
      withWorkspaceTargetAutoArchiveLease(
        'project-1',
        'wt-1',
        recording(ran, 'deleted'),
      );
    await expect(attempt()).rejects.toBeInstanceOf(
      WorkspaceTargetAutoArchiveExcludedError,
    );
    await settle();
    expect(ran).toEqual([]);
    // Recording works again: that sweep records the write and skips, the
    // next one deletes.
    record = (): Promise<void> => Promise.resolve();
    await expect(attempt()).rejects.toBeInstanceOf(
      WorkspaceTargetAutoArchiveExcludedError,
    );
    await settle();
    await attempt();
    expect(ran).toEqual(['deleted']);
  });

  it('keeps one activity stream across lease issues and looks at the session, when the session hands out a wrapper of the issued client', async () => {
    const issued = owner.session.client;
    // As the owner session does: a stable wrapper around the client a
    // lease issue receives, never the same object.
    const wrapped: FenceOwnerClient = {
      instruction: (name, params) => issued.instruction(name, params),
      openStream: (name, params, options) =>
        issued.openStream(name, params, options),
    };
    const session: FenceOwnerSession = {
      signal: owner.session.signal,
      lease: owner.session.lease,
      client: wrapped,
    };
    const publisher = createSplitLockFencePublisher({
      ownerPossible: () => true,
      ownerSession: () => Promise.resolve(session),
      isOwnerUnavailable: () => false,
      locks: getSplitLockedWorktrees,
      recheckMs: 5,
    });
    const stop = new AbortController();
    const watching = publisher.keepObserved(stop.signal);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await owner.newLease();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(owner.streams).toHaveLength(1);
      expect(owner.streams[0].closed).toBe(false);
    } finally {
      stop.abort();
      await watching;
    }
  });

  it('opens an ended activity stream again while the owner is watched, and closes it at quit, opening none after', async () => {
    const publisher = createSplitLockFencePublisher({
      ownerPossible: () => true,
      ownerSession: () => Promise.resolve(owner.session),
      isOwnerUnavailable: () => false,
      locks: getSplitLockedWorktrees,
      recheckMs: 10,
    });
    const stop = new AbortController();
    const watching = publisher.keepObserved(stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(owner.streams).toHaveLength(1);
    owner.frame({ kind: 'end' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(owner.streams).toHaveLength(2);
    stop.abort();
    await watching;
    expect(owner.streams.every((stream) => stream.closed)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(owner.streams).toHaveLength(2);
  });

  it('records each write the installed publisher hears as activity on its worktree', async () => {
    const lifetime = new AbortController();
    mockOwnerLifetime = new AbortController();
    mockOwnerUnavailable = false;
    mockOwnerSession.mockReset();
    mockOwnerSession.mockResolvedValue({
      signal: lifetime.signal,
      client: owner.session.client,
      lease: {
        register: (
          _key: string,
          issue: (lease: unknown, client: FenceOwnerClient) => unknown,
        ): (() => void) => {
          void Promise.resolve(issue({}, owner.session.client)).catch(
            () => undefined,
          );
          return (): void => undefined;
        },
      },
    });
    mockTouch.mockClear();
    const stopInstalled = installSplitLockFencePublisher();
    try {
      await settle();
      expect(owner.streams).toHaveLength(1);
      owner.frame({ kind: 'item', item: write('wt-1', 1_000) });
      expect(mockTouch).toHaveBeenCalledWith('project-1', 'wt-1', 1_000);
    } finally {
      stopInstalled();
      lifetime.abort();
    }
  });
});

describe('the installed publisher at quit (CAN-4730 E2-G)', () => {
  let stopInstalled: () => void = () => undefined;
  beforeEach(() => {
    jest.useFakeTimers();
    mockOwnerLifetime = new AbortController();
    mockOwnerUnavailable = false;
    mockOwnerSession.mockReset();
    mockOwnerSession.mockRejectedValue(new Error('No daemon yet.'));
  });
  afterEach(() => {
    stopInstalled();
    jest.useRealTimers();
  });

  // These two run first: once an owner is disposed, the refusal stays for
  // the module's life, so a stop would otherwise restore an earlier refusal.
  it('restores the previous confirmer on its own stop, refusing nothing, so a lock behaves as before', async () => {
    stopInstalled = installSplitLockFencePublisher();
    stopInstalled();
    await acquireSplitLock('project-1', 'wt-stop');
    expect(isSplitLocked('project-1', 'wt-stop')).toBe(true);
    releaseSplitLock('project-1', 'wt-stop');
  });

  it('refuses a split lock when the owner is disposed after its own stop', async () => {
    stopInstalled = installSplitLockFencePublisher();
    stopInstalled();
    mockOwnerLifetime.abort();
    const late = acquireSplitLock('project-1', 'wt-stop-then-quit');
    await expect(late).rejects.toBeInstanceOf(SplitLockError);
    await expect(late).rejects.toHaveProperty('message', UNCONFIRMED);
    expect(isSplitLocked('project-1', 'wt-stop-then-quit')).toBe(false);
  });

  it('stops watching the owner session once the owner is disposed at quit, with no timer left and no further owner session request', async () => {
    stopInstalled = installSplitLockFencePublisher();
    await jest.advanceTimersByTimeAsync(5_000);
    const made = mockOwnerSession.mock.calls.length;
    expect(made).toBeGreaterThan(0);
    // The quit chain disposes the owner, which aborts its lifetime.
    mockOwnerLifetime.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(mockOwnerSession).toHaveBeenCalledTimes(made);
  });

  it('refuses a split lock once the owner is disposed at quit, so no lock is taken without a fence', async () => {
    stopInstalled = installSplitLockFencePublisher();
    mockOwnerLifetime.abort();
    const late = acquireSplitLock('project-1', 'wt-quit');
    await expect(late).rejects.toBeInstanceOf(SplitLockError);
    await expect(late).rejects.toHaveProperty('message', UNCONFIRMED);
    expect(isSplitLocked('project-1', 'wt-quit')).toBe(false);
  });

  it('keeps refusing once the owner is disposed, however the publisher or its fences are installed again', async () => {
    // A disposed owner reads as unavailable, so a live confirmer would lock
    // with no fence.
    mockOwnerUnavailable = true;
    stopInstalled = installSplitLockFencePublisher();
    let reentrant: () => void = () => undefined;
    mockOwnerLifetime.signal.addEventListener(
      'abort',
      () => {
        reentrant = installSplitLockFencePublisher();
      },
      { once: true },
    );
    mockOwnerLifetime.abort();
    const late = installSplitLockFencePublisher();
    connectSplitLockFences({
      confirmLocked: () => Promise.resolve(),
      released: () => undefined,
      observe: () => undefined,
      keepObserved: () => Promise.resolve(),
      confirmHold: () => Promise.resolve(),
      releaseHold: () => undefined,
    });
    for (const worktreeId of ['wt-again', 'wt-after-stops']) {
      const attempt = acquireSplitLock('project-1', worktreeId);
      await expect(attempt).rejects.toBeInstanceOf(SplitLockError);
      await expect(attempt).rejects.toHaveProperty('message', UNCONFIRMED);
      expect(isSplitLocked('project-1', worktreeId)).toBe(false);
      late();
      reentrant();
    }
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refuses an archive and skips an Auto Delete once the owner is disposed at quit', async () => {
    stopInstalled = installSplitLockFencePublisher();
    mockOwnerLifetime.abort();
    const ran: string[] = [];
    await expect(
      withWorkspaceTargetArchiveDrain(
        'project-1',
        'wt-quit',
        recording(ran, 'archive'),
      ),
    ).rejects.toHaveProperty('message', ARCHIVE_UNPAUSED);
    await expect(
      withWorkspaceTargetAutoArchiveLease(
        'project-1',
        'wt-quit',
        recording(ran, 'deleted'),
      ),
    ).rejects.toBeInstanceOf(WorkspaceTargetAutoArchiveExcludedError);
    expect(ran).toEqual([]);
    resetWorkspaceTargetExclusionsForTests();
  });
});
