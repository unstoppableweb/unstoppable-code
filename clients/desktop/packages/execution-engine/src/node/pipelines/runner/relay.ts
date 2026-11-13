import { access } from 'node:fs/promises';
import * as path from 'node:path';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  PIPELINE_RUNNER_DEFINITIONS,
  isPipelineRelayCoreHello,
  servePipelineRelayLeg,
  type PipelineHostModule,
  type PipelineOwnerLease,
  type PipelineRelayLeg,
} from '@canopy/core-runtime/node/pipeline/host';
import {
  WORKER_PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  CloudRunnerActivationSchema,
  PIPELINE_RELAY_CLOSE_CODES,
  PIPELINE_RELAY_MAX_MESSAGE_BYTES,
  pipelineRelaySubprotocols,
  type CloudRunnerActivation,
} from '@canopy/protocol/pipeline-relay';
import { WebSocket, type RawData } from 'ws';
import { listExecutionSummariesForArchival } from '../executor/execution-state';

/*
 * The runner's connection to the pipeline relay (CP-11): one outbound
 * WebSocket per attachment, dialled with the runner credential from the
 * activation, carrying one relay leg (`servePipelineRelayLeg`). The relay
 * stores nothing: when a connection drops, the runner keeps what the web
 * core missed in its events journal and execution state, and dials again
 * with backoff until the relay says it must not.
 *
 * Why a connection ends decides what follows:
 *
 * - `superseded` (4409) or `staleEpoch` (4410): a newer lease epoch holds
 *   the delegation. The incarnation's lease is over; it never dials again.
 * - `unauthorized` (4401): the relay refused the credential, revoked or
 *   expired. Dialling again cannot succeed.
 * - `replaced` (4408): another connection presented this credential while
 *   this one was open. The runner only dials after its last connection
 *   closed, so the other one is not this incarnation's; it stops.
 * - anything else, including a dropped network, a relay restart (1001), a
 *   stalled leg (4411) or a frame the relay refused (4400): dial again.
 *
 * The relay refuses a credential it does not take (401) before the
 * upgrade, which ends the runner as 4401 does. It refuses a stale epoch
 * with 409 too, but also this epoch while it still holds the runner's
 * dropped leg, so 409s end the runner as superseded only once they outlast
 * the relay's detection of that leg. At the credential's expiry the open
 * connection closes and nothing is dialled.
 */

/** Why the runner stopped dialling the relay. */
export type PipelineRunnerRelayEnd =
  | 'superseded'
  | 'unauthorized'
  | 'replaced'
  | 'expired'
  | 'stopped';

/** What the dialler needs of one WebSocket connection. */
export interface PipelineRunnerRelaySocket {
  /** Sends one text message; false once the connection is closing. */
  send(text: string): boolean;
  /** Bytes sent but not yet written to the network. */
  readonly bufferedAmount: number;
  close(code?: number, reason?: string): void;
}

export interface PipelineRunnerRelaySocketHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  /** The connection closed, with the code the peer or the network gave. */
  onClose(code: number): void;
}

/** Opens one connection; the default is `openNodeRelaySocket`. */
export type OpenPipelineRunnerRelaySocket = (
  url: string,
  protocols: string[],
  handlers: PipelineRunnerRelaySocketHandlers,
) => PipelineRunnerRelaySocket;

/** A close code for a connection that never opened or lost its network. */
const ABNORMAL_CLOSE = 1006;
const NORMAL_CLOSE = 1000;

/**
 * The dialler's own close code for an upgrade the relay refused with 409.
 * The relay never sends it.
 */
export const PIPELINE_RUNNER_RELAY_UPGRADE_CONFLICT = 4900;

/**
 * The close code a refused upgrade stands for. The relay checks the token
 * and the lease epoch before the upgrade (apps/device-relay): 401 for a
 * credential it does not take, and 409 both for an epoch older than the
 * delegation's current one and for this epoch while the relay still holds
 * the runner's earlier accepted leg, which it drops within a heartbeat or
 * two. Anything else, such as 503 or 429, is worth dialling again.
 */
