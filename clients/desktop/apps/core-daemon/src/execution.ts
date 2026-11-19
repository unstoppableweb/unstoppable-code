import { randomUUID } from 'node:crypto';
import { totalmem } from 'node:os';
import {
  createCoreExecutionHandlers,
  defineRuntimeModule,
  ExecutionAccounting,
  type ExecutionAccountingLimits,
  type ExecutionFamily,
  type ExecutionResourceGroupId,
  type ExecutionResourceKind,
  type ExecutionWakeLock,
  type GenericResourceMetadata,
  type PlatformSupervisionServices,
  type RuntimeHealthCheck,
  type RuntimeModule,
} from '@canopy/core-runtime';
import type { ExecutionHostProcess } from '@canopy/core-platform/execution-host';
import {
  CORE_EXECUTION_GRANTS,
  CORE_EXECUTION_QUERIES,
  CORE_EXECUTION_STREAMS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { DaemonWakeLock } from './wake-lock';

/*
 * The daemon's execution accounting (CAN-5627): the CAN-4135 core class over
 * this process's own process table. Work the daemon runs holds leases and
 * registrations in it, so `core.execution.status.*` reports its pressure,
 * processes and family counts to every leased client, as Electron main's
 * accounting does for its own work.
 */

export type DaemonExecutionAccounting =
  ExecutionAccounting<GenericResourceMetadata>;

/** Leased same-user peers read the daemon's execution status. */
export const DAEMON_EXECUTION_CALLER_GRANTS: CanopyCallerDescriptor['grants'] =
  [CORE_EXECUTION_GRANTS.read];

const GIB = 1024 * 1024 * 1024;

/** How often the daemon samples while its work holds a lease. */
export const DAEMON_EXECUTION_SAMPLE_INTERVAL_MS = 5_000;

/**
 * The least time between the end of one sample and a sample taken because a
 * host was registered or unregistered (CAN-5700).
 */
export const DAEMON_EXECUTION_CHANGE_SAMPLE_MIN_MS = 500;

const GROUP_LABELS: Readonly<Record<ExecutionResourceGroupId, string>> = {
  app: 'Background service',
  browser: 'Browser',
  codex: 'Codex',
  claude: 'Claude',
  chat: 'Chat',
  pipelines: 'Pipelines',
  terminal: 'Terminals',
  scripts: 'Script',
  other: 'Other',
};

/**
 * The desktop's default thresholds; the daemon reads no preferences. Nothing
 * the daemon runs is memory guarded or capped, so pressure only reports.
 */
export function daemonExecutionLimits(
  totalMemoryBytes: number,
): ExecutionAccountingLimits {
  return {
    maxActive: {},
    memoryGuardEnabled: false,
    warningMemoryBytes: Math.min(2 * GIB, Math.floor(totalMemoryBytes * 0.5)),
    criticalMemoryBytes: Math.min(4 * GIB, Math.floor(totalMemoryBytes * 0.7)),
  };
}

export function createDaemonExecutionAccounting(options: {
  /** The closure gate's supervision, so reads stop once it seals. */
  readonly supervision: Pick<PlatformSupervisionServices, 'readProcessTable'>;
  readonly rootPid?: number;
  readonly totalMemoryBytes?: number;
  /** Keeps the computer awake while pipeline work runs (CAN-5872). */
  readonly wakeLock?: ExecutionWakeLock;
  /** Records a failed sample; see `createDaemonExecutionSampleFailures`. */
  readonly onSampleFailure?: (error: unknown) => void;
}): DaemonExecutionAccounting {
  const limits = daemonExecutionLimits(options.totalMemoryBytes ?? totalmem());
  return new ExecutionAccounting<GenericResourceMetadata>({
    rootPid: options.rootPid ?? process.pid,
    readProcessTable: (request) =>
      options.supervision.readProcessTable(request),
    limits: () => limits,
    productName: GROUP_LABELS.app,
    groupLabel: (id) => GROUP_LABELS[id],
    executionIdOf: () => undefined,
    ...(options.wakeLock && { wakeLock: options.wakeLock }),
    ...(options.onSampleFailure && {
      onSampleFailure: options.onSampleFailure,
    }),
  });
}

/** How a launched execution host shows in the daemon's accounting. */
export interface DaemonExecutionHostAccount {
  readonly family: ExecutionFamily;
  readonly label: string;
  readonly groupId: ExecutionResourceGroupId;
  readonly kind: ExecutionResourceKind;
}

/**
 * Holds one execution host under a lease of its family and a registration of
 * its process, both until the host exits, however it ends. Without
 * accounting the host is returned as it is.
 */
export function accountExecutionHost<Host extends ExecutionHostProcess>(
  accounting: DaemonExecutionAccounting | undefined,
  host: Host,
  account: DaemonExecutionHostAccount,
): Host {
  if (!accounting) return host;
  const id = `${account.family}-host:${randomUUID()}`;
  const lease = accounting.track(account.family, id);
  let registration: { unregister(): void } | undefined;
  host.once('spawn', () => {
    if (host.pid === undefined) return;
    registration = accounting.register({
      id,
      groupId: account.groupId,
      kind: account.kind,
      label: account.label,
      pid: host.pid,
      metadata: { type: 'generic' },
    });
  });
  host.once('exit', () => {
    registration?.unregister();
    lease.release();
  });
  return host;
}

function hasActive(
  families: ReturnType<DaemonExecutionAccounting['familyStatus']>,
): boolean {
  return Object.values(families).some(({ active }) => active > 0);
}

/**
 * `core.execution.status.get` and `.events` over the daemon's accounting.
 * Nobody drives a sampling cadence here, as Electron main's resource monitor
 * does for its own accounting, so the daemon samples while its work holds a
 * lease, and once more after any sample that showed work, so subscribers see
 * it idle.
 * A read takes a fresh sample when the last one is older than that interval,
 * and core samples again for a read when a host was registered or
 * unregistered since the last sample (CAN-5693).
 * A host registered or unregistered is published without waiting for the
 * interval (CAN-5700): the daemon samples once the last sample, whoever took
 * it, is at least the change interval old, so a burst of changes takes one
 * sample, and skips it when a read or tick already sampled after the change.
 * A change a sample in flight started before waits the change interval after
 * that sample.
 */
export function createDaemonExecutionModule(
  accounting: DaemonExecutionAccounting,
  options: {
    readonly sampleIntervalMs?: number;
    readonly changeSampleMinIntervalMs?: number;
    /** The accounting's wake lock, released at stop. */
    readonly wakeLock?: DaemonWakeLock;
    /** The accounting service's health check. */
    readonly health?: () => RuntimeHealthCheck;
  } = {},
): RuntimeModule {
  const intervalMs =
    options.sampleIntervalMs ?? DAEMON_EXECUTION_SAMPLE_INTERVAL_MS;
  const changeMinMs =
    options.changeSampleMinIntervalMs ?? DAEMON_EXECUTION_CHANGE_SAMPLE_MIN_MS;
  const handlers = createCoreExecutionHandlers(accounting);
  let timer: ReturnType<typeof setInterval> | undefined;
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeRegistrations = (): void => undefined;
  let watchingChanges = false;
  // The empty snapshot carries a time too, so only a real sample counts.
  let lastSampledAt: number | null = null;
  // Whoever took it, the last sample showed work, so one more follows.
  let publishedWork = false;
  const changeWait = (): number =>
    lastSampledAt === null
      ? 0
      : Math.max(0, lastSampledAt + changeMinMs - Date.now());
  const sampleSoon = (): void => {
    if (!watchingChanges || changeTimer !== undefined) return;
    changeTimer = setTimeout(sampleChanges, changeWait());
    changeTimer.unref();
  };
  function sampleChanges(): void {
    changeTimer = undefined;
    if (!accounting.hasUnsampledRegistrationChanges()) return;
    // A read may have sampled since this was scheduled.
    if (changeWait() > 0) {
      sampleSoon();
      return;
    }
    // Joins a sample in flight; one that started before the change asks
    // again when it ends.
    // The accounting reports a failed sample to its `onSampleFailure`.
    void accounting.sample().catch(() => undefined);
  }
  accounting.subscribe((snapshot) => {
    lastSampledAt = Date.now();
    publishedWork = hasActive(snapshot.families);
    if (accounting.hasUnsampledRegistrationChanges()) sampleSoon();
  });
  const sampleIfStale = async (): Promise<void> => {
    if (lastSampledAt === null || Date.now() - lastSampledAt >= intervalMs)
      await accounting.sample();
  };
  return defineRuntimeModule({
    name: 'core.execution',
    plane: 'core',
    services: [
      {
        name: 'core.execution.accounting',
        plane: 'core',
        ...(options.health && { health: options.health }),
        start: (): void => {
          timer = setInterval(() => {
            if (hasActive(accounting.familyStatus()) || publishedWork)
              void accounting.sample().catch(() => undefined);
          }, intervalMs);
          timer.unref();
          watchingChanges = true;
          unsubscribeRegistrations =
            accounting.subscribeRegistrations(sampleSoon);
        },
        stop: {
          5: async (): Promise<void> => {
            clearInterval(timer);
            watchingChanges = false;
            unsubscribeRegistrations();
            clearTimeout(changeTimer);
            changeTimer = undefined;
            accounting.dispose();
            await options.wakeLock?.shutdown();
          },
        },
      },
    ],
    definitions: {
      queries: CORE_EXECUTION_QUERIES,
      instructions: {},
      streams: CORE_EXECUTION_STREAMS,
    },
    handlers: {
      queries: {
        'core.execution.status.get': async (params, context) => {
          await sampleIfStale();
          return handlers.queries['core.execution.status.get'](params, context);
        },
      },
      instructions: {},
      streams: handlers.streams,
    },
  });
}
