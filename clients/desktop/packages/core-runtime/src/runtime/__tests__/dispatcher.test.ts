import {
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_INSTRUCTION_DEFINITIONS,
  WORKER_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CanopyInstructionHandlerMap,
  type CanopyQueryHandlerMap,
  type CanopyQueryParams,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError, createCanopyDispatcher } from '../dispatcher';
import type { CanopyHandlerContext } from '../types';
import type { CanopyDispatcher } from '../types';

const caller: CanopyCallerDescriptor = {
  principalId: 'test-user',
  clientInstanceId: 'test-client',
  authorityId: 'test-authority',
  interfaceKind: 'test',
  grants: ['worker.filesystem.read'],
};

const rootsResult = {
  roots: [
    {
      fileRootId: 'repo-1',
      name: 'Repository',
      kind: 'git-repo' as const,
    },
  ],
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type WorkerQueryHandlers = Pick<
  CanopyQueryHandlerMap<CanopyHandlerContext>,
  | 'worker.agent.provider.list'
  | 'worker.filesystem.roots.list'
  | 'worker.filesystem.directory.list'
  | 'worker.filesystem.file.read'
  | 'worker.filesystem.search'
  | 'worker.filesystem.link.resolve'
  | 'worker.git.branch.list'
  | 'worker.git.executable.get'
  | 'worker.git.remote.get'
  | 'worker.git.worktree.health.get'
  | 'worker.git.diff.get'
  | 'worker.script.execution.get'
  | 'worker.script.execution.list'
  | 'worker.script.execution.groupMembers'
  | 'worker.pipeline.execution.get'
  | 'worker.pipeline.execution.list'
  | 'worker.codeGraph.buildQueue.get'
  | 'worker.codeGraph.status.get'
  | 'worker.codeGraph.query'
  | 'worker.codeGraph.snapshot.export'
  | 'worker.codeGraph.languages.validate'
>;

function handlers(
  roots: CanopyQueryHandlerMap<CanopyHandlerContext>['worker.filesystem.roots.list'] = () =>
    rootsResult,
): WorkerQueryHandlers {
  return {
    'worker.agent.provider.list': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.filesystem.roots.list': roots,
    'worker.filesystem.directory.list': () => ({ entries: [] }),
    'worker.filesystem.file.read': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.filesystem.search': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.filesystem.link.resolve': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.git.branch.list': () => ({
      branches: [],
      defaultBranch: null,
      defaultBranchSource: null,
    }),
    'worker.git.executable.get': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.git.remote.get': () => ({
      origin: { state: 'absent' as const },
    }),
    'worker.git.worktree.health.get': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.git.diff.get': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.script.execution.get': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.script.execution.list': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.script.execution.groupMembers': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.pipeline.execution.get': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.pipeline.execution.list': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.codeGraph.buildQueue.get': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.codeGraph.status.get': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.codeGraph.query': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.codeGraph.snapshot.export': (): never => {
      throw new Error('Not exercised.');
    },
    'worker.codeGraph.languages.validate': (): never => {
      throw new Error('Not exercised.');
    },
  };
}

function createDispatcher(
  roots?: CanopyQueryHandlerMap<CanopyHandlerContext>['worker.filesystem.roots.list'],
  shutdownTimeoutMs = 50,
): CanopyDispatcher<typeof WORKER_QUERY_DEFINITIONS> {
  return createCanopyDispatcher({
    profile: 'worker',
    definitions: WORKER_QUERY_DEFINITIONS,
    handlers: handlers(roots),
    shutdownTimeoutMs,
  });
}

const rootsParams = {
  scope: { workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
};

type ChatSendHandler =
  CanopyInstructionHandlerMap<CanopyHandlerContext>['core.chat.message.send'];
const emptyRuntimeMap: Record<never, never> = {};
const chatSendDefinitions: Pick<
  typeof CANOPY_INSTRUCTION_DEFINITIONS,
  'core.chat.message.send'
> = {
  'core.chat.message.send':
    CANOPY_INSTRUCTION_DEFINITIONS['core.chat.message.send'],
};

function createChatSendDispatcher(
  handler: ChatSendHandler,
): CanopyDispatcher<
  Record<never, never>,
  typeof chatSendDefinitions,
  Record<never, never>
> {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: emptyRuntimeMap,
      instructions: chatSendDefinitions,
      streams: emptyRuntimeMap,
    },
    handlers: {
      queries: emptyRuntimeMap,
      instructions: { 'core.chat.message.send': handler },
      streams: emptyRuntimeMap,
    },
  });
}

