import type { SessionViewModel } from '@canopy/app-core';
import {
  projectRemoteW5Recovery,
  readRemoteBackgroundService,
  W5RecoveryStatusSchema,
  type BackgroundServiceStatus,
  type W5RecoveryStatus,
} from '@canopy/protocol/remote-control/shell';
import { create } from 'zustand';

/** Validated host notices read from a paired computer's session snapshot. */
export interface RemoteHostNotices {
  readonly backgroundService?: BackgroundServiceStatus;
  readonly w5Recovery?: W5RecoveryStatus;
}

export function readRemoteHostNotices(
  snapshot: Pick<SessionViewModel, 'backgroundService' | 'w5Recovery'>,
): RemoteHostNotices {
  const recovery = W5RecoveryStatusSchema.safeParse(snapshot.w5Recovery);
  const backgroundService = readRemoteBackgroundService(
    snapshot.backgroundService,
  );
  return {
    ...(recovery.success && {
      w5Recovery: projectRemoteW5Recovery(recovery.data),
    }),
    ...(backgroundService && { backgroundService }),
  };
}

const recoveryShellSnapshotRefreshers = new Set<() => Promise<void>>();

/** Shares the sidebar's existing read without rerendering the entire app shell. */
export const useRecoveryShellSnapshotStore = create<{
  snapshot: SessionViewModel | null;
  remoteNotices: RemoteHostNotices | null;
  remoteSnapshotFailed: boolean;
}>()(() => ({
  snapshot: null,
  remoteNotices: null,
  remoteSnapshotFailed: false,
}));

/**
 * The notices to publish: the current ones when `next` says the same, so a
 * snapshot refresh that changes no notice does not re-render the sidebar
 * (CAN-8047). The notices are validated plain data.
 */
function keepEqualNotices(next: RemoteHostNotices): RemoteHostNotices {
  const current = useRecoveryShellSnapshotStore.getState().remoteNotices;
  return current !== null && JSON.stringify(current) === JSON.stringify(next)
    ? current
    : next;
}

export function publishRecoveryShellSnapshot(snapshot: SessionViewModel): void {
  useRecoveryShellSnapshotStore.setState({
    snapshot,
    remoteNotices: keepEqualNotices(readRemoteHostNotices(snapshot)),
    remoteSnapshotFailed: false,
  });
}

/**
 * Updates only the paired host notices, leaving any previously loaded sidebar
 * snapshot untouched. `snapshotFailed` distinguishes a `{ noticesOnly: true }`
 * fallback after a failed overview snapshot from notices attached to a
 * successful snapshot.
 */
export function publishRemoteHostNotices(
  snapshot: Pick<SessionViewModel, 'backgroundService' | 'w5Recovery'>,
  options?: { readonly snapshotFailed?: boolean },
): void {
  useRecoveryShellSnapshotStore.setState({
    remoteNotices: keepEqualNotices(readRemoteHostNotices(snapshot)),
    remoteSnapshotFailed: options?.snapshotFailed ?? false,
  });
}

export function registerRecoveryShellSnapshotRefresh(
  refresh: () => Promise<void>,
): () => void {
  recoveryShellSnapshotRefreshers.add(refresh);
  return () => {
    recoveryShellSnapshotRefreshers.delete(refresh);
  };
}

export function requestRecoveryShellSnapshotRefresh(): boolean {
  if (recoveryShellSnapshotRefreshers.size === 0) return false;
  for (const refresh of recoveryShellSnapshotRefreshers) {
    void refresh();
  }
  return true;
}

export function resetRecoveryShellSnapshotStore(): void {
  recoveryShellSnapshotRefreshers.clear();
  useRecoveryShellSnapshotStore.setState({
    snapshot: null,
    remoteNotices: null,
    remoteSnapshotFailed: false,
  });
}
