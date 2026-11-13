/**
 * Worktree teardown must stop every owned script process, including descendants.
 * runShellScript exercises the worker.script.execute process runner through the
 * desktop host adapter, and worktree drain stops its real OS process tree.
 * Cancellation flows live in Electron goldens; executable qualification and
 * focused buffer regressions remain in ignored scratch.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDSHAKE_SOURCE } from './runner-fixtures/handshake';

// Keep the desktop monitoring service off the import path; execution,
// signals, pipes and process cleanup below all use real OS processes.
jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: (): {
    registerProcess(): { unregister(): void };
  } => ({
    registerProcess: (): { unregister(): void } => ({
      unregister: (): void => undefined,
    }),
  }),
}));

import {
  drainWorktreeShellScripts,
  runShellScript,
} from '../lib/script-runner';

const posix = process.platform === 'win32' ? describe.skip : describe;
const execFile = promisify(execFileCallback);

async function isLiveProcess(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    try {
      const value = await readFile(`/proc/${pid}/stat`, 'utf8');
      // Zombies are not live descendants or writers, even if init has not
      // reaped them yet. Probe once, never retry waiting for external reaping.
      return !['Z', 'X'].includes(
        value.slice(value.lastIndexOf(')') + 2).split(/\s+/)[0],
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return false;
      throw error;
    }
  }
  try {
    const { stdout } = await execFile('/bin/ps', [
      '-p',
      String(pid),
      '-o',
      'stat=',
    ]);
    return stdout.trim().length > 0 && !stdout.trim().startsWith('Z');
  } catch (error) {
    // ps returns 1 when the process no longer exists.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 1
    )
      return false;
    throw error;
  }
}
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

posix('CAN-3211 worktree script cleanup', () => {
  let directory: string;
  let fixture: string;
  let originalShell: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'runner-'));
    // Ubuntu's interactive system bashrc prints sudo onboarding in a fresh
    // HOME unless hushlogin exists. Keep it out of the isolated fixture HOME
    // without changing the production shell argv or the user's script.
    await writeFile(join(directory, '.hushlogin'), '');
    fixture = join(directory, 'handshake.cjs');
    await writeFile(fixture, HANDSHAKE_SOURCE);
    originalShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
  });

  afterEach(async () => {
    await drainWorktreeShellScripts('runner-contract', 'owned-tree');
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    await rm(directory, { recursive: true, force: true });
  });

  it('worktree drain leaves no owned child or grandchild', async () => {
    const ready = deferred<number[]>();
    const result = runShellScript({
      script: `exec ${quote(process.execPath)} ${quote(fixture)} tree`,
      cwd: directory,
      env: {
        HOME: directory,
        PATH: '/usr/bin:/bin',
        RUNNER_FIXTURE_ROOT: directory,
      },
      tracking: {
        projectId: 'runner-contract',
        worktreeId: 'owned-tree',
        scriptKey: 'fixture',
      },
      onChunk: (lines) => {
        const tree = lines.find((line) => line.startsWith('tree:'));
        if (tree) ready.resolve(tree.slice(5).split(',').map(Number));
      },
    });
    const pids = await ready.promise;
    expect(pids).toHaveLength(3);
    for (const pid of pids) expect(await isLiveProcess(pid)).toBe(true);
    await drainWorktreeShellScripts('runner-contract', 'owned-tree');
    expect((await result).success).toBe(false);
    for (const pid of pids) {
      expect(await isLiveProcess(pid)).toBe(false);
    }
  });
});
