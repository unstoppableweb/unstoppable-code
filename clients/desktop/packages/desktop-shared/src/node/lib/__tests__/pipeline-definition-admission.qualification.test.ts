import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomicallySync } from '@canopy/execution-engine/node/lib/atomic-file';
import {
  admittedStorageRowForPath,
  isAdmittedStorageCandidate,
} from '@canopy/execution-engine/node/lib/admitted-storage-paths';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pipeline-definition-admission-'));
  mkdirSync(join(root, 'pipelines'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('refuses a synchronous write to a pipeline document from another module', () => {
  const file = join(root, 'pipelines', 'abc-123.yaml');
  writeFileSync(file, 'original');
  let failure: unknown;
  try {
    writeFileAtomicallySync(file, 'replacement');
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    name: 'StorageWriteRefusedError',
    reason: 'unadmitted_writer',
    namespaceId: 'pipeline_definitions',
  });
  expect(readFileSync(file, 'utf8')).toBe('original');
});

it('classifies only the exact pipeline definition directory and file shapes', () => {
  for (const suffix of [
    'pipelines',
    'pipelines/index.json',
    'pipelines/index.json.damaged-1793700000000',
    'pipelines/abc-123.yaml',
    'pipelines/.project-share-links.json',
  ]) {
    const file = join(root, suffix);
    expect(admittedStorageRowForPath(file, root)).toBe('pipeline_definitions');
    expect(admittedStorageRowForPath(file, null)).toBe('pipeline_definitions');
    expect(isAdmittedStorageCandidate(file)).toBe(true);
  }
  for (const suffix of [
    'pipelines/nested/x.yaml',
    'other/index.json',
    'pipelines/index.json.tmp',
    'pipelines/x.yml',
    'index.json',
  ]) {
    expect(admittedStorageRowForPath(join(root, suffix), root)).toBeUndefined();
    expect(isAdmittedStorageCandidate(join(root, suffix))).toBe(false);
  }
  expect(
    admittedStorageRowForPath(join(root, 'other/pipelines/x.yaml'), root),
  ).toBeUndefined();
});

it('admits the store principal and refuses a different module', () => {
  const file = join(root, 'pipelines', 'abc-123.yaml');
  writeFileAtomicallySync(file, 'stored', {
    admittedWriter: {
      namespace: 'pipeline_definitions',
      writer: 'desktop_cli',
      module: 'packages/execution-engine/src/pipelines/store.ts',
    },
  });
  expect(readFileSync(file, 'utf8')).toBe('stored');
  let failure: unknown;
  try {
    writeFileAtomicallySync(file, 'other', {
      admittedWriter: {
        namespace: 'pipeline_definitions',
        writer: 'desktop_cli',
        module: 'shared/pipelines/other-store',
      },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    name: 'StorageWriteRefusedError',
    reason: 'unadmitted_writer',
  });
  expect(readFileSync(file, 'utf8')).toBe('stored');
});
