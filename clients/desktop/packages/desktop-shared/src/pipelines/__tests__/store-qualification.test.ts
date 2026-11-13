import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as AtomicFile from '@canopy/execution-engine/node/lib/atomic-file';
import type {
  PipelineIndex,
  PipelineSaveInput,
} from '@canopy/execution-engine/types/pipeline';

let mockRoot = '';
let mockFailIndex = false;
let mockUnreadableDocument = '';
let mockUnstatableDocument = '';
let mockOrder: string[] = [];
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof fs>('node:fs');
  return {
    ...actual,
    unlinkSync: jest.fn(actual.unlinkSync),
    statSync: (
      ...args: Parameters<typeof actual.statSync>
    ): ReturnType<typeof actual.statSync> => {
      if (args[0] === mockUnstatableDocument)
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return actual.statSync(...args);
    },
    readFileSync: (
      ...args: Parameters<typeof actual.readFileSync>
    ): ReturnType<typeof actual.readFileSync> => {
      if (args[0] === mockUnreadableDocument)
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return actual.readFileSync(...args);
    },
  };
});
jest.mock('@canopy/execution-engine/pipelines/config-paths', () => ({
  getUserPipelinesDir: (): string => join(mockRoot, 'pipelines'),
  getUserPipelineIndexPath: (): string =>
    join(mockRoot, 'pipelines', 'index.json'),
  getBundledPipelinesDir: (): string => join(mockRoot, 'bundled'),
}));
jest.mock('@canopy/execution-engine/node/lib/atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFile>(
    '@canopy/execution-engine/node/lib/atomic-file',
  );
  return {
    ...actual,
    writeFileAtomicallySync: jest.fn(
      (...args: Parameters<typeof actual.writeFileAtomicallySync>) => {
        if (args[0].endsWith('index.json')) {
          mockOrder.push('index');
          if (mockFailIndex) {
            mockFailIndex = false;
            throw new Error('index failed');
          }
        }
        return actual.writeFileAtomicallySync(...args);
      },
    ),
  };
});
import {
  inspectStoredPipelineDocument,
  removeUnlistedStoredPipelineDocument,
  readStoredPipelinePresence,
  getStoredPipeline,
  listStoredPipelines,
  readStoredPipelineRevision,
  readStoredPipelineIndexStatus,
  reconcileStoredPipelineIndex,
  removeStoredPipeline,
  saveStoredPipeline,
  writeStoredPipeline,
  writeStoredPipelineRemoteMetadata,
} from '@canopy/execution-engine/pipelines/store';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { createStoredPipelineDefinitionWriter } from '../../node/pipelines/definition-sources';

const input = (name = 'Review'): PipelineSaveInput => ({
  name,
  description: '',
  icon: '',
  content: {
    name,
    on: 'dispatch',
    jobs: { build: { steps: [{ run: 'echo ok' }] } },
  },
});
const indexPath = (): string => join(mockRoot, 'pipelines', 'index.json');
const bytes = (): string => fs.readFileSync(indexPath(), 'utf8');
const index = (): PipelineIndex => JSON.parse(bytes()) as PipelineIndex;
const document = (id: string): string =>
  join(mockRoot, 'pipelines', `${id}.yaml`);
function saved(name = 'Review'): string {
  const result = saveStoredPipeline(input(name));
  if (!result.success || !result.data) throw new Error(result.error);
  return result.data.id;
}
function seed(entries: unknown[], rest: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    indexPath(),
    JSON.stringify({ ...rest, pipelines: entries }),
  );
}
function liveLock(milliseconds: number): ChildProcess {
  const child = spawn(
    process.execPath,
    ['-e', `setTimeout(() => {}, ${milliseconds})`],
    { stdio: 'ignore' },
  );
  const directory = join(getCanopyDataDir(), 'locks', 'pipeline-definitions');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    join(directory, 'writer.lock'),
    JSON.stringify({
      version: 1,
      pid: child.pid,
      nonce: 'child',
      createdAt: new Date().toISOString(),
    }),
  );
  return child;
}

beforeEach(() => {
  mockRoot = fs.mkdtempSync(join(tmpdir(), 'store-persistence-'));
  fs.mkdirSync(join(mockRoot, 'pipelines'));
  mockFailIndex = false;
  mockUnreadableDocument = '';
  mockUnstatableDocument = '';
  mockOrder = [];
});
afterEach(() => {
  jest
    .mocked(fs.unlinkSync)
    .mockImplementation(jest.requireActual<typeof fs>('node:fs').unlinkSync);
  jest.restoreAllMocks();
  fs.rmSync(mockRoot, { recursive: true, force: true });
});

