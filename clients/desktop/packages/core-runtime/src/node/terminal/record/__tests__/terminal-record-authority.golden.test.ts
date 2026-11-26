// CAN-7051: host report pressure, PTY lifetimes and create/restore attribution
// before output, first-output, offset and exit reports reach the record.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANOPY_DEFAULT_MAX_FRAME_BYTES } from '@canopy/core-transport';
import {
  WORKER_TERMINAL_LOST_SIGNAL,
  type WorkerTerminalRestoreParams,
  type WorkerTerminalRestoreResult,
} from '@canopy/protocol/canopy-core';
import type { TerminalSession } from '@canopy/protocol/terminal';
import { TerminalRecordAuthority } from '../authority';
import { TerminalRecordRepository } from '../repository';
import {
  createWorkerTerminalHandlers,
  TerminalHostSupervisor,
  type TerminalHostProcess,
  type TerminalHostRequestMessage,
  type TerminalHostTerminal,
} from '../../host';
import { CanopyOperationError } from '../../../../runtime/errors';
import type { CanopyHandlerContext } from '../../../../runtime/types';
import { serveTerminalHost } from '../../host/server';
import type { TerminalHostMessage } from '../../host/protocol';
import type {
  TerminalDisposable,
  TerminalPersistencePort,
  TerminalPty,
} from '../../ports';
import {
  RemoteTerminals,
  type RemoteTerminalsOptions,
  type RemoteTerminalTransport,
} from '../../remote/remote-terminals';

const client = {
  projectId: 'proj',
  worktreeId: 'wt',
  legacyLayout: 'workspaces' as const,
  incarnation: 'inc-1',
};

function session(
  id: string,
  extra: Partial<TerminalSession> = {},
): TerminalSession {
  return {
    id,
    projectId: 'proj',
    worktreeId: 'wt',
    shell: '/bin/zsh',
    shellBasename: 'zsh',
    cwd: '/tmp',
    createdAt: 1,
    ...extra,
  };
}

let root: string;

const make = (): TerminalRecordAuthority =>
  new TerminalRecordAuthority({
    repository: new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: () => undefined,
    }),
    installDebounceMs: 1,
  });

