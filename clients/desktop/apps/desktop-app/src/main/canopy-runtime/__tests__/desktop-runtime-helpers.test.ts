import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableStringify } from '@canopy/protocol/plans';
import {
  CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { DESKTOP_INSTRUCTION_DEFINITIONS } from '../desktop-instruction-definitions';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  runHelperThroughWorker,
  HelperWorkerUnavailableError,
} from '../../helper-runs/helper-runs';
import { createWorkerAgentAdapter } from '../worker-agent-adapter';
import { desktopHelperWorker } from '../../helper-runs/helper-worker-host';
import { currentHelperWorkerContext } from '../../helper-runs/helper-worker-context';

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher;
const caller: CanopyCallerDescriptor = {
  principalId: 'another-client',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.operation.cancel'],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desktop-helpers-'));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

it('runs a staged launch on the local worker and returns its own value', async () => {
  const value = { text: 'ready', usage: { inputTokens: 7 } };
  expect(
    await runHelperThroughWorker({
      kind: 'chat_summary',
      model: 'model',
      scope: { chatId: 'chat' },
      origin: 'client',
      launch: () => Promise.resolve(value),
      usageOf: (result) => result.usage,
    }),
  ).toBe(value);
  const [parent] = (
    await operations.service.list({ kinds: ['core.helper.run'], limit: 10 })
  ).items;
  expect(parent).toMatchObject({
    status: 'completed',
    outcome: {
      usage: { inputTokens: 7 },
      result: {
        sha256: `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`,
        bytes: Buffer.byteLength(stableStringify(value)),
      },
    },
  });
});

it("rethrows the launch's own error while the record keeps only the portable error", async () => {
  const error = new Error('provider /secret/path');
  await expect(
    runHelperThroughWorker({
      kind: 'chat_summary',
      model: 'model',
      scope: {},
      origin: 'system',
      launch: () => Promise.reject(error),
      usageOf: () => undefined,
    }),
  ).rejects.toBe(error);
  const [parent] = (
    await operations.service.list({ kinds: ['core.helper.run'], limit: 10 })
  ).items;
  expect(parent?.error).toEqual({
    kind: 'internal',
    code: 'worker.agent.helperFailed',
    message: 'The helper model call failed.',
    retry: { kind: 'never' },
  });
  expect(JSON.stringify(parent)).not.toContain('/secret/path');
});

it('cancels the launch when another client cancels its operation', async () => {
  const reason = new Error('stopped');
  let started = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = runHelperThroughWorker({
    kind: 'chat_summary',
    model: 'model',
    scope: {},
    origin: 'system',
    launch: (signal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(reason), { once: true });
        started();
      }),
    usageOf: () => undefined,
  });
  const rejected = expect(running).rejects.toBe(reason);
  await ready;
  const [parent] = (
    await operations.service.list({ kinds: ['core.helper.run'], limit: 10 })
  ).items;
  if (!parent) throw new Error('Missing parent');
  await runtime.instruction(
    'core.operation.cancel',
    { operationId: parent.operationId, reason: 'stop' },
    { caller },
  );
  await rejected;
  expect(await operations.service.get(parent.operationId)).toMatchObject({
    status: 'cancelled',
  });
});

it("never runs the launch when the caller aborted first, and throws the caller's reason", async () => {
  const reason = new Error('already stopped');
  const controller = new AbortController();
  controller.abort(reason);
  const launch = jest.fn(() => Promise.resolve('unused'));
  await expect(
    runHelperThroughWorker({
      kind: 'chat_summary',
      model: 'model',
      scope: {},
      origin: 'client',
      signal: controller.signal,
      launch,
      usageOf: () => undefined,
    }),
  ).rejects.toBe(reason);
  expect(launch).not.toHaveBeenCalled();
});

it('runs the launch inside the helper worker context', async () => {
  const context = await runHelperThroughWorker({
    kind: 'chat_summary',
    model: 'model',
    scope: {},
    origin: 'system',
    launch: () => Promise.resolve(currentHelperWorkerContext()),
    usageOf: () => undefined,
  });
  const runIdMatcher: unknown = expect.any(String);
  expect(context).toEqual({
    helperRunId: runIdMatcher,
    kind: 'chat_summary',
  });
  expect(currentHelperWorkerContext()).toBeUndefined();
});

it('refuses with HelperWorkerUnavailableError when the runtime is not accepting', async () => {
  await runtime.shutdown();
  const launch = jest.fn(() => Promise.resolve('unused'));
  await expect(
    runHelperThroughWorker({
      kind: 'chat_summary',
      model: 'model',
      scope: {},
      origin: 'client',
      launch,
      usageOf: () => undefined,
    }),
  ).rejects.toBeInstanceOf(HelperWorkerUnavailableError);
  expect(launch).not.toHaveBeenCalled();
});

