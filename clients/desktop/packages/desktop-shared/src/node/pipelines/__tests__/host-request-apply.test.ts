// CAN-5771: the owner applies a daemon host request with the desktop host of
// the run's start, rebuilding the executor's caller and controls and
// enforcing the deadline and timeout finalizer as the executor does in process.
import type { WorkerPipelineHostRequest } from '@canopy/protocol/canopy-core';
import { buildPipelineHostIdempotencyKey } from '@canopy/execution-engine/pipelines/host-actions';
import { hostArtifactsDir } from '@canopy/execution-engine/node/pipelines/executor/host-action-runner';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionRequest,
  PipelineHostActionResult,
  PipelineHostActions,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  applyPortableHostRequest,
  type PortableHostRunContext,
} from '../host-request-apply';
import {
  hostRequestEnvelope,
  portableHostActionRequest,
} from '@canopy/execution-engine/node/pipelines/host-request-portable';

const EXECUTIONS_DIR = '/data/pipeline-executions';

const parts = {
  executionId: 'run-1',
  jobId: 'j',
  stepId: 'make',
  attempt: 0,
  iteration: 1,
};

const caller: PipelineHostActionCaller = {
  ...parts,
  idempotencyKey: buildPipelineHostIdempotencyKey(parts),
  pipelineId: 'pipeline',
  pipelineName: 'Daemon run',
  executionContext: 'personal',
  initiationSource: 'user',
};

const run: PortableHostRunContext = {
  executionsDir: EXECUTIONS_DIR,
  pipelineId: 'pipeline',
  pipelineName: 'Daemon run',
  executionContext: 'personal',
  initiationSource: 'user',
};

const createWorktree: PipelineHostActionRequest = {
  action: 'create-worktree',
  inputs: {
    projectId: 'workspace',
    branch: { kind: 'new', name: 'b' },
    repair: false,
    setup: 'skip',
  },
};

function requestFor(
  deadlineAt: number,
  overrides: Partial<WorkerPipelineHostRequest> = {},
): WorkerPipelineHostRequest {
  const portable = portableHostActionRequest(createWorktree);
  if (portable === null) throw new Error('create-worktree is portable');
  const controls: PipelineHostActionControls = {
    deadlineAt,
    artifactsDir: hostArtifactsDir(
      EXECUTIONS_DIR,
      caller.executionId,
      caller.idempotencyKey,
    ),
    registerTimeoutFinalizer: () => undefined,
  };
  return { ...hostRequestEnvelope(portable, caller, controls), ...overrides };
}

interface Seen {
  request: PipelineHostActionRequest;
  caller: PipelineHostActionCaller;
  controls: PipelineHostActionControls | undefined;
  signal: AbortSignal;
}

function fakeHost(behave: (seen: Seen) => Promise<PipelineHostActionResult>): {
  host: PipelineHostActions;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    host: {
      run(request, hostCaller, signal, controls) {
        const call = { request, caller: hostCaller, controls, signal };
        seen.push(call);
        return behave(call);
      },
    },
  };
}

const never = (): Promise<never> => new Promise<never>(() => undefined);

afterEach(() => {
  jest.useRealTimers();
});

