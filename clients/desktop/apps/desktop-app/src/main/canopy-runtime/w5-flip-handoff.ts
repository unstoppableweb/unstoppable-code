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

let status: W5FlipHandoffStatus | undefined;
let settled: Promise<void> | undefined;
const owner = new AbortController();

/** `undefined` until a flip build starts it; the GB4 warning's input. */
export function getW5FlipHandoffStatus(): W5FlipHandoffStatus | undefined {
  return status;
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
        noteElectronW5Handoff(
          failure.reason === 'cancelled' ? 'cancelled' : 'degraded',
        );
        if (failure.reason !== 'cancelled')
          logMainProcessWarn(
            'W5 startup handoff failed; workspace records are read-only',
            { reason: failure.reason, detail: failure.detail },
          );
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
  await disposeElectronDaemonConnections();
}
