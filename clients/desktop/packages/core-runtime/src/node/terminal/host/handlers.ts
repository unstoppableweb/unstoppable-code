import { KeyedOutcomes } from '../keyed-outcomes';
import { basename, join } from 'node:path';
import {
  WORKER_TERMINAL_RECORD_SCHEMA_REVISION,
  type WorkerTerminalRecordAttribution,
  type WorkerTerminalRecordClient,
} from '@canopy/protocol/canopy-core';
import {
  TERMINAL_USER_CLOSE_SIGNAL,
  TERMINAL_WORKTREE_CLEANUP_SIGNAL,
  type TerminalSession,
} from '@canopy/protocol/terminal';
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
  canopyCancelledError,
  CanopyOperationError,
  type SpawnFailureDetails,
} from '../../../runtime/errors';
import type {
  CanopyHandlerContext,
  CanopyStreamSink,
} from '../../../runtime/types';
import type { TerminalEnvironment } from '../ports';
import { isDrawerOwnedTerminal } from '../record/codec';
import type {
  TerminalRecordAttribution,
  TerminalRecordRegistration,
} from '../record/authority';
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
  /**
   * The worktree terminal record (CAN-7051): attributes revision 2 creates
   * and restores, and supplies a restore's history and close veto. Absent,
   * revision 2 attribution is ignored and explicit record history restores
   * empty.
   */
  readonly record?: WorkerTerminalRecordPort;
  /** Pure record-path validation, shared with the daemon's record operations. */
  readonly validateRecordTarget?: (client: WorkerTerminalRecordClient) => void;
  /** An attributed lifetime's source offset before any newly appended bytes. */
  readonly onOutputStart?: (
    terminal: TerminalHostTerminal,
    fromOffset: number,
    registration: TerminalRecordRegistration,
  ) => void;
  readonly log?: (message: string, details: Record<string, unknown>) => void;
}

/** What the handlers need of the record authority. */
export interface WorkerTerminalRecordPort {
  attribute(
    attribution: TerminalRecordAttribution,
  ): TerminalRecordRegistration | undefined;
  restoreHistoryTail(
    client: WorkerTerminalRecordClient,
    terminalId: string,
    maxChars: number,
  ): { scrollback: string; signal: string | null } | null;
}

/** The newest output a recreated terminal replays: its restore window. */
const RESTORE_HISTORY_MAX_CHARS = 1024 * 1024;

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
  /**
   * The host PTY lifetime it describes. Progress of an earlier lifetime of
   * the same id, such as an attachment still draining it, never applies.
   */
  readonly lifetimeId: number | undefined;
  /** The furthest output offset reported for its lifetime (CAN-7051). */
  outputOffset: number;
  /** When it first wrote live output (CAN-7051); never set by a replay. */
  firstOutputAt?: number;
}

interface RecentExit {
  readonly descriptor: Descriptor;
  readonly lifetimeId: number | undefined;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outputOffset: number;
  /** The host's own PTY exit carried its final output offset. */
  readonly confirmed: boolean;
}

/**
 * A terminal's output offset: its host reply's, or further progress reported
 * for the same lifetime since that reply was taken.
 */
function outputOffsetOf(
  terminal: TerminalHostTerminal,
  descriptor: Descriptor | undefined,
  exit: RecentExit | undefined,
): number {
  return Math.max(
    terminal.outputOffset,
    descriptor !== undefined && descriptor.lifetimeId === terminal.lifetimeId
      ? descriptor.outputOffset
      : 0,
    exit !== undefined && exit.lifetimeId === terminal.lifetimeId
      ? exit.outputOffset
      : 0,
  );
}

