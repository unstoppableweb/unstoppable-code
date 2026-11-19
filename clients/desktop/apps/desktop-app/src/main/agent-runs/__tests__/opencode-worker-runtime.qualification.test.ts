import { OpenCodeProvider } from '../../agents/opencode-session';
import { openOpenCodeExecutionRuntime } from '../../opencode/execution-runtime';
import type { ProviderProcessRequest } from '@canopy/desktop-shared/node/provider-process/spawn';
import {
  AgentOutsideWorkerError,
  runInAgentWorker,
  runInAgentWorkerSync,
} from '../agent-worker-context';
import {
  getOpenCodeWorkerRuntime,
  OpenCodeProcessOutsideRunError,
  openCodeProcessOwner,
  openOpenCodeExecutionForWorkerRun,
  spawnOpenCodeProcessForWorkerRun,
  type OpenCodeExecutionRuntimeInput,
  type OpenCodeProcessOwner,
  type OpenCodeWorkerRunEntry,
} from '../opencode-worker-runtime';
import { spawnProviderProcess } from '../provider-process-host';
import { workerProviderRuntimeFor } from '../worker-provider-runtimes';
import { windowAgentInterfacePort } from '../../agents/agent-interface-port';

const fakeRuntime = Object.freeze({ rawModelId: 'fixture/model' });
const fakeProcess = Object.freeze({ pid: 4242 });

jest.mock('../../agents/opencode-session', () => ({
  OpenCodeProvider: jest
    .fn()
    .mockImplementation(() => ({ createSession: jest.fn() })),
}));
jest.mock('../../opencode/execution-runtime', () => ({
  openOpenCodeExecutionRuntime: jest.fn(() => Promise.resolve(fakeRuntime)),
}));
jest.mock('../provider-process-host', () => ({
  spawnProviderProcess: jest.fn(() => fakeProcess),
}));

const providerMock = jest.mocked(OpenCodeProvider);
const openerMock = jest.mocked(openOpenCodeExecutionRuntime);
const spawnMock = jest.mocked(spawnProviderProcess);

function processRequest(owner: OpenCodeProcessOwner): ProviderProcessRequest {
  return {
    command: '/usr/bin/opencode',
    args: ['acp'],
    cwd: '/work',
    env: {},
    owner,
  };
}

function executionInput(): OpenCodeExecutionRuntimeInput {
  return {
    model: 'opencode/fixture/model',
    sessionId: 'session',
    signal: new AbortController().signal,
    attribution: () => Promise.reject(new Error('unused')),
  };
}

beforeEach(() => {
  providerMock.mockClear();
  openerMock.mockClear();
  spawnMock.mockClear();
});

it('constructs the OpenCode provider inside a turn run', async () => {
  const provider = await runInAgentWorker(
    { kind: 'turn', runId: 't1' },
    async () => {
      const runtime = await workerProviderRuntimeFor('opencode');
      if (!runtime) throw new Error('No OpenCode runtime registered');
      return runtime.providerFor(
        'opencode',
        windowAgentInterfacePort(() => null),
      );
    },
  );
  expect(provider).toBe(providerMock.mock.results[0]?.value);
  expect(providerMock).toHaveBeenCalledTimes(1);
  expect(providerMock).toHaveBeenCalledWith();
});

it('a subagent run may construct the provider', async () => {
  const provider = await runInAgentWorker(
    { kind: 'subagent', runId: 's1' },
    async () => {
      const runtime = await workerProviderRuntimeFor('opencode');
      if (!runtime) throw new Error('No OpenCode runtime registered');
      return runtime.providerFor(
        'opencode',
        windowAgentInterfacePort(() => null),
      );
    },
  );
  expect(provider).toBe(providerMock.mock.results[0]?.value);
  expect(providerMock).toHaveBeenCalledTimes(1);
});

it('refuses an OpenCode provider outside a worker run', async () => {
  const refused = getOpenCodeWorkerRuntime().providerFor(
    'opencode',
    windowAgentInterfacePort(() => null),
  );
  await expect(refused).rejects.toBeInstanceOf(AgentOutsideWorkerError);
  await expect(refused).rejects.toThrow('OpenCodeWorkerRuntime.providerFor');
  expect(providerMock).not.toHaveBeenCalled();
});

