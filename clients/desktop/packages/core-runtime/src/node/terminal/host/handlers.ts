import { KeyedOutcomes } from '../keyed-outcomes';
import { basename, join } from 'node:path';
import type {
  CanopyErrorPayload,
  CanopyWorkspaceScope,
  WorkerTerminal,
  WorkerTerminalAttachItem,
  WorkerTerminalAttachParams,
  WorkerTerminalCreateParams,
  WorkerTerminalCreateResult,
  WorkerTerminalGetParams,
  WorkerTerminalKillParams,
  WorkerTerminalListParams,
  WorkerTerminalListResult,
  WorkerTerminalReleaseParams,
  WorkerTerminalReleaseResult,
  WorkerTerminalResizeParams,
  WorkerTerminalRestoreParams,
  WorkerTerminalRestoreResult,
  WorkerTerminalWriteParams,
  WorkerTerminalWriteResult,
} from '@canopy/protocol/canopy-core';
import { isSafePortableRelativePath } from '@canopy/protocol/safe-relative-path';
import {
  CanopyOperationError,
  type SpawnFailureDetails,
} from '../../../runtime/errors';
import type {
  CanopyHandlerContext,
  CanopyStreamSink,
} from '../../../runtime/types';
import type { TerminalEnvironment } from '../ports';
import type { TerminalHostItem, TerminalHostTerminal } from './protocol';
import {
  TerminalHostRequestError,
  type TerminalHostSupervisor,
} from './supervisor';

export interface WorkerTerminalHandlerOptions {
  readonly supervisor: TerminalHostSupervisor;
  /**
   * The host directory of one root of a scope this worker serves. Throws a
   * typed error for a scope or root it does not serve.
   */
  readonly resolveRoot: (
    scope: CanopyWorkspaceScope,
    rootId: string,
  ) => Promise<string>;
  /** The shortest interval between an attachment's deliveries of output. */
  readonly flushIntervalMs?: number;
}

type Handler<P, R> = (params: P, context: CanopyHandlerContext) => Promise<R>;

export interface WorkerTerminalHandlers {
  queries: {
    'worker.terminal.get': Handler<WorkerTerminalGetParams, WorkerTerminal>;
    'worker.terminal.list': Handler<
      WorkerTerminalListParams,
      WorkerTerminalListResult
    >;
  };
  instructions: {
    'worker.terminal.create': Handler<
      WorkerTerminalCreateParams,
      WorkerTerminalCreateResult
    >;
    'worker.terminal.restore': Handler<
      WorkerTerminalRestoreParams,
      WorkerTerminalRestoreResult
    >;
    'worker.terminal.write': Handler<
      WorkerTerminalWriteParams,
      WorkerTerminalWriteResult
    >;
    'worker.terminal.resize': Handler<
      WorkerTerminalResizeParams,
      WorkerTerminal
    >;
    'worker.terminal.kill': Handler<WorkerTerminalKillParams, WorkerTerminal>;
    'worker.terminal.release': Handler<
      WorkerTerminalReleaseParams,
      WorkerTerminalReleaseResult
    >;
  };
  streams: {
    'worker.terminal.attach': (
      params: WorkerTerminalAttachParams,
      context: CanopyHandlerContext,
      sink: CanopyStreamSink<WorkerTerminalAttachItem>,
    ) => Promise<() => void>;
  };
}

/** What the worker knows of a live terminal beyond its host's record. */
interface Descriptor {
  kind: 'interactive' | 'managed';
  scope: CanopyWorkspaceScope;
  cwdRootId: string;
  cwdRelativePath: string;
  profileId: WorkerTerminalCreateParams['profileId'] | null;
  initialCommand: string | null;
}

/**
 * Attachment pacing. Every hop of a stream holds at most 1,024 frames, and
 * the client's own consumption is not visible here, so output reaches the
 * stream at most once per interval, in items of at most 64 KiB, and only
 * while this hop holds fewer than {@link STREAM_HIGH_WATER_ITEMS}. Output a
 * slow client could not take is dropped oldest first beyond
 * {@link PENDING_MAX_BYTES}, and the next item says so (`truncatedBefore`).
 */
