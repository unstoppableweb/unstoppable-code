import { CanopyClientError } from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import { IdentifierValidationError } from '@canopy/core-runtime/node/identifiers';
import {
  W5AuthorityUnreachableError,
  W5RecordOverloadedError,
} from '@canopy/core-runtime/node/w5/file-store';
import { WorkspaceMetadataRefusedError } from '@canopy/core-runtime/node/w5/workspace-metadata/metadata';
import { WorkspaceIndexUnreadableError } from '@canopy/core-runtime/node/w5/workspace-index-repository';
import type { AppError } from '@canopy/protocol/app-errors';
import type { IpcOperationFailure } from '@canopy/desktop-shared/ipc/app-error-rejection';
import {
  ProjectsReloadRequiredError,
  SidebarItemsInvalidError,
} from '../lib/sidebar-save-errors';
import { W5DaemonHandoffError } from '../lib/w5-handoff-store';
import type { AppDiagnosticRecord } from '../observability/service';
import {
  allowlistedErrorCode,
  isStandardErrorName,
} from '../observability/telemetry-error-details';
import { ipcErrorChain } from './error-chain';

/**
 * A class the record may name. Package classes and the handoff error match by
 * `instanceof`; desktop `lib/` classes whose modules can reach `ipc/` match by
 * exact class name instead, so this module adds no import cycle.
 */
type NamedClass = {
  readonly name: string;
  readonly matches: (value: unknown) => boolean;
};

const byName =
  (name: string) =>
  (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null) return false;
    if (Reflect.get(value, 'name') === name) return true;
    const prototype: unknown = Reflect.getPrototypeOf(value);
    const constructor: unknown =
      typeof prototype === 'object' && prototype !== null
        ? Reflect.get(prototype, 'constructor')
        : undefined;
    return (
      typeof constructor === 'function' &&
      Reflect.get(constructor, 'name') === name
    );
  };

const byClass =
  (type: abstract new (...args: never[]) => unknown) =>
  (value: unknown): boolean =>
    value instanceof type;

/** In precedence order: the first specific class anywhere in the chain wins. */
const SPECIFIC_CLASSES: readonly NamedClass[] = [
  { name: 'W5DaemonHandoffError', matches: byClass(W5DaemonHandoffError) },
  {
    name: 'W5AuthorityUnreachableError',
    matches: byClass(W5AuthorityUnreachableError),
  },
  {
    name: 'W5RecordOverloadedError',
    matches: byClass(W5RecordOverloadedError),
  },
  {
    name: 'ProjectsReloadRequiredError',
    matches: byClass(ProjectsReloadRequiredError),
  },
  {
    name: 'SidebarItemsInvalidError',
    matches: byClass(SidebarItemsInvalidError),
  },
  {
    name: 'SidebarSaveRefusedError',
    matches: byName('SidebarSaveRefusedError'),
  },
  {
    name: 'WorkspaceMetadataRefusedError',
    matches: byClass(WorkspaceMetadataRefusedError),
  },
  {
    name: 'WorktreeUpdateRefusedError',
    matches: byName('WorktreeUpdateRefusedError'),
  },
  {
    name: 'WorkspaceIndexUnreadableError',
    matches: byClass(WorkspaceIndexUnreadableError),
  },
  {
    name: 'IdentifierValidationError',
    matches: byClass(IdentifierValidationError),
  },
];

/** Wrappers name the record only when no specific class sits below them. */
const WRAPPER_CLASSES: readonly NamedClass[] = [
  { name: 'CanopyOperationError', matches: byClass(CanopyOperationError) },
  { name: 'CanopyClientError', matches: byClass(CanopyClientError) },
];

/** Refusal reasons and handoff stages are closed code-like tokens. */
const TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;

const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MAX_KEYS = 200;

interface DedupeEntry {
  /** When the window opened; the key is suppressed until it expires. */
  readonly openedAt: number;
  suppressed: number;
}

/** Insertion order is window-open order, so the first key is the oldest. */
const windows = new Map<string, DedupeEntry>();
/** Counts suppressed in a window that expired, carried to the next record. */
const carried = new Map<string, number>();

/** Clears the dedupe state. Exported for tests only: it is module state. */
export function resetIpcRequestFailureDedupe(): void {
  windows.clear();
  carried.clear();
}

