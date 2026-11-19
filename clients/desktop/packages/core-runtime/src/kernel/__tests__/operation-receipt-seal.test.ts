/** CAN-4733: a seal makes absent final for a worker run; a lookup stays a pure read. */
import {
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { LocalWorkerBindingClient } from '../../runtime/local-worker-binding-client';
import { createSupervisedLocalWorker } from '../../runtime/supervised-local-worker';
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

function tagged(
  dispatchId: string,
  signal: AbortSignal = new AbortController().signal,
): CanopyHandlerContext {
  return {
    requestId: dispatchId,
    caller: CALLER,
    metadata: { idempotencyKey: `key-${dispatchId}`, dispatchId },
    signal,
  };
}

function params(dispatchId: string): Record<string, unknown> {
  return {
    relativePath: dispatchId,
    _meta: { idempotencyKey: `key-${dispatchId}`, dispatchId },
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
    const seal = (): unknown => receipts.seal(CALLER.principalId, DELETE, 't');
    expect(seal()).toEqual({ state: 'absent' });
    expect(seal()).toEqual({ state: 'absent' });
    await expect(run('t')).rejects.toMatchObject(notStarted);
    expect(handler).not.toHaveBeenCalled();
    expect(seal()).toEqual({ state: 'absent' });
    expect(
      receipts.lookup(CALLER.principalId, DELETE, { dispatchId: 't' }),
    ).toEqual({ state: 'absent' });
  });

  it('keeps a lookup a pure read: a tag looked up first still runs once', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const { receipts, run } = receiptsWith(handler);
    expect(
      receipts.lookup(CALLER.principalId, DELETE, { dispatchId: 't' }),
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
    expect(receipts.seal(CALLER.principalId, DELETE, 't')).toEqual({
      state: 'running',
    });
    for (let tick = 0; tick < 10 && handler.mock.calls.length === 0; tick += 1)
      await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    finish(RESULT);
    await expect(running).resolves.toEqual(RESULT);
    expect(receipts.seal(CALLER.principalId, DELETE, 't')).toEqual({
      state: 'settled',
      outcome: { status: 'completed', result: RESULT },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('answers forgotten past the tag bound and seals nothing', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const { receipts, run } = receiptsWith(handler, { maxReplayedKeys: 2 });
    expect(receipts.seal(CALLER.principalId, DELETE, 'sealed')).toEqual({
      state: 'absent',
    });
    await run('first');
    expect(receipts.seal(CALLER.principalId, DELETE, 'late')).toEqual({
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
          dispatchId: 't',
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
        dispatchId: 't',
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