it('R11 host report pressure bounds held bytes and keeps retained output before exit', async () => {
  jest.useFakeTimers();
  let blocked = true;
  let pauseAfterNextDelivery = false;
  let drain: () => void = () => undefined;
  const delivered: TerminalHostMessage[] = [];
  class Channel extends EventEmitter {
    public postMessage(message: TerminalHostMessage): void {
      delivered.push(message);
      if (pauseAfterNextDelivery) {
        pauseAfterNextDelivery = false;
        blocked = true;
      }
    }
    public congested(): boolean {
      return blocked;
    }
    public onceDrained(listener: () => void): void {
      drain = listener;
    }
  }
  const channel = new Channel();
  let data: (text: string) => void = () => undefined;
  let exit: (event: { exitCode: number }) => void = () => undefined;
  const { engine } = serveTerminalHost({
    channel,
    platform: 'linux',
    variable: () => undefined,
    pty: {
      spawn: () => ({
        pid: 42,
        process: 'sh',
        onData: (listener): { dispose(): void } => {
          data = listener;
          return { dispose: (): void => undefined };
        },
        onExit: (listener): { dispose(): void } => {
          exit = listener;
          return { dispose: (): void => undefined };
        },
        write: (): void => undefined,
        resize: (): void => undefined,
        kill: (): void => exit({ exitCode: 0 }),
      }),
    },
    processes: {
      killWindowsTree: (): void => undefined,
      drainOwned: () => Promise.resolve(),
      lowerPriority: (): void => undefined,
      probe: () => Promise.resolve(null),
    },
    log: { warn: (): void => undefined },
  });
  try {
    channel.emit('message', {
      data: {
        kind: 'request',
        id: 1,
        request: {
          op: 'create',
          cols: 80,
          rows: 24,
          launch: {
            projectId: 'proj',
            worktreeId: 'wt',
            root,
            cwd: root,
            environment: {},
            shell: { shell: '/bin/sh', args: [], shellBasename: 'sh' },
            persist: true,
          },
        },
      },
    });
    await Promise.resolve();
    expect(engine.list()).toHaveLength(1);
    for (let i = 0; i < 512; i += 1) data('x'.repeat(32 * 1024));
    exit({ exitCode: 0 });
    channel.emit('message', {
      data: { kind: 'request', id: 2, request: { op: 'stop' } },
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(
      delivered.some(
        (message) => message.kind === 'response' && message.id === 2,
      ),
    ).toBe(false);
    expect(delivered.filter((message) => message.kind === 'report')).toEqual(
      [],
    );
    pauseAfterNextDelivery = true;
    blocked = false;
    drain();
    expect(blocked).toBe(true);
    expect(
      delivered.some(
        (message) => message.kind === 'response' && message.id === 2,
      ),
    ).toBe(false);
    blocked = false;
    drain();
    let bytes = 0;
    let lastOutput = -1;
    let lastOffset = 0;
    let ended = -1;
    let stopped = -1;
    delivered.forEach((message, index): void => {
      if (message.kind === 'report' && message.report.type === 'output') {
        bytes += message.report.data.byteLength;
        lastOutput = index;
        expect(message.report.toOffset).toBeGreaterThan(lastOffset);
        if (lastOffset !== 0)
          expect(message.report.toOffset).toBe(
            lastOffset + message.report.data.byteLength,
          );
        lastOffset = message.report.toOffset;
      }
      if (message.kind === 'event' && message.event.type === 'exit')
        ended = index;
      if (message.kind === 'response' && message.id === 2) stopped = index;
    });
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(ended).toBeGreaterThan(lastOutput);
    expect(lastOffset).toBe(512 * 32 * 1024);
    expect(stopped).toBeGreaterThan(ended);
  } finally {
    jest.useRealTimers();
  }
});

interface ReportHost {
  engine: ReturnType<typeof serveTerminalHost>['engine'];
  host: TerminalHostProcess & EventEmitter;
  ptys: {
    data(text: string): void;
    exit(event: { exitCode: number }): void;
    size: { cols: number; rows: number };
  }[];
  supervisor: TerminalHostSupervisor;
  messages: TerminalHostMessage[];
  block(): void;
  unblock(): void;
  belowHighWater(): void;
  /** With `wire`: delivers queued frames in order, up to `bytes`. */
  pump(bytes: number): void;
}

/** Approximate frame bytes, for a wire that congests on what it holds. */
function frameBytes(message: TerminalHostMessage): number {
  if (message.kind === 'item') return 128 + message.item.data.byteLength;
  if (message.kind === 'report' && message.report.type === 'output')
    return 128 + message.report.data.byteLength;
  return 128;
}

type RestoredTerminal = Awaited<ReturnType<TerminalHostSupervisor['restore']>>;

function reportHost(
  options: {
    exitFirstRestore?: boolean;
    drainOwned?: () => Promise<void>;
    exitOnKill?: boolean;
    /** Queue frames on a wire with this high-water mark until `pump`. */
    wire?: number;
    requestTimeoutMs?: number;
  } = {},
): ReportHost {
  let blocked = false;
  let drain: (() => void) | undefined;
  const messages: TerminalHostMessage[] = [];
  const queued: TerminalHostMessage[] = [];
  let queuedBytes = 0;
  const ptys: ReportHost['ptys'] = [];
  class Host extends EventEmitter implements TerminalHostProcess {
    public postMessage(message: TerminalHostRequestMessage): void {
      channel.emit('message', { data: message });
    }
    public kill(): boolean {
      this.emit('exit', 0);
      return true;
    }
  }
  const host = new Host();
  const deliver = (message: TerminalHostMessage): void => {
    messages.push(message);
    host.emit('message', message);
  };
  class Channel extends EventEmitter {
    public postMessage(message: TerminalHostMessage): void {
      if (options.wire === undefined) {
        deliver(message);
        return;
      }
      queued.push(message);
      queuedBytes += frameBytes(message);
    }
    public congested(): boolean {
      return options.wire === undefined ? blocked : queuedBytes >= options.wire;
    }
    public onceDrained(listener: () => void): void {
      if (options.wire !== undefined && queued.length === 0) listener();
      else drain = listener;
    }
  }
  const pump = (bytes: number): void => {
    let budget = bytes;
    while (budget > 0) {
      const message = queued.shift();
      if (!message) break;
      queuedBytes -= frameBytes(message);
      budget -= frameBytes(message);
      deliver(message);
    }
    if (queued.length > 0) return;
    const listener = drain;
    drain = undefined;
    listener?.();
  };
  const channel = new Channel();
  const { engine } = serveTerminalHost({
    channel,
    platform: 'linux',
    variable: () => undefined,
    pty: {
      spawn: (_file, _args, spawnOptions): TerminalPty => {
        const callbacks: ReportHost['ptys'][number] = {
          data: (): void => undefined,
          exit: (): void => undefined,
          size: { cols: spawnOptions.cols, rows: spawnOptions.rows },
        };
        ptys.push(callbacks);
        if (options.exitFirstRestore && ptys.length === 1)
          void Promise.resolve().then((): void => {
            callbacks.data('first lifetime €\n');
            callbacks.exit({ exitCode: 7 });
          });
        return {
          pid: 42 + ptys.length,
          process: 'sh',
          onData: (listener): TerminalDisposable => {
            callbacks.data = listener;
            return { dispose: (): void => undefined };
          },
          onExit: (listener): TerminalDisposable => {
            callbacks.exit = listener;
            return { dispose: (): void => undefined };
          },
          write: (): void => undefined,
          resize: (cols, rows): void => {
            callbacks.size = { cols, rows };
          },
          kill: (): void => {
            if (options.exitOnKill !== false) callbacks.exit({ exitCode: 0 });
          },
        };
      },
    },
    processes: {
      killWindowsTree: (): void => undefined,
      drainOwned:
        options.drainOwned ?? ((): Promise<void> => Promise.resolve()),
      lowerPriority: (): void => undefined,
      probe: () => Promise.resolve(null),
    },
    log: { warn: (): void => undefined },
  });
  const supervisor = new TerminalHostSupervisor({
    launch: (): TerminalHostProcess => host,
    ...(options.requestTimeoutMs !== undefined && {
      requestTimeoutMs: options.requestTimeoutMs,
    }),
  });
  return {
    engine,
    host,
    ptys,
    supervisor,
    messages,
    block: (): void => {
      blocked = true;
    },
    belowHighWater: (): void => {
      blocked = false;
    },
    unblock: (): void => {
      blocked = false;
      drain?.();
    },
    pump,
  };
}

it.each(['', 'prior history 🦜\n'])(
  'overlapping revision 2 restores replay final output from current record history (%j)',
  async (initialHistory: string): Promise<void> => {
    jest.useFakeTimers();
    const f = reportHost({ exitFirstRestore: true });
    const authority = make();
    const initialRegistration = authority.attribute({
      terminalId: 'same',
      client,
      session: session('same'),
      persist: true,
    });
    authority.output(initialRegistration, Buffer.from(initialHistory));
    authority.exited(initialRegistration, 0, null);
    authority.flushSync();
    const attributed = new Map<string, number>();
    const seen: string[] = [];
    f.supervisor.onReport((report, registration): void => {
      if (report.type !== 'output') return;
      authority.output(registration, report.data);
      const text = Buffer.from(report.data).toString();
      if (text.includes('first lifetime'))
        seen.push(`${attributed.get(report.terminalId)}:first`);
      if (text.includes('second lifetime'))
        seen.push(`${attributed.get(report.terminalId)}:second`);
    });
    f.supervisor.onEvent((event, registration): void => {
      if (event.type !== 'exit') return;
      authority.exited(registration, event.exitCode, event.signal);
      if (event.terminalId === 'same')
        seen.push(`${attributed.get(event.terminalId)}:exit:${event.exitCode}`);
    });
    const handlers = createWorkerTerminalHandlers({
      supervisor: f.supervisor,
      record: authority,
      onOutputStart: (terminal): void => {
        attributed.set(terminal.session.id, terminal.lifetimeId ?? 0);
      },
      resolveRoot: (): Promise<string> => Promise.resolve(root),
    });
    const context: CanopyHandlerContext = {
      requestId: 'overlap',
      signal: new AbortController().signal,
      metadata: {},
      caller: {
        principalId: 'test',
        clientInstanceId: 'test',
        authorityId: 'test',
        interfaceKind: 'test',
        grants: [],
      },
    };
    let restoreNumber = 0;
    const restore = (
      terminalId = 'same',
    ): Promise<WorkerTerminalRestoreResult> => {
      restoreNumber += 1;
      const idempotencyKey = `restore-${restoreNumber}`;
      return handlers.instructions['worker.terminal.restore'](
        {
          scope: { workspaceId: 'proj', worktreeId: 'wt' },
          terminalId,
          cols: 80,
          rows: 24,
          revision: 2,
          client,
          session: session(terminalId),
          restoreMode: 'recreate_if_exited',
          historyFrom: 'record',
          _meta: { idempotencyKey },
          snapshot: {
            cwdRootId: 'root',
            cwdRelativePath: '',
            shell: '/bin/sh',
            args: [],
            env: {},
            scrollback: 'stale client snapshot',
          },
        },
        { ...context, metadata: { idempotencyKey } },
      );
    };
    try {
      f.block();
      let firstFinished = false;
      const first = restore().then((result): WorkerTerminalRestoreResult => {
        firstFinished = true;
        return result;
      });
      await jest.advanceTimersByTimeAsync(0);
      const second = restore();
      await jest.advanceTimersByTimeAsync(0);
      expect(firstFinished).toBe(false);
      expect(f.ptys).toHaveLength(1);
      expect(seen).toEqual([]);
      expect(authority.historyTail(client, 'same', 1024 * 1024)).toBe(
        initialHistory,
      );
      // A restore for another terminal reaches the host without waiting for
      // this one; only its reply queues behind the held exit on the channel.
      const unrelated = restore('unrelated');
      await jest.advanceTimersByTimeAsync(0);
      expect(f.ptys).toHaveLength(2);
      expect(firstFinished).toBe(false);
      f.unblock();
      expect((await unrelated).recreated).toBe(true);
      const results = await Promise.all([first, second]);
      expect(results.map((result): boolean => result.recreated)).toEqual([
        true,
        true,
      ]);
      expect(results[1].state).toBe('running');
      expect(f.ptys).toHaveLength(3);
      expect(attributed.get('same')).toBe(3);
      expect(seen).toEqual(['1:first', '1:exit:7']);
      const replay = f.engine.replayText('same');
      expect(replay).toContain(initialHistory);
      expect(replay).toContain('first lifetime €\n');
      expect(replay).not.toContain('stale client snapshot');
      f.ptys[2].data('second lifetime 🦜');
      await jest.advanceTimersByTimeAsync(50);
      expect(seen).toEqual(['1:first', '1:exit:7', '3:second']);
      authority.flushSync();
      const history = make().historyRead({ client, terminalId: 'same' }).text;
      expect(history).toContain('first lifetime €\n');
      expect(history).toContain('second lifetime 🦜');
      expect(history.match(/first lifetime/g)).toHaveLength(1);
      expect(f.engine.replayText('same')).toContain(history);
      const live = await restore();
      expect(live.recreated).toBe(false);
      expect(f.supervisor.isLive('same')).toBe(true);
      expect(attributed.get('same')).toBe(3);
      expect(f.ptys).toHaveLength(3);
    } finally {
      f.unblock();
      await f.supervisor.stop();
      authority.flushSync();
      jest.useRealTimers();
    }
  },
);

it.each(['queued', 'resolving root'] as const)(
  'cancelling a %s replacement preserves the previous lifetime record and permits retry',
  async (stage): Promise<void> => {
    jest.useFakeTimers();
    const f = reportHost({ exitFirstRestore: true });
    const posted = jest.spyOn(f.host, 'postMessage');
    const authority = make();
    f.supervisor.onReport((report, registration): void => {
      if (report.type === 'output') authority.output(registration, report.data);
    });
    f.supervisor.onEvent((event, registration): void => {
      if (event.type === 'exit')
        authority.exited(registration, event.exitCode, event.signal);
    });
    let releaseFirstRoot: () => void = (): void => undefined;
    const firstRoot = new Promise<string>((resolve): void => {
      releaseFirstRoot = (): void => resolve(root);
    });
    let releaseSecondRoot: () => void = (): void => undefined;
    const secondRoot = new Promise<string>((resolve): void => {
      releaseSecondRoot = (): void => resolve(root);
    });
    let rootCalls = 0;
    const handlers = createWorkerTerminalHandlers({
      supervisor: f.supervisor,
      record: authority,
      resolveRoot: (): Promise<string> => {
        rootCalls += 1;
        if (rootCalls === 1) return firstRoot;
        return rootCalls === 2 && stage === 'resolving root'
          ? secondRoot
          : Promise.resolve(root);
      },
    });
    const abort = new AbortController();
    const params = (
      key: string,
      cols: number,
    ): WorkerTerminalRestoreParams => ({
      terminalId: 'same',
      scope: { workspaceId: 'proj', worktreeId: 'wt' },
      cols,
      rows: 24,
      revision: 2,
      client,
      session: session('same'),
      restoreMode: 'recreate_if_exited',
      historyFrom: 'record',
      _meta: { idempotencyKey: key },
      snapshot: {
        cwdRootId: 'root',
        cwdRelativePath: '',
        shell: '/bin/sh',
        args: [],
        env: {},
        scrollback: '',
      },
    });
    const restore = (
      key: string,
      cols: number,
      signal = new AbortController().signal,
    ): Promise<WorkerTerminalRestoreResult> =>
      handlers.instructions['worker.terminal.restore'](params(key, cols), {
        requestId: key,
        signal,
        metadata: { idempotencyKey: key },
        caller: {
          principalId: 'test',
          clientInstanceId: 'test',
          authorityId: 'test',
          interfaceKind: 'test',
          grants: [],
        },
      });
    f.block();
    const first = restore('first', 80);
    const firstSettled = first.catch((): void => undefined);
    const cancelled = restore('cancelled', 201, abort.signal);
    const cancellation = cancelled.catch((error: unknown): unknown => error);
    const successor = restore('successor', 100);
    const successorSettled = successor.catch((): void => undefined);
    try {
      if (stage === 'queued') abort.abort();
      releaseFirstRoot();
      await jest.advanceTimersByTimeAsync(0);
      expect(f.ptys).toHaveLength(1);
      f.unblock();
      expect(await first).toMatchObject({ recreated: true, state: 'exited' });
      if (stage === 'resolving root') {
        await jest.advanceTimersByTimeAsync(0);
        expect(rootCalls).toBe(2);
        abort.abort();
        releaseSecondRoot();
      }
      expect(await cancellation).toMatchObject({
        payload: { kind: 'cancelled' },
      });
      expect(await successor).toMatchObject({
        recreated: true,
        state: 'running',
      });
      expect(
        posted.mock.calls.some(
          ([message]): boolean =>
            (message.request.op === 'restore' ||
              message.request.op === 'resize') &&
            message.request.cols === 201,
        ),
      ).toBe(false);
      expect(f.ptys).toHaveLength(2);
      expect(f.ptys[1].size).toEqual({ cols: 100, rows: 24 });
      expect(f.engine.replayText('same')).toContain('first lifetime €\n');
      expect(await restore('cancelled', 201)).toMatchObject({
        recreated: false,
        state: 'running',
      });
      expect(f.ptys[1].size).toEqual({ cols: 201, rows: 24 });
      expect(f.ptys).toHaveLength(2);
      f.ptys[1].data('replacement lifetime 🦜');
      await jest.advanceTimersByTimeAsync(50);
      authority.flushSync();
      const history = make().historyRead({ client, terminalId: 'same' }).text;
      expect(history).toContain('first lifetime €\n');
      expect(history).toContain('replacement lifetime 🦜');
      expect(history.match(/first lifetime/g)).toHaveLength(1);
    } finally {
      releaseFirstRoot();
      releaseSecondRoot();
      f.unblock();
      await Promise.all([firstSettled, cancellation, successorSettled]);
      await f.supervisor.stop();
      authority.flushSync();
      jest.useRealTimers();
    }
  },
);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trec-'));
});
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it.each(['before', 'after'] as const)(
  'non-persisted terminal offsets survive %s-response reports without byte reports',
  async (timing) => {
    const terminal: TerminalHostTerminal = {
      session: session('offset-only', { kind: 'claude-code' }),
      cols: 80,
      rows: 24,
      outputOffset: 0,
      running: true,
      processName: 'sh',
      pid: null,
    };
    class OffsetHost extends EventEmitter implements TerminalHostProcess {
      public postMessage(message: TerminalHostRequestMessage): void {
        const response = (): void => {
          this.emit('message', {
            kind: 'response',
            id: message.id,
            ok: true,
            // List stays stale: only reports can advance post-create progress.
            value:
              message.request.op === 'list'
                ? [{ ...terminal, outputOffset: 73 }]
                : terminal,
          });
        };
        if (message.request.op !== 'create') {
          response();
          return;
        }
        expect(message.request.launch.persist).toBe(false);
        if (timing === 'after') response();
        this.emit('message', {
          kind: 'report',
          report: { type: 'firstOutput', terminalId: 'offset-only', at: 123 },
        });
        this.offset(73);
        if (timing === 'before') response();
      }
      public offset(outputOffset: number): void {
        this.emit('message', {
          kind: 'report',
          report: { type: 'offset', terminalId: 'offset-only', outputOffset },
        });
      }
      public kill(): boolean {
        this.emit('exit', 0);
        return true;
      }
    }
    const host = new OffsetHost();
    const supervisor = new TerminalHostSupervisor({
      launch: (): TerminalHostProcess => host,
    });
    const authority = make();
    const reports: string[] = [];
    supervisor.onReport((report): void => {
      reports.push(report.type);
    });
    const handlers = createWorkerTerminalHandlers({
      supervisor,
      record: authority,
      resolveRoot: () => Promise.resolve(root),
    });
    const context: CanopyHandlerContext = {
      requestId: 'offset-only',
      signal: new AbortController().signal,
      metadata: {},
      caller: {
        principalId: 'test',
        clientInstanceId: 'test',
        authorityId: 'test',
        interfaceKind: 'test',
        grants: [],
      },
    };
    const scope = { workspaceId: 'proj', worktreeId: 'wt' };
    try {
      const created = await handlers.instructions['worker.terminal.create'](
        {
          scope,
          kind: 'managed',
          cwdRootId: 'root',
          cwdRelativePath: '',
          shell: '/bin/sh',
          cols: 80,
          rows: 24,
          revision: 2,
          client,
          session: session('offset-only', { kind: 'claude-code' }),
          _meta: { idempotencyKey: 'offset-only' },
        },
        context,
      );
      expect(created.outputOffset).toBe(73);
      expect(created.firstOutputAt).toBe(123);
      host.offset(101);
      host.offset(129);
      const current = await handlers.queries['worker.terminal.get'](
        { scope, terminalId: 'offset-only' },
        context,
      );
      expect(current.outputOffset).toBe(129);
      const listed = await handlers.queries['worker.terminal.list'](
        { scope, pageSize: 10 },
        context,
      );
      expect(listed.items[0].outputOffset).toBe(129);
      expect(reports).toEqual(['firstOutput', 'offset', 'offset', 'offset']);
      expect(authority.open(client).terminals).toEqual([]);
    } finally {
      await supervisor.stop();
      authority.flushSync();
    }
  },
);

