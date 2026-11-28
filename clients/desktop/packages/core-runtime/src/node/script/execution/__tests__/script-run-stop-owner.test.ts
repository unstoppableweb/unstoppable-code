import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkerScriptDescriptor } from '@canopy/protocol/canopy-core';

import {
  ScriptRunLogStore,
  scriptRunFileStem,
  type ScriptRunChild,
  type ScriptRunChildReap,
  type ScriptRunChildStop,
  type ScriptRunSpawner,
  type ScriptRunStopOwnership,
  type ScriptRunWriter,
  type ScriptRunWriterFence,
} from '..';

// Any run a host may not end is refused as `not_owner` and nothing is signalled.

const script: WorkerScriptDescriptor = {
  scriptKey: 'build',
  scriptName: 'build',
  label: 'Build',
  command: 'make',
  lifecycle: 'custom',
  target: 'project',
};
const target = { projectId: 'project', worktreeId: 'task' };
const identified: ScriptRunChild = {
  pid: 4242,
  processGroupId: 4242,
  startIdentity: 'darwin:v1:4242:1700000000',
  executablePath: '/bin/sh',
};
const writer: ScriptRunWriter = { pid: 101, startIdentity: 'a' };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'script-run-stop-owner-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeAtomically(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, path);
}

function store(writerFence: ScriptRunWriterFence): ScriptRunLogStore {
  return new ScriptRunLogStore({
    paths: {
      runDir: (projectId, worktreeId): string =>
        join(dir, projectId, worktreeId),
      fileStem: scriptRunFileStem,
    },
    files: { writeFileAtomically: writeAtomically },
    writerFence,
  });
}

function metaPath(): string {
  return join(dir, 'project', 'task', `${scriptRunFileStem('build')}.json`);
}

async function readRaw(): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(metaPath(), 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Unreadable metadata.');
  return Object.fromEntries(Object.entries(value));
}

async function orphanBy(
  spawner: string | undefined,
  child: ScriptRunChild = identified,
): Promise<string> {
  const starter = store({
    self: () => Promise.resolve(writer),
    inspect: () => Promise.resolve('running'),
    identifyChild: () => Promise.resolve(child),
  });
  const ref = await starter.start({
    ...target,
    script,
    invocation: 'manual-run',
  });
  await starter.recordChild({ ref, pid: child.pid });
  const raw = await readRaw();
  delete raw.spawner;
  await writeAtomically(
    metaPath(),
    JSON.stringify({
      ...raw,
      orphaned: true,
      ...(spawner !== undefined ? { spawner } : {}),
    }),
  );
  return ref.runId;
}

function host(
  spawner: ScriptRunSpawner | undefined,
  stopOwnership: ScriptRunStopOwnership | undefined,
): ScriptRunWriterFence & {
  stopChild: jest.Mock<Promise<ScriptRunChildStop>, [ScriptRunChild, string]>;
  stopGroup: jest.Mock;
  reapChild: jest.Mock<Promise<ScriptRunChildReap>, [ScriptRunChild]>;
} {
  return {
    ...(spawner ? { spawner } : {}),
    ...(stopOwnership ? { stopOwnership } : {}),
    self: () => Promise.resolve({ pid: 202, startIdentity: 'b' }),
    inspect: () => Promise.resolve('gone'),
    reapChild: jest.fn<Promise<ScriptRunChildReap>, [ScriptRunChild]>(() =>
      Promise.resolve('unproven'),
    ),
    stopChild: jest.fn<Promise<ScriptRunChildStop>, [ScriptRunChild, string]>(
      () => Promise.resolve('stopped'),
    ),
    stopGroup: jest.fn(() =>
      Promise.resolve({
        kind: 'done' as const,
        outcome: 'stopped' as const,
        members: [],
      }),
    ),
  };
}

const stopArgs = (
  runId: string,
): Parameters<ScriptRunLogStore['stopOrphan']>[0] => ({
  ...target,
  scriptKey: 'build',
  runId,
  mode: 'stop' as const,
  confirmed: false,
});

