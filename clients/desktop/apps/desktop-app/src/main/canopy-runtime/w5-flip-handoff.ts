import { toCanopyClientError } from '@canopy/core-client';
import {
  canopyLaunchDetails,
  canopyDaemonRefusal,
  canopyPathSharedWithAnotherAccount,
} from '@canopy/core-client/node';
import { getLinuxDaemonStartDiagnostics } from './electron-daemon-host';
import { w5FailureDiagnostics } from '@canopy/core-runtime/node/w5/error-diagnostics';
import { W5AuthorityUnreachableError } from '@canopy/core-runtime/node/w5/file-store';
import type { BackgroundServiceHandoffFailure } from '@canopy/desktop-shared/lib/background-service-status';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { installDesktopW5FileStore } from '../lib/w5-commit-log-file-store';
import { isW5DaemonFlipCompiled } from '../lib/w5-flip-gate';
import {
  createW5HandoffStore,
  W5DaemonHandoffError,
  type W5HandoffFailure,
} from '../lib/w5-handoff-store';
import {
  setW5PreEffectAttempts,
  W5_DAEMON_PRE_EFFECT_ATTEMPTS,
} from '../lib/w5-pre-effect-retry';
import {
  disposeElectronDaemonConnections,
  noteElectronW5Handoff,
} from './electron-daemon-access';
import type { W5FlipHandoffInput } from './w5-flip-handoff-sequence';
import type { W5BackupRefusal } from '../lib/w5-backup';

/*
 * TRANSITIONAL (CAN-5543, GB12): the flip launch's W5 startup. Installs the
 * W5 store at once, so no W5 call reaches the in-process commit log, and runs
 * the handoff behind it; W5 calls wait for it while the rest of startup goes
 * on (Q3(b)). It runs on every launch of a flip build, never assuming what
 * ran before, so a launch that skipped releases walks the whole migration.
 * Remove at W15.
 */

export type W5FlipHandoffStatus =
  | { readonly state: 'pending' | 'ready' }
  /**
   * Direct reads, no writes; `daemon_unavailable` is its own warning. Never
   * retried in process: the in-process host stays stopped, so the backup
   * cannot rerun; the next launch retries. A `ready` store's session
   * reconnects through its lease.
   */
  | {
      readonly state: 'degraded';
      readonly reason: W5HandoffFailure;
      readonly detail?: string;
    };

/** A handoff code missing from the notice's contract fails to compile here. */
function handoffFailureCode(
  reason: Exclude<W5HandoffFailure, 'cancelled'>,
): BackgroundServiceHandoffFailure {
  return reason;
}

let status: W5FlipHandoffStatus | undefined;
let settled: Promise<void> | undefined;
const owner = new AbortController();

/** `undefined` until a flip build starts it; the GB4 warning's input. */
export function getW5FlipHandoffStatus(): W5FlipHandoffStatus | undefined {
  return status;
}

/** Every backup refusal: a `Record` so a new refusal must be listed here. */
const BACKUP_REFUSAL_CODES: Record<W5BackupRefusal, true> = {
  'incomplete-backup': true,
  'corrupt-backup': true,
  'source-changed': true,
  'source-unreadable': true,
  'missing-source': true,
  'newer-writes': true,
  'schema-downgrade': true,
  'exclusive-required': true,
};

/**
 * Path-free handoff sub-reasons the diagnostic may keep verbatim: the backup
 * refusals and the flip step's and store's own codes. Anything else is
 * `other`, since `detail` is an open string (CAN-7316).
 */
const W5_HANDOFF_DETAIL_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(BACKUP_REFUSAL_CODES),
  'completion-invalid',
  'host-unavailable',
  'marker-unwritable',
  'host-stopped',
  'handoff-not-started',
]);

/** `<stage or unknown>: <failure>[: <detail code>]`, from closed codes only. */
function w5HandoffDegradedReason(failure: W5DaemonHandoffError): string {
  const { detail } = failure;
  const code =
    detail === undefined
      ? ''
      : `: ${W5_HANDOFF_DETAIL_CODES.has(detail) ? detail : 'other'}`;
  return `${failure.stage ?? 'unknown'}: ${failure.reason}${code}`;
}

/**
 * Persists the failure to app-events, which feedback bundles include on every
 * platform, unlike `main.log` on win32 (CAN-7316). Best effort and never
 * awaited: a diagnostics failure cannot change or delay the handoff outcome.
 */
