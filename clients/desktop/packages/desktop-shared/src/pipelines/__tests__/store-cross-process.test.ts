import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';

let mockRoot = '';
jest.mock('@canopy/execution-engine/pipelines/config-paths', () => ({
  getUserPipelinesDir: (): string => join(mockRoot, 'pipelines'),
  getUserPipelineIndexPath: (): string =>
    join(mockRoot, 'pipelines', 'index.json'),
  getBundledPipelinesDir: (): string => join(mockRoot, 'bundled'),
}));
import { saveStoredPipeline } from '@canopy/execution-engine/pipelines/store';
import type { PipelineIndex } from '@canopy/execution-engine/types/pipeline';

const REPOSITORY_ROOT = resolve(__dirname, '../../../../..');
const WRITER = join(__dirname, 'pipeline-definition-writer-process.ts');

function runWriter(
  prefix: string,
  sharedId: string,
  startAt: number,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', WRITER, prefix, '20', sharedId, String(startAt)],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, CANOPY_DATA_DIR: mockRoot },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}

beforeEach(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'pipeline-definitions-processes-'));
});
afterEach(() => {
  rmSync(mockRoot, { recursive: true, force: true });
});

it('keeps every desktop and CLI save when both processes write at once', async () => {
  const saved = saveStoredPipeline({
    name: 'Shared',
    description: '',
    icon: '',
    content: { name: 'Shared', on: 'dispatch', jobs: {} },
  });
  if (!saved.success || !saved.data) throw new Error(saved.error);
  const sharedId = saved.data.id;
  const startAt = Date.now() + 4_000;
  const results = await Promise.all([
    runWriter('desktop', sharedId, startAt),
    runWriter('cli', sharedId, startAt),
  ]);
  expect(results).toEqual([
    { code: 0, stderr: '' },
    { code: 0, stderr: '' },
  ]);
  const index = JSON.parse(
    readFileSync(join(mockRoot, 'pipelines', 'index.json'), 'utf8'),
  ) as PipelineIndex;
  expect(index.pipelines).toHaveLength(41);
  for (const prefix of ['desktop', 'cli']) {
    for (let n = 0; n < 20; n += 1) {
      expect(
        index.pipelines.filter(
          (entry) => entry.id !== sharedId && entry.name === `${prefix}-${n}`,
        ),
      ).toHaveLength(1);
    }
  }
  expect(index.pipelines.find((entry) => entry.id === sharedId)?.revision).toBe(
    41,
  );
  for (const entry of index.pipelines) {
    expect(
      yaml.load(
        readFileSync(join(mockRoot, 'pipelines', entry.filename), 'utf8'),
      ),
    ).toEqual(expect.any(Object));
  }
}, 60_000);