it('never writes the index when reading or listing', () => {
  const id = saved();
  const entry = { ...index().pipelines[0] };
  delete entry.stepCount;
  delete entry.triggerTypes;
  delete entry.scopes;
  seed([
    entry,
    { ...entry, id: 'missing', filename: 'missing.yaml' },
    { invalid: true },
  ]);
  const before = bytes();
  const mtime = fs.statSync(indexPath()).mtimeMs;
  expect(listStoredPipelines().data?.map((entry) => entry.id)).toEqual([id]);
  expect(getStoredPipeline(id).success).toBe(true);
  expect(readStoredPipelineRevision(id)).toEqual({
    source: 'user',
    revision: 1,
  });
  expect(bytes()).toBe(before);
  expect(fs.statSync(indexPath()).mtimeMs).toBe(mtime);
});

function damage(): string[] {
  const ids = [saved('One'), saved('Two')];
  fs.writeFileSync(indexPath(), '{not json');
  return ids;
}

it('never replaces a damaged index with an empty one', () => {
  const ids = damage();
  expect(
    listStoredPipelines()
      .data?.map((entry) => entry.id)
      .sort(),
  ).toEqual(ids.sort());
  expect(bytes()).toBe('{not json');
  expect(readStoredPipelineIndexStatus()).toBe('damaged');
});

it('rebuilds a damaged index from its documents and keeps the damaged bytes aside on the next write', () => {
  const ids = damage();
  saved('Three');
  expect(index().pipelines).toHaveLength(3);
  for (const id of ids)
    expect(index().pipelines.find((entry) => entry.id === id)?.revision).toBe(
      1,
    );
  const copies = fs
    .readdirSync(join(mockRoot, 'pipelines'))
    .filter((name) => /^index\.json\.damaged-\d+$/.test(name));
  expect(copies).toHaveLength(1);
  expect(fs.readFileSync(join(mockRoot, 'pipelines', copies[0]), 'utf8')).toBe(
    '{not json',
  );
});

it('keeps only the newest five damaged index copies', () => {
  damage();
  for (let stamp = 1; stamp <= 6; stamp += 1)
    fs.writeFileSync(`${indexPath()}.damaged-${stamp}`, String(stamp));
  saved('Three');
  const copies = fs
    .readdirSync(join(mockRoot, 'pipelines'))
    .filter((name) => name.startsWith('index.json.damaged-'));
  expect(copies).toHaveLength(5);
  expect(copies).not.toContain('index.json.damaged-1');
  expect(copies).not.toContain('index.json.damaged-2');
});

(process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it)(
  'refuses to save over an index it cannot read and leaves it unchanged',
  () => {
    saved('One');
    saved('Two');
    const before = bytes();
    fs.chmodSync(indexPath(), 0o000);
    try {
      expect(writeStoredPipeline(input('Three'))).toMatchObject({
        ok: false,
        reason: 'index_unreadable',
      });
    } finally {
      fs.chmodSync(indexPath(), 0o600);
    }
    expect(bytes()).toBe(before);
  },
);

it('refuses to write an index from a newer version', () => {
  const id = saved();
  seed(index().pipelines, { version: 2, future: true });
  const before = bytes();
  expect(readStoredPipelinePresence(id)).toBe('present');
  expect(writeStoredPipeline(input())).toMatchObject({
    ok: false,
    reason: 'index_newer',
  });
  expect(removeStoredPipeline(id)).toMatchObject({
    ok: false,
    reason: 'index_newer',
  });
  expect(
    writeStoredPipelineRemoteMetadata(id, {
      remoteId: 'remote',
      contentHash: 'a'.repeat(64),
      shareScope: 'private',
      sharedAt: '2026-11-04T00:00:00.000Z',
    }),
  ).toMatchObject({
    success: false,
    error: expect.stringContaining('newer') as unknown,
  });
  expect(bytes()).toBe(before);
  expect(listStoredPipelines().data).toHaveLength(1);
});

it('keeps fields this build does not know when it rewrites an entry', () => {
  const id = saved();
  seed([{ ...index().pipelines[0], futureField: 1 }], { extra: 'x' });
  expect(writeStoredPipeline({ ...input('Updated'), id }).ok).toBe(true);
  saved('Another');
  expect(JSON.parse(bytes())).toMatchObject({
    extra: 'x',
    pipelines: expect.arrayContaining([
      expect.objectContaining({ id, futureField: 1 }),
    ]) as unknown,
  });
});

