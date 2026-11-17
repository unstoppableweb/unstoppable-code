import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { createNodeW5Durability } from '@canopy/core-runtime/node/w5/commit-log/node-durability';
import { runW5CommitLogWorker } from '@canopy/core-runtime/node/w5/commit-log/worker';

// The W5 commit log worker body over real files, whose durable writes wait
// while the test's gate file, `write-gate` beside the database, exists
// (CAN-5589): a commit is then held after its log row is committed and
// before its files are written. Reaching the gate writes `<gate>.reached`.
const data: unknown = workerData;
const dbPath: unknown =
  typeof data === 'object' && data !== null
    ? Reflect.get(data, 'dbPath')
    : undefined;
const gate =
  typeof dbPath === 'string' ? join(dirname(dbPath), 'write-gate') : undefined;
const real = createNodeW5Durability(process.platform);
const port = parentPort;
if (port === null) throw new Error('Must run in a worker thread');

async function passGate(): Promise<void> {
  if (gate === undefined || !existsSync(gate)) return;
  writeFileSync(`${gate}.reached`, '');
  while (existsSync(gate))
    await new Promise((resolve) => setTimeout(resolve, 5));
}

void runW5CommitLogWorker(port, data, {
  durability: {
    syncDirectory: real.syncDirectory,
    writeFileDurably: async (path, contents) => {
      await passGate();
      await real.writeFileDurably(path, contents);
    },
  },
  os: process.platform,
});
