import {
  FeatureFlagEventSchema,
  FeatureFlagSnapshotGetResultSchema,
  type FeatureFlagSnapshotGetResult,
} from '@canopy/protocol/canopy-core';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { CanopyCoreRelayApi } from '../../../shared/canopy-core-relay';

/** Core's values for the flags it owns or shares, and their provenance. */
export type CoreFeatureFlags = Pick<
  FeatureFlagSnapshotGetResult,
  'flags' | 'provenance'
>;

const RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Follows `core.featureFlag.*` over the local renderer relay (CAN-4181 F5):
 * the snapshot, then the events stream, whose first event carries every flag
 * in scope. Core's values hold only while they are fresh: a snapshot read or
 * a stream item applies them, and every end, a
 * `core.featureFlag.snapshotRequired` frame or any failure, drops them with
 * `apply(null)`, so the caller falls back to the IPC snapshot until core
 * reads again. A snapshotRequired end reads again at once; any other retries
 * with backoff. A snapshot read or stream item that IPC published a snapshot
 * since, which may be another account's, is dropped and core read again.
 * Returns the stop.
 */
export function followCoreFeatureFlags(
  relay: CanopyCoreRelayApi,
  apply: (flags: CoreFeatureFlags | null) => void,
  ipcSnapshots: () => number,
): () => void {
  let stopped = false;
  let subscriptionId: string | null = null;
  let delay = RETRY_MS;
  const close = (): void => {
    if (subscriptionId !== null)
      void relay.invoke({ kind: 'closeStream', subscriptionId });
    subscriptionId = null;
  };

  const readSnapshot = (): ReturnType<CanopyCoreRelayApi['invoke']> =>
    relay.invoke({
      kind: 'request',
      method: 'core.featureFlag.snapshot.get',
      params: {},
    });

  // One snapshot and stream; true when the stream asks for a new snapshot.
  async function followOnce(): Promise<boolean> {
    let seen = ipcSnapshots();
    let read = await readSnapshot();
    // shortcut: IPC snapshots carry no account identity, so any IPC snapshot drops a pending read or a later stream item; re-reads are bounded by the IPC push count and IPC values show meanwhile, and on a quiet stream core comes back up to one relay read deadline after the IPC snapshot.
    while (read.ok && !stopped && ipcSnapshots() !== seen) {
      seen = ipcSnapshots();
      read = await readSnapshot();
    }
    if (!read.ok || stopped) return false;
    let current: CoreFeatureFlags = FeatureFlagSnapshotGetResultSchema.parse(
      read.value,
    );
    apply(current);
    const opened = await relay.invoke({
      kind: 'openStream',
      method: 'core.featureFlag.events',
      params: {},
    });
    if (!opened.ok || !isRecord(opened.value)) return false;
    const id = opened.value.subscriptionId;
    if (typeof id !== 'string') return false;
    subscriptionId = id;
    while (!stopped) {
      const next = await relay.invoke({
        kind: 'readStream',
        subscriptionId: id,
      });
      if (stopped) break;
      // A quiet stream outlives the relay's read deadline; read it again.
      if (!next.ok && next.error.kind === 'deadline_exceeded') {
        if (ipcSnapshots() !== seen) return true;
        continue;
      }
      const frame = next.ok ? next.value : null;
      if (!isRecord(frame) || frame.kind !== 'item')
        return (
          isRecord(frame) &&
          isRecord(frame.error) &&
          frame.error.code === 'core.featureFlag.snapshotRequired'
        );
      // A queued item may be the previous account's, ahead of its end frame;
      // drop it and read core again, as for a snapshot read.
      // shortcut: every flag change re-reads because IPC broadcasts first; upgrade to a value match or an account identity on IPC if flag churn ever shows up in perf.
      if (ipcSnapshots() !== seen) return true;
      const event = FeatureFlagEventSchema.parse(frame.item);
      // The first event carries every flag in scope; later ones, what changed.
      current = {
        flags: { ...current.flags, ...event.changed },
        provenance: event.provenance,
      };
      apply(current);
      // Only a delivering stream ends the backoff: a snapshot read alone
      // would reset it before an open or read that keeps failing.
      delay = RETRY_MS;
    }
    return false;
  }

  void (async (): Promise<void> => {
    while (!stopped) {
      const snapshotRequired = await followOnce().catch((error: unknown) => {
        // A malformed reply; the retry below reads core again.
        reportClientAppError(error);
        return false;
      });
      close();
      if (stopped) return;
      apply(null);
      if (snapshotRequired) continue;
      await new Promise((done) => setTimeout(done, delay));
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  })();
  return (): void => {
    stopped = true;
    close();
  };
}
