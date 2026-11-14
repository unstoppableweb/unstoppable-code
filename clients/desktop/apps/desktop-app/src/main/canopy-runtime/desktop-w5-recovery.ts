import { listW5RootPresencePeers } from '@canopy/core-platform/w5-root-presence';
import { isDeepStrictEqual } from 'node:util';
import {
  lifecycleJournalSlotName,
  withSharedLifecycleJournalAccess,
} from '../lib/w5-destructive-recovery';
import { inspectDestructiveJournals } from '@canopy/desktop-shared/node/w5-destructive-journal';
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

interface DesktopW5RecoveryController extends W5RecoveryController {
  refreshJournals(): Promise<W5RecoveryStatus>;
}

let controller: DesktopW5RecoveryController | undefined;

/** Native interface intent; the cold writer is never callable from this process. */
export function getDesktopW5RecoveryController(): DesktopW5RecoveryController {
  if (controller) return controller;
  let lease: ElectronW5RecordPortLease | undefined;
  let lastResult: W5RecoveryStatus | null | undefined;
  let journalsRemain = true;
  const recovery = createW5RecoveryController({
    enabled: isW5RecoveryAvailable,
    supported: () => hostPlatformOperatingSystem() !== 'win32',
    live: async (): Promise<readonly W5RecoveryEntry[]> => {
      if (lastResult === undefined)
        lastResult = await readW5RecoveryResult(getCanopyDataDir());
      const retained =
        lastResult?.entries.filter(
          (entry) =>
            (entry.id === 'journals' && journalsRemain) ||
            entry.id === 'log' ||
            entry.id.startsWith('file:'),
        ) ?? [];
      const handoff = getW5FlipHandoffStatus();
      if (handoff?.state === 'pending') return retained;
      if (handoff?.state === 'degraded') {
        if (handoff.reason === 'daemon_unavailable') return retained;
        return [
          ...retained,
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
        const stillBlocked = electronW5RecoveryObservations
          .withoutCompleted(cached)
          .filter((entry) => entry.id !== 'journals' || journalsRemain);
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
      const legacy = await listW5HostPeers({
        dataRoot: getCanopyDataDir(),
        secureFiles: platform.secureFiles,
        inspect: (pid, signal) =>
          platform.supervision.inspectProcess({ pid, signal }),
      });
      const presence = await listW5RootPresencePeers({
        dataRoot: getCanopyDataDir(),
        inspect: (pid) => platform.supervision.inspectProcess({ pid }),
      });
      // Quiesce releases our daemon lease; cold maintenance checks its exit.
      return [
        ...new Set([
          ...legacy,
          ...presence.filter((kind) => kind !== 'daemon'),
        ]),
      ];
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
  controller = {
    ...recovery,
    async refreshJournals(): Promise<W5RecoveryStatus> {
      // Only an explicit recovery operation scans disk, never startup/status polling.
      journalsRemain = await withSharedLifecycleJournalAccess(async () => {
        const evidence = await inspectDestructiveJournals(getCanopyDataDir());
        const operations = new Map<
          string,
          (typeof evidence.records)[number]['record']
        >();
        if (evidence.issues.length > 0) return true;
        for (const { record, name } of evidence.records) {
          if (
            record.state !== 'completed' ||
            record.cleanupRequired === true ||
            (name !== `${record.operationId}.json` &&
              name !==
                lifecycleJournalSlotName(record.workspaceId, record.worktreeId))
          )
            return true;
          const previous = operations.get(record.operationId);
          if (previous && !isDeepStrictEqual(previous, record)) return true;
          operations.set(record.operationId, record);
        }
        return false;
      });
      return recovery.status();
    },
  };
  return controller;
}