function recordW5HandoffDegraded(failure: W5DaemonHandoffError): void {
  void import('../observability')
    .then(({ getObservabilityService }) =>
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'w5_handoff_degraded',
        reason: w5HandoffDegradedReason(failure),
        ...w5FailureDiagnostics(failure),
      }),
    )
    .catch(() => undefined);
}

/**
 * After W11 admission and before any W5 call. With legacy rows it does
 * nothing: no store, no daemon contact, no backup or marker read. The
 * returned promise settles with the handoff; it never rejects.
 */
export function startW5FlipHandoff(input: W5FlipHandoffInput): Promise<void> {
  if (!isW5DaemonFlipCompiled()) return Promise.resolve();
  if (settled) return settled;
  status = { state: 'pending' };
  noteElectronW5Handoff('pending');
  const outcome = import('./w5-flip-handoff-sequence')
    .then(({ runW5FlipHandoff }) =>
      runW5FlipHandoff({ ...input, signal: owner.signal }),
    )
    .then(
      (store) => {
        status = { state: 'ready' };
        noteElectronW5Handoff('ready');
        // CAN-7155: warm the read cache; first readers wait on the warm.
        void import('./w5-read-cache')
          .then((readCache) =>
            readCache.isDesktopW5ReadCacheSelected()
              ? readCache.getDesktopW5ReadCache().activate(store)
              : undefined,
          )
          .catch((error: unknown) =>
            logMainProcessWarn('W5 read cache did not start', { error }),
          );
        return store;
      },
      (error: unknown) => {
        const failure =
          error instanceof W5DaemonHandoffError
            ? error
            : new W5DaemonHandoffError('daemon_unavailable', undefined, error);
        status = {
          state: 'degraded',
          reason: failure.reason,
          ...(failure.detail !== undefined && { detail: failure.detail }),
        };
        const launchError =
          failure.underlying instanceof W5AuthorityUnreachableError
            ? (failure.underlying.cause ?? failure.underlying)
            : (failure.underlying ?? failure);
        if (failure.reason === 'cancelled') noteElectronW5Handoff('cancelled');
        else
          noteElectronW5Handoff(
            'degraded',
            // A restart alone can't help while another account can reach the folder.
            canopyPathSharedWithAnotherAccount(launchError)
              ? 'data_folder_shared'
              : handoffFailureCode(failure.reason),
          );
        if (failure.reason !== 'cancelled') {
          // Content-free on every platform: the failing step, errno, port kind
          // (CAN-7137) and any private-path cause (CAN-7917).
          const launch = {
            stage: failure.stage,
            errorKind: toCanopyClientError(launchError).payload.kind,
            refusal: canopyDaemonRefusal(launchError) ?? undefined,
            ...canopyLaunchDetails(launchError),
          };
          const facts = getLinuxDaemonStartDiagnostics()?.handoff(launch);
          logMainProcessWarn(
            'W5 startup handoff failed; workspace records are read-only',
            {
              reason: failure.reason,
              detail: failure.detail,
              ...w5FailureDiagnostics(failure),
              ...launch,
              ...facts,
            },
          );
          recordW5HandoffDegraded(failure);
        }
        throw failure;
      },
    );
  installDesktopW5FileStore(createW5HandoffStore(outcome));
  setW5PreEffectAttempts(W5_DAEMON_PRE_EFFECT_ATTEMPTS);
  settled = outcome.then(
    () => undefined,
    () => undefined,
  );
  return settled;
}

/**
 * Quit, before the W5 writers drain: a handoff still pending ends `cancelled`,
 * so their calls refuse at once instead of holding quit for its wait.
 */
export function cancelPendingW5FlipHandoff(): void {
  if (status?.state === 'pending') owner.abort();
}

/**
 * Quit, after the last W5 writer: releases the W5 record lease, then every
 * daemon session and the W5e observation, which a flip build's Files slot
 * leaves open. A no-op with legacy rows.
 */
export async function disposeW5FlipHandoff(): Promise<void> {
  if (!isW5DaemonFlipCompiled()) return;
  owner.abort();
  if (status?.state === 'ready')
    (await import('./w5-read-cache')).disposeDesktopW5ReadCache();
  await disposeElectronDaemonConnections();
}