it('keeps an entry whose document is missing until it is deleted', () => {
  const id = saved('Missing');
  fs.unlinkSync(document(id));
  saved('Present');
  saved('Third');
  expect(index().pipelines.some((entry) => entry.id === id)).toBe(true);
  expect(removeStoredPipeline(id).ok).toBe(true);
  expect(index().pipelines.some((entry) => entry.id === id)).toBe(false);
});

it('restores the previous document when the index write fails after an update', () => {
  const id = saved();
  const before = fs.readFileSync(document(id), 'utf8');
  const indexBefore = bytes();
  mockFailIndex = true;
  expect(writeStoredPipeline({ ...input('Changed'), id })).toMatchObject({
    ok: false,
    reason: 'io',
  });
  expect(fs.readFileSync(document(id), 'utf8')).toBe(before);
  expect(bytes()).toBe(indexBefore);
});

it('removes a created document when its index write fails', () => {
  mockFailIndex = true;
  expect(writeStoredPipeline(input())).toMatchObject({
    ok: false,
    reason: 'io',
  });
  expect(
    fs
      .readdirSync(join(mockRoot, 'pipelines'))
      .filter((name) => name.endsWith('.yaml')),
  ).toEqual([]);
});

it('publishes a delete by removing the index entry before the document', () => {
  const id = saved();
  mockOrder = [];
  const actualUnlink = jest.requireActual<typeof fs>('node:fs').unlinkSync;
  jest.mocked(fs.unlinkSync).mockImplementation((file) => {
    if (file === document(id)) mockOrder.push('document');
    return actualUnlink(file);
  });
  expect(removeStoredPipeline(id).ok).toBe(true);
  expect(mockOrder).toEqual(['index', 'document']);
});

it('refuses a stale expected revision under the writer lock', () => {
  const id = saved();
  seed([{ ...index().pipelines[0], revision: 3 }]);
  const before = bytes();
  const yaml = fs.readFileSync(document(id), 'utf8');
  expect(
    writeStoredPipeline({ ...input('Changed'), id }, { expectedRevision: 1 }),
  ).toMatchObject({ ok: false, reason: 'revision_conflict' });
  expect(bytes()).toBe(before);
  expect(fs.readFileSync(document(id), 'utf8')).toBe(yaml);
});

it('refuses to update a definition that was deleted instead of creating a copy', () => {
  expect(
    writeStoredPipeline({ ...input(), id: 'gone' }, { requireExisting: true }),
  ).toMatchObject({ ok: false, reason: 'not_found' });
  expect(fs.readdirSync(join(mockRoot, 'pipelines'))).toEqual([]);
});

it('refreshes cached metadata a document left newer than the index', () => {
  const id = saved();
  const before = index().pipelines[0];
  fs.writeFileSync(
    document(id),
    'name: Changed\non: task_ready\njobs:\n  build:\n    steps:\n      - run: echo one\n      - run: echo two\n      - run: echo three\n',
  );
  expect(reconcileStoredPipelineIndex()).toEqual({
    ok: true,
    value: { updated: 1, rebuilt: false },
  });
  expect(listStoredPipelines().data?.[0]).toMatchObject({
    stepCount: 3,
    triggerTypes: ['task_ready'],
    revision: before.revision,
    updatedAt: before.updatedAt,
  });
});

it('reconciles the valid entry after an invalid duplicate without changing the invalid row', () => {
  const id = saved();
  const before = index().pipelines[0];
  const invalid = { id, filename: before.filename, future: 'kept' };
  seed([invalid, before]);
  fs.writeFileSync(
    document(id),
    'name: Changed\nscope: global\non: task_ready\njobs:\n  build:\n    steps:\n      - run: echo one\n      - run: echo two\n',
  );
  expect(reconcileStoredPipelineIndex()).toEqual({
    ok: true,
    value: { updated: 1, rebuilt: false },
  });
  expect(listStoredPipelines().data?.[0]).toMatchObject({
    stepCount: 2,
    triggerTypes: ['task_ready'],
    scopes: ['global'],
    revision: before.revision,
    updatedAt: before.updatedAt,
  });
  expect(index().pipelines[0]).toEqual(invalid);
  const after = bytes();
  expect(reconcileStoredPipelineIndex()).toEqual({
    ok: true,
    value: { updated: 0, rebuilt: false },
  });
  expect(bytes()).toBe(after);
});