describe.each(['create', 'restore'] as const)(
  '%s attribution before host reports',
  (operation) => {
    it.each([
      ['before', 'live'],
      ['after', 'live'],
      ['before', 'exit'],
      ['after', 'exit'],
      ['before', 'lost'],
      ['after', 'lost'],
      ['after', 'recreate'],
    ] as const)(
      'keeps %s-response output, first-output and offsets, including exit=%s',
      async (timing, exits) => {
        const authority = make();
        const terminal: TerminalHostTerminal = {
          session: session('early'),
          cols: 80,
          rows: 24,
          outputOffset: 0,
          running: true,
          processName: 'sh',
          pid: null,
        };
        // One synchronous delivery models frames decoded from one stdout chunk.
        class CoalescedHost
          extends EventEmitter
          implements TerminalHostProcess
        {
          private openings = 0;

          public postMessage(message: TerminalHostRequestMessage): void {
            const response = (): void => {
              this.emit('message', {
                kind: 'response',
                id: message.id,
                ok: true,
                value:
                  message.request.op === 'restore'
                    ? { terminal, recreated: true }
                    : message.request.op === 'list'
                      ? [terminal]
                      : terminal,
              });
            };
            if (
              message.request.op !== 'create' &&
              message.request.op !== 'restore'
            ) {
              response();
              return;
            }
            this.openings += 1;
            if (timing === 'after') response();
            this.emit('message', {
              kind: 'report',
              report: { type: 'firstOutput', terminalId: 'early', at: 123 },
            });
            const bytes = Buffer.from(
              this.openings === 1 ? '€first\nlast' : '-new',
            );
            for (const [data, toOffset] of [
              [bytes.subarray(0, 1), 1],
              [bytes.subarray(1), bytes.length],
            ] as const)
              this.emit('message', {
                kind: 'report',
                report: { type: 'output', terminalId: 'early', data, toOffset },
              });
            this.emit('message', {
              kind: 'report',
              report: {
                type: 'offset',
                terminalId: 'early',
                outputOffset: bytes.length,
              },
            });
            if (
              exits === 'exit' ||
              (exits === 'recreate' && this.openings === 1)
            )
              this.emit('message', {
                kind: 'event',
                event: {
                  type: 'exit',
                  terminalId: 'early',
                  exitCode: 7,
                  signal: null,
                },
              });
            if (timing === 'before') response();
            if (exits === 'lost') this.emit('exit', 1);
          }
          public kill(): boolean {
            this.emit('exit', 0);
            return true;
          }
        }
        const host = new CoalescedHost();
        const supervisor = new TerminalHostSupervisor({
          launch: (): TerminalHostProcess => host,
        });
        const order: string[] = [];
        supervisor.onReport((report, registration) => {
          order.push(report.type);
          if (report.type === 'output')
            authority.output(registration, report.data);
        });
        const ended = new Promise<void>((resolve) => {
          supervisor.onEvent((event, registration) => {
            if (event.type !== 'exit') return;
            order.push('exit');
            authority.exited(registration, event.exitCode, event.signal);
            resolve();
          });
        });
        const handlers = createWorkerTerminalHandlers({
          supervisor,
          record: authority,
          resolveRoot: () => Promise.resolve(root),
        });
        const context: CanopyHandlerContext = {
          requestId: 'request',
          signal: new AbortController().signal,
          metadata: {},
          caller: {
            principalId: 'test',
            clientInstanceId: 'test',
            authorityId: 'test',
            interfaceKind: 'test',
            grants: [],
          },
        };
        const scope = { workspaceId: 'proj', worktreeId: 'wt' };
        try {
          if (operation === 'create') {
            const created = await handlers.instructions[
              'worker.terminal.create'
            ](
              {
                scope,
                kind: 'interactive',
                cwdRootId: 'root',
                cwdRelativePath: '',
                shell: '/bin/sh',
                cols: 80,
                rows: 24,
                revision: 2,
                client,
                _meta: { idempotencyKey: 'create' },
                session: session('early'),
              },
              context,
            );
            expect(
              authority.historyRead({ client, terminalId: 'early' }).text,
            ).toBe('€first\nlast');
            expect(created.firstOutputAt).toBe(123);
            expect(created.state).toBe(exits === 'live' ? 'running' : 'exited');
            expect(created.outputOffset).toBe(
              Buffer.byteLength('€first\nlast'),
            );
          } else {
            const restored = await handlers.instructions[
              'worker.terminal.restore'
            ](
              {
                scope,
                terminalId: 'early',
                cols: 80,
                rows: 24,
                revision: 2,
                client,
                session: session('early'),
                restoreMode: 'recreate_if_exited',
                historyFrom: 'record',
                _meta: { idempotencyKey: 'restore' },
                snapshot: {
                  cwdRootId: 'root',
                  cwdRelativePath: '',
                  shell: '/bin/sh',
                  args: [],
                  env: {},
                  scrollback: '',
                },
              },
              context,
            );
            expect(
              authority.historyRead({ client, terminalId: 'early' }).text,
            ).toBe('€first\nlast');
            expect(restored.outputOffset).toBe(
              Buffer.byteLength('€first\nlast'),
            );
            expect(restored.state).toBe(
              exits === 'live' ? 'running' : 'exited',
            );
          }
          if (exits === 'recreate') {
            // No event-loop turn separates the response from the recreation.
            // A delayed old exit must not terminate this new attribution.
            await handlers.instructions['worker.terminal.restore'](
              {
                scope,
                terminalId: 'early',
                cols: 80,
                rows: 24,
                revision: 2,
                client,
                session: session('early'),
                restoreMode: 'recreate_if_exited',
                historyFrom: 'record',
                _meta: { idempotencyKey: 'recreate' },
                snapshot: {
                  cwdRootId: 'root',
                  cwdRelativePath: '',
                  shell: '/bin/sh',
                  args: [],
                  env: {},
                  scrollback: '',
                },
              },
              context,
            );
            await ended;
            const live = await handlers.queries['worker.terminal.get'](
              { terminalId: 'early', scope },
              context,
            );
            expect(live.state).toBe('running');
            expect(authority.open(client).terminals[0]).toMatchObject({
              exitCode: null,
              signal: null,
            });
            expect(
              authority.historyRead({ client, terminalId: 'early' }).text,
            ).toBe('€first\nlast-new');
            return;
          }
          if (exits !== 'live') await ended;
          else {
            const live = await handlers.queries['worker.terminal.get'](
              { terminalId: 'early', scope },
              context,
            );
            expect(live.firstOutputAt).toBe(123);
            expect(live.outputOffset).toBe(Buffer.byteLength('€first\nlast'));
          }
          expect(order).toEqual([
            'firstOutput',
            'output',
            'output',
            'offset',
            ...(exits !== 'live' ? ['exit'] : []),
          ]);
          authority.flushSync();
          const reopened = make();
          expect(
            reopened.historyRead({ client, terminalId: 'early' }).text,
          ).toBe('€first\nlast');
          if (exits === 'exit')
            expect(reopened.open(client).terminals[0]).toMatchObject({
              exitCode: 7,
            });
          if (exits === 'lost')
            expect(reopened.open(client).terminals[0]).toMatchObject({
              signal: WORKER_TERMINAL_LOST_SIGNAL,
            });
        } finally {
          await supervisor.stop();
          authority.shutdown('app-quit');
        }
      },
    );
  },
);

function restoreForProgress(
  f: ReportHost,
  terminalId: string,
): Promise<RestoredTerminal> {
  return f.supervisor.restore(
    {
      op: 'restore',
      terminalId,
      cols: 80,
      rows: 24,
      recreate: {
        projectId: 'proj',
        worktreeId: 'wt',
        root,
        cwd: root,
        environment: {},
        shell: { shell: '/bin/sh', args: [], shellBasename: 'sh' },
        scrollback: '',
        persist: true,
      },
    },
    () => undefined,
  );
}

