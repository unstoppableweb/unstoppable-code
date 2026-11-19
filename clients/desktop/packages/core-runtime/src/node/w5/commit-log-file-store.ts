import { assertStorageWriteAllowed, STORAGE_OWNERSHIP } from '../../storage';
// Explicit commit-log modules only: the commit-log index loads node:sqlite,
// which only the worker opens.
import type { W5ProcessFileLock } from './commit-log/apply';
import type {
  W5CaptureRequest,
  W5CaptureResult,
} from './commit-log/capture-contract';
import type {
  W5CommitRequest,
  W5ReceiptLookup,
  W5Reservation,
  W5ReservationFailureDiagnostics,
  W5Resource,
} from './commit-log/commit-log';
import {
  W5CommitRefusedError,
  W5FileWriteRefusedError,
} from './commit-log/errors';
import { fingerprintW5File } from './commit-log/fingerprint';
import {
  workspaceCreationDiagnosticsSchema,
  type WorkspaceCreationDiagnostics,
} from './commit-log/reservation-diagnostics';
import { isW5CommitOutcome } from './commit-log/worker-contract';
import type {
  W5CommitOutcome,
  W5HostRecoveryReport,
} from './commit-log/worker-contract';
import {
  currentW5CommitScope,
  runW5Commit,
  type W5CommitOptions,
  type W5ObservedFile,
} from './commit-scope';
import {
  WorkspaceConfigUnreadableError,
  createSerialQueue,
  W5AuthorityUnreachableError,
  w5NamedUnreadable,
  w5ReadUnreachable,
  type W5FileReplacement,
  type W5FileRead,
  type W5FileStore,
} from './file-store';
import type { W5StorageAdmission } from './storage-binding';
import type { W5StorageTarget } from './storage-target';

export { W5FileWriteRefusedError } from './commit-log/errors';

/** A caller precondition refused by SQLite, distinct from a file conflict. */
export class W5RevisionConflictError extends Error {
  readonly reason = 'revision-conflict';
  constructor(
    readonly resource: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super('This was changed since it was read. Reload and try again.');
    this.name = 'W5RevisionConflictError';
  }
}

export interface W5ReservationInput {
  /** Exclusive workspace creation claim; worktree reservations omit it. */
  workspaceIdentity?: string;
  /** Validated orphan records may be reclaimed only while both images match. */
  expectedWorkspaceRecords?: {
    manifest: string | null;
    worktrees: string | null;
  };
  reservationId: string;
  operation: string;
  receipt?: NonNullable<W5CommitRequest['receipt']>;
  diagnostics?: unknown;
}

/**
 * The commit-log host calls the store makes. Hosts keep worker construction,
 * startup, shutdown and root selection; this only names the calls.
 */
export interface W5CommitLogHostPort {
  /** The W5 data root the host captures and writes under. */
  readonly root: string;
  /**
   * Views of one host (W5e attributed ports) name the host here, so every
   * store over any of them shares its final-decision queue. Default: itself.
   */
  readonly commitQueueKey?: object;
  recoveryReport(): Promise<W5HostRecoveryReport>;
  commit(request: W5CommitRequest): Promise<W5CommitOutcome>;
  lookupReceipt(
    receipt: NonNullable<W5CommitRequest['receipt']>,
  ): Promise<W5ReceiptLookup>;
  reserve(input: W5ReservationInput): Promise<void>;
  updateReservationDiagnostics(
    reservationId: string,
    diagnostics: WorkspaceCreationDiagnostics,
  ): Promise<void>;
  releaseReservation(reservationId: string): Promise<void>;
  markReservationRecoveryRequired(
    reservationId: string,
    diagnostics: W5ReservationFailureDiagnostics,
  ): Promise<void>;
  /** forCommit bypasses host-side ordinary read batching, when present. */
  revision(resource: W5Resource, forCommit?: boolean): Promise<number>;
  capture(request: W5CaptureRequest): Promise<W5CaptureResult>;
  captureForPreparation?(request: W5CaptureRequest): Promise<W5CaptureResult>;
}

