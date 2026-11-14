import { spawn } from 'node:child_process';

import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';

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
      // Another start identity holds the PID: the recorded process ended.
      await expect(
        desktopScriptRunWriterFence.reapChild?.({
          pid,
          startIdentity: 'an-earlier-process',
        }),
      ).resolves.toBe('gone');
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

  it('keeps a run orphaned while its recorded group outlives its leader (CAN-6482)', async () => {
    // The leader exits at once; its member stays in the group.
    const leader = spawn('/bin/sh', ['-c', '/bin/sleep 30 & exit 0'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = leader.pid;
    if (pid === undefined) throw new Error('No leader process.');
    try {
      await new Promise((resolve) => leader.once('exit', resolve));
      await expect(
        desktopScriptRunWriterFence.reapChild?.({
          pid,
          processGroupId: pid,
          startIdentity: 'recorded',
          executablePath: '/bin/sh',
        }),
      ).resolves.toBe('unproven');
      expect(() => process.kill(-pid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  it('force stops the group a leader left, member by member, as the daemon does (CAN-6601)', async () => {
    const runStartedAtMs = Date.now();
    // A node member that ignores SIGTERM, carrying the run's marker: macOS
    // shows the environment only of programs that aren't Apple's own.
    const node = JSON.stringify(process.execPath);
    const leader = spawn(
      '/bin/sh',
      [
        '-c',
        `${node} -e "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)" & sleep 0.5; exit 0`,
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, CANOPY_SCRIPT_RUN_ID: 'run-1' },
      },
    );
    const pid = leader.pid;
    if (pid === undefined) throw new Error('No leader process.');
    const exited = new Promise((resolve) => leader.once('exit', resolve));
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const found = await hostPlatformServices(
        createPlatformEndpointServices(hostPlatformOperatingSystem()),
      ).supervision.identifyProcess?.({ pid });
      if (found?.state !== 'running') throw new Error('Not identified.');
      const recorded = {
        pid,
        processGroupId: found.processGroupId,
        startIdentity: found.startIdentity,
        executablePath: found.executablePath,
      };
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(
        desktopScriptRunWriterFence.stopChild?.(recorded, 'stop'),
      ).resolves.toBe('group_remains');
      const listing = await desktopScriptRunWriterFence.listGroup?.(
        recorded,
        runStartedAtMs,
        'run-1',
      );
      if (listing?.kind !== 'members') throw new Error('No members.');
      expect(listing).toMatchObject({ offerable: true });
      expect(listing.members).toHaveLength(1);
      // A list that misses nothing but names another start identity: refused.
      const [member] = listing.members;
      if (!member) throw new Error('No member.');
      await expect(
        desktopScriptRunWriterFence.stopGroup?.(
          recorded,
          runStartedAtMs,
          'run-1',
          [{ pid: member.pid, startIdentity: `${member.startIdentity}-other` }],
        ),
      ).resolves.toEqual({ kind: 'refused' });
      expect(() => process.kill(-pid, 0)).not.toThrow();
      await expect(
        desktopScriptRunWriterFence.stopGroup?.(
          recorded,
          runStartedAtMs,
          'run-1',
          listing.members,
        ),
      ).resolves.toEqual({
        kind: 'done',
        outcome: 'stopped',
        members: [{ pid: member.pid, outcome: 'killed' }],
      });
      expect(() => process.kill(-pid, 0)).toThrow();
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }, 30_000);
});
