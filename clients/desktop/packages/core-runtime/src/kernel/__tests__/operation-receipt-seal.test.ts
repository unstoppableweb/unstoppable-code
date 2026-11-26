/** CAN-4733: a seal makes absent final for a worker run; a lookup stays a pure read. */
import {
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
  type WorkerFilesystemEntryDeleteParams,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../runtime/dispatcher';
import { createInProcessWorkerBinding } from '../../runtime/in-process-worker-binding';
import type { LocalWorkerBindingClient } from '../../runtime/local-worker-binding-client';
import { serializingWorkerPair } from '../../runtime/__tests__/serializing-worker-pair';
import { createSupervisedLocalWorker } from '../../runtime/supervised-local-worker';
import {
  dispatchTagPrincipal,
  dispatchTagScope,
  peerScopedDispatchTag,
  scopeForwardedDispatchTags,
} from '../../runtime/dispatch-tag-scope';
import type { CanopyHandlerContext } from '../../runtime/types';
import { createWorkerExecutorReceipts } from '../../runtime/worker-executor-receipts';
import { createWorkerOperationReceiptSeal } from '../../runtime/worker-operation-receipts';
import {
  OPERATION_RECEIPT_QUERY,
  OPERATION_RECEIPT_SEAL,
  routeOperationReceiptLookups,
  routeOperationReceiptSeals,
  type OperationReceiptState,
} from '../operation-receipt-routing';

const DELETE = 'worker.filesystem.entry.delete';
const RESULT = { deleted: true, deletedEntryCount: 1, disposition: 'trash' };
const CALLER: CanopyCallerDescriptor = {
  principalId: 'worker-caller',
  clientInstanceId: 'bundled-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.filesystem.write'],
};

/** A tag as the core scopes it before a worker sees it. */
const scoped = (name: string): string => peerScopedDispatchTag(CALLER, name);

function tagged(
  dispatchId: string,
  signal: AbortSignal = new AbortController().signal,
): CanopyHandlerContext {
  return {
    requestId: dispatchId,
    caller: CALLER,
    metadata: {
      idempotencyKey: `key-${dispatchId}`,
      dispatchId: scoped(dispatchId),
    },
    signal,
  };
}

function params(dispatchId: string): Record<string, unknown> {
  return {
    relativePath: dispatchId,
    _meta: {
      idempotencyKey: `key-${dispatchId}`,
      dispatchId: scoped(dispatchId),
    },
  };
}

function receiptsWith(
  handler: () => Promise<unknown>,
  options: Parameters<typeof createWorkerExecutorReceipts>[1] = {},
): {
  receipts: ReturnType<typeof createWorkerExecutorReceipts>;
  run: (dispatchId: string) => Promise<unknown>;
} {
  const receipts = createWorkerExecutorReceipts(
    WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
    options,
  );
  const wrapped = receipts.wrap({ [DELETE]: handler })[DELETE];
  if (!wrapped) throw new Error('Missing wrapped handler');
  return {
    receipts,
    run: (dispatchId) =>
      Promise.resolve(wrapped(params(dispatchId), tagged(dispatchId))),
  };
}

const notStarted = {
  payload: {
    kind: 'failed_precondition',
    details: { receipt: 'not-started' },
    retry: { kind: 'never' },
  },
};

