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
});
