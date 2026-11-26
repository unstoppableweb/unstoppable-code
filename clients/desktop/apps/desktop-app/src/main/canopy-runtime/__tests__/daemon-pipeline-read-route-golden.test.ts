/**
 * CAN-7874 golden: Electron main's `worker.pipeline.execution.get` reads a
 * run on the daemon on macOS and Linux, through the real worker.pipeline
 * adapter and route, over a daemon session double. A run the daemon doesn't
 * know, an unreachable daemon or a dropped session reads in process, so a run
 * main started never goes missing; any other refusal is the answer.
 */
import type * as CorePlatform from '@canopy/core-platform';

const mockGet = jest.fn<Promise<{ client: unknown }>, [unknown, unknown]>();
jest.mock('../electron-daemon-access', () => ({
  getElectronDaemonConnections: (): unknown => ({
    get: (caller: unknown, signal: unknown) => mockGet(caller, signal),
  }),
  getElectronDaemonFilesContext: (): Promise<unknown> =>
    Promise.resolve({ authorityId: 'local', canonicalDataRoot: '/data' }),
}));
const mockNoteFallback = jest.fn();
let mockLatched = false;
jest.mock('../electron-daemon-health', () => ({
  getElectronDaemonHealth: (): unknown => ({
    setConsumerEnabled: (): void => undefined,
    isLatched: (): boolean => mockLatched,
    noteFallback: (...args: unknown[]): void => {
      mockNoteFallback(...args);
    },
  }),
}));
let mockPlatform = 'darwin';
jest.mock('@canopy/core-platform', () => ({
  ...jest.requireActual<typeof CorePlatform>('@canopy/core-platform'),
  hostPlatformOperatingSystem: (): string => mockPlatform,
}));
jest.mock('../../execution-secrets/owner', () => ({
  getDesktopExecutionSecrets: (): unknown =>
    jest.requireActual<{ refusingExecutionSecretSource: unknown }>(
      '@canopy/core-runtime/node/execution-secrets',
    ).refusingExecutionSecretSource,
}));