function upgradeRefusalCode(status: number | undefined): number {
  switch (status) {
    case 401:
      return PIPELINE_RELAY_CLOSE_CODES.unauthorized;
    case 409:
      return PIPELINE_RUNNER_RELAY_UPGRADE_CONFLICT;
    default:
      return ABNORMAL_CLOSE;
  }
}

/**
 * How long an upgrade may take: one that a proxy accepts and never answers
 * closes as 1006 and is dialled again.
 */
export const PIPELINE_RUNNER_RELAY_HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * How often an open connection proves it is alive. The runner pings each
 * interval; a connection that sent nothing back since the last ping, no
 * pong, ping or message, is taken as lost (a half-open TCP connection or an
 * expired NAT mapping closes nothing), terminated and dialled again.
 */
export const PIPELINE_RUNNER_RELAY_LIVENESS_INTERVAL_MS = 15_000;

/**
 * Node's connection to the relay, on `ws`: unlike Node's built-in client,
 * it reports a refused upgrade's status, which says whether to dial again.
 */
export function nodeRelaySocketOpener(
  options: {
    readonly handshakeTimeoutMs?: number;
    readonly livenessIntervalMs?: number;
  } = {},
): OpenPipelineRunnerRelaySocket {
  const timing = {
    handshakeTimeout:
      options.handshakeTimeoutMs ?? PIPELINE_RUNNER_RELAY_HANDSHAKE_TIMEOUT_MS,
    livenessInterval:
      options.livenessIntervalMs ?? PIPELINE_RUNNER_RELAY_LIVENESS_INTERVAL_MS,
  };
  return (url, protocols, handlers) =>
    openNodeRelaySocketWith(url, protocols, handlers, timing);
}

export const openNodeRelaySocket: OpenPipelineRunnerRelaySocket =
  nodeRelaySocketOpener();

function openNodeRelaySocketWith(
  url: string,
  protocols: string[],
  handlers: PipelineRunnerRelaySocketHandlers,
  timing: {
    readonly handshakeTimeout: number;
    readonly livenessInterval: number;
  },
): PipelineRunnerRelaySocket {
  const socket = new WebSocket(url, protocols, {
    maxPayload: PIPELINE_RELAY_MAX_MESSAGE_BYTES,
    handshakeTimeout: timing.handshakeTimeout,
  });
  let closed = false;
  let heard = true;
  let liveness: ReturnType<typeof setInterval> | undefined;
  const closeOnce = (code: number): void => {
    if (closed) return;
    closed = true;
    if (liveness !== undefined) clearInterval(liveness);
    handlers.onClose(code);
  };
  const alive = (): void => {
    heard = true;
  };
  socket.on('open', () => {
    liveness = setInterval(() => {
      if (!heard) {
        // Lost without a close: end it here so the dialler dials again.
        socket.terminate();
        closeOnce(ABNORMAL_CLOSE);
        return;
      }
      heard = false;
      socket.ping();
    }, timing.livenessInterval);
    handlers.onOpen();
  });
  socket.on('pong', alive);
  socket.on('ping', alive);
  socket.on('message', (data, isBinary) => {
    alive();
    // Every relay message is text; a binary one is not a session frame.
    if (isBinary) socket.close(PIPELINE_RELAY_CLOSE_CODES.invalidMessage);
    else handlers.onMessage(rawText(data));
  });
  socket.on('unexpected-response', (request, response) => {
    closeOnce(upgradeRefusalCode(response.statusCode));
    request.destroy();
  });
  socket.on('close', (code) => closeOnce(code));
  socket.on('error', () => closeOnce(ABNORMAL_CLOSE));
  return {
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    send: (text) => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(text);
      return true;
    },
    close: (code = NORMAL_CLOSE, reason) => {
      if (socket.readyState === WebSocket.CONNECTING) {
        // Not open yet: there is no close handshake to send.
        socket.terminate();
        closeOnce(code);
        return;
      }
      try {
        socket.close(code, reason);
      } catch {
        // Already closing.
      }
    },
  };
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(new Uint8Array(data)).toString('utf8');
}

export interface PipelineRunnerRelayBackoff {
  readonly initialMs: number;
  readonly maxMs: number;
  /** A connection open this long resets the backoff. */
  readonly stableMs: number;
}

