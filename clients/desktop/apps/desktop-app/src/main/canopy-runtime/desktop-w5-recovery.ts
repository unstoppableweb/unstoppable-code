import { listW5RootPresencePeers } from '@canopy/core-platform/w5-root-presence';
import { withSharedLifecycleJournalAccess } from '../lib/w5-destructive-recovery';
import { countDestructiveJournalsNeedingAttention } from '@canopy/core-runtime/node/w5/destructive-journal';
import { inspectDestructiveJournals } from '@canopy/desktop-shared/node/w5-destructive-journal';
import { electronW5RecoveryObservations } from './w5-recovery-observations';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import type {
  W5RecoveryEntry,
  W5RecoveryReason,
  W5RecoveryStatus,
} from '@canopy/protocol/portal';
import { listW5HostPeers } from '@canopy/execution-engine/node/w5-host-cohort';
import { getCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import {
  isW5RecoveryAvailable,
  isW5ReservationReleaseQualified,
} from '../lib/w5-recovery-gates';
import { W5_RESOLVABLE_RESERVATION_OPERATIONS } from '../lib/w5-maintenance-decisions';
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
  type W5RecoverySnapshot,
} from './w5-recovery-controller';

interface DesktopW5RecoveryController extends W5RecoveryController {
  refreshJournals(): Promise<W5RecoveryStatus>;
}

let controller: DesktopW5RecoveryController | undefined;
// Any read's start, so a polling local window spares the remote refresh.
let liveReadAt: number | undefined;
// The local window's own polling interval.
const REMOTE_REFRESH_INTERVAL_MS = 10_000;

/**
 * The status a Portal or direct Remote Control snapshot projects (CAN-7061).
 * A remote session can run with no local window polling, so it starts a
 * refresh when no read ran within that window's interval; a change it finds
 * schedules the next snapshot push.
 */
export function peekDesktopW5RecoveryForRemote(): W5RecoveryStatus {
  const recovery = getDesktopW5RecoveryController();
  if (
    liveReadAt === undefined ||
    Date.now() - liveReadAt >= REMOTE_REFRESH_INTERVAL_MS
  )
    void recovery.status().catch(() => undefined);
  return recovery.peek();
}

function retainedEvidenceReason(
  reason: W5RecoveryReason | undefined,
  retained: readonly W5RecoveryEntry[],
): W5RecoveryReason | undefined {
  if (reason === 'log-unavailable' && retained.some(({ id }) => id === 'log'))
    return reason;
  if (
    reason === 'source-unavailable' &&
    retained.some(({ id }) => id.startsWith('file:'))
  )
    return reason;
  return undefined;
}

/** Native interface intent; the cold writer is never callable from this process. */
export function getDesktopW5RecoveryController(): DesktopW5RecoveryController {
  if (controller) return controller;
  let lease: ElectronW5RecordPortLease | undefined;
  let lastResult: W5RecoveryStatus | null | undefined;
  let journalsRemain = true;
  let knownCommitIds: readonly number[] = [];
  let releasableReservation = false;
  const snapshot = (
    entries: readonly W5RecoveryEntry[],
    retained: readonly W5RecoveryEntry[],
    observation: 'current' | 'unavailable',
  ): W5RecoverySnapshot => {
    const available = observation === 'current';
    const applicable =
      electronW5RecoveryObservations.hasRecoverableCommit(knownCommitIds) ||
      (isW5ReservationReleaseQualified() && releasableReservation);
    // Startup's support guidance stays beside the retained log or file issue it
    // describes; a live target or an unanswered query supersedes it.
    const reason =
      available && !applicable
        ? retainedEvidenceReason(lastResult?.reason, retained)
        : undefined;
    return {
      entries,
      applicability: applicable
        ? available
          ? 'current-target'
          : 'retained-target'
        : available
          ? 'none'
          : 'unavailable',
      ...(reason ? { reason } : {}),
    };
  };
  const recovery = createW5RecoveryController({
    enabled: isW5RecoveryAvailable,
    supported: () => hostPlatformOperatingSystem() !== 'win32',
    live: async (): Promise<W5RecoverySnapshot> => {
      liveReadAt = Date.now();
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
      // A degraded handoff is the background service notice's Restart app
      // (CAN-7061), not a recovery target.
      if (handoff?.state === 'pending' || handoff?.state === 'degraded')
        return { entries: retained, applicability: 'none' };
      lease ??= leaseElectronW5RecordPort();
      try {
        const [recovery, reservations] = await Promise.all([
          lease.transport.recovery(),
          lease.transport.listReservations(),
        ]);
        knownCommitIds = recovery.recoveryRequired;
        releasableReservation = reservations.reservations.some(
          (r) =>
            r.state === 'recovery-required' &&
            W5_RESOLVABLE_RESERVATION_OPERATIONS.has(r.operation),
        );
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
        return snapshot(
          [
            ...new Map(
              pending.map((entry) => [
                entry.id,
                lastResult?.entries.find(
                  (previous) => previous.id === entry.id,
                ) ?? entry,
              ]),
            ).values(),
          ],
          retained,
          'current',
        );
      } catch {
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
        // A failed query is not fresh evidence. Only recognized targets survive;
        // an arbitrary cached warning or historical result cannot grant recovery.
        return snapshot(
          [...new Map(entries.map((entry) => [entry.id, entry])).values()],
          retained,
          'unavailable',
        );
      }
    },
    onChanged: (): void => {
      void import('../services/desktop-structure-signal')
        .then(({ scheduleDesktopStructureChanged }) =>
          scheduleDesktopStructureChanged('structural.w5-recovery'),
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
        return countDestructiveJournalsNeedingAttention(evidence) !== 0;
      });
      return recovery.status();
    },
  };
  return controller;
}