import { CanopyClientError } from '@canopy/core-client';
import {
  CanopyOperationError,
  canopyPermissionDeniedError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import {
  pipelineExecutionNotFoundError,
  type PipelineExecutionWorker,
} from '@canopy/core-runtime/node/pipeline';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import type {
  WorkerPipelineExecution,
  WorkerPipelineExecutionView,
} from '@canopy/protocol/canopy-core';
import { markUnreachable } from '../electron-daemon-connection';
import { createWorkerPipelineAdapter } from '../worker-pipeline-adapter';

const RUN: WorkerPipelineExecution = {
  executionId: 'run-desktop',
  pipelineId: 'pipeline',
  name: 'Desktop run',
  status: 'success',
  runScope: 'worktree',
  definitionSource: 'project',
  owner: null,
  workspaceId: 'project',
  worktreeId: 'task',
  parentExecutionId: null,
  startedAt: '2026-11-25T00:00:00.000Z',
  completedAt: '2026-11-25T00:01:00.000Z',
  pendingPauseCount: 0,
  error: null,
};
const DAEMON_RUN: WorkerPipelineExecution = {
  ...RUN,
  executionId: 'run-daemon',
  name: 'Daemon run',
};

/** In-process reads the worker answered, by execution id. */
const inProcessReads: string[] = [];

function unused(): Promise<never> {
  return Promise.reject(new Error('Not used by a read.'));
}

/** A worker that holds only the desktop's run. */
const worker: PipelineExecutionWorker = {
  start: unused,
  control: unused,
  sweep: unused,
  checkpoint: unused,
  list: unused,
  cancel: unused,
  observe: (): null => null,
  get: (executionId: string): Promise<WorkerPipelineExecution | null> => {
    inProcessReads.push(executionId);
    return Promise.resolve(executionId === RUN.executionId ? RUN : null);
  },
  inspect: (
    executionId: string,
  ): Promise<WorkerPipelineExecutionView | null> => {
    inProcessReads.push(executionId);
    return Promise.resolve(
      executionId === RUN.executionId ? { execution: RUN } : null,
    );
  },
};

/** The daemon session double: each query it got, and how it answers. */
const daemonQueries: Array<{ name: string; params: unknown }> = [];
let daemonAnswer: (params: { executionId: string }) => Promise<unknown>;
const session = {
  signal: new AbortController().signal,
  query: (name: string, params: { executionId: string }): Promise<unknown> => {
    daemonQueries.push({ name, params });
    return daemonAnswer(params);
  },
};

function context(): CanopyHandlerContext {
  return {
    requestId: 'read',
    caller: {
      principalId: 'local-desktop-user',
      clientInstanceId: 'renderer',
      authorityId: 'local',
      interfaceKind: 'desktop',
      grants: ['worker.pipeline.read'],
    },
    metadata: {},
    signal: new AbortController().signal,
  };
}

const adapter = createWorkerPipelineAdapter(() => Promise.resolve(worker));
function get(
  executionId: string,
  detail?: true,
): Promise<WorkerPipelineExecutionView> {
  return Promise.resolve(
    adapter.queries['worker.pipeline.execution.get'](
      { executionId, ...(detail && { detail }) },
      context(),
    ),
  );
}
function routes(): Record<string, number> {
  return Object.fromEntries(
    Object.entries(snapshotWorkCounters().route).filter(([key]) =>
      key.startsWith('pipelines.'),
    ),
  );
}

beforeEach(() => {
  resetWorkCounters();
  inProcessReads.length = 0;
  daemonQueries.length = 0;
  mockNoteFallback.mockReset();
  mockLatched = false;
  mockPlatform = 'darwin';
  mockGet.mockReset();
  mockGet.mockResolvedValue({ client: session });
  daemonAnswer = (params): Promise<unknown> =>
    params.executionId === DAEMON_RUN.executionId
      ? Promise.resolve({ execution: DAEMON_RUN })
      : Promise.reject(
          new CanopyClientError(pipelineExecutionNotFoundError().payload),
        );
});

describe('desktop pipeline execution reads on the daemon (CAN-7874)', () => {
  it.each(['darwin', 'linux'])(
    'reads a run on the daemon session, not in process (%s)',
    async (platform) => {
      mockPlatform = platform;
      await expect(get(DAEMON_RUN.executionId)).resolves.toEqual({
        execution: DAEMON_RUN,
      });
      expect(daemonQueries).toEqual([
        {
          name: 'worker.pipeline.execution.get',
          params: { executionId: DAEMON_RUN.executionId },
        },
      ]);
      expect(inProcessReads).toEqual([]);
      expect(routes()).toEqual({ 'pipelines.get.daemon.served': 1 });
    },
  );

  it('reads in process while the daemon is latched unreachable, asking it nothing', async () => {
    mockLatched = true;
    await expect(get(RUN.executionId)).resolves.toEqual({ execution: RUN });
    expect(mockGet).not.toHaveBeenCalled();
    expect(routes()).toEqual({ 'pipelines.get.direct': 1 });
  });

  it('reads in process when the daemon is unreachable', async () => {
    mockGet.mockRejectedValue(
      markUnreachable(new Error('down'), 'connection_lost'),
    );
    await expect(get(RUN.executionId)).resolves.toEqual({ execution: RUN });
    expect(mockNoteFallback).toHaveBeenCalledWith(
      'pipelines',
      'connection_lost',
    );
    expect(routes()).toEqual({ 'pipelines.get.daemon.fallback': 1 });
  });

  it('reads in process when the session closes under the read', async () => {
    const dropped = new AbortController();
    mockGet.mockResolvedValue({
      client: {
        signal: dropped.signal,
        query: (): Promise<unknown> => {
          dropped.abort();
          return Promise.reject(new Error('closed'));
        },
      },
    });
    await expect(get(RUN.executionId)).resolves.toEqual({ execution: RUN });
    expect(mockNoteFallback).toHaveBeenCalledWith(
      'pipelines',
      'connection_lost',
    );
    expect(routes()).toEqual({ 'pipelines.get.daemon.fallback': 1 });
  });

  it('reads a run the daemon does not know in process, so a desktop run never goes missing', async () => {
    await expect(get(RUN.executionId)).resolves.toEqual({ execution: RUN });
    expect(daemonQueries).toHaveLength(1);
    expect(inProcessReads).toEqual([RUN.executionId]);
    expect(routes()).toEqual({ 'pipelines.get.daemon.fallback': 1 });
  });

  it('reads in process on Windows, asking the daemon nothing', async () => {
    mockPlatform = 'win32';
    await expect(get(RUN.executionId)).resolves.toEqual({ execution: RUN });
    expect(mockGet).not.toHaveBeenCalled();
    expect(routes()).toEqual({ 'pipelines.get.direct': 1 });
  });

  it('routes a detail read the same way', async () => {
    await expect(get(DAEMON_RUN.executionId, true)).resolves.toEqual({
      execution: DAEMON_RUN,
    });
    expect(daemonQueries).toEqual([
      {
        name: 'worker.pipeline.execution.get',
        params: { executionId: DAEMON_RUN.executionId, detail: true },
      },
    ]);
    expect(routes()).toEqual({ 'pipelines.get.daemon.served': 1 });
  });

  it('answers any other reached refusal as the daemon gave it, reading nothing in process', async () => {
    daemonAnswer = (): Promise<unknown> =>
      Promise.reject(
        new CanopyClientError(
          canopyPermissionDeniedError('Not allowed.').payload,
        ),
      );
    const refused = get(DAEMON_RUN.executionId);
    await expect(refused).rejects.toBeInstanceOf(CanopyOperationError);
    await expect(refused).rejects.toMatchObject({
      payload: { kind: 'permission_denied' },
    });
    expect(inProcessReads).toEqual([]);
    expect(routes()).toEqual({ 'pipelines.get.daemon.refused': 1 });
  });
});
