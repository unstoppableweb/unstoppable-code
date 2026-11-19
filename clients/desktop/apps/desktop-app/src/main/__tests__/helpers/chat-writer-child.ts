/**
 * Parent side of the CAN-7176 child chat writer: starts the writer as its own
 * Node process (the electron-refusing preload hooks plus the repository's tsx
 * loader, no bundling), sends it workload steps over a Unix socket, and kills
 * it with SIGKILL. Each writer leads its own process group (spawned detached,
 * pgid = pid) under a hard timeout. Only the groups this module started are
 * ever signalled, never a process by name, and each kill waits for the
 * writer to exit.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const REPO_ROOT = resolve(__dirname, '../../../../../..');
export const CHILD_PRELOAD = pathToFileURL(
  join(__dirname, 'chat-writer-child-preload.ts'),
).href;
const CHILD_ENTRY = join(__dirname, 'chat-writer-child-entry.ts');

/**
 * The Electron binary the package unpacks when plain Node loads it, as
 * identity and modification time per path, or `absent`. A suite compares
 * it before and after, so an unpack cannot happen silently.
 */
export function electronBinarySnapshot(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ['dist', 'path.txt']) {
    const path = join(REPO_ROOT, 'node_modules', 'electron', name);
    try {
      const stats = statSync(path);
      result[name] = `${stats.ino}:${stats.mtimeMs}`;
    } catch {
      result[name] = 'absent';
    }
  }
  return result;
}

/** A writer still running after this long is killed with its group. */
const HARD_TIMEOUT_MS = 50_000;

/** macOS caps a Unix socket path at 104 bytes, including the terminator. */
const MAX_SOCKET_PATH_BYTES = 103;

export function socketPathFor(directory: string): string {
  const path = join(directory, 'w.sock');
  const bytes = Buffer.byteLength(path);
  if (bytes > MAX_SOCKET_PATH_BYTES)
    throw new Error(
      `The child writer's socket path is ${bytes} bytes, over the macOS limit of ${MAX_SOCKET_PATH_BYTES}: ${path}. Use a shorter TMPDIR.`,
    );
  return path;
}

export interface Reply {
  step: number;
  revision: number;
  applied: boolean;
}

export interface ChildWriter {
  readonly pid: number;
  /** Sends one step; resolves with its reply, rejects if the writer dies first. */
  send(step: number): Promise<Reply>;
  /** Resolves with the boundary once the writer prints its pause marker. */
  readonly paused: Promise<string>;
  /** SIGKILLs this writer's process group and waits for the writer to exit. */
  kill(): Promise<void>;
}

interface Started {
  child: ChildProcess;
  /** The writer's process group: it is the group leader, so pgid = pid. */
  pgid: number;
  timeout: ReturnType<typeof setTimeout>;
}

/** Every writer this module started that has not been reaped, by pgid. */
const started = new Map<number, Started>();
/** Every process group this module ever started, reaped or not. */
const groups = new Set<number>();

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Process groups this module started that still have a live member. */
export function liveChildGroups(): number[] {
  return [...groups].filter(groupAlive);
}

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // The group has already gone.
  }
}

async function stop({ child, pgid, timeout }: Started): Promise<void> {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    killGroup(pgid);
    await exited;
  } else {
    killGroup(pgid);
  }
  started.delete(pgid);
}

/** Kills and reaps every writer this module started. */
export async function reapChildWriters(): Promise<void> {
  await Promise.all([...started.values()].map(stop));
}

export async function startChildWriter(options: {
  root: string;
  socketDirectory: string;
  pauseStep?: string;
  pauseAt?: string;
}): Promise<ChildWriter> {
  const socketPath = socketPathFor(options.socketDirectory);
  const child = spawn(
    process.execPath,
    ['--import', CHILD_PRELOAD, '--import', 'tsx', CHILD_ENTRY],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.base.json'),
        CANOPY_DATA_DIR: options.root,
        R0_WRITER_ROOT: options.root,
        R0_WRITER_SOCKET: socketPath,
        ...(options.pauseStep ? { R0_PAUSE_STEP: options.pauseStep } : {}),
        ...(options.pauseAt ? { R0_PAUSE_AT: options.pauseAt } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error('The child writer did not start');
  const entry: Started = {
    child,
    pgid: pid,
    timeout: setTimeout(() => killGroup(pid), HARD_TIMEOUT_MS),
  };
  started.set(pid, entry);
  groups.add(pid);

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout ?? process.stdin });
  const exited = once(child, 'exit').then((): never => {
    throw new Error(`The child writer exited: ${stderr.slice(-2000)}`);
  });
  exited.catch(() => undefined);
  const marker = (prefix: string): Promise<string> =>
    Promise.race([
      new Promise<string>((resolveMarker) => {
        lines.on('line', (line) => {
          if (line.startsWith(prefix))
            resolveMarker(line.slice(prefix.length).trim());
        });
      }),
      exited,
    ]);
  const paused = marker('paused ');
  paused.catch(() => undefined);
  await marker('ready');

  const socket: Socket = createConnection(socketPath);
  await once(socket, 'connect');
  const replies = createInterface({ input: socket });
  const waiting = new Map<number, (reply: Reply) => void>();
  replies.on('line', (line) => {
    const reply: unknown = JSON.parse(line);
    if (
      typeof reply === 'object' &&
      reply !== null &&
      'step' in reply &&
      'revision' in reply &&
      'applied' in reply &&
      typeof reply.step === 'number' &&
      typeof reply.revision === 'number' &&
      typeof reply.applied === 'boolean'
    )
      waiting.get(reply.step)?.({
        step: reply.step,
        revision: reply.revision,
        applied: reply.applied,
      });
  });
  const closed = once(socket, 'close').then((): never => {
    throw new Error('The child writer closed its socket without replying');
  });
  closed.catch(() => undefined);

  return {
    pid,
    paused,
    send: (step: number): Promise<Reply> => {
      const reply = new Promise<Reply>((resolveReply) =>
        waiting.set(step, resolveReply),
      );
      socket.write(`${JSON.stringify({ step })}\n`);
      return Promise.race([reply, closed]);
    },
    kill: async (): Promise<void> => {
      await stop(entry);
      socket.destroy();
    },
  };
}
