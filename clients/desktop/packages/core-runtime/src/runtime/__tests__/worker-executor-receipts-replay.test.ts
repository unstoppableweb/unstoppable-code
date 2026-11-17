/** CAN-4733: a replayed key never reaches its handler twice, however its receipt ends. */
import {
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { keyedInstructionReplay } from '../../kernel/keyed-instruction-fingerprint';
import { CanopyOperationError } from '../errors';
import type { CanopyHandlerContext } from '../types';
import { createWorkerExecutorReceipts } from '../worker-executor-receipts';

const OPERATION = 'worker.filesystem.entry.delete';
const RESULT = { deleted: true, deletedEntryCount: 1, disposition: 'trash' };
const CALLER: CanopyCallerDescriptor = {
  principalId: 'worker-caller',
  clientInstanceId: 'bundled-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: [],
};

function params(relativePath: string): Record<string, unknown> {
  return { relativePath, _meta: { idempotencyKey: 'ignored' } };
}

function context(
  idempotencyKey: string,
  signal: AbortSignal = new AbortController().signal,
): CanopyHandlerContext {
  return {
    requestId: idempotencyKey,
    caller: CALLER,
    metadata: { idempotencyKey },
    signal,
  };
}

function receiptsWith(
  options: Parameters<typeof createWorkerExecutorReceipts>[1],
  handler: () => Promise<unknown>,
): {
  run: (path: string, key: string, signal?: AbortSignal) => Promise<unknown>;
  release: (key: string) => void;
} {
  const receipts = createWorkerExecutorReceipts(
    WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
    { replay: keyedInstructionReplay(new Set([OPERATION])), ...options },
  );
  const wrapped = receipts.wrap({ [OPERATION]: handler })[OPERATION];
  if (!wrapped) throw new Error('Missing wrapped handler');
  return {
    run: async (path, key, signal) =>
      await wrapped(params(path), context(key, signal)),
    release: (key) => receipts.release(CALLER.principalId, OPERATION, key),
  };
}

const refusedAs = (receipt: string): object => ({
  payload: { details: { receipt }, retry: { kind: 'never' } },
});

describe('worker executor receipt replay (CAN-4733)', () => {
  it('replays a settled key without running it again', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const { run } = receiptsWith({}, handler);
    await expect(run('a', 'k')).resolves.toEqual(RESULT);
    await expect(run('a', 'k')).resolves.toEqual(RESULT);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('joins a running key instead of running it again', async () => {
    let finish: () => void = () => undefined;
    const handler = jest.fn(
      (): Promise<unknown> =>
        new Promise((resolve) => {
          finish = (): void => resolve(RESULT);
        }),
    );
    const { run } = receiptsWith({}, handler);
    const first = run('a', 'k');
    const second = run('a', 'k');
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await expect(first).resolves.toEqual(RESULT);
    await expect(second).resolves.toEqual(RESULT);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses a key reused for other parameters', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const { run } = receiptsWith({}, handler);
    await run('a', 'k');
    await expect(run('b', 'k')).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        details: { receipt: 'key-reused' },
        retry: { kind: 'never' },
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('replays a settled failure with retry never', async () => {
    const handler = jest.fn(
      (): Promise<unknown> =>
        Promise.reject(
          new CanopyOperationError({
            kind: 'unavailable',
            message: 'Unconfirmed.',
            retry: { kind: 'same_idempotency_key' },
          }),
        ),
    );
    const { run } = receiptsWith({}, handler);
    await expect(run('a', 'k')).rejects.toBeInstanceOf(CanopyOperationError);
    await expect(run('a', 'k')).rejects.toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'never' } },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses an evicted key and never runs it again, however many keys follow', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const { run } = receiptsWith({ max: 1, maxReplayedKeys: 8 }, handler);
    for (const key of ['k1', 'k2', 'k3']) await run(key, key);
    for (const key of ['k1', 'k2'])
      await expect(run(key, key)).rejects.toMatchObject(
        refusedAs('not-retained'),
      );
    await expect(run('k3', 'k3')).resolves.toEqual(RESULT);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('refuses a released key instead of running it again', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const { run, release } = receiptsWith({}, handler);
    await run('a', 'k');
    release('k');
    await expect(run('a', 'k')).rejects.toMatchObject(
      refusedAs('not-retained'),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fails closed past the replayed-key bound instead of forgetting an old key', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const { run } = receiptsWith({ max: 1, maxReplayedKeys: 2 }, handler);
    await run('k1', 'k1');
    await run('k2', 'k2');
    await expect(run('k3', 'k3')).rejects.toMatchObject({
      payload: {
        kind: 'resource_exhausted',
        details: { receipt: 'keys-exhausted' },
        retry: { kind: 'never' },
      },
    });
    await expect(run('k1', 'k1')).rejects.toMatchObject(
      refusedAs('not-retained'),
    );
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('replays a result beyond the bounded receipt and forgets the oldest past the result budget', async () => {
    const CREATE = 'worker.filesystem.directory.create';
    const big = {
      fileRootId: 'root',
      relativePath: 'deep',
      createdParentPaths: Array.from(
        { length: 2_000 },
        (_, index) => `parent/${String(index).padStart(12, '0')}`,
      ),
      version: '0:0',
    };
    expect(JSON.stringify(big).length).toBeGreaterThan(32_768);
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(big));
    const receipts = createWorkerExecutorReceipts(
      WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
      {
        replay: keyedInstructionReplay(new Set([CREATE])),
        maxReplayResults: 100_000,
      },
    );
    const create = receipts.wrap({ [CREATE]: handler })[CREATE];
    if (!create) throw new Error('Missing wrapped handler');
    const run = async (key: string): Promise<unknown> =>
      await create(params(key), context(key));
    await run('k1');
    await expect(run('k1')).resolves.toEqual(big);
    await run('k2');
    await run('k3');
    await expect(run('k1')).rejects.toMatchObject(refusedAs('not-retained'));
    await expect(run('k3')).resolves.toEqual(big);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('stops a waiting repeat on its own abort and leaves the first request running', async () => {
    let finish: () => void = () => undefined;
    const handler = jest.fn(
      (): Promise<unknown> =>
        new Promise((resolve) => {
          finish = (): void => resolve(RESULT);
        }),
    );
    const { run } = receiptsWith({}, handler);
    const first = run('a', 'k');
    const abort = new AbortController();
    const second = run('a', 'k', abort.signal);
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await expect(second).rejects.toMatchObject({
      payload: { kind: 'cancelled', retry: { kind: 'same_idempotency_key' } },
    });
    finish();
    await expect(first).resolves.toEqual(RESULT);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('leaves operations outside the replay set running a repeated key as before', async () => {
    const handler = jest.fn((): Promise<unknown> => Promise.resolve(RESULT));
    const receipts = createWorkerExecutorReceipts(
      WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
    );
    const wrapped = receipts.wrap({ [OPERATION]: handler })[OPERATION];
    if (!wrapped) throw new Error('Missing wrapped handler');
    await wrapped(params('a'), context('k'));
    await wrapped(params('b'), context('k'));
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
