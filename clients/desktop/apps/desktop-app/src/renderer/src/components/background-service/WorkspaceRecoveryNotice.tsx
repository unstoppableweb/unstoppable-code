import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { WorktreeRecoveryPanel } from '@canopy/ui-app/worktree-discard';
import type { W5RecoveryStatus } from '@canopy/protocol/portal';
import { useCanopyClient, useCapabilities } from '@canopy/app-state';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { useRecoveryShellSnapshotStore } from '@/stores/recoveryShellSnapshotStore';
import { isDesktopSharedSidebarEnabled } from '../sidebar/desktop-shared-sidebar-flag';

export function WorkspaceRecoveryNotice(): JSX.Element | null {
  const local = useRemoteControlStore(
    (store) => store.context.mode === 'local',
  );
  const capabilities = useCapabilities();
  const client = useCanopyClient();
  const sharedSidebar = useMemo(isDesktopSharedSidebarEnabled, []);
  const snapshot = useRecoveryShellSnapshotStore((store) => store.snapshot);
  const [status, setStatus] = useState<W5RecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
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
  if (!local) return null;
  return (
    <WorktreeRecoveryPanel
      client={client}
      snapshot={sharedSidebar ? snapshot : undefined}
      status={status ?? undefined}
      canRecover={capabilities.workspaceRecovery === true}
      coldBusy={busy}
      onRecover={recover}
    />
  );
}
