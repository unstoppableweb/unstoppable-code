import {
  CLOUD_ACCOUNT_OPERATION_QUEUE_TIMEOUT_MS,
  CloudAccountOperationQueue,
  CloudAccountOperationQueueTimeoutError,
  CloudAccountPublisher,
  CloudAccountReadCache,
  CloudAccountSessionStatus,
} from '..';

interface Entry {
  key: string;
  tags: string[];
}

const clone = (entry: Entry): Entry => ({ ...entry, tags: [...entry.tags] });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('cloud account operation queue', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('runs operations one at a time, in arrival order', async () => {
    const queue = new CloudAccountOperationQueue();
    const order: string[] = [];
    const gate = deferred();
    const first = queue.run(async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    const second = queue.run((): Promise<void> => {
      order.push('second');
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('releases the queue when an operation throws', async () => {
    const queue = new CloudAccountOperationQueue();
    await expect(
      queue.run(() => Promise.reject(new Error('write failed'))),
    ).rejects.toThrow('write failed');
    await expect(queue.run(() => Promise.resolve('next'))).resolves.toBe(
      'next',
    );
  });

  it('arms one setTimeout per waiter and clears it when the waiter gets its turn', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
    const queue = new CloudAccountOperationQueue();
    const gate = deferred();
    const first = queue.run(() => gate.promise);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    const second = queue.run(() => Promise.resolve('second'));
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(
      CLOUD_ACCOUNT_OPERATION_QUEUE_TIMEOUT_MS,
    );
    gate.resolve();
    await first;
    await expect(second).resolves.toBe('second');
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects a waiter that cannot start within 30 s and skips it afterwards', async () => {
    jest.useFakeTimers();
    const queue = new CloudAccountOperationQueue();
    const gate = deferred();
    const first = queue.run(() => gate.promise);
    const waiting = jest.fn(() => Promise.resolve());
    const timedOut = queue.run(waiting);
    const rejection = expect(timedOut).rejects.toMatchObject({
      name: 'AccountOperationQueueTimeoutError',
      message: 'Timed out waiting for another account operation to finish.',
    });
    jest.advanceTimersByTime(CLOUD_ACCOUNT_OPERATION_QUEUE_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(waiting).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await rejection;
    await expect(timedOut).rejects.toBeInstanceOf(
      CloudAccountOperationQueueTimeoutError,
    );
    gate.resolve();
    await first;
    expect(waiting).not.toHaveBeenCalled();
    await expect(queue.run(() => Promise.resolve('free'))).resolves.toBe(
      'free',
    );
  });
});

describe('cloud account read cache', () => {
  it('serves clones for 5 s, only for the backend it was read under', () => {
    let now = 1_000;
    const cache = new CloudAccountReadCache(clone, { now: (): number => now });
    expect(cache.get('keychain')).toBeUndefined();
    const entry = { key: 'k1', tags: ['a'] };
    cache.set(entry, 'keychain');
    entry.tags.push('mutated');
    const first = cache.get('keychain');
    expect(first).toEqual({ key: 'k1', tags: ['a'] });
    first?.tags.push('mutated');
    expect(cache.get('keychain')).toEqual({ key: 'k1', tags: ['a'] });
    expect(cache.get('basic-text')).toBeUndefined();
    now += 4_999;
    expect(cache.get('keychain')).toEqual({ key: 'k1', tags: ['a'] });
    now += 1;
    expect(cache.get('keychain')).toBeUndefined();
    expect(cache.peek()).toEqual({ key: 'k1', tags: ['a'] });
  });

  it('holds a confirmed sign-out as null and forgets everything on invalidate', () => {
    const cache = new CloudAccountReadCache(clone, { now: (): number => 0 });
    cache.set(null, 'keychain');
    expect(cache.get('keychain')).toBeNull();
    expect(cache.peekHeld()).toBeNull();
    cache.invalidate();
    expect(cache.get('keychain')).toBeUndefined();
    expect(cache.peekHeld()).toBeUndefined();
    expect(cache.peek()).toBeNull();
  });
});

describe('cloud account publisher', () => {
  it('gives every listener its own clone and isolates listener failures', () => {
    const publisher = new CloudAccountPublisher(clone);
    const seen: Array<Entry | null> = [];
    publisher.addChangeListener((entry) => {
      entry?.tags.push('mutated');
      throw new Error('listener failed');
    });
    const stop = publisher.addChangeListener((entry) => seen.push(entry));
    publisher.notify({ key: 'k1', tags: ['a'] });
    expect(seen).toEqual([{ key: 'k1', tags: ['a'] }]);
    stop();
    publisher.notify(null);
    expect(seen).toHaveLength(1);
  });

  it('rethrows the first listener failure only from notifyOrThrow, after notifying all', () => {
    const publisher = new CloudAccountPublisher(clone);
    const seen: Array<Entry | null> = [];
    publisher.addChangeListener(() => {
      throw new Error('first');
    });
    publisher.addChangeListener(() => {
      throw new Error('second');
    });
    publisher.addChangeListener((entry) => seen.push(entry));
    expect(() => publisher.notifyOrThrow(null)).toThrow('first');
    expect(seen).toEqual([null]);
    expect(() => publisher.notify(null)).not.toThrow();
  });

  it('notifies confirmations separately from changes', () => {
    const publisher = new CloudAccountPublisher(clone);
    const changes = jest.fn();
    const confirmations = jest.fn(() => {
      throw new Error('ignored');
    });
    publisher.addChangeListener(changes);
    publisher.addConfirmationListener(confirmations);
    publisher.notifyConfirmation();
    expect(confirmations).toHaveBeenCalledTimes(1);
    expect(changes).not.toHaveBeenCalled();
  });
});

describe('cloud account session status', () => {
  const status = (): CloudAccountSessionStatus<Entry, string> =>
    new CloudAccountSessionStatus<Entry, string>(
      (entry) => (entry.key ? entry.key : null),
      (left, right) => left === right,
    );

  it('records only the newest current probe and expires the rejected credential', () => {
    const tracker = status();
    const changes = jest.fn();
    tracker.addListener(changes);
    const entry = { key: 'k1', tags: [] };
    const older = tracker.begin();
    const newer = tracker.begin();
    tracker.record(newer, entry, 'rejected');
    expect(tracker.isExpired(entry)).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(tracker.isSuperseded(older)).toBe(true);
    tracker.record(older, entry, 'accepted');
    expect(tracker.isExpired(entry)).toBe(true);
    expect(tracker.isExpired({ key: 'k2', tags: [] })).toBe(false);
  });

  it('supersedes in-flight probes and clears expiry when the credential resets', () => {
    const tracker = status();
    const changes = jest.fn();
    tracker.addListener(changes);
    const entry = { key: 'k1', tags: [] };
    tracker.record(tracker.begin(), entry, 'rejected');
    const inFlight = tracker.begin();
    tracker.resetCredential();
    expect(tracker.isExpired(entry)).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(tracker.isCurrent(inFlight)).toBe(false);
    expect(tracker.isSuperseded(inFlight)).toBe(true);
    tracker.record(inFlight, entry, 'rejected');
    expect(tracker.isExpired(entry)).toBe(false);
  });

  it('ignores probes for a record that cannot be identified', () => {
    const tracker = status();
    tracker.record(tracker.begin(), { key: '', tags: [] }, 'rejected');
    expect(tracker.isExpired({ key: '', tags: [] })).toBe(false);
  });
});
