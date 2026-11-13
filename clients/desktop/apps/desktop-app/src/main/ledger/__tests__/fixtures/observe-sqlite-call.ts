import { StatementSync } from 'node:sqlite';
import { MessagePort, workerData } from 'node:worker_threads';

// Preloaded after tsx, before the real storage worker opens its connection.
const data: unknown = workerData;
if (
  typeof data !== 'object' ||
  data === null ||
  !('sqliteCallState' in data) ||
  !(data.sqliteCallState instanceof Int32Array) ||
  !('sqlitePausePort' in data) ||
  !(data.sqlitePausePort instanceof MessagePort)
) {
  throw new Error('Missing SQLite call observer');
}
const state = data.sqliteCallState;
const pausePort = data.sqlitePausePort;
const methods = Object.getOwnPropertyDescriptors(StatementSync.prototype);
const nativeGet = methods.get.value;
if (nativeGet === undefined) {
  throw new Error('Missing native SQLite statement methods');
}

// Slot 0 marks the entry INSERT/get window; slot 1 arms its return barrier.
// The host snapshots slot 0 synchronously in terminate().
StatementSync.prototype.get = new Proxy(nativeGet, {
  apply(get, statement: StatementSync, args: unknown[]): unknown {
    const observed = statement.sourceSQL.startsWith(
      'INSERT INTO ledger_entries ',
    );
    if (observed) Atomics.store(state, 0, 1);
    try {
      const result: unknown = Reflect.apply(get, statement, args);
      if (observed && Atomics.load(state, 1) === 1) {
        // Hold the uncommitted INSERT's wrapper until the host terminates us.
        pausePort.postMessage('entry-insert-paused');
        Atomics.wait(state, 1, 1);
      }
      return result;
    } finally {
      if (observed) Atomics.store(state, 0, 0);
    }
  },
});
