import { isAbsolute, relative, sep } from 'node:path';
import {
  CORE_WORKSPACE_COMMITTED_EVENT,
  CORE_WORKSPACE_INVALIDATED_EVENT,
  CoreWorkspaceCommittedPayloadSchema,
  CoreWorkspaceInvalidatedPayloadSchema,
  type CanopyJsonValue,
  type CanopyWorkspaceScope,
  type CoreWorkspaceCommittedPayload,
} from '@canopy/protocol/canopy-core';
import type { CoreEventRecord } from '../../kernel/core-events-module';
import {
  createEventJournal,
  type EventJournal,
} from '../../kernel/event-journal';
// Explicit commit-log modules only: the commit-log index loads node:sqlite.
import {
  isW5CaptureWorkspaceId,
  type W5CaptureFile,
} from './commit-log/capture-contract';
import type { W5CommitRequest } from './commit-log/commit-log';
import { W5CommitLogError, W5CommitRefusedError } from './commit-log/errors';
import type {
  W5CommitOutcome,
  W5HostRecoveryReport,
} from './commit-log/worker-contract';
import {
  w5ResourceKey,
  type W5CommitLogHostPort,
} from './commit-log-file-store';
import { W5CommitLogHostError } from './commit-log-host';

/*
 * The W5 commit event source (W5e, CAN-5497): every commit an attributed or
 * plain view of one host applies becomes exactly one `core.workspace.committed`
 * journal entry, appended in the outcome continuation, so journal order is
 * commit order. An uncertain outcome, a worker's exit, or a replacement worker
 * whose launch recovery may have applied commits, is
 * `core.workspace.invalidated`. Recovery-required and abandoned-conflict
 * decisions invalidate too: their log-wide eligibility changed without an
 * applied file. Pre-decision refusals and replays publish nothing.
 */

/** A host port, with the worker lifecycle hooks the source watches. */
export type W5CommitEventHost = W5CommitLogHostPort & {
  /** The start number of the latest worker whose launch recovery completed. */
  readonly recoveredWorker?: number;
  /** Called after each worker exits; returns the listener's removal. */
  onWorkerExit?(listener: () => void): () => void;
};

export interface W5CommitAttribution {
  /** The caller's client instance id; its own subscriber skips the event. */
  readonly publishedBy?: string;
}

export interface W5CommitEventSource {
  /** Serve with `createCoreEventsModule`; its epoch is the runtime's. */
  readonly journal: EventJournal<CoreEventRecord>;
  /**
   * A view of the host whose applied commits carry `publishedBy`. Every view
   * shares the host's final-decision queue (`commitQueueKey`).
   */
  port(attribution?: W5CommitAttribution): W5CommitLogHostPort;
}

export interface W5CommitEventSourceOptions {
  readonly host: W5CommitEventHost;
  /** The runtime's `daemonEpoch`. */
  readonly epoch: string;
  readonly maxEntries?: number;
  readonly now?: () => Date;
}

type CommittedChange = CoreWorkspaceCommittedPayload['changes'][number];
type CommittedFile = NonNullable<
  CoreWorkspaceCommittedPayload['files']
>[number];

const CHANGE_KINDS = {
  workspaces: 'index',
  workspace: 'workspace',
  worktrees: 'worktreeList',
  worktree: 'worktree',
} as const;

/** A file under the W5 root as a path-free capture file; anything else is dropped. */
export function classifyW5CommitFile(
  root: string,
  path: string,
): W5CaptureFile | null {
  const inside = relative(root, path);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
    return null;
  const parts = inside.split(sep);
  if (parts.length === 1) {
    if (parts[0] === 'index.json') return { kind: 'index' };
    if (parts[0] === 'index.json.bak') return { kind: 'index-backup' };
    return null;
  }
  const [workspaceId, file] = parts;
  if (parts.length !== 2 || !isW5CaptureWorkspaceId(workspaceId)) return null;
  if (file === 'workspace.json') return { kind: 'manifest', workspaceId };
  if (file === 'worktrees.json') return { kind: 'worktrees', workspaceId };
  return null;
}

/** Refused, malformed or never sent: no commit can have been made. */
function isCertainFailure(error: unknown): boolean {
  if (error instanceof W5CommitRefusedError) return true;
  if (error instanceof W5CommitLogError) return true;
  return (
    error instanceof W5CommitLogHostError && error.reason !== 'outcome-unknown'
  );
}