it('waits for a live writer in another process and reclaims its lock once that process is gone', async () => {
  const waiting = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      join(__dirname, 'pipeline-definition-writer-process.ts'),
      '--save-once',
    ],
    {
      cwd: resolve(__dirname, '../../../../..'),
      env: { ...process.env, CANOPY_DATA_DIR: mockRoot },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  waiting.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    waiting.once('message', () => resolve());
    waiting.once('error', reject);
    waiting.once('exit', (code) =>
      reject(new Error(`Writer exited before ready: ${code}: ${stderr}`)),
    );
  });
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], {
    stdio: 'ignore',
  });
  const holderExit = new Promise<void>((resolve) =>
    holder.once('exit', () => resolve()),
  );
  const directory = join(mockRoot, 'locks', 'pipeline-definitions');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    join(directory, 'writer.lock'),
    JSON.stringify({
      version: 1,
      pid: holder.pid,
      nonce: 'child',
      createdAt: new Date().toISOString(),
    }),
  );
  try {
    const result = new Promise<{ result: { ok: boolean }; elapsed: number }>(
      (resolve, reject) => {
        waiting.once('message', resolve);
        waiting.once('error', reject);
        waiting.once('exit', (code) => {
          if (code !== 0) reject(new Error(stderr));
        });
      },
    );
    const exited = new Promise<number | null>((resolve) =>
      waiting.once('exit', resolve),
    );
    waiting.send('save');
    const saved = await result;
    expect(saved.result.ok).toBe(true);
    expect(saved.elapsed).toBeGreaterThanOrEqual(300);
    expect(await exited).toBe(0);
    expect(stderr).toBe('');
    expect(fs.existsSync(join(directory, 'writer.lock'))).toBe(false);
  } finally {
    waiting.kill();
    holder.kill();
    await holderExit;
  }
}, 20_000);

