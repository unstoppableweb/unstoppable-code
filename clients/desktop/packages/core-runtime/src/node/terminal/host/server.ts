import type {
  PersistedTerminalEntry,
  TerminalSession,
} from '@canopy/protocol/terminal';
import type { PlatformOperatingSystem } from '../../../platform/platform-services';
import { TerminalEngine, type TerminalEngineOptions } from '../engine';
import type {
  TerminalEngineHost,
  TerminalLogPort,
  TerminalProcessPort,
  TerminalPtyPort,
} from '../ports';
import { TerminalShells } from '../shells';
import {
  isTerminalHostRequestMessage,
  type TerminalHostError,
  type TerminalHostLaunch,
  type TerminalHostMessage,
  type TerminalHostRequest,
  type TerminalHostTerminal,
} from './protocol';

/** The execution host channel, as the terminal host uses it. */
export interface TerminalHostChannel {
  postMessage(message: TerminalHostMessage): void;
  congested?(): boolean;
  onceDrained?(listener: () => void): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
}

export interface TerminalHostServerOptions {
  readonly channel: TerminalHostChannel;
  readonly pty: TerminalPtyPort;
  readonly processes: TerminalProcessPort;
  readonly platform: PlatformOperatingSystem;
  /** A variable of the host process environment (`LANG`). */
  readonly variable: (name: string) => string | undefined;
  readonly log: TerminalLogPort;
  readonly engine?: TerminalEngineOptions;
  /** How long `stop` waits for killed terminals to exit. */
  readonly stopTimeoutMs?: number;
}

/**
 * A terminal host's live terminals, at most the attachments a worker can
 * keep open for them with room left for other clients.
 */
export const TERMINAL_HOST_MAX_LIVE_TERMINALS = 48;

const STOP_TIMEOUT_MS = 3_000;

/**
 * Output reports (CAN-7051): a persisted terminal's bytes leave at most this
 * often, or sooner once this many are held; offsets at most once a second.
 */
const OUTPUT_REPORT_INTERVAL_MS = 50;
const OUTPUT_REPORT_MAX_BYTES = 256 * 1024;
const OFFSET_REPORT_INTERVAL_MS = 1_000;
const MAX_HELD_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_HELD_OUTPUT_REPORTS = 256;

class TerminalHostFailure extends Error {
  public constructor(
    public readonly code: TerminalHostError['code'],
    message: string,
  ) {
    super(message);
  }
}

function hostError(error: unknown): TerminalHostError {
  if (error instanceof TerminalHostFailure)
    return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  if (
    code === 'ERR_TERMINAL_CAPACITY' ||
    code === 'ERR_TERMINAL_ATTACHMENT_CAPACITY'
  )
    return { code: 'capacity', message };
  if (message.startsWith('Terminal not found'))
    return { code: 'notFound', message };
  if (message.startsWith('Terminal is not restorable'))
    return { code: 'invalidState', message };
  return { code: 'failed', message };
}

function scopeKey(projectId: string, worktreeId: string): string {
  return `${projectId}\u0000${worktreeId}`;
}

/**
 * Serves one terminal host process: the terminal engine over the host's PTY
 * library, behind the worker's private request channel. The host keeps no
 * terminal state of its own: its client resolves every directory, shell and
 * environment, and persists sessions and output.
 */
