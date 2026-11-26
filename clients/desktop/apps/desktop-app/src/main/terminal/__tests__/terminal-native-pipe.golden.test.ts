/**
 * CAN-3238: real Linux slave-PTY closure through the production TerminalEngine
 * and pinned node-pty. Unlike Windows' separate input pipe, Unix uses a PTY:
 * read EIO may turn write into a no-op before any write error is observable.
 * Never manufacture EPIPE, patch a descriptor, or replace the write transport.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPty } from 'node-pty';
import type * as NodePty from 'node-pty';
import type * as NodeFs from 'node:fs';
import type { PersistedTerminalEntry } from '@canopy/protocol/terminal';
import { TerminalEngine } from '@canopy/core-runtime/node/terminal/engine';
import type { TerminalEngineHost } from '@canopy/core-runtime/node/terminal/ports';
import { TerminalShells } from '@canopy/core-runtime/node/terminal/shells';

function errno(error: unknown): Record<string, unknown> {
  return {
    code:
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : null,
    syscall:
      typeof error === 'object' && error !== null && 'syscall' in error
        ? error.syscall
        : null,
  };
}

const nativeTest = process.platform === 'linux' ? it : it.skip;

describe('terminal native closed-peer golden (CAN-3238)', () => {
  nativeTest.each(['before', 'during'] as const)(
    'contains a slave PTY closed %s writes; preserves history and restarts only manually',
    async (phase) => {
      // Lazy loading is essential: macOS development may have the Electron ABI
      // addon installed. A missing/wrong Linux addon is a failure, not a skip.
      const { spawn } = jest.requireActual<typeof NodePty>('node-pty');
      const fs = jest.requireActual<typeof NodeFs>('node:fs');
      const root = mkdtempSync(join(tmpdir(), 'closed-pty-'));
      const commandLog = join(root, 'commands.log');
      const events: Array<Record<string, unknown>> = [];
      const listeners = new Set<() => void>();
      const record = (
        event: string,
        details: Record<string, unknown> = {},
      ): void => {
        events.push({ event, ...details });
        for (const listener of listeners) listener();
      };
      const until = (predicate: () => boolean): Promise<void> =>
        new Promise((resolve, reject) => {
          const check = (): void => {
            if (!predicate()) return;
            clearTimeout(timer);
            listeners.delete(check);
            resolve();
          };
          const timer = setTimeout(() => {
            listeners.delete(check);
            reject(
              new Error(
                `Native PTY barrier timed out: ${JSON.stringify(events)}`,
              ),
            );
          }, 3000);
          listeners.add(check);
          check();
        });
      const seen = (event: string, generation = 0): boolean =>
        events.some(
          (entry) => entry.event === event && entry.generation === generation,
        );
      const peers: Socket[] = [];
      const server = createServer((socket) => {
        const generation = peers.length;
        peers.push(socket);
        let pending = '';
        socket.on('error', (error) =>
          record('control-error', { generation, ...errno(error) }),
        );
        socket.on('data', (chunk) => {
          pending += chunk.toString();
          let newline;
          while ((newline = pending.indexOf('\n')) !== -1) {
            const value: unknown = JSON.parse(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            if (
              typeof value !== 'object' ||
              value === null ||
              !('event' in value)
            )
              continue;
            record(String(value.event), { ...value, generation });
          }
        });
      });
      const ptys: IPty[] = [];
      const descriptors = new Map<number, number>();
      const outstanding = new Map<number, number>();
      const restoreObservers: Array<() => void> = [];
      const resources = new Set<number>();
      const persisted = new Map<string, PersistedTerminalEntry>();
      const callbacks = { success: 0, eagain: 0, failed: 0 };
      const writeDescriptor = Object.getOwnPropertyDescriptor(fs, 'write');
      const originalWrite = fs.write;
      let engine: TerminalEngine | undefined;
      let outcome = 'failed';
      let cleanupFailure: { error: unknown } | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('Missing control port');

        // Observation only: invoke the original fs.write with the original
        // descriptor/buffer/offset, then forward its real callback unchanged.
        // node-pty exposes no public write callback. Collapse repeated EAGAIN
        // retries so the retained evidence stays bounded.
        Object.defineProperty(fs, 'write', {
          ...writeDescriptor,
          value: (...args: unknown[]): void => {
            const fd = args[0];
            const callback = args[args.length - 1];
            const generation =
              typeof fd === 'number' ? descriptors.get(fd) : undefined;
            if (generation !== undefined && typeof callback === 'function') {
              outstanding.set(
                generation,
                (outstanding.get(generation) ?? 0) + 1,
              );
              args[args.length - 1] = (
                error: unknown,
                written: unknown,
              ): void => {
                const detail = errno(error);
                const key =
                  error == null
                    ? 'success'
                    : detail.code === 'EAGAIN'
                      ? 'eagain'
                      : 'failed';
                callbacks[key] += 1;
                if (callbacks[key] === 1 || key === 'failed') {
                  record('write-callback', { generation, ...detail, written });
                }
                try {
                  Reflect.apply(callback, undefined, [error, written]);
                } finally {
                  outstanding.set(
                    generation,
                    (outstanding.get(generation) ?? 1) - 1,
                  );
                  for (const listener of listeners) listener();
                }
              };
            }
            Reflect.apply(originalWrite, fs, args);
          },
        });
        const host: TerminalEngineHost = {
          shells: new TerminalShells({
            platform: () => 'linux',
            linuxLoginShellsSupported: () => false,
            accountShell: () => Promise.resolve(undefined),
            findOnPath: () => null,
            windowsGitBash: () => null,
            variable: () => undefined,
          }),
          pty: {
            spawn: (file, args, options) => {
              const generation = ptys.length;
              const pty = spawn(file, args, options);
              ptys.push(pty);
              pty.onExit(({ exitCode, signal }) =>
                record('pty-exit', {
                  generation,
                  exitCode,
                  signal: signal ?? null,
                }),
              );
              const fd: unknown = Reflect.get(pty, 'fd');
              const socket: unknown = Reflect.get(pty, '_socket');
              if (typeof fd !== 'number' || !(socket instanceof EventEmitter)) {
                throw new Error(
                  'Pinned node-pty Unix observation seam changed',
                );
              }
              descriptors.set(fd, generation);
              // Do not add an error listener: node-pty inspects listener count
              // to decide whether an unexpected error is contained or thrown.
              const ownEmit = Object.getOwnPropertyDescriptor(socket, 'emit');
              const emit = socket.emit.bind(socket);
              socket.emit = function (
                this: EventEmitter,
                event: string | symbol,
                ...args: unknown[]
              ): boolean {
                if (event === 'error')
                  record('tty-error', { generation, ...errno(args[0]) });
                return emit(event, ...args);
              };
              restoreObservers.push(() => {
                if (ownEmit) Object.defineProperty(socket, 'emit', ownEmit);
                else Reflect.deleteProperty(socket, 'emit');
              });
              socket.on('close', () => record('tty-close', { generation }));
              return pty;
            },
          },
          environment: {
            base: () => ({}),
            worktree: () => ({}),
            variable: () => undefined,
          },
          workspace: {
            worktreeCwd: () => root,
            assertStartAllowed: () => undefined,
          },
          resources: {
            register: (_session, pid) => {
              resources.add(pid);
              return {
                unregister: () => {
                  resources.delete(pid);
                },
              };
            },
          },
          persistence: {
            registerLiveSession: (session) => {
              const previous = persisted.get(session.id);
              persisted.set(session.id, {
                session,
                scrollbackLines: previous?.scrollbackLines ?? [],
                exitCode: null,
                signal: null,
              });
            },
            appendTerminalOutput: (_project, _worktree, id, chunk) => {
              const entry = persisted.get(id);
              if (entry) entry.scrollbackLines.push(chunk.toString('utf8'));
            },
            markTerminalExited: (_project, _worktree, id, exitCode, signal) => {
              const entry = persisted.get(id);
              if (entry) Object.assign(entry, { exitCode, signal });
            },
            getPersistedTerminalEntry: (id) => persisted.get(id) ?? null,
          },
          processes: {
            lowerPriority: () => undefined,
            probe: () => Promise.resolve(null),
            killWindowsTree: () => {
              throw new Error('Unexpected Windows effect');
            },
            drainOwned: (pid) => {
              process.kill(pid, 'SIGKILL');
              return Promise.resolve();
            },
          },
          log: {
            warn: (message, details) =>
              record('warning', { message, ...details }),
          },
        };
        engine = new TerminalEngine(host, {
          runningDetector: { syncLifecycle: (): void => undefined },
        });
        engine.addEventListener((event) => {
          if (event.type === 'exit')
            record('engine-exit', { ...event.payload });
          else if (event.type === 'output') record('engine-output');
        });
        const shell = {
          shell: '/usr/bin/python3',
          shellBasename: 'python3',
          args: [join(__dirname, 'fixtures/terminal-native-child.py')],
        };
        const environment = {
          CANOPY_CLOSED_PIPE_CONTROL_PORT: String(address.port),
          CANOPY_CLOSED_PIPE_COMMAND_LOG_PATH: commandLog,
        };
        const first = engine.create({
          projectId: 'native',
          worktreeId: 'pty',
          cols: 80,
          rows: 24,
          shell,
          environment,
        });
        await until(() => seen('ready'));
        engine.write(first.id, 'execute-once\r');
        await until(() => seen('executed'));
        await until(
          () =>
            engine?.replayText(first.id)?.includes('executed-once') === true,
        );
        const attachment = engine.attach({
          terminalId: first.id,
          fromOffset: 0,
          sink: {
            item: (item) => {
              if (item.exit) record('attachment-exit', { ...item.exit });
            },
            end: (end) => record('attachment-end', { outcome: end.outcome }),
          },
        });

        if (phase === 'during') {
          peers[0].write('arm\n');
          await until(() => seen('armed'));
          record('write-start', { generation: 0, bytes: 1024 * 1024 });
          engine.write(first.id, 'x'.repeat(1024 * 1024));
          // Child has consumed bytes and stopped reading; the native writer
          // has encountered actual kernel backpressure, not just a JS queue.
          await until(() => seen('first-bytes') && callbacks.eagain > 0);
        }
        peers[0].write('close\n');
        await until(() => seen('closed') && seen('tty-close'));
        if (phase === 'before') {
          await until(() => (outstanding.get(0) ?? 0) === 0);
          const previous = { ...callbacks };
          record('write-start', { generation: 0, bytes: 16 });
          expect(engine.write(first.id, 'must-not-replay\r')).toBeUndefined();
          // UnixTerminal._close replaces public write with a no-op. A control
          // round trip verifies the child is still alive after that call.
          peers[0].write('snapshot\n');
          await until(() => seen('snapshot'));
          expect(callbacks).toEqual(previous);
          record('write-noop-after-tty-close', { generation: 0 });
        }
        expect(ptys).toHaveLength(1); // No recovery spawn on pipe failure.
        expect(readFileSync(commandLog, 'utf8')).toBe('executed\n');
        peers[0].write('exit\n');
        await until(
          () =>
            seen('pty-exit') &&
            events.some((entry) => entry.event === 'attachment-end'),
        );
        expect(
          events.filter((entry) => entry.event === 'engine-exit'),
        ).toHaveLength(1);
        expect(
          events.find((entry) => entry.event === 'pty-exit'),
        ).toMatchObject({ exitCode: 23, signal: 0 });
        expect(
          events.find((entry) => entry.event === 'attachment-exit'),
        ).toMatchObject({ exitCode: 23, signal: null });
        expect(
          events.find((entry) => entry.event === 'attachment-end'),
        ).toMatchObject({ outcome: 'completed' });
        expect(resources.size).toBe(0);
        expect(engine.get(first.id)).toBeNull();
        expect(engine.replayText(first.id)).toContain('native-history');
        engine.releaseAttachment(attachment.attachmentId);

        await until(() => (outstanding.get(0) ?? 0) === 0);
        const oldWriter: unknown = Reflect.get(ptys[0], '_writeStream');
        if (typeof oldWriter !== 'object' || oldWriter === null) {
          throw new Error('Pinned node-pty write observation seam changed');
        }
        expect(Reflect.get(oldWriter, '_writeImmediate')).toBeUndefined();
        record('old-writer-quiescent', {
          generation: 0,
          outstanding: outstanding.get(0) ?? 0,
        });
        record('manual-restore');
        const restored = engine.restore({
          terminalId: first.id,
          cols: 80,
          rows: 24,
          shell,
          environment,
        });
        expect(restored.id).toBe(first.id);
        expect(engine.replayText(first.id)).toContain('executed-once');
        expect(engine.replayText(first.id)).toContain('Terminal restarted');
        await until(() => seen('ready', 1));
        peers[1].write('snapshot\n');
        await until(() => seen('snapshot', 1));
        expect(
          events.find(
            (entry) => entry.event === 'snapshot' && entry.generation === 1,
          ),
        ).toMatchObject({ received: 0 });
        expect(readFileSync(commandLog, 'utf8')).toBe('executed\n');
        expect(
          events.filter((entry) => entry.event === 'engine-exit'),
        ).toHaveLength(1);
        engine.write(first.id, 'execute-once\r');
        await until(() => seen('executed', 1));
        expect(readFileSync(commandLog, 'utf8')).toBe('executed\nexecuted\n');
        peers[1].write('exit\n');
        await until(() => seen('pty-exit', 1));
        await until(() => resources.size === 0);
        expect(ptys).toHaveLength(2);
        outcome = 'passed';
      } finally {
        try {
          engine?.killAll();
        } finally {
          for (const [generation, pty] of ptys.entries()) {
            if (seen('pty-exit', generation)) continue;
            try {
              process.kill(pty.pid, 'SIGKILL');
            } catch (error) {
              record('cleanup-kill', { generation, ...errno(error) });
            }
          }
          for (const peer of peers) peer.destroy();
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error('Control server close timed out')),
                3000,
              );
              server.close(() => {
                clearTimeout(timer);
                resolve();
              });
            });
            // Wait for native waitpid callbacks before removing the observation
            // hook; cleanup must finish even when a barrier assertion failed.
            await until(() =>
              ptys.every((_pty, generation) => seen('pty-exit', generation)),
            );
          } catch (error) {
            outcome = 'failed';
            record('cleanup-failed', { message: String(error) });
            cleanupFailure = { error };
          } finally {
            if (writeDescriptor)
              Object.defineProperty(fs, 'write', writeDescriptor);
            for (const restore of restoreObservers) restore();
            rmSync(root, { recursive: true, force: true });
            process.stdout.write(
              `CAN-3238 ${JSON.stringify({
                transport: 'terminal-node-pty',
                phase,
                outcome,
                os: process.platform,
                release: release(),
                node: process.versions.node,
                uv: process.versions.uv,
                stdinError: 'not applicable: Unix PTY, not stdin pipe',
                rejection: 'not applicable: TerminalEngine.write returns void',
                callbacks,
                events,
              })}\n`,
            );
          }
        }
      }
      if (cleanupFailure) throw cleanupFailure.error;
    },
    15_000,
  );
});
