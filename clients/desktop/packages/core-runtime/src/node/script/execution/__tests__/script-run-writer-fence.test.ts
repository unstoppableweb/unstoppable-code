import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkerScriptDescriptor } from '@canopy/protocol/canopy-core';

import {
  ScriptRunLogStore,
  scriptRunFileStem,
  toWorkerScriptExecution,
  type ScriptRunChild,
  type ScriptRunChildReap,
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

const child: ScriptRunChild = {
  pid: 4242,
  processGroupId: 4242,
  startIdentity: 'darwin:v1:4242:1700000000',
  executablePath: '/bin/sh',
};

async function startWithChild(): Promise<void> {
  const a = store({
    ...fence(() => Promise.resolve('running'), writerA),
    identifyChild: (pid): Promise<ScriptRunChild | null> =>
      Promise.resolve(pid === child.pid ? child : null),
  });
  const ref = await a.start({ ...target, script, invocation: 'manual-run' });
  await a.recordChild({ ref, pid: child.pid });
}

function reaping(...results: ScriptRunChildReap[]): ScriptRunWriterFence & {
  reapChild: jest.Mock<Promise<ScriptRunChildReap>, [ScriptRunChild]>;
} {
  return {
    ...fence(() => Promise.resolve('gone')),
    reapChild: jest.fn<Promise<ScriptRunChildReap>, [ScriptRunChild]>(() =>
      Promise.resolve(results.shift() ?? 'unproven'),
    ),
  };
}

it('records the run process as it starts and reads the run lost once a proven reap ends it', async () => {
  await startWithChild();
  expect(JSON.parse(await readFile(metaPath(), 'utf8'))).toMatchObject({
    status: 'running',
    child,
  });
  const bFence = reaping('reaped');
  const meta = await store(bFence).readMetaFor({
    ...target,
    scriptKey: 'build',
  });
  expect(bFence.reapChild).toHaveBeenCalledWith(child);
  expect(meta).toMatchObject({ status: 'failed', outcome: 'lost' });
});

it('kills nothing on an unproven reap and reads the run orphaned with its pid until the process is gone', async () => {
  await startWithChild();
  const bFence = reaping('unproven', 'unproven', 'gone');
  const b = store(bFence);
  const meta = await b.readMetaFor({ ...target, scriptKey: 'build' });
  expect(meta).toMatchObject({ status: 'running', orphaned: true, child });
  expect(JSON.parse(await readFile(metaPath(), 'utf8'))).toMatchObject({
    status: 'running',
    orphaned: true,
  });
  expect(meta && toWorkerScriptExecution(meta)).toMatchObject({
    status: 'orphaned',
    pid: child.pid,
  });
  // Every read checks again; an orphaned run stays orphaned while unproven.
  expect(await b.readMetaFor({ ...target, scriptKey: 'build' })).toMatchObject({
    status: 'running',
    orphaned: true,
  });
  const lost = await b.readMetaFor({ ...target, scriptKey: 'build' });
  expect(lost).toMatchObject({ status: 'failed', outcome: 'lost' });
  expect(lost).not.toHaveProperty('orphaned');
  // A lost run no longer names the process that has gone.
  expect(lost && toWorkerScriptExecution(lost)).not.toHaveProperty('pid');
  expect(bFence.reapChild).toHaveBeenCalledTimes(3);
});

it('refreshes the recorded process only for the same PID and start identity', async () => {
  const exec = { ...child, executablePath: '/bin/sleep' };
  const other = { ...child, startIdentity: 'darwin:v1:4242:1700000999' };
  const identities = [child, exec, other];
  const a = store({
    ...fence(() => Promise.resolve('running'), writerA),
    identifyChild: (): Promise<ScriptRunChild | null> =>
      Promise.resolve(identities.shift() ?? null),
  });
  const ref = await a.start({ ...target, script, invocation: 'manual-run' });
  await a.recordChild({ ref, pid: child.pid });
  // The shell exec'd its command: same process, new executable.
  await a.recordChild({ ref, pid: child.pid, refresh: true });
  expect(JSON.parse(await readFile(metaPath(), 'utf8'))).toMatchObject({
    child: exec,
  });
  // A different start identity is another process; the record keeps its own.
  await a.recordChild({ ref, pid: child.pid, refresh: true });
  expect(JSON.parse(await readFile(metaPath(), 'utf8'))).toMatchObject({
    child: exec,
  });
});

it('never upgrades a PID-only record, so a reused PID cannot become a proven reap', async () => {
  // The first read could not identify the process; by the refresh its PID
  // may belong to another process, which the fence would identify fully.
  const identities: ScriptRunChild[] = [{ pid: child.pid }, child];
  const a = store({
    ...fence(() => Promise.resolve('running'), writerA),
    identifyChild: (): Promise<ScriptRunChild | null> =>
      Promise.resolve(identities.shift() ?? null),
  });
  const ref = await a.start({ ...target, script, invocation: 'manual-run' });
  await a.recordChild({ ref, pid: child.pid });
  await a.recordChild({ ref, pid: child.pid, refresh: true });
  const stored: unknown = JSON.parse(await readFile(metaPath(), 'utf8'));
  expect(stored).toMatchObject({ child: { pid: child.pid } });
  expect(stored).not.toHaveProperty('child.startIdentity');
  const bFence = reaping('unproven');
  await store(bFence).readMetaFor({ ...target, scriptKey: 'build' });
  expect(bFence.reapChild).toHaveBeenCalledWith({ pid: child.pid });
});

it('refreshes nothing when the start recorded no process, so a reused PID is never adopted', async () => {
  // The first lookup found nothing; by the refresh the PID belongs to another
  // process, which the fence would identify fully.
  const identities: (ScriptRunChild | null)[] = [null, child];
  const a = store({
    ...fence(() => Promise.resolve('running'), writerA),
    identifyChild: (): Promise<ScriptRunChild | null> =>
      Promise.resolve(identities.shift() ?? null),
  });
  const ref = await a.start({ ...target, script, invocation: 'manual-run' });
  await a.recordChild({ ref, pid: child.pid });
  await a.recordChild({ ref, pid: child.pid, refresh: true });
  expect(JSON.parse(await readFile(metaPath(), 'utf8'))).not.toHaveProperty(
    'child',
  );
  const bFence = reaping('reaped');
  const meta = await store(bFence).readMetaFor({
    ...target,
    scriptKey: 'build',
  });
  expect(bFence.reapChild).not.toHaveBeenCalled();
  expect(meta).toMatchObject({ status: 'failed', outcome: 'lost' });
});

it('keeps a run without a recorded process lost, as before', async () => {
  await startWithA();
  const bFence = reaping('reaped');
  const meta = await store(bFence).readMetaFor({
    ...target,
    scriptKey: 'build',
  });
  expect(meta).toMatchObject({ status: 'failed', outcome: 'lost' });
  expect(bFence.reapChild).not.toHaveBeenCalled();
});

async function recordedRunId(): Promise<string> {
  const meta: unknown = JSON.parse(await readFile(metaPath(), 'utf8'));
  if (typeof meta !== 'object' || meta === null || !('runId' in meta))
    throw new Error('No run.');
  return String(meta.runId);
}

const key = { ...target, scriptKey: 'build' };

it('marks a lost run without a recorded process as unrecorded, and not one that had one (CAN-6482)', async () => {
  await startWithA();
  const unrecorded = await store(
    fence(() => Promise.resolve('gone')),
  ).readMetaFor(key);
  expect(unrecorded && toWorkerScriptExecution(unrecorded)).toMatchObject({
    status: 'lost',
    lostFrom: 'unrecorded',
  });
  await startWithChild();
  const reaped = await store(reaping('reaped')).readMetaFor(key);
  expect(reaped && toWorkerScriptExecution(reaped)).toMatchObject({
    status: 'lost',
  });
  expect(reaped && toWorkerScriptExecution(reaped)).not.toHaveProperty(
    'lostFrom',
  );
});

it('clears only a finished run, by its own id, and never a running or orphaned one (CAN-6482)', async () => {
  // Running under another live writer.
  await startWithA();
  const running = store(fence(() => Promise.resolve('running')));
  await expect(
    running.clear({ ...key, runId: await recordedRunId() }),
  ).resolves.toBe('active');
  // Orphaned, once a read found it so: its record names a process that may
  // still run.
  await startWithChild();
  const orphaned = store(reaping('unproven'));
  await orphaned.readMetaFor(key);
  await expect(
    orphaned.clear({ ...key, runId: await recordedRunId() }),
  ).resolves.toBe('active');
  expect(JSON.parse(await readFile(metaPath(), 'utf8'))).toMatchObject({
    orphaned: true,
  });
  // Lost, once a read reconciled it: cleared only by its own id.
  await startWithA();
  const lost = store(fence(() => Promise.resolve('gone')));
  const runId = await recordedRunId();
  await lost.readMetaFor(key);
  await expect(lost.clear({ ...key, runId: 'another-run' })).resolves.toBe(
    'absent',
  );
  await expect(lost.clear({ ...key, runId })).resolves.toBe('cleared');
  await expect(lost.readMetaFor(key)).resolves.toBeNull();
  await expect(lost.clear({ ...key, runId })).resolves.toBe('absent');
});

it('never reconciles or reaps a run to clear it, whatever id it is asked for (CAN-6482)', async () => {
  // Its writer is gone and its process recorded: a read would reap it.
  await startWithChild();
  const runId = await recordedRunId();
  const bFence = reaping('reaped');
  const b = store(bFence);
  await expect(b.clear({ ...key, runId: 'another-run' })).resolves.toBe(
    'absent',
  );
  await expect(b.clear({ ...key, runId })).resolves.toBe('active');
  expect(bFence.reapChild).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(metaPath(), 'utf8'))).toMatchObject({
    status: 'running',
    child,
  });
});

it('keeps the run-log stem', () => {
  expect(scriptRunFileStem('build')).toBe('build__44575cf5b285');
  expect(scriptRunFileStem('Dev Server!')).toBe('dev-server__f29d9cb0eb73');
  expect(scriptRunFileStem('k'.repeat(200))).toBe(
    `${'k'.repeat(64)}__6de3c2886910`,
  );
});