it("opens the execution runtime inside a run with the caller's input unchanged", async () => {
  const cases: ReadonlyArray<
    readonly [
      OpenCodeWorkerRunEntry,
      { kind: 'turn' | 'subagent'; runId: string },
    ]
  > = [
    ['opencodeSessionTurn', { kind: 'turn', runId: 't2' }],
    ['opencodeDelegationRunner', { kind: 'subagent', runId: 's2' }],
  ];
  for (const [entry, context] of cases) {
    openerMock.mockClear();
    const input = executionInput();
    const runtime = await runInAgentWorker(context, () =>
      openOpenCodeExecutionForWorkerRun(entry, input),
    );
    expect(runtime).toBe(fakeRuntime);
    expect(openerMock).toHaveBeenCalledTimes(1);
    expect(openerMock.mock.calls[0]?.[0]).toBe(input);
  }
});

it('refuses an OpenCode execution runtime outside a worker run', async () => {
  const refused = openOpenCodeExecutionForWorkerRun(
    'opencodeDelegationRunner',
    executionInput(),
  );
  await expect(refused).rejects.toBeInstanceOf(AgentOutsideWorkerError);
  await expect(refused).rejects.toThrow(
    'OpenCodeWorkerRuntime.openExecution:opencodeDelegationRunner',
  );
  expect(openerMock).not.toHaveBeenCalled();
});

it('an execution runtime opened after awaits inside a turn run is admitted', async () => {
  const runtime = await runInAgentWorker(
    { kind: 'turn', runId: 't3' },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      return openOpenCodeExecutionForWorkerRun(
        'opencodeSessionTurn',
        executionInput(),
      );
    },
  );
  expect(runtime).toBe(fakeRuntime);
  expect(openerMock).toHaveBeenCalledTimes(1);
});

it("a turn's OpenCode process starts only inside its own run", () => {
  const request = processRequest({ kind: 'turn', id: 't3' });
  const spawned = runInAgentWorkerSync({ kind: 'turn', runId: 't3' }, () =>
    spawnOpenCodeProcessForWorkerRun(request),
  );
  expect(spawned).toBe(fakeProcess);
  expect(spawnMock.mock.calls[0]?.[0]).toBe(request);
  const message =
    'OpenCode processes for a turn start only inside that run (t3).';
  expect(() =>
    runInAgentWorkerSync({ kind: 'turn', runId: 't4' }, () =>
      spawnOpenCodeProcessForWorkerRun(request),
    ),
  ).toThrow(new OpenCodeProcessOutsideRunError({ kind: 'turn', id: 't3' }));
  expect(() =>
    runInAgentWorkerSync({ kind: 'turn', runId: 't4' }, () =>
      spawnOpenCodeProcessForWorkerRun(request),
    ),
  ).toThrow(message);
  expect(() => spawnOpenCodeProcessForWorkerRun(request)).toThrow(message);
  expect(spawnMock).toHaveBeenCalledTimes(1);
});

it('a subagent owner requires its subagent run', () => {
  const request = processRequest({ kind: 'subagent', id: 's3' });
  expect(() =>
    runInAgentWorkerSync({ kind: 'turn', runId: 's3' }, () =>
      spawnOpenCodeProcessForWorkerRun(request),
    ),
  ).toThrow(OpenCodeProcessOutsideRunError);
  expect(spawnMock).not.toHaveBeenCalled();
  expect(
    runInAgentWorkerSync({ kind: 'subagent', runId: 's3' }, () =>
      spawnOpenCodeProcessForWorkerRun(request),
    ),
  ).toBe(fakeProcess);
  expect(spawnMock).toHaveBeenCalledTimes(1);
});

it('discovery and pipeline processes start outside runs, and owners name the current run', () => {
  expect(
    spawnOpenCodeProcessForWorkerRun(
      processRequest({ kind: 'discovery', id: 'd' }),
    ),
  ).toBe(fakeProcess);
  expect(
    spawnOpenCodeProcessForWorkerRun(
      processRequest({ kind: 'pipeline', id: 'p' }),
    ),
  ).toBe(fakeProcess);
  expect(spawnMock).toHaveBeenCalledTimes(2);
  expect(
    runInAgentWorkerSync({ kind: 'subagent', runId: 's5' }, () =>
      openCodeProcessOwner('agent'),
    ),
  ).toEqual({ kind: 'subagent', id: 's5' });
  const pipeline = openCodeProcessOwner('pipeline');
  expect(pipeline.kind).toBe('pipeline');
  expect(pipeline.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(openCodeProcessOwner(undefined).kind).toBe('discovery');
});
