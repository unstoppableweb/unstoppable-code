import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { WorkerScriptDescriptor } from '@canopy/protocol/canopy-core';

import {
  ScriptRunLogStore,
  scriptRunFileStem,
  type ScriptRunChild,
  type ScriptRunChildStop,
  type ScriptRunChildStopMode,
  type ScriptRunWriterFence,
} from '..';
import { createScriptWorkerFixture, SCOPE } from './script-worker-fixtures';

/*
 * CAN-7520: a host that signals only an identified record refuses a Stop of
 * a PID-only record as `unverifiable` before asking for confirmation, and
 * signals nothing; a host without that rule keeps today's confirmed Stop.
 */

const script: WorkerScriptDescriptor = {
  scriptKey: 'build',
  scriptName: 'build',
  label: 'Build',
  command: 'make',
  lifecycle: 'custom',
  target: 'project',
};
const key = {
  projectId: SCOPE.workspaceId,
  worktreeId: SCOPE.worktreeId,
  scriptKey: 'build',
};
const identified: ScriptRunChild = {
  pid: 4242,
  processGroupId: 4242,
  startIdentity: 'darwin:v1:4242:1700000000',
  executablePath: '/bin/sh',
};
const pidOnly: ScriptRunChild = { pid: 4242 };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'script-run-pid-only-stop-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runDir(projectId: string, worktreeId: string): string {
  return join(dir, 'runs', projectId, worktreeId);
}

function metaPath(): string {
  return join(
    runDir(key.projectId, key.worktreeId),
    `${scriptRunFileStem('build')}.json`,
  );
}

function store(writerFence?: ScriptRunWriterFence): ScriptRunLogStore {
  return new ScriptRunLogStore({
    paths: { runDir, fileStem: scriptRunFileStem },
    files: {
      writeFileAtomically: async (path, text): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, text, 'utf8');
        await rename(temp, path);
      },
    },
    ...(writerFence ? { writerFence } : {}),
  });
}

/** A run a restart left running, recorded orphaned with `child` as written. */
async function orphaned(child: ScriptRunChild): Promise<string> {
  const ref = await store().start({
    projectId: key.projectId,
    worktreeId: key.worktreeId,
    script,
    invocation: 'manual-run',
  });
  const meta: unknown = JSON.parse(await readFile(metaPath(), 'utf8'));
  await writeFile(
    metaPath(),
    JSON.stringify({
      ...(typeof meta === 'object' && meta !== null ? meta : {}),
      status: 'running',
      orphaned: true,
      child,
    }),
  );
  return ref.runId;
}

function stopping(): ScriptRunWriterFence & {
  stopChild: jest.Mock<
    Promise<ScriptRunChildStop>,
    [ScriptRunChild, ScriptRunChildStopMode]
  >;
} {
  return {
    self: () => Promise.resolve({ pid: 202, startIdentity: 'b' }),
    inspect: () => Promise.resolve('gone'),
    stopChild: jest.fn<
      Promise<ScriptRunChildStop>,
      [ScriptRunChild, ScriptRunChildStopMode]
    >(() => Promise.resolve('stopped')),
  };
}

/** The daemon's shape: it signals only an identified record. */
function refusing(): ReturnType<typeof stopping> {
  const fence = stopping();
  return Object.assign(fence, { refusesUnidentifiedStop: true as const });
}

async function recorded(): Promise<unknown> {
  return JSON.parse(await readFile(metaPath(), 'utf8'));
}

it('refuses a PID-only Stop as unverifiable before any confirmation, and signals nothing', async () => {
  const runId = await orphaned(pidOnly);
  const fence = refusing();
  for (const mode of ['stop', 'force'] as const)
    for (const confirmed of [false, true])
      await expect(
        store(fence).stopOrphan({ ...key, runId, mode, confirmed }),
      ).resolves.toBe('unverifiable');
  expect(fence.stopChild).not.toHaveBeenCalled();
  // Nothing proved the process ended, so the run stays orphaned, not lost.
  expect(await recorded()).toMatchObject({
    runId,
    status: 'running',
    orphaned: true,
    child: pidOnly,
  });
});

it('still stops an identified record on that host as before', async () => {
  const runId = await orphaned(identified);
  const fence = refusing();
  await expect(
    store(fence).stopOrphan({ ...key, runId, mode: 'force', confirmed: false }),
  ).resolves.toBe('unconfirmed');
  expect(fence.stopChild).not.toHaveBeenCalled();
  await expect(
    store(fence).stopOrphan({ ...key, runId, mode: 'stop', confirmed: false }),
  ).resolves.toBe('stopped');
  expect(fence.stopChild).toHaveBeenCalledWith(identified, 'stop');
  expect(await recorded()).toMatchObject({ status: 'failed', outcome: 'lost' });
});

it("keeps a confirmed PID-only Stop on a host without the rule (Electron main's)", async () => {
  const runId = await orphaned(pidOnly);
  const fence = stopping();
  await expect(
    store(fence).stopOrphan({ ...key, runId, mode: 'stop', confirmed: false }),
  ).resolves.toBe('unconfirmed');
  expect(fence.stopChild).not.toHaveBeenCalled();
  await expect(
    store(fence).stopOrphan({ ...key, runId, mode: 'force', confirmed: true }),
  ).resolves.toBe('stopped');
  expect(fence.stopChild).toHaveBeenCalledWith(pidOnly, 'force');
});

it('answers worker.script.execution.stop with unverifiable, never confirmationRequired, on that host', async () => {
  const fence = refusing();
  const fixture = await createScriptWorkerFixture({
    host: { writerFence: fence },
  });
  try {
    await rm(dir, { recursive: true, force: true });
    dir = fixture.dir;
    const runId = await orphaned(pidOnly);
    for (const mode of ['stop', 'force'] as const)
      await expect(
        fixture.worker.stopOrphan({
          scope: SCOPE,
          scriptKey: 'build',
          executionId: runId,
          mode,
        }),
      ).resolves.toEqual({ outcome: 'unverifiable' });
    await expect(
      fixture.worker.stopOrphan({
        scope: SCOPE,
        scriptKey: 'build',
        executionId: runId,
        mode: 'force',
        confirmed: true,
      }),
    ).resolves.toEqual({ outcome: 'unverifiable' });
    expect(fence.stopChild).not.toHaveBeenCalled();
  } finally {
    await fixture.cleanup();
  }
});
