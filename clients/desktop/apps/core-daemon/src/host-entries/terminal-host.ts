import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants, setPriority } from 'node:os';
import { join } from 'node:path';
import { connectExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import type {
  TerminalProcessPort,
  TerminalPtyPort,
} from '@canopy/core-runtime/node/terminal';
import { serveTerminalHost } from '@canopy/core-runtime/node/terminal/host/server';

// The daemon's terminal host (CAN-5088): the terminal engine over the
// daemon's own Node-ABI node-pty, staged beside the executable as node-pty/
// (CAN-5068), so a native PTY fault ends this process and its terminals only.
// On Windows node-pty runs ConPTY, and this host starts suspended inside its
// own kill-on-close job object, so its terminals end with it (CAN-5091).

function isPtyModule(value: unknown): value is TerminalPtyPort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'spawn') === 'function'
  );
}

function errnoCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

function exists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ESRCH') return false;
    throw error;
  }
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error('Invalid owned process id.');
}

function lowerPriority(pid: number): void {
  try {
    setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Priority is advisory.
  }
}

const posixProcesses: TerminalProcessPort = {
  killWindowsTree: (_pid, onFailure) => onFailure(),
  drainOwned: async (pid, isOwned) => {
    assertPid(pid);
    for (const target of [-pid, pid]) {
      if (!isOwned())
        throw new Error('The terminal process ownership changed.');
      try {
        process.kill(target, 'SIGKILL');
      } catch (error) {
        if (errnoCode(error) !== 'ESRCH') throw error;
      }
    }
    const deadline = Date.now() + 5_000;
    let ownershipReleased = false;
    const groupExists = (): boolean => {
      try {
        return exists(-pid);
      } catch (error) {
        // An unsignalable group member leaves nothing waitable by this host.
        if (errnoCode(error) === 'EPERM') return false;
        throw error;
      }
    };
    while (true) {
      // Root exit can precede descendant exit. Stop probing the reusable root
      // PID once ownership is released, but keep waiting for its process group.
      ownershipReleased ||= !isOwned();
      if ((ownershipReleased || !exists(pid)) && !groupExists()) break;
      if (Date.now() >= deadline) {
        // Unreaped zombies can retain the group ID after the root has exited.
        if (ownershipReleased) return;
        throw new Error('An owned terminal process did not exit.');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  },
  lowerPriority,
  // Only Windows probes a terminal's foreground process.
  probe: () => Promise.resolve(null),
};

/** taskkill from System32, never a PATH lookup. */
function taskkill(): string {
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'taskkill.exe',
  );
}

// taskkill /t without /f fails on hidden-console children, so Windows always
// forces, as the in-process engine and core-platform's kill-tree do.
const windowsProcesses: TerminalProcessPort = {
  killWindowsTree: (pid, onFailure) => {
    let failed = false;
    const fail = (): void => {
      if (failed) return;
      failed = true;
      onFailure();
    };
    try {
      const child = spawn(taskkill(), ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', fail);
      child.once('exit', (code) => {
        if (code !== 0) fail();
      });
    } catch {
      fail();
    }
  },
  drainOwned: async (pid, isOwned) => {
    assertPid(pid);
    if (!isOwned()) throw new Error('The terminal process ownership changed.');
    // taskkill's exit code never proves absence; only the probe after it does.
    await new Promise<void>((settle) => {
      execFile(
        taskkill(),
        ['/pid', String(pid), '/t', '/f'],
        { windowsHide: true, timeout: 5_000 },
        () => settle(),
      );
    });
    const deadline = Date.now() + 5_000;
    // Once the root reports exit, never probe a possibly reused PID.
    while (isOwned() && exists(pid)) {
      if (Date.now() >= deadline)
        throw new Error('An owned terminal process did not exit.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  },
  lowerPriority,
  probe: (file, args, timeoutMs) =>
    new Promise((resolve) => {
      try {
        execFile(
          file,
          args,
          { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
          (error, stdout) => {
            resolve(error || typeof stdout !== 'string' ? null : stdout);
          },
        );
      } catch {
        resolve(null);
      }
    }),
};

const channel = connectExecutionHostChannel();
if (!channel) throw new Error('Launched without an execution host channel.');
const platform = process.platform;
if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32')
  throw new Error('Daemon terminals run on macOS, Linux and Windows only.');
const directory = join(__dirname, '..', 'node-pty');
const pty: unknown = createRequire(join(directory, 'package.json'))(directory);
if (!isPtyModule(pty)) throw new Error('The staged node-pty is unusable.');
serveTerminalHost({
  channel,
  pty,
  processes: platform === 'win32' ? windowsProcesses : posixProcesses,
  platform,
  variable: (name) => process.env[name],
  log: {
    warn: (message, details) => {
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', message, details: details ?? null })}\n`,
      );
    },
  },
});