it('settles as cancelled without launching when aborted during adapter loading', async () => {
  await runtime.shutdown();
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'delayed-ledger.sqlite'),
  });
  let release = (): void => undefined;
  let started = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
    workerAgentAdapter: createWorkerAgentAdapter({
      loadHelpers: async () => {
        started();
        await loading;
        return desktopHelperWorker;
      },
      sinkFor: () => null,
    }),
  });
  const launch = jest.fn(() => Promise.resolve('unused'));
  const running = runHelperThroughWorker({
    kind: 'chat_summary',
    model: 'model',
    scope: {},
    origin: 'system',
    launch,
    usageOf: () => undefined,
  }).catch(() => undefined);
  try {
    await ready;
    const [parent] = (
      await operations.service.list({ kinds: ['core.helper.run'], limit: 10 })
    ).items;
    if (!parent) throw new Error('Missing parent');
    await runtime.instruction(
      'core.operation.cancel',
      {
        operationId: parent.operationId,
        reason: 'stop during adapter loading',
      },
      { caller },
    );
    release();
    await running;
    expect(launch).not.toHaveBeenCalled();
    expect(await operations.service.get(parent.operationId)).toMatchObject({
      status: 'cancelled',
    });
    const [child] = (
      await operations.service.list({
        kinds: ['worker.agent.helper.run'],
        limit: 10,
      })
    ).items;
    expect(child).toMatchObject({
      status: 'cancelled',
      outcome: { status: 'cancelled', usage: {} },
    });
  } finally {
    release();
  }
});

it('the runtime serves worker.agent.turn.run and worker.agent.subagent.run beside helper runs', async () => {
  expect(runtime.chatTurnRuns.sinkFor('unknown')).toBeNull();
  const { operation: parent } = await operations.service.admit({
    kind: 'core.chat.turn.run',
    status: 'running',
    origin: { kind: 'client', sourceId: 'test' },
    owner: { kind: 'system', id: 'test' },
    scope: { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' },
  });
  const scope = { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' };
  const dispatches = [
    {
      operation: 'worker.agent.helper.run',
      params: {
        helperRunId: 'unknown',
        kind: 'chat_summary',
        scope: {},
        model: 'model',
      },
      code: 'worker.agent.helperLaunchUnavailable',
    },
    {
      operation: 'worker.agent.turn.run',
      params: {
        turnRunId: 'unknown',
        scope,
        turnId: 'message',
        eventNamespace: 'initial',
        providerId: 'claude',
        model: null,
        materializationId: null,
      },
      code: 'worker.agent.runLaunchUnavailable',
    },
    {
      operation: 'worker.agent.subagent.run',
      params: {
        subagentRunId: 'unknown',
        delegationId: 'delegation',
        runGeneration: 1,
        harnessId: 'local-delegation-claude-v1',
        scope,
      },
      code: 'worker.agent.runLaunchUnavailable',
    },
  ];
  for (const { operation, params, code } of dispatches) {
    const dispatched = await runtime.localWorker.dispatch({
      parentOperationId: parent.operationId,
      operation,
      params,
      idempotencyKey: operation,
    });
    expect(dispatched.operation).toMatchObject({
      status: 'failed',
      error: { code },
    });
  }
});

it('the runtime serves worker.agent.provider.list from the worker.agent owner', async () => {
  await runtime.shutdown();
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'provider-ledger.sqlite'),
  });
  const inventory = {
    providers: [
      {
        providerId: 'claude' as const,
        name: 'Claude',
        authState: 'ready' as const,
        checkedAt: '2026-11-05T12:00:00.000Z',
        models: [],
        usageLimit: null,
      },
    ],
  };
  const fakeHost = {
    authorityId: 'local-desktop',
    targetId: 'in_process_worker',
    list: jest.fn(() => Promise.resolve(inventory)),
    platformSupport: jest.fn(() => Promise.resolve(['claude' as const])),
  };
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
    workerAgentAdapter: createWorkerAgentAdapter({
      providerHost: fakeHost,
      sinkFor: () => null,
    }),
  });
  await expect(
    runtime.query(
      'worker.agent.provider.list',
      { scope: {}, probe: false },
      { caller: { ...caller, grants: ['worker.agent.read'] } },
    ),
  ).resolves.toEqual({
    authorityId: 'local-desktop',
    targetId: 'in_process_worker',
    probed: false,
    ...inventory,
  });
});

it('the desktop dispatcher serves core.chat.question.respond', async () => {
  expect(DESKTOP_INSTRUCTION_DEFINITIONS['core.chat.question.respond']).toBe(
    CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS['core.chat.question.respond'],
  );
  // A malformed call reaches the owner's handler, past grant checks.
  await expect(
    runtime.instruction(
      'core.chat.question.respond',
      { chatId: 'chat-1', questionId: 'question-1' },
      { caller: { ...caller, grants: ['core.chat.write'] } },
    ),
  ).rejects.toMatchObject({
    payload: {
      kind: 'invalid_argument',
      message: 'Send answers keyed by question ID, or dismissed: true.',
    },
  });
});
