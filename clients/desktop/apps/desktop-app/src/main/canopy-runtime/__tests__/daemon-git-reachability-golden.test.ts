// CAN-4729: daemon branch lists follow the shared background-service rule
// (CAN-5541). A selected read falls back to the in-process reader once, and
// only when the daemon was never reached and no result arrived; anything a
// reached daemon answers stays typed. The rule sits outside the route, which
// it drives here unchanged.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { GitChangeSetSample } from '@canopy/core-runtime/node/git';
import type {
  CanopyCallerDescriptor,
  CanopyHostExecution,
  WorkerGitBranchListParams,
  WorkerGitBranchListResult,
  WorkerGitDiffGetResult,
  WorkerGitWorktreeHealthGetResult,
} from '@canopy/protocol/canopy-core';
import {
  createDaemonGitRoute,
  type DaemonChangeSetParams,
  type DaemonGitQueryClient,
  type DaemonGitRoute,
} from '../daemon-git-route';
import {
  createReachableDaemonGitRoute,
  type DaemonGitReachability,
  type DaemonGitRouteInputs,
} from '../daemon-git-reachability';
import { createElectronDaemonHealth } from '../electron-daemon-health';
import { createElectronDaemonCallerLifetime } from '../electron-daemon-caller-lifetime';
import { markUnreachable } from '../electron-daemon-connection';
import type { ReadRoutePlatform } from '../daemon-read-route-guard';
import { withWorkingDirectoryReadCheck } from '@canopy/desktop-shared/node/lib/working-directory';
import { FakeSender } from './daemon-files-route-harness';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};
const params: WorkerGitBranchListParams = {
  scope: { workspaceId: 'ws', worktreeId: 'wt' },
  repository: { kind: 'checkout' },
};
const branch = (
  name: string,
): WorkerGitBranchListResult['branches'][number] => ({
  name,
  isRemote: false,
  isCurrent: true,
  isUsedByWorktree: false,
  hasLocalRef: true,
  hasRemoteRef: false,
});
const fromDaemon: WorkerGitBranchListResult = {
  branches: [branch('daemon')],
  defaultBranch: null,
  defaultBranchSource: null,
};
const inProcess: WorkerGitBranchListResult = {
  branches: [branch('in-process')],
  defaultBranch: null,
  defaultBranchSource: null,
};
const healthy: WorkerGitWorktreeHealthGetResult = { healthy: true };
const healthInProcess: WorkerGitWorktreeHealthGetResult = {
  healthy: false,
  issue: {
    code: 'missing-worktree-path',
    checkedAt: '2026-01-01T00:00:00.000Z',
    repoIssues: null,
  },
};
// Connection setup's own timeout, tagged as it is in electron-daemon-connection.
const setupTimedOut = (): unknown =>
  markUnreachable(
    new CanopyOperationError({
      kind: 'deadline_exceeded',
      message: 'Desktop connection setup timed out.',
      retry: { kind: 'never' },
    }),
    'connect_timeout',
  );
const refusal = (): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.git.branch.repositoryUnavailable',
    message: 'The workspace has no source repository.',
    retry: { kind: 'never' },
  });

