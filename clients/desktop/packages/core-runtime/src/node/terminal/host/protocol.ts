import type { TerminalSession } from '@canopy/protocol/terminal';
import type { TerminalEnvironment } from '../ports';
import type { ResolvedTerminalShell } from '../shells';

/**
 * The private protocol between a worker and the terminal host process it
 * supervises (CAN-5088). The host runs the terminal engine with its own PTY
 * library, so a native fault there ends only terminals. Messages are
 * structured-clone values on the execution host channel; nothing here is a
 * wire operation, and every host path in it was resolved by the worker.
 */

/** Where and how a terminal starts, as the worker resolved it. */
export interface TerminalHostLaunch {
  projectId: string;
  worktreeId: string;
  /** The scope root; a restored directory that left it falls back here. */
  root: string;
  /** The directory the shell starts in. */
  cwd: string;
  /** The terminal's whole environment; the host adds nothing of its own. */
  environment: TerminalEnvironment;
  shell: ResolvedTerminalShell;
  initialCommand?: string;
  /**
   * The terminal's output belongs in its worktree record (CAN-7051): the
   * host reports its bytes. Every terminal reports first output and offsets.
   */
  persist?: boolean;
}

export type TerminalHostRequest =
  | {
      op: 'create';
      launch: TerminalHostLaunch;
      cols: number;
      rows: number;
    }
  | {
      op: 'restore';
      terminalId: string;
      cols: number;
      rows: number;
      /** Recreates a terminal that is not live here from its persisted output. */
      recreate?: TerminalHostLaunch & { scrollback: string };
    }
  | { op: 'write'; terminalId: string; data: string }
  | { op: 'resize'; terminalId: string; cols: number; rows: number }
  /** `signal` is the exit reason the terminal reports (CAN-7051). */
  | { op: 'kill'; terminalId: string; signal?: string }
  | { op: 'release'; terminalId: string; signal?: string }
  | { op: 'list' }
  | {
      op: 'attach';
      attachmentId: string;
      terminalId: string;
      fromOffset: number;
      maxReplayBytes?: number;
    }
  | { op: 'acknowledge'; attachmentId: string; offset: number }
  | { op: 'detach'; attachmentId: string }
  /** Kill every terminal and wait for their exits; the host then idles. */
  | { op: 'stop' };

export type TerminalHostOperation = TerminalHostRequest['op'];

/** One live terminal of the host. */
export interface TerminalHostTerminal {
  /** Monotonic within this host, never a public terminal id. */
  lifetimeId?: number;
  session: TerminalSession;
  pid: number | null;
  cols: number;
  rows: number;
  /** Offset just past the last byte the terminal has written. */
  outputOffset: number;
  running: boolean;
  processName: string | null;
}

export type TerminalHostErrorCode =
  | 'notFound'
  | 'invalidState'
  | 'capacity'
  | 'unavailable'
  | 'failed';

export interface TerminalHostError {
  code: TerminalHostErrorCode;
  message: string;
}

export interface TerminalHostExit {
  exitCode: number | null;
  signal: string | null;
}

export interface TerminalHostItem {
  terminalId: string;
  /** The PTY lifetime the attachment opened on; it drains past that exit. */
  lifetimeId?: number;
  fromOffset: number;
  toOffset: number;
  data: Uint8Array;
  truncatedBefore: boolean;
  exit: TerminalHostExit | null;
}

export type TerminalHostEvent = { lifetimeId?: number } & (
  | {
      type: 'runningChanged';
      terminalId: string;
      running: boolean;
      processName: string | null;
      interruptedByUser?: boolean;
    }
  | ({
      type: 'exit';
      terminalId: string;
      /** Offset just past the terminal's last byte; absent when its host died. */
      outputOffset?: number;
    } & TerminalHostExit)
);

/**
 * What a terminal host tells its worker about output outside any attachment
 * (CAN-7051): the bytes of a persisted terminal, in order and before its
 * exit; a terminal's first live output (never its restored replay); and its
 * output offset, coalesced.
 */
export type TerminalHostReport = { lifetimeId?: number } & (
  | { type: 'output'; terminalId: string; toOffset: number; data: Uint8Array }
  | { type: 'firstOutput'; terminalId: string; at: number }
  | { type: 'offset'; terminalId: string; outputOffset: number }
);

/** Worker to host. */
export interface TerminalHostRequestMessage {
  kind: 'request';
  id: number;
  request: TerminalHostRequest;
}

/** Host to worker. */
export type TerminalHostMessage =
  | { kind: 'ready' }
  | { kind: 'response'; id: number; ok: true; value: unknown }
  | { kind: 'response'; id: number; ok: false; error: TerminalHostError }
  | { kind: 'item'; attachmentId: string; item: TerminalHostItem }
  | {
      kind: 'end';
      attachmentId: string;
      outcome: 'completed' | 'cancelled';
      offset: number;
    }
  | { kind: 'event'; event: TerminalHostEvent }
  | { kind: 'report'; report: TerminalHostReport };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isTerminalHostRequestMessage(
  value: unknown,
): value is TerminalHostRequestMessage {
  return (
    isRecord(value) &&
    value.kind === 'request' &&
    typeof value.id === 'number' &&
    isRecord(value.request) &&
    typeof value.request.op === 'string'
  );
}

const HOST_MESSAGE_KINDS = new Set([
  'ready',
  'response',
  'item',
  'end',
  'event',
  'report',
]);

export function isTerminalHostMessage(
  value: unknown,
): value is TerminalHostMessage {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    HOST_MESSAGE_KINDS.has(value.kind)
  );
}