describe('dispatch tag seal', () => {
  it('refuses a dispatch unrun when its tag was sealed first, and repeats the answer', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const { receipts, run } = receiptsWith(handler);
    const seal = (): unknown =>
      receipts.seal(CALLER.principalId, DELETE, scoped('t'));
    expect(seal()).toEqual({ state: 'absent' });
    expect(seal()).toEqual({ state: 'absent' });
    await expect(run('t')).rejects.toMatchObject(notStarted);
    expect(handler).not.toHaveBeenCalled();
    expect(seal()).toEqual({ state: 'absent' });
    expect(
      receipts.lookup(CALLER.principalId, DELETE, { dispatchId: scoped('t') }),
    ).toEqual({ state: 'absent' });
  });

  it('keeps a lookup a pure read: a tag looked up first still runs once', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const { receipts, run } = receiptsWith(handler);
    expect(
      receipts.lookup(CALLER.principalId, DELETE, { dispatchId: scoped('t') }),
    ).toEqual({ state: 'absent' });
    await expect(run('t')).resolves.toEqual(RESULT);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reads running when the dispatch arrives first, then settled', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const handler = jest.fn(
      (): Promise<unknown> =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { receipts, run } = receiptsWith(handler);
    const running = run('t');
    expect(receipts.seal(CALLER.principalId, DELETE, scoped('t'))).toEqual({
      state: 'running',
    });
    for (let tick = 0; tick < 10 && handler.mock.calls.length === 0; tick += 1)
      await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    finish(RESULT);
    await expect(running).resolves.toEqual(RESULT);
    expect(receipts.seal(CALLER.principalId, DELETE, scoped('t'))).toEqual({
      state: 'settled',
      outcome: { status: 'completed', result: RESULT },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('answers forgotten past the tag bound and seals nothing', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const { receipts, run } = receiptsWith(handler, { maxReplayedKeys: 2 });
    expect(receipts.seal(CALLER.principalId, DELETE, scoped('sealed'))).toEqual(
      {
        state: 'absent',
      },
    );
    await run('first');
    expect(receipts.seal(CALLER.principalId, DELETE, scoped('late'))).toEqual({
      state: 'forgotten',
    });
    await expect(run('late')).rejects.toMatchObject({
      payload: {
        kind: 'resource_exhausted',
        details: { receipt: 'keys-exhausted' },
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps lookups by idempotency key pure', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const receipts = createWorkerExecutorReceipts(
      WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
    );
    const wrapped = receipts.wrap({ [DELETE]: handler })[DELETE];
    if (!wrapped) throw new Error('Missing wrapped handler');
    expect(
      receipts.lookup(CALLER.principalId, DELETE, { idempotencyKey: 'k' }),
    ).toEqual({ state: 'absent' });
    await Promise.resolve(
      wrapped(
        { relativePath: 'a', _meta: { idempotencyKey: 'k' } },
        {
          requestId: 'k',
          caller: CALLER,
          metadata: { idempotencyKey: 'k' },
          signal: new AbortController().signal,
        },
      ),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('worker incarnation', () => {
  const context: CanopyHandlerContext = {
    requestId: 'lookup',
    caller: CALLER,
    metadata: {},
    signal: new AbortController().signal,
  };

  const forward = jest.fn(
    (): Promise<unknown> =>
      Promise.resolve({ daemonEpoch: 'worker', receipt: { state: 'absent' } }),
  );
  beforeEach(() => forward.mockClear());

  function route(
    state: OperationReceiptState,
    caller: CanopyCallerDescriptor = CALLER,
    expectedEpoch = 'core-epoch',
  ): (dispatchId: string) => Promise<unknown> {
    const options = {
      instructions: WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
      peerScopedIdempotency: new Set<string>(),
      state,
    };
    const seal = routeOperationReceiptSeals(
      { [OPERATION_RECEIPT_SEAL]: forward },
      options,
    )[OPERATION_RECEIPT_SEAL];
    if (!seal) throw new Error('Missing seal route');
    return (dispatchId) =>
      Promise.resolve(
        seal(
          { operation: DELETE, dispatchId, expectedEpoch },
          { ...context, caller },
        ),
      );
  }

  it('keeps a sealed absent final for the first worker under the core epoch', async () => {
    await expect(
      route({ daemonEpoch: 'core-epoch', workerIncarnation: () => 1 })('t'),
    ).resolves.toEqual({
      daemonEpoch: 'core-epoch',
      receipt: { state: 'absent' },
    });
  });

  it('reads unknown after a supervised worker restarts, with the incarnation in the epoch', async () => {
    const lookup = routeOperationReceiptLookups(
      { [OPERATION_RECEIPT_QUERY]: forward },
      {
        instructions: WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
        peerScopedIdempotency: new Set(),
        state: { daemonEpoch: 'core-epoch', workerIncarnation: () => 2 },
      },
    )[OPERATION_RECEIPT_QUERY];
    await expect(
      Promise.resolve(
        lookup?.({ operation: DELETE, dispatchId: 't' }, context),
      ),
    ).resolves.toEqual({
      daemonEpoch: 'core-epoch/worker-2',
      receipt: { state: 'forgotten' },
    });
  });

  it('refuses a seal naming another run before forwarding, never answering absent', async () => {
    const restarted: OperationReceiptState = {
      daemonEpoch: 'core-epoch',
      workerIncarnation: (): number => 2,
    };
    const epochChanged = (daemonEpoch: string): object => ({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.operation.receipt.epochChanged',
        details: { daemonEpoch },
        retry: { kind: 'never' },
      },
    });
    // A daemon restart: the dispatch was sent under the old epoch.
    await expect(
      route({ daemonEpoch: 'core-epoch' }, CALLER, 'old-epoch')('t'),
    ).rejects.toMatchObject(epochChanged('core-epoch'));
    // A split worker restart under the same core epoch.
    await expect(route(restarted)('t')).rejects.toMatchObject(
      epochChanged('core-epoch/worker-2'),
    );
    expect(forward).not.toHaveBeenCalled();
    // A seal naming the run answering now may be final.
    await expect(
      route(restarted, CALLER, 'core-epoch/worker-2')('t'),
    ).resolves.toEqual({
      daemonEpoch: 'core-epoch/worker-2',
      receipt: { state: 'absent' },
    });
  });

  it('reads forgotten when the worker restarts during a seal', async () => {
    const seen = [1, 1, 2];
    const state: OperationReceiptState = {
      daemonEpoch: 'core-epoch',
      workerIncarnation: () => seen.shift() ?? 2,
    };
    await expect(route(state)('t')).resolves.toEqual({
      daemonEpoch: 'core-epoch/worker-2',
      receipt: { state: 'forgotten' },
    });
  });

  it('counts each worker the supervised route attaches', () => {
    const worker = createSupervisedLocalWorker({
      definitions: { queries: {}, instructions: {}, streams: {} },
    });
    const client = (): LocalWorkerBindingClient => ({
      forwarders: { queries: {}, instructions: {}, streams: {} },
      signal: new AbortController().signal,
      query: (): Promise<never> => Promise.reject(new Error('unused')),
      instruction: (): Promise<never> => Promise.reject(new Error('unused')),
      openStream: (): Promise<never> => Promise.reject(new Error('unused')),
      receipt: (): Promise<null> => Promise.resolve(null),
      releaseReceipt: (): void => undefined,
      close: (): void => undefined,
    });
    expect(worker.incarnation()).toBe(0);
    worker.attach(client());
    expect(worker.incarnation()).toBe(1);
    worker.attach(client());
    expect(worker.incarnation()).toBe(2);
  });
});

describe('who may seal', () => {
  const WRITE = 'worker.filesystem.write';
  const context: CanopyHandlerContext = {
    requestId: 'seal',
    caller: CALLER,
    metadata: {},
    signal: new AbortController().signal,
  };
  const deleteDefinition =
    WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS[DELETE];
  // A served instruction gated by two grants.
  const INSTRUCTIONS = {
    ...WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
    'worker.example.twoGrants': {
      ...deleteDefinition,
      requiredGrants: [WRITE, 'worker.git.write'],
    },
    'worker.example.ungated': { ...deleteDefinition, requiredGrants: [] },
  } as const;
  const forward = jest.fn(
    (): Promise<unknown> =>
      Promise.resolve({ daemonEpoch: 'worker', receipt: { state: 'absent' } }),
  );
  beforeEach(() => forward.mockClear());

  function sealAs(grants: string[], operation: string): Promise<unknown> {
    const seal = routeOperationReceiptSeals(
      { [OPERATION_RECEIPT_SEAL]: forward },
      {
        instructions: INSTRUCTIONS,
        peerScopedIdempotency: new Set(),
        state: { daemonEpoch: 'core-epoch' },
      },
    )[OPERATION_RECEIPT_SEAL];
    if (!seal) throw new Error('Missing seal route');
    const caller: CanopyCallerDescriptor = {
      ...CALLER,
      grants: grants.filter(
        (grant): grant is CanopyCallerDescriptor['grants'][number] =>
          grant.startsWith('worker.'),
      ),
    };
    return Promise.resolve(
      seal(
        { operation, dispatchId: 't', expectedEpoch: 'core-epoch' },
        { ...context, caller },
      ),
    );
  }
  const denied = { payload: { kind: 'permission_denied' } };

  it('seals a tag of a served instruction for a caller holding its grant', async () => {
    await expect(sealAs([WRITE], DELETE)).resolves.toMatchObject({
      receipt: { state: 'absent' },
    });
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('refuses a caller holding only read grants before forwarding', async () => {
    await expect(
      sealAs(['worker.filesystem.read'], DELETE),
    ).rejects.toMatchObject(denied);
    expect(forward).not.toHaveBeenCalled();
  });

  it('refuses a tag naming a read operation before forwarding', async () => {
    await expect(
      sealAs(
        [WRITE, 'worker.filesystem.read'],
        'worker.filesystem.directory.list',
      ),
    ).rejects.toMatchObject(denied);
    expect(forward).not.toHaveBeenCalled();
  });

  it('refuses an unknown instruction, and the seal itself, before forwarding', async () => {
    for (const operation of ['worker.example.unserved', OPERATION_RECEIPT_SEAL])
      await expect(sealAs([WRITE], operation)).rejects.toMatchObject(denied);
    expect(forward).not.toHaveBeenCalled();
  });

  it('refuses a caller missing one of several grants before forwarding', async () => {
    await expect(
      sealAs([WRITE], 'worker.example.twoGrants'),
    ).rejects.toMatchObject(denied);
    expect(forward).not.toHaveBeenCalled();
    await expect(
      sealAs([WRITE, 'worker.git.write'], 'worker.example.twoGrants'),
    ).resolves.toMatchObject({ receipt: { state: 'absent' } });
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('refuses an instruction gated by no grant, on the core and on the worker', async () => {
    await expect(
      sealAs([WRITE], 'worker.example.ungated'),
    ).rejects.toMatchObject(denied);
    expect(forward).not.toHaveBeenCalled();
    const receipts = createWorkerExecutorReceipts(INSTRUCTIONS);
    const seal = createWorkerOperationReceiptSeal({
      receipts,
      instructions: INSTRUCTIONS,
      daemonEpoch: () => 'worker',
    });
    let refusal: unknown;
    try {
      seal(
        {
          operation: 'worker.example.ungated',
          dispatchId: scoped('t'),
          expectedEpoch: 'worker',
        },
        context,
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject(denied);
    expect(
      receipts.lookup(CALLER.principalId, 'worker.example.ungated', {
        dispatchId: scoped('t'),
      }),
    ).toEqual({ state: 'absent' });
  });

  it('finds every served worker instruction gated by a grant, so no legitimate seal is refused', () => {
    // A seal needs exactly the grants dispatching the instruction needs.
    const ungated = Object.entries(WORKER_INSTRUCTION_DEFINITIONS)
      .filter(([name]) => name !== OPERATION_RECEIPT_SEAL)
      .filter(([, definition]) => definition.requiredGrants.length === 0)
      .map(([name]) => name);
    expect(ungated).toEqual([]);
  });
});

describe('who may look up', () => {
  const forward = jest.fn(
    (): Promise<unknown> =>
      Promise.resolve({ daemonEpoch: 'worker', receipt: { state: 'absent' } }),
  );
  beforeEach(() => forward.mockClear());

  it('refuses an unknown name, a query and the seal on the core, before forwarding', async () => {
    const lookup = routeOperationReceiptLookups(
      { [OPERATION_RECEIPT_QUERY]: forward },
      {
        instructions: {
          ...WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
          ...WORKER_INSTRUCTION_DEFINITIONS,
        },
        peerScopedIdempotency: new Set(),
        state: { daemonEpoch: 'core-epoch' },
      },
    )[OPERATION_RECEIPT_QUERY];
    if (!lookup) throw new Error('Missing lookup route');
    const context: CanopyHandlerContext = {
      requestId: 'lookup',
      caller: { ...CALLER, grants: ['worker.filesystem.write'] },
      metadata: {},
      signal: new AbortController().signal,
    };
    for (const operation of [
      'worker.example.unserved',
      'worker.filesystem.directory.list',
      OPERATION_RECEIPT_SEAL,
    ])
      await expect(
        Promise.resolve(lookup({ operation, dispatchId: 't' }, context)),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          code: 'worker.operation.receipt.unknownOperation',
        },
      });
    expect(forward).not.toHaveBeenCalled();
    await expect(
      Promise.resolve(lookup({ operation: DELETE, dispatchId: 't' }, context)),
    ).resolves.toMatchObject({ receipt: { state: 'absent' } });
    expect(forward).toHaveBeenCalledTimes(1);
  });
});

describe('dispatch tags per peer (security review, Low)', () => {
  const peer = (clientInstanceId: string): CanopyCallerDescriptor => ({
    ...CALLER,
    clientInstanceId,
  });
  const tagOf = (clientInstanceId: string, name: string): string =>
    peerScopedDispatchTag(peer(clientInstanceId), name);
  const BOUND_MESSAGES = {
    peer: 'This caller may record no more dispatch tags on this worker until it restarts.',
    principal:
      "This caller's principal may record no more dispatch tags on this worker, from any of its sessions, until it restarts.",
    worker:
      'This worker accepts no more dispatch tags from any caller until it restarts.',
  };
  const exhausted = (scope: 'peer' | 'principal' | 'worker'): object => ({
    payload: {
      kind: 'resource_exhausted',
      message: BOUND_MESSAGES[scope],
      details: { receipt: 'keys-exhausted', scope },
      retry: { kind: 'never' },
    },
  });
  const unscoped = {
    payload: {
      kind: 'invalid_argument',
      details: { receipt: 'tag-unscoped' },
      retry: { kind: 'never' },
    },
  };

  function receiptsFor(
    options: Parameters<typeof createWorkerExecutorReceipts>[1],
  ): {
    handler: jest.Mock<Promise<unknown>, []>;
    receipts: ReturnType<typeof createWorkerExecutorReceipts>;
    run: (dispatchId: string) => Promise<unknown>;
    seal: (dispatchId: string) => unknown;
  } {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const receipts = createWorkerExecutorReceipts(
      WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
      options,
    );
    const wrapped = receipts.wrap({ [DELETE]: handler })[DELETE];
    if (!wrapped) throw new Error('Missing wrapped handler');
    return {
      handler,
      receipts,
      run: (dispatchId) =>
        Promise.resolve(
          wrapped(
            { relativePath: dispatchId, _meta: { dispatchId } },
            {
              requestId: dispatchId,
              caller: CALLER,
              metadata: { dispatchId },
              signal: new AbortController().signal,
            },
          ),
        ),
      seal: (dispatchId) =>
        receipts.seal(CALLER.principalId, DELETE, dispatchId),
    };
  }

  it("leaves another peer's tagged dispatch and seal working when one peer exhausts its share", async () => {
    const { handler, run, seal } = receiptsFor({
      maxDispatchTagsPerPeer: 2,
      maxReplayedKeys: 100,
    });
    await expect(run(tagOf('a', 'one'))).resolves.toEqual(RESULT);
    expect(seal(tagOf('a', 'two'))).toEqual({ state: 'absent' });
    await expect(run(tagOf('a', 'three'))).rejects.toMatchObject(
      exhausted('peer'),
    );
    expect(seal(tagOf('a', 'four'))).toEqual({ state: 'forgotten' });
    await expect(run(tagOf('b', 'one'))).resolves.toEqual(RESULT);
    expect(seal(tagOf('b', 'two'))).toEqual({ state: 'absent' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('still refuses every peer once the worker-wide bound is reached', async () => {
    const { handler, run, seal } = receiptsFor({
      maxDispatchTagsPerPeer: 2,
      maxReplayedKeys: 3,
    });
    await run(tagOf('a', 'one'));
    await run(tagOf('a', 'two'));
    await run(tagOf('b', 'one'));
    await expect(run(tagOf('b', 'two'))).rejects.toMatchObject(
      exhausted('worker'),
    );
    await expect(run(tagOf('c', 'one'))).rejects.toMatchObject(
      exhausted('worker'),
    );
    expect(seal(tagOf('c', 'two'))).toEqual({ state: 'forgotten' });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('scopes a tag in three parts, naming the principal apart from its peer', () => {
    const a1 = peerScopedDispatchTag(
      { principalId: 'a', clientInstanceId: '1' },
      't',
    );
    const a2 = peerScopedDispatchTag(
      { principalId: 'a', clientInstanceId: '2' },
      't',
    );
    const b1 = peerScopedDispatchTag(
      { principalId: 'b', clientInstanceId: '1' },
      't',
    );
    expect(a1.split(':')).toHaveLength(4);
    expect(a1.split(':')[0]).toBe('peer');
    expect(dispatchTagScope(a1)).toEqual({
      principal: dispatchTagPrincipal('a'),
      peer: a1.split(':')[2],
    });
    // Two sessions of one principal share the principal, not the peer.
    expect(dispatchTagScope(a2)?.principal).toBe(
      dispatchTagScope(a1)?.principal,
    );
    expect(dispatchTagScope(a2)?.peer).not.toBe(dispatchTagScope(a1)?.peer);
    expect(dispatchTagScope(b1)?.principal).not.toBe(
      dispatchTagScope(a1)?.principal,
    );
  });

  it('refuses a tag the core did not scope, before it runs, in a dispatch, a seal and a lookup', async () => {
    const digest = 'A'.repeat(43);
    for (const raw of [
      't',
      'peer:t',
      `peer:${digest}`,
      // The earlier two-part form, which no released build sends.
      `peer:${digest}:${digest}`,
      `peer:${digest}:${digest}:${digest}:${digest}`,
      `peer:short:${digest}`,
      `peer:${digest}:${digest}:extra`,
      `key:${digest}:${digest}`,
    ]) {
      const { handler, receipts, run, seal } = receiptsFor({});
      await expect(run(raw)).rejects.toMatchObject(unscoped);
      expect(handler).not.toHaveBeenCalled();
      const thrown = (call: () => unknown): unknown => {
        try {
          call();
        } catch (error) {
          return error;
        }
        return 'returned';
      };
      expect(thrown(() => seal(raw))).toMatchObject(unscoped);
      expect(
        thrown(() =>
          receipts.lookup(CALLER.principalId, DELETE, { dispatchId: raw }),
        ),
      ).toMatchObject(unscoped);
    }
  });

  it('keeps a raw tag a caller picks under its own peer, as the desktop dispatcher composes them, so it neither exhausts nor collides with another peer', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const receipts = createWorkerExecutorReceipts(
      WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
      { maxDispatchTagsPerPeer: 2, maxReplayedKeys: 100 },
    );
    // desktop-runtime.ts: the tags are scoped before the worker's receipts.
    const dispatch = scopeForwardedDispatchTags(
      receipts.wrap({ [DELETE]: handler }),
    )[DELETE];
    if (!dispatch) throw new Error('Missing scoped handler');
    let key = 0;
    const send = (clientInstanceId: string, raw: string): Promise<unknown> => {
      key += 1;
      const metadata = { idempotencyKey: `key-${key}`, dispatchId: raw };
      return Promise.resolve(
        dispatch(
          { relativePath: raw, _meta: metadata },
          {
            requestId: `request-${key}`,
            caller: peer(clientInstanceId),
            metadata,
            signal: new AbortController().signal,
          },
        ),
      );
    };
    await expect(send('renderer-a', 'shared')).resolves.toEqual(RESULT);
    await expect(send('renderer-a', 'shared')).rejects.toMatchObject({
      payload: { kind: 'conflict', details: { receipt: 'tag-reused' } },
    });
    await expect(send('renderer-a', 'other')).resolves.toEqual(RESULT);
    await expect(send('renderer-a', 'third')).rejects.toMatchObject(
      exhausted('peer'),
    );
    // Renderer B picks the same raw tag A used, after A exhausted its share.
    await expect(send('renderer-b', 'shared')).resolves.toEqual(RESULT);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(
      receipts.lookup(CALLER.principalId, DELETE, {
        dispatchId: tagOf('renderer-b', 'shared'),
      }),
    ).toMatchObject({ state: 'settled' });
  });

  /**
   * Scoped dispatches as a host composes them (scope, then receipts), from
   * any principal and session.
   */
  function rotatingCallers(
    options: Parameters<typeof createWorkerExecutorReceipts>[1],
  ): {
    handler: jest.Mock<Promise<unknown>, []>;
    receipts: ReturnType<typeof createWorkerExecutorReceipts>;
    send: (
      principalId: string,
      session: string,
      raw: string,
    ) => Promise<unknown>;
  } {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const receipts = createWorkerExecutorReceipts(
      WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
      options,
    );
    const dispatch = scopeForwardedDispatchTags(
      receipts.wrap({ [DELETE]: handler }),
    )[DELETE];
    if (!dispatch) throw new Error('Missing scoped handler');
    let key = 0;
    return {
      handler,
      receipts,
      send: (principalId, session, raw) => {
        key += 1;
        const metadata = { idempotencyKey: `key-${key}`, dispatchId: raw };
        return Promise.resolve(
          dispatch(
            { relativePath: raw, _meta: metadata },
            {
              requestId: `request-${key}`,
              caller: { ...CALLER, principalId, clientInstanceId: session },
              metadata,
              signal: new AbortController().signal,
            },
          ),
        );
      },
    };
  }

  it('caps a principal across the peers it rotates through, leaving other principals working, when the host sets a principal bound', async () => {
    const { handler, send } = rotatingCallers({
      maxDispatchTagsPerPeer: 2,
      maxDispatchTagsForPrincipal: () => 4,
      maxReplayedKeys: 8,
    });
    for (const session of ['s1', 's2'])
      for (const raw of ['one', 'two'])
        await expect(send('renderer', session, raw)).resolves.toEqual(RESULT);
    // A fresh session of the same principal gets no fresh share.
    await expect(send('renderer', 's3', 'one')).rejects.toMatchObject(
      exhausted('principal'),
    );
    await expect(send('main-process', 'core', 'one')).resolves.toEqual(RESULT);
    await expect(send('other-renderer', 's1', 'one')).resolves.toEqual(RESULT);
    expect(handler).toHaveBeenCalledTimes(6);
  });

  const RENDERERS: ReadonlySet<string> = new Set(
    ['renderer:main', 'renderer:app-advisor'].map(dispatchTagPrincipal),
  );

  it('keeps a main-process peer dispatching and sealing once both bounded renderer principals are exhausted', async () => {
    // As the desktop bounds them: renderer principals only, together under
    // the run-wide bound.
    const { handler, receipts, send } = rotatingCallers({
      maxDispatchTagsPerPeer: 2,
      maxDispatchTagsForPrincipal: (principal) =>
        RENDERERS.has(principal) ? 4 : undefined,
      maxReplayedKeys: 12,
    });
    for (const renderer of ['renderer:main', 'renderer:app-advisor']) {
      for (const session of ['s1', 's2'])
        for (const raw of ['one', 'two'])
          await expect(send(renderer, session, raw)).resolves.toEqual(RESULT);
      await expect(send(renderer, 's3', 'one')).rejects.toMatchObject(
        exhausted('principal'),
      );
    }
    await expect(send('core', 'desktop-core', 'one')).resolves.toEqual(RESULT);
    expect(
      receipts.seal(
        'core',
        DELETE,
        peerScopedDispatchTag(
          { principalId: 'core', clientInstanceId: 'desktop-core' },
          'sealed',
        ),
      ),
    ).toEqual({ state: 'absent' });
    expect(handler).toHaveBeenCalledTimes(9);
  });

  it('without a principal bound, as the daemon runs, lets peer rotation reach the run-wide bound and refuse every principal', async () => {
    const { handler, send } = rotatingCallers({
      maxDispatchTagsPerPeer: 2,
      maxReplayedKeys: 8,
    });
    for (const session of ['s1', 's2', 's3', 's4'])
      for (const raw of ['one', 'two'])
        await expect(send('renderer', session, raw)).resolves.toEqual(RESULT);
    await expect(send('main-process', 'core', 'one')).rejects.toMatchObject(
      exhausted('worker'),
    );
    expect(handler).toHaveBeenCalledTimes(8);
  });

  it('refuses an unscoped tag that reaches a worker through its binding, runs a scoped one, and names the bound it refuses past', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const receipts = createWorkerExecutorReceipts(
      WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
      { maxDispatchTagsPerPeer: 1, maxDispatchTagsForPrincipal: () => 2 },
    );
    const definitions = {
      queries: {},
      instructions: {
        [DELETE]: WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS[DELETE],
      },
      streams: {},
    };
    const pair = serializingWorkerPair();
    const binding = createInProcessWorkerBinding({
      dispatcher: createCanopyDispatcher({
        profile: 'worker',
        definitions,
        handlers: {
          queries: {},
          instructions: receipts.wrap({ [DELETE]: handler }),
          streams: {},
        },
      }),
      definitions,
      caller: CALLER,
      pair,
      receipts,
    });
    const deleteParams = (meta: {
      idempotencyKey: string;
      dispatchId: string;
    }): WorkerFilesystemEntryDeleteParams => ({
      scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
      fileRootId: 'root',
      relativePath: 'file',
      expectedVersion: null,
      recursive: false,
      disposition: 'permanent',
      _meta: meta,
    });
    const send = (meta: {
      idempotencyKey: string;
      dispatchId: string;
    }): Promise<unknown> =>
      binding.instruction(DELETE, deleteParams(meta), {
        metadata: meta,
      });
    try {
      await expect(
        send({ idempotencyKey: 'raw', dispatchId: 't' }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          message: 'This dispatch tag was not scoped to a caller by the core.',
          retry: { kind: 'never' },
        },
      });
      expect(handler).not.toHaveBeenCalled();
      await expect(
        send({ idempotencyKey: 'scoped', dispatchId: tagOf('a', 't') }),
      ).resolves.toEqual(RESULT);
      expect(handler).toHaveBeenCalledTimes(1);
      // The binding carries kind, message and retry, never details, so the
      // message alone tells the caller which bound refused it.
      await expect(
        send({ idempotencyKey: 'second', dispatchId: tagOf('a', 'u') }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'resource_exhausted',
          message: BOUND_MESSAGES.peer,
          retry: { kind: 'never' },
        },
      });
      expect(handler).toHaveBeenCalledTimes(1);
      // The binding's caller is one principal: a second peer's tag fills its
      // share, and a third peer's is refused with the principal's message.
      await expect(
        send({ idempotencyKey: 'peer-b', dispatchId: tagOf('b', 't') }),
      ).resolves.toEqual(RESULT);
      await expect(
        send({ idempotencyKey: 'peer-c', dispatchId: tagOf('c', 't') }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'resource_exhausted',
          message: BOUND_MESSAGES.principal,
          retry: { kind: 'never' },
        },
      });
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      binding.close();
      pair.client.close();
    }
  });
});