/** The client session a revision 2 call attributes, under the client's ids. */
function attributedSession(
  terminalId: string,
  client: WorkerTerminalRecordClient,
  session: WorkerTerminalRecordAttribution,
): TerminalSession {
  return {
    ...session,
    id: terminalId,
    projectId: client.projectId,
    worktreeId: client.worktreeId,
  };
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

/** A revision 2 kill or release's exit reason (CAN-7051). */
function exitSignalOf(params: {
  readonly revision?: number;
  readonly exitSignal?: string;
}): string | undefined {
  return params.revision === WORKER_TERMINAL_RECORD_SCHEMA_REVISION
    ? params.exitSignal
    : undefined;
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
  /** The exit follows output this attachment never received. */
  private exitTruncated = false;
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
    if (item.exit) {
      this.exit = { code: item.exit.exitCode, signal: item.exit.signal };
      if (item.truncatedBefore && item.data.length === 0)
        this.exitTruncated = true;
    }
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
      const truncatedBefore = this.exitTruncated;
      this.exit = null;
      this.exitTruncated = false;
      this.emit({
        terminalId: this.terminalId,
        fromOffset: this.from,
        toOffset: this.from,
        data: '',
        encoding: 'base64',
        truncatedBefore,
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
  const pendingRestores = new Map<
    string,
    Promise<WorkerTerminalRestoreResult>
  >();
  const serializeRestore = (
    terminalId: string,
    restore: () => Promise<WorkerTerminalRestoreResult>,
  ): Promise<WorkerTerminalRestoreResult> => {
    const previous = pendingRestores.get(terminalId);
    // Read history only after the previous restore has applied its reports.
    const outcome = previous ? previous.then(restore, restore) : restore();
    pendingRestores.set(terminalId, outcome);
    const finished = (): void => {
      if (pendingRestores.get(terminalId) === outcome)
        pendingRestores.delete(terminalId);
    };
    void outcome.then(finished, finished);
    return outcome;
  };
  const firstOutputs = new Map<
    string,
    { lifetimeId: number | undefined; at: number }
  >();
  /** The live descriptor of exactly this lifetime of `terminalId`. */
  const descriptorOf = (
    terminalId: string,
    lifetimeId: number | undefined,
  ): Descriptor | undefined => {
    const descriptor = descriptors.get(terminalId);
    return descriptor?.lifetimeId === lifetimeId ? descriptor : undefined;
  };
  const noteOffset = (
    terminalId: string,
    lifetimeId: number | undefined,
    offset: number,
  ): void => {
    const descriptor = descriptorOf(terminalId, lifetimeId);
    if (descriptor)
      descriptor.outputOffset = Math.max(descriptor.outputOffset, offset);
  };
  // Output progress reaches the handlers outside any attachment (CAN-7051).
  supervisor.onReport((report) => {
    if (report.type === 'offset')
      noteOffset(report.terminalId, report.lifetimeId, report.outputOffset);
    else if (report.type === 'output')
      noteOffset(report.terminalId, report.lifetimeId, report.toOffset);
    else {
      const descriptor = descriptorOf(report.terminalId, report.lifetimeId);
      if (descriptor && descriptor.firstOutputAt === undefined)
        descriptor.firstOutputAt = report.at;
      firstOutputs.set(report.terminalId, {
        lifetimeId: report.lifetimeId,
        at: report.at,
      });
    }
  });
  const attribute = (
    attribution: TerminalRecordAttribution,
  ): TerminalRecordRegistration | undefined => {
    try {
      return options.record?.attribute(attribution);
    } catch (error) {
      // The terminal runs either way; its record catches up on next use.
      options.log?.('Could not attribute a terminal to its record', {
        name: error instanceof Error ? error.name : 'error',
      });
      return undefined;
    }
  };
  const recordAttribution = (params: {
    revision?: number;
    client?: WorkerTerminalRecordClient;
    session?: WorkerTerminalRecordAttribution;
  }): {
    client: WorkerTerminalRecordClient;
    session: WorkerTerminalRecordAttribution;
  } | null => {
    if (
      params.revision !== WORKER_TERMINAL_RECORD_SCHEMA_REVISION ||
      !options.record ||
      !params.client ||
      !params.session
    )
      return null;
    try {
      options.validateRecordTarget?.(params.client);
      return { client: params.client, session: params.session };
    } catch (error) {
      // An impossible record target must not block a shell or accrue retry debt.
      options.log?.('Starting a terminal without record attribution', {
        name: error instanceof Error ? error.name : 'error',
      });
      return null;
    }
  };
  // An unreadable record never blocks a restore: no history, no close veto.
  const recordRestoreHistory = (
    client: WorkerTerminalRecordClient,
    terminalId: string,
  ): { scrollback: string; signal: string | null } | null => {
    try {
      return (
        options.record?.restoreHistoryTail(
          client,
          terminalId,
          RESTORE_HISTORY_MAX_CHARS,
        ) ?? null
      );
    } catch (error) {
      options.log?.('Restoring a terminal without reading its record', {
        name: error instanceof Error ? error.name : 'error',
      });
      return null;
    }
  };
  const recentExits = new Map<string, RecentExit>();
  let revision = 0;
  supervisor.onEvent((event) => {
    if (event.type !== 'exit') return;
    if (firstOutputs.get(event.terminalId)?.lifetimeId === event.lifetimeId)
      firstOutputs.delete(event.terminalId);
    const descriptor = descriptors.get(event.terminalId);
    if (!descriptor) return;
    descriptors.delete(event.terminalId);
    revision += 1;
    recentExits.set(event.terminalId, {
      descriptor,
      lifetimeId: event.lifetimeId,
      exitCode: event.exitCode,
      signal: event.signal,
      // Output written while no client was attached counts too.
      outputOffset: Math.max(
        event.outputOffset ?? 0,
        descriptor.lifetimeId === event.lifetimeId
          ? descriptor.outputOffset
          : 0,
      ),
      confirmed: event.outputOffset !== undefined,
    });
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
      outputOffset: outputOffsetOf(terminal, descriptor, exit),
      running: exit ? false : terminal.running,
      processName: terminal.processName,
      pid: terminal.pid,
      createdAt: terminal.session.createdAt,
      shellBasename: terminal.session.shellBasename,
      kind: descriptor.kind,
      ...(descriptor.firstOutputAt !== undefined && {
        firstOutputAt: descriptor.firstOutputAt,
      }),
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
          const kind = params.kind;
          if (kind !== 'interactive' && kind !== 'managed')
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
          const recorded = recordAttribution(params);
          const persist =
            recorded !== null && isDrawerOwnedTerminal(recorded.session);
          let known: Descriptor | undefined;
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
                persist,
              },
              params.cols,
              params.rows,
              (created) => {
                const firstOutput = firstOutputs.get(created.session.id);
                known = {
                  kind,
                  scope: params.scope,
                  cwdRootId: params.cwdRootId,
                  cwdRelativePath: params.cwdRelativePath,
                  profileId: params.profileId ?? null,
                  initialCommand: params.initialCommand ?? null,
                  lifetimeId: created.lifetimeId,
                  outputOffset: 0,
                  ...(firstOutput !== undefined &&
                    firstOutput.lifetimeId === created.lifetimeId && {
                      firstOutputAt: firstOutput.at,
                    }),
                };
                descriptors.set(created.session.id, known);
                const registration = recorded
                  ? attribute({
                      terminalId: created.session.id,
                      client: recorded.client,
                      session: attributedSession(
                        created.session.id,
                        recorded.client,
                        recorded.session,
                      ),
                      persist,
                    })
                  : undefined;
                if (registration !== undefined)
                  options.onOutputStart?.(created, 0, registration);
                revision += 1;
                return registration;
              },
            ),
          );
          return {
            ...wire(terminal, known),
            profileId: params.profileId ?? null,
            initialCommand: params.initialCommand ?? null,
          };
        }),
      'worker.terminal.restore': (params, context) =>
        restores.run(context, params, () => {
          const revision2 =
            params.revision === WORKER_TERMINAL_RECORD_SCHEMA_REVISION;
          const recordHistory = revision2 && params.historyFrom === 'record';
          if (recordHistory && !params.client)
            return Promise.reject(
              terminalError(
                'invalid_argument',
                'Record history requires a terminal record client.',
              ),
            );
          // Without recreation data, absent targets need no root-lookup barrier.
          if (
            (params.restoreMode !== 'recreate_if_exited' || !params.snapshot) &&
            !supervisor.isLive(params.terminalId)
          )
            return Promise.reject(notFound());
          // Only queued restores gain cancellation points; keep the fast path.
          const queued = pendingRestores.has(params.terminalId);
          return serializeRestore(params.terminalId, async () => {
            if (queued && context.signal.aborted) throw canopyCancelledError();
            const { terminalId, cols, rows, snapshot } = params;
            if (supervisor.isLive(terminalId)) {
              try {
                const { terminal } = await supervisor.restore({
                  op: 'restore',
                  terminalId,
                  cols,
                  rows,
                });
                return {
                  terminalId,
                  state: supervisor.isLive(terminalId) ? 'running' : 'exited',
                  restored: true,
                  recreated: false,
                  outputOffset: outputOffsetOf(
                    terminal,
                    descriptors.get(terminalId),
                    supervisor.isLive(terminalId)
                      ? undefined
                      : recentExits.get(terminalId),
                  ),
                  pid: terminal.pid,
                  createdAt: terminal.session.createdAt,
                };
              } catch (error) {
                if (
                  !(error instanceof TerminalHostRequestError) ||
                  error.error.code !== 'notFound' ||
                  params.restoreMode !== 'recreate_if_exited' ||
                  !snapshot
                )
                  throw translate(error);
                // The host queues notFound behind that lifetime's final reports.
              }
            }
            if (params.restoreMode !== 'recreate_if_exited' || !snapshot)
              throw notFound();
            const recorded = recordAttribution(params);
            const persist =
              recorded !== null && isDrawerOwnedTerminal(recorded.session);
            // Only recreation needs a worktree scope; live reattach does not.
            const { workspaceId, worktreeId } = worktreeOf(params.scope);
            const scope = params.scope ?? { workspaceId, worktreeId };
            const root = await options.resolveRoot(scope, snapshot.cwdRootId);
            if (queued && context.signal.aborted) throw canopyCancelledError();
            // A directory that left the root restarts in the root, as in process.
            const cwd = isSafePortableRelativePath(snapshot.cwdRelativePath)
              ? directoryIn(root, snapshot.cwdRelativePath)
              : root;
            // Read in either replay mode: the record also carries the close veto.
            const history =
              revision2 && params.client
                ? recordRestoreHistory(params.client, terminalId)
                : null;
            const scrollback = recordHistory
              ? (history?.scrollback ?? '')
              : snapshot.scrollback;
            // Only deliberate closes veto recreation; crashed shells stay restorable.
            if (
              history?.signal === TERMINAL_USER_CLOSE_SIGNAL ||
              history?.signal === TERMINAL_WORKTREE_CLEANUP_SIGNAL
            )
              throw terminalError(
                'failed_precondition',
                "Couldn't restore this terminal because it was closed. Open a new terminal.",
                'worker.terminal.invalidState',
              );
            // Keep the shell if retirement races dispatch; revisit at slice 3's attribution/retire cutover.
            const { terminal, recreated } = await hosted(() =>
              supervisor.restore(
                {
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
                    scrollback,
                    persist,
                  },
                },
                (restoredTerminal, wasRecreated) => {
                  // Another restore may already have registered and exited it.
                  if (!wasRecreated && !supervisor.isLive(terminalId)) return;
                  // A concurrent restore may have recreated it first: this one
                  // adopts the live terminal without changing its snapshot.
                  if (wasRecreated || !descriptors.has(terminalId)) {
                    descriptors.set(terminalId, {
                      kind: 'interactive',
                      scope,
                      cwdRootId: snapshot.cwdRootId,
                      cwdRelativePath: snapshot.cwdRelativePath,
                      profileId: null,
                      initialCommand: snapshot.initialCommand ?? null,
                      lifetimeId: restoredTerminal.lifetimeId,
                      outputOffset: 0,
                    });
                    const registration =
                      recorded && wasRecreated
                        ? attribute({
                            terminalId,
                            client: recorded.client,
                            session: attributedSession(
                              terminalId,
                              recorded.client,
                              recorded.session,
                            ),
                            persist,
                          })
                        : undefined;
                    if (registration !== undefined)
                      options.onOutputStart?.(
                        restoredTerminal,
                        Buffer.byteLength(scrollback, 'utf8'),
                        registration,
                      );
                    revision += 1;
                    return registration;
                  }
                },
              ),
            );
            return {
              terminalId,
              state: supervisor.isLive(terminalId) ? 'running' : 'exited',
              restored: true,
              recreated,
              // Only legacy recreations seed locally; live restores replay from zero.
              outputOffset:
                recreated &&
                params.revision !== WORKER_TERMINAL_RECORD_SCHEMA_REVISION
                  ? terminal.outputOffset
                  : outputOffsetOf(
                      terminal,
                      descriptors.get(terminalId),
                      supervisor.isLive(terminalId)
                        ? undefined
                        : recentExits.get(terminalId),
                    ),
              pid: terminal.pid,
              createdAt: terminal.session.createdAt,
            };
          });
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
          await hosted(() =>
            supervisor.kill(params.terminalId, exitSignalOf(params)),
          ),
          known,
        );
      },
      'worker.terminal.release': async (params) => ({
        released: await hosted(() =>
          supervisor.release(params.terminalId, exitSignalOf(params)),
        ),
      }),
    },
    streams: {
      'worker.terminal.attach': async (params, _context, sink) => {
        const descriptor = descriptors.get(params.terminalId);
        const recent = recentExits.get(params.terminalId);
        const complete = (exited: NonNullable<typeof recent>): (() => void) => {
          // Exited while this client was away: report the exit, flagging
          // the output it can no longer read. An unconfirmed end may have
          // lost output past any offset the host showed.
          sink.emit({
            terminalId: params.terminalId,
            fromOffset: params.fromOffset,
            toOffset: params.fromOffset,
            data: '',
            encoding: 'base64',
            truncatedBefore:
              !exited.confirmed || exited.outputOffset > params.fromOffset,
            exit: { code: exited.exitCode, signal: exited.signal },
          });
          sink.end('completed');
          return () => undefined;
        };
        if (!descriptor && recent) return complete(recent);
        if (!descriptor) throw notFound();
        const pacer = new AttachmentPacer(
          params.terminalId,
          sink,
          options.flushIntervalMs ?? FLUSH_INTERVAL_MS,
        );
        let attachmentId: string | undefined;
        const unsubscribe = supervisor.onEvent((event) => {
          if (
            event.type !== 'runningChanged' ||
            event.terminalId !== params.terminalId ||
            descriptors.get(params.terminalId) !== descriptor
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
                if (descriptors.get(params.terminalId) === descriptor)
                  noteOffset(params.terminalId, item.lifetimeId, item.toOffset);
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
          if (descriptors.get(params.terminalId) === descriptor)
            pacer.running({
              running: opened.terminal.running,
              processName: opened.terminal.processName,
            });
        } catch (error) {
          close();
          const exited = recentExits.get(params.terminalId);
          if (
            error instanceof TerminalHostRequestError &&
            error.error.code === 'notFound' &&
            exited?.descriptor === descriptor
          )
            return complete(exited);
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
