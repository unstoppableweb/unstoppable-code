import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectPipelinesDir } from '@canopy/execution-engine/pipelines/config-paths';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import type { ShareRemoteMetadata } from '@canopy/protocol/sharing';
import {
  attachProjectPipelineRemoteMetadata,
  clearProjectPipelineRemoteMetadataByRemoteId,
  writeProjectPipelineRemoteMetadata,
} from '../pipeline-service';

/*
 * CAN-7058: the project workflow share-link catalog is its own storage row,
 * pipeline_project_share_links, written only by pipeline-service. It holds
 * every author-side cloud link for project definitions, so an unreadable
 * catalog must never be replaced by a fresh one: publish, discovery and clear
 * all leave its bytes as they were. A missing catalog reads as no links and
 * is created by the first publish.
 */

const REMOTE: ShareRemoteMetadata = {
  remoteId: 'remote-1',
  contentHash: 'hash-1',
  shareScope: 'team',
  sharedAt: '2026-11-17T12:00:00.000Z',
};

let root = '';
let project = '';
let definition = '';
const saved = {
  data: process.env.CANOPY_DATA_DIR,
  secure: process.env.CANOPY_SECURE_DATA_DIR,
};

const catalog = (): string =>
  join(root, 'data', 'pipelines', '.project-share-links.json');

function projectPipeline(): PipelineInfo {
  return {
    id: 'project-review',
    name: 'Project review',
    filename: 'review.yaml',
    description: '',
    icon: '',
    createdAt: '2026-11-17T12:00:00.000Z',
    updatedAt: '2026-11-17T12:00:00.000Z',
    source: 'project',
    readonly: true,
    filePath: definition,
  };
}

function seedCatalog(text: string): void {
  mkdirSync(join(catalog(), '..'), { recursive: true });
  writeFileSync(catalog(), text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-share-links-'));
  process.env.CANOPY_DATA_DIR = join(root, 'data');
  process.env.CANOPY_SECURE_DATA_DIR = join(root, 'secure');
  project = join(root, 'project');
  const folder = getProjectPipelinesDir(project);
  mkdirSync(folder, { recursive: true });
  definition = join(folder, 'review.yaml');
  writeFileSync(definition, 'name: Project review\n');
});

afterEach(() => {
  for (const [key, value] of [
    ['CANOPY_DATA_DIR', saved.data],
    ['CANOPY_SECURE_DATA_DIR', saved.secure],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('project share-link catalog (CAN-7058)', () => {
  it.each([
    ['unparseable', '{ not json'],
    ['not a map', '[]\n'],
    [
      'holding an invalid link',
      `${JSON.stringify({ '/elsewhere/review.yaml': { remote: {} } })}\n`,
    ],
  ])(
    'leaves an %s catalog byte-identical through publish, discovery and clear',
    (_label, text) => {
      seedCatalog(text);

      expect(
        writeProjectPipelineRemoteMetadata(definition, REMOTE),
      ).toMatchObject({ success: false });
      const pipelines = [projectPipeline()];
      expect(
        attachProjectPipelineRemoteMetadata(pipelines, project, true),
      ).toBe(pipelines);
      expect(
        clearProjectPipelineRemoteMetadataByRemoteId('remote-1'),
      ).toMatchObject({ success: false });

      expect(readFileSync(catalog(), 'utf8')).toBe(text);
    },
  );

  it('reads a missing catalog as no links and writes nothing until a publish', () => {
    const [discovered] = attachProjectPipelineRemoteMetadata(
      [projectPipeline()],
      project,
      true,
    );
    expect(discovered.remote).toBeUndefined();
    expect(clearProjectPipelineRemoteMetadataByRemoteId('remote-1')).toEqual({
      success: true,
      data: 0,
    });
    expect(existsSync(join(root, 'data', 'pipelines'))).toBe(false);

    expect(writeProjectPipelineRemoteMetadata(definition, REMOTE)).toEqual({
      success: true,
    });
    const [linked] = attachProjectPipelineRemoteMetadata(
      [projectPipeline()],
      project,
      true,
    );
    expect(linked.remote).toEqual(REMOTE);
    expect(clearProjectPipelineRemoteMetadataByRemoteId('remote-1')).toEqual({
      success: true,
      data: 1,
    });
    expect(JSON.parse(readFileSync(catalog(), 'utf8'))).toEqual({});
  });
});