function read(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function matchIn(
  chain: readonly unknown[],
  classes: readonly NamedClass[],
): { readonly name: string; readonly value: unknown } | undefined {
  for (const named of classes) {
    for (const value of chain) {
      try {
        if (named.matches(value)) return { name: named.name, value };
      } catch {
        /* An unreadable value does not match. */
      }
    }
  }
  return undefined;
}

/**
 * The record's error name over the whole chain: a specific class, then a
 * wrapper, then a standard name, else `Error`. A wrapper never masks the cause
 * it carries. `value` is set only for an allowlisted class.
 */
function nameOf(thrown: unknown): {
  readonly errorName: string;
  readonly value?: unknown;
} {
  const chain = ipcErrorChain(thrown);
  const matched =
    matchIn(chain, SPECIFIC_CLASSES) ?? matchIn(chain, WRAPPER_CLASSES);
  if (matched) return { errorName: matched.name, value: matched.value };
  for (const value of chain) {
    const name = read(value, 'name');
    if (isStandardErrorName(name)) return { errorName: name };
  }
  return { errorName: 'Error' };
}

const token = (value: unknown): string | undefined =>
  typeof value === 'string' && TOKEN.test(value) ? value : undefined;

/** Ends expired windows, keeping their suppressed counts for the next record. */
function expire(now: number): void {
  for (const [key, entry] of windows) {
    if (now - entry.openedAt < DEDUPE_WINDOW_MS) continue;
    windows.delete(key);
    if (entry.suppressed > 0) carried.set(key, entry.suppressed);
  }
}

/**
 * Opens a window for a new key within the 200-key cap, ending the oldest
 * window as `expire` does, so its suppressed count carries.
 */
function reserve(key: string, now: number): void {
  while (windows.size >= DEDUPE_MAX_KEYS) {
    const oldest = windows.entries().next();
    if (oldest.done) break;
    const [oldestKey, entry] = oldest.value;
    windows.delete(oldestKey);
    if (entry.suppressed > 0) carried.set(oldestKey, entry.suppressed);
  }
  while (carried.size >= DEDUPE_MAX_KEYS) {
    const oldest = carried.keys().next();
    if (oldest.done) break;
    carried.delete(oldest.value);
  }
  windows.set(key, { openedAt: now, suppressed: 0 });
}

export interface IpcRequestFailure {
  /** The final shape the rejection carries. */
  readonly error: AppError;
  /** The value the handler threw; only class names and closed tokens are read. */
  readonly thrown: unknown;
  readonly operationFailure?: IpcOperationFailure;
}

/**
 * Keeps a local, content-free `ipc_request_failed` app diagnostic for a failed
 * request, whether or not error telemetry is on (CAN-7137). The kind is not
 * forwarded to telemetry. It writes only the reference id, the public IPC
 * source, the catalog code, an allowlisted class name, errno, a closed reason
 * and handoff stage, and the operation's status and code: never the message,
 * a path or an argument.
 *
 * One record per `ipcSource|appErrorCode|errorName|reason` per 60 s: the key
 * is reserved before the write, so concurrent failures write once, and the
 * next record for the key carries how many were suppressed. A suppressed
 * failure's reference id is not recorded. Never throws.
 */
export function recordIpcRequestFailure(
  failure: IpcRequestFailure,
  now: () => number = Date.now,
): void {
  let reservedKey: string | undefined;
  try {
    const { error, thrown, operationFailure } = failure;
    if (error.kind === 'input') return;
    const ipcSource =
      typeof error.source === 'string' && error.source.startsWith('ipc:')
        ? error.source
        : undefined;
    const { errorName, value } = nameOf(thrown);
    const reason =
      value === undefined ? undefined : token(read(value, 'reason'));
    const handoffStage =
      value instanceof W5DaemonHandoffError ? token(value.stage) : undefined;
    const key = [ipcSource ?? 'ipc', error.code, errorName, reason ?? ''].join(
      '|',
    );
    const at = now();
    expire(at);
    const open = windows.get(key);
    if (open) {
      open.suppressed += 1;
      return;
    }
    reserve(key, at);
    reservedKey = key;
    const suppressedCount = carried.get(key);
    const errorCode = allowlistedErrorCode(error.detail.errno);
    const record: AppDiagnosticRecord = {
      version: 1,
      timestamp: new Date(at).toISOString(),
      kind: 'ipc_request_failed',
      referenceId: error.referenceId,
      ...(ipcSource === undefined ? {} : { ipcSource }),
      appErrorCode: error.code,
      errorName,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(reason === undefined ? {} : { reason }),
      ...(handoffStage === undefined ? {} : { handoffStage }),
      ...(operationFailure === undefined
        ? {}
        : {
            operationStatus: operationFailure.status,
            ...(operationFailure.code === undefined
              ? {}
              : { operationCode: operationFailure.code }),
          }),
      ...(suppressedCount === undefined ? {} : { suppressedCount }),
    };
    const reservation = windows.get(key);
    // A delayed failure must not release a newer window's reservation.
    const release = (): void => {
      if (windows.get(key) === reservation) windows.delete(key);
    };
    // Observability reaches app-error-rejection through its host imports.
    // Load it after module initialization to avoid that cycle.
    void import('../observability')
      .then(({ peekObservabilityService }) => {
        const service = peekObservabilityService();
        if (!service) return release();
        service.recordAppDiagnostic(record);
        carried.delete(key);
      })
      .catch(release);
  } catch {
    if (reservedKey !== undefined) windows.delete(reservedKey);
  }
}
