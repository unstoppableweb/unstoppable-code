import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resourceLimits } from 'node:worker_threads';
import { connectExecutionHostChannel } from '../../execution-host/channel';

// A host for the port suite, bundled and launched under plain Node. Each
// request exercises one host behavior over the real channel.

const channel = connectExecutionHostChannel();
if (!channel) throw new Error('Launched without an execution host channel.');

process.stdout.write('not a frame\n');

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined;

const retained: unknown[] = [];

function exhaust(memory: unknown): void {
  // Synchronous on purpose: the budget must hold while the event loop of the
  // thread running the entry is blocked.
  for (;;) {
    // Small objects stay in the old generation the sampled heap limit
    // watches; large arrays would go to large-object space and grow the
    // resident set first.
    if (memory === 'heap')
      for (let index = 0; index < 4096; index += 1)
        retained.push({ index, value: `${index}` });
    else retained.push(Buffer.alloc(32 * 1024 * 1024, 1));
  }
}

channel.on('message', ({ data }) => {
  const type = field(data, 'type');
  if (type === 'exhaust') exhaust(field(data, 'memory'));
  if (type === 'writer') {
    const db = new DatabaseSync(String(field(data, 'path')));
    db.exec(
      'PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (x); INSERT INTO t VALUES (1);',
    );
    retained.push(db);
    channel.postMessage({ type: 'writer' });
  }
  if (type === 'heap-limit')
    channel.postMessage({
      type: 'heap-limit',
      oldGenerationMb: resourceLimits.maxOldGenerationSizeMb,
    });
  if (type === 'echo') {
    channel.postMessage({ type: 'echo', value: field(data, 'value') });
  } else if (type === 'structured') {
    channel.postMessage({
      map: new Map([['a', 1]]),
      date: new Date(0),
      bytes: Buffer.from([0, 255]),
      big: BigInt(10),
      missing: undefined,
    });
  } else if (type === 'burst') {
    const count = Number(field(data, 'count'));
    const payload = 'x'.repeat(Number(field(data, 'size')));
    for (let index = 0; index < count; index += 1)
      channel.postMessage({ type: 'chunk', index, payload });
    channel.postMessage({ type: 'done' });
    channel.exit(0);
  } else if (type === 'grandchild') {
    // win32 children of a Node child die with its libuv job unless detached;
    // detached they still stay in the owned job. On POSIX detached would
    // leave the owned process group.
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1 << 30)'],
      { stdio: 'ignore', detached: process.platform === 'win32' },
    );
    child.unref();
    channel.postMessage({ type: 'grandchild', pid: child.pid });
  } else if (type === 'crash') {
    process.kill(process.pid, 'SIGKILL');
  } else if (type === 'exit') {
    channel.exit(Number(field(data, 'code')));
  }
});
