import {
  isW5ProjectionOnlyView,
  readW5FallbackFile,
  withoutW5Projection,
} from './w5-fallback-read';
import { AsyncLocalStorage } from 'node:async_hooks';
import { relative, resolve, sep } from 'node:path';
import type {
  W5CaptureFile,
  W5CaptureResult,
} from '../w5-commit-log/commit-log-worker-contract';
import type { W5FileRead } from './w5-file-store';
import { logMainProcessWarn } from './main-process-logging';
import { recordW5Work } from '@canopy/desktop-shared/node/work-counters';
import { W5_AGGREGATE_KEYS } from './w5-work-counters';

/*
 * A request-local view that serves one query's W5 reads from a single
 * worker capture (CAN-5318). It is a consistent worker-log position, not
 * filesystem snapshot isolation: CLI writes are not excluded, so captured
 * images carry eligibility evidence instead of being trusted as canonical.
 */

/** Why a query's W5 reads were not served from one capture. */
export type W5ReadViewUncapturedReason =
  /** A host OS without handle-confined capture reads. */
  | 'unsupported-platform'
  /** Windows whose owned-child addon, which confines capture reads, did not load. */
  | 'confinement-unavailable'
  /**
   * Windows data root that no longer resolves to the path the host anchored,
   * as after an ancestor swap; every W5 read fails closed.
   */
  | 'root-changed'
  | 'capture-limit'
  /** A workspace id the capture cannot name, such as a reserved device name. */
  | 'unsupported-id'
  /** Index bytes that are not UTF-8, which discovery refuses to follow. */
  | 'undecodable-index'
  /** An injected test store has no worker to capture through. */
  | 'direct-store'
  /** A mutation scope keeps its staged reads. */
  | 'mutation-scope'
  /** The flip launch's daemon handoff failed: reads fall back to the files. */
  | 'handoff-degraded'
  /**
   * The data root did not resolve, as while an ancestor is swapped or the
   * root is removed; every W5 read fails closed.
   */
  | 'root-unavailable'
  /** The capture itself failed; every W5 read fails closed. */
  | 'capture-failed'
  /** Projection-only disk read while the W5 authority is unreachable. */
  | 'daemon-unavailable';

/** Whether a query uncaptured for `reason` fails its W5 reads closed instead of reading live. */
export function failsW5ReadsClosed(
  reason: W5ReadViewUncapturedReason,
): boolean {
  // `confinement-unavailable` deliberately reads live, as Windows did before
  // CAN-5202: only a missing or broken addon causes it, never a path swap, and
  // failing it closed would turn a packaging defect into every query failing.
  return (
    reason === 'capture-failed' ||
    reason === 'root-unavailable' ||
    reason === 'root-changed'
  );
}

export type W5ReadViewOutcome =
  | {
      readonly status: 'captured';
      readonly capture: W5CaptureResult;
      /** Reads of W5 files the capture lacked; each failed closed. */
      readonly uncapturedReads: readonly W5CaptureFile[];
    }
  | {
      readonly status: 'uncaptured';
      readonly reason: W5ReadViewUncapturedReason;
      /** Query adapters must propagate authority loss, never project absence. */
      readonly error?: Error;
    };

/** An open query read view refuses every W5 write and commit scope. */
export class W5ReadViewWriteRefusedError extends Error {
  constructor() {
    super("Projects can't be changed while they're being read.");
    this.name = 'W5ReadViewWriteRefusedError';
  }
}

interface ActiveReadView {
  /** Undefined while reads pass through to the store (uncaptured, not failed). */
  read?: (path: string) => W5FileRead;
  closed: boolean;
  deferred: (() => Promise<unknown>)[];
}

const context = new AsyncLocalStorage<ActiveReadView>();

/**
 * The current open view. A finished view is inert, so timers a query started
 * read and write as they would outside it.
 */
function currentView(): ActiveReadView | undefined {
  const view = context.getStore();
  return view && !view.closed ? view : undefined;
}

/** The captured read, or undefined to read through the store. */
export function readFromW5ReadView(
  path: string,
): W5FileRead | Promise<W5FileRead> | undefined {
  return readW5FallbackFile(path) ?? currentView()?.read?.(path);
}

