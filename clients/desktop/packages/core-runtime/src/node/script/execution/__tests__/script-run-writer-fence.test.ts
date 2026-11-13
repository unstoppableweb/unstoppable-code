import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkerScriptDescriptor } from '@canopy/protocol/canopy-core';

import {
  ScriptRunLogStore,
  scriptRunFileStem,
  type ScriptRunWriter,
  type ScriptRunWriterFence,
  type ScriptRunWriterState,
} from '..';

const script: WorkerScriptDescriptor = {
  scriptKey: 'build',
  scriptName: 'build',
  label: 'Build',
  command: 'make',
  lifecycle: 'custom',
  target: 'project',
};
const writerA: ScriptRunWriter = { pid: 101, startIdentity: 'a' };
const target = { projectId: 'project', worktreeId: 'task' };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'script-run-writer-fence-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeAtomically(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, path);
}

function store(
  writerFence?: ScriptRunWriterFence,
  writeFileAtomically = writeAtomically,
): ScriptRunLogStore {
  return new ScriptRunLogStore({
    paths: {
      runDir: (projectId, worktreeId): string =>
        join(dir, projectId, worktreeId),
      fileStem: scriptRunFileStem,
    },
    files: { writeFileAtomically },
    ...(writerFence ? { writerFence } : {}),
  });
}

function fence(
  inspect: (writer: ScriptRunWriter) => Promise<ScriptRunWriterState>,
  self: ScriptRunWriter | null = { pid: 202, startIdentity: 'b' },
): ScriptRunWriterFence & {
  inspect: jest.Mock<Promise<ScriptRunWriterState>, [ScriptRunWriter]>;
} {
  return {
    self: (): Promise<ScriptRunWriter | null> => Promise.resolve(self),
    inspect: jest.fn(inspect),
  };
}

function metaPath(): string {
  return join(dir, 'project', 'task', `${scriptRunFileStem('build')}.json`);
}

async function startWithA(withFence = true): Promise<void> {
  const a = store(
    withFence ? fence(() => Promise.resolve('running'), writerA) : undefined,
  );
  await a.start({ ...target, script, invocation: 'manual-run' });
}

it("keeps another live writer's running run running", async () => {
  await startWithA();
  const before = await readFile(metaPath(), 'utf8');
  const b = store(fence(() => Promise.resolve('running')));
  const tails = await b.listTails({ ...target, maxLines: 10 });
  expect(tails.map(({ meta }) => meta.status)).toEqual(['running']);
  const meta = await b.readMetaFor({ ...target, scriptKey: 'build' });
  expect(meta?.status).toBe('running');
  expect(meta?.writer).toEqual(writerA);
  expect(await readFile(metaPath(), 'utf8')).toBe(before);
});

it("marks a gone writer's running run lost", async () => {
  await startWithA();
  const before = await readFile(metaPath(), 'utf8');
  const b = store(fence(() => Promise.resolve('gone')));
  const meta = await b.readMetaFor({ ...target, scriptKey: 'build' });
  expect(meta).toMatchObject({ status: 'failed', outcome: 'lost' });
  const after = await readFile(metaPath(), 'utf8');
  expect(after).not.toBe(before);
  expect(JSON.parse(after)).toMatchObject({
    status: 'failed',
    outcome: 'lost',
  });
});

it("leaves an unverifiable writer's run running and writes nothing", async () => {
  await startWithA();
  const before = await readFile(metaPath(), 'utf8');
  const b = store(fence(() => Promise.reject(new Error('inspector failed'))));
  const tails = await b.listTails({ ...target, maxLines: 10 });
  expect(tails.map(({ meta }) => meta.status)).toEqual(['running']);
  const meta = await b.readMetaFor({ ...target, scriptKey: 'build' });
  expect(meta?.status).toBe('running');
  expect(await readFile(metaPath(), 'utf8')).toBe(before);
});

it('treats a run without a writer as before', async () => {
  await startWithA(false);
  expect(JSON.parse(await readFile(metaPath(), 'utf8'))).not.toHaveProperty(
    'writer',
  );
  const bFence = fence(() => Promise.resolve('running'));
  const b = store(bFence);
  const meta = await b.readMetaFor({ ...target, scriptKey: 'build' });
  expect(meta).toMatchObject({ status: 'failed', outcome: 'lost' });
  expect(bFence.inspect).not.toHaveBeenCalled();
});

it('keeps the writer through completion', async () => {
  const a = store(fence(() => Promise.resolve('running'), writerA));
  const ref = await a.start({ ...target, script, invocation: 'manual-run' });
  await a.complete({
    ref,
    response: { success: true, exitCode: 0, timedOut: false, durationMs: 5 },
  });
  expect(JSON.parse(await readFile(metaPath(), 'utf8'))).toMatchObject({
    status: 'success',
    writer: writerA,
  });
});

it('lists a run as completed when its completion was pending', async () => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const a = store(undefined, async (path, text): Promise<void> => {
    if (text.includes('"completedAt"')) await held;
    await writeAtomically(path, text);
  });
  const ref = await a.start({ ...target, script, invocation: 'manual-run' });
  const completing = a.complete({
    ref,
    response: {
      success: false,
      exitCode: null,
      timedOut: false,
      durationMs: 5,
    },
  });
  const listing = a.listTails({ ...target, maxLines: 10 });
  // The listing reads the running run first, then waits for the write.
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await completing;
  const [tail] = await listing;
  const completedAt: unknown = expect.any(String);
  expect(tail?.meta).toMatchObject({ status: 'cancelled', completedAt });
});

it('drops a malformed writer and still reads the run', async () => {
  await startWithA();
  const raw: unknown = JSON.parse(await readFile(metaPath(), 'utf8'));
  await writeFile(
    metaPath(),
    JSON.stringify({
      ...(typeof raw === 'object' && raw !== null ? raw : {}),
      status: 'success',
      writer: { pid: -1 },
    }),
    'utf8',
  );
  const meta = await store().readMetaFor({ ...target, scriptKey: 'build' });
  expect(meta?.status).toBe('success');
  expect(meta).not.toHaveProperty('writer');
});

it('keeps the run-log stem', () => {
  expect(scriptRunFileStem('build')).toBe('build__44575cf5b285');
  expect(scriptRunFileStem('Dev Server!')).toBe('dev-server__f29d9cb0eb73');
  expect(scriptRunFileStem('k'.repeat(200))).toBe(
    `${'k'.repeat(64)}__6de3c2886910`,
  );
});