export function serveTerminalHost(options: TerminalHostServerOptions): {
  readonly engine: TerminalEngine;
} {
  const { channel } = options;
  const roots = new Map<string, string>();
  const seeded = new Map<string, PersistedTerminalEntry>();
  const pids = new Map<string, number>();
  const lifetimes = new Map<string, number>();
  let nextLifetime = 0;
  const sizes = new Map<string, { cols: number; rows: number }>();
  const offsets = new Map<string, number>();
  // Persistence can flush before the engine publishes its output offset.
  const appendedOffsets = new Map<string, number>();
  const attachments = new Map<string, string>();
  // Terminals whose bytes belong in the worktree record (CAN-7051).
  const persisted = new Set<string>();
  const firstOutput = new Set<string>();
  const pendingOutput = new Map<
    string,
    { chunks: Buffer[]; bytes: number; toOffset: number }
  >();
  const changedOffsets = new Set<string>();
  let outputTimer: ReturnType<typeof setTimeout> | undefined;
  let offsetTimer: ReturnType<typeof setTimeout> | undefined;

  const host: TerminalEngineHost = {
    shells: new TerminalShells({
      platform: () => options.platform,
      linuxLoginShellsSupported: () => false,
      accountShell: () => Promise.resolve(undefined),
      findOnPath: () => null,
      windowsGitBash: () => null,
      variable: options.variable,
    }),
    pty: options.pty,
    environment: {
      base: () => ({}),
      worktree: () => ({}),
      variable: options.variable,
    },
    workspace: {
      worktreeCwd: (projectId, worktreeId) => {
        const root = roots.get(scopeKey(projectId, worktreeId));
        if (root === undefined)
          throw new TerminalHostFailure(
            'invalidState',
            'The terminal scope has no resolved root.',
          );
        return root;
      },
      assertStartAllowed: () => undefined,
    },
    resources: {
      register: (session, pid) => {
        pids.set(session.id, pid);
        return {
          unregister: () => {
            if (pids.get(session.id) === pid) pids.delete(session.id);
          },
        };
      },
    },
    persistence: {
      registerLiveSession: (session) => {
        lifetimes.set(session.id, ++nextLifetime);
        appendedOffsets.set(
          session.id,
          Buffer.byteLength(
            seeded.get(session.id)?.scrollbackLines.join('\n') ?? '',
            'utf8',
          ),
        );
      },
      // Reported, not kept: the worker's record authority writes it.
      appendTerminalOutput: (_projectId, _worktreeId, terminalId, chunk) => {
        if (!persisted.has(terminalId) || chunk.length === 0) return;
        for (let start = 0; start < chunk.length; ) {
          const pending = pendingOutput.get(terminalId) ?? {
            chunks: [],
            bytes: 0,
            toOffset: appendedOffsets.get(terminalId) ?? 0,
          };
          let end = Math.min(
            chunk.length,
            start + OUTPUT_REPORT_MAX_BYTES - pending.bytes,
          );
          // A pressure trim may start at any report: keep UTF-8 boundaries.
          while (
            end > start &&
            end < chunk.length &&
            (chunk[end] & 0xc0) === 0x80
          )
            end -= 1;
          if (end === start) {
            flushOutput(terminalId);
            continue;
          }
          pending.chunks.push(Buffer.from(chunk.subarray(start, end)));
          pending.bytes += end - start;
          pending.toOffset += end - start;
          appendedOffsets.set(terminalId, pending.toOffset);
          start = end;
          pendingOutput.set(terminalId, pending);
          if (pending.bytes >= OUTPUT_REPORT_MAX_BYTES) flushOutput(terminalId);
          else scheduleOutput();
        }
      },
      markTerminalExited: () => undefined,
      getPersistedTerminalEntry: (terminalId) => seeded.get(terminalId) ?? null,
    },
    processes: options.processes,
    log: options.log,
  };
  const engine = new TerminalEngine(host, {
    maxLiveTerminals: TERMINAL_HOST_MAX_LIVE_TERMINALS,
    ...options.engine,
  });

  const held: TerminalHostMessage[] = [];
  const heldExits = new Map<string, number>();
  let heldBytes = 0;
  let heldOutputs = 0;
  // Held frames other than reports. Only reports may be trimmed or coalesced.
  let heldOrdered = 0;
  let drainCallbackArmed = false;
  let draining = false;

  function drainReports(): void {
    if (draining) return;
    draining = true;
    try {
      while (held.length > 0 && !channel.congested?.()) {
        const message = held.shift();
        if (!message) break;
        if (message.kind !== 'report') heldOrdered -= 1;
        if (message.kind === 'report' && message.report.type === 'output') {
          heldBytes -= message.report.data.byteLength;
          heldOutputs -= 1;
        }
        if (message.kind === 'event' && message.event.type === 'exit') {
          const terminalId = message.event.terminalId;
          const remaining = (heldExits.get(terminalId) ?? 1) - 1;
          if (remaining === 0) heldExits.delete(terminalId);
          else heldExits.set(terminalId, remaining);
        }
        channel.postMessage(message);
      }
    } finally {
      draining = false;
    }
    if (held.length > 0 && !drainCallbackArmed && channel.onceDrained) {
      drainCallbackArmed = true;
      channel.onceDrained(() => {
        drainCallbackArmed = false;
        drainReports();
      });
    }
  }

  function post(message: TerminalHostMessage, ordered = false): void {
    // While an exit or reply waits, later frames queue behind it: traffic
    // that bypassed the lane could keep the channel congested indefinitely.
    // Attachment credit and request replies bound what queues meanwhile.
    if (
      !ordered &&
      heldOrdered === 0 &&
      message.kind !== 'report' &&
      !(message.kind === 'event' && message.event.type === 'exit') &&
      !(message.kind === 'item' && message.item.exit) &&
      !(message.kind === 'end' && message.outcome === 'completed')
    ) {
      // Attachment traffic may keep the writer nonempty below high water.
      // Inspect capacity even while the full-idle callback remains armed.
      drainReports();
      channel.postMessage(message);
      return;
    }
    if (message.kind === 'event' && message.event.type === 'exit') {
      const terminalId = message.event.terminalId;
      heldExits.set(terminalId, (heldExits.get(terminalId) ?? 0) + 1);
    }
    held.push(message);
    if (message.kind !== 'report') heldOrdered += 1;
    if (message.kind === 'report' && message.report.type === 'output') {
      heldBytes += message.report.data.byteLength;
      heldOutputs += 1;
    }
    if (message.kind === 'report' && message.report.type === 'offset') {
      const report = message.report;
      const index = held.findIndex(
        (entry) =>
          entry !== message &&
          entry.kind === 'report' &&
          entry.report.type === 'offset' &&
          entry.report.terminalId === report.terminalId &&
          entry.report.lifetimeId === report.lifetimeId,
      );
      if (index >= 0) held.splice(index, 1);
    }
    // Cap only what remains held after using the channel's current capacity.
    drainReports();
    // Retain the newest bounded output under pressure, never block a shell.
    // Exit frames stay behind the retained bytes of their exact lifetime.
    while (
      heldBytes > MAX_HELD_REPORT_BYTES ||
      heldOutputs > MAX_HELD_OUTPUT_REPORTS
    ) {
      const index = held.findIndex(
        (entry) => entry.kind === 'report' && entry.report.type === 'output',
      );
      const oldest = held[index];
      if (
        !oldest ||
        oldest.kind !== 'report' ||
        oldest.report.type !== 'output'
      )
        break;
      heldBytes -= oldest.report.data.byteLength;
      heldOutputs -= 1;
      held.splice(index, 1);
    }
  }

  function flushOutput(terminalId: string): void {
    const pending = pendingOutput.get(terminalId);
    if (!pending) return;
    pendingOutput.delete(terminalId);
    post({
      kind: 'report',
      report: {
        type: 'output',
        lifetimeId: lifetimes.get(terminalId),
        terminalId,
        toOffset: pending.toOffset,
        data: new Uint8Array(Buffer.concat(pending.chunks)),
      },
    });
  }

  function scheduleOutput(): void {
    if (outputTimer !== undefined) return;
    outputTimer = setTimeout(() => {
      outputTimer = undefined;
      for (const terminalId of Array.from(pendingOutput.keys()))
        flushOutput(terminalId);
    }, OUTPUT_REPORT_INTERVAL_MS);
  }

  function flushOffsets(): void {
    for (const terminalId of changedOffsets) {
      const outputOffset = offsets.get(terminalId);
      if (outputOffset !== undefined)
        post({
          kind: 'report',
          report: {
            type: 'offset',
            terminalId,
            outputOffset,
            lifetimeId: lifetimes.get(terminalId),
          },
        });
    }
    changedOffsets.clear();
  }

  function noteOutput(terminalId: string): void {
    if (!firstOutput.has(terminalId)) {
      firstOutput.add(terminalId);
      post({
        kind: 'report',
        report: {
          type: 'firstOutput',
          terminalId,
          at: Date.now(),
          lifetimeId: lifetimes.get(terminalId),
        },
      });
    }
    changedOffsets.add(terminalId);
    if (offsetTimer !== undefined) return;
    offsetTimer = setTimeout(() => {
      offsetTimer = undefined;
      flushOffsets();
    }, OFFSET_REPORT_INTERVAL_MS);
  }

  engine.setEventSink((event) => {
    if (event.type === 'output') {
      // Live PTY output only: a restore's replay never reaches this sink.
      offsets.set(event.payload.terminalId, event.payload.seq);
      noteOutput(event.payload.terminalId);
      return;
    }
    if (event.type === 'runningChanged') {
      post({
        kind: 'event',
        event: {
          type: 'runningChanged',
          lifetimeId: lifetimes.get(event.payload.terminalId),
          terminalId: event.payload.terminalId,
          running: event.payload.running,
          processName: event.payload.processName ?? null,
          ...(event.payload.interruptedByUser !== undefined && {
            interruptedByUser: event.payload.interruptedByUser,
          }),
        },
      });
      return;
    }
    if (event.type === 'exit') {
      const { terminalId } = event.payload;
      const lifetimeId = lifetimes.get(terminalId);
      const outputOffset = offsets.get(terminalId) ?? 0;
      // Every byte is reported before the exit that follows it.
      flushOutput(terminalId);
      persisted.delete(terminalId);
      firstOutput.delete(terminalId);
      changedOffsets.delete(terminalId);
      sizes.delete(terminalId);
      offsets.delete(terminalId);
      appendedOffsets.delete(terminalId);
      // Queued frames and replies already carry their own lifetime.
      lifetimes.delete(terminalId);
      post({
        kind: 'event',
        event: {
          type: 'exit',
          lifetimeId,
          terminalId: event.payload.terminalId,
          exitCode: event.payload.exitCode,
          signal: event.payload.signal,
          outputOffset,
        },
      });
    }
  });

  const describe = (session: TerminalSession): TerminalHostTerminal => {
    const size = sizes.get(session.id) ?? { cols: 1, rows: 1 };
    return {
      session,
      lifetimeId: lifetimes.get(session.id),
      pid: pids.get(session.id) ?? null,
      cols: size.cols,
      rows: size.rows,
      outputOffset: offsets.get(session.id) ?? 0,
      running: session.running ?? false,
      processName: session.processName ?? null,
    };
  };

  const live = (terminalId: string): TerminalHostTerminal => {
    const session = engine
      .list()
      .find((candidate) => candidate.id === terminalId);
    if (!session)
      throw new TerminalHostFailure(
        'notFound',
        `Terminal not found: ${terminalId}`,
      );
    return describe(session);
  };

  const remember = (launch: TerminalHostLaunch): void => {
    roots.set(scopeKey(launch.projectId, launch.worktreeId), launch.root);
  };

  const handle = async (request: TerminalHostRequest): Promise<unknown> => {
    switch (request.op) {
      case 'create': {
        const { launch } = request;
        remember(launch);
        const session = engine.create({
          projectId: launch.projectId,
          worktreeId: launch.worktreeId,
          cols: request.cols,
          rows: request.rows,
          cwd: launch.cwd,
          environment: launch.environment,
          shell: launch.shell,
          ...(launch.initialCommand !== undefined && {
            initialCommand: launch.initialCommand,
          }),
        });
        if (launch.persist === true) persisted.add(session.id);
        sizes.set(session.id, { cols: request.cols, rows: request.rows });
        offsets.set(session.id, 0);
        return live(session.id);
      }
      case 'restore': {
        const { terminalId, cols, rows, recreate } = request;
        const existing = engine.get(terminalId);
        if (existing) {
          engine.restore({ terminalId, cols, rows });
          sizes.set(terminalId, { cols, rows });
          return { terminal: live(terminalId), recreated: false };
        }
        if (!recreate)
          throw new TerminalHostFailure(
            'notFound',
            `Terminal not found: ${terminalId}`,
          );
        remember(recreate);
        seeded.set(terminalId, {
          session: {
            id: terminalId,
            projectId: recreate.projectId,
            worktreeId: recreate.worktreeId,
            shell: recreate.shell.shell,
            shellBasename: recreate.shell.shellBasename,
            cwd: recreate.cwd,
            createdAt: Date.now(),
            ...(recreate.initialCommand !== undefined && {
              initialCommand: recreate.initialCommand,
            }),
          },
          scrollbackLines: recreate.scrollback.split('\n'),
          exitCode: null,
          signal: null,
        });
        // Before the restore, so its marker is reported with the output.
        if (recreate.persist === true) persisted.add(terminalId);
        try {
          engine.restore({
            terminalId,
            cols,
            rows,
            environment: recreate.environment,
            shell: recreate.shell,
          });
        } catch (error) {
          persisted.delete(terminalId);
          pendingOutput.delete(terminalId);
          appendedOffsets.delete(terminalId);
          throw error;
        } finally {
          seeded.delete(terminalId);
        }
        sizes.set(terminalId, { cols, rows });
        offsets.set(terminalId, engine.replay(terminalId).seq);
        return { terminal: live(terminalId), recreated: true };
      }
      case 'write':
        live(request.terminalId);
        engine.write(request.terminalId, request.data);
        return live(request.terminalId);
      case 'resize':
        live(request.terminalId);
        engine.resize(request.terminalId, request.cols, request.rows);
        sizes.set(request.terminalId, {
          cols: request.cols,
          rows: request.rows,
        });
        return live(request.terminalId);
      case 'kill': {
        const terminal = live(request.terminalId);
        engine.kill(request.terminalId, {
          ...(request.signal !== undefined && { signal: request.signal }),
        });
        return terminal;
      }
      case 'release': {
        const released = engine.get(request.terminalId) !== null;
        await engine.release(request.terminalId, {
          ...(request.signal !== undefined && { signal: request.signal }),
        });
        return released;
      }
      case 'list':
        return engine.list().map(describe);
      case 'attach': {
        const { attachmentId } = request;
        const lifetimeId = lifetimes.get(request.terminalId);
        let ended = false;
        const attachment = engine.attach({
          terminalId: request.terminalId,
          fromOffset: request.fromOffset,
          ...(request.maxReplayBytes !== undefined && {
            maxReplayBytes: request.maxReplayBytes,
          }),
          sink: {
            item: (item) => {
              post({
                kind: 'item',
                attachmentId,
                item: {
                  terminalId: item.terminalId,
                  lifetimeId,
                  fromOffset: item.fromOffset,
                  toOffset: item.toOffset,
                  data: item.data,
                  truncatedBefore: item.truncatedBefore,
                  exit: item.exit && {
                    exitCode: item.exit.exitCode,
                    signal: item.exit.signal,
                  },
                },
              });
            },
            end: (end) => {
              ended = true;
              attachments.delete(attachmentId);
              post({
                kind: 'end',
                attachmentId,
                outcome: end.outcome,
                offset: end.offset,
              });
            },
          },
        });
        if (!ended) attachments.set(attachmentId, attachment.attachmentId);
        return live(request.terminalId);
      }
      case 'acknowledge': {
        const engineId = attachments.get(request.attachmentId);
        if (engineId !== undefined)
          engine.acknowledgeAttachment(engineId, request.offset);
        return null;
      }
      case 'detach': {
        const engineId = attachments.get(request.attachmentId);
        if (engineId !== undefined) engine.releaseAttachment(engineId);
        return null;
      }
      case 'stop': {
        engine.killAll();
        const deadline =
          Date.now() + (options.stopTimeoutMs ?? STOP_TIMEOUT_MS);
        while (engine.getLiveTerminalCount() > 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        for (const terminalId of Array.from(pendingOutput.keys()))
          flushOutput(terminalId);
        return engine.getLiveTerminalCount();
      }
    }
  };

  channel.on('message', ({ data }) => {
    if (!isTerminalHostRequestMessage(data)) return;
    const { id, request } = data;
    const respond = async (): Promise<void> => {
      let response: TerminalHostMessage;
      try {
        response = {
          kind: 'response',
          id,
          ok: true,
          value: await handle(request),
        };
      } catch (error: unknown) {
        response = { kind: 'response', id, ok: false, error: hostError(error) };
      }
      // No terminal reply may overtake its retained final reports. Live
      // replies and unrelated terminals need no barrier under congestion.
      const ordered =
        request.op === 'stop' ||
        ('terminalId' in request && heldExits.has(request.terminalId));
      post(response, ordered);
    };
    void Promise.resolve().then(respond);
  });
  post({ kind: 'ready' });
  return { engine };
}
