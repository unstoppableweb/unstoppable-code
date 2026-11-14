import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkerScriptDescriptor } from '@canopy/protocol/canopy-core';

import {
  ScriptRunLogStore,
  forceStopScriptRunGroup,
  listScriptRunGroup,
  scriptRunFileStem,
  stopScriptRunChild,
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

describe('a user Stop of an orphaned run (CAN-6482)', () => {
  type Seen = 'match' | 'other' | 'absent' | 'unreadable' | 'execd';
  let clock = 0;
  let probeLatency = 0;
  let probes = 0;
  // Whether the recorded group keeps a member once its leader is gone.
  let groupLingers = false;
  beforeEach(() => {
    clock = 0;
    probeLatency = 0;
    probes = 0;
    groupLingers = false;
  });
  function host(...states: Seen[]): {
    supervision: Parameters<typeof stopScriptRunChild>[0]['supervision'];
    signals: Array<[number, string]>;
  } {
    const signals: Array<[number, string]> = [];
    const next = (): Seen =>
      (states.length > 1 ? states.shift() : states[0]) ?? 'absent';
    return {
      signals,
      supervision: {
        inspectProcess: (): ReturnType<
          Parameters<
            typeof stopScriptRunChild
          >[0]['supervision']['inspectProcess']
        > =>
          Promise.resolve(
            next() === 'absent'
              ? { state: 'absent' }
              : { state: 'running', startIdentity: 'any' },
          ),
        identifyProcess: (): ReturnType<
          NonNullable<
            Parameters<
              typeof stopScriptRunChild
            >[0]['supervision']['identifyProcess']
          >
        > => {
          const seen = next();
          probes += 1;
          clock += probeLatency;
          if (seen === 'unreadable')
            return Promise.resolve({
              state: 'unverifiable',
              reason: 'unreadable',
            });
          return Promise.resolve(
            seen === 'absent'
              ? { state: 'absent' }
              : {
                  state: 'running',
                  startIdentity:
                    seen === 'other' ? 'reused' : (child.startIdentity ?? ''),
                  processGroupId: child.processGroupId ?? 0,
                  executablePath:
                    seen === 'execd'
                      ? '/bin/other'
                      : (child.executablePath ?? ''),
                },
          );
        },
      },
    };
  }
  const stop = (
    target: ScriptRunChild,
    mode: 'stop' | 'force',
    seen: ReturnType<typeof host>,
  ): ReturnType<typeof stopScriptRunChild> =>
    stopScriptRunChild({
      child: target,
      mode,
      supervision: seen.supervision,
      kill: (pid, signal) => {
        if (signal !== 0) {
          seen.signals.push([pid, signal]);
          return;
        }
        if (!groupLingers)
          throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      },
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      graceMs: 3,
      pollMs: 1,
    });
  const group = -(child.processGroupId ?? 0);

  it('ends a proven group with SIGTERM, and SIGKILL only while the identity still matches', async () => {
    const exits = host('match', 'match', 'absent');
    await expect(stop(child, 'stop', exits)).resolves.toBe('stopped');
    expect(exits.signals).toEqual([[group, 'SIGTERM']]);
    const lingers = host('match');
    await expect(stop(child, 'stop', lingers)).resolves.toBe('stopped');
    expect(lingers.signals).toEqual([
      [group, 'SIGTERM'],
      [group, 'SIGKILL'],
    ]);
  });

  it('sends no SIGKILL once the identity changed between SIGTERM and SIGKILL', async () => {
    // Proven at start and through the grace, another process at the re-check.
    const changed = host('match', 'match', 'match', 'match', 'other');
    await expect(stop(child, 'stop', changed)).resolves.toBe('stopped');
    expect(changed.signals).toEqual([[group, 'SIGTERM']]);
  });

  it('signals nothing for a full record that no longer matches, or a process that is gone', async () => {
    const reused = host('other');
    await expect(stop(child, 'stop', reused)).resolves.toBe('not_same');
    const gone = host('absent');
    await expect(stop(child, 'stop', gone)).resolves.toBe('gone');
    expect([...reused.signals, ...gone.signals]).toEqual([]);
  });

  it('keeps a process that runs another program, or a reused PID whose group lives on, unverified and unsignalled', async () => {
    // The same start identity running another program is still running.
    const execd = host('execd');
    await expect(stop(child, 'stop', execd)).resolves.toBe('unverifiable');
    // Another start identity holds the PID, but the recorded group still
    // has a member: the run's processes may still be running.
    groupLingers = true;
    const reused = host('other');
    await expect(stop(child, 'stop', reused)).resolves.toBe('unverifiable');
    expect([...execd.signals, ...reused.signals]).toEqual([]);
  });

  it('reports a process that runs another executable after SIGTERM as still running, with no SIGKILL', async () => {
    // Same PID and start identity, a new executable: it still runs.
    const execd = host('match', 'execd');
    await expect(stop(child, 'stop', execd)).resolves.toBe('still_running');
    expect(execd.signals).toEqual([[group, 'SIGTERM']]);
  });

  it('never reports a group stopped while a member outlives its leader, and never signals it (CAN-6601: group_remains)', async () => {
    groupLingers = true;
    // The leader exits on SIGTERM; a member that ignores it remains.
    const leaderExits = host('match', 'absent');
    await expect(stop(child, 'stop', leaderExits)).resolves.toBe(
      'group_remains',
    );
    expect(leaderExits.signals).toEqual([[group, 'SIGTERM']]);
    // The leader was gone before the Stop: nothing proves the group.
    const leaderGone = host('absent');
    await expect(stop(child, 'stop', leaderGone)).resolves.toBe(
      'group_remains',
    );
    expect(leaderGone.signals).toEqual([]);
  });

  it('bounds the grace by the clock, however slow each probe is', async () => {
    probeLatency = 2;
    const slow = host('match');
    await expect(stop(child, 'stop', slow)).resolves.toBe('stopped');
    // The first proof, one poll within the 3 ms grace, and the re-check.
    expect(probes).toBe(3);
    expect(slow.signals).toEqual([
      [group, 'SIGTERM'],
      [group, 'SIGKILL'],
    ]);
  });

  it('never reports a stop it cannot prove, and signals nothing it cannot identify', async () => {
    // Unreadable after SIGTERM: still running, and no SIGKILL.
    const unreadable = host('match', 'unreadable');
    await expect(stop(child, 'stop', unreadable)).resolves.toBe(
      'still_running',
    );
    expect(unreadable.signals).toEqual([[group, 'SIGTERM']]);
    const atStart = host('unreadable');
    await expect(stop(child, 'stop', atStart)).resolves.toBe('unverifiable');
    expect(atStart.signals).toEqual([]);
  });

  it('sends a PID-only record SIGTERM to the PID alone, and SIGKILL only when forced', async () => {
    const pidOnly: ScriptRunChild = { pid: child.pid };
    const survives = host('match');
    await expect(stop(pidOnly, 'stop', survives)).resolves.toBe(
      'still_running',
    );
    expect(survives.signals).toEqual([[child.pid, 'SIGTERM']]);
    const forced = host('match');
    await expect(stop(pidOnly, 'force', forced)).resolves.toBe('stopped');
    expect(forced.signals).toEqual([[child.pid, 'SIGKILL']]);
  });

  it('stops only an orphaned run by its id, and an unverifiable one only when confirmed', async () => {
    const stopChild = jest.fn(() => Promise.resolve('stopped' as const));
    const withStop = (...results: ScriptRunChildReap[]): ScriptRunLogStore =>
      store({ ...reaping(...results), stopChild });
    // Not orphaned: still running under its live writer.
    await startWithA();
    await expect(
      store({
        ...fence(() => Promise.resolve('running')),
        stopChild,
      }).stopOrphan({
        ...key,
        runId: await recordedRunId(),
        mode: 'stop',
        confirmed: true,
      }),
    ).resolves.toBe('not_orphaned');
    // Not admitted, and nothing reaped, before its record says orphaned.
    await startWithChild();
    const runId = await recordedRunId();
    const reapOnRead = reaping('reaped');
    const unread = store({ ...reapOnRead, stopChild });
    await expect(
      unread.stopOrphan({ ...key, runId, mode: 'stop', confirmed: true }),
    ).resolves.toBe('not_orphaned');
    await expect(
      unread.stopOrphan({
        ...key,
        runId: 'another-run',
        mode: 'stop',
        confirmed: true,
      }),
    ).resolves.toBe('absent');
    expect(reapOnRead.reapChild).not.toHaveBeenCalled();
    expect(stopChild).not.toHaveBeenCalled();
    // A full record, once a read found it orphaned: proven before every
    // signal, so no confirmation needed.
    const full = withStop('unproven');
    await full.readMetaFor(key);
    await expect(
      full.stopOrphan({
        ...key,
        runId: 'another-run',
        mode: 'stop',
        confirmed: false,
      }),
    ).resolves.toBe('absent');
    await expect(
      full.stopOrphan({ ...key, runId, mode: 'stop', confirmed: false }),
    ).resolves.toBe('stopped');
    expect(stopChild).toHaveBeenLastCalledWith(child, 'stop');
    // A PID-only record needs the user's confirmation.
    await writeFile(
      metaPath(),
      JSON.stringify({
        ...JSON.parse(await readFile(metaPath(), 'utf8')),
        status: 'running',
        orphaned: true,
        child: { pid: child.pid },
      }),
    );
    const pidOnly = withStop('unproven');
    const pidRun = await recordedRunId();
    stopChild.mockClear();
    await expect(
      pidOnly.stopOrphan({
        ...key,
        runId: pidRun,
        mode: 'stop',
        confirmed: false,
      }),
    ).resolves.toBe('unconfirmed');
    expect(stopChild).not.toHaveBeenCalled();
    await expect(
      pidOnly.stopOrphan({
        ...key,
        runId: pidRun,
        mode: 'force',
        confirmed: true,
      }),
    ).resolves.toBe('stopped');
    expect(stopChild).toHaveBeenLastCalledWith({ pid: child.pid }, 'force');
  });

  it('records a stopped run lost itself, so a reused PID cannot keep it orphaned', async () => {
    await startWithChild();
    const runId = await recordedRunId();
    // Every later read finds the PID reused, so it cannot prove the run.
    const reused = reaping('unproven', 'unproven', 'unproven');
    const stopped = store({
      ...reused,
      stopChild: () => Promise.resolve('stopped' as const),
    });
    await stopped.readMetaFor(key);
    await expect(
      stopped.stopOrphan({ ...key, runId, mode: 'stop', confirmed: false }),
    ).resolves.toBe('stopped');
    const read = await stopped.readMetaFor(key);
    expect(read).toMatchObject({ runId, status: 'failed', outcome: 'lost' });
    expect(read?.orphaned).toBeUndefined();
    await expect(stopped.clear({ ...key, runId })).resolves.toBe('cleared');
  });

  it('records a run whose PID another process now holds lost, signalling nothing (coordinator, 12 Nov 2026)', async () => {
    await startWithChild();
    const runId = await recordedRunId();
    const stopChild = jest.fn(() => Promise.resolve('not_same' as const));
    const replaced = store({ ...reaping('unproven', 'unproven'), stopChild });
    await replaced.readMetaFor(key);
    await expect(
      replaced.stopOrphan({ ...key, runId, mode: 'stop', confirmed: false }),
    ).resolves.toBe('not_same');
    const read = await replaced.readMetaFor(key);
    expect(read).toMatchObject({ runId, status: 'failed', outcome: 'lost' });
    expect(read?.orphaned).toBeUndefined();
    await expect(replaced.clear({ ...key, runId })).resolves.toBe('cleared');
  });

  it('keeps a run orphaned when its Stop could not prove the process ended', async () => {
    await startWithChild();
    const runId = await recordedRunId();
    const stopChild = jest.fn(() => Promise.resolve('unverifiable' as const));
    const execd = store({ ...reaping('unproven', 'unproven'), stopChild });
    await execd.readMetaFor(key);
    await expect(
      execd.stopOrphan({ ...key, runId, mode: 'stop', confirmed: false }),
    ).resolves.toBe('unverifiable');
    expect(JSON.parse(await readFile(metaPath(), 'utf8'))).toMatchObject({
      runId,
      status: 'running',
      orphaned: true,
    });
  });

  it('projects whether an orphaned run can be verified', async () => {
    await startWithChild();
    const orphaned = await store(reaping('unproven')).readMetaFor(key);
    expect(orphaned && toWorkerScriptExecution(orphaned)).toMatchObject({
      status: 'orphaned',
      orphanIdentity: 'recorded',
    });
  });
});

describe('a confirmed group Force stop of an orphaned run whose leader exited (CAN-6601)', () => {
  const RUN_START = 1_700_000_000_000;
  const groupId = child.processGroupId ?? 0;
  interface Member {
    startIdentity: string;
    startedAtMs: number;
    group: number;
    alive: boolean;
    /** Exits on SIGTERM; otherwise only SIGKILL ends it. */
    termExits: boolean;
    /** Its environment carries the run's marker. */
    marked: boolean;
  }
  let clock = 0;
  let members: Map<number, Member>;
  let leader: 'absent' | 'reused' | 'running';
  let signals: Array<[number, string]>;
  /** Runs after the listing check, before each member's own proof. */
  let beforeProof: ((pid: number) => void) | undefined;
  beforeEach(() => {
    clock = 0;
    leader = 'absent';
    signals = [];
    beforeProof = undefined;
    markers = [];
    members = new Map([
      [5001, member('darwin:v1:5001:1700000001', RUN_START + 1000, false)],
      [5002, member('darwin:v1:5002:1700000002', RUN_START + 2000, true)],
    ]);
  });
  function member(
    startIdentity: string,
    startedAtMs: number,
    termExits: boolean,
  ): Member {
    return {
      startIdentity,
      startedAtMs,
      group: groupId,
      alive: true,
      termExits,
      marked: true,
    };
  }
  let listed = false;
  let markers: unknown[] = [];
  const supervision: Parameters<typeof listScriptRunGroup>[0]['supervision'] = {
    identifyProcess: (request) => {
      if (request.pid === child.pid) {
        if (leader === 'absent') return Promise.resolve({ state: 'absent' });
        return Promise.resolve({
          state: 'running',
          startIdentity:
            leader === 'reused' ? 'reused' : (child.startIdentity ?? ''),
          processGroupId: groupId,
          executablePath: child.executablePath ?? '',
        });
      }
      if (listed) beforeProof?.(request.pid);
      const found = members.get(request.pid);
      return Promise.resolve(
        found?.alive
          ? {
              state: 'running',
              startIdentity: found.startIdentity,
              processGroupId: found.group,
              executablePath: '/bin/sleep',
            }
          : { state: 'absent' },
      );
    },
    listProcessGroup: (request) => {
      listed = true;
      markers.push(request.runMarker);
      return Promise.resolve({
        state: 'listed',
        members: [...members]
          .filter(
            ([, found]) =>
              found.alive && found.group === request.processGroupId,
          )
          .map(([pid, found]) => ({
            pid,
            startIdentity: found.startIdentity,
            startedAtMs: found.startedAtMs,
            command: 'sleep',
            runMarker: found.marked ? ('match' as const) : ('absent' as const),
          })),
      });
    },
  };
  const kill = (target: number, signal: 'SIGTERM' | 'SIGKILL' | 0): void => {
    const esrch = (): never => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    };
    if (signal === 0) {
      if (target !== -groupId) throw new Error('Only the group is probed.');
      if (![...members.values()].some((m) => m.alive && m.group === groupId))
        esrch();
      return;
    }
    signals.push([target, signal]);
    const found = members.get(target);
    if (!found?.alive) esrch();
    if (found && (signal === 'SIGKILL' || found.termExits)) found.alive = false;
  };
  const confirmedNow = (): { pid: number; startIdentity: string }[] =>
    [...members]
      .filter(([, found]) => found.alive)
      .map(([pid, found]) => ({ pid, startIdentity: found.startIdentity }));
  const forceStop = (
    confirmed = confirmedNow(),
  ): ReturnType<typeof forceStopScriptRunGroup> => {
    listed = false;
    return forceStopScriptRunGroup({
      child,
      runStartedAtMs: RUN_START,
      runId: 'run-1',
      members: confirmed,
      supervision,
      kill,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      graceMs: 3,
      pollMs: 1,
    });
  };

  it('lists a group as offerable only when every member started no earlier than the run', async () => {
    await expect(
      listScriptRunGroup({
        child,
        runStartedAtMs: RUN_START,
        runId: 'run-1',
        supervision,
      }),
    ).resolves.toMatchObject({ kind: 'members', offerable: true });
    // A member from before the run: the group ID was reused, or the member
    // can't be tied to the run. Listed, never offered.
    members.set(
      5003,
      member('darwin:v1:5003:1699990000', RUN_START - 60_000, true),
    );
    const reused = await listScriptRunGroup({
      child,
      runStartedAtMs: RUN_START,
      runId: 'run-1',
      supervision,
    });
    expect(reused).toMatchObject({ kind: 'members', offerable: false });
    expect(reused.kind === 'members' && reused.members).toHaveLength(3);
    // A live leader, or its PID held by another process, names no group to
    // force: the first is stopped through its record, the second formed
    // after the run's group ended.
    for (const state of ['running', 'reused'] as const) {
      leader = state;
      await expect(
        listScriptRunGroup({
          child,
          runStartedAtMs: RUN_START,
          runId: 'run-1',
          supervision,
        }),
      ).resolves.toEqual({ kind: 'not_group' });
    }
    // No process groups on this host (Windows).
    await expect(
      listScriptRunGroup({
        child,
        runStartedAtMs: RUN_START,
        runId: 'run-1',
        supervision: { identifyProcess: supervision.identifyProcess },
      }),
    ).resolves.toEqual({ kind: 'unsupported' });
  });

  it("asks for the run's own marker, and refuses a reused group whose members started after the run but carry none", async () => {
    await expect(
      listScriptRunGroup({
        child,
        runStartedAtMs: RUN_START,
        runId: 'run-1',
        supervision,
      }),
    ).resolves.toMatchObject({ kind: 'members', offerable: true });
    expect(markers).toEqual([{ name: 'CANOPY_SCRIPT_RUN_ID', value: 'run-1' }]);
    // A reused group ID: every member born after the run, none carrying it.
    for (const found of members.values()) found.marked = false;
    const reused = await listScriptRunGroup({
      child,
      runStartedAtMs: RUN_START,
      runId: 'run-1',
      supervision,
    });
    expect(reused).toMatchObject({ kind: 'members', offerable: false });
    expect(
      reused.kind === 'members' &&
        reused.members.every((found) => !found.carriesRunId),
    ).toBe(true);
    await expect(forceStop()).resolves.toEqual({ kind: 'refused' });
    // One member that cleared its environment (env -i): no group action.
    for (const found of members.values()) found.marked = true;
    const cleared = members.get(5002);
    if (cleared) cleared.marked = false;
    await expect(forceStop()).resolves.toEqual({ kind: 'refused' });
    expect(signals).toEqual([]);
  });

  it('refuses a group with a member from before the run, signalling nothing', async () => {
    members.set(
      5003,
      member('darwin:v1:5003:1699990000', RUN_START - 60_000, true),
    );
    await expect(forceStop()).resolves.toEqual({ kind: 'refused' });
    expect(signals).toEqual([]);
  });

  it('stops a matching group member by member: SIGTERM to each PID, then SIGKILL only to proven survivors', async () => {
    await expect(forceStop()).resolves.toEqual({
      kind: 'done',
      outcome: 'stopped',
      members: [
        { pid: 5001, outcome: 'killed' },
        { pid: 5002, outcome: 'stopped' },
      ],
    });
    // Never the group ID.
    expect(signals).toEqual([
      [5001, 'SIGTERM'],
      [5002, 'SIGTERM'],
      [5001, 'SIGKILL'],
    ]);
  });

  it('skips a member whose PID another process holds, or that left the group, between the listing and its signal', async () => {
    beforeProof = (pid): void => {
      const found = members.get(pid);
      if (pid === 5001 && found)
        found.startIdentity = 'darwin:v1:5001:1800000000';
      if (pid === 5002 && found) found.group = 7777;
    };
    const result = await forceStop();
    expect(signals).toEqual([]);
    expect(result).toEqual({
      kind: 'done',
      outcome: 'still_running',
      members: [
        { pid: 5001, outcome: 'gone' },
        { pid: 5002, outcome: 'not_same' },
      ],
    });
  });

  it('refuses a confirmed list that misses a member now in the group', async () => {
    const seen = confirmedNow();
    members.set(
      5003,
      member('darwin:v1:5003:1700000003', RUN_START + 3000, true),
    );
    await expect(forceStop(seen)).resolves.toEqual({ kind: 'refused' });
    await expect(
      forceStop([
        { pid: 5001, startIdentity: 'darwin:v1:5001:1700000001' },
        { pid: 5002, startIdentity: 'darwin:v1:5002:0' },
        { pid: 5003, startIdentity: 'darwin:v1:5003:1700000003' },
      ]),
    ).resolves.toEqual({ kind: 'refused' });
    expect(signals).toEqual([]);
  });

  it('needs the confirmation and the members, and records the run lost only once its whole group is gone', async () => {
    await startWithChild();
    const runId = await recordedRunId();
    const stopGroup = jest.fn(
      (): ReturnType<NonNullable<ScriptRunWriterFence['stopGroup']>> =>
        Promise.resolve({
          kind: 'done',
          outcome: 'still_running',
          members: [{ pid: 5001, outcome: 'still_running' }],
        }),
    );
    const orphanedStore = store({
      ...reaping('unproven', 'unproven'),
      stopGroup,
    });
    await orphanedStore.readMetaFor(key);
    const request = {
      ...key,
      runId,
      members: [{ pid: 5001, startIdentity: 'darwin:v1:5001:1700000001' }],
    };
    await expect(
      orphanedStore.stopOrphanGroup({ ...request, confirmed: false }),
    ).resolves.toBe('unconfirmed');
    await expect(
      orphanedStore.stopOrphanGroup({
        ...request,
        members: [],
        confirmed: true,
      }),
    ).resolves.toBe('unconfirmed');
    expect(stopGroup).not.toHaveBeenCalled();
    // A member outlives the stop: the run stays orphaned.
    await orphanedStore.stopOrphanGroup({ ...request, confirmed: true });
    expect(JSON.parse(await readFile(metaPath(), 'utf8'))).toMatchObject({
      status: 'running',
      orphaned: true,
    });
    // The whole group is gone: the run is lost.
    stopGroup.mockImplementationOnce(() =>
      Promise.resolve({
        kind: 'done',
        outcome: 'stopped',
        members: [{ pid: 5001, outcome: 'killed' }],
      }),
    );
    await orphanedStore.stopOrphanGroup({ ...request, confirmed: true });
    expect(await orphanedStore.readMetaFor(key)).toMatchObject({
      runId,
      status: 'failed',
      outcome: 'lost',
    });
  });
});

it('keeps the run-log stem', () => {
  expect(scriptRunFileStem('build')).toBe('build__44575cf5b285');
  expect(scriptRunFileStem('Dev Server!')).toBe('dev-server__f29d9cb0eb73');
  expect(scriptRunFileStem('k'.repeat(200))).toBe(
    `${'k'.repeat(64)}__6de3c2886910`,
  );
});