it('refuses a save after waiting five seconds for a live writer', async () => {
  const child = liveLock(8_000);
  try {
    const start = Date.now();
    expect(writeStoredPipeline(input())).toMatchObject({
      ok: false,
      reason: 'busy',
      message: 'Another app is saving workflows. Try again in a moment.',
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(4_900);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    fs.rmSync(
      join(getCanopyDataDir(), 'locks', 'pipeline-definitions', 'writer.lock'),
      { force: true },
    );
  }
}, 20_000);

it('skips malformed documents during recovery and keeps their bytes and cached metadata', () => {
  const id = saved('Valid');
  const malformed = 'name: Broken\non: dispatch\njobs:\n  broken: null\n';
  fs.writeFileSync(document('broken'), malformed);
  fs.writeFileSync(
    document('missing-steps'),
    'name: Missing steps\non: dispatch\njobs:\n  broken: {}\n',
  );
  fs.writeFileSync(
    document('array-jobs'),
    'name: Array jobs\non: dispatch\njobs: []\n',
  );
  fs.writeFileSync(indexPath(), '{not json');
  expect(listStoredPipelines().data?.map((entry) => entry.id)).toEqual([id]);
  expect(readStoredPipelineRevision(id)).toEqual({
    source: 'user',
    revision: 1,
  });
  expect(reconcileStoredPipelineIndex()).toEqual({
    ok: true,
    value: { updated: 0, rebuilt: true },
  });
  const created = saved('Another');
  expect(removeStoredPipeline(created).ok).toBe(true);
  expect(fs.readFileSync(document('broken'), 'utf8')).toBe(malformed);
  const listed = index().pipelines[0];
  fs.writeFileSync(document(id), malformed);
  const before = bytes();
  expect(reconcileStoredPipelineIndex()).toEqual({
    ok: true,
    value: { updated: 0, rebuilt: false },
  });
  expect(bytes()).toBe(before);
  expect(index().pipelines[0]).toEqual(listed);
});

it('keeps a surviving workflow document referenced by a hidden duplicate when deleting another workflow', () => {
  const a = saved('A');
  const b = saved('B');
  const entries = index().pipelines;
  const bBefore = fs.readFileSync(document(b), 'utf8');
  seed([...entries, { ...entries[0], filename: `${b}.yaml` }]);
  expect(removeStoredPipeline(a).ok).toBe(true);
  expect(index().pipelines.map((entry) => entry.id)).toEqual([b]);
  expect(fs.existsSync(document(a))).toBe(false);
  expect(fs.readFileSync(document(b), 'utf8')).toBe(bBefore);
  expect(getStoredPipeline(b).success).toBe(true);
});

it('refuses every mutation of a newer index before validating its current-format shape', () => {
  const id = saved();
  for (const pipelines of [{ futureShape: true }, null, 'future']) {
    const newer = JSON.stringify({ version: 2, pipelines, future: 'kept' });
    fs.writeFileSync(indexPath(), newer);
    expect(readStoredPipelineIndexStatus()).toBe('newer');
    expect(readStoredPipelinePresence(id)).toBe('unreadable');
    expect(reconcileStoredPipelineIndex()).toMatchObject({
      ok: false,
      reason: 'index_newer',
    });
    expect(writeStoredPipeline(input())).toMatchObject({
      ok: false,
      reason: 'index_newer',
    });
    expect(removeStoredPipeline(id)).toMatchObject({
      ok: false,
      reason: 'index_newer',
    });
    expect(bytes()).toBe(newer);
  }
});

it('refuses an upsert whose expected revision changes after its fast precheck', async () => {
  const id = saved();
  const pipeline = input().content;
  const writer = createStoredPipelineDefinitionWriter({
    owner: () => {
      seed([{ ...index().pipelines[0], revision: 2 }]);
      return null;
    },
  });
  await expect(
    writer.upsert(
      {
        definitionId: id,
        expectedRevision: 1,
        name: pipeline.name,
        description: '',
        icon: '',
        pipeline,
        text: fs.readFileSync(document(id), 'utf8'),
      },
      { scope: {}, signal: new AbortController().signal },
    ),
  ).rejects.toMatchObject({ code: 'core.pipeline.revisionConflict' });
  expect(readStoredPipelineRevision(id)).toEqual({
    source: 'user',
    revision: 2,
  });
});

it('keeps cached scopes when a readable legacy document cannot be normalized', () => {
  const id = saved();
  fs.writeFileSync(
    document(id),
    'name: Review\non: dispatch\ninputs: {}\njobs:\n  build:\n    steps:\n      - run: echo ok\n',
  );
  const before = bytes();
  expect(getStoredPipeline(id).success).toBe(true);
  expect(reconcileStoredPipelineIndex()).toEqual({
    ok: true,
    value: { updated: 0, rebuilt: false },
  });
  expect(bytes()).toBe(before);
  expect(getStoredPipeline(id).success).toBe(true);
});

it('never unlinks the index named by a malformed duplicate during delete', () => {
  const a = saved('A');
  const b = saved('B');
  seed([...index().pipelines, { id: a, filename: 'index.json' }]);
  expect(removeStoredPipeline(a).ok).toBe(true);
  expect(fs.existsSync(indexPath())).toBe(true);
  expect(getStoredPipeline(b).success).toBe(true);
  expect(listStoredPipelines().data?.some((entry) => entry.id === b)).toBe(
    true,
  );
  expect(fs.existsSync(document(a))).toBe(false);
});

it('keeps YAML referenced through a case-only filename alias', () => {
  const a = saved('A');
  const b = saved('B');
  const [entryA, entryB] = index().pipelines;
  const filename = 'case-alias.yaml';
  const alias = 'CASE-ALIAS.yaml';
  const filePath = join(mockRoot, 'pipelines', filename);
  const aliasPath = join(mockRoot, 'pipelines', alias);
  fs.renameSync(document(a), filePath);
  if (!fs.existsSync(aliasPath)) fs.linkSync(filePath, aliasPath);
  const original = fs.readFileSync(filePath, 'utf8');
  const identity = fs.statSync(filePath);
  expect(fs.statSync(aliasPath)).toMatchObject({
    dev: identity.dev,
    ino: identity.ino,
  });
  seed([
    { ...entryA, filename },
    { ...entryB, filename: alias },
  ]);
  expect(getStoredPipeline(b).success).toBe(true);
  expect(removeStoredPipeline(a).ok).toBe(true);
  expect(fs.existsSync(filePath)).toBe(true);
  expect(fs.readFileSync(aliasPath, 'utf8')).toBe(original);
  expect(getStoredPipeline(b).success).toBe(true);
  expect(index().pipelines.map((entry) => entry.id)).toEqual([b]);
});

it('inspects listed, unlisted, absent and unreadable documents', () => {
  const id = saved();
  const rawContent = fs.readFileSync(document(id), 'utf8');
  const before = bytes();
  expect(inspectStoredPipelineDocument(id)).toEqual({
    kind: 'stored',
    rawContent,
    revision: 1,
  });
  expect(readStoredPipelinePresence(id)).toBe('present');
  fs.writeFileSync(document('orphan'), 'orphan bytes');
  expect(inspectStoredPipelineDocument('orphan')).toEqual({
    kind: 'unlisted',
    rawContent: 'orphan bytes',
  });
  expect(readStoredPipelinePresence('orphan')).toBe('absent');
  expect(inspectStoredPipelineDocument('missing')).toEqual({ kind: 'absent' });
  expect(readStoredPipelinePresence('missing')).toBe('absent');
  mockUnreadableDocument = document(id);
  expect(inspectStoredPipelineDocument(id)).toEqual({
    kind: 'unreadable',
    message: 'EACCES',
  });
  expect(readStoredPipelinePresence(id)).toBe('unreadable');
  mockUnreadableDocument = '';
  expect(bytes()).toBe(before);
  fs.writeFileSync(indexPath(), '{broken');
  expect(inspectStoredPipelineDocument(id)).toEqual({
    kind: 'stored',
    rawContent,
    revision: 1,
  });
  expect(readStoredPipelinePresence(id)).toBe('unreadable');
});

it('removes an unlisted document only while it holds the expected bytes', () => {
  const hash = (text: string): string =>
    createHash('sha256').update(text).digest('hex');
  const id = saved();
  const storedBytes = fs.readFileSync(document(id), 'utf8');
  expect(
    removeUnlistedStoredPipelineDocument(id, hash(storedBytes)),
  ).toMatchObject({ ok: false, reason: 'invalid' });
  fs.writeFileSync(document('orphan'), 'new bytes');
  expect(
    removeUnlistedStoredPipelineDocument('orphan', hash('old bytes')),
  ).toMatchObject({ ok: false, reason: 'invalid' });
  expect(fs.readFileSync(document('orphan'), 'utf8')).toBe('new bytes');
  const actualUnlink = jest.requireActual<typeof fs>('node:fs').unlinkSync;
  jest.mocked(fs.unlinkSync).mockImplementation((file) => {
    if (file === document('orphan'))
      expect(
        fs.existsSync(
          join(getCanopyDataDir(), 'locks/pipeline-definitions/writer.lock'),
        ),
      ).toBe(true);
    return actualUnlink(file);
  });
  expect(
    removeUnlistedStoredPipelineDocument('orphan', hash('new bytes')),
  ).toEqual({ ok: true, value: { removed: true } });
  jest.mocked(fs.unlinkSync).mockImplementation(actualUnlink);
  expect(fs.existsSync(document('orphan'))).toBe(false);
  expect(
    removeUnlistedStoredPipelineDocument('orphan', hash('new bytes')),
  ).toEqual({ ok: true, value: { removed: false } });
  fs.writeFileSync(document('orphan'), '{not yaml');
  fs.writeFileSync(indexPath(), '{broken');
  expect(
    removeUnlistedStoredPipelineDocument('orphan', hash('{not yaml')),
  ).toMatchObject({ ok: false, reason: 'invalid' });
  expect(fs.readFileSync(document('orphan'), 'utf8')).toBe('{not yaml');
  expect(bytes()).toBe('{broken');
});

it('reports an unreadable indexed alternate document instead of absence', () => {
  const id = saved();
  const alternate = join(mockRoot, 'pipelines', 'alternate.yaml');
  fs.renameSync(document(id), alternate);
  seed(
    index().pipelines.map((entry) => ({
      ...entry,
      filename: 'alternate.yaml',
    })),
  );
  const before = bytes();
  mockUnstatableDocument = alternate;
  const state = inspectStoredPipelineDocument(id);
  expect(state.kind).toBe('unreadable');
  expect(readStoredPipelinePresence(id)).toBe('unreadable');
  expect(bytes()).toBe(before);
});

it('reports an indexed directory target instead of absence', () => {
  const id = saved();
  const entry = index().pipelines[0];
  fs.unlinkSync(document(id));
  fs.mkdirSync(join(mockRoot, 'pipelines', 'alternate-directory'));
  seed([{ ...entry, filename: 'alternate-directory' }]);
  const before = bytes();
  expect(inspectStoredPipelineDocument(id).kind).toBe('unreadable');
  expect(readStoredPipelinePresence(id)).toBe('unreadable');
  expect(bytes()).toBe(before);
});