const dir = mkdtempSync(join(tmpdir(), 'c4729-reach-'));
const lifetime = createElectronDaemonCallerLifetime();
const routes: DaemonGitRoute[] = [];
afterAll(() => {
  routes.forEach((route) => route.dispose());
  lifetime.disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly route: DaemonGitRoute;
  readonly direct: jest.Mock<Promise<WorkerGitBranchListResult>, []>;
  readonly query: jest.Mock;
  readonly hostContext: jest.Mock;
  readonly get: jest.Mock;
  readonly noteFallback: jest.Mock;
  readonly record: jest.Mock;
  readonly connection: AbortController;
  readonly list: () => Promise<WorkerGitBranchListResult>;
  readonly healthDirect: jest.Mock<
    Promise<WorkerGitWorktreeHealthGetResult>,
    []
  >;
  readonly health: () => Promise<WorkerGitWorktreeHealthGetResult>;
  readonly changeSetDirect: jest.Mock<Promise<GitChangeSetSample | null>, []>;
  readonly changeSet: (
    params?: DaemonChangeSetParams,
    repoPath?: string,
    sender?: FakeSender,
  ) => Promise<GitChangeSetSample | null>;
  /** The daemon instance and build the next connection reports. */
  readonly attach: (identity: DaemonGitQueryClient['identity']) => void;
}

function harness(
  options: {
    readonly platform?: ReadRoutePlatform;
    readonly latched?: boolean;
    readonly reachability?: DaemonGitReachability;
    readonly queryDeadlineMs?: number;
    readonly admitted?: boolean | (() => Promise<boolean>);
    readonly createRoute?: (inputs: DaemonGitRouteInputs) => DaemonGitRoute;
  } = {},
): Harness {
  const connection = new AbortController();
  const query = jest.fn(
    (): Promise<WorkerGitBranchListResult> => Promise.resolve(fromDaemon),
  );
  let identity: DaemonGitQueryClient['identity'];
  const get = jest.fn(() =>
    Promise.resolve({
      client: {
        signal: connection.signal,
        query,
        ...(identity && { identity }),
      } satisfies DaemonGitQueryClient,
    }),
  );
  const hostContext = jest.fn(() =>
    Promise.resolve({ authorityId: 'authority' }),
  );
  const noteFallback = jest.fn(
    (reason: Parameters<DaemonGitReachability['noteFallback']>[0]): void =>
      options.reachability?.noteFallback(reason),
  );
  const record = jest.fn();
  const direct = jest.fn(
    (): Promise<WorkerGitBranchListResult> => Promise.resolve(inProcess),
  );
  const route = createReachableDaemonGitRoute({
    inputs: {
      repositoryPath: () => Promise.resolve(dir),
      hostContext,
      connections: () => ({ get }),
    },
    reachability: {
      isLatched: () =>
        options.reachability?.isLatched() ?? options.latched ?? false,
      noteFallback,
    },
    createRoute:
      options.createRoute ??
      ((inputs): DaemonGitRoute =>
        createDaemonGitRoute({
          lifetime,
          platform: options.platform ?? 'darwin',
          workspaceType: () => 'single-repo',
          resolveWorktreeTargetIds: (projectId, worktreeId) => ({
            projectId,
            worktreeId,
          }),
          workspaceManifestReadable: () => Promise.resolve(true),
          diffRepositoryPath: () => Promise.resolve(dir),
          diffScopeAdmitted: () =>
            typeof options.admitted === 'function'
              ? options.admitted()
              : Promise.resolve(options.admitted ?? true),
          execution: (): CanopyHostExecution => ({
            childEnvironment: { GIT_TERMINAL_PROMPT: '0' },
          }),
          ...(options.queryDeadlineMs && {
            queryDeadlineMs: options.queryDeadlineMs,
          }),
          ...inputs,
        })),
    record,
    appVersion: APP_VERSION,
  });
  routes.push(route);
  const healthDirect = jest.fn(
    (): Promise<WorkerGitWorktreeHealthGetResult> =>
      Promise.resolve(healthInProcess),
  );
  const changeSetDirect = jest.fn(
    (): Promise<GitChangeSetSample | null> => Promise.resolve(inProcessSample),
  );
  return {
    changeSetDirect,
    changeSet: (
      diff = diffParams,
      repoPath = dir,
      sender = new FakeSender(1),
    ) =>
      route.changeSet(diff, repoPath, { caller }, { sender }, changeSetDirect),
    attach: (next) => {
      identity = next;
    },
    healthDirect,
    health: () =>
      route.worktreeHealth(
        { scope: { workspaceId: 'ws', worktreeId: 'wt' } },
        { caller },
        { sender: new FakeSender(1) },
        healthDirect,
      ),
    route,
    direct,
    query,
    hostContext,
    get,
    noteFallback,
    record,
    connection,
    list: () =>
      route.branchList(
        params,
        { caller },
        { sender: new FakeSender(1) },
        direct,
      ),
  };
}

const APP_VERSION = '1.2.0';
const thisBuild = {
  runtimeId: 'runtime',
  daemonEpoch: 'epoch-1',
  buildVersion: APP_VERSION,
};
const olderBuild = { ...thisBuild, buildVersion: '1.1.0' };
const diffParams: DaemonChangeSetParams = {
  scope: { workspaceId: 'ws', worktreeId: 'wt' },
  repoId: '__workspace_root__',
  base: 'HEAD',
  head: 'WORKTREE',
};
const diffAnswer: WorkerGitDiffGetResult = {
  files: [],
  truncated: false,
  reads: {
    nameStatus: { ok: true, fields: ['M', 'a.txt', 'R100', 'old', 'new'] },
    numstat: { ok: true, fields: [], overCap: true },
    untracked: { ok: true, fields: ['n.txt', 'skipped.txt'] },
    unmerged: { ok: false, exitCode: 128 },
    untrackedEstimates: [
      { insertions: 2, binary: false },
      { insertions: 1, binary: true },
    ],
  },
};
const inProcessSample: GitChangeSetSample = {
  range: { kind: 'worktree', base: 'HEAD' },
  nameStatus: { ok: true, stdout: '' },
  numstat: { ok: true, stdout: '' },
  untracked: { ok: true, stdout: '' },
  unmerged: { ok: true, stdout: '' },
  untrackedEstimates: [],
};
const refusedAs = (
  kind: 'invalid_argument' | 'capability_unavailable' | 'failed_precondition',
): CanopyOperationError =>
  new CanopyOperationError({
    kind,
    message: 'Refused.',
    retry: { kind: 'never' },
  });

/** Telemetry is recorded after the current task. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('daemon branch lists under the background-service rule (CAN-4729)', () => {
  it('serves a reached daemon and never reads in process', async () => {
    const h = harness();
    await expect(h.list()).resolves.toEqual(fromDaemon);
    expect(h.direct).not.toHaveBeenCalled();
    expect(h.noteFallback).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['served']]);
  });

  it('falls back once when the host cannot be prepared', async () => {
    const h = harness();
    h.hostContext.mockRejectedValueOnce(new Error('no data root'));
    await expect(h.list()).resolves.toEqual(inProcess);
    expect(h.direct).toHaveBeenCalledTimes(1);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.noteFallback.mock.calls).toEqual([['host_unavailable']]);
    expect(h.record.mock.calls).toEqual([['host_unavailable']]);
  });

  it('falls back once when the connection cannot be set up', async () => {
    const h = harness();
    h.get.mockRejectedValueOnce(
      markUnreachable(new Error('spawn failed'), 'start_failed'),
    );
    await expect(h.list()).resolves.toEqual(inProcess);
    expect(h.direct).toHaveBeenCalledTimes(1);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.noteFallback.mock.calls).toEqual([['start_failed']]);
    expect(h.record.mock.calls).toEqual([['unreachable']]);
  });

  it('falls back once when its own connection drops before any result', async () => {
    const h = harness();
    h.query.mockImplementationOnce(() => {
      h.connection.abort();
      return Promise.reject(new Error('closed'));
    });
    await expect(h.list()).resolves.toEqual(inProcess);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.direct).toHaveBeenCalledTimes(1);
    expect(h.noteFallback.mock.calls).toEqual([['connection_lost']]);
    expect(h.record.mock.calls).toEqual([['unreachable']]);
  });

  it('falls back once when a reconnecting session cannot yet hand out its client', async () => {
    const h = harness();
    h.get.mockImplementationOnce(() =>
      Promise.resolve({
        get client(): DaemonGitQueryClient {
          throw markUnreachable(new Error('replacing'), 'connection_lost');
        },
      }),
    );
    await expect(h.list()).resolves.toEqual(inProcess);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.direct).toHaveBeenCalledTimes(1);
    expect(h.noteFallback.mock.calls).toEqual([['connection_lost']]);
    expect(h.record.mock.calls).toEqual([['unreachable']]);
  });

  it('keeps a reached daemon refusal typed, with no in-process read', async () => {
    const h = harness();
    h.query.mockRejectedValueOnce(refusal());
    await expect(h.list()).rejects.toMatchObject({
      payload: { code: 'worker.git.branch.repositoryUnavailable' },
    });
    expect(h.direct).not.toHaveBeenCalled();
    expect(h.noteFallback).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['refused']]);
  });

  it('keeps a connection drop after the result typed', async () => {
    const h = harness();
    h.query.mockImplementationOnce(async () => {
      await Promise.resolve();
      queueMicrotask(() => h.connection.abort());
      return fromDaemon;
    });
    const outcome = await h.list().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    // Either the result survives or the loss is typed; never a second read.
    if ('error' in outcome)
      expect(outcome.error).toMatchObject({ payload: { kind: 'unavailable' } });
    else expect(outcome.result).toEqual(fromDaemon);
    expect(h.direct).not.toHaveBeenCalled();
    expect(h.noteFallback).not.toHaveBeenCalled();
  });

  it('reads in process from the start while latched, with no contact or notice', async () => {
    const h = harness({ latched: true });
    await expect(h.list()).resolves.toEqual(inProcess);
    expect(h.hostContext).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.direct).toHaveBeenCalledTimes(1);
    expect(h.noteFallback).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['latched']]);
  });

  it('falls back once when connection setup times out before the request deadline', async () => {
    const h = harness();
    h.get.mockRejectedValueOnce(setupTimedOut());
    await expect(h.list()).resolves.toEqual(inProcess);
    expect(h.direct).toHaveBeenCalledTimes(1);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.noteFallback.mock.calls).toEqual([['connect_timeout']]);
    expect(h.record.mock.calls).toEqual([['unreachable']]);
  });

  it('keeps a deadline typed while the connection is still being set up', async () => {
    const h = harness({ queryDeadlineMs: 20 });
    h.get.mockImplementationOnce(() => new Promise<never>(() => undefined));
    await expect(h.list()).rejects.toMatchObject({
      payload: { kind: 'deadline_exceeded' },
    });
    expect(h.direct).not.toHaveBeenCalled();
    expect(h.noteFallback).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['refused']]);
  });

  it('leaves unselected requests alone', async () => {
    const h = harness({ platform: 'win32' });
    await expect(h.list()).resolves.toEqual(inProcess);
    expect(h.hostContext).not.toHaveBeenCalled();
    expect(h.direct).toHaveBeenCalledTimes(1);
    expect(h.noteFallback).not.toHaveBeenCalled();
    await settle();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('does not retry when the one in-process read fails', async () => {
    const h = harness();
    h.hostContext.mockRejectedValueOnce(new Error('no data root'));
    h.direct.mockRejectedValueOnce(new Error('in-process failure'));
    await expect(h.list()).rejects.toThrow('in-process failure');
    expect(h.direct).toHaveBeenCalledTimes(1);
  });

  it('counts a route that reads in process itself after trying the daemon, once', async () => {
    // As a pre-contact budget would (CAN-6803): the route asks for the host,
    // gives up before a result, and calls its in-process reader.
    let inputs: DaemonGitRouteInputs | undefined;
    const h = harness({
      createRoute: (watched): DaemonGitRoute => {
        inputs = watched;
        return {
          branchList: async (
            requested,
            _context,
            _request,
            direct,
          ): Promise<WorkerGitBranchListResult> => {
            await watched.repositoryPath(requested);
            await watched.hostContext();
            return direct();
          },
          worktreeHealth: (_requested, _context, _request, direct) => direct(),
          changeSet: (_requested, _repoPath, _context, _request, direct) =>
            direct(),
          ownerFor: (sender) => lifetime.ownerFor(sender),
          dispose: (): void => undefined,
        };
      },
    });
    expect(inputs).toBeDefined();
    await expect(h.list()).resolves.toEqual(inProcess);
    expect(h.direct).toHaveBeenCalledTimes(1);
    expect(h.noteFallback.mock.calls).toEqual([['connect_timeout']]);
    expect(h.record.mock.calls).toEqual([['unreachable']]);
  });

  it('isolates concurrent requests: only the one whose connection drops falls back', async () => {
    const h = harness();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Each request gets its own connection; the request for worktree `drop`
    // loses its own before a result, whichever reaches the daemon first.
    h.get.mockImplementation(() => {
      const connection = new AbortController();
      return Promise.resolve({
        client: {
          signal: connection.signal,
          query: async (
            _name: 'worker.git.branch.list',
            requested: WorkerGitBranchListParams,
          ): Promise<WorkerGitBranchListResult> => {
            await gate;
            if (requested.scope.worktreeId !== 'drop') return fromDaemon;
            connection.abort();
            throw new Error('closed');
          },
        },
      });
    });
    const listFor = (worktreeId: string): Promise<WorkerGitBranchListResult> =>
      h.route.branchList(
        { ...params, scope: { workspaceId: 'ws', worktreeId } },
        { caller },
        { sender: new FakeSender(1) },
        h.direct,
      );
    const dropped = listFor('drop');
    const served = listFor('keep');
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await expect(dropped).resolves.toEqual(inProcess);
    await expect(served).resolves.toEqual(fromDaemon);
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.direct).toHaveBeenCalledTimes(1);
    expect(h.noteFallback.mock.calls).toEqual([['connection_lost']]);
    expect(h.record).toHaveBeenCalledTimes(2);
    expect(h.record).toHaveBeenCalledWith('served');
    expect(h.record).toHaveBeenCalledWith('unreachable');
  });

  it('carries no latch to the next request unless the health record latched', async () => {
    const health = createElectronDaemonHealth({
      warn: jest.fn(),
      info: jest.fn(),
    });
    health.setConsumerEnabled('git_reads', true);
    const h = harness({
      reachability: {
        isLatched: () => health.isLatched(),
        noteFallback: (reason) => health.noteFallback('git_reads', reason),
      },
    });
    // A dropped connection falls back without latching: the next read is served.
    h.query.mockImplementationOnce(() => {
      h.connection.abort();
      return Promise.reject(new Error('closed'));
    });
    await expect(h.list()).resolves.toEqual(inProcess);
    expect(health.isLatched()).toBe(false);
    const next = harness({
      reachability: {
        isLatched: () => health.isLatched(),
        noteFallback: (reason) => health.noteFallback('git_reads', reason),
      },
    });
    await expect(next.list()).resolves.toEqual(fromDaemon);
    expect(next.direct).not.toHaveBeenCalled();
    // An unprepared host latches: the following read skips the daemon.
    next.hostContext.mockRejectedValueOnce(new Error('no data root'));
    await expect(next.list()).resolves.toEqual(inProcess);
    expect(health.isLatched()).toBe(true);
    next.hostContext.mockClear();
    await expect(next.list()).resolves.toEqual(inProcess);
    expect(next.hostContext).not.toHaveBeenCalled();
    expect(next.record.mock.calls.map(([reason]: [string]) => reason)).toEqual([
      'served',
      'host_unavailable',
      'latched',
    ]);
  });
});

describe('daemon worktree health under the background-service rule (CAN-4729)', () => {
  it('serves a reached daemon and never checks in process', async () => {
    const h = harness();
    h.query.mockResolvedValueOnce(healthy);
    await expect(h.health()).resolves.toEqual(healthy);
    expect((h.query.mock.calls[0] as unknown[]).slice(0, 2)).toEqual([
      'worker.git.worktree.health.get',
      {
        scope: {
          workspaceId: 'ws',
          worktreeId: 'wt',
          authorityId: 'authority',
        },
      },
    ]);
    expect(h.healthDirect).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['served']]);
  });

  it('falls back once when the host cannot be prepared', async () => {
    const h = harness();
    h.hostContext.mockRejectedValueOnce(new Error('no data root'));
    await expect(h.health()).resolves.toEqual(healthInProcess);
    expect(h.healthDirect).toHaveBeenCalledTimes(1);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.noteFallback.mock.calls).toEqual([['host_unavailable']]);
  });

  it('keeps a reached daemon refusal typed, with no in-process check', async () => {
    const h = harness();
    h.query.mockRejectedValueOnce(
      new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'worker.git.worktree.scopeUnsupported',
        message: 'Unsupported.',
        retry: { kind: 'never' },
      }),
    );
    await expect(h.health()).rejects.toMatchObject({
      payload: { code: 'worker.git.worktree.scopeUnsupported' },
    });
    expect(h.healthDirect).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['refused']]);
  });

  it('falls back once when connection setup times out before the request deadline', async () => {
    const h = harness();
    h.get.mockRejectedValueOnce(setupTimedOut());
    await expect(h.health()).resolves.toEqual(healthInProcess);
    expect(h.healthDirect).toHaveBeenCalledTimes(1);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.noteFallback.mock.calls).toEqual([['connect_timeout']]);
    expect(h.record.mock.calls).toEqual([['unreachable']]);
  });

  it('keeps a deadline typed while the connection is still being set up', async () => {
    const h = harness({ queryDeadlineMs: 20 });
    h.get.mockImplementationOnce(() => new Promise<never>(() => undefined));
    await expect(h.health()).rejects.toMatchObject({
      payload: { kind: 'deadline_exceeded' },
    });
    expect(h.healthDirect).not.toHaveBeenCalled();
    expect(h.noteFallback).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['refused']]);
  });

  it('checks in process from the start while latched, with no contact', async () => {
    const h = harness({ latched: true });
    await expect(h.health()).resolves.toEqual(healthInProcess);
    expect(h.hostContext).not.toHaveBeenCalled();
    expect(h.healthDirect).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls).toEqual([['latched']]);
  });

  it('leaves Windows on the in-process check, never refused', async () => {
    const h = harness({ platform: 'win32' });
    await expect(h.health()).resolves.toEqual(healthInProcess);
    expect(h.hostContext).not.toHaveBeenCalled();
    expect(h.healthDirect).toHaveBeenCalledTimes(1);
    await settle();
    expect(h.record).not.toHaveBeenCalled();
  });
});

// CAN-4729: `activity:changed-files` reads revision 3 from the daemon. Only an
// older daemon build refusing the revision reads in process, and that daemon
// instance stays in process until it restarts; nothing else changes the rule.
describe('daemon changed files under the background-service rule (CAN-4729)', () => {
  it("serves revision 3's reads as the sample the legacy lists are built from", async () => {
    const h = harness();
    h.attach(thisBuild);
    h.query.mockResolvedValueOnce(diffAnswer);
    const sample = await h.changeSet();
    expect((h.query.mock.calls[0] as unknown[]).slice(0, 2)).toEqual([
      'worker.git.diff.get',
      {
        scope: {
          workspaceId: 'ws',
          worktreeId: 'wt',
          authorityId: 'authority',
        },
        repoId: '__workspace_root__',
        base: 'HEAD',
        head: 'WORKTREE',
        revision: 3,
      },
    ]);
    expect(sample).toEqual({
      range: { kind: 'worktree', base: 'HEAD' },
      nameStatus: { ok: true, stdout: 'M\0a.txt\0R100\0old\0new\0' },
      // Over its bound, as legacy blanks an over-long list.
      numstat: { ok: false, error: diffAnswer.reads?.numstat },
      untracked: { ok: true, stdout: 'n.txt\0skipped.txt\0' },
      unmerged: { ok: false, error: { ok: false, exitCode: 128 } },
      untrackedEstimates: [
        { insertions: 2, binary: false },
        { insertions: 1, binary: true },
      ],
    });
    expect(h.changeSetDirect).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['served']]);
  });

  it('reads a commit range with no untracked or unmerged reads', async () => {
    const h = harness();
    h.query.mockResolvedValueOnce({
      ...diffAnswer,
      reads: { ...diffAnswer.reads, untracked: null, unmerged: null },
    });
    const sample = await h.changeSet({
      ...diffParams,
      base: 'abc',
      head: 'HEAD',
    });
    expect(sample).toMatchObject({
      range: { kind: 'objects', base: 'abc', head: 'HEAD' },
      untracked: null,
      unmerged: null,
    });
  });

  it.each(['invalid_argument', 'capability_unavailable'] as const)(
    'reads in process once an older daemon build refuses the revision as %s, and stops asking that daemon',
    async (kind) => {
      const h = harness();
      h.attach(olderBuild);
      h.query.mockRejectedValueOnce(refusedAs(kind));
      await expect(h.changeSet()).resolves.toBe(inProcessSample);
      await expect(h.changeSet()).resolves.toBe(inProcessSample);
      expect(h.query).toHaveBeenCalledTimes(1);
      expect(h.changeSetDirect).toHaveBeenCalledTimes(2);
      // Not a background-service outage: no notice.
      expect(h.noteFallback).not.toHaveBeenCalled();
      expect(h.record.mock.calls).toEqual([['version_skew'], ['version_skew']]);
      // Branch lists still go to that daemon.
      await expect(h.list()).resolves.toEqual(fromDaemon);
      expect(h.query).toHaveBeenCalledTimes(2);
    },
  );

  it('asks a restarted daemon again', async () => {
    const h = harness();
    h.attach(olderBuild);
    h.query.mockRejectedValueOnce(refusedAs('invalid_argument'));
    await h.changeSet();
    h.attach({ ...thisBuild, daemonEpoch: 'epoch-2' });
    h.query.mockResolvedValueOnce(diffAnswer);
    await expect(h.changeSet()).resolves.toMatchObject({
      untracked: { ok: true, stdout: 'n.txt\0skipped.txt\0' },
    });
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.changeSetDirect).toHaveBeenCalledTimes(1);
    expect(h.record.mock.calls).toEqual([['version_skew'], ['served']]);
  });

  it('keeps the same build refusing the revision typed, with no latch', async () => {
    const h = harness();
    h.attach(thisBuild);
    h.query.mockRejectedValueOnce(refusedAs('invalid_argument'));
    await expect(h.changeSet()).rejects.toMatchObject({
      payload: { kind: 'invalid_argument' },
    });
    h.query.mockResolvedValueOnce(diffAnswer);
    await expect(h.changeSet()).resolves.not.toBeNull();
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.changeSetDirect).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['refused'], ['served']]);
  });

  it('re-estimates a confined skip in main, as in process, over the estimated files', async () => {
    const h = harness();
    writeFileSync(join(dir, 'n.txt'), 'a\nb\nc\n');
    writeFileSync(join(dir, 'skipped.txt'), 'a\nb\n');
    h.query.mockResolvedValueOnce({
      ...diffAnswer,
      reads: {
        ...diffAnswer.reads,
        untrackedEstimates: [
          { insertions: 0, binary: false },
          { insertions: 0, binary: false, confined: true },
        ],
      },
    });
    await expect(h.changeSet()).resolves.toMatchObject({
      untrackedEstimates: [
        { insertions: 3, binary: false },
        { insertions: 2, binary: false },
      ],
    });
    expect(h.record.mock.calls).toEqual([['served']]);
  });

  it('lists in process once for an object the daemon will not fetch, with no latch', async () => {
    const h = harness();
    h.attach(thisBuild);
    h.query.mockRejectedValueOnce(
      new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'worker.git.diff.objectMissing',
        message: 'A read needs an object this repository does not have.',
        retry: { kind: 'never' },
      }),
    );
    await expect(h.changeSet()).resolves.toBe(inProcessSample);
    h.query.mockResolvedValueOnce(diffAnswer);
    await expect(h.changeSet()).resolves.not.toBe(inProcessSample);
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.changeSetDirect).toHaveBeenCalledTimes(1);
    expect(h.noteFallback).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['object_missing'], ['served']]);
  });

  // The daemon's Git host ends a request at 30 s and sends the read with no
  // exit code; main's own read has no deadline, so it lists in process once.
  it('lists in process once when a daemon read ended with no exit code, with no latch', async () => {
    const h = harness();
    h.attach(thisBuild);
    h.query.mockResolvedValueOnce({
      ...diffAnswer,
      reads: {
        ...diffAnswer.reads,
        nameStatus: { ok: false, exitCode: null },
        untracked: { ok: true, fields: [] },
        untrackedEstimates: [],
      },
    });
    await expect(h.changeSet()).resolves.toBe(inProcessSample);
    h.query.mockResolvedValueOnce(diffAnswer);
    await expect(h.changeSet()).resolves.not.toBe(inProcessSample);
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.changeSetDirect).toHaveBeenCalledTimes(1);
    expect(h.noteFallback).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['read_timed_out'], ['served']]);
  });

  it("keeps an older build's other refusals typed", async () => {
    const h = harness();
    h.attach(olderBuild);
    h.query.mockRejectedValueOnce(
      new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'worker.git.diff.scopeUnsupported',
        message: 'Unsupported.',
        retry: { kind: 'never' },
      }),
    );
    await expect(h.changeSet()).rejects.toMatchObject({
      payload: { code: 'worker.git.diff.scopeUnsupported' },
    });
    expect(h.changeSetDirect).not.toHaveBeenCalled();
    expect(h.record.mock.calls).toEqual([['refused']]);
  });

  it('reads in process, with no contact, when the daemon would not resolve the worktree to this checkout', async () => {
    const h = harness({ admitted: false });
    await expect(h.changeSet()).resolves.toBe(inProcessSample);
    expect(h.hostContext).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    await settle();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('reads in process, with no contact, when main resolves the scope to another checkout', async () => {
    const h = harness();
    await expect(h.changeSet(diffParams, join(dir, 'other'))).resolves.toBe(
      inProcessSample,
    );
    expect(h.hostContext).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    await settle();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('falls back once when the host cannot be prepared, and reads in process while latched', async () => {
    const h = harness();
    h.hostContext.mockRejectedValueOnce(new Error('no data root'));
    await expect(h.changeSet()).resolves.toBe(inProcessSample);
    expect(h.noteFallback.mock.calls).toEqual([['host_unavailable']]);
    const latched = harness({ latched: true });
    await expect(latched.changeSet()).resolves.toBe(inProcessSample);
    expect(latched.hostContext).not.toHaveBeenCalled();
    expect(latched.record.mock.calls).toEqual([['latched']]);
  });

  it('fails every read, with no query, once the folder is being retired', async () => {
    const h = harness();
    const sample = await withWorkingDirectoryReadCheck(
      () => false,
      () => h.changeSet(),
    );
    const failed = sample?.nameStatus;
    expect(failed).toMatchObject({ ok: false });
    expect(String(failed && !failed.ok && failed.error)).toContain(
      'is being archived or deleted',
    );
    expect(sample).toEqual({
      range: { kind: 'worktree', base: 'HEAD' },
      nameStatus: failed,
      numstat: failed,
      untracked: failed,
      unmerged: failed,
      untrackedEstimates: [],
    });
    expect(h.query).not.toHaveBeenCalled();
    expect(h.changeSetDirect).not.toHaveBeenCalled();
  });

  // Admission stays pending until each case has asserted, so these prove the
  // request settles without it rather than only that nothing is sent after.
  const heldAdmission = (): {
    readonly admitting: () => Promise<boolean>;
    readonly admit: () => void;
  } => {
    let release: () => void = () => undefined;
    const gate = new Promise<boolean>((resolve) => {
      release = (): void => resolve(true);
    });
    return { admitting: () => gate, admit: () => release() };
  };

  it('cancels while admission is still pending when the document navigates', async () => {
    const held = heldAdmission();
    const h = harness({ admitted: held.admitting });
    const sender = new FakeSender(1);
    const pending = h.changeSet(diffParams, dir, sender);
    await settle();
    sender.emit('did-navigate');
    await expect(pending).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    held.admit();
    await settle();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.changeSetDirect).not.toHaveBeenCalled();
  });

  it('reports the deadline while admission is still pending', async () => {
    const held = heldAdmission();
    const h = harness({ admitted: held.admitting, queryDeadlineMs: 50 });
    await expect(h.changeSet()).rejects.toMatchObject({
      payload: { kind: 'deadline_exceeded' },
    });
    held.admit();
    await settle();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.changeSetDirect).not.toHaveBeenCalled();
  });

  // After a refusal the in-process read is bounded by navigation, not the
  // deadline, as the unrouted read is.
  it('cancels the in-process read after a refusal when the document navigates', async () => {
    const h = harness();
    h.attach(thisBuild);
    h.query.mockRejectedValueOnce(
      new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'worker.git.diff.objectMissing',
        message: 'A read needs an object this repository does not have.',
        retry: { kind: 'never' },
      }),
    );
    let release: () => void = () => undefined;
    let reading: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    h.changeSetDirect.mockImplementationOnce(() => {
      reading();
      return new Promise((resolve) => {
        release = (): void => resolve(inProcessSample);
      });
    });
    const sender = new FakeSender(1);
    const pending = h.changeSet(diffParams, dir, sender);
    await started;
    sender.emit('did-navigate');
    await expect(pending).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    release();
    expect(h.record.mock.calls).toEqual([['object_missing']]);
  });

  it('leaves Windows on the in-process read', async () => {
    const h = harness({ platform: 'win32' });
    await expect(h.changeSet()).resolves.toBe(inProcessSample);
    expect(h.hostContext).not.toHaveBeenCalled();
    await settle();
    expect(h.record).not.toHaveBeenCalled();
  });
});
