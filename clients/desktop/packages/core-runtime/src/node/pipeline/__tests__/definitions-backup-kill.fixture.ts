import { readFileSync } from 'node:fs';

import { validateNamespaceBackupRecord } from '../../../storage/backup-record';
import { restorePipelineDefinitionsBackup } from '../store/definitions-backup';
import {
  FLIP_READY,
  recordingLock,
  strictFlush,
} from './definitions-backup-fixtures';

/*
 * One restore in its own process, killed with SIGKILL right after its
 * `killAt`-th folder flush returns (CAN-5340).
 *
 *   definitions-backup-kill.fixture.ts <dataRoot> <recordsFile> <killAt> [accept]
 */

const [dataRoot, recordsFile, boundary, accept] = process.argv.slice(2);
const killAt = Number(boundary);
if (!dataRoot || !recordsFile || !Number.isInteger(killAt) || killAt < 1)
  throw new Error('Expected a data root, a records file and a boundary.');

const parsed: unknown = JSON.parse(readFileSync(recordsFile, 'utf8'));
if (!Array.isArray(parsed)) throw new Error('Expected a records array.');
const records = parsed.map((candidate: unknown) => {
  const result = validateNamespaceBackupRecord(candidate, {
    rows: FLIP_READY,
    isOutsideCheckouts: () => true,
  });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.record;
});

let flushes = 0;
restorePipelineDefinitionsBackup(records, {
  dataRoot,
  isOutsideCheckouts: () => true,
  syncDirectory: async (path) => {
    const flushed = await strictFlush(path);
    flushes += 1;
    if (flushes === killAt) process.kill(process.pid, 'SIGKILL');
    return flushed;
  },
  flushRequiresWriteHandle: false,
  quiesce: (operation) => operation(),
  lock: recordingLock(),
  ownership: FLIP_READY,
  ...(accept === 'accept'
    ? { acceptNewerLoss: { confirmedBy: 'person', log: (): void => undefined } }
    : {}),
}).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  },
);
