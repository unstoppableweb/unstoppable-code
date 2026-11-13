/**
 * CAN-5771: Electron main settles the daemon's host requests over its owner
 * subscription, applying each with the desktop host of a run it follows.
 * The owner client is faked; the mirror, the apply core and the desktop
 * side of the boundary are real.
 */
type Frame = { kind: 'item'; cursor: string; item: unknown } | { kind: 'end' };
interface FakeOwnerClient {
  readonly signal: AbortSignal;
  readonly calls: unknown[][];
  /** Rejections for the next instructions, in order. */
  readonly failures: Error[];
  instruction(...args: unknown[]): Promise<unknown>;
  openStream(
    name: string,
    params: unknown,
    options: { onFrame: (frame: Frame) => void },
  ): Promise<{ close(): void }>;
}
let mockOnFrame: ((frame: Frame) => void) | undefined;
const mockClients: FakeOwnerClient[] = [];
function mockClient(): FakeOwnerClient {
  const calls: unknown[][] = [];
  const failures: Error[] = [];
  return {
    signal: new AbortController().signal,
    calls,
    failures,
    instruction: (...args: unknown[]): Promise<unknown> => {
      calls.push(args);
      const failure = failures.shift();
      return failure
        ? Promise.reject(failure)
        : Promise.resolve({ status: 'settled' });
    },
    openStream: (_name, _params, options): Promise<{ close(): void }> => {
      mockOnFrame = options.onFrame;
      return Promise.resolve({ close: (): void => undefined });
    },
  };
}
import type * as HostRequestApply from '@canopy/desktop-shared/node/pipelines/host-request-apply';

/** Runs after the real apply settles and before the answer is sent. */
let mockAfterApply: ((executionId: string) => void) | undefined;
jest.mock('@canopy/desktop-shared/node/pipelines/host-request-apply', () => {
  const actual: typeof HostRequestApply = jest.requireActual(
    '@canopy/desktop-shared/node/pipelines/host-request-apply',
  );
  return {
    ...actual,
    applyPortableHostRequest: async (
      options: Parameters<typeof actual.applyPortableHostRequest>[0],
    ): ReturnType<typeof actual.applyPortableHostRequest> => {
      const answer = await actual.applyPortableHostRequest(options);
      mockAfterApply?.(options.request.executionId);
      return answer;
    },
  };
});
jest.mock('../../canopy-runtime/electron-daemon-owner', () => ({
  getDaemonPipelineOwnerClient: (): Promise<unknown> => {
    const next = mockClients.length > 1 ? mockClients.shift() : mockClients[0];
    return next
      ? Promise.resolve(next)
      : Promise.reject(new Error('No owner client.'));
  },
  disposeDaemonPipelineOwner: (): Promise<void> => Promise.resolve(),
}));

import { randomUUID } from 'node:crypto';
import { CanopyClientError } from '@canopy/core-client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { WorkerPipelineHostRequest } from '@canopy/protocol/canopy-core';
import {
  createInitialState,
  normalizePipeline,
} from '@canopy/execution-engine/node/pipelines/executor';
import type {
  ExecutionRuntime,
  PipelineHostActionCaller,
  PipelineHostActionResult,
  PipelineHostActions,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  hostRequestEnvelope,
  portableHostActionRequest,
} from '@canopy/execution-engine/node/pipelines/host-request-portable';
import { buildPipelineHostIdempotencyKey } from '@canopy/execution-engine/pipelines/host-actions';
import { markUnreachable } from '../../canopy-runtime/electron-daemon-connection';
import {
  DaemonPipelineExecutionHandle,
  registerDaemonPipelineExecution,
} from '../daemon-pipeline-execution';
import {
  abortDaemonPipelineHostCalls,
  DAEMON_PIPELINE_NOT_STARTED_HERE_MESSAGE,
  ensureDaemonPipelineOwnerSettlement,
  expectDaemonPipelineHostSteps,
} from '../daemon-pipeline-owner';

const BUNDLED_ACTIONS = resolve(
  __dirname,
  '../../../../../../packages/desktop-shared/resources/actions',
);

let root: string;
let runtime: ExecutionRuntime;

interface FakeHost {
  readonly actions: PipelineHostActions;
  readonly signals: AbortSignal[];
}

function fakeHost(behave: () => Promise<PipelineHostActionResult>): FakeHost {
  const signals: AbortSignal[] = [];
  return {
    signals,
    actions: {
      run: (_request, _caller, signal): Promise<PipelineHostActionResult> => {
        signals.push(signal);
        return behave();
      },
    },
  };
}

const never = (): Promise<never> => new Promise<never>(() => undefined);