it.each(['traffic', 'idle'] as const)(
  'progresses held exit and restore on %s capacity recovery',
  async (recovery) => {
    jest.useFakeTimers();
    const f = reportHost();
    try {
      await restoreForProgress(f, 'a');
      await restoreForProgress(f, 'b');
      await f.supervisor.attach(
        { terminalId: 'b', fromOffset: 0 },
        {
          item: (item, id) => f.supervisor.acknowledge(id, item.toOffset),
          end: () => undefined,
        },
      );
      f.ptys[1].data('already started');
      await jest.advanceTimersByTimeAsync(50);
      f.block();
      f.ptys[0].data('final bytes');
      f.ptys[0].exit({ exitCode: 7 });
      let settled = false;
      const reply = f.supervisor
        .restore({ op: 'restore', terminalId: 'a', cols: 90, rows: 30 })
        .then(
          () => {
            throw new Error('expected notFound');
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      if (recovery === 'idle') f.unblock();
      else {
        // Below high water but still nonempty: onceDrained has not run.
        f.belowHighWater();
        for (let i = 0; i < 8; i += 1) {
          f.ptys[1].data('continuing attachment');
          await jest.advanceTimersByTimeAsync(5);
        }
      }
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await reply;
      const exitIndex = f.messages.findIndex(
        (message) =>
          message.kind === 'event' &&
          message.event.type === 'exit' &&
          message.event.terminalId === 'a',
      );
      const outputIndex = f.messages.findIndex(
        (message) =>
          message.kind === 'report' &&
          message.report.type === 'output' &&
          message.report.terminalId === 'a' &&
          Buffer.from(message.report.data)
            .toString('utf8')
            .includes('final bytes'),
      );
      const replyIndex = f.messages.findIndex(
        (message) => message.kind === 'response' && !message.ok,
      );
      expect(outputIndex).toBeGreaterThanOrEqual(0);
      expect(exitIndex).toBeGreaterThan(outputIndex);
      expect(replyIndex).toBeGreaterThan(outputIndex);
      expect(replyIndex).toBeGreaterThan(exitIndex);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(f.supervisor.isLive('b')).toBe(true);
    } finally {
      f.unblock();
      await f.supervisor.stop();
      jest.useRealTimers();
    }
  },
);

it('a saturated attachment never holds back another terminal exit and its reply', async () => {
  jest.useFakeTimers();
  // The wire stays above high water: its reader takes only what b produces.
  const f = reportHost({ wire: 1024 * 1024, requestTimeoutMs: 1_000 });
  const chunk = 'y'.repeat(64 * 1024);
  let producing = false;
  const reader = setInterval(() => f.pump(64 * 1024), 1);
  const producer = setInterval(() => {
    if (producing) f.ptys[1].data(chunk);
  }, 1);
  const settle = async <T>(pending: Promise<T>): Promise<T> => {
    await jest.advanceTimersByTimeAsync(10);
    return pending;
  };
  try {
    await settle(restoreForProgress(f, 'a'));
    await settle(restoreForProgress(f, 'b'));
    let itemsAfterExit = 0;
    let exited = false;
    await settle(
      f.supervisor.attach(
        { terminalId: 'b', fromOffset: 0 },
        {
          item: (item, id) => {
            if (exited) itemsAfterExit += 1;
            f.supervisor.acknowledge(id, item.toOffset);
          },
          end: () => undefined,
        },
      ),
    );
    for (let i = 0; i < 32; i += 1) f.ptys[1].data(chunk);
    producing = true;
    await jest.advanceTimersByTimeAsync(50);
    f.ptys[0].data('final bytes');
    f.ptys[0].exit({ exitCode: 7 });
    exited = true;
    let settled = false;
    const reply = f.supervisor
      .restore({ op: 'restore', terminalId: 'a', cols: 90, rows: 30 })
      .then(
        () => {
          throw new Error('expected notFound');
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    // Well inside the request timeout, while b stays saturated.
    await jest.advanceTimersByTimeAsync(250);
    expect(settled).toBe(true);
    expect(await reply).toMatchObject({ error: { code: 'notFound' } });
    const exitIndex = f.messages.findIndex(
      (message) =>
        message.kind === 'event' &&
        message.event.type === 'exit' &&
        message.event.terminalId === 'a',
    );
    const outputIndex = f.messages.findIndex(
      (message) =>
        message.kind === 'report' &&
        message.report.type === 'output' &&
        message.report.terminalId === 'a' &&
        Buffer.from(message.report.data)
          .toString('utf8')
          .includes('final bytes'),
    );
    const replyIndex = f.messages.findIndex(
      (message) => message.kind === 'response' && !message.ok,
    );
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(outputIndex);
    expect(replyIndex).toBeGreaterThan(exitIndex);
    // The host outlives the request timeout and b keeps streaming.
    await jest.advanceTimersByTimeAsync(1_500);
    expect(itemsAfterExit).toBeGreaterThan(0);
    expect(f.supervisor.isLive('b')).toBe(true);
  } finally {
    producing = false;
    clearInterval(producer);
    const stopped = f.supervisor.stop();
    await jest.advanceTimersByTimeAsync(500);
    await stopped;
    clearInterval(reader);
    jest.useRealTimers();
  }
});

it.each(['exit', 'host-loss'] as const)(
  'announces lifecycle before attachment completion on %s',
  async (ending) => {
    jest.useFakeTimers();
    const f = reportHost();
    const order: string[] = [];
    try {
      await restoreForProgress(f, 'a');
      f.supervisor.onEvent((event) => {
        if (event.type === 'exit') order.push('lifecycle');
      });
      await f.supervisor.attach(
        { terminalId: 'a', fromOffset: 0 },
        {
          item: (item, id) => {
            f.supervisor.acknowledge(id, item.toOffset);
            if (item.exit) order.push('item');
          },
          end: () => {
            order.push('end');
            expect(f.supervisor.isLive('a')).toBe(false);
          },
        },
      );
      f.block();
      f.ptys[0].data('final');
      if (ending === 'exit') {
        f.ptys[0].exit({ exitCode: 7 });
        expect(order).toEqual([]);
        f.unblock();
      } else f.host.emit('exit', 1);
      expect(order).toEqual(['lifecycle', 'item', 'end']);
    } finally {
      f.unblock();
      await f.supervisor.stop();
      jest.useRealTimers();
    }
  },
);

it.each([1, 2] as const)(
  'revision %s: an attachment draining an earlier lifetime never inflates the recreated offset',
  async (revision) => {
    jest.useFakeTimers();
    const f = reportHost();
    const handlers = createWorkerTerminalHandlers({
      supervisor: f.supervisor,
      resolveRoot: () => Promise.resolve(root),
      flushIntervalMs: 0,
    });
    const settle = (): Promise<void> => jest.advanceTimersByTimeAsync(1);
    const context = (key: string): CanopyHandlerContext => ({
      requestId: key,
      signal: new AbortController().signal,
      metadata: {},
      caller: {
        principalId: 'test',
        clientInstanceId: 'test',
        authorityId: 'test',
        interfaceKind: 'test',
        grants: [],
      },
    });
    const scope = { workspaceId: 'proj', worktreeId: 'wt' };
    const restore = (key: string): Promise<WorkerTerminalRestoreResult> =>
      handlers.instructions['worker.terminal.restore'](
        {
          scope,
          terminalId: 'same',
          cols: 80,
          rows: 24,
          ...(revision === 2 && { revision }),
          restoreMode: 'recreate_if_exited',
          _meta: { idempotencyKey: key },
          snapshot: {
            cwdRootId: 'root',
            cwdRelativePath: '',
            shell: '/bin/sh',
            args: [],
            env: {},
            scrollback: 'snapshot',
          },
        },
        context(key),
      );
    const toOffsets: number[] = [];
    const attach = (fromOffset: number, key: string): Promise<() => void> =>
      handlers.streams['worker.terminal.attach'](
        { terminalId: 'same', fromOffset },
        context(key),
        {
          emit: (item) => {
            toOffsets.push(item.toOffset);
            return { daemonEpoch: 'test', sequence: toOffsets.length };
          },
          emitAt: () => null,
          end: () => undefined,
          endAt: () => undefined,
        },
      );
    // Withheld credit leaves the first lifetime's attachment a backlog.
    const acknowledge = f.supervisor.acknowledge.bind(f.supervisor);
    const credit: [string, number][] = [];
    const withhold = jest
      .spyOn(f.supervisor, 'acknowledge')
      .mockImplementation((id: string, offset: number): void => {
        credit.push([id, offset]);
      });
    try {
      const first = await restore('first');
      expect(first.recreated).toBe(true);
      const closeOld = await attach(first.outputOffset, 'attach-old');
      for (let i = 0; i < 300; i += 1) {
        f.ptys[0].data('x'.repeat(1000));
        await settle();
      }
      f.ptys[0].exit({ exitCode: 0 });
      await settle();
      expect((await restore('second')).recreated).toBe(true);
      f.ptys[1].data('y'.repeat(30));
      await settle();
      const own = f.engine.replay('same').seq;
      withhold.mockRestore();
      const drained = toOffsets.length;
      for (const [id, offset] of credit.splice(0)) acknowledge(id, offset);
      await settle();
      // The old lifetime's items, past the new output, arrived after it.
      expect(toOffsets.length).toBeGreaterThan(drained);
      expect(Math.max(...toOffsets)).toBeGreaterThan(own);
      const got = await handlers.queries['worker.terminal.get'](
        { scope, terminalId: 'same' },
        context('get'),
      );
      expect(got.outputOffset).toBe(own);
      const reattached = await restore('reattach');
      expect(reattached).toMatchObject({ recreated: false, outputOffset: own });
      // Resuming from the advertised offset is accepted.
      (await attach(got.outputOffset, 'attach-new'))();
      closeOld();
    } finally {
      jest.restoreAllMocks();
      await f.supervisor.stop();
      jest.useRealTimers();
    }
  },
);

it.each([
  'a failed connection-lost release',
  "a quit's kill",
  "a remote client's failed lost-stream release",
] as const)(
  'a cleanup records its own exit reason after %s and vetoes a record restore',
  async (before) => {
    const draining = Promise.withResolvers<void>();
    const drainOwned = jest
      .fn<Promise<void>, []>()
      .mockImplementationOnce(() =>
        before === "a quit's kill"
          ? draining.promise
          : Promise.reject(new Error('drain failed')),
      )
      .mockResolvedValue(undefined);
    const f = reportHost({ exitOnKill: false, drainOwned });
    const authority = make();
    const exits: (string | null)[] = [];
    f.supervisor.onReport((report, registration) => {
      if (report.type === 'output') authority.output(registration, report.data);
    });
    f.supervisor.onEvent((event, registration) => {
      if (event.type !== 'exit') return;
      exits.push(event.signal);
      authority.exited(registration, event.exitCode, event.signal);
    });
    const handlers = createWorkerTerminalHandlers({
      supervisor: f.supervisor,
      record: authority,
      resolveRoot: () => Promise.resolve(root),
    });
    const context: CanopyHandlerContext = {
      requestId: 'release',
      signal: new AbortController().signal,
      metadata: {},
      caller: {
        principalId: 'test',
        clientInstanceId: 'test',
        authorityId: 'test',
        interfaceKind: 'test',
        grants: [],
      },
    };
    const scope = { workspaceId: 'proj', worktreeId: 'wt' };
    let terminalId = '';
    const release = (exitSignal: string): Promise<{ released: boolean }> =>
      handlers.instructions['worker.terminal.release'](
        { scope, terminalId, revision: 2, exitSignal },
        context,
      );
    const remote =
      before === "a remote client's failed lost-stream release"
        ? remoteClient(handlers, context)
        : null;
    try {
      if (remote) terminalId = await remote.create();
      else
        ({ terminalId } = await handlers.instructions['worker.terminal.create'](
          {
            scope,
            kind: 'interactive',
            cwdRootId: 'root',
            cwdRelativePath: '',
            shell: '/bin/sh',
            cols: 80,
            rows: 24,
            revision: 2,
            client,
            _meta: { idempotencyKey: 'create' },
            session: session('cleaned'),
          },
          context,
        ));
      if (remote) {
        // The client ends it as lost; its release's drain fails, so the
        // worktree cleanup asks again.
        await remote.lose();
        expect(exits).toEqual([]);
        const worktree = { projectId: 'proj', worktreeId: 'wt' };
        await remote.terminals.releaseWorktree(worktree);
        expect(remote.terminals.hasLiveTerminals(worktree)).toBe(false);
      } else if (before === "a quit's kill") {
        const cleanup = release('worktree-cleanup');
        await new Promise((resolve) => setImmediate(resolve));
        // A quit during the cleanup cannot make it restorable.
        await handlers.instructions['worker.terminal.kill'](
          { scope, terminalId, revision: 2, exitSignal: 'app-quit' },
          context,
        );
        draining.resolve();
        await expect(cleanup).resolves.toEqual({ released: true });
      } else {
        // A lost stream's release whose drain fails leaves the shell running.
        await expect(release('connection-lost')).rejects.toBeDefined();
        expect(exits).toEqual([]);
        await expect(release('worktree-cleanup')).resolves.toEqual({
          released: true,
        });
      }
      expect(exits).toEqual(['worktree-cleanup']);
      expect(authority.open(client).terminals[0]).toMatchObject({
        signal: 'worktree-cleanup',
      });
      const restoring = handlers.instructions['worker.terminal.restore'](
        {
          scope,
          terminalId,
          cols: 80,
          rows: 24,
          revision: 2,
          client,
          session: session(terminalId),
          restoreMode: 'recreate_if_exited',
          historyFrom: 'record',
          _meta: { idempotencyKey: 'restore' },
          snapshot: {
            cwdRootId: 'root',
            cwdRelativePath: '',
            shell: '/bin/sh',
            args: [],
            env: {},
            scrollback: '',
          },
        },
        context,
      );
      await expect(restoring).rejects.toBeInstanceOf(CanopyOperationError);
      await expect(restoring).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'worker.terminal.invalidState',
        },
      });
      expect(f.ptys).toHaveLength(1);
    } finally {
      remote?.close();
      await f.supervisor.stop();
      authority.shutdown('app-quit');
    }
  },
);

/** A record-attributed remote client of `handlers` whose stream can drop. */
function remoteClient(
  handlers: ReturnType<typeof createWorkerTerminalHandlers>,
  context: CanopyHandlerContext,
): {
  terminals: RemoteTerminals;
  create(): Promise<string>;
  /** Drops the stream and waits for the client's lost exit. */
  lose(): Promise<void>;
  close(): void;
} {
  let drop = (): void => undefined;
  let closeStream = (): void => undefined;
  const lost = Promise.withResolvers<void>();
  const persistence: TerminalPersistencePort = {
    registerLiveSession: () => undefined,
    appendTerminalOutput: () => undefined,
    markTerminalExited: () => undefined,
    getPersistedTerminalEntry: () => null,
  };
  const transport: RemoteTerminalTransport = {
    create: (params) =>
      handlers.instructions['worker.terminal.create'](params, context),
    restore: (params) =>
      handlers.instructions['worker.terminal.restore'](params, context),
    write: (params) =>
      handlers.instructions['worker.terminal.write'](params, context),
    resize: (params) =>
      handlers.instructions['worker.terminal.resize'](params, context),
    kill: (params) =>
      handlers.instructions['worker.terminal.kill'](params, context),
    release: (params) =>
      handlers.instructions['worker.terminal.release'](params, context),
    attach: async (params, onFrame) => {
      let sequence = 0;
      const close = await handlers.streams['worker.terminal.attach'](
        params,
        context,
        {
          emit: (item) => {
            onFrame({ kind: 'item', item });
            sequence += 1;
            return { daemonEpoch: 'test', sequence };
          },
          emitAt: () => null,
          end: () =>
            onFrame({ kind: 'end', outcome: 'completed', error: null }),
          endAt: () => undefined,
        },
      );
      closeStream = close;
      drop = (): void => {
        close();
        onFrame({
          kind: 'end',
          outcome: 'error',
          error: { kind: 'unavailable' },
        });
      };
      return { close };
    },
  };
  const options: RemoteTerminalsOptions = {
    transport,
    persistence,
    resources: { register: () => ({ unregister: () => undefined }) },
    emit: (event) => {
      if (event.type === 'exit') lost.resolve();
    },
    log: () => undefined,
    // No reattach: a dropped stream ends the terminal as lost at once.
    reattachDelaysMs: [],
    createIdempotencyKey: () => 'remote-create',
    recordAttribution: () => Promise.resolve({ client, persistence }),
  };
  const terminals = new RemoteTerminals(options);
  return {
    terminals,
    create: async (): Promise<string> => {
      const created = await terminals.create({
        projectId: 'proj',
        worktreeId: 'wt',
        scope: { workspaceId: 'proj', worktreeId: 'wt' },
        cwdRootId: 'root',
        cwdRelativePath: '',
        cwd: root,
        shell: { shell: '/bin/sh', args: [], shellBasename: 'sh' },
        environment: {},
        cols: 80,
        rows: 24,
      });
      return created.id;
    },
    lose: async (): Promise<void> => {
      drop();
      await lost.promise;
    },
    close: (): void => closeStream(),
  };
}

it('history pages fit the default frame once JSON-encoded and resume where each page ended', () => {
  const authority = make();
  // Control bytes encode as \u00XX: a 4 MiB raw page is a 24 MiB reply.
  const line = `\u0001"\\${'\u0007'.repeat(1024 * 1024 - 3)}`;
  authority.apply({
    client,
    producer: { id: 'producer', runId: 'run' },
    seq: 1,
    ops: [
      { op: 'session.upsert', session: session('escaped') },
      {
        op: 'output.replace',
        terminalId: 'escaped',
        lines: Array.from({ length: 5 }, () => line),
      },
    ],
  });
  authority.flushSync();
  const reader = make();
  const expected = reader.historyTail(
    client,
    'escaped',
    Number.MAX_SAFE_INTEGER,
  );
  let text = '';
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = reader.historyRead({
      client,
      terminalId: 'escaped',
      maxBytes: 4 * 1024 * 1024,
      ...(cursor !== null && { cursor }),
    });
    expect(page.restarted).toBe(false);
    expect(
      Buffer.byteLength(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: page }),
        'utf8',
      ),
    ).toBeLessThanOrEqual(CANOPY_DEFAULT_MAX_FRAME_BYTES);
    text += page.text;
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== null && pages < 16);
  expect(cursor).toBeNull();
  expect(pages).toBeGreaterThan(2);
  expect(text.length).toBe(expected.length);
  expect(text === expected).toBe(true);
});

