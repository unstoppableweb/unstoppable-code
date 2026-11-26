import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  getWorkspaceRecoveryDismissalStore,
  WorkspaceRecoveryNotice as SharedWorkspaceRecoveryNotice,
  WorktreeRecoveryPanel,
} from '@canopy/ui-app/worktree-discard';
import type { W5RecoveryStatus } from '@canopy/protocol/remote-control/shell';
import { backgroundServiceRepairCommand } from '@canopy/ui-shared/lib';
import { useCanopyClient, useCapabilities } from '@canopy/app-state';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { formatBrandText } from '@/lib/brand';
import {
  getAuthoritativeProjectsLoadEpoch,
  requestRemoteRecoveryProjectsReload,
} from '@/stores/projectsStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import {
  publishRemoteHostNotices,
  registerRecoveryShellSnapshotRefresh,
  useRecoveryShellSnapshotStore,
} from '@/stores/recoveryShellSnapshotStore';
import { isDesktopSharedSidebarEnabled } from '../sidebar/desktop-shared-sidebar-flag';
import { useLocalBackgroundServiceNotice } from './useLocalBackgroundServiceNotice';

export function WorkspaceRecoveryNotice(): JSX.Element | null {
  const remoteContext = useRemoteControlStore((store) => store.context);
  const local = remoteContext.mode === 'local';
  const remoteDeviceId =
    remoteContext.mode === 'remote' ? remoteContext.deviceId : null;
  const capabilities = useCapabilities();
  const client = useCanopyClient();
  // Keep dismissal across notice remounts for this CanopyClient only; renderer
  // reload or app relaunch must restore access to Restart for recovery.
  const dismissalStore = useMemo(
    () => getWorkspaceRecoveryDismissalStore(client, remoteDeviceId),
    [client, remoteDeviceId],
  );
  const sharedSidebar = useMemo(isDesktopSharedSidebarEnabled, []);
  const snapshot = useRecoveryShellSnapshotStore((store) => store.snapshot);
  const remoteNotices = useRecoveryShellSnapshotStore(
    (store) => store.remoteNotices,
  );
  const [status, setStatus] = useState<W5RecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const localService = useLocalBackgroundServiceNotice(local);
  const remoteService = useMemo(
    () =>
      !local && remoteNotices?.backgroundService
        ? {
            status: remoteNotices.backgroundService,
            repairCommand: backgroundServiceRepairCommand(
              formatBrandText('{cli}'),
            ),
          }
        : undefined,
    [local, remoteNotices?.backgroundService],
  );
  const paused =
    status?.state === 'restart-required' ||
    status?.reason === 'request-unavailable';
  useEffect(() => {
    const api = local && !paused ? window.api?.w5Recovery : undefined;
    if (!api) return undefined;
    let active = true;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await api.getStatus();
        if (active) setStatus(next);
      } catch {
        /* Background service failures have their own notice. */
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 10_000);
    return (): void => {
      active = false;
      clearInterval(timer);
    };
  }, [local, paused]);
  // When the shared sidebar is disabled via the legacy escape hatch, nothing
  // else queries session.snapshot in a remote window; keep host notices live.
  useEffect(() => {
    if (local || sharedSidebar) return undefined;
    let active = true;
    let inFlight = false;
    let pending = false;
    let remoteOutageLoadEpoch: number | null = null;
    const refreshNotices = async (): Promise<void> => {
      if (!active) return;
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      pending = false;
      try {
        const notices = await client.query('session.snapshot', {
          noticesOnly: true,
        });
        if (!active) return;
        const previousSnapshotFailed =
          useRecoveryShellSnapshotStore.getState().remoteSnapshotFailed;
        const nextSnapshotFailed =
          notices.backgroundService?.state === 'unavailable';
        if (nextSnapshotFailed) {
          remoteOutageLoadEpoch ??= getAuthoritativeProjectsLoadEpoch();
        }
        publishRemoteHostNotices(notices, {
          snapshotFailed: nextSnapshotFailed,
        });
        if (previousSnapshotFailed && !nextSnapshotFailed) {
          const outageEpoch =
            remoteOutageLoadEpoch ?? getAuthoritativeProjectsLoadEpoch();
          remoteOutageLoadEpoch = null;
          requestRemoteRecoveryProjectsReload(outageEpoch);
        } else if (!nextSnapshotFailed) {
          remoteOutageLoadEpoch = null;
        }
      } catch (error) {
        if (!active) return;
        reportClientAppError(error);
      } finally {
        inFlight = false;
        if (active && pending) void refreshNotices();
      }
    };
    const unregisterRefresh =
      registerRecoveryShellSnapshotRefresh(refreshNotices);
    const unsubscribe = client.subscribe('session.snapshot-stale', () => {
      void refreshNotices();
    });
    void refreshNotices();
    return (): void => {
      active = false;
      unregisterRefresh();
      unsubscribe();
    };
  }, [client, local, sharedSidebar]);
  const recover = useCallback((): void => {
    if (busy) return;
    setBusy(true);
    void window.api.w5Recovery
      .prepare()
      .then(async (next) => {
        setStatus(next);
        if (next.state === 'restart-required') await window.api.restartApp();
      })
      .catch(() => {
        setStatus((previous) =>
          previous
            ? {
                ...previous,
                state: 'refused',
                canRecover: false,
                reason: 'request-unavailable',
              }
            : previous,
        );
      })
      .finally(() => setBusy(false));
  }, [busy]);
  if (!local) {
    const remoteRecovery = remoteNotices?.w5Recovery;
    const hasRemoteRecovery =
      remoteRecovery !== undefined && remoteRecovery.state !== 'hidden';
    if (!remoteService && !hasRemoteRecovery) return null;
    return (
      <SharedWorkspaceRecoveryNotice
        dismissalStore={dismissalStore}
        status={remoteRecovery}
        canRecover={false}
        service={remoteService}
      />
    );
  }
  return (
    <WorktreeRecoveryPanel
      client={client}
      dismissalStore={dismissalStore}
      snapshot={sharedSidebar ? snapshot : undefined}
      status={status ?? undefined}
      canRecover={capabilities.workspaceRecovery === true}
      coldBusy={busy}
      onRecover={recover}
      service={localService}
    />
  );
}