/** A host whose call, like wait-for-agent-reply, ends only when it is aborted. */
function abortEndedHost(): FakeHost {
  const signals: AbortSignal[] = [];
  return {
    signals,
    actions: {
      run: (_request, _caller, signal): Promise<PipelineHostActionResult> => {
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('The wait was aborted.')),
            { once: true },
          );
        });
      },
    },
  };
}

/** A followed owner-bound mirror of one daemon run, with `host` as its start's desktop host. */
function follow(host: FakeHost): string {
  const executionId = randomUUID();
  const state = createInitialState(
    normalizePipeline({
      name: 'Daemon run',
      on: 'dispatch',
      jobs: { j: { steps: [{ id: 'make', uses: 'builtin/create-worktree' }] } },
    }),
    { cwd: root, pipelineId: 'pipeline', runtime },
    executionId,
  );
  state.status = 'running';
  registerDaemonPipelineExecution(
    new DaemonPipelineExecutionHandle({
      executionId,
      initialState: state,
      executionsDir: runtime.executionsDir,
      openEvents: never,
      cancel: never,
      deliverEvent: (): void => undefined,
      deliverOutput: (): void => undefined,
      sweep: (): Promise<void> => Promise.resolve(),
      hostSteps: {
        context: { pipelineId: 'pipeline', executionContext: 'personal' },
        actions: host.actions,
      },
      ownerBound: true,
    }),
  );
  return executionId;
}

function requestFor(executionId: string): WorkerPipelineHostRequest {
  const portable = portableHostActionRequest({
    action: 'create-worktree',
    inputs: {
      projectId: 'workspace',
      branch: { kind: 'new', name: 'b' },
      repair: false,
      setup: 'skip',
    },
  });
  if (portable === null) throw new Error('create-worktree is portable');
  const parts = {
    executionId,
    jobId: 'j',
    stepId: 'make',
    attempt: 0,
    iteration: 1,
  };
  const caller: PipelineHostActionCaller = {
    ...parts,
    idempotencyKey: buildPipelineHostIdempotencyKey(parts),
    pipelineId: 'pipeline',
    executionContext: 'personal',
  };
  return hostRequestEnvelope(portable, caller, {
    deadlineAt: Date.now() + 60_000,
    artifactsDir: '',
    registerTimeoutFinalizer: () => undefined,
  });
}

function deliver(item: unknown): void {
  mockOnFrame?.({ kind: 'item', cursor: randomUUID(), item });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1)
    await new Promise((done) => setTimeout(done, 10));
  expect(check()).toBe(true);
}

const owner = mockClient();

beforeAll(async () => {
  mockClients.push(owner);
  await ensureDaemonPipelineOwnerSettlement();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'daemon-pipeline-owner-'));
  runtime = {
    executionsDir: join(root, 'pipeline-executions'),
    tempRootDir: join(root, 'tmp'),
    bundledActionsDir: BUNDLED_ACTIONS,
    getProjectActionsDir: (repoPath: string): string => repoPath,
    getProjectPipelinesDir: (repoPath: string): string => repoPath,
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
  };
  owner.calls.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function gated(client: FakeOwnerClient): { open(): void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const answer = client.instruction.bind(client);
  client.instruction = async (...args: unknown[]): Promise<unknown> => {
    await gate;
    return answer(...args);
  };
  return { open: release };
}

