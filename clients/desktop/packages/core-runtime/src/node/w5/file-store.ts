import { isNativeError } from 'node:util/types';
import type { CanopyRetryDirective } from '@canopy/protocol/canopy-core';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { W5Resource } from './commit-log';
import type { W5CaptureFile } from './commit-log/capture-contract';
import type { W5StorageTarget } from './storage-target';

export interface W5FileReplacement {
  operation: string;
  advance: readonly W5Resource[];
  /** Exact text read inside the repository queue/lock; null means absent. */
  previousRaw: string | null;
  /** The rolling index backup belongs to the same decision, without revisions. */
  backup?: { path: string; contents: string; previousRaw: string | null };
}

export type W5FileRemoval = Pick<
  W5FileReplacement,
  'operation' | 'advance' | 'previousRaw'
>;

/** One read of a W5 file: missing, its contents, or a read that failed. */
export type W5FileRead =
  | { state: 'absent' }
  | { state: 'present'; raw: string }
  | { state: 'unreadable'; error?: Error };

/**
 * The two capture classes the daemon record port cannot serve, so their
 * files read unreadable and fail closed (CAN-5498 debt, CAN-5531).
 */
export type W5RecordUnservedReason = 'unsupported-id' | 'limit-exceeded';

const UNSERVED_SUBJECTS: Readonly<Record<W5CaptureFile['kind'], string>> = {
  index: 'the project list',
  'index-backup': 'the project list',
  manifest: "this project's settings",
  worktrees: "this project's worktree list",
};

const UNSERVED_REASONS: Readonly<Record<W5RecordUnservedReason, string>> = {
  'unsupported-id': "The project's ID isn't supported.",
  'limit-exceeded': "It's too large to read.",
};

/** Why a read over the daemon record port is unreadable, by class and file. */
export class W5RecordUnservedError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause?: unknown;
  constructor(
    readonly reason: W5RecordUnservedReason,
    kind: W5CaptureFile['kind'],
    cause?: unknown,
  ) {
    super(
      `Couldn't read ${UNSERVED_SUBJECTS[kind]}. ${UNSERVED_REASONS[reason]}`,
    );
    this.name = 'W5RecordUnservedError';
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        configurable: true,
      });
  }
}

/** A live authority refused an unsent call; not an edit conflict or authority loss. */
export class W5RecordOverloadedError extends Error {
  declare readonly cause?: unknown;
  constructor(
    readonly kind: 'resource_exhausted' | 'unavailable',
    readonly retry: CanopyRetryDirective,
    cause?: unknown,
  ) {
    super('Project records are busy. Try again shortly.');
    this.name = 'W5RecordOverloadedError';
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', {
        value: cause,
        configurable: true,
      });
  }
}

/**
 * Whether a call that could not reach the W5 authority was sent: `refused`
 * when it certainly was not (or was a query), `outcome-unknown` when an
 * instruction was in flight as the connection dropped.
 */
export type W5AuthorityUnreachableCertainty = 'refused' | 'outcome-unknown';

/**
 * Why the W5 authority could not be reached (CAN-5542): no session could be
 * opened (`connect`), the session dropped (`lost`), reconnecting is held
 * (`held`), or the reached daemon serves no W5 records (`w5_host_unavailable`).
 */
export type W5AuthorityUnreachableReason =
  | 'connect'
  | 'lost'
  | 'held'
  | 'w5_host_unavailable';

const UNREACHABLE_MESSAGES: Readonly<
  Record<W5AuthorityUnreachableCertainty, string>
> = {
  refused:
    "Couldn't save this change because the background service isn't running. Reconnect from the notice, then try again.",
  'outcome-unknown':
    'This change may not have saved. The background service stopped before it confirmed. Reconnect, check the project, then try again.',
};

/**
 * A read-only surface's copy for an unreachable authority: the error's own
 * message is a save's refusal, which a read must never show.
 */