describe('createCanopyDispatcher', () => {
  it('rejects definition/handler maps that disagree with the runtime profile', () => {
    expect(() =>
      createCanopyDispatcher({
        profile: 'core',
        definitions: CANOPY_QUERY_DEFINITIONS,
        // @ts-expect-error Intentionally missing core handlers to verify runtime validation.
        handlers: handlers(),
      }),
    ).toThrow('core.chat.send.receipt');

    expect(() =>
      createCanopyDispatcher({
        profile: 'worker',
        definitions: WORKER_QUERY_DEFINITIONS,
        // @ts-expect-error Intentionally incomplete to verify runtime validation.
        handlers: {
          'worker.agent.provider.list': (): never => {
            throw new Error('Not exercised.');
          },
          'worker.filesystem.roots.list': () => rootsResult,
        },
      }),
    ).toThrow('worker.filesystem.directory.list');

    expect(() =>
      createCanopyDispatcher({
        profile: 'worker',
        definitions: WORKER_QUERY_DEFINITIONS,
        handlers: {
          ...handlers(),
          // @ts-expect-error Intentionally extra to verify runtime validation.
          'worker.filesystem.extra.read': () => ({}),
        },
      }),
    ).toThrow('worker.filesystem.extra.read');
  });

  it('dispatches with validated params, caller, metadata, and a runtime context', async () => {
    const rootHandler = jest.fn(
      (
        _params: CanopyQueryParams<'worker.filesystem.roots.list'>,
        context: CanopyHandlerContext,
      ) => {
        expect(context.requestId).toEqual(expect.any(String));
        expect(context.caller).toEqual(caller);
        expect(context.metadata).toEqual({ traceparent: '00-trace-parent' });
        expect(context.signal.aborted).toBe(false);
        return {
          ...rootsResult,
          futureTopLevel: true,
          roots: [{ ...rootsResult.roots[0], futureRowField: 'retained' }],
        };
      },
    );
    const dispatcher = createDispatcher(rootHandler);

    await expect(
      dispatcher.query('worker.filesystem.roots.list', rootsParams, {
        caller,
        metadata: { traceparent: '00-trace-parent' },
      }),
    ).resolves.toEqual({
      ...rootsResult,
      futureTopLevel: true,
      roots: [{ ...rootsResult.roots[0], futureRowField: 'retained' }],
    });
    expect(rootHandler).toHaveBeenCalledTimes(1);
  });

  it.each([
    'toString',
    '__proto__',
    'constructor',
    'worker.filesystem.missing',
  ])('rejects unregistered operation %s before handler entry', async (name) => {
    const handler = jest.fn(() => rootsResult);
    const dispatcher = createDispatcher(handler);
    await expect(
      // @ts-expect-error Untrusted bindings can receive arbitrary method names.
      dispatcher.query(name, {}, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    {
      code: 'core.workspace.unrelated' as const,
      retry: { kind: 'never' as const },
    },
    {
      code: 'worker.filesystem.directory.notFound' as const,
      retry: { kind: 'never' as const },
    },
    { retry: { kind: 'same_idempotency_key' as const } },
  ])(
    'redacts a handler error outside its operation contract: %j',
    async (fields) => {
      const dispatcher = createDispatcher(() => {
        throw new CanopyOperationError({
          kind: 'not_found',
          message: 'private invalid handler error',
          ...fields,
        });
      });
      await expect(
        dispatcher.query('worker.filesystem.roots.list', rootsParams, {
          caller,
        }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'internal',
          message: 'The operation returned an invalid error.',
          retry: { kind: 'never' },
        },
      });
    },
  );

  it('rejects idempotency keys on inherently idempotent read queries', async () => {
    const handler = jest.fn(() => rootsResult);
    const dispatcher = createDispatcher(handler);
    await expect(
      dispatcher.query('worker.filesystem.roots.list', rootsParams, {
        caller,
        // @ts-expect-error Read queries do not accept keyed-replay metadata.
        metadata: { idempotencyKey: 'not-a-keyed-operation' },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps keyed retry guidance when an instruction deadline expires in flight', async () => {
    const dispatcher = createChatSendDispatcher(
      () => new Promise<never>(() => {}),
    );
    await expect(
      dispatcher.instruction(
        'core.chat.message.send',
        {
          scope: rootsParams.scope,
          commandId: 'command-1',
          _meta: { idempotencyKey: 'command-1' },
          chatId: 'chat-1',
          messageId: 'message-1',
          text: 'hello',
        },
        {
          caller: { ...caller, grants: ['core.chat.write'] },
          metadata: {
            idempotencyKey: 'command-1',
            deadlineAt: new Date(Date.now() + 20).toISOString(),
          },
        },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'deadline_exceeded',
        retry: { kind: 'same_idempotency_key' },
      },
    });
  });

  it('keeps a handler retry delay when normalizing keyed retry guidance', async () => {
    const dispatcher = createChatSendDispatcher(() => {
      throw new CanopyOperationError({
        kind: 'unavailable',
        message: 'Chat state is busy.',
        retry: { kind: 'same_request', delayMs: 5000 },
      });
    });
    await expect(
      dispatcher.instruction(
        'core.chat.message.send',
        {
          scope: rootsParams.scope,
          commandId: 'command-1',
          _meta: { idempotencyKey: 'command-1' },
          chatId: 'chat-1',
          messageId: 'message-1',
          text: 'hello',
        },
        {
          caller: { ...caller, grants: ['core.chat.write'] },
          metadata: { idempotencyKey: 'command-1' },
        },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        retry: { kind: 'same_idempotency_key', delayMs: 5000 },
      },
    });
  });

  it.each(['expired deadline', 'shutdown'])(
    'keeps keyed retry guidance during preparation: %s',
    async (failure) => {
      const handler = jest.fn(() => ({
        commandId: 'command-1',
        revision: 1,
        outcome: 'applied' as const,
      }));
      const dispatcher = createChatSendDispatcher(handler);
      if (failure === 'shutdown') await dispatcher.shutdown();
      await expect(
        dispatcher.instruction(
          'core.chat.message.send',
          {
            scope: rootsParams.scope,
            commandId: 'command-1',
            _meta: { idempotencyKey: 'command-1' },
            chatId: 'chat-1',
            messageId: 'message-1',
            text: 'hello',
          },
          {
            caller: { ...caller, grants: ['core.chat.write'] },
            metadata: {
              idempotencyKey: 'command-1',
              deadlineAt:
                failure === 'expired deadline'
                  ? new Date(Date.now() - 1000).toISOString()
                  : undefined,
            },
          },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: failure === 'shutdown' ? 'unavailable' : 'deadline_exceeded',
          retry: { kind: 'same_idempotency_key' },
        },
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('applies rejection ordering before handler execution', async () => {
    const rootHandler = jest.fn(() => rootsResult);
    const dispatcher = createDispatcher(rootHandler);
    await dispatcher.shutdown();
    await expect(
      // @ts-expect-error Intentionally unknown to verify rejection ordering.
      dispatcher.query('worker.filesystem.missing', {}, {}),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    expect(rootHandler).not.toHaveBeenCalled();
  });

  it('validates metadata, params, callers, and exact grants in order', async () => {
    const rootHandler = jest.fn(() => rootsResult);
    const dispatcher = createDispatcher(rootHandler);

    await expect(
      dispatcher.query(
        'worker.filesystem.roots.list',
        // @ts-expect-error Intentionally malformed to verify validation ordering.
        { nope: true },
        {
          caller: { ...caller, grants: [] },
          metadata: { extra: true },
        },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        message: 'Invalid request metadata.',
      },
    });
    await expect(
      dispatcher.query(
        'worker.filesystem.roots.list',
        // @ts-expect-error Intentionally malformed to verify parameter validation.
        { nope: true },
        {
          caller: { ...caller, grants: [] },
        },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        message: 'Invalid operation parameters.',
      },
    });
    await expect(
      dispatcher.query('worker.filesystem.roots.list', rootsParams, {
        caller: { ...caller, principalId: '' },
      }),
    ).rejects.toMatchObject({
      payload: { kind: 'unauthenticated' },
    });
    await expect(
      dispatcher.query('worker.filesystem.roots.list', rootsParams, {
        caller: { ...caller, grants: [] },
      }),
    ).rejects.toMatchObject({
      payload: { kind: 'permission_denied' },
    });
    expect(rootHandler).not.toHaveBeenCalled();
  });

  it('rejects pre-aborted calls and already-expired deadlines before invoking handlers', async () => {
    const rootHandler = jest.fn(() => rootsResult);
    const dispatcher = createDispatcher(rootHandler);
    const controller = new AbortController();
    controller.abort();

    await expect(
      dispatcher.query('worker.filesystem.roots.list', rootsParams, {
        caller,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      payload: { kind: 'cancelled', retry: { kind: 'never' } },
    });
    await expect(
      dispatcher.query('worker.filesystem.roots.list', rootsParams, {
        caller,
        metadata: { deadlineAt: '2000-01-01T00:00:00.000Z' },
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'deadline_exceeded',
        retry: { kind: 'same_request' },
      },
    });
    expect(rootHandler).not.toHaveBeenCalled();
  });

  it('settles cancellation and deadline races without observing late handler outcomes', async () => {
    const late = deferred<typeof rootsResult>();
    const controller = new AbortController();
    const dispatcher = createDispatcher(() => late.promise);
    const cancelled = dispatcher.query(
      'worker.filesystem.roots.list',
      rootsParams,
      { caller, signal: controller.signal },
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      payload: { kind: 'cancelled', retry: { kind: 'never' } },
    });
    late.resolve(rootsResult);
    await Promise.resolve();
    await expect(cancelled).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });

    const deadlineDispatcher = createDispatcher(() => new Promise(() => {}));
    await expect(
      deadlineDispatcher.query('worker.filesystem.roots.list', rootsParams, {
        caller,
        metadata: { deadlineAt: new Date(Date.now() + 15).toISOString() },
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'deadline_exceeded',
        retry: { kind: 'same_request' },
      },
    });
  });

  it('rejects a synchronous handler result that completes after its deadline', async () => {
    const startedAt = new Date('2026-09-04T12:00:00.000Z');
    const deadlineAt = new Date(startedAt.getTime() + 10).toISOString();
    jest.useFakeTimers({ now: startedAt });
    const dispatcher = createDispatcher(() => {
      jest.setSystemTime(new Date(startedAt.getTime() + 11));
      return rootsResult;
    });

    try {
      await expect(
        dispatcher.query('worker.filesystem.roots.list', rootsParams, {
          caller,
          metadata: { deadlineAt },
        }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'deadline_exceeded',
          retry: { kind: 'same_request' },
        },
      });
    } finally {
      await dispatcher.shutdown();
      jest.useRealTimers();
    }
  });

  it('bounds long-range deadline timers instead of overflowing the host timer', async () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const gate = deferred<typeof rootsResult>();
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const dispatcher = createDispatcher(() => gate.promise);
    const pending = dispatcher.query(
      'worker.filesystem.roots.list',
      rootsParams,
      {
        caller,
        metadata: { deadlineAt: '2026-02-01T00:00:00.000Z' },
      },
    );

    try {
      expect(timeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        2_147_483_647,
      );
    } finally {
      gate.resolve(rootsResult);
      await expect(pending).resolves.toEqual(rootsResult);
      await dispatcher.shutdown();
      timeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('converts malformed results and unknown throws to redacted internal errors', async () => {
    const malformed = createDispatcher(
      // @ts-expect-error Intentionally malformed to verify result validation.
      () => ({
        roots: [{ secret: true }],
      }),
    );
    await expect(
      malformed.query('worker.filesystem.roots.list', rootsParams, { caller }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'internal',
        message: 'The operation returned an invalid result.',
      },
    });

    const thrown = createDispatcher(() => {
      throw new Error('secret host path /private/example');
    });
    await expect(
      thrown.query('worker.filesystem.roots.list', rootsParams, { caller }),
    ).rejects.toMatchObject({
      payload: { kind: 'internal', message: 'The operation failed.' },
    });
  });

  it('preserves typed operation errors without serializing runtime causes', async () => {
    const cause = new Error('runtime-only cause');
    const operationError = new CanopyOperationError(
      {
        kind: 'not_found',
        message: 'The requested root was not found.',
        code: 'worker.filesystem.roots.notFound',
        retry: { kind: 'never' },
      },
      cause,
    );
    const dispatcher = createDispatcher(() => {
      throw operationError;
    });

    const rejection = dispatcher.query(
      'worker.filesystem.roots.list',
      rootsParams,
      { caller },
    );
    await expect(rejection).rejects.toBe(operationError);
    expect(operationError.runtimeCause).toBe(cause);
    expect(JSON.stringify(operationError)).toBe(
      JSON.stringify(operationError.payload),
    );
    expect(JSON.stringify(operationError)).not.toContain('runtime-only cause');
  });

  it('drains completed work and bounds/idempotently interrupts stuck work on shutdown', async () => {
    const gate = deferred<typeof rootsResult>();
    const draining = createDispatcher(() => gate.promise, 100);
    const active = draining.query('worker.filesystem.roots.list', rootsParams, {
      caller,
    });
    const shutdown = draining.shutdown();
    expect(draining.shutdown()).toBe(shutdown);
    await expect(
      draining.query('worker.filesystem.roots.list', rootsParams, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    gate.resolve(rootsResult);
    await expect(active).resolves.toEqual(rootsResult);
    await expect(shutdown).resolves.toBeUndefined();

    const stuck = createDispatcher(() => new Promise(() => {}), 20);
    const stuckCall = stuck.query('worker.filesystem.roots.list', rootsParams, {
      caller,
    });
    const startedAt = Date.now();
    await expect(stuck.shutdown()).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(stuckCall).rejects.toMatchObject({
      payload: { kind: 'cancelled', retry: { kind: 'never' } },
    });
  });
});