describe('applyPortableHostRequest (CAN-5771)', () => {
  it("rebuilds the executor's caller and controls", async () => {
    const deadlineAt = Date.now() + 60_000;
    const { host, seen } = fakeHost(() =>
      Promise.resolve({ status: 'success', outputs: {} }),
    );
    await applyPortableHostRequest({
      request: requestFor(deadlineAt),
      host,
      run,
      signal: new AbortController().signal,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request).toEqual(createWorktree);
    expect(seen[0]?.caller).toEqual(caller);
    // The envelope carries the deadline as an ISO string, to the millisecond.
    expect(seen[0]?.controls?.deadlineAt).toBe(deadlineAt);
    expect(seen[0]?.controls?.artifactsDir).toBe(
      hostArtifactsDir(
        EXECUTIONS_DIR,
        caller.executionId,
        caller.idempotencyKey,
      ),
    );
  });

  it('returns host-path outputs host-locally', async () => {
    const { host } = fakeHost(() =>
      Promise.resolve({
        status: 'success',
        outputs: { branch_name: 'b', path: '/worktrees/b' },
      }),
    );
    const answer = await applyPortableHostRequest({
      request: requestFor(Date.now() + 60_000),
      host,
      run,
      signal: new AbortController().signal,
    });
    expect(answer.result).toEqual({
      status: 'success',
      outputs: { branch_name: 'b' },
    });
    expect(answer.values).toEqual({
      pathOutputs: { path: '/worktrees/b' },
      timeout: 'none',
    });
  });

  it("a request whose id is not its step's key is no longer waiting", async () => {
    const { host, seen } = fakeHost(() =>
      Promise.resolve({ status: 'success', outputs: {} }),
    );
    const answer = await applyPortableHostRequest({
      request: requestFor(Date.now() + 60_000, { stepId: 'other' }),
      host,
      run,
      signal: new AbortController().signal,
    });
    expect(answer).toEqual({
      result: {
        status: 'failure',
        failureReason: 'not_found',
        message: 'This host request is no longer waiting.',
        outputs: {},
      },
      values: { pathOutputs: {}, timeout: 'none' },
    });
    expect(seen).toHaveLength(0);
  });

  it('at the deadline it aborts the host and answers its finalizer', async () => {
    jest.useFakeTimers();
    const deadlineAt = Date.now() + 1_000;
    const finalized: PipelineHostActionResult = {
      status: 'failure',
      failureReason: 'target_not_ready',
      error: 'The target was not ready.',
      outputs: { path: '/worktrees/b' },
    };
    const withFinalizer = fakeHost((call) => {
      call.controls?.registerTimeoutFinalizer(() => Promise.resolve(finalized));
      return never();
    });
    const pending = applyPortableHostRequest({
      request: requestFor(deadlineAt),
      host: withFinalizer.host,
      run,
      signal: new AbortController().signal,
    });
    await jest.advanceTimersByTimeAsync(1_001);
    const answer = await pending;
    expect(withFinalizer.seen[0]?.signal.aborted).toBe(true);
    expect(answer).toEqual({
      result: {
        status: 'failure',
        failureReason: 'target_not_ready',
        message: 'The target was not ready.',
        outputs: {},
      },
      values: { pathOutputs: { path: '/worktrees/b' }, timeout: 'finalized' },
    });

    const without = fakeHost(() => never());
    const plain = applyPortableHostRequest({
      request: requestFor(Date.now() + 1_000),
      host: without.host,
      run,
      signal: new AbortController().signal,
    });
    await jest.advanceTimersByTimeAsync(1_001);
    expect(without.seen[0]?.signal.aborted).toBe(true);
    expect(await plain).toEqual({
      result: {
        status: 'failure',
        failureReason: null,
        message: 'The host step timed out.',
        outputs: {},
      },
      values: { pathOutputs: {}, timeout: 'unfinalized' },
    });
  });

  it('a request past its deadline times out without calling the host', async () => {
    const { host, seen } = fakeHost(() =>
      Promise.resolve({ status: 'success', outputs: {} }),
    );
    const answer = await applyPortableHostRequest({
      request: requestFor(Date.now() - 1_000),
      host,
      run,
      signal: new AbortController().signal,
    });
    expect(seen).toHaveLength(0);
    expect(answer).toEqual({
      result: {
        status: 'failure',
        failureReason: null,
        message: 'The host step timed out.',
        outputs: {},
      },
      values: { pathOutputs: {}, timeout: 'unfinalized' },
    });
  });

  it('a withdrawal aborts the host', async () => {
    const { host, seen } = fakeHost(() => never());
    const withdrawal = new AbortController();
    const pending = applyPortableHostRequest({
      request: requestFor(Date.now() + 60_000),
      host,
      run,
      signal: withdrawal.signal,
    });
    withdrawal.abort();
    expect(await pending).toEqual({
      result: {
        status: 'failure',
        failureReason: null,
        message: 'The host request was withdrawn.',
        outputs: {},
      },
      values: { pathOutputs: {}, timeout: 'none' },
    });
    expect(seen[0]?.signal.aborted).toBe(true);
  });

  it('an unexpected host error is redacted with its message host-local', async () => {
    const boom = new Error('boom');
    const { host } = fakeHost(() => Promise.reject(boom));
    const onError = jest.fn();
    const answer = await applyPortableHostRequest({
      request: requestFor(Date.now() + 60_000),
      host,
      run,
      signal: new AbortController().signal,
      onError,
    });
    expect(answer.result).toEqual({
      status: 'failure',
      failureReason: null,
      message: 'The host step failed unexpectedly.',
      outputs: {},
    });
    expect(answer.values.errorMessage).toBe('boom');
    expect(onError).toHaveBeenCalledWith(boom);
  });
});