const FLUSH_INTERVAL_MS = 16;
const ITEM_MAX_BYTES = 64 * 1024;
const PENDING_MAX_BYTES = 1024 * 1024;
const STREAM_HIGH_WATER_ITEMS = 32;
const MAX_RECENT_EXITS = 256;

function terminalError(
  kind: CanopyErrorPayload['kind'],
  message: string,
  code?: 'worker.terminal.notFound' | 'worker.terminal.invalidState',
  details?: SpawnFailureDetails,
): CanopyOperationError {
  return new CanopyOperationError({
    kind,
    ...(code && { code }),
    message,
    ...(details && { details: { ...details } }),
    retry: { kind: 'never' },
  });
}

function notFound(): CanopyOperationError {
  return terminalError(
    'not_found',
    'The terminal is not live on this worker.',
    'worker.terminal.notFound',
  );
}

/** Host failures as the operation's typed errors; host details stay here. */
function translate(error: unknown): unknown {
  if (!(error instanceof TerminalHostRequestError)) return error;
  switch (error.error.code) {
    case 'notFound':
      return notFound();
    case 'invalidState':
      return terminalError(
        'failed_precondition',
        'The terminal cannot do that in its current state.',
        'worker.terminal.invalidState',
      );
    case 'capacity':
      return terminalError(
        'resource_exhausted',
        'This worker has no room for another terminal or attachment.',
      );
    case 'unavailable':
      return terminalError(
        'unavailable',
        'The terminal host is unavailable.',
        undefined,
        error.startFailure,
      );
    case 'failed':
      return terminalError('internal', 'The terminal operation failed.');
  }
}

async function hosted<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translate(error);
  }
}

/** The scope's workspace and worktree, which every terminal belongs to. */
function worktreeOf(scope: CanopyWorkspaceScope | undefined): {
  workspaceId: string;
  worktreeId: string;
} {
  if (scope?.workspaceId === undefined || scope.worktreeId === undefined)
    throw terminalError(
      'invalid_argument',
      'A terminal scope names its workspace and worktree.',
    );
  return { workspaceId: scope.workspaceId, worktreeId: scope.worktreeId };
}

function directoryIn(root: string, relativePath: string): string {
  if (relativePath === '') return root;
  if (!isSafePortableRelativePath(relativePath))
    throw terminalError(
      'invalid_argument',
      'The terminal directory must be a relative path inside its root.',
    );
  return join(root, ...relativePath.split('/'));
}

function environmentOf(
  env: Readonly<Record<string, unknown>> | undefined,
): TerminalEnvironment {
  const environment: TerminalEnvironment = {};
  for (const [name, value] of Object.entries(env ?? {}))
    if (typeof value === 'string') environment[name] = value;
  return environment;
}

type RunningState = NonNullable<WorkerTerminalAttachItem['running']>;

