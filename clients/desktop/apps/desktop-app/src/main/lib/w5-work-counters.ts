import { basename } from 'node:path';
import type { W5CommitLogHostPort } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import type { W5RecordPortTransport } from '@canopy/core-runtime/node/w5/record-port';
import { CanopyErrorPayloadSchema } from '@canopy/protocol/canopy-core';
import { recordW5Work } from '@canopy/desktop-shared/node/work-counters';

/*
 * CAN-5532: W5 store work counters, counted in every build. They compare the
 * in-process store with the daemon-backed one: reads by record class and
 * source, host captures and commits, and record-port calls, each with its
 * microsecond total. Counting never changes what the counted call does.
 */

/**
 * CAN-7064: the `w5` keys that split logical work from the captures that
 * served it and the bytes decoded from them. The new keys use prefixes no
 * CAN-5532 or CAN-6944 key uses, so caller attribution never charges them.
 */
export const W5_AGGREGATE_KEYS = {
  /** One `runW5ReadView` query. */
  queryReadView: 'logical.query.readView',
  /** One `prepareW5ReadBinding` query. */
  queryPreparation: 'logical.query.preparation',
  /** One record read sent to the daemon record port (CAN-5532). */
  recordReads: 'read.backend.capture',
  /** One capture call over the record port (CAN-5532). */
  portCaptures: 'port.capture',
  /** One capture by an in-process host (CAN-5532). */
  hostCaptures: 'host.capture',
  portCapturedBytes: 'captured.port.bytes',
  hostCapturedBytes: 'captured.host.bytes',
  viewDecodedBytes: 'decoded.view.bytes',
  recordDecodedBytes: 'decoded.record.bytes',
  indexDecodedBytes: 'decoded.index.bytes',
} as const;

/**
 * Decoded size of the present images in a capture. A record-port
 * result is counted before the port validates it, so a malformed one counts
 * as 0 instead of throwing.
 */
export function w5PresentImageBytes(capture: {
  readonly files: readonly {
    readonly state: string;
    readonly base64?: string;
  }[];
}): number {
  let bytes = 0;
  try {
    for (const file of capture.files)
      if (file.state === 'present' && typeof file.base64 === 'string')
        bytes += Buffer.byteLength(file.base64, 'base64');
  } catch {
    return 0;
  }
  return bytes;
}

export type W5RecordFileClass = 'index' | 'manifest' | 'worktrees' | 'other';

/** The W5 record class a store path names, by its file name. */
export function w5RecordFileClass(filePath: string): W5RecordFileClass {
  switch (basename(filePath)) {
    case 'index.json':
    case 'index.json.bak':
      return 'index';
    case 'workspace.json':
      return 'manifest';
    case 'worktrees.json':
      return 'worktrees';
    default:
      return 'other';
  }
}

function recordElapsed(key: string, startedAt: number): void {
  recordW5Work(`${key}.us`, Math.round((performance.now() - startedAt) * 1000));
}

async function timed<T>(key: string, call: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await call();
  } finally {
    recordElapsed(key, startedAt);
  }
}

const countedHosts = new WeakMap<W5CommitLogHostPort, W5CommitLogHostPort>();

/**
 * `host` with its captures, commits and revision reads counted. One view per
 * host, sharing the host's final-decision queue (`commitQueueKey`).
 */