export function createW5CommitEventSource(
  options: W5CommitEventSourceOptions,
): W5CommitEventSource {
  const { host } = options;
  const now = options.now ?? ((): Date => new Date());
  const journal = createEventJournal<CoreEventRecord>({
    epoch: options.epoch,
    maxEntries: options.maxEntries,
  });
  let lastCommitId = 0;
  // The latest worker whose launch recovery subscribers were told of. Worker 1
  // recovers at startup, before any subscriber can attach.
  let observedWorker = Math.max(host.recoveredWorker ?? 0, 1);

  const append = (
    name: string,
    scope: CanopyWorkspaceScope,
    payload: Readonly<Record<string, CanopyJsonValue>>,
  ): void => {
    journal.append({ name, scope, occurredAt: now().toISOString(), payload });
  };
  const invalidate = (
    reason: 'uncertain' | 'recovered',
    commits?: readonly string[],
  ): void => {
    append(
      CORE_WORKSPACE_INVALIDATED_EVENT,
      {},
      CoreWorkspaceInvalidatedPayloadSchema.parse({
        reason,
        ...(commits && commits.length > 0 && { commits }),
      }),
    );
  };
  // A stopped worker, even one that failed before it was ready, may have
  // applied part of a commit or its launch recovery, and its refused calls
  // publish nothing; once it has exited, its effects are all on disk.
  host.onWorkerExit?.(() => invalidate('uncertain'));
  /**
   * Runs as every call settles, before anything it answered is published. A
   * worker is observed only once its launch recovery completed, never on a
   * call refused while it was still starting. Read in the call's own
   * continuation: a result settles in its worker's message task, and a newer
   * worker reports ready only in a later task.
   */
  const noteWorker = (report?: W5HostRecoveryReport): void => {
    const recovered = host.recoveredWorker;
    if (recovered === undefined || recovered <= observedWorker) return;
    // A report proves only its own worker's recovery; a skipped worker may
    // have applied part of a commit before it failed.
    const proof = recovered === observedWorker + 1 ? report : undefined;
    observedWorker = recovered;
    if (proof && proof.applied.length === 0) return;
    invalidate(
      'recovered',
      proof?.applied.map((commitId) => `w5:${commitId}`),
    );
  };

  const committed = (
    request: W5CommitRequest,
    outcome: Extract<W5CommitOutcome, { status: 'applied' }>,
    attribution: W5CommitAttribution,
  ): void => {
    const commit = `w5:${outcome.commitId}`;
    if (outcome.commitId <= lastCommitId) {
      // Journal order must be commit order; never publish out of it.
      invalidate('uncertain', [commit]);
      return;
    }
    lastCommitId = outcome.commitId;
    const workspaces = new Set<string>();
    const changes: CommittedChange[] = [];
    const seen = new Set<string>();
    for (const resource of request.advance) {
      const key = w5ResourceKey(resource);
      const revision = outcome.revisions[key];
      if (seen.has(key) || revision === undefined) continue;
      seen.add(key);
      const change: CommittedChange = {
        kind: CHANGE_KINDS[resource.kind],
        revision,
      };
      if (resource.kind !== 'workspaces') {
        change.workspaceId = resource.workspaceId;
        workspaces.add(resource.workspaceId);
      }
      if (resource.kind === 'worktree') change.worktreeId = resource.worktreeId;
      changes.push(change);
    }
    const files: CommittedFile[] = [];
    for (const { path } of request.files) {
      const file = classifyW5CommitFile(host.root, path);
      if (!file) continue;
      files.push({ ...file });
      if ('workspaceId' in file) workspaces.add(file.workspaceId);
    }
    const payload = CoreWorkspaceCommittedPayloadSchema.safeParse({
      commit,
      changes,
      files,
      ...(attribution.publishedBy !== undefined && {
        publishedBy: attribution.publishedBy,
      }),
    });
    if (!payload.success) {
      invalidate('uncertain', [commit]);
      return;
    }
    const [only] = workspaces;
    append(
      CORE_WORKSPACE_COMMITTED_EVENT,
      workspaces.size === 1 && only !== undefined ? { workspaceId: only } : {},
      payload.data,
    );
  };

  const views = new Map<string, W5CommitLogHostPort>();
  const view = (attribution: W5CommitAttribution): W5CommitLogHostPort => {
    const observe = <T>(call: Promise<T>): Promise<T> =>
      call.then(
        (result) => {
          noteWorker();
          return result;
        },
        (error: unknown) => {
          noteWorker();
          throw error;
        },
      );
    return {
      root: host.root,
      commitQueueKey: host.commitQueueKey ?? host,
      recoveryReport: () =>
        host.recoveryReport().then(
          (report) => {
            noteWorker(report);
            return report;
          },
          (error: unknown) => {
            noteWorker();
            throw error;
          },
        ),
      commit: (request) =>
        host.commit(request).then(
          (outcome) => {
            noteWorker();
            if (outcome.status === 'applied')
              committed(request, outcome, attribution);
            // Returned conflicts are persisted abandonments (W5CommitOutcome);
            // pre-decision revision/identity conflicts throw a certain refusal.
            else if (
              outcome.status === 'recovery-required' ||
              outcome.status === 'conflict'
            )
              invalidate('uncertain', [`w5:${outcome.commitId}`]);
            return outcome;
          },
          (error: unknown) => {
            noteWorker();
            if (!isCertainFailure(error)) invalidate('uncertain');
            throw error;
          },
        ),
      lookupReceipt: (receipt) => observe(host.lookupReceipt(receipt)),
      reserve: (input) => observe(host.reserve(input)),
      updateReservationDiagnostics: (reservationId, diagnostics) =>
        observe(host.updateReservationDiagnostics(reservationId, diagnostics)),
      releaseReservation: (reservationId) =>
        observe(host.releaseReservation(reservationId)),
      markReservationRecoveryRequired: (reservationId, diagnostics) =>
        observe(
          host.markReservationRecoveryRequired(reservationId, diagnostics),
        ),
      revision: (...args) => observe(host.revision(...args)),
      capture: (request) => observe(host.capture(request)),
    };
  };

  return {
    journal,
    port(attribution = {}): W5CommitLogHostPort {
      // One view per attribution, so a store's host lookup stays stable.
      const key = attribution.publishedBy ?? '';
      const existing = views.get(key);
      if (existing) return existing;
      const created = view(attribution);
      views.set(key, created);
      return created;
    },
  };
}
