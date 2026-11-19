/**
 * CAN-4475 R0-F1 across a process boundary (CAN-7176): a chat writer in its
 * own process acknowledges each command over a Unix socket only after the
 * commit resolves. Killed with SIGKILL before its reply, the client never
 * sees the command as saved, the reopened scope holds it exactly once, and a
 * retry with the same mutation id is already applied at the same revision.
 * Killed after its reply, the reopened scope is at the reply's revision.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  STEPS,
  observe,
  openAt,
  referenceStates,
  scope,
  useR0Root,
  type Observed,
} from './helpers/chat-r0-commit-workload';
import {
  CHILD_PRELOAD,
  electronBinarySnapshot,
  liveChildGroups,
  reapChildWriters,
  socketPathFor,
  startChildWriter,
} from './helpers/chat-writer-child';

// A child cold-starts in about 11 s (its loader transpiles the main graph)
// and in about 4 s once its cache is warm.
jest.setTimeout(60_000);

const root = useR0Root();
let expected: Observed[] | undefined;

// The child mocks electron: this proves the repository and journal under
// SIGKILL, not Electron's own process. The daemon writer's pass closes that.
const electronBefore = electronBinarySnapshot();

afterEach(async () => {
  await reapChildWriters();
});

afterAll(() => {
  expect(liveChildGroups()).toEqual([]);
  expect(electronBinarySnapshot()).toEqual(electronBefore);
});

it('R0-F1 child writer: the preload refuses the electron package before it loads', async () => {
  // A stand-in package that only records being loaded, so a broken guard
  // fails this test without the real package being reached or unpacked.
  const fake = join(root(), 'fake');
  const marker = join(root(), 'fake-electron-loaded');
  await mkdir(join(fake, 'node_modules', 'electron'), { recursive: true });
  await writeFile(
    join(fake, 'node_modules', 'electron', 'index.js'),
    "require('node:fs').writeFileSync(process.env.R0_FAKE_ELECTRON_MARKER, 'loaded');\n",
  );
  const result = spawnSync(
    process.execPath,
    ['--import', CHILD_PRELOAD, '-e', "require('electron/index.js')"],
    {
      cwd: fake,
      encoding: 'utf8',
      env: { ...process.env, R0_FAKE_ELECTRON_MARKER: marker },
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    'The child chat writer refuses the real electron package',
  );
  expect(existsSync(marker)).toBe(false);
});

it('R0-F1 child writer: a socket path over the macOS limit fails with a clear error', () => {
  expect(() => socketPathFor(join('/', 'x'.repeat(120)))).toThrow(
    /over the macOS limit of 103/,
  );
});

it.each(['record-written', 'record-synced'])(
  'R0-F1 child writer killed at %s, before its reply: the command is never acknowledged, the reopened scope holds it once, and a same-key retry is already applied',
  async (boundary) => {
    expected ??= await referenceStates(join(root(), 'reference'), 'format 4');
    const at = join(root(), 'w');
    const writer = await startChildWriter({
      root: at,
      socketDirectory: root(),
      pauseStep: 'send',
      pauseAt: boundary,
    });
    expect(await writer.send(0)).toEqual({
      step: 0,
      revision: 1,
      applied: true,
    });
    const send = writer.send(1);
    send.catch(() => undefined);
    expect(await writer.paused).toBe(boundary);
    await writer.kill();
    await expect(send).rejects.toThrow(/without replying|exited/);

    // The record's bytes reached the file before the kill, so they survive
    // the process: durable on reopen, though never acknowledged.
    const reopened = openAt(at, 'format 4');
    expect(await observe(reopened)).toEqual(expected[2]);
    const retry = await reopened.transact(
      scope,
      STEPS[1].mutations,
      STEPS[1].options,
    );
    expect(retry.applied).toBe(false);
    expect(retry.revision).toBe(2);
    expect(await observe(reopened)).toEqual(expected[2]);
  },
);

it('R0-F1 child writer killed after its reply: the reopened scope is at the acknowledged revision', async () => {
  expected ??= await referenceStates(join(root(), 'reference'), 'format 4');
  const at = join(root(), 'w');
  const writer = await startChildWriter({ root: at, socketDirectory: root() });
  await writer.send(0);
  const reply = await writer.send(1);
  expect(reply).toEqual({ step: 1, revision: 2, applied: true });
  await writer.kill();

  const reopened = openAt(at, 'format 4');
  const state = await observe(reopened);
  expect(state).toEqual(expected[reply.revision]);
  expect(state.receiptRevision).toBe(reply.revision);
});