export function countingW5HostPort(
  host: W5CommitLogHostPort,
): W5CommitLogHostPort {
  const existing = countedHosts.get(host);
  if (existing) return existing;
  const view: W5CommitLogHostPort = {
    get root(): string {
      return host.root;
    },
    commitQueueKey: host.commitQueueKey ?? host,
    recoveryReport: () => host.recoveryReport(),
    async commit(request) {
      recordW5Work(`host.commit.${request.operation}`);
      try {
        const outcome = await timed('host.commit', () => host.commit(request));
        recordW5Work(`host.commit.${outcome.status}`);
        return outcome;
      } catch (error) {
        recordW5Work('host.commit.failed');
        throw error;
      }
    },
    lookupReceipt: (receipt) => host.lookupReceipt(receipt),
    reserve: (input) => host.reserve(input),
    updateReservationDiagnostics: (reservationId, diagnostics) =>
      host.updateReservationDiagnostics(reservationId, diagnostics),
    releaseReservation: (reservationId) =>
      host.releaseReservation(reservationId),
    markReservationRecoveryRequired: (reservationId, diagnostics) =>
      host.markReservationRecoveryRequired(reservationId, diagnostics),
    revision(resource, forCommit) {
      recordW5Work('host.revision');
      return forCommit
        ? host.revision(resource, true)
        : host.revision(resource);
    },
    ...(host.captureForPreparation
      ? {
          captureForPreparation: (
            request: Parameters<
              NonNullable<W5CommitLogHostPort['captureForPreparation']>
            >[0],
          ) =>
            host.captureForPreparation
              ? host.captureForPreparation(request)
              : Promise.reject(new Error('Preparation capability was removed')),
        }
      : {}),
    async capture(request, signal) {
      recordW5Work('host.capture');
      const result = await timed('host.capture', () =>
        host.capture(request, signal),
      );
      recordW5Work('host.capture.files', result.files.length);
      recordW5Work(
        W5_AGGREGATE_KEYS.hostCapturedBytes,
        w5PresentImageBytes(result),
      );
      // The history each capture's chain evidence aggregates (CAN-5562):
      // every retained decision of each captured path, and the log's size.
      recordW5Work(
        'host.capture.chainDecisions',
        result.log.chains.reduce((sum, chain) => sum + chain.decisions, 0),
      );
      recordW5Work('host.capture.retainedCommits', result.log.retainedCommits);
      return result;
    },
  };
  countedHosts.set(host, view);
  return view;
}

/**
 * The counter keys of one failed record-port call: its error kind, and for a
 * typed authority refusal its code and, when it names one, its reason (such
 * as `writeRefused.unlisted_writer`).
 */
export function w5PortFailureKeys(method: string, error: unknown): string[] {
  const payload =
    typeof error === 'object' && error !== null && 'payload' in error
      ? CanopyErrorPayloadSchema.safeParse(error.payload)
      : undefined;
  if (!payload?.success) return [`port.${method}.failed.untyped`];
  const { kind, code, details } = payload.data;
  const keys = [`port.${method}.failed.${kind}`];
  if (code) {
    const reason =
      typeof details === 'object' &&
      details !== null &&
      'reason' in details &&
      typeof details.reason === 'string'
        ? `.${details.reason}`
        : '';
    keys.push(
      `port.${method}.refused.${code.replace(/^core\.workspaceRecords\./, '')}${reason}`,
    );
  }
  return keys;
}

/** `transport` with every call, its failures and its time counted. */
export function countingW5RecordPortTransport(
  transport: W5RecordPortTransport,
): W5RecordPortTransport {
  const call = async <T>(method: string, run: () => Promise<T>): Promise<T> => {
    recordW5Work(`port.${method}`);
    const startedAt = performance.now();
    try {
      return await run();
    } catch (error) {
      for (const key of w5PortFailureKeys(method, error)) recordW5Work(key);
      throw error;
    } finally {
      recordElapsed(`port.${method}`, startedAt);
    }
  };
  return {
    capture: (request, signal) =>
      call('capture', async () => {
        const result = await transport.capture(request, signal);
        recordW5Work(
          W5_AGGREGATE_KEYS.portCapturedBytes,
          w5PresentImageBytes(result),
        );
        return result;
      }),
    recovery: () => call('recovery', () => transport.recovery()),
    commit: (request) => call('commit', () => transport.commit(request)),
    lookupReceipt: (receipt) =>
      call('lookupReceipt', () => transport.lookupReceipt(receipt)),
    listReservations: () =>
      call('listReservations', () => transport.listReservations()),
    reserve: (params) => call('reserve', () => transport.reserve(params)),
    updateReservationDiagnostics: (params) =>
      call('updateReservationDiagnostics', () =>
        transport.updateReservationDiagnostics(params),
      ),
    releaseReservation: (reservationId) =>
      call('releaseReservation', () =>
        transport.releaseReservation(reservationId),
      ),
    markReservationRecoveryRequired: (params) =>
      call('markReservationRecoveryRequired', () =>
        transport.markReservationRecoveryRequired(params),
      ),
  };
}