export function assertOutsideW5ReadView(): void {
  if (currentView() || isW5ProjectionOnlyView())
    throw new W5ReadViewWriteRefusedError();
}

/**
 * Inside an open view, queues a write a read decided on to run, in order and
 * outside the view, once it closes, and returns true. Projection-only views
 * drop the write instead. Outside a view, false.
 */
export function deferUntilW5ReadViewCloses(
  write: () => Promise<unknown>,
): boolean {
  if (isW5ProjectionOnlyView()) return true;
  const view = currentView();
  view?.deferred.push(write);
  return view !== undefined;
}

function captureFileForPath(
  root: string,
  path: string,
): W5CaptureFile | undefined {
  const parts = relative(resolve(root), resolve(path)).split(sep);
  if (parts.length === 1) {
    if (parts[0] === 'index.json') return { kind: 'index' };
    if (parts[0] === 'index.json.bak') return { kind: 'index-backup' };
    return undefined;
  }
  const [workspaceId, name] = parts;
  // Any workspace's file maps, so a miss is recorded whatever its id.
  if (parts.length !== 2 || !workspaceId || workspaceId === '..')
    return undefined;
  if (name === 'workspace.json') return { kind: 'manifest', workspaceId };
  if (name === 'worktrees.json') return { kind: 'worktrees', workspaceId };
  return undefined;
}

function sameFile(left: W5CaptureFile, right: W5CaptureFile): boolean {
  return (
    left.kind === right.kind &&
    ('workspaceId' in left ? left.workspaceId : null) ===
      ('workspaceId' in right ? right.workspaceId : null)
  );
}

function notCaptured(): W5FileRead {
  return {
    state: 'unreadable',
    error: new Error('This project file was not part of the read.'),
  };
}

/**
 * Serves `work`'s W5 reads from `capture` under `root`, refusing writes.
 * `work` receives the outcome, whose uncaptured reads grow as it reads.
 */
export function runInW5CapturedView<T>(
  capture: W5CaptureResult,
  root: string,
  work: (view: W5ReadViewOutcome) => Promise<T>,
): Promise<T> {
  const uncapturedReads: W5CaptureFile[] = [];
  const view: ActiveReadView = {
    closed: false,
    deferred: [],
    read: (path): W5FileRead => {
      const file = captureFileForPath(root, path);
      const image = file
        ? capture.files.find((entry) => sameFile(entry, file))
        : undefined;
      if (!file || !image) {
        if (file && !uncapturedReads.some((entry) => sameFile(entry, file)))
          uncapturedReads.push(file);
        return notCaptured();
      }
      if (image.state === 'present') {
        const bytes = Buffer.from(image.base64, 'base64');
        recordW5Work(W5_AGGREGATE_KEYS.viewDecodedBytes, bytes.byteLength);
        // The store's own `utf8` decoding, so normalization sees the same text.
        return { state: 'present', raw: bytes.toString('utf8') };
      }
      return image.state === 'absent'
        ? { state: 'absent' }
        : {
            state: 'unreadable',
            error: new Error(
              `This project file could not be read (${image.reason}).`,
            ),
          };
    },
  };
  return runInView(view, () =>
    work({ status: 'captured', capture, uncapturedReads }),
  );
}

/** Runs `work` refusing writes; reads pass through, or all fail closed. */
export function runInW5UncapturedView<T>(
  reason: W5ReadViewUncapturedReason,
  work: (view: W5ReadViewOutcome) => Promise<T>,
  error?: Error,
): Promise<T> {
  const view: ActiveReadView = {
    closed: false,
    deferred: [],
    ...(failsW5ReadsClosed(reason)
      ? {
          read: (): W5FileRead =>
            error ? { state: 'unreadable', error } : notCaptured(),
        }
      : {}),
  };
  return runInView(view, () =>
    work({ status: 'uncaptured', reason, ...(error ? { error } : {}) }),
  );
}

async function runInView<T>(
  view: ActiveReadView,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await withoutW5Projection(() => context.run(view, work));
  } finally {
    view.closed = true;
    // Before the query returns, as the write it replaces did.
    for (const write of view.deferred)
      if (!deferUntilW5ReadViewCloses(write))
        await write().catch((error: unknown) => {
          logMainProcessWarn('A write deferred past a W5 query failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
  }
}
