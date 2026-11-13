import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageOutcomeUnknownError } from '@canopy/core-runtime/storage';
import * as atomicFile from '@canopy/execution-engine/node/lib/atomic-file';
import type { PipelinePackageResource } from '@canopy/protocol/pipelines';

let mockRoot = '';
jest.mock('../../lib/paths', () => ({
  getPipelineLocalMetadataFilePath: (): string =>
    join(mockRoot, 'pipeline-local-metadata.json'),
  getPipelineDefinitionReplaysFilePath: (): string =>
    join(mockRoot, 'pipeline-definition-replays.json'),
  getPipelineAssetsDir: (id: string): string =>
    join(mockRoot, 'pipeline-data', id, 'assets'),
  getPipelineAssetsManifestPath: (id: string): string =>
    join(mockRoot, 'pipeline-data', id, 'assets.json'),
}));
jest.mock('@canopy/execution-engine/node/lib/atomic-file', () => {
  const actual = jest.requireActual<typeof atomicFile>(
    '@canopy/execution-engine/node/lib/atomic-file',
  );
  return {
    ...actual,
    writeFileAtomicallySync: jest.fn(actual.writeFileAtomicallySync),
    writeFileAtomically: jest.fn(actual.writeFileAtomically),
  };
});

import {
  readPipelineLocalMetadata,
  recordUserPipelineOwner,
} from '../pipeline-local-metadata-store';
import { createPipelineDefinitionReplayStore } from '../pipeline-definition-replay-store';
import { installPipelineAssets } from '../pipeline-asset-install';

const contents = Buffer.from('#!/bin/sh\necho hello\n');
const sha256 = createHash('sha256').update(contents).digest('hex');
const resource: PipelinePackageResource = {
  id: 'script',
  kind: 'file_asset',
  displayName: 'Script',
  sourceLabel: 'Package',
  sourceVisibility: 'local',
  invocationKeys: [],
  dependencyResourceIds: [],
  assetId: 'script',
  installMode: 'replace',
  trees: [
    {
      provider: 'codex',
      runtimeKind: 'pipeline_asset',
      rootName: 'script',
      entries: [
        { path: 'run.sh', sha256, size: contents.length, mode: 'execute' },
      ],
    },
  ],
};
const manifestPath = (): string =>
  join(mockRoot, 'pipeline-data', 'workflow', 'assets.json');

beforeEach(() => {
  mockRoot = fs.mkdtempSync(join(tmpdir(), 'pipeline-sidecars-'));
  jest.clearAllMocks();
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(mockRoot, { recursive: true, force: true });
});

it('installs the metadata file durably with mode 0600', () => {
  recordUserPipelineOwner('workflow', 'personal');
  const file = join(mockRoot, 'pipeline-local-metadata.json');
  expect(atomicFile.writeFileAtomicallySync).toHaveBeenCalledWith(
    file,
    expect.any(String),
    expect.objectContaining({ encoding: 'utf8', mode: 0o600, durable: true }),
  );
  if (process.platform !== 'win32')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

it('keeps a metadata write whose folder flush failed', () => {
  const actual = jest.requireActual<typeof atomicFile>(
    '@canopy/execution-engine/node/lib/atomic-file',
  );
  jest
    .mocked(atomicFile.writeFileAtomicallySync)
    .mockImplementationOnce((...args) => {
      actual.writeFileAtomicallySync(...args);
      throw new StorageOutcomeUnknownError(
        'directory_flush',
        new Error('flush failed'),
      );
    });
  const warning = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  recordUserPipelineOwner('workflow', 'personal');
  expect(
    readPipelineLocalMetadata({
      type: 'stored',
      source: 'user',
      value: 'workflow',
    }),
  ).toEqual({ owner: 'personal' });
  expect(warning).toHaveBeenCalledWith(
    '[pipeline-local-metadata] Metadata file installed, but its folder flush failed.\n',
  );
});

it('saves receipts durably', async () => {
  const store = createPipelineDefinitionReplayStore();
  await store.save({ entries: [], expired: [] });
  expect(atomicFile.writeFileAtomically).toHaveBeenCalledWith(
    join(mockRoot, 'pipeline-definition-replays.json'),
    expect.any(String),
    expect.objectContaining({ durable: true }),
  );
  await expect(store.load()).resolves.toEqual({ entries: [], expired: [] });
});

describe('automations:capability-package:install supporting-file persistence', () => {
  it('installs supporting files and their manifest durably', async () => {
    const packagePath = join(mockRoot, 'package');
    fs.mkdirSync(join(packagePath, 'blobs'), { recursive: true });
    fs.writeFileSync(join(packagePath, 'blobs', sha256), contents);
    const manifest = await installPipelineAssets({
      localPipelineId: 'workflow',
      packagePath,
      resources: [resource],
    });
    const destination = join(
      mockRoot,
      'pipeline-data',
      'workflow',
      'assets',
      'script',
      'run.sh',
    );
    expect(atomicFile.writeFileAtomically).toHaveBeenCalledWith(
      destination,
      contents,
      expect.objectContaining({ mode: 0o755, durable: true }),
    );
    expect(atomicFile.writeFileAtomically).toHaveBeenCalledWith(
      manifestPath(),
      `${JSON.stringify(manifest, null, 2)}\n`,
      expect.objectContaining({ durable: true }),
    );
    expect(fs.readFileSync(destination)).toEqual(contents);
    if (process.platform !== 'win32')
      expect(fs.statSync(destination).mode & 0o777).toBe(0o755);
  });

  it('refuses an install over a manifest from a newer version', async () => {
    fs.mkdirSync(join(mockRoot, 'pipeline-data', 'workflow'), {
      recursive: true,
    });
    const original = '{"version":2,"assets":{},"future":true}\n';
    fs.writeFileSync(manifestPath(), original);
    const beforeWrite = jest
      .fn<Promise<void>, []>()
      .mockResolvedValue(undefined);
    await expect(
      installPipelineAssets({
        localPipelineId: 'workflow',
        packagePath: join(mockRoot, 'package'),
        resources: [],
        beforeWrite,
      }),
    ).rejects.toThrow(
      'The supporting files of this workflow were saved by a newer version of the app. Update the app and try again.',
    );
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(fs.readFileSync(manifestPath(), 'utf8')).toBe(original);
    expect(atomicFile.writeFileAtomically).not.toHaveBeenCalled();
  });
});