/** One decision a store asked its host for, as its `onApplied` binding sees it. */
export interface W5StoreDecision {
  /** The files it named, with the contents it would write (null removes). */
  readonly files: readonly {
    readonly path: string;
    readonly contents: string | null;
  }[];
  readonly advance: readonly W5Resource[];
  /**
   * The host's outcome, or `failed` when preflight or the call threw;
   * `maybeCommitted` unless the request certainly never became a commit.
   */
  readonly outcome:
    | W5CommitOutcome
    | { readonly status: 'failed'; readonly maybeCommitted: boolean };
}

/** The host's late admission of one checked write its operation did not admit. */
export type W5StorageWriteAdmission = <T>(
  target: W5StorageTarget,
  write: () => Promise<T>,
) => Promise<T>;

export interface W5CommitLogFileStoreBindings {
  /** For hosts without execution-owner exclusion. Never combine both layers. */
  processLock?: W5ProcessFileLock;
  /**
   * Resolved once per recovery attempt. Return the same object for the same
   * host: stores sharing a host share its final-decision queue by identity.
   */
  getHost: () => W5CommitLogHostPort | Promise<W5CommitLogHostPort>;
  warn: (message: string, context: Record<string, unknown>) => void;
  /** Fresh file images from the host-selected disk or record-port reader. */
  readFile: (filePath: string) => Promise<W5FileRead>;
  /** Fresh reads that bypass pending record-port batches for writes. */
  readFileForCommit?: (filePath: string) => Promise<W5FileRead>;
  /** Admits every target a scope staged before its decision. */
  admit: W5StorageAdmission;
  /** Admits an unscoped replace its operation did not admit. */
  admitWrite: W5StorageWriteAdmission;
  /**
   * The per-write ownership check; defaults to the target writer's. A
   * daemon-backed store leaves it to its authority, which checks `daemon`.
   */
  assertWrite?: (target: W5StorageTarget) => void;
  /**
   * Every decision's result, applied or not, reported synchronously before
   * the process lock and final-decision queue release, so a cache sees its
   * own writes before any later decision. A throw is logged, never raised.
   */
  onApplied?: (decision: W5StoreDecision) => void;
}

export interface W5CommitLogFileStore extends W5FileStore {
  withCommit<T>(options: W5CommitOptions, work: () => Promise<T>): Promise<T>;
  lookupReceipt(
    receipt: NonNullable<W5CommitRequest['receipt']>,
  ): Promise<W5ReceiptLookup>;
  reserve(input: W5ReservationInput): Promise<void>;
  readReservations(): Promise<W5Reservation[]>;
  updateReservationDiagnostics(
    reservationId: string,
    diagnostics: WorkspaceCreationDiagnostics,
  ): Promise<void>;
  releaseReservation(reservationId: string): Promise<void>;
  markReservationRecoveryRequired(
    reservationId: string,
    diagnostics: W5ReservationFailureDiagnostics,
  ): Promise<void>;
  readRevisions(
    resources: readonly W5Resource[],
    forCommit?: boolean,
  ): Promise<NonNullable<W5CommitRequest['expectedRevisions']>>;
  captureForPreparation?(
    request: W5CaptureRequest,
  ): Promise<
    | { status: 'captured'; capture: W5CaptureResult; root: string }
    | { status: 'unsupported' }
  >;
  /** One serialized capture after launch recovery, with the root it is under. */
  capture?(
    request: W5CaptureRequest,
  ): Promise<{ capture: W5CaptureResult; root: string }>;
}

export function w5ResourceKey(resource: W5Resource): string {
  // Matches the commit log's key without loading its node:sqlite runtime.
  switch (resource.kind) {
    case 'workspaces':
      return 'workspaces';
    case 'workspace':
      return `workspace:${resource.workspaceId}`;
    case 'worktrees':
      return `worktrees:${resource.workspaceId}`;
    case 'worktree':
      return `worktree:${resource.workspaceId}/${resource.worktreeId}`;
  }
}

// All stores using a host share its final decision queue. The worker itself
// serializes requests; this also keeps the host's preflight in the same order.
const commitQueues = new WeakMap<
  object,
  ReturnType<typeof createSerialQueue>
>();
function commitQueue(
  host: W5CommitLogHostPort,
): ReturnType<typeof createSerialQueue> {
  const key = host.commitQueueKey ?? host;
  const existing = commitQueues.get(key);
  if (existing) return existing;
  const queue = createSerialQueue();
  commitQueues.set(key, queue);
  return queue;
}

