import { dirname } from 'node:path';
import { worktreeListProcessLock } from '@canopy/core-platform/w5-process-file-lock';
import { parentPort, workerData } from 'node:worker_threads';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { windowsW5ConfinedFileReader } from '@canopy/core-platform/w5-confined-read';
import { createNodeW5Durability } from '@canopy/core-runtime/node/w5/commit-log/node-durability';
import { runW5CommitLogWorker } from '@canopy/core-runtime/node/w5/commit-log/worker';
import { isDaemonW5CommitLogWorkerData } from './w5-commit-log-worker-data';

// The daemon's W5 commit log worker entry, bundled beside the host executable
// as w5-commit-log-worker.js; only w5-host.ts starts it. On win32 it reads
// captures through the owned-child addon the host names, as the desktop
// worker does (CAN-5530); without one that loads, capture refuses rather
// than read unconfined. Folder flushes are the desktop's: a refused one
// fails closed (CAN-5153).
const port = parentPort;
if (port === null)
  throw new Error('The W5 commit log worker must run in a worker thread');
const data: unknown = workerData;
const valid = isDaemonW5CommitLogWorkerData(data);
const os = hostOperatingSystem();
// Worker data with a malformed addon reaches the body as no data at all, so
// it refuses its configuration rather than read unconfined.
void runW5CommitLogWorker(port, valid ? data : undefined, {
  durability: createNodeW5Durability(os, {
    flushDirectory: (folder) => flushDirectory(folder, { os }),
  }),
  os,
  ...(valid
    ? {
        processLock: worktreeListProcessLock(
          data.dataRoot ?? dirname(data.root),
        ),
      }
    : {}),
  confinedReader: windowsW5ConfinedFileReader(
    os,
    valid ? data.confinementAddon : undefined,
  ),
});