/** One attachment's deliveries to its stream; see {@link FLUSH_INTERVAL_MS}. */
class AttachmentPacer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  /** Offset of the first pending byte. */
  private from: number;
  private truncated = false;
  private exit: WorkerTerminalAttachItem['exit'] = null;
  private ending: 'completed' | 'cancelled' | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastFlush = Number.NEGATIVE_INFINITY;
  private closed = false;

  public constructor(
    private readonly terminalId: string,
    private readonly sink: CanopyStreamSink<WorkerTerminalAttachItem>,
    private readonly intervalMs: number,
  ) {
    this.from = 0;
  }

  public push(item: TerminalHostItem): void {
    if (this.closed) return;
    if (item.data.length > 0) {
      if (this.bytes === 0) this.from = item.fromOffset;
      else if (item.fromOffset !== this.from + this.bytes) {
        // The host skipped ahead; deliver what came before the gap first.
        this.flush(true);
        this.from = item.fromOffset;
      }
      if (item.truncatedBefore && this.bytes === 0) this.truncated = true;
      this.chunks.push(Buffer.from(item.data));
      this.bytes += item.data.length;
      while (this.bytes > PENDING_MAX_BYTES) this.dropOldest();
    } else if (this.bytes === 0) this.from = item.toOffset;
    if (item.exit)
      this.exit = { code: item.exit.exitCode, signal: item.exit.signal };
    this.schedule();
  }

  public running(state: RunningState): void {
    if (this.closed) return;
    this.flush(true);
    this.emit({
      terminalId: this.terminalId,
      fromOffset: this.from,
      toOffset: this.from,
      data: '',
      encoding: 'base64',
      truncatedBefore: false,
      exit: null,
      running: state,
    });
  }

  public end(outcome: 'completed' | 'cancelled'): void {
    if (this.closed) return;
    this.ending = outcome;
    this.schedule();
  }

  public close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private dropOldest(): void {
    const excess = this.bytes - PENDING_MAX_BYTES;
    const first = this.chunks[0];
    if (!first) return;
    if (first.length <= excess) {
      this.chunks.shift();
      this.bytes -= first.length;
      this.from += first.length;
    } else {
      this.chunks[0] = first.subarray(excess);
      this.bytes -= excess;
      this.from += excess;
    }
    this.truncated = true;
  }

  private schedule(): void {
    if (this.closed || this.timer !== undefined) return;
    const wait = Math.max(0, this.lastFlush + this.intervalMs - Date.now());
    if (wait === 0 && this.backlog() < STREAM_HIGH_WATER_ITEMS) {
      this.flush(false);
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (this.backlog() >= STREAM_HIGH_WATER_ITEMS && this.ending === null) {
          this.schedule();
          return;
        }
        this.flush(false);
      },
      Math.max(wait, 1),
    );
  }

  private backlog(): number {
    return this.sink.buffered?.() ?? 0;
  }

  /** Delivers everything pending, then the exit and end once reached. */
  private flush(beforeMore: boolean): void {
    if (this.closed) return;
    this.lastFlush = Date.now();
    if (this.bytes > 0) {
      const pending = Buffer.concat(this.chunks);
      this.chunks = [];
      this.bytes = 0;
      for (let start = 0; start < pending.length; start += ITEM_MAX_BYTES) {
        const data = pending.subarray(start, start + ITEM_MAX_BYTES);
        const fromOffset = this.from;
        this.from += data.length;
        this.emit({
          terminalId: this.terminalId,
          fromOffset,
          toOffset: this.from,
          data: data.toString('base64'),
          encoding: 'base64',
          truncatedBefore: this.truncated,
          exit: null,
        });
        this.truncated = false;
      }
    }
    if (beforeMore) return;
    if (this.exit) {
      const exit = this.exit;
      this.exit = null;
      this.emit({
        terminalId: this.terminalId,
        fromOffset: this.from,
        toOffset: this.from,
        data: '',
        encoding: 'base64',
        truncatedBefore: false,
        exit,
      });
    }
    if (this.ending !== null) {
      const outcome = this.ending;
      this.close();
      this.sink.end(outcome);
    }
  }

  private emit(item: WorkerTerminalAttachItem): void {
    if (this.closed) return;
    if (this.sink.emit(item) === null) this.close();
  }
}

/**
 * `worker.terminal.*` over a supervised terminal host (CAN-5088). The worker
 * serves interactive terminals only, started in a directory it resolves from
 * the scope's root, with the shell and environment its client selected. It
 * keeps no terminal state: a live terminal is the host's, and its client
 * persists sessions and output, supplying the record to recreate one.
 */
