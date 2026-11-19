import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  getWorkspaceRecoveryDismissalStore,
  WorktreeRecoveryPanel,
} from '@canopy/ui-app/worktree-discard';
import type { W5RecoveryStatus } from '@canopy/protocol/remote-control/shell';
import { useCanopyClient, useCapabilities } from '@canopy/app-state';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { useRecoveryShellSnapshotStore } from '@/stores/recoveryShellSnapshotStore';
import { isDesktopSharedSidebarEnabled } from '../sidebar/desktop-shared-sidebar-flag';
import { useLocalBackgroundServiceNotice } from './useLocalBackgroundServiceNotice';

export function WorkspaceRecoveryNotice(): JSX.Element | null {
  const local = useRemoteControlStore(
    (store) => store.context.mode === 'local',
  );
  const capabilities = useCapabilities();
  const client = useCanopyClient();
  // Keep dismissal across notice remounts for this CanopyClient only; renderer
  // reload or app relaunch must restore access to Restart for recovery.
  const dismissalStore = useMemo(
    () => (local ? getWorkspaceRecoveryDismissalStore(client, null) : null),
    [client, local],
  );
  const sharedSidebar = useMemo(isDesktopSharedSidebarEnabled, []);
  const snapshot = useRecoveryShellSnapshotStore((store) => store.snapshot);
  const [status, setStatus] = useState<W5RecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const service = useLocalBackgroundServiceNotice(local);
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
  if (!local || dismissalStore === null) return null;
  return (
    <WorktreeRecoveryPanel
      client={client}
      dismissalStore={dismissalStore}
      snapshot={sharedSidebar ? snapshot : undefined}
      status={status ?? undefined}
      canRecover={capabilities.workspaceRecovery === true}
      coldBusy={busy}
      onRecover={recover}
      service={service}
    />
  );
}
