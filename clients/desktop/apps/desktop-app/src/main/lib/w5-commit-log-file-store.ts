import type { W5RecordImageStore } from '@canopy/core-runtime/node/w5/record-image-repositories';
import {
  W5AuthorityUnreachableError,
  w5NamedUnreadable,
  type W5NamedUnreadableError,
} from '@canopy/core-runtime/node/w5/file-store';
import {
  allowsW5ProjectionOnlyRead,
  runW5FallbackRead,
} from './w5-fallback-read';
import { isUtf8 } from 'node:buffer';
import type {
  W5CommitRequest,
  W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import {
  createW5CommitLogFileStore as createCoreW5CommitLogFileStore,
  type W5CommitLogFileStore,
  type W5CommitLogHostPort,
} from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { recordW5Work } from '@canopy/desktop-shared/node/work-counters';
import { admitW5Storage } from './w5-storage';
import { currentW5CommitScope, type W5CommitOptions } from './w5-commit-scope';
import { logMainProcessWarn } from './main-process-logging';
import { markE2eStartup } from './e2e-startup-marks';
import { admitStorageWrite } from '@canopy/execution-engine/node/lib/storage-admission';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { readWorkspaceIndex } from '@canopy/core-runtime/node';
import { w5RecordFileClass } from './w5-work-counters';
import {
  isW5CaptureWorkspaceId,
  type W5CaptureRequest,
  type W5CaptureResult,
} from '../w5-commit-log/commit-log-worker-contract';
import {
  assertOutsideW5ReadView,
  failsW5ReadsClosed,
  readFromW5ReadView,
  runInW5CapturedView,
  runInW5UncapturedView,
  type W5ReadViewOutcome,
  type W5ReadViewUncapturedReason,
} from './w5-read-view';
import { nodeW5FileStore, type W5FileStore } from './w5-file-store';
import {
  createW5DegradedStore,
  W5DaemonHandoffError,
} from './w5-handoff-store';
import { noteW5CommitScopeOpened } from './w5-pre-effect-retry';

export {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
  w5ResourceKey,
  type W5CommitLogFileStore,
} from '@canopy/core-runtime/node/w5/commit-log-file-store';

/**
 * The core store bound to desktop main's logger, direct reads and storage
 * admission. Each binding resolves at call time, so test spies still intercept.
 */
export function createW5CommitLogFileStore(
  getHost: () => W5CommitLogHostPort | Promise<W5CommitLogHostPort>,
): W5CommitLogFileStore {
  return createCoreW5CommitLogFileStore({
    getHost,
    warn: (message, context) => logMainProcessWarn(message, context),
    readFile: (filePath) => {
      recordW5Work('read.backend.direct');
      return nodeW5FileStore.read(filePath);
    },
    admit: (targets, operation) => admitW5Storage(targets, operation),
    admitWrite: (target, write) => admitStorageWrite(target, write),
  });
}

let firstReadServed = false;

/** E2E startup mark for the first W5 read either store served. */
function noteW5ReadServed(): void {
  if (firstReadServed) return;
  firstReadServed = true;
  markE2eStartup('w5FirstReadServed');
}

let testStore: W5FileStore | undefined;
let installedStore: W5CommitLogFileStore | undefined;

/** Explicit test injection; production never falls back to direct writes. */
export function __setDesktopW5FileStoreForTests(
  store: W5FileStore | undefined,
): void {
  testStore = store;
}

/**
 * TRANSITIONAL (CAN-5543, GB12): the production slot the flip launch fills
 * before any W5 call, replacing the in-process store for the process's life.
 * Remove at W15 with the in-process store.
 */
export function installDesktopW5FileStore(store: W5CommitLogFileStore): void {
  installedStore = store;
}

const uninitializedDaemonStore = createW5DegradedStore(
  new W5DaemonHandoffError('daemon_unavailable', 'handoff-not-started'),
);

const currentStore = (): W5FileStore =>
  testStore ??
  installedStore ??
  // Import-time and failed-startup callers get only degraded reads, never a local writer.
  uninitializedDaemonStore;

export const desktopW5FileStore: W5RecordImageStore = {
  withCommit: (options, work) => withW5Commit(options, work),
  read: async (path) => {
    const captured = readFromW5ReadView(path);
    recordW5Work(
      `read.${w5RecordFileClass(path)}.${captured ? 'view' : 'store'}`,
    );
    const read = await (captured ?? currentStore().read(path));
    if (read.state !== 'unreadable') noteW5ReadServed();
    return read;
  },
  remove: async (path, storage, removal) => {
    assertOutsideW5ReadView();
    await currentStore().remove(path, storage, removal);
  },
  replace: async (path, contents, storage, replacement) => {
    assertOutsideW5ReadView();
    recordW5Work(`replace.${w5RecordFileClass(path)}`);
    await currentStore().replace(path, contents, storage, replacement);
  },
};

export type { W5CommitOptions } from './w5-commit-scope';

function isCommitLogStore(store: W5FileStore): store is W5CommitLogFileStore {
  return (
    'withCommit' in store &&
    typeof store.withCommit === 'function' &&
    'readRevisions' in store &&
    typeof store.readRevisions === 'function'
  );
}

/** Existing Jest direct stores retain their explicit injection; production always stages. */
export async function withW5Commit<T>(
  options: W5CommitOptions,
  work: () => Promise<T>,
): Promise<T> {
  assertOutsideW5ReadView();
  // A scope's work may run effects, so an enclosing unit never reruns it.
  noteW5CommitScopeOpened();
  const store = currentStore();
  return isCommitLogStore(store) ? store.withCommit(options, work) : work();
}

function captureRefusal(error: unknown): W5ReadViewUncapturedReason {
  if (error instanceof W5DaemonHandoffError) return 'handoff-degraded';
  if (
    error instanceof W5CommitRefusedError &&
    error.reason === 'invalid-state'
  ) {
    const reason = error.details.capture;
    if (
      reason === 'unsupported-platform' ||
      reason === 'confinement-unavailable' ||
      reason === 'root-changed' ||
      reason === 'root-unavailable'
    )
      return reason;
    if (reason === 'limit-exceeded') return 'capture-limit';
  }
  return 'capture-failed';
}

const loggedLiveReasons = new Set<W5ReadViewUncapturedReason>();

/** Runs `work` in an uncaptured view, counted by its reason. */
function runUncaptured<T>(
  reason: W5ReadViewUncapturedReason,
  work: (view: W5ReadViewOutcome) => Promise<T>,
  error?: Error,
): Promise<T> {
  recordW5Work(`readView.uncaptured.${reason}`);
  return runInW5UncapturedView(reason, work, error);
}

/** A query the capture cannot serve reads live, recorded in its outcome and logged once. */
function runLive<T>(
  reason: W5ReadViewUncapturedReason,
  work: (view: W5ReadViewOutcome) => Promise<T>,
): Promise<T> {
  if (!loggedLiveReasons.has(reason)) {
    loggedLiveReasons.add(reason);
    logMainProcessWarn('W5 query reads are not captured', { reason });
  }
  return runUncaptured(reason, work);
}

/**
 * Runs one query's W5 reads over one worker capture of `request`. Writes
 * are refused. Where capture is unsupported, over its limits, or cannot name
 * a workspace or decode the index naming it, the whole query reads live and
 * the outcome says so; a failed capture, or a data root that did not
 * resolve or no longer resolves to its anchored path, fails every read
 * closed. Inside a mutation scope, its staged
 * reads apply unchanged.
 */
export async function runW5ReadView<T>(
  request: W5CaptureRequest,
  work: (view: W5ReadViewOutcome) => Promise<T>,
): Promise<T> {
  if (currentW5CommitScope()) {
    recordW5Work('readView.uncaptured.mutation-scope');
    return work({ status: 'uncaptured', reason: 'mutation-scope' });
  }
  const store = currentStore();
  if (!isCommitLogStore(store) || !store.capture)
    return runUncaptured('direct-store', work);
  if (
    !request.files.every(
      (file) =>
        !('workspaceId' in file) || isW5CaptureWorkspaceId(file.workspaceId),
    )
  )
    return runLive('unsupported-id', work);
  let captured: { capture: W5CaptureResult; root: string };
  try {
    captured = await store.capture(request);
  } catch (error) {
    if (error instanceof W5AuthorityUnreachableError) {
      if (allowsW5ProjectionOnlyRead()) return runW5FallbackRead(work);
      return runInW5UncapturedView('capture-failed', work, error);
    }
    const reason = captureRefusal(error);
    if (!failsW5ReadsClosed(reason)) return runLive(reason, work);
    logMainProcessWarn('W5 query capture failed; its reads fail closed', {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return runUncaptured(
      reason,
      work,
      error instanceof Error ? error : undefined,
    );
  }
  const skipped = discoverySkippedReads(captured.capture);
  if (skipped) return runLive(skipped, work);
  recordW5Work('readView.captured');
  noteW5ReadServed();
  return runInW5CapturedView(captured.capture, captured.root, work);
}

/**
 * Why discovery left out files of a workspace the query's index will name:
 * one it cannot name, or every one behind bytes it will not decode.
 */
function discoverySkippedReads(
  capture: W5CaptureResult,
): W5ReadViewUncapturedReason | undefined {
  if (capture.discovery !== 'invalid-index') return undefined;
  const index = capture.files.find((file) => file.kind === 'index');
  if (index?.state !== 'present') return undefined;
  const bytes = Buffer.from(index.base64, 'base64');
  // The repositories' own lenient decoding, as the captured view serves it.
  const { entries } = readWorkspaceIndex(
    { state: 'present', raw: bytes.toString('utf8') },
    () => undefined,
  );
  const captured = (
    kind: 'manifest' | 'worktrees',
    workspaceId: string,
  ): boolean =>
    capture.files.some(
      (file) =>
        file.kind === kind &&
        'workspaceId' in file &&
        file.workspaceId === workspaceId,
    );
  if (
    entries.every(
      (entry) =>
        captured('manifest', entry.id) && captured('worktrees', entry.id),
    )
  )
    return undefined;
  return isUtf8(bytes) ? 'unsupported-id' : 'undecodable-index';
}

export type W5PreparationFallbackReason =
  | 'mutation-scope'
  | 'direct-store'
  | 'preparation-unsupported'
  | 'unsupported-id'
  | 'unsupported-platform'
  | 'confinement-unavailable'
  | 'handoff-degraded'
  | 'capture-limit'
  | 'undecodable-index';

export type W5MetadataCaptureOutcome =
  | { status: 'captured'; capture: W5CaptureResult }
  | {
      status: 'failed-closed';
      reason: 'root-changed' | 'root-unavailable' | 'capture-failed';
      cause: unknown;
      readError?: Error;
      named?: W5NamedUnreadableError;
    };

export type W5PreparationBinding =
  | { status: 'fallback'; reason: W5PreparationFallbackReason; cause?: unknown }
  | {
      status: 'prepared';
      outcome: W5MetadataCaptureOutcome;
      bind<T>(work: () => Promise<T>): Promise<T>;
    };

/** Capture admission ends before this short, decoder-only binding can be used. */
export async function prepareW5ReadBinding(
  request: W5CaptureRequest,
): Promise<W5PreparationBinding> {
  if (currentW5CommitScope())
    return { status: 'fallback', reason: 'mutation-scope' };
  const store = currentStore();
  if (!isCommitLogStore(store))
    return { status: 'fallback', reason: 'direct-store' };
  if (!store.captureForPreparation)
    return { status: 'fallback', reason: 'preparation-unsupported' };
  if (
    !request.files.every(
      (file) =>
        !('workspaceId' in file) || isW5CaptureWorkspaceId(file.workspaceId),
    )
  )
    return { status: 'fallback', reason: 'unsupported-id' };
  try {
    const result = await store.captureForPreparation(request);
    if (result.status === 'unsupported')
      return { status: 'fallback', reason: 'preparation-unsupported' };
    const skipped = discoverySkippedReads(result.capture);
    if (skipped === 'unsupported-id' || skipped === 'undecodable-index')
      return { status: 'fallback', reason: skipped };
    return {
      status: 'prepared',
      outcome: { status: 'captured', capture: result.capture },
      bind: (work) => runInW5CapturedView(result.capture, result.root, work),
    };
  } catch (cause) {
    const reason = captureRefusal(cause);
    if (
      reason === 'unsupported-platform' ||
      reason === 'confinement-unavailable' ||
      reason === 'handoff-degraded' ||
      reason === 'capture-limit'
    )
      return { status: 'fallback', reason, cause };
    const failedReason =
      reason === 'root-changed' || reason === 'root-unavailable'
        ? reason
        : 'capture-failed';
    const readError = cause instanceof Error ? cause : undefined;
    const named = w5NamedUnreadable(cause);
    return {
      status: 'prepared',
      outcome: {
        status: 'failed-closed',
        reason: failedReason,
        cause,
        ...(readError ? { readError } : {}),
        ...(named ? { named } : {}),
      },
      bind: (work) => runInW5UncapturedView(failedReason, work, readError),
    };
  }
}

/** Current revisions through the recovered worker, for a later edit's preconditions. */
export function readW5Revisions(
  resources: readonly W5Resource[],
  forCommit?: boolean,
): Promise<NonNullable<W5CommitRequest['expectedRevisions']>> {
  const store = currentStore();
  if (!isCommitLogStore(store))
    throw new Error('Revision reads require the W5 commit log store');
  return forCommit
    ? store.readRevisions(resources, true)
    : store.readRevisions(resources);
}

/** Keyed admission never acquires repository leases or the final decision queue. */
export function getW5ReceiptStore(): Pick<
  W5CommitLogFileStore,
  | 'lookupReceipt'
  | 'reserve'
  | 'releaseReservation'
  | 'markReservationRecoveryRequired'
> {
  const store = currentStore();
  if (!isCommitLogStore(store))
    throw new Error('Keyed changes require the W5 commit log store');
  return store;
}

/** Only explicitly injected legacy test stores bypass identity reservations. */
export function getW5IdentityStore(): W5CommitLogFileStore | undefined {
  const store = currentStore();
  return isCommitLogStore(store) ? store : undefined;
}
