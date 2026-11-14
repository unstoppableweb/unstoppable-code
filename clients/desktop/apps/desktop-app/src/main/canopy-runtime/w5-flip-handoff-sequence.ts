import { app } from 'electron';
import { toCanopyClientError } from '@canopy/core-client';
import {
  canopyDaemonRefusal,
  canopyDaemonRefusalError,
} from '@canopy/core-client/node';
import { w5RootEvidenceScope } from '@canopy/core-runtime/node/w5/service-history';
import type { W5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { createW5DaemonRecordStore } from '../lib/w5-daemon-record-store';
import {
  deferW5FlipBackup,
  noteW5DaemonServed,
  stopInProcessW5Host,
  w5FlipStepFailure,
} from '../lib/w5-flip-backup';
import { W5DaemonHandoffError } from '../lib/w5-handoff-store';
import {
  getElectronDaemonFilesContext,
  probeElectronDaemonW5,
} from './electron-daemon-access';
import { leaseElectronW5RecordPort } from './electron-w5-record-port';
import { settleRefusedW5Daemon } from './w5-refused-daemon';

/*
 * TRANSITIONAL (CAN-5543, GB12): the flip launch's handoff sequence, loaded
 * only by a flip build. Remove at W15.
 */

const PROBE_TIMEOUT_MS = 30_000;
/** A refused daemon's 30 s idle grace, up to 5 s to stop, and slack. */
const W5_RELEASE_WAIT_MS = 45_000;

export interface W5FlipHandoffInput {
  /** Main's W11 startup admission; `refused` already stopped the app. */
  readonly admission: { readonly kind: 'admitted' | 'unregistered' | 'failed' };
}

const outlived = (refusal: 'peer_held' | 'version_skew'): Error =>
  canopyDaemonRefusalError(
    refusal,
    refusal === 'version_skew'
      ? 'The running core serves another version of the workspace records.'
      : 'Another core is still running and cannot serve this app.',
  );

/** Probes, waiting out refused daemons, until one serves W5 or none is live. */
async function awaitServableDaemon(
  signal: AbortSignal,
): Promise<'attach' | 'spawn'> {
  const bound = performance.now() + W5_RELEASE_WAIT_MS;
  let refusal: 'peer_held' | 'version_skew' | undefined;
  for (;;) {
    signal.throwIfAborted();
    const probeRemaining = Math.ceil(bound - performance.now());
    if (probeRemaining <= 0) throw outlived(refusal ?? 'peer_held');
    const found = await probeElectronDaemonW5(
      Math.min(PROBE_TIMEOUT_MS, probeRemaining),
      signal,
    ).catch((error: unknown): never => {
      // A final shortened probe can exhaust the refused daemon's wait budget.
      if (
        refusal &&
        performance.now() >= bound &&
        toCanopyClientError(error).payload.kind === 'deadline_exceeded'
      )
        throw outlived(refusal);
      throw error;
    });
    if (found.kind === 'absent') return 'spawn';
    if (found.kind === 'accept') return 'attach';
    if (found.kind === 'refuse')
      throw canopyDaemonRefusalError(
        found.refusal,
        'Another app holds the workspace records.',
      );
    // A skewed daemon is waited out too: after an update, the previous
    // build's daemon idles out like any other; an RC or prod peer does not.
    refusal = found.refusal ?? 'peer_held';
    const remaining = Math.ceil(bound - performance.now());
    if (remaining <= 0) throw outlived(refusal);
    try {
      await settleRefusedW5Daemon(found.descriptor, remaining, signal);
    } catch (error) {
      throw canopyDaemonRefusal(error) === 'peer_held'
        ? outlived(refusal)
        : error;
    }
  }
}

function handoffFailureOf(
  error: unknown,
  signal: AbortSignal,
): W5DaemonHandoffError {
  if (signal.aborted) return new W5DaemonHandoffError('cancelled');
  if (error instanceof W5DaemonHandoffError) return error;
  const refusal = canopyDaemonRefusal(error);
  if (refusal) return new W5DaemonHandoffError(refusal, undefined, error);
  const step = w5FlipStepFailure(error);
  if (step) return new W5DaemonHandoffError(step.failure, step.detail, error);
  return new W5DaemonHandoffError('daemon_unavailable', undefined, error);
}

/**
 * Resolves the daemon-backed store once a daemon serving W5 holds the log,
 * or rejects typed. Any failure leaves the in-process host stopped.
 */
export async function runW5FlipHandoff(
  input: W5FlipHandoffInput & { readonly signal: AbortSignal },
): Promise<W5CommitLogFileStore> {
  const lease = leaseElectronW5RecordPort();
  input.signal.addEventListener('abort', () => lease.close(), { once: true });
  try {
    if (input.admission.kind === 'failed')
      throw new W5DaemonHandoffError('host_admission_failed');
    const path = await awaitServableDaemon(input.signal);
    const buildVersion = app.getVersion();
    // A daemon already holds the log, so the backup must wait (Q1(a)). Only
    // the later capture's label depends on this record, so it never fails
    // the handoff.
    if (path === 'attach')
      await deferW5FlipBackup(buildVersion).catch(() => undefined);
    const { canonicalDataRoot } = await getElectronDaemonFilesContext();
    const servedScope = await w5RootEvidenceScope(canonicalDataRoot);
    // Attaches or starts, then checks the daemon's W5 capability and leases.
    await lease.transport.recovery();
    // A lease-free probe alone must not authorize stopped-host crash respawns.
    input.signal.throwIfAborted();
    await noteW5DaemonServed(servedScope);
    await deferW5FlipBackup(buildVersion).catch(() => undefined);
    // Fences in-process use where the launch attached instead of spawning.
    await stopInProcessW5Host();
    input.signal.throwIfAborted();
    return createW5DaemonRecordStore({ transport: lease.transport });
  } catch (error) {
    lease.close();
    await stopInProcessW5Host().catch(() => undefined);
    throw handoffFailureOf(error, input.signal);
  }
}