/** A record whose producer watermarks hold `runs` maximum-length keys. */
function manyRunsReader(runs: number): TerminalRecordAuthority {
  const authority = make();
  authority.apply({
    client,
    producer: { id: 'producer', runId: 'run' },
    seq: 1,
    ops: [
      { op: 'session.upsert', session: session('many-runs') },
      {
        op: 'output.replace',
        terminalId: 'many-runs',
        lines: ['history of many producer runs'],
      },
    ],
  });
  authority.flushSync();
  const repository = new TerminalRecordRepository({
    dataRoot: root,
    flushDirectorySync: (): void => undefined,
  });
  const loaded = repository.load('proj', 'wt');
  if (loaded.kind !== 'record') throw new Error('expected a record');
  // Valid keys of the longest allowed length, as many producer runs leave.
  for (let run = 0; run < runs; run += 1)
    loaded.envelope.producerWatermarks[
      `producer/${String(run).padStart(6, '0')}${'r'.repeat(1_009)}`
    ] = 1;
  repository.save(loaded.envelope);
  return make();
}

it('history pages omit durable receipts when both producer watermark maps cannot fit', () => {
  const page = manyRunsReader(4_500).historyRead({
    client,
    terminalId: 'many-runs',
  });
  expect(
    Buffer.byteLength(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: page }),
      'utf8',
    ),
  ).toBeLessThanOrEqual(CANOPY_DEFAULT_MAX_FRAME_BYTES);
  expect(page.text).toBe('history of many producer runs');
  expect(page.nextCursor).toBeNull();
  // Snapshot coverage stays complete; no replay copy is released.
  expect(Object.keys(page.snapshotProducerWatermarks ?? {})).toHaveLength(
    4_501,
  );
  expect(page.producerWatermarks).toBeUndefined();
});

