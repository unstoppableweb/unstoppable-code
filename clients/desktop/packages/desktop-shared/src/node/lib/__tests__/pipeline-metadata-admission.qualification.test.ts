import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateAdmittedWriter,
  STORAGE_OWNERSHIP,
} from '@canopy/core-runtime/storage';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';
import {
  admittedStorageRowForPath,
  isAdmittedStorageCandidate,
} from '@canopy/execution-engine/node/lib/admitted-storage-paths';

let root = '';
const metadataModule = 'main/pipelines/pipeline-local-metadata-store';
const namespace = 'pipeline_local_metadata';

function caught(operation: () => void): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pipeline-metadata-admission-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it('refuses a synchronous write of an admitted row without its writer', () => {
  const file = join(root, 'pipeline-local-metadata.json');
  writeFileSync(file, 'original');
  expect(
    caught(() => writeFileAtomicallySync(file, 'replacement')),
  ).toMatchObject({
    name: 'StorageWriteRefusedError',
    namespaceId: namespace,
    reason: 'unadmitted_writer',
  });
  expect(readFileSync(file, 'utf8')).toBe('original');
});

it('lets an admitted module write a row synchronously', () => {
  const file = join(root, 'pipeline-local-metadata.json');
  writeFileAtomicallySync(file, 'owner metadata', {
    admittedWriter: {
      namespace,
      writer: 'electron_main',
      module: metadataModule,
    },
  });
  expect(readFileSync(file, 'utf8')).toBe('owner metadata');
});

it('refuses a synchronous metadata write from another module', () => {
  const file = join(root, 'pipeline-local-metadata.json');
  expect(
    caught(() =>
      writeFileAtomicallySync(file, 'replacement', {
        admittedWriter: {
          namespace,
          writer: 'electron_main',
          module: 'main/pipelines/other-store',
        },
      }),
    ),
  ).toMatchObject({
    name: 'StorageWriteRefusedError',
    reason: 'unadmitted_writer',
  });
});

it('classifies the metadata file under its data root and by shape for sync writes', () => {
  const file = join(root, 'pipeline-local-metadata.json');
  expect(isAdmittedStorageCandidate(file)).toBe(true);
  expect(admittedStorageRowForPath(file, root)).toBe(namespace);
  expect(admittedStorageRowForPath(file, null)).toBe(namespace);
  expect(
    admittedStorageRowForPath(
      join(root, 'nested', 'pipeline-local-metadata.json'),
      root,
    ),
  ).toBeUndefined();
});

it('admits only the metadata store under its current writer principal', () => {
  expect(
    evaluateAdmittedWriter(
      namespace,
      'electron_main',
      metadataModule,
      STORAGE_OWNERSHIP,
    ),
  ).toEqual({ allowed: true });
  expect(
    evaluateAdmittedWriter(
      namespace,
      'electron_main',
      'main/pipelines/other-store',
      STORAGE_OWNERSHIP,
    ),
  ).toEqual({ allowed: false, reason: 'unadmitted_writer' });
});
