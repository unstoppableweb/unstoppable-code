import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  forceStopOrphanedScriptRunGroup,
  ScriptActionError,
  stopOrphanedScriptRun,
} from '../script-run-actions-client';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  reportClientAppError: jest.fn(),
}));

const TARGET = {
  projectId: 'project',
  worktreeId: 'task',
  scriptKey: 'project:dev',
  executionId: 'run-1',
};

const OUTCOME_UNKNOWN = {
  kind: 'failed_precondition',
  code: 'worker.script.outcomeUnknown',
  message: 'The run may have stopped.',
  retry: { kind: 'never' },
};

interface CoreRequest {
  readonly kind: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function execution(
  status: string,
  executionId = TARGET.executionId,
): Record<string, unknown> {
  return {
    executionId,
    script: {
      scriptKey: TARGET.scriptKey,
      scriptName: 'dev',
      label: 'Dev',
      command: 'npm run dev',
      lifecycle: 'custom',
      target: 'project',
    },
    invocation: 'manual-run',
    status,
    startedAt: '2026-11-26T09:00:00.000Z',
    completedAt: status === 'running' ? null : '2026-11-26T09:05:00.000Z',
    exitCode: null,
    timedOut: false,
    durationMs: 0,
  };
}

// The relay answers the Stop with outcomeUnknown and the run's read with `read`.
function relay(read: unknown): jest.Mock<Promise<unknown>, [CoreRequest]> {
  const invoke = jest.fn((request: CoreRequest) =>
    Promise.resolve(
      request.method === 'worker.script.execution.stop'
        ? { ok: false, error: OUTCOME_UNKNOWN }
        : read,
    ),
  );
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { canopyCore: { invoke } },
  });
  return invoke;
}

function methods(invoke: jest.Mock<Promise<unknown>, [CoreRequest]>): string[] {
  return invoke.mock.calls.map(([request]) => request.method);
}

const forceStop = (ended: () => void): Promise<unknown> =>
  forceStopOrphanedScriptRunGroup(
    TARGET,
    [{ pid: 4243, startIdentity: 'member', startedAt: 0, command: 'node' }],
    ended,
  );
const stop = (ended: () => void): Promise<unknown> =>
  stopOrphanedScriptRun(TARGET, { mode: 'stop', confirmed: false }, ended);

describe('a Stop whose outcome is unknown reads the run again (CAN-7586)', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    jest.mocked(reportClientAppError).mockClear();
  });

  it.each([
    ['Stop', stop],
    ['group Force stop', forceStop],
  ])(
    'settles the run when a %s ends with outcomeUnknown and the run has stopped',
    async (_name, run) => {
      const invoke = relay({
        ok: true,
        value: { run: { execution: execution('lost'), lines: [] } },
      });
      const ended = jest.fn();
      const failure = await run(ended).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ScriptActionError);
      expect(failure).toMatchObject({
        code: 'worker.script.outcomeUnknown',
        message:
          'The stop may have happened. The run’s status shows whether it did.',
      });
      expect(methods(invoke)).toEqual([
        'worker.script.execution.stop',
        'worker.script.execution.get',
      ]);
      expect(invoke.mock.calls[1]?.[0].params).toEqual({
        scope: { workspaceId: 'project', worktreeId: 'task' },
        scriptKey: 'project:dev',
        tailLines: 0,
      });
      expect(ended).toHaveBeenCalledTimes(1);
    },
  );

  it('settles the run when another run has taken its key', async () => {
    relay({
      ok: true,
      value: { run: { execution: execution('running', 'run-2'), lines: [] } },
    });
    const ended = jest.fn();
    await expect(stop(ended)).rejects.toMatchObject({
      code: 'worker.script.outcomeUnknown',
    });
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'still running',
      {
        ok: true,
        value: { run: { execution: execution('running'), lines: [] } },
      },
    ],
    [
      'still orphaned',
      {
        ok: true,
        value: { run: { execution: execution('orphaned'), lines: [] } },
      },
    ],
  ])('leaves the run as shown when it is %s', async (_name, read) => {
    relay(read);
    const ended = jest.fn();
    await expect(stop(ended)).rejects.toMatchObject({
      code: 'worker.script.outcomeUnknown',
    });
    expect(ended).not.toHaveBeenCalled();
    expect(reportClientAppError).not.toHaveBeenCalled();
  });

  it.each([
    [
      'refused',
      {
        ok: false,
        error: { ...OUTCOME_UNKNOWN, code: 'worker.script.unavailable' },
      },
    ],
    ['malformed', { ok: true, value: { run: 'not a run' } }],
  ])(
    'records a reread that is %s, keeps the run as shown and the original error',
    async (_name, read) => {
      relay(read);
      const ended = jest.fn();
      const failure = await stop(ended).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ScriptActionError);
      expect(failure).toMatchObject({
        code: 'worker.script.outcomeUnknown',
        message:
          'The stop may have happened. The run’s status shows whether it did.',
      });
      expect(ended).not.toHaveBeenCalled();
      // The failed read is recorded, never folded into 'still running'.
      expect(reportClientAppError).toHaveBeenCalledTimes(1);
      expect(reportClientAppError).not.toHaveBeenCalledWith(failure);
    },
  );

  it('reads nothing again after any other refusal', async () => {
    const invoke = jest.fn(() =>
      Promise.resolve({
        ok: false,
        error: { ...OUTCOME_UNKNOWN, code: 'worker.script.notOwner' },
      }),
    );
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { canopyCore: { invoke } },
    });
    const ended = jest.fn();
    await expect(stop(ended)).rejects.toMatchObject({
      code: 'worker.script.notOwner',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
  });
});