it('history reads fail typed, never oversized, when snapshot coverage alone cannot fit', () => {
  const reader = manyRunsReader(9_000);
  const thrown = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };
  const failure = thrown(() =>
    reader.historyRead({ client, terminalId: 'many-runs' }),
  );
  expect(failure).toBeInstanceOf(CanopyOperationError);
  expect(failure).toMatchObject({
    payload: {
      kind: 'resource_exhausted',
      retry: { kind: 'never' },
      details: { reason: 'terminal_record_history_metadata_too_large' },
    },
  });
});

describe('release drain lifecycle intent', () => {
  function fixture(): ReportHost & {
    drain: PromiseWithResolvers<void>;
    drainOwned: jest.Mock<Promise<void>, []>;
    signals: (string | null)[];
    restore: () => Promise<WorkerTerminalRestoreResult>;
    close: () => Promise<void>;
  } {
    const drain = Promise.withResolvers<void>();
    const drainOwned = jest.fn(() => drain.promise);
    const f = reportHost({ drainOwned, exitOnKill: false });
    const authority = new TerminalRecordAuthority({
      repository: new TerminalRecordRepository({
        dataRoot: mkdtempSync(join(root, 'drain-')),
        flushDirectorySync: (): void => undefined,
      }),
      installDebounceMs: 1,
    });
    const handlers = createWorkerTerminalHandlers({
      supervisor: f.supervisor,
      record: authority,
      resolveRoot: () => Promise.resolve(root),
    });
    const signals: (string | null)[] = [];
    f.supervisor.onEvent((event, registration) => {
      if (event.type === 'exit') {
        signals.push(event.signal);
        authority.exited(registration, event.exitCode, event.signal);
      }
    });
    const context: CanopyHandlerContext = {
      requestId: 'release-drain',
      signal: new AbortController().signal,
      metadata: {},
      caller: {
        principalId: 'test',
        clientInstanceId: 'test',
        authorityId: 'test',
        interfaceKind: 'test',
        grants: [],
      },
    };
    let restoreNumber = 0;
    const restore = (): Promise<WorkerTerminalRestoreResult> => {
      const idempotencyKey = `drain-restore-${++restoreNumber}`;
      return handlers.instructions['worker.terminal.restore'](
        {
          scope: { workspaceId: 'proj', worktreeId: 'wt' },
          terminalId: 'draining',
          cols: 80,
          rows: 24,
          revision: 2,
          client,
          session: session('draining'),
          restoreMode: 'recreate_if_exited',
          historyFrom: 'record',
          _meta: { idempotencyKey },
          snapshot: {
            cwdRootId: 'root',
            cwdRelativePath: '',
            shell: '/bin/sh',
            args: [],
            env: {},
            scrollback: '',
          },
        },
        { ...context, metadata: { idempotencyKey } },
      );
    };
    return {
      ...f,
      drain,
      drainOwned,
      signals,
      restore,
      close: async (): Promise<void> => {
        drain.resolve();
        // The mock host exit does not dispose the in-process engine's timers.
        for (const pty of f.ptys) pty.exit({ exitCode: 0 });
        f.host.emit('exit', 0);
        try {
          await f.supervisor.stop();
        } finally {
          authority.dispose();
        }
      },
    };
  }

  it.each([
    ['connection-lost', 'worktree-cleanup'],
    ['worktree-cleanup', 'connection-lost'],
    ['connection-lost', undefined],
    [undefined, 'connection-lost'],
  ])(
    'joins releases (%s then %s) with one nonrestorable cleanup exit',
    async (first, second) => {
      const f = fixture();
      try {
        await f.restore();
        const releasing = f.supervisor.release('draining', first);
        await f.supervisor.list();
        const joining = f.supervisor.release('draining', second);
        await f.supervisor.list();
        expect(f.drainOwned).toHaveBeenCalledTimes(1);
        f.drain.resolve();
        expect(await Promise.all([releasing, joining])).toEqual([true, true]);
        expect(f.signals).toEqual(['worktree-cleanup']);
        await expect(f.restore()).rejects.toMatchObject({
          payload: {
            kind: 'failed_precondition',
            code: 'worker.terminal.invalidState',
          },
        });
        expect(f.ptys).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );

  it.each(['before', 'during', 'after-join'] as const)(
    "ranks a kill's reason %s a release drain, and a failed drain keeps the kill's",
    async (timing) => {
      // A drain's cleanup replaces a restorable kill reason, and a release
      // naming no reason replaces any kill's (CAN-7051).
      const drained = (signal: string): string =>
        timing === 'before' || signal === 'connection-lost'
          ? 'worktree-cleanup'
          : signal;
      for (const signal of [
        'user-close',
        'connection-lost',
        'worktree-cleanup',
        'SIGTERM',
      ]) {
        for (const fail of [false, true]) {
          const f = fixture();
          try {
            await f.restore();
            if (timing === 'before') f.engine.kill('draining', { signal });
            const releasing = f.engine.release('draining', {
              signal: timing === 'before' ? undefined : 'connection-lost',
            });
            if (timing === 'during') f.engine.kill('draining', { signal });
            const joining = f.engine.release('draining');
            const settled = Promise.allSettled([releasing, joining]);
            if (timing === 'after-join') f.engine.kill('draining', { signal });
            if (fail) f.drain.reject(new Error('drain failed'));
            else f.drain.resolve();
            expect((await settled).map((result) => result.status)).toEqual(
              fail ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled'],
            );
            if (fail) f.ptys[0].exit({ exitCode: 0 });
            expect(f.signals).toEqual([fail ? signal : drained(signal)]);
            expect(f.drainOwned).toHaveBeenCalledTimes(1);
          } finally {
            await f.close();
          }
        }
      }
    },
  );

  it.each([
    ['connection-lost', 'worktree-cleanup'],
    ['worktree-cleanup', 'connection-lost'],
  ])(
    'rolls back joined release reasons (%s then %s) after a failed drain',
    async (first, second) => {
      const f = fixture();
      try {
        await f.restore();
        const releasing = f.engine.release('draining', { signal: first });
        const joining = f.engine.release('draining', { signal: second });
        const settled = Promise.allSettled([releasing, joining]);
        f.drain.reject(new Error('drain failed'));
        expect((await settled).map((result) => result.status)).toEqual([
          'rejected',
          'rejected',
        ]);
        expect(f.signals).toEqual([]);
        f.ptys[0].exit({ exitCode: 7 });
        expect(f.signals).toEqual([null]);
        expect((await f.restore()).recreated).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it.each([
    'release-worktree',
    'kill-worktree',
    'kill',
    'kill-all',
    'shutdown',
  ] as const)(
    '%s can join a pending drain without losing cleanup or rollback ownership',
    async (action) => {
      for (const fail of [false, true]) {
        const f = fixture();
        try {
          await f.restore();
          const releasing = f.engine.release('draining', {
            signal: 'connection-lost',
          });
          const joining =
            action === 'release-worktree'
              ? f.engine.releaseWorktree({
                  projectId: 'proj',
                  worktreeId: 'wt',
                })
              : Promise.resolve();
          if (action === 'kill-worktree')
            f.engine.killWorktree({ projectId: 'proj', worktreeId: 'wt' });
          if (action === 'kill') f.engine.kill('draining');
          if (action === 'kill-all') f.engine.killAll();
          if (action === 'shutdown') f.engine.killAll({ reason: 'app-quit' });
          const settled = Promise.allSettled([releasing, joining]);
          if (fail) f.drain.reject(new Error('drain failed'));
          else f.drain.resolve();
          const results = await settled;
          expect(results[0].status).toBe(fail ? 'rejected' : 'fulfilled');
          expect(results[1].status).toBe(
            fail && action === 'release-worktree' ? 'rejected' : 'fulfilled',
          );
          if (fail) f.ptys[0].exit({ exitCode: 0 });
          const expected =
            action === 'kill-worktree'
              ? 'worktree-cleanup'
              : fail
                ? null
                : action === 'release-worktree'
                  ? 'worktree-cleanup'
                  : 'connection-lost';
          expect(f.signals).toEqual([expected]);
          expect(f.drainOwned).toHaveBeenCalledTimes(1);
        } finally {
          await f.close();
        }
      }
    },
  );

  it('retries a failed joined drain with a fresh release reason', async () => {
    const f = fixture();
    try {
      await f.restore();
      const releasing = f.engine.release('draining', {
        signal: 'connection-lost',
      });
      const joining = f.engine.release('draining');
      const settled = Promise.allSettled([releasing, joining]);
      f.drain.reject(new Error('drain failed'));
      expect((await settled).map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
      ]);
      f.drainOwned.mockResolvedValueOnce(undefined);
      await f.engine.release('draining', { signal: 'connection-lost' });
      expect(f.drainOwned).toHaveBeenCalledTimes(2);
      expect(f.signals).toEqual(['connection-lost']);
      expect((await f.restore()).recreated).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('treats a null release reason as cleanup and leaves missing terminals alone', async () => {
    const f = fixture();
    try {
      await expect(
        f.engine.release('missing', { signal: null }),
      ).resolves.toBeUndefined();
      expect(f.drainOwned).not.toHaveBeenCalled();
      await f.restore();
      const releasing = f.engine.release('draining', {
        signal: 'connection-lost',
      });
      const joining = f.engine.release('draining', { signal: null });
      f.drain.resolve();
      await Promise.all([releasing, joining]);
      expect(f.signals).toEqual(['worktree-cleanup']);
      expect(f.drainOwned).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it('leaves a same-ID restored lifetime untouched when the old release drain completes', async () => {
    const f = fixture();
    try {
      await f.restore();
      const releasing = f.supervisor.release('draining', 'connection-lost');
      await f.supervisor.list();
      f.ptys[0].data('old lifetime');
      f.ptys[0].exit({ exitCode: 7 });
      expect(f.signals).toEqual(['connection-lost']);
      expect((await f.restore()).recreated).toBe(true);
      expect(f.ptys).toHaveLength(2);
      const replacement = f.engine.get('draining');
      const replacementReplay = f.engine.replay('draining');
      f.drain.resolve();
      expect(await releasing).toBe(true);
      // Old callbacks must not publish output or exit into the replacement either.
      f.ptys[0].data('stale output');
      f.ptys[0].exit({ exitCode: 9 });
      expect(f.engine.get('draining')).toEqual(replacement);
      expect(f.engine.replay('draining')).toEqual(replacementReplay);
      expect(f.supervisor.isLive('draining')).toBe(true);
      expect(f.signals).toEqual(['connection-lost']);
      f.ptys[1].data('replacement output');
      f.ptys[1].exit({ exitCode: 0 });
      expect(f.signals).toEqual(['connection-lost', null]);
    } finally {
      await f.close();
    }
  });
});

it.each([
  'host-loss',
  'same-turn-loss',
  'failed-release',
  'quit-then-host-loss',
  'exit-timeout',
] as const)(
  'keeps an acknowledged user close nonrestorable after %s',
  async (ending) => {
    jest.useFakeTimers();
    const f = reportHost({
      exitOnKill: false,
      drainOwned: () => Promise.reject(new Error('drain failed')),
    });
    const authority = make();
    const handlers = createWorkerTerminalHandlers({
      supervisor: f.supervisor,
      record: authority,
      resolveRoot: () => Promise.resolve(root),
    });
    f.supervisor.onEvent((event, registration) => {
      if (event.type === 'exit')
        authority.exited(registration, event.exitCode, event.signal);
    });
    const context: CanopyHandlerContext = {
      requestId: 'acknowledged-close',
      signal: new AbortController().signal,
      metadata: {},
      caller: {
        principalId: 'test',
        clientInstanceId: 'test',
        authorityId: 'test',
        interfaceKind: 'test',
        grants: [],
      },
    };
    const restore = (
      idempotencyKey: string,
    ): Promise<WorkerTerminalRestoreResult> =>
      handlers.instructions['worker.terminal.restore'](
        {
          scope: { workspaceId: 'proj', worktreeId: 'wt' },
          terminalId: 'closed',
          cols: 80,
          rows: 24,
          revision: 2,
          client,
          session: session('closed'),
          restoreMode: 'recreate_if_exited',
          historyFrom: 'record',
          _meta: { idempotencyKey },
          snapshot: {
            cwdRootId: 'root',
            cwdRelativePath: '',
            shell: '/bin/sh',
            args: [],
            env: {},
            scrollback: '',
          },
        },
        { ...context, metadata: { idempotencyKey } },
      );
    try {
      await restore('create');
      const attachedSignals: (string | null)[] = [];
      await f.supervisor.attach(
        { terminalId: 'closed', fromOffset: 0 },
        {
          item: (item, id) => {
            f.supervisor.acknowledge(id, item.toOffset);
            if (item.exit) attachedSignals.push(item.exit.signal);
          },
          end: () => undefined,
        },
      );
      // Runs after the supervisor receives the reply but before kill resumes.
      const loseAfterReply = (message: TerminalHostMessage): void => {
        if (message.kind === 'response' && message.ok) f.host.emit('exit', 1);
      };
      if (ending === 'same-turn-loss') f.host.once('message', loseAfterReply);
      await handlers.instructions['worker.terminal.kill'](
        {
          scope: { workspaceId: 'proj', worktreeId: 'wt' },
          terminalId: 'closed',
          revision: 2,
          exitSignal: 'user-close',
        },
        context,
      );
      if (ending === 'failed-release')
        await expect(
          handlers.instructions['worker.terminal.release'](
            {
              scope: { workspaceId: 'proj', worktreeId: 'wt' },
              terminalId: 'closed',
              revision: 2,
              exitSignal: 'worktree-cleanup',
            },
            context,
          ),
        ).rejects.toThrow();
      // A quit's restorable reason never replaces the acknowledged close.
      if (ending === 'quit-then-host-loss')
        await handlers.instructions['worker.terminal.kill'](
          {
            scope: { workspaceId: 'proj', worktreeId: 'wt' },
            terminalId: 'closed',
            revision: 2,
            exitSignal: 'app-quit',
          },
          context,
        );
      if (ending === 'exit-timeout') await jest.advanceTimersByTimeAsync(2_000);
      else f.host.emit('exit', 1);
      authority.flushSync();
      const durable = new TerminalRecordRepository({
        dataRoot: root,
        flushDirectorySync: (): void => undefined,
      }).load('proj', 'wt');
      expect(durable.kind).toBe('record');
      if (durable.kind !== 'record') throw new Error('Missing closed terminal');
      expect(durable.envelope.record.terminals[0].signal).toBe('user-close');
      expect(attachedSignals).toEqual(['user-close']);
      await expect(restore('must-not-reopen')).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'worker.terminal.invalidState',
        },
      });
      expect(f.ptys).toHaveLength(1);
    } finally {
      f.host.emit('exit', 0);
      await f.supervisor.stop();
      authority.dispose();
      jest.useRealTimers();
    }
  },
);

it('records an acknowledged close before the create reply installs its lifetime', async () => {
  const authority = make();
  const terminal: TerminalHostTerminal = {
    session: session('opening'),
    lifetimeId: 1,
    pid: null,
    cols: 80,
    rows: 24,
    outputOffset: 0,
    running: true,
    processName: 'sh',
  };
  class Host extends EventEmitter implements TerminalHostProcess {
    public postMessage(message: TerminalHostRequestMessage): void {
      this.emit('message', {
        kind: 'response',
        id: message.id,
        ok: true,
        value: terminal,
      });
      if (message.request.op === 'kill') this.emit('exit', 1);
    }
    public kill(): boolean {
      this.emit('exit', 0);
      return true;
    }
  }
  const host = new Host();
  const supervisor = new TerminalHostSupervisor({
    launch: (): TerminalHostProcess => host,
  });
  supervisor.onEvent((event, registration): void => {
    if (event.type === 'exit')
      authority.exited(registration, event.exitCode, event.signal);
  });
  try {
    const opening = supervisor.create(
      {
        projectId: 'proj',
        worktreeId: 'wt',
        root,
        cwd: root,
        environment: {},
        shell: { shell: '/bin/sh', args: [], shellBasename: 'sh' },
        persist: true,
      },
      80,
      24,
      (created) =>
        authority.attribute({
          terminalId: created.session.id,
          client,
          session: created.session,
          persist: true,
        }),
    );
    await Promise.all([opening, supervisor.kill('opening', 'user-close')]);
    authority.flushSync();
    const durable = new TerminalRecordRepository({
      dataRoot: root,
      flushDirectorySync: (): void => undefined,
    }).load('proj', 'wt');
    expect(durable.kind).toBe('record');
    if (durable.kind !== 'record') throw new Error('Missing opening terminal');
    expect(durable.envelope.record.terminals[0].signal).toBe('user-close');
    expect(authority.restoreHistoryTail(client, 'opening', 1)?.signal).toBe(
      'user-close',
    );
  } finally {
    host.emit('exit', 0);
    await supervisor.stop();
    authority.dispose();
  }
});

it.each(['host-loss', 'recreated', 'detach-one'] as const)(
  'retains a completed lifetime exit for credit-blocked attachments after %s',
  async (ending): Promise<void> => {
    jest.useFakeTimers();
    const f = reportHost({ exitOnKill: false });
    const exits: { exitCode: number | null; signal: string | null }[][] = [
      [],
      [],
      [],
    ];
    const ends: string[] = [];
    const attach = async (index: number): Promise<string> => {
      const opened = await f.supervisor.attach(
        { terminalId: 'closed', fromOffset: 0 },
        {
          item: (item): void => {
            if (item.exit) exits[index].push(item.exit);
          },
          end: (outcome): void => {
            ends.push(`${index}:${outcome}`);
          },
        },
      );
      return opened.attachmentId;
    };
    try {
      await restoreForProgress(f, 'closed');
      const first = await attach(0);
      await attach(1);
      for (let i = 0; i < 128; i++) {
        f.ptys[0].data('x');
        jest.advanceTimersByTime(20);
      }
      await f.supervisor.kill('closed', 'user-close');
      f.ptys[0].exit({ exitCode: 7 });
      expect(f.supervisor.isLive('closed')).toBe(false);
      expect(exits).toEqual([[], [], []]);
      expect(ends).toEqual([]);
      if (ending === 'recreated') {
        await restoreForProgress(f, 'closed');
        await attach(2);
      }
      if (ending === 'detach-one') {
        f.supervisor.detach(first);
        await Promise.resolve();
        await Promise.resolve();
        expect(ends).toEqual(['0:cancelled']);
      }
      f.host.emit('exit', 1);
      const known = [{ exitCode: 7, signal: 'user-close' }];
      expect(exits[0]).toEqual(ending === 'detach-one' ? [] : known);
      expect(exits[1]).toEqual(known);
      expect(exits[2]).toEqual(
        ending === 'recreated'
          ? [{ exitCode: null, signal: WORKER_TERMINAL_LOST_SIGNAL }]
          : [],
      );
      expect(ends).toEqual(
        ending === 'detach-one'
          ? ['0:cancelled', '1:completed']
          : ending === 'recreated'
            ? ['0:completed', '1:completed', '2:completed']
            : ['0:completed', '1:completed'],
      );
    } finally {
      f.host.emit('exit', 0);
      await f.supervisor.stop();
      jest.useRealTimers();
    }
  },
);

it.each([
  ['supervisor', 'exited', 'missed'],
  ['supervisor', 'exited', 'received'],
  ['supervisor', 'running', 'missed'],
  ['supervisor', 'running', 'received'],
  ['stream', 'exited', 'missed'],
  ['stream', 'exited', 'received'],
  ['stream', 'running', 'missed'],
  ['stream', 'running', 'received'],
  // A client that reattaches after the host ended, at its last offset.
  ['reattach', 'exited', 'missed'],
  ['reattach', 'exited', 'received'],
  ['reattach', 'running', 'missed'],
  ['reattach', 'running', 'received'],
] as const)(
  'marks a host-loss exit truncated unless its PTY exit confirmed the attachment has every byte (%s, %s, %s)',
  async (path, pty, output): Promise<void> => {
    jest.useFakeTimers();
    const terminal: TerminalHostTerminal = {
      session: session('lost'),
      lifetimeId: 1,
      pid: null,
      cols: 80,
      rows: 24,
      outputOffset: 0,
      running: true,
      processName: 'sh',
    };
    let attachmentId = '';
    class Host extends EventEmitter implements TerminalHostProcess {
      public postMessage(message: TerminalHostRequestMessage): void {
        const { request } = message;
        if (request.op === 'attach') attachmentId = request.attachmentId;
        this.emit('message', {
          kind: 'response',
          id: message.id,
          ok: true,
          value:
            request.op === 'restore'
              ? { terminal, recreated: true }
              : request.op === 'attach'
                ? terminal
                : true,
        });
      }
      public kill(): boolean {
        this.emit('exit', 0);
        return true;
      }
    }
    const host = new Host();
    const supervisor = new TerminalHostSupervisor({
      launch: (): TerminalHostProcess => host,
    });
    const handlers = createWorkerTerminalHandlers({
      supervisor,
      resolveRoot: () => Promise.resolve(root),
    });
    const context: CanopyHandlerContext = {
      requestId: 'host-loss-truncation',
      signal: new AbortController().signal,
      metadata: { idempotencyKey: 'host-loss-truncation' },
      caller: {
        principalId: 'test',
        clientInstanceId: 'test',
        authorityId: 'test',
        interfaceKind: 'test',
        grants: [],
      },
    };
    const exits: {
      fromOffset: number;
      truncatedBefore: boolean;
      exit: unknown;
    }[] = [];
    const ends: string[] = [];
    let sequence = 0;
    const attachStream = (fromOffset: number): Promise<unknown> =>
      handlers.streams['worker.terminal.attach'](
        {
          scope: { workspaceId: 'proj', worktreeId: 'wt' },
          terminalId: 'lost',
          fromOffset,
        },
        context,
        {
          emit: (item) => {
            if (item.exit)
              exits.push({
                fromOffset: item.fromOffset,
                truncatedBefore: item.truncatedBefore,
                exit: item.exit,
              });
            sequence += 1;
            return { daemonEpoch: 'test', sequence };
          },
          emitAt: () => null,
          end: (outcome): void => {
            ends.push(outcome);
          },
          endAt: (): void => undefined,
        },
      );
    try {
      await handlers.instructions['worker.terminal.restore'](
        {
          scope: { workspaceId: 'proj', worktreeId: 'wt' },
          terminalId: 'lost',
          cols: 80,
          rows: 24,
          restoreMode: 'recreate_if_exited',
          _meta: { idempotencyKey: 'host-loss-truncation' },
          snapshot: {
            cwdRootId: 'root',
            cwdRelativePath: '',
            shell: '/bin/sh',
            args: [],
            env: {},
            scrollback: '',
          },
        },
        context,
      );
      if (path === 'supervisor')
        await supervisor.attach(
          { terminalId: 'lost', fromOffset: 0 },
          {
            item: (item): void => {
              if (item.exit)
                exits.push({
                  fromOffset: item.fromOffset,
                  truncatedBefore: item.truncatedBefore,
                  exit: { code: item.exit.exitCode, signal: item.exit.signal },
                });
            },
            end: (outcome): void => {
              ends.push(outcome);
            },
          },
        );
      else if (path === 'stream') await attachStream(0);
      host.emit('message', {
        kind: 'item',
        attachmentId,
        item: {
          terminalId: 'lost',
          fromOffset: 0,
          toOffset: 4,
          data: new TextEncoder().encode('seen'),
          truncatedBefore: false,
          exit: null,
        },
      });
      const outputOffset = output === 'missed' ? 12 : 4;
      // The host saw output past what this attachment's items carried. Only
      // its own PTY exit confirms a final offset; this report never does.
      host.emit('message', {
        kind: 'report',
        report: {
          type: 'offset',
          terminalId: 'lost',
          outputOffset,
          lifetimeId: 1,
        },
      });
      if (pty === 'exited')
        host.emit('message', {
          kind: 'event',
          event: {
            type: 'exit',
            terminalId: 'lost',
            lifetimeId: 1,
            exitCode: 0,
            signal: null,
            outputOffset,
          },
        });
      expect(exits).toEqual([]);
      host.emit('exit', 1);
      await jest.advanceTimersByTimeAsync(50);
      if (path === 'reattach') {
        await attachStream(4);
        await jest.advanceTimersByTimeAsync(50);
      }
      expect(exits).toEqual([
        {
          fromOffset: 4,
          // Unconfirmed (running) ends are truncated even when caught up.
          truncatedBefore: pty === 'running' || output === 'missed',
          exit:
            pty === 'exited'
              ? { code: 0, signal: null }
              : { code: null, signal: WORKER_TERMINAL_LOST_SIGNAL },
        },
      ]);
      expect(ends).toEqual(['completed']);
    } finally {
      await supervisor.stop();
      jest.useRealTimers();
    }
  },
);

it.each([
  [true, true, true],
  [true, true, false],
  [true, false, true],
  [true, false, false],
  [false, true, true],
  [false, true, false],
  [false, false, true],
  [false, false, false],
])(
  'replays a known lifecycle exit after its final attachment completes and a restore reply registers (already registered: %s, host loss: %s, initializer: %s)',
  async (registered, hostLoss, initialize): Promise<void> => {
    jest.useFakeTimers();
    let attachmentId = '';
    const completions: string[] = [];
    const initialized: {
      lifetimeId: number | undefined;
      recreated: boolean;
    }[] = [];
    const attachedExits: { exitCode: number | null; signal: string | null }[] =
      [];
    class Host extends EventEmitter implements TerminalHostProcess {
      private terminal: TerminalHostTerminal | undefined;
      private nextLifetimeId = 1;

      public postMessage(message: TerminalHostRequestMessage): void {
        const { request } = message;
        let value: unknown;
        if (request.op === 'restore') {
          const recreated = this.terminal === undefined;
          if (!this.terminal) {
            if (!request.recreate) {
              this.emit('message', {
                kind: 'response',
                id: message.id,
                ok: false,
                error: {
                  code: 'notFound',
                  message: `Terminal not found: ${request.terminalId}`,
                },
              });
              return;
            }
            this.terminal = {
              session: session(request.terminalId),
              lifetimeId: this.nextLifetimeId++,
              pid: null,
              cols: request.cols,
              rows: request.rows,
              outputOffset: 0,
              running: true,
              processName: 'sh',
            };
          }
          value = { terminal: this.terminal, recreated };
        } else if (request.op === 'attach') {
          if (!this.terminal) throw new Error('No live terminal to attach');
          attachmentId = request.attachmentId;
          value = this.terminal;
        }
        this.emit('message', {
          kind: 'response',
          id: message.id,
          ok: true,
          value,
        });
      }
      public exit(exitCode: number, signal: string | null): void {
        if (!this.terminal) throw new Error('No live terminal to exit');
        const { session, lifetimeId } = this.terminal;
        this.terminal = undefined;
        this.emit('message', {
          kind: 'event',
          event: {
            type: 'exit',
            terminalId: session.id,
            lifetimeId,
            exitCode,
            signal,
          },
        });
      }
      public finish(): void {
        this.exit(9, 'user-close');
        // Evict the recent-exit cache before the restore continuation registers.
        for (let i = 0; i < 300; i += 1)
          this.emit('message', {
            kind: 'event',
            event: {
              type: 'exit',
              terminalId: `unrelated-${i}`,
              lifetimeId: i + 3,
              exitCode: 0,
              signal: null,
            },
          });
        this.emit('message', {
          kind: 'item',
          attachmentId,
          item: {
            terminalId: 'same',
            fromOffset: 0,
            toOffset: 0,
            data: new Uint8Array(),
            truncatedBefore: false,
            exit: { exitCode: 9, signal: 'user-close' },
          },
        });
        this.emit('message', {
          kind: 'end',
          attachmentId,
          outcome: 'completed',
          offset: 0,
        });
        expect(completions).toEqual(['completed']);
        if (hostLoss) this.emit('exit', 1);
      }
      public kill(): boolean {
        this.emit('exit', 0);
        return true;
      }
    }
    const host = new Host();
    const supervisor = new TerminalHostSupervisor({
      launch: (): TerminalHostProcess => host,
    });
    const exits: {
      lifetimeId: number | undefined;
      exitCode: number | null;
      signal: string | null;
    }[] = [];
    supervisor.onEvent((event): void => {
      if (event.type === 'exit')
        exits.push({
          lifetimeId: event.lifetimeId,
          exitCode: event.exitCode,
          signal: event.signal,
        });
    });
    try {
      const request = {
        op: 'restore',
        terminalId: 'same',
        cols: 80,
        rows: 24,
      } as const;
      await expect(supervisor.restore(request)).rejects.toMatchObject({
        error: { code: 'notFound' },
      });
      const recreate = {
        projectId: 'proj',
        worktreeId: 'wt',
        root,
        cwd: root,
        environment: {},
        shell: { shell: '/bin/sh', args: [], shellBasename: 'sh' },
        scrollback: '',
        persist: true,
      };
      await expect(
        supervisor.restore({ ...request, recreate }),
      ).resolves.toMatchObject({
        terminal: { lifetimeId: 1 },
        recreated: true,
      });
      expect(supervisor.isLive('same')).toBe(true);
      if (!registered) {
        host.exit(0, null);
        expect(supervisor.isLive('same')).toBe(false);
        await expect(supervisor.restore(request)).rejects.toMatchObject({
          error: { code: 'notFound' },
        });
      }
      const restoring = supervisor.restore(
        registered ? request : { ...request, recreate },
        initialize
          ? (terminal, recreated): void => {
              initialized.push({ lifetimeId: terminal.lifetimeId, recreated });
            }
          : undefined,
      );
      const attaching = supervisor.attach(
        { terminalId: 'same', fromOffset: 0 },
        {
          item: (item): void => {
            if (item.exit) attachedExits.push(item.exit);
          },
          end: (outcome): void => {
            completions.push(outcome);
          },
        },
      );
      host.finish();
      const [restored] = await Promise.all([restoring, attaching]);
      expect(restored).toMatchObject({
        terminal: { lifetimeId: registered ? 1 : 2 },
        recreated: !registered,
      });
      expect(initialized).toEqual(
        initialize
          ? [{ lifetimeId: registered ? 1 : 2, recreated: !registered }]
          : [],
      );
      // New attributions observe the exit during registration; legacy callers
      // observe it only after their reply, on the next timer turn.
      if (!registered)
        expect(exits).toEqual([
          { lifetimeId: 1, exitCode: 0, signal: null },
          ...(initialize
            ? [{ lifetimeId: 2, exitCode: 9, signal: 'user-close' }]
            : []),
        ]);
      jest.advanceTimersByTime(0);
      expect(attachedExits).toEqual([{ exitCode: 9, signal: 'user-close' }]);
      expect(completions).toEqual(['completed']);
      expect(exits).toEqual([
        ...(!registered
          ? [
              {
                lifetimeId: 1,
                exitCode: 0,
                signal: null,
              },
            ]
          : []),
        { lifetimeId: registered ? 1 : 2, exitCode: 9, signal: 'user-close' },
      ]);
      expect(supervisor.isLive('same')).toBe(false);
    } finally {
      host.emit('exit', 0);
      await supervisor.stop();
      jest.useRealTimers();
    }
  },
);