export function createWorkerTerminalHandlers(
  options: WorkerTerminalHandlerOptions,
): WorkerTerminalHandlers {
  const { supervisor } = options;
  const descriptors = new Map<string, Descriptor>();
  const reusedKey = (): CanopyOperationError =>
    terminalError(
      'conflict',
      'This idempotency key was used with other parameters.',
    );
  const creates = new KeyedOutcomes<WorkerTerminalCreateResult>(reusedKey);
  const restores = new KeyedOutcomes<WorkerTerminalRestoreResult>(reusedKey);
  const offsets = new Map<string, number>();
  const recentExits = new Map<
    string,
    { exitCode: number | null; signal: string | null; outputOffset: number }
  >();
  let revision = 0;
  supervisor.onEvent((event) => {
    if (event.type !== 'exit') return;
    if (!descriptors.delete(event.terminalId)) return;
    revision += 1;
    recentExits.set(event.terminalId, {
      exitCode: event.exitCode,
      signal: event.signal,
      // Output written while no client was attached counts too.
      outputOffset: Math.max(
        event.outputOffset ?? 0,
        offsets.get(event.terminalId) ?? 0,
      ),
    });
    offsets.delete(event.terminalId);
    while (recentExits.size > MAX_RECENT_EXITS) {
      const oldest = recentExits.keys().next().value;
      if (oldest === undefined) break;
      recentExits.delete(oldest);
    }
  });

  /**
   * A terminal as get, list, kill and resize describe it. `known` is its
   * descriptor as of the call: an exit that arrives with the host's reply
   * removes the descriptor first, and the terminal then reads as ended.
   */
  const wire = (
    terminal: TerminalHostTerminal,
    known?: Descriptor,
  ): WorkerTerminal => {
    const descriptor = descriptors.get(terminal.session.id) ?? known;
    if (!descriptor) throw notFound();
    const exit = descriptors.has(terminal.session.id)
      ? undefined
      : recentExits.get(terminal.session.id);
    return {
      terminalId: terminal.session.id,
      scope: descriptor.scope,
      state: exit ? 'exited' : 'running',
      cwdRootId: descriptor.cwdRootId,
      cwdRelativePath: descriptor.cwdRelativePath,
      cols: terminal.cols,
      rows: terminal.rows,
      exitCode: exit?.exitCode ?? null,
      signal: exit?.signal ?? null,
      outputOffset: terminal.outputOffset,
      running: exit ? false : terminal.running,
      processName: terminal.processName,
      pid: terminal.pid,
      createdAt: terminal.session.createdAt,
      shellBasename: terminal.session.shellBasename,
      kind: descriptor.kind,
    };
  };

  const find = async (terminalId: string): Promise<TerminalHostTerminal> => {
    if (!descriptors.has(terminalId)) throw notFound();
    const terminal = (await hosted(() => supervisor.list())).find(
      (candidate) => candidate.session.id === terminalId,
    );
    if (!terminal) throw notFound();
    return terminal;
  };

  return {
    queries: {
      'worker.terminal.get': async (params) =>
        wire(await find(params.terminalId)),
      'worker.terminal.list': async (params) => {
        const terminals = await hosted(() => supervisor.list());
        const matching = terminals
          .filter((terminal) => {
            const descriptor = descriptors.get(terminal.session.id);
            if (!descriptor) return false;
            const { workspaceId, worktreeId } = params.scope ?? {};
            return (
              (workspaceId === undefined ||
                descriptor.scope.workspaceId === workspaceId) &&
              (worktreeId === undefined ||
                descriptor.scope.worktreeId === worktreeId) &&
              (params.states === undefined || params.states.includes('running'))
            );
          })
          .map((terminal) => wire(terminal));
        const start = params.cursor === undefined ? 0 : Number(params.cursor);
        if (!Number.isSafeInteger(start) || start < 0)
          throw terminalError(
            'invalid_argument',
            'The list cursor is invalid.',
          );
        const end = start + params.pageSize;
        return {
          items: matching.slice(start, end),
          nextCursor: end < matching.length ? String(end) : null,
          revision,
        };
      },
    },
    instructions: {
      'worker.terminal.create': (params, context) =>
        creates.run(context, params, async () => {
          const { workspaceId, worktreeId } = worktreeOf(params.scope);
          if (params.kind !== 'interactive' && params.kind !== 'managed')
            throw terminalError(
              'capability_unavailable',
              'This worker opens interactive terminals only.',
            );
          if (
            params.kind === 'managed' &&
            ((params.profileId !== undefined && params.profileId !== null) ||
              (params.initialCommand !== undefined &&
                params.initialCommand !== null))
          )
            throw terminalError(
              'invalid_argument',
              'A managed command takes no profile or initial command.',
            );
          if (!params.shell)
            throw terminalError(
              'capability_unavailable',
              'This worker starts the shell its client selected.',
            );
          const root = await options.resolveRoot(
            params.scope,
            params.cwdRootId,
          );
          const cwd = directoryIn(root, params.cwdRelativePath);
          const terminal = await hosted(() =>
            supervisor.create(
              {
                projectId: workspaceId,
                worktreeId,
                root,
                cwd,
                environment: environmentOf(params.env),
                shell: {
                  shell: params.shell ?? '',
                  args: params.args ?? [],
                  shellBasename: basename(params.shell ?? ''),
                },
                ...(params.initialCommand && {
                  initialCommand: params.initialCommand,
                }),
              },
              params.cols,
              params.rows,
            ),
          );
          descriptors.set(terminal.session.id, {
            kind: params.kind,
            scope: params.scope,
            cwdRootId: params.cwdRootId,
            cwdRelativePath: params.cwdRelativePath,
            profileId: params.profileId ?? null,
            initialCommand: params.initialCommand ?? null,
          });
          revision += 1;
          return {
            ...wire(terminal),
            profileId: params.profileId ?? null,
            initialCommand: params.initialCommand ?? null,
          };
        }),
      'worker.terminal.restore': (params, context) =>
        restores.run(context, params, async () => {
          const { terminalId, cols, rows, snapshot } = params;
          if (supervisor.isLive(terminalId)) {
            const { terminal } = await hosted(() =>
              supervisor.restore({ op: 'restore', terminalId, cols, rows }),
            );
            return {
              terminalId,
              state: 'running',
              restored: true,
              recreated: false,
              outputOffset: terminal.outputOffset,
              pid: terminal.pid,
              createdAt: terminal.session.createdAt,
            };
          }
          if (params.restoreMode !== 'recreate_if_exited' || !snapshot)
            throw notFound();
          const { workspaceId, worktreeId } = worktreeOf(params.scope);
          const scope = params.scope ?? { workspaceId, worktreeId };
          const root = await options.resolveRoot(scope, snapshot.cwdRootId);
          // A directory that left the root restarts in the root, as in process.
          const cwd = isSafePortableRelativePath(snapshot.cwdRelativePath)
            ? directoryIn(root, snapshot.cwdRelativePath)
            : root;
          const { terminal, recreated } = await hosted(() =>
            supervisor.restore({
              op: 'restore',
              terminalId,
              cols,
              rows,
              recreate: {
                projectId: workspaceId,
                worktreeId,
                root,
                cwd,
                environment: environmentOf(snapshot.env),
                shell: {
                  shell: snapshot.shell,
                  args: snapshot.args,
                  shellBasename: basename(snapshot.shell),
                },
                ...(snapshot.initialCommand && {
                  initialCommand: snapshot.initialCommand,
                }),
                scrollback: snapshot.scrollback,
              },
            }),
          );
          // A concurrent restore may have recreated it first: this one then
          // adopts the live terminal, and its snapshot changes nothing.
          if (recreated || !descriptors.has(terminalId)) {
            descriptors.set(terminalId, {
              kind: 'interactive',
              scope,
              cwdRootId: snapshot.cwdRootId,
              cwdRelativePath: snapshot.cwdRelativePath,
              profileId: null,
              initialCommand: snapshot.initialCommand ?? null,
            });
            revision += 1;
          }
          return {
            terminalId,
            state: 'running',
            restored: true,
            recreated,
            outputOffset: terminal.outputOffset,
            pid: terminal.pid,
            createdAt: terminal.session.createdAt,
          };
        }),
      'worker.terminal.write': async (params) => {
        if (!descriptors.has(params.terminalId)) throw notFound();
        const data =
          params.encoding === 'base64'
            ? Buffer.from(params.input, 'base64').toString('utf8')
            : params.input;
        const terminal = await hosted(() =>
          supervisor.write(params.terminalId, data),
        );
        return {
          acceptedBytes: Buffer.byteLength(data, 'utf8'),
          outputOffset: terminal.outputOffset,
        };
      },
      'worker.terminal.resize': async (params) => {
        const known = descriptors.get(params.terminalId);
        if (!known) throw notFound();
        return wire(
          await hosted(() =>
            supervisor.resize(params.terminalId, params.cols, params.rows),
          ),
          known,
        );
      },
      'worker.terminal.kill': async (params) => {
        const known = descriptors.get(params.terminalId);
        if (!known) throw notFound();
        // The host force-kills the process tree, as the in-process engine
        // does; another signal or a grace period is refused, not dropped.
        if (params.signal !== undefined && params.signal !== 'SIGKILL')
          throw terminalError(
            'capability_unavailable',
            'This worker kills a terminal with SIGKILL only.',
          );
        if (params.graceMs !== undefined && params.graceMs > 0)
          throw terminalError(
            'capability_unavailable',
            'This worker kills a terminal without a grace period.',
          );
        return wire(
          await hosted(() => supervisor.kill(params.terminalId)),
          known,
        );
      },
      'worker.terminal.release': async (params) => ({
        released: await hosted(() => supervisor.release(params.terminalId)),
      }),
    },
    streams: {
      'worker.terminal.attach': async (params, _context, sink) => {
        const recent = recentExits.get(params.terminalId);
        if (!descriptors.has(params.terminalId) && recent) {
          // Exited while this client was away: report the exit, flagging
          // the output it can no longer read.
          sink.emit({
            terminalId: params.terminalId,
            fromOffset: params.fromOffset,
            toOffset: params.fromOffset,
            data: '',
            encoding: 'base64',
            truncatedBefore: recent.outputOffset > params.fromOffset,
            exit: { code: recent.exitCode, signal: recent.signal },
          });
          sink.end('completed');
          return () => undefined;
        }
        if (!descriptors.has(params.terminalId)) throw notFound();
        const pacer = new AttachmentPacer(
          params.terminalId,
          sink,
          options.flushIntervalMs ?? FLUSH_INTERVAL_MS,
        );
        let attachmentId: string | undefined;
        const unsubscribe = supervisor.onEvent((event) => {
          if (
            event.type !== 'runningChanged' ||
            event.terminalId !== params.terminalId
          )
            return;
          pacer.running({
            running: event.running,
            processName: event.processName,
            ...(event.interruptedByUser !== undefined && {
              interruptedByUser: event.interruptedByUser,
            }),
          });
        });
        const close = (): void => {
          unsubscribe();
          pacer.close();
        };
        try {
          const opened = await supervisor.attach(
            {
              terminalId: params.terminalId,
              fromOffset: params.fromOffset,
              ...(params.maxReplayBytes !== undefined && {
                maxReplayBytes: params.maxReplayBytes,
              }),
            },
            {
              item: (item, id) => {
                attachmentId = id;
                offsets.set(
                  params.terminalId,
                  Math.max(offsets.get(params.terminalId) ?? 0, item.toOffset),
                );
                // The host is never held back: pacing and truncation for
                // a slow client happen here, where the stream's bound is.
                supervisor.acknowledge(id, item.toOffset);
                pacer.push(item);
              },
              end: (outcome) => {
                unsubscribe();
                pacer.end(outcome);
              },
            },
          );
          attachmentId = opened.attachmentId;
          // The foreground process as of this attachment, ahead of any
          // later change, so a client that was away does not keep a stale one.
          pacer.running({
            running: opened.terminal.running,
            processName: opened.terminal.processName,
          });
        } catch (error) {
          close();
          throw translate(error);
        }
        return () => {
          close();
          if (attachmentId !== undefined) supervisor.detach(attachmentId);
        };
      },
    },
  };
}
