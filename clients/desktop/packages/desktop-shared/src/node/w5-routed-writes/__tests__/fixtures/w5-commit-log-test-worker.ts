import { dirname } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { windowsW5ConfinedFileReader } from '@canopy/core-platform/w5-confined-read';
import { worktreeListProcessLock } from '@canopy/core-platform/w5-process-file-lock';
import {
  isW5CommitLogWorkerData,
  type W5CommitLogHostWorkerData,
} from '@canopy/core-runtime/node/w5/commit-log/worker-contract';
import { parentPort, workerData } from 'node:worker_threads';
import { createNodeW5Durability } from '@canopy/core-runtime/node/w5/commit-log/node-durability';
import { runW5CommitLogWorker } from '@canopy/core-runtime/node/w5/commit-log/worker';

function isTestW5CommitLogWorkerData(
  value: unknown,
): value is W5CommitLogHostWorkerData {
  if (!isW5CommitLogWorkerData(value)) return false;
  const addon: unknown = Reflect.get(
    value,
    'confinementAddon' satisfies keyof W5CommitLogHostWorkerData,
  );
  return addon === undefined || typeof addon === 'string';
}

// The portable worker with Node durability and production Windows confinement.
const port = parentPort;
if (port === null)
  throw new Error('The W5 commit log worker must run in a worker thread');
const data: unknown = workerData;
const valid = isTestW5CommitLogWorkerData(data);
const os = hostOperatingSystem();
void runW5CommitLogWorker(port, valid ? data : undefined, {
  ...(valid
    ? {
        processLock: worktreeListProcessLock(
          data.dataRoot ?? dirname(data.root),
        ),
      }
    : {}),
  durability: createNodeW5Durability(os),
  os,
  confinedReader: windowsW5ConfinedFileReader(
    os,
    valid ? data.confinementAddon : undefined,
  ),
});