describe('daemon pipeline owner settlement (CAN-5771)', () => {
  it('settles a host request of a run this app follows, with path outputs host-locally', async () => {
    const host = fakeHost(() =>
      Promise.resolve({
        status: 'success',
        outputs: { branch_name: 'b', path: '/worktrees/b' },
      }),
    );
    const request = requestFor(follow(host));
    deliver(request);
    await waitFor(() => owner.calls.length === 1);
    expect(owner.calls[0]).toEqual([
      'worker.pipeline.hostRequest.respond',
      {
        executionId: request.executionId,
        requestId: request.requestId,
        result: { status: 'success', outputs: { branch_name: 'b' } },
      },
      {
        metadata: {},
        execution: {
          childEnvironment: {},
          pipelineHostStep: {
            pathOutputs: { path: '/worktrees/b' },
            timeout: 'none',
          },
        },
      },
    ]);
  });

  it('refuses a request for a run this app did not start or owns differently', async () => {
    const host = fakeHost(() =>
      Promise.resolve({ status: 'success', outputs: {} }),
    );
    const notStartedHere = {
      status: 'failure',
      failureReason: null,
      message: DAEMON_PIPELINE_NOT_STARTED_HERE_MESSAGE,
      outputs: {},
    };
    deliver(requestFor(randomUUID()));
    await waitFor(() => owner.calls.length === 1);
    expect(owner.calls[0]?.[1]).toMatchObject({ result: notStartedHere });
    expect(owner.calls[0]?.[2]).toEqual({ metadata: {} });

    deliver({ ...requestFor(follow(host)), owner: null });
    await waitFor(() => owner.calls.length === 2);
    expect(owner.calls[1]?.[1]).toMatchObject({ result: notStartedHere });
    expect(owner.calls[1]?.[2]).toEqual({ metadata: {} });
    expect(host.signals).toHaveLength(0);
  });

  it('a withdrawal aborts the running host call', async () => {
    const host = fakeHost(never);
    const request = requestFor(follow(host));
    deliver(request);
    await waitFor(() => host.signals.length === 1);
    deliver({
      withdrawn: true,
      executionId: request.executionId,
      requestId: request.requestId,
    });
    expect(host.signals[0]?.aborted).toBe(true);
  });

  it('a replayed request joins the running apply, and a dropped session resends the answer once', async () => {
    let finish: (result: PipelineHostActionResult) => void = () => undefined;
    const host = fakeHost(
      () =>
        new Promise<PipelineHostActionResult>((done) => {
          finish = done;
        }),
    );
    const request = requestFor(follow(host));
    deliver(request);
    deliver(request);
    await waitFor(() => host.signals.length === 1);
    // The session drops before the answer; the next owner client is new.
    const dropped = new Error('The connection closed.');
    markUnreachable(dropped, 'connection_lost');
    owner.failures.push(dropped);
    const replacement = mockClient();
    mockClients.splice(0, mockClients.length, replacement, owner);
    try {
      finish({ status: 'success', outputs: { branch_name: 'b' } });
      await waitFor(() => replacement.calls.length === 1);
      expect(owner.calls).toHaveLength(1);
      expect(replacement.calls[0]).toEqual(owner.calls[0]);
      expect(replacement.calls[0]?.[2]).toMatchObject({
        execution: {
          childEnvironment: {},
          pipelineHostStep: { timeout: 'none' },
        },
      });
      expect(host.signals).toHaveLength(1);
    } finally {
      mockClients.splice(0, mockClients.length, owner);
    }
  });

  it('an answer lost with its session is resent for the replayed request, never applied twice', async () => {
    let applies = 0;
    const host = fakeHost(() => {
      applies += 1;
      return Promise.resolve({
        status: 'success',
        outputs: { branch_name: 'b' },
      });
    });
    const request = requestFor(follow(host));
    const dropped = new Error('The connection closed.');
    markUnreachable(dropped, 'connection_lost');
    owner.failures.push(dropped);
    // The session is still down when the resend asks for a new client.
    mockClients.splice(0, mockClients.length);
    try {
      deliver(request);
      await waitFor(() => owner.calls.length === 1);
      await new Promise((done) => setTimeout(done, 20));
    } finally {
      mockClients.splice(0, mockClients.length, owner);
    }
    // The owner is back and the daemon replays the pending request.
    deliver(request);
    await waitFor(() => owner.calls.length === 2);
    expect(applies).toBe(1);
    expect(owner.calls[1]).toEqual(owner.calls[0]);
  });

  it('a refusal on the replacement client sends the redacted failure there, not a held answer', async () => {
    const host = fakeHost(() =>
      Promise.resolve({ status: 'success', outputs: { branch_name: 'b' } }),
    );
    const request = requestFor(follow(host));
    const dropped = new Error('The connection closed.');
    markUnreachable(dropped, 'connection_lost');
    owner.failures.push(dropped);
    const replacement = mockClient();
    replacement.failures.push(
      new CanopyClientError({
        kind: 'resource_exhausted',
        message: 'Busy.',
        retry: { kind: 'never' },
      }),
    );
    mockClients.splice(0, mockClients.length, replacement, owner);
    try {
      deliver(request);
      await waitFor(() => replacement.calls.length === 2);
      expect(replacement.calls[1]?.[1]).toMatchObject({
        result: {
          failureReason: null,
          message: 'The host step failed unexpectedly.',
        },
      });
    } finally {
      mockClients.splice(0, mockClients.length, owner);
    }
  });

  it('a replay during an answer that ends held resends it on the live subscription', async () => {
    let applies = 0;
    const host = fakeHost(() => {
      applies += 1;
      return Promise.resolve({
        status: 'success',
        outputs: { branch_name: 'b' },
      });
    });
    const request = requestFor(follow(host));
    const dropped = new Error('The connection closed.');
    markUnreachable(dropped, 'connection_lost');
    const gate = gated(owner);
    owner.failures.push(dropped);
    mockClients.splice(0, mockClients.length);
    try {
      deliver(request);
      await waitFor(() => applies === 1);
      await new Promise((done) => setTimeout(done, 20));
      // The daemon replays while the first answer is still in flight.
      deliver(request);
      gate.open();
      await new Promise((done) => setTimeout(done, 20));
    } finally {
      mockClients.splice(0, mockClients.length, owner);
    }
    await waitFor(() => owner.calls.length === 2);
    expect(applies).toBe(1);
    expect(owner.calls[1]).toEqual(owner.calls[0]);
  });

  it('a host request raised before its start returns is settled with that start\u2019s host', async () => {
    const host = fakeHost(() =>
      Promise.resolve({ status: 'success', outputs: { branch_name: 'b' } }),
    );
    const executionId = randomUUID();
    const release = expectDaemonPipelineHostSteps(executionId, {
      executionsDir: runtime.executionsDir,
      hostSteps: {
        context: { pipelineId: 'pipeline', executionContext: 'personal' },
        actions: host.actions,
      },
    });
    deliver(requestFor(executionId));
    await waitFor(() => owner.calls.length === 1);
    expect(owner.calls[0]?.[1]).toMatchObject({
      result: { status: 'success', outputs: { branch_name: 'b' } },
    });
    expect(host.signals).toHaveLength(1);
    // Once released, with no mirror registered, the run is not this app's.
    release();
    deliver({ ...requestFor(executionId), stepId: 'later' });
    await waitFor(() => owner.calls.length === 2);
    expect(owner.calls[1]?.[1]).toMatchObject({
      result: { message: DAEMON_PIPELINE_NOT_STARTED_HERE_MESSAGE },
    });
    expect(host.signals).toHaveLength(1);
  });

  it('an aborted host call sends the daemon no answer (CAN-6033)', async () => {
    const withdrawnHost = abortEndedHost();
    const withdrawn = requestFor(follow(withdrawnHost));
    deliver(withdrawn);
    const settledHost = abortEndedHost();
    const settledId = follow(settledHost);
    deliver(requestFor(settledId));
    await waitFor(
      () =>
        withdrawnHost.signals.length === 1 && settledHost.signals.length === 1,
    );
    deliver({
      withdrawn: true,
      executionId: withdrawn.executionId,
      requestId: withdrawn.requestId,
    });
    abortDaemonPipelineHostCalls(settledId);
    await new Promise((done) => setTimeout(done, 100));
    expect(
      owner.calls.filter(
        ([name]) => name === 'worker.pipeline.hostRequest.respond',
      ),
    ).toEqual([]);
  });

  it('a host call that succeeded before its abort still answers the daemon (CAN-6033)', async () => {
    const host = fakeHost(() =>
      Promise.resolve({ status: 'success', outputs: { branch_name: 'b' } }),
    );
    const request = requestFor(follow(host));
    mockAfterApply = abortDaemonPipelineHostCalls;
    try {
      deliver(request);
      await waitFor(() => owner.calls.length === 1);
    } finally {
      mockAfterApply = undefined;
    }
    expect(host.signals[0]?.aborted).toBe(true);
    expect(owner.calls[0]?.[0]).toBe('worker.pipeline.hostRequest.respond');
    expect(owner.calls[0]?.[1]).toMatchObject({
      requestId: request.requestId,
      result: { status: 'success' },
    });
  });

  it('a stop while the owner session is still opening leaves no subscription (CAN-6033)', async () => {
    const fresh = mockClient();
    const opened: string[] = [];
    const openStream = fresh.openStream.bind(fresh);
    fresh.openStream = (name, params, options): Promise<{ close(): void }> => {
      opened.push(name);
      return openStream(name, params, options);
    };
    const frames = mockOnFrame;
    mockClients.unshift(fresh);
    try {
      await jest.isolateModulesAsync(async () => {
        const isolated = await import('../daemon-pipeline-owner');
        const opening = isolated.ensureDaemonPipelineOwnerSettlement();
        isolated.stopDaemonPipelineOwnerSettlement();
        await opening.catch(() => undefined);
      });
    } finally {
      mockClients.splice(mockClients.indexOf(fresh), 1);
      mockOnFrame = frames;
    }
    expect(opened).toEqual([]);
  });

  it('a settled mirror aborts its execution’s host calls', async () => {
    const host = fakeHost(never);
    const executionId = follow(host);
    deliver(requestFor(executionId));
    await waitFor(() => host.signals.length === 1);
    abortDaemonPipelineHostCalls(executionId);
    expect(host.signals[0]?.aborted).toBe(true);
  });
});
