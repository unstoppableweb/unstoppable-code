import { spawn } from 'node:child_process';

import { desktopScriptRunWriterFence } from '../script-run-writer-fence';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

function exitedChildPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', () => {
      if (child.pid === undefined) reject(new Error('The child had no PID.'));
      else resolve(child.pid);
    });
  });
}

describePosix('desktopScriptRunWriterFence', () => {
  it('reports this process running and a finished child gone', async () => {
    const self = await desktopScriptRunWriterFence.self();
    expect(self?.pid).toBe(process.pid);
    if (self === null) return;
    await expect(desktopScriptRunWriterFence.inspect(self)).resolves.toBe(
      'running',
    );
    const pid = await exitedChildPid();
    await expect(
      desktopScriptRunWriterFence.inspect({ pid, startIdentity: 'child' }),
    ).resolves.toBe('gone');
    await expect(
      desktopScriptRunWriterFence.inspect({
        pid: process.pid,
        startIdentity: 'other',
      }),
    ).resolves.toBe('gone');
  });

  it('never kills a process the daemon left, and reports it gone once it exits (CAN-6482)', async () => {
    const live = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const pid = live.pid;
    if (pid === undefined) throw new Error('No sleep process.');
    try {
      await expect(
        desktopScriptRunWriterFence.reapChild?.({ pid }),
      ).resolves.toBe('unproven');
      expect(live.exitCode).toBeNull();
      expect(live.signalCode).toBeNull();
    } finally {
      live.kill('SIGKILL');
    }
    await new Promise((resolve) => live.once('exit', resolve));
    await expect(
      desktopScriptRunWriterFence.reapChild?.({ pid: await exitedChildPid() }),
    ).resolves.toBe('gone');
  });
});
