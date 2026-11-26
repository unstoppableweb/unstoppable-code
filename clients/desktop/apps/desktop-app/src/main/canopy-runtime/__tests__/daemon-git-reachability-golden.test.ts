// CAN-4729: daemon branch lists follow the shared background-service rule
// (CAN-5541). A selected read falls back to the in-process reader once, and
// only when the daemon was never reached and no result arrived; anything a
// reached daemon answers stays typed. The rule sits outside the route, which
// it drives here unchanged.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  CanopyCallerDescriptor,
  CanopyHostExecution,
  WorkerGitBranchListParams,
  WorkerGitBranchListResult,
  WorkerGitWorktreeHealthGetResult,
} from '@canopy/protocol/canopy-core';
import {
  createDaemonGitRoute,
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
}

function harness(
  options: {
    readonly platform?: ReadRoutePlatform;
    readonly latched?: boolean;
    readonly reachability?: DaemonGitReachability;
    readonly queryDeadlineMs?: number;
    readonly createRoute?: (inputs: DaemonGitRouteInputs) => DaemonGitRoute;
  } = {},
): Harness {
  const connection = new AbortController();
  const query = jest.fn(
    (): Promise<WorkerGitBranchListResult> => Promise.resolve(fromDaemon),
  );
  const client: DaemonGitQueryClient = { signal: connection.signal, query };
  const get = jest.fn(() => Promise.resolve({ client }));
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
          execution: (): CanopyHostExecution => ({
            childEnvironment: { GIT_TERMINAL_PROMPT: '0' },
          }),
          ...(options.queryDeadlineMs && {
            queryDeadlineMs: options.queryDeadlineMs,
          }),
          ...inputs,
        })),
    record,
  });
  routes.push(route);
  const healthDirect = jest.fn(
    (): Promise<WorkerGitWorktreeHealthGetResult> =>
      Promise.resolve(healthInProcess),
  );
  return {
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
