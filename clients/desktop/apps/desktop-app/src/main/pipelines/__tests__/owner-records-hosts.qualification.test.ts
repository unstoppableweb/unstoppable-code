import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

let mockRoot = '';
jest.mock('../../lib/paths', () => ({
  getPipelineDefinitionReplaysFilePath: (): string =>
    `${mockRoot}/pipeline-definition-replays.json`,
}));

import { StorageRowOwnerError } from '@canopy/core-runtime/node/pipeline/store';
import { STORAGE_OWNERSHIP } from '@canopy/core-runtime/storage/storage-ownership.generated';
import * as pipelinePaths from '@canopy/execution-engine/pipelines/config-paths';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import {
  deleteStoredPipeline,
  saveStoredPipeline,
  withStoredPipelineWriter,
} from '@canopy/execution-engine/pipelines/store';
import { createPipelineDefinitionReplayStore } from '../pipeline-definition-replay-store';

/*
 * CAN-7690: Electron main and the CLI write the definitions store through
 * the execution-engine environment, and Electron main writes the definition
 * receipts through its own store. Each refuses, writing nothing, once the
 * row's owner record names the daemon, and is unchanged with no record.
 */

const TEXT =
  'name: Alpha\non: dispatch\njobs:\n  run:\n    steps:\n      - run: echo alpha\n';

function record(namespaceId: string, toOwner: 'daemon' | 'legacy'): void {
  const path = join(
    mockRoot,
    'storage-records',
    namespaceId,
    'owner-flip.json',
  );
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      namespaceId,
      fromOwner: toOwner === 'daemon' ? 'legacy' : 'daemon',
      toOwner,
      workPackage: 'W6',
      backupRecord: `storage-records/${namespaceId}/namespace-backup.json#sha256:${'a'.repeat(64)}`,
      flippedAt: '2026-11-24T10:00:00.000Z',
    }),
  );
}

/** Every file under the root but the owner records, by path and digest. */
function tree(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (relative(mockRoot, path) === 'storage-records') continue;
      if (statSync(path).isDirectory()) walk(path);
      else
        files[relative(mockRoot, path)] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
    }
  };
  walk(mockRoot);
  return files;
}

function save(name: string): ReturnType<typeof saveStoredPipeline> {
  return saveStoredPipeline({
    name,
    description: '',
    icon: '',
    content: parsePipelineText(TEXT),
    rawContent: TEXT,
  });
}

const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'owner-records-hosts-'));
  process.env.CANOPY_DATA_DIR = mockRoot;
  jest
    .spyOn(pipelinePaths, 'getUserPipelinesDir')
    .mockReturnValue(join(mockRoot, 'pipelines'));
  jest
    .spyOn(pipelinePaths, 'getUserPipelineIndexPath')
    .mockReturnValue(join(mockRoot, 'pipelines', 'index.json'));
});

afterEach(() => {
  jest.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  rmSync(mockRoot, { recursive: true, force: true });
});

describe('older app and CLI writes refused once the daemon owns a pipeline store (CAN-7690)', () => {
  it('writes the definitions store as before with no record, and refuses every write once the record names the daemon', () => {
    const created = save('Alpha');
    expect(created.success).toBe(true);
    const id = created.data?.id ?? '';
    record('pipeline_definitions', 'daemon');
    const before = tree();
    const refusedSave = save('Beta');
    expect(refusedSave.success).toBe(false);
    expect(refusedSave.error).toContain('background service keeps this data');
    expect(deleteStoredPipeline(id).success).toBe(false);
    expect(tree()).toEqual(before);
    record('pipeline_definitions', 'legacy');
    expect(save('Gamma').success).toBe(true);
    expect(deleteStoredPipeline(id).success).toBe(true);
  });

  it('refuses Electron main’s receipt writes once their record names the daemon, and writes them as before without one', async () => {
    const file = join(mockRoot, 'pipeline-definition-replays.json');
    const receipts = createPipelineDefinitionReplayStore();
    const ledger = { entries: [], expired: [] };
    await receipts.save(ledger);
    expect(existsSync(file)).toBe(true);
    const written = readFileSync(file, 'utf8');
    record('pipeline_definition_replays', 'daemon');
    await expect(receipts.save(ledger)).rejects.toBeInstanceOf(
      StorageRowOwnerError,
    );
    expect(readFileSync(file, 'utf8')).toBe(written);
  });

  it('refuses the desktop CLI by name as an app writer once the record names the daemon', () => {
    const asCli = <T>(run: () => T): T =>
      withStoredPipelineWriter(
        { writer: 'desktop_cli', ownership: STORAGE_OWNERSHIP },
        run,
      );
    record('pipeline_definitions', 'legacy');
    const created = asCli(() => save('Alpha'));
    expect(created.success).toBe(true);
    record('pipeline_definitions', 'daemon');
    const before = tree();
    const refused = asCli(() => save('Beta'));
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('background service keeps this data');
    expect(
      asCli(() => deleteStoredPipeline(created.data?.id ?? '')).success,
    ).toBe(false);
    expect(tree()).toEqual(before);
  });
});