export const W5_UNREACHABLE_READ_MESSAGE =
  "Couldn't load this because the background service isn't running. Reconnect from the notice, then try again.";

/*
 * `w5_host_unavailable`: the service runs and answers but serves no project
 * records, and no notice shows for it yet (GB4 plan §13 ask ii), so the copy
 * neither says it isn't running nor points at the notice. Restarting the app
 * is the one step that changes which service it attaches to.
 */
const HOSTLESS_SAVE_MESSAGE =
  "Couldn't save this change because the background service can't save projects. Restart the app, then try again.";
/** {@link W5_UNREACHABLE_READ_MESSAGE} for `w5_host_unavailable`. */
export const W5_HOSTLESS_READ_MESSAGE =
  "Couldn't load this because the background service can't load projects. Restart the app, then try again.";

/** The copy a read-only surface shows for `error` instead of its message. */
export function w5UnreachableReadMessage(
  error: W5AuthorityUnreachableError,
): string {
  return error.reason === 'w5_host_unavailable' && error.certainty === 'refused'
    ? W5_HOSTLESS_READ_MESSAGE
    : W5_UNREACHABLE_READ_MESSAGE;
}

/**
 * A daemon-backed W5 call that never reached a live authority, as opposed to
 * a typed refusal from one. Never retried: a refused call stays refused until
 * the service is back, and an unknown outcome must not be decided twice.
 */
export class W5AuthorityUnreachableError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause?: unknown;
  constructor(
    readonly certainty: W5AuthorityUnreachableCertainty,
    readonly reason: W5AuthorityUnreachableReason,
    cause?: unknown,
  ) {
    // An instruction that may have saved says so, whatever the reason.
    super(
      certainty === 'refused' && reason === 'w5_host_unavailable'
        ? HOSTLESS_SAVE_MESSAGE
        : UNREACHABLE_MESSAGES[certainty],
    );
    this.name = 'W5AuthorityUnreachableError';
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        configurable: true,
      });
  }
}

/** Whether an unreadable-file refusal stops a write or answers a read. */
export type W5UnreadableUse = 'write' | 'read';

/**
 * An unreadable-file refusal's message: `cause`'s when it names its class,
 * except that a read never shows an unreachable authority's save copy.
 */
export function w5UnreadableMessage(
  fallback: string,
  cause: unknown,
  use: W5UnreadableUse = 'write',
): string {
  if (use === 'read' && cause instanceof W5AuthorityUnreachableError)
    return w5UnreachableReadMessage(cause);
  return w5NamedUnreadable(cause)?.message ?? fallback;
}

/**
 * The named reason a record read was unreadable, carried as `unserved` so
 * refusals use its message: a class the record port can't serve (CAN-5531),
 * an authority it couldn't reach (CAN-5542), or a live overload (CAN-5577).
 * A read-only surface takes its copy from {@link w5UnreadableMessage} with
 * `'read'`, never `message`.
 */
export type W5NamedUnreadableError =
  | W5RecordUnservedError
  | W5RecordOverloadedError
  | W5AuthorityUnreachableError;

/** `error` when it names why its read was unreadable. */
export function w5NamedUnreadable(
  error: unknown,
): W5NamedUnreadableError | undefined {
  return error instanceof W5RecordUnservedError ||
    error instanceof W5RecordOverloadedError ||
    error instanceof W5AuthorityUnreachableError
    ? error
    : undefined;
}

/** The authority-unreachable failure a read carries, if it carries one. */
export function w5ReadUnreachable(
  read: W5FileRead,
): W5AuthorityUnreachableError | undefined {
  return read.state === 'unreadable' &&
    read.error instanceof W5AuthorityUnreachableError
    ? read.error
    : undefined;
}

/**
 * Whether a persisted-file read can prove absence: `ok` and `absent` (no
 * file) are authoritative states; `unreadable` (I/O error other than
 * ENOENT, invalid JSON, unexpected shape or version) is not. A host's plain
 * readers fall back to empty defaults in every case so the app keeps
 * working; callers that turn absence into a destructive action must use
 * its detailed readers and respect the authority they report.
 */