/**
 * The most a connection queues before the network takes it, four of the
 * relay's largest messages. Past it the attachment ends and the runner
 * dials again: its streams resume from their cursors, so a slow relay
 * costs a reconnect, never unbounded memory.
 */
export const PIPELINE_RUNNER_RELAY_MAX_BUFFERED_BYTES =
  4 * PIPELINE_RELAY_MAX_MESSAGE_BYTES;

/**
 * How long 409 refusals may go on before the runner takes them as a newer
 * epoch holding the delegation: past the relay's own detection of the
 * runner's dropped leg (a 10 s heartbeat), with no connection opened since.
 */
export const PIPELINE_RUNNER_RELAY_UPGRADE_CONFLICT_MS = 60_000;

/** Backoff between dials: doubled from `initialMs` to `maxMs`, with jitter. */
export const PIPELINE_RUNNER_RELAY_BACKOFF: PipelineRunnerRelayBackoff =
  Object.freeze({
    initialMs: 500,
    maxMs: 15_000,
    /** A connection open this long resets the backoff. */
    stableMs: 30_000,
  });

export interface DialPipelineRelayOptions {
  /** The relay leg URL from the activation, with its path. */
  readonly url: string;
  /** The runner credential's relay token. */
  readonly token: string;
  /** When the credential ends (epoch ms): nothing is dialled after it. */
  readonly expiresAt: number;
  /** Serves one attachment over `send`; ends it with `close`. */
  readonly serve: (attachment: {
    readonly send: (text: string) => boolean;
    /** The leg ended on its own: close its connection and dial again. */
    readonly onEnded: () => void;
  }) => PipelineRelayLeg;
  readonly openSocket?: OpenPipelineRunnerRelaySocket;
  readonly backoff?: Partial<PipelineRunnerRelayBackoff>;
  /** Default {@link PIPELINE_RUNNER_RELAY_UPGRADE_CONFLICT_MS}. */
  readonly upgradeConflictMs?: number;
  /** Default {@link PIPELINE_RUNNER_RELAY_MAX_BUFFERED_BYTES}. */
  readonly maxBufferedBytes?: number;
  /** Observes each connection's open and close, for the runner's log. */
  readonly onConnection?: (
    event:
      | { readonly kind: 'open'; readonly attempt: number }
      | {
          readonly kind: 'closed';
          readonly code: number;
          readonly retryInMs: number | null;
        },
  ) => void;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface PipelineRunnerRelay {
  /** Settles once the runner stops dialling, with why. */
  readonly ended: Promise<PipelineRunnerRelayEnd>;
  /** Closes the connection and stops dialling (`stopped`). */
  stop(): void;
  /** A newer lease epoch holds the delegation: stop dialling (`superseded`). */
  supersede(): void;
}

/** The longest delay a timer takes. */
const TIMER_MAX_MS = 2_147_483_647;

interface Connection {
  socket: PipelineRunnerRelaySocket | null;
  leg: PipelineRelayLeg | null;
}

function endOf(code: number): PipelineRunnerRelayEnd | null {
  switch (code) {
    case PIPELINE_RELAY_CLOSE_CODES.superseded:
    case PIPELINE_RELAY_CLOSE_CODES.staleEpoch:
      return 'superseded';
    case PIPELINE_RELAY_CLOSE_CODES.unauthorized:
      return 'unauthorized';
    case PIPELINE_RELAY_CLOSE_CODES.replaced:
      return 'replaced';
    default:
      return null;
  }
}

/** Dials the relay and keeps one attachment served until it must stop. */
export function dialPipelineRelay(
  options: DialPipelineRelayOptions,
): PipelineRunnerRelay {
  const openSocket = options.openSocket ?? openNodeRelaySocket;
  const backoff: PipelineRunnerRelayBackoff = {
    ...PIPELINE_RUNNER_RELAY_BACKOFF,
    ...options.backoff,
  };
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const protocols = pipelineRelaySubprotocols(options.token);
  let resolveEnded: (end: PipelineRunnerRelayEnd) => void = () => undefined;
  const ended = new Promise<PipelineRunnerRelayEnd>((resolve) => {
    resolveEnded = resolve;
  });
  let finished = false;
  let attempt = 0;
  let delayMs = backoff.initialMs;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let current: Connection | null = null;
  /** When the current run of 409 refusals began, with nothing opened since. */
  let conflictSince: number | null = null;
  const upgradeConflictMs =
    options.upgradeConflictMs ?? PIPELINE_RUNNER_RELAY_UPGRADE_CONFLICT_MS;
  const maxBufferedBytes =
    options.maxBufferedBytes ?? PIPELINE_RUNNER_RELAY_MAX_BUFFERED_BYTES;

  const finish = (end: PipelineRunnerRelayEnd): void => {
    if (finished) return;
    finished = true;
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    clearTimeout(expiry);
    const open = current;
    current = null;
    open?.leg?.close();
    open?.socket?.close(NORMAL_CLOSE, end);
    resolveEnded(end);
  };

  const dial = (): void => {
    retry = undefined;
    if (finished) return;
    if (now() >= options.expiresAt) return finish('expired');
    attempt += 1;
    let openedAt: number | null = null;
    // Current before it opens: a socket may report as soon as it is made.
    const connection: Connection = { socket: null, leg: null };
    current = connection;
    const live = (): boolean => current === connection;
    const serveLeg = (): PipelineRelayLeg =>
      options.serve({
        // A connection that stopped draining ends its attachment.
        send: (text) => {
          const socket = connection.socket;
          if (!live() || socket === null) return false;
          if (socket.bufferedAmount > maxBufferedBytes) return false;
          return socket.send(text);
        },
        onEnded: () => {
          if (live()) connection.socket?.close();
        },
      });
    connection.socket = openSocket(options.url, protocols, {
      onOpen: () => {
        if (!live()) return;
        openedAt = now();
        conflictSince = null;
        options.onConnection?.({ kind: 'open', attempt });
        connection.leg = serveLeg();
      },
      onMessage: (text) => {
        if (!live()) return;
        // A core that connected again opens a new session on the same
        // connection: what the last one served ends, and a new leg takes its
        // hello. The relay dropped what was sent while no core held it.
        if (
          connection.leg?.established === true &&
          isPipelineRelayCoreHello(text)
        ) {
          connection.leg.close();
          connection.leg = serveLeg();
        }
        connection.leg?.receive(text);
      },
      onClose: (code) => {
        if (!live()) return;
        current = null;
        connection.leg?.close();
        let end = endOf(code);
        if (code === PIPELINE_RUNNER_RELAY_UPGRADE_CONFLICT) {
          conflictSince ??= now();
          if (now() - conflictSince >= upgradeConflictMs) end = 'superseded';
        }
        if (end !== null) {
          options.onConnection?.({ kind: 'closed', code, retryInMs: null });
          return finish(end);
        }
        if (openedAt !== null && now() - openedAt >= backoff.stableMs)
          delayMs = backoff.initialMs;
        // Jitter over the upper half, so runners do not dial in step.
        const wait = Math.round(delayMs / 2 + (random() * delayMs) / 2);
        delayMs = Math.min(backoff.maxMs, delayMs * 2);
        options.onConnection?.({ kind: 'closed', code, retryInMs: wait });
        retry = setTimeout(dial, wait);
      },
    });
    // Stopped while it was being made.
    if (!live() && finished) connection.socket.close(NORMAL_CLOSE);
  };

  // The credential's expiry ends an open connection too: the relay checks
  // it only at the upgrade.
  const expiry = setTimeout(
    () => finish('expired'),
    Math.min(TIMER_MAX_MS, Math.max(0, options.expiresAt - now())),
  );
  expiry.unref?.();
  dial();
  return {
    ended,
    stop: () => finish('stopped'),
    supersede: () => finish('superseded'),
  };
}

/**
 * How the relay mode exits (CP-11), so the sandbox supervisor knows what
 * the incarnation left without reading its output:
 *
 * - `terminal` (0): every run it held has ended.
 * - `paused` (10): its store holds a run it did not finish (paused for
 *   owner loss, input or a provider, or left running by a lost host), or it
 *   could not read its store to tell; a new incarnation resumes it.
 * - `drained` (11): it stopped on a signal while runs were running, and
 *   checkpointed every one as paused for the next incarnation (a checkpoint
 *   that failed leaves its run unpaused, which exits as `paused`).
 * - `fenced` (12): a newer lease epoch holds the delegation (superseded,
 *   staleEpoch or a newer epoch's notice), or another connection took its
 *   credential (replaced); its fence stopped every run.
 * - `leaseLapsed` (13): its credential expired or the relay refused it.
 *
 * 1 stays a failure and 2 a usage error, as in the other modes.
 */
export const PIPELINE_RUNNER_RELAY_EXIT_CODES = Object.freeze({
  terminal: 0,
  paused: 10,
  drained: 11,
  fenced: 12,
  leaseLapsed: 13,
});

/**
 * The runs a stopped runner left unfinished in its store, for its exit code
 * (CP-11): every record not finished (pending, running or paused) once its supervisor has
 * stopped, so a run admitted while it stopped, checkpointed by the stop, or
 * orphaned by a lost host is counted. Null when a state file cannot be read:
 * the exit code then never claims every run ended.
 */
const FINISHED: ReadonlySet<string> = new Set([
  'success',
  'failure',
  'cancelled',
]);

export async function pipelineRunnerStoreCensus(dataRoot: string): Promise<{
  readonly unfinished: number | null;
  /** Of those, the records still pending or running: no checkpoint took them. */
  readonly unpaused: number | null;
}> {
  const executionsDir = path.join(dataRoot, 'pipeline-executions');
  try {
    await access(executionsDir);
  } catch (error) {
    // No run ever wrote here; any other failure leaves it unknown.
    const count =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
        ? 0
        : null;
    return { unfinished: count, unpaused: count };
  }
  try {
    const { summaries, unreadableFiles } =
      await listExecutionSummariesForArchival(executionsDir);
    if (unreadableFiles.length > 0) return { unfinished: null, unpaused: null };
    // Every status but a finished one is unfinished, a pending record a
    // lost host left included, and so is any status added later.
    const unfinished = summaries.filter(({ status }) => !FINISHED.has(status));
    return {
      unfinished: unfinished.length,
      unpaused: unfinished.filter(({ status }) => status !== 'paused').length,
    };
  } catch {
    return { unfinished: null, unpaused: null };
  }
}

export function pipelineRunnerRelayExitCode(outcome: {
  readonly end: PipelineRunnerRelayEnd;
  /** It stopped on SIGTERM or SIGINT. */
  readonly signalled: boolean;
  /** Runs its host ran when the signal came, which the stop checkpointed. */
  readonly runningAtSignal: number;
  /** Runs its store held unfinished once it stopped; null when unknown. */
  readonly unfinished: number | null;
  /** Of those, the ones no checkpoint paused; null when unknown. */
  readonly unpaused: number | null;
}): number {
  const codes = PIPELINE_RUNNER_RELAY_EXIT_CODES;
  switch (outcome.end) {
    case 'superseded':
    case 'replaced':
      return codes.fenced;
    case 'expired':
    case 'unauthorized':
      return codes.leaseLapsed;
    case 'stopped':
      break;
  }
  // Drained only when it checkpointed what it ran: the store reads, holds
  // unfinished runs, and none of them is still pending or running. Runs
  // that ended before the stop leave nothing to drain.
  if (
    outcome.signalled &&
    outcome.runningAtSignal > 0 &&
    outcome.unfinished !== null &&
    outcome.unfinished > 0 &&
    outcome.unpaused === 0
  )
    return codes.drained;
  if (outcome.unfinished === null || outcome.unfinished > 0)
    return codes.paused;
  return codes.terminal;
}

/**
 * Reads a bootstrap activation (CAN-6215). Whatever is wrong with it, the
 * error names nothing it holds: a JSON or schema error message could quote
 * the relay token, the session key or a secret value.
 */
export function parsePipelineRunnerActivation(
  text: string,
): CloudRunnerActivation | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = CloudRunnerActivationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The incarnation's delegation lease (CAN-6198), as its activation names
 * it: the epoch its credential was issued for, ending at the credential's
 * expiry, which nothing in the activation outlives. Until the web core
 * reports renewals, that is the lease's end; a newer epoch ends it sooner.
 */
export function pipelineRunnerLeaseOf(
  activation: Pick<CloudRunnerActivation, 'leaseEpoch' | 'expiresAt'>,
): PipelineOwnerLease {
  return {
    leaseEpoch: activation.leaseEpoch,
    expiresAt: Date.parse(activation.expiresAt),
  };
}

/**
 * The web core as the runner's caller over the relay (CAN-6161 Caller
 * context): its authority for the activation's delegation, with the
 * worker.pipeline grants. The relay carries no caller; the credential the
 * runner dialled with decides who is on the other end.
 */
export function pipelineRunnerRelayCaller(
  activation: Pick<CloudRunnerActivation, 'delegationId' | 'leaseEpoch'>,
): CanopyCallerDescriptor {
  return {
    principalId: 'web-core',
    clientInstanceId: `web-core:delegation:${activation.delegationId}:${String(activation.leaseEpoch)}`,
    authorityId: 'web-core',
    interfaceKind: 'worker',
    grants: [
      WORKER_PIPELINE_GRANTS.read,
      WORKER_PIPELINE_GRANTS.write,
      WORKER_PIPELINE_GRANTS.host,
    ],
  };
}

export interface ServePipelineRunnerRelayOptions extends Pick<
  DialPipelineRelayOptions,
  'openSocket' | 'backoff' | 'onConnection' | 'now' | 'random'
> {
  /** The runner, built with the activation's lease (`pipelineRunnerLeaseOf`). */
  readonly runner: PipelineHostModule;
  readonly activation: Pick<
    CloudRunnerActivation,
    'delegationId' | 'leaseEpoch' | 'expiresAt' | 'relay' | 'sessionKey'
  >;
}

/**
 * Serves the runner's `worker.pipeline.*` operations, its recovery controls
 * and checkpoint, and the owner channel to the web core over the relay
 * (CP-11), one leg per attachment. Once a newer lease epoch holds the
 * delegation, the supervisor's fence stops every run (CAN-6198).
 */
export function servePipelineRunnerRelay(
  options: ServePipelineRunnerRelayOptions,
): PipelineRunnerRelay {
  const { runner, activation } = options;
  const { runnerHandlers } = runner;
  if (!runnerHandlers)
    throw new Error('The relay serves a runner built with its operations.');
  const dispatcher = createCanopyDispatcher({
    profile: 'worker',
    definitions: PIPELINE_RUNNER_DEFINITIONS,
    handlers: {
      ...runner.handlers,
      instructions: { ...runner.handlers.instructions, ...runnerHandlers },
    },
  });
  const caller = pipelineRunnerRelayCaller(activation);
  const sessionKey = Buffer.from(activation.sessionKey, 'base64url');
  // Set once dialling starts; a notice arrives only on an open connection.
  let supersede: () => void = () => undefined;
  const relay = dialPipelineRelay({
    url: activation.relay.url,
    token: activation.relay.token,
    expiresAt: Date.parse(activation.expiresAt),
    serve: ({ send, onEnded }) =>
      servePipelineRelayLeg({
        dispatcher,
        definitions: PIPELINE_RUNNER_DEFINITIONS,
        caller,
        sessionKey,
        send,
        onEnded,
        // The same owner returns only with this delegation's lease at this
        // epoch or a newer one (CP-11). The session already proves the core
        // holds this incarnation's key; the notice can only move it on.
        onLease: (lease) => {
          // The leg ends at once, so nothing this core sent after the notice
          // is served; ending it closes the connection, and the runner dials
          // again.
          if (lease.leaseEpoch < activation.leaseEpoch) return 'refuse';
          runner.supervisor.observeOwnerLease({ kind: 'renewed', lease });
          if (lease.leaseEpoch > activation.leaseEpoch) supersede();
          return undefined;
        },
      }),
    ...(options.openSocket && { openSocket: options.openSocket }),
    ...(options.backoff && { backoff: options.backoff }),
    ...(options.onConnection && { onConnection: options.onConnection }),
    ...(options.now && { now: options.now }),
    ...(options.random && { random: options.random }),
  });
  supersede = (): void => relay.supersede();
  void relay.ended.then((end) => {
    if (end === 'superseded')
      runner.supervisor.observeOwnerLease({ kind: 'superseded' });
  });
  return relay;
}