describe('a Stop ends only a run its host may end (CAN-7586)', () => {
  // [record spawner, host spawner, host ownership, may stop]
  const cases: [
    string | undefined,
    ScriptRunSpawner | undefined,
    ScriptRunStopOwnership | undefined,
    boolean,
  ][] = [
    // The daemon: only its own runs.
    ['daemon', 'daemon', 'own', true],
    ['electron', 'daemon', 'own', false],
    [undefined, 'daemon', 'own', false],
    ['future-host', 'daemon', 'own', false],
    ['unreadable', 'daemon', 'own', false],
    // Electron main where Stop routes: its own runs and earlier records.
    ['electron', 'electron', 'own-or-legacy', true],
    [undefined, 'electron', 'own-or-legacy', true],
    ['daemon', 'electron', 'own-or-legacy', false],
    ['future-host', 'electron', 'own-or-legacy', false],
    // No ownership (Electron main on Windows, an earlier host): any run.
    ['daemon', 'electron', undefined, true],
    ['future-host', undefined, undefined, true],
    [undefined, undefined, undefined, true],
  ];

  it.each(cases)(
    'a run by %p on a %p host with %p ownership: stopped %p',
    async (recorded, spawner, ownership, mayStop) => {
      const runId = await orphanBy(recorded);
      const fence = host(spawner, ownership);
      const outcome = await store(fence).stopOrphan(stopArgs(runId));
      if (mayStop) {
        expect(outcome).toBe('stopped');
        expect(fence.stopChild).toHaveBeenCalledTimes(1);
      } else {
        expect(outcome).toBe('not_owner');
        expect(fence.stopChild).not.toHaveBeenCalled();
        // A refused Stop leaves the run orphaned, as written.
        expect(await readRaw()).toMatchObject({
          status: 'running',
          orphaned: true,
        });
      }
    },
  );

  it("refuses another host's PID-only run as not_owner before anything else", async () => {
    const runId = await orphanBy('electron', { pid: 4242 });
    const fence = {
      ...host('daemon', 'own'),
      refusesUnidentifiedStop: true as const,
    };
    expect(
      await store(fence).stopOrphan({ ...stopArgs(runId), confirmed: true }),
    ).toBe('not_owner');
    expect(fence.stopChild).not.toHaveBeenCalled();
  });

  it("refuses a group Force stop of another host's run, signalling no member", async () => {
    const runId = await orphanBy('electron');
    const fence = host('daemon', 'own');
    expect(
      await store(fence).stopOrphanGroup({
        ...target,
        scriptKey: 'build',
        runId,
        confirmed: true,
        members: [{ pid: 4243, startIdentity: 'member' }],
      }),
    ).toBe('not_owner');
    expect(fence.stopGroup).not.toHaveBeenCalled();
    const own = host('electron', 'own-or-legacy');
    expect(
      await store(own).stopOrphanGroup({
        ...target,
        scriptKey: 'build',
        runId,
        confirmed: true,
        members: [{ pid: 4243, startIdentity: 'member' }],
      }),
    ).toMatchObject({ kind: 'done', outcome: 'stopped' });
    expect(own.stopGroup).toHaveBeenCalledTimes(1);
  });
});

describe("an orphaned run's spawner, read to route its Stop (CAN-7586)", () => {
  it('reads the spawner as written, never reaping the run', async () => {
    for (const recorded of ['daemon', 'electron', 'future-host', undefined]) {
      const runId = await orphanBy(recorded);
      const fence = host('electron', 'own-or-legacy');
      expect(
        await store(fence).orphanSpawner({
          ...target,
          scriptKey: 'build',
          runId,
        }),
      ).toEqual({ spawner: recorded });
      expect(fence.reapChild).not.toHaveBeenCalled();
      expect(await readRaw()).toMatchObject({
        status: 'running',
        orphaned: true,
      });
    }
  });

  it('answers absent for another run and not_orphaned for a run that is not orphaned', async () => {
    const runId = await orphanBy('daemon');
    const fence = host('electron', 'own-or-legacy');
    expect(
      await store(fence).orphanSpawner({
        ...target,
        scriptKey: 'build',
        runId: 'another-run',
      }),
    ).toBe('absent');
    const raw = await readRaw();
    delete raw.orphaned;
    await writeAtomically(metaPath(), JSON.stringify(raw));
    expect(
      await store(fence).orphanSpawner({
        ...target,
        scriptKey: 'build',
        runId,
      }),
    ).toBe('not_orphaned');
    expect(fence.reapChild).not.toHaveBeenCalled();
  });
});