export type PersistedFileAuthority = 'ok' | 'absent' | 'unreadable';

/**
 * The storage the W5 repositories read and replace their files through
 * (CAN-3800). Production commits through the CAN-3805 worker;
 * tests inject read and write faults.
 */
export interface W5FileStore {
  read(filePath: string): Promise<W5FileRead>;
  remove(
    filePath: string,
    storage: W5StorageTarget,
    removal: W5FileRemoval,
  ): Promise<void>;
  /**
   * Commits the replacement once storage admits it, then atomically installs
   * each file before resolving. Injected direct stores retain atomic replace.
   */
  replace(
    filePath: string,
    contents: string,
    storage: W5StorageTarget,
    replacement: W5FileReplacement,
  ): Promise<void>;
}

/**
 * The host's checked atomic replace. Direct stores pass no `durable` option,
 * so they keep the host writer's default durability.
 */
export type W5AtomicFileWriter = (
  filePath: string,
  contents: string,
  options: { encoding: 'utf8'; storage: W5StorageTarget },
) => Promise<void>;

function errorCode(error: unknown): unknown {
  try {
    return typeof error === 'object' && error !== null
      ? Reflect.get(error, 'code')
      : undefined;
  } catch {
    return undefined;
  }
}

/** One direct Node read of a W5 file, outside the commit log. */
export async function readNodeW5File(filePath: string): Promise<W5FileRead> {
  try {
    return { state: 'present', raw: await readFile(filePath, 'utf8') };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { state: 'absent' };
    const failure = isNativeError(error)
      ? error
      : new Error('The W5 file could not be read.');
    if (failure !== error)
      Object.defineProperty(failure, 'cause', {
        value: error,
        configurable: true,
        writable: true,
      });
    return { state: 'unreadable', error: failure };
  }
}

/** A direct store over Node reads and the host's atomic writer. */
export function createNodeW5FileStore(
  writeFileAtomically: W5AtomicFileWriter,
): W5FileStore {
  return {
    read: (filePath: string): Promise<W5FileRead> => readNodeW5File(filePath),
    async remove(filePath): Promise<void> {
      await rm(filePath, { force: true });
    },
    async replace(
      filePath: string,
      contents: string,
      storage: W5StorageTarget,
      replacement: W5FileReplacement,
    ): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      if (replacement.backup) {
        await writeFileAtomically(
          replacement.backup.path,
          replacement.backup.contents,
          {
            encoding: 'utf8',
            storage,
          },
        );
      }
      await writeFileAtomically(filePath, contents, {
        encoding: 'utf8',
        storage,
      });
    },
  };
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `next` plus every field of `previous` outside `knownKeys`. A W5 write keeps
 * data this version does not know, such as a field a newer app added, while
 * a known field `next` leaves undefined stays cleared.
 */
export function withUnknownFields(
  next: object,
  previous: Record<string, unknown> | undefined,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...next };
  if (previous === undefined) return merged;
  for (const [key, value] of Object.entries(previous)) {
    if (
      !knownKeys.has(key) &&
      !Object.prototype.hasOwnProperty.call(merged, key)
    ) {
      merged[key] = value;
    }
  }
  return merged;
}

/** A serial queue: each task starts after every earlier one settles. */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.then(
      (): void => undefined,
      (): void => undefined,
    );
    return run;
  };
}

export class WorkspaceConfigUnreadableError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause?: unknown;
  constructor(cause?: unknown, use?: W5UnreadableUse) {
    super(
      w5UnreadableMessage(
        "This project's settings could not be read, so they were not changed. Try again.",
        cause,
        use,
      ),
    );
    this.name = 'WorkspaceConfigUnreadableError';
    if (cause !== undefined)
      Object.defineProperty(this, 'cause', {
        value: cause,
        writable: true,
        configurable: true,
      });
  }
}
