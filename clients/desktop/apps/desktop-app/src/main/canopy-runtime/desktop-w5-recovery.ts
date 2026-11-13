import { electronW5RecoveryObservations } from './w5-recovery-observations';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import type {
  W5RecoveryEntry,
  W5RecoveryStatus,
} from '@canopy/protocol/portal';
import { listW5HostPeers } from '@canopy/execution-engine/node/w5-host-cohort';
import { getCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import { isW5RecoveryAvailable } from '../lib/w5-recovery-gates';
import {
  readW5RecoveryResult,
  writeW5RecoveryRequest,
} from '../lib/w5-recovery-request';
import { disposeElectronDaemonConnections } from './electron-daemon-access';
import { getElectronDaemonHealth } from './electron-daemon-health';
import {
  leaseElectronW5RecordPort,
  type ElectronW5RecordPortLease,
} from './electron-w5-record-port';
import {
  cancelPendingW5FlipHandoff,
  getW5FlipHandoffStatus,
} from './w5-flip-handoff';
import {
  createW5RecoveryController,
  type W5RecoveryController,
} from './w5-recovery-controller';

let controller: W5RecoveryController | undefined;

/** Native interface intent; the cold writer is never callable from this process. */
export function getDesktopW5RecoveryController(): W5RecoveryController {
  if (controller) return controller;
  let lease: ElectronW5RecordPortLease | undefined;
  let lastResult: W5RecoveryStatus | null | undefined;
  controller = createW5RecoveryController({
    enabled: isW5RecoveryAvailable,
    supported: () => hostPlatformOperatingSystem() !== 'win32',
    live: async (): Promise<readonly W5RecoveryEntry[]> => {
      if (lastResult === undefined)
        lastResult = await readW5RecoveryResult(getCanopyDataDir());
      const retained =
        lastResult?.entries.filter(
          (entry) =>
            entry.id === 'journals' ||
            entry.id === 'log' ||
            entry.id.startsWith('file:'),
        ) ?? [];
      const handoff = getW5FlipHandoffStatus();
      if (handoff?.state === 'pending') return [];
      if (handoff?.state === 'degraded') {
        if (handoff.reason === 'daemon_unavailable') return [];
        return [
          {
            id: 'handoff',
            operation: 'Workspace records',
            detail: `${handoff.reason}${handoff.detail ? `: ${handoff.detail}` : ''}`,
          },
        ];
      }
      lease ??= leaseElectronW5RecordPort();
      try {
        const [recovery, reservations] = await Promise.all([
          lease.transport.recovery(),
          lease.transport.listReservations(),
        ]);
        const entries: W5RecoveryEntry[] = [
          ...retained,
          ...reservations.reservations
            .filter((r) => r.state === 'recovery-required')
            .map((r) => ({
              id: `reservation:${r.reservationId}`.slice(0, 256),
              operation: r.operation.slice(0, 256),
              detail: r.diagnostics.slice(0, 2000),
            })),
          ...recovery.recoveryRequired.map((commitId) => ({
            id: `commit:${commitId}`,
            operation: `Commit ${commitId}`,
            detail: 'Operation details are available after restart.',
          })),
        ];
        const pending = electronW5RecoveryObservations.withoutCompleted([
          ...entries,
          ...electronW5RecoveryObservations.entries(),
        ]);
        return [
          ...new Map(
            pending.map((entry) => [
              entry.id,
              lastResult?.entries.find(
                (previous) => previous.id === entry.id,
              ) ?? entry,
            ]),
          ).values(),
        ];
      } catch (error) {
        // An unavailable query cannot undo a completion proved by a write.
        const cached = controller?.peek().entries ?? [];
        const stillBlocked =
          electronW5RecoveryObservations.withoutCompleted(cached);
        const entries = electronW5RecoveryObservations.withoutCompleted([
          ...stillBlocked,
          ...retained,
          ...electronW5RecoveryObservations.entries(),
        ]);
        if (entries.length || stillBlocked.length !== cached.length)
          return [
            ...new Map(entries.map((entry) => [entry.id, entry])).values(),
          ];
        throw error;
      }
    },
    reason: () =>
      lastResult?.state === 'blocked' || lastResult?.state === 'refused'
        ? lastResult.reason
        : undefined,
    onChanged: (): void => {
      void import('../portal/portal-structural-sync')
        .then(({ schedulePortalStructuralSync }) =>
          schedulePortalStructuralSync(),
        )
        .catch(() => undefined);
    },
    peers: async () => {
      const platform = hostPlatformServices(
        createPlatformEndpointServices(hostPlatformOperatingSystem()),
      );
      return listW5HostPeers({
        dataRoot: getCanopyDataDir(),
        secureFiles: platform.secureFiles,
        inspect: (pid, signal) =>
          platform.supervision.inspectProcess({ pid, signal }),
      });
    },
    quiesce: async (): Promise<void> => {
      getElectronDaemonHealth().beginRecovery();
      cancelPendingW5FlipHandoff();
      lease?.close();
      // Stops W5e's recheck and owed-recovery timers, every poller and lease reconnect.
      await disposeElectronDaemonConnections();
    },
    request: () => writeW5RecoveryRequest(getCanopyDataDir()),
  });
  return controller;
}