/** Runs `task` in `host`'s final-decision queue, which every store on it shares. */
export function runInW5CommitQueue<T>(
  host: W5CommitLogHostPort,
  task: () => Promise<T>,
): Promise<T> {
  return commitQueue(host)(task);
}

/** The queued fingerprint preflight: refuses before any decision. */
export async function preflightW5Files(
  readFile: (filePath: string) => Promise<W5FileRead>,
  files: readonly { path: string; previousFingerprint: string | null }[],
): Promise<void> {
  for (const file of files) {
    const current = await readFile(file.path);
    if (current.state === 'unreadable')
      throw (
        w5NamedUnreadable(current.error) ??
        new WorkspaceConfigUnreadableError(current.error)
      );
    if (
      fingerprintW5File(current.state === 'present' ? current.raw : null) !==
      file.previousFingerprint
    ) {
      throw new W5FileWriteRefusedError(file.path);
    }
  }
}

/** One launch barrier shared by all three repositories using this store. */
export function createW5CommitLogFileStore(
  bindings: W5CommitLogFileStoreBindings,
): W5CommitLogFileStore {
  const { warn, readFile, admit, admitWrite } = bindings;
  const assertWrite =
    bindings.assertWrite ??
    ((target: W5StorageTarget): void =>
      assertStorageWriteAllowed(
        target.namespace,
        target.writer,
        STORAGE_OWNERSHIP,
      ));
  let ready: Promise<W5CommitLogHostPort> | undefined;
  function recover(): Promise<W5CommitLogHostPort> {
    if (ready) return ready;
    const attempt = (async (): Promise<W5CommitLogHostPort> => {
      const host = await bindings.getHost();
      const report = await host.recoveryReport();
      for (const entry of report.abandoned ?? [])
        warn('W5 launch abandoned clean conflict', { ...entry });
      for (const commitId of report.recoveryRequired) {
        const detail = report.recoveryRequiredDetails?.find(
          (entry) => entry.commitId === commitId,
        );
        warn('W5 commit requires recovery', {
          commitId,
          reason: 'file-apply-incomplete',
          ...(detail
            ? {
                diagnostics: {
                  conflictCount: detail.conflictCount,
                  writtenFileCount: detail.writtenFileCount,
                  unexpectedFailure: detail.unexpectedFailure,
                },
              }
            : {}),
        });
      }
      for (const reservationId of report.recoveryRequiredReservations ?? []) {
        const diagnostic = workspaceCreationDiagnosticsSchema.safeParse(
          report.reservations?.find(
            (entry) => entry.reservationId === reservationId,
          )?.diagnostics,
        );
        warn('W5 reservation requires recovery', {
          reservationId,
          reason: 'interrupted-operation',
          ...(diagnostic.success ? { diagnostics: diagnostic.data } : {}),
        });
      }
      return host;
    })();
    ready = attempt;
    // Share each attempt, retaining only successful recovery. A later call
    // can ask the host's replacement worker to recover after startup fails.
    void attempt.catch((): void => {
      if (ready === attempt) ready = undefined;
    });
    return attempt;
  }

  // An unreachable authority may come back restarted, so the next call
  // recovers again and reads that daemon's recovery warnings (CAN-5542).
  // Only the recovery the failed call rode is forgotten, never a newer one.
  const forgetRecoveryIfUnreachable = (
    attempt: Promise<W5CommitLogHostPort> | undefined,
    error: unknown,
  ): void => {
    if (error instanceof W5AuthorityUnreachableError && ready === attempt)
      ready = undefined;
  };
  const readThroughHost = async (
    filePath: string,
    forCommit = false,
  ): Promise<W5FileRead> => {
    const attempt = ready;
    const readSource = forCommit
      ? (bindings.readFileForCommit ?? readFile)
      : readFile;
    const read = await readSource(filePath);
    forgetRecoveryIfUnreachable(attempt, w5ReadUnreachable(read));
    return read;
  };
  async function onHost<T>(
    call: (host: W5CommitLogHostPort) => Promise<T>,
  ): Promise<T> {
    const attempt = recover();
    const host = await attempt;
    try {
      return await call(host);
    } catch (error) {
      forgetRecoveryIfUnreachable(attempt, error);
      throw error;
    }
  }

  // Only final preflight/decision/application is serialized. This queue
  // never acquires repository locks and is never held while work runs.
  async function commitFiles(
    options: W5CommitOptions,
    files: readonly W5ObservedFile[],
    advance: readonly W5Resource[],
  ): Promise<void> {
    if (
      !files.length &&
      !options.expectedRevisions?.length &&
      !options.receipt &&
      !options.reservationId
    )
      return;
    const queuedHost = await recover();
    await commitQueue(queuedHost)(async (): Promise<void> => {
      // A preceding queued commit can invalidate recovery while this scope
      // waits. Finish the replacement worker's recovery before preflight.
      const host = await recover();
      const changes = files.map(({ path, contents, previousRaw }) => ({
        path,
        contents,
        previousFingerprint: fingerprintW5File(previousRaw),
      }));
      const report = (outcome: W5StoreDecision['outcome']): void => {
        if (!bindings.onApplied) return;
        try {
          bindings.onApplied({
            files: changes.map(({ path, contents }) => ({ path, contents })),
            advance,
            outcome,
          });
        } catch (error) {
          warn('W5 decision observer failed', {
            operation: options.operation,
            error,
          });
        }
      };
      const decide = async (): Promise<void> => {
        try {
          await preflightW5Files(
            (path) => readThroughHost(path, true),
            changes,
          );
        } catch (error) {
          report({ status: 'failed', maybeCommitted: false });
          throw error;
        }
        let outcome: W5CommitOutcome;
        let sent = false;
        try {
          options.beforeDecision?.();
          sent = true;
          outcome = await host.commit({
            operation: options.operation,
            receipt: options.receipt,
            reservationId: options.reservationId,
            expectedRevisions: options.expectedRevisions,
            advance,
            files: changes,
            outcome: options.outcome ?? null,
          });
        } catch (error) {
          report({
            status: 'failed',
            maybeCommitted: sent && !(error instanceof W5CommitRefusedError),
          });
          // A failed worker call may have left a durable, unapplied decision.
          // The next read/queued preflight must await recovery again.
          ready = undefined;
          if (
            error instanceof W5CommitRefusedError &&
            error.reason === 'revision-conflict'
          ) {
            const { resource, expected, actual } = error.details;
            if (
              typeof resource === 'string' &&
              typeof expected === 'number' &&
              typeof actual === 'number'
            ) {
              throw new W5RevisionConflictError(resource, expected, actual);
            }
          }
          throw error;
        }
        report(outcome);
        // Returned, not thrown: the worker answered, so recovery stays valid.
        if (outcome.status === 'conflict') {
          if (!isW5CommitOutcome(outcome))
            throw new Error('Invalid W5 conflict outcome');
          const conflict = outcome.conflicts[0];
          if (!conflict) throw new Error('Invalid empty W5 conflict outcome');
          warn('W5 clean apply conflict abandoned', {
            commitId: outcome.commitId,
            operation: options.operation,
            path: conflict.path,
          });
          throw new W5FileWriteRefusedError(conflict.path);
        }
        if (outcome.status === 'recovery-required') {
          throw new W5CommitRefusedError(
            'recovery-required',
            'This change was saved but did not finish and needs recovery.',
            { commitId: outcome.commitId },
          );
        }
      };
      if (bindings.processLock && changes.length)
        await bindings.processLock(
          changes.map((file) => file.path),
          decide,
        );
      else await decide();
    });
  }

  async function fenceLockedFiles(options: W5CommitOptions): Promise<void> {
    if (!options.fenceLockedFiles) return;
    const scope = currentW5CommitScope();
    if (!scope) throw new Error('Missing W5 commit scope');
    for (const { path } of options.locks ?? []) {
      // Nested scopes retain the first observation or staged preimage.
      if (scope.observed.has(path) || scope.files.has(path)) continue;
      const read = await store.read(path);
      if (read.state === 'unreadable')
        throw (
          w5NamedUnreadable(read.error) ??
          new WorkspaceConfigUnreadableError(read.error)
        );
      const raw = read.state === 'present' ? read.raw : null;
      if (!scope.observed.has(path))
        scope.observed.set(path, { path, contents: raw, previousRaw: raw });
    }
  }

  async function stageFile(
    filePath: string,
    contents: string | null,
    storage: W5StorageTarget,
    replacement: W5FileReplacement,
  ): Promise<void> {
    assertWrite(storage);
    await admitWrite(storage, async (): Promise<void> => {
      await recover();
      const files = [
        { path: filePath, contents, previousRaw: replacement.previousRaw },
        ...(replacement.backup ? [replacement.backup] : []),
      ];
      const scope = currentW5CommitScope();
      if (!scope) {
        await commitFiles(
          { operation: replacement.operation },
          files,
          replacement.advance,
        );
        return;
      }
      if (scope.store !== store)
        throw new Error('A W5 scope cannot span stores');
      scope.storage.set(storage.namespace, storage);
      // Preserve the fingerprint of the first read, while subsequent writes
      // read their own staged image. Keep the original rolling backup.
      for (const file of files) {
        const staged = scope.files.get(file.path);
        if (
          staged &&
          fingerprintW5File(staged.contents) !==
            fingerprintW5File(file.previousRaw)
        ) {
          throw new W5FileWriteRefusedError(file.path);
        }
      }
      for (const file of files) {
        const staged = scope.files.get(file.path);
        if (file.path !== filePath) {
          const main = scope.files.get(filePath);
          if (staged || main?.previousRaw === null) continue;
          if (main) file.contents = main.previousRaw ?? file.contents;
        }
        scope.files.set(file.path, {
          ...file,
          previousRaw: staged ? staged.previousRaw : file.previousRaw,
        });
      }
      for (const resource of replacement.advance)
        scope.advance.set(w5ResourceKey(resource), resource);
    });
  }

  const store: W5CommitLogFileStore = {
    withCommit: (options, work) =>
      runW5Commit(
        store,
        options,
        async () => {
          await fenceLockedFiles(options);
          return work();
        },
        (scope) => {
          const files = new Map<string, W5ObservedFile>(scope.observed);
          for (const [path, observed] of Array.from(scope.observed)) {
            const staged = scope.files.get(path);
            if (
              staged &&
              fingerprintW5File(staged.previousRaw) !==
                fingerprintW5File(observed.previousRaw)
            )
              throw new W5FileWriteRefusedError(path);
          }
          scope.files.forEach((file, path) => files.set(path, file));
          return admit(Array.from(scope.storage.values()), () =>
            commitFiles(
              scope.options,
              Array.from(files.values()),
              Array.from(scope.advance.values()),
            ),
          );
        },
      ),
    lookupReceipt: (receipt) => onHost((host) => host.lookupReceipt(receipt)),
    async readReservations() {
      return (await onHost((host) => host.recoveryReport())).reservations ?? [];
    },
    reserve: (input) => onHost((host) => host.reserve(input)),
    updateReservationDiagnostics: (reservationId, diagnostics) =>
      onHost((host) =>
        host.updateReservationDiagnostics(reservationId, diagnostics),
      ),
    releaseReservation: (reservationId) =>
      onHost((host) => host.releaseReservation(reservationId)),
    markReservationRecoveryRequired: (reservationId, diagnostics) =>
      onHost((host) =>
        host.markReservationRecoveryRequired(reservationId, diagnostics),
      ),
    readRevisions: (resources, forCommit = false) =>
      onHost((host) =>
        Promise.all(
          resources.map(async (resource) => ({
            resource,
            revision: await (forCommit
              ? host.revision(resource, true)
              : host.revision(resource)),
          })),
        ),
      ),
    captureForPreparation: (request) =>
      onHost(async (host) =>
        host.captureForPreparation
          ? {
              status: 'captured',
              capture: await host.captureForPreparation(request),
              root: host.root,
            }
          : { status: 'unsupported' },
      ),
    capture: (request) =>
      onHost(async (host) => ({
        capture: await host.capture(request),
        root: host.root,
      })),
    async read(filePath): Promise<W5FileRead> {
      const scope = currentW5CommitScope();
      if (scope && scope.store !== store)
        throw new Error('A W5 scope cannot span stores');
      const staged = scope?.files.get(filePath);
      if (staged)
        return staged.contents === null
          ? { state: 'absent' }
          : { state: 'present', raw: staged.contents };
      try {
        await recover();
      } catch (error) {
        return {
          state: 'unreadable',
          ...(error instanceof Error ? { error } : {}),
        };
      }
      return readThroughHost(filePath, Boolean(scope));
    },
    replace: stageFile,
    remove: (filePath, storage, removal) =>
      stageFile(filePath, null, storage, removal),
  };
  return store;
}
